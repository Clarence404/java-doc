---
description: 新 Pod 前几分钟 P99 飙高、JIT 编译抢 CPU、类加载与连接池懒初始化、缓存冷启动、预热后就绪与 AOT 缓存
---

# 启动后 RT 飙高

> 前置阅读：[JIT 编译](/jvm/7_jit)、[优雅上下线与变更](/high-avail/8_graceful_release)

商品服务每次发版或扩容，新 Pod 刚接流量的两三分钟里接口 P99 都会冲到秒级，老 Pod 却一切正常。本篇复盘这次"冷启动毛刺"的排查与治理，基线为 JDK 21 / 25、Spring Boot 4、Kubernetes。

---

## 一、现象

10 月 11 日 14:00 product-service（8 个 Pod，`requests.cpu=1`、`limits.cpu=2`，`-Xmx3g`，G1）滚动发布，`maxSurge=2`、`maxUnavailable=0`。发布期间网关告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 14:02 | `HttpP99High`：商品详情接口 P99 从 120ms 升到 2.6s |
| 14:03 | 订单服务调用商品服务超时（读超时 1s）比例 6%，触发重试 |
| 14:04 | Redis `instantaneous_ops_per_sec` 从 4 万涨到 11 万 |
| 14:05 | 第一批新 Pod 的 P99 回落到 300ms，第二批新 Pod 又冲到 2s |
| 14:18 | 发布结束 5 分钟后，全部 Pod 的 P99 恢复到 120ms |

把 P99 按 Pod 拆开看，规律很清楚：**只有启动不到 3 分钟的 Pod 慢**，同一时刻的老 Pod 完全正常。每个新 Pod 的曲线都是"就绪即冲高、两三分钟内逐步回落"。

---

## 二、影响

- 14:02–14:16 共 14 分钟，商品详情接口约 3.4% 的请求超过 1s，订单服务的重试又把流量放大约 1.3 倍
- 下单链路依赖商品详情校验，约 2100 笔下单请求因超时失败，用户重试后大部分成功
- 平时每天发版 2–3 次、早高峰 HPA 扩容一次，同样的毛刺每次都在，只是这次叠加了午间流量才触发告警

---

## 三、排查过程

### 1、确认和启动时长相关

先确认慢的是不是新实例，用 `process_uptime_seconds` 把 P99 和 Pod 启动时长对齐：

```promql
histogram_quantile(0.99,
  sum by (pod, le) (rate(http_server_requests_seconds_bucket{app="product-service", uri="/products/{id}"}[1m])))
  and on (pod) process_uptime_seconds{app="product-service"} < 300
```

示例结果（14:03）：

```text
{pod="product-service-6c8f-q7n2d"}  2.61
{pod="product-service-6c8f-w4k9s"}  2.38
```

只有两个刚启动的 Pod 有值，去掉 `< 300` 条件后其他 6 个 Pod 都在 0.12 左右。问题和新实例强相关，与代码逻辑无关（老版本发版时同样出现）。

### 2、看 CPU：谁在用、有没有被限流

```bash
kubectl top pod -l app=product-service
```

示例输出：

```text
NAME                          CPU(cores)   MEMORY(bytes)
product-service-6c8f-q7n2d    1998m        1180Mi
product-service-6c8f-w4k9s    2001m        1206Mi
product-service-5b7d-h2m8x    640m         2410Mi
...
```

新 Pod CPU 顶在 limit 上，老 Pod 只用 0.6 核。看 CFS 限流：

```promql
rate(container_cpu_cfs_throttled_periods_total{pod=~"product-service-6c8f-.*"}[1m])
  / rate(container_cpu_cfs_periods_total{pod=~"product-service-6c8f-.*"}[1m])
```

新 Pod 被限流的周期占比 68%，也就是三分之二的 100ms 周期里进程用完了配额要等下一个周期，所有线程（包括处理请求的线程）都被一起暂停。

### 3、看 CPU 花在哪：JIT 编译线程

进入新 Pod，按线程看 CPU：

```bash
kubectl exec product-service-6c8f-q7n2d -- top -H -b -n 1 -p 1 | head -14
```

示例输出：

```text
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   23 app       20   0 6012340   1.1g  27412 R  71.4   7.3   0:58.21 C2 CompilerThre
   24 app       20   0 6012340   1.1g  27412 R  52.9   7.3   0:41.07 C2 CompilerThre
   25 app       20   0 6012340   1.1g  27412 R  23.5   7.3   0:19.66 C1 CompilerThre
  112 app       20   0 6012340   1.1g  27412 S   5.9   7.3   0:02.11 http-nio-8080-e
  118 app       20   0 6012340   1.1g  27412 S   5.9   7.3   0:01.94 http-nio-8080-e
  ...
```

占 CPU 最多的是 C2、C1 编译线程，合计近 1.5 核。再看编译统计：

```bash
kubectl exec product-service-6c8f-q7n2d -- jstat -compiler 1
kubectl exec product-service-6c8f-q7n2d -- jcmd 1 Compiler.queue | head -6
```

示例输出：

```text
Compiled Failed Invalid   Time   FailedType FailedMethod
   18432      0       0    96.41          0

Current compiles:
C2 CompilerThread0    21871 %     4       com.fasterxml.jackson.databind.ser.BeanSerializer::serialize @ 42 (114 bytes)
C2 CompilerThread1    21880       4       com.example.product.price.PriceCalculator::calculate (386 bytes)
C1 compile queue:
...
```

启动 3 分钟累计编译 1.8 万个方法、编译耗时 96 秒，而且队列里还排着不少方法。对照老 Pod：编译数几乎不再增长。结论：**新 Pod 的热点代码还在解释执行或 C1 代码上跑，同时 C2 在拼命编译，编译线程又和业务线程抢仅有的 2 核**。

### 4、看类加载

```bash
kubectl exec product-service-6c8f-q7n2d -- jstat -class 1 5000 3
```

示例输出：

```text
Loaded  Bytes  Unloaded  Bytes     Time
 21844 43211.6        0     0.0      18.92
 22310 44102.3        0     0.0      19.37
 22597 44655.0        0     0.0      19.71
```

就绪之后每 5 秒仍新加载几百个类：很多类（Jackson 序列化器、MyBatis 映射、Feign 客户端、校验器）要等第一个真实请求才加载和初始化，这部分耗时直接落在首批请求上。

### 5、看连接池与缓存

HikariCP 指标：

```promql
hikaricp_connections_pending{pod="product-service-6c8f-q7n2d"}
hikaricp_connections{pod="product-service-6c8f-q7n2d"}
```

就绪后第一分钟 `pending` 峰值 21，总连接数从 2 爬到 30。配置里为了省数据库连接写了 `minimum-idle: 2`，而服务用的 MyBatis 启动时不碰数据源，**连接是被首批请求现场一个个建出来的**，每个连接含 TLS 握手约 60–90ms。

本地缓存（Caffeine，存商品基础信息）命中率：

```promql
sum by (pod) (rate(cache_gets_total{cache="productBase", result="hit"}[1m]))
  / sum by (pod) (rate(cache_gets_total{cache="productBase"}[1m]))
```

老 Pod 命中率 96%，新 Pod 第一分钟只有 31%，大量请求穿透到 Redis，这就是 Redis QPS 翻倍的原因；Redis 本身 P99 仍在 2ms 内，不是瓶颈，但增加了新 Pod 的网络往返和反序列化开销。

### 6、看就绪时机

```bash
kubectl get pod product-service-6c8f-q7n2d -o jsonpath='{.status.conditions[?(@.type=="Ready")].lastTransitionTime}'
kubectl logs product-service-6c8f-q7n2d | grep -m1 "Started ProductApplication"
```

示例输出：

```text
2026-10-11T06:01:41Z
2026-10-11T14:01:34.512+08:00  INFO 1 --- [main] c.e.product.ProductApplication : Started ProductApplication in 21.874 seconds
```

应用启动完成后 7 秒 Pod 就绪，立刻分到全量流量的约 1/10（滚动发布 `maxSurge=2`，在线实例最多 10 个），此时 JIT、类加载、连接池、本地缓存都还是"冷"的。

---

## 四、根因

新实例在"完全冷"的状态下直接承接全量流量，四个冷启动因素叠加：

1. **JIT 未预热**：热点方法还在解释执行或 C1 代码上运行，C2 编译需要几分钟
2. **CPU limit 放大了预热成本**：编译线程与业务线程争抢 2 核，CFS 限流让请求线程被整体暂停，预热时间被拉得更长，形成"越慢越编译不完"
3. **懒初始化落在请求路径上**：类加载与初始化、连接池按需建连（`minimum-idle: 2`）都由首批请求承担
4. **本地缓存冷启动**：命中率从 0 起步，穿透到 Redis 增加了每个请求的开销

就绪探针只检查"应用是否启动完成"，不知道"应用是否已经热了"；滚动发布一次放出 2 个冷实例，调用方超时重试又放大了流量，于是每次发布都出现毛刺。

---

## 五、修复

### 1、止血

- 14:06 执行 `kubectl rollout pause deploy/product-service`，等已启动的新 Pod 热起来再继续，把 `maxSurge` 临时改为 1
- 14:08 订单服务对商品详情的调用临时去掉重试（接口本身幂等，但重试只会放大冷实例的压力）
- 14:12 恢复发布，单批次只放 1 个冷实例，P99 峰值降到 600ms 左右

### 2、预热完成再就绪

把预热放进 `ApplicationRunner`，Spring Boot 在所有 Runner 执行完之后才把就绪状态切到 `ACCEPTING_TRAFFIC`，K8s 就绪探针会自然等待：

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class WarmupRunner implements ApplicationRunner {

    private final DataSource dataSource;
    private final ProductBaseCache productBaseCache;
    private final ProductQueryService productQueryService;
    private final StringRedisTemplate redis;

    @Override
    public void run(ApplicationArguments args) throws Exception {
        long start = System.nanoTime();
        try (Connection ignored = dataSource.getConnection()) {
            // 触发连接池初始化，配合 minimum-idle 一次建足连接
        }
        redis.hasKey("warmup");                              // 建立 Redis 连接
        List<Long> hotIds = productBaseCache.loadHotProducts(2_000);   // 预加载前 2000 个热门商品
        for (int round = 0; round < 30; round++) {           // 跑核心只读路径，触发类加载与 JIT 编译
            for (Long id : hotIds.subList(0, 200)) {
                productQueryService.detail(id);
            }
        }
        log.info("warmup finished in {} ms", Duration.ofNanos(System.nanoTime() - start).toMillis());
    }
}
```

几点注意：

- 预热只走**只读**路径，不能产生业务数据或调用有副作用的下游
- 预热次数按"让核心方法达到 C2 编译阈值"估算（分层编译下 C2 的调用阈值在数千到 1.5 万次量级），以日志里的耗时和随后的 `jstat -compiler` 曲线验证
- 预热要有时间上限（可用超时兜底，超时就带着半热状态就绪），`startupProbe` 的 `failureThreshold × periodSeconds` 要覆盖"启动 + 预热"总时长，否则会被反复重启
- 服务还注册到 Nacos 的话，自动注册早于 Runner 执行，要改为预热完成后再注册，见 [预热完成再就绪](/high-avail/8_graceful_release#_1、预热完成再就绪)

连接池同步调整：

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 30
      minimum-idle: 30          # 固定大小连接池，启动时建足，不在请求路径上建连
```

### 3、给编译留 CPU

- `requests.cpu` 从 1 调到 2、`limits.cpu` 从 2 调到 4：稳态只用 0.6 核，多出来的配额主要在启动的前几分钟被编译线程用掉
- 不建议为省 CPU 关闭 C2 或改为只用 C1（`-XX:TieredStopAtLevel=1`），那会让稳态峰值性能永久下降

### 4、缩短启动与预热：CDS 和 AOT 缓存

服务分两批 JDK：

| JDK | 方案 | 效果（本服务实测） |
|-----|------|-------------------|
| JDK 21 | AppCDS：镜像构建时训练运行生成归档，`-XX:SharedArchiveFile` 启动 | 启动 21.9s → 14.6s，对 JIT 预热无帮助 |
| JDK 25 | AOT 缓存：`-XX:AOTCacheOutput` 训练、`-XX:AOTCache` 启动 | 启动 21.9s → 9.8s；训练时带预热流量，JIT 达到稳态时间缩短约 40% |

JDK 25 的训练运行放在 CI 镜像构建阶段，用预热 Runner 加一份回放的只读请求跑 2 分钟后正常退出，这样缓存里除了已加载、已链接的类，还有方法 profile（JEP 515），启动后 JIT 能更早编译热点。只用 `spring.context.exit=onRefresh` 训练的话，profile 几乎采集不到，只能缩短启动。具体步骤见 [CDS 与 AOT 缓存](/spring-boot/13_startup#四、cds-与-aot-缓存)。

::: warning AOT 缓存与构建绑定
缓存与应用 jar、依赖列表、JDK 版本严格绑定，任何一项变化都要重新训练；训练必须在流水线里自动完成，不能手工生成后长期复用。加 `-Xlog:class+load` 确认生产启动时确实命中了缓存。
:::

---

## 六、预防

**监控告警**：

```yaml
- alert: NewInstanceSlow
  # 启动 10 分钟内的实例 P99 超过 1s，单独告警，便于和稳态问题区分
  expr: |
    histogram_quantile(0.99,
      sum by (app, pod, le) (rate(http_server_requests_seconds_bucket[1m])))
      > 1
    and on (pod) process_uptime_seconds < 600
  for: 2m
  labels: {severity: warning}
- alert: CpuThrottlingHigh
  expr: |
    rate(container_cpu_cfs_throttled_periods_total[5m])
      / rate(container_cpu_cfs_periods_total[5m]) > 0.3
  for: 10m
  labels: {severity: warning}
```

**发布规范**：

- 所有在线服务必须实现"预热完成再就绪"，发布检查单增加一项：新 Pod 就绪后 1 分钟内 P99 不超过稳态的 2 倍
- 滚动发布 `maxSurge` 不超过实例数的 15%；有网关或注册中心权重能力的，新实例按 3–5 分钟逐步放量
- 调用方重试只对幂等接口开启，并配合重试预算，避免冷实例被重试流量二次放大

**压测**：

- 压测场景增加"压测中途滚动发布"，观察新实例的 P99 曲线，而不是只压稳态

---

## 七、涉及知识点

- 分层编译、编译阈值与 HotSpot AOT 缓存：[JIT 编译](/jvm/7_jit)
- 冷启动毛刺的成因与手段对比：[JVM 层性能策略](/high-perf/5_jvm_tuning#四、jit-预热与冷启动毛刺)
- 预热、就绪探针与权重预热：[优雅上下线与变更](/high-avail/8_graceful_release#二、服务预热)
- CDS、AOT 缓存的训练与使用：[启动与部署优化](/spring-boot/13_startup#四、cds-与-aot-缓存)
- 类加载过程与初始化时机：[类加载机制](/jvm/2_class_loading)
- 连接池参数：[池化技术](/high-perf/7_pooling)

---

## 小结

- 先按 Pod 和启动时长拆分 P99，只有新实例慢就是冷启动问题，不必去翻业务代码
- 冷启动有四个来源：JIT、类加载与懒初始化、连接池按需建连、本地缓存为空；CPU limit 过小会把它们一起放大
- 治理顺序：预热完成再就绪 → 固定大小连接池与缓存预加载 → 给编译留 CPU → CDS（JDK 21）或 AOT 缓存（JDK 25）缩短启动与预热
- 就绪探针要表达"可以接流量"，而不只是"进程起来了"

## 参考资料

- 分层编译与 JIT 相关参数：[The java Command](https://docs.oracle.com/en/java/javase/25/docs/specs/man/java.html)
- AOT 缓存：[JEP 483: Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483)、[JEP 514: Ahead-of-Time Command-Line Ergonomics](https://openjdk.org/jeps/514)、[JEP 515: Ahead-of-Time Method Profiling](https://openjdk.org/jeps/515)
- Spring Boot 的 CDS 与 AOT 缓存：[Spring Boot Reference — AOT Cache](https://docs.spring.io/spring-boot/reference/packaging/aot-cache.html)
- 应用可用性状态：[Spring Boot Reference — Application Availability](https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.application-availability)
- 探针配置：[Kubernetes — Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- HikariCP 参数说明：[HikariCP README](https://github.com/brettwooldridge/HikariCP)

> 下一篇：[日志打印拖慢接口](./23_log_bottleneck)

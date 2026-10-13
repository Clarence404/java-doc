---
description: 下游变慢且无超时导致业务线程池与 Tomcat 线程耗尽、线程栈归类、超时与隔离改造、探针与告警
---

# 线程池耗尽

> 前置阅读：[线程池](/java/28_topic_thread_pool)、[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)

优惠券服务变慢且调用无超时，订单服务的业务线程池与 Tomcat 线程相继耗尽，Pod 反复重启。本篇复盘定位方法与超时、隔离、快速失败改造，基线为 JDK 21、Spring Boot 4。

---

## 一、现象

结算时 order-service 并行调用优惠券、库存、会员三个下游，共用一个业务线程池 `orderAsyncExecutor`（核心 32、最大 64、`LinkedBlockingQueue(2000)`、`CallerRunsPolicy`）。Tomcat 最大线程数为默认的 200。10 月 10 日：

| 时间 | 告警 / 现象 |
|------|-------------|
| 11:20 | coupon-service 告警：数据库慢查询激增，接口 P99 从 40ms 升到 4.8s |
| 11:23 | `ExecutorQueueBacklog`：order-service `executor_queued_tasks{name="orderAsync"}` 达到 2000（队列满） |
| 11:25 | `TomcatThreadsExhausted`：`tomcat_threads_busy_threads` = 200，下单、查询订单等**所有接口** P99 超过 10s |
| 11:27 | K8s 事件：`Liveness probe failed: ... context deadline exceeded`，6 个 Pod 先后重启，`RESTARTS` 计数持续上涨 |
| 11:30 | 网关 5xx 比例 41% |

order-service 的 CPU 只有 0.3 核，堆和 GC 都正常：进程很"闲"，但所有线程都在等。

---

## 二、影响

- 11:23–11:58 约 35 分钟，下单成功率最低 52%，订单查询、支付回调等与优惠券无关的接口也一起不可用
- Pod 重启风暴：重启中的 Pod 不接流量，剩余 Pod 压力更大，更快被打满，形成连锁
- 部分支付回调因 order-service 不可用而失败，依赖支付平台重试，最长延迟约 40 分钟完成状态同步

---

## 三、排查过程

### 1、先看线程整体分布

```bash
[arthas@1]$ thread | head -3
```

示例输出：

```text
Threads Total: 341, NEW: 0, RUNNABLE: 38, BLOCKED: 0, WAITING: 269, TIMED_WAITING: 17, TERMINATED: 0, Internal threads: 17
```

绝大多数线程处于 `WAITING`，CPU 又很低：典型的"都在等某个东西"，而不是计算或死锁（死锁见下一篇 [死锁](./5_deadlock)）。

### 2、按线程池归类，看大家卡在哪

```bash
kubectl exec order-service-79c4-h2w8d -- jstack 1 > dump.txt
# 各线程池的线程数
grep -oE '^"[a-zA-Z-]+' dump.txt | sort | uniq -c | sort -rn | head -4
# 业务线程池的栈顶归类
grep -A 12 '^"order-async-' dump.txt | grep -E "com\.example" | sort | uniq -c | sort -rn | head -3
```

示例输出：

```text
    200 "http-nio-
     64 "order-async-
     12 "lettuce-nioEventLoop-
     64 	at com.example.order.client.CouponClient.calculate(CouponClient.java:33)
```

64 个业务线程全部停在 `CouponClient.calculate`。看其中一个线程的完整栈：

```text
"order-async-17" #96 [182] prio=5 os_prio=0 cpu=1834.22ms elapsed=268.41s tid=0x00007f6a1c3b2000 nid=182 waiting on condition  [0x00007f69e8bfd000]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@21.0.8/Native Method)
	- parking to wait for  <0x00000006d4c18a30> (a java.util.concurrent.CompletableFuture$Signaller)
	at java.util.concurrent.locks.LockSupport.park(java.base@21.0.8/LockSupport.java:221)
	at java.util.concurrent.CompletableFuture$Signaller.block(java.base@21.0.8/CompletableFuture.java:1864)
	...
	at java.util.concurrent.CompletableFuture.get(java.base@21.0.8/CompletableFuture.java:2096)
	at jdk.internal.net.http.HttpClientImpl.send(java.net.http@21.0.8/HttpClientImpl.java:931)
	at org.springframework.http.client.JdkClientHttpRequest.executeInternal(JdkClientHttpRequest.java:...)
	...
	at com.example.order.client.CouponClient.calculate(CouponClient.java:33)
```

线程在等 HTTP 响应，没有任何超时，能等多久就等多久。

再看 Tomcat 线程，本应只处理请求，却也出现在 `CouponClient` 里：

```bash
grep -A 30 '^"http-nio-8080-exec-' dump.txt | grep -B1 -A1 "CallerRunsPolicy" | head -6
```

示例输出：

```text
	at com.example.order.client.CouponClient.calculate(CouponClient.java:33)
	...
	at java.util.concurrent.ThreadPoolExecutor$CallerRunsPolicy.rejectedExecution(java.base@21.0.8/ThreadPoolExecutor.java:2037)
	at java.util.concurrent.ThreadPoolExecutor.reject(java.base@21.0.8/ThreadPoolExecutor.java:841)
```

业务线程池队列满后触发拒绝策略 `CallerRunsPolicy`，任务由提交者（Tomcat 线程）自己执行，于是 Tomcat 线程也去等优惠券服务。

### 3、确认线程池参数与实时状态

```bash
[arthas@1]$ vmtool --action getInstances --className java.util.concurrent.ThreadPoolExecutor \
  --express 'instances.{#this.toString()}' --limit 10
```

示例输出（节选）：

```text
@ArrayList[
    @String[java.util.concurrent.ThreadPoolExecutor@5e3a8624[Running, pool size = 64, active threads = 64, queued tasks = 2000, completed tasks = 18734120]],
    @String[java.util.concurrent.ThreadPoolExecutor@1b9c0d41[Running, pool size = 1, active threads = 0, queued tasks = 0, completed tasks = 3921]],
]
```

线程数已到最大值 64、全部活跃、队列 2000 满载：线程池彻底耗尽。

### 4、为什么连探针都失败

Deployment 中的存活探针：

```yaml
livenessProbe:
  httpGet: {path: /actuator/health/liveness, port: 8080}
  periodSeconds: 5
  timeoutSeconds: 1
  failureThreshold: 3
```

探针和业务请求走同一个端口、同一组 Tomcat 线程。200 个线程全被占满，探针请求排不上队，连续 3 次 1 秒超时，kubelet 就判定容器"死了"并重启，而进程本身是健康的。

---

## 四、根因

```java
public CheckoutResult calculate(CheckoutRequest req) {
    CompletableFuture<CouponResult> coupon = CompletableFuture.supplyAsync(() -> couponClient.calculate(req), orderAsyncExecutor);
    CompletableFuture<StockResult>  stock  = CompletableFuture.supplyAsync(() -> inventoryClient.check(req), orderAsyncExecutor);
    CompletableFuture<MemberResult> member = CompletableFuture.supplyAsync(() -> memberClient.level(req), orderAsyncExecutor);
    return assemble(coupon.join(), stock.join(), member.join());   // join 无超时
}
```

几个缺陷叠加，任何一个被修掉都不至于全站不可用：

1. **HTTP 客户端没有超时**：`RestClient` 未配置读取超时，下游多慢，线程就占多久
2. **一个池服务所有下游**：优惠券变慢，库存、会员的调用也排不上队
3. **请求链路上用了 `CallerRunsPolicy`**：拒绝时把压力转嫁给 Tomcat 线程，故障从一个线程池扩散到整个服务
4. **`join()` 不设超时**：即使业务能接受"没有优惠券信息"，也没有机会降级
5. **存活探针过于敏感且与业务共用线程**：把"忙"误判为"死"，重启又放大了故障

---

## 五、修复

### 1、止血

- 11:36 在配置中心打开"优惠券降级"开关：结算跳过优惠计算，页面提示"优惠券暂不可用"，允许按原价下单
- 11:38 临时把存活探针 `failureThreshold` 调到 12、`timeoutSeconds` 调到 3，先止住重启风暴
- 11:58 coupon-service 加索引后恢复，order-service 指标回落；13:00 关闭降级开关

### 2、根治：超时、隔离、快速失败

**所有 HTTP 客户端设置超时**（Boot 4 的 HTTP 客户端全局默认值 + 按服务覆盖）：

```yaml
spring:
  http:
    clients:
      connect-timeout: 500ms
      read-timeout: 2s
    serviceclient:
      coupon:
        base-url: http://coupon-service
        read-timeout: 800ms        # 结算页可接受的优惠计算上限
```

**按下游拆分线程池**，有界小队列 + `AbortPolicy`，拒绝即快速失败，不转嫁给 Tomcat：

```java
@Bean
ThreadPoolExecutor couponExecutor(MeterRegistry registry) {
    ThreadPoolExecutor pool = new ThreadPoolExecutor(16, 16, 60, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100),
            Thread.ofPlatform().name("coupon-call-", 0).factory(),
            new ThreadPoolExecutor.AbortPolicy());
    ExecutorServiceMetrics.monitor(registry, pool, "couponCall");   // 暴露 executor_* 指标
    return pool;
}
```

**每个异步调用都有超时和降级**：

```java
CompletableFuture<CouponResult> coupon = supplyAsyncSafely(() -> couponClient.calculate(req), couponExecutor)
        .orTimeout(1, TimeUnit.SECONDS)
        .exceptionally(ex -> {
            log.warn("coupon degraded, orderToken={}", req.token(), ex);
            return CouponResult.unavailable();                          // 降级：不使用优惠券
        });

static <T> CompletableFuture<T> supplyAsyncSafely(Supplier<T> task, Executor executor) {
    try {
        return CompletableFuture.supplyAsync(task, executor);
    } catch (RejectedExecutionException e) {                            // 池满被拒绝，同样走降级
        return CompletableFuture.failedFuture(e);
    }
}
```

**探针与业务端口分离**：开启独立管理端口，探针请求不再与业务请求争抢 Tomcat 线程；存活检查只反映进程自身状态，不包含下游依赖：

```yaml
management:
  server:
    port: 8081
  endpoint:
    health:
      probes:
        enabled: true
```

```yaml
livenessProbe:
  httpGet: {path: /actuator/health/liveness, port: 8081}
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 6
readinessProbe:
  httpGet: {path: /actuator/health/readiness, port: 8081}
  periodSeconds: 5
  failureThreshold: 3
```

改造后在预发环境用故障注入让 coupon-service 延迟 5s：结算接口 P99 稳定在 1.1s（优惠降级），`couponCall` 池拒绝数上升，其他接口不受影响，无 Pod 重启。

::: tip 虚拟线程不能替代超时
改用虚拟线程后不再有"64 个线程用完"的问题，但对慢下游的并发会无限增长，压力转移到连接池和下游本身。超时、降级和 `Semaphore` 并发限制仍然必需。
:::

---

## 六、预防

**监控告警**：

```yaml
- alert: ExecutorQueueBacklog
  expr: executor_queued_tasks / (executor_queued_tasks + executor_queue_remaining_tasks) > 0.8
  for: 2m
  labels: {severity: warning}
- alert: ExecutorSaturated
  expr: executor_active_threads / executor_pool_max_threads >= 1
  for: 3m
  labels: {severity: critical}
- alert: TomcatThreadsExhausted
  # 需开启 server.tomcat.mbeanregistry.enabled=true
  expr: tomcat_threads_busy_threads / tomcat_threads_config_max_threads > 0.9
  for: 2m
  labels: {severity: critical}
```

同时对 `RejectedExecutionException` 计数、下游调用 P99（`http_client_requests_seconds`）和 Pod 重启次数（`kube_pod_container_status_restarts_total`）设置告警。

**代码规范**：

- 所有出站调用（HTTP、RPC、数据库、Redis）必须有连接超时和读取超时，Code Review 检查配置
- 每个下游使用独立线程池或信号量隔离；请求链路上的线程池禁用 `CallerRunsPolicy` 和无界队列
- `join()` / `get()` 必须带超时，或使用 `orTimeout` / `completeOnTimeout`
- 存活探针只检查进程自身，就绪探针才反映依赖；探针走独立管理端口

**测试**：

- 预发环境定期做故障注入：下游延迟 5s、下游返回 503，验证超时、降级和隔离生效
- 压测时观察 `executor_*` 与 `tomcat_threads_*` 指标，确认线程池在下游变慢时以"拒绝 + 降级"收场，而不是堆积

---

## 七、涉及知识点

- 线程池参数、拒绝策略与监控：[线程池](/java/28_topic_thread_pool#_8、拒绝策略)
- 线程池的常见坑：[线程池](/java/28_topic_thread_pool#八、常见坑)
- 超时设置与线程池 / 信号量隔离：[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#_1、线程池隔离)
- 降级策略设计：[降级](/high-avail/6_degradation)
- 存活 / 就绪探针与独立管理端口：[Actuator 监控](/spring-boot/11_actuator#四、存活-就绪探针与健康分组)
- 虚拟线程的适用边界：[虚拟线程](/java/30_topic_virtual_thread#十、什么时候不用)
- 线程栈分析：[诊断工具](/jvm/8_monitoring_tools#四、jstack-线程分析)

---

## 小结

- CPU 低、线程大量 `WAITING`、接口全面变慢，是线程池耗尽的典型画像；按线程池归类线程栈，找它们共同在等什么
- 下游没有超时是根源，共享线程池和 `CallerRunsPolicy` 让故障从一个依赖扩散到整个服务
- 修复三件套：所有出站调用有超时、按下游隔离、拒绝即降级
- 存活探针误判会把"忙"变成"重启风暴"，探针要走独立端口、只查进程自身

## 参考资料

- 线程池参数与拒绝策略：[ThreadPoolExecutor — Java SE 21 API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- `orTimeout` / `completeOnTimeout`：[CompletableFuture — Java SE 21 API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html)
- HTTP 客户端超时配置：[Spring Boot — Calling REST Services](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- 线程池指标：[Micrometer — JVM and Executor Metrics](https://docs.micrometer.io/micrometer/reference/reference/jvm.html)
- 探针配置：[Configure Liveness, Readiness and Startup Probes — Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)

> 下一篇：[死锁](./5_deadlock)

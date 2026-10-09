---
description: 优雅停机、K8s preStop、滚动参数与 PDB、服务预热、发布策略、变更三板斧
---

# 优雅上下线与变更

> **本篇目标**：让每次发布都做到实例级无损上下线（优雅停机、预热、可用实例数有保障），并用灰度、监控、回滚把变更风险控制在小范围。
>
> **前置阅读**：[限流与过载保护](./7_rate_limiting)

相关：[发布策略](/devops/5_release_strategy) · [冗余与故障转移 - K8s 探针](./2_redundancy_failover) · [Kubernetes](/cloud-native/6_kubernetes) · [数据库版本迁移](/spring-boot/4_flyway)

发布是频率最高的"计划内故障"：每次滚动发布都要让实例下线再上线。如果下线时直接杀进程、上线时冷启动直接接满流量，每次发布都会产生一批 502、连接重置和 RT 毛刺。高可用的变更管理要做到两点：**实例级的上下线无损**，以及**变更级的风险可控**。

## 一、优雅停机

### 1、停机顺序

| 顺序 | 动作 | 目的 |
|------|------|------|
| 1 | 从注册中心注销 / 从 K8s Endpoints 摘除 | 不再有新流量进来 |
| 2 | 等待调用方刷新实例列表（数秒）| 覆盖注册中心推送与客户端缓存的延迟 |
| 3 | Web 容器停止接收新请求，处理完在途请求 | 在途请求不被中断 |
| 4 | 停止 MQ 消费、定时任务，等待线程池任务完成 | 异步任务不丢失 |
| 5 | 关闭连接池、释放资源，进程退出 | 干净退出 |

最常见的错误是**顺序颠倒**：先停 Web 容器再注销，调用方在感知到下线之前仍把请求发过来，全部失败。

### 2、Spring Boot 配置

```yaml
server:
  shutdown: graceful                       # 2.3+ 支持；3.4 起嵌入式容器默认开启
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s        # 每个生命周期阶段的最长等待时间
```

`graceful` 模式下，Tomcat / Jetty / Undertow 收到停机信号后停止接收新请求，等待在途请求完成，超过 `timeout-per-shutdown-phase` 则强制关闭。

自定义线程池也要等待任务完成，否则停机时队列中的任务会被丢弃（使用 Spring Boot 自动配置的执行器时，对应配置为 `spring.task.execution.shutdown.await-termination` 与 `await-termination-period`）：

```java
@Bean
public ThreadPoolTaskExecutor bizExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(16);
    executor.setQueueCapacity(200);
    executor.setThreadNamePrefix("biz-");
    executor.setWaitForTasksToCompleteOnShutdown(true);   // 停机时等待已提交任务
    executor.setAwaitTerminationSeconds(20);              // 最多等待 20s
    return executor;
}
```

### 3、Kubernetes 配合

Pod 删除时，**摘除 Endpoints 与发送 SIGTERM 是并行发生的**：kube-proxy / Ingress / 注册中心感知摘除需要时间，而容器可能已经开始停机。所以需要 `preStop` 先等待一段时间：

```yaml
spec:
  terminationGracePeriodSeconds: 60        # 总宽限期，包含 preStop 耗时，超时后 SIGKILL
  containers:
    - name: order-service
      lifecycle:
        preStop:
          exec:
            # 先主动从注册中心下线，再等待流量摘干净
            command: ["sh", "-c", "curl -s -X POST localhost:8080/internal/offline; sleep 15"]
```

| 参数 | 建议 |
|------|------|
| `preStop` 等待时间 | 覆盖 Endpoints 传播 + 注册中心推送 + 客户端缓存刷新，一般 10 ~ 20s |
| `timeout-per-shutdown-phase` | 大于 P99.9 的请求耗时，一般 20 ~ 30s |
| `terminationGracePeriodSeconds` | ≥ preStop 等待 + 应用停机超时 + 余量 |

注意事项：

- **SIGTERM 要能到达 JVM**：Dockerfile 使用 exec 形式 `ENTRYPOINT ["java", "-jar", "app.jar"]`，或用 `tini` 作为 PID 1；shell 形式启动时 SIGTERM 只发给 sh，JVM 收不到，最终被 SIGKILL
- **`/internal/offline` 是示意**：可调用注册中心 SDK 注销（如 Nacos `NamingService#deregisterInstance`），或通过 Spring Cloud 的 `/actuator/serviceregistry` 端点把状态置为 DOWN（需注册中心实现支持）

### 4、保证可用实例数：滚动参数与 PDB

**滚动更新期间的可用实例数由 Deployment 的 `maxUnavailable` / `maxSurge` 控制；PodDisruptionBudget（PDB）只约束通过 Eviction API 发起的主动驱逐，两者管的不是同一件事。**

| 机制 | 约束的操作 | 不约束的操作 |
|------|-----------|------------|
| `maxUnavailable` / `maxSurge` | Deployment 自身的滚动更新 | 节点维护、驱逐 |
| PDB | 走 Eviction API 的自愿中断：`kubectl drain`、集群自动缩容回收节点、托管集群的节点升级 | Deployment 滚动更新、直接 `kubectl delete pod`、节点宕机等非自愿中断 |

```yaml
# Deployment：先起新实例、就绪后再下线旧实例，滚动期间可用实例数不减少
spec:
  replicas: 4
  minReadySeconds: 10          # 新 Pod 就绪后需稳定 10s 才计为可用，给预热留余量
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
---
# PDB：节点排空时，同一时刻最多驱逐 1 个 Pod
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: order-service
```

::: warning PDB 不要把驱逐完全堵死
`minAvailable` 等于副本数（或单副本服务配 `minAvailable: 1`）时，任何驱逐都会被拒绝，`kubectl drain` 会一直卡住，节点无法维护。副本数会被 HPA 调整时，优先用 `maxUnavailable: 1` 或百分比。
:::

### 5、RPC 与消息消费

| 组件 | 优雅停机要点 |
|------|------------|
| Dubbo | 内置优雅停机：先向注册中心注销，再等待在途调用完成，等待时间由 `dubbo.service.shutdown.wait` 控制 |
| MQ 消费者 | 先停止拉取新消息，处理完已拉取的消息并提交位点；未提交的消息会被重新投递，消费逻辑必须幂等 |
| 定时任务 | 分布式调度框架先摘除执行节点；本地 `@Scheduled` 任务默认不保证等待执行完成，需开启 `spring.task.scheduling.shutdown.await-termination=true` 并设置 `spring.task.scheduling.shutdown.await-termination-period`（如 30s）|

---

## 二、服务预热

新实例刚启动时 RT 明显偏高，直接接满流量可能被瞬间打垮，甚至触发熔断和级联故障。

| 冷启动原因 | 表现 | 预热手段 |
|-----------|------|---------|
| JIT 未编译 | 前几分钟代码以解释执行为主，CPU 高、RT 高 | 启动后执行预热请求；小流量逐步放大 |
| 本地缓存为空 | 大量请求穿透到 Redis / DB | 启动时加载热点数据 |
| 连接池未建立 | 首批请求要同步建连 | 启动阶段主动获取连接，配置 `minimumIdle` |
| 类加载、懒加载 Bean | 首次调用慢 | 预热调用核心接口；关闭不必要的懒加载 |

### 1、预热完成再就绪

Spring Boot 在所有 `ApplicationRunner` 执行完毕后才把就绪状态置为 `ACCEPTING_TRAFFIC`，因此把预热逻辑放在 Runner 中，K8s Readiness 探针会自然等到预热结束：

```java
@Component
@RequiredArgsConstructor
public class WarmupRunner implements ApplicationRunner {

    private final ProductCacheLoader cacheLoader;
    private final DataSource dataSource;
    private final OrderQueryService orderQueryService;

    @Override
    public void run(ApplicationArguments args) throws Exception {
        try (Connection ignored = dataSource.getConnection()) {
            // 触发连接池初始化
        }
        cacheLoader.loadHotProducts();                 // 加载热点缓存
        for (int i = 0; i < 200; i++) {                // 调用核心路径，促进 JIT 编译
            orderQueryService.warmup();
        }
    }
}
```

::: warning 注册中心的注册时机早于就绪
Spring Cloud 的自动注册在 Web 容器启动完成时触发，早于 `ApplicationRunner` 执行，也就是说**实例可能在预热结束前就被注册中心的调用方发现**。K8s Service 按 Readiness 摘流量不受影响；通过 Nacos 等注册中心发现的调用方则需要额外处理：关闭自动注册（`spring.cloud.service-registry.auto-registration.enabled=false`），在预热完成后由代码主动注册，或注册时先给低权重。
:::

### 2、权重预热

即使完成预热，新实例也不宜立刻承担同等流量。权重预热让新实例的流量占比随启动时长逐步上升：

| 方案 | 说明 |
|------|------|
| Dubbo | 内置 warmup，默认 10 分钟内权重随运行时长线性增长到配置值 |
| Nacos | 可在控制台 / OpenAPI 调整实例权重，由发布平台分步调高 |
| Spring Cloud LoadBalancer | 无内置预热，可在自定义负载均衡器中按实例元数据中的启动时间计算权重 |
| Nginx / Ingress | 通过 `weight` 或金丝雀比例逐步放量 |

---

## 三、发布策略

| 策略 | 做法 | 回滚速度 | 资源成本 | 适用 |
|------|------|---------|---------|------|
| 滚动发布 | 分批替换实例 | 慢（需再滚一次）| 低 | 常规迭代 |
| 蓝绿发布 | 新旧两套环境，一次切换全部流量 | 秒级（切回旧环境）| 高（双倍资源）| 重大版本、需要快速回滚 |
| 金丝雀 / 灰度 | 先放少量流量（按比例、用户、地域）到新版本 | 快（摘除灰度实例）| 中 | 高风险变更、核心链路 |

K8s 滚动、蓝绿、Ingress 金丝雀的具体配置与上线 SOP 见 [发布策略](/devops/5_release_strategy)，按请求头路由的灰度负载均衡实现见 [Spring Cloud 服务治理](/spring-cloud/5_service_governance)。

---

## 四、变更三板斧

业界常说的变更三板斧：**可灰度、可监控、可回滚**。任何一项做不到的变更，都不应在高峰期上线。

| 原则 | 要求 | 常见做法 |
|------|------|---------|
| 可灰度 | 变更先影响小范围，逐步扩大 | 单机 → 单机房 → 1% → 10% → 全量；每批之间留观察时间 |
| 可监控 | 能在分钟级发现变更引起的异常 | 发布大盘对比新旧版本成功率 / RT；基于 SLO 的燃烧速率告警，见 [可用性度量](./1_sla_slo) |
| 可回滚 | 出问题能快速恢复到变更前状态 | 镜像版本化、`kubectl rollout undo`、功能开关、配置历史版本 |

配套规则：

- **先止血后定位**：发布期间出现异常，第一反应是回滚，而不是在线上排查
- **变更可追溯**：所有发布、配置、数据修复都有记录，故障时能快速关联"刚刚改了什么"
- **封网与变更窗口**：大促、节假日前封网；日常变更避开业务高峰
- **错误预算约束**：预算不足时冻结非紧急变更

---

## 五、配置与数据变更

配置变更比代码发布更危险：它通常**秒级推送到全部实例**，没有滚动过程，也常常绕过测试。

| 风险 | 示例 | 防护 |
|------|------|------|
| 全量即时生效 | 一个错误的限流阈值推送到所有实例 | 配置灰度（Nacos Beta 发布到指定 IP），先推少量实例观察 |
| 格式 / 取值错误 | YAML 缩进错误、超时写成 0 | 发布前 Schema 校验；代码对非法值兜底为默认值 |
| 无法回滚 | 直接覆盖，旧值未知 | 配置中心保留历史版本，支持一键回滚 |
| 权限过大 | 任何人都能改生产配置 | 审批流、双人复核、操作审计 |
| 功能开关失控 | 开关长期不清理，组合状态无法预测 | 开关设置负责人与到期时间，定期清理 |

数据库结构变更遵循**先扩展后收缩（Expand-Contract）**：先加列 / 加表并兼容新旧代码，代码全量切换后再删除旧列，保证任一时刻回滚代码都不需要回滚表结构。迁移脚本管理见 [数据库版本迁移](/spring-boot/4_flyway)。

---

## 小结

- 停机顺序：先注销 / 摘流量，等调用方刷新，再停 Web 容器、停消费与定时任务、释放资源；K8s 用 `preStop` 覆盖摘除传播时间
- 线程池、`@Scheduled`、MQ 消费都要显式配置停机等待，SIGTERM 必须能到达 JVM
- 滚动更新靠 `maxUnavailable: 0` + `maxSurge` 保证可用实例数，PDB 只约束 Eviction API 驱逐
- 预热完成再就绪，再用权重逐步放量；注意注册中心的注册时机早于就绪
- 变更三板斧：可灰度、可监控、可回滚；配置变更同样要灰度，表结构变更先扩展后收缩

> 下一篇：[多活与容灾](./9_multi_active) —— 实例级的故障有了应对，接下来是机房和地域级的故障。

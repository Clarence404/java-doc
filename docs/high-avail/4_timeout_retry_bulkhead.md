---
description: 分层超时、指数退避与抖动、重试放大控制（重试预算、deadline 传播）、线程池 / 信号量隔离
---

# 超时、重试与隔离

> **本篇目标**：给每一次远程调用设好超时，只在该重试的地方有限重试并控制放大，用舱壁隔离把慢依赖的影响圈在局部。
>
> **前置阅读**：[负载均衡](./3_load_balancing)

参考链接：[Google SRE - Handling Overload](https://sre.google/sre-book/handling-overload/) · [Google SRE - Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) · [Resilience4j 文档](https://resilience4j.readme.io/docs)

雪崩通常不是从"下游挂了"开始，而是从"下游变慢"开始：调用方线程一直等，线程池被占满，自己也变慢，再拖垮上游。三件事按顺序解决这个问题：**超时**限制每次等待的上限，**重试**消化短暂故障，**隔离**让一个依赖耗尽的只是它自己的资源。重试的前提是幂等，见 [幂等设计](/architecture/5_idempotence)。

---

## 一、超时

**每一次跨进程调用都必须显式设置超时。** 许多客户端默认不超时或超时很长（例如 OpenFeign 默认连接 10s、读取 60s，JDBC 驱动 `socketTimeout` 默认 0 即不限），一个卡死的下游就能占住调用方全部线程。

### 1、连接超时与读取超时

| 类型 | 含义 | 建议 |
|------|------|------|
| 连接超时（connect timeout） | 建立 TCP 连接的最长时间 | 同机房一般 100ms ～ 1s；连不上通常意味着实例已不可用，宜短 |
| 读取超时（read / socket timeout） | 连接建立后等待响应数据的最长时间 | 按下游接口 P99～P999 延迟加余量设定 |
| 获取连接超时（pool acquire timeout） | 从连接池借连接的等待时间 | 宜短（几百毫秒），池耗尽时快速失败而不是排队 |
| 整体超时（call timeout / deadline） | 一次调用含重试的总时长上限 | 由上游剩余时间决定，见下文 deadline 传播 |

### 2、分层超时

**越靠近用户，超时越长；越靠近数据，超时越短。** 上游超时必须覆盖下游的全部尝试，否则上游已经放弃，下游还在重试，做的都是无用功。

![分层超时](../assets/high-avail/layered-timeout.svg)

### 3、超时值怎么定

- **按延迟分布定，不按平均值定**：取下游 P99（核心链路取 P999）再留 20%～50% 余量；平均值会让大量正常的长尾请求被误判超时
- **按接口定，不按服务定**：同一服务的查询接口与导出接口延迟差距很大，应分别配置
- **定期复核**：下游优化或劣化后超时值要跟着调整，否则要么形同虚设，要么误杀

常见量级参考（同机房，需按实测调整）：

| 调用类型 | 读取超时量级 |
|---------|------------|
| Redis 等缓存操作 | 10ms ～ 100ms |
| 数据库查询（OLTP） | 100ms ～ 1s |
| 内部 RPC / HTTP 调用 | 100ms ～ 1s |
| 外部第三方 HTTP 调用 | 1s ～ 5s |

### 4、配置示例

```yaml
# Spring Cloud OpenFeign：全局默认 + 按服务覆盖
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connect-timeout: 1000      # 连接超时 1s
            read-timeout: 3000         # 读取超时 3s
          inventory-service:           # 库存查询更快，单独收紧
            connect-timeout: 500
            read-timeout: 1000
```

::: warning 注意框架自带的超时
开启 `spring.cloud.openfeign.circuitbreaker.enabled` 并使用 Resilience4j 实现时，Spring Cloud CircuitBreaker 的 TimeLimiter 也会生效，其默认超时很短（1s），可能先于 Feign 的读取超时触发。建议显式配置 TimeLimiter，并让两者取值一致。
:::

---

## 二、重试

**重试只用来消化短暂故障（网络抖动、实例切换），而且只对幂等操作开启。** 对持续故障重试只会放大流量，让下游更难恢复。

### 1、哪些错误可以重试

| 错误类型 | 是否重试 | 说明 |
|---------|---------|------|
| 连接失败、连接被拒绝 | 可以 | 请求未到达下游，换实例重试最安全 |
| 读取超时 | 仅幂等操作 | 下游可能已执行成功，非幂等写会重复执行 |
| 503 / 429 等过载信号 | 谨慎，遵守 `Retry-After` | 过载时重试会加剧过载 |
| 4xx 参数错误、业务异常 | 不重试 | 重试结果不会变 |
| 熔断器打开（`CallNotPermittedException`） | 不重试 | 熔断就是为了不再调用 |

### 2、指数退避与随机抖动

**每次重试的等待时间按指数增长，再叠加随机抖动。** 退避给下游恢复的时间；抖动把大量客户端的重试时刻打散，避免它们在同一时刻集中重试、形成周期性尖峰。

![指数退避与随机抖动](../assets/high-avail/retry-backoff.svg)

```java
// Resilience4j Retry：指数退避 + 随机抖动
RetryConfig config = RetryConfig.custom()
    .maxAttempts(3)                                   // 总调用次数（含首次）：首次 + 最多 2 次重试
    .intervalFunction(IntervalFunction.ofExponentialRandomBackoff(
        Duration.ofMillis(100),                       // 初始等待 100ms
        2.0,                                          // 每次翻倍
        0.5,                                          // 抖动因子：实际等待在 ±50% 范围内随机
        Duration.ofSeconds(2)))                       // 单次等待上限
    .retryExceptions(IOException.class, TimeoutException.class)
    .ignoreExceptions(BusinessException.class, CallNotPermittedException.class)
    .build();

Retry retry = RetryRegistry.of(config).retry("inventory");
Supplier<Stock> call = Retry.decorateSupplier(retry, () -> inventoryClient.query(skuId));
```

在线请求的重试等待应控制在百毫秒级，整体仍要落在上游超时之内；秒级、分钟级的退避只适合异步任务和消息重投。

### 3、重试放大控制

**每一层都"重试 3 次"时，放大是乘法：3 层调用、每层最多 3 次尝试，最底层会收到 3 × 3 × 3 = 27 倍请求。** 下游本来只是过载，被重试流量直接打垮。控制放大有四条规则：

| 规则 | 做法 |
|------|------|
| 只在一层重试 | 通常放在直接调用不稳定依赖的那一层；其他层收到失败后直接向上返回，不再叠加重试 |
| 单请求限次 | 每个请求最多尝试 2～3 次，且一次调用内换实例重试（`proxy_next_upstream_tries`、SCL 重试）也计入次数 |
| 重试预算 | 按客户端统计，重试请求不超过正常请求的一定比例（如 10%）；超出预算直接失败，故障时重试量不会跟着请求量膨胀 |
| deadline 传播 | 上游把剩余时间传给下游，下游用 `min(自身超时, 剩余时间)`；剩余时间不足时直接失败，不再发起调用或重试 |

**重试预算**可以用令牌桶思路实现（gRPC 的 retryThrottling 与此类似）：

```java
/** 重试预算示意：每次成功调用返还 ratio 个额度，每次重试消耗 1 个，额度不足则放弃重试 */
public final class RetryBudget {

    private final double maxTokens;
    private final double ratio;      // 0.1 表示稳态下重试量约为成功请求量的 10%
    private double tokens;

    public RetryBudget(double maxTokens, double ratio) {
        this.maxTokens = maxTokens;
        this.ratio = ratio;
        this.tokens = maxTokens;
    }

    public synchronized void onSuccess() {
        tokens = Math.min(maxTokens, tokens + ratio);
    }

    public synchronized boolean tryAcquireRetry() {
        if (tokens < 1) {
            return false;
        }
        tokens -= 1;
        return true;
    }
}

// 接入 Resilience4j：只有可重试异常且预算充足时才重试
RetryConfig config = RetryConfig.custom()
    .maxAttempts(3)
    .intervalFunction(IntervalFunction.ofExponentialRandomBackoff(Duration.ofMillis(100), 2.0, 0.5, Duration.ofSeconds(1)))
    .retryOnException(e -> isTransient(e) && budget.tryAcquireRetry())
    .build();

Supplier<Stock> call = Retry.decorateSupplier(Retry.of("inventory", config), () -> {
    Stock stock = inventoryClient.query(skuId);
    budget.onSuccess();                              // 成功调用返还额度
    return stock;
});
```

**deadline 传播**：gRPC 原生支持，服务端处理请求时发起的下游调用会自动继承剩余 deadline；HTTP 调用需要自行约定请求头（如 `X-Timeout-Ms` 传剩余毫秒数），各跳用本地时钟换算截止时间。传相对时长而不是绝对时间戳，可以避开机器间的时钟偏差。

**上游超时的推导**：设下游单次超时为 `T`，最多重试 `N` 次，退避总时长为 `B`，上游自身处理耗时为 `S`，则上游超时应满足 `T_上游 ≥ T × (N + 1) + B + S`。

| 取值 | 计算 | 结论 |
|------|------|------|
| 网关调订单：`T` = 3s，`N` = 1，`B` ≈ 0.2s | 3 × 2 + 0.2 ≈ 6.2s | Nginx 调网关的超时取 8s，客户端 10s |
| 若订单也调库存重试 2 次：`T` = 1s | 1 × 3 + 退避 ≈ 3.3s | 已超过网关给订单的 3s，订单的重试注定白做 |

算不过来时，要么缩短下游超时，要么减少重试次数，要么去掉某一层的重试，而不是一味加大上游超时。

::: tip 重试与熔断的配合
Resilience4j 注解默认的装饰顺序是 `Retry ( CircuitBreaker ( RateLimiter ( TimeLimiter ( Bulkhead ( 调用 ) ) ) ) )`：重试在最外层，每次尝试都会被熔断器统计。熔断打开后抛出的 `CallNotPermittedException` 必须排除在重试之外，见 [熔断](./5_circuit_breaking)。
:::

### 4、Spring Retry

Spring 生态可用 `@Retryable` + `@Backoff` 声明式实现退避重试，`@Recover` 做重试耗尽后的兜底。用法、退避参数、`RetryTemplate` 与自定义 `RetryPolicy` 详见 [Retry 重试](/spring/6_retry)。

---

## 三、隔离

**舱壁隔离（Bulkhead）借鉴船舱的隔水舱：给每个依赖划出独立的并发配额，一个依赖变慢，最多耗尽它自己的配额，不会占满整个服务的线程。**

![线程池隔离](../assets/high-avail/bulkhead-thread-pool.svg)

### 1、线程池隔离

为每个依赖分配独立线程池，调用在隔离池中执行，调用方可以按超时放弃等待：

```java
// Resilience4j 线程池隔离
ThreadPoolBulkheadConfig config = ThreadPoolBulkheadConfig.custom()
    .coreThreadPoolSize(5)
    .maxThreadPoolSize(10)                  // 该依赖最多占用 10 个线程
    .queueCapacity(20)                      // 队列满后直接拒绝（BulkheadFullException）
    .keepAliveDuration(Duration.ofMillis(20))
    .build();

ThreadPoolBulkhead bulkhead = ThreadPoolBulkheadRegistry.of(config).bulkhead("inventory");

// 返回 CompletionStage，调用方配合 TimeLimiter 或 orTimeout 控制等待上限
CompletionStage<Stock> future = bulkhead.executeSupplier(() -> inventoryClient.query(skuId));
```

### 2、信号量隔离

用计数信号量限制对某个依赖的并发调用数，超过即拒绝，调用仍在当前线程执行：

```java
@Service
@Slf4j
public class InventoryFacade {

    // 最多 20 个并发调用；拿不到许可最多等 10ms，之后走兜底
    @Bulkhead(name = "inventory", fallbackMethod = "queryFallback")
    public Stock query(Long skuId) {
        return inventoryClient.query(skuId);
    }

    private Stock queryFallback(Long skuId, BulkheadFullException e) {
        log.warn("库存查询并发已满，返回兜底值 skuId={}", skuId);
        return Stock.unknown(skuId);
    }
}
```

```yaml
resilience4j:
  bulkhead:
    instances:
      inventory:
        max-concurrent-calls: 20
        max-wait-duration: 10ms
```

### 3、如何选择

| 对比 | 线程池隔离 | 信号量隔离 |
|------|-----------|-----------|
| 隔离程度 | 强：慢调用只占隔离池线程 | 中：慢调用仍占用调用方线程，只是数量受限 |
| 开销 | 线程切换、上下文传递（ThreadLocal、链路追踪需要额外处理） | 几乎没有额外开销 |
| 超时控制 | 调用方可以放弃等待（Future 超时） | 依赖下游客户端自身的超时 |
| 适用 | 外部 HTTP 调用、慢且不稳定的依赖 | 内部快速依赖、调用量大的场景 |

**配额大小用 Little 定律估算**：并发数 ≈ 该依赖的 QPS × P99 延迟。例如 200 QPS、P99 为 50ms，稳态并发约 10，配额取 15～20；配额过大起不到隔离作用，过小会误拒正常请求。定律推导见 [性能指标](/high-perf/1_metrics)。

### 4、其他隔离维度

线程与信号量只是进程内的隔离，同样的思路可以用在更大的粒度上：

| 维度 | 做法 | 目的 |
|------|------|------|
| 核心与非核心 | 核心链路独立部署、独立数据库连接池 | 非核心功能出问题不影响下单、支付 |
| 快慢请求 | 导出、报表等慢接口使用独立线程池或独立实例 | 慢请求不挤占在线请求 |
| 读写 | 读写分离，报表查询走只读库 | 大查询不拖慢写入 |
| 租户 / 调用方 | 按调用方或租户分配配额 | 单个调用方异常不影响其他调用方 |
| 部署 | 跨可用区、单元化部署 | 限制故障爆炸半径，见 [多活与容灾](./9_multi_active) |

超出容量时主动丢弃部分请求（负载卸除）属于过载保护，见 [限流与过载保护](./7_rate_limiting)。

---

## 小结

- 每个远程调用都显式设置连接超时和读取超时，取值按 P99～P999 加余量，按接口分别配置
- 重试只对幂等操作和短暂故障开启，用指数退避加随机抖动，在线请求的重试等待控制在百毫秒级
- 控制重试放大：只在一层重试、单请求限次、重试预算、deadline 传播，并满足 `T_上游 ≥ T × (N + 1) + B + S`
- 用线程池或信号量给每个依赖划配额，配额按 QPS × P99 估算

> 下一篇：[熔断](./5_circuit_breaking) —— 下游持续失败时，连超时都不必再等，直接快速失败。

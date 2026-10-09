---
description: 核心 @Retryable、退避与抖动、@ConcurrencyLimit、RetryTemplate、迁移
---

# Retry 重试

> **本篇目标**：掌握 Spring Framework 7 内置的弹性能力（`@Retryable`、`@ConcurrencyLimit`、`RetryTemplate`），能为远程调用写出次数、退避、抖动、异常范围都清晰可控的重试，理解它与事务、幂等、熔断的配合，并能把 Boot 3 项目中的 Spring Retry 迁移过来。
>
> **前置阅读**：[AOP](./2_aop)

> 参考资料：
> * Spring Framework Resilience Features：[https://docs.spring.io/spring-framework/reference/core/resilience.html](https://docs.spring.io/spring-framework/reference/core/resilience.html)
> * `@Retryable` Javadoc：[https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/resilience/annotation/Retryable.html](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/resilience/annotation/Retryable.html)
> * Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
> * Spring Retry（已归档）：[https://github.com/spring-projects/spring-retry](https://github.com/spring-projects/spring-retry)

本篇只讲 Spring 中**怎么写**重试。哪些错误该重试、指数退避与抖动的原理、重试放大与重试预算见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)；熔断见 [熔断](/high-avail/5_circuit_breaking)。

---

## 一、方案选择

| 方案 | 适用版本 | 定位 |
|------|---------|------|
| Framework 7 核心弹性（`@Retryable`、`@ConcurrencyLimit`、`RetryTemplate`） | Spring Framework 7 / Boot 4 | **新项目首选**，无额外依赖，支持响应式返回值 |
| Spring Retry（`org.springframework.retry`） | Boot 3 及以前 | 已归档，README 说明由 Framework 7 取代；Boot 4 不再管理其版本 |
| Resilience4j / Spring Cloud CircuitBreaker | 任意 | 需要熔断、舱壁、限流、时间限制等组合能力时使用 |
| Reactor `retryWhen(Retry.backoff(...))` | WebFlux | 响应式链路内部的重试，见 [WebFlux](./8_webflux) |

> Framework 7 的核心重试只解决「重试」和「并发限制」，**没有熔断**。熔断、降级仍用 Resilience4j 或 Sentinel，见 [服务治理 · 限流与熔断](/spring-cloud/5_service_governance)。

---

## 二、声明式重试：@Retryable

### 1、开启

`@Retryable`、`@ConcurrencyLimit` 位于 `spring-context`（包 `org.springframework.resilience.annotation`），不需要引入 Spring Retry，也不需要 AspectJ starter。在配置类上声明 `@EnableResilientMethods` 开启：

```java
import org.springframework.context.annotation.Configuration;
import org.springframework.resilience.annotation.EnableResilientMethods;

@Configuration
@EnableResilientMethods     // 同时开启 @Retryable 与 @ConcurrencyLimit
public class ResilienceConfig { }
```

也可以只注册其中一个后处理器：`RetryAnnotationBeanPostProcessor` 或 `ConcurrencyLimitBeanPostProcessor`。

### 2、默认行为与次数语义

```java
@Service
public class NotificationService {

    private final JmsClient jmsClient;

    public NotificationService(JmsClient jmsClient) {
        this.jmsClient = jmsClient;
    }

    @Retryable     // 任意异常都重试，最多重试 3 次，每次间隔 1 秒
    public void send(Notification n) {
        jmsClient.destination("notifications").send(n);
    }
}
```

| 属性 | 默认值 | 说明 |
|------|-------|------|
| `includes` / `value` | 空（所有异常） | 需要重试的异常，**同时匹配异常本身及其嵌套 cause** |
| `excludes` | 空 | 不重试的异常 |
| `predicate` | 无 | 自定义 `MethodRetryPredicate`，在 includes / excludes 之后判断 |
| `maxRetries` | 3 | **重试次数，不含首次调用**：总调用次数 = 1 + maxRetries |
| `delay` | 1000 | 首次重试前的等待 |
| `multiplier` | 1.0 | 每次等待的倍数，1.0 即固定间隔 |
| `maxDelay` | 不限 | 等待上限 |
| `jitter` | 0 | 随机抖动幅度 |
| `timeout` | 0（不限） | 整体超时，7.0.2 起提供 |
| `timeUnit` | 毫秒 | 作用于 `delay`、`jitter`、`maxDelay` |

重试耗尽后，**最后一次的原始异常**直接抛给调用方。每次异常还会发布一个 `MethodRetryEvent`，可以监听它做重试监控。

### 3、退避与抖动

```java
@Retryable(
    includes   = {ConnectException.class, SocketTimeoutException.class},
    excludes   = BusinessException.class,     // 业务异常重试无意义
    maxRetries = 4,                           // 总共最多调用 5 次
    delay      = 500,
    multiplier = 2,
    maxDelay   = 5000,
    jitter     = 100)
public PriceVO queryPrice(String sku) {
    return priceClient.query(sku);
}
```

上例 4 次重试前的等待依次约为 500ms、1s、2s、4s：

- 第 n 次等待 = `delay × multiplier^(n-1)`，不超过 `maxDelay`
- 设置 `jitter` 后，每次在计算值基础上随机加减最多 `jitter`（有 `multiplier` 时抖动幅度同样按倍数放大），且结果不小于 `delay`、不大于 `maxDelay`；多个实例同时失败时，抖动把重试时间打散，避免同时冲击下游
- `delay = 0` 加正的 `jitter` 时间隔不再增长，每次在 `0 ~ min(jitter, maxDelay)` 之间随机等待

### 4、外部化配置

数值属性都有对应的 `*String` 版本，支持 `${...}` 占位符与 SpEL，非空时覆盖数值属性：

```java
@Retryable(
    maxRetriesString = "${app.retry.price.max-retries:3}",
    delayString      = "${app.retry.price.delay:500ms}",
    maxDelayString   = "${app.retry.price.max-delay:5s}")
public PriceVO queryPrice(String sku) { ... }
```

### 5、没有 @Recover：兜底写在调用方

Framework 7 的 `@Retryable` 没有 `@Recover` 这类兜底注解。重试耗尽后原始异常会抛出来，由调用方决定降级：

```java
public PriceVO priceOrDefault(String sku) {
    try {
        return priceService.queryPrice(sku);       // 通过代理调用，带重试
    } catch (ConnectException | SocketTimeoutException e) {
        log.warn("价格服务重试耗尽，使用缓存价格 sku={}", sku, e);
        return priceCache.lastKnown(sku);
    }
}
```

需要「重试 + 兜底」写在一处时，用下文的 `RetryTemplate`。

### 6、响应式返回值

方法返回 `Mono` / `Flux` 时，`@Retryable` 不会在方法调用层面重试，而是给返回的 Publisher 装饰 Reactor 的重试规格，失败时重新订阅：

```java
@Retryable(maxRetries = 4, delay = 100)
public Mono<PriceVO> queryPriceReactive(String sku) {
    return webClient.get().uri("/price/{sku}", sku).retrieve().bodyToMono(PriceVO.class);
}
```

---

## 三、并发限制：@ConcurrencyLimit

`@ConcurrencyLimit` 限制同时进入方法的线程数，作用类似一个只计数不建线程的「池」：

```java
@ConcurrencyLimit(10)       // 同时最多 10 个线程进入，超出的默认阻塞等待
public ReportVO export(ReportQuery q) { ... }

@ConcurrencyLimit(limit = 3, policy = ConcurrencyLimit.ThrottlePolicy.REJECT)  // 7.0.3+
public void callLegacySystem(Request req) { ... }   // 超出直接抛 InvocationRejectedException
```

- `limit = 1` 相当于对该 Bean 实例的方法加锁，串行执行
- `limitString` 支持占位符；`policy` 默认 `BLOCK`，`REJECT` 抛出的 `InvocationRejectedException` 继承自 `RejectedExecutionException`
- 注解在类上时，类中所有方法**共享一个**并发计数；注解在方法上时各自独立
- **主要场景是虚拟线程**：虚拟线程没有池大小上限，大量并发请求会把下游（数据库连接池、老旧系统、限频的第三方 API）压垮，用它在方法级加一道闸。虚拟线程见 [虚拟线程](/java/30_topic_virtual_thread)

它是**单实例内**的并发保护，不是集群限流。集群级限流见 [限流与过载保护](/high-avail/7_rate_limiting)。

---

## 四、编程式重试：RetryTemplate

以下场景用 `org.springframework.core.retry.RetryTemplate`：

- 只想重试方法中的**一段**逻辑，而不是整个方法
- 不同调用需要不同策略（例如按租户、按下游配置）
- 需要「重试 + 兜底」写在一处
- 调用发生在同一个类内部，注解会因自调用不经过代理而失效

### 1、构建 RetryPolicy

```java
import java.time.Duration;
import org.springframework.core.retry.RetryPolicy;
import org.springframework.core.retry.RetryTemplate;

RetryPolicy policy = RetryPolicy.builder()
    .includes(ConnectException.class, SocketTimeoutException.class)
    .excludes(BusinessException.class)
    .maxRetries(3)
    .delay(Duration.ofMillis(500))
    .multiplier(2)
    .maxDelay(Duration.ofSeconds(5))
    .jitter(Duration.ofMillis(100))
    .build();

RetryTemplate retryTemplate = new RetryTemplate(policy);
```

快捷写法：`new RetryTemplate()` 使用 `RetryPolicy.withDefaults()`（3 次重试、1 秒间隔）；`RetryPolicy.withMaxRetries(4)` 只改次数。`RetryTemplate` 很轻量，可以按需临时创建。

### 2、invoke 与 execute

```java
@Service
public class PayService {

    private static final Logger log = LoggerFactory.getLogger(PayService.class);

    private final PayClient payClient;
    private final RetryTemplate retryTemplate;

    public PayService(PayClient payClient) {
        this.payClient = payClient;
        this.retryTemplate = new RetryTemplate(RetryPolicy.builder()
            .includes(PayTimeoutException.class)
            .maxRetries(2)
            .delay(Duration.ofMillis(300))
            .build());
        this.retryTemplate.setRetryListener(new RetryListener() {
            @Override
            public void onRetryFailure(RetryPolicy retryPolicy, Retryable<?> retryable,
                                       Throwable throwable) {
                log.warn("支付重试失败: {}", throwable.getMessage());
            }
        });
    }

    // invoke：重试耗尽后抛出最后一次的原始（非受检）异常
    public PayResult pay(PayRequest req) {
        try {
            return retryTemplate.invoke(() -> payClient.charge(req));
        } catch (PayTimeoutException e) {
            log.error("支付重试耗尽 orderNo={}", req.orderNo(), e);
            return PayResult.pending(req.orderNo());   // 结果未知，交给对账/查询补偿
        }
    }

    // execute：抛出受检的 RetryException，可拿到每次尝试的异常
    public PayResult payWithDetail(PayRequest req) throws RetryException {
        return retryTemplate.execute(() -> payClient.charge(req));
        // 调用方 catch (RetryException ex) 后可用 ex.getExceptions() / ex.getLastException()
    }
}
```

`RetryListener`（`org.springframework.core.retry` 包，注意与注解 `@Retryable` 同名的 `Retryable` 接口也在该包）的方法都有默认实现，常用 `beforeRetry`、`onRetrySuccess`、`onRetryFailure`、`onRetryPolicyExhaustion`；多个监听器用 `CompositeRetryListener` 组合。需要完全自定义退避时，实现 `RetryPolicy` 或用 builder 的 `backOff(...)` 传入 `BackOff`。

> 支付这类非幂等操作重试前必须确认下游支持幂等（同一订单号重复扣款只生效一次），超时后状态未知时走查询补偿，而不是盲目重试。幂等方案见 [幂等方案总结](/architecture/5_idempotence)。

---

## 五、与代理、事务、熔断的配合

### 1、自调用失效

`@Retryable`、`@ConcurrencyLimit` 和事务一样基于代理：同类内部 `this.queryPrice()` 不经过代理，不会重试；`private` 方法也不会被拦截。原因与解决办法见 [AOP · 自调用失效问题](./2_aop)。

### 2、重试要包住事务，而不是在事务里重试

数据库乐观锁冲突、死锁等需要重试的场景，每次重试都应该是**一个新事务**。如果重试发生在同一个事务内部，第一次失败可能已把事务标记为 rollback-only，后面的重试即使成功也提交不了。

推荐把两者放在**不同的 Bean** 上，顺序一目了然：

```java
@Service
@RequiredArgsConstructor
public class StockFacade {

    private final StockService stockService;

    @Retryable(includes = OptimisticLockingFailureException.class, maxRetries = 3, delay = 50, jitter = 30)
    public void deduct(Long skuId, int qty) {
        stockService.deductInTx(skuId, qty);    // 每次重试都开启一个新事务
    }
}

@Service
public class StockService {
    @Transactional
    public void deductInTx(Long skuId, int qty) { ... }
}
```

同一个方法上同时标 `@Retryable` 和 `@Transactional` 时，两个拦截器的先后取决于各自的 order 配置，不直观，不建议依赖。事务传播见 [事务管理](./4_transaction)。

### 3、重试与熔断

- 只重试**幂等**操作与**瞬时**错误（连接失败、超时、429/503），4xx 业务错误不重试
- 重试次数要和上游超时预算匹配：上游 3 秒超时，下游重试 4 次、每次 1 秒，用户早已收到超时
- 多层重试会成倍放大流量（网关、Feign、业务代码各最多调用 3 次即 3 × 3 × 3 = 27 倍），只在一层重试
- 下游持续故障时重试只会加剧故障，需要熔断快速失败。Resilience4j 中重试与熔断的装配顺序见 [熔断 · 与重试的执行顺序](/high-avail/5_circuit_breaking)；Spring Cloud 中的接入见 [服务治理](/spring-cloud/5_service_governance)

---

## 六、Spring Retry（Boot 3 存量项目）

Spring Retry 的 README 已声明不再作为开源项目维护、由 Framework 7 取代并归档；Boot 4 移除了它的依赖管理。Boot 3 项目可以继续使用，Boot 4 项目如暂时保留，需要自己写版本号：

```xml
<dependency>
    <groupId>org.springframework.retry</groupId>
    <artifactId>spring-retry</artifactId>
    <version>2.0.13</version>   <!-- Boot 4 不再管理版本；Boot 3 可省略 -->
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>   <!-- Boot 4 改名为 spring-boot-starter-aspectj -->
</dependency>
```

### 1、语义差异：maxAttempts 包含首次调用

```java
@Configuration
@EnableRetry
public class RetryConfig { }

@Service
public class RemoteService {

    private static final Logger log = LoggerFactory.getLogger(RemoteService.class);

    private final RestClient restClient;

    public RemoteService(RestClient restClient) {
        this.restClient = restClient;
    }

    // maxAttempts = 3：总共 3 次调用（首次 + 2 次重试），只等待两次：1s、2s
    @Retryable(retryFor = RemoteCallException.class, maxAttempts = 3,
               backoff = @Backoff(delay = 1000, multiplier = 2, maxDelay = 10000),
               recover = "callApiFallback")    // 显式指定兜底方法，避免多个 @Recover 时匹配歧义
    public String callApi(String param) {
        return restClient.get().uri("/api?p={p}", param).retrieve().body(String.class);
    }

    // 第一个参数是异常，其余参数与原方法一致，返回类型相同
    @Recover
    public String callApiFallback(RemoteCallException e, String param) {
        log.error("重试耗尽 param={}", param, e);
        return "fallback-" + param;
    }
}
```

| 概念 | Spring Retry | Framework 7 |
|------|-------------|-------------|
| 次数 | `maxAttempts`（**含**首次，默认 3） | `maxRetries`（**不含**首次，默认 3） |
| 开启 | `@EnableRetry` + AOP starter | `@EnableResilientMethods` |
| 异常范围 | `retryFor` / `noRetryFor` | `includes` / `excludes` / `predicate` |
| 退避 | `@Backoff(delay, multiplier, maxDelay, random)` | `delay` / `multiplier` / `maxDelay` / `jitter` |
| 兜底 | `@Recover` | 调用方 catch，或 `RetryTemplate` 中处理 |
| 编程式 | `org.springframework.retry.support.RetryTemplate` | `org.springframework.core.retry.RetryTemplate` |
| 监听 | `RetryListener`（`RetryListenerSupport` 自 2.0 起废弃，直接实现接口即可，方法都有默认实现） | `RetryListener` / `MethodRetryEvent` |
| 熔断 | `@CircuitBreaker` | 无，使用 Resilience4j |

迁移时注意次数换算：`maxAttempts = 3` 对应 `maxRetries = 2`。

### 2、random 抖动的真实含义

`@Backoff(random = true)` 不是「在间隔上加减一半」：

- 有 `multiplier` 时使用 `ExponentialRandomBackOffPolicy`，每次等待在 `[d, d × multiplier]` 之间均匀随机（`d` 为当前指数间隔），不会小于 `d`
- 没有 `multiplier` 时使用 `UniformRandomBackOffPolicy`，需要 `maxDelay > delay` 才会在 `[delay, maxDelay]` 之间随机；只写 `@Backoff(delay = 500, random = true)` **没有任何抖动**

### 3、@CircuitBreaker 参数

| 参数 | 默认值 | 含义 |
|------|-------|------|
| `maxAttempts` | 3 | 在 `openTimeout` 窗口内失败达到该次数，熔断器打开 |
| `openTimeout` | 5000 ms | 统计失败次数的时间窗口 |
| `resetTimeout` | 20000 ms | 打开状态持续多久后放行下一次调用试探（半开） |

打开期间直接走 `@Recover`。它只按失败次数统计，没有失败率、慢调用、舱壁等能力，生产环境建议换成 Resilience4j。

---

## 七、适用场景

| 适合重试 | 不适合重试 |
|---------|-----------|
| 远程调用的网络抖动、连接拒绝、读超时 | 参数校验失败、权限不足等确定性业务错误 |
| 数据库乐观锁冲突、死锁（每次重试新事务） | 未确认幂等的写操作（支付、扣库存、发券） |
| 下游返回 429 / 503（结合 `Retry-After`） | 下游已持续故障（应熔断而不是重试） |
| 消息消费的瞬时失败（MQ 自身也有重试机制，二者不要叠加） | 用户在线等待、超时预算已不足的链路 |

---

## 小结

- Boot 4 / Framework 7 首选核心弹性能力：`@EnableResilientMethods` 开启 `@Retryable` 与 `@ConcurrencyLimit`，无需 Spring Retry 和 AspectJ starter
- `maxRetries` 不含首次调用，默认 3 次、间隔 1 秒、所有异常都重试；用 `includes` / `excludes` 收窄范围，用 `multiplier` + `maxDelay` + `jitter` 做指数退避加抖动
- 没有 `@Recover`，耗尽后抛出原始异常，兜底由调用方或 `RetryTemplate` 处理
- `@ConcurrencyLimit` 是单实例并发闸门，特别适合给虚拟线程下的下游调用限流
- 重试要包住事务、只重试幂等操作与瞬时错误、只在一层重试；持续故障交给熔断
- Spring Retry 已归档：`maxAttempts` 含首次调用，`random` 抖动需配合 `multiplier` 或 `maxDelay`，`@CircuitBreaker` 的 `openTimeout` 是统计窗口、`resetTimeout` 是打开时长

> 下一篇：[事件机制](./7_event) —— 用事件把业务主流程与后续动作解耦，并理解事务事件的执行时机与可靠性边界。

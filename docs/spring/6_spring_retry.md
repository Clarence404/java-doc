# Spring Retry

> 参考资料：
> * GitHub：[https://github.com/spring-projects/spring-retry](https://github.com/spring-projects/spring-retry)
> * Spring Retry 实战：[https://www.baeldung.com/spring-retry](https://www.baeldung.com/spring-retry)

## 一、快速使用

```xml
<dependency>
    <groupId>org.springframework.retry</groupId>
    <artifactId>spring-retry</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

```java
@EnableRetry
@SpringBootApplication
public class App { }
```

### 1.1 @Retryable 基本用法

```java
@Service
public class RemoteService {

    // 遇到 RemoteCallException 最多重试 3 次，退避策略：1s → 2s → 4s（指数）
    @Retryable(
        retryFor = RemoteCallException.class,
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2, maxDelay = 10000)
    )
    public String callApi(String param) {
        // 模拟远程调用
        return httpClient.get("/api?p=" + param);
    }

    // 所有重试耗尽后执行（方法签名：第一个参数是捕获的异常，其余参数与原方法一致）
    @Recover
    public String recover(RemoteCallException e, String param) {
        log.error("重试耗尽，param={}, 原因: {}", param, e.getMessage());
        return "fallback-" + param;
    }
}
```

### 1.2 重试多个异常 + 排除异常

```java
@Retryable(
    retryFor  = {IOException.class, TimeoutException.class},
    noRetryFor = BusinessException.class,   // 业务异常不重试
    maxAttempts = 4,
    backoff = @Backoff(delay = 500, random = true)  // 随机抖动，防止惊群
)
public void processMessage(Message msg) { ... }
```

---

## 二、退避策略

| 参数 | 说明 |
|------|------|
| `delay` | 首次重试等待时间（ms） |
| `multiplier` | 每次等待时间的倍数（指数退避，建议 1.5–2） |
| `maxDelay` | 等待时间上限（ms），避免无限增长 |
| `random` | 是否在等待时间上加随机抖动（防止同时重试的惊群效应） |

```java
// 固定间隔
@Backoff(delay = 2000)                         // 每次等 2s

// 指数退避：1s → 2s → 4s → 最多 10s
@Backoff(delay = 1000, multiplier = 2, maxDelay = 10000)

// 加随机抖动：1s±0.5s → 2s±1s → ...
@Backoff(delay = 1000, multiplier = 2, random = true)
```

---

## 三、RetryTemplate（编程式重试）

注解方式无法处理 lambda 内部的重试，此时用 `RetryTemplate`：

```java
@Bean
public RetryTemplate retryTemplate() {
    return RetryTemplate.builder()
        .maxAttempts(3)
        .exponentialBackoff(1000, 2, 10000)
        .retryOn(IOException.class)
        .withListener(new RetryListenerSupport() {
            @Override
            public <T, E extends Throwable> void onError(RetryContext context,
                                                          RetryCallback<T, E> callback,
                                                          Throwable throwable) {
                log.warn("第 {} 次重试失败: {}", context.getRetryCount(), throwable.getMessage());
            }
        })
        .build();
}

@Service
@RequiredArgsConstructor
public class PayService {

    private final RetryTemplate retryTemplate;

    public PayResult pay(PayRequest req) {
        return retryTemplate.execute(
            ctx -> {
                // 重试逻辑
                return payClient.charge(req);
            },
            ctx -> {
                // recover 逻辑（重试耗尽后）
                log.error("支付重试耗尽: {}", ctx.getLastThrowable().getMessage());
                return PayResult.fail("支付服务暂不可用");
            }
        );
    }
}
```

---

## 四、自定义 RetryPolicy

```java
// 按异常类型 + 最大次数组合
RetryPolicy policy = new ExceptionClassifierRetryPolicy();
((ExceptionClassifierRetryPolicy) policy).setPolicyMap(Map.of(
    IOException.class,        new SimpleRetryPolicy(3),
    TimeoutException.class,   new SimpleRetryPolicy(5),
    BusinessException.class,  new NeverRetryPolicy()    // 不重试
));

// 按时间限制：最多重试 10 秒内
RetryPolicy timePolicy = new TimeoutRetryPolicy();
((TimeoutRetryPolicy) timePolicy).setTimeout(10_000L);

// 组合策略
CompositeRetryPolicy composite = new CompositeRetryPolicy();
composite.setPolicies(new RetryPolicy[]{new SimpleRetryPolicy(3), timePolicy});
composite.setOptimistic(false);  // false = 所有策略都允许才重试
```

---

## 五、@CircuitBreaker（断路器）

```java
// 熔断器：失败超过阈值后打开，停止重试，直接走 recover
@CircuitBreaker(
    include = RemoteCallException.class,
    openTimeout = 5000L,     // 熔断器打开后 5 秒尝试半开
    resetTimeout = 20000L    // 半开后 20 秒内无异常则关闭
)
public String callWithBreaker(String param) {
    return remoteApi.call(param);
}

@Recover
public String breakerFallback(RemoteCallException e, String param) {
    return "circuit-open-fallback";
}
```

> 生产环境更推荐使用 Resilience4j（功能更完整）。详见 → [高可用：熔断降级](/high-avail/2_circuit_breaker)

---

## 六、适用场景

- ✅ 远程 HTTP 接口调用（网络抖动）
- ✅ 数据库乐观锁冲突重试
- ✅ 消息队列消费失败重试
- ✅ 外部服务偶发超时
- ❌ 业务逻辑错误（参数校验失败等），重试无意义
- ❌ 非幂等操作，重试前必须确认接口幂等性

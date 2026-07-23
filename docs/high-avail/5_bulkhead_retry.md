# 隔离与重试

## 一、舱壁隔离（Bulkhead）

舱壁模式借鉴船舱隔舱设计：将不同服务的调用资源（线程 / 信号量）隔离，防止一个依赖的故障耗尽整体资源，影响其他服务。

### 线程池隔离

为每个依赖服务分配独立线程池，依赖超时或报错只影响该线程池，不影响其他依赖：

```
主线程池                下游A线程池        下游B线程池
[■■■■■■■■]            [■■■■□□]           [■■□□□□]
                         ↑                   ↑
                     调用服务A           调用服务B
                  （即使A挂了，B线程池仍正常）
```

```java
// Resilience4j 线程池隔离
ThreadPoolBulkheadConfig config = ThreadPoolBulkheadConfig.custom()
    .maxThreadPoolSize(10)         // 线程池最大线程数
    .coreThreadPoolSize(5)         // 核心线程数
    .queueCapacity(20)             // 等待队列容量
    .keepAliveDuration(Duration.ofMillis(20))
    .build();

ThreadPoolBulkheadRegistry registry = ThreadPoolBulkheadRegistry.of(config);
ThreadPoolBulkhead bulkhead = registry.bulkhead("serviceA");

// 使用
CompletableFuture<String> future = bulkhead.executeSupplier(() -> callServiceA());
```

**优点**：完全隔离，一个依赖挂死不影响其他；支持异步调用。
**缺点**：线程切换开销，线程数配置复杂。

---

### 信号量隔离

用计数信号量限制并发请求数，超过限制直接拒绝（不创建新线程）：

```java
// Resilience4j 信号量隔离
BulkheadConfig config = BulkheadConfig.custom()
    .maxConcurrentCalls(20)                    // 最大并发调用数
    .maxWaitDuration(Duration.ofMillis(100))   // 等待信号量的最大时间
    .build();

BulkheadRegistry registry = BulkheadRegistry.of(config);
Bulkhead bulkhead = registry.bulkhead("serviceA");

// Spring Boot 注解方式
@Bulkhead(name = "serviceA", fallbackMethod = "fallback")
public String callServiceA(String param) {
    return restTemplate.getForObject(serviceAUrl, String.class);
}

public String fallback(String param, BulkheadFullException e) {
    return "服务繁忙";
}
```

**优点**：无线程切换开销，低延迟。
**缺点**：调用线程被占用（同步阻塞），无法像线程池隔离那样完全隔离。

---

### 线程池隔离 vs 信号量隔离

| 对比 | 线程池隔离 | 信号量隔离 |
|------|-----------|-----------|
| 隔离程度 | 强（独立线程池）| 中（共享调用线程）|
| 开销 | 线程切换开销 | 几乎无额外开销 |
| 超时处理 | 支持独立超时（Future.get）| 依赖下游超时（调用线程阻塞）|
| 适用场景 | 外部 HTTP 调用、慢依赖 | 内部服务、响应快的依赖 |

---

## 二、重试与指数退避

### 重试适用场景

| 场景 | 是否适合重试 |
|------|------------|
| 网络抖动（短暂超时）| ✅ 适合 |
| 服务临时不可用 | ✅ 适合（配合退避）|
| 业务逻辑错误（参数校验失败）| ❌ 不适合（重试无意义）|
| 非幂等操作（未做幂等保证）| ❌ 危险（可能重复写入）|

**原则**：重试只用于**幂等操作**（GET / 查询 / 已做幂等保证的写操作）。

---

### 指数退避（Exponential Backoff）

每次重试的等待时间按指数增长，避免重试风暴：

```
第 1 次重试：等待 1s
第 2 次重试：等待 2s
第 3 次重试：等待 4s
第 4 次重试：等待 8s（加 Jitter 随机抖动，避免多实例同时重试）
```

```java
// Resilience4j Retry 配置
RetryConfig config = RetryConfig.custom()
    .maxAttempts(4)                                  // 最多重试 4 次（含首次）
    .waitDuration(Duration.ofSeconds(1))             // 基础等待时间
    .intervalFunction(IntervalFunction.ofExponentialBackoff(
        Duration.ofSeconds(1),    // 初始等待时间
        2.0,                      // 指数基数
        Duration.ofSeconds(30)    // 最大等待时间上限
    ))
    .retryOnException(e -> e instanceof IOException || e instanceof TimeoutException)
    .ignoreExceptions(BusinessException.class)       // 业务异常不重试
    .build();

RetryRegistry registry = RetryRegistry.of(config);
Retry retry = registry.retry("callServiceA");

// 使用
String result = retry.executeSupplier(() -> callServiceA());
```

---

### Spring Retry

```xml
<dependency>
    <groupId>org.springframework.retry</groupId>
    <artifactId>spring-retry</artifactId>
</dependency>
```

```java
@Service
@EnableRetry
public class OrderService {

    @Retryable(
        retryFor = {IOException.class, TimeoutException.class},
        noRetryFor = BusinessException.class,
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2, maxDelay = 10000)
    )
    public Order queryOrder(Long id) {
        return remoteOrderService.query(id);
    }

    @Recover
    public Order recoverQueryOrder(IOException e, Long id) {
        log.error("重试耗尽，id={}", id, e);
        return Order.empty();    // 最终兜底
    }
}
```

---

## 三、超时设计

超时设计是高可用的基础，每一层都需要设置合理的超时时间：

```
用户 → [Nginx: 30s] → [API Gateway: 10s] → [Service A: 5s] → [DB: 2s]
```

**分层超时原则**：越靠近用户，超时时间越长；越靠近基础设施，超时时间越短。

```yaml
# Spring Boot OpenFeign 超时配置
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connect-timeout: 1000      # 连接超时 1s
            read-timeout: 5000         # 读取超时 5s
          order-service:               # 特定服务单独配置
            connect-timeout: 1000
            read-timeout: 3000
```

**超时设置参考值**：
- 数据库查询：100ms ~ 500ms
- 缓存（Redis）操作：10ms ~ 50ms
- 内部 RPC 调用：100ms ~ 1000ms
- 外部 HTTP 调用：1s ~ 5s

---

## 四、负载卸除（Load Shedding）

当系统接近容量极限时，主动拒绝低优先级请求，保障高优先级请求的响应质量：

```java
// 简单示例：基于队列深度的负载卸除
@Component
public class LoadSheddingFilter implements Filter {

    private final ThreadPoolExecutor executor;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        int queueSize = executor.getQueue().size();
        if (queueSize > 1000) {
            // 队列积压超过 1000 时，拒绝低优先级请求
            HttpServletResponse response = (HttpServletResponse) res;
            response.setStatus(503);
            response.getWriter().write("{\"message\":\"服务繁忙，请稍后重试\"}");
            return;
        }
        chain.doFilter(req, res);
    }
}
```

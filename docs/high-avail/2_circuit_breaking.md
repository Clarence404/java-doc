# 熔断

## 一、为什么需要熔断

当下游服务出现故障（超时、报错），如果上游继续不断发起调用，会导致：
- 资源耗尽（线程池 / 连接池堆积等待）
- **雪崩效应**：一个慢服务把整条调用链拖垮

熔断器（Circuit Breaker）在检测到故障后**快速失败**，不再等待超时，保护整个系统。

---

## 二、熔断器三态机

![熔断器三态机状态转换](../assets/high-avail/circuit-breaker-states.svg)

| 状态 | 行为 | 触发条件 |
|------|------|---------|
| **Closed（关闭）** | 正常放行所有请求 | 初始状态；或 Half-Open 探测成功 |
| **Open（打开）** | 直接拒绝，不调用下游 | 失败率 / 慢调用率超过阈值 |
| **Half-Open（半开）** | 放行少量探测请求 | Open 状态经过等待时间后自动进入 |

---

## 三、Sentinel 熔断规则

Sentinel 支持三种熔断策略：

| 策略 | 说明 |
|------|------|
| 慢调用比例（SLOW_REQUEST_RATIO）| 慢调用（超过最大 RT）占比超阈值则熔断 |
| 异常比例（ERROR_RATIO）| 异常请求占比超阈值则熔断 |
| 异常数（ERROR_COUNT）| 时间窗口内异常数超阈值则熔断 |

```java
// 慢调用比例熔断：响应时间 > 500ms 视为慢调用，慢调用比例 > 60% 则熔断 10s
DegradeRule rule = new DegradeRule("callDownstream")
    .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType())
    .setCount(500)                // 最大允许响应时间（ms）
    .setSlowRatioThreshold(0.6)   // 慢调用比例阈值 60%
    .setMinRequestAmount(10)      // 最小请求数（低于此数不统计）
    .setStatIntervalMs(10_000)    // 统计窗口 10s
    .setTimeWindow(10);           // 熔断持续时间 10s
DegradeRuleManager.loadRules(Collections.singletonList(rule));
```

```java
// 异常比例熔断：异常比例 > 50% 则熔断 5s
DegradeRule rule = new DegradeRule("callDownstream")
    .setGrade(CircuitBreakerStrategy.ERROR_RATIO.getType())
    .setCount(0.5)
    .setMinRequestAmount(5)
    .setStatIntervalMs(5_000)
    .setTimeWindow(5);
```

### 熔断事件监听

```java
EventObserverRegistry.getInstance().addStateChangeObserver("logObserver",
    (prevState, newState, rule, snapshotValue) -> {
        log.warn("熔断状态变化: {} -> {}, 资源: {}, 快照值: {}",
            prevState, newState, rule.getResource(), snapshotValue);
    });
```

---

## 四、Resilience4j 熔断配置

Resilience4j 是 Hystrix 的替代品，更轻量，无线程池隔离开销，基于函数式编程风格。

```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      callDownstream:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 10                              # 最近 10 次请求
        failure-rate-threshold: 50                           # 失败率阈值 50%
        slow-call-rate-threshold: 60                         # 慢调用比例阈值 60%
        slow-call-duration-threshold: 2s                     # 超过 2s 视为慢调用
        wait-duration-in-open-state: 10s                     # Open 等待 10s 后进入 Half-Open
        permitted-number-of-calls-in-half-open-state: 3      # Half-Open 时放行 3 个探测请求
        minimum-number-of-calls: 5
```

```java
@CircuitBreaker(name = "callDownstream", fallbackMethod = "fallback")
public String callDownstream(String param) {
    return restTemplate.getForObject(downstreamUrl, String.class);
}

public String fallback(String param, Throwable t) {
    log.warn("熔断降级，参数: {}, 原因: {}", param, t.getMessage());
    return "默认响应";
}
```

---

## 五、OpenFeign + Sentinel 集成实战

OpenFeign 声明式 HTTP 客户端结合 Sentinel 实现服务间调用的熔断与降级：

```xml
<!-- pom.xml -->
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-sentinel</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
```

```yaml
# application.yml — 开启 Feign 对 Sentinel 的支持
feign:
  sentinel:
    enabled: true
```

```java
// 定义 Feign 客户端接口
@FeignClient(
    name = "order-service",
    fallbackFactory = OrderFeignClientFallbackFactory.class
)
public interface OrderFeignClient {

    @GetMapping("/api/orders/{id}")
    Result<Order> getOrder(@PathVariable Long id);

    @PostMapping("/api/orders")
    Result<String> createOrder(@RequestBody CreateOrderRequest req);
}
```

```java
// fallbackFactory：可获取异常信息，比 fallback 更灵活
@Component
public class OrderFeignClientFallbackFactory
        implements FallbackFactory<OrderFeignClient> {

    @Override
    public OrderFeignClient create(Throwable cause) {
        return new OrderFeignClient() {
            @Override
            public Result<Order> getOrder(Long id) {
                log.warn("[OrderFeign 熔断] getOrder id={}, cause={}", id, cause.getMessage());
                return Result.fail(503, "订单服务不可用，请稍后重试");
            }

            @Override
            public Result<String> createOrder(CreateOrderRequest req) {
                // 创建操作熔断时不能静默返回成功，应抛出让上层感知
                throw new ServiceUnavailableException("订单服务熔断中，请稍后重试");
            }
        };
    }
}
```

**注意事项**：
- 非幂等接口（创建/更新）熔断降级时，**不应静默返回假成功**，应抛异常让调用方感知
- `fallback` 只能返回固定降级值，无法获取异常原因；`fallbackFactory` 可拿到 `Throwable`，推荐用 factory
- Sentinel Dashboard 中可以看到 `order-service#getOrder(Long)` 等 Feign 资源，可在控制台动态调整规则

---

## 六、Sentinel vs Resilience4j

| 对比维度 | Sentinel | Resilience4j |
|---------|---------|-------------|
| 来源 | 阿里巴巴开源 | Netflix Hystrix 继任者 |
| 控制台 | 提供可视化 Dashboard | 无官方 Dashboard（可集成 Actuator）|
| 隔离方式 | 信号量隔离 | 信号量隔离（无线程池隔离）|
| 规则配置 | 控制台 / 代码 / Nacos 动态推送 | 配置文件 / 代码 |
| 功能丰富度 | 限流 + 熔断 + 降级 + 热点 + 系统保护 | 熔断 + 限流 + 重试 + 超时 |
| 适用场景 | 国内微服务（Spring Cloud Alibaba）| Spring Boot / Spring Cloud 通用 |

---

## 六、常见面试问题

**Q：熔断器从 Open 如何恢复到 Closed？**
Open 状态经过配置的等待时间后自动进入 **Half-Open**，放行少量探测请求。若探测成功率达阈值，则恢复为 Closed；若仍高失败，则退回 Open 重新计时。

**Q：blockHandler 和 fallback 有什么区别？**
`blockHandler` 处理 Sentinel **流控/熔断规则触发**（`BlockException`）；`fallback` 处理**业务代码抛出的异常**（含 `BlockException`）。若两者都配置，`BlockException` 优先走 `blockHandler`。

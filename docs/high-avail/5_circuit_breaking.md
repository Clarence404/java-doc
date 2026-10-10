---
description: 熔断器三态、统计窗口与阈值、Sentinel 与 Resilience4j 对比
---

# 熔断

> 前置阅读：[超时、重试与隔离](./4_timeout_retry_bulkhead)

**熔断器（Circuit Breaker）在检测到下游持续失败后直接快速失败，不再发起调用，给下游恢复的时间，也保住了自己的线程和连接。** 本篇讲熔断器三态机与熔断策略、阈值设定，以及 Sentinel 与 Resilience4j 的选型。

---

## 一、为什么需要熔断

**没有熔断时，一个慢依赖会沿调用链把上游逐级拖垮，这就是雪崩。**

超时和隔离能限制"一次调用"的损失，但下游持续故障时，每个请求仍要等满超时才失败，资源一直被占着。

| 手段 | 作用对象 | 解决的问题 |
|------|---------|-----------|
| 超时 | 单次调用 | 不无限等待 |
| 隔离 | 某个依赖的资源配额 | 一个依赖慢，不耗尽全部线程 |
| 熔断 | 某个依赖的整体健康度 | 依赖持续故障时停止调用，快速失败 |
| 降级 | 失败后的返回内容 | 熔断或失败后返回什么，见 [降级](./6_degradation) |

- 下游 RT 从 50ms 涨到 3s，上游每个请求多占用线程 3s，线程池很快被占满
- 上游开始超时，它的上游也开始堆积，故障沿调用链向入口扩散
- 下游本已过载，上游的持续调用和重试让它更难恢复

熔断的收益是双向的：**对上游，快速失败释放资源；对下游，停止施压让它有机会恢复。**

---

## 二、熔断器三态机

**熔断器在 Closed、Open、Half-Open 三个状态间切换，Half-Open 用少量探测请求判断下游是否恢复。**

![熔断器三态机状态转换](../assets/high-avail/circuit-breaker-states.svg)

| 状态 | 行为 | 进入条件 |
|------|------|---------|
| **Closed（关闭）** | 正常放行，持续统计失败率 / 慢调用率 | 初始状态；或 Half-Open 探测成功 |
| **Open（打开）** | 直接拒绝，不调用下游，走降级逻辑 | 统计窗口内指标超过阈值 |
| **Half-Open（半开）** | 放行少量探测请求 | Open 持续一段时间（熔断时长）后自动进入 |

Half-Open 的探测结果决定下一步：探测成功则回到 Closed；探测仍失败则回到 Open 并重新计时。Sentinel 在半开状态只放行 1 个探测请求；Resilience4j 放行 `permittedNumberOfCallsInHalfOpenState` 个，按它们的失败率判断。

---

## 三、熔断策略与阈值

**熔断的判断依据有三类：慢调用比例、异常比例、异常数。** 慢调用比例最常用，因为"变慢"往往比"报错"更早出现，也更伤资源。

| 策略 | 判断方式 | 适用场景 |
|------|---------|---------|
| 慢调用比例 | RT 超过阈值的请求占比超标 | 下游变慢是主要风险（DB、第三方接口） |
| 异常比例 | 异常请求占比超标 | 调用量较大、错误率能稳定统计 |
| 异常数 | 窗口内异常数超标 | 调用量小、比例波动大 |

### 1、关键参数怎么定

| 参数 | 含义 | 建议 |
|------|------|------|
| 慢调用 RT 阈值 | 超过即算慢调用 | 取下游正常 P99 的 1.5 ~ 2 倍，且小于调用方超时 |
| 比例阈值 | 慢调用 / 异常占比 | 常用 50% ~ 60%，太低容易误熔断 |
| 最小请求数 | 窗口内请求数低于它不做判断 | 按低峰期流量设定，避免"2 个请求失败 1 个就熔断" |
| 统计窗口 | 计算比例的时间或次数窗口 | 5 ~ 10s（时间窗口）或最近 50 ~ 100 次（计数窗口） |
| 熔断时长 | Open 状态持续多久后进入半开 | 5 ~ 30s，与下游典型恢复时间匹配 |

### 2、哪些失败该计入

- **计入**：超时、连接失败、5xx、下游返回的"系统繁忙"类错误
- **不计入**：参数校验失败、业务规则拒绝（如余额不足）等 4xx 类业务异常，它们与下游健康度无关
- 被熔断拒绝本身（`CallNotPermittedException`、`DegradeException`）不能再被重试，否则熔断形同虚设

### 3、熔断粒度

| 粒度 | 优点 | 缺点 |
|------|------|------|
| 按依赖服务 | 规则少，易管理 | 一个慢接口会连累同服务的其他接口 |
| 按接口（推荐） | 故障影响面精确 | 规则多，需要模板化管理 |
| 按下游实例 | 可摘掉单个坏实例 | 通常由负载均衡的故障摘除承担，见 [负载均衡](./3_load_balancing) |

---

## 四、选型：Sentinel、Resilience4j 与 Hystrix

**新项目在 Sentinel 和 Resilience4j 之间选：用 Spring Cloud Alibaba 体系、需要控制台动态调规则选 Sentinel；追求轻量、与 Spring Cloud CircuitBreaker 标准集成选 Resilience4j。Hystrix 已停止开发，不再用于新项目。**

| 维度 | Sentinel | Resilience4j | Hystrix |
|------|---------|-------------|---------|
| 出品 | 阿里巴巴开源 | 独立社区项目，受 Hystrix 启发 | Netflix，2018 年起进入维护模式 |
| 熔断策略 | 慢调用比例、异常比例、异常数 | 失败率、慢调用率 | 失败率 |
| 统计窗口 | 滑动时间窗口 | 计数窗口或时间窗口 | 滑动时间窗口 |
| 隔离 | 并发线程数限制（信号量式） | 信号量 `Bulkhead` 与 `ThreadPoolBulkhead` | 线程池、信号量 |
| 其他能力 | 限流、热点参数、系统自适应保护 | 限流、重试、超时（`TimeLimiter`）、缓存 | 请求合并、缓存 |
| 规则配置 | 控制台、代码、配置中心动态推送 | 配置文件、代码 | 配置文件、Archaius |
| 控制台 | 官方 Dashboard | 无，依赖 Actuator + Micrometer 监控 | Hystrix Dashboard |
| Spring 集成 | Spring Cloud Alibaba | Spring Cloud CircuitBreaker、Spring Boot Starter | 已从 Spring Cloud 2020 移除 |

---

## 五、最小示例

**下面只给出最小可用配置，完整的 Sentinel 规则代码、事件监听与规则持久化见 [Spring Cloud Alibaba - Sentinel](/spring-cloud/6_alibaba)。**

### 1、Sentinel：慢调用比例熔断

```java
// 统计 10s 内请求：RT > 500ms 视为慢调用，慢调用比例 > 60% 且请求数 ≥ 10 时熔断 10s
DegradeRule rule = new DegradeRule("queryInventory")
        .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType())
        .setCount(500)                 // 慢调用 RT 阈值（ms）
        .setSlowRatioThreshold(0.6)    // 慢调用比例阈值
        .setMinRequestAmount(10)       // 最小请求数
        .setStatIntervalMs(10_000)     // 统计窗口（ms）
        .setTimeWindow(10);            // 熔断时长（s）
DegradeRuleManager.loadRules(Collections.singletonList(rule));
```

### 2、Resilience4j：失败率 + 慢调用率熔断

```yaml
resilience4j:
  circuitbreaker:
    instances:
      inventory:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 50                          # 统计最近 50 次调用
        minimum-number-of-calls: 20                      # 至少 20 次才开始计算
        failure-rate-threshold: 50                       # 失败率阈值 50%
        slow-call-duration-threshold: 800ms              # 超过 800ms 视为慢调用
        slow-call-rate-threshold: 60                     # 慢调用率阈值 60%
        wait-duration-in-open-state: 10s                 # 熔断时长
        permitted-number-of-calls-in-half-open-state: 5  # 半开探测请求数
        ignore-exceptions:
          - com.example.common.BusinessException         # 业务异常不计入失败
```

```java
@Slf4j
@Service
public class InventoryClient {

    @CircuitBreaker(name = "inventory", fallbackMethod = "queryFallback")
    public Stock query(Long skuId) {
        return restClient.get().uri("/api/stock/{id}", skuId).retrieve().body(Stock.class);
    }

    // 参数与原方法一致，最后加异常参数；熔断打开时收到 CallNotPermittedException
    private Stock queryFallback(Long skuId, Throwable t) {
        log.warn("库存查询降级 skuId={}, cause={}", skuId, t.toString());
        return Stock.unknown(skuId);
    }
}
```

::: warning Resilience4j 默认值偏宽松
`minimumNumberOfCalls` 与 `slidingWindowSize` 默认均为 100，`waitDurationInOpenState` 默认 60s，`slowCallDurationThreshold` 默认 60s。直接用默认值时，小流量接口几乎不会触发熔断，慢调用也基本不计入，**建议每个实例显式设置**。
:::

### 3、与重试的执行顺序

Resilience4j 注解叠加时，默认执行顺序由外到内为 `Retry → CircuitBreaker → RateLimiter → TimeLimiter → Bulkhead → 业务方法`。重试在最外层意味着每次重试都会经过熔断器统计；熔断打开后抛出的 `CallNotPermittedException` 必须配置为不重试，重试策略见 [超时、重试与隔离](./4_timeout_retry_bulkhead)。

---

## 六、OpenFeign 接入 Sentinel

**开启 `feign.sentinel.enabled=true` 后，每个 Feign 方法自动成为一个 Sentinel 资源，失败或熔断时走 `fallbackFactory`。**

- **资源名格式**：`HTTP方法:协议://服务名/路径`，如 `GET:http://order-service/api/orders/{id}`，在控制台按这个名字配熔断规则
- **优先用 `fallbackFactory`**：它能拿到异常原因，便于区分"熔断拒绝"和"下游报错"
- **非幂等接口不要静默返回成功**：创建、扣款等写操作降级时应抛出异常，让调用方明确感知失败

依赖、配置与 `FallbackFactory` 完整代码见 [Spring Cloud Alibaba - Sentinel](/spring-cloud/6_alibaba)。

---

## 七、实践要点

- **每个外部依赖都要有熔断**，尤其是第三方接口和跨团队服务；熔断与超时、隔离一起配置，缺一不可
- **熔断状态变化必须告警**：熔断打开意味着有依赖在故障，监听状态变化事件并上报指标
- **降级逻辑要可用**：熔断后走的 fallback 不能再依赖同一个故障下游，也不能有高延迟
- **用演练验证**：通过故障注入让下游变慢，确认熔断能按预期触发和恢复，见 [混沌工程](./10_chaos_engineering)

---

## 小结

- 熔断解决"下游持续故障"：快速失败释放上游资源，同时给下游恢复时间
- 三态机：Closed 统计 → 超阈值 Open 拒绝 → 熔断时长后 Half-Open 探测 → 成功 Closed / 失败 Open
- 慢调用比例最常用；阈值设置要看最小请求数、统计窗口和熔断时长，业务异常不计入失败
- 选型先比较 Sentinel 与 Resilience4j：Resilience4j 是受 Hystrix 启发的独立项目，同时提供信号量与线程池两种隔离
- Feign + Sentinel 的资源名形如 `GET:http://order-service/api/orders/{id}`，框架代码集中在 Spring Cloud Alibaba 篇

> 下一篇：[降级](./6_degradation) —— 熔断之后返回什么，以及如何主动放弃非核心功能保住主链路。

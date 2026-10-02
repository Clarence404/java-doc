---
description: 降级分级、兜底策略、开关与规则管理
---

# 降级

> **本篇目标**：理解降级与熔断的关系，掌握降级分级、静态与动态降级的实现方式，并能设计有业务价值、可观测、可演练的降级预案。
>
> **前置阅读**：[熔断](./5_circuit_breaking)

熔断回答"什么时候停止调用下游"，降级回答"停止之后返回什么、放弃什么"。**降级是在资源不足或依赖故障时，主动放弃部分非核心功能或降低服务质量，换取核心链路的可用性。**

| 对比 | 熔断 | 降级 |
|------|------|------|
| 性质 | 被动触发的保护机制 | 预先定义的应对策略 |
| 触发 | 下游失败率 / 慢调用率超阈值 | 熔断、限流、超时、异常，或人工打开开关 |
| 关注点 | 是否调用下游 | 返回什么、放弃什么 |
| 关系 | 熔断打开后通常执行降级逻辑 | 降级不一定由熔断触发 |

---

## 一、降级的触发方式

**降级有自动和手动两种触发方式，核心链路两种都要准备。**

| 方式 | 触发条件 | 例子 |
|------|---------|------|
| 自动降级 | 熔断打开、限流命中、调用超时或异常 | Sentinel `fallback`、Resilience4j `fallbackMethod` |
| 手动降级 | 值班人员根据预案打开降级开关 | 大促前关闭商品评论、故障时关闭个性化推荐 |

系统整体过载时按 CPU、load、RT 自动拒绝入口流量，本质是限流而不是降级，见 [限流与过载保护](./7_rate_limiting)。

---

## 二、降级分级

**按业务重要性给功能分级，故障时从最不重要的开始放弃。**

### 1、功能分级

| 级别 | 定义 | 示例 | 降级策略 |
|------|------|------|---------|
| 核心 | 失败即直接损失交易 | 下单、支付、登录 | 不降级，只能扩容、限流保护 |
| 重要 | 影响体验但不阻断交易 | 库存展示、优惠计算 | 可返回缓存或近似值 |
| 一般 | 可以暂时不提供 | 推荐、评论、足迹 | 返回兜底数据或直接隐藏 |
| 边缘 | 对用户无感知 | 埋点、日志上报、报表 | 直接关闭或改为异步 |

### 2、降级手段

| 手段 | 做法 | 示例 |
|------|------|------|
| 返回兜底数据 | 返回缓存、默认值或通用数据，用户基本无感知 | 个性化推荐改为热销榜 |
| 关闭功能 | 隐藏非核心入口，保留主流程 | 大促期间关闭商品评价 |
| 读降级 | 读不到实时数据时读缓存或静态快照 | 商品详情读本地缓存 |
| 写降级 | 同步写改为异步写，稍后补偿 | 积分发放改为 MQ 异步 |
| 精度降级 | 降低计算精度或数据新鲜度 | 实时销量改为分钟级更新 |
| 页面降级 | 返回 CDN 托管的静态页面 | 活动页切换为静态快照 |
| 提示降级 | 返回明确的友好提示 | "系统繁忙，请稍后重试" |

---

## 三、静态降级与动态降级

**静态降级写死在代码里，由异常自动触发；动态降级由配置中心开关控制，无需重启即可生效。** 两者配合使用：静态降级兜住意外故障，动态开关用于预案和人工干预。

### 1、静态降级：fallback 兜底

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class RecommendService {

    private final RecommendClient recommendClient;
    private final HotProductCache hotProductCache;
    private final MeterRegistry meterRegistry;

    @SentinelResource(value = "getRecommendations", fallback = "recommendFallback")
    public List<Product> getRecommendations(Long userId) {
        return recommendClient.personalized(userId);
    }

    // 兜底：返回本地缓存的热销榜，并上报降级指标
    public List<Product> recommendFallback(Long userId, Throwable t) {
        log.warn("推荐服务降级 userId={}, cause={}", userId, t.toString());
        meterRegistry.counter("degrade.fallback", "resource", "getRecommendations").increment();
        return hotProductCache.top(20);
    }
}
```

### 2、动态降级：配置中心开关

```java
@Data
@Component
@ConfigurationProperties(prefix = "degrade")
public class DegradeSwitches {
    // Nacos 修改后自动刷新，@ConfigurationProperties 无需 @RefreshScope
    private boolean recommendEnabled = true;
    private boolean commentEnabled = true;
}

@Service
@RequiredArgsConstructor
public class ProductPageService {

    private final DegradeSwitches switches;
    private final RecommendService recommendService;
    private final HotProductCache hotProductCache;

    public List<Product> recommendations(Long userId) {
        if (!switches.isRecommendEnabled()) {
            // 开关关闭：不再调用推荐服务，直接返回热销榜
            return hotProductCache.top(20);
        }
        return recommendService.getRecommendations(userId);
    }
}
```

```yaml
# Nacos 中的降级开关配置，修改后实时推送到应用
degrade:
  recommend-enabled: false   # 关闭个性化推荐
  comment-enabled: true
```

### 3、Sentinel 熔断规则的动态管理

熔断降级规则同样应放在配置中心动态下发。需要注意数据流向：**`sentinel-datasource-nacos` 只负责从 Nacos 拉取并监听规则**，Sentinel 控制台默认把规则直接推到应用内存，不会写回 Nacos，应用重启后控制台上改的规则就丢了。要让"控制台修改 → 持久化到 Nacos"，需要改造 Dashboard 的规则发布逻辑，或者约定只在 Nacos 中修改规则。数据源配置与规则 JSON 见 [Spring Cloud Alibaba - Sentinel](/spring-cloud/6_alibaba)。

---

## 四、降级设计要点

**降级逻辑平时不执行，最容易在真正需要时失效。** 设计时逐条对照：

- **兜底数据要有业务价值**：避免返回 `null` 或空列表导致前端报错，优先热销榜、缓存快照、默认配置
- **降级逻辑不依赖故障源**：推荐服务故障时，兜底不能再调推荐服务，也不要调用另一个同样可能过载的远程服务
- **降级要可观测**：每次降级打日志、上报指标（按资源维度），降级量突增要告警
- **开关要有预案**：每个手动开关写清楚打开条件、影响范围、负责人和恢复条件，纳入故障预案，见 [故障应急与复盘](./11_incident_response)
- **避免级联降级**：A 的兜底依赖 B 的数据，B 也在降级，最终返回无意义数据，梳理依赖时要识别出这种链路
- **非幂等写操作不静默降级**：创建订单、扣款等写操作失败时不能返回假成功，应明确报错
- **定期演练**：在压测或演练环境中真实打开开关、注入故障，验证降级路径可用，见 [混沌工程](./10_chaos_engineering)

---

## 小结

- 熔断决定"是否调用"，降级决定"返回什么、放弃什么"，二者通常配合使用
- 按核心、重要、一般、边缘给功能分级，故障时从边缘功能开始放弃，核心链路靠扩容和限流保护
- 静态降级用 fallback 兜住意外故障，动态降级用配置中心开关支持预案和人工干预
- `sentinel-datasource-nacos` 只从 Nacos 拉规则，控制台改规则要持久化需改造 Dashboard
- 降级逻辑要有业务价值、不依赖故障源、可观测、定期演练

> 下一篇：[限流与过载保护](./7_rate_limiting) —— 从上游入口控制流量，在容量不足时有选择地拒绝请求。

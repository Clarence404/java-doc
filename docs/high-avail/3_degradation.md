# 降级

## 一、什么是降级

降级是指在系统资源不足或依赖故障时，**主动放弃部分非核心功能**，以保证核心功能的可用性。

降级 vs 熔断：
- **熔断**：被动触发，下游故障率超阈值后自动断路
- **降级**：主动策略，预先定义在故障/压力时应返回什么

两者通常配合使用：熔断触发后，走降级逻辑返回兜底数据。

---

## 二、降级分层

### 系统级降级（自动）

Sentinel 提供系统保护规则，当系统整体指标（CPU、RT、QPS）超过阈值时，自动限流保护：

```java
SystemRule rule = new SystemRule();
rule.setHighestSystemLoad(3.0);   // 系统 load 超过 3 时触发
rule.setAvgRt(200);               // 平均响应时间超过 200ms 时触发
rule.setQps(1000);                // 入口 QPS 超过 1000 时触发
rule.setMaxThread(200);           // 并发线程数超过 200 时触发
SystemRuleManager.loadRules(Collections.singletonList(rule));
```

### 业务级降级（手动）

在代码层面预定义降级逻辑，根据业务重要性分级：

| 降级级别 | 说明 | 示例 |
|---------|------|------|
| 返回默认值 | 返回缓存 / 兜底数据，用户无感知 | 商品推荐返回热销榜 |
| 功能降级 | 关闭非核心功能，保留核心流程 | 关闭个性化推荐，使用通用推荐 |
| 提示降级 | 返回友好提示，引导用户稍后重试 | "系统繁忙，请稍后重试" |
| 静态页面 | CDN 托管的静态兜底页面 | 首页 / 活动页静态快照 |

---

## 三、静态降级 vs 动态降级

### 静态降级

降级逻辑写死在代码中，简单可靠，修改需重新部署：

```java
@SentinelResource(
    value = "getRecommendations",
    fallback = "getRecommendationsFallback"
)
public List<Product> getRecommendations(Long userId) {
    return recommendService.getPersonalized(userId);
}

// 静态降级：返回热销商品兜底
public List<Product> getRecommendationsFallback(Long userId, Throwable t) {
    log.warn("[推荐服务降级] userId={}, reason={}", userId, t.getMessage());
    return List.of(
        new Product(1001L, "热销商品A"),
        new Product(1002L, "热销商品B")
    );
}
```

### 动态降级

通过配置中心（如 Nacos）实时下发降级开关，无需重启服务：

```java
@Component
@RefreshScope
public class FeatureConfig {
    @Value("${feature.recommendation.enabled:true}")
    private boolean recommendationEnabled;
}

@Service
@RequiredArgsConstructor
public class RecommendService {

    private final FeatureConfig featureConfig;

    public List<Product> getRecommendations(Long userId) {
        if (!featureConfig.isRecommendationEnabled()) {
            // 动态降级：配置中心改为 false 后立即生效，无需重启
            return getHotProductsFromCache();
        }
        return getPersonalized(userId);
    }
}
```

Nacos 配置：
```yaml
# 在 Nacos 配置中心修改，实时推送
feature:
  recommendation:
    enabled: false    # 改为 false 触发降级
```

---

## 四、Sentinel 降级规则动态推送（Nacos）

将 Sentinel 规则持久化到 Nacos，实现控制台 / 配置中心双向同步：

```xml
<dependency>
    <groupId>com.alibaba.csp</groupId>
    <artifactId>sentinel-datasource-nacos</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    sentinel:
      datasource:
        degrade-rules:
          nacos:
            server-addr: ${nacos.server-addr}
            namespace: ${nacos.namespace}
            data-id: ${spring.application.name}-degrade-rules
            group-id: SENTINEL_GROUP
            data-type: json
            rule-type: degrade
```

Nacos 中的规则 JSON：
```json
[
  {
    "resource": "callDownstream",
    "grade": 0,
    "count": 500,
    "slowRatioThreshold": 0.6,
    "minRequestAmount": 10,
    "statIntervalMs": 10000,
    "timeWindow": 10
  }
]
```

---

## 五、降级最佳实践

1. **识别核心/非核心功能**：优先降级推荐、广告等非核心功能，保障下单、支付主链路
2. **兜底数据有意义**：避免返回 null 或空列表，应有业务价值（如热销榜、缓存快照）
3. **降级有监控**：触发时打告警日志，上报指标，便于排查
4. **预演降级链路**：上线前在压测/演练环境验证降级是否正常工作
5. **避免级联降级**：A 降级依赖 B 的数据，B 也在降级，导致返回无意义数据

```java
// 降级时上报监控
public List<Product> getRecommendationsFallback(Long userId, Throwable t) {
    log.warn("[推荐降级] userId={}, cause={}", userId, t.getMessage());
    meterRegistry.counter("recommendation.fallback").increment();
    return getHotProductsFromCache();
}
```

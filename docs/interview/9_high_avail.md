# 开发总结-高可用

> 精华提炼，细节详见 [high-avail/](../high-avail/0_overview)

## 一、限流算法有哪些？令牌桶和漏桶的区别？

**四种常见算法**：

| 算法 | 原理 | 能否处理突发 | 典型实现 |
|------|------|------------|---------|
| 固定窗口 | 统计固定时间窗口内请求数 | ❌ 窗口边界有突刺 | Redis INCR + EXPIRE |
| 滑动窗口 | 多个小窗口，精细化统计 | ✅ 较平滑 | Redis ZSet + Lua |
| 漏桶 | 固定速率流出，超出丢弃 | ❌ 不允许突发 | — |
| **令牌桶** | 固定速率生成令牌，有令牌才放行 | ✅ 允许一定突发 | Guava `RateLimiter` |

**令牌桶 vs 漏桶核心区别**：漏桶强制匀速输出，适合流量整形；令牌桶允许积累令牌消费突发流量，更适合限流场景。

**Redis + Lua 滑动窗口实现**：

```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])  -- 窗口大小(ms)
local limit = tonumber(ARGV[3])   -- 限制次数

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)  -- 移除窗口外记录
local count = redis.call('ZCARD', key)
if count < limit then
    redis.call('ZADD', key, now, now)
    redis.call('PEXPIRE', key, window)
    return 1  -- 放行
end
return 0  -- 限流
```

## 二、熔断器的三种状态是什么？如何切换？

```
Closed（正常）─── 错误率超阈值 ──→ Open（熔断，直接失败）
                                         │
                                    等待一段时间
                                         ↓
                               Half-Open（半开，放少量探测请求）
                                    ↙          ↘
                              探测成功         探测失败
                            ↙                        ↘
                        Closed                      Open
```

- **Closed → Open**：错误率 / 慢调用比例超过配置阈值
- **Open → Half-Open**：经过 `waitDurationInOpenState` 后自动进入半开
- **Half-Open → Closed**：探测请求成功率满足阈值，恢复正常
- **Half-Open → Open**：探测失败，重新打开

**Resilience4j 配置示例**：

```yaml
resilience4j:
  circuitbreaker:
    instances:
      orderService:
        failure-rate-threshold: 50          # 错误率超 50% 触发熔断
        slow-call-rate-threshold: 80        # 慢调用超 80% 触发熔断
        slow-call-duration-threshold: 2s    # 超过 2s 算慢调用
        wait-duration-in-open-state: 10s    # 熔断等待时间
        permitted-calls-in-half-open-state: 5  # 半开时允许的探测请求数
```

## 三、Sentinel 和 Hystrix 的区别？

| 对比项 | Sentinel | Hystrix |
|--------|---------|---------|
| 来源 | 阿里开源 | Netflix（已停止维护）|
| 隔离方式 | 信号量（轻量，无额外线程）| 线程池隔离 + 信号量 |
| 熔断策略 | 错误率 / 慢调用比例 / 异常数 | 错误率 |
| 规则配置 | 控制台动态推送（Nacos / ZK）| 配置文件 / 代码 |
| 流量控制 | QPS / 并发数 / 热点参数 | 并发线程数 |
| 可视化 | ✅ 实时 Dashboard | ✅ Turbine Dashboard |
| 生态 | Spring Cloud Alibaba | Spring Cloud Netflix（过时）|

**推荐**：新项目用 Sentinel（国内）或 Resilience4j（替代 Hystrix）。

## 四、服务降级有哪些策略？

降级的本质是**牺牲非核心功能，保住核心链路**。

| 级别 | 降级措施 | 示例 |
|------|---------|------|
| 轻微 | 关闭非核心功能 | 关闭推荐、广告、积分 |
| 中等 | 简化业务流程 | 秒杀时跳过风控、关闭退款 |
| 严重 | 只保留核心交易 | 只允许下单+支付，关闭其他接口 |

**代码实现（Sentinel fallback）**：

```java
@SentinelResource(
    value = "queryRecommend",
    blockHandler = "blockHandler",    // 限流/熔断触发
    fallback = "fallbackHandler"      // 业务异常触发
)
public List<Item> queryRecommend(Long userId) {
    return remoteService.getRecommend(userId);
}

public List<Item> fallbackHandler(Long userId, Throwable e) {
    return Collections.emptyList();   // 返回兜底空列表
}
```

## 五、如何实现超时控制和重试？

**超时设置原则**：每一层都要设超时，不能依赖下层兜底。

```yaml
# Feign 客户端超时配置
feign:
  client:
    config:
      default:
        connect-timeout: 1000   # 连接超时 1s
        read-timeout: 3000      # 读超时 3s
```

**重试策略**（仅适用于幂等操作）：

```java
@Retryable(
    value = {RemoteCallException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 500, multiplier = 2)  // 500ms, 1s, 2s 指数退避
)
public Result callRemoteService() {
    return remoteService.call();
}

@Recover
public Result recover(RemoteCallException e) {
    return Result.fail("服务暂不可用，请稍后重试");
}
```

::: warning 注意
非幂等操作（如扣库存、发消息）**不能**直接加重试，否则会重复执行。需要先保证接口幂等性，再考虑重试。
:::

## 六、什么是优雅停机？如何实现？

**为什么需要优雅停机**：直接 kill 进程会中断正在处理的请求，导致数据不一致或请求报错。

**优雅停机流程**：
1. 停止接受新请求（从注册中心下线，Nginx 摘除）
2. 等待当前请求处理完毕
3. 关闭资源（数据库连接、MQ 连接）
4. 进程退出

**Spring Boot 配置**：

```yaml
server:
  shutdown: graceful          # 不再接受新请求，处理完存量请求再关闭
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # 最多等 30s，超时强制关闭
```

**K8s 配合**：配置 `preStop` 钩子，让 Pod 先从 Service 摘除，再等待请求处理完毕：

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 10"]  # 等待 Nginx/网关感知下线
```

## 七、如何设计一个高可用系统？

**核心原则**：

1. **消除单点**（SPoF）：每个组件至少 2 个实例，含数据库、Redis、网关
2. **故障隔离**：线程池隔离（不同业务不同池）、机房级别隔离
3. **快速失败**：超时 + 熔断，避免故障扩散
4. **流量管控**：限流 + 降级，保住核心链路
5. **可观测**：Metrics（Prometheus）+ Tracing（SkyWalking）+ Logging（ELK）

**可用性目标参考**：

| SLA | 年故障时间 |
|-----|---------|
| 99.9%（三个九）| 8.76 小时 |
| 99.99%（四个九）| 52.56 分钟 |
| 99.999%（五个九）| 5.26 分钟 |

**多活架构**：同城双活（两机房互切，RTO < 30s）→ 两地三中心 → 异地多活（数据最终一致，实现复杂度最高）。

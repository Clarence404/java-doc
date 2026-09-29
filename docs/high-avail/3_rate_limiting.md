# 限流

## 一、为什么需要限流

当请求量超过系统承载能力时，不加控制的流量会耗尽线程池、数据库连接池等资源，导致系统崩溃。限流的目标是**以可控的方式拒绝超量请求**，保护系统稳定运行。

---

## 二、四种限流算法

### 1. 固定窗口（Fixed Window）

将时间切成固定长度的窗口（如每秒），统计窗口内请求数，超过阈值则拒绝。

```
时间轴：|-- 0~1s --|-- 1~2s --|-- 2~3s --|
请求数：    100          100         100
阈值：      100          100         100
```

**缺点**：临界问题 —— 窗口边界前后各发 100 个请求，200ms 内实际通过 200 请求，远超阈值。

---

### 2. 滑动窗口（Sliding Window）

用多个子窗口（bucket）拼成一个滑动的大窗口，统计最近 N 个 bucket 的总请求数。

```
当前时间 t=1.8s，窗口大小 1s，分成 10 个 bucket（每个 100ms）：

[0.8~0.9][0.9~1.0][1.0~1.1] ... [1.7~1.8]
  ← 统计这 10 个 bucket 的总和 →
```

解决了固定窗口的临界问题，Sentinel 默认采用滑动窗口统计。

---

### 3. 令牌桶（Token Bucket）

以固定速率向桶中投放令牌，请求到来时消耗令牌，桶满则溢出（令牌不堆积超过桶容量）。

```
         固定速率生产令牌
              ↓
    [令牌桶  ████████  ]  容量 = 100
              ↓
     请求到来 → 取走令牌 → 通过
     桶空时   → 请求拒绝 / 等待
```

**特点**：允许**突发流量**（桶中积累的令牌可瞬间消耗），适合流量有短时峰值的场景。

---

### 4. 漏桶（Leaky Bucket）

请求进入桶中排队，以**固定速率**流出处理。桶满则拒绝新请求。

```
请求流入 → [漏桶队列] → 固定速率流出 → 处理
                ↓
            桶满则丢弃
```

**特点**：输出速率完全均匀，**不允许突发**，适合对下游调用频率有严格要求的场景（如第三方 API 限速）。

---

### 算法对比

| 算法 | 突发流量 | 实现复杂度 | 典型使用场景 |
|------|---------|-----------|------------|
| 固定窗口 | 有临界问题 | 简单 | 粗粒度场景、快速原型 |
| 滑动窗口 | 平滑 | 中 | Sentinel 默认统计窗口 |
| 令牌桶 | 允许 | 中 | API 网关、用户级限流 |
| 漏桶 | 不允许 | 中 | 调用第三方服务、匀速写 DB |

---

## 三、Redis + Lua 滑动窗口限流

使用 Redis `ZSET` 记录请求时间戳，利用 Lua 脚本保证原子性：

```lua
-- limit.lua
-- KEYS[1]: 限流 key（如 "rate:limit:userId:123"）
-- ARGV[1]: 当前时间戳（毫秒）
-- ARGV[2]: 窗口大小（毫秒），如 1000
-- ARGV[3]: 窗口内最大请求数，如 100

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- 删除窗口之前的过期记录
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
-- 统计当前窗口内请求数
local count = redis.call('ZCARD', key)
if count < limit then
    -- 未超限：记录本次请求
    redis.call('ZADD', key, now, now)
    redis.call('PEXPIRE', key, window)
    return 1  -- 允许
else
    return 0  -- 拒绝
end
```

```java
// Spring Boot 中调用
@Component
public class RedisRateLimiter {

    private final StringRedisTemplate redisTemplate;
    private final DefaultRedisScript<Long> script;

    public RedisRateLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
        script = new DefaultRedisScript<>();
        script.setLocation(new ClassPathResource("scripts/limit.lua"));
        script.setResultType(Long.class);
    }

    public boolean isAllowed(String key, int limit, long windowMillis) {
        long now = System.currentTimeMillis();
        Long result = redisTemplate.execute(script,
            Collections.singletonList(key),
            String.valueOf(now),
            String.valueOf(windowMillis),
            String.valueOf(limit));
        return Long.valueOf(1L).equals(result);
    }
}
```

---

## 四、单机限流（Guava RateLimiter）

Guava `RateLimiter` 基于令牌桶算法，适合**单实例**场景（进程内限流），无需 Redis：

```xml
<dependency>
    <groupId>com.google.guava</groupId>
    <artifactId>guava</artifactId>
    <version>33.0.0-jre</version>
</dependency>
```

```java
@Component
public class LocalRateLimiter {

    // 每秒最多 100 个请求
    private final RateLimiter limiter = RateLimiter.create(100.0);

    public boolean tryAcquire() {
        return limiter.tryAcquire();               // 立即返回是否获取到令牌
    }

    public boolean tryAcquire(long timeoutMs) {
        return limiter.tryAcquire(timeoutMs, TimeUnit.MILLISECONDS);  // 等待最多 N ms
    }
}

// 在 Spring AOP / Filter 中使用
@Around("@annotation(RateLimit)")
public Object around(ProceedingJoinPoint pjp) throws Throwable {
    if (!rateLimiter.tryAcquire()) {
        throw new TooManyRequestsException("请求过于频繁");
    }
    return pjp.proceed();
}
```

**RateLimiter 特性**：支持平滑预热（`RateLimiter.create(rate, warmupPeriod, timeUnit)`），启动时逐步增加速率而非直接满速，避免冷启动冲击 DB。

**局限性**：仅单机有效。多实例部署时需配合 Redis 做分布式限流（见第三节）。

---

## 五、网关限流（Spring Cloud Gateway）

在 API 网关集中限流，业务服务无需感知，适合统一入口场景：

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-gateway</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis-reactive</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100      # 每秒向桶补充 100 个令牌
                redis-rate-limiter.burstCapacity: 200      # 桶容量（允许的突发上限）
                redis-rate-limiter.requestedTokens: 1      # 每次请求消耗 1 个令牌
                key-resolver: "#{@userKeyResolver}"        # 限流维度（按用户）
```

```java
// 限流 Key 提取策略（按用户 ID 限流）
@Bean
public KeyResolver userKeyResolver() {
    return exchange -> Mono.justOrEmpty(
        exchange.getRequest().getHeaders().getFirst("X-User-Id")
    ).defaultIfEmpty("anonymous");
}

// 按 IP 限流
@Bean
public KeyResolver ipKeyResolver() {
    return exchange -> Mono.just(
        Objects.requireNonNull(exchange.getRequest().getRemoteAddress())
               .getAddress().getHostAddress()
    );
}
```

触发限流时 Gateway 自动返回 `429 Too Many Requests`，可自定义响应体：

```java
@Component
public class RateLimitErrorHandler implements ErrorWebExceptionHandler {
    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable ex) {
        if (exchange.getResponse().getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
            exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
            byte[] body = "{\"code\":429,\"message\":\"请求过于频繁，请稍后重试\"}".getBytes();
            return exchange.getResponse().writeWith(
                Mono.just(exchange.getResponse().bufferFactory().wrap(body))
            );
        }
        return Mono.error(ex);
    }
}
```

---

## 六、Sentinel 限流

### 流控规则配置

```java
// 代码方式定义流控规则
FlowRule rule = new FlowRule();
rule.setResource("queryOrder");                            // 资源名
rule.setGrade(RuleConstant.FLOW_GRADE_QPS);               // 限流维度：QPS
rule.setCount(100);                                        // 阈值：100 QPS
rule.setStrategy(RuleConstant.STRATEGY_DIRECT);            // 直接限流
rule.setControlBehavior(RuleConstant.CONTROL_BEHAVIOR_DEFAULT);  // 快速失败
FlowRuleManager.loadRules(Collections.singletonList(rule));
```

### @SentinelResource 注解

```java
@Service
public class OrderService {

    @SentinelResource(
        value = "queryOrder",
        blockHandler = "queryOrderBlock",    // 触发限流/熔断时的处理方法
        fallback = "queryOrderFallback"      // 业务异常时的降级方法
    )
    public Order queryOrder(Long id) {
        return orderRepository.findById(id).orElseThrow();
    }

    // 限流处理（参数列表需与原方法一致，最后加 BlockException）
    public Order queryOrderBlock(Long id, BlockException ex) {
        return Order.empty("系统繁忙，请稍后重试");
    }

    // 业务异常降级（参数列表与原方法一致）
    public Order queryOrderFallback(Long id, Throwable t) {
        return Order.empty("查询失败，返回默认数据");
    }
}
```

### 热点参数限流

针对参数值进行细粒度限流，如对某个特定商品 ID 的查询请求单独限速：

```java
// 对 queryItem 资源的第 0 个参数（itemId）做热点限流
ParamFlowRule rule = new ParamFlowRule("queryItem")
    .setParamIdx(0)
    .setGrade(RuleConstant.FLOW_GRADE_QPS)
    .setCount(50);          // 每个 itemId 最多 50 QPS

// 针对特殊商品（itemId=1001）单独设置更高阈值
ParamFlowItem item = new ParamFlowItem()
    .setObject(1001L)
    .setClassType(long.class.getName())
    .setCount(200);
rule.setParamFlowItemList(Collections.singletonList(item));

ParamFlowRuleManager.loadRules(Collections.singletonList(rule));
```

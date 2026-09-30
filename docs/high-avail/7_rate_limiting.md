# 限流与过载保护

> **本篇目标**：掌握四种限流算法与分布式实现，知道限流放在哪一层、阈值怎么定、被限流时返回什么，并能在固定阈值失效时用过载保护兜底。
>
> **前置阅读**：[降级](./6_degradation)
>
> **参考**：[Google SRE Book - Handling Overload](https://sre.google/sre-book/handling-overload/) · [Sentinel 系统自适应保护](https://sentinelguard.io/zh-cn/docs/system-adaptive-protection.html)

熔断和降级保护的是"下游出问题时的我"，限流保护的是"上游流量太大时的我"。请求量超过承载能力时，放任流量进来只会耗尽线程池、连接池，让所有请求一起超时。**限流的目标是以可控的方式拒绝超量请求，让系统在满负荷下仍按容量上限正常服务。**

| 手段 | 触发依据 | 解决的问题 |
|------|---------|-----------|
| 限流 | 预先设定的 QPS / 并发阈值 | 已知容量下，挡住超出部分 |
| 过载保护 | 系统实时状态（CPU、延迟、并发、排队时间） | 容量临时下降（依赖变慢、GC、机器差异）时固定阈值失效 |
| 按优先级卸载 | 请求重要程度 | 必须丢请求时，先丢不重要的 |

---

## 一、四种限流算法

**固定窗口最简单但有边界突发，滑动窗口修正了统计精度；令牌桶允许突发，漏桶强制匀速。**

### 1、固定窗口（Fixed Window）

把时间切成固定长度的窗口（如每秒一个），统计窗口内请求数，超过阈值即拒绝，窗口切换时计数清零。

![固定窗口的边界突发问题](../assets/high-avail/rate-limit-fixed-window.svg)

缺点是**临界突发**：窗口 1 的最后 100ms 和窗口 2 的最前 100ms 各放行 100 次，200ms 内实际通过 200 次，是阈值的 2 倍。

### 2、滑动窗口（Sliding Window）

把一个大窗口拆成多个子窗口（bucket），随时间向前滑动，只统计最近 N 个子窗口的总和。

![滑动窗口子窗口统计](../assets/high-avail/rate-limit-sliding-window.svg)

子窗口越多精度越高、内存越大。Sentinel 的秒级统计就是滑动窗口（`LeapArray`），默认 1s 拆成 2 个 500ms 子窗口。

### 3、令牌桶（Token Bucket）

以固定速率 r 往桶里放令牌，桶容量为 b；请求到来时取走一个令牌才能通过，取不到就拒绝或等待。

![令牌桶算法](../assets/high-avail/rate-limit-token-bucket.svg)

**允许突发**：空闲时攒下的令牌可以被瞬间消耗，适合入口流量有短时峰值、但长期平均速率要受控的场景。Guava `RateLimiter`、Spring Cloud Gateway 的 `RedisRateLimiter` 都是令牌桶。

### 4、漏桶（Leaky Bucket）

请求先进入队列，以固定速率流出处理，队列满则拒绝。

![漏桶算法](../assets/high-avail/rate-limit-leaky-bucket.svg)

**输出绝对平滑、不允许突发**，适合保护处理能力固定的下游，如调用有严格 QPS 配额的第三方 API、匀速写库。Sentinel 流控效果中的"匀速排队"就是漏桶思想。

### 5、算法对比

| 算法 | 突发流量 | 实现复杂度 | 典型场景 |
|------|---------|-----------|---------|
| 固定窗口 | 边界处可达 2 倍阈值 | 低 | 粗粒度配额（如每天调用次数） |
| 滑动窗口 | 平滑，精度取决于子窗口数 | 中 | 服务端 QPS 统计（Sentinel） |
| 令牌桶 | 允许，上限为桶容量 | 中 | 网关、用户级 / API 级限流 |
| 漏桶 | 不允许 | 中 | 第三方 API 配额、匀速写入 |

---

## 二、限流放在哪一层

**越靠外层越粗粒度、越省资源；越靠内层越精确、越贴近真实容量。** 生产上通常多层叠加，每层解决不同问题。接入层的整体架构见 [接入层架构](/high-con/1_access_layer)。

| 层次 | 典型实现 | 限流维度 | 主要作用 |
|------|---------|---------|---------|
| 接入层 | CDN / WAF、Nginx `limit_req` / `limit_conn` | IP、URL | 挡恶意刷量和 CC 攻击，最便宜的一层 |
| 网关 | Spring Cloud Gateway、APISIX、Kong + Redis 令牌桶 | 用户、租户、API、AppKey | 集群级配额，按调用方公平分配 |
| 服务 | Sentinel、Resilience4j RateLimiter、Guava | 实例级 QPS / 并发 | 按单机容量保护自己，不依赖外部组件 |
| 方法 / 资源 | Sentinel 热点参数、调用下游的客户端限流 | 参数值、下游资源 | 热点 key 单独限速；按下游配额保护下游 |

几条经验：

- **自我保护的限流一定要在服务内做**：网关限流是集群总量，挡不住负载不均或部分实例变慢时的单机过载
- **分布式限流依赖 Redis**：Redis 故障时要有降级策略（放行、退回单机限流），不能让限流器成为新的单点
- **限流 key 的基数要可控**：按用户 / IP 限流时每个 key 都占内存，注意过期和容量

---

## 三、阈值怎么定

**阈值来自压测，不来自拍脑袋。** 单机阈值取压测拐点（RT 开始陡增、错误率开始上升的那个 QPS）乘安全系数，流量估算与压测方法见 [容量评估与规划](/high-con/8_capacity_planning)。

| 步骤 | 做法 |
|------|------|
| 1. 单机压测 | 找到拐点 QPS 与对应并发数 |
| 2. 乘安全系数 | 单机阈值 ≈ 拐点 × 0.7 ~ 0.8，给 GC、突发、机器差异留余量 |
| 3. 推算集群阈值 | 集群阈值 ≈ 单机阈值 × 实例数，并按负载不均打折 |
| 4. 灰度上线 | 先用偏宽松的阈值，观察限流命中日志和指标，再逐步收紧 |
| 5. 跟随变化 | 扩缩容、版本发布、依赖变化后重新校验 |

::: warning 集群阈值拆到单机的陷阱
把集群总阈值平均拆到每台机器时，扩容后总阈值会被动变大、缩容后被动变小。需要严格控制总量时，用网关集中限流或 Sentinel 集群流控；只需保护单机时，按单机容量设阈值，与实例数无关。
:::

---

## 四、被限流时返回什么

**限流是正常的业务结果，不是异常：返回明确的状态码，并告诉调用方多久后再来。**

| 场景 | HTTP 状态码 | 响应头 | 说明 |
|------|-----------|-------|------|
| 超过调用方配额（按用户 / AppKey） | `429 Too Many Requests` | `Retry-After: <秒数>` | 调用方行为问题，自己降速 |
| 服务整体过载（过载保护、按优先级卸载） | `503 Service Unavailable` | `Retry-After: <秒数>` | 服务端问题，客户端应退避 |
| gRPC | `RESOURCE_EXHAUSTED` / `UNAVAILABLE` | — | 语义同上 |

约定要点：

- 响应体带统一的业务码和提示，前端据此展示"操作太频繁"，而不是通用错误页
- **客户端收到 429 / 503 不能立即重试**：按 `Retry-After` 或指数退避等待，且重试次数计入重试预算，见 [超时、重试与隔离](./4_timeout_retry_bulkhead)
- 限流命中要打指标（按资源、按调用方），用于告警和阈值调优

```java
// 服务内限流被触发时的统一响应：429 + Retry-After
private void writeTooManyRequests(HttpServletResponse response, int retryAfterSeconds) throws IOException {
    response.setStatus(429);
    response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
    response.setContentType("application/json;charset=UTF-8");
    response.getWriter().write("{\"code\":\"RATE_LIMITED\",\"message\":\"请求过于频繁，请稍后重试\"}");
}
```

---

## 五、分布式限流：Redis + Lua 滑动窗口

**多实例共享一个计数器时，用 Redis ZSET 记录每次请求的时间戳，Lua 脚本保证"清理—计数—写入"原子执行。**

```lua
-- scripts/sliding_window.lua
-- KEYS[1]: 限流 key，如 rate:limit:user:123
-- ARGV[1]: 窗口大小（毫秒）
-- ARGV[2]: 窗口内最大请求数
-- ARGV[3]: 本次请求的唯一 ID（UUID），避免同一毫秒的请求互相覆盖
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])

-- 使用 Redis 服务端时间，避免多实例之间时钟漂移
local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 清理窗口之外的旧记录
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

if redis.call('ZCARD', key) < limit then
    -- member 必须唯一：score 相同的请求才能都被计数
    redis.call('ZADD', key, now, now .. '-' .. ARGV[3])
    redis.call('PEXPIRE', key, window)
    return 1
end
return 0
```

```java
@Slf4j
@Component
public class RedisSlidingWindowLimiter {

    private final StringRedisTemplate redisTemplate;
    private final DefaultRedisScript<Long> script;

    public RedisSlidingWindowLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
        this.script = new DefaultRedisScript<>();
        this.script.setLocation(new ClassPathResource("scripts/sliding_window.lua"));
        this.script.setResultType(Long.class);
    }

    public boolean tryAcquire(String key, int limit, long windowMillis) {
        try {
            Long result = redisTemplate.execute(script,
                    Collections.singletonList(key),
                    String.valueOf(windowMillis),
                    String.valueOf(limit),
                    UUID.randomUUID().toString());
            return Long.valueOf(1L).equals(result);
        } catch (DataAccessException e) {
            // Redis 不可用时放行（fail-open），并依赖单机限流兜底；强管控场景可改为拒绝
            log.warn("限流 Redis 不可用，key={}，本次放行", key, e);
            return true;
        }
    }
}
```

::: tip 实现细节
- 在 Lua 中调用 `TIME` 后再写入，要求 Redis 5+（默认按效果复制）；更老的版本需先调用 `redis.replicate_commands()`
- ZSET 方案每个请求占一个元素，内存与阈值成正比，适合阈值较小（如每用户每分钟几十次）的场景；阈值大时改用令牌桶或"子窗口计数"方案
- Redis Cluster 下一个脚本访问的所有 key 必须在同一 slot，本脚本只用一个 key，天然满足
:::

---

## 六、单机限流：Guava RateLimiter

**进程内令牌桶，无外部依赖，适合按单机容量做自我保护。**

```java
@Component
public class LocalRateLimiter {

    // 每秒 100 个令牌
    private final RateLimiter limiter = RateLimiter.create(100.0);

    // 立即返回，拿不到令牌就拒绝（接口限流通常用这个）
    public boolean tryAcquire() {
        return limiter.tryAcquire();
    }

    // 最多等待 timeoutMs，适合后台任务匀速执行
    public boolean tryAcquire(long timeoutMs) {
        return limiter.tryAcquire(timeoutMs, TimeUnit.MILLISECONDS);
    }
}
```

- `RateLimiter.create(rate, warmupPeriod, unit)` 支持预热：冷启动后在预热期内逐步提升到目标速率，避免缓存未热时直接打满数据库
- `acquire()` 会阻塞等待，接口入口不要用，否则限流变成排队，请求在超时前堆满线程池

---

## 七、网关限流：Spring Cloud Gateway

**`RequestRateLimiter` 过滤器 + `RedisRateLimiter`（Redis 令牌桶）实现集群级限流，业务服务无感知。**

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
                redis-rate-limiter.replenishRate: 100   # 每秒补充 100 个令牌
                redis-rate-limiter.burstCapacity: 200   # 桶容量，即允许的突发上限
                redis-rate-limiter.requestedTokens: 1   # 每个请求消耗的令牌数
                key-resolver: "#{@userKeyResolver}"     # 限流维度
                deny-empty-key: true                    # key 为空时拒绝（默认 true）
                empty-key-status: FORBIDDEN             # key 为空时返回的状态码（默认 403）
```

```java
@Configuration
public class RateLimiterKeyConfig {

    // 按用户限流：取鉴权过滤器注入的用户 ID；取不到时返回空，由 deny-empty-key 拒绝
    @Bean
    public KeyResolver userKeyResolver() {
        return exchange -> Mono.justOrEmpty(
                exchange.getRequest().getHeaders().getFirst("X-User-Id"));
    }
}
```

几个容易写错的地方：

- **不要给空 key 兜底成固定值**：`defaultIfEmpty("anonymous")` 会让所有匿名请求共用一个桶，一个刷子就能把所有匿名用户挡在外面；匿名流量应走单独的路由、按 IP 限流
- **触发限流时过滤器直接写 429 并结束响应，不抛异常**，所以 `ErrorWebExceptionHandler` 捕获不到；默认响应体为空，需要自定义响应体时要扩展 `RequestRateLimiterGatewayFilterFactory` 或写 `GlobalFilter`
- 响应会带 `X-RateLimit-Remaining`、`X-RateLimit-Burst-Capacity` 等头，但**默认不带 `Retry-After`**，按第四节约定需要时自行补充
- 按 IP 限流时，经过 CDN / SLB 后 `getRemoteAddress()` 是代理地址，要从可信的 `X-Forwarded-For` 中取真实 IP

网关的完整配置见 [API 网关](/spring-cloud/2_api_gateway)。

---

## 八、Sentinel 限流

**Sentinel 以"资源"为单位配置规则，除 QPS 限流外还支持并发线程数、热点参数、集群流控和系统自适应保护。**

| 能力 | 说明 | 典型用法 |
|------|------|---------|
| QPS 流控 | 滑动窗口统计，超阈值按流控效果处理 | 接口级限流 |
| 并发线程数流控 | 限制同时执行的线程数 | 慢接口、调用慢依赖的资源（见第九节） |
| 流控效果 | 快速失败 / Warm Up（冷启动预热） / 匀速排队（漏桶） | 秒杀入口用快速失败，消息消费用匀速排队 |
| 热点参数限流 | 按参数值分别计数，可对特定值单独设阈值 | 爆款商品 ID 单独限速 |
| 集群流控 | Token Server 统一发放令牌 | 严格控制集群总量 |

最小示例：

```java
FlowRule rule = new FlowRule("queryOrder");
rule.setGrade(RuleConstant.FLOW_GRADE_QPS);  // 按 QPS 限流
rule.setCount(100);                          // 单机阈值 100 QPS
FlowRuleManager.loadRules(Collections.singletonList(rule));
```

`@SentinelResource` 注解、`blockHandler` 与 `fallback` 的区别、热点参数规则代码、规则持久化到 Nacos，见 [Spring Cloud Alibaba - Sentinel](/spring-cloud/6_alibaba)。

---

## 九、过载保护与自适应限流

**固定阈值只在"容量不变"时成立。** 依赖变慢、Full GC、宿主机争抢都会让真实容量临时下降，此时 QPS 阈值还没到，系统已经过载。过载保护根据系统的实时状态决定是否放行。

### 1、并发数限流与 Little 定律

**限制并发数比限制 QPS 更能自适应延迟变化。** 由 Little 定律 `并发数 = 吞吐量 × 平均响应时间`（推导见 [性能指标](/high-perf/1_metrics)）：

| 状态 | 吞吐量 | 平均 RT | 所需并发 |
|------|-------|--------|---------|
| 正常 | 1000 QPS | 50ms | 50 |
| 下游变慢，只限 QPS | 1000 QPS | 500ms | 500，线程池被打满 |
| 下游变慢，限并发 50 | 自动降到 100 QPS | 500ms | 50，线程池安全 |

QPS 阈值不变时，RT 上涨会让在途请求成倍堆积；并发上限不变时，吞吐会随 RT 自动收缩。实现方式：Sentinel 的 `FLOW_GRADE_THREAD`、Resilience4j `Bulkhead`、或一个 `Semaphore`。

### 2、系统自适应保护（Sentinel SystemRule）

**从整机维度保护入口流量**，只对入口资源（`EntryType.IN`）生效：

```java
SystemRule rule = new SystemRule();
rule.setHighestSystemLoad(8.0);   // load1 阈值，建议取 CPU 核数 × 1 ~ 2.5；仅 Linux / Unix 有效
rule.setHighestCpuUsage(0.8);     // CPU 使用率阈值，取值 0 ~ 1
rule.setAvgRt(200);               // 入口平均 RT 阈值（ms）
rule.setMaxThread(200);           // 入口并发线程数阈值
rule.setQps(1000);                // 入口总 QPS 阈值
SystemRuleManager.loadRules(Collections.singletonList(rule));
```

- **load 指标只在 Linux / Unix 上生效**：它取自 `getSystemLoadAverage()`，Windows 上返回负值，规则不会触发
- load 超阈值时并不会直接拒绝，而是再做一次 **BBR 式判断**：当前并发 > `最大成功 QPS × 最小 RT` 时才拒绝，即"在途请求已超过系统估算的处理能力"
- 容器中 load 反映的是宿主机，CPU 使用率是否按容器配额计算与 JDK 版本有关，**容器内优先用 CPU、RT、并发数指标**，并以压测结果校验

### 3、BBR 思想：估算最大并发

BBR 源自 TCP 拥塞控制：系统的最佳在途量 ≈ 最大吞吐 × 最小延迟。把它用在服务端：

- 持续统计窗口内的最大成功 QPS（maxPass）与最小 RT（minRt），估算容量 `maxInflight = maxPass × minRt`
- 仅在 CPU 等指标超过触发阈值时，才拒绝"在途请求数 > maxInflight"的新请求，避免误杀
- 同类实现：Kratos 的 BBR 限流器、Netflix concurrency-limits（基于 Vegas / Gradient 算法动态调整并发上限）

### 4、负载卸除与按优先级卸载

**必须丢请求时，先丢不重要的。** 给请求分级，在途请求越多，允许进入的优先级越高：

```java
@Slf4j
@Component
public class PriorityLoadSheddingFilter extends OncePerRequestFilter {

    private static final int MAX_INFLIGHT = 200;      // 按压测拐点并发设定
    private final AtomicInteger inflight = new AtomicInteger();

    enum Priority {
        CRITICAL(1.0),  // 下单、支付：在途达到上限才拒绝
        NORMAL(0.8),    // 普通查询：80% 开始卸载
        LOW(0.6);       // 推荐、埋点、报表：60% 开始卸载

        final double shedRatio;
        Priority(double shedRatio) { this.shedRatio = shedRatio; }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        Priority priority = resolvePriority(request);
        int current = inflight.incrementAndGet();
        try {
            if (current > MAX_INFLIGHT * priority.shedRatio) {
                log.debug("负载卸除：priority={}, inflight={}", priority, current);
                response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
                response.setHeader("Retry-After", "1");
                return;
            }
            chain.doFilter(request, response);
        } finally {
            inflight.decrementAndGet();
        }
    }

    // 优先级由网关按路由或调用方写入，不信任客户端自带的值
    private Priority resolvePriority(HttpServletRequest request) {
        String p = request.getHeader("X-Request-Priority");
        if (p == null) {
            return Priority.NORMAL;
        }
        try {
            return Priority.valueOf(p);
        } catch (IllegalArgumentException e) {
            return Priority.NORMAL;
        }
    }
}
```

- 该计数方式适用于同步 Servlet；异步请求（`DeferredResult`、WebFlux）要在真正完成时再减计数
- **请求已超过调用方 deadline 就直接丢弃**：排队太久的请求，客户端早已超时，处理它只会浪费资源
- 越早卸载越省资源：能在网关按优先级卸载的，不要等到进入业务线程池

### 5、客户端自适应节流

**服务端拒绝请求也有成本；过载严重时，拒绝本身也会压垮服务。** Google SRE 提出的客户端节流让调用方在本地提前拒绝：

- 客户端统计最近一段时间（如 2 分钟）的请求数 `requests` 与被后端接受的数 `accepts`
- 本地拒绝概率 `p = max(0, (requests - K × accepts) / (requests + 1))`，K 通常取 2
- 后端正常时 `accepts ≈ requests`，p 为 0；后端大量拒绝时，客户端按比例在本地直接失败，不再发出请求

它与熔断的区别：熔断是开 / 关二值切换，自适应节流是按比例连续调节，更平滑。

---

## 小结

- 固定窗口有边界突发，滑动窗口修正统计；令牌桶允许突发，漏桶强制匀速
- 限流多层叠加：接入层防刷、网关管配额、服务内按单机容量自保，自保限流必须在服务内做
- 阈值 = 压测拐点 × 安全系数，上线后按命中数据调整；被限流返回 429 / 503 + `Retry-After`，客户端退避而非立即重试
- 分布式限流注意唯一 member、Redis 服务端时间与 Redis 故障时的降级；网关空 key 用 `deny-empty-key`，不要兜底成共享 key
- 容量会变，固定阈值会失效：用并发数限流、系统自适应保护、按优先级卸载和客户端节流兜底

> 下一篇：[优雅上下线与变更](./8_graceful_release) —— 发布是最频繁的计划内故障，如何让每次上下线都无损。

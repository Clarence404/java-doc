---
description: 排行榜、布隆过滤器、签到统计、可靠延迟队列、List / Stream 队列、其他场景索引
---

# Redis 典型应用场景

> **本篇目标**：掌握几种常见业务场景的 Redis 数据结构选型与正确写法，重点是延迟队列和 Stream 队列在消费失败时如何不丢任务。
>
> **前置阅读**：[Redis 基础](./1_redis_base)、[Redis 核心原理](./2_redis_core)（Lua 脚本）

本篇只讲 Redis 层面的实现。限流、分布式会话、分布式锁有各自的主文档，见文末第六节的索引。示例基于 Spring Boot 4 / Spring Data Redis 4，`redis` 指注入的 `StringRedisTemplate`。

---

## 一、排行榜（ZSet）

```java
// 加分
redis.opsForZSet().incrementScore("rank:game:202610", userId, delta);

// Top 10（降序）
Set<ZSetOperations.TypedTuple<String>> top10 =
        redis.opsForZSet().reverseRangeWithScores("rank:game:202610", 0, 9);

// 某用户的名次（从 0 开始，null 表示未上榜）
Long rank = redis.opsForZSet().reverseRank("rank:game:202610", userId);
```

注意点：

- **同分排序**：score 相同按成员字典序排列，不是按先到先得。需要「同分先达到者靠前」时把时间编进 score，例如 `score = 积分 × 10^10 + (9999999999 - 秒级时间戳)`；score 是 double，整数部分不能超过 2^53，要按积分上限核算位数
- **数据量**：ZSet 的增删查都是 O(log N)，百万成员没有问题；真正的风险是大 key 的删除、迁移和全量读取，按周期分 key（如按月）并给过期时间，删除用 `UNLINK`
- 分榜、合榜、实时与离线结合的完整设计见 [排行榜和积分](/scenario/7_rank_system)

---

## 二、布隆过滤器

布隆过滤器用很少的内存判断元素「可能存在」或「一定不存在」：有误判（把不存在说成可能存在），不会漏判；标准布隆过滤器不能删除元素。常用于拦截不存在的 ID，防止缓存穿透，穿透 / 击穿 / 雪崩的整体防护见 [缓存最佳实践](./11_cache_rule)。

### 1、Redis 8 原生 Bloom

Redis 8 内置 `BF.*` 命令，过滤器的位数组和哈希计算都在服务端，一次往返完成。Spring Data Redis 没有专用 API，可以通过 `execute` 发原生命令：

```java
// 初始化一次：误判率 0.1%，预计 100 万元素；已存在时会报错，可在部署脚本中执行
// BF.RESERVE bf:product 0.001 1000000

public boolean mightContain(long productId) {
    Object r = redis.execute((RedisCallback<Object>) conn -> conn.execute("BF.EXISTS",
            "bf:product".getBytes(StandardCharsets.UTF_8),
            String.valueOf(productId).getBytes(StandardCharsets.UTF_8)));
    return Long.valueOf(1L).equals(r);
}
```

需要删除元素时改用 Cuckoo 过滤器（`CF.ADD` / `CF.DEL` / `CF.EXISTS`）。

### 2、Redisson RBloomFilter

Redisson 的布隆过滤器在客户端计算哈希、用 Bitmap 存储，不依赖 Redis 模块，Valkey 和旧版本 Redis 也能用：

```java
RBloomFilter<String> bloomFilter = redissonClient.getBloomFilter("bf:product");
bloomFilter.tryInit(1_000_000L, 0.001);   // 预计 100 万元素，误判率 0.1%

// 启动或数据变更时写入合法 ID
productIds.forEach(id -> bloomFilter.add(String.valueOf(id)));

public Product getProduct(Long id) {
    if (!bloomFilter.contains(String.valueOf(id))) {
        return null;                       // 一定不存在，直接返回
    }
    return productCache.getOrLoad(id);     // 可能存在：查缓存，未命中再查库并回填
}
```

实际元素数超过预估时误判率会快速上升，要监控元素数并定期重建；新增数据要同步写入过滤器，否则新数据会被误拦。

---

## 三、签到统计（Bitmap）

每个用户每月一个 key，第 d 天对应偏移 `d - 1`：

```java
String key = "sign:" + userId + ":" + YearMonth.now();     // sign:1001:2026-10
int day = LocalDate.now().getDayOfMonth();

// 签到
redis.opsForValue().setBit(key, day - 1, true);

// 当月签到天数
Long total = redis.execute((RedisCallback<Long>) conn ->
        conn.stringCommands().bitCount(key.getBytes(StandardCharsets.UTF_8)));

// 截至今天的连续签到天数：一次取出 1..day 号的位，从最低位（今天）往前数连续的 1
List<Long> bits = redis.opsForValue().bitField(key, BitFieldSubCommands.create()
        .get(BitFieldSubCommands.BitFieldType.unsigned(day)).valueAt(0));
long v = (bits == null || bits.isEmpty() || bits.get(0) == null) ? 0 : bits.get(0);
int streak = 0;
while ((v & 1) == 1) {
    streak++;
    v >>>= 1;
}
```

`BITFIELD GET u<N> 0` 把偏移 0 作为最高位返回，所以最低位就是今天。一个月最多 31 位，不会超过无符号 63 位的上限。`RedisConnection` 上直接调用 `bitCount` 等方法从 Spring Data Redis 3.0 起已废弃，改用 `stringCommands()`。

---

## 四、可靠延迟队列（ZSet）

订单超时关闭、定时重试等场景可以用 ZSet 做延迟队列：score 存执行时间，定时取出到期任务。常见的「先 `ZREM` 抢占再处理」写法有个问题：抢到后进程崩溃或处理异常，任务就丢了。可靠写法是增加一个 processing 集合，处理成功才确认：

![可靠延迟队列：ready / processing 两个 ZSet](../assets/cache/redis-delay-queue.svg)

```java
@Component
public class OrderTimeoutQueue {

    private static final Logger log = LoggerFactory.getLogger(OrderTimeoutQueue.class);
    // 同一个 Hash Tag，Cluster 下两个 key 在同一个槽，Lua 才能同时操作
    private static final String READY = "{delay:order}:ready";
    private static final String PROCESSING = "{delay:order}:processing";
    private static final long VISIBILITY_MS = 60_000;   // 领取后 60 秒内未确认视为失败

    // 把 KEYS[1] 中 score <= ARGV[1] 的最多 ARGV[3] 个元素移到 KEYS[2]，新 score = ARGV[1] + ARGV[2]
    private static final String MOVE_DUE_LUA = """
            local items = redis.call('ZRANGE', KEYS[1], '-inf', ARGV[1], 'BYSCORE', 'LIMIT', 0, tonumber(ARGV[3]))
            for _, id in ipairs(items) do
              redis.call('ZREM', KEYS[1], id)
              redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[2]), id)
            end
            return items
            """;

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static final RedisScript<List<String>> MOVE_DUE =
            (RedisScript) RedisScript.of(MOVE_DUE_LUA, List.class);

    private final StringRedisTemplate redis;
    private final OrderService orderService;

    public OrderTimeoutQueue(StringRedisTemplate redis, OrderService orderService) {
        this.redis = redis;
        this.orderService = orderService;
    }

    public void add(String orderNo, Instant executeAt) {
        redis.opsForZSet().add(READY, orderNo, executeAt.toEpochMilli());
    }

    // 领取到期任务：原子地从 ready 移到 processing，score 改为处理截止时间
    @Scheduled(fixedDelay = 1000)
    public void poll() {
        String now = String.valueOf(System.currentTimeMillis());
        List<String> due = redis.execute(MOVE_DUE, List.of(READY, PROCESSING),
                now, String.valueOf(VISIBILITY_MS), "100");
        if (due == null) {
            return;
        }
        for (String orderNo : due) {
            try {
                orderService.closeIfUnpaid(orderNo);       // 业务必须幂等：按订单状态做条件更新
                redis.opsForZSet().remove(PROCESSING, orderNo);   // 成功才确认
            } catch (Exception e) {
                log.warn("close order {} failed, will retry after visibility timeout", orderNo, e);
            }
        }
    }

    // 回收超时未确认的任务：从 processing 移回 ready，立即可被再次领取
    @Scheduled(fixedDelay = 10_000)
    public void requeueExpired() {
        redis.execute(MOVE_DUE, List.of(PROCESSING, READY),
                String.valueOf(System.currentTimeMillis()), "0", "1000");
    }
}
```

要点：

- **领取是原子的**：`ZRANGE ... BYSCORE`（6.2+）加 `LIMIT` 控制单批数量，多实例并发轮询也不会重复领取同一个任务
- **至少一次投递**：处理超过可见性超时、或处理成功但确认前宕机，任务都会被再次投递，所以业务必须幂等（如 `UPDATE ... WHERE status = 'UNPAID'`），通用做法见 [幂等方案总结](/architecture/5_idempotence)
- **重试上限**：可再用一个 Hash 记录每个任务的投递次数，超过阈值转入死信集合并告警
- **持久化边界**：Redis 的持久化与复制都是异步的，主节点宕机可能丢掉最近写入的任务。订单关闭这类不能丢的场景，优先用 MQ 的延迟消息，或以数据库中的订单状态做定时兜底扫描

Redisson 也提供延迟队列，但开源版 `RDelayedQueue` 已被标记为废弃，见 [Redisson](./6_redisson)。

---

## 五、Redis 做消息队列

### 1、List：BLMOVE 可靠队列

`LPUSH` + `BRPOP` 的简单队列在消费者取出消息后崩溃就会丢消息。可靠写法是取出的同时原子放入一个处理中列表，处理成功再删除：

```java
// 生产
redis.opsForList().rightPush("queue:task", message);

// 消费：BLMOVE（6.2+），弹出并原子放入 processing 列表，最多阻塞 5 秒
String msg = redis.opsForList().move("queue:task", RedisListCommands.Direction.LEFT,
        "queue:task:processing", RedisListCommands.Direction.RIGHT, Duration.ofSeconds(5));
if (msg != null) {
    handle(msg);                                                // 业务幂等
    redis.opsForList().remove("queue:task:processing", 1, msg); // 成功后确认
}
```

处理中列表里长期滞留的消息需要单独的回收任务移回主队列。`RPOPLPUSH` / `BRPOPLPUSH` 已被 `LMOVE` / `BLMOVE` 取代。

### 2、Stream：消费组队列

Stream 自带消费组、ACK 和待确认列表（PEL），是 Redis 里最接近 MQ 的结构。消费组要先创建，可在部署脚本中执行 `XGROUP CREATE orders group1 $ MKSTREAM`。

```java
// 生产
redis.opsForStream().add(StreamRecords.newRecord()
        .in("orders")
        .ofMap(Map.of("orderNo", "123", "amount", "99.9")));

// 消费：读本组未投递过的新消息，最多 10 条，最多阻塞 2 秒
List<MapRecord<String, Object, Object>> records = redis.opsForStream().read(
        Consumer.from("group1", consumerName),
        StreamReadOptions.empty().count(10).block(Duration.ofSeconds(2)),
        StreamOffset.create("orders", ReadOffset.lastConsumed()));

if (records != null) {
    for (MapRecord<String, Object, Object> record : records) {
        handle(record.getValue());                                       // 业务幂等
        redis.opsForStream().acknowledge("orders", "group1", record.getId());  // 成功才 ACK
    }
}
```

- 处理失败不 ACK，消息留在 PEL；需要定时用 `XPENDING` 查看、用 `XAUTOCLAIM`（6.2+）把超时消息转给存活的消费者重试，投递次数过多的转入死信并告警
- 生产代码建议用 `StreamMessageListenerContainer` 管理轮询线程，而不是自己写循环
- 生产时用 `XADD ... MAXLEN ~ N` 限制长度，避免 Stream 无限增长
- Stream 的持久化与复制都是异步的，故障时可能丢最近的消息；可靠性、顺序与积压处理的系统性方案见 [消息队列基础](/messaging/1_basics)

---

## 六、其他场景索引

以下场景常用 Redis 实现，但主文档在其他模块，这里只给结论：

- **限流**：固定窗口用 `INCR` + `EXPIRE`，滑动窗口用 ZSet + Lua（成员要唯一，如「时间戳-请求 ID」，否则同一毫秒的请求互相覆盖）。算法对比与完整脚本见 [限流与过载保护](/high-avail/7_rate_limiting)，Redisson `RRateLimiter` 的用法见 [Redisson](./6_redisson)
- **分布式会话**：Spring Session 把 Session 存进 Redis，或用 Redis 存 Token 实现主动失效、踢人下线，见 [分布式会话](/distributed/5_session)
- **分布式锁**：`SET key uuid NX PX` 加锁、Lua 比对后删除解锁，长任务要续期或用 fencing token，见 [分布式锁](/distributed/3_lock)
- **计数器 / UV**：精确计数用 `INCR` / `HINCRBY`，海量去重计数用 HyperLogLog，见 [Redis 基础](./1_redis_base)
- **附近的人**：GEO 命令，完整设计见 [附近的人](/scenario/12_geo_nearby)

---

## 小结

- 排行榜用 ZSet，同分顺序要把时间编进 score，大榜按周期分 key
- 布隆过滤器优先用 Redis 8 原生 `BF.*`，需要删除用 Cuckoo；Redisson 实现适合 Valkey 或旧版本
- 签到用每月一个 Bitmap，连续天数用 `BITFIELD` 一次取出再在本地计算
- 延迟队列用 ready / processing 两个 ZSet，Lua 原子领取、成功才确认、超时回收，业务必须幂等
- List 队列用 `BLMOVE` 保留处理中副本，Stream 用消费组 + ACK + `XAUTOCLAIM`；不能丢的消息用专业 MQ

## 参考资料

- Sorted sets：[https://redis.io/docs/latest/develop/data-types/sorted-sets/](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- Bloom filter：[https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/](https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/)
- BITFIELD：[https://redis.io/docs/latest/commands/bitfield/](https://redis.io/docs/latest/commands/bitfield/)
- LMOVE（含可靠队列模式）：[https://redis.io/docs/latest/commands/lmove/](https://redis.io/docs/latest/commands/lmove/)
- Redis Streams：[https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)
- Spring Data Redis Streams：[https://docs.spring.io/spring-data/redis/reference/redis/redis-streams.html](https://docs.spring.io/spring-data/redis/reference/redis/redis-streams.html)
- Redisson Bloom filter：[https://redisson.pro/docs/data-and-services/collections/](https://redisson.pro/docs/data-and-services/collections/)

> 下一篇：[Redis 实战](./5_redis_practice) —— Spring Data Redis 集成与序列化、Spring Cache 配置、大 Key / 热 Key 治理与性能优化。

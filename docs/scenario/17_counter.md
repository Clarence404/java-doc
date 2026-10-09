---
description: Redis 计数与关系去重、CDC 异步落库与最终一致、热点分桶、读路径降级、大 V 点赞查询、对账校准、存储估算
---

# 计数系统

> **本篇目标**：设计一套支撑点赞数、阅读数、粉丝数、评论数的计数服务，做到读路径毫秒级返回、写热点不打垮数据库、重复消息不重复累加，并能通过定期对账把偏差校准回来。
>
> **前置阅读**：[热点问题](/high-con/6_hotspot)（合并更新、分桶一节）、[消息队列基础](/messaging/1_basics)、[缓存一致性](/cache/10_cache_consistency)、[Redis 典型应用场景](/cache/4_redis_scenario)

计数看起来只是一个 `count + 1`，难在规模：一条热门内容每秒被点赞几万次、每个 Feed 页面要一次拿出几十个对象的四五种计数。思路是：**关系（谁赞了谁）以数据库为准，计数是关系的派生值，异步合并后落库，读走 Redis 和本地缓存，偏差靠对账收敛**。

---

## 一、需求与挑战

### 1、四类计数

| 计数 | 是否有对应关系记录 | 写入特点 | 精度要求 | 写入方式 |
|------|------------------|----------|----------|----------|
| 点赞数 | 有（点赞记录） | 热门内容瞬时集中 | 可短暂不一致，最终要和关系对上 | 关系表为准，CDC 异步计数 |
| 评论数 | 有（评论表） | 量小于点赞 | 同上，删评、审核下线要减回去 | 同上 |
| 粉丝数 | 有（关注表） | 大 V 官宣时集中涨粉 | 同上 | 同上 |
| 阅读数 | 没有（不保存每次阅读） | 量最大，是点赞的几十倍 | 允许少量丢失，只增不减 | Redis 先计，定时刷盘 |

是否有关系记录决定了两条不同的写路径：有关系的计数可以随时从关系表重算，所以能做对账；阅读数没有明细，丢了就找不回来，只能尽量少丢。

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 读多 | 每次 Feed 刷新、详情页打开都要读计数，读量是写量的百倍以上 |
| 写热点 | 爆款内容的点赞、阅读集中在一行数据、一个 Redis key 上 |
| 重复与一致性 | 连点、重试、MQ 重复投递都不能多加；允许几秒延迟，但不能长期偏离关系表 |
| 成本 | 内容总量以十亿计，全部放进 Redis 太贵，要区分冷热 |

---

## 二、整体架构

![计数系统整体架构](../assets/scenario/counter-arch.svg)

| 组件 | 职责 |
|------|------|
| 关系服务 | 点赞、关注、评论的写入口，只写关系表，用唯一约束去重 |
| CDC + Kafka | 订阅关系表 binlog，把插入、删除转成 +1 / -1 事件，按对象 ID 分区 |
| 计数消费者 | 批量消费，按对象合并增量，写 MySQL 计数表后再更新 Redis |
| 阅读计数 | 阅读数直接在 Redis 累加，热点对象分桶，由刷盘任务定时写库 |
| 计数读取 | 批量读 Redis，热点对象加 1 秒本地缓存，Redis 故障时降级 |
| MySQL 计数表 | 每个对象一行，是计数的持久化副本，也是 Redis 未命中时的回源 |

- 关系服务不直接发 MQ，计数事件来自已提交的 binlog，事务回滚的点赞不会产生计数
- 一个对象的所有计数放在一个 Redis Hash 里（`cnt:<id>`，字段 `like` / `comment` / `fans`），读一个对象只要一次 `HGETALL`；阅读数单独用 `view:<id>` 字符串，因为它的写入方式和刷盘逻辑与其他计数不同

---

## 三、Redis 计数结构

### 1、命令选择

| 需求 | 命令 | 说明 |
|------|------|------|
| 单个计数 | `INCR` / `INCRBY` | 字符串 key，原子加减 |
| 一个对象多种计数 | `HINCRBY` | Hash 字段数少时用 listpack 紧凑编码，比多个字符串 key 省内存 |
| 批量读取 | pipeline 里多个 `HMGET` | Cluster 下不同对象落在不同槽，客户端按节点拆分发送 |

计数 key 一律设 TTL（如 3 天，读写时续期），冷对象自然淘汰，下次读取从计数表重建；增量只在 key 存在时执行（见第四节），防止淘汰后从 0 开始累加。

### 2、关系去重：Set、Bitmap 还是关系表

点赞必须去重，「同一个人对同一条内容只算一次」。几种做法的取舍：

| 做法 | 优点 | 问题 |
|------|------|------|
| Redis Set（每个对象一个） | `SADD` 返回 1 才加计数，天然去重 | 大 V 内容几百万成员，单 key 几百 MB，见第八节 |
| Redis Bitmap（以用户 ID 为偏移） | 每个用户 1 bit | 用户 ID 稀疏或很大时浪费严重，10 亿 ID 上限就是 119 MB 一个 key |
| 关系表唯一约束 | 持久、可对账、可查「谁赞了我」 | 每次点赞一次数据库写入 |

本篇以**关系表唯一约束**为准：点赞关系本来就要持久保存（「我赞过的」「谁赞了我」都要查），去重放在这里一举两得。Redis 中的 Set / Bitmap 只作为「是否已赞」的查询缓存，不承担去重职责。

---

## 四、点赞写路径与异步落库

![点赞计数写入链路](../assets/scenario/counter-like-flow.svg)

### 1、关系表：唯一约束兜底

```sql
CREATE TABLE like_record (
    id          BIGINT PRIMARY KEY,                -- 分布式 ID
    user_id     BIGINT NOT NULL,
    target_id   BIGINT NOT NULL,
    create_time DATETIME(3) NOT NULL,
    UNIQUE KEY uk_user_target (user_id, target_id)
);

CREATE TABLE counter (
    target_id   BIGINT PRIMARY KEY,
    like_cnt    BIGINT NOT NULL DEFAULT 0,
    comment_cnt BIGINT NOT NULL DEFAULT 0,
    view_cnt    BIGINT NOT NULL DEFAULT 0,
    update_time DATETIME(6) NOT NULL
);

CREATE TABLE consumer_offset (                     -- 计数消费者的位点，与计数在同一个库
    topic            VARCHAR(64) NOT NULL,
    part             INT NOT NULL,
    committed_offset BIGINT NOT NULL,              -- 初始化为 -1
    PRIMARY KEY (topic, part)
);
```

```java
// LikeService（@Service，注入 LikeMapper likeMapper 与 LikedCache likedCache）
public boolean like(long userId, long targetId) {
    try {
        likeMapper.insert(userId, targetId);       // uk_user_target 拦住重复点赞与重试
    } catch (DuplicateKeyException e) {
        return false;                              // 已经赞过：幂等返回，不报错
    }
    likedCache.evict(userId);                      // 先写库再删「我赞过的」缓存
    return true;
}
// unlike：DELETE 影响 1 行才算取消成功，同样先写库再删缓存
```

- 点赞、取消点赞都以「影响行数」判断是否真的发生了变化，用户连点、网关重试都只会成功一次；通用幂等做法见 [幂等设计](/architecture/5_idempotence)
- 关系表按 `user_id` 分片，「我赞过的」只查一个分片；「谁赞了我」和对账需要按 `target_id` 查，由 CDC 再同步一份按 `target_id` 分片的副本，分片方法见 [数据层扩展](/high-con/5_data_scaling)
- 自己点赞后看到的 +1 由前端乐观更新，其他人看到的计数有秒级延迟

### 2、计数事件从哪来

在点赞方法里直接 `HINCRBY` 或发 MQ 都有问题：前者 Redis 和数据库两次写不原子，后者如果放在事务里，事务回滚了消息已经发出。这里用 **CDC 订阅关系表 binlog**：binlog 只包含已提交的变更，`INSERT` 转成 `+1`、`DELETE` 转成 `-1`，以 `target_id` 为消息 key 写入 Kafka，同一对象的事件进同一分区、按顺序消费。不方便接 CDC 时，用 Outbox（关系记录和事件记录在同一事务写入，由中继投递）效果相同。两种方案的对比见 [消息队列基础](/messaging/1_basics)（分布式事务中的消息一节）。

### 3、计数消费者：合并增量，位点与计数同事务

MQ 是至少一次投递，消费者重启、再均衡都会重放消息，计数如果每条加一次就会多加。这里把**消费位点和计数写在同一个本地事务**里：已经落库的 offset 不会被再加一次，同时一批消息可以按对象合并成一条 `UPDATE`。

```java
public record CountEvent(long targetId, int delta) {}   // CDC 转换后的事件：+1 / -1

@Component
public class LikeCountConsumer implements ConsumerSeekAware {

    private final CounterStore store;
    private final CounterCache cache;

    public LikeCountConsumer(CounterStore store, CounterCache cache) {
        this.store = store;
        this.cache = cache;
    }

    @Override
    public void onPartitionsAssigned(Map<TopicPartition, Long> assignments, ConsumerSeekCallback callback) {
        // 以数据库里的位点为准：分到分区后从「已落库位点 + 1」开始消费
        assignments.keySet().forEach(tp -> callback.seek(tp.topic(), tp.partition(), store.loadOffset(tp) + 1));
    }

    @KafkaListener(topics = "like-count-event", groupId = "counter", batch = "true")
    public void onBatch(List<ConsumerRecord<String, CountEvent>> records) {
        Map<TopicPartition, List<ConsumerRecord<String, CountEvent>>> byPartition = records.stream()
                .collect(Collectors.groupingBy(r -> new TopicPartition(r.topic(), r.partition())));
        byPartition.forEach((tp, list) -> {
            Map<Long, Long> applied = store.applyBatch(tp, list);   // 一个本地事务
            cache.applyDelta(applied);                              // 提交之后才改 Redis
        });
    }
}

@Repository
public class CounterStore {

    private static final String OFFSET_SQL =
            "SELECT committed_offset FROM consumer_offset WHERE topic = ? AND part = ?";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public CounterStore(JdbcTemplate jdbc, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.tx = tx;
    }

    public long loadOffset(TopicPartition tp) {
        return jdbc.queryForObject(OFFSET_SQL, Long.class, tp.topic(), tp.partition());
    }

    public Map<Long, Long> applyBatch(TopicPartition tp, List<ConsumerRecord<String, CountEvent>> records) {
        return tx.execute(status -> {
            long done = jdbc.queryForObject(OFFSET_SQL + " FOR UPDATE", Long.class, tp.topic(), tp.partition());
            Map<Long, Long> delta = new HashMap<>();
            long last = done;
            for (ConsumerRecord<String, CountEvent> r : records) {
                if (r.offset() <= done) continue;                    // 重放的消息：已经计过
                delta.merge(r.value().targetId(), (long) r.value().delta(), Long::sum);
                last = Math.max(last, r.offset());
            }
            if (last == done) return Map.<Long, Long>of();
            delta.values().removeIf(d -> d == 0);                   // 一批内先赞后取消，相互抵消
            delta.forEach((id, d) -> jdbc.update("""
                    INSERT INTO counter (target_id, like_cnt, update_time) VALUES (?, ?, NOW(6))
                    ON DUPLICATE KEY UPDATE like_cnt = like_cnt + ?, update_time = NOW(6)
                    """, id, d, d));
            jdbc.update("UPDATE consumer_offset SET committed_offset = ? WHERE topic = ? AND part = ?",
                    last, tp.topic(), tp.partition());
            return delta;
        });
    }
}
```

- **合并写**：一个爆款每秒 1 万次点赞，按 500 条一批消费、一批合并成一次 `UPDATE`，数据库这一行的写入从每秒 1 万次降到每秒 20 次；同一对象的事件只在一个分区里，不同分区不会争同一行锁
- **去重**：去重依据是 Kafka 分区内单调递增的 offset，和计数在同一事务提交，重放时直接跳过；这是「去重记录与业务写入同事务」的一种形式，通用方案见 [消息队列基础](/messaging/1_basics)（幂等消费一节）
- **失败重试**：事务失败整体回滚，位点不前进，交给 Spring Kafka 的错误处理器重试整批，多次失败进入死信 Topic 并告警

### 4、更新 Redis：只在 key 存在时加

```java
// CounterCache（@Component，注入 StringRedisTemplate redis）
// key 不存在时不能 HINCRBY：否则会建出一个只有本次增量的 Hash，计数从 0 开始
private static final RedisScript<Long> HINCR_IF_EXISTS = RedisScript.of("""
        if redis.call('EXISTS', KEYS[1]) == 1 then
          return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
        end
        return false
        """, Long.class);

public void applyDelta(Map<Long, Long> delta) {
    delta.forEach((id, d) -> {
        String key = "cnt:" + id;
        try {
            redis.execute(HINCR_IF_EXISTS, List.of(key), "like", String.valueOf(d));
        } catch (RuntimeException e) {
            try {
                redis.delete(key);                 // 加不上就删掉，下次读取从计数表重建
            } catch (RuntimeException ignored) {
                // Redis 整体不可用：依赖 TTL 与对账收敛
            }
        }
    });
}
```

- 计数表是持久化副本，Redis 是缓存：先提交数据库，再改缓存；改不了就删，和 [缓存一致性](/cache/10_cache_consistency) 中「先更新数据库再删缓存」的思路一致
- 用增量而不是每次删除：热门对象每秒都在变，每批都删缓存会让读请求反复回源；增量加在已有值上，只要 key 存在就和计数表同步前进
- 仍有极小的竞态（读请求回源的同时消费者提交了新增量），偏差最多维持到 key 过期或下一次对账

---

## 五、阅读数：Redis 先计，定时刷盘

阅读数没有明细，量又是点赞的几十倍，不值得每次写关系表。做法是 **Redis 累加绝对值，刷盘任务定时把绝对值写回计数表**：

```java
// ViewCounter（@Service，注入 StringRedisTemplate redis 与 CounterMapper counterMapper）
private static final Duration TTL = Duration.ofDays(3);
private static final int DIRTY_SHARDS = 16;

private static final RedisScript<Long> INCR_IF_EXISTS = RedisScript.of("""
        if redis.call('EXISTS', KEYS[1]) == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
          return redis.call('INCR', KEYS[1])
        end
        return false
        """, Long.class);

public void incr(long id) {
    String key = "view:" + id;
    Long v = redis.execute(INCR_IF_EXISTS, List.of(key), String.valueOf(TTL.toSeconds()));
    if (v == null) {                                       // key 不存在：先装入库里的基数
        long base = counterMapper.selectViewCount(id);
        redis.opsForValue().setIfAbsent(key, String.valueOf(base), TTL);
        redis.opsForValue().increment(key);
    }
    // 记录脏对象，刷盘任务只处理变化过的对象
    redis.opsForSet().add("view:dirty:" + Math.floorMod(id, DIRTY_SHARDS), String.valueOf(id));
}
```

刷盘任务每分钟执行一次：从 16 个脏集合里分批 `SPOP`，读出当前值，批量执行：

```sql
UPDATE counter SET view_cnt = GREATEST(view_cnt, ?), update_time = NOW(6) WHERE target_id = ?;
```

- **写绝对值而不是增量**：同一个值写两次结果一样，刷盘任务重跑、多实例重复刷都不会多加，不需要额外的去重记录
- **`GREATEST` 防回退**：阅读数只增不减，Redis 主从切换丢了最近几次写入、或者旧快照晚到时，库里的值不会被改小
- **能丢多少**：`SPOP` 之后、写库之前进程崩溃，这批对象要等下一次被阅读才会重新进入脏集合；Redis 主从切换会丢失切换前尚未同步的少量写入。阅读数允许这类小偏差，没有明细也无法对账
- 同一用户短时间内反复刷新只算一次，可以在入口用 `SET view:seen:<user>:<id> 1 NX EX 1800` 过滤；要统计独立访客数（UV）用 HyperLogLog

---

## 六、热点计数分片

![热点计数分桶](../assets/scenario/counter-bucket.svg)

点赞、评论、粉丝数经过消费者合并后已经没有写热点；阅读数是每次请求直接写 Redis，一个爆款视频每秒 20 万次阅读会全部落到一个 key 所在的分片上，超出单分片约 10 万次/秒的处理能力。办法是**把一个 key 拆成多个桶，写入随机选一个，读取时求和**：

```java
public void incrHot(long id, int buckets) {
    int b = ThreadLocalRandom.current().nextInt(1, buckets + 1);
    String key = "view:" + id + ":" + b;          // 不要用 {id} 这种 hash tag，否则所有桶落进同一个槽
    redis.opsForValue().increment(key);
    redis.expire(key, TTL);
    redis.opsForSet().add("view:dirty:" + Math.floorMod(id, DIRTY_SHARDS), String.valueOf(id));
}

public long readHot(long id, int buckets) {
    List<String> keys = new ArrayList<>(buckets + 1);
    keys.add("view:" + id);                        // 基数：成为热点之前累计的值
    for (int b = 1; b <= buckets; b++) {
        keys.add("view:" + id + ":" + b);
    }
    // Cluster 模式下 Spring Data Redis 会把跨槽的 MGET 拆成按节点的请求
    return redis.opsForValue().multiGet(keys).stream()
            .filter(Objects::nonNull).mapToLong(Long::parseLong).sum();
}
```

- **只对热点对象分桶**：热点名单由热点探测产生，并通过配置中心下发到所有实例，探测方式见 [热点问题](/high-con/6_hotspot)；分桶数按峰值除以单分片可承受的写入量估算，20 万 ÷ 2.5 万 = 8 个桶
- **基数 key 冻结**：对象进入热点名单时对 `view:<id>` 执行 `PERSIST` 去掉 TTL，此后新增阅读只进桶。个别实例还没收到名单、仍然加在基数上也没关系，总数始终是「基数 + 全部桶」
- **读的代价**：一次读变成 N+1 次 key 访问，所以热点对象的读结果一定要加本地缓存（见第七节），不然读放大会比写热点更严重
- 刷盘任务对热点对象同样先求和再按绝对值写库；对象冷却后（如一天没进热点名单），由后台任务把各桶合并回基数、恢复 TTL

---

## 七、读路径缓存与降级

Feed 页一次展示 20 条内容，每条要点赞、评论、阅读三个数，读接口必须是**批量**的：

```java
public record Counts(long like, long comment, long view) {
    public static final Counts HIDDEN = new Counts(-1, -1, -1);   // 前端遇到 -1 不展示数字
}

public Map<Long, Counts> batchGet(List<Long> ids) {
    // hotLocal：Caffeine，maximumSize(100_000)、expireAfterWrite(1 秒)，只放热点对象
    Map<Long, Counts> result = new HashMap<>(hotLocal.getAllPresent(ids));
    List<Long> missing = ids.stream().filter(id -> !result.containsKey(id)).toList();
    if (missing.isEmpty()) return result;
    try {
        // pipeline 批量 HMGET cnt:<id> 与 GET view:<id>，未命中的从计数表重建
        redisLoader.load(missing).forEach((id, c) -> {
            result.put(id, c);
            if (hotKeys.isHot(id)) hotLocal.put(id, c);
        });
    } catch (RuntimeException e) {
        missing.forEach(id -> result.putIfAbsent(id, Counts.HIDDEN));   // 降级：不展示数字
    }
    return result;
}
```

| 故障 | 处理 |
|------|------|
| Redis 单分片超时 | 读取设 50 ms 左右超时，超时的对象返回 `HIDDEN`，页面不显示数字，其余内容正常 |
| Redis 整体不可用 | 熔断后不回源计数表（数据库扛不住 Feed 的读量），全部返回 `HIDDEN`；核心详情页可限流回源 |
| 计数表回源慢 | 同一对象同时只回源一次，并做限流 |

- 计数是展示数据，「1.2 万」与「1.2 万零 3」用户看不出差别，所以 1 秒本地缓存、几秒延迟都可以接受；**拿不到时宁可不显示，也不要显示 0**，显示 0 会让用户以为数据被清空了
- 降级开关与分级见 [降级](/high-avail/6_degradation)，回源限流见 [限流与过载保护](/high-avail/7_rate_limiting)，本地缓存与 Redis 两级缓存的组合见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)

---

## 八、点赞关系查询与大 V 场景

### 1、「是否已赞」怎么查

Feed 页每条内容都要显示自己是否已赞，即一次查 20 个 `(userId, targetId)` 组合。按对象维护 Set 在大 V 场景下会失控：一条 500 万赞的内容，Set 使用哈希表编码，每个成员按约 60 B 估算，单个 key 就是 300,000,000 B ≈ 286 MB，读写都会阻塞分片。

更实用的是**按用户维度缓存**：

| 层次 | 做法 |
|------|------|
| 用户最近点赞 | `liked:<userId>` 用 ZSet 存最近 1000 次点赞的对象 ID（score 为时间），Feed 里的内容大多是近期的，命中率高 |
| 判断完整性 | ZSet 元素数小于 1000 说明这是该用户的全部点赞，未命中即「未赞」；达到 1000 则未命中的对象再查库 |
| 回查关系表 | `SELECT target_id FROM like_record WHERE user_id = ? AND target_id IN (...)`，关系表按 `user_id` 分片，只查一个分片且走唯一索引 |
| 缓存更新 | 点赞、取消点赞后删除 `liked:<userId>`，下次读取重建；主从延迟导致重建到旧数据的处理见 [缓存一致性](/cache/10_cache_consistency) |

### 2、大 V 的几个特殊点

- **涨粉 / 点赞洪峰**：明星官宣时每秒几万次关注，关系表写入分散在不同用户的分片上，没有行锁热点；计数通过消费者合并，粉丝数这一行每批只更新一次
- **布隆过滤器快速判断**：对少量超大对象可以额外维护一个布隆过滤器，500 万元素、1% 误判率约需 500 万 × 9.6 bit ÷ 8 = 6,000,000 B ≈ 5.7 MB；「肯定没赞」直接返回，「可能赞了」再走上面的查询。取消点赞无法从布隆过滤器中删除，只会增加误判，不影响正确性
- 大 V 发内容引起的写扩散问题见 [Feed 流](./8_feed_stream)

---

## 九、数据校准

消费者 bug、Redis 回源竞态、手工修数都会让计数表与关系表出现偏差。有关系记录的计数可以定期**按关系表重算并修正**；阅读数没有明细，不做对账。

难点是校准时数据还在变：重算时刻关系表里的数量，与计数表里尚未消费完的增量不能直接比较。做法是**只修正静默对象，并用 CAS 更新**：

1. 选出最近一天有过变化、但 10 分钟内没有变化的对象：`SELECT target_id, like_cnt, update_time FROM counter WHERE update_time BETWEEN NOW() - INTERVAL 1 DAY AND NOW() - INTERVAL 10 MINUTE`，记下每个对象的 `like_cnt` 与 `update_time`
2. 在按 `target_id` 分片的关系副本上重算：`SELECT COUNT(*) FROM like_record_by_target WHERE target_id = ?`，记下重算时刻 T
3. 等计数消费者的水位越过 T（已处理的最新事件的提交时间晚于 T）
4. 条件修正：`UPDATE counter SET like_cnt = ?, update_time = NOW(6) WHERE target_id = ? AND update_time = ?`，然后删除 `cnt:<id>`

- 第 4 步的条件是 `update_time` 没变：如果第 1 步之后该对象又有事件被消费，`update_time` 会变化，这次修正自动放弃，下一轮再说；条件成立说明 T 之前的事件都已计入且之后没有新事件，两边可以比较
- 重算大 V 内容的 `COUNT(*)` 要扫几百万行索引，放在低峰期分批执行；差异超过阈值（如 1%）时告警，说明链路有 bug，不能只靠校准掩盖
- 对账的通用做法与告警设计见 [秒杀](./4_seckill)（对账一节）

---

## 十、存储成本与容量估算

假设：内容总量 10 亿，近 30 天活跃 1 亿；日均点赞 2 亿次；DAU 1 亿、人均阅读 100 次。1 GB 按 1024³ B 计；每个 key 的实际占用以 `MEMORY USAGE` 抽样为准，下面是估算方法。

**存储**：

| 数据 | 计算 | 结果 |
|------|------|------|
| Redis 计数（只放活跃对象） | 每个 key 约 150 B（key 名、listpack 编码的 3 个字段、对象头与分配器开销）；1 亿 × 150 B = 1.5 × 10¹⁰ B | 约 14 GB，一主一从约 28 GB，8 个主分片每片约 1.75 GB |
| MySQL 计数表（全量对象） | 每行约 60 B；10 亿 × 60 B = 6 × 10¹⁰ B | 约 56 GB |
| 点赞关系表 | 每行含唯一索引约 100 B；2 亿 × 100 B = 2 × 10¹⁰ B/天 | 约 18.6 GB/天，一年约 6.6 TB，需要分库分表；按 `target_id` 的副本再加一份 |
| 布隆过滤器（每个大 V 对象） | 500 万 × 9.6 bit ÷ 8 | 约 5.7 MB |

**写入 QPS**：

| 链路 | 计算 | 结果 |
|------|------|------|
| 点赞写关系表 | 2 亿 ÷ 86,400 ≈ 2,315 次/秒，峰值按 5 倍 | 约 1.16 万次/秒，16 个分库每库约 723 次/秒 |
| 阅读数写 Redis | 1 亿 × 100 = 100 亿次/天，100 亿 ÷ 86,400 ≈ 11.6 万次/秒，峰值按 3 倍 | 约 34.7 万次/秒，每次 `INCR` + `SADD` 两条命令，约 69.4 万条命令/秒 |
| Redis 阅读分片 | 694,000 ÷ 16 | 16 个分片每片约 4.3 万条命令/秒 |
| 计数表更新（点赞） | 合并后每批每对象一次；设峰值 1.16 万次/秒的事件分布在 3,000 个对象上 | 每秒最多约 3,000 条 `UPDATE`，与点赞量脱钩 |

**读取 QPS**：Feed 峰值 20 万次/秒 × 每页 20 条 = 400 万次对象计数读取/秒。热点本地缓存命中 50% 后剩 200 万次/秒，分到 16 个分片每片 12.5 万次/秒，借助 pipeline 可以承受但余量不大，扩到 32 个分片后每片约 6.3 万次/秒。单分片能力以压测为准，峰值预估方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 有关系的计数（点赞、评论、粉丝）以关系表为准，唯一约束去重；计数是派生值，通过 CDC 从已提交的 binlog 异步产生，业务代码不在事务里发 MQ
- 计数消费者按对象合并增量，位点和计数在同一个本地事务提交，重放的消息直接跳过；提交后 Redis 只在 key 存在时加增量，失败就删 key
- 阅读数在 Redis 累加绝对值，刷盘用 `GREATEST` 写绝对值，可重复执行；热点对象分桶写入、求和读取，并配合本地缓存
- 读接口批量、热点 1 秒本地缓存，Redis 故障时不显示数字而不是显示 0，也不把读量放给数据库
- 「是否已赞」按用户维度缓存最近点赞，不为大 V 维护巨型 Set；大对象可加布隆过滤器
- 定期对账只修正静默对象，用 `update_time` 做 CAS，避免和在途增量冲突；偏差超阈值要告警查原因

## 参考资料

- Redis INCR 命令（含计数器模式说明）：[https://redis.io/docs/latest/commands/incr/](https://redis.io/docs/latest/commands/incr/)
- Redis 内存优化（Hash 的紧凑编码）：[https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- Redis Cluster 规范（hash tag 与槽）：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- Kafka 消费者 API（在外部存储中保存位点）：[https://kafka.apache.org/documentation/#consumerapi](https://kafka.apache.org/documentation/#consumerapi)
- Spring for Apache Kafka 位点定位（ConsumerSeekAware）：[https://docs.spring.io/spring-kafka/reference/kafka/seek.html](https://docs.spring.io/spring-kafka/reference/kafka/seek.html)
- Debezium MySQL Connector：[https://debezium.io/documentation/reference/stable/connectors/mysql.html](https://debezium.io/documentation/reference/stable/connectors/mysql.html)

> 下一篇：[扫码登录](./18_qr_login) —— 二维码状态机、Lua 原子迁移、长轮询通知、PC 会话换发与防钓鱼。

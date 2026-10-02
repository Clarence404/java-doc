---
description: 热点 key 探测与治理、热点行更新（库存扣减）、分桶库存、合并更新、热点隔离
---

# 热点问题

> **本篇目标**：掌握热点的"探测 → 分散 → 隔离"三板斧，能针对读热点、写热点、相同请求洪峰分别选出合适方案。
>
> **前置阅读**：[数据层扩展](./5_data_scaling)
>
> **参考链接**：[京东 hotkey](https://gitee.com/jd-platform-opensource/hotkey) · [有赞透明多级缓存 TMC](https://tech.youzan.com/tmc/) · [Sentinel 热点参数限流](https://sentinelguard.io/zh-cn/docs/parameter-flow-control.html)

水平扩展解决的是"总量大"，对"**流量集中**"无效：一个爆款商品的 10w QPS 只会落到 Redis 集群的某一个分片、数据库的某一行上，加再多机器也无济于事。热点治理的核心思路是**探测 → 分散 → 隔离**。

| 热点类型 | 表现 | 瓶颈点 |
|----------|------|--------|
| 热点 key（读） | 单个 Redis key 每秒被读数万次 | 单分片 CPU / 网卡带宽打满 |
| 热点行（写） | 单行记录被高并发更新（库存、余额、计数） | InnoDB 行锁排队，TPS 跌到几百 |
| 热点请求 | 大量相同请求同时到达（同一商品详情） | 重复计算、重复回源 |
| 热点租户 / 业务 | 大客户、大促活动流量远超其他 | 挤占共享资源，影响其他业务 |

---

## 一、热点 key 探测

**可预知的热点提前预热，突发热点靠实时探测，事后排查靠 Redis 工具。** 三者覆盖的时机不同，生产上通常组合使用。

| 热点来源 | 例子 | 手段 |
|---------|------|------|
| 可预知 | 活动商品、首页配置 | 活动前预热到 Redis 与本地缓存，见 [缓存架构设计](./3_cache_architecture) |
| 突发 | 突发新闻、明星同款 | 实时探测 + 自动晋升本地缓存（本节） |
| 事后排查 | 线上某分片 CPU 异常 | `redis-cli --hotkeys`、云 Redis 热点分析、慢日志 |

### 1、探测方式对比

| 方式 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 客户端统计 | 应用内滑动窗口统计 key 访问次数 | 实现简单、无额外组件 | 单机视角，全局热点被分散到多实例后可能漏判 |
| 代理层统计 | Twemproxy / Codis / 自研 Proxy 统计 | 全局视角 | 需要代理层 |
| Redis 自带 | `redis-cli --hotkeys`（需 `maxmemory-policy` 为 LFU 类策略）、`MONITOR` | 无需改代码 | 离线分析；`MONITOR` 严重影响性能，生产慎用 |
| 集中式探测 | 客户端上报访问 → 计算集群汇总 → 推送热点列表 | 全局准确、秒级 | 需部署独立组件 |

### 2、集中式探测：JD-hotkey 的思路

JD-hotkey 是集中式探测的典型实现：

1. **客户端 SDK**：在应用内对每次 key 访问做本地计数，每 500ms 批量上报给 Worker
2. **Worker 集群**：按 key 哈希分配，滑动窗口统计（如 1s 内访问 > 1000 次即判定为热点）
3. **推送**：Worker 通过长连接把热点 key 推送给**所有**应用实例
4. **本地缓存**：应用收到推送后把该 key 的值缓存到 JVM 本地，后续请求直接命中本地，不再访问 Redis
5. **自动过期**：热度下降后本地缓存到期自动淘汰

从探测到全集群生效通常在 1 秒内，可以扛住突发热点对单个 Redis 分片的冲击。

### 3、客户端简易统计

没有集中式组件时，可以先在单机做近似统计，访问次数超阈值就晋升到本地缓存：

```java
/** 基于 Caffeine 的单机热点统计：约 1 秒窗口内访问超阈值即判定为热点 */
public class HotKeyDetector {

    private static final int THRESHOLD = 500;

    private final Cache<String, LongAdder> counter = Caffeine.newBuilder()
            .expireAfterWrite(1, TimeUnit.SECONDS)   // 写入 1 秒后过期，近似滚动窗口
            .maximumSize(100_000)
            .build();

    public boolean isHot(String key) {
        LongAdder adder = counter.get(key, k -> new LongAdder());
        adder.increment();
        return adder.sum() >= THRESHOLD;
    }
}
```

阈值按"单实例 QPS × 该 key 占比"估算，并结合实例数：100 个实例时，全局 5 万 QPS 的热点在单机只有约 500 QPS。

---

## 二、读热点治理

**读热点的首选是本地缓存，其次是多副本打散，再往前可以推到 Nginx / CDN。**

### 1、本地缓存兜底

把热点 key 缓存到每个应用实例的 JVM 内：100 个实例各自缓存一份，Redis 只需承担"每实例每个 TTL 周期一次"的回源。

```java
public ItemDTO getItem(Long itemId) {
    String key = "item:" + itemId;
    // 1. 热点 key 先查本地缓存（短 TTL，如 3 秒，接受短暂不一致）
    if (hotKeyDetector.isHot(key)) {
        return hotLocalCache.get(key, k -> loadFromRedis(k));
    }
    // 2. 非热点走 Redis
    return loadFromRedis(key);
}
```

### 2、key 打散（多副本）

无法使用本地缓存时（需要较强一致性、实例数少），把一个热 key 复制为 N 个副本，分布到不同分片：

```java
private static final int REPLICAS = 8;

// 写：更新所有副本
public void setHot(String key, String value, long ttlSeconds) {
    for (int i = 0; i < REPLICAS; i++) {
        redis.opsForValue().set(key + "#" + i, value, ttlSeconds, TimeUnit.SECONDS);
    }
}

// 读：随机读一个副本，流量均摊到多个分片
public String getHot(String key) {
    int idx = ThreadLocalRandom.current().nextInt(REPLICAS);
    return redis.opsForValue().get(key + "#" + idx);
}
```

- Redis Cluster 按 key 计算槽位，`item:1#0`、`item:1#1` 大概率落到不同槽，但不保证；可用 `CLUSTER KEYSLOT` 校验后缀是否分散到不同节点
- **不能**使用 `{item:1}#0` 这种 hash tag 写法，否则所有副本仍在同一分片
- 代价：写放大 N 倍，且副本之间在更新瞬间可能短暂不一致

### 3、其他手段

| 手段 | 说明 |
|------|------|
| Redis 读从节点 | 从节点分担读；Cluster 模式需客户端开启从节点读，如 Lettuce `ReadFrom.REPLICA_PREFERRED` |
| 大 value 拆分 | 热点同时是大 key 时，拆成多个小 key 或压缩，降低带宽 |
| 前置到 Nginx / CDN | 千人一面的热点数据直接在接入层返回，见 [接入层架构](./1_access_layer) |

---

## 三、写热点：热点行更新

**秒杀、抢购场景下所有请求都要更新同一行库存，这是最典型的写热点。** 思路是把行锁排队移到更快的地方（Redis），或者把一行拆成多行、多次更新合成一次。

### 1、数据库行锁排队

```sql
UPDATE t_stock SET stock = stock - 1 WHERE item_id = 1001 AND stock > 0;
```

语句本身能防超卖，但 InnoDB 对同一行的更新必须串行：每个事务持有行锁直到提交，并发越高，锁等待与死锁检测开销越大，单行 TPS 通常只有**几百**。适合并发不高的普通商品。

### 2、Redis 预扣 + 异步落库

把库存预加载到 Redis，用 Lua 保证"判断 + 扣减"原子执行，扣减成功后发 MQ 异步落库：

```lua
-- KEYS[1] = stock:{itemId}, KEYS[2] = bought:{itemId}（已购用户集合）
-- ARGV[1] = userId, ARGV[2] = 购买数量
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return -2                                  -- 重复购买
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
local num = tonumber(ARGV[2])
if stock < num then
    return -1                                  -- 库存不足
end
redis.call('DECRBY', KEYS[1], num)
redis.call('SADD', KEYS[2], ARGV[1])
return stock - num
```

```java
Long result = redis.execute(DEDUCT_SCRIPT,
        List.of("stock:{" + itemId + "}", "bought:{" + itemId + "}"),   // hash tag 保证两个 key 同槽
        String.valueOf(userId), "1");
if (result != null && result >= 0) {
    mqProducer.send("stock-deduct", new DeductMsg(itemId, userId, 1));  // 消费端幂等落库
}
```

**要点**：DB 最终更新由 MQ 匀速完成；需要对账任务核对 Redis 与 DB 的库存，处理 MQ 发送失败、订单超时未支付回补等情况。完整方案见 [秒杀系统设计](/scenario/4_seckill)。

### 3、分桶库存

单个 Redis key 仍有上限（单分片单线程）。把库存拆成 N 个桶，分布到不同分片：

| 步骤 | 做法 |
|------|------|
| 初始化 | 库存 10000 拆成 10 个桶：`stock:1001:0` ~ `stock:1001:9`，每桶 1000 |
| 扣减 | 按 `userId % 10` 选桶；桶库存不足时尝试下一个桶 |
| 售罄判断 | 维护一个"已售罄桶数"，全部售罄才返回售罄 |
| 数据库侧 | 同样可以把一行库存拆成 N 行（`item_id + bucket_no`），分散行锁 |

代价：可能出现"其他桶还有库存但当前桶已空"的误判，需要遍历或定期再平衡。

### 4、合并更新（写合并）

**对不需要逐条精确的计数类热点（浏览量、点赞数），把多次更新合并成一次。**

```java
/** 点赞计数：内存聚合 1 秒后批量写 DB，1 万次/秒的更新变成 1 次/秒 */
@Component
public class LikeCounter {

    private final ConcurrentHashMap<Long, LongAdder> buffer = new ConcurrentHashMap<>();

    public void incr(Long postId) {
        buffer.computeIfAbsent(postId, k -> new LongAdder()).increment();
    }

    @Scheduled(fixedDelay = 1000)
    public void flush() {
        for (Long postId : buffer.keySet()) {
            LongAdder adder = buffer.remove(postId);
            long delta = adder == null ? 0 : adder.sum();
            if (delta > 0) {
                postMapper.incrLikeCount(postId, delta);   // UPDATE ... SET like_count = like_count + ?
            }
        }
    }
}
```

- `remove` 之后仍可能有线程在旧 `LongAdder` 上累加，丢失少量计数；要求精确时改用 Redis `INCRBY` 聚合再定期落库
- 宕机会丢失缓冲区数据，需权衡缓冲时长
- 数据库层面也有类似思路：部分云数据库（如阿里云 RDS 的热点行更新优化）在引擎层把同一行的并发更新合并提交

读写扩散（Feed 流的推 / 拉模式）也是一类热点问题：大 V 发帖时写扩散会瞬间产生海量写入，通常对大 V 改用读扩散，见 [Feed 流系统](/scenario/8_feed_stream)。

---

## 四、热点请求：Single Flight

**大量相同请求同时到达时，只让一个请求真正执行，其余等待共享结果**，这是防缓存击穿的通用手段：

```java
public class SingleFlight<K, V> {

    private final ConcurrentHashMap<K, CompletableFuture<V>> inFlight = new ConcurrentHashMap<>();

    public V execute(K key, Supplier<V> loader) {
        CompletableFuture<V> future = new CompletableFuture<>();
        CompletableFuture<V> existing = inFlight.putIfAbsent(key, future);
        if (existing != null) {
            return existing.join();                    // 已有请求在执行，等待其结果
        }
        try {
            V value = loader.get();
            future.complete(value);
            return value;
        } catch (Throwable e) {
            future.completeExceptionally(e);
            throw e;
        } finally {
            inFlight.remove(key, future);              // 执行完即移除，后续请求重新加载
        }
    }
}
```

- Single Flight 合并的是**相同 key** 的并发请求，回源次数降为 1；代价是失败时所有等待者一起失败，等待方应设置超时
- 把窗口内**不同 key** 的请求合并为一次批量查询（`MGET`、`WHERE id IN (...)`）属于请求合并 / 批量化，实现见 [异步与批量](/high-perf/8_async_batch)

---

## 五、热点隔离

**即使做了上述优化，热点流量仍可能挤占共享资源。隔离的目标是热点出问题只影响热点自己。**

| 隔离层级 | 做法 |
|----------|------|
| 集群隔离 | 秒杀 / 大促活动使用独立的服务集群、独立 Redis 集群、独立库 |
| 线程池隔离 | 热点接口使用独立线程池，满了只拒绝热点请求 |
| 数据隔离 | 热点商品的库存单独存放（独立库表或独立 Redis 实例） |
| 流量隔离 | 网关层按商品 / 租户维度做热点参数限流（Sentinel 热点参数规则） |

```java
// Sentinel 热点参数限流：按 itemId 维度，单个商品每秒最多 5000 次，爆款 1001 单独放宽到 20000
ParamFlowRule rule = new ParamFlowRule("getItemDetail")
        .setParamIdx(0)                  // 第 0 个参数 itemId
        .setGrade(RuleConstant.FLOW_GRADE_QPS)
        .setCount(5000);
ParamFlowItem hot = new ParamFlowItem().setObject("1001").setClassType(Long.class.getName()).setCount(20000);
rule.setParamFlowItemList(List.of(hot));
ParamFlowRuleManager.loadRules(List.of(rule));
```

线程池隔离与舱壁模式见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)，限流算法见 [限流与过载保护](/high-avail/7_rate_limiting)，Sentinel 规则持久化见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba)。

---

## 六、方案选型

| 场景 | 推荐方案 |
|------|----------|
| 读热点，允许秒级不一致 | 热点探测 + 本地缓存 |
| 读热点，一致性要求较高 | key 多副本打散 + 写时全量更新 |
| 写热点，库存类精确扣减 | Redis Lua 预扣 + MQ 异步落库 + 对账；超高并发加分桶 |
| 写热点，计数类 | 内存 / Redis 合并更新，定期落库 |
| 大量相同读请求 | Single Flight |
| 活动流量远超日常 | 独立集群 + 热点参数限流 |

---

## 小结

- 热点是"流量集中"问题，加机器无效，按**探测 → 分散 → 隔离**治理
- 探测分三种时机：可预知热点预热、突发热点实时探测（集中式最准）、事后用 `--hotkeys` 排查
- 读热点首选本地缓存，其次多副本打散（不能用 hash tag）；写热点用 Redis 预扣、分桶、写合并
- 相同请求洪峰用 Single Flight 防击穿；不同 key 的批量合并见高性能模块
- 最后一道防线是隔离：独立集群、独立线程池、热点参数限流

> 下一篇：[并发参数调优](./7_concurrency_tuning) —— 架构层面理顺之后，还要让线程池、Web 容器、连接池、OS 参数与流量逐级匹配。

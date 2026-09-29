# 热点问题

> 参考链接：[京东 hotkey](https://gitee.com/jd-platform-opensource/hotkey) · [Sentinel 热点参数限流](https://sentinelguard.io/zh-cn/docs/parameter-flow-control.html)

水平扩展解决的是"总量大"，但对"**流量集中**"无效：一个爆款商品的 10w QPS 只会落到 Redis 集群的某一个分片、数据库的某一行上，加再多机器也无济于事。热点治理的核心思路是**探测 → 分散 → 隔离**。

| 热点类型 | 表现 | 瓶颈点 |
|----------|------|--------|
| 热点 key（读） | 单个 Redis key 每秒被读数万次 | 单分片 CPU / 网卡带宽打满 |
| 热点行（写） | 单行记录被高并发更新（库存、余额、计数） | InnoDB 行锁排队，TPS 跌到几百 |
| 热点请求 | 大量相同请求同时到达（同一商品详情） | 重复计算、重复回源 |
| 热点租户 / 业务 | 大客户、大促活动流量远超其他 | 挤占共享资源，影响其他业务 |

---

## 一、热点 key

### 1、探测

- **可预知热点**：活动商品、首页配置 —— 提前预热到本地缓存
- **突发热点**：实时探测，方式包括客户端统计、代理层统计、集中式探测（JD-hotkey），见 [缓存架构设计 - 热点 key 探测](/high-con/2_cache_architecture)
- **事后排查**：`redis-cli --hotkeys`（需 `maxmemory-policy` 为 LFU）、云 Redis 热点分析、慢日志

### 2、本地缓存兜底

最有效的手段：把热点 key 缓存到每个应用实例的 JVM 内。100 个实例各自缓存一份，Redis 只需承担每实例每个 TTL 周期一次的回源。

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

### 3、key 打散（多副本）

无法使用本地缓存时（如需要较强一致性、实例数少），把一个热 key 复制为 N 个副本，分布到不同分片：

```java
private static final int REPLICAS = 8;

// 写：更新所有副本
public void setHot(String key, String value, long ttlSeconds) {
    for (int i = 0; i < REPLICAS; i++) {
        redis.opsForValue().set(key + "#" + i, value, ttlSeconds, TimeUnit.SECONDS);
    }
}

// 读：随机读一个副本，流量均摊到 8 个分片
public String getHot(String key) {
    int idx = ThreadLocalRandom.current().nextInt(REPLICAS);
    return redis.opsForValue().get(key + "#" + idx);
}
```

注意：Redis Cluster 按 key 计算槽位，`item:1#0` 与 `item:1#1` 会分布到不同槽，但**不能**使用 `{item:1}#0` 这种 hash tag 写法，否则所有副本仍在同一分片。

### 4、其他手段

| 手段 | 说明 |
|------|------|
| 读写分离 | Redis 从节点分担读（注意 Cluster 模式下需客户端开启从节点读，如 Lettuce `ReadFrom.REPLICA_PREFERRED`） |
| 大 value 拆分 | 热点同时是大 key 时，拆成多个小 key 或压缩，降低带宽 |
| 前置到 Nginx / CDN | 千人一面的热点数据直接在接入层返回 |

---

## 二、热点行更新（库存扣减）

秒杀、抢购场景下，所有请求都要更新同一行库存，这是最典型的写热点。

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

**要点**：Redis 单 key 可达数万 QPS；DB 最终更新由 MQ 匀速完成；需要对账任务核对 Redis 与 DB 的库存，处理 MQ 发送失败、订单超时未支付回补等情况。完整方案见 [秒杀系统设计 - 库存处理](/scenario/4_seckill)。

### 3、分桶库存

单个 Redis key 仍有上限（单分片单线程）。把库存拆成 N 个桶，分布到不同分片：

| 步骤 | 做法 |
|------|------|
| 初始化 | 库存 10000 拆成 10 个桶：`stock:1001:0` ~ `stock:1001:9`，每桶 1000 |
| 扣减 | 按 `userId % 10` 选桶；桶库存不足时尝试下一个桶 |
| 售罄判断 | 维护一个"已售罄桶数"，全部售罄才返回售罄 |
| 数据库侧 | 同样可以把一行库存拆成 N 行（`item_id + bucket_no`），分散行锁 |

代价：可能出现"其他桶还有库存但当前桶已空"导致的误判，需要遍历或定期再平衡。

### 4、合并更新

对不需要逐条精确的计数类热点（浏览量、点赞数、账户流水汇总），把多次更新**合并**成一次：

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

`remove` 之后仍可能有线程在旧 `LongAdder` 上累加，丢失少量计数；对计数类数据可接受，要求精确时改用 Redis `INCRBY` 聚合再定期落库。宕机会丢失缓冲区数据，需权衡缓冲时长。

数据库层面也有类似思路：阿里云 RDS / AliSQL 的热点行更新优化（Inventory Hint）会在引擎层把同一行的并发更新合并为组提交。

---

## 三、请求合并

大量**相同**请求同时到达时，只让一个请求真正执行，其余等待共享结果（Single Flight）：

```java
public class SingleFlight<K, V> {

    private final ConcurrentHashMap<K, CompletableFuture<V>> inFlight = new ConcurrentHashMap<>();

    public V execute(K key, Supplier<V> loader) {
        CompletableFuture<V> future = new CompletableFuture<>();
        CompletableFuture<V> existing = inFlight.putIfAbsent(key, future);
        if (existing != null) {
            return existing.join();                    // 已有请求在执行，等待结果
        }
        try {
            V value = loader.get();
            future.complete(value);
            return value;
        } catch (Throwable e) {
            future.completeExceptionally(e);
            throw e;
        } finally {
            inFlight.remove(key, future);
        }
    }
}
```

另一种是**批量合并**：把短时间窗口（如 10ms）内的 N 个不同 key 查询合并为一次批量查询（`MGET`、`WHERE id IN (...)`），降低下游调用次数，代价是每个请求增加最多一个窗口的延迟。

| 合并方式 | 合并对象 | 收益 | 代价 |
|----------|----------|------|------|
| Single Flight | 相同 key 的并发请求 | 防缓存击穿，回源次数降为 1 | 失败时所有等待者一起失败 |
| 批量合并 | 窗口内不同 key 的请求 | 下游调用次数降为 1/N | 增加窗口延迟 |
| 写合并 | 同一对象的多次更新 | 写次数大幅下降 | 数据延迟、宕机丢失 |

---

## 四、热点隔离

即使做了上述优化，热点流量仍可能挤占共享资源。隔离的目标是**热点出问题只影响热点自己**：

| 隔离层级 | 做法 |
|----------|------|
| 集群隔离 | 秒杀 / 大促活动使用独立的服务集群、独立 Redis 集群、独立库 |
| 线程池隔离 | 热点接口使用独立线程池，满了只拒绝热点请求 |
| 数据隔离 | 热点商品的库存单独存放（独立库表或独立 Redis 实例） |
| 流量隔离 | 网关层按商品 / 租户维度做热点参数限流（Sentinel 热点参数规则） |

```java
// Sentinel 热点参数限流：对 itemId 维度限流，单个商品每秒最多 5000 次，特定爆款单独配置
ParamFlowRule rule = new ParamFlowRule("getItemDetail")
        .setParamIdx(0)                  // 第 0 个参数 itemId
        .setGrade(RuleConstant.FLOW_GRADE_QPS)
        .setCount(5000);
ParamFlowItem hot = new ParamFlowItem().setObject("1001").setClassType(Long.class.getName()).setCount(20000);
rule.setParamFlowItemList(List.of(hot));
ParamFlowRuleManager.loadRules(List.of(rule));
```

线程池隔离与舱壁模式见 [舱壁隔离与重试](/high-avail/6_bulkhead_retry)，限流算法见 [限流](/high-avail/3_rate_limiting)。

---

## 五、方案选型

| 场景 | 推荐方案 |
|------|----------|
| 读热点，允许秒级不一致 | 热点探测 + 本地缓存 |
| 读热点，一致性要求较高 | key 多副本打散 + 写时全量更新 |
| 写热点，库存类精确扣减 | Redis Lua 预扣 + MQ 异步落库 + 对账；超高并发加分桶 |
| 写热点，计数类 | 内存 / Redis 合并更新，定期落库 |
| 大量相同读请求 | Single Flight |
| 活动流量远超日常 | 独立集群 + 热点参数限流 |

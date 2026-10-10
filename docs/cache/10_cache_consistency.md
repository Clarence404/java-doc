---
description: 三种缓存模式、写顺序与竞态、提交后删除、延迟双删、binlog 订阅失效、方案选型
---

# 缓存一致性

> 前置阅读：[Redis 基础](./1_redis_base)、[两级缓存（L1 + L2）](./8_two_level_cache)、[消息队列基础](/messaging/1_basics)

缓存与数据库之间**不存在低成本的强一致**，任何模式都只能把不一致窗口压小、并保证它最终收敛。本篇是缓存与数据库一致性的主文档，讲三种缓存模式、Cache Aside 写顺序、提交后删除、延迟双删和 binlog / CDC 订阅失效。

---

## 一、三种缓存模式

![三种缓存模式的写路径](../assets/cache/cache_patterns.svg)

### 1、Cache Aside（旁路缓存）

- **读**：应用先查缓存，未命中查数据库，再把结果回填缓存
- **写**：应用先更新数据库，再**删除**缓存
- 缓存逻辑由应用自己控制，是互联网业务中绝大多数场景的选择
- Spring Cache 的 `@Cacheable` + `@CacheEvict` 也属于 Cache Aside，只是回填和删除由代理完成，应用仍然自己写数据库

### 2、Read / Write Through（读写穿透）

- 应用只和缓存层打交道，缓存层负责从数据库加载（Read Through）和同步写数据库（Write Through）
- 典型实现：JCache（JSR-107）的 `CacheLoader` / `CacheWriter`（`setReadThrough` / `setWriteThrough`）、Ehcache、Hazelcast 的 `MapStore`
- Caffeine / Guava 的 `LoadingCache` 只是 Read Through；Caffeine 3.0 已移除 `CacheWriter`，不提供 Write Through
- 写缓存与写数据库仍然不是原子的，多实例部署时各自的缓存层之间也需要失效机制，因此同样是最终一致

### 3、Write Behind（写回）

- 写操作只更新缓存并立即返回，由后台批量、异步地写入数据库
- 典型实现：Hazelcast `MapStore` 的写延迟模式、Ehcache / JCache 的写回模式、「Redis 计数器 + 定时落库」；数据库的 Buffer Pool、操作系统的 Page Cache 也是同一思想
- 写吞吐最高，但缓存宕机或写队列丢失会**丢数据**，需要持久化队列、WAL 或幂等重放来保障
- 适合计数、点赞、浏览量、埋点等允许少量误差、可重算的数据

### 4、对比

| 维度 | Cache Aside | Read / Write Through | Write Behind |
|------|-------------|----------------------|--------------|
| 谁维护缓存 | 应用 | 缓存层 | 缓存层 |
| 写路径 | 写数据库 → 删缓存 | 写缓存层 → 同步写数据库 | 写缓存 → 异步批量写数据库 |
| 与数据库的一致性 | 最终一致，窗口小 | 最终一致，窗口较小 | 弱一致，可能丢数据 |
| 写性能 | 中 | 中（同步写库） | 高 |
| 主要风险 | 并发下旧值回填、删除失败 | 缓存层成为单点、抽象过深 | 宕机丢数据、落库延迟 |
| 适用 | 绝大多数读多写少业务 | 有成熟缓存中间件、读写模式统一 | 计数、统计、埋点 |

---

## 二、Cache Aside 的写顺序

### 1、四种写法对比

| 写法 | 问题 | 结论 |
|------|------|------|
| 先更新数据库，再**更新**缓存 | 并发写会乱序：A 写库、B 写库、B 写缓存、A 写缓存，缓存最终是 A 的旧值；写入的值可能从来不会被读，浪费计算 | 不推荐 |
| 先更新缓存，再更新数据库 | 数据库写失败或事务回滚，缓存里就是从未生效过的数据 | 不推荐 |
| 先**删**缓存，再更新数据库 | 删除后、事务提交前，读请求从数据库读到旧值并回填；窗口等于整个事务时长，很容易发生 | 不推荐 |
| 先更新数据库，再**删**缓存 | 仍有竞态（见下文），但需要多个条件同时满足，窗口很小 | **默认做法** |

**为什么删而不是更新**：删除是幂等的，多个写请求的删除顺序乱了也没关系；新值由下一次读请求按数据库的最新状态重建（懒加载），不会出现「旧值后写覆盖新值」。缓存值需要复杂计算或聚合时，删除也避免了每次写都重算。

### 2、仍然存在的竞态

![「先更新数据库，再删缓存」仍存在的竞态](../assets/cache/cache_aside_race.svg)

1. 读请求 A 发现缓存未命中（刚过期或刚被删）
2. A 从数据库读到旧值 v1
3. 写请求 B 把数据更新为 v2 并提交
4. B 删除缓存（此时缓存本来就是空的）
5. A 把旧值 v1 写回缓存，直到 TTL 过期前都读到旧值

要发生这个竞态，B 的「更新 + 删除」必须完整地落在 A 的「读库」与「写缓存」之间。正常情况下读库加写缓存只需几毫秒，概率很低；但两种情况会显著放大窗口：

- **读写分离**：A 从从库读，主从复制延迟期间读到的都是旧值
- **A 在读库后发生 GC 停顿或线程调度延迟**

延迟双删、binlog 订阅删除就是为了收拾这类残留。

---

## 三、删除时机：事务提交之后

「先更新数据库，再删缓存」中的「更新数据库」指的是**事务提交**。在 `@Transactional` 方法内部删除缓存，删除实际发生在提交之前，提交前的窗口里其他请求会把旧值重新回填；事务回滚时缓存又被白白删除。

```java
@Transactional
public void updatePrice(long skuId, BigDecimal price) {
    skuMapper.updatePrice(skuId, price);
    String key = "sku:info:" + skuId;
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
            redis.delete(key);           // 提交成功后才删除；回滚则不执行
        }
    });
}
```

等价的写法是发布领域事件，用 `@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)` 处理，完整示例见 [两级缓存（L1 + L2）](./8_two_level_cache)。Spring Cache 的 `@CacheEvict` 与事务同在一个方法时有同样的问题，处理方式见 [Cache 抽象](/spring/5_cache)。

`afterCommit` 仍有两个缺口：

- **删除失败**：Redis 超时、网络抖动，删除没有生效，缓存一直是旧值直到 TTL
- **提交后、删除前进程崩溃**：删除根本没有执行

缺口的补法是对删除做可靠重试：要么用延迟消息再删一次（第四节），要么由 binlog 订阅驱动删除（第五节），要么把「待失效的 key」和业务数据写进同一个本地事务，由投递任务保证必达（本地消息表，见 [消息队列基础](/messaging/1_basics)）。无论哪种，**缓存都必须设置 TTL**，作为最后一道兜底。

---

## 四、延迟双删

### 1、做法与原理

事务提交后删除一次缓存，**延迟一段时间后再删一次**。第二次删除用来清掉第二节竞态中被读请求回填的旧值。

### 2、延迟时间怎么定

延迟必须大于「并发读请求从读库到写回缓存」的最长耗时，再加上主从复制延迟（读从库时）：

- 延迟 > 读请求读库 + 写缓存的 P99 耗时 + 主从复制延迟
- 常见取值在几百毫秒到 1–2 秒之间，应以监控数据为准；复制延迟可能突增，因此它只能**降低**而不能消除不一致

### 3、实现：用延迟消息，不要用内存定时器

- 不要在请求线程里 `Thread.sleep` 后再删，会直接拖慢接口
- 不要用 `ScheduledExecutorService` 之类的内存定时器：进程重启时第二次删除丢失，删除失败也没有重试
- 用 MQ 的延迟消息承载第二次删除，消费失败由 MQ 重试

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onSkuChanged(SkuChanged event) {
    String key = "sku:info:" + event.skuId();
    rocketMQTemplate.syncSendDelayTimeSeconds("cache-evict", key, 1);   // 先登记 1 秒后的第二次删除（RocketMQ 5.x）
    redis.delete(key);                                                   // 第一次删除；失败也有延迟消息兜底
}

@Component
@RocketMQMessageListener(topic = "cache-evict", consumerGroup = "cache-evict-consumer")
public class CacheEvictConsumer implements RocketMQListener<String> {

    private final StringRedisTemplate redis;

    public CacheEvictConsumer(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public void onMessage(String key) {
        redis.delete(key);           // 删除是幂等的；抛异常时由 RocketMQ 重试
    }
}
```

RocketMQ 4.x 只支持固定延迟级别，5.x 支持任意延迟，见 [RocketMQ](/messaging/3_rocketmq)。

---

## 五、binlog / CDC 订阅失效

![基于 binlog / CDC 的缓存失效链路](../assets/cache/cache_binlog_invalidation.svg)

由 CDC 组件订阅 MySQL binlog，把行变更转成「待删除的缓存 key」，由独立的消费者执行删除：

1. 业务服务只写数据库，不再负责删缓存
2. CDC 组件（Canal、Debezium、Flink CDC）解析 binlog 中的行变更
3. 按表与主键映射出缓存 key，以主键为分区键发到 MQ，保证同一 key 的变更有序
4. 失效消费者删除缓存，失败退避重试，超过次数进入死信并告警

**优点**：

- **只有提交成功的变更才会进入 binlog**，天然满足「提交后删除」，回滚不会误删
- 业务进程崩溃不影响删除，失败的删除可以重试、重放，不会漏删
- 与业务代码解耦：多个服务、批量脚本、手工 SQL 改了同一张表，缓存都能失效

**代价**：要运维 CDC 组件与 MQ，端到端延迟通常在几十到几百毫秒，期间仍是旧值；表结构到缓存 key 的映射需要维护。

**推荐组合**：应用在 `afterCommit` 中先删一次（快），binlog 订阅再删一次（可靠）。binlog 那次删除天然晚于提交，相当于一个由基础设施保证的延迟双删。

binlog 参数、Canal 与 Debezium 的选型与部署见 [CDC 工具](/database/5_practice/0_cdc_tools)，基于 Flink 的 CDC 管道见 [Flink CDC](/flink/6_cdc)。

---

## 六、更强的一致性

确实需要接近强一致的少数数据，有以下手段，代价都很高：

- **按 key 读写互斥**：读写同一 key 时加分布式读写锁（如 Redisson `RReadWriteLock`），回填与更新串行化；读请求也要加锁，吞吐大幅下降
- **lease 机制**：读未命中时由缓存发放一个 lease 令牌，删除会使令牌失效，持过期令牌的回填被拒绝（Facebook 的 Memcache 论文中的做法），可以消除旧值回填；Redis 没有内置，需要用 Lua 自行实现
- **不缓存或直读主库**：余额、库存扣减等以数据库为准，缓存只用于展示；扣减用数据库条件更新或 Lua 原子操作，不依赖缓存一致性

---

## 七、方案选型

工程上的目标是：不一致窗口足够小、有上限（TTL 兜底），且不会因为一次失败而永久不一致。

| 方案 | 不一致窗口 | 可靠性 | 复杂度 | 适用 |
|------|-----------|--------|--------|------|
| 只靠 TTL 过期 | 最长一个 TTL | 必然收敛 | 最低 | 允许分钟级旧数据，如排行榜、推荐 |
| 提交后删除 | 毫秒级，残留竞态 | 删除失败或崩溃会漏删 | 低 | 默认做法 |
| 提交后删除 + 延迟双删 | 约等于延迟时长 | 依赖延迟消息重试 | 中 | 读写分离、高并发热点 |
| binlog / CDC 订阅删除 | CDC 端到端延迟 | 高，可重放 | 中高（需运维 CDC） | 核心数据、多入口写同一张表 |
| 本地消息表投递失效消息 | 投递延迟 | 高 | 中 | 没有 CDC 基础设施时 |
| 读写锁 / lease | 接近强一致 | 高 | 高，吞吐下降 | 极少数关键数据 |

常用落地组合：**所有 key 设置 TTL + 提交后删除 + binlog 订阅兜底删除**；读从库的场景再加延迟双删。

---

## 小结

- 缓存与数据库之间没有低成本的强一致，所有模式都是最终一致，区别在窗口大小与丢失风险
- Cache Aside 是默认模式；Spring Cache 属于 Cache Aside，Caffeine `LoadingCache` 只是 Read Through，Caffeine 3 没有 Write Through
- 写操作是「先更新数据库，再删除缓存」，删除而不是更新，并且在**事务提交之后**执行
- 残留竞态是读请求把读到的旧值在删除之后回填，读从库会放大窗口
- 延迟双删的延迟要大于读库加写缓存耗时与主从延迟之和，用延迟消息实现，不用内存定时器
- binlog / CDC 订阅删除只处理已提交的变更、可重试可重放，是可靠失效的首选兜底
- 所有缓存 key 必须有 TTL，作为最后一道兜底

本地缓存的多实例失效见 [两级缓存（L1 + L2）](./8_two_level_cache)，穿透、击穿、雪崩的防护见 [缓存最佳实践](./11_cache_rule)。

## 参考资料

- Microsoft Azure Architecture Center · Cache-Aside pattern：[https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
- Scaling Memcache at Facebook（NSDI 2013，lease 机制）：[https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala)
- Ehcache 文档 · Cache Usage Patterns：[https://www.ehcache.org/documentation/3.10/caching-patterns.html](https://www.ehcache.org/documentation/3.10/caching-patterns.html)
- Spring Framework 文档 · Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Debezium 文档 · MySQL Connector：[https://debezium.io/documentation/reference/stable/connectors/mysql.html](https://debezium.io/documentation/reference/stable/connectors/mysql.html)
- Canal GitHub：[https://github.com/alibaba/canal](https://github.com/alibaba/canal)
- RocketMQ 文档 · 定时 / 延时消息：[https://rocketmq.apache.org/docs/featureBehavior/02delaymessage/](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage/)

> 下一篇：[缓存最佳实践](./11_cache_rule) —— Key / Value / TTL 规范、穿透与击穿防护代码、禁止事项与监控指标。

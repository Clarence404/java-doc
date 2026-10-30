---
description: 缓存选择、Redis Sentinel、商品详情两级缓存、Cache Aside 与延迟双删、穿透击穿雪崩、热点 key
---

# 引入缓存

> 前置阅读：[数据建模](./2_data_model)、[接口设计](./3_api_design)、[缓存架构设计](/high-con/3_cache_architecture)

日订单涨到 10 万后，数据库的压力先来自读而不是写。本篇讲缓存的范围、Redis 部署、商品详情两级缓存与一致性策略，基线为 Redis 8、Caffeine 3、Spring Boot 4。

---

## 一、背景

进入阶段二，日订单约 10 万，下单峰值约 30 QPS；真正把数据库压红的是**商品详情读，平时约 2000 QPS**，活动推送后的几分钟里还会翻倍。按阶段一的设计，每次打开详情页要查 `t_product`，再按 `sku_id` 查一次 `t_inventory` 展示有货无货，一次请求两条 SQL：

| 指标 | 阶段一 | 阶段二 |
|------|-------|-------|
| 商品详情读 | 约 100 QPS | 约 2000 QPS，峰值 4000+ |
| 云数据库 CPU（高峰） | 15% | 75%，慢查询告警每天十几次 |
| 下单接口 P99 | 120 ms | 450 ms（读把连接池和 CPU 占满，写跟着变慢） |

商品数据有三个特点：几万个 SKU、改得少（运营每天改几百次价格或文案）、读得多且集中在头部商品。这是缓存收益最大的形态。同一时期还有另一个问题：支付成功后同步发通知、加积分，外部接口一慢就拖累同进程的下单接口，留给下一篇 [异步化](./5_async) 解决。

---

## 二、缓存什么，不缓存什么

先划范围，再选技术。判断标准就三条：读写比高不高、能不能接受短时间旧数据、命中率能不能做上去。

| 数据 | 读写特点 | 决策 | 理由 |
|------|---------|------|------|
| 商品详情（名称、主图、价格、规格） | 读 2000 QPS，日改几百次 | **两级缓存** | 读写比上千，头部集中，旧几秒可以接受 |
| 库存展示（有货 / 无货） | 跟着下单频繁变 | Redis 短 TTL（10 秒） | 只用于展示，旧了最多让下单时多一次库存不足 |
| 库存扣减 | 写 | **不缓存，仍走数据库条件更新** | 扣减要正确，不能用旧值判断 |
| 订单详情 | 每单被看一两次 | **不缓存** | 命中率低、状态变化快，见下文 |
| 下单计价 | 读 | **不读缓存** | 价格以数据库为准，详情页的旧价格不影响实际扣款 |

### 1、库存：展示可以旧，扣减不能

详情页的「有货」只是提示，放进 Redis 设 10 秒 TTL；真正扣减仍是 [数据建模 · 库存表与扣减方式](./2_data_model#六、库存表与扣减方式) 里的 `UPDATE t_inventory ... WHERE stock >= ?`。阶段二下单峰值约 30 QPS，分摊到几万个 SKU，单行锁竞争依旧可以忽略；用 Redis 预扣要处理 Redis 与 MySQL 的对账和宕机丢数据，换不来什么收益。单 SKU 秒杀式的写热点留到大促阶段再看，做法见 [热点问题 · 写热点](/high-con/6_hotspot#三、写热点-热点行更新)。

### 2、订单详情：为什么不缓存

- **命中率低**：一笔订单通常只在支付后、发货后各被看一两次，缓存写进去基本等不到第二次读
- **状态变得快**：待支付 → 待发货 → 已发货都在几小时内发生，每次流转都要删缓存，一致性成本比收益高
- **查询本来就便宜**：`GET /api/orders/{orderNo}` 走 `uk_order_no` 唯一索引，加上明细一共两次索引查找，阶段二订单详情读约 150 QPS，数据库完全扛得住

所以订单详情、「我的订单」列表都不缓存。真遇到个别订单被刷（例如客服系统轮询），先在调用方限频；确需缓存时只给已完成、已关闭这类不再变化的订单加 60 秒 TTL，待支付订单绝不缓存。

---

## 三、Redis 部署：主从 + Sentinel

### 1、选项

| 方案 | 可用性 | 代价 |
|------|-------|------|
| 单机 Redis | 宕机即全部回源，2000 QPS 直接打到数据库 | 最省事，但等于把数据库的安全交给一台机器 |
| **主从 + Sentinel** | 主节点故障约 10–30 秒内自动切换 | 多两台主机和 3 个 Sentinel 进程，客户端要支持 Sentinel |
| Redis Cluster | 分片 + 自动故障转移 | 至少 3 主 3 从，多 key 命令受限；数据只有几百 MB，用不上分片 |
| 云厂商托管版 | 由厂商负责切换 | 版本常落后，按规格计费比自建贵，排查问题看不到底层 |

### 2、决策

选 **Redis 8 一主一从 + 3 个 Sentinel**：主从各占一台 4C8G 云主机，两台机器上各跑一个 Sentinel，第三个 Sentinel 放在其中一台应用主机上，凑够多数派。

- **不上 Cluster**：容量只有几百 MB（见第七节），单个 Redis 每秒十万级命令，阶段二的 2000 QPS 远远用不完；分片带来的多 key 限制和运维成本，到数据量或单节点带宽真的不够时再付
- **不做读写分离**：从节点只用于故障切换，读写都走主节点。从库读有复制延迟，会让刚删除的缓存从从库读到旧值，一致性分析见 [Redis 集群 · 读写分离](/cache/3_redis_cluster#_3、读写分离)
- **持久化只开 RDB**：Redis 里全是缓存，丢了可以从数据库重建，不需要 AOF；但重启后不至于全量回源

主从复制、Sentinel 的故障判定与配置见 [Redis 集群 · 哨兵模式](/cache/3_redis_cluster#三、哨兵模式-sentinel)。应用侧只需改连接配置，Lettuce 会向 Sentinel 询问当前主节点，切换后自动重连：

```yaml
spring:
  data:
    redis:
      sentinel:
        master: qingyou-cache
        nodes: 10.0.1.21:26379,10.0.1.22:26379,10.0.1.11:26379
        password: ${REDIS_SENTINEL_PASSWORD}
      password: ${REDIS_PASSWORD}
      timeout: 200ms           # 缓存慢了宁可回源，不让请求卡在 Redis 上
      lettuce:
        pool:
          max-active: 32
```

密码和阶段一的数据库密码一样放在 `EnvironmentFile=/etc/qingyou-mall/env`。Redis 侧把内存上限和淘汰策略定死，避免内存打满后写入报错：

```properties
# redis.conf（主从一致）
maxmemory 2gb
maxmemory-policy allkeys-lfu     # 全是缓存，按访问频率淘汰；LFU 还让 redis-cli --hotkeys 可用
save 900 1
appendonly no
```

淘汰策略的区别见 [Redis 核心原理 · 缓存淘汰策略](/cache/2_redis_core#三、缓存淘汰策略)。

---

## 四、商品详情两级缓存

### 1、为什么还要本地缓存

只用 Redis，2000 QPS 也就是 Redis 的零头。加一层进程内的 Caffeine 是为了另外两件事：

- **头部商品挡在进程内**：活动商品一个 SKU 能占到全部详情读的三成，L1 命中时连网络都不走，P99 从约 3 ms 降到 1 ms 以内
- **Redis 抖动或切换时不雪崩**：Sentinel 切换的十几秒里，L1 里的热门商品还能继续返回

代价是多实例之间的 L1 不一致：A 实例删了自己的 L1，B 实例还握着旧值。处理方式见第五节。读写流程如下图：

![商品详情两级缓存的读路径与失效路径](../assets/project/product-detail-two-level-cache.svg)

| 层 | 介质 | TTL | 容量 | 预期命中 |
|----|------|-----|------|---------|
| L1 | Caffeine，每个应用实例一份 | 写入后 30 秒 | 最多 1 万条 | 约 80% |
| L2 | Redis，key `product:detail:{skuId}` | 30 分钟 + 0–5 分钟随机 | 全量 SKU | 约 19% |
| 回源 | MySQL `t_product` | — | — | 不到 1%，约 20 QPS |

整体命中率是两层叠乘的结果，L2 命中率从 95% 提到 99%，回源量就降为原来的五分之一，计算方式见 [缓存架构设计 · 整体命中率的放大效应](/high-con/3_cache_architecture#_1、整体命中率的放大效应)。两级缓存的通用设计见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)，这里只放青柚的落地写法。

### 2、读路径

商品模块新增包 `com.qingyou.product.detail`，对外接口是 `GET /api/products/{skuId}`；返回的 `ProductDetailView` 是 record，放进 L1 后不会被调用方改掉：

```java
@Service
public class ProductDetailService {

    static final String KEY_PREFIX = "product:detail:";
    private static final String NULL_JSON = "{}";                    // 空值占位，防穿透

    private final Cache<Long, Optional<ProductDetailView>> local = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofSeconds(30))                 // 兜底丢失的失效广播
            .recordStats()
            .build();

    private final StringRedisTemplate redis;
    private final JsonMapper jsonMapper;
    private final ProductMapper productMapper;

    // 构造器注入，略

    public Optional<ProductDetailView> get(long skuId) {
        // 同一 skuId 并发未命中时，本 JVM 只有一个线程去查 Redis / 数据库
        return local.get(skuId, this::loadFromRemote);
    }

    private Optional<ProductDetailView> loadFromRemote(long skuId) {
        String key = KEY_PREFIX + skuId;
        String json = redis.opsForValue().get(key);
        if (json != null) {
            return NULL_JSON.equals(json) ? Optional.empty()
                    : Optional.of(jsonMapper.readValue(json, ProductDetailView.class));
        }
        ProductDetailView view = productMapper.selectDetail(skuId);   // 回源只查 t_product
        if (view == null) {
            redis.opsForValue().set(key, NULL_JSON, Duration.ofSeconds(60));
            return Optional.empty();
        }
        Duration ttl = Duration.ofMinutes(30).plusSeconds(ThreadLocalRandom.current().nextInt(300));
        redis.opsForValue().set(key, jsonMapper.writeValueAsString(view), ttl);
        return Optional.of(view);
    }

    void evictLocal(long skuId) {
        local.invalidate(skuId);
    }
}
```

Controller 拿到 `Optional.empty()` 时抛 `BizException(ProductErrorCode.PRODUCT_NOT_FOUND)`，返回 404 的 `ProblemDetail`，与 [接口设计](./3_api_design) 的约定一致。Redis 超时或连不上时，`loadFromRemote` 捕获 `RedisConnectionFailureException` 直接查库并跳过回写，这里省略。

下单计价走的仍是 `ProductApi.listByIds`，直接查 `t_product`，**不经过这个缓存**：详情页看到的价格最多旧几十秒，用户实际支付的金额永远是下单那一刻数据库里的价格。

---

## 五、一致性：Cache Aside + 延迟双删

### 1、选项

商品只有一个写入口：运营后台调用 `ProductService` 改 `t_product`。可选的失效方式：

| 方案 | 不一致窗口 | 阶段二的代价 |
|------|-----------|-------------|
| 只靠 TTL | 最长 35 分钟 | 改了价格半小时不生效，运营不接受 |
| 先删缓存再更新库 | 读请求会把旧值写回，窗口可达一个 TTL | 不可取 |
| **提交后删除 + 延迟双删** | 约 1 秒 | 多一次删除，第二次删除可能丢 |
| binlog 订阅删除（Canal 等） | CDC 延迟，可重放 | 要部署、监控一套 CDC，只为一张表不划算 |

### 2、决策

选 **Cache Aside + 事务提交后删除 + 1 秒后再删一次**，所有 key 都带 TTL 兜底：

- **为什么是删不是更新**：并发写时「更新缓存」会把旧值覆盖到新值之后，删除只会多一次回源。四种写顺序的对比见 [缓存一致性 · Cache Aside 的写顺序](/cache/10_cache_consistency#二、cache-aside-的写顺序)
- **为什么要第二次删**：读请求在更新前读到旧值、在第一次删除之后才写回 Redis，旧值会一直待到 TTL；1 秒后再删一次能清掉这类回写。延迟取「读请求查库 + 写 Redis」耗时的几倍，商品详情回源 P99 约 50 ms，1 秒足够，依据见 [缓存一致性 · 延迟双删](/cache/10_cache_consistency#四、延迟双删)
- **为什么不上 binlog 订阅**：写入口只有一个，提交后删除已经覆盖了正常路径；为一张几万行的表运维 CDC 不划算。等阶段三商品数据被搜索、推荐等多个系统消费时，再考虑统一的变更订阅
- **明确接受的风险**：第二次删除用应用内的定时任务执行，进程恰好在这 1 秒内重启会丢。主文档建议用延迟消息，但这需要先有 MQ；下一篇引入 RocketMQ 后也不为这个低概率场景单独加主题，丢了由 30 分钟 TTL 兜底，运营发现价格未生效时可在后台手动刷新缓存

各方案的完整对比见 [缓存一致性 · 方案选型](/cache/10_cache_consistency#七、方案选型)。

### 3、关键实现

`ProductService` 在事务里只发布 `ProductChangedEvent`，删除放在提交之后，避免「删了缓存、事务却回滚」或「删完缓存、提交前被读回旧值」：

```java
public record ProductChangedEvent(long skuId) {}

@Slf4j
@Component
public class ProductCacheInvalidator {

    static final String CHANNEL = "cache:invalidate:product";
    private static final ScheduledExecutorService DELAYED =
            Executors.newSingleThreadScheduledExecutor(Thread.ofVirtual().factory());

    private final StringRedisTemplate redis;

    public ProductCacheInvalidator(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onChanged(ProductChangedEvent e) {
        evict(e.skuId());
        DELAYED.schedule(() -> evict(e.skuId()), 1, TimeUnit.SECONDS);   // 延迟双删
    }

    private void evict(long skuId) {
        try {
            redis.delete(ProductDetailService.KEY_PREFIX + skuId);       // 删 L2
            redis.convertAndSend(CHANNEL, String.valueOf(skuId));         // 通知所有实例删 L1
        } catch (RuntimeException ex) {
            log.warn("商品缓存删除失败，等待 TTL 兜底，skuId={}", skuId, ex);
        }
    }
}
```

每个实例都订阅 `cache:invalidate:product`，收到后调用 `ProductDetailService.evictLocal`，自己发的广播自己也会收到，所以 `evict` 里不单独删本地。订阅容器的注册写法见 [两级缓存 · 订阅失效频道](/cache/8_two_level_cache#_2、订阅失效频道)。Pub/Sub 不保证送达，应用和 Redis 断连期间的广播会丢，L1 的 30 秒 TTL 就是为这种情况兜底的上限。

---

## 六、穿透、击穿、雪崩与热点

缓存一上线就要同时防住这几类问题，阶段二的规模下都用最轻的手段：

| 问题 | 青柚的做法 | 暂不做 |
|------|-----------|-------|
| 穿透：查不存在的 SKU | `skuId` 先做格式校验，查不到时缓存空值 60 秒 | 布隆过滤器：SKU 只有几万个，空值缓存足够 |
| 击穿：热门 key 过期瞬间 | Caffeine `get(key, loader)` 在单实例内合并回源，几个实例最多几个请求到库 | 分布式互斥锁、逻辑过期 |
| 雪崩：大量 key 同时过期或 Redis 宕机 | L2 TTL 加 0–5 分钟随机；Sentinel 自动切换；L1 顶住切换期间的热门读 | 多机房、Redis 降级开关 |

做法与原理见 [缓存最佳实践 · 缓存穿透防护](/cache/11_cache_rule#四、缓存穿透防护)、[缓存击穿防护](/cache/11_cache_rule#五、缓存击穿防护)、[缓存雪崩防护](/cache/11_cache_rule#六、缓存雪崩防护)。

**热点 key** 在阶段二主要靠 L1 解决：一个爆款 SKU 即使占了一半流量，每个实例 30 秒也只向 Redis 读一次，Redis 侧看不到热点。探测上不建 JD-hotkey 这类集中式系统，`allkeys-lfu` 下定期跑 `redis-cli --hotkeys` 抽查，配合 L1 的命中统计看哪些 SKU 最热。大促前的预热与热点隔离留到稳定性阶段，思路见 [热点问题 · 本地缓存兜底](/high-con/6_hotspot#_1、本地缓存兜底) 与 [商品详情页 · 热点与大促](/scenario/13_product_detail#六、热点与大促)。

---

## 七、容量估算

| 项 | 估算 | 结果 |
|----|------|------|
| SKU 数 | 在售约 5 万，含下架约 8 万 | 按 8 万算 |
| 单条详情 JSON | 名称、价格、主图 URL、规格约 3 KB；详情富文本和图片走 CDN，不进缓存 | 3 KB |
| Redis 数据 | 8 万 × 3 KB ≈ 240 MB，加 key、过期字典等开销按 1.5 倍 | 约 360 MB |
| 库存展示 key | 8 万 × 约 100 B | 约 8 MB |
| 单实例 L1 | 1 万条 × 约 4 KB（对象比 JSON 大） | 约 40 MB 堆内存 |

`maxmemory 2gb` 留了 5 倍余量，fork 做 RDB 时的写时复制也够用，所以 Redis 主机选 8G 内存。容量估算的通用方法见 [商品详情页 · 容量估算](/scenario/13_product_detail#八、容量估算)。商品数涨到百万级、单条加上评价摘要等字段后，再评估是否拆 Cluster。

---

## 八、命中率监控

缓存是否起作用，看三个数字，阶段二先通过 Actuator 的 Micrometer 指标暴露：

- **L1 命中率**：`CaffeineCacheMetrics.monitor(registry, local, "product_detail")` 注册后得到 `cache.gets{result=hit|miss}`，低于 70% 说明 L1 太小或 TTL 太短
- **L2 命中率**：在 `loadFromRemote` 里按命中、未命中、空值三种结果计数 `product.detail.l2`；Redis `INFO stats` 的 `keyspace_hits` 是全实例口径，混着库存展示 key，只做参考
- **回源 QPS**：`selectDetail` 的调用次数，超过 100 QPS 告警，往往意味着大面积过期或 Redis 不可用

此外盯 Redis 的 `used_memory`、`evicted_keys`（大于 0 说明容量不够）和主从切换事件。指标口径和告警阈值见 [缓存最佳实践 · 监控告警](/cache/11_cache_rule#九、监控告警)，Caffeine 统计的开法见 [Caffeine · 统计与监控](/cache/7_caffeine#六、统计与监控)。

上线一周后的数据：L1 命中 82%，L2 命中 17.6%，回源约 8 QPS；数据库 CPU 高峰回落到 30%，下单接口 P99 回到 150 ms 左右。

---

## 九、代价与后续

| 本篇的决策 | 带来的问题 | 在哪解决 |
|-----------|-----------|---------|
| 第二次删除用应用内定时任务 | 进程重启会丢，靠 TTL 兜底 | 暂时接受；概率低，不为它单独加消息主题 |
| L1 失效靠 Pub/Sub | 断连期间的广播丢失，最多 30 秒旧数据 | 暂时接受；阶段三商品仍留在 `mall-app`，将来商品独立成服务时再评估改 MQ 广播 |
| 库存扣减仍是数据库行锁 | 单 SKU 抢购时行锁排队 | 「稳定性」的写热点治理 |
| 支付成功后仍同步发通知、加积分 | 下单接口被第三方拖慢 | 下一篇 [异步化](./5_async) |
| 多了一套 Redis 要运维 | 切换、内存、慢命令都要盯 | 「可观测与发布」统一告警 |

---

## 小结

- 先划范围：商品详情两级缓存，库存展示短 TTL，库存扣减、下单计价、订单详情都不读缓存
- Redis 8 一主一从 + 3 个 Sentinel，只开 RDB、`allkeys-lfu`、`maxmemory 2gb`；不上 Cluster、不读从库
- 商品详情 L1 Caffeine 30 秒 + L2 Redis 30 分钟加随机，key `product:detail:{skuId}`，整体回源不到 1%
- 一致性用 Cache Aside：事务提交后删 L2 并广播删 L1，1 秒后再删一次，所有 key 带 TTL 兜底；不上 binlog 订阅
- 穿透用参数校验 + 空值缓存，击穿靠 Caffeine 单实例合并回源，雪崩靠 TTL 抖动 + Sentinel + L1；热点 key 由 L1 吸收
- 上线后盯 L1 / L2 命中率、回源 QPS 和 `evicted_keys`

---

## 参考资料

- Redis Docs · High availability with Redis Sentinel：[https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- Redis Docs · Key eviction：[https://redis.io/docs/latest/develop/reference/eviction/](https://redis.io/docs/latest/develop/reference/eviction/)
- Caffeine Wiki · Statistics：[https://github.com/ben-manes/caffeine/wiki/Statistics](https://github.com/ben-manes/caffeine/wiki/Statistics)
- Spring Data Redis Reference · Redis Sentinel Support：[https://docs.spring.io/spring-data/redis/reference/redis/connection-modes.html](https://docs.spring.io/spring-data/redis/reference/redis/connection-modes.html)

> 下一篇：[异步化](./5_async) —— 用消息队列解耦下单后的通知、积分与发货，可靠投递与消费幂等

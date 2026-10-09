---
description: 静动分离、Nginx / Caffeine / Redis 三级缓存、变更消息重建与版本号、热点预热、降级兜底、容量估算
---

# 商品详情页

> **本篇目标**：设计一个能扛大促峰值的商品详情页，做到静态部分走 CDN、动态部分异步拉取、基础信息走三级缓存，数据变更后缓存能按 SKU 可靠重建且不被旧数据覆盖，任何一个依赖故障时页面仍然能打开。
>
> **前置阅读**：[接入层架构](/high-con/1_access_layer)（动静分离一节）、[缓存架构设计](/high-con/3_cache_architecture)、[两级缓存（L1 + L2）](/cache/8_two_level_cache)、[热点问题](/high-con/6_hotspot)

商品详情页是电商流量最大的页面：首页、搜索、推荐、广告最终都落到这里。它的特点是读远多于写、同一商品对所有人展示的内容大部分相同，所以思路是：**能静态化的推到 CDN，能缓存的尽量靠近用户，必须实时的单独拉取并允许失败**。

---

## 一、需求与挑战

### 1、数据来源

一个详情页拼装了多个服务的数据，变化频率和一致性要求差别很大：

| 数据 | 来源服务 | 变化频率 | 一致性要求 | 放在哪 |
|------|----------|----------|------------|--------|
| 标题、主图、规格、类目、品牌 | 商品服务 | 低（天级） | 秒级延迟可接受 | 静态骨架 + base 接口 |
| 商品描述（图文详情） | 商品服务 | 很低 | 分钟级可接受 | CDN（对象存储） |
| 价格 | 价格服务 | 中（活动开始结束） | 高，但以结算页为准 | dynamic 接口 |
| 库存状态 | 库存服务 | 高 | 展示「有货 / 无货」即可 | dynamic 接口 |
| 促销、优惠券 | 促销服务 | 中 | 秒级 | dynamic 接口 |
| 评价摘要（好评率、条数） | 评价服务 | 高但不敏感 | 分钟级可接受 | base 接口（独立 key） |

价格和库存在详情页上只做**展示**：用户下单时结算页会重新计价、扣减库存，所以详情页可以接受秒级旧值，但不能因为价格服务慢把整个页面拖垮。

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 读多写少 | 读写比常在万比一以上，读流量必须在缓存层消化 |
| 大促峰值 | 峰值 PV 是日常的数十倍，且集中在少数爆款上，形成热点 |
| 依赖多 | 一个页面依赖 5 个以上服务，任意一个慢都会拖长整体耗时 |
| 一致性 | 商家改价、改标题后，用户要在秒级看到新内容，且不能被旧数据覆盖回去 |
| 可用性 | 详情页打不开直接损失成交，任何依赖故障都要有兜底 |

---

## 二、整体架构

![商品详情页整体架构](../assets/scenario/product-detail-arch.svg)

一次页面访问拆成三类请求：

| 请求 | 内容 | 链路 | 缓存 |
|------|------|------|------|
| 静态部分 | HTML 骨架、JS/CSS、图片、商品描述 | CDN → 对象存储 | 长 TTL，变更时主动刷新 |
| base 接口 | 标题、规格、类目、评价摘要等千人一面的数据 | Nginx（L0）→ 聚合服务（L1）→ Redis（L2）→ 商品服务 | 三级缓存 + 变更消息重建 |
| dynamic 接口 | 价格、库存状态、促销 | Nginx 透传 → 聚合服务 → 各业务服务 | 最多 1 秒本地缓存，超时降级 |

- **详情聚合服务**只做读：拼装、缓存、降级，不承担任何写逻辑；写路径留在各业务服务
- base 与 dynamic 分开是为了让两部分可以有不同的缓存策略和失败策略：base 可以用旧值，dynamic 宁可不显示也不显示错的
- 个性化内容（会员价、用户可领的券、收货地址相关的配送时效）放在 dynamic 或单独的接口里，不能进入 L0 / CDN 这类所有人共享的缓存

---

## 三、静态化与静动分离

### 1、两种静态化方式

| 方式 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| 全量静态化 | 商品变更时用模板生成完整 HTML，推到 CDN / 对象存储 | 访问时零计算，CDN 命中率最高 | 改一次模板要重新生成全部商品页；SKU 上千万时重新生成要几小时 |
| 模板 + 数据渲染 | HTML 只是一个通用骨架，数据由 base 接口提供，前端或 Nginx 渲染 | 改模板只需发布一个文件；数据变更只刷新缓存不刷新 CDN | 每次访问多一次 base 请求 |

生产上更常用**模板 + 数据渲染**：骨架和静态资源走 CDN，base 数据走多级缓存。全量静态化只用于少量活动页、落地页这类模板稳定、商品数少的场景。页面静态化与 CDN 回源保护的通用做法见 [接入层架构](/high-con/1_access_layer)。

- 商品描述（图文详情）体积大、几乎不变，单独作为静态文件放对象存储，文件名带版本号，前端滚动到该区域时再加载
- SEO 需要服务端渲染时，可以由 Nginx 用模板引擎把 base 数据填进骨架后输出，数据仍然来自同一套缓存

### 2、动态数据异步拉取

dynamic 接口在聚合服务里**并发调用**各业务服务，每个依赖单独设超时与兜底值，整体耗时取决于最慢且未超时的那个：

```java
public record PriceInfo(Long priceCent, boolean available) {
    public static final PriceInfo UNKNOWN = new PriceInfo(null, false);
}

public enum StockStatus { IN_STOCK, LOW, OUT_OF_STOCK, UNKNOWN }

public record PromoInfo(List<String> labels) {
    public static final PromoInfo NONE = new PromoInfo(List.of());
}

public record ItemDynamic(PriceInfo price, StockStatus stock, PromoInfo promo) {}

@Service
public class ItemDynamicService {

    private final PriceClient priceClient;
    private final StockClient stockClient;
    private final PromoClient promoClient;
    // JDK 21 虚拟线程：每个下游调用一个线程，阻塞 IO 不占平台线程
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public ItemDynamicService(PriceClient priceClient, StockClient stockClient, PromoClient promoClient) {
        this.priceClient = priceClient;
        this.stockClient = stockClient;
        this.promoClient = promoClient;
    }

    public ItemDynamic load(long skuId) {
        CompletableFuture<PriceInfo> price = CompletableFuture
                .supplyAsync(() -> priceClient.get(skuId), executor)
                .completeOnTimeout(PriceInfo.UNKNOWN, 150, TimeUnit.MILLISECONDS)
                .exceptionally(e -> PriceInfo.UNKNOWN);
        CompletableFuture<StockStatus> stock = CompletableFuture
                .supplyAsync(() -> stockClient.status(skuId), executor)
                .completeOnTimeout(StockStatus.UNKNOWN, 100, TimeUnit.MILLISECONDS)
                .exceptionally(e -> StockStatus.UNKNOWN);
        CompletableFuture<PromoInfo> promo = CompletableFuture
                .supplyAsync(() -> promoClient.get(skuId), executor)
                .completeOnTimeout(PromoInfo.NONE, 100, TimeUnit.MILLISECONDS)
                .exceptionally(e -> PromoInfo.NONE);
        return new ItemDynamic(price.join(), stock.join(), promo.join());
    }
}
```

- 兜底值决定页面怎么展示：价格 `UNKNOWN` 时显示「价格加载中」并禁用购买按钮，**不显示缓存里可能过期的价格**；库存 `UNKNOWN` 时不显示库存状态，下单时再校验；促销失败就不显示促销标签
- `completeOnTimeout` 只是让调用方不再等待，下游请求本身仍在执行，所以 HTTP 客户端也要设读超时，否则慢请求会在后台堆积
- 库存只返回「有货 / 紧张 / 无货」而不是精确数字：状态变化远少于数量变化，可以在聚合服务按 skuId 做 1 秒本地缓存，也不暴露真实库存

---

## 四、多级缓存

### 1、三级缓存的分工

| 层级 | 实现 | 内容 | TTL | 容量（示例） | 失效方式 |
|------|------|------|-----|--------------|----------|
| L0 | OpenResty `lua_shared_dict` | base 接口响应体 | 5 秒 | 每台 Nginx 256 MB | 只靠 TTL |
| L1 | 聚合服务 Caffeine | base 序列化后的 `byte[]` | 30 秒刷新、10 分钟过期 | 每实例 100 MB | 变更广播 + TTL |
| L2 | Redis Cluster | 按数据源拆分的快照 | 7 天 + 随机抖动 | 全量在售 SKU | 重建服务按版本号覆盖 |

**容量估算**（按 base 快照平均 4 KB、1 KB = 1024 B）：

- L0：热点 SKU 5 万个 × 4 KB = 200,000 KB ≈ 195 MB，`lua_shared_dict` 配 256 MB 留出余量，满了按 LRU 淘汰
- L1：上限按字节算 100 MB，100 × 1024 KB ÷ 4 KB = 25,600 个 SKU；存 `byte[]` 而不是反序列化后的对象，内存可控，命中时直接作为响应体返回
- L2：在售 SKU 1000 万 × 4 KB = 40,000,000 KB ≈ 38.1 GB；value 超过 64 字节后 Hash 不再用 listpack 编码，按每个 key 额外约 200 B 估算，1000 万 × 200 B ≈ 1.9 GB，合计约 40 GB；16 个主分片每片约 2.5 GB，一主一从共需约 80 GB 内存。快照用 gzip 压缩到约三分之一后，单副本可降到 15 GB 左右（一主一从约 30 GB）

**一致性**：L2 由重建服务按变更消息写入（见第五节），写成功后广播 L1 失效；L0 不接收广播，只靠 5 秒 TTL 过期，所以 base 数据最长有约 5 秒延迟。各层一致性取舍的原则见 [缓存架构设计](/high-con/3_cache_architecture)，L1 失效广播的几种实现见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)。

### 2、L0：OpenResty 共享字典

```nginx
lua_shared_dict item_base 256m;

upstream item_detail {
    server 10.0.1.11:8080;
    server 10.0.1.12:8080;
    keepalive 64;
}

server {
    listen 80;

    location ~ ^/api/item/(\d+)/base$ {
        default_type application/json;
        content_by_lua_block {
            local dict = ngx.shared.item_base
            local sku = ngx.var[1]
            local body = dict:get(sku)
            if body then
                ngx.print(body)
                return
            end
            local res = ngx.location.capture("/internal/item/" .. sku .. "/base")
            if res.status == 200 then
                dict:set(sku, res.body, 5)          -- 只缓存 5 秒
                ngx.print(res.body)
                return
            end
            local stale = dict:get_stale(sku)       -- 上游失败：返回已过期但还没被淘汰的旧值
            if stale then
                ngx.print(stale)
                return
            end
            ngx.exit(ngx.HTTP_SERVICE_UNAVAILABLE)
        }
    }

    location /internal/ {
        internal;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_connect_timeout 50ms;
        proxy_read_timeout 200ms;
        proxy_pass http://item_detail;
    }
}
```

- 共享字典由同一台机器的所有 worker 进程共享，一台 Nginx 上一个 SKU 每 5 秒最多回源若干次；需要严格只回源一次时用 `lua-resty-lock` 包住回源
- `get_stale` 是尽力而为的兜底：过期条目在被 LRU 淘汰之前仍可读到，Nginx 重启后全部丢失

### 3、L1：Caffeine 与 L2 回源

```java
@Service
public class ItemBaseCache {

    private final StringRedisTemplate redis;
    private final ItemCacheRebuilder rebuilder;
    private final LoadingCache<Long, byte[]> l1;

    public ItemBaseCache(StringRedisTemplate redis, ItemCacheRebuilder rebuilder) {
        this.redis = redis;
        this.rebuilder = rebuilder;
        this.l1 = Caffeine.newBuilder()
                .maximumWeight(100L * 1024 * 1024)                  // 按字节限制：100 MB
                .weigher((Long skuId, byte[] json) -> json.length)
                .refreshAfterWrite(Duration.ofSeconds(30))          // 30 秒后访问触发异步刷新，刷新失败继续用旧值
                .expireAfterWrite(Duration.ofMinutes(10))           // 旧值最多保留 10 分钟
                .recordStats()
                .build(this::loadFromL2);
    }

    public byte[] get(long skuId) {
        return l1.get(skuId);           // 同一实例内同一 key 并发未命中，只有一个线程执行加载
    }

    public void invalidate(long skuId) { // 由失效广播的订阅者调用
        l1.invalidate(skuId);
    }

    private byte[] loadFromL2(Long skuId) throws InterruptedException {
        String key = ItemCacheRebuilder.key(skuId);
        for (int i = 0; i < 3; i++) {
            Object data = redis.opsForHash().get(key, "data");
            if (data != null) {
                return ((String) data).getBytes(StandardCharsets.UTF_8);
            }
            // L2 也未命中：跨实例只放一个请求回源重建，锁靠 3 秒过期释放
            Boolean locked = redis.opsForValue().setIfAbsent("lock:" + key, "1", Duration.ofSeconds(3));
            if (Boolean.TRUE.equals(locked)) {
                return rebuilder.rebuild(skuId);
            }
            Thread.sleep(50);
        }
        throw new IllegalStateException("item base cache miss: " + skuId);   // 交给上层降级
    }
}
```

- `refreshAfterWrite` + 更长的 `expireAfterWrite` 是 L1 的关键配置：正常情况下 30 秒内刷新一次；Redis 故障时刷新失败，旧值继续可用，最多 10 分钟
- 失效广播到达时直接 `invalidate`，下次访问重新从 L2 加载，所以正常情况下 L1 的延迟取决于广播时延，而不是 30 秒
- 价格、促销这类 dynamic 数据不进 L1 的长缓存，最多按 skuId 缓存 1 秒

---

## 五、数据变更与缓存重建

![数据变更与缓存重建链路](../assets/scenario/product-detail-rebuild.svg)

### 1、变更消息怎么发

商品服务改完数据库后要通知重建服务，有三种发送时机：

| 方式 | 做法 | 问题 |
|------|------|------|
| 事务内发送 | 在 `@Transactional` 方法里直接发 MQ | 事务回滚了消息已经发出，重建服务读到的是旧数据 |
| 提交后发送 | `@TransactionalEventListener(phase = AFTER_COMMIT)` 里发 MQ | 提交后、发送前进程崩溃，这次变更丢失，缓存要等 TTL 才更新 |
| Outbox / CDC | 同一事务写业务表与 outbox 表，由中继投递；或订阅 binlog | 至少投递一次，不丢；需要额外的中继或 CDC 组件 |

缓存有 TTL 兜底时，「提交后发送」能满足大部分商品；改价这类必须及时生效的变更用 Outbox 或 CDC。Outbox 的实现见 [分布式事务](/distributed/4_transaction)（本地消息表一节），MQ 的可靠投递与消费见 [消息队列基础](/messaging/1_basics)，基于 binlog 的缓存失效见 [缓存一致性](/cache/10_cache_consistency)。

消息体只带 `skuId` 与 `version`，**不带商品数据**：重建服务总是回查最新数据，消息丢了一条、重复了一条、乱序了，结果都一样。

### 2、重建服务：合并、回查、版本号

```java
public record ItemSnapshot(long skuId, long version, boolean exists, String json) {}

@Component
public class ItemCacheRebuilder {

    // 新版本号大于已有版本号才覆盖：防止乱序消息或并发重建把旧数据写回
    private static final RedisScript<Long> SET_IF_NEWER = RedisScript.of("""
            local cur = redis.call('HGET', KEYS[1], 'v')
            if cur and tonumber(cur) >= tonumber(ARGV[1]) then
              return 0
            end
            redis.call('HSET', KEYS[1], 'v', ARGV[1], 'data', ARGV[2])
            redis.call('EXPIRE', KEYS[1], ARGV[3])
            return 1
            """, Long.class);

    private final ItemAssembler assembler;      // 回查商品库，组装基础信息快照
    private final StringRedisTemplate redis;

    public ItemCacheRebuilder(ItemAssembler assembler, StringRedisTemplate redis) {
        this.assembler = assembler;
        this.redis = redis;
    }

    public static String key(long skuId) {
        return "item:base:" + skuId;
    }

    public byte[] rebuild(long skuId) {
        ItemSnapshot s = assembler.assemble(skuId);   // 不存在的 SKU 返回 exists=false、version=0 的空快照
        long ttl = s.exists()
                ? Duration.ofDays(7).toSeconds() + ThreadLocalRandom.current().nextLong(86_400)
                : 60;                                  // 空值只缓存 60 秒，防穿透
        Long written = redis.execute(SET_IF_NEWER, List.of(key(skuId)),
                String.valueOf(s.version()), s.json(), String.valueOf(ttl));
        if (Long.valueOf(1L).equals(written)) {
            redis.convertAndSend("item:l1-invalidate", String.valueOf(skuId));
            return s.json().getBytes(StandardCharsets.UTF_8);
        }
        // 没写入说明 Redis 里已经是更新的版本，以 Redis 为准
        Object current = redis.opsForHash().get(key(skuId), "data");
        return (current != null ? (String) current : s.json()).getBytes(StandardCharsets.UTF_8);
    }
}

@Component
public class ItemChangedListener {

    private final ItemCacheRebuilder rebuilder;

    public ItemChangedListener(ItemCacheRebuilder rebuilder) {
        this.rebuilder = rebuilder;
    }

    // 消息 key 为 skuId，同一 SKU 落在同一分区，按顺序到达同一个消费者
    @KafkaListener(topics = "item-changed", groupId = "item-cache-rebuild", batch = "true")
    public void onMessages(List<ConsumerRecord<String, String>> records) {
        // 一批内同一 SKU 改了多次只重建一次；重建总是回查最新数据，合并不会丢更新
        Set<Long> skuIds = new LinkedHashSet<>();
        for (ConsumerRecord<String, String> r : records) {
            skuIds.add(Long.valueOf(r.key()));
        }
        skuIds.forEach(rebuilder::rebuild);
    }
}
```

- **合并重复事件**：商家批量改价、导入时同一 SKU 可能几秒内变更几十次，批量消费后按 skuId 去重，重建次数降为每批一次；配合 `fetch.max.wait.ms` 让一批多攒一点
- **版本号防乱序**：`version` 取商品表的版本列，每次更新加 1。即使两个重建并发执行、后读到新数据的先写入，旧快照也会被脚本拒绝
- **失败重试**：重建抛异常时整批交给 Spring Kafka 的错误处理器重试，重建本身是幂等的，重复执行没有副作用；多次失败进入死信 Topic 并告警
- 示例用 Kafka 批量监听；用 RocketMQ 时同样按 skuId 做顺序消息的 sharding key，批量消费后去重

### 3、多数据源的快照

基础信息、评价摘要、促销规则分别来自不同服务，**各自一个 key、各自一个版本号**（如 `item:base:{skuId}`、`item:review:{spuId}`），由各自的变更消息驱动重建，聚合服务读取时再拼装。合成一个大 key 的话，任何一个来源变化都要重建整个快照，而且多个来源的版本号无法比较。

---

## 六、热点与大促

### 1、预热

大促的爆款是可预知的，开场前按名单逐层预热：

| 层 | 预热方式 |
|----|----------|
| CDN | 调用 CDN 预热接口推送骨架、主图、描述文件 |
| Redis | 重建服务按名单分批执行 `rebuild`，限速以免压垮商品库 |
| L1 / L0 | 聚合服务启动时加载 Top N；Nginx 由预热脚本按名单请求一遍 base 接口 |

预热分批、限速，以及与 K8s 就绪探针的配合见 [缓存架构设计](/high-con/3_cache_architecture)（缓存预热一节）。

### 2、突发热点

直播带货、热搜这类突发热点无法预知，靠实时探测：

- 聚合服务统计 skuId 访问频次，超过阈值的标记为热点，热点 SKU 在 L1 中提高权重或延长刷新间隔
- 热点 SKU 可以把 base 接口的 CDN 缓存打开（如 `Cache-Control: max-age=3`），让 CDN 也承担一部分 base 流量
- 热点探测、本地缓存兜底、key 打散等通用手段见 [热点问题](/high-con/6_hotspot)

### 3、防击穿

热点 SKU 的缓存失效瞬间，大量请求会同时回源。本篇的做法是逐层收敛回源请求：

1. L0：每台 Nginx 上一个 SKU 每 5 秒只回源少数几次（加 `lua-resty-lock` 后为 1 次）
2. L1：Caffeine 的 `get(key)` 对同一 key 只执行一次加载，其余线程等待结果；`refreshAfterWrite` 异步刷新期间继续返回旧值
3. L2：Redis 未命中时用 `SET NX` 锁让全集群只有一个请求回源重建，其余短暂等待后重读

L2 的 key 设 7 天长 TTL 并由重建服务维护，未命中只发生在新商品或被淘汰的冷门商品上，热点商品基本不会走到第 3 步。

---

## 七、降级与兜底

### 1、降级链

| 故障 | 表现 | 兜底 |
|------|------|------|
| 某个 dynamic 依赖超时 | 价格 / 库存 / 促销拿不到 | 返回兜底值：价格显示「加载中」并禁用购买，库存与促销不显示 |
| 评价、推荐等非核心服务故障 | 模块无数据 | 隐藏该模块，不影响主体 |
| Redis 不可用 | L1 刷新失败 | L1 继续返回旧值（最多 10 分钟）；L1 未命中的冷门商品限流回源商品服务 |
| 聚合服务整体故障 | base 接口失败 | Nginx 用 `get_stale` 返回旧值；仍拿不到时前端展示只读兜底页 |
| 全部动态链路故障 | 只剩 CDN | CDN 上的只读兜底页：骨架 + 主图 + 描述，提示「商品信息暂时无法获取」 |

- **Redis 故障时不能把流量直接放给商品服务**：L1 命中的热点继续用旧值，未命中的请求经过限流（如每实例 50 QPS）才回源，超出部分直接返回降级结果，否则商品库会被打垮
- 是否进入降级由熔断器自动判断，也可以由配置中心开关手动打开；大促期间提前把评价、推荐等非核心模块降级，把资源留给核心链路

降级分级与开关见 [降级](/high-avail/6_degradation)，回源限流见 [限流与过载保护](/high-avail/7_rate_limiting)，熔断规则见 [熔断](/high-avail/5_circuit_breaking)。

### 2、依赖超时与隔离

- **分层超时**：Nginx 到聚合服务 200 ms，聚合服务到各依赖 100–150 ms，内层超时必须小于外层，否则外层先超时、内层还在白白执行
- **依赖隔离**：每个下游用独立的并发上限（信号量或独立线程池），评价服务变慢只会耗尽它自己的配额，不会占满价格服务的调用资源
- **不重试或只重试一次**：详情页是读请求，重试可以做，但大促时重试会放大下游压力，优先返回兜底值

超时、重试与隔离的配置方法见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 八、容量估算

以大促峰值**详情页 PV 20 万/秒**为例，每个 PV 发出：静态资源（主要是图片，约 300 KB）、1 次 base 请求、1 次 dynamic 请求，两个接口 gzip 后各约 1 KB。带宽按 1 KB = 1000 B、1 B = 8 bit 换算。

**带宽**：

| 链路 | 计算 | 结果 |
|------|------|------|
| CDN 静态资源 | 200,000 × 300 KB = 60,000,000 KB/s = 60 GB/s；60 × 8 | 约 480 Gbps，只能由 CDN 承担 |
| Nginx 出口 | 200,000 × (1 KB + 1 KB) = 400,000 KB/s = 400 MB/s；0.4 × 8 | 约 3.2 Gbps |

**QPS 与命中率**（L0 命中率 90%，L1 命中率 80%，L2 命中率 99%）：

| 层 | 计算 | QPS |
|----|------|-----|
| Nginx | base 20 万 + dynamic 20 万 | 40 万 |
| 聚合服务（base） | 200,000 × (1 − 90%) | 2 万 |
| Redis（base） | 20,000 × (1 − 80%) | 4,000 |
| 商品服务回源 | 4,000 × (1 − 99%) | 40 |
| 聚合服务（dynamic） | 全部透传 | 20 万 |

整体回源比例 = 10% × 20% × 1% = 0.02%，20 万 × 0.02% = 40 QPS，与逐层计算一致。

**实例数**：

- Nginx：按单台 2 万 QPS 估算，400,000 ÷ 20,000 = 20 台，按 1.5 倍冗余部署 30 台
- 聚合服务：base 2 万 + dynamic 20 万 = 22 万 QPS，按单实例 4,000 QPS 估算，220,000 ÷ 4,000 = 55 个，按 1.5 倍冗余约 83 个
- dynamic 依赖：价格、促销在聚合服务按 skuId 做 1 秒本地缓存后，每个 SKU 打到价格服务的 QPS 上限约等于聚合实例数，83 个实例时单个爆款最多约 83 QPS，与 PV 脱钩

单机 QPS 必须以压测结果为准，上面只是估算方法。峰值预估、冗余系数与全链路压测见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 详情页拆成三部分：静态骨架与图片走 CDN，千人一面的 base 数据走三级缓存，价格、库存、促销走 dynamic 接口并发拉取
- dynamic 依赖各自设超时和兜底值；价格拿不到就不显示并禁用购买，不展示可能过期的价格，下单以结算页为准
- 三级缓存：Nginx 共享字典 5 秒 TTL、Caffeine 按字节限容并用 `refreshAfterWrite` 在故障时保留旧值、Redis 长 TTL 由重建服务维护
- 变更消息只带 skuId 与 version，重建服务批量去重、回查最新数据、用 Lua 脚本按版本号写入，乱序与重复都不会把旧数据写回
- 回源逐层收敛：L0 每台机器少量回源，L1 同 key 单次加载，L2 用 `SET NX` 全局单次重建
- Redis 故障时用 L1 旧值兜底并对回源限流，不能把流量直接放给商品库；最后一层兜底是 CDN 上的只读页

## 参考资料

- 选题参考：doocs/advanced-java：[https://github.com/doocs/advanced-java](https://github.com/doocs/advanced-java)
- lua-nginx-module ngx.shared.DICT：[https://github.com/openresty/lua-nginx-module#ngxshareddict](https://github.com/openresty/lua-nginx-module#ngxshareddict)
- Caffeine Refresh：[https://github.com/ben-manes/caffeine/wiki/Refresh](https://github.com/ben-manes/caffeine/wiki/Refresh)
- Spring for Apache Kafka 批量监听：[https://docs.spring.io/spring-kafka/reference/kafka/receiving-messages/listener-annotation.html](https://docs.spring.io/spring-kafka/reference/kafka/receiving-messages/listener-annotation.html)
- Redis Scripting with Lua：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)

> 返回：[业务场景总览](./0_overview)

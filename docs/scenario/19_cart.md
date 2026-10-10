---
description: 数据模型、Redis Hash 与异步持久化、临时车与登录合并、实时价格库存、上限与结算校验、跨端同步、容量估算
---

# 购物车

> 前置阅读：[商品详情页](./13_product_detail)、[缓存一致性](/cache/10_cache_consistency)、[幂等设计](/architecture/5_idempotence)

购物车看起来只是「用户 + 商品 + 数量」的增删改查，难点在数据量大且写得频繁、未登录也要能用、价格库存随时在变，最终还要交给订单系统做强一致扣减。本篇讲存储（Redis Hash 为主、异步持久化到 MySQL）、临时车合并、展示实时计算与结算校验，核心原则是**购物车只存用户的选择，不存价格和库存的结论，以订单系统为准**。

---

## 一、需求与挑战

### 1、功能范围

| 功能 | 说明 |
|------|------|
| 加购 / 改数量 / 删除 / 勾选 | 最常见的写操作，要求毫秒级响应 |
| 查看购物车 | 按店铺分组，展示实时价格、降价提示、缺货与下架状态、可用优惠 |
| 未登录购物车 | 不登录也能加购，登录后合并到账号下 |
| 跨端同步 | 手机上加购，电脑上打开能看到 |
| 去结算 | 勾选部分商品进入结算页，下单成功后从购物车移除 |

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 写多 | 加购、改数量、勾选都是写，写读比远高于商品详情页 |
| 数据量大 | 千万级用户各有几十个商品，且大部分用户很久不来一次 |
| 数据会变 | 加购之后价格、库存、上下架都可能变化，购物车里存的是旧值 |
| 身份切换 | 未登录时的临时车与账号车要合并，合并要可重试、不重复累加 |
| 多端并发 | 同一账号多个设备同时修改，不能互相覆盖 |
| 大促峰值 | 零点前后大量用户反复刷新购物车、集中去结算 |

---

## 二、整体架构

![购物车整体架构](../assets/scenario/cart-arch.svg)

- **购物车服务**无状态，所有写操作以「操作」而不是「整车快照」提交（加购 1 件、把数量改成 3、勾选某个 SKU），服务端按顺序执行，多端同时操作不会整体覆盖
- **Redis Cluster 是在线数据的主存储**，所有读写都先落在 Redis；持久化任务把有变化的用户异步写入 MySQL，MySQL 用于恢复和冷数据加载
- 价格、库存、商品状态、促销**不存进购物车**，读的时候批量调用对应服务（与 [商品详情页](./13_product_detail) 的 dynamic 接口是同一套依赖）
- 结算与下单交给订单系统，购物车只在下单成功后被动清理已购商品

---

## 三、数据模型

### 1、一行购物车记录有什么

| 字段 | 说明 | 为什么要存 |
|------|------|------------|
| userId / guestId | 归属，已登录用 userId，未登录用临时 ID | 主键的一部分 |
| skuId | 具体规格（颜色、尺码），不是 spuId | 价格、库存都按 SKU 计 |
| 数量 | 1 到单品上限 | 用户的选择 |
| 勾选 | 是否参与结算 | 多端打开时保持一致 |
| 加购时价 | 加购时的成交价（分） | 用来提示「比加入时降了 x 元」，**不用于结算** |
| 加购时间 | 秒级时间戳 | 排序、合并取舍、下单后清理的判断条件 |

店铺、标题、图片都不存：它们由 skuId 查商品服务得到，存了反而要处理变更同步。

### 2、Redis 结构

每个用户一个 Hash，field 是 skuId，value 把四个字段编码成一个短字符串 `数量|勾选|加购时价|加购时间`，如 `2|1|599000|1728460800`：

| key | 类型 | 内容 |
|-----|------|------|
| `cart:{b}:{userId}` | Hash | skuId → `数量\|勾选\|加购时价\|加购时间` |
| `cart:{b}:{userId}:v` | String | 购物车版本号，每次写操作加 1 |
| `cart:{b}:{userId}:req:{requestId}` | String | 写操作的幂等记录，保留 10 分钟 |
| `cart:{b}:dirty` | Hash | 本桶内待刷盘的用户：userId → 版本号 |

- `b = userId % 1024` 是**分桶号**，作为 hash tag 放在 `{}` 里：同一个用户的 4 类 key 与所在桶的脏用户表落在同一个槽，一个 Lua 脚本就能原子地完成「改数据、加版本、记脏标记、写幂等记录」
- 1024 个桶分布到所有分片上，不会形成热点；每个桶约 3000 万 ÷ 1024 ≈ 2.9 万个用户
- value 不用 JSON：短字符串在 64 字节以内，配合商品数上限 120（小于默认的 `hash-max-listpack-entries 128`），Hash 保持 listpack 紧凑编码，内存明显低于 hashtable 编码（见第九节）
- 用版本号 key 是否存在来判断「这个用户的车已经在 Redis 里」：空购物车没有 Hash，但有版本号，不会被误判为需要回库加载

### 3、库表

```sql
CREATE TABLE cart_snapshot (
    user_id    BIGINT       NOT NULL PRIMARY KEY,
    version    BIGINT       NOT NULL,
    items      JSON         NOT NULL,          -- 整车快照：skuId → 编码后的行
    updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
```

每个用户一行整车快照，而不是每个商品一行：刷盘时一条按主键的 upsert 就能写完，配合版本号天然幂等。代价是无法用 SQL 查「哪些用户的购物车里有某个 SKU」，这类分析需求走 binlog 同步到数仓解决。表按 `user_id` 分库分表，方法见 [数据层扩展](/high-con/5_data_scaling)。

---

## 四、存储选型与异步持久化

### 1、两种方案

| 方案 | 做法 | 优点 | 缺点 | 适合 |
|------|------|------|------|------|
| 直接存库 | MySQL 每个商品一行，Redis 只做缓存，先更新库再删缓存 | 数据可靠，实现简单 | 每次加购、勾选都写库，写多时库压力大 | 用户量百万级以内 |
| Redis 为主 + 异步持久化 | 读写都在 Redis，后台按用户合并后批量写库 | 写操作毫秒级，库的写入量被合并后大幅降低 | Redis 主节点宕机可能丢失最后一小段写入 | 千万级用户、写多 |

购物车不是资金数据，极端情况下丢失最后一两秒的加购可以接受（用户重新加一次即可），所以大规模场景选第二种。为了把丢失窗口压小：Redis 开 AOF（`appendfsync everysec`），主从切换后可能丢失尚未复制的写入，这是异步复制的固有代价。分片集群的数据必须常驻内存，`maxmemory-policy` 设为 `noeviction` 并对内存水位告警，**不能让 Redis 自己淘汰还没刷盘的用户数据**。用户量不大时直接存库更省事，缓存一致性按 [缓存一致性](/cache/10_cache_consistency) 的「先更新库再删缓存」处理即可。

### 2、写入：一个 Lua 脚本完成校验与记账

```lua
-- KEYS[1] 购物车 Hash  KEYS[2] 版本号  KEYS[3] 幂等记录  KEYS[4] 本桶脏用户 Hash
-- ARGV[1] skuId  ARGV[2] 加购数量  ARGV[3] 加购时价  ARGV[4] 当前时间  ARGV[5] userId
-- ARGV[6] 商品数上限  ARGV[7] 单品数量上限  ARGV[8] 数据 TTL（秒）
-- 返回：>=1 该商品当前数量；-1 商品数已满；-2 购物车未加载
local done = redis.call('GET', KEYS[3])
if done then
  return tonumber(done)                 -- 重复请求：直接返回上次结果
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  return -2
end
local qty, sel, price, ts = 0, '1', ARGV[3], ARGV[4]
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local q, s, p = string.match(cur, '^(%d+)|(%d)|(%d+)|%d+$')
  qty, sel, price = tonumber(q), s, p          -- 已在车里：保留原加购时价，加购时间刷新为本次
elseif redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[6]) then
  return -1
end
qty = math.min(qty + tonumber(ARGV[2]), tonumber(ARGV[7]))
redis.call('HSET', KEYS[1], ARGV[1], qty .. '|' .. sel .. '|' .. price .. '|' .. ts)
local v = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[4], ARGV[5], v)      -- 记脏标记：值为最新版本号
redis.call('EXPIRE', KEYS[1], ARGV[8])
redis.call('EXPIRE', KEYS[2], ARGV[8])
redis.call('SET', KEYS[3], qty, 'EX', 600)
return qty
```

```java
@Service
@RequiredArgsConstructor
public class CartService {

    static final int MAX_ITEMS = 120, MAX_QTY = 99;
    static final long TTL_SECONDS = Duration.ofDays(30).toSeconds();
    private static final RedisScript<Long> ADD =
            RedisScript.of(new ClassPathResource("lua/cart_add.lua"), Long.class);

    private final StringRedisTemplate redis;
    private final SkuClient skuClient;
    private final CartLoader loader;

    public int add(long userId, long skuId, int qty, UUID requestId) {
        if (qty < 1 || qty > MAX_QTY) {
            throw new IllegalArgumentException("qty out of range: " + qty);
        }
        SkuInfo sku = skuClient.get(skuId);              // 加购时价由服务端查询，不信任客户端
        if (!sku.onShelf()) {
            throw new IllegalStateException("sku off shelf: " + skuId);
        }
        List<String> keys = List.of(CartKeys.items(userId), CartKeys.version(userId),
                CartKeys.request(userId, requestId), CartKeys.dirty(CartKeys.bucket(userId)));
        for (int attempt = 0; attempt < 2; attempt++) {
            Long r = redis.execute(ADD, keys, String.valueOf(skuId), String.valueOf(qty),
                    String.valueOf(sku.priceCent()), String.valueOf(Instant.now().getEpochSecond()),
                    String.valueOf(userId), String.valueOf(MAX_ITEMS), String.valueOf(MAX_QTY),
                    String.valueOf(TTL_SECONDS));
            if (r == -2) {
                loader.loadIfAbsent(userId);             // 冷用户：先从库加载再重试
                continue;
            }
            if (r == -1) {
                throw new CartFullException(MAX_ITEMS);
            }
            return r.intValue();
        }
        throw new IllegalStateException("cart not loaded: " + userId);
    }
}

public final class CartKeys {
    public static final int BUCKETS = 1024;

    public static int bucket(long userId) { return (int) (userId % BUCKETS); }
    public static String items(long userId) { return "cart:{" + bucket(userId) + "}:" + userId; }
    public static String version(long userId) { return items(userId) + ":v"; }
    public static String request(long userId, UUID rid) { return items(userId) + ":req:" + rid; }
    public static String dirty(int bucket) { return "cart:{" + bucket + "}:dirty"; }
}
```

- **「加 1 件」不是天然幂等的**：网络超时后客户端重试会加成 2 件。客户端每次操作生成一个 requestId，幂等记录和数据修改在同一个脚本里原子完成，不存在「记录写了、数据没改」的中间状态。「把数量改成 3」「勾选」「删除」本身就是幂等的，可以不带 requestId。幂等的通用做法见 [幂等设计](/architecture/5_idempotence)
- requestId 拼在用户自己的 key 下面，不同用户的 requestId 碰撞也不会互相影响
- 用 `StringRedisTemplate` 执行脚本，保证参数以纯字符串传入，`tonumber` 能正确解析

### 3、异步刷盘：脏标记 + 版本号

```java
@Component
@RequiredArgsConstructor
public class CartFlusher {

    // 脏标记里的版本仍等于刚刷盘的版本才删除；刷盘期间又有写入则保留，下一轮再刷
    private static final RedisScript<Long> CLEAR_IF_SAME = RedisScript.of("""
            if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
              return redis.call('HDEL', KEYS[1], ARGV[1])
            end
            return 0
            """, Long.class);

    // 新版本大于库中版本才覆盖：items 必须写在 version 之前，用的是旧 version 做比较
    private static final String UPSERT = """
            INSERT INTO cart_snapshot (user_id, version, items) VALUES (:uid, :ver, :items) AS n
            ON DUPLICATE KEY UPDATE
              items   = IF(n.version > cart_snapshot.version, n.items, cart_snapshot.items),
              version = GREATEST(cart_snapshot.version, n.version)
            """;

    private final StringRedisTemplate redis;
    private final JdbcClient jdbc;          // 按 user_id 路由分库，此处省略
    private final JsonMapper json;          // Spring Boot 4 默认的 Jackson 3

    public void flushBucket(int bucket) {
        String dirty = CartKeys.dirty(bucket);
        Map<Object, Object> batch = redis.opsForHash().randomEntries(dirty, 200);
        if (batch == null) {
            return;
        }
        batch.keySet().forEach(uid -> {
            long userId = Long.parseLong((String) uid);
            // 先读版本号再读商品：读到的商品只会比版本号新，下一轮会用更大的版本号重写
            String ver = redis.opsForValue().get(CartKeys.version(userId));
            if (ver == null) {
                redis.opsForHash().delete(dirty, uid);       // 数据已过期，没有可刷的内容
                return;
            }
            Map<Object, Object> items = redis.opsForHash().entries(CartKeys.items(userId));
            jdbc.sql(UPSERT).param("uid", userId).param("ver", Long.parseLong(ver))
                    .param("items", json.writeValueAsString(items)).update();
            redis.execute(CLEAR_IF_SAME, List.of(dirty), (String) uid, ver);
        });
    }
}
```

- **脏标记用 Hash 存版本号而不是 Set**：如果用 `SPOP` 取出用户，进程在写库前崩溃，这个用户的修改就再也不会刷盘；用 `SREM` 在写库后删除，又会把刷盘期间新产生的标记一起删掉。比较版本再删除可以同时避免这两种丢失
- **读取顺序**：先读版本号再读商品。反过来的话，可能把旧商品打上新版本号写入库中，并且脏标记被删掉，新数据永远不会刷盘
- **upsert 幂等**：同一快照重复写、两个任务并发写同一用户、旧快照晚到，结果都由版本号决定，不会把新数据覆盖成旧数据。注意 `ON DUPLICATE KEY UPDATE` 按书写顺序赋值，`items` 必须写在 `version` 前面；`VALUES ... AS n` 别名写法需要 MySQL 8.0.19 及以上
- **调度**：1024 个桶分给多个刷盘实例，每个实例只处理自己的桶（分片方式见 [分布式调度](/distributed/6_job_scheduler)）；日常每 2 秒一轮，大促时放宽到 10 秒，同一用户在一个周期内的多次修改合并为一次写库

### 4、冷数据加载

活跃用户的数据在 Redis 里随每次写入续期 30 天，30 天没碰过的用户自然过期，只留在 MySQL。用户回来时版本号 key 不存在，`CartLoader` 从 `cart_snapshot` 读出快照，用一个脚本「版本号 key 不存在才写入」把整车和版本号写回 Redis：两个请求同时加载时，后到的那个什么都不做，不会覆盖先到请求之后发生的新修改。

---

## 五、未登录购物车与登录合并

### 1、临时车存在哪

| 方式 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| 客户端本地存储 | Web 用 localStorage，App 用本地数据库；登录时整体上传合并 | 服务端零存储；离线可用 | 换设备、清缓存就丢；价格库存仍要请求服务端；Cookie 方式还受 4 KB 限制 |
| 服务端临时车 | 服务端签发 guestId（随机 128 位 + 签名），客户端保存在 Cookie 或设备存储，临时车存 Redis | 与登录车同一套代码；可统计未登录加购 | 要存大量从不登录的临时车，必须设短 TTL |

大多数电商用服务端临时车：Web 端 guestId 放在 HttpOnly Cookie，App 端放设备存储。临时车用 `cart:{g<分桶>}:<guestId>` 存储，TTL 7 天，商品数上限比登录车小（如 50）。**guestId 必须由服务端生成并签名校验**，否则攻击者可以猜测或伪造别人的 guestId，把别人的临时车合并到自己账号下，签名与防篡改见 [API 安全](/security/6_api_security)。

### 2、合并规则

| 情况 | 规则 |
|------|------|
| 只在临时车里 | 加入登录车，保留临时车里的数量、勾选、加购时价 |
| 两边都有同一 SKU | 数量累加，超过单品上限时封顶；勾选状态以临时车为准（用户刚刚选过）；加购时价与时间保留登录车原有的 |
| 合并后超过商品数上限 | 登录车已有的商品优先保留，临时车按加购时间倒序，新加的优先，放不下的不写入并提示用户 |
| 同一次登录重复调用合并 | 只合并一次 |

同一 SKU 也有平台取两边较大值而不是累加，理由是用户可能在两个端都加过同一件；累加的理由是用户明确表达了两次购买意图。两种都可以，关键是规则固定并在页面上给出提示。

### 3、合并实现

![登录后合并临时购物车](../assets/scenario/cart-merge.svg)

临时车和登录车在不同的槽，不能放进同一个脚本。做法是三步，每一步都可以重试：

1. 读出临时车（`HGETALL`），为空直接结束
2. 在登录车所在的槽执行合并脚本：先检查合并标记 `cart:{b}:{userId}:merged:{guestId}`，存在说明已合并过，直接返回；否则按上表规则逐个 SKU 写入，加版本号、记脏标记，**最后写入合并标记**（TTL 1 天），整个脚本原子执行
3. 删除临时车

第 2 步之后、第 3 步之前进程崩溃，客户端重试时会再走一遍：合并标记让第 2 步变成空操作，第 3 步补上删除，不会出现数量被累加两次。合并标记和数据修改在同一个脚本里，与上一节的幂等记录是同一种思路。

---

## 六、价格与库存的实时性

购物车里存的加购时价只用来比较，页面上显示的价格、库存、状态每次都实时查询：

```java
public record CartLine(long skuId, int qty, boolean selected, long addPriceCent, long addTime) {}

public record SkuInfo(long priceCent, boolean onShelf) {}

public enum LineState { NORMAL, PRICE_DROP, OUT_OF_STOCK, OFF_SHELF, UNKNOWN }

public record CartLineView(CartLine line, Long priceCent, LineState state, boolean checkable) {}

public List<CartLineView> view(List<CartLine> lines) {
    List<Long> skuIds = lines.stream().map(CartLine::skuId).toList();
    var infos = CompletableFuture.supplyAsync(() -> skuClient.batchGet(skuIds), executor)
            .completeOnTimeout(Map.of(), 150, TimeUnit.MILLISECONDS)
            .exceptionally(e -> Map.of());
    var stocks = CompletableFuture.supplyAsync(() -> stockClient.batchStatus(skuIds), executor)
            .completeOnTimeout(Map.of(), 100, TimeUnit.MILLISECONDS)
            .exceptionally(e -> Map.of());
    Map<Long, SkuInfo> info = infos.join();
    Map<Long, StockStatus> stock = stocks.join();
    return lines.stream().map(l -> {
        SkuInfo s = info.get(l.skuId());
        if (s == null) {
            return new CartLineView(l, null, LineState.UNKNOWN, false);       // 价格未知：不可勾选
        }
        if (!s.onShelf()) {
            return new CartLineView(l, s.priceCent(), LineState.OFF_SHELF, false);
        }
        if (stock.get(l.skuId()) == StockStatus.OUT_OF_STOCK) {
            return new CartLineView(l, s.priceCent(), LineState.OUT_OF_STOCK, false);
        }
        LineState st = s.priceCent() < l.addPriceCent() ? LineState.PRICE_DROP : LineState.NORMAL;
        return new CartLineView(l, s.priceCent(), st, true);
    }).toList();
}
```

- **批量查询**：一车最多 120 个 SKU，一次批量调用而不是 120 次单查；价格、库存服务按 SKU 做 1 秒本地缓存，热门 SKU 被千万人加购时查询量与用户数脱钩
- **价格拿不到就不显示**：与详情页一样，宁可显示「价格加载中」并禁止勾选，也不显示可能过期的价格；库存拿不到时不标缺货，允许勾选，到结算页再校验
- **降价提示**：当前价低于加购时价时显示「比加入时降 x 元」，这是购物车提升转化的常用手段；涨价一般不主动提示
- 促销（满减、跨店优惠）按勾选的商品实时试算，促销服务超时就不显示优惠，不影响结算
- **为什么不存当前价**：存了就要处理变更同步，一个热门 SKU 改价要更新几百万个购物车；只存加购时价，改价对购物车零写入。库存同理只展示「有货 / 缺货」，**真正的扣减发生在下单时**，见 [订单](./5_order_system) 与 [秒杀](./4_seckill)

---

## 七、上限与结算校验

### 1、数量与商品数上限

| 上限 | 示例值 | 原因 |
|------|--------|------|
| 单品数量 | 99，或取该 SKU 的限购数 | 防误操作；大额采购走企业通道 |
| 登录车商品种数 | 120 | 页面渲染与批量查价的成本；保持 Hash 为 listpack 编码 |
| 临时车商品种数 | 50 | 临时车数量多、生命周期短 |
| 单次结算商品种数 | 50 | 一次下单要拆单、算优惠，种数太多耗时不可控 |

上限在写入脚本里原子校验，前端校验只是体验优化。商品数超限时返回明确的错误码，前端提示「购物车已满，请先清理」。

### 2、结算时校验

![结算校验与下单后清理](../assets/scenario/cart-checkout.svg)

购物车页展示的一切都只是参考，**进入结算页和提交订单时各校验一次**：

| 校验项 | 内容 | 不通过时 |
|--------|------|----------|
| 商品状态 | 是否下架、是否可售、收货地址是否可配送 | 从本次结算中移除并提示 |
| 价格 | 重新取当前价，按活动规则算成交价 | 以当前价为准，与页面不一致时提示 |
| 库存 | 查询可售库存是否足够（不扣减） | 提示库存不足，可调整数量 |
| 优惠 | 优惠券是否可用、满减门槛是否满足 | 重新试算，用不了的券不选中 |
| 限购 | 该用户该 SKU 的历史购买量 + 本次数量是否超限 | 提示限购数量 |

提交订单时客户端带上结算页确认的应付总额，服务端重新计算后比对，**不一致就拒绝下单**并返回新价格，避免用户在不知情的情况下以更高价格成交。库存扣减、建单、锁券在订单服务的本地事务里完成，见 [订单](./5_order_system)。

### 3、下单后清理

订单创建成功后才能从购物车删除已购商品，否则下单失败用户的购物车就空了。订单服务在建单事务里写 outbox，提交后投递「订单已创建」消息（或用 RocketMQ 事务消息），购物车服务消费后删除对应 SKU，可靠投递见 [消息队列基础](/messaging/1_basics)。

- 删除脚本只删**加购时间早于下单时间**的行：用户下单后马上又加购了同一 SKU，加购脚本会把这一行的加购时间刷新为当前时间，清理消息晚到时这一行不会被整行删除，只扣减本次下单的数量，减到 0 才删除
- 删除本身幂等，重复消息再执行一次没有副作用；同样要加版本号、记脏标记

---

## 八、大促与跨端同步

### 1、大促高并发读写

| 压力 | 应对 |
|------|------|
| 购物车页反复刷新 | 读只访问 Redis 和价格库存服务的本地缓存；购物车角标（商品数）用 `HLEN`，单独接口，客户端缓存几秒 |
| 热门 SKU 查价 | 价格、库存服务按 SKU 做本地缓存，查询量与加购人数脱钩，见 [热点问题](/high-con/6_hotspot) |
| 写入集中 | key 按用户分散在 1024 个桶，没有单 key 热点；刷盘周期临时放宽，写库量随之下降 |
| 零点集中去结算 | 结算与下单接口单独限流，超出部分排队或提示稍后再试，见 [限流与过载保护](/high-avail/7_rate_limiting) |
| 依赖变慢 | 降价提示、凑单推荐、跨店优惠试算这类非核心功能提前降级，保证增删改查和去结算可用 |

### 2、跨端同步

- **服务端是唯一数据源**：各端不保存完整的购物车副本，打开购物车页、从后台切回前台时都向服务端拉取
- **用版本号省流量**：客户端带上本地的版本号请求，与服务端版本相同就返回「未变化」，不同才返回整车数据
- **以操作提交，按 SKU 后写为准**：A 端把某 SKU 改成 3 件、B 端改成 5 件，服务端按到达顺序执行，结果是 5；不会出现一端用旧的整车快照覆盖另一端全部修改的问题
- **需要实时同步时推送通知**：已有长连接的 App（如消息、客服通道）可以在购物车变更后推送一条「购物车版本 N」，其他端收到后拉取。推送只是通知，丢了也只是延迟到下次打开时同步，长连接的实现见 [WebSocket](/netty/10_websocket) 与 [心跳与连接管理](/netty/9_heartbeat)

---

## 九、容量估算

假设注册用户 2 亿，购物车非空的活跃用户 3000 万，平均每人 20 个商品。存储按 1 KB = 1024 B 换算。

**Redis 内存**：

| 项 | 计算 | 结果 |
|----|------|------|
| 单个商品 | field（skuId）约 10 B + value 约 22 B + listpack 条目开销约 8 B | 约 40 B |
| 单个用户 | 20 × 40 B = 800 B，加上 Hash key、版本号 key、过期时间等开销约 200 B | 约 1 KB |
| 全量 | 30,000,000 × 1 KB = 30,000,000 KB；30,000,000 ÷ 1024 ÷ 1024 | 约 28.6 GB |
| 部署 | 一主一从 28.6 × 2 = 57.2 GB；按 16 个主分片 | 每个主分片约 1.8 GB |

如果 value 超过 64 字节或商品数超过 128，Hash 会转成 hashtable 编码，每个 field 额外多出几十字节的指针与对象开销，同样的数据内存会翻倍以上，这就是 value 用短字符串、商品数上限定为 120 的原因。编码转换规则见 [Redis 基础](/cache/1_redis_base)。

**MySQL 存储**：3000 万行，每行快照约 1 KB JSON 加行开销约 0.1 KB，30,000,000 × 1.1 KB = 33,000,000 KB ≈ 31.5 GB；按 16 个库、每库 16 张表共 256 张表，每表 30,000,000 ÷ 256 ≈ 11.7 万行，单表很小，分库主要是为了分摊写入。

**大促 QPS**（峰值读 20 万 QPS、写 5 万 QPS）：

| 层 | 计算 | 结果 |
|----|------|------|
| Redis 读 | 每次读 = 读版本号 + `HGETALL`，用 pipeline 一次往返；200,000 × 2 | 40 万命令/秒 |
| Redis 写 | 每次写 1 个脚本 | 5 万脚本/秒 |
| 每个主分片 | (400,000 + 50,000) ÷ 16 | 约 2.8 万/秒，低于单分片约 10 万的经验值 |
| MySQL 写入（最坏） | 刷盘完全没有合并：50,000 ÷ 16 库 | 每库约 3,125 次/秒按主键 upsert |
| MySQL 写入（合并后） | 刷盘周期 10 秒内同一用户平均操作 3 次：50,000 ÷ 3 ÷ 16 | 每库约 1,042 次/秒 |

购物车服务按单实例 4,000 QPS 估算，(200,000 + 50,000) ÷ 4,000 = 62.5，取 63 个，按 1.5 倍冗余约 95 个。以上单机数值都要以压测为准，估算方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 购物车只存用户的选择（SKU、数量、勾选、加购时价、加购时间），价格、库存、状态展示时实时查，结算时再校验，以订单系统为准
- 大规模场景用 Redis Hash 做在线主存储，用户分桶号做 hash tag，一个 Lua 脚本原子完成校验上限、修改数据、加版本号、记脏标记与幂等记录
- 异步刷盘用「脏标记存版本号 + 比较后删除」和「按版本号 upsert 整车快照」，进程崩溃、并发刷盘、乱序写入都不会丢数据或写回旧数据；Redis 内存不能被淘汰策略清掉未刷盘的数据
- 未登录用服务端签名的 guestId 存临时车，登录后三步合并，合并标记与数据修改在同一个脚本里，重试不会重复累加
- 结算页与提交订单各校验一次价格、库存、优惠、状态与限购，金额不一致就拒绝下单；下单成功的消息到达后才清理购物车，且只删下单前加购的行
- 多端以操作提交、服务端按顺序执行，客户端用版本号判断是否需要重新拉取，长连接推送只作为变更通知

结算之后的扣减与状态流转见 [订单](./5_order_system)。

## 参考资料

- 选题参考：doocs/advanced-java：[https://github.com/doocs/advanced-java](https://github.com/doocs/advanced-java)
- Redis Hashes：[https://redis.io/docs/latest/develop/data-types/hashes/](https://redis.io/docs/latest/develop/data-types/hashes/)
- Redis 内存优化（小对象紧凑编码）：[https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- Redis 持久化：[https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- MySQL INSERT ... ON DUPLICATE KEY UPDATE：[https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html](https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html)
- Spring Data Redis Scripting：[https://docs.spring.io/spring-data/redis/reference/redis/scripting.html](https://docs.spring.io/spring-data/redis/reference/redis/scripting.html)

> 返回：[业务场景总览](./0_overview)

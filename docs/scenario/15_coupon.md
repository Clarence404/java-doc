---
description: 券模板与券实例、三种发券方式、Lua 原子领券与异步落库、防刷、锁券核销回退、叠加与分摊、过期处理、大促容量
---

# 优惠券和营销

> 前置阅读：[秒杀](./4_seckill)、[订单](./5_order_system)、[幂等方案总结](/architecture/5_idempotence)

优惠券同时有两种难题：**发券**像秒杀，库存有限、瞬时并发高；**用券**是订单链路的一环，状态要随支付、关单、退款正确流转（金额单位统一为「分」，用 `long`）。本篇按「模型 → 发券 → 防刷 → 用券 → 计价 → 过期 → 大促」的顺序展开。

---

## 一、需求与挑战

### 1、常见券类型

| 类型 | 规则示例 | 计算方式 |
|------|----------|----------|
| 满减券 | 满 200 元减 30 元 | 适用商品金额 ≥ 门槛时，优惠 = 面额 |
| 折扣券 | 85 折，最高减 50 元 | 优惠 = min(适用金额 × 15%，上限) |
| 无门槛券 | 立减 5 元 | 优惠 = min(面额，适用金额) |
| 运费券 | 抵扣运费 10 元 | 只作用于运费，不参与商品分摊 |

每种券还有**适用范围**（全场、店铺、类目、指定商品）和**出资方**（平台券由平台承担，店铺券由商家承担），这两点决定了计价时哪些商品行参与、结算时谁来付这笔钱。

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 不超发 | 库存 100 万张，大促 0 点几百万人同时抢，发出的券不能超过 100 万 |
| 不超领 | 每人限领 N 张，用户连点、脚本并发都不能突破 |
| 领到必落库 | 领券先在 Redis 成功，异步落库，任何一步失败都不能让用户「领到了却查不到」 |
| 状态正确 | 下单锁券、支付核销、关单解锁、退款返还，在消息重复、乱序时不能把券弄错 |
| 计价精确 | 多券叠加、门槛逐层判断，优惠要分摊到每个商品行，不能差一分钱 |

---

## 二、整体架构

![优惠券系统整体架构](../assets/scenario/coupon-arch.svg)

- **券服务**无状态，领券走 Redis，用券走 MySQL：领券是「抢库存」，写入集中在一个模板上，需要 Redis 的原子性和吞吐；用券是「改自己的券」，天然按用户分散，直接在数据库上做条件更新即可
- **券实例按 `user_id` 分库分表**：券包查询、结算页选券、锁券都带着 `user_id`，单用户的请求只落在一个分片
- **订单与券的交互**：下单时订单服务同步调用锁券（必须当场知道成败）；支付成功、关单、退款等后续变化由订单服务通过 Outbox 发事件，券服务消费后改状态，见 [订单](./5_order_system) 的分布式事务一节

---

## 三、券模板与券实例

### 1、两层模型

- **券模板**（coupon_template）：运营配置的一种券，包含面额、门槛、范围、总量、限领、有效期；万级，单库加本地缓存
- **券实例**（coupon）：发到某个用户手里的一张券；百亿级，按 `user_id` 分库分表

模板**发布后核心字段不可修改**（面额、门槛、范围）：已经发出去的券要按领取时的规则使用，改规则等于改了用户手里的券。要调整就下线旧模板、新建一个。

### 2、表结构

```sql
CREATE TABLE coupon_template (
  id              BIGINT PRIMARY KEY,
  type            VARCHAR(16) NOT NULL,   -- FULL_REDUCTION / DISCOUNT / NO_THRESHOLD / SHIPPING
  threshold_cent  BIGINT NOT NULL DEFAULT 0,
  value_cent      BIGINT NOT NULL DEFAULT 0,      -- 满减、无门槛的面额
  discount_pct    INT    NOT NULL DEFAULT 100,    -- 折扣券：85 表示 85 折
  max_off_cent    BIGINT NOT NULL DEFAULT 0,      -- 折扣券单张最高优惠
  scope_type      VARCHAR(16) NOT NULL,           -- ALL / SHOP / CATEGORY / SKU，配合 scope_ids
  scope_ids       JSON NULL,
  stack_level     VARCHAR(16) NOT NULL,           -- SHOP / PLATFORM / SHIPPING：叠加层级
  total_count     INT NOT NULL,
  per_user_limit  INT NOT NULL DEFAULT 1,
  claim_start     DATETIME NOT NULL,
  claim_end       DATETIME NOT NULL,
  valid_type      VARCHAR(16) NOT NULL,           -- FIXED：固定区间；RELATIVE：领取后 valid_days 天
  valid_start     DATETIME NULL, valid_end DATETIME NULL, valid_days INT NULL,
  status          VARCHAR(16) NOT NULL            -- DRAFT / PUBLISHED / OFFLINE
);

-- 分表：coupon_00 ~ coupon_63，按 user_id 路由
CREATE TABLE coupon (
  id           BIGINT PRIMARY KEY,                -- 雪花 ID，领券时预先生成
  template_id  BIGINT       NOT NULL,
  user_id      BIGINT       NOT NULL,
  issue_key    VARCHAR(96)  NOT NULL,             -- 发放键：同一次发放只能落一张券
  status       VARCHAR(16)  NOT NULL,             -- UNUSED / LOCKED / USED / EXPIRED / INVALID
  valid_start  DATETIME     NOT NULL,
  valid_end    DATETIME     NOT NULL,
  lock_biz_no  VARCHAR(64)  NULL,                 -- 锁定它的下单请求号
  order_id     BIGINT       NULL,
  locked_at    DATETIME     NULL,
  used_at      DATETIME     NULL,
  UNIQUE KEY uk_issue_key (issue_key),
  KEY idx_user_status (user_id, status, valid_end),
  KEY idx_status_end (status, valid_end)
);
```

- **`issue_key` 是发券幂等的关键**，不同发券方式各有构造规则（见第四节），同一次发放无论重试多少次都只能插入一行；同一个发放键必然对应同一个用户、路由到同一张分表，所以分表后唯一约束依然有效
- 有效期在**领取时算好写进实例**：固定区间直接拷贝模板的起止时间，「领取后 7 天」则按领取时间计算，之后过期判断只看实例自己的 `valid_end`
- 券 ID 由雪花算法生成（见 [分布式 ID 生成](/distributed/8_id_generator)）；只凭券 ID 查券的场景较少，需要时可以把 `user_id` 的分片位嵌进 ID

---

## 四、发券

### 1、三种发券方式

| 方式 | 场景 | 并发特点 | `issue_key` |
|------|------|----------|-------------|
| 主动领 | 领券中心、商品页「领券」按钮 | 瞬时高并发，集中在热门模板 | `C:{模板}:{用户}:{第几张}` |
| 批量发 | 运营圈选 500 万老用户定向发券 | 量大但可控速 | `B:{发券任务}:{用户}` |
| 活动自动发 | 注册送券包、支付成功返券 | 跟随业务事件 | `E:{模板}:{来源业务单号}` |

### 2、主动领：一个 Lua 脚本完成扣库存与限领

![高并发领券链路](../assets/scenario/coupon-claim-flow.svg)

库存判断、每人限领判断、扣库存、累加已领数、写待落库记录，必须在**一个脚本里原子完成**。分成多次调用就会出现「库存扣了但已领数没加」之类的中间状态，并发下限领也会被突破。

```lua
-- KEYS[1] = coupon:{tplId}:stock    KEYS[2] = coupon:{tplId}:claimed（userId -> 已领张数）
-- KEYS[3] = coupon:{tplId}:pending（couponId -> userId:seq:时间戳，待落库记录）
-- ARGV[1] = userId  ARGV[2] = 每人限领  ARGV[3] = couponId  ARGV[4] = 当前毫秒时间
-- 返回：>0 本次是该用户领的第几张；-1 已领完；-2 已达限领；-3 未预热
local stock = redis.call('GET', KEYS[1])
if not stock then
  return -3
end
if tonumber(stock) <= 0 then
  return -1
end
local cnt = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if cnt >= tonumber(ARGV[2]) then
  return -2
end
redis.call('DECR', KEYS[1])
local seq = redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('HSET', KEYS[3], ARGV[3], ARGV[1] .. ':' .. seq .. ':' .. ARGV[4])
return seq
```

```java
@Service
@RequiredArgsConstructor
public class CouponClaimService {

    private static final RedisScript<Long> CLAIM =
            RedisScript.of(new ClassPathResource("lua/coupon_claim.lua"), Long.class);

    private final StringRedisTemplate redis;
    private final RocketMQTemplate mq;
    private final IdGenerator idGenerator;
    private final TemplateCache templates;          // 模板规则的本地缓存

    public ClaimResult claim(long userId, long templateId) {
        CouponTemplate t = templates.get(templateId);
        if (!t.claimableAt(Instant.now())) {
            return ClaimResult.fail("不在领取时间内");
        }
        long couponId = idGenerator.nextId();
        long now = System.currentTimeMillis();
        String tag = "coupon:{" + templateId + "}:";            // hash tag：三个 key 落在同一个槽
        Long seq = redis.execute(CLAIM, List.of(tag + "stock", tag + "claimed", tag + "pending"),
                String.valueOf(userId), String.valueOf(t.perUserLimit()),
                String.valueOf(couponId), String.valueOf(now));
        int code = seq == null ? -3 : seq.intValue();
        if (code < 0) {
            return ClaimResult.fail(code == -1 ? "券已领完" : code == -2 ? "已达领取上限" : "活动未开始");
        }
        CouponClaimed msg = new CouponClaimed(couponId, templateId, userId, code, now);
        try {
            mq.syncSend("coupon-claimed", MessageBuilder.withPayload(msg)
                    .setHeader(RocketMQHeaders.KEYS, couponId).build(), 3000);
        } catch (MessagingException e) {
            // 不回补库存：待落库记录还在 Redis 里，补发任务会用同一个 couponId 重发
        }
        return ClaimResult.ok(couponId);
    }
}
```

- 与 [秒杀](./4_seckill) 的 Lua 一样：key 不存在时 `GET` 返回 `false` 要先判断；`HGET` 不存在也返回 `false`，用 `or '0'` 兜底；Cluster 下用 `{tplId}` 做 hash tag。**脚本返回成功就算领到**，`pending` 哈希相当于放在 Redis 里的发件箱：只要记录还在，这张券就一定会被投递落库

### 3、异步落库与补发

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(topic = "coupon-claimed", consumerGroup = "coupon-persist")
public class CouponClaimedListener implements RocketMQListener<CouponClaimed> {

    private final CouponMapper couponMapper;
    private final TemplateCache templates;
    private final StringRedisTemplate redis;

    @Override
    public void onMessage(CouponClaimed m) {
        CouponTemplate t = templates.get(m.templateId());
        String issueKey = "C:" + m.templateId() + ":" + m.userId() + ":" + m.seq();
        try {
            couponMapper.insert(Coupon.issued(m.couponId(), t, m.userId(), issueKey,
                    Instant.ofEpochMilli(m.claimedAt())));   // 有效期按领取时间计算
        } catch (DuplicateKeyException e) {
            // 重复消息（同一 couponId）或同一发放键已落库：视为已处理
        }
        // 落库之后再删待落库记录；删除失败只会导致一次多余的补发，插入仍然幂等
        redis.opsForHash().delete("coupon:{" + m.templateId() + "}:pending", String.valueOf(m.couponId()));
    }
}
```

- **补发任务**：每分钟 `HSCAN` 各模板的 `pending`，记录里的时间戳超过 1 分钟仍在的，用原来的 `couponId` 重发消息。发送失败、进程在发送前崩溃、消费失败进入重试，都会被它兜住
- **为什么不回补库存**：发送超时不代表消息没到，如果回补了库存而消息其实已经落库，就会多发一张。只向前重发、不回滚，配合落库幂等，就不存在这个竞态。这与秒杀「发送失败回补 + 对账」的思路不同，原因是券的 `pending` 记录本身就是可靠的待办清单
- **每人限领的数据库兜底**：`issue_key` 里的 `seq` 来自 `HINCRBY`，取值只会是 1 到限领数。即使 Redis 主从切换丢了已领计数，用户再领时得到的 `seq` 会与已落库的重复，撞唯一键被丢弃，不会多出一张；这次扣掉的 Redis 库存由对账回补
- Redis 开启 AOF（`appendfsync everysec`），主从切换仍可能丢掉最后约 1 秒的 `pending`，表现为少发，由对账发现后补发；领券到落库通常在 1 秒内，落库前券包查不到时前端提示「券已到账」

### 4、批量发与活动自动发

- **批量发**：运营提交发券任务，任务按用户分段拆成子任务，每个子任务记录游标；每批 500 个用户一条多行 `INSERT ... ON DUPLICATE KEY UPDATE id = id`，任务中断后从游标重跑，已插入的行撞 `issue_key` 被忽略。按写库能力限速，例如 20 个并发 worker、每个每秒 1 批 500 行，即 10,000 行/秒，500 万用户需要 5,000,000 ÷ 10,000 = 500 秒，约 8.3 分钟
- **活动自动发**：订单服务在支付成功时通过 Outbox 发出事件，券服务消费后发「返券」，`issue_key` 带上订单号，重复消息撞唯一键；有总量限制的返券模板同样走第 2 小节的 Lua 扣库存

### 5、对账

活动结束后（进行中每 10 分钟一次）按模板核对：**Redis 剩余库存 + 待落库记录数 + 数据库已落库张数 = 总量**。数据库张数需要汇总所有分片，量大时从 binlog 同步到数仓统计。不相等时告警，少发的部分补发或回补库存。模板表不逐张维护 `issued_count`：100 万张券都去更新同一行，会让这一行成为写热点，见 [热点问题](/high-con/6_hotspot) 的写热点一节。

---

## 五、防刷

| 手段 | 位置 | 拦截什么 |
|------|------|----------|
| 登录 + 限流 | 网关 | 未登录请求；按用户、IP、设备的高频请求，见 [限流与过载保护](/high-avail/7_rate_limiting) |
| 风控评分 | 领券前 | 新注册账号、模拟器 / 改机设备、同一 IP 段大量账号；高风险拒绝，中风险加验证码 |
| 设备指纹限领 | Lua 脚本 | 新人券等高价值券在用户维度之外再加设备维度计数，一台设备只能领一次 |
| 接口签名与防重放 | 网关 | 脚本伪造、重放领券请求，见 [API 安全](/security/6_api_security) |
| 用券时再校验 | 锁券前 | 同一收货地址、同一支付账号在同一活动的核销次数，羊毛党往往在使用环节才暴露 |

**券码兑换防爆破**：兑换码必须是随机高熵串，不能用自增编号。16 位、字符集 32 个时共有 32^16 = 2^80 ≈ 1.2 × 10^24 种组合，发出 1000 万个码，随机猜中一个的概率约为 10^7 ÷ 1.2 × 10^24 ≈ 8.3 × 10^-18；再对同一用户、同一 IP 的兑换失败次数限流，连续失败直接冻结兑换功能。

防刷的原则是**分层、可降级**：风控服务超时不能拖垮领券，超时按中风险处理（加验证码）而不是直接放行或直接拒绝。

---

## 六、用券：锁券、核销、回退

![券实例状态流转](../assets/scenario/coupon-state.svg)

### 1、状态机

下单锁券（UNUSED → LOCKED），支付成功核销（LOCKED → USED），取消或超时关单解锁（LOCKED → UNUSED），整单退款时仍在有效期内返还为 UNUSED、否则直接 EXPIRED；未使用的券到期变 EXPIRED，被风控判定或发错时由运营作废为 INVALID。

所有状态变化都写成**带原状态与归属条件的 `UPDATE`**，影响 1 行才算成功。重复消息再执行一次影响 0 行，天然幂等，见 [幂等方案总结](/architecture/5_idempotence) 的条件更新一节。

### 2、锁券：同步、幂等

下单流程里订单服务以下单请求号 `biz_no` 调用锁券（流程见 [订单](./5_order_system) 的下单一节）：

```sql
UPDATE coupon
SET status = 'LOCKED', lock_biz_no = #{bizNo}, locked_at = NOW()
WHERE id = #{couponId} AND user_id = #{userId} AND status = 'UNUSED'
  AND valid_start <= NOW() AND valid_end > NOW();
```

- 影响 0 行时再按券 ID 查一次：状态是 `LOCKED` 且 `lock_biz_no` 等于本次 `biz_no`，说明是同一下单请求的重试，必须返回成功，否则下单重试会失败；其他情况（被别的订单锁定、已用、已过期）返回「优惠券不可用」
- 锁券条件里直接带 `valid_end > NOW()`，**过期判断不依赖过期任务是否已经跑过**

### 3、核销与回退：消费订单事件

```sql
-- 支付成功：核销
UPDATE coupon SET status = 'USED', order_id = #{orderId}, used_at = NOW()
WHERE id = #{couponId} AND status = 'LOCKED' AND lock_biz_no = #{bizNo};

-- 取消 / 关单：解锁
UPDATE coupon SET status = 'UNUSED', lock_biz_no = NULL, locked_at = NULL
WHERE id = #{couponId} AND status = 'LOCKED' AND lock_biz_no = #{bizNo};

-- 整单退款：返还，已过有效期的直接置为过期
UPDATE coupon
SET status = IF(valid_end > NOW(), 'UNUSED', 'EXPIRED'), order_id = NULL, lock_biz_no = NULL
WHERE id = #{couponId} AND status = 'USED' AND order_id = #{orderId};
```

- **条件里带上 `lock_biz_no` / `order_id`，防止 ABA**：券被订单 A 锁定、关单解锁后又被订单 B 锁定，此时订单 A 的关单消息重复到达，如果条件只有 `status = 'LOCKED'` 就会把订单 B 的券解锁
- 支付成功事件到达时核销影响 0 行，要再查一次：已经是 `USED` 且 `order_id` 相同说明是重复消息；否则记录异常并告警，不能静默丢弃
- 这些事件由订单服务在本地事务中写 Outbox 后投递，**不在事务提交前发送**；也可以用 RocketMQ 事务消息，回查时本地事务仍在进行中要返回 `UNKNOWN` 而不是回滚，见 [RocketMQ](/messaging/3_rocketmq) 的事务消息一节与 [消息队列基础](/messaging/1_basics) 的分布式事务一节
- **部分退款不返还券**：退款金额按该商品行分摊后的实付计算（见第七节），只有整单全部退完才返还。这是本文采用的业务规则，不同平台规则可能不同，但必须事先定死，否则退款金额算不清

### 4、悬挂锁券

订单服务锁券成功后、插入订单前宕机，券会一直停在 `LOCKED`。补偿任务每 10 分钟扫描 `locked_at` 超过 30 分钟（大于 15 分钟支付超时再留余量）的 `LOCKED` 券，按 `lock_biz_no` 向订单服务确认：没有对应订单就解锁，有订单就按订单状态处理。这与库存服务处理悬挂预占的方式相同，TCC 中的悬挂问题见 [分布式事务](/distributed/4_transaction)。

---

## 七、优惠计算

### 1、叠加规则

优惠按固定层级逐层计算，**每一层的门槛用上一层优惠之后的金额判断**，同一层级的券互斥：

| 顺序 | 层级 | 规则 | 示例（商品原价 300 元） |
|------|------|------|------------------------|
| 1 | 商品级 | 单品直降、会员价 | 直降 20 元 → 280 元 |
| 2 | 店铺级 | 每个店铺最多一张店铺券 | 满 200 减 20 → 260 元 |
| 3 | 平台级 | 每单最多一张平台券 | 满 250 减 30（260 ≥ 250）→ 230 元 |
| 4 | 运费 | 运费券只抵运费 | 运费 10 元 → 0 元 |

- 计价**只在服务端进行**：结算页展示和提交订单时各算一次，以提交时的服务端结果为准，前端传来的金额一律不信任；下单时把计价结果（每层用了哪张券、各优惠多少）快照到订单上，之后退款、对账都以快照为准

### 2、分摊到商品行

一张券的优惠要分到它适用的每个商品行上，原因有三：**部分退款**时要知道这一行实际付了多少；**商家结算**时要区分平台券和店铺券由谁出资；**开票**按行开具实付金额。

按行金额比例分摊会有除不尽的尾差。用**最大余额法**：先全部向下取整，剩下不足行数的几分钱，按余数从大到小每行补 1 分。这样每行分到的优惠不会超过该行金额，总和精确等于券的优惠。

```java
public record PricedLine(long skuId, long amountCent) {}

public final class DiscountAllocator {

    private DiscountAllocator() {}

    /** 把一张券的优惠按行金额比例分摊，单位：分 */
    public static long[] allocate(List<PricedLine> lines, long discountCent) {
        long total = lines.stream().mapToLong(PricedLine::amountCent).sum();
        if (discountCent < 0 || discountCent > total) {
            throw new IllegalArgumentException("discount out of range");
        }
        int n = lines.size();
        long[] share = new long[n];
        if (discountCent == 0) {
            return share;
        }
        long[] remainder = new long[n];
        long allocated = 0;
        for (int i = 0; i < n; i++) {
            long product = Math.multiplyExact(discountCent, lines.get(i).amountCent());
            share[i] = product / total;                  // 先向下取整
            remainder[i] = product % total;
            allocated += share[i];
        }
        // 剩余不足 n 分：余数大的先补；余数相同按行号，保证同样输入得到同样结果
        List<Integer> order = IntStream.range(0, n).boxed()
                .sorted(Comparator.comparingLong((Integer i) -> remainder[i]).reversed()
                        .thenComparingInt(i -> i))
                .toList();
        for (int k = 0; k < discountCent - allocated; k++) {
            share[order.get(k)]++;
        }
        return share;
    }
}
```

例：三行金额 3333、3333、3334 分（合计 10000 分），优惠 1000 分。按比例分别是 333.3、333.3、333.4，向下取整得 333、333、333，合计 999，剩 1 分；第三行余数最大（3334 × 1000 mod 10000 = 4000，前两行为 3000），补给第三行，结果 333、333、334，合计 1000。

多层优惠逐层分摊：先分店铺券（只在本店铺的行之间分），再分平台券（在平台券适用的所有行之间按**店铺券后的金额**分），每行最终实付 = 原价 − 各层分摊之和。

### 3、精度

- 金额全部用 `long` 存「分」，**不用 `double`**（`0.1 + 0.2` 在二进制浮点下不等于 `0.3`）；折扣券的计算要定好取整方向并全站一致，例如 85 折、适用金额 39999 分：优惠 = 39999 × 15 ÷ 100 = 5999.85，向下取整为 5999 分，再与上限比较
- 需要 `BigDecimal` 的地方（如汇率换算）必须显式指定 `RoundingMode`，最终仍转换为整数分存储

---

## 八、过期处理

| 方案 | 做法 | 适用 |
|------|------|------|
| 查询时判断 | 锁券条件带 `valid_end > NOW()`，券包按 `valid_end` 过滤 | **必须有**，是真正的过期保障 |
| 定时扫描改状态 | 按 `(status, valid_end)` 索引分批把过期券改为 `EXPIRED` | 券包展示、统计；可以延迟 |
| 每张券一条延迟消息 | 领券时投递到期定时消息 | 不推荐：上亿张券就是上亿条定时消息，且固定区间的券会在同一时刻集中触发 |

扫描在每个分片上执行，不需要游标，已更新的行自然不再命中：

```sql
SELECT id FROM coupon
WHERE status = 'UNUSED' AND valid_end <= NOW()
ORDER BY valid_end LIMIT 500;

UPDATE coupon SET status = 'EXPIRED'
WHERE id IN (...) AND status = 'UNUSED';          -- 带上原状态：期间被锁定的券不受影响
```

- **已锁定的券不参与过期扫描**：下单时券还有效，订单支付成功就核销，关单时解锁回 `UNUSED`，之后再由扫描置为过期
- **到期提醒**：每小时扫描 24 小时内到期的未使用券，按用户合并推送，以「用户 + 日期」去重
- 多实例部署时扫描任务用分布式调度按分片分配，见 [分布式调度](/distributed/6_job_scheduler)；模板对账完成后给它在 Redis 中的三个 key 设置过期时间清理

---

## 九、大促预热与热点

### 1、预热

- **模板规则**：开场前加载到券服务本地缓存，模板变更时广播失效
- **库存 key**：用 `SET coupon:{tplId}:stock 1000000 NX` 初始化，`NX` 保证预热脚本重跑时不会把已经扣过的库存重置回去
- **券包与结算页**：大促前把非核心查询（历史券、已过期券）降级，只查未使用的券

### 2、单模板热点

一个热门模板的库存 key 落在 Redis Cluster 的同一个分片上，所有领券请求都打到这一个分片。处理方式与秒杀相同：

- **分桶**：把库存拆成 16 个桶 `coupon:{tplId:b}:stock`，按 `hash(userId) % 16` 选桶，`claimed`、`pending` 也按同样的桶号拆，保证同一用户的三个 key 仍在同一个槽内；桶之间余量不均时，由后台任务把其他桶的剩余库存挪到已空的桶。做法见 [热点问题](/high-con/6_hotspot#_3、分桶库存) 的分桶库存一节
- **本地售罄标记**：某个桶返回已领完后，实例本地记录几秒，后续请求不再访问 Redis；有库存回补时广播清除，见 [秒杀](./4_seckill) 的本地售罄标记一节
- **用券不是热点**：锁券、核销都按 `user_id` 分散在各个分片，大促时主要压力在订单链路

---

## 十、容量估算

以大促 0 点发一张平台券为例：**库存 100 万张、每人限领 1 张，500 万用户在开场 10 秒内平均每人点击 2 次**。下表的单机能力是估算用的经验值，实际以压测为准。

| 环节 | 计算 | 结果 |
|------|------|------|
| 网关入口 | 5,000,000 × 2 ÷ 10 秒 | 100 万 QPS |
| 网关放行到券服务 | 按券服务压测容量设置全局限流 | 30 万 QPS |
| 售罄时间 | 1,000,000 ÷ 300,000 | 约 3.3 秒，之后由本地售罄标记拦截 |
| Redis 分片 | Lua 单分片按 5 万 QPS 估算，300,000 ÷ 50,000 | 至少 6 个分片；16 个桶分布在 16 个主分片上，每片约 1.9 万 QPS |
| 券服务实例 | 单实例 5,000 QPS，300,000 ÷ 5,000 = 60，乘 1.5 倍冗余 | 90 个 |
| MQ 落库 | 消费速率限制在 2 万 TPS，1,000,000 ÷ 20,000 | 50 秒内全部落库，16 个库每库约 1,250 写/秒 |

**Redis 内存**（哈希字段按约 100 B 估算，1 MB = 1024 × 1024 B）：已领计数 1,000,000 × 100 B ≈ 95 MB；待落库记录峰值约 1,000,000 × 130 B ≈ 124 MB，落库后逐步删除。

**券实例存储**：日均发券 5,000 万张，保留 180 天，共 5,000 万 × 180 = 90 亿行；单行约 200 B，90 亿 × 200 B = 1.8 × 10^12 B ≈ 1.64 TB，加上索引按 1.5 倍估算约 2.5 TB。分 16 库 × 64 表 = 1,024 张表，每表 9,000,000,000 ÷ 1,024 ≈ 879 万行。已使用和已过期超过 90 天的券归档到冷存储，见 [冷热数据分离](/architecture/1_cold_hot_data)。

峰值预估、冗余系数与全链路压测见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 券分模板与实例两层：模板发布后核心规则不可改，实例在领取时写入自己的有效期，按 `user_id` 分库分表
- 主动领用一个 Lua 脚本完成库存判断、限领判断、扣库存、计数与写待落库记录；脚本成功即领取成功
- 待落库记录是 Redis 里的发件箱：发送失败不回补库存，由补发任务按同一 `couponId` 重发，落库靠券 ID 与 `issue_key` 唯一约束幂等
- 三种发券方式共用 `issue_key` 唯一约束；模板表不逐张累加已发数，总量靠 Redis 原子扣减保证、靠对账核实
- 用券状态全部用带原状态和 `lock_biz_no` / `order_id` 条件的 `UPDATE` 推进，重复消息影响 0 行，也不会误改被其他订单锁定的券
- 优惠逐层计算、同层互斥，用最大余额法按分分摊到商品行；过期以查询条件为准，扫描任务只负责改展示状态
- 0 点领券的热点处理可参考 [热点问题](/high-con/6_hotspot)。

## 参考资料

- Redis Scripting with Lua：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- Redis Cluster 规范（哈希标签）：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- Redis 持久化：[https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- RocketMQ 事务消息：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage)
- Transactional Outbox 模式：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[即时通讯](./16_im) —— 长连接路由、会话内 seq、三段确认、多端同步与群聊读写扩散。

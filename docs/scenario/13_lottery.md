---
description: 奖池与库存建模、按权重选奖的区间法与别名法、Lua 原子扣次数与奖品、大奖单独处理、落库与发奖、防刷、概率监控
---

# 抽奖

> 前置阅读：[秒杀](./11_seckill)、[优惠券和营销](./5_coupon)

抽奖是把有限的奖品按设定的概率分给来参与的人，要做到概率准、奖品不多发、大奖不被刷走。本篇讲奖池怎么建、一次抽奖怎么选和怎么扣、中了之后怎么发、怎么防刷和自证公平，基线为 Redis 8、RocketMQ 5。

---

## 一、需求与挑战

### 1、玩法

| 玩法 | 特点 | 本篇 |
|------|------|------|
| 即抽即开：大转盘、九宫格、砸金蛋 | 点一下立刻出结果，整点开抽时并发最高 | 主要讲这一种 |
| 定时开奖：报名后统一开奖、抽签购买资格 | 报名阶段只是登记，开奖是一次离线计算 | 第八节讲怎么让结果可验证 |
| 抽卡、开盲盒 | 奖品种类成百上千，单价低 | 第四节的别名法 |

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 奖品不能多发 | 大奖只有 1 个，两个人同时抽中只能给一个 |
| 概率要和公示的一致 | 配置的是 1%，实际中出来不能是 3%；奖品抽完之后别的奖品的概率不能悄悄变 |
| 次数限制 | 每人每天 3 次，并发请求不能多抽 |
| 瞬时并发 | 活动整点开始，前几秒的请求量是平时的上百倍 |
| 中了必须发到 | 用户已经看到「恭喜中奖」，奖品不能因为后面哪一步失败就没了 |
| 防刷 | 批量注册的账号、脚本，目标是把值钱的奖品抽走 |
| 说得清 | 有人质疑不公平时，能拿出每一次抽奖的记录和实际中奖率 |

---

## 二、整体架构

![抽奖整体架构](../assets/scenario/lottery-arch.svg)

和 [秒杀](./11_seckill)、[优惠券和营销](./5_coupon) 的领券是同一个骨架：前面限流，Redis 里一个脚本原子地扣，扣成功就算数，数据库和发奖在后面异步跟上。不同的地方有两个：抽奖多了「按概率选一个」这一步；奖品有很多种，其中最值钱的往往只有一两个。

---

## 三、奖池建模

```sql
CREATE TABLE lottery_prize (
    id            BIGINT       PRIMARY KEY,
    activity_id   BIGINT       NOT NULL,
    name          VARCHAR(64)  NOT NULL,
    type          VARCHAR(16)  NOT NULL,              -- COUPON / POINT / GOODS / NONE
    grant_ref     VARCHAR(64),                        -- 发什么：券模板 ID、积分数、商品 SKU
    weight        INT          NOT NULL,              -- 权重，全部奖品之和是 1,000,000
    total         INT          NOT NULL,              -- 总数；兜底奖不限量
    is_fallback   TINYINT      NOT NULL DEFAULT 0,    -- 每个活动有且只有一个兜底奖
    rare          TINYINT      NOT NULL DEFAULT 0,    -- 数量很少的大奖，扣减走单独的路径，见第五节
    release_at    DATETIME(3),                        -- 最早什么时候可以被抽中
    KEY idx_activity (activity_id)
);
```

三个建模上的决定：

- **概率用整数权重表示**，全部奖品的权重之和固定为 100 万，1% 就是 10,000。不用小数，免得加起来是 0.9999
- **一定有一个兜底奖**（谢谢参与，或者几个积分），不限量。它有两个用处：权重之和凑满 100 万；别的奖品没货时改发它
- **奖品抽完了，它的概率不摊给别的奖品**，而是落到兜底奖上。摊给别人的话，剩下的奖品中奖率会越来越高，最后几个抽奖的人几乎必中大奖，实际概率和公示的对不上

**不要让大奖在第一秒被抽走。** 活动持续 7 天、大奖只有 1 个时，可以给它设最早可中时间 `release_at`，在那之前选中它一律改发兜底奖；数量多一些的奖品按天或按小时把库存分批放进 Redis。这会让实际概率在不同时段有差别，规则里要写明。

---

## 四、怎么选出一个奖品

![一次抽奖的步骤](../assets/scenario/lottery-draw-flow.svg)

选奖在应用里做，扣减在 Redis 的脚本里做。选奖只是算一个随机数，不涉及共享的数据，没必要放进脚本占着 Redis。

### 1、区间法

把权重累加成一串区间，取一个 0 到 100 万之间的随机整数，看它落在哪个区间：

```java
public final class WeightedPicker {

    private final long[] prizeIds;
    private final int[] cumulative;                      // 累积权重，最后一个等于总权重

    public WeightedPicker(List<Prize> prizes) {
        prizeIds = prizes.stream().mapToLong(Prize::id).toArray();
        cumulative = new int[prizes.size()];
        int sum = 0;
        for (int i = 0; i < prizes.size(); i++) {
            sum += prizes.get(i).weight();
            cumulative[i] = sum;
        }
        if (sum != 1_000_000) {
            throw new IllegalArgumentException("权重之和必须是 1,000,000，实际 " + sum);
        }
    }

    public long pick() {
        int r = ThreadLocalRandom.current().nextInt(1_000_000);   // [0, 1,000,000)
        int lo = 0, hi = cumulative.length - 1;
        while (lo < hi) {                                // 找第一个大于 r 的累积权重
            int mid = (lo + hi) >>> 1;
            if (r < cumulative[mid]) hi = mid; else lo = mid + 1;
        }
        return prizeIds[lo];
    }
}
```

奖品只有十来个时，二分最多比较四次，完全够用。

### 2、别名法

奖品有上千种（抽卡、盲盒）时可以用别名法：预处理一次，之后每次取样只要一个随机下标加一次比较，和奖品数量无关。

思路是把所有奖品的概率摊平成 n 个一样高的格子，每个格子最多由两种奖品填满：格子自己的那种，和「借」来补齐的另一种（别名）。

```java
public final class AliasSampler {

    private final double[] prob;                         // 落在第 i 格时，取格子自己的概率
    private final int[] alias;                           // 否则取谁

    public AliasSampler(double[] weights) {
        int n = weights.length;
        double sum = Arrays.stream(weights).sum();
        prob = new double[n];
        alias = new int[n];
        double[] scaled = new double[n];
        Deque<Integer> small = new ArrayDeque<>();
        Deque<Integer> large = new ArrayDeque<>();
        for (int i = 0; i < n; i++) {
            scaled[i] = weights[i] * n / sum;            // 平均高度记为 1
            (scaled[i] < 1.0 ? small : large).push(i);
        }
        while (!small.isEmpty() && !large.isEmpty()) {
            int s = small.pop();
            int l = large.pop();
            prob[s] = scaled[s];                         // 矮的那格，自己占 scaled[s]
            alias[s] = l;                                // 剩下的由高的那种补齐
            scaled[l] = scaled[l] + scaled[s] - 1.0;     // 高的那种被借走了一部分
            (scaled[l] < 1.0 ? small : large).push(l);
        }
        while (!large.isEmpty()) prob[large.pop()] = 1.0;
        while (!small.isEmpty()) prob[small.pop()] = 1.0;   // 浮点误差留下的，当作正好填满
    }

    public int sample() {
        ThreadLocalRandom r = ThreadLocalRandom.current();
        int i = r.nextInt(prob.length);
        return r.nextDouble() < prob[i] ? i : alias[i];
    }
}
```

| | 预处理 | 每次取样 | 适合 |
|------|------|------|------|
| 区间法 | O(n) | O(log n) | 奖品几十个以内，绝大多数抽奖活动 |
| 别名法 | O(n) | O(1) | 奖品成百上千，或一次请求要连抽很多次 |

### 3、随机数

- `ThreadLocalRandom` 对绝大多数活动足够，没有锁竞争
- 奖品价值很高，或者有合规要求时用 `SecureRandom`，它的输出无法从之前的结果推出下一个
- 不要用「用户 ID 加时间戳取哈希」这类自己拼的办法：输入是别人能猜到的，结果也就能被算出来

---

## 五、扣次数和奖品：一个脚本

选出奖品之后，要在一个原子动作里做三件事：这个人的次数加 1，这个奖品的库存减 1，记下一条待落库的中奖记录。

```lua
-- KEYS[1] 当天已抽次数 lot:{actId:b}:times:<日期>（Hash：用户 → 次数）
-- KEYS[2] 奖品库存     lot:{actId:b}:stock（Hash：奖品 → 剩余）
-- KEYS[3] 待落库       lot:{actId:b}:pending（Hash：抽奖流水号 → 用户:奖品）
-- ARGV[1] 用户  ARGV[2] 每人每天上限  ARGV[3] 选中的奖品（选中大奖时传 0）  ARGV[4] 兜底奖  ARGV[5] 抽奖流水号
local used = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if used >= tonumber(ARGV[2]) then
    return -1                                          -- 次数用完
end
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)             -- 先扣次数：没中也算抽过一次

local prize = ARGV[3]
if prize == '0' then
    return 0                                           -- 选中的是大奖：这里只扣次数，库存去大奖的 key 上扣
end
if prize ~= ARGV[4] then
    local left = tonumber(redis.call('HGET', KEYS[2], prize) or '0')
    if left <= 0 then
        prize = ARGV[4]                                -- 没货了：改发兜底奖
    else
        redis.call('HINCRBY', KEYS[2], prize, -1)
        redis.call('HSET', KEYS[3], ARGV[5], ARGV[1] .. ':' .. prize)
    end
end
return tonumber(prize)
```

这里的兜底奖是「谢谢参与」，不用落库；兜底奖有实际价值（比如几个积分）时，它也要记进待落库。

- **三个 key 用同一个哈希标签** `{actId:b}`，落在集群的同一个槽里，脚本才能一起操作
- **按用户分桶**：`b = hash(用户) % 16`，每个桶有自己的次数、库存和待落库。全场请求不会都打到一个分片上，这和 [优惠券和营销](./5_coupon) 把券库存拆成 16 个桶是同一个做法
- **脚本返回的就是结果**，返回成功用户就可以看到中了什么，不等数据库
- 分成几条命令来做会出现中间状态：次数扣了、库存没扣上；或者两个并发请求都读到「还剩 1 次」

### 大奖不能分桶

普通奖品有几千几万个，平均分到 16 个桶里没有问题。大奖只有 1 个，放进哪个桶，就只有那个桶的用户抽得到，对其余 15 个桶的人不公平。

做法是把数量很少的奖品单独放在一个不分桶的 key 里，分两步扣：

1. 桶内的脚本照常扣次数。选中的如果是大奖，这一步不扣库存，只返回「待定」
2. 再对大奖的 key 执行一个脚本：还有货、这个人也没中过，就减 1 并记进得主集合；否则改发兜底奖

```lua
-- KEYS[1] 大奖库存 lot:{actId}:rare:<奖品>    KEYS[2] 大奖得主 lot:{actId}:rare:winners（Set）
-- ARGV[1] 用户
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return 0                                           -- 同一个人在活动期内最多中一次大奖
end
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
if left <= 0 then
    return 0
end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
```

这个 key 不会成为热点：只有选中了大奖的请求才会访问它，大奖的概率是十万分之一的话，10 万次/秒的抽奖只有每秒 1 次落到它上面。

两步之间进程崩溃的话，次数扣了、大奖没扣，用户看到的是失败，可以重试；大奖的库存没有动。不会出现「大奖扣了却没有记录」：得主集合和库存是在同一个脚本里改的，得主集合本身就是大奖的待落库清单，补发任务同样会扫它。

---

## 六、落库与发奖

### 1、落库

脚本成功后，抽奖服务发一条中奖消息，消费者写中奖记录，写成功再从 `pending` 里删掉：

```sql
CREATE TABLE lottery_record (
    draw_id      BIGINT       PRIMARY KEY,             -- 抽奖流水号，抽奖服务预先生成
    activity_id  BIGINT       NOT NULL,
    user_id      BIGINT       NOT NULL,
    prize_id     BIGINT       NOT NULL,
    grant_status VARCHAR(16)  NOT NULL,                -- PENDING / GRANTED / FAILED
    created_at   DATETIME(3)  NOT NULL,
    KEY idx_user (user_id, activity_id),
    KEY idx_grant (grant_status, created_at)
);
```

消息发送失败、进程在发送之前崩溃，都由补发任务兜住：每分钟扫一遍 `pending`，停留超过 1 分钟的用原来的流水号重发一次。消费端以流水号为主键，重复的消息撞主键直接跳过。这一套和领券的「待落库记录 + 补发 + 落库幂等」完全一样，细节见 [优惠券和营销](./5_coupon)。

发送失败时**不回补**库存和次数。发送超时不代表消息没到，回补之后消息其实已经落库的话，就多出来一个奖品。

### 2、发奖

中奖记录落库后，发奖任务按奖品类型调用各自的服务，幂等键都用抽奖流水号：

| 奖品 | 怎么发 | 幂等 |
|------|------|------|
| 优惠券 | 调券服务的活动发放接口 | 发放键 `E:{券模板}:{抽奖流水号}`，见 [优惠券和营销](./5_coupon) |
| 积分 | 调积分服务加分 | 流水上「类型 + 抽奖流水号」唯一，见 [排行榜和积分](./14_rank_system) |
| 余额、红包 | 调账户服务记一张凭证 | 凭证号由抽奖流水号派生，见 [账户与记账](./10_account_ledger) |
| 实物 | 让用户填收货地址，生成一张 0 元订单 | 订单的业务幂等号用抽奖流水号 |

发奖是异步的，用户会先看到「恭喜中奖」，过一会儿奖品才到账，页面上要有「发放中」这个状态。发放失败就重试，重试到上限仍失败的转人工，不能悄悄丢掉：用户已经看到自己中奖了。

### 3、对账

每个奖品验一个恒等式：**Redis 里的剩余 + 待落库的条数 + 已落库的条数 = 总数**。活动进行中每 10 分钟验一次，结束后验一次。另外核对已落库的中奖记录都发出去了：长时间停在 `PENDING` 的要告警。

---

## 七、防刷

| 手段 | 做法 |
|------|------|
| 限流 | 网关按用户、按设备、按 IP 限流，挡住脚本的高频请求 |
| 次数 | 每人每天的次数在脚本里原子判断，前端的置灰只是体验 |
| 抽奖机会要有成本 | 机会靠下单、签到、分享得到，而不是登录就送，批量注册的账号拿不到多少 |
| 风控分 | 风险高的账号照常能抽、照常扣次数，但只会出兜底奖，页面上不提示。直接拒绝会让对方知道自己被识别了 |
| 大奖限中 | 同一个人活动期内最多中一次大奖，在大奖的脚本里用得主集合判断；同一设备、同一收货地址也只发一次 |
| 大奖复核 | 高价值奖品中出后先冻结，人工核实账号后再发 |
| 一次性令牌 | 抽奖前先取令牌，用一次即删，做法见 [秒杀](./11_seckill) |

---

## 八、公平与可审计

### 1、实际中奖率要盯着

配置的概率和实际中出来的比例应当接近。按奖品统计「抽中次数 ÷ 总抽奖次数」，和配置的概率比较，偏差超过阈值就告警。偏差的常见原因：

- 权重之和不是 100 万，或者改了某个奖品的权重、别的没跟着改
- 奖品抽完之后落到了兜底奖上，这是预期内的，统计时要把「选中但没货」单独列出来
- 分桶之后某几个桶的库存先用完了，需要后台把别的桶的余量调过去

### 2、每一次抽奖都留记录

抽奖日志记下流水号、用户、时间、取到的随机数、当时生效的奖品表版本、最后给出的奖品。没中的也要记。有人投诉时能还原当时发生了什么，也能事后重新统计任意时段的中奖率。

### 3、定时开奖：让结果可以被验证

统一开奖的玩法（比如从 10 万个报名的人里抽 100 个购买资格）可以做到让任何人自己验算：

1. 报名截止前，平台生成一个随机种子，只公布它的哈希值
2. 报名截止后，公布全部报名编号的列表（或它的哈希）
3. 开奖时公布种子本身。中签名单 = 用「种子 + 报名列表」按公开的算法算出来的结果

种子的哈希是报名截止前公布的，平台没法在看到报名名单之后再换一个对自己有利的种子；算法和输入都是公开的，谁都可以重算一遍。即抽即开的玩法做不到这一点，只能靠上面两条。

---

## 九、容量估算

假设一次活动有 **1,000 万人参与**，每人每天 3 次，奖品里非兜底的合计概率 20%，1 KB = 1024 B。

**抽奖次数**：10,000,000 × 3 = 30,000,000 次/天。

**峰值**：整点开抽，假设 5% 的次数集中在头 15 秒，30,000,000 × 5% ÷ 15 = 100,000 次/秒。

**Redis**：每次抽奖一个脚本。按单分片每秒 5 万次脚本算，需要 100,000 ÷ 50,000 = 2 个分片；分 16 个桶落在 16 个分片上，每个分片约 100,000 ÷ 16 = 6,250 次/秒，余量充足。

**大奖 key**：大奖概率按十万分之一算，峰值 100,000 × 0.00001 = 1 次/秒，不是热点。

**中奖消息**：峰值 100,000 × 20% = 20,000 条/秒。消费端每批 500 条、一条多行插入，按每秒 10,000 行的写入能力，15 秒的高峰产生 300,000 条，约 30 秒消化完。

**存储**：中奖记录每天 30,000,000 × 20% = 6,000,000 行，每行约 100 B，索引放大 1.5 倍为 150 B，共 6,000,000 × 150 B = 900,000,000 B ≈ 858 MB/天。兜底奖只记日志、不进中奖记录表。

**次数的 key**：每个桶一个 Hash，共 1,000 万个用户字段，每个字段约 50 B，合计约 477 MB，带日期后缀，次日过期。

---

## 小结

- 概率用整数权重，和固定为 100 万；设一个不限量的兜底奖，奖品抽完后概率落到它上面，不摊给别的奖品
- 选奖在应用里做：奖品少用区间法，上千种用别名法；随机数别自己拼
- 次数、库存、待落库记录在一个脚本里原子完成，按用户分桶；数量很少的大奖不分桶，单独一个 key 两步扣
- 脚本成功就是中了，落库靠待落库记录加补发，发送失败不回补
- 发奖按类型调各自的服务，都用抽奖流水号做幂等键，失败重试到底
- 防刷的重点是让抽奖机会有成本、让高风险账号只出兜底奖、大奖限中并复核
- 盯实际中奖率，每一次抽奖留记录；定时开奖可以用先公布种子哈希的办法让结果可验证

## 参考资料

- Redis 脚本的原子性：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- Keith Schwarz, Darts, Dice, and Coins（别名法的推导）：[https://www.keithschwarz.com/darts-dice-coins/](https://www.keithschwarz.com/darts-dice-coins/)
- JDK 21 `SecureRandom`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/security/SecureRandom.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/security/SecureRandom.html)

> 下一篇：[排行榜和积分](./14_rank_system) —— 基于 Redis ZSet 的实时榜、分时段榜与大规模排行优化。

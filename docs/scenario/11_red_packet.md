---
description: 二倍均值分配、发红包本地事务扣款、Lua 原子抢、事务消息可靠入账、对账后退款
---

# 抢红包系统设计

> **本篇目标**：设计一个资金守恒的抢红包系统：金额怎么分、发红包怎么扣款、高并发下怎么原子地抢、抢到后怎么可靠入账、过期后怎么不多不少地退款。
>
> **前置阅读**：[秒杀系统设计](./4_seckill)、[消息队列基础](/messaging/1_basics)、[RocketMQ](/messaging/3_rocketmq)（事务消息一节）

红包和秒杀一样是「固定份数、瞬时高并发」，但它是**资金**：任何一步出错都可能凭空多出或少掉钱。本篇的设计目标是一条不变式：**发出总额 = 已领取总额 + 已退款总额**，并且每一项都能对账。金额单位统一为「分」，用 `long`。

---

## 一、核心挑战

| 挑战 | 说明 |
|------|------|
| 资金守恒 | 发送者先扣款；领取和退款之和必须等于发出金额 |
| 不超发 | 份数固定，同一份不能被两个人领走，同一人不能领两次 |
| 不少发 | 抢到了就必须入账，进程崩溃、消息丢失都要能补回来 |
| 高并发 | 一个群红包可能有上千人同时点开 |
| 金额随机 | 随机但每人至少 1 分，手气最佳不固定在某个位置 |

![红包资金链路](../assets/scenario/red-packet-flow.svg)

---

## 二、金额分配

### 1、朴素随机的问题

每次在 `[1, 剩余金额 - 剩余人数 + 1]` 里均匀随机：第一个人的期望就接近总额的一半，越往后剩得越少，后面的人往往只能拿到几分钱，先抢的人系统性占优。

### 2、二倍均值法

每次在 `[1, 剩余均值 × 2 - 1]` 内随机（剩余均值 = 剩余金额 / 剩余人数），最后一人拿走剩余。每次的期望都是当前均值，整体上各位置的期望相同；单份最多约为均值的 2 倍。公开的技术分享中常提到微信红包使用了类似思路。

```java
public final class AmountSplitter {

    public static List<Long> split(long totalCent, int count) {
        if (count <= 0 || totalCent < count) {
            throw new IllegalArgumentException("每人至少 1 分");
        }
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        List<Long> amounts = new ArrayList<>(count);
        long remaining = totalCent;
        for (int left = count; left > 1; left--) {
            long max = remaining / left * 2 - 1;          // 剩余均值 × 2 - 1，保证后面每人至少 1 分
            long amount = rnd.nextLong(1, max + 1);       // [1, max]
            amounts.add(amount);
            remaining -= amount;
        }
        amounts.add(remaining);
        Collections.shuffle(amounts, rnd);                // 打乱，最后一份的特殊性不落在固定位置
        return amounts;
    }
}
```

参数校验还要包括单个红包的金额上限、份数上限（如群人数）。

### 3、预分配

发红包时一次算好所有份额并落库，抢的时候只是「领走一份」，不在高并发路径上做计算，也便于事后逐份对账。

---

## 三、发红包：一个本地事务

### 1、表结构

```sql
CREATE TABLE red_packet (
    id          BIGINT PRIMARY KEY,
    sender_id   BIGINT      NOT NULL,
    total       BIGINT      NOT NULL,
    count       INT         NOT NULL,
    status      VARCHAR(16) NOT NULL,      -- CREATED / ACTIVE / CLOSED / REFUNDED
    expire_at   DATETIME    NOT NULL,
    created_at  DATETIME    NOT NULL,
    KEY idx_status_expire (status, expire_at)
);

-- 预分配的每一份
CREATE TABLE red_packet_slot (
    packet_id   BIGINT      NOT NULL,
    seq         INT         NOT NULL,      -- 1..count
    amount      BIGINT      NOT NULL,
    status      VARCHAR(16) NOT NULL,      -- UNCLAIMED / CLAIMED / REFUNDED
    user_id     BIGINT,
    PRIMARY KEY (packet_id, seq)
);

-- 领取记录：入账的去重依据
CREATE TABLE grab_record (
    id          BIGINT PRIMARY KEY,
    packet_id   BIGINT   NOT NULL,
    user_id     BIGINT   NOT NULL,
    seq         INT      NOT NULL,
    amount      BIGINT   NOT NULL,
    created_at  DATETIME NOT NULL,
    UNIQUE KEY uk_user (packet_id, user_id),   -- 一人一份
    UNIQUE KEY uk_seq  (packet_id, seq)        -- 一份一人
);

-- 账户流水：biz_type + biz_id 唯一，任何资金变动都可追溯、可去重
CREATE TABLE account_flow (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT      NOT NULL,
    amount      BIGINT      NOT NULL,      -- 正数入账，负数扣款
    biz_type    VARCHAR(32) NOT NULL,      -- RP_SEND / RP_GRAB / RP_REFUND
    biz_id      VARCHAR(64) NOT NULL,
    created_at  DATETIME    NOT NULL,
    UNIQUE KEY uk_biz (biz_type, biz_id)
);
```

### 2、扣款与创建

扣发送者余额、写流水、写红包和份额在**同一个本地事务**里（红包与钱包余额在同一个资金库），先落库再装载 Redis：

```java
@Transactional
public long create(long senderId, long totalCent, int count, String requestId) {
    List<Long> amounts = AmountSplitter.split(totalCent, count);
    long packetId = idGenerator.nextId();

    // UPDATE account SET balance = balance - #{amt} WHERE user_id = #{uid} AND balance >= #{amt}
    if (accountMapper.debit(senderId, totalCent) == 0) {
        throw new BizException("余额不足");
    }
    // requestId 重复提交时 uk_biz 冲突，整笔事务回滚；调用方捕获后返回已创建的红包
    flowMapper.insert(AccountFlow.of(senderId, -totalCent, "RP_SEND", requestId));
    packetMapper.insert(RedPacket.created(packetId, senderId, totalCent, count, LocalDateTime.now().plusHours(24)));
    slotMapper.batchInsert(packetId, amounts);

    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
            loader.loadQuietly(packetId);      // 提交后装载；失败只记日志，由补偿任务重试
        }
    });
    return packetId;
}
```

### 3、装载 Redis

三个 key 用同一个哈希标签 `{id}`，保证在 Redis Cluster 中落在同一个槽，Lua 才能同时操作它们：

- `rp:{id}:slots`：List，未领的份额，元素为 `seq:amount`
- `rp:{id}:grabbed`：Hash，`userId → seq:amount`，领取事实的记录
- `rp:{id}:info`：Hash，`state = OPEN / CLOSED`

```lua
-- KEYS[1] slots  KEYS[2] info   ARGV[1] 过期秒数   ARGV[2..] 各份额 "seq:amount"
if redis.call('EXISTS', KEYS[2]) == 1 then
    return 0                                   -- 已装载过，重复执行无副作用
end
redis.call('RPUSH', KEYS[1], unpack(ARGV, 2))
redis.call('HSET', KEYS[2], 'state', 'OPEN')
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return 1
```

- 过期时间取「红包有效期 + 1 天」，留给退款前的对账
- 装载成功后把数据库状态从 `CREATED` 条件更新为 `ACTIVE`；补偿任务扫描创建超过数秒仍是 `CREATED` 的红包重新装载，`EXISTS` 判断保证重复装载不会把份额推两遍
- `unpack` 受 Lua 栈大小限制，份数上限（几百份）远在安全范围内

---

## 四、抢红包

### 1、Lua 原子抢

```lua
-- KEYS[1] slots  KEYS[2] grabbed  KEYS[3] info   ARGV[1] userId
if redis.call('HGET', KEYS[3], 'state') ~= 'OPEN' then
    return 'CLOSED'                            -- 已关闭，或尚未装载
end
local got = redis.call('HGET', KEYS[2], ARGV[1])
if got then
    return 'DUP:' .. got                       -- 已领过，返回原来那份
end
local slot = redis.call('LPOP', KEYS[1])
if not slot then
    return 'EMPTY'
end
redis.call('HSET', KEYS[2], ARGV[1], slot)
redis.call('EXPIRE', KEYS[2], redis.call('TTL', KEYS[3]))   -- 与 info 同时过期
return 'OK:' .. slot
```

「判关闭 → 判重 → 弹出份额 → 记录领取」在一个脚本里原子完成，不需要分布式锁。

### 2、抢到之后：事务消息保证入账

Lua 成功后再普通地发一条 MQ 消息是不可靠的：发送失败或进程在两步之间崩溃，Redis 里已经记了「领过」，钱却永远不会入账。这里用 RocketMQ 事务消息，**本地事务就是执行 Lua**，回查依据是 Redis 中的领取记录：

```java
public GrabResult grab(long packetId, long userId) {
    if (soldOut.getIfPresent(packetId) != null) {                 // Caffeine，expireAfterWrite 1 分钟
        return GrabResult.empty();
    }
    String txId = packetId + ":" + userId;
    Message<GrabMessage> msg = MessageBuilder.withPayload(new GrabMessage(packetId, userId))
            .setHeader("packetId", packetId)
            .setHeader("userId", userId)
            .setHeader("txCreatedAt", System.currentTimeMillis())
            .setHeader(RocketMQHeaders.KEYS, txId)
            .build();
    GrabHolder holder = new GrabHolder(packetId, userId);
    rocketMQTemplate.sendMessageInTransaction("red-packet-grab", msg, holder);
    if (holder.result() == GrabOutcome.EMPTY) {
        soldOut.put(packetId, Boolean.TRUE);
    }
    return GrabResult.of(holder);                                  // 结果不确定时提示「处理中」，客户端稍后查询
}

@RocketMQTransactionListener
@RequiredArgsConstructor
public class GrabTxListener implements RocketMQLocalTransactionListener {

    private static final long UNCERTAIN_WINDOW_MS = 60_000;
    private final RedPacketRedis rpRedis;

    @Override
    public RocketMQLocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        GrabHolder h = (GrabHolder) arg;
        try {
            h.setResult(rpRedis.grab(h.packetId(), h.userId()));          // 执行上面的 Lua
            return h.result() == GrabOutcome.OK
                    ? RocketMQLocalTransactionState.COMMIT
                    : RocketMQLocalTransactionState.ROLLBACK;            // 已领过 / 抢完 / 已关闭：不投递
        } catch (Exception e) {
            h.setResult(GrabOutcome.UNKNOWN);
            return RocketMQLocalTransactionState.UNKNOWN;                // Redis 超时：脚本可能已执行
        }
    }

    @Override
    public RocketMQLocalTransactionState checkLocalTransaction(Message msg) {
        long packetId = Long.parseLong(String.valueOf(msg.getHeaders().get("packetId")));
        long userId = Long.parseLong(String.valueOf(msg.getHeaders().get("userId")));
        if (rpRedis.grabbedSlot(packetId, userId) != null) {
            return RocketMQLocalTransactionState.COMMIT;                 // 领取记录在，确定抢到
        }
        long createdAt = Long.parseLong(String.valueOf(msg.getHeaders().get("txCreatedAt")));
        if (System.currentTimeMillis() - createdAt > UNCERTAIN_WINDOW_MS) {
            return RocketMQLocalTransactionState.ROLLBACK;               // 超过窗口仍无记录，确定没抢到
        }
        return RocketMQLocalTransactionState.UNKNOWN;                    // 可能仍在执行，下次再查
    }
}
```

- 回查只在确定时返回 `COMMIT` / `ROLLBACK`，查不到且仍在窗口内必须返回 `UNKNOWN`，原理见 [RocketMQ](/messaging/3_rocketmq#七、事务消息) 的事务消息一节
- 抢失败的请求也会产生一条半消息再回滚。高峰时可以先做一次廉价的预检（`LLEN` 份额为 0、`HEXISTS` 已领过直接返回），只是过滤，真正的判断仍在 Lua 里
- 不使用 RocketMQ 时，可以在 Lua 成功后同步写本地消息表（Outbox），两步之间的崩溃由第五节的对账补齐

### 3、入账消费者

去重靠 `grab_record` 的唯一键，和份额状态、加余额、写流水放在**同一个本地事务**里；不要「先查是否存在再插入」，更不要把插入和加余额分在两个事务里：

```java
@Component
@RocketMQMessageListener(topic = "red-packet-grab", consumerGroup = "rp-credit")
@RequiredArgsConstructor
public class GrabCreditListener implements RocketMQListener<GrabMessage> {

    private final RedPacketRedis rpRedis;
    private final GrabCreditService creditService;

    @Override
    public void onMessage(GrabMessage m) {
        String slot = rpRedis.grabbedSlot(m.packetId(), m.userId());     // "seq:amount"
        if (slot == null) {
            throw new IllegalStateException("领取记录缺失");              // 重试耗尽进入死信，人工处理
        }
        try {
            creditService.credit(m.packetId(), m.userId(), Slot.parse(slot).seq());
        } catch (DuplicateKeyException e) {
            // 已入账过：重复消费，直接确认
        }
    }
}

@Service
@RequiredArgsConstructor
public class GrabCreditService {

    @Transactional
    public void credit(long packetId, long userId, int seq) {
        // UPDATE red_packet_slot SET status='CLAIMED', user_id=#{uid}
        //  WHERE packet_id=#{pid} AND seq=#{seq} AND status='UNCLAIMED'
        if (slotMapper.claim(packetId, seq, userId) == 0
                && !slotMapper.isClaimedBy(packetId, seq, userId)) {
            throw new IllegalStateException("份额状态异常");               // 已退款或被他人占用：回滚并告警
        }
        long amount = slotMapper.amountOf(packetId, seq);                 // 金额以数据库为准
        grabRecordMapper.insert(new GrabRecord(packetId, userId, seq, amount));   // 重复时 DuplicateKeyException
        accountMapper.credit(userId, amount);
        flowMapper.insert(AccountFlow.of(userId, amount, "RP_GRAB", packetId + ":" + userId));
    }
}
```

`DuplicateKeyException` 会让整个事务回滚，前面的份额更新也一起撤销，所以重复消费不会产生任何副作用。消费幂等的通用做法见 [消息队列基础](/messaging/1_basics)，幂等方案对比见 [幂等设计](/architecture/5_idempotence)。

---

## 五、过期退款：先关闭、再对账、后退款

直接用「总额 - 已入账金额」退款是错的：此时可能还有抢到但仍在 MQ 中的入账消息，退款就会多退，钱凭空多出来。正确顺序：

1. **扫描**：由 XXL-JOB、ShedLock 等分布式调度触发（同一时刻只有一个实例执行），找出 `status = ACTIVE AND expire_at < NOW()` 的红包
2. **关闭**：执行 Lua `HSET rp:{id}:info state CLOSED`，此后的抢请求都会返回 `CLOSED`；数据库状态条件更新为 `CLOSED`
3. **等待结清**：等过事务消息的不确定窗口（如关闭后 5 分钟），再比较数据库 `grab_record` 条数与 Redis `HLEN rp:{id}:grabbed`
4. **对账补齐**：两者不一致时，以 Redis 领取记录为准，对缺失的用户直接调用上面的 `credit`（同一个幂等事务），补齐后条数一致才继续
5. **退款**：在一个本地事务里完成，状态条件更新作为防重闸门

```java
@Transactional
public void refund(long packetId) {
    if (packetMapper.casStatus(packetId, "CLOSED", "REFUNDED") == 0) {
        return;                                                   // 已退过，或另一个实例正在处理
    }
    long left = slotMapper.sumUnclaimed(packetId);                // SELECT COALESCE(SUM(amount), 0) ... status='UNCLAIMED'
    slotMapper.markUnclaimedRefunded(packetId);                   // 之后迟到的入账会在 claim 处失败并告警
    if (left > 0) {
        long senderId = packetMapper.senderOf(packetId);
        accountMapper.credit(senderId, left);
        flowMapper.insert(AccountFlow.of(senderId, left, "RP_REFUND", String.valueOf(packetId)));
    }
}
```

6. **清理**：退款成功后 `UNLINK` 三个 Redis key
7. **核对**：每个红包都校验 `total = 已领取份额之和 + 已退款份额之和`，日终再按账户流水做总账核对

---

## 六、与秒杀的区别

| 维度 | 秒杀 | 红包 |
|------|------|------|
| 库存 | 固定数量的商品 | 固定份数的金额 |
| 金额 | 固定价格 | 随机金额，发红包时预分配 |
| 资金方向 | 用户付款 | 发送者先扣款，领取者入账 |
| 超时处理 | 未支付关单、回补库存 | 过期关闭、对账后退还未领金额 |
| 防超卖 | Redis 预扣 + 数据库条件更新 | Lua 弹出份额 + 唯一键 |

秒杀的削峰、限流与库存设计见 [秒杀系统设计](./4_seckill)。

---

## 小结

- 金额用「分」；二倍均值法每次在 `[1, 剩余均值 × 2 - 1]` 内随机，校验总额不少于份数
- 发红包：扣款、流水、红包、份额在一个本地事务；提交后装载 Redis，补偿任务兜底，装载脚本可重复执行
- Redis key 用同一个哈希标签；Lua 一次完成判关闭、判重、弹出份额、记录领取
- 入账用事务消息：本地事务即执行 Lua，回查看领取记录，不确定时返回 `UNKNOWN`
- 消费端以唯一键去重，领取记录、份额状态、余额、流水同一个本地事务
- 退款顺序：关闭 → 等待窗口 → 对账补齐 → 状态条件更新后退未领份额；调度保证单实例执行

## 参考资料

- RocketMQ 事务消息：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- RocketMQ Spring：[https://github.com/apache/rocketmq-spring](https://github.com/apache/rocketmq-spring)
- Redis 脚本（EVAL）：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- Redis Cluster 规范（哈希标签）：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- ShedLock：[https://github.com/lukas-krecan/ShedLock](https://github.com/lukas-krecan/ShedLock)

> 下一篇：[附近的人 & LBS 地理位置设计](./12_geo_nearby) —— Redis GEO、Geohash 九宫格、过期清理、司机派单与位置隐私。

# 抢红包系统设计

> 微信红包是高并发 + 公平性的经典场景：海量用户同时抢、金额随机分配、不能超发、不能少发。

---

## 一、核心挑战

| 挑战 | 说明 |
|------|------|
| 高并发抢占 | 万人同时抢，需快速判断是否抢到 |
| 金额随机 | 随机但总额固定，不能超发 |
| 不超发 | 红包数量固定，绝不多发 |
| 不少发 | 有人抢到但最终未到账（系统异常），需补偿 |
| 公平性 | 手气最佳不能固定是某个位置 |

---

## 二、金额分配算法

### 2.1 方案一：实时随机（有问题）

每次抢时随机生成金额：
```
当前可用金额 / 剩余人数 * 2 = 随机上限
```

**问题**：最后一个人拿走所有剩余金额，可能极大或极小，不公平。

### 2.2 方案二：二倍均值法（微信采用）

每次随机范围为 `[1分, 剩余均值 × 2]`，保证每人都能抢到，且期望值相等：

```java
public List<Long> splitRedPacket(long totalAmount, int count) {
    List<Long> amounts = new ArrayList<>();
    long remaining = totalAmount;
    int remainCount = count;

    Random random = new Random();
    for (int i = 0; i < count - 1; i++) {
        // 随机范围：[1分, 剩余均值 × 2)
        long avg = remaining / remainCount;
        long amount = 1 + (long)(random.nextDouble() * (avg * 2 - 1));
        amounts.add(amount);
        remaining -= amount;
        remainCount--;
    }
    amounts.add(remaining); // 最后一个人拿走剩余
    Collections.shuffle(amounts); // 打乱顺序，防止最后一个总是特殊
    return amounts;
}
```

**特点**：
- 每人期望值相同（均值 = totalAmount / count）
- 最大值不超过均值的 2 倍
- 打乱顺序后，手气最佳出现位置随机

### 2.3 方案三：预分配（推荐）

**发红包时**就预先计算好每份金额，存入 Redis Queue。抢红包时直接出队，避免实时计算竞争：

```java
// 发红包时预分配
public void createRedPacket(RedPacketDTO dto) {
    List<Long> amounts = splitRedPacket(dto.getTotalAmount(), dto.getCount());

    String key = "rp:amounts:" + dto.getId();
    // 所有金额预存 Redis List
    amounts.forEach(amount ->
        redisTemplate.opsForList().rightPush(key, amount.toString()));
    redisTemplate.expire(key, 24, TimeUnit.HOURS); // 24 小时有效

    // 保存红包基本信息
    redisTemplate.opsForHash().putAll("rp:info:" + dto.getId(), Map.of(
        "total", dto.getTotalAmount(),
        "count", dto.getCount(),
        "expire", System.currentTimeMillis() + 24 * 3600 * 1000
    ));

    // 记录到 DB
    redPacketMapper.insert(buildEntity(dto, amounts));
}
```

---

## 三、抢红包核心逻辑

### 3.1 Lua 脚本原子抢占

```lua
-- grab_red_packet.lua
-- KEYS[1]: rp:amounts:{id}   金额队列
-- KEYS[2]: rp:grabbed:{id}   已抢用户 Set
-- ARGV[1]: userId
-- ARGV[2]: 当前时间戳

-- 1. 判断用户是否已抢
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return {-1, 0}  -- 已抢过
end

-- 2. 从队列取金额
local amount = redis.call('LPOP', KEYS[1])
if not amount then
    return {-2, 0}  -- 红包已抢完
end

-- 3. 记录已抢用户
redis.call('SADD', KEYS[2], ARGV[1])

return {1, tonumber(amount)}  -- 成功，返回金额
```

```java
public GrabResult grab(String redPacketId, Long userId) {
    // 1. 快速判断红包是否还有（本地缓存，减少 Redis 压力）
    if (soldOutCache.containsKey(redPacketId)) {
        return GrabResult.fail("红包已抢完");
    }

    // 2. Redis Lua 原子操作
    List<Long> result = redisTemplate.execute(
        grabScript,
        Arrays.asList("rp:amounts:" + redPacketId, "rp:grabbed:" + redPacketId),
        userId.toString(), String.valueOf(System.currentTimeMillis())
    );

    int code = result.get(0).intValue();
    long amount = result.get(1);

    return switch (code) {
        case 1  -> {
            // 抢到了！异步入账
            mqTemplate.send("red-packet-grab", new GrabMessage(redPacketId, userId, amount));
            yield GrabResult.success(amount);
        }
        case -1 -> GrabResult.fail("您已领取过该红包");
        case -2 -> {
            soldOutCache.put(redPacketId, true); // 标记售完
            yield GrabResult.fail("红包已抢完");
        }
        default -> GrabResult.fail("系统异常");
    };
}
```

### 3.2 异步入账

抢到红包后，异步将记录写入 DB，不阻塞主流程：

```java
@RocketMQMessageListener(topic = "red-packet-grab", consumerGroup = "rp-account-group")
public class RedPacketAccountListener implements RocketMQListener<GrabMessage> {
    @Override
    public void onMessage(GrabMessage msg) {
        // 幂等：防止重复消费
        if (grabRecordMapper.exists(msg.getRedPacketId(), msg.getUserId())) return;

        // 记录抢红包明细
        grabRecordMapper.insert(new GrabRecord(
            msg.getRedPacketId(), msg.getUserId(), msg.getAmount()));

        // 入账（余额增加）
        accountService.credit(msg.getUserId(), msg.getAmount());
    }
}
```

---

## 四、过期红包退款

24 小时后未抢完的红包，退还给发红包的用户：

```java
// 定时任务：处理过期红包
@Scheduled(fixedRate = 60_000)
public void refundExpiredRedPackets() {
    List<RedPacket> expired = redPacketMapper.selectExpired(); // 查询过期未处理的

    for (RedPacket rp : expired) {
        // 计算未抢金额
        Long grabbed = grabRecordMapper.sumByRedPacketId(rp.getId());
        long refundAmount = rp.getTotalAmount() - grabbed;

        if (refundAmount > 0) {
            accountService.credit(rp.getSenderId(), refundAmount); // 退款
        }
        redPacketMapper.markRefunded(rp.getId());

        // 清理 Redis
        redisTemplate.delete("rp:amounts:" + rp.getId());
        redisTemplate.delete("rp:grabbed:" + rp.getId());
    }
}
```

---

## 五、完整流程

```
发红包：
  1. 预分配金额（二倍均值法）
  2. 金额存 Redis List，信息存 Redis Hash
  3. 记录到 DB（异步）

抢红包：
  1. 本地缓存检查（是否已售完）
  2. Lua 脚本原子抢占（判重 + 出队 + 记录）
  3. 成功后发 MQ 异步入账

过期处理：
  1. 定时扫描过期红包
  2. 计算未抢余额退款给发送者
  3. 清理 Redis 数据
```

---

## 六、与秒杀的区别

| | 秒杀 | 红包 |
|--|------|------|
| 库存控制 | 固定数量商品 | 固定数量金额份数 |
| 金额 | 固定价格 | 随机金额 |
| 预分配 | 否 | 是（预分配金额） |
| 退款 | 超时关单回补库存 | 过期退还未抢金额 |
| 公平性 | 先到先得 | 随机金额（二倍均值法） |

---
description: 分层拦截、防刷、Lua 原子预扣、MQ 可靠投递与对账、幂等落库、超时关单、容量评估
---

# 秒杀

> **本篇目标**：把限流、热点、削峰、消息可靠性这些单点知识组合成一条完整的秒杀链路，做到不超卖、不少卖、重复消息不重复下单，并清楚每一环失败后怎么补偿。
>
> **前置阅读**：[热点问题](/high-con/6_hotspot)、[异步与削峰](/high-con/4_async_peak_shaving)、[限流与过载保护](/high-avail/7_rate_limiting)、[RocketMQ](/messaging/3_rocketmq)

秒杀的特点是瞬时流量极大、库存极少、一致性要求高。思路只有一条：**把请求尽量拦在上游，只让和库存数量相当的请求到达数据库**。本篇讲组合方案，各环节原理看前置阅读。

---

## 一、核心挑战

| 挑战 | 说明 |
|------|------|
| 瞬时高并发 | 开抢瞬间 QPS 可达平时的百倍以上，且集中在一个商品上 |
| 超卖 | 库存 100 件，绝不能卖出 101 件 |
| 少卖 | Redis 已扣减，但订单没建成，库存被白占 |
| 重复下单 | 用户重复点击、MQ 重复投递，同一用户只能成交一次 |
| 接口防刷 | 脚本提前刷接口、高频请求挤占正常用户 |

---

## 二、整体链路

![秒杀下单链路](../assets/scenario/seckill_flow.svg)

1. **活动前**：静态页推到 CDN，库存预热到 Redis
2. **接入层**：Nginx 与网关按用户、按接口总量限流，校验一次性下单 token
3. **秒杀服务**：先看本地售罄标记，再执行一个 Lua 脚本完成限购校验、扣库存、记已购，成功后同步发送 MQ，返回「排队中」
4. **订单服务**：消费消息，在一个本地事务里插入订单（唯一约束）并条件扣减 DB 库存
5. **结果查询**：用户按 `orderId` 轮询秒杀结果（成功 / 失败 / 处理中）
6. **超时关单**：定时消息触发，状态条件更新关单，成功后回补 DB 与 Redis 库存并广播清除售罄标记

---

## 三、接入层：静态化、防刷与限流

### 1、页面静态化

秒杀页的 HTML / JS / CSS / 图片提前推到 CDN，倒计时用服务端时间校准，开抢前页面请求不回源。

### 2、防刷

- **一次性下单 token**：活动开始后，客户端调 `/seckill/token` 获取 token。服务端校验活动时间、登录态和风控结果后，按 `userId + activityId` 生成随机 token 存进 Redis（短 TTL），下单接口校验通过后立即删除。这样脚本无法在开抢前构造请求，一个 token 也只能用一次
- **验证码 / 答题**：在获取 token 前加入，把瞬时峰值拉平到几秒内，同时拦截机器
- **风控黑名单**：设备指纹、IP 段、异常账号直接拒绝
- **按钮防重**：点击后置灰，请求失败时恢复。这只是体验优化，不能代替服务端的限购与幂等

```javascript
const btn = document.getElementById('seckillBtn');
btn.onclick = async () => {
  btn.disabled = true;
  btn.innerText = '请求中...';
  try {
    const res = await fetch('/seckill/submit', { method: 'POST', body: formData });
    const data = await res.json();
    btn.innerText = data.message;          // 文案以服务端返回为准：排队中 / 已售罄 / 已参与
  } catch (e) {
    btn.disabled = false;                  // 网络失败时恢复按钮，允许重试
    btn.innerText = '立即抢购';
  }
};
```

### 3、限流

- **用户维度**：同一用户每秒最多 N 次，网关上用 Redis + Lua 计数或令牌桶
- **接口总量**：按压测容量设置全局 QPS 上限（Sentinel、网关限流），超出直接返回「活动火爆」
- 用户在上游排队、令牌发放这类削峰手段见 [异步与削峰](/high-con/4_async_peak_shaving)

限流算法与 Lua 实现见 [限流与过载保护](/high-avail/7_rate_limiting)，这里不重复。

---

## 四、库存预扣：防超卖核心

### 1、为什么不直接扣数据库

```sql
UPDATE seckill_stock SET stock = stock - 1
WHERE activity_id = ? AND stock > 0;      -- 影响行数为 0 即售罄
```

条件更新本身能防超卖，问题是所有请求都排队竞争同一行的行锁，DB 撑不住瞬时流量。所以先在 Redis 预扣，DB 只承接预扣成功的少量请求，DB 条件更新作为最终兜底。

### 2、一个 Lua 脚本完成限购与扣减

限购校验和扣库存必须在一个脚本里原子完成。如果分成 SADD 和扣减两次调用，就会出现「记了已购、库存却没扣到」的中间状态，之后回补库存时这个用户也买不了。

```lua
-- KEYS[1] = seckill:{activityId}:stock   KEYS[2] = seckill:{activityId}:buyers
-- ARGV[1] = userId
-- 返回：>=0 剩余库存；-1 售罄；-2 已参与；-3 未预热
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return -2
end
local stock = redis.call('GET', KEYS[1])
if not stock then
    return -3
end
stock = tonumber(stock)
if stock <= 0 then
    return -1
end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return stock - 1
```

```java
private static final RedisScript<Long> DEDUCT =
        RedisScript.of(new ClassPathResource("lua/seckill_deduct.lua"), Long.class);

Long r = stringRedisTemplate.execute(DEDUCT,
        List.of(stockKey(activityId), buyersKey(activityId)),
        String.valueOf(userId));
```

- key 不存在时 `GET` 在 Lua 里返回 `false`，必须先判断，否则 `tonumber(false)` 得到 `nil`，与数字比较会报运行时错误
- Redis Cluster 下一个脚本访问的 key 必须在同一个槽，所以 key 里用 `{activityId}` 做 hash tag
- 用 `StringRedisTemplate`，避免值被 JDK / JSON 序列化后 `tonumber` 解析失败

### 3、回补脚本

MQ 发送失败、超时关单、对账发现差异时，都用同一个回补脚本。以「从已购集合移除成功」作为回补条件，重复执行不会多加库存：

```lua
-- KEYS 同上，ARGV[1] = userId
if redis.call('SREM', KEYS[2], ARGV[1]) == 1 then
    redis.call('INCR', KEYS[1])
    return 1
end
return 0
```

### 4、本地售罄标记

售罄之后，后续请求没必要再访问 Redis。每个实例在本地记一个售罄标记，命中直接返回：

```java
// 短 TTL 兜底：即使漏收清除广播，几秒后也会重新访问 Redis
private final Cache<Long, Boolean> soldOut = Caffeine.newBuilder()
        .expireAfterWrite(Duration.ofSeconds(3))
        .build();

if (soldOut.getIfPresent(activityId) != null) {
    return Result.fail("已售罄");
}
Long r = executeDeduct(activityId, userId);
if (r == -1) {
    soldOut.put(activityId, Boolean.TRUE);
    return Result.fail("已售罄");
}
```

标记只是缓存，**一旦库存回补（超时关单、MQ 发送失败），就要清除各实例的标记**，否则会出现 Redis 有货、所有实例都返回「已售罄」的少卖。做法是回补后发一条广播消息（RocketMQ 广播消费模式），各实例收到后 `soldOut.invalidate(activityId)`；短 TTL 作为广播丢失时的兜底。

### 5、单 key 热点

所有请求都打到同一个库存 key，也就是 Redis Cluster 的同一个分片。单分片扛不住时把库存拆成多个分桶 key，请求按用户哈希到某个分桶扣减，见 [热点问题](/high-con/6_hotspot#_3、分桶库存) 的分桶库存一节。分桶后限购集合也要跟着按用户分桶，保证同一用户的校验和扣减落在同一个槽。

---

## 五、异步下单：MQ 可靠投递

### 1、发送：同步发送，失败回补

`orderId` 在秒杀服务用雪花算法预先生成（见 [分布式 ID 生成](/distributed/8_id_generator)），它既是返回给用户的查询凭证，也是下游的幂等键。

```java
SeckillMessage msg = new SeckillMessage(orderId, userId, activityId);
try {
    rocketMQTemplate.syncSend("seckill-topic",
            MessageBuilder.withPayload(msg).setHeader(RocketMQHeaders.KEYS, orderId).build(),
            3000);                          // 同步发送，客户端内置失败重试（retryTimesWhenSendFailed）
} catch (MessagingException e) {
    stringRedisTemplate.execute(ROLLBACK,
            List.of(stockKey(activityId), buyersKey(activityId)), String.valueOf(userId));
    broadcastStockRestored(activityId);     // 通知各实例清除售罄标记
    return Result.fail("系统繁忙，请重试");
}
resultCache.markPending(orderId);           // 秒杀结果：处理中
return Result.ok("排队中", orderId);
```

Redis 和 MQ 无法放进同一个事务，发送失败回补之后仍有两个缺口：

- **进程在扣减成功、发送之前崩溃**：Redis 已扣、消息没发，形成少卖
- **发送超时但消息其实已到达**：已经执行了回补，消费端仍会建单

第二种情况由 DB 兜底：DB 库存条件更新防止超卖，订单表 `(user_id, activity_id)` 唯一约束防止同一用户回补后再抢一次造成重复成交。第一种情况靠对账：

### 2、对账：兜住少卖

定时任务（活动进行中每分钟一次，活动结束后再全量一次）比对 Redis 已购集合与 DB 订单表，找出「已购但超过 N 分钟仍无订单、也没有失败记录」的用户，执行回补脚本并广播。对账以 DB 为准，同时校验 `Redis 剩余 + 已成交 = 初始库存`，不一致时告警。多实例下用分布式调度避免重复执行，见 [分布式调度](/distributed/6_job_scheduler)。

> 如果要求一条请求都不能丢，可以先把请求写进本地消息表（与秒杀记录同库同事务），再由投递任务发 MQ，即 Transactional Outbox，见 [消息队列基础](/messaging/1_basics) 的分布式事务一节。代价是秒杀服务也要写库，吞吐下降。

### 3、消费：一个本地事务 + 唯一约束

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(topic = "seckill-topic", consumerGroup = "seckill-order-group")
public class SeckillOrderListener implements RocketMQListener<SeckillMessage> {

    private final SeckillOrderService seckillOrderService;

    @Override
    public void onMessage(SeckillMessage msg) {
        seckillOrderService.createOrder(msg);   // 抛异常则由 RocketMQ 重试
    }
}

@Service
@RequiredArgsConstructor
public class SeckillOrderService {

    private final SeckillOrderMapper orderMapper;
    private final SeckillStockMapper stockMapper;

    // seckill_order：UNIQUE KEY uk_order_id (order_id)、UNIQUE KEY uk_user_activity (user_id, activity_id)
    @Transactional
    public void createOrder(SeckillMessage msg) {
        try {
            orderMapper.insert(SeckillOrder.pendingPayment(msg));
        } catch (DuplicateKeyException e) {
            return;                                     // 重复消息，或该用户已成交：视为已处理
        }
        // UPDATE seckill_stock SET stock = stock - 1 WHERE activity_id = ? AND stock > 0
        if (stockMapper.deduct(msg.activityId()) == 0) {
            orderMapper.markFailed(msg.orderId());      // DB 兜底发现无库存：记失败，用户轮询可见
        }
    }
}
```

- **先插订单，再扣库存**：并发投递的两条相同消息，第二条的 insert 会等第一条事务提交后撞唯一键，不会重复扣库存
- **插订单和扣库存在同一个本地事务**：不会出现「库存扣了、订单没建」
- 只用 `exists` 先查后写不可靠：两条并发消息都可能通过检查。幂等消费的通用做法见 [消息队列基础](/messaging/1_basics) 的幂等消费一节
- 订单状态变化后更新秒杀结果缓存，供用户轮询

---

## 六、超时关单与库存回补

下单后 15 分钟未支付就关单，订单关闭成功后才回补库存：

1. 订单建成并提交后，发送 15 分钟的定时消息（RocketMQ 5.x 支持任意时延；4.x 只有 18 个固定级别，15 分钟不在其中），具体写法见 [订单](./5_order_system#四、超时关单) 的超时关单一节
2. 消费时先调用支付平台关单接口，再用 `UPDATE ... SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING_PAYMENT'` 关单，影响行数为 1 才继续
3. 同一事务里回补 DB 库存；提交后执行 Redis 回补脚本，并广播清除售罄标记
4. 重复的关单消息会因条件更新影响 0 行而直接结束，不会重复回补

---

## 七、容量评估

以下为经验量级，只用于粗估，实际以压测为准：

| 指标 | 参考值 |
|------|--------|
| Redis 单分片 QPS | ~10w（简单命令；Lua 脚本更低） |
| 单台秒杀服务 QPS | ~5000（含网关、Redis、MQ） |
| MQ 消费速度（单消费者） | ~1000 TPS |
| DB 写入 QPS | ~3000（SSD + 连接池优化） |

按上表粗估：峰值 5w QPS 至少需要 10 台秒杀服务，再按多可用区冗余放大；下游 Redis、MQ 消费者、DB 写入要分别核算，DB 侧靠 MQ 匀速消费而不是按峰值扩容。峰值估算、冗余系数、全链路压测与大促预案见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 秒杀的核心是逐层拦截：CDN 拦静态请求，网关拦超频与脚本，本地标记拦售罄后的请求，Redis 拦超出库存的请求，DB 只承接预扣成功的部分
- 限购校验、扣库存、记已购必须在一个 Lua 脚本里完成；key 不存在要先判断，Cluster 下用 hash tag 保证同槽
- 回补以 `SREM` 成功为条件，可以重复执行；回补后必须广播清除本地售罄标记，标记本身也要有短 TTL
- Redis 与 MQ 不在一个事务里：同步发送失败要回补，崩溃造成的少卖靠定时对账兜底，要求零丢失时改用 Outbox
- 消费端在一个本地事务里先插订单（唯一约束）再条件扣库存，重复消息撞唯一键即视为已处理
- 关单用状态条件更新，影响 1 行才回补库存；RocketMQ 4.x 的固定延迟级别里没有 15 分钟，用 5.x 任意时延定时消息

## 参考资料

- Redis Scripting with Lua：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- Redis Cluster 与 hash tag：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- RocketMQ 定时 / 延时消息：[https://rocketmq.apache.org/docs/featureBehavior/02delaymessage](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage)
- RocketMQ 消费重试：[https://rocketmq.apache.org/docs/featureBehavior/10consumerretrypolicy](https://rocketmq.apache.org/docs/featureBehavior/10consumerretrypolicy)
- Caffeine：[https://github.com/ben-manes/caffeine](https://github.com/ben-manes/caffeine)

> 下一篇：[订单](./5_order_system) —— 订单状态机、下单幂等、支付回调、超时关单、分布式事务与退款。

# 秒杀系统设计

> 秒杀是电商最经典的高并发场景：瞬时流量极大、库存极少、一致性要求高。核心目标是用最少资源支撑最大流量，同时保证不超卖。

---

## 一、秒杀系统的核心挑战

| 挑战 | 说明 |
|------|------|
| 瞬时高并发 | 活动开始瞬间 QPS 可能达到平时的 100 倍以上 |
| 超卖防止 | 库存只有 100 件，绝不能卖出 101 件 |
| 少卖防止 | 扣减成功但下单失败，库存被白占（少卖） |
| 接口防刷 | 恶意脚本刷接口，挤占正常用户资源 |
| 用户体验 | 秒杀失败要快速返回，不能让用户一直等待 |

---

## 二、整体架构设计

```
用户请求
    ↓
CDN（静态资源缓存，秒杀页面不走源站）
    ↓
Nginx（限流 + 负载均衡）
    ↓
网关（接口鉴权 + 用户限流：每人每秒 N 次）
    ↓
秒杀服务
    ├── Redis 库存预减（原子操作，拦截无效请求）
    ├── 重复购买校验（Redis 记录已购用户）
    └── 写入 MQ（异步下单）
            ↓
        订单服务（消费 MQ，真正创建订单 + 扣减 DB 库存）
            ↓
        支付服务（用户在有效期内完成支付）
```

---

## 三、前端层优化

### 3.1 静态化 & CDN

秒杀页面所有静态资源（HTML/JS/CSS/图片）提前推到 CDN，用户访问不走源站。

### 3.2 按钮防重点击

```javascript
// 点击后禁用按钮，防止多次提交
document.getElementById('seckillBtn').onclick = function() {
    this.disabled = true;
    this.innerText = '请求中...';
    fetch('/seckill/submit', { method: 'POST', body: formData })
        .then(res => res.json())
        .then(data => {
            this.innerText = data.success ? '抢购成功' : '已售罄';
        });
};
```

### 3.3 接口地址隐藏

秒杀接口地址不写死在页面，活动开始前通过 `/seckill/getUrl` 动态获取（服务端校验时间后返回加密 URL），防止提前刷接口。

---

## 四、网关层限流

### 4.1 用户维度限流

对每个用户的秒杀请求限频（令牌桶），防止单用户暴力刷：

```java
// 基于 Redis + Lua 的滑动窗口限流
// 1 秒内同一用户最多 5 次请求
String key = "seckill:limit:" + userId;
Long count = redisTemplate.execute(limitScript, key, 1, 5);
if (count > 5) {
    return Result.fail("请求太频繁，请稍后再试");
}
```

### 4.2 接口总量限流

对秒杀接口设置全局 QPS 上限（Sentinel 流控），超出部分直接返回"系统繁忙"。

---

## 五、库存处理——防超卖核心

### 5.1 方案演进

**方案一：数据库乐观锁（不推荐高并发场景）**
```sql
UPDATE seckill_stock
SET stock = stock - 1
WHERE product_id = ? AND stock > 0;
-- 影响行数 = 0 说明已售罄
```
问题：高并发时大量请求打到数据库，DB 压力极大。

**方案二：Redis 原子扣减（推荐）**

预热：活动开始前将库存写入 Redis：
```bash
SET seckill:stock:{productId} 100
```

扣减（Lua 保证原子性）：
```lua
-- seckill_stock.lua
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock <= 0 then
    return -1  -- 已售罄
end
redis.call('DECR', KEYS[1])
return stock - 1
```

```java
Long remaining = redisTemplate.execute(
    seckillStockScript,
    Collections.singletonList("seckill:stock:" + productId)
);
if (remaining < 0) {
    return Result.fail("已售罄");
}
```

**方案三：Redis + 本地缓存标记（进一步优化）**

Redis 扣减成功之前，用本地 AtomicBoolean 标记该商品是否已售罄，售罄后的请求不再访问 Redis（直接返回失败），减轻 Redis 压力：

```java
// 本地售罄标记（内存级，每个实例维护）
private Map<Long, Boolean> soldOutMap = new ConcurrentHashMap<>();

public Result seckill(Long productId, Long userId) {
    // 1. 本地快速判断
    if (Boolean.TRUE.equals(soldOutMap.get(productId))) {
        return Result.fail("已售罄");
    }
    // 2. Redis 原子扣减
    Long remaining = executeStockScript(productId);
    if (remaining < 0) {
        soldOutMap.put(productId, true); // 标记售罄
        return Result.fail("已售罄");
    }
    // 3. 发 MQ 异步下单
    ...
}
```

### 5.2 重复购买校验

用 Redis Set 记录已购用户，防止同一用户多次秒杀：

```java
// SADD 返回 0 说明已购买
Long result = redisTemplate.opsForSet()
    .add("seckill:buyers:" + productId, userId.toString());
if (result == 0) {
    return Result.fail("每人限购一件");
}
```

---

## 六、异步下单——MQ 削峰

Redis 扣减成功后，不直接操作数据库，而是把下单请求投入 MQ：

```java
// 秒杀服务：发消息
SeckillMessage msg = new SeckillMessage(userId, productId, orderId);
rocketMQTemplate.convertAndSend("seckill-topic", msg);
return Result.ok("排队中，请稍候查看订单");
```

```java
// 订单服务：消费消息，异步创建订单
@RocketMQMessageListener(topic = "seckill-topic", consumerGroup = "order-group")
public class SeckillOrderListener implements RocketMQListener<SeckillMessage> {
    @Override
    public void onMessage(SeckillMessage msg) {
        // 1. 幂等校验（防重复消费）
        if (orderService.exists(msg.getOrderId())) return;
        // 2. 扣减 DB 库存
        int rows = stockMapper.deduct(msg.getProductId());
        if (rows == 0) return; // DB 库存不足（兜底）
        // 3. 创建订单
        orderService.create(msg);
    }
}
```

---

## 七、订单超时关闭

用户下单后 15 分钟未支付，自动关闭订单并回滚库存：

**方案：延迟消息（RocketMQ 延迟队列）**
```java
// 下单时投递延迟消息（15 分钟后触发）
Message message = new Message("order-close-topic", JSON.toJSONBytes(order));
message.setDelayTimeLevel(4); // 1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m...
producer.send(message);

// 消费延迟消息
// 检查订单是否已支付，未支付则关闭 + Redis 库存回补 + DB 库存回滚
```

---

## 八、完整流程总结

```
1. 活动开始前：库存预热到 Redis，CDN 刷新静态页面
2. 用户访问：CDN 返回静态页，活动开始时动态获取秒杀 URL
3. 用户点击：
   ① 网关限流（用户 + 全局）
   ② 本地 soldOut 标记校验（毫秒级）
   ③ Redis 重复购买校验
   ④ Redis Lua 原子扣减库存
   ⑤ 发送 MQ 消息，返回"排队中"
4. 异步下单：
   ① 幂等校验
   ② DB 扣减库存（兜底防超卖）
   ③ 创建订单记录
5. 用户轮询订单状态，15 分钟内完成支付
6. 超时未支付：延迟消息触发，关单 + 库存回补
```

---

## 九、压测与容量评估

| 指标 | 参考值 |
|------|--------|
| Redis 单节点 QPS | ~10w（set/get） |
| 单台秒杀服务 QPS | ~5000（含网关、Redis、MQ） |
| MQ 消费速度（单消费者） | ~1000 TPS |
| DB 写入 QPS | ~3000（SSD + 连接池优化） |

**容量规划**：预期峰值 QPS 5w → 需要 10 台秒杀服务 + Redis Cluster + MQ 集群 + 3 台 DB 写节点。

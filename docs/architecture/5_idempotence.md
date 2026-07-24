# 幂等方案总结

> 参考：[幂等的八种实现方式-苏三说技术](https://mp.weixin.qq.com/s/adRe5OuDhMndPltzgP73hg) · [如何保证接口的幂等性-JavaGuide](https://mp.weixin.qq.com/s/tL0fnUR3BNBjP8Qw2pldVg)

**幂等**：同一请求无论执行一次还是多次，结果完全相同。

**触发场景**：网络超时重试、MQ 消费重试、用户重复点击提交、支付回调重推。

---

## 一、八种实现方案

### 1. Token 机制（防重复提交）

适合：表单提交、支付确认等用户操作。

```java
// 1. 获取 Token（前端在打开页面时调用）
public String generateToken(String userId) {
    String token = UUID.randomUUID().toString();
    // NX：不存在才设置；EX：30秒过期
    redis.set("idem:token:" + token, userId, Duration.ofSeconds(30), SetOption.NX);
    return token;
}

// 2. 提交时原子校验+删除（Lua 保证原子性）
private static final String LUA_SCRIPT =
    "if redis.call('get', KEYS[1]) == ARGV[1] then " +
    "    return redis.call('del', KEYS[1]) " +
    "else return 0 end";

public boolean checkAndDeleteToken(String token, String userId) {
    Long result = redis.eval(LUA_SCRIPT,
        List.of("idem:token:" + token), List.of(userId));
    return result != null && result == 1L;
}

// 3. 业务层使用
public void submitOrder(String token, String userId, OrderRequest req) {
    if (!checkAndDeleteToken(token, userId)) {
        throw new IdempotentException("请勿重复提交");
    }
    // 处理订单...
}
```

---

### 2. 数据库唯一索引

适合：插入类操作（订单创建、支付记录）。

```sql
-- 以业务唯一键建唯一索引
ALTER TABLE orders ADD UNIQUE KEY uk_order_no (order_no);
```

```java
public void createOrder(Order order) {
    try {
        orderMapper.insert(order);
    } catch (DuplicateKeyException e) {
        // 唯一索引冲突 = 已处理，直接忽略或返回已有结果
        log.warn("Order {} already exists, skip", order.getOrderNo());
    }
}
```

---

### 3. Redis SETNX

适合：MQ 消费去重、接口防重（无需用户参与）。

```java
public boolean tryLock(String bizKey, Duration ttl) {
    // SET key value NX EX seconds
    Boolean success = redis.setIfAbsent("idem:" + bizKey, "1", ttl);
    return Boolean.TRUE.equals(success);
}

// MQ 消费示例
@RocketMQMessageListener(topic = "order-pay")
public class PayConsumer implements RocketMQListener<PayMessage> {
    @Override
    public void onMessage(PayMessage msg) {
        String key = "pay:" + msg.getPayNo();
        if (!tryLock(key, Duration.ofMinutes(10))) {
            log.info("Duplicate pay message {}, skip", msg.getPayNo());
            return;
        }
        // 处理支付...
    }
}
```

---

### 4. 乐观锁（版本号）

适合：更新类操作，状态流转。

```java
// 表中增加 version 字段
@Update("UPDATE orders SET status=#{newStatus}, version=version+1 " +
        "WHERE id=#{id} AND version=#{version}")
int updateStatus(@Param("id") Long id,
                 @Param("newStatus") int newStatus,
                 @Param("version") int version);

public void completeOrder(Long orderId) {
    Order order = orderMapper.selectById(orderId);
    int affected = orderMapper.updateStatus(
        orderId, OrderStatus.COMPLETED, order.getVersion());
    if (affected == 0) {
        // 并发更新失败，说明已被其他线程处理或版本不匹配
        throw new ConcurrentModificationException("Order state changed, retry");
    }
}
```

---

### 5. 状态机（终态保护）

适合：订单、审批等有明确状态流转的业务。

```java
public enum OrderStatus {
    PENDING, PAID, SHIPPED, COMPLETED, CANCELLED;

    private static final Map<OrderStatus, Set<OrderStatus>> TRANSITIONS = Map.of(
        PENDING,   Set.of(PAID, CANCELLED),
        PAID,      Set.of(SHIPPED, CANCELLED),
        SHIPPED,   Set.of(COMPLETED),
        COMPLETED, Set.of(),   // 终态，不允许任何流转
        CANCELLED, Set.of()    // 终态
    );

    public boolean canTransitTo(OrderStatus next) {
        return TRANSITIONS.getOrDefault(this, Set.of()).contains(next);
    }
}

public void cancelOrder(Long orderId) {
    Order order = orderMapper.selectById(orderId);
    if (!order.getStatus().canTransitTo(OrderStatus.CANCELLED)) {
        // 已是终态（COMPLETED/CANCELLED），直接幂等返回
        return;
    }
    orderMapper.updateStatus(orderId, OrderStatus.CANCELLED);
}
```

---

### 6. Select + Insert（先查后写）

适合：允许有轻微并发窗口、业务逻辑简单的场景。

```java
@Transactional
public void processCallback(String tradeNo, BigDecimal amount) {
    // 先查是否已处理
    PayRecord existing = payRecordMapper.selectByTradeNo(tradeNo);
    if (existing != null) {
        log.info("TradeNo {} already processed", tradeNo);
        return;
    }
    // 未处理，写入记录
    payRecordMapper.insert(new PayRecord(tradeNo, amount));
    // 执行业务...
}
```

> 并发场景下需配合唯一索引兜底，防止两个线程同时通过查询判断。

---

### 7. 分布式锁（串行化处理）

适合：并发极高、其他方案不适用的复杂场景。

```java
public void handleRequest(String requestId) {
    String lockKey = "lock:req:" + requestId;
    RLock lock = redisson.getLock(lockKey);
    boolean acquired = lock.tryLock(0, 30, TimeUnit.SECONDS);
    if (!acquired) {
        throw new IdempotentException("Duplicate request: " + requestId);
    }
    try {
        // 再次查询是否已处理（双重检查）
        if (requestRecordService.exists(requestId)) return;
        // 处理业务...
        requestRecordService.record(requestId);
    } finally {
        lock.unlock();
    }
}
```

---

### 8. MQ 消息去重表

适合：消息队列场景，消费端保证 exactly-once。

```java
@Transactional
public void consume(MqMessage msg) {
    // 利用消息 ID + 唯一索引去重
    try {
        mqDedupeMapper.insert(new MqDedupe(msg.getMsgId(), msg.getTopic()));
    } catch (DuplicateKeyException e) {
        log.info("MQ msg {} already consumed", msg.getMsgId());
        return;
    }
    // 执行业务逻辑...
}
```

---

## 二、方案对比

| 方案 | 适用操作 | 并发安全 | 实现复杂度 | 适用场景 |
|------|---------|---------|----------|---------|
| Token 机制 | 插入 | ✅ Lua 原子 | 中 | 表单提交、支付 |
| 唯一索引 | 插入 | ✅ DB 保证 | 低 | 创建类操作 |
| Redis SETNX | 任意 | ✅ | 低 | MQ 去重、接口防重 |
| 乐观锁 | 更新 | ✅ | 低 | 状态更新 |
| 状态机 | 更新 | 需配合锁 | 中 | 复杂流程 |
| Select+Insert | 插入 | 需唯一索引兜底 | 低 | 简单场景 |
| 分布式锁 | 任意 | ✅ | 高 | 复杂并发 |
| MQ 去重表 | 消费 | ✅ DB 保证 | 低 | MQ 消费 |

**推荐优先级**：唯一索引 > Redis SETNX > Token > 乐观锁 > 其他。

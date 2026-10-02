---
description: Token、唯一索引、乐观锁、去重表、HTTP 语义
---

# 幂等设计

> 幂等性（Idempotency）：对同一操作执行多次，产生的结果与执行一次相同。分布式系统中，网络重试、消息重投、用户重复点击都会导致重复请求，幂等是系统健壮性的基础保障。
>
> 八种实现方案总结与对比选型见 [系统架构：幂等方案总结](../architecture/5_idempotence)。

---

## 一、为什么需要幂等

| 场景 | 问题 |
|------|------|
| 用户重复点击"提交"按钮 | 创建多笔订单 |
| 网络超时后客户端重试 | 重复扣款 |
| MQ 消费者消费后宕机，消息重投 | 重复处理消息 |
| Feign 调用超时重试 | 重复调用下游接口 |
| 定时任务重复执行 | 重复发短信/邮件 |

---

## 二、Token 机制（防重复提交）

### 2.1 原理

```
1. 客户端请求前，先从服务端获取唯一 Token（存入 Redis）
2. 客户端提交时，携带该 Token
3. 服务端用 Lua 原子检查并删除 Token
   - Token 存在 → 正常处理，删除 Token
   - Token 不存在 → 重复请求，拒绝
```

### 2.2 实现

```java
// 1. 获取提交 Token
@GetMapping("/token")
public Result getToken() {
    String token = UUID.randomUUID().toString();
    redis.set("idempotent:token:" + token, "1", 5, TimeUnit.MINUTES);
    return Result.ok(token);
}

// 2. Lua 脚本原子校验并删除（防止并发竞争）
private static final String CHECK_AND_DEL_LUA =
    "if redis.call('GET', KEYS[1]) then " +
    "  return redis.call('DEL', KEYS[1]) " +
    "else " +
    "  return 0 " +
    "end";

// 3. 接口层拦截器
@Aspect
@Component
public class IdempotentAspect {
    @Around("@annotation(Idempotent)")
    public Object check(ProceedingJoinPoint jp) throws Throwable {
        HttpServletRequest request = getRequest();
        String token = request.getHeader("Idempotent-Token");
        if (token == null) throw new BusinessException("缺少幂等 Token");

        Long deleted = redis.execute(checkAndDelScript,
            Collections.singletonList("idempotent:token:" + token));
        if (deleted == null || deleted == 0) {
            throw new BusinessException("请勿重复提交");
        }
        return jp.proceed();
    }
}
```

**使用：**
```java
@PostMapping("/order/create")
@Idempotent  // 自定义注解
public Result createOrder(@RequestBody CreateOrderRequest req) { ... }
```

---

## 三、数据库唯一索引

### 3.1 原理

在业务唯一约束字段上建唯一索引，重复插入抛 `DuplicateKeyException`，捕获后返回原记录。

```sql
-- 订单表：业务号唯一
ALTER TABLE orders ADD UNIQUE KEY uk_biz_no (biz_no);

-- 支付记录：(订单号 + 支付渠道) 唯一
ALTER TABLE payment ADD UNIQUE KEY uk_order_channel (order_id, channel);
```

```java
public Order createOrder(CreateOrderRequest req) {
    Order order = buildOrder(req);
    try {
        orderMapper.insert(order);
        return order;
    } catch (DuplicateKeyException e) {
        // 重复请求：查询并返回已有记录
        return orderMapper.selectByBizNo(req.getBizNo());
    }
}
```

**适用场景**：插入类操作（创建订单、创建支付单），不适合更新类操作。

---

## 四、乐观锁（状态机 + 版本号）

### 4.1 状态机保证幂等

通过限制状态流转方向，天然保证幂等：

```sql
-- 只允许从"待支付"改为"已支付"，重复执行影响行数为 0
UPDATE orders
SET status = 'PAID', version = version + 1
WHERE id = #{id} AND status = 'PENDING' AND version = #{version};
```

```java
int rows = orderMapper.updateStatus(orderId, "PENDING", "PAID", version);
if (rows == 0) {
    // 已经支付过了（幂等），查询当前状态返回
    Order order = orderMapper.selectById(orderId);
    if ("PAID".equals(order.getStatus())) {
        return Result.ok("已支付");
    }
    throw new BusinessException("状态更新失败，可能存在并发冲突");
}
```

### 4.2 版本号（CAS）

```java
// 更新时携带 version，版本不匹配则拒绝
public void updateStock(Long productId, int delta, int version) {
    int rows = stockMapper.updateWithVersion(productId, delta, version);
    if (rows == 0) {
        throw new OptimisticLockException("并发更新，请重试");
    }
}
```

---

## 五、去重表（MQ 消费幂等）

### 5.1 问题

MQ 保证消息至少投递一次（at-least-once），消费者可能收到重复消息。

### 5.2 去重表方案

```sql
-- 消息去重表
CREATE TABLE mq_dedup (
    msg_id      VARCHAR(64) PRIMARY KEY,  -- 消息唯一 ID
    topic       VARCHAR(128),
    created_at  DATETIME NOT NULL
);
```

```java
@RocketMQMessageListener(topic = "order-topic", consumerGroup = "order-group")
public class OrderMessageListener implements RocketMQListener<OrderMessage> {
    @Override
    @Transactional
    public void onMessage(OrderMessage msg) {
        // 幂等：插入去重记录（唯一索引冲突则跳过）
        try {
            dedupMapper.insert(new MqDedup(msg.getMsgId(), "order-topic"));
        } catch (DuplicateKeyException e) {
            log.warn("重复消息，跳过: {}", msg.getMsgId());
            return;
        }
        // 正常业务处理
        orderService.process(msg);
    }
}
```

### 5.3 Redis 去重（性能更高）

```java
public void onMessage(OrderMessage msg) {
    String key = "mq:dedup:" + msg.getMsgId();
    // SET NX EX：只有第一次执行成功
    Boolean isFirst = redis.opsForValue().setIfAbsent(key, "1", 1, TimeUnit.DAYS);
    if (!Boolean.TRUE.equals(isFirst)) {
        return; // 重复消息，跳过
    }
    orderService.process(msg);
}
```

**注意**：Redis 存在宕机丢数据风险，对一致性要求高的场景用 DB 去重表。

---

## 六、分布式锁 + 查询兜底

### 6.1 适用场景

适合无法通过唯一索引或状态机判断幂等的复杂场景（如批量操作）。

```java
public Result processRefund(String refundNo) {
    // 1. 加分布式锁（防并发重复处理）
    try (var lock = redisLock.tryLock("refund:" + refundNo, 10, TimeUnit.SECONDS)) {
        if (lock == null) {
            return Result.fail("系统繁忙，请稍后重试");
        }

        // 2. 查询是否已处理（幂等检查）
        Refund refund = refundMapper.selectByNo(refundNo);
        if (refund.getStatus() != RefundStatus.PENDING) {
            return Result.ok("已处理"); // 已完成，直接返回
        }

        // 3. 执行退款
        payService.refund(refundNo, refund.getAmount());
        refundMapper.updateStatus(refundNo, RefundStatus.SUCCESS);

        return Result.ok();
    }
}
```

---

## 七、接口级幂等（HTTP 语义）

| HTTP 方法 | 是否天然幂等 | 说明 |
|----------|------------|------|
| GET | ✅ | 查询，不修改数据 |
| PUT | ✅ | 全量更新，执行多次结果相同 |
| DELETE | ✅ | 删除，重复删除返回 404 即可 |
| POST | ❌ | 创建，需要额外幂等机制 |
| PATCH | ❌ | 部分更新，可能累加，需要幂等机制 |

**RESTful 设计建议**：能用 PUT 替代 POST 的场景尽量用 PUT（如更新资源），天然幂等。

---

## 八、各方案对比

| 方案 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| Token 机制 | 前端防重复提交 | 通用，可 AOP 透明拦截 | 需额外接口获取 Token |
| 数据库唯一索引 | 创建类操作 | 实现简单，强一致 | 只适合插入，性能有限 |
| 乐观锁/状态机 | 更新类操作 | 无额外存储开销 | 需要状态字段支持 |
| MQ 去重表（DB） | MQ 消费 | 可靠，持久化 | 写 DB 有开销 |
| MQ 去重（Redis） | MQ 消费 | 高性能 | 宕机可能丢数据 |
| 分布式锁 + 查询 | 复杂场景 | 通用性强 | 性能较低，需处理锁超时 |

::: tip 选型建议
- 前端表单提交：**Token 机制**
- 下单/支付创建：**数据库唯一索引**（bizNo）
- 状态变更：**乐观锁 + 状态机**
- MQ 消费：**Redis SET NX**（高性能）或 **DB 去重表**（高可靠）
- 复杂幂等：**分布式锁 + 状态查询**兜底
:::

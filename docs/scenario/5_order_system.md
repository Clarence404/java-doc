# 订单系统设计

> 订单是电商系统的核心，涉及状态流转、幂等控制、分布式事务、超时处理等多个复杂场景。

---

## 一、订单状态机

### 1.1 核心状态流转

```
待支付 (PENDING_PAYMENT)
    │
    ├─ 支付成功 ──→ 待发货 (PENDING_SHIPMENT)
    │                   │
    │               发货 ──→ 已发货 (SHIPPED)
    │                           │
    │                       确认收货 ──→ 已完成 (COMPLETED)
    │                           │
    │                       申请退款 ──→ 退款中 (REFUNDING) ──→ 已退款 (REFUNDED)
    │
    ├─ 超时未支付 ──→ 已取消 (CANCELLED)
    │
    └─ 用户主动取消 ──→ 已取消 (CANCELLED)
```

### 1.2 状态机实现

```java
public enum OrderStatus {
    PENDING_PAYMENT, PENDING_SHIPMENT, SHIPPED, COMPLETED, CANCELLED, REFUNDING, REFUNDED;

    // 定义合法的状态流转
    private static final Map<OrderStatus, Set<OrderStatus>> TRANSITIONS = Map.of(
        PENDING_PAYMENT, Set.of(PENDING_SHIPMENT, CANCELLED),
        PENDING_SHIPMENT, Set.of(SHIPPED, REFUNDING),
        SHIPPED,          Set.of(COMPLETED, REFUNDING),
        REFUNDING,        Set.of(REFUNDED)
    );

    public boolean canTransitTo(OrderStatus next) {
        return TRANSITIONS.getOrDefault(this, Set.of()).contains(next);
    }
}

// 状态流转时校验
public void updateStatus(Long orderId, OrderStatus newStatus) {
    Order order = orderMapper.selectById(orderId);
    if (!order.getStatus().canTransitTo(newStatus)) {
        throw new IllegalStateException("非法状态流转: " + order.getStatus() + " -> " + newStatus);
    }
    // 乐观锁更新，防并发
    int rows = orderMapper.updateStatus(orderId, order.getStatus(), newStatus, order.getVersion());
    if (rows == 0) throw new OptimisticLockException("并发更新冲突，请重试");
}
```

---

## 二、下单流程设计

### 2.1 完整下单流程

```
1. 参数校验（商品存在、用户地址合法、优惠券有效）
2. 库存预占（Redis 预减 or 数据库锁）
3. 计算价格（防止前端篡改金额）
4. 生成订单 ID（雪花算法，全局唯一）
5. 创建订单记录（状态=待支付）
6. 生成支付单，调用支付服务
7. 返回支付链接，用户跳转支付
```

### 2.2 防超卖（乐观锁）

```sql
-- 扣减库存，version 乐观锁防并发
UPDATE product_stock
SET stock = stock - #{quantity}, version = version + 1
WHERE product_id = #{productId}
  AND stock >= #{quantity}
  AND version = #{version};
```

### 2.3 幂等控制

下单接口可能因网络重试被多次调用，需保证幂等：

```java
// 客户端生成唯一幂等键（订单业务号），传给服务端
// 服务端用数据库唯一索引保证幂等
@UniqueConstraint(columnNames = {"biz_no"})  // 业务号唯一索引
public class Order {
    private String bizNo;  // 客户端生成的幂等号
    // ...
}

// 捕获唯一索引冲突，查询已有订单返回
try {
    orderMapper.insert(order);
} catch (DuplicateKeyException e) {
    return orderMapper.selectByBizNo(order.getBizNo());
}
```

---

## 三、支付回调处理

### 3.1 挑战

- 支付宝/微信回调可能重复（网络超时重试）
- 必须在 5 秒内返回响应，否则支付平台继续重试
- 回调与系统内部状态更新需保持原子

### 3.2 回调处理流程

```java
@PostMapping("/pay/callback")
public String payCallback(HttpServletRequest request) {
    // 1. 验签（防伪造回调）
    if (!payService.verifySign(request)) {
        return "fail";
    }

    String tradeNo = request.getParameter("out_trade_no");
    String payStatus = request.getParameter("trade_status");

    // 2. 幂等：已处理过则直接返回 success
    if (orderService.isCallbackProcessed(tradeNo)) {
        return "success";
    }

    // 3. 更新订单状态（分布式锁防并发回调）
    try (var lock = redisLock.lock("pay:callback:" + tradeNo)) {
        if ("TRADE_SUCCESS".equals(payStatus)) {
            orderService.paySuccess(tradeNo);  // 更新订单状态 + 触发后续流程
        }
    }

    return "success"; // 必须返回 success，否则支付平台会持续重试
}
```

### 3.3 回调超时的补偿机制

支付平台有时回调会延迟或丢失，需要主动查单：

```java
// 定时任务：每分钟查询"待支付"超过 5 分钟但未超 15 分钟的订单
@Scheduled(fixedRate = 60_000)
public void checkPayStatus() {
    List<Order> orders = orderMapper.selectPendingOrders(5, 15); // 5~15 分钟
    for (Order order : orders) {
        PayStatus status = payService.queryFromThirdParty(order.getPayNo());
        if (status == PayStatus.SUCCESS) {
            orderService.paySuccess(order.getPayNo());
        }
    }
}
```

---

## 四、超时未支付自动关单

### 4.1 方案对比

| 方案 | 原理 | 优缺点 |
|------|------|--------|
| 定时任务扫描 | 每分钟扫 `status=待支付 AND created_at < now-15m` | 实现简单，但有延迟且轮询压力大 |
| Redis 过期监听 | key 过期触发回调 | 不可靠（Redis 过期通知不保证 100% 送达） |
| RocketMQ 延迟消息 | 下单时发 15min 延迟消息 | 可靠，推荐 |
| 时间轮（HashedWheelTimer） | 内存级定时器 | 服务重启会丢失，需持久化配合 |

### 4.2 延迟消息实现

```java
// 下单时发延迟消息
public void createOrder(Order order) {
    orderMapper.insert(order);

    // 发送 15 分钟后触发的延迟消息
    OrderCloseMessage msg = new OrderCloseMessage(order.getId());
    Message<OrderCloseMessage> message = MessageBuilder
        .withPayload(msg)
        .build();
    rocketMQTemplate.syncSendDelayTimeSeconds("order-close-topic", message, 900); // 900s = 15min
}

// 消费关单消息
@RocketMQMessageListener(topic = "order-close-topic", consumerGroup = "order-close-group")
public class OrderCloseListener implements RocketMQListener<OrderCloseMessage> {
    @Override
    public void onMessage(OrderCloseMessage msg) {
        Order order = orderMapper.selectById(msg.getOrderId());
        // 幂等：已不是待支付状态则忽略
        if (order == null || order.getStatus() != OrderStatus.PENDING_PAYMENT) return;
        // 关闭订单 + 回补库存
        orderService.closeOrder(order.getId());
        stockService.revert(order.getProductId(), order.getQuantity());
    }
}
```

---

## 五、分布式事务

订单创建涉及多个服务，需要保证最终一致性：

```
订单服务：创建订单记录
库存服务：扣减库存
积分服务：预增积分
优惠券服务：核销优惠券
```

**推荐方案：RocketMQ 事务消息**

```java
// 订单服务：事务消息发送
@GlobalTransactional  // 或 RocketMQ 事务消息
public Order createOrder(CreateOrderRequest req) {
    // 1. 本地事务：创建订单
    Order order = buildOrder(req);
    orderMapper.insert(order);

    // 2. 发送事务消息，库存服务订阅扣减
    rocketMQTemplate.sendMessageInTransaction(
        "inventory-deduct-topic",
        MessageBuilder.withPayload(new DeductMessage(req.getProductId(), req.getQuantity()))
                      .setHeader("orderId", order.getId())
                      .build(),
        order
    );
    return order;
}
```

---

## 六、退款流程

### 6.1 退款状态流转

```
用户申请退款 → 商家审核 → 平台退款 → 退款成功/失败
    ↓
退款单创建（关联原订单）
    ↓
调用支付平台退款接口（幂等，退款单号唯一）
    ↓
支付平台异步回调退款结果
    ↓
更新订单状态 = 已退款，回补库存/积分
```

### 6.2 退款幂等

退款接口调用支付平台时，必须传入唯一退款单号，防止重复退款：

```java
public void applyRefund(Long orderId, BigDecimal amount) {
    // 退款单号用订单号+退款次数，保证唯一
    String refundNo = orderId + "_" + getRefundCount(orderId);

    // 幂等：同一退款单号已发起则查状态
    Refund existRefund = refundMapper.selectByRefundNo(refundNo);
    if (existRefund != null) {
        // 已申请，查询结果
        return;
    }
    // 创建退款单 + 调用支付平台
    payService.refund(refundNo, amount);
}
```

---

## 七、大促订单架构扩展

### 7.1 读写分离

- 订单详情查询 → 从库
- 用户订单列表 → ES（按 userId 索引）
- 创建/更新订单 → 主库

### 7.2 订单分库分表

按 `user_id % 16` 分 16 个库，每库 16 张表（256 张分表），支持千亿级订单：

```
order_db_00.order_0000  （user_id % 16 = 0，order_id % 16 = 0）
order_db_00.order_0001
...
order_db_15.order_0255
```

注意：分表后按订单号查询需要路由到 user_id（在订单号中编码 user_id），或建立订单号 → user_id 的映射表。

### 7.3 订单归档

超过 6 个月的历史订单归档到 ClickHouse / TiDB，MySQL 主表只保留近期数据，保证主表查询性能。

---
description: 状态机与条件更新、下单幂等与库存预占、支付回调、超时关单、按流程选分布式事务、退款
---

# 订单

> **本篇目标**：设计一个经得起重试、并发和故障的订单系统：状态流转只靠条件更新，下单、支付回调、关单、退款都可以安全重放，跨服务的一致性按流程选定一种方案。
>
> **前置阅读**：[幂等方案总结](/architecture/5_idempotence)、[分布式事务](/distributed/4_transaction)、[消息队列基础](/messaging/1_basics)

订单的难点不在建表，而在**每个环节都会被重复调用**：用户重复提交、支付平台重复通知、MQ 重复投递、定时任务和消息同时关单。本篇的统一做法是：唯一约束挡重复，状态条件更新挡并发，消息在事务提交之后发出。

---

## 一、订单状态机

### 1、主状态流转

![订单主状态流转](../assets/scenario/order_state.svg)

退款不放进订单主状态：一笔订单可能多次部分退款，退款进度记录在独立的退款单上，只有全额退完时订单才流转到「已关闭」。

### 2、只用条件更新改状态

```java
public enum OrderStatus {
    PENDING_PAYMENT, PENDING_SHIPMENT, SHIPPED, COMPLETED, CANCELLED, CLOSED;

    private static final Map<OrderStatus, Set<OrderStatus>> TRANSITIONS = Map.of(
            PENDING_PAYMENT,  Set.of(PENDING_SHIPMENT, CANCELLED),
            PENDING_SHIPMENT, Set.of(SHIPPED, CLOSED),
            SHIPPED,          Set.of(COMPLETED, CLOSED),
            COMPLETED,        Set.of(CLOSED));

    public boolean canTransitTo(OrderStatus next) {
        return TRANSITIONS.getOrDefault(this, Set.of()).contains(next);
    }
}
```

```java
public void transit(long orderId, OrderStatus from, OrderStatus to) {
    if (!from.canTransitTo(to)) {
        throw new IllegalStateException("非法状态流转: " + from + " -> " + to);
    }
    // UPDATE orders SET status = #{to} WHERE id = #{orderId} AND status = #{from}
    if (orderMapper.updateStatus(orderId, from, to) == 0) {
        throw new OptimisticLockingFailureException("订单状态已变化: " + orderId);
    }
}
```

`WHERE status = #{from}` 本身就是并发控制：支付回调和关单同时到达时，只有一个能把「待支付」改掉，另一个影响 0 行。不需要额外的 version 字段。

---

## 二、下单：幂等与库存预占

### 1、流程

1. 校验参数（商品、地址、优惠券），**服务端计算价格**，不信任前端金额
2. 用客户端提交的幂等号 `biz_no` 查订单，已存在直接返回
3. 调库存服务**预占**库存、调优惠券服务锁定优惠券，两者都以 `biz_no` 作为幂等键
4. 生成订单号（雪花算法，见 [分布式 ID 生成](/distributed/8_id_generator)），插入订单，状态为待支付
5. 事务提交后发送 15 分钟关单定时消息
6. 创建支付单，返回支付参数

幂等检查和插入订单都在预占之后，所以**预占本身必须幂等**：重复请求用同一个 `biz_no` 预占，库存服务直接返回上次的结果，不会重复扣减。

### 2、库存服务：幂等预占

```sql
-- stock_reservation：UNIQUE KEY uk_biz_no_sku (biz_no, sku_id)
-- 同一个本地事务：先插预占记录，撞唯一键说明已预占过，直接返回成功
INSERT INTO stock_reservation (biz_no, sku_id, quantity, status) VALUES (?, ?, ?, 'RESERVED');

-- 条件更新：可用库存够才预占，影响 0 行则回滚整个事务并返回库存不足
UPDATE sku_stock
SET available = available - #{quantity}, reserved = reserved + #{quantity}
WHERE sku_id = #{skuId} AND available >= #{quantity};
```

只用 `available >= quantity` 条件就能防超卖，不需要再加 version：版本号会让库存充足的并发请求也失败。库存热点（单个 SKU 被集中抢购）见 [秒杀](./4_seckill)。

### 3、订单服务：唯一约束兜底

```java
// orders：UNIQUE KEY uk_biz_no (biz_no)
@Transactional
public Order createOrder(CreateOrderCommand cmd) {
    Order existing = orderMapper.selectByBizNo(cmd.bizNo());
    if (existing != null) {
        return existing;                                   // 重试请求：返回已有订单
    }
    inventoryClient.reserve(cmd.bizNo(), cmd.items());     // 幂等预占，库存不足抛异常
    couponClient.lock(cmd.bizNo(), cmd.couponId());        // 幂等锁券

    Order order = Order.create(idGenerator.nextId(), cmd, pricingService.price(cmd));
    try {
        orderMapper.insert(order);
    } catch (DuplicateKeyException e) {
        return orderMapper.selectByBizNo(cmd.bizNo());     // 并发的同一请求已建单，预占是同一份
    }
    eventPublisher.publishEvent(new OrderCreatedEvent(order.getId()));   // 提交后才发关单消息，见第四节
    return order;
}
```

- 远程调用放在事务里会拉长事务、占用连接，量大时把预占移到事务外，只把插入订单放进事务
- 预占成功、建单失败（宕机、非唯一键异常）会留下**悬挂预占**：库存服务定时扫描超过 N 分钟的 `RESERVED` 记录，按 `biz_no` 向订单服务确认，没有订单就释放
- 幂等方案的通用对比见 [幂等方案总结](/architecture/5_idempotence)

---

## 三、支付回调

### 1、两大平台的差异

| 项目 | 支付宝 | 微信支付 APIv3 |
|------|--------|----------------|
| 成功状态 | `trade_status` 为 `TRADE_SUCCESS` 或 `TRADE_FINISHED` | 解密后 `trade_state` 为 `SUCCESS` |
| 应答成功 | 响应体返回纯文本 `success` | 返回 HTTP 200 或 204 |
| 应答失败 | 返回其他内容，平台按间隔重发 | 返回 4XX / 5XX，平台按间隔重发 |
| 必须校验 | 验签，`out_trade_no`、`total_amount`、`app_id` 与本地一致 | 验签并解密，`out_trade_no`、金额、`appid` / `mchid` 与本地一致 |

只验签不校验金额和商户号，就可能被别的订单或低金额的合法通知冒充。

### 2、回调处理

```java
@PostMapping("/pay/notify/alipay")
public String alipayNotify(@RequestParam Map<String, String> params) {
    if (!alipayVerifier.verify(params)) {
        return "failure";                                   // 验签失败
    }
    PayNotify n = PayNotify.fromAlipay(params);
    if (!n.isPaid()) {
        return "success";                                   // 非成功状态：确认收到即可
    }
    Payment payment = paymentMapper.selectByPayNo(n.payNo());
    if (payment == null
            || payment.getAmount().compareTo(n.amount()) != 0
            || !alipayAppId.equals(n.appId())) {
        log.warn("支付通知与本地支付单不一致: {}", n);
        return "failure";
    }
    orderPayService.paySuccess(n);
    return "success";
}
```

```java
@Transactional
public void paySuccess(PayNotify n) {
    // payment：UNIQUE KEY uk_pay_no (pay_no)、UNIQUE KEY uk_trade_no (trade_no)
    // UPDATE payment SET status='SUCCESS', trade_no=?, paid_at=? WHERE pay_no=? AND status='WAITING'
    if (paymentMapper.markSuccess(n.payNo(), n.tradeNo(), n.paidAt()) == 0) {
        return;                                             // 重复通知或主动查单已处理
    }
    if (orderMapper.updateStatus(n.orderId(), PENDING_PAYMENT, PENDING_SHIPMENT) == 0) {
        refundService.applyAutoRefund(n.orderId(), n.payNo(), n.amount());   // 关单后才到账：自动退款
        return;
    }
    outboxMapper.insert(OutboxEvent.of("ORDER_PAID", n.orderId()));         // 与状态变更同一事务
}
```

- **幂等靠支付单的状态条件更新**：`WAITING → SUCCESS` 只会成功一次，重复通知、通知与主动查单并发都影响 0 行。不需要分布式锁，更不能「锁外先查、锁内不查」
- **下游通知走 Outbox**：发货、积分、确认扣减库存都订阅 `ORDER_PAID`，事件与状态变更在同一事务落库，提交后由投递任务发出
- 回调里只做校验和落库，耗时的后续动作全部异步，保证快速应答

### 3、主动查单

通知可能延迟或丢失，定时任务查询「待支付且已发起支付」的订单，查到已支付就调用同一个 `paySuccess`。多实例部署时 `@Scheduled` 会在每个实例上执行，用 XXL-JOB 或 ShedLock 保证单实例运行，见 [分布式调度](/distributed/6_job_scheduler)。关单前也要最后查一次，见下一节。

---

## 四、超时关单

### 1、方案对比

| 方案 | 原理 | 评价 |
|------|------|------|
| 定时扫描 | 每分钟扫 `status = 待支付 AND created_at < now - 15m` | 简单可靠，有分钟级延迟，量大时需分片扫描；适合作为兜底 |
| RocketMQ 5.x 定时消息 | 下单时发 15 分钟后投递的消息 | 精确、可靠，推荐；4.x 只有 18 个固定级别，没有 15 分钟 |
| RabbitMQ 延迟 | 延迟消息插件，或 TTL + 死信队列 | 可用；TTL 方案有队头阻塞，不同时长要分队列 |
| Redisson 延迟队列 | 基于 Redis ZSet 的 `RDelayedQueue` | 轻量，可靠性取决于 Redis 持久化 |
| Redis 过期通知 | key 过期发事件 | 不可靠：通知不持久化，订阅方断开即丢，不建议 |
| 内存时间轮 | Netty `HashedWheelTimer` | 重启丢失，只能配合持久化与扫描使用 |

各类延迟消息的原理见 [RocketMQ](/messaging/3_rocketmq#_1、延迟消息-4-x-固定级别-vs-5-x-任意时间) 的延迟消息一节，常用组合是**定时消息 + 定时扫描兜底**。

### 2、事务提交后再发定时消息

```java
@Component
@RequiredArgsConstructor
public class OrderCloseScheduler {

    private final RocketMQTemplate rocketMQTemplate;

    // 订单事务提交后才执行；回滚则不发
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderCreated(OrderCreatedEvent e) {
        try {
            rocketMQTemplate.syncSendDelayTimeSeconds("order-close-topic",
                    new OrderCloseMessage(e.orderId()), 15 * 60);   // 需要 RocketMQ 5.x Broker
        } catch (MessagingException ex) {
            log.warn("关单消息发送失败，由扫描任务兜底 orderId={}", e.orderId(), ex);
        }
    }
}
```

在事务里直接发送有两个问题：事务回滚后消息照样发出；事务提交前消息就被消费，查不到订单。提交后发送失败的那部分由「超过 16 分钟仍待支付」的扫描任务兜底。

### 3、关单与释放库存原子化

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(topic = "order-close-topic", consumerGroup = "order-close-group")
public class OrderCloseListener implements RocketMQListener<OrderCloseMessage> {

    private final OrderCloseService orderCloseService;

    @Override
    public void onMessage(OrderCloseMessage msg) {
        orderCloseService.closeIfUnpaid(msg.orderId());
    }
}

@Service
@RequiredArgsConstructor
public class OrderCloseService {

    public void closeIfUnpaid(long orderId) {
        Order order = orderMapper.selectById(orderId);
        if (order == null || order.getStatus() != OrderStatus.PENDING_PAYMENT) {
            return;                                         // 快速路径，真正的判断在条件更新
        }
        // 1. 先关闭支付平台上的交易；关不掉说明用户已付款，按支付成功处理
        if (payGateway.closeTrade(order.getPayNo()) == CloseResult.ALREADY_PAID) {
            orderPayService.paySuccess(payGateway.query(order.getPayNo()));
            return;
        }
        // 2. 本地关单与「释放库存」事件在同一个事务
        transactionTemplate.executeWithoutResult(status -> {
            if (orderMapper.updateStatus(orderId, PENDING_PAYMENT, CANCELLED) == 0) {
                return;                                     // 已支付或已关闭：重复消息直接结束
            }
            outboxMapper.insert(OutboxEvent.of("ORDER_CANCELLED", orderId));
        });
    }
}
```

库存服务消费 `ORDER_CANCELLED` 时同样用条件更新保证只释放一次：

```sql
-- 同一个本地事务：预占记录 RESERVED → RELEASED 影响 1 行，才把库存加回
UPDATE stock_reservation SET status = 'RELEASED'
WHERE biz_no = ? AND sku_id = ? AND status = 'RESERVED';

UPDATE sku_stock
SET available = available + #{quantity}, reserved = reserved - #{quantity}
WHERE sku_id = #{skuId};
```

- 关单先调支付平台关单接口（支付宝 `alipay.trade.close`、微信支付关单接口），否则可能本地刚关单，用户就付款成功
- 「先查状态、再关单、再回补」三步分开执行时，并发的支付回调或重复消息会导致已支付订单被关闭、库存重复回补；条件更新 + 同事务事件可以消除这些问题
- 订单和库存在同一个库时，直接在关单事务里执行上面两条 SQL，不需要事件

---

## 五、分布式事务：按流程选一种

一个下单流程不要同时套用 Seata 全局事务和事务消息：两者解决的问题不同，混用后边界不清，出了问题难以判断该由谁回滚。按流程选择：

| 流程 | 一致性要求 | 方案 |
|------|------------|------|
| 下单：库存、优惠券 | 必须同步知道成败 | 幂等预占（TCC 思路：下单 Try 预占、支付后 Confirm 扣减、关单 Cancel 释放），悬挂预占靠扫描释放 |
| 支付成功 → 发货、积分、确认扣库存 | 最终一致 | Transactional Outbox（本文选用）或 RocketMQ 事务消息，二选一 |
| 关单 → 释放库存、解锁优惠券 | 最终一致 | 同上，`ORDER_CANCELLED` 事件 |
| 内部后台、低并发、要同步整体回滚 | 同步出结果、失败整体回滚 | 可以用 Seata AT（仍是最终一致，注意全局锁带来的写阻塞与默认读未提交）；确需强一致用 Seata XA |

**Outbox 与事务消息怎么选**：Outbox 只依赖本地数据库，任何 MQ 都能用，代价是多一张表和一个投递任务（或用 CDC 读 binlog 投递）；RocketMQ 事务消息不需要额外的表，但本地事务必须写在 `executeLocalTransaction` 里，并实现回查 `checkLocalTransaction`：查到事务记录返回 COMMIT，查不到且仍在不确定窗口内返回 UNKNOWN，不能直接回滚。完整实现见 [RocketMQ](/messaging/3_rocketmq#七、事务消息) 的事务消息一节和 [消息队列基础](/messaging/1_basics) 的分布式事务一节，Seata 各模式对比见 [分布式事务](/distributed/4_transaction)。

无论哪种方案，**下游消费者都要幂等**：积分服务以 `orderId` 建唯一约束，库存服务以预占记录的状态条件更新。

---

## 六、退款

### 1、流程

1. 用户提交退款申请，携带客户端生成的退款请求号 `request_no`
2. 校验可退金额，**一次性生成退款单号并落库**，状态为已申请
3. 商家审核：驳回则释放可退额度；通过则流转到已审核
4. 退款执行任务把退款单改为退款中，用**固定的退款单号**调用支付平台，失败重试时始终复用
5. 平台异步通知或主动查询得到结果，条件更新为成功 / 失败；失败释放可退额度
6. 退款成功后：累计退款等于实付时订单流转到已关闭；未发货的退款释放库存，积分、优惠券按规则回退，同样通过 Outbox 事件通知

### 2、申请：固定退款单号 + 额度条件更新

```java
// refund：UNIQUE KEY uk_refund_no (refund_no)、UNIQUE KEY uk_order_request (order_id, request_no)
@Transactional
public Refund apply(long orderId, String requestNo, BigDecimal amount) {
    Refund existing = refundMapper.selectByRequest(orderId, requestNo);
    if (existing != null) {
        return existing;                                    // 重复申请：返回同一张退款单
    }
    // UPDATE orders SET refund_amount = refund_amount + #{amount}
    // WHERE id = #{orderId} AND refund_amount + #{amount} <= pay_amount
    if (orderMapper.occupyRefundAmount(orderId, amount) == 0) {
        throw new BizException("超过可退金额");
    }
    Refund refund = Refund.applied(idGenerator.nextId(), orderId, requestNo, amount);
    refundMapper.insert(refund);                            // 并发重复申请撞唯一键，整个事务回滚
    return refund;
}
```

### 3、执行：复用同一个退款单号

```java
public void execute(String refundNo) {
    Refund r = refundMapper.selectByRefundNo(refundNo);
    if (r.getStatus() == RefundStatus.APPROVED) {
        refundMapper.updateStatus(refundNo, RefundStatus.APPROVED, RefundStatus.REFUNDING);
    } else if (r.getStatus() != RefundStatus.REFUNDING) {
        return;                                             // 已有终态，不再调用平台
    }
    // 支付宝部分退款用 out_request_no，微信支付用 out_refund_no；平台按该编号幂等
    payGateway.refund(r.getPayNo(), r.getRefundNo(), r.getAmount());
}
```

- 不要在调用时用「订单号 + 退款次数」临时拼退款单号：重试时次数可能已经变化，拼出一个新单号，平台会把它当成另一笔退款，造成重复退款
- 可退额度用条件更新占用，两个并发的部分退款不会超出实付金额

---

## 七、大促扩展

### 1、读写路由

- 创建、支付、关单等写操作走主库
- 订单详情默认走从库，但**支付完成后的跳转页、刚修改过的订单走主库**，否则主从延迟会让用户看到「待支付」
- 用户订单列表、运营多条件查询走 ES 或 OLAP，由 binlog / CDC 同步

### 2、分库分表

库和表用同一个分片键，避免按用户查订单时扫全部分表：

| 项目 | 规则 |
|------|------|
| 分片键 | `user_id` |
| 库 | `user_id % 16`，共 16 个库 |
| 表 | `(user_id / 16) % 16`，每库 16 张表，共 256 张 |
| 订单号 | 雪花 ID 低位嵌入 `user_id` 的低 8 位（基因法），只凭订单号也能路由 |

256 张表、每张控制在千万行左右，总量约数十亿行；更大规模要提前规划扩容方式。分片算法、基因法与扩容迁移见 [分库分表与中间件](/database/5_practice/2_sharding)。

### 3、历史订单归档

超过一定时间的已完结订单迁出主表，主表只保留近期数据，见 [数据冷热分离](/architecture/1_cold_hot_data)。

---

## 小结

- 订单主状态只靠 `WHERE status = 旧状态` 的条件更新流转，并发控制不需要 version；退款进度放在独立的退款单上
- 下单以 `biz_no` 唯一约束兜底，库存与优惠券预占也必须以 `biz_no` 幂等，悬挂预占靠扫描释放
- 支付回调要验签并校验金额与商户号；幂等靠支付单 `WAITING → SUCCESS` 条件更新和支付单号唯一约束，后续动作通过 Outbox 事件触发
- 关单先关支付平台交易，再在一个事务里条件更新订单并写释放库存事件；库存侧以预占记录状态保证只释放一次
- 定时消息在事务提交后发送（`@TransactionalEventListener(AFTER_COMMIT)`），失败由扫描任务兜底；RocketMQ 4.x 没有 15 分钟级别
- 一个流程只选一种分布式事务方案：同步预占、Outbox 或事务消息、Seata 各管各的
- 退款单号申请时一次生成并落库，重试始终复用；可退额度用条件更新占用

## 参考资料

- 微信支付 APIv3 支付通知：[https://pay.weixin.qq.com/doc/v3/merchant/4012791861](https://pay.weixin.qq.com/doc/v3/merchant/4012791861)
- RocketMQ 定时 / 延时消息：[https://rocketmq.apache.org/docs/featureBehavior/02delaymessage](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage)
- RocketMQ 事务消息：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage)
- Spring Framework Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Apache Seata：[https://seata.apache.org/docs/overview/what-is-seata](https://seata.apache.org/docs/overview/what-is-seata)

> 下一篇：[短链接](./6_shorturl) —— 短码生成、存储与缓存、跳转与统计、高可用。

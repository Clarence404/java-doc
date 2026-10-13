---
description: 状态机与条件更新、下单幂等与库存预占、消费支付成功事件、超时关单、订单侧退款、按流程选分布式事务、分库分表、容量估算
---

# 订单

> 前置阅读：[幂等方案总结](/architecture/3_idempotence)、[分布式事务](/distributed/4_transaction)、[消息队列基础](/messaging/1_basics)

订单的难点不在建表，而在**每个环节都会被重复调用**：用户重复提交、支付成功事件重复到达、MQ 重复投递、定时任务和消息同时关单。本篇的统一做法是唯一约束挡重复、状态条件更新挡并发、消息在事务提交之后发出，跨服务的一致性按流程选定一种方案。

---

## 一、需求与挑战

### 1、功能范围

| 功能 | 要求 |
|------|------|
| 下单 | 服务端计价，预占库存、锁定优惠券，生成待支付订单 |
| 支付 | 支付中心确认到账后，订单流转到待发货并通知发货、积分等下游 |
| 超时关单 | 15 分钟未支付自动关单，释放库存与优惠券 |
| 售后退款 | 申请、审核、退款，支持多次部分退款 |
| 查询 | 订单详情、用户订单列表、运营多条件查询 |

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 重复调用 | 用户重复提交、支付成功事件重复到达、MQ 重复投递，同一件事只能生效一次 |
| 并发改状态 | 支付成功与超时关单同时到达，只能有一个生效 |
| 跨服务一致性 | 订单、库存、优惠券、支付分属不同服务，没有一个本地事务能覆盖 |
| 消息与事务的先后 | 事务回滚了消息却发出去，或事务未提交消息就被消费 |
| 数据量 | 订单只增不减，大促峰值写入集中，单库单表撑不住 |

---

## 二、整体架构

| 组件 | 职责 |
|------|------|
| 订单服务 | 订单与售后单的生命周期，所有状态变更都用条件更新，事件与状态变更同事务写入 Outbox |
| 库存服务 | 以 `biz_no` 幂等预占、确认扣减、释放库存，定时扫描悬挂预占 |
| 优惠券服务 | 以 `biz_no` 幂等锁券、核销、解锁 |
| 支付中心 | 支付单、渠道回调、查单、渠道关单、退款单与可退额度，见 [支付](./14_payment) |
| MQ | 关单定时消息；`PAY_SUCCESS`、`ORDER_PAID`、`ORDER_CANCELLED`、`REFUND_SUCCESS` 等事件 |
| 扫描任务 | 定时扫描超时未关的订单、悬挂预占，兜底消息丢失 |
| 查询侧 | 主库、从库按场景路由，列表与多条件查询走 ES / OLAP |

下单时订单服务同步调用库存与优惠券服务预占，之后的支付、关单、退款都是事件驱动：上游状态变更与事件同事务落库，提交后投递，下游消费时各自用条件更新保证只生效一次。

---

## 三、订单状态机

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

## 四、下单：幂等与库存预占

### 1、流程

1. 校验参数（商品、地址、优惠券），**服务端计算价格**，不信任前端金额
2. 用客户端提交的幂等号 `biz_no` 查订单，已存在直接返回
3. 调库存服务**预占**库存、调优惠券服务锁定优惠券，两者都以 `biz_no` 作为幂等键
4. 生成订单号（雪花算法，见 [分布式 ID 生成](/distributed/8_id_generator)），插入订单，状态为待支付
5. 事务提交后发送 15 分钟关单定时消息
6. 调支付中心创建支付单（以订单号幂等），返回支付参数；支付单与交易单模型见 [支付](./14_payment#三、支付单、交易单与状态机)

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
    eventPublisher.publishEvent(new OrderCreatedEvent(order.getId()));   // 提交后才发关单消息，见第六节
    return order;
}
```

- 远程调用放在事务里会拉长事务、占用连接，量大时把预占移到事务外，只把插入订单放进事务
- 预占成功、建单失败（宕机、非唯一键异常）会留下**悬挂预占**：库存服务定时扫描超过 N 分钟的 `RESERVED` 记录，按 `biz_no` 向订单服务确认，没有订单就释放
- 幂等方案的通用对比见 [幂等方案总结](/architecture/3_idempotence)

---

## 五、支付回调

渠道回调的验签、金额与商户号校验、渠道流水号去重、主动查单都由支付中心负责，订单服务不直接对接支付宝、微信支付。支付中心处理成功后通过 Outbox 投递 `PAY_SUCCESS` 事件，订单服务只做订单侧的事：

- 回调验签与幂等：见 [支付](./14_payment#四、渠道下单与异步回调)
- 查单补偿与渠道关单：见 [支付](./14_payment#五、主动查单与超时关单)

### 1、消费支付成功事件

```java
@Transactional
public void onPaySuccess(PaySuccessEvent e) {             // 事件至少投递一次，必须幂等
    long orderId = Long.parseLong(e.bizOrderNo());
    // UPDATE orders SET status='PENDING_SHIPMENT', pay_no=?, paid_at=? WHERE id=? AND status='PENDING_PAYMENT'
    if (orderMapper.markPaid(orderId, e.payNo(), e.paidAt()) == 0) {
        Order o = orderMapper.selectById(orderId);
        if (o.getStatus() == OrderStatus.CANCELLED) {
            // 关单后才到账：向支付中心申请全额退款，request_no 固定，重复事件不会退两次
            payClient.applyRefund(e.payNo(), "AUTO-" + orderId, e.amountCent());
        }
        return;                                             // 已是待发货及之后：重复事件直接结束
    }
    outboxMapper.insert(OutboxEvent.of("ORDER_PAID", orderId));   // 与状态变更同一事务
}
```

- **幂等靠订单的状态条件更新**：`待支付 → 待发货` 只会成功一次，重复事件、事件与关单并发都影响 0 行，不需要分布式锁
- **下游通知走 Outbox**：发货、积分、确认扣减库存都订阅 `ORDER_PAID`，事件与状态变更在同一事务落库，提交后由投递任务发出
- **兜底**：事件长时间没到时，订单服务按支付单号向支付中心查询；日终核对「支付成功」与「订单已支付」两个集合，见 [支付](./14_payment#_2、支付中心与业务方的一致性)

---

## 六、超时关单

### 1、方案对比

| 方案 | 原理 | 评价 |
|------|------|------|
| 定时扫描 | 每分钟扫 `status = 待支付 AND created_at < now - 15m` | 简单可靠，有分钟级延迟，量大时需分片扫描；适合作为兜底；多实例部署用 XXL-JOB 或 ShedLock 保证单实例执行，见 [分布式调度](/distributed/6_job_scheduler) |
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
        // 1. 先让支付中心关闭渠道交易；关不掉说明用户已付款，等 PAY_SUCCESS 事件推进订单
        if (payClient.close(order.getPayNo()) == CloseResult.ALREADY_PAID) {
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

- 关单先让支付中心关闭渠道交易（先查单、再关渠道，见 [支付](./14_payment#_2、超时关单)），否则可能本地刚关单，用户就付款成功
- 「先查状态、再关单、再回补」三步分开执行时，并发的支付回调或重复消息会导致已支付订单被关闭、库存重复回补；条件更新 + 同事务事件可以消除这些问题
- 订单和库存在同一个库时，直接在关单事务里执行上面两条 SQL，不需要事件

---

## 七、退款

退款单、可退额度、调渠道退款都归支付中心，订单服务只管售后申请、审核和订单侧的状态。退款单模型、可退额度与部分退款见 [支付](./14_payment#六、退款)。

### 1、流程

1. 用户提交售后申请，携带客户端生成的请求号 `request_no`，订单服务落一张售后单（`UNIQUE KEY (order_id, request_no)`），状态为已申请
2. 商家审核：驳回则售后单结束；通过则以 `request_no` 调支付中心申请退款，支付中心占用可退额度并生成退款单号，超额时直接拒绝
3. 支付中心退款成功后投递 `REFUND_SUCCESS` 事件，订单服务条件更新售后单为已退款
4. 累计退款等于实付时订单流转到已关闭；未发货的退款释放库存，积分、优惠券按规则回退，同样通过 Outbox 事件通知

### 2、订单侧只记状态

- 售后单只记录申请、审核与退款结果，**不在订单表上自己维护可退额度**：两处各记一份必然对不上，以支付中心交易单上的已退金额为准
- 重试调用支付中心时始终带同一个 `request_no`，支付中心按 `(trade_no, request_no)` 幂等，返回同一张退款单
- 关单后到账的自动退款（第五节）也走同一个接口，`request_no` 用固定前缀加订单号

---

## 八、分布式事务：按流程选一种

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

## 九、大促扩展

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

超过一定时间的已完结订单迁出主表，主表只保留近期数据，见 [数据冷热分离](/architecture/4_cold_hot_data)。

---

## 十、容量估算

以**日下单 1,000 万笔、其中约一半完成支付**为例（与 [支付](./14_payment#十、容量估算) 的日成功支付 500 万笔对应），1 KB = 1024 B：

**TPS**：日均 10,000,000 ÷ 86,400 ≈ 116 笔/秒；大促峰值按日均的 50 倍，116 × 50 = 5,800，取 6,000 笔/秒下单。

**数据库写入**：每笔订单在订单库至少有 3 个事务：建单（订单 1 行 + 明细平均 2 行）、支付成功（状态 1 行 + Outbox 1 行）、发货或关单（状态 1 行 + Outbox 1 行）。峰值下单 6,000 × 3 = 18,000 事务/秒，分到 16 个库，每库约 1,125 事务/秒，留有余量；库存服务的预占同样是每笔一个事务，热点 SKU 按 [秒杀](./4_seckill) 的方式处理。

**关单**：每笔订单一条 15 分钟定时消息，峰值 6,000 条/秒；约一半订单未支付，每天需要真正关单约 500 万笔，日均 5,000,000 ÷ 86,400 ≈ 58 笔/秒。

**存储**（每笔：订单主表 0.5 KB + 明细 2 × 0.3 KB = 1.1 KB，索引按 1.5 倍放大约 1.7 KB）：每天 10,000,000 × 1.7 KB = 17,000,000 KB ≈ 16 GB，每年约 16 GB × 365 ≈ 5.7 TB。

**分表规模**：每年 10,000,000 × 365 = 36.5 亿行，分到 256 张表约每张 1,400 万行；主表只保留近 6 个月（约 18 亿行，每张约 700 万行），超过的已完结订单归档，单表控制在千万行左右。

单库 TPS 以压测为准，估算方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 订单主状态只靠 `WHERE status = 旧状态` 的条件更新流转，并发控制不需要 version；退款进度放在独立的退款单上
- 下单以 `biz_no` 唯一约束兜底，库存与优惠券预占也必须以 `biz_no` 幂等，悬挂预占靠扫描释放
- 支付回调验签、查单、渠道关单与退款都归支付中心（见 [支付](./14_payment)）；订单侧消费 `PAY_SUCCESS` 时以 `待支付 → 待发货` 条件更新幂等，关单后到账则申请自动退款
- 关单先让支付中心关闭渠道交易，再在一个事务里条件更新订单并写释放库存事件；库存侧以预占记录状态保证只释放一次
- 定时消息在事务提交后发送（`@TransactionalEventListener(AFTER_COMMIT)`），失败由扫描任务兜底；RocketMQ 4.x 没有 15 分钟级别
- 一个流程只选一种分布式事务方案：同步预占、Outbox 或事务消息、Seata 各管各的
- 订单侧只管售后申请、审核和订单状态；退款单号与可退额度由支付中心管理，重试始终带同一个 `request_no`

## 参考资料

- RocketMQ 定时 / 延时消息：[https://rocketmq.apache.org/docs/featureBehavior/02delaymessage](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage)
- RocketMQ 事务消息：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage)
- Spring Framework Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Apache Seata：[https://seata.apache.org/docs/overview/what-is-seata](https://seata.apache.org/docs/overview/what-is-seata)

> 下一篇：[短链接](./6_shorturl) —— 短码生成、存储与缓存、跳转与统计、高可用。

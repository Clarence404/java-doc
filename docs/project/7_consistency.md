---
description: 方案对比与不用 Seata 的理由、库存预占三个接口、本地消息表与消费幂等、空回滚与悬挂、每日对账
---

# 跨服务一致性

> 前置阅读：[数据建模](./2_data_model)、[分布式事务](/distributed/4_transaction)、[库存与票务](/scenario/22_inventory)

库存与支付拆成独立服务后，阶段一「扣库存 + 写订单」的本地事务不再成立。本篇讲方案取舍、库存预占与支付消息、失败补偿与对账，基线为 Spring Boot 4、RocketMQ 5、MySQL 8.4。

---

## 一、背景

阶段三日订单到了 100 万，上一篇 [拆分服务](./6_split) 把库存和支付拆了出去：订单留在 `mall-app`（库 `qingyou_mall`），库存在 `inventory-service`（库 `qingyou_inventory`），支付在 `payment-service`（库 `qingyou_payment`）。[数据建模](./2_data_model#七、事务边界) 里那个 `@Transactional` 原本同时包住扣库存和写订单，现在 `InventoryApi.deduct` 变成了一次远程调用，事务只管得住订单库。上一篇用了过渡写法：先远程 `deduct`，写单失败再 `restore`；支付回调里 `payment-service` 同步调用 `OrderPayApi.markPaid`，失败就让渠道重试回调。

一笔订单的生命周期里，有四个地方会出现「一边成功、一边失败」：

| 环节 | 失败方式 | 后果 |
|------|---------|------|
| 下单：扣库存 → 写订单 | 库存扣了，写订单时数据库抖动 | 库存凭空少了，商品提前显示售罄 |
| 下单：调库存超时 | 不知道对方扣没扣 | 重试可能扣两次，不重试可能漏还 |
| 支付成功 → 改订单状态 | 回调处理到一半实例重启 | 用户付了钱，订单还显示待支付 |
| 超时取消 → 归还库存 | 归还请求丢失 | 库存永久泄漏 |

按跨服务调用 0.1% 的超时或失败率估算，每天会有约 1000 单落进这些缝里。过渡期靠每日核对脚本加人工修，到 100 万单时修不过来，必须由系统自己收敛。

---

## 二、选项

几种主流方案的原理见 [分布式事务](/distributed/4_transaction)，这里只看它们放到青柚的代价：

| 方案 | 一致性 | 对业务的侵入 | 青柚的代价 |
|------|-------|------------|-----------|
| 2PC / XA | 强一致 | 低，靠数据库 XA 接口 | 两阶段期间一直持有行锁，热门 SKU 的库存行被锁到支付服务返回；协调者宕机时参与者阻塞 |
| Seata AT | 最终一致（全局锁隔离写） | 低，自动生成回滚 SQL | 要单独部署并运维 TC 集群和它的存储；全局锁让同一 SKU 的下单串行；依赖 SQL 解析与 `undo_log` |
| TCC | 最终一致 | 高，每个参与方写三个接口 | 要处理空回滚、幂等、悬挂；但库存「预占」天然就是 Try |
| Saga | 最终一致，无隔离 | 中，每步写补偿 | 补偿前中间状态对外可见，库存先扣后还会造成「明明有货却下不了单」 |
| [本地消息表](/distributed/4_transaction#五、本地消息表-transactional-outbox) | 最终一致 | 中，业务表旁加一张 `t_outbox` | 有投递延迟；消费方必须幂等。[异步化](./5_async) 一篇已经在用，连同 `t_consume_record` 去重表 |
| RocketMQ 事务消息 | 最终一致 | 中，要实现回查接口 | 和本地消息表解决同一个问题，多一套机制要维护 |

CAP 与 BASE 的取舍见 [分布式理论](/distributed/2_theorem#二、base-与一致性模型)：电商下单接受「几秒到几分钟内最终一致」，不接受「为了强一致让下单排队」。

---

## 三、决策

不用一种方案包打天下，而是**按环节选**：

| 环节 | 方案 | 理由 |
|------|------|------|
| 下单占库存 | TCC 风格的库存预占：`reserve / confirm / release` | 下单时必须同步知道「有没有货」，异步消息给不了这个答案 |
| 支付成功 → 订单 → 库存 | 本地消息表 + 消费幂等 | 支付成功后不能失败、只能往前推，适合消息驱动的最终一致 |
| 取消、超时 → 归还库存 | 本地消息表 + 消费幂等 | 同上，归还晚几秒没有影响 |
| 兜底 | 预占过期回查 + 每日对账 | 消息和调用都可能丢，最后要有一道不依赖它们的检查 |

预占不是完整的 TCC 框架：**没有独立的事务协调者，订单服务自己就是协调者，订单状态就是全局事务状态**。待支付对应 Try 已完成，待发货对应应当 Confirm，已取消对应应当 Cancel。库存怎么预占、什么时候释放，通用做法见 [库存与票务 · 预占与释放](/scenario/22_inventory#五、预占与释放)。

### 1、为什么不用 Seata

- **参与方少、流程固定**：跨服务的写只有订单、库存、支付三方，状态流转在 [数据建模](./2_data_model) 里已经定死，手写协调的代码量可控
- **多一套要高可用的基础设施**：TC 集群挂了，所有下单都失败；20 人的团队里没有人专职维护它
- **热点 SKU 会被全局锁串行化**：AT 模式在全局事务提交前持有全局锁，大促时同一个爆款的下单全部排队，见 [分布式事务 · Seata](/distributed/4_transaction#八、seata)
- **团队已经有 Outbox**：[异步化](./5_async) 一篇的 `t_outbox`、`OutboxRelayJob` 和 `t_consume_record` 直接复用，`payment-service`、`inventory-service` 各建一份；新增的只是库存的三个接口

### 2、明确不做

- 不用 XA，也不用 [RocketMQ · 事务消息](/messaging/3_rocketmq#七、事务消息)：消息可靠投递统一走本地消息表，只保留一套机制，不必为每个生产者再写回查接口
- `reserve` 调用不自动重试：结果未知时直接释放并让用户重试，重试风暴由「稳定性」一篇统一治理
- 不做实时对账：每日一次，差错先人工确认，自动修复只覆盖几类明确的情况
- 不建 Saga 编排引擎：只有三方参与，用订单状态机表达流程就够了

---

## 四、正常流程

![下单、支付到库存确认的时序](../assets/project/consistency-order-pay-sequence.svg)

1. **下单**：`mall-app` 先生成订单号，用它调用 `inventory-service.reserve`；预占成功后，在一个本地事务里写 `t_order`（状态 10）、`t_order_item` 和 `t_outbox`（15 分钟后投递的 `order-timeout` 定时消息，沿用 [异步化](./5_async) 的做法）；`InventoryApi` 上的 `deduct` / `restore` 换成 `reserve` / `release` / `confirm`，仍是同一个 `@HttpExchange` 接口
2. **支付**：渠道回调到 `payment-service`，验签后在一个本地事务里把 `t_payment` 改为成功并写入它自己库里的 `t_outbox`，由投递任务发出 `payment-succeeded` 消息；同步的 `OrderPayApi.markPaid` 就此下线
3. **订单确认**：`mall-app` 的消费组 `order-payment-consumer` 收到消息，在一个本地事务里把订单从 10 改为 20，并写入 `order-paid` 消息；积分、通知的消费者照旧订阅 `order-paid`，不感知拆分
4. **库存确认**：`inventory-service` 的消费组 `inventory-confirm-consumer` 订阅 `order-paid`，把预占记录从 RESERVED 改为 CONFIRMED

取消订单（用户取消，或 `order-timeout-consumer` 收到超时消息）走对称的路径：先请 `payment-service` 关闭支付单，关闭成功后在本地事务里把订单从 10 改为 50 并写入 `order-cancelled` 消息，`inventory-service` 的 `inventory-release-consumer` 收到后执行 `release`。关闭支付单失败说明用户已经付款，这时不取消，等 `payment-succeeded` 到达，做法见 [支付 · 主动查单与超时关单](/scenario/14_payment#五、主动查单与超时关单)。

---

## 五、库存预占

### 1、预占记录表

```sql
-- qingyou_inventory 库；t_inventory 增加一列 reserved：已预占、尚未确认的数量
ALTER TABLE t_inventory ADD COLUMN reserved INT NOT NULL DEFAULT 0 COMMENT '已预占未确认' AFTER stock;

CREATE TABLE t_inventory_reservation (
    id         BIGINT      NOT NULL COMMENT '雪花 ID',
    order_no   VARCHAR(32) NOT NULL,
    sku_id     BIGINT      NOT NULL,
    quantity   INT         NOT NULL,
    status     TINYINT     NOT NULL COMMENT '1 RESERVED 2 CONFIRMED 3 RELEASED',
    expire_at  DATETIME(3) NOT NULL COMMENT '下单后 30 分钟，超过仍未确认则回查订单',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_sku (order_no, sku_id),
    KEY idx_status_expire (status, expire_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '库存预占记录';
```

- **`uk_order_sku` 是三个接口幂等的基础**：同一订单的同一 SKU 只能有一行，重复的 `reserve` 插不进去，`confirm`、`release` 都是带旧状态的条件更新，执行两次与执行一次结果相同，通用做法见 [幂等设计 · 条件更新](/architecture/3_idempotence#四、条件更新-状态机与版本号)
- **`stock` 仍是可售数量**：预占时 `stock -n, reserved +n`，确认时 `reserved -n`，释放时 `stock +n, reserved -n`；商品页展示 `stock`，不受预占状态影响
- **`expire_at` 比订单超时多 15 分钟**：留出关单消息延迟和重试的时间，正常情况下预占在过期前就已确认或释放
- 平均每单 3 件商品，每天约 300 万行，保留 30 天后归档

### 2、三个接口

```java
// inventory-service：com.qingyou.inventory.reserve.ReservationService
@Transactional(rollbackFor = Exception.class)
public ReserveResult reserve(String orderNo, List<ReserveLine> lines) {
    List<Reservation> existing = reservationMapper.selectByOrderNo(orderNo);
    if (!existing.isEmpty()) {          // 重复请求，或 release 先到留下的空回滚占位
        return existing.getFirst().isReleased() ? ReserveResult.REJECTED : ReserveResult.OK;
    }
    for (ReserveLine l : lines.stream().sorted(comparing(ReserveLine::skuId)).toList()) {
        reservationMapper.insert(Reservation.reserved(orderNo, l));  // 并发时撞 uk_order_sku，整体回滚
        if (inventoryMapper.reserve(l.skuId(), l.quantity()) == 0) { // stock >= n 条件更新
            throw new BizException(InventoryErrorCode.STOCK_INSUFFICIENT);
        }
    }
    return ReserveResult.OK;
}

@Transactional(rollbackFor = Exception.class)
public void release(String orderNo, List<ReserveLine> lines) {
    for (ReserveLine l : lines.stream().sorted(comparing(ReserveLine::skuId)).toList()) {
        // INSERT IGNORE ... status = 3：返回 1 说明从没预占过，返回 0 说明记录已存在
        // 不用 ON DUPLICATE KEY UPDATE id = id：Connector/J 默认返回 found rows，已存在也返回 1
        if (reservationMapper.insertReleasedIfAbsent(orderNo, l) == 1) {
            continue;                   // 空回滚：不动库存，只留下占位，挡住迟到的 reserve
        }
        if (reservationMapper.transit(orderNo, l.skuId(), RESERVED, RELEASED) == 1) {
            inventoryMapper.unreserve(l.skuId(), l.quantity());      // stock +n, reserved -n
        }   // 0 行：已释放（重复请求）或已确认（不应释放，记日志告警）
    }
}
```

`confirm` 只有一条条件更新 `RESERVED → CONFIRMED`，再把对应数量从 `reserved` 中减掉，省略。

### 3、空回滚与悬挂

![预占记录的状态流转与补偿路径](../assets/project/consistency-reservation-compensation.svg)

`reserve` 超时后订单服务会马上调 `release`，可这时 `reserve` 可能还在网络里：

- **空回滚**：`release` 先到，库里没有预占记录。如果直接返回成功，什么都不留下，那么迟到的 `reserve` 会照常扣掉库存，而订单根本不存在。所以 `release` 要写一行 RELEASED 占位
- **悬挂**：迟到的 `reserve` 查到 RELEASED 占位，返回 REJECTED，不扣库存。占位和预占共用 `uk_order_sku`，两者并发时由唯一键决定先后

这两个问题的一般性分析见 [分布式事务 · 空回滚、幂等与悬挂](/distributed/4_transaction#_2、空回滚、幂等与悬挂)。

---

## 六、订单侧的调用与补偿

### 1、下单：结果未知按失败处理

```java
// mall-app：com.qingyou.order.place.PlaceOrderService（阶段三）
public PlaceOrderResult place(long userId, String idemKey, PlaceOrderRequest req) {
    Order existing = orderMapper.selectByUserAndBizNo(userId, idemKey);
    if (existing != null) {
        return PlaceOrderResult.replayed(existing);
    }
    List<PricedItem> items = pricingService.price(req);
    String orderNo = orderNoGenerator.next(userId);   // 先有订单号，作为预占的幂等键
    List<ReserveLine> lines = ReserveLine.of(items);

    try {
        inventoryApi.reserve(new ReserveStockRequest(orderNo, lines));   // 读超时 800ms，不重试
    } catch (RemoteBizException e) {
        throw e;                                      // STOCK_INSUFFICIENT：明确失败，什么都没扣
    } catch (RuntimeException e) {                    // 超时或 5xx：结果未知，按失败处理
        releaseQuietly(orderNo, lines);
        throw e;
    }
    try {
        return PlaceOrderResult.created(placeOrderTxService.create(userId, orderNo, idemKey, req, items));
    } catch (DuplicateKeyException e) {               // 并发的重复请求已经下单，本次预占作废
        releaseQuietly(orderNo, lines);
        return PlaceOrderResult.replayed(orderMapper.selectByUserAndBizNo(userId, idemKey));
    } catch (RuntimeException e) {                    // 写订单失败
        releaseQuietly(orderNo, lines);
        throw e;
    }
}
```

`releaseQuietly` 是本类的私有方法，调用 `inventoryApi.release`，吞掉异常、只记日志。结果未知时不重试 `reserve`，先释放再由全局异常处理器返回 `SYSTEM_ERROR`；客户端带同一个 `Idempotency-Key` 重试时，由于订单没写成功，会生成新的订单号重新预占。旧订单号的预占要么已被释放，要么被空回滚占位挡住。`releaseQuietly` 自己也可能失败，这时预占记录保持 RESERVED，交给下面的过期回查。

### 2、支付成功：去重表加条件更新

```java
// mall-app：com.qingyou.order.paid.OrderPaidTxService（原 pay 包已随支付迁出）
@Transactional(rollbackFor = Exception.class)
public void markPaid(PaymentSucceeded msg) {
    if (consumeRecordMapper.insertIgnore("order-payment-consumer", msg.orderNo()) == 0) {
        return;                                                   // t_consume_record 已有：重复消息
    }
    if (orderMapper.transit(msg.orderNo(), PENDING_PAYMENT, PENDING_SHIPMENT, msg.paidAt()) == 1) {
        outboxWriter.append("order-paid", msg.orderNo(), OrderPaidEvent.from(msg), null);
        return;
    }
    if (orderMapper.selectStatus(msg.orderNo()) == CANCELLED) {   // 关单后才到的支付：原路退款
        outboxWriter.append("order-refund-required", msg.orderNo(), msg, null);
    }
    // 其余情况（已是待发货及以后）：渠道重复回调产生的第二条消息，直接确认
}
```

去重记录与状态变更在同一个事务里，沿用 [异步化](./5_async) 的 `t_consume_record` 和 `OutboxWriter`；订单状态 `WHERE status = 10` 的条件更新再兜一层，即使去重记录被清理，重复消息也只影响 0 行，不会重复写 `order-paid`。库存侧的 `confirm` / `release` 同样是条件更新。消费幂等的几种做法见 [幂等设计 · 消费幂等](/architecture/3_idempotence#五、消费幂等-同事务去重记录)，RocketMQ 的重试与死信见 [RocketMQ](/messaging/3_rocketmq#八、消费模式、重试与死信)。

「关单后才到的支付」来自关闭支付单与用户付款的竞态：渠道关单请求发出时，用户恰好完成付款。这类订单每天个位数，`payment-service` 收到 `order-refund-required` 后原路退款，并通知用户。

### 3、预占过期回查

`inventory-service` 每 5 分钟运行一次 `ReservationExpireJob`，按 `idx_status_expire` 找出已过期仍为 RESERVED 的记录，通过 `OrderQueryApi` 回查订单状态：订单不存在或已取消就 `release`，已支付及以后就 `confirm`，仍待支付则等下一轮。这是库存服务唯一一处反向调用订单服务，只在兜底任务里出现。

---

## 七、每日对账

消息、回查都依赖代码按预期运行；对账是唯一**只看数据、不看过程**的检查。每天凌晨 2 点，对账任务从三个库的只读从库按 `order_no` 拉取前一天变动的数据，这是全系统唯一允许跨库读的地方：

| 检查项 | 不一致的表现 | 处理 |
|-------|-------------|------|
| 支付单 vs 订单 | 支付成功，订单仍待支付 | 补发 `payment-succeeded`，走正常消费 |
| 支付单 vs 订单 | 支付成功，订单已取消且未退款 | 补发 `order-refund-required` |
| 订单 vs 预占 | 订单已取消，预占仍 RESERVED 或 CONFIRMED | RESERVED 自动 `release`；CONFIRMED 转人工 |
| 订单 vs 预占 | 订单已支付，预占仍 RESERVED | 自动 `confirm` |
| 预占 vs 库存 | 某 SKU 的 `reserved` ≠ RESERVED 记录数量之和 | 只告警，人工核对流水后修正 |

自动修复全部复用前面那些幂等接口和消息，不写专用的修数据 SQL；修不了的写入差错表，第二天由值班同学处理。100 万订单、300 万预占记录按 `order_no` 排序后归并比对，几分钟就能跑完。比对方法、断点续跑与差错状态机见 [海量数据对账](/scenario/3_reconcile)，支付与渠道之间的对账见 [支付 · 对账](/scenario/14_payment#七、对账)。

---

## 八、用户看到什么

最终一致意味着存在不一致的窗口，产品上要给每个窗口一个说得通的展示：

| 窗口 | 通常时长 | 用户看到的 |
|------|---------|-----------|
| 支付成功 → 订单变为待发货 | 1 秒内，消息积压时到分钟级 | App 收到渠道的成功回执后显示「支付成功，订单确认中」，轮询订单详情 10 秒，仍未变化就提示稍后到订单列表查看 |
| 取消订单 → 库存归还 | 秒级 | 订单立即显示已取消；商品页库存晚几秒恢复 |
| `reserve` 超时 | 800ms | 「下单失败，请重试」；重试走同一个幂等键，不会重复下单 |
| 关单与付款竞态 | 退款到账 1–3 天 | 订单显示已取消，收到「支付已原路退回」的通知 |

---

## 九、代价与后续

| 本篇的决策 | 带来的问题 | 在哪里解决 |
|-----------|-----------|-----------|
| 下单同步调用 `reserve` | 库存服务变慢会拖慢下单，超时堆积可能拖垮订单服务 | 下一篇「稳定性」：超时、熔断与降级 |
| 预占在付款前就占住库存 | 恶意下单不付款，能在 15 分钟内锁住爆款库存 | 「稳定性」：按用户限流与下单频控 |
| 一致性窗口取决于消息投递 | 消费积压时窗口从秒级变成分钟级，用户投诉才发现 | 「可观测与发布」：Outbox 积压与消费延迟告警 |
| 同一 SKU 的预占仍是单行条件更新 | 大促 5000 QPS 下爆款单行成为热点 | 「稳定性」：热点库存拆分，思路见 [库存与票务](/scenario/22_inventory#七、热点-sku-拆分库存) |
| 对账每日一次 | 不一致最长要一天才被发现 | 「复盘」：讨论什么时候值得做准实时对账 |

完整的订单系统最终形态见 [订单](/scenario/5_order_system)。

---

## 小结

- 拆服务后，下单、支付、取消三处都会出现「一边成功一边失败」，按 0.1% 失败率每天约 1000 单，必须由系统自己收敛
- 按环节选方案：下单用 TCC 风格的库存预占，支付与取消用本地消息表 + 消费幂等，最后由预占过期回查和每日对账兜底
- 不引入 Seata：参与方只有三个，TC 集群是新的单点，全局锁会把爆款下单串行化；也不用 XA 和事务消息
- `t_inventory_reservation` 以 `(order_no, sku_id)` 唯一，`reserve` 查重、`confirm` / `release` 走条件更新；`release` 写占位处理空回滚，`reserve` 遇到占位拒绝以防悬挂
- 调用结果未知按失败处理，立即释放预占；订单状态的条件更新本身就是消息消费的幂等
- 每个不一致窗口都要有对用户说得通的展示，尤其是「支付成功、订单确认中」

## 参考资料

- Seata 官方文档 · AT 模式：[https://seata.apache.org/docs/dev/mode/at-mode](https://seata.apache.org/docs/dev/mode/at-mode)
- Chris Richardson · Pattern: Transactional outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
- Chris Richardson · Pattern: Saga：[https://microservices.io/patterns/data/saga.html](https://microservices.io/patterns/data/saga.html)
- Apache RocketMQ · 事务消息：[https://rocketmq.apache.org/zh/docs/featureBehavior/04transactionmessage](https://rocketmq.apache.org/zh/docs/featureBehavior/04transactionmessage)

> 下一篇：[稳定性](./8_stability) —— 大促前的超时重试、限流熔断降级、压测与容量评估

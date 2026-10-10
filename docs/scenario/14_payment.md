---
description: 支付单与交易单、状态机与条件更新、渠道下单与回调验签幂等、查单与关单、退款、日终对账、借贷记账、容量估算
---

# 支付系统

> 前置阅读：[订单](./5_order_system)、[幂等设计](/architecture/5_idempotence)、[分布式事务](/distributed/4_transaction)

支付中心负责一笔钱从发起、到账、退回到对平的完整生命周期，原则是**任何结论都要有渠道侧的证据**（回调、查单、账单）。本篇讲对接微信支付、支付宝时如何处理重复 / 丢失 / 乱序回调、可靠关单、安全重试退款，以及每日对账与差错处理。

---

## 一、需求与挑战

### 1、职责边界

| 属于支付中心 | 不属于支付中心 |
|--------------|----------------|
| 支付单、交易单、退款单的生命周期 | 订单状态、库存、优惠券 |
| 对接渠道：下单、回调、查单、关单、退款、下载账单 | 商品价格计算（金额由业务方传入并由服务端校验） |
| 资金流水与账户余额 | 给商户结算打款（属于清结算系统，本篇只讲记账） |
| 日终对账与差错处理 | 风控决策（只接入结果） |

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 结果不确定 | 下单请求超时、回调丢失、用户付完款关掉页面，本地都不知道钱到没到 |
| 重复 | 渠道在一天内多次重发通知，查单任务和回调同时到达，用户换渠道重复付款 |
| 并发 | 回调与超时关单同时发生，必须只有一个生效 |
| 资金零差错 | 多记一笔就是资损，少记一笔就是客诉，每天必须能对平 |
| 渠道差异 | 各渠道金额单位、状态枚举、签名方式都不同，业务方不应感知 |
| 安全 | 伪造回调、篡改金额、用低价订单的合法通知冒充高价订单 |

---

## 二、整体架构

![支付系统整体架构](../assets/scenario/payment-arch.svg)

| 组件 | 职责 |
|------|------|
| 支付核心 | 支付单、交易单、退款单、资金流水，所有状态变更与记账在同一个库的同一个事务里完成 |
| 渠道适配层 | 把各渠道的下单、查询、关单、退款、账单接口统一成一套接口，金额单位、状态枚举在这里转换 |
| 回调网关 | 接收渠道异步通知：验签、解密、校验金额与商户号，再交给支付核心；不做业务逻辑 |
| 补偿任务 | 查单（补回调）、超时关单、退款重试，多实例下用 ShedLock 或 XXL-JOB 保证单实例执行，见 [分布式调度](/distributed/6_job_scheduler) |
| Outbox 中继 | 支付成功、退款成功的事件与状态变更同事务落库，提交后投递到 MQ，业务方消费 |
| 对账服务 | 日终下载渠道账单逐笔比对，不一致的进入差错池 |

---

## 三、支付单、交易单与状态机

### 1、两层模型

| 模型 | 含义 | 关键字段 | 唯一约束 |
|------|------|----------|----------|
| 支付单 `pay_order` | 业务方的一次收款需求，一个订单对应一张 | `pay_no`、`biz_type`、`biz_order_no`、`amount_cent`、`status`、`success_trade_no` | `(biz_type, biz_order_no)` |
| 交易单 `pay_trade` | 向某个渠道发起的一次支付尝试，`trade_no` 就是传给渠道的商户订单号 | `trade_no`、`pay_no`、`channel`、`amount_cent`、`channel_trade_no`、`refund_applied_cent`、`refunded_cent` | `trade_no`；`(channel, channel_trade_no)` |
| 退款单 `refund_order` | 针对一笔成功交易单的一次退款 | `refund_no`、`trade_no`、`request_no`、`amount_cent`、`status` | `refund_no`；`(trade_no, request_no)` |

拆成两层的原因：用户可能先选微信、取消后又改用支付宝，一张支付单会产生多张交易单。渠道要求商户订单号对应的金额、商品信息不能变，所以每换一次渠道就新建一张交易单，而**支付单只认第一张成功的交易单**。

- 金额统一用 `long` 存「分」：微信支付本来就是分；支付宝是带两位小数的元，适配层用 `new BigDecimal(s).movePointRight(2).longValueExact()` 转换，避免浮点误差
- 支付单按 `(biz_type, biz_order_no)` 唯一，业务方重复调用创建接口直接返回已有的支付单；单号用雪花算法生成，见 [分布式 ID 生成](/distributed/8_id_generator)

### 2、交易单状态机

![交易单状态机](../assets/scenario/payment-state.svg)

失败（如银行卡扣款失败）只来自渠道的明确结果；成功后发生的退款另建退款单，交易单只累计已退金额并推进为部分退款或全额退款。

所有状态变更都用**带前置状态的条件更新**，影响行数为 0 就说明别人已经改过了：

```sql
-- 支付成功：允许从待支付直接成功（下单请求超时但用户已经付款）
UPDATE pay_trade SET status = 'SUCCESS', channel_trade_no = ?, paid_at = ?
WHERE trade_no = ? AND status IN ('WAITING', 'PAYING');

-- 关单：已经成功的交易单不会被关掉
UPDATE pay_trade SET status = 'CLOSED', closed_at = ?
WHERE trade_no = ? AND status IN ('WAITING', 'PAYING');
```

回调和关单并发时，两条语句竞争同一行的行锁，先提交的生效，后执行的影响 0 行。状态机与条件更新的通用写法见 [幂等设计](/architecture/5_idempotence)（条件更新一节）。

---

## 四、渠道下单与异步回调

### 1、下单

- 微信支付由服务端调用 App、JSAPI、H5、Native 下单接口拿到 `prepay_id` 或 `code_url`；支付宝 App、网页支付由服务端用 SDK 本地签名生成参数，扫码用当面付预下单
- 下单时把**过期时间**传给渠道（微信 `time_expire`，支付宝 `time_expire` / `timeout_express`），过期后渠道自己拒绝付款，本地关单只是收尾
- 金额只取支付单上的金额，**不接受客户端传来的金额**；支付单金额由订单服务按服务端计价写入
- 用户再次点击支付且渠道不变、未过期时，复用同一张交易单，不重复下单
- 支付宝本地签名的场景下，用户真正打开收银台之前支付宝侧还没有这笔交易，查单会返回「交易不存在」

### 2、回调验签

| 项目 | 微信支付 APIv3 | 支付宝 |
|------|----------------|--------|
| 签名 | 请求头 `Wechatpay-Signature` 等，用微信支付平台证书或公钥验签 | 参数里的 `sign`，RSA2，用支付宝公钥验签 |
| 内容 | `resource` 字段用 APIv3 密钥 AES-GCM 加密，验签后解密 | 明文表单参数 |
| 应答成功 | HTTP 200 / 204 | 响应体返回纯文本 `success` |
| 未应答 | 按递增间隔重发，持续约一天 | 按递增间隔重发，持续约一天 |

验签只证明「这是渠道发的」，还要校验**内容属于这笔交易**：`trade_no` 存在、金额相等、`appid` 与商户号是自己的。只验签不校验金额，攻击者可以用一笔 1 分钱的合法通知去冒充一笔大额交易。

```java
@RestController
public class WechatPayNotifyController {

    // 构造器注入省略。parser 来自 wechatpay-java，基于自动更新的平台证书验签并解密
    private final NotificationParser parser;
    private final PayNotifyService notifyService;

    @PostMapping("/pay/notify/wechat")
    public ResponseEntity<Map<String, String>> notify(
            @RequestHeader("Wechatpay-Serial") String serial,
            @RequestHeader("Wechatpay-Nonce") String nonce,
            @RequestHeader("Wechatpay-Signature") String signature,
            @RequestHeader("Wechatpay-Timestamp") String timestamp,
            @RequestBody String body) {                         // 原始报文验签，不能先反序列化再序列化
        Transaction tx;
        try {
            tx = parser.parse(new RequestParam.Builder()
                    .serialNumber(serial).nonce(nonce).signature(signature)
                    .timestamp(timestamp).body(body).build(), Transaction.class);
        } catch (ValidationException e) {
            return ResponseEntity.status(401).body(Map.of("code", "FAIL", "message", "invalid signature"));
        }
        if (tx.getTradeState() == Transaction.TradeStateEnum.SUCCESS) {
            notifyService.handlePaid(new PaidResult(Channel.WECHAT, tx.getOutTradeNo(), tx.getTransactionId(),
                    tx.getAmount().getTotal(), tx.getMchid(), tx.getAppid(),
                    OffsetDateTime.parse(tx.getSuccessTime()).toInstant()));   // 抛异常时返回 5XX，渠道会重发
        }
        return ResponseEntity.noContent().build();
    }
}
```

支付宝回调用 SDK 的 `AlipaySignature.rsaCheckV1` 验签，校验 `out_trade_no`、`total_amount`、`app_id` 后进入同一个 `handlePaid`，只认 `TRADE_SUCCESS` 与 `TRADE_FINISHED` 两种状态。

### 3、回调幂等：渠道流水号唯一约束 + 条件更新

```java
public record PaidResult(Channel channel, String tradeNo, String channelTradeNo,
                         long amountCent, String mchId, String appId, Instant paidAt) {}

@Service
public class PayNotifyService {

    private final PayTxService txService;                 // 构造器注入省略；独立 Bean，保证 @Transactional 生效

    public void handlePaid(PaidResult r) {          // 回调与查单共用的唯一入口
        try {
            txService.onPaid(r);
        } catch (DuplicateKeyException e) {
            // 同一渠道流水号已处理过：重复通知或查单并发，事务已整体回滚，直接视为成功
        }
    }
}

@Service
public class PayTxService {

    // 省略构造器注入：tradeMapper、payOrderMapper、channelTxnMapper、merchants、ledger、outbox、errorPool

    @Transactional
    public void onPaid(PaidResult r) {
        PayTrade t = tradeMapper.selectByTradeNo(r.tradeNo());
        if (t == null || t.amountCent() != r.amountCent() || !merchants.owns(r.channel(), r.mchId(), r.appId())) {
            throw new NotifyMismatchException(r);                // 告警并应答失败，交给人工核查
        }
        // 1. 去重记录：UNIQUE KEY uk_channel_txn (channel, channel_txn_no, txn_type)
        channelTxnMapper.insert(r.channel(), r.channelTradeNo(), "PAY", r.tradeNo(), r.amountCent());
        // 2. 条件更新：只有待支付 / 支付中能变成成功
        if (tradeMapper.markSuccess(r.tradeNo(), r.channelTradeNo(), r.paidAt()) == 0) {
            errorPool.add(ErrorType.PAID_AFTER_CLOSE, r);       // 已关闭却到账：进差错池原路退款
            return;
        }
        // 3. 钱已到账，先记账
        ledger.post("PAY-" + r.tradeNo(), List.of(
                Entry.ofDebit(Accounts.channelReceivable(r.channel()), r.amountCent()),
                Entry.ofCredit(Accounts.MERCHANT_PENDING, r.amountCent())));
        // 4. 支付单只认第一张成功的交易单：WHERE pay_no = ? AND status = 'WAITING'
        if (payOrderMapper.markSuccess(t.payNo(), r.tradeNo()) == 0) {
            errorPool.add(ErrorType.DUPLICATE_PAY, r);          // 换渠道重复付款：这一笔原路退款
            return;
        }
        outbox.insert(OutboxEvent.paySuccess(t.payNo(), t.bizType(), t.bizOrderNo(), r.amountCent()));
    }
}
```

- **去重记录与业务写入在同一个事务**：重复通知在第一步撞唯一键，异常抛出事务边界，整个事务回滚后由外层吞掉。不能「先 `SETNX` 再处理」，处理失败时 key 已经占住，渠道重发会被误判为已处理
- **条件更新是第二道防线**：即使去重表被误清理，`status IN ('WAITING','PAYING')` 也保证只成功一次
- **事件走 Outbox**：支付成功事件与状态变更同事务写入，提交后由中继投递，不在事务里直接发 MQ。投递与消费的可靠性见 [消息队列基础](/messaging/1_basics)，用 RocketMQ 事务消息替代 Outbox 的写法见 [RocketMQ](/messaging/3_rocketmq)
- 回调接口只做校验和落库，耗时的后续动作全部由事件驱动，保证几百毫秒内应答。订单侧如何消费 `PAY_SUCCESS`、订单已关闭时如何自动退款，见 [订单](./5_order_system#三、支付回调)

---

## 五、主动查单与超时关单

### 1、查单补偿

回调会延迟、会丢、商户服务宕机期间的重发也可能耗尽。查单任务扫描「支付中」且创建超过 2 分钟的交易单，查到成功就走与回调**同一个** `handlePaid`：

```java
@Scheduled(fixedDelay = 60_000)                     // 多实例部署需加 ShedLock 等保证单实例执行
public void queryPaying() {
    Instant before = Instant.now().minus(Duration.ofMinutes(2));
    for (PayTrade t : tradeMapper.selectPaying(before, 500)) {
        ChannelQueryResult q = gateway.of(t.channel()).query(t.tradeNo());
        switch (q.state()) {
            case PAID -> notifyService.handlePaid(q.toPaidResult(t));
            case FAILED -> tradeMapper.markFailed(t.tradeNo());   // WHERE status = 'PAYING'
            case NOT_PAID, NOT_EXIST, CLOSED -> { }               // 继续等，到期由关单任务处理
        }
    }
}
```

- 查询间隔按交易单年龄递增（如 2、5、10、30 分钟），遵守渠道的接口频率限制
- 用户付完款回到商户页面时可以触发一次即时查单；前端跳转本身**不能**作为支付成功的依据

### 2、超时关单

关单的顺序是**先查、再关渠道、最后改本地**：

```java
public void closeExpired(PayTrade t) {
    ChannelGateway gw = gateway.of(t.channel());
    ChannelQueryResult q = gw.query(t.tradeNo());
    if (q.state() == ChannelTradeState.PAID) {
        notifyService.handlePaid(q.toPaidResult(t));       // 关单前发现已付款：按成功处理
        return;
    }
    if (q.state() != ChannelTradeState.NOT_EXIST) {        // 渠道侧没有这笔交易（用户没打开收银台）时无需关单
        if (gw.close(t.tradeNo()) == CloseResult.ALREADY_PAID) {
            notifyService.handlePaid(gw.query(t.tradeNo()).toPaidResult(t));   // 查单与关单之间用户付了款
            return;
        }
    }
    tradeMapper.markClosed(t.tradeNo());                   // WHERE status IN ('WAITING','PAYING')
}
```

- 只改本地不关渠道，用户手里的支付页面仍然可以付款，就会出现「本地已关闭、渠道已扣款」。关闭渠道交易后，渠道保证不再收款
- 渠道关单接口是幂等的，本地更新失败时下一轮重试即可；本地关单时间比渠道过期时间晚 1 分钟左右，避开时钟偏差
- 交易单都关闭后，支付单 `WAITING → CLOSED`，并通知业务方。订单侧的超时关单与库存回补见 [订单](./5_order_system#四、超时关单)

---

## 六、退款

### 1、流程

订单侧的退款审核与积分回退见 [订单](./5_order_system#六、退款)，支付中心只负责把钱退回去：

1. 业务方调用退款接口，带上自己的退款请求号 `request_no`（同一次退款重试时不变）
2. 支付中心在一个事务里占用可退额度，**生成退款单号并落库**
3. 退款任务把退款单改为退款中，用这个固定的退款单号调用渠道（微信 `out_refund_no`，支付宝 `out_request_no`）
4. 渠道通知或查询得到结果：成功则累计已退金额、记账、写 Outbox 事件；失败则释放占用的额度

### 2、可退额度与部分退款

```java
@Transactional
public RefundOrder apply(String tradeNo, String requestNo, long amountCent) {
    RefundOrder existing = refundMapper.selectByRequest(tradeNo, requestNo);
    if (existing != null) {
        return existing;                                   // 重复请求：返回同一张退款单
    }
    // UPDATE pay_trade SET refund_applied_cent = refund_applied_cent + #{amt}
    // WHERE trade_no = #{tradeNo} AND status IN ('SUCCESS', 'PART_REFUND')
    //   AND refund_applied_cent + #{amt} <= amount_cent
    if (tradeMapper.occupyRefund(tradeNo, amountCent) == 0) {
        throw new BizException("交易不可退或超过可退金额");
    }
    RefundOrder r = RefundOrder.applied("R" + idGenerator.nextId(), tradeNo, requestNo, amountCent);
    refundMapper.insert(r);                                // 并发重复申请撞 (trade_no, request_no) 唯一键，整体回滚
    return r;
}
```

退款成功时，在同一个事务里先把退款单 `REFUNDING → SUCCESS`（影响 0 行说明已处理），再累计已退金额并推进交易单状态：

```sql
-- MySQL 单表 UPDATE 按从左到右的顺序赋值，status 必须写在 refunded_cent 之前
UPDATE pay_trade
SET status = IF(refunded_cent + ? = amount_cent, 'FULL_REFUND', 'PART_REFUND'),
    refunded_cent = refunded_cent + ?
WHERE trade_no = ?;
```

- **退款单号在申请时一次生成**，重试始终复用；渠道按退款单号幂等，同一个单号重复调用不会退两次。用「交易号 + 第几次退款」临时拼单号，重试时会拼出新单号，造成重复退款
- 申请时占用的 `refund_applied_cent` 防止两个并发的部分退款超出实付；成功时累计的 `refunded_cent` 才是真实已退金额
- 渠道对退款有期限（如微信支付超过一年的交易不能退款），超期只能走线下打款并单独记账

---

## 七、对账

![日终对账流程](../assets/scenario/payment-reconcile.svg)

### 1、日终流程

1. **下载账单**：每天在渠道账单生成之后（一般为次日上午）拉取前一天的交易账单与退款账单，失败按间隔重试，超过截止时间告警
2. **解析入库**：账单写入 `recon_channel_bill`，按账单日分区；本地数据取支付库只读副本中当天的交易单与退款单
3. **逐笔比对**：以渠道流水号或商户订单号关联两边，分出对平、长款、短款、金额或状态不符四类
4. **差错处理**：不一致的写入差错池，先自动处理，处理不了的转人工

```sql
-- 长款：渠道有成功记录，本地没有或不是成功（用商户订单号关联，本地可能还没有渠道流水号）
SELECT b.trade_no, b.channel_trade_no, b.amount_cent
FROM recon_channel_bill b
LEFT JOIN pay_trade t ON t.trade_no = b.trade_no
WHERE b.bill_date = '2026-10-08' AND b.txn_type = 'PAY'
  AND (t.trade_no IS NULL OR t.status NOT IN ('SUCCESS', 'PART_REFUND', 'FULL_REFUND'));

-- 短款：本地成功，渠道账单里没有
SELECT t.trade_no, t.channel_trade_no, t.amount_cent
FROM pay_trade t
LEFT JOIN recon_channel_bill b
       ON b.channel = t.channel AND b.channel_trade_no = t.channel_trade_no AND b.txn_type = 'PAY'
WHERE t.paid_at >= '2026-10-08 00:00:00' AND t.paid_at < '2026-10-09 00:00:00'
  AND b.channel_trade_no IS NULL;
```

`paid_at` 与账单日必须按同一时区切分（渠道账单一般按北京时间），否则零点附近的交易会被误判。

### 2、长款、短款与差错处理

| 差错类型 | 常见原因 | 处理 |
|----------|----------|------|
| 长款：渠道有、本地无或未成功 | 回调丢失且查单还没跑到；关单后到账；用户换渠道重复付款 | 查单确认后补单走 `handlePaid`；对应支付单已成功或已关闭的，原路退款 |
| 短款：本地成功、渠道无 | 零点前后的交易被划到渠道的下一天；伪造通知被误处理 | 跨日的挂起到次日账单复核；次日仍不存在的按资损事件处理，查回调日志与验签记录 |
| 金额不符 | 适配层金额换算错误；通知校验缺失 | 以渠道金额为准，人工核实后调账 |
| 状态不符 | 本地已退款、渠道未退；或反过来 | 以渠道为准查询退款单，补推状态 |

- **差错处理不改历史数据**：修正通过新增的调账流水完成（红字冲正原分录、再记一笔正确分录），保留完整痕迹
- 对账结果每天产出对平率与差错笔数；长款、短款超过阈值时告警并暂停该渠道的自动结算

---

## 八、资金流水与一致性

### 1、借贷记账

资金不用「余额字段加减」来记，而是**每次资金变动生成一组分录**：有借必有贷，借贷金额相等。以一笔 100 元的微信支付为例：

| 业务 | 借 | 贷 |
|------|----|----|
| 支付成功 100 元 | 渠道应收款-微信 100 | 商户待结算 100 |
| 部分退款 30 元 | 商户待结算 30 | 渠道应收款-微信 30 |
| 渠道结算到银行，手续费 0.6% | 银行存款 69.58、手续费 0.42 | 渠道应收款-微信 70 |

手续费 = 70 × 0.6% = 0.42 元，到账 = 70 − 0.42 = 69.58 元，借方合计 70 = 贷方合计 70。

```java
public record Entry(String accountNo, boolean debit, long amountCent) {
    public static Entry ofDebit(String account, long cent)  { return new Entry(account, true, cent); }
    public static Entry ofCredit(String account, long cent) { return new Entry(account, false, cent); }
}

@Component
public class Ledger {

    private final LedgerMapper mapper;                    // 构造器注入省略

    @Transactional(propagation = Propagation.MANDATORY)   // 必须在调用方的业务事务里执行
    public void post(String voucherNo, List<Entry> entries) {
        long debit = entries.stream().filter(Entry::debit).mapToLong(Entry::amountCent).sum();
        long credit = entries.stream().filter(e -> !e.debit()).mapToLong(Entry::amountCent).sum();
        if (debit <= 0 || debit != credit) {
            throw new IllegalStateException("借贷不平: " + voucherNo);
        }
        for (int i = 0; i < entries.size(); i++) {
            Entry e = entries.get(i);
            mapper.insertJournal(voucherNo, i + 1, e);        // UNIQUE KEY uk_voucher_line (voucher_no, line_no)
            mapper.addBalance(e.accountNo(), e.debit() ? e.amountCent() : -e.amountCent());   // 余额按借方为正
        }
    }
}
```

- 凭证号由业务单号派生（如 `PAY-{trade_no}`、`REFUND-{refund_no}`），重复记账会撞唯一键
- 流水只增不改，余额等于流水的累计；每天用流水汇总核对一次余额，不一致说明有绕过记账的写入
- 平台自营时「商户待结算」只有一个账户，每笔支付都更新同一行，会成为热点行。常见做法是拆成多个子账户随机记入、或流水先落库余额按批次汇总更新，见 [热点问题](/high-con/6_hotspot)

### 2、支付中心与业务方的一致性

- **业务方 → 支付中心**：创建支付单、申请退款都带业务单号或请求号，按唯一约束幂等
- **支付中心内部**：状态变更、去重记录、资金流水、Outbox 事件在同一个本地事务
- **支付中心 → 业务方**：Outbox 事件至少投递一次，业务方用条件更新幂等消费；兜底是业务方按支付单号主动查询，以及日终核对「支付成功」与「订单已支付」两个集合

支付链路不用 2PC 或 Seata：渠道不参与本地事务，跨服务只能靠「本地事务 + 可靠事件 + 对账」达到最终一致。方案对比见 [分布式事务](/distributed/4_transaction)。

---

## 九、安全

- **签名**：调用渠道的请求用商户私钥签名，渠道的应答与通知用渠道公钥或平台证书验签；业务方调用支付中心的内部接口也要签名并防重放，见 [API 安全](/security/6_api_security)
- **金额以服务端为准**：客户端只传业务单号，金额由订单服务计价后写入支付单；回调金额必须与交易单相等
- **只认渠道证据**：前端跳转、客户端 SDK 返回的「支付成功」只用于展示，支付结果只认验签通过的通知、查单结果和账单
- **密钥管理**：商户私钥、APIv3 密钥放 KMS 或 Vault，不进代码仓库与配置文件，按期轮换，见 [数据安全](/security/7_data_security)
- **回调接口**：不需要登录态，但要验签、限制请求体大小、按来源限流（见 [限流与过载保护](/high-avail/7_rate_limiting)），记录原始报文以便追查；日志中的卡号、手机号脱敏

---

## 十、容量估算

以**日成功支付 500 万笔**为例，1 KB = 1024 B：

**TPS**：日均 5,000,000 ÷ 86,400 ≈ 58 笔/秒；大促峰值按日均的 50 倍，58 × 50 = 2,900，取 3,000 笔/秒。

**数据库写入**：每笔成功支付写 10 行，即支付单 2（插入、成功）+ 交易单 3（插入、支付中、成功）+ 去重记录 1 + 资金流水 2（一借一贷）+ Outbox 2（插入、投递后标记）。

峰值 3,000 × 10 = 30,000 行写/秒，分布在 3 个事务里（创建、下单返回、回调），即 3,000 × 3 = 9,000 事务/秒。按单库 3,000 事务/秒的经验值需要 9,000 ÷ 3,000 = 3 个库，按 2 倍冗余取 6，向上取 2 的幂为 8 个库，按 `pay_no` 哈希分库，交易单、退款单与支付单同库。另有每笔 2 次账户余额更新，热点账户按上一节拆分子账户。单库 TPS 以压测为准，估算方法见 [容量评估与规划](/high-con/8_capacity_planning)。

**存储**（每笔：支付单 0.5 KB、交易单 0.5 KB、去重记录 0.2 KB、资金流水 2 × 0.3 KB、回调原始报文 1 KB，合计 2.8 KB，索引按 1.5 倍放大约 4.2 KB）：每天 5,000,000 × 4.2 KB = 21,000,000 KB ≈ 20 GB，每年 20 GB × 365 = 7,300 GB ≈ 7.1 TB。交易单、流水按月归档到冷库，回调原始报文只保留 6 个月。

**对账**：渠道账单每行约 300 B，5,000,000 × 300 B = 1,500,000,000 B ≈ 1.4 GB；按每秒 2 万行批量写入，5,000,000 ÷ 20,000 = 250 秒，约 4 分钟入库。比对按 `channel_trade_no` 哈希分 64 片并行，每片约 5,000,000 ÷ 64 ≈ 7.8 万行。

---

## 小结

- 两层模型：支付单对应业务的一次收款，交易单对应一次渠道尝试；支付单只认第一张成功的交易单，换渠道重复付款的那笔原路退款
- 状态只用带前置状态的条件更新推进，回调与关单并发时只有一个生效
- 回调先验签，再校验交易单号、金额、商户号；幂等靠同事务的渠道流水号去重记录加条件更新，事件走 Outbox
- 查单补回调，关单先查、再关渠道、最后改本地；回调、查单、关单发现到账都走同一个入口
- 退款单号申请时一次生成并复用，可退额度用条件更新占用，部分退款按累计金额推进状态
- 日终按渠道账单逐笔对账，长款补单或退款，短款挂起复核，差错用调账流水修正，不改历史
- 资金变动一律借贷记账，流水只增不改，余额由流水累计并每日核对
- 订单一侧如何因支付成功而流转见 [订单](./5_order_system)；回调验签等接口防护见 [API 安全](/security/6_api_security)。

## 参考资料

- 微信支付 APIv3 支付通知：[https://pay.weixin.qq.com/doc/v3/merchant/4012791861](https://pay.weixin.qq.com/doc/v3/merchant/4012791861)
- 微信支付 Java SDK（wechatpay-java）：[https://github.com/wechatpay-apiv3/wechatpay-java](https://github.com/wechatpay-apiv3/wechatpay-java)
- 支付宝开放平台文档中心：[https://opendocs.alipay.com/](https://opendocs.alipay.com/)
- Transactional Outbox 模式：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
- Martin Fowler, Accounting Entry：[https://martinfowler.com/eaaDev/AccountingEntry.html](https://martinfowler.com/eaaDev/AccountingEntry.html)

> 下一篇：[优惠券和营销](./15_coupon) —— 券模板与实例、Lua 原子领券、锁券核销回退、叠加分摊与过期处理。

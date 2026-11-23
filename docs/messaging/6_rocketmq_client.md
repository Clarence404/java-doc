---
description: Spring Boot 收发、幂等消费、延迟与顺序消息、事务消息与回查、重试与死信、消息积压
---

# RocketMQ 生产与消费

> 前置阅读：[RocketMQ 架构与存储](./5_rocketmq)、[消息队列基础](./1_basics)

RocketMQ 的业务消息能力最终落在客户端：怎么发、怎么消费、失败怎么重试。本篇讲 Spring Boot 收发、延迟与顺序消息、事务消息、重试与死信，基线为 RocketMQ 5。

---

## 一、Spring Boot 接入

本篇的 Spring Boot 示例基于 `rocketmq-spring-boot-starter` 2.3.x（底层走 Remoting 协议的经典客户端，可连 4.x / 5.x Broker，不经过 gRPC Proxy）；5.x 专有能力单独说明，两代的差异见 [RocketMQ 架构与存储 · 版本说明](./5_rocketmq#一、版本说明-4-x-与-5-x)。

```xml
<dependency>
    <groupId>org.apache.rocketmq</groupId>
    <artifactId>rocketmq-spring-boot-starter</artifactId>
    <version>2.3.1</version>
</dependency>
```

```yaml
rocketmq:
  name-server: 127.0.0.1:9876
  producer:
    group: order-producer-group
    send-message-timeout: 3000
    retry-times-when-send-failed: 2        # 同步发送失败重试次数
    retry-times-when-send-async-failed: 2  # 异步发送失败重试次数
```

### 1、生产者

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderMessageProducer {

    private final RocketMQTemplate rocketMQTemplate;

    // 同步发送：等待 Broker 确认，关键业务消息首选
    public void sendOrderCreated(OrderCreatedEvent event) {
        Message<OrderCreatedEvent> msg = MessageBuilder.withPayload(event)
                .setHeader(RocketMQHeaders.KEYS, event.getOrderNo())  // 业务键：可查询、可去重
                .build();
        SendResult result = rocketMQTemplate.syncSend("order-topic:CREATED", msg);  // topic:tag
        if (result.getSendStatus() != SendStatus.SEND_OK) {
            // FLUSH_DISK_TIMEOUT / FLUSH_SLAVE_TIMEOUT / SLAVE_NOT_AVAILABLE：消息已到 Broker 但未达到配置的刷盘/复制要求，关键消息需告警或补偿
            log.warn("send status {}, orderNo={}", result.getSendStatus(), event.getOrderNo());
        }
    }

    // 异步发送：不阻塞业务线程，回调里处理失败
    public void sendLog(OperationLog logEvent) {
        rocketMQTemplate.asyncSend("log-topic", logEvent, new SendCallback() {
            @Override public void onSuccess(SendResult r) { }
            @Override public void onException(Throwable e) { log.error("send failed", e); }
        });
    }

    // 顺序消息：同一 orderNo 进同一个 MessageQueue
    public void sendStatusChange(String orderNo, OrderStatusEvent event) {
        rocketMQTemplate.syncSendOrderly("order-status-topic", event, orderNo);
    }
}
```

> 发送消息不要放在数据库事务里「顺带一起成功」：DB 回滚了消息却已发出，或 DB 提交了消息却没发出，都会不一致。需要「写库 + 发消息」原子性时，用下文的**事务消息**或本地消息表；只需在提交后通知时，用 `@TransactionalEventListener(phase = AFTER_COMMIT)` 发送，但提交后到发送前宕机仍会丢，可靠性要求高时仍要配合本地消息表。详见 [分布式基础 · 分布式事务](/distributed/5_transaction)。

### 2、消费者与幂等

**RocketMQ 只保证 At Least Once，重复投递一定会发生，消费者必须幂等。** 用 `RocketMQListener<MessageExt>` 才能拿到 `msgId`、`keys`、`reconsumeTimes` 等元数据；去重优先用业务键（`keys` 或消息体里的订单号），因为生产者重试会产生 `msgId` 不同的重复消息。

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(
    topic = "order-topic",
    selectorExpression = "CREATED",            // 按 Tag 过滤
    consumerGroup = "order-points-group"
)
public class OrderCreatedConsumer implements RocketMQListener<MessageExt> {

    private final PointsService pointsService;
    private final JsonMapper jsonMapper;      // Jackson 3：tools.jackson.databind.json.JsonMapper

    @Override
    public void onMessage(MessageExt msg) {
        String bizKey = msg.getKeys();          // 业务键，缺失时再退回 msg.getMsgId()
        OrderCreatedEvent event = jsonMapper.readValue(msg.getBody(), OrderCreatedEvent.class);
        pointsService.grantPoints(bizKey, event);
        // 正常返回 = 消费成功；抛异常 = 稍后重试
    }
}
```

`grantPoints` 内部按「去重记录与积分写入同一个本地事务」实现，写法、Redis 状态机方案和「`SETNX` 占位即完成」反模式见 [幂等设计 · 消费幂等](/architecture/3_idempotence#五、消费幂等-同事务去重记录)。RocketMQ 侧的要点：

- **去重键取 `msg.getKeys()`**：发送时把订单号写进 `KEYS`，比 `msgId` 可靠（重试产生的重复消息 `msgId` 不同），控制台也能按 Key 查消息
- **正常返回 = 成功，抛异常 = 重试**：已处理过的消息直接返回；看到「处理中」要抛异常等重投，不能返回成功
- **`msg.getReconsumeTimes()` 可做分级处理**：比如超过若干次后记录告警、走人工补偿，避免一直重试到进死信队列才被发现（重试与死信见下文第四节）

---

## 二、消息类型

| 类型 | 特点 | 适用场景 |
|------|------|---------|
| **普通消息** | 无顺序保证，吞吐最高 | 通知、日志、异步任务 |
| **顺序消息** | 同一 hashKey / MessageGroup 内严格有序 | 订单状态流转、账务流水 |
| **延迟 / 定时消息** | 到期后才对消费者可见 | 订单超时取消、定时提醒 |
| **事务消息** | 本地事务与消息投递最终一致 | 下单后通知下游、跨服务数据同步 |

### 1、延迟消息：4.x 固定级别 vs 5.x 任意时间

**4.x 只支持 18 个固定延迟级别，5.x 支持指定任意投递时间。**

| 版本 | 能力 | 实现 |
|------|------|------|
| 4.x | 级别 1~18：`1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h` | 消息先写入内部 Topic `SCHEDULE_TOPIC_XXXX`，每个级别一个队列，到期后转投原 Topic |
| 5.x | 指定任意时间戳（定时）或延迟时长，上限由 Broker 配置 | 基于时间轮（TimerWheel）+ TimerLog 实现 |

```java
// 4.x：第 16 级 = 30 分钟
rocketMQTemplate.syncSend("order-topic:TIMEOUT_CHECK",
        MessageBuilder.withPayload(event).build(), 3000, 16);

// 5.x Broker：starter 2.3.x 提供按秒 / 毫秒 / 投递时间点发送的方法
rocketMQTemplate.syncSendDelayTimeSeconds("order-topic:TIMEOUT_CHECK", event, 30 * 60);
```

> 延迟消息只能触发「检查」，不能代替状态判断：消费超时取消消息时，要先确认订单仍是「待支付」再取消（用状态条件更新），否则会误取消已支付订单。

### 2、顺序消息

按业务键路由、消费端串行的通用原理见 [消息队列基础 · 顺序消息](/messaging/1_basics#五、顺序消息)，RocketMQ 两代 SDK 的写法：

- **4.x**：`syncSendOrderly(topic, payload, hashKey)` 按 hashKey 选择同一个 MessageQueue；消费端设 `consumeMode = ConsumeMode.ORDERLY`，同一队列同一时刻只由一个线程处理
- **5.x 新 SDK**：Topic 声明为 FIFO 类型，发送时设置 `MessageGroup`（如订单号），消费者组开启顺序投递；同一 MessageGroup 内有序，不同组之间并行
- 生产端必须同步发送（`syncSendOrderly` 底层是 `MessageQueueSelector`），异步并发发送会打乱顺序；顺序消费失败时整队列阻塞重试，见 [重试机制](#_2、重试机制)

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(
    topic = "order-status-topic",
    consumerGroup = "order-status-group",
    consumeMode = ConsumeMode.ORDERLY
)
public class OrderStatusConsumer implements RocketMQListener<MessageExt> {
    private final OrderService orderService;

    @Override
    public void onMessage(MessageExt msg) {
        orderService.applyStatusChange(msg.getKeys(), msg.getBody());  // 同样需要幂等
    }
}
```

---

## 三、事务消息

**事务消息解决的是「本地事务成功 ⇔ 消息一定投递」的原子性：先发一条消费者不可见的半消息，本地事务提交后再确认投递，确认丢失时由 Broker 回查。**

![RocketMQ 事务消息流程](../assets/messaging/rocketmq-transaction.svg)

流程说明：

1. Producer 发送**半消息**，Broker 写入内部 Topic，消费者不可见
2. 半消息写入成功后，Producer 执行本地事务，并在同一事务里记录 `txId`（供回查）
3. 本地事务提交返回 `COMMIT`，失败返回 `ROLLBACK`；Broker 据此投递或丢弃半消息
4. 若第 3 步结果丢失、或返回了 `UNKNOWN`，Broker 定时**回查** `checkLocalTransaction`；回查次数有上限（Broker 配置 `transactionCheckMax`，默认 15 次），超过后默认丢弃该半消息并记录日志

### 1、实现

```java
@Service
@RequiredArgsConstructor
public class OrderTxProducer {

    private final RocketMQTemplate rocketMQTemplate;

    public void createOrder(CreateOrderRequest req) {
        String txId = req.getRequestId();                     // 幂等请求号，作为事务标识
        Message<CreateOrderRequest> msg = MessageBuilder.withPayload(req)
                .setHeader("txId", txId)
                .setHeader("txCreatedAt", System.currentTimeMillis())
                .setHeader(RocketMQHeaders.KEYS, txId)
                .build();
        rocketMQTemplate.sendMessageInTransaction("order-topic:CREATED", msg, req);
    }
}

@RocketMQTransactionListener
@RequiredArgsConstructor
public class OrderTxListener implements RocketMQLocalTransactionListener {

    private static final long UNCERTAIN_WINDOW_MS = 5 * 60 * 1000;
    private final OrderTxService orderTxService;
    private final TxLogMapper txLogMapper;

    @Override
    public RocketMQLocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        String txId = (String) msg.getHeaders().get("txId");
        try {
            // @Transactional：写订单 + 写事务记录 tx_log(tx_id 唯一) 在同一个本地事务
            orderTxService.createOrder((CreateOrderRequest) arg, txId);
            return RocketMQLocalTransactionState.COMMIT;
        } catch (BizException e) {
            return RocketMQLocalTransactionState.ROLLBACK;    // 确定失败（如库存不足），事务已回滚
        } catch (Exception e) {
            return RocketMQLocalTransactionState.UNKNOWN;     // 超时等结果不确定，交给回查
        }
    }

    @Override
    public RocketMQLocalTransactionState checkLocalTransaction(Message msg) {
        String txId = (String) msg.getHeaders().get("txId");
        if (txLogMapper.exists(txId)) {
            return RocketMQLocalTransactionState.COMMIT;      // 本地事务已提交
        }
        long createdAt = Long.parseLong(String.valueOf(msg.getHeaders().get("txCreatedAt")));
        if (System.currentTimeMillis() - createdAt > UNCERTAIN_WINDOW_MS) {
            return RocketMQLocalTransactionState.ROLLBACK;    // 超过窗口仍无记录，可确定未提交
        }
        return RocketMQLocalTransactionState.UNKNOWN;         // 可能仍在执行，下次再查
    }
}
```

### 2、注意事项

- **回查只在「确定」时返回 COMMIT / ROLLBACK**：查不到记录不等于失败，本地事务可能还没提交；此时必须返回 `UNKNOWN`，否则会把即将成功的事务消息回滚掉
- **回查依据必须持久化**：`txId` 要和业务数据在同一个事务里落库，回查只读这张表，不依赖内存状态
- **回查可能落到其他实例**：Producer 集群中任一实例都可能收到回查，所以回查逻辑只能依赖数据库
- **回查节奏**：Broker 按 `transactionCheckInterval` 周期回查，超过 `transactionCheckMax` 次后丢弃半消息；不确定窗口要大于本地事务的最长执行时间
- **其他客户端写法**：原生 Remoting 客户端用 `TransactionMQProducer` + `TransactionListener`（状态枚举 `LocalTransactionState.UNKNOW`）；5.x gRPC 客户端（`rocketmq-client-java`）用 `TransactionChecker` 与 `producer.beginTransaction()`，语义相同
- 事务消息只保证「生产端本地事务 ⇔ 消息投递」一致，**下游消费失败不会回滚上游**，下游仍需重试 + 幂等，必要时人工补偿
- 不用 RocketMQ 时，等价方案是本地消息表（Transactional Outbox），见 [分布式基础 · 分布式事务](/distributed/5_transaction)

---

## 四、消费模式、重试与死信

### 1、集群与广播

| 模式 | 说明 | 失败处理 |
|------|------|---------|
| **集群消费（默认）** `CLUSTERING` | 同组实例分摊队列，每条消息组内只被处理一次；消费进度存在 Broker | 支持重试与死信 |
| **广播消费** `BROADCASTING` | 同组每个实例都收到全量消息；消费进度存在本地 | **不重试、不进死信**，失败即丢弃，适合刷新本地缓存这类可容忍丢失的场景 |

### 2、重试机制

**并发消费和顺序消费的重试方式完全不同：前者把消息挪到重试队列、继续消费后面的消息；后者在本地挂起重试、整个队列停住等它。**

| 消费模式 | 重试方式 | 默认次数 | 超过次数后 |
|---------|---------|---------|-----------|
| **并发消费** `CONCURRENTLY` | 消息发回 Broker 的 `%RETRY%{group}` Topic，按阶梯间隔（10s、30s、1m … 2h）重新投递；后续消息不受影响 | 16 次 | 进入死信队列 `%DLQ%{group}` |
| **顺序消费** `ORDERLY` | 不发回 Broker，在本地暂停当前队列一小段时间后重试同一条消息（SUSPEND），**不会跳过它去消费后面的消息** | 未配置 `maxReconsumeTimes` 时近乎无限 | 达到配置的上限后进死信，队列才继续 |
| **广播消费** | 不重试 | — | 丢弃 |

- `@RocketMQMessageListener(maxReconsumeTimes = 5)` 可调整次数；顺序消费务必设置上限，否则一条毒消息会让整个队列永久卡住
- 重试间隔较长，不要用它做「快速重试」：瞬时失败可以在消费方法内先做几次短间隔重试，仍失败再抛出
- `msg.getReconsumeTimes()` 可拿到已重试次数，用于在最后几次重试时打告警

### 3、死信处理

「退避重试 + 死信兜底」的通用原则见 [消息队列基础 · 重试与死信](/messaging/1_basics#七、重试与死信)。死信 Topic 名为 `%DLQ%{ConsumerGroup}`，**默认权限为只写（perm=2），不能被订阅消费**，需先在控制台或用 `mqadmin updateTopic -p 6` 把权限改为可读写，再订阅处理：

```java
@Component
@RequiredArgsConstructor
@RocketMQMessageListener(
    topic = "%DLQ%order-points-group",
    consumerGroup = "order-points-dlq-group"
)
public class OrderPointsDlqHandler implements RocketMQListener<MessageExt> {
    private final DlqRecordService dlqRecordService;
    private final AlertService alertService;

    @Override
    public void onMessage(MessageExt msg) {
        // 落库待人工审核 + 告警；修复后可按 keys 重新投递原 Topic
        dlqRecordService.save(msg.getKeys(), msg.getProperty("ORIGIN_MESSAGE_ID"), msg.getBody());
        alertService.sendDlqAlert("order-points-group", msg.getKeys());
    }
}
```

---

## 五、可靠性与常见问题

### 1、消息不丢

| 环节 | 措施 |
|------|------|
| 生产者 | 关键消息用 `syncSend` 并检查结果；失败重试（`retry-times-when-send-failed`）；需要与本地事务一致时用事务消息 |
| Broker | 同步复制（`SYNC_MASTER` 或 Controller 模式）+ 视要求选择同步刷盘 |
| 消费者 | 业务处理完成后才正常返回；不要在消费方法内异步处理后直接返回 |

Broker 侧的复制与刷盘配置见 [RocketMQ 架构与存储 · 高可用](./5_rocketmq#四、高可用)。

### 2、重复消费

生产者超时重试、消费者重启或 Rebalance 都会导致重复。按 [消费者与幂等](#_2、消费者与幂等) 的方式用**业务键 + 本地事务去重表**实现幂等，写法见 [幂等设计 · 消费幂等](/architecture/3_idempotence#五、消费幂等-同事务去重记录)。

### 3、消息积压

通用的排查与处置清单见 [消息队列基础 · 消息积压](/messaging/1_basics#六、消息积压)，RocketMQ 侧要点：

- **扩容上限**：4.x 实例数超过 MessageQueue 数后多出的实例空闲，需同时增加队列数；5.x 用 POP 消费可突破这一限制
- **提升单实例吞吐**：调大 `consumeThreadNumber`（并发模式）；原生 `DefaultMQPushConsumer` 可设 `consumeMessageBatchMaxSize` 批量消费（starter 的 `RocketMQListener` 是逐条回调）
- **留意重试放大**：并发消费失败的消息回到 `%RETRY%{group}` 再投递，大量失败时先修复毒消息或下游故障；死信积压按 Key 重放，不要直接清空

---

## 小结

- 关键消息用 `syncSend` 并检查发送状态，发送时把业务键写进 `KEYS`；不要在数据库事务里直接发消息
- 只保证 At Least Once，幂等用 `MessageExt` 取业务键，去重记录与业务写入放在同一个本地事务
- 延迟消息 4.x 只有 18 个固定级别、5.x 可指定任意时间；顺序消息按 hashKey 或 MessageGroup 路由，生产端必须同步发送
- 事务消息 = 半消息 + 本地事务 + 回查；回查结果不确定时必须返回 `UNKNOWN`，`txId` 与业务数据同事务落库
- 并发消费重试 16 次后进 `%DLQ%{group}`；顺序消费本地挂起重试、整队列阻塞，务必设上限；广播消费不重试

## 参考资料

- 官方文档：[https://rocketmq.apache.org/docs/](https://rocketmq.apache.org/docs/)
- rocketmq-spring：[https://github.com/apache/rocketmq-spring](https://github.com/apache/rocketmq-spring)
- rocketmq-clients（5.x 新 SDK）：[https://github.com/apache/rocketmq-clients](https://github.com/apache/rocketmq-clients)

> 下一篇：[RabbitMQ 核心模型与高可用](./7_rabbitmq) —— Exchange 四种类型与 Topic 匹配、Docker 安装、镜像队列移除、Quorum 队列、Streams

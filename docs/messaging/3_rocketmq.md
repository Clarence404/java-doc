---
description: 4.x 与 5.x 差异、架构、存储结构、高可用、消息类型、事务消息、重试与死信、幂等与积压
---

# RocketMQ

> **本篇目标**：理解 RocketMQ 的架构与存储设计，用 Spring Boot 写出可靠的生产与消费代码，掌握事务消息、延迟消息、重试与死信的正确用法。
>
> **前置阅读**：[消息队列基础](./1_basics)

> 参考资料：
> * 官方文档：[https://rocketmq.apache.org/docs/](https://rocketmq.apache.org/docs/)
> * rocketmq-spring：[https://github.com/apache/rocketmq-spring](https://github.com/apache/rocketmq-spring)
> * rocketmq-clients（5.x 新 SDK）：[https://github.com/apache/rocketmq-clients](https://github.com/apache/rocketmq-clients)

RocketMQ 诞生于阿里交易场景，强项是**业务消息**：事务消息、延迟消息、顺序消息、消息轨迹与按 Key 查询都是开箱即用。和 [Kafka](./2_kafka) 相比，它的吞吐稍逊，但在「订单、支付、库存」这类对可靠性和业务语义要求高的场景更顺手。

---

## 一、版本说明：4.x 与 5.x

**5.x 不是小版本升级，而是架构演进：引入无状态 Proxy、gRPC 协议和新的轻量客户端。** 存量系统大多仍在用 4.x 的 Remoting 协议客户端，两者的差异需要先分清：

| 维度 | 4.x | 5.x |
|------|-----|-----|
| 接入协议 | Remoting（自定义 TCP 协议），客户端直连 Broker | 新增 **Proxy + gRPC**，客户端连 Proxy；Remoting 仍兼容 |
| 客户端 | `rocketmq-client`（重客户端，负载均衡在客户端） | `rocketmq-client-java`（轻客户端，多语言统一） |
| 顺序消息 | 按 `hashKey` 选 MessageQueue | Topic 声明为 FIFO 类型，按 **MessageGroup** 保证组内有序 |
| 延迟消息 | 18 个固定级别，最长 2h | **定时消息**：指定任意投递时间戳（上限由 Broker 配置） |
| 消费方式 | Push / Pull，队列粒度负载均衡 | 新增 **POP 消费**：Broker 侧按消息分配，消费者数可超过队列数 |
| 高可用 | 主从复制 / DLedger（Raft） | 新增 **Controller 模式**：自动选主，复制仍走主从链路 |
| Topic 类型 | 不区分 | 创建时可声明 `message.type`（NORMAL / FIFO / DELAY / TRANSACTION），开启 Broker 类型校验时发送类型须与之一致 |

本篇的 Spring Boot 示例基于 `rocketmq-spring-boot-starter` 2.3.x（底层走 Remoting 协议的经典客户端，可连 4.x / 5.x Broker，不经过 gRPC Proxy）；5.x 专有能力单独说明。

---

## 二、架构与核心概念

![RocketMQ 部署架构](../assets/messaging/rocketmq-architecture.svg)

| 组件/概念 | 说明 |
|----------|------|
| **NameServer** | 无状态路由中心，Broker 定时注册心跳，客户端定时拉取路由；节点之间互不通信，任一存活即可工作 |
| **Broker** | 消息存储与转发节点；Master 负责读写，Slave 备份数据 |
| **Proxy**（5.x） | 无状态接入层，承接 gRPC 请求、做协议转换与 POP 消费，可与 Broker 同进程（Local 模式）或独立部署（Cluster 模式） |
| **Topic** | 消息的逻辑分类，由多个 MessageQueue 组成 |
| **MessageQueue** | Topic 的分片（对标 Kafka Partition），决定并发度与顺序粒度 |
| **Tag** | Topic 内的二级标签，消费者可按 Tag 在 Broker 侧过滤 |
| **Keys** | 消息的业务键，Broker 建索引，可按 Key 查询，也是幂等去重的首选依据 |
| **ConsumerGroup** | 同组实例分摊消费（集群模式）或各自全量消费（广播模式） |

---

## 三、存储结构

**RocketMQ 把所有 Topic 的消息顺序追加到同一个 CommitLog，再异步构建轻量索引供消费和查询。** 这和 Kafka「每个 Partition 一组文件」不同：Topic 再多，磁盘写入仍是单文件顺序写，不会退化为随机 IO。

| 文件 | 内容 | 作用 |
|------|------|------|
| **CommitLog** | 消息体本身，所有 Topic 混合顺序写，单文件默认 1GB | 唯一的数据文件，决定写入性能 |
| **ConsumeQueue** | 每个 Topic 的每个 Queue 一份，定长条目（CommitLog 偏移 + 消息长度 + Tag 哈希） | 消费索引：按 Queue 偏移定位消息，按 Tag 哈希做初步过滤 |
| **IndexFile** | 以 Keys / 消息 ID 为键的哈希索引 | 按 Key 或时间区间查询消息，用于排查与补偿 |

读写路径上的关键优化：

- **mmap + PageCache**：CommitLog 与 ConsumeQueue 用 `MappedByteBuffer` 映射到内存，写入先落 PageCache，热数据的读取直接命中内存；零拷贝原理见 [Netty · ByteBuf 与内存管理](/netty/6_bytebuf)
- **消费是两次查找**：先读 ConsumeQueue 拿到偏移，再到 CommitLog 取消息体；ConsumeQueue 条目很小，基本常驻 PageCache
- **刷盘策略**：

| 刷盘方式 | 配置 | 特点 |
|---------|------|------|
| 异步刷盘（默认） | `flushDiskType=ASYNC_FLUSH` | 写入 PageCache 即返回，后台线程定期刷盘；机器断电可能丢最近一小段 |
| 同步刷盘 | `flushDiskType=SYNC_FLUSH` | 刷到磁盘才返回成功；可靠性最高，吞吐明显下降 |

> 实践中更常见的组合是「异步刷盘 + 同步复制」：单机断电丢的数据由副本兜底，兼顾性能与可靠性。

---

## 四、高可用

**RocketMQ 的高可用经历了三个阶段：主从复制 → DLedger（Raft）→ 5.x Controller。** 区别在于 Master 宕机后能否自动切换、切换是否会丢数据。

| 方案 | 复制方式 | 故障切换 | 说明 |
|------|---------|---------|------|
| **主从同步/异步复制** | `brokerRole=SYNC_MASTER` / `ASYNC_MASTER` | 不自动切换；Master 宕机后该 Broker 不可写，消费可转到 Slave 读 | 同步复制：Slave 确认后才返回，不丢数据；异步复制：延迟低，宕机可能丢少量未复制消息。可靠性靠多组 Broker 分担写入 |
| **DLedger**（4.5+） | 基于 Raft 的 CommitLog 复制，多数派写入成功才提交 | 自动选主 | 至少 3 副本；CommitLog 格式被 Raft 日志接管，存储与复制强耦合 |
| **Controller 模式**（5.x） | 仍用主从复制，维护同步副本集合（SyncStateSet） | Controller（可内嵌 NameServer）自动选主 | 选主只在同步副本中进行，避免丢数据；2 副本即可工作，复用原有存储格式 |

新集群优先选 5.x Controller 模式；存量 4.x 集群如需自动切换，可用 DLedger。

---

## 五、Spring Boot 接入

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

> 发送消息不要放在数据库事务里「顺带一起成功」：DB 回滚了消息却已发出，或 DB 提交了消息却没发出，都会不一致。需要「写库 + 发消息」原子性时，用下文的**事务消息**或本地消息表；只需在提交后通知时，用 `@TransactionalEventListener(phase = AFTER_COMMIT)` 发送，但提交后到发送前宕机仍会丢，可靠性要求高时仍要配合本地消息表。详见 [分布式 · 分布式事务](/distributed/4_transaction)。

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

    @Override
    public void onMessage(MessageExt msg) {
        String bizKey = msg.getKeys();          // 业务键，缺失时再退回 msg.getMsgId()
        OrderCreatedEvent event = JSON.parseObject(msg.getBody(), OrderCreatedEvent.class);
        pointsService.grantPoints(bizKey, event);
        // 正常返回 = 消费成功；抛异常 = 稍后重试
    }
}

@Service
@RequiredArgsConstructor
public class PointsService {

    private final ConsumeRecordMapper consumeRecordMapper;
    private final PointsMapper pointsMapper;

    @Transactional
    public void grantPoints(String bizKey, OrderCreatedEvent event) {
        try {
            // 去重记录表：唯一键 (consumer_group, biz_key)，与业务写入在同一个本地事务
            consumeRecordMapper.insert("order-points-group", bizKey);
        } catch (DuplicateKeyException e) {
            return;                              // 已处理过，直接视为成功
        }
        pointsMapper.addPoints(event.getUserId(), event.getAmount());
    }
}
```

要点：

- **去重记录与业务写入必须在同一个本地事务**，业务失败时去重记录一起回滚，重投时能再次处理
- 不能「先 Redis `SETNX` 占位、再处理」：处理失败后占位还在，重投会被误判为已处理而丢消息。业务不在 DB 时用 Redis 状态机：`SET key processing NX EX` → 处理 → 置为 `done`；失败则 `DEL` 让重投能重试；重投时看到 `processing` 说明另一实例在处理，应抛异常稍后重试，而不是直接确认跳过
- 通用方案对比见 [系统架构 · 幂等设计](/architecture/5_idempotence)

---

## 六、消息类型

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

- **4.x**：`syncSendOrderly(topic, payload, hashKey)` 按 hashKey 选择同一个 MessageQueue；消费端设 `consumeMode = ConsumeMode.ORDERLY`，同一队列同一时刻只由一个线程处理
- **5.x 新 SDK**：Topic 声明为 FIFO 类型，发送时设置 `MessageGroup`（如订单号），消费者组开启顺序投递；同一 MessageGroup 内有序，不同组之间并行
- 顺序只在「同一个 key」内成立；生产端必须同步发送，异步并发发送会打乱顺序

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

## 七、事务消息

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
- 事务消息只保证「生产端本地事务 ⇔ 消息投递」一致，**下游消费失败不会回滚上游**，下游仍需重试 + 幂等，必要时人工补偿
- 不用 RocketMQ 时，等价方案是本地消息表（Transactional Outbox），见 [分布式 · 分布式事务](/distributed/4_transaction)

---

## 八、消费模式、重试与死信

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

死信 Topic 名为 `%DLQ%{ConsumerGroup}`，**默认权限为只写（perm=2），不能被订阅消费**，需先在控制台或用 `mqadmin updateTopic -p 6` 把权限改为可读写，再订阅处理：

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

## 九、可靠性与常见问题

### 1、消息不丢

| 环节 | 措施 |
|------|------|
| 生产者 | 关键消息用 `syncSend` 并检查结果；失败重试（`retry-times-when-send-failed`）；需要与本地事务一致时用事务消息 |
| Broker | 同步复制（`SYNC_MASTER` 或 Controller 模式）+ 视要求选择同步刷盘 |
| 消费者 | 业务处理完成后才正常返回；不要在消费方法内异步处理后直接返回 |

### 2、重复消费

生产者超时重试、消费者重启或 Rebalance 都会导致重复。按「五、2」的方式用**业务键 + 本地事务去重表**实现幂等。

### 3、消息积压

- **先止血**：确认消费者是否在报错重试（大量重试会放大积压），先修复毒消息或下游故障
- **扩容消费者**：4.x 实例数超过 MessageQueue 数后多出的实例空闲，需同时增加队列数；5.x 用 POP 消费可突破这一限制
- **提升单实例吞吐**：调大 `consumeThreadNumber`（并发模式）；原生 `DefaultMQPushConsumer` 可设 `consumeMessageBatchMaxSize` 批量消费（starter 的 `RocketMQListener` 是逐条回调）；把慢 IO 改为批量写
- **临时转储**：积压巨大时，写一个临时消费者把消息快速转发到队列更多的新 Topic，再用大量实例消费新 Topic
- **死信积压**：排查原因后写补偿脚本按 Key 重放，不要直接清空
- 系统级的削峰与容量规划见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)

---

## 小结

- 5.x 引入 Proxy + gRPC、新 SDK（MessageGroup 顺序）、任意时间定时消息、POP 消费与 Controller 高可用；4.x 是 18 级延迟与 DLedger
- 存储上所有 Topic 共用 CommitLog 顺序写，ConsumeQueue 做消费索引、IndexFile 做 Key 查询，依靠 mmap + PageCache 提速
- 事务消息 = 半消息 + 本地事务 + 回查；回查结果不确定时必须返回 `UNKNOWN`，`txId` 与业务数据同事务落库
- 并发消费重试 16 次后进 `%DLQ%{group}`；顺序消费本地挂起重试、整队列阻塞，务必设上限；广播消费不重试
- 幂等用 `MessageExt` 取业务键，去重记录与业务写入放在同一个本地事务

> 下一篇：[RabbitMQ](./4_rabbitmq) —— 从 Exchange 路由模型到仲裁队列，看另一种以灵活路由见长的 MQ。

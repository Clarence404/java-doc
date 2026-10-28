---
description: 同步与异步的划分、RocketMQ 选型、本地消息表 t_outbox、消费幂等、重试与死信、超时关单、积压监控
---

# 异步化

> 前置阅读：[接口设计](./3_api_design)、[消息队列基础](/messaging/1_basics)、[分布式事务](/distributed/4_transaction)

阶段二支付成功后的积分、通知、发货单都在回调里同步执行，拖慢响应还牵连主链路。本篇讲异步边界、本地消息表与 RocketMQ、消费幂等与超时关单，基线为 RocketMQ 5、Spring Boot 4。

---

## 一、背景

上一篇 [引入缓存](./4_cache) 解决了读压力，阶段二的另一个矛盾在写链路上：日订单到了 10 万，下单峰值约 200 QPS，支付成功回调峰值约 180 QPS。阶段一就有的短信通知之外，这一阶段运营又上线了积分和 App 推送，仓库接入了 WMS（仓储系统），三件事都直接写在 `mall-order` 的 `pay` 包里，由 `PayCallbackService` 在订单事务提交后依次调用：

| 步骤 | 依赖 | 平均耗时 | P99 |
|------|------|---------|-----|
| `t_payment` 置成功、`t_order` 10→20 | 本库 | 8 ms | 25 ms |
| 加积分 | mall-user，本库 | 10 ms | 40 ms |
| 发短信、App 推送 | 短信服务商、推送平台 HTTP 接口 | 180 ms | 1.2 s |
| 建发货单 | WMS HTTP 接口 | 120 ms | 900 ms |
| **合计** | | **约 320 ms** | **约 2.1 s** |

数字本身还能忍，真正出事的是耦合：

- **外部故障进了主链路**：一次 WMS 发布后响应变成 3 s，回调线程占满 Tomcat 线程池，同一进程里下单接口的 P99 从 150 ms 涨到 2.5 s
- **失败没人补**：短信服务商故障 40 分钟，回调在订单提交后抛异常、返回 500，支付渠道反复重发；可订单早已是待发货，重发的回调被判为重复直接返回，没发出去的短信、没建成的发货单再也没人补
- **加一个下游就改一次支付代码**：运营还排着「支付后返券」「埋点上报」，每加一个都要改 `PayCallbackService`、重新回归支付

---

## 二、哪些异步，哪些保持同步

判断标准只有一条：**用户当场要看到结果、失败时本次请求就该失败的，保持同步；其余的都可以晚几秒做完**。

| 动作 | 方式 | 理由 |
|------|------|------|
| 下单扣库存、写订单 | 同步（本地事务） | 超卖必须在下单时拦住，阶段二仍走条件更新 |
| 支付成功：`t_payment`、`t_order` 10→20 | 同步（本地事务） | 这是「已支付」这个事实本身，回调据此应答渠道 |
| 加积分 | 异步 | 晚几秒到账用户感知不到，但不能丢 |
| 短信、App 推送 | 异步 | 外部依赖慢且不稳定，可以接受延迟和极少量重复 |
| 建发货单 | 异步 | 仓库按批次拣货，分钟级延迟没有影响 |
| 超时关单 | 异步（定时消息） | 本来就是 15 分钟后才做的动作 |

异步之后支付回调只剩一个本地事务，P99 回到 30 ms 以内；下游再慢，也只是自己的消费组变慢。消息队列解耦、削峰的通用作用见 [消息队列基础 · 核心作用](/messaging/1_basics#一、核心作用)。

---

## 三、选项

### 1、要不要上 MQ

在单体里，最省事的写法是 `@TransactionalEventListener(phase = AFTER_COMMIT)` 加 `@Async` 线程池，不多一个中间件。它的问题是事件只在内存里：进程重启、发布时排队的任务全丢，没有重试和死信，也看不到积压；阶段三拆服务后积分、发货单不在一个进程里，还得再换一次。所以只把它用在「丢了也无所谓」的地方（如刷新本地缓存），这三件事要上 MQ。

### 2、上哪个 MQ

| 维度 | RocketMQ 5 | Kafka 4 | RabbitMQ 4 |
|------|-----------|---------|------------|
| 15 分钟关单 | 原生定时消息，任意时间 | 不支持，要自建延迟层 | TTL + 死信交换机或延迟插件 |
| 重试与死信 | 按消费组内置阶梯重试 + 死信 | 无内置，要自己写重试 Topic | 死信交换机，重试间隔要自己编排 |
| 按订单号查消息 | 按 Keys 查询，控制台可直接重发 | 不支持按业务键查 | 不支持 |
| 积压能力 | 强，消息落盘保留数天 | 最强 | 经典 / 仲裁队列大量堆积时性能下降 |
| 托管与团队经验 | 云厂商托管成熟，团队有人用过 | 托管成熟，但团队只用它做过日志 | 团队无经验 |

逐项对比和场景决策表见 [MQ 选型](/messaging/6_selection)。

### 3、写库和发消息怎么保证一致

| 方案 | 做法 | 问题 |
|------|------|------|
| 事务里直接发 | `@Transactional` 方法里调 `send` | 事务回滚了消息已发出，或提交了消息没发出 |
| 提交后发送 | `AFTER_COMMIT` 里调 `send` | 提交后、发送前宕机，消息丢失 |
| RocketMQ 事务消息 | 半消息 + 本地事务 + 回查 | 要写回查接口，业务代码绑死 RocketMQ API |
| **本地消息表** | 同一事务写业务表和 `t_outbox`，中继投递 | 多一张表和一个投递任务，消息至少一次 |

三种方案的原理对比见 [消息队列基础 · 方案对比](/messaging/1_basics#_4、方案对比)。

---

## 四、决策

- **MQ 选 RocketMQ 5，用云厂商托管实例**：定时消息直接覆盖超时关单，消费组自带重试和死信，按订单号查消息对排查最友好；3 个人不自建 NameServer / Broker 集群
- **一致性用本地消息表 `t_outbox`**：放在 mall-order、与订单同库同事务。不用事务消息，是因为 `t_outbox` 同时承载普通消息和定时消息，中继逻辑只写一份；表里能直接查到「哪笔订单的消息发没发」；阶段三其他服务照搬同一套
- **Topic 与消费组**：支付成功发 `order-paid`，三个消费组 `points-consumer`、`notify-consumer`、`shipment-consumer` 各收一份；超时关单发 `order-timeout`，消费组 `order-timeout-consumer`
- **消费幂等统一用 `t_consume_record`**：三个下游里只有积分有天然的业务表，通知和 WMS 都是外部调用，统一一张去重表，写法一致、排查时也能查到「这笔订单被哪个组处理过」
- **客户端用 `rocketmq-client-java` 5.x**：走 Proxy + gRPC，几个 Bean 就能包装好；没有用 [RocketMQ](/messaging/3_rocketmq) 主文档里的 starter，它底层是 Remoting 经典客户端

明确暂不做：

- **不做顺序消息**：`order-paid` 每笔订单只有一条，三个下游之间、不同订单之间都没有先后依赖；顺序消费一条毒消息会卡住整个队列，代价不值。阶段三订单状态事件变多时再评估按订单号的 FIFO Topic，原理见 [消息队列基础 · 顺序消息](/messaging/1_basics#五、顺序消息)
- **不把下单本身异步化**：排队下单是大促削峰手段，阶段二 200 QPS 用不上
- **不建消息轨迹平台、不做 CDC 投递**：控制台按 Keys 查询加 `t_outbox` 已够排查

![支付成功后的异步链路](../assets/project/order-paid-async-flow.svg)

---

## 五、关键实现

### 1、本地消息表

```sql
CREATE TABLE t_outbox (
    id            BIGINT        NOT NULL COMMENT '雪花 ID',
    topic         VARCHAR(64)   NOT NULL COMMENT 'order-paid / order-timeout',
    msg_key       VARCHAR(64)   NOT NULL COMMENT '业务键，即 order_no，发送时写入消息 Keys',
    payload       JSON          NOT NULL,
    deliver_at    DATETIME(3)   NULL     COMMENT '定时投递时间，为空表示立即投递',
    status        TINYINT       NOT NULL DEFAULT 0 COMMENT '0 待发送 1 已发送 2 失败',
    retry_count   INT           NOT NULL DEFAULT 0,
    next_retry_at DATETIME(3)   NOT NULL COMMENT '扫表兜底的最早时间，写入时为当前时间 + 3 秒',
    created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_topic_key (topic, msg_key),
    KEY idx_status_retry (status, next_retry_at)
) COMMENT '本地消息表，归 mall-order';
```

`uk_topic_key` 保证一笔订单的同一种消息只写一条，支付回调重复到达时，第二次的状态条件更新影响 0 行，也就不会再写。写入由 `OutboxWriter` 完成，要求调用方已经在事务里，提交后立刻交给中继发送：

```java
// com.qingyou.order.outbox.OutboxWriter
@Transactional(propagation = Propagation.MANDATORY)       // 必须在业务事务内调用
public void append(String topic, String orderNo, Object payload, LocalDateTime deliverAt) {
    OutboxRecord r = OutboxRecord.of(topic, orderNo, Json.write(payload), deliverAt);
    outboxMapper.insert(r);
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {                        // 提交后立即发，不等扫表
            outboxExecutor.execute(() -> outboxRelay.relayOne(r.id()));
        }
    });
}
```

```java
// com.qingyou.order.pay.PayCallbackService（节选）
@Transactional
public void onPaid(PayNotify n) {
    if (paymentMapper.markSuccess(n.paymentNo(), n.channelTradeNo()) == 0) {
        return;                                            // 重复回调：支付单已是成功状态
    }
    if (orderMapper.updateStatus(n.orderId(), OrderStatus.PENDING_PAYMENT, OrderStatus.PENDING_SHIPMENT) == 0) {
        paymentMapper.markRefundPending(n.paymentNo());   // 订单已超时关闭：支付单转待退款，走原路退款
        return;
    }
    outboxWriter.append("order-paid", n.orderNo(), OrderPaidEvent.of(n), null);
}
```

已关单后才到的支付按「关单后收到支付」走原路退款，处理方式见 [订单 · 支付回调](/scenario/5_order_system#五、支付回调)。

### 2、中继投递

中继既服务「提交后立即发」，也服务「每秒扫表兜底」；两台应用机同时跑，用 `FOR UPDATE SKIP LOCKED` 让同一行只被一个线程处理，原理见 [分布式事务 · 中继投递代码](/distributed/4_transaction#_3、中继投递代码)：

```java
// com.qingyou.order.outbox.OutboxRelay
@Transactional
public void relayOne(long id) {
    OutboxRecord r = outboxMapper.lockPendingById(id);    // 已发送或被别的线程锁住时返回 null
    if (r != null) send(r);
}

@Transactional
public int relayBatch(int limit) {                         // OutboxRelayJob 每秒调用一次，limit = 100
    List<OutboxRecord> batch = outboxMapper.lockPending(limit);
    batch.forEach(this::send);
    return batch.size();
}

private void send(OutboxRecord r) {
    MessageBuilder b = provider.newMessageBuilder()
            .setTopic(r.topic())
            .setKeys(r.msgKey())                           // 控制台按订单号查消息，消费端按它去重
            .setBody(r.payload().getBytes(StandardCharsets.UTF_8));
    if (r.deliverAt() != null) {
        b.setDeliveryTimestamp(r.deliverAt().atZone(ZoneId.systemDefault()).toInstant().toEpochMilli());
    }
    try {
        producer.send(b.build());                          // 同步发送，Broker 确认后才置 SENT
        outboxMapper.markSent(r.id());
    } catch (ClientException e) {
        outboxMapper.markRetry(r.id());                    // retry_count + 1，按退避推迟 next_retry_at，超过 10 次置为失败
    }
}
```

`Producer` 在启动时用 `ClientServiceProvider` 构建，接入点和 AccessKey 从 [工程搭建](./1_project_setup) 约定的 `EnvironmentFile` 环境变量读取。发送成功但 `markSent` 前宕机时消息会再发一次，这是本地消息表「至少一次」的固有代价，由消费端幂等兜住。已发送的记录保留 7 天，每天凌晨分批删除。

### 3、消费与幂等

```sql
CREATE TABLE t_consume_record (
    consumer_group VARCHAR(64) NOT NULL,
    biz_key        VARCHAR(64) NOT NULL COMMENT '消息 Keys，即 order_no',
    created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (consumer_group, biz_key),
    KEY idx_created (created_at)
) COMMENT '消费去重记录，保留 30 天';
```

积分是强要求「不丢不重」的，去重记录和加积分放在**同一个本地事务**里，插入影响 0 行说明处理过，直接返回：

```java
// com.qingyou.user.points.PointsGrantService
@Transactional
public void grant(OrderPaidEvent e) {
    if (consumeRecordMapper.insertIgnore("points-consumer", e.orderNo()) == 0) {
        return;                                            // 重复投递
    }
    pointsMapper.add(e.userId(), e.payAmount().setScale(0, RoundingMode.DOWN).intValue(), e.orderNo());
}
```

```java
// 消费者注册（节选）：返回 SUCCESS 确认，返回 FAILURE 由 Broker 按退避重投
provider.newPushConsumerBuilder()
        .setClientConfiguration(clientConfig)
        .setConsumerGroup("points-consumer")
        .setSubscriptionExpressions(Map.of("order-paid", new FilterExpression("*", FilterExpressionType.TAG)))
        .setMessageListener(view -> {
            OrderPaidEvent e = Json.read(view.getBody(), OrderPaidEvent.class);
            try {
                pointsGrantService.grant(e);
                return ConsumeResult.SUCCESS;
            } catch (Exception ex) {
                log.warn("加积分失败，orderNo={}，第 {} 次投递", e.orderNo(), view.getDeliveryAttempt(), ex);
                return ConsumeResult.FAILURE;
            }
        })
        .build();
```

另外两个组调用的是外部接口，没法和去重记录放进一个事务，分别处理：

- **`notify-consumer` 先发后记**：先查记录，没有才发短信，发成功再插记录；发完、插记录前宕机会多发一条，可以接受。支付时间超过 30 分钟的消息直接确认不发，迟到的「支付成功」短信只会让用户困惑
- **`shipment-consumer` 依赖 WMS 幂等**：调用 WMS 时把 `order_no` 作为外部单号，WMS 按外部单号去重；成功后插记录，下次重投在本地就被挡住

去重记录与业务同事务、Redis 状态机等方案对比见 [幂等设计 · 消费幂等](/architecture/3_idempotence#五、消费幂等-同事务去重记录)；没做幂等时线上会是什么样，见 [重复消费](/handbook/2_incidents/13_duplicate_consume)。

### 4、重试与死信

三个组都用并发消费，失败按阶梯退避重投，超过次数进入 `%DLQ%{消费组}`，在托管控制台按组配置：

| 消费组 | 最大投递次数 | 超过后 |
|--------|------------|--------|
| `points-consumer` | 16（约 4.7 小时内重试完） | 进死信，告警，修复后从控制台重发 |
| `notify-consumer` | 3 | 进死信，不重发，通知类消息过时即作废 |
| `shipment-consumer` | 16 | 进死信，告警，仓储同事确认后重发或手工建单 |
| `order-timeout-consumer` | 16 | 进死信，由兜底扫描关单 |

瞬时失败（如 WMS 偶发超时）先在消费方法内短间隔重试 2 次，仍失败再返回 `FAILURE`，避免一次抖动就等上 10 秒。重试队列与死信的机制见 [RocketMQ · 消费模式、重试与死信](/messaging/3_rocketmq#八、消费模式、重试与死信)。

### 5、超时关单

阶段一每分钟扫一次 `idx_status_created`，关单最多晚 1 分钟，库存也跟着多占 1 分钟；日订单 10 万后，待支付订单常驻上千笔，每分钟一次的扫描开始出现在慢查询里。改为下单时写一条定时消息，扫描降级为兜底：

- **下单**：`PlaceOrderTxService` 在同一事务里 `append("order-timeout", orderNo, payload, createdAt.plusMinutes(15))`
- **到期**：`order-timeout-consumer` 调 `OrderCloseService.closeIfUnpaid(orderNo)`，用状态条件更新 10→50，影响 1 行才在同一事务回补库存；用户已支付时影响 0 行，直接确认消息。支付成功不需要「撤回」定时消息
- **兜底**：原扫描任务改为每 10 分钟一次，只处理创建超过 20 分钟仍待支付的订单，防止 MQ 或中继故障时订单永远不关

![订单超时关单：定时消息 + 扫描兜底](../assets/project/order-timeout-close-flow.svg)

`order-timeout` 创建时声明为 DELAY 类型，5.x 定时消息与 4.x 固定级别的区别见 [RocketMQ · 延迟消息](/messaging/3_rocketmq#_1、延迟消息-4-x-固定级别-vs-5-x-任意时间)；各类延迟方案的对比见 [延迟任务](/scenario/23_delay_task#五、以订单超时关单为例)。

---

## 六、监控

异步之后，失败不再表现为接口报错，而是「消息堆着没人处理」，所以上线时同步配好这几项：

| 指标 | 来源 | 告警条件 |
|------|------|---------|
| 各消费组堆积量、消费延迟 | 托管实例控制台 | 堆积超过 5000 条或延迟超过 5 分钟 |
| `t_outbox` 最老一条待发送记录的等待时长 | 应用定时查询，暴露为 `outbox.pending.age` | 超过 1 分钟 |
| `t_outbox` 失败记录数 | 同上 | 大于 0 |
| 死信消息数 | 托管实例控制台 | 大于 0（`notify-consumer` 除外） |

`outbox.pending.age` 涨说明中继或 Broker 出了问题，消费组堆积涨说明下游慢了，两者分开看就能定位到哪一段。堆积的排查思路（先看是全部还是个别队列、再看单条消息慢在哪）见 [MQ 消息积压](/handbook/2_incidents/12_mq_backlog)，原理见 [消息队列基础 · 消息积压](/messaging/1_basics#六、消息积压)。

---

## 七、代价与后续

| 本篇的决策 | 带来的问题 | 在哪解决 |
|-----------|-----------|---------|
| 积分、通知、发货单异步 | 最终一致：积分晚几秒到账，客服话术和前端文案要跟着改 | 已在本阶段处理，前端显示「积分发放中」 |
| 引入 RocketMQ | 多一个依赖；Broker 不可用时消息积在 `t_outbox`，恢复后补发，业务不受影响 | 托管实例的高可用，大促前做容量评估见「稳定性」 |
| `t_outbox`、`t_consume_record` 只在 mall-order 里 | 拆出去的服务也要可靠发消息、幂等消费 | [跨服务一致性](./7_consistency)：`payment-service`、`inventory-service` 各建一份 |
| 支付仍在 mall-order 本地事务里改订单 | 支付独立成服务后，「支付成功 → 订单待发货」跨了两个库 | [拆分服务](./6_split) 先同步调用过渡，[跨服务一致性](./7_consistency) 改用 `payment-succeeded` 消息 + 本地消息表 |
| 告警分散在控制台和应用里 | 堆积、失败、死信没有统一大盘 | 「可观测与发布」 |

---

## 小结

- 用户当场要结果、失败要让请求失败的保持同步，积分、通知、发货单、超时关单改为异步；支付回调只剩一个本地事务
- MQ 选 RocketMQ 5 托管实例，看中定时消息、内置重试与死信、按订单号查消息；不用顺序消息，不把下单异步化
- 写库与发消息用本地消息表 `t_outbox`：同一事务写入，提交后立即发送，每秒扫表兜底，`SKIP LOCKED` 避免两台机重复投递
- `order-paid` 由 `points-consumer`、`notify-consumer`、`shipment-consumer` 各自消费，幂等统一用 `t_consume_record`；外部调用按「先发后记」或下游幂等处理
- 超时关单改为 15 分钟定时消息加每 10 分钟的兜底扫描，关单一律用状态条件更新
- 监控看两段：`t_outbox` 待发送时长定位中继问题，消费组堆积定位下游问题，死信大于 0 就告警

---

## 参考资料

- Apache RocketMQ 文档 · 定时 / 延时消息：[https://rocketmq.apache.org/zh/docs/featureBehavior/02delaymessage](https://rocketmq.apache.org/zh/docs/featureBehavior/02delaymessage)
- Apache RocketMQ 文档 · 消费重试：[https://rocketmq.apache.org/zh/docs/featureBehavior/10consumerretrypolicy](https://rocketmq.apache.org/zh/docs/featureBehavior/10consumerretrypolicy)
- Apache RocketMQ Clients（rocketmq-client-java）：[https://github.com/apache/rocketmq-clients](https://github.com/apache/rocketmq-clients)
- Chris Richardson · Pattern: Transactional outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[拆分服务](./6_split) —— 从模块化单体拆出库存与支付服务，注册发现、网关与调用

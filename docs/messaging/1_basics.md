---
description: 解耦削峰异步、消息模型、可靠性三层保障、幂等消费、顺序消息、积压处置、重试与死信、本地消息表与事务消息
---

# 消息队列基础

消息中间件（MQ）是分布式系统的异步通信层，换来解耦与弹性，也带来重复、乱序、积压、一致性问题。本篇讲 MQ 的作用、消息模型，以及不丢、不重、有序、不积压的通用解法。

---

## 一、核心作用

这些是与具体产品无关的通用认知（含事务一致的解法），后面各篇的 Kafka / RocketMQ / RabbitMQ 本质都是在用不同机制回答这几个问题。

**MQ 的价值可以概括为三个词：解耦、削峰、异步。** 系统层面的削峰设计见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)。

![MQ 的三个核心作用](../assets/messaging/mq-roles.svg)

| 作用 | 解决的问题 | 典型场景 |
|------|-----------|---------|
| **应用解耦** | 上游直接调用下游，下游故障或新增下游都要改上游 | 订单完成后通知库存、积分、物流 |
| **流量削峰** | 突发流量超过后端处理能力，直接打垮 DB | 秒杀下单、整点活动 |
| **异步处理** | 主流程串行执行非核心操作，响应延迟高 | 注册后发邮件、推送、更新统计 |

引入 MQ 的代价同样明确：

- **系统复杂度**：多了一个需要高可用部署、监控、扩容的中间件
- **一致性问题**：上下游从同步调用变成最终一致，需要处理消息丢失、重复与事务边界
- **可观测性变差**：一次业务跨越多个异步环节，排查需要链路追踪与消息轨迹

---

## 二、消息模型

### 1、基本角色

| 角色 | 说明 |
|------|------|
| **Producer** | 生产者，发送消息 |
| **Broker** | 消息服务端，负责存储与投递 |
| **Topic / Queue** | 消息的逻辑分类；Topic 在物理上通常再分为多个分区（Kafka Partition）或队列（RocketMQ MessageQueue） |
| **Consumer Group** | 消费者组：组内多个实例**分摊**消息，不同组之间**各自完整**地消费一份 |
| **Offset / ACK** | 消费进度：Kafka、RocketMQ 记录位点，RabbitMQ 按单条消息确认 |

### 2、消息类型

| 模型 | 说明 | 典型应用 |
|------|------|---------|
| **点对点（P2P）** | 一条消息只被一个消费者处理 | 任务队列、订单处理 |
| **发布/订阅（Pub/Sub）** | 一条消息被每个订阅组各收到一份 | 事件通知、日志收集 |
| **顺序消息** | 同一业务 key 的消息按发送顺序消费 | 订单状态流转、账务流水 |
| **延迟 / 定时消息** | 消息在指定时间后才可被消费 | 订单超时取消、定时提醒 |
| **事务消息** | 本地事务结果决定消息是否投递 | 跨服务最终一致 |

> 「消费后删除」与「可回放」是存储模型的差异：Kafka、RocketMQ 按日志保留，消费不删除、可按位点回放；RabbitMQ 经典队列与仲裁队列在确认后删除，回放需要 Streams。

---

## 三、可靠性：三层保障

**消息不丢需要生产、存储、消费三个环节同时做到位，任何一环偷懒都会丢。**

| 环节 | 措施 | 要点 |
|------|------|------|
| **生产者** | 发送确认 + 重试 | 收到 Broker 确认（Kafka `acks=all`、RocketMQ 同步发送返回 `SEND_OK`、RabbitMQ Publisher Confirm）才算成功；失败重试，重试带来的重复交给幂等 |
| **Broker** | 持久化 + 多副本 | 落盘（同步 / 异步刷盘）并复制到多个副本；只确认已同步到足够副本的写入（如 Kafka `min.insync.replicas`、RabbitMQ 仲裁队列多数派） |
| **消费者** | 处理成功后再确认 | 关闭自动提交 / 自动 ACK，**业务处理成功后**再提交位点或 ACK；失败则不确认或抛异常，交给重试机制 |

三层都做到之后，能得到的语义是**至少一次（At Least Once）**：

| 语义 | 含义 | 实现方式 |
|------|------|---------|
| 最多一次 | 可能丢，不会重 | 先确认再处理 |
| **至少一次** | 不会丢，可能重 | 处理成功再确认（**业务系统的默认选择**） |
| 恰好一次 | 不丢不重 | 至少一次 + 幂等消费；Kafka 事务的 Exactly Once 只覆盖 Kafka 内部的「读-处理-写」 |

因此**幂等消费不是可选项，而是可靠投递的另一半**。

---

## 四、幂等消费

生产者重试、消费者处理成功但确认失败、Rebalance 后位点回退，都会让同一条消息被投递多次。业务层要保证**同一消息处理多次与处理一次效果相同**，通用方案见 [系统架构 · 幂等设计](/architecture/5_idempotence)，这里只讲消费端的两种正确写法。

::: warning 常见错误：「SETNX 占位成功 → 直接处理」
先写「已消费」标记再处理业务，一旦业务失败或进程崩溃，重投的消息会因为标记已存在被直接跳过——**消息就这样丢了**。去重标记必须与业务结果绑定，而不是先于业务写入。
:::

**去重键优先用业务键**（订单号 + 动作类型），而不是 Broker 的 msgId：生产者重试发出的两条消息 msgId 可能不同，业务键才真正代表「同一件事」。

### 1、方案一：去重记录与业务写入在同一个本地事务（首选）

```sql
CREATE TABLE t_consume_record (
  biz_key    VARCHAR(64) NOT NULL,   -- 业务键，如订单号
  consumer   VARCHAR(64) NOT NULL,   -- 消费方，如 points
  created_at DATETIME    NOT NULL,
  PRIMARY KEY (biz_key, consumer)
);
```

```java
@Transactional(rollbackFor = Exception.class)
public void onOrderPaid(OrderPaidEvent evt) {
    try {
        consumeRecordMapper.insert(evt.getOrderNo(), "points");   // 唯一键兜底
    } catch (DuplicateKeyException e) {
        return;                                                   // 已处理过：直接确认消息
    }
    pointsService.addPoints(evt.getUserId(), evt.getAmount());    // 与去重记录同事务提交
}
```

- 业务失败 → 整个事务回滚，去重记录也不存在，重投时可以再次处理
- 并发重复投递 → 后到的事务在唯一键上等待，前者提交后它得到冲突，自然跳过
- 适用于消费结果落在**同一个数据库**的场景，资金、库存类业务首选
- 上例按 MySQL 写法：唯一键冲突不会中止事务；PostgreSQL 中语句报错会使整个事务失效，应改用 `INSERT ... ON CONFLICT DO NOTHING` 并按影响行数判断

### 2、方案二：Redis 状态机（处理中 / 已完成）

当业务结果不在同一个库，或需要在 DB 之前挡住大量重复时，用带状态的占位，而不是「占位即完成」：

```java
String key = "consume:points:" + evt.getOrderNo();
Boolean first = redis.opsForValue()
        .setIfAbsent(key, "PROCESSING", Duration.ofMinutes(5));  // TTL 大于最长处理时间

if (!Boolean.TRUE.equals(first)) {
    if ("DONE".equals(redis.opsForValue().get(key))) {
        return;                                    // 已完成：确认消息
    }
    throw new RetryLaterException("消息处理中");    // 处理中：不确认，稍后重投
}
try {
    pointsService.addPoints(evt.getUserId(), evt.getAmount());
    redis.opsForValue().set(key, "DONE", Duration.ofDays(7));
} catch (Exception e) {
    redis.delete(key);                             // 释放占位，让重投可以重新处理
    throw e;
}
```

- 看到 `PROCESSING` 时**不能确认后跳过**，只能抛错 / 退避等待重投，否则前一个处理若失败，这条消息就丢了
- Redis 与业务库不是原子的：业务已提交但 `DONE` 没写成功时，占位过期后会再处理一次，所以业务操作本身仍需具备幂等能力（如更新带状态条件），或在关键链路改用方案一
- `DONE` 的保留时间要覆盖消息可能被重投的最长时间窗口

---

## 五、顺序消息

**MQ 只能保证分区（队列）内有序，全局有序代价极高。** 实践中要的是「同一业务 key 有序」，做法是三点：

| 环节 | 做法 |
|------|------|
| **生产端路由** | 按业务 key（如订单号）选择分区：Kafka 指定消息 key、RocketMQ 4.x 用 `MessageQueueSelector`、RocketMQ 5.x 设置 MessageGroup |
| **生产端不乱序** | 同一 key 串行发送；Kafka 开启幂等生产者（3.0 起默认开启），重试时不会因多个 in-flight 请求造成乱序 |
| **消费端单线程** | 一个分区同一时刻只由一个线程顺序处理；Kafka 的分区消费本就是单线程拉取，**乱序往往来自消费端把消息丢进线程池异步处理** |

常见的破坏顺序的情况：

- 消费者把消息提交到线程池并发执行，或处理失败后跳过当前消息继续往下
- 扩容分区后 key 的哈希路由变化，扩容瞬间新旧分区中同一 key 的消息并存
- 全局只用一个分区追求「全局有序」——吞吐被限制在单分区单线程，一般不可取

**热点 key 问题**：顺序消费要求同 key 串行，若某个 key 消息量极大（如大商户、热门直播间），它所在的分区会成为瓶颈，其他分区空闲。应对思路：

- **细化 key**：只在真正需要有序的粒度上保序（订单级而非商户级）
- **消费端按 key 分桶**：一个分区内的消息按 key 哈希到 N 个单线程执行器，不同 key 并行、同 key 串行；代价是位点提交要等前面的消息都处理完，实现复杂
- **拆分业务**：把热点流量拆到独立 Topic，单独扩容

---

## 六、消息积压

积压 = 生产速度持续大于消费速度。先止血，再找根因。

**排查清单：**

1. 看监控：积压量（Lag）是**突增**还是**持续缓慢增长**，从什么时间开始
2. 对比生产 TPS 与消费 TPS：是上游流量突增，还是消费能力下降
3. 检查消费者实例：是否宕机、频繁 Rebalance、线程被阻塞（`jstack` 看是否卡在下游调用或锁上）
4. 检查下游依赖：DB 慢查询、第三方接口超时、连接池耗尽
5. 检查是否有「毒丸消息」：某条消息反复失败、反复重试，堵住了整个分区

**处置清单：**

1. **扩消费者**：在按分区 / 队列分配的模型下（Kafka 消费组、RocketMQ 4.x 集群消费），实例数超过分区数的部分会空闲，需要同时扩分区
2. **提升单实例吞吐**：批量拉取、批量写库，优化慢 SQL 与外部调用
3. **临时扩容转发**：消费者只做转发，把消息搬到一个分区更多的临时 Topic，再用更多实例消费
4. **隔离毒丸消息**：失败超过上限的消息转入死信，不让它阻塞后续消息
5. **降级非核心消费**：暂停统计类等非关键消费组，把资源让给核心链路
6. **事后复盘**：按峰值评估消费能力与分区数，配置 Lag 告警

---

## 七、重试与死信

**消费失败不能无限原地重试，也不能直接丢弃，标准做法是「退避重试 + 死信兜底」。**

![消费重试与死信队列](../assets/messaging/mq-retry-dlq.svg)

| MQ | 重试机制 | 死信 |
|------|---------|------|
| **Kafka** | 位点是累积提交的，「不确认」不会触发重投；Spring Kafka 中抛出异常 → `DefaultErrorHandler` 按退避策略重试 | 重试耗尽后由 `DeadLetterPublishingRecoverer` 发到死信 Topic（默认 `<topic>.DLT`、同分区号，死信 Topic 分区数不能少于原 Topic） |
| **RocketMQ** | 消费返回失败或抛异常，Broker 按递增间隔重新投递（4.x 经由 `%RETRY%<ConsumerGroup>` 重试主题） | 超过最大重试次数进入 `%DLQ%<ConsumerGroup>` |
| **RabbitMQ** | `basicNack` / `basicReject` 重回队列（立即重投、无退避），退避需借助 TTL + DLX 或延迟交换机插件 | 拒绝且不重回队列、TTL 过期、超过仲裁队列 `delivery-limit` 时路由到死信交换机（DLX） |

几条实践原则：

- **区分可重试与不可重试异常**：网络超时值得重试，参数校验失败、反序列化失败重试也没用，应直接进死信
- **重试间隔递增**：避免下游故障时重试风暴
- **死信必须有人管**：配置告警、提供查询与重投工具，修复问题后重新投递或人工补偿
- 重试意味着重复投递，**再次强调消费幂等**

---

## 八、分布式事务中的消息

典型诉求：订单状态改为「已支付」，同时通知积分、物流服务。难点在于**数据库提交与消息发送是两个系统，无法放进同一个事务**：

- 先发消息再提交：消息发出后事务回滚，下游收到了一条「不存在」的事件
- 在事务中发消息：发送成功但提交失败，同上；发送超时还会拉长事务、占住连接
- 先提交再发消息：提交后进程崩溃或发送失败，消息丢失

所以**不要把「在 DB 事务里发 MQ」当作一致性方案**。可选的正确做法：

### 1、本地消息表（Transactional Outbox）

![本地消息表（Transactional Outbox）](../assets/messaging/mq-outbox.svg)

1. 在同一个本地事务里写业务表和消息表（状态 `NEW`），两者同时成功或同时失败
2. 投递任务扫描 `NEW` 状态的消息发送到 MQ，成功后标记为 `SENT`；失败则累加重试次数下次再发
3. 消费端幂等，因为投递任务可能重复发送

投递任务可以是定时轮询（多实例时用 `SELECT ... FOR UPDATE SKIP LOCKED`（MySQL 8.0+ / PostgreSQL）或分片避免重复扫描），也可以用 CDC 订阅 binlog 推送，见 [CDC 工具](/database/5_practice/0_cdc_tools)。它不依赖 MQ 的特殊能力，任何 MQ 都能用。

### 2、事务消息（RocketMQ）

RocketMQ 把「本地事务 + 发消息」做成了两阶段：先发**半消息**（消费者不可见）→ 执行本地事务 → 根据结果提交或回滚半消息；若 Broker 长时间收不到结果，会**回查**生产者的本地事务状态；回查时本地事务仍未有结论可返回 `UNKNOWN`，Broker 稍后继续回查，超过回查上限后按配置丢弃半消息。效果与本地消息表一致，但省去了消息表与投递任务，代价是绑定 RocketMQ，且要实现回查接口。

> Kafka 也有「事务」，但它保证的是多条消息写入多个分区的原子性（以及「消费-处理-生产」的 Exactly Once），**无法与数据库事务绑定**，不能替代本地消息表。

### 3、提交后发送（弱保证）

对一致性要求不高的通知类消息，可以在事务提交后再发：

```java
@Transactional
public void pay(String orderNo) {
    orderMapper.markPaid(orderNo);
    eventPublisher.publishEvent(new OrderPaidEvent(orderNo));   // 只是登记，事务提交后才触发
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onPaid(OrderPaidEvent evt) {
    kafkaTemplate.send("order-paid", evt.getOrderNo(), evt)       // spring-kafka 3.x 返回 CompletableFuture
            .whenComplete((r, ex) -> { if (ex != null) log.error("发送失败", ex); });
}
```

它避免了「事务回滚但消息已发出」，但**提交后到发送前进程崩溃、或异步发送失败，消息仍会丢**——需要可靠性的场景仍应使用本地消息表。另外 `@TransactionalEventListener` 只在有活动事务时生效，没有事务时事件默认被丢弃（除非设置 `fallbackExecution = true`）。

### 4、方案对比

| 方案 | 一致性 | 侵入性 | 适用场景 |
|------|-------|-------|---------|
| **本地消息表 / Outbox** | 最终一致，可靠 | 需要消息表与投递任务 | 通用首选，不绑定 MQ |
| **事务消息** | 最终一致，可靠 | 实现回查接口，绑定 RocketMQ | 已使用 RocketMQ 的核心链路 |
| **最大努力通知** | 尽力而为，按策略重试有限次数，提供对账查询兜底 | 低 | 跨企业回调，如支付结果通知 |
| **提交后发送** | 可能丢 | 最低 | 非关键通知 |

TCC、Saga 等完整的分布式事务方案见 [分布式 · 分布式事务](/distributed/4_transaction)。

---

## 小结

- MQ 用**解耦、削峰、异步**换来弹性，代价是引入重复、乱序、积压与一致性问题
- 不丢消息要三层配合：**生产确认 + Broker 持久化多副本 + 消费成功后再确认**，得到的是至少一次语义
- 幂等消费是可靠投递的另一半：**去重记录与业务同事务**最稳；用 Redis 时要区分「处理中」和「已完成」，失败要释放占位
- 顺序靠**分区键路由 + 单分区单线程**，乱序多来自消费端异步处理；热点 key 要细化 key 或按 key 分桶
- 积压先扩容、隔离毒丸、降级止血，再查消费能力与下游瓶颈
- 失败走**退避重试 + 死信**；跨库一致性用**本地消息表或事务消息**，不要在 DB 事务里直接发消息

## 参考资料

- 消息模型与通道模式：[Enterprise Integration Patterns: Messaging Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/)
- Kafka 投递语义：[Kafka Documentation: Message Delivery Semantics](https://kafka.apache.org/documentation/#semantics)
- RabbitMQ 可靠性（确认、持久化）：[RabbitMQ: Reliability Guide](https://www.rabbitmq.com/docs/reliability)
- RabbitMQ 死信：[RabbitMQ: Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx)
- RocketMQ 事务消息：[RocketMQ: Transaction Message](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- 本地消息表（事务发件箱）：[Pattern: Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[Kafka](./2_kafka) —— 以分区日志为核心的事件流平台，看它如何把吞吐、持久化与回放做到极致。

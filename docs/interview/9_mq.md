---
description: MQ 场景与选型、不丢消息与幂等、顺序消息、零拷贝与积压、事务消息与本地消息表、高可用
---

# 开发总结 - 消息队列

> 精华提炼，细节详见 [消息队列总览](/messaging/0_overview)；题目清单见 [消息队列面试题](/messaging/99_interview)，本页按清单的分组与顺序作答。
> 版本基线：Kafka 4.x、RocketMQ 5.x（兼顾 4.x）、RabbitMQ 4.x。

## 一、MQ 基础

### Q1：消息队列有哪些使用场景？（异步解耦、削峰填谷、广播通知）

**核心结论**：MQ 的价值是**解耦、削峰、异步**，代价是引入重复、乱序、积压与一致性四类新问题。

![MQ 的三个核心作用](../assets/messaging/mq-roles.svg)

| 场景 | 解决的问题 | 典型例子 |
|------|-----------|---------|
| 应用解耦 | 上游直接调下游，下游故障或新增下游都要改上游 | 订单完成后通知库存、积分、物流 |
| 削峰填谷 | 突发流量超过后端处理能力 | 秒杀下单先入队，后端按能力消费 |
| 异步处理 | 非核心操作串行执行拖慢主流程 | 注册后发邮件、推送、更新统计 |
| 广播通知 | 一份事件多个系统各自处理 | 发布/订阅：每个消费者组各收一份 |
| 数据管道 | 日志、埋点、CDC 汇聚到下游 | Kafka + Flink / Connect |

- 代价：多一个要高可用部署的中间件；上下游从同步调用变为最终一致；链路排查需要消息轨迹与链路追踪
- 系统级的削峰设计见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)

→ 详见 [消息队列基础](/messaging/1_basics)

### Q2：消息队列的核心工作流程是什么？（Producer → Broker → Consumer）

**核心结论**：生产者把消息发给 Broker 并等待确认 → Broker 持久化并复制到副本 → 消费者拉取（或被推送）消息、处理成功后提交位点或 ACK。每一步都有"确认"，可靠性就建立在这三次确认上。

| 步骤 | 做什么 | 关键点 |
|------|-------|-------|
| 1. 发送 | Producer 按 Topic（及分区键）发送 | 收到 Broker 确认才算成功，失败重试 |
| 2. 存储 | Broker 写入日志 / 队列，刷盘并复制 | 只确认已同步到足够副本的写入 |
| 3. 投递 | Consumer Group 内实例分摊分区 / 队列 | 组内分摊、组间各自完整消费 |
| 4. 确认 | 处理成功后提交 offset 或 ACK | Kafka / RocketMQ 记录位点，RabbitMQ 按单条确认 |
| 5. 失败 | 退避重试，超过上限进死信 | 重试带来重复，消费端必须幂等 |

- **消费后是否删除**是存储模型的差异：Kafka、RocketMQ 按日志保留、可按位点回放；RabbitMQ 经典 / 仲裁队列确认后删除，回放要用 Stream

→ 详见 [消息队列基础](/messaging/1_basics)

### Q3：Kafka、RocketMQ、RabbitMQ 的对比？各自适合什么场景？

**核心结论**：Kafka 是**事件流平台**（日志即存储），RocketMQ 是**业务消息中间件**（事务、定时、重试开箱即用），RabbitMQ 是**灵活路由的消息代理**。选型先看语义硬需求，再看量级，最后看团队与生态。

| 维度 | Kafka 4.x | RocketMQ 5.x | RabbitMQ 4.x |
|------|-----------|--------------|--------------|
| 吞吐（相对） | 最高 | 高 | 中 |
| 顺序 | 分区内有序 | 队列内有序（5.x 按 MessageGroup） | 单队列 + 单活消费者 |
| 事务 | 跨分区原子写 + EOS，**不是**半消息 | 原生事务消息（半消息 + 回查） | 无事务消息 |
| 延迟消息 | 不原生支持 | 5.x 任意时间（4.x 为 18 级） | TTL + DLX 或延迟插件 |
| 回放 | 重置 offset | 重置消费位点 | 仅 Stream 支持 |
| 死信 | 无内置，Spring 用 DLT | 内置重试队列 + 死信队列 | 内置 DLX |
| 高可用 | ISR 副本，元数据 KRaft | 主从 / DLedger，5.x Controller | 仲裁队列（Raft） |
| 典型场景 | 日志、埋点、数据管道、事件溯源 | 订单、支付、库存等核心链路 | 业务解耦、复杂路由、中低并发通知 |

- 吞吐只看量级关系，具体数字取决于消息大小、批量、刷盘与副本策略，不要拿网上的"百万 / 十万 / 万"直接下结论
- Kafka 4.x 正在引入共享组（KIP-932，队列式按条确认的消费语义），目前仍应视为预览特性，不宜据此替代 RabbitMQ / RocketMQ 选型
- 已在公有云上时，托管版的运维成本往往比引擎差异更重要；同一公司尽量收敛到一到两种 MQ

→ 详见 [MQ 选型](/messaging/6_selection)

### Q4：RocketMQ 5.x 相比 4.x 有哪些主要变化？

**核心结论**：5.x 是架构演进而不是小版本升级——引入**无状态 Proxy + gRPC** 与轻量多语言客户端，补上了**任意时间定时消息**、**POP 消费**和 **Controller 自动切主**；Remoting 协议仍兼容，老客户端可以继续连。

| 维度 | 4.x | 5.x |
|------|-----|-----|
| 接入 | Remoting 协议，客户端直连 Broker | 新增 Proxy + gRPC，客户端连 Proxy |
| 客户端 | `rocketmq-client`（重客户端，负载均衡在客户端） | `rocketmq-client-java`（轻客户端，多语言统一） |
| 顺序消息 | 按 hashKey 选 MessageQueue | FIFO 类型 Topic + **MessageGroup** 组内有序 |
| 延迟消息 | 18 个固定级别，最长 2h | 定时消息：任意投递时间戳（上限由 Broker 配置） |
| 消费方式 | Push / Pull，按队列分配 | 新增 POP：Broker 按消息分配，消费者数可超过队列数 |
| 高可用 | 主从复制 / DLedger（Raft） | 新增 Controller 模式：在同步副本中自动选主 |
| Topic 类型 | 不区分 | 可声明 `message.type`（NORMAL / FIFO / DELAY / TRANSACTION），开启 Broker 类型校验时发送类型须与之一致 |

- `rocketmq-spring-boot-starter` 2.3.x 仍是 Remoting 经典客户端，可连 5.x Broker 并使用按秒 / 毫秒 / 时间点的定时发送，但不经过 gRPC Proxy

→ 详见 [RocketMQ](/messaging/3_rocketmq)

### Q5：RabbitMQ 延迟消息有哪几种实现方式？各有什么坑？

**核心结论**：两种——**TTL + 死信交换机**（无需插件，但逐条 TTL 有队头阻塞）和**延迟消息插件**（每条任意延迟，但单节点存储、不复制）。大量、任意时间、强可靠的延迟需求更适合 RocketMQ 5.x 定时消息或"数据库 + 定时扫描"。

![TTL + DLX 延迟消息](../assets/messaging/rabbitmq-delay-ttl-dlx.svg)

| 对比 | TTL + DLX | 延迟插件 `x-delayed-message` |
|------|-----------|-----------------------------|
| 原理 | 消息在无消费者的队列中过期 → 变死信 → DLX 转发到真正消费的队列 | 消息先存在插件内部，到期才路由到队列 |
| 精度 | 队列级 TTL 准确；逐条 TTL 只在到达队头时才检查过期 | 每条任意延迟，较准确 |
| 可靠性 | 延迟队列可用 Quorum，多副本 | 延迟中的消息**单节点存储、不复制**，节点数据丢失即丢 |
| 坑 | 同一队列混用不同逐条 TTL → 短延迟被长延迟堵住 | 不适合百万级或超长延迟；禁用插件丢掉未到期消息；不支持 `mandatory`（发布时就可能收到 Returns 回调，需过滤），到期时的路由失败无法回调 |
| 做法 | **一个延迟时长一个队列**（如 10s / 1min / 30min 三档） | 升级大版本前确认插件兼容性 |

- 延迟消息只能触发"检查"：超时关单要先确认订单仍是"待支付"再取消（带状态条件更新），否则会误关已支付订单

→ 详见 [RabbitMQ](/messaging/4_rabbitmq)

## 二、消息可靠性

### Q6：如何保证消息不丢失？（生产确认 + 持久化 + 消费 ACK）

**核心结论**：生产、存储、消费三个环节同时设防，任何一环偷懒都会丢。三层都做到后得到的是**至少一次**语义，所以幂等消费是可靠投递的另一半。

| 环节 | Kafka | RocketMQ | RabbitMQ |
|------|-------|----------|----------|
| 生产者 | `acks=all` + 幂等生产者（默认开启），用 `delivery.timeout.ms` 控制重试总时长 | `syncSend` 并检查 `SEND_OK`，失败重试 | Publisher Confirm + Returns（`mandatory=true`） |
| Broker | `replication.factor=3` + `min.insync.replicas=2` + 禁止 unclean 选举 | 同步复制（或 Controller 模式）+ 视要求同步刷盘 | durable + 持久化消息 + **Quorum 队列** |
| 消费者 | 关闭自动提交，处理成功后提交 offset，失败抛异常 | 处理完成才正常返回，不要异步处理后直接返回 | 处理成功后 ack，失败有限重试 + DLX |

- **发送失败不能靠回调补救来保证一致**：进程可能在回调前崩溃，业务库与消息需要一致时用本地消息表（见 Q18）
- Kafka 的持久性来自多副本而不是每条 fsync，不建议强制刷盘参数
- 三种投递语义：先确认再处理 = 最多一次；处理成功再确认 = **至少一次（业务默认）**；恰好一次 = 至少一次 + 幂等

→ 详见 [消息队列基础](/messaging/1_basics)、[Kafka](/messaging/2_kafka)

### Q7：RocketMQ 的同步刷盘和异步刷盘有什么区别？

**核心结论**：同步刷盘等消息刷到磁盘才返回，可靠但吞吐明显下降；异步刷盘（默认）写入 PageCache 即返回，机器断电可能丢最近一小段。生产上更常见的是**异步刷盘 + 同步复制**，单机断电丢的数据由副本兜底。

| 刷盘方式 | 配置 | 返回时机 | 特点 |
|---------|------|---------|------|
| 异步刷盘（默认） | `flushDiskType=ASYNC_FLUSH` | 写入 PageCache | 性能高；宕机 / 断电可能丢未刷盘数据 |
| 同步刷盘 | `flushDiskType=SYNC_FLUSH` | 刷盘完成 | 可靠性最高；吞吐明显下降 |

- 刷盘管的是**单机**持久化，复制管的是**多机**冗余：`SYNC_MASTER` 等 Slave 确认才返回，`ASYNC_MASTER` 延迟低但宕机可能丢少量未复制消息
- 生产者收到 `FLUSH_DISK_TIMEOUT` / `FLUSH_SLAVE_TIMEOUT` / `SLAVE_NOT_AVAILABLE` 时，消息已到 Broker 但没达到配置的刷盘或复制要求，关键消息需告警或补偿

→ 详见 [RocketMQ](/messaging/3_rocketmq)

### Q8：Kafka 的 ISR 机制是什么？如何保证数据不丢失？

**核心结论**：ISR（In-Sync Replicas）是**跟上 Leader 的副本集合**；`acks=all` 时 Leader 要等 ISR 内全部副本写入才确认，Leader 故障只从 ISR 中选新 Leader，所以已确认的消息不会丢。

| 概念 | 说明 |
|------|------|
| ISR | 与 Leader 保持同步的副本；落后超过 `replica.lag.time.max.ms` 的 Follower 被移出，追上后再加入 |
| LEO | 副本日志末尾的下一个 offset |
| HW | ISR 都已复制到的位置，消费者只能读到 HW 之前的消息 |

不丢消息的配置组合：

```properties
# Broker / Topic
default.replication.factor=3
min.insync.replicas=2                 # ISR 不足 2 时 acks=all 的写入直接失败，而不是悄悄写成单副本
unclean.leader.election.enable=false  # 默认 false：不让 ISR 之外的落后副本当 Leader
# Producer
acks=all                              # 3.0+ 默认
enable.idempotence=true               # 3.0+ 默认，retries 默认 Integer.MAX_VALUE，由 delivery.timeout.ms 控制总时长
```

- `replication.factor=3` + `min.insync.replicas=2`：允许 1 个副本故障仍可写，ISR 不足时生产者收到 `NotEnoughReplicas`
- 不要把 `retries` 调小：只会让 Leader 切换、网络闪断这类可自动恢复的抖动变成发送失败
- 消费端关闭自动提交，处理成功后再提交 offset

→ 详见 [Kafka](/messaging/2_kafka)

### Q9：消息幂等性（重复消费）如何保证？（业务键去重：去重记录与业务写入同一本地事务 / Redis 状态机）

**核心结论**：生产者重试、确认丢失、Rebalance 后位点回退都会重复投递，任何 MQ 都只保证至少一次，消费端必须幂等。**去重标记必须与业务结果绑定**：首选"去重记录 + 业务写入同一个本地事务"；用 Redis 时要做成"处理中 / 已完成"状态机，失败释放占位。

> [!warning] 错误做法：SETNX 占位成功后直接处理
> 先写"已消费"标记再处理业务，业务失败或进程崩溃后，重投的消息因为标记已存在被跳过——**消息就丢了**。

**方案一：去重记录与业务写入同一事务（首选）**

```java
@Transactional(rollbackFor = Exception.class)
public void onOrderPaid(OrderPaidEvent evt) {
    // t_consume_record 主键 (biz_key, consumer)；MySQL INSERT IGNORE / PostgreSQL ON CONFLICT DO NOTHING
    if (consumeRecordMapper.insertIgnore(evt.getOrderNo(), "points") == 0) {
        return;                                                // 已处理过：正常返回，消息被确认
    }
    pointsService.addPoints(evt.getUserId(), evt.getAmount()); // 失败抛异常 → 去重记录一起回滚 → 重投可再处理
}
```

**方案二：Redis 状态机（业务结果不在同一个库时）**

1. `SET consume:{bizKey} PROCESSING NX EX <大于最长处理时间>`，成功才开始处理
2. 处理成功后置为 `DONE`，保留时间覆盖可能重投的窗口
3. 处理失败时 `DEL` 再抛异常，让重投能重新处理
4. 抢占失败时读值：`DONE` 直接确认；`PROCESSING` 说明别的实例正在处理，**抛异常退避重试，不能确认后跳过**

| 要点 | 说明 |
|------|------|
| 去重键 | 优先业务键（订单号 + 动作类型），不用 Broker msgId 或 Kafka `partition + offset`：生产者重发的同一事件 msgId / offset 都会变 |
| Redis 的局限 | Redis 与业务库不是原子的：业务已提交但 `DONE` 没写成功，占位过期后会再处理一次，业务操作本身仍需带状态条件 |
| 兜底 | 资金、库存类业务用方案一；更新语句带状态条件（`WHERE status = 'UNPAID'`）也是天然幂等 |

- 通用幂等方案见 [系统架构 · 幂等设计](/architecture/5_idempotence)

→ 详见 [消息队列基础](/messaging/1_basics)

### Q10：Kafka 消费失败时为什么可能"跳过"消息？如何正确重试？

**核心结论**：Kafka 按分区只记录**一个累计的 offset**，提交 N 表示 N 之前全部处理完毕。第 5 条失败不 ack、第 6 条成功并提交，第 5 条就被一起确认了——**"不 ack 等重投"在 Kafka 里不成立**。正确做法是**抛异常 → `DefaultErrorHandler` 原地退避重试 → 耗尽后 `DeadLetterPublishingRecoverer` 发死信 Topic → 提交 offset 继续**。

常见的"跳过"原因：

| 原因 | 结果 |
|------|------|
| 自动提交（`enable.auto.commit=true`） | 到时间就提交，处理失败或崩溃时消息被跳过 |
| 监听方法 catch 住异常只打日志 | 容器认为成功，提交 offset |
| 失败的消息不 ack，后续消息 ack | 累计提交把失败的那条一起确认 |
| 只配了 `DefaultErrorHandler` 没配恢复器 | 默认重试 9 次（共 10 次投递、无退避）后**只打日志并跳过** |

```java
@Bean
public DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    // 重试耗尽后发到 <topic>.DLT 的同一分区（死信 Topic 分区数不能少于原 Topic）
    DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(template);
    ExponentialBackOffWithMaxRetries backOff = new ExponentialBackOffWithMaxRetries(4); // 1s、2s、4s、8s
    backOff.setInitialInterval(1000);
    backOff.setMultiplier(2.0);
    DefaultErrorHandler handler = new DefaultErrorHandler(recoverer, backOff);
    handler.addNotRetryableExceptions(JsonProcessingException.class, IllegalArgumentException.class);
    return handler;   // Boot 自动装配到监听容器工厂
}
```

![消费重试与死信队列](../assets/messaging/mq-retry-dlq.svg)

- **阻塞重试**：seek 回失败位置再拉取，分区内顺序不乱；退避期间该分区停止前进，退避总时长要结合 `max.poll.interval.ms` 评估，过长可能触发 Rebalance
- **非阻塞重试**：`@RetryableTopic` 把失败消息转到重试 Topic，主分区不被卡住，代价是同 key 可能乱序
- 区分可重试（超时）与不可重试（参数校验、反序列化失败）异常；DLT 要有告警和重放工具
- 重试意味着重复投递，消费端仍要按 Q9 做幂等

→ 详见 [Kafka](/messaging/2_kafka)

## 三、消息顺序

### Q11：如何保证消息的顺序消费？

**核心结论**：MQ 只保证**分区（队列）内有序**，实践中要的是"同一业务 key 有序"：**生产端按 key 路由到同一分区 + 生产端不乱序 + 消费端单分区串行处理**。全局有序只能单分区，吞吐被锁死，一般不可取。

| 环节 | 做法 |
|------|------|
| 生产端路由 | Kafka 指定消息 key；RocketMQ 4.x `MessageQueueSelector` / `syncSendOrderly`；5.x 设置 MessageGroup；RabbitMQ 同 key 路由到同一队列 |
| 生产端不乱序 | 同一 key 同步串行发送；Kafka 保持幂等生产者开启 |
| 消费端串行 | 一个分区同一时刻只由一个线程处理；RabbitMQ 用 `x-single-active-consumer` |

破坏顺序的常见情况：

- 消费者把消息丢进线程池异步处理（最常见）；确需并行时按 key 哈希到固定的单线程执行器
- 处理失败后跳过当前消息继续往下，或用非阻塞重试 / 死信重放
- 扩分区后 `hash(key) % 分区数` 变化，扩容瞬间新旧分区里同一 key 的消息并存
- **热点 key**：同 key 必须串行，大商户、热门直播间会让单分区成为瓶颈——细化 key 粒度、消费端按 key 分桶，或拆独立 Topic

→ 详见 [消息队列基础](/messaging/1_basics)

### Q12：RocketMQ 如何实现顺序消息？（MessageGroup + FIFO 队列）

**核心结论**：4.x 靠"**同一 hashKey 选同一个 MessageQueue + 顺序消费模式锁队列串行**"；5.x 新 SDK 把 Topic 声明为 **FIFO 类型**、发送时设置 **MessageGroup**，同组内有序、不同组并行。

| 版本 | 生产端 | 消费端 |
|------|-------|-------|
| 4.x / starter | `syncSendOrderly(topic, payload, hashKey)` | `consumeMode = ConsumeMode.ORDERLY`，同一队列同一时刻只由一个线程处理 |
| 5.x 新 SDK | FIFO Topic + `MessageGroup`（如订单号） | 消费者组开启顺序投递 |

- 生产端必须**同步发送**，异步并发发送会打乱顺序
- 顺序消费失败时**不发回 Broker**，在本地挂起后重试同一条，整个队列停住等它；未配置 `maxReconsumeTimes` 时近乎无限重试，**务必设上限**，否则一条毒消息永久卡住队列
- 顺序消费同样需要幂等

→ 详见 [RocketMQ](/messaging/3_rocketmq)

### Q13：Kafka 如何保证分区内有序？跨分区能保证顺序吗？

**核心结论**：分区是只追加的日志，写入有序、按 offset 顺序读取，一个分区在组内只分配给一个消费者线程，所以**分区内天然有序**；**跨分区不保证顺序**，需要有序的消息用同一个 key 发送到同一分区。

```java
kafkaTemplate.send("order-events", orderId.toString(), payload);   // key = orderId
```

- 消费端**不需要 `concurrency=1`**：每个分区始终只由一个线程串行处理，`concurrency=3` 只是不同分区之间并行
- 生产端重试乱序只发生在**关闭幂等**且 `max.in.flight.requests.per.connection > 1` 时；幂等生产者（3.0+ 默认）在 in-flight ≤ 5 时保持分区内顺序
- key 为空时按粘性策略分散到各分区；扩分区会改变 key 的映射；`@RetryableTopic` 非阻塞重试会让后续消息先被处理
- 全局有序只能单分区，吞吐锁定在单分区的处理能力

→ 详见 [Kafka](/messaging/2_kafka)

## 四、高性能

### Q14：消息队列如何实现高效读写？（零拷贝 MMap/SendFile、顺序写入、PageCache）

**核心结论**：**顺序追加写**把磁盘随机 IO 变成顺序 IO，**PageCache** 让读写都先走内存，**零拷贝**减少数据在内核态与用户态之间的拷贝和上下文切换。RocketMQ 用 **mmap** 读写 CommitLog，Kafka 消费时用 **sendfile** 直接把 PageCache 送到网卡。

| 方式 | 拷贝次数 | 上下文切换 | 谁在用 |
|------|---------|-----------|-------|
| 传统 `read` + `write` | 4 次（2 次 DMA + 2 次 CPU） | 4 次 | — |
| `mmap` + `write` | 3 次（2 次 DMA + 1 次 CPU） | 4 次 | RocketMQ（`MappedByteBuffer`） |
| `sendfile`（支持 SG-DMA） | 2 次（均为 DMA） | 2 次 | Kafka（`FileChannel.transferTo`） |

![mmap + write 数据路径](../assets/messaging/zero-copy-mmap.svg)

![sendfile 数据路径](../assets/messaging/zero-copy-sendfile.svg)

- **mmap**：进程可直接读写映射内存，适合小块消息的随机读写；Java 单次映射上限 2GB，CommitLog 单文件默认 1GB
- **sendfile**：数据完全不进用户态，Broker 无法加工内容；**开启 TLS 后必须在用户态加密，sendfile 失效**，CPU 开销明显上升
- **顺序写**：Kafka 每个分区一组分段日志；RocketMQ 所有 Topic 共用一个 CommitLog，Topic 再多也是单文件顺序写，ConsumeQueue 只存定长索引
- **PageCache**：不占 JVM 堆，刚写入的数据通常直接从缓存读到；持久性靠副本，而不是每条 fsync
- 应用层（Netty `CompositeByteBuf`、`FileRegion`）的零拷贝是另一层概念，见 [Netty · ByteBuf 与内存管理](/netty/5_bytebuf)

→ 详见 [Kafka](/messaging/2_kafka)、[RocketMQ](/messaging/3_rocketmq)

### Q15：Kafka 为什么吞吐量这么高？

**核心结论**：Kafka 把自己做成了一个**分区化的顺序日志**：写是顺序追加、读走 PageCache 和 sendfile，网络和磁盘上都按**批**处理，再用**分区**把负载摊到多台 Broker。

| 机制 | 说明 |
|------|------|
| 顺序追加写 | 消息追加到分段日志文件，顺序 IO 远快于随机 IO |
| PageCache | 读写走操作系统页缓存，不占 JVM 堆，避免 GC 压力 |
| 零拷贝 sendfile | 消费时数据从 PageCache 直接送网卡，不经过用户态 |
| 批量与压缩 | 生产者按分区攒批（`batch.size` / `linger.ms`），整批压缩（lz4 / zstd），Broker 原样存储，消费者解压 |
| 分区并行 | 多分区分布在多个 Broker 上，生产与消费都能水平扩展 |
| 消费不删除 | 消费只是移动 offset，多个消费者组读同一份数据没有额外写入 |

- 吞吐与延迟需要取舍：`linger.ms` 越大批越满、吞吐越高，单条延迟也越大
- 开启 TLS 后 sendfile 失效，容量评估要预留 CPU

→ 详见 [Kafka](/messaging/2_kafka)

### Q16：消息积压了怎么处理？

**核心结论**：积压 = 生产速度持续大于消费速度。**先止血、再扩容、后根治**：先排除毒消息和下游故障，再扩消费者（必要时同时扩分区 / 队列），最后按峰值复盘消费能力与告警。

排查：

1. Lag 是突增还是持续缓慢增长；全部分区都涨（整体能力不足）还是个别分区涨（热点 key、某实例卡住）
2. 对比生产与消费 TPS；看消费者是否宕机、频繁 Rebalance、线程阻塞（`jstack`）
3. 看下游依赖：慢 SQL、第三方超时、连接池耗尽；是否有毒消息反复重试堵住分区

处置：

| 手段 | 说明 |
|------|------|
| 隔离毒消息 | 失败超上限转死信；RabbitMQ 先停掉 requeue 循环，否则扩容也没用 |
| 扩消费者 | Kafka、RocketMQ 4.x 按分区 / 队列分配，实例数超过分区数的部分空闲，需同时扩分区；RocketMQ 5.x POP 消费可突破；RabbitMQ 竞争消费可直接扩 |
| 提升单实例吞吐 | 批量拉取 + 批量写库，减少同步远程调用，优化慢 SQL；RabbitMQ 调整 prefetch |
| 临时转储 | 轻量消费者把消息原样转到分区更多的临时 Topic，再用大量实例消费 |
| 降级 | 暂停统计类等非核心消费组，资源让给核心链路 |
| 跳过（最后手段） | 业务允许丢弃时重置 offset 到最新，被跳过的数据事后补偿 |

- 事后：按峰值评估分区数与消费能力，配置 Lag 告警；系统级削峰见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)

→ 详见 [消息队列基础](/messaging/1_basics)、[Kafka](/messaging/2_kafka)

## 五、分布式事务

### Q17：如何用消息队列实现分布式事务最终一致性？

**核心结论**：MQ 只能做到**最终一致**。思路是"**上游本地事务与消息投递原子化 + MQ 至少一次投递 + 下游幂等重试 + 对账补偿兜底**"。原子化有两种可靠做法：**本地消息表（Outbox）** 或 **RocketMQ 事务消息**。

| 方案 | 一致性 | 侵入性 | 适用场景 |
|------|-------|-------|---------|
| 本地消息表 / Outbox | 最终一致，可靠 | 需要消息表与投递任务 | 通用首选，不绑定 MQ |
| RocketMQ 事务消息 | 最终一致，可靠 | 实现回查接口，绑定 RocketMQ | 已使用 RocketMQ 的核心链路 |
| 最大努力通知 | 尽力而为，有限次重试 + 对账查询 | 低 | 跨企业回调，如支付结果通知 |
| 提交后发送 | 可能丢 | 最低 | 非关键通知 |

- 上游只保证"本地事务成功 ⇔ 消息一定投递"，**下游消费失败不会回滚上游**：下游要重试 + 幂等，重试耗尽进死信后人工处理或反向补偿
- Kafka 事务保证的是多分区原子写和 Kafka 内的 Exactly-Once，**无法与数据库事务绑定**，不能替代本地消息表
- 需要回滚语义的强流程用 TCC / Saga，见 [分布式 · 分布式事务](/distributed/4_transaction)

→ 详见 [消息队列基础](/messaging/1_basics)

### Q18：为什么不能在数据库事务里直接发 MQ 消息？本地消息表（Outbox）怎么做？

**核心结论**：数据库提交和发消息是两个系统，放不进同一个事务。在事务里发消息，会出现"**消息已发出但事务回滚**"或"**事务提交但消息没发出**"，发送超时还会拉长事务、占住连接。正确做法是**本地消息表**：业务数据和待发消息在同一个本地事务里落库，再由投递任务可靠地发出去。

| 写法 | 问题 |
|------|------|
| 先发消息再提交 / 事务内发送 | 事务回滚，下游收到一条"不存在"的事件 |
| 先提交再发消息 | 提交后进程崩溃或发送失败，消息丢失 |
| `@TransactionalEventListener(phase = AFTER_COMMIT)` | 避免了"回滚但已发出"，但提交后到发送前崩溃仍会丢，只适合非关键通知 |

![本地消息表（Transactional Outbox）](../assets/messaging/mq-outbox.svg)

1. 同一个本地事务里写业务表和消息表（状态 `NEW`），两者同时成功或同时失败
2. 投递任务扫描 `NEW` 消息发送到 MQ，收到 Broker 确认后标记 `SENT`；失败累加重试次数，下次再发
3. 投递可能重复，**消费端必须幂等**

- 多实例扫表用 `SELECT ... FOR UPDATE SKIP LOCKED`（MySQL 8.0+ / PostgreSQL）或按分片扫描，避免重复投递
- 也可以用 CDC（如 Debezium 读 binlog）推送 outbox 表，见 [数据库 · CDC 工具](/database/5_practice/0_cdc_tools)
- `@TransactionalEventListener` 只在有活动事务时生效，没有事务时事件默认被丢弃（除非 `fallbackExecution = true`）

→ 详见 [消息队列基础](/messaging/1_basics)

### Q19：RocketMQ 事务消息的原理是什么？（半消息 + 本地事务 + 回查）

**核心结论**：先发一条消费者不可见的**半消息** → 执行本地事务 → 按结果 **COMMIT** 投递或 **ROLLBACK** 丢弃；二次确认丢失或返回 `UNKNOWN` 时，Broker 定时**回查**生产者的本地事务状态。

![RocketMQ 事务消息流程](../assets/messaging/rocketmq-transaction.svg)

1. Producer 发送半消息，Broker 写入内部 Topic，消费者不可见
2. 半消息写入成功后执行本地事务，并在**同一事务**里记录 `txId`（回查依据）
3. 本地事务提交返回 `COMMIT`，确定失败返回 `ROLLBACK`，结果不确定返回 `UNKNOWN`
4. 结果丢失或为 `UNKNOWN` 时 Broker 回查 `checkLocalTransaction`；超过回查上限（`transactionCheckMax`，默认 15 次）默认丢弃半消息

关键点：

- **回查只在"确定"时返回 COMMIT / ROLLBACK**：查不到记录不等于失败，本地事务可能还没提交，应返回 `UNKNOWN`；超过合理窗口仍无记录才判定回滚
- 回查依据必须持久化：回查可能落到 Producer 集群的其他实例，只能依赖数据库，不能依赖内存
- 只保证"生产端本地事务 ⇔ 消息投递"，下游仍需重试 + 幂等
- 5.x 的 Topic 需声明为 TRANSACTION 类型

→ 详见 [RocketMQ](/messaging/3_rocketmq)

### Q20：本地消息表和 RocketMQ 事务消息的区别？

**核心结论**：两者效果一致（本地事务成功则消息必达），差别在**谁来保证投递**：本地消息表靠**自己的消息表 + 投递任务**，与 MQ 无关；事务消息把这件事交给 **Broker 的半消息 + 回查**，省掉消息表，但绑定 RocketMQ。

| 维度 | 本地消息表（Outbox） | RocketMQ 事务消息 |
|------|---------------------|------------------|
| 原子性来源 | 业务表与消息表同一本地事务 | 半消息 + 本地事务 + 回查 |
| 额外组件 | 消息表、投递任务（或 CDC） | 回查接口、事务记录表（`txId`） |
| MQ 依赖 | 任何 MQ 都能用 | 只能 RocketMQ |
| 投递时延 | 取决于扫表间隔（CDC 可接近实时） | 本地事务提交后立即确认 |
| 失败可见性 | 消息表里能直接查到未发送 / 重试中的消息 | 状态在 Broker 内部，依赖控制台与日志 |
| 侵入与成本 | 多一张表和一个任务，库多一份写入 | 回查逻辑要写对（不确定返回 `UNKNOWN`） |
| 共同点 | 都是至少一次，下游必须幂等；都不回滚上游 | 同左 |

- 已用 RocketMQ 的核心链路可用事务消息；跨 MQ、需要统一治理或要接 CDC 时选本地消息表

→ 详见 [RocketMQ](/messaging/3_rocketmq)、[消息队列基础](/messaging/1_basics)

## 六、高可用

### Q21：RocketMQ 如何保证高可用？（主从复制 + DLedger / 5.x Controller）

**核心结论**：NameServer 无状态多节点部署，任一存活即可路由；Broker 侧经历了三个阶段——**主从复制（不自动切换）→ DLedger（Raft 自动选主）→ 5.x Controller（在同步副本中自动选主）**。新集群优先 5.x Controller 模式。

![RocketMQ 部署架构](../assets/messaging/rocketmq-architecture.svg)

| 方案 | 复制方式 | 故障切换 | 说明 |
|------|---------|---------|------|
| 主从同步 / 异步复制 | `SYNC_MASTER` / `ASYNC_MASTER` | 不自动切换；Master 宕机后该组不可写，消费可转到 Slave 读 | 写入靠多组 Broker 分担；同步复制不丢，异步复制可能丢少量 |
| DLedger（4.5+） | Raft，多数派写入成功才提交 | 自动选主 | 至少 3 副本；CommitLog 格式被 Raft 日志接管，存储与复制强耦合 |
| Controller 模式（5.x） | 仍是主从复制，维护同步副本集合 SyncStateSet | Controller（可内嵌 NameServer）自动选主 | 只在同步副本中选主，避免丢数据；2 副本即可工作，复用原存储格式 |

- 可靠性组合：同步复制（或 Controller）+ 异步刷盘是常见折中，详见 Q7

→ 详见 [RocketMQ](/messaging/3_rocketmq)

### Q22：Kafka 的副本机制是什么？Leader 宕机如何选举？

**核心结论**：每个分区有多个副本，**读写都走 Leader**，Follower 拉取同步；Leader 宕机后由 **KRaft Controller** 从 **ISR** 中选出新 Leader 并广播元数据，客户端刷新元数据后切到新 Leader。Kafka 4.0 起只有 KRaft 模式，不再依赖 ZooKeeper。

![Kafka 4.x 集群架构](../assets/messaging/kafka-architecture.svg)

| 环节 | 说明 |
|------|------|
| 副本分布 | 同一分区的副本分散在不同 Broker（可按机架感知分布） |
| 同步 | Follower 向 Leader 拉取；跟上的进入 ISR，HW 推进到 ISR 都已复制的位置 |
| 故障检测 | Broker 与 Controller 的心跳 / 会话超时，Controller 感知 Broker 下线 |
| 选举 | Controller 从该分区的 ISR 中选新 Leader；`unclean.leader.election.enable=false` 时 ISR 为空则分区不可用，而不是让落后副本上位丢数据 |
| 截断 | 旧 Leader 恢复后作为 Follower，按新 Leader 的日志（Leader Epoch）截断未提交部分再追赶 |

- KRaft Controller 通常 3 或 5 个节点组成 Raft 仲裁，管理 Topic、分区、Leader 与 ISR 变更；开发测试可与 Broker 同进程（combined 模式），生产建议独立部署
- 旧集群需先在 3.x 完成 ZooKeeper → KRaft 迁移，再升级到 4.x

→ 详见 [Kafka](/messaging/2_kafka)

### Q23：RabbitMQ 的镜像队列（4.0 已移除）和 Quorum Queue 有什么区别？为什么要迁移？

**核心结论**：经典镜像队列是 3.x 时代的主从复制方案，**已在 RabbitMQ 4.0 正式移除**，`ha-mode` 策略在 4.x 不再生效；需要复制的队列只剩 **Quorum 队列（Raft）** 和 **Stream**，升级前必须先把镜像队列迁移到 Quorum。

| 对比 | 经典镜像队列（≤ 3.x） | Quorum 队列（3.8+） |
|------|---------------------|--------------------|
| 复制模型 | 一主多镜像，靠策略把经典队列镜像到其他节点 | Raft：一个 leader + 若干 follower，多数派写入才确认 |
| 数据安全 | 新镜像加入需同步历史消息，同步期间可用性受影响；提升未同步的镜像可能丢消息 | 多数派提交，Leader 宕机自动选举且不丢已确认消息 |
| 毒消息保护 | 无 | `delivery-limit`（4.0 起默认 20），超过后死信或丢弃 |
| 特性限制 | 支持非持久、排他等经典特性 | 始终持久化，不支持非持久、排他、自动删除；内存与磁盘 IO 要求更高 |
| 现状 | 3.9 起废弃，**4.0 移除** | **业务队列的默认选择** |

- 副本数建议奇数（3 或 5），3 副本容忍 1 个节点故障
- 死信默认 at-most-once，要求可靠时设 `dead-letter-strategy: at-least-once`（配合 `overflow: reject-publish`）
- 需要回放、大扇出或海量堆积时用 **Stream**（3.9+）：只追加日志、非破坏性消费、可按 offset / 时间戳回放
- Classic 队列即使持久化也是单节点存储，只适合临时、可丢的队列

→ 详见 [RabbitMQ](/messaging/4_rabbitmq)

### Q24：如何设计一个消息队列？

**核心结论**：按"**一条消息的生命周期**"组织答案：怎么收（网络与协议）→ 怎么存（存储模型）→ 怎么投（消费模型）→ 怎么不丢不重（可靠性）→ 怎么扩与容错（分区与副本），再补上事务、延迟、死信等业务能力，并能说出每处的取舍。

| 维度 | 设计要点 | 参照 |
|------|---------|------|
| 网络通信 | 生产 / 消费两段 RPC，长连接 + 自定义二进制协议，批量收发与压缩 | Netty、Kafka 协议 |
| 存储 | 顺序追加的分段日志 + 稀疏 / 定长索引；PageCache + 零拷贝；按时间 / 大小清理 | Kafka 分段日志、RocketMQ CommitLog + ConsumeQueue |
| 消费模型 | 消费者组：组内分摊、组间各自全量；拉模式 + 长轮询；位点存 Broker | Kafka / RocketMQ |
| 可靠性 | 生产确认 + 多副本确认后才 ack + 消费成功后再提交；默认至少一次 | `acks=all`、`min.insync.replicas` |
| 扩展性 | Topic 拆分区，分区分布到多个 Broker；扩容加分区与节点 | Kafka Partition |
| 高可用 | 分区多副本 + Leader 选举（Raft 或同步副本集合）；元数据集群化 | KRaft、Controller 模式 |
| 业务能力 | 顺序（分区键）、延迟（时间轮）、事务（半消息 + 回查）、重试与死信 | RocketMQ |
| 运维 | Lag 监控、消息轨迹、按 Key 查询、限流与配额 | — |

- 取舍要主动说：同步刷盘 / 同步复制换可靠性牺牲吞吐；分区多提升并行但增加元数据与 Rebalance 开销；全局有序与吞吐不可兼得
- 无论怎么设计，至少一次投递下的**幂等消费**都要交给业务

→ 详见 [MQ 选型](/messaging/6_selection)、[Kafka](/messaging/2_kafka)

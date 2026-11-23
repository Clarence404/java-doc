---
description: KRaft 架构、副本与可靠性配置、高性能原理、扩分区、Share Group 队列语义
---

# Kafka 架构与存储

> 前置阅读：[消息队列基础](./1_basics)

Kafka 本质是分布式、分区、多副本的提交日志，这决定了它高吞吐、可回放、分区内有序。本篇讲架构与核心概念、副本与可靠性、高性能原理、扩分区与 Share Group 队列语义，基线为 Kafka 4。

---

## 一、架构与核心概念

**Kafka 4.0 起彻底移除 ZooKeeper，集群元数据只由 KRaft Controller 仲裁（基于 Raft）管理。** 旧集群需先在 3.x 完成 ZooKeeper → KRaft 迁移再升级到 4.x。

![Kafka 4.x 集群架构](../assets/messaging/kafka-architecture.svg)

| 概念 | 说明 |
|------|------|
| **Topic** | 消息分类，逻辑上的消息流 |
| **Partition** | Topic 的物理分片，分区内消息顺序追加；并行度的基本单位 |
| **Offset** | 消息在分区内的序号；消费者提交的是「下一条要读的 offset」，**按分区累计生效** |
| **Broker** | 存储与读写节点，一个集群由多个 Broker 组成 |
| **KRaft Controller** | 管理元数据（Topic、分区、Leader 选举、ISR 变更），通常 3 或 5 个节点组成仲裁；小集群可与 Broker 混部 |
| **Replica / Leader / Follower** | 每个分区有多个副本，读写都走 Leader，Follower 拉取同步 |
| **ISR** | In-Sync Replicas，跟上 Leader 的副本集合；Leader 故障时从 ISR 中选新 Leader |
| **HW（High Watermark）** | ISR 都已复制到的位置，消费者只能读到 HW 之前的消息 |
| **LEO（Log End Offset）** | 副本日志末尾的下一个 offset |
| **Consumer Group** | 组内每个分区只分给一个消费者；不同 Group 各自维护 offset，互不影响 |

生产者、消费者组的用法、失败处理与调优见 [Kafka 生产与消费](./3_kafka_client)。

---

## 二、消息可靠性

消息丢失可能发生在生产、存储、消费三个环节，三端都要配。

### 1、生产者侧

| `acks` | 含义 | 可靠性 | 吞吐 |
|--------|------|--------|------|
| `0` | 不等确认 | 最低，可能丢 | 最高 |
| `1` | Leader 写入即返回 | Leader 宕机且未同步给 Follower 时丢 | 高 |
| `all`（`-1`） | ISR 全部写入才返回 | 配合 `min.insync.replicas` 最高 | 较低 |

推荐组合：`acks=all` + 幂等开启（默认）+ 合理的 `delivery.timeout.ms`；需要和数据库一致时再加本地消息表。

### 2、Broker 侧：靠复制，不靠刷盘

**Kafka 的持久性来自多副本，而不是每条 fsync。** 不建议配置 `log.flush.interval.messages` / `log.flush.interval.ms`：强制刷盘会显著拉低吞吐，而且单机刷盘挡不住磁盘损坏；保持默认，让操作系统刷盘，用副本冗余兜底。

```properties
# server.properties
default.replication.factor=3          # 新建 Topic 默认 3 副本
min.insync.replicas=2                 # acks=all 时至少 2 个 ISR 写入才算成功
unclean.leader.election.enable=false  # 默认 false：禁止 ISR 之外的落后副本当选 Leader
```

`replication.factor=3` + `min.insync.replicas=2` 的含义：允许 1 个副本故障时仍可写；若 ISR 不足 2 个，生产者收到 `NotEnoughReplicas` 异常而不是悄悄写成单副本。

### 3、消费者侧

关闭自动提交，由 Spring 容器在**处理成功后**提交 offset；处理失败抛异常，交给错误处理器（见 [Kafka 生产与消费 · 消费失败处理与幂等消费](./3_kafka_client#二、消费失败处理与幂等消费)）。自动提交是「到时间就提交」，处理失败或进程崩溃时消息就被跳过了。

### 4、丢失原因速查

| 环节 | 原因 | 解决方案 |
|------|------|---------|
| 生产者 | `acks=0/1`，Leader 宕机 | `acks=all` + `min.insync.replicas=2` |
| 生产者 | 发送失败只打日志 / 进程在回调前退出 | 本地消息表，中继重试 |
| Broker | 副本不足、非 ISR 副本当选 Leader | 3 副本 + `unclean.leader.election.enable=false` |
| 消费者 | 自动提交后处理失败；catch 住异常不抛 | 关闭自动提交，失败抛出，走重试 + 死信 |

---

## 三、高性能原理

| 机制 | 说明 |
|------|------|
| **顺序追加写** | 消息追加写入分段日志文件，顺序 IO 吞吐远高于随机 IO |
| **PageCache** | 读写都走操作系统页缓存，不占 JVM 堆；刚写入的数据通常直接从缓存读到 |
| **零拷贝（sendfile）** | 消费时数据从 PageCache 直接送到网卡，不经过用户态，省去两次拷贝和上下文切换 |
| **批量与压缩** | 生产者按分区攒批（`batch.size` / `linger.ms`），整批压缩（lz4 / zstd），Broker 原样存储，消费者解压 |
| **分区并行** | 多分区分布在多个 Broker 上，生产与消费都能水平扩展 |

![sendfile 数据路径](../assets/messaging/zero-copy-sendfile.svg)

**零拷贝的前提**：Broker 要原样转发磁盘上的字节。启用 **TLS 后数据必须在用户态加密，sendfile 不再生效**，CPU 与内存拷贝开销会明显上升，容量评估时要考虑。应用层（Netty）的零拷贝是另一层概念，见 [Netty · ByteBuf 与内存管理](/netty/6_bytebuf)。

---

## 四、常见问题

### 1、增加分区

- **在线执行，无需停服**：`kafka-topics.sh --alter --topic order-events --partitions 12`，生产者和消费者刷新元数据后自动感知
- **分区只能增不能减**，需要减少只能新建 Topic 迁移
- **key 会重新映射**：新消息按新的分区数计算，同一 key 在扩容前后可能落到不同分区。扩容瞬间旧分区里还有未消费的该 key 消息，新分区的消息可能被先处理，造成短暂乱序
- **对顺序敏感时**：在业务低峰扩容；或短暂暂停相关生产者，等旧分区消费完毕后再恢复；更好的做法是建 Topic 时按峰值预留足够分区

积压排查与 Consumer Rebalance 见 [Kafka 生产与消费 · 常见问题](./3_kafka_client#五、常见问题)。

---

## 五、Kafka 的队列语义：Share Group

KIP-932（Share Group，即 Queues for Kafka）让多个消费者共享消费同一分区并逐条确认，相当于 Pulsar 的 Shared 订阅（不保证顺序），给 Kafka 补上了传统队列语义。4.0 为早期访问、4.1 为预览，**4.2（2026-02）起正式宣布生产可用（GA）**。已有 Kafka 集群、需要竞争消费的场景可以不再额外引入 RabbitMQ。

### 1、和消费者组的区别

| 维度 | 消费者组 | 共享组 |
|------|----------|--------|
| 分区分配 | 一个分区只给组内一个消费者 | 多个消费者可同时消费同一分区 |
| 消费者上限 | 受分区数限制 | 不受分区数限制，可按积压扩消费者 |
| 确认方式 | 累计提交 offset | 逐条确认：`ACCEPT`（完成）/ `RELEASE`（放回重投）/ `REJECT`（永久失败）；4.2 新增 `RENEW`，延长处理慢的记录的锁 |
| 顺序 | 分区内有序 | 不保证顺序 |

### 2、使用要点

- **客户端**：用 `KafkaShareConsumer`（不是 `KafkaConsumer`）；记录被取走后加锁（`share.record.lock.duration.ms`，默认 30s），超时未确认自动放回
- **重投上限**：单条记录最多投递 `share.delivery.count.limit` 次（默认 5），超过后归档不再投递；截至 4.3 还没有内置死信 Topic（KIP-1191 已通过，计划在后续版本提供），需要死信时在 `REJECT` 前自行转发
- **监控**：4.2 起提供共享分区 lag 指标，可据此扩缩消费者
- **适用**：任务分发、竞争消费、逐条确认且不要求顺序的场景；要求分区内顺序、Exactly-Once 或 Streams 处理时仍用消费者组

Pulsar 四种订阅模式与 Shared 订阅的对比见 [Pulsar 与其他 MQ · 订阅模式](./9_other_mq#_2、订阅模式-一套系统同时覆盖队列与流)。

---

## 小结

- Kafka 4.0 起只有 KRaft 模式，元数据由 Controller 仲裁管理，不再依赖 ZooKeeper
- 可靠性三端配：`acks=all` + 幂等生产者（默认开启，靠 `delivery.timeout.ms` 控制重试），`replication.factor=3` + `min.insync.replicas=2` + 禁止 unclean 选举，消费端关闭自动提交；持久性靠副本，不靠强制刷盘
- 高吞吐来自顺序追加写、PageCache、sendfile 零拷贝、批量压缩与分区并行；TLS 会让 sendfile 零拷贝失效
- 扩分区在线执行，但只能增不能减，并会改变 key 的分区映射
- 共享组（4.2 起 GA）允许多个消费者同时消费同一分区、逐条确认，不保证顺序，适合任务分发

## 参考资料

- 官方文档：[https://kafka.apache.org/documentation/](https://kafka.apache.org/documentation/)
- Kafka Share Group：[KIP-932: Queues for Kafka](https://cwiki.apache.org/confluence/display/KAFKA/KIP-932%3A+Queues+for+Kafka)

> 下一篇：[Kafka 生产与消费](./3_kafka_client) —— Spring Kafka 接入、死信与幂等消费、事务与 Exactly-Once、顺序消息、积压与 Rebalance

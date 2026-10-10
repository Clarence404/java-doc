---
description: Apache Pulsar 存算分离与订阅模式、与 Kafka 的差异、Kafka Share Group、其他常见消息系统速览
---

# 其他 MQ

> 前置阅读：[Kafka](./2_kafka)、[RocketMQ](./3_rocketmq)、[RabbitMQ](./4_rabbitmq)

在平台化、多租户、跨地域复制等需求下，Pulsar 常被放进三大 MQ 之外的候选名单。本篇先讲 Pulsar 解决什么问题、代价是什么，再速览其他常见消息系统的定位，下一篇统一做选型。

---

## 一、Apache Pulsar

Pulsar 是 Apache 顶级项目，同时提供队列和流两种语义，最大特点是**存算分离**：Broker 只负责计算，消息持久化交给 BookKeeper。

### 1、架构与特性

![Pulsar 存算分离架构](../assets/messaging/pulsar-architecture.svg)

| 特性 | 说明 |
|------|------|
| **存算分离** | Broker 无状态，Topic 归属可在 Broker 间快速迁移；存储由 Bookie 集群承担，两层独立扩缩容 |
| **分段存储** | 一个分区的数据按 Segment 分散在多个 Bookie 上，扩容新 Bookie 后新数据直接写入，无需像 Kafka 那样做分区重分配 |
| **分层存储** | 冷数据可卸载到 S3 等对象存储，适合超长保留 |
| **多租户** | 原生 Tenant / Namespace / Topic 三级隔离，可按租户配置配额与权限 |
| **订阅模型** | Exclusive / Failover / Shared / Key_Shared，一套系统覆盖队列与流 |
| **Geo 复制** | 原生跨集群、跨地域复制 |
| **协议兼容** | 通过 KoP 等协议处理器兼容 Kafka 客户端（成熟度需按版本评估） |

### 2、订阅模式：一套系统同时覆盖队列与流

Pulsar 把「怎么分发给消费者」交给**订阅（Subscription）**决定，同一个 Topic 可以同时挂多个不同模式的订阅：

| 订阅模式 | 分发方式 | 顺序 | 相当于 |
|---------|---------|------|--------|
| **Exclusive** | 一个订阅只允许一个消费者，多连会报错 | 全局有序 | 单消费者的流 |
| **Failover** | 多个消费者，只有主消费者在收，主挂了备接管 | 有序 | Kafka 消费组（分区内） |
| **Shared** | 多个消费者轮询分发，逐条确认 | 不保证顺序 | 传统工作队列（RabbitMQ 竞争消费） |
| **Key_Shared** | 多个消费者，同一 Key 固定发给同一消费者 | 同 Key 有序 | 按业务键并行 + 局部有序 |

逐条确认（而不是只提交位点）也让 Pulsar 天然支持**单条重投、否认确认（negative ack）与死信**，这正是 Kafka 需要靠 Share Group 补齐的能力（见第二节）。

### 3、和 Kafka 的关键差异

| 维度 | Kafka | Pulsar |
|------|-------|--------|
| 存储位置 | 分区数据存在 Broker 本地磁盘 | Broker 无状态，数据分段存到 BookKeeper |
| 扩容 | 新 Broker 需要分区重分配（搬迁数据） | 新 Bookie 直接接收新分段，Broker 扩容只迁移 Topic 归属，不搬数据 |
| 消费确认 | 按分区提交位点（累计确认） | 逐条确认 + 累计确认都支持 |
| 多租户 | 靠 Topic 命名与 ACL 约定 | 原生 Tenant / Namespace 隔离，配额与策略按租户配置 |
| 跨地域复制 | MirrorMaker 2 等外部组件 | 内置 Geo-Replication |
| 冷数据 | 分层存储（Tiered Storage） | 分层存储，冷段卸载到对象存储 |
| 生态 | Connect、Streams、Flink / Spark 集成最成熟 | Pulsar Functions、IO Connectors，生态相对小 |
| 运维代价 | 4.0 起只需 Kafka 自身（KRaft） | Broker + Bookie + 元数据存储三类组件，排障要同时理解计算层与存储层 |

### 4、什么时候选它

- **平台型消息中台**：要给多个团队、多个业务线共用一套集群，需要原生多租户隔离与配额。
- **跨机房 / 跨地域复制**是硬需求，希望用内置能力而不是自己维护复制链路。
- **海量 Topic** 或需要频繁弹性扩缩容，不希望每次扩容都搬迁分区数据。
- **同一份数据既要流式回放、又要队列式竞争消费**，希望用订阅模式统一。
- 前提：**团队有能力运维多组件集群**。如果只是普通业务解耦、日志采集，Kafka / RocketMQ / RabbitMQ 更省心。

**当前现状**：Pulsar 已进入 4.x LTS 阶段，元数据存储除 ZooKeeper 外还可选 etcd、Oxia 等；国内外均有大规模生产案例。但它组件更多（Broker + Bookie + 元数据），排障需要同时理解两层，社区与中文资料也少于 Kafka、RocketMQ。**适合有平台团队、明确需要多租户或跨地域复制的场景，普通业务项目不建议为"架构先进"单独引入。**

---

## 二、Kafka 的队列语义：Share Group

Kafka 社区也在补齐"队列语义"：KIP-932（Share Group，即 Queues for Kafka）允许多个消费者**共享消费同一分区**并**逐条确认**，单条消息处理失败可以单独重投，而不必像传统消费组那样受「一个分区只能被组内一个消费者消费」和累计位点的限制。

它在 4.x 中从早期访问、预览逐步推进，**生产使用前请确认所用版本中该特性的状态**。在它成熟之前，需要竞争消费、逐条确认的场景仍以 RabbitMQ、RocketMQ 或 Pulsar 的 Shared 订阅为主。

---

## 三、其他常见消息系统速览

下面这些系统在特定场景里很常见，通常不作为通用业务 MQ 的首选，但选型时应当知道它们的定位：

| 系统 | 定位 | 适合 | 需要注意 |
|------|------|------|---------|
| **Redis Stream** | Redis 内置的日志型数据结构，支持消费组与确认 | 已有 Redis、消息量不大、可接受内存成本的轻量异步任务 | 持久化与高可用依赖 Redis 本身的配置，不适合大积压和长期保留 |
| **NATS（JetStream）** | 轻量、低延迟的消息系统，JetStream 提供持久化与流 | 云原生、边缘与微服务间轻量通信 | 国内 Java 生态与资料较少 |
| **ActiveMQ Artemis** | JMS 规范的实现，传统 ActiveMQ 的下一代 | 依赖 JMS 规范的存量 Java EE / 企业系统 | 新项目较少选择 |
| **MQTT Broker（EMQX 等）** | 面向物联网设备的发布订阅，海量长连接 | 设备上报与下发，通常再汇入 Kafka 做后端处理 | 定位是设备接入层，不替代后端业务 MQ |
| **云托管消息服务** | 云厂商的托管版 Kafka / RocketMQ / RabbitMQ，或自有队列服务 | 已在公有云上、希望免运维 | 关注与开源版本的兼容差异、跨云迁移成本 |

---

## 小结

- Pulsar 以存算分离、多租户、Geo 复制见长，四种订阅模式让一套系统同时覆盖队列与流；但组件多、门槛高，平台型场景再引入
- Kafka 用 Share Group 补齐逐条确认的队列语义，生产使用前要确认版本状态
- Redis Stream、NATS、Artemis、MQTT Broker、云托管服务各有细分场景，通用业务 MQ 仍以三大 MQ 为主

## 参考资料

- Pulsar 架构（存算分离）：[Pulsar: Architecture Overview](https://pulsar.apache.org/docs/next/concepts-architecture-overview/)
- Pulsar 订阅模式与确认：[Pulsar: Messaging Concepts](https://pulsar.apache.org/docs/next/concepts-messaging/)
- Kafka Share Group：[KIP-932: Queues for Kafka](https://cwiki.apache.org/confluence/display/KAFKA/KIP-932%3A+Queues+for+Kafka)
- Redis Stream：[Redis Streams — Redis Docs](https://redis.io/docs/latest/develop/data-types/streams/)
- NATS 官方文档：[NATS Docs](https://docs.nats.io/)
- ActiveMQ Artemis：[Apache ActiveMQ Artemis](https://activemq.apache.org/components/artemis/)

> 下一篇：[MQ 选型](./6_selection) —— 把三大 MQ 的差异收拢到一张表里，按场景给出选型建议与常见误区。

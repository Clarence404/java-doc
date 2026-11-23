---
description: 4.x 与 5.x 差异、NameServer 与 Broker、CommitLog 存储结构、刷盘策略、三代高可用方案
---

# RocketMQ 架构与存储

> 前置阅读：[消息队列基础](./1_basics)、[Kafka 架构与存储](./2_kafka)

RocketMQ 诞生于阿里交易场景，强项是事务、延迟、顺序等业务消息能力，适合订单、支付这类高可靠场景。本篇讲 4.x 与 5.x 的差异、架构、存储结构与高可用，基线为 RocketMQ 5。

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

两代客户端的收发写法、延迟与顺序消息的代码见 [RocketMQ 生产与消费](./6_rocketmq_client)。

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

![mmap + write 数据路径](../assets/messaging/zero-copy-mmap.svg)

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

## 小结

- 5.x 引入 Proxy + gRPC、新 SDK（MessageGroup 顺序）、任意时间定时消息、POP 消费与 Controller 高可用；4.x 是 18 级延迟与 DLedger
- NameServer 是无状态路由中心，Broker 负责存储与转发，MessageQueue 对标 Kafka Partition，Keys 是按 Key 查询与幂等去重的依据
- 存储上所有 Topic 共用 CommitLog 顺序写，ConsumeQueue 做消费索引、IndexFile 做 Key 查询，依靠 mmap + PageCache 提速
- 常见组合是「异步刷盘 + 同步复制」，单机断电丢的数据由副本兜底
- 高可用从主从复制、DLedger 演进到 5.x Controller 模式，新集群优先选 Controller

## 参考资料

- 官方文档：[https://rocketmq.apache.org/docs/](https://rocketmq.apache.org/docs/)
- rocketmq-clients（5.x 新 SDK）：[https://github.com/apache/rocketmq-clients](https://github.com/apache/rocketmq-clients)

> 下一篇：[RocketMQ 生产与消费](./6_rocketmq_client) —— Spring Boot 收发、幂等消费、延迟与顺序消息、事务消息与回查、重试与死信、消息积压

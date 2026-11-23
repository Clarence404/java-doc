---
description: Streams 核心概念、窗口聚合与 JOIN、与 Flink 取舍、Connect 核心概念、ES Sink、部署模式
---

# Kafka Streams 与 Connect

> 前置阅读：[Kafka 架构与存储](./2_kafka)、[Kafka 生产与消费](./3_kafka_client)

Kafka Streams 是嵌在应用里的流处理库，Kafka Connect 是用配置搭数据管道的框架。本篇讲 Streams 的核心概念、窗口聚合与 JOIN，Connect 的 Sink 配置与部署模式，基线为 Kafka 4。

---

## 一、Kafka Streams

Kafka Streams 是 Kafka 内置的**流处理库**（不是独立集群），以普通 Java 应用部署，直接消费和生产 Kafka Topic，多实例通过 `application.id`（即消费者组）自动分担分区。

### 1、核心概念

| 概念 | 说明 |
|------|------|
| **KStream** | 无界事件流，每条记录是一个独立事件（INSERT 语义） |
| **KTable** | 变更日志流，相同 key 的新记录覆盖旧值（UPSERT 语义） |
| **GlobalKTable** | 全量广播到每个实例的 KTable，用于流-表 JOIN 时不要求分区对齐 |
| **Topology** | 处理拓扑，由 Source → Processor → Sink 节点组成 |
| **State Store** | 本地状态存储（默认 RocksDB），由 changelog Topic 备份，实例故障后可恢复 |
| **Task** | 并行单元，一个输入分区对应一个 Task |

### 2、示例：每分钟每用户的支付金额

```java
@Bean
public KStream<String, OrderEvent> orderStream(StreamsBuilder builder) {
    KStream<String, OrderEvent> stream = builder.stream(
        "order-events", Consumed.with(Serdes.String(), orderSerde()));

    stream
        .filter((key, order) -> "PAID".equals(order.getStatus()))
        .groupBy((key, order) -> order.getUserId(),
                 Grouped.with(Serdes.String(), orderSerde()))
        .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(1)))
        .aggregate(
            () -> BigDecimal.ZERO,
            (userId, order, total) -> total.add(order.getAmount()),
            Materialized.<String, BigDecimal, WindowStore<Bytes, byte[]>>as("user-order-amount-store")
                .withKeySerde(Serdes.String())
                .withValueSerde(bigDecimalSerde()))
        .toStream()
        .to("user-order-stats", Produced.with(windowedSerde(), bigDecimalSerde()));

    return stream;
}
```

```yaml
spring:
  kafka:
    streams:
      application-id: order-stats-app     # 同时作为消费者组 ID 与内部 Topic 前缀
      bootstrap-servers: localhost:9092
      properties:
        default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.value.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        processing.guarantee: exactly_once_v2
        commit.interval.ms: 1000
        num.stream.threads: 4
```

`commit.interval.ms` 是**提交处理进度的间隔**：每次提交时刷新状态存储与缓存、把结果写出并提交输入 offset。它不是「状态刷盘间隔」。间隔越小，下游看到结果越及时、故障后重放越少，但提交开销越大；默认在 at-least-once 下为 30 秒，在 exactly-once 下为 100 毫秒。

### 3、KStream 与 KTable JOIN

```java
KStream<String, Order> orders = builder.stream("orders", Consumed.with(Serdes.String(), orderSerde()));
KTable<String, User>   users  = builder.table("users", Consumed.with(Serdes.String(), userSerde()));

// 每条订单关联用户信息：KTable 在本地状态中查询，两个 Topic 需按同一 key 分区且分区数相同
KStream<String, EnrichedOrder> enriched = orders.join(
    users,
    (order, user) -> new EnrichedOrder(order, user),
    Joined.with(Serdes.String(), orderSerde(), userSerde()));
```

### 4、适用场景

| 场景 | 说明 |
|------|------|
| 实时统计 / 排行榜 | 窗口聚合，每分钟 / 每小时 Top N |
| 流式 ETL | 过滤 → 转换 → 写入目标 Topic |
| 事件关联 | 订单与用户 JOIN 生成宽表 |
| 异常检测 | 滑动窗口计数，超阈值告警 |

> Kafka Streams 与 Flink：数据源和输出都在 Kafka、团队以 Java 为主、不想额外维护计算集群 → Kafka Streams；跨多种数据源、超大状态、复杂事件处理或批流一体 → Flink。

---

## 二、Kafka Connect

Kafka Connect 是 Kafka 自带的**数据管道框架**，通过配置而不是写代码，把外部系统的数据导入或导出 Kafka。

![Kafka Connect 数据管道](../assets/messaging/kafka-connect-pipeline.svg)

### 1、核心概念

| 概念 | 说明 |
|------|------|
| **Source Connector** | 从外部系统读取数据写入 Kafka（如 MySQL → Kafka） |
| **Sink Connector** | 从 Kafka 消费数据写入外部系统（如 Kafka → Elasticsearch） |
| **Worker** | Connect 运行进程，分 Standalone / Distributed 两种模式 |
| **Task** | Connector 的并行执行单元，`tasks.max` 控制并行度 |
| **Converter** | 数据序列化格式（JSON / Avro / Protobuf），常与 Schema Registry 配合 |
| **SMT** | Single Message Transform，单条消息的轻量转换，如字段提取、改 Topic 名 |

### 2、Debezium：MySQL CDC → Kafka

Debezium 是最常用的 CDC Source Connector，读取 MySQL binlog（需 `binlog_format=ROW`）把行变更写入 `<topic.prefix>.<库名>.<表名>`，每条消息带 `op` / `before` / `after` / `source` 信封。连接器注册 JSON、`database.server.id` 唯一性、事件结构与 CDC 工具对比统一见 [CDC 工具 · Debezium](/database/4_practice/8_cdc_tools#五、debezium)；下面的 Sink 示例以 topic `dbserver1.inventory.orders` 为例。

### 3、Sink：Kafka → Elasticsearch

Elasticsearch 7 废弃、8 移除了 mapping type，新版 ES Sink Connector 也不再支持 `type.name`，不要再配置。Debezium 的消息带 `before` / `after` 信封，写 ES 前用 `ExtractNewRecordState` 只保留变更后的行；Debezium 的消息 key 是包含主键字段的结构体，ES Sink 只接受基本类型的 key，再用 `ExtractField$Key` 取出主键：

```json
{
  "name": "es-sink-connector",
  "config": {
    "connector.class": "io.confluent.connect.elasticsearch.ElasticsearchSinkConnector",
    "tasks.max": "4",
    "topics": "dbserver1.inventory.orders",
    "connection.url": "http://elasticsearch:9200",
    "key.ignore": "false",
    "schema.ignore": "true",
    "behavior.on.null.values": "delete",
    "transforms": "unwrap,key",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.delete.tombstone.handling.mode": "tombstone",
    "transforms.key.type": "org.apache.kafka.connect.transforms.ExtractField$Key",
    "transforms.key.field": "id"
  }
}
```

`key.ignore=false` 让 ES 文档 ID 取消息 key（即主键），重复写入只会覆盖同一文档，天然幂等；`delete.tombstone.handling.mode=tombstone`（Debezium 2.5 起的写法，取代旧的 `drop.tombstones` / `delete.handling.mode`）把删除事件转成 null 值的墓碑消息，按 `behavior.on.null.values=delete` 删除文档。

### 4、部署模式

| 模式 | 适用场景 | 说明 |
|------|---------|------|
| **Standalone** | 开发 / 测试 | 单进程，配置写在本地文件，offset 存本地 |
| **Distributed** | 生产 | 多 Worker 自动分配 Task，配置与 offset 存在 Kafka 内部 Topic，REST API 管理 |

```bash
# 创建 Connector
curl -X POST http://connect:8083/connectors \
  -H "Content-Type: application/json" \
  -d @mysql-cdc-connector.json

# 查看状态
curl http://connect:8083/connectors/mysql-cdc-connector/status
```

---

## 小结

- Kafka Streams 是嵌在应用里的流处理库，不是独立集群，多实例按 `application.id` 分担分区，一个输入分区对应一个 Task
- KStream 是事件流、KTable 是按 key 覆盖的变更流，状态存在本地 RocksDB 并由 changelog Topic 备份；`commit.interval.ms` 是提交处理进度的间隔，不是刷盘间隔
- 数据源和输出都在 Kafka、不想维护计算集群时选 Kafka Streams，跨数据源、超大状态或批流一体选 Flink
- Kafka Connect 用配置搭数据管道，CDC 常用 Debezium Source；ES Sink 以主键作文档 ID，重复写入天然幂等
- Connect 开发测试用 Standalone，生产用 Distributed，配置与 offset 存在 Kafka 内部 Topic

## 参考资料

- 官方文档：[https://kafka.apache.org/documentation/](https://kafka.apache.org/documentation/)
- Debezium：[https://debezium.io/documentation/](https://debezium.io/documentation/)

> 下一篇：[RocketMQ 架构与存储](./5_rocketmq) —— 4.x 与 5.x 差异、NameServer 与 Broker、CommitLog 存储结构、刷盘策略、三代高可用方案

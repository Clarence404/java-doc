# Kafka

> 参考资料：
> * 官方文档：[https://kafka.apache.org/documentation/](https://kafka.apache.org/documentation/)
> * Spring for Apache Kafka：[https://spring.io/projects/spring-kafka](https://spring.io/projects/spring-kafka)

---

## 一、架构与核心概念

```
Producer ──→ Broker Cluster ──→ Consumer Group
               │
               ├── Topic A
               │     ├── Partition 0 [Leader: Broker1, Follower: Broker2]
               │     └── Partition 1 [Leader: Broker2, Follower: Broker3]
               └── Topic B
                     └── Partition 0 [Leader: Broker3, ...]

ZooKeeper / KRaft（Kafka 2.8+）── 集群元数据管理
```

| 概念 | 说明 |
|------|------|
| **Topic** | 消息分类，逻辑上的消息流 |
| **Partition** | Topic 的物理分片，消息顺序写入，可并行消费 |
| **Offset** | 每条消息在 Partition 内的唯一位置，消费者通过 Offset 追踪进度 |
| **Broker** | Kafka 服务节点，一个集群由多个 Broker 组成 |
| **Consumer Group** | 同组消费者共享消费一个 Topic，每个 Partition 只被组内一个消费者消费 |
| **ISR** | In-Sync Replicas，与 Leader 保持同步的副本集合，用于故障选举 |
| **HW（High Watermark）** | 所有 ISR 都已确认的最大 Offset，消费者只能读到 HW 之前的消息 |
| **LEO（Log End Offset）** | 副本当前最新写入的 Offset |

---

## 二、Spring Boot 快速接入

```xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
      acks: all          # 等待所有 ISR 确认（最可靠）
      retries: 3
      batch-size: 16384
      linger-ms: 5       # 批量等待时间（ms），提升吞吐
    consumer:
      group-id: my-group
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      auto-offset-reset: earliest   # 新 Group 从最早消息开始消费
      enable-auto-commit: false     # 关闭自动提交，手动控制
```

### 生产者

```java
@Service
public class OrderEventProducer {
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    public void sendOrderCreated(Order order) throws JsonProcessingException {
        String payload = objectMapper.writeValueAsString(order);
        // key = orderId，保证同一订单的消息路由到同一 Partition（顺序保障）
        CompletableFuture<SendResult<String, String>> future =
            kafkaTemplate.send("order-events", order.getId().toString(), payload);

        future.whenComplete((result, ex) -> {
            if (ex != null) {
                log.error("Kafka send failed for orderId={}", order.getId(), ex);
                // 生产环境：写入本地消息表，由补偿任务重试
            } else {
                log.debug("Sent to partition={} offset={}",
                    result.getRecordMetadata().partition(),
                    result.getRecordMetadata().offset());
            }
        });
    }
}
```

### 消费者

```java
@Component
public class OrderEventConsumer {

    @KafkaListener(
        topics = "order-events",
        groupId = "order-processor",
        concurrency = "3"   // 3 个线程并发消费，不超过 Partition 数
    )
    public void consume(ConsumerRecord<String, String> record,
                        Acknowledgment ack) {
        try {
            Order order = objectMapper.readValue(record.value(), Order.class);

            // 幂等检查
            if (redis.opsForValue().setIfAbsent(
                    "kafka:processed:" + record.offset() + ":" + record.partition(),
                    "1", Duration.ofDays(1)) == Boolean.FALSE) {
                ack.acknowledge();
                return;
            }

            processOrder(order);
            ack.acknowledge();   // 手动提交 Offset

        } catch (Exception e) {
            log.error("Process failed partition={} offset={}", 
                      record.partition(), record.offset(), e);
            // 不 ack：下次 Rebalance 后会重新消费此消息
        }
    }
}
```

---

## 三、消息可靠性

### 生产者侧

| `acks` 配置 | 说明 | 可靠性 | 性能 |
|-------------|------|--------|------|
| `0` | 不等待确认 | 最低，可能丢 | 最高 |
| `1` | Leader 确认即返回 | 中，Leader 宕机可能丢 | 高 |
| `all`（`-1`）| 所有 ISR 确认 | 最高 | 较低 |

生产环境推荐 `acks=all` + `retries=3`，配合本地消息表做最终一致性补偿。

### Broker 侧

```yaml
# server.properties
log.flush.interval.messages=1      # 每条消息刷盘（性能代价大）
log.flush.interval.ms=1000         # 或每秒刷盘（推荐）
default.replication.factor=3       # 3 副本
min.insync.replicas=2              # 至少 2 个 ISR 确认才算写成功
unclean.leader.election.enable=false  # 禁止 ISR 外的副本当选 Leader（防数据丢失）
```

### 消费者侧

```yaml
enable-auto-commit: false   # 关闭自动提交
```

使用手动 `Acknowledgment.acknowledge()`，确保业务处理成功后才提交 Offset。

---

## 四、顺序消息

Kafka 只保证**同一 Partition 内**有序：

```java
// 发送时指定相同的 key → 路由到同一 Partition
kafkaTemplate.send("order-events", orderId.toString(), payload);

// 消费时 concurrency=1（单线程消费该 Partition），保证顺序
@KafkaListener(topics = "order-events", concurrency = "1")
```

**注意**：增加 Partition 数会打乱原有 key 的路由，已有顺序保证需要停服迁移。

---

## 五、高性能原理

| 机制 | 说明 |
|------|------|
| **顺序写磁盘** | 消息追加写日志文件，顺序 IO 吞吐远高于随机 IO |
| **PageCache** | 利用 OS 文件系统缓存，读写都不经过 JVM 堆 |
| **零拷贝（sendfile）** | 消费时直接从 PageCache → 网卡，不经用户态，减少 2 次数据拷贝 |
| **批量压缩** | Producer 端批量发送，支持 gzip/snappy/lz4，降低网络带宽 |
| **分区并行** | 多 Partition 多消费者并行处理，横向扩展吞吐 |

---

## 六、常见问题

### 消息丢失

| 阶段 | 原因 | 解决方案 |
|------|------|---------|
| 生产者 | `acks=0/1`，Leader 宕机 | `acks=all` + `min.insync.replicas=2` |
| Broker | 异步刷盘，宕机丢 PageCache | 同步刷盘 或 多副本 + 禁止非 ISR 选举 |
| 消费者 | 自动提交 Offset 后处理失败 | 关闭自动提交，改为手动 ACK |

### 重复消费

Consumer Rebalance 或消费者崩溃重启都会导致重复消费，必须在业务层保证幂等（见 `0_mq.md` 幂等消费方案）。

### 消息积压

```
原因：消费速度 < 生产速度
处理：
1. 临时扩容消费者（不超过 Partition 数）
2. 增加 Partition 数（需停服迁移）
3. 积压过多时：批量跳过到最新 Offset（丢数据，需业务允许）
4. 长期优化：消费者逻辑异步化、批量处理（@KafkaListener batchListener=true）
```

### Consumer Rebalance

```
触发：消费者加入/离开 Group、心跳超时、订阅 Topic 变化

影响：Rebalance 期间所有消费者暂停消费（Stop the World）

优化：
- 增大 session.timeout.ms 和 heartbeat.interval.ms
- 使用 Cooperative Sticky Assignor（Kafka 2.4+）减少全量重分配
- 避免消费者长时间阻塞（max.poll.interval.ms 内必须 poll）
```

---

## 七、Kafka Streams

Kafka Streams 是 Kafka 内置的**流处理库**（非独立集群），以普通 Java 应用方式部署，直接消费和生产 Kafka Topic。

### 核心概念

| 概念 | 说明 |
|------|------|
| **KStream** | 无界数据流，每条记录代表一个事件（INSERT 语义）|
| **KTable** | 变更日志流，相同 key 的新记录覆盖旧值（UPSERT 语义）|
| **GlobalKTable** | 全量广播的 KTable，每个实例都有完整副本，用于流-表 JOIN |
| **Topology** | 处理拓扑，由 Source → Processor → Sink 节点组成 |
| **State Store** | 本地 RocksDB 状态存储，支持窗口聚合、JOIN 等有状态操作 |
| **Task** | 并行处理单元，一个 Partition 对应一个 Task |

### 快速示例：订单金额实时聚合

```java
@Bean
public KStream<String, OrderEvent> orderStream(StreamsBuilder builder) {
    // 读取 Source Topic
    KStream<String, OrderEvent> stream = builder.stream(
        "order-events",
        Consumed.with(Serdes.String(), orderSerde())
    );

    // 过滤 + 分组 + 窗口聚合：统计每分钟每用户的订单金额
    stream
        .filter((key, order) -> order.getStatus().equals("PAID"))
        .groupBy((key, order) -> order.getUserId(),
                 Grouped.with(Serdes.String(), orderSerde()))
        .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(1)))
        .aggregate(
            () -> BigDecimal.ZERO,
            (userId, order, total) -> total.add(order.getAmount()),
            Materialized.<String, BigDecimal, WindowStore<Bytes, byte[]>>as("user-order-amount-store")
                .withKeySerde(Serdes.String())
                .withValueSerde(bigDecimalSerde())
        )
        .toStream()
        .to("user-order-stats", Produced.with(windowedSerde(), bigDecimalSerde()));

    return stream;
}
```

```yaml
spring:
  kafka:
    streams:
      application-id: order-stats-app    # 消费者 Group ID，多实例水平扩展
      bootstrap-servers: localhost:9092
      properties:
        default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.value.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        commit.interval.ms: 1000         # 状态刷盘间隔
        num.stream.threads: 4            # 处理线程数
```

### KStream vs KTable JOIN

```java
KStream<String, Order> orders = builder.stream("orders");
KTable<String, User>   users  = builder.table("users");

// Stream-Table JOIN：每条订单携带用户信息（KTable 本地查询）
KStream<String, EnrichedOrder> enriched = orders.join(
    users,
    (order, user) -> new EnrichedOrder(order, user),
    Joined.with(Serdes.String(), orderSerde(), userSerde())
);
```

### 适用场景

| 场景 | 说明 |
|------|------|
| 实时统计 / 排行榜 | 窗口聚合，每分钟/每小时 Top N |
| 流式 ETL | 过滤 → 转换 → 写入目标 Topic |
| 事件驱动聚合 | 订单 + 用户 JOIN 生成宽表 |
| 异常检测 | 滑动窗口统计，触发告警 |

> Kafka Streams vs Flink：数据量百万级 / 无需跨语言 → Kafka Streams；超大数据量 / 复杂 CEP / 批流一体 → Flink。

---

## 八、Kafka Connect

Kafka Connect 是 Kafka 内置的**数据管道框架**，无需编写代码即可将外部系统的数据导入/导出 Kafka。

### 核心概念

| 概念 | 说明 |
|------|------|
| **Source Connector** | 从外部系统读取数据写入 Kafka（如 MySQL → Kafka）|
| **Sink Connector** | 从 Kafka 消费数据写入外部系统（如 Kafka → Elasticsearch）|
| **Worker** | Connect 运行进程，支持 Standalone / Distributed 两种模式 |
| **Task** | Connector 的并行执行单元，Task 数 = 并行度 |
| **Converter** | 数据格式转换（JSON / Avro / Protobuf），与 Schema Registry 配合 |

### Debezium：MySQL CDC → Kafka

Debezium 是最常用的 Source Connector，基于 MySQL Binlog 实现变更数据捕获（CDC）：

```json
{
  "name": "mysql-cdc-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "mysql",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "dbz",
    "database.server.id": "1",
    "database.server.name": "dbserver1",
    "database.include.list": "inventory",
    "table.include.list": "inventory.orders",
    "database.history.kafka.bootstrap.servers": "kafka:9092",
    "database.history.kafka.topic": "schema-changes.inventory"
  }
}
```

每条 Binlog 变更会产生一条 Kafka 消息，路由到 Topic `dbserver1.inventory.orders`：

```json
{
  "op": "u",           // c=insert, u=update, d=delete, r=snapshot
  "before": { "id": 1, "amount": 100 },
  "after":  { "id": 1, "amount": 200 },
  "source": { "ts_ms": 1700000000000, "table": "orders" }
}
```

### Sink：Kafka → Elasticsearch

```json
{
  "name": "es-sink-connector",
  "config": {
    "connector.class": "io.confluent.connect.elasticsearch.ElasticsearchSinkConnector",
    "tasks.max": "4",
    "topics": "dbserver1.inventory.orders",
    "connection.url": "http://elasticsearch:9200",
    "type.name": "_doc",
    "key.ignore": "false",
    "schema.ignore": "true"
  }
}
```

### 部署模式对比

| 模式 | 适用场景 | 说明 |
|------|---------|------|
| **Standalone** | 开发 / 测试 | 单进程，配置写文件，不支持水平扩展 |
| **Distributed** | 生产 | 多 Worker 自动负载均衡，REST API 管理 Connector |

```bash
# Distributed 模式下通过 REST API 管理
curl -X POST http://connect:8083/connectors \
  -H "Content-Type: application/json" \
  -d @mysql-cdc-connector.json

# 查看 Connector 状态
curl http://connect:8083/connectors/mysql-cdc-connector/status
```

### 典型架构

```
MySQL ──Debezium──→ Kafka ──ES Sink──→ Elasticsearch（搜索）
                       └──Flink/Streams──→ ClickHouse（分析）
                       └──JDBC Sink──→ 数仓
```

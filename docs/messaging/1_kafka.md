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

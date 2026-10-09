---
description: KRaft 架构、可靠性配置、死信与幂等消费、事务、顺序、积压与 Rebalance、Streams / Connect
---

# Kafka

> **本篇目标**：理解 Kafka 4.x 的架构与核心概念，能在 Spring Boot 中写出不丢消息、失败可重试可兜底、消费幂等的生产与消费代码，并能处理积压、Rebalance、扩分区等线上问题。
>
> **前置阅读**：[消息队列基础](./1_basics)

> 参考资料：
> * 官方文档：[https://kafka.apache.org/documentation/](https://kafka.apache.org/documentation/)
> * Spring for Apache Kafka：[https://spring.io/projects/spring-kafka](https://spring.io/projects/spring-kafka)
> * Debezium：[https://debezium.io/documentation/](https://debezium.io/documentation/)

Kafka 本质是一个**分布式、分区、多副本的提交日志**：消息按分区顺序追加、按 offset 读取、按保留策略删除，消费不删消息。这一点决定了它的大部分行为——高吞吐、可回放、分区内有序，以及「offset 是累计提交的」。

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

---

## 二、Spring Boot 快速接入

Spring Boot 3.x 对应 spring-kafka 3.x，Boot 4.x 对应 spring-kafka 4.x，版本由 Boot 依赖管理，无需手写。中间件接入的通用做法见 [Spring Boot · 中间件集成](/spring-boot/5_middleware)。

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
      acks: all                       # 等待 ISR 全部确认（3.0+ 默认即 all）
      batch-size: 32768
      compression-type: lz4
      properties:
        linger.ms: 10                 # 攒批等待时间，提升吞吐
        enable.idempotence: true      # 3.0+ 默认开启，显式写出防止被其他配置关掉
        delivery.timeout.ms: 120000   # 一次 send 的总超时（含重试），代替手调 retries
    consumer:
      group-id: order-processor
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      auto-offset-reset: earliest     # 新 Group 无 offset 时从最早消息开始
      enable-auto-commit: false       # 由 Spring 容器在处理成功后提交
      max-poll-records: 200
    listener:
      ack-mode: record                # 每条处理成功后提交；默认 batch 为每批处理完提交
```

**不要再写 `retries: 3`**：开启幂等后 `retries` 默认为 `Integer.MAX_VALUE`，真正控制「最多重试多久」的是 `delivery.timeout.ms`。把 `retries` 调小只会让本可以自动恢复的抖动（Leader 切换、网络闪断）变成发送失败。

### 1、生产者

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderEventProducer {
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    public CompletableFuture<SendResult<String, String>> sendOrderCreated(Order order) throws JsonProcessingException {
        String payload = objectMapper.writeValueAsString(order);
        // key = orderId：同一订单的消息落到同一分区，保证分区内有序
        return kafkaTemplate.send("order-events", order.getId().toString(), payload)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    // delivery.timeout.ms 内的自动重试都失败了才会走到这里
                    log.error("Kafka send failed, orderId={}", order.getId(), ex);
                } else {
                    log.debug("Sent partition={} offset={}",
                        result.getRecordMetadata().partition(),
                        result.getRecordMetadata().offset());
                }
            });
    }
}
```

**发送失败不能靠回调里补救来保证一致性**——进程可能在回调前就挂了。业务库与消息需要一致时，用**本地消息表（Transactional Outbox）**：业务数据和待发消息在同一个本地事务里落库，由中继任务扫表发送、成功后标记，失败持续重试；或用 CDC（第十节的 Debezium）读取 outbox 表投递。不要在数据库事务内直接 `send()`，事务回滚了消息却已发出。详见 [分布式 · 分布式事务](/distributed/4_transaction)。

### 2、消费者

```java
@Component
@RequiredArgsConstructor
public class OrderEventConsumer {
    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    @KafkaListener(topics = "order-events", groupId = "order-processor",
                   concurrency = "3")   // 3 个消费线程，超过分区数的线程会空闲
    public void consume(ConsumerRecord<String, String> record) throws Exception {
        OrderEvent event = objectMapper.readValue(record.value(), OrderEvent.class);
        orderService.handle(event);     // 内部做幂等，见第四节
        // 正常返回 → 容器提交 offset；抛异常 → 交给 DefaultErrorHandler 重试 / 进死信
    }
}
```

消费方法**正常返回即成功、抛异常即失败**，不要自己 catch 后吞掉。失败处理和幂等是第四节的重点。

---

## 三、消息可靠性

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

关闭自动提交，由 Spring 容器在**处理成功后**提交 offset；处理失败抛异常，交给错误处理器（见第四节）。自动提交是「到时间就提交」，处理失败或进程崩溃时消息就被跳过了。

### 4、丢失原因速查

| 环节 | 原因 | 解决方案 |
|------|------|---------|
| 生产者 | `acks=0/1`，Leader 宕机 | `acks=all` + `min.insync.replicas=2` |
| 生产者 | 发送失败只打日志 / 进程在回调前退出 | 本地消息表，中继重试 |
| Broker | 副本不足、非 ISR 副本当选 Leader | 3 副本 + `unclean.leader.election.enable=false` |
| 消费者 | 自动提交后处理失败；catch 住异常不抛 | 关闭自动提交，失败抛出，走重试 + 死信 |

---

## 四、消费失败处理与幂等消费

### 1、offset 是累计的：不 ack 不等于会重投

**Kafka 按分区只记录一个「已消费到的位置」，提交 offset=N 表示 N 之前全部处理完毕。** 所以：

- 第 5 条失败后不 ack、第 6 条成功并提交，第 5 条就**一起被确认**了，不会重新投递
- 消费者在同一个分区上会继续往后拉，不会因为某条没 ack 就停下或回头
- 只有 Rebalance 或重启时，才会从「最后一次提交的位置」重新拉取——这是重复消费的来源，不是失败重试机制

因此「失败了不 ack，等它重投」在 Kafka 里是错误的做法。正确的做法是：**抛异常 → 错误处理器在原地重试（seek 回失败位置）→ 重试耗尽送进死信 Topic → 提交 offset 继续往后**。

### 2、DefaultErrorHandler + DeadLetterPublishingRecoverer

```java
@Configuration
public class KafkaErrorConfig {

    @Bean
    public DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
        // 重试耗尽后发到 <原 topic>.DLT 的同一分区（死信 Topic 分区数不能少于原 Topic）
        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(template);

        // 指数退避：最多重试 4 次，间隔 1s、2s、4s、8s
        ExponentialBackOffWithMaxRetries backOff = new ExponentialBackOffWithMaxRetries(4);
        backOff.setInitialInterval(1000);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(10000);

        DefaultErrorHandler handler = new DefaultErrorHandler(recoverer, backOff);
        // 重试也没用的异常，直接进死信
        handler.addNotRetryableExceptions(JsonProcessingException.class, IllegalArgumentException.class);
        return handler;
    }
}
```

Spring Boot 检测到 `CommonErrorHandler` 类型的 Bean 会自动装配到监听容器工厂。要点：

- **阻塞重试**：错误处理器把失败位置 seek 回去、退避后重新拉取，重试期间该分区后续消息等待，顺序不乱；单次退避间隔加上处理耗时要小于 `max.poll.interval.ms`，否则会触发 Rebalance
- **死信**：死信消息带有原 Topic、分区、offset、异常栈等 Header，便于排查；需要有消费者或告警盯着 DLT，修复后可重放
- **非阻塞重试**：对时延不敏感、允许乱序的场景可用 `@RetryableTopic`，失败消息转到重试 Topic 延迟处理，主分区不被卡住；代价是同一 key 的消息可能乱序

### 3、幂等消费

重复消费不可避免（生产者重试、Rebalance、重启从旧 offset 拉取），必须在业务层幂等。通用原则见 [消息队列基础](./1_basics) 与 [系统架构 · 幂等设计](/architecture/5_idempotence)，这里给出 Kafka 下的推荐写法。

**去重键用业务键（订单号 + 事件类型），不要用 `partition + offset`**：同一业务事件被生产者重发时会拿到新的 offset，按 offset 去重拦不住；数据迁移、Topic 重建后 offset 也会变。

**方案 A：业务写入与去重记录放在同一个本地事务（首选）**

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final ConsumeRecordMapper consumeRecordMapper;  // consume_record 表，biz_key 唯一索引
    private final OrderMapper orderMapper;

    @Transactional
    public void handle(OrderEvent event) {
        String bizKey = event.getOrderId() + ":" + event.getType();
        // INSERT IGNORE（MySQL）/ ON CONFLICT DO NOTHING（PostgreSQL），与业务更新同一事务
        if (consumeRecordMapper.insertIgnore(bizKey) == 0) {
            return;                               // 已处理过：直接返回，offset 正常提交
        }
        orderMapper.markPaid(event.getOrderId());
        // 业务失败抛异常 → 去重记录一起回滚 → 错误处理器重试时可以再次处理
    }
}
```

**方案 B：Redis 状态机（业务不在同一个库时）**

1. `SET dedup:{bizKey} processing NX EX 60`：设置成功才开始处理
2. 处理成功后把值改为 `done`，并设置较长过期时间
3. 处理失败时 `DEL` 该 key 再抛异常，重试或重投时可以重新处理
4. 抢占失败时读值：`done` 直接返回；`processing` 说明有别的实例正在处理，**抛异常让错误处理器退避重试，不能当作成功跳过**

**错误做法**：先 `SETNX` 占位、再处理、失败也不清理——处理失败后这条消息再也进不去，等于丢消息。

---

## 五、幂等生产者与事务（Exactly-Once）

### 1、幂等生产者：单分区不重复

开启 `enable.idempotence`（3.0+ 默认）后，Broker 为每个生产者分配 PID，并按分区记录序列号，**重试导致的重复写入会被 Broker 丢弃**，同时在 `max.in.flight.requests.per.connection ≤ 5` 时保持分区内顺序。

它的范围有限：只保证**单个生产者会话、单个分区**内不重复。应用重启后重新 `send` 同一业务消息、或业务层主动重发，幂等生产者都拦不住，下游仍需幂等消费。

### 2、事务：多分区原子写入

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: order-tx-   # 配置后 Boot 自动启用事务并装配 KafkaTransactionManager
    consumer:
      isolation-level: read_committed    # 只读已提交事务的消息，默认 read_uncommitted
```

```java
// 多条消息要么都可见，要么都不可见
kafkaTemplate.executeInTransaction(ops -> {
    ops.send("order-events", orderId, created);
    ops.send("inventory-events", skuId, deduct);
    return true;
});
```

- 事务通过 `transactional.id` 识别同一个生产者，重启后会**隔离（fence）**掉旧实例未完成的事务，防止「僵尸生产者」继续写
- 消费方必须设置 `read_committed`，否则会读到未提交或已回滚事务里的消息

### 3、consume-transform-produce：Kafka 内的 Exactly-Once

「从 Topic A 读 → 计算 → 写 Topic B」时，把**写出的消息与消费 offset 的提交放进同一个事务**（`sendOffsetsToTransaction`），就能做到端到端恰好一次：要么输出和 offset 一起提交，要么一起回滚后重新消费。

在 Spring 中，配置了 `transaction-id-prefix` 后，监听容器会在 Kafka 事务中执行监听方法，方法内的 `kafkaTemplate.send()` 加入该事务，容器在提交前自动把 offset 发送进事务。Kafka Streams 设置 `processing.guarantee=exactly_once_v2` 即可获得同样的语义。

**边界**：Exactly-Once 只覆盖 **Kafka → Kafka**。监听方法里写数据库、调外部接口等副作用不在 Kafka 事务内，事务回滚重试时仍会重复执行，依然要按第四节做幂等。

---

## 六、顺序消息

**Kafka 只保证同一分区内有序。** 需要有序的消息用同一个 key 发送（如 orderId），落到同一分区。

```java
kafkaTemplate.send("order-events", orderId.toString(), payload);
```

**消费端不需要 `concurrency=1`**：容器的每个消费线程负责若干分区，单个分区始终只由一个线程串行处理，`concurrency=3` 依然保证每个分区内有序，只是不同分区之间并行。真正会破坏顺序的情况：

- **消费者内部异步化**：在监听方法里把消息丢给线程池处理，同一分区的消息就并发了。确需并行时按 key 哈希到固定的单线程队列，并在全部处理完成后再提交 offset
- **生产者重试乱序**：关闭了幂等且 `max.in.flight.requests.per.connection > 1` 时，第一批失败重试、第二批先成功，就会乱序。保持幂等开启即可
- **key 选错或为空**：key 为空时消息按粘性策略分散到各分区，不同步骤可能落到不同分区
- **扩分区**：`hash(key) % 分区数` 变化，同一 key 前后落到不同分区，见第八节
- **非阻塞重试 / 死信重放**：失败消息转到重试 Topic 后，后续消息先被处理；严格有序的业务要用阻塞重试

全局有序只能用单分区，吞吐也就锁定在单分区的处理能力，一般只做到「业务键维度有序」。

---

## 七、高性能原理

| 机制 | 说明 |
|------|------|
| **顺序追加写** | 消息追加写入分段日志文件，顺序 IO 吞吐远高于随机 IO |
| **PageCache** | 读写都走操作系统页缓存，不占 JVM 堆；刚写入的数据通常直接从缓存读到 |
| **零拷贝（sendfile）** | 消费时数据从 PageCache 直接送到网卡，不经过用户态，省去两次拷贝和上下文切换 |
| **批量与压缩** | 生产者按分区攒批（`batch.size` / `linger.ms`），整批压缩（lz4 / zstd），Broker 原样存储，消费者解压 |
| **分区并行** | 多分区分布在多个 Broker 上，生产与消费都能水平扩展 |

**零拷贝的前提**：Broker 要原样转发磁盘上的字节。启用 **TLS 后数据必须在用户态加密，sendfile 不再生效**，CPU 与内存拷贝开销会明显上升，容量评估时要考虑。应用层（Netty）的零拷贝是另一层概念，见 [Netty · ByteBuf 与内存管理](/netty/6_bytebuf)。

---

## 八、常见问题

### 1、消息积压

积压的本质是**消费速度小于生产速度**。处理步骤：

- **先定位瓶颈**：看消费者 lag 是全部分区都涨还是个别分区涨。个别分区涨通常是热点 key 或某个实例卡住；全部涨才是整体消费能力不足
- **扩消费者实例**：同一 Group 的有效消费者数不超过分区数，超出的会空闲
- **扩分区**：消费者已和分区数相等时，增加分区再扩消费者。扩分区可在线执行，但会影响 key 的路由（见下文）
- **提升单条处理速度**：批量消费（`@KafkaListener(batch = "true")`）+ 批量写库、减少同步远程调用、优化慢 SQL
- **临时转储**：积压量巨大且消费逻辑无法快速提速时，先用一个轻量消费者把消息原样转到分区更多的临时 Topic，再用大量消费者并行处理
- **跳过（最后手段）**：业务允许丢弃时，用 `kafka-consumer-groups.sh --reset-offsets --to-latest` 重置 offset，被跳过的数据需要事后补偿

削峰本身的系统设计见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)。

### 2、Consumer Rebalance

**触发**：消费者加入或离开 Group、心跳超时（超过 `session.timeout.ms`）、两次 poll 间隔超过 `max.poll.interval.ms`、订阅的 Topic 或分区数变化。

**影响**：经典协议下的 Eager 再均衡会让所有消费者先放弃全部分区再重新分配，期间整个 Group 停止消费；未提交的 offset 会导致重复消费。

**优化**：

- **心跳参数**：`heartbeat.interval.ms` 不超过 `session.timeout.ms` 的 1/3（默认 3s 与 45s），保证超时前能发出多次心跳
- **防止处理超时**：单批处理时间要小于 `max.poll.interval.ms`（默认 5 分钟）。处理慢就调小 `max.poll.records`，而不是一味调大超时
- **经典协议用增量分配**：分配策略使用 `CooperativeStickyAssignor`，只迁移需要变动的分区，其余分区继续消费
- **静态成员**：设置 `group.instance.id`，滚动重启时在超时时间内回来不会触发 Rebalance
- **新消费者组协议（KIP-848）**：Kafka 4.0 正式可用，客户端设置 `group.protocol=consumer`。分配由 Broker 端协调者计算、增量下发，不再有全组同步屏障，单个成员变动不会让其他成员停顿。使用新协议时心跳、会话超时等参数改由 Broker 端的组配置控制，客户端的 `heartbeat.interval.ms`、`session.timeout.ms` 不再生效

### 3、增加分区

- **在线执行，无需停服**：`kafka-topics.sh --alter --topic order-events --partitions 12`，生产者和消费者刷新元数据后自动感知
- **分区只能增不能减**，需要减少只能新建 Topic 迁移
- **key 会重新映射**：新消息按新的分区数计算，同一 key 在扩容前后可能落到不同分区。扩容瞬间旧分区里还有未消费的该 key 消息，新分区的消息可能被先处理，造成短暂乱序
- **对顺序敏感时**：在业务低峰扩容；或短暂暂停相关生产者，等旧分区消费完毕后再恢复；更好的做法是建 Topic 时按峰值预留足够分区

### 4、共享组（Queues for Kafka）

KIP-932 引入的共享组（Share Group）让多个消费者可以协同消费同一分区，支持逐条确认和重投递，消费者数量不再受分区数限制，更接近传统队列语义。该特性从 4.0 起以早期访问 / 预览形式逐步提供，成熟度随版本变化，生产使用前请以所用版本的官方文档为准。

---

## 九、Kafka Streams

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

## 十、Kafka Connect

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

Debezium 是最常用的 CDC Source Connector，读取 MySQL binlog（需 `binlog_format=ROW`）把行变更写入 Kafka。CDC 工具的整体对比见 [数据库 · CDC 工具](/database/5_practice/0_cdc_tools)。以下为 Debezium 2.x 及以后的属性名：

```json
{
  "name": "mysql-cdc-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "mysql",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "${file:/opt/kafka/secrets/mysql.properties:password}",
    "database.server.id": "184054",
    "topic.prefix": "dbserver1",
    "database.include.list": "inventory",
    "table.include.list": "inventory.orders",
    "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
    "schema.history.internal.kafka.topic": "schema-changes.inventory"
  }
}
```

- `topic.prefix` 取代了 1.x 的 `database.server.name`，变更写入 `<topic.prefix>.<库名>.<表名>`，即 `dbserver1.inventory.orders`
- `schema.history.internal.kafka.*` 取代了 1.x 的 `database.history.kafka.*`，用于保存表结构变更历史
- `database.server.id` 是 Debezium 伪装成 MySQL 从库时使用的 server id，在复制拓扑中必须唯一
- 密码不要明文写进配置，用 Connect 的配置提供者（如 `FileConfigProvider`）引用外部文件

每条变更消息的 payload 结构：

```json
{
  "op": "u",
  "before": { "id": 1, "amount": 100 },
  "after":  { "id": 1, "amount": 200 },
  "source": { "ts_ms": 1700000000000, "db": "inventory", "table": "orders" }
}
```

`op` 取值：`c` 插入、`u` 更新、`d` 删除、`r` 快照读取。

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

- Kafka 4.0 起只有 KRaft 模式，元数据由 Controller 仲裁管理，不再依赖 ZooKeeper
- 可靠性三端配：`acks=all` + 幂等生产者（默认开启，靠 `delivery.timeout.ms` 控制重试），`replication.factor=3` + `min.insync.replicas=2` + 禁止 unclean 选举，消费端关闭自动提交；持久性靠副本，不靠强制刷盘
- offset 按分区累计提交，不 ack 不会重投；失败处理是抛异常 → `DefaultErrorHandler` 退避重试 → `DeadLetterPublishingRecoverer` 进死信
- 幂等消费用业务键：去重记录与业务写入同一事务，或 Redis 状态机失败时清理；不要用 offset 去重，不要先占位后处理
- 事务 + `read_committed` + offset 入事务实现 Kafka 内的 Exactly-Once，外部副作用仍需幂等
- 分区内天然串行，`concurrency` 不必为 1；乱序来自消费端异步化、关闭幂等的重试、扩分区与非阻塞重试
- Rebalance 优化：心跳不超过会话超时的 1/3、控制单批耗时、经典协议用 Cooperative Sticky + 静态成员，4.0 起可用 KIP-848 新协议
- 扩分区在线执行，但会改变 key 的分区映射；TLS 会让 sendfile 零拷贝失效

> 下一篇：[RocketMQ](./3_rocketmq) —— 事务消息、定时消息、顺序消息开箱即用，看看业务型消息队列如何设计。

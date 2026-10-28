---
description: Spring Kafka 接入、死信与幂等消费、事务与 Exactly-Once、顺序消息、积压与 Rebalance
---

# Kafka 生产与消费

> 前置阅读：[Kafka 架构与存储](./2_kafka)、[消息队列基础](./1_basics)

Kafka 的可靠收发最终落在客户端：生产者怎么发、消费者怎么提交 offset 与处理失败。本篇讲 Spring Boot 接入、死信与幂等消费、事务与 Exactly-Once、顺序消息、积压与 Rebalance，基线为 Kafka 4。

---

## 一、Spring Boot 快速接入

Spring Boot 3.x 对应 spring-kafka 3.x，Boot 4.x 对应 spring-kafka 4.x，版本由 Boot 依赖管理，无需手写。中间件接入的通用做法见 [Spring Boot · 中间件集成](/spring-boot/6_middleware)。

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

**不要再写 `retries: 3`**：开启幂等后 `retries` 默认为 `Integer.MAX_VALUE`，真正控制「最多重试多久」的是 `delivery.timeout.ms`。把 `retries` 调小只会让本可以自动恢复的抖动（Leader 切换、网络闪断）变成发送失败。`acks` 与 Broker 副本配置如何配合见 [Kafka 架构与存储 · 消息可靠性](./2_kafka#二、消息可靠性)。

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

**发送失败不能靠回调里补救来保证一致性**——进程可能在回调前就挂了。业务库与消息需要一致时，用**本地消息表（Transactional Outbox）**：业务数据和待发消息在同一个本地事务里落库，由中继任务扫表发送、成功后标记，失败持续重试；或用 CDC（[Kafka 架构与存储 · Kafka Connect](./2_kafka#六、kafka-connect) 中的 Debezium）读取 outbox 表投递。不要在数据库事务内直接 `send()`，事务回滚了消息却已发出。详见 [分布式 · 分布式事务](/distributed/4_transaction)。

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
        orderService.handle(event);     // 内部做幂等，见第二节
        // 正常返回 → 容器提交 offset；抛异常 → 交给 DefaultErrorHandler 重试 / 进死信
    }
}
```

消费方法**正常返回即成功、抛异常即失败**，不要自己 catch 后吞掉。失败处理和幂等是第二节的重点。

---

## 二、消费失败处理与幂等消费

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

重复消费不可避免（生产者重试、Rebalance、重启从旧 offset 拉取），必须在业务层幂等。两种正确写法（去重记录与业务同事务、Redis 处理中 / 已完成状态机）和「SETNX 占位即完成」的反模式统一见 [消息队列基础 · 幂等消费](/messaging/1_basics#四、幂等消费)，通用方案见 [系统架构 · 幂等设计](/architecture/3_idempotence)。Kafka 下要注意两点：

- **去重键用业务键（订单号 + 事件类型），不要用 `partition + offset`**：同一业务事件被生产者重发时会拿到新的 offset，按 offset 去重拦不住；数据迁移、Topic 重建后 offset 也会变
- **已处理过就正常返回，处理失败就抛异常**：返回后 offset 照常提交；抛异常交给上面的 `DefaultErrorHandler` 退避重试或进死信，看到「处理中」状态时同样抛异常，不能当作成功跳过（offset 是累计提交的，跳过就再也回不来）

---

## 三、幂等生产者与事务（Exactly-Once）

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

**边界**：Exactly-Once 只覆盖 **Kafka → Kafka**。监听方法里写数据库、调外部接口等副作用不在 Kafka 事务内，事务回滚重试时仍会重复执行，依然要按第二节做幂等。

---

## 四、顺序消息

**Kafka 只保证同一分区内有序**，按业务键路由、消费端串行这些通用做法见 [消息队列基础 · 顺序消息](/messaging/1_basics#五、顺序消息)。Kafka 侧的具体落点：

```java
kafkaTemplate.send("order-events", orderId.toString(), payload);   // 消息 key = 业务键，同 key 同分区
```

- **key 不能为空**：key 为空时消息按粘性策略分散到各分区，同一业务的不同步骤可能落到不同分区
- **生产端保持幂等开启**：关闭幂等且 `max.in.flight.requests.per.connection > 1` 时，第一批失败重试、第二批先成功就会乱序；开启幂等（3.0+ 默认）且 in-flight ≤ 5 时 Broker 按序列号保序
- **消费端不需要 `concurrency=1`**：单个分区始终只由容器的一个线程串行处理，`concurrency=3` 只是让不同分区并行
- **严格有序用阻塞重试**：`@RetryableTopic` 非阻塞重试或死信重放会让后续消息先被处理；扩分区对 key 路由的影响见 [Kafka 架构与存储 · 增加分区](./2_kafka#_1、增加分区)

---

## 五、常见问题

### 1、消息积压

通用的排查与处置清单见 [消息队列基础 · 消息积压](/messaging/1_basics#六、消息积压)，Kafka 侧的工具与开关：

- **看 Lag**：`kafka-consumer-groups.sh --describe --group <group>` 按分区列出 `LAG`，个别分区涨多是热点 key 或某个实例卡住，全部涨才是整体消费能力不足
- **扩容上限**：同一 Group 的有效消费者数不超过分区数；扩分区可在线执行，但会改变 key 的路由（见 [Kafka 架构与存储 · 增加分区](./2_kafka#_1、增加分区)）
- **批量消费**：`@KafkaListener(batch = "true")` + 批量写库，配合调大 `max.poll.records`（单批耗时仍要小于 `max.poll.interval.ms`）
- **跳过（最后手段）**：业务允许丢弃时用 `kafka-consumer-groups.sh --reset-offsets --to-latest --execute` 重置 offset（需先停掉该组消费者），被跳过的数据事后补偿

### 2、Consumer Rebalance

**触发**：消费者加入或离开 Group、心跳超时（超过 `session.timeout.ms`）、两次 poll 间隔超过 `max.poll.interval.ms`、订阅的 Topic 或分区数变化。

**影响**：经典协议下的 Eager 再均衡会让所有消费者先放弃全部分区再重新分配，期间整个 Group 停止消费；未提交的 offset 会导致重复消费。

**优化**：

- **心跳参数**：`heartbeat.interval.ms` 不超过 `session.timeout.ms` 的 1/3（默认 3s 与 45s），保证超时前能发出多次心跳
- **防止处理超时**：单批处理时间要小于 `max.poll.interval.ms`（默认 5 分钟）。处理慢就调小 `max.poll.records`，而不是一味调大超时
- **经典协议用增量分配**：分配策略使用 `CooperativeStickyAssignor`，只迁移需要变动的分区，其余分区继续消费
- **静态成员**：设置 `group.instance.id`，滚动重启时在超时时间内回来不会触发 Rebalance
- **新消费者组协议（KIP-848）**：Kafka 4.0 正式可用，客户端设置 `group.protocol=consumer`。分配由 Broker 端协调者计算、增量下发，不再有全组同步屏障，单个成员变动不会让其他成员停顿。使用新协议时心跳、会话超时等参数改由 Broker 端的组配置控制，客户端的 `heartbeat.interval.ms`、`session.timeout.ms` 不再生效

扩分区与共享组（Queues for Kafka）见 [Kafka 架构与存储 · 常见问题](./2_kafka#四、常见问题)。

---

## 小结

- 生产端 `acks=all` + 幂等生产者（默认开启），重试时长由 `delivery.timeout.ms` 控制，不要手调 `retries`；业务库与消息要一致时用本地消息表
- offset 按分区累计提交，不 ack 不会重投；失败处理是抛异常 → `DefaultErrorHandler` 退避重试 → `DeadLetterPublishingRecoverer` 进死信
- 幂等消费用业务键：去重记录与业务写入同一事务，或 Redis 状态机失败时清理；不要用 offset 去重，不要先占位后处理
- 事务 + `read_committed` + offset 入事务实现 Kafka 内的 Exactly-Once，外部副作用仍需幂等
- 分区内天然串行，`concurrency` 不必为 1；乱序来自消费端异步化、关闭幂等的重试、扩分区与非阻塞重试
- 积压先按分区看 Lag，有效消费者数不超过分区数；Rebalance 优化：心跳不超过会话超时的 1/3、控制单批耗时、经典协议用 Cooperative Sticky + 静态成员，4.0 起可用 KIP-848 新协议

## 参考资料

- 官方文档：[https://kafka.apache.org/documentation/](https://kafka.apache.org/documentation/)
- Spring for Apache Kafka：[https://spring.io/projects/spring-kafka](https://spring.io/projects/spring-kafka)

> 下一篇：[RocketMQ](./3_rocketmq) —— 事务消息、定时消息、顺序消息开箱即用，看看业务型消息队列如何设计。

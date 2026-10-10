---
description: Mutiny 与 Reactor、Kafka 响应式消息、ack 与失败策略、事件总线、虚拟线程
---

# 响应式与消息

> 前置阅读：[REST 与数据访问](./2_rest_data)、[WebFlux](/spring/8_webflux)、[Kafka](/messaging/2_kafka)

Quarkus 的响应式编程基于 Mutiny，消息集成基于 SmallRye Reactive Messaging。本篇讲 Mutiny 用法与线程语义及与 Reactor 的差异、可靠的 Kafka 消费与生产、事件总线的适用范围，以及何时用虚拟线程代替响应式写法。

---

## 一、Mutiny：Quarkus 的响应式 API

### 1、两个类型

| 类型 | 含义 | 对应 Reactor |
|------|------|--------------|
| `Uni<T>` | 最多发出一个结果或一个失败 | `Mono<T>` |
| `Multi<T>` | 发出 0..N 个元素，可能无限，支持背压 | `Flux<T>` |

Mutiny 是**事件驱动**风格的 API：先用 `onItem()`、`onFailure()`、`ifNoItem()` 选择「对哪个事件做反应」，再选择动作。这让 IDE 补全更有引导性，操作符数量也比 Reactor 少得多。

```java
import io.smallrye.mutiny.Uni;
import java.time.Duration;

// orderClient / customerClient 为注入的 REST Client（返回 Uni 的方法）
// OrderView 提供 (OrderDto, CustomerDto) 构造器与无参静态方法 degraded()
public Uni<OrderView> loadOrderView(long orderId) {
    Uni<OrderDto> order = orderClient.getAsync(orderId)
            .memoize().indefinitely();                         // 缓存结果，避免重复调用
    Uni<CustomerDto> customer = order.flatMap(o -> customerClient.getAsync(o.customerId()));

    return Uni.combine().all().unis(order, customer)
            .with(OrderView::new)                              // 两个结果都到达后组合
            .ifNoItem().after(Duration.ofSeconds(2)).fail()    // 整体超时
            .onFailure(TransientException.class)
                .retry().withBackOff(Duration.ofMillis(100), Duration.ofSeconds(1)).atMost(3)
            .onFailure().recoverWithItem(OrderView::degraded); // 兜底
}
```

上面 `order` 会被订阅两次（一次在组合里，一次在 `flatMap` 里）。**Uni 是惰性的，每次订阅都会重新执行**，不加 `memoize()` 就会调用两次订单服务。这是从命令式思维转过来最常见的错误之一，Reactor 的 `Mono` 也有同样的问题（对应 `cache()`）。另一种写法是改成串行 `flatMap` 链，把前一步结果传下去。

### 2、和 Reactor 的差异

| 维度 | Mutiny | Reactor |
|------|--------|---------|
| API 风格 | 事件分组：`onItem().transform()`、`onFailure().retry()` | 扁平操作符：`map`、`retryWhen` |
| 常用简写 | `map`、`flatMap`、`invoke`、`call` 作为快捷方式 | 原生扁平 |
| 操作符数量 | 少，偏向可读性 | 多，表达能力强 |
| 生态 | Quarkus、Vert.x Mutiny 绑定、Hibernate Reactive | Spring WebFlux、R2DBC、Spring Data Reactive |
| 互操作 | 都实现 Reactive Streams，可通过 `mutiny-reactor` 互转 | 同左 |
| 阻塞等待 | `uni.await().atMost(Duration)` | `mono.block(Duration)` |

### 3、线程语义

Mutiny **不会自己切换线程**：元素在哪个线程上发出，后续的操作符就在哪个线程上执行。在 Quarkus 中这通常是 Vert.x 的事件循环线程。

- `emitOn(executor)`：之后的下游处理切换到指定线程池，相当于 Reactor 的 `publishOn`
- `runSubscriptionOn(executor)`：订阅动作（通常是阻塞的数据源调用）在指定线程池执行，相当于 `subscribeOn`
- 在 Quarkus 中需要线程池时注入 `@Inject ManagedExecutor` 或使用 `Infrastructure.getDefaultWorkerPool()`

**包装阻塞调用的正确做法**：

```java
import io.smallrye.mutiny.Uni;
import io.smallrye.mutiny.infrastructure.Infrastructure;

public Uni<String> legacySign(byte[] payload) {
    return Uni.createFrom().item(() -> legacySdk.sign(payload))   // 阻塞的老 SDK
              .runSubscriptionOn(Infrastructure.getDefaultWorkerPool());
}
```

不加 `runSubscriptionOn` 的话，阻塞调用会直接跑在事件循环上。

---

## 二、Kafka 响应式消息

### 1、模型：通道（Channel）

![SmallRye Reactive Messaging 的 Kafka 消费链路](../assets/quarkus/quarkus-kafka-flow.svg)

SmallRye Reactive Messaging 实现了 MicroProfile Reactive Messaging 规范，核心是**通道**：

- `@Incoming("orders")`：从通道接收消息
- `@Outgoing("order-events")`：方法返回值发送到通道
- `@Channel("xxx") Emitter<T>`：在命令式代码（如 REST 端点）中向通道发消息
- 通道通过配置绑定到连接器（Kafka、AMQP、RabbitMQ、Pulsar 等），业务代码不依赖具体 MQ

扩展为 `quarkus-messaging-kafka`。没有配置 `kafka.bootstrap.servers` 时，Dev Services 会在 dev / test 模式下自动启动一个 Kafka 容器（默认是上游 Apache Kafka 原生镜像）。

### 2、消费

```java
import io.smallrye.reactive.messaging.kafka.Record;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.transaction.Transactional;
import org.eclipse.microprofile.reactive.messaging.Incoming;

@ApplicationScoped
public class PaymentEventConsumer {

    @Inject
    OrderService orderService;

    @Incoming("payment-events")
    @Transactional                       // @Transactional 自动视为阻塞，在 Worker 线程执行
    public void onPayment(Record<String, PaymentEvent> record) {
        // 业务幂等：以 paymentId 去重，与业务更新同一事务
        orderService.markPaid(record.value().orderId(), record.value().paymentId());
    }
}
```

```properties
mp.messaging.incoming.payment-events.connector=smallrye-kafka
mp.messaging.incoming.payment-events.topic=payment.events
mp.messaging.incoming.payment-events.group.id=order-service
mp.messaging.incoming.payment-events.auto.offset.reset=earliest
# 失败策略：进死信主题
mp.messaging.incoming.payment-events.failure-strategy=dead-letter-queue
mp.messaging.incoming.payment-events.dead-letter-queue.topic=payment.events.dlq
# 消费并发：分区在多个消费者之间分配
mp.messaging.incoming.payment-events.concurrency=3
%prod.kafka.bootstrap.servers=kafka-0:9092,kafka-1:9092,kafka-2:9092
```

`PaymentEvent` 的反序列化器可由 Quarkus 根据方法签名自动推导（Jackson），复杂情况下用 `value.deserializer` 显式指定。

### 3、确认（ack）与提交（commit）

这一层是理解 Quarkus Kafka 可靠性的关键：**业务代码只负责 ack / nack，什么时候真正提交 offset 由提交策略决定**。

| 方法签名 | 默认确认策略 |
|----------|--------------|
| 接收 payload 或 `Record` | `POST_PROCESSING`：方法正常返回后 ack，抛异常则 nack |
| 接收 `Message<T>` | `MANUAL`：必须自己调用 `message.ack()` / `nack()` |
| 返回 `CompletionStage` / `Uni` 或流 | 异步结果完成或下游确认后 ack |

可用 `@Acknowledgment` 改为 `PRE_PROCESSING`（收到即确认）或 `NONE`，前者意味着处理失败也不会重投，一般不用。

提交策略（`commit-strategy`）：

| 策略 | 说明 |
|------|------|
| `throttled` | 默认（`enable.auto.commit=false` 时）。跟踪每条消息的确认，**只提交连续确认的最大 offset**，周期性提交；某条消息超过 `throttled.unprocessed-record-max-age.ms`（默认 60 秒）未确认，连接器被标记为不健康 |
| `latest` | 消息一确认就提交其 offset（大于已提交值时），提交频繁、开销大 |
| `ignore` | 不由连接器提交，配合 `enable.auto.commit=true`（自动提交，可能丢消息） |
| `checkpoint` | 实验性，把处理状态存到外部存储 |

`throttled` 的语义和 Spring Kafka 的「按分区累计提交」一致：中间某条消息没确认，后面的 offset 都不会提交，重启后从未确认处重投——所以**消费端必须幂等**。

### 4、失败策略

| `failure-strategy` | 行为 |
|--------------------|------|
| `fail` | 默认。nack 后通道失败，应用标记为不健康，停止消费 |
| `ignore` | 记录日志后继续，相当于丢弃 |
| `dead-letter-queue` | 发送到死信主题（默认 `dead-letter-topic-<通道名>`），带上失败原因头部 |
| `delayed-retry-topic` | 发送到延迟重试主题，按配置的延迟重新消费，超过次数后进死信 |

默认的 `fail` 对线上服务很危险：一条毒消息就能让整个消费停下来。生产环境通常的组合是：

1. 方法内对瞬时错误做有限次重试（如 `@Retry`，来自 SmallRye Fault Tolerance）
2. 仍失败则 nack，`failure-strategy=dead-letter-queue` 兜底
3. 死信主题配监控告警和人工 / 自动补偿流程

### 5、线程与顺序

- `@Incoming` 方法默认在 **I/O 线程**上调用，阻塞操作必须加 `@Blocking`、`@Transactional` 或 `@RunOnVirtualThread`
- `@Blocking` 默认 `ordered = true`：同一通道内串行执行，保证顺序；`@Blocking(ordered = false)` 允许并发处理，但会打破分区内顺序
- 吞吐不够时优先加 `concurrency`（按分区拆给多个消费者），而不是关掉顺序保证
- `@RunOnVirtualThread` 也可用于 `@Incoming` 方法，适合每条消息都要调多个下游的场景，但要注意并发上限对下游的压力

### 6、生产

```java
import io.smallrye.reactive.messaging.kafka.Record;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.reactive.messaging.Channel;
import org.eclipse.microprofile.reactive.messaging.Emitter;
import java.util.concurrent.CompletionStage;

@ApplicationScoped
public class OrderEventPublisher {

    @Inject
    @Channel("order-events")
    Emitter<Record<String, OrderEvent>> emitter;

    public CompletionStage<Void> publish(OrderEvent event) {
        // 以 orderId 为 key，保证同一订单的事件进入同一分区、保持顺序
        return emitter.send(Record.of(event.orderId(), event));
    }
}
```

```properties
mp.messaging.outgoing.order-events.connector=smallrye-kafka
mp.messaging.outgoing.order-events.topic=order.events
mp.messaging.outgoing.order-events.acks=all
```

- `send` 返回的 `CompletionStage` 在 Broker 确认后完成，**需要可靠投递时要等待或处理它的失败**，不能发完就忘
- Emitter 内部有缓冲区，下游跟不上时会溢出报错，可用 `@OnOverflow` 配置策略
- 「数据库写入 + 发消息」的一致性问题不能靠 Emitter 解决，仍需事务消息或 Outbox 模式，见 [Kafka](/messaging/2_kafka)

---

## 三、事件总线

### 1、用法

Quarkus 暴露了 Vert.x 的事件总线，用于**应用内**组件之间的异步解耦：

```java
import io.quarkus.vertx.ConsumeEvent;
import io.smallrye.common.annotation.Blocking;
import io.smallrye.mutiny.Uni;
import io.vertx.mutiny.core.eventbus.EventBus;
import io.vertx.mutiny.core.eventbus.Message;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

@ApplicationScoped
public class InvoiceHandlers {

    @Inject
    InvoiceService invoiceService;

    @ConsumeEvent("invoice.generate")
    @Blocking                                   // 默认在事件循环上执行，阻塞逻辑需标注
    public String generate(InvoiceRequest req) {
        return invoiceService.render(req);      // 返回值作为 request 的回复
    }
}

@ApplicationScoped
public class InvoiceFacade {

    @Inject
    EventBus bus;

    public Uni<String> generateAsync(InvoiceRequest req) {
        return bus.<String>request("invoice.generate", req)
                  .map(Message::body);
    }

    public void notifyGenerated(long invoiceId) {
        bus.publish("invoice.generated", invoiceId);   // 广播给所有消费者
    }
}
```

三种发送方式：`send`（点对点，单个消费者）、`publish`（广播）、`request`（请求-响应）。

### 2、适用边界

- 默认是**进程内**总线，不持久化：进程重启、消费者异常，消息就丢了
- 适合：把阻塞工作从 I/O 线程卸载出去、应用内模块解耦、本地事件通知
- 不适合：跨服务通信、需要可靠投递或重放的业务事件——这些应该走 Kafka 等 MQ
- Vert.x 支持集群模式的事件总线（见 [Vert.x 概览](/vertx/1_basics)），但在 Quarkus 业务系统中很少使用

---

## 四、虚拟线程：响应式之外的选择

响应式写法的收益是用少量线程承载大量并发 I/O，代价是代码可读性、调试、异常栈、上下文传播都变难。JDK 21 的虚拟线程用同步写法达到了相近的资源利用率：

| 维度 | 响应式（Mutiny） | 虚拟线程 |
|------|------------------|----------|
| 编程模型 | 链式异步，需要全链路非阻塞驱动 | 同步代码，可以用 JDBC 等阻塞驱动 |
| 调试与异常栈 | 栈不连续，排查困难 | 普通调用栈 |
| 背压 | `Multi` 原生支持 | 需要自己用信号量、有界队列控制 |
| 流式处理（SSE、无限流） | 天然适合 | 不擅长 |
| 并发上限 | 由事件循环与驱动控制 | 不限，需显式限流 |
| JDK 要求 | 无 | 21+，24+ 解决 `synchronized` 钉住 |

在 Quarkus 中的落地：

- REST 端点、`@Incoming` 方法、定时任务（Scheduler）、gRPC 服务都支持 `@RunOnVirtualThread`
- 在虚拟线程里需要调用返回 `Uni` 的 API 时，直接 `uni.await().atMost(...)`，阻塞的是虚拟线程而不是载体线程
- 用 `quarkus.virtual-threads.name-prefix` 设置线程名前缀，便于在线程转储中识别

一个务实的分工：**请求-响应式的业务逻辑优先用同步写法（Worker 线程或虚拟线程），流式处理、消息管道、网关类组件用 Mutiny**。

---

## 小结

- Mutiny 的 `Uni` / `Multi` 对应 Reactor 的 `Mono` / `Flux`，API 按事件分组；Uni 是惰性的，重复订阅会重复执行
- Mutiny 不自动切换线程，阻塞调用用 `runSubscriptionOn` 卸载到 Worker 池
- Kafka 响应式消息以通道为中心：业务代码只管 ack / nack，`throttled` 策略按连续确认的 offset 提交，消费端必须幂等
- 默认失败策略 `fail` 会让通道停摆，生产改为有限重试 + `dead-letter-queue`
- `@Blocking` 默认保持顺序，提高吞吐优先加 `concurrency`；生产端要处理 `send` 的结果
- 事件总线是进程内、非持久的，只用于应用内解耦与卸载阻塞工作
- 请求-响应式业务优先同步写法 + 虚拟线程，流式与消息管道用 Mutiny
- Reactor 的执行模型、背压、调度器等通用概念已在 [WebFlux](/spring/8_webflux) 中展开，Kafka 本身的可靠性配置、幂等消费、Exactly-Once 见 [Kafka](/messaging/2_kafka)。

## 参考资料

- Mutiny：[https://smallrye.io/smallrye-mutiny/](https://smallrye.io/smallrye-mutiny/)
- Quarkus 中的 Mutiny：[https://quarkus.io/guides/mutiny-primer](https://quarkus.io/guides/mutiny-primer)
- Kafka 响应式消息：[https://quarkus.io/guides/kafka](https://quarkus.io/guides/kafka)
- Kafka Dev Services：[https://quarkus.io/guides/kafka-dev-services](https://quarkus.io/guides/kafka-dev-services)
- 事件总线：[https://quarkus.io/guides/reactive-event-bus](https://quarkus.io/guides/reactive-event-bus)
- 虚拟线程：[https://quarkus.io/guides/virtual-threads](https://quarkus.io/guides/virtual-threads)

> 下一篇：[从 Spring Boot 迁移](./5_from_spring) —— 概念一一对照、兼容扩展能帮多少、迁移步骤与坑，以及什么时候不值得迁。

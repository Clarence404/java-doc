---
description: Exchange 四种类型、发布确认与回退、手动 ACK 与重试、死信与延迟消息、Quorum 队列、Streams
---

# RabbitMQ

> 前置阅读：[消息队列基础](./1_basics)

RabbitMQ 是 AMQP 0-9-1 的经典实现，强项是**灵活路由**和**低延迟**，适合消息量中等、路由规则多的业务事件与任务分发场景。本篇讲 Exchange 路由模型、Spring Boot 中的发布确认 / 消费重试 / 死信、4.x 的 Quorum 队列与 Streams，以及延迟消息的两种实现。

---

## 一、核心概念

**生产者从不直接把消息投到队列，而是投给 Exchange，由 Exchange 按 Binding 规则路由到一个或多个 Queue。**

![RabbitMQ 路由模型](../assets/messaging/rabbitmq-routing.svg)

| 概念 | 说明 |
|------|------|
| **Exchange** | 消息入口，按类型和 Binding 规则把消息分发到 Queue，本身不存消息 |
| **Queue** | 存储消息的缓冲区，消费者从队列取消息；类型有 classic / quorum / stream |
| **Binding** | Exchange 与 Queue 之间的绑定关系，带 Binding Key |
| **Routing Key** | 生产者发送时携带的路由标识，与 Binding Key 匹配 |
| **VHost** | 虚拟主机，隔离不同业务的 Exchange / Queue / 权限（类似命名空间）|
| **Connection / Channel** | 一个 TCP 连接上可开多个轻量 Channel，复用连接，减少资源消耗 |
| **DLX** | 死信交换机，被拒绝 / 过期 / 超长的消息由它转发到死信队列 |

---

## 二、Exchange 四种类型

| 类型 | 路由规则 | 适用场景 |
|------|---------|---------|
| **Direct** | Routing Key 与 Binding Key 完全相等 | 点对点，按业务类型路由 |
| **Fanout** | 广播给所有绑定的 Queue，忽略 Key | 系统通知、配置更新广播 |
| **Topic** | 按 `.` 分词做模式匹配：`*` 匹配恰好一个词，`#` 匹配零个或多个词 | 多维度订阅（区域、事件类型、日志级别）|
| **Headers** | 按消息 Header 属性匹配（`x-match=all/any`），不用 Routing Key | 复杂条件路由（少用，性能较差）|

Topic 匹配示例（Routing Key = `order.created.cn`）：

| Binding Key | 是否匹配 | 原因 |
|-------------|---------|------|
| `order.#` | 匹配 | `#` 匹配 `created.cn` 两个词 |
| `order.*.cn` | 匹配 | `*` 恰好匹配 `created` 一个词 |
| `order.*` | 不匹配 | `*` 只能匹配一个词，后面还剩 `cn` |
| `payment.#` | 不匹配 | 首个词不同 |

---

## 三、Docker 单机安装

```yaml
services:
  rabbitmq:
    image: rabbitmq:4-management
    container_name: rabbitmq
    hostname: rabbitmq          # 数据目录按节点名区分，固定 hostname 避免重建容器后"丢数据"
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: change_me
    ports:
      - "5672:5672"    # AMQP 协议端口
      - "15672:15672"  # 管理控制台
    volumes:
      - ./rabbitmq_data:/var/lib/rabbitmq
    restart: always
```

> 延迟消息插件、Stream 协议端口（5552）等按需另行启用，见第六、七节。

---

## 四、Spring Boot 接入

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-amqp</artifactId>
</dependency>
```

```yaml
spring:
  rabbitmq:
    host: localhost
    port: 5672
    username: admin
    password: change_me
    virtual-host: /
    publisher-confirm-type: correlated   # 发布确认：Broker 收下消息后回调
    publisher-returns: true              # 消息无法路由到任何队列时回退
    template:
      mandatory: true                    # 回退的前提，见下文
    listener:
      simple:
        acknowledge-mode: auto           # 推荐：成功自动 ack，异常走重试 + 死信
        prefetch: 10                     # 每个消费者最多未确认 10 条，防止过载
        default-requeue-rejected: false  # 异常时不重新入队（否则会死循环），交给 DLX
        retry:
          enabled: true                  # 消费端本地重试（带退避）
          max-attempts: 4                # 含首次，共 4 次
          initial-interval: 1s
          multiplier: 2
          max-interval: 10s
```

### 1、声明 Exchange + Queue + Binding

业务队列声明为 **Quorum 队列**并挂上死信交换机，`deliveryLimit` 为毒消息兜底（第七节详述）：

```java
@Configuration
public class RabbitMQConfig {

    public static final String ORDER_EXCHANGE    = "order.exchange";
    public static final String ORDER_QUEUE       = "order.queue";
    public static final String ORDER_ROUTING_KEY = "order.created";

    public static final String DLX_EXCHANGE = "order.dlx.exchange";
    public static final String DLX_QUEUE    = "order.dlq";

    @Bean
    public TopicExchange orderExchange() {
        return new TopicExchange(ORDER_EXCHANGE, true, false);
    }

    @Bean
    public Queue orderQueue() {
        return QueueBuilder.durable(ORDER_QUEUE)
            .quorum()                                   // Raft 复制队列
            .deliveryLimit(5)                           // 投递超过 5 次 → 死信
            .deadLetterExchange(DLX_EXCHANGE)
            .deadLetterRoutingKey("order.dead")
            .build();
    }

    @Bean
    public Binding orderBinding(TopicExchange orderExchange, Queue orderQueue) {
        return BindingBuilder.bind(orderQueue).to(orderExchange).with(ORDER_ROUTING_KEY);
    }

    @Bean
    public DirectExchange dlxExchange() {
        return new DirectExchange(DLX_EXCHANGE, true, false);
    }

    @Bean
    public Queue dlxQueue() {
        return QueueBuilder.durable(DLX_QUEUE).quorum().build();
    }

    @Bean
    public Binding dlxBinding(DirectExchange dlxExchange, Queue dlxQueue) {
        return BindingBuilder.bind(dlxQueue).to(dlxExchange).with("order.dead");
    }
}
```

> 队列参数一经声明不可修改，改参数需要新建队列迁移，或用 Policy 下发（Policy 可动态调整，优先推荐）。

### 2、生产者：发布确认与回退

**两个回调解决两个不同问题：confirm 回答"Broker 收没收到"，return 回答"有没有队列能接"。**

| 回调 | 触发时机 | 前提配置 |
|------|---------|---------|
| `ConfirmCallback` | Broker 处理完消息后回 ack / nack（持久化消息落盘或 Quorum 多数派写入后才 ack）| `publisher-confirm-type: correlated` |
| `ReturnsCallback` | 消息到达 Exchange 但**没有任何队列匹配** | `publisher-returns: true` **且** `mandatory=true` |

注意两点：

* **不可路由的消息照样会收到 confirm ack**（Broker 已"处理"完——丢掉了），只靠 confirm 发现不了路由错误，必须配合 returns。
* `mandatory=false` 时不可路由的消息被静默丢弃，ReturnsCallback 永远不会触发。Spring Boot 在 `publisher-returns: true` 且未显式配置时会把 mandatory 设为 true；**自己 new RabbitTemplate 时必须手动 `setMandatory(true)`**。

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderMessageProducer {
    private final RabbitTemplate rabbitTemplate;
    private final OutboxRepository outboxRepository;

    @PostConstruct
    public void init() {
        rabbitTemplate.setConfirmCallback((correlationData, ack, cause) -> {
            if (ack) {
                outboxRepository.markSent(correlationData.getId());   // 本地消息表标记已发送
            } else {
                log.error("消息未被 Broker 确认: {}, cause: {}", correlationData.getId(), cause);
                // 不在这里同步重发，交给本地消息表的定时补偿任务
            }
        });
        rabbitTemplate.setReturnsCallback(returned ->
            log.error("消息无法路由: exchange={}, routingKey={}, reply={}",
                returned.getExchange(), returned.getRoutingKey(), returned.getReplyText()));
    }

    /** 由 outbox 投递任务调用，消息 id 即本地消息表主键 */
    public void send(OutboxMessage msg) {
        rabbitTemplate.convertAndSend(
            RabbitMQConfig.ORDER_EXCHANGE,
            RabbitMQConfig.ORDER_ROUTING_KEY,
            msg.getPayload(),
            new CorrelationData(msg.getId()));
    }
}
```

> **不要在数据库事务里直接发 MQ 来追求一致性**：事务回滚了消息却已发出，或事务提交了发送却失败。正确做法是**本地消息表（transactional outbox）**：业务数据和待发消息在同一个本地事务里写库，再由异步任务投递、confirm 后标记完成。也可以在事务提交后发送（`@TransactionalEventListener(phase = AFTER_COMMIT)`），但进程在提交后、发送前崩溃仍会丢，关键链路仍需 outbox 兜底。详见 [分布式 · 分布式事务](/distributed/4_transaction)。

### 3、消费者：自动 ACK + 重试 + 死信（推荐）

**消费失败最常见的坑是 `nack(requeue=true)` 无限重入队：一条处理不了的毒消息会在队头反复投递，CPU 打满、后面的消息全被堵住。** 正确姿势是"有限次数、带退避的重试，耗尽后拒绝进 DLX"。

用 `acknowledge-mode: auto` + 上面的 `retry` 配置时：

1. 方法正常返回 → 容器自动 ack。
2. 抛异常 → 在消费线程内按 1s、2s、4s 退避重试，共 4 次。
3. 重试耗尽 → Spring Boot 默认的 `RejectAndDontRequeueRecoverer` 以 `requeue=false` 拒绝 → 进入 DLX。

```java
@Component
@RequiredArgsConstructor
public class OrderConsumer {
    private final OrderService orderService;

    @RabbitListener(queues = RabbitMQConfig.ORDER_QUEUE)
    public void handleOrder(OrderCreatedEvent event) {
        orderService.handleCreated(event);   // 抛异常即触发重试，耗尽后进 DLX
    }
}
```

需要区分"可重试 / 不可重试"异常时（例如参数非法重试多少次都没用），自定义容器工厂的重试拦截器：

```java
@Bean
public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        SimpleRabbitListenerContainerFactoryConfigurer configurer, ConnectionFactory cf) {
    SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
    configurer.configure(factory, cf);
    factory.setAdviceChain(RetryInterceptorBuilder.stateless()
        .retryPolicy(new SimpleRetryPolicy(4,
            Map.of(BusinessException.class, false),   // 业务异常不重试
            true, true))                              // 按异常链匹配，默认其余异常可重试
        .backOffOptions(1000, 2.0, 10000)             // 初始 1s，×2，上限 10s
        .recoverer(new RejectAndDontRequeueRecoverer())
        .build());
    return factory;
}
```

> 本地重试会**占住消费线程**，退避时间不宜过长；需要分钟级的重试间隔时，改为"拒绝到重试队列（TTL + DLX 回流）"或延迟消息。上面的写法基于 Spring Boot 3.x（Spring AMQP 3.x + Spring Retry）；升级到 Spring Boot 4 / Spring AMQP 4 时重试相关 API 有调整，以对应版本文档为准。

### 4、消费者：手动 ACK

需要精确控制确认时机（例如批量处理后统一确认、异步处理完再确认）时用 `acknowledge-mode: manual`。此时 Spring 的重试拦截器不再帮你兜底，**每条消息必须且只能 ack / nack 一次**，否则会一直处于 unacked 状态，直到连接断开才重投：

```java
@RabbitListener(queues = RabbitMQConfig.ORDER_QUEUE, ackMode = "MANUAL")
public void handleOrder(OrderCreatedEvent event, Channel channel,
                        @Header(AmqpHeaders.DELIVERY_TAG) long deliveryTag,
                        @Header(name = "x-delivery-count", required = false) Long deliveryCount)
        throws IOException {
    try {
        orderService.handleCreated(event);
        channel.basicAck(deliveryTag, false);
    } catch (BusinessException e) {
        // 不可恢复：直接拒绝进 DLX
        channel.basicNack(deliveryTag, false, false);
    } catch (Exception e) {
        // 临时异常：Quorum 队列重新入队，x-delivery-count 累加，超过 deliveryLimit 自动进 DLX
        log.warn("处理失败, 第 {} 次投递, orderId={}", deliveryCount, event.orderId(), e);
        channel.basicNack(deliveryTag, false, true);
    }
}
```

* `requeue=true` 的重投是**立即发生、没有退避**的，只适合偶发抖动；它的安全前提是 Quorum 队列的 `delivery-limit` 兜底。Classic 队列没有投递次数上限，**不要在 classic 队列上对所有异常无条件 requeue**。
* `x-delivery-count` 由 Quorum 队列维护，可用于日志或分级处理（如超过 3 次就主动拒绝到 DLX）；首次投递时可能不带该头，所以参数要 `required = false` 并处理 null。

### 5、幂等消费

RabbitMQ 是至少一次投递：requeue、消费者崩溃、连接断开、生产者 confirm 超时重发，都会产生重复消息。**用业务键（如 `orderId + 事件类型`）而不是 Broker 的 messageId 去重**，并且"去重记录"与"业务写入"必须原子：

```java
@Transactional
public void handleCreated(OrderCreatedEvent event) {
    // 去重表对 (biz_key, consumer) 建唯一索引；与业务写入在同一个本地事务里
    int inserted = consumeRecordMapper.insertIgnore("order-created:" + event.orderId(), "order-service");
    if (inserted == 0) {
        return;   // 已处理过，直接返回（容器随后 ack）
    }
    inventoryService.reserve(event);   // 业务写入；异常则整个事务回滚，去重记录一起撤销，重投时可再处理
}
```

> 反例：先 `SETNX` 占位再处理——处理失败时占位已存在，重投会被当成"已处理"而跳过，消息就丢了。用 Redis 的话要做成状态机：`SET key processing NX EX` → 处理 → 置为 `done`；失败时 `DEL` 让重投能重试；看到 `processing` 的投递应退避重试而不是 ack 跳过。更多方案见 [系统架构 · 幂等设计](/architecture/5_idempotence)。

---

## 五、消息可靠性

**丢消息可能发生在三段链路上，每一段都要单独设防，缺一不可：**

| 环节 | 风险 | 措施 |
|------|------|------|
| 生产者 → Broker | 网络失败、Broker 未落盘、路由不到队列 | publisher confirm + returns（mandatory）+ 本地消息表补偿 |
| Broker 存储 | 节点宕机、磁盘损坏 | Exchange / Queue 声明为 durable，消息持久化（Spring AMQP 默认 `PERSISTENT`）；用 **Quorum 队列**做多副本 |
| Broker → 消费者 | 消费者收到后崩溃 | 处理成功后再 ack（auto 模式在方法返回后 ack，manual 模式业务完成后 ack），失败走有限重试 + DLX |

> Classic 队列即使持久化也是**单节点存储**，节点磁盘坏了就丢；需要高可用的业务队列一律用 Quorum。

---

## 六、死信队列（DLX）与延迟消息

### 1、死信的来源

消息在以下情况会变成死信，若队列配置了 `x-dead-letter-exchange` 就被转发到 DLX，否则直接丢弃：

1. 消费者 `basicNack` / `basicReject` 且 `requeue=false`（包括 Spring 重试耗尽后的 `RejectAndDontRequeueRecoverer`）
2. 消息 TTL 过期
3. 队列超过最大长度（`x-max-length` / `x-max-length-bytes`，且 overflow 策略为默认的 `drop-head`）
4. Quorum 队列中投递次数超过 `delivery-limit`

死信消息头部会带上 `x-death`（原队列、原因、次数），死信队列消费者据此告警、记录、人工处理或修复后重新投递。

### 2、方案一：TTL + DLX

**给一个"没有消费者"的队列设置 TTL，消息过期后变成死信，被 DLX 转发到真正被消费的队列，从而实现延迟。** 适用场景：订单 30 分钟未支付自动关单。

![TTL + DLX 延迟消息](../assets/messaging/rabbitmq-delay-ttl-dlx.svg)

```java
@Bean
public Queue orderDelayQueue() {
    return QueueBuilder.durable("order.delay.queue")
        .ttl(30 * 60 * 1000)                              // 队列级 TTL：所有消息统一 30 分钟
        .deadLetterExchange("order.dlx.exchange")
        .deadLetterRoutingKey("order.timeout")
        .build();
}
// 另需声明 order.timeout.queue，并以 order.timeout 绑定到 order.dlx.exchange，关单消费者监听它
```

**最大的坑是队头阻塞**：

* **队列级 TTL**（`x-message-ttl`）：所有消息延迟相同，先进先过期，没有问题。
* **消息级 TTL**（发送时设 `expiration`）：RabbitMQ **只在消息到达队头时才检查是否过期**。若队头是一条 30 分钟的消息，后面 10 秒的消息要等它过期后才能被转发——延迟严重不准。
* 结论：用 TTL + DLX 时**一个延迟时长一个队列**（如 10s / 1min / 30min 三档），不要在同一队列混用不同的逐条 TTL。

### 3、方案二：延迟消息插件

`rabbitmq_delayed_message_exchange` 插件提供 `x-delayed-message` 类型的 Exchange，每条消息可指定任意延迟，到期才路由到队列，没有队头阻塞问题：

```bash
# 插件需与 RabbitMQ 版本匹配，从官方 GitHub Release 下载 .ez 放入 plugins 目录后启用
rabbitmq-plugins enable rabbitmq_delayed_message_exchange
```

```java
@Bean
public CustomExchange orderDelayedExchange() {
    return new CustomExchange("order.delayed.exchange", "x-delayed-message", true, false,
        Map.of("x-delayed-type", "direct"));   // 到期后按 direct 规则路由
}

public void sendCloseOrder(long orderId, Duration delay) {
    rabbitTemplate.convertAndSend("order.delayed.exchange", "order.timeout", orderId, m -> {
        m.getMessageProperties().setDelayLong(delay.toMillis());   // 设置 x-delay 头
        return m;
    });
}
```

插件的限制必须清楚：

* 延迟中的消息存在**插件自己的单节点存储**中，**不复制到其他节点**，该节点数据丢失则延迟消息丢失。
* 不适合大量（百万级）或超长延迟的消息；禁用插件会丢掉所有未到期消息。
* 消息到期前并未路由：开启 `mandatory` 时可能立即收到回退（需在 ReturnsCallback 里按延迟头过滤），而到期时真正的路由失败却无法回调给生产者。
* 插件并非核心组件，升级 RabbitMQ 大版本前要确认插件 README 中的兼容性说明。

| 对比 | TTL + DLX | 延迟插件 |
|------|-----------|---------|
| 延迟精度 | 队列级 TTL 准确；逐条 TTL 有队头阻塞 | 每条任意延迟，较准确 |
| 可靠性 | 延迟队列可用 Quorum，多副本 | 单节点存储，不复制 |
| 部署 | 无需插件 | 需安装匹配版本的插件 |
| 适用 | 少数几档固定延迟 | 延迟时长多变、量不大 |

> 大量、任意时间、强可靠的延迟需求，RocketMQ 5.x 的定时消息更合适，见 [RocketMQ](./3_rocketmq)；也可以用"数据库 + 定时扫描"做兜底。

---

## 七、高可用：Quorum 队列与 Streams

### 1、镜像队列已在 4.0 移除

**RabbitMQ 4.0 正式移除了经典镜像队列（Classic Mirrored Queues），需要复制的场景只剩两种队列类型：Quorum 队列和 Stream。** 3.x 时代的 `ha-mode` 策略在 4.x 不再生效，升级前必须先把镜像队列迁移到 Quorum。

| 对比 | Classic 队列 | Quorum 队列 | Stream |
|------|-------------|-------------|--------|
| 复制 | 无（单节点） | Raft 多副本，多数派写入才确认 | 多副本复制日志 |
| 消费语义 | 消费即删除 | 消费即删除 | 只追加日志，**非破坏性消费，可按 offset 回放** |
| 毒消息保护 | 无 | `delivery-limit`（4.0 起默认 20）| 不适用（不 requeue）|
| 适用 | 临时、可丢、排他、自动删除的队列 | **业务队列的默认选择** | 大扇出、回放、海量堆积 |

### 2、Quorum 队列

* 基于 Raft：一个 leader + 若干 follower，写入需多数派确认；节点宕机时自动选举新 leader，消息不丢。
* 副本数建议奇数（3 或 5），可用 `x-quorum-initial-group-size` 指定；3 副本可容忍 1 个节点故障。
* 始终持久化，不支持非持久、排他、自动删除；对内存和磁盘 I/O 的要求高于 classic 队列。
* `delivery-limit`：消息投递次数超过上限即被死信（配置了 DLX 时）或丢弃，是防止毒消息无限 requeue 的最后一道闸。
* 死信默认是 at-most-once（转发失败就丢）；对死信可靠性有要求时可设置 `dead-letter-strategy: at-least-once`（需配合 `overflow: reject-publish`）。

```java
QueueBuilder.durable("order.queue")
    .quorum()
    .deliveryLimit(5)
    .deadLetterExchange("order.dlx.exchange")
    .build();
```

> 注意区分：`spring.rabbitmq.listener.simple.default-requeue-rejected: false` 不是队列属性，而是 **Spring 监听容器**的开关，决定监听方法抛异常时是否让 Broker 重新入队；`delivery-limit` 才是 Quorum 队列自身的兜底。两者配合使用，前者对任何队列类型都生效。

### 3、Streams：可回放的日志

**RabbitMQ 3.9 起提供 Stream 类型：消息只追加写入日志、按保留策略过期，消费后不删除，多个消费者可从任意 offset 独立读取。** 所以"RabbitMQ 不支持回放"的说法已过时——用 Stream 就能回放。

* 回放：消费时指定起点 `first` / `last` / `next` / 具体 offset / 时间戳。
* 保留策略：按大小（`x-max-length-bytes`）或时间（`x-max-age`）清理旧数据段。
* 分区：Super Stream（3.11 起）把一个逻辑流拆成多个分区 Stream，类似 Kafka 的分区。
* 访问方式：可用 AMQP 0-9-1 消费（需手动 ack、设置 prefetch，并通过消费者参数 `x-stream-offset` 指定起点），也可用原生 Stream 协议（端口 5552，Java 客户端 `stream-client`，Spring 侧为 `spring-rabbit-stream`），吞吐更高。

```java
@Bean
public Queue orderEventStream() {
    return QueueBuilder.durable("order.events")
        .stream()                                    // x-queue-type=stream
        .withArgument("x-max-age", "7D")             // 保留 7 天
        .build();
}
```

> Stream 适合审计、事件溯源、大扇出这类"一份数据多方读、需要重读"的场景；但其生态和海量吞吐仍不及 Kafka，日志型主链路仍建议选 [Kafka](./2_kafka)。

---

## 八、常见问题

### 1、消息丢失

开启 publisher confirm + returns（mandatory）、持久化 + Quorum 队列、处理成功后再 ack 三层保障，再用本地消息表补偿发送失败的消息，任何一层缺失都可能丢。

### 2、重复消费

requeue、消费者崩溃、连接断开、生产者重发都会造成重投。业务层必须幂等：业务键去重 + 与业务写入在同一本地事务（见第四节第 5 小节）。

### 3、消息积压

* **先止血**：确认消费者是否在报错——如果是毒消息在 requeue 循环，先修正重试策略或把它拒绝到 DLX，否则扩容也没用。
* **扩容消费者**：增加实例数或 `concurrency`；同一队列多个消费者是竞争消费，可直接水平扩展（需要保序的队列除外）。
* **调整 prefetch**：处理快的场景适当调大 prefetch 提升吞吐；处理慢、耗时不均时调小，避免消息压在某个慢消费者手里。
* **优化消费逻辑**：批量写库、减少同步远程调用，把慢操作异步化。
* **紧急分流**：写一个临时程序把积压消息快速转发到新建的多个队列，由更多消费者并行处理，事后再回收。
* **长期**：大量堆积会显著拖慢 classic / quorum 队列，海量堆积场景应考虑 Stream 或 Kafka。系统级削峰策略见 [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)。

### 4、消息顺序

单个队列本身是 FIFO，但**多个消费者竞争消费、或 requeue 重投**都会打乱处理顺序。需要保序时：同一业务键路由到同一个队列，并开启 `x-single-active-consumer`（同一时刻只有一个消费者在消费，其余待命做故障转移），代价是该队列吞吐受限于单个消费者。

---

## 小结

* RabbitMQ 的核心是 **Exchange 路由**：Direct 精确匹配、Fanout 广播、Topic 模式匹配（`*` 一个词，`#` 零或多个词）、Headers 按属性匹配。
* 生产端：confirm 确认 Broker 收下，returns（必须 mandatory=true）发现路由不到的消息；一致性靠本地消息表，不要在 DB 事务里直接发消息。
* 消费端：**禁止无限 requeue**，用 Spring 重试（带退避）+ `RejectAndDontRequeueRecoverer` 进 DLX，或用 Quorum 队列的 `delivery-limit` 兜底；幂等用业务键 + 本地事务去重。
* 4.0 起镜像队列已移除，**Quorum 队列（Raft）是复制队列的标准选择**；Stream（3.9+）提供只追加日志与按 offset 回放。
* 延迟消息：TTL + DLX 要按延迟时长分队列以避开队头阻塞；延迟插件灵活但单节点存储、不复制，不适合大量消息。
* 延迟低（通常亚毫秒到毫秒级）、路由灵活，但吞吐与堆积能力不如 Kafka / RocketMQ。

## 参考资料

- 官方文档：[https://www.rabbitmq.com/docs](https://www.rabbitmq.com/docs)
- Quorum Queues：[https://www.rabbitmq.com/docs/quorum-queues](https://www.rabbitmq.com/docs/quorum-queues)
- Streams：[https://www.rabbitmq.com/docs/streams](https://www.rabbitmq.com/docs/streams)
- Spring AMQP：[https://spring.io/projects/spring-amqp](https://spring.io/projects/spring-amqp)

> 下一篇：[其他 MQ](./5_other_mq) —— 三大 MQ 之外最常被比较的 Pulsar，以及其他常见消息系统的定位。

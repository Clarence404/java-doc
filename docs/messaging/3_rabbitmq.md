# RabbitMQ

> 参考资料：
> * 官方文档：[https://www.rabbitmq.com/docs](https://www.rabbitmq.com/docs)
> * Spring AMQP：[https://spring.io/projects/spring-amqp](https://spring.io/projects/spring-amqp)

---

## 一、核心概念

```
Producer → Exchange → Binding → Queue → Consumer
```

| 概念 | 说明 |
|------|------|
| **Exchange** | 消息入口，根据路由规则将消息分发到绑定的 Queue |
| **Queue** | 消息存储缓冲区，消费者从此拉取消息 |
| **Binding** | Exchange 与 Queue 之间的绑定关系，含路由键（Routing Key）|
| **Routing Key** | 生产者发送消息时携带的路由标识 |
| **VHost** | 虚拟主机，隔离不同业务的资源（类似命名空间）|
| **Channel** | 连接上的轻量级虚拟信道，复用 TCP 连接，减少资源消耗 |

---

## 二、Exchange 四种类型

| 类型 | 路由规则 | 适用场景 |
|------|---------|---------|
| **Direct** | Routing Key 完全匹配 | 点对点，按业务类型路由 |
| **Fanout** | 广播给所有绑定的 Queue，忽略 Key | 系统通知、配置更新广播 |
| **Topic** | Routing Key 模式匹配（`*` 匹配一词，`#` 匹配多词）| 日志分级路由（`log.error.*`）|
| **Headers** | 根据消息 Header 属性匹配，不用 Routing Key | 复杂条件路由（少用）|

```
Topic 示例：
Routing Key = "order.created.cn"
绑定规则 "order.#"    → 匹配（# 匹配任意多词）
绑定规则 "order.*.cn" → 匹配（* 匹配一词）
绑定规则 "payment.#"  → 不匹配
```

---

## 三、Docker 单机安装

```yaml
services:
  rabbitmq:
    image: rabbitmq:3.13-management
    container_name: rabbitmq
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: admin123
    ports:
      - "5672:5672"    # AMQP 协议端口
      - "15672:15672"  # 管理控制台
    volumes:
      - ./rabbitmq_data:/var/lib/rabbitmq
    restart: always
```

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
    password: admin123
    virtual-host: /
    publisher-confirm-type: correlated   # 开启发布确认
    publisher-returns: true              # 开启消息回退
    listener:
      simple:
        acknowledge-mode: manual         # 手动 ACK
        prefetch: 10                     # 每次预取 10 条，避免消费者过载
```

### 声明 Exchange + Queue + Binding

```java
@Configuration
public class RabbitMQConfig {

    public static final String ORDER_EXCHANGE    = "order.exchange";
    public static final String ORDER_QUEUE       = "order.queue";
    public static final String ORDER_ROUTING_KEY = "order.created";

    // 死信 Exchange + Queue
    public static final String DLX_EXCHANGE = "order.dlx.exchange";
    public static final String DLX_QUEUE    = "order.dlx.queue";

    @Bean
    public TopicExchange orderExchange() {
        return new TopicExchange(ORDER_EXCHANGE, true, false);
    }

    @Bean
    public Queue orderQueue() {
        return QueueBuilder.durable(ORDER_QUEUE)
            .withArgument("x-dead-letter-exchange", DLX_EXCHANGE)  // 死信转发
            .withArgument("x-dead-letter-routing-key", "order.dead")
            .withArgument("x-message-ttl", 300_000)                // 消息 TTL 5 分钟
            .build();
    }

    @Bean
    public Binding orderBinding(TopicExchange orderExchange, Queue orderQueue) {
        return BindingBuilder.bind(orderQueue)
            .to(orderExchange)
            .with(ORDER_ROUTING_KEY);
    }

    @Bean
    public DirectExchange dlxExchange() {
        return new DirectExchange(DLX_EXCHANGE, true, false);
    }

    @Bean
    public Queue dlxQueue() {
        return QueueBuilder.durable(DLX_QUEUE).build();
    }

    @Bean
    public Binding dlxBinding(DirectExchange dlxExchange, Queue dlxQueue) {
        return BindingBuilder.bind(dlxQueue).to(dlxExchange).with("order.dead");
    }
}
```

### 生产者（含发布确认）

```java
@Service
public class OrderMessageProducer {
    private final RabbitTemplate rabbitTemplate;

    @PostConstruct
    public void init() {
        // 消息到达 Exchange 确认
        rabbitTemplate.setConfirmCallback((correlationData, ack, cause) -> {
            if (!ack) {
                log.error("Message not confirmed: {}, cause: {}", correlationData, cause);
                // 重试或写入本地消息表
            }
        });
        // 消息无法路由到 Queue 时回退
        rabbitTemplate.setReturnsCallback(returned -> {
            log.error("Message returned: {} routing key: {}",
                returned.getMessage(), returned.getRoutingKey());
        });
    }

    public void sendOrderCreated(Order order) {
        CorrelationData correlationData = new CorrelationData(order.getId().toString());
        rabbitTemplate.convertAndSend(
            RabbitMQConfig.ORDER_EXCHANGE,
            RabbitMQConfig.ORDER_ROUTING_KEY,
            order,
            correlationData
        );
    }
}
```

### 消费者（手动 ACK）

```java
@Component
public class OrderConsumer {

    @RabbitListener(queues = RabbitMQConfig.ORDER_QUEUE)
    public void handleOrder(Order order, Channel channel,
                            @Header(AmqpHeaders.DELIVERY_TAG) long deliveryTag) throws IOException {
        try {
            // 幂等检查
            if (!redis.opsForValue().setIfAbsent(
                    "rmq:processed:" + order.getId(), "1", Duration.ofDays(1))) {
                channel.basicAck(deliveryTag, false);
                return;
            }

            processOrder(order);
            channel.basicAck(deliveryTag, false);    // 确认处理成功

        } catch (BusinessException e) {
            // 业务异常：不重试，直接 nack 进死信队列
            channel.basicNack(deliveryTag, false, false);
        } catch (Exception e) {
            // 临时异常：requeue 重试
            channel.basicNack(deliveryTag, false, true);
        }
    }
}

// 死信队列消费者
@Component
public class DlxOrderConsumer {

    @RabbitListener(queues = RabbitMQConfig.DLX_QUEUE)
    public void handleDeadLetter(Order order, Channel channel,
                                 @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        log.error("Dead letter received for orderId={}", order.getId());
        alertService.notify("Dead letter: order " + order.getId());
        channel.basicAck(tag, false);
    }
}
```

---

## 五、消息可靠性

| 层次 | 措施 |
|------|------|
| 生产者 | `publisher-confirm-type: correlated` + `publisher-returns: true` |
| Broker | Queue 和消息声明为 `durable=true`，消息设 `deliveryMode=2`（持久化）|
| 消费者 | `acknowledge-mode: manual` + 手动 `basicAck/basicNack` |

---

## 六、死信队列（DLX）与延迟队列

**消息进入死信队列的三种情况：**
1. 消费者 `basicNack/basicReject`，且 `requeue=false`
2. 消息 TTL 过期未消费
3. 队列达到最大长度（`x-max-length`）

**利用 TTL + DLX 实现延迟队列：**

```
Producer → 正常 Queue（设置 TTL，无消费者）
                ↓ TTL 过期
           Dead Letter Exchange
                ↓
           延迟处理 Queue（真正的消费者在这里）
```

适用场景：订单 30 分钟未支付自动取消，在正常队列上设 `x-message-ttl=1800000`。

---

## 七、高可用：Quorum Queue

```yaml
# 推荐：Quorum Queue（Raft 共识，替代老版镜像队列）
spring:
  rabbitmq:
    listener:
      simple:
        default-requeue-rejected: false
```

```java
@Bean
public Queue quorumQueue() {
    return QueueBuilder.durable("order.queue.quorum")
        .quorum()          // 声明为 Quorum Queue（3 节点集群时自动 3 副本）
        .build();
}
```

| 对比 | 镜像队列（Classic Mirror）| Quorum Queue |
|------|------------------------|--------------|
| 一致性算法 | 无（主从异步）| Raft（强一致）|
| 性能 | 较好 | 略低但更安全 |
| 推荐 | 3.8 以前 | **3.8+ 推荐** |

---

## 八、常见问题

### 消息丢失

开启 `publisher-confirm` + Queue/Message 持久化 + 手动 ACK 三层保障，任何一层缺失都可能丢消息。

### 重复消费

`basicNack + requeue=true` 或消费者崩溃重启都会重投。业务层必须幂等，用 `messageId` 做去重。

### 消息积压

```
1. 扩容消费者实例
2. 调大 prefetch（批量拉取）
3. 紧急处理：临时将消息转移到更大的 Queue，批量消费后清理
```

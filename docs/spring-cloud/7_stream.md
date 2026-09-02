# Stream

- 官方文档：[https://docs.spring.io/spring-cloud-stream/reference/](https://docs.spring.io/spring-cloud-stream/reference/)
- MQ 本体（Kafka / RocketMQ / RabbitMQ 原理与选型）见 [消息队列模块](../messaging/0_mq)

## 一、解决什么问题

直接用 MQ 原生客户端的痛点：**业务代码和具体 MQ 深度耦合**——换 MQ 等于重写消息层，测试也必须起真实中间件。

Spring Cloud Stream 在中间加了一层 **Binder 抽象**：

```
业务代码（Function）→ Binding（逻辑通道）→ Binder（各 MQ 的适配器）→ Kafka / RabbitMQ / RocketMQ
```

业务只面向"输入/输出通道"编程，**换 MQ = 换 Binder 依赖 + 改配置**，代码不动。

| | 原生客户端 | Spring Cloud Stream |
|---|---|---|
| 耦合 | 直接依赖 KafkaTemplate / RocketMQTemplate | 面向 Function，零 MQ API |
| 换 MQ | 重写消息层 | 换依赖 + 配置 |
| 消费组/重试/死信 | 各 MQ 自己配 | 统一配置模型 |
| 精细特性（事务消息、顺序）| 全量可用 | 部分依赖 Binder 支持程度 |

---

## 二、函数式编程模型

Stream 3.x 起主推**函数式模型**（`@StreamListener` 已废弃）：三种函数对应三种角色，声明成 Bean 即完成绑定：

```java
@Configuration
public class OrderStreamConfig {

    // Supplier = 生产者（框架默认每秒轮询一次，也可命令式手动发）
    @Bean
    public Supplier<OrderEvent> orderPoller() {
        return () -> orderService.pollPending();
    }

    // Function = 处理器（消费 A 通道，产出到 B 通道）
    @Bean
    public Function<OrderEvent, SettleEvent> settle() {
        return order -> settleService.process(order);
    }

    // Consumer = 消费者
    @Bean
    public Consumer<SettleEvent> notify() {
        return event -> notifyService.send(event);
    }
}
```

```yaml
spring:
  cloud:
    function:
      definition: orderPoller;settle;notify    # 多个函数用分号列出
    stream:
      bindings:
        # 命名规则：<函数名>-<in/out>-<索引>
        orderPoller-out-0:
          destination: order-topic
        settle-in-0:
          destination: order-topic
          group: settle-group                   # 消费组：组内竞争消费
        settle-out-0:
          destination: settle-topic
        notify-in-0:
          destination: settle-topic
          group: notify-group
```

**命令式发送**（不想轮询时）用 `StreamBridge`：

```java
@Service
public class OrderService {
    @Resource
    private StreamBridge streamBridge;

    public void createOrder(Order order) {
        orderRepository.save(order);
        streamBridge.send("orderCreated-out-0", new OrderEvent(order.getId()));
    }
}
```

---

## 三、核心机制

### 1、消费组（Group）

不配 `group` 时每个实例都是独立订阅者（**广播**，且匿名组不持久化，重启丢消息）；配了 `group` 后同组实例**竞争消费**（同 Kafka Consumer Group 语义）。**生产环境必须显式配 group**。

### 2、分区（Partitioning）

跨 MQ 统一的分区抽象（RabbitMQ 这类原生无分区的也能用）：

```yaml
# 生产端：按 orderId 分区，保证同一订单的消息有序进同一分区
spring.cloud.stream.bindings.orderCreated-out-0.producer:
  partition-key-expression: payload.orderId
  partition-count: 8

# 消费端
spring.cloud.stream.bindings.settle-in-0.consumer:
  partitioned: true
spring.cloud.stream.instance-index: 0     # 每实例不同
spring.cloud.stream.instance-count: 2
```

### 3、重试与死信

```yaml
spring.cloud.stream.bindings.settle-in-0.consumer:
  max-attempts: 3                # 本地重试 3 次（默认 3）
spring.cloud.stream.rabbit.bindings.settle-in-0.consumer:
  auto-bind-dlq: true            # 重试耗尽进死信队列（Rabbit Binder 特性）
```

重试耗尽后的消息进入 DLQ，人工或定时任务兜底——处理思路与 [消息队列模块](../messaging/0_mq) 的死信设计一致。

---

## 四、切换 MQ 演示

从 RabbitMQ 切到 Kafka，业务代码零改动：

```xml
<!-- 之前 -->
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-stream-binder-rabbit</artifactId>
</dependency>

<!-- 之后：只换 Binder -->
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-stream-binder-kafka</artifactId>
</dependency>
```

官方维护 Rabbit / Kafka Binder；RocketMQ Binder 由 Spring Cloud Alibaba 提供（见 [SCA 落地实践](./6_alibaba)）。

---

## 五、选型判断

**适合用 Stream**：

- 消息逻辑是常规的发/收/组消费，希望保留换 MQ 的自由度
- 多套环境用不同 MQ（本地 Rabbit、云上 Kafka）
- 测试想用 Test Binder 免起中间件

**直接用原生客户端更好**：

- 重度依赖某 MQ 的独有特性：RocketMQ 事务消息/延迟等级、Kafka Streams 流处理、精确一次语义调优
- 团队已有成熟的原生封装，抽象层反而加了一层排查负担

> 经验法则：**用得越"标准"，Stream 越香；用得越"深"，越该直连原生。**

---

## 六、相关文档

- [消息队列模块（Kafka / RocketMQ / RabbitMQ 本体）](../messaging/0_mq)
- [Spring Cloud Alibaba（RocketMQ Binder）](./6_alibaba)
- [微服务通信模式（同步 vs 异步）](../microservices/2_patterns)

---
description: Binder 抽象、函数式编程模型、StreamBridge、消费组 / 分区 / 重试死信、切换 MQ、选型判断
---

# Spring Cloud Stream

> 前置阅读：[消息队列基础](/messaging/1_basics)

Spring Cloud Stream 用 Binder 抽象和函数式编程模型屏蔽具体 MQ 的差异。本篇讲生产者、处理器与消费者的生产配置（消费组、分区、重试与死信），以及何时该用 Stream、何时直连 MQ 原生客户端。

---

## 一、解决什么问题

直接用 MQ 原生客户端时，**业务代码和具体 MQ 深度耦合**：换 MQ 等于重写消息层，测试也必须起真实中间件。Spring Cloud Stream 在中间加了一层 Binder 抽象：

![Spring Cloud Stream Binder 抽象](../assets/spring-cloud/stream-binder.svg)

- **业务函数**：普通的 `Supplier` / `Function` / `Consumer` Bean，不出现任何 MQ API
- **Binding**：函数的输入输出与目标地址（destination）之间的逻辑通道，命名为 `<函数名>-in-<N>` / `<函数名>-out-<N>`
- **Binder**：各 MQ 的适配器，负责创建 Topic / Exchange、生产者与消费者

业务只面向通道编程，**换 MQ = 换 Binder 依赖 + 改配置**。

| 维度 | 原生客户端 | Spring Cloud Stream |
|------|-----------|---------------------|
| 耦合 | 直接依赖 `KafkaTemplate` / `RocketMQTemplate` | 面向函数，零 MQ API |
| 换 MQ | 重写消息层 | 换依赖与配置 |
| 消费组 / 重试 / 死信 | 各 MQ 各自配置 | 统一配置模型，Binder 专属能力另配 |
| 精细特性（事务消息、顺序、精确一次） | 全量可用 | 取决于 Binder 支持程度 |

Kafka、RocketMQ、RabbitMQ 本身的原理、可靠投递与幂等消费见 [消息队列总览](/messaging/0_overview)。

---

## 二、函数式编程模型

**注解模型（`@EnableBinding` / `@StreamListener` / `@Output`）在 Spring Cloud Stream 4.0（2022.0）中已被移除**，只剩函数式模型：三种函数对应三种角色，声明成 Bean 即完成绑定。

```java
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OrderStreamConfig {

    // Supplier = 生产者：框架默认每秒轮询一次，返回 null 时不发送
    @Bean
    public Supplier<OrderEvent> orderPoller(OrderOutboxService outboxService) {
        return outboxService::pollPending;
    }

    // Function = 处理器：消费一个通道，产出到另一个通道
    @Bean
    public Function<OrderEvent, SettleEvent> settle(SettleService settleService) {
        return settleService::process;
    }

    // Consumer = 消费者；方法名不能叫 notify，会与 Object.notify() 冲突而无法编译
    @Bean
    public Consumer<SettleEvent> notifyUser(NotifyService notifyService) {
        return notifyService::send;
    }
}
```

依赖通过 `@Bean` 方法参数注入，不需要在配置类里声明字段。

```yaml
spring:
  cloud:
    function:
      definition: orderPoller;settle;notifyUser   # 多个函数用分号分隔
    stream:
      bindings:
        orderPoller-out-0:
          destination: order-topic
        settle-in-0:
          destination: order-topic
          group: settle-group                     # 消费组：组内竞争消费
        settle-out-0:
          destination: settle-topic
        notifyUser-in-0:
          destination: settle-topic
          group: notify-group
```

**命令式发送**（由业务事件触发，而不是轮询）用 `StreamBridge`：

```java
import org.springframework.cloud.stream.function.StreamBridge;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final StreamBridge streamBridge;

    public OrderService(OrderRepository orderRepository, StreamBridge streamBridge) {
        this.orderRepository = orderRepository;
        this.streamBridge = streamBridge;
    }

    @Transactional
    public void createOrder(Order order) {
        orderRepository.save(order);
        // 绑定名不需要预先声明，首次发送时动态创建；可在配置中为它指定 destination
        streamBridge.send("orderCreated-out-0", new OrderEvent(order.getId()));
    }
}
```

在本地事务里直接发消息存在「事务回滚但消息已发出」或「事务提交但消息发送失败」的不一致，可靠做法是事务消息或 Outbox，见 [分布式事务](/distributed/4_transaction)。

---

## 三、核心机制

### 1、消费组（Group）

不配 `group` 时每个实例都是独立的匿名订阅者（广播，且匿名订阅不持久化，重启期间的消息会丢）；配了 `group` 后同组实例竞争消费（与 Kafka Consumer Group 语义一致）。**生产环境的每个消费 Binding 都必须显式配置 group。**

### 2、分区（Partitioning）

Stream 提供跨 MQ 的统一分区抽象（RabbitMQ 这类原生无分区的也能用），用于保证同一业务键的消息有序：

```yaml
spring:
  cloud:
    stream:
      instance-count: 2                 # 消费者实例总数
      instance-index: 0                 # 每个实例不同，K8s 中可从 StatefulSet 序号注入
      bindings:
        orderCreated-out-0:
          producer:
            partition-key-expression: payload.orderId   # 同一订单进同一分区
            partition-count: 8
        settle-in-0:
          consumer:
            partitioned: true
```

使用 Kafka Binder 时分区由 Kafka 原生管理，消费端通常不需要配置 `instance-index`，交给 Kafka 的分区分配即可。

### 3、重试与死信

```yaml
spring:
  cloud:
    stream:
      bindings:
        settle-in-0:
          consumer:
            max-attempts: 3                  # 本地重试次数（含首次），默认 3
            back-off-initial-interval: 1000
            back-off-multiplier: 2.0
      # Kafka Binder：重试耗尽后发送到死信 Topic
      kafka:
        bindings:
          settle-in-0:
            consumer:
              enable-dlq: true
              dlq-name: settle-topic.dlq     # 不配置时默认为 error.<destination>.<group>
      # RabbitMQ Binder：自动声明死信队列并绑定
      rabbit:
        bindings:
          settle-in-0:
            consumer:
              auto-bind-dlq: true
```

本地重试会阻塞当前消费线程，次数与间隔不宜过大；重试耗尽进入 DLQ 后由人工或定时任务兜底，处理思路与 [消息队列基础](/messaging/1_basics) 中的死信设计一致。消费逻辑必须幂等，重试与 Rebalance 都会导致重复投递。

---

## 四、切换 MQ

从 RabbitMQ 切到 Kafka，业务代码不变，只换 Binder 依赖并调整 Binder 专属配置：

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

- Spring 官方维护 Kafka、RabbitMQ Binder 及 Test Binder（`spring-cloud-stream-test-binder`，测试时不用启动中间件）
- RocketMQ Binder 由 Spring Cloud Alibaba 提供（`spring-cloud-starter-stream-rocketmq`），SCA 2025.1 对应 RocketMQ 5.3.1，见 [Spring Cloud Alibaba](./6_alibaba)
- 以 `spring.cloud.stream.kafka.*`、`spring.cloud.stream.rabbit.*` 开头的 Binder 专属配置需要同步迁移，死信、确认模式等语义并不完全等价，切换后要回归验证

---

## 五、选型判断

| 场景 | 建议 |
|------|------|
| 常规的发送、订阅、组消费，希望保留换 MQ 的自由度 | Spring Cloud Stream |
| 多套环境使用不同 MQ（本地 RabbitMQ、云上 Kafka） | Spring Cloud Stream |
| 希望用 Test Binder 免起中间件做单元测试 | Spring Cloud Stream |
| 重度依赖某个 MQ 的独有特性：RocketMQ 事务消息与定时消息、Kafka Streams、精确一次语义调优 | 原生客户端（Spring for Apache Kafka、RocketMQ 客户端） |
| 团队已有成熟的原生封装，抽象层只会增加排查负担 | 原生客户端 |

经验法则：**用得越标准，Stream 收益越大；用得越深，越该直连原生客户端。**

---

## 小结

- Stream 用 Binder 抽象屏蔽具体 MQ，业务只写 `Supplier` / `Function` / `Consumer`，Binding 名为 `<函数名>-in/out-<N>`
- `@StreamListener` 等注解模型已在 Stream 4.0 移除；多个函数用 `spring.cloud.function.definition` 声明
- 函数 Bean 不能命名为 `notify`、`wait` 等与 `Object` final 方法同名的名字；依赖通过 `@Bean` 方法参数注入
- 事件触发的发送用 `StreamBridge`，与本地事务的一致性用事务消息或 Outbox 解决
- 消费 Binding 必须配置 group；分区抽象保证同一业务键有序，Kafka Binder 下交给 Kafka 原生分区
- 重试耗尽进死信：Kafka 用 `enable-dlq`，RabbitMQ 用 `auto-bind-dlq`；消费逻辑必须幂等
- 用得标准选 Stream，依赖 MQ 独有特性选原生客户端

## 参考资料

- Spring Cloud Stream 参考文档：[https://docs.spring.io/spring-cloud-stream/reference/](https://docs.spring.io/spring-cloud-stream/reference/)
- Spring Cloud Function：[https://docs.spring.io/spring-cloud-function/reference/](https://docs.spring.io/spring-cloud-function/reference/)
- Kafka Binder：[https://docs.spring.io/spring-cloud-stream/reference/kafka/kafka-binder/usage.html](https://docs.spring.io/spring-cloud-stream/reference/kafka/kafka-binder/usage.html)

> 返回：[Spring Cloud 总览](./0_overview)

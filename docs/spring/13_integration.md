# Integration

> 参考资料：
> * Spring Integration 官方文档：[https://docs.spring.io/spring-integration/reference/](https://docs.spring.io/spring-integration/reference/)
> * Enterprise Integration Patterns：[https://www.enterpriseintegrationpatterns.com/](https://www.enterpriseintegrationpatterns.com/)

## 一、是什么

Spring Integration 是企业集成模式（EIP）的 Java 实现，用于构建**消息驱动的集成流**，连接不同系统、协议和数据源。

> 日常 CRUD 业务无需使用，适合多系统协议适配、异步数据管道场景。

---

## 二、核心概念

![Spring Integration 架构](../assets/spring/spring_integration_arch.svg)

| 概念 | 说明 |
|------|------|
| `Message` | 消息对象 = `MessageHeaders`（元数据）+ `Payload`（数据） |
| `MessageChannel` | 消息传输通道，发送方和接收方解耦 |
| `MessageEndpoint` | 处理消息的节点（过滤 / 转换 / 路由 / 聚合等） |
| `Adapter` | 与外部系统交互的出入口（文件 / HTTP / JMS / AMQP 等） |
| `Gateway` | 对外暴露同步接口，屏蔽消息细节 |

### Channel 类型

| 类型 | 说明 |
|------|------|
| `DirectChannel` | 同步点对点，默认类型 |
| `QueueChannel` | 异步缓冲，需要 Poller |
| `PublishSubscribeChannel` | 广播，多消费者同时接收 |
| `ExecutorChannel` | 在线程池中异步处理 |

---

## 三、依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-integration</artifactId>
</dependency>
<!-- 按需加入具体适配器 -->
<dependency>
    <groupId>org.springframework.integration</groupId>
    <artifactId>spring-integration-file</artifactId>
</dependency>
```

---

## 四、Java DSL 示例

### 4.1 文件监控 → 处理 → 归档

```java
@Configuration
@EnableIntegration
public class FileIntegrationConfig {

    @Bean
    public IntegrationFlow fileInboundFlow() {
        return IntegrationFlow
            // 1. 入站适配器：监控目录，每 5 秒轮询一次
            .from(Files.inboundAdapter(new File("/data/input"))
                      .patternFilter("*.csv"),
                  e -> e.poller(Pollers.fixedDelay(5000)))
            // 2. 转换：File → String（读取文件内容）
            .transform(Files.toStringTransformer())
            // 3. 路由到业务处理 Channel
            .channel("csvProcessingChannel")
            .get();
    }

    @Bean
    public IntegrationFlow csvProcessingFlow() {
        return IntegrationFlow
            .from("csvProcessingChannel")
            // 4. 拆分：按行分割
            .split(s -> s.applySequence(true))
            // 5. 过滤：跳过表头
            .filter(String.class, line -> !line.startsWith("id,"))
            // 6. 转换：CSV 行 → 业务对象
            .transform(String.class, this::parseCsvLine)
            // 7. 出站适配器：写入数据库
            .handle(this::saveToDatabase)
            .get();
    }

    private UserRecord parseCsvLine(String line) {
        String[] parts = line.split(",");
        return new UserRecord(Long.parseLong(parts[0]), parts[1], parts[2]);
    }

    @ServiceActivator
    private void saveToDatabase(UserRecord record) {
        // 调用 Repository 保存
    }
}
```

### 4.2 HTTP 入站 → MQ 出站

```java
@Bean
public IntegrationFlow httpToMqFlow() {
    return IntegrationFlow
        // HTTP 入站网关（接收 POST /events）
        .from(Http.inboundGateway("/events")
                  .requestMapping(m -> m.methods(HttpMethod.POST))
                  .requestPayloadType(EventDto.class))
        // 丰富消息头
        .enrichHeaders(h -> h.header("source", "http-gateway"))
        // 路由到 RabbitMQ 出站
        .handle(Amqp.outboundAdapter(rabbitTemplate())
                    .exchangeName("events.exchange")
                    .routingKey("event.created"))
        .get();
}
```

### 4.3 Gateway 接口（同步调用）

```java
// 定义网关接口，隐藏消息细节
@MessagingGateway
public interface OrderGateway {
    @Gateway(requestChannel = "orderChannel", replyChannel = "orderReplyChannel")
    OrderResult process(Order order);
}

// 调用方像调普通 Service 一样使用
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderGateway orderGateway;

    public OrderResult submitOrder(Order order) {
        return orderGateway.process(order);  // 内部走消息流
    }
}
```

---

## 五、常用 Endpoint 速查

| Endpoint | 作用 | DSL 方法 |
|----------|------|---------|
| `Transformer` | 转换消息 Payload | `.transform(...)` |
| `Filter` | 按条件丢弃消息 | `.filter(...)` |
| `Router` | 按条件路由到不同 Channel | `.route(...)` |
| `Splitter` | 将一条消息拆为多条 | `.split(...)` |
| `Aggregator` | 将多条消息合并为一条 | `.aggregate(...)` |
| `ServiceActivator` | 调用业务方法 | `.handle(...)` |
| `Bridge` | 连接两个 Channel | `.bridge()` |

---

## 六、与 Spring Cloud Stream 的区别

| 维度 | Spring Integration | Spring Cloud Stream |
|------|--------------------|---------------------|
| 定位 | 通用企业集成，支持文件/DB/HTTP/MQ | 专注云原生消息中间件 |
| 抽象层次 | 细粒度（Channel/Endpoint） | 粗粒度（Binding/Binder） |
| 适用 | 复杂多协议集成管道 | 微服务间 MQ 事件驱动 |
| 与 MQ 关系 | 通过 Adapter 接入 | 原生支持 Kafka / RabbitMQ |

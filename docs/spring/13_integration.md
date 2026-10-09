---
description: EIP 概念、Channel、Java DSL 文件与 HTTP 流、错误处理、Stream / Camel 对比
---

# Spring Integration

> **本篇目标**：理解企业集成模式（EIP）在 Spring Integration 中的落地方式（Message、Channel、Endpoint、Adapter），能用 Java DSL 写出可编译、行为正确的文件处理流与 HTTP→MQ 流，掌握错误处理与重试，并能在 Spring Integration、Spring Cloud Stream 与 Apache Camel 之间做出选择。
>
> **前置阅读**：[消息队列基础](/messaging/1_basics)、[Spring Batch 批处理](./12_batch)

> 参考资料：
> * Spring Integration 官方文档：[https://docs.spring.io/spring-integration/reference/](https://docs.spring.io/spring-integration/reference/)
> * Spring Integration 7.0 变化：[https://docs.spring.io/spring-integration/reference/changes-6.5-7.0.html](https://docs.spring.io/spring-integration/reference/changes-6.5-7.0.html)
> * Enterprise Integration Patterns：[https://www.enterpriseintegrationpatterns.com/](https://www.enterpriseintegrationpatterns.com/)
> * Apache Camel 用户手册：[https://camel.apache.org/manual/](https://camel.apache.org/manual/)
> * Camel Spring Boot：[https://camel.apache.org/camel-spring-boot/latest/](https://camel.apache.org/camel-spring-boot/latest/)

Spring Integration 是企业集成模式（EIP）的 Spring 实现，用于构建**消息驱动的集成流**，把文件、FTP、HTTP、数据库、MQ 等不同系统和协议连接起来。Boot 4 对应 Spring Integration 7.x。

日常 CRUD 业务不需要它；它适合多系统协议适配、异步数据管道、遗留系统对接这类「搬运 + 转换 + 路由」的场景。

---

## 一、核心概念

![Spring Integration 架构](../assets/spring/spring_integration_arch.svg)

| 概念 | 说明 |
|------|------|
| `Message` | 消息 = `MessageHeaders`（元数据）+ Payload（数据），不可变 |
| `MessageChannel` | 消息通道，解耦发送方与接收方 |
| Endpoint | 处理消息的节点：转换、过滤、路由、拆分、聚合、服务激活 |
| Channel Adapter | 与外部系统交互的单向出入口（文件、HTTP、JMS、AMQP、Kafka 等） |
| Gateway | 双向（请求-响应）的出入口；`@MessagingGateway` 把消息流包装成普通 Java 接口 |
| `IntegrationFlow` | 用 Java DSL 把上述组件串成一条流 |

### 1、Channel 类型

| 类型 | 说明 |
|------|------|
| `DirectChannel` | 同步点对点，在发送方线程中执行，**默认类型**，可参与发送方事务 |
| `QueueChannel` | 异步缓冲，消费端需要 Poller；默认内存队列，进程退出即丢失 |
| `QueueChannel` + `MessageStore` | 用 JDBC / Redis 消息存储做持久化队列，重启不丢消息 |
| `PublishSubscribeChannel` | 广播给所有订阅者 |
| `ExecutorChannel` | 交给线程池异步分发 |
| `FluxMessageChannel` | 响应式通道，基于 Reactor 背压 |

`errorChannel`、`nullChannel` 是框架自带的两个特殊通道：前者接收异步流程中的异常，后者丢弃消息。

### 2、依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-integration</artifactId>
</dependency>
```

适配器按需引入，版本由 Boot BOM 管理：

| 场景 | 依赖 |
|------|------|
| 文件 | `spring-integration-file` |
| HTTP 入站 / 出站 | `spring-integration-http` + `spring-boot-starter-webmvc` |
| RabbitMQ | `spring-integration-amqp` + `spring-boot-starter-amqp` |
| Kafka | `spring-integration-kafka` |
| JDBC（适配器、消息存储、分布式锁） | `spring-integration-jdbc` |
| FTP / SFTP | `spring-integration-ftp` / `spring-integration-sftp` |

> Spring Boot 已自动开启 Integration 并扫描 `@MessagingGateway` 接口，不需要再写 `@EnableIntegration`。

---

## 二、Java DSL 示例

### 1、文件监控 → 逐行拆分 → 入库

```java
@Configuration
@RequiredArgsConstructor
public class FileIntegrationConfig {

    private final UserRepository userRepository;

    @Bean
    public IntegrationFlow fileInboundFlow() {
        return IntegrationFlow
            // 1. 入站适配器：每 5 秒轮询目录中的 CSV 文件
            .from(Files.inboundAdapter(new File("/data/input")).patternFilter("*.csv"),
                  e -> e.poller(Pollers.fixedDelay(Duration.ofSeconds(5))))
            // 2. 按行流式拆分：第一行作为表头放入消息头 header，不作为数据行发出
            .split(Files.splitter().firstLineAsHeader("header"))
            // 3. 转换：CSV 行 → 业务对象
            .transform(String.class, this::parseCsvLine)
            // 4. 调用业务方法；返回 null 表示流到此结束
            .handle(UserRecord.class, (record, headers) -> {
                userRepository.save(record);
                return null;
            })
            .get();
    }

    private UserRecord parseCsvLine(String line) {
        String[] parts = line.split(",", -1);
        return new UserRecord(Long.parseLong(parts[0].trim()), parts[1].trim(), parts[2].trim());
    }
}

public record UserRecord(Long id, String name, String email) {}
```

几个容易写错的地方：

- **拆分 String 不会按行拆**：默认的 `split()` 只拆分集合、数组、Iterator、Stream 类型的 Payload。先用 `Files.toStringTransformer()` 把文件读成一个 String 再 `split()`，结果仍是一条消息。按行拆分用 `Files.splitter()`，它逐行读取，不会把大文件整个读进内存
- **`handle(...)` 的方法签名**：`handle` 接受 `MessageHandler`（`handleMessage(Message<?>)`）或 `GenericHandler<P>`（`(payload, headers) -> Object`）。单参数、返回 void 的方法引用 `this::save` 不匹配任何一个，无法编译
- **防重复处理**：入站文件适配器默认只在内存中记录已处理的文件，重启或多实例时会重复处理。生产环境用 `FileSystemPersistentAcceptOnceFileListFilter` 加共享的 `MetadataStore`（JDBC / Redis），或在处理完后移动文件
- 解析逻辑超过几行的大文件导入，直接用 [Spring Batch 批处理](./12_batch)：它有分块事务、跳过、重启语义，Spring Integration 只负责发现文件并触发作业

### 2、HTTP 入站 → RabbitMQ 出站

```java
@Configuration
public class HttpToMqConfig {

    @Bean
    public IntegrationFlow httpToMqFlow(AmqpTemplate amqpTemplate) {
        return IntegrationFlow
            // 单向入站适配器：收到 POST /events 后立即返回 200，不等待回复
            .from(Http.inboundChannelAdapter("/events")
                      .requestMapping(m -> m.methods(HttpMethod.POST))
                      .requestPayloadType(EventDto.class))
            .enrichHeaders(h -> h.header("source", "http-gateway"))
            .handle(Amqp.outboundAdapter(amqpTemplate)
                        .exchangeName("events.exchange")
                        .routingKey("event.created"))
            .get();
    }
}
```

入站端点要和流的出口方向一致：

| 入站 | 出站 | 结果 |
|------|------|------|
| `Http.inboundChannelAdapter`（单向） | `Amqp.outboundAdapter`（单向） | 正确：投递后立即响应 |
| `Http.inboundGateway`（等待回复） | `Amqp.outboundGateway`（RPC，等待回复） | 正确：同步请求-响应 |
| `Http.inboundGateway` | `Amqp.outboundAdapter` | **错误**：网关一直等不到回复，直到超时报错 |

### 3、Gateway：把消息流包装成接口

```java
@MessagingGateway
public interface OrderGateway {

    @Gateway(requestChannel = "orderChannel", replyTimeout = 5000)
    OrderResult process(Order order);   // 同步：等待流返回结果
}

@Configuration
public class OrderFlowConfig {

    @Bean
    public IntegrationFlow orderFlow(OrderHandler orderHandler) {
        return IntegrationFlow.from("orderChannel")
            .handle(Order.class, (order, headers) -> orderHandler.handle(order))   // 返回值即回复
            .get();
    }
}

@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderGateway orderGateway;

    public OrderResult submitOrder(Order order) {
        return orderGateway.process(order);   // 调用方感知不到消息流
    }
}
```

不指定 `replyChannel` 时框架为每次调用创建临时回复通道，这是最简单也最不容易出错的方式。

### 4、路由与聚合

```java
// 按事件类型路由到不同通道
.route(OrderEvent.class, OrderEvent::type, r -> r
    .channelMapping("PAID", "paidChannel")
    .channelMapping("CANCELLED", "cancelChannel")
    .defaultOutputChannel("unknownEventChannel"))

// 同一订单的 3 条子结果聚合为一条；30 秒未凑齐则发出部分结果
.aggregate(a -> a
    .correlationStrategy(m -> m.getHeaders().get("orderId"))
    .releaseStrategy(group -> group.size() == 3)
    .groupTimeout(30_000)
    .sendPartialResultOnExpiry(true)
    .expireGroupsUponCompletion(true))
```

聚合器的未完成分组默认存在内存中，重启即丢失；需要可靠性时配置 JDBC / Redis `MessageGroupStore`。

---

## 三、常用 Endpoint 速查

| Endpoint | 作用 | DSL 方法 |
|----------|------|---------|
| Transformer | 转换 Payload | `.transform(...)` |
| Filter | 按条件丢弃消息 | `.filter(...)` |
| Router | 按条件路由到不同 Channel | `.route(...)` |
| Splitter | 一条消息拆为多条 | `.split(...)` |
| Aggregator | 多条消息合并为一条 | `.aggregate(...)` |
| Service Activator | 调用业务方法 | `.handle(...)` |
| Header Enricher | 添加消息头 | `.enrichHeaders(...)` |
| Bridge | 连接两个 Channel | `.bridge()` |

---

## 四、错误处理与事务

- **同步流**（全程 `DirectChannel`）：异常直接抛回调用方，可以参与调用方的事务
- **异步流**（Poller、`ExecutorChannel`、`QueueChannel` 之后）：异常被包装成 `ErrorMessage` 发送到 `errorChannel`，默认只打印日志
- 入站适配器可以用 `e -> e.errorChannel("...")` 指定专属错误通道

```java
@Configuration
@Slf4j
public class IntegrationErrorConfig {

    // 对单个端点重试：Spring Integration 7 基于 Spring Framework 核心重试，不再依赖 Spring Retry
    @Bean
    public RequestHandlerRetryAdvice retryAdvice(MessageChannel failedChannel) {
        RequestHandlerRetryAdvice advice = new RequestHandlerRetryAdvice();
        advice.setRetryPolicy(RetryPolicy.builder()
            .maxRetries(3)
            .delay(Duration.ofSeconds(1))
            .multiplier(2.0)
            .build());
        advice.setRecoveryCallback(new ErrorMessageSendingRecoverer(failedChannel));   // 重试耗尽后转入失败通道
        return advice;
    }

    @Bean
    public MessageChannel failedChannel() {
        return new DirectChannel();
    }

    @Bean
    public IntegrationFlow failedFlow() {
        return IntegrationFlow.from("failedChannel")
            .handle(m -> log.error("集成流处理失败，转人工: {}", m.getPayload()))   // 落库、告警
            .get();
    }
}
```

在端点上使用：`.handle(UserRecord.class, handler, e -> e.advice(retryAdvice))`。轮询型入站流需要事务时，用 `Pollers.fixedDelay(...).transactional(txManager)`，让「取消息 + 处理」处于同一个事务中。消息投递的可靠性与幂等消费见 [消息队列基础](/messaging/1_basics)。

---

## 五、与 Spring Cloud Stream 的区别

Spring Cloud Stream **构建在 Spring Integration 之上**：Binding 背后就是 Spring Integration 的 MessageChannel，Binder 负责把通道连到具体中间件。

| 维度 | Spring Integration | Spring Cloud Stream |
|------|--------------------|---------------------|
| 定位 | 通用企业集成：文件、DB、HTTP、FTP、MQ | 微服务之间的事件驱动消息 |
| 抽象层次 | 细粒度：Channel、Endpoint、Adapter | 粗粒度：函数式 `Supplier` / `Function` / `Consumer` + Binding |
| 与 MQ 的关系 | 每种 MQ 一个 Adapter 模块，手动编排 | 通过 Binder 适配 Kafka、RabbitMQ、Pulsar 等，切换中间件只改配置 |
| 适用 | 复杂多协议集成管道 | 服务间发布 / 订阅事件 |

详见 [Spring Cloud Stream](/spring-cloud/7_stream)。

---

## 六、Apache Camel 对比

### 1、Camel 是什么

Apache Camel 是 Apache 基金会的开源集成框架，同样以 EIP 为核心，是 Java 生态中组件最多的集成框架。

- **版本**：当前为 4.x，LTS 版本约一年维护期。4.22（2026 年 7 月）是最新 LTS，支持 Java 17 / 21 / 25；**4.19 起 camel-spring-boot 只支持 Spring Boot 4**，仍在 Boot 3 上的项目使用 4.18 LTS
- **运行方式**：独立运行（Camel Main）、Spring Boot（camel-spring-boot）、Quarkus（Camel Quarkus），以及命令行工具 Camel JBang 快速运行路由
- **组件**：数百个组件，以 URI 寻址，如 `file:`、`sftp:`、`http:`、`kafka:`、`jms:`、`sql:`、`aws2-s3:`、`salesforce:`
- **DSL**：Java DSL、YAML DSL、XML DSL；有 Kaoto 等可视化设计工具

### 2、同一条流水线的两种写法

![Spring Integration 与 Camel 概念映射](../assets/spring/camel_vs_spring_integration.svg)

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.apache.camel.springboot</groupId>
            <artifactId>camel-spring-boot-bom</artifactId>
            <version>4.22.1</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>org.apache.camel.springboot</groupId>
        <artifactId>camel-spring-boot-starter</artifactId>
    </dependency>
    <!-- 每个组件一个 starter -->
    <dependency>
        <groupId>org.apache.camel.springboot</groupId>
        <artifactId>camel-file-starter</artifactId>
    </dependency>
    <dependency>
        <groupId>org.apache.camel.springboot</groupId>
        <artifactId>camel-sql-starter</artifactId>
    </dependency>
</dependencies>
```

```java
@Component
public class UserImportRoute extends RouteBuilder {

    @Override
    public void configure() {
        // 失败的消息重试 3 次，仍失败则写入错误目录
        errorHandler(deadLetterChannel("file:/data/error")
            .maximumRedeliveries(3)
            .redeliveryDelay(1000));

        from("file:/data/input?include=.*\\.csv&move=.done&moveFailed=.failed")   // 处理完移入 .done 目录
            .split(body().tokenize("\n")).streaming()                              // 流式按行拆分
                .filter(simple("${exchangeProperty.CamelSplitIndex} > 0"))         // 跳过表头
                .bean(UserLineMapper.class)                                        // 行 → Map(id, name, email)
                .to("sql:INSERT INTO users (id, name, email) VALUES (:#id, :#name, :#email)")
            .end();
    }
}
```

| Spring Integration | Camel |
|--------------------|-------|
| `IntegrationFlow` | Route（`RouteBuilder#configure`） |
| Channel Adapter（`Files.inboundAdapter`） | Endpoint URI（`file:/data/input?...`） |
| `Message`（headers + payload） | `Exchange` 包含 `Message`（headers + body）与属性 |
| `.handle(...)`（Service Activator） | `.process(...)` / `.bean(...)` |
| `MessageChannel` | 路由内的步骤直接相连，跨路由用 `direct:` / `seda:` |
| `errorChannel` + `RequestHandlerRetryAdvice` | `errorHandler(...)`、`onException(...)` |

### 3、怎么选

| 维度 | Spring Integration | Apache Camel |
|------|--------------------|--------------|
| 编程模型 | 类型化的 Bean 与 Channel，编译期检查 | URI 字符串 + DSL，配置错误多在运行时暴露 |
| 与 Spring 的结合 | 原生：Spring 事务、Boot 自动配置、Spring 测试工具 | 通过 camel-spring-boot 集成，Bean 与事务也能用 |
| 连接器数量 | 数十个适配器模块 | 数百个组件，覆盖大量 SaaS 与行业协议 |
| 运行时 | 仅 Spring | Spring Boot、Quarkus、独立运行 |
| 工具 | IDE + Spring 工具 | Camel JBang、Kaoto 可视化、TUI |
| 生态协同 | Spring Batch 远程分块 / 分区、Spring Cloud Stream 都基于它 | 独立生态 |

- **选 Spring Integration**：技术栈全是 Spring；集成流数量不多；需要与 Spring 事务、Spring Batch 深度协作
- **选 Camel**：需要对接大量异构系统（SaaS、FTP、EDI、老旧协议）；集成路由很多，需要独立的集成服务或集成平台；运行在 Quarkus 上；团队希望用 YAML 或可视化方式维护路由
- **两者都不需要**：只是消费一个 Kafka / RabbitMQ 主题，直接用 Spring Kafka / Spring AMQP（见 [消息队列基础](/messaging/1_basics)）或 Spring Cloud Stream

---

## 小结

- Spring Integration 是 EIP 的 Spring 实现：Message + Channel + Endpoint + Adapter，用 `IntegrationFlow` Java DSL 编排；Boot 4 对应 7.x，Boot 已自动开启，不必写 `@EnableIntegration`
- 每类外部系统一个适配器模块，HTTP 需要 webmvc starter，AMQP 需要 amqp starter
- 按行拆文件用 `Files.splitter()`；`handle` 用 `GenericHandler`（`(payload, headers) -> ...`），返回 null 结束流
- 入站和出站的方向要一致：单向适配器配单向适配器，网关配网关，否则请求会一直等到超时
- 异步流的异常进入 `errorChannel`；端点重试用 `RequestHandlerRetryAdvice`（7.x 基于 Spring Framework 核心 `RetryPolicy`）
- 内存中的 QueueChannel、聚合分组、文件去重记录在重启后都会丢失，需要可靠性时换成 JDBC / Redis 存储
- Spring Cloud Stream 构建于 Spring Integration 之上，专注服务间消息；Camel 组件最多、运行时更多样，适合大量异构系统集成；Camel 4.19+ 才支持 Boot 4

> 返回：[Spring 总览](./0_overview)

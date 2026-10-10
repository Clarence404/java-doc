---
description: Trace / Span、W3C 传播、Boot 接入、异步与 Kafka 透传、头尾采样、后端选型
---

# 链路追踪

> 前置阅读：[日志](/spring-boot/12_logging)、[指标监控](./2_metrics)

链路追踪回答一个请求穿过多个服务和消息队列后慢在哪一跳、错误从哪里开始传播。本篇以 **Spring Boot 4.x 自带的 Micrometer Tracing** 和 **OpenTelemetry** 为基线，讲模型、上下文传播、接入、采样、后端选型与排障，示例使用 `order-service` → `inventory-service` → Kafka 主题 `order-created` → `notification-service` 这条下单链路。

---

## 一、核心概念

### 1、Trace 与 Span

| 概念 | 含义 | 例子 |
|------|------|------|
| Trace | 一个请求在整个系统中的完整调用链，由一棵 Span 树组成，用 128 位 `trace-id` 标识 | 用户点一次"提交订单" |
| Span | 调用链中的一段工作，有开始时间和耗时，用 64 位 `span-id` 标识 | `order-service` 处理 `POST /orders`、一条 SQL、一次 Kafka 发送 |
| Parent Span | 发起当前 Span 的上一级 Span；没有父 Span 的是根 Span | 网关的入口 Span 是根 |
| SpanContext | 需要跨进程传递的最小信息：trace-id、span-id、采样标记、tracestate | 放进 HTTP 头 / Kafka 记录头 |
| Baggage | 随链路一起传递的业务键值对，和 Span 本身无关 | `tenantId=t-1001` |

![一次下单请求的 Trace 瀑布图](../assets/observability/tracing-waterfall.svg)

追踪后端把同一个 trace-id 的所有 Span 按父子关系和时间轴画成瀑布图。看图的顺序是：先看根 Span 总耗时，再找最长的那根子条，逐层往下钻到"自己耗时长、子 Span 又短"的那一段，那里就是瓶颈。上图中下单接口 380ms，其中 240ms 花在调用库存服务，库存服务里一条 `UPDATE` 占了 210ms。

### 2、Span 携带的信息

| 字段 | 说明 |
|------|------|
| name | 操作名，应是低基数的，如 `POST /orders`、`SELECT t_order`，不要把订单号拼进去 |
| kind | `SERVER`（处理入站请求）、`CLIENT`（发出出站请求）、`PRODUCER` / `CONSUMER`（消息收发）、`INTERNAL`（进程内） |
| attributes | 键值标签，如 `http.request.method`、`http.response.status_code`、`db.system.name`；订单号这类高基数值放这里而不是 name |
| events | Span 内某个时间点发生的事，异常就记为一个 `exception` 事件，带堆栈 |
| status | `UNSET` / `OK` / `ERROR`；HTTP 5xx、未捕获异常会被自动标为 `ERROR` |
| links | 关联到其他 Trace 的 Span，用于批量消费等"一个 Span 对应多个上游"的场景 |

属性名遵循 OpenTelemetry 的语义约定（Semantic Conventions），各语言、各框架产出的 Span 字段一致，后端才能统一查询和生成服务拓扑，见 [OpenTelemetry](./5_opentelemetry)。

---

## 二、上下文传播

链路能连起来，靠的是每次跨进程调用时把 SpanContext 放进请求，接收方取出来作为自己 Span 的父级。发送方叫 **Inject**，接收方叫 **Extract**，执行这两步的组件叫 **Propagator**。

![上下文传播](../assets/observability/tracing-context-propagation.svg)

### 1、W3C Trace Context

W3C Trace Context 是跨厂商的标准，OpenTelemetry 和 Micrometer Tracing 都默认使用它，定义了两个头：

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate: congo=t61rcWkgMzE
```

- `traceparent` 四段用 `-` 分隔：版本 `00`、32 位十六进制 trace-id、16 位十六进制 parent-id（发送方当前 Span 的 id）、trace-flags（最低位为 1 表示已采样）
- trace-id 全链路不变，parent-id 每经过一跳就换成发送方的 span-id
- `tracestate` 给各厂商放自己的扩展数据，可以没有
- trace-id 与 parent-id 全为 0 是非法值，接收方会丢弃并开启新 Trace

### 2、其他传播格式

| 格式 | 头 | 现状 |
|------|----|------|
| W3C Trace Context | `traceparent` / `tracestate` | 默认首选 |
| B3（Zipkin） | 多头 `X-B3-TraceId`、`X-B3-SpanId`、`X-B3-Sampled`，或单头 `b3` | Brave / Zipkin 体系和部分 Service Mesh 仍在用 |
| SkyWalking | `sw8` | 只在 SkyWalking 体系内通用 |
| Jaeger | `uber-trace-id` | Jaeger 原生客户端已退役，迁移到 W3C |

新老系统混跑时，让 Propagator 同时支持多种格式：Spring Boot 用 `management.tracing.propagation.type=w3c,b3` 发送多种头，或用 `management.tracing.propagation.consume` 只控制接收的格式；OpenTelemetry SDK 用 `OTEL_PROPAGATORS=tracecontext,baggage,b3multi`。网关、Sidecar 和所有服务的格式必须有交集，否则链路会在格式不一致的那一跳断开。Service Mesh 场景下应用仍需把入站头带到出站请求，见 [服务网格](/microservices/3_service_mesh)。

### 3、Baggage

Baggage 是 W3C 的另一个标准，用 `baggage` 头传递业务键值对，例如租户、渠道、灰度标记：

```text
baggage: tenantId=t-1001,channel=app
```

Baggage 只负责传递，不会自动变成 Span 属性或日志字段，需要显式配置。每个下游、每个请求都会带着它，所以只放少量短字段；也不要放用户手机号这类敏感信息，它会原样发给链路上的每个服务，包括第三方。

### 4、各种通道的载体

| 通道 | 载体 | 谁来 Inject / Extract |
|------|------|----------------------|
| HTTP | 请求头 | Spring MVC / WebFlux 服务端自动 Extract；`RestClient`、`WebClient`、`RestTemplate` 必须由 Boot 自动配置的 Builder 创建才会 Inject |
| gRPC / Dubbo | Metadata / Attachment | 对应框架的 Observation 或 OpenTelemetry 插桩 |
| Kafka | Record Header | Spring Kafka 开启 Observation 后自动处理，见第四节 |
| RabbitMQ | Message Properties 的 headers | Spring AMQP 开启 Observation 后自动处理 |
| 线程池 / 异步 | ThreadLocal 快照 | Context Propagation 库，见第四节 |

---

## 三、Spring Boot 接入

Spring Boot 的链路追踪由 **Micrometer Tracing** 提供：业务和框架代码面向 Micrometer 的 `Observation` / `Tracer` 编程，底层通过 bridge 选择 OpenTelemetry 或 Brave 实现，再由 exporter 上报。

### 1、选择组合

| 组合 | Boot 4 依赖 | 上报协议 | 适用 |
|------|-------------|----------|------|
| OpenTelemetry + OTLP | `spring-boot-starter-opentelemetry` | OTLP（HTTP 默认，也可 gRPC） | 新项目首选，可发往 Collector、Tempo、Jaeger v2 |
| Brave + Zipkin | `spring-boot-starter-zipkin` | Zipkin JSON | 已有 Zipkin 平台 |

Boot 3.x 没有这两个 starter，需要手动组合 `micrometer-tracing-bridge-otel` + `opentelemetry-exporter-otlp`（或 `micrometer-tracing-bridge-brave` + `zipkin-reporter-brave`），OTLP 地址的属性是 `management.otlp.tracing.endpoint`。

另一条路是不引入任何依赖，直接挂 OpenTelemetry Java agent 做字节码插桩。两条路选一条，**不要同时使用**，否则同一个请求会产生两套 Span。对比与 agent 用法见 [OpenTelemetry](./5_opentelemetry)。

### 2、依赖与配置

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-opentelemetry</artifactId>
</dependency>
```

```yaml
spring:
  application:
    name: order-service              # 成为 service.name，后端按它区分服务

management:
  tracing:
    sampling:
      probability: 1.0               # 默认 0.1；开发环境全采，生产按量调整
    baggage:
      remote-fields: tenantId        # 作为 baggage 透传给下游
      correlation:
        fields: tenantId             # 同时写进 MDC，日志里可用 %X{tenantId}
  opentelemetry:
    tracing:
      export:
        otlp:
          endpoint: http://otel-collector:4318/v1/traces
```

几个要点：

- 采样率 `management.tracing.sampling.probability` 默认 0.1，即只有 10% 的 Trace 被上报；日志中的 traceId 不受采样影响，未采样的请求也有 traceId，只是后端查不到
- Boot 4.0 起 `management.tracing.enabled` 更名为 `management.tracing.export.enabled`，设为 `false` 只关闭上报，traceId 仍会生成并写入日志
- OpenTelemetry 采样器由 `management.opentelemetry.tracing.sampler` 决定，默认 `parent-based-trace-id-ratio`：上游已做出采样决定就跟随上游，否则按比例采样，保证一条链路要么完整、要么都不采
- 本地开发配合 Docker Compose 支持时，OTLP 地址会自动配置；生产环境需要自己设置

traceId 写入日志的格式（`logging.pattern.correlation`）见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)，这里不重复。

### 3、自动产生的 Span

接入后无需写代码，以下调用都会自动产生 Span 并传播上下文：

- Spring MVC / WebFlux 处理的入站 HTTP 请求（`SERVER`）
- 通过 Builder 创建的 `RestClient` / `WebClient` / `RestTemplate` 发出的请求（`CLIENT`）
- 开启 Observation 的 `KafkaTemplate`、`@KafkaListener`、`RabbitTemplate`、`@RabbitListener`
- Spring Data Redis（Lettuce）的命令、`@Scheduled` 任务

JDBC 不在 Spring 的 Observation 覆盖范围内。需要 SQL 级 Span 时可引入社区的 `datasource-micrometer-spring-boot`，或改用 OpenTelemetry Java agent（自带 JDBC 插桩）。

### 4、手动创建 Span

业务内部的关键步骤（如风控校验、调用第三方）可以手动埋点。首选 Observation API，一次埋点同时得到指标和 Span，写法见 [Actuator 监控](/spring-boot/7_actuator)；只要 Span 时可以直接用 `Tracer`：

```java
import io.micrometer.tracing.BaggageInScope;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import org.springframework.stereotype.Service;

@Service
public class RiskCheckService {

    private final Tracer tracer;

    public RiskCheckService(Tracer tracer) {
        this.tracer = tracer;
    }

    public boolean check(String orderNo, String tenantId) {
        Span span = tracer.nextSpan().name("risk.check");           // 当前 Span 的子 Span
        try (Tracer.SpanInScope ws = tracer.withSpan(span.start());
             BaggageInScope baggage = tracer.createBaggageInScope("tenantId", tenantId)) {
            span.tag("order.no", orderNo);                          // 高基数值放 tag，不放 name
            return callRiskEngine(orderNo);
        } catch (RuntimeException e) {
            span.error(e);                                          // 状态置为 ERROR 并记录异常
            throw e;
        } finally {
            span.end();                                             // 必须 end，否则不会上报
        }
    }

    private boolean callRiskEngine(String orderNo) {
        return true;
    }
}
```

`createBaggageInScope` 设置的 baggage 只有在 `management.tracing.baggage.remote-fields` 中登记过的字段才会随请求发往下游。

---

## 四、异步与消息队列透传

当前 Span 存在 ThreadLocal 里，只要代码换了线程，子线程就拿不到父 Span：新 Span 会成为一条新 Trace 的根，日志里的 traceId 也跟着变了。这是链路"断开"最常见的原因。

### 1、线程池与 @Async

Micrometer 的 [Context Propagation](https://docs.micrometer.io/context-propagation/reference/) 库负责在提交任务时给已注册的 ThreadLocal（当前 Observation、MDC 等）拍快照，执行任务前在工作线程中恢复，结束后还原。Spring 把它封装成 `ContextPropagatingTaskDecorator`：

| 场景 | 做法 |
|------|------|
| 自己定义的 `ThreadPoolTaskExecutor` | `executor.setTaskDecorator(new ContextPropagatingTaskDecorator())` |
| Boot 自动配置的 `@Async` 执行器 | Boot 4.1+ 设置 `spring.task.execution.propagate-context=true`；更早的版本注册一个 `ContextPropagatingTaskDecorator` Bean |
| `CompletableFuture.supplyAsync(..., executor)` | 传入上面装饰过的执行器，不要用默认的 `ForkJoinPool.commonPool()` |
| 原生 `ExecutorService` | 用 `ContextExecutorService.wrap(...)` 包装 |

配置代码见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)，线程池参数见 [异步与定时任务](/spring-boot/9_async_schedule)。

### 2、虚拟线程

虚拟线程同样使用 ThreadLocal，**不会**自动继承父线程的上下文。开启 `spring.threads.virtual.enabled=true` 后，Boot 自动配置的执行器会应用容器中的 `TaskDecorator`，与平台线程的处理方式一致；自己创建的虚拟线程执行器需要手动包装：

```java
import io.micrometer.context.ContextExecutorService;
import io.micrometer.context.ContextSnapshotFactory;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class VirtualThreadExecutorConfig {

    @Bean(destroyMethod = "close")
    ExecutorService notifyExecutor() {
        return ContextExecutorService.wrap(
                Executors.newVirtualThreadPerTaskExecutor(),
                ContextSnapshotFactory.builder().build());
    }
}
```

使用 OpenTelemetry Java agent 时，agent 会对 JDK 的 `Executor` 实现做插桩，提交到线程池（包括虚拟线程执行器）的任务自动携带上下文，不需要上面的包装。虚拟线程本身见 [虚拟线程](/java/30_topic_virtual_thread)。

### 3、响应式

WebFlux / Reactor 中一个请求会在多个线程间切换，需要设置 `spring.reactor.context-propagation=auto`，让 Reactor 在操作符之间自动恢复 ThreadLocal，见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)。

### 4、Kafka

Spring Kafka 默认不开启 Observation，需要显式打开生产端和消费端：

```yaml
spring:
  kafka:
    template:
      observation-enabled: true      # KafkaTemplate 发送时创建 PRODUCER Span，并把 traceparent 写入记录头
    listener:
      observation-enabled: true      # @KafkaListener 接收时从记录头 Extract，创建 CONSUMER Span
```

开启后，`order-service` 发送 `order-created` 消息时，记录头里会带上 `traceparent`；`notification-service` 消费时以它为父级，于是消费者的 Span 和下单请求出现在同一条 Trace 里（见第一节瀑布图的最后一行）。需要注意：

- `KafkaTemplate` 必须是 Boot 自动配置的那个，自己 `new` 出来的不会读取上述属性，要调用 `setObservationEnabled(true)`
- 批量监听器默认不创建 Observation：一批消息可能来自多条 Trace，无法都作为监听方法的父级；可在容器属性中设置 `recordObservationsInBatch=true` 为每条记录单独创建 Span，但它不会传播到监听方法中
- 消息经过 Kafka Connect、Flink 等中间处理后再被消费，上下文是否保留取决于中间组件是否透传记录头
- 消费者与生产者在时间上可能相隔很久（积压、重试），瀑布图上的长空白不代表处理慢，应看 CONSUMER Span 自身的耗时

Kafka 本身的使用见 [Kafka](/messaging/2_kafka)。RabbitMQ 对应的属性是 `spring.rabbitmq.template.observation-enabled` 与 `spring.rabbitmq.listener.simple.observation-enabled`（`direct` 容器同理）。

---

## 五、采样策略

全量追踪的开销主要在上报、传输和存储：每个请求十几个 Span，QPS 上万时每天的数据量非常可观。采样决定哪些 Trace 被保留。

### 1、头部采样

在 Trace 开始时（根 Span 创建时）就决定采不采，通过 `traceparent` 的采样标记告诉下游跟随这个决定。

- 优点：实现简单，未采样的请求几乎没有开销，不需要中间缓冲
- 缺点：决策时还不知道请求结果，按 10% 采样时，出错和慢的请求有 90% 的概率被丢掉，而排障恰恰最需要它们
- 配置：Spring Boot 用 `management.tracing.sampling.probability`，OpenTelemetry SDK 用 `OTEL_TRACES_SAMPLER=parentbased_traceidratio` 加 `OTEL_TRACES_SAMPLER_ARG=0.1`

### 2、尾部采样

应用全量上报，由 OpenTelemetry Collector 把同一 Trace 的 Span 缓存一段时间，等 Trace 结束后按规则决定保留与否：

```yaml
processors:
  tail_sampling:
    decision_wait: 10s                 # 等待同一 trace 的 Span 到齐的时间
    num_traces: 100000                 # 内存中最多缓存的 trace 数
    expected_new_traces_per_sec: 2000
    policies:
      - name: keep-errors              # 出错的全部保留
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: keep-slow                # 慢于 1 秒的全部保留
        type: latency
        latency:
          threshold_ms: 1000
      - name: sample-rest              # 其余按 5% 保留
        type: probabilistic
        probabilistic:
          sampling_percentage: 5
```

多条策略之间是"任一命中即保留"的关系。尾部采样的代价：

- **同一 Trace 的所有 Span 必须到达同一个 Collector 实例**，多副本部署时需要前置一层 `load_balancing` exporter 按 traceID 路由，见 [OpenTelemetry](./5_opentelemetry)
- Collector 要缓存 `decision_wait` 时间内的全部 Span，内存与 QPS 成正比
- 应用侧必须把头部采样率调到 1.0（或较高值），否则 Collector 只能在已经被丢掉 90% 的数据里挑

### 3、怎么选

| 规模 | 建议 |
|------|------|
| 开发、测试环境 | 头部采样 1.0 |
| 中小规模生产 | 头部采样 0.1～1.0，配合日志中的 traceId 排障 |
| 大规模、对错误链路要求高 | 应用全量上报 + Collector 尾部采样（错误、慢请求全留，其余低比例） |

---

## 六、追踪后端选型

| 后端 | 架构与存储 | 查询 | 特点 |
|------|-----------|------|------|
| Jaeger v2 | 基于 OpenTelemetry Collector 构建的单一二进制，原生接收 OTLP（4317 / 4318）；存储可选 Cassandra、Elasticsearch / OpenSearch、Badger 等 | Jaeger UI，按服务、操作、标签、耗时搜索 | CNCF 毕业项目；v1 已于 2025 年底停止维护，旧的 Jaeger agent 和客户端库应迁移到 OTLP |
| Grafana Tempo | 只建 trace-id 索引，数据存对象存储（S3 / OSS / GCS） | TraceQL；Grafana 中与 Loki、Prometheus 互相跳转 | 存储成本低，适合大量全量数据；metrics-generator 可从 Span 生成 RED 指标和服务拓扑 |
| Zipkin | 老牌追踪系统，存储可选 Elasticsearch、Cassandra、MySQL | Zipkin UI | 简单轻量，Brave 体系原生支持；Boot 中 OpenTelemetry 到 Zipkin 的导出已弃用 |
| Apache SkyWalking | 自有 Java agent + OAP 服务端，存储可选 BanyanDB、Elasticsearch | 自带 UI，含拓扑、指标、告警 | 国内使用广泛，开箱即有 APM 能力；使用自有 `sw8` 传播头，与 OTel 体系混用需要注意 |
| 商业 APM | Datadog、New Relic、阿里云 ARMS、腾讯云 APM 等 | 各自控制台 | 免运维，大多支持直接接收 OTLP |

TraceQL 示例（Tempo）：

```text
{ resource.service.name = "order-service" && span.http.route = "/orders" && duration > 500ms }
{ resource.service.name = "inventory-service" && status = error }
```

选型建议：已经用 Grafana + Prometheus + Loki 的团队选 Tempo，数据在对象存储里，成本最低；需要独立追踪系统、存储已有 Elasticsearch 的选 Jaeger v2；希望一个系统包揽指标、链路、告警且接受专有 agent 的可选 SkyWalking。无论选哪个，应用侧都建议用 OpenTelemetry 协议上报、经 Collector 转发，这样换后端只改 Collector 配置。

---

## 七、日志、指标与链路的关联

三类信号单独看都只能回答一半问题，用 traceId 串起来才能形成排障路径：

| 从 | 到 | 怎么关联 |
|----|----|----------|
| 指标 | 链路 | **Exemplars**：直方图的某个桶附带一个被采样请求的 `trace_id`，Grafana 延迟面板上的点击即可打开该 Trace；配置见 [指标监控](./2_metrics) 的 Grafana 一节 |
| 链路 | 日志 | Span 带 `service.name` 和 trace-id，Grafana 的 Tempo 数据源配置 "Trace to logs"，按 trace-id 查 Loki |
| 日志 | 链路 | 日志中的 traceId 字段配置为 Loki 的 derived field，点击跳转到 Tempo / Jaeger |
| 链路 | 指标 | Tempo metrics-generator 或 Collector 的 `span_metrics` connector 从 Span 生成请求数、错误数、耗时直方图 |

关联的前提是字段一致：Micrometer Tracing 写入 MDC 的键是 `traceId` / `spanId`，OpenTelemetry Java agent 写入的是 `trace_id` / `span_id`，日志通过 OTLP 发到 Loki 时 trace-id 会作为结构化元数据 `trace_id`。团队内定一种，日志模板、Loki 派生字段和 Grafana 跳转配置都按它来。按 trace-id 查 Loki 的 LogQL：

```text
{service_name="order-service"} | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"
```

---

## 八、排障实战：下单接口 P99 变慢

1. **告警**：`order-service` 的 `POST /orders` P99 从 200ms 升到 900ms，触发燃烧速率告警（规则见 [可用性度量](/high-avail/1_sla_slo)）
2. **指标 → 链路**：打开 Grafana 延迟面板，点 P99 曲线高点附近的 exemplar，进入一条耗时 1.1s 的 Trace
3. **读瀑布图**：根 Span 1.1s，子 Span `HTTP POST inventory-service` 占 950ms，展开后 `inventory-service` 的 `UPDATE t_stock` 占 900ms
4. **确认是普遍现象**：用 TraceQL 查 `{ resource.service.name = "inventory-service" && name =~ "UPDATE.*" && duration > 500ms }`，最近 30 分钟有大量命中，且集中在同一个 SKU
5. **链路 → 日志**：从 Span 跳到 Loki，看到库存服务大量 `Lock wait timeout` 警告
6. **结论**：热门 SKU 的库存行被并发扣减争抢行锁。处理方式是热点库存拆分或改为缓存预扣，见 [热点问题](/high-con/6_hotspot) 与 [秒杀](/scenario/4_seckill)

这条路径里每一步都依赖前面几节的工作：exemplar 需要 Micrometer Tracing 和 Prometheus 配合，Trace 完整需要上下文传播不断链，慢请求一定能查到需要尾部采样或足够高的采样率，从 Span 跳日志需要字段统一。

---

## 小结

- Trace 是一棵 Span 树，trace-id 全链路不变，span-id 每段一个；排障时从根 Span 往下找"自身耗时最长"的那一段
- 链路靠上下文传播连起来，默认使用 W3C `traceparent`；Baggage 传业务字段，只放少量非敏感数据
- Spring Boot 4 用 `spring-boot-starter-opentelemetry` 接入，采样率默认 0.1，`management.tracing.export.enabled` 只控制上报；HTTP 客户端必须由自动配置的 Builder 创建
- 换线程就可能断链：线程池用 `ContextPropagatingTaskDecorator`，自建执行器用 `ContextExecutorService.wrap`，Reactor 开 `context-propagation`，Kafka 打开 `observation-enabled`
- 头部采样便宜但会漏掉错误和慢请求；尾部采样能全留异常链路，代价是全量上报和按 traceID 路由的 Collector
- 后端优先选能接收 OTLP 的 Tempo 或 Jaeger v2，应用经 Collector 上报，换后端不动代码
- 用 exemplars、trace-id 跳转把指标、链路、日志串成一条路径，前提是字段命名统一

相关内容：应用侧 traceId 写入日志、`logging.pattern.correlation` 与 `ContextPropagatingTaskDecorator` 的基础配置见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)；Observation API 一次埋点同时产出指标和 Span 见 [Actuator 监控](/spring-boot/7_actuator)；OpenTelemetry 的组件、Java agent 与 Collector 配置见 [OpenTelemetry](./5_opentelemetry)。

## 参考资料

- W3C Trace Context 规范：[Trace Context](https://www.w3.org/TR/trace-context/)
- W3C Baggage 规范：[Propagation format for distributed context: Baggage](https://www.w3.org/TR/baggage/)
- Spring Boot 链路追踪：[Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- Spring Boot 可观测性与上下文传播：[Observability](https://docs.spring.io/spring-boot/reference/actuator/observability.html)
- Spring 官方博客：[OpenTelemetry with Spring Boot](https://spring.io/blog/2025/11/18/opentelemetry-with-spring-boot/)
- Micrometer Tracing：[Micrometer Tracing 文档](https://docs.micrometer.io/tracing/reference/)
- Context Propagation 库：[Context Propagation 文档](https://docs.micrometer.io/context-propagation/reference/)
- Spring Kafka 可观测性：[Observation](https://docs.spring.io/spring-kafka/reference/kafka/micrometer.html)
- OpenTelemetry 采样：[Sampling](https://opentelemetry.io/docs/concepts/sampling/)
- 尾部采样处理器：[Tail Sampling Processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md)
- Jaeger 文档：[Jaeger Documentation](https://www.jaegertracing.io/docs/latest/)
- Grafana Tempo 与 TraceQL：[TraceQL](https://grafana.com/docs/tempo/latest/traceql/)
- Apache SkyWalking：[SkyWalking 文档](https://skywalking.apache.org/docs/)

> 下一篇：[告警体系](./4_alerting)

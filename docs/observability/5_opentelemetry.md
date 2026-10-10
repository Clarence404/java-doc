---
description: 组成与成熟度、Java agent 2.x、Spring Boot 接入对比、Collector 管道、K8s 部署
---

# OpenTelemetry

> 前置阅读：[链路追踪](./3_tracing)、[指标监控](./2_metrics)

OpenTelemetry（OTel）是 CNCF 下的可观测性数据标准与工具集，换后端不用改代码。本篇讲 OTel 组成、Java 接入方式、Collector 配置与 Kubernetes 部署，基线为 Spring Boot 4.x。

---

## 一、组成

OTel 只负责数据怎么产生、描述和传输，应用产出的数据可发给任意兼容 OTLP 的后端。版本为 OpenTelemetry Java agent 2.32、Collector v0.162（2026 年 10 月），示例沿用 `order-service` → `inventory-service` → Kafka → `notification-service` 下单链路。

### 1、六个部分

| 组成 | 作用 | Java 中的对应 |
|------|------|---------------|
| API | 埋点用的接口：`Tracer`、`Meter`、`Logger`、`Baggage`、`Context`；没有 SDK 时调用是空操作 | `io.opentelemetry:opentelemetry-api` |
| SDK | API 的实现：采样、批处理、资源属性、导出 | `opentelemetry-sdk`、`opentelemetry-exporter-otlp` |
| Instrumentation（插桩） | 为常见框架和库自动产生数据，分为字节码插桩（agent）和库插桩（手动注册） | `opentelemetry-java-instrumentation` 项目，含 Java agent 和各库的插桩模块 |
| Collector | 独立进程，接收、处理、转发遥测数据 | Go 编写，与语言无关 |
| OTLP | OpenTelemetry Protocol，基于 Protobuf，支持 gRPC（4317）和 HTTP（4318） | 所有 SDK、Collector 和主流后端都支持 |
| Semantic Conventions（语义约定） | 统一属性名，如 `http.request.method`、`db.system.name`、`service.name` | 插桩按约定产出，后端按约定查询 |

**API 与 SDK 分离**是设计上最重要的一点：类库作者只依赖 API 埋点，不绑定实现；应用决定用哪个 SDK、发到哪里。没有配置 SDK 时 API 调用全部是空操作，不会产生开销。

### 2、资源（Resource）

每条数据都带一组描述"谁产生的"资源属性，其中 `service.name` 是唯一必填项，后端按它区分服务。常用的还有：

| 属性 | 示例 | 说明 |
|------|------|------|
| `service.name` | `order-service` | 服务名，必填 |
| `service.namespace` | `shop` | 服务所属业务域，避免不同团队的同名服务冲突 |
| `service.version` | `1.4.2` | 版本，发布前后对比时用 |
| `deployment.environment.name` | `prod` | 环境；旧名 `deployment.environment` 已弃用 |
| `k8s.namespace.name`、`k8s.pod.name` | | 由 Collector 的 `k8s_attributes` 处理器自动补充 |

### 3、信号成熟度

| 信号 | 规范与 OTLP | Java SDK | 说明 |
|------|-------------|----------|------|
| Traces | 稳定 | 稳定 | 最成熟，各后端支持最完整 |
| Metrics | 稳定 | 稳定 | 可直接写入 Prometheus 3 |
| Logs | 稳定 | 稳定 | OTel 不提供新的日志 API 给业务用，而是用 Appender 桥接现有的 Logback / Log4j2 |
| Baggage | 稳定 | 稳定 | 随上下文传播的键值对 |
| Profiles | Alpha（2026 年 3 月进入公开 Alpha） | 开发中 | 持续性能剖析，数据模型仍可能变化，暂不建议用于生产 |

日志信号的思路值得单独说明：业务代码继续用 SLF4J 写日志，OTel 通过 Appender 把日志转换成 LogRecord，自动附上当前的 trace-id、span-id 和资源属性，再通过 OTLP 发出。这样日志不需要再靠文件采集和正则解析来关联链路。

---

## 二、Java 接入方式对比

Java 服务接入 OpenTelemetry 有三条路：

| 维度 | OTel Java agent | Spring Boot 官方 `spring-boot-starter-opentelemetry` | OTel 社区 `opentelemetry-spring-boot-starter` |
|------|-----------------|------------------------------------------|------------------------------------------|
| 原理 | `-javaagent` 字节码插桩 | Micrometer Observation + OTel bridge，OTLP 导出 | Spring 自动配置 + 库插桩 |
| 代码改动 | 无 | 加依赖 | 加依赖 |
| 覆盖范围 | 最广：HTTP 服务端与客户端、JDBC、Kafka、Redis、线程池等上百个库 | Spring 生态中支持 Observation 的组件；JDBC 需额外引入 | 介于两者之间 |
| 配置方式 | `OTEL_*` 环境变量 / `otel.*` 系统属性 | `management.*` 属性 | `otel.*` 属性 |
| 指标命名 | OTel 语义约定（如 `http.server.request.duration`） | Micrometer 命名（如 `http.server.requests`） | OTel 语义约定 |
| GraalVM 原生镜像 | 不支持 | 支持 | 支持 |
| 启动开销 | 启动时插桩，启动变慢；与 AOT 缓存、其他 agent 可能冲突 | 小 | 小 |
| 维护方 | OpenTelemetry | Spring 团队 | OpenTelemetry；官方文档列出的支持范围为 Boot 2.6+ / 3.1+ |

选择建议：

- **希望零代码、覆盖面最广，或公司内多语言统一用 OTel 体系**：用 Java agent。OpenTelemetry 官方把 agent 作为 Java 的默认推荐
- **Spring Boot 4 项目、已经在用 Micrometer、或需要原生镜像**：用官方 `spring-boot-starter-opentelemetry`，配置方式见 [链路追踪](./3_tracing) 第三节和 [Actuator 监控](/spring-boot/7_actuator)
- **社区 starter**：只在 Boot 3.x 项目无法使用 agent（如原生镜像）时考虑，它与 Boot 4 的官方 starter 不能混用
- 三条路**只选一条**：agent 与 Micrometer Tracing 同时启用会产生重复的 Span；agent 2.x 默认关闭了对 Micrometer 指标的桥接，也是为了避免重复

---

## 三、Java agent 2.x

### 1、启动方式

agent 是一个 jar，启动时用 `-javaagent` 挂载：

```bash
java -javaagent:/opt/otel/opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -jar order-service.jar
```

容器中通常把 agent 打进镜像，通过 `JAVA_TOOL_OPTIONS` 挂载，配置全部用环境变量传入：

```dockerfile
FROM eclipse-temurin:21-jre
WORKDIR /app
ADD --chmod=644 https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.32.0/opentelemetry-javaagent.jar /opt/otel/opentelemetry-javaagent.jar
COPY target/order-service.jar app.jar
ENV JAVA_TOOL_OPTIONS="-javaagent:/opt/otel/opentelemetry-javaagent.jar"
ENTRYPOINT ["java", "-jar", "app.jar"]
```

下载地址固定到具体版本，而不是 `latest`，否则每次构建拿到的 agent 可能不同。镜像构建的其他细节见 [Docker](/cloud-native/5_docker)；在 Kubernetes 中也可以由 OpenTelemetry Operator 自动注入 agent，见第六节。

### 2、常用配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `OTEL_SERVICE_NAME` | `unknown_service:java` | 服务名，必须设置 |
| `OTEL_RESOURCE_ATTRIBUTES` | 无 | 其他资源属性，逗号分隔的 `k=v` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP 地址，三种信号共用；agent 会自动拼接 `/v1/traces` 等路径 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 可改为 `grpc`，此时端口是 4317 |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | 生产常用 `parentbased_traceidratio` |
| `OTEL_TRACES_SAMPLER_ARG` | 无 | 采样比例，如 `0.1` |
| `OTEL_PROPAGATORS` | `tracecontext,baggage` | 需要兼容 Zipkin 体系时加 `b3multi` |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `otlp` | 设为 `none` 关闭对应信号 |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | 指标推送间隔（毫秒） |
| `OTEL_INSTRUMENTATION_<名称>_ENABLED` | 多数为 `true` | 关闭某个插桩，如 `OTEL_INSTRUMENTATION_JDBC_ENABLED=false` |
| `OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED` | `true` | 设为 `false` 后全部关闭，再逐个开启需要的插桩 |

任意系统属性都能写成环境变量：全部大写，`.` 和 `-` 换成 `_`。优先级从高到低是系统属性、环境变量、`otel.javaagent.configuration-file` 指定的 properties 文件。

一份典型的生产配置：

```bash
OTEL_SERVICE_NAME=order-service
OTEL_RESOURCE_ATTRIBUTES=service.namespace=shop,service.version=1.4.2,deployment.environment.name=prod
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-agent.observability:4318
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.2
```

如果下游 Collector 做尾部采样，`OTEL_TRACES_SAMPLER_ARG` 应设为 `1.0`，把选择权交给 Collector，原因见 [链路追踪](./3_tracing) 第五节。

### 3、2.x 的默认行为

从 1.x 升到 2.x 的变化集中在默认值上，排查"数据和以前不一样"时先看这里：

- 默认协议从 gRPC 改为 `http/protobuf`，端口从 4317 变为 4318；Collector 只开了 gRPC 时会连不上
- HTTP 相关属性改用稳定版语义约定，例如 `http.method` 变为 `http.request.method`，旧看板和告警的查询需要同步修改
- Micrometer 桥接默认关闭（`otel.instrumentation.micrometer.enabled=false`），应用里的 Micrometer 指标不会再被 agent 导出
- Spring MVC 控制器、视图渲染等内部 Span 默认关闭，只保留 HTTP 服务端 Span，减少噪声
- 日志默认通过 OTLP 导出，并向 MDC 写入 `trace_id`、`span_id`、`trace_flags`，键名与 Micrometer Tracing 的 `traceId` / `spanId` 不同，日志模板要按实际使用的方式统一

### 4、声明式配置

环境变量只能表达平铺的键值，复杂配置（多个 exporter、按路由的采样规则、属性过滤）写起来很别扭。OpenTelemetry 为此定义了**声明式配置**：用一个 YAML 文件描述完整的 SDK 配置，由 `OTEL_CONFIG_FILE` 环境变量指定。2026 年这套配置的数据模型（`opentelemetry-configuration` 1.0.0）和 `OTEL_CONFIG_FILE` 变量已经在规范层面稳定，Java 是已有实现的语言之一，但 SDK 与 agent 中的支持仍标记为实验性。使用时注意两点：

- 一旦指定了配置文件，其他 `OTEL_*` 环境变量会被忽略，所有配置都要写进文件
- 不同 agent 版本对文件中各字段的支持程度不同，升级 agent 时要对照该版本文档验证

生产环境目前仍建议以环境变量为主，声明式配置可以先在新服务上试点。

### 5、扩展与排障

- **扩展**：需要自定义采样器、Span 处理器或给不支持的库加插桩时，写一个扩展 jar，用 `otel.javaagent.extensions` 加载，不要修改 agent 本身
- **调试**：`OTEL_JAVAAGENT_DEBUG=true` 打印插桩与导出细节；临时把 `OTEL_TRACES_EXPORTER` 设为 `console` 可以在标准输出中直接看到 Span
- **库版本**：字节码插桩与目标库的版本强相关，升级 Spring、Kafka 客户端等大版本前，先在 agent 的支持库列表中确认已覆盖

---

## 四、手动埋点

自动插桩覆盖的是框架边界（HTTP、SQL、消息）。业务内部的关键步骤需要手动补 Span。使用 agent 时，引入 API 和注解依赖（版本由 BOM 管理）：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>io.opentelemetry.instrumentation</groupId>
            <artifactId>opentelemetry-instrumentation-bom</artifactId>
            <version>2.32.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>io.opentelemetry</groupId>
        <artifactId>opentelemetry-api</artifactId>
    </dependency>
    <dependency>
        <groupId>io.opentelemetry.instrumentation</groupId>
        <artifactId>opentelemetry-instrumentation-annotations</artifactId>
    </dependency>
</dependencies>
```

```java
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import io.opentelemetry.instrumentation.annotations.SpanAttribute;
import io.opentelemetry.instrumentation.annotations.WithSpan;
import java.math.BigDecimal;
import org.springframework.stereotype.Service;

@Service
public class OrderPricingService {

    private static final Tracer TRACER = GlobalOpenTelemetry.getTracer("order-service");

    // 注解方式：agent 为方法创建 Span，抛出异常时自动记录并标记 ERROR
    @WithSpan("order.price")
    public BigDecimal price(@SpanAttribute("order.no") String orderNo, int quantity) {
        Span.current().setAttribute("order.quantity", quantity);
        Span.current().addEvent("coupon.applied");
        return BigDecimal.valueOf(quantity).multiply(BigDecimal.TEN);
    }

    // API 方式：需要精确控制 Span 范围，或在循环、回调中使用时
    public void submit(String orderNo, String tenantId) {
        Span span = TRACER.spanBuilder("order.submit").startSpan();
        try (Scope spanScope = span.makeCurrent();
             Scope baggageScope = Baggage.current().toBuilder()
                     .put("tenantId", tenantId)          // 随后续出站请求的 baggage 头传给下游
                     .build()
                     .makeCurrent()) {
            span.setAttribute("order.no", orderNo);
            // 调用库存服务、发送 Kafka 消息……
        } catch (RuntimeException e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR);
            throw e;
        } finally {
            span.end();
        }
    }
}
```

要点：

- 没有挂 agent 时，`GlobalOpenTelemetry` 返回空实现，上面的代码可以照常运行，只是不产生数据
- Span 名用低基数的操作名，订单号这类值放属性
- 使用 Spring Boot 官方 starter 的项目不要用这套 API，而是用 Micrometer 的 `Observation` / `Tracer`，见 [链路追踪](./3_tracing) 第三节

---

## 五、Collector

应用可以直接把 OTLP 发给后端，但生产中几乎都会经过 Collector：应用只需要知道一个地址；重试、批处理、脱敏、采样、加 K8s 元数据都在 Collector 里完成；换后端只改 Collector 配置。

### 1、管道模型

![Collector 管道](../assets/observability/otel-collector-pipeline.svg)

| 组件 | 作用 | 常用 |
|------|------|------|
| receivers | 接收数据，可以是推（OTLP）也可以是拉（抓取 Prometheus 端点） | `otlp`、`prometheus`、`file_log`、`kafka` |
| processors | 按声明顺序处理数据 | `memory_limiter`、`batch`、`k8s_attributes`、`resource_detection`、`attributes`、`filter`、`transform`、`tail_sampling` |
| exporters | 发送到后端 | `otlp_grpc`、`otlp_http`、`prometheus_remote_write`、`load_balancing`、`debug` |
| connectors | 连接两条管道，前一条的 exporter 即后一条的 receiver | `span_metrics`（从 Span 生成 RED 指标） |
| extensions | 不处理数据的辅助功能 | `health_check`、`pprof`、认证扩展 |

组件定义了不等于启用了，只有出现在 `service.pipelines` 里的才会运行。

::: tip 组件改名
Collector 正在把组件类型统一改为 snake_case，从 v0.144.0 开始陆续生效：`otlp` exporter 改名为 `otlp_grpc`，`otlphttp` 改为 `otlp_http`，`k8sattributes` 改为 `k8s_attributes`，`loadbalancing` 改为 `load_balancing`，`filelog` 改为 `file_log` 等，旧名作为弃用别名仍可使用。网上大量示例还是旧名，照抄可以运行，但新配置建议直接用新名。`otlp` receiver 的名称没有变。
:::

### 2、一份可用的配置

下面是 Gateway 层的完整配置：接收 OTLP，三种信号分别发往 Tempo、Prometheus 3 和 Loki 3。

```yaml
extensions:
  health_check:
    endpoint: 0.0.0.0:13133

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:                      # 必须放在 processors 第一位
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 20
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: keep-slow
        type: latency
        latency:
          threshold_ms: 1000
      - name: sample-rest
        type: probabilistic
        probabilistic:
          sampling_percentage: 10
  batch:
    send_batch_size: 8192
    timeout: 5s

exporters:
  otlp_grpc/tempo:
    endpoint: tempo.observability:4317
    tls:
      insecure: true
  otlp_http/prometheus:
    endpoint: http://prometheus.observability:9090/api/v1/otlp    # 自动拼接 /v1/metrics
  otlp_http/loki:
    endpoint: http://loki.observability:3100/otlp                 # 自动拼接 /v1/logs
  debug:
    verbosity: basic

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp_grpc/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/loki, debug]
```

配置要点：

- **监听地址**：新版本 receiver 默认只监听 `localhost`，在容器中运行时必须显式写 `0.0.0.0`，否则其他 Pod 连不进来
- **`memory_limiter` 放第一位**：内存超过阈值时直接拒绝新数据，让上游重试，而不是 OOM 后把缓冲中的数据全丢掉；容器中按百分比配置，基于 cgroup 内存限制计算
- **`batch` 放在靠后的位置**：攒批后再发，显著减少网络请求数；社区正在用 `queue_batch` 处理器和 exporter 自带的 `sending_queue` 批处理逐步取代它，目前 `batch` 仍是标准写法
- **`type/name` 形式**：同一类型的组件可以定义多个实例，如 `otlp_http/prometheus` 与 `otlp_http/loki`
- **Prometheus**：需要以 `--web.enable-otlp-receiver` 启动，资源属性如何变成标签见 [指标监控](./2_metrics) 的 OTLP 一节；也可以改用 `prometheus_remote_write` exporter 写入 Mimir、VictoriaMetrics 等远程存储
- **Loki**：Loki 3 原生接收 OTLP，地址为 `/otlp`；collector-contrib 中专用的 `loki` exporter 自 2024 年起弃用，已于 v0.131.0 移除，旧配置要换成 `otlp_http`
- **Jaeger v2**：同样原生接收 OTLP，把 `otlp_grpc/tempo` 的地址换成 Jaeger 即可

配置写好后先用 `otelcol-contrib validate --config=config.yaml` 校验，再上线。

### 3、发行版

| 发行版 | 镜像 | 说明 |
|--------|------|------|
| core | `otel/opentelemetry-collector` | 只含最核心的组件（OTLP 收发、batch、memory_limiter、debug） |
| contrib | `otel/opentelemetry-collector-contrib` | 包含几乎所有社区组件，体积大，适合起步和实验 |
| k8s | `otel/opentelemetry-collector-k8s` | 为 Kubernetes 场景挑选的组件集合 |
| 自定义 | 用 OpenTelemetry Collector Builder（`ocb`）构建 | 只打包需要的组件，镜像小、攻击面小，生产推荐 |

---

## 六、在 Kubernetes 上部署

### 1、Agent 与 Gateway

![Kubernetes 上的两层部署](../assets/observability/otel-k8s-deployment.svg)

| 模式 | K8s 工作负载 | 职责 |
|------|-------------|------|
| Agent | DaemonSet，每个节点一个 | 就近接收本节点 Pod 的数据；`k8s_attributes` 补充 Pod、Deployment、Namespace 等元数据；采集节点上的容器日志文件；按 traceID 把 Span 路由到 Gateway |
| Gateway | Deployment，多副本 + HPA | 集中做尾部采样、脱敏、过滤，统一持有后端凭证，再导出到各后端 |

小规模集群可以只部署 Gateway，应用直接发给 Gateway 的 Service；需要尾部采样且 Gateway 有多个副本时，必须有一层按 traceID 路由，保证同一 Trace 的 Span 落在同一个副本上。Agent 层的关键配置：

```yaml
processors:
  k8s_attributes:
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.pod.name
        - k8s.deployment.name
        - k8s.node.name
    pod_association:
      - sources:
          - from: connection           # 用连接的源 IP 找到对应的 Pod

exporters:
  load_balancing:
    routing_key: traceID
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      k8s:
        service: otel-gateway.observability   # Gateway 的 Service 名.命名空间
        ports: [4317]
  otlp_grpc/gateway:
    endpoint: otel-gateway.observability:4317
    tls:
      insecure: true
```

traces 管道使用 `load_balancing`，metrics 和 logs 管道直接发 `otlp_grpc/gateway`（`traceID` 路由只适用于 traces 和 logs）。`k8s_attributes` 与 `load_balancing` 的 k8s 解析器都需要读取 API Server，要给 Collector 的 ServiceAccount 授予 Pod、ReplicaSet、EndpointSlice 等资源的 `get` / `list` / `watch` 权限。

### 2、应用如何找到本节点的 Agent

DaemonSet 通过 `hostPort` 暴露 4317 / 4318，应用用 Downward API 拿到节点 IP：

```yaml
env:
  - name: NODE_IP
    valueFrom:
      fieldRef:
        fieldPath: status.hostIP
  - name: OTEL_SERVICE_NAME
    value: order-service
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://$(NODE_IP):4318      # 引用前面定义的变量
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: service.namespace=shop,deployment.environment.name=prod
```

Deployment 的其他部分（探针、资源、滚动更新）见 [Kubernetes](/cloud-native/6_kubernetes) 的实战一节。

### 3、Helm 与 Operator

- **Helm Chart**：`open-telemetry/opentelemetry-collector` 用 `mode` 选择 `daemonset` / `deployment`，`presets.kubernetesAttributes.enabled=true` 会自动配置 `k8s_attributes` 及所需 RBAC，Collector 配置写在 values 的 `config` 下，Helm 的用法见 [Helm](/cloud-native/8_helm)
- **OpenTelemetry Operator**：用 `OpenTelemetryCollector` 自定义资源声明 Collector（支持 daemonset、deployment、statefulset、sidecar 四种模式）；用 `Instrumentation` 资源配置 agent 镜像和 `OTEL_*` 参数，再给 Pod 加注解 `instrumentation.opentelemetry.io/inject-java: "true"`，Operator 会通过 init 容器自动注入 Java agent，镜像里无需再打包 agent

---

## 七、与后端集成

### 1、常见组合

| 信号 | 开源后端 | Collector exporter |
|------|----------|--------------------|
| Traces | Tempo、Jaeger v2 | `otlp_grpc` |
| Metrics | Prometheus 3、Mimir、VictoriaMetrics | `otlp_http`（Prometheus OTLP 接收）或 `prometheus_remote_write` |
| Logs | Loki 3、Elasticsearch / OpenSearch | `otlp_http`（Loki）或 contrib 中的 `elasticsearch` exporter |
| 展示 | Grafana | 不经 Collector，直接查询各后端 |

Grafana 的 Loki、Tempo、Mimir 加上 Grafana 本身常被称为 LGTM 栈，配合 OTel 可以实现三种信号之间的互相跳转，关联方式见 [链路追踪](./3_tracing) 第七节。

### 2、本地实验环境

Grafana 提供的 `grafana/otel-lgtm` 镜像把 Collector、Prometheus、Tempo、Loki 和 Grafana 打包在一个容器里，适合本地验证接入效果：

```bash
docker run --rm -p 3000:3000 -p 4317:4317 -p 4318:4318 grafana/otel-lgtm
```

应用挂上 agent 后保持默认的 `http://localhost:4318` 即可上报，打开 `http://localhost:3000` 查看。Spring Boot 4 官方 starter 配合 Docker Compose 支持时，也能识别这个镜像并自动配置 OTLP 地址。它只用于开发，不要用在生产。

---

## 八、落地关注点

| 关注点 | 建议 |
|--------|------|
| 性能开销 | agent 会增加启动时间和少量 CPU、内存；上线前用压测对比挂与不挂 agent 的 P99 和吞吐，按需关闭用不到的插桩 |
| 采样 | 默认 `parentbased_always_on` 是全采，生产必须显式设置；采样策略见 [链路追踪](./3_tracing) 第五节 |
| 资源属性规范 | 全公司统一 `service.name`、`service.namespace`、`deployment.environment.name` 的取值规则，否则看板和告警无法复用 |
| 语义约定迁移 | 稳定版约定替换实验版时属性名会变；部分插桩支持 `OTEL_SEMCONV_STABILITY_OPT_IN`（如 `database/dup` 同时输出新旧属性），给看板和告警留出切换时间 |
| 敏感数据 | URL 参数、SQL 参数、请求头可能带个人信息，默认不采集的不要随意打开；必要时在 Collector 用 `attributes` / `transform` 处理器删除或脱敏 |
| 指标基数 | 自定义属性进入指标会成倍增加时间序列，规则见 [指标监控](./2_metrics) 的基数一节 |
| Collector 自身可观测 | Collector 暴露自身指标（接收量、丢弃量、队列长度），要纳入监控并对 `refused`、`dropped` 类指标告警 |
| 版本升级 | agent 与 Collector 都按月发版，Collector 仍处于 0.x，配置项可能有破坏性变更，升级前阅读 changelog |

---

## 小结

- OpenTelemetry 只管数据的产生、描述和传输，不管存储；靠 OTLP 和语义约定做到"换后端不改代码"
- 组成是 API、SDK、插桩、Collector、OTLP、语义约定；traces、metrics、logs 均已稳定，profiles 处于 Alpha
- Java 接入三选一：agent 零代码、覆盖最广；Boot 4 官方 starter 基于 Micrometer、支持原生镜像；社区 starter 只用于 Boot 3 的特殊场景，不要叠加使用
- agent 2.x 默认使用 `http/protobuf` 和 4318 端口、稳定版 HTTP 语义约定，并关闭 Micrometer 桥接；配置以 `OTEL_*` 环境变量为主，声明式配置的规范已稳定但 Java 实现仍是实验性
- Collector 由 receivers、processors、exporters 组成管道，`memory_limiter` 放第一位；组件已改用 snake_case 新名，Loki 改用 `otlp_http` 写入
- Kubernetes 上采用 DaemonSet Agent + Deployment Gateway 两层部署，尾部采样需要按 traceID 路由到同一副本

## 参考资料

- OpenTelemetry 文档：[What is OpenTelemetry?](https://opentelemetry.io/docs/what-is-opentelemetry/)
- 各语言与信号状态：[Status](https://opentelemetry.io/status/)
- Java agent：[Java zero-code instrumentation](https://opentelemetry.io/docs/zero-code/java/agent/)
- Java agent 配置：[Agent Configuration](https://opentelemetry.io/docs/zero-code/java/agent/configuration/)
- Java SDK 配置与环境变量：[Configure the SDK](https://opentelemetry.io/docs/languages/java/configuration/)
- Java agent 发布记录：[opentelemetry-java-instrumentation Releases](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases)
- 社区 Spring Boot starter：[Spring Boot starter](https://opentelemetry.io/docs/zero-code/java/spring-boot-starter/)
- Spring 官方博客：[OpenTelemetry with Spring Boot](https://spring.io/blog/2025/11/18/opentelemetry-with-spring-boot/)
- 声明式配置稳定公告：[Declarative configuration is stable](https://opentelemetry.io/blog/2026/stable-declarative-config/)
- Profiles 进入 Alpha：[OpenTelemetry Profiles Enters Public Alpha](https://opentelemetry.io/blog/2026/profiles-alpha/)
- 语义约定：[OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- Collector 配置：[Collector Configuration](https://opentelemetry.io/docs/collector/configuration/)
- Collector 部署模式：[Collector Deployment](https://opentelemetry.io/docs/collector/deployment/)
- Collector 变更记录：[opentelemetry-collector CHANGELOG](https://github.com/open-telemetry/opentelemetry-collector/blob/main/CHANGELOG.md)、[opentelemetry-collector-contrib CHANGELOG](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/CHANGELOG.md)
- 负载均衡导出器：[Load Balancing Exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/loadbalancingexporter/README.md)
- K8s 属性处理器：[Kubernetes Attributes Processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/k8sattributesprocessor/README.md)
- OpenTelemetry Operator：[OpenTelemetry Operator for Kubernetes](https://opentelemetry.io/docs/platforms/kubernetes/operator/)
- Collector Helm Chart：[OpenTelemetry Collector Chart](https://opentelemetry.io/docs/platforms/kubernetes/helm/collector/)
- Prometheus 接收 OTLP：[Using Prometheus as your OpenTelemetry backend](https://prometheus.io/docs/guides/opentelemetry/)
- Loki 接收 OTLP：[Ingesting logs to Loki using OpenTelemetry Collector](https://grafana.com/docs/loki/latest/send-data/otel/)
- 本地 LGTM 镜像：[grafana/docker-otel-lgtm](https://github.com/grafana/docker-otel-lgtm)

---
description: 日志分类与级别策略、JSON 字段规范、traceId 关联、采集链路、Loki 与 ELK 选型、LogQL、保留与脱敏
---

# 日志体系

> 前置阅读：[日志](/spring-boot/12_logging)、[可观测性总览](./0_overview)

日志平台关心的是日志离开应用之后的事情。本篇讲分类与级别、结构化与 traceId 关联、Kubernetes 采集、Loki 与 Elasticsearch 选型、保留与脱敏。

---

## 一、日志分类与用途

示例统一以 Kubernetes 上运行的 `order-service`（命名空间 `order`）为对象，另含 LogQL 查询与控量手段。

不同类别的日志，读者、保留期和可靠性要求完全不同，混在一条管道、一个保留策略里，要么成本失控，要么合规不达标。

| 类别 | 内容 | 主要读者 | 可靠性要求 | 保留期参考 |
|------|------|----------|------------|------------|
| 应用日志 | 业务流程、状态变化、异常 | 开发、On-call | 允许极端情况下少量丢失 | 短期（数天到数周） |
| 访问日志 | 每个 HTTP 请求的方法、路径、状态码、耗时 | 运维、安全 | 可采样，异常请求全量 | 短期，聚合结果可长期保留 |
| 审计日志 | 谁在何时对什么资源做了什么操作 | 安全、合规、审计 | **不能丢、不可篡改** | 按法规要求（常见为数月到数年） |
| 系统日志 | GC 日志、容器事件、节点内核日志 | 平台、SRE | 一般 | 短期 |

几点约定：

- **审计日志单独一条管道**：同步写出、独立索引或独立租户、只追加，存储层开启对象锁（WORM）或写入不可修改的存储；实现方式见 [数据安全](/security/7_data_security) 第四节
- **访问日志优先在网关 / Ingress 层统一输出**，应用内不必再逐请求打一条 INFO；应用只记录业务含义的事件
- **能用指标表达的不要用日志**：请求量、错误率、耗时分布用 Micrometer 指标统计，比从日志里 `count_over_time` 便宜得多；日志用来解释"那几次失败具体是什么"

---

## 二、日志级别策略

级别是写日志的人和读日志的人之间的约定。团队内统一语义，才能让"只看 ERROR"成为有效的排障入口。

| 级别 | 语义 | 示例（order-service） | 生产是否输出 | 是否触发告警 |
|------|------|------------------------|--------------|--------------|
| ERROR | 当前请求或任务失败，需要人介入或至少需要统计 | 调用支付网关超时且重试耗尽；消息消费进入死信 | 是 | 按错误率或数量告警，不对单条告警 |
| WARN | 异常但已自愈或已降级，持续出现说明有隐患 | 库存服务超时，已走降级返回；重试第 2 次成功 | 是 | 一般不告警，进看板 |
| INFO | 关键业务节点与状态变化 | 订单创建、支付成功、状态机迁移；应用启动完成 | 是 | 否 |
| DEBUG | 排障细节 | 请求参数、SQL、分支判断 | 否，临时开启 | 否 |
| TRACE | 框架内部细节 | 连接池借还 | 否 | 否 |

落地要点：

- **生产默认 INFO**，第三方框架包统一调到 WARN；需要 DEBUG 时用 `/actuator/loggers` 对单个包临时调级，排查完恢复，见 [日志](/spring-boot/12_logging) 第六节
- **ERROR 必须可行动**：被调用方返回业务校验失败（如参数错误）是 WARN 甚至 INFO，不是 ERROR；否则 ERROR 被噪声淹没，基于 ERROR 数量的告警就失去意义
- **同一异常只记录一次**：在统一异常处理处打 ERROR 并带完整异常栈，中间层不要"打一条再抛出"
- **防日志风暴**：下游故障时，每个失败请求都打异常栈会让日志量瞬间放大数十倍，压垮采集管道和存储。应用侧写日志不能阻塞业务线程（异步 Appender 与 `neverBlock` 的取舍见 [日志](/spring-boot/12_logging) 第四节），平台侧在 Agent 和存储层设置限流（见第八节）

---

## 三、结构化日志与字段规范

### 1、为什么必须是 JSON

文本日志需要在采集端用正则或 grok 解析，字段一改、多一个空格解析就失败；多行异常栈还要额外配置多行合并规则。结构化 JSON 一行一个事件，异常栈作为字段内的字符串，采集端零解析，查询端直接按字段过滤。

Spring Boot 3.4 起内置 `ecs`、`gelf`、`logstash` 三种结构化格式，配置方法见 [日志](/spring-boot/12_logging) 第三节。平台侧要做的是**全公司选定一种格式**，让所有服务的字段名一致——同一个"日志级别"，在 ECS 里是 `log.level`，在 Logstash 格式里是 `level`，在 OTel 日志模型里是 `SeverityText`，混用会让跨服务查询和告警规则写不下去。

### 2、字段清单

以 ECS 格式为例，order-service 一条错误日志输出如下（字段由 Boot 的 ECS 格式化器、MDC 和 SLF4J Fluent API 的 `addKeyValue` 共同产生）：

```json
{"@timestamp":"2026-10-10T08:15:30.123456789Z","log":{"level":"ERROR","logger":"com.example.order.payment.PaymentClient"},"process":{"pid":1,"thread":{"name":"http-nio-8080-exec-7"}},"service":{"name":"order-service","version":"1.8.2","environment":"prod"},"message":"调用支付网关超时，重试已耗尽","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7","orderId":"O202610100001","costMs":3012,"errorCode":"PAY_TIMEOUT","ecs":{"version":"8.11"}}
```

| 字段 | 来源 | 要求 |
|------|------|------|
| `@timestamp` | 格式化器 | ISO-8601、UTC 或带时区，精确到毫秒以上；不要用本地时间字符串 |
| `log.level` / `log.logger` | 格式化器 | 级别语义按第二节约定 |
| `service.name` / `version` / `environment` | `logging.structured.ecs.service.*` | 服务名与 Kubernetes 中的 `app.kubernetes.io/name` 保持一致，版本用于对比发布前后 |
| `traceId` / `spanId` | Micrometer Tracing 写入 MDC | 见第四节；**不要自己生成另一套 requestId** |
| 业务键（`orderId`、`errorCode`、`costMs`） | `addKeyValue` 或 MDC | 键名用 lowerCamelCase 并全公司统一；数值字段输出为数字而不是字符串，便于范围过滤 |
| `error.type` / `error.message` / `error.stack_trace` | 格式化器（记录异常时） | 异常栈过长时用 `logging.structured.json.stacktrace.max-length` 裁剪 |
| Pod、节点、命名空间、集群 | **采集 Agent 补充** | 应用不要自己写这些字段，由 Agent 从文件路径或 Kubernetes API 获取 |

两个容易被忽略的约定：

- **message 写给人看，字段写给机器查**：`"调用支付网关超时，重试已耗尽"` 是固定文本，订单号、耗时放进独立字段；不要写成 `"订单 O2026... 支付超时 3012ms"`，否则无法按订单号精确过滤，也无法按消息模板聚合
- **字段名不随意新增**：Elasticsearch 中每个新字段都会进入索引映射（mapping），字段数量无节制增长会导致映射膨胀；在 Loki 中虽然没有映射问题，但字段名不统一同样让查询写不下去

---

## 四、日志与链路关联

### 1、traceId 从哪里来

引入 Micrometer Tracing 后，每个请求的 `traceId`、`spanId` 会被自动写入 MDC，结构化日志随之输出为 JSON 字段，跨线程池与响应式链路的传递方式见 [日志](/spring-boot/12_logging) 第五节。需要注意 MDC 键名在两条接入路线上不同：

| 接入方式 | MDC 键 |
|----------|--------|
| Micrometer Tracing（Brave / OTel bridge） | `traceId`、`spanId` |
| OpenTelemetry Java agent | `trace_id`、`span_id`、`trace_flags` |

全公司应只用一条路线，或在平台侧统一字段名，否则 Grafana 的跳转规则要为每种写法各配一条。

### 2、把 traceId 返回给调用方

用户报障时，最有用的信息就是那次请求的 traceId。在响应头里返回它，客服和前端就能直接把 traceId 交给开发：

```java
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class TraceIdResponseFilter extends OncePerRequestFilter {

    private final Tracer tracer;

    public TraceIdResponseFilter(Tracer tracer) {
        this.tracer = tracer;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        Span span = tracer.currentSpan();
        if (span != null) {
            response.setHeader("X-Trace-Id", span.context().traceId());
        }
        chain.doFilter(request, response);
    }
}
```

这个 Filter 使用默认的最低优先级，排在 Spring Boot 注册的 HTTP 观测 Filter 之后执行，此时当前 Span 已经创建。统一异常响应体里也可以带上 traceId，前提是它不泄露内部信息——traceId 本身只是随机 ID，可以对外暴露。

### 3、在 Grafana 中互相跳转

- **日志 → 链路**：在 Loki 数据源上配置派生字段（derived field），用正则从日志行中提取 traceId，渲染成跳转到 Tempo 的链接
- **链路 → 日志**：在 Tempo 数据源上配置 trace to logs，点击 Span 时按 traceId 和时间范围生成 Loki 查询

Loki 数据源的派生字段可以通过 provisioning 文件声明：

```yaml
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    uid: loki
    url: http://loki-gateway.monitoring.svc
    jsonData:
      derivedFields:
        - name: TraceID
          matcherRegex: '"traceId":"(\w+)"'
          datasourceUid: tempo
          url: '$${__value.raw}'
          urlDisplayLabel: 查看链路
```

`url` 中的 `$` 在 provisioning 文件里要写成 `$$` 转义；`datasourceUid` 必须与 Tempo 数据源的 `uid` 一致。

::: tip traceId 不要做成 Loki 标签
traceId 每个请求都不同，做成标签会让每个请求成为一条独立的流，索引瞬间膨胀。它应该留在日志行里用过滤表达式查，或作为结构化元数据（structured metadata）存储，见第六节。
:::

---

## 五、采集链路

![Kubernetes 日志采集链路](../assets/observability/logging-pipeline.svg)

### 1、部署模式

| 模式 | 做法 | 优点 | 缺点 | 适用 |
|------|------|------|------|------|
| 节点 Agent（DaemonSet） | 应用写 stdout，容器运行时落盘到 `/var/log/pods`，每个节点一个 Agent 读取 | 应用无感知、资源开销集中、Agent 故障不影响应用 | 需要挂载宿主机目录，多租户隔离靠标签 | **Kubernetes 默认选择** |
| Sidecar | 每个 Pod 内跑一个采集容器读共享卷中的文件 | 能处理只写文件的遗留应用、按 Pod 定制 | 每个 Pod 多一份资源开销 | 无法改成 stdout 的应用 |
| 应用直推 | 应用通过 OTLP 直接把日志发给 Collector | 无需解析文件，日志自带 traceId 等结构化属性 | 日志可靠性依赖网络与 Collector，应用要处理背压 | 已全面使用 OTel 的团队 |
| 主机 Agent | 虚拟机上 Agent 读取滚动日志文件 | 传统部署成熟方案 | 要管理文件轮转与位点 | 非容器化部署 |

容器化部署中应用**只输出 stdout**，不在容器内写文件，原因见 [日志](/spring-boot/12_logging) 第九节和 [Kubernetes](/cloud-native/6_kubernetes)。日志量很大或存储需要维护窗口时，可以在 Agent 与存储之间加 Kafka 缓冲，存储故障时日志先积压在 Kafka 中，避免 Agent 本地缓冲打满后丢弃。

### 2、Agent 选型

| Agent | 实现 | 特点 | 适合 |
|-------|------|------|------|
| OpenTelemetry Collector | Go | `filelog` receiver 读取容器日志，与指标、链路共用一套配置和 OTLP 协议；处理器生态丰富 | 新建平台、希望三种信号统一采集 |
| Fluent Bit | C | 内存占用很小，Kubernetes 元数据过滤器成熟，直接输出到 Loki、Elasticsearch、Kafka 等 | 资源敏感的节点 Agent |
| Vector | Rust | 内置 VRL 转换语言，转换与路由能力强，可同时做 Agent 和聚合层 | 需要复杂清洗、多目标路由 |
| Filebeat / Elastic Agent | Go | Elastic 官方，与 Elasticsearch 的索引模板、Ingest Pipeline 配套 | 已经是 Elastic 技术栈 |
| Logstash | JVM | 重量级聚合与转换层，插件多但资源占用高 | 已有存量，一般不再作为节点 Agent |

### 3、OpenTelemetry Collector 采集配置

以 DaemonSet 方式部署 Collector（contrib 或 k8s 发行版），挂载宿主机的 `/var/log/pods`，读取容器日志后补充 Kubernetes 元数据，以 OTLP 发往 Loki 3：

```yaml
extensions:
  file_storage:
    directory: /var/lib/otelcol/file_storage   # 持久化读取位点，Collector 重启后不重复、不丢失

receivers:
  filelog:
    include:
      - /var/log/pods/*/*/*.log
    exclude:
      - /var/log/pods/kube-system_*/*/*.log
      - /var/log/pods/*/otel-collector/*.log      # 不采集自己，避免循环
    start_at: end
    include_file_path: true                        # container 解析器依赖 log.file.path 提取 Pod 信息
    storage: file_storage
    operators:
      - type: container                            # 自动识别 containerd / CRI-O / Docker 格式，合并 CRI 分片行
        id: container-parser

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  k8sattributes:
    auth_type: serviceAccount
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.uid
    extract:
      metadata:
        - k8s.deployment.name
        - k8s.node.name
      labels:
        - tag_name: service.name
          key: app.kubernetes.io/name
          from: pod
  resource:
    attributes:
      - key: k8s.cluster.name
        value: prod-sh
        action: upsert
  batch: {}

exporters:
  otlphttp/loki:
    endpoint: http://loki-gateway.monitoring.svc/otlp

service:
  extensions: [file_storage]
  pipelines:
    logs:
      receivers: [filelog]
      processors: [memory_limiter, k8sattributes, resource, batch]
      exporters: [otlphttp/loki]
```

- `container` 解析器从文件路径中解析出 `k8s.namespace.name`、`k8s.pod.name`、`k8s.pod.uid`、`k8s.container.name` 等资源属性；`k8sattributes` 再按 Pod UID 去 Kubernetes API 查询 Deployment 名和 Pod 标签，需要为 Collector 的 ServiceAccount 授予读取 Pod、ReplicaSet 等资源的 RBAC 权限
- `memory_limiter` 放在处理器链的第一位，内存接近上限时拒绝新数据，避免 Collector 被 OOMKill
- 应用输出的 JSON 原样作为日志正文（body）存入 Loki，查询时用 `| json` 解析；Loki 把 `service.name`、`k8s.namespace.name` 等资源属性转为索引标签 `service_name`、`k8s_namespace_name`（点号替换为下划线），其余属性存为结构化元数据
- 向 Loki 发送日志请使用 `otlphttp` exporter 并指向 `/otlp` 路径，这是 Loki 3 推荐的原生 OTLP 接入方式

### 4、Fluent Bit 采集配置

使用 Fluent Bit 时的等价配置（YAML 格式）：

```yaml
pipeline:
  inputs:
    - name: tail
      path: /var/log/containers/*.log
      multiline.parser: docker, cri
      tag: kube.*
      db: /var/lib/fluent-bit/flb_kube.db
      mem_buf_limit: 50MB
      skip_long_lines: true

  filters:
    - name: kubernetes
      match: kube.*
      merge_log: on
      keep_log: off

  outputs:
    - name: loki
      match: kube.*
      host: loki-gateway.monitoring.svc
      port: 80
      labels: cluster=prod-sh, namespace=$kubernetes['namespace_name'], app=$kubernetes['labels']['app.kubernetes.io/name']
      structured_metadata: pod=$kubernetes['pod_name']
      line_format: json
```

`merge_log: on` 会把应用输出的 JSON 展开为记录字段；`db` 保存读取位点；`mem_buf_limit` 限制输入缓冲，超出时暂停读取而不是无限占用内存。标签只放集群、命名空间、应用这类取值有限的维度，Pod 名放在结构化元数据中。

---

## 六、存储与检索选型

### 1、三类方案对比

| 维度 | Elasticsearch / OpenSearch | Loki | ClickHouse |
|------|----------------------------|------|------------|
| 索引方式 | 全文倒排索引，所有字段可建索引 | **只索引标签**，日志正文压缩成块存入对象存储 | 列式存储，按排序键与跳数索引过滤 |
| 查询语言 | Query DSL、KQL、ES\|QL | LogQL（类 PromQL） | SQL |
| 全文检索 | 强，支持分词、相关性、模糊匹配 | 先按标签选流，再在块中暴力扫描过滤 | 依赖 `LIKE`、token / ngram 跳数索引，弱于 ES |
| 存储成本 | 高：索引体积可与原始数据相当，需要 SSD | 低：对象存储 + 高压缩比 | 低：列存压缩比高 |
| 运维复杂度 | 高：分片、映射、JVM 堆、集群扩缩 | 中：组件多，但存储交给对象存储 | 中：表结构与分区设计需要经验 |
| 聚合分析 | 强 | 适合按时间窗口计数、速率，复杂聚合较弱 | **最强**，适合大规模统计分析 |
| 典型场景 | 需要全文检索、复杂查询、安全分析（SIEM） | 云原生运维排障，已用 Prometheus + Grafana | 超大日志量、需要 SQL 分析 |

选型建议：

- **以排障为主、已经使用 Prometheus 与 Grafana**：选 Loki，成本最低，与指标、链路在同一个 Grafana 中关联
- **需要模糊搜索、复杂过滤、安全审计分析**：选 Elasticsearch 或 OpenSearch，接受更高的存储与运维成本
- **日志量极大且有统计分析需求**：选 ClickHouse 或基于它的可观测性产品
- 不要为了"什么都能查"把所有日志都全文索引——绝大多数查询都是"某服务、某时间段、某个 traceId 或关键字"，标签 + 扫描就足够

Elasticsearch 的倒排索引与分片原理见 [搜索数据库](/database/4_nosql/3_search_db)。

### 2、Loki 的标签与基数

Loki 中**一组标签值的组合就是一条流（stream）**，每条流单独切块、单独索引。标签越多、取值越分散，流就越多、每块越小，索引膨胀、查询变慢、写入压力增大——这就是 Loki 的基数问题，与 Prometheus 的时间序列基数是同一回事。

| 维度 | 是否做标签 | 原因 |
|------|------------|------|
| 集群、命名空间、服务名、环境 | 是 | 取值少且稳定，几乎每次查询都会用 |
| 容器名、Deployment 名 | 可以 | 取值有限 |
| Pod 名、实例 ID | 谨慎 | 每次发布都会产生新值；Loki 官方已不建议新用户默认把 `k8s.pod.name` 作为标签 |
| 日志级别 | 通常不需要 | 会把一个服务的日志拆成 4～5 条流，用 `| json | log_level="ERROR"` 过滤通常同样快 |
| traceId、orderId、userId、请求路径原值 | **绝不** | 无界取值，每个值都是一条新流 |

高基数但常用于精确查询的值（traceId、Pod 名），放到**结构化元数据**中：它随日志行存储，不参与流的划分，可以在查询中像标签一样过滤。通过 OTLP 写入 Loki 时，未被列为索引标签的资源属性和日志属性会自动进入结构化元数据。

排查标签基数可以用 `logcli series --analyze-labels '{k8s_namespace_name="order"}'`，找出唯一值过多的标签后从采集配置中移除。

---

## 七、LogQL 查询

LogQL 的结构是"**流选择器 + 管道**"：先用 `{}` 中的标签选出流（走索引，越精确越好），再用管道逐行过滤、解析、格式化。下面的查询都基于上文 ECS 格式的 order-service 日志；`| json` 会把嵌套字段展平，点号替换为下划线，例如 `log.level` 变成 `log_level`。

### 1、日志查询

```logql
# 1. 某服务的全部 ERROR 日志
{service_name="order-service"} | json | log_level="ERROR"

# 2. 按 traceId 串起一次请求在本命名空间所有服务中的日志（行过滤器放最前面，先做廉价的字符串匹配）
{k8s_namespace_name="order"} |= "4bf92f3577b34da6a3ce929d0e0e4736" | json

# 3. 耗时超过 1 秒的支付调用（costMs 为数值字段）
{service_name="order-service"} |= "PaymentClient" | json | costMs > 1000

# 4. 排除噪声：去掉健康检查，再用正则匹配错误码
{service_name="order-service"} != "/actuator/health" |~ `"errorCode":"PAY_\w+"`

# 5. 只显示关心的字段，便于在 Grafana 中浏览
{service_name="order-service"} | json | log_level="ERROR" | line_format "{{.traceId}} {{.errorCode}} {{.message}}"
```

- 行过滤器（`|=`、`!=`、`|~`、`!~`）要放在解析器之前，先在原始行上快速筛掉大部分数据，再对剩余的行做 JSON 解析
- 正则用反引号包裹可以避免双重转义
- 解析出的字段与已有的流标签同名时（例如 ECS 的 `service.name` 解析后与标签 `service_name` 冲突），解析结果会被加上 `_extracted` 后缀
- 解析失败的行会带上 `__error__` 标签；做数值比较或聚合前可以加 `| __error__=""` 排除这些行

### 2、指标查询

LogQL 可以把日志转换成时间序列，用于看板和日志告警：

```logql
# 6. 每个服务每秒的 ERROR 日志数
sum by (service_name) (rate({k8s_namespace_name="order"} | json | log_level="ERROR" [5m]))

# 7. 最近一小时出现最多的 5 个错误码
topk(5, sum by (errorCode) (count_over_time({service_name="order-service"} | json | errorCode != "" [1h])))

# 8. 从日志中的 costMs 字段计算 P99 耗时
quantile_over_time(0.99, {service_name="order-service"} | json | __error__="" | unwrap costMs [5m]) by (service_name)
```

- `rate` / `count_over_time` 统计日志条数，`unwrap` 把字段值提取为样本做数值聚合
- 指标查询要扫描时间窗口内的全部匹配日志，范围越大越慢；**长期看板应基于 Micrometer 指标**，日志指标只用于临时分析或没有对应指标的场景
- 这类查询可以写进 Loki ruler 作为日志告警规则，告警的设计与路由见 [告警体系](./4_alerting)

---

## 八、保留周期与成本控制

日志是三大信号中唯一随请求量线性增长的，成本控制要从源头到存储层层设防。

### 1、源头控量

| 手段 | 做法 |
|------|------|
| 级别治理 | 生产默认 INFO，框架包 WARN；定期按服务统计日志量排名，日志量异常大的服务优先治理 |
| 不打无用日志 | 不打印完整请求 / 响应体、大对象、循环内逐条日志；健康检查、探针请求不记访问日志 |
| 用指标代替日志 | 计数、耗时类信息用 Micrometer 指标，不要靠日志统计 |
| 采样 | 成功请求的访问日志按比例采样，错误与慢请求全量保留 |

### 2、管道过滤与限流

在 Collector 中丢弃已知噪声，比存下来再删便宜：

```yaml
processors:
  filter/drop-noise:
    error_mode: ignore
    logs:
      log_record:
        - 'IsMatch(body, "GET /actuator/(health|prometheus)")'
```

`filter` 处理器中匹配条件的日志会被丢弃，把它加入 logs 流水线的 `processors` 列表（放在 `memory_limiter` 之后）即可生效。存储层也要设置保护性限流，防止单个服务的日志风暴拖垮整个集群，Loki 中对应 `limits_config` 下的 `ingestion_rate_mb`、`ingestion_burst_size_mb`、`per_stream_rate_limit`、`max_line_size` 等参数，可以按租户覆盖。

### 3、分级保留

不同命名空间、不同类别的日志设置不同的保留期。Loki 的保留由 compactor 执行：

```yaml
compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: s3

limits_config:
  retention_period: 336h              # 全局默认保留 14 天
  retention_stream:
    - selector: '{k8s_namespace_name="staging"}'
      priority: 1
      period: 72h                     # 测试环境保留 3 天
    - selector: '{k8s_namespace_name="order", service_name="order-service"}'
      priority: 2
      period: 720h                    # 核心服务保留 30 天
```

- 保留依赖 compactor 运行，且索引周期必须为 24h（TSDB 存储的默认推荐）
- `retention_stream` 的选择器只支持标签匹配，`period` 最小 24h；多条规则同时匹配时 `priority` 大者生效
- 审计日志不要和应用日志放在同一个保留策略里，应写入独立租户或独立存储，按合规要求设置更长的保留期

### 4、冷热分层

Elasticsearch 使用索引生命周期管理（ILM）把数据从热节点逐步迁移到温、冷节点，最后删除：

```json
PUT _ilm/policy/order-logs
{
  "policy": {
    "phases": {
      "hot":    { "actions": { "rollover": { "max_primary_shard_size": "50gb", "max_age": "1d" } } },
      "warm":   { "min_age": "7d",  "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "cold":   { "min_age": "30d", "actions": { "set_priority": { "priority": 0 } } },
      "delete": { "min_age": "90d", "actions": { "delete": {} } }
    }
  }
}
```

Loki 的数据本身就在对象存储中，冷热分层主要靠对象存储的生命周期规则（例如 30 天后转为低频存储类别）实现，注意转入归档类存储后数据无法直接被查询。

---

## 九、敏感数据脱敏

日志一旦进入集中存储，就会被大量人员查询、被复制到多个系统，泄露面远大于业务数据库。脱敏按层次设防：

| 层次 | 做法 | 说明 |
|------|------|------|
| 源头 | DTO 排除敏感字段、不打印请求体、Logback `%replace` 兜底 | **最主要的一层**，见 [日志](/spring-boot/12_logging) 第八节 |
| 管道 | Collector `transform` / `redaction` 处理器、Fluent Bit 过滤器按规则替换 | 兜底拦截漏网的手机号、身份证号、Token |
| 存储与访问 | Loki 多租户隔离、Elasticsearch 字段级权限、查询审计 | 不同团队只能看自己的日志，敏感索引单独授权 |
| 生命周期 | 按合规要求设置保留期并真正删除 | 过期日志也是负债 |

管道层用 OTTL 的 `replace_pattern` 对日志正文做正则替换：

```yaml
processors:
  transform/mask:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - replace_pattern(body, "(1[3-9]\\d)\\d{4}(\\d{4})", "$$1****$$2")
          - replace_pattern(body, "(?i)(\"authorization\":\")[^\"]+", "$$1***")
```

- Collector 配置中 `$` 用于环境变量展开，正则的捕获组引用要写成 `$$1`
- 正则对每条日志执行，有 CPU 成本，规则要少而准；`redaction` 处理器适合按属性名白名单 / 黑名单处理结构化属性
- 管道脱敏只是兜底，不能代替源头治理——密码、密钥、完整证件号从一开始就不应该进入日志

脱敏规则（手机号、身份证、银行卡的保留位数）与审计日志设计见 [数据安全](/security/7_data_security)。

---

## 十、排障实战：按 traceId 串起一次慢请求

以"下单接口 P99 突然升高"为例，演示三种信号如何配合：

1. **指标告警**：`http_server_requests_seconds` 的 P99 超过阈值触发告警，看板显示只有 `POST /orders` 变慢，错误率没有明显变化
2. **从指标到链路**：在 P99 面板上点击 exemplar，打开一条慢 trace，瀑布图显示 `order-service → payment-gateway` 这一跳占了 3 秒
3. **从链路到日志**：在该 Span 上点击"查看日志"，Grafana 按 traceId 生成 Loki 查询，看到 `PaymentClient` 连续三条 WARN：连接池获取连接超时，第三次重试成功
4. **扩大范围确认**：用 `sum by (service_name) (count_over_time({k8s_namespace_name="order"} |= "获取连接超时" [15m]))` 统计，发现只有 order-service 出现，且从一次发布后开始
5. **定位根因**：对比发布前后配置，支付客户端的连接池最大连接数被误改小，高峰期排队等待；回滚配置后 P99 恢复

整个过程不需要登录任何一台机器，前提是三件事都做到了：日志是带 traceId 的结构化 JSON、采集链路补全了服务与命名空间标签、Grafana 中配置了信号间的跳转。

---

## 小结

- 日志按应用、访问、审计、系统分类，读者、可靠性和保留期不同；审计日志单独管道、不可篡改；能用指标表达的不要用日志
- 级别语义全团队统一：ERROR 必须可行动，生产默认 INFO，DEBUG 用 Actuator 临时开启；同一异常只记录一次，防止日志风暴
- 全公司选定一种结构化格式（如 ECS），message 写固定文本、业务键放独立字段；Pod、节点等基础设施字段交给采集 Agent 补充
- traceId 由 Micrometer Tracing 写入 MDC，在响应头中返回给调用方；Grafana 用派生字段和 trace to logs 打通日志与链路；traceId 永远不做 Loki 标签
- Kubernetes 下应用只写 stdout，由 DaemonSet Agent（OTel Collector `filelog`、Fluent Bit、Vector）采集，持久化读取位点，`memory_limiter` 放第一位
- 以排障为主选 Loki（只索引标签、成本低），需要全文检索选 Elasticsearch，海量分析选 ClickHouse；Loki 标签只放低基数维度，高基数值放结构化元数据
- LogQL 先用标签选流、再用行过滤器筛选、最后解析；指标查询用于临时分析，长期看板基于 Micrometer 指标
- 成本控制靠源头控量、管道丢噪声、存储限流、分级保留与冷热分层；脱敏以源头为主、管道兜底、存储层做权限隔离

## 参考资料

- Spring Boot 结构化日志：[Spring Boot - Logging](https://docs.spring.io/spring-boot/reference/features/logging.html)
- Spring Boot 日志关联 ID：[Spring Boot - Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- OpenTelemetry Java agent 的 MDC 注入：[Logger MDC auto-instrumentation](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/logger-mdc-instrumentation.md)
- Collector filelog receiver：[Filelog Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/filelogreceiver/README.md)
- Collector container 解析器：[Container operator](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/docs/operators/container.md)
- Collector Kubernetes 属性处理器：[k8sattributes processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/k8sattributesprocessor/README.md)
- Collector 转换处理器（OTTL）：[Transform Processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/transformprocessor/README.md)
- Fluent Bit Tail 输入：[Tail](https://docs.fluentbit.io/manual/data-pipeline/inputs/tail)
- Fluent Bit Loki 输出：[Loki output](https://docs.fluentbit.io/manual/data-pipeline/outputs/loki)
- Loki 接收 OpenTelemetry 日志：[Ingesting logs to Loki using OpenTelemetry Collector](https://grafana.com/docs/loki/latest/send-data/otel/)
- Loki 标签最佳实践：[Label best practices](https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/)
- LogQL 日志查询：[Log queries](https://grafana.com/docs/loki/latest/query/log_queries/)
- LogQL 指标查询：[Metric queries](https://grafana.com/docs/loki/latest/query/metric_queries/)
- Loki 保留策略：[Log retention](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- Grafana Loki 数据源与派生字段：[Configure the Loki data source](https://grafana.com/docs/grafana/latest/datasources/loki/configure/)
- Elasticsearch 索引生命周期管理：[Index lifecycle management](https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management)
- Elastic Common Schema：[ECS Reference](https://www.elastic.co/docs/reference/ecs)

> 下一篇：[指标监控](./2_metrics)

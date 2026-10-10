# 可观测性总览

可观测性（Observability）回答的是：系统出问题时，能不能**只凭它对外输出的信号**判断发生了什么、在哪里、为什么。本模块讲平台侧——信号怎么采集、存在哪里、怎么查询与告警；应用侧怎么打日志、怎么注册指标，分别在 [日志](/spring-boot/12_logging) 与 [Actuator 监控](/spring-boot/7_actuator) 中讲，这里只链接不重复。

**版本基线（2026 年 10 月）**：Spring Boot 4.0 / 4.1，对应 Micrometer 1.16 / 1.17 与 Micrometer Tracing 1.6 / 1.7，Boot 4 新增 `spring-boot-starter-opentelemetry`；OpenTelemetry Java agent 2.x（当前 2.32，2.0 起默认以 `http/protobuf` 协议向 4318 端口导出 OTLP）；Prometheus 3.x（3.0 于 2024 年 11 月发布，带来新版 UI、UTF-8 指标名与 OTLP 接收，当前 3.15，另有 3.13 LTS 线）；Grafana 13.x；Loki 3.x（当前 3.7，原生接收 OTLP 日志，默认开启结构化元数据）；Tempo 3.x（3.0 用新的写入架构取代了 ingester）；Jaeger v2（2024 年 11 月发布，基于 OpenTelemetry Collector 构建，Jaeger v1 已于 2025-12-31 停止维护）；OpenTelemetry Profiles 信号于 2026 年 3 月进入公开 Alpha。

---

## 一、三大信号与 Profiles

| 信号 | 回答的问题 | 数据形态 | 成本特征 | 典型工具 | 本模块 |
|------|------------|----------|----------|----------|--------|
| 指标（Metrics） | 系统健康吗？趋势如何？ | 数值时间序列：指标名 + 标签 + 时间戳 + 值 | 存储与请求量无关，只与时间序列数（基数）有关 | Micrometer、Prometheus、Grafana | [指标监控](./2_metrics) |
| 日志（Logs） | 具体发生了什么？ | 带时间戳的离散事件，最好是结构化 JSON | 与请求量线性增长，是最贵的信号 | Fluent Bit、Loki、Elasticsearch | [日志体系](./1_logging) |
| 链路（Traces） | 一次请求经过了哪里，慢在哪一段？ | 由 Span 组成的调用树，靠 traceId 串联 | 通常需要采样 | Micrometer Tracing、OTel、Tempo、Jaeger | [链路追踪](./3_tracing) |
| Profiles | 哪段代码消耗了 CPU / 内存？ | 带调用栈的采样数据，以火焰图呈现 | 持续低频采样，开销可控 | JFR、async-profiler、Pyroscope | 见 [性能分析工具](/high-perf/3_profilers) |

几条使用原则：

- **指标发现问题，链路定位位置，日志解释原因**：告警来自指标（P99 升高、错误率上升），通过链路找到慢的那一跳，再看那一跳的日志和异常栈。Profiles 用于回答"代码层面为什么慢"
- **信号之间要能互相跳转**：日志里带 traceId，指标的直方图桶带 exemplar（指向一条具体 trace），trace 的 Span 能反查同一 traceId 的日志。没有关联字段，三个后端就是三座孤岛
- **监控与可观测性的区别**：监控针对已知问题预设看板和阈值；可观测性要求在未预料的问题出现时，仍能通过高维度的数据（标签、属性、traceId）临时下钻分析
- **告警不是第四种信号**，而是基于信号的判断规则；SLO 与燃烧速率告警的建模见 [可用性度量](/high-avail/1_sla_slo)，告警规则与路由见 [告警体系](./4_alerting)

---

## 二、整体架构

![可观测性平台整体架构](../assets/observability/overview-observability-stack.svg)

一套典型的开源可观测性平台分为四层：

| 层 | 职责 | 常见选择 |
|----|------|----------|
| 埋点与产生 | 应用产生指标、Span 和日志 | Micrometer + Micrometer Tracing（Spring 原生方式），或 OpenTelemetry Java agent（零代码）；日志由 Logback 输出到 stdout |
| 采集与处理 | 接收、批处理、补充资源属性（服务名、Pod、集群）、脱敏、采样、按信号路由 | OpenTelemetry Collector；日志也常用 Fluent Bit / Vector 节点 Agent |
| 存储与查询 | 按信号特点各自存储 | 指标：Prometheus（长期存储接 VictoriaMetrics / Thanos / Mimir）；日志：Loki / Elasticsearch；链路：Tempo / Jaeger v2；Profiles：Pyroscope |
| 展示与告警 | 看板、探索、跨信号跳转、告警 | Grafana；Prometheus 规则 + Alertmanager，或 Grafana Alerting |

Spring Boot 应用有两条接入路线，选一条为主，不要混用导致重复埋点：

- **Micrometer 路线**：`spring-boot-starter-actuator` 暴露 `/actuator/prometheus` 供 Prometheus 抓取，Micrometer Tracing 通过 OTel bridge 以 OTLP 导出 Span；Boot 4 的 `spring-boot-starter-opentelemetry` 把这套依赖打包好。优点是与 Spring 的 Observation API、配置属性完全对齐
- **OpenTelemetry agent 路线**：`-javaagent:opentelemetry-javaagent.jar` 自动埋点 HTTP、JDBC、Kafka 等常见库，指标、链路、日志都走 OTLP 发往 Collector。优点是零代码、多语言统一；代价是启动变慢、与 Spring 自己的 Observation 埋点可能重叠

两条路线的细节与取舍见 [OpenTelemetry](./5_opentelemetry)。Collector 作为中间层的价值在于：应用只认 OTLP 一个协议，后端怎么换（Jaeger 换 Tempo、自建换云厂商）只改 Collector 配置；采样、脱敏、限流这类治理逻辑也集中在这一层做。

::: tip 本地试验
Grafana 官方提供 `grafana/otel-lgtm` 镜像，一个容器内集成了 OTel Collector、Prometheus、Loki、Tempo、Pyroscope 与 Grafana，适合在本机跑通 order-service 的三大信号，不适合用于生产。
:::

---

## 三、模块导航

<ModuleNav />

---

## 四、推荐阅读路径

1. **先打好应用侧基础**：读 [日志](/spring-boot/12_logging)（结构化日志、MDC 与 traceId）与 [Actuator 监控](/spring-boot/7_actuator)（Micrometer 指标、Observation API），确认应用能正确产出信号。
2. **按信号逐个建设**：读 [日志体系](./1_logging)（采集链路、Loki / Elasticsearch 选型、LogQL），再读 [指标监控](./2_metrics)（指标类型、PromQL、基数控制）和 [链路追踪](./3_tracing)（上下文传播、采样、后端选型）。
3. **把信号变成行动**：读 [告警体系](./4_alerting)，结合 [可用性度量](/high-avail/1_sla_slo) 中的 SLO 与燃烧速率，设计少而准的告警。
4. **统一标准**：读 [OpenTelemetry](./5_opentelemetry)，理解 OTLP、Collector 和语义约定，把各信号的采集收敛到一套标准上。

---

## 五、关联模块

- 应用侧日志框架、结构化日志、MDC 与 traceId 传递 → [日志](/spring-boot/12_logging)
- Actuator 端点、Micrometer 自定义指标、Observation API → [Actuator 监控](/spring-boot/7_actuator)
- SLI / SLO、错误预算与燃烧速率告警 → [可用性度量](/high-avail/1_sla_slo)；故障分级、On-call 与复盘 → [故障应急与复盘](/high-avail/11_incident_response)
- 分位数、吞吐与延迟指标的含义 → [性能指标](/high-perf/1_metrics)；RED / USE 方法 → [性能分析方法论](/high-perf/2_methodology)
- Prometheus 本地 TSDB 与长期存储（VictoriaMetrics / Thanos / Mimir） → [时序数据库](/database/4_nosql/1_time_series_db)
- Elasticsearch 索引与检索原理 → [搜索数据库](/database/4_nosql/3_search_db)
- JFR、jstack 等 JVM 诊断工具 → [诊断工具](/jvm/8_monitoring_tools)；Arthas 等线上诊断 → [线上诊断](/engineering/4_diagnosis)
- Sidecar 代理自动产生的流量指标与链路 → [服务网格](/microservices/3_service_mesh)
- 采集 Agent 的 DaemonSet 部署、Pod 日志路径 → [Kubernetes](/cloud-native/6_kubernetes)
- 日志脱敏与审计日志 → [数据安全](/security/7_data_security)

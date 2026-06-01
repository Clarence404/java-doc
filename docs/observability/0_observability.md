# 可观测性总览

> [!warning] 待补充
> 当前仅整理学习大纲，后续可按日志、指标、链路追踪、告警和排障实践逐步补充。

## 模块导航

| 模块 | 覆盖内容 |
|------|----------|
| [日志体系](./1_logging) | 日志规范、结构化日志、日志采集、日志检索 |
| [指标监控](./2_metrics) | 指标类型、Prometheus、Grafana、业务指标 |
| [链路追踪](./3_tracing) | Trace / Span、上下文传播、SkyWalking、Jaeger |
| [告警体系](./4_alerting) | 告警规则、告警分级、降噪、值班响应 |
| [OpenTelemetry](./5_opentelemetry) | 统一采集标准、SDK、Collector、生态集成 |

## 学习主线

```
日志：发生了什么
指标：系统是否健康
追踪：请求经过了哪里
告警：什么时候需要介入
排障：如何从信号定位根因
```

## 与其他模块的关系

- JVM 监控工具 → [jvm/7_monitoring_tools](../jvm/7_monitoring_tools)
- JVM 故障排查 → [jvm/8_troubleshooting](../jvm/8_troubleshooting)
- 微服务链路追踪 → [microservices/7_tracing](../microservices/7_tracing)
- 架构日志设计 → [architecture/12_logging_system](../architecture/12_logging_system)

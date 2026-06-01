# OpenTelemetry

> [!warning] 待补充

## 学习目标

- 理解 OpenTelemetry 在可观测性体系中的定位
- 掌握统一采集日志、指标、链路追踪的基本思路
- 了解 SDK、Collector、Exporter 的职责

## 大纲

- 核心组件：API、SDK、Collector、Exporter
- 三类信号：Logs、Metrics、Traces
- 采集方式：自动埋点、手动埋点、Agent
- 数据流向：应用 → Collector → 后端存储 / 分析平台
- 落地关注：性能开销、采样策略、字段规范

## 后续补充

- Java Agent 接入示例
- Collector Pipeline 配置
- 与 Prometheus、Jaeger、Grafana 的集成

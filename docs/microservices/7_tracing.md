# 链路追踪

> 链路追踪的完整内容（原理、SkyWalking/Zipkin 接入、OpenTelemetry 配置）见 → [可观测性 - 链路追踪](../observability/)

---

## 一、为什么需要链路追踪

微服务架构中，一次用户请求可能经过 10+ 个服务。当出现慢查询或异常时，需要链路追踪来：

- 还原完整调用链路（哪个服务先调、调了谁）
- 定位耗时瓶颈（哪个服务最慢）
- 快速找到异常节点（哪个服务报错）

---

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Trace** | 一次完整请求的全链路记录，由多个 Span 组成 |
| **Span** | 链路中每一个服务调用单元，记录开始时间、耗时、状态 |
| **TraceId** | 全局唯一 ID，在所有服务间透传，将分散的 Span 串联成一条 Trace |
| **SpanId** | 当前节点的唯一 ID |
| **Parent SpanId** | 父节点 SpanId，构成调用树形结构 |

```
用户请求 [TraceId=abc123]
  ├── Gateway [SpanId=1]           10ms
  ├── order-service [SpanId=2]    150ms
  │     ├── MySQL 查询 [SpanId=3]  80ms
  │     └── user-service [SpanId=4] 30ms
  └── payment-service [SpanId=5]  200ms ← 瓶颈
```

---

## 三、主流方案

| 组件 | 特点 |
|------|------|
| **SkyWalking** | 国产顶流，APM + 链路追踪，Java Agent 无侵入接入 |
| **Zipkin** | 轻量级，Spring Cloud Sleuth 原生集成（Sleuth 已停止维护）|
| **Jaeger** | Uber 出品，CNCF 项目，Kubernetes 友好 |
| **OpenTelemetry** | 厂商中立的可观测性标准，统一 Tracing + Metrics + Logs，未来趋势 |

> 详细接入配置和使用见 [可观测性](../observability/)。

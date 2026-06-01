# 链路追踪

> [!warning] 待补充

## 学习目标

- 理解分布式调用链的基本概念
- 掌握 Trace、Span、上下文传播的关系
- 能通过链路追踪定位慢调用和错误传播路径

## 大纲

- 核心概念：TraceId、SpanId、ParentSpanId
- 上下文传播：HTTP Header、RPC Metadata、MQ 消息头
- 常见工具：SkyWalking、Jaeger、Zipkin、OpenTelemetry
- 典型场景：网关到服务、服务到数据库、服务到 MQ
- 排查方向：慢接口、依赖超时、错误调用链

## 后续补充

- Spring Cloud 链路追踪接入
- 异步任务和 MQ 场景的链路透传
- 链路追踪与日志关联

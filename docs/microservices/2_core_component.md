# 核心组件

主要基于 [Spring Cloud Alibaba](https://sca.aliyun.com/) + 国际流行方案扩展。

---

## 一、各层组件速查

| 层次 | 职责 | 国内主流 | 国际主流 |
|------|------|---------|---------|
| **API 网关** | 路由、鉴权、限流、灰度 | Spring Cloud Gateway、APISIX | Kong、Traefik |
| **服务注册发现** | 动态地址管理、健康检查 | Nacos | Consul、etcd |
| **配置中心** | 集中配置、动态刷新 | Nacos Config、Apollo | Spring Cloud Config、K8s ConfigMap |
| **服务通信** | 服务间调用 | OpenFeign、Dubbo | gRPC |
| **服务网格** | 非侵入式流量治理、mTLS | — | Istio + Envoy |
| **流量控制** | 限流、熔断、降级 | Sentinel | Resilience4j |
| **分布式事务** | 跨服务数据一致性 | Seata | Saga 模式、Outbox Pattern |
| **消息中间件** | 异步解耦、削峰填谷 | RocketMQ | Kafka、RabbitMQ |
| **链路追踪** | 全链路可观测 | SkyWalking | Jaeger、Zipkin、OpenTelemetry |
| **指标监控** | 指标采集与告警 | Prometheus + Grafana | Prometheus + Grafana |

---

## 二、Spring Cloud Alibaba 技术栈

```
客户端
    │
    ▼
Spring Cloud Gateway（API 网关：路由/鉴权/限流）
    │
    ▼
OpenFeign（声明式 HTTP 调用）+ Spring Cloud LoadBalancer（客户端负载均衡）
    │
    ├── order-service ──→ Nacos（注册中心 + 配置中心）
    ├── user-service  ──→ Sentinel（流量控制 + 熔断）
    └── pay-service   ──→ Seata（分布式事务）
                         RocketMQ（异步消息）
                         SkyWalking（链路追踪）
```

---

## 三、选型建议

**国内 Java 后端（推荐组合）**

```
注册 + 配置：Nacos
网关：Spring Cloud Gateway
服务调用：OpenFeign + Spring Cloud LoadBalancer
流控：Sentinel
事务：Seata（简单场景）/ Saga + RocketMQ 事务消息（复杂场景）
消息：RocketMQ（业务）/ Kafka（日志/大数据）
监控：SkyWalking + Prometheus + Grafana
```

**云原生 / 多语言混合**

```
注册：Consul / etcd（K8s 场景直接用 K8s Service）
网关：Kong / APISIX
服务调用：gRPC
流控：Istio + Envoy（Service Mesh，非侵入）
消息：Kafka
监控：OpenTelemetry + Jaeger + Prometheus
```

::: tip
- 国内偏「一站式集成」（Spring Cloud Alibaba）
- 国际偏「搭积木式」（gRPC + Consul + Envoy + Jaeger）
- IoT / 高并发场景重点关注：Sentinel 流控 + Kafka 消息 + SkyWalking 全链路监控
:::

---

## 四、各章节深度链接

| 方向 | 章节 |
|------|------|
| 服务注册与发现 | [服务注册与发现](./3_service_registry.md) |
| API 网关 | [API 网关](./4_api_gateway.md) |
| 服务间通信 | [服务间通信](./5_communication.md) |
| 配置中心 | [配置中心](./6_config_center.md) |
| 链路追踪 | [链路追踪](./7_tracing.md) |
| 微服务设计模式 | [微服务设计模式](./8_patterns.md) |
| 服务网格 | [服务网格](./9_service_mesh.md) |
| 服务治理 | [服务治理](./10_service_governance.md) |
| 熔断限流 | [高可用](../high-avail/) |
| 分布式事务 | [分布式事务](../distributed/3_transaction.md) |
| 消息中间件 | [消息队列](../messaging/0_mq.md) |

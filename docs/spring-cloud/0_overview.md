# Spring Cloud 总览

本模块讲 Spring Cloud 微服务工具集的框架落地：注册发现、网关、通信、配置、治理，再到 Spring Cloud Alibaba 与 Spring Cloud Stream。

**版本基线（2026 年 10 月）**：Spring Cloud 2025.1、Spring Cloud Alibaba 2025.1.0.0、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. [注册发现](./1_service_registry)：注册中心选型、Nacos 2.x+ 的 gRPC 连接与临时 / 持久实例、Spring Cloud 接入
2. [API 网关](./2_api_gateway)：Gateway Server WebFlux 与 Server MVC、路由与过滤链、网关统一鉴权、限流与灰度
3. [服务通信](./3_communication)：HTTP Service Clients 与 OpenFeign、gRPC、Dubbo 3 的选型与接入
4. [配置中心](./4_config_center)：`spring.config.import` 接入 Nacos Config、gRPC 推送刷新链路、`@RefreshScope` 与属性重绑定
5. [服务治理](./5_service_governance)：Spring Cloud LoadBalancer、灰度路由与标记透传、Resilience4j 与 Framework 7 内置容错
6. [Spring Cloud Alibaba](./6_alibaba)：版本对齐、Sentinel 规则与持久化、Seata AT 模式
7. [Spring Cloud Stream](./7_stream)：Binder 抽象、函数式模型、消费组与分区、重试与死信

[高频面试题](./99_interview) 只列题目，答案在 [Spring Cloud 面试题解答](/interview/11_spring_cloud)。

---

## 三、版本与选型速查

**版本对应**（三者强绑定，按官方版本说明对表选择）：

| Spring Boot | Spring Cloud | Spring Cloud Alibaba | 说明 |
|------|------|------|------|
| 4.0.x | 2025.1.x（Oakwood） | 2025.1.0.0（Nacos 3.1.1、Sentinel 1.8.9、Seata 2.5.0） | 本站基线，取消 bootstrap，统一 `spring.config.import` |
| 4.1.x | 2025.1.2 及以上 | 以 SCA 发布说明为准 | Spring Cloud 2025.1.2 起支持 Boot 4.1 |
| 3.5.x | 2025.0.x（Northfields） | 2025.0.0.0（Nacos 3.0.3） | 存量项目，开源支持已于 2026-06 结束 |

**Netflix 组件替代关系**（老项目升级时对照）：

| 原组件 | 现状 | 替代方案 |
|------|------|---------|
| Ribbon | 2020.0 起移除 | Spring Cloud LoadBalancer |
| Hystrix | 2020.0 起移除 | Resilience4j（Spring Cloud CircuitBreaker）/ Sentinel |
| Zuul 1 | 2020.0 起移除 | Spring Cloud Gateway |
| Archaius | 2020.0 起移除 | Spring Cloud Config / Nacos Config |
| Eureka | 仍随 Spring Cloud Netflix 发布，仅维护 | Nacos / Consul / Kubernetes Service |
| Sleuth | 2022.0 起不再发布 | Micrometer Tracing + OpenTelemetry |
| OpenFeign | 2022.0 起功能冻结，只修缺陷 | Spring HTTP Service Clients（`@HttpExchange`） |

**选型组合**：

| 能力 | 国内 Java 后端常用组合 | 云原生 / 多语言 |
|------|----------------------|----------------|
| 注册 + 配置 | Nacos | Kubernetes Service + ConfigMap / Secret，或 Consul |
| 网关 | Spring Cloud Gateway、APISIX、Higress | Envoy Gateway（K8s Gateway API）、Kong |
| 服务调用 | HTTP Service Clients / OpenFeign + LoadBalancer，Dubbo 3 | gRPC |
| 流控熔断 | Sentinel、Resilience4j | Istio / Envoy（服务网格，非侵入） |
| 分布式事务 | Seata（AT / TCC / Saga 最终一致，XA 强一致）/ 事务消息 + 本地消息表 | Saga、Outbox |
| 消息 | RocketMQ（业务）、Kafka（日志与事件流） | Kafka |
| 可观测 | Micrometer Tracing + SkyWalking / Prometheus | OpenTelemetry + Jaeger / Tempo + Prometheus |

国内偏「一站式集成」（Spring Cloud Alibaba），云原生偏「平台下沉」：注册发现、流量治理交给 Kubernetes 与服务网格，应用只保留业务调用。

![Spring Cloud Alibaba 技术栈](../assets/spring-cloud/sca-stack.svg)

---

## 四、关联模块

Spring Cloud 在 Spring Boot 之上提供统一抽象，具体实现可以换成 Nacos、Consul、Kubernetes 等。限流熔断的策略与阈值、分布式事务理论、服务网格分别在高可用、分布式、微服务模块展开，本模块只写框架落地。版本说明：Spring Cloud 2025.1.x（Oakwood）基于 Spring Framework 7，2025.1.2 起支持 Boot 4.1；Boot 3.5 对应 Spring Cloud 2025.0（Northfields）与 SCA 2025.0.0.0，文中涉及差异处单独标出。

- [微服务设计模式](/microservices/2_patterns)：网关、BFF、Sidecar 等微服务模式
- [微服务 · 服务网格](/microservices/3_service_mesh)：Istio / Envoy 与 Spring Cloud 的分工
- [微服务 · Dubbo](/microservices/4_dubbo)：RPC 框架方案
- [高可用总览](/high-avail/0_overview)：负载均衡、熔断降级、限流、优雅上下线的原理与阈值
- [分布式 · 分布式事务](/distributed/4_transaction)：2PC、TCC、Saga、本地消息表的完整对比
- [消息队列总览](/messaging/0_overview)：Kafka / RocketMQ / RabbitMQ 本体
- [可观测性 · 链路追踪](/observability/3_tracing)：Micrometer Tracing 与 OpenTelemetry
- [Spring Boot · 版本演进](/spring-boot/11_versions)：Boot 4 / Framework 7 的升级要点
- [Spring Cloud 面试题解答](/interview/11_spring_cloud)：本模块高频问题的答案汇总

## 参考资料

- Spring Cloud：[https://spring.io/projects/spring-cloud](https://spring.io/projects/spring-cloud)
- Spring Cloud 2025.1（Oakwood）发布说明：[https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released)
- Spring Cloud Alibaba 版本说明：[https://sca.aliyun.com/docs/2025.x/overview/version-explain/](https://sca.aliyun.com/docs/2025.x/overview/version-explain/)

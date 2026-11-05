# 微服务治理总览

微服务治理解决服务拆开之后的注册发现、网关、调用、配置、流量与消息驱动问题。本模块以 Spring Cloud 为主线，按一次请求经过的顺序讲这些能力怎么落地，并包含国内常用的 Spring Cloud Alibaba 与屏蔽具体 MQ 的 Spring Cloud Stream。

**版本基线（2026 年 10 月）**：Spring Boot 4、Spring Cloud 2025.1、Spring Cloud Alibaba 2025.1

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

先读 [微服务架构总览](/microservices/0_overview) 的「概念与拆分」，想清楚要不要拆、怎么拆，再看这些能力在 Spring Cloud 里怎么落地。

1. [注册发现](./1_service_registry)：注册中心选型、Nacos 2.x+ 的 gRPC 连接与临时 / 持久实例、Spring Cloud 接入
2. [API 网关](./2_api_gateway)：Gateway Server WebFlux 与 Server MVC、路由与过滤链、网关统一鉴权、限流与灰度
3. [服务通信](./3_communication)：HTTP Service Clients 与 OpenFeign、gRPC、Dubbo 3 的选型与接入
4. [配置中心](./4_config_center)：`spring.config.import` 接入 Nacos Config、gRPC 推送刷新链路、`@RefreshScope` 与属性重绑定
5. [流量治理](./5_traffic_governance)：Spring Cloud LoadBalancer、灰度路由与标记透传、Resilience4j 与 Framework 7 内置容错
6. [Spring Cloud Alibaba](./6_alibaba)：版本对齐、Sentinel 规则与持久化、Seata AT 模式
7. [Spring Cloud Stream](./7_stream)：Binder 抽象、函数式模型、消费组与分区、重试与死信

[高频面试题](./99_interview) 只列题目，答案在 [微服务治理面试题解答](/interview/18_service_governance)。不用 Spring Cloud 时的 Dubbo 与服务网格两条路线见 [微服务架构总览](/microservices/0_overview)。

---

## 三、Spring Cloud 版本与选型速查

**版本对应**：Spring Boot、Spring Cloud、Spring Cloud Alibaba 三者强绑定，本站基线为 Boot 4.0.x + Spring Cloud 2025.1 + SCA 2025.1.0.0，完整对表见 [Spring Cloud Alibaba · 定位与版本对齐](./6_alibaba#一、定位与版本对齐)。

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

![Spring Cloud Alibaba 技术栈](../assets/service-governance/sca-stack.svg)

---

## 四、关联模块

本模块只写框架落地；要不要拆、怎么拆、用哪些模式在微服务架构模块，限流熔断的策略与阈值、分布式事务理论分别在高可用、分布式基础模块展开。

- [微服务架构总览](/microservices/0_overview)：拆分原则、设计模式，以及 Dubbo、服务网格两条其他路线
- [分布式基础 · 分布式事务](/distributed/4_transaction)：2PC、TCC、Saga、本地消息表、Seata 的完整对比
- [高可用总览](/high-avail/0_overview)：负载均衡、熔断降级、限流、优雅上下线的原理与阈值
- [消息队列总览](/messaging/0_overview)：Kafka / RocketMQ / RabbitMQ 本体
- [可观测性 · 链路追踪](/observability/3_tracing)：Micrometer Tracing 与 OpenTelemetry
- [Spring Boot · 版本演进](/spring-boot/14_versions)：Boot 4 / Framework 7 的升级要点
- [项目演进 · 拆分服务](/project/6_split)：一个订单服务从单体拆出库存与支付服务的完整过程

## 参考资料

- Spring Cloud：[https://spring.io/projects/spring-cloud](https://spring.io/projects/spring-cloud)
- Spring Cloud 2025.1（Oakwood）发布说明：[https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released)
- Spring Cloud Alibaba 版本说明：[https://sca.aliyun.com/docs/2025.x/overview/version-explain/](https://sca.aliyun.com/docs/2025.x/overview/version-explain/)

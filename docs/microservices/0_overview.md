# 微服务总览

微服务是把单一应用拆成一组围绕业务能力构建、可独立部署、通过轻量级协议通信的小服务的架构风格。本模块先讲与框架无关的架构问题（收益与代价、怎么拆、常用模式），再讲 Spring Cloud 的落地，最后是 Dubbo 与服务网格两条其他路线。

**版本基线（2026 年 10 月）**：Spring Boot 4、Spring Cloud 2025.1、Spring Cloud Alibaba 2025.1.0.0、Istio 1.30 / 1.31、Dubbo 3.3

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

**概念与拆分**：先想清楚要不要拆、怎么拆

1. [微服务优势与挑战](./1_pros_and_cons)：微服务的定义与原则、与 SOA 的区别、优势与代价、何时拆分，以及绞杀者模式等单体迁移策略
2. [服务拆分](./2_service_split)：拆分依据与康威定律、粒度判断、共享表与数据迁移、绞杀者式抽取步骤、拆后治理与电商示例
3. [微服务设计模式](./3_patterns)：拆分、通信、数据、可靠性、可观测与部署六类模式的目录，每个模式给出适用场景与主文档链接
4. [接口调用顺序性](./4_call_ordering)：同步调用为什么会乱序、怎样消除顺序依赖，以及按业务键路由、实例内串行与版本号兜底

**Spring Cloud**：上面这些能力在 Java 里怎么落地

5. [注册发现](./10_service_registry)：注册中心选型、Nacos 2.x+ 的 gRPC 连接与临时 / 持久实例、Spring Cloud 接入
6. [API 网关](./11_api_gateway)：Gateway Server WebFlux 与 Server MVC、路由与过滤链、网关统一鉴权、限流与灰度
7. [服务通信](./12_communication)：HTTP Service Clients 与 OpenFeign、gRPC、Dubbo 3 的选型与接入
8. [配置中心](./13_config_center)：`spring.config.import` 接入 Nacos Config、gRPC 推送刷新链路、`@RefreshScope` 与属性重绑定
9. [服务治理](./14_service_governance)：Spring Cloud LoadBalancer、灰度路由与标记透传、Resilience4j 与 Framework 7 内置容错
10. [Spring Cloud Alibaba](./15_alibaba)：版本对齐、Sentinel 规则与持久化、Seata AT 模式
11. [Spring Cloud Stream](./16_stream)：Binder 抽象、函数式模型、消费组与分区、重试与死信

**其他路线**：不用 Spring Cloud 时的选择

12. [Dubbo](./20_dubbo)：RPC 服务框架的调用流程、Triple 协议、负载均衡与集群容错、SPI 扩展机制，以及与 Spring Cloud 的选型
13. [服务网格](./21_service_mesh)：Istio 的控制面与数据面、流量管理、mTLS、Sidecar 与 Ambient 两种数据面，以及与 Spring Cloud 的取舍

[高频面试题](./99_interview) 只列题目，答案在 [微服务面试题解答](/interview/11_microservices) 与 [Spring Cloud 面试题解答](/interview/11_spring_cloud)。

---

## 三、Spring Cloud 版本与选型速查

**版本对应**：Spring Boot、Spring Cloud、Spring Cloud Alibaba 三者强绑定，本站基线为 Boot 4.0.x + Spring Cloud 2025.1 + SCA 2025.1.0.0，完整对表见 [Spring Cloud Alibaba · 定位与版本对齐](./15_alibaba#一、定位与版本对齐)。

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

![Spring Cloud Alibaba 技术栈](../assets/microservices/sca-stack.svg)

版本注意：Istio 1.29 已于 2026-10-12 停止支持，Ambient 模式已 GA；Dubbo 3.3 基于 Spring Boot 3.5，Boot 4 适配以官方发布为准。

---

## 四、关联模块

限流熔断的策略与阈值、分布式事务理论分别在高可用、分布式模块展开，本模块只写架构取舍与框架落地。

- [系统架构 · DDD 领域驱动设计](/architecture/2_ddd)：用限界上下文划定服务边界
- [系统架构 · 架构模式与风格](/architecture/1_arch_patterns)：CQRS、Event Sourcing、六边形架构
- [分布式 · 分布式事务](/distributed/4_transaction)：2PC、TCC、Saga、本地消息表、Seata 的完整对比
- [高可用总览](/high-avail/0_overview)：负载均衡、熔断降级、限流、优雅上下线的原理与阈值
- [消息队列总览](/messaging/0_overview)：Kafka / RocketMQ / RabbitMQ 本体
- [可观测性 · 链路追踪](/observability/3_tracing)：Micrometer Tracing 与 OpenTelemetry
- [Spring Boot · 版本演进](/spring-boot/14_versions)：Boot 4 / Framework 7 的升级要点
- [云原生 · Kubernetes](/cloud-native/6_kubernetes)：微服务与服务网格的运行底座
- [RPC 协议](/protocols/5_rpc_protocols)：gRPC 帧格式、Protobuf 编码、Thrift、SOAP 等协议的横向对比
- [项目演进 · 拆分服务](/project/6_split)：一个订单服务从单体拆出库存与支付服务的完整过程

## 参考资料

- Microservices（James Lewis & Martin Fowler）：[https://martinfowler.com/articles/microservices.html](https://martinfowler.com/articles/microservices.html)
- Microservice Architecture（Chris Richardson）：[https://microservices.io/](https://microservices.io/)
- Spring Cloud：[https://spring.io/projects/spring-cloud](https://spring.io/projects/spring-cloud)
- Spring Cloud 2025.1（Oakwood）发布说明：[https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released)
- Spring Cloud Alibaba 版本说明：[https://sca.aliyun.com/docs/2025.x/overview/version-explain/](https://sca.aliyun.com/docs/2025.x/overview/version-explain/)

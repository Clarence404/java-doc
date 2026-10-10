# 微服务总览

本模块讲与框架无关的微服务架构问题：收益与代价、何时及如何从单体迁移、常用设计模式，以及 Dubbo / Spring Cloud 与服务网格两条治理路线。

**版本基线（2026 年 10 月）**：Spring Boot 4.x、Spring Cloud 2025.1、Istio 1.24、Dubbo 3.3

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. [微服务优势与挑战](./1_pros_and_cons)：微服务的定义与原则、与 SOA 的区别、优势与代价、何时拆分，以及绞杀者模式等单体迁移策略
2. [微服务设计模式](./2_patterns)：拆分、通信、数据、可靠性、可观测与部署六类模式的目录，每个模式给出适用场景与主文档链接
3. [服务网格](./3_service_mesh)：Istio 的控制面与数据面、流量管理、mTLS、Sidecar 与 Ambient 两种数据面，以及与 Spring Cloud 的取舍
4. [Dubbo](./4_dubbo)：RPC 服务框架的调用流程、Triple 协议、负载均衡与集群容错、SPI 扩展机制，以及与 Spring Cloud 的选型

[高频面试题](./99_interview) 只列题目，答案在 [微服务面试题解答](/interview/11_microservices)。

---

## 三、关联模块

微服务是把单一应用拆成一组围绕业务能力构建、可独立部署、通过轻量级协议通信的小服务的架构风格（James Lewis 与 Martin Fowler 2014 年系统阐述）。Spring Cloud 各组件的具体用法在 [Spring Cloud](/spring-cloud/0_overview) 模块展开。版本注意：Istio Ambient 模式已 GA；Dubbo 3.3 基于 Spring Boot 3.5，Boot 4 适配以官方发布为准。

- [Spring Cloud 总览](/spring-cloud/0_overview)：注册发现、网关、服务通信、配置中心、服务治理的 Spring 实现
- [Spring Cloud · 服务通信](/spring-cloud/3_communication)：HTTP Service Clients、OpenFeign、gRPC 与异步消息
- [Spring Cloud Alibaba](/spring-cloud/6_alibaba)：Nacos、Sentinel、Seata 与版本对齐
- [系统架构 · DDD 领域驱动设计](/architecture/3_ddd)：用限界上下文划定服务边界
- [系统架构 · 架构模式与风格](/architecture/2_arch_patterns)：CQRS、Event Sourcing、六边形架构
- [分布式 · 分布式事务](/distributed/4_transaction)：TCC、Saga、本地消息表、Seata
- [高可用 · 熔断](/high-avail/5_circuit_breaking)：熔断器状态机与系统级容错策略
- [可观测性 · 链路追踪](/observability/3_tracing)：跨服务调用链的追踪与排障
- [云原生 · Kubernetes](/cloud-native/6_kubernetes)：微服务与服务网格的运行底座
- [RPC 协议](/protocols/5_rpc_protocols)：gRPC 帧格式、Protobuf 编码、Thrift、SOAP 等协议的横向对比
- [微服务面试题解答](/interview/11_microservices)：本模块高频问题的答案汇总

## 参考资料

- Microservices（James Lewis & Martin Fowler）：[https://martinfowler.com/articles/microservices.html](https://martinfowler.com/articles/microservices.html)
- Microservice Architecture（Chris Richardson）：[https://microservices.io/](https://microservices.io/)

# 微服务架构总览

微服务是把单一应用拆成一组围绕业务能力构建、可独立部署、通过轻量级协议通信的小服务的架构风格。本模块讲与框架无关的架构问题（收益与代价、怎么拆、常用模式），以及 Dubbo 与服务网格两条落地路线；以 Spring Cloud 为主线的落地见微服务治理模块。

**版本基线（2026 年 10 月）**：Istio 1.30 / 1.31、Dubbo 3.3

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

**微服务治理**：上面这些能力在 Java 里怎么落地，见 [微服务治理总览](/service-governance/0_overview)（以 Spring Cloud 为主线：注册发现、网关、服务通信、配置中心、流量治理、Alibaba、Stream）

**其他路线**：不用 Spring Cloud 时的选择

5. [Dubbo](./5_dubbo)：RPC 服务框架的调用流程、Triple 协议、负载均衡与集群容错、SPI 扩展机制，以及与 Spring Cloud 的选型
6. [服务网格](./6_service_mesh)：Istio 的控制面与数据面、流量管理、mTLS、Sidecar 与 Ambient 两种数据面，以及与 Spring Cloud 的取舍

[高频面试题](./99_interview) 只列题目，答案在 [微服务架构面试题解答](/interview/17_microservices)。

---

## 三、版本注意

Istio 1.29 已于 2026-10-12 停止支持，Ambient 模式已 GA；Dubbo 3.3 基于 Spring Boot 3.5，Boot 4 适配以官方发布为准。

---

## 四、关联模块

限流熔断的策略与阈值、分布式事务理论分别在高可用、分布式基础模块展开，本模块只写架构取舍与 Dubbo、服务网格两条路线。

- [微服务治理总览](/service-governance/0_overview)：注册发现、网关、服务通信、配置、流量治理在 Spring Cloud 中的落地与版本选型
- [系统架构 · DDD 领域驱动设计](/architecture/2_ddd)：用限界上下文划定服务边界
- [系统架构 · 架构模式与风格](/architecture/1_arch_patterns)：CQRS、Event Sourcing、六边形架构
- [分布式基础 · 分布式事务](/distributed/4_transaction)：2PC、TCC、Saga、本地消息表、Seata 的完整对比
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
- Apache Dubbo：[https://dubbo.apache.org/](https://dubbo.apache.org/)
- Istio：[https://istio.io/latest/docs/](https://istio.io/latest/docs/)

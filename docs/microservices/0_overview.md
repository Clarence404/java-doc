# 微服务架构总览

微服务是把单一应用拆成一组围绕业务能力构建、可独立部署、通过轻量级协议通信的小服务的架构风格。本模块只讲与框架无关的架构问题：收益与代价、怎么拆、常用模式、调用顺序与服务间通信契约，Spring Cloud、Dubbo、服务网格三条落地路线见微服务治理模块。

**版本基线（2026 年 10 月）**：Spring Boot 4、Spring Cloud 2025.1

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

先想清楚要不要拆、怎么拆，再看拆开之后服务之间怎么协作：

1. [微服务优势与挑战](./1_pros_and_cons)：微服务的定义与原则、与 SOA 的区别、单体瓶颈、优势与代价
2. [服务拆分](./2_service_split)：何时拆、拆分依据与康威定律、粒度判断、共享表与数据迁移、绞杀者式抽取步骤、拆后治理与电商示例
3. [微服务设计模式](./3_patterns)：拆分、通信、数据、可靠性、可观测与部署六类模式的目录，每个模式给出适用场景与主文档链接
4. [接口调用顺序性](./4_call_ordering)：同步调用为什么会乱序、怎样消除顺序依赖，以及按业务键路由、实例内串行与版本号兜底
5. [服务间通信与契约](./5_communication)：同步还是异步、事件驱动的三种用法、接口契约、版本与兼容、跨服务查询

这些能力在 Java 里怎么落地（注册发现、网关、服务通信、配置中心、流量治理，以及 Dubbo 与服务网格两条其他路线），见 [微服务治理总览](/service-governance/0_overview)。

[高频面试题](./99_interview) 只列题目，答案在 [微服务架构面试题解答](/interview/17_microservices)。

---

## 三、关联模块

限流熔断的策略与阈值、分布式事务理论分别在高可用、分布式基础模块展开，框架与基础设施落地在微服务治理模块，本模块只写架构取舍。

- [微服务治理总览](/service-governance/0_overview)：Spring Cloud 主线（注册发现、网关、服务通信、配置、流量治理）与 Dubbo、服务网格两条其他路线
- [系统架构 · DDD 领域驱动设计](/architecture/2_ddd)：用限界上下文划定服务边界
- [系统架构 · 架构模式与风格](/architecture/1_arch_patterns)：CQRS、Event Sourcing、六边形架构
- [分布式基础 · 分布式事务](/distributed/4_transaction)：2PC、TCC、Saga、本地消息表、Seata 的完整对比
- [高可用总览](/high-avail/0_overview)：负载均衡、熔断降级、限流、优雅上下线的原理与阈值
- [消息队列总览](/messaging/0_overview)：Kafka / RocketMQ / RabbitMQ 本体
- [可观测性 · 链路追踪](/observability/3_tracing)：Micrometer Tracing 与 OpenTelemetry
- [Spring Boot · 版本演进](/spring-boot/14_versions)：Boot 4 / Framework 7 的升级要点
- [云原生 · Kubernetes](/cloud-native/6_kubernetes)：微服务的运行底座
- [RPC 协议](/protocols/5_rpc_protocols)：gRPC 帧格式、Protobuf 编码、Thrift、SOAP 等协议的横向对比
- [项目演进 · 拆分服务](/project/6_split)：一个订单服务从单体拆出库存与支付服务的完整过程

## 参考资料

- Microservices（James Lewis & Martin Fowler）：[https://martinfowler.com/articles/microservices.html](https://martinfowler.com/articles/microservices.html)
- Microservice Architecture（Chris Richardson）：[https://microservices.io/](https://microservices.io/)
- What do you mean by “Event-Driven”?（Martin Fowler）：[https://martinfowler.com/articles/201701-event-driven.html](https://martinfowler.com/articles/201701-event-driven.html)

---
description: 拆分与演进、通信与 RPC、服务网格与 Dubbo、微服务模式、分布式场景题目清单
---

# 面试高频题

> 汇总微服务架构层面的高频面试问题，完整解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - 微服务与 Spring Cloud</RouteLink> 的前五组。
>
> 注册中心、网关、OpenFeign、配置中心、Sentinel、Seata 等组件问题见 <RouteLink to="/spring-cloud/99_interview">Spring Cloud 面试题</RouteLink>；熔断、降级、限流的系统级策略见 <RouteLink to="/high-avail/99_interview">高可用面试题</RouteLink>。

## 一、拆分与演进

- **微服务和单体架构各有什么优缺点？什么时候该拆分？**
- **微服务和 SOA 的区别是什么？**
- **微服务拆分的原则是什么？如何避免过度拆分和「分布式单体」？**
- **如何把单体迁移到微服务？绞杀者模式怎么做？**  
  → 详见 <RouteLink to="/microservices/1_pros_and_cons">微服务优势与挑战</RouteLink>、<RouteLink to="/microservices/2_patterns">微服务设计模式</RouteLink>

## 二、通信与 RPC

- **客户端服务发现与服务端服务发现有什么区别？**
- **服务间同步调用与异步消息怎么选？**
- **gRPC、Dubbo 与 HTTP（REST）分别适合什么场景？**  
  → 详见 <RouteLink to="/microservices/2_patterns">微服务设计模式</RouteLink>、<RouteLink to="/spring-cloud/3_communication">服务通信</RouteLink>

## 三、服务网格与 Dubbo

- **什么是服务网格？istiod 负责什么，控制面与数据面如何分工？**
- **Istio 的 Sidecar 模式与 Ambient 模式有什么区别？ztunnel 与 waypoint 各做什么？**
- **为什么 VirtualService 的路由规则顺序很重要？**
- **Istio 如何实现 mTLS？SPIFFE 身份是什么？网格下的链路追踪是零侵入的吗？**
- **服务网格与 Spring Cloud 如何选？组合使用时要注意什么？**
- **Dubbo 的注册中心宕机为什么不影响已建立的调用？什么是应用级服务发现？**
- **Triple 协议与 dubbo 协议有什么区别？**
- **Dubbo 默认的 failover 为什么对写操作是陷阱？**
- **Dubbo SPI 与 Java SPI 有什么区别？`@Adaptive`、`@Activate` 做什么？**
- **Dubbo 和 Spring Cloud 怎么选？**  
  → 详见 <RouteLink to="/microservices/3_service_mesh">服务网格</RouteLink>、<RouteLink to="/microservices/4_dubbo">Dubbo</RouteLink>

## 四、微服务模式

- **BFF 是什么？和 API 网关有什么区别？**
- **Database per Service 之后如何做跨服务查询？API Composition 还是 CQRS？**
- **Outbox 模式如何保证「写库 + 发消息」的原子性？**
- **Saga 的编排式与协同式有什么区别？**
- **消费者驱动契约测试解决什么问题？**  
  → 详见 <RouteLink to="/microservices/2_patterns">微服务设计模式</RouteLink>、<RouteLink to="/distributed/4_transaction">分布式事务</RouteLink>

## 五、分布式场景

- **微服务之间的分布式事务如何处理？**
- **微服务接口如何实现幂等？**
- **服务间如何传递认证信息与上下文（用户身份、灰度标记、traceId）？**  
  → 详见 <RouteLink to="/distributed/4_transaction">分布式事务</RouteLink>、<RouteLink to="/architecture/5_idempotence">幂等方案总结</RouteLink>、<RouteLink to="/spring-cloud/2_api_gateway">API 网关</RouteLink>、<RouteLink to="/spring-cloud/5_service_governance">服务治理</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - 微服务与 Spring Cloud</RouteLink>
:::

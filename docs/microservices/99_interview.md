# 微服务面试高频题

> 汇总微服务架构核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/5_spring_cloud">开发总结-微服务</RouteLink>

## 一、微服务基础

- **微服务和单体架构各有什么优缺点？什么时候该拆分？**
- **微服务拆分的原则是什么？如何避免过度拆分？**
- **微服务和 SOA 的区别是什么？**

## 二、注册中心与配置

- **Nacos、Eureka、Consul、Zookeeper 作为注册中心有什么区别？**
- **Nacos 注册中心的工作原理？健康检查机制是什么？**
- **Nacos 和 Apollo 作为配置中心有什么区别？如何实现配置热更新？**
- **Nacos 为什么支持 AP/CP 切换？**

## 三、服务调用与负载均衡

- **OpenFeign 的工作原理？**
- **Ribbon 和 Spring Cloud LoadBalancer 的区别？**
- **常见负载均衡策略有哪些？（轮询、加权、最少连接、一致性哈希）**
- **gRPC 和 OpenFeign 适合什么场景？**  
  → 详见 <RouteLink to="/microservices/5_communication">服务调用</RouteLink>

## 四、网关

- **Spring Cloud Gateway 的工作原理？Route、Predicate、Filter 是什么？**
- **网关有哪些核心功能？（路由、鉴权、限流、熔断、灰度）**
- **如何在网关层实现 JWT 鉴权？**

## 五、服务治理

- **服务熔断和服务降级的区别？Sentinel 的核心功能有哪些？**
- **如何处理服务雪崩问题？**
- **链路追踪的原理？TraceId 和 SpanId 是什么？SkyWalking 如何无侵入？**

## 六、分布式场景

- **微服务之间的分布式事务如何处理？**  
  → 详见 <RouteLink to="/distributed/3_transaction">分布式事务</RouteLink>
- **微服务如何实现幂等性？**
- **服务间如何传递认证信息（Token 透传）？**

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/5_spring_cloud">开发总结-微服务</RouteLink>
:::

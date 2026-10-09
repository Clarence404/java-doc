---
description: 注册与配置、调用与网关、服务治理、分布式事务、消息与链路题目清单
---

# 面试高频题

> 汇总 Spring Cloud 组件的高频面试问题，完整解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - 微服务与 Spring Cloud</RouteLink> 的后五组。
>
> 拆分、服务网格、Dubbo 等架构层问题见 <RouteLink to="/microservices/99_interview">微服务面试题</RouteLink>；熔断、降级、限流的策略与阈值见 <RouteLink to="/high-avail/99_interview">高可用面试题</RouteLink>。

## 一、注册与配置

- **Spring Boot、Spring Cloud、Spring Cloud Alibaba 的版本如何对应？**
- **注册中心如何选型？Nacos、Eureka、Consul、ZooKeeper、Kubernetes 有什么区别？**
- **注册中心为什么更适合 AP？ZooKeeper 做注册中心有什么问题？**
- **Nacos 的临时实例和持久实例有什么区别？AP / CP 是由什么决定的？**
- **Nacos 2.x 与 1.x 的健康检查有何不同？需要放通哪些端口？**
- **Nacos 的保护阈值是什么？Nacos Server 全挂了服务还能调用吗？**
- **Spring Cloud Alibaba 2025.1 为什么不再支持 bootstrap？如何用 `spring.config.import` 接入 Nacos？**
- **配置中心动态刷新的原理是什么？Nacos 1.x 长轮询与 2.x 推送有什么区别？**
- **`@RefreshScope` 的原理是什么？`@Value` 与 `@ConfigurationProperties` 的刷新有什么区别？**  
  → 详见 <RouteLink to="/spring-cloud/0_overview">Spring Cloud 总览</RouteLink>、<RouteLink to="/spring-cloud/1_service_registry">注册发现</RouteLink>、<RouteLink to="/spring-cloud/4_config_center">配置中心</RouteLink>

## 二、调用与网关

- **OpenFeign 还推荐用吗？HTTP Service Clients 如何接入负载均衡？**
- **OpenFeign 的工作原理是什么？为什么配置了 fallback 却不生效？**
- **Spring Cloud LoadBalancer 有哪些内置能力？如何基于它实现灰度路由？**
- **API 网关的作用是什么？Route、Predicate、Filter 分别是什么，请求如何流转？**
- **Gateway Server WebFlux 与 Server MVC 如何选？2025.x 的依赖与配置前缀有何变化？**
- **网关统一鉴权怎么做？如何防止下游收到伪造的用户请求头？**
- **网关灰度路由为什么不能用路由 metadata？正确做法是什么？**  
  → 详见 <RouteLink to="/spring-cloud/3_communication">服务通信</RouteLink>、<RouteLink to="/spring-cloud/2_api_gateway">API 网关</RouteLink>、<RouteLink to="/spring-cloud/5_service_governance">服务治理</RouteLink>

## 三、服务治理

- **Netflix 组件（Ribbon、Hystrix、Zuul、Sleuth）分别被什么替代？为什么被替换？**
- **什么是服务雪崩？Spring Cloud 中有哪些治理手段？**
- **Sentinel 的核心原理（Slot 链、滑动窗口）是什么？**
- **Sentinel 有哪些流控效果和熔断策略？规则如何持久化？**
- **Framework 7 的 `@Retryable` / `@ConcurrencyLimit` 与 Resilience4j、Sentinel 如何分工？**
- **如何按 API 版本把请求路由到不同实例？**  
  → 详见 <RouteLink to="/spring-cloud/5_service_governance">服务治理</RouteLink>、<RouteLink to="/spring-cloud/6_alibaba">Spring Cloud Alibaba</RouteLink>

## 四、分布式事务

- **Seata AT 模式的原理是什么？一阶段和二阶段分别做了什么？**
- **Seata AT 模式的读写隔离如何保证？什么情况下回滚会失败？**
- **Seata AT、TCC、Saga、XA 模式如何选择？**  
  → 详见 <RouteLink to="/spring-cloud/6_alibaba">Spring Cloud Alibaba</RouteLink>、<RouteLink to="/distributed/4_transaction">分布式事务</RouteLink>

## 五、消息与链路

- **Spring Cloud Stream 解决什么问题？`@StreamListener` 还能用吗？**
- **Spring Cloud Stream 如何配置消费组、重试与死信？**
- **Sleuth 之后用什么做链路追踪？traceId 如何跨服务、跨线程、跨 MQ 传递？**  
  → 详见 <RouteLink to="/spring-cloud/7_stream">Spring Cloud Stream</RouteLink>、<RouteLink to="/spring-boot/12_logging">日志</RouteLink>、<RouteLink to="/observability/3_tracing">链路追踪</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - 微服务与 Spring Cloud</RouteLink>
:::

---
description: Spring Cloud 方向题目清单
---

# 面试高频题

> 汇总 Spring Cloud 微服务组件的高频面试问题，完整解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - Spring Cloud</RouteLink>

## 一、整体选型

- **Spring Cloud 的核心组件有哪些？Netflix 组件为什么被替换？**
- **Spring Boot、Spring Cloud、Spring Cloud Alibaba 版本如何对应？**

## 二、注册与配置

- **注册中心如何选型？Eureka、Nacos、Consul、ZooKeeper 的区别？**
- **注册中心为什么更适合 AP？ZooKeeper 做注册中心有什么问题？**
- **Nacos 临时实例和持久实例的区别？Distro 和 Raft 分别用在哪里？**
- **Nacos 的保护阈值是什么？Nacos Server 全挂了服务还能调用吗？**
- **配置中心动态刷新的原理？长轮询是如何实现的？**
- **`@RefreshScope` 的原理是什么？`@Value` 和 `@ConfigurationProperties` 刷新有什么区别？**  
  → 详见 <RouteLink to="/spring-cloud/4_config_center">配置中心</RouteLink>

## 三、网关与调用

- **API 网关的作用是什么？Route、Predicate、Filter 分别是什么？**
- **Spring Cloud Gateway 的请求处理流程？为什么基于 WebFlux？**
- **OpenFeign 的工作原理？接口是如何变成 HTTP 请求的？**
- **Spring Cloud LoadBalancer 有哪些策略？如何基于它实现灰度发布？**  
  → 详见 <RouteLink to="/spring-cloud/3_communication">服务通信</RouteLink>

## 四、服务治理

- **Sentinel 的核心原理（Slot 链、滑动窗口）是什么？**
- **Sentinel 的流控效果和熔断策略有哪些？**
- **什么是服务雪崩？有哪些治理手段？**  
  → 详见 <RouteLink to="/spring-cloud/5_service_governance">服务治理</RouteLink>

## 五、分布式事务与链路追踪

- **Seata AT 模式的原理？一阶段和二阶段分别做了什么？**
- **Seata AT、TCC、Saga、XA 模式如何选择？**
- **链路追踪中 traceId 是如何跨服务、跨线程、跨 MQ 传递的？**
- **Spring Cloud Stream 解决什么问题？**  
  → 详见 <RouteLink to="/spring-cloud/6_alibaba">Spring Cloud Alibaba</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/11_spring_cloud">开发总结 - Spring Cloud</RouteLink>
:::

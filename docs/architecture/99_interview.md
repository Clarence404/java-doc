# 面试高频题

> 汇总系统架构核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/12_architecture">开发总结-系统架构</RouteLink>

## 一、架构演进

- **微服务和单体架构各有什么优缺点？什么时候该做微服务拆分？**
- **微服务拆分的原则是什么？过度拆分有哪些危害？**
- **单体 → 微服务的迁移策略有哪些？（绞杀者模式、抽取式拆分）**

## 二、DDD

- **DDD 的核心概念有哪些？（领域、限界上下文、聚合根、值对象、领域事件）**
- **聚合根的作用是什么？为什么不能直接操作聚合内的实体？**
- **限界上下文和微服务的关系是什么？**
- **领域事件如何驱动跨聚合的最终一致性？**  
  → 详见 <RouteLink to="/architecture/8_ddd_architecture">DDD 架构</RouteLink>

## 三、接口设计

- **什么是幂等性？哪些 HTTP 方法天然幂等？**
- **常见幂等实现方案有哪些？（唯一索引、Token、Redis SETNX、乐观锁）**
- **RESTful API 设计规范有哪些？**
- **如何设计一个 API 网关？核心功能有哪些？**

## 四、访问控制

- **RBAC 和 ABAC 的区别？各适合什么场景？**
- **RBAC 的五张核心表是什么？**
- **JWT 如何实现鉴权？Token 过期如何处理（无感刷新）？**  
  → 详见 <RouteLink to="/architecture/9_access_control_model">访问控制</RouteLink>

## 五、可观测性

- **日志、指标、链路追踪的区别？（Logging、Metrics、Tracing）**
- **如何设计一个分布式日志追踪系统？TraceId 如何在服务间传递？**
- **ELK 的架构是什么？各组件的职责？**
- **Prometheus + Grafana 做监控的原理是什么？**

## 六、系统设计

- **如何设计一个高并发秒杀系统？**  
  → 详见 <RouteLink to="/scenario/3_seckill">秒杀系统</RouteLink>
- **如何设计一个短链接系统？**  
  → 详见 <RouteLink to="/scenario/5_shorturl">短链接</RouteLink>
- **如何设计一个排行榜系统？**  
  → 详见 <RouteLink to="/scenario/6_rank_system">排行榜</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/12_architecture">开发总结-系统架构</RouteLink>
:::

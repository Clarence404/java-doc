# 系统架构总览

系统架构模块整理 Java 后端在「代码怎么组织、数据怎么分层、接口怎么可靠」上的通用设计：架构模式与 DDD、冷热分离与对象存储、幂等、权限系统与主数据。

**版本基线（2026 年 10 月）**：JDK 21 / 25、Spring Boot 4、MySQL 8.4、Redis 8.x、RocketMQ 5.x、AWS SDK for Java 2.x、MyBatis-Plus 3.5

---

## 一、模块地图

微服务拆分与中间件选型在 [微服务](/microservices/0_overview) 与 [Spring Cloud](/spring-cloud/0_overview) 模块展开，业务系统的完整设计案例在 [业务场景](/scenario/0_overview) 模块，这里不重复。示例代码统一使用构造器注入。

| 方向 | 内容 | 适合关注 |
|------|------|----------|
| **代码组织** | 分层、整洁架构、六边形架构、CQRS、事件溯源、DDD | 业务复杂、需要长期演进的系统 |
| **数据策略** | 冷热分离、对象存储 | 数据量增长、文件与归档存储 |
| **可靠性基础** | 幂等设计、领域事件与 Outbox | 重试、MQ 消费、支付回调 |
| **平台能力** | 权限系统架构、主数据系统 | 多服务共享的基础平台 |

---

## 二、模块导航

<ModuleNav />

---

## 三、推荐阅读路径

1. [架构模式与风格](./2_arch_patterns) 与 [DDD 领域驱动设计](./3_ddd)：先建立依赖方向、聚合与限界上下文的概念，再看领域事件如何经 Outbox 可靠投递
2. [幂等设计](./5_idempotence)：所有重试、MQ 消费、回调接口的前提，建议与 [消息队列基础](/messaging/1_basics) 一起读
3. [数据冷热分离](./1_cold_hot_data) 与 [对象存储](./4_object_storage)：数据量增长后的分层存储与文件存储方案
4. [权限系统架构设计](./6_access_control) 与 [主数据系统设计](./7_master_data)：把前面的模式组合成具体的平台系统

[高频面试题](./99_interview) 只列题目，答案在 [系统架构面试题解答](/interview/15_architecture)。

---

## 四、关联模块

- 服务拆分、通信与治理 → [微服务](/microservices/0_overview) / [Spring Cloud](/spring-cloud/0_overview)
- 分布式锁、分布式事务、分布式 ID → [分布式](/distributed/0_overview)
- MQ 可靠投递、事务消息与消费幂等 → [消息队列](/messaging/0_overview)
- 缓存一致性与两级缓存 → [缓存](/cache/0_overview)
- 系统级扩展、热点与容量规划 → [高并发](/high-con/0_overview)
- 认证授权模型与零信任 → [应用安全](/security/0_overview)
- 秒杀、订单、文件上传等完整案例 → [业务场景](/scenario/0_overview)

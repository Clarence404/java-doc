# 分布式基础总览

本模块先从分布式理论建立「一致性与可用性怎么取舍」的视角，再落到一致性哈希、ID、锁、事务、会话、调度等工程方案；为什么从单体拆成分布式，见微服务设计模块的 [从单体到微服务](/microservices/1_pros_and_cons)。

**版本基线（2026 年 10 月）**：Redis 8、Redisson 4、Curator 5.x、jetcd 0.8.x、Apache Seata 2.5 / 2.6、RocketMQ 5、Kafka 4、XXL-JOB 3.x、Quartz 2.5、ElasticJob 3.0.x、PowerJob 5.x、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

侧边栏分三段，按顺序读：

1. **理论**：[分布式理论](./1_theorem) 讲 CAP、共识算法与一致性模型，弄清一致性与可用性怎么取舍；[一致性哈希](./2_consistent_hashing) 是缓存分片、分库分表与 MQ 分区路由的基础
2. **协调与一致性**：[分布式 ID 生成](./3_id_generator)、[分布式锁](./4_lock)、[分布式事务](./5_transaction)，业务里最常碰到的协调问题，重点看时钟回拨、租约过期与 Fencing Token、Outbox 与 Seata 的适用边界
3. **会话与任务**：[分布式会话](./6_session)、[分布式调度](./7_job_scheduler)、[工作流引擎](./8_work_flow)，应用多实例部署后要外置的状态与任务，按需阅读

[高频面试题](./99_interview) 只列题目，答案在 [分布式基础面试题解答](/interview/16_distributed)。

---

## 三、关联模块

本模块是锁、事务、ID、会话的主文档；缓存一致性见 [缓存一致性](/cache/10_cache_consistency)，幂等见 [幂等设计](/architecture/3_idempotence)，消息可靠投递见 [消息队列基础](/messaging/1_basics)，分库分表见 [分库分表与中间件](/database/4_practice/4_sharding)。版本说明：Redis 8.4 起有原生 `DELEX key IFEQ value` 做比较后删除（Valkey 8.x 同理）；Redisson 4.x 锁 API 与 3.x 一致；Seata 仍为 Apache 孵化项目，groupId 为 `org.apache.seata`，SCA 2025.1 BOM 自带 2.5.0，最新版为 2.6.0，客户端可沿用 BOM 的 2.5.0 或显式覆盖到 2.6.0，seata-server 与客户端保持同一版本；Kafka 4.x 仅支持 KRaft；XXL-JOB 3.x 需 JDK 17+。

- [高并发总览](/high-con/0_overview) / [高可用总览](/high-avail/0_overview) / [高性能总览](/high-perf/0_overview)：系统级的扩展、容灾与性能策略
- [微服务设计总览](/microservices/0_overview)：服务拆分与微服务设计模式
- [服务治理总览](/service-governance/0_overview)：Spring Cloud 治理与 Seata 的配置落地
- [Redis 与缓存总览](/cache/0_overview)：Redis、Redisson API 与缓存一致性
- [消息队列总览](/messaging/0_overview)：消息可靠投递、消费幂等与事务消息的中间件细节
- [幂等设计](/architecture/3_idempotence)：接口与消息消费的幂等方案（唯一约束、状态机、去重表）
- [分库分表与中间件](/database/4_practice/4_sharding)：分片键、ShardingSphere 与分布式主键的落地
- [JWT 令牌机制](/security/1_jwt)：无状态令牌的结构、签名与吊销
- [业务场景总览](/scenario/0_overview)：秒杀、订单等用到锁、事务与 ID 的完整案例

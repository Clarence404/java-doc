# 分布式总览

分布式模块讲多节点协作的通用问题：先从架构演进和分布式理论（CAP / PACELC、BASE、Paxos / Raft / ZAB、Gossip）建立「一致性与可用性怎么取舍」的视角，再落到分布式锁、分布式事务、会话共享、任务调度、流程编排、ID 生成和一致性哈希这些工程方案上。本模块是锁、事务、ID、会话的主文档；缓存一致性见 [缓存一致性](/cache/10_cache_consistency)，幂等见 [幂等设计](/architecture/5_idempotence)，消息可靠投递见 [消息队列基础](/messaging/1_basics)，分库分表见 [分库分表与中间件](/database/5_practice/2_sharding)。

版本基线：**Redis 8.x / Valkey 8.x**（Redis 8.4 起有原生的 `DELEX key IFEQ value` 做比较后删除）、**Redisson 4.x**（锁 API 与 3.x 一致：`RLock` / `RFencedLock`）、**Curator 5.x**、**jetcd 0.8.x**、**Apache Seata 2.x**（孵化中，groupId `org.apache.seata`，当前 2.6）、**RocketMQ 5.x**、**Kafka 4.x**（仅 KRaft）、**XXL-JOB 3.x**（JDK 17+）、**Quartz 2.5**、**ShardingSphere ElasticJob 3.0.x**、**PowerJob 5.x**、**Spring Boot 4 / Spring Session 4**。

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读 [分布式架构](./1_distributed) 与 [分布式理论](./2_theorem)，弄清为什么拆、拆了以后一致性与可用性怎么取舍
2. 再读 [分布式锁](./3_lock) 与 [分布式事务](./4_transaction)，这是业务里最常碰到的两类协调问题，重点看租约过期、Fencing Token、Outbox 与 Seata 的适用边界
3. 然后读 [分布式 ID 生成](./8_id_generator) 与 [一致性哈希](./9_consistent_hashing)，它们是分库分表与缓存分片的基础工具
4. 最后按需读 [分布式会话](./5_session)、[分布式调度](./6_job_scheduler)、[工作流引擎](./7_work_flow)

[高频面试题](./99_interview) 只列题目，答案在 [分布式面试题解答](/interview/10_distributed)。

---

## 三、关联模块

- [高并发总览](/high-con/0_overview) / [高可用总览](/high-avail/0_overview) / [高性能总览](/high-perf/0_overview)：系统级的扩展、容灾与性能策略
- [微服务总览](/microservices/0_overview) / [Spring Cloud 总览](/spring-cloud/0_overview)：服务拆分、治理与 Seata 的配置落地
- [缓存总览](/cache/0_overview)：Redis、Redisson API 与缓存一致性
- [消息队列总览](/messaging/0_overview)：消息可靠投递、消费幂等与事务消息的中间件细节
- [幂等设计](/architecture/5_idempotence)：接口与消息消费的幂等方案（唯一约束、状态机、去重表）
- [分库分表与中间件](/database/5_practice/2_sharding)：分片键、ShardingSphere 与分布式主键的落地
- [JWT 令牌机制](/security/1_jwt)：无状态令牌的结构、签名与吊销
- [业务场景总览](/scenario/0_overview)：秒杀、订单等用到锁、事务与 ID 的完整案例

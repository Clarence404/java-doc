# 分布式总览

分布式模块覆盖架构演进、分布式理论（CAP / BASE / 共识算法）以及分布式锁、事务、会话、调度、ID 生成、一致性哈希等通用问题的解决方案。

## 一、模块导航

| 文档 | 覆盖内容 |
|------|----------|
| [分布式架构](./1_distributed) | 单体 → 集群 → 分布式 → SOA → 微服务的演进与对比 |
| [分布式理论](./2_theorem) | CAP、BASE、Paxos、Raft、ZAB、Gossip、FLP |
| [分布式锁](./3_lock) | Redis 锁、Redlock 争议、ZooKeeper / etcd 锁、方案对比 |
| [分布式事务](./4_transaction) | 2PC / 3PC、TCC、本地消息表、可靠消息、Saga、Seata |
| [分布式会话](./5_session) | Cookie-Session、JWT、Redis Session、选型建议 |
| [分布式调度](./6_job_scheduler) | XXL-JOB、Quartz、ElasticJob、PowerJob 等对比 |
| [工作流](./7_work_flow) | Activiti / Flowable / Camunda / jBPM 选型 |
| [分布式 ID 生成](./8_id_generator) | UUID、自增、雪花算法、号段模式、Leaf、UidGenerator |
| [一致性哈希](./9_consistent_hashing) | 原理、虚拟节点、在缓存与 MQ 中的应用 |
| [面试高频题](./99_interview) | 分布式方向题目清单 |

## 二、推荐阅读路径

1. 先读 [分布式架构](./1_distributed) 与 [分布式理论](./2_theorem)，建立一致性与可用性的取舍视角。
2. 再读 [分布式锁](./3_lock) 与 [分布式事务](./4_transaction)，掌握最常用的两类协调问题。
3. 然后读 [分布式 ID](./8_id_generator) 与 [一致性哈希](./9_consistent_hashing)，理解数据分片的基础工具。
4. 最后按需阅读 [会话](./5_session)、[调度](./6_job_scheduler)、[工作流](./7_work_flow)。

## 三、关联模块

- 三高架构（高并发 / 高可用 / 高性能）→ [高并发](/high-con/0_overview) / [高可用](/high-avail/0_overview) / [高性能](/high-perf/0_overview)
- 微服务架构与治理 → [微服务](/microservices/0_overview) / [Spring Cloud](/spring-cloud/0_overview)
- 分布式缓存与消息中间件 → [缓存](/cache/0_overview) / [消息队列](/messaging/0_overview)

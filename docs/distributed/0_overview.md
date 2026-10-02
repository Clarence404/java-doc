# 分布式总览

分布式模块覆盖架构演进、分布式理论（CAP / BASE / 共识算法）以及分布式锁、事务、会话、调度、ID 生成、一致性哈希等通用问题的解决方案。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. 先读 [分布式架构](./1_distributed) 与 [分布式理论](./2_theorem)，建立一致性与可用性的取舍视角。
2. 再读 [分布式锁](./3_lock) 与 [分布式事务](./4_transaction)，掌握最常用的两类协调问题。
3. 然后读 [分布式 ID](./8_id_generator) 与 [一致性哈希](./9_consistent_hashing)，理解数据分片的基础工具。
4. 最后按需阅读 [会话](./5_session)、[调度](./6_job_scheduler)、[工作流](./7_work_flow)。

## 三、关联模块

- 三高架构（高并发 / 高可用 / 高性能）→ [高并发](/high-con/0_overview) / [高可用](/high-avail/0_overview) / [高性能](/high-perf/0_overview)
- 微服务架构与治理 → [微服务](/microservices/0_overview) / [Spring Cloud](/spring-cloud/0_overview)
- 分布式缓存与消息中间件 → [缓存](/cache/0_overview) / [消息队列](/messaging/0_overview)

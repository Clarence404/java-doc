# 消息队列总览

消息中间件（MQ）是分布式系统的异步通信层，用来解耦服务、削峰填谷、把非核心操作异步化。本模块先讲可靠性、幂等、顺序、积压等通用问题，再深入 Kafka、RocketMQ、RabbitMQ 并给出选型建议。

**版本基线（2026 年 10 月）**：Kafka 4、RocketMQ 5、RabbitMQ 4、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. [消息队列基础](./1_basics)：解耦削峰异步、消息模型，以及不丢、不重、有序、积压、事务一致的通用解法，后面各家 MQ 都按这套问题对照着读
2. **Kafka**：[Kafka 架构与存储](./2_kafka)（分区日志、副本与 KRaft、高吞吐原理、Share Group）→ [Kafka 生产与消费](./3_kafka_client)（Spring Boot 接入、幂等消费、事务与 Exactly-Once、顺序消息）→ [Kafka Streams 与 Connect](./4_kafka_streams)，大数据与事件流场景的首选
3. **RocketMQ**：[RocketMQ 架构与存储](./5_rocketmq)（4.x 与 5.x、CommitLog、高可用）→ [RocketMQ 生产与消费](./6_rocketmq_client)（事务消息、延迟与顺序消息、重试与死信），国内业务消息的主力
4. **RabbitMQ**：[RabbitMQ 核心模型与高可用](./7_rabbitmq)（Exchange 路由、Quorum 队列、Streams）→ [RabbitMQ 生产与消费](./8_rabbitmq_client)（发布确认、手动 ACK、死信与延迟消息），灵活路由与中低并发业务解耦
5. [Pulsar 与其他 MQ](./9_other_mq)：Apache Pulsar 的存算分离与订阅模式，以及其他常见消息系统的定位
6. [MQ 选型](./10_selection)：三大 MQ 对比、场景决策与常见误区

复习时用 [高频面试题](./99_interview) 自测，答案在 [消息队列面试题解答](/interview/15_mq)。

---

## 三、关联模块

- [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)：MQ 在系统级削峰设计中的位置
- [分布式基础 · 分布式事务](/distributed/5_transaction)：TCC、Saga、本地消息表、事务消息的完整对比
- [系统架构 · 幂等设计](/architecture/3_idempotence)：消费幂等所依赖的通用幂等方案
- [Spring Boot · 中间件集成](/spring-boot/6_middleware)：Spring Boot 集成 Kafka / RabbitMQ
- [CDC 工具](/database/4_practice/8_cdc_tools)：基于 binlog 的数据同步与 Outbox 投递

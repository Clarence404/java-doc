# 消息队列总览

消息中间件（Message Queue，MQ）是分布式系统中的异步通信层，用来解耦服务依赖、缓冲流量洪峰、把非核心操作异步化。本模块先讲与产品无关的通用问题（可靠性、幂等、顺序、积压、事务一致），再分别深入 Kafka、RocketMQ、RabbitMQ 三大主流 MQ，介绍 Pulsar 等其他 MQ，最后给出选型建议。

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. [消息队列基础](./1_basics)：解耦削峰异步、消息模型，以及不丢、不重、有序、积压、事务一致的通用解法
2. [Kafka](./2_kafka)：分区日志、副本与 KRaft、高吞吐原理，大数据与事件流场景的首选
3. [RocketMQ](./3_rocketmq)：事务消息、定时消息、顺序消息，国内业务消息的主力
4. [RabbitMQ](./4_rabbitmq)：AMQP 交换机路由、仲裁队列，灵活路由与中低并发业务解耦
5. [其他 MQ](./5_other_mq)：Apache Pulsar 与其他常见消息系统的定位
6. [MQ 选型](./6_selection)：三大 MQ 对比、场景决策与常见误区

---

## 三、关联模块

- [高并发 · 异步与削峰](/high-con/4_async_peak_shaving)：MQ 在系统级削峰设计中的位置
- [分布式 · 分布式事务](/distributed/4_transaction)：TCC、Saga、本地消息表、事务消息的完整对比
- [系统架构 · 幂等方案总结](/architecture/5_idempotence)：消费幂等所依赖的通用幂等方案
- [Spring Boot · 中间件集成](/spring-boot/5_middleware)：Spring Boot 集成 Kafka / RocketMQ / RabbitMQ
- [数据库 · CDC 工具](/database/5_practice/0_cdc_tools)：基于 binlog 的数据同步与 Outbox 投递
- [开发总结 · 消息队列](/interview/9_mq)：本模块高频问题的答案汇总

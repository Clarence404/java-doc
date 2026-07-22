# 消息队列面试高频题

> 汇总 MQ 核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/6_mq">开发总结-消息队列</RouteLink>

## 一、MQ 基础

- **消息队列有哪些使用场景？（异步解耦、削峰填谷、广播通知）**
- **消息队列的核心工作流程是什么？（Producer → Broker → Consumer）**
- **Kafka、RocketMQ、RabbitMQ 的对比？各自适合什么场景？**

## 二、消息可靠性

- **如何保证消息不丢失？（生产确认 + 持久化 + 消费 ACK）**
- **RocketMQ 的同步刷盘和异步刷盘有什么区别？**
- **Kafka 的 ISR 机制是什么？如何保证数据不丢失？**
- **消息幂等性（重复消费）如何保证？**（全局唯一 ID + Redis SETNX / DB 唯一索引）

## 三、消息顺序

- **如何保证消息的顺序消费？**
- **RocketMQ 如何实现顺序消息？（MessageGroup + FIFO 队列）**
- **Kafka 如何保证分区内有序？跨分区能保证顺序吗？**  
  → 详见 <RouteLink to="/messaging/1_kafka">Kafka</RouteLink>

## 四、高性能

- **消息队列如何实现高效读写？**（零拷贝 MMap/SendFile、顺序写入、PageCache）
- **Kafka 为什么吞吐量这么高？**
- **消息积压了怎么处理？**

## 五、分布式事务

- **如何用消息队列实现分布式事务最终一致性？**
- **RocketMQ 事务消息的原理是什么？（半消息 + 本地事务 + 回查）**
- **本地消息表和 RocketMQ 事务消息的区别？**  
  → 详见 <RouteLink to="/messaging/2_rocketmq">RocketMQ</RouteLink>

## 六、高可用

- **RocketMQ 如何保证高可用？（主从复制 + DLedger）**
- **Kafka 的副本机制是什么？Leader 宕机如何选举？**
- **RabbitMQ 的镜像队列和 Quorum Queue 有什么区别？**
- **如何设计一个消息队列？**

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/6_mq">开发总结-消息队列</RouteLink>
:::

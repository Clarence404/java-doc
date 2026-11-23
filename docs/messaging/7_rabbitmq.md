---
description: Exchange 四种类型与 Topic 匹配、Docker 安装、镜像队列移除、Quorum 队列、Streams
---

# RabbitMQ 核心模型与高可用

> 前置阅读：[消息队列基础](./1_basics)

RabbitMQ 是 AMQP 0-9-1 的经典实现，强项是灵活路由和低延迟。本篇讲 Exchange 路由模型、单机安装、Quorum 队列与 Streams，基线为 RabbitMQ 4。

---

## 一、核心概念

**生产者从不直接把消息投到队列，而是投给 Exchange，由 Exchange 按 Binding 规则路由到一个或多个 Queue。**

RabbitMQ 适合消息量中等、路由规则多的业务事件与任务分发。

![RabbitMQ 路由模型](../assets/messaging/rabbitmq-routing.svg)

| 概念 | 说明 |
|------|------|
| **Exchange** | 消息入口，按类型和 Binding 规则把消息分发到 Queue，本身不存消息 |
| **Queue** | 存储消息的缓冲区，消费者从队列取消息；类型有 classic / quorum / stream |
| **Binding** | Exchange 与 Queue 之间的绑定关系，带 Binding Key |
| **Routing Key** | 生产者发送时携带的路由标识，与 Binding Key 匹配 |
| **VHost** | 虚拟主机，隔离不同业务的 Exchange / Queue / 权限（类似命名空间）|
| **Connection / Channel** | 一个 TCP 连接上可开多个轻量 Channel，复用连接，减少资源消耗 |
| **DLX** | 死信交换机，被拒绝 / 过期 / 超长的消息由它转发到死信队列 |

---

## 二、Exchange 四种类型

| 类型 | 路由规则 | 适用场景 |
|------|---------|---------|
| **Direct** | Routing Key 与 Binding Key 完全相等 | 点对点，按业务类型路由 |
| **Fanout** | 广播给所有绑定的 Queue，忽略 Key | 系统通知、配置更新广播 |
| **Topic** | 按 `.` 分词做模式匹配：`*` 匹配恰好一个词，`#` 匹配零个或多个词 | 多维度订阅（区域、事件类型、日志级别）|
| **Headers** | 按消息 Header 属性匹配（`x-match=all/any`），不用 Routing Key | 复杂条件路由（少用，性能较差）|

Topic 匹配示例（Routing Key = `order.created.cn`）：

| Binding Key | 是否匹配 | 原因 |
|-------------|---------|------|
| `order.#` | 匹配 | `#` 匹配 `created.cn` 两个词 |
| `order.*.cn` | 匹配 | `*` 恰好匹配 `created` 一个词 |
| `order.*` | 不匹配 | `*` 只能匹配一个词，后面还剩 `cn` |
| `payment.#` | 不匹配 | 首个词不同 |

---

## 三、Docker 单机安装

```yaml
services:
  rabbitmq:
    image: rabbitmq:4-management
    container_name: rabbitmq
    hostname: rabbitmq          # 数据目录按节点名区分，固定 hostname 避免重建容器后"丢数据"
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: change_me
    ports:
      - "5672:5672"    # AMQP 协议端口
      - "15672:15672"  # 管理控制台
    volumes:
      - ./rabbitmq_data:/var/lib/rabbitmq
    restart: always
```

> 延迟消息插件、Stream 协议端口（5552）等按需另行启用，见 [RabbitMQ 生产与消费 · 延迟消息插件](./8_rabbitmq_client#_3、方案二-延迟消息插件) 与本篇 [Streams](#_3、streams-可回放的日志)。

---

## 四、高可用：Quorum 队列与 Streams

### 1、镜像队列已在 4.0 移除

**RabbitMQ 4.0 正式移除了经典镜像队列（Classic Mirrored Queues），需要复制的场景只剩两种队列类型：Quorum 队列和 Stream。** 3.x 时代的 `ha-mode` 策略在 4.x 不再生效，升级前必须先把镜像队列迁移到 Quorum。

| 对比 | Classic 队列 | Quorum 队列 | Stream |
|------|-------------|-------------|--------|
| 复制 | 无（单节点） | Raft 多副本，多数派写入才确认 | 多副本复制日志 |
| 消费语义 | 消费即删除 | 消费即删除 | 只追加日志，**非破坏性消费，可按 offset 回放** |
| 毒消息保护 | 无 | `delivery-limit`（4.0 起默认 20）| 不适用（不 requeue）|
| 适用 | 临时、可丢、排他、自动删除的队列 | **业务队列的默认选择** | 大扇出、回放、海量堆积 |

### 2、Quorum 队列

* 基于 Raft：一个 leader + 若干 follower，写入需多数派确认；节点宕机时自动选举新 leader，消息不丢。
* 副本数建议奇数（3 或 5），可用 `x-quorum-initial-group-size` 指定；3 副本可容忍 1 个节点故障。
* 始终持久化，不支持非持久、排他、自动删除；对内存和磁盘 I/O 的要求高于 classic 队列。
* `delivery-limit`：消息投递次数超过上限即被死信（配置了 DLX 时）或丢弃，是防止毒消息无限 requeue 的最后一道闸。
* 死信默认是 at-most-once（转发失败就丢）；对死信可靠性有要求时可设置 `dead-letter-strategy: at-least-once`（需配合 `overflow: reject-publish`）。

```java
QueueBuilder.durable("order.queue")
    .quorum()
    .deliveryLimit(5)
    .deadLetterExchange("order.dlx.exchange")
    .build();
```

> 注意区分：`spring.rabbitmq.listener.simple.default-requeue-rejected: false` 不是队列属性，而是 **Spring 监听容器**的开关，决定监听方法抛异常时是否让 Broker 重新入队；`delivery-limit` 才是 Quorum 队列自身的兜底。两者配合使用，前者对任何队列类型都生效。

### 3、Streams：可回放的日志

**RabbitMQ 3.9 起提供 Stream 类型：消息只追加写入日志、按保留策略过期，消费后不删除，多个消费者可从任意 offset 独立读取。** 所以"RabbitMQ 不支持回放"的说法已过时——用 Stream 就能回放。

* 回放：消费时指定起点 `first` / `last` / `next` / 具体 offset / 时间戳。
* 保留策略：按大小（`x-max-length-bytes`）或时间（`x-max-age`）清理旧数据段。
* 分区：Super Stream（3.11 起）把一个逻辑流拆成多个分区 Stream，类似 Kafka 的分区。
* 访问方式：可用 AMQP 0-9-1 消费（需手动 ack、设置 prefetch，并通过消费者参数 `x-stream-offset` 指定起点），也可用原生 Stream 协议（端口 5552，Java 客户端 `stream-client`，Spring 侧为 `spring-rabbit-stream`），吞吐更高。

```java
@Bean
public Queue orderEventStream() {
    return QueueBuilder.durable("order.events")
        .stream()                                    // x-queue-type=stream
        .withArgument("x-max-age", "7D")             // 保留 7 天
        .build();
}
```

> Stream 适合审计、事件溯源、大扇出这类"一份数据多方读、需要重读"的场景；但其生态和海量吞吐仍不及 Kafka，日志型主链路仍建议选 [Kafka 架构与存储](./2_kafka)。

---

## 小结

* RabbitMQ 的核心是 **Exchange 路由**：Direct 精确匹配、Fanout 广播、Topic 模式匹配（`*` 一个词，`#` 零或多个词）、Headers 按属性匹配。
* 单机部署固定 `hostname`，避免重建容器后数据目录对不上；延迟插件与 Stream 端口按需另行启用。
* 4.0 起镜像队列已移除，**Quorum 队列（Raft）是复制队列的标准选择**，`delivery-limit` 是防毒消息无限 requeue 的最后一道闸；Classic 队列只适合临时、可丢的场景。
* Stream（3.9+）提供只追加日志与按 offset 回放，适合审计、事件溯源、大扇出，日志型主链路仍选 Kafka。
* 延迟低（通常亚毫秒到毫秒级）、路由灵活，但吞吐与堆积能力不如 Kafka / RocketMQ。

## 参考资料

- 官方文档：[https://www.rabbitmq.com/docs](https://www.rabbitmq.com/docs)
- Quorum Queues：[https://www.rabbitmq.com/docs/quorum-queues](https://www.rabbitmq.com/docs/quorum-queues)
- Streams：[https://www.rabbitmq.com/docs/streams](https://www.rabbitmq.com/docs/streams)

> 下一篇：[RabbitMQ 生产与消费](./8_rabbitmq_client) —— Spring Boot 接入、发布确认与回退、自动 / 手动 ACK 与重试、幂等消费、死信与延迟消息、积压与顺序

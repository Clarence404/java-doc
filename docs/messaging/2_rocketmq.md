# RocketMQ

> 参考资料：
> * 官方文档：[https://rocketmq.apache.org/docs/](https://rocketmq.apache.org/docs/)
> * rocketmq-spring：[https://github.com/apache/rocketmq-spring](https://github.com/apache/rocketmq-spring)

---

## 一、架构与核心概念

```
Producer ──→ NameServer（注册中心）
              │
              ├── Broker Master ──→ Broker Slave（主从同步）
              │      ├── Topic A: MessageQueue 0, 1, 2, 3
              │      └── Topic B: MessageQueue 0, 1
              │
Consumer Group ──→ 订阅 Topic，按 MessageQueue 分配消费
```

| 组件/概念 | 说明 |
|----------|------|
| **NameServer** | 无状态注册中心，Broker 心跳注册，Producer/Consumer 从此获取路由（类比 DNS）|
| **Broker** | 消息存储与转发节点，Master 处理读写，Slave 同步数据 |
| **Topic** | 消息分类，一个 Topic 有多个 MessageQueue |
| **MessageQueue** | Topic 的分片（对标 Kafka Partition），决定顺序和并发粒度 |
| **Tag** | Topic 内的二级过滤标签，消费者可按 Tag 订阅 |
| **ConsumerGroup** | 同组消费者共享消费，支持集群消费（负载均衡）和广播消费（全量接收）|

---

## 二、Spring Boot 快速接入

```xml
<dependency>
    <groupId>org.apache.rocketmq</groupId>
    <artifactId>rocketmq-spring-boot-starter</artifactId>
    <version>2.3.0</version>
</dependency>
```

```yaml
rocketmq:
  name-server: 127.0.0.1:9876
  producer:
    group: order-producer-group
    send-message-timeout: 3000
    retry-times-when-send-failed: 3
```

### 生产者

```java
@Service
public class OrderMessageProducer {
    @Autowired
    private RocketMQTemplate rocketMQTemplate;

    // 普通消息
    public void sendOrderCreated(Order order) {
        rocketMQTemplate.convertAndSend("order-topic:CREATED", order);
    }

    // 同步发送（等待 Broker 确认）
    public void sendSync(Order order) {
        SendResult result = rocketMQTemplate.syncSend("order-topic", order);
        if (result.getSendStatus() != SendStatus.SEND_OK) {
            throw new RuntimeException("MQ send failed: " + result);
        }
    }

    // 延迟消息（超时取消：30 分钟后投递）
    public void sendDelayOrder(Order order) {
        Message<Order> msg = MessageBuilder.withPayload(order).build();
        // 延迟级别：1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h
        rocketMQTemplate.syncSend("order-topic:TIMEOUT_CHECK", msg, 3000, 16); // 第 16 级 = 30m
    }

    // 顺序消息（同一 orderId 发到同一 MessageQueue）
    public void sendOrderStatusChange(Long orderId, String status) {
        rocketMQTemplate.syncSendOrderly("order-status-topic", status, orderId.toString());
    }
}
```

### 消费者

```java
// 普通消费
@Component
@RocketMQMessageListener(
    topic = "order-topic",
    selectorExpression = "CREATED || TIMEOUT_CHECK",  // Tag 过滤
    consumerGroup = "order-consumer-group"
)
public class OrderConsumer implements RocketMQListener<Order> {

    @Override
    public void onMessage(Order order) {
        // 幂等检查
        if (!redis.opsForValue().setIfAbsent(
                "rmq:consumed:" + order.getMsgId(), "1", Duration.ofDays(1))) {
            return;
        }
        processOrder(order);
        // 不抛异常 = ACK；抛异常 = RECONSUME_LATER（重试）
    }
}

// 顺序消费
@Component
@RocketMQMessageListener(
    topic = "order-status-topic",
    consumerGroup = "order-status-group",
    consumeMode = ConsumeMode.ORDERLY   // 顺序消费模式
)
public class OrderStatusConsumer implements RocketMQListener<String> {
    @Override
    public void onMessage(String status) {
        updateOrderStatus(status);
    }
}
```

---

## 三、四种消息类型

| 类型 | 特点 | 适用场景 |
|------|------|---------|
| **普通消息** | 无顺序、无事务保证，高吞吐 | 日志、通知、异步任务 |
| **顺序消息** | 同一 MessageGroup 内严格有序 | 订单状态流转、账务流水 |
| **延迟消息** | 指定延迟级别后投递（18 级，最长 2h）| 订单超时取消、定时提醒 |
| **事务消息** | 本地事务与消息投递原子一致 | 分布式事务最终一致 |

---

## 四、事务消息原理

```
Producer                    Broker                  本地 DB
   │                           │                       │
   │── ① 发送半消息（Half Msg）──→│                       │
   │◄── ② 半消息写入成功 ─────────│                       │
   │── ③ 执行本地事务 ───────────────────────────────────►│
   │                           │                       │
   │── ④a 本地事务成功 → COMMIT ──→│ ⑤ 投递给消费者         │
   │── ④b 本地事务失败 → ROLLBACK →│ ⑤ 删除半消息           │
   │                           │                       │
   │    ⑥ 如果长时间未确认 ──────│── 回查本地事务状态 ──────►│
   │                           │◄── 返回 COMMIT/ROLLBACK──│
```

```java
@Service
public class OrderTransactionProducer {

    public void createOrderWithMQ(CreateOrderRequest req) {
        rocketMQTemplate.sendMessageInTransaction(
            "order-topic",
            MessageBuilder.withPayload(req).build(),
            req  // 回查时用到的参数
        );
    }
}

// 本地事务执行 + 回查
@RocketMQTransactionListener
public class OrderTransactionListener implements RocketMQLocalTransactionListener {

    @Override
    public RocketMQLocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        try {
            CreateOrderRequest req = (CreateOrderRequest) arg;
            orderRepository.save(new Order(req));          // 本地事务
            return RocketMQLocalTransactionState.COMMIT;
        } catch (Exception e) {
            return RocketMQLocalTransactionState.ROLLBACK;
        }
    }

    @Override
    public RocketMQLocalTransactionState checkLocalTransaction(Message msg) {
        // Broker 回查：检查本地事务是否执行成功
        CreateOrderRequest req = parseRequest(msg);
        return orderRepository.existsByRequestId(req.getRequestId())
            ? RocketMQLocalTransactionState.COMMIT
            : RocketMQLocalTransactionState.ROLLBACK;
    }
}
```

---

## 五、消息可靠性

| 层次 | 配置 | 说明 |
|------|------|------|
| 生产者 | `syncSend` / `producer.retry-times=3` | 同步发送确保 Broker 收到；失败重试 |
| Broker | `flushDiskType=SYNC_FLUSH` | 同步刷盘，性能低但不丢消息 |
| Broker | `brokerRole=SYNC_MASTER` | 同步主从复制，Slave 确认后才返回 |
| 消费者 | 不抛异常 = ACK | 抛异常触发重试，默认重试 16 次后进死信队列 |

---

## 六、消费模式

| 模式 | 说明 | 配置 |
|------|------|------|
| **集群消费（默认）** | 同 Group 内多实例负载均衡消费，每条消息只被处理一次 | `messageModel = CLUSTERING` |
| **广播消费** | 同 Group 内每个实例都收到全量消息 | `messageModel = BROADCASTING` |

---

## 七、常见问题

### 消息丢失

生产者使用 `syncSend`，开启同步刷盘（`SYNC_FLUSH`）和同步主从（`SYNC_MASTER`），消费者不抛异常才算 ACK。

### 重复消费

网络超时重试、消费者重启都会导致重复，业务侧用 `msgId` 做幂等（Redis SETNX 或 DB 唯一索引）。

### 消息积压

```
1. 扩容消费者实例（不超过 MessageQueue 数）
2. 如果消费者逻辑慢：改为批量消费（consumeMessageBatchMaxSize）
3. 积压严重时：临时增加 MessageQueue 并行度
4. 死信队列积压：人工消费或写补偿脚本
```

### 死信队列处理

```java
// 死信 Topic 名称规则：%DLQ%{ConsumerGroup}
@Component
@RocketMQMessageListener(
    topic = "%DLQ%order-consumer-group",
    consumerGroup = "dlq-handler-group"
)
public class DlqHandler implements RocketMQListener<MessageExt> {
    @Override
    public void onMessage(MessageExt msg) {
        // 告警 + 人工处理 / 写入数据库待审核
        alertService.sendDlqAlert(msg.getTopic(), new String(msg.getBody()));
    }
}
```

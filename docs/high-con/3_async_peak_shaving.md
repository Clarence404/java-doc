# 异步与削峰

> 参考链接：[RocketMQ 事务消息](https://rocketmq.apache.org/zh/docs/featureBehavior/04transactionmessage) · [Kafka 官方文档](https://kafka.apache.org/documentation/)

缓存解决的是"读"的扩展，异步解决的是"写"和"重"的扩展：**把非核心、可延迟的工作从请求链路上剥离，把瞬时洪峰摊平到系统可承受的速率**。

---

## 一、MQ 异步削峰

通过消息队列将同步调用解耦为异步处理，平滑流量洪峰。

![MQ异步削峰](../assets/concurrency/mq.svg)

**典型场景**：

- 秒杀下单：接受请求后立即返回"处理中"，MQ 异步扣库存、创建订单
- 日志审计：业务操作同步写 DB，日志记录异步写 Kafka
- 邮件/短信通知：主流程完成后异步推送通知

**异步带来的收益**：

| 收益 | 说明 |
|------|------|
| 降低 RT | 主链路只做核心步骤，接口响应从 500ms 降到 50ms |
| 提升吞吐 | Web 线程快速释放，同样线程数承载更多请求 |
| 削峰填谷 | 洪峰先堆积在 MQ，消费端按自身能力匀速处理 |
| 故障隔离 | 下游（短信、积分）故障不影响主流程，恢复后继续消费 |

**代价**：结果不再实时可见、需要处理消息丢失/重复/乱序、链路排查更复杂。

---

## 二、同步转异步的常见模式

| 模式 | 做法 | 适用场景 |
|------|------|----------|
| **事件通知** | 主流程完成后发事件，下游各自订阅 | 下单后发短信、加积分、更新搜索索引 |
| **请求受理 + 异步处理** | 立即返回受理号，客户端轮询 / 回调 / WebSocket 获取结果 | 秒杀下单、报表导出、批量导入 |
| **写缓冲（Write-Behind）** | 先写 Redis / 内存队列，后台批量落库 | 点赞数、浏览量、埋点 |
| **异步编排** | 多个无依赖的远程调用并行执行 | 商品详情页聚合多个服务 |

异步编排示例（线程池必须自定义，避免使用公共 ForkJoinPool）：

```java
public ItemDetailVO getDetail(Long itemId) {
    CompletableFuture<ItemDTO> itemF = CompletableFuture.supplyAsync(() -> itemClient.get(itemId), ioPool);
    CompletableFuture<StockDTO> stockF = CompletableFuture.supplyAsync(() -> stockClient.get(itemId), ioPool);
    CompletableFuture<List<CommentDTO>> commentF = CompletableFuture
            .supplyAsync(() -> commentClient.top(itemId, 10), ioPool)
            .completeOnTimeout(Collections.emptyList(), 200, TimeUnit.MILLISECONDS); // 非核心数据超时降级

    CompletableFuture.allOf(itemF, stockF, commentF).join();
    return ItemDetailVO.of(itemF.join(), stockF.join(), commentF.join());
}
```

`CompletableFuture` 的详细用法见 [CompletableFuture](/java/29_topic_completable_future)。

---

## 三、削峰填谷

### 1、原理

瞬时流量 10w QPS 持续 10 秒，而下游数据库只能承受 5000 TPS。若同步处理，DB 直接被打垮；引入 MQ 后：

- 生产端：10 秒内写入 100w 条消息（MQ 顺序写磁盘，写入能力远高于 DB）
- 消费端：以 5000 TPS 匀速消费，约 200 秒处理完
- 结果：DB 始终在安全水位，代价是最后一条消息延迟约 200 秒

### 2、控制消费速率

削峰的关键是**消费端速率可控**，而不是越快越好：

| MQ | 控制手段 |
|----|----------|
| Kafka | `max.poll.records` 控制单批拉取数；消费者实例数 ≤ 分区数；消费逻辑内做令牌桶限速 |
| RocketMQ | `consumeThreadMin/Max` 控制并发；`pullBatchSize`；`consumeMessageBatchMaxSize` |
| RabbitMQ | `prefetch`（basic.qos）限制未确认消息数；消费者数 |

```java
@Component
@RocketMQMessageListener(topic = "order-create", consumerGroup = "order-create-cg",
        consumeThreadNumber = 20)            // 并发消费线程数（RocketMQ Spring 2.2.x+）
public class OrderCreateConsumer implements RocketMQListener<OrderMsg> {

    // Guava RateLimiter：单实例每秒最多处理 500 条，N 个实例总速率 = 500 × N
    private final RateLimiter limiter = RateLimiter.create(500);

    @Override
    public void onMessage(OrderMsg msg) {
        limiter.acquire();
        orderService.createIfAbsent(msg);    // 必须幂等：MQ 至少一次投递
    }
}
```

### 3、积压的监控与处理

- 监控**消费延迟（Lag）**：Kafka 用 consumer lag，RocketMQ 用 `diffTotal`
- 积压时先判断是"消费变慢"（下游故障）还是"生产突增"（正常洪峰）
- 临时扩容：增加消费者实例（Kafka 受分区数上限约束），或把消息转存到新的多分区 Topic 再并行消费
- 对时效敏感的消息设置过期丢弃，避免处理已无意义的旧请求

---

## 四、排队与令牌

MQ 是"系统内部排队"，面向用户的高并发场景（秒杀、抢票、挂号）还常用"**用户侧排队**"：

| 方案 | 做法 | 效果 |
|------|------|------|
| **令牌发放** | 活动开始前按库存量发放有限令牌（如库存 × 1.5），无令牌请求直接返回"已抢完" | 把 100w 请求过滤到 1.5w |
| **排队队列** | 请求写入 Redis List / ZSet，返回排队序号，前端轮询 | 用户体验可控，后端匀速处理 |
| **异步下单** | 请求通过校验后发 MQ，前端轮询下单结果 | 最终写 DB 的只有真实成交量 |

秒杀的完整链路（前端静态化、网关限流、Redis 预扣、MQ 异步下单）见 [秒杀系统设计](/scenario/4_seckill)。

---

## 五、流量整形 vs 限流

两者都是"控制流量速率"，但目标和行为不同：

| 对比项 | 流量整形（Traffic Shaping） | 限流（Rate Limiting） |
|--------|-----------------------------|------------------------|
| 目标 | 把不均匀的流量变平滑 | 保护系统不被超出容量的流量压垮 |
| 超出部分 | **缓冲、排队、延后处理** | **直接拒绝**（快速失败） |
| 典型算法 | 漏桶、MQ 缓冲、排队 | 令牌桶、滑动窗口、计数器 |
| 请求结果 | 最终都会被处理（延迟增加） | 被拒请求需客户端重试或放弃 |
| 归属 | 高并发（扛住流量） | 高可用（保护系统） |
| 场景 | 下单、支付回调、数据同步 | 接口防刷、网关总量保护 |

**组合使用**：网关层先限流挡住超出总容量的请求，放行的请求进入 MQ 整形，消费端匀速落库。限流算法与 Sentinel 配置见 [限流](/high-avail/3_rate_limiting)。

---

## 六、最终一致性与补偿

异步之后，多个步骤不再在一个本地事务里，需要保证**最终一致**：

| 问题 | 方案 |
|------|------|
| 本地事务成功但消息没发出去 | **本地消息表**：业务数据和消息记录同一事务写入，定时任务扫描未发送消息重发；或 RocketMQ **事务消息** |
| 消息重复投递 | 消费端**幂等**：唯一键约束、状态机、去重表，见 [幂等设计](/architecture/5_idempotence) |
| 消费失败 | 有限次重试 + 死信队列 + 人工 / 定时补偿 |
| 异步步骤失败需回滚 | Saga：每个步骤定义补偿操作（如取消订单 → 回补库存） |
| 状态长时间不一致 | 对账任务：定时比对上下游数据，发现差异自动修复或告警 |

本地消息表示例：

```java
@Transactional(rollbackFor = Exception.class)
public void createOrder(OrderCmd cmd) {
    orderMapper.insert(Order.from(cmd));
    // 同一事务写入消息表，保证"订单存在 ⇔ 消息存在"
    outboxMapper.insert(new OutboxMsg("order-created", cmd.getOrderNo(), JSON.toJSONString(cmd)));
}

// 定时任务（或 CDC 监听 outbox 表）投递消息，投递成功后标记已发送
@Scheduled(fixedDelay = 1000)
public void relay() {
    for (OutboxMsg msg : outboxMapper.selectPending(200)) {
        mqProducer.send(msg.getTopic(), msg.getKey(), msg.getPayload());
        outboxMapper.markSent(msg.getId());
    }
}
```

分布式事务的完整方案（2PC、TCC、Saga、事务消息）见 [分布式事务](/distributed/4_transaction)；消息不丢失、不重复、顺序性等可靠性保障见 [消息队列](/messaging/0_overview)。

---

## 七、设计清单

- [ ] 区分核心步骤与可异步步骤，主链路只保留必须同步完成的部分
- [ ] 异步接口有明确的结果查询方式（轮询 / 回调 / 推送）
- [ ] 消费端速率可控，且与下游容量匹配
- [ ] 消费逻辑幂等
- [ ] 有消息发送可靠性保障（本地消息表 / 事务消息）
- [ ] 有重试上限、死信队列与补偿 / 对账机制
- [ ] 监控消费延迟与积压，设置告警阈值

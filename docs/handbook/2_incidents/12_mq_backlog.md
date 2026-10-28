---
description: 消费者同步调用慢下游导致 Kafka 积压、lag 与成员状态排查、poll 超时踢出组、扩分区误区、Lag 告警
---

# MQ 消息积压

> 前置阅读：[消息队列基础](/messaging/1_basics#六、消息积压)、[Kafka 生产与消费](/messaging/2_kafka_client#_1、消息积压)

大促开场后履约消息积压 175 万条，根因是消费逻辑里新加的一次同步调用。本篇按现象到预防完整复盘，基线为 Spring Boot 4、Kafka 4（新消费者组协议）。

---

## 一、现象

10 月 5 日 14:00 order-service 发布了"履约前核销优惠券"功能，20:00 大促开场。履约消费组 `order-fulfil-group` 订阅 `order-created`（24 个分区），6 个 Pod × `concurrency=4` 共 24 个消费线程：

| 时间 | 告警 / 现象 |
|------|-------------|
| 20:06 | `KafkaConsumerLagHigh`：`order-fulfil-group` 总 lag 超过 5 万并持续 5 分钟，此时已达 70 万 |
| 20:08 | 客服反馈：用户下单成功 10 分钟仍显示"待接单"，仓库侧没收到履约单 |
| 20:09 | 应用日志反复出现 `consumer poll timeout has expired` 与分区撤销、重新分配 |
| 20:11 | lag 达到 128 万，生产速率约 2000 条/秒，消费速率只有约 35 条/秒 |

14:00–20:00 流量低，问题被掩盖：平峰时 coupon-service 响应约 15ms，单条处理约 20ms，24 个线程每秒能处理 1200 条，平峰 400 条/秒的流量消费得过来。

---

## 二、影响

- 20:00–20:26 下单的约 310 万笔订单履约延迟，最长延迟 15 分钟，仓库拣货排期整体后移，次日达承诺有 1.2 万单未兑现，按规则发放了补偿券
- 订单状态停留在"待接单"期间，约 3800 名用户取消订单后重新下单
- 消费者被反复踢出组，未提交的消息被重复处理，产生了 600 多张重复履约单，当时人工清理；消费端幂等缺陷的完整复盘见下一篇 [重复消费](./13_duplicate_consume)

---

## 三、排查过程

### 1、看 lag 分布：全部分区还是个别分区

```bash
bin/kafka-consumer-groups.sh --bootstrap-server kafka-0.kafka:9092 \
  --describe --group order-fulfil-group | sort -k3 -n | head -6
```

示例输出：

```text
GROUP              TOPIC          PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG    CONSUMER-ID                 HOST          CLIENT-ID
order-fulfil-group order-created  0          18822316        18875811        53495  kY3sZ0b2TpS9...             /10.1.4.21    consumer-order-fulfil-group-1
order-fulfil-group order-created  1          18794102        18847560        53458  Pq81xLmA0cRw...             /10.1.4.21    consumer-order-fulfil-group-2
order-fulfil-group order-created  2          18810953        18864481        53528  -                           -             -
order-fulfil-group order-created  3          18807419        18860955        53536  Ua2nVd7eQyHk...             /10.1.4.37    consumer-order-fulfil-group-1
order-fulfil-group order-created  4          18799870        18853302        53432  Zm0QeR5sL8wB...             /10.1.4.37    consumer-order-fulfil-group-2
```

24 个分区 lag 都在 5.3 万左右，而且很均匀：不是热点 key 或某条毒丸消息卡住了一个分区，是**整体消费能力下降**。分区 2 当时没有消费者（`-`），说明组成员在变动。

### 2、看组状态与成员

```bash
bin/kafka-consumer-groups.sh --bootstrap-server kafka-0.kafka:9092 \
  --describe --group order-fulfil-group --state
```

示例输出：

```text
GROUP              COORDINATOR (ID)          ASSIGNMENT-STRATEGY  STATE         #MEMBERS
order-fulfil-group kafka-2.kafka:9092  (2)   uniform              Reconciling   21
```

每隔几十秒执行一次，`#MEMBERS` 在 18–24 之间跳动，状态长期处于 `Reconciling`：成员不断被移出又重新加入。对应的应用日志（示例输出）：

```text
2026-10-05T20:09:14.502+08:00  WARN 1 --- [orderFulfil-2-C-1] o.a.k.c.c.internals.ConsumerMembershipManager : [Consumer clientId=consumer-order-fulfil-group-3, groupId=order-fulfil-group] consumer poll timeout has expired. This means the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms, which typically implies that the poll loop is spending too much time processing messages. You can address this either by increasing max.poll.interval.ms or by reducing the maximum size of batches returned in poll() with max.poll.records.
2026-10-05T20:09:15.977+08:00  INFO 1 --- [orderFulfil-2-C-1] o.s.k.l.KafkaMessageListenerContainer : order-fulfil-group: partitions assigned: [order-created-7]
```

一批 `max.poll.records=500` 条消息没在 `max.poll.interval.ms=300000`（5 分钟）内处理完，消费者被移出组；这批已处理的消息还没提交 offset，重新分配后从上次提交的位置再拉一遍。消费线程在原地打转，offset 几乎不前进。

### 3、看单条消息慢在哪

在一个 Pod 上附着 Arthas：

```bash
trace com.example.order.fulfil.OrderFulfilListener onMessage -n 3
```

示例输出：

```text
`---ts=2026-10-05 20:10:02;thread_name=orderFulfil-0-C-1;id=5e;is_daemon=false;priority=5;TCCL=...
    `---[1748.33ms] com.example.order.fulfil.OrderFulfilListener:onMessage()
        +---[2.61ms] com.example.order.fulfil.FulfilService:buildTask() #44
        +---[1741.07ms] com.example.order.coupon.CouponClient:verifyAndConsume() #47
        `---[3.12ms] com.example.order.fulfil.FulfilService:save() #49
```

99% 的时间花在 `CouponClient.verifyAndConsume`，即 14:00 新加的同步 HTTP 调用。再看 coupon-service 的客户端指标：

```bash
curl -s localhost:8081/actuator/metrics/http.client.requests?tag=uri:/api/coupons/verify-consume \
  | jq '.measurements'
```

示例输出：

```json
[
  {"statistic": "COUNT", "value": 1284610.0},
  {"statistic": "TOTAL_TIME", "value": 802331.42},
  {"statistic": "MAX", "value": 28.913}
]
```

平均 0.62 秒，最大 28.9 秒。coupon-service 在大促时自己也被下单流量压着，响应变慢；而 order-service 这个客户端**没有设置读超时**，慢请求能一直挂着。按平均 0.62 秒算，500 条一批就要 310 秒，超过 5 分钟的 poll 上限。

### 4、一个无效的操作：扩容 Pod

20:12 值班同学把 order-service 从 6 个 Pod 扩到 12 个，lag 毫无变化。再看一次 `--describe`：新增的 24 个消费线程没有分到任何分区。

::: tip 消费者数超过分区数无效
一个分区同一时刻只能被组内一个消费者消费。24 个分区已经配了 24 个线程，再加只会空转，还会多触发一轮重新分配。要扩消费能力，先看单条处理耗时，再考虑扩分区。
:::

---

## 四、根因

- **直接原因**：履约消费逻辑中新增了对 coupon-service 的同步调用，大促时该调用平均 0.62 秒，单线程消费能力从约 200 条/秒降到 2 条/秒以下（重做之后实际只有 1.5 条/秒左右）
- **放大因素**：
  - 客户端没有读超时，偶发的 20 秒以上慢请求让单批处理时间超过 `max.poll.interval.ms`，消费者被移出组、整批重做，有效消费速率进一步跌到约 35 条/秒
  - `max.poll.records` 沿用默认 500，批越大，越容易超过 poll 间隔上限
  - 核销优惠券本身不是履约的必要前置，却放进了履约主链路
- **为什么没提前发现**：功能在平峰发布，压测只覆盖下单接口，没有压消费链路；lag 告警阈值只看绝对值，没有看增长趋势

---

## 五、修复

### 1、止血

1. 20:14 在配置中心关闭 `order.fulfil.coupon-verify.enabled`，核销改为写入待处理表、由定时任务补做
2. 20:15 把 `max.poll.records` 调到 100 并滚动重启，消费者不再被踢出组
3. 20:16 将 order-service 缩回 6 个 Pod，避免多余的成员变动
4. 20:15 lag 到达峰值 175 万，之后消费速率回到约 4800 条/秒，净消化约 2800 条/秒，20:26 lag 归零

### 2、根治

**把非必要的下游调用移出消费主链路**：履约消费者只做履约；核销优惠券改由单独的消费组订阅同一 Topic，失败走重试与死信，互不拖累（见 [消息队列基础 · 重试与死信](/messaging/1_basics#七、重试与死信)）。

**所有远程调用都有超时**，并配熔断，下游变慢时快速失败而不是挂住消费线程：

```java
@Bean
RestClient couponRestClient(RestClient.Builder builder) {
    HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(200))
            .build();
    JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
    factory.setReadTimeout(Duration.ofMillis(500));          // 读超时，原来没有
    return builder.baseUrl("http://coupon-service").requestFactory(factory).build();
}
```

**消费参数与处理耗时匹配**：单批最长处理时间 = `max.poll.records` × 单条最坏耗时，必须明显小于 `max.poll.interval.ms`：

```yaml
spring:
  kafka:
    consumer:
      max-poll-records: 100              # 100 × 0.5s 超时上限 = 50s，远小于 300s
      properties:
        group.protocol: consumer
        max.poll.interval.ms: 300000
    listener:
      concurrency: 4
```

**分区数按峰值预留**：峰值 2000 条/秒、单线程按 150 条/秒估算需要 14 个线程，看似够用，但下游一抖单条耗时就会翻倍，24 个分区没有扩容空间；扩到 48 个分区，平时仍用 24 个线程，需要时可直接扩到 48（扩分区对 key 路由的影响见 [Kafka 架构与存储 · 增加分区](/messaging/2_kafka#_1、增加分区)）。

---

## 六、预防

**监控告警**：lag 同时看绝对值和增长趋势，再配消费速率与生产速率的比值（kafka_exporter 指标）：

```yaml
- alert: KafkaConsumerLagHigh
  expr: sum by (consumergroup) (kafka_consumergroup_lag{consumergroup="order-fulfil-group"}) > 50000
  for: 5m
  labels: {severity: critical}
- alert: KafkaConsumerLagGrowing
  expr: sum by (consumergroup) (deriv(kafka_consumergroup_lag{consumergroup="order-fulfil-group"}[5m])) > 200
  for: 3m
  labels: {severity: warning}
```

增长趋势告警在 20:03 就会触发，比实际告警早 3 分钟。成员数频繁变化（`#MEMBERS` 抖动、日志出现 `poll timeout has expired`）也应单独告警。

**代码规则**：

- 消费逻辑里新增远程调用要在评审中说明耗时、超时与失败处理，默认不允许同步调用非必要下游
- 所有 HTTP / RPC 客户端必须配置连接超时和读超时
- 修改消费逻辑的发布，同时评估 `max.poll.records` × 单条最坏耗时

**测试**：压测增加消费链路场景：按峰值速率向测试 Topic 灌消息，同时把下游 coupon-service 注入 500ms 延迟，观察 lag 是否收敛、成员是否稳定（见 [性能测试](/testing/7_performance_test)）。

---

## 七、涉及知识点

- 积压的排查与处置清单：[消息队列基础 · 消息积压](/messaging/1_basics#六、消息积压)
- Rebalance 触发条件与新消费者组协议：[Kafka 生产与消费 · Consumer Rebalance](/messaging/2_kafka_client#_2、consumer-rebalance)
- 失败重试与死信 Topic：[Kafka 生产与消费 · DefaultErrorHandler](/messaging/2_kafka_client#_2、defaulterrorhandler-deadletterpublishingrecoverer)
- 超时值怎么定：[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#一、超时)
- 削峰的系统设计：[异步与削峰](/high-con/4_async_peak_shaving)
- Arthas `trace`：[线上诊断](/engineering/7_diagnosis#_3、trace-拆解方法内部耗时)

---

## 小结

- 先看 lag 分布：所有分区均匀上涨是整体消费能力问题，个别分区上涨是热点或毒丸
- 组状态反复变动、日志出现 `poll timeout has expired`，说明单批处理超过 `max.poll.interval.ms`，消费者在原地重做
- 消费者数超过分区数无效；先降单条耗时，再扩分区
- 消费链路只放必要逻辑，远程调用必须有超时；lag 告警要看增长趋势

## 参考资料

- `kafka-consumer-groups.sh` 的用法：[Managing Consumer Groups — Apache Kafka Documentation](https://kafka.apache.org/documentation/#basic_ops_consumer_group)
- `max.poll.records`、`max.poll.interval.ms`、`group.protocol`：[Consumer Configs — Apache Kafka Documentation](https://kafka.apache.org/documentation/#consumerconfigs)
- 新消费者组协议：[KIP-848: The Next Generation of the Consumer Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol)
- 监听容器与错误处理：[Spring for Apache Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
- `JdkClientHttpRequestFactory` 与 RestClient：[REST Clients — Spring Framework](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)
- Lag 指标导出：[kafka_exporter](https://github.com/danielqsj/kafka_exporter)

> 下一篇：[重复消费](./13_duplicate_consume)

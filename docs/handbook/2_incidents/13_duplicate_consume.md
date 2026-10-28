---
description: 滚动发布强杀消费者导致整批重投、积分重复发放与短信重发、日志比对定位、同事务去重与条件更新
---

# 重复消费

> 前置阅读：[消息队列基础](/messaging/1_basics#四、幂等消费)、[幂等设计](/architecture/3_idempotence)

一次滚动发布后 4562 笔订单的积分和短信被重复发放，根因是消费不幂等、发布又强杀了消费者。本篇按现象到预防完整复盘，基线为 Spring Boot 4、Kafka 4、MySQL 8.4。

---

## 一、现象

10 月 8 日 14:02–14:11 order-service 滚动发布（6 个 Pod，`maxSurge=1`、`maxUnavailable=0`）。支付成功消费组 `order-paid-group` 订阅 `order-paid`（12 个分区），每个 Pod `concurrency=2`；每条消息依次做三件事：订单置为已支付、发放积分、调用短信服务发通知，单条约 45ms。

| 时间 | 告警 / 现象 |
|------|-------------|
| 14:20 | 客服工单激增：用户反映"付了一次款，收到两条支付成功短信" |
| 14:35 | 积分运营看板：当日积分发放量比前 7 日同时段高 38%，`ORDER_PAID` 类积分流水出现同一订单两条记录 |
| 14:40 | 短信服务账单告警：14:00–14:15 发送量比基线高 4500 条左右 |

这一次没有任何技术指标告警：接口正常、lag 正常、错误率为零。发现问题的是用户和运营。

---

## 二、影响

- 4562 笔订单被重复处理：重复发放积分合计 61.3 万（价值约 6130 元），重复发送支付成功短信 4562 条
- 其中 117 名用户在发现前已用重复积分抵扣下单，事后只能按规则核销，无法全部追回
- 订单状态无误：置为已支付的 `UPDATE` 执行两次结果相同，这也是该问题长期没被发现的原因
- 10 月 5 日积压事故中出现过的重复履约单（见 [MQ 消息积压](./12_mq_backlog)）是同一类缺陷，当时只做了人工清理

---

## 三、排查过程

### 1、确认范围：哪些订单被重复处理

```sql
SELECT DATE_FORMAT(created_at, '%H:%i') AS minute, COUNT(*) AS dup_orders
FROM (
  SELECT order_no, MIN(created_at) AS created_at
  FROM t_points_log
  WHERE biz_type = 'ORDER_PAID' AND created_at >= '2026-10-08 13:30:00'
  GROUP BY order_no HAVING COUNT(*) > 1
) d
GROUP BY minute ORDER BY minute;
```

示例输出：

```text
+--------+------------+
| minute | dup_orders |
+--------+------------+
| 14:02  |        402 |
| 14:03  |        377 |
| 14:04  |        611 |
| 14:05  |        798 |
| 14:06  |        583 |
| 14:07  |        690 |
| 14:08  |        455 |
| 14:09  |        309 |
| 14:10  |        207 |
| 14:11  |        130 |
+--------+------------+
10 rows in set (0.84 sec)
```

合计 4562 笔，全部集中在 14:02–14:11，与发布窗口完全重合，之前之后都没有。

### 2、确认是同一条消息被处理了两次

从日志平台按订单号检索（LogQL）：

```text
{app="order-service"} |= "O20261008140415227" |= "order-paid"
```

示例输出：

```text
2026-10-08T14:04:31.208+08:00 order-service-5f7c9-hx2lp  INFO [orderPaid-1-C-1] c.e.o.pay.OrderPaidListener : handled orderNo=O20261008140415227 partition=7 offset=3318820 msgId=8c1e0f2a-...
2026-10-08T14:05:36.644+08:00 order-service-7b4d2-r9wqs  INFO [orderPaid-0-C-1] c.e.o.pay.OrderPaidListener : handled orderNo=O20261008140415227 partition=7 offset=3318820 msgId=8c1e0f2a-...
```

同一个分区、同一个 offset、同一个 msgId，先后被旧 Pod 和新 Pod 各处理一次：不是上游重复发送，是**消费端重投**。

### 3、为什么会重投：旧 Pod 没来得及提交 offset

查看旧 Pod 停机前的最后几行日志：

```text
{pod="order-service-5f7c9-hx2lp"} |~ "shutdown|Shutdown|partitions"
```

示例输出：

```text
2026-10-08T14:04:22.016+08:00  INFO [ionShutdownHook] o.s.boot.tomcat.GracefulShutdown : Commencing graceful shutdown. Waiting for active requests to complete
2026-10-08T14:04:22.041+08:00  INFO [ionShutdownHook] o.s.boot.tomcat.GracefulShutdown : Graceful shutdown complete
2026-10-08T14:04:41.877+08:00  INFO [orderPaid-1-C-1] c.e.o.pay.OrderPaidListener : handled orderNo=O20261008140428361 partition=7 offset=3319041 ...
```

最后一条日志停在 14:04:41，之后既没有 `partitions revoked`，也没有容器停止的日志：进程是被强杀的。再看部署参数：

```bash
kubectl get deploy order-service -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{"\n"}{.spec.template.spec.containers[0].lifecycle.preStop}{"\n"}'
kubectl exec order-service-7b4d2-r9wqs -- printenv | grep -iE "MAX_POLL|ACK_MODE"
```

示例输出：

```text
30
{"sleep":{"seconds":10}}
SPRING_KAFKA_CONSUMER_MAX_POLL_RECORDS=500
```

时间线对上了：14:04:12 收到删除请求，preStop 睡 10 秒，14:04:22 JVM 收到 SIGTERM 开始关闭；监听容器要等手上这批消息处理完才提交 offset 并退出，而一批 500 条 × 45ms ≈ 22.5 秒，剩下的 20 秒不够；14:04:42 宽限期到，kubelet 发 SIGKILL。这批已经处理过的几百条消息 offset 没提交，分区交给新 Pod 后从上次提交的位置重新拉取。

平时 lag 为零，一次 poll 只拉到几条消息，强杀也只重投几条；但发布时第一个被强杀的 Pod 没有正常离开消费组，它的分区要等会话超时（Broker 端 `group.consumer.session.timeout.ms` 默认 45 秒）才转移，期间积累了上千条消息，接手的 Pod 一次就拉满 500 条，而它恰好是下一个被滚动替换的 Pod。整批重投就这样一个接一个传下去。

### 4、为什么重投会变成重复发放

```bash
# Arthas：确认线上运行的消费代码
jad --source-only com.example.order.pay.OrderPaidListener onMessage
```

示例输出（节选）：

```java
public void onMessage(OrderPaidEvent evt) {
    this.orderMapper.markPaid(evt.getOrderNo());                 // UPDATE t_order SET status='PAID' WHERE order_no=?
    this.pointsService.grant(evt.getUserId(), evt.getOrderNo(), evt.getAmount());
    this.smsClient.send(evt.getMobile(), "PAY_SUCCESS", evt.getOrderNo());
}
```

三步都没有幂等保护：

- `markPaid` 天然幂等，但不判断原状态，重复执行也"成功"，后面两步照常执行
- `grant` 插入积分流水并 `UPDATE ... SET points = points + ?`，`t_points_log` 上没有 `(biz_type, order_no)` 唯一键
- 短信直接调用，没有任何去重

代码注释里写着"生产者已开启幂等，不会重复"——生产者幂等只保证单分区内发送不重复，管不了消费端重投。

---

## 四、根因

- **根本原因**：支付成功消费逻辑不幂等，积分和短信两个有副作用的操作没有去重键，违反了"消息至少投递一次，消费端必须幂等"的前提
- **触发因素**：发布时 `terminationGracePeriodSeconds=30`，扣掉 preStop 的 10 秒，只剩 20 秒给应用关闭，小于一批 500 条消息的处理时间（约 22.5 秒），消费者被强杀、offset 未提交，整批重投
- **放大因素**：被强杀的消费者不会主动离开消费组，分区要等 45 秒会话超时才转移，积累的消息让下一批又拉满 500 条，重投在滚动发布中逐个传递
- **为什么没提前发现**：测试环境消息量小，每次只重投几条，而订单状态的 `UPDATE` 结果不变，掩盖了积分与短信的重复；对"生产者幂等 = 不会重复消费"存在误解

---

## 五、修复

### 1、止血

1. 14:45 冻结 order-service 的后续发布，直到修复版本上线
2. 15:30 按第一步的 SQL 导出重复订单，对每笔多发的积分写入一条 `ORDER_PAID_REVERSE` 冲正流水并扣回余额；已被使用的 117 笔转人工处理
3. 16:10 客服对收到重复短信的用户统一发送说明
4. 清理完成后在线加唯一键，先堵住积分重复：

```sql
ALTER TABLE t_points_log
  ADD UNIQUE KEY uk_biz_order (biz_type, order_no),
  ALGORITHM = INPLACE, LOCK = NONE;
```

冲正流水用了不同的 `biz_type`，不会与原流水冲突；加唯一键前必须确认已没有重复数据，否则 DDL 会失败。

### 2、根治

**去重记录与业务写入放在同一个本地事务**，业务失败则一起回滚，重投时可以再次处理（写法与原理见 [消息队列基础 · 方案一](/messaging/1_basics#_1、方案一-去重记录与业务写入在同一个本地事务-首选)）：

```java
@Transactional(rollbackFor = Exception.class)
public void onOrderPaid(OrderPaidEvent evt) {
    try {
        consumeRecordMapper.insert(evt.getOrderNo(), "ORDER_PAID");   // 主键 (biz_key, consumer)
    } catch (DuplicateKeyException e) {
        duplicateCounter.increment();                                  // 记录重投次数，供告警
        return;                                                        // 已处理过：正常返回，offset 照常提交
    }
    int rows = orderMapper.markPaid(evt.getOrderNo());                 // ... WHERE order_no = ? AND status = 'UNPAID'
    if (rows == 0) {
        return;                                                        // 状态已变更，不再触发后续动作
    }
    pointsService.grant(evt.getUserId(), evt.getOrderNo(), evt.getAmount());  // 唯一键兜底
    smsOutboxMapper.insert(evt.getOrderNo(), "PAY_SUCCESS", evt.getMobile()); // 短信写发件箱，同事务提交
}
```

- **去重键用业务键**（订单号 + 动作），不用 `partition + offset` 或 msgId，上游重发的消息也能拦住
- **状态条件更新**：`markPaid` 带上原状态条件，影响行数为 0 说明已处理过，见 [幂等设计 · 条件更新](/architecture/3_idempotence#四、条件更新-状态机与版本号)
- **短信走发件箱**：事务提交后由发件箱任务发送，`t_sms_outbox` 以 `(order_no, template)` 为唯一键，外部调用不再放在消费事务里

**停机时间与批大小匹配**：单批处理时间要明显小于应用可用的关闭时间：

```yaml
spring:
  kafka:
    consumer:
      max-poll-records: 50              # 50 × 45ms ≈ 2.3s
  lifecycle:
    timeout-per-shutdown-phase: 40s
```

同时把 `terminationGracePeriodSeconds` 调到 60 秒（preStop 10 秒 + 应用关闭 40 秒 + 余量 10 秒）。停机顺序的完整设计见 [优雅上下线与变更](/high-avail/8_graceful_release#_5、rpc-与消息消费)，发布时的流量摘除问题见下一篇。

::: tip 优雅停机只能减少重投，不能消灭重投
Pod 被驱逐、节点宕机、OOM 都会让消费者来不及提交 offset。Kafka 的语义是至少一次，幂等必须在消费端做，停机参数只是让重投规模变小。
:::

---

## 六、预防

**监控告警**：

- 去重命中计数 `order_consume_duplicate_total` 平时接近零，按分钟增量超过 50 告警：重投规模异常时第一时间知道，而不是等用户投诉
- 每日对账任务：按 `(biz_type, order_no)` 统计积分流水、短信发件箱的重复数，不为零即告警
- 发布期间关注消费组的成员变化和被强杀的 Pod（容器退出码 137）

**代码规则**：

- 每个消费者在评审时必须回答"同一条消息处理两次会怎样"；有副作用的操作必须有业务去重键和唯一约束兜底
- 消费逻辑中不直接调用短信、推送等外部系统，统一写发件箱
- `max.poll.records` × 单条最坏耗时，必须小于 `timeout-per-shutdown-phase`

**测试**：

- 集成测试用 Testcontainers 启动 Kafka 与 MySQL，把同一条消息连续发送两次、以及并发发送两次，断言积分只发一次、发件箱只有一条（见 [Testcontainers](/testing/5_testcontainers)）
- 预发环境做混沌演练：消费高峰时 `kubectl delete pod --grace-period=0 --force` 强杀消费者，验证对账结果为零重复（见 [混沌工程](/high-avail/10_chaos_engineering)）

---

## 七、涉及知识点

- 消费幂等的两种正确写法与常见错误：[消息队列基础 · 幂等消费](/messaging/1_basics#四、幂等消费)
- Kafka 下的重复来源与去重键：[Kafka 生产与消费 · 幂等消费](/messaging/2_kafka_client#_3、幂等消费)
- 唯一约束、条件更新、Token 等通用方案：[幂等设计](/architecture/3_idempotence)
- 生产者幂等与事务的边界：[Kafka 生产与消费 · 幂等生产者与事务](/messaging/2_kafka_client#三、幂等生产者与事务-exactly-once)
- 优雅停机与 Kubernetes 配合：[优雅上下线与变更](/high-avail/8_graceful_release#一、优雅停机)
- Arthas `jad`：[线上诊断](/engineering/7_diagnosis#_1、jad-确认运行的是哪份代码)

---

## 小结

- 重复消费是常态不是意外：重投来自强杀、Rebalance、上游重发，消费端必须幂等
- 排查先用业务数据圈定范围和时间，再用日志比对 partition、offset、msgId 区分"消费端重投"与"上游重发"
- 根治靠"同事务去重记录 + 唯一键 + 状态条件更新 + 外部调用走发件箱"
- 停机宽限期、`timeout-per-shutdown-phase` 与批处理时间要匹配，但它只决定重投规模

## 参考资料

- 消费者位移提交与投递语义：[Message Delivery Semantics — Apache Kafka Documentation](https://kafka.apache.org/documentation/#semantics)
- 会话超时等组配置：[Broker Configs — Apache Kafka Documentation](https://kafka.apache.org/documentation/#brokerconfigs)
- 监听容器停止与提交：[Spring for Apache Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
- `spring.lifecycle.timeout-per-shutdown-phase`：[Graceful Shutdown — Spring Boot](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)
- 终止宽限期与 preStop：[Pod Lifecycle — Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- 在线加索引：[Online DDL Operations — MySQL 8.4 Reference Manual](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)

> 下一篇：[发布时 502](./14_release_502)

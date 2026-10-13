---
description: 单条大 DELETE 致复制延迟、SHOW REPLICA STATUS、写后读主、按延迟摘除从库
---

# 主从延迟读到旧数据

> 前置阅读：[MySQL 主从与高可用](/database/1_mysql/9_topic_replication)、[数据层扩展](/high-con/5_data_scaling)

用户支付成功后跳回订单详情，页面却一直显示"待支付"，部分用户因此重复支付。根因是详情查询走了从库，而一次单语句清理大表让从库延迟最高到了 14 分钟。本篇按现象、排查、根因、修复、预防完整复盘，基线为 JDK 21、Spring Boot 4、MySQL 8.4（GTID 复制，一主两从）。

---

## 一、现象

10 月 8 日 21:00 起，客服陆续收到"付了钱订单还是待支付"的投诉。

| 时间 | 告警 / 现象 |
|------|-------------|
| 21:04 | 客服工单激增：20 分钟内 230 单"已支付仍显示待支付" |
| 21:06 | `PayDuplicateHigh`：同一订单 10 分钟内出现第二笔成功支付，累计 37 笔 |
| 21:06 | `MySQLReplicaLagHigh`：从库 db-replica-1 / db-replica-2 的 `Seconds_Behind_Source` 分别为 386、371 |
| 21:07 | 主库 CPU 22%，从库 CPU 一个核满载、其余空闲；应用接口 RT 和错误率均正常 |

接口全部成功、RT 正常，只是**数据旧**——这类故障不会触发常规的错误率告警，最早发现的往往是用户。

---

## 二、影响

- 21:00–21:27 约 1.2 万名用户在支付后看到旧状态，订单详情、"我的订单"列表均受影响
- 37 笔重复支付，事后全部原路退款，并逐一电话致歉
- 商家后台基于从库的"今日成交额"少算最多十余分钟的数据，晚间战报推迟发布

---

## 三、排查过程

### 1、确认主从数据不一致

拿一笔投诉订单分别查主库和从库：

```sql
-- 主库
SELECT id, status, pay_time, update_time FROM t_order WHERE order_no = 'O2026100821031188';
-- 从库
SELECT id, status, pay_time, update_time FROM t_order WHERE order_no = 'O2026100821031188';
```

示例输出：

```text
-- 主库
+-----------+--------+---------------------+---------------------+
| id        | status | pay_time            | update_time         |
+-----------+--------+---------------------+---------------------+
| 418827735 |      3 | 2026-10-08 21:03:20 | 2026-10-08 21:03:20 |
+-----------+--------+---------------------+---------------------+
-- 从库
+-----------+--------+----------+---------------------+
| id        | status | pay_time | update_time         |
+-----------+--------+----------+---------------------+
| 418827735 |      1 | NULL     | 2026-10-08 21:03:11 |
+-----------+--------+----------+---------------------+
```

主库已是"已支付"（3），从库还是"待支付"（1）。数据最终会一致，问题是"现在"不一致。

### 2、看复制状态

```sql
SHOW REPLICA STATUS\G
```

示例输出（节选）：

```text
             Replica_IO_State: Waiting for source to send event
           Replica_IO_Running: Yes
          Replica_SQL_Running: Yes
        Seconds_Behind_Source: 386
          Read_Source_Log_Pos: 734118204
          Exec_Source_Log_Pos: 102664017
              Relay_Log_Space: 2251873360
    Replica_SQL_Running_State: Applying batch of row changes (delete)
           Retrieved_Gtid_Set: 3e11fa47-71ca-11ef-9b1a-0242ac120002:1-918274661
            Executed_Gtid_Set: 3e11fa47-71ca-11ef-9b1a-0242ac120002:1-918201377
```

- IO 线程和 SQL 线程都在运行，没有复制错误，排除"复制断了"
- `Read_Source_Log_Pos` 远大于 `Exec_Source_Log_Pos`、中继日志 2.1GB：binlog 已经拉过来了，**卡在回放**
- 回放状态是 `Applying batch of row changes (delete)`：正在回放一个大批量删除
- `Retrieved_Gtid_Set` 与 `Executed_Gtid_Set` 相差约 7.3 万个事务在排队

### 3、谁卡住了回放

```sql
SELECT worker_id, applying_transaction, applying_transaction_start_apply_timestamp,
       last_applied_transaction
FROM performance_schema.replication_applier_status_by_worker;
```

示例输出（节选）：

```text
+-----------+-------------------------------------------------+--------------------------------------------+---------------------------------------------------+
| worker_id | applying_transaction                            | applying_transaction_start_apply_timestamp | last_applied_transaction                          |
+-----------+-------------------------------------------------+--------------------------------------------+---------------------------------------------------+
|         1 | 3e11fa47-71ca-11ef-9b1a-0242ac120002:918201378  | 2026-10-08 21:01:37.118207                 | 3e11fa47-71ca-11ef-9b1a-0242ac120002:918201376    |
|         2 |                                                 | 0000-00-00 00:00:00.000000                 | 3e11fa47-71ca-11ef-9b1a-0242ac120002:918201377    |
|         3 |                                                 | 0000-00-00 00:00:00.000000                 | 3e11fa47-71ca-11ef-9b1a-0242ac120002:918201375    |
|         4 |                                                 | 0000-00-00 00:00:00.000000                 | 3e11fa47-71ca-11ef-9b1a-0242ac120002:918201374    |
+-----------+-------------------------------------------------+--------------------------------------------+---------------------------------------------------+
```

4 个回放 worker（`replica_parallel_workers` 默认 4）里只有 worker 1 在干活，从 21:01:37 开始回放事务 `...:918201378`，其余空闲。多线程回放能并行的是**不同事务**，单个事务只能由一个 worker 串行执行；而 `replica_preserve_commit_order` 默认开启，后面的事务即使回放完也要等它先提交。

### 4、这个事务是什么

在主库上解析对应 GTID 的 binlog：

```bash
mysqlbinlog --include-gtids='3e11fa47-71ca-11ef-9b1a-0242ac120002:918201378' \
  --base64-output=DECODE-ROWS -v binlog.004127 | grep -c '^### DELETE FROM `order_db`.`t_order_log`'
```

示例输出：

```text
4812377
```

一个事务删了 `t_order_log` 481 万行。对应到应用：order-job 服务 21:00 的"操作日志归档"任务，新版本把"按天循环删除"改成了一条语句：

```sql
DELETE FROM t_order_log WHERE create_time < '2026-07-01';
```

主库上这条语句执行约 95 秒，但它在 binlog 里是**一个**事务、481 万个行事件（`binlog_row_image=FULL`），从库只能单线程逐行回放，加上回放期间新的写入不断堆积，延迟从 0 一路涨到最高约 14 分钟（21:14 这个事务回放完，之后又用了十几分钟追平积压）。

### 5、为什么详情页会读从库

```bash
[arthas@1]$ watch com.example.order.infra.ds.RoutingDataSource determineCurrentLookupKey '{returnObj}' -n 3
```

示例输出：

```text
method=com.example.order.infra.ds.RoutingDataSource.determineCurrentLookupKey location=AtExit
ts=2026-10-08 21:12:41.207; [cost=0.012ms] result=@ArrayList[
    @String[replica],
]
```

订单服务用 `AbstractRoutingDataSource` 做读写分离：`@Transactional(readOnly = true)` 的方法一律路由到从库。订单详情接口就是只读方法，支付回调写主库后，用户紧接着刷新详情，读到的是延迟中的从库。

---

## 四、根因

1. **业务假设"从库是实时的"**：写后立即读（支付后看订单）的场景路由到从库，平时延迟不到 1 秒没暴露问题
2. **单个大事务打穿复制**：归档任务改成单语句删除 481 万行，从库无法并行回放，延迟最高 14 分钟
3. **没有延迟感知**：从库延迟十几分钟时，读写分离仍照常把流量分给它
4. **支付入口防重只看从库状态**：收银台用详情接口判断"是否已支付"，旧数据直接导致重复支付

---

## 五、修复

### 1、止血

- 21:10 暂停 order-job 的归档任务（不中断正在回放的事务，否则从库也要等它完成）
- 21:12 配置中心打开 `order.read.force-primary=true`，订单服务所有读请求临时走主库（主库 CPU 22%，有余量承接）
- 21:13 收银台"是否已支付"判断改为直接查支付单（主库），重复支付止住
- 21:27 从库回放完成，延迟回落到 1 秒内；21:40 关闭强制读主

### 2、根治

**写后读走主库**：支付、下单、取消等写操作完成后，给该用户打一个短时"读主"标记，标记期内的读请求路由到主库：

```java
public class RoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        if (!TransactionSynchronizationManager.isCurrentTransactionReadOnly()) return "primary";
        if (ReadPrimaryContext.forced()) return "primary";                 // @ReadPrimary 注解或写后标记
        return replicaHealth.anyHealthy() ? "replica" : "primary";        // 从库全部延迟超标时回落主库
    }
}

// 写操作成功后：该用户 5 秒内的读走主库（Redis 短 TTL 标记，多 Pod 共享）
redis.opsForValue().set("rp:" + userId, "1", Duration.ofSeconds(5));
```

支付状态、库存、余额等"必须读到最新值"的查询加 `@ReadPrimary`，无论是否有写后标记都走主库。

**按延迟摘除从库**：每 2 秒检测一次各从库延迟，超过 3 秒就从读池中摘除，恢复后再加回：

```java
@Scheduled(fixedDelay = 2000)
void checkLag() {
    for (Replica r : replicas) {
        Long lag = r.jdbc().queryForObject(
            "SELECT TIMESTAMPDIFF(SECOND, ts, NOW(3)) FROM ops.heartbeat WHERE id = 1", Long.class);
        replicaHealth.mark(r.name(), lag != null && lag <= 3);
    }
}
```

心跳表由主库每秒更新一行时间戳，比 `Seconds_Behind_Source` 更可靠（后者在回放空闲、网络慢或多线程回放时都可能失真）。

**归档任务分批**：按主键范围每批删 2,000 行、每批独立提交，批间检查从库延迟，超过 2 秒就暂停：

```sql
DELETE FROM t_order_log WHERE id BETWEEN ? AND ? AND create_time < '2026-07-01';
```

---

## 六、预防

**监控告警**：

- 心跳表延迟 > 3 秒持续 1 分钟告警，> 30 秒升级为 P1
- 主库单事务 binlog 大小超过 100MB 告警（可在 binlog 解析或 CDC 链路统计），提前发现会打穿复制的大事务
- 业务指标：同一订单短时间内重复支付笔数，作为数据一致性问题的兜底信号

**代码规范**：

- 读写分离默认读主，只有明确能接受秒级旧数据的查询（报表、列表、搜索）才标注读从库
- 写后读、状态判断、防重校验必须读主库或带版本号校验
- 批量 `DELETE` / `UPDATE` 按主键分批，单批不超过 5,000 行，且必须带"从库延迟超标即暂停"的保护

**测试**：预发环境用 `CHANGE REPLICATION SOURCE TO SOURCE_DELAY = 10` 人为制造 10 秒延迟，回归"支付后查看订单""下单后查看列表"等写后读场景，断言状态正确。

---

## 七、涉及知识点

- 复制原理、并行回放与延迟成因：[MySQL 主从与高可用](/database/1_mysql/9_topic_replication#五、复制延迟与多线程回放)
- 读写分离方案与一致性：[MySQL 主从与高可用](/database/1_mysql/9_topic_replication#七、读写分离)、[数据层扩展](/high-con/5_data_scaling)
- 读写分离多数据源配置：[数据库连接池](/database/5_practice/3_connection_pool)
- 大事务的危害与分批改造：[大事务锁表](./7_big_transaction)
- 缓存场景下的同类问题：[缓存一致性](/cache/10_cache_consistency)
- Arthas `watch` 的用法：[线上诊断](/engineering/7_diagnosis)

---

## 小结

- 接口全成功、RT 正常但数据是旧的，先怀疑读到了从库或缓存
- `SHOW REPLICA STATUS` 看 IO / SQL 线程是否运行，再对比读到和执行到的位置，判断卡在拉取还是回放
- `replication_applier_status_by_worker` 能看到哪个 worker 在回放哪个事务；单个大事务无法并行回放
- 写后读走主库、按真实延迟摘除从库，是读写分离必须配套的两件事
- 批量删除改为分批提交，并以从库延迟作为节流信号

## 参考资料

- 复制状态字段与 `Seconds_Behind_Source` 的局限：[MySQL 8.4 Reference Manual: SHOW REPLICA STATUS Statement](https://dev.mysql.com/doc/refman/8.4/en/show-replica-status.html)
- 回放 worker 状态表：[MySQL 8.4 Reference Manual: The replication_applier_status_by_worker Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-replication-applier-status-by-worker-table.html)
- `replica_parallel_workers`、`replica_preserve_commit_order`：[MySQL 8.4 Reference Manual: Replica Server Options and Variables](https://dev.mysql.com/doc/refman/8.4/en/replication-options-replica.html)
- 按 GTID 解析 binlog：[MySQL 8.4 Reference Manual: mysqlbinlog](https://dev.mysql.com/doc/refman/8.4/en/mysqlbinlog.html)
- 延迟复制 `SOURCE_DELAY`：[MySQL 8.4 Reference Manual: Delayed Replication](https://dev.mysql.com/doc/refman/8.4/en/replication-delayed.html)
- 路由数据源：[Spring Framework API: AbstractRoutingDataSource](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/jdbc/datasource/lookup/AbstractRoutingDataSource.html)

> 下一篇：[深分页拖垮数据库](./9_deep_paging)

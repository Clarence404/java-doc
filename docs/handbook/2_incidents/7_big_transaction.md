---
description: 无索引批量 UPDATE 锁全表、锁等待定位、KILL 与回滚、分批短事务改造
---

# 大事务锁表

> 前置阅读：[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)、[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)

运营在后台点了一次"批量关闭活动订单"，一个持续 14 分钟的大事务把订单表几乎整张锁住，下单和支付回调全部锁等待超时。本篇按现象、排查、根因、修复、预防完整复盘，基线为 JDK 21、Spring Boot 4、MySQL 8.4（隔离级别 REPEATABLE READ）。

---

## 一、现象

10 月 3 日 14:21，运营在后台对已下线的活动 7788 执行"批量关闭未支付订单"。`t_order` 约 4,100 万行，主键自增。

| 时间 | 告警 / 现象 |
|------|-------------|
| 14:22 | `MySQLRowLockWaitsHigh`：`Innodb_row_lock_current_waits` 从 0 升到 260+ |
| 14:23 | `HttpP99High`：下单接口 P99 升到 50s，与 `innodb_lock_wait_timeout` 默认值 50 秒吻合 |
| 14:24 | `PayCallbackFailRate`：支付回调失败率 100%，日志全部是锁等待超时 |
| 14:25 | 主库 `History list length` 持续上涨，CPU 只有 35%，没有慢查询堆积 |

应用日志：

```text
2026-10-03T14:23:41.902+08:00 ERROR 1 --- [io-8080-exec-211] c.e.order.pay.PayCallbackService : pay callback failed, orderNo=O2026100314221735
org.springframework.dao.CannotAcquireLockException:
### Error updating database.  Cause: com.mysql.cj.jdbc.exceptions.MySQLTransactionRollbackException: Lock wait timeout exceeded; try restarting transaction
### SQL: UPDATE t_order SET status = ?, pay_time = ?, update_time = ? WHERE id = ? AND status = ?
```

和上一篇的"慢 SQL"不同：数据库 CPU 不高、SQL 本身很简单，请求是在**等锁**。

---

## 二、影响

- 14:22–14:39 共 17 分钟，下单基本不可用（新订单的 `INSERT` 也被阻塞），约 3.6 万笔下单失败
- 支付回调失败约 5,200 笔，依赖渠道重试补回；其中 41 笔超过渠道重试窗口，由对账任务次日补单
- 连接池被等锁的事务占满，订单查询类接口也连带超时

---

## 三、排查过程

### 1、谁在等谁

MySQL 8.4 的 `sys.innodb_lock_waits` 直接给出等待方和阻塞方：

```sql
SELECT wait_age, locked_table_name, locked_index, locked_type,
       waiting_query, blocking_pid, blocking_query, sql_kill_blocking_connection
FROM sys.innodb_lock_waits ORDER BY wait_age DESC LIMIT 3\G
```

示例输出（节选）：

```text
*************************** 1. row ***************************
                    wait_age: 00:00:48
           locked_table_name: t_order
                locked_index: PRIMARY
                 locked_type: RECORD
               waiting_query: UPDATE t_order SET status = 3, pay_time = '2026-10-03 14:22:53' ...
                blocking_pid: 918274
              blocking_query: NULL
sql_kill_blocking_connection: KILL 918274
*************************** 2. row ***************************
                    wait_age: 00:00:47
           locked_table_name: t_order
                locked_index: PRIMARY
                 locked_type: RECORD
               waiting_query: INSERT INTO t_order (order_no, user_id, merchant_id, ...
                blocking_pid: 918274
              blocking_query: NULL
sql_kill_blocking_connection: KILL 918274
```

所有等待的阻塞方都是同一个连接 918274；`blocking_query` 为 `NULL`，说明它此刻没有在执行 SQL——事务开着，人却"在别处忙"。

### 2、阻塞方的事务有多大

```sql
SELECT trx_id, trx_state, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s,
       trx_rows_locked, trx_rows_modified, trx_lock_structs, trx_mysql_thread_id
FROM information_schema.innodb_trx
WHERE trx_mysql_thread_id = 918274\G
```

示例输出：

```text
*************************** 1. row ***************************
             trx_id: 48817230095
          trx_state: RUNNING
        trx_started: 2026-10-03 14:21:07
              age_s: 497
    trx_rows_locked: 41208533
  trx_rows_modified: 186402
   trx_lock_structs: 312877
trx_mysql_thread_id: 918274
```

事务已运行 8 分多钟，**锁了 4,120 万行**（几乎是整张表），只修改了 18.6 万行。锁的行数远多于改的行数，典型的"无索引条件导致全表加锁"。

::: tip 注意
`performance_schema.data_locks` 能看到每一把锁的明细，但本例有几千万把锁，全量查询本身就会给主库带来很大压力。大事务场景先看 `innodb_trx` 的汇总数字，明细只按 `ENGINE_TRANSACTION_ID` 加 `LIMIT` 抽样。
:::

### 3、这个连接执行过什么

```sql
SELECT t.processlist_host, t.processlist_user, h.event_id, LEFT(h.sql_text, 120) AS sql_text
FROM performance_schema.threads t
JOIN performance_schema.events_statements_history h ON h.thread_id = t.thread_id
WHERE t.processlist_id = 918274 ORDER BY h.event_id;
```

示例输出（节选）：

```text
+------------------+------------------+----------+------------------------------------------------------------------------------+
| processlist_host | processlist_user | event_id | sql_text                                                                     |
+------------------+------------------+----------+------------------------------------------------------------------------------+
| 10.42.7.31:52814 | order_admin      |   771203 | UPDATE t_order SET status = 9, update_time = NOW() WHERE activity_id = 7788 AND status = 1 |
| 10.42.7.31:52814 | order_admin      |   771204 | INSERT INTO t_order_log (order_id, action, operator, ...) VALUES (...)       |
| 10.42.7.31:52814 | order_admin      |   771205 | INSERT INTO t_order_log (order_id, action, operator, ...) VALUES (...)       |
+------------------+------------------+----------+------------------------------------------------------------------------------+
```

来源 IP 是 order-admin 服务的 Pod；第一条语句就是批量关单，后面是逐条写日志。

### 4、为什么一条 UPDATE 会锁住整张表

```sql
EXPLAIN UPDATE t_order SET status = 9 WHERE activity_id = 7788 AND status = 1;
```

示例输出：

```text
+----+-------------+---------+------+---------------+------+---------+------+----------+-------------+
| id | select_type | table   | type | possible_keys | key  | key_len | rows     | filtered | Extra       |
+----+-------------+---------+------+---------------+------+---------+------+----------+-------------+
|  1 | UPDATE      | t_order | ALL  | NULL          | NULL | NULL    | 40812345 |     1.00 | Using where |
+----+-------------+---------+------+---------------+------+---------+------+----------+-------------+
```

`activity_id` 没有索引，`type=ALL` 全表扫描。在 REPEATABLE READ 下，InnoDB 会给**扫描过的每一行**加 next-key 锁，并锁住主键末尾的 supremum 间隙，所以不仅更新已有订单会冲突，自增主键的新订单 `INSERT` 也被挡住。

### 5、事务为什么迟迟不提交

用 Arthas 附着 order-admin，找到执行任务的线程并看它的栈：

```bash
[arthas@1]$ thread | grep batch-close
[arthas@1]$ thread 87
```

示例输出（节选）：

```text
 87   batch-close-1     main      5    RUNNABLE   0.31    0.000   8:52.104  false  false
"batch-close-1" Id=87 RUNNABLE (in native)
    at java.base@21.0.8/sun.nio.ch.SocketDispatcher.read0(Native Method)
    ...
    at com.example.admin.client.StockClient.release(StockClient.java:37)
    at com.example.admin.order.BatchCloseService.closeByActivity(BatchCloseService.java:52)
    at com.example.admin.order.BatchCloseService$$SpringCGLIB$$0.closeByActivity(<generated>)
    ...
```

线程已运行近 9 分钟，此刻正在 `@Transactional` 方法里等库存服务的 HTTP 响应。

对照代码：

```java
@Transactional
public void closeByActivity(long activityId) {
    orderMapper.closeUnpaidByActivity(activityId);                 // 全表加锁，耗时约 40 秒
    for (Order o : orderMapper.listClosedByActivity(activityId)) { // 18.6 万笔
        stockClient.release(o.getSkuId(), o.getQuantity());        // 远程 HTTP 调用，约 4ms / 次
        orderLogMapper.insert(OrderLog.closed(o.getId(), "ops"));
    }
}                                                                  // 全部完成才提交
```

18.6 万次远程调用加 18.6 万次插入，估算总耗时 14 分钟以上，锁全程不释放。

---

## 四、根因

1. **UPDATE 条件无索引**：`activity_id` 未建索引，在 REPEATABLE READ 下扫描全表并对每行加锁，效果等同锁表
2. **一个事务包住整个批量任务**：`@Transactional` 加在整个方法上，18.6 万笔的处理（含远程调用）在同一个事务里，锁持有时间 = 任务总时长
3. **事务里有远程调用**：库存释放走 HTTP，事务时长受下游影响，且远程调用失败时事务回滚也撤不回已释放的库存
4. **运营操作没有防护**：后台批量操作不限量、不预估影响行数，也没有在业务低峰执行

---

## 五、修复

### 1、止血

- 14:31 先停止任务调度入口（配置中心关闭"批量关单"开关），防止被重复触发
- 14:32 评估：事务已修改 18.6 万行，回滚需撤销这些修改；剩余工作量约 6 分钟，而回滚通常更快且确定。决定 `KILL 918274`
- 14:32–14:36 回滚期间锁仍未释放（`trx_state` 显示 `ROLLING BACK`），这段时间只能等待，**不要重启 MySQL**，重启后崩溃恢复同样要完成回滚，耗时更长
- 14:39 锁等待清零，下单恢复；被回滚的关单由修复后的任务夜间重跑

::: warning 注意
应用侧的线程被打断或 Pod 被删掉，并不会立刻结束数据库里的事务：连接断开后 MySQL 才会回滚，期间锁照样持有。止血要在数据库侧 `KILL` 对应连接。
:::

### 2、根治

**补索引**：

```sql
ALTER TABLE t_order ADD INDEX idx_activity_status (activity_id, status), ALGORITHM = INPLACE, LOCK = NONE;
```

**拆成分批短事务，远程调用移出事务**：

```java
public void closeByActivity(long activityId) throws InterruptedException {
    long lastId = 0;
    while (true) {
        // 按主键游标分页取 500 条待关闭订单（走 idx_activity_status，不加锁的快照读）
        List<Long> ids = orderMapper.findUnpaidIds(activityId, lastId, 500);
        if (ids.isEmpty()) break;
        // 每批一个短事务：只做本库的状态更新和日志写入
        transactionTemplate.executeWithoutResult(s -> {
            orderMapper.closeByIds(ids, OrderStatus.UNPAID);   // WHERE id IN (...) AND status = 1
            orderLogMapper.batchInsert(OrderLog.closed(ids, "ops"));
        });
        // 事务提交后发事件，由库存服务异步释放（本地消息表保证不丢）
        eventPublisher.publishOrdersClosed(ids);
        lastId = ids.getLast();
        Thread.sleep(50);                                      // 给在线流量让路
    }
}
```

改造后每批事务约 30ms，锁只持有在 500 行上，任务期间下单 P99 无明显波动。

---

## 六、预防

**监控告警**：每 30 秒采集一次长事务，超过 60 秒告警并附带 `trx_rows_locked`：

```sql
SELECT trx_mysql_thread_id, trx_started, trx_rows_locked, trx_rows_modified
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 60 SECOND;
```

同时对 `Innodb_row_lock_current_waits > 20` 持续 1 分钟、`History list length` 持续上涨设置告警。

**代码规范**：

- `@Transactional` 方法内禁止远程调用、MQ 同步发送、文件操作；跨服务的后续动作用事务提交后事件或本地消息表
- 批量 `UPDATE` / `DELETE` 必须走索引，按主键分批，每批不超过 1,000 行
- 后台批量操作先展示预估影响行数，超过阈值需二次确认，并只允许在低峰时段执行
- 运维与后台账号的会话开启 `sql_safe_updates`，拒绝不带键条件也不带 `LIMIT` 的 `UPDATE` / `DELETE`

**测试**：用 Testcontainers 启动 MySQL 8.4，对批量类 SQL 执行 `EXPLAIN`，断言 `type` 不为 `ALL`；再写一个并发测试，在批量任务执行时并发下单，断言下单 P99 低于 200ms。

---

## 七、涉及知识点

- 行锁、next-key 锁与长事务：[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)
- `EXPLAIN` 与全表扫描：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)
- 索引设计：[MySQL 索引](/database/1_mysql/4_topic_index)
- 事务提交后事件与本地消息表：[分布式事务](/distributed/4_transaction)
- 常见 MySQL 坑：[MySQL 避坑指南](/database/1_mysql/3_fallible_point)
- 故障止血与复盘流程：[故障应急与复盘](/high-avail/11_incident_response)

---

## 小结

- "CPU 不高、SQL 很简单、RT 正好卡在 50 秒"是锁等待的典型画像
- `sys.innodb_lock_waits` 找阻塞方，`innodb_trx` 看事务多大、开了多久，`blocking_query` 为空说明事务开着却在做别的事
- 无索引的 `UPDATE` 在 REPEATABLE READ 下会锁住扫描过的所有行，等同锁表
- `KILL` 大事务要等回滚完成才释放锁，不要指望重启数据库更快
- 根治靠"走索引 + 分批短事务 + 远程调用移出事务"

## 参考资料

- 各类语句加锁规则：[MySQL 8.4 Reference Manual: Locks Set by Different SQL Statements in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- 锁等待视图：[MySQL 8.4 Reference Manual: The innodb_lock_waits View](https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html)
- 事务信息表：[MySQL 8.4 Reference Manual: The INFORMATION_SCHEMA INNODB_TRX Table](https://dev.mysql.com/doc/refman/8.4/en/information-schema-innodb-trx-table.html)
- 锁明细表：[MySQL 8.4 Reference Manual: The data_locks Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- `innodb_lock_wait_timeout`：[MySQL 8.4 Reference Manual: InnoDB Startup Options and System Variables](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html)
- `sql_safe_updates`：[MySQL 8.4 Reference Manual: mysql Client Tips](https://dev.mysql.com/doc/refman/8.4/en/mysql-tips.html)
- 编程式事务：[Spring Framework: Programmatic Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html)

> 下一篇：[主从延迟读到旧数据](./8_replica_lag)

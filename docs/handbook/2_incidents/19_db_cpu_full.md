---
description: 发版后 MySQL CPU 打满、线程 ID 对应 SQL、digest 找 Top SQL、隐式类型转换致全表扫描
---

# 数据库 CPU 被打满

> 前置阅读：[MySQL 排查速查](/handbook/1_cheatsheet/5_mysql)、[MySQL 索引](/database/1_mysql/4_topic_index)

支付服务发版后，共享 MySQL 主库 CPU 被打到 100%，同库服务一起变慢。本篇复盘从实例指标、线程到 SQL 的定位过程，基线为 JDK 21、Spring Boot 4、MySQL 8.4。

---

## 一、现象

9 月 30 日 14:00 pay-service 发版（滚动发布 10 分钟完成）。实例 mysql-trade-01（16 核 64GB 虚拟机自建，一主两从，主库承载 pay、order、member 三个服务）随后告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 14:06 | `MysqlCpuHigh`：主库 CPU 使用率 97%，持续 3 分钟 |
| 14:08 | `MysqlThreadsRunningHigh`：`Threads_running` 从平时 8 左右升到 290 |
| 14:10 | `HttpP99High`：pay-service 支付回调接口 P99 从 40ms 升到 9s；order-service 下单 P99 升到 3s |
| 14:13 | `HikariPendingHigh`：三个服务的连接池等待线程数均超过 50 |

QPS 只比平时高 6%，没有流量突增；`Innodb_rows_read` 速率从平时约 4 万行/秒涨到约 8400 万行/秒。

---

## 二、影响

- 14:06–14:38 共 32 分钟，支付回调处理成功率最低 71%，支付渠道按策略重试回调，没有丢单，但约 1.1 万笔订单「已付款未更新状态」平均延迟 6 分钟
- 下单接口成功率最低 93%，会员积分查询大面积超时
- 无数据错乱：回调逻辑幂等，渠道重试后状态最终一致

---

## 三、排查过程

### 1、先看实例层：是忙在计算还是在等

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN
  ('Threads_running', 'Threads_connected', 'Innodb_rows_read', 'Innodb_row_lock_current_waits');
```

示例输出：

```text
+-------------------------------+--------------+
| Variable_name                 | Value        |
+-------------------------------+--------------+
| Innodb_row_lock_current_waits | 0            |
| Innodb_rows_read              | 918273645512 |
| Threads_connected             | 612          |
| Threads_running               | 287          |
+-------------------------------+--------------+
```

`Threads_running` 很高但没有行锁等待；主机上 `iostat` 的 `%util` 只有 12%，数据都在 Buffer Pool 里：CPU 花在**大量扫描内存中的行**上，不是锁或磁盘问题。

### 2、从最忙的系统线程找到 SQL

MySQL 是单进程多线程，`top -H` 能看到哪些线程最耗 CPU，再用 `THREAD_OS_ID` 对回 SQL：

```bash
top -H -b -n1 -p $(pidof mysqld) | head -12
```

```text
    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
  48213 mysql     20   0   68.1g  51.2g  38212 R  99.0  80.1   4:12.37 connection
  48190 mysql     20   0   68.1g  51.2g  38212 R  98.7  80.1   4:09.81 connection
  48244 mysql     20   0   68.1g  51.2g  38212 R  98.3  80.1   3:58.02 connection
```

```sql
SELECT t.THREAD_OS_ID, t.PROCESSLIST_ID, t.PROCESSLIST_USER, t.PROCESSLIST_TIME,
       LEFT(t.PROCESSLIST_INFO, 120) AS sql_text
FROM performance_schema.threads t
WHERE t.THREAD_OS_ID IN (48213, 48190, 48244);
```

```text
+--------------+----------------+------------------+------------------+------------------------------------------------------------------+
| THREAD_OS_ID | PROCESSLIST_ID | PROCESSLIST_USER | PROCESSLIST_TIME | sql_text                                                         |
+--------------+----------------+------------------+------------------+------------------------------------------------------------------+
|        48213 |         901223 | pay_rw           |                4 | SELECT id, order_id, status, amount FROM pay_order WHERE out_tra |
|        48190 |         901187 | pay_rw           |                5 | SELECT id, order_id, status, amount FROM pay_order WHERE out_tra |
|        48244 |         901301 | pay_rw           |                3 | SELECT id, order_id, status, amount FROM pay_order WHERE out_tra |
+--------------+----------------+------------------+------------------+------------------------------------------------------------------+
```

最忙的线程全是 pay-service 账号在执行同一条按 `out_trade_no` 查询的 SQL。

### 3、用 digest 确认是不是「头号」SQL

单个线程只是抽样，用语句摘要统计确认整体占比（开始排查时先清空了一次统计，下面是 5 分钟的累计）：

```sql
SELECT LEFT(DIGEST_TEXT, 80) AS digest, COUNT_STAR AS cnt,
       ROUND(SUM_TIMER_WAIT / 1e12) AS total_s,
       ROUND(SUM_ROWS_EXAMINED / COUNT_STAR) AS exam_per_call,
       ROUND(SUM_ROWS_SENT / COUNT_STAR, 1) AS sent_per_call,
       SUM_NO_INDEX_USED AS no_index
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC LIMIT 3;
```

```text
+----------------------------------------------------------------------------------+-------+---------+---------------+---------------+----------+
| digest                                                                           | cnt   | total_s | exam_per_call | sent_per_call | no_index |
+----------------------------------------------------------------------------------+-------+---------+---------------+---------------+----------+
| SELECT `id` , `order_id` , `status` , `amount` FROM `pay_order` WHERE `out_trade | 12000 |   72000 |       2104377 |           1.0 |    12000 |
| SELECT `id` , `user_id` , `status` FROM `orders` WHERE `id` = ?                  | 98712 |    2384 |             1 |           1.0 |        0 |
| UPDATE `pay_order` SET `status` = ? , `paid_at` = ? WHERE `id` = ?               | 30907 |    1197 |             1 |           1.0 |        0 |
+----------------------------------------------------------------------------------+-------+---------+---------------+---------------+----------+
```

这条 SQL 占了总耗时的 9 成以上：每次只返回 1 行，却要检查 210 万行，且全部没有用到索引。`pay_order.out_trade_no` 上明明有唯一索引。平均每次执行约 6 秒（72000s / 12000 次），5 分钟里约 240 个连接并发在跑它，正对上 `Threads_running` 升到的 287。

### 4、执行计划与警告

从应用日志里拿到一条带真实参数的语句：

```sql
EXPLAIN SELECT id, order_id, status, amount FROM pay_order WHERE out_trade_no = 202609301405128873;
SHOW WARNINGS;
```

示例输出（节选）：

```text
type: ALL    key: NULL    rows: 2104377    Extra: Using where

Warning | 1739 | Cannot use ref access on index 'uk_out_trade_no' due to type or collation conversion on field 'out_trade_no'
```

`out_trade_no` 是 `VARCHAR(32)`，参数却是数字。字符串和数字比较时 MySQL 会把**每一行的列值**转成数字再比，索引无法使用，只能全表扫描。把参数加上引号，执行计划立刻变成 `type: const`、`rows: 1`。

### 5、对上发版内容

```bash
git diff release/2026.09.29 release/2026.09.30 -- '*PayOrderMapper*' '*CallbackCommand*'
```

```diff
 public record CallbackCommand(
-        String outTradeNo,
+        Long outTradeNo,          // 「统一订单号类型」重构：渠道返回的商户单号全是数字
         String channelTradeNo,
         BigDecimal amount) {}
```

Mapper 里的 `#{outTradeNo}` 随之以 `Long` 绑定，Connector/J 默认在客户端拼装语句，发到数据库的就是不带引号的数字字面量。

---

## 四、根因

1. **类型改动引发隐式转换**：重构把 `outTradeNo` 从 `String` 改成 `Long`，与列类型 `VARCHAR` 不一致，`uk_out_trade_no` 唯一索引查找退化为每次扫描 210 万行
2. **测试环境没暴露**：测试库 `pay_order` 只有 3000 行，全表扫描也只要 1ms，接口测试和回归测试都通过
3. **SQL 审核只看 Mapper 文本**：审核规则检查了 SQL 写法和索引，没有检查参数的 Java 类型与列类型是否一致
4. **核心库共用一个实例**：支付、订单、会员共用主库，一个服务的坏 SQL 把 CPU 打满，其他服务一起受影响

---

## 五、修复

### 1、止血

- 14:15 确认与发版强相关，决定回滚；同时在主库上批量终止该类语句，先把 CPU 降下来：

```sql
SELECT CONCAT('KILL QUERY ', id, ';')
FROM information_schema.processlist
WHERE user = 'pay_rw' AND info LIKE 'SELECT id, order_id, status, amount FROM pay_order WHERE out_trade_no%';
```

- 14:24 pay-service 回滚到上一版本完成，CPU 回落到 35%，`Threads_running` 回到个位数
- 14:38 支付渠道重试的回调全部处理完，「已付款未更新」订单清零

### 2、根治

- `outTradeNo` 恢复为 `String`，与列类型保持一致；订单号「看起来是数字」不等于应该用数字类型，前导零、长度扩展都会出问题
- Mapper 中显式声明 JDBC 类型，类型再被误改时也按字符串绑定：

```xml
<select id="findByOutTradeNo" resultType="com.example.pay.PayOrder">
  SELECT id, order_id, status, amount FROM pay_order
  WHERE out_trade_no = #{outTradeNo, jdbcType=VARCHAR}
</select>
```

- 回调查询加上执行时间上限，坏计划出现时单条语句最多占用 CPU 500ms：`SELECT /*+ MAX_EXECUTION_TIME(500) */ ...`

---

## 六、预防

**监控告警**（mysqld_exporter 指标）：

```yaml
- alert: MysqlThreadsRunningHigh
  expr: mysql_global_status_threads_running > 64      # 约为核数的 4 倍
  for: 2m
  labels: {severity: critical}
- alert: MysqlRowsReadSurge
  # 扫描行数相对一周前同时段暴涨，往往是执行计划变坏
  expr: |
    rate(mysql_global_status_innodb_row_ops_total{operation="read"}[5m])
      > 10 * rate(mysql_global_status_innodb_row_ops_total{operation="read"}[5m] offset 1w)
  for: 5m
  labels: {severity: warning}
```

**发布与审核**：

- 发版检查单增加一项：发布后 15 分钟内对比 `events_statements_summary_by_digest` 中本服务 SQL 的 `SUM_ROWS_EXAMINED / COUNT_STAR`，新出现的「检查行数 / 返回行数」大于 1000 的语句阻断全量
- 预发库保留生产量级的脱敏数据，核心查询在预发执行 `EXPLAIN` 并在 CI 中断言 `type` 不为 `ALL`
- 实体字段类型与列类型的一致性检查加入 Code Review 清单；单号、手机号、证件号一律用字符串

**架构**：支付库从共享实例中拆出，独立实例 + 独立账号限额，避免一个服务拖垮整库。

---

## 七、涉及知识点

- 隐式类型转换导致索引失效：[MySQL 索引](/database/1_mysql/4_topic_index#_2、隐式类型转换)
- 慢 SQL 定位与 `EXPLAIN` 字段：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#四、慢-sql-定位)
- Top SQL 与会话命令：[MySQL 排查速查](/handbook/1_cheatsheet/5_mysql#三、top-sql)
- 慢 SQL 治理闭环：[数据访问性能](/high-perf/10_db_performance#一、慢-sql-治理闭环)
- 连接池被慢 SQL 占满时的表现：[慢 SQL 拖垮连接池](./6_slow_sql_pool)
- 回滚等止血手段：[故障应急与复盘](/high-avail/11_incident_response#四、止血手段清单)

---

## 小结

- 数据库 CPU 高先看 `Threads_running`、行锁等待和 IO：没有锁等待、IO 不高而扫描行数暴涨，基本是执行计划问题
- 用 `top -H` 找最忙的线程，再用 `performance_schema.threads.THREAD_OS_ID` 对回正在执行的 SQL
- 用 digest 统计的「检查行数 / 返回行数」判断 SQL 效率，`SUM_NO_INDEX_USED` 直接标出全表扫描
- 参数类型与列类型不一致会让索引失效，`SHOW WARNINGS` 中的 1739 警告是直接证据

## 参考资料

- 语句摘要统计表：[MySQL 8.4 Reference Manual: Statement Summary Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)
- `threads` 表与 `THREAD_OS_ID`：[MySQL 8.4 Reference Manual: The threads Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-threads-table.html)
- 比较时的类型转换规则：[MySQL 8.4 Reference Manual: Type Conversion in Expression Evaluation](https://dev.mysql.com/doc/refman/8.4/en/type-conversion.html)
- `MAX_EXECUTION_TIME` 优化器提示：[MySQL 8.4 Reference Manual: Optimizer Hints](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html)
- MySQL 指标导出：[Prometheus mysqld_exporter](https://github.com/prometheus/mysqld_exporter)

> 下一篇：[磁盘写满](./20_disk_full)

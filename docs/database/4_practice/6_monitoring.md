---
description: 关键指标、慢查询日志、sys 库、pg_stat_statements、锁等待、卡顿排查顺序
---

# 数据库监控与诊断

> 前置阅读：[MySQL EXPLAIN 与 SQL 优化](../1_mysql/5_topic_explain)、[PostgreSQL 基础](../2_postgresql/0_basics)

数据库出问题时要先回答三件事：是不是数据库的问题、慢在哪条 SQL、它在等什么。本篇讲要盯的关键指标、MySQL 与 PostgreSQL 的慢 SQL 统计和锁等待排查，以及线上卡顿的排查顺序，基线为 MySQL 8.4、PostgreSQL 18。

---

## 一、要盯哪些指标

| 关注点 | MySQL | PostgreSQL | 告警思路 |
|------|-------|-----------|---------|
| 连接数 | `Threads_connected` / `max_connections` | `pg_stat_activity` 行数 / `max_connections` | 超过 80% 告警，通常是连接泄漏或应用实例扩容 |
| 活跃会话 | `Threads_running` | `state = 'active'` 的会话数 | 持续高于 CPU 核数的几倍，说明 SQL 在排队 |
| 慢查询 | `Slow_queries` 的增速 | `pg_stat_statements` 里 `mean_exec_time` 突增的语句 | 看环比突增，不看绝对值 |
| 锁等待 | `Innodb_row_lock_current_waits`、`Innodb_row_lock_waits` 的增速 | `wait_event_type = 'Lock'` 的会话数、`pg_stat_database.deadlocks` | 有持续的锁等待就要查是谁在阻塞 |
| 缓存命中 | `1 - Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests` | `blks_hit / (blks_hit + blks_read)` | OLTP 库通常在 99% 以上，明显下降说明内存不够或出现大扫描 |
| 复制延迟 | 心跳表或 `SHOW REPLICA STATUS` | `pg_stat_replication.replay_lag` | 按业务能容忍的读旧数据时间设阈值 |
| 长事务 | `information_schema.innodb_trx` 的 `trx_started` | `pg_stat_activity` 的 `xact_start`、`idle in transaction` | 超过 60 秒告警，长事务会拖住 DDL、undo 清理与 VACUUM |
| 存储 | 磁盘使用率、binlog 体积 | 磁盘使用率、WAL 堆积、表膨胀、XID 年龄 | 磁盘 80% 告警；PostgreSQL 额外盯 XID 年龄 |

`Seconds_Behind_Source` 在复制中断、大事务时都会失真，复制延迟优先用心跳表，原因见 [MySQL 主从与高可用](../1_mysql/6_topic_replication)。应用侧的连接池指标（活跃连接、等待获取连接的线程数）往往比数据库更早报警，见 [数据库连接池](./2_connection_pool)。

手工看一眼 MySQL 的关键状态：

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN (
    'Threads_connected', 'Threads_running', 'Slow_queries',
    'Innodb_row_lock_current_waits', 'Innodb_row_lock_waits',
    'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests');
```

日常采集用 Prometheus 的 [mysqld_exporter](https://github.com/prometheus/mysqld_exporter) 与 [postgres_exporter](https://github.com/prometheus-community/postgres_exporter)，配合 Grafana 看板与告警规则，整体做法见 [指标监控](/observability/2_metrics)。监控账号只给读状态所需的权限，不要用应用账号或 root。

---

## 二、MySQL：慢查询日志

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
# 单位秒，可以写小数，精度到微秒；默认 10 秒太宽，OLTP 一般设 0.5～1 秒
long_query_time = 0.5
# 额外记录扫描行数、排序、临时表、收发字节等字段，只对写文件的慢日志生效
log_slow_extra = ON
# 扫描行数少于这个值的语句不记录，0 表示不过滤
min_examined_row_limit = 0
# 没走索引的语句也记录：噪音较大，排查时短时开启
log_queries_not_using_indexes = 0
```

`long_query_time` 可以 `SET GLOBAL` 在线修改，但只对之后新建的连接生效；`ALTER TABLE`、`CREATE INDEX` 这类管理语句默认不记，需要时打开 `log_slow_admin_statements`。

慢日志用 `pt-query-digest` 按语句模板聚合，比逐条翻日志有用得多：

```bash
# 按总耗时排序输出 TOP SQL：每个模板的执行次数、平均 / 95 分位耗时、扫描行数
pt-query-digest /var/log/mysql/slow.log > slow_report.txt
```

报告里先看**总耗时**排前面的模板，而不是单次最慢的那条：一条 50 毫秒、每秒执行一千次的语句，对数据库的压力远大于一天跑一次的 10 秒报表。

---

## 三、MySQL：performance_schema 与 sys

慢日志只记超过阈值的语句；performance_schema 按语句模板（digest）统计**所有**语句，sys 库是在它上面包的一层易读视图。8.x 默认开启，不用额外配置。

### 1、Top SQL

```sql
-- 按总耗时排序的语句模板；statement_analysis 的 total_latency 是格式化后的字符串（如 '1.23 s'），
-- 不能直接按它排序，视图本身已按总耗时降序，或改用 x$ 前缀的原始数值视图
SELECT query, exec_count, total_latency, rows_examined_avg
FROM sys.statement_analysis
LIMIT 10;

-- 原始表：时间单位是皮秒，除以 1e12 换成秒；QUERY_SAMPLE_TEXT 是一条带真实参数的样例，可以直接拿去 EXPLAIN
SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT / 1e12 AS total_sec,
       SUM_ROWS_EXAMINED / COUNT_STAR AS rows_examined_avg, QUERY_SAMPLE_TEXT
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
```

统计从实例启动开始累计。压测或发版前后想单独看一段时间，先 `TRUNCATE TABLE performance_schema.events_statements_summary_by_digest` 清零再观察。

### 2、正在执行的会话

```sql
-- Time 列是已执行秒数；只看在干活的会话
SELECT id, user, host, db, time, state, LEFT(info, 100) AS query
FROM information_schema.processlist
WHERE command <> 'Sleep'
ORDER BY time DESC;
```

### 3、锁等待：谁在阻塞谁

```sql
-- 行锁等待：等待方与阻塞方的会话、SQL，以及现成的 KILL 语句
SELECT waiting_pid, waiting_query, blocking_pid, blocking_query,
       wait_age_secs, sql_kill_blocking_query, sql_kill_blocking_connection
FROM sys.innodb_lock_waits;

-- 元数据锁（MDL）等待：DDL 卡住、表上所有查询排队时看这里
SELECT * FROM sys.schema_table_lock_waits;
```

`blocking_query` 为空时，说明阻塞方的语句已经执行完、事务却没提交（典型的是代码里开了事务后去调外部接口）。这时 `sql_kill_blocking_query` 杀不掉它，要用 `sql_kill_blocking_connection` 断开连接，再回头修代码。MDL 阻塞链的成因与 DDL 的做法见 [Schema 变更与数据迁移](./5_schema_migration#_1、ddl-被-mdl-阻塞-拖垮整张表)。

### 4、定期巡检

| 视图 | 用途 |
|------|------|
| `sys.statements_with_full_table_scans` | 有全表扫描的语句模板，补索引的候选 |
| `sys.statements_with_sorting` | 排序较重的语句 |
| `sys.schema_redundant_indexes` | 被其他索引覆盖的冗余索引，`sql_drop_index` 列给出删除语句 |
| `sys.schema_unused_indexes` | 实例启动以来没被用过的索引 |

`schema_unused_indexes` 只有在实例运行得够久、覆盖了月末报表这类低频业务之后才可信；删索引前在副本上确认，并先用 `ALTER TABLE ... ALTER INDEX ... INVISIBLE` 隐藏观察一段时间，没问题再删。

---

## 四、PostgreSQL：统计视图

### 1、pg_stat_statements

PostgreSQL 的 Top SQL 靠 `pg_stat_statements` 扩展，要在 `shared_preload_libraries` 里预加载（需要重启），再在要用的库里建扩展：

```sql
-- postgresql.conf：shared_preload_libraries = 'pg_stat_statements'，重启后执行
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 按总耗时排序，顺带看缓存命中率：命中率低的语句在大量读盘
SELECT queryid, calls,
       round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       rows,
       round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- 清零，单独观察一段时间
SELECT pg_stat_statements_reset();
```

### 2、慢日志与 auto_explain

```ini
# postgresql.conf
# 超过 500 毫秒的语句记录到日志，默认 -1 表示关闭
log_min_duration_statement = 500ms
# auto_explain：把慢语句的执行计划一起记下来，事后不用再复现
session_preload_libraries = 'auto_explain'
auto_explain.log_min_duration = 1s
# 记录实际行数与耗时；每个节点都计时开销很大，开启时关掉 log_timing 降低代价
auto_explain.log_analyze = on
auto_explain.log_timing = off
```

线上慢查询往往在测试环境复现不出来（数据分布、参数不同），auto_explain 记下的是当时真实执行的计划，比事后 `EXPLAIN` 可靠。

### 3、会话与锁

```sql
-- 正在执行的语句，按已执行时长排序；顺带看在等什么（wait_event）
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - query_start AS running, left(query, 80) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid()
ORDER BY query_start;

-- 锁等待链：被阻塞的会话和阻塞它的会话
SELECT w.pid AS waiting_pid, left(w.query, 60) AS waiting_query,
       b.pid AS blocking_pid, b.state AS blocking_state, left(b.query, 60) AS blocking_query
FROM pg_stat_activity w
JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ON true
JOIN pg_stat_activity b ON b.pid = bp.pid;
```

阻塞方 `state` 是 `idle in transaction`，说明事务开着却没在执行语句，和 MySQL 的「blocking_query 为空」是同一类问题。用 `idle_in_transaction_session_timeout`（如 `60s`）兜底，超时自动断开这类会话。取消语句与断开会话的函数见 [PostgreSQL 基础](../2_postgresql/0_basics)。

### 4、表健康

```sql
-- 顺序扫描远多于索引扫描的大表：可能缺索引
SELECT relname, seq_scan, idx_scan, n_live_tup
FROM pg_stat_user_tables
WHERE seq_scan > coalesce(idx_scan, 0) AND n_live_tup > 100000
ORDER BY seq_scan DESC
LIMIT 10;

-- 死元组多、长时间没被自动 VACUUM 的表：膨胀的候选
SELECT relname, n_dead_tup, n_live_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;

-- XID 年龄：接近 autovacuum_freeze_max_age（默认 2 亿）时要关注冻结是否跟得上
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database
ORDER BY xid_age DESC;
```

死元组、VACUUM 与 XID 回卷的原理见 [PostgreSQL MVCC 与 VACUUM](../2_postgresql/1_topic_mvcc)。

---

## 五、线上卡顿怎么查

接口变慢、超时告警时，按下面的顺序从外往里收窄：

1. **确认是不是数据库**：应用的连接池等待数、SQL 耗时埋点有没有同步上涨；数据库的活跃会话（`Threads_running` / `active` 会话数）是不是同时变高。连接池打满但数据库很闲，问题多半在应用侧（连接泄漏、事务里调外部接口）
2. **看此刻在跑什么**：processlist / `pg_stat_activity` 按执行时长排序，找执行最久、数量最多的语句
3. **看它们在等什么**：大量会话在等锁，就按锁等待视图找到阻塞源头；在等 IO，看缓存命中率与磁盘
4. **看最近谁最耗资源**：digest 表或 `pg_stat_statements` 按总耗时排序，和上一次发版、上周同时段对比，找新出现或突然变重的语句
5. **看执行计划**：拿样例 SQL 跑 `EXPLAIN` / `EXPLAIN ANALYZE`，确认是不是走错索引、扫描行数暴涨，读法见 [MySQL EXPLAIN 与 SQL 优化](../1_mysql/5_topic_explain)
6. **先止血再根治**：杀掉阻塞源头或失控的查询、对问题接口限流、把报表类查询切到副本；之后再加索引、改写 SQL、拆大事务

几个真实案例按这个顺序走了一遍：[数据库 CPU 被打满](/handbook/2_incidents/19_db_cpu_full)、[慢 SQL 拖垮连接池](/handbook/2_incidents/6_slow_sql_pool)、[大事务锁表](/handbook/2_incidents/7_big_transaction)、[主从延迟读到旧数据](/handbook/2_incidents/8_replica_lag)；常用命令汇总在 [MySQL 排查速查](/handbook/1_cheatsheet/5_mysql)。

---

## 小结

- 先盯连接数、活跃会话、慢查询增速、锁等待、缓存命中、复制延迟、长事务、存储这几类指标，告警看环比突增而不是绝对值
- MySQL 慢日志把 `long_query_time` 调到 0.5～1 秒、开 `log_slow_extra`，用 `pt-query-digest` 按总耗时看模板
- performance_schema / sys 统计全部语句：digest 表找 Top SQL，`sys.innodb_lock_waits` 找阻塞源头，`schema_table_lock_waits` 看 MDL，冗余与未用索引定期巡检
- PostgreSQL 用 `pg_stat_statements` 找 Top SQL、auto_explain 记下慢语句当时的计划，`pg_blocking_pids` 找锁等待链，`pg_stat_user_tables` 看缺索引与膨胀
- 阻塞方没在执行语句却持有锁（MySQL 的 blocking_query 为空、PostgreSQL 的 idle in transaction），是事务没关的代码问题
- 卡顿排查顺序：确认是数据库 → 此刻在跑什么 → 在等什么 → 谁最耗资源 → 执行计划 → 先止血再根治

## 参考资料

- MySQL 慢查询日志：[https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html)
- MySQL 语句汇总表：[https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)
- sys.innodb_lock_waits：[https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html](https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html)
- sys.schema_unused_indexes：[https://dev.mysql.com/doc/refman/8.4/en/sys-schema-unused-indexes.html](https://dev.mysql.com/doc/refman/8.4/en/sys-schema-unused-indexes.html)
- PostgreSQL pg_stat_statements：[https://www.postgresql.org/docs/18/pgstatstatements.html](https://www.postgresql.org/docs/18/pgstatstatements.html)
- PostgreSQL auto_explain：[https://www.postgresql.org/docs/18/auto-explain.html](https://www.postgresql.org/docs/18/auto-explain.html)
- PostgreSQL 统计视图：[https://www.postgresql.org/docs/18/monitoring-stats.html](https://www.postgresql.org/docs/18/monitoring-stats.html)
- postgres_exporter：[https://github.com/prometheus-community/postgres_exporter](https://github.com/prometheus-community/postgres_exporter)

> 下一篇：[数据备份与恢复](./7_backup_recovery) —— RTO / RPO、mysqldump、XtraBackup 增量、binlog PITR、PG 增量备份、恢复演练

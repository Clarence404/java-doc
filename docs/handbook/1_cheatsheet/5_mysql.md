---
description: 实例概况、慢查询日志、Top SQL、EXPLAIN、连接与会话、事务与锁等待、死锁、主从复制状态
---

# MySQL 排查速查

> 前置阅读：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)、[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)、[MySQL 主从与高可用](/database/1_mysql/9_topic_replication)

本篇按场景列出 MySQL 线上排查语句，覆盖慢 SQL、执行计划、连接、事务与锁、主从复制，基线为 MySQL 8.4。

---

## 一、实例概况

| 场景 | 命令 | 说明 |
|------|------|------|
| 看版本 | `SELECT VERSION();` | 8.4 起 `SHOW MASTER STATUS` 等旧语法已移除，先确认版本再选语句 |
| 看运行时长 | `SHOW GLOBAL STATUS LIKE 'Uptime';` | 单位秒，判断是否刚发生过重启 |
| 每秒看 QPS / TPS 变化 | `mysqladmin -u root -p extended-status -r -i 1` | `-r` 输出与上次的差值，关注 `Questions`、`Com_commit`、`Threads_running` |
| 看连接数上限 | `SHOW VARIABLES LIKE 'max_connections';` | 与下一条对比判断是否打满 |
| 看历史最大连接数 | `SHOW GLOBAL STATUS LIKE 'Max_used_connections';` | 接近 `max_connections` 说明曾经打满 |
| 看当前活跃线程 | `SHOW GLOBAL STATUS LIKE 'Threads_%';` | `Threads_running` 持续高于 CPU 核数通常意味着有慢 SQL 或锁等待 |
| 看大表 | `SELECT table_schema, table_name, ROUND((data_length + index_length) / 1024 / 1024) AS size_mb FROM information_schema.tables ORDER BY size_mb DESC LIMIT 10;` | 统计值默认缓存 24 小时，要实时值先执行 `ANALYZE TABLE` |
| 持久化修改参数 | `SET PERSIST long_query_time = 1;` | 写入 `mysqld-auto.cnf`，重启后仍生效；`SET GLOBAL` 重启即失效 |

---

## 二、慢查询日志

| 场景 | 命令 | 说明 |
|------|------|------|
| 看慢日志配置 | `SHOW VARIABLES LIKE 'slow_query%';` | 查看是否开启与日志文件路径 |
| 开启慢日志 | `SET GLOBAL slow_query_log = ON;` | 动态生效，无需重启 |
| 设置慢查询阈值 | `SET GLOBAL long_query_time = 1;` | 单位秒，支持小数；只对之后新建的连接生效 |
| 记录额外字段 | `SET GLOBAL log_slow_extra = ON;` | 增加读取行数、排序、临时表等字段，便于定位 |
| 记录未走索引的 SQL | `SET GLOBAL log_queries_not_using_indexes = ON;` | 日志量可能暴增，配合下一条限流 |
| 限制未走索引日志频率 | `SET GLOBAL log_throttle_queries_not_using_indexes = 60;` | 每分钟最多记录 60 条 |
| 按总耗时汇总慢日志 | `mysqldumpslow -s t -t 10 /var/lib/mysql/slow.log` | 官方自带；`-s t` 按总时间排序，`-t 10` 取前 10 |
| 按平均耗时汇总 | `mysqldumpslow -s at -t 10 /var/lib/mysql/slow.log` | `at` 为平均时间，`c` 为次数，`r` 为返回行数 |

---

## 三、Top SQL

| 场景 | 命令 | 说明 |
|------|------|------|
| 按总耗时排序的语句 | `SELECT * FROM sys.statement_analysis LIMIT 10;` | 已按总延迟降序，同类 SQL 按摘要（digest）合并 |
| 自定义字段看 Top SQL | `SELECT DIGEST_TEXT, COUNT_STAR, ROUND(SUM_TIMER_WAIT / 1e12, 2) AS total_s, ROUND(AVG_TIMER_WAIT / 1e9, 2) AS avg_ms, SUM_ROWS_EXAMINED FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;` | 计时单位为皮秒；`SUM_ROWS_EXAMINED` 远大于返回行数说明索引不佳 |
| 全表扫描的语句 | `SELECT * FROM sys.statements_with_full_table_scans LIMIT 10;` | 优先处理执行次数多的 |
| 用了磁盘临时表的语句 | `SELECT * FROM sys.statements_with_temp_tables LIMIT 10;` | 常见于 `GROUP BY`、`DISTINCT`、`UNION` |
| 有排序的语句 | `SELECT * FROM sys.statements_with_sorting LIMIT 10;` | 结合 EXPLAIN 看是否能用索引消除排序 |
| 从未使用的索引 | `SELECT * FROM sys.schema_unused_indexes;` | 统计自上次重启起，刚重启的实例不可信 |
| 冗余索引 | `SELECT * FROM sys.schema_redundant_indexes;` | 给出被哪个索引覆盖与删除语句 |
| 清空统计重新观察 | `TRUNCATE TABLE performance_schema.events_statements_summary_by_digest;` | 优化上线后清零，便于对比 |

---

## 四、执行计划

| 场景 | 命令 | 说明 |
|------|------|------|
| 看执行计划 | `EXPLAIN SELECT * FROM orders WHERE user_id = 42;` | 重点看 `type`、`key`、`rows`、`Extra` |
| 树形格式 | `EXPLAIN FORMAT=TREE SELECT * FROM orders WHERE user_id = 42;` | 按执行顺序缩进，看 JOIN 和子查询更直观 |
| 实际执行并对比预估 | `EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 42;` | **会真正执行 SQL**，对比 `rows` 预估与 `actual rows`；不要对写语句用 |
| JSON 格式看成本 | `EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE user_id = 42;` | 含 `cost_info`，比较两种写法的成本 |
| 看优化器改写后的 SQL | `SHOW WARNINGS;` | 紧跟 EXPLAIN 执行，显示子查询展开、条件改写后的语句 |
| 看正在执行的 SQL 的计划 | `EXPLAIN FOR CONNECTION 123;` | `123` 为 processlist 中的 ID，不用复制 SQL |
| 看优化器为什么选这个索引 | `SET optimizer_trace = 'enabled=on';` | 再执行目标 SQL，然后 `SELECT * FROM information_schema.OPTIMIZER_TRACE\G`，看完关闭 |
| 看索引定义与区分度 | `SHOW INDEX FROM orders;` | `Cardinality` 为估算值，偏差大时执行 `ANALYZE TABLE orders;` |
| 强制走某索引验证 | `SELECT * FROM orders FORCE INDEX (idx_user_id) WHERE user_id = 42;` | 只用于验证，确认后优先改索引或 SQL |

---

## 五、连接与会话

| 场景 | 命令 | 说明 |
|------|------|------|
| 看所有连接 | `SHOW FULL PROCESSLIST;` | `Time` 为当前状态持续秒数，`Info` 为完整 SQL |
| 只看非空闲会话 | `SELECT * FROM sys.session WHERE command <> 'Sleep' ORDER BY time DESC;` | 含当前语句、已执行时长、事务状态，比 processlist 信息多 |
| 按来源统计连接 | `SELECT SUBSTRING_INDEX(host, ':', 1) AS client, COUNT(*) AS cnt FROM information_schema.processlist GROUP BY client ORDER BY cnt DESC;` | 定位是哪台应用把连接打满 |
| 按状态统计连接 | `SELECT state, COUNT(*) AS cnt FROM information_schema.processlist GROUP BY state ORDER BY cnt DESC;` | 大量 `Waiting for table metadata lock` 说明有 MDL 阻塞 |
| 终止某条 SQL | `KILL QUERY 123;` | 只中止当前语句，连接保留 |
| 断开某个连接 | `KILL 123;` | 未提交事务会回滚，大事务回滚可能很久 |

---

## 六、事务与锁

| 场景 | 命令 | 说明 |
|------|------|------|
| 找长事务 | `SELECT trx_id, trx_mysql_thread_id, trx_state, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s, trx_rows_locked, trx_query FROM information_schema.innodb_trx ORDER BY trx_started;` | `trx_mysql_thread_id` 即 processlist ID；`trx_query` 为空说明事务已空闲但未提交 |
| 谁阻塞了谁 | `SELECT * FROM sys.innodb_lock_waits\G` | 给出等待方与阻塞方 SQL，以及 `sql_kill_blocking_connection` 现成的 KILL 语句 |
| 看当前持有的行锁 | `SELECT object_schema, object_name, index_name, lock_type, lock_mode, lock_status, lock_data FROM performance_schema.data_locks;` | `lock_mode` 中 `X,GAP`、`X,REC_NOT_GAP` 区分间隙锁与记录锁 |
| 看锁等待关系 | `SELECT * FROM performance_schema.data_lock_waits;` | 与 `data_locks` 按 `ENGINE_LOCK_ID` 关联 |
| 找元数据锁阻塞 | `SELECT * FROM sys.schema_table_lock_waits\G` | DDL 卡住时用；通常是长事务持有 MDL 读锁 |
| 看最近一次死锁 | `SHOW ENGINE INNODB STATUS\G` | 看 `LATEST DETECTED DEADLOCK` 段，含双方 SQL 与持有 / 等待的锁 |
| 把所有死锁写进错误日志 | `SET GLOBAL innodb_print_all_deadlocks = ON;` | `SHOW ENGINE INNODB STATUS` 只保留最近一次，开启后可回溯 |
| 看行锁等待统计 | `SHOW GLOBAL STATUS LIKE 'Innodb_row_lock%';` | `Innodb_row_lock_waits` 持续增长说明锁竞争加剧 |
| 看锁等待超时时间 | `SHOW VARIABLES LIKE 'innodb_lock_wait_timeout';` | 默认 50 秒，应用侧超时应短于它 |
| 看 undo 历史长度 | `SELECT count FROM information_schema.innodb_metrics WHERE name = 'trx_rseg_history_len';` | 持续增长说明有长事务阻止 purge |

---

## 七、主从复制

| 场景 | 命令 | 说明 |
|------|------|------|
| 看从库状态 | `SHOW REPLICA STATUS\G` | 在从库执行；`Replica_IO_Running` 与 `Replica_SQL_Running` 都应为 `Yes` |
| 看复制延迟 | `SHOW REPLICA STATUS\G` | 看 `Seconds_Behind_Source`，为 0 也不一定完全追上，结合 GTID 判断 |
| 看接收线程状态 | `SELECT SERVICE_STATE, LAST_ERROR_MESSAGE, LAST_HEARTBEAT_TIMESTAMP FROM performance_schema.replication_connection_status;` | IO 线程断开时看错误信息与最后心跳时间 |
| 看回放线程错误 | `SELECT WORKER_ID, LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE, APPLYING_TRANSACTION FROM performance_schema.replication_applier_status_by_worker;` | 多线程回放时定位具体哪个 worker 在哪个事务上出错 |
| 看并行回放线程数 | `SHOW VARIABLES LIKE 'replica_parallel_workers';` | 8.4 默认 4，延迟大时可调大 |
| 看主库当前 binlog 位点 | `SHOW BINARY LOG STATUS;` | 在主库执行，替代 8.4 已移除的 `SHOW MASTER STATUS` |
| 看连接的从库 | `SHOW REPLICAS;` | 在主库执行，从库需配置 `report_host` 才会显示 |
| 看已执行的 GTID | `SELECT @@GLOBAL.gtid_executed;` | 主从对比，判断从库缺哪些事务 |
| 列出 binlog 文件 | `SHOW BINARY LOGS;` | 查看文件大小，评估磁盘占用 |
| 按时间解析 binlog | `mysqlbinlog --base64-output=DECODE-ROWS -vv --start-datetime="2026-10-13 10:00:00" --stop-datetime="2026-10-13 10:05:00" binlog.000123` | 把行格式事件解码为伪 SQL，用于查误操作 |
| 重启复制 | `STOP REPLICA; START REPLICA;` | 8.4 起只支持 `REPLICA` 写法；修复错误后执行 |

::: tip 跳过复制错误前先确认数据
回放报错（如主键冲突、找不到行）说明主从数据已经不一致，跳过事务只会让差异扩大。先用 `replication_applier_status_by_worker` 找到出错事务，核对数据后再处理，必要时重建从库。
:::

---

## 小结

最常用的 5 条：

1. `SELECT * FROM sys.statement_analysis LIMIT 10;`：找最耗时的 SQL
2. `EXPLAIN ANALYZE SELECT …;`：看实际执行计划（会真正执行）
3. `SELECT * FROM sys.innodb_lock_waits\G`：找出谁阻塞了谁
4. `SELECT … FROM information_schema.innodb_trx ORDER BY trx_started;`：找长事务
5. `SHOW REPLICA STATUS\G`：看复制线程与延迟

执行计划字段含义见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)，加锁规则见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction)。

---

## 参考资料

- 慢查询日志：[The Slow Query Log（MySQL 8.4）](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html)
- mysqldumpslow：[mysqldumpslow — Summarize Slow Query Log Files](https://dev.mysql.com/doc/refman/8.4/en/mysqldumpslow.html)
- EXPLAIN 语法：[EXPLAIN Statement](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- sys 库视图：[MySQL sys Schema](https://dev.mysql.com/doc/refman/8.4/en/sys-schema.html)
- 锁相关表：[Performance Schema Lock Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-lock-tables.html)
- 复制状态：[Checking Replication Status](https://dev.mysql.com/doc/refman/8.4/en/replication-administration-status.html)
- 8.4 移除的语法：[What Is New in MySQL 8.4 since MySQL 8.0](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)

> 下一篇：[Redis 运维命令速查](./6_redis)

---
description: Binlog、复制原理、GTID、半同步、并行回放与延迟、InnoDB Cluster、读写分离
---

# MySQL 主从与高可用

> **本篇目标**：理解 binlog 与基于 GTID 的复制原理，能用 MySQL 8.4 语法搭建和排查复制，掌握半同步、多线程回放与延迟监控，并能在 InnoDB Cluster、ClusterSet 和传统主从方案之间做选择。
>
> **前置阅读**：[MySQL 事务与锁](./5_topic_transaction)、[InnoDB 存储结构](./8_topic_innodb)

本篇以 MySQL 8.4 LTS 为基准。8.4 **移除了**所有 `MASTER` / `SLAVE` 形式的复制语句（如 `CHANGE MASTER TO`、`START SLAVE`、`SHOW SLAVE STATUS`、`SHOW MASTER STATUS`），文中只使用新语法。下文"主库 / 从库"对应官方术语 source / replica。

---

## 一、Binlog

### 1、作用

Binlog 是 **Server 层**的二进制日志，记录所有**修改数据的操作**（DML 与 DDL），不记录 SELECT。三个用途：

1. **复制**：主库通过 binlog 把变更传给从库
2. **时间点恢复**：全量备份加 binlog 回放到指定时间点，见 [数据备份与恢复](../5_practice/1_backup_recovery)
3. **数据订阅**：Canal、Debezium 等 CDC 工具伪装成从库消费 binlog，见 [CDC 工具](../5_practice/0_cdc_tools) 与 [Flink CDC](/flink/6_cdc)

binlog 与 redo log 的区别、两阶段提交与崩溃恢复见 [MySQL 事务与锁](./5_topic_transaction)。

### 2、格式

| 格式 | 记录内容 | 现状 |
|------|---------|------|
| **ROW** | 每行变更前后的数据 | 5.7.7 起的默认值，也是唯一推荐的格式；CDC 依赖它 |
| STATEMENT | SQL 原文 | 遗留格式；`NOW()`、`UUID()`、`LIMIT` 无序更新等可能导致主从不一致 |
| MIXED | 按语句自动切换 | 遗留格式 |

8.0.34 起 `binlog_format` 变量本身已弃用，设置它会产生警告，未来版本只保留 ROW。ROW 格式下可用 `binlog_row_image=MINIMAL` 减小体积，但 CDC 场景通常需要 `FULL`（默认）。

### 3、配置与管理

```ini
[mysqld]
server_id = 1
# 8.0 起 binlog 默认开启，这里显式写出文件名前缀
log_bin = mysql-bin
# 默认 2592000 秒（30 天）；expire_logs_days 在 8.4 中已移除，写进配置会导致无法启动
binlog_expire_logs_seconds = 604800
```

```sql
SHOW BINARY LOGS;                          -- 所有 binlog 文件
SHOW BINARY LOG STATUS;                    -- 当前写入位置与 Executed_Gtid_Set（替代 SHOW MASTER STATUS）
PURGE BINARY LOGS TO 'mysql-bin.000010';   -- 手动清理，先确认所有从库与 CDC 已消费
```

```bash
# 查看 ROW 格式内容（-v 解析出伪 SQL）
mysqlbinlog -v --base64-output=decode-rows mysql-bin.000001
```

---

## 二、复制原理

### 1、线程模型

![MySQL 主从复制原理](../../assets/mysql/mysql-replication.svg)

| 线程 | 所在节点 | 职责 |
|------|---------|------|
| **Binlog Dump 线程** | 主库 | 为每个连接的从库发送 binlog 事件 |
| **接收线程**（receiver，原 I/O 线程） | 从库 | 连接主库，接收事件写入本地 relay log |
| **协调线程**（coordinator，原 SQL 线程） | 从库 | 读取 relay log，按事务依赖分发给 worker |
| **Worker 线程**（applier worker） | 从库 | 并行回放事务；8.0.27 起默认 4 个 |

### 2、异步带来的两类问题

默认复制是**异步**的：主库提交事务时不等从库确认，由此带来两类问题：

- **主从延迟**：从库读到旧数据，见第五节
- **主库宕机丢数据**：最后一批 binlog 还没传到从库，见第四节半同步

---

## 三、GTID 复制

### 1、GTID 是什么

GTID（全局事务 ID）格式为 `source_uuid:事务序号`，8.3 起还支持带标签的 `source_uuid:tag:序号`。开启 GTID 后，从库根据自己已执行的 GTID 集合**自动定位**复制起点，切换主库时不再需要人工找 binlog 文件名和位置。

### 2、搭建步骤

主从双方都需要开启 GTID：

```ini
[mysqld]
server_id = 2                       # 每个实例唯一
gtid_mode = ON
enforce_gtid_consistency = ON
log_bin = mysql-bin
log_replica_updates = ON            # 默认 ON，从库也写 binlog，便于级联和切换
relay_log_recovery = ON             # 从库崩溃后丢弃未回放的 relay log 并重新拉取
```

主库创建复制账号（权限名仍为 `REPLICATION SLAVE`）：

```sql
CREATE USER 'repl'@'10.0.%' IDENTIFIED BY 'change_me';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'10.0.%';
```

从库通过 clone 插件（8.0.17 起）或 `mysqldump --source-data` 等方式拿到初始数据后，配置复制：

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = '10.0.0.11',
  SOURCE_PORT = 3306,
  SOURCE_USER = 'repl',
  SOURCE_PASSWORD = 'change_me',
  SOURCE_AUTO_POSITION = 1,
  SOURCE_SSL = 1;
START REPLICA;

SHOW REPLICA STATUS\G
-- 关注 Replica_IO_Running、Replica_SQL_Running、Seconds_Behind_Source、Last_IO_Error、Last_SQL_Error
```

复制账号默认使用 `caching_sha2_password`，连接必须走 TLS（`SOURCE_SSL = 1`），或者允许获取 RSA 公钥（`GET_SOURCE_PUBLIC_KEY = 1`），否则接收线程会报错 2061 无法连接。

### 3、语法对照

| 8.0 旧语法（8.4 已移除） | 8.4 语法 |
|------|------|
| `CHANGE MASTER TO MASTER_HOST = ...` | `CHANGE REPLICATION SOURCE TO SOURCE_HOST = ...` |
| `START SLAVE` / `STOP SLAVE` / `RESET SLAVE` | `START REPLICA` / `STOP REPLICA` / `RESET REPLICA` |
| `SHOW SLAVE STATUS` | `SHOW REPLICA STATUS` |
| `SHOW SLAVE HOSTS` | `SHOW REPLICAS` |
| `SHOW MASTER STATUS` | `SHOW BINARY LOG STATUS` |
| `RESET MASTER` | `RESET BINARY LOGS AND GTIDS` |

---

## 四、半同步复制

### 1、原理

主库提交时**至少等一个从库确认收到事件并写入 relay log**，才向客户端返回成功，避免主库宕机后已提交事务在从库不存在。

`rpl_semi_sync_source_wait_point` 默认 `AFTER_SYNC`（无损半同步）：主库在 binlog 落盘后、引擎提交前等待确认，等待期间其他会话看不到这笔事务，主库宕机切换后不会出现"主库上读到过、新主库上没有"的幻读。

### 2、配置

8.0.26 起插件和变量使用 source / replica 命名，主从两侧安装不同的插件：

```sql
-- 主库
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET PERSIST rpl_semi_sync_source_enabled = ON;
-- 默认 10000 毫秒，超时后自动降级为异步
SET PERSIST rpl_semi_sync_source_timeout = 1000;

-- 从库
INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
SET PERSIST rpl_semi_sync_replica_enabled = ON;
-- 重启接收线程后生效
STOP REPLICA IO_THREAD;
START REPLICA IO_THREAD;
```

`rpl_semi_sync_source_wait_for_replica_count`（默认 1）控制需要几个从库确认。

### 3、一致性对比

| 模式 | 数据安全 | 写入延迟 |
|------|---------|---------|
| 异步（默认） | 主库宕机可能丢最后一批事务 | 无额外延迟 |
| 半同步 | 至少一个从库有 relay log 副本；超时降级后退化为异步 | 多一次网络往返 |
| 组复制（MGR） | 事务需多数派认证通过才提交，故障切换不丢已提交事务 | 多一次多数派通信 |

---

## 五、复制延迟与多线程回放

### 1、常见延迟原因

| 原因 | 优化方案 |
|------|---------|
| 主库大事务（大批量 DML、大表 DDL） | 拆成小批次；大表 DDL 的做法见 [MySQL 避坑指南](./3_fallible_point) |
| 回放并行度不足 | 确认多线程回放生效，按需增加 worker（见下） |
| 从库执行了大查询（报表、备份） | 分析类查询走专用从库 |
| 从库 IO 能力差 | 升级存储；或在从库放宽 `sync_binlog`、`innodb_flush_log_at_trx_commit`，代价是从库崩溃后可能需要重建 |
| 无主键的表 | ROW 格式下每行变更都要全表扫描定位，务必给所有表加主键 |

### 2、多线程回放的演进

| 版本 | 并行策略 |
|------|---------|
| 5.6 | 按库并行，单库场景无效 |
| 5.7 | `LOGICAL_CLOCK`：主库同一组提交的事务在从库并行回放 |
| 8.0 | 主库用 WRITESET 记录事务修改的行，不冲突的事务即可并行，并行度不再依赖主库的组提交 |
| 8.0.27 起 | 多线程回放默认开启：`replica_parallel_workers=4`、`replica_preserve_commit_order=ON` |
| 8.4 | `binlog_transaction_dependency_tracking` 已移除，主库固定使用 WRITESET；`replica_parallel_type` 自 8.0.29 弃用，固定为 LOGICAL_CLOCK |

8.4 中需要调整的只有 worker 数量：

```ini
[mysqld]
# 默认 4，写入并发高时可调大；不要再配置 replica_parallel_type 和
# binlog_transaction_dependency_tracking（后者在 8.4 中写进配置会导致无法启动）
replica_parallel_workers = 8
replica_preserve_commit_order = ON
```

### 3、延迟监控

`Seconds_Behind_Source` 不可靠：它依据正在回放的事件时间戳计算，回放线程空闲时显示 0，即使接收线程卡住、事件根本没传过来。更可靠的做法：

- **心跳表**：主库定时写入时间戳，从库比较当前时间与读到的时间戳，如 Percona Toolkit 的 `pt-heartbeat`
- **performance_schema 时间戳**（8.0 起）：比较原始提交时间与回放完成时间

```sql
SELECT WORKER_ID,
       LAST_APPLIED_TRANSACTION,
       TIMESTAMPDIFF(MICROSECOND,
                     LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
                     LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP) / 1e6 AS lag_sec
FROM performance_schema.replication_applier_status_by_worker;

-- 接收侧：最后收到的事务及其原始提交时间
SELECT LAST_QUEUED_TRANSACTION, LAST_QUEUED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP
FROM performance_schema.replication_connection_status;
```

### 4、读己之写

写后立即读的场景，MySQL 层面可以用 GTID 等待：

```sql
-- 主库会话开启后，每次提交在 OK 包中返回本事务的 GTID
SET SESSION session_track_gtids = OWN_GTID;

-- 从库上读之前等待该 GTID 回放完成，最多等 1 秒；返回 0 表示已追上，1 表示超时
SELECT WAIT_FOR_EXECUTED_GTID_SET('3e11fa47-71ca-11e1-9e33-c80aa9429562:1-1000', 1);
```

强制读主、按业务容忍度分级等系统级策略见 [数据层扩展](/high-con/5_data_scaling)。

---

## 六、高可用方案

### 1、组复制与 InnoDB Cluster

**组复制（Group Replication，MGR）** 基于 Paxos 变种实现多数派认证，最多 9 个成员：

- 默认**单主模式**（`group_replication_single_primary_mode=ON`），主节点故障时自动选出新主；多主模式存在写冲突回滚等限制，一般不推荐
- 多数派认证保证故障切换不丢已提交事务，但**从节点的读默认不保证读到最新数据**。`group_replication_consistency` 在 8.4 中默认 `BEFORE_ON_PRIMARY_FAILOVER`（8.0 为 `EVENTUAL`），只保证新主上线前追平积压；需要读己之写时用 `BEFORE`、`AFTER` 或 `BEFORE_AND_AFTER`，代价是更高的延迟
- 对网络延迟敏感，组内成员应部署在同一地域

官方把组复制与工具打包成几种拓扑，都用 MySQL Shell 的 AdminAPI 管理：

| 方案 | 组成 | 适用场景 |
|------|------|---------|
| **InnoDB Cluster** | 组复制 + MySQL Shell + MySQL Router | 单地域高可用，自动故障切换，官方首选 |
| **InnoDB ClusterSet**（8.0.27 起） | 一个主 InnoDB Cluster + 若干异地副本 Cluster，之间异步复制 | 跨地域容灾，支持计划内切换与紧急故障转移 |
| **InnoDB ReplicaSet** | 传统异步复制 + MySQL Shell + Router | 不需要自动故障切换、只想简化运维的场景，切换需手动执行 |

新节点加入时 MySQL Shell 会用 clone 插件自动拷贝全量数据。

### 2、其他方案

| 方案 | 现状 |
|------|------|
| **MHA** | 项目多年未更新，依赖 8.4 已移除的旧复制语句，不建议新建 |
| **Orchestrator + 半同步** | 社区拓扑管理与故障切换工具，需自行搭建配套组件；选型前确认项目当前维护状态和对 8.4 的支持 |
| **云托管（RDS / Aurora 等）** | 高可用由云厂商负责，关注其切换时间与数据丢失承诺 |

> 自建 MySQL 时首选 8.4 LTS 上的 InnoDB Cluster，跨地域再叠加 ClusterSet。冗余与故障转移的通用策略见 [冗余与故障转移](/high-avail/2_redundancy_failover)。

---

## 七、读写分离

- **应用层**：ShardingSphere-JDBC 等在 JDBC 层识别读写语句，写主读从，无额外网络跳数
- **代理层**：MySQL Router（InnoDB Cluster 自带读写分离端口）、ProxySQL，对应用透明，但多一跳且代理本身要做高可用
- 读写分离一定会遇到复制延迟，MySQL 层面的手段见第五节，系统级策略见 [数据层扩展](/high-con/5_data_scaling)
- 分库分表见 [分库分表与中间件](../5_practice/2_sharding)

---

## 小结

- binlog 只推荐 ROW 格式，`binlog_format` 自 8.0.34 弃用；`expire_logs_days` 在 8.4 中已移除，用 `binlog_expire_logs_seconds`
- 8.4 只接受 `CHANGE REPLICATION SOURCE TO`、`START REPLICA`、`SHOW REPLICA STATUS`、`SHOW BINARY LOG STATUS` 等新语法；复制账号默认 `caching_sha2_password`，需 TLS 或 `GET_SOURCE_PUBLIC_KEY=1`
- 用 GTID 加 `SOURCE_AUTO_POSITION=1` 自动定位，用 clone 插件初始化从库
- 半同步插件为 `rpl_semi_sync_source` / `rpl_semi_sync_replica`，默认 `AFTER_SYNC`，超时会降级为异步
- 多线程回放 8.0.27 起默认开启（4 个 worker），8.4 固定使用 WRITESET，只需调 `replica_parallel_workers`
- `Seconds_Behind_Source` 不可靠，用心跳表或 performance_schema 时间戳监控延迟；读己之写用 `WAIT_FOR_EXECUTED_GTID_SET`
- 组复制默认单主，多数派认证不等于从节点强一致读；InnoDB Cluster 管单地域，ClusterSet 管跨地域；MHA 已不适用于 8.4

## 参考资料

- MySQL 8.4 Reference Manual：[Replication](https://dev.mysql.com/doc/refman/8.4/en/replication.html)
- MySQL 8.4 Reference Manual：[What Is New in MySQL 8.4 since MySQL 8.0](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)
- MySQL 8.4 Reference Manual：[Setting Up Replication Using GTIDs](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-howto.html)
- MySQL 8.4 Reference Manual：[Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html)
- MySQL 8.4 Reference Manual：[Group Replication](https://dev.mysql.com/doc/refman/8.4/en/group-replication.html)
- MySQL Shell 8.4：[InnoDB Cluster](https://dev.mysql.com/doc/mysql-shell/8.4/en/mysql-innodb-cluster.html)、[InnoDB ClusterSet](https://dev.mysql.com/doc/mysql-shell/8.4/en/innodb-clusterset.html)
- MySQL 8.4 Release Notes：[Changes in MySQL 8.4.0](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/news-8-4-0.html)
- Percona Toolkit：[pt-heartbeat](https://docs.percona.com/percona-toolkit/pt-heartbeat.html)

> 下一篇：[PostgreSQL 基础](../2_postgresql/0_overview) —— 进入 PostgreSQL：与 MySQL 的差异、安装与核心概念。

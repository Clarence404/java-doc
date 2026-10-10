---
description: 进程模型与连接池、流复制与同步级别、复制槽、逻辑复制与 CDC、Patroni 等高可用、与 MySQL 对照
---

# PostgreSQL 复制与高可用

> 前置阅读：[MySQL 主从与高可用](../1_mysql/9_topic_replication)、[MVCC 与 VACUUM](./2_topic_mvcc)

本篇讲 PG 每连接一进程模型为何必须配连接池、基于 WAL 的流复制与 `synchronous_commit` 各级别含义、复制槽风险、逻辑复制边界，以及 Patroni、CloudNativePG 等故障切换方案。

---

## 一、进程模型与连接池

| | PostgreSQL | MySQL |
|---|---|---|
| 连接模型 | 每个连接 fork 一个后端进程 | 每个连接一个线程 |
| 单连接开销 | 进程创建成本高；空闲进程私有内存通常为几 MB，随 `work_mem` 使用和缓存的元数据增长 | 较小 |
| 默认 `max_connections` | 100 | 151 |
| 大量短连接 | 不适合，必须使用连接池 | 相对能承受 |

PG 18 仍没有内置连接池，生产环境通常是两层：应用内的 HikariCP 控制应用并发，外部的 PgBouncer 等代理把成百上千个客户端连接收敛成少量真实后端连接。

PgBouncer 最常用 `transaction` 模式（事务结束即归还后端连接），代价是会话级状态不可用：`SET`（`SET LOCAL` 除外）、`LISTEN` / `NOTIFY`、会话级 advisory lock、`WITH HOLD` 游标。PgJDBC 默认在同一语句执行 5 次（`prepareThreshold`）后改用服务端预编译语句，需要 PgBouncer 1.21 及以上并开启 `max_prepared_statements`，旧版本则在 JDBC URL 上设 `prepareThreshold=0`。pool_mode 选择、两层池的大小计算等细节见 [数据库连接池](../5_practice/3_connection_pool)。

---

## 二、WAL 与流复制

PG 只有一种日志：**WAL**（Write-Ahead Log）。它同时承担 InnoDB redo log 的崩溃恢复职责和 MySQL binlog 的复制职责，没有独立的 binlog，也就不需要两阶段提交来协调两种日志。

![流复制链路与 synchronous_commit 等待点](../../assets/database/pg-streaming-replication.svg)

后端进程把 WAL 记录写入共享内存中的 WAL Buffers，提交时（或由 walwriter 后台）刷入 `pg_wal` 段文件；walsender 进程读取 WAL 流式发送给备库，备库的 walreceiver 接收并写入本地 `pg_wal`，startup 进程持续重放到数据页。物理复制传的是页级变更，备库与主库逐字节一致。

### 1、搭建要点

`wal_level = replica`、`max_wal_senders = 10` 从 10 起已是默认值，主库通常只需要准备账号与访问控制：

```sql
-- 主库：复制专用角色
CREATE ROLE repl WITH REPLICATION LOGIN PASSWORD 'change-me';
```

```ini
# 主库 pg_hba.conf：允许备库以复制协议连接，修改后 SELECT pg_reload_conf();
host  replication  repl  10.0.0.12/32  scram-sha-256
```

```bash
# 备库：拉取基础备份；-R 写入连接信息并生成 standby.signal，-C -S 同时在主库创建物理复制槽
pg_basebackup -h 10.0.0.11 -U repl -D /var/lib/postgresql/18/main \
  -X stream -C -S standby1_slot -R -P
```

备库启动后以只读的 hot standby 模式提供查询。备库查询与 WAL 重放会冲突（重放要清理的旧版本正被备库查询使用），两个参数决定取舍：

| 备库参数 | 作用 | 代价 |
|---------|------|------|
| `max_standby_streaming_delay` | 冲突时重放最多等多久，超时取消备库查询（默认 30s） | 调大则复制延迟可能变大 |
| `hot_standby_feedback` | 把备库查询的 xmin 反馈给主库，主库暂缓清理这些旧版本 | 备库长查询会让主库膨胀，见 [MVCC 与 VACUUM](./2_topic_mvcc) |

```sql
-- 主库查看各备库的延迟
SELECT application_name, state, sync_state,
       write_lag, flush_lag, replay_lag,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_gap
FROM pg_stat_replication;
```

### 2、同步级别

`synchronous_commit` 决定提交时等到哪一步才返回。除 `off` 和 `local` 外，其余级别只有在 `synchronous_standby_names` 非空时才会等待备库，否则 `on`、`remote_write`、`remote_apply` 都只等本地落盘，效果等同 `local`。

| 值 | 提交时等待 | 对照 MySQL |
|----|-----------|-----------|
| `off` | 不等本地 WAL 落盘（崩溃可能丢最近几百毫秒的已提交事务，但不会导致数据不一致） | 类似 `innodb_flush_log_at_trx_commit = 0` |
| `local` | 本地 WAL 落盘 | “双 1”的单机部分 |
| `remote_write` | 同步备库已收到并写入操作系统缓存（未 fsync） | 最接近 AFTER_SYNC 半同步（备库写入 relay log 后确认） |
| `on`（默认） | 同步备库 WAL 已刷盘 | 强于 MySQL 半同步 |
| `remote_apply` | 同步备库已重放，备库上能读到 | MySQL 无直接对应 |

`synchronous_commit` 可以按事务设置：核心交易保持同步，日志、埋点这类非关键写入在事务里执行 `SET LOCAL synchronous_commit = off;` 降低延迟。

同步备库的选择：

```ini
# 按优先级：列表中第一个可用的作为同步备库，其余为候选（FIRST 关键字 10 起；9.6 写作 1 (standby1, standby2)）
synchronous_standby_names = 'FIRST 1 (standby1, standby2)'

# quorum：任意 1 个确认即可（10 起）
synchronous_standby_names = 'ANY 1 (standby1, standby2)'
```

只有一个同步备库时，它宕机会让主库所有提交挂起，生产环境至少准备两个候选，或由 Patroni 一类工具在备库故障时自动降级为异步。

### 3、复制槽

复制槽让主库记住每个消费者的进度，保留其尚未消费的 WAL，避免备库或 CDC 断连一段时间后发现所需的 WAL 已被删除。代价是消费者长期不回来时，WAL 会无限堆积直到磁盘写满。

```sql
SELECT slot_name, slot_type, active, wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

| 防护参数 | 版本 | 作用 |
|---------|------|------|
| `max_slot_wal_keep_size` | 13+ | 单个槽最多保留的 WAL 量，超出后该槽失效（`wal_status = lost`），需要重建备库或重新初始化 CDC |
| `idle_replication_slot_timeout` | 18+ | 槽不活跃超过该时长自动失效 |

`wal_status` 为 `extended` 或 `unreserved` 时就该告警。逻辑复制槽还会通过 `catalog_xmin` 阻止系统表清理，废弃的 CDC 槽必须及时删除：`SELECT pg_drop_replication_slot('slot_name');`。

---

## 三、逻辑复制

逻辑复制把 WAL 解码成行级变更，按表发布 / 订阅，作用类似 MySQL ROW 格式 binlog 的订阅。

```sql
-- 发布端：需要 wal_level = logical（修改需重启）
CREATE PUBLICATION pub_orders FOR TABLE orders, order_items;

-- 订阅端（可以是另一个大版本）：表结构需事先建好
CREATE SUBSCRIPTION sub_orders
  CONNECTION 'host=10.0.0.11 dbname=mydb user=repl password=change-me'
  PUBLICATION pub_orders;
```

使用前要知道的限制：

- UPDATE / DELETE 需要能定位行：表要有主键，或设置 `REPLICA IDENTITY USING INDEX` / `FULL`（`FULL` 会把整行旧值写入 WAL，开销大）
- 不复制 DDL：表结构变更要在两端分别执行，通常先改订阅端
- 不复制序列的当前值、大对象（large object）；切换到订阅端前要手动同步序列
- 订阅端的表是可写的，但本地写入与复制过来的变更冲突（如主键重复）会让复制停止，需要人工处理；18 起冲突会写日志并计入 `pg_stat_subscription_stats`
- 大事务：14 起订阅选项 `streaming = on` 可在提交前就开始传输，16 起 `streaming = parallel` 可并行应用

### 1、物理复制与逻辑复制

| | 流复制（物理） | 逻辑复制 |
|---|---|---|
| 粒度 | 整个实例 | 表级，可过滤行和列（15+） |
| 备库可写 | 不可写（只读） | 可写，但有冲突风险 |
| 跨大版本 | 不支持 | 支持，常用于低停机大版本升级 |
| DDL | 自动（页级复制） | 不复制 |
| 典型用途 | 高可用、读扩展 | 大版本升级、数据分发与汇聚、CDC |

### 2、CDC

Debezium、Flink CDC 等工具不使用 `CREATE SUBSCRIPTION`，而是作为客户端创建逻辑复制槽，用内置的 `pgoutput` 解码插件读取变更流。它们同样受复制槽 WAL 堆积和 `catalog_xmin` 的约束，下游停摆时要有告警。工具对比见 [CDC 工具](../5_practice/0_cdc_tools)，Flink 侧的用法见 [Flink CDC](/flink/6_cdc)。

---

## 四、高可用方案

PG 内核只提供复制，不负责故障检测和自动切换，需要外部组件：

| 方案 | 原理 | 说明 |
|------|------|------|
| **Patroni** | 每个节点运行 Patroni 代理，借助 etcd / Consul / ZooKeeper 或 Kubernetes API 做选主与拓扑管理 | 主流方案；Zalando Postgres Operator（Spilo 镜像）与 Crunchy PGO 都基于它 |
| **CloudNativePG** | Kubernetes Operator，以 Kubernetes API 作为集群状态的唯一来源，自带实例管理器负责切换 | 不使用 Patroni，适合全面上 K8s 的团队 |
| repmgr | 复制管理工具，带 repmgrd 守护进程做自动切换 | 不依赖分布式一致性存储，脑裂防护较弱 |
| pg_auto_failover | 独立 monitor 节点仲裁主备状态 | 部署简单，monitor 自身需要保护 |

Patroni 典型架构：应用经 HAProxy（或 VIP、PgBouncer）访问，HAProxy 通过 Patroni 的 REST 健康检查端口识别当前主库；三个及以上 etcd 节点保存领导者租约，主库失联时由存活节点竞选并提升备库，旧主恢复后用 `pg_rewind` 重新加入。

不想部署代理时，PgJDBC 支持多主机连接串，按角色自动选择节点：

```properties
# 写连接：只连主库
spring.datasource.url=jdbc:postgresql://node1:5432,node2:5432,node3:5432/mydb?targetServerType=primary
# 读连接：优先备库，均衡分布
# jdbc:postgresql://node1:5432,node2:5432,node3:5432/mydb?targetServerType=preferSecondary&loadBalanceHosts=true
```

切换期间旧连接会报错，应用侧要配合连接池的失效检测和事务重试。系统级的故障转移策略见 [冗余与故障转移](/high-avail/2_redundancy_failover)。

---

## 五、与 MySQL 复制体系对照

| | PostgreSQL | MySQL |
|---|---|---|
| 复制载体 | WAL（物理）/ 逻辑解码 | binlog（逻辑，推荐 ROW） |
| 位点 | LSN | GTID / 文件名 + 位置 |
| 接近半同步的配置 | `synchronous_commit = remote_write` + `synchronous_standby_names` | semi-sync（AFTER_SYNC） |
| 备库重放 | startup 单进程重放；写入量大或与备库查询冲突时可能积压 | 8.0.27 起默认多线程应用（`replica_parallel_workers = 4`） |
| 自动故障切换 | 需 Patroni、CloudNativePG 等外部组件 | InnoDB Cluster（MGR + MySQL Shell + MySQL Router）或 Orchestrator 等 |
| 跨版本复制 | 逻辑复制可跨任意受支持版本 | 支持从低版本源复制到高一个系列的副本（如 8.0 → 8.4 LTS → 9.x） |

MySQL 侧详见 [MySQL 主从与高可用](../1_mysql/9_topic_replication)。

---

## 小结

- PG 每连接一进程，生产必须两层池：HikariCP + PgBouncer；transaction 模式下的预编译语句需要 PgBouncer 1.21+ 或 `prepareThreshold=0`
- WAL 同时承担崩溃恢复与复制，没有独立 binlog；物理复制让备库与主库逐字节一致
- 搭建备库要准备 `REPLICATION` 角色和 `pg_hba.conf` 的 replication 条目，`hot_standby_feedback` 以主库膨胀为代价换备库查询不被取消
- `synchronous_commit` 的远程级别只在配置了 `synchronous_standby_names` 时生效；默认 `on` 等待备库刷盘，`remote_write` 才是与 MySQL 半同步最接近的级别
- 复制槽防止 WAL 被提前删除，也可能撑爆磁盘；用 `max_slot_wal_keep_size`（13+）、`idle_replication_slot_timeout`（18+）兜底并监控 `wal_status`
- 逻辑复制需要主键或 REPLICA IDENTITY，不复制 DDL、序列和大对象；CDC 工具通过逻辑复制槽 + `pgoutput` 读取变更
- 故障切换靠外部组件：Patroni 最常见，CloudNativePG 不依赖 Patroni；JDBC 可用多主机 + `targetServerType` 免代理

## 参考资料

- 高可用、负载均衡与复制：[https://www.postgresql.org/docs/18/high-availability.html](https://www.postgresql.org/docs/18/high-availability.html)
- 复制相关参数：[https://www.postgresql.org/docs/18/runtime-config-replication.html](https://www.postgresql.org/docs/18/runtime-config-replication.html)
- synchronous_commit：[https://www.postgresql.org/docs/18/runtime-config-wal.html](https://www.postgresql.org/docs/18/runtime-config-wal.html)
- 逻辑复制：[https://www.postgresql.org/docs/18/logical-replication.html](https://www.postgresql.org/docs/18/logical-replication.html)
- PgBouncer 配置：[https://www.pgbouncer.org/config.html](https://www.pgbouncer.org/config.html)
- PgJDBC 连接参数：[https://jdbc.postgresql.org/documentation/use/](https://jdbc.postgresql.org/documentation/use/)
- Patroni：[https://patroni.readthedocs.io/](https://patroni.readthedocs.io/)
- CloudNativePG：[https://cloudnative-pg.io/](https://cloudnative-pg.io/)

> 下一篇：[其他 RDBMS](../3_relational/0_other_rdbms) —— Oracle、SQL Server 与达梦、人大金仓、openGauss 等国产库的方言差异和接入要点。

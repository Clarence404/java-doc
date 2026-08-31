# PostgreSQL 专项 - 复制与高可用

## 一、进程模型与连接池

PostgreSQL 与 MySQL 在连接架构上有本质差异：

| | PostgreSQL | MySQL |
|---|---|---|
| 连接模型 | **每连接一个进程**（fork）| 每连接一个线程 |
| 单连接开销 | 大（约 5~10MB 内存 + fork 成本）| 小 |
| 默认 `max_connections` | 100 | 151 |
| 高并发短连接 | ❌ 灾难，必须上连接池 | 相对耐受 |

因此 PG 生产环境几乎必配 **PgBouncer**（轻量连接池代理）：

```ini
; pgbouncer.ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
listen_port = 6432
pool_mode = transaction     ; 见下表
max_client_conn = 2000      ; 面向应用的连接数
default_pool_size = 20      ; 面向 PG 的真实连接数
```

| pool_mode | 归还连接的时机 | 限制 |
|-----------|---------------|------|
| session | 客户端断开 | 复用率最低 |
| **transaction（常用）** | 事务结束 | 不能用会话级特性（`SET`、PREPARE、advisory lock）|
| statement | 每条语句 | 限制最多，极少用 |

> 应用侧仍保留 HikariCP（管理到 PgBouncer 的连接），两层池并不冲突：HikariCP 控制应用并发，PgBouncer 收敛数据库真实连接数。

---

## 二、WAL 与流复制（Streaming Replication）

PG 的物理复制基于 **WAL**（Write-Ahead Log，对应 MySQL 的 redo log 角色，但同时承担了复制职能——PG 没有独立的 binlog）：

```
主库 walwriter → WAL 段文件 → walsender ══网络══> 备库 walreceiver → 重放（startup process）
```

### 搭建要点

```ini
# 主库 postgresql.conf
wal_level = replica
max_wal_senders = 10
```

```bash
# 备库：pg_basebackup 拉取基础备份并自动配置（-R 生成连接信息）
pg_basebackup -h 主库IP -U repl -D /var/lib/pgsql/data -P -R
# 备库数据目录出现 standby.signal 文件即以只读备库模式启动
```

### 同步级别（synchronous_commit）

| 值 | 主库提交等待 | 对应 MySQL 概念 |
|----|-------------|----------------|
| `off` | 不等本地 WAL 落盘 | `innodb_flush_log_at_trx_commit=0` |
| `local`（默认 on 的本地部分）| 本地 WAL 落盘 | 双 1 |
| `remote_write` | 备库收到 WAL（未落盘）| 半同步近似 |
| `on` / `remote_apply` | 备库落盘 / 备库已重放 | 强于 MySQL 半同步 |

```ini
# 指定同步备库（其余为异步）
synchronous_standby_names = 'FIRST 1 (standby1, standby2)'
```

### Replication Slot（复制槽）

备库断连期间，主库靠复制槽**保留其尚未消费的 WAL**，防止备库回来后发现日志已被清理：

```sql
SELECT * FROM pg_create_physical_replication_slot('standby1_slot');
-- ⚠️ 雷区：备库长期失联时槽会让 WAL 无限堆积撑爆磁盘
-- 13+ 用 max_slot_wal_keep_size 设上限
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

---

## 三、逻辑复制（Logical Replication，10+）

按**表级别**发布/订阅行变更（解析 WAL 为逻辑行事件），角色类似 MySQL 的 ROW binlog 订阅：

```sql
-- 发布端
CREATE PUBLICATION pub_orders FOR TABLE orders, order_items;

-- 订阅端（可以是另一个大版本的 PG！）
CREATE SUBSCRIPTION sub_orders
  CONNECTION 'host=主库IP dbname=mydb user=repl password=xxx'
  PUBLICATION pub_orders;
```

### 物理复制 vs 逻辑复制

| | 流复制（物理）| 逻辑复制 |
|---|---|---|
| 粒度 | 整个实例 | 表级 |
| 备库可写 | ❌ 只读 | ✅ 非订阅表可写 |
| 跨大版本 | ❌ | ✅（**大版本升级利器**）|
| DDL 同步 | ✅（物理页级）| ❌ 需手工执行 |
| 典型用途 | 高可用、读扩展 | 数据分发、升级、异构同步（Debezium 底层）|

---

## 四、高可用方案

PG 内核只提供复制，**故障切换需要外部组件**：

| 方案 | 原理 | 特点 |
|------|------|------|
| **Patroni（主流）** | 基于 etcd/Consul 的分布式选主，管理 PG 拓扑 | K8s 友好（CloudNativePG / Zalando Operator 底层）|
| repmgr | 复制管理 + 手动/自动 failover | 轻量，无外部依赖 |
| pg_auto_failover | Citus 出品，monitor 节点仲裁 | 三节点起步，配置简单 |

Patroni 典型架构：`HAProxy / VIP → Patroni(PG) × N ← etcd 集群`，应用通过 HAProxy 的健康检查端口自动路由到主节点。

> JDBC 侧也可多主机串免去代理：`jdbc:postgresql://node1:5432,node2:5432/mydb?targetServerType=primary`

---

## 五、与 MySQL 复制体系对照

| | PostgreSQL | MySQL |
|---|---|---|
| 复制载体 | WAL（物理）/ 逻辑解码 | binlog（逻辑，ROW/STATEMENT）|
| 位点 | LSN | GTID / file+pos |
| 半同步对应 | `synchronous_commit = on` | semi-sync plugin |
| 并行重放 | 单进程重放（物理复制天然快）| 5.7+ 并行复制 |
| 自动故障切换 | 需 Patroni 等外部组件 | MGR / InnoDB Cluster 原生 |
| 跨版本复制 | 逻辑复制支持 | 仅相邻大版本主从 |

MySQL 侧详见 [MySQL Binlog、主从复制与高可用专项](../1_mysql/9_topic_replication)。

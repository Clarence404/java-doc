# MySQL 专项 - Binlog、主从复制与高可用

## 一、Binlog

### 概念

Binlog 是 **Server 层**的二进制日志，记录所有**修改操作**（INSERT / UPDATE / DELETE 及 DDL），不记录 SELECT。三大用途：

1. **主从复制**：主库通过 binlog 把数据变更传给从库
2. **数据恢复**：基于备份 + binlog 做 Point-in-Time 恢复
3. **数据订阅**：Canal / Debezium 等 CDC 工具伪装成从库消费 binlog（见 [CDC 工具](../5_practice/0_cdc_tools)）

> Binlog（Server 层、逻辑日志、追加写）与 redo log（InnoDB 层、物理日志、循环写）的对比，见 [事务专项](./5_topic_transaction)。

### 三种格式

| 格式 | 记录内容 | 优点 | 缺点 |
|------|---------|------|------|
| **STATEMENT** | SQL 语句原文 | 日志小 | `NOW()`、`UUID()` 等主从执行结果可能不一致 |
| **ROW（推荐）** | 变更前后的行数据 | 精确一致，CDC 依赖此格式 | 日志体积大（批量更新逐行记录）|
| **MIXED** | 自动切换 | 折中 | 排查问题时格式不统一 |

### 配置与管理

```ini
[mysqld]
server-id     = 1
log_bin       = mysql-bin
binlog_format = ROW
# 8.0 用 binlog_expire_logs_seconds（expire_logs_days 已弃用）
binlog_expire_logs_seconds = 604800   # 7 天
```

```sql
SHOW BINARY LOGS;                    -- 所有 binlog 文件
SHOW MASTER STATUS;                  -- 当前写入位置
PURGE BINARY LOGS TO 'mysql-bin.000010';  -- 手动清理（确认从库已消费）
```

```bash
# 查看 ROW 格式内容（-v 解析出伪 SQL）
mysqlbinlog -v --base64-output=decode-rows mysql-bin.000001
```

---

## 二、主从复制原理

![MySQL 主从复制原理](../../assets/mysql/mysql-replication.svg)

**三个核心线程：**

| 线程 | 所在节点 | 职责 |
|------|---------|------|
| **Binlog Dump Thread** | 主库 | 监听 binlog 变化，将事件推送给从库 IO Thread |
| **IO Thread** | 从库 | 连接主库，接收 binlog 事件，写入本地 relay log |
| **SQL Thread** | 从库 | 读取 relay log，在从库重放，应用数据变更 |

复制是**异步**的：主库提交事务不等从库确认，这带来两类问题 —— **主从延迟**（读到旧数据）和**主库宕机丢数据**（binlog 未传到从库），分别对应下文的延迟优化和半同步复制。

---

## 三、GTID 复制（推荐）

GTID（全局事务 ID，`server_uuid:事务序号`）让从库**自动定位**复制位点，主从切换不再需要人工找 binlog 文件名 + offset：

```sql
-- 主库配置
[mysqld]
gtid_mode = ON
enforce_gtid_consistency = ON
log_bin = mysql-bin

-- 从库配置（GTID 模式自动定位）
CHANGE MASTER TO
  MASTER_HOST = '主库IP',
  MASTER_USER = 'repl',
  MASTER_PASSWORD = 'xxx',
  MASTER_AUTO_POSITION = 1;
START SLAVE;

-- 查看复制状态（关注 Slave_IO_Running / Slave_SQL_Running / Seconds_Behind_Master）
SHOW SLAVE STATUS\G
```

---

## 四、半同步复制

主库提交时**至少等一个从库确认已写入 relay log** 才向客户端返回成功，避免主库宕机导致已提交事务在从库不存在：

```sql
INSTALL PLUGIN rpl_semi_sync_master SONAME 'semisync_master.so';
SET GLOBAL rpl_semi_sync_master_enabled = ON;
SET GLOBAL rpl_semi_sync_master_timeout = 1000;  -- 1 秒超时，超时自动降级为异步
```

| 模式 | 数据安全 | 写入延迟 |
|------|---------|---------|
| 异步（默认）| 主库宕机可能丢最后一批事务 | 无额外延迟 |
| 半同步 | 至少一个从库有 relay log 副本 | +1 次网络往返 |
| MGR 强一致 | 多数派确认 | 最高 |

---

## 五、主从延迟与并行复制

### 常见延迟原因

| 原因 | 优化方案 |
|------|---------|
| 主库大事务（大批量 DML）| 拆分小事务，减少单次 binlog 体积 |
| SQL Thread 单线程重放 | 开启并行复制（见下）|
| 从库执行了大查询（分析、备份）| 分析类查询走专用从库 |
| 从库 IO 性能差 | 升级 SSD，或从库关闭 `sync_binlog=1` 等强持久化 |

### 并行复制的演进

| 版本 | 策略 | 并行粒度 |
|------|------|---------|
| 5.6 | 按库并行 | 单库场景无效 |
| 5.7 | `LOGICAL_CLOCK`：主库**组提交**的事务在从库并行重放 | 事务级，依赖主库并发度 |
| 8.0 | `WRITESET`：按行冲突检测，不冲突即并行 | 行级，效果最好 |

```ini
[mysqld]
# 8.0.26 前参数名为 slave_parallel_*
replica_parallel_type    = LOGICAL_CLOCK   # 8.0 建议配合 WRITESET
replica_parallel_workers = 8
binlog_transaction_dependency_tracking = WRITESET  # 主库侧
```

### 业务层应对延迟

- **强制读主**：写后立即读的场景（下单后跳转详情）路由到主库
- **会话级 GTID 等待**：`WAIT_FOR_EXECUTED_GTID_SET` 等从库追上再读
- **接受最终一致**：列表页等场景容忍秒级延迟

---

## 六、高可用方案对比

| 方案 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| **MHA** | 主库故障时从各从库中选**数据最新者**为新主，并补齐差异 binlog | 成熟稳定，切换快（30s 内）| 需额外 MHA Manager 节点，项目已不活跃 |
| **MGR（组复制）** | 基于 Paxos 的多数派投票，数据强一致 | 官方原生，自动故障切换 | 配置复杂，跨机房延迟敏感 |
| **InnoDB Cluster** | MGR + MySQL Shell + MySQL Router 封装 | 官方推荐组合，运维友好 | 要求 MySQL 8.0+ |
| **Orchestrator + 半同步** | 拓扑管理工具 + 半同步保证数据 | 灵活，GitHub 等大厂验证 | 需自行搭建配套 |

> 云上（RDS / Aurora）高可用由云厂商托管，自建时 8.0 首选 InnoDB Cluster。

---

## 七、读写分离

- **应用层**：ShardingSphere-JDBC 等在 JDBC 层拦截，写主读从，无额外网络跳数
- **代理层**：ProxySQL / MySQL Router，对应用透明，但多一跳且代理自身需高可用
- 读写分离必须直面**主从延迟**问题（见第五节业务层应对）
- 分库分表见 [数据库中间件](../5_practice/2_sharding)

---

## 八、相关专项

- redo log 与 binlog 的两阶段提交 → [事务、MVCC 与锁专项](./5_topic_transaction)
- binlog 订阅与数据同步 → [CDC 工具](../5_practice/0_cdc_tools)
- 备份恢复策略 → [数据备份与恢复](../5_practice/1_backup_recovery)

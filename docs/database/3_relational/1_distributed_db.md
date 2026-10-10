---
description: TiDB 架构与事务、OceanBase 多副本与多租户、选型对比、Aurora / PolarDB 存算分离
---

# 分布式数据库

> 前置阅读：[MySQL 基础](../1_mysql/0_overview)、[其他 RDBMS](./0_other_rdbms)

TiDB、OceanBase 这类分布式数据库对外提供 SQL 与事务，内部切片并多副本复制，加节点就能扩容。本篇讲两者的实现、MySQL 兼容差异及与 Aurora、PolarDB 的选型，基线为 TiDB 8.5。

---

## 一、TiDB

OceanBase 部分以 4.x 为基线。

### 1、定位与特点

- PingCAP 开源（Apache 2.0）的分布式数据库，**兼容 MySQL 8.0 协议**，`SELECT VERSION()` 返回形如 `8.0.11-TiDB-v8.5.x`，支持 CTE、窗口函数、角色等 8.0 特性
- **HTAP**：行存 TiKV 处理事务，列存 TiFlash 处理分析，同一份数据
- 计算层（TiDB Server）无状态，存储层（TiKV）按 Region 分片，两层可以分别扩容
- 每个 Region 3 副本 Raft 复制，多数派写成功即提交，单节点故障不丢数据

### 2、整体架构

![TiDB 整体架构](../../assets/database/tidb-architecture.svg)

| 组件 | 职责 |
|------|------|
| TiDB Server | SQL 解析、优化、执行；无状态，可水平扩展 |
| PD | 集群元数据、Region 调度、TSO 全局授时 |
| TiKV | 基于 Raft 的分布式 KV 存储，数据按 Region 分片，底层 RocksDB |
| TiFlash | 列存副本，以 Raft Learner 身份异步复制 TiKV 数据，加速分析查询 |

### 3、TiKV：Region 与 Raft

![TiKV：Region 分片与 Raft 副本](../../assets/database/tidb-region-raft.svg)

- 表数据和索引都编码成有序的 Key，整个 Key 空间按范围切成 **Region**；v8.4.0 起 Region 默认分裂阈值为 256 MiB（之前为 96 MiB）
- 每个 Region 的副本组成一个 Raft Group，读写都走 Leader；PD 负责分裂、合并和 Leader 均衡
- 按范围分片意味着单调递增主键的写入会集中在最后一个 Region，形成写热点，建表时用 `AUTO_RANDOM` 或 `SHARD_ROW_ID_BITS` 打散

### 4、HTAP：TiFlash 列存副本

- **复制方式**：TiFlash 以 Raft Learner 加入 Region 的 Raft Group，异步接收日志，不参与投票，不拖慢 TiKV 写入
- **一致性读**：查询 TiFlash 时先通过 Raft Read Index 确认 Leader 的最新日志位置，等本地追上后再按事务的快照时间戳读取，所以读到的数据与 TiKV 一致，不是“最终一致”
- **引擎选择**：优化器按代价在 TiKV 与 TiFlash 之间选择，也可以用会话变量 `tidb_isolation_read_engines` 或 Hint 指定；大表聚合、Join 在 TiFlash 上可以走 MPP 模式并行执行
- 给表加列存副本：`ALTER TABLE orders SET TIFLASH REPLICA 1;`

### 5、事务模型

TiDB 的事务基于 **Percolator** 模型：

1. 事务开始时从 PD 取 `start_ts` 作为快照版本
2. **Prewrite**：选一个 Key 作为 Primary，对所有写入的 Key 加锁并写入数据，锁记录指向 Primary
3. **Commit**：再取 `commit_ts`，提交 Primary Key 即代表事务提交成功；Secondary Key 的锁随后异步清理

5.0 起默认开启 **Async Commit** 与 **1PC**（只涉及一个 Region 的事务一阶段提交），提交延迟明显降低。冲突处理有两种模式：

| 模式 | 特点 | 适用场景 |
|------|------|---------|
| 悲观事务（新集群默认） | 执行 DML 时就加锁，行为接近 MySQL | 冲突较多、要与 MySQL 行为一致 |
| 乐观事务 | 提交时才检测冲突，冲突则报错，需要应用重试 | 冲突极少、追求吞吐 |

```sql
-- 会话级切换事务模式
SET SESSION tidb_txn_mode = 'optimistic';

-- 单个事务显式指定模式
BEGIN PESSIMISTIC;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

隔离级别方面，TiDB 的 REPEATABLE READ 实际是**快照隔离**；悲观锁只锁定已存在的行，**没有 Gap Lock**，无法像 InnoDB 那样阻止其他事务在范围内插入新行。依赖 `SELECT ... FOR UPDATE` 锁住范围来防止并发插入的逻辑，迁移时需要改为唯一约束或显式的锁记录。

### 6、与 MySQL 的兼容性

| 特性 | TiDB 8.5 的情况 |
|------|----------------|
| 存储过程、触发器、事件、自定义函数 | 不支持 |
| 外键 | v6.6 引入，**v8.5 正式 GA**；对性能有影响，上线前需压测 |
| FULLTEXT 索引 | 自建 TiDB 不支持；TiDB Cloud 提供全文检索能力 |
| 自增 ID | 默认每个 TiDB Server 缓存一段 ID，全局唯一但不连续、不保证递增；v6.4 起 `AUTO_ID_CACHE=1` 提供与 MySQL 一致的集中分配；写热点场景推荐 `AUTO_RANDOM` |
| 隔离级别与锁 | REPEATABLE READ 为快照隔离，悲观模式无 Gap Lock（见上节） |
| 大事务 | 单事务大小受 `txn-total-size-limit` 限制，批量写入要分批提交 |

### 7、适用场景

| 场景 | 是否适合 | 原因 |
|------|---------|------|
| MySQL 单机容量或写入瓶颈 | 适合 | 水平扩展，协议兼容，业务改动小 |
| 需要实时分析（HTAP） | 适合 | TiFlash 列存副本，无需 ETL |
| 多副本强一致、自动故障转移 | 适合 | Raft 多数派提交 |
| 单次请求要求亚毫秒延迟 | 不适合 | TSO 获取与跨节点提交带来额外 RT |
| 数据量小、单机 MySQL 足够 | 不适合 | 最小生产拓扑约为 3 PD + 3 TiKV + 2 TiDB，硬件与运维成本远高于主从 MySQL |

---

## 二、OceanBase

### 1、定位与特点

- 2010 年起源于淘宝，后在蚂蚁集团体系内发展，现由蚂蚁集团旗下的北京奥星贝斯科技有限公司（OceanBase）运营；核心验证场景是支付宝、网商银行的交易与账务系统，以及双十一大促
- 同一集群可以创建 MySQL 模式与 Oracle 模式（企业版）的租户
- 原生多租户：租户之间 CPU、内存、日志盘等资源隔离
- 存储引擎基于 LSM-Tree，基线数据做编码压缩，官方给出的存储成本相比 MySQL 可显著降低
- 社区版采用木兰公共许可证 MulanPubL-2.0，企业版商业授权
- 4.0 起采用单机分布式一体化架构，小规格部署也可以运行；4.3 起提供列存引擎，增强 HTAP

### 2、整体架构

![OceanBase 架构与 Paxos 高可用](../../assets/database/oceanbase-architecture.svg)

| 组件 | 职责 |
|------|------|
| ODP（OceanBase Database Proxy，原 OBProxy） | 连接管理、SQL 路由到 Leader 副本、负载均衡 |
| OBServer | SQL 引擎 + 存储引擎 + 事务引擎，计算存储一体 |
| RootService | 运行在某个 OBServer 上，负责集群元数据、DDL、资源调度 |
| Zone | 物理隔离的可用区（机房），副本跨 Zone 部署 |

### 3、Paxos 多副本高可用

- 4.x 中数据按**日志流**组织，每个日志流的多个副本通过 Multi-Paxos 同步 redo 日志，多数派持久化即提交
- **RPO = 0**：少数派副本所在 Zone 故障不丢数据
- **RTO < 8s**：4.0 引入新的选举协议后，官方给出的故障恢复时间从 3.x 的 30 秒缩短到 8 秒以内

### 4、存储引擎：LSM-Tree 变体

![OceanBase 存储引擎：LSM 树变体](../../assets/database/oceanbase-lsm.svg)

- 写入先进 MemTable，转储为增量 SSTable，每日（或按策略）合并（Major Compaction）为基线 SSTable
- 基线数据在微块内做字典、RLE、差值等编码后再通用压缩，这是存储成本低的主要原因；合并在业务低峰执行，可以降低对在线写入的影响
- 4.3 起支持**列存表**，并可设置行列混存，让 OLTP 走行存、OLAP 扫描走列存：

```sql
-- 纯列存表
CREATE TABLE sales_fact (
    id     BIGINT PRIMARY KEY,
    region VARCHAR(32),
    amount DECIMAL(12, 2)
) WITH COLUMN GROUP (each column);

-- 行列混存：同一张表同时保留行存与列存
CREATE TABLE orders_htap (
    id     BIGINT PRIMARY KEY,
    status TINYINT,
    amount DECIMAL(12, 2)
) WITH COLUMN GROUP (all columns, each column);
```

### 5、多租户

```sql
-- 资源规格：每个 Unit 的 CPU 与内存
CREATE RESOURCE UNIT biz_unit MAX_CPU = 4, MEMORY_SIZE = '8G';

-- 资源池：每个 Zone 放几个 Unit
CREATE RESOURCE POOL biz_pool UNIT = 'biz_unit', UNIT_NUM = 1, ZONE_LIST = ('z1', 'z2', 'z3');

-- 租户：相当于一个独立的数据库实例
CREATE TENANT biz_tenant
    RESOURCE_POOL_LIST = ('biz_pool')
    SET ob_compatibility_mode = 'mysql', ob_tcp_invited_nodes = '%';
```

租户之间 CPU、内存、日志盘隔离，一套集群可以承载多条业务线，也适合多租户 SaaS 按大客户划分租户。

### 6、Oracle 兼容模式

企业版的 Oracle 模式租户支持 PL/SQL 存储过程、函数、触发器、包，Oracle 内置函数（`NVL`、`DECODE`、`ROWNUM` 等）、序列和 `PIVOT`，适合 Oracle 迁移场景。迁移仍需要逐项验证执行计划和边缘语法。

---

## 三、TiDB 与 OceanBase 选型对比

应用层分库分表与分布式数据库的系统级取舍见 [数据层扩展](/high-con/5_data_scaling)，分布式事务的通用理论见 [分布式事务](/distributed/4_transaction)。

| 维度 | TiDB | OceanBase |
|------|------|-----------|
| 开源协议 | Apache 2.0 | 社区版 MulanPubL-2.0，企业版商业授权 |
| MySQL 兼容 | 较好（8.0 协议） | 较好 |
| Oracle 兼容 | 不支持 | 支持（企业版 Oracle 模式租户） |
| 一致性协议 | Raft（按 Region） | Multi-Paxos（按日志流） |
| HTAP | 原生支持（TiFlash 列存副本 + MPP） | 支持（4.3+ 列存表、行列混存） |
| 存储压缩 | 一般（RocksDB 压缩） | 高（基线编码 + 压缩） |
| 多租户 | 资源管控（Resource Control） | 原生租户隔离 |
| 部署形态 | 计算、存储分层部署 | 计算存储一体，支持单机到多 Zone |
| 运维难度 | 中等，组件较多 | 较高，需熟悉租户与资源模型 |
| 典型场景 | MySQL 扩容、HTAP、互联网业务 | 金融核心、Oracle 迁移、多租户 SaaS |

各类数据库的整体选型思路见 [数据库选型参考](../6_reference/1_selection_guide)；本节是 TiDB 与 OceanBase 对比的主文档。

---

## 四、云原生数据库：Aurora 与 PolarDB

与 TiDB、OceanBase 的 Shared-Nothing 分片路线不同，Aurora、PolarDB 的主力形态走 **存算分离 + 共享存储** 路线：

![两条扩展路线：Shared-Nothing 与 Shared-Storage](../../assets/database/cloud-native-db-shared-storage.svg)

- **日志即数据库**：写节点只把 redo 下推到分布式存储，存储层自行回放生成数据页，网络 IO 大幅减少
- **加只读节点不复制数据**：只读节点与写节点共享同一份存储，分钟级扩容，主从延迟通常在毫秒级

| | AWS Aurora | 阿里云 PolarDB |
|---|---|---|
| 兼容内核 | MySQL / PostgreSQL | MySQL / PostgreSQL / PostgreSQL（兼容 Oracle 语法） |
| 共享存储形态 | 1 写 + 最多 15 只读，存储跨 3 个 AZ 6 副本 | 1 写 + 多只读，RDMA 互联的分布式存储 |
| 写扩展 | Aurora PostgreSQL Limitless Database（2024 年 GA）按分片扩展写入；Aurora DSQL（2025 年 GA）是兼容 PostgreSQL 的分布式多活数据库；Aurora MySQL 早期的多主模式已停止支持 | PolarDB for MySQL 多主集群（Limitless）；独立产品 PolarDB-X 为 Shared-Nothing 分布式数据库 |

**与 NewSQL 的选型分界**：

- 读多写少、想从 RDS 平滑升级、运维投入少：选**云原生共享存储数据库**，数据不用重新分片
- 写入量超出单写节点、需要 HTAP、跨云或自建机房：选 **TiDB / OceanBase**，或云厂商的分布式形态（Aurora Limitless、PolarDB-X）

---

## 小结

- TiDB 8.5 兼容 MySQL 8.0 协议；数据按 Region（8.4 起默认 256 MiB）分片，Raft 3 副本；单调递增主键会形成写热点，用 `AUTO_RANDOM` 打散
- TiDB 事务基于 Percolator（TSO、Primary Lock、Prewrite / Commit），5.0 起默认 Async Commit 与 1PC；RR 为快照隔离，悲观模式无 Gap Lock
- TiDB 8.5 外键 GA，仍不支持存储过程、触发器、自定义函数，自建版不支持 FULLTEXT
- TiFlash 以 Raft Learner 异步复制，通过 Read Index 保证一致性读，优化器自动选择行存或列存
- OceanBase 4.x 基于日志流 Multi-Paxos，RPO = 0、RTO < 8s；原生多租户，4.3 起支持列存与行列混存，Oracle 模式适合 Oracle 迁移
- Aurora、PolarDB 主力形态是存算分离、单写多读；写扩展需要 Aurora Limitless / DSQL、PolarDB 多主或 PolarDB-X

## 参考资料

- TiDB 文档：[https://docs.pingcap.com/tidb/stable/](https://docs.pingcap.com/tidb/stable/)
- TiDB 与 MySQL 兼容性：[https://docs.pingcap.com/tidb/stable/mysql-compatibility/](https://docs.pingcap.com/tidb/stable/mysql-compatibility/)
- TiDB 外键约束：[https://docs.pingcap.com/tidb/stable/foreign-key/](https://docs.pingcap.com/tidb/stable/foreign-key/)
- TiKV 概述：[https://docs.pingcap.com/tidb/stable/tikv-overview/](https://docs.pingcap.com/tidb/stable/tikv-overview/)
- TiDB 悲观事务：[https://docs.pingcap.com/tidb/stable/pessimistic-transaction/](https://docs.pingcap.com/tidb/stable/pessimistic-transaction/)
- TiFlash 概述：[https://docs.pingcap.com/tidb/stable/tiflash-overview/](https://docs.pingcap.com/tidb/stable/tiflash-overview/)
- OceanBase 文档：[https://en.oceanbase.com/docs/](https://en.oceanbase.com/docs/)
- Amazon Aurora PostgreSQL Limitless Database：[https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/limitless.html](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/limitless.html)
- Amazon Aurora DSQL：[https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html)
- PolarDB 文档：[https://help.aliyun.com/zh/polardb/](https://help.aliyun.com/zh/polardb/)

> 下一篇：[ORM 框架](./2_orm_framework) —— MyBatis 的缓存、分页、Mapper 代理、执行器、TypeHandler 与插件原理，以及 Hibernate 的持久化上下文。

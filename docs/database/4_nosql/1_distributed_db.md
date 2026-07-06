# Distributed DB

## 一、TiDB

### 1、定位与特点

- PingCAP 开源的 **NewSQL 分布式数据库**，兼容 MySQL 5.7 协议
- **HTAP**：同时支持 OLTP（高并发事务）和 OLAP（实时分析）
- 水平扩展：计算层与存储层解耦，独立弹性扩容
- 金融级强一致性（Raft 多副本）

### 2、整体架构

```
Client（MySQL 驱动直连，无需改代码）
  ↓
TiDB Server（无状态 SQL 计算层）
  ↓
PD（Placement Driver，调度中心）
  ↓
TiKV（行存储，OLTP）    TiFlash（列存储，OLAP）
```

| 组件 | 职责 |
|------|------|
| TiDB Server | SQL 解析、优化、执行；无状态，可水平扩展 |
| PD | 集群元数据、Region 调度、TSO 全局授时 |
| TiKV | 基于 Raft 的分布式 KV 存储，数据按 Region 分片 |
| TiFlash | 列存副本，与 TiKV 实时同步，加速分析查询 |

### 3、TiKV 存储原理

数据按 **Region**（默认 96MB）分片，每个 Region 在 3 个节点上各有一个副本，通过 **Raft** 协议保证强一致：

```
数据空间（按 RowKey 排序）：
[a .... m][m .... z]
    ↓         ↓
 Region 1   Region 2
(Raft Group)(Raft Group)
 Leader + 2 Follower
```

- 底层使用 **RocksDB**（LSM 树）持久化
- 事务用 **Percolator** 两阶段提交，TSO 保证全局顺序

### 4、HTAP 原理

```
TiKV（行存，OLTP 写入）
    ↓ 异步实时同步（Raft learner）
TiFlash（列存，OLAP 读取）

优化器根据查询特征自动路由：
- 点查/事务  → TiKV
- 聚合分析   → TiFlash
```

无需 ETL，同一份数据两种访问模式，分析查询不影响 OLTP 性能。

### 5、事务模型

| 模式 | 特点 | 适用场景 |
|------|------|---------|
| 悲观事务（默认）| 与 MySQL 行为一致，先加锁 | 高冲突场景 |
| 乐观事务 | 提交时检测冲突，冲突重试 | 低冲突、高吞吐 |

```sql
-- 手动控制事务
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

### 6、与 MySQL 兼容性说明

TiDB 兼容 MySQL 5.7 大部分语法，以下特性**不支持或有差异**：
- 不支持存储过程、触发器、自定义函数（部分）
- 不支持 `FULLTEXT` 索引
- 自增 ID 在分布式场景不保证连续（全局唯一但有间隔）
- `SELECT ... FOR UPDATE` 语义与 MySQL 略有差异

### 7、适用场景

| 场景 | 适合 |
|------|------|
| MySQL 单机容量/性能瓶颈 | ✅ 水平扩展，业务代码改动极小 |
| 需要实时 HTAP | ✅ TiFlash 列存 |
| 金融级强一致性 | ✅ Raft 多副本 |
| 超低延迟（< 1ms）| ❌ 分布式引入额外 RT |
| 数据量 < 1 亿行 | ❌ MySQL 即可满足，TiDB 运维成本高 |

---

## 二、OceanBase

### 1、定位与特点

- 蚂蚁集团自研，支撑淘宝双十一的**金融级分布式关系数据库**
- 已在支付宝核心账务系统（资金流水）大规模验证
- 兼容 MySQL 和 Oracle 双模式
- 极致存储压缩：相比 MySQL 节省 70%~90% 存储空间
- 原生多租户架构

### 2、整体架构

```
OBProxy（连接代理，连接复用、路由）
  ↓
OBServer Zone1 | OBServer Zone2 | OBServer Zone3
（计算 + 存储一体，无共享架构）
```

| 组件 | 职责 |
|------|------|
| OBProxy | 连接池管理、SQL 路由、负载均衡 |
| OBServer | SQL 引擎 + 存储引擎（计算存储一体）|
| RootService | 集群元数据、DDL 执行、负载均衡 |
| Zone | 物理隔离的可用区，跨 Zone 部署保证高可用 |

### 3、Paxos 多副本高可用

```
Zone1（主副本 Leader）
Zone2（从副本 Follower）
Zone3（从副本 Follower）

写入：Leader 接收写请求 → 同步给多数派（≥2个Zone）→ 提交
故障：Zone1 宕机 → Zone2/Zone3 Paxos 选主（< 30s）
```

- **RPO = 0**：任意一个 Zone 宕机，数据不丢失
- **RTO < 30s**：自动选主，业务快速恢复

### 4、存储引擎：LSM 树变体

```
写入 → MemTable（内存）
            ↓ Flush
         Minor SSTable（增量，磁盘）
            ↓ 定期合并（Major Compaction）
         Major SSTable（基线，高度压缩）
```

**高压缩原理**：
- 基线数据使用字典编码、Run-Length Encoding（RLE）、列式压缩
- 混合行列存储：OLTP 走行存，OLAP 走列存

### 5、多租户架构

```sql
-- 创建资源规格
CREATE RESOURCE UNIT biz_unit MAX_CPU = 4, MEMORY_SIZE = '8G';

-- 创建资源池
CREATE RESOURCE POOL biz_pool UNIT = 'biz_unit', UNIT_NUM = 2, ZONE_LIST = ('z1','z2','z3');

-- 创建租户（隔离的数据库实例）
CREATE TENANT biz_tenant
  RESOURCE_POOL_LIST = ('biz_pool')
  SET ob_compatibility_mode = 'mysql';  -- MySQL 兼容模式
```

租户间 CPU、内存、存储完全隔离，一套集群承载多个业务线。

### 6、Oracle 兼容模式

OceanBase 提供 Oracle 模式租户，支持：
- PL/SQL 存储过程、函数、触发器
- Oracle 特有函数（`NVL`、`DECODE`、`ROWNUM` 等）
- 序列（`CREATE SEQUENCE`）
- 行转列（`PIVOT`）

适合 Oracle 迁移场景，降低迁移成本。

---

## 三、TiDB vs OceanBase 选型对比

| 维度 | TiDB | OceanBase |
|------|------|-----------|
| 开源协议 | Apache 2.0（完全开源）| 社区版开源，企业版商业 |
| MySQL 兼容 | ✅ 较好 | ✅ 较好 |
| Oracle 兼容 | ❌ | ✅（Oracle 模式租户）|
| 一致性协议 | Raft | Paxos |
| HTAP | ✅ 原生（TiFlash 列存）| ⚠️ 部分（列存引擎）|
| 存储压缩 | 一般 | 极高（70%~90%）|
| 运维难度 | 中等 | 较高 |
| 社区生态 | 活跃，文档丰富 | 快速成长 |
| 成熟度验证 | 互联网大量使用 | 金融核心系统验证 |
| 适用场景 | MySQL 扩展、HTAP | 金融核心、Oracle 迁移、多租户 SaaS |

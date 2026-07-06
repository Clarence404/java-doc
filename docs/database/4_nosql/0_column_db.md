# Columnar DB

## 一、HBase

### 1、定位与特点

- Apache HBase 是基于 HDFS 的分布式列式 NoSQL 数据库
- 设计目标：**海量数据**（百亿行级别）的**随机实时读写**
- 核心适用场景：用户行为日志、消息存储、时序数据、Feed 流

**不适合场景**：复杂多表 JOIN、频繁聚合分析、数据量小（< 千万行）

### 2、数据模型

```
Table（表）
  └── RowKey（行键，唯一标识）
       └── Column Family（列族，物理存储单元）
            └── Column Qualifier（列限定符，动态添加）
                 └── Timestamp（版本号）
                      └── Value（字节数组）
```

**示例**：存储用户行为

| RowKey | cf:event | cf:device | cf:location |
|--------|----------|-----------|-------------|
| user_001_1700000000 | click | iPhone | Beijing |
| user_001_1700001000 | purchase | iPhone | Beijing |

### 3、架构组件

```
Client
  ↓
ZooKeeper（集群协调、RegionServer 发现）
  ↓
HMaster（DDL管理、Region分配、负载均衡）
  ↓
RegionServer × N（数据读写、Region管理）
  ↓
HDFS（底层存储）
```

| 组件 | 职责 |
|------|------|
| HMaster | DDL 操作、Region 分配、RegionServer 故障转移 |
| RegionServer | 承载 Region，处理读写请求，管理 MemStore/HFile |
| Region | 数据水平分片，按 RowKey 范围分割 |
| ZooKeeper | 集群状态管理、HMaster 选主 |

### 4、读写流程（LSM 树）

**写入流程**：
```
Client → RegionServer
  → 写 WAL（Write Ahead Log，防崩溃丢数据）
  → 写 MemStore（内存缓冲）
  → MemStore 满 → Flush 到 HDFS 生成 HFile
  → 后台 Compaction 合并 HFile
```

**读取流程**：
```
Client → RegionServer
  → BlockCache（内存）→ MemStore → HFile
  → 多版本合并，返回最新值
```

### 5、RowKey 设计（核心）

RowKey 决定数据分布和查询性能，**设计不当会导致热点问题**。

**热点问题**：所有请求打到同一 RegionServer（如时间戳递增 RowKey）

**解决方案**：

```java
// 方案1：Hash 前缀散列
String userId = "user_001";
String hashPrefix = String.valueOf(Math.abs(userId.hashCode()) % 16);  // 0~15
String rowKey = hashPrefix + "_" + userId + "_" + timestamp;
// 结果：数据均匀分散到 16 个 Region

// 方案2：反转手机号（前缀散列）
String phone = "13800138000";
String rowKey = new StringBuilder(phone).reverse() + "_" + timestamp;
// "00083100831_1700000000" → 前缀散列，避免热点

// 方案3：盐值（Salt）前缀
String salt = String.format("%02d", rowKey.hashCode() % 32);
String finalRowKey = salt + "_" + rowKey;
```

**设计原则**：
- **唯一性**：RowKey 必须全局唯一
- **散列性**：避免单调递增，防止热点
- **最短原则**：RowKey 越短越好（存储在每个 Cell 中）
- **查询友好**：把最常用的查询维度放到 RowKey 前缀

### 6、适用场景对比

| 场景 | 适合用 HBase | 不适合用 HBase |
|------|------------|--------------|
| 按 RowKey 点查 | ✅ 毫秒级 | — |
| 时序数据存储 | ✅ | — |
| 海量行（> 10 亿）| ✅ | — |
| 复杂 SQL 查询 | ❌ | → 用 Phoenix 扩展 |
| 多表 JOIN | ❌ | → 用 MySQL/Hive |
| 数据量 < 千万行 | ❌ | → 用 MySQL 即可 |

---

## 二、ClickHouse

### 1、定位与特点

- Yandex 开源的**列式 OLAP 数据库**，专为分析查询设计
- **核心优势**：亿级数据聚合查询秒级响应，写入吞吐率极高
- **不适合场景**：高频点查（单行查询慢）、频繁 UPDATE/DELETE、强事务

### 2、列存储优势

```
行存（MySQL）：读一行 = 读所有列
列存（ClickHouse）：只读查询涉及的列

SELECT sum(amount) FROM orders WHERE status = 'paid';
-- 行存：读取所有列（id, user_id, status, amount, created_at...）
-- 列存：只读 status 列 + amount 列，IO 减少 80%+
```

- **压缩率极高**：同列数据类型一致，LZ4/ZSTD 压缩比可达 10:1
- **向量化执行**：SIMD 指令批量处理，CPU 效率极高

### 3、MergeTree 引擎（核心）

```sql
CREATE TABLE events (
    event_date  Date,
    user_id     UInt64,
    event_type  String,
    amount      Float64
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)      -- 按月分区，便于过期清理
ORDER BY (event_date, user_id)          -- 主键 / 排序键（影响物理顺序）
SETTINGS index_granularity = 8192;      -- 稀疏索引粒度（每 8192 行一个索引点）
```

**核心概念**：

| 概念 | 说明 |
|------|------|
| 分区（Partition）| 按时间/字段分区，支持 DROP PARTITION 快速删除历史数据 |
| 排序键（ORDER BY）| 数据物理存储顺序，范围查询效率的关键 |
| 稀疏索引 | 每 8192 行记录一个索引点（非逐行索引），体积极小 |
| Part 文件 | 写入数据先生成 Part，后台异步 Merge（类 LSM） |

### 4、常用变体引擎

| 引擎 | 特点 | 适用场景 |
|------|------|---------|
| `MergeTree` | 基础引擎 | 通用 OLAP |
| `ReplacingMergeTree` | Merge 时去重（按排序键）| 幂等写入、去重 |
| `SummingMergeTree` | Merge 时对数值列求和 | 预聚合报表 |
| `AggregatingMergeTree` | Merge 时执行聚合函数 | 物化视图 |
| `CollapsingMergeTree` | 通过 +1/-1 标记实现删改 | 频繁更新场景 |
| `ReplicatedMergeTree` | 多副本高可用 | 生产环境 |

### 5、实用查询示例

```sql
-- 日活统计（走分区裁剪 + 排序键）
SELECT toDate(event_date) AS day, count(DISTINCT user_id) AS dau
FROM events
WHERE event_date >= '2024-01-01' AND event_date < '2024-02-01'
GROUP BY day ORDER BY day;

-- 漏斗分析
SELECT
    countIf(event_type = 'page_view')  AS pv,
    countIf(event_type = 'add_cart')   AS add_cart,
    countIf(event_type = 'purchase')   AS purchase,
    purchase / pv AS conversion_rate
FROM events
WHERE event_date = today();

-- 跳数索引（加速非排序键过滤）
ALTER TABLE events ADD INDEX idx_event_type (event_type) TYPE bloom_filter GRANULARITY 4;
```

### 6、分布式表架构

```sql
-- 步骤1：在所有节点创建本地表
CREATE TABLE events_local ON CLUSTER my_cluster (...)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, user_id);

-- 步骤2：创建分布式表（查询路由层）
CREATE TABLE events_all ON CLUSTER my_cluster AS events_local
ENGINE = Distributed(my_cluster, default, events_local, cityHash64(user_id));

-- 写入走本地表（直接写到对应 shard）
INSERT INTO events_local VALUES (...);

-- 查询走分布式表（自动路由到所有 shard 聚合）
SELECT count() FROM events_all WHERE event_date = today();
```

### 7、性能优化建议

- **合理设计 ORDER BY**：把高频过滤/GROUP BY 列放前面
- **分区裁剪**：查询条件包含分区键，避免全表扫描
- **物化视图**：对高频聚合提前计算，查询时直接读结果
- **避免高频 UPDATE/DELETE**：改用 `ReplacingMergeTree` 或 `CollapsingMergeTree`
- **批量写入**：单次插入 > 1000 行，避免小批量频繁写（会产生大量小 Part）

---

## 三、HBase vs ClickHouse 对比

| 维度 | HBase | ClickHouse |
|------|-------|------------|
| 数据模型 | 列族（KV 存储）| 列式关系表 |
| 查询类型 | RowKey 点查 | 聚合分析（OLAP）|
| 写入特性 | 高吞吐随机写 | 批量写入极快，不适合点写 |
| 读取延迟 | 毫秒级（点查）| 秒级（范围聚合）|
| SQL 支持 | 弱（需 Phoenix）| 标准 SQL 子集 |
| 事务支持 | 单行原子 | 无事务 |
| 扩展性 | 水平扩展（HDFS）| 分布式分片 |
| 典型场景 | 实时读写、消息、时序 | 日志分析、报表、BI |

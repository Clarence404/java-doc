---
description: 宽列 HBase、ClickHouse / Doris / StarRocks、MergeTree、分布式表、选型
---

# 列式与 OLAP 数据库

> **本篇目标**：分清「宽列存储」（HBase、Cassandra）与「列式 OLAP」（ClickHouse、Doris、StarRocks）这两类常被混称为「列式数据库」的产品，掌握 HBase 的 RowKey 设计和 ClickHouse 的 MergeTree、分布式表、去重与更新语义，能按场景选型。
>
> **前置阅读**：[MySQL 索引](../1_mysql/4_topic_index)（B+ 树与 LSM 的对比视角）、[数据库选型参考](../6_reference/1_selection_guide)

「列式数据库」这个词常被用来指两类差别很大的产品：

| 类别 | 代表 | 存储方式 | 擅长 |
|------|------|----------|------|
| 宽列存储（Wide-Column / 列族） | HBase、Cassandra | 按 RowKey 有序的 KV，列族内仍按行组织 | 海量数据的按键随机读写 |
| 列式 OLAP | ClickHouse、Apache Doris、StarRocks | 每列单独存储、压缩，向量化执行 | 大范围扫描与聚合分析 |

HBase 的「列族」只决定哪些列放进同一组文件，每个列族内部仍是按行键排列的 KV，它并不是分析型列存。两者解决的问题完全不同，下面分开讲。

---

## 一、HBase：宽列存储

### 1、定位与版本

- Apache HBase 是构建在 HDFS 上的分布式宽列存储，参考 Google Bigtable 设计
- 设计目标：百亿行级数据的**按 RowKey 随机实时读写**
- 适合：用户行为明细、消息存储、Feed、画像宽表、设备明细等「按键查」的海量数据
- 不适合：多表 JOIN、频繁的大范围聚合分析、数据量不大（千万行以内用 MySQL 即可）
- 版本：稳定线为 2.5 / 2.6，3.0 仍处于 beta 阶段

同属宽列存储的 **Apache Cassandra** 采用无中心的对等架构（无 Master、无 HDFS 依赖），可调一致性级别，适合多数据中心写入；国内大数据生态里 HBase 更常见，本篇不展开 Cassandra。

### 2、数据模型

![HBase 数据模型](../../assets/database/hbase-data-model.svg)

- **Table** 按 RowKey 范围水平切分成多个 Region
- **RowKey** 是唯一主键，数据按 RowKey 字典序存放
- **Column Family（列族）** 建表时定义，同一列族的数据存放在同一组 HFile 中，列族数量宜少（1~3 个）
- **Qualifier（列名）** 写入时可动态增加，不同行可以有不同的列
- **Timestamp** 是版本号，一个 Cell 可保留多个版本
- **Value** 是字节数组，HBase 不理解数据类型

示例：存储用户行为

| RowKey | cf:event | cf:device | cf:location |
|--------|----------|-----------|-------------|
| user_001_1700000000 | click | iPhone | Beijing |
| user_001_1700001000 | purchase | iPhone | Beijing |

### 3、架构组件

![HBase 架构](../../assets/database/hbase-architecture.svg)

| 组件 | 职责 |
|------|------|
| HMaster | DDL 操作、Region 分配、RegionServer 故障转移 |
| RegionServer | 承载 Region，处理读写请求，管理 MemStore / HFile |
| Region | 数据水平分片，按 RowKey 范围分割 |
| ZooKeeper | 集群状态管理、HMaster 选主 |

### 4、读写流程（LSM 树）

![HBase LSM 写入与读取流程](../../assets/database/hbase-lsm-flow.svg)

写入先追加 WAL 再写 MemStore，MemStore 满后 Flush 成 HFile，后台 Compaction 合并文件；读取依次查 BlockCache、MemStore 和多个 HFile 并合并版本，BloomFilter 用来跳过不含该行的文件。

### 5、RowKey 设计

RowKey 决定数据分布和查询方式，设计不当会导致**热点**：单调递增的 RowKey（如时间戳开头）会让所有新写入落在最后一个 Region 上。

常见的打散方法：

```java
import java.time.Instant;

public final class RowKeys {

    private static final int BUCKETS = 16;

    // 方案 1：Hash 前缀，前缀取值 0~15
    static String hashPrefixed(String userId, long timestamp) {
        int bucket = Math.floorMod(userId.hashCode(), BUCKETS);   // floorMod 保证非负
        return String.format("%02d_%s_%d", bucket, userId, timestamp);
    }

    // 方案 2：反转（手机号等前缀集中、尾部离散的字段）
    static String reversed(String phone, long timestamp) {
        return new StringBuilder(phone).reverse() + "_" + timestamp;
    }

    // 方案 3：对已有 RowKey 加盐
    static String salted(String rowKey, int saltBuckets) {
        int salt = Math.floorMod(rowKey.hashCode(), saltBuckets);
        return String.format("%02d_%s", salt, rowKey);
    }

    public static void main(String[] args) {
        long ts = Instant.now().getEpochSecond();
        System.out.println(hashPrefixed("user_001", ts));
        System.out.println(reversed("13800138000", ts));
        System.out.println(salted("order_20240101_0001", 32));
    }
}
```

注意两点：

- **要配合预分区**：新表默认只有一个 Region，前缀打散了也仍写在同一个 Region 上，建表时要按前缀预分区，如 `create 't', 'cf', SPLITS => ['01_', '02_', ..., '15_']`，或用 `NUMREGIONS` + `SPLITALGO`
- **范围扫描变成 N 路扫描**：加了 Hash / 盐前缀后，原本连续的 RowKey 范围被拆到 N 个桶里，客户端要分别 Scan N 次再合并；需要按时间范围扫描的场景，前缀用业务维度（如 userId 的 hash）而不是全局盐值

设计原则：

- **唯一性**：RowKey 全局唯一
- **散列性**：避免单调递增前缀
- **尽量短**：RowKey 存在每个 Cell 中，越长越费空间
- **查询友好**：最常用的查询维度放在前缀，便于前缀 Scan

### 6、适用场景

| 场景 | HBase 是否合适 | 替代方案 |
|------|----------------|----------|
| 按 RowKey 点查 / 前缀扫描 | 适合，毫秒级 | — |
| 海量明细写入（十亿行以上） | 适合 | — |
| 时序数据 | 可以，但专用 TSDB 更省心 | [时序数据库](./1_time_series_db) |
| 复杂 SQL 查询 | 不适合 | Phoenix 或导入 OLAP 引擎 |
| 多表 JOIN、聚合报表 | 不适合 | ClickHouse / Doris / StarRocks |
| 数据量在千万行以内 | 不必要 | MySQL |

---

## 二、ClickHouse：列式 OLAP

### 1、定位与版本

- 最初由 Yandex 开发并于 2016 年开源，2021 年独立为 ClickHouse Inc.，Apache 2.0 协议，当前主线为 25.x（每月发版，LTS 为每年的 .3 与 .8 版本）
- 擅长：亿级到百亿级数据的聚合查询秒级返回，批量写入吞吐高
- 不擅长：高并发单行点查、频繁的单行更新、多表大 JOIN、强事务

### 2、为什么列存适合分析

![行存与列存的读取对比](../../assets/database/row-vs-column-store.svg)

以 `SELECT sum(amount) FROM orders WHERE status = 'paid'` 为例：行存要把整行读进内存，列存只读 `status` 和 `amount` 两个列文件。

- **IO 少**：只读查询涉及的列
- **压缩率高**：同列数据类型一致、重复值多，LZ4 / ZSTD 配合 Delta、Gorilla 等编码，压缩比常在 5~10 倍以上
- **向量化执行**：按列批量处理，充分利用 SIMD

### 3、MergeTree 引擎

```sql
CREATE TABLE events (
    event_date  Date,
    user_id     UInt64,
    event_type  LowCardinality(String),
    amount      Decimal(18, 2)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, user_id)
SETTINGS index_granularity = 8192;
```

- `PARTITION BY` 按月分区，过期数据用 `ALTER TABLE ... DROP PARTITION` 整块删除
- `ORDER BY` 决定数据在 Part 内的物理顺序，同时是默认的主键（稀疏索引）
- `LowCardinality(String)` 对取值少的字符串做字典编码，适合 `event_type` 这类列
- 金额用 `Decimal` 而不是浮点

| 概念 | 说明 |
|------|------|
| 分区（Partition） | 按时间等字段划分，支持整分区删除、按分区裁剪 |
| 排序键（ORDER BY） | 数据物理顺序，范围过滤效率的关键 |
| 稀疏索引 | 每 `index_granularity`（默认 8192）行记录一个索引标记，体积小、可常驻内存 |
| Part | 每次 INSERT 生成一个不可变 Part，后台异步 Merge（类似 LSM） |

### 4、常用变体引擎

| 引擎 | 合并时的行为 | 适用场景 |
|------|--------------|----------|
| `MergeTree` | 只合并文件 | 通用 OLAP |
| `ReplacingMergeTree` | 按排序键去重，保留最新版本 | 幂等写入、按版本覆盖 |
| `SummingMergeTree` | 对数值列求和 | 预聚合报表 |
| `AggregatingMergeTree` | 合并聚合函数中间状态 | 配合物化视图做增量聚合 |
| `CollapsingMergeTree` | 通过 +1 / -1 标记行抵消 | 状态变更流 |
| `Replicated*MergeTree` | 以上引擎的多副本版本 | 生产环境高可用 |

**ReplacingMergeTree 不保证查询时已去重**：去重只发生在后台 Merge 时，且只在同一分区内进行，什么时候 Merge 不确定。要读到去重后的结果，查询需要显式处理：

```sql
-- 方式一：FINAL，查询时合并（新版本已并行化，但仍有额外开销）
SELECT * FROM user_profile FINAL WHERE user_id = 1001;

-- 方式二：argMax 按版本列取最新值
SELECT user_id, argMax(nickname, version) AS nickname
FROM user_profile
GROUP BY user_id;
```

### 5、查询示例

```sql
-- 日活统计（分区裁剪 + 排序键）
SELECT event_date AS day, uniqExact(user_id) AS dau
FROM events
WHERE event_date >= '2024-01-01' AND event_date < '2024-02-01'
GROUP BY day
ORDER BY day;

-- 漏斗
SELECT
    countIf(event_type = 'page_view') AS pv,
    countIf(event_type = 'add_cart')  AS add_cart,
    countIf(event_type = 'purchase')  AS purchase,
    purchase / pv                     AS conversion_rate
FROM events
WHERE event_date = today();
```

非排序键列的过滤可以用**跳数索引**加速，但跳数索引只对新写入的 Part 生效，已有数据要手动物化：

```sql
ALTER TABLE events ADD INDEX idx_user_bf (user_id) TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events MATERIALIZE INDEX idx_user_bf;
```

`bloom_filter` 适合高基数列的等值过滤；低基数列（如 `event_type`）用 `LowCardinality` 或 `set` 类型索引更合适。需要另一种排序方式的高频查询，可以用 **Projection**（同一张表内维护一份按其他键排序或预聚合的数据，由优化器自动选用）。

### 6、分布式表与副本

![ClickHouse 分布式表与副本拓扑](../../assets/database/clickhouse-distributed.svg)

```sql
-- 1. 每个节点建本地表（带副本）
CREATE TABLE events_local ON CLUSTER my_cluster
(
    event_date Date,
    user_id    UInt64,
    event_type LowCardinality(String),
    amount     Decimal(18, 2)
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events_local', '{replica}')
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, user_id);

-- 2. 建分布式表（只做路由，不存数据）
CREATE TABLE events_all ON CLUSTER my_cluster AS events_local
ENGINE = Distributed(my_cluster, default, events_local, cityHash64(user_id));

-- 3. 查询走分布式表：并行下发到各 shard 再汇总
SELECT count() FROM events_all WHERE event_date = today();
```

写入有两种方式，区别要清楚：

| 写入方式 | 数据去哪 | 说明 |
|----------|----------|------|
| INSERT 分布式表 `events_all` | 按分片键 `cityHash64(user_id)` 分发到各 shard | 默认异步转发（先落本地队列），可用 `distributed_foreground_insert = 1`（旧名 `insert_distributed_sync`）改为同步 |
| INSERT 本地表 `events_local` | **只写当前连接节点所在的 shard** | 不会按分片键路由；需要客户端自己按分片键选节点，否则数据分布由客户端连接决定 |

副本之间的复制由 ClickHouse Keeper（或 ZooKeeper）协调。

### 7、更新、删除与事务

| 操作 | 方式 | 说明 |
|------|------|------|
| 删除 | 轻量级 `DELETE FROM t WHERE ...`（23.3 起 GA） | 先给行打删除标记，查询时过滤，后台 Merge 时物理删除 |
| 更新 | 轻量级 `UPDATE t SET ... WHERE ...`（25.7 引入，目前为 Beta，基于 patch part） | 表需开启 `enable_block_number_column` 与 `enable_block_offset_column`；只写入变更的列，查询时叠加，仍不适合高频单行更新 |
| 删除 / 更新（旧方式） | `ALTER TABLE ... DELETE / UPDATE`（Mutation） | 重写受影响的整个 Part，开销大，适合低频批量修正 |
| 按版本覆盖 | `ReplacingMergeTree` + `FINAL` / `argMax` | 把更新转成追加新版本 |
| 事务 | 单次 INSERT 的一个数据块是原子的 | 多语句事务仍是实验特性，不要按 OLTP 事务使用 |

### 8、写入与性能建议

- **批量写入**：官方建议每次 INSERT 至少 1000 行，最好 1 万到 10 万行，同步写入时控制在每秒约一次 INSERT；每次 INSERT 都会生成新 Part，小批量高频写会导致 Part 过多（`Too many parts`）
- **大量小客户端**：开启 `async_insert = 1`，由服务端缓冲后批量落盘
- **ORDER BY 设计**：把高频过滤列放在前面，基数低的列在前、高的在后
- **分区不要太细**：按月或按天，分区数过多同样导致 Part 过多
- **物化视图**：对高频聚合做增量预计算，查询直接读结果

---

## 三、Apache Doris 与 StarRocks

两者同源于百度 Palo，都是 **MPP 架构的实时分析数据库**，兼容 MySQL 协议（可直接用 MySQL 客户端和 JDBC 驱动连接），与 ClickHouse 的主要区别在于：**多表 JOIN 能力强、支持主键模型的实时更新、运维简单（FE + BE 两种进程，无 ZooKeeper 依赖）**。

| 维度 | Apache Doris | StarRocks |
|------|--------------|-----------|
| 归属 | Apache 顶级项目 | Linux 基金会项目（StarRocks 公司主导） |
| 版本 | 3.x 稳定，4.0 于 2025 年发布（向量检索、全文检索增强） | 3.x 稳定，4.0 于 2025 年 10 月发布 |
| 存算分离 | 3.0 起支持 | 3.0 起支持 |
| 数据湖 | Hive / Iceberg / Hudi / Paimon 外表查询 | 同样支持，Iceberg 集成较深 |

数据模型（以 Doris 为例）：

| 模型 | 语义 | 适用场景 |
|------|------|----------|
| 明细模型（Duplicate Key） | 保留所有写入行 | 日志、明细 |
| 主键模型（Unique Key，Merge-on-Write） | 按主键 UPSERT，查询无需合并 | 需要实时更新的业务表、CDC 同步 |
| 聚合模型（Aggregate Key） | 写入时按 Key 预聚合 | 指标汇总 |

```sql
-- Doris 主键模型：适合从 MySQL 通过 CDC 实时同步
CREATE TABLE orders (
    order_id   BIGINT,
    user_id    BIGINT,
    status     VARCHAR(16),
    amount     DECIMAL(18, 2),
    updated_at DATETIME
)
UNIQUE KEY (order_id)
DISTRIBUTED BY HASH (order_id) BUCKETS 16
PROPERTIES (
    "replication_num" = "3",
    "enable_unique_key_merge_on_write" = "true"
);
```

导入方式常用 Stream Load（HTTP 批量）、Routine Load（订阅 Kafka）和 Flink Connector，MySQL 实时同步链路见 [Flink CDC](/flink/6_cdc)。

---

## 四、选型对比

| 维度 | HBase | ClickHouse | Doris / StarRocks |
|------|-------|------------|-------------------|
| 类别 | 宽列 KV | 列式 OLAP | 列式 OLAP（MPP） |
| 主要查询 | RowKey 点查、前缀扫描 | 单表大宽表聚合 | 聚合 + 多表 JOIN |
| 写入 | 高吞吐随机写 | 大批量追加最佳 | 批量 + 主键模型实时 UPSERT |
| 更新 | 按 RowKey 覆盖 | 轻量级 DELETE / UPDATE，不适合高频 | 主键模型原生支持 |
| SQL | 无（需 Phoenix） | ClickHouse SQL 方言 | MySQL 协议兼容 |
| 运维依赖 | HDFS + ZooKeeper | Keeper（复制时） | 无外部依赖 |
| 典型场景 | 消息、明细、画像 KV | 日志分析、行为分析、监控 | 实时报表、BI、湖仓分析 |

选型建议：

- 按键查的海量明细 → HBase（或云上的 Bigtable 类服务）
- 单表宽表、日志 / 行为分析、追求极致扫描性能 → ClickHouse
- 多表 JOIN 的报表 / BI、需要实时更新、团队熟悉 MySQL → Doris 或 StarRocks
- 数据量不大（千万行级）的报表 → 先用 MySQL / PostgreSQL 只读副本

OLAP 在整体架构中的位置（读写分离到异构存储、冷热分层）见 [数据层扩展](/high-con/5_data_scaling) 和 [海量数据处理](/scenario/2_big_data)。

---

## 小结

- 「列式数据库」包含两类：HBase / Cassandra 是宽列 KV 存储，擅长按键随机读写；ClickHouse / Doris / StarRocks 是列式 OLAP，擅长扫描聚合
- HBase 的 RowKey 设计决定一切：打散前缀要配合预分区，Hash 前缀会把范围扫描变成 N 路扫描；取模用 `Math.floorMod` 避免负数
- ClickHouse 的 MergeTree：分区用于裁剪与整块删除，ORDER BY 即稀疏索引；新增跳数索引要 `MATERIALIZE INDEX` 才覆盖存量数据
- ReplacingMergeTree 只在 Merge 时、分区内去重，查询需 `FINAL` 或 `argMax`
- INSERT 本地表只写当前节点的 shard，按分片键分发要写分布式表或由客户端路由
- 删除用轻量级 DELETE，更新可用 25.7 起的轻量级 UPDATE（Beta），但都不适合高频单行修改；单次 INSERT 块原子，无 OLTP 事务
- 写入每批 1 万到 10 万行，小客户端多就开 `async_insert`
- 需要多表 JOIN 和实时更新时选 Doris / StarRocks（MySQL 协议、主键模型）

## 参考资料

- Apache HBase Reference Guide：[https://hbase.apache.org/book.html](https://hbase.apache.org/book.html)
- ClickHouse MergeTree：[https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree)
- ClickHouse ReplacingMergeTree：[https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)
- ClickHouse Distributed 引擎：[https://clickhouse.com/docs/engines/table-engines/special/distributed](https://clickhouse.com/docs/engines/table-engines/special/distributed)
- ClickHouse 轻量级 DELETE：[https://clickhouse.com/docs/sql-reference/statements/delete](https://clickhouse.com/docs/sql-reference/statements/delete)
- ClickHouse 轻量级 UPDATE：[https://clickhouse.com/docs/sql-reference/statements/update](https://clickhouse.com/docs/sql-reference/statements/update)
- ClickHouse 批量写入建议：[https://clickhouse.com/docs/optimize/bulk-inserts](https://clickhouse.com/docs/optimize/bulk-inserts)
- ClickHouse 异步写入：[https://clickhouse.com/docs/optimize/asynchronous-inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)
- Apache Doris 数据模型：[https://doris.apache.org/docs/table-design/data-model/overview](https://doris.apache.org/docs/table-design/data-model/overview)
- StarRocks 文档：[https://docs.starrocks.io/docs/introduction/StarRocks_intro/](https://docs.starrocks.io/docs/introduction/StarRocks_intro/)

> 下一篇：[时序数据库](./1_time_series_db) —— 写多读少、按时间聚合与过期的时序数据怎么存

---
description: 列存原理、MergeTree 引擎家族、跳数索引、分布式表与副本、轻量级删除与更新、写入建议
---

# ClickHouse

> 前置阅读：[数据库选型参考](/database/0_fundamentals/2_selection_guide)

ClickHouse 是开源的列式 OLAP 数据库，擅长亿级到百亿级数据的聚合查询秒级返回。本篇讲列存原理、MergeTree 引擎家族、分布式表与副本、更新删除与写入建议，基线为 ClickHouse 26。

---

## 一、定位与版本

- 最初由 Yandex 开发并于 2016 年开源，2021 年独立为 ClickHouse Inc.，Apache 2.0 协议，当前主线为 26.x（每月发版，LTS 为每年的 .3 与 .8 版本）
- 擅长：亿级到百亿级数据的聚合查询秒级返回，批量写入吞吐高
- 不擅长：高并发单行点查、频繁的单行更新、多表大 JOIN、强事务

需要多表 JOIN 与实时更新时的另一类列式 OLAP 见 [Doris 与 StarRocks](./7_doris_starrocks)。

---

## 二、为什么列存适合分析

![行存与列存的读取对比](../assets/nosql/row-vs-column-store.svg)

以 `SELECT sum(amount) FROM orders WHERE status = 'paid'` 为例：行存要把整行读进内存，列存只读 `status` 和 `amount` 两个列文件。

- **IO 少**：只读查询涉及的列
- **压缩率高**：同列数据类型一致、重复值多，LZ4 / ZSTD 配合 Delta、Gorilla 等编码，压缩比常在 5~10 倍以上
- **向量化执行**：按列批量处理，充分利用 SIMD

---

## 三、MergeTree 引擎

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

---

## 四、常用变体引擎

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

---

## 五、查询示例

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

---

## 六、分布式表与副本

![ClickHouse 分布式表与副本拓扑](../assets/nosql/clickhouse-distributed.svg)

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

---

## 七、更新、删除与事务

| 操作 | 方式 | 说明 |
|------|------|------|
| 删除 | 轻量级 `DELETE FROM t WHERE ...`（23.3 起 GA） | 先给行打删除标记，查询时过滤，后台 Merge 时物理删除 |
| 更新 | 轻量级 `UPDATE t SET ... WHERE ...`（25.7 引入，26.10 起 GA，基于 patch part） | 表需开启 `enable_block_number_column` 与 `enable_block_offset_column`；只写入变更的列，查询时叠加，仍不适合高频单行更新 |
| 删除 / 更新（旧方式） | `ALTER TABLE ... DELETE / UPDATE`（Mutation） | 重写受影响的整个 Part，开销大，适合低频批量修正 |
| 按版本覆盖 | `ReplacingMergeTree` + `FINAL` / `argMax` | 把更新转成追加新版本 |
| 事务 | 单次 INSERT 的一个数据块是原子的 | 多语句事务仍是实验特性，不要按 OLTP 事务使用 |

---

## 八、写入与性能建议

- **批量写入**：官方建议每次 INSERT 至少 1000 行，最好 1 万到 10 万行，同步写入时控制在每秒约一次 INSERT；每次 INSERT 都会生成新 Part，小批量高频写会导致 Part 过多（`Too many parts`）
- **大量小客户端**：开启 `async_insert = 1`，由服务端缓冲后批量落盘
- **ORDER BY 设计**：把高频过滤列放在前面，基数低的列在前、高的在后
- **分区不要太细**：按月或按天，分区数过多同样导致 Part 过多
- **物化视图**：对高频聚合做增量预计算，查询直接读结果

---

## 小结

- 列存只读查询涉及的列、同列压缩率高、按列向量化执行，所以适合大范围扫描聚合
- MergeTree：分区用于裁剪与整块删除，ORDER BY 即稀疏索引；新增跳数索引要 `MATERIALIZE INDEX` 才覆盖存量数据
- ReplacingMergeTree 只在 Merge 时、分区内去重，查询需 `FINAL` 或 `argMax`
- INSERT 本地表只写当前节点的 shard，按分片键分发要写分布式表或由客户端路由
- 删除用轻量级 DELETE，更新可用轻量级 UPDATE（25.7 引入，26.10 起 GA），但都不适合高频单行修改；单次 INSERT 块原子，无 OLTP 事务
- 写入每批 1 万到 10 万行，小客户端多就开 `async_insert`

## 参考资料

- ClickHouse MergeTree：[https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree)
- ClickHouse ReplacingMergeTree：[https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)
- ClickHouse Distributed 引擎：[https://clickhouse.com/docs/engines/table-engines/special/distributed](https://clickhouse.com/docs/engines/table-engines/special/distributed)
- ClickHouse 轻量级 DELETE：[https://clickhouse.com/docs/sql-reference/statements/delete](https://clickhouse.com/docs/sql-reference/statements/delete)
- ClickHouse 轻量级 UPDATE：[https://clickhouse.com/docs/sql-reference/statements/update](https://clickhouse.com/docs/sql-reference/statements/update)
- ClickHouse 批量写入建议：[https://clickhouse.com/docs/optimize/bulk-inserts](https://clickhouse.com/docs/optimize/bulk-inserts)
- ClickHouse 异步写入：[https://clickhouse.com/docs/optimize/asynchronous-inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts)

> 下一篇：[Doris 与 StarRocks](./7_doris_starrocks) —— Doris 与 StarRocks 异同、明细 / 主键 / 聚合模型、导入方式、列式 OLAP 与宽列选型对比

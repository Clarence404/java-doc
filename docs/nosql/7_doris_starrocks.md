---
description: 两者异同、数据模型、分区与分桶、Stream Load、Routine Load、Group Commit、选型
---

# Doris 与 StarRocks

> 前置阅读：[HBase](./5_hbase)、[ClickHouse](./6_clickhouse)

Apache Doris 与 StarRocks 同源于百度 Palo，都是兼容 MySQL 协议的 MPP 实时分析数据库。本篇讲两者异同、数据模型、分区分桶与导入，以及与 HBase、ClickHouse 的选型对比，基线为 Doris 4、StarRocks 4。

---

## 一、Apache Doris 与 StarRocks

两者同源于百度 Palo，都是 **MPP 架构的实时分析数据库**，兼容 MySQL 协议（可直接用 MySQL 客户端和 JDBC 驱动连接），与 ClickHouse 的主要区别在于：**多表 JOIN 能力强、支持主键模型的实时更新、运维简单（FE + BE 两种进程，无 ZooKeeper 依赖）**。

| 维度 | Apache Doris | StarRocks |
|------|--------------|-----------|
| 归属 | Apache 顶级项目 | Linux 基金会项目（StarRocks 公司主导） |
| 版本 | 4.x 为当前稳定版（基线 4.1）；4.0 起增强向量检索、全文检索 | 4.x 为当前稳定版（基线 4.1）；4.0 于 2025 年 10 月发布 |
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

StarRocks 的对应关系：实时更新用**主键表**（Primary Key），语法是 `PRIMARY KEY`，主键列必须写在最前面、必须包含分区列和分桶列，建好后不能改；Unique Key 表在 StarRocks 里是读时合并（Merge-on-Read），新表优先用主键表。

```sql
-- StarRocks 主键表：按天分区，主键里带上分区列 dt
CREATE TABLE orders (
    order_id BIGINT NOT NULL,
    dt       DATE   NOT NULL,
    user_id  BIGINT,
    status   VARCHAR(16),
    amount   DECIMAL(18, 2)
)
PRIMARY KEY (order_id, dt)
PARTITION BY date_trunc('day', dt)
DISTRIBUTED BY HASH (order_id);
```

---

## 二、分区与分桶

数据先按**分区**切（通常按时间，便于按天删除过期数据、查询时裁剪），每个分区再按**分桶**打散到各个 BE。分区不用手工一个个建：

```sql
-- Doris 自动分区：写入哪一天的数据就自动建哪一天的分区；明细模型，日志类数据
CREATE TABLE user_events (
    event_time DATETIME NOT NULL,
    user_id    BIGINT,
    event_type VARCHAR(32),
    payload    JSON
)
DUPLICATE KEY (event_time, user_id)
AUTO PARTITION BY RANGE (date_trunc(event_time, 'day')) ()
DISTRIBUTED BY HASH (user_id) BUCKETS AUTO
PROPERTIES ("replication_num" = "3");
```

StarRocks 的写法是表达式分区 `PARTITION BY date_trunc('day', dt)`（上一节的例子）。Doris 的自动分区只支持日期类型的分区列，且分区列不能为空；它与旧的动态分区（`dynamic_partition.*` 属性）不建议混用。

分桶数决定了每个分片（tablet）的大小，Doris 官方的建议：

- 单个 tablet 压缩后在 1–20 GB 之间，主键模型的表不超过 10 GB
- 分桶数取 BE 数量的整数倍，每个分区不超过 128 个桶；拿不准就写 `BUCKETS AUTO` 交给系统估算
- 分桶列选区分度高、查询常带的列（如 `user_id`），避免数据倾斜到少数几个桶

---

## 三、数据导入

| 方式 | 适用 | 特点 |
|------|------|------|
| Stream Load | 文件、批量推送 | HTTP 同步导入，一次请求一个事务 |
| Routine Load | 订阅 Kafka | 常驻任务持续消费，按分区并行 |
| Flink Connector | 实时同步 MySQL 等 | 配合 Flink CDC，见 [Flink CDC](/flink/6_cdc) |
| INSERT + Group Commit | 业务代码零散的小写入 | 服务端把一段时间内的小写入合并成一次提交 |

### 1、Stream Load

向 FE 的 HTTP 端口（默认 8030）发 PUT，FE 再转给 BE；Doris 与 StarRocks 的接口路径相同：

```bash
curl --location-trusted -u etl_user:${DORIS_PASSWORD} \
  -H "Expect:100-continue" \
  -H "label:orders_20261123_01" \
  -H "format:json" -H "strip_outer_array:true" \
  -T orders.json \
  -XPUT http://fe-host:8030/api/shop/orders/_stream_load
```

`label` 是这批数据的身份证：同一个 label 不会被导入两次，所以失败重试时**沿用原来的 label**，不会重复写入。按返回的 `Status` 处理：

| Status | 含义 | 处理 |
|------|------|------|
| `Success` | 导入成功 | 完成 |
| `Publish Timeout` | 已提交，只是数据稍后才可见 | 不要重试 |
| `Label Already Exists` | 这个 label 已经导入过或正在导入 | 看 `ExistingJobStatus`，不要换 label 重发 |
| `Fail` | 导入失败 | 看 `Message` 和 `ErrorURL` 里的错误行，修正后用原 label 重试 |

### 2、Routine Load

常驻任务持续消费 Kafka，实际并发取 Topic 分区数、`desired_concurrent_number` 等几个值中的最小值：

```sql
CREATE ROUTINE LOAD shop.orders_from_kafka ON orders
COLUMNS (order_id, user_id, status, amount, updated_at)
PROPERTIES (
    "format" = "json",
    "desired_concurrent_number" = "3"
)
FROM KAFKA (
    "kafka_broker_list" = "kafka-1:9092,kafka-2:9092",
    "kafka_topic" = "orders",
    "property.kafka_default_offsets" = "OFFSET_BEGINNING"
);

SHOW ROUTINE LOAD FOR shop.orders_from_kafka;   -- 状态、消费进度、错误行数
PAUSE ROUTINE LOAD FOR shop.orders_from_kafka;  -- 手动暂停的任务要手动 RESUME
RESUME ROUTINE LOAD FOR shop.orders_from_kafka;
```

任务因为错误行过多等原因被系统暂停时，`SHOW ROUTINE LOAD` 里能看到原因，修正后 `RESUME`；`STOP` 掉的任务无法恢复，只能重建。

### 3、业务代码里的小写入：Group Commit

Doris 和 StarRocks 用 MySQL 协议接入，Java 里直接用 MySQL 驱动连 FE 的查询端口（默认 9030）。但每条 `INSERT ... VALUES` 都是一次导入事务，业务里零散的小写入会产生大量数据版本，拖慢查询。Doris 的 Group Commit 让服务端把一段时间内的小写入合并成一次提交（默认 10 秒或攒够 128 MB），`async_mode` 先写 WAL 立即返回：

```yaml
spring:
  datasource:
    # 连接串里开启 Group Commit；也可以在会话里 SET group_commit = async_mode
    url: jdbc:mysql://fe-host:9030/shop?sessionVariables=group_commit=async_mode
```

`async_mode` 返回成功时数据还没提交，最长要等一个合并周期才可见；要求写完立刻能查到的场景用 `sync_mode`，大批量数据仍然走 Stream Load。

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

OLAP 在整体架构中的位置（读写分离到异构存储、冷热分层）见 [数据层扩展](/high-con/5_data_scaling) 和 [海量数据架构选型](/scenario/26_big_data)；把 OLAP 引擎包装成对外查询服务（结果表设计、物化视图、重查询限流、多租户隔离）见 [OLAP 查询与数据服务](/big-data/7_olap_service)。

---

## 小结

- Doris 与 StarRocks 同源于百度 Palo，都是 MPP 架构、兼容 MySQL 协议，FE + BE 两种进程、无 ZooKeeper 依赖
- 相比 ClickHouse，两者的优势是多表 JOIN 能力强、支持主键模型的实时更新
- Doris 有明细、主键（Merge-on-Write）、聚合三种模型，主键模型适合需要实时更新的业务表和 CDC 同步
- StarRocks 的实时更新用主键表，主键列写在最前并包含分区列和分桶列
- 按时间自动分区，分桶让单个 tablet 保持在 1–20 GB，拿不准用 `BUCKETS AUTO`
- 批量用 Stream Load（重试沿用原 label，不会重复导入），Kafka 用 Routine Load，业务里零散的小写入开 Group Commit
- 选型：按键查的海量明细用 HBase，单表宽表扫描用 ClickHouse，多表 JOIN 与实时更新用 Doris / StarRocks，千万行级报表先用关系库只读副本

## 参考资料

- Apache Doris 数据模型：[https://doris.apache.org/docs/table-design/data-model/overview](https://doris.apache.org/docs/table-design/data-model/overview)
- Doris 自动分区：[https://doris.apache.org/docs/4.x/table-design/data-partitioning/auto-partitioning/](https://doris.apache.org/docs/4.x/table-design/data-partitioning/auto-partitioning/)
- Doris 分桶：[https://doris.apache.org/docs/4.x/table-design/data-partitioning/data-bucketing/](https://doris.apache.org/docs/4.x/table-design/data-partitioning/data-bucketing/)
- Doris Stream Load：[https://doris.apache.org/docs/4.x/data-operate/import/import-way/stream-load-manual/](https://doris.apache.org/docs/4.x/data-operate/import/import-way/stream-load-manual/)
- Doris Routine Load：[https://doris.apache.org/docs/4.x/data-operate/import/import-way/routine-load-manual/](https://doris.apache.org/docs/4.x/data-operate/import/import-way/routine-load-manual/)
- Doris Group Commit：[https://doris.apache.org/docs/4.x/data-operate/import/load-best-practices/group-commit-manual/](https://doris.apache.org/docs/4.x/data-operate/import/load-best-practices/group-commit-manual/)
- StarRocks 主键表：[https://docs.starrocks.io/docs/table_design/table_types/primary_key_table/](https://docs.starrocks.io/docs/table_design/table_types/primary_key_table/)
- StarRocks 文档：[https://docs.starrocks.io/docs/introduction/StarRocks_intro/](https://docs.starrocks.io/docs/introduction/StarRocks_intro/)

> 下一篇：[时序数据库概览](./8_tsdb) —— 时序数据特点、TSDB 数据模型与共性机制、Prometheus 本地与长期存储、TDengine / IoTDB、选型

---
description: 数据湖与湖仓、表格式原理、Iceberg / Paimon / Hudi / Delta 对比、Catalog、小文件治理、流式湖仓
---

# 数据湖与湖仓

> 前置阅读：[大数据基础](./1_basics)、[数仓分层与建模](./2_data_warehouse)、[Spark](./3_spark)

湖仓是在对象存储的开放文件之上加一层表格式，把数仓的事务、行级更新和演进能力带到数据湖上，并让多个引擎共享同一张表。本篇以 Iceberg 为例讲表格式原理与 Spark SQL 实战，再覆盖 Iceberg / Paimon / Hudi / Delta 选型、Catalog、小文件治理和 Flink + Paimon 流式湖仓，版本基线为 Iceberg 1.12、Paimon 2.0、Hudi 1.2.x。

---

## 一、为什么需要数据湖与湖仓

### 1、Hive 表的天花板

Hive 表本质上是"一个目录约定"：表对应一个目录，分区对应子目录，Hive Metastore（HMS）只记录到分区级别，至于分区里有哪些文件，每次查询都要去文件系统 list 一遍。数据量上来、迁到对象存储之后，这套约定的问题集中暴露：

| 问题 | 表现 | 根因 |
|------|------|------|
| 规划慢 | 查一个月的订单要先 list 几十个分区目录、数万个文件，规划阶段就要几十秒 | 文件清单不在元数据里，只能列目录；对象存储的 list 又慢又贵 |
| 没有事务 | 写到一半失败，读者看到半批数据；两个作业同时写同一分区互相覆盖 | 可见性靠"写临时目录再 rename"，对象存储上 rename 不是原子的 |
| 改一行要重写整个分区 | 订单状态变更、GDPR 删除，只能 `INSERT OVERWRITE` 整个分区 | 没有行级删除的元数据 |
| Schema 变更危险 | 按列位置读 CSV / ORC 时，删一列、调换列序会让数据错位 | Schema 与文件的列没有稳定的对应关系 |
| 分区方案改不动 | 一开始按天分区，后来想按小时，只能新建表并重刷全部历史 | 分区就是目录结构，与查询条件强绑定 |

### 2、数据湖、数仓、湖仓

**数据湖**把所有原始数据以开放文件格式（Parquet、ORC）放在廉价的对象存储上，任何引擎都能读，解决了"存得下、存得起、谁都能用"。但只有文件没有表的管理能力，很容易沦为没人敢用的"数据沼泽"。**数仓**（传统 MPP、云数仓）有完整的事务、索引和优化器，代价是数据进了专有格式，被单一引擎锁定。

**湖仓（Lakehouse）**的做法是在湖的文件之上加一层**开放表格式**，把数仓的表管理能力（ACID、Schema 管理、行级更新、快照）带到湖上，再让多个引擎直接查同一份数据：

![湖仓分层：存储、格式、目录、引擎彼此解耦](../assets/big-data/lakehouse-layers.svg)

| 维度 | 传统数仓 | 数据湖（Hive 时代） | 湖仓 |
|------|----------|---------------------|------|
| 存储 | 专有格式，存算一体 | 对象存储 / HDFS 上的开放文件 | 对象存储 / HDFS 上的开放文件 |
| 事务 | 完整 ACID | 无 | 快照隔离的 ACID |
| 行级更新 | 支持 | 重写分区 | 删除文件 / 合并读 |
| 引擎 | 自家引擎 | 多引擎，但各自为政 | 多引擎共享同一张表、同一份元数据 |
| 数据类型 | 结构化 | 任意 | 结构化为主，v3 起支持 `variant` 半结构化 |

湖仓不是"把数仓搬到湖上"这么简单，它真正的收益是**存储与计算解耦**：Spark 跑离线批处理、Flink 流式写入、Trino 做交互查询、Doris / StarRocks 做高并发分析，都读写同一张表，引擎可以按场景替换而不必搬数据。

---

## 二、表格式原理：以 Iceberg 为例

Iceberg、Paimon、Hudi、Delta 的细节各不相同，但核心思路一致：**用一棵不可变的元数据树描述"某一时刻这张表由哪些文件组成"，提交就是原子地切换树根**。Iceberg 的规范最清晰，下面以它为例。

### 1、元数据分层

![Iceberg 元数据树：Catalog → 元数据文件 → 清单列表 → 清单文件 → 数据文件](../assets/big-data/lakehouse-iceberg-metadata.svg)

| 层级 | 文件 | 内容 | 作用 |
|------|------|------|------|
| Catalog | 外部服务 | 表名 → 当前 `metadata.json` 的位置 | 唯一可变的指针，提交就是改它 |
| 表元数据 | `vN.metadata.json` | Schema（含历史版本）、分区规范、排序、表属性、快照列表、当前快照 ID | 一次提交生成一个新文件，旧文件保留 |
| 清单列表 | `snap-*.avro` | 一个快照包含哪些清单文件，以及每个清单覆盖的分区范围 | 规划时按分区范围整体跳过清单 |
| 清单文件 | `*.avro` | 一批数据文件 / 删除文件的路径、分区值、行数、每列的最小值 / 最大值 / 空值数 | 按列统计跳过文件，不再需要 list 目录 |
| 数据与删除文件 | Parquet / ORC / Puffin | 真正的行数据；删除文件或删除向量标记哪些行已删除 | 不可变，只增不改 |

几个关键性质：

- **所有文件不可变**：一次写入只新增文件，不改旧文件，所以读者永远看到一个完整、一致的快照
- **清单可复用**：图中快照 S2 直接复用 S1 的 `manifest-1`，只新增本次写入的清单，提交开销与本次改动量成正比，与表的总大小无关
- **规划不碰存储目录**：查询 `order_time` 在 10 月 9 日的订单时，引擎先用清单列表的分区范围跳过无关清单，再用清单里的列统计跳过无关文件，最后只打开必要的 Parquet 文件

### 2、快照与提交：乐观并发

写入者不加锁，假设没有人与自己冲突，失败了再重试：

1. 读取当前元数据（记为 base，例如 `v2.metadata.json`）
2. 写数据文件、清单文件、清单列表，生成新的 `v3.metadata.json`
3. 请 Catalog 做一次**比较并交换（CAS）**：只有当前指针仍是 v2 时才改成 v3
4. 如果别人已经抢先提交（指针变成了别的版本），则基于新的 base 检查冲突：两次写入的文件互不相干（例如追加不同分区）就重新生成元数据再提交；真冲突（都改了同一批文件）就让本次写入失败

CAS 由 Catalog 实现：HMS 用表锁加参数更新，JDBC Catalog 用带条件的 `UPDATE`，REST Catalog 由服务端在一个事务里校验并提交。重试次数由表属性 `commit.retry.num-retries` 控制（默认 4 次）。读者不参与这个过程，打开表时拿到哪个快照就读哪个，不会被并发写入阻塞。

::: tip 冲突检查的粒度
Spark 的 `DELETE` / `UPDATE` / `MERGE` 默认使用 `serializable` 隔离级别（表属性 `write.delete.isolation-level` 等），会检查并发提交是否新增了可能匹配本次条件的数据文件；改成 `snapshot` 可以减少冲突，但要接受"并发插入的行没有被本次更新覆盖"。高频小批量写入同一张表时，冲突重试是吞吐瓶颈之一，常见做法是让一张表只有一个流式写入者，补数作业错开分区。
:::

### 3、行级更新：写时复制与读时合并

| 模式 | 做法 | 写入代价 | 读取代价 | 适用 |
|------|------|----------|----------|------|
| 写时复制（COW） | 重写包含被改行的整个数据文件 | 高：改一行重写一个文件 | 低：直接读数据文件 | 更新少、读多的报表表 |
| 读时合并（MOR） | 只写一个删除文件标记旧行，新值作为新行追加 | 低 | 读时要合并删除信息 | 频繁 upsert 的 ODS / CDC 表 |

Iceberg 的删除信息经历了三代：v2 的**位置删除文件**（记录 `文件路径 + 行号`）和**等值删除文件**（记录 `order_id = 1001` 这样的条件，Flink 流式 upsert 常用）；v3 引入**删除向量（Deletion Vector）**，每个数据文件最多对应一个存放在 Puffin 文件里的位图，读时合并的开销大幅降低。v4 规划中将不再写新的等值删除文件。用哪种模式按操作分别配置：`write.delete.mode`、`write.update.mode`、`write.merge.mode`，取值 `copy-on-write` 或 `merge-on-read`。

MOR 不是免费的：删除文件越积越多，读放大越严重，必须配合第六节的合并任务定期把删除信息"压实"进数据文件。

### 4、Schema 演进

Iceberg 给每一列分配一个**唯一的列 ID**，数据文件里记录的也是列 ID，而不是列名或列位置：

- **加列**：新列分配新 ID，旧文件里没有这个 ID，读出来就是 `NULL`（v3 支持列默认值）
- **删列**：只从当前 Schema 移除，旧文件里的数据不再被读取，之后再加一个同名列也不会"复活"旧数据
- **改名**：只改 Schema 里 ID 对应的名字，数据文件不动
- **改类型**：只允许安全的拓宽，如 `int → long`、`float → double`、`decimal(P,S)` 增大精度
- **调整列序**：只改 Schema 中的顺序，与文件无关

这正是 Hive 按列位置读文件时做不到的。所有 Schema 变更都是纯元数据操作，毫秒级完成，不重写数据。

### 5、隐藏分区与分区演进

Hive 要求用户显式维护一个分区列（如 `dt`），写入时自己算、查询时自己带 `dt = '2026-10-09'`，忘带就全表扫描。Iceberg 的分区是对已有列做**转换（transform）**：`identity`、`bucket[N]`、`truncate[W]`、`year` / `month` / `day` / `hour`。按 `days(order_time)` 分区后，查询只写 `WHERE order_time >= '2026-10-09'`，引擎自动换算到分区，用户看不到分区列，这就是**隐藏分区**。

**分区演进**：分区规范（partition spec）也有版本。把按天改成按小时分区时，旧数据保留旧规范，新数据按新规范写入，规划时对两段数据分别做分区裁剪，不需要重写历史。

### 6、时间旅行、分支与标签

每个快照都是表在某一时刻的完整视图，所以可以按快照 ID 或时间戳查询历史版本，用于排查"昨天的报表为什么和今天不一样"、恢复误删数据、复现机器学习训练集。快照会被过期清理，需要长期保留的版本可以打**标签（tag）**并指定保留期；**分支（branch）**则允许在不影响主线的情况下写入并验证数据（Write-Audit-Publish 模式：先写到审计分支，校验通过再快进到主线）。

---

## 三、Spark SQL 实战：Iceberg 订单表

**版本基线（2026 年 10 月）**：Iceberg 1.12（2026 年 9 月发布，表格式规范 v1 / v2 / v3 均已定稿，v4 仍在开发）、Paimon 2.0（2026 年 8 月）、Hudi 1.2.x、Delta Lake 4.4、Apache Polaris 1.4、Apache Gravitino 1.x。注意 Iceberg 1.12 的 Spark 运行时只发布到 `iceberg-spark-runtime-4.1_2.13`，[Spark](./3_spark) 一篇的基线 Spark 4.2 暂时没有对应构件，读写 Iceberg 的集群先用 Spark 4.1。

示例统一用电商订单：业务库 `order_info` 表同步进湖，形成 `lake.ods.ods_order_info_inc`。

### 1、连接 REST Catalog

以 Polaris（Iceberg REST Catalog 的一个实现）为例，Catalog 负责下发对象存储的临时凭证，客户端不必持有长期 AK / SK：

```bash
spark-sql \
  --packages org.apache.iceberg:iceberg-spark-runtime-4.1_2.13:1.12.0,org.apache.iceberg:iceberg-aws-bundle:1.12.0 \
  --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions \
  --conf spark.sql.catalog.lake=org.apache.iceberg.spark.SparkCatalog \
  --conf spark.sql.catalog.lake.type=rest \
  --conf spark.sql.catalog.lake.uri=http://polaris:8181/api/catalog \
  --conf spark.sql.catalog.lake.warehouse=lake \
  --conf spark.sql.catalog.lake.credential=${POLARIS_CLIENT_ID}:${POLARIS_CLIENT_SECRET} \
  --conf spark.sql.catalog.lake.scope=PRINCIPAL_ROLE:ALL \
  --conf spark.sql.catalog.lake.header.X-Iceberg-Access-Delegation=vended-credentials \
  --conf spark.sql.defaultCatalog=lake
```

- `iceberg-aws-bundle` 提供 S3FileIO，访问 S3 兼容存储时需要
- SQL 扩展提供 `MERGE`、`ALTER TABLE ... ADD PARTITION FIELD`、`WRITE ORDERED BY` 等语法；Spark 4 已原生支持存储过程调用，但分区演进等 DDL 仍依赖扩展
- 换成 Hive Metastore 时把 `type` 改为 `hive`、`uri` 改为 `thrift://<metastore-host>:9083`，本地试验可用 `type=hadoop` 加 `warehouse=<目录>`

### 2、建表、写入与 upsert

```sql
CREATE NAMESPACE IF NOT EXISTS lake.ods;

CREATE TABLE lake.ods.ods_order_info_inc (
  order_id     BIGINT NOT NULL,
  user_id      BIGINT,
  shop_id      BIGINT,
  amount       DECIMAL(12, 2),
  status       STRING,
  order_time   TIMESTAMP,
  update_time  TIMESTAMP
) USING iceberg
PARTITIONED BY (days(order_time))
TBLPROPERTIES (
  'format-version'                = '3',
  'write.delete.mode'             = 'merge-on-read',
  'write.update.mode'             = 'merge-on-read',
  'write.merge.mode'              = 'merge-on-read',
  'write.target-file-size-bytes'  = '268435456'
);

INSERT INTO lake.ods.ods_order_info_inc VALUES
  (1001, 501, 11, 199.00, 'PAID',    TIMESTAMP '2026-10-08 10:15:00', TIMESTAMP '2026-10-08 10:15:00'),
  (1002, 502, 12,  89.90, 'CREATED', TIMESTAMP '2026-10-09 09:01:00', TIMESTAMP '2026-10-09 09:01:00');

-- 当天的增量：1002 已支付，新增 1003
CREATE OR REPLACE TEMPORARY VIEW order_info_chg AS
SELECT * FROM VALUES
  (1002, 502, 12,  89.90, 'PAID',    TIMESTAMP '2026-10-09 09:01:00', TIMESTAMP '2026-10-09 09:30:00'),
  (1003, 503, 11, 356.00, 'CREATED', TIMESTAMP '2026-10-09 11:20:00', TIMESTAMP '2026-10-09 11:20:00')
AS v(order_id, user_id, shop_id, amount, status, order_time, update_time);

MERGE INTO lake.ods.ods_order_info_inc t
USING order_info_chg s
ON t.order_id = s.order_id
WHEN MATCHED AND s.update_time > t.update_time THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;
```

- 显式指定 `format-version = 3` 才能用删除向量、行血缘、`variant` 等 v3 特性；查询这张表的所有引擎都必须支持 v3，混用老版本 Trino / Doris 时先确认兼容性
- `MERGE` 的匹配条件里带上 `update_time` 比较，乱序或重复投递的旧数据不会覆盖新数据，这是第五篇讲的幂等写入在湖表上的写法
- 目标文件大小默认 512 MB，表不大或写入频繁时调小到 128～256 MB，减少单个文件重写的代价

### 3、时间旅行与元数据表

```sql
-- 查看快照历史：每次 INSERT / MERGE 都是一个快照
SELECT snapshot_id, committed_at, operation, summary['added-records'] AS added
FROM lake.ods.ods_order_info_inc.snapshots
ORDER BY committed_at;

-- 按快照 ID / 时间点查询历史版本（快照 ID 取自上一条查询）
SELECT * FROM lake.ods.ods_order_info_inc VERSION AS OF 8744736658442914487;
SELECT * FROM lake.ods.ods_order_info_inc TIMESTAMP AS OF '2026-10-09 09:00:00';

-- 对比两个版本的差异：MERGE 之后新增或变化的行
SELECT * FROM lake.ods.ods_order_info_inc
EXCEPT
SELECT * FROM lake.ods.ods_order_info_inc TIMESTAMP AS OF '2026-10-09 09:00:00';

-- 日终打标签，保留 30 天，供对账与复现报表
ALTER TABLE lake.ods.ods_order_info_inc CREATE TAG `eod_20261009` RETAIN 30 DAYS;
SELECT COUNT(*) FROM lake.ods.ods_order_info_inc VERSION AS OF 'eod_20261009';

-- 文件级统计：排查小文件与删除文件堆积
SELECT content, COUNT(*) AS files, SUM(record_count) AS records,
       ROUND(AVG(file_size_in_bytes) / 1048576, 1) AS avg_mb
FROM lake.ods.ods_order_info_inc.files
GROUP BY content;

-- 误操作后回滚到指定快照（生成新的元数据版本，不删除任何文件）
CALL lake.system.rollback_to_snapshot('ods.ods_order_info_inc', 8744736658442914487);
```

`files` 元数据表的 `content` 列：0 是数据文件，1 是位置删除文件（v3 的删除向量也计入这一类），2 是等值删除文件。删除文件占比持续升高，说明该做合并了。

### 4、Schema 与分区演进

```sql
-- 加列、改名：纯元数据操作
ALTER TABLE lake.ods.ods_order_info_inc ADD COLUMN coupon_amount DECIMAL(12, 2) AFTER amount;
ALTER TABLE lake.ods.ods_order_info_inc RENAME COLUMN status TO order_status;

-- 大促期间单日数据量暴涨，新数据改为按小时分区，历史数据保持按天
ALTER TABLE lake.ods.ods_order_info_inc REPLACE PARTITION FIELD days(order_time) WITH hours(order_time);

-- 按店铺聚簇写入，提升 shop_id 过滤时的文件跳过率
ALTER TABLE lake.ods.ods_order_info_inc WRITE ORDERED BY shop_id, order_time;
```

改名前要确认下游：引擎层面按列 ID 读是安全的，但下游 SQL、BI 报表和同步任务里写死的列名会失效。

---

## 四、四种表格式对比

| 维度 | Apache Iceberg | Apache Paimon | Apache Hudi | Delta Lake |
|------|----------------|---------------|-------------|------------|
| 起源与治理 | Netflix 开源，ASF 顶级项目 | 源自 Flink Table Store，ASF 顶级项目 | Uber 开源，ASF 顶级项目 | Databricks 开源，Linux 基金会项目 |
| 设计重心 | 多引擎共享的分析表标准 | 流式更新：高频 upsert 与 changelog | 增量处理：upsert 与增量拉取 | Spark 生态下的可靠表 |
| 元数据组织 | metadata.json + 清单列表 + 清单 | 快照 + 清单，数据按桶组织为 LSM 树 | 时间线（Timeline，1.x 起为 LSM 时间线） | `_delta_log` 下的 JSON 提交日志 + Parquet 检查点 |
| 行级更新 | COW / MOR（删除文件、v3 删除向量） | 主键表 LSM 合并，删除向量可选 | COW / MOR（基础文件 + 日志文件） | COW，删除向量实现 MOR |
| 主键语义 | 无强制主键，标识字段用于 upsert | 原生主键，多种合并引擎 | 原生记录键 + 索引 | 无主键，靠 `MERGE` |
| 流式读取变更 | 增量读追加数据；完整变更流较弱 | 完整 changelog，下游可直接流式消费 | 增量查询 + CDC 查询 | Change Data Feed |
| 并发控制 | 乐观并发，由 Catalog 原子提交 | 乐观并发；动态桶要求单写者 | 乐观并发，1.0 起支持非阻塞并发控制 | 乐观并发，基于日志条目的原子写入 |
| 引擎生态 | 最广：Spark、Flink、Trino、Doris、StarRocks、各大云数仓 | Flink 最完整，Spark、Trino、Doris、StarRocks 可读写 | Spark 最完整，Flink 次之 | Spark 最完整，UniForm 可让 Iceberg 客户端读取 |

选型建议：

- **以批处理和多引擎共享为主**，或者希望表能被云厂商的数仓、查询服务直接读：选 **Iceberg**，它已是事实上的开放表标准，REST Catalog 生态最成熟
- **以 Flink 实时入湖、分钟级更新为主**，需要主键 upsert、部分列更新、预聚合和下游流式消费：选 **Paimon**，详见第八节
- **已有成熟的 Hudi 增量链路**（Spark 为主、依赖增量查询）：继续使用，新建平台较少再首选
- **Databricks 或纯 Spark 技术栈**：Delta 最省心；需要开放给其他引擎时开启 UniForm

一个常见组合是"Paimon 承接实时 ODS / DWD，Iceberg 承载离线 DWS / ADS 和对外共享"，两者都能挂在同一个 Catalog（如 Gravitino）下统一管理。

---

## 五、Catalog：湖仓的元数据入口

表格式只定义了"文件怎么组织"，"表名在哪、当前版本是哪个、谁能访问"由 Catalog 负责。Catalog 选错了，多引擎共享就是空话。

| 方案 | 原子提交方式 | 优点 | 局限 |
|------|--------------|------|------|
| Hive Metastore | HMS 表锁 + 表参数 `metadata_location` | 存量最多，几乎所有引擎都支持 | 依赖老旧的 Thrift 服务；锁与超时问题多；没有细粒度权限 |
| JDBC Catalog | 数据库条件 `UPDATE` | 部署简单，一个 MySQL / PostgreSQL 即可 | 每个引擎都要直连数据库，权限难管 |
| REST Catalog | 服务端事务提交 | 引擎只说 HTTP 协议；服务端可做权限、凭证下发、多表事务、审计 | 需要部署一个 Catalog 服务 |
| 云厂商托管 | 各自实现，多已提供 REST 接口 | 免运维 | 绑定云厂商 |

**REST Catalog 是当前的主流方向**。Iceberg 项目以 OpenAPI 规范定义了 REST Catalog 协议，引擎侧只需要实现一个通用客户端，换 Catalog 服务不改引擎配置以外的任何东西。它带来几项 HMS 做不到的能力：

- **凭证下发（credential vending）**：客户端加载表时，Catalog 返回只对该表路径有效的临时存储凭证，计算集群不再需要持有整个存储桶的长期密钥
- **服务端提交与冲突检测**：提交逻辑集中在服务端，客户端实现更薄，也为多表事务打下基础
- **统一权限与审计**：表、命名空间级别的授权在 Catalog 里做一次，所有引擎都生效

常见的开源实现：

- **Apache Polaris**：Iceberg REST Catalog 的完整实现，内置基于角色的访问控制和凭证下发，2026 年 2 月从孵化器毕业成为 ASF 顶级项目，1.4 版本完善了多租户
- **Apache Gravitino**：定位为统一元数据湖，用一套接口联邦管理 Hive、Iceberg、Paimon、Hudi、JDBC 数据库、Kafka、文件集等多种元数据，并对外提供 Iceberg REST 服务；2025 年 6 月成为 ASF 顶级项目
- **其他**：Unity Catalog 开源版、Project Nessie（带 Git 式分支语义）、Lakekeeper 等；Paimon 也定义了自己的 REST Catalog 协议

查询引擎侧同样通过 REST 接入。以 Trino 为例，在 `etc/catalog/lake.properties` 中：

```properties
connector.name=iceberg
iceberg.catalog.type=rest
iceberg.rest-catalog.uri=http://polaris:8181/api/catalog
iceberg.rest-catalog.warehouse=lake
iceberg.rest-catalog.security=OAUTH2
iceberg.rest-catalog.oauth2.credential=${ENV:POLARIS_CLIENT_ID}:${ENV:POLARIS_CLIENT_SECRET}
iceberg.rest-catalog.oauth2.scope=PRINCIPAL_ROLE:ALL
iceberg.rest-catalog.vended-credentials-enabled=true
fs.native-s3.enabled=true
s3.region=us-east-1
```

`vended-credentials-enabled` 让 Trino 使用 Catalog 下发的临时凭证访问存储；文件系统仍需显式启用（这里是原生 S3 实现），区域按实际存储填写。

之后在 Trino 中 `SELECT * FROM lake.ods.ods_order_info_inc FOR VERSION AS OF 8744736658442914487` 即可时间旅行，元数据表写成 `lake.ods."ods_order_info_inc$snapshots"`。

---

## 六、小文件治理与表维护

### 1、小文件从哪来

- **流式写入**：Flink 每次 checkpoint 提交一次，每个并行度、每个分区都会产生文件，1 分钟一次 checkpoint、32 个并行度，一天就是数万个小文件
- **过细的分区**：按小时分区再按用户分桶，每个格子里只有几 MB
- **MOR 删除文件**：频繁 upsert 产生大量删除文件，读时合并开销持续上升
- **元数据膨胀**：每次提交都产生新的 metadata.json、清单列表和清单，快照不清理，元数据比数据增长还快

小文件的代价是：规划变慢（清单条目多）、打开文件的固定开销放大、对象存储请求数暴涨、列式压缩与谓词下推效果变差。

### 2、Iceberg 维护任务

```sql
-- 1. 合并小文件，同时把删除信息压实进数据文件（只处理最近 7 天的分区）
CALL lake.system.rewrite_data_files(
  table   => 'ods.ods_order_info_inc',
  where   => 'order_time >= TIMESTAMP "2026-10-03 00:00:00"',
  options => map(
    'target-file-size-bytes',   '268435456',
    'min-input-files',          '5',
    'delete-file-threshold',    '3',
    'partial-progress.enabled', 'true'
  )
);

-- 2. 合并清单文件，让规划时读的清单更少
CALL lake.system.rewrite_manifests('ods.ods_order_info_inc');

-- 3. 过期快照：删除 7 天前的快照，但至少保留最近 50 个
CALL lake.system.expire_snapshots(
  table       => 'ods.ods_order_info_inc',
  older_than  => TIMESTAMP '2026-10-03 00:00:00',
  retain_last => 50
);

-- 4. 清理孤儿文件：失败作业留下、任何快照都不引用的文件
CALL lake.system.remove_orphan_files(
  table      => 'ods.ods_order_info_inc',
  older_than => TIMESTAMP '2026-10-07 00:00:00'
);
```

- **顺序**：合并数据文件 → 合并清单 → 过期快照 → 清理孤儿文件。合并后旧文件仍被旧快照引用，过期快照之后才真正可删
- **时间旅行的代价**：快照过期后就不能再回到那个版本了，保留期要与"最远需要回溯几天"对齐，需要长期保留的版本用标签
- **孤儿文件的保留期**：`remove_orphan_files` 默认只删 3 天前的文件，不要调得太短，否则会误删正在写入、尚未提交的文件
- **调度**：这些任务通常每天由调度系统统一跑（见 [任务调度](./6_scheduling)），只处理最近有写入的分区；也可以交给 Catalog 或平台的自动表维护服务
- **写入侧先治本**：合理的 checkpoint 间隔、写入前按分区 shuffle（`write.distribution-mode = hash`）、不要过度分区，比事后合并更有效

### 3、Paimon 的做法

Paimon 主键表的数据按桶组织成 LSM 树，**写入作业在写的同时异步做合并**，小文件和删除信息在写入链路中就被持续消化，一般不需要像 Iceberg 那样单独调度合并任务。写入压力大时可以在写入作业中设置 `'write-only' = 'true'` 关闭合并，另起一个专门的合并作业；快照过期由写入作业按 `snapshot.time-retained`、`snapshot.num-retained.min` 等参数自动完成。

---

## 七、湖仓：在湖上直接查询

湖仓的"仓"体现在查询侧：不再把湖里的数据再导一遍到数仓，而是让查询引擎直接读湖表。

| 引擎 | 角色 | 湖表支持 |
|------|------|----------|
| Spark | 离线 ETL、批量回刷、表维护 | Iceberg / Paimon / Hudi / Delta 全面读写 |
| Flink | 流式写入、流式读取变更 | Paimon 最完整，Iceberg / Hudi 可读写 |
| Trino | 交互式即席查询、跨源联邦 | Iceberg / Delta / Hudi 连接器，Paimon 项目提供独立的 Trino 连接器 |
| Doris / StarRocks | 高并发、低延迟的分析服务 | 通过外部 Catalog 直接查 Iceberg / Paimon / Hudi / Hive，可在湖表上建异步物化视图加速 |

选型思路：

- **即席分析、数据探索**：Trino 或 Doris / StarRocks 直接查湖表，免去导数
- **报表、看板这类高并发查询**：湖表的延迟（对象存储读取 + 元数据规划）通常在秒级，扛不住几百 QPS 的面板；在 Doris / StarRocks 上对湖表建物化视图，或把 ADS 层结果写入其内表
- **冷热分层**：近期热数据放 OLAP 内表，历史数据留在湖里按需查询，策略见 [数据冷热分离](/architecture/1_cold_hot_data)

Doris / StarRocks 的数据模型、物化视图与选型对比见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)；对外提供查询服务的整体设计见 [OLAP 查询与数据服务](./7_olap_service)。

---

## 八、Flink + Paimon：流式湖仓

传统实时数仓用 Kafka 做中间层，数据不可查、保留期有限、回溯困难；离线数仓又是 T+1。Paimon 让一张湖表同时具备"可以被流式消费"和"可以被批量查询"两种身份，实时链路的每一层都落在湖上。

### 1、主键表的关键配置

| 配置 | 取值 | 说明 |
|------|------|------|
| `bucket` | 默认 `-1`（动态桶）；正整数为固定桶；`-2` 为延后定桶 | 桶是读写并行的最小单位；动态桶自动扩展，但同一分区只允许一个作业写 |
| `merge-engine` | `deduplicate`（默认）/ `partial-update` / `aggregation` / `first-row` | 同一主键多条记录如何合并：保留最新、按列补齐、预聚合、保留第一条 |
| `changelog-producer` | `none`（默认）/ `input` / `lookup` / `full-compaction` | 下游流式读取时能否拿到完整的 `-U` / `+U` 变更 |
| `sequence.field` | 列名 | 按业务时间而不是到达顺序决定"最新"，防止乱序数据覆盖新值 |

`changelog-producer` 最容易被忽略：默认 `none` 时，下游流式读只能拿到每条记录的最新值，没有更新前镜像，做聚合会算错。上游是 CDC（本身带完整变更）可以用 `input`；上游不带完整变更、下游又要做聚合时用 `lookup`，在合并时查出旧值生成完整 changelog。

### 2、订单实时入湖与汇总

```sql
CREATE CATALOG paimon WITH (
  'type'      = 'paimon',
  'warehouse' = 's3://lake/paimon'
);
USE CATALOG paimon;
CREATE DATABASE IF NOT EXISTS ods;
CREATE DATABASE IF NOT EXISTS dws;

-- ODS：订单主键表，按 update_time 判断新旧，产出完整 changelog
CREATE TABLE ods.ods_order_info_inc (
  order_id     BIGINT,
  user_id      BIGINT,
  shop_id      BIGINT,
  amount       DECIMAL(12, 2),
  status       STRING,
  order_time   TIMESTAMP(3),
  update_time  TIMESTAMP(3),
  dt           STRING,
  PRIMARY KEY (dt, order_id) NOT ENFORCED
) PARTITIONED BY (dt) WITH (
  'merge-engine'       = 'deduplicate',
  'sequence.field'     = 'update_time',
  'changelog-producer' = 'lookup'
);

-- DWS：店铺日 GMV，聚合引擎在湖里直接累加，撤回消息会被正确扣减
CREATE TABLE dws.dws_trade_shop_order_1d (
  dt       STRING,
  shop_id  BIGINT,
  gmv      DECIMAL(18, 2),
  PRIMARY KEY (dt, shop_id) NOT ENFORCED
) WITH (
  'merge-engine'                  = 'aggregation',
  'fields.gmv.aggregate-function' = 'sum',
  'changelog-producer'            = 'lookup'
);

SET 'execution.runtime-mode' = 'streaming';

-- 流式读 ODS 的变更：订单金额被修改时，先收到 -U 旧值再收到 +U 新值
INSERT INTO dws.dws_trade_shop_order_1d
SELECT dt, shop_id, amount
FROM ods.ods_order_info_inc
WHERE status <> 'CANCELLED';
```

- ODS 表的数据通常由 Flink CDC 整库同步写入（YAML 管道 `sink.type: paimon`，自动建表并跟随上游 Schema 演进），写法见 [Flink CDC](/flink/6_cdc)；Paimon 在 checkpoint 时提交快照，配合 CDC 源可做到端到端精确一次
- 访问 S3 需要把 Paimon 的 S3 文件系统 Jar 放进 Flink 的 `lib` 目录，具体构件名按 Paimon 安装文档选择
- 订单从 `PAID` 变成 `CANCELLED` 时，WHERE 过滤会把这条更新转成对旧值的撤回，GMV 自动扣减；这依赖 ODS 的 `lookup` changelog 提供完整的更新前镜像
- 同一张 `dws.dws_trade_shop_order_1d` 既能被下游 Flink 继续流式消费，也能被 Spark、Trino、Doris 批量查询，天然实现"流批一体"的同一份口径

### 3、Kafka 还是 Paimon 做中间层

Paimon 的端到端延迟由 checkpoint 间隔决定，一般在 1～5 分钟；大屏、风控这类秒级场景仍然走 Kafka。两者的取舍、DWD 维表关联写法见 [Flink 实战场景](/flink/8_scenarios)；本模块的 [实时数仓实战](./9_realtime_dw) 会把 CDC 入湖、分层加工、OLAP 服务串成一条完整链路。

---

## 小结

- Hive 表只是目录约定，没有文件级元数据、没有事务、改不动 Schema 和分区；湖仓在对象存储的开放文件上加一层表格式，把 ACID、行级更新、演进能力带到湖上，并让多个引擎共享同一张表
- 表格式的核心是一棵不可变的元数据树：Catalog 指针 → metadata.json → 清单列表 → 清单 → 数据文件；提交是对 Catalog 指针的 CAS，冲突时基于新版本重试
- 行级更新有 COW 与 MOR 两种，Iceberg v3 用删除向量降低 MOR 的读开销；Schema 演进靠列 ID，分区演进靠带版本的分区规范和隐藏分区
- 选型：多引擎、批处理、对外共享选 Iceberg；Flink 实时 upsert、changelog 下游消费选 Paimon；Hudi、Delta 适合各自已有的技术栈
- Catalog 优先选 REST 协议的实现（Polaris、Gravitino 等），获得凭证下发、统一权限和服务端提交
- MOR 和流式写入必然带来小文件和删除文件堆积，Iceberg 要按"合并数据文件 → 合并清单 → 过期快照 → 清理孤儿文件"定期维护，Paimon 在写入链路中自动合并
- 交互查询用 Trino / Doris / StarRocks 直接读湖表，高并发服务靠物化视图或 OLAP 内表；分钟级实时链路用 Flink + Paimon，秒级仍走 Kafka
- 本篇只讲湖表本身：对象存储与存算分离的基本原理见 [大数据基础](./1_basics)；Flink 的运行时、Flink SQL 与 Flink CDC 见 [Flink 总览](/flink/0_overview)；Doris / StarRocks / ClickHouse 本身见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)；冷数据归档到对象存储的策略见 [数据冷热分离](/architecture/1_cold_hot_data)；数据怎么从业务库进湖见 [数据集成](./5_data_integration)

## 参考资料

- Iceberg 表格式规范：[Iceberg Table Spec](https://iceberg.apache.org/spec/)
- Iceberg 版本发布：[Iceberg Releases](https://iceberg.apache.org/releases/)
- Iceberg Spark 配置与快速开始：[Spark Configuration](https://iceberg.apache.org/docs/latest/spark-configuration/)、[Spark Quickstart](https://iceberg.apache.org/spark-quickstart/)
- Iceberg Spark 查询、DDL 与写入：[Spark Queries](https://iceberg.apache.org/docs/latest/spark-queries/)、[Spark DDL](https://iceberg.apache.org/docs/latest/spark-ddl/)、[Spark Writes](https://iceberg.apache.org/docs/latest/spark-writes/)
- Iceberg 存储过程与表维护：[Spark Procedures](https://iceberg.apache.org/docs/latest/spark-procedures/)、[Maintenance](https://iceberg.apache.org/docs/latest/maintenance/)
- Iceberg 表属性：[Configuration](https://iceberg.apache.org/docs/latest/configuration/)
- Iceberg REST Catalog 协议：[REST Catalog OpenAPI Spec](https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml)
- Paimon 文档：[Apache Paimon Docs](https://paimon.apache.org/docs/master/)、[Flink Quick Start](https://paimon.apache.org/docs/master/flink/quick-start/)
- Paimon 主键表数据分布与 changelog：[Data Distribution](https://paimon.apache.org/docs/master/primary-key-table/data-distribution/)、[Changelog Producer](https://paimon.apache.org/docs/master/primary-key-table/changelog-producer/)
- Paimon 版本发布：[Paimon Releases](https://github.com/apache/paimon/releases)
- Hudi 文档：[Apache Hudi Docs](https://hudi.apache.org/docs/overview)
- Delta Lake 文档与发布：[Delta Lake Documentation](https://docs.delta.io/latest/index.html)、[Delta Lake Releases](https://github.com/delta-io/delta/releases)
- Polaris：[Apache Polaris](https://polaris.apache.org/)
- Gravitino：[Apache Gravitino](https://gravitino.apache.org/)、[Gravitino 毕业公告](https://gravitino.apache.org/blog/gravitino-top-level-project)
- Trino Iceberg 连接器：[Trino Iceberg Connector](https://trino.io/docs/current/connector/iceberg.html)

> 下一篇：[数据集成](./5_data_integration)

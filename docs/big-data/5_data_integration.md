---
description: DataX 与 SeaTunnel 离线同步、Kafka Connect / Flink CDC 实时入湖、全量 + 增量、幂等写入、对账、表结构变更
---

# 数据集成

> 前置阅读：[数仓分层与建模](./2_data_warehouse)、[数据湖与湖仓](./4_lakehouse)、[CDC 工具](/database/5_practice/0_cdc_tools)

数据集成负责把业务库、日志和外部系统的数据按约定时效同步进数据平台，并保证与源头对得上。本篇讲 DataX / SeaTunnel 离线同步、Debezium + Kafka Connect 与 Flink CDC 实时入湖、全量与增量衔接、幂等写入、对账和表结构变更，版本基线为 DataX `datax_v202309`、SeaTunnel 3.0（2.3.x 文档已标为不再维护）、Debezium 3.x、Flink CDC 3.6、Iceberg 1.12（均为 Apache License 2.0）。

---

## 一、数据集成全景

数据集成要回答的问题是：**业务数据怎么可靠地、按约定的时效进入数据平台，并且进来之后和源头对得上**。一个电商平台的数据来源通常有三类：业务库（订单、商品、用户）、行为日志（App / Web 埋点）、外部系统（物流、广告投放、支付对账单）。本篇示例统一用电商订单：MySQL 订单库 `shop.order_info` 同步到湖仓 ODS 层。

![数据集成架构：离线批量 + 实时增量，源端与目标端对账](../assets/big-data/integration-sync-architecture.svg)

| 维度 | 离线批量同步 | 实时增量同步 |
|------|--------------|--------------|
| 时效 | T+1 或小时级 | 秒级到分钟级 |
| 读取方式 | 按 SQL 查询源表（全量或按时间增量） | 订阅 binlog / WAL 变更日志 |
| 对源库影响 | 集中时段的大查询，需走从库、限速 | 持续但轻量，只读日志 |
| 能否捕获删除 | 不能（硬删除的行查不到） | 能，事件里带删除和更新前的值 |
| 运维形态 | 调度系统按周期拉起，跑完即结束 | 常驻作业，需要监控延迟与断点续传 |
| 典型工具 | DataX、SeaTunnel（批模式）、Spark JDBC | Debezium + Kafka Connect、Flink CDC、SeaTunnel CDC |
| 适用 | 维表、外部系统、对时效不敏感的报表 | 订单、库存等需要分钟级可见、要感知删除的核心表 |

两条链路不是二选一：核心交易表走实时，同时保留一条离线全量链路做兜底与对账；维表、配置表这种小表每天全量覆盖最简单可靠。

---

## 二、DataX：离线批量同步

DataX 是阿里开源的离线同步框架，把同步抽象成 **Reader → Framework → Writer**：Reader 插件读源端，Writer 插件写目标端，Framework 负责切分任务、并发、限速、脏数据统计。一个 Job 按 `splitPk` 切成多个 Task，Task 被分到若干 TaskGroup，每个 Task 由一个 Channel（读写线程对）执行。

### 1、作业 JSON：MySQL 订单增量写入 Hive ODS

先在 Hive 中建好目标表和当天分区（DataX 只负责写文件，不会帮你建表和登记分区）：

```sql
CREATE TABLE IF NOT EXISTS ods.ods_order_info_inc (
  order_id     BIGINT,
  user_id      BIGINT,
  shop_id      BIGINT,
  amount       DECIMAL(12, 2),
  status       STRING,
  order_time   TIMESTAMP,
  update_time  TIMESTAMP
)
PARTITIONED BY (dt STRING)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
STORED AS TEXTFILE;

ALTER TABLE ods.ods_order_info_inc ADD IF NOT EXISTS PARTITION (dt = '2026-10-09');
```

作业文件 `order_info_inc.json`：

```json
{
  "job": {
    "setting": {
      "speed": {
        "channel": 4
      },
      "errorLimit": {
        "record": 0,
        "percentage": 0
      }
    },
    "content": [
      {
        "reader": {
          "name": "mysqlreader",
          "parameter": {
            "username": "datax_reader",
            "password": "${src_password}",
            "column": ["order_id", "user_id", "shop_id", "amount", "status", "order_time", "update_time"],
            "splitPk": "order_id",
            "where": "update_time >= '${start}' AND update_time < '${end}'",
            "connection": [
              {
                "table": ["order_info"],
                "jdbcUrl": ["jdbc:mysql://mysql-order-replica:3306/shop?useSSL=false&serverTimezone=Asia/Shanghai"]
              }
            ]
          }
        },
        "writer": {
          "name": "hdfswriter",
          "parameter": {
            "defaultFS": "hdfs://namenode:8020",
            "fileType": "text",
            "path": "/user/hive/warehouse/ods.db/ods_order_info_inc/dt=${dt}",
            "fileName": "order_info",
            "column": [
              {"name": "order_id", "type": "BIGINT"},
              {"name": "user_id", "type": "BIGINT"},
              {"name": "shop_id", "type": "BIGINT"},
              {"name": "amount", "type": "STRING"},
              {"name": "status", "type": "STRING"},
              {"name": "order_time", "type": "TIMESTAMP"},
              {"name": "update_time", "type": "TIMESTAMP"}
            ],
            "writeMode": "truncate",
            "fieldDelimiter": "\t"
          }
        }
      }
    ]
  }
}
```

运行（`-p` 传入作业里的 `${变量}`，值里不要带空格）：

```bash
python bin/datax.py \
  -p "-Ddt=2026-10-09 -Dstart=2026-10-09 -Dend=2026-10-10 -Dsrc_password=${SRC_PASSWORD}" \
  job/order_info_inc.json
```

逐项说明：

- **读从库**：`jdbcUrl` 指向只读副本，避免大查询影响主库；`jdbcUrl` 和 `table` 都是数组，必须放在 `connection` 里
- **`splitPk`**：按主键范围切分成多个 Task 并发读，只支持整数主键；不配则单线程读整张表。实际并发受 `channel` 限制
- **`where` 用左闭右开**：`[start, end)` 保证相邻两天既不重不漏；`update_time` 上要有索引，并且业务更新时必须刷新它（`ON UPDATE CURRENT_TIMESTAMP` 或由 ORM 统一维护）
- **`writeMode: truncate`**：写入前清空目标目录下以 `fileName` 为前缀的文件，同一天重跑结果不变，这是离线同步幂等的关键；`append` 重跑会产生重复数据
- **金额声明为 `STRING`**：文本文件里写原样的 `199.00`，由 Hive 按表上的 `DECIMAL(12,2)` 解析，避免经过 `DOUBLE` 丢精度；`fieldDelimiter` 必须与建表语句一致
- **`errorLimit`**：脏数据（类型转换失败等）超过阈值就让作业失败；对账要求严格的表设为 0
- **密码不要写死在 JSON 里**：由调度系统从密钥管理中取出后经环境变量传入；生产上 Hive 表推荐用 ORC / Parquet（`fileType: "orc"`），文本格式只是为了示例直观

`python bin/datax.py -r mysqlreader -w hdfswriter` 可以打印一对 Reader / Writer 的配置模板。

### 2、DataX 的局限

- **只做批**：没有 CDC，捕获不到硬删除，时效受调度周期限制
- **单机进程**：一个 Job 跑在一台机器上，靠多开进程和调度系统分摊，没有分布式容错，失败只能整体重跑
- **不感知表结构**：`column` 写死列名，上游加列不会自动同步；写 `"column": ["*"]` 则上游一改列序就会错位写入
- **社区活跃度下降**：开源版最近一次发布停在 2023 年，新的湖仓目标端（Iceberg、Paimon）需要自己写插件或借助社区分支

存量的 DataX 作业稳定运行就不必急着迁；新建平台、需要 CDC 或湖仓写入时，优先考虑 SeaTunnel 或 Flink CDC。

---

## 三、SeaTunnel：多引擎的数据集成平台

SeaTunnel 的连接器（Connector-V2）与执行引擎解耦，同一份配置可以跑在三种引擎上：

| 引擎 | 启动方式 | 特点 |
|------|----------|------|
| Zeta（SeaTunnel Engine） | `bin/seatunnel.sh` | 官方自研、默认推荐；支持批、流、CDC 多表同步、Schema 演进，资源占用小，可单机或集群部署 |
| Flink | `bin/start-seatunnel-flink-15-connector-v2.sh`（1.15～1.18）、`flink-13`（1.12～1.14） | 复用已有 Flink 集群；官方文档列出的是 Flink 1.x，与本站 Flink 2.2 基线的集群不能直接复用 |
| Spark | `bin/start-seatunnel-spark-3-connector-v2.sh`（Spark 3.x） | 复用已有 Spark 集群，适合批量场景 |

### 1、批量同步：MySQL 订单写入 Doris

配置使用 HOCON 格式，由 `env`、`source`、`transform`（可选）、`sink` 四段组成：

```hocon
env {
  job.mode = "BATCH"
  parallelism = 4
}

source {
  Jdbc {
    url = "jdbc:mysql://mysql-order-replica:3306/shop?serverTimezone=Asia/Shanghai"
    driver = "com.mysql.cj.jdbc.Driver"
    user = "st_reader"
    password = "${SRC_PASSWORD}"
    query = "select order_id, user_id, shop_id, amount, status, order_time, update_time from order_info where update_time >= '${start}' and update_time < '${end}'"
    partition_column = "order_id"
    fetch_size = 5000
    plugin_output = "order_info"
  }
}

sink {
  Doris {
    plugin_input = "order_info"
    fenodes = "doris-fe:8030"
    query-port = 9030
    username = "st_writer"
    password = "${DORIS_PASSWORD}"
    database = "ods"
    table = "ods_order_info_inc"
    sink.label-prefix = "ods_order_info_inc_${start}"
    sink.enable-2pc = "true"
    doris.config {
      format = "json"
      read_json_by_line = "true"
    }
    schema_save_mode = "CREATE_SCHEMA_WHEN_NOT_EXIST"
    data_save_mode = "APPEND_DATA"
  }
}
```

```bash
# 变量值不能含空格；密码不经 -i 传，直接读环境变量 SRC_PASSWORD / DORIS_PASSWORD
./bin/seatunnel.sh --config config/order_info_to_doris.conf \
  -i start=2026-10-09 -i end=2026-10-10 \
  -m cluster
```

- `plugin_output` / `plugin_input` 用来连接上下游（旧名 `result_table_name` / `source_table_name` 已废弃）
- MySQL 驱动 Jar 需要自行放到 `$SEATUNNEL_HOME/lib/`（Zeta 引擎）
- Doris 目标表建议用 **Unique Key 模型**，`APPEND_DATA` 加主键覆盖写，重跑同一时间窗结果不变；`sink.enable-2pc` 开启两阶段提交，`sink.label-prefix` 要全局唯一
- `-m local` 在本机启动一个临时引擎，调试用；`-m cluster`（默认）提交到已部署的 Zeta 集群

### 2、实时同步：MySQL-CDC 多表入湖

把 `job.mode` 改为 `STREAMING`、Source 换成 `MySQL-CDC`，就成了一条实时同步链路：

```hocon
env {
  job.mode = "STREAMING"
  parallelism = 2
  checkpoint.interval = 60000
}

source {
  MySQL-CDC {
    url = "jdbc:mysql://mysql-order:3306/shop"
    username = "st_cdc"
    password = "${CDC_PASSWORD}"
    table-names = ["shop.order_info", "shop.order_item"]
    startup.mode = "initial"
    server-id = "5401-5404"
    schema-changes.enabled = true
  }
}

sink {
  Paimon {
    warehouse = "s3://lake/paimon"
    database = "ods"
    table = "ods_${table_name}_inc"
    paimon.table.write-props = {
      changelog-producer = "input"
    }
  }
}
```

- `startup.mode = "initial"` 先做全量快照再接 binlog；`server-id` 给范围，每个并行读取线程占一个，且不能与其他 binlog 客户端冲突
- `${table_name}` 是 Sink 的保留占位符，按上游表名分别写入 `ods.ods_order_info_inc`、`ods.ods_order_item_inc`
- `schema-changes.enabled` 默认关闭，开启后上游的加列、删列、改名等变更会传给支持 Schema 演进的 Sink（Paimon Sink 支持加列、删列、类型拓宽等）；对 S3 的访问参数按 Paimon Sink 文档配置

### 3、DataX 与 SeaTunnel 怎么选

| 维度 | DataX | SeaTunnel |
|------|-------|-----------|
| 处理模式 | 只有批 | 批、流、CDC |
| 执行形态 | 单机多线程 | Zeta 集群，或跑在 Flink / Spark 上 |
| 容错 | 失败整体重跑 | 基于 checkpoint 断点续传 |
| 多表 / 整库同步 | 一个 Job 一张表（可多张同构表） | 原生支持多表、正则匹配表名 |
| 自动建表与 Schema 演进 | 不支持 | `schema_save_mode` 自动建表，CDC 场景支持 Schema 演进 |
| 湖仓目标端 | 需自研插件 | Iceberg、Paimon、Hudi、Doris、StarRocks 等官方连接器 |
| 社区 | 开源版更新停滞 | ASF 顶级项目，持续发版 |
| 上手成本 | 低，一个 JSON 一个命令 | 中，需要部署引擎集群 |

---

## 四、实时同步：Kafka Connect 与 Flink CDC

MySQL 的 binlog 与账号前置配置、Canal / Debezium 的事件结构见 [CDC 工具](/database/5_practice/0_cdc_tools)。

### 1、Debezium + Kafka Connect

Debezium MySQL Connector 作为 Source 把每张表的变更写入一个 Kafka 主题（`<topic.prefix>.<库>.<表>`），再由 Sink Connector 写到目标端。Kafka 在中间起到**缓冲和多路分发**的作用：同一份订单变更可以同时供湖仓入湖、搜索索引更新、缓存失效等多个下游消费。Kafka Connect 的概念与 Debezium Source 的完整配置见 [Kafka](/messaging/2_kafka) 第十节，这里给出写入 Iceberg 的 Sink（Iceberg 1.7 起官方自带 Kafka Connect Sink）：

```json
{
  "name": "iceberg-order-info-sink",
  "config": {
    "connector.class": "org.apache.iceberg.connect.IcebergSinkConnector",
    "tasks.max": "2",
    "topics": "mysql-order.shop.order_info",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.add.fields": "op,source.ts_ms",
    "transforms.unwrap.delete.tombstone.handling.mode": "rewrite",
    "iceberg.tables": "ods.ods_order_info_changelog",
    "iceberg.tables.auto-create-enabled": "true",
    "iceberg.tables.evolve-schema-enabled": "true",
    "iceberg.catalog.type": "rest",
    "iceberg.catalog.uri": "http://polaris:8181/api/catalog",
    "iceberg.catalog.warehouse": "lake",
    "iceberg.catalog.credential": "${env:POLARIS_CREDENTIAL}",
    "iceberg.control.commit.interval-ms": "60000"
  }
}
```

- `ExtractNewRecordState` 把 Debezium 的 `before` / `after` 信封展开成一行；`add.fields` 追加 `__op`（c / u / d / r）和 `__source_ts_ms`；`rewrite` 把删除事件改写成带 `__deleted = true` 的普通记录，删除信息不会丢
- 这样写出的是一张**只追加的变更日志表**，再由下游 Spark 作业按主键取最新一条 `MERGE` 进 ODS 当前表（写法见第五节）；比起让 Sink 直接 upsert，这种两段式更容易回溯和对账
- Sink 按 `commit.interval-ms` 周期性地协调各 Task 统一提交一个 Iceberg 快照（默认 5 分钟），依赖 Kafka 事务（KIP-447）实现精确一次；间隔越短，小文件越多
- `${env:...}` 需要在 Connect Worker 配置中启用 `EnvVarConfigProvider`；写入带 Schema 的表要求消息有 Schema（Avro + Schema Registry，或开启 `schemas.enable` 的 JSON）

### 2、Flink CDC

Flink CDC（3.6 兼容 Flink 1.20 / 2.2）不经过 Kafka，直接从 binlog 读到目标表：全量快照阶段无锁并行读取，结束后自动切换到 binlog，两阶段的衔接由框架保证。只做"把业务库整库复制到湖仓 / Doris"时，用 YAML 数据管道一个配置文件即可，自动建表并跟随上游 DDL；要在同步途中做关联、聚合时用 CDC Source 加 Flink SQL。增量快照原理、管道写法与精确一次的边界见 [Flink CDC](/flink/6_cdc)，本篇不再重复。

### 3、实时链路选型

| 场景 | 推荐 |
|------|------|
| 同一份变更要供多个下游消费（入湖 + 搜索 + 缓存失效） | Debezium + Kafka，下游各自用 Sink 或消费者 |
| 只把业务库整库复制到 Paimon / Doris / StarRocks，要求自动建表和 Schema 演进 | Flink CDC YAML 管道，或 SeaTunnel MySQL-CDC |
| 同步途中要做维表关联、打宽、聚合 | Flink CDC Source + Flink SQL |
| 已有 Kafka Connect 集群、团队不熟 Flink | Debezium + Kafka Connect + Iceberg Sink |
| 源库种类多（MySQL、PostgreSQL、Oracle、MongoDB 混合） | Debezium 覆盖最广，其次 Flink CDC |

无论哪种方案，实时链路都要监控三件事：**同步延迟**（源端提交时间与目标端可见时间之差）、**binlog 保留是否够长**（作业停机时间必须短于 binlog 保留期，否则只能重新全量）、**目标端提交是否卡住**（checkpoint 失败、Sink 提交超时）。

---

## 五、全量 + 增量：同步策略设计

### 1、三种同步方式

| 方式 | 做法 | 前提 | 适用 |
|------|------|------|------|
| 每日全量 | 每天整表导出，覆盖当天分区或整表 | 表不大（百万行以内） | 维表、配置表、字典表 |
| 时间戳增量 | 按 `update_time` 拉取一个时间窗内变化的行，合并进全量表 | 有可靠的更新时间列与索引，业务不做硬删除 | 中大型业务表的离线同步 |
| CDC 增量 | 订阅变更日志，按主键 upsert / delete | 开启 ROW 格式 binlog，保留期足够 | 核心交易表、需要感知删除的表 |

时间戳增量有三个经典坑：

- **硬删除丢失**：被 `DELETE` 的行不会出现在增量里，目标端永远留着。业务改为软删除（`is_deleted` 标记），或对这类表改用 CDC，或定期全量对比补删
- **长事务导致漏数**：一个事务 9:59 写入、10:01 才提交，`update_time` 是 9:59，而 10:00 截止的那一批查询时它还不可见，下一批又从 10:00 开始。解决办法是**窗口重叠**：每批多往前拉一段（如 10 分钟），靠幂等合并消除重复
- **更新时间不可靠**：批量脚本直接改库没刷 `update_time`。这类变更只能靠 CDC 或定期全量兜底

### 2、首次全量与增量的衔接

- **CDC 工具**：Flink CDC、Debezium（`snapshot.mode=initial`）、SeaTunnel MySQL-CDC 都内置"先全量快照、再从快照时刻的 binlog 位点接续"，衔接点由工具保证，直接用即可
- **离线链路**：先做一次全量初始化，记下开始时间 T0；之后的增量从 `T0 - 重叠窗口` 开始拉，靠主键合并去重
- **离线全量 + 实时增量混合**：先启动 CDC 作业（从当前位点开始，暂不消费或写入暂存表），再做离线全量，最后从全量开始时刻之前的位点回放增量合并。关键原则是**增量的起点必须早于全量的快照时刻**，宁可重叠，不可留缝

### 3、增量合并进当前表

ODS 增量分区（或上一节的变更日志表）合并进 DWD 当前表，用湖表的 `MERGE INTO` 实现：

```sql
MERGE INTO lake.dwd.dwd_trade_order_full t
USING (
  SELECT order_id, user_id, shop_id, amount, status, order_time, update_time, is_deleted
  FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY update_time DESC) AS rn
    FROM lake.ods.ods_order_info_inc
    WHERE dt = '2026-10-09'
  ) x
  WHERE rn = 1
) s
ON t.order_id = s.order_id
WHEN MATCHED AND s.is_deleted = 1 THEN DELETE
WHEN MATCHED AND s.update_time >= t.update_time THEN UPDATE SET
  user_id = s.user_id, shop_id = s.shop_id, amount = s.amount,
  status = s.status, order_time = s.order_time, update_time = s.update_time
WHEN NOT MATCHED AND s.is_deleted = 0 THEN INSERT
  (order_id, user_id, shop_id, amount, status, order_time, update_time)
  VALUES (s.order_id, s.user_id, s.shop_id, s.amount, s.status, s.order_time, s.update_time);
```

- 增量表带软删除标记 `is_deleted`（CDC 链路由变更日志里的 `__deleted` / `__op` 转换而来）
- 先用 `ROW_NUMBER` 在批内按主键去重，否则同一主键在一批里出现多次时，`MERGE` 会因"一个目标行匹配多个源行"而报错
- `s.update_time >= t.update_time` 防止重叠窗口或乱序带来的旧数据覆盖新数据；同一条数据重复合并结果不变
- 软删除标记在合并时转成物理删除，或保留为 DWD 的一个字段，按数仓规范决定

---

## 六、幂等写入

调度重试、手工补数、实时作业从 checkpoint 恢复，都会让同一批数据被写入不止一次。同步链路必须做到**写一次和写多次结果相同**：

| 目标端 | 幂等手段 | 说明 |
|--------|----------|------|
| Hive / 湖表分区 | 分区覆盖写 | Hive `INSERT OVERWRITE ... PARTITION (dt=...)`；DataX `writeMode: truncate`；Spark 设置 `spark.sql.sources.partitionOverwriteMode=dynamic` 后 `INSERT OVERWRITE` 只替换涉及的分区 |
| Iceberg / Hudi / Delta | `MERGE INTO` 按主键合并 | 见第五节，带版本比较条件 |
| Paimon | 主键表 | 同主键后写覆盖先写，`sequence.field` 指定按业务时间判断新旧 |
| Doris / StarRocks | Unique Key / Primary Key 模型 | 同主键覆盖；配合 Stream Load 的 label 去重，同一 label 不会重复导入 |
| MySQL 等关系库 | `INSERT ... ON DUPLICATE KEY UPDATE` 或先删后插（同一事务） | 目标表必须有主键或唯一键 |
| Kafka | 幂等生产者 + 事务 | 见 [Kafka](/messaging/2_kafka) 第五节；下游消费者仍需自行去重 |

几条原则：

- **只追加的写入天然不幂等**：日志类数据只能追加时，按"批次号 / 分区"覆盖写，或在下游按事件 ID 去重
- **重跑粒度与覆盖粒度一致**：作业按天重跑，就按天分区覆盖；按小时重跑却按天覆盖，会把同一天其他小时的数据清掉
- **两阶段提交管"恰好一次可见"**：Flink 的事务型 Sink、SeaTunnel Doris 的 `sink.enable-2pc` 保证故障恢复后不重复提交，但人工重跑同一时间窗仍要靠主键或分区覆盖

业务系统中的幂等设计（唯一索引、Token、状态机）见 [幂等设计](/architecture/5_idempotence)。

---

## 七、一致性校验与对账

"任务成功"不等于"数据对了"：源端有过滤条件写错、时区错位、字符截断、脏数据被跳过，作业都可能照样成功。对账就是**在源端和目标端按同一口径各算一遍，比较结果**。

### 1、校验层级

| 层级 | 比较内容 | 成本 | 能发现 |
|------|----------|------|--------|
| 行数 | `COUNT(*)` | 最低 | 漏数、重复 |
| 关键指标汇总 | `SUM(amount)`、`COUNT(DISTINCT user_id)` | 低 | 金额精度丢失、错行 |
| 分桶校验和 | 每行拼接后求哈希，按主键分桶求和 | 中 | 任意字段内容不一致，并定位到桶 |
| 抽样逐行比对 | 抽取部分主键全字段对比 | 高 | 具体哪一行、哪一列不同 |

### 2、行数与校验和对账

源端 MySQL（在从库上执行）：

```sql
SELECT order_id % 64 AS bucket,
       COUNT(*)      AS cnt,
       SUM(amount)   AS amt,
       SUM(CRC32(CONCAT_WS('|', order_id, user_id, shop_id, amount, status,
                           DATE_FORMAT(update_time, '%Y-%m-%d %H:%i:%s')))) AS chk
FROM order_info
WHERE order_time >= '2026-10-09' AND order_time < '2026-10-10'
GROUP BY order_id % 64;
```

目标端 Spark SQL：

```sql
SELECT order_id % 64 AS bucket,
       COUNT(*)      AS cnt,
       SUM(amount)   AS amt,
       SUM(crc32(concat_ws('|',
             CAST(order_id AS STRING), CAST(user_id AS STRING), CAST(shop_id AS STRING),
             CAST(amount AS STRING), status,
             date_format(update_time, 'yyyy-MM-dd HH:mm:ss')))) AS chk
FROM lake.dwd.dwd_trade_order_full
WHERE order_time >= TIMESTAMP '2026-10-09 00:00:00'
  AND order_time <  TIMESTAMP '2026-10-10 00:00:00'
GROUP BY order_id % 64;
```

- **两边的拼接结果必须逐字节相同**：数字统一转字符串（`DECIMAL(12,2)` 两边都输出 `199.00`）、时间统一格式与时区（Spark 会话时区 `spark.sql.session.timeZone` 要与 MySQL 连接时区一致）、`CONCAT_WS` 两边都会跳过 `NULL`
- **按主键分桶**：总数对不上时，只需在不一致的桶里继续下钻，不用全表逐行比
- **时间窗选稳定的数据**：实时链路的数据一直在变，对账选 T-1 这类已经稳定的窗口，或在源端与目标端取同一时刻的快照（Iceberg 用 `TIMESTAMP AS OF`）
- **口径一致**：目标端如果做过清洗（过滤测试订单、合并软删除），源端的统计 SQL 要用相同条件

### 3、把对账变成流程

- 对账作为同步任务的**下游节点**挂在调度 DAG 中，失败时阻断后续加工，避免错误数据流到报表（见 [任务调度](./6_scheduling)）
- 设定容忍阈值：实时链路允许极小的延迟误差，离线 T+1 必须完全一致
- 差异处理：按分区重跑同步；多次重跑仍不一致的，转人工排查源端异常写入
- 对账结果、差异明细沉淀为数据质量指标，纳入 [数据治理](./8_governance) 的质量监控

---

## 八、表结构变更处理

上游业务库改表结构是同步链路最常见的故障来源：加了一列下游没有、改了类型写入失败、改了列名数据错位。

### 1、各类变更的风险

| 变更 | 风险 | 推荐处理 |
|------|------|----------|
| 末尾加可空列 | 低 | 允许自动同步到下游 |
| 拓宽类型（`INT → BIGINT`、`VARCHAR(64) → VARCHAR(128)`） | 低 | 允许自动同步；湖表只支持安全拓宽 |
| 删列 | 中：下游报表引用该列会失败 | 下游先标记废弃，确认无引用后再删 |
| 改列名 | 高：按名字映射的链路数据丢失或错位 | 视为"加新列 + 迁移 + 删旧列"，走变更流程 |
| 收窄类型、改语义（金额从元改为分） | 高：静默写错 | 禁止直接改，新建列或新表 |
| 改主键 | 高：upsert 语义改变 | 重建下游表并全量重刷 |

### 2、各工具的能力

| 工具 | 表结构变更处理 |
|------|----------------|
| DataX | 不感知，列名写死在 JSON 里；新增列被忽略，删列会让作业报错 |
| SeaTunnel | CDC Source 开启 `schema-changes.enabled` 后，把 DDL 传给支持演进的 Sink |
| Debezium | 记录 schema 历史，变更后的消息携带新 Schema；能否落地取决于 Sink 与 Converter（Iceberg Sink 开启 `iceberg.tables.evolve-schema-enabled` 后自动加列） |
| Flink CDC 管道 | `schema.change.behavior` 控制 DDL 的应用策略（宽松、尝试演进、严格演进、忽略、报错），见 [Flink CDC](/flink/6_cdc) |
| Iceberg / Paimon | 支持加列、删列、改名、安全拓宽，均为元数据操作 |

### 3、流程比工具更重要

- **DDL 走变更单**：业务库的 DDL 必须经过评审，同步链路负责人是评审人之一；兼容性规则（只加列、只拓宽）写进开发规范
- **先下游、后上游**：需要下游配合的变更（如改类型），先改湖表 / OLAP 表结构，再执行上游 DDL
- **自动演进设白名单**：只对加列、拓宽开启自动同步，删列、改名、收窄统一转成告警，人工确认后处理
- **监控 Schema 差异**：每天比对源表与目标表的列定义，发现漂移及时告警

---

## 小结

- 数据集成分离线批量和实时增量两类：离线按 SQL 拉取，简单但感知不到硬删除；实时订阅 binlog，时效高、能拿到删除，但需要常驻运维。核心表走实时、离线全量兜底是常见组合
- DataX 是"Reader + Writer"的单机批同步框架，关键配置是 `splitPk`、左闭右开的 `where` 与 `writeMode: truncate`；社区已停滞，新平台优先 SeaTunnel
- SeaTunnel 的连接器与引擎解耦，可跑在 Zeta、Flink、Spark 上，原生支持多表、CDC、自动建表和 Schema 演进
- 实时入湖：多下游共享变更用 Debezium + Kafka Connect（Iceberg 官方 Sink），整库复制和流中加工用 Flink CDC
- 时间戳增量要防硬删除、长事务和不可靠的更新时间；全量与增量衔接的原则是增量起点早于全量快照，宁重叠不留缝
- 幂等靠分区覆盖、主键合并、带版本比较的 `MERGE`，重跑粒度要与覆盖粒度一致
- 对账按行数、指标汇总、分桶校验和逐层下钻，两端拼接口径必须逐字节一致，并作为调度 DAG 的阻断节点
- 表结构变更要分级处理：加列、拓宽可自动演进，删列、改名、收窄走变更流程
- 本篇只讲同步链路的设计与选型：同步任务的定时触发与依赖编排见 [任务调度](./6_scheduling) 与 [分布式任务调度](/distributed/6_job_scheduler)，数据质量规则的平台化见 [数据治理](./8_governance)

## 参考资料

- DataX：[DataX GitHub](https://github.com/alibaba/DataX)、[DataX 快速开始](https://github.com/alibaba/DataX/blob/master/userGuid.md)
- DataX 插件文档：[MysqlReader](https://github.com/alibaba/DataX/blob/master/mysqlreader/doc/mysqlreader.md)、[HdfsWriter](https://github.com/alibaba/DataX/blob/master/hdfswriter/doc/hdfswriter.md)
- SeaTunnel 配置与变量替换：[SeaTunnel Config File](https://seatunnel.apache.org/docs/3.0.0/introduction/concepts/config)、[Sink 参数占位符](https://seatunnel.apache.org/docs/3.0.0/introduction/configuration/sink-options-placeholders)、[Schema 演进](https://seatunnel.apache.org/docs/3.0.0/introduction/configuration/schema-evolution)
- SeaTunnel 连接器：[JDBC Source](https://seatunnel.apache.org/docs/3.0.0/connectors/source/Jdbc)、[MySQL-CDC Source](https://seatunnel.apache.org/docs/3.0.0/connectors/source/MySQL-CDC)、[Doris Sink](https://seatunnel.apache.org/docs/3.0.0/connectors/sink/Doris)、[Paimon Sink](https://seatunnel.apache.org/docs/3.0.0/connectors/sink/Paimon)
- SeaTunnel 引擎与命令：[Command Usage](https://seatunnel.apache.org/docs/3.0.0/engines/command/usage)、[Quick Start With Flink](https://seatunnel.apache.org/docs/3.0.0/getting-started/locally/quick-start-flink)、[Zeta 本地模式部署](https://seatunnel.apache.org/docs/3.0.0/engines/zeta/local-mode-deployment)
- SeaTunnel 版本发布：[SeaTunnel Releases](https://github.com/apache/seatunnel/releases)
- Iceberg Kafka Connect Sink：[Kafka Connect](https://iceberg.apache.org/docs/latest/kafka-connect/)
- Debezium：[Debezium MySQL Connector](https://debezium.io/documentation/reference/stable/connectors/mysql.html)、[New Record State Extraction](https://debezium.io/documentation/reference/stable/transformations/event-flattening.html)、[Debezium Releases](https://debezium.io/releases/)
- Kafka Connect 配置提供者：[Kafka Connect - Externalizing Secrets](https://kafka.apache.org/documentation/#connect_configproviders)
- Flink CDC：[Flink CDC Documentation](https://nightlies.apache.org/flink/flink-cdc-docs-stable/)、[Flink CDC 3.6.0 Release Announcement](https://flink.apache.org/2026/03/30/apache-flink-cdc-3.6.0-release-announcement/)
- Iceberg MERGE INTO：[Spark Writes](https://iceberg.apache.org/docs/latest/spark-writes/)

> 下一篇：[任务调度](./6_scheduling)

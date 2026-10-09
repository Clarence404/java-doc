---
description: 无锁增量快照、MySQL CDC 源、YAML 管道与 Schema 演进、Sink 选择、精确一次与常见坑
---

# Flink CDC

> **本篇目标**：搞清楚 Flink CDC 3.x 的两种用法（CDC 源连接器与 YAML 数据管道），理解无锁增量快照如何做到「全量 + 增量」无缝衔接，能正确配置 MySQL 源（binlog、server-id、分块），把整库同步到 Doris / StarRocks / Paimon / Kafka，并知道精确一次在哪一段成立、哪些坑最常见。
>
> **前置阅读**：[状态与容错](./4_state_checkpoint)、[Flink SQL 与 Table API](./5_sql)

CDC 的通用概念、binlog 原理以及 Canal / Debezium / Flink CDC 的横向选型见 [CDC 工具](/database/5_practice/0_cdc_tools)；本篇是「用 Flink 做 CDC」的主文档。

---

## 一、Flink CDC 3.x 是什么

### 1、从连接器到数据集成框架

Flink CDC 最早是一组 Flink Source 连接器（内嵌 Debezium 解析 binlog），3.x 起演进为**基于 Flink 的流式数据集成框架**，项目已捐赠给 Apache 软件基金会：

| 版本 | 变化 |
|------|------|
| 2.x | `com.ververica` 坐标，只有 Source 连接器 |
| 3.0 | 引入 YAML 数据管道、Schema 演进，仍是 `com.ververica` 坐标 |
| 3.1 起 | 进入 Apache，坐标改为 `org.apache.flink`，包名 `org.apache.flink.cdc.*` |
| 3.6（2026-03） | 当前最新版；同时为 Flink 1.20 与 2.2 发布构件（版本后缀 `-1.20` / `-2.2`），要求 JDK 11+ |

**Flink 版本要跟 CDC 构件对齐**：Flink 2.2 用 `3.6.0-2.2`，Flink 1.20 用 `3.6.0-1.20`；CDC 尚未针对 Flink 2.3 发布构件时，CDC 作业应停留在 2.2。

### 2、两种用法

- **CDC Source 连接器**：在 DataStream 或 SQL 里当普通 Source 用（`MySqlSource` / `'connector' = 'mysql-cdc'`），后面接任意 Flink 计算。适合「CDC + 实时计算」。
- **YAML 数据管道（Pipeline）**：写一份 YAML 描述 source、sink、路由、转换，`flink-cdc.sh` 提交成一个 Flink 作业，支持整库同步、分库分表合并、**自动建表与 Schema 演进**。适合「数据库 → 数仓 / 湖」的纯同步，不写代码。

经验法则：要做聚合、关联、窗口用 Source 连接器 + SQL；只是把业务库实时复制到 Doris / Paimon 就用 Pipeline——Source 连接器的 SQL 用法**不会**把上游 DDL 同步到下游，表结构一变作业就要改。

---

## 二、无锁增量快照

### 1、要解决的问题

「先全量后增量」最朴素的做法是：加全局读锁（`FLUSH TABLES WITH READ LOCK`）→ 记下 binlog 位点 → 全量 SELECT → 释放锁 → 从位点读 binlog。问题是读锁会阻塞业务写入，大表全量动辄数小时，且全量阶段无法并行、失败只能从头再来。

### 2、算法：按 chunk 切分 + 高低水位修正

![Flink CDC 无锁增量快照（单个 chunk）](../assets/flink/flink-cdc-incremental-snapshot.svg)

1. 按主键（或指定的 `chunk.key-column`）把表切成若干 chunk，默认每块 8096 行。
2. 每个 chunk 读之前记录 binlog 的 **LOW** 位点，SELECT 读出该范围的行，再记录 **HIGH** 位点。
3. 把 LOW 到 HIGH 之间属于这个 chunk 主键范围的 binlog 变更回放到刚读出的数据上，得到一份与 HIGH 时刻一致的快照，再输出。
4. 所有 chunk 完成后，由**单个** binlog reader 从各 chunk 的 HIGH 位点之后继续读增量，已被某个 chunk 修正过的变更不会重复输出。

收益：

- **不加锁**：全程不需要全局读锁，也不需要 `RELOAD` 权限。
- **并行**：多个 SnapshotSplit 并行读，全量速度随并行度扩展。
- **可续传**：checkpoint 以 chunk 为粒度，失败后从最后一个完成的 chunk 继续。
- **衔接无缝**：binlog reader 要等全部快照 chunk 完成**且随后一次 checkpoint 完成**之后才启动。

---

## 三、MySQL CDC 源

### 1、数据库侧准备

```sql
-- 专用账号，最小权限
CREATE USER 'flink_cdc'@'%' IDENTIFIED BY '******';
GRANT SELECT, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'flink_cdc'@'%';
FLUSH PRIVILEGES;
```

binlog 侧需要确认（MySQL 8.0 起这三项均为默认值，主要是检查是否被改过）：

- `log_bin` 开启、`binlog_format = ROW`、`binlog_row_image = FULL`：行格式且带完整前后镜像，否则拿不到完整的 `before` / `after`。
- binlog 保留时间（`binlog_expire_logs_seconds`）要**大于作业可能停机的最长时间**，否则从 checkpoint 恢复时位点已被清理，只能重做全量。
- 主从切换场景开启 GTID（`gtid_mode = ON`、`enforce_gtid_consistency = ON`），连接切到新主库后能按 GTID 找到续读位置。

binlog 格式与主从复制原理见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication)。

### 2、关键参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `server-id` | 5400–6400 随机 | CDC 以「伪从库」身份连接，**整个 MySQL 集群内唯一**；增量快照下配置区间（如 `5401-5404`），区间大小须大于源并行度 |
| `scan.incremental.snapshot.chunk.size` | 8096 | 每个 chunk 行数；越大单次 SELECT 越久、checkpoint 越慢，越小 chunk 越多、元数据越大 |
| `scan.incremental.snapshot.chunk.key-column` | 主键第一列 | 无主键表必须指定；用非主键列可能导致数据不一致 |
| `scan.startup.mode` | `initial` | `initial` 全量 + 增量；`latest-offset` / `earliest-offset` / `specific-offset` / `timestamp` 只读 binlog；`snapshot` 只做全量 |
| `heartbeat.interval` | 30s | 表长期无变更时推进 binlog 位点，避免恢复时位点过旧 |
| `connection.pool.size` | 20 | 快照阶段的 JDBC 连接池 |
| `debezium.*` | — | 透传给内嵌的 Debezium 引擎 |

### 3、SQL 用法

```sql
CREATE TABLE orders_cdc (
  id          BIGINT,
  user_id     BIGINT,
  amount      DECIMAL(18, 2),
  status      STRING,
  update_time TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector' = 'mysql-cdc',
  'hostname' = 'mysql',
  'port' = '3306',
  'username' = 'flink_cdc',
  'password' = '******',
  'database-name' = 'shop',
  'table-name' = 'orders',
  'server-id' = '5401-5404',
  'server-time-zone' = 'Asia/Shanghai'
);

-- CDC 表是带 -U/+U/-D 的更新流，聚合结果写 upsert 类 Sink
INSERT INTO user_order_stat
SELECT user_id, COUNT(*) AS cnt, SUM(amount) AS total
FROM orders_cdc
WHERE status = 'PAID'
GROUP BY user_id;
```

`server-time-zone` 要与数据库实际时区一致，否则 `TIMESTAMP` 列会整体偏移 8 小时。CDC 表的 changelog 语义见 [Flink SQL 与 Table API](./5_sql)。

### 4、DataStream 用法

```java
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.cdc.connectors.mysql.source.MySqlSource;
import org.apache.flink.cdc.connectors.mysql.table.StartupOptions;
import org.apache.flink.cdc.debezium.JsonDebeziumDeserializationSchema;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

public class OrdersCdcJob {
    public static void main(String[] args) throws Exception {
        MySqlSource<String> source = MySqlSource.<String>builder()
                .hostname("mysql")
                .port(3306)
                .databaseList("shop")
                .tableList("shop.orders", "shop.order_item")
                .username("flink_cdc")
                .password(System.getenv("CDC_PASSWORD"))
                .serverId("5401-5404")
                .serverTimeZone("Asia/Shanghai")
                .startupOptions(StartupOptions.initial())
                .deserializer(new JsonDebeziumDeserializationSchema())
                .build();

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.enableCheckpointing(60_000);   // 不开 checkpoint，增量阶段永远不会开始

        env.fromSource(source, WatermarkStrategy.noWatermarks(), "mysql-cdc")
           .setParallelism(4)              // 快照阶段 4 路并行，增量阶段只有 1 个 reader 工作
           .print();

        env.execute("orders-cdc");
    }
}
```

`JsonDebeziumDeserializationSchema` 输出 Debezium 格式 JSON（`before` / `after` / `op` / `source`），`op` 取值 `r`（快照读）、`c`、`u`、`d`。生产中通常实现自己的 `DebeziumDeserializationSchema`，直接转成业务对象，避免再解析一次 JSON。驱动 `mysql-connector-java` 因 GPL 许可不随连接器分发，需自行引入。

---

## 四、YAML 数据管道

### 1、整库同步到 Doris

![Flink CDC 3.x 数据管道](../assets/flink/flink-cdc-pipeline.svg)

```yaml
source:
  type: mysql
  hostname: mysql
  port: 3306
  username: flink_cdc
  password: ${CDC_PASSWORD}          # 由部署平台注入，勿写明文
  tables: shop.\.*, order_db_[0-9]+.order_[0-9]+
  server-id: 5401-5408
  scan.incremental.snapshot.chunk.size: 8096
  scan.binlog.newly-added-table.enabled: true

sink:
  type: doris
  fenodes: doris-fe:8030
  username: flink_writer
  password: ${DORIS_PASSWORD}
  table.create.properties.replication_num: 3

route:
  - source-table: order_db_[0-9]+.order_[0-9]+
    sink-table: ods.ods_order          # 分库分表合并到一张表
    description: merge sharded orders

transform:
  - source-table: shop.user
    projection: id, name, level, UPPER(city) AS city
    filter: deleted = 0

pipeline:
  name: shop-to-doris
  parallelism: 4
  schema.change.behavior: lenient
```

```bash
# 连接器 jar 放进 flink-cdc 的 lib 目录（或用 --jar 指定），FLINK_HOME 指向 Flink 安装目录
export FLINK_HOME=/opt/flink
./bin/flink-cdc.sh shop-to-doris.yaml
```

- `tables` 是正则，`.` 是库表分隔符，要匹配任意字符时写 `\.`。
- `route` 把多张分表路由到同一张下游表，是分库分表数据汇总的标准做法；`transform` 做投影、过滤、计算列，支持自定义 UDF。
- `${...}` 占位符示意由部署平台注入（如 Kubernetes Secret 渲染配置），不要把明文密码提交进仓库。
- checkpoint 间隔在 Flink 集群配置（`execution.checkpointing.interval`）中设置，CDC 管道同样依赖它推进增量与提交 Sink。

### 2、Schema 演进

上游执行 `ALTER TABLE` 时，管道中的 Schema 协调算子会**暂停数据流**，等下游应用完 DDL 再继续，保证 DDL 前后的数据不会以错误的结构写入。`pipeline.schema.change.behavior` 决定怎么应用：

| 取值 | 行为 |
|------|------|
| `lenient`（默认） | 转成不丢数据的安全形式：改列类型变成「保留旧列 + 新增新类型列」；不下发 `TRUNCATE` 与 `DROP TABLE` |
| `evolve` | 原样应用全部变更，失败则作业全局重启 |
| `try_evolve` | 尽量应用，不支持的变更容忍并转换后续数据，可能有精度损失 |
| `ignore` | 丢弃所有结构变更，未变化的列照常同步 |
| `exception` | 不允许任何结构变更，收到即报错 |

还可以在 sink 段用 `include.schema.changes` / `exclude.schema.changes` 按事件类型（`add.column`、`drop.column`、`alter.column.type`、`rename.column`、`truncate.table`、`drop.table` 等）细粒度控制，`exclude` 优先。生产上一般用默认的 `lenient`，并把 `drop.column` 排除掉——上游删列通常不希望下游数仓的历史数据跟着丢。

### 3、新增表

- `scan.binlog.newly-added-table.enabled`：增量阶段捕获匹配正则的新建表，只同步建表后的 DDL 与 DML，不做全量。
- `scan.newly-added-table.enabled`：对新加入 `tables` 范围的已有表补做全量快照，**只在从 savepoint / checkpoint 重启时生效**。修改 `tables` 正则后要走「停止并做 savepoint → 改配置 → 从 savepoint 启动」。

---

## 五、Sink 选择

| Sink | 写入方式 | 一致性 | 适用 |
|------|----------|--------|------|
| Doris | Stream Load 批量写，默认 10s 或 5 万行刷一次 | 按 Unique Key 模型 upsert，重放幂等 | 实时 OLAP、报表 |
| StarRocks | Stream Load，仅支持主键表 | 官方说明为至少一次 + 主键表幂等写，不支持精确一次 | 实时 OLAP |
| Paimon | 写入湖表，checkpoint 时提交快照 | 精确一次（提交与 checkpoint 绑定） | 实时数仓 ODS / DWD、湖仓一体 |
| Kafka | 默认 `debezium-json`，可选 `canal-json` | 取决于投递保证配置，下游按主键幂等消费 | 一份变更多方订阅 |

几个容易忽略的点：

- **Kafka Sink 默认把所有记录写到 0 号分区**（`partition.strategy = all-to-zero`），整库同步时必须改为 `hash-by-key`，否则单分区成为瓶颈；同一主键仍落在同一分区，保证行级有序。
- 默认 topic 名为 `库.表`，可用 `sink.tableId-to-topic.mapping` 或 `topic` 自定义。
- Doris / StarRocks 的自动建表只按上游主键生成分桶与主键，分区、副本、冷热策略需要用 `table.create.properties.*` 补充，或者提前手工建表。
- Paimon 主键表能直接产出 changelog 给下游 Flink 继续消费，是实时数仓分层的常用底座，见 [实战场景](./8_scenarios)。

---

## 六、精确一次

精确一次要拆成两段看：

1. **Source → Flink 状态**：CDC 源把已读到的 binlog 位点（以及快照阶段已完成的 chunk）存进 checkpoint，故障后从 checkpoint 恢复，变更事件**不丢不重地进入 Flink**——这一段由连接器保证。
2. **Flink → 外部系统**：取决于 Sink。Paimon 这类「checkpoint 时提交」的 Sink 和开启事务的 Kafka Sink 能做到端到端精确一次；Doris / StarRocks / JDBC 这类按主键 upsert 的 Sink，故障后会重放 checkpoint 之后的数据，但同一主键重复写入结果不变，**效果上等价于精确一次**。

因此 CDC 链路的落地原则是：**下游表一定要有主键，并按主键 upsert**。无主键的追加写（例如写成日志表）重放时会产生重复行。Kafka 事务的边界与消费端幂等见 [Kafka](/messaging/2_kafka) 与 [幂等设计](/architecture/5_idempotence)；Flink checkpoint 与两阶段提交的机制见 [状态与容错](./4_state_checkpoint)。

---

## 七、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 报 server_id 重复、连接被踢 | 多个作业或多个并行度用了同一个 `server-id`，或与真实从库冲突 | 每个作业分配独立区间，区间大小 ≥ 并行度，统一登记 |
| 恢复时报 binlog 不存在 | 作业停机时间超过 binlog 保留期，位点已被 purge | 延长 binlog 保留；已发生只能 `initial` 重新全量 |
| 一直停在全量阶段、增量不开始 | 没开 checkpoint，或 checkpoint 一直失败 | 开启 checkpoint；全量阶段适当调大 `execution.checkpointing.timeout` |
| 全量阶段 checkpoint 超时 | chunk 太大或下游写入慢导致反压 | 调小 chunk、提高 Sink 吞吐、按 [部署与运维](./7_deployment) 排查反压 |
| 时间字段差 8 小时 | `server-time-zone` 与数据库时区不一致 | 显式配置时区，下游统一用 `TIMESTAMP_LTZ` |
| 无主键表报错或数据错乱 | 无法切 chunk、无法 upsert | 指定 `chunk.key-column` 且该列唯一；下游设计业务主键 |
| 增量阶段只有一个 subtask 忙 | binlog 天然串行，增量只有 1 个 reader | 正常现象；吞吐不够时按库拆作业，或先同步到 Kafka 再分区并行处理 |
| 主库压力大 | 每个 CDC 作业都单独拉一份 binlog | 一个 Pipeline 作业覆盖多表，或「一份 CDC 写 Kafka、多方消费」 |
| 上游 DDL 后 SQL 作业报错或丢列 | Source 连接器的 SQL 用法不做 Schema 演进 | 纯同步改用 YAML Pipeline；SQL 作业变更表结构需走发布流程 |
| 从库读 binlog 时切主丢位点 | 未开启 GTID，新主库位点对不上 | 开启 GTID，连接配置指向 VIP 或代理 |

---

## 小结

- Flink CDC 3.x 是基于 Flink 的数据集成框架：Source 连接器用于「CDC + 计算」，YAML Pipeline 用于整库同步、分表合并与 Schema 演进；3.6 同时支持 Flink 1.20 与 2.2，构件以 `-1.20` / `-2.2` 后缀区分
- 无锁增量快照：按 chunk 并行读全量，用 LOW / HIGH 位点之间的 binlog 修正每个 chunk，之后单 reader 续读 binlog；不加读锁、可断点续传
- MySQL 侧准备：最小权限账号、ROW + FULL 镜像、足够的 binlog 保留期、GTID；`server-id` 区间全集群唯一且大于并行度
- 必须开 checkpoint：它既是增量阶段开始的前提，也是 Sink 提交和故障恢复的依据
- Schema 演进默认 `lenient`，不丢数据；`drop.column` 通常排除；新增表要区分「只同步增量」与「补全量」两种开关
- Sink：Paimon 精确一次，Doris / StarRocks 靠主键 upsert 幂等；Kafka Sink 默认全写 0 号分区，必须改为 `hash-by-key`
- 下游一定要有主键并按主键 upsert，这是 CDC 链路「效果上精确一次」的前提

## 参考资料

- Flink CDC 文档（3.6）：[https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/](https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/)
- MySQL CDC 源连接器：[https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/connectors/flink-sources/mysql-cdc/](https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/connectors/flink-sources/mysql-cdc/)
- 数据管道定义：[https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/core-concept/data-pipeline/](https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/core-concept/data-pipeline/)
- Schema 演进：[https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/core-concept/schema-evolution/](https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/core-concept/schema-evolution/)
- GitHub Releases：[https://github.com/apache/flink-cdc/releases](https://github.com/apache/flink-cdc/releases)

> 下一篇：[部署与运维](./7_deployment) —— 把作业跑上 Kubernetes，算清内存、并行度与 slot，排查反压、checkpoint 失败和数据倾斜。

---
description: 动态表与 changelog、连接器 DDL、窗口 TVF、四种 Join、Top-N 与去重、状态 TTL
---

# Flink SQL 与 Table API

> 前置阅读：[时间、水位线与窗口](./3_time_window)、[状态与容错](./4_state_checkpoint)

Flink SQL 把流看作不断变化的动态表，本篇讲 changelog 的四种行类型、Kafka / upsert-kafka / JDBC 连接器 DDL、事件时间与水位线声明、窗口聚合、各类 Join、Top-N 与去重，以及如何估算并用 TTL 控制状态。示例以 **Flink 2.2 + 对应连接器** 为准（见 [Flink 概览](./1_basics)），SQL 语法在 2.3 上同样适用。

---

## 一、动态表与 changelog

### 1、流就是一张不断变化的表

Flink SQL 不是「在流上跑批处理 SQL」，而是**连续查询**：输入流被看作一张只追加或不断更新的**动态表**，SQL 在它上面持续执行，结果也是一张动态表，再以 changelog 的形式写给下游。

![流、动态表与 changelog](../assets/flink/flink-dynamic-table.svg)

结果表的每次变化用一行带 `RowKind` 的记录表达：

| RowKind | 含义 | 出现场景 |
|---------|------|----------|
| `+I` INSERT | 新增一行 | 所有查询 |
| `-U` UPDATE_BEFORE | 撤回旧值 | 非窗口聚合、Regular Join、Top-N |
| `+U` UPDATE_AFTER | 写入新值 | 同上 |
| `-D` DELETE | 删除一行 | CDC 源、Top-N 挤出、外连接补 null 撤回 |

### 2、三种流的形态

- **Append 流**：只有 `+I`。过滤、投影、窗口聚合（窗口关闭后结果不再变）、Interval Join 都属于这一类，可以写进任何 Sink，包括只支持追加的 Kafka。
- **Retract 流**：更新拆成 `-U` + `+U`。下游必须能「撤回」，例如另一层聚合会先减掉旧值再加新值。
- **Upsert 流**：有主键时只发 `+I` / `+U` / `-D`，省掉 `-U`，下游按主键覆盖写即可。upsert-kafka、JDBC（带主键）、Doris / Paimon 主键表都走这种模式。

**判断方法**：`EXPLAIN CHANGELOG_MODE SELECT ...` 会在执行计划里给每个算子标出 `changelogMode=[I,UB,UA,D]`。一条 SQL 写不进 Kafka 报 `doesn't support consuming update changes`，就是因为结果是更新流而 Sink 只支持追加——要么换 upsert-kafka，要么改写成窗口聚合。

### 3、为什么 Sink 前会出现 SinkUpsertMaterializer

当上游的 changelog 在 shuffle 后可能乱序、而 Sink 的主键与上游推导出的唯一键不一致时，规划器会在 Sink 前插入 `SinkUpsertMaterializer`，在状态里保存每个主键的历史行来纠正顺序。它的状态可能很大，由 `table.exec.sink.upsert-materialize`（默认 `AUTO`）控制。常见做法是让 Sink 主键与 `GROUP BY` 键保持一致，从根上避免它被插入。注意 Flink 2.3 的行为变化（FLIP-558）：upsert 键与 Sink 主键不一致时，查询默认在规划阶段直接报错，需要在 `INSERT` 上用新增的 `ON CONFLICT` 子句显式选择 `DO NOTHING` / `DO ERROR` / `DO DEDUPLICATE`（后者对应以前的行为）；本文基线 2.2 仍是自动插入。

---

## 二、DDL 与连接器

### 1、Kafka 源表：时间属性与水位线

```sql
CREATE TABLE order_paid (
  order_id   BIGINT,
  user_id    BIGINT,
  amount     DECIMAL(18, 2),
  pay_time   TIMESTAMP_LTZ(3),
  -- Kafka 消息自带的时间戳，VIRTUAL 表示只读、不写回
  kafka_ts   TIMESTAMP_LTZ(3) METADATA FROM 'timestamp' VIRTUAL,
  -- 处理时间属性，Lookup Join 需要
  proc_time  AS PROCTIME(),
  -- 事件时间属性：允许 5 秒乱序
  WATERMARK FOR pay_time AS pay_time - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'order_paid',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-gmv',
  'scan.startup.mode' = 'group-offsets',
  'properties.auto.offset.reset' = 'earliest',
  'format' = 'json',
  'json.ignore-parse-errors' = 'true'
);
```

要点：

- 声明了 `WATERMARK FOR` 的列才是**事件时间属性**，窗口 TVF、Interval Join、Temporal Join 只认它；普通 `TIMESTAMP` 列不行。
- 时区敏感的业务（按自然日汇总）用 `TIMESTAMP_LTZ` 并设置 `table.local-time-zone = 'Asia/Shanghai'`，否则「当天」的边界会差 8 小时。
- 某些 Kafka 分区长期没数据时，该分区的水位线不前进，整个作业的水位线被拖住、窗口迟迟不触发。设置 `table.exec.source.idle-timeout`（默认 0，即不判定空闲）让空闲分区不参与水位线计算。水位线原理见 [时间、水位线与窗口](./3_time_window)。
- `json.ignore-parse-errors` 会把脏数据变成 null 后静默跳过，上线前确认这是期望的行为；更稳妥的做法是在 DataStream 层把解析失败的消息送到死信主题。

### 2、upsert-kafka：把更新流写进 Kafka

```sql
CREATE TABLE user_gmv (
  user_id  BIGINT,
  gmv      DECIMAL(18, 2),
  PRIMARY KEY (user_id) NOT ENFORCED
) WITH (
  'connector' = 'upsert-kafka',
  'topic' = 'user_gmv',
  'properties.bootstrap.servers' = 'kafka:9092',
  'key.format' = 'json',
  'value.format' = 'json',
  'sink.buffer-flush.max-rows' = '1000',
  'sink.buffer-flush.interval' = '1s'
);
```

- 主键必填，主键列写入消息 key，同一 key 的更新落在同一分区，保证分区内有序；`-D` 写成 value 为 null 的墓碑消息，配合 `cleanup.policy=compact` 主题天然就是一张「最新值表」。
- 两个 buffer-flush 参数都大于 0 才生效，缓冲期间同 key 只保留最后一条，能显著降低写放大。
- 作为**源表**时，upsert-kafka 读出来是 upsert 流，规划器会自动加一个 `ChangelogNormalize` 算子把它补成完整 changelog——这个算子要按主键缓存全部最新值，是隐藏的状态大户。
- Kafka 本身的分区、副本、事务等机制见 [Kafka](/messaging/2_kafka)。

### 3、JDBC：结果表与维表

```sql
CREATE TABLE dim_user (
  id        BIGINT,
  level     STRING,
  city      STRING,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector' = 'jdbc',
  'url' = 'jdbc:mysql://mysql:3306/crm',
  'table-name' = 'user',
  'username' = 'flink_ro',
  'password' = '******',
  'lookup.cache' = 'PARTIAL',
  'lookup.partial-cache.max-rows' = '100000',
  'lookup.partial-cache.expire-after-write' = '10 min',
  'lookup.max-retries' = '3'
);
```

- 声明了主键的 JDBC Sink 走 upsert 写法（MySQL 生成 `INSERT ... ON DUPLICATE KEY UPDATE`），天然幂等；不声明主键则只能追加。批量参数 `sink.buffer-flush.max-rows` 默认 100、`sink.buffer-flush.interval` 默认 1s。
- 做维表时打开 `PARTIAL` 缓存，`cache-missing-key` 默认 true，查不到的 key 也会缓存空值，防止大量不存在的 key 打穿数据库；代价是新插入的维度数据要等缓存过期才可见。
- 依赖：JDBC 连接器 4.x 起拆成 `flink-connector-jdbc-core` 加方言模块（如 `flink-connector-jdbc-mysql`），MySQL 驱动需自行引入。
- 密码不要写死在 SQL 文件里，用 Catalog 或部署平台的密钥注入。

---

## 三、窗口 TVF

窗口表值函数（Windowing TVF）是窗口计算的标准写法，官方定位为旧版 `GROUP BY TUMBLE(...)` 分组窗口函数的替代：后者只能做聚合，TVF 还能接 Window Top-N、Window Join、Window 去重。TVF 给每行追加 `window_start`、`window_end`、`window_time` 三列。

| TVF | 语法 | 典型用途 |
|-----|------|----------|
| `TUMBLE` | `TUMBLE(TABLE t, DESCRIPTOR(ts), size [, offset])` | 每分钟 PV、每小时订单数 |
| `HOP` | `HOP(TABLE t, DESCRIPTOR(ts), slide, size [, offset])` | 最近 10 分钟、每 1 分钟刷新一次 |
| `CUMULATE` | `CUMULATE(TABLE t, DESCRIPTOR(ts), step, size)` | 当天累计 GMV、每分钟出一次（size 须为 step 整数倍） |
| `SESSION` | `SESSION(TABLE t PARTITION BY k, DESCRIPTOR(ts), gap)` | 用户会话，仅流模式 |

```sql
-- 当天累计 GMV，每分钟输出一次；结果只追加，可直接写 Kafka
SELECT window_start, window_end,
       SUM(amount)              AS gmv,
       COUNT(DISTINCT user_id)  AS buyers
FROM CUMULATE(TABLE order_paid, DESCRIPTOR(pay_time), INTERVAL '1' MINUTE, INTERVAL '1' DAY)
GROUP BY window_start, window_end;
```

**为什么优先用窗口而不是 `GROUP BY DATE_FORMAT(...)`**：后者是无界聚合，每来一条都发一次 `-U/+U`，状态永不过期（除非配 TTL）；窗口聚合在水位线越过窗口后一次性输出并清理状态，结果是 append 流，下游简单得多。代价是延迟——结果要等水位线推进才出来，`CUMULATE` 正好在「实时性」和「只追加」之间取了折中。

窗口聚合可以叠加 mini-batch 与两阶段聚合优化（见第六节），`COUNT(DISTINCT)` 在大窗口上尤其需要。

---

## 四、Join 与状态

Join 是 Flink SQL 里最容易「把状态撑爆」的地方。四种 Join 的状态占用差异巨大：

![Flink SQL 四种 Join 的状态占用](../assets/flink/flink-sql-join-state.svg)

### 1、Regular Join

```sql
SELECT o.order_id, o.amount, p.pay_time
FROM orders o
JOIN payments p ON o.order_id = p.order_id;
```

两侧所有历史数据都进状态，任意一侧来新数据都去另一侧状态里找匹配，语义最完整，但**状态无界**。只支持等值条件；任一侧是更新流时输出也是更新流。外连接在对侧数据到来前先输出补 null 的行，之后再撤回，下游会看到 `-D` / `+I` 抖动。

必须控制状态：全局 `table.exec.state.ttl`（默认 0，永不过期），或用 `STATE_TTL` 提示给两侧设不同 TTL（下文）。

### 2、Interval Join

```sql
SELECT o.order_id, s.ship_time
FROM orders o, shipments s
WHERE o.order_id = s.order_id
  AND s.ship_time BETWEEN o.order_time AND o.order_time + INTERVAL '4' HOUR;
```

要求两侧都是**只追加**且带时间属性，水位线越过区间上界后的数据可以安全清理，因此状态有界、输出只追加。适合「下单后 N 小时内支付 / 发货」这类有天然时间约束的关联。

### 3、Temporal Join（版本表关联）

```sql
SELECT o.order_id, o.amount * r.rate AS amount_cny
FROM orders o
LEFT JOIN currency_rates FOR SYSTEM_TIME AS OF o.order_time AS r
  ON o.currency = r.currency;
```

右表必须是**版本表**：有主键、有事件时间与水位线（例如 CDC 表或 upsert-kafka 表）。每条订单关联「订单发生时刻」那个版本的汇率，结果是确定的、可重放的。状态里只保留右表每个主键的必要版本，水位线推进时清理旧版本；左表数据要等右表水位线追上才能输出，右表长期无更新时同样需要 idle-timeout。

### 4、Lookup Join（维表查询）

```sql
SELECT /*+ LOOKUP('table'='u', 'async'='true', 'output-mode'='allow_unordered',
                  'capacity'='200', 'timeout'='5s') */
       o.order_id, o.amount, u.level, u.city
FROM order_paid AS o
JOIN dim_user FOR SYSTEM_TIME AS OF o.proc_time AS u
  ON o.user_id = u.id;
```

用**处理时间**逐条查外部库，Flink 侧几乎无状态，维表多大都行；代价是结果不可重放（同一条订单重跑可能关联到新的维度值），以及外部库要扛住 QPS。三板斧：`PARTIAL` 缓存、异步查询（`allow_unordered` 吞吐更高但打乱顺序）、`LOOKUP` 提示里的 `retry-predicate='lookup_miss'` 处理「维度数据比事实数据晚到」。

### 5、选型

| 场景 | 推荐 |
|------|------|
| 维表大、更新不频繁、能接受处理时间语义 | Lookup Join + 缓存 |
| 需要严格按事件时间关联、结果可重放（汇率、价格） | Temporal Join |
| 两条事实流且有时间窗口约束 | Interval Join |
| 两条流需要全量互相关联且无时间约束 | Regular Join + TTL，或换成 Paimon 等存储侧关联 |

Flink 2.1 引入、2.2 继续增强的 Delta Join（FLIP-486）思路是把双流 Regular Join 改为「到对侧源表存储里按键双向查询」，从而去掉 Join 两侧的大状态，优化器开关是 `table.optimizer.delta-join.strategy`（默认 `AUTO`，能转换就转换，否则退回 Regular Join）；它要求源表存储支持按键索引查询（如 Apache Fluss），适用条件较窄，落地前以官方文档的限制说明为准。更多维表策略见 [实战场景](./8_scenarios)。

---

## 五、Top-N 与去重

### 1、Top-N

```sql
-- 每个类目销量前 3 的商品
SELECT category, item_id, sales
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY category ORDER BY sales DESC) AS rn
  FROM item_sales
)
WHERE rn <= 3;
```

- 必须严格按这个模式写（`ROW_NUMBER()` + 外层 `rn <= N`），否则优化器认不出来；目前只支持 `ROW_NUMBER`。
- 结果是更新流：排名变化时第 3 名被挤出要发 `-D`，Sink 需要支持更新，且主键为 `(category, rn)`。
- **无排名输出优化**：外层 SELECT 不输出 `rn`，则只有进出榜的记录会下发，主键变为 `(category, item_id)`，写放大大幅降低，由前端自己排序。
- 输入如果是更新流（例如 `item_sales` 本身是聚合结果），Top-N 算子要保存每个分区的全部数据，状态远大于只追加输入；能用窗口 Top-N 就别用全局 Top-N。

### 2、去重

```sql
-- 按订单号去重，保留第一条（ASC），结果只追加
SELECT order_id, user_id, amount, pay_time
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY proc_time ASC) AS rn
  FROM order_paid
)
WHERE rn = 1;
```

去重是 N=1 的 Top-N，`ORDER BY` 必须是时间属性：

- **保留第一条**（按处理时间 `ASC`）：输出只追加，状态只记录「这个 key 见过没有」，最省。
- **保留最后一条**（`DESC`）：每来一条都要撤回旧值，输出是更新流。

上游不是端到端精确一次时（例如 at-least-once 的 Kafka 生产者重试），先去重再聚合，防止重复消息污染 SUM / COUNT。去重状态同样需要 TTL，TTL 取「重复消息可能出现的最大时间间隔」。

---

## 六、状态 TTL 与调优参数

### 1、三个粒度的 TTL

```sql
-- 作业级：所有有状态算子空闲 1 天后清理
SET 'table.exec.state.ttl' = '1 d';

-- 查询级：STATE_TTL 提示，按表（或别名）给不同 TTL
SELECT /*+ STATE_TTL('o' = '1d', 'p' = '2h') */ o.order_id, p.pay_time
FROM orders o JOIN payments p ON o.order_id = p.order_id;
```

- `table.exec.state.ttl` 是「**空闲**多久后清理」：一个 key 的状态在 TTL 内被访问过就续期。默认 0 表示永不清理——这是无界聚合、Regular Join 上线后状态无限增长的头号原因。
- `STATE_TTL` 提示适用于 Regular Join 和分组聚合，表有别名时必须用别名。典型用法：订单表留 1 天，支付表留 2 小时。
- 更细的算子级 TTL 可以通过 `COMPILE PLAN` 导出 JSON 执行计划、修改其中的 `ttl` 字段后再 `EXECUTE PLAN`。

**TTL 是正确性换资源**：状态被清理后，同一个 key 再来数据会被当作新 key——聚合从 0 重新开始、Join 匹配不到旧数据。TTL 要按业务最大间隔设，并在监控中关注状态大小，而不是越小越好。

### 2、聚合调优

```sql
SET 'table.exec.mini-batch.enabled' = 'true';
SET 'table.exec.mini-batch.allow-latency' = '2 s';
SET 'table.exec.mini-batch.size' = '5000';
SET 'table.optimizer.agg-phase-strategy' = 'TWO_PHASE';
SET 'table.optimizer.distinct-agg.split.enabled' = 'true';
```

- **mini-batch**（默认关闭）：攒一小批再访问状态，同 key 的多次更新合并为一次，RocksDB / ForSt 状态后端下收益明显，代价是秒级延迟。
- **两阶段聚合**：先在上游本地预聚合再 shuffle，解决 `GROUP BY` 热点 key 倾斜；需要 mini-batch 开启才生效。
- **distinct 拆分**：把 `COUNT(DISTINCT user_id)` 拆成「按 `user_id` 分桶先去重、再汇总」两层，解决 distinct 热点。

数据倾斜的整体处理思路见 [部署与运维](./7_deployment)。

---

## 七、SQL Gateway、SQL Client 与 Table / DataStream 混用

### 1、提交 SQL 的方式

- **SQL Client**：`./bin/sql-client.sh`，开发调试与一次性任务最方便；`-f job.sql` 可直接执行脚本。
- **SQL Gateway**：`./bin/sql-gateway.sh start -Dsql-gateway.endpoint.rest.address=localhost`，默认 REST 端口 8083，另有 HiveServer2 端点。平台化场景（自研实时计算平台、BI 工具、JDBC 驱动接入）通过它提交 SQL、管理会话。Flink 2.0 移除了 per-job 模式，Gateway 支持以 Application 模式提交作业。
- **嵌入 Java 程序**：用 `TableEnvironment` 执行 SQL 字符串，打成 jar 按普通作业部署，最适合需要和 DataStream 混用的场景。

生产 SQL 作业务必给每条 `INSERT` 配合 `SET 'pipeline.name' = '...'`，并在升级前评估执行计划是否变化——SQL 改动后算子 uid 可能变化，导致从 savepoint 恢复失败，详见 [部署与运维](./7_deployment)。

### 2、Table 与 DataStream 互转

需要 SQL 表达不了的逻辑（复杂状态机、CEP、自定义侧输出）时，在同一个作业里两种 API 混用：

```java
import java.math.BigDecimal;
import java.time.Instant;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

public class SqlOnStreamJob {

    /** Flink POJO：public 无参构造 + public 字段 */
    public static class OrderEvent {
        public long orderId;
        public long userId;
        public BigDecimal amount;
        public Instant payTime;
        public OrderEvent() {}
    }

    public static void run(StreamExecutionEnvironment env, DataStream<OrderEvent> orders) throws Exception {
        StreamTableEnvironment tEnv = StreamTableEnvironment.create(env);

        // DataStream -> Table：沿用 DataStream 上已分配的时间戳与水位线
        Table orderTable = tEnv.fromDataStream(orders, Schema.newBuilder()
                .columnByMetadata("rowtime", "TIMESTAMP_LTZ(3)")
                .watermark("rowtime", "SOURCE_WATERMARK()")
                .build());
        tEnv.createTemporaryView("orders", orderTable);

        Table perUser = tEnv.sqlQuery(
                "SELECT userId, SUM(amount) AS total FROM orders GROUP BY userId");

        // 结果是更新流，必须用 toChangelogStream；toDataStream 只接受只追加的表
        DataStream<Row> changelog = tEnv.toChangelogStream(perUser);
        changelog.filter(r -> r.getKind() != RowKind.UPDATE_BEFORE)
                 .print();

        env.execute("sql-on-stream");
    }
}
```

- `fromDataStream` 不会自动带上事件时间，要像上面这样用 `SOURCE_WATERMARK()` 声明，否则下游窗口 TVF 找不到时间属性。
- `toDataStream` 用于只追加的结果，`toChangelogStream` 用于更新流，每行通过 `Row.getKind()` 拿到 `RowKind`。
- 在 SQL 里配置的 `table.exec.*` 参数通过 `tEnv.getConfig().set(...)` 设置，作用于该 `TableEnvironment` 产生的所有算子。

---

## 小结

- Flink SQL 是动态表上的连续查询，结果以 `+I / -U / +U / -D` 的 changelog 输出；Sink 能否接住更新流决定了 SQL 怎么写，用 `EXPLAIN CHANGELOG_MODE` 检查
- 事件时间只认 DDL 里声明了 `WATERMARK FOR` 的列；空闲分区用 `table.exec.source.idle-timeout` 防止水位线停滞，按自然日计算注意 `TIMESTAMP_LTZ` 与本地时区
- upsert-kafka 写更新流、读出来会多一个 `ChangelogNormalize` 状态算子；JDBC 有主键即 upsert 写，做维表时开 `PARTIAL` 缓存
- 窗口 TVF（TUMBLE / HOP / CUMULATE / SESSION）输出只追加且状态可清理，优先于无界 `GROUP BY`
- Join 状态：Regular 无界、Interval 按区间清理、Temporal 保存维表版本、Lookup 几乎无状态但结果不可重放
- Top-N 与去重必须按固定模式写；保留第一条的去重最省，无排名输出优化能大幅减少写放大
- `table.exec.state.ttl` 默认 0 即永不清理，配合 `STATE_TTL` 提示按表设置；TTL 是用正确性换资源
- mini-batch、两阶段聚合、distinct 拆分是聚合倾斜的三件套；需要复杂逻辑时用 `toChangelogStream` 与 DataStream 混用

## 参考资料

- Flink SQL 参考（2.2）：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/overview/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/overview/)
- 窗口 TVF：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/window-tvf/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/window-tvf/)
- Join：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/joins/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/joins/)
- SQL Hints：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/hints/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/hints/)
- Table 配置项：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/config/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/config/)
- Upsert Kafka 连接器：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/table/upsert-kafka/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/table/upsert-kafka/)

> 下一篇：[Flink CDC](./6_cdc) —— 不锁表地全量 + 增量同步数据库，再用一份 YAML 把整库实时搬进 Doris、Paimon 或 Kafka。

---
description: 埋点规范与采集网关、Flink SQL 写 Paimon 分层、StarRocks 物化视图、查询服务、延迟监控、回放补数与故障恢复
---

# 实时数仓实战

> 前置阅读：[数据湖与湖仓](./4_lakehouse)、[Flink SQL 与 Table API](/flink/5_sql)、[OLAP 查询与数据服务](./7_olap_service)

本篇把前面的分层建模、湖仓表格式、调度、OLAP 与治理串成一条能上线的分钟级实时数仓链路：App 埋点经采集网关进入 Kafka，Flink SQL 逐层写入 Paimon 的 ODS / DWD / DWS，StarRocks 用外部 Catalog 和异步物化视图提供 ADS，Spring Boot 查询服务对外输出。内容覆盖每层的延迟监控与回放、补数、故障恢复，版本基线为 Flink 2.2（`flink-sql-connector-kafka-5.0.0-2.2.jar`，Kafka 连接器尚未适配 2.3）、Paimon 2.0（2026 年 8 月发布，`paimon-flink-2.2-2.0.0.jar`）、StarRocks 4.1、Spring Boot 4、JDK 21（查询服务与网关）。

---

## 一、需求与架构

### 1、需求

运营要一块大促实时大屏和一个商品实时排行接口：

- **大屏**：今日按分钟的浏览量、加购次数、支付件数、支付金额曲线
- **商品排行**：今日按支付金额排序的商品 Top N，附带浏览和加购数
- **时效**：分钟级，数据延迟超过 10 分钟要告警
- **可修复**：埋点解析逻辑或汇总口径出错时，能重算指定日期的数据

### 2、架构

![实时数仓链路](../assets/big-data/realtime-dw-architecture.svg)

| 层 | 表 / 组件 | 存储与引擎 | 产出方式 |
|----|-----------|------------|----------|
| 采集 | 埋点 SDK、采集网关 | Spring Boot 4 | 客户端批量上报，网关校验后写 Kafka |
| 消息 | `app_event` 主题 | Kafka | 按 `device_id` 分区，保留 7 天用于重放 |
| ODS | `ods_app_event_inc` | Paimon 追加表 | Flink SQL 作业 1：Kafka 原样落地 |
| DWD | `dwd_traffic_app_event_inc` | Paimon 主键表（`first-row`） | Flink SQL 作业 2：清洗、按 `event_id` 去重 |
| DWS | `dws_trade_site_event_1min`、`dws_trade_sku_event_1d` | Paimon 主键表（`aggregation`） | Flink SQL 作业 3：写入即预聚合 |
| ADS | `ads_trade_realtime_overview`、`ads_trade_sku_rank` | StarRocks 异步物化视图 | 每分钟从 Paimon 外部 Catalog 刷新 |
| 服务 | 实时指标查询服务 | Spring Boot 4 + JdbcClient | 查询 ADS，附带数据新鲜度 |

三个设计取舍：

- **每层一个 Flink 作业**：分开部署便于单独升级、单独回刷，代价是端到端延迟是各层提交间隔之和
- **去重和聚合下推给 Paimon**：DWD 用 `first-row` 合并引擎按主键保留第一条，DWS 用 `aggregation` 合并引擎在写入时累加，Flink 作业里没有 `GROUP BY` 和去重算子，几乎不持有状态，升级和恢复都很轻
- **ADS 放在 StarRocks**：StarRocks 的 Flink 连接器（截至 1.2.16）只支持到 Flink 1.20，Flink 2.2 作业无法直接写入；改由 StarRocks 通过外部 Catalog 读 Paimon，再用异步物化视图把结果物化到本地，查询性能与内表一致

Kafka 分层与 Paimon 分层的取舍见 [Flink 实战场景](/flink/8_scenarios) 第三节和 [数据湖与湖仓](./4_lakehouse) 第八节，本篇直接采用 Paimon 分层。

### 3、延迟预算

Paimon 在 Flink checkpoint 完成时提交快照，数据此后才对下游可见，所以每一层的延迟主要由 checkpoint 间隔决定：

| 环节 | 延迟来源 | 典型值 |
|------|----------|--------|
| 客户端 → Kafka | SDK 攒批上报间隔 | 10–30 秒 |
| Kafka → ODS | checkpoint 间隔 | ≤ 1 分钟 |
| ODS → DWD | 流读发现间隔（`continuous.discovery-interval` 默认 10 秒）+ checkpoint | ≤ 1 分钟多 |
| DWD → DWS | 同上 | ≤ 1 分钟多 |
| DWS → ADS | 物化视图刷新间隔 + 刷新耗时 | 1–2 分钟 |
| 合计 | — | 约 3–5 分钟 |

如果大屏必须做到秒级，就不要让它走湖仓分层：用 Flink 直接从 Kafka 聚合写入 OLAP（见 [Flink 实战场景](/flink/8_scenarios) 第一节的实时 GMV 大屏），或用 StarRocks Routine Load 直接订阅 Kafka，湖仓链路只承担明细沉淀和分钟级指标。

### 4、埋点规范

下游清洗成本的大头来自埋点不规范。所有事件统一一个结构，事件名和属性在埋点平台登记，未登记的事件网关直接丢弃并计数：

| 字段 | 类型 | 说明 |
|------|------|------|
| `event_id` | STRING | 客户端生成的 UUID，重试上报时保持不变，用于去重 |
| `event_type` | STRING | 客户端：`page_view`、`add_cart`；服务端：`order_paid` |
| `user_id` | BIGINT | 登录用户 ID，未登录为空 |
| `device_id` | STRING | 设备标识，未登录用户靠它串联行为 |
| `sku_id` | BIGINT | 商品 ID |
| `order_id` | BIGINT | 订单 ID，仅 `order_paid` |
| `quantity` | INT | 件数，`add_cart` 与 `order_paid` |
| `amount` | DECIMAL(18, 2) | 支付金额（元），仅 `order_paid` |
| `platform` / `app_version` | STRING | 公共属性 |
| `client_ts` | BIGINT | 客户端事件时间（毫秒） |
| `server_ts` | BIGINT | 网关或服务端接收时间（毫秒），由服务端填写 |

两条约定：

- **交易事件以服务端为准**：`order_paid` 由订单服务在支付成功后发出，按订单明细行一行一个事件（`event_id` 取 `订单号-商品号`），客户端不上报支付事件。客户端埋点会因为杀进程、断网而丢失，只适合流量类指标；订单数、GMV 的正式口径来自业务库 CDC 链路（见 [Flink CDC](/flink/6_cdc)），这里的支付金额只用于大屏趋势
- **分区和统计用 `server_ts`**：手机时钟可能被用户调乱，`client_ts` 只作为属性保留；所有分区、分钟归属都按 `server_ts` 计算

### 5、采集网关

网关做三件事：校验、补 `server_ts`、写 Kafka。Kafka 主题先建好，保留 7 天：

```bash
kafka-topics.sh --bootstrap-server kafka:9092 --create --topic app_event \
  --partitions 12 --replication-factor 3 --config retention.ms=604800000
```

网关依赖 `spring-boot-starter-webmvc` 和 `spring-boot-starter-kafka`，配置 `spring.kafka.bootstrap-servers` 指向集群，并设置 `spring.jackson.property-naming-strategy: SNAKE_CASE`，让 JSON 字段与 Flink 表字段一致（都是下划线命名）：

```java
public record TrackEvent(String eventId, String eventType, Long userId, String deviceId,
                         Long skuId, Long orderId, Integer quantity, BigDecimal amount,
                         String platform, String appVersion, Long clientTs, Long serverTs) {

    TrackEvent withServerTs(long ts) {
        return new TrackEvent(eventId, eventType, userId, deviceId, skuId, orderId, quantity,
                amount, platform, appVersion, clientTs, ts);
    }
}

@RestController
@RequestMapping("/track")
public class TrackController {

    private static final Set<String> CLIENT_EVENTS = Set.of("page_view", "add_cart");

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final JsonMapper jsonMapper;          // Jackson 3：tools.jackson.databind.json.JsonMapper
    private final Counter rejected;

    public TrackController(KafkaTemplate<String, String> kafkaTemplate, JsonMapper jsonMapper,
                           MeterRegistry registry) {
        this.kafkaTemplate = kafkaTemplate;
        this.jsonMapper = jsonMapper;
        this.rejected = registry.counter("track.events.rejected");
    }

    @PostMapping
    public ResponseEntity<Void> collect(@RequestBody List<TrackEvent> events) {
        if (events.size() > 100) {
            return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).build();
        }
        long serverTs = System.currentTimeMillis();
        for (TrackEvent e : events) {
            if (e.eventId() == null || e.deviceId() == null || !CLIENT_EVENTS.contains(e.eventType())) {
                rejected.increment();
                continue;
            }
            kafkaTemplate.send("app_event", e.deviceId(), jsonMapper.writeValueAsString(e.withServerTs(serverTs)));
        }
        return ResponseEntity.accepted().build();
    }
}
```

要点：以 `device_id` 作为消息 key，同一设备的事件落在同一分区、保持顺序；被拒绝的事件计入 `track.events.rejected` 指标，突增说明有新版本 App 埋点不合规。网关本身是无状态服务，水平扩容即可，接入层的限流与扩容见 [高并发总览](/high-con/0_overview)。

---

## 二、Kafka 到 ODS

Flink 集群的 `lib/` 目录放入 `flink-sql-connector-kafka-5.0.0-2.2.jar`、`paimon-flink-2.2-2.0.0.jar` 和访问 S3 所需的 `paimon-s3-2.0.0.jar`。下面三个作业都是 SQL 脚本，用 `sql-client.sh -f <脚本>` 提交，或通过 SQL Gateway 提交（见 [Flink SQL 与 Table API](/flink/5_sql) 第七节）。S3 凭证通过节点 IAM 角色或 Catalog 的 `s3.*` 选项提供，不写进脚本。

作业 1：`ods_app_event_inc.sql`

```sql
SET 'pipeline.name' = 'ods_app_event_inc';
SET 'execution.checkpointing.interval' = '1 min';
SET 'table.local-time-zone' = 'Asia/Shanghai';
SET 'table.exec.source.idle-timeout' = '1 min';

CREATE CATALOG lake WITH (
  'type' = 'paimon',
  'warehouse' = 's3://mall-lake/warehouse'
);
CREATE DATABASE IF NOT EXISTS lake.ods;

CREATE TABLE IF NOT EXISTS lake.ods.ods_app_event_inc (
  event_id         STRING,
  event_type       STRING,
  user_id          BIGINT,
  device_id        STRING,
  sku_id           BIGINT,
  order_id         BIGINT,
  quantity         INT,
  amount           DECIMAL(18, 2),
  platform         STRING,
  app_version      STRING,
  client_ts        BIGINT,
  server_ts        BIGINT,
  kafka_partition  INT,
  kafka_offset     BIGINT,
  dt               DATE
) PARTITIONED BY (dt) WITH (
  'partition.expiration-time' = '30 d',
  'partition.timestamp-formatter' = 'yyyy-MM-dd',
  'partition.timestamp-pattern' = '$dt',
  'snapshot.time-retained' = '24 h',
  'consumer.expiration-time' = '3 d'
);

-- Kafka 源表建在默认 Catalog 中，作业结束即消失
CREATE TEMPORARY TABLE default_catalog.default_database.kafka_app_event (
  event_id         STRING,
  event_type       STRING,
  user_id          BIGINT,
  device_id        STRING,
  sku_id           BIGINT,
  order_id         BIGINT,
  quantity         INT,
  amount           DECIMAL(18, 2),
  platform         STRING,
  app_version      STRING,
  client_ts        BIGINT,
  server_ts        BIGINT,
  kafka_partition  INT    METADATA FROM 'partition' VIRTUAL,
  kafka_offset     BIGINT METADATA FROM 'offset' VIRTUAL,
  event_time AS TO_TIMESTAMP_LTZ(server_ts, 3),
  WATERMARK FOR event_time AS event_time - INTERVAL '10' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'app_event',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-ods-app-event',
  'scan.startup.mode' = 'group-offsets',
  'properties.auto.offset.reset' = 'earliest',
  'format' = 'json',
  'json.ignore-parse-errors' = 'true'
);

INSERT INTO lake.ods.ods_app_event_inc
SELECT event_id, event_type, user_id, device_id, sku_id, order_id, quantity, amount,
       platform, app_version, client_ts, server_ts, kafka_partition, kafka_offset,
       CAST(event_time AS DATE)
FROM default_catalog.default_database.kafka_app_event
WHERE server_ts IS NOT NULL;
```

要点：

- **ODS 是追加表，不做业务过滤**：没有主键，只丢弃连 `server_ts` 都没有的残缺消息。ODS 的价值是"出了问题能拿原始数据重算"，过滤和去重都留给 DWD
- **保留 Kafka 分区和位点**：`kafka_partition`、`kafka_offset` 让每条 ODS 记录都能追溯到 Kafka 中的具体消息，排查重复和丢失时非常有用
- **水位线写进快照**：源表声明了水位线，Paimon 会把它记录在每个快照的 `watermark` 字段中，第七节用它判断 ODS 的数据进度；`table.exec.source.idle-timeout` 防止某个 Kafka 分区没有数据时拖住水位线
- **分区按本地日期**：`table.local-time-zone` 设为 `Asia/Shanghai`，`CAST(event_time AS DATE)` 得到的是本地自然日；字段与时区标准见 [数据治理](./8_governance) 第五节
- **脏数据**：`json.ignore-parse-errors` 会让解析失败的字段变成 NULL 而不报错。网关已经保证了格式，这里只兜底；网关侧的拒绝计数是发现脏数据的主要手段

---

## 三、DWD：清洗与去重

作业 2：`dwd_traffic_app_event_inc.sql`（前四行 `SET` 与 `CREATE CATALOG` 同作业 1，`pipeline.name` 改为本作业名）

```sql
CREATE DATABASE IF NOT EXISTS lake.dwd;

CREATE TABLE IF NOT EXISTS lake.dwd.dwd_traffic_app_event_inc (
  dt           DATE,
  event_id     STRING,
  event_type   STRING,
  user_id      BIGINT,
  device_id    STRING,
  sku_id       BIGINT,
  order_id     BIGINT,
  quantity     INT,
  amount       DECIMAL(18, 2),
  platform     STRING,
  app_version  STRING,
  event_time   TIMESTAMP(3),
  PRIMARY KEY (dt, event_id) NOT ENFORCED
) PARTITIONED BY (dt) WITH (
  'bucket' = '8',
  'merge-engine' = 'first-row',
  'changelog-producer' = 'lookup',
  'partition.expiration-time' = '365 d',
  'partition.timestamp-formatter' = 'yyyy-MM-dd',
  'partition.timestamp-pattern' = '$dt',
  'partition.time-interval' = '1 d',
  'partition.idle-time-to-done' = '15 m',
  'partition.mark-done-action' = 'success-file',
  'snapshot.time-retained' = '24 h',
  'consumer.expiration-time' = '3 d'
);

INSERT INTO lake.dwd.dwd_traffic_app_event_inc
SELECT dt, event_id, event_type, user_id, device_id, sku_id, order_id, quantity, amount,
       platform, app_version,
       CAST(TO_TIMESTAMP_LTZ(server_ts, 3) AS TIMESTAMP(3)) AS event_time
FROM lake.ods.ods_app_event_inc /*+ OPTIONS('consumer-id' = 'dwd_traffic_app_event_inc') */
WHERE event_id IS NOT NULL
  AND device_id IS NOT NULL
  AND (
        (event_type = 'page_view' AND sku_id IS NOT NULL)
     OR (event_type = 'add_cart'  AND sku_id IS NOT NULL AND quantity > 0)
     OR (event_type = 'order_paid' AND order_id IS NOT NULL AND quantity > 0 AND amount > 0)
  );
```

### 1、用 first-row 去重

客户端重试、网关重发、Kafka 生产者重试、ODS 回放都会产生重复事件。`first-row` 合并引擎对同一主键只保留第一次写入的记录，之后的重复写入被丢弃：

- **去重状态在 Paimon 而不在 Flink**：等价于 Flink SQL 的 `ROW_NUMBER()` 去重，但不需要在 Flink 状态里存几亿个 `event_id`，也不用为状态 TTL 纠结
- **下游只收到插入**：配合 `changelog-producer = 'lookup'`，流式读取 DWD 的下游只会看到每个主键的第一条 `+I` 记录，没有回撤，这是 DWS 能用简单累加的前提。`first-row` 只支持 `none` 和 `lookup` 两种 changelog 产出方式，流读必须用 `lookup`
- **主键带上分区字段**：Paimon 分区表的主键必须包含分区字段，所以去重范围是"同一天内"。回放产生的重复事件 `server_ts` 不变、落在同一天，能被去掉；极少数跨零点的客户端重试会各留一条，可以接受
- **可见性**：`first-row` 表的 level-0 文件要在 compaction 后才可见，默认同步 compaction，不要为了吞吐开启异步 compaction，否则下游会额外延迟

### 2、consumer-id

`consumer-id` 让 Paimon 记录这个下游作业消费到了哪个快照，带来两个好处：

- **保护快照不被过期**：Paimon 过期快照时会检查所有 consumer，下游作业还没消费的快照不会被删除。没有它，下游停机超过 `snapshot.time-retained`（这里是 24 小时）后再恢复，会因为快照文件已被清理而失败
- **无状态也能续读**：作业不从 checkpoint 恢复时，也能从 consumer 记录的进度继续消费。默认的 `exactly-once` 模式下，消费进度与 checkpoint 对齐

`consumer.expiration-time` 让长期不活动的 consumer 自动失效，避免一个被遗忘的测试作业让快照永远无法过期。

### 3、分区完成标记

离线任务（例如每天凌晨基于 DWD 计算留存）需要知道"昨天的分区写完了没有"。`partition.mark-done-action = 'success-file'` 配合 `partition.time-interval` 与 `partition.idle-time-to-done`：分区对应的时间段结束、并且 15 分钟内没有新数据写入后，Paimon 在分区目录下写出 `_SUCCESS` 文件，例如：

```text
s3://mall-lake/warehouse/dwd.db/dwd_traffic_app_event_inc/dt=2026-10-09/_SUCCESS
```

调度系统的离线工作流以这个文件为依赖，后面接质量检查任务，强规则通过后再跑下游，做法见 [数据治理](./8_governance) 第四节和 [任务调度](./6_scheduling) 第二节。`_SUCCESS` 文件中记录了创建和修改时间，迟到数据会更新修改时间，可以据此发现分区标记完成后又被写入的情况。

---

## 四、DWS：写入即聚合

作业 3：`dws_trade_event.sql`（`SET` 与 `CREATE CATALOG` 同前）

```sql
CREATE DATABASE IF NOT EXISTS lake.dws;

CREATE TABLE IF NOT EXISTS lake.dws.dws_trade_site_event_1min (
  dt               DATE,
  minute_ts        TIMESTAMP(3),
  pv               BIGINT,
  cart_cnt         BIGINT,
  pay_qty          BIGINT,
  pay_amount       DECIMAL(18, 2),
  last_event_time  TIMESTAMP(3),
  PRIMARY KEY (dt, minute_ts) NOT ENFORCED
) PARTITIONED BY (dt) WITH (
  'bucket' = '1',
  'merge-engine' = 'aggregation',
  'fields.pv.aggregate-function' = 'sum',
  'fields.cart_cnt.aggregate-function' = 'sum',
  'fields.pay_qty.aggregate-function' = 'sum',
  'fields.pay_amount.aggregate-function' = 'sum',
  'fields.last_event_time.aggregate-function' = 'max',
  'partition.expiration-time' = '90 d',
  'partition.timestamp-formatter' = 'yyyy-MM-dd',
  'partition.timestamp-pattern' = '$dt'
);

CREATE TABLE IF NOT EXISTS lake.dws.dws_trade_sku_event_1d (
  dt          DATE,
  sku_id      BIGINT,
  pv          BIGINT,
  cart_cnt    BIGINT,
  pay_qty     BIGINT,
  pay_amount  DECIMAL(18, 2),
  PRIMARY KEY (dt, sku_id) NOT ENFORCED
) PARTITIONED BY (dt) WITH (
  'bucket' = '4',
  'merge-engine' = 'aggregation',
  'fields.pv.aggregate-function' = 'sum',
  'fields.cart_cnt.aggregate-function' = 'sum',
  'fields.pay_qty.aggregate-function' = 'sum',
  'fields.pay_amount.aggregate-function' = 'sum',
  'partition.expiration-time' = '90 d',
  'partition.timestamp-formatter' = 'yyyy-MM-dd',
  'partition.timestamp-pattern' = '$dt'
);

-- 两个 INSERT 共用同一个源，规划器会复用为一次读取
CREATE TEMPORARY VIEW dwd_event AS
SELECT
  dt,
  sku_id,
  event_time,
  CAST(IF(event_type = 'page_view', 1, 0) AS BIGINT)        AS pv,
  CAST(IF(event_type = 'add_cart', 1, 0) AS BIGINT)         AS cart_cnt,
  CAST(IF(event_type = 'order_paid', quantity, 0) AS BIGINT) AS pay_qty,
  IF(event_type = 'order_paid', amount, CAST(0 AS DECIMAL(18, 2))) AS pay_amount
FROM lake.dwd.dwd_traffic_app_event_inc /*+ OPTIONS('consumer-id' = 'dws_trade_event') */;

EXECUTE STATEMENT SET
BEGIN
  INSERT INTO lake.dws.dws_trade_site_event_1min
  SELECT dt, FLOOR(event_time TO MINUTE), pv, cart_cnt, pay_qty, pay_amount, event_time
  FROM dwd_event;

  INSERT INTO lake.dws.dws_trade_sku_event_1d
  SELECT dt, sku_id, pv, cart_cnt, pay_qty, pay_amount
  FROM dwd_event;
END;
```

这个作业没有 `GROUP BY`，也没有窗口：每条明细被转换成一行"增量"（浏览为 1、其余为 0），写进主键表后由 `aggregation` 合并引擎按主键累加。这样设计的好处：

- **几乎无状态**：聚合结果在 Paimon 里，Flink 作业只做逐行转换，重启、扩缩容、改并行度都不受状态限制
- **迟到数据自然归位**：一条迟到 5 分钟的事件，按自己的 `event_time` 落进对应的分钟桶，直接累加到那一行上，不需要水位线和窗口的迟到处理
- **前提是输入只有插入**：`sum` 遇到回撤会做减法，但 `max` 等函数不支持回撤。上游 DWD 用 `first-row` 保证了只有 `+I`，所以可以放心累加

注意几点：

- **DWS 没有配 `changelog-producer`**：它的读者是 StarRocks 的批量查询，读到的是合并后的结果，不需要 changelog。如果以后有 Flink 作业要流式读 DWS，`aggregation` 引擎必须配合 `lookup` 或 `full-compaction` 产出 changelog
- **UV 不能累加**：去重计数不能用 `sum` 合并。需要实时 UV 时，可以用 Paimon 的 `hll_sketch` / `theta_sketch` 聚合函数存近似基数，或者在 StarRocks 中对 DWD 明细做 `COUNT(DISTINCT)` / bitmap 聚合
- **`last_event_time` 取最大事件时间**：它是第七节判断数据新鲜度的依据，聚合函数用 `max`

---

## 五、StarRocks：外部 Catalog 与物化视图

### 1、创建 Paimon 外部 Catalog

```sql
CREATE EXTERNAL CATALOG paimon_lake
PROPERTIES (
  "type" = "paimon",
  "paimon.catalog.type" = "filesystem",
  "paimon.catalog.warehouse" = "s3://mall-lake/warehouse",
  "aws.s3.use_instance_profile" = "true",
  "aws.s3.endpoint" = "<s3_endpoint>"
);

-- 直接查询湖仓中的任意一层，排查问题时很方便
SELECT sku_id, pv, cart_cnt, pay_qty, pay_amount
FROM paimon_lake.dws.dws_trade_sku_event_1d
WHERE dt = '2026-10-10'
ORDER BY pay_amount DESC
LIMIT 20;
```

Paimon Catalog 在 StarRocks 中是只读的，可以 `SELECT`、`DESC`、`SHOW CREATE TABLE`，也可以用 `INSERT INTO <内表> SELECT ...` 把数据导入内表。开发同学用它直接查 ODS / DWD 排查问题，不用再临时写 Flink 作业消费 Kafka。

### 2、异步物化视图作为 ADS

直接查外部表每次都要读对象存储上的文件并做合并，对高频接口不划算。用异步物化视图把结果物化到 StarRocks 本地：

```sql
SET GLOBAL time_zone = 'Asia/Shanghai';   -- 与 Paimon 中的本地时间保持一致
CREATE DATABASE IF NOT EXISTS ads;

CREATE MATERIALIZED VIEW ads.ads_trade_realtime_overview
PARTITION BY dt
DISTRIBUTED BY HASH(minute_ts)
REFRESH ASYNC EVERY (INTERVAL 1 MINUTE)
PROPERTIES ("partition_ttl" = "30 DAY")
AS
SELECT dt, minute_ts, pv, cart_cnt, pay_qty, pay_amount, last_event_time
FROM paimon_lake.dws.dws_trade_site_event_1min;

CREATE MATERIALIZED VIEW ads.ads_trade_sku_rank
PARTITION BY dt
DISTRIBUTED BY HASH(sku_id)
REFRESH ASYNC EVERY (INTERVAL 1 MINUTE)
PROPERTIES ("partition_ttl" = "30 DAY")
AS
SELECT dt, sku_id, pv, cart_cnt, pay_qty, pay_amount
FROM paimon_lake.dws.dws_trade_sku_event_1d;
```

要点：

- **按分区增量刷新**：StarRocks 从 3.2.1 起能在分区级别感知 Paimon 表的变化，每次刷新只重算有变化的分区，这里通常只有当天一个分区。物化视图的分区键必须包含在基表的分区键中，所以 Paimon 表用 `DATE` 类型的 `dt` 分区，物化视图直接 `PARTITION BY dt`
- **只能定时刷新**：基于外部 Catalog 的物化视图不支持"基表变化即触发"，只支持固定间隔和手动刷新；新版本的 `SHOW CREATE MATERIALIZED VIEW` 会把 `ASYNC EVERY` 显示为 `SCHEDULE` 写法，含义相同
- **`partition_ttl`** 让物化视图只保留最近 30 天，更早的数据需要时直接查外部 Catalog
- 物化视图的透明改写、刷新资源隔离等更多用法见 [OLAP 查询与数据服务](./7_olap_service) 第五节，Doris / StarRocks 的数据模型见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)

### 3、服务账号

查询服务使用独立账号，只授予两张物化视图的读权限（授权设计见 [数据治理](./8_governance) 第六节）：

```sql
CREATE ROLE rt_query;
GRANT SELECT ON MATERIALIZED VIEW ads.ads_trade_realtime_overview TO ROLE rt_query;
GRANT SELECT ON MATERIALIZED VIEW ads.ads_trade_sku_rank TO ROLE rt_query;

CREATE USER 'rt_query_svc'@'%' IDENTIFIED BY '<password>';
GRANT rt_query TO USER 'rt_query_svc'@'%';
SET DEFAULT ROLE rt_query TO 'rt_query_svc'@'%';
```

---

## 六、查询服务

查询服务是一个普通的 Spring Boot 4 应用，StarRocks 兼容 MySQL 协议，用 `mysql-connector-j` 和 `JdbcClient` 即可。连接池、参数约束、按数据版本失效缓存、重查询限流这些通用做法在 [OLAP 查询与数据服务](./7_olap_service) 第四、六、七节已经展开，这里只给出与实时链路相关的部分：接口返回数据的同时返回**数据新鲜度**，并把新鲜度暴露为监控指标。

依赖：`spring-boot-starter-webmvc`、`spring-boot-starter-jdbc`、`spring-boot-starter-cache`、`spring-boot-starter-actuator`、`com.mysql:mysql-connector-j`、`com.github.ben-manes.caffeine:caffeine`、`io.micrometer:micrometer-registry-prometheus`。

```yaml
spring:
  datasource:
    url: jdbc:mysql://starrocks-fe:9030/ads
    username: rt_query_svc
    password: ${STARROCKS_PASSWORD}
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=30s   # 数据每分钟才更新一次，缓存 30 秒足够
management.endpoints.web.exposure.include: health,prometheus
```

```java
public record MinutePoint(LocalDateTime minuteTs, long pv, long cartCnt, long payQty, BigDecimal payAmount) {}

@Repository
public class RealtimeMetricRepository {

    private final JdbcClient jdbcClient;

    public RealtimeMetricRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public List<MinutePoint> overview(LocalDate dt) {
        return jdbcClient.sql("""
                SELECT minute_ts, pv, cart_cnt, pay_qty, pay_amount
                FROM ads_trade_realtime_overview
                WHERE dt = :dt
                ORDER BY minute_ts
                """)
                .param("dt", dt)
                .query(MinutePoint.class)
                .list();
    }

    /** 最新事件时间距现在的秒数；近两天都没有数据时返回 -1 */
    public long freshnessLagSeconds() {
        return jdbcClient.sql("""
                SELECT COALESCE(TIMESTAMPDIFF(SECOND, MAX(last_event_time), NOW()), -1)
                FROM ads_trade_realtime_overview
                WHERE dt >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
                """)
                .query(Long.class)
                .single();
    }
}
```

`query(MinutePoint.class)` 对 record 使用 `DataClassRowMapper`，会把 `minute_ts` 这类下划线列名映射到 `minuteTs` 组件。

```java
@Component
public class FreshnessMonitor {

    private final RealtimeMetricRepository repository;
    private final AtomicLong lagSeconds = new AtomicLong(-1);

    public FreshnessMonitor(RealtimeMetricRepository repository, MeterRegistry registry) {
        this.repository = repository;
        Gauge.builder("dw.freshness.lag", lagSeconds, AtomicLong::get)
                .description("实时数仓最新事件时间与当前时间的差")
                .baseUnit("seconds")
                .tag("table", "ads_trade_realtime_overview")
                .register(registry);
    }

    @Scheduled(fixedDelay = 30_000)
    public void refresh() {
        lagSeconds.set(repository.freshnessLagSeconds());
    }

    public long current() {
        return lagSeconds.get();
    }
}
```

```java
public record OverviewResponse(LocalDate dt, long lagSeconds, List<MinutePoint> points) {}

@RestController
@RequestMapping("/api/realtime")
public class RealtimeMetricController {

    private final RealtimeMetricService service;   // 对 Repository 方法加 @Cacheable，代码略
    private final FreshnessMonitor freshness;

    public RealtimeMetricController(RealtimeMetricService service, FreshnessMonitor freshness) {
        this.service = service;
        this.freshness = freshness;
    }

    @GetMapping("/overview")
    public OverviewResponse overview(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dt) {
        LocalDate day = dt != null ? dt : LocalDate.now(ZoneId.of("Asia/Shanghai"));
        return new OverviewResponse(day, freshness.current(), service.overview(day));
    }
}
```

启动类加上 `@EnableCaching` 和 `@EnableScheduling`。商品排行接口查询 `ads_trade_sku_rank`（`ORDER BY pay_amount DESC LIMIT :limit`），写法相同，`limit` 的参数约束见 [OLAP 查询与数据服务](./7_olap_service) 第四节。大屏前端拿到 `lagSeconds` 后在页面上显示"数据更新于 x 分钟前"，延迟过大时置灰提示，而不是让运营对着一条停住的曲线做决策。StarRocks 不可用时，服务返回缓存中的最近结果并标注数据时间，降级策略见 [服务降级](/high-avail/6_degradation)；本地缓存与两级缓存的设计见 [Caffeine](/cache/7_caffeine)。

---

## 七、延迟监控

链路越长，"数据不动了"的原因越多：Kafka 积压、某个 Flink 作业 checkpoint 失败、Paimon compaction 跟不上、物化视图刷新失败。每一层放一个观测点，才能在告警时直接定位到哪一段：

| 层 | 观测点 | 来源 | 异常信号 |
|----|--------|------|----------|
| Kafka → ODS | 消费积压 | Kafka Source 的 `pendingRecords` 指标、消费组 lag | 积压持续上升 |
| 各 Flink 作业 | checkpoint 时长与失败次数 | `lastCheckpointDuration`、`numberOfFailedCheckpoints` | 失败次数增加，或时长接近间隔 |
| ODS | 最新快照的水位线 | `ods_app_event_inc$snapshots` 的 `watermark` | 与当前时间差距持续扩大 |
| DWD / DWS | 最新提交时间、下游消费进度 | `$snapshots` 的 `commit_time`、`$consumers` 的 `next_snapshot_id` | 长时间无新快照；consumer 落后最新快照越来越多 |
| ADS | 物化视图刷新状态 | `information_schema.materialized_views` | `LAST_REFRESH_STATE` 为失败，或完成时间停滞 |
| 端到端 | 数据新鲜度 | 查询服务的 `dw_freshness_lag_seconds` | 超过 600 秒 |

Paimon 的系统表可以在 Flink SQL（批模式）或 Spark 中查询：

```sql
-- ODS 最新快照：提交时间与水位线（毫秒时间戳）
SELECT snapshot_id, commit_time, watermark
FROM lake.ods.ods_app_event_inc$snapshots
ORDER BY snapshot_id DESC
LIMIT 1;

-- DWS 作业消费 DWD 的进度，与 DWD 最新 snapshot_id 比较
SELECT consumer_id, next_snapshot_id
FROM lake.dwd.dwd_traffic_app_event_inc$consumers;
```

StarRocks 物化视图的刷新状态：

```sql
SELECT TABLE_NAME, LAST_REFRESH_STATE, LAST_REFRESH_FINISHED_TIME, LAST_REFRESH_ERROR_MESSAGE
FROM information_schema.materialized_views
WHERE TABLE_SCHEMA = 'ads';
```

Flink 通过 Prometheus Reporter 暴露指标（配置见 [Flink 部署与运维](/flink/7_deployment)），查询服务通过 Actuator 暴露新鲜度，告警规则：

```yaml
groups:
  - name: realtime-dw
    rules:
      - alert: RealtimeDwStale
        expr: dw_freshness_lag_seconds{table="ads_trade_realtime_overview"} > 600
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 实时大屏数据延迟超过 10 分钟
      - alert: FlinkCheckpointFailing
        expr: delta(flink_jobmanager_job_numberOfFailedCheckpoints[10m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.job_name }} 最近 10 分钟有 checkpoint 失败"
```

新鲜度为 -1（近两天没有任何数据）同样要告警。端到端新鲜度是唯一需要电话告警的指标，其他观测点用于定位：新鲜度告警时，从 ADS 往上逐层看哪一层的时间停住了。告警分级与路由见 [告警体系](/observability/4_alerting)，指标设计见 [指标监控](/observability/2_metrics)。

::: tip 新鲜度要用业务时间衡量
只看"作业在运行""物化视图刷新成功"是不够的：上游埋点全部被网关拒绝时，所有作业都健康，但数据一条也没进来。`last_event_time` 是数据本身携带的时间，它不前进就说明链路某处断了，不管各组件看起来多健康。
:::

---

## 八、回放与补数

三种常见情况，处理方式不同：

| 情况 | 例子 | 做法 |
|------|------|------|
| ODS 漏数据或解析错 | ODS 作业有 bug，某段时间的消息字段解析错误 | 从 Kafka 按时间点重放，DWD 去重吸收重复 |
| DWD 清洗逻辑错 | 过滤条件写错，误删了某类事件 | 修改逻辑后，从 ODS 批量重算指定日期的 DWD，再重算 DWS |
| DWS 口径错 | 支付件数统计口径要调整 | 从 DWD 批量重算指定日期的 DWS |

### 1、从 Kafka 重放

停掉原 ODS 作业，修复后**不从 checkpoint 恢复**，改用新的消费组从指定时间点开始消费。只需在作业 1 的 `INSERT` 中给源表加上动态选项：

```sql
INSERT INTO lake.ods.ods_app_event_inc
SELECT event_id, event_type, user_id, device_id, sku_id, order_id, quantity, amount,
       platform, app_version, client_ts, server_ts, kafka_partition, kafka_offset,
       CAST(event_time AS DATE)
FROM default_catalog.default_database.kafka_app_event /*+ OPTIONS(
  'properties.group.id' = 'flink-ods-app-event-v2',
  'scan.startup.mode' = 'timestamp',
  'scan.startup.timestamp-millis' = '1791594000000'   -- 2026-10-10 09:00:00 +08:00
) */
WHERE server_ts IS NOT NULL;
```

重放会让 ODS 中出现重复记录（追加表不去重），但 DWD 的 `first-row` 按 `(dt, event_id)` 只保留第一条，已经处理过的事件不会再次流向 DWS，所以汇总不会重复累加。这就是"去重放在 DWD、聚合依赖只有插入的输入"这套设计的回报：重放是安全的。

前提是 Kafka 的保留时间覆盖重放起点，所以 `retention.ms` 要大于"故障发现时间 + 修复时间"，这里取 7 天。超出 Kafka 保留期的数据，只能从 ODS 重算。

### 2、批量重算历史分区

DWD 或 DWS 逻辑修复后，用 Flink 批模式重算指定日期。Flink 默认是动态分区覆盖，`INSERT OVERWRITE` 只替换查询结果中出现的分区。先重算 DWD：把作业 2 的 `INSERT INTO` 改成 `INSERT OVERWRITE`，去掉 `consumer-id` 提示，在 `WHERE` 中追加 `dt = DATE '2026-10-08'`，以批模式执行。再重算同一天的 DWS：

```sql
SET 'execution.runtime-mode' = 'batch';
SET 'table.local-time-zone' = 'Asia/Shanghai';

INSERT OVERWRITE lake.dws.dws_trade_sku_event_1d
SELECT dt, sku_id,
       SUM(CAST(IF(event_type = 'page_view', 1, 0) AS BIGINT)),
       SUM(CAST(IF(event_type = 'add_cart', 1, 0) AS BIGINT)),
       SUM(CAST(IF(event_type = 'order_paid', quantity, 0) AS BIGINT)),
       SUM(IF(event_type = 'order_paid', amount, CAST(0 AS DECIMAL(18, 2))))
FROM lake.dwd.dwd_traffic_app_event_inc
WHERE dt = DATE '2026-10-08'
GROUP BY dt, sku_id;
```

`dws_trade_site_event_1min` 同理按 `dt, FLOOR(event_time TO MINUTE)` 分组重算。然后强制刷新 StarRocks 物化视图的对应分区：

```sql
REFRESH MATERIALIZED VIEW ads.ads_trade_sku_rank
PARTITION START ("2026-10-08") END ("2026-10-09") FORCE WITH SYNC MODE;
```

几个必须知道的行为：

- **覆盖不会传给流式下游**：流读默认忽略 `OVERWRITE` 类型的快照（`streaming-read-overwrite` 默认 `false`，并且在 `lookup` / `full-compaction` changelog 下不能开启），所以重算 DWD 之后，DWS 不会自动更新，必须像上面一样显式重算 DWS。按血缘把下游逐层补齐，是补数的通用原则（见 [任务调度](./6_scheduling) 第五节）
- **只重算已经关闭的分区**：流式作业仍在写入的当天分区不要用批作业覆盖，两个作业同时写同一分区会产生提交冲突。当天的数据有误时，修复流式作业后从 ODS 重放更稳妥
- **用分区完成标记判断是否关闭**：分区下已有 `_SUCCESS` 文件，说明流式写入已经结束

---

## 九、故障恢复

| 故障 | 影响 | 处理 |
|------|------|------|
| TaskManager 宕机、作业自动重启 | 从最近一次 checkpoint 恢复 | Paimon Sink 在 checkpoint 时两阶段提交，恢复后不重不丢；配置 `restart-strategy.type: exponential-delay` 避免频繁重启打满集群 |
| checkpoint 持续失败 | Paimon 不提交，下游看不到新数据 | 查看是反压还是对象存储写入慢；常见原因是 DWD 的 lookup compaction 跟不上，增加 `bucket` 或资源 |
| 作业停机超过一天 | 快照可能已过期 | 有 `consumer-id` 保护的快照不会被清理，恢复后继续消费；超过 `consumer.expiration-time` 后 consumer 失效，只能从指定时间点或快照重新开始，再按第八节补数 |
| Kafka 积压超过保留期 | 最早的消息被删除 | 优先恢复 ODS 作业；保留期按最长恢复时间设置 |
| SQL 逻辑变更后无法从 savepoint 恢复 | 算子拓扑变化，状态不兼容 | 本链路 DWD / DWS 作业几乎无状态，可以不带状态启动，由 `consumer-id` 从上次进度续读 |
| 表结构变更（加字段） | 新字段不可见 | Paimon `ALTER TABLE ... ADD` 后修改作业 SQL 重启；StarRocks 物化视图可能变为 inactive，用 `ALTER MATERIALIZED VIEW <name> ACTIVE` 重新激活 |
| 物化视图刷新失败 | ADS 停在旧数据，新鲜度告警 | 查 `LAST_REFRESH_ERROR_MESSAGE`，修复后 `REFRESH MATERIALIZED VIEW` 手动刷新 |

计划内的升级（改 SQL、升级 Flink 小版本、调并行度）走 stop-with-savepoint：

```bash
# 停止作业并生成 savepoint
./bin/flink stop --savepointPath s3://mall-lake/flink/savepoints/dws_trade_event <jobId>
```

```sql
-- 在 SQL 脚本开头指定恢复路径（Flink 2.x 使用 execution.state-recovery.path，取代旧的 execution.savepoint.path）
SET 'execution.state-recovery.path' = 's3://mall-lake/flink/savepoints/dws_trade_event/savepoint-xxxxxx';
```

如果 SQL 改动导致状态无法恢复，对 DWD / DWS 作业直接去掉这一行重新提交即可，`consumer-id` 会从上次提交的快照继续消费；对持有 Kafka 位点的 ODS 作业，不带状态启动时会从消费组已提交的位点（`group-offsets`）继续。需要把某个 consumer 的进度回拨到指定快照时，先停掉对应作业，再调用 Paimon 的 `sys.reset_consumer` 过程：

```sql
USE CATALOG lake;
CALL sys.reset_consumer('dwd.dwd_traffic_app_event_inc', 'dws_trade_event', 1024);
```

checkpoint 与 savepoint 的原理、状态后端选型见 [状态与容错](/flink/4_state_checkpoint)，生产部署与 Kubernetes Operator 见 [Flink 部署与运维](/flink/7_deployment)。

---

## 小结

- 链路：埋点 SDK → 采集网关 → Kafka → Flink SQL 写 Paimon ODS / DWD / DWS → StarRocks 异步物化视图 → Spring Boot 查询服务；端到端延迟约 3–5 分钟，由各层 checkpoint 间隔和物化视图刷新间隔决定，秒级需求另走 Kafka 直连 OLAP
- 埋点统一结构并登记；交易事件由服务端发出，分区与统计一律用 `server_ts`；网关校验、补时间、按 `device_id` 写 Kafka，拒绝数计入指标
- ODS 用追加表原样落地并保留 Kafka 分区与位点；DWD 用 `first-row` 按 `(dt, event_id)` 去重并以 `lookup` 产出只有插入的 changelog；DWS 用 `aggregation` 合并引擎写入即累加，Flink 作业几乎无状态
- 下游作业都配 `consumer-id`：防止快照过期，并能不带状态从上次进度续读；DWD 配置分区完成标记，为离线任务和质量门禁提供依赖
- StarRocks 的 Flink 连接器尚不支持 Flink 2.x，改用 Paimon 外部 Catalog + 异步物化视图，按分区增量刷新
- 每层一个观测点，端到端用 `last_event_time` 计算新鲜度并电话告警；接口同时返回新鲜度
- 重放安全依赖 DWD 去重；批量重算用动态分区覆盖，覆盖不会传给流式下游，要按血缘逐层补齐并强制刷新物化视图；升级走 stop-with-savepoint，Flink 2.x 用 `execution.state-recovery.path` 恢复
- Flink 的 DataStream、窗口、状态等原理本篇不展开，见 [Flink](/flink/0_overview) 模块

## 参考资料

- Paimon Flink 快速开始与依赖：[Paimon Flink Quick Start](https://paimon.apache.org/docs/2.0/flink/quick-start)
- Paimon 合并引擎：[First Row](https://paimon.apache.org/docs/2.0/primary-key-table/merge-engine/first-row/)、[Aggregation](https://paimon.apache.org/docs/2.0/primary-key-table/merge-engine/aggregation/)
- Paimon 流式读取与 consumer：[SQL Query](https://paimon.apache.org/docs/2.0/flink/sql-query/)、[Consumer ID](https://paimon.apache.org/docs/2.0/flink/consumer-id/)
- Paimon 写入、覆盖与分区完成标记：[SQL Write](https://paimon.apache.org/docs/2.0/flink/sql-write/)
- Paimon 系统表：[System Tables](https://paimon.apache.org/docs/2.0/concepts/system-tables/)
- Paimon 表属性：[Configurations](https://paimon.apache.org/docs/2.0/maintenance/configurations/)
- Flink Kafka 连接器：[Apache Kafka SQL Connector](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/table/kafka/)
- Flink 配置项：[Configuration](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/config/)
- Flink 指标：[Metrics](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/metrics/)
- StarRocks Paimon Catalog：[Paimon catalog](https://docs.starrocks.io/docs/data_source/catalog/paimon_catalog/)
- StarRocks 物化视图：[CREATE MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW/)、[REFRESH MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/REFRESH_MATERIALIZED_VIEW/)、[数据湖查询加速](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_lake_query_acceleration_with_materialized_views/)
- StarRocks 物化视图状态：[information_schema.materialized_views](https://docs.starrocks.io/docs/sql-reference/information_schema/materialized_views/)
- StarRocks Flink 连接器版本兼容：[Load data using Flink connector](https://docs.starrocks.io/docs/loading/Flink-connector-starrocks/)
- Spring Framework JdbcClient：[JDBC Core Classes](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html)

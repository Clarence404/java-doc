---
description: 实时 GMV 大屏、CEP 实时风控、Kafka / Paimon 实时数仓分层、维表关联策略选型
---

# 实战场景

> 前置阅读：[Flink SQL 与 Table API](./5_sql)、[Flink CDC](./6_cdc)、[部署与运维](./7_deployment)

实战场景把前面的 Flink 知识串成可落地的完整方案。本篇讲实时 GMV 大屏、CEP 实时风控、实时数仓分层、维表关联，基线为 Flink 2.2。

---

## 一、实时 GMV 大屏

每个方案给出架构、关键代码与设计取舍。示例基于 Flink 2.2 + `flink-connector-kafka:5.0.0-2.2` + Flink CDC 3.6；CEP 需要单独引入 `flink-cep`（不在 Flink 发行包里）。

### 1、需求与架构

运营大屏展示「今日实时 GMV、支付人数」，每分钟刷新，按类目拆分；0 点自动清零；与次日离线报表的差异要可解释。

![实时 GMV 大屏](../assets/flink/flink-gmv-dashboard.svg)

### 2、关键 SQL

```sql
SET 'table.local-time-zone' = 'Asia/Shanghai';
SET 'table.exec.source.idle-timeout' = '30 s';

-- 源表 order_paid：支付成功事件，DDL 在 Flink SQL 篇的基础上补充 category_id、shop_id 两列；pay_time 为 TIMESTAMP_LTZ(3) 事件时间

-- 1）结果表：主键 = 日期 + 类目 + 窗口结束时间，重放幂等
CREATE TABLE ads_gmv_minute (
  stat_date    DATE,
  category_id  BIGINT,
  window_end   TIMESTAMP(3),
  gmv          DECIMAL(18, 2),
  buyers       BIGINT,
  PRIMARY KEY (stat_date, category_id, window_end) NOT ENFORCED
) WITH (
  'connector' = 'jdbc',
  'url' = 'jdbc:mysql://report-db:3306/ads',
  'table-name' = 'ads_gmv_minute',
  'username' = 'flink_writer',
  'password' = '******'
);

-- 2）当日累计，每分钟输出一次
INSERT INTO ads_gmv_minute
SELECT CAST(window_start AS DATE)   AS stat_date,
       category_id,
       window_end,
       SUM(amount)                  AS gmv,
       COUNT(DISTINCT user_id)      AS buyers
FROM CUMULATE(TABLE order_paid, DESCRIPTOR(pay_time), INTERVAL '1' MINUTE, INTERVAL '1' DAY)
GROUP BY window_start, window_end, category_id;
```

窗口 TVF 只认带水位线的事件时间属性，因此重复消息的处理放在上游，见下文「重复消息」。

### 3、设计要点

- **为什么用 CUMULATE**：无界 `GROUP BY DATE(pay_time)` 每条订单都会发一次更新，状态永不过期；`CUMULATE` 按分钟输出、只追加，日窗口结束后状态自动清理，0 点天然清零。`table.local-time-zone` 决定「一天」从北京时间 0 点开始。
- **口径**：以支付时间（事件时间）而非处理时间统计，作业重启、积压追数后的结果与离线一致。
- **迟到数据**：水位线之后到达的数据会被窗口丢弃。水位线延迟（如 5 秒）在「延迟」与「准确」之间取舍；剩余差异由 T+1 离线报表校准，并在大屏标注「实时数据仅供参考」。
- **重复消息**：生产端开启 Kafka 幂等生产者可消除重试造成的重复；业务重发等仍可能重复时，由上游 DWD 作业按订单号去重（保留第一条，输出只追加）后写入新主题，GMV 作业消费去重后的主题并重新声明水位线。去重作业要配 TTL（如 `SET 'table.exec.state.ttl' = '1 d'`），否则订单号状态无限增长。
- **类目热点**：少数大类目集中了大部分订单，`COUNT(DISTINCT)` 会倾斜，打开 mini-batch 与 distinct 拆分。
- **大屏读取**：后端服务按分钟查 `ads_gmv_minute` 最新一行并缓存，不要让每个大屏客户端直接查库；高并发读取可以把结果同时写一份 Redis。

---

## 二、实时风控：CEP 识别异常登录

### 1、需求与架构

识别「同一用户 5 分钟内连续登录失败至少 3 次后又登录成功」——典型的撞库得手特征，命中后要求二次验证或冻结账号。

![实时风控：CEP 识别「连续失败后成功登录」](../assets/flink/flink-risk-cep.svg)

### 2、关键代码

```java
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.cep.CEP;
import org.apache.flink.cep.PatternStream;
import org.apache.flink.cep.functions.PatternProcessFunction;
import org.apache.flink.cep.nfa.aftermatch.AfterMatchSkipStrategy;
import org.apache.flink.cep.pattern.Pattern;
import org.apache.flink.cep.pattern.conditions.SimpleCondition;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.formats.json.JsonDeserializationSchema;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.util.Collector;

public class LoginRiskJob {

    /** 登录事件 POJO */
    public static class LoginEvent {
        public String userId;
        public String ip;
        public boolean success;
        public long eventTime;   // 毫秒时间戳
        public LoginEvent() {}
    }

    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.enableCheckpointing(60_000);

        KafkaSource<LoginEvent> source = KafkaSource.<LoginEvent>builder()
                .setBootstrapServers("kafka:9092")
                .setTopics("login_event")
                .setGroupId("risk-login-cep")
                .setStartingOffsets(OffsetsInitializer.latest())
                .setValueOnlyDeserializer(new JsonDeserializationSchema<>(LoginEvent.class))
                .build();

        DataStream<LoginEvent> logins = env.fromSource(source,
                WatermarkStrategy.<LoginEvent>forBoundedOutOfOrderness(Duration.ofSeconds(3))
                        .withTimestampAssigner((e, ts) -> e.eventTime)
                        .withIdleness(Duration.ofMinutes(1)),
                "login-source").uid("login-source");

        // 连续失败 >= 3 次，紧接着一次成功，整体发生在 5 分钟内
        Pattern<LoginEvent, ?> pattern = Pattern
                .<LoginEvent>begin("fail", AfterMatchSkipStrategy.skipPastLastEvent())
                .where(SimpleCondition.of(e -> !e.success))
                .timesOrMore(3).consecutive()
                .next("success")
                .where(SimpleCondition.of(e -> e.success))
                .within(Duration.ofMinutes(5));

        PatternStream<LoginEvent> matches = CEP.pattern(logins.keyBy(e -> e.userId), pattern);

        DataStream<String> alerts = matches.process(new PatternProcessFunction<LoginEvent, String>() {
            @Override
            public void processMatch(Map<String, List<LoginEvent>> match, Context ctx,
                                     Collector<String> out) {
                List<LoginEvent> fails = match.get("fail");
                LoginEvent ok = match.get("success").get(0);
                out.collect(String.format(
                        "{\"userId\":\"%s\",\"failCount\":%d,\"successIp\":\"%s\",\"ts\":%d}",
                        ok.userId, fails.size(), ok.ip, ok.eventTime));
            }
        }).uid("login-cep");

        KafkaSink<String> sink = KafkaSink.<String>builder()
                .setBootstrapServers("kafka:9092")
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic("risk_alert")
                        .setValueSerializationSchema(new SimpleStringSchema())
                        .build())
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                .build();
        alerts.sinkTo(sink).uid("risk-alert-sink");

        env.execute("login-risk-cep");
    }
}
```

依赖：`flink-cep`、`flink-connector-kafka`、`flink-json`（`JsonDeserializationSchema`），版本与 Flink 对齐。

### 3、设计要点

- **CEP 默认按事件时间**：同一用户的事件在进入 NFA 前按时间戳排序，乱序容忍度由水位线决定；不需要严格时序时可调用 `inProcessingTime()` 降低延迟。
- **`within` 是状态边界**：超过 5 分钟的部分匹配会被清理，状态不会无限增长；没有 `within` 的模式加上 `timesOrMore` 会让状态失控。
- **跳过策略**：`skipPastLastEvent()` 保证一次撞库只告警一次，默认的 `noSkip()` 会把「4 次失败 + 成功」拆成多次匹配重复告警。
- **告警幂等**：Sink 是至少一次，作业重启可能重复告警。下游风控服务以 `userId + ts` 去重；要精确一次可改为 `EXACTLY_ONCE` 并设置 `setTransactionalIdPrefix`，下游以 `read_committed` 消费。消费端幂等的做法见 [幂等设计](/architecture/5_idempotence)。
- **规则动态化**：CEP 模式编译进作业，修改阈值要重新发布。规则频繁变化时，把阈值类规则写成「广播规则流 + `KeyedBroadcastProcessFunction` + 状态计数」，或交给专门的规则引擎，CEP 只负责结构稳定的时序模式。
- **超时也是信号**：「连续失败但 5 分钟内没成功」可以在 `PatternProcessFunction` 上实现 `TimedOutPartialMatchHandler`，把超时的部分匹配输出到侧输出流，用于识别暴力破解尝试。

---

## 三、实时数仓分层

### 1、架构

![实时数仓分层（Kafka / Paimon）](../assets/flink/flink-realtime-dw.svg)

| 层 | 内容 | 存储 | 产出方式 |
|----|------|------|----------|
| ODS | 业务库变更、埋点日志原样落地 | Paimon 主键表 / Kafka | Flink CDC Pipeline 整库同步；日志直接写 Kafka |
| DWD | 清洗、去重、维度打宽后的明细 | Paimon 主键表 | Flink SQL 流式读 ODS，关联维表后写入 |
| DWS | 按主题、粒度轻度汇总 | Paimon 聚合表 / Doris | Flink SQL 聚合 |
| ADS | 面向应用的指标与宽表 | Doris / StarRocks | 汇总写入或直接在 OLAP 中建视图 |

### 2、Kafka 还是 Paimon 做中间层

| 维度 | Kafka 分层 | Paimon 分层 |
|------|-----------|-------------|
| 延迟 | 秒级 | 分钟级（数据在 checkpoint 时提交可见） |
| 可查询 | 不能直接查，排查问题要临时消费 | 可用 Flink / Spark / OLAP 引擎直接查询任意一层 |
| 更新与回溯 | 只能按 offset 重放 | 主键表支持 upsert，可按快照时间回溯 |
| 成本 | 数据保留期有限，长期保存贵 | 对象存储，成本低，流批一体共用一份数据 |

常见组合是「延迟敏感的链路走 Kafka，其余走 Paimon」：大屏、风控直接消费 Kafka；数仓明细和汇总落在 Paimon，既能流式往下游传，又能被分析查询直接使用。

### 3、关键代码

ODS：用 Flink CDC Pipeline 把业务库整库同步进 Paimon（`sink.type: paimon`），自动建表并跟随上游 Schema 演进，写法与 [Flink CDC](./6_cdc) 中同步 Doris 的管道相同。

DWD：订单明细打宽。

```sql
CREATE CATALOG lake WITH (
  'type' = 'paimon',
  'warehouse' = 's3://lake/warehouse'
);
USE CATALOG lake;

CREATE TABLE IF NOT EXISTS dwd.dwd_order_detail (
  order_id     BIGINT,
  user_id      BIGINT,
  user_level   STRING,
  city         STRING,
  amount       DECIMAL(18, 2),
  status       STRING,
  pay_time     TIMESTAMP(3),
  dt           STRING,
  PRIMARY KEY (dt, order_id) NOT ENFORCED
) PARTITIONED BY (dt) WITH (
  'bucket' = '8',
  'changelog-producer' = 'lookup'     -- 为下游流读产出完整 changelog
);

INSERT INTO dwd.dwd_order_detail
SELECT o.id, o.user_id, u.level, u.city, o.amount, o.status, o.pay_time,
       DATE_FORMAT(o.pay_time, 'yyyy-MM-dd')
FROM ods.ods_orders AS o
LEFT JOIN ods.ods_user AS u
  ON o.user_id = u.id;
```

DWS：用聚合合并引擎做预聚合，写入即合并。

```sql
CREATE TABLE IF NOT EXISTS dws.dws_city_gmv_day (
  dt      STRING,
  city    STRING,
  gmv     DECIMAL(18, 2),
  orders  BIGINT,
  PRIMARY KEY (dt, city) NOT ENFORCED
) WITH (
  'merge-engine' = 'aggregation',
  'fields.gmv.aggregate-function' = 'sum',
  'fields.orders.aggregate-function' = 'sum',
  'changelog-producer' = 'lookup'
);
```

### 4、设计要点

- **Paimon 的 changelog**：主键表默认不为下游产出完整 changelog，下游要流式消费更新时设置 `changelog-producer`（`input` / `lookup` / `full-compaction`），`lookup` 在延迟和成本间较均衡。
- **DWD 关联的是「当前」维度**：上例中 ODS 用户表是一张不断更新的表，Regular Join 会在维度变更时回撤并更新历史明细，状态也很大。只要「下单时刻的维度」时改用 Lookup Join，或在 Paimon 中用 Temporal Join；对比见下一节。
- **分区与分桶**：按天分区便于过期清理；`bucket` 决定写入并行度上限，过少会成为写入瓶颈，过多会产生大量小文件。
- **每层一个作业 vs 一个作业多层**：分作业便于独立升级和回溯，但端到端延迟是各层 checkpoint 间隔之和；对延迟敏感的指标不要堆太多层。
- **ODS 用 CDC 一次拉全库**，下游所有作业都读 Paimon，避免每个作业都单独连业务库读 binlog。

---

## 四、维表关联策略

### 1、方案对比

![维表关联的三种做法](../assets/flink/flink-dim-join.svg)

| 方案 | 维度一致性 | Flink 状态 | 外部压力 | 适用 |
|------|-----------|-----------|----------|------|
| Lookup Join + 缓存 | 处理时刻的值，缓存期内可能旧 | 几乎无 | 高，依赖缓存与异步 | 大维表、变化慢，如用户、商品 |
| Temporal Join（版本表） | 事件时刻的值，可重放 | 维表全量版本 | 无 | 汇率、价格等需严格按时间关联 |
| Broadcast State | 最新值，每个并行实例一份 | 维表全量 × 并行度 | 无 | 小维表、规则配置 |
| 启动时预加载 + 定时刷新 | 刷新周期内可能旧 | 堆内存 | 低 | 很小且几乎不变的码表 |

选择顺序：维表小（万级）且变化需要实时生效 → Broadcast；维表大 → Lookup + 缓存；必须按事件时间关联 → Temporal Join（维表通过 Flink CDC 或 upsert-kafka 接入）。

### 2、Lookup Join 的三个坑

```sql
SELECT /*+ LOOKUP('table'='s', 'async'='true', 'output-mode'='allow_unordered',
                  'retry-predicate'='lookup_miss', 'retry-strategy'='fixed_delay',
                  'fixed-delay'='2s', 'max-attempts'='3') */
       o.order_id, o.amount, s.shop_name, s.region
FROM order_paid AS o
LEFT JOIN dim_shop FOR SYSTEM_TIME AS OF o.proc_time AS s
  ON o.shop_id = s.id;
```

- **维度晚到**：新店铺的第一笔订单可能比店铺数据先到，查不到就关联出 null。`retry-predicate = lookup_miss` 让查不到时延迟重试，重试参数没有默认值，需要全部显式设置。
- **缓存穿透与陈旧**：`PARTIAL` 缓存默认缓存空值，配合重试时要权衡；缓存过期时间就是维度变更的最大可见延迟。
- **同步查询拖垮吞吐**：每条记录一次同步 RPC，单子任务每秒只能处理几百条。开启异步并设置 `capacity`；不要求输出顺序时用 `allow_unordered`。

### 3、Broadcast State

```java
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.functions.co.BroadcastProcessFunction;
import org.apache.flink.util.Collector;

// orders：DataStream<OrderEvent>；shopDims：店铺维表变更流 DataStream<ShopDim>（如 Flink CDC 读出）
// OrderEvent、ShopDim、EnrichedOrder 均为 POJO
final MapStateDescriptor<Long, ShopDim> dimDesc =
        new MapStateDescriptor<>("shop-dim", Types.LONG, Types.POJO(ShopDim.class));

BroadcastStream<ShopDim> dimBroadcast = shopDims.broadcast(dimDesc);

DataStream<EnrichedOrder> enriched = orders
        .connect(dimBroadcast)
        .process(new BroadcastProcessFunction<OrderEvent, ShopDim, EnrichedOrder>() {
            @Override
            public void processElement(OrderEvent o, ReadOnlyContext ctx,
                                       Collector<EnrichedOrder> out) throws Exception {
                ShopDim dim = ctx.getBroadcastState(dimDesc).get(o.shopId);
                out.collect(EnrichedOrder.of(o, dim));   // dim 可能为 null，见下文
            }

            @Override
            public void processBroadcastElement(ShopDim d, Context ctx,
                                                Collector<EnrichedOrder> out) throws Exception {
                if (d.deleted) {
                    ctx.getBroadcastState(dimDesc).remove(d.shopId);
                } else {
                    ctx.getBroadcastState(dimDesc).put(d.shopId, d);
                }
            }
        })
        .uid("order-enrich-broadcast");
```

- 广播状态在每个并行实例上各存一份全量，维表 10 万行、并行度 32 就是 320 万行的内存与 checkpoint 体积，只适合小维表。
- 作业启动时，事实流可能先于维表流到达，关联出 null。处理办法：维表未加载完成前把事实数据缓存在 keyed state 中延后处理，或把关联不上的数据输出到侧输出流稍后补偿。
- 广播流的顺序在各并行实例间不保证一致，维度更新不要依赖「先 A 后 B」的跨 key 顺序。

---

## 小结

- 实时 GMV：先按订单号去重，再用 `CUMULATE` 做当日累计、每分钟输出；以事件时间统计、结果按主键 upsert，迟到数据由离线校准
- 实时风控：CEP 适合结构稳定的时序模式，`within` 控制状态边界，`skipPastLastEvent` 避免重复告警；告警至少一次投递、下游幂等
- 实时数仓：ODS 用 Flink CDC 整库入湖，DWD / DWS 用 Flink SQL 流式加工；Kafka 换秒级延迟，Paimon 换可查询、可回溯与低成本，常见做法是两者组合
- Paimon 下游要流读时配置 `changelog-producer`，汇总层可用聚合合并引擎写入即合并
- 维表关联：大维表用 Lookup + 缓存 + 异步，按事件时间关联用 Temporal Join，小维表用 Broadcast State；维度晚到用 `lookup_miss` 重试或侧输出补偿

## 参考资料

- FlinkCEP（2.3）：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/)
- 窗口 TVF：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/window-tvf/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/window-tvf/)
- Join：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/joins/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/table/sql/queries/joins/)
- Apache Paimon：[https://paimon.apache.org/docs/master/](https://paimon.apache.org/docs/master/)
- Flink CDC Pipeline 连接器：[https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/connectors/pipeline-connectors/overview/](https://nightlies.apache.org/flink/flink-cdc-docs-release-3.6/docs/connectors/pipeline-connectors/overview/)

> 返回：[Flink 总览](./0_overview)

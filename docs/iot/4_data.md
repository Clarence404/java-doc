---
description: EMQX 转发 Kafka、Flink 2.x 告警与离线检测、TDengine 超表、降采样与保留、Grafana
---

# 数据处理

> 前置阅读：[时序数据库](/nosql/4_time_series_db)、[Flink 总览](/flink/0_overview)、[通信协议](./1_protocol)

IoT 数据链路把设备经 MQTT 上报的数据转发、处理、存储并可视化。本篇讲 EMQX 转发 Kafka、Flink 清洗与告警、TDengine 超表、降采样与 Grafana，基线为 Flink 2.2。

---

## 一、IoT 数据链路

整条链路：设备经 MQTT 上报，EMQX 规则引擎转发到 Kafka，Flink 做清洗、窗口聚合与告警，结果写入 TDengine 超表，再用降采样控制存储、用 Grafana 出看板和告警。版本基线：EMQX 5.9+ / 6.x（配置为 5.x 起的 HOCON 语法）、Flink 2.2.x + `flink-connector-kafka:5.0.0-2.2`、TDengine 3.3.x / 3.4.x + `taos-jdbcdriver` 3.9.x、JDK 21 / Spring Boot 4。

### 1、IoT 数据的特点

| 特点 | 说明 | 对链路的影响 |
|------|------|-------------|
| 高频写入 | 每台设备每秒到每分钟上报一次，设备数从万到百万 | 写入路径要能批量、能削峰 |
| 时序性强 | 查询基本都是「某设备 / 某批设备 + 时间范围」 | 按设备分表、按时间分片 |
| 写多读少 | 绝大多数数据写进去后只会被聚合查询 | 原始数据短期保留，长期只留降采样结果 |
| 冷热分明 | 近几天的数据查得多，历史数据很少访问 | 分层保留，冷数据转低成本存储 |
| 乱序与断连 | 设备时钟不准、断网后补传 | 用设备时间戳 + 水位线，容忍乱序 |

### 2、整体链路

![IoT 数据链路](../assets/iot/iot-data-pipeline.svg)

| 环节 | 职责 | 为什么需要 |
|------|------|-----------|
| EMQX | 设备接入、认证、规则引擎做轻量过滤与格式转换 | Broker 擅长海量长连接，不适合做有状态计算 |
| Kafka | 缓冲、削峰、多消费者共享、故障后重放 | 设备批量重连或下游变慢时，消息不压垮 Broker，也不丢失 |
| Flink | 清洗、窗口聚合、离线检测、复杂事件告警 | 需要按设备保存状态和定时器，SQL 或规则引擎写不出来 |
| TDengine | 原始数据与降采样结果存储 | 一台设备一张子表，写入与时间范围查询都快 |
| Grafana | 看板与基于存储数据的阈值告警 | 运维与业务人员自助配置 |

设备规模在几千台以内、没有复杂计算时，可以省掉 Kafka 和 Flink，直接用 EMQX 规则引擎写入 TDengine（见二.4）；链路越长，运维成本越高，按需引入。

### 3、存储选型结论

选型细节见 [时序数据库](/nosql/4_time_series_db) 的「选型对比」，IoT 场景的结论是：

- 设备量大、schema 一致的工业 / 能源采集：TDengine 或 Apache IoTDB（树模型天然对应「工厂 → 设备 → 测点」）
- 团队已经重度使用 PostgreSQL、需要和业务表 JOIN：TimescaleDB
- 以运维监控指标为主：Prometheus 或 InfluxDB 3

本篇以 TDengine 为例。

---

## 二、MQTT 到 Kafka：EMQX 规则引擎

EMQX 5.9 起为统一的 BSL 1.1 版本，许可说明见 [平台选型](./2_platform)。

### 1、Topic 与消息约定

| 方向 | Topic | 说明 |
|------|-------|------|
| 设备上报遥测 | `devices/{deviceId}/telemetry` | QoS 1，JSON |
| 平台下发指令 | `devices/{deviceId}/cmd` | QoS 1 |
| 设备上下线 | `$events/client/connected`、`$events/client/disconnected` | EMQX 内置事件，只能在规则 SQL 中引用 |

遥测消息体约定带设备侧时间戳 `ts`（毫秒），后续按事件时间处理，补传的旧数据也能落到正确的时间窗口：

```json
{"ts": 1767225600000, "temp": 26.4, "hum": 61.2}
```

Topic 中的 `deviceId` 由 ACL 限定只能是连接自身的 `clientid`（见 [设备安全](./5_security)），所以下游可以信任规则 SQL 里取到的 `clientid`，不用信任消息体里自报的设备 ID。

### 2、规则 SQL

规则 SQL 负责字段裁剪和改名，载荷是 JSON 时可以直接用 `payload.字段` 取值：

```sql
SELECT
  clientid      AS deviceId,
  payload.ts    AS ts,
  payload.temp  AS temperature,
  payload.hum   AS humidity
FROM "devices/+/telemetry"
WHERE is_not_null(payload.temp)
```

规则引擎只做无状态的过滤与转换；需要「最近 N 条」「5 分钟窗口」之类状态的逻辑交给 Flink。

### 3、Kafka Sink 配置要点

在 Dashboard 的「集成 → Sink」里创建 Kafka Producer 连接器和动作，并挂到上面的规则：

| 配置项 | 建议值 | 原因 |
|--------|--------|------|
| Topic | `iot.telemetry` | 遥测、事件、指令回执分开 Topic，便于独立扩容 |
| Message Key | `${deviceId}` | 同一设备进同一分区，保证单设备有序 |
| Message Value | `${.}` | 整条规则输出（JSON） |
| 分区数 | 按峰值吞吐与 Flink 并行度规划 | Flink Source 并行度不应超过分区数 |
| 缓冲 | 开启内存 + 磁盘缓冲 | Kafka 短暂不可用时，EMQX 侧先缓冲，恢复后续传 |

5.9 之前，Kafka 等数据集成属于 EMQX 企业版功能，开源版没有；5.9 起统一为一个版本。Kafka 本身的分区与可靠性配置见 [Kafka 架构与存储](/messaging/2_kafka)，消费组见 [Kafka 生产与消费](/messaging/2_kafka_client)。

### 4、小规模：规则引擎直写 TDengine

EMQX 内置 TDengine Sink，规则输出可以直接拼成 `INSERT` 语句写入。适合设备数少、只需落库和简单阈值告警的场景；一旦需要离线检测、连续事件判断或多个下游消费同一份数据，再加入 Kafka + Flink。

---

## 三、TDengine 超表建模

时序数据库本身的存储模型、InfluxDB / TimescaleDB / IoTDB 的对比见 [时序数据库](/nosql/4_time_series_db)，本篇只讲 IoT 场景特有的建模。

### 1、超表与子表

TDengine 的核心约定是**一台设备一张子表，同类设备共用一张超表作模板**：

![TDengine 超表与子表](../assets/iot/tdengine-stable.svg)

| 概念 | 说明 |
|------|------|
| 超表（STable） | 定义采集列和 TAGS，是子表的模板，本身不存数据，查询超表等于跨子表聚合 |
| 子表 | 每台设备一张，数据按设备连续存放，写入和单设备时间范围查询都很快 |
| TAGS | 设备静态属性（设备 ID、型号、位置），存一份而不是每行都存，用于过滤和分组 |

TAGS 只放「设备是什么」，不放「设备测到什么」；位置、型号等属性变化时用 `ALTER TABLE ... SET TAG` 修改，不影响历史数据。

### 2、建库与建表

```sql
-- KEEP：数据保留天数；DURATION：每个数据文件覆盖的时间跨度
CREATE DATABASE IF NOT EXISTS iot_db KEEP 30 DURATION 1d PRECISION 'ms';

CREATE STABLE IF NOT EXISTS iot_db.sensors (
    ts          TIMESTAMP,
    temperature FLOAT,
    humidity    FLOAT
) TAGS (
    device_id   VARCHAR(64),
    product     VARCHAR(32),
    location    VARCHAR(64)
);

-- 显式建子表（也可以在写入时自动建表，见下文 Java 写入）
CREATE TABLE IF NOT EXISTS iot_db.d_dev001
    USING iot_db.sensors TAGS ('dev001', 'th-sensor', 'Shanghai-A1');

-- 设备搬迁：只改 TAG，不动历史数据
ALTER TABLE iot_db.d_dev001 SET TAG location = 'Shanghai-A2';
```

子表名加前缀（`d_`），避免设备 ID 以数字开头或与关键字冲突；TDengine 表名不允许 `-` 等字符（除非用反引号），所以设备 ID 进入表名前要先做白名单校验。

### 3、常用查询

```sql
-- 单设备最近 1 小时
SELECT ts, temperature, humidity
FROM iot_db.d_dev001
WHERE ts >= NOW - 1h;

-- 每台设备最近 10 分钟的均值与最大值：3.x 推荐 PARTITION BY tbname 按子表分组
SELECT tbname, device_id, AVG(temperature) AS avg_temp, MAX(temperature) AS max_temp
FROM iot_db.sensors
WHERE ts >= NOW - 10m
PARTITION BY tbname;

-- 每台设备的最新一条（实时看板）：LAST_ROW 走缓存时很快
SELECT tbname, device_id, LAST_ROW(ts) AS ts, LAST_ROW(temperature) AS temperature
FROM iot_db.sensors
PARTITION BY tbname;

-- 单设备 5 分钟窗口均值，空窗口用 NULL 填充（看板上能看到断点）
SELECT _wstart, AVG(temperature) AS avg_temp
FROM iot_db.d_dev001
WHERE ts >= NOW - 1h
INTERVAL(5m) FILL(NULL);
```

`LAST_ROW` 返回最后一行（列值可能为 NULL），`LAST` 返回每列最后一个非 NULL 值；看板展示最新读数时，设备会分字段上报就用 `LAST`。

### 4、Java 写入：WebSocket 连接 + 参数绑定

TDengine 官方已将原生连接（`jdbc:TAOS://`，依赖本机安装 taosc 客户端库）和 REST 连接标记为废弃，计划 2027-01-01 停止支持；Java 改用 WebSocket 连接（`jdbc:TAOS-WS://`，端口 6041，不需要客户端库）：

```xml
<dependency>
    <groupId>com.taosdata.jdbc</groupId>
    <artifactId>taos-jdbcdriver</artifactId>
    <version>3.9.2</version>
</dependency>
```

```yaml
spring:
  datasource:
    url: jdbc:TAOS-WS://tdengine:6041/iot_db
    driver-class-name: com.taosdata.jdbc.ws.WebSocketDriver
    username: ${TDENGINE_USER}
    password: ${TDENGINE_PASSWORD}
    hikari:
      maximum-pool-size: 8
```

写入用参数绑定：子表名 `tbname` 作为一个绑定列，配合 TAG 列即可「不存在就自动建表」。设备 ID 不拼接进 SQL，同时做白名单校验，因为它最终会成为表名：

```java
import java.sql.Timestamp;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

public record Telemetry(String deviceId, long ts, double temperature, double humidity) {}

@Repository
public class TelemetryWriter {

    private static final Pattern DEVICE_ID = Pattern.compile("^[A-Za-z0-9_]{1,60}$");
    // 未列出的 TAG（product、location）为 NULL，由设备台账同步时 SET TAG 补齐
    private static final String SQL = """
            INSERT INTO sensors (tbname, device_id, ts, temperature, humidity)
            VALUES (?, ?, ?, ?, ?)""";

    private final JdbcTemplate jdbc;

    public TelemetryWriter(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void writeBatch(List<Telemetry> batch) {
        List<Telemetry> valid = batch.stream()
                .filter(t -> DEVICE_ID.matcher(t.deviceId()).matches())
                .toList();
        jdbc.batchUpdate(SQL, valid, valid.size(), (ps, t) -> {
            ps.setString(1, "d_" + t.deviceId());
            ps.setString(2, t.deviceId());
            ps.setTimestamp(3, new Timestamp(t.ts()));
            ps.setFloat(4, (float) t.temperature());
            ps.setFloat(5, (float) t.humidity());
        });
    }
}
```

- **批量写**：单条写入的网络往返是瓶颈，攒几百到几千行一批再提交
- **重复写入天然幂等**：同一子表同一 `ts` 再写一次会覆盖原值，所以上游至少一次投递、重放 Kafka 都不会产生重复行
- **校验不通过的数据**：记日志或写入死信 Topic，不要静默丢弃

---

## 四、Flink 2.x 实时处理

Flink 在这条链路里只做三件事：按设备做窗口聚合、离线检测和连续异常告警，结果写入 TDengine。`KafkaSource`、水位线、窗口函数、定时器与 Sink V2 的通用写法见 [Flink 总览](/flink/0_overview) 模块，本节只讲 IoT 场景下的取舍。

### 1、读取 Kafka 与事件时间

用 `KafkaSource` + `fromSource` 读 `iot.telemetry`，时间戳取设备上报的 `ts`（`Telemetry` 即上文的 record，字段名与规则 SQL 的输出一致），写法见 [DataStream API · KafkaSource](/flink/2_datastream#_2、kafkasource)。设备数据的水位线有三点要按 IoT 特点设置：

- **乱序容忍取 10 秒左右**：`forBoundedOutOfOrderness(Duration.ofSeconds(10))` 覆盖设备时钟偏差与网络抖动；设得太大会拖慢所有窗口的输出
- **一定要配 `withIdleness`**：部分设备集中在少数 Kafka 分区，夜间或分批停机时某些分区长时间没数据，不配空闲检测水位线会被卡住，见 [时间、水位线与窗口 · 空闲检测](/flink/3_time_window#_4、空闲检测-idleness)
- **断网补传的数据**：晚于水位线太多会被窗口丢弃；需要保留时用侧输出收集迟到数据再补算或直接落库，见 [时间、水位线与窗口 · 迟到数据](/flink/3_time_window#三、迟到数据)

### 2、窗口聚合：5 分钟均温超限

按 `deviceId` 分组，开 5 分钟事件时间滚动窗口，用 `AggregateFunction` 增量累加 `[sum, count]`（不缓存窗口内原始数据），再用 `ProcessWindowFunction` 补上设备 ID 与窗口结束时间，最后 `filter(avg > 80)` 输出告警候选。增量聚合与全量聚合的组合写法见 [时间、水位线与窗口 · 窗口函数](/flink/3_time_window#五、窗口函数)。

同一个窗口顺便算出 `max / min / count`，就能直接作为降采样结果写库，见五.3。

### 3、离线检测：KeyedProcessFunction + 定时器

「90 秒内没有数据就告警」本质是「每来一条数据就把定时器往后推」，用 `KeyedProcessFunction` 最直接：

```java
public record DeviceStatus(String deviceId, String status, long ts) {}

public class OfflineDetector extends KeyedProcessFunction<String, Telemetry, DeviceStatus> {

    private static final long TIMEOUT_MS = Duration.ofSeconds(90).toMillis();  // 约 3 倍上报周期
    private transient ValueState<Long> timerState;
    private transient ValueState<Boolean> offlineState;

    @Override
    public void open(OpenContext openContext) {
        timerState = getRuntimeContext().getState(new ValueStateDescriptor<>("offline-timer", Types.LONG));
        offlineState = getRuntimeContext().getState(new ValueStateDescriptor<>("offline", Types.BOOLEAN));
    }

    @Override
    public void processElement(Telemetry t, Context ctx, Collector<DeviceStatus> out) throws Exception {
        Long oldTimer = timerState.value();
        if (oldTimer != null) {
            ctx.timerService().deleteProcessingTimeTimer(oldTimer);
        }
        long fireAt = ctx.timerService().currentProcessingTime() + TIMEOUT_MS;
        ctx.timerService().registerProcessingTimeTimer(fireAt);
        timerState.update(fireAt);

        if (Boolean.TRUE.equals(offlineState.value())) {      // 离线后重新上报
            offlineState.clear();
            out.collect(new DeviceStatus(ctx.getCurrentKey(), "ONLINE", t.ts()));
        }
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<DeviceStatus> out) throws Exception {
        timerState.clear();
        offlineState.update(true);
        out.collect(new DeviceStatus(ctx.getCurrentKey(), "OFFLINE", timestamp));
    }
}

// 作业中：telemetry.keyBy(Telemetry::deviceId).process(new OfflineDetector()).uid("offline-detector");
```

- **为什么用处理时间定时器**：设备不发数据时不会推动事件时间，所有设备同时断网（如机房断电）时水位线整体停住，事件时间定时器永远不触发
- **为什么不用 CEP**：「没有发生某事」CEP 表达不了，见 [实战场景 · 连续性与量词](/flink/8_scenarios#_3、连续性与量词)
- **与 EMQX 上下线事件互补**：`$events/client/disconnected` 只说明 TCP 连接断了；连接还在但不再上报（采集模块死机）只能靠这里的数据超时检测
- **定时器成本**：上报频率很高时，把 `fireAt` 向上取整到秒，只有取整值变化时才重新注册

### 4、连续超温：CEP

「连续 3 次采集都超过 80°C」是有顺序的事件模式，用 CEP：

```java
Pattern<Telemetry, ?> overheat = Pattern
        .<Telemetry>begin("hot", AfterMatchSkipStrategy.skipPastLastEvent())
        .where(SimpleCondition.of(t -> t.temperature() > 80.0))
        .times(3).consecutive()              // 严格相邻：中间夹一条正常读数就不算
        .within(Duration.ofMinutes(5));       // 部分匹配最多保留 5 分钟，控制状态大小
```

按 `deviceId` 分区后交给 `CEP.pattern`，在 `PatternProcessFunction` 里取 `hot` 的最后一条输出告警。最常见的错误是漏写 `consecutive()`：`times(3)` 默认宽松连续，「5 条里有 3 条超温」也会告警；其余写法与连续性对比见 [实战场景 · 连续性与量词](/flink/8_scenarios#_3、连续性与量词)。

### 5、写入 TDengine：Sink V2

Flink 2.x 没有官方 TDengine Sink，按 Sink V2 写一个 `SinkWriter` 即可：`write` 里沿用三.4 的参数绑定批量写入（设备 ID 先过白名单再拼子表名），攒满一批或在 `flush`（Checkpoint 前调用）时 `executeBatch`。这样是至少一次，配合 TDengine「同一子表同一 `ts` 覆盖写」，从 Checkpoint 重放不会产生重复行；写入失败直接抛异常，让作业按重启策略恢复。Sink V2 的结构见 [DataStream API · Sink V2 的结构](/flink/2_datastream#_1、sink-v2-的结构)，幂等 Sink 的原理见 [状态与容错 · 幂等 Sink：更简单的选择](/flink/4_state_checkpoint#_3、幂等-sink-更简单的选择)。

---

## 五、降采样与数据保留

### 1、分层保留

原始数据量大但很快就不再查询，常见做法是**按精度分库，各库设置不同的 `KEEP`**：

| 数据层 | 精度 | 保留 | 用途 |
|--------|------|------|------|
| 原始数据 `iot_db` | 设备上报原样 | 7–30 天 | 故障回溯、明细查询 |
| 5 分钟聚合 `iot_db_5m` | 均值 / 最大 / 最小 / 条数 | 1 年 | 日、周趋势看板 |
| 1 小时聚合 `iot_db_1h` | 同上 | 3–5 年 | 年度报表、同比环比 |

存储估算：日写入量 = 设备数 × 每设备每日上报条数 × 每行字节数 ÷ 压缩比，乘以保留天数即为该层容量。原始层通常占总容量的绝大部分，所以缩短原始层的 `KEEP` 是最有效的降本手段。

聚合层一定要同时存 `count`：「这 5 分钟只有 2 条数据」本身就是设备异常的信号，只存均值会把它掩盖掉。

### 2、TDengine 流计算降采样

TDengine 自带流计算，可以在库内持续把原始数据聚合到降采样表。3.3.7 起流计算改为新语法（触发方式写在 `CREATE STREAM` 中，查询用 `%%trows` 引用触发窗口内的数据），与 3.3.6 及以前的写法不同，示例按新语法：

```sql
CREATE STREAM IF NOT EXISTS iot_db_5m.s_sensors_5m
  INTERVAL(5m) SLIDING(5m) FROM iot_db.sensors PARTITION BY tbname
  INTO iot_db_5m.sensors_5m
  AS SELECT _twstart AS ts,
            AVG(temperature) AS avg_temp,
            MAX(temperature) AS max_temp,
            MIN(temperature) AS min_temp,
            COUNT(*)         AS cnt
     FROM %%trows;
```

`PARTITION BY tbname` 让每台设备各自开窗并写入输出超表的独立子表。流计算的触发类型、迟到数据处理和输出表规则在不同小版本间仍有调整，上线前以所用版本的「流计算」文档为准。

### 3、在 Flink 中降采样

如果 Flink 作业已经在做窗口聚合（如四.2），把 5 分钟窗口的 `avg / max / min / count` 一并写到 `iot_db_5m`，可以省掉库内流计算，也便于和告警共用同一份窗口结果。两种方式选一种，不要两边同时算，否则会出现口径不一致。

---

## 六、可视化与告警

告警使用 Grafana 统一告警（Grafana Alerting）。

### 1、Grafana 看板

Grafana 通过 TDengine 官方数据源插件直接用 SQL 查询；看板上常用的几类面板：

| 面板 | 查询要点 |
|------|----------|
| 设备实时读数（Stat / Gauge） | `LAST_ROW` + `PARTITION BY tbname`，配合 `$device` 变量 |
| 温度趋势（Time series） | `INTERVAL($__interval)` 按时间范围自动选粒度；查询范围超过几天时改查 `iot_db_5m` |
| 在线率（Bar gauge） | 读取 Flink 写出的 `DeviceStatus` 结果表 |
| 告警列表（Table） | 读取业务告警表 |

长时间范围的趋势图一定要查降采样库，否则一次刷新就会扫描海量原始数据。

### 2、统一告警规则

Grafana 9 起统一使用 Grafana Alerting，旧版面板告警（`IS ABOVE 80` 那套写法）已不再使用。一条告警规则由三部分组成：

| 步骤 | 作用 | 示例 |
|------|------|------|
| Query | 查出每台设备的时间序列 | `SELECT _wstart, AVG(temperature) FROM iot_db.sensors WHERE ts >= NOW - 5m PARTITION BY device_id INTERVAL(1m)` |
| Reduce 表达式 | 把每条序列压成一个值 | `Last` 或 `Mean` |
| Threshold 表达式 | 与阈值比较 | `> 80` |

其他关键配置：

| 配置项 | 说明 |
|--------|------|
| Pending period | 条件需持续多久才从 Pending 进入 Alerting，如 `2m`，过滤瞬时抖动 |
| No data 处理 | 默认进入 No Data 状态；可选 Alerting、Normal、Keep last state。「设备停报」类规则设为 Alerting |
| Error 处理 | 查询出错时的状态，可选 Error、Alerting、Normal、Keep last state |
| Labels | 如 `severity=critical`、`team=iot`，由通知策略按标签路由 |

告警实例的状态流转：Normal → Pending → Alerting，条件解除后回到 Normal 并发送恢复通知。

### 3、通知与回调

联系人（Contact point）直接选 **DingDing** 类型，填钉钉机器人地址即可，不需要用 Webhook 自己拼钉钉的消息 JSON；通知策略（Notification policy）按 `severity` 等标签把告警路由到不同联系人，并设置分组等待、分组间隔与重复间隔。

需要把告警写入自家工单 / 告警系统时，再加一个 **Webhook** 联系人回调后端，并在联系人上配置 Authorization 头凭据。接收端要校验凭据，并按 `fingerprint` 幂等处理（同一告警会重复通知）：

```java
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

// 以下三个类型分属不同文件
public record GrafanaAlert(String status, String fingerprint, Map<String, String> labels,
                           Map<String, String> annotations, Instant startsAt, Instant endsAt) {}

public record GrafanaWebhook(String status, List<GrafanaAlert> alerts) {}

@RestController
@RequestMapping("/api/grafana")
public class GrafanaAlertController {

    private static final Logger log = LoggerFactory.getLogger(GrafanaAlertController.class);
    private final AlarmService alarmService;       // 业务告警服务：按 fingerprint 幂等开 / 关告警
    private final byte[] expectedAuth;

    public GrafanaAlertController(AlarmService alarmService,
                                  @Value("${alert.grafana-webhook-token}") String token) {
        this.alarmService = alarmService;
        this.expectedAuth = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
    }

    @PostMapping("/alert")
    public ResponseEntity<Void> receive(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String auth,
                                        @RequestBody GrafanaWebhook body) {
        if (auth == null || !MessageDigest.isEqual(expectedAuth, auth.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(401).build();
        }
        for (GrafanaAlert alert : body.alerts()) {
            String deviceId = alert.labels().get("device_id");
            if ("firing".equals(alert.status())) {
                log.warn("告警触发：设备 {}，{}", deviceId, alert.annotations().get("summary"));
                alarmService.open(alert.fingerprint(), deviceId, alert.annotations());
            } else {
                alarmService.close(alert.fingerprint());
            }
        }
        return ResponseEntity.noContent().build();
    }
}
```

`MessageDigest.isEqual` 做常量时间比较，避免按响应耗时逐字节猜出凭据。

### 4、告警放在哪一层

| 告警类型 | 放在 | 原因 |
|----------|------|------|
| 离线、连续超温、多条件组合 | Flink | 需要按设备的状态和定时器，秒级延迟 |
| 单指标阈值、趋势类 | Grafana | 运维自助配置，不用发版 |
| 设备连接断开 | EMQX 规则引擎（`$events/client/disconnected`） | 事件源头就在 Broker |
| 设备联动、需要关联业务数据（工单、设备模型、权限）的单点判断 | 自研规则引擎，见 [规则引擎](./11_rule_engine) | 规则由业务人员配置，动作要调用业务系统 |

同一个告警只在一层产生，四层的告警再统一汇入同一个告警服务做去重、抑制和升级，避免同一故障从多个渠道各报一次。

---

## 小结

- 链路：设备 → EMQX 规则引擎 → Kafka → Flink 2.x → TDengine → Grafana；规模小时用 EMQX 直写 TDengine，按需加组件
- Topic 中的设备 ID 由 ACL 绑定到 `clientid`，下游以 `clientid` 作为可信设备标识，Kafka 消息 Key 用设备 ID 保证单设备有序
- TDengine 一台设备一张子表，TAG 放静态属性；写入用 WebSocket 连接 + 参数绑定，设备 ID 进入表名前做白名单校验；同 `ts` 覆盖写使重放幂等
- Flink 2.x 用 `KafkaSource`、`Duration`、Sink V2；离线检测用处理时间定时器而不是 CEP，连续超温用 `times(3).consecutive()`
- 原始数据短期保留，降采样结果长期保留并带上 `count`；降采样在 TDengine 流计算或 Flink 中二选一
- Grafana 统一告警按 Query → Reduce → Threshold 配置，钉钉用原生 DingDing 联系人；Webhook 回调要鉴权并按 fingerprint 幂等

## 参考资料

- EMQX 规则引擎：[https://docs.emqx.com/en/emqx/latest/data-integration/rules.html](https://docs.emqx.com/en/emqx/latest/data-integration/rules.html)
- EMQX 规则 SQL 事件与字段：[https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html](https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html)
- EMQX 许可 FAQ：[https://www.emqx.com/en/content/license-faq](https://www.emqx.com/en/content/license-faq)
- TDengine Java 连接器：[https://docs.tdengine.com/developer-guide/connectors-reference/java/](https://docs.tdengine.com/developer-guide/connectors-reference/java/)
- TDengine 流计算语法：[https://docs.tdengine.com/stream-processing/syntax/](https://docs.tdengine.com/stream-processing/syntax/)
- taos-jdbcdriver（Maven Central）：[https://central.sonatype.com/artifact/com.taosdata.jdbc/taos-jdbcdriver](https://central.sonatype.com/artifact/com.taosdata.jdbc/taos-jdbcdriver)
- Flink CEP：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/)
- Flink ProcessFunction：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/process_function/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/process_function/)
- Grafana 告警状态与健康：[https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/state-and-health/](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/state-and-health/)
- Grafana 联系人：[https://grafana.com/docs/grafana/latest/alerting/fundamentals/notifications/contact-points/](https://grafana.com/docs/grafana/latest/alerting/fundamentals/notifications/contact-points/)

> 下一篇：[设备安全](./5_security) —— 一机一密、X.509 与 mTLS、EMQX 认证授权、审计与零信任落地。

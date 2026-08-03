# IoT 数据处理

> 参考资料：
> * InfluxDB 文档：[https://docs.influxdata.com/](https://docs.influxdata.com/)
> * TDengine 文档：[https://docs.taosdata.com/](https://docs.taosdata.com/)
> * Grafana：[https://grafana.com/docs/](https://grafana.com/docs/)

## 一、IoT 数据的特点

| 特点 | 说明 |
|------|------|
| **高频写入** | 传感器每秒/每分钟上报，写入量极大 |
| **时序性强** | 数据天然按时间排列，查询多为时间范围查询 |
| **读少写多** | 大量写入，查询集中在最近时段 |
| **数据冷热分明** | 近期数据频繁查询，历史数据逐渐冷却 |
| **聚合计算多** | 平均值、最大值、趋势、同比环比 |

→ 普通关系型数据库（MySQL）不适合存储 IoT 数据，**时序数据库（TSDB）** 是首选。

## 二、时序数据库

### InfluxDB

- **定位**：最流行的开源时序数据库，生态最完整
- **技术栈**：Go（InfluxDB 2.x 自带查询引擎 Flux）
- **存储模型**：Measurement（表）→ Tag（索引维度）→ Field（数据值）→ Timestamp
- **生态**：原生集成 Grafana、Telegraf（采集器）、Kapacitor（告警引擎）
- **适合**：中小规模 IoT，监控指标，运维数据
- 官网：[https://www.influxdata.com](https://www.influxdata.com)

```sql
-- InfluxQL 示例：查询最近 1 小时设备温度均值
SELECT MEAN("temperature") FROM "sensors"
WHERE "device_id" = 'device-001'
AND time >= now() - 1h
GROUP BY time(5m)
```

### TDengine

- **定位**：国产高性能时序数据库，专为 IoT 场景优化
- **技术特点**：超表（STable）概念，按设备分表存储，写入性能极高
- **SQL 兼容**：支持标准 SQL，学习成本低
- **生态**：内置订阅（类 Kafka）、缓存、流计算功能
- **适合**：大规模工业 IoT，国内项目，万级以上设备量
- 官网：[https://www.taosdata.com](https://www.taosdata.com)

```sql
-- TDengine：创建超表（模板表）
CREATE STABLE sensors (ts TIMESTAMP, temperature FLOAT, humidity FLOAT)
TAGS (device_id NCHAR(64), location NCHAR(64));

-- 查询每台设备最近 10 分钟的平均温度
SELECT device_id, AVG(temperature) FROM sensors
WHERE ts >= NOW - 10m GROUP BY device_id;
```

### TimescaleDB

- **定位**：基于 PostgreSQL 的时序数据库扩展
- **优势**：完全兼容 PostgreSQL，可复用 ORM 和现有 SQL 工具链
- **适合**：团队熟悉 PostgreSQL，不想引入新数据库
- 官网：[https://www.timescale.com](https://www.timescale.com)

### TSDB 横向对比

| 数据库 | 写入性能 | SQL 支持 | 生态 | 适合规模 |
|--------|---------|---------|------|---------|
| **InfluxDB** | 高 | 类 SQL（Flux） | 最成熟 | 中小规模 |
| **TDengine** | 极高 | 标准 SQL | 国内活跃 | 大规模工业 |
| **TimescaleDB** | 中 | 完整 PostgreSQL | PostgreSQL 生态 | 已有 PG 的项目 |

---

## 三、数据流处理

IoT 数据往往需要实时计算（告警、聚合、异常检测），常用流处理框架：

### Apache Flink 在 IoT 中的应用

数据链路：设备 → MQTT Broker → Kafka → Flink → 时序数据库 / 告警系统

| 场景 | Flink 处理方式 |
|------|--------------|
| 实时告警 | 滑动窗口聚合，温度超阈值触发告警 |
| 数据清洗 | 过滤异常值、补充缺失字段 |
| 指标聚合 | 每分钟统计各设备平均值 |
| 设备状态计算 | CEP（复杂事件处理）判断设备离线 |

```java
// Flink 示例：5 分钟窗口内温度告警
DataStream<SensorData> stream = env.addSource(new FlinkKafkaConsumer<>(...));

stream
    .keyBy(SensorData::getDeviceId)
    .window(TumblingProcessingTimeWindows.of(Time.minutes(5)))
    .aggregate(new AvgTemperatureAggregator())
    .filter(avg -> avg.getValue() > 80.0)  // 超过 80°C 告警
    .addSink(new AlertSink());
```

---

## 四、数据可视化

### Grafana

- IoT 数据可视化首选，原生支持 InfluxDB / TDengine / Prometheus
- 丰富的图表类型：时序折线、仪表盘、热力图、地理地图
- 告警规则配置，触发邮件 / 钉钉 / Webhook 通知

---

## 五、IoT 数据处理全链路

![IoT 数据处理全链路](../assets/iot/iot-data-pipeline.svg)

## 六、TDengine 超表实战

### 超表（STable）与子表（Table）概念

TDengine 的核心设计理念：**一台设备一张子表，超表是所有子表的模板**。

| 概念 | 说明 |
|------|------|
| **超表（STable）** | 定义公共列（采集字段）和 Tags（设备维度标签），是子表的模板，不存储实际数据 |
| **子表（Table）** | 每台设备对应一张子表，继承超表结构，实际写入和查询都针对子表 |
| **Tags** | 设备的静态属性（如设备 ID、位置、型号），作为索引用于快速过滤 |

这种设计让 TDengine 在写入时按设备分区，极大提升了并发写入和时间范围查询性能。

### 完整建表流程

```sql
-- 第一步：创建数据库（KEEP 数据保留天数，DURATION 每个数据文件跨越的天数）
CREATE DATABASE iot_db KEEP 365 DURATION 10;

-- 使用数据库
USE iot_db;

-- 第二步：创建超表（模板）
-- 普通列：时序采集字段；TAGS：设备静态属性
CREATE STABLE sensors (
    ts          TIMESTAMP,
    temperature FLOAT,
    humidity    FLOAT,
    voltage     FLOAT
) TAGS (
    device_id   NCHAR(64),
    location    NCHAR(64),
    device_type NCHAR(32)
);

-- 第三步：为每台设备创建子表（USING 指定超表，赋值 Tags）
CREATE TABLE device_001 USING sensors TAGS ('device_001', 'Shanghai-A1', 'temperature-sensor');
CREATE TABLE device_002 USING sensors TAGS ('device_002', 'Beijing-B2',  'humidity-sensor');

-- 也可以在写入时自动建表（推荐生产环境使用）
INSERT INTO device_003 USING sensors TAGS ('device_003', 'Shenzhen-C3', 'multi-sensor')
VALUES (NOW, 25.6, 60.1, 220.0);
```

### 常用查询

```sql
-- 查询单台设备最近 1 小时的数据
SELECT ts, temperature, humidity
FROM device_001
WHERE ts >= NOW - 1h
ORDER BY ts DESC;

-- 按设备聚合：查询所有设备最近 10 分钟的平均温度（超表查询）
SELECT device_id, AVG(temperature) AS avg_temp, MAX(temperature) AS max_temp
FROM sensors
WHERE ts >= NOW - 10m
GROUP BY device_id;

-- 时间窗口聚合：每 5 分钟统计一次 device_001 的温度均值
SELECT _wstart, AVG(temperature) AS avg_temp
FROM device_001
WHERE ts >= NOW - 1h
INTERVAL(5m);

-- LAST 函数：查询每台设备最新一条数据（实时看板常用）
SELECT device_id, LAST(temperature) AS last_temp, LAST(ts) AS last_time
FROM sensors
GROUP BY device_id;

-- 查询超过阈值的设备（结合标签过滤）
SELECT device_id, temperature, ts
FROM sensors
WHERE ts >= NOW - 5m AND temperature > 80.0;
```

### Java JDBC 接入

**Maven 依赖：**

```xml
<dependency>
    <groupId>com.taosdata.jdbc</groupId>
    <artifactId>taos-jdbcdriver</artifactId>
    <version>3.3.0</version>
</dependency>
```

**连接与写入示例：**

```java
import java.sql.*;
import java.util.Properties;

public class TDengineExample {

    private static final String URL = "jdbc:TAOS://localhost:6030/iot_db";

    public static Connection getConnection() throws SQLException {
        Properties props = new Properties();
        props.setProperty("user", "root");
        props.setProperty("password", "taosdata");
        return DriverManager.getConnection(URL, props);
    }

    // 写入单条数据
    public static void insert(String deviceId, float temperature, float humidity) {
        String sql = "INSERT INTO " + deviceId
                + " USING sensors TAGS ('" + deviceId + "', 'unknown', 'sensor')"
                + " VALUES (NOW, ?, ?, ?)";
        try (Connection conn = getConnection();
             PreparedStatement pstmt = conn.prepareStatement(sql)) {
            pstmt.setFloat(1, temperature);
            pstmt.setFloat(2, humidity);
            pstmt.setFloat(3, 220.0f);
            pstmt.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException("TDengine 写入失败", e);
        }
    }

    // 批量写入（推荐：减少网络往返）
    public static void batchInsert(List<SensorData> dataList) {
        StringBuilder sb = new StringBuilder("INSERT INTO ");
        for (SensorData d : dataList) {
            sb.append(d.getDeviceId())
              .append(" USING sensors TAGS ('").append(d.getDeviceId()).append("', 'loc', 'sensor') VALUES (")
              .append(d.getTimestamp()).append(", ")
              .append(d.getTemperature()).append(", ")
              .append(d.getHumidity()).append(", 220.0) ");
        }
        try (Connection conn = getConnection();
             Statement stmt = conn.createStatement()) {
            stmt.executeUpdate(sb.toString());
        } catch (SQLException e) {
            throw new RuntimeException("TDengine 批量写入失败", e);
        }
    }

    // 查询最新值
    public static void queryLatest() {
        String sql = "SELECT device_id, LAST(temperature), LAST(ts) FROM sensors GROUP BY device_id";
        try (Connection conn = getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                System.out.printf("设备：%s，最新温度：%.1f°C，时间：%s%n",
                        rs.getString("device_id"),
                        rs.getFloat(2),
                        rs.getTimestamp(3));
            }
        } catch (SQLException e) {
            throw new RuntimeException("TDengine 查询失败", e);
        }
    }
}
```

**Spring Boot 集成（application.yml）：**

```yaml
spring:
  datasource:
    url: jdbc:TAOS://localhost:6030/iot_db
    username: root
    password: taosdata
    driver-class-name: com.taosdata.jdbc.TSDBDriver
```

---

## 七、Flink 复杂事件处理（CEP）

### CEP 适用场景

Flink CEP（Complex Event Processing）用于从事件流中检测符合特定时序模式的事件组合：

| 场景 | 模式描述 |
|------|---------|
| **设备离线检测** | 30 秒内没有收到设备心跳 → 触发离线告警 |
| **连续超温告警** | 3 次连续采集温度均 > 80°C → 设备过热告警 |
| **异常波动检测** | 温度在 1 分钟内上升超过 20°C → 异常告警 |
| **设备重启检测** | 连续收到"离线"后紧接"上线"事件 → 设备重启 |

### Maven 依赖

```xml
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-cep</artifactId>
    <version>1.18.1</version>
</dependency>
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-streaming-java</artifactId>
    <version>1.18.1</version>
</dependency>
```

### 场景一：设备离线检测（30 秒无心跳）

```java
import org.apache.flink.cep.CEP;
import org.apache.flink.cep.PatternStream;
import org.apache.flink.cep.pattern.Pattern;
import org.apache.flink.cep.pattern.conditions.SimpleCondition;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.util.OutputTag;

// 设备事件类
@Data
public class DeviceEvent {
    private String deviceId;
    private String eventType; // "heartbeat" | "alarm"
    private double temperature;
    private long timestamp;
}

public class DeviceOfflineDetection {

    public static void detect(DataStream<DeviceEvent> stream) {

        // 定义模式：30 秒内只有一次心跳（没有后续心跳 = 超时 = 离线）
        Pattern<DeviceEvent, ?> offlinePattern = Pattern
                .<DeviceEvent>begin("heartbeat")
                .where(new SimpleCondition<DeviceEvent>() {
                    @Override
                    public boolean filter(DeviceEvent event) {
                        return "heartbeat".equals(event.getEventType());
                    }
                })
                .within(Time.seconds(30));  // 30 秒时间窗口

        // 按设备 ID 分流后应用 CEP 模式
        PatternStream<DeviceEvent> patternStream = CEP.pattern(
                stream.keyBy(DeviceEvent::getDeviceId),
                offlinePattern
        );

        // 定义超时输出标签
        OutputTag<DeviceEvent> timeoutTag = new OutputTag<DeviceEvent>("offline-devices") {};

        // 处理匹配结果（正常心跳）和超时事件（设备离线）
        SingleOutputStreamOperator<String> result = patternStream.flatSelect(
                timeoutTag,
                // 超时处理：30 秒内没有第二次心跳 → 离线告警
                (pattern, timestamp) -> {
                    DeviceEvent firstHeartbeat = pattern.get("heartbeat").get(0);
                    return "【离线告警】设备 " + firstHeartbeat.getDeviceId()
                            + " 超过 30 秒无心跳，最后心跳时间：" + firstHeartbeat.getTimestamp();
                },
                // 正常匹配处理
                (pattern, out) -> {
                    // 正常心跳，不需要处理
                }
        );

        // 获取超时（离线）事件流
        DataStream<String> offlineAlerts = result.getSideOutput(timeoutTag);
        offlineAlerts.print("离线告警");
    }
}
```

### 场景二：连续超温检测（3 次连续温度 > 80°C）

```java
public class ConsecutiveOverheatDetection {

    public static void detect(DataStream<DeviceEvent> stream) {

        // 定义模式：连续 3 次温度超过 80°C
        Pattern<DeviceEvent, ?> overheatPattern = Pattern
                .<DeviceEvent>begin("overheat")
                .where(new SimpleCondition<DeviceEvent>() {
                    @Override
                    public boolean filter(DeviceEvent event) {
                        return event.getTemperature() > 80.0;
                    }
                })
                .followedBy("overheat2")         // 紧接着（允许中间有其他事件）
                .where(new SimpleCondition<DeviceEvent>() {
                    @Override
                    public boolean filter(DeviceEvent event) {
                        return event.getTemperature() > 80.0;
                    }
                })
                .followedBy("overheat3")         // 再接着
                .where(new SimpleCondition<DeviceEvent>() {
                    @Override
                    public boolean filter(DeviceEvent event) {
                        return event.getTemperature() > 80.0;
                    }
                })
                .within(Time.minutes(5));         // 5 分钟内发生

        // 简化写法：使用 times() 重复次数
        Pattern<DeviceEvent, ?> overheatPatternShort = Pattern
                .<DeviceEvent>begin("overheat")
                .where(new SimpleCondition<DeviceEvent>() {
                    @Override
                    public boolean filter(DeviceEvent event) {
                        return event.getTemperature() > 80.0;
                    }
                })
                .times(3)                         // 连续出现 3 次
                .within(Time.minutes(5));

        PatternStream<DeviceEvent> patternStream = CEP.pattern(
                stream.keyBy(DeviceEvent::getDeviceId),
                overheatPatternShort
        );

        patternStream.select(matchedEvents -> {
            List<DeviceEvent> events = matchedEvents.get("overheat");
            DeviceEvent last = events.get(events.size() - 1);
            return String.format("【过热告警】设备 %s 连续 3 次温度超过 80°C，最新温度：%.1f°C",
                    last.getDeviceId(), last.getTemperature());
        }).print("过热告警");
    }
}
```

---

## 八、Grafana 告警规则配置

### 基本概念

Grafana Alerting 由三个核心组件构成：

| 组件 | 说明 |
|------|------|
| **Alert Rule（告警规则）** | 定义"什么条件触发告警"，包含数据查询和阈值判断 |
| **Contact Point（联系人）** | 定义"告警发送到哪里"，如钉钉 Webhook、邮件、Slack |
| **Notification Policy（通知策略）** | 定义"哪些告警发给哪个联系人"，支持分组、静默、抑制 |

告警状态流转：`Normal（正常）→ Pending（等待确认）→ Firing（触发）→ Resolved（恢复）`

### 配置步骤

#### 第一步：新建 Alert Rule

1. 进入 **Alerting → Alert Rules → New alert rule**
2. 选择数据源（InfluxDB / Prometheus / TDengine）
3. 编写查询语句：

```sql
-- InfluxQL：查询最近 5 分钟设备温度均值
SELECT MEAN("temperature") FROM "sensors"
WHERE "device_id" = 'device-001' AND $timeFilter
GROUP BY time(1m)
```

```
# PromQL：查询设备温度指标
avg_over_time(iot_device_temperature{device_id="device-001"}[5m])
```

#### 第二步：设置告警条件

在 **Conditions** 区域配置阈值：

| 配置项 | 示例值 | 说明 |
|--------|--------|------|
| **Condition** | IS ABOVE 80 | 均值超过 80 时触发 |
| **For** | 2m | 持续 2 分钟才真正触发（避免抖动） |
| **No Data** | NoData | 无数据时的告警状态 |
| **Error** | Alerting | 查询报错时的告警状态 |

#### 第三步：配置 Contact Point（钉钉 Webhook 示例）

1. 进入 **Alerting → Contact Points → New contact point**
2. 类型选择 **Webhook**
3. URL 填写钉钉机器人 Webhook 地址：`https://oapi.dingtalk.com/robot/send?access_token=xxx`

钉钉消息模板（在 Webhook 的 Message 字段填写 JSON）：

```json
{
  "msgtype": "markdown",
  "markdown": {
    "title": "Grafana 告警通知",
    "text": "### {{ .CommonAnnotations.summary }}\n\n**告警状态：** {{ .Status }}\n\n**触发时间：** {{ .StartsAt.Format \"2006-01-02 15:04:05\" }}\n\n**详情：**\n{{ range .Alerts }}\n- 设备：{{ .Labels.device_id }}，当前值：{{ .Annotations.value }}\n{{ end }}"
  },
  "at": {
    "isAtAll": false
  }
}
```

#### 第四步：配置 Notification Policy

1. 进入 **Alerting → Notification policies**
2. 编辑默认策略或新增策略：
   - **Matching labels**：填写标签过滤，如 `severity=critical` 发给运维群，`severity=warning` 发给开发群
   - **Contact point**：选择第三步创建的钉钉联系人
   - **Group wait**：首次告警等待 30s 再发送（等待同组其他告警一起发）
   - **Group interval**：同组告警合并发送间隔，建议 5m
   - **Repeat interval**：告警持续时重复通知间隔，建议 1h

### 常用告警场景配置

**场景一：设备温度超限**

```yaml
# Alert Rule 配置要点
name: 设备温度超限告警
condition: AVG(temperature) IS ABOVE 80
for: 2m
labels:
  severity: warning
  team: iot
annotations:
  summary: "设备 {{ $labels.device_id }} 温度超限"
  description: "设备 {{ $labels.device_id }} 最近 5 分钟平均温度为 {{ $values.A.Value | humanize }}°C，超过阈值 80°C"
```

**场景二：设备长时间无数据上报（NoData 检测）**

```yaml
# Alert Rule 配置要点
name: 设备数据上报中断告警
# 查询最近 5 分钟数据行数
condition: COUNT(temperature) IS BELOW 1
for: 5m
# 关键：将 No Data 状态设置为 Alerting
no_data_state: Alerting
labels:
  severity: critical
  team: iot
annotations:
  summary: "设备 {{ $labels.device_id }} 停止上报数据"
  description: "设备 {{ $labels.device_id }} 超过 5 分钟未上报数据，请检查设备连接状态"
```

**场景三：Grafana 告警与 Spring Boot 集成（接收 Webhook 推送）**

```java
@RestController
@RequestMapping("/api/grafana")
public class GrafanaAlertController {

    @PostMapping("/alert")
    public ResponseEntity<String> receiveAlert(@RequestBody GrafanaAlertPayload payload) {
        for (GrafanaAlert alert : payload.getAlerts()) {
            String deviceId = alert.getLabels().get("device_id");
            String status = alert.getStatus(); // "firing" | "resolved"

            if ("firing".equals(status)) {
                log.warn("Grafana 告警触发：设备 {}，摘要：{}", deviceId, alert.getAnnotations().get("summary"));
                // 写入告警记录到数据库
                alarmService.createAlarm(deviceId, alert);
            } else if ("resolved".equals(status)) {
                log.info("Grafana 告警恢复：设备 {}", deviceId);
                alarmService.resolveAlarm(deviceId);
            }
        }
        return ResponseEntity.ok("ok");
    }
}

// Grafana Webhook Payload 结构
@Data
public class GrafanaAlertPayload {
    private String status;           // "firing" | "resolved"
    private List<GrafanaAlert> alerts;
    private Map<String, String> commonLabels;
    private Map<String, String> commonAnnotations;
}

@Data
public class GrafanaAlert {
    private String status;
    private Map<String, String> labels;
    private Map<String, String> annotations;
    private String startsAt;
    private String endsAt;
}
```

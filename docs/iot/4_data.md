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

```
设备 → MQTT Broker → Kafka → Flink → 时序数据库 / 告警系统
```

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

```
InfluxDB / TDengine
        ↓
    Grafana
        ↓
  Dashboard 看板
  （折线图 / 仪表盘 / 告警）
```

---

## 五、IoT 数据处理全链路

```
传感器设备
    ↓ MQTT / Modbus
EMQX Broker
    ↓ 规则引擎转发
Kafka（缓冲高并发写入）
    ↓
Flink（实时流处理：清洗 / 聚合 / 告警）
    ↓                    ↓
TDengine / InfluxDB    告警服务 → 钉钉 / 短信
（时序存储）
    ↓
Grafana（可视化看板）
```

> [!warning]
> 待补充：TDengine 超表实战、Flink 复杂事件处理（CEP）、Grafana 告警规则配置

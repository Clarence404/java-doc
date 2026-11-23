---
description: 时序数据特点、TSDB 数据模型与共性机制、Prometheus 本地与长期存储、TDengine / IoTDB、选型
---

# 时序数据库概览

时序数据在写入路径、过期、压缩与聚合上需要专用存储。本篇讲时序数据的特点与通用模型、Prometheus 本地存储的定位、TDengine 与 IoTDB，以及 TSDB 选型，基线为 Prometheus 3。

---

## 一、时序数据与 TSDB 核心概念

### 1、时序数据的特点

| 特点 | 说明 |
|------|------|
| **写多读少，几乎不更新** | 数据按时间源源不断追加（append-only），历史数据写入后基本不改 |
| **时间是一等公民** | 所有查询都带时间范围；最近的数据最热，越老越冷 |
| **批量过期** | 数据按保留期整块删除（如「删掉 3 个月前的」），而不是逐行删 |
| **聚合为主** | 关心的是趋势（每分钟均值、P99），很少查单条原始点 |

### 2、为什么不用 MySQL 存时序数据

- **写入路径**：B+ 树的随机写和页分裂扛不住每秒百万级数据点；TSDB 普遍用 LSM / TSM / 列式追加等顺序写结构
- **过期删除**：MySQL `DELETE` 三个月前的数据是海量行删除（锁、binlog、碎片）；TSDB 按时间分区或分块，**整文件直接丢弃**
- **压缩比**：时序专用编码（时间戳 delta-of-delta、浮点 Gorilla XOR、RLE）能做到 10~20 倍压缩，通用行存做不到
- **聚合查询**：按时间窗口聚合（`GROUP BY time(1m)`、`time_bucket`）是 TSDB 的原生算子

### 3、数据模型

各家术语不同，但模型高度一致（以 InfluxDB 行协议为例）：

![时序数据模型](../assets/nosql/tsdb-data-model.svg)

| 概念 | InfluxDB | Prometheus | TDengine | 关系型类比 |
|------|----------|-----------|----------|-----------|
| 指标集合 | measurement（3.x 称 table） | metric name | 超级表 STable | 表 |
| 维度（索引） | tag | label | TAGS | 带索引的列 |
| 值 | field | value | 普通列 | 无索引的列 |
| 一条序列 | series | time series | 子表 | — |

### 4、三个共性机制

- **保留策略（Retention）**：按时间自动过期删除，建库时就要定（如原始数据留 30 天）
- **降采样（Downsampling）**：原始秒级数据聚合成分钟级 / 小时级长期保存，「近期细、久远粗」
- **高基数（High Cardinality）**：序列总数约等于各 tag 取值的组合数；把 user_id、订单号这类高基数字段放进 tag / label 会让索引膨胀，是所有 TSDB 的第一大坑

两款常用的通用时序库单独成篇：[InfluxDB](./9_influxdb) 讲三代版本差异与部署读写，[TimescaleDB](./10_timescaledb) 讲 PostgreSQL 扩展形态的 hypertable 与连续聚合。

---

## 二、Prometheus 的存储

Prometheus 是 CNCF 毕业的监控系统，采用**拉模型**（主动抓取目标的 `/metrics` 端点），当前主线为 3.x（2024 年 11 月发布 3.0，带来新版 UI、UTF-8 指标名、OTLP 接收与 Remote Write 2.0）。指标类型、PromQL、告警规则和 Spring Boot 接入属于可观测性范畴，见 [可观测性总览](/observability/0_overview)；这里只看它作为时序存储的特点。

### 1、本地 TSDB

- 数据先写 WAL 和内存 Head 块，每 2 小时落盘成一个不可变 Block，后台再合并成更大的 Block
- 默认保留 15 天（`--storage.tsdb.retention.time`），也可按容量限制（`--storage.tsdb.retention.size`）
- 单机、无副本：定位是**短期存储**，高可用靠部署两份相同配置的 Prometheus

### 2、长期存储

长期、大规模存储通过 `remote_write` 外接：

| 方案 | 思路 | 特点 |
|------|------|------|
| **VictoriaMetrics** | 兼容 PromQL 的独立 TSDB，接收 remote_write | 资源占用低、压缩比高，可直接替代 Prometheus 存储层 |
| **Thanos** | Sidecar 把本地 Block 上传对象存储，Query 层聚合多个 Prometheus | 保留 Prometheus 本体，适合多集群全局视图 |
| **Grafana Mimir** | Cortex 演进而来的水平扩展多租户存储 | 大规模多租户场景 |

单团队想省事选 VictoriaMetrics，多个 Kubernetes 集群需要全局查询选 Thanos。

---

## 三、国产 TSDB

### 1、TDengine

涛思数据开源的时序数据库，面向 IoT 和工业场景，社区版 AGPL 3.0，当前主线为 3.4.x（2026 年 1 月发布，3.3.x 升级到 3.4 不支持滚动升级，需停机整体升级）。

- **超级表（STable）**：一类设备一张超级表，每台设备一张子表，schema 一致，查询可跨子表聚合
- **写入性能**：官方基准测试给出的写入吞吐很高，实际以自身压测为准
- **时序函数**：`LAST_ROW`、时间窗口（`INTERVAL`）、插值（`FILL`）等
- **保留策略**：建库时用 `KEEP` 设置保留天数

```sql
-- 超级表（一类设备的模板）
CREATE STABLE meters (ts TIMESTAMP, current FLOAT, voltage INT, phase FLOAT)
  TAGS (location VARCHAR(64), groupid INT);

-- 子表（一台具体设备）
CREATE TABLE d1001 USING meters TAGS ('Beijing.Chaoyang', 2);

INSERT INTO d1001 VALUES (NOW, 10.3, 219, 0.31);

-- 跨设备聚合
SELECT location, AVG(current) FROM meters
WHERE ts > NOW - 1h
GROUP BY location;
```

IoT 场景下的超级表建模与数据链路见 [遥测数据链路](/iot/3_platform/2_data)。

### 2、Apache IoTDB

Apache 顶级项目，起源于清华大学，面向工业物联网，当前主线为 2.x。

- **树模型**：`root.plant.device.sensor` 层次化路径，对应工厂、设备、传感器的物理拓扑
- **表模型**：2.0 起新增，用关系表的方式组织设备数据，与树模型并存
- **TsFile**：自研列式文件格式，可被 Spark / Flink 直接读取
- **边云协同**：边缘节点轻量部署，数据同步到云端集群

```sql
-- 树模型示例
CREATE TIMESERIES root.plant1.device1.temperature WITH DATATYPE=FLOAT, ENCODING=RLE;

INSERT INTO root.plant1.device1(timestamp, temperature) VALUES (now(), 36.5);

-- 每 10 分钟平均温度
SELECT AVG(temperature) FROM root.plant1.device1
GROUP BY ([2024-01-01T00:00:00, 2024-01-02T00:00:00), 10m);
```

其他值得关注的开源时序库：GreptimeDB（Rust，指标 / 日志 / 事件统一存储）、QuestDB（SQL、高写入吞吐）。

---

## 四、选型对比

| 维度 | InfluxDB 3 | TimescaleDB | Prometheus（+VM） | TDengine | IoTDB |
|------|-----------|-------------|-------------------|----------|-------|
| 形态 | 独立 TSDB | **PG 扩展** | 监控系统（拉模型） | 独立 TSDB | 独立 TSDB |
| 开源协议 | MIT / Apache-2.0（Core） | Apache 2.0 + TSL | Apache 2.0 | AGPL 3.0 | Apache 2.0 |
| 查询语言 | SQL / InfluxQL | 标准 SQL（PG） | PromQL | SQL 方言 | SQL 扩展 |
| 开源集群 | 否（Enterprise） | 无自建多节点，靠 PG 副本或 Tiger Cloud | 联邦 / Thanos / VM 集群版 | 支持 | 支持 |
| 与业务表 JOIN | 不支持 | 支持 | 不支持 | 弱 | 弱 |
| 主要场景 | 通用时序 / DevOps | 已有 PG 栈的时序 | 监控告警 | IoT / 工业 | 工业 IoT / 边云协同 |

选型速记：

| 场景 | 推荐 |
|------|------|
| 系统监控告警 | Prometheus + Grafana，存储扛不住时接 VictoriaMetrics |
| 已有 PostgreSQL 技术栈 | TimescaleDB（免新组件，能 JOIN 业务表） |
| 工业 IoT / 设备采集 | TDengine（超级表贴合设备模型）或 IoTDB（边云协同、Hadoop 生态） |
| 通用时序、新建独立系统 | InfluxDB 3 |
| 数据量不大、已有 MongoDB | MongoDB 时间序列集合（5.0+），见 [MongoDB 集群与事务 · 时间序列集合](./4_mongodb_cluster#四、时间序列集合) |

---

## 小结

- 时序数据追加写、按时间聚合、整块过期，专用 TSDB 用顺序写结构、时序编码和按时间分块解决 MySQL 的写入、删除和压缩问题
- 各家模型高度一致：指标集合、带索引的维度、值、序列；保留策略与降采样是共性机制
- 高基数是所有 TSDB 的头号风险：不要把 user_id、订单号放进 tag / label
- Prometheus 本地存储默认保留 15 天、单机无副本，长期存储用 VictoriaMetrics / Thanos / Mimir；监控体系本身见可观测性模块
- 工业 IoT 优先看 TDengine（超级表）和 IoTDB 2.x（树模型 + 表模型）

## 参考资料

- Prometheus 存储：[https://prometheus.io/docs/prometheus/latest/storage/](https://prometheus.io/docs/prometheus/latest/storage/)
- TDengine 文档：[https://docs.tdengine.com/](https://docs.tdengine.com/)
- Apache IoTDB 文档：[https://iotdb.apache.org/UserGuide/latest/QuickStart/QuickStart.html](https://iotdb.apache.org/UserGuide/latest/QuickStart/QuickStart.html)

> 下一篇：[InfluxDB](./9_influxdb) —— 三代差异、1.x InfluxQL 与 TSI 索引、2.x Bucket 与 Token、3 的 SQL 与对象存储

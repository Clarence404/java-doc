---
description: 时序模型、InfluxDB、TimescaleDB、Prometheus 存储、TDengine / IoTDB、选型
---

# 时序数据库

> **本篇目标**：理解时序数据为什么需要专用存储（写入路径、过期、压缩、聚合），掌握 InfluxDB 三代版本的差异与部署要点、TimescaleDB 的 hypertable / 列存 / 连续聚合、Prometheus 本地存储的定位，能在 InfluxDB、TimescaleDB、TDengine、IoTDB 之间做选型。
>
> **前置阅读**：[列式与 OLAP 数据库](./0_column_db)（LSM 与列存）、[PostgreSQL 基础](../2_postgresql/0_overview)（TimescaleDB 部分）

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

![时序数据模型](../../assets/database/tsdb-data-model.svg)

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

---

## 二、InfluxDB

### 1、版本演进

InfluxDB 三代架构差异很大，几乎是三个产品：

| 特性 | InfluxDB 1.x | InfluxDB 2.x | InfluxDB 3 |
|------|--------------|--------------|------------|
| 实现 | Go | Go | Rust（原代号 IOx），2025 年 4 月 GA |
| 查询语言 | InfluxQL | Flux / InfluxQL | **SQL** / InfluxQL |
| 存储结构 | TSM | TSM | Parquet（内存中为 Arrow）+ 对象存储 |
| 计算存储分离 | 否 | 否 | 是 |
| 组织概念 | 数据库 + 保留策略 | Org / Bucket / Token | 数据库 + 表 |
| 开源版 | 单机，MIT | 单机，MIT | **3 Core**：单节点，MIT / Apache-2.0 |
| 商业版 | Enterprise 集群 | Cloud | **3 Enterprise**：多节点、压缩合并、长时间范围查询 |
| 适用 | 存量系统维护 | 存量系统维护 | 新项目 |

> Flux 已进入维护模式，3 不再支持 Flux；新项目不要在 Flux 上做重投入。

以下示例均为本地演示配置，密码与 Token 仅作示意；国内拉取镜像困难时可配置 Docker 镜像加速器，镜像名保持官方名称。

### 2、InfluxDB 1.x

```yaml
# docker-compose.yml（本地演示）
services:
  influxdb:
    image: influxdb:1.11
    container_name: influxdb
    environment:
      INFLUXDB_DB: mydb
      INFLUXDB_HTTP_AUTH_ENABLED: "true"
      INFLUXDB_ADMIN_USER: root
      INFLUXDB_ADMIN_PASSWORD: change-me-123
    ports:
      - "8086:8086"
    volumes:
      - ./influxdb_data:/var/lib/influxdb
    restart: always
```

在 `influx` 命令行中执行 InfluxQL：

```sql
CREATE DATABASE mydb
USE mydb

-- 行协议写入：measurement,tag=值 field=值
INSERT cpu,host=serverA value=0.64

-- 时间窗口聚合
SELECT MEAN(value) FROM cpu WHERE time > now() - 1h GROUP BY time(1m)

-- 保留策略：数据保留 30 天并设为默认
CREATE RETENTION POLICY "30d" ON mydb DURATION 30d REPLICATION 1 DEFAULT
```

1.x 默认使用内存索引（`inmem`），序列多时内存占用高；`tsi1` 是基于磁盘的索引，适合大量序列：

```toml
[data]
index-version = "tsi1"
```

修改后只对新建的 shard 生效，已有 shard 要停服后用 `influx_inspect buildtsi` 离线转换。

### 3、InfluxDB 2.x

2.x 官方镜像通过 `DOCKER_INFLUXDB_INIT_*` 变量完成首次初始化，数据目录是 `/var/lib/influxdb2`：

```yaml
services:
  influxdb2:
    image: influxdb:2.7
    container_name: influxdb2
    environment:
      DOCKER_INFLUXDB_INIT_MODE: setup
      DOCKER_INFLUXDB_INIT_USERNAME: admin
      DOCKER_INFLUXDB_INIT_PASSWORD: change-me-123
      DOCKER_INFLUXDB_INIT_ORG: my-org
      DOCKER_INFLUXDB_INIT_BUCKET: my-bucket
      DOCKER_INFLUXDB_INIT_RETENTION: 30d
      DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: my-super-secret-token
    ports:
      - "8086:8086"
    volumes:
      - ./influxdb2_data:/var/lib/influxdb2
      - ./influxdb2_config:/etc/influxdb2
    restart: always
```

2.x 用 Bucket（自带保留期）取代了 1.x 的「数据库 + 保留策略」，所有 API 调用都要带 Token：

```bash
curl -X POST "http://localhost:8086/api/v2/write?org=my-org&bucket=my-bucket&precision=s" \
  -H "Authorization: Token my-super-secret-token" \
  --data-raw "sensor,location=room1 temperature=25.3,humidity=60"
```

Flux 查询示例：

```text
from(bucket: "my-bucket")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "sensor" and r.location == "room1")
  |> aggregateWindow(every: 1m, fn: mean)
```

### 4、InfluxDB 3

InfluxDB 3 的关键变化：

- **列式存储 + 对象存储**：数据以 Parquet 落盘，可放在本地磁盘、S3 或兼容对象存储上
- **标准 SQL**：基于 Apache DataFusion 查询引擎，同时兼容 InfluxQL；写入兼容 1.x / 2.x 的行协议
- **默认开启 Token 认证**：所有写入和查询都需要 `Authorization: Bearer <token>`
- **3 Core 的限制**：没有时间范围的硬限制，但单次查询可读取的 Parquet 文件数受 `--query-file-limit`（默认 432）约束，按默认 10 分钟一个文件折算约 72 小时；Core 不做文件压缩合并，长时间范围的历史查询、压缩合并和多节点高可用属于 Enterprise

```yaml
services:
  influxdb3:
    image: influxdb:3-core
    container_name: influxdb3
    ports:
      - "8181:8181"
    volumes:
      - ./influxdb3_data:/var/lib/influxdb3
    command: >
      influxdb3 serve --node-id node0
      --object-store file --data-dir /var/lib/influxdb3
    restart: always
```

启动后先创建管理员 Token（只显示一次，妥善保存）：

```bash
docker exec influxdb3 influxdb3 create token --admin
export INFLUXDB3_TOKEN=<上一步输出的 token>
```

写入（数据库不存在时自动创建）与 SQL 查询：

```bash
curl -X POST "http://localhost:8181/api/v3/write_lp?db=mydb" \
  -H "Authorization: Bearer $INFLUXDB3_TOKEN" \
  --data-raw "sensor,location=lab temperature=23.5"

curl -G "http://localhost:8181/api/v3/query_sql" \
  -H "Authorization: Bearer $INFLUXDB3_TOKEN" \
  --data-urlencode "db=mydb" \
  --data-urlencode "q=SELECT * FROM sensor WHERE time > now() - interval '1 hour'"
```

本地快速试用也可以在 `serve` 时加 `--without-auth` 关闭认证，生产环境不要这样做。

---

## 三、TimescaleDB

TimescaleDB 是 **PostgreSQL 扩展**形态的时序数据库：不引入新组件、新语言，全部能力都是标准 SQL，还能和业务表 JOIN。开发公司 Timescale 于 2025 年 6 月更名为 **TigerData**（托管服务为 Tiger Cloud），扩展本身仍叫 TimescaleDB。

### 1、Hypertable

Hypertable 是按时间自动切分成 chunk 的分区表，写入和查询与普通表一样。2.20 起可以直接在建表时声明：

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE metrics (
    time        TIMESTAMPTZ      NOT NULL,
    device_id   INT              NOT NULL,
    temperature DOUBLE PRECISION
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'time',
    tsdb.chunk_interval   = '1 day',
    tsdb.segmentby        = 'device_id'
);
```

较早版本（2.13 ~ 2.19）先建普通表，再转换：

```sql
SELECT create_hypertable('metrics', by_range('time', INTERVAL '1 day'));
```

旧写法 `create_hypertable('metrics', 'time')` 仍可用，但已不推荐。

### 2、查询与 JOIN

```sql
SELECT d.name,
       time_bucket('5 minutes', m.time) AS bucket,
       avg(m.temperature)               AS avg_temp
FROM metrics m
JOIN devices d ON d.id = m.device_id
WHERE m.time > now() - INTERVAL '1 day'
GROUP BY d.name, bucket
ORDER BY bucket;
```

### 3、列存（Hypercore）与保留策略

2.18 起「压缩」改称**列存（columnstore，Hypercore 引擎）**：较老的 chunk 转为列式存储，压缩比通常在 10 倍以上，旧的 `compress` 系列参数与函数作为别名保留。

```sql
-- 2.20+ 用 CREATE TABLE ... WITH 建表时，默认已开启列存并自动创建列存策略；
-- 需要调整转换时机或手动建表时：
CALL add_columnstore_policy('metrics', after => INTERVAL '7 days');

-- 保留策略：90 天前的 chunk 整块删除
SELECT add_retention_policy('metrics', INTERVAL '90 days');
```

更早的版本用 `ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id')` 加 `add_compression_policy`。

### 4、连续聚合（降采样）

连续聚合是增量维护的物化视图，**必须添加刷新策略才会自动刷新**：

```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id,
       avg(temperature) AS avg_temp
FROM metrics
GROUP BY bucket, device_id;

-- 每小时刷新一次「3 小时前到 1 小时前」这段窗口
SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
```

### 5、许可与部署注意

- 列存 / 压缩、连续聚合、各类自动策略属于 **TSL（Timescale License）** 功能，只有 Apache 2.0 部分的构建（部分云厂商托管 PG 提供的版本）没有这些能力，选型前确认
- 自建多节点（multi-node）在 2.13 废弃、2.14 移除；横向扩展依赖 PG 自身的读副本或 Tiger Cloud
- 适合：已有 PostgreSQL 技术栈、时序数据要和业务数据 JOIN、团队只想写 SQL
- 不适合：单机每秒千万点级别的极端写入

---

## 四、Prometheus 的存储

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

## 五、国产 TSDB

### 1、TDengine

涛思数据开源的时序数据库，面向 IoT 和工业场景，社区版 AGPL 3.0，当前主线为 3.3.x。

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

IoT 场景下的超级表建模与数据链路见 [数据处理](/iot/4_data)。

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

## 六、选型对比

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
| 数据量不大、已有 MongoDB | MongoDB 时间序列集合（5.0+），见 [文档数据库](./2_document_db) |

---

## 小结

- 时序数据追加写、按时间聚合、整块过期，专用 TSDB 用顺序写结构、时序编码和按时间分块解决 MySQL 的写入、删除和压缩问题
- 高基数是所有 TSDB 的头号风险：不要把 user_id、订单号放进 tag / label
- InfluxDB 1.x / 2.x / 3 几乎是三个产品：2.x 镜像用 `DOCKER_INFLUXDB_INIT_*` 初始化、数据在 `/var/lib/influxdb2`；3 用 Parquet + 对象存储和 SQL，默认 Token 认证
- InfluxDB 3 Core 没有时间范围硬限制，但受 `--query-file-limit` 约束且不做压缩合并，长范围查询和多节点属于 Enterprise
- TimescaleDB（TigerData）：2.20 起 `CREATE TABLE ... WITH (tsdb.hypertable)`，列存用 `add_columnstore_policy`，连续聚合要配 `add_continuous_aggregate_policy` 才自动刷新；这些能力属于 TSL 许可
- Prometheus 本地存储默认保留 15 天、单机无副本，长期存储用 VictoriaMetrics / Thanos / Mimir；监控体系本身见可观测性模块
- 工业 IoT 优先看 TDengine（超级表）和 IoTDB 2.x（树模型 + 表模型）

## 参考资料

- InfluxDB 3 Core 文档：[https://docs.influxdata.com/influxdb3/core/](https://docs.influxdata.com/influxdb3/core/)
- InfluxDB 3 Core 配置项（query-file-limit）：[https://docs.influxdata.com/influxdb3/core/reference/config-options/](https://docs.influxdata.com/influxdb3/core/reference/config-options/)
- InfluxDB 3 Core Token 管理：[https://docs.influxdata.com/influxdb3/core/admin/tokens/](https://docs.influxdata.com/influxdb3/core/admin/tokens/)
- InfluxDB 2 Docker 安装：[https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/](https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/)
- InfluxDB 1 TSI 索引：[https://docs.influxdata.com/influxdb/v1/administration/upgrading/](https://docs.influxdata.com/influxdb/v1/administration/upgrading/)
- TimescaleDB CREATE TABLE：[https://www.tigerdata.com/docs/api/latest/hypertable/create_table](https://www.tigerdata.com/docs/api/latest/hypertable/create_table)
- TimescaleDB 列存策略：[https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy)
- TimescaleDB 连续聚合策略：[https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_continuous_aggregate_policy](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_continuous_aggregate_policy)
- Prometheus 存储：[https://prometheus.io/docs/prometheus/latest/storage/](https://prometheus.io/docs/prometheus/latest/storage/)
- TDengine 文档：[https://docs.tdengine.com/](https://docs.tdengine.com/)
- Apache IoTDB 文档：[https://iotdb.apache.org/UserGuide/latest/QuickStart/QuickStart.html](https://iotdb.apache.org/UserGuide/latest/QuickStart/QuickStart.html)

> 下一篇：[文档数据库](./2_document_db) —— Schema 灵活的 MongoDB：建模、索引、副本集、分片与事务

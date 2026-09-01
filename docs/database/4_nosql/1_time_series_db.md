# 时序数据库

## 一、时序数据与 TSDB 核心概念

### 1、时序数据的特点

| 特点 | 说明 |
|------|------|
| **写多读少，几乎不更新** | 数据按时间源源不断追加（append-only），历史数据一旦写入基本不改 |
| **时间是一等公民** | 所有查询都带时间范围；最近的数据最热，越老越冷 |
| **批量过期** | 数据按保留期整块删除（"删掉 3 个月前的"），而不是逐行删 |
| **聚合为主** | 关心的是趋势（每分钟均值、P99），很少查单条原始点 |

### 2、为什么不用 MySQL 存时序数据

- **写入路径**：B+ 树的随机写 + 页分裂扛不住每秒百万级数据点；TSDB 普遍用 LSM/TSM 类结构，纯顺序写
- **过期删除**：MySQL `DELETE` 三个月前的数据是海量行删除（锁、binlog、碎片）；TSDB 按时间分区/分块，**整文件直接丢弃**
- **压缩比**：时序专用编码（时间戳 delta-of-delta、数值 Gorilla XOR、RLE）能做到 10~20 倍压缩，通用行存做不到
- **聚合查询**：按时间窗口聚合（`GROUP BY time(1m)`）是 TSDB 的原生算子，MySQL 只能全量扫描后计算

### 3、数据模型

各家术语不同，但模型高度一致（以 InfluxDB 行协议为例）：

![时序数据模型](../../assets/database/tsdb-data-model.svg)

| 概念 | InfluxDB | Prometheus | TDengine | 关系型类比 |
|------|----------|-----------|----------|-----------|
| 指标集合 | measurement | metric name | 超级表 STable | 表 |
| 维度（索引）| tag | label | TAGS | 带索引的列 |
| 值 | field | value | 普通列 | 无索引的列 |
| 一条序列 | series | time series | 子表 | — |

### 4、三个共性机制

- **保留策略（Retention）**：按时间自动过期删除，建库时就要定（如原始数据留 30 天）
- **降采样（Downsampling）**：原始秒级数据聚合成分钟级/小时级长期保存，"近期细、久远粗"
- **高基数问题（High Cardinality）**：序列总数 = 各 tag 取值的笛卡尔积；把 user_id、订单号这类高基数字段放进 tag/label 会让索引爆炸，是所有 TSDB 的第一大坑

---

## 二、InfluxDB

官网：[https://www.influxdata.com](https://www.influxdata.com)

### 1、版本演进

InfluxDB 三代架构差异极大，几乎是三个产品，按需选读：

- **1.x**：单体架构，InfluxQL（类 SQL），存量系统仍大量使用
- **2.x**：整合 Telegraf / Kapacitor 一站式，主推 Flux 查询语言（学习成本高，官方已宣布 Flux 进入维护模式）
- **3.x**：2025 年 GA 的重构版（原代号 IOx），Rust 重写，**列式存储（Parquet）+ 对象存储 + 计算存储分离**，回归标准 SQL；开源版为 **InfluxDB 3 Core**（MIT/Apache-2.0），商业版 Enterprise
- 集群/高可用能力始终在商业版（1.x/2.x 开源版单机；3 Core 单机、Enterprise 多节点）

### 2、InfluxDB 1.x

#### 1.x 安装

个人安装使用 docker-compose 形式安装，代码如下所示：

```yaml
# docker-compose.yml
services:
  influxdb:
    # 此处的镜像可能失效，后续随时更新
    image: docker.1ms.run/library/influxdb:1.11.7
    container_name: influxdb
    environment:
      INFLUXDB_ADMIN_USER: root
      INFLUXDB_ADMIN_PASSWORD: 123456
    ports:
      - "8086:8086"
    volumes:
      - ./influxdb_data:/var/lib/influxdb
    restart: always
```

#### 1.x 使用

基础语法等同于 SQL 语法，详情可参考官方文档。

```bash
# 进入 InfluxDB 交互界面
influx

# 创建数据库
CREATE DATABASE mydb

# 查看数据库
SHOW DATABASES

# 查看数据库-数据表
SHOW MEASUREMENTS

# 使用指定数据库
USE mydb

# 插入数据（行协议：measurement,tag=值 field=值）
INSERT cpu,host=serverA value=0.64

# 查询数据
SELECT * FROM cpu

# 时间窗口聚合 + 保留策略（时序典型用法）
SELECT MEAN(value) FROM cpu WHERE time > now() - 1h GROUP BY time(1m)
CREATE RETENTION POLICY "30d" ON mydb DURATION 30d REPLICATION 1 DEFAULT
```

图形化工具可用 InfluxDB Studio（开源，Windows）。

#### 1.x 索引

1.x 默认使用内存索引（inmem），序列多时内存占用高；`tsi1`（Time Series Index）是磁盘索引，适合大规模序列，需手动开启：

```toml
[data]
index-version = "tsi1"
```

重启服务后生效。

### 3、InfluxDB 2.x

#### 2.x 安装

```yaml
services:
  influxdb_v2:
    image: docker.1ms.run/library/influxdb:2.7.10
    container_name: influxdb_v2
    environment:
      INFLUXDB_ADMIN_USER: root
      INFLUXDB_ADMIN_PASSWORD: 123456
    ports:
      - "8087:8086"
    volumes:
      - ./influxdb_data_v2:/var/lib/influxdb
    restart: always
```

#### 2.x 使用

- **初始化配置**：访问 `http://localhost:8087` 进入初始化界面，创建组织、Bucket、Token（2.x 用 Bucket 取代了 1.x 的"数据库 + 保留策略"）

- **数据写入**（CLI / API）：

```bash
influx write \
  --bucket my-bucket \
  --org my-org \
  --token my-token \
  --precision s \
  "sensor,location=room1 temperature=25.3,humidity=60"
```

```bash
curl -X POST "http://localhost:8087/api/v2/write?org=my-org&bucket=my-bucket&precision=s" \
  --header "Authorization: Token my-token" \
  --data-raw "sensor,location=room1 temperature=25.3,humidity=60"
```

- **数据查询**（Flux 语言）：

```
from(bucket: "my-bucket")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "sensor")
  |> filter(fn: (r) => r.location == "room1")
```

> 2.x 也保留了 InfluxQL 兼容端点；Flux 已进入维护模式，新项目不建议在 Flux 上做重投入。

### 4、InfluxDB 3.x

#### 版本背景

InfluxDB 3（原代号 IOx）是 2023 年起重构、**2025 年 4 月 GA** 的新一代版本，Rust 编写，与 1.x/2.x 完全不兼容：

- **列式存储**：数据以 Apache Parquet 落盘，内存中用 Apache Arrow
- **对象存储优先**：本地磁盘 / S3 / OSS 皆可作主存储，计算存储分离
- **回归标准 SQL**（基于 Apache DataFusion 引擎），同时兼容 InfluxQL
- 开源版 **InfluxDB 3 Core**：定位近实时数据（**默认查询窗口限最近 72 小时**）；历史长查询、多节点高可用属于 **Enterprise** 版

#### 3.x 安装

```yaml
services:
  influxdb3:
    image: influxdb:3-core
    container_name: influxdb3
    ports:
      - "8181:8181"          # HTTP API
    volumes:
      - ./influxdb3_data:/var/lib/influxdb3
    command: >
      influxdb3 serve --node-id node0
      --object-store file --data-dir /var/lib/influxdb3
    restart: always
```

#### 3.x 使用

- **数据写入**：兼容 1.x/2.x 的 Line Protocol：

```bash
curl -X POST "http://localhost:8181/api/v3/write_lp?db=mydb" \
  --data-raw "sensor,location=lab temperature=23.5"
```

- **数据查询**（标准 SQL）：

```bash
curl "http://localhost:8181/api/v3/query_sql?db=mydb" \
  --data-urlencode "q=SELECT * FROM sensor WHERE time > now() - interval '1 hour'"
```

### 5、版本对比总结

| 特性 | InfluxDB 1.x | InfluxDB 2.x | InfluxDB 3.x |
|------|--------------|--------------|--------------|
| 查询语言 | InfluxQL | Flux / InfluxQL | **SQL** / InfluxQL |
| 存储结构 | TSM | TSM + BoltDB | Parquet + 对象存储（Arrow）|
| 计算存储分离 | ❌ | ❌ | ✅ |
| 组织概念 | 数据库 + 保留策略 | Org / Bucket / Token | 数据库（SQL 语义）|
| 开源许可 | MIT | MIT | MIT / Apache-2.0（3 Core）|
| 开源版限制 | 单机 | 单机 | 单机 + 默认查最近 72h |
| 适用 | 存量系统维护 | 存量系统维护 | 新项目 / 云原生 / 大数据量 |

---

## 三、TimescaleDB

官网：[https://www.timescale.com](https://www.timescale.com)

**PostgreSQL 扩展**形态的时序数据库——不引入新组件、新语言，全部能力都是标准 SQL：

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 普通表一键变时序表（hypertable）：自动按时间分区（chunk）
CREATE TABLE metrics (
  time        TIMESTAMPTZ NOT NULL,
  device_id   INT,
  temperature DOUBLE PRECISION
);
SELECT create_hypertable('metrics', 'time');

-- 写入/查询就是普通 SQL，还能 JOIN 业务表
SELECT d.name, time_bucket('5 minutes', m.time) AS bucket, AVG(m.temperature)
FROM metrics m JOIN devices d ON d.id = m.device_id
WHERE m.time > NOW() - INTERVAL '1 day'
GROUP BY d.name, bucket;

-- 连续聚合（降采样物化视图，自动增量刷新）
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket, device_id, AVG(temperature) AS avg_temp
FROM metrics GROUP BY bucket, device_id;

-- 压缩 + 保留策略
ALTER TABLE metrics SET (timescaledb.compress);
SELECT add_compression_policy('metrics', INTERVAL '7 days');   -- 7 天后压缩（列式，约 10 倍）
SELECT add_retention_policy('metrics', INTERVAL '90 days');    -- 90 天后整 chunk 删除
```

**适合**：已有 PostgreSQL 技术栈、时序数据需要和业务数据 JOIN、团队只想写 SQL。
**不适合**：单机写入千万点/秒级别的极端场景（不如 TDengine / InfluxDB 专用引擎）。

---

## 四、Prometheus

官网：[https://prometheus.io](https://prometheus.io)

Prometheus 是云原生监控领域的事实标准，CNCF 毕业项目，配合 Grafana 提供完整的监控告警体系。与其他 TSDB 的关键差异：**拉模型（pull）**——Prometheus 主动抓取目标的 `/metrics` 端点，而不是应用推数据。

### 1、数据模型

Prometheus 以**时间序列**为核心，每条序列由 **metric 名称 + label 集合**唯一标识：

```
<metric_name>{<label_name>=<label_value>, ...}  →  [(timestamp, value), ...]
```

**示例**：

```
# HTTP 请求总数（Counter）
http_requests_total{method="POST", handler="/api/orders", status="200"} 3492

# 内存使用（Gauge）
process_resident_memory_bytes{job="app"} 134217728

# 请求延迟分布（Histogram）
http_request_duration_seconds_bucket{le="0.1"} 523
http_request_duration_seconds_bucket{le="0.5"} 1024
http_request_duration_seconds_count 1051
http_request_duration_seconds_sum 204.3
```

### 2、四种 Metric 类型

| 类型 | 描述 | 典型用途 |
|------|------|---------|
| **Counter** | 只增不减的计数器（重启归零）| 请求总数、错误总数、处理字节数 |
| **Gauge** | 可升可降的当前值 | 内存使用量、在线连接数、队列长度 |
| **Histogram** | 采样并按桶分组，计算百分位 | 请求延迟分布、响应包大小 |
| **Summary** | 客户端计算百分位，精确但无法聚合 | 低基数场景的精确百分位 |

### 3、PromQL 常用查询

```promql
# 请求速率（5分钟内每秒请求数）
rate(http_requests_total{job="app"}[5m])

# 错误率
rate(http_requests_total{status=~"5.."}[5m]) 
  / rate(http_requests_total[5m])

# 99th 百分位延迟（Histogram）
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# 服务实例 CPU 使用率（Top 5）
topk(5, rate(process_cpu_seconds_total[5m]))

# 内存超过 1GB 的实例
process_resident_memory_bytes > 1073741824
```

### 4、Spring Boot 集成（Micrometer）

```xml
<!-- Spring Boot Actuator + Prometheus 导出 -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: prometheus,health,info
  metrics:
    export:
      prometheus:
        enabled: true
    tags:
      application: ${spring.application.name}
```

访问 `http://localhost:8080/actuator/prometheus` 即可看到所有指标，Prometheus 定时抓取（scrape）该端点。

```java
// 自定义 Meter
@Component
public class OrderMetrics {
    private final Counter orderCreated;
    private final Timer orderProcessTime;

    public OrderMetrics(MeterRegistry registry) {
        orderCreated = Counter.builder("order.created.total")
            .description("订单创建总数")
            .tag("channel", "web")
            .register(registry);

        orderProcessTime = Timer.builder("order.process.seconds")
            .description("订单处理耗时")
            .register(registry);
    }

    public void recordOrder(Runnable task) {
        orderCreated.increment();
        orderProcessTime.record(task);
    }
}
```

### 5、Prometheus 抓取配置

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'spring-app'
    static_configs:
      - targets: ['app1:8080', 'app2:8080']
    metrics_path: /actuator/prometheus

  - job_name: 'mysql-exporter'
    static_configs:
      - targets: ['mysql-exporter:9104']
```

### 6、告警规则示例

```yaml
# alert_rules.yml
groups:
  - name: app-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.job }} 错误率超过 5%"

      - alert: HighP99Latency
        expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P99 延迟超过 1s"
```

### 7、长期存储与集群

Prometheus 本地 TSDB 定位是**短期存储**（默认保留 15 天，单机无高可用），长期/大规模方案通过 `remote_write` 外接：

| 方案 | 思路 | 特点 |
|------|------|------|
| **VictoriaMetrics** | 兼容 PromQL 的独立 TSDB，Prometheus remote_write 写入 | 资源占用低、压缩比高，可直接**替代** Prometheus 存储层，国内使用广泛 |
| **Thanos** | Sidecar 把本地块上传对象存储，Query 层聚合多个 Prometheus | 保留 Prometheus 本体，适合多集群全局视图 |
| **Grafana Mimir** | Cortex 演进版，水平扩展的多租户存储 | 大规模多租户 SaaS 场景 |

> 选型速记：单团队想省事 → VictoriaMetrics；多 K8s 集群联邦查询 → Thanos。

---

## 五、国产 TSDB

### 1、TDengine

官网：[https://www.taosdata.com](https://www.taosdata.com)

涛思数据开源的高性能时序数据库，针对 IoT 和工业场景深度优化。

**核心特性**：
- **超级表（STable）**：用一张逻辑大表表示同类型设备，每台设备是一个子表，schema 一致，查询可跨子表聚合
- **写入性能**：单机可达千万 TPS（测试值），依托列式存储 + 时间戳主键压缩
- **内置计算**：支持 `LAST_ROW`、时间窗口聚合（`INTERVAL`）、数据插补（`FILL`）等时序专属函数
- **数据保留策略**：按表/库设置 `KEEP` 自动过期删除

```sql
-- 创建超级表（一类设备的模板）
CREATE STABLE meters (ts TIMESTAMP, current FLOAT, voltage INT, phase FLOAT)
  TAGS (location BINARY(64), groupid INT);

-- 创建子表（一台具体设备）
CREATE TABLE d1001 USING meters TAGS ("Beijing.Chaoyang", 2);

-- 写入数据
INSERT INTO d1001 VALUES (NOW, 10.3, 219, 0.31);

-- 跨设备聚合（按 location 统计平均电流）
SELECT location, AVG(current) FROM meters
WHERE ts > NOW - 1h GROUP BY location;
```

**适用场景**：工业 IoT、智能电网、车联网、APM 监控

### 2、IoTDB（Apache IoTDB）

官网：[https://iotdb.apache.org](https://iotdb.apache.org)

Apache 顶级项目，清华大学主导开发，专为工业物联网设计的时序数据库，与 Hadoop/Spark 生态深度集成。

**核心特性**：
- **树状存储模型**：`root.plant.device.sensor` 层次化命名，对应工厂→设备→传感器的物理拓扑
- **TsFile 格式**：列式存储，支持按时间范围高效查询，可直接导出供 Spark/Flink 分析
- **边缘-云协同**：轻量级部署在边缘节点，定期将 TsFile 同步到云端 IoTDB 集群
- **SQL 支持**：兼容标准 SQL 语法 + 时序扩展（`FILL`、滑动窗口、对齐时间序列）

```sql
-- 创建时间序列
CREATE TIMESERIES root.plant1.device1.temperature WITH DATATYPE=FLOAT, ENCODING=RLE;

-- 写入数据
INSERT INTO root.plant1.device1(timestamp, temperature) VALUES(NOW(), 36.5);

-- 时间窗口聚合（每 10 分钟平均温度）
SELECT AVG(temperature) FROM root.plant1.device1
GROUP BY ([2024-01-01, 2024-01-02), 10m);
```

**适用场景**：工业制造、智慧城市、能源管理、边云协同 IoT

---

## 六、选型对比

| 维度 | InfluxDB | TimescaleDB | Prometheus (+VM) | TDengine | IoTDB |
|------|---------|-------------|------------------|----------|-------|
| 形态 | 独立 TSDB | **PG 扩展** | 监控系统（拉模型）| 独立 TSDB | 独立 TSDB |
| 开源协议 | MIT（3 Core）| Apache 2.0 / TSL | Apache 2.0 | AGPL 3.0 | Apache 2.0 |
| 查询语言 | SQL / InfluxQL | **标准 SQL（PG）** | PromQL | SQL 方言 | SQL 扩展 |
| 开源集群 | ❌（商业版）| ❌（多节点属云版）| 联邦 / Thanos / VM | ✅ | ✅ |
| 与业务表 JOIN | ❌ | ✅ | ❌ | 弱 | 弱 |
| 主要场景 | 通用时序 / DevOps | 已有 PG 栈的时序 | 监控告警 | IoT / 工业 | 工业 IoT / 边云协同 |

**选型速记**：

```
系统监控告警            → Prometheus + Grafana（存储扛不住上 VictoriaMetrics）
已有 PostgreSQL 技术栈  → TimescaleDB（免新组件，能 JOIN 业务表）
工业 IoT / 设备采集     → TDengine（超级表模型贴合设备场景）/ IoTDB（边云协同、Hadoop 生态）
通用时序 / 新建独立系统  → InfluxDB 3
```

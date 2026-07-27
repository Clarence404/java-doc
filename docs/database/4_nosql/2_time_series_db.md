# Time Series DB

## 一、InfluxDB

### 1、背景介绍

目前存在两个InfluxDB的实现，一个是开源的，一个是商业的。开源版本不支持集群模式。

开源版本为 1.x 和 2.x的版本，此处只讨论 1.x版本。

1.x版本和2.x版本区别：

- **架构变化**：1.x 采用单体架构，2.x 整合了多个组件（如Telegraf、Kapacitor），提供一站式解决方案。
- **API 变化**：1.x 使用 InfluxQL 类 SQL 查询语言，2.x 推出了 Flux 查询语言，功能更强大但学习成本更高。
- **用户管理**：1.x 用户管理较为基础，2.x 支持多用户、多组织，安全管理更细致。
- **数据存储**：2.x 引入了 Bucket（桶）的概念，取代了 1.x 的数据库和保留策略概念。

### 2、InfluxDB 1.x

#### 1.x 安装

个人安装使用docker-compose形式安装，代码如下所示：

```dockerfile
docker-compose.yml

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

基础的语法等同与SQL语法，详情可以参考官方文档。

- 命令行方式

```bash
# 进入InfluxDB交互界面
influx

# 创建数据库
CREATE DATABASE mydb

# 查看数据库
SHOW DATABASES

# 查看数据库-数据表
SHOW MEASUREMENTS

# 使用指定数据库
USE mydb

# 插入数据
INSERT cpu,host=serverA value=0.64

# 查询数据
SELECT * FROM cpu
```

- InfluxDB Studio方式

InfluxDB Studio 是一个开源的图形化管理工具，支持 Windows，可以方便地查询、管理 InfluxDB 数据库。

#### 1.x 其他特性

- 1.x 索引

1.x 版本使用的是 `tsi1`（Time Series Index），适合大规模数据存储，默认不开启，需要手动配置。

开启索引的方法：

```toml
[data]
index-version = "tsi1"
```

重启服务后生效。

### 3、InfluxDB 2.x

#### 2.x 安装

```dockerfile
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

- 初始化配置

访问 `http://localhost:8087`，会进入初始化界面，创建组织、Bucket、Token。

创建完成后，记下 Token 方便后续使用。

- 数据写入

2.x 支持多种方式写入数据，最常见的是 `CLI` 和 `API`。

**CLI方式**

```bash
influx write \
  --bucket my-bucket \
  --org my-org \
  --token my-token \
  --precision s \
  "sensor,location=room1 temperature=25.3,humidity=60"
```

**API方式**

```bash
curl -X POST "http://localhost:8087/api/v2/write?org=my-org&bucket=my-bucket&precision=s" \
  --header "Authorization: Token my-token" \
  --data-raw "sensor,location=room1 temperature=25.3,humidity=60"
```

- 数据查询

2.x 默认使用 Flux 语言查询数据，示例：

```sql
from(bucket: "my-bucket")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "sensor")
  |> filter(fn: (r) => r.location == "room1")
```

### 4、InfluxDB 3.x

#### 版本背景

InfluxDB 3.0 是 InfluxData 公司于 2023 年推出的重构版本，它基于 **Apache Arrow** 和 **Object Store（如 S3）**
构建，完全改变了原有的存储和查询架构。该版本在可扩展性、查询性能、成本控制方面做了大幅提升。

> 🚨 注意：InfluxDB 3.0 与 1.x / 2.x 完全不兼容，采用了全新的架构和 API 接口。

#### 架构特点

- **基于 Apache Arrow 格式存储数据**
- **使用 Object Store（如 S3）作为主存储层**
- **计算和存储分离（Compute/Storage Separation）**
- 支持标准 SQL（通过 FlightSQL 协议）
- 提供 InfluxQL / Flux / SQL 三种查询语言接口（但以 SQL 为主）

#### 适用场景

- 大规模数据分析（TB/PB 级别）
- 云原生架构下的数据湖、冷热数据分析
- 成本敏感型的时序数据应用

---

#### 3.x 安装

InfluxDB 3.0 不再提供直接的开源二进制安装包，而是以托管服务（InfluxDB Cloud）为主，并开放了使用 **InfluxDB IOx** 源码自部署的能力。

官方提供了 Docker Compose 示例：

```yaml
version: '3'
services:
  influxdb3:
    image: quay.io/influxdb/influxdb_iox:2024-01-18
    ports:
      - "8080:8080"   # gRPC + FlightSQL
      - "8081:8081"   # HTTP API
    volumes:
      - ./iox_data:/root/.influxdb_iox
    environment:
      INFLUXDB_IOX_DATABASE_NAME: mydb
    restart: always
```

---

#### 3.x 使用

- 数据写入

InfluxDB 3.0 兼容 Line Protocol 写入格式：

```bash
curl -X POST http://localhost:8081/api/v2/write \
  -H 'Content-Type: text/plain; charset=utf-8' \
  --data-raw "sensor,location=lab temperature=23.5"
```

还支持通过 Arrow Flight、gRPC 或 Kafka 等形式批量写入。

- 数据查询（SQL）

3.0 主推标准 SQL 查询，使用 FlightSQL 协议，也支持通过 REST API 查询：

```sql
SELECT *
FROM sensor
WHERE location = 'lab' AND time > now() - interval '1 hour';
```

也支持 CLI 方式：

```bash
influx query --sql 'SELECT * FROM sensor'
```

---

- 3.x 特性与优势

| 特性      | InfluxDB 3.x                      |
|---------|-----------------------------------|
| 存储引擎    | Apache Arrow + Object Store（S3）   |
| 查询语言    | SQL（FlightSQL），兼容 InfluxQL / Flux |
| 数据压缩    | 高效列式压缩（Arrow + Parquet）           |
| 计算与存储分离 | ✅ 支持                              |
| 扩展性     | 弹性扩展，适合大规模 IoT/监控场景               |
| 安装方式    | Docker / Cloud / 自建 IOx           |

---

### 5、版本对比总结

| 特性      | InfluxDB 1.x | InfluxDB 2.x    | InfluxDB 3.x（IOx）           |
|---------|--------------|-----------------|-----------------------------|
| 查询语言    | InfluxQL     | Flux / InfluxQL | SQL / InfluxQL / Flux       |
| 管理方式    | CLI          | Web UI + Token  | API（支持 Cloud / 本地）          |
| 存储结构    | TSM          | TSM + BoltDB    | Apache Arrow + Object Store |
| 异步写入    | 有限           | 支持              | 高并发写入（gRPC + Kafka）         |
| 计算与存储分离 | ❌            | ❌               | ✅                           |
| 多租户     | 基础权限         | 多用户多组织          | 未来支持（基于 Cloud）              |
| 最佳应用场景  | 小型系统迁移       | 中型系统            | 大数据量、云原生、数据湖分析              |

--- 

## 二、Prometheus

官网：[https://prometheus.io](https://prometheus.io)

Prometheus 是云原生监控领域的事实标准，CNCF 毕业项目，配合 Grafana 提供完整的监控告警体系。

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

---

## 三、国产 TSDB

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

### 3、时序数据库选型对比

| 维度 | InfluxDB | Prometheus | TDengine | IoTDB |
|------|---------|-----------|----------|-------|
| 开源协议 | MIT（1.x/2.x）/ 商业（3.x）| Apache 2.0 | AGPL 3.0 | Apache 2.0 |
| 主要场景 | 通用时序 / DevOps | 监控告警 | IoT / 工业 | 工业 IoT / 边云协同 |
| 集群支持 | 商业版 | 联邦 / Thanos | 开源支持 | 开源支持 |
| SQL 支持 | InfluxQL / Flux / SQL | PromQL | SQL 方言 | SQL 扩展 |
| 生态集成 | Telegraf / Grafana | Alertmanager / Grafana | 全套组件 | Hadoop / Spark |
| 国内使用 | 较广泛 | 云原生主流 | 工业 IoT 主流 | 工业领域增长中 |
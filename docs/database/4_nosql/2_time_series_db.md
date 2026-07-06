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

示例 Token（仅供参考）：

```
4TnxeZiruEm9pjlI3BIXTH8XYgIwMgr_ghy9Phj_YoXpJSABig_FhEkOVKWTaKPMeHPjAcVWx5UqviEGs1BZxg==
```

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

* **官网地址**：[https://prometheus.io](https://prometheus.io)

---

## 三、国产 TSDB

### 1、TDengine

* **官网地址**：[https://www.taosdata.com](https://www.taosdata.com)

### 2、IoTDB（Apache IoTDB）

* **官网地址**：[https://iotdb.apache.org](https://iotdb.apache.org)
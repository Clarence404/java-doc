---
description: 三代差异、1.x InfluxQL 与 TSI 索引、2.x Bucket 与 Token、3 的 SQL 与对象存储
---

# InfluxDB

> 前置阅读：[时序数据库概览](./8_tsdb)

InfluxDB 是独立部署的时序数据库，从 Go 实现的 TSM 引擎演进到 Rust 实现、Parquet + 对象存储的 InfluxDB 3。本篇讲三代的版本差异与取舍、各代的部署、写入与查询，基线为 InfluxDB 3。

---

## 一、版本演进

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

---

## 二、InfluxDB 1.x

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

---

## 三、InfluxDB 2.x

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

---

## 四、InfluxDB 3

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

## 小结

- InfluxDB 1.x / 2.x / 3 几乎是三个产品：1.x、2.x 只适合存量维护，新项目用 3；Flux 已进入维护模式，3 不再支持
- 1.x 用数据库 + 保留策略组织数据，序列多时把索引改为 `tsi1`，存量 shard 要离线转换
- 2.x 镜像用 `DOCKER_INFLUXDB_INIT_*` 初始化、数据在 `/var/lib/influxdb2`，Bucket 自带保留期，所有 API 都要带 Token
- 3 用 Parquet + 对象存储和 SQL，默认 Token 认证，写入兼容 1.x / 2.x 行协议
- InfluxDB 3 Core 没有时间范围硬限制，但受 `--query-file-limit` 约束且不做压缩合并，长范围查询和多节点属于 Enterprise

## 参考资料

- InfluxDB 3 Core 文档：[https://docs.influxdata.com/influxdb3/core/](https://docs.influxdata.com/influxdb3/core/)
- InfluxDB 3 Core 配置项（query-file-limit）：[https://docs.influxdata.com/influxdb3/core/reference/config-options/](https://docs.influxdata.com/influxdb3/core/reference/config-options/)
- InfluxDB 3 Core Token 管理：[https://docs.influxdata.com/influxdb3/core/admin/tokens/](https://docs.influxdata.com/influxdb3/core/admin/tokens/)
- InfluxDB 2 Docker 安装：[https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/](https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/)
- InfluxDB 1 TSI 索引：[https://docs.influxdata.com/influxdb/v1/administration/upgrading/](https://docs.influxdata.com/influxdb/v1/administration/upgrading/)

> 下一篇：[TimescaleDB](./10_timescaledb) —— PG 扩展形态、Hypertable 建表、列存 Hypercore 与保留策略、连续聚合、TSL 许可与部署

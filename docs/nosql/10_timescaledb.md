---
description: PG 扩展形态、Hypertable 建表、列存 Hypercore 与保留策略、连续聚合、TSL 许可与部署
---

# TimescaleDB

> 前置阅读：[时序数据库概览](./8_tsdb)、[PostgreSQL 基础](/database/2_postgresql/0_basics)

TimescaleDB 是以 PostgreSQL 扩展形态提供的时序数据库，全部能力都是标准 SQL。本篇讲 Hypertable、列存与保留策略、连续聚合，以及许可与部署注意，基线为 TimescaleDB 2。

---

## 一、定位

TimescaleDB 是 **PostgreSQL 扩展**形态的时序数据库：不引入新组件、新语言，全部能力都是标准 SQL，还能和业务表 JOIN。开发公司 Timescale 于 2025 年 6 月更名为 **TigerData**（托管服务为 Tiger Cloud），扩展本身仍叫 TimescaleDB。

---

## 二、Hypertable

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

---

## 三、查询与 JOIN

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

---

## 四、列存（Hypercore）与保留策略

2.18 起「压缩」改称**列存（columnstore，Hypercore 引擎）**：较老的 chunk 转为列式存储，压缩比通常在 10 倍以上，旧的 `compress` 系列参数与函数作为别名保留。

```sql
-- 2.20+ 用 CREATE TABLE ... WITH 建表时，默认已开启列存并自动创建列存策略；
-- 需要调整转换时机或手动建表时：
CALL add_columnstore_policy('metrics', after => INTERVAL '7 days');

-- 保留策略：90 天前的 chunk 整块删除
SELECT add_retention_policy('metrics', INTERVAL '90 days');
```

更早的版本用 `ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id')` 加 `add_compression_policy`。

---

## 五、连续聚合（降采样）

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

---

## 六、许可与部署注意

- 列存 / 压缩、连续聚合、各类自动策略属于 **TSL（Timescale License）** 功能，只有 Apache 2.0 部分的构建（部分云厂商托管 PG 提供的版本）没有这些能力，选型前确认
- 自建多节点（multi-node）在 2.13 废弃、2.14 移除；横向扩展依赖 PG 自身的读副本或 Tiger Cloud
- 适合：已有 PostgreSQL 技术栈、时序数据要和业务数据 JOIN、团队只想写 SQL
- 不适合：单机每秒千万点级别的极端写入

---

## 小结

- TimescaleDB 是 PostgreSQL 扩展，不引入新组件和新语言，时序数据能直接和业务表 JOIN；开发公司已更名为 TigerData
- 2.20 起 `CREATE TABLE ... WITH (tsdb.hypertable)` 直接建 Hypertable，较早版本用 `create_hypertable` 转换
- 列存用 `add_columnstore_policy`，过期数据用 `add_retention_policy` 按 chunk 整块删除
- 连续聚合要配 `add_continuous_aggregate_policy` 才自动刷新
- 列存、连续聚合与自动策略属于 TSL 许可；自建多节点已移除，横向扩展靠 PG 读副本或 Tiger Cloud

## 参考资料

- TimescaleDB CREATE TABLE：[https://www.tigerdata.com/docs/api/latest/hypertable/create_table](https://www.tigerdata.com/docs/api/latest/hypertable/create_table)
- TimescaleDB 列存策略：[https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy)
- TimescaleDB 连续聚合策略：[https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_continuous_aggregate_policy](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_continuous_aggregate_policy)

> 下一篇：[图数据库概览](./11_graph_db) —— 多跳关系的代价与免索引邻接、典型场景、属性图模型、ISO GQL 标准、Apache AGE 等方案、选型

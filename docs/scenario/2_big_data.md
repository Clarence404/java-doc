---
description: 存储扩展、深分页与预计算、日志链路与 ES 写入、Flink 实时聚合、HyperLogLog UV 统计
---

# 海量数据架构选型

> **本篇目标**：遇到「存不下、查不快、算不完、写不进」时，知道该把问题交给哪类方案，并知道 HyperLogLog 这类概率结构的内存与误差。
>
> **前置阅读**：[数据层扩展](/high-con/5_data_scaling)、[分库分表与中间件](/database/5_practice/2_sharding)

本篇只做组合与选型：分库分表、冷热分离、OLAP 存储、Flink 各有主文档，这里一句话带过并给出链接；分桶、Top K、位图这类算法题见 [海量数据算法题](./3_massive_data)。

---

## 一、核心挑战

| 挑战 | 说明 | 主要手段 |
|------|------|----------|
| 存不下 | 单机磁盘 / 内存不足 | 分库分表、冷热分离、对象存储归档 |
| 查不快 | 全表扫描、深分页、复杂聚合 | 索引、游标分页、预计算、OLAP 引擎 |
| 算不完 | 单机算力不足 | Flink 流计算、Spark 批计算 |
| 写不进 | 单库写入瓶颈 | Kafka 缓冲 + 批量写入、水平拆分 |

---

## 二、存储扩展

### 1、分库分表

垂直拆分按业务拆库，水平拆分按分片键（如 `user_id`）把一张大表拆成多张同构表。分片键选择、跨分片聚合与分页、扩容迁移见 [分库分表与中间件](/database/5_practice/2_sharding)；全局唯一 ID 可以用雪花算法、号段模式，或多主步长自增，见 [分布式 ID 生成](/distributed/8_id_generator)；跨分片事务尽量通过业务设计避免，必须时见 [分布式事务](/distributed/4_transaction)。

### 2、冷热分离

近期数据留在 OLTP 库，历史数据迁到低成本存储（OLAP 库或对象存储），迁移按「先写冷库、校验、再删热库」分批进行。完整方案见 [数据冷热分离](/architecture/1_cold_hot_data)。

### 3、数仓分层

| 层 | 内容 | 说明 |
|----|------|------|
| ODS（原始层） | 原始日志、业务库 binlog 同步 | 保持原样，便于回溯重算 |
| DWD（明细层） | 清洗、去重、格式统一 | 一行一个业务事实 |
| DWS（汇总层） | 按主题聚合（日 / 周 / 月） | 宽表或轻度汇总 |
| ADS（应用层） | 面向报表、接口的结果 | 直接被查询 |

OLAP 引擎（ClickHouse、Doris / StarRocks）的选型见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)。

---

## 三、查询优化

### 1、索引

- 覆盖索引：查询字段全在索引中，不回表
- 前缀索引：长字符串取前 N 个字符建索引
- 避免索引失效：不在索引列上做函数、隐式类型转换、前缀 `%` 的 LIKE

索引原理见 [MySQL 索引](/database/1_mysql/4_topic_index)。

### 2、深分页

`LIMIT 1000000, 10` 要先扫过 100 万行再丢弃：

```sql
-- 不推荐
SELECT * FROM orders ORDER BY id LIMIT 1000000, 10;

-- 游标分页（推荐）：记住上一页最后一个 id
SELECT * FROM orders WHERE id > #{lastId} ORDER BY id LIMIT 10;

-- 必须跳页时：子查询只走主键索引定位起点，外层同样要 ORDER BY
SELECT * FROM orders
WHERE id >= (SELECT id FROM orders ORDER BY id LIMIT 1000000, 1)
ORDER BY id
LIMIT 10;
```

### 3、读写分离

主库写、从库读，由 ShardingSphere 5.5 的读写分离规则或数据库代理透明路由（MyCat 已基本停止维护，不建议新项目使用）。主从延迟下「写后立即读」可能读到旧数据，关键读强制走主库。复制与延迟治理见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication)。

### 4、预计算汇总表

MySQL 没有物化视图（PostgreSQL、Oracle、ClickHouse 有），常见做法是定时任务写汇总表。只汇总增量区间，并用唯一键 + `ON DUPLICATE KEY UPDATE` 让任务可以安全重跑：

```sql
-- daily_sales_summary 上有 UNIQUE KEY uk_day_category (stat_date, category_id)
INSERT INTO daily_sales_summary (stat_date, category_id, total_amount)
SELECT DATE(created_at), category_id, SUM(amount)
FROM orders
WHERE created_at >= CURDATE() - INTERVAL 1 DAY
  AND created_at <  CURDATE()
GROUP BY DATE(created_at), category_id
ON DUPLICATE KEY UPDATE total_amount = VALUES(total_amount);
```

> MySQL 8.0.20 起 `VALUES()` 写法已弃用但仍可用，新写法是行别名：`INSERT ... SELECT * FROM (SELECT ...) AS s ON DUPLICATE KEY UPDATE total_amount = s.total_amount`。

---

## 四、海量日志处理

### 1、典型链路

![海量日志处理链路](../assets/scenario/log_pipeline.svg)

Kafka 负责削峰与解耦，Flink 做清洗和实时聚合，明细进 ES 供检索、进 OLAP 供分析，原始数据归档到对象存储。采集、格式与存储的完整设计见 [日志体系](/observability/1_logging)。

### 2、Elasticsearch 写入与查询

**写入优化**：

- 批量写入（bulk API），单批 5～15MB 起步，按压测调整
- 大批量导入时把 `index.refresh_interval` 设为 `-1`、副本数设为 `0`，导入完成后恢复原值并手动 `refresh`
- 日志按时间建索引（按天 / 周），配合 ILM 滚动与删除

**查询优化**：

- 查询带时间范围，只命中少量索引
- 不需要评分的条件放 `filter`（不计分、可缓存）

原理与调优见 [搜索数据库](/database/4_nosql/3_search_db)。

### 3、实时计算：Flink

统计最近 1 分钟每个商品的下单量（Flink 2.x，`getCreateTime()` 返回毫秒时间戳）：

```java
DataStream<Order> orders = env.fromSource(kafkaSource,
        WatermarkStrategy.<Order>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                .withTimestampAssigner((o, ts) -> o.getCreateTime()),
        "orders");

orders
    .keyBy(Order::getProductId)
    .window(SlidingEventTimeWindows.of(Duration.ofMinutes(1), Duration.ofSeconds(10)))
    .aggregate(new CountAggregator())
    .sinkTo(kafkaSink);   // 结果写回 Kafka，由下游服务更新 Redis / 看板
```

Flink 2.0 删除了 `SinkFunction`，基于它的 Bahir Redis 连接器已不能使用，官方也没有 Redis 连接器。结果要进 Redis 时，要么写 Kafka / JDBC 等官方连接器再由下游消费，要么自己实现 Sink V2，见 [DataStream API](/flink/2_datastream) 的 Sink 一节；时间语义与窗口见 [Flink 总览](/flink/0_overview)。

---

## 五、经典海量数据问题

「两个大文件找相同 URL」「海量文本找高频词」「5 亿个数找中位数」这类单机离线题，套路是哈希分桶、堆、位图、布隆过滤器与外部排序的组合，题目、思路与内存估算统一见 [海量数据算法题](./3_massive_data)。本节只保留需要依赖线上存储的 UV 统计。

### 1、海量 UV 统计

Redis HyperLogLog 每个 key 最多约 12KB，统计亿级基数，标准误差约 0.81%：

```text
PFADD uv:20261009 user1 user2 user3
PFCOUNT uv:20261009
PFMERGE uv:week uv:20261003 uv:20261004 uv:20261005
```

结果是估算值，需要精确值（如计费）时用 Bitmap（用户 ID 连续时）或离线精确去重。

---

## 小结

- 分库分表、冷热分离、OLAP、Flink 各有主文档，海量数据方案是它们的组合：Kafka 缓冲写入，OLTP 存热数据，OLAP 做分析，对象存储归档
- 深分页优先游标分页；必须跳页时子查询先定位主键，外层仍要 `ORDER BY`
- MySQL 没有物化视图，汇总表只算增量区间，并用唯一键让任务可重跑
- Flink 2.x 只有 Sink V2，没有官方 Redis 连接器，结果先写 Kafka / JDBC 或自定义 Sink
- HyperLogLog 每个 key 约 12KB、误差约 0.81%，只适合允许误差的基数统计
- 大文件交集、Top K、中位数等单机离线题见 [海量数据算法题](./3_massive_data)

## 参考资料

- Redis HyperLogLog：[https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)
- MySQL INSERT ... ON DUPLICATE KEY UPDATE：[https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)
- Elasticsearch Tune for indexing speed：[https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed)
- Flink DataStream API：[https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/overview/](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/overview/)

> 下一篇：[海量数据算法题](./3_massive_data) —— 哈希分桶、堆、位图、布隆过滤器与外部排序，九类经典题的思路与内存估算。

---
description: 冷热判断标准、分批归档迁移、CDC 异步归档、分区交换、冷存储选型、查询路由
---

# 数据冷热分离

> **本篇目标**：按访问特征划分冷热数据，掌握三种落地方式（分批归档迁移、基于 binlog 的 CDC 异步归档、分区表交换分区）的正确写法与边界，能为冷数据选择存储并设计查询路由。
>
> **前置阅读**：[数据层扩展](/high-con/5_data_scaling)、[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)

冷热分离把访问频率差异很大的数据分层存放：热数据留在高性能的主库，冷数据迁到成本更低的存储。主表变小后，索引更容易装进内存，备份、DDL、主从同步都更快。它是数据层扩展的手段之一，与读写分离、分库分表的取舍见 [数据层扩展](/high-con/5_data_scaling)。

---

## 一、冷热判断标准

| 维度 | 热数据 | 冷数据 |
|------|--------|--------|
| 访问频率 | 每天、每小时都会访问 | 30 天以上几乎无人访问 |
| 时间窗口 | 近 N 天（如近 3 个月订单） | 更早的历史记录 |
| 业务状态 | 进行中、可能还会被修改 | 已完成、已关闭，且过了售后 / 退款期 |
| 查询延迟要求 | 毫秒级 | 秒级可接受 |

常见切割点：订单 3～6 个月、日志 7～30 天、用户行为 1 年、财务流水按监管要求保留但 1～2 年后转冷。**只归档终态数据**：还可能被修改的数据迁走后，更新会找不到行。

---

## 二、分离策略

### 1、分批归档迁移（最常用）

定时任务按主键游标分批：插入归档表 → 删除主表中**已归档**的行，每批一个短事务。

```java
@Component
public class OrderArchiveJob {
    private static final int BATCH = 500;
    private final OrderMapper orderMapper;
    private final OrderArchiver archiver;

    public OrderArchiveJob(OrderMapper orderMapper, OrderArchiver archiver) {
        this.orderMapper = orderMapper;
        this.archiver = archiver;
    }

    @Scheduled(cron = "0 0 2 * * ?")   // 每天 02:00；多实例部署时改用分布式调度或加 ShedLock
    public void archiveOrders() {
        LocalDateTime cutoff = LocalDate.now().minusMonths(3).atStartOfDay();
        long lastId = 0;
        while (true) {
            // WHERE id > #{lastId} AND status IN ('COMPLETED', 'CLOSED') AND created_at < #{cutoff}
            // ORDER BY id LIMIT #{batch}
            List<Long> ids = orderMapper.selectColdIds(lastId, cutoff, BATCH);
            if (ids.isEmpty()) {
                return;
            }
            archiver.archiveBatch(ids);
            lastId = ids.get(ids.size() - 1);
        }
    }
}

@Component
public class OrderArchiver {
    private final OrderArchiveMapper archiveMapper;
    private final OrderMapper orderMapper;

    public OrderArchiver(OrderArchiveMapper archiveMapper, OrderMapper orderMapper) {
        this.archiveMapper = archiveMapper;
        this.orderMapper = orderMapper;
    }

    /** 单独的 Bean 方法，经代理调用 @Transactional 才生效；每批一个事务 */
    @Transactional(rollbackFor = Exception.class)
    public void archiveBatch(List<Long> ids) {
        // INSERT IGNORE INTO orders_archive SELECT * FROM orders WHERE id IN (...)：重跑时已存在的行被忽略
        archiveMapper.copyFromOrders(ids);
        // DELETE o FROM orders o JOIN orders_archive a ON a.id = o.id WHERE o.id IN (...)：只删已归档的行
        orderMapper.deleteArchived(ids);
    }
}
```

- 归档表与主表**在同一个实例**时，复制和删除可以放在一个本地事务里，任意一步失败整体回滚
- 冷库在另一个系统（独立实例、ClickHouse、OSS）时无法共用事务：先写冷库（按主键幂等写入），校验行数或校验和后再删热库；中途失败重跑也不会丢数据或重复
- 批次要小，批间可短暂休眠：大批量 DELETE 会产生长事务、大量 undo 与 binlog，拖慢主从同步；MySQL 生态也可以直接用 Percona 的 `pt-archiver`
- 多实例部署时同一时刻只能有一个实例执行，见 [分布式调度](/distributed/6_job_scheduler)

### 2、基于 binlog 的 CDC 异步归档

「业务写热库的同时再写一份到 MQ」是双写：数据库成功、MQ 失败（或反过来）都会让冷库丢数据或多数据。可靠的做法是订阅热库的 binlog，由 CDC 工具把变更送进 MQ，归档消费者幂等写入冷库：

![基于 binlog 的 CDC 异步归档](../assets/architecture/cold-hot-cdc-archive.svg)

- 业务代码不变，CDC 工具（Canal、Debezium、Flink CDC）读取 binlog 投递到 Kafka，工具对比见 [CDC 工具](/database/5_practice/0_cdc_tools)
- 归档消费者按主键 upsert 写入冷库，消息重复或重放都不会产生重复数据
- 热库仍需按策略清理过期数据；清理产生的 DELETE 也会进入 binlog，归档消费者要**忽略归档清理产生的删除**（例如按表或执行账号过滤），否则冷库数据会被一起删掉
- 适合写入量大、冷库需要近实时数据的场景，如日志、埋点、订单明细同步到分析库

如果业务本身需要发事件，也可以在业务事务里写 Outbox 表，再由投递任务发送，效果相同，见 [消息队列基础](/messaging/1_basics)。

### 3、分区表：交换分区归档

按时间分区后，整月数据可以用元数据操作移出，不用逐行删除。

```sql
CREATE TABLE orders (
    id          BIGINT        NOT NULL,
    user_id     BIGINT        NOT NULL,
    status      TINYINT       NOT NULL,
    amount      DECIMAL(12,2) NOT NULL,
    created_at  DATETIME      NOT NULL,
    PRIMARY KEY (id, created_at)          -- 主键与唯一键都必须包含分区列
) PARTITION BY RANGE COLUMNS (created_at) (
    PARTITION p202401 VALUES LESS THAN ('2024-02-01'),
    PARTITION p202402 VALUES LESS THAN ('2024-03-01'),
    PARTITION p202403 VALUES LESS THAN ('2024-04-01'),
    PARTITION p_future VALUES LESS THAN (MAXVALUE)
);

-- 归档：把整个分区交换到一张结构相同的普通表
CREATE TABLE orders_202401 LIKE orders;
ALTER TABLE orders_202401 REMOVE PARTITIONING;
ALTER TABLE orders EXCHANGE PARTITION p202401 WITH TABLE orders_202401;
-- orders_202401 导出或迁到冷库、校验完成后，再删除已经为空的分区
ALTER TABLE orders DROP PARTITION p202401;
```

- `DROP PARTITION` 会**直接删除**分区里的数据，不是归档；先交换（或导出）、校验，再删除
- 交换和删除分区都是元数据操作，不产生逐行的 undo 和 binlog，几乎瞬时完成
- 用 `RANGE COLUMNS(created_at)` 而不是 `YEAR(created_at) * 100 + MONTH(created_at)` 这类复合表达式：后者对日期范围查询做不了分区裁剪
- 唯一键必须包含分区列，`order_no` 这类业务唯一键无法在全表范围内保证唯一，需要应用层或独立的唯一键表兜底
- 新分区要提前创建：用定时任务对 `p_future` 执行 `REORGANIZE PARTITION` 拆出下个月的分区

---

## 三、冷存储选型

| 场景 | 推荐方案 | 说明 |
|------|---------|------|
| 同库归档 | 归档表 / 分区表 | 最简单，归档表只保留主键与时间等少量索引 |
| 跨库归档 | 独立的 MySQL 归档实例 | 大容量盘、少索引，业务查询方式不变 |
| 冷数据仍要做统计分析 | ClickHouse / Apache Doris / StarRocks | 列存压缩比高；支持 TTL 与冷热存储策略（如按时间把分区移到低成本磁盘或对象存储），见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db) |
| 分布式数据库 | TiDB Placement Rules in SQL | 手动把指定分区放到带特定标签的存储节点，不会按热度自动分层 |
| 海量明细、极少访问 | 对象存储 + Parquet / Iceberg 湖表 | 成本最低，用 Trino、Spark 按需查询；对象存储的生命周期与归档类别见 [对象存储](./4_object_storage) |
| 时序数据 | InfluxDB / TimescaleDB / TDengine | 内置保留策略与降采样 |

---

## 四、查询路由与注意事项

- **按时间路由**：查询带时间条件，近 3 个月查热库，更早的查冷库；跨越边界的查询分别查询再合并，分页会变复杂，产品上常把「历史订单」做成单独入口
- **按 ID 路由**：ID 内含时间戳（如雪花 ID）时可直接判断冷热；否则先查热库、未命中再查冷库
- **框架支持**：按时间分表、分库可以交给 ShardingSphere 的分片算法处理，见 [分库分表与中间件](/database/5_practice/2_sharding)
- **冷数据 SLA**：明确冷数据的查询延迟与可用性，冷库故障时历史查询可以降级，不影响主流程
- **数据安全**：先归档、校验（行数、抽样校验和）、再删除；删除只针对已确认归档的主键
- **监控**：监控主表行数与归档任务的进度、耗时、失败次数，归档积压时告警
- **冷数据被频繁回查**：说明切割点不合理，或需要为冷数据加缓存，缓存策略见 [缓存架构设计](/high-con/3_cache_architecture)

---

## 小结

- 冷热按访问频率、时间窗口和业务状态划分，只归档已进入终态的数据
- 分批迁移：主键游标分批，每批一个短事务；跨系统时先幂等写冷库、校验后再删热库；多实例需分布式调度
- 不要业务双写热库与 MQ；用 binlog CDC 或 Outbox 异步归档，消费者按主键幂等写入，并忽略清理产生的删除
- 分区表用 `RANGE COLUMNS` 保证分区裁剪；先 `EXCHANGE PARTITION` 再 `DROP PARTITION`，后者会直接删数据
- 冷存储按用途选择：归档实例、OLAP 列存、对象存储湖表、时序库；查询层按时间或 ID 路由

## 参考资料

- MySQL Partition Pruning：[https://dev.mysql.com/doc/refman/8.4/en/partitioning-pruning.html](https://dev.mysql.com/doc/refman/8.4/en/partitioning-pruning.html)
- MySQL RANGE COLUMNS Partitioning：[https://dev.mysql.com/doc/refman/8.4/en/partitioning-columns-range.html](https://dev.mysql.com/doc/refman/8.4/en/partitioning-columns-range.html)
- MySQL Exchanging Partitions and Subpartitions with Tables：[https://dev.mysql.com/doc/refman/8.4/en/partitioning-management-exchange.html](https://dev.mysql.com/doc/refman/8.4/en/partitioning-management-exchange.html)
- Percona Toolkit · pt-archiver：[https://docs.percona.com/percona-toolkit/pt-archiver.html](https://docs.percona.com/percona-toolkit/pt-archiver.html)
- Debezium MySQL Connector：[https://debezium.io/documentation/reference/stable/connectors/mysql.html](https://debezium.io/documentation/reference/stable/connectors/mysql.html)
- ClickHouse · Manage data with TTL：[https://clickhouse.com/docs/guides/developer/ttl](https://clickhouse.com/docs/guides/developer/ttl)
- TiDB · Placement Rules in SQL：[https://docs.pingcap.com/tidb/stable/placement-rules-in-sql](https://docs.pingcap.com/tidb/stable/placement-rules-in-sql)

> 下一篇：[架构模式与风格](./2_arch_patterns) —— 分层、整洁架构与六边形架构的依赖规则，以及 CQRS 与事件溯源的适用场景和代价。

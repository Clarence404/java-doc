# 数据冷热分离

> 将访问频率差异显著的数据分层存储，用低成本介质承载冷数据，高性能介质承载热数据，降本增效。

---

## 一、冷热判断标准

| 维度 | 热数据 | 冷数据 |
|------|--------|--------|
| 访问频率 | 高频（每天/每小时访问） | 低频（30天以上未访问） |
| 时间窗口 | 近 N 天（如近 3 个月订单） | 历史归档（3个月前） |
| 业务属性 | 进行中的业务实体 | 已完成/已关闭的记录 |
| 查询延迟要求 | 毫秒级 | 秒级可接受 |

**常见冷热切割点**：订单 3 个月、日志 7 天、用户行为 1 年、财务流水 2 年。

---

## 二、分离策略

### 1. 定时批量迁移（最常用）

定时任务扫描主表，将满足条件的记录迁移到归档表，主表删除。

```java
@Scheduled(cron = "0 2 * * * ?")  // 每天凌晨2点执行
public void archiveOrders() {
    LocalDate cutoff = LocalDate.now().minusMonths(3);
    List<Order> coldOrders = orderRepo.findByStatusAndCreateTimeBefore(
        OrderStatus.COMPLETED, cutoff.atStartOfDay()
    );

    if (coldOrders.isEmpty()) return;

    // 批量写入归档表
    orderArchiveRepo.batchInsert(coldOrders);

    // 从主表删除（分批，避免锁表）
    List<Long> ids = coldOrders.stream().map(Order::getId).toList();
    orderRepo.batchDeleteByIds(ids);

    log.info("Archived {} orders before {}", ids.size(), cutoff);
}
```

> 分批处理建议每批 500~1000 条，配合事务，避免单次操作过大导致锁等待。

### 2. 双写 + 异步归档

写入时同时写热库和消息队列，消费端异步写冷库；主表定期清理。

```
写请求 → 主库（MySQL热表）
       → Kafka（归档消息）→ Consumer → 归档库（HBase/OSS）
```

适合：写入量大、对实时性要求高的场景（如日志、埋点数据）。

### 3. 实时感知冷热（LRU 策略）

基于 Redis 记录数据最近访问时间，后台任务根据访问热度动态调整存储层。

```java
// 查询时更新热度
public Order getOrder(Long id) {
    Order order = hotCache.get(id);
    if (order == null) {
        order = coldStorage.get(id);
        if (order != null) {
            hotCache.put(id, order);  // 回写热层
        }
    }
    // 记录访问时间
    redis.zadd("order:heat", System.currentTimeMillis(), id.toString());
    return order;
}

// 后台定时将长时间未访问的数据从热层驱逐
@Scheduled(fixedRate = 3600_000)
public void evictColdData() {
    long threshold = System.currentTimeMillis() - Duration.ofDays(7).toMillis();
    Set<String> coldIds = redis.zrangeByScore("order:heat", 0, threshold);
    coldIds.forEach(id -> hotCache.remove(Long.parseLong(id)));
}
```

---

## 三、存储技术选型

| 场景 | 推荐方案 | 说明 |
|------|---------|------|
| 同库归档（简单） | MySQL 归档表 / 分区表 | 同实例，历史表加 `_archive` 后缀，按月分区 |
| 跨库归档（中等） | MySQL → TiDB / PostgreSQL | TiDB 原生冷热存储，自动分层 |
| 半结构化大数据 | MySQL → HBase | 适合稀疏列、海量行 |
| 文件/日志类 | MySQL → OSS + 索引 | 文件存 OSS，元数据存 ES 提供检索 |
| 时序数据 | InfluxDB / TimescaleDB | 内置自动降采样和数据过期策略 |

---

## 四、MySQL 分区表方案（按月分区）

```sql
CREATE TABLE orders (
    id          BIGINT       NOT NULL,
    user_id     BIGINT       NOT NULL,
    status      TINYINT      NOT NULL,
    amount      DECIMAL(12,2),
    created_at  DATETIME     NOT NULL,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (YEAR(created_at) * 100 + MONTH(created_at)) (
    PARTITION p202401 VALUES LESS THAN (202402),
    PARTITION p202402 VALUES LESS THAN (202403),
    PARTITION p202403 VALUES LESS THAN (202404),
    -- ...
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- 归档：直接 DROP PARTITION，比 DELETE 快 100 倍
ALTER TABLE orders DROP PARTITION p202401;
```

---

## 五、注意事项

- **查询路由**：冷热分离后，查询层需判断数据在哪一层（按时间范围路由）。
- **一致性**：迁移过程中需防止数据丢失，建议先归档、验证、再删主表。
- **索引策略**：归档表通常只需少量索引（ID + 时间），减少写入开销。
- **监控**：监控主表行数增长趋势，超过阈值自动触发归档任务告警。

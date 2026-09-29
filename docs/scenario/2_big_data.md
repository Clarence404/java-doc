# 海量数据处理

> 参考资料：[advanced-java 海量数据处理](https://gitee.com/Doocs/advanced-java#%E6%B5%B7%E9%87%8F%E6%95%B0%E6%8D%AE%E5%A4%84%E7%90%86)

---

## 一、海量数据的核心挑战

| 挑战 | 说明 |
|------|------|
| 存不下 | 单机磁盘/内存不足，需分布式存储 |
| 查不快 | 全表扫描慢，索引失效，需要预计算或专用查询引擎 |
| 算不完 | 实时/离线计算资源不足，需分布式计算框架 |
| 写不进 | 高并发写入单库瓶颈，需分库分表或写入队列 |

---

## 二、海量数据存储方案

### 2.1 分库分表

**垂直分库**：按业务模块拆分，订单库 / 用户库 / 商品库各自独立。

**水平分表**：同一张表按某字段（userId / orderId）取模或范围分片：

```sql
-- 按 user_id % 16 分 16 张表
order_0000, order_0001, ... order_0015
```

**分片键选择原则**：
- 高频查询字段（避免跨分片查询）
- 数据分布均匀（避免热点）
- 不可变（分片后不能修改）

**跨分片问题：**

| 问题 | 解决方案 |
|------|---------|
| 跨分片聚合（COUNT/SUM） | 各分片计算后合并，或用 Elasticsearch |
| 跨分片排序分页 | 禁止深分页，或用游标分页（last_id > ? LIMIT N） |
| 全局唯一 ID | 雪花算法 / 号段模式（不能用自增） |
| 跨分片事务 | 尽量避免；必须时用 Seata |

### 2.2 冷热分离

将近期数据（热数据）与历史数据（冷数据）分开存储：

```
热数据（近 3 个月）→ MySQL（高性能 SSD）
冷数据（3 个月前）→ TiDB / ClickHouse / OSS 归档
```

**归档策略**：定时任务按日期批量迁移，迁移前写入冷库，确认后从热库删除。

### 2.3 数据湖 / 数仓分层

```
ODS（原始层）  → 原始日志、业务库 binlog 同步
DWD（明细层）  → 清洗、格式统一
DWS（汇总层）  → 按主题聚合（日/周/月粒度）
ADS（应用层）  → 直接供报表、接口查询
```

---

## 三、海量数据查询优化

### 3.1 索引优化

- 覆盖索引：查询字段全在索引中，无需回表
- 前缀索引：对长字符串字段取前 N 字符建索引
- 避免索引失效：不在索引列上做函数/类型转换/% 前缀 LIKE

### 3.2 分页优化

**深分页问题**：`LIMIT 1000000, 10` 实际扫描 100w+ 行。

```sql
-- 禁止方式
SELECT * FROM orders LIMIT 1000000, 10;

-- 游标分页（推荐）
SELECT * FROM orders WHERE id > #{lastId} ORDER BY id LIMIT 10;

-- 子查询优化（覆盖索引先定位）
SELECT * FROM orders
WHERE id >= (SELECT id FROM orders ORDER BY id LIMIT 1000000, 1)
LIMIT 10;
```

### 3.3 读写分离

主库写，从库读，通过 ShardingSphere / MyCat 透明路由：

```
写操作 → Master
读操作 → Slave（1 or N）
```

注意：主从延迟（通常 < 1s）场景下，写后立即读可能读到旧数据，需强制走主库或引入延迟补偿。

### 3.4 预计算 & 物化视图

对复杂统计（销售额排行、用户行为漏斗）提前计算结果存入汇总表，查询时直接读：

```sql
-- 每日凌晨跑批，写入汇总表
INSERT INTO daily_sales_summary(date, category_id, total_amount)
SELECT DATE(created_at), category_id, SUM(amount)
FROM orders GROUP BY DATE(created_at), category_id;
```

---

## 四、海量日志处理

### 4.1 典型链路

```
应用产生日志
    ↓
Logstash / Filebeat 采集
    ↓
Kafka（缓冲削峰）
    ↓
Flink / Spark Streaming（实时处理）
    ↓
ES（查询）+ ClickHouse（分析）+ HDFS（归档）
```

### 4.2 日志查询——Elasticsearch

**适用场景**：全文检索、关键词高亮、日志聚合分析。

**写入优化**：
- 批量写入（bulk API），每批 5MB~15MB
- 关闭 `refresh_interval`（写入时），写完后手动 refresh
- 副本数设为 0（写入时），写完再恢复

**查询优化**：
- 按时间范围（@timestamp）分索引（按天/周），避免全索引扫描
- Filter Context 代替 Query Context（不计分，可缓存）

### 4.3 实时计算——Flink

```java
// 统计最近 1 分钟每个商品的下单量（滑动窗口）
DataStream<Order> orders = env.addSource(kafkaSource);
orders
    .keyBy(Order::getProductId)
    .window(SlidingEventTimeWindows.of(Time.minutes(1), Time.seconds(10)))
    .aggregate(new CountAggregator())
    .addSink(redisSink);
```

---

## 五、海量数据常见面试题

### 5.1 找出 10 亿个数中最大的 Top K

**方案：小顶堆**
- 维护一个大小为 K 的小顶堆
- 逐行读数据，若当前数 > 堆顶，则替换堆顶并重新堆化
- 最终堆中就是 Top K
- 时间复杂度：O(N log K)，空间复杂度：O(K)

```java
PriorityQueue<Integer> minHeap = new PriorityQueue<>(K);
for (int num : dataStream) {
    if (minHeap.size() < K) {
        minHeap.offer(num);
    } else if (num > minHeap.peek()) {
        minHeap.poll();
        minHeap.offer(num);
    }
}
```

**分布式方案**：将数据分片到 N 台机器，每台机器求本地 Top K，再汇总 N * K 个数求全局 Top K。

### 5.2 10 亿 URL 去重

**方案：布隆过滤器（BloomFilter）**
- 初始化 bit 数组（如 10 亿 bit ≈ 120MB）
- 每个 URL 经 K 个哈希函数映射到 K 个 bit 位
- 判断时 K 个位全为 1 → 可能存在；任一为 0 → 一定不存在
- 误判率（False Positive）可通过调整 bit 数组大小和哈希函数数量控制

```java
// Guava BloomFilter 示例
BloomFilter<String> filter = BloomFilter.create(
    Funnels.stringFunnel(Charset.defaultCharset()),
    1_000_000_000,  // 预期元素数量
    0.001           // 误判率 0.1%
);
filter.put(url);
filter.mightContain(url); // true: 可能存在；false: 一定不存在
```

### 5.3 统计海量 UV（独立访客数）

**HyperLogLog（HLL）**：Redis 内置，用极小内存（12KB）统计亿级基数，误差率约 0.81%：

```bash
PFADD uv:20240101 user1 user2 user3  # 添加用户
PFCOUNT uv:20240101                  # 统计 UV（误差率 0.81%）
PFMERGE uv:week uv:20240101 uv:20240102  # 合并多日
```

### 5.4 两个大文件求交集

**外排序 + 归并**：
1. 将两个文件各自按行哈希，分成 N 个小文件（确保相同行落入同编号小文件）
2. 对每对同编号小文件求交集（放入内存 HashSet）
3. 汇总所有结果

**位图（BitMap）**：若数据是整数且范围有限（如 0~10亿），用 bit 数组标记，两个文件分别标记后做 AND 操作。

---

## 六、选型速查

| 场景 | 推荐方案 |
|------|---------|
| 海量写入 | Kafka 缓冲 + 批量入库 |
| 结构化查询 + 分析 | ClickHouse |
| 全文检索 | Elasticsearch |
| 实时流计算 | Flink |
| 离线批计算 | Spark / Hive |
| Top K | 小顶堆 / 分布式归并 |
| 去重（允许误差） | 布隆过滤器 / HyperLogLog |
| 大表分页 | 游标分页（禁深分页） |

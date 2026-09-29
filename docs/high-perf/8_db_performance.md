# 数据访问性能

> 在典型的业务系统中，数据库往往是链路上最慢、最难扩展的一环。本文从应用视角总结数据访问的性能治理方法，MySQL 内部原理见：
> - [MySQL 索引](/database/1_mysql/4_topic_index) · [SQL 执行流程](/database/1_mysql/6_topic_execution) · [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)
> - [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver) · [数据库连接池](/database/5_practice/3_connection_pool)

---

## 一、慢 SQL 治理闭环

慢 SQL 治理不是一次性的"优化几条 SQL"，而是持续的闭环：

| 阶段 | 做什么 | 工具 / 手段 |
|------|--------|-------------|
| 1、发现 | 开启慢查询日志，采集 APM 中的 SQL 耗时 | `slow_query_log=ON`、`long_query_time=0.5`、`log_queries_not_using_indexes`；SkyWalking / Arthas `trace` |
| 2、聚合排序 | 按**总耗时**（次数 × 单次耗时）排序，而非只看单次最慢 | `pt-query-digest`、云数据库的慢日志分析 |
| 3、分析 | 看执行计划：访问类型、使用的索引、扫描行数、是否 filesort / 临时表 | `EXPLAIN`、`EXPLAIN ANALYZE`（8.0.18+）、Optimizer Trace |
| 4、优化 | 加索引 / 调整联合索引顺序 / 改写 SQL / 业务改造 | 覆盖索引、消除函数与隐式转换、拆分复杂 SQL |
| 5、验证 | 对比优化前后的执行计划与耗时，确认不影响其他 SQL | 压测、灰度观察慢日志 |
| 6、预防 | SQL 上线前审核，持续监控 | SQL 审核平台、CI 中检查 `EXPLAIN`、慢 SQL 告警 |

常见优化方向速查：

| 执行计划信号 | 问题 | 优化方向 |
|--------------|------|----------|
| `type=ALL` | 全表扫描 | 为过滤条件建立索引 |
| `key=NULL` 但有索引 | 索引失效 | 检查函数运算、隐式类型转换、左模糊、违反最左前缀 |
| `rows` 很大、`filtered` 很低 | 索引区分度低或条件无法利用 | 调整联合索引列顺序、选择更高区分度的列 |
| `Using filesort` | 额外排序 | 让 ORDER BY 利用索引顺序 |
| `Using temporary` | 使用临时表 | 优化 GROUP BY / DISTINCT，利用索引 |
| 大量回表 | 二级索引查到后再查主键索引 | 覆盖索引，只查需要的列 |

索引失效场景与 EXPLAIN 字段详解见 [MySQL 索引](/database/1_mysql/4_topic_index)、[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)。

---

## 二、深分页

### 1、问题

```sql
SELECT * FROM t_order WHERE user_id = 1001 ORDER BY create_time DESC LIMIT 100000, 20;
```

MySQL 需要先按顺序读出 100020 行（每行都要回表），再丢弃前 100000 行。offset 越大越慢，后台导出、爬虫翻页场景下经常拖垮数据库。

### 2、方案对比

| 方案 | 做法 | 优点 | 局限 |
|------|------|------|------|
| 延迟关联 | 子查询先用覆盖索引查出 20 个主键，再关联回表 | 改动小，支持跳页 | 仍需扫描 offset 行索引，只是省掉回表 |
| 游标 / Seek 分页 | 记录上一页最后一条的排序值，`WHERE create_time < ? ORDER BY ... LIMIT 20` | 耗时与页数无关，性能最好 | 不支持随机跳页；排序字段需唯一或组合主键保证稳定 |
| 限制最大页数 | 产品层面限制只能翻前 N 页 | 简单有效 | 需要产品配合 |
| 搜索引擎 | 复杂条件 + 深分页交给 ES（`search_after`） | 适合多条件检索 | 引入数据同步 |

```sql
-- 延迟关联
SELECT o.* FROM t_order o
JOIN (
    SELECT id FROM t_order
    WHERE user_id = 1001
    ORDER BY create_time DESC
    LIMIT 100000, 20
) tmp ON o.id = tmp.id;

-- 游标分页：排序值可能重复时，带上 id 组成唯一游标
SELECT * FROM t_order
WHERE user_id = 1001
  AND (create_time < ? OR (create_time = ? AND id < ?))
ORDER BY create_time DESC, id DESC
LIMIT 20;
```

以上两条 SQL 都需要联合索引 `(user_id, create_time, id)` 支撑。批量导出、数据迁移这类**全量遍历**场景一律使用游标方式（按主键 `WHERE id > ? ORDER BY id LIMIT 1000`）。

---

## 三、批量写入

### 1、JDBC 批量

逐条 `INSERT` 每次都是一次网络往返 + 一次（自动）提交。批量写入需同时满足：

- 使用 `addBatch()` / `executeBatch()`（或 MyBatis `ExecutorType.BATCH`、JPA `hibernate.jdbc.batch_size`）。
- **MySQL 驱动 URL 添加 `rewriteBatchedStatements=true`**，否则驱动仍会逐条发送。
- 在一个事务中提交一批，而不是每条自动提交。

```java
String sql = "INSERT INTO t_order_item(order_id, sku_id, quantity) VALUES (?, ?, ?)";
try (Connection conn = dataSource.getConnection();
     PreparedStatement ps = conn.prepareStatement(sql)) {
    conn.setAutoCommit(false);
    int count = 0;
    for (OrderItem item : items) {
        ps.setLong(1, item.getOrderId());
        ps.setLong(2, item.getSkuId());
        ps.setInt(3, item.getQuantity());
        ps.addBatch();
        if (++count % 500 == 0) {        // 每 500 条提交一次，控制事务大小
            ps.executeBatch();
            conn.commit();
        }
    }
    ps.executeBatch();
    conn.commit();
}
```

### 2、注意事项

| 要点 | 说明 |
|------|------|
| 批大小 | 通常 500～1000 行一批；总长度受 `max_allowed_packet` 限制 |
| 大事务 | 一次提交几十万行会导致长时间锁、主从延迟、undo 膨胀，应分批提交 |
| MyBatis `foreach` 拼接 | 拼出超长 SQL 会导致解析耗时高、占用内存，大批量时优先使用 BATCH 执行器 |
| JPA `IDENTITY` 主键 | Hibernate 使用 `GenerationType.IDENTITY` 时无法批量插入，需改用序列或应用层生成 ID |
| 批量更新 | 相同更新值用 `UPDATE ... WHERE id IN (...)`；不同值可用 `CASE WHEN` 或 `INSERT ... ON DUPLICATE KEY UPDATE`（注意其锁与自增副作用） |

驱动层原理见 [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver)，更多批量场景见 [异步与批量](/high-perf/6_async_batch)。

---

## 四、N+1 查询

### 1、问题

先查出 N 条主记录，再对每条记录单独查询一次关联数据，共 1 + N 次查询：

```java
// Bad：1 次查订单 + N 次查明细
List<Order> orders = orderMapper.selectByUserId(userId);          // 1 次
for (Order order : orders) {
    order.setItems(itemMapper.selectByOrderId(order.getId()));    // N 次
}
```

在 ORM 中更隐蔽：JPA 的 `@OneToMany` 懒加载在循环中访问关联集合、MyBatis 的嵌套 `select` 关联，都会在不知不觉中产生 N+1。

### 2、解决方式

```java
// Good：2 次查询，内存中组装
List<Order> orders = orderMapper.selectByUserId(userId);
List<Long> orderIds = orders.stream().map(Order::getId).toList();
Map<Long, List<OrderItem>> itemMap = itemMapper.selectByOrderIds(orderIds).stream()
        .collect(Collectors.groupingBy(OrderItem::getOrderId));
orders.forEach(o -> o.setItems(itemMap.getOrDefault(o.getId(), List.of())));
```

| 方式 | 适用 |
|------|------|
| `IN` 批量查询 + 内存组装 | 最通用，适合跨表、跨服务 |
| JOIN 一次查出 | 关联数据量小、一对一或一对少 |
| JPA `JOIN FETCH` / `@EntityGraph` | JPA 项目，注意一对多 fetch 与分页同时使用会在内存中分页 |
| Hibernate `@BatchSize` | 懒加载时按批加载关联集合 |

发现手段：开启 SQL 日志统计单请求 SQL 条数、APM 链路中观察重复 SQL、Hibernate Statistics。

---

## 五、其他常见问题

| 问题 | 表现 | 处理 |
|------|------|------|
| `SELECT *` | 多传输无用列、无法使用覆盖索引 | 只查询需要的列 |
| 大结果集一次性加载 | 内存暴涨甚至 OOM | 分页或流式读取（JDBC `fetchSize`、MyBatis `Cursor`） |
| 长事务 | 连接长期占用、锁等待、主从延迟 | 事务内不做 RPC 和耗时计算，缩小事务范围 |
| 大 `IN` 列表 | SQL 过长、优化器放弃索引 | 分批，每批几百个 |
| `COUNT(*)` 大表 | 分页总数查询很慢 | 缓存总数、估算值、或不展示总页数 |
| 热点行更新 | 行锁竞争，TPS 上不去 | 合并更新、分散到多行后汇总、异步化 |

---

## 六、连接池与更大规模的扩展

- 数据库连接池的参数与容量计算见 [池化技术](/high-perf/5_pooling)：**连接池过大并不会让数据库更快**。
- 当单库在 SQL 已充分优化后仍无法支撑，需要引入缓存、读写分离、分库分表等**扩展性方案**，这属于高并发的范畴，见 [数据层扩展](/high-con/4_data_scaling) 与 [分库分表](/database/5_practice/2_sharding)。
- 读多写少的数据优先考虑缓存，见 [两级缓存](/cache/8_two_level_cache) 与 [缓存一致性](/cache/10_cache_consistency)。

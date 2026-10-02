---
description: 慢 SQL 治理闭环、N+1、深分页方案对比、批量写
---

# 数据访问性能

> **本篇目标**：从应用视角建立慢 SQL 治理闭环，掌握深分页、批量写、N+1 等高频问题的处理方案。
>
> **前置阅读**：[IO 与网络优化](./9_io_network)

> 参考：[MySQL 索引](/database/1_mysql/4_topic_index) · [SQL 执行流程](/database/1_mysql/6_topic_execution) · [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain) · [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver) · [数据库连接池](/database/5_practice/3_connection_pool)

在典型业务系统中，数据库往往是链路上最慢、最难扩展的一环。本篇讲应用侧的治理方法与方案选型，MySQL 内部原理见上方链接。

---

## 一、慢 SQL 治理闭环

**慢 SQL 治理不是一次性"优化几条 SQL"，而是发现 → 排序 → 分析 → 优化 → 验证 → 预防的持续闭环。**

| 阶段 | 做什么 | 工具 / 手段 |
|------|--------|-------------|
| 1、发现 | 开启慢查询日志，采集 APM 中的 SQL 耗时 | `slow_query_log=ON`、`long_query_time=0.5`、`log_queries_not_using_indexes`；SkyWalking / Arthas `trace` |
| 2、聚合排序 | 按**总耗时**（次数 × 单次耗时）排序，而非只看单次最慢 | `pt-query-digest`、云数据库的慢日志分析 |
| 3、分析 | 看执行计划：访问类型、使用的索引、扫描行数、是否 filesort / 临时表 | `EXPLAIN`、`EXPLAIN ANALYZE`（8.0.18+）、Optimizer Trace |
| 4、优化 | 加索引 / 调整联合索引顺序 / 改写 SQL / 业务改造 | 覆盖索引、消除函数与隐式转换、拆分复杂 SQL |
| 5、验证 | 对比优化前后的执行计划与耗时，确认不影响其他 SQL | 压测、灰度观察慢日志 |
| 6、预防 | SQL 上线前审核，持续监控 | SQL 审核平台、CI 中检查 `EXPLAIN`、慢 SQL 告警 |

::: tip 为什么按总耗时排序
单次 2 秒、每天 10 次的报表 SQL，对数据库的压力远小于单次 20ms、每秒 500 次的列表查询。优先治理总耗时 Top N，收益最大。
:::

执行计划各字段的含义与优化方向速查见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)，索引失效场景见 [MySQL 索引](/database/1_mysql/4_topic_index)。

---

## 二、深分页

**`LIMIT offset, n` 需要先读出 offset + n 行再丢弃前 offset 行，offset 越大越慢**；后台导出、爬虫翻页场景下经常拖垮数据库。

| 方案 | 做法 | 优点 | 局限 |
|------|------|------|------|
| 延迟关联 | 子查询先用覆盖索引查出 n 个主键，再关联回表 | 改动小，支持跳页 | 仍需扫描 offset 行索引，只是省掉回表 |
| 游标 / Seek 分页 | 记录上一页最后一条的排序值和 id，`WHERE (create_time, id) < (?, ?)` 语义的条件 + `LIMIT n` | 耗时与页数无关，性能最好 | 不支持随机跳页；排序值不唯一时要带上 id 组成复合游标 |
| 限制最大页数 | 产品层面限制只能翻前 N 页 | 简单有效 | 需要产品配合 |
| 搜索引擎 | 复杂条件 + 深分页交给 ES（`search_after`） | 适合多条件检索 | 引入数据同步 |

- 带过滤条件的查询（如 `WHERE user_id = ? ORDER BY create_time DESC`）只需联合索引 `(user_id, create_time)`：InnoDB 二级索引叶子节点本身就带主键 id，并按 id 作为最后一个排序维度，复合游标可以直接利用。
- 批量导出、数据迁移这类**全量遍历**一律按主键游标：`WHERE id > ? ORDER BY id LIMIT 1000`。
- 各方案的完整 SQL 写法（含过滤条件与复合游标）见 [MySQL 索引 · 深度分页优化](/database/1_mysql/4_topic_index)。

---

## 三、批量写入

### 1、三个条件缺一不可

**逐条 `INSERT` 每次都是一次网络往返 + 一次（自动）提交。** 真正的批量写入需同时满足：

| 条件 | 说明 |
|------|------|
| 批量 API | `addBatch()` / `executeBatch()`，或 MyBatis `ExecutorType.BATCH`、JPA `hibernate.jdbc.batch_size` |
| 驱动改写 | MySQL URL 添加 `rewriteBatchedStatements=true`，否则驱动仍逐条发送，原理见 [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver) |
| 事务分批 | 一批在一个事务中提交，而不是每条自动提交 |

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
| 批大小 | 通常 500～1000 行一批；改写后的语句总长受 `max_allowed_packet` 限制 |
| 大事务 | 一次提交几十万行会导致长时间锁、主从延迟、undo 膨胀，应分批提交 |
| MyBatis `foreach` 拼接 | 超长 SQL 解析耗时高、占用内存，大批量时优先使用 BATCH 执行器 |
| JPA `IDENTITY` 主键 | Hibernate 使用 `GenerationType.IDENTITY` 时无法批量插入，需改用序列或应用层生成 ID |
| 批量更新 | 相同更新值用 `UPDATE ... WHERE id IN (...)`；不同值可用 `CASE WHEN` 或 `INSERT ... ON DUPLICATE KEY UPDATE`（注意其锁与自增副作用） |

更多批量场景见 [异步与批量](./8_async_batch)。

---

## 四、N+1 查询

### 1、问题

**先查出 N 条主记录，再对每条单独查一次关联数据，共 1 + N 次查询。**

```java
// Bad：1 次查订单 + N 次查明细
List<Order> orders = orderMapper.selectByUserId(userId);          // 1 次
for (Order order : orders) {
    order.setItems(itemMapper.selectByOrderId(order.getId()));    // N 次
}
```

ORM 中更隐蔽：JPA 的 `@OneToMany` 懒加载在循环中访问关联集合、MyBatis 的嵌套 `select` 关联，都会在不知不觉中产生 N+1。

### 2、解决方式

```java
// Good：2 次查询，内存中组装
List<Order> orders = orderMapper.selectByUserId(userId);
List<Long> orderIds = orders.stream().map(Order::getId).toList();
Map<Long, List<OrderItem>> itemMap = orderIds.isEmpty()
        ? Map.of()
        : itemMapper.selectByOrderIds(orderIds).stream()
                .collect(Collectors.groupingBy(OrderItem::getOrderId));
orders.forEach(o -> o.setItems(itemMap.getOrDefault(o.getId(), List.of())));
```

| 方式 | 适用 |
|------|------|
| `IN` 批量查询 + 内存组装 | 最通用，适合跨表、跨服务 |
| JOIN 一次查出 | 关联数据量小、一对一或一对少 |
| JPA `JOIN FETCH` / `@EntityGraph` | JPA 项目；注意一对多 fetch 与分页同时使用会在内存中分页 |
| Hibernate `@BatchSize` | 懒加载时按批加载关联集合 |

发现手段：开启 SQL 日志统计单请求 SQL 条数、在 APM 链路中观察重复 SQL、Hibernate Statistics。

---

## 五、其他常见问题

| 问题 | 表现 | 处理 |
|------|------|------|
| `SELECT *` | 多传输无用列、无法使用覆盖索引 | 只查询需要的列 |
| 大结果集一次性加载 | 内存暴涨甚至 OOM | 分页或流式读取（JDBC `fetchSize`、MyBatis `Cursor`），驱动的读取模式见 [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver) |
| 长事务 | 连接长期占用、锁等待、主从延迟 | 事务内不做 RPC 和耗时计算，缩小事务范围 |
| 大 `IN` 列表 | SQL 过长、执行计划变差 | 分批，每批几百个；原因见下方说明 |
| `COUNT(*)` 大表 | 分页总数查询很慢 | 缓存总数、估算值，或不展示总页数 |
| 热点行更新 | 行锁竞争，TPS 上不去 | 合并更新、分散到多行后汇总、异步化，见 [热点问题](/high-con/6_hotspot) |

::: warning 大 IN 列表为什么会变慢
- IN 值个数超过 `eq_range_index_dive_limit`（默认 200）后，优化器不再逐个做 index dive，改用索引统计信息估算行数，估算偏差可能导致选错索引。
- 范围条件分析所需内存超过 `range_optimizer_max_mem_size`（默认 8MB）时，优化器放弃 range 访问方式，可能退化为全表扫描。
:::

---

## 六、连接池与更大规模的扩展

- 连接池参数与容量估算见 [池化技术](./7_pooling)：**连接池过大不会让数据库更快**。
- SQL 已充分优化后单库仍无法支撑，就需要缓存、读写分离、分库分表等**扩展性方案**，属于高并发范畴，见 [数据层扩展](/high-con/5_data_scaling) 与 [分库分表](/database/5_practice/2_sharding)。
- 读多写少的数据优先考虑缓存，见 [缓存架构设计](/high-con/3_cache_architecture)、[两级缓存](/cache/8_two_level_cache) 与 [缓存一致性](/cache/10_cache_consistency)。

---

## 小结

- 慢 SQL 治理是闭环：按总耗时排序，优化后验证，上线前审核
- 深分页优先游标分页，`(user_id, create_time)` 索引即可支撑复合游标；需要跳页时用延迟关联
- 批量写入要同时满足批量 API、`rewriteBatchedStatements=true`、分批提交事务
- N+1 用 `IN` 批量查询 + 内存组装解决，靠 SQL 条数统计发现
- 大 IN 列表分批，避免超过 `eq_range_index_dive_limit` 后执行计划变差

> 下一篇：[端到端优化案例](./11_case_study) —— 把前面各篇的方法串成一次完整的接口优化。

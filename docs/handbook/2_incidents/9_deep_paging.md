---
description: 按页码全量拉取、大偏移扫描百万行、Buffer Pool 冲刷、游标分页与延迟关联
---

# 深分页拖垮数据库

> 前置阅读：[MySQL 索引](/database/1_mysql/4_topic_index)、[数据访问性能](/high-perf/10_db_performance)

一个第三方服务商用 `page=1,2,3…` 循环拉取大商户的全部历史订单，页码越翻越深，单条查询从毫秒级涨到 7 秒，最终把主库 IO 和 Buffer Pool 一起拖垮。本篇按现象、排查、根因、修复、预防完整复盘，基线为 JDK 21、Spring Boot 4、MySQL 8.4。

---

## 一、现象

10 月 10 日 22:00 起，order-service 的开放接口 `GET /open/v1/orders?merchantId=&page=&size=50` 被一家 ISV（服务商）用于给商户 20002 做"历史订单迁移"，8 个并发从第 1 页开始顺序翻页。

| 时间 | 告警 / 现象 |
|------|-------------|
| 02:10 | 慢查询日志写入速度从每分钟个位数升到每分钟 400+ 条 |
| 02:40 | `MySQLCpuHigh`：主库 CPU 92%，`Innodb_buffer_pool_reads` 每秒 1.8 万次（平时约 200） |
| 02:45 | `HttpP99High`：下单接口 P99 从 150ms 升到 1.9s，订单详情 P99 升到 3.4s |
| 02:52 | Buffer Pool 命中率从 99.9% 降到 96.1%，磁盘读 IOPS 打满 |

开放接口本身没有报错，每次都正常返回 50 条；但同一时段所有业务查询都变慢了。

---

## 二、影响

- 02:40–03:25 共 45 分钟，下单接口 P99 超过 1 秒，夜间流量较低，约 900 笔下单因超时失败
- 03:00 的"超时未支付关单"定时任务比平时多跑了 22 分钟
- 被冲出 Buffer Pool 的热点数据在恢复后约 15 分钟才重新预热，期间 RT 仍偏高

---

## 三、排查过程

### 1、慢查询日志：谁最耗时

```bash
mysqldumpslow -s t -t 3 /var/lib/mysql/db-primary-slow.log
```

示例输出：

```text
Count: 18742  Time=4.21s (78904s)  Lock=0.00s (1s)  Rows=50.0 (937100), order_api[order_api]@[10.42.3.18]
  SELECT * FROM t_order WHERE merchant_id = N ORDER BY create_time DESC LIMIT N, N

Count: 18742  Time=1.37s (25677s)  Lock=0.00s (0s)  Rows=1.0 (18742), order_api[order_api]@[10.42.3.18]
  SELECT COUNT(*) FROM t_order WHERE merchant_id = N

Count: 312  Time=1.12s (349s)  Lock=0.00s (0s)  Rows=1.0 (312), order_api[order_api]@[10.42.3.21]
  SELECT * FROM t_order WHERE id = N
```

第一条分页查询累计耗时 7.9 万秒，平均 4.21 秒却只返回 50 行；第二条是每页都要算一次的总数。第三条按主键查单条也要 1 秒多，是被前两条拖慢的受害者。

### 2、看单条慢日志的扫描行数

```bash
grep -B3 "LIMIT 1999950, 50" /var/lib/mysql/db-primary-slow.log | head -4
```

示例输出：

```text
# Time: 2026-10-11T02:47:13.418226+08:00
# User@Host: order_api[order_api] @  [10.42.3.18]  Id: 1288731
# Query_time: 6.912341  Lock_time: 0.000004 Rows_sent: 50  Rows_examined: 2000000
SET timestamp=1791658033;
```

返回 50 行，扫描 200 万行。偏移量越大，扫描越多：第 1 页 50 行，第 40,000 页 200 万行。

### 3、执行计划

```sql
EXPLAIN ANALYZE
SELECT * FROM t_order WHERE merchant_id = 20002 ORDER BY create_time DESC LIMIT 1999950, 50;
```

示例输出：

```text
-> Limit/Offset: 50/1999950 row(s)  (cost=401217 rows=50) (actual time=6871.402..6871.517 rows=50 loops=1)
    -> Index lookup on t_order using idx_merchant_create (merchant_id=20002) (reverse)  (cost=401217 rows=3986420) (actual time=0.093..6774.880 rows=2000000 loops=1)
```

索引用对了（`idx_merchant_create`，倒序扫描免排序），问题在于 `LIMIT offset, n` 的语义：MySQL 必须先按顺序走过前 1,999,950 行再丢弃。`SELECT *` 让每一行都要回表到聚簇索引取整行数据，200 万次随机回表把大量冷数据页读进 Buffer Pool，挤掉了下单、详情等接口依赖的热点页——这就是"一个接口慢、全站跟着慢"的原因。

### 4、定位请求来源

```bash
kubectl logs -l app=api-gateway --since=1h | grep '/open/v1/orders' \
  | awk '{print $7}' | sed -E 's/.*appId=([^&]+).*page=([0-9]+).*/\1/' | sort | uniq -c | sort -rn | head -3
```

示例输出：

```text
   4812 isv_7f3a91
    418 isv_22c0d8
     97 isv_9b14e2
```

一个 ISV 一小时内调用 4,812 次，并发恒定为 8，占该接口调用量的 90% 以上。抽查它的请求，`page` 从 1 递增到 40,000 以上，`size=50` 固定，是典型的"用分页接口做全量同步"。

---

## 四、根因

1. **大偏移分页的成本与页码成正比**：`LIMIT 1999950, 50` 要扫描并回表 200 万行，接口设计上允许任意页码
2. **`SELECT *` 放大回表成本**：分页先取整行再丢弃，冷数据大量进入 Buffer Pool，冲掉热点页
3. **每页都 `COUNT(*)`**：大商户 400 万订单，每次翻页都重新数一遍
4. **开放接口没有页深限制和配额**：全量同步本应走导出或增量接口，开放平台既未提供，也未限制

---

## 五、修复

### 1、止血

- 02:58 网关对 `isv_7f3a91` 的 `/open/v1/orders` 限流到 2 QPS，并通知 ISV 暂停迁移
- 03:01 结束仍在执行的深分页查询：

```sql
SELECT CONCAT('KILL QUERY ', processlist_id, ';')
FROM performance_schema.threads
WHERE processlist_command = 'Query' AND processlist_time > 3
  AND processlist_info LIKE 'SELECT * FROM t_order WHERE merchant_id =%LIMIT%';
```

- 03:10 发布热修复：`page × size > 10,000` 时返回 400，提示改用游标接口
- 03:25 主库 CPU 回落到 30%，Buffer Pool 命中率逐步恢复

### 2、根治

**开放接口改游标分页（keyset pagination）**：不再传页码，而是传上一页最后一条记录的排序键，查询直接从该位置往后取，任何一页的成本都相同：

```sql
-- v2 接口：GET /open/v2/orders?merchantId=20002&cursor=<上一页最后一条的 create_time 与 id>&size=50
SELECT id, order_no, amount, status, create_time
FROM t_order
WHERE merchant_id = 20002
  AND (create_time < '2026-03-14 09:21:07' OR (create_time = '2026-03-14 09:21:07' AND id < 318822014))
ORDER BY create_time DESC, id DESC
LIMIT 50;
```

二级索引 `idx_merchant_create(merchant_id, create_time)` 的叶子节点本身就带主键 `id`，上述条件和排序都能在索引上完成，`Rows_examined` 恒为约 50。`id` 作为第二排序键，解决同一时间多条订单的翻页重复或遗漏。

```java
public record OrderPage(List<OrderDto> items, String nextCursor) {}

public OrderPage list(long merchantId, String cursor, int size) {
    Cursor c = Cursor.decode(cursor);                 // Base64 编码的 (createTime, id)，首页为 null
    List<OrderDto> rows = mapper.listAfter(merchantId, c, Math.min(size, 100));
    String next = rows.size() < size ? null : Cursor.encode(rows.getLast());
    return new OrderPage(rows, next);
}
```

**后台跳页改延迟关联**：商家后台需要"跳到第 N 页"，先在索引上只取主键，再回表取 50 行：

```sql
SELECT o.* FROM t_order o
JOIN (SELECT id FROM t_order WHERE merchant_id = 20002
      ORDER BY create_time DESC LIMIT 9950, 50) t ON o.id = t.id
ORDER BY o.create_time DESC;
```

子查询只扫描二级索引、不回表，同时页深限制在 200 页以内。

**总数不再实时计算**：开放接口去掉 `total` 字段，只返回 `nextCursor`；后台列表的总数按商户缓存 5 分钟。

**全量同步走专门通道**：为 ISV 提供按 `update_time` 游标的增量同步接口，以及从只读从库生成的异步导出文件。

---

## 六、预防

**监控告警**：

- 慢查询按 SQL 指纹统计 `Rows_examined / Rows_sent`，比值超过 1,000 且执行次数 > 100 次 / 小时即告警（`sys.statement_analysis` 的 `rows_examined_avg` 与 `rows_sent_avg`）
- `Innodb_buffer_pool_reads` 速率突增 10 倍告警，它往往比 CPU 更早反映"冷数据冲刷"
- 网关按 appId 统计开放接口调用量，单应用占比超过 50% 告警

**接口规范**：

- 对外列表接口一律用游标分页，不提供页码和总数；内部后台允许页码，但限制最大页深
- 列表查询禁止 `SELECT *`，只取展示所需字段
- 全量数据获取必须走导出、增量同步或 CDC，不允许用分页接口循环拉取

**测试**：性能测试增加"深页"用例：在 400 万订单的商户上分别请求第 1 页、第 1,000 页、末页，要求三者 RT 差距不超过 2 倍；集成测试断言游标翻页在同一 `create_time` 有多条记录时不重复、不遗漏。

---

## 七、涉及知识点

- 深度分页的原理与优化：[MySQL 索引](/database/1_mysql/4_topic_index#九、深度分页优化)
- 深分页方案对比与慢 SQL 治理：[数据访问性能](/high-perf/10_db_performance#二、深分页)
- 回表、覆盖索引与 Buffer Pool：[MySQL 索引](/database/1_mysql/4_topic_index)、[InnoDB 存储结构](/database/1_mysql/8_topic_innodb)
- 执行计划解读：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)
- 开放接口的分页与限流设计：[API 设计规范](/engineering/4_api_design_rule)、[限流与过载保护](/high-avail/7_rate_limiting)
- 全量与增量同步：[CDC 工具](/database/5_practice/0_cdc_tools)

---

## 小结

- 深分页的成本与偏移量成正比，"返回 50 行、扫描 200 万行"是典型特征
- 危害不止慢：大量回表把冷数据读进 Buffer Pool，热点页被冲掉，全站一起变慢
- 对外接口用游标分页，排序键要带唯一列兜底；需要跳页时用延迟关联并限制页深
- 每页 `COUNT(*)` 同样昂贵，能去掉就去掉，去不掉就缓存
- 全量同步需求要提供专门通道，而不是让调用方翻页翻到底

## 参考资料

- `LIMIT` 的执行方式：[MySQL 8.4 Reference Manual: LIMIT Query Optimization](https://dev.mysql.com/doc/refman/8.4/en/limit-optimization.html)
- 慢查询日志字段：[MySQL 8.4 Reference Manual: The Slow Query Log](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html)
- 慢日志汇总工具：[MySQL 8.4 Reference Manual: mysqldumpslow](https://dev.mysql.com/doc/refman/8.4/en/mysqldumpslow.html)
- `EXPLAIN ANALYZE`：[MySQL 8.4 Reference Manual: EXPLAIN Statement](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- Buffer Pool 机制与状态变量：[MySQL 8.4 Reference Manual: Buffer Pool](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html)
- 语句统计视图：[MySQL 8.4 Reference Manual: The statement_analysis View](https://dev.mysql.com/doc/refman/8.4/en/sys-statement-analysis.html)

> 下一篇：[缓存雪崩与击穿](./10_cache_avalanche)

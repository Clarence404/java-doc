---
description: EXPLAIN 字段与 ANALYZE、type 与 Extra、慢 SQL 定位、filesort、Hash Join
---

# EXPLAIN 与 SQL 优化

> 前置阅读：[SQL 执行流程](./6_topic_execution)、[MySQL 索引](./4_topic_index)

本篇讲 `EXPLAIN` 与 `EXPLAIN ANALYZE` 的读法、按慢日志 / `sys` schema / Optimizer Trace 定位慢 SQL，以及 filesort、COUNT 与 Hash Join 的真实行为。以 MySQL 8.4 LTS 为基准，8.0 已于 2026 年 4 月停止官方支持，文中 8.0 的差异只用于理解存量系统。

---

## 一、EXPLAIN 字段总览

### 1、字段含义

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 123 ORDER BY create_time DESC LIMIT 10;
```

| 字段 | 含义 | 关注点 |
|------|------|--------|
| `id` | 查询序号；id 越大越先执行，相同则从上往下 | 子查询 / UNION 的执行顺序 |
| `select_type` | SIMPLE / PRIMARY / SUBQUERY / DERIVED / UNION 等 | DERIVED（派生表）常伴随物化开销 |
| `table` | 访问的表（或 `<derivedN>` / `<unionM,N>`） | — |
| `type` | **访问类型**，最重要的字段之一 | 见第二节 |
| `possible_keys` | 可能用到的索引 | 有候选但 `key` 为 NULL：优化器认为走索引不划算 |
| `key` | 实际使用的索引 | NULL 表示没走索引 |
| `key_len` | 使用的索引字节数 | 判断联合索引**用到了前几列** |
| `rows` | 预估要检查的行数 | 基于统计信息，可能有偏差 |
| `filtered` | 预估经表条件过滤后剩下的行占 `rows` 的百分比 | `rows × filtered / 100` 是传给下一张表的行数；低 filtered + 大 rows 说明大量无效扫描 |
| `Extra` | 附加信息 | 见第三节 |

### 2、输出格式：TRADITIONAL、TREE、JSON

| 写法 | 适用场景 |
|------|----------|
| `EXPLAIN ...` | 默认表格格式，快速看访问类型和索引 |
| `EXPLAIN FORMAT=TREE ...` | 按迭代器树展示执行计划，能看清 JOIN 顺序、Hash Join 的 build / probe 两侧 |
| `EXPLAIN FORMAT=JSON ...` | 带成本（`cost_info`）等完整信息，适合程序解析 |
| `EXPLAIN FORMAT=JSON INTO @var ...` | 8.4 支持把 JSON 计划存进用户变量，便于脚本化比较 |

用 `explain_format` 系统变量可以修改默认格式，例如 `SET explain_format = TREE;`。

### 3、EXPLAIN ANALYZE：预估与实际对比

普通 `EXPLAIN` 只给**预估值**，`EXPLAIN ANALYZE`（8.0.18 起）会**真正执行**语句，并在 TREE 格式中给出每个迭代器的实际耗时、实际行数和循环次数：

```sql
EXPLAIN ANALYZE
SELECT o.id, o.amount
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE u.city = '杭州' AND o.status = 'paid';
```

输出中每个节点形如：

```text
-> Nested loop inner join  (cost=... rows=120) (actual time=0.31..5.82 rows=118 loops=1)
    -> Index lookup on u using idx_city (city='杭州')  (cost=... rows=40) (actual time=0.12..0.40 rows=40 loops=1)
    -> Filter: (o.status = 'paid')  (cost=... rows=3) (actual time=0.10..0.13 rows=3 loops=40)
        -> Index lookup on o using idx_user_id (user_id=u.id)  (actual time=0.09..0.12 rows=5 loops=40)
```

阅读要点：

- `rows`（预估）与 `actual ... rows`（实际）差一个数量级以上，说明统计信息不准，先 `ANALYZE TABLE` 或建直方图（`ANALYZE TABLE t UPDATE HISTOGRAM ON col`）
- `actual time=a..b` 中 a 是返回第一行的耗时、b 是返回全部行的耗时（毫秒，包含子迭代器）；`loops` 大于 1 时是每次循环的平均值，乘以 `loops` 才是该节点总耗时
- `EXPLAIN ANALYZE` 会真正执行语句，支持 `SELECT`、多表 `UPDATE` / `DELETE` 和 `TABLE`，生产环境慎用；它固定输出 TREE 格式

---

## 二、type 访问类型

从优到劣的大致顺序：`system`、`const`、`eq_ref`、`ref`、`fulltext`、`ref_or_null`、`index_merge`、`unique_subquery` / `index_subquery`、`range`、`index`、`ALL`。

### 1、常见取值

| type | 含义 | 示例 |
|------|------|------|
| `system` | 表只有一行（系统表），`const` 的特例 | — |
| `const` | 主键 / 唯一索引等值查询，最多一行 | `WHERE id = 1` |
| `eq_ref` | JOIN 时被驱动表走主键 / 唯一非空索引，每次只匹配一行 | `JOIN b ON b.id = a.bid` |
| `ref` | 普通索引等值查询 | `WHERE name = 'Alice'` |
| `ref_or_null` | 在 `ref` 基础上额外查 NULL | `WHERE name = 'Alice' OR name IS NULL` |
| `index_merge` | 用多个索引分别扫描再合并结果（交集 / 并集） | `WHERE a = 1 OR b = 2`（a、b 各有索引） |
| `range` | 索引范围扫描 | `WHERE id > 100`、`IN`、`BETWEEN` |
| `index` | 扫描整棵索引树（索引比数据小，所以比 ALL 好） | 覆盖索引但无过滤条件 |
| `ALL` | 全表扫描 | 无可用索引 |

> **经验线**：线上核心查询至少达到 `range`，最好是 `ref` 以上；出现 `index` / `ALL` 要审视。`index_merge` 往往说明缺一个合适的联合索引。

### 2、key_len 计算

| 类型 | 字节数 |
|------|--------|
| `INT` | 4 |
| `BIGINT` | 8 |
| `DATETIME` | 5（不含小数秒） |
| `CHAR(n)`（utf8mb4） | 4n |
| `VARCHAR(n)`（utf8mb4） | 4n + 2（2 字节存长度） |
| 列允许 NULL | 额外 + 1 |

例：联合索引 `idx(a, b)`，其中 `a INT NOT NULL`、`b VARCHAR(20) NOT NULL`。`key_len = 4` 说明只用到了 `a`；`key_len = 86`（4 + 4×20 + 2）说明 `a`、`b` 都用到了。若 `a` 允许 NULL，这两个值分别变成 5 和 87。

---

## 三、Extra 常见值

| Extra | 含义 | 评价 |
|-------|------|------|
| `Using index` | 覆盖索引，无需回表 | 好 |
| `Using index condition` | 索引下推（ICP）生效 | 好 |
| `Using where` | Server 层对存储引擎返回的行再过滤 | 中性，结合 rows 和 filtered 看 |
| `Using filesort` | 需要额外排序，索引无法消除排序 | 数据量大时需要优化 |
| `Using temporary` | 使用内部临时表（常见于 GROUP BY / DISTINCT / UNION） | 需要关注 |
| `Using join buffer (hash join)` | 被驱动表无可用索引，使用 Hash Join | 给关联字段加索引通常更好 |
| `Using MRR` | 多范围读：先收集主键并排序再回表，把随机 IO 变顺序 | 好 |
| `Backward index scan` | 倒序扫描索引满足 `ORDER BY ... DESC` | 正常 |
| `Select tables optimized away` | 优化器直接用索引元数据得出结果（如 `MIN(id)`） | 好 |

两点说明：

- 8.0 起 `GROUP BY` **不再隐式排序**，需要有序结果必须显式写 `ORDER BY`；`Using temporary` 主要来自分组和去重本身
- 8.0.20 起 BNL（Block Nested-Loop）被移除，原来显示 `Using join buffer (Block Nested Loop)` 的场景，在 8.4 中都显示 `Using join buffer (hash join)`

---

## 四、慢 SQL 定位

### 1、慢查询日志

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
# 超过 1 秒记录
long_query_time = 1
# 按需开启，噪音较大
log_queries_not_using_indexes = 0
```

```bash
# pt-query-digest 聚合分析慢日志（按总耗时排序输出 TOP SQL）
pt-query-digest /var/log/mysql/slow.log > slow_report.txt
```

### 2、正在执行与历史最耗时的语句

```sql
-- 正在执行的语句（Time 列为已执行秒数）
SHOW PROCESSLIST;

-- sys schema：按语句模板汇总的历史耗时
-- statement_analysis 的 total_latency 是格式化后的字符串（如 '1.23 s'），不能直接按它排序；
-- 视图本身已按总耗时降序，或改用 x$ 前缀的原始数值视图排序
SELECT query, exec_count, total_latency, rows_examined_avg
FROM sys.statement_analysis
LIMIT 10;

SELECT query, exec_count, total_latency / 1e12 AS total_sec, rows_examined_avg
FROM sys.`x$statement_analysis`
ORDER BY total_latency DESC
LIMIT 10;
```

`sys.statements_with_full_table_scans`、`sys.statements_with_sorting` 分别列出全表扫描和排序较重的语句模板，适合做定期巡检。

### 3、Optimizer Trace：优化器为什么这么选

```sql
SET optimizer_trace = 'enabled=on';
SELECT * FROM orders WHERE user_id = 123 AND status = 'paid';
SELECT TRACE FROM information_schema.OPTIMIZER_TRACE\G
SET optimizer_trace = 'enabled=off';
```

输出的 JSON 中，`rows_estimation` 和 `considered_execution_plans` 给出每个候选索引的行数与成本估算，用于定位"为什么不走我建的索引"。

---

## 五、ORDER BY 与 filesort

### 1、filesort 不等于磁盘排序

`Using filesort` 只表示需要额外排序。MySQL 先在 `sort_buffer` 中排序（8.0.12 起按需逐步分配，最大到 `sort_buffer_size`），放不下才写临时文件做归并。

### 2、排序模式

Optimizer Trace 的 `filesort_summary.sort_mode` 给出实际采用的模式：

| sort_mode | 排序缓冲区中放什么 | 排完之后 |
|-----------|-------------------|----------|
| `<sort_key, rowid>` | 排序键 + 行 ID | 按行 ID **再回表**取需要的列 |
| `<sort_key, additional_fields>` | 排序键 + 查询需要的列（定长编码） | 直接返回，不回表 |
| `<sort_key, packed_additional_fields>` | 同上，但列值紧凑打包 | 直接返回，不回表；8.4 中最常见 |

8.0.20 起 `max_length_for_sort_data` 已弃用且不再影响排序模式的选择，不需要再调它；行很宽（如包含 TEXT / BLOB）时优化器会退回 rowid 模式。

查看排序细节：

```sql
SET optimizer_trace = 'enabled=on';
SELECT id, city, name FROM users WHERE city = '杭州' ORDER BY name LIMIT 100;
SELECT JSON_EXTRACT(TRACE, '$**.filesort_summary')
FROM information_schema.OPTIMIZER_TRACE;
SET optimizer_trace = 'enabled=off';
-- 关注 sort_mode、number_of_tmp_files（0 表示纯内存）、peak_memory_used
```

全局看是否频繁磁盘归并，可观察 `SHOW GLOBAL STATUS LIKE 'Sort_merge_passes'`。

### 3、消除 filesort：让索引天然有序

```sql
-- 只有 idx(city) 时，ORDER BY name 需要 filesort
SELECT city, name FROM users WHERE city = '杭州' ORDER BY name LIMIT 100;

-- 建联合索引 idx(city, name)：city 等值过滤后 name 天然有序
ALTER TABLE users ADD INDEX idx_city_name (city, name);
-- 再次 EXPLAIN，Extra 不再出现 Using filesort
```

---

## 六、COUNT 的性能

### 1、为什么 InnoDB 的 COUNT(*) 要扫描

InnoDB 没有像 MyISAM 那样维护总行数：在 MVCC 下，不同事务看到的"总行数"可能不同，所以 `COUNT(*)` 必须扫描索引。

8.0.13 起，不带 WHERE 的 `SELECT COUNT(*) FROM t` 走专门的优化路径：遍历**最小的二级索引**（没有二级索引时用聚簇索引），并可由 `innodb_parallel_read_threads` 并行扫描聚簇索引（8.4 默认值为逻辑 CPU 数 / 8，最小 4）。

### 2、几种写法的差异

| 写法 | 行为 | 性能 |
|------|------|------|
| `COUNT(*)` | 统计行数，不取字段值 | 最快 |
| `COUNT(1)` | 与 `COUNT(*)` 处理方式相同 | 与 `COUNT(*)` 相同 |
| `COUNT(主键)` | 需取出主键值 | 略慢 |
| `COUNT(普通字段)` | 需取值并判断 NULL，结果只统计非 NULL | 最慢，且语义不同 |

### 3、大表取总数

- 接受近似值：`information_schema.TABLES.TABLE_ROWS`、`SHOW TABLE STATUS` 或 `EXPLAIN` 的 `rows`，都是基于统计信息的估算
- 需要精确且高频：维护冗余计数表（与业务写入在同一事务内更新），或放到缓存中计数，缓存方案见 [缓存总览](/cache/0_overview)

---

## 七、JOIN 原理与优化

### 1、连接算法

![MySQL JOIN 算法：Index Nested-Loop 与 Hash Join](../../assets/database/mysql-join-algorithms.svg)

| 算法 | 触发条件 | 特点 |
|------|---------|------|
| **Index Nested-Loop Join（NLJ）** | 被驱动表关联字段**有可用索引** | 驱动表每行用索引查找被驱动表，代价约为驱动表行数 × 树高，最理想 |
| **Hash Join** | 被驱动表无可用索引（8.0.18 引入；8.0.20 起取代 BNL） | 用较小的一侧在 `join_buffer` 中建哈希表（build），另一侧逐行探测（probe）；内存不够时分片写入磁盘 |
| Block Nested-Loop（BNL） | 仅 8.0.19 及更早版本 | 驱动表分块读入 join_buffer，与被驱动表全表逐块比对；8.0.20 已移除 |

8.0.18 的 Hash Join 只用于等值连接；8.0.20 起扩展到非等值连接、笛卡尔积、外连接、半连接和反连接，`EXPLAIN FORMAT=TREE` 中显示为 `Inner hash join`、`Left hash join`、`Hash semijoin`、`Hash antijoin` 等。

### 2、优化要点

- 被驱动表的关联字段要有索引：有索引走 NLJ，没有才退到 Hash Join
- 小表驱动大表：这里的"小"指**过滤后参与 JOIN 的数据量**（行数 × 列宽），不是表的总行数
- `STRAIGHT_JOIN` 强制左表为驱动表，或用 `JOIN_ORDER` 等优化器提示，主要用于诊断
- `join_buffer_size` 默认 256KB，同时是 Hash Join 的内存上限；Hash Join 的缓冲区按需分配，调大它不会让小查询多占内存，可以适当调大以避免落盘
- 需要禁用 Hash Join 时，使用 `NO_BNL` 提示或 `optimizer_switch` 的 `block_nested_loop=off`（名称沿用历史，作用对象已是 Hash Join）

```sql
-- 诊断用：强制 small_after_filter 作为驱动表
SELECT *
FROM small_after_filter s
STRAIGHT_JOIN big b ON b.sid = s.id;

SHOW VARIABLES LIKE 'join_buffer_size';
```

> **"JOIN 不能超过 3 张表"**：JOIN 本身不是问题，被驱动表无索引、中间结果过大才是。规范限制表数量更多是为了可维护性和日后拆库的余地。

---

## 小结

- 读 `EXPLAIN` 先看 `type`、`key` / `key_len`、`rows × filtered`、`Extra`；`key_len` 计算要考虑字符集和列是否可为 NULL
- `EXPLAIN FORMAT=TREE` 看清执行顺序，`EXPLAIN ANALYZE` 会真正执行语句，对比预估与实际行数，用于判断统计信息是否失准
- 慢 SQL 定位顺序：慢日志 + `pt-query-digest`，`sys` schema（排序用 `x$` 视图的原始数值），Optimizer Trace
- `Using filesort` 不一定落盘；8.4 中通过 `sort_mode` 和 `number_of_tmp_files` 判断，`max_length_for_sort_data` 已不起作用；最好的优化是用联合索引让结果天然有序
- `COUNT(*)` 与 `COUNT(1)` 等价且最快，无 WHERE 时走最小二级索引并可并行；大表精确计数靠冗余计数
- 8.0.20 起 BNL 被 Hash Join 取代；关联字段有索引时仍是 NLJ 最优

## 参考资料

- MySQL 8.4 Reference Manual：[EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)
- MySQL 8.4 Reference Manual：[Obtaining Information with EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html#explain-analyze)
- MySQL 8.4 Reference Manual：[ORDER BY Optimization](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html)
- MySQL 8.4 Reference Manual：[Hash Join Optimization](https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html)
- MySQL 8.4 Reference Manual：[The sys Schema](https://dev.mysql.com/doc/refman/8.4/en/sys-schema.html)
- MySQL 8.0 Release Notes：[Changes in MySQL 8.0.20](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/news-8-0-20.html)
- Percona Toolkit：[pt-query-digest](https://docs.percona.com/percona-toolkit/pt-query-digest.html)

> 下一篇：[InnoDB 存储结构](./8_topic_innodb) —— 从表空间、页、行格式到 Buffer Pool、Double Write 与刷脏，理解 SQL 背后的存储层。

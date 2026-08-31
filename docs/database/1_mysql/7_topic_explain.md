# MySQL 专项 - EXPLAIN 与 SQL 优化

## 一、EXPLAIN 字段总览

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 123 ORDER BY create_time DESC LIMIT 10;
```

| 字段 | 含义 | 关注点 |
|------|------|--------|
| `id` | 查询序号，越大越先执行；相同则从上往下 | 子查询/UNION 的执行顺序 |
| `select_type` | SIMPLE / PRIMARY / SUBQUERY / DERIVED / UNION | DERIVED（派生表）常伴随物化开销 |
| `table` | 访问的表（或 `<derivedN>` / `<unionM,N>`）| — |
| `type` | **访问类型，最重要的字段之一** | 见下节等级表 |
| `possible_keys` | 可能用到的索引 | 有候选但 `key` 为 NULL → 优化器认为不划算 |
| `key` | 实际使用的索引 | NULL = 没走索引 |
| `key_len` | 使用的索引字节数 | 判断联合索引**用到了前几列** |
| `rows` | 预估扫描行数 | 越小越好，估算值可能偏差 |
| `filtered` | 存储引擎返回后 Server 层过滤的比例 | 低 filtered + 大 rows = 大量无效扫描 |
| `Extra` | 附加信息 | 见下文常见值表 |

---

## 二、type 访问类型等级

从优到劣：

```
system > const > eq_ref > ref > range > index > ALL
```

| type | 含义 | 示例 |
|------|------|------|
| `const` | 主键/唯一索引等值查询，最多一行 | `WHERE id = 1` |
| `eq_ref` | JOIN 时被驱动表走主键/唯一索引 | `JOIN b ON b.id = a.bid` |
| `ref` | 普通索引等值查询 | `WHERE name = 'Alice'` |
| `range` | 索引范围扫描 | `WHERE id > 100`、`IN`、`BETWEEN` |
| `index` | 扫全索引树（比 ALL 好在索引比数据小）| 覆盖索引但无过滤条件 |
| `ALL` | 全表扫描 | 无可用索引 |

> **经验线**：线上核心查询至少 `range` 级别，最好 `ref` 以上；出现 `index` / `ALL` 需要审视。

### key_len 快速计算

```
INT = 4；BIGINT = 8；DATETIME = 5（5.6+）
VARCHAR(n)（utf8mb4）= 4n + 2（变长）+ 1（若可 NULL）
```

联合索引 `idx(a INT, b VARCHAR(20) NOT NULL)`，若 `key_len = 4` 说明只用到了 `a`；`key_len = 86`（4 + 4×20 + 2）说明 `a`、`b` 都用到了。

---

## 三、Extra 常见值

| Extra | 含义 | 好坏 |
|-------|------|------|
| `Using index` | 覆盖索引，无需回表 | ✅ |
| `Using index condition` | 索引下推（ICP）生效 | ✅ |
| `Using where` | Server 层过滤 | 中性，结合 rows 看 |
| `Using filesort` | 内存/磁盘排序，未用索引消除排序 | ⚠️ 数据量大时优化 |
| `Using temporary` | 使用临时表（常见于 GROUP BY / DISTINCT）| ⚠️ |
| `Using join buffer (Block Nested Loop)` | 被驱动表无索引可用 | ❌ 给关联字段加索引 |
| `Select tables optimized away` | 优化器直接用索引元数据得出结果 | ✅ |

---

## 四、慢 SQL 定位

### 1、慢查询日志

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1          # 超过 1 秒记录
log_queries_not_using_indexes = 0   # 按需开启，噪音较大
```

```bash
# pt-query-digest 聚合分析慢日志（按总耗时排序输出 TOP SQL）
pt-query-digest /var/log/mysql/slow.log > slow_report.txt
```

### 2、当前正在执行的慢 SQL

```sql
-- 查看执行中的语句（Time 列为已执行秒数）
SHOW PROCESSLIST;

-- sys schema：历史最耗时的语句模板
SELECT * FROM sys.statement_analysis ORDER BY total_latency DESC LIMIT 10;
```

### 3、Optimizer Trace（分析优化器为什么这么选）

```sql
SET optimizer_trace = 'enabled=on';
SELECT * FROM orders WHERE user_id = 123 AND status = 'paid';
SELECT * FROM information_schema.OPTIMIZER_TRACE\G
SET optimizer_trace = 'enabled=off';
-- 输出 JSON：包含每个候选索引的成本估算（rows、cost），定位"为什么不走我建的索引"
```

---

## 五、ORDER BY 原理与 filesort

`Using filesort` 并不一定在磁盘排序，MySQL 优先在 `sort_buffer` 内存排序，放不下才用磁盘临时文件归并。

### 两种排序模式

| 模式 | 条件 | 过程 |
|------|------|------|
| **全字段排序** | 单行长度 ≤ `max_length_for_sort_data`（默认 4096）| 查询字段全部放入 sort_buffer 排序，排完直接返回 |
| **rowid 排序** | 单行超长 | 只把排序列 + 主键放入 sort_buffer，排完**再回表**取整行 |

```sql
-- 查看是否使用了磁盘临时文件
SET optimizer_trace = 'enabled=on';
-- 执行查询后查看 trace 中的 number_of_tmp_files（0 = 纯内存排序）
```

### 消除 filesort：让索引天然有序

```sql
-- ❌ idx(city)，ORDER BY name 需要 filesort
SELECT city, name FROM user WHERE city = '杭州' ORDER BY name LIMIT 100;

-- ✅ 建联合索引 idx(city, name)，city 等值过滤后 name 天然有序
ALTER TABLE user ADD INDEX idx_city_name(city, name);
-- EXPLAIN Extra 不再出现 Using filesort
```

---

## 六、COUNT 的性能差异

InnoDB 没有像 MyISAM 那样维护总行数（MVCC 下"总行数"因事务而异），`COUNT(*)` 必须扫描。

| 写法 | 行为 | 性能 |
|------|------|------|
| `COUNT(*)` | 官方优化的专用路径，不取字段值 | ✅ 最快（≈ COUNT(1)）|
| `COUNT(1)` | 与 `COUNT(*)` 几乎无差 | ✅ |
| `COUNT(主键)` | 需取出 id 判非空 | 略慢 |
| `COUNT(普通字段)` | 需取值 + 判 NULL | 最慢 |

> InnoDB 会自动选**最小的可用索引树**（通常是某个二级索引）来做 COUNT 扫描，而非聚簇索引。
> 大表高频取总数：考虑冗余计数表（事务内维护）或 Redis 计数，接受近似值可用 `EXPLAIN` 估算行数。

---

## 七、JOIN 原理与优化

### 三种连接算法

| 算法 | 触发条件 | 复杂度 |
|------|---------|--------|
| **Index Nested-Loop Join（NLJ）** | 被驱动表关联字段**有索引** | 驱动表 N 行 × 树高，✅ 理想 |
| **Block Nested-Loop Join（BNL）** | 被驱动表**无索引**（8.0.18 前）| 驱动表读入 join_buffer，与被驱动表全表逐块比对，❌ |
| **Hash Join** | 8.0.18+ 替代 BNL | 驱动表建哈希表，被驱动表探测，比 BNL 快一个量级 |

### 优化要点

```sql
-- 1. 被驱动表的关联字段必须有索引（决定 NLJ vs BNL/Hash）
-- 2. 小表驱动大表："小"指过滤后参与 JOIN 的行数 × 列宽，不是表总行数
SELECT * FROM small_after_filter s
STRAIGHT_JOIN big b ON b.sid = s.id;   -- STRAIGHT_JOIN 强制左表为驱动表（诊断用）

-- 3. join_buffer_size 默认 256KB，BNL/Hash Join 场景可适当调大
SHOW VARIABLES LIKE 'join_buffer_size';
```

> **"JOIN 不能超过 3 张表"的真相**：JOIN 本身不是原罪，被驱动表无索引才是。规范限制表数量更多是为了可维护性和拆库拆表的余地。

---

## 八、相关专项

- 索引结构、失效场景、深度分页 → [索引专项](./4_topic_index)
- SQL 从解析到执行的完整链路 → [SQL 执行流程专项](./6_topic_execution)

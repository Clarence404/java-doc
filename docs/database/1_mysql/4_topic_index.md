---
description: B+ 树、聚簇与二级索引、Change Buffer、覆盖索引、最左前缀、索引失效、ICP、深度分页、索引设计
---

# MySQL 索引

> **本篇目标**：理解 InnoDB 为什么用 B+ 树、聚簇索引与二级索引如何配合回表，掌握最左前缀、ICP、Skip Scan、Index Merge 等优化器行为，能判断一条 SQL 为什么没走索引，并写出正确的深度分页与索引设计方案。
>
> **前置阅读**：[MySQL 基础](./0_overview)

本文以 MySQL 8.4 LTS 为基线，涉及 8.0 与 8.4 默认值不同的地方会单独标出。执行计划各字段的读法见 [EXPLAIN 与 SQL 优化](./7_topic_explain)，Buffer Pool 与页结构见 [InnoDB 存储结构](./8_topic_innodb)。

---

## 一、B+ 树数据结构

### 1、为什么选 B+ 树

InnoDB 的索引底层是 **B+ 树**。B 树、B+ 树都是有序的多路平衡树，都能做等值、范围、排序和 `LIKE 'x%'` 前缀匹配；差别在于**效率**：

| 对比项 | B 树 | B+ 树 | 哈希索引 |
|------|------|-------|---------|
| 数据存储位置 | 所有节点都存数据 | 只在叶节点存数据 | 哈希桶 |
| 等值查询 | 支持，可能在非叶节点提前命中 | 支持，固定走到叶节点 | 支持，O(1) |
| 范围查询 / 排序 | 支持，但要中序遍历、在层间上下回溯 | 支持，定位起点后沿叶节点链表顺序扫 | 不支持 |
| `LIKE 'x%'` 前缀匹配 | 支持（本质是范围查询） | 支持（本质是范围查询） | 不支持 |
| 树高 / 磁盘 I/O | 较高：节点存数据，扇出小 | 更矮：非叶节点只存 key 与指针，扇出大 | — |

B+ 树的两个优势：非叶节点只存 key，单页能放更多 key，树更矮；叶节点用双向链表串起来，范围扫描不必回到上层节点。InnoDB 里能手工建的只有 B+ 树索引；Memory 引擎支持显式 `USING HASH`，InnoDB 只有引擎内部的自适应哈希索引（见下一节）。

### 2、三层 B+ 树能存多少行

「三层约 2000 万行」是一个估算，前提如下：

- 页大小默认 16KB
- 非叶节点每条目 = `BIGINT` 主键 8 字节 + 页指针 6 字节 ≈ 14 字节，一页约 16384 / 14 ≈ **1170** 个指针
- 叶节点每行约 1KB，一页约 **16** 行
- 三层可容纳 1170 × 1170 × 16 ≈ **2190 万行**

行越宽，叶节点每页能放的行越少，同样三层能存的行数就越少。这个数字只用来理解「树很矮、点查只需 2~3 次页访问」，不是分表阈值。

---

## 二、索引分类总览

| 分类 | 说明 | 备注 |
|------|------|------|
| **主键索引** | 即聚簇索引，叶节点存整行 | 每表一个 |
| **唯一索引** | 值唯一，可为 NULL（可有多个 NULL） | 写入需校验唯一性，用不了 Change Buffer（见第四节） |
| **普通索引** | 最常用的二级索引 | — |
| **联合索引** | 多列组成，遵守最左前缀 | 优先于多个单列索引 |
| **前缀索引** | 只索引字符串前 N 个字符 | 省空间；无法做覆盖索引，也无法用于 ORDER BY / GROUP BY |
| **函数索引** | 8.0.13+，对表达式建索引，如 `((YEAR(create_time)))` | 本质是隐藏的虚拟生成列 + 索引 |
| **降序索引** | 8.0+ 真正按降序存储，如 `(a ASC, b DESC)` | 解决混合排序方向无法用索引排序的问题 |
| **全文索引** | FULLTEXT，倒排结构 | 中文用内置 ngram 分词器（5.7.6+）；重检索场景用 Elasticsearch / OpenSearch |
| **自适应哈希索引** | InnoDB 自动为热点页建哈希（AHI） | 引擎内部行为，不可手工创建；**8.4 起默认关闭**（`innodb_adaptive_hash_index=OFF`），8.0 默认开启 |

```sql
-- 前缀索引：先评估区分度再选长度
SELECT COUNT(DISTINCT LEFT(email, 8)) / COUNT(DISTINCT email) FROM t_user;  -- 越接近 1 越好
CREATE INDEX idx_email ON t_user (email(8));

-- 中文全文检索：建索引时指定 ngram 分词器
CREATE FULLTEXT INDEX ft_title ON t_article (title) WITH PARSER ngram;
SELECT * FROM t_article WHERE MATCH(title) AGAINST('数据库' IN NATURAL LANGUAGE MODE);
```

---

## 三、聚簇索引与二级索引

### 1、聚簇索引（Clustered Index）

- **定义**：索引与数据存在一起，叶节点直接存储**完整行数据**
- InnoDB 中**主键索引 = 聚簇索引**，一张表只能有一个
- 没有显式主键时，InnoDB 选第一个所有列都 NOT NULL 的唯一索引；仍没有就用隐藏的 6 字节 `DB_ROW_ID` 建聚簇索引

**为什么一定要显式定义主键**：`DB_ROW_ID` 来自实例级的全局计数器，所有无主键表共用，6 字节用尽后从 0 重新开始，新行会覆盖同 row_id 的旧行，且这种表在复制、在线 DDL 和 CDC 工具中也更难处理。8.0.30+ 可开启 `sql_generate_invisible_primary_key=ON`，让无主键建表自动生成不可见的自增主键 `my_row_id`（GIPK）。

### 2、二级索引（Secondary Index）

- 叶节点存储 **索引列值 + 主键值**，不存完整行
- 查询时先在二级索引上找到主键，再去聚簇索引取整行，这一步叫**回表**
- 二级索引在索引列值相同时按主键有序，这个特性在深度分页的复合游标中会用到

![聚簇索引与二级索引结构](../../assets/mysql/mysql-index-structure.svg)

---

## 四、Change Buffer：普通索引与唯一索引的写入差异

更新**非唯一二级索引**时，若目标页不在 Buffer Pool，InnoDB 可以不立刻读盘，而是把变更缓存在 **Change Buffer** 中，等该页下次被读入时再合并（merge），省掉一次随机读 I/O。

**唯一索引用不了 Change Buffer**：唯一性校验必须先把页读进内存，页既然已在内存，直接改就行了。主键（聚簇索引）同理。

| 对比项 | 普通索引 | 唯一索引 |
|---|---------|---------|
| 目标页不在内存时的写入 | 可记入 Change Buffer，不读盘（需开启缓冲） | 必须读盘校验唯一性 |
| 收益最大的场景 | 写多读少（日志、流水），且二级索引页大多不在内存 | — |

**版本差异**：

- **MySQL 8.4 起 `innodb_change_buffering` 默认值为 `none`**，即默认不缓冲任何二级索引变更；8.0 默认是 `all`
- MariaDB 11.0 起彻底移除了 InnoDB Change Buffer

```sql
SHOW VARIABLES LIKE 'innodb_change_buffering';        -- 8.4 默认 none，8.0 默认 all
SHOW VARIABLES LIKE 'innodb_change_buffer_max_size';  -- 占 Buffer Pool 比例，默认 25，最大 50
```

> **选型结论**：唯一性是业务约束，应当用唯一索引来保证，不要为了性能放弃。「普通索引写入更快」只在 8.0（或 8.4 手动开启 `innodb_change_buffering`）、Buffer Pool 远小于数据量的写密集场景下成立；「写后立刻读」会马上触发 merge，Change Buffer 也没有收益。

---

## 五、回表与覆盖索引

### 1、回表（Back to Table）

```sql
-- idx_name 是 name 列的二级索引
SELECT * FROM t_user WHERE name = 'Alice';
```

执行过程：

1. 在 `idx_name` 上找到 `name='Alice'` 的条目，得到主键 `id=1`
2. 用 `id=1` 去聚簇索引取整行，这一步就是回表

每次回表都是一次聚簇索引查找，命中行多时是随机 I/O，是慢查询的常见原因。

### 2、覆盖索引（Covering Index）

查询需要的列**全部能从二级索引上拿到**，就不必回表。二级索引叶子自带主键，所以主键列也算在内：

```sql
-- 联合索引 idx_name_age(name, age)
SELECT id, name, age FROM t_user WHERE name = 'Alice';
-- 索引叶节点已包含 name、age 和主键 id，不需要回表
-- EXPLAIN Extra：Using index
```

注意两点：

- 前缀索引只存了列的前 N 个字符，无法覆盖该列
- `Using index` 才表示覆盖索引；`Using index condition` 是 ICP（见第八节），仍然要回表

---

## 六、最左前缀原则

联合索引 `idx_a_b_c(a, b, c)` 按 a、b、c 的顺序排序，只有从最左列开始连续的等值条件才能用来定位：

| 查询条件 | 用于定位的列 | 说明 |
|----------|-----------|------|
| `WHERE a = 1` | a | 命中最左列 |
| `WHERE a = 1 AND b = 2` | a, b | 连续命中 |
| `WHERE a = 1 AND b = 2 AND c = 3` | a, b, c | 全命中 |
| `WHERE b = 2` | 无 | 跳过了 a，一般不能定位；例外见下文 Skip Scan |
| `WHERE a = 1 AND c = 3` | a | c 不参与定位，但会被 ICP 在引擎层过滤 |
| `WHERE a = 1 AND b > 2 AND c = 3` | a, b | 范围截断，c 不参与定位，但会被 ICP 在引擎层过滤 |
| `WHERE a = 1 ORDER BY b` | a（排序用 b） | 索引顺序直接满足排序，无 filesort |

> **口诀**：从左开始，遇到范围（`>` / `<` / `BETWEEN` / `LIKE 'x%'`）就截断定位；截断后的列不能缩小扫描范围，但仍可在引擎层过滤，减少回表。

### 1、ICP 让截断后的列仍然有用

`a = 1 AND b > 2 AND c = 3` 中，扫描范围由 `a = 1 AND b > 2` 决定，`c = 3` 会通过索引下推在引擎层逐条检查，不满足的条目不回表。EXPLAIN 的 `Extra` 显示 `Using index condition`。所以 c 并非完全没用，只是不能减少扫描的索引条目数。

### 2、Index Skip Scan（8.0.13+）

`WHERE b = 2` 跳过了最左列 a，但在以下条件下优化器可以用**跳跃扫描**：对 a 的每个不同值做一次 `a = ? AND b = 2` 的范围扫描。

- 只涉及一张表，没有 GROUP BY / DISTINCT
- 查询只引用索引中的列（覆盖索引）
- 最左列 a 的不同值很少（例如性别、状态），否则拆出的子扫描太多，不如全扫

EXPLAIN 的 `Extra` 显示 `Using index for skip scan`，可用 `optimizer_switch` 的 `skip_scan` 或 hint `NO_SKIP_SCAN` 控制。另外，即使不能 skip scan，覆盖查询也可能选择**全扫索引**（`type=index`），因为索引比整表小。

---

## 七、索引失效的常见场景

是否走索引由**基于成本的优化器**决定：它根据统计信息和 index dive 估算扫描行数、回表次数、是否需要排序，比较各方案成本后选择。不存在「命中超过 30% 就不走索引」之类的固定阈值，一切以 `EXPLAIN` 为准。

### 1、对索引列做函数运算

```sql
-- 反例：对列调函数，B+ 树的有序性用不上
SELECT * FROM t_user WHERE YEAR(create_time) = 2024;

-- 正例一：改为范围条件
SELECT * FROM t_user WHERE create_time >= '2024-01-01' AND create_time < '2025-01-01';

-- 正例二（8.0.13+）：建函数索引，表达式必须与查询完全一致
CREATE INDEX idx_ct_year ON t_user ((YEAR(create_time)));
```

### 2、隐式类型转换

规则：**被转换的是列时索引失效，被转换的是常量时不受影响**。字符串与数字比较时，MySQL 统一按数字比较。

```sql
-- phone 是 VARCHAR 列
-- 反例：每行的 phone 都要转成数字再比较，索引失效
SELECT * FROM t_user WHERE phone = 13800138000;
-- 正例：类型一致
SELECT * FROM t_user WHERE phone = '13800138000';

-- id 是 INT 列：常量 '10' 被转换成数字，仍然走索引
SELECT * FROM t_user WHERE id = '10';
```

两表 JOIN 时关联列的字符集或排序规则不一致，也会在列上发生转换，见 [MySQL 避坑指南](./3_fallible_point)。

### 3、LIKE 左模糊

```sql
-- 反例：前置 % 无法利用索引有序性
SELECT * FROM t_user WHERE name LIKE '%Alice';

-- 正例：右模糊等价于范围查询，可走索引
SELECT * FROM t_user WHERE name LIKE 'Alice%';
```

包含匹配用全文索引（ngram）或 Elasticsearch / OpenSearch。

### 4、OR 条件

```sql
SELECT * FROM t_user WHERE name = 'Alice' OR age = 18;
```

- age 没有索引：任何一个分支都要全表扫，整体退化为全表扫描
- name、age 都有索引：优化器可以用 **Index Merge（union）** 分别扫两个索引再合并主键，EXPLAIN 显示 `type=index_merge`、`Extra: Using union(idx_name,idx_age)`，不必改写

确实需要手工改写时，必须用 `UNION` 去重，或在第二个分支里排除第一个分支已命中的行；用 `UNION ALL` 会把同时满足两个条件的行返回两次：

```sql
-- 正例一：UNION 去重（有额外的去重开销）
SELECT * FROM t_user WHERE name = 'Alice'
UNION
SELECT * FROM t_user WHERE age = 18;

-- 正例二：UNION ALL + 互斥条件
SELECT * FROM t_user WHERE name = 'Alice'
UNION ALL
SELECT * FROM t_user WHERE age = 18 AND (name <> 'Alice' OR name IS NULL);
```

两种改写都要求 age 上有索引，否则第二个分支仍是全表扫描。

### 5、NOT IN / !=

```sql
SELECT * FROM t_user WHERE status != 1;
SELECT * FROM t_user WHERE id NOT IN (1, 2, 3);
```

`!=` 和 `NOT IN` 可以转换成若干个范围，并非一定不走索引。符合条件的行占比大时，走二级索引要大量回表，优化器会算出全表扫描更便宜。能改写成正向条件时尽量改写，例如 `status IN (0, 2)`。

### 6、违反最左前缀

见第六节：跳过联合索引最左列，且不满足 Skip Scan 条件。

### 7、字段区分度极低

```sql
-- status 只有 0/1，命中半张表，回表成本高于全表扫描
SELECT * FROM t_order WHERE status = 1;
```

解决：与高区分度列组成联合索引，如 `idx_status_create_time(status, create_time)`，让 `status = ? AND create_time > ?` 能缩小范围；或者让查询变成覆盖查询。统计信息不准导致选错索引时，处理方法见 [SQL 执行流程](./6_topic_execution) 的优化器一节。

---

## 八、索引下推（ICP）

**Index Condition Pushdown**，MySQL 5.6 引入：把能用索引列判断的 WHERE 条件下推到存储引擎，在二级索引上先过滤，再回表。

![ICP 执行流对比](../../assets/mysql/mysql-icp.svg)

```sql
-- 联合索引 idx_name_age(name, age)
SELECT * FROM t_user WHERE name LIKE 'A%' AND age = 18;
```

- 没有 ICP：`name LIKE 'A%'` 命中的所有条目都回表，取出整行后由 Server 层过滤 `age = 18`
- 有 ICP：`age = 18` 在引擎层的索引条目上就检查，只有满足的才回表
- EXPLAIN 的 `Extra` 显示 `Using index condition`

ICP 只作用于二级索引（聚簇索引本身就是整行，不存在回表），目的是减少回表次数，不减少扫描的索引条目数。

---

## 九、深度分页优化

`LIMIT offset, n` 在 offset 很大时，MySQL 必须**扫描并丢弃**前 offset 行，耗时随 offset 线性增长；`SELECT *` 时被丢弃的每一行还要回表。

```sql
-- 反例：按 create_time 倒序读出 100020 行（每行回表），再丢弃前 100000 行
SELECT * FROM t_order WHERE user_id = 1001 ORDER BY create_time DESC LIMIT 100000, 20;
```

下面的写法都以联合索引 `idx_user_time(user_id, create_time)` 为前提。**不需要把 id 加进索引**：二级索引叶子本身就存了主键 id，且在 `(user_id, create_time)` 相同时按 id 有序，覆盖查询和复合游标都能直接利用。

### 1、方案一：子查询定位边界 id（按主键排序时）

```sql
SELECT * FROM t_order
WHERE id >= (SELECT id FROM t_order ORDER BY id LIMIT 100000, 1)
ORDER BY id LIMIT 10;
```

子查询按主键排序，走的是**聚簇索引**，仍要顺序读过 100000 行所在的数据页；省下的是这些行不必作为整行交给 Server 层，外层也只取 10 行。它不是覆盖二级索引，收益有限，而且只适用于无过滤条件、按 id 排序的列表。按主键翻页更推荐方案三的 `WHERE id > ?`。

### 2、方案二：延迟关联（Deferred Join）

```sql
SELECT o.* FROM t_order o
JOIN (
    SELECT id FROM t_order
    WHERE user_id = 1001
    ORDER BY create_time DESC, id DESC
    LIMIT 100000, 20
) tmp ON o.id = tmp.id
ORDER BY o.create_time DESC, o.id DESC;
```

内层只查 id，在 `idx_user_time` 上是覆盖查询（`Using index`），扫描 offset 行索引条目但不回表；外层只回表这 20 行。内外层都带上 `id DESC`，保证 `create_time` 相同时页边界确定，不会跨页重复或遗漏。延迟关联仍要扫描 offset 行索引，但**支持随机跳页**。

### 3、方案三：游标翻页（适合「下一页」场景）

```sql
-- 记录上一页最后一条的 (create_time, id) 作为游标
-- 排序值可能重复，必须带上 id 组成唯一的复合游标，否则翻页会漏数据或重复
SELECT * FROM t_order
WHERE user_id = 1001
  AND (create_time < ? OR (create_time = ? AND id < ?))
ORDER BY create_time DESC, id DESC
LIMIT 20;

-- 全量遍历（导出、迁移）：直接按主键游标
SELECT * FROM t_order WHERE id > ? ORDER BY id LIMIT 1000;
```

直接在索引上定位到游标位置再往后取 n 行，耗时与页数无关。

| 方案 | 耗时是否随页数增长 | 随机跳页 | 适用 |
|------|------------------|---------|------|
| 方案一：子查询找边界 id | 是（扫聚簇索引，但不回传整行） | 支持 | 无过滤条件、按主键排序的列表 |
| 方案二：延迟关联 | 是（只扫二级索引，不回表） | 支持 | 带过滤条件、需要跳页的后台列表 |
| 方案三：游标翻页 | 否 | 不支持 | App 下拉加载、「下一页」、全量导出 |

> **取舍**：需要随机跳页时用方案二，并在产品层面限制最大页数；纯翻页列表和批量导出用方案三。应用侧的方案选型（含限制页数、ES `search_after`）见 [数据访问性能](/high-perf/10_db_performance)。

---

## 十、索引设计原则

**该建索引的：**

- WHERE / JOIN ON / ORDER BY / GROUP BY 中的高频列
- 区分度高的列（`COUNT(DISTINCT col) / COUNT(*)` 越接近 1 越好）
- 高频查询组合建联合索引，并尽量做成覆盖索引

**不该建或慎建的：**

- 区分度极低的列单独建（性别、状态位），优化器大概率不用
- 频繁更新的列（每次更新都要维护对应的 B+ 树）
- 大字符串直接建（用前缀索引或 hash 冗余列代替）
- 一张表索引过多（写放大：每个二级索引都是一棵要维护的树，经验上限 5~6 个）

**联合索引列顺序三原则：**

1. **等值查询列在前，范围查询列在后**（范围会截断后续列的定位）
2. 区分度高的列尽量靠前
3. 兼顾 ORDER BY：`WHERE a = ? ORDER BY b` 建 `(a, b)`；混合排序方向用降序索引

```sql
-- 找出从未使用的索引（统计自实例启动以来）
SELECT * FROM sys.schema_unused_indexes WHERE object_schema = 'mydb';

-- 删除前先设为不可见观察一段时间，有问题可立即恢复
ALTER TABLE t_order ALTER INDEX idx_status INVISIBLE;
ALTER TABLE t_order ALTER INDEX idx_status VISIBLE;
```

---

## 小结

- B 树与 B+ 树都支持范围、排序和前缀匹配；B+ 树非叶节点只存 key、叶子带链表，树更矮、范围扫描更快
- 显式定义主键；无主键表依赖全局 `DB_ROW_ID`，8.0.30+ 可用 GIPK 兜底
- 二级索引叶子存主键，取整行要回表；查询列全在索引里（含主键）才是覆盖索引（`Using index`）
- Change Buffer 只服务非唯一二级索引，8.4 默认关闭（`none`），AHI 8.4 也默认关闭；不要为了性能放弃唯一索引
- 最左前缀决定定位范围；截断后的列仍可被 ICP 过滤（`Using index condition`）；跳过最左列在低基数且覆盖查询时可用 Skip Scan
- 索引失效的本质是列被变换或优化器算出更便宜的方案；OR 两侧都有索引时可走 Index Merge，手工改写要用 UNION 或互斥条件
- 深度分页：跳页用延迟关联，下一页与导出用复合游标；内外层排序都带上 id 保证分页稳定

## 参考资料

- Optimization and Indexes：[https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html](https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html)
- Clustered and Secondary Indexes：[https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- Change Buffer：[https://dev.mysql.com/doc/refman/8.4/en/innodb-change-buffer.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-change-buffer.html)
- Adaptive Hash Index：[https://dev.mysql.com/doc/refman/8.4/en/innodb-adaptive-hash.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-adaptive-hash.html)
- Index Condition Pushdown：[https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)
- Range Optimization（含 Skip Scan）：[https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)
- Index Merge Optimization：[https://dev.mysql.com/doc/refman/8.4/en/index-merge-optimization.html](https://dev.mysql.com/doc/refman/8.4/en/index-merge-optimization.html)
- Generated Invisible Primary Keys：[https://dev.mysql.com/doc/refman/8.4/en/create-table-gipks.html](https://dev.mysql.com/doc/refman/8.4/en/create-table-gipks.html)
- ngram Full-Text Parser：[https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)
- What Is New in MySQL 8.4（默认值变更）：[https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)

> 下一篇：[MySQL 事务与锁](./5_topic_transaction) —— ACID 的实现、隔离级别与 MVCC、Next-Key Lock 加锁规则、死锁排查与 redo / undo / binlog 两阶段提交。

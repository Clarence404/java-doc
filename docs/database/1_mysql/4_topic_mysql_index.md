# MySQL 专项 - 索引

## 一、B+ 树数据结构

### 为什么选 B+ 树

InnoDB 索引底层使用 **B+ 树**，而不是 B 树或哈希索引：

| 对比 | B 树 | B+ 树 | 哈希索引 |
|------|------|-------|---------|
| 数据存储位置 | 所有节点 | 只在叶节点 | 哈希桶 |
| 范围查询 | 中序遍历整棵树 | 叶节点链表直接遍历 ✅ | ❌ 不支持 |
| 排序 | ❌ | ✅ | ❌ |
| 树高/磁盘 I/O | 较高（节点存数据，扇出小） | 更矮（非叶只存 key）✅ | — |
| LIKE 前缀查询 | ❌ | ✅ | ❌ |

**B+ 树非叶节点只存索引 key，不存行数据**，单页能放更多 key，树更矮，减少磁盘 I/O。InnoDB 页大小默认 16KB，三层 B+ 树可存约 **2000 万行**。

---

## 二、聚簇索引 vs 二级索引

### 聚簇索引（Clustered Index）

- **定义**：索引与数据存在一起，叶节点直接存储**完整行数据**
- InnoDB 中，**主键索引 = 聚簇索引**，一张表只能有一个
- 若无主键，InnoDB 自动选择第一个 NOT NULL 唯一索引；否则内部生成 6 字节隐式 rowid

```
主键索引（聚簇）叶节点：
  [id=1 | name='Alice' | age=25 | ...]
  [id=2 | name='Bob'   | age=30 | ...]
```

### 二级索引（Secondary Index / 非聚簇索引）

- 叶节点存储 **索引字段值 + 主键值**，不存完整行
- 查询时先找到主键，再去聚簇索引取完整数据 → **回表**

```
name 索引（二级）叶节点：
  ['Alice' | id=1]
  ['Bob'   | id=2]
```

---

## 三、回表 & 覆盖索引

### 回表（Back to Table）

```sql
-- idx_name 是 name 字段的二级索引
SELECT * FROM user WHERE name = 'Alice';

-- 执行过程：
-- 1. 在 idx_name 上找到 name='Alice' → 得到主键 id=1
-- 2. 用 id=1 去聚簇索引取整行数据  ← 回表（额外 I/O）
```

大量回表会严重影响性能，是慢查询的常见原因。

### 覆盖索引（Covering Index）

查询所需字段**全部包含在索引中**，无需回表：

```sql
-- 联合索引 idx_name_age(name, age)
SELECT name, age FROM user WHERE name = 'Alice';
-- 索引叶节点已包含 name + age，不需要回表
-- EXPLAIN Extra 列显示：Using index
```

> **优化思路**：高频查询尽量设计覆盖索引，减少回表。

---

## 四、最左前缀原则

联合索引 `idx_a_b_c(a, b, c)` 的使用规则：

| 查询条件 | 走索引情况 | 说明 |
|----------|-----------|------|
| `WHERE a = 1` | ✅ a | 命中最左列 |
| `WHERE a = 1 AND b = 2` | ✅ a, b | 连续命中 |
| `WHERE a = 1 AND b = 2 AND c = 3` | ✅ a, b, c | 全命中 |
| `WHERE b = 2` | ❌ | 跳过了 a，索引失效 |
| `WHERE a = 1 AND c = 3` | ⚠️ 只有 a | 中间跳过 b，c 无法用 |
| `WHERE a = 1 AND b > 2 AND c = 3` | ⚠️ a, b | **范围查询截断**，b 后的列失效 |
| `WHERE a = 1 ORDER BY b` | ✅ | ORDER BY 也遵守最左前缀 |

> **口诀**：从左开始，遇到范围（`>`/`<`/`BETWEEN`/`LIKE 'x%'`）就截断。

---

## 五、索引失效的 7 种场景

### 1. 对索引列做函数运算

```sql
-- ❌ 对列调函数，MySQL 无法用索引
SELECT * FROM user WHERE YEAR(create_time) = 2024;

-- ✅ 改为范围条件
SELECT * FROM user WHERE create_time >= '2024-01-01' AND create_time < '2025-01-01';
```

### 2. 隐式类型转换

```sql
-- phone 字段是 VARCHAR，用数字查询会触发隐式转换
-- ❌ MySQL 把 phone 转成数字比较，索引失效
SELECT * FROM user WHERE phone = 13800138000;

-- ✅ 保持类型一致
SELECT * FROM user WHERE phone = '13800138000';
```

### 3. LIKE 左模糊

```sql
-- ❌ 前置 % 无法利用 B+ 树的有序性
SELECT * FROM user WHERE name LIKE '%Alice';

-- ✅ 右模糊可走索引
SELECT * FROM user WHERE name LIKE 'Alice%';

-- 需要全文搜索时，考虑 Elasticsearch
```

### 4. OR 条件存在无索引列

```sql
-- age 没有索引，整体退化为全表扫描
SELECT * FROM user WHERE name = 'Alice' OR age = 18;

-- ✅ 方案1：给 age 也加索引
-- ✅ 方案2：改用 UNION ALL
SELECT * FROM user WHERE name = 'Alice'
UNION ALL
SELECT * FROM user WHERE age = 18;
```

### 5. NOT IN / !=

```sql
-- ❌ 大多数情况下不走索引
SELECT * FROM user WHERE status != 1;
SELECT * FROM user WHERE id NOT IN (1, 2, 3);

-- ✅ 改写为正向条件（如 status IN (0, 2)）
```

### 6. 违反最左前缀

见第四节，跳过联合索引最左列直接查询中间列。

### 7. 字段区分度极低

```sql
-- status 只有 0/1，MySQL 优化器认为全表扫描比走索引代价更低，放弃索引
SELECT * FROM order WHERE status = 1;

-- 解决方案：与高区分度字段组成联合索引 idx_status_create_time(status, create_time)
```

---

## 六、索引下推（ICP）

MySQL 5.6 引入，**Index Condition Pushdown**，减少回表次数。

**无 ICP（旧行为）**：

```
存储引擎：按索引第一列找到所有满足条件的主键 → 全部回表
Server 层：对拿回来的行过滤其他索引列的条件
```

**有 ICP（5.6+）**：

```
存储引擎：在索引遍历时同时过滤所有索引列的条件
         → 只对满足全部条件的记录回表
Server 层：拿到的行已经过滤，不再需要再过滤
```

```sql
-- 联合索引 idx_name_age(name, age)
SELECT * FROM user WHERE name LIKE 'A%' AND age = 18;

-- 没有 ICP：name LIKE 'A%' 命中的所有记录全部回表，Server 层再过滤 age = 18
-- 有 ICP：age = 18 的过滤在存储引擎内完成，只回表真正满足条件的行
-- EXPLAIN Extra 显示：Using index condition
```

---

## 七、深度分页优化

`LIMIT offset, n` 在 offset 很大时，MySQL 必须**扫描并丢弃**前 offset 行，性能随 offset 线性下降。

### 方案一：子查询 + 覆盖索引

```sql
-- ❌ 慢：需要扫描 100010 行
SELECT * FROM order ORDER BY id LIMIT 100000, 10;

-- ✅ 先用覆盖索引找边界 id，再取完整行
SELECT * FROM order
WHERE id >= (SELECT id FROM order ORDER BY id LIMIT 100000, 1)
ORDER BY id LIMIT 10;
```

### 方案二：延迟关联（Deferred Join）

```sql
SELECT o.* FROM order o
JOIN (SELECT id FROM order ORDER BY id LIMIT 100000, 10) tmp
  ON o.id = tmp.id;
-- 内层子查询走覆盖索引，外层只关联必要的行
```

### 方案三：游标翻页（最优，适合"下一页"场景）

```sql
-- 记录上一页最后一条的 id（如 last_id = 100）
SELECT * FROM order WHERE id > 100 ORDER BY id LIMIT 10;

-- 原理：直接用主键索引定位，O(log n)，无需跳过前 N 行
```

> **取舍**：游标翻页不支持随机跳页（跳到第 1000 页），只能上/下翻。
> 需要随机跳页时用方案一/二；纯翻页列表用方案三。

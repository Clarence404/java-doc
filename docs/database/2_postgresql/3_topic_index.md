# PostgreSQL 专项 - 索引类型

## 一、索引类型总览

PostgreSQL 支持 **8 种**索引类型，远超 MySQL 的 B+树/哈希两种：

| 索引类型 | 适用场景 | 支持运算符 | 特点 |
|---------|---------|-----------|------|
| **B-tree** | 默认，等值/范围/排序 | `=` `<` `>` `BETWEEN` `LIKE 'x%'` | 通用，绝大多数场景首选 |
| **Hash** | 纯等值查询 | `=` | 比 B-tree 快，但不支持范围和排序 |
| **GIN** | JSONB、数组、全文搜索 | `@>` `?` `@@` | 倒排索引，查询快但写入慢 |
| **GiST** | 几何形状、地理位置、全文 | `&&` `@>` `<->` | 通用框架，支持自定义 |
| **BRIN** | 时序/物理有序大表 | `=` `<` `>` `BETWEEN` | 体积极小，写入开销几乎为零 |
| **SP-GiST** | 非平衡树（IP 段、电话号码） | `=` `<` `>` `&&` | 适合稀疏分布数据 |
| Partial Index | 只对满足条件的行建索引 | 任意 | 体积小，特定查询极快 |
| Expression Index | 对函数/表达式结果建索引 | 任意 | 对计算列查询有效 |

---

## 二、B-tree 索引

默认索引类型，原理与 MySQL 类似（B 树变体）。

```sql
-- 普通 B-tree 索引
CREATE INDEX idx_users_email ON users(email);

-- 联合索引（遵守最左前缀原则，与 MySQL 相同）
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);

-- 降序索引（PG 支持混合排序方向）
CREATE INDEX idx_orders_created_desc ON orders(created_at DESC);
```

**PG B-tree vs MySQL B+树的区别**：
- PG 的 B-tree 非叶节点也会存数据页指针，支持双向扫描
- PG 支持在同一联合索引中为不同列指定不同排序方向

---

## 三、GIN 索引（Generalized Inverted Index）

**倒排索引**，适合一列中含有多个元素的数据类型（数组、JSONB、全文搜索）。

### JSONB 场景

```sql
-- 建表
CREATE TABLE products (
  id serial PRIMARY KEY,
  attrs JSONB
);

-- 创建 GIN 索引
CREATE INDEX idx_products_attrs ON products USING GIN (attrs);

-- 以下查询走 GIN 索引
SELECT * FROM products WHERE attrs @> '{"color": "red"}';   -- 包含
SELECT * FROM products WHERE attrs ? 'size';                 -- 存在 key
SELECT * FROM products WHERE attrs #>> '{spec,weight}' = '1kg'; -- 路径查询
```

### 数组场景

```sql
CREATE TABLE articles (id serial, tags text[]);
CREATE INDEX idx_articles_tags ON articles USING GIN (tags);

SELECT * FROM articles WHERE tags @> ARRAY['java', 'spring'];  -- 包含所有
SELECT * FROM articles WHERE tags && ARRAY['java', 'go'];       -- 包含任一
```

### 全文搜索场景

```sql
CREATE TABLE docs (id serial, content text, content_ts tsvector);

-- 更新 tsvector 字段并建 GIN 索引
UPDATE docs SET content_ts = to_tsvector('english', content);
CREATE INDEX idx_docs_content ON docs USING GIN (content_ts);

SELECT * FROM docs WHERE content_ts @@ to_tsquery('java & spring');
```

> **GIN 注意**：写入性能比 B-tree 差（需维护倒排列表），适合**读多写少**场景。写入频繁时可考虑 `fastupdate = on`（延迟合并）。

---

## 四、GiST 索引（Generalized Search Tree）

通用搜索树框架，主要用于**几何/地理/范围数据**。

```sql
-- 地理位置查询（需安装 PostGIS 扩展）
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
SELECT * FROM locations WHERE ST_DWithin(geom, ST_MakePoint(116.4, 39.9)::geography, 1000);

-- 范围类型查询（PG 内置 range 类型）
CREATE TABLE reservations (room_id int, period tsrange);
CREATE INDEX idx_reservations_period ON reservations USING GIST (period);

-- 查询时间段重叠的预约（&& = overlap）
SELECT * FROM reservations WHERE period && '[2024-01-01, 2024-01-05)';

-- 最近邻查询（KNN），使用 <-> 距离运算符
SELECT * FROM locations ORDER BY geom <-> ST_MakePoint(116.4, 39.9) LIMIT 10;
```

---

## 五、BRIN 索引（Block Range Index）

**块范围索引**，只记录每个数据块范围内的最大/最小值，体积极小。

**适用条件**：列值与**物理存储顺序高度相关**（如自增 ID、时间戳、流水号）。

```sql
-- 时序表，created_at 随时间顺序写入
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  event_type text,
  created_at timestamptz DEFAULT now()
);

-- BRIN 索引体积是 B-tree 的 1/1000 以下
CREATE INDEX idx_events_created_brin ON events USING BRIN (created_at);

-- 时间范围查询走 BRIN
SELECT * FROM events WHERE created_at BETWEEN '2024-01-01' AND '2024-02-01';
```

| 对比 | B-tree | BRIN |
|------|--------|------|
| 索引体积 | 大（数据量的 10–30%） | **极小**（仅记录块级统计） |
| 写入开销 | 中 | **几乎为零** |
| 查询精度 | 精确 | 块级（可能扫描同块的无关行） |
| 适用场景 | 通用 | 物理有序大表（日志、时序） |

---

## 六、Partial Index（部分索引）

只对满足 WHERE 条件的行建立索引，**体积更小，效率更高**。

```sql
-- 只对未完成的订单建索引（完成的订单不需要频繁查询）
CREATE INDEX idx_orders_pending ON orders(user_id)
WHERE status = 'pending';

-- 查询时 WHERE 条件需包含索引的 WHERE 子句才能命中
SELECT * FROM orders WHERE user_id = 123 AND status = 'pending';  -- ✅ 命中
SELECT * FROM orders WHERE user_id = 123;                          -- ❌ 不命中

-- 软删除场景：只对未删除的行建索引
CREATE INDEX idx_users_active ON users(email) WHERE deleted_at IS NULL;
```

---

## 七、Expression Index（表达式索引）

对函数或表达式的计算结果建索引。

```sql
-- 对邮箱的小写形式建索引（实现大小写不敏感搜索）
CREATE INDEX idx_users_email_lower ON users(lower(email));

-- 查询时必须使用相同的表达式
SELECT * FROM users WHERE lower(email) = lower('Alice@Example.com');  -- ✅ 命中

-- 对 JSONB 内嵌字段建索引（比 GIN 更精准）
CREATE INDEX idx_orders_city ON orders((info->>'city'));
SELECT * FROM orders WHERE info->>'city' = 'Beijing';                 -- ✅ 命中
```

---

## 八、如何选择索引类型

```
查询类型是等值/范围/排序？
    └── 数据物理有序（时序/自增）且表很大？ → BRIN
    └── 其他 → B-tree（默认）

字段是 JSONB / 数组 / 全文搜索？
    └── GIN

字段是几何/地理 / 范围类型？
    └── GiST

只需对部分行建索引？
    └── Partial Index

查询的是函数计算结果？
    └── Expression Index
```

---

## 九、索引维护

```sql
-- 查看表上的所有索引
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'orders';

-- 查看索引使用情况（扫描次数为 0 的可能是无效索引）
SELECT schemaname, tablename, indexname,
       idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'orders'
ORDER BY idx_scan;

-- 不锁表重建索引（PG 12+）
REINDEX INDEX CONCURRENTLY idx_orders_user_created;

-- 查看索引体积
SELECT pg_size_pretty(pg_relation_size('idx_orders_user_created'));
```

---
description: 堆表与 ctid、六种索引访问方法、覆盖索引与 Index Only Scan、部分与表达式索引、选型、在线建索引与维护
---

# PostgreSQL 索引类型

> **本篇目标**：理解 PG 堆表 + 索引的存储结构与 InnoDB 聚簇索引的差别，掌握 B-tree、Hash、GIN、GiST、SP-GiST、BRIN 六种索引访问方法的适用场景，会用部分索引、表达式索引、覆盖索引，并能在线建索引、发现无用索引和处理索引膨胀。
>
> **前置阅读**：[MySQL 索引](../1_mysql/4_topic_index)、[MVCC 与 VACUUM](./2_topic_mvcc)

---

## 一、与 InnoDB 的根本差异：没有聚簇索引

![InnoDB 聚簇索引 vs PostgreSQL 堆表](../../assets/database/pg-heap-vs-clustered.svg)

- InnoDB 的表就是主键 B+ 树，二级索引叶子存主键值，查询非覆盖列要再查一次主键索引（回表）
- PG 的表是无序的堆，主键索引和其他索引没有区别，叶子里存的都是元组的物理位置 `ctid`，取整行是按 `ctid` 直接读堆页
- 因此 PG 选主键不必像 InnoDB 那样顾虑“主键越短二级索引越小”，但随机主键（UUID v4）仍会让主键索引本身插入分散、页分裂多，PG 18 可用 `uuidv7()`
- 代价在更新：非 HOT 更新会让新版本换位置，表上**所有**索引都要插入新条目，见 [MVCC 与 VACUUM](./2_topic_mvcc)
- `CLUSTER` 命令可以按某个索引把表物理重排一次，但之后的写入不会保持这个顺序，不等于聚簇索引

### 1、Index Only Scan 与可见性映射

索引里没有 MVCC 信息，只存 `ctid`，判断可见性必须看堆中的元组头。Index Only Scan 能省去堆访问的前提是：该页在**可见性映射**（visibility map）中被标记为“全部可见”，而这个标记由 VACUUM 设置。

- 刚大量写入、还没被 VACUUM 过的表，执行计划显示 Index Only Scan，但 `EXPLAIN ANALYZE` 中的 `Heap Fetches` 很高，实际仍在回堆
- 只插入的表在 13 起也会按插入量触发 autovacuum，可见性映射能及时更新

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT name, email FROM users WHERE name = 'Alice';
-- Index Only Scan using idx_users_name_incl on users
--   Heap Fetches: 0      ← 非 0 说明有页尚未标记为全部可见
```

---

## 二、索引访问方法总览

PG 内置 **6 种**索引访问方法：B-tree、Hash、GiST、SP-GiST、GIN、BRIN。部分索引、表达式索引、`INCLUDE` 覆盖索引是可以叠加在这些方法上的**特性**，不是独立类型；`bloom` 等是扩展提供的访问方法。

| 访问方法 | 适用场景 | 典型运算符 | 特点 |
|---------|---------|-----------|------|
| **B-tree** | 等值、范围、排序、前缀匹配 | `=` `<` `>` `BETWEEN` `IN` `LIKE 'x%'` | 默认类型，唯一索引只能用它 |
| **Hash** | 只有等值查询的长键 | `=` | 只存哈希值，长键时体积更小；不支持范围、排序、唯一 |
| **GIN** | 一列含多个元素：JSONB、数组、全文检索、三元组 | `@>` `<@` `&&` `?` `@@` | 倒排索引，查得快，写入与更新代价高 |
| **GiST** | 几何、地理、范围类型、最近邻 | `&&` `@>` `<->` | 平衡树框架，可做排他约束与 KNN |
| **SP-GiST** | 可递归划分的非平衡结构：四叉树、k-d 树、基数树 | 点的 `<<` `>>` `~=`、`inet` 的 `<<` `>>=`、文本前缀 `^@` | 适合分布不均匀、天然分区的数据，如 IP 段、文本前缀 |
| **BRIN** | 值与物理存储顺序强相关的大表 | `=` `<` `>` `BETWEEN` | 只存每个块范围的摘要，体积极小、精度为块级 |

MySQL 一侧也不只“B+ 树和哈希”：InnoDB 有 B+ 树、`SPATIAL`（R 树）和 `FULLTEXT`（倒排）索引；InnoDB 不能手动建 Hash 索引，只有引擎自动维护的自适应哈希索引。

---

## 三、B-tree

```sql
CREATE INDEX idx_users_email ON users (email);

-- 联合索引
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at DESC);

-- 覆盖索引（11+）：email 只存在叶子中，不参与排序和查找
CREATE INDEX idx_users_name_incl ON users (name) INCLUDE (email);
```

- **最左前缀**：和 MySQL 一样，条件里有前导列的等值时效率最高。PG 18 增加了 **skip scan**：前导列没有条件（或只有范围条件）时，优化器可以逐个跳过前导列的取值去用后续列，前导列取值很少时有效，取值多时仍会选别的计划，不能代替合理的列顺序
- **排序方向**：可以为每列单独指定 `ASC` / `DESC` 和 `NULLS FIRST` / `NULLS LAST`；MySQL 8.0 起同样支持降序与混合方向索引，这不是 PG 独有能力
- **去重**（13+）：非唯一索引中相同键值只存一次，低区分度列的索引明显变小
- **`INCLUDE`**：让更多查询走 Index Only Scan；与把列放进键里相比，`INCLUDE` 列不影响唯一约束、不参与排序，也不能用于查找条件
- 内部实现上 PG 的 B-tree（基于 Lehman-Yao 算法）与 InnoDB 的 B+ 树一样，只有叶子保存指向数据的条目，内部页只存下层页的指针；两者都能双向扫描

---

## 四、Hash

10 起 Hash 索引写 WAL、崩溃安全，可以正常使用。它只存 32 位哈希值，对很长的键（如 URL、长 token）做等值查询时比 B-tree 小；但不支持唯一约束、范围、排序和多列。多数场景 B-tree 已足够，只有在长键等值查询且索引体积成为问题时才考虑 Hash。

---

## 五、GIN（倒排索引）

### 1、JSONB

```sql
CREATE TABLE products (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attrs JSONB
);

-- 默认操作符类 jsonb_ops
CREATE INDEX idx_products_attrs ON products USING GIN (attrs);

SELECT * FROM products WHERE attrs @> '{"color": "red"}';                  -- 包含：走 GIN
SELECT * FROM products WHERE attrs ? 'size';                               -- key 存在：走 GIN
SELECT * FROM products WHERE attrs @> '{"spec": {"weight": "1kg"}}';       -- 嵌套包含：走 GIN

-- 用 #>> / ->> 取值再比较，GIN 用不上，要建表达式 B-tree 索引
CREATE INDEX idx_products_weight ON products ((attrs #>> '{spec,weight}'));
SELECT * FROM products WHERE attrs #>> '{spec,weight}' = '1kg';
```

| 操作符类 | 支持的运算符 | 特点 |
|---------|-------------|------|
| `jsonb_ops`（默认） | `@>` `?` `?|` `?&` `@?` `@@` | 索引 key 与 value，功能全 |
| `jsonb_path_ops` | `@>` `@?` `@@` | 只索引路径哈希，更小更快，但不支持 `?` 系列 key 存在判断 |

固定查询某个字段时，表达式 B-tree 索引比整列 GIN 更小、更精确；查询条件不固定、需要按任意属性过滤时才用 GIN。JSONB 的操作符与函数见 [PostgreSQL 高级 SQL](./4_topic_advanced_sql)。

### 2、数组、全文检索与模糊匹配

```sql
CREATE INDEX idx_posts_tags ON posts USING GIN (tags);
SELECT * FROM posts WHERE tags @> ARRAY['java', 'spring'];   -- 走 GIN
SELECT * FROM posts WHERE 'java' = ANY (tags);               -- 不走 GIN，改写成 @> 才行

-- 全文检索：对 STORED 生成列建 GIN，写法见高级 SQL 一篇
CREATE INDEX idx_articles_fts ON articles USING GIN (content_ts);

-- LIKE '%xx%'：pg_trgm 三元组索引
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_users_name_trgm ON users USING GIN (name gin_trgm_ops);
SELECT * FROM users WHERE name ILIKE '%ali%';
```

需要把普通标量列和 JSONB / 数组放在同一个 GIN 索引里时，用 `btree_gin` 扩展。

### 3、写入代价

GIN 每插入一行要更新多个倒排条目。默认开启的 `fastupdate` 会先把新条目写入待处理列表（pending list），等 VACUUM 或列表超过 `gin_pending_list_limit`（默认 4MB）时批量合并：写入更快，但查询要额外扫描待处理列表，合并时偶发延迟抖动。对查询延迟要求稳定的表，可以 `WITH (fastupdate = off)` 或调小 `gin_pending_list_limit`。

---

## 六、GiST 与 SP-GiST

### 1、地理位置（PostGIS）

`geometry` 与 `geography` 混用、坐标点不带 SRID 是最常见的错误：前者让索引失效，后者直接报 SRID 不一致。

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE locations (
  id   BIGINT PRIMARY KEY,
  name TEXT,
  geom geometry(Point, 4326)
);

-- 按米计算距离要用 geography，对同一表达式建索引
CREATE INDEX idx_locations_geog ON locations USING GIST ((geom::geography));
SELECT * FROM locations
WHERE ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326)::geography,
                 1000);                                   -- 1000 米内

-- 最近邻（KNN）用 geometry 列上的 GiST 索引
CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
SELECT id, name FROM locations
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326)
LIMIT 10;
```

### 2、范围类型与排他约束

```sql
CREATE TABLE reservations (room_id INT, period TSRANGE);
CREATE INDEX idx_reservations_period ON reservations USING GIST (period);

SELECT * FROM reservations WHERE period && '[2026-01-01, 2026-01-05)';   -- 时间段重叠

-- 排他约束：同一房间的预约时间段不允许重叠
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- 让 GiST 支持 INT 的 =
ALTER TABLE reservations
  ADD CONSTRAINT no_overlap EXCLUDE USING GIST (room_id WITH =, period WITH &&);
```

PG 18 起也可以用 `PRIMARY KEY (room_id, period WITHOUT OVERLAPS)` 表达同样的约束，见 [PostgreSQL 版本特性](./1_feature)。

### 3、SP-GiST

SP-GiST 适合可以递归切分空间的数据，例如 `inet` / `cidr` 的 IP 段包含查询、点数据的四叉树、文本前缀查询。

```sql
CREATE INDEX idx_ip_rules_net ON ip_rules USING SPGIST (net);
SELECT * FROM ip_rules WHERE net >>= '10.1.2.3'::inet;   -- 哪些网段包含该 IP
```

---

## 七、BRIN

BRIN 只记录每个块范围（默认 128 页）内的最小值和最大值，体积通常只有同列 B-tree 的极小一部分，几乎不增加写入开销。前提是列值与物理存储顺序强相关，例如只追加的日志表的时间列、自增 ID。

```sql
CREATE TABLE events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_events_created_brin ON events USING BRIN (created_at);
SELECT * FROM events WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01';
```

| 对比 | B-tree | BRIN |
|------|--------|------|
| 体积 | 与数据量成正比 | 极小，与块数成正比 |
| 写入开销 | 每行维护 | 几乎为零 |
| 精度 | 精确到行 | 块级，命中块内的无关行需要过滤 |
| 适用 | 通用 | 物理有序的大表；数据被频繁更新打乱顺序后效果迅速变差 |

---

## 八、部分索引与表达式索引

### 1、部分索引

只为满足条件的行建索引，体积小、维护代价低：

```sql
-- 只有待处理订单需要按用户查
CREATE INDEX idx_orders_pending ON orders (user_id) WHERE status = 'pending';

SELECT * FROM orders WHERE user_id = 123 AND status = 'pending';   -- 命中
SELECT * FROM orders WHERE user_id = 123;                          -- 不命中

-- 软删除表上的唯一约束：只约束未删除的行
CREATE UNIQUE INDEX uk_users_email_active ON users (email) WHERE deleted_at IS NULL;
```

查询条件必须能推出索引的 WHERE 条件才会命中；用 JDBC 参数绑定 `status = ?` 时，优化器在通用计划下无法证明参数等于 `'pending'`，部分索引的条件最好写成常量。

### 2、表达式索引

```sql
-- 大小写不敏感查找
CREATE INDEX idx_users_email_lower ON users (lower(email));
SELECT * FROM users WHERE lower(email) = lower('Alice@Example.com');   -- 命中

-- JSONB 中固定字段
CREATE INDEX idx_order_ext_city ON order_ext ((info ->> 'city'));
SELECT * FROM order_ext WHERE info ->> 'city' = 'Beijing';             -- 命中
```

查询中的表达式必须与索引定义一致；表达式里只能用 `IMMUTABLE` 函数。

---

## 九、如何选择

| 查询特征 | 推荐 |
|---------|------|
| 等值、范围、排序、`LIKE 'x%'` | B-tree |
| 只查固定几列，希望不回堆 | B-tree + `INCLUDE` |
| 超大的只追加表，按时间范围查 | BRIN |
| JSONB 按任意属性包含查询、数组包含 / 重叠 | GIN |
| JSONB 只查某个固定字段 | 表达式 B-tree |
| 全文检索、`LIKE '%xx%'` | GIN（`tsvector` / `pg_trgm`） |
| 地理位置、范围重叠、最近邻、排他约束 | GiST |
| IP 段、文本前缀、分布不均的点数据 | SP-GiST |
| 只有少部分行会被查询 | 部分索引 |
| 条件是函数或表达式结果 | 表达式索引 |
| 超长键的纯等值查询 | Hash |

---

## 十、索引维护

### 1、在线建索引

普通 `CREATE INDEX` 持有 `SHARE` 锁，建索引期间表上的 INSERT / UPDATE / DELETE 全部阻塞。生产环境用 `CONCURRENTLY`：

```sql
CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders (user_id, created_at);
```

- 需要两次扫描表并等待已有事务结束，耗时更长，且不能放在事务块里执行（Flyway 中要关闭该脚本的事务）
- 失败或被取消时会留下一个 `INVALID` 索引：它不参与查询，却仍要在写入时维护，必须手动删除后重建

```sql
-- 找出无效索引
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE NOT indisvalid;

DROP INDEX CONCURRENTLY idx_orders_user_created;
```

### 2、使用情况与无用索引

```sql
-- 表上的索引定义
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'orders';

-- 各索引被扫描的次数，长期为 0 的是候选删除对象
SELECT schemaname, relname, indexrelname,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname = 'orders'
ORDER BY idx_scan;
```

统计信息只反映当前节点，删除前要确认备库上的只读查询也不使用它；主键、唯一约束索引即使扫描次数为 0 也不能删。

### 3、膨胀与重建

频繁更新和删除会让索引膨胀（13 的去重与 14 的自底向上删除缓解了很多）。可以用 `pgstattuple` 扩展的 `pgstatindex()` 看叶子页密度，膨胀严重时在线重建：

```sql
SELECT avg_leaf_density, leaf_fragmentation FROM pgstatindex('idx_orders_user_created');

REINDEX INDEX CONCURRENTLY idx_orders_user_created;   -- 12+
```

---

## 小结

- PG 没有聚簇索引：表是堆，所有索引都存 `ctid`；非 HOT 更新要改全部索引，索引越多写放大越大
- Index Only Scan 依赖可见性映射，`Heap Fetches` 高说明需要 VACUUM
- 内置 6 种访问方法；部分、表达式、`INCLUDE` 是特性而非类型；MySQL 也有 R 树空间索引和全文倒排索引
- 联合索引仍以最左前缀为主，PG 18 的 skip scan 只在前导列取值少时有帮助；降序与混合方向索引 MySQL 8.0 同样支持
- JSONB 的 GIN 只支持包含与 key 存在类运算符，按字段取值比较要建表达式 B-tree；`= ANY(array)` 不走 GIN
- PostGIS 查询保持 geometry / geography 与 SRID 一致，否则索引失效或报错
- 生产建索引用 `CONCURRENTLY`，失败后清理 `INVALID` 索引；用 `pg_stat_user_indexes`（`relname` / `indexrelname`）找无用索引

## 参考资料

- 索引类型：[https://www.postgresql.org/docs/18/indexes-types.html](https://www.postgresql.org/docs/18/indexes-types.html)
- Index Only Scan 与覆盖索引：[https://www.postgresql.org/docs/18/indexes-index-only-scans.html](https://www.postgresql.org/docs/18/indexes-index-only-scans.html)
- GIN 内置操作符类：[https://www.postgresql.org/docs/18/gin.html](https://www.postgresql.org/docs/18/gin.html)
- CREATE INDEX（含 CONCURRENTLY）：[https://www.postgresql.org/docs/18/sql-createindex.html](https://www.postgresql.org/docs/18/sql-createindex.html)
- B-tree 实现说明：[https://www.postgresql.org/docs/18/btree.html](https://www.postgresql.org/docs/18/btree.html)
- PostGIS ST_DWithin：[https://postgis.net/docs/ST_DWithin.html](https://postgis.net/docs/ST_DWithin.html)

> 下一篇：[PostgreSQL 高级 SQL](./4_topic_advanced_sql) —— UPSERT 与 RETURNING、JSONB、CTE 与递归、窗口函数、全文检索、数组与 DISTINCT ON。

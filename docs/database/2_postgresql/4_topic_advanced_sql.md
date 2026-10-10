---
description: UPSERT 与 RETURNING、JSONB、递归 CTE、窗口函数与 FILTER、全文检索、数组、每组取一行
---

# PostgreSQL 高级 SQL

> 前置阅读：[PostgreSQL 基础](./0_overview)、[PostgreSQL 索引类型](./3_topic_index)

本篇讲 Java 开发中最常用的 PostgreSQL SQL 能力：`ON CONFLICT` UPSERT 与 `RETURNING`、JSONB 与数组、递归 CTE、窗口函数、内置全文检索，以及“每组取一行”和任务队列的标准写法。

---

## 一、UPSERT、RETURNING 与 MERGE

本篇示例使用下面两张表，标准 SQL 部分（CTE、窗口函数）与 MySQL 8.0 基本通用，重点关注 PG 特有的写法。

```sql
CREATE TABLE orders (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  amount     NUMERIC(12, 2) NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_ext (
  order_id BIGINT PRIMARY KEY,
  info     JSONB
);
```

### 1、INSERT ... ON CONFLICT

对应 MySQL 的 `INSERT ... ON DUPLICATE KEY UPDATE`，但必须**指明冲突目标**（唯一约束的列或约束名）：

```sql
CREATE TABLE user_stats (
  user_id     BIGINT PRIMARY KEY,
  order_count BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

-- 不存在则插入，存在则累加；EXCLUDED 代表本次尝试插入的那一行
INSERT INTO user_stats (user_id, order_count, updated_at)
VALUES (42, 1, now())
ON CONFLICT (user_id) DO UPDATE
  SET order_count = user_stats.order_count + EXCLUDED.order_count,
      updated_at  = EXCLUDED.updated_at;

-- 存在则忽略（幂等写入）
INSERT INTO user_stats (user_id, order_count, updated_at)
VALUES (42, 0, now())
ON CONFLICT (user_id) DO NOTHING;
```

- 冲突目标必须对应一个唯一索引或约束，部分唯一索引要带上相同的 `WHERE` 条件
- 和 MySQL 不同，`ON CONFLICT` 只处理指定的那一个约束，其他唯一约束冲突照常报错
- `DO UPDATE` 可加 `WHERE`，只在满足条件时更新（例如版本号更大才覆盖）

### 2、RETURNING

INSERT / UPDATE / DELETE 可以直接返回受影响的行，省去一次查询；JDBC 中当作查询执行即可拿到结果集。

```sql
INSERT INTO orders (user_id, amount, status)
VALUES (42, 199.90, 'pending')
RETURNING id, created_at;

-- 18 起可同时取修改前后的值
UPDATE orders SET status = 'paid'
WHERE id = 1001
RETURNING old.status AS before, new.status AS after;
```

MyBatis 的 `useGeneratedKeys` 在 PgJDBC 上就是通过追加 `RETURNING` 实现的。

### 3、MERGE

15 起支持 SQL 标准的 `MERGE`，17 起支持 `RETURNING`。与 `ON CONFLICT` 的取舍：

| | `INSERT ... ON CONFLICT` | `MERGE` |
|---|---|---|
| 数据来源 | 单行或 `SELECT` | 任意源表 / 子查询 |
| 分支 | 插入或更新 / 忽略 | 匹配时更新或删除、不匹配时插入，可多个条件分支 |
| 并发安全 | 基于唯一索引的推测插入，并发下不会因重复键报错 | 并发插入同一键仍可能报唯一键冲突，需要重试 |
| 适用 | 高并发的单行 UPSERT | 批量同步、数据合并 |

`MERGE` 示例见 [PostgreSQL 版本特性](./1_feature)。

---

## 二、JSONB

PG 有两种 JSON 类型：`json` 原样保存文本，`jsonb` 解析后以二进制保存（去掉重复 key、不保留 key 顺序和空白）。实际开发几乎只用 `jsonb`：支持索引，运算符更丰富。

### 1、取值与判断

```sql
INSERT INTO order_ext (order_id, info) VALUES
  (1, '{"user":"alice","city":"Beijing","tags":["vip","member"],"price":199.9}');

SELECT info -> 'user'       FROM order_ext;   -- "alice"（jsonb）
SELECT info ->> 'user'      FROM order_ext;   -- alice（text，可直接比较）
SELECT info -> 'tags' -> 0  FROM order_ext;   -- "vip"
SELECT info #>> '{tags,0}'  FROM order_ext;   -- vip（按路径取 text）
SELECT info['city']         FROM order_ext;   -- "Beijing"（14+ 下标语法，返回 jsonb）

SELECT * FROM order_ext WHERE info @> '{"city":"Beijing"}';     -- 包含子文档
SELECT * FROM order_ext WHERE info ? 'city';                     -- 存在 key
SELECT * FROM order_ext WHERE info ?| ARRAY['city','country'];   -- 存在任一 key
SELECT * FROM order_ext WHERE info ?& ARRAY['city','user'];      -- 存在全部 key
SELECT * FROM order_ext WHERE info @? '$.tags[*] ? (@ == "vip")'; -- jsonpath（12+）
```

哪些运算符能走 GIN、什么时候改用表达式索引，见 [PostgreSQL 索引类型](./3_topic_index)。

### 2、修改

```sql
UPDATE order_ext SET info = jsonb_set(info, '{city}', '"Shanghai"') WHERE order_id = 1;
UPDATE order_ext SET info['city'] = '"Shanghai"' WHERE order_id = 1;   -- 14+ 等价写法
UPDATE order_ext SET info = info - 'city' WHERE order_id = 1;           -- 删除 key
UPDATE order_ext SET info = info || '{"vip":true}' WHERE order_id = 1;  -- 合并，右侧覆盖同名 key
```

任何修改都会重写整个 JSONB 值（产生新元组），大文档频繁局部更新的代价远高于普通列，热点字段应拆成独立列。

### 3、展开为行

```sql
-- 顶层 key-value 展开
SELECT e.key, e.value FROM order_ext, jsonb_each(info) AS e WHERE order_id = 1;

-- 数组展开
SELECT t.tag FROM order_ext, jsonb_array_elements_text(info -> 'tags') AS t(tag) WHERE order_id = 1;

-- 映射成记录；user 是保留字，列名必须加双引号
SELECT * FROM jsonb_to_record('{"user":"alice","price":199.9}'::jsonb)
         AS t("user" TEXT, price NUMERIC);
```

17 起还可以用 SQL 标准的 `JSON_TABLE`、`JSON_VALUE`、`JSON_EXISTS`，示例见 [PostgreSQL 版本特性](./1_feature)。

---

## 三、CTE 与递归查询

### 1、普通 CTE

```sql
WITH monthly_sales AS (
  SELECT date_trunc('month', created_at) AS month, sum(amount) AS total
  FROM orders
  WHERE status = 'paid'
  GROUP BY 1
),
ranked AS (
  SELECT *, rank() OVER (ORDER BY total DESC) AS rk FROM monthly_sales
)
SELECT * FROM ranked WHERE rk <= 3;
```

12 起只被引用一次的 CTE 默认内联进主查询优化；需要强制先算一次时写 `AS MATERIALIZED`。PG 的 CTE 里还可以放 `INSERT / UPDATE / DELETE ... RETURNING`，在一条语句里完成“删除并归档”这类操作。

### 2、WITH RECURSIVE

适合组织架构、菜单、评论树、BOM 等层级数据：

```sql
CREATE TABLE employees (
  id         INT PRIMARY KEY,
  name       TEXT,
  manager_id INT REFERENCES employees (id)
);

-- 某人的所有下属
WITH RECURSIVE subordinates AS (
  SELECT id, name, manager_id, 0 AS depth
  FROM employees
  WHERE id = 1                                 -- 锚点

  UNION ALL

  SELECT e.id, e.name, e.manager_id, s.depth + 1
  FROM employees e
  JOIN subordinates s ON e.manager_id = s.id   -- 递归步骤
)
SELECT * FROM subordinates ORDER BY depth, id;
```

数据里一旦出现环（A 的上级是 B、B 的上级又是 A），上面的查询会无限循环。14 起可以用 `SEARCH` / `CYCLE` 子句：

```sql
WITH RECURSIVE tree AS (
  SELECT id, name, manager_id FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, e.manager_id
  FROM employees e JOIN tree t ON e.manager_id = t.id
)
SEARCH DEPTH FIRST BY id SET ord          -- 按深度优先顺序生成排序列 ord
CYCLE id SET is_cycle USING path          -- 遇到重复 id 标记为环并停止展开
SELECT id, name, path FROM tree WHERE NOT is_cycle ORDER BY ord;
```

14 之前要手动维护路径数组，用 `NOT e.id = ANY(path)` 判断是否成环。

---

## 四、窗口函数与聚合增强

窗口函数在不合并行的前提下对一组相关行做计算：

```sql
function_name(args) OVER (
  PARTITION BY ...          -- 分组，不折叠行
  ORDER BY ...              -- 组内排序
  ROWS | RANGE | GROUPS ... -- 窗口帧
)
```

### 1、排名与前后行

```sql
SELECT user_id, id, amount,
  ROW_NUMBER() OVER w AS rn,      -- 连续编号
  RANK()       OVER w AS rnk,     -- 并列跳号
  DENSE_RANK() OVER w AS drk,     -- 并列不跳号
  LAG(amount)  OVER w AS prev_amount
FROM orders
WINDOW w AS (PARTITION BY user_id ORDER BY amount DESC);
```

### 2、累计与移动窗口

`ROWS` 按行数取窗口，`RANGE` 按排序值的距离取窗口（11 起支持带偏移量的 `RANGE`）。“近 7 天”这种按时间的窗口要用 `RANGE`，或者先按天聚合：

```sql
-- 先按天汇总，再做 7 天移动平均：每天一行时 ROWS 6 PRECEDING 才等于 7 天
WITH daily AS (
  SELECT created_at::date AS day, sum(amount) AS revenue
  FROM orders
  GROUP BY 1
)
SELECT day, revenue,
       SUM(revenue) OVER (ORDER BY day) AS cumulative,
       AVG(revenue) OVER (ORDER BY day
                          RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW) AS avg_7d
FROM daily;
```

用 `RANGE` 时缺失的日期不会被当作 0 计入；直接对明细行写 `ROWS BETWEEN 6 PRECEDING` 得到的是“最近 7 笔订单”，不是 7 天。

### 3、FILTER 与 GROUPING SETS

```sql
-- 条件聚合，比 SUM(CASE WHEN ...) 清晰
SELECT user_id,
       count(*)                                   AS total,
       count(*) FILTER (WHERE status = 'paid')    AS paid,
       sum(amount) FILTER (WHERE status = 'paid') AS paid_amount
FROM orders
GROUP BY user_id;

-- 一次查询同时出明细小计与总计
SELECT status, date_trunc('month', created_at) AS month, sum(amount)
FROM orders
GROUP BY ROLLUP (status, date_trunc('month', created_at));
```

---

## 五、全文检索

PG 内置全文检索，能满足站内搜索、后台检索这类中等规模的需求；需要复杂相关性排序、聚合分析、海量数据横向扩展时再上 Elasticsearch，边界见 [搜索数据库](../4_nosql/3_search_db)。

| 类型 | 说明 |
|------|------|
| `tsvector` | 文档分词、归一化后的词素及位置 |
| `tsquery` | 查询表达式，支持 `&`、`|`、`!`、`<->`（相邻） |

```sql
SELECT to_tsvector('english', 'PostgreSQL is an advanced open-source database');
-- 'advanc':4 'databas':8 'open':6 'open-sourc':5 'postgresql':1 'sourc':7
-- 停用词 is / an 被去掉，词干化后 advanced → advanc，连字符词同时保留整体和各部分

SELECT to_tsquery('english', 'postgres & database');
SELECT websearch_to_tsquery('english', 'postgres -oracle "open source"');   -- 搜索框语法，适合直接接用户输入
```

### 1、建列、建索引与查询

```sql
CREATE TABLE articles (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT,
  body       TEXT,
  content_ts TSVECTOR GENERATED ALWAYS AS
             (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED
);

CREATE INDEX idx_articles_fts ON articles USING GIN (content_ts);

SELECT id, title, ts_rank(content_ts, q) AS rank
FROM articles, to_tsquery('english', 'java & spring') AS q
WHERE content_ts @@ q
ORDER BY rank DESC
LIMIT 20;

-- 高亮片段；所有函数都显式传入同一个分词配置
SELECT ts_headline('english', body, to_tsquery('english', 'java & spring'),
                   'MaxFragments=2, MinWords=10, MaxWords=20')
FROM articles WHERE id = 1;
```

用 `STORED` 生成列保存 `tsvector`，数据更新时自动重算，不会出现手工维护的列过期的问题。

### 2、中文

内置配置只按空格和标点切词，中文需要分词扩展，如 `zhparser`（基于 SCWS）或 `pg_jieba`，安装后创建对应的文本检索配置，用法与 `'english'` 相同；只做简单的包含匹配时，`pg_trgm` 也是一个选择（见 [PostgreSQL 索引类型](./3_topic_index)）。

---

## 六、数组

PG 原生支持数组列，适合标签、少量枚举值这类“只随主行一起读写”的多值属性：

```sql
CREATE TABLE posts (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title  TEXT,
  tags   TEXT[],
  scores INTEGER[]
);

INSERT INTO posts (title, tags, scores)
VALUES ('PG Array', ARRAY['database', 'postgres'], ARRAY[95, 87, 92]);

SELECT * FROM posts WHERE tags @> ARRAY['database'];           -- 包含全部（GIN 可加速）
SELECT * FROM posts WHERE tags && ARRAY['postgres', 'mysql'];  -- 有交集（GIN 可加速）
SELECT * FROM posts WHERE 'postgres' = ANY (tags);              -- 结果相同，但不走 GIN

UPDATE posts SET tags = array_append(tags, 'jvm') WHERE id = 1;
SELECT id, unnest(tags) AS tag FROM posts;                      -- 展开为行
SELECT array_agg(DISTINCT status ORDER BY status) FROM orders;  -- 聚合为数组
SELECT cardinality(scores) FROM posts;                          -- 元素个数
```

这些运算在没有索引时也能执行，只是全表扫描；GIN 只负责加速。使用数组意味着放弃外键约束和按元素关联查询的便利，元素需要被单独引用、需要维护属性或数量无上限时，仍应拆成关联表。

---

## 七、每组取一行与任务队列

### 1、每组取一行

“每个用户最新一笔订单”有三种写法：

```sql
-- 写法一：DISTINCT ON（PG 特有），DISTINCT ON 的列必须排在 ORDER BY 最前面
SELECT DISTINCT ON (user_id) user_id, id AS order_id, created_at, amount
FROM orders
ORDER BY user_id, created_at DESC;

-- 写法二：窗口函数（标准 SQL，MySQL 8.0 通用）
SELECT * FROM (
  SELECT o.*, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders o
) t
WHERE rn = 1;

-- 写法三：LATERAL + LIMIT 1，配合 (user_id, created_at DESC) 索引
SELECT u.id AS user_id, o.id AS order_id, o.created_at, o.amount
FROM users u
CROSS JOIN LATERAL (
  SELECT id, created_at, amount
  FROM orders
  WHERE orders.user_id = u.id
  ORDER BY created_at DESC
  LIMIT 1
) o;
```

`DISTINCT ON` 的优势在于写法简洁，并不更快：前两种写法都要读完全部订单再排序或去重。每个用户订单很多、用户表相对小时，`LATERAL` 对每个用户只走一次索引取一行，通常快得多。

### 2、FOR UPDATE SKIP LOCKED

用数据库表做任务队列时，多个 worker 并发领取任务互不阻塞：

```sql
WITH next_jobs AS (
  SELECT id FROM jobs
  WHERE status = 'ready'
  ORDER BY id
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs SET status = 'running', started_at = now()
FROM next_jobs
WHERE jobs.id = next_jobs.id
RETURNING jobs.id;
```

`SKIP LOCKED` 跳过已被其他事务锁住的行，MySQL 8.0 也支持同样的语法。

---

## 小结

- UPSERT 用 `INSERT ... ON CONFLICT (目标) DO UPDATE / DO NOTHING`，`EXCLUDED` 引用待插入行；高并发单行写入优先它，批量合并用 `MERGE`
- `RETURNING` 让写操作直接返回生成的主键和字段值，18 起可取 `old` / `new`
- JSONB 是 JSON 的首选：`->` 返回 jsonb、`->>` 返回 text，`@>` / `?` 类运算符可走 GIN；保留字列名要加双引号
- 递归 CTE 处理层级数据，14 起用 `SEARCH` / `CYCLE` 控制顺序和防止环
- 按时间的移动窗口用 `RANGE ... INTERVAL` 或先按天聚合；条件聚合用 `FILTER`
- 内置全文检索用 `STORED` 生成列 + GIN，所有函数显式指定分词配置；中文需要分词扩展
- 数组适合随主行读写的多值属性，`= ANY` 不走 GIN；需要约束与关联时仍拆表
- 每组取一行：`DISTINCT ON` 简洁，`LATERAL ... LIMIT 1` 往往更快；任务队列用 `FOR UPDATE SKIP LOCKED`

## 参考资料

- INSERT 与 ON CONFLICT：[https://www.postgresql.org/docs/18/sql-insert.html](https://www.postgresql.org/docs/18/sql-insert.html)
- MERGE：[https://www.postgresql.org/docs/18/sql-merge.html](https://www.postgresql.org/docs/18/sql-merge.html)
- JSON 函数与运算符：[https://www.postgresql.org/docs/18/functions-json.html](https://www.postgresql.org/docs/18/functions-json.html)
- WITH 查询：[https://www.postgresql.org/docs/18/queries-with.html](https://www.postgresql.org/docs/18/queries-with.html)
- 窗口函数：[https://www.postgresql.org/docs/18/tutorial-window.html](https://www.postgresql.org/docs/18/tutorial-window.html)
- 全文检索：[https://www.postgresql.org/docs/18/textsearch.html](https://www.postgresql.org/docs/18/textsearch.html)
- 数组：[https://www.postgresql.org/docs/18/arrays.html](https://www.postgresql.org/docs/18/arrays.html)
- SELECT（DISTINCT ON、LATERAL、SKIP LOCKED）：[https://www.postgresql.org/docs/18/sql-select.html](https://www.postgresql.org/docs/18/sql-select.html)

> 下一篇：[PostgreSQL 复制与高可用](./5_topic_replication) —— 进程模型、WAL 流复制与同步级别、复制槽、逻辑复制，以及 Patroni 等故障切换方案。

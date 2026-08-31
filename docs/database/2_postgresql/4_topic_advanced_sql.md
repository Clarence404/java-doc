# PostgreSQL 专项 - 高级 SQL

## 一、JSONB

PostgreSQL 提供两种 JSON 类型：`json`（原样存储文本）和 `jsonb`（解析后以二进制存储）。
**实践中几乎只用 `jsonb`**：支持索引、操作符更丰富、查询更快。

### 基本操作符

```sql
CREATE TABLE orders (id serial, info JSONB);
INSERT INTO orders(info) VALUES
  ('{"user":"alice","city":"Beijing","tags":["vip","member"],"price":199.9}');

-- -> 返回 JSONB，->> 返回 text
SELECT info -> 'user'        FROM orders;  -- "alice"（JSONB）
SELECT info ->> 'user'       FROM orders;  -- alice（text，可直接比较）
SELECT info -> 'tags' -> 0   FROM orders;  -- "vip"（数组取第0个元素）
SELECT info #>> '{tags, 0}'  FROM orders;  -- vip（路径表达式，text）

-- 包含判断
SELECT * FROM orders WHERE info @> '{"city":"Beijing"}';    -- info 包含这个子集
SELECT * FROM orders WHERE info ? 'city';                    -- 存在 key 'city'
SELECT * FROM orders WHERE info ?| ARRAY['city','country']; -- 存在任一 key
SELECT * FROM orders WHERE info ?& ARRAY['city','user'];    -- 同时存在所有 key
```

### 更新 JSONB 字段

```sql
-- 设置/覆盖某个 key
UPDATE orders SET info = jsonb_set(info, '{city}', '"Shanghai"');

-- 删除某个 key
UPDATE orders SET info = info - 'city';

-- 合并（|| 运算符，右侧覆盖左侧同名 key）
UPDATE orders SET info = info || '{"vip":true}';
```

### 结合 GIN 索引

```sql
CREATE INDEX idx_orders_info ON orders USING GIN (info);

-- 走 GIN 索引
SELECT * FROM orders WHERE info @> '{"city":"Beijing"}';
SELECT * FROM orders WHERE info ? 'tags';
```

### 展开 JSONB

```sql
-- jsonb_each：将顶层 key-value 展开为行
SELECT key, value FROM orders, jsonb_each(info) WHERE id = 1;

-- jsonb_array_elements：展开数组
SELECT elem FROM orders, jsonb_array_elements(info->'tags') AS elem WHERE id = 1;

-- jsonb_to_record / jsonb_populate_record：映射到行类型
SELECT * FROM json_to_record('{"user":"alice","price":199.9}')
         AS t(user text, price numeric);
```

---

## 二、CTE 与 WITH RECURSIVE

### 普通 CTE（公共表表达式）

```sql
-- 提高可读性，将复杂子查询提取为命名块
WITH
  monthly_sales AS (
    SELECT date_trunc('month', created_at) AS month,
           sum(amount) AS total
    FROM orders
    WHERE status = 'paid'
    GROUP BY 1
  ),
  ranked AS (
    SELECT *, rank() OVER (ORDER BY total DESC) AS rk
    FROM monthly_sales
  )
SELECT * FROM ranked WHERE rk <= 3;
```

> PG 12 之前 CTE 是**优化栅栏**（强制物化），PG 12+ 默认可内联优化。需要强制物化时加 `MATERIALIZED`。

### WITH RECURSIVE（递归查询）

适合**树形结构、层级数据**（组织架构、菜单、BOM 物料清单）。

```sql
CREATE TABLE employees (
  id int PRIMARY KEY,
  name text,
  manager_id int REFERENCES employees(id)
);

-- 查询某员工的所有下属（递归展开组织树）
WITH RECURSIVE subordinates AS (
  -- 1. 初始成员（锚点）
  SELECT id, name, manager_id, 0 AS depth
  FROM employees
  WHERE id = 1   -- 从 CEO 开始

  UNION ALL

  -- 2. 递归步骤：找到上一轮结果的直接下属
  SELECT e.id, e.name, e.manager_id, s.depth + 1
  FROM employees e
  JOIN subordinates s ON e.manager_id = s.id
)
SELECT * FROM subordinates ORDER BY depth, id;
```

```sql
-- 路径追踪：找出从根到叶的完整路径
WITH RECURSIVE tree AS (
  SELECT id, name, manager_id, name::text AS path
  FROM employees WHERE manager_id IS NULL

  UNION ALL

  SELECT e.id, e.name, e.manager_id, t.path || ' > ' || e.name
  FROM employees e
  JOIN tree t ON e.manager_id = t.id
)
SELECT id, path FROM tree;
```

---

## 三、窗口函数（Window Functions）

窗口函数在**不折叠行**的情况下对关联行集合进行聚合计算，比 GROUP BY 更灵活。

### 语法结构

```sql
function_name(args) OVER (
  [PARTITION BY col1, col2]  -- 分组（不折叠行）
  [ORDER BY col3]             -- 组内排序
  [ROWS/RANGE frame_spec]     -- 窗口帧（计算范围）
)
```

### 排名函数

```sql
SELECT
  name,
  department,
  salary,
  ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rn,   -- 唯一排名
  RANK()       OVER (PARTITION BY department ORDER BY salary DESC) AS rnk,  -- 并列跳号
  DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS drk,  -- 并列不跳号
  NTILE(4)     OVER (PARTITION BY department ORDER BY salary DESC) AS quartile  -- 分四组
FROM employees;
```

### 前后行访问

```sql
SELECT
  month,
  revenue,
  LAG(revenue, 1) OVER (ORDER BY month)  AS prev_month,    -- 上一行
  LEAD(revenue, 1) OVER (ORDER BY month) AS next_month,    -- 下一行
  revenue - LAG(revenue, 1) OVER (ORDER BY month) AS mom_diff  -- 环比差值
FROM monthly_revenue;
```

### 累计聚合

```sql
SELECT
  created_at::date AS day,
  amount,
  SUM(amount) OVER (ORDER BY created_at)                             AS cumulative_total,
  AVG(amount) OVER (ORDER BY created_at ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg_7d
FROM orders;
```

### 取组内第一/最后

```sql
-- 每个用户最新的一条订单
SELECT DISTINCT ON (user_id)
  user_id, id AS order_id, created_at, amount
FROM orders
ORDER BY user_id, created_at DESC;
```

---

## 四、全文搜索

PostgreSQL 内置全文搜索，无需 Elasticsearch 即可满足基本场景。

### 核心类型

| 类型 | 说明 |
|------|------|
| `tsvector` | 文档的词素向量（归一化后的词列表）|
| `tsquery` | 搜索查询表达式 |

```sql
-- 文本转词向量
SELECT to_tsvector('english', 'PostgreSQL is an advanced open-source database');
-- 结果：'advanced':4 'databas':7 'open-sourc':5 'postgresql':1

-- 搜索表达式
SELECT to_tsquery('english', 'postgres & database');
SELECT to_tsquery('english', 'postgres | mysql');
SELECT to_tsquery('english', 'database & !oracle');  -- 包含 database 且不含 oracle
```

### 实际使用

```sql
ALTER TABLE articles ADD COLUMN content_ts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) STORED;

CREATE INDEX idx_articles_fts ON articles USING GIN (content_ts);

-- 全文搜索
SELECT id, title, ts_rank(content_ts, query) AS rank
FROM articles, to_tsquery('english', 'java & spring') query
WHERE content_ts @@ query
ORDER BY rank DESC
LIMIT 20;

-- 高亮显示匹配片段
SELECT ts_headline('english', body, to_tsquery('java & spring'),
                   'MaxFragments=2, MinWords=10, MaxWords=20')
FROM articles WHERE id = 1;
```

> **中文全文搜索**：需安装 `pg_jieba` 或 `zhparser` 扩展，替换分词器。

---

## 五、Array 类型

PostgreSQL 原生支持**数组字段**，不需要范式拆表。

```sql
CREATE TABLE posts (
  id serial PRIMARY KEY,
  title text,
  tags text[],
  scores integer[]
);

INSERT INTO posts(title, tags, scores)
VALUES ('PG Array', ARRAY['database','postgres'], ARRAY[95, 87, 92]);

-- 查询包含某个元素
SELECT * FROM posts WHERE 'postgres' = ANY(tags);

-- 数组包含（需 GIN 索引）
SELECT * FROM posts WHERE tags @> ARRAY['database'];

-- 数组交集（任一匹配）
SELECT * FROM posts WHERE tags && ARRAY['postgres','mysql'];

-- 展开数组为行
SELECT id, unnest(tags) AS tag FROM posts;

-- 数组聚合
SELECT array_agg(DISTINCT status ORDER BY status) FROM orders;
```

---

## 六、DISTINCT ON

PG 特有语法，**按指定列去重，保留每组的第一行**（等价于 MySQL 的 `ROW_NUMBER() ... WHERE rn=1` 写法）：

```sql
-- 每个用户的最新订单
SELECT DISTINCT ON (user_id)
  user_id, id, created_at, amount
FROM orders
ORDER BY user_id, created_at DESC;  -- DISTINCT ON 的列必须出现在 ORDER BY 最前面

-- 等价的窗口函数写法（更通用）
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders
) t WHERE rn = 1;
```

`DISTINCT ON` 写法更简洁，PG 优化器对其支持也更好。

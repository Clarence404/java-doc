# Mysql 5.7 / 8.0 / 8.4 / 9.x 特性

## 一、MySQL 5.7 重要特性

### 1、JSON 数据类型

原生支持 JSON 字段存储与索引，提供丰富的 JSON 函数：

```sql
CREATE TABLE config (
  id   INT PRIMARY KEY,
  data JSON
);

INSERT INTO config VALUES (1, '{"host":"127.0.0.1","port":3306,"tags":["db","primary"]}');

-- -> 返回 JSON，->> 返回字符串
SELECT data -> '$.host'      FROM config WHERE id = 1;  -- "127.0.0.1"
SELECT data ->> '$.host'     FROM config WHERE id = 1;  -- 127.0.0.1
SELECT data -> '$.tags[0]'   FROM config WHERE id = 1;  -- "db"

-- JSON 函数
SELECT JSON_EXTRACT(data, '$.port')        FROM config;  -- 3306
SELECT JSON_CONTAINS(data, '"primary"', '$.tags');       -- 1

-- 修改 JSON 字段
UPDATE config SET data = JSON_SET(data, '$.port', 3307) WHERE id = 1;
UPDATE config SET data = JSON_ARRAY_APPEND(data, '$.tags', 'replica') WHERE id = 1;
```

### 2、虚拟生成列（Generated Columns）

```sql
CREATE TABLE orders (
  id         BIGINT PRIMARY KEY,
  created_at DATETIME,
  -- VIRTUAL：不存储，查询时计算（默认）
  year_val   INT AS (YEAR(created_at)) VIRTUAL,
  -- STORED：物理存储，可建索引
  year_stored INT AS (YEAR(created_at)) STORED
);

-- 对 STORED 列建索引（实现函数索引）
CREATE INDEX idx_year ON orders(year_stored);

-- 查询时可直接使用，走索引
SELECT * FROM orders WHERE year_stored = 2024;
```

### 3、InnoDB 在线 DDL 增强

更多操作支持 `ALGORITHM=INPLACE`，减少锁表时间：

| DDL 操作 | 5.6 | 5.7 |
|---------|-----|-----|
| 添加列 | COPY（锁表）| INPLACE（部分场景）|
| 添加索引 | INPLACE | INPLACE |
| 修改列类型 | COPY | COPY（仍需锁表）|
| 重命名列 | COPY | INPLACE |

```sql
-- 在线添加索引（不锁表）
ALTER TABLE orders ADD INDEX idx_status (status), ALGORITHM=INPLACE, LOCK=NONE;
```

### 4、sys Schema

5.7 内置 `sys` 库，简化性能诊断：

```sql
-- 查看最耗时的 SQL
SELECT * FROM sys.statement_analysis ORDER BY total_latency DESC LIMIT 10;

-- 查看当前锁等待
SELECT * FROM sys.innodb_lock_waits;

-- 查看未使用的索引
SELECT * FROM sys.schema_unused_indexes WHERE object_schema = 'mydb';

-- 查看 IO 最高的表
SELECT * FROM sys.io_global_by_file_by_bytes LIMIT 10;
```

### 5、其他改进

- **组复制（Group Replication）**：原生支持多主复制，提供高可用基础
- **多源复制**：一个从库可从多个主库复制
- **Performance Schema 增强**：语句级、阶段级统计更完善，完全替代 `SHOW PROFILE`

---

## 二、MySQL 8.0 重要特性

### 1、窗口函数（Window Functions）

```sql
SELECT name, department, salary,
  RANK()       OVER (PARTITION BY department ORDER BY salary DESC) AS rnk,
  DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dense_rnk,
  ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rn,
  LAG(salary,  1, 0) OVER (PARTITION BY department ORDER BY salary DESC) AS prev_salary,
  LEAD(salary, 1, 0) OVER (PARTITION BY department ORDER BY salary DESC) AS next_salary,
  SUM(salary)  OVER (PARTITION BY department ORDER BY salary DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
FROM employees;
```

### 2、CTE 公共表表达式（WITH）

```sql
-- 普通 CTE：提升可读性
WITH monthly AS (
  SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, SUM(amount) AS total
  FROM orders GROUP BY 1
)
SELECT * FROM monthly WHERE total > 10000;

-- 递归 CTE：查询组织树
WITH RECURSIVE org AS (
  SELECT id, name, manager_id, 0 AS depth
  FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, e.manager_id, o.depth + 1
  FROM employees e JOIN org o ON e.manager_id = o.id
)
SELECT * FROM org ORDER BY depth;
```

### 3、不可见索引（Invisible Index）

安全测试"删除索引"的影响，不真正删除：

```sql
-- 将索引设为不可见（优化器忽略，但仍维护索引结构）
ALTER TABLE orders ALTER INDEX idx_status INVISIBLE;

-- 强制使用不可见索引（验证）
SELECT /*+ USE_INDEX(orders, idx_status) */ * FROM orders WHERE status = 'paid';

-- 确认无影响后再真正删除
DROP INDEX idx_status ON orders;
```

### 4、降序索引（Descending Index）

```sql
-- 8.0 之前：语法合法但按 ASC 存储，ORDER BY DESC 仍需 filesort
-- 8.0：真正按降序存储，消除 ORDER BY DESC 的 filesort
CREATE INDEX idx_created_desc ON orders(created_at DESC);

-- 混合排序方向，8.0 可直接利用索引
CREATE INDEX idx_multi ON orders(status ASC, created_at DESC);
SELECT * FROM orders WHERE status = 'paid' ORDER BY created_at DESC;  -- 无 filesort
```

### 5、原子 DDL

DDL 操作（CREATE/DROP/RENAME TABLE 等）具备原子性：

```sql
-- 8.0 之前：DROP TABLE t1, t2 若 t1 成功 t2 失败，t1 已被删除（无法回滚）
-- 8.0：要么全部成功，要么全部回滚
DROP TABLE t1, t2;

-- RENAME 也是原子的
RENAME TABLE old_name TO new_name;
```

### 6、角色管理（Role）

```sql
-- 创建角色
CREATE ROLE 'app_readonly', 'app_readwrite';

-- 给角色授权
GRANT SELECT ON mydb.* TO 'app_readonly';
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite';

-- 将角色赋给用户
GRANT 'app_readonly' TO 'report_user'@'%';
GRANT 'app_readwrite' TO 'app_user'@'%';

-- 激活角色（重要：角色需激活后才生效）
SET DEFAULT ROLE ALL TO 'app_user'@'%';
```

### 7、JSON 增强

```sql
-- JSON_TABLE：将 JSON 数组展开为关系表
SELECT jt.*
FROM orders,
     JSON_TABLE(items, '$[*]' COLUMNS (
       product_id INT    PATH '$.id',
       qty        INT    PATH '$.qty',
       price      DOUBLE PATH '$.price'
     )) AS jt;

-- 多值索引（Multi-Valued Index，8.0.17+）
CREATE TABLE posts (id INT, tags JSON);
CREATE INDEX idx_tags ON posts ((CAST(tags -> '$[*]' AS CHAR(50) ARRAY)));

-- 走多值索引
SELECT * FROM posts WHERE 'java' MEMBER OF (tags -> '$[*]');
SELECT * FROM posts WHERE JSON_OVERLAPS(tags, '["java","go"]');
```

### 8、InnoDB 改进

| 特性 | 说明 |
|------|------|
| 自增持久化 | AUTO_INCREMENT 计数器写入 redo log，重启后不回退 |
| Redo log 动态调整 | 8.0.30+ 支持在线修改 `innodb_redo_log_capacity` |
| 死锁检测可关闭 | `innodb_deadlock_detect = OFF` 减少高并发检测开销 |
| 并行读取 | InnoDB 支持并行扫描，加速全表分析 |

### 9、默认字符集 utf8mb4

```sql
-- 8.0 默认字符集：utf8mb4，排序规则：utf8mb4_0900_ai_ci
-- ai = accent insensitive（重音不敏感）
-- ci = case insensitive（大小写不敏感）
SHOW VARIABLES LIKE 'character_set_database';  -- utf8mb4
SHOW VARIABLES LIKE 'collation_database';       -- utf8mb4_0900_ai_ci
```

### 10、直方图统计（Histogram）

```sql
-- 收集列的值分布统计，帮助优化器选择更好执行计划
ANALYZE TABLE orders UPDATE HISTOGRAM ON status, amount WITH 64 BUCKETS;

-- 查看直方图
SELECT HISTOGRAM->>'$."number-of-buckets-specified"',
       HISTOGRAM->>'$."data-type"'
FROM information_schema.COLUMN_STATISTICS
WHERE TABLE_NAME = 'orders' AND COLUMN_NAME = 'status';

-- 删除直方图
ANALYZE TABLE orders DROP HISTOGRAM ON status;
```

---

## 三、MySQL 8.4 LTS 重要变化

MySQL 8.4 于 **2024 年 4 月**发布，是继 8.0 之后的下一个**长期支持版本（LTS）**，支持维护至 2032 年。

### 1、`mysql_native_password` 默认禁用

8.4 将 `mysql_native_password` 身份验证插件**默认禁用**（8.0 中已弃用，9.0 中彻底移除）：

```sql
-- 8.4 默认使用 caching_sha2_password
-- 旧客户端若遭遇 "Authentication plugin 'mysql_native_password' is not loaded" 错误
-- 方案1：升级客户端驱动（推荐）
-- 方案2：创建用户时显式指定插件
CREATE USER 'legacy_app'@'%' IDENTIFIED WITH mysql_native_password BY 'pass';

-- 方案3：临时启用（不推荐用于生产）
-- [mysqld]
-- mysql_native_password=ON
```

### 2、EXPLAIN INTO（调试增强）

```sql
-- 将执行计划保存到用户变量，便于程序化处理
EXPLAIN FORMAT=JSON INTO @plan SELECT * FROM orders WHERE user_id = 123;
SELECT @plan;  -- 返回 JSON 格式的执行计划
```

### 3、`SHOW PARSE_TREE`（SQL 解析树调试）

```sql
-- 查看 SQL 的解析树，方便排查复杂 SQL 的解析问题
SHOW PARSE_TREE SELECT id, SUM(amount) FROM orders GROUP BY id;
```

### 4、弃用项清理

| 8.4 弃用/移除 | 影响 |
|--------------|------|
| `mysql_native_password` 默认禁用 | 旧驱动需升级 |
| `sync_binlog` 语义不变，但若干旧参数别名移除 | 检查配置文件 |
| `INFORMATION_SCHEMA.ENGINES` 部分引擎条目 | 几乎无影响 |

---

## 四、MySQL 9.x Innovation 重要特性

MySQL 9.0 于 **2024 年 7 月**发布，之后每季度发布 Innovation 版本（9.1、9.2、9.3…），引入前沿特性，不承诺长期维护，适合尝鲜；生产环境建议使用 LTS 版本（8.4 / 未来的 9.7 LTS）。

### 1、VECTOR 数据类型（9.0+）

原生支持向量存储，为 AI / 机器学习嵌入场景而设计：

```sql
CREATE TABLE embeddings (
  id      INT PRIMARY KEY AUTO_INCREMENT,
  content TEXT,
  vec     VECTOR(1536)   -- 1536 维向量（如 OpenAI text-embedding-3-small）
);

-- 写入向量（字符串格式）
INSERT INTO embeddings (content, vec)
VALUES ('Java 并发编程', '[0.012, -0.345, 0.678, ...]');

-- 向量函数
SELECT id, content,
  DISTANCE(vec, '[0.011, -0.340, 0.670, ...]', 'COSINE') AS cos_dist
FROM embeddings
ORDER BY cos_dist
LIMIT 5;
```

### 2、向量近似最近邻索引 ANN（9.2+）

9.2 引入基于 **HNSW** 算法的 ANN 向量索引，大幅加速语义搜索：

```sql
-- 创建 HNSW 向量索引（9.2+）
ALTER TABLE embeddings
  ADD VECTOR INDEX idx_vec (vec)
  USING HNSW;

-- ANN 搜索（走向量索引）
SELECT id, content
FROM embeddings
ORDER BY DISTANCE(vec, '[0.011, -0.340, ...]', 'COSINE')
LIMIT 10;
```

| 函数 | 说明 |
|------|------|
| `DISTANCE(v1, v2, 'COSINE')` | 余弦距离（越小越相似）|
| `DISTANCE(v1, v2, 'EUCLIDEAN')` | 欧几里得距离 |
| `VECTOR_DIM(v)` | 返回向量维度数 |
| `STRING_TO_VECTOR(str)` | 字符串转向量 |
| `VECTOR_TO_STRING(v)` | 向量转字符串 |

### 3、`mysql_native_password` 彻底移除（9.0）

9.0 中完全移除该插件，所有用户必须使用 `caching_sha2_password` 或其他现代插件。

### 4、JavaScript 存储程序（Enterprise 版）

9.0 Enterprise 版通过集成 GraalVM JavaScript 引擎，支持用 JavaScript 编写存储过程/函数（社区版不包含）。

---

## 五、特性总结对比

| 特性 | 5.7 | 8.0 | 8.4 LTS | 9.x |
|------|:---:|:---:|:-------:|:---:|
| 窗口函数 | ❌ | ✅ | ✅ | ✅ |
| CTE / WITH RECURSIVE | ❌ | ✅ | ✅ | ✅ |
| 不可见索引 | ❌ | ✅ | ✅ | ✅ |
| 真正降序索引 | ❌ | ✅ | ✅ | ✅ |
| 原子 DDL | ❌ | ✅ | ✅ | ✅ |
| 角色管理 | ❌ | ✅ | ✅ | ✅ |
| JSON 多值索引 | ❌ | ✅（8.0.17+）| ✅ | ✅ |
| 直方图统计 | ❌ | ✅ | ✅ | ✅ |
| JSON 基础支持 | ✅ | ✅（增强）| ✅ | ✅ |
| 虚拟生成列 | ✅ | ✅ | ✅ | ✅ |
| sys Schema | ✅ | ✅ | ✅ | ✅ |
| utf8mb4 默认 | ❌ | ✅ | ✅ | ✅ |
| AUTO_INCREMENT 持久化 | ❌ | ✅ | ✅ | ✅ |
| `mysql_native_password` | ✅ | ✅（弃用）| ⚠️ 默认禁用 | ❌ 已移除 |
| EXPLAIN INTO 变量 | ❌ | ❌ | ✅ | ✅ |
| VECTOR 数据类型 | ❌ | ❌ | ❌ | ✅（9.0+）|
| ANN 向量索引（HNSW）| ❌ | ❌ | ❌ | ✅（9.2+）|

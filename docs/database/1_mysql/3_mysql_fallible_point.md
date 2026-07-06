# Mysql 雷区标识

参考：https://mp.weixin.qq.com/s/xQGJBn_M9qT2znd-2nmAng

## 一、索引失效雷区

### 1、隐式类型转换

字段类型与传入值类型不匹配时，MySQL 做隐式转换，索引失效。

```sql
-- phone 字段为 varchar，传入 int → 全表扫描
SELECT * FROM users WHERE phone = 13800138000;    -- ❌ 索引失效
SELECT * FROM users WHERE phone = '13800138000';  -- ✅ 走索引
```

反向也会发生：数字字段与字符串比较，字符串被转成数字，索引可能失效。

### 2、对索引列使用函数或运算

```sql
-- 对列做函数运算，破坏索引结构
SELECT * FROM orders WHERE YEAR(created_at) = 2024;             -- ❌
SELECT * FROM orders WHERE DATE(created_at) = '2024-06-01';     -- ❌
SELECT * FROM orders WHERE id + 1 = 100;                        -- ❌

-- 改为范围查询
SELECT * FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'; -- ✅
SELECT * FROM orders WHERE id = 99;                              -- ✅
```

### 3、LIKE 前缀通配符

```sql
SELECT * FROM users WHERE name LIKE '%张%';  -- ❌ 前通配，全表扫描
SELECT * FROM users WHERE name LIKE '张%';   -- ✅ 后通配，走索引
```

前缀模糊搜索需要改用全文索引或 Elasticsearch。

### 4、OR 条件中有列未命中索引

```sql
-- id 有索引，email 无索引，OR 导致整体失效
SELECT * FROM users WHERE id = 1 OR email = 'a@b.com';  -- ❌

-- 方案1：给 email 也加索引
-- 方案2：UNION 替代 OR
SELECT * FROM users WHERE id = 1
UNION
SELECT * FROM users WHERE email = 'a@b.com';             -- ✅
```

### 5、联合索引违反最左前缀

```sql
-- 联合索引 (a, b, c)
SELECT * FROM t WHERE b = 1 AND c = 2;       -- ❌ 未包含 a，索引失效
SELECT * FROM t WHERE a = 1 AND c = 2;       -- ⚠️ 仅用到 a，c 无法利用索引
SELECT * FROM t WHERE a = 1 AND b = 2;       -- ✅ 用到 (a, b)
SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3; -- ✅ 全用到
SELECT * FROM t WHERE b = 2 AND a = 1;       -- ✅ 优化器会调整顺序
```

### 6、范围查询后的列失效

```sql
-- 联合索引 (status, amount, created_at)
-- amount 用了范围查询，其后的 created_at 无法使用索引
SELECT * FROM orders
WHERE status = 'paid' AND amount > 100 AND created_at > '2024-01-01';
-- status + amount 走索引，created_at 不走 ❌

-- 将区分度高的等值列放前面
CREATE INDEX idx_opt ON orders(status, created_at, amount);
```

---

## 二、事务与锁雷区

### 1、大事务导致锁等待和 undo log 膨胀

```sql
-- ❌ 一次性删除大量数据，持锁时间长，undo log 膨胀
DELETE FROM logs WHERE created_at < '2023-01-01';

-- ✅ 分批次，每批 commit
DELETE FROM logs WHERE created_at < '2023-01-01' LIMIT 500;
-- 循环执行直到影响行数为 0
```

### 2、死锁：加锁顺序不一致

```sql
-- 事务 A：先锁 id=1，再锁 id=2
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;

-- 事务 B（同时执行）：先锁 id=2，再锁 id=1 → 死锁
UPDATE accounts SET balance = balance - 50 WHERE id = 2;
UPDATE accounts SET balance = balance + 50 WHERE id = 1;
```

**解决**：统一按 id 升序加锁，避免交叉持有。

### 3、SELECT ... FOR UPDATE 锁范围超预期

```sql
-- WHERE 条件未走索引时，FOR UPDATE 升级为表锁
SELECT * FROM orders WHERE remark = 'urgent' FOR UPDATE;  -- remark 无索引 → 表锁 ❌

-- 确保 WHERE 条件命中索引
SELECT * FROM orders WHERE id = 123 FOR UPDATE;           -- ✅ 行锁
```

### 4、间隙锁（Gap Lock）引发死锁

RR 隔离级别下，范围查询会加间隙锁，容易与插入产生死锁：

```sql
-- 事务 A：SELECT 加间隙锁 (10, 20)
SELECT * FROM t WHERE id BETWEEN 10 AND 20 FOR UPDATE;

-- 事务 B：INSERT 想插入 id=15，被间隙锁阻塞
INSERT INTO t VALUES (15, 'data');  -- 等待 A 的间隙锁
-- 若 A 也有插入操作 → 死锁
```

**解决**：降低隔离级别到 RC，或精确 WHERE 条件避免范围锁。

### 5、@Transactional 注解失效

| 场景 | 原因 |
|------|------|
| 方法非 `public` | Spring AOP 代理不拦截非 public 方法 |
| 同类内部调用 `this.method()` | 绕过代理，事务不生效 |
| 异常被 catch 吞掉 | 没有异常抛出，事务不回滚 |
| 检查型异常未配 `rollbackFor` | 默认只回滚 `RuntimeException` |
| 多线程异步执行 | 不同线程不共享事务上下文 |

---

## 三、字符集雷区

### 1、utf8 ≠ 真正的 UTF-8

MySQL 的 `utf8` 是 3 字节，**无法存储 emoji 及部分生僻字**。应使用 `utf8mb4`：

```sql
-- 建表时指定
CREATE TABLE posts (
  content TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
) DEFAULT CHARSET = utf8mb4;

-- 连接时指定（JDBC URL 或代码中）
SET NAMES utf8mb4;
-- JDBC: jdbc:mysql://host/db?characterEncoding=utf8mb4
```

### 2、字符集不一致导致索引失效

表字段字符集与查询参数字符集不同时，MySQL 做隐式转换，索引失效。常见于：
- 表使用 `utf8mb4`，连接字符集是 `utf8`
- 联表查询两张表字符集不同

---

## 四、NULL 处理雷区

### 1、NULL 参与运算结果为 NULL

```sql
SELECT NULL + 1;       -- NULL（不是 1）
SELECT 1 = NULL;       -- NULL（不是 FALSE）
SELECT NULL = NULL;    -- NULL（用 IS NULL 判断）
SELECT NULL != NULL;   -- NULL

-- 正确判断 NULL
SELECT * FROM t WHERE col IS NULL;
SELECT * FROM t WHERE col IS NOT NULL;
```

### 2、COUNT 对 NULL 的处理差异

```sql
SELECT COUNT(*)      FROM t;  -- 统计所有行（含 NULL）
SELECT COUNT(col)    FROM t;  -- 忽略 NULL
SELECT COUNT(DISTINCT col) FROM t; -- 忽略 NULL
```

### 3、NOT IN 子查询含 NULL 时恒为空

```sql
-- 若子查询返回集合中含有 NULL，NOT IN 结果集为空
SELECT * FROM a WHERE id NOT IN (SELECT id FROM b);
-- 若 b 中有一行 id IS NULL → 整个查询返回空！

-- 安全写法
SELECT * FROM a WHERE id NOT IN (
  SELECT id FROM b WHERE id IS NOT NULL
);
-- 或用 NOT EXISTS
SELECT * FROM a WHERE NOT EXISTS (
  SELECT 1 FROM b WHERE b.id = a.id
);
```

---

## 五、分页与排序雷区

### 1、深度分页

```sql
-- OFFSET 过大，MySQL 扫描并丢弃大量行（即便有索引）
SELECT * FROM orders ORDER BY id LIMIT 1000000, 10;  -- ❌ 慢

-- 游标翻页（推荐）
SELECT * FROM orders WHERE id > :last_id ORDER BY id LIMIT 10;  -- ✅

-- 子查询延迟关联
SELECT o.* FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 1000000, 10) t ON o.id = t.id;  -- ✅
```

### 2、ORDER BY 与 LIMIT 陷阱

```sql
-- 多行相同排序值时，LIMIT 结果不稳定（不同页可能重复或遗漏）
SELECT * FROM orders ORDER BY status LIMIT 10 OFFSET 10;  -- ❌ status 有重复值

-- 加唯一列保证稳定排序
SELECT * FROM orders ORDER BY status, id LIMIT 10 OFFSET 10;  -- ✅
```

---

## 六、其他常见雷区

### 1、UPDATE / DELETE 不带 WHERE

```sql
-- 开启安全模式防止误操作
SET sql_safe_updates = 1;
-- 此时不带索引条件的 UPDATE/DELETE 会报错

-- 生产操作前先 SELECT 验证条件
SELECT COUNT(*) FROM orders WHERE status = 'cancelled';
-- 确认无误后再执行 DELETE
```

### 2、自增 ID 用尽

```sql
-- INT：最大 2,147,483,647（约 21 亿）
-- BIGINT：最大 9,223,372,036,854,775,807（约 922 亿亿）

-- 检查当前自增值
SHOW CREATE TABLE orders;  -- 查看 AUTO_INCREMENT 当前值
SELECT MAX(id) FROM orders;

-- 高并发大表直接用 BIGINT UNSIGNED
CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY
);
```

### 3、时区不一致

```sql
-- 检查时区设置
SHOW VARIABLES LIKE '%time_zone%';

-- 统一设置为 +08:00
SET GLOBAL time_zone = '+08:00';
SET time_zone = '+08:00';
-- JDBC URL 加参数：serverTimezone=Asia/Shanghai
```

### 4、VARCHAR 长度误解

`VARCHAR(255)` 的 255 是**字符数**，不是字节数。utf8mb4 每字符最多 4 字节，所以 `VARCHAR(255)` 实际最多占 255×4=1020 字节。

索引键最大 767 字节（ROW_FORMAT=COMPACT）或 3072 字节（ROW_FORMAT=DYNAMIC），超长字段建索引需加前缀：

```sql
CREATE INDEX idx_content ON articles(content(100));  -- 前 100 个字符建索引
```

---
description: 大事务与批量删除、锁范围与间隙锁死锁、字符集与排序规则、NULL、时区、排序稳定性、Online DDL 与 MDL
---

# MySQL 避坑指南

> **本篇目标**：认清线上最常见的 MySQL 雷区：锁范围超预期、间隙锁死锁、字符集与排序规则不一致、NULL 语义、时区错乱、大表 DDL 被 MDL 堵死，并掌握对应的正确写法和排查手段。本篇也是 Online DDL 的主文档。
>
> **前置阅读**：[MySQL 基础](./0_overview)、[MySQL 事务与锁](./5_topic_transaction)

本篇以 MySQL 8.4 LTS 为基线，默认隔离级别为可重复读（RR）。

---

## 一、索引失效

隐式类型转换、对索引列做函数运算、`LIKE` 左模糊、`OR` 中有无索引列、违反最左前缀、区分度过低等索引失效场景，以及深度分页的优化方案，统一在 [MySQL 索引](./4_topic_index) 中讲解。字符集或排序规则不一致导致的索引失效见本篇第三节。

---

## 二、事务与锁

锁的原理（记录锁、间隙锁、Next-Key Lock、插入意向锁）见 [MySQL 事务与锁](./5_topic_transaction)，这里只列容易踩的坑。

### 1、大事务：一次删除海量数据

```sql
-- 反例：一条语句删除上千万行，持锁时间长、undo 膨胀、副本延迟飙升
DELETE FROM app_log WHERE created_at < '2026-01-01';

-- 正例一：按主键范围分批，每批单独提交（应用层循环推进 id 区间）
DELETE FROM app_log
WHERE id >= ? AND id < ?
  AND created_at < '2026-01-01';

-- 正例二：created_at 上有索引时，按主键顺序小批量删除，循环直到影响行数为 0
DELETE FROM app_log
WHERE created_at < '2026-01-01'
ORDER BY id
LIMIT 1000;
```

- 不带 `ORDER BY` 的 `DELETE ... LIMIT` 删除哪些行不确定，在基于语句的 binlog 下属于不安全语句；ROW 格式下没有复制问题，但如果条件列没有索引，每一批都要重新扫描全表
- 按时间清理的日志表，更好的做法是按时间分区，直接 `ALTER TABLE ... DROP PARTITION`

### 2、加锁顺序不一致导致死锁

```sql
-- 事务 A：先锁 id=1，再锁 id=2
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;

-- 事务 B（并发执行）：先锁 id=2，再锁 id=1，与 A 形成等待环
UPDATE accounts SET balance = balance - 50 WHERE id = 2;
UPDATE accounts SET balance = balance + 50 WHERE id = 1;
```

解决：所有涉及多行的事务统一按主键升序加锁，例如转账时先锁 ID 较小的账户。

### 3、`SELECT ... FOR UPDATE` 锁住了整张表

InnoDB 不会把行锁升级为表锁，但锁是加在**扫描到的索引记录**上的。条件列没有可用索引时，语句会扫描整个聚簇索引，并对扫描到的每一行加锁：

```sql
-- 反例：remark 无索引，全表扫描，所有记录和间隙都被加上 Next-Key Lock
SELECT * FROM orders WHERE remark = 'urgent' FOR UPDATE;

-- 正例：条件命中索引，只锁匹配的记录（唯一索引等值命中时只有记录锁）
SELECT * FROM orders WHERE id = 123 FOR UPDATE;
```

- RR 下，扫描到的记录和它们之间的间隙都被 Next-Key Lock 锁住，效果上整张表的更新和插入都被阻塞，表级只持有一把意向锁（IX）
- 读已提交（RC）下，不满足条件的行在判断后会立即释放锁，影响小得多，但扫描成本不变
- 范围条件同理：RR 下 `WHERE id BETWEEN 10 AND 20 FOR UPDATE` 锁住的是匹配记录上的 Next-Key Lock，以及最后一条匹配记录到下一条记录之间的间隙，而不只是 (10, 20)

### 4、间隙锁死锁：先查不存在的行再插入

「先 `SELECT ... FOR UPDATE` 判断不存在，再 `INSERT`」是最常见的间隙锁死锁来源。设表 `t` 主键 `id` 已有 10 和 20 两行：

![间隙锁死锁的时序](../../assets/database/mysql-gap-lock-deadlock.svg)

```sql
-- T1 事务 A：id=15 不存在，获得间隙锁 (10, 20)
SELECT * FROM t WHERE id = 15 FOR UPDATE;

-- T2 事务 B：间隙锁之间互相兼容，同样获得间隙锁 (10, 20)
SELECT * FROM t WHERE id = 15 FOR UPDATE;

-- T3 事务 A：插入意向锁与 B 的间隙锁冲突，等待
INSERT INTO t (id, c) VALUES (15, 'a');

-- T4 事务 B：插入意向锁与 A 的间隙锁冲突，形成等待环，InnoDB 回滚其中一个（ERROR 1213）
INSERT INTO t (id, c) VALUES (15, 'b');
```

解决方式：

- 依赖唯一约束，直接 `INSERT`，捕获重复键错误；或者用 `INSERT ... ON DUPLICATE KEY UPDATE` 一条语句完成「不存在则插入」
- 业务允许时改用 RC：RC 下普通查询不加间隙锁，但外键检查和唯一键重复检查仍会加；使用 RC 时 `binlog_format` 必须是 ROW
- 应用层对 1213（死锁）和 1205（锁等待超时）做有限次数的事务级重试

排查死锁：

```sql
SHOW ENGINE INNODB STATUS;              -- LATEST DETECTED DEADLOCK 段记录最近一次死锁的两条语句和锁
SELECT * FROM performance_schema.data_locks;        -- 当前持有和等待的锁
SELECT * FROM performance_schema.data_lock_waits;   -- 等待关系
SET PERSIST innodb_print_all_deadlocks = ON;        -- 把每次死锁都写入错误日志
```

### 5、`@Transactional` 失效

非 public 方法、同类自调用、异常被吞、`rollbackFor` 缺失、多线程等属于 Spring 层的问题，见 [事务管理](/spring/4_transaction)。

---

## 三、字符集与排序规则

### 1、`utf8` 不是真正的 UTF-8

MySQL 的 `utf8` 是 `utf8mb3` 的别名，每个字符最多 3 字节，**存不了 emoji 和部分生僻字**，已被弃用（8.0.30 起 `SHOW CREATE TABLE` 直接显示为 `utf8mb3`）。统一使用 `utf8mb4`，排序规则用 8.x 默认的 `utf8mb4_0900_ai_ci`：

```sql
CREATE TABLE posts (
  id      BIGINT PRIMARY KEY,
  content TEXT
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
```

JDBC 连接串中用 Java 的编码名 `characterEncoding=UTF-8`，Connector/J 会映射为 `utf8mb4`；需要固定排序规则时再加 `connectionCollation=utf8mb4_0900_ai_ci`。完整参数见 [MySQL JDBC 驱动](../6_reference/2_jdbc_driver)。

### 2、字符集或排序规则不一致导致索引失效

比较两边字符集不同时，MySQL 会把**字符集较小的一边**转换成较大的一边：

- 列是 `utf8mb4`、参数是 `utf8mb3`：转换发生在参数上，索引照常使用
- 列是 `utf8mb3`、与 `utf8mb4` 的值或列比较：转换发生在列上，相当于对索引列套了 `CONVERT(... USING utf8mb4)`，索引失效

最典型的场景是**联表**：驱动表的关联列是 `utf8mb4`，被驱动表的关联列还是老的 `utf8mb3`，被驱动表上的索引用不上，`EXPLAIN` 里能看到全表扫描。

```sql
-- 老表 user_profile.user_code 为 utf8mb3，新表 orders.user_code 为 utf8mb4
SELECT o.id, p.nickname
FROM orders o
JOIN user_profile p ON p.user_code = o.user_code   -- p 上的索引失效
WHERE o.id = 1001;

-- 根治：把老表转换为 utf8mb4（会重建表，按大表 DDL 流程执行）
ALTER TABLE user_profile CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

排序规则不一致也有同样的问题：一张表用 `utf8mb4_unicode_ci`、另一张用 `utf8mb4_0900_ai_ci`，比较时要么报 `Illegal mix of collations`，要么索引失效。从 5.7 升级上来的库最容易出现这种混用，建库时就要统一字符集和排序规则。

---

## 四、NULL 处理

### 1、NULL 参与运算和比较

```sql
SELECT NULL + 1;      -- NULL
SELECT 1 = NULL;      -- NULL，不是 FALSE
SELECT NULL = NULL;   -- NULL
SELECT NULL <=> NULL; -- 1，NULL 安全的等值比较

SELECT * FROM t WHERE col IS NULL;
```

### 2、COUNT 对 NULL 的处理

```sql
SELECT COUNT(*)            FROM t;  -- 统计所有行
SELECT COUNT(col)          FROM t;  -- 忽略 col 为 NULL 的行
SELECT COUNT(DISTINCT col) FROM t;  -- 忽略 NULL 后去重
```

### 3、`NOT IN` 子查询含 NULL 时结果为空

```sql
-- 子查询结果中只要有一个 NULL，NOT IN 对任何行都得到 NULL，整个查询返回空
SELECT * FROM a WHERE id NOT IN (SELECT a_id FROM b);

-- 正例：过滤 NULL，或改用 NOT EXISTS
SELECT * FROM a WHERE id NOT IN (SELECT a_id FROM b WHERE a_id IS NOT NULL);
SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);
```

建表时业务字段尽量 `NOT NULL` 并给默认值，可以从源头避开这些问题。

---

## 五、排序稳定性

`ORDER BY` 的列存在重复值时，MySQL 不保证相同值之间的顺序，配合 `LIMIT` 分页会出现某些行在不同页重复、另一些行永远翻不到：

```sql
-- 反例：status 有大量重复值，翻页结果不稳定
SELECT * FROM orders ORDER BY status LIMIT 10 OFFSET 10;

-- 正例：追加唯一列作为最后的排序键
SELECT * FROM orders ORDER BY status, id LIMIT 10 OFFSET 10;
```

深度分页（大 `OFFSET`）的优化方案见 [MySQL 索引](./4_topic_index)。

---

## 六、其他常见雷区

### 1、UPDATE / DELETE 漏写 WHERE

```sql
-- 开启后，WHERE 中没有索引列且没有 LIMIT 的 UPDATE / DELETE 会直接报错
SET SESSION sql_safe_updates = 1;

-- 生产手工变更：先用同样的条件 SELECT COUNT(*) 核对行数，再在事务中执行并检查影响行数
SELECT COUNT(*) FROM orders WHERE status = 'cancelled';
```

客户端 `mysql --safe-updates` 也能达到同样效果；生产变更最好走带审批和回滚备份的变更平台。

### 2、自增 ID 用尽

`INT` 最大约 21 亿，`INT UNSIGNED` 约 42 亿，高增长的表直接使用 `BIGINT`。自增值用尽后插入会报主键冲突。

```sql
SELECT TABLE_NAME, AUTO_INCREMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'shop' AND AUTO_INCREMENT IS NOT NULL
ORDER BY AUTO_INCREMENT DESC;
```

`information_schema.TABLES` 的统计默认有缓存（`information_schema_stats_expiry`，默认 86400 秒），精确值以 `SHOW CREATE TABLE` 为准。

### 3、时区不一致

时间错 8 小时几乎都是服务端时区、JDBC 会话时区、JVM 时区三者不一致造成的：

```sql
SHOW VARIABLES LIKE '%time_zone%';
SET PERSIST time_zone = '+08:00';   -- 持久化到 mysqld-auto.cnf，重启不丢
```

```properties
# Connector/J 8.0.23 起用 connectionTimeZone 取代 serverTimezone（后者仅保留为别名）
spring.datasource.url=jdbc:mysql://db:3306/shop?sslMode=REQUIRED&characterEncoding=UTF-8&connectionTimeZone=Asia/Shanghai&forceConnectionTimeZoneToSession=true
```

- `forceConnectionTimeZoneToSession=true` 会把会话的 `time_zone` 设置为 `connectionTimeZone`，保证 `NOW()` 等函数与驱动的转换使用同一时区
- 跨时区部署的系统建议统一存 UTC，展示时再转换；`TIMESTAMP` 按 UTC 存储且受会话时区影响，范围只到 2038 年，`DATETIME` 原样存储、不做时区转换

### 4、VARCHAR 长度与索引前缀

`VARCHAR(255)` 的 255 是**字符数**，`utf8mb4` 下最多占 1020 字节。InnoDB 索引键长度上限：`DYNAMIC` / `COMPRESSED` 行格式为 3072 字节，`REDUNDANT` / `COMPACT` 为 767 字节。超长字段只能建前缀索引：

```sql
CREATE INDEX idx_title ON articles (title(100));   -- 前 100 个字符
```

前缀索引无法用于覆盖索引和 `ORDER BY`，前缀长度用 `COUNT(DISTINCT LEFT(title, n)) / COUNT(*)` 评估区分度。

---

## 七、大表 DDL 与 Online DDL

### 1、DDL 被 MDL 阻塞，拖垮整张表

DDL 执行时需要拿表的 **MDL 写锁**；而任何访问过该表、尚未提交的事务（哪怕只执行过一条 `SELECT`）都持有 MDL 读锁。MDL 请求按队列排队，于是形成下面的阻塞链：

![MDL 阻塞链](../../assets/database/mysql-mdl-blocking.svg)

8.0.12 起 `ADD COLUMN` 默认就是 INSTANT，重建表的耗时已经不是问题，真正的风险在于等 MDL。

```sql
-- 1、DDL 前先找长事务
SELECT trx_id, trx_mysql_thread_id, trx_started, trx_query
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 60 SECOND;

-- 2、给 DDL 设置较短的 MDL 等待超时，拿不到锁就失败，而不是排队堵死业务
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD COLUMN remark VARCHAR(64), ALGORITHM = INSTANT;

-- 3、DDL 卡住时查看谁在等、谁持有 MDL（8.x 默认已开启 MDL 采集）
SELECT * FROM sys.schema_table_lock_waits;
SELECT OBJECT_SCHEMA, OBJECT_NAME, LOCK_TYPE, LOCK_STATUS, OWNER_THREAD_ID
FROM performance_schema.metadata_locks
WHERE OBJECT_NAME = 'orders';
```

`information_schema.innodb_trx` 只能看到 InnoDB 事务，MDL 的持有和等待要看 `performance_schema.metadata_locks` 或 `sys.schema_table_lock_waits`。

### 2、Online DDL 的算法与锁

`ALTER TABLE` 有三种算法，代价依次升高：

| 算法 | 做法 | 并发 DML |
|------|------|---------|
| `INSTANT` | 只修改数据字典 | 允许 |
| `INPLACE` | 在引擎内部完成，可能需要重建表（rebuild），执行期间记录并回放增量 | 大多允许 |
| `COPY` | 建新表、逐行拷贝、再替换 | 不允许 |

常见操作在 8.4 上的表现：

| 操作 | 算法 | 重建表 | 并发 DML |
|------|------|-------|---------|
| 加列（任意位置）、删列 | `INSTANT`（8.0.29+） | 否 | 允许 |
| 重命名列（类型与 NULL 属性不变） | `INSTANT` | 否 | 允许 |
| 修改 / 删除列默认值 | `INSTANT` | 否 | 允许 |
| 加二级索引 | `INPLACE` | 否 | 允许 |
| 删除索引、重命名索引 | `INPLACE`（只改元数据） | 否 | 允许 |
| 扩展 `VARCHAR` 长度（长度前缀字节数不变：都在 255 字节以内或都超过 255 字节） | `INPLACE` | 否 | 允许 |
| 加主键 | `INPLACE` | 是 | 允许 |
| 修改列类型、修改字符集 | `COPY` | 是 | 不允许 |
| `OPTIMIZE TABLE` / `ENGINE=InnoDB` 重建 | `INPLACE` | 是 | 允许 |

显式写出 `ALGORITHM` 和 `LOCK`，MySQL 做不到时会直接报错，而不是悄悄退化成锁表的 COPY：

```sql
ALTER TABLE orders ADD INDEX idx_status (status), ALGORITHM = INPLACE, LOCK = NONE;
ALTER TABLE orders ADD COLUMN channel VARCHAR(16), ALGORITHM = INSTANT;
```

INSTANT 加 / 删列受表的行版本数上限约束（8.4 为 64，9.1 起为 255），达到上限后只能重建表，见 [MySQL 版本特性](./1_feature)。

### 3、超大表用外部工具

INPLACE 不阻塞 DML，但重建表期间的 IO 压力和副本延迟仍然很大：DDL 在源库执行完之后才写入 binlog，副本要再完整执行一遍，期间复制延迟持续累积。千万行以上的表建议用外部工具：

| 工具 | 原理 | 特点与限制 |
|------|------|-----------|
| **gh-ost**（GitHub） | 建影子表，拷贝存量数据，同时消费 binlog 回放增量，最后原子切换表名 | 无触发器，可暂停、限速；要求 `binlog_format=ROW` 且 `binlog_row_image=FULL`，不支持外键 |
| **pt-online-schema-change**（Percona） | 建影子表，用触发器同步增量 | 成熟稳定；触发器带来额外写开销，外键需要特殊处理 |

```bash
gh-ost --alter="ADD COLUMN remark VARCHAR(64)" \
  --database=shop --table=orders \
  --max-load=Threads_running=50 --chunk-size=1000 \
  --execute
```

上线守则：

1. 先在副本或预发环境验证耗时和锁行为
2. 放在业务低峰期执行，DDL 会话设置较短的 `lock_wait_timeout`
3. 执行前确认没有长事务，执行中盯住副本延迟和 `Threads_running`
4. 准备好回滚方案（反向 DDL 或影子表保留）

---

## 小结

- 大批量删除按主键范围分批提交；按时间清理的表优先用分区
- InnoDB 不会把行锁升级为表锁，但无索引的 `FOR UPDATE` 会锁住扫描到的所有记录和间隙，效果等同锁表
- 「先 `FOR UPDATE` 查不存在的行再插入」会因为间隙锁兼容、插入意向锁互斥而死锁，改用唯一约束 + 直接插入或 `ON DUPLICATE KEY UPDATE`
- 统一使用 `utf8mb4` + `utf8mb4_0900_ai_ci`；字符集较小的列参与比较时会被转换，索引失效，联表时最常见
- JDBC 使用 `characterEncoding=UTF-8` 和 `connectionTimeZone`，`serverTimezone` 只是旧别名
- `NOT IN` 遇到 NULL 返回空，分页排序必须带唯一列
- 大表 DDL 的主要风险是 MDL 排队：先查长事务、设置 `lock_wait_timeout`、显式声明 `ALGORITHM` / `LOCK`，超大表用 gh-ost

## 参考资料

- InnoDB 中各类语句加的锁：[https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- data_locks 表：[https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- utf8mb4 字符集：[https://dev.mysql.com/doc/refman/8.4/en/charset-unicode-utf8mb4.html](https://dev.mysql.com/doc/refman/8.4/en/charset-unicode-utf8mb4.html)
- Connector/J 配置属性：[https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)
- 元数据锁：[https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html](https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html)
- Online DDL 操作：[https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- gh-ost：[https://github.com/github/gh-ost](https://github.com/github/gh-ost)

> 下一篇：[MySQL 索引](./4_topic_index) —— B+ 树、聚簇与二级索引、覆盖索引、最左前缀、索引失效与深度分页。

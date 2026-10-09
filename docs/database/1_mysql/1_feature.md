---
description: 版本生命周期、5.7 与 8.0 关键特性、8.4 LTS 移除项与默认值、9.7 LTS 与日历版本、升级检查
---

# MySQL 版本特性

> **本篇目标**：弄清 MySQL 的 LTS / Innovation 发布模型和各版本的维护期限，掌握 8.0 引入的、日常开发最常用的特性，知道 8.0 升级到 8.4 LTS 时哪些语法和参数被移除、哪些默认值变了，以及 9.7 LTS 带来了什么。
>
> **前置阅读**：[MySQL 基础](./0_overview)

---

## 一、版本路线与生命周期

![MySQL 版本路线与生命周期](../../assets/database/mysql-version-timeline.svg)

2023 年起 MySQL 改为 **LTS + Innovation** 双轨发布：Innovation 版本按季度发布，引入新特性也可能移除旧特性，只维护到下一次发布；LTS 版本只修 bug 和安全问题，维护期长，适合生产。

| 版本线 | 类型 | GA 时间 | 状态 |
|--------|------|---------|------|
| 5.7 | GA | 2015-10 | 2023-10 停止维护 |
| 8.0 | GA（8.0.34 起只修 bug） | 2018-04 | 2026-04 随 8.0.46 停止维护 |
| 8.1 ~ 8.3 | Innovation | 2023-07 ~ 2024-01 | 已被 8.4 LTS 取代 |
| 8.4 | LTS | 2024-04 | 主流生产基线，扩展支持至 2032 年 |
| 9.0 ~ 9.6 | Innovation | 2024-07 起 | 已被 9.7 LTS 取代 |
| 9.7 | LTS | 2026-04-21 | 最新 LTS |
| 26.7 起 | Innovation（日历版本） | 2026-07 | 版本号改为 `YY.M.P`，如 26.7.0、26.10.0 |

几条升级规则：

- LTS 系列内可以原地升级和降级；跨 LTS 只能升级到下一个 LTS（8.0 → 8.4 → 9.7），不能跳过 LTS
- 9.7 是最后一个使用顺序版本号的版本线，之后 Innovation 和 LTS 都采用日历版本，版本号本身不再体现是 LTS 还是 Innovation
- 仍在 8.0 上的系统已经没有社区版安全修复，应尽快升级到 8.4 LTS

本文以 **8.4 LTS** 为基线，8.0 引入的特性默认 8.4 / 9.7 都具备。

---

## 二、MySQL 5.7 关键特性

### 1、JSON 类型

原生 JSON 类型以二进制格式存储，写入时校验格式，并提供路径表达式和一组 JSON 函数：

```sql
CREATE TABLE app_config (
  id   INT PRIMARY KEY,
  data JSON
);

INSERT INTO app_config VALUES (1, '{"host":"127.0.0.1","port":3306,"tags":["db","primary"]}');

-- -> 返回 JSON 值，->> 返回去掉引号的字符串
SELECT data -> '$.host'  FROM app_config WHERE id = 1;   -- "127.0.0.1"
SELECT data ->> '$.host' FROM app_config WHERE id = 1;   -- 127.0.0.1

SELECT JSON_CONTAINS(data, '"primary"', '$.tags') FROM app_config WHERE id = 1;  -- 1

UPDATE app_config SET data = JSON_SET(data, '$.port', 3307) WHERE id = 1;
UPDATE app_config SET data = JSON_ARRAY_APPEND(data, '$.tags', 'replica') WHERE id = 1;
```

### 2、生成列与「函数索引」

生成列的值由表达式计算得出，分 `VIRTUAL`（不存储，读取时计算，默认）和 `STORED`（写入时计算并落盘）。InnoDB 从 5.7.8 起支持在 **VIRTUAL 生成列**上建二级索引，索引里存的是计算结果，这是 5.7 实现函数索引的标准做法：

```sql
CREATE TABLE orders (
  id         BIGINT PRIMARY KEY,
  status     VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  year_val   INT AS (YEAR(created_at)) VIRTUAL,
  INDEX idx_year (year_val)
);

SELECT * FROM orders WHERE year_val = 2024;   -- 走 idx_year
```

8.0.13 起可以直接写函数索引，见下文第三节的「索引增强」。

### 3、sys Schema

5.7 内置 `sys` 库，把 Performance Schema 的原始数据整理成可读视图：

```sql
SELECT * FROM sys.statement_analysis ORDER BY total_latency DESC LIMIT 10;  -- 最耗时的语句
SELECT * FROM sys.innodb_lock_waits;                                          -- 当前锁等待
SELECT * FROM sys.schema_unused_indexes WHERE object_schema = 'shop';         -- 未使用的索引
```

### 4、其他

- **Group Replication**（5.7.17）：基于 Paxos 的组复制，是 InnoDB Cluster 的基础，见 [MySQL 主从与高可用](./9_topic_replication)
- **多源复制**：一个副本可同时从多个源复制
- **Online DDL 增强**：`VARCHAR` 在同一长度字节数范围内扩容、`RENAME INDEX` 可以原地完成；Online DDL 的完整规则见 [MySQL 避坑指南](./3_fallible_point)

---

## 三、MySQL 8.0 关键特性

### 1、窗口函数与 CTE

```sql
-- 窗口函数：部门内薪资排名与累计
SELECT name, department, salary,
  RANK()       OVER w AS rnk,
  ROW_NUMBER() OVER w AS rn,
  LAG(salary, 1, 0) OVER w AS prev_salary,
  SUM(salary)  OVER (PARTITION BY department ORDER BY salary DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
FROM employees
WINDOW w AS (PARTITION BY department ORDER BY salary DESC);

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

递归 CTE 的最大递归深度受 `cte_max_recursion_depth`（默认 1000）限制，防止数据成环时死循环。

### 2、索引增强

**不可见索引**：优化器忽略该索引，但写入时仍维护它，用来在删除索引前验证影响，出问题可以立刻改回可见。主键不能设为不可见。

```sql
ALTER TABLE orders ALTER INDEX idx_status INVISIBLE;

-- 在当前会话里让优化器重新考虑不可见索引，对比执行计划
-- 注意：FORCE INDEX 或索引提示指向不可见索引会直接报错
SET SESSION optimizer_switch = 'use_invisible_indexes=on';
EXPLAIN SELECT * FROM orders WHERE status = 'paid';
SET SESSION optimizer_switch = 'use_invisible_indexes=off';

-- 观察一段时间确认无影响后再删除
DROP INDEX idx_status ON orders;
```

**降序索引**：8.0 之前 `DESC` 关键字被解析但忽略，索引一律升序存储。单一方向的 `ORDER BY ... DESC` 本来就能反向扫描升序索引，不需要降序索引；降序索引解决的是**多列排序方向不一致**的场景：

```sql
CREATE INDEX idx_status_created ON orders (status ASC, created_at DESC);

-- 排序方向与索引定义一致，不再需要 filesort
SELECT id, status, created_at FROM orders
ORDER BY status ASC, created_at DESC
LIMIT 20;
```

**函数索引**（8.0.13+）：直接对表达式建索引，内部实现为隐藏的虚拟生成列。查询条件里的表达式必须与索引定义完全一致才能命中：

```sql
CREATE INDEX idx_created_year ON orders ((YEAR(created_at)));   -- 注意双层括号

SELECT * FROM orders WHERE YEAR(created_at) = 2024;              -- 走 idx_created_year
```

**多值索引**（8.0.17+）：对 JSON 数组的每个元素建索引，查询表达式要与索引表达式一致：

```sql
CREATE TABLE posts (
  id   BIGINT PRIMARY KEY,
  tags JSON,
  INDEX idx_tags ((CAST(tags -> '$[*]' AS CHAR(32) ARRAY)))
);

SELECT * FROM posts WHERE 'java' MEMBER OF (tags -> '$[*]');
SELECT * FROM posts WHERE JSON_CONTAINS(tags -> '$[*]', CAST('["java","go"]' AS JSON));
SELECT * FROM posts WHERE JSON_OVERLAPS(tags -> '$[*]', CAST('["java","go"]' AS JSON));
```

### 3、Instant DDL 与原子 DDL

- **INSTANT 加列**（8.0.12+）：只改数据字典，不重建表，秒级完成；8.0.29 起可以在任意位置加列和删列
- 每次 INSTANT 加 / 删列都会增加表的行版本数，上限 64（9.1 起为 255），达到上限后只能重建表
- **原子 DDL**：8.0 用 InnoDB 存储的事务型数据字典取代了 `.frm` 文件，`DROP TABLE t1, t2` 这类 DDL 要么全部成功、要么全部回滚

```sql
ALTER TABLE orders ADD COLUMN remark VARCHAR(64), ALGORITHM = INSTANT;

-- 查看行版本数
SELECT NAME, TOTAL_ROW_VERSIONS FROM information_schema.INNODB_TABLES
WHERE NAME = 'shop/orders';
```

INSTANT 只解决重建表的耗时，DDL 仍需要拿元数据锁（MDL），长事务照样会把 DDL 和后续查询堵死。Online DDL 的算法选择、MDL 风险与 gh-ost 等工具见 [MySQL 避坑指南](./3_fallible_point)。

### 4、优化器与诊断

| 特性 | 版本 | 说明 |
|------|------|------|
| 移除查询缓存 | 8.0.3 | Query Cache 在高并发写入下锁竞争严重，被整体删除；结果缓存放到应用层 |
| Hash Join | 8.0.18 | 无索引可用的等值 JOIN 不再走 Block Nested-Loop，8.0.20 起完全取代 BNL |
| `EXPLAIN ANALYZE` | 8.0.18 | 真正执行语句，输出每个迭代器的实际行数和耗时，用法见 [EXPLAIN 与 SQL 优化](./7_topic_explain) |
| `EXPLAIN FORMAT=TREE` | 8.0.16 | 以迭代器树展示执行计划 |
| 直方图 | 8.0.3 | 为无索引列收集值分布，帮助优化器估算选择率；8.4 支持自动更新 |
| 优化器提示 | 8.0.20 | `INDEX` / `NO_INDEX` / `JOIN_INDEX` / `GROUP_INDEX` / `ORDER_INDEX` 等索引级提示 |

```sql
-- 收集直方图；8.4 起加 AUTO UPDATE，随 ANALYZE TABLE 和统计信息自动重算刷新
ANALYZE TABLE orders UPDATE HISTOGRAM ON status WITH 64 BUCKETS AUTO UPDATE;

SELECT HISTOGRAM ->> '$."number-of-buckets-specified"' AS buckets
FROM information_schema.COLUMN_STATISTICS
WHERE TABLE_NAME = 'orders' AND COLUMN_NAME = 'status';

ANALYZE TABLE orders DROP HISTOGRAM ON status;

-- 8.0.20+ 索引提示
SELECT /*+ INDEX(orders idx_status_created) */ id FROM orders WHERE status = 'paid';
```

### 5、锁与并发

- **`NOWAIT` / `SKIP LOCKED`**：`SELECT ... FOR UPDATE SKIP LOCKED` 跳过已被锁住的行，适合多个消费者抢任务；`NOWAIT` 拿不到锁立即报错
- **`performance_schema.data_locks` / `data_lock_waits`**：取代 5.7 的 `information_schema.innodb_locks`，可以直接看到每把行锁和等待关系
- **`innodb_deadlock_detect`**：极高并发更新热点行时可关闭死锁检测，改由 `innodb_lock_wait_timeout` 兜底

```sql
-- 多个 worker 并发领取任务，互不阻塞
SELECT id FROM job_queue
WHERE state = 'READY'
ORDER BY id
LIMIT 10
FOR UPDATE SKIP LOCKED;
```

锁的原理见 [MySQL 事务与锁](./5_topic_transaction)。

### 6、其他高影响变化

| 变化 | 版本 | 影响 |
|------|------|------|
| 默认字符集 `utf8mb4`，排序规则 `utf8mb4_0900_ai_ci` | 8.0.1 | `utf8` 是 `utf8mb3` 的别名，已弃用；新旧表排序规则混用会导致比较报错或索引失效 |
| 默认认证插件 `caching_sha2_password` | 8.0.4 | 老驱动需要升级，见 [MySQL 基础](./0_overview) |
| 角色（Role） | 8.0 | 权限按角色管理，`SET DEFAULT ROLE` 后才生效 |
| 自增值持久化 | 8.0 | AUTO_INCREMENT 计数器写入 redo log，重启后不再回退到 `MAX(id) + 1` |
| CHECK 约束真正生效 | 8.0.16 | 之前语法被接受但不检查 |
| Binlog 默认开启，格式 ROW | 8.0 | `binlog_format` 在 8.0.34 起被标记弃用，未来只保留 ROW |
| 复制术语改为 SOURCE / REPLICA | 8.0.22 / 8.0.26 | 新语句与新变量名；旧语法在 8.4 移除 |
| Clone 插件 | 8.0.17 | 直接从运行中的实例克隆数据来搭建副本 |
| 在线调整 redo log 容量 | 8.0.30 | `innodb_redo_log_capacity` 取代 `innodb_log_file_size` + `innodb_log_files_in_group` |
| 生成隐藏主键（GIPK） | 8.0.30 | `sql_generate_invisible_primary_key=ON` 时，无主键的表自动加隐藏主键 `my_row_id` |
| InnoDB 并行读 | 8.0.14 | `innodb_parallel_read_threads` 只用于聚簇索引上的 `SELECT COUNT(*)` 和 `CHECK TABLE` |

---

## 四、MySQL 8.4 LTS 的变化

8.4 是 8.1 ~ 8.3 三个 Innovation 版本的集大成，主要变化是**清理弃用项**和**调整 InnoDB 默认值**。从 8.0 升级到 8.4，配置文件和运维脚本是最容易出问题的地方。

### 1、移除项

| 移除 | 替代 |
|------|------|
| `CHANGE MASTER TO`、`START SLAVE`、`SHOW SLAVE STATUS`、`RESET SLAVE`、`SHOW SLAVE HOSTS` | `CHANGE REPLICATION SOURCE TO`、`START REPLICA`、`SHOW REPLICA STATUS`、`RESET REPLICA`、`SHOW REPLICAS` |
| `SHOW MASTER STATUS`、`RESET MASTER`、`SHOW MASTER LOGS`、`PURGE MASTER LOGS` | `SHOW BINARY LOG STATUS`、`RESET BINARY LOGS AND GTIDS`、`SHOW BINARY LOGS`、`PURGE BINARY LOGS` |
| `CHANGE REPLICATION SOURCE TO` 的 `MASTER_*` 选项 | `SOURCE_*` 选项，如 `SOURCE_HOST` |
| `default_authentication_plugin` | `authentication_policy` |
| `expire_logs_days` | `binlog_expire_logs_seconds` |
| `binlog_transaction_dependency_tracking` | 无，源端始终按 WRITESET 计算事务依赖 |
| `FLUSH HOSTS` | `TRUNCATE TABLE performance_schema.host_cache` |
| `mysql_upgrade`、`mysqlpump`、`mysql_ssl_rsa_setup` | 升级由 mysqld 启动时自动完成；逻辑备份用 `mysqldump` 或 MySQL Shell 的 dump 工具 |
| `keyring_file` 等 keyring 插件 | 对应的 `component_keyring_*` 组件 |
| `FLOAT` / `DOUBLE` 列上的 `AUTO_INCREMENT` | 升级前改为整数类型 |

依赖 `SHOW SLAVE STATUS` 的监控脚本、使用旧复制语法的高可用组件和 CDC 工具，升级前都要先确认兼容。

### 2、`mysql_native_password` 默认不加载

8.4 不再默认加载 `mysql_native_password`，9.0 起该插件被彻底移除。处理顺序：

1. **首选**：升级客户端驱动（Connector/J 8.0+ 都支持 `caching_sha2_password`），把账号改为新插件：`ALTER USER 'legacy_app'@'%' IDENTIFIED WITH caching_sha2_password BY 'new_password';`
2. **过渡**：确实无法升级的老客户端，先在配置中启用插件，**之后**才能创建或使用 `mysql_native_password` 账号；不先启用插件，`IDENTIFIED WITH mysql_native_password` 会直接失败

```ini
[mysqld]
mysql_native_password = ON   # 仅作为过渡；升级到 9.x 前必须迁移完
```

### 3、InnoDB 默认值变化

| 参数 | 8.0 默认 | 8.4 默认 |
|------|---------|---------|
| `innodb_adaptive_hash_index` | `ON` | `OFF` |
| `innodb_change_buffering` | `all` | `none` |
| `innodb_io_capacity` | 200 | 10000 |
| `innodb_log_buffer_size` | 16 MiB | 64 MiB |
| `innodb_flush_method`（Linux） | `fsync` | 支持时为 `O_DIRECT` |
| `innodb_buffer_pool_instances` | 8（缓冲池小于 1 GiB 时为 1） | 按缓冲池大小与 CPU 数自动计算 |
| `innodb_parallel_read_threads` | 4 | 逻辑 CPU 数 / 8，至少 4 |
| `innodb_read_io_threads` | 4 | 逻辑 CPU 数 / 2，至少 4 |
| `innodb_purge_threads` | 4 | CPU ≤ 16 时为 1，否则 4 |
| `innodb_numa_interleave` | `OFF` | `ON` |
| `temptable_max_ram` | 1 GiB | 总内存的 3%，介于 1 ~ 4 GiB |

自适应哈希索引和 Change Buffer 默认关闭，对等值查询密集或二级索引写入多的业务可能有影响，升级后对比压测结果，必要时显式打开。Change Buffer 的原理见 [MySQL 索引](./4_topic_index)。

### 4、新增能力

- **直方图自动更新**：见上文 `AUTO UPDATE`
- **GTID 标签**：GTID 格式扩展为 `UUID:TAG:NUMBER`，可以给一批事务打标签，便于区分来源；原 `UUID:NUMBER` 格式继续有效
- **`EXPLAIN ... INTO`**：把 JSON 格式的执行计划存进用户变量，便于程序化分析

```sql
SET @@SESSION.gtid_next = 'AUTOMATIC:batch';   -- 需要 TRANSACTION_GTID_TAG 权限

EXPLAIN FORMAT=JSON INTO @plan SELECT * FROM orders WHERE status = 'paid';
SELECT JSON_EXTRACT(@plan, '$.query_block.cost_info.query_cost') AS cost;
```

---

## 五、9.x Innovation 与 9.7 LTS

### 1、VECTOR 类型：社区版只能存储

9.0 引入 `VECTOR(N)` 类型，按 4 字节单精度浮点存储 N 维向量。社区版只提供类型本身和转换函数：

```sql
CREATE TABLE doc_embedding (
  id      BIGINT PRIMARY KEY AUTO_INCREMENT,
  content TEXT,
  vec     VECTOR(4)                 -- 示例用 4 维，实际模型常见 768 / 1024 / 1536 维
);

INSERT INTO doc_embedding (content, vec)
VALUES ('Java 并发编程', STRING_TO_VECTOR('[0.12, -0.34, 0.56, 0.08]'));

SELECT id, VECTOR_DIM(vec) AS dim, VECTOR_TO_STRING(vec) AS v FROM doc_embedding;
```

| 能力 | 社区版 / 企业版 | HeatWave on OCI / MySQL AI |
|------|----------------|---------------------------|
| `VECTOR` 类型、`STRING_TO_VECTOR`、`VECTOR_TO_STRING`、`VECTOR_DIM` | 支持 | 支持 |
| `DISTANCE()` 相似度计算 | 不支持 | 支持（`COSINE` / `DOT` / `EUCLIDEAN`） |
| 向量索引（ANN） | 不支持，`VECTOR` 列不能作为索引键 | 由 HeatWave GenAI 提供 |

在自建 MySQL 上做语义检索需要另选方案：PostgreSQL + pgvector、MariaDB 11.8 LTS 起的向量索引（见 [MariaDB](./2_maria_db)），或 Elasticsearch / OpenSearch 的向量检索（见 [搜索数据库](../4_nosql/3_search_db)）。

### 2、9.7 LTS 相对 8.4 的主要变化

- **`mysql_native_password` 已移除**（9.0）：8.4 上的过渡账号必须在升级前迁移完
- **Instant DDL 行版本上限提高到 255**（9.1）
- **原企业版功能进入社区版**：复制 applier 指标、Group Replication 流控统计、资源管理、按数据新旧选主等高可用观测能力，以及遥测（Telemetry）
- **企业版新增动态数据脱敏**；JavaScript 存储程序（基于 GraalVM 的 MLE）仍只在企业版和 HeatWave 中提供
- **复制默认值调整**：`binlog_transaction_dependency_history_size` 默认值提高到 1000000（9.5）；`replica_parallel_type` 在 9.x 中被移除，多线程副本固定按逻辑时钟并行应用

### 3、选择建议

- 新项目和 8.0 升级目标：**8.4 LTS**，生态（驱动、CDC、备份工具、云托管）最成熟
- 需要 9.x 新能力并能接受较新版本：**9.7 LTS**，从 8.4 直接升级
- 26.x 等 Innovation 版本只用于评估新特性，不建议直接上生产

---

## 六、特性对比

| 特性 | 5.7 | 8.0 | 8.4 LTS | 9.7 LTS |
|------|-----|-----|---------|---------|
| JSON 类型 | 支持 | 支持（增强） | 支持 | 支持 |
| VIRTUAL 生成列上建索引 | 支持 | 支持 | 支持 | 支持 |
| 窗口函数 / 递归 CTE | 不支持 | 支持 | 支持 | 支持 |
| 不可见索引 / 降序索引 | 不支持 | 支持 | 支持 | 支持 |
| 函数索引 | 不支持 | 8.0.13+ | 支持 | 支持 |
| JSON 多值索引 | 不支持 | 8.0.17+ | 支持 | 支持 |
| INSTANT 加列 | 不支持 | 8.0.12+（任意位置 8.0.29+） | 支持 | 支持（行版本上限 255） |
| 原子 DDL | 不支持 | 支持 | 支持 | 支持 |
| Hash Join / `EXPLAIN ANALYZE` | 不支持 | 8.0.18+ | 支持 | 支持 |
| 查询缓存 | 支持 | 已移除 | 已移除 | 已移除 |
| 默认字符集 | `latin1` | `utf8mb4` | `utf8mb4` | `utf8mb4` |
| 默认认证插件 | `mysql_native_password` | `caching_sha2_password` | `caching_sha2_password` | `caching_sha2_password` |
| `mysql_native_password` | 默认 | 可用（已弃用） | 默认不加载 | 已移除 |
| MASTER / SLAVE 复制语法 | 唯一语法 | 可用（已弃用） | 已移除 | 已移除 |
| 直方图自动更新 | 不支持 | 不支持 | 支持 | 支持 |
| VECTOR 类型 | 不支持 | 不支持 | 不支持 | 仅存储 |

---

## 七、8.0 升级到 8.4 的检查清单

1. 用 MySQL Shell 的 `util.checkForServerUpgrade()` 扫描实例，处理报告中的错误项
2. 清理配置文件里已移除的参数（`expire_logs_days`、`default_authentication_plugin`、`binlog_transaction_dependency_tracking` 等），否则 mysqld 无法启动
3. 替换运维脚本、监控和高可用组件中的 `MASTER` / `SLAVE` 语法，确认 CDC 工具版本支持 8.4
4. 盘点仍在用 `mysql_native_password` 的账号，升级驱动后改为 `caching_sha2_password`
5. 评估 InnoDB 默认值变化，尤其是自适应哈希索引、Change Buffer 和 `innodb_io_capacity`，在预发环境压测对比
6. 先升级副本，再切换主库；保留回退方案（8.4 不能原地降级回 8.0，需要依赖备份或逻辑复制回退）

---

## 小结

- 生产选 LTS：8.0 已于 2026 年 4 月停止维护，当前基线是 8.4 LTS，9.7 LTS 可从 8.4 直接升级；9.7 之后改为 `YY.M.P` 日历版本
- 5.7 起 VIRTUAL 生成列即可建索引，8.0.13 起支持函数索引，查询表达式要与索引定义完全一致
- 不可见索引不能被 `FORCE INDEX` 强制使用，验证时打开 `use_invisible_indexes`；降序索引只对多列混合排序方向有意义
- INSTANT 加列从 8.0.12 开始，8.0.29 支持任意位置和删列，受行版本上限约束，且仍需要 MDL
- 8.4 移除了 MASTER / SLAVE 语法、`default_authentication_plugin`、`expire_logs_days` 等，并调整了多项 InnoDB 默认值，升级时先查配置和脚本
- 社区版 VECTOR 只能存储，`DISTANCE()` 和向量索引仅在 HeatWave / MySQL AI 中提供

## 参考资料

- MySQL 8.4 新特性与移除项：[https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)
- MySQL 9.7 发布说明：[https://dev.mysql.com/doc/relnotes/mysql/9.7/en/](https://dev.mysql.com/doc/relnotes/mysql/9.7/en/)
- MySQL 发布模型与版本号：[https://dev.mysql.com/doc/refman/9.7/en/mysql-releases.html](https://dev.mysql.com/doc/refman/9.7/en/mysql-releases.html)
- MySQL 8.0 发布说明：[https://dev.mysql.com/doc/relnotes/mysql/8.0/en/](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/)
- 函数索引与多值索引：[https://dev.mysql.com/doc/refman/8.4/en/create-index.html](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)
- 不可见索引：[https://dev.mysql.com/doc/refman/8.4/en/invisible-indexes.html](https://dev.mysql.com/doc/refman/8.4/en/invisible-indexes.html)
- Online DDL 操作：[https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- 向量函数：[https://dev.mysql.com/doc/refman/9.7/en/vector-functions.html](https://dev.mysql.com/doc/refman/9.7/en/vector-functions.html)

> 下一篇：[MariaDB](./2_maria_db) —— MySQL 分支的现状：版本线、与 MySQL 的差异、特有能力和迁移注意事项。

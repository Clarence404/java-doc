---
description: 9.6 ~ 13 要点、14 ~ 18 逐版新特性、升级时的行为变化、特性起始版本速查
---

# PostgreSQL 版本特性

> 前置阅读：[PostgreSQL 基础](./0_overview)

本篇按版本梳理 PostgreSQL 9.6 到 18 的关键特性与升级到 15、17、18 时的行为变化，以 PG 18 为基线，17 的差异单独标注。13 及更早版本已停止支持只保留相关要点，文中性能数字均来自官方发布公告，实际收益取决于负载。

---

## 一、9.6 ～ 13 要点（均已停止支持）

支持周期见 [PostgreSQL 基础](./0_overview)。

| 版本 | 发布 | 关键特性 |
|------|------|----------|
| 9.6 | 2016-09 | 并行查询（顺序扫描、Join、聚合）；多个同步备库（按优先级，语法 `2 (s1, s2)`）；`pg_stat_activity` 新增 `wait_event_type` / `wait_event`；`postgres_fdw` 下推远端 Join、排序、UPDATE / DELETE；`pg_stat_progress_vacuum` |
| 10 | 2017-10 | 声明式分区（RANGE / LIST）；内置逻辑复制；标识列 `IDENTITY`；Hash 索引写 WAL、崩溃安全；SCRAM-SHA-256 认证；quorum 同步提交 `ANY n (...)`；`postgres_fdw` 聚合下推；`CREATE STATISTICS`（ndistinct、dependencies） |
| 11 | 2018-10 | `CREATE PROCEDURE`（过程内可提交事务）；JIT 编译（12 起默认开启）；`INCLUDE` 覆盖索引；HASH 分区与 DEFAULT 分区；分区表上的主键 / 唯一索引及引用其他表的外键；分区级聚合（`enable_partitionwise_aggregate`） |
| 12 | 2019-10 | 生成列（STORED）；CTE 默认内联；`REINDEX CONCURRENTLY`；SQL/JSON path 语言与 `jsonb_path_*` 函数；外键可引用分区表；`CREATE STATISTICS` 支持 MCV；`pg_checksums --enable`；B-tree 存储优化 |
| 13 | 2020-09 | B-tree 去重；`FETCH FIRST ... WITH TIES`；`pg_verifybackup`；`logical_decoding_work_mem` 与大事务流式解码的基础设施；按插入量触发 autovacuum；`max_slot_wal_keep_size`；分区级 Join 支持边界不完全一致的分区 |

下面只展开在日常开发中仍会直接用到的几项。

### 1、声明式分区（10 / 11）

```sql
-- 范围分区
CREATE TABLE orders (id BIGINT, created_at DATE, amount NUMERIC)
PARTITION BY RANGE (created_at);

CREATE TABLE orders_2025 PARTITION OF orders
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE orders_2026 PARTITION OF orders
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE orders_default PARTITION OF orders DEFAULT;   -- 11 起

-- 列表分区
CREATE TABLE logs (id BIGINT, region TEXT, msg TEXT) PARTITION BY LIST (region);
CREATE TABLE logs_cn PARTITION OF logs FOR VALUES IN ('cn');
CREATE TABLE logs_us PARTITION OF logs FOR VALUES IN ('us');

-- 哈希分区（11 起）
CREATE TABLE accounts (user_id BIGINT, balance NUMERIC) PARTITION BY HASH (user_id);
CREATE TABLE accounts_0 PARTITION OF accounts FOR VALUES WITH (MODULUS 4, REMAINDER 0);
-- ... REMAINDER 1 ~ 3 同理
```

分区表上的主键 / 唯一约束必须包含分区键。单库分区与分库分表的取舍见 [分库分表与中间件](../5_practice/2_sharding)。

### 2、标识列（10）

```sql
-- ALWAYS：不允许手动指定值（除非 OVERRIDING SYSTEM VALUE）
-- BY DEFAULT：允许手动指定，适合数据迁移
CREATE TABLE users (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT
);
```

### 3、存储过程（11）

函数不能在内部提交事务，存储过程可以，用 `CALL` 调用：

```sql
CREATE PROCEDURE transfer(from_id BIGINT, to_id BIGINT, amount NUMERIC)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance = balance - amount WHERE user_id = from_id;
  UPDATE accounts SET balance = balance + amount WHERE user_id = to_id;
  COMMIT;
END;
$$;

CALL transfer(1, 2, 100.00);
```

### 4、CTE 内联与生成列（12）

12 之前 CTE 总是先物化（优化屏障），12 起没有副作用、只引用一次的 CTE 默认内联，需要旧行为时写 `AS MATERIALIZED`。12 的生成列只有 `STORED`，18 增加了 `VIRTUAL` 并改为默认，见下文。

### 5、扩展统计（10 / 12）

相关列（如 `city` 与 `province`）上的行数估算容易偏差，可以建扩展统计：

```sql
-- ndistinct / dependencies 从 10 起支持，mcv 从 12 起支持
CREATE STATISTICS stat_status_region (dependencies, mcv) ON status, region FROM orders;
ANALYZE orders;
```

`pg_checksums --enable`（12）可给已有集群开启数据校验和，但整个重写过程中集群必须保持停机，大库耗时很长。

---

## 二、PostgreSQL 14（2021-09）

| 特性 | 说明 |
|------|------|
| 多范围类型 | `datemultirange` 等，一个值表示多段不连续区间 |
| JSONB 下标 | `data['address']['city']` 读写，用法见 [PostgreSQL 高级 SQL](./4_topic_advanced_sql) |
| 存储过程 OUT 参数 | `CREATE PROCEDURE ... OUT` |
| B-tree 自底向上删除 | 频繁 UPDATE 时主动清理索引中的过期条目，减缓索引膨胀 |
| `pg_read_all_data` / `pg_write_all_data` | 预定义角色，一次授权读 / 写所有表 |
| 逻辑复制流式传输 | 订阅选项 `streaming = on`，大事务在提交前就开始传给订阅端 |
| 递归 CTE `SEARCH` / `CYCLE` | 深度 / 广度优先排序与环检测 |
| `idle_session_timeout` | 断开长时间空闲的会话 |
| XID 回卷保护调整 | 告警与停写阈值调整为剩余 4000 万 / 300 万；新增 `vacuum_failsafe_age` |
| libpq 管道模式 | C 客户端的管道 API；PgJDBC 自己实现协议，`executeBatch` 早就是管道化发送，不依赖它 |

```sql
-- 多范围：判断日期是否落在任一区间
SELECT '2024-01-10'::date <@ '{[2024-01-01,2024-01-15],[2024-02-01,2024-02-15]}'::datemultirange;

-- 带 OUT 参数的存储过程，COUNT(*) 返回 bigint，OUT 参数类型要一致
CREATE PROCEDURE get_order_stats(
  IN  p_user_id BIGINT,
  OUT total     NUMERIC,
  OUT cnt       BIGINT
) LANGUAGE sql AS $$
  SELECT SUM(amount), COUNT(*) FROM orders WHERE user_id = p_user_id;
$$;

CALL get_order_stats(123, NULL, NULL);
```

---

## 三、PostgreSQL 15（2022-10）

### 1、MERGE

```sql
MERGE INTO inventory AS t
USING incoming AS s ON t.sku = s.sku
WHEN MATCHED AND s.qty > 0 THEN
  UPDATE SET qty = t.qty + s.qty, updated_at = now()
WHEN MATCHED AND s.qty = 0 THEN
  DELETE
WHEN NOT MATCHED THEN
  INSERT (sku, qty) VALUES (s.sku, s.qty);
```

`MERGE` 和 `INSERT ... ON CONFLICT` 的区别见 [PostgreSQL 高级 SQL](./4_topic_advanced_sql)。

### 2、逻辑复制行 / 列过滤

```sql
CREATE PUBLICATION pub_active_users FOR TABLE users (id, name, email)
  WHERE (status = 'active');
```

### 3、其他

- 排序：内存与磁盘排序算法改进，官方公告给出的提升为 25%～400%（视数据类型而定）
- `wal_compression` 支持 `lz4` / `zstd`
- `log_destination = 'jsonlog'` 输出 JSON 格式日志，便于接入日志平台
- `UNIQUE NULLS NOT DISTINCT`：让唯一约束把多个 NULL 视为重复

### 4、升级注意：public Schema 不再允许所有人建表

15 起新建数据库的 `public` Schema 收回了 `PUBLIC` 的 `CREATE` 权限，属主改为 `pg_database_owner`。用非属主账号执行 Flyway / Liquibase 迁移会在建表时报 `permission denied for schema public`。处理方式见 [PostgreSQL 基础](./0_overview)。

---

## 四、PostgreSQL 16（2023-09）

| 特性 | 说明 |
|------|------|
| 并行查询增强 | `FULL JOIN` / `RIGHT JOIN` 可并行 |
| SIMD 加速 | x86 与 ARM 上加速 ASCII / JSON 字符串处理、数组搜索 |
| `COPY` 批量导入 | 官方公告称部分场景提升可达 300% |
| 从备库做逻辑解码 | 订阅端可以连接备库消费变更，减轻主库压力 |
| SQL/JSON 构造函数 | `JSON_ARRAY`、`JSON_OBJECT`、`JSON_ARRAYAGG`、`IS JSON` |
| `pg_stat_io` | 按后端类型、对象、上下文统计 IO |
| 角色继承细粒度控制 | `GRANT ... WITH INHERIT TRUE/FALSE` |
| 逻辑复制并行应用 | 订阅选项 `streaming = parallel` |

从备库做逻辑解码时，`CREATE PUBLICATION` 仍然在**主库**执行（备库只读），发布定义随 WAL 复制到备库；主库需要 `wal_level = logical`，备库通常还要开 `hot_standby_feedback`，避免所需的系统表旧版本被主库清理。

```sql
SELECT JSON_OBJECT('id': 1, 'name': 'Alice');          -- {"id" : 1, "name" : "Alice"}
SELECT '{"a":1,"a":2}' IS JSON WITH UNIQUE KEYS;        -- false

SELECT backend_type, object, context, reads, hits, evictions
FROM pg_stat_io
ORDER BY reads DESC NULLS LAST;
```

---

## 五、PostgreSQL 17（2024-09）

### 1、增量备份

`pg_basebackup --incremental` 基于上次备份的 manifest 只拷贝变化的块，恢复前用 `pg_combinebackup` 合成完整备份。前提是服务端开启 `summarize_wal = on`，且 `pg_combinebackup` 只接受 plain 格式（目录）备份。完整流程与 PITR 见 [数据备份与恢复](../5_practice/1_backup_recovery)。

### 2、SQL/JSON 查询函数与 JSON_TABLE

```sql
SELECT jt.*
FROM orders,
     JSON_TABLE(items, '$[*]' COLUMNS (
       product_id INT PATH '$.id',
       qty        INT PATH '$.qty'
     )) AS jt;

SELECT JSON_EXISTS('{"address":{"city":"Shanghai"}}'::jsonb, '$.address.city');   -- true
SELECT JSON_VALUE('{"name":"Alice"}'::jsonb, '$.name');                            -- Alice
```

### 3、其他

| 特性 | 说明 |
|------|------|
| `MERGE ... RETURNING` | MERGE 可返回受影响的行，并可作用于可更新视图 |
| `MAINTAIN` 权限 | 授权执行 VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH MATERIALIZED VIEW / LOCK TABLE |
| VACUUM 内存结构 | 官方公告称内存占用最多降低 20 倍，且不再受 1GB 上限约束 |
| WAL 写入 | 官方公告称高并发写入吞吐最高提升 2 倍 |
| `COPY ... ON_ERROR ignore` | 跳过格式错误的行继续导入 |
| `transaction_timeout` | 限制整个事务的最长时间（含空闲时间） |
| pg_upgrade 保留逻辑复制槽 | 仅当旧集群为 17 及以上时生效，从 16 升级上来仍要重建 |
| 逻辑复制故障切换 | 逻辑复制槽可同步到备库（`failover` 选项），切主后订阅不断 |

```sql
COPY bad_data FROM '/data/messy.csv'
WITH (FORMAT csv, ON_ERROR ignore, LOG_VERBOSITY verbose);
```

---

## 六、PostgreSQL 18（2025-09）

### 1、异步 I/O

新增异步 I/O 子系统，后端可以一次排队多个读请求，加速顺序扫描、位图堆扫描和 VACUUM 等读路径（写路径不在此列）。

```ini
# postgresql.conf，三选一，修改需重启
io_method = worker      # 默认值，由 io worker 进程代为执行 IO，跨平台
# io_method = io_uring  # 仅 Linux，且需编译时带 --with-liburing
# io_method = sync      # 关闭异步 IO，行为同 17
```

官方公告给出的读密集场景提升最高约 3 倍；是否改用 `io_uring` 应基于自己的压测。

### 2、uuidv7()

```sql
-- 带时间戳的 UUID，按时间大致有序，作为 B-tree 主键时插入集中在索引右侧，页分裂少
CREATE TABLE events (
  id      UUID DEFAULT uuidv7() PRIMARY KEY,
  payload JSONB
);
SELECT uuidv7();
SELECT uuidv4();   -- gen_random_uuid() 的显式别名
```

17 及以前没有 `uuidv7()`，可以在应用侧生成（如 Java 的 UUID v7 库），或继续用 `gen_random_uuid()` 但接受随机插入带来的索引碎片。

### 3、虚拟生成列成为默认

```sql
CREATE TABLE order_lines (
  price         NUMERIC,
  qty           INT,
  total_virtual NUMERIC GENERATED ALWAYS AS (price * qty),          -- 18 默认 VIRTUAL，读取时计算
  total_stored  NUMERIC GENERATED ALWAYS AS (price * qty) STORED    -- 写入时计算并存储
);
```

18 起不写 `STORED` 的生成列是虚拟列，不占存储，但不能建索引；需要索引的生成列要显式写 `STORED`。从 12～17 迁移来的 DDL 本来就必须写 `STORED`，不受影响。

### 4、查询优化

```sql
-- B-tree skip scan：索引 (status, created_at)，条件只有 created_at 也可能走索引
-- 前导列取值越少越有效
SELECT * FROM orders WHERE created_at > '2025-01-01';

-- OR 条件自动转成 = ANY(...)，便于走索引
SELECT * FROM users WHERE status = 'active' OR status = 'pending';
```

skip scan 对联合索引最左前缀规则的影响见 [PostgreSQL 索引类型](./3_topic_index)。

### 5、SQL 与约束

| 特性 | 说明 |
|------|------|
| `RETURNING OLD / NEW` | DML 可同时返回修改前后的值，示例见 [PostgreSQL 高级 SQL](./4_topic_advanced_sql) |
| 时态约束 | 主键 / 唯一约束 `WITHOUT OVERLAPS`、外键 `PERIOD`，约束“同一资源的时间段不重叠” |
| `NOT NULL ... NOT VALID` | 先加约束不校验存量数据，后续 `VALIDATE CONSTRAINT`，避免大表长时间锁 |

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- 非范围列参与 WITHOUT OVERLAPS 需要它

CREATE TABLE room_booking (
  room_id INT,
  during  TSTZRANGE,
  PRIMARY KEY (room_id, during WITHOUT OVERLAPS)
);
```

### 6、运维与安全

| 特性 | 说明 |
|------|------|
| 数据校验和默认开启 | `initdb` 默认启用，`--no-data-checksums` 关闭；`pg_upgrade` 要求新旧集群设置一致，旧集群未开启时新集群需用该选项初始化 |
| MD5 密码弃用 | 设置 MD5 密码会告警，后续大版本将移除，改用 SCRAM |
| pg_upgrade 保留统计信息 | 升级后不必等全库 `ANALYZE` 完才恢复正常计划（扩展统计除外） |
| `autovacuum_vacuum_max_threshold` | 默认 1 亿，给按比例触发的 autovacuum 加上限，大表不再迟迟不触发 |
| `idle_replication_slot_timeout` | 自动失效长期不活跃的复制槽，防止 WAL 堆积 |
| 逻辑复制冲突统计 | 应用冲突写日志并计入 `pg_stat_subscription_stats` |
| 生成列参与逻辑复制 | `publish_generated_columns` 控制是否发布生成列的值 |
| OAuth 认证 | `pg_hba.conf` 新增 `oauth` 方法，需配合令牌校验模块 |
| 线协议 3.2 | 首次升级协议版本（取消请求密钥加长到 256 位），libpq 默认仍使用 3.0 |
| 官方 Docker 镜像 | 数据目录改为 `/var/lib/postgresql/18/docker`，挂载点见 [PostgreSQL 基础](./0_overview) |

OAuth 不是只写一行 `issuer` 就能工作：服务端要在 `oauth_validator_libraries` 里加载令牌校验模块，`pg_hba.conf` 中还要声明 `scope`：

```ini
# postgresql.conf
oauth_validator_libraries = 'my_validator'

# pg_hba.conf
host  mydb  all  0.0.0.0/0  oauth  issuer="https://auth.example.com" scope="openid postgres"
```

---

## 七、特性起始版本速查

| 特性 | 起始版本 |
|------|----------|
| 并行查询 | 9.6 |
| 声明式分区、逻辑复制、标识列、SCRAM 认证 | 10 |
| 存储过程、JIT、`INCLUDE` 覆盖索引、HASH 分区 | 11 |
| 生成列（STORED）、CTE 默认内联、`REINDEX CONCURRENTLY`、jsonpath | 12 |
| B-tree 去重、`WITH TIES`、`max_slot_wal_keep_size` | 13 |
| 多范围类型、JSONB 下标、`pg_read_all_data`、`SEARCH` / `CYCLE` | 14 |
| `MERGE`、逻辑复制行列过滤、public Schema 收回 `CREATE` | 15 |
| SQL/JSON 构造函数、`pg_stat_io`、从备库逻辑解码 | 16 |
| `JSON_TABLE`、增量备份、`MAINTAIN` 权限、`transaction_timeout` | 17 |
| 异步 I/O、`uuidv7()`、虚拟生成列、skip scan、`RETURNING OLD/NEW`、时态约束、OAuth | 18 |

---

## 小结

- 13 及以前已停止支持，14 将于 2026-11 停止支持，新项目直接选 18
- 15 收回了 `public` Schema 的 `CREATE` 权限，是升级后迁移脚本报错的常见原因
- `pg_read_all_data` 是 14 引入的，quorum 同步提交（`ANY n`）是 10 引入的，jsonpath 是 12 引入的
- 17 的增量备份依赖 `summarize_wal = on`，且只支持 plain 格式
- 18 的生成列默认是 VIRTUAL，需要索引时显式写 `STORED`；数据校验和默认开启，升级时要与旧集群一致
- 18 的异步 I/O 默认 `worker`，只覆盖读路径；`io_uring` 需要编译支持
- PgJDBC 不依赖 libpq，libpq 层面的新特性（管道模式、协议 3.2）不会自动作用于 Java 应用

## 参考资料

- PostgreSQL 发布说明：[https://www.postgresql.org/docs/release/](https://www.postgresql.org/docs/release/)
- PostgreSQL 18 发布说明：[https://www.postgresql.org/docs/18/release-18.html](https://www.postgresql.org/docs/18/release-18.html)
- PostgreSQL 17 发布说明：[https://www.postgresql.org/docs/17/release-17.html](https://www.postgresql.org/docs/17/release-17.html)
- PostgreSQL 18 新闻稿资料：[https://www.postgresql.org/about/press/presskit18/](https://www.postgresql.org/about/press/presskit18/)
- 特性矩阵：[https://www.postgresql.org/about/featurematrix/](https://www.postgresql.org/about/featurematrix/)
- 版本支持策略：[https://www.postgresql.org/support/versioning/](https://www.postgresql.org/support/versioning/)

> 下一篇：[MVCC 与 VACUUM](./2_topic_mvcc) —— 元组可见性、HOT 更新、VACUUM 与 XID 回卷，以及 PG 的隔离级别和 MySQL 有什么不同。

---
description: 与 MySQL 的差异、版本支持、Docker 与 JDBC 接入、Schema 与类型映射、psql 与运维、权限
---

# PostgreSQL 基础

> 前置阅读：[MySQL 基础](../1_mysql/0_overview)

PostgreSQL 起源于 1986 年加州大学伯克利分校的 POSTGRES 项目，是功能最完整的开源关系型数据库之一。本篇从 MySQL 开发者视角讲两者的关键差异、用 Docker 起 PG 18 并用 JDBC 接入，以及日常排查用的 psql 命令与系统视图。

---

## 一、版本与支持周期

PG 每年 9～10 月发布一个大版本，每个大版本维护 5 年，季度发布小版本（只修 bug 与安全问题，同一大版本内可直接替换二进制升级）。

| 大版本 | 首次发布 | 停止支持 | 说明 |
|--------|----------|----------|------|
| 18 | 2025-09 | 2030-11 | 当前主线，本系列的基线 |
| 17 | 2024-09 | 2029-11 | 存量主流，文中标注与 18 的差异 |
| 16 | 2023-09 | 2028-11 | |
| 15 | 2022-10 | 2027-11 | |
| 14 | 2021-09 | 2026-11 | 即将停止支持 |
| 13 及更早 | — | 已停止 | 13 已于 2025-11 停止支持 |

各版本新特性见 [PostgreSQL 版本特性](./1_feature)。

---

## 二、与 MySQL 的差异（Java 开发视角）

| 维度 | MySQL（InnoDB） | PostgreSQL |
|------|----------------|-----------|
| 自增主键 | `AUTO_INCREMENT` | `GENERATED ... AS IDENTITY`（推荐）/ `SERIAL`（旧写法） |
| 布尔类型 | `BOOLEAN` 只是 `TINYINT(1)` 的别名 | 原生 `BOOLEAN` |
| JSON | `JSON` 以二进制格式存储，靠生成列、函数索引、多值索引建索引 | `JSONB` 二进制存储，可对整列建 GIN 索引，支持 `@>`、`?` 等包含运算 |
| 数组 | 无原生数组 | `INTEGER[]`、`TEXT[]` 等原生数组 |
| 字符串拼接 | `CONCAT()`（`||` 默认是逻辑或） | `||` 或 `CONCAT()` |
| 字符串比较 | 默认排序规则 `utf8mb4_0900_ai_ci` 不区分大小写 | 默认区分大小写，忽略大小写用 `ILIKE` 或 `lower()` 表达式索引 |
| 标识符大小写 | 表名大小写取决于操作系统和 `lower_case_table_names` | 未加双引号的标识符一律折叠为小写，`"UserName"` 加引号才保留大小写 |
| UPSERT | `INSERT ... ON DUPLICATE KEY UPDATE` | `INSERT ... ON CONFLICT (...) DO UPDATE / DO NOTHING`，另有 `MERGE` |
| 命名空间 | 数据库即命名空间 | 实例 → 数据库 → Schema（默认 `public`） → 表 |
| 存储结构 | 聚簇索引：表数据就存在主键 B+ 树里 | 堆表 + 索引，所有索引（含主键）都指向行的物理位置 `ctid` |
| 默认隔离级别 | REPEATABLE READ | READ COMMITTED |
| RR 的语义 | 快照读 + 当前读加 Next-Key Lock | 快照隔离，并发更新同一行直接报序列化失败，需要应用重试 |
| DDL 与事务 | 8.0 起 DDL 是原子的，但会隐式提交，无法和 DML 一起回滚 | 绝大多数 DDL 可放在事务里一起回滚（`CREATE INDEX CONCURRENTLY`、`CREATE DATABASE` 等除外） |
| 旧版本清理 | undo log + purge 线程 | 旧版本留在堆表，靠 VACUUM 回收 |
| 连接模型 | 每连接一个线程 | 每连接一个进程，必须配连接池 |
| GIS | 内置空间类型，功能较少 | PostGIS 扩展（事实标准） |
| 全文检索 | `FULLTEXT` 索引 | 内置 `tsvector` / `tsquery` + GIN 索引 |

存储结构、MVCC 与隔离级别的差异是 MySQL 用户最容易踩坑的地方，详见 [MVCC 与 VACUUM](./2_topic_mvcc) 和 [PostgreSQL 索引类型](./3_topic_index)。

---

## 三、安装与接入

### 1、Docker Compose

```yaml
services:
  postgres:
    image: postgres:18          # 生产环境请固定到具体小版本，如 18.x
    container_name: postgres
    restart: always
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: change-me   # 演示用，生产用 secrets 注入
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    volumes:
      - ./postgres_data:/var/lib/postgresql   # 18 起挂载父目录
```

PG 18 官方镜像改了数据目录：`PGDATA` 变为带版本号的 `/var/lib/postgresql/18/docker`，`VOLUME` 声明改为 `/var/lib/postgresql`，因此挂载点应是 `/var/lib/postgresql`。17 及以前的镜像挂载 `/var/lib/postgresql/data`。注意两点：

- 沿用旧写法把卷挂到 `/var/lib/postgresql/data`，18 镜像会拒绝启动或数据写进匿名卷，重建容器后数据丢失
- 把 17 镜像直接换成 18 不会自动升级数据，大版本升级需要 `pg_upgrade`、`pg_dump` / `pg_restore` 或逻辑复制

### 2、Spring Boot 接入

```xml
<dependency>
  <groupId>org.postgresql</groupId>
  <artifactId>postgresql</artifactId>
  <scope>runtime</scope>
</dependency>
```

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb?currentSchema=public
    username: app
    password: change-me
```

依赖版本由 Spring Boot 管理，驱动类名可省略。表不在 `public` 下时用 `currentSchema` 指定，或在用户级别设置默认搜索路径：`ALTER ROLE app SET search_path = finance, public;`。数据源与连接池配置见 [数据访问](/spring-boot/3_data_access)、[数据库连接池](../5_practice/3_connection_pool)。

### 3、常用客户端

| 工具 | 类型 | 说明 |
|------|------|------|
| `psql` | CLI | 官方命令行客户端，排查必备 |
| pgAdmin 4 | GUI | 官方管理工具 |
| DBeaver | GUI | 跨平台、多数据库 |
| DataGrip | IDE | JetBrains 出品 |

---

## 四、核心概念

### 1、逻辑结构

![PostgreSQL 逻辑结构](../../assets/database/pg-logical-structure.svg)

一个实例下有多个数据库，数据库之间不能直接跨库查询（需要 `postgres_fdw` 等扩展）；同一数据库内的多个 Schema 可以互相引用。Schema 的典型用途：

- 多租户隔离：每个租户一个 Schema，共享同一数据库
- 模块划分：`finance.orders`、`logistics.orders` 互不干扰
- 权限隔离：按 Schema 授予 `USAGE` / `CREATE`

```sql
CREATE SCHEMA finance;
CREATE TABLE finance.accounts (id BIGINT PRIMARY KEY, balance NUMERIC(18, 2));

-- 搜索路径：未写 Schema 前缀时按顺序查找
SET search_path = finance, public;
```

PG 15 起，`public` Schema 上的 `CREATE` 权限不再默认授予所有用户（`PUBLIC`），只有数据库属主才能在其中建表。从 14 及以前升级上来的应用、Flyway 迁移若用非属主账号建表，会报 `permission denied for schema public`，需要显式 `GRANT CREATE ON SCHEMA public TO app;`，或者让应用账号成为数据库 / Schema 的属主。

### 2、数据类型与 Java 映射

| PostgreSQL 类型 | Java 类型（PgJDBC） | 说明 |
|----------------|---------------------|------|
| `SMALLINT` / `INTEGER` / `BIGINT` | `Short` / `Integer` / `Long` | 2 / 4 / 8 字节 |
| `BIGINT GENERATED ... AS IDENTITY` | `Long` | 标识列的 Java 类型取决于列类型，`INT` 标识列对应 `Integer` |
| `SERIAL` / `BIGSERIAL` | `Integer` / `Long` | 旧式自增：整数列 + 序列默认值 |
| `NUMERIC(p,s)` | `BigDecimal` | 精确小数，金额用它 |
| `REAL` / `DOUBLE PRECISION` | `Float` / `Double` | 浮点 |
| `VARCHAR(n)` / `TEXT` | `String` | `TEXT` 与 `VARCHAR` 性能相同，长度约束按业务需要加 |
| `BOOLEAN` | `Boolean` | 原生布尔 |
| `DATE` / `TIME` | `LocalDate` / `LocalTime` | |
| `TIMESTAMP` | `LocalDateTime` | 不带时区，存什么取什么 |
| `TIMESTAMPTZ` | `OffsetDateTime` / `Instant` | 存储时统一换算为 UTC，读取时按会话时区展示，记录时间点推荐用它 |
| `INTERVAL` | `org.postgresql.util.PGInterval` | 驱动不会直接转成 `Duration`，需要自行换算 |
| `BYTEA` | `byte[]` | 二进制 |
| `UUID` | `java.util.UUID` | 有序 UUID 见版本特性中的 `uuidv7()` |
| `JSONB` / `JSON` | `PGobject` / `String` | 映射成对象需 Hibernate 6 的 `@JdbcTypeCode(SqlTypes.JSON)` 或 MyBatis 自定义 TypeHandler |
| `INTEGER[]` / `TEXT[]` | `java.sql.Array` | `rs.getArray(...).getArray()` 得到 `Integer[]` / `String[]` |
| `hstore` | `Map<String, String>` | 需先 `CREATE EXTENSION hstore` |

`TIMESTAMP` 与 `TIMESTAMPTZ` 的选择：前者不记录时区，应用服务器换了时区就会读出错误的时间点；后者在入库时换算为 UTC，跨时区部署时不会混乱。除非存的是“墙上时间”（例如营业时间 09:00），一律用 `TIMESTAMPTZ`。

### 3、数组与 JSONB

数组、JSONB 是 PG 区别于 MySQL 的常用类型，操作符、索引与反范式的取舍统一在 [PostgreSQL 高级 SQL](./4_topic_advanced_sql) 讲解；JSONB 该建哪种索引见 [PostgreSQL 索引类型](./3_topic_index)。

---

## 五、psql 与常用运维 SQL

### 1、psql 元命令

```bash
psql -h localhost -p 5432 -U app -d mydb
```

进入 psql 后，以反斜杠开头的是客户端元命令，不是 SQL：

| 命令 | 作用 |
|------|------|
| `\l` | 列出数据库 |
| `\c mydb` | 切换数据库 |
| `\dn` | 列出 Schema |
| `\dt` / `\dt *.*` | 列出当前搜索路径 / 所有 Schema 下的表 |
| `\d orders` | 查看表结构、索引、约束 |
| `\di orders*` | 查看索引 |
| `\du` | 列出角色 |
| `\conninfo` | 当前连接信息 |
| `\x` | 切换竖排显示，宽表必备 |
| `\timing` | 显示每条语句耗时 |
| `\i script.sql` | 执行 SQL 文件 |
| `\q` | 退出 |

### 2、常用运维 SQL

```sql
-- 当前活跃会话
SELECT pid, usename, application_name, client_addr, state,
       now() - query_start AS running, query
FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid();

-- 锁等待：谁被谁阻塞
SELECT pid, pg_blocking_pids(pid) AS blocked_by,
       wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';

-- 取消正在执行的语句（保留会话）/ 直接断开会话
SELECT pg_cancel_backend(12345);
SELECT pg_terminate_backend(12345);

-- 表大小（含索引与 TOAST）排名
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;

-- 更新统计信息 / 回收死元组
ANALYZE orders;
VACUUM (ANALYZE) orders;
```

`wait_event IS NOT NULL` 不能用来找锁等待：空闲连接（`Client` / `ClientRead`）、IO 和轻量锁等待都会被筛进来。索引使用情况的查询见 [PostgreSQL 索引类型](./3_topic_index)，VACUUM 相关监控见 [MVCC 与 VACUUM](./2_topic_mvcc)。

### 3、用户与权限

PG 里用户和组都是“角色”（role），`CREATE USER` 等价于带 `LOGIN` 的 `CREATE ROLE`。

```sql
-- 应用账号
CREATE ROLE app LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE mydb TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app;

-- 对以后新建的表同样生效（由建表的角色执行）
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;

-- 只读账号：PG 14 起的预定义角色，覆盖所有库表与 Schema
CREATE ROLE readonly_user LOGIN PASSWORD 'change-me';
GRANT pg_read_all_data TO readonly_user;
```

- `GRANT ... ON ALL TABLES` 只影响已存在的表，新表靠 `ALTER DEFAULT PRIVILEGES`
- PG 14 起 `password_encryption` 默认 `scram-sha-256`；PG 18 起 MD5 密码已弃用，设置 MD5 密码会告警，`pg_hba.conf` 应使用 `scram-sha-256`
- `pg_hba.conf` 决定谁能从哪里、用什么方式连接，修改后执行 `SELECT pg_reload_conf();` 生效

---

## 六、扩展生态

PG 的很多能力来自扩展（extension），`CREATE EXTENSION` 即可在当前数据库启用：

| 扩展 | 用途 |
|------|------|
| `pg_stat_statements` | 慢 SQL 统计，需在 `shared_preload_libraries` 中预加载 |
| PostGIS | 地理空间数据，使用 `postgis/postgis:18-3.6` 这类带 PostGIS 的镜像后 `CREATE EXTENSION postgis;` |
| pgvector | 向量存储与相似度检索，RAG 场景常用 |
| `pg_trgm` | 三元组模糊匹配，加速 `LIKE '%xx%'` |
| `postgres_fdw` | 访问远端 PG 的外部表 |

地理空间索引的写法见 [PostgreSQL 索引类型](./3_topic_index)。

---

## 小结

MVCC、索引、高级 SQL、复制分别在本组后续文章展开。

- 18 是当前主线，14～18 受支持，13 及更早已停止支持；14 将在 2026-11 停止支持
- 与 MySQL 最大的差异：堆表无聚簇索引、旧版本留在表内靠 VACUUM 回收、RR 是快照隔离、DDL 可回滚、每连接一个进程
- 未加引号的标识符折叠为小写；字符串比较默认区分大小写
- PG 18 Docker 镜像的数据卷挂载点改为 `/var/lib/postgresql`，旧写法会导致数据丢失
- PG 15 起 `public` Schema 默认不允许普通用户建表，升级后注意给迁移账号授权
- 时间点用 `TIMESTAMPTZ`；`INTERVAL`、`JSONB` 在 JDBC 层不会自动转成 `Duration` / `Map`
- 锁等待用 `wait_event_type = 'Lock'` 加 `pg_blocking_pids()` 排查；先 `pg_cancel_backend` 再考虑 `pg_terminate_backend`

## 参考资料

- PostgreSQL 版本策略：[https://www.postgresql.org/support/versioning/](https://www.postgresql.org/support/versioning/)
- PostgreSQL 18 文档：[https://www.postgresql.org/docs/18/](https://www.postgresql.org/docs/18/)
- Schema 与 public 权限：[https://www.postgresql.org/docs/18/ddl-schemas.html](https://www.postgresql.org/docs/18/ddl-schemas.html)
- 预定义角色：[https://www.postgresql.org/docs/18/predefined-roles.html](https://www.postgresql.org/docs/18/predefined-roles.html)
- psql：[https://www.postgresql.org/docs/18/app-psql.html](https://www.postgresql.org/docs/18/app-psql.html)
- Docker 官方镜像说明：[https://hub.docker.com/_/postgres](https://hub.docker.com/_/postgres)
- PgJDBC 文档：[https://jdbc.postgresql.org/documentation/](https://jdbc.postgresql.org/documentation/)

> 下一篇：[PostgreSQL 版本特性](./1_feature) —— 9.6 到 18 的关键变化，重点是 15、17、18 对应用开发的影响。

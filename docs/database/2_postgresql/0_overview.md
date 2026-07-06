# PostgreSQL

官网：[https://www.postgresql.org](https://www.postgresql.org)

## 一、PostgreSQL vs MySQL（Java 开发视角）

PostgreSQL 1986 年起源于加州大学伯克利分校，是功能最完整的开源关系型数据库之一。对于习惯 MySQL 的 Java 开发者，以下差异最需要关注：

| 维度 | MySQL | PostgreSQL |
|------|-------|-----------|
| 自增主键 | `AUTO_INCREMENT` | `GENERATED ALWAYS AS IDENTITY`（推荐）/ `SERIAL`（旧） |
| 布尔类型 | `TINYINT(1)` 模拟 | 原生 `BOOLEAN` |
| JSON 支持 | `JSON` 列（文本存储） | `JSONB`（二进制，可索引）|
| 数组类型 | 不支持原生数组 | `INTEGER[]`、`TEXT[]` 等原生数组 |
| 字符串拼接 | `CONCAT()` | 支持 `||` 运算符 |
| 大小写敏感 | 默认不敏感 | 默认敏感（可用 `ILIKE` 忽略大小写）|
| 分页语法 | `LIMIT n OFFSET m` | `LIMIT n OFFSET m`（相同）|
| 模式（Schema）| 无（数据库即命名空间）| 有 Schema，默认 `public` |
| 事务隔离默认 | REPEATABLE READ | READ COMMITTED |
| DDL 事务 | 不支持（DDL 自动提交）| 支持（DDL 可回滚）|
| 并发控制 | MVCC | MVCC |
| GIS 扩展 | 内置但较弱 | PostGIS（业界标准）|
| 全文检索 | 内置 FULLTEXT | 内置 `tsvector`/`tsquery`，支持 GIN 索引 |

---

## 二、安装使用

### Docker Compose

```yaml
services:
  postgres:
    image: postgres:17.4-bookworm
    container_name: postgres
    restart: always
    environment:
      POSTGRES_USER: root
      POSTGRES_PASSWORD: 123456
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    volumes:
      - ./postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

### Spring Boot JDBC 配置

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: root
    password: 123456
    driver-class-name: org.postgresql.Driver
```

```xml
<dependency>
  <groupId>org.postgresql</groupId>
  <artifactId>postgresql</artifactId>
</dependency>
```

### 常用客户端工具

| 工具 | 类型 | 说明 |
|------|------|------|
| `psql` | CLI | 官方命令行客户端 |
| pgAdmin 4 | GUI | 官方 Web GUI |
| DBeaver | GUI | 跨平台，支持多种数据库 |
| TablePlus | GUI | macOS/Windows，体验流畅 |
| DataGrip | IDE | JetBrains 出品，功能最强 |

---

## 三、核心概念

### 1、逻辑结构

```
PostgreSQL 实例
└── 数据库（Database）         ← 各数据库完全隔离，不能跨库 JOIN
    └── 模式（Schema）         ← 命名空间，默认 public，可创建多个
        ├── 表（Table）
        ├── 视图（View）
        ├── 函数（Function）
        └── 序列（Sequence）
```

Schema 的实际用途：
- 多租户隔离：每个租户一个 schema，共享同一数据库
- 模块化管理：`finance.orders`、`logistics.orders` 互不干扰
- 权限隔离：`GRANT USAGE ON SCHEMA`

```sql
-- 创建 schema
CREATE SCHEMA finance;

-- 在 schema 下建表
CREATE TABLE finance.accounts (id BIGINT PRIMARY KEY, balance NUMERIC);

-- 设置搜索路径（类似 Java 的 import）
SET search_path = finance, public;
```

### 2、常见数据类型与 Java 对应

| PostgreSQL 类型 | Java 类型 | 说明 |
|----------------|-----------|------|
| `SMALLINT` | `Short` | 2 字节，-32768 ~ 32767 |
| `INTEGER` / `INT` | `Integer` | 4 字节 |
| `BIGINT` | `Long` | 8 字节 |
| `SERIAL` | `Integer` | 旧式自增，等价于 `INT` + `SEQUENCE`，**PG 10 起推荐用 IDENTITY** |
| `BIGSERIAL` | `Long` | 旧式大整数自增 |
| `GENERATED ALWAYS AS IDENTITY` | `Long` | 标准 SQL 自增列（推荐）|
| `DECIMAL(p,s)` / `NUMERIC(p,s)` | `BigDecimal` | 精确小数，用于金融 |
| `REAL` | `Float` | 4 字节单精度浮点 |
| `DOUBLE PRECISION` | `Double` | 8 字节双精度浮点 |
| `CHAR(n)` | `String` | 定长字符串 |
| `VARCHAR(n)` | `String` | 变长字符串 |
| `TEXT` | `String` | 无长度限制文本 |
| `BOOLEAN` | `Boolean` | 原生布尔，接受 `true`/`false`/`yes`/`no`/`1`/`0` |
| `DATE` | `LocalDate` | 仅日期 |
| `TIME` | `LocalTime` | 仅时间 |
| `TIMESTAMP` | `LocalDateTime` | 日期+时间，不含时区 |
| `TIMESTAMPTZ` | `OffsetDateTime` | 带时区，**推荐存储时间戳** |
| `INTERVAL` | `Duration` | 时间间隔 |
| `BYTEA` | `byte[]` | 二进制数据 |
| `JSON` | `String` | 文本 JSON，不可索引 |
| `JSONB` | `String` / `Map` | 二进制 JSON，支持 GIN 索引，**推荐** |
| `UUID` | `UUID` | 128 位全局唯一标识符 |
| `INTEGER[]` | `Integer[]` | 整型数组 |
| `TEXT[]` | `String[]` | 字符串数组 |
| `hstore` | `Map<String, String>` | 键值对（需启用 extension）|

### 3、数组类型

```sql
-- 建表
CREATE TABLE tags (
  id   BIGINT PRIMARY KEY,
  name TEXT,
  cats TEXT[]    -- 字符串数组列
);

-- 插入数组
INSERT INTO tags VALUES (1, 'article', ARRAY['java', 'spring', 'backend']);

-- 查询：包含某元素（@> 包含运算符）
SELECT * FROM tags WHERE cats @> ARRAY['java'];

-- 查询：交集不为空（&& 运算符）
SELECT * FROM tags WHERE cats && ARRAY['java', 'python'];

-- 查询：被包含（<@ 运算符）
SELECT * FROM tags WHERE cats <@ ARRAY['java', 'spring', 'backend', 'jvm'];

-- 追加元素
UPDATE tags SET cats = cats || ARRAY['jvm'] WHERE id = 1;

-- 数组长度
SELECT array_length(cats, 1) FROM tags;
```

### 4、JSONB

```sql
CREATE TABLE events (
  id      BIGINT PRIMARY KEY,
  payload JSONB
);

-- 插入
INSERT INTO events VALUES (1, '{"type": "click", "user": {"id": 42, "name": "Alice"}}');

-- 操作符查询
SELECT payload->>'type' FROM events;              -- 取顶层字段（文本）
SELECT payload->'user'->>'name' FROM events;      -- 嵌套取值
SELECT payload['user']['name'] FROM events;       -- PG 14+ 下标语法

-- 条件查询（走 GIN 索引）
SELECT * FROM events WHERE payload @> '{"type": "click"}';

-- 创建 GIN 索引
CREATE INDEX idx_events_payload ON events USING GIN (payload);
```

---

## 四、常用命令

### psql 元命令

```bash
# 连接数据库
psql -h localhost -p 5432 -U root -d mydb

# 列出数据库
\l

# 切换数据库
\c mydb

# 列出当前 schema 下所有表
\dt

# 列出所有 schema 的表
\dt *.*

# 查看表结构
\d orders

# 查看索引
\di orders*

# 列出所有 schema
\dn

# 查看当前用户和连接信息
\conninfo

# 执行 SQL 文件
\i /path/to/script.sql

# 开启/关闭执行耗时显示
\timing

# 退出
\q
```

### 常用 SQL

```sql
-- 查看所有数据库
SELECT datname FROM pg_database;

-- 查看当前连接
SELECT pid, usename, application_name, client_addr, state, query
FROM pg_stat_activity
WHERE state != 'idle';

-- 终止某个连接
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = 12345;

-- 查看表大小
SELECT pg_size_pretty(pg_total_relation_size('orders')) AS total_size;

-- 查看所有表大小排名
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- 查看锁等待
SELECT pid, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE wait_event IS NOT NULL;

-- 分析表（更新统计信息）
ANALYZE orders;

-- 手动 VACUUM（回收死元组）
VACUUM orders;
VACUUM ANALYZE orders;

-- 查看索引使用情况
SELECT relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### 用户与权限

```sql
-- 创建用户
CREATE USER appuser WITH PASSWORD 'secret';

-- 授权
GRANT CONNECT ON DATABASE mydb TO appuser;
GRANT USAGE ON SCHEMA public TO appuser;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appuser;

-- 只读用户（PG 14+）
GRANT pg_read_all_data TO readonly_user;
```

---

## 五、常见问题

### 1、JDBC 连接 Schema 不对

PG 默认 `search_path = public`，如果表建在其他 schema 下需要显式指定：

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb?currentSchema=finance
```

或者在用户级别设置默认 schema：

```sql
ALTER USER appuser SET search_path = finance, public;
```

### 2、如何开启 PostGIS（GIS 支持）

```sql
-- 需要使用带 PostGIS 的镜像：postgis/postgis:17-3.5
CREATE EXTENSION postgis;
CREATE EXTENSION postgis_topology;

-- 验证
SELECT PostGIS_version();
```

### 3、uuidv7 有序 UUID（PG 18+）

```sql
-- PG 17 及之前用 gen_random_uuid()（随机，索引碎片多）
-- PG 18 起推荐 uuidv7()（时间戳有序，B-tree 友好）
CREATE TABLE events (
  id UUID DEFAULT uuidv7() PRIMARY KEY
);
```

### 4、TIMESTAMP vs TIMESTAMPTZ

- `TIMESTAMP`：存储时不带时区，取出什么就是什么
- `TIMESTAMPTZ`：存储时转为 UTC，取出时按会话时区转换

**推荐**：统一使用 `TIMESTAMPTZ`，避免跨时区数据混乱。

# Postgres

- **官网**：[PostgreSQL 官网](https://www.postgresql.org/)

## 一、基础介绍

- **背景**：PostgreSQL 是一个开源的关系型数据库管理系统（RDBMS），最初由加利福尼亚大学伯克利分校的研究团队在 1986
  年开始开发，最初的名字叫做 Postgres。
- **来源**：PostgreSQL 并非中国的数据库，而是源自美国的开源项目。
- **特点**：
    - 全球范围内广泛使用的开源数据库，具有高可扩展性和强大的事务支持。
    - 支持 SQL 标准，具备丰富的功能，如 JSON 数据类型、地理信息系统（GIS）功能（PostGIS）等。
    - 在全球范围内有广泛的社区支持和开发者贡献。

## 二、安装使用

```shell
services:
  postgres:
    image: postgres:17.4-bookworm
    container_name: postgres
    restart: always
    environment:
      POSTGRES_USER: root
      POSTGRES_PASSWORD: 123456
    ports:
      - "5432:5432"
    volumes:
      - ./postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:

```

## 三、核心概念

### 1、逻辑结构

PostgreSQL 采用 数据库 - 模式（Schema） - 表 的层级结构：

- 数据库（Database）：存储所有数据，每个 PostgreSQL 实例可包含多个数据库。

- 模式（Schema）：用于组织数据库对象（表、视图等），类似于命名空间。

- 表（Table）：数据的核心存储单元，由行和列组成。

- 列（Column）：定义字段，具有不同的数据类型。

- 行（Row）：存储具体的数据记录。

### 2、常见数据类型

官网数据结构地址：[https://www.postgresql.org/docs/current/datatype.html](https://www.postgresql.org/docs/current/datatype.html)

以下是 **PostgreSQL 数据类型** 和 **Java 数据类型** 之间的对应关系表：

| PostgreSQL 数据类型                       | Java 数据类型                     | 说明                                    |
|---------------------------------------|-------------------------------|---------------------------------------|
| **整数类型**                              |
| `SMALLINT` (2字节)                      | `Short`                       | 适用于 -32,768 到 32,767 之间的整数            |
| `INTEGER` / `INT` (4字节)               | `Integer`                     | 适用于 -2^31 到 2^31-1 之间的整数              |
| `BIGINT` (8字节)                        | `Long`                        | 适用于更大范围的整数                            |
| `SERIAL` (自增 INT)                     | `Integer`                     | 自增主键，自动生成数值                           |
| `BIGSERIAL` (自增 BIGINT)               | `Long`                        | 适用于大整数的自增主键                           |
| **浮点数与精度数**                           |
| `DECIMAL(p,s)` / `NUMERIC(p,s)`       | `BigDecimal`                  | 高精度小数，适用于金融计算                         |
| `REAL` (4字节)                          | `Float`                       | 单精度浮点数                                |
| `DOUBLE PRECISION` (8字节)              | `Double`                      | 双精度浮点数                                |
| **字符串类型**                             |
| `CHAR(n)` / `CHARACTER(n)`            | `String`                      | 固定长度字符串                               |
| `VARCHAR(n)` / `CHARACTER VARYING(n)` | `String`                      | 可变长度字符串                               |
| `TEXT`                                | `String`                      | 任意长度的字符串                              |
| **日期和时间类型**                           |
| `DATE`                                | `LocalDate`                   | 仅存储日期 (yyyy-MM-dd)                    |
| `TIME`                                | `LocalTime`                   | 仅存储时间 (HH:mm:ss)                      |
| `TIMESTAMP`                           | `LocalDateTime`               | 日期 + 时间，不带时区                          |
| `TIMESTAMP WITH TIME ZONE`            | `OffsetDateTime`              | 带时区的日期时间                              |
| `INTERVAL`                            | `Duration`                    | 表示时间间隔                                |
| **布尔类型**                              |
| `BOOLEAN`                             | `Boolean`                     | `true` 或 `false`                      |
| **二进制类型**                             |
| `BYTEA`                               | `byte[]`                      | 存储二进制数据                               |
| **JSON 类型**                           |
| `JSON` / `JSONB`                      | `String` / `JSONObject`       | `JSONB` 存储效率更高                        |
| **数组类型**                              |
| `INTEGER[]`                           | `Integer[]` / `List<Integer>` | 存储整型数组                                |
| `TEXT[]`                              | `String[]` / `List<String>`   | 存储字符串数组                               |
| **UUID 类型**                           |
| `UUID`                                | `UUID`                        | 存储全局唯一标识符                             |
| **枚举类型**                              |
| `ENUM`                                | `Enum<?>`                     | 需要用 `@Enumerated(EnumType.STRING)` 映射 |
| **hstore（键值存储）**                      |
| `hstore`                              | `Map<String, String>`         | 键值对存储                                 |

### 3、数组特性

```sql
&&  交集
@>  包含
>@  被包含
```

## 四、常用命令

## 五、常见问题

### 1、PostgreSQL Gis如何支持？

17版本可以直接使用如下命令：

```sql
CREATE EXTENSION postgis;
```


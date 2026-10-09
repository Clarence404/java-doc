---
description: Oracle 与 SQL Server 方言差异、达梦、人大金仓、openGauss 接入要点、国产库兼容对照
---

# 其他 RDBMS

> **本篇目标**：掌握 Oracle、SQL Server 与 MySQL 在分页、自增、空字符串、布尔、隔离级别上的关键差异，能为达梦、人大金仓、openGauss 选对驱动与连接串，并避开大小写、认证等常见接入坑。
>
> **前置阅读**：[MySQL 基础](../1_mysql/0_overview)、[PostgreSQL 基础](../2_postgresql/0_overview)

本篇以 MySQL 8.4 为对照基线，各产品版本基线如下：

| 产品 | 版本基线 | 说明 |
|------|---------|------|
| Oracle Database | 19c / 23ai | 19c 是长期支持版本；23ai 于 2025 年 10 月起更名为 26ai |
| SQL Server | 2022 / 2025 | |
| 达梦 DM | DM8 | |
| 人大金仓 KingbaseES | V9 | |
| openGauss | 6.0 / 7.0 LTS | 商业版为华为 GaussDB |

---

## 一、Oracle

- 官网：[oracle.com/database](https://www.oracle.com/database/)
- 企业级 RDBMS，金融、电信、政府核心系统中常见
- PL/SQL 存储过程、分区表、物化视图、RAC 共享存储集群、Data Guard 容灾

### 1、与 MySQL 的常见差异

| 场景 | MySQL 8.4 | Oracle |
|------|-----------|--------|
| 分页 | `LIMIT 10 OFFSET 20` | 12c+ `OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY`；更早版本用 `ROWNUM` 三层嵌套 |
| 自增主键 | `AUTO_INCREMENT` | `SEQUENCE` + `NEXTVAL`，或 12c+ 的 `IDENTITY` 列 |
| 空字符串 | `''` 与 `NULL` 不同 | `''` 等同于 `NULL`：存入 `''` 读出是 `NULL`，`WHERE col = ''` 永远不成立 |
| 字符串拼接 | 只能用 `CONCAT(a, b)`；`a + b` 是数值加法；`\|\|` 默认是逻辑或（开启 `PIPES_AS_CONCAT` 才是拼接，`\|\|` 作逻辑或的用法自 8.0.17 起已弃用） | `\|\|` 运算符或 `CONCAT`（`CONCAT` 只接受两个参数） |
| 当前时间 | `NOW()` / `SYSDATE()` | `SYSDATE` / `SYSTIMESTAMP` |
| 无表查询 | `SELECT 1` | 23ai 之前必须 `SELECT 1 FROM DUAL`；23ai 起可省略 `FROM DUAL` |
| 布尔类型 | `BOOLEAN` 是 `TINYINT(1)` 的别名 | 23ai 之前 SQL 层没有 BOOLEAN（只有 PL/SQL 有），通常用 `NUMBER(1)` / `CHAR(1)`；23ai 起有原生 `BOOLEAN` |
| DDL 幂等 | `CREATE TABLE IF NOT EXISTS` | 23ai 起支持 `IF [NOT] EXISTS`，之前需要在 PL/SQL 中捕获异常 |
| 默认隔离级别 | REPEATABLE READ | READ COMMITTED（不支持 READ UNCOMMITTED 与 REPEATABLE READ，另有 SERIALIZABLE） |
| 一致性读 | undo 构造历史版本 | 同样基于 undo；长查询读取的版本被覆盖时报 `ORA-01555 snapshot too old` |
| 字符串比较 | 默认排序规则 `utf8mb4_0900_ai_ci`，不区分大小写 | 默认区分大小写 |

### 2、分页写法

`ROWNUM` 在排序**之前**分配，所以必须先在最内层排好序，再在外面两层分别截取上下界：

```sql
-- 12c 之前：三层嵌套，排序放在最内层
SELECT *
FROM (
    SELECT t.*, ROWNUM rn
    FROM (SELECT * FROM orders ORDER BY id) t
    WHERE ROWNUM <= 30
)
WHERE rn > 20;

-- 12c+（推荐）
SELECT * FROM orders
ORDER BY id
OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;
```

如果把 `ORDER BY` 和 `ROWNUM <= 30` 写在同一层，Oracle 会先取任意 30 行再排序，每页内容都是不确定的。

### 3、序列与 IDENTITY

```sql
CREATE SEQUENCE seq_order_id START WITH 1 INCREMENT BY 1 CACHE 20;

INSERT INTO orders (id, amount) VALUES (seq_order_id.NEXTVAL, 100);

-- 12c+ IDENTITY 列，内部仍由序列实现
CREATE TABLE orders (
    id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    amount NUMBER
);
```

序列的 `CACHE` 会让实例重启后出现跳号，与 MySQL 自增一样不能依赖连续性；RAC 下多个实例各自缓存，序列值在全局范围内也不保证有序。

---

## 二、SQL Server

- 官网：[microsoft.com/sql-server](https://www.microsoft.com/sql-server)
- 微软企业级 RDBMS，.NET 技术栈常用，制造业、传统企业 ERP 中常见

| 场景 | MySQL 8.4 | SQL Server |
|------|-----------|-----------|
| 分页 | `LIMIT 10 OFFSET 20` | `ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY`（2012+，**必须带 `ORDER BY`**，否则语法错误） |
| 限制行数 | `LIMIT n` | `SELECT TOP (n) ...` |
| 自增主键 | `AUTO_INCREMENT` | `IDENTITY(1,1)` 或 `SEQUENCE` |
| 当前时间 | `NOW()` | `GETDATE()` / `SYSDATETIME()` |
| 字符串拼接 | `CONCAT(a, b)` | `+` 或 `CONCAT`；`+` 遇到 `NULL` 结果为 `NULL`，`CONCAT` 把 `NULL` 当空串 |
| 默认隔离级别 | REPEATABLE READ | READ COMMITTED（基于锁）；开启 `READ_COMMITTED_SNAPSHOT` 后改为行版本读 |
| 过程语言 | SQL/PSM 风格的存储过程语法 | T-SQL |
| 标识符引用 | 反引号 `` `order` `` | 方括号 `[order]` 或双引号 |

---

## 三、达梦 DM8

- 官网：[dameng.com](https://www.dameng.com/)
- 武汉达梦自研内核，政府、金融、能源行业国产化项目中常见
- 语法兼容 SQL 标准，并大量兼容 Oracle（PL/SQL 风格过程、`ROWNUM`、序列）；`COMPATIBLE_MODE` 参数可调整对 Oracle、MySQL 等语法的兼容程度

接入要点：

- **大小写**：初始化实例时 `CASE_SENSITIVE` 默认为 `Y`。未加引号的标识符会被转换为大写，加了双引号的标识符严格区分大小写。这个参数在实例创建后无法修改。从 MySQL 迁移时，如果建表脚本对小写名称加了引号，后续不带引号的 SQL 就找不到表，所以要统一约定：一律不加引号，或者一律大写
- **分页**：支持 `LIMIT` / `OFFSET`，也支持 `ROWNUM` 和 `OFFSET ... FETCH`
- **驱动**：`dm.jdbc.driver.DmDriver`，Maven 坐标 `com.dameng:DmJdbcDriver18`（JDK 8+）

---

## 四、人大金仓 KingbaseES

- 官网：[kingbase.com.cn](https://www.kingbase.com.cn/)
- 人大金仓（中国电科旗下）的数据库产品，内核源自 PostgreSQL，政务、金融国产替代项目中常见
- 当前版本 V9 提供 Oracle、MySQL、SQL Server、PostgreSQL 多种兼容模式，在初始化实例时选定。Oracle 模式下可用 `ROWNUM`、`NVL`、`DECODE` 等写法

接入要点：

- **驱动**：`com.kingbase8.Driver`，Maven 坐标 `cn.com.kingbase:kingbase8`；URL 形如 `jdbc:kingbase8://host:54321/db_name`
- **必须使用官方驱动**：认证方式、类型映射和兼容模式下的行为都与 PostgreSQL 有差异，不要用 PG 驱动代替
- **兼容模式决定 SQL 写法**：同一套代码迁到不同模式的实例，分页、空字符串、大小写行为都可能变化，测试环境的模式要与生产保持一致

---

## 五、openGauss

- 官网：[opengauss.org](https://opengauss.org/)
- 华为基于 PostgreSQL 9.2 内核深度改造的开源数据库，商业版为 GaussDB，运营商、政企场景常见
- 生态上兼容 PG，但内核已经大幅分化（线程池模型、增量 checkpoint、NUMA 优化）

接入要点：

- **驱动**：`org.opengauss.Driver`，Maven 坐标 `org.opengauss:opengauss-jdbc`；URL 形如 `jdbc:opengauss://host:5432/db_name`
- **认证**：默认使用 SHA256 口令加密，PostgreSQL 原生驱动直连会认证失败，需要用官方驱动，或由 DBA 调整认证方式

---

## 六、JDBC 接入速查与兼容对照

### 1、驱动与连接串

| 数据库 | 驱动类 | URL 模板 | 默认端口 | Maven 坐标 |
|--------|--------|---------|---------|-----------|
| Oracle | `oracle.jdbc.OracleDriver` | `jdbc:oracle:thin:@//host:1521/service_name` | 1521 | `com.oracle.database.jdbc:ojdbc11` / `ojdbc17` |
| SQL Server | `com.microsoft.sqlserver.jdbc.SQLServerDriver` | `jdbc:sqlserver://host:1433;databaseName=db;encrypt=true` | 1433 | `com.microsoft.sqlserver:mssql-jdbc` |
| 达梦 DM8 | `dm.jdbc.driver.DmDriver` | `jdbc:dm://host:5236` | 5236 | `com.dameng:DmJdbcDriver18` |
| KingbaseES | `com.kingbase8.Driver` | `jdbc:kingbase8://host:54321/db` | 54321 | `cn.com.kingbase:kingbase8` |
| openGauss | `org.opengauss.Driver` | `jdbc:opengauss://host:5432/db` | 5432 | `org.opengauss:opengauss-jdbc` |

驱动类会根据 URL 自动识别，一般不需要配置 `driver-class-name`。Spring Boot 数据源与连接池的配置方式见 [数据访问](/spring-boot/3_data_access)。SQL Server 驱动 10.x 起默认 `encrypt=true`，自签证书的测试环境才加 `trustServerCertificate=true`，生产环境应配置受信任的证书。

### 2、国产数据库兼容对照

| 数据库 | 内核来源 | Oracle 兼容 | PostgreSQL 兼容 | MySQL 兼容 | 主要场景 |
|--------|---------|------------|----------------|-----------|---------|
| 达梦 DM8 | 自研 | 较高 | 部分 | 部分（`COMPATIBLE_MODE`） | 政府、金融、能源 |
| 人大金仓 KingbaseES V9 | PostgreSQL | 支持（Oracle 模式） | 高 | 支持（MySQL 模式） | 政务、国产替代 |
| openGauss / GaussDB | PostgreSQL 9.2 | 部分 | 较高 | 部分 | 运营商、华为生态 |

分布式路线的 OceanBase、TiDB 以及云原生的 PolarDB 见 [分布式数据库](./1_distributed_db)；在关系库、NoSQL 之间如何选型见 [数据库选型参考](../6_reference/1_selection_guide)。

---

## 小结

- Oracle：`''` 等于 `NULL`；`ROWNUM` 分页必须三层嵌套并把排序放在最内层，12c+ 直接用 `OFFSET ... FETCH`；23ai 起有原生 `BOOLEAN`、可省略 `FROM DUAL`、支持 `IF [NOT] EXISTS`
- Oracle 与 SQL Server 默认都是 READ COMMITTED，与 MySQL 的 REPEATABLE READ 不同，迁移时要重新评估依赖可重复读的逻辑
- MySQL 只能用 `CONCAT` 拼接字符串，`+` 是数值加法；SQL Server 的 `OFFSET ... FETCH` 必须带 `ORDER BY`
- 达梦默认 `CASE_SENSITIVE=Y`，不加引号的名称转为大写、加引号的严格区分大小写，且实例创建后不能修改
- KingbaseES V9 有多种兼容模式，openGauss 默认 SHA256 认证，都应使用各自的官方 JDBC 驱动

## 参考资料

- Oracle Database 23ai SQL Language Reference：[https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/)
- Oracle Database 19c SQL Language Reference：[https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/)
- SQL Server ORDER BY 与 OFFSET-FETCH：[https://learn.microsoft.com/sql/t-sql/queries/select-order-by-clause-transact-sql](https://learn.microsoft.com/sql/t-sql/queries/select-order-by-clause-transact-sql)
- Microsoft JDBC Driver for SQL Server：[https://learn.microsoft.com/sql/connect/jdbc/](https://learn.microsoft.com/sql/connect/jdbc/)
- MySQL 8.4 字符串函数与运算符：[https://dev.mysql.com/doc/refman/8.4/en/string-functions.html](https://dev.mysql.com/doc/refman/8.4/en/string-functions.html)
- 达梦技术文档：[https://eco.dameng.com/document/dm/zh-cn/start/](https://eco.dameng.com/document/dm/zh-cn/start/)
- KingbaseES 产品文档：[https://help.kingbase.com.cn/](https://help.kingbase.com.cn/)
- openGauss 文档：[https://docs.opengauss.org/](https://docs.opengauss.org/)

> 下一篇：[分布式数据库](./1_distributed_db) —— TiDB 与 OceanBase 的架构、事务与兼容性，以及 Aurora、PolarDB 的存算分离路线。

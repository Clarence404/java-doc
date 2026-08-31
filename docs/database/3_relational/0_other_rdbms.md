# 其他 RDBMS

## 一、Oracle

- 官网：[oracle.com/database](https://www.oracle.com/database/)
- 全球领先的企业级 RDBMS，广泛用于金融、电信、政府核心系统
- 支持 PL/SQL 存储过程、分区表、物化视图、RAC 集群高可用

### 与 MySQL 常见差异（Java 开发必知）

| 场景 | MySQL | Oracle |
|------|-------|--------|
| 分页查询 | `LIMIT 10 OFFSET 20` | `FETCH NEXT 10 ROWS ONLY`（12c+）或 `ROWNUM`（旧版）|
| 自增主键 | `AUTO_INCREMENT` | `CREATE SEQUENCE` + `NEXTVAL`，或 12c+ 的 `IDENTITY` 列 |
| 空字符串 | `''` ≠ `NULL` | `''` **等价于 `NULL`**（存入 `''` 取出是 `NULL`）|
| 字符串拼接 | `CONCAT(a, b)` 或 `a + b` 会当数字运算 | `\|\|` 运算符：`'hello' \|\| ' world'` |
| 当前时间 | `NOW()` / `SYSDATE()` | `SYSDATE` / `SYSTIMESTAMP` |
| 获取单行 | `SELECT 1` | `SELECT 1 FROM DUAL`（DUAL 是虚拟表）|
| 布尔类型 | `TINYINT(1)` 或 `BIT` | 无原生 BOOLEAN，通常用 `CHAR(1)` 或 `NUMBER(1)` |
| 事务提交 | DDL 自动提交，DML 手动 | DDL 自动提交，DML 手动（相同） |
| 字符串比较 | 大小写不敏感（默认 ci 排序规则）| 大小写敏感 |

**Oracle 分页示例**（旧版 / 兼容写法）：

```sql
-- Oracle 12c 之前：ROWNUM 嵌套
SELECT * FROM (
  SELECT t.*, ROWNUM rn FROM orders t WHERE ROWNUM <= 30
) WHERE rn > 20;

-- Oracle 12c+（推荐）
SELECT * FROM orders
ORDER BY id
OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;
```

**序列自增示例**：

```sql
-- 创建序列
CREATE SEQUENCE seq_order_id
  START WITH 1 INCREMENT BY 1 NOCACHE NOCYCLE;

-- 插入时使用序列
INSERT INTO orders (id, amount) VALUES (seq_order_id.NEXTVAL, 100);

-- Oracle 12c+ IDENTITY 列（类似 AUTO_INCREMENT）
CREATE TABLE orders (
  id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount NUMBER
);
```

**JDBC 连接配置**：

```yaml
# Spring Boot application.yml
spring:
  datasource:
    url: jdbc:oracle:thin:@//host:1521/ORCL
    driver-class-name: oracle.jdbc.OracleDriver
    username: app_user
    password: xxx
```

---

## 二、达梦（DM 数据库）

- 官网：[dameng.com](https://www.dameng.com/)
- 武汉达梦数据库有限公司自研，国内政府、金融行业主流国产数据库选型之一
- **兼容性**：兼容 SQL 标准，语法上部分兼容 Oracle，支持 PL/SQL 存储过程

**Java 接入要点**：
- JDBC 驱动：`dm.jdbc.driver.DmDriver`，Maven 坐标 `com.dameng:DmJdbcDriver18`
- 分页语法：支持 `LIMIT / OFFSET`（与 MySQL 一致）
- 大小写：默认对象名不区分大小写（存储为大写），建议统一用大写或加引号

```yaml
spring:
  datasource:
    url: jdbc:dm://host:5236/DMSERVER
    driver-class-name: dm.jdbc.driver.DmDriver
```

---

## 三、人大金仓（KingbaseES）

- 官网：[kingbase.com.cn](https://www.kingbase.com.cn/)
- 北京人大金仓，**基于 PostgreSQL 深度优化**，增强了 Oracle 兼容性
- KingbaseES 是其企业版，广泛用于政务、金融核心系统的国产替代场景

**兼容性**：
- SQL 语法基本兼容 PostgreSQL，支持 PL/pgSQL 存储过程
- 提供 Oracle 兼容模式，可使用 `ROWNUM`、`NVL`、`DECODE` 等 Oracle 特性

**Java 接入要点**：
- JDBC 驱动：`com.kingbase8.Driver`
- URL：`jdbc:kingbase8://host:54321/db_name`
- 连接方式与 PostgreSQL 高度一致，部分场景可用 PostgreSQL JDBC 驱动临时替代

---

## 四、SQL Server

- 官网：[microsoft.com/sql-server](https://www.microsoft.com/sql-server)
- 微软企业级 RDBMS，.NET 技术栈标配，制造业 / 传统企业 ERP（用友、金蝶部分版本）常见

**与 MySQL 常见差异（Java 开发必知）**：

| 场景 | MySQL | SQL Server |
|------|-------|-----------|
| 分页查询 | `LIMIT 10 OFFSET 20` | `OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY`（2012+）|
| 自增主键 | `AUTO_INCREMENT` | `IDENTITY(1,1)` |
| 当前时间 | `NOW()` | `GETDATE()` / `SYSDATETIME()` |
| 字符串拼接 | `CONCAT(a, b)` | `+` 运算符或 `CONCAT` |
| 限制行数 | `LIMIT n` | `SELECT TOP n` |
| 存储过程语言 | SQL/PSM | T-SQL |

```yaml
spring:
  datasource:
    url: jdbc:sqlserver://host:1433;databaseName=mydb;encrypt=true;trustServerCertificate=true
    driver-class-name: com.microsoft.sqlserver.jdbc.SQLServerDriver
```

---

## 五、openGauss

- 官网：[opengauss.org](https://opengauss.org/)
- 华为基于 PostgreSQL 9.2 内核深度重构的开源数据库，运营商、政企场景常见
- 衍生商业版：华为 GaussDB；生态兼容 PG，但内核已大幅分化（线程池模型、增量 checkpoint、NUMA 优化）

**Java 接入要点**：
- JDBC 驱动：`org.opengauss.Driver`（Maven 坐标 `org.opengauss:opengauss-jdbc`）
- URL：`jdbc:opengauss://host:5432/db_name`
- 默认加密认证为 SHA256，PG 原生驱动直连会报认证失败，需用官方驱动或调整认证方式

---

## 六、国产数据库选型参考

| 数据库 | 内核基础 | Oracle 兼容 | PostgreSQL 兼容 | 主要场景 |
|--------|---------|:-----------:|:---------------:|---------|
| 达梦 DM | 自研 | 部分 | 部分 | 政府、金融核心系统 |
| 人大金仓 KingbaseES | PostgreSQL | 部分（增强）| 高 | 政务、国产替代 |
| OceanBase | 自研 | ✅（Oracle 模式）| — | 金融核心、大规模 SaaS |
| openGauss | PostgreSQL | 部分 | 高 | 华为系、运营商 |
| PolarDB（阿里）| MySQL / PostgreSQL | — | 部分 | 阿里云原生 |

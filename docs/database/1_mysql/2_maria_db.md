# MariaDB

- 官网：[mariadb.com](https://mariadb.com/)
- GitHub：[MariaDB/server](https://github.com/MariaDB/server)

## 一、起源

MySQL 由瑞典 MySQL AB 公司于 1995 年创建，2008 年 Sun 公司收购，2010 年随 Sun 并入 Oracle。MySQL 创始人 **Michael "Monty" Widenius** 为避免 MySQL 走向封闭，于 2009 年从 MySQL 代码分叉出 **MariaDB**。

名字由来：MySQL 来自 Monty 大女儿 **My**，MariaDB 来自小女儿 **Maria**。

---

## 二、MariaDB vs MySQL 对比

| 对比项 | MySQL | MariaDB |
|-------|-------|---------|
| 维护方 | Oracle（商业主导）| MariaDB Foundation（开源基金会）|
| 协议兼容 | — | 兼容 MySQL 协议，大多数 MySQL 驱动可直接连接 |
| 默认存储引擎 | InnoDB | XtraDB（早期 10.x）/ InnoDB |
| 版本路线 | 5.7 → 8.0 → 8.4 LTS → 9.x | 5.5 → 10.x → 11.x |
| JSON / CTE / 窗口函数 | ✅ 8.0+ 发展较快 | ✅ 各版本陆续支持，部分语法有差异 |
| 存储引擎扩展 | 以 InnoDB 为核心 | 额外支持 MyRocks、ColumnStore 等 |
| Oracle 兼容性 | 弱 | 有限兼容（部分语法）|
| 商业版 | Oracle MySQL Enterprise | MariaDB Enterprise |

---

## 三、MariaDB 特有能力

MariaDB 不只是"开源版 MySQL"，若干特性早于或独立于 MySQL：

### 1、SEQUENCE 对象（10.3+）

不依赖表的自增序列，多表共享、可设步长（MySQL 至今没有）：

```sql
CREATE SEQUENCE order_seq START WITH 1000 INCREMENT BY 1 CACHE 100;
INSERT INTO orders (id, ...) VALUES (NEXT VALUE FOR order_seq, ...);
SELECT LASTVAL(order_seq);
```

### 2、DML 的 RETURNING（10.5+）

写操作直接返回受影响的行，省一次回查（对齐 PostgreSQL）：

```sql
DELETE FROM tasks WHERE status = 'done' RETURNING id, title;
INSERT INTO users (name) VALUES ('Alice') RETURNING id;
```

### 3、系统版本表（System-Versioned Tables，10.3+）

自动保留每行的历史版本，支持"时间旅行"查询，审计场景免去手写历史表：

```sql
CREATE TABLE account (
  id INT PRIMARY KEY,
  balance DECIMAL(10,2)
) WITH SYSTEM VERSIONING;

-- 查询任意历史时刻的数据
SELECT * FROM account FOR SYSTEM_TIME AS OF '2024-06-01 00:00:00';
```

### 4、多样的存储引擎

| 引擎 | 用途 |
|------|------|
| **MyRocks**（RocksDB）| LSM-Tree 写优化，空间压缩比 InnoDB 高数倍，写多读少场景 |
| **ColumnStore** | 列式存储，OLAP 分析查询 |
| **Spider** | 内置分库分表（水平分片代理）|
| **S3** | 归档表直接放对象存储（只读）|

---

## 四、相关生态：Percona

同属 "MySQL 兼容" 阵营，常与 MariaDB 一起被对比：

- **Percona Server**：MySQL 的增强发行版（更多诊断插桩、线程池），协议 100% 兼容
- **Percona XtraBackup**：物理热备份的事实标准（官方 mysqldump 是逻辑备份，大库太慢）
- **Percona Toolkit**：`pt-query-digest`（慢日志分析）、`pt-online-schema-change`（在线 DDL）、`pt-table-checksum`（主从一致性校验）—— 即使用官方 MySQL，这套工具也是运维标配

---

## 五、选型建议

- **MySQL**：生产首选，生态最成熟，Java 驱动（Connector/J）维护活跃，云托管方案丰富（RDS、Aurora）
- **MariaDB**：偏好完全开源、需要 SEQUENCE / 系统版本表 / MyRocks 等特有能力，或发行版默认内置（CentOS/RHEL 的 `yum install mysql` 装的就是 MariaDB）
- **迁移兼容性**：MariaDB 10.x 与 MySQL 5.7 语法高度兼容；11.x 与 MySQL 8.0 有部分差异（GTID 实现、JSON 函数、认证插件均不同），迁移前需逐项验证，**不要假设可以无缝互换**

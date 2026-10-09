---
description: 起源与治理、LTS 版本线、与 MySQL 差异、SEQUENCE 与 RETURNING、向量索引、Galera、迁移
---

# MariaDB

> **本篇目标**：了解 MariaDB 与 MySQL 分叉后的现状和当前 LTS 版本线，掌握两者在认证、JSON、GTID、隔离行为上的关键差异，以及 SEQUENCE、RETURNING、系统版本表、向量索引、Galera 等 MariaDB 特有能力，避免把两者当成可以无缝互换的数据库。
>
> **前置阅读**：[MySQL 版本特性](./1_feature)

---

## 一、起源与治理

MySQL 由瑞典 MySQL AB 于 1995 年创建，2008 年被 Sun 收购，2010 年随 Sun 并入 Oracle。MySQL 创始人 Michael "Monty" Widenius 担心 MySQL 在 Oracle 手中走向封闭，于 2009 年从 MySQL 5.1 代码分叉出 MariaDB。名字来自他的小女儿 Maria，MySQL 的 My 则是大女儿的名字。

MariaDB 由两方共同维护：

- **MariaDB plc**（原 MariaDB Corporation）：商业公司，承担大部分开发工作并提供企业版（MariaDB Enterprise Server）和订阅支持，2024 年被 K1 私有化
- **MariaDB Foundation**：非营利基金会，负责社区版的发布治理和开源许可的延续

存储引擎方面，5.5 ~ 10.1 默认使用 Percona 的 XtraDB，10.2 起改回 InnoDB。此后 MariaDB 的 InnoDB 与 MySQL 独立演进，差异越来越大，例如 11.0 移除了 Change Buffer。

---

## 二、版本线

MariaDB 现在每年发布一个 LTS 版本，LTS 之间是按季度发布的滚动版本（rolling release）。截至 2026 年 10 月仍在社区维护期内的 LTS：

| LTS 版本 | GA 时间 | 社区维护至 |
|---------|---------|-----------|
| 12.3 | 2026-05 | 2029 |
| 11.8 | 2025-06 | 2028 |
| 11.4 | 2024-05 | 2029 |
| 10.11 | 2023-02 | 2028 |

10.6 已于 2026-07-06 停止维护，仍在使用的系统建议直接升级到 11.8 或 12.3。

---

## 三、MariaDB 与 MySQL 的差异

两者共用协议和大部分 SQL 语法，但分叉十多年后，已经是两个不同的数据库。下表以 MySQL 8.4 / 9.7 LTS 与 MariaDB 11.8 / 12.3 LTS 对比：

| 对比项 | MySQL | MariaDB |
|-------|-------|---------|
| 维护方 | Oracle | MariaDB plc + MariaDB Foundation |
| 客户端协议 | — | 兼容 MySQL 协议，常规 CRUD 可用 MySQL 驱动连接；使用 MariaDB 特有功能时用 MariaDB Connector/J |
| 默认认证 | `caching_sha2_password`；`mysql_native_password` 在 8.4 默认不加载、9.0 移除 | `mysql_native_password`，另有 `ed25519`、PARSEC；12.1 起提供兼容的 `caching_sha2_password` 插件，官方定位为迁移用途 |
| JSON | 原生二进制 JSON 类型 | `JSON` 是 `LONGTEXT` 的别名，附带 `JSON_VALID` 校验；部分函数行为不同 |
| GTID | `UUID:NUMBER`（8.4 起可带标签） | `domain-server-seq` 三段式，与 MySQL 不兼容 |
| 高可用 | Group Replication / InnoDB Cluster | Galera Cluster（同步多主）内置，另有异步 / 半同步复制 |
| 向量 | 社区版只能存储，无距离函数和向量索引 | 11.7 起支持 `VECTOR` 类型与向量索引，11.8 LTS 可用于生产 |
| RR 下的写冲突 | 当前读读取最新版本，不报错 | 11.8 / 12.3 LTS 默认 `innodb_snapshot_isolation=ON`，事务快照之后被别人修改过的行再去更新会报错 |
| 物理备份 | Percona XtraBackup、MySQL Enterprise Backup | `mariadb-backup`（XtraBackup 不支持 MariaDB 10.3+） |
| 存储引擎 | 以 InnoDB 为核心 | InnoDB 外还有 Aria、MyRocks、ColumnStore、Spider、S3 等 |

最后两点对 Java 应用影响最直接：

- **快照隔离**：开启 `innodb_snapshot_isolation` 后，可重复读事务更新一条在自己快照之后被其他事务修改过的行，会得到 `ERROR 1020 (HY000): Record has changed since last read`，而不是像 MySQL 那样基于最新版本继续执行。应用需要捕获该错误并重试整个事务；MVCC 原理见 [MySQL 事务与锁](./5_topic_transaction)
- **认证**：用 MySQL Connector/J 连接 MariaDB 一般没有问题；反过来把应用从 MariaDB 迁到 MySQL 8.4 时，账号要改用 `caching_sha2_password`

---

## 四、MariaDB 特有能力

### 1、SEQUENCE

独立于表的序列对象，可在多表间共享、设置步长和缓存，MySQL 没有对应功能：

```sql
CREATE SEQUENCE order_seq START WITH 1000 INCREMENT BY 1 CACHE 100;

CREATE TABLE orders (
  id     BIGINT PRIMARY KEY,
  amount DECIMAL(10, 2) NOT NULL
);

INSERT INTO orders (id, amount) VALUES (NEXT VALUE FOR order_seq, 99.00);
SELECT LASTVAL(order_seq);
```

### 2、RETURNING

写语句直接返回受影响的行，省掉一次回查：

```sql
DELETE FROM tasks WHERE status = 'done' RETURNING id, title;        -- 10.0.5+
INSERT INTO users (name) VALUES ('Alice') RETURNING id;             -- 10.5+
```

支持范围是 `DELETE`（10.0.5+）和 `INSERT` / `REPLACE`（10.5+）；截至 11.8 LTS，`UPDATE ... RETURNING` 仍不支持，这一点与 PostgreSQL 不同。

### 3、系统版本表（10.3+）

自动保留每行的历史版本，支持按时间点查询，审计场景可以省掉手写的历史表：

```sql
CREATE TABLE account (
  id      INT PRIMARY KEY,
  balance DECIMAL(10, 2)
) WITH SYSTEM VERSIONING;

SELECT * FROM account FOR SYSTEM_TIME AS OF TIMESTAMP '2026-06-01 00:00:00';
```

历史行与当前行存在同一张表里，更新频繁的表要规划好分区或定期清理历史数据。

### 4、向量类型与向量索引（11.7+）

MariaDB 的向量索引基于改进的 HNSW 算法（MHNSW），可以在数据库内直接做近似最近邻检索：

```sql
CREATE TABLE doc_embedding (
  id      BIGINT PRIMARY KEY AUTO_INCREMENT,
  content TEXT,
  vec     VECTOR(4) NOT NULL,                  -- 建向量索引的列必须 NOT NULL
  VECTOR INDEX (vec) M=8 DISTANCE=cosine
);

INSERT INTO doc_embedding (content, vec)
VALUES ('Java 并发编程', VEC_FromText('[0.12, -0.34, 0.56, 0.08]'));

SELECT id, content
FROM doc_embedding
ORDER BY VEC_DISTANCE_COSINE(vec, VEC_FromText('[0.10, -0.30, 0.50, 0.10]'))
LIMIT 5;
```

查询中的距离函数要与索引的 `DISTANCE` 一致，并且带 `ORDER BY ... LIMIT`，才会走向量索引。

### 5、Galera Cluster

Galera 是 MariaDB 内置的同步多主集群：事务在提交时把写集广播给所有节点做冲突检测（certification），通过后各节点一起提交。

- 任意节点可写，节点间数据强同步，没有主从延迟
- 写冲突在提交时才发现，失败的一方收到死锁错误，应用必须重试；热点行并发写入时冲突率高，实践中常只往一个节点写
- 只支持 InnoDB，所有表必须有主键；集群至少 3 个节点以避免脑裂
- 整体写入吞吐受最慢节点和网络延迟制约，不适合跨地域部署

MySQL 侧对应的方案是 Group Replication / InnoDB Cluster，见 [MySQL 主从与高可用](./9_topic_replication)。

### 6、存储引擎

| 引擎 | 用途 |
|------|------|
| **MyRocks**（RocksDB） | LSM-Tree 写优化，压缩率高，适合写多读少 |
| **ColumnStore** | 列式存储，用于 OLAP 分析查询 |
| **Spider** | 引擎层的分库分表，把一张表分片到多个后端实例 |
| **S3** | 把只读归档表放到对象存储 |

---

## 五、相关生态：Percona

Percona 是另一个 MySQL 兼容阵营，常与 MariaDB 一起比较：

- **Percona Server for MySQL**：跟随 MySQL 版本的增强发行版，与 MySQL 完全兼容，额外提供线程池、审计插件等
- **Percona XtraBackup**：按 MySQL 版本线发布（8.0 / 8.4 等），只支持 MySQL 和 Percona Server；MariaDB 10.3 起请用 `mariadb-backup`。备份方案见 [数据备份与恢复](../5_practice/1_backup_recovery)
- **Percona Toolkit**：`pt-query-digest` 的用法见 [EXPLAIN 与 SQL 优化](./7_topic_explain)，`pt-online-schema-change` 见 [MySQL 避坑指南](./3_fallible_point)

---

## 六、选型与迁移

- **默认选 MySQL 8.4 LTS**：Java 生态、CDC 工具、云托管（RDS、Aurora 等）支持最完整
- **选 MariaDB 的理由**：需要 SEQUENCE、系统版本表、库内向量检索、Galera 多主等能力，或团队希望使用由基金会参与治理的发行版
- **发行版里的 MySQL**：RHEL / CentOS 7 时代 `yum install mysql` 装的是 MariaDB；RHEL 8 / 9 的 AppStream 同时提供 MySQL 和 MariaDB，需要按包名区分；Debian 的 `default-mysql-server` 仍指向 MariaDB。安装前确认实际装的是哪一个
- **迁移不能假设无缝**：认证插件、JSON 存储、GTID 格式、系统库（`sys`、`performance_schema` 内容）、隔离行为都有差异，复制拓扑不能混用两种数据库；迁移前用逻辑导出导入，并对 SQL 和驱动做完整回归测试

---

## 小结

- MariaDB 由 MariaDB plc 主导开发、MariaDB Foundation 负责社区治理；10.2 起使用 InnoDB，但已与 MySQL 的 InnoDB 独立演进
- 当前社区 LTS 是 12.3、11.8、11.4、10.11，10.6 已于 2026 年 7 月停止维护
- 与 MySQL 的关键差异：默认认证插件、`JSON` 是 `LONGTEXT` 别名、GTID 格式不兼容、新 LTS 默认开启快照隔离
- RETURNING 只支持 `DELETE` 和 `INSERT` / `REPLACE`；SEQUENCE、系统版本表、向量索引、Galera 是 MariaDB 的特色
- MariaDB 物理备份用 `mariadb-backup`，Percona XtraBackup 不支持 MariaDB 10.3+

## 参考资料

- MariaDB Server 文档：[https://mariadb.com/docs/server](https://mariadb.com/docs/server)
- MariaDB 版本与维护周期：[https://mariadb.org/about/](https://mariadb.org/about/)
- MariaDB 12.3 LTS 发布公告：[https://mariadb.org/mariadb-server-12-3-lts-released/](https://mariadb.org/mariadb-server-12-3-lts-released/)
- 10.6 停止维护公告：[https://mariadb.org/mariadb-server-10-6-reaches-end-of-life-on-july-6th/](https://mariadb.org/mariadb-server-10-6-reaches-end-of-life-on-july-6th/)
- 向量功能：[https://mariadb.com/docs/server/reference/sql-structure/vectors](https://mariadb.com/docs/server/reference/sql-structure/vectors)
- caching_sha2_password 插件：[https://mariadb.com/docs/server/reference/plugins/authentication-plugins/authentication-plugin-caching_sha2_password](https://mariadb.com/docs/server/reference/plugins/authentication-plugins/authentication-plugin-caching_sha2_password)
- GitHub 仓库：[https://github.com/MariaDB/server](https://github.com/MariaDB/server)

> 下一篇：[MySQL 避坑指南](./3_fallible_point) —— 锁、字符集、NULL、时区、大表 DDL 等线上高频雷区及正确做法。

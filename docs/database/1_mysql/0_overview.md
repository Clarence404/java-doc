# MySQL

参考的数据库教程: [https://dunwu.github.io/db-tutorial/](https://dunwu.github.io/db-tutorial/)

## 一、数据库范式

### 1、第一范式 (1NF)：属性值不可分割

要求每个字段的值都是原子值，即字段的值必须不可再拆分。举例如下：
::: warning 不满足 1NF
**`地址`** 字段包含 "北京市 朝阳区 某路 XX号"。
:::
::: tip 满足 1NF 例子
**`地址`** 拆成多个字段：城市=北京市，区=朝阳区，地址=某路 XX号。
:::

### 2、第二范式 (2NF)：主键唯一性和消除部分依赖

**前提**：满足 1NF。

要求非主键字段完全依赖于主键，不能有仅依赖于主键一部分的字段（消除部分依赖）。举例如下：

::: warning 不满足 2NF

**`数据库表`**：课程表

**`主键字段`**：(课程ID, 教师ID)

**`其他字段`**：课程名称，教师名称
:::

<span style="color:red">**问题**：课程名称只依赖于课程ID，教师名称只依赖于教师ID，存在部分依赖。</span>

::: tip 满足 2NF

拆表方案：

**`课程表`**：课程ID -> 课程名称

**`教师表`**：教师ID -> 教师名称

**`课程教师关系表`**：课程ID, 教师ID。
:::

### 3、第三范式 (3NF)：消除传递依赖

**前提**：满足 2NF。

要求非主键字段直接依赖主键，不能通过其他非主键字段间接依赖主键（消除传递依赖）。举例如下：

::: warning 不满足 3NF

**`数据库表`**：学生表

**`主键字段`**：学生ID

**`其他字段`**：班级ID，班级名称
:::

<span style="color:red">问题：班级名称通过班级ID间接依赖于主键学生ID。</span>

::: tip 满足 3NF

**`学生表`**：学生ID -> 班级ID

**`班级表`**：班级ID -> 班级名称。
:::

---

## 二、MySQL 视图

> [!warning] 待补充

---

## 三、MySQL 存储过程

> [!warning] 待补充

---

## 四、MySQL 索引

B+ 树原理、聚簇索引与二级索引、回表、覆盖索引、最左前缀原则、索引失效场景、ICP 索引下推、深度分页优化详见专项文档：

→ [MySQL 索引专项](./4_topic_mysql_index)

---

## 五、MySQL 事务 / MVCC / 锁

ACID、隔离级别与并发问题（脏读/幻读）、undo log / redo log、MVCC 版本链与 Read View、行锁三种形态（Record / Gap / Next-Key Lock）、死锁检测详见专项文档：

→ [MySQL 事务、MVCC 与锁专项](./5_topic_mysql_transaction)

---

## 六、MySQL 性能优化

- **查询分析**
  - `EXPLAIN` 详解（type / key / rows / Extra 字段含义）
  - 慢查询日志（`slow_query_log`）+ `pt-query-digest` 分析
  - Performance Schema（替代已废弃的 `SHOW PROFILE`）
- **索引优化**
  - 覆盖索引减少回表
  - 区分度低的字段不建单列索引，考虑联合索引
- **SQL 优化**
  - 避免 `SELECT *`，只查需要的列
  - 避免在 WHERE 中对列做函数运算
  - 大批量操作用分批次 + 事务控制

---

## 七、数据库安全

- **SQL 注入防范**
  - 使用预编译语句（`PreparedStatement`）
  - ORM 框架（MyBatis / JPA）默认参数绑定
  - 避免拼接 SQL 字符串
- **访问控制**
  - 最小权限原则（`GRANT` / `REVOKE`）
  - 生产库禁止 root 远程登录
  - 加密传输（`require_ssl`）
- **数据安全**
  - 敏感字段脱敏存储（手机号、身份证加密）
  - 定期备份 + 恢复演练

---

## 八、MySQL 运维

- **主从复制**（主从同步延迟、半同步复制、GTID 复制）
- **读写分离**
- **高可用方案**：MHA、MySQL Router、ProxySQL
- **分库分表**：垂直拆分 vs 水平拆分，数据一致性问题
- **配置优化**：`innodb_buffer_pool_size`、`max_connections`、`sync_binlog`

### MySQL Binlog

**概念**

* Binlog 是 MySQL 的二进制日志（Binary Log），记录了数据库的所有 **修改操作**（INSERT/UPDATE/DELETE）以及 **数据变更顺序**。
* Binlog 不记录 SELECT 语句，但可以记录 `CREATE TABLE`、`ALTER TABLE` 等 DDL 操作。
* 主要用途：

  1. **数据恢复**：可用于 Point-in-Time 恢复（基于时间回滚数据）。
  2. **主从复制**：主库通过 Binlog 发送数据变更给从库。
  3. **审计与监控**：分析数据修改历史。

**类型**

1. **Statement-Based Logging (SBL)**：记录执行的 SQL 语句。

  * 优点：日志体积小。
  * 缺点：依赖 SQL 执行结果，某些函数（如 NOW()）可能在主从库不一致。
2. **Row-Based Logging (RBL)**：记录变更的行数据。

  * 优点：精确记录每一行变动，主从库结果一致。
  * 缺点：日志体积大。
3. **Mixed Logging (MBL)**：SBL 与 RBL 的混合模式，MySQL 自动选择最优方式。

**存储位置**

* Binlog 文件位于 MySQL 数据目录下，文件名通常形如：`mysql-bin.000001`。
* 对应的索引文件：`mysql-bin.index`，记录所有 binlog 文件列表。

**开启与管理**

```ini
[mysqld]
server-id = 1
log_bin = mysql-bin
binlog_format = ROW   # 或 STATEMENT / MIXED
expire_logs_days = 7  # 自动清理过期 binlog
```

```sql
-- 查看所有 binlog 文件
SHOW BINARY LOGS;
```

```bash
# 查看 binlog 内容
mysqlbinlog mysql-bin.000001
```

**注意事项**

1. **日志轮转与清理**：长期不清理会占用大量磁盘空间。
2. **性能考虑**：Binlog 开启后会略微增加写操作的开销。
3. **GTID**：增强型复制方式，更方便进行主从切换和容灾。

---

## 九、后续补充专题

- [Elasticsearch 与 OpenSearch](../4_nosql/4_elasticsearch_opensearch)：搜索引擎、日志检索、聚合分析
- [数据备份与恢复](../5_ops/1_backup_recovery)：备份策略、RTO / RPO、恢复演练

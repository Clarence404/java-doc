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

## 二、MySQL 视图

## 三、MySQL 存储过程

## 四、MySQL 索引的分类和优化

## 五、MySQL 事务

## 六、MySQL 一致性视图（MVCC）

## 七、MySQL 锁

### 1、读写锁（共享锁 vs 排他锁）

### 2、表锁 vs 行锁 vs 页面锁

### 3、意向锁（Intention Lock）

### 4、间隙锁（Gap Lock）和 Next-Key Lock

### 5、死锁检测和解决方案

### 6、锁的优化建议

Todo：完成自己的理解书写

[什么是MySQL锁？有哪些锁类型？](https://mp.weixin.qq.com/s/gAJFm3q5510PfRBe4F11PQ)

[MySQL锁机制详解：从原理到实战，Java开发者必知的高并发基石](https://mp.weixin.qq.com/s/A-aVFJLpCnNtAg8ZZN6-YQ)

## 八、Mysql性能优化-高级篇

- **查询优化**
    - EXPLAIN 详解（每个字段的意义）
    - 慢查询日志分析
- **索引优化**
    - B+ 树索引 vs 哈希索引
    - 如何选择合适的索引
- **SQL 语句优化**
    - 避免 SELECT *
    - 避免 NOT IN / NOT EXISTS 导致的全表扫描
    - 分析执行计划（EXPLAIN / PROFILE）

## 九、深度分页及优化

- LIMIT offset 大时的优化策略（比如 `ORDER BY id LIMIT 100000, 10` 的优化）
- **优化方法**：
    - 覆盖索引
    - 子查询优化
    - 使用延迟关联（先查主键，再关联其他字段）

## 十、数据库安全问题

- **SQL 注入防范**
    - 预编译 SQL 语句（PreparedStatement）
    - 使用 ORM 框架（如 MyBatis）
- **XSS 防范**
    - HTML 转义
    - 输入过滤
- **数据库访问控制**
    - 权限管理（GRANT, REVOKE）
    - 最小权限原则
    - MySQL 用户管理和加密传输

## 十一、MySQL 运维

- **主从复制**（主从同步延迟、半同步复制、GTID 复制）
- **读写分离**
- **高可用方案**
    - MHA、MySQL Router、ProxySQL
- **分库分表**
    - 垂直拆分 vs 水平拆分
    - 数据一致性问题
- **MySQL 配置优化**
    - my.cnf 配置优化
    - 常见参数（innodb_buffer_pool_size, query_cache_size, max_connections）

### 1、MySQL Binlog

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

**使用与管理**

* **开启 Binlog**：

```ini
[mysqld]
server-id = 1
log_bin = mysql-bin
binlog_format = ROW   # 或 STATEMENT / MIXED
expire_logs_days = 7  # 自动清理过期 binlog
```

* **查看 Binlog 文件**：

```sql
SHOW BINARY LOGS;
```

* **mysqlbinlog 下载**：

* **查看 Binlog 内容**：

```bash
mysqlbinlog mysql-bin.000001
```

* **主从复制使用**：从库通过 `CHANGE MASTER TO` 语句指定主库和位置，读取 Binlog 更新数据。

**注意事项**

1. **日志轮转与清理**：长期不清理会占用大量磁盘空间。
2. **性能考虑**：Binlog 开启后会略微增加写操作的开销。
3. **GTID（全局事务 ID）**：增强型复制方式，可以更方便地进行主从切换和容灾。

---

## 十二、后续补充专题

- [Elasticsearch 与 OpenSearch](./17_elasticsearch_opensearch)：搜索引擎、日志检索、聚合分析
- [数据备份与恢复](./18_backup_recovery)：备份策略、RTO / RPO、恢复演练

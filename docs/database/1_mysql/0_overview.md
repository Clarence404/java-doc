# MySQL

参考的数据库教程: [https://dunwu.github.io/db-tutorial/](https://dunwu.github.io/db-tutorial/)

## 一、数据库范式

| 范式 | 核心要求 | 违反示例 | 解决方案 |
|------|---------|---------|---------|
| **1NF** | 每个字段值不可再拆分（原子性）| `地址` 字段存 "北京市朝阳区某路XX号" | 拆为 `city`、`district`、`street` 三个字段 |
| **2NF** | 非主键字段完全依赖于主键（消除部分依赖）| 复合主键 `(课程ID, 教师ID)`，课程名称只依赖课程ID | 拆出课程表、教师表，关系表只存两个 ID |
| **3NF** | 非主键字段直接依赖主键（消除传递依赖）| 学生表中存 `班级ID` + `班级名称`，班级名称通过班级ID间接依赖学生ID | 拆出班级表，学生表只存 `班级ID` |

> 实际工程中适度反范式（冗余字段）是常见的性能优化手段，不必强求 3NF。

---

## 二、MySQL 视图

视图是基于 SQL 查询结果的虚拟表，**不存储数据**，每次查询时实时执行底层 SQL。

```sql
-- 创建视图
CREATE VIEW v_active_orders AS
SELECT o.id, o.user_id, u.name AS user_name, o.amount, o.status
FROM orders o
JOIN users u ON o.user_id = u.id
WHERE o.status != 'cancelled';

-- 使用视图（与普通表一致）
SELECT * FROM v_active_orders WHERE user_id = 123;

-- 更新视图定义
CREATE OR REPLACE VIEW v_active_orders AS ...;

-- 删除视图
DROP VIEW IF EXISTS v_active_orders;
```

**视图的作用**：
- **简化复杂查询**：封装多表 JOIN，对外暴露简单接口
- **权限控制**：只给用户授权视图，隐藏底层表结构和敏感字段
- **数据抽象**：业务层不感知底层表结构变化

**注意事项**：
- MySQL 视图**不缓存结果**，每次查询都执行底层 SQL（与物化视图不同）
- 满足特定条件的简单视图支持 INSERT/UPDATE（`WITH CHECK OPTION` 可限制更新范围）
- 复杂视图（含 GROUP BY、DISTINCT、子查询、UNION）**不可更新**

---

## 三、MySQL 存储过程

存储过程是预编译的 SQL 代码块，存储在数据库中，可通过名称调用。

```sql
-- 创建存储过程：批量更新订单状态
DELIMITER //
CREATE PROCEDURE batch_expire_orders(IN days_ago INT, OUT affected_rows INT)
BEGIN
  DECLARE exit_flag INT DEFAULT 0;
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET exit_flag = 1;

  START TRANSACTION;

  UPDATE orders
  SET status = 'expired'
  WHERE status = 'pending'
    AND created_at < DATE_SUB(NOW(), INTERVAL days_ago DAY);

  IF exit_flag = 0 THEN
    SET affected_rows = ROW_COUNT();
    COMMIT;
  ELSE
    SET affected_rows = 0;
    ROLLBACK;
  END IF;
END //
DELIMITER ;

-- 调用存储过程
CALL batch_expire_orders(30, @cnt);
SELECT @cnt AS affected;

-- 查看存储过程定义
SHOW CREATE PROCEDURE batch_expire_orders;

-- 删除存储过程
DROP PROCEDURE IF EXISTS batch_expire_orders;
```

**存储过程 vs 应用层代码**：

| 维度 | 存储过程 | 应用层代码 |
|------|---------|-----------|
| 性能 | 预编译，减少网络往返 | 每次发送 SQL |
| 维护性 | 难以版本管理、测试 | 代码仓库管理，易测试 |
| 可移植性 | 与数据库强绑定 | 可切换数据库 |
| 调试难度 | 困难 | 方便（日志、断点）|
| 适用场景 | 数据库内批量操作、DBA 脚本 | 业务逻辑（推荐）|

> **工程实践建议**：互联网业务中通常避免在存储过程中放置核心业务逻辑，逻辑放应用层，数据库只做数据存储。存储过程适合 DBA 批量数据修复、数据迁移等场景。

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

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

→ [MySQL 索引专项](./4_topic_index)

---

## 五、MySQL 事务 / MVCC / 锁

ACID、隔离级别与并发问题（脏读/幻读）、undo log / redo log、MVCC 版本链与 Read View、行锁三种形态（Record / Gap / Next-Key Lock）、死锁检测详见专项文档：

→ [MySQL 事务、MVCC 与锁专项](./5_topic_transaction)

---

## 六、SQL 执行流程

连接器 → 分析器 → 优化器 → 执行器的完整链路、UPDATE 的写入路径（Buffer Pool / undo / redo / binlog）、崩溃恢复规则详见专项文档：

→ [MySQL SQL 执行流程专项](./6_topic_execution)

---

## 七、性能优化（EXPLAIN 与慢 SQL）

EXPLAIN 字段详解（type 等级 / key_len / Extra）、慢查询日志 + `pt-query-digest`、Optimizer Trace、ORDER BY 与 filesort、COUNT 性能差异、JOIN 原理与优化详见专项文档：

→ [MySQL EXPLAIN 与 SQL 优化专项](./7_topic_explain)

**日常三条速记**：避免 `SELECT *`；WHERE 里不对列做函数运算；大批量操作分批次提交。

---

## 八、InnoDB 存储结构

段 / 区 / 页层次、行格式与行溢出、Buffer Pool 三链表与 LRU 冷热分离、Double Write、脏页刷盘时机、存储引擎对比详见专项文档：

→ [InnoDB 存储结构与 Buffer Pool 专项](./8_topic_innodb)

---

## 九、数据库安全

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

## 十、Binlog、主从复制与高可用

Binlog 三种格式与管理、主从复制三线程模型、GTID / 半同步、主从延迟与并行复制、高可用方案（MHA / MGR / InnoDB Cluster）、读写分离详见专项文档：

→ [MySQL Binlog、主从复制与高可用专项](./9_topic_replication)

**其他运维要点**：

- **分库分表**：垂直拆分（按业务）vs 水平拆分（按数据量），见 [数据库中间件](../5_practice/2_sharding)
- **配置优化**：`innodb_buffer_pool_size`（建议物理内存 60%~70%）、`max_connections`（按连接池总量设置）、`sync_binlog=1` + `innodb_flush_log_at_trx_commit=1`（双 1 强持久性）

---

## 十一、后续补充专题

- [Elasticsearch 与 OpenSearch](../4_nosql/3_search_db)：搜索引擎、日志检索、聚合分析
- [数据备份与恢复](../5_practice/1_backup_recovery)：备份策略、RTO / RPO、恢复演练

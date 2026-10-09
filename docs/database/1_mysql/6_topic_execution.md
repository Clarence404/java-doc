---
description: Server 层与存储引擎层、连接器与权限生效、优化器与选错索引、SELECT 与 UPDATE 执行路径
---

# SQL 执行流程

> **本篇目标**：理清一条 SQL 从客户端到 InnoDB 经过哪些组件、各组件负责什么，知道权限变更何时生效、长连接与选错索引怎么处理，并能把 UPDATE 的执行阶段与提交阶段分开讲清楚。
>
> **前置阅读**：[MySQL 事务与锁](./5_topic_transaction)（undo / redo / binlog 与两阶段提交）

本文以 MySQL 8.4 LTS 为基线。执行计划的读法见 [EXPLAIN 与 SQL 优化](./7_topic_explain)，Buffer Pool 与刷脏见 [InnoDB 存储结构](./8_topic_innodb)。

---

## 一、整体架构

MySQL 分为 **Server 层** 和 **存储引擎层** 两部分：

![一条 SQL 在 MySQL 中的执行流程](../../assets/mysql/mysql-sql-execution.svg)

| 层次 | 包含组件 | 职责 |
|------|---------|------|
| **Server 层** | 连接器、分析器、优化器、执行器 | 跨引擎的功能：SQL 解析、优化、内置函数、存储过程、触发器、视图、binlog |
| **存储引擎层** | InnoDB / MyISAM / Memory 等（插件式） | 数据的实际存取，通过统一的 handler API 与 Server 层交互 |

---

## 二、各组件职责

### 1、连接器

负责 TCP 握手、身份认证（8.4 默认 `caching_sha2_password`）、建立会话。

**权限变更何时生效**：通过 `GRANT` / `REVOKE` / `CREATE USER` 等语句修改权限时，服务器立即更新内存中的权限表，已建立的连接也会受影响，只是生效时机因权限级别而异：

| 变更的权限 | 对已连接会话的生效时机 |
|------|------|
| 表级、列级权限 | 该会话的下一条语句 |
| 库级权限 | 该会话下一次执行 `USE db_name`（客户端可能缓存库名） |
| 静态全局权限、密码 | 不影响已连接会话，只对之后新建的连接生效 |
| 动态全局权限 | 立即生效 |

直接用 DML 修改 `mysql.user` 等权限表不会立即生效，需要 `FLUSH PRIVILEGES`；生产中应始终用账户管理语句。要让被回收全局权限或改了密码的账号立刻失效，需要 `KILL` 它现有的连接。

**空闲连接超时**：`wait_timeout` 默认 8 小时，超时后服务器断开连接，客户端再发语句时报 `2013 Lost connection to MySQL server during query` 或 `2006 MySQL server has gone away`。连接池的 `maxLifetime` 应小于 `wait_timeout`，详见 [数据库连接池](../5_practice/3_connection_pool)。

**长连接内存**：执行过程中分配的部分内存挂在会话上，直到连接断开才释放，长连接累积可能占用大量内存。两种解法：

- 定期断开重连：连接池设置 `maxLifetime`
- 重置会话：C API `mysql_reset_connection()`（协议命令 `COM_RESET_CONNECTION`，5.7+）在不重新认证的情况下清理会话状态；它是客户端 API，不是 SQL 语句

```sql
-- 查看当前连接
SHOW PROCESSLIST;
```

### 2、查询缓存（8.0 已移除）

以 SQL 文本为 key 缓存结果集，表上任何更新都会让该表的所有缓存失效，高并发下还有全局锁争用，8.0 直接移除了这个模块。需要结果缓存时在应用层做，见 [缓存总览](/cache/0_overview)。

### 3、分析器

- **词法分析**：把 SQL 字符串拆成 token，识别关键字、表名、列名
- **语法分析**：按语法规则生成语法树，语法错误在此抛出 `ERROR 1064 ... You have an error in your SQL syntax`
- **预处理**：打开表、解析列名，表或列不存在的错误在此阶段报出

### 4、优化器

基于**成本（cost）**选择执行方案：根据统计信息估算各方案的扫描行数、回表次数、是否需要排序或临时表，选成本最低的：

- 多个索引可用时选哪个，或者是否干脆全表扫描
- 多表 JOIN 时决定连接顺序和连接算法（8.0.20 起用 hash join 取代 Block Nested-Loop）
- 子查询改写、条件化简等

统计信息不准时优化器可能**选错索引**，处理手段从轻到重：

```sql
-- 1. 重新采集统计信息
ANALYZE TABLE orders;

-- 2. 对非索引列或分布倾斜的列建直方图，帮助优化器估算选择度（8.0+）
ANALYZE TABLE orders UPDATE HISTOGRAM ON status WITH 32 BUCKETS;

-- 3. 优化器 hint 指定索引（8.0.20+），只影响本条语句，比 FORCE INDEX 更细粒度
SELECT /*+ INDEX(orders idx_create_time) */ *
FROM orders WHERE create_time > '2024-01-01' LIMIT 100;

-- 4. 传统写法 FORCE INDEX（应急手段，索引名硬编码在代码里不利于维护）
SELECT * FROM orders FORCE INDEX (idx_create_time)
WHERE create_time > '2024-01-01' LIMIT 100;
```

想验证「去掉某个索引后优化器会怎么选」，先把它设为不可见（`ALTER TABLE ... ALTER INDEX ... INVISIBLE`），比直接删除安全，见 [MySQL 索引](./4_topic_index)。

### 5、执行器

- 打开表时校验当前用户对该表的权限，没有权限返回 `ERROR 1142`
- 按执行计划循环调用存储引擎的 handler 接口，逐行读取或写入
- 慢查询日志中的 `Rows_examined` 是 Server 层从引擎拿到并检查的行数；被 ICP 在引擎层过滤掉的条目不计入，所以它不等于引擎实际扫描的索引条目或数据页数

---

## 三、一条 SELECT 的执行过程

```sql
SELECT * FROM t_user WHERE id = 10;
```

1. **连接器**：连接建立时已完成认证，会话中带着当前用户的权限
2. **分析器**：词法 + 语法分析，打开表并确认列存在
3. **优化器**：`id` 是主键，选择聚簇索引点查（EXPLAIN 中 `type=const`）
4. **执行器**：校验对 `t_user` 的 SELECT 权限，调用 InnoDB 接口读取 `id=10` 的行
5. **InnoDB**：先查 Buffer Pool，未命中则从磁盘读入数据页（16KB），按 MVCC 返回对当前事务可见的版本
6. **执行器**：把结果返回客户端

---

## 四、一条 UPDATE 的执行过程

```sql
UPDATE t_user SET age = age + 1 WHERE id = 10;
```

连接器、分析器、优化器与 SELECT 相同，区别在执行器与引擎的写入路径。这里要把**语句执行**和**事务提交**分开：

### 1、执行阶段（语句执行时）

1. **定位并加锁**：InnoDB 把 id=10 所在页读入 Buffer Pool（若未命中），读最新版本（当前读）并加 X 锁
2. **写 undo log**：记录旧值，用于回滚和 MVCC 版本链
3. **修改内存页**：直接修改 Buffer Pool 中的数据页，该页成为**脏页**
4. **生成 redo**：页修改（含 undo 页的修改）产生的 redo 记录写入 log buffer，此时不要求落盘
5. **生成 binlog 事件**：执行器把行变更写入当前会话的 **binlog cache**，此时还没有写入 binlog 文件

autocommit 模式下语句执行完立即进入提交阶段；显式事务则等到 `COMMIT`。

### 2、提交阶段（COMMIT 时）

开启 binlog 时，提交走两阶段提交与组提交：InnoDB prepare，然后 flush 阶段把 redo 刷盘并把 binlog cache 写入 binlog 文件，sync 阶段对 binlog fsync，最后 commit 阶段在 InnoDB 中提交并释放锁。事务是否算提交以 binlog 中是否有它的 XID 为准，崩溃恢复规则与流程图见 [MySQL 事务与锁](./5_topic_transaction) 的两阶段提交一节。

**为什么更新不直接写数据页？** 修改数据页是随机 I/O，redo 是顺序 I/O。WAL 先顺序写日志、脏页由后台线程异步刷盘，把随机写转换为顺序写，这是 InnoDB 写性能的核心。脏页何时刷盘见 [InnoDB 存储结构](./8_topic_innodb)。

---

## 小结

- Server 层负责连接、解析、优化、执行和 binlog，引擎层通过 handler API 负责存取
- 权限变更会影响已连接会话：表、列级下一条语句生效，库级下一次 `USE` 生效，只有静态全局权限和密码要等新连接
- 空闲连接超过 `wait_timeout` 会被断开（2006 / 2013），连接池 `maxLifetime` 要小于它
- 查询缓存在 8.0 已移除
- 优化器基于成本选方案，选错索引时依次考虑 `ANALYZE TABLE`、直方图、优化器 hint、`FORCE INDEX`
- UPDATE 执行时只写 undo、改 Buffer Pool、把 redo 写入 log buffer、把行事件写入 binlog cache；redo prepare、binlog 写入与 fsync、redo commit 都发生在 COMMIT 时

## 参考资料

- When Privilege Changes Take Effect：[https://dev.mysql.com/doc/refman/8.4/en/privilege-changes.html](https://dev.mysql.com/doc/refman/8.4/en/privilege-changes.html)
- Server System Variables（wait_timeout）：[https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html)
- mysql_reset_connection()：[https://dev.mysql.com/doc/c-api/8.4/en/mysql-reset-connection.html](https://dev.mysql.com/doc/c-api/8.4/en/mysql-reset-connection.html)
- Optimizer Hints：[https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html)
- Optimizer Statistics（直方图）：[https://dev.mysql.com/doc/refman/8.4/en/optimizer-statistics.html](https://dev.mysql.com/doc/refman/8.4/en/optimizer-statistics.html)
- Hash Join Optimization：[https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html](https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html)
- The Binary Log：[https://dev.mysql.com/doc/refman/8.4/en/binary-log.html](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)

> 下一篇：[EXPLAIN 与 SQL 优化](./7_topic_explain) —— 读懂执行计划的 type 与 Extra，定位慢 SQL，优化排序、COUNT 与 JOIN。

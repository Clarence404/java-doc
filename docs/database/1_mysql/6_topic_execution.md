# MySQL 专项 - SQL 执行流程

## 一、整体架构

MySQL 分为 **Server 层** 和 **存储引擎层** 两部分：

![一条 SQL 在 MySQL 中的执行流程](../../assets/mysql/mysql-sql-execution.svg)

| 层次 | 包含组件 | 职责 |
|------|---------|------|
| **Server 层** | 连接器、分析器、优化器、执行器 | 所有跨引擎的功能：SQL 解析、优化、内置函数、触发器、视图 |
| **存储引擎层** | InnoDB / MyISAM / Memory 等（插件式） | 数据的实际存取，通过统一的 handler API 与 Server 层交互 |

---

## 二、各组件职责

### 1、连接器

负责 TCP 握手、身份认证、权限读取：

- **权限在连接建立时读取**：连接期间管理员修改权限，不影响已建立的连接
- **空闲连接超时**：`wait_timeout` 默认 8 小时，超时后连接被断开，客户端再执行报 `Lost connection`
- **长连接内存问题**：MySQL 执行过程中的临时内存挂在连接对象上，长连接累积可能导致 OOM

```sql
-- 查看当前连接
SHOW PROCESSLIST;

-- 长连接内存问题的两种解法：
-- 1. 定期断开重连（连接池的 maxLifetime）
-- 2. 5.7+ 执行 mysql_reset_connection 重置连接资源（不需重连和鉴权）
```

### 2、查询缓存（8.0 已彻底移除）

以 SQL 语句为 key 缓存结果集。**只要表上有任何更新，该表所有缓存全部失效**，命中率极低，弊大于利，8.0 直接移除了这个模块。

### 3、分析器

- **词法分析**：把 SQL 字符串拆成 token，识别关键字、表名、列名
- **语法分析**：按语法规则生成语法树，语法错误在此抛出 `You have an error in your SQL syntax`
- 表不存在、列不存在的错误也在此阶段（打开表校验列信息）

### 4、优化器

基于**成本（cost）**决定执行方案：

- 多个索引可用时选哪个（扫描行数、是否回表、是否排序都计入成本）
- 多表 JOIN 时决定连接顺序
- 优化器可能**选错索引**（统计信息不准时），可用 `ANALYZE TABLE` 重新统计，或 `FORCE INDEX` 强制指定：

```sql
-- 统计信息失真导致选错索引时
ANALYZE TABLE orders;

-- 强制走指定索引（应急手段，代码里硬编码索引名不利于维护）
SELECT * FROM orders FORCE INDEX(idx_create_time)
WHERE create_time > '2024-01-01' LIMIT 100;
```

### 5、执行器

- 执行前校验**表级权限**（精细的列权限在此之前）
- 循环调用存储引擎的 handler 接口逐行取数据 / 写数据
- 慢查询日志中的 `rows_examined` 就是执行器累计调用引擎接口的行数

---

## 三、一条 SELECT 的完整执行

```sql
SELECT * FROM user WHERE id = 10;
```

1. **连接器**：校验用户名密码，读取权限
2. **分析器**：词法 + 语法分析，确认表和列存在
3. **优化器**：`id` 是主键，决定走聚簇索引点查
4. **执行器**：校验对 `user` 表的 SELECT 权限，调用 InnoDB 接口"取 id=10 的行"
5. **InnoDB**：先查 Buffer Pool，未命中则从磁盘读入数据页（16KB），返回该行
6. **执行器**：将结果返回客户端

---

## 四、一条 UPDATE 的完整执行

```sql
UPDATE user SET age = age + 1 WHERE id = 10;
```

前 4 步与 SELECT 相同（连接器 → 分析器 → 优化器 → 执行器），关键在引擎层的写入路径：

1. **读取数据页**：InnoDB 将 id=10 所在页读入 Buffer Pool（若未命中）
2. **写 undo log**：记录旧值，用于回滚和 MVCC 版本链
3. **更新内存页**：直接修改 Buffer Pool 中的页，该页成为**脏页**
4. **写 redo log（prepare 状态）**：物理日志顺序写，此时数据已可恢复
5. **执行器写 binlog**：逻辑日志，记录行变更
6. **提交事务**：redo log 改为 commit 状态 —— 即**两阶段提交**

> 两阶段提交的流程图与 redo/undo/binlog 的详细对比，见 [事务、MVCC 与锁专项](./5_topic_transaction)。

**为什么更新不直接写磁盘？** 修改数据页是随机 I/O，redo log 是顺序 I/O。WAL（Write-Ahead Logging）先顺序写日志、脏页异步刷盘，把随机写转换为顺序写，这是 InnoDB 写性能的核心。

### 崩溃恢复的判断规则

宕机重启后，InnoDB 扫描 redo log：

| redo log 状态 | binlog 状态 | 处理 |
|--------------|------------|------|
| commit | — | 直接提交 |
| prepare | binlog 完整 | 提交（binlog 可能已被从库消费）|
| prepare | binlog 不完整 | 回滚 |

这保证了 redo log（主库数据）与 binlog（从库/备份数据）的最终一致。

---

## 五、相关专项

- Buffer Pool、脏页刷盘时机 → [InnoDB 存储结构专项](./8_topic_innodb)
- 执行计划分析与慢 SQL 优化 → [EXPLAIN 与 SQL 优化专项](./7_topic_explain)

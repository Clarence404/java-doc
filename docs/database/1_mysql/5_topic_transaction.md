---
description: ACID、隔离级别、MVCC、加锁规则、死锁排查、redo / undo / binlog 两阶段提交、长事务
---

# MySQL 事务与锁

> 前置阅读：[MySQL 索引](./4_topic_index)

InnoDB 用 undo、redo、MVCC 和锁实现 ACID，本篇讲隔离级别、加锁规则与死锁排查、redo 与 binlog 两阶段提交及崩溃恢复，范围限于单个 InnoDB 实例内的事务。以 MySQL 8.4 LTS 为基线。

---

## 一、事务 ACID

Spring 声明式事务与传播行为见 [事务管理](/spring/4_transaction)，跨库、跨服务的事务见 [分布式事务](/distributed/4_transaction)。

| 特性 | 含义 | InnoDB 实现手段 |
|------|------|----------------|
| **原子性** (Atomicity) | 事务要么全成功，要么全回滚 | undo log |
| **一致性** (Consistency) | 事务前后数据库满足约束、逻辑一致 | 由其他三者与约束共同保障 |
| **隔离性** (Isolation) | 并发事务之间互不干扰 | MVCC + 锁 |
| **持久性** (Durability) | 提交后数据不因宕机丢失 | redo log（WAL）+ 两阶段提交 |

---

## 二、并发问题与隔离级别

### 1、三种并发读问题

| 问题 | 描述 | 触发条件 |
|------|------|---------|
| **脏读** | 读到另一事务**未提交**的数据 | 事务 B 修改未提交，事务 A 就读到了 |
| **不可重复读** | 同一事务内两次读**同一行**结果不同 | 事务 B 修改并提交，事务 A 两次读之间结果变了 |
| **幻读** | 同一事务内两次**范围查询**行数不同 | 事务 B 插入新行并提交，事务 A 范围查询多出了几行 |

### 2、四种隔离级别

表中「可能」表示该现象会发生，「避免」表示不会发生：

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | InnoDB 实现 |
|----------|:----:|:---------:|:----:|------|
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 读最新版本，不用 Read View |
| **READ COMMITTED（RC）** | 避免 | 可能 | 可能 | 每次快照读新建 Read View；基本不加间隙锁 |
| **REPEATABLE READ（RR，默认）** | 避免 | 避免 | 基本避免 | 复用一个 Read View；当前读加 Next-Key Lock |
| SERIALIZABLE | 避免 | 避免 | 避免 | 关闭 autocommit 时普通 SELECT 隐式变为 `FOR SHARE` |

RR 下「基本避免」幻读：纯快照读靠 Read View，当前读靠 Next-Key Lock；两者混用时仍可能看到新行，见下一小节。

### 3、快照读与当前读

| 对比项 | 快照读（Snapshot Read） | 当前读（Current Read） |
|---|---|---|
| 语句 | 普通 `SELECT` | `SELECT ... FOR UPDATE` / `FOR SHARE`、`UPDATE`、`DELETE`、`INSERT` |
| 读到的版本 | Read View 决定的历史版本 | **最新已提交版本** |
| 是否加锁 | 不加锁（MVCC） | 加锁（Record / Gap / Next-Key） |
| RR 下防幻读 | 靠复用 Read View | 靠 Next-Key Lock |

`FOR SHARE` 是 8.0 起的写法，旧的 `LOCK IN SHARE MODE` 仅为兼容保留。8.0 还支持 `NOWAIT`（拿不到锁立即报错）和 `SKIP LOCKED`（跳过已锁行，适合任务队列）。

**混用两种读仍可能「看见」幻读**：

```sql
-- RR 级别，事务 A：
SELECT * FROM t WHERE k = 5;          -- 快照读：0 行
-- 此时事务 B 插入 k=5 并提交
UPDATE t SET v = 1 WHERE k = 5;       -- 当前读：更新到了 B 插入的行
SELECT * FROM t WHERE k = 5;          -- 再快照读：1 行（自己改过的行对自己可见）
```

所以 RR 只对**纯快照读**序列保证可重复读；事务中一旦出现当前读，读到的就是最新数据。「先检查再修改」的业务，第一步就该用 `SELECT ... FOR UPDATE`，或者直接用带条件的 `UPDATE` 并检查影响行数。

---

## 三、MVCC（多版本并发控制）

MVCC 让**普通读不加锁**，通过版本链实现读写并发。

### 1、行的隐藏列

| 隐藏列 | 大小 | 说明 |
|------|------|------|
| `DB_TRX_ID` | 6 字节 | 最近一次插入或更新此行的事务 ID |
| `DB_ROLL_PTR` | 7 字节 | 回滚指针，指向 undo log 中该行的上一个版本 |
| `DB_ROW_ID` | 6 字节 | 仅在表没有主键和非空唯一索引时生成，见 [MySQL 索引](./4_topic_index) |

### 2、版本链与 Read View 可见性

UPDATE 不覆盖旧版本：旧值写入 undo log，新版本的 `DB_ROLL_PTR` 指向它，形成版本链。快照读时用 Read View 判断每个版本是否可见（图中简写为 trx_id / roll_ptr）：

![MVCC 版本链与 Read View 可见性判断](../../assets/mysql/mysql-mvcc-version-chain.svg)

Read View 有四个字段：`m_ids`（创建时活跃的事务 ID 列表）、`min_trx_id`（`m_ids` 最小值）、`max_trx_id`（下一个待分配的事务 ID）、`creator_trx_id`（创建者自身 ID）。对版本链上每个版本的 `DB_TRX_ID` 依次判断：

| 条件 | 结论 | 含义 |
|------|------|------|
| 等于 `creator_trx_id` | 可见 | 自己改的 |
| 小于 `min_trx_id` | 可见 | Read View 创建前已提交 |
| 大于等于 `max_trx_id` | 不可见 | Read View 创建后才开始 |
| 在 `m_ids` 中 | 不可见 | 创建时还未提交 |
| 介于两者之间且不在 `m_ids` 中 | 可见 | 创建前已提交的并发事务 |

不可见就沿 `DB_ROLL_PTR` 找上一个版本，直到找到可见版本或链尾。

### 3、RC 与 RR 的 Read View 差异

| 隔离级别 | Read View 创建时机 | 结果 |
|----------|-------------------|------|
| READ COMMITTED | **每次快照读都重新创建** | 能看到其他事务最新提交的数据，存在不可重复读 |
| REPEATABLE READ | **事务中第一次快照读时创建，之后复用** | 整个事务看到固定快照 |

`BEGIN` / `START TRANSACTION` 本身不创建 Read View；需要从事务开始那一刻就固定快照时用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`（只在 RR 下有意义），mysqldump `--single-transaction` 就是这样做的。

---

## 四、undo、redo 与 binlog

### 1、undo log（回滚日志）

- **作用**：原子性（回滚）+ MVCC 版本链
- **内容**：逻辑逆操作。INSERT 记录主键用于删除；UPDATE / DELETE 记录旧值
- **存储**：8.0 起 undo log 不再放在系统表空间，初始化时默认创建两个 undo 表空间 `undo_001`、`undo_002`（位置由 `innodb_undo_directory` 决定），可用 `CREATE UNDO TABLESPACE` 增加；`innodb_undo_log_truncate` 默认开启，超过 `innodb_max_undo_log_size` 自动截断
- **清理**：insert undo 在提交后即可丢弃；update undo 要等没有任何 Read View 还需要它时，由 purge 线程清理。长事务会让 undo 无法清理（见第七节）

### 2、redo log（重做日志）

- **作用**：持久性，宕机后把已提交但未刷盘的数据页修改重放回来
- **原理**：WAL（Write-Ahead Logging），先顺序写 redo，脏页由后台异步刷盘，把随机写变成顺序写
- **内容**：物理日志，记录「某表空间某页某偏移做了什么修改」
- **存储（8.0.30+）**：数据目录下的 `#innodb_redo` 目录，固定 32 个 `#ib_redoN` 文件循环使用，总容量由 `innodb_redo_log_capacity` 设置（默认 100MB），可在线调整；8.0.30 之前的 `ib_logfile0` / `ib_logfile1` 与 `innodb_log_file_size` 已被取代

redo 先写入内存中的 **log buffer**，何时刷盘由 `innodb_flush_log_at_trx_commit` 控制：

| 值 | 提交时行为 | 宕机丢数据风险 | 性能 |
|:--:|-----------|--------------|------|
| 0 | 只写 log buffer，后台约每秒写盘并 fsync | mysqld 崩溃即可能丢最多约 1 秒 | 最快 |
| **1（默认）** | 每次提交写盘并 fsync | 不丢已提交事务 | 最慢 |
| 2 | 提交时写入 OS page cache，约每秒 fsync | mysqld 崩溃不丢；**主机断电**丢最多约 1 秒 | 折中 |

binlog 由 `sync_binlog` 控制：1 表示每次提交 fsync（默认），N 表示每 N 组提交 fsync 一次，0 交给操作系统。

- **「双 1」**：`innodb_flush_log_at_trx_commit=1` 且 `sync_binlog=1`，金融级持久性的标配。每次提交理论上要 redo 和 binlog 两次 fsync，组提交（group commit）让同一批并发提交的事务共享 fsync，实际开销被摊薄
- **「2 + N」**：`innodb_flush_log_at_trx_commit=2`、`sync_binlog=N`（如 100 或 1000），写入密集且可容忍断电丢秒级数据的场景使用，主库不建议

### 3、三种日志对比

| 对比项 | undo log | redo log | binlog |
|---|---|---|---|
| 所属层 | InnoDB 引擎层 | InnoDB 引擎层 | **Server 层**（所有引擎共用） |
| 日志类型 | 逻辑日志（逆操作） | 物理日志（页的改动） | 逻辑日志（8.4 推荐 ROW 格式的行变更） |
| 写入方式 | 随 DML 写入 undo 页（undo 页本身也受 redo 保护） | 循环写，checkpoint 推进后覆盖 | 追加写，写满切换新文件 |
| 用途 | 回滚 + MVCC 版本链 | 崩溃恢复 | 主从复制、时间点恢复、CDC 订阅 |

binlog 与复制见 [MySQL 主从与高可用](./9_topic_replication)。

### 4、两阶段提交与崩溃恢复

redo 与 binlog 分属两层，必须保证二者对「哪些事务已提交」的结论一致：否则主库恢复出的数据与从库、备份回放出的数据不同。InnoDB 用以 binlog 为协调者的内部 XA 两阶段提交解决：

![redo / undo / binlog 两阶段提交与崩溃恢复](../../assets/mysql/mysql-two-phase-commit.svg)

**执行阶段**（DML 语句执行时，尚未提交）：

1. 写 undo log，记录旧值
2. 修改 Buffer Pool 中的数据页，页变为脏页
3. 页修改产生的 redo 记录写入 log buffer（还不要求落盘）
4. 行变更事件写入当前会话的 binlog cache（还未进入 binlog 文件）

**提交阶段**（执行 `COMMIT` 时，binlog 组提交分三个阶段，每阶段由一个 leader 替一组事务完成）：

1. **Prepare**：InnoDB 把事务标记为 prepared 并记录 XID
2. **Flush 阶段**：先把 redo 刷到这一组事务的位置（双 1 时 fsync），再把各会话的 binlog cache 写入 binlog 文件
3. **Sync 阶段**：按 `sync_binlog` 对 binlog 文件 fsync，此后 binlog 中有了该事务的 XID 事件
4. **Commit 阶段**：按 binlog 中的顺序在 InnoDB 中提交，释放锁；commit 标记不需要立即 fsync

**崩溃恢复规则**：重启时 InnoDB 先用 redo 重放数据页，再找出处于 prepared 状态的事务；Server 层扫描最后一个 binlog 文件，收集其中完整写入的 XID：

| InnoDB 中的事务状态 | binlog 中是否有该 XID | 处理 |
|--------------|------------|------|
| 已 commit | — | 保持提交 |
| prepared | 有（事务事件完整） | 提交：binlog 可能已被从库或备份消费 |
| prepared | 没有 | 回滚：binlog 中没有，从库也不会有 |
| 未 prepare | — | 用 undo 回滚 |

结论：**事务是否提交以 binlog 是否完整写入为准**。这也是「双 1」重要的原因：只要 binlog 落盘了，redo 中至少有 prepare 记录，恢复时一定能把它提交。

---

## 五、锁

### 1、共享锁与排他锁

| 锁类型 | 兼容关系 | 加锁方式 |
|--------|---------|---------|
| 共享锁（S） | S 与 S 兼容 | `SELECT ... FOR SHARE` |
| 排他锁（X） | 与 S、X 均不兼容 | `SELECT ... FOR UPDATE`、UPDATE、DELETE |

### 2、意向锁（Intention Lock）

**表级锁**，事务在加行锁前先在表上加意向锁，让表级加锁请求能快速判断表中是否有行锁。

- **IS**：加行级 S 锁前先加 IS
- **IX**：加行级 X 锁前先加 IX
- 意向锁之间完全兼容，只与 `LOCK TABLES ... READ/WRITE` 等**表级** S / X 锁冲突

### 3、行锁的形态

行锁加在**索引记录**上，不是加在行上；没有可用索引时会扫描并锁住聚簇索引上的所有记录。

| 锁 | data_locks 中的 LOCK_MODE | 锁住的范围 |
|------|------|------|
| Record Lock | `X,REC_NOT_GAP` | 单条索引记录 |
| Gap Lock | `X,GAP` | 该记录之前的开区间，只阻止插入 |
| Next-Key Lock | `X` | 该记录之前的间隙 + 记录本身，左开右闭 |
| Insert Intention Lock | `X,GAP,INSERT_INTENTION` | INSERT 前在间隙上申请，被其他事务的 Gap / Next-Key Lock 阻塞 |

间隙锁之间互相兼容（两个事务可以同时持有同一间隙的 Gap Lock），它们只和插入意向锁冲突。最后一个间隙由索引页上的 supremum 伪记录承载：

![行锁形态与 Next-Key Lock 区间划分](../../assets/mysql/mysql-next-key-lock.svg)

### 4、RR 下的加锁规则

RR 下当前读的基本单位是 Next-Key Lock，**扫描到的每条索引记录都加锁**（不论是否满足 WHERE 中其他条件），再按索引类型优化：

- **唯一索引（含主键）等值查询，命中**：退化为 Record Lock
- **唯一索引等值查询，未命中**：在第一个大于查询值的记录上加 Gap Lock
- **非唯一索引等值查询**：命中的每条记录加 Next-Key Lock，并且继续向右扫描到第一条不匹配的记录，对它加 Gap Lock
- **范围查询**：扫描到的记录都加 Next-Key Lock；对第一条超出范围的记录，唯一索引上加 Gap Lock（8.0.18+），非唯一索引上加 Next-Key Lock
- 通过二级索引加 X 锁时，对应的聚簇索引记录也会加 Record Lock

以下面的表为例：

```sql
CREATE TABLE t (
  id INT PRIMARY KEY,
  k  INT,
  v  INT,
  KEY idx_k (k)
);
INSERT INTO t VALUES (5, 5, 0), (10, 10, 0), (15, 15, 0), (20, 20, 0);
```

| 语句（RR，各自在新事务中执行） | data_locks 中的锁 | 等价的锁定范围 |
|------|------|------|
| `SELECT * FROM t WHERE id = 10 FOR UPDATE` | PRIMARY `10`：`X,REC_NOT_GAP` | 只锁 id=10 |
| `SELECT * FROM t WHERE id = 12 FOR UPDATE` | PRIMARY `15`：`X,GAP` | 间隙 (10, 15) |
| `SELECT * FROM t WHERE k = 10 FOR UPDATE` | idx_k `10, 10`：`X`；idx_k `15, 15`：`X,GAP`；PRIMARY `10`：`X,REC_NOT_GAP` | k 上 (5, 10] 与 (10, 15) |
| `SELECT * FROM t WHERE id > 10 AND id < 20 FOR UPDATE` | PRIMARY `15`：`X`；PRIMARY `20`：`X,GAP` | (10, 15] 与 (15, 20)，即 (10, 20) 内的间隙和 id=15 |
| `SELECT * FROM t WHERE id > 20 FOR UPDATE` | PRIMARY `supremum pseudo-record`：`X` | (20, supremum] |

每条语句执行后，在同一会话里查询实际加的锁：

```sql
SELECT ENGINE_TRANSACTION_ID AS trx, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA
FROM performance_schema.data_locks
WHERE OBJECT_NAME = 't';
```

除了行锁，结果中还会有一条表级 `IX`。加锁细节与版本和执行计划有关，**以 data_locks 的实际输出为准**。

### 5、RC 下的加锁差异

很多团队把隔离级别设为 RC 以减少锁冲突，RC 与 RR 的加锁行为差别很大：

| 对比项 | RR | RC |
|------|------|------|
| 间隙锁 | 当前读默认加 Next-Key Lock | 不加，只在外键检查和唯一键重复检查时使用 |
| 不满足条件的行 | 扫描到的记录都持有锁直到事务结束 | 评估完 WHERE 后立即释放不匹配行的锁 |
| UPDATE 遇到被锁的行 | 等待 | 半一致读（semi-consistent read）：先读最新已提交版本判断是否匹配，不匹配就跳过 |
| 幻读 | 当前读基本避免 | 可能出现 |
| binlog 格式 | 任意 | 只支持基于行的记录：STATEMENT 不可用，MIXED 会自动按 ROW 记录 |

8.4 默认 `binlog_format=ROW`（且该变量已标记为弃用），所以 RC + ROW 是常见且安全的组合，代价是业务要接受不可重复读和幻读。

### 6、死锁

**死锁是两个及以上事务互相等待对方持有的锁**，单纯的锁等待不是死锁。下面两个例子都能稳定复现。

**例一：加锁顺序相反**

![死锁场景：两事务交叉持有锁](../../assets/mysql/mysql-deadlock.svg)

| 步骤 | 事务 A | 事务 B |
|:--:|------|------|
| 1 | `UPDATE t SET v = v + 1 WHERE id = 5;` 持有 id=5 | |
| 2 | | `UPDATE t SET v = v + 1 WHERE id = 10;` 持有 id=10 |
| 3 | `UPDATE t SET v = v + 1 WHERE id = 10;` 等待 B | |
| 4 | | `UPDATE t SET v = v + 1 WHERE id = 5;` 形成环，死锁 |

**例二：间隙锁 + 插入（「先查不存在再插入」）**

| 步骤 | 事务 A | 事务 B |
|:--:|------|------|
| 1 | `SELECT * FROM t WHERE id = 12 FOR UPDATE;` 0 行，持有 Gap (10, 15) | |
| 2 | | `SELECT * FROM t WHERE id = 13 FOR UPDATE;` 0 行，也持有 Gap (10, 15)（间隙锁互相兼容） |
| 3 | `INSERT INTO t VALUES (12, 12, 0);` 插入意向锁被 B 的间隙锁阻塞 | |
| 4 | | `INSERT INTO t VALUES (13, 13, 0);` 插入意向锁被 A 的间隙锁阻塞，死锁 |

这是 RR 下最常见的死锁：两个请求并发执行「查一下不存在就插入」。另一种常见形态是多个会话插入同一个唯一键：重复键错误会让等待方在该记录上加 S 锁，前一个事务回滚后，几个持有 S 锁的事务都想升级为 X 锁，互相死锁。

**InnoDB 的处理**：

- `innodb_deadlock_detect` 默认开启，发现等待环后立即选一个事务回滚，返回 `ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction`
- 回滚的是「较小」的事务，大小按插入、更新、删除的行数衡量
- 极高并发下可关闭死锁检测以节省 CPU，此时只能靠 `innodb_lock_wait_timeout`（默认 50 秒）超时，返回 `ERROR 1205`；锁等待超时默认只回滚当前语句，不回滚整个事务

**预防建议**：

1. 所有事务按**相同顺序**访问和加锁（如按主键升序批量更新）
2. 拆小大事务，缩短持锁时间
3. WHERE 条件走合适索引，避免扫描并锁住大量记录
4. 不要用「`SELECT ... FOR UPDATE` 查一个不存在的行，再 INSERT」实现幂等或防重；改为依赖唯一键直接插入，用 `INSERT ... ON DUPLICATE KEY UPDATE` 或捕获重复键异常处理，或在 RC 下执行（不加间隙锁）
5. 应用层对 1213 做有限次重试：死锁的事务已被整体回滚，重试整个事务而不是单条语句

### 7、锁等待与死锁诊断

8.0 起 `information_schema.innodb_locks` / `innodb_lock_waits` 已移除，改用 performance_schema 与 sys：

```sql
-- 当前谁在等谁：等待方、阻塞方的连接 ID、SQL 和等待时长，并给出 KILL 语句
SELECT wait_age, locked_table, locked_index, locked_type,
       waiting_pid, waiting_query,
       blocking_pid, blocking_query, sql_kill_blocking_connection
FROM sys.innodb_lock_waits;

-- 所有锁明细与锁等待关系
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;

-- 最近一次死锁的详细信息：看 LATEST DETECTED DEADLOCK 段
SHOW ENGINE INNODB STATUS;
```

`SHOW ENGINE INNODB STATUS` 只保留最近一次死锁。线上建议开启 `innodb_print_all_deadlocks=ON`，把每次死锁都写入错误日志，便于事后统计。阻塞方 `blocking_query` 常为 NULL，说明它的语句已执行完、事务还没提交，要回到应用代码里找没提交的事务。

---

## 六、长事务

### 1、危害

- **undo 无法清理**：只要有更老的 Read View 存在，purge 就不能清理它可能需要的旧版本，undo 表空间持续膨胀，版本链变长又拖慢快照读
- **锁持有时间长**：阻塞其他事务，放大死锁概率
- **阻塞 DDL**：事务持有表的 MDL 读锁直到结束，DDL 申请 MDL 写锁被卡住，其后所有对该表的查询都排队，见 [MySQL 避坑指南](./3_fallible_point) 的大表 DDL 一节
- **复制延迟**：大事务的 binlog 在提交时一次性写入并传输，从库也要整体重放

### 2、排查

```sql
-- 运行超过 60 秒的事务及其连接（trx_started 越早越危险）
SELECT t.trx_id, t.trx_state, t.trx_started,
       TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS duration_sec,
       t.trx_rows_locked, t.trx_rows_modified,
       p.ID AS conn_id, p.USER, p.HOST, p.COMMAND, p.INFO
FROM information_schema.innodb_trx t
JOIN performance_schema.processlist p ON p.ID = t.trx_mysql_thread_id
WHERE t.trx_started < NOW() - INTERVAL 60 SECOND
ORDER BY t.trx_started;

-- 确认来源后终止连接（事务会回滚，大事务回滚同样耗时）
KILL 12345;
```

**常见根因**：`autocommit=0` 后忘记提交、事务内做 RPC 或长循环、`@Transactional` 包了不该包的慢逻辑（文件上传、外部接口调用）。

> **实践守则**：事务内只做数据库操作，控制在毫秒到百毫秒级；监控 `innodb_trx` 中超过 N 秒的事务和 `Innodb_history_list_length`（未清理的 undo 历史长度），超阈值告警。

---

## 小结

- 原子性靠 undo，持久性靠 redo + 两阶段提交，隔离性靠 MVCC + 锁
- 快照读读 Read View 决定的历史版本、不加锁；当前读读最新版本并加锁，二者混用时 RR 也会看到新行
- RC 每次快照读新建 Read View，RR 在第一次快照读时创建并复用；`WITH CONSISTENT SNAPSHOT` 可立即创建
- RR 当前读以 Next-Key Lock 为单位、扫描到的记录都加锁；唯一索引等值命中退化为 Record Lock，非唯一索引等值还会锁到下一条记录前的间隙
- RC 不加间隙锁、提前释放不匹配行的锁，binlog 只能按行记录
- 间隙锁互相兼容但阻塞插入意向锁，「先 FOR UPDATE 查不存在再插入」是经典死锁；用唯一键 + `ON DUPLICATE KEY UPDATE` 替代
- 锁等待看 `sys.innodb_lock_waits` 和 `performance_schema.data_locks`，死锁看 `SHOW ENGINE INNODB STATUS` 并开启 `innodb_print_all_deadlocks`
- 8.0.30+ redo 位于 `#innodb_redo`、容量由 `innodb_redo_log_capacity` 控制；undo 默认在独立的 `undo_001` / `undo_002`
- 两阶段提交：执行时只写 log buffer 和 binlog cache，COMMIT 时 prepare → flush → sync → commit；恢复时以 binlog 中是否有 XID 决定提交或回滚

## 参考资料

- Transaction Isolation Levels：[https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- Consistent Nonlocking Reads：[https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)
- InnoDB Multi-Versioning：[https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)
- InnoDB Locking：[https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- Locks Set by Different SQL Statements in InnoDB：[https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- Deadlocks in InnoDB：[https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
- The data_locks Table：[https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- The innodb_lock_waits View：[https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html](https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html)
- Redo Log：[https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- Undo Tablespaces：[https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-tablespaces.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-tablespaces.html)
- The Binary Log（含 sync_binlog 与崩溃恢复）：[https://dev.mysql.com/doc/refman/8.4/en/binary-log.html](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)

> 下一篇：[SQL 执行流程](./6_topic_execution) —— 一条 SELECT / UPDATE 从连接器到存储引擎的完整路径，以及各组件的职责与常见问题。

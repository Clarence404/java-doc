# MySQL 专项 - 事务、MVCC 与锁

## 一、事务 ACID

| 特性 | 含义 | InnoDB 实现手段 |
|------|------|----------------|
| **原子性** (Atomicity) | 事务要么全成功，要么全回滚 | undo log |
| **一致性** (Consistency) | 事务前后数据库满足约束、逻辑一致 | 由其他三者共同保障 |
| **隔离性** (Isolation) | 并发事务之间互不干扰 | MVCC + 锁 |
| **持久性** (Durability) | 提交后数据永久保存，不因宕机丢失 | redo log（WAL） |

---

## 二、并发问题与隔离级别

### 三种并发读问题

| 问题 | 描述 | 触发条件 |
|------|------|---------|
| **脏读** | 读到另一事务**未提交**的数据 | 事务 B 修改未提交，事务 A 就读到了 |
| **不可重复读** | 同一事务内两次读**同一行**结果不同 | 事务 B 修改并提交，事务 A 两次读之间结果变了 |
| **幻读** | 同一事务内两次**范围查询**行数不同 | 事务 B 插入新行并提交，事务 A 范围查询多出了几行 |

### 四种隔离级别

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | 性能 |
|----------|:----:|:---------:|:----:|------|
| READ UNCOMMITTED | ❌ | ❌ | ❌ | 最高 |
| **READ COMMITTED（RC）** | ✅ | ❌ | ❌ | 较高 |
| **REPEATABLE READ（RR）** | ✅ | ✅ | ⚠️ | 中（默认） |
| SERIALIZABLE | ✅ | ✅ | ✅ | 最低 |

> MySQL 默认 **RR**。RR 下 MVCC 解决了快照读的幻读；当前读（`SELECT FOR UPDATE`）依靠 Next-Key Lock 防幻读。

---

## 三、undo log & redo log

### undo log（回滚日志）

- **作用**：原子性（回滚）+ MVCC 版本链
- **内容**：逻辑逆操作
  - INSERT 对应 DELETE
  - DELETE 对应 INSERT
  - UPDATE 对应原值记录
- **存储**：InnoDB 系统表空间或独立 undo 表空间

### redo log（重做日志）

- **作用**：持久性，防止宕机后已提交数据丢失
- **原理**：WAL（Write-Ahead Logging）—— 先顺序写 redo log，再异步刷脏页
  - 顺序 I/O（redo log append）比随机 I/O（直接写数据页）快得多
- **组成**：`ib_logfile0` / `ib_logfile1`，循环写

### 两阶段提交（redo log + binlog 一致性）

```
① 写 redo log（prepare 状态）
② 写 binlog
③ redo log 标记 commit
```

崩溃恢复规则：
- redo log prepare + binlog 完整 → 提交
- redo log prepare + binlog 不完整 → 回滚

---

## 四、MVCC（多版本并发控制）

MVCC 让**读操作不加锁**，通过版本链实现读写并发。

### 行的隐式字段

InnoDB 每行记录隐式携带：

| 字段 | 说明 |
|------|------|
| `trx_id` | 最近一次修改此行的事务 ID |
| `roll_pointer` | 指向 undo log 中的上一个版本 |

### 版本链

每次 UPDATE 不直接覆盖原行，而是写入新版本，旧版本通过 `roll_pointer` 串联：

```
当前行 [trx_id=100] → undo版本[trx_id=80] → undo版本[trx_id=60] → ...
```

### Read View（快照）

事务执行**快照读**时生成 Read View，包含四个字段：

| 字段 | 含义 |
|------|------|
| `m_ids` | 生成 Read View 时，当前**活跃（未提交）**的事务 ID 列表 |
| `min_trx_id` | `m_ids` 中的最小值 |
| `max_trx_id` | 生成 Read View 时下一个待分配的事务 ID（即 **当前最大 + 1**） |
| `creator_trx_id` | 创建此 Read View 的事务自身 ID |

### 可见性判断规则

遍历版本链，对每个版本的 `trx_id` 判断：

```
if trx_id == creator_trx_id        → 可见（自己改的）
elif trx_id < min_trx_id           → 可见（Read View 生成前已提交）
elif trx_id >= max_trx_id          → 不可见（Read View 生成后才开始）
elif trx_id in m_ids               → 不可见（生成时还未提交）
else                               → 可见（已提交的并发事务）
```

找不到可见版本则继续沿链向前，直到找到或链尾（返回空）。

### RC vs RR 的本质差异

| 隔离级别 | Read View 生成时机 | 结果 |
|----------|-------------------|------|
| READ COMMITTED | **每次快照读都重新生成** | 能看到其他事务最新提交的数据，存在不可重复读 |
| REPEATABLE READ | **只在第一次快照读时生成，后续复用同一个** | 整个事务看到固定快照，实现可重复读 |

---

## 五、锁

### 共享锁 vs 排他锁

| 锁类型 | 符号 | 兼容关系 | 加锁方式 |
|--------|------|---------|---------|
| 共享锁（S Lock） | S | S 与 S 兼容 | `SELECT ... LOCK IN SHARE MODE` |
| 排他锁（X Lock） | X | 与 S、X 均不兼容 | `SELECT ... FOR UPDATE` / DML |

### 意向锁（Intention Lock）

**表级锁**，事务在加行锁前先在表上加意向锁，让其他事务能快速判断"表中是否有行锁"。

- **IS**（意向共享锁）：加行级 S 锁前先加 IS
- **IX**（意向排他锁）：加行级 X 锁前先加 IX
- 意向锁之间完全兼容，只与**表级** S/X 锁冲突

### 行锁的三种形态

| 锁名 | 锁定范围 | 作用 |
|------|---------|------|
| **Record Lock** | 单条索引记录 | 锁住具体一行 |
| **Gap Lock** | 两条索引记录**之间**的间隙（不含记录本身） | 阻止在间隙内插入，防幻读 |
| **Next-Key Lock** | Gap Lock + Record Lock（左开右闭区间） | RR 级别默认行锁形态 |

```
假设索引值为：10, 20, 30
Next-Key Lock 区间划分：
  (-∞, 10]   (10, 20]   (20, 30]   (30, +∞)
```

**退化规则**：
- 等值查询**命中**记录 → Next-Key Lock 退化为 Record Lock
- 等值查询**未命中**（查询值落在间隙中）→ 退化为 Gap Lock

### 加锁场景示例

```sql
-- RR 级别下，以下语句触发 Next-Key Lock
UPDATE order SET status = 1 WHERE id = 5;
-- id=5 存在：Record Lock(5)
-- id=5 不存在（假设索引有 1, 10）：Gap Lock(1, 10)

-- 范围查询加锁
SELECT * FROM order WHERE id > 10 AND id < 20 FOR UPDATE;
-- 锁住 (10, 20) 的间隙 + 记录本身
```

### 死锁

**产生场景**：两个事务互相持有对方需要的锁。

```
事务A: UPDATE t SET ... WHERE id = 1   ← 持有 id=1 的锁
事务B: UPDATE t SET ... WHERE id = 2   ← 持有 id=2 的锁
事务A: UPDATE t SET ... WHERE id = 2   ← 等待事务B
事务B: UPDATE t SET ... WHERE id = 1   ← 等待事务A  → 死锁
```

**InnoDB 处理**：后台自动检测死锁，选代价最小的事务回滚并抛出 `ERROR 1213: Deadlock found`。

**预防建议**：

1. 多表操作时，所有事务按**相同顺序**加锁（避免交叉依赖）
2. 拆小大事务，缩短锁的持有时间
3. WHERE 条件加合适索引（避免全表扫描锁住大量行）
4. 先查后更新改为 `SELECT ... FOR UPDATE` 一步完成（避免间隙扩大）

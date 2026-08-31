# PostgreSQL 专项 - MVCC 与 VACUUM

## 一、PG vs MySQL MVCC 原理对比

MySQL 和 PostgreSQL 都实现了 MVCC，但底层机制**完全不同**：

| 维度 | MySQL InnoDB | PostgreSQL |
|------|-------------|------------|
| 旧版本存储位置 | 独立 undo log 段 | 直接留在**堆表**中 |
| 行修改方式 | 原地修改 + undo log 记录逆操作 | 写入新版本行，旧版本保留 |
| 旧版本清理 | 事务提交后 purge 线程清理 | 需要 **VACUUM** 主动清理 |
| 读一致性 | 通过 Read View + undo 链重建历史版本 | 通过行的 xmin/xmax 字段判断可见性 |
| 版本链长度影响 | 长事务导致 undo log 膨胀 | 长事务导致堆表死元组堆积 |

---

## 二、Tuple 结构与可见性

### 行头隐式字段

PG 每一行（Tuple）都隐式携带系统字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `xmin` | TransactionId | **插入**此行的事务 ID |
| `xmax` | TransactionId | **删除/更新**此行的事务 ID（未删除时为 0） |
| `ctid` | TID | 行的物理位置（块号 + 行号），UPDATE 后指向新版本 |
| `cmin/cmax` | CommandId | 事务内的命令序号（处理同一事务内多语句可见性） |

```sql
-- 查看行的系统字段
SELECT xmin, xmax, ctid, id, name FROM users WHERE id = 1;
```

### UPDATE 的实际行为

```
UPDATE users SET name = 'Bob' WHERE id = 1;

操作过程：
1. 旧行：xmin=100, xmax=0  → 更新后：xmin=100, xmax=200（标记删除）
2. 新行：xmin=200, xmax=0  → 插入到堆表（可能在不同物理位置）

结果：堆表中存在两个版本，旧行变为"死元组"（dead tuple）
```

### 可见性判断规则

读取行时，PG 根据当前事务的快照（snapshot）判断每个版本是否可见：

```
可见条件（满足其一）：
1. xmin 已提交 AND xmax 为 0（未被删除）
2. xmin 已提交 AND xmax 未提交（删除操作还没完成）
3. xmin 已提交 AND xmax 已提交 但 xmax > 当前快照（删除发生在快照之后）
```

---

## 三、Dead Tuple 与表膨胀

### 死元组的产生

每次 UPDATE 或 DELETE 都会产生死元组（dead tuple）：

```
初始：[row v1: xmin=1, xmax=0]

UPDATE 5 次后：
[row v1: xmin=1, xmax=2]  ← dead
[row v2: xmin=2, xmax=3]  ← dead
[row v3: xmin=3, xmax=4]  ← dead
[row v4: xmin=4, xmax=5]  ← dead
[row v5: xmin=5, xmax=0]  ← 当前有效版本
```

大量 UPDATE/DELETE 会导致：
- **表文件持续膨胀**（物理空间不释放，只是标记废弃）
- 顺序扫描需要跳过大量死元组，性能下降
- 索引也积累废弃指针

### 查看死元组数量

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 2) AS dead_ratio
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

---

## 四、VACUUM

### VACUUM vs VACUUM FULL

| 操作 | 作用 | 是否锁表 | 是否归还空间给 OS |
|------|------|---------|-----------------|
| `VACUUM` | 清理死元组，标记空间可复用 | ❌ 不锁表（并发执行） | ❌（空间留在表文件内部） |
| `VACUUM FULL` | 重写整张表，物理压缩 | ✅ 全表排他锁 | ✅ |
| `VACUUM ANALYZE` | VACUUM + 更新统计信息 | ❌ | ❌ |

```sql
-- 普通 VACUUM（生产环境常用，不锁表）
VACUUM users;

-- 顺带更新查询计划统计信息
VACUUM ANALYZE users;

-- 彻底压缩（会锁表，谨慎在业务低峰执行）
VACUUM FULL users;

-- 查看 VACUUM 进度（PG 9.6+）
SELECT * FROM pg_stat_progress_vacuum;
```

### AUTOVACUUM

PG 后台自动运行 VACUUM，关键参数：

```ini
# postgresql.conf

autovacuum = on                          # 开启（默认）
autovacuum_vacuum_threshold = 50         # 死元组数量基础阈值
autovacuum_vacuum_scale_factor = 0.2     # 超过表行数的 20% 触发
# 触发条件：dead_tuples > threshold + scale_factor * reltuples

autovacuum_analyze_threshold = 50
autovacuum_analyze_scale_factor = 0.1    # 修改超过 10% 触发 ANALYZE

autovacuum_vacuum_cost_delay = 2ms       # 每次清理的间隔（控制对 I/O 的影响）
```

**针对高频更新表单独调整**（在 DDL 中覆盖全局配置）：

```sql
ALTER TABLE hot_table SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- 1% 就触发，而不是默认 20%
  autovacuum_vacuum_cost_delay = 0          -- 不限速
);
```

---

## 五、XID Wraparound（事务 ID 回卷）

### 原理

PostgreSQL 使用 32 位无符号整数作为事务 ID（XID），最大值约 **42 亿**。

PG 使用**模运算**判断事务先后：当前 XID 的前 21 亿个视为"过去"，后 21 亿个视为"未来"。

当 XID 用尽后，下一个 XID 会从头开始（回卷），如果不处理，**旧行的 xmin 会被认为是"未来事务"，导致数据对所有查询不可见**。

### 危害

```
XID 接近上限时：
- PG 开始发出警告：WARNING: database "xxx" must be vacuumed within N transactions
- 到达 1000 万 XID 前：PG 拒绝所有写操作（自我保护），服务中断
```

### 应对措施

```sql
-- 查看各数据库距离 wraparound 的剩余 XID
SELECT datname,
       age(datfrozenxid) AS xid_age,
       2147483647 - age(datfrozenxid) AS remaining
FROM pg_database
ORDER BY xid_age DESC;

-- 查看各表的 relfrozenxid
SELECT relname, age(relfrozenxid) AS xid_age
FROM pg_class
WHERE relkind = 'r'
ORDER BY xid_age DESC
LIMIT 20;
```

**预防**：
1. 确保 AUTOVACUUM 正常运行，不要禁用
2. 避免超长事务（长事务会阻止 VACUUM 冻结旧版本）
3. 定期执行 `VACUUM FREEZE`（将 xmin 冻结为特殊值，不再参与回卷计算）

```sql
-- 手动冻结（紧急时使用）
VACUUM FREEZE users;
```

---

## 六、长事务的危害

```sql
-- 查找当前长事务
SELECT pid, usename, state, 
       now() - xact_start AS duration,
       query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY duration DESC;
```

长事务会：
1. **阻止 VACUUM 清理**：VACUUM 不能清理 xmax 大于最老活跃事务 XID 的死元组
2. **加剧表膨胀**：死元组堆积无法回收
3. **加速 XID 消耗**：长事务期间其他事务仍在消耗 XID

> **生产建议**：设置 `statement_timeout` 和 `idle_in_transaction_session_timeout` 限制长事务。

```sql
-- 设置空闲事务超时（全局或会话级）
SET idle_in_transaction_session_timeout = '10min';

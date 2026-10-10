---
description: 元组可见性、HOT 更新、RR 快照隔离与 SSI、表膨胀、VACUUM 与 autovacuum、XID 回卷、长事务
---

# MVCC 与 VACUUM

> 前置阅读：[MySQL 事务与锁](../1_mysql/5_topic_transaction)、[PostgreSQL 基础](./0_overview)

PostgreSQL 把旧版本元组留在堆表里实现 MVCC，本篇讲快照可见性判断、RR / SERIALIZABLE 与 InnoDB 的语义差别，以及 autovacuum 配置、表膨胀与 XID 回卷监控、阻止清理的长事务定位。

---

## 一、PG 与 InnoDB 的 MVCC 对比

两者都用多版本让读不阻塞写，但旧版本放在哪里完全不同：

| 维度 | MySQL InnoDB | PostgreSQL |
|------|-------------|------------|
| 修改方式 | 原地修改行，旧值写入 undo log | 不改旧行，插入一个新版本（元组） |
| 旧版本位置 | undo 表空间，通过 `roll_ptr` 串成版本链 | 和新版本一起留在堆表里 |
| 可见性判断 | Read View + 沿 undo 链回溯 | 元组头的 `xmin` / `xmax` + 事务快照 |
| 旧版本清理 | purge 线程清理不再需要的 undo | VACUUM 回收死元组；页内剪枝做局部清理 |
| 长事务的代价 | undo 无法 purge，undo 表空间膨胀 | 死元组无法回收，表和索引膨胀 |
| 索引 | 二级索引存主键，回表走聚簇索引 | 所有索引都存 `ctid`，直接指向堆中的元组 |

InnoDB 侧的 MVCC 细节见 [MySQL 事务与锁](../1_mysql/5_topic_transaction)，本篇不再重复。

---

## 二、元组头与可见性

### 1、元组头字段

每个元组（一行的一个版本）都带有系统字段，可以直接查询：

| 字段 | 含义 |
|------|------|
| `xmin` | 插入这个版本的事务 ID |
| `xmax` | 删除或更新这个版本的事务 ID，也可能是**加行锁**的事务 ID；为 0 表示从未被删除或锁定 |
| `cmin` / `cmax` | 同一事务内的命令序号，用来判断本事务前面语句做的修改对后面语句是否可见 |
| `ctid` | 这个元组自身的物理位置（页号, 行号） |

```sql
SELECT xmin, xmax, ctid, id, name FROM users WHERE id = 1;
```

几个容易误解的点：

- `xmax` 非 0 不代表行已删除。`SELECT ... FOR UPDATE / FOR SHARE` 会把加锁事务写进 `xmax`（并在 `t_infomask` 里标记“仅加锁”），删除事务回滚后 `xmax` 也会留着旧值，靠事务状态判断它是否生效
- `ctid` 是元组自己的位置，不是“指向新版本”的指针。指向新版本的是旧元组头里的 `t_ctid` 字段，它不能通过 SQL 查询到；最新版本的 `t_ctid` 指向自己
- 事务是否提交记录在 `pg_xact`（旧称 clog）里，第一次判断后会写回元组头的提示位（hint bits），之后不必再查

### 2、快照

READ COMMITTED 下每条语句、REPEATABLE READ 下事务的第一条语句会取一个快照，可以用 `SELECT pg_current_snapshot();` 查看，格式为 `xmin:xmax:xip_list`：

| 快照字段 | 含义 |
|---------|------|
| `xmin` | 取快照时仍在运行的最老事务 ID，小于它的事务都已结束 |
| `xmax` | 取快照时尚未分配的第一个事务 ID，大于等于它的事务对快照来说都在“未来” |
| `xip_list` | 介于两者之间、取快照时仍在运行的事务 ID |

一个事务对快照“已生效”，当且仅当它已提交，且 ID 小于快照 `xmax`、不在 `xip_list` 中。

### 3、可见性规则

对照 `HeapTupleSatisfiesMVCC`，一个元组对当前快照可见，需要同时满足两个条件：

**条件一：插入已生效**，满足其一即可：

- `xmin` 是当前事务自己，且插入它的命令早于当前命令（`cmin` 小于当前命令号）
- `xmin` 已提交，且对快照已生效（小于快照 `xmax`、不在 `xip_list` 中）；冻结过的元组直接视为已生效

**条件二：删除未生效**，满足其一即可：

- `xmax` 为 0
- `xmax` 只是加行锁，没有删除或更新
- `xmax` 对应的事务已回滚
- `xmax` 是其他事务且对快照未生效（仍在运行，或在快照之后才提交）
- `xmax` 是当前事务自己，但删除它的命令晚于当前命令（`cmax` 不小于当前命令号）

`xmin` 回滚、`xmin` 在快照时仍在运行的元组一律不可见。

### 4、UPDATE 与 HOT 更新

UPDATE 等于“把旧版本的 `xmax` 设为当前事务 + 插入新版本”。新版本放在哪里决定了代价：

![UPDATE 产生新版本：非 HOT 与 HOT](../../assets/database/pg-tuple-update.svg)

- **非 HOT 更新**：新版本可能落在别的页，表上**每一个**索引都要插入一条指向新 `ctid` 的条目，哪怕被修改的列与这些索引无关。这就是 PG 写放大和索引膨胀的主要来源
- **HOT 更新**（Heap-Only Tuple）：没有修改任何被索引的列，且旧版本所在页有足够空闲空间时，新版本写在同一页，旧元组标记为 HOT_UPDATED，索引条目不变，查询时从索引指向的旧元组沿页内 HOT 链找到可见版本。16 起只出现在 BRIN 等摘要型索引中的列被修改时，也不会阻止 HOT

HOT 链上的死版本不必等 VACUUM：后续访问该页且空间紧张时，会触发**页内剪枝**（page pruning），把死版本回收为页内可用空间。

提高 HOT 比例的手段：

```sql
-- 更新频繁的表预留页内空间，默认 fillfactor 为 100
ALTER TABLE orders SET (fillfactor = 85);   -- 只影响之后写入的页，存量页需重写

-- 观察 HOT 比例
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(n_tup_hot_upd * 100.0 / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 20;
```

此外，少建不必要的索引、避免在频繁更新的列（如 `updated_at`、计数器）上建索引，HOT 比例会明显提高。

---

## 三、隔离级别：写给 MySQL 用户

PG 支持标准的四个隔离级别名，但 READ UNCOMMITTED 实际按 READ COMMITTED 执行，默认是 READ COMMITTED。

| 场景 | MySQL InnoDB RR | PostgreSQL RR |
|------|----------------|---------------|
| 普通 SELECT | 事务级快照 | 事务级快照 |
| 幻读 | 快照读无幻读；当前读靠 Next-Key Lock / Gap Lock 阻止插入 | 快照隔离本身无幻读，没有间隙锁 |
| UPDATE 一行，该行已被并发事务修改并提交 | 当前读拿最新版本继续更新 | 报错 `could not serialize access due to concurrent update`（SQLSTATE 40001） |
| 写偏斜（两个事务读同一批行、各改不同的行） | 可能发生，需 `FOR UPDATE` | 可能发生，需 `FOR UPDATE` 或 SERIALIZABLE |

要点：

- PG 的 RR 是**快照隔离**（Snapshot Isolation）。读到的数据和写的前提都基于事务开始时的快照，一旦要修改的行在快照之后被别人改过，PG 不会像 InnoDB 那样“读最新再改”，而是让当前事务失败，**由应用重试整个事务**
- READ COMMITTED 下遇到同样情况，PG 会等对方提交后在新版本上重新检查 WHERE 条件再更新，不会报错，这也是它适合作为默认级别的原因
- SERIALIZABLE 用 **SSI**（Serializable Snapshot Isolation）实现：在快照隔离基础上用谓词锁（`SIReadLock`，只记录读依赖、不阻塞）跟踪读写依赖，检测到可能破坏串行化的结构时让其中一个事务以 40001 失败。InnoDB 的 SERIALIZABLE 则是把普通 SELECT 变成加共享锁的读，靠阻塞实现
- 行锁信息存在元组的 `xmax` 里而不是内存锁表，所以锁多少行都不会“锁升级”，但加锁会弄脏数据页、产生 WAL；多个事务同时持有共享锁时使用 MultiXact

Java 侧的处理：RR 或 SERIALIZABLE 下要捕获 SQLSTATE `40001`（死锁是 `40P01`）并重试整个事务。Spring 会把它翻译为 `ConcurrencyFailureException` 的子类，可以在事务方法外层用重试机制包裹，事务传播与回滚规则见 [事务管理](/spring/4_transaction)。

PG 没有聚簇索引，表数据存在无序的堆里，所有索引都直接指向 `ctid`，这一点对索引设计的影响见 [PostgreSQL 索引类型](./3_topic_index)。

---

## 四、死元组与表膨胀

每次 UPDATE 或 DELETE 都会留下对所有快照都不再可见的死元组。例如对一行执行 4 次 UPDATE（事务 101～104）后，堆里有 5 个版本：

| 版本 | xmin | xmax | 状态 |
|------|------|------|------|
| v1 | 100 | 101 | 死元组 |
| v2 | 101 | 102 | 死元组 |
| v3 | 102 | 103 | 死元组 |
| v4 | 103 | 104 | 死元组 |
| v5 | 104 | 0 | 当前版本 |

（XID 0～2 是保留值，普通事务 ID 从 3 开始。）死元组在被回收前：

- 占用表文件空间，顺序扫描要读更多页
- 非 HOT 更新时索引中也积累指向死元组的条目
- 回收后的空间可被复用，但普通 VACUUM 不会把文件缩小（末尾整页为空时除外），所以膨胀一旦发生就很难消退

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

精确的膨胀率可以用 `pgstattuple` 扩展测量。

---

## 五、VACUUM

### 1、普通 VACUUM 做了什么

- 删除堆和索引中的死元组，空间登记到空闲空间映射（FSM）供后续插入复用
- 更新可见性映射（VM），标记“全部可见”的页，Index Only Scan 和后续 VACUUM 都依赖它
- 冻结足够老的元组，推进 `relfrozenxid`（见第六节）
- 表末尾的页全部为空时，短暂获取排他锁截断文件，把这部分空间还给操作系统

普通 VACUUM 持有 `SHARE UPDATE EXCLUSIVE` 锁：不阻塞 SELECT / INSERT / UPDATE / DELETE，但与 DDL、另一个 VACUUM、`ANALYZE`、`CREATE INDEX CONCURRENTLY` 互斥。

```sql
VACUUM orders;
VACUUM (ANALYZE, VERBOSE) orders;

-- 进度
SELECT * FROM pg_stat_progress_vacuum;
```

### 2、VACUUM FULL 与在线替代

| 操作 | 锁 | 效果 | 代价 |
|------|----|------|------|
| `VACUUM` | `SHARE UPDATE EXCLUSIVE`，不阻塞读写 | 回收空间供复用，一般不缩小文件 | 产生 IO |
| `VACUUM FULL` | `ACCESS EXCLUSIVE`，读写全部阻塞 | 重写整表与索引，归还空间 | 需要额外一份表大小的磁盘空间，大表耗时长 |
| `pg_repack` / `pg_squeeze`（扩展） | 只在开始和结束时短暂加强锁 | 在线重建表，效果同 VACUUM FULL | 同样需要额外空间，需要主键或唯一键 |

生产环境处理已经膨胀的大表，优先用 `pg_repack` 一类扩展，`VACUUM FULL` 只在可停服的窗口使用。

### 3、autovacuum

autovacuum 守护进程每隔 `autovacuum_naptime`（默认 1 分钟）检查各表，满足阈值就启动 worker：

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `autovacuum_vacuum_threshold` / `autovacuum_vacuum_scale_factor` | 50 / 0.2 | 死元组数超过 `50 + 0.2 × 表行数` 触发 VACUUM |
| `autovacuum_vacuum_max_threshold`（18+） | 1 亿 | 上述阈值的上限，避免十亿行大表要积累 2 亿死元组才触发 |
| `autovacuum_vacuum_insert_threshold` / `..._insert_scale_factor`（13+） | 1000 / 0.2 | 只插入不更新的表按插入量触发，及时冻结并更新可见性映射 |
| `autovacuum_analyze_threshold` / `..._scale_factor` | 50 / 0.1 | 变化行数超过阈值触发 ANALYZE |
| `autovacuum_max_workers` | 3 | 同时运行的 worker 数 |
| `autovacuum_vacuum_cost_limit` | -1（沿用 `vacuum_cost_limit` = 200） | 累计 IO 代价达到该值就休眠一次，所有 worker 共享这一额度 |
| `autovacuum_vacuum_cost_delay` | 2ms（12 起；之前为 20ms） | 每次达到代价上限后的休眠时长 |
| `autovacuum_freeze_max_age` | 2 亿 | 表的 `age(relfrozenxid)` 超过它，无论是否有死元组都强制启动防回卷 VACUUM |

更新频繁的大表可以单独调整：

```sql
ALTER TABLE hot_table SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- 1% 死元组就触发
  autovacuum_vacuum_cost_delay   = 0       -- 这张表不限速
);
```

不要关闭 autovacuum。它跟不上时，常见手段是调高 `autovacuum_vacuum_cost_limit`、增加 worker 数、对热点表单独降低 scale factor。

---

## 六、冻结与 XID 回卷

### 1、为什么需要冻结

事务 ID 是 32 位，比较新旧用的是模 2³² 的环形比较：对任意一个 XID，前面约 21 亿个算“过去”，后面约 21 亿个算“未来”。如果一个元组的 `xmin` 太老，超过 21 亿个事务之后它会突然变成“未来”的事务，数据对所有查询消失。

**冻结**就是把足够老的元组标记为“对所有事务都可见”。9.4 起冻结只在 `t_infomask` 中设置 `HEAP_XMIN_FROZEN` 标志位，原始 `xmin` 保留（便于排查）；9.4 之前是把 `xmin` 改写为特殊值 `FrozenTransactionId`（2）。每张表的 `relfrozenxid` 记录表中未冻结元组的最老 XID，每个库的 `datfrozenxid` 是库内所有表的最小值。

### 2、保护阈值

![age(relfrozenxid) 增长时的保护阈值](../../assets/database/pg-xid-wraparound.svg)

| 阶段 | 触发点（默认值） | 行为 |
|------|----------------|------|
| 防回卷 autovacuum | `age(relfrozenxid)` 超过 `autovacuum_freeze_max_age`（2 亿） | 即使关闭了 autovacuum 也会对该表启动，且不会因锁冲突自动让步 |
| failsafe（14+） | 超过 `vacuum_failsafe_age`（16 亿） | VACUUM 取消代价限速、跳过索引清理，全力推进冻结 |
| 告警 | 距回卷剩余 4000 万个 XID | 日志与客户端出现 `WARNING: database "mydb" must be vacuumed within N transactions` |
| 停止分配 XID | 距回卷剩余 300 万个 XID | 报错 `database is not accepting commands that assign new transaction IDs`，所有写入失败，只读查询仍可执行 |

上表告警和停写阈值是 14 起的值（之前约为剩余 1100 万和 100 万）。MultiXact ID 也有同样的回卷问题，对应 `autovacuum_multixact_freeze_max_age`（默认 4 亿）。

### 3、监控与处置

```sql
-- 各库距离强制防回卷 VACUUM 还有多远
SELECT datname, age(datfrozenxid) AS xid_age,
       current_setting('autovacuum_freeze_max_age')::int - age(datfrozenxid) AS to_forced_vacuum
FROM pg_database
ORDER BY xid_age DESC;

-- 最老的表：包含 TOAST 表与物化视图，它们常常是最老的
SELECT c.oid::regclass AS rel, c.relkind, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
WHERE c.relkind IN ('r', 't', 'm')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;
```

`age` 持续逼近 2 亿以上且不下降，说明冻结推进不动，几乎总是第七节列出的某个因素卡住了清理边界。处置顺序：先找到并解除这个因素（结束长事务、提交或回滚遗留的两阶段事务、删除废弃的复制槽），再对最老的表执行 `VACUUM`（必要时 `VACUUM (FREEZE, VERBOSE)`）。停止分配 XID 后同样在正常模式下执行 VACUUM 即可，官方文档已不建议进入单用户模式；此时不要用 `VACUUM FULL`，它比普通 VACUUM 慢得多。

---

## 七、长事务与清理边界

VACUUM 只能回收对**所有**可能存在的快照都不可见的死元组，这个边界（xmin horizon）取以下各项中最老的：

- 各会话的 `backend_xmin`：任何持有快照的事务，包括只读事务和 `idle in transaction` 的连接
- 复制槽的 `xmin` / `catalog_xmin`：逻辑复制槽、长期不消费的 CDC 槽
- 备库开启 `hot_standby_feedback` 后反馈回来的 xmin
- 未提交的两阶段事务（`PREPARE TRANSACTION`）

长事务不会让 XID 消耗得更快，问题在于它**让边界停住**：其他事务照常消耗 XID、产生死元组，但都无法回收和冻结，于是表持续膨胀，`age(relfrozenxid)` 不断增长，最终逼近回卷阈值。

```sql
-- 持有旧快照的会话
SELECT pid, usename, state, backend_xmin, age(backend_xmin) AS xmin_age,
       now() - xact_start AS xact_duration, left(query, 80) AS query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 10;

-- 复制槽
SELECT slot_name, slot_type, active, xmin, catalog_xmin,
       age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots;

-- 遗留的两阶段事务
SELECT gid, prepared, owner, database, age(transaction) AS xid_age
FROM pg_prepared_xacts;
```

用超时参数给事务加上限，可以在库级、角色级或会话级设置：

| 参数 | 限制的对象 |
|------|-----------|
| `statement_timeout` | 单条语句执行时间，不限制事务中语句之间的空闲时间 |
| `idle_in_transaction_session_timeout` | 事务开启后处于空闲状态的时间，常见于忘记提交的连接 |
| `transaction_timeout`（17+） | 整个事务的总时长 |
| `idle_session_timeout`（14+） | 事务外空闲会话的时长，连接池场景慎用 |

```sql
ALTER ROLE app SET idle_in_transaction_session_timeout = '10min';
ALTER ROLE app SET transaction_timeout = '30min';   -- 17+
```

复制槽导致的 WAL 堆积与 `max_slot_wal_keep_size`、`idle_replication_slot_timeout` 见 [PostgreSQL 复制与高可用](./5_topic_replication)。

---

## 小结

- PG 的 UPDATE 是“标记旧版本 + 插入新版本”，旧版本留在堆表里，靠 VACUUM 回收
- 可见性 = `xmin` 对快照已生效 且 `xmax` 未生效；`xmax` 非 0 也可能只是行锁或已回滚的删除
- `ctid` 是元组自身位置，新旧版本由旧元组头的 `t_ctid` 串起；HOT 更新不改索引，是降低写放大的关键，配合 `fillfactor` 与精简索引
- PG 的 RR 是快照隔离，并发更新同一行直接报 40001，需要应用重试；SERIALIZABLE 是 SSI，不靠阻塞
- 普通 VACUUM 不阻塞 DML，但与 DDL 互斥；`VACUUM FULL` 锁全表，在线重建用 `pg_repack`
- autovacuum 默认 20% 死元组触发，18 增加了 1 亿的上限；大表与热点表单独调参，不要关闭
- 冻结在 9.4 起只设置标志位；14 起剩余 4000 万 XID 告警、300 万停止分配 XID，16 亿时进入 failsafe
- 清理边界由最老的快照、复制槽、备库反馈和两阶段事务决定；长事务不加速 XID 消耗，而是让冻结停滞

## 参考资料

- 并发控制：[https://www.postgresql.org/docs/18/mvcc.html](https://www.postgresql.org/docs/18/mvcc.html)
- 事务隔离：[https://www.postgresql.org/docs/18/transaction-iso.html](https://www.postgresql.org/docs/18/transaction-iso.html)
- 日常 VACUUM：[https://www.postgresql.org/docs/18/routine-vacuuming.html](https://www.postgresql.org/docs/18/routine-vacuuming.html)
- autovacuum 参数：[https://www.postgresql.org/docs/18/runtime-config-vacuum.html](https://www.postgresql.org/docs/18/runtime-config-vacuum.html)
- HOT 更新：[https://www.postgresql.org/docs/18/storage-hot.html](https://www.postgresql.org/docs/18/storage-hot.html)
- 系统列：[https://www.postgresql.org/docs/18/ddl-system-columns.html](https://www.postgresql.org/docs/18/ddl-system-columns.html)
- 论文 Serializable Snapshot Isolation in PostgreSQL：[https://arxiv.org/abs/1208.4179](https://arxiv.org/abs/1208.4179)

> 下一篇：[PostgreSQL 索引类型](./3_topic_index) —— 六种索引访问方法、部分 / 表达式 / 覆盖索引、Index Only Scan 与在线建索引。

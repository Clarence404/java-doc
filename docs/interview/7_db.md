---
description: 事务、索引、锁、InnoDB、SQL 优化、主从、PostgreSQL、分库分表、NoSQL、连接池与 CDC
---

# 数据库面试题解答

> 精华提炼，细节详见 [数据库总览](/database/0_overview)；题目清单见 [数据库面试题](/database/99_interview)，本页按清单的分组与顺序作答。
> 版本基线：MySQL 8.4 LTS（8.0 已于 2026 年 4 月停止维护，9.7 LTS 的差异单独标注）、PostgreSQL 18（兼顾 17）、TiDB 8.5、MongoDB 8.x、Elasticsearch 9 / OpenSearch 3、ShardingSphere 5.5.x、HikariCP 7.x、Debezium 3.x。缓存一致性、分布式事务与系统级分库分表策略只简述并链接到 [缓存面试题解答](/interview/8_cache)、[分布式面试题解答](/interview/10_distributed)、[高并发面试题解答](/interview/13_high_con)。

## 一、事务与隔离级别

### Q1：MySQL 有哪四种隔离级别？各自能解决什么问题？默认是哪一种？

**核心结论**：从低到高是 READ UNCOMMITTED、READ COMMITTED、REPEATABLE READ、SERIALIZABLE，每升一级多防一种并发读问题。InnoDB 默认 **REPEATABLE READ**；Oracle、PostgreSQL、SQL Server 默认都是 READ COMMITTED。

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | InnoDB 实现 |
|---------|:---:|:---------:|:---:|------------|
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 直接读最新版本 |
| READ COMMITTED（RC） | 避免 | 可能 | 可能 | 每次快照读新建 Read View；基本不加间隙锁 |
| REPEATABLE READ（RR，默认） | 避免 | 避免 | 基本避免（见 Q3） | 事务内复用一个 Read View；当前读加 Next-Key Lock |
| SERIALIZABLE | 避免 | 避免 | 避免 | 关闭 autocommit 时普通 SELECT 隐式变为 `FOR SHARE`，靠行级锁阻塞，不是表锁 |

- 不少团队把 MySQL 设为 RC：间隙锁少、死锁少，代价是接受不可重复读，且 binlog 必须是 ROW（8.4 默认即 ROW）
- Oracle 与 PostgreSQL 的 RC 基于 MVCC 快照；SQL Server 默认的 RC 是加锁读，开启 `READ_COMMITTED_SNAPSHOT` 后才是快照读
- 查看与设置：`SELECT @@transaction_isolation;`、`SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_2、四种隔离级别)

### Q2：脏读、不可重复读、幻读的区别？

**核心结论**：三者都是同一事务内读到了其他事务造成的变化，区别在变化的来源和对象：**脏读**读到的是别人**未提交**的修改；**不可重复读**是**同一行**在两次读之间被别人修改（或删除）并提交，读到的值变了；**幻读**是同一个**范围条件**两次查询之间，别人插入了满足条件的行并提交，结果集多出了行。

| 问题 | 变化来源 | 关注对象 | 示例 | 能避免它的最低级别 |
|------|---------|---------|------|-----------------|
| 脏读 | 未提交的修改 | 某行的值 | B 把余额改为 0 未提交，A 读到 0，B 随后回滚 | RC |
| 不可重复读 | 已提交的 UPDATE / DELETE | 已经读过的那一行 | A 两次读 id=1 的余额，中间 B 改成 50 并提交 | RR |
| 幻读 | 已提交的 INSERT（或让行进入范围的修改） | 满足条件的行集合 | A 两次查 `age > 18`，中间 B 插入一个 20 岁的用户 | SERIALIZABLE（InnoDB 的 RR 基本避免） |

- 分界在于：防不可重复读只需保护「已读到的行」，防幻读要保护「还不存在的行」，所以需要间隙锁（InnoDB）或谓词锁（PG 的 SSI）
- 写与写之间的冲突（丢失更新、写偏斜）不属于这三类，要靠当前读加锁、乐观锁版本号或 SERIALIZABLE

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_1、三种并发读问题)

### Q3：快照读和当前读有什么区别？RR 能在多大程度上避免幻读？

**核心结论**：普通 SELECT 是**快照读**，读 Read View 决定的历史版本，不加锁；`SELECT ... FOR UPDATE / FOR SHARE`、UPDATE、DELETE、INSERT 是**当前读**，读最新已提交版本并加锁。RR 下纯快照读靠复用的 Read View 不出现幻读，当前读靠 Next-Key Lock 阻止范围内插入；但**同一事务先快照读、再当前读**，仍会「看见」别人新插入的行。

```sql
-- RR，事务 A
SELECT * FROM t WHERE k = 5;        -- 快照读：0 行
-- 此时事务 B 插入 k=5 并提交
UPDATE t SET v = 1 WHERE k = 5;     -- 当前读：更新到了 B 插入的行
SELECT * FROM t WHERE k = 5;        -- 快照读：1 行（自己改过的行对自己可见）
```

- RR 只保证纯快照读序列可重复；「先检查再修改」的业务第一步就用 `SELECT ... FOR UPDATE`，或直接执行带条件的 UPDATE 并检查影响行数
- RC 下当前读不加间隙锁，幻读照常出现
- 8.0 起 `FOR SHARE` 取代 `LOCK IN SHARE MODE`，并支持 `NOWAIT`、`SKIP LOCKED`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_3、快照读与当前读)

### Q4：MVCC 的原理是什么？undo log 和 Read View 如何配合？RC 与 RR 有何不同？

**核心结论**：InnoDB 每行带隐藏列 `DB_TRX_ID`（最后修改它的事务）和 `DB_ROLL_PTR`（指向 undo log 中的上一版本），UPDATE 把旧值写入 undo，形成**版本链**。快照读时用 **Read View** 判断每个版本是否可见，不可见就沿 `DB_ROLL_PTR` 找上一个版本。RC 每次快照读都新建 Read View，RR 在事务第一次快照读时创建并一直复用。

Read View 记录创建时活跃的事务 ID 列表 `m_ids`、其最小值 `min_trx_id`、下一个待分配的事务 ID `max_trx_id` 和创建者 `creator_trx_id`：

| 版本的 `DB_TRX_ID` | 结论 |
|------------------|------|
| 等于 `creator_trx_id` | 可见：自己改的 |
| 小于 `min_trx_id` | 可见：创建 Read View 前已提交 |
| 大于等于 `max_trx_id` | 不可见：创建后才开始 |
| 在 `m_ids` 中 | 不可见：创建时还未提交 |
| 其余 | 可见：创建前已提交的并发事务 |

- `BEGIN` 本身不创建 Read View；要从事务开始就固定快照用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`，mysqldump `--single-transaction` 就是这样做的
- 长事务持有老的 Read View，purge 无法清理它可能需要的 undo，undo 膨胀、版本链变长；用 `information_schema.innodb_trx` 找出长事务，监控 `Innodb_history_list_length`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#三、mvcc-多版本并发控制)

### Q5：redo log、undo log、binlog 有什么区别？两阶段提交如何保证崩溃恢复一致？

**核心结论**：undo 负责回滚和 MVCC（原子性），redo 负责宕机后重放已提交但未刷盘的页修改（持久性，WAL），binlog 是 Server 层的逻辑日志，用于复制、时间点恢复和 CDC。redo 与 binlog 分属两层，InnoDB 以 binlog 为协调者做内部两阶段提交：**事务是否提交，以 binlog 中是否完整写入了它的 XID 为准**。

| 对比项 | undo log | redo log | binlog |
|--------|---------|----------|--------|
| 所属层 | InnoDB | InnoDB | Server 层 |
| 内容 | 逻辑逆操作 | 物理页修改 | 行变更（ROW） |
| 写法 | 随 DML 写 undo 页 | 循环写，checkpoint 后覆盖 | 追加写，写满切换文件 |
| 用途 | 回滚、MVCC | 崩溃恢复 | 复制、PITR、CDC |

COMMIT 时按 binlog 组提交执行：**Prepare**（InnoDB 标记 prepared 并记录 XID）→ **Flush**（redo 刷盘，binlog cache 写入 binlog 文件）→ **Sync**（按 `sync_binlog` fsync binlog）→ **Commit**（InnoDB 提交、释放锁）。崩溃恢复时，prepared 且 binlog 中有 XID 的事务提交，没有的回滚，于是主库恢复的数据和从库、备份回放出来的一致。

- 「双 1」：`innodb_flush_log_at_trx_commit=1`、`sync_binlog=1`（均为默认），组提交让一批事务共享 fsync；设为 2 时 mysqld 崩溃不丢、主机断电可能丢约 1 秒
- 8.0.30 起 redo 位于 `#innodb_redo` 目录，容量由 `innodb_redo_log_capacity` 控制；undo 默认在独立的 `undo_001` / `undo_002`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_4、两阶段提交与崩溃恢复)

## 二、索引

### Q6：InnoDB 为什么用 B+ 树？B 树真的不能做范围查询吗？三层 B+ 树能存多少行？

**核心结论**：B 树和 B+ 树都能做等值、范围、排序和 `LIKE 'x%'`，差别在**效率**：B+ 树非叶节点只存 key，扇出大、树更矮；数据只在叶子，叶子用双向链表串起来，范围扫描定位起点后顺序往后读即可，不必在层间回溯。

| 结构 | 不选它的原因 |
|------|-------------|
| 红黑树 / AVL | 二叉树，千万级数据树高二十多层，每层一次随机 IO |
| B 树 | 非叶节点也存数据，扇出小、树更高；范围扫描要中序遍历、上下回溯 |
| 哈希 | 只支持等值，不支持范围、排序和前缀匹配；InnoDB 只有引擎内部的自适应哈希索引（8.4 默认关闭） |

- 「三层约 2000 万行」的前提：16KB 页，`BIGINT` 主键 + 6 字节页指针约 14 字节，一页约 1170 个指针；叶子行约 1KB，一页约 16 行；1170 × 1170 × 16 ≈ 2190 万
- 行越宽这个数越小。它只说明点查只需 2～3 次页访问，不是分表阈值

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#一、b-树数据结构)

### Q7：聚簇索引和二级索引的区别？什么是回表和覆盖索引？

**核心结论**：InnoDB 的主键索引就是**聚簇索引**，叶子存整行；**二级索引**叶子存「索引列 + 主键值」。通过二级索引查非索引列时，要拿主键再查一次聚簇索引，这一步叫**回表**；查询需要的列全部能从二级索引上拿到（主键自动包含）时不必回表，就是**覆盖索引**。

| 对比项 | 聚簇索引 | 二级索引 |
|--------|---------|---------|
| 数量 | 每表一个 | 可以多个 |
| 叶子内容 | 整行数据 | 索引列 + 主键 |
| 来源 | 主键；没有则用第一个全 NOT NULL 的唯一索引；再没有则用隐藏的 `DB_ROW_ID` | 手工创建 |

- EXPLAIN 中 `Using index` 才是覆盖索引；`Using index condition` 是 ICP，仍要回表
- 前缀索引只存前 N 个字符，无法覆盖该列
- 主键越长，每个二级索引越大；回表命中行多时是大量随机 IO，是慢查询的常见原因
- PostgreSQL 没有聚簇索引，所有索引都指向堆中行的物理位置，见 Q31

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#三、聚簇索引与二级索引)

### Q8：联合索引的最左前缀原则是什么？范围条件之后的列完全用不上吗？

**核心结论**：联合索引 `(a, b, c)` 按 a、b、c 依次排序，只有从最左列开始**连续的等值条件**能用来定位扫描范围；遇到范围条件（`>`、`<`、`BETWEEN`、`LIKE 'x%'`）后，后面的列不再缩小扫描范围，但**仍可被 ICP 在引擎层过滤**，减少回表次数。

| 查询条件 | 用于定位的列 | 其余条件 |
|---------|------------|---------|
| `a = 1 AND b = 2 AND c = 3` | a、b、c | — |
| `a = 1 AND c = 3` | a | c 由 ICP 在索引上过滤 |
| `a = 1 AND b > 2 AND c = 3` | a、b | c 由 ICP 在索引上过滤 |
| `b = 2` | 一般无 | 8.0.13+ 满足条件时可用 Skip Scan |
| `a = 1 ORDER BY b` | a | 索引顺序直接满足排序，无 filesort |

- ICP（5.6+）把能用索引列判断的条件下推到存储引擎，只作用于二级索引，减少回表而不减少扫描的索引条目，EXPLAIN 显示 `Using index condition`
- Skip Scan 的条件：单表、无 GROUP BY / DISTINCT、查询只用到索引列、最左列不同值很少；EXPLAIN 显示 `Using index for skip scan`

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#六、最左前缀原则)

### Q9：索引失效的常见场景有哪些？

**核心结论**：「失效」分两类：一是**索引列被变换**（函数、运算、隐式转换、左模糊），B+ 树的有序性用不上，确实无法定位；二是**优化器按成本放弃**（OR 一侧无索引、`!=`、`NOT IN`、低区分度），索引能用，但它估算全表扫描更便宜。是否走索引由基于成本的优化器决定，不存在「命中超过 30% 就全表扫描」的固定阈值，一切以 `EXPLAIN` 为准。

| 场景 | 原因 | 一定用不上吗 | 改法 |
|------|------|-------------|------|
| 对列用函数或运算：`YEAR(create_time) = 2024` | 列值被变换 | 是 | 改为范围条件；8.0.13+ 建函数索引 |
| VARCHAR 列与数字比较：`phone = 13800138000` | 列被转成数字 | 是 | 类型一致；INT 列与字符串常量比较不受影响 |
| 关联列字符集或排序规则不一致 | 被转换的一侧用不上 | 是 | 统一 `utf8mb4` 与排序规则 |
| `LIKE '%abc'` | 前缀不确定 | 是 | `LIKE 'abc%'`；包含匹配用全文索引或 ES |
| OR 的一侧没有索引 | 该分支必须全表扫 | 是 | 补索引；两侧都有索引时可走 Index Merge（union） |
| `!=`、`NOT IN` | 可转为范围，命中多时回表太贵 | 否，按成本 | 改为正向条件，如 `status IN (0, 2)` |
| 跳过联合索引最左列 | 无法定位 | 否，可能 Skip Scan | 调整索引列顺序 |
| 低区分度：`status = 1` 命中半张表 | 回表成本高于全表扫描 | 否，按成本 | 与高区分度列组成联合索引，或做成覆盖查询 |

- 同一行两列比较（`WHERE a = b`）无法用索引定位，只能逐行过滤
- OR 手工改写要用 `UNION`，或 `UNION ALL` 加互斥条件；直接 `UNION ALL` 会把同时满足两个条件的行返回两次
- 排序方向混合（`ORDER BY a ASC, b DESC`）导致的是 filesort，不是 WHERE 用不了索引；8.0 起可建 `(a, b DESC)` 降序索引消除
- 统计信息不准导致选错索引的处理见 Q22

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#七、索引失效的常见场景)

### Q10：深度分页如何优化？

**核心结论**：`LIMIT 100000, 20` 要扫描并丢弃前 10 万行，`SELECT *` 时每一行还要回表。需要随机跳页用**延迟关联**：内层在覆盖索引上只取 id，外层只回表 20 行；「下一页」和批量导出用**游标翻页**：记住上一页最后一条的排序值和 id，耗时与页数无关。

```sql
-- 索引 idx_user_time(user_id, create_time)，叶子自带主键 id

-- 延迟关联：内层覆盖索引不回表，外层只回表 20 行
SELECT o.* FROM t_order o
JOIN (SELECT id FROM t_order WHERE user_id = 1001
      ORDER BY create_time DESC, id DESC LIMIT 100000, 20) tmp ON o.id = tmp.id
ORDER BY o.create_time DESC, o.id DESC;

-- 游标翻页：排序值可能重复，必须带上 id 组成复合游标
SELECT * FROM t_order
WHERE user_id = 1001 AND (create_time < ? OR (create_time = ? AND id < ?))
ORDER BY create_time DESC, id DESC LIMIT 20;
```

- 延迟关联仍要扫描 offset 行索引条目，只是不回表；游标翻页不支持随机跳页
- 产品层面限制最大页数；ES 的深分页见 Q42；应用侧的整体方案见 [高性能面试题解答](/interview/12_high_perf#q26-深分页为什么慢-有哪些优化方案-游标分页需要什么索引)

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#九、深度分页优化)

### Q11：如何设计合理的索引？唯一索引和普通索引怎么选？

**核心结论**：围绕高频查询建**联合索引**并尽量做成覆盖索引，等值列在前、范围列在后、兼顾 ORDER BY，控制单表索引数量。唯一性是业务约束，**该用唯一索引就用**：「普通索引写入更快」靠的是 Change Buffer，而 MySQL 8.4 默认已经关闭它（`innodb_change_buffering=none`，8.0 默认 `all`）。

- 该建：WHERE、JOIN ON、ORDER BY、GROUP BY 中的高频列；区分度高的列
- 慎建：低区分度列单独建索引；频繁更新的列；大字符串（用前缀索引或哈希冗余列）；索引过多（每个二级索引都是一棵要维护的树）
- 联合索引列顺序：等值列在前、范围列在后 → 区分度高的靠前 → `WHERE a = ? ORDER BY b` 建 `(a, b)`
- Change Buffer 只服务非唯一二级索引（唯一索引必须读页校验唯一性），只在写多读少、Buffer Pool 远小于数据量时有收益
- 删除索引前先设为不可见观察：`ALTER TABLE t ALTER INDEX idx INVISIBLE`；`sys.schema_unused_indexes` 找出未使用的索引

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#十、索引设计原则)

## 三、锁

### Q12：InnoDB 有哪些锁？Record Lock、Gap Lock、Next-Key Lock 的区别和加锁规则？

**核心结论**：表级有**意向锁**（IS / IX，加行锁前先加，让 `LOCK TABLES` 这类表级锁能快速判断冲突）；行级有共享锁 S 和排他锁 X，按锁定范围分为 Record、Gap、Next-Key 和插入意向锁。行锁加在**索引记录**上；RR 下当前读的基本单位是 Next-Key Lock，**扫描到的每条记录都加锁**，再按索引类型退化。

| 锁 | `data_locks` 中的 LOCK_MODE | 锁定范围 |
|----|---------------------------|---------|
| Record Lock | `X,REC_NOT_GAP` | 单条索引记录 |
| Gap Lock | `X,GAP` | 记录之前的开区间，只阻止插入 |
| Next-Key Lock | `X` | 间隙 + 记录本身，左开右闭 |
| 插入意向锁 | `X,GAP,INSERT_INTENTION` | INSERT 前在间隙上申请，被 Gap / Next-Key Lock 阻塞 |

RR 下的规则（表 `t` 主键 id、普通索引 k，已有 5、10、15、20 四行）：

| 语句 | 加锁结果 |
|------|---------|
| `WHERE id = 10 FOR UPDATE`：唯一索引等值命中 | 退化为 Record Lock，只锁 id=10 |
| `WHERE id = 12 FOR UPDATE`：唯一索引等值未命中 | Gap Lock (10, 15) |
| `WHERE k = 10 FOR UPDATE`：非唯一索引等值 | k 上 (5, 10] 与 (10, 15)，以及主键 id=10 的记录锁 |
| `WHERE id > 20 FOR UPDATE`：范围 | (20, supremum] |

- 兼容性：S 与 S 兼容，X 与任何锁冲突；间隙锁之间互相兼容，只与插入意向锁冲突
- 间隙锁防幻读：锁住记录之间的间隙后，其他事务无法在范围内插入，当前读两次结果一致
- RC 下不加间隙锁（外键检查和唯一键重复检查除外），不匹配的行评估后立即释放
- 实际加了哪些锁以 `performance_schema.data_locks` 的输出为准

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#五、锁)

### Q13：没走索引的 UPDATE 会锁住哪些行？

**核心结论**：InnoDB **不会把行锁升级为表锁**。但锁是加在扫描到的索引记录上的，条件列没有可用索引时，语句要扫描整个聚簇索引，RR 下**每一条记录和记录之间的间隙**都会被加上 Next-Key Lock，效果上整张表的更新和插入都被阻塞；表级只持有一把 IX 意向锁。

```sql
-- remark 无索引：RR 下全表记录与间隙都被锁住，直到事务结束
UPDATE orders SET status = 2 WHERE remark = 'urgent';
```

- RC 下不满足条件的行在判断后立即释放锁，UPDATE 还会用半一致读跳过被锁且不匹配的行，影响小得多，但全表扫描的成本不变
- 走了索引但范围很大时同理：锁住的是扫描到的全部记录和间隙
- UPDATE、DELETE、`FOR UPDATE` 的条件要命中索引，上线前用 EXPLAIN 确认；大批量修改按主键范围分批

→ 详见 [MySQL 避坑指南](/database/1_mysql/3_fallible_point#_3、select-for-update-锁住了整张表)

### Q14：死锁是怎么产生的？如何排查和预防？

**核心结论**：死锁是两个及以上事务**互相等待对方持有的锁**形成环。最常见的两种：加锁顺序相反；RR 下两个事务并发「先 `FOR UPDATE` 查一个不存在的行，再 INSERT」，间隙锁互相兼容、插入意向锁却互相阻塞。InnoDB 检测到环后回滚修改行数较少的事务，返回 `ERROR 1213 (40001)`。

| 步骤 | 事务 A | 事务 B |
|:---:|--------|--------|
| 1 | `SELECT * FROM t WHERE id = 12 FOR UPDATE`，0 行，持有间隙 (10, 15) | |
| 2 | | `SELECT * FROM t WHERE id = 13 FOR UPDATE`，0 行，同样持有 (10, 15) |
| 3 | `INSERT` id=12，被 B 的间隙锁阻塞 | |
| 4 | | `INSERT` id=13，被 A 的间隙锁阻塞，形成环 |

排查：

- `SHOW ENGINE INNODB STATUS` 的 LATEST DETECTED DEADLOCK 段只保留最近一次，线上开启 `innodb_print_all_deadlocks=ON` 把每次死锁写入错误日志
- 锁等待看 `sys.innodb_lock_waits`、`performance_schema.data_locks` / `data_lock_waits`；阻塞方 SQL 为 NULL 说明它的事务执行完语句后还没提交

预防：

- 所有事务按相同顺序加锁（如按主键升序批量更新），拆小事务
- 条件走合适的索引，减少被锁住的记录
- 「不存在则插入」改为依赖唯一键：`INSERT ... ON DUPLICATE KEY UPDATE`，或直接插入并捕获重复键异常
- 应用对 1213 做有限次数的**整个事务**重试；锁等待超时是 1205（`innodb_lock_wait_timeout` 默认 50 秒，默认只回滚当前语句）

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_6、死锁)

### Q15：高并发下如何安全地修改同一行数据？

**核心结论**：单库内按冲突程度选择：**带条件的原子 UPDATE** 最简单；读改写逻辑复杂时，冲突少用**乐观锁版本号**，冲突多用 `SELECT ... FOR UPDATE` **悲观锁**。单行热点到行锁排队成为瓶颈时（如秒杀扣库存），要在系统层面用 Redis 预扣、分桶或合并写。

| 方式 | 写法 | 适用 |
|------|------|------|
| 条件 UPDATE | `UPDATE stock SET num = num - 1 WHERE id = ? AND num >= 1`，检查影响行数 | 扣减、计数 |
| 乐观锁 | `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`，影响 0 行则重试 | 冲突少的读改写 |
| 悲观锁 | 事务内 `SELECT ... FOR UPDATE` 后再改 | 冲突多、必须串行 |
| 热点行治理 | Redis 预扣 + 异步落库、分桶库存、合并更新 | 单行每秒上千次写 |

- 条件都要命中主键或唯一索引，否则锁范围会扩大，见 Q13
- 跨服务、跨库的互斥要用分布式锁，见 [分布式面试题解答](/interview/10_distributed)

→ 详见 [高并发面试题解答](/interview/13_high_con#q30-秒杀场景下同一行库存的高并发扣减如何优化)、[热点问题](/high-con/6_hotspot#三、写热点-热点行更新)

## 四、存储引擎

### Q16：InnoDB 和 MyISAM 的区别？

**核心结论**：InnoDB 支持事务、行锁、外键和崩溃恢复，用聚簇索引组织数据；MyISAM 只有表锁、没有事务，崩溃后容易损坏。InnoDB 自 5.5 起是默认引擎，8.0 起系统表也全部是 InnoDB，MyISAM 已是遗留引擎，新项目没有理由选择。

| 维度 | InnoDB | MyISAM |
|------|--------|--------|
| 事务 | 支持 | 不支持 |
| 锁粒度 | 行锁 | 表锁 |
| 外键 | 支持 | 不支持 |
| 崩溃恢复 | redo log 自动恢复 | 易损坏，需要修复 |
| 索引结构 | 聚簇索引，二级索引存主键 | 非聚簇，索引存行地址 |
| 无条件 `COUNT(*)` | 扫描索引（见 Q23） | 直接读维护的行数 |
| 文件 | 默认每表一个 `.ibd` 独立表空间 | `.MYD` 数据、`.MYI` 索引、`.sdi` 元数据（8.0 起不再有 `.frm`） |

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#七、存储引擎对比)

### Q17：InnoDB 为什么推荐自增主键？不定义主键会怎样？

**核心结论**：聚簇索引按主键有序存放整行。**自增主键**让新行总是追加到 B+ 树最右侧的页，几乎没有页分裂和碎片，而且主键短，所有二级索引都更小。随机主键（UUID v4）会在树中间随机插入，页分裂频繁、页填充率低、Buffer Pool 命中率下降。

- 分布式场景要全局唯一又要趋势递增：雪花 ID、号段或时间有序的 UUID v7，见 [分布式 ID 生成](/distributed/8_id_generator)
- 自增 ID 不连续是正常的（事务回滚、批量插入预分配都会跳号），不要用它表达业务序号
- 不定义主键：InnoDB 选第一个所有列都 NOT NULL 的唯一索引；没有就用隐藏的 6 字节 `DB_ROW_ID`，它是所有无主键表共用的全局计数器，用尽后回绕会覆盖同 row_id 的旧行；无主键表在 ROW 格式复制中每行变更都要全表扫描定位，造成复制延迟
- 8.0.30 起可开启 `sql_generate_invisible_primary_key=ON`，无主键建表时自动加不可见的自增主键 `my_row_id`（GIPK）

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#_1、聚簇索引-clustered-index)

### Q18：什么是页？InnoDB 的存储层次和行溢出是怎样的？

**核心结论**：页是 InnoDB **磁盘 IO 和 Buffer Pool 管理的最小单位**，默认 16KB，B+ 树的一个节点就是一页；`innodb_page_size` 只能在初始化实例时设为 4KB～64KB。存储层次是表空间 → 段 → 区 → 页 → 行。

| 层次 | 说明 |
|------|------|
| 表空间 | 独立表空间是一个 `.ibd` 文件，含一张表的数据和索引；16KB 页时上限 64TB |
| 段 | 每个索引有叶子节点段和非叶子节点段 |
| 区 | 16KB 页时为 64 个连续页（1MB），让同一段的页物理相邻 |
| 页 | 默认 16KB，IO 最小单位 |
| 行 | 按行格式存放在页内，默认 DYNAMIC（5.7.9 起） |

- 一页至少放两行，16KB 页中单行（不含溢出部分）最大约 8KB；超出时最长的变长列整列移到溢出页，DYNAMIC 行内只留 20 字节指针
- 索引键前缀上限：DYNAMIC / COMPRESSED 为 3072 字节（16KB 页），REDUNDANT / COMPACT 为 767 字节
- 大字段（JSON 详情、富文本）拆到附表：读取时仍要额外读溢出页，宽行还会降低每页能放的行数

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#一、表空间层次-段、区、页、行)

### Q19：Buffer Pool 如何管理内存？Double Write 解决什么问题？MySQL 偶尔「抖」一下是什么原因？

**核心结论**：Buffer Pool 缓存数据页和索引页，用 Free / LRU / Flush 三条链表管理，LRU 分 young / old 两区，防止一次全表扫描把热点页挤出去。脏页由后台按 checkpoint 刷盘，**redo 空间不足或空闲页不够时被迫集中刷脏**，就是「偶尔抖一下」的常见原因。Double Write 防的是**部分页写**：16KB 页写到一半断电，redo 无法在损坏页上重放，要先用 Double Write 中的完整副本恢复该页。

- LRU：新读入的页插入 old 区头部（old 区默认占 37%），在 old 区停留超过 `innodb_old_blocks_time`（默认 1 秒）后再被访问才晋升 young 区
- 刷脏时机：redo 空间不足（最坏，会阻塞更新）、脏页比例超过阈值、Free List 不足、系统空闲时后台匀速刷
- 调优：`innodb_buffer_pool_size` 取物理内存 50%～75%；`innodb_redo_log_capacity` 留足；`innodb_io_capacity` 与磁盘能力匹配（8.4 默认 10000，8.0 为 200）
- Double Write 8.0.20 起放在独立的 `.dblwr` 文件；只有存储能保证 16KB 原子写时才考虑关闭

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#三、buffer-pool)

## 五、SQL 执行与优化

### Q20：一条 SQL 的执行流程是什么？SELECT 和 UPDATE 有何不同？

**核心结论**：连接器（认证、权限）→ 分析器（词法、语法分析，确认表和列）→ 优化器（基于成本选索引、JOIN 顺序和算法）→ 执行器（校验表权限，调用存储引擎接口）。查询缓存 8.0 已移除。UPDATE 多出写路径：加锁读最新版本 → 写 undo → 修改 Buffer Pool 中的页 → redo 写入 log buffer、行事件写入 binlog cache → COMMIT 时两阶段提交（见 Q5）。

| 组件 | 职责 | 常见问题 |
|------|------|---------|
| 连接器 | TCP、认证（8.4 默认 `caching_sha2_password`）、建立会话 | 空闲超过 `wait_timeout`（默认 8 小时）被断开；权限变更对已连接会话按级别生效 |
| 分析器 | 词法、语法分析，解析表和列 | `ERROR 1064` 语法错误，表或列不存在 |
| 优化器 | 按统计信息估算成本 | 统计信息不准时选错索引（见 Q22） |
| 执行器 | 校验表权限，按计划逐行调用引擎接口 | 慢日志 `Rows_examined` 不含 ICP 在引擎层过滤掉的条目 |

- 更新为什么不直接写数据页：改数据页是随机 IO，redo 是顺序 IO；WAL 先顺序写日志，脏页由后台异步刷盘

→ 详见 [SQL 执行流程](/database/1_mysql/6_topic_execution#二、各组件职责)

### Q21：EXPLAIN 各字段的含义？type 从好到差的顺序是什么？

**核心结论**：重点看 `type`（访问方式）、`key` / `key_len`（用了哪个索引、用到几列）、`rows` × `filtered`（估算扫描行数和过滤比例）、`Extra`（是否回表、排序、临时表）。type 从好到差大致是 `system`、`const`、`eq_ref`、`ref`、`fulltext`、`ref_or_null`、`index_merge`、`unique_subquery` / `index_subquery`、`range`、`index`、`ALL`，线上核心查询至少要到 `range`。

| 字段 | 看什么 |
|------|-------|
| `key` / `key_len` | 实际使用的索引；`key_len` 判断联合索引用到几列（允许 NULL 的列 +1 字节，VARCHAR 另加 2 字节长度） |
| `rows` / `filtered` | 估算扫描行数；`rows × filtered%` 是传给下一张表的估算行数 |
| `Extra` | `Using index` 覆盖索引；`Using index condition` ICP；`Using filesort` 额外排序；`Using temporary` 临时表；`Using join buffer (hash join)` 被驱动表无可用索引 |

- `EXPLAIN ANALYZE`（8.0.18+）会真正执行语句，给出每个算子的实际耗时、行数和循环次数，用来对比估算与实际
- `Using filesort` 不等于磁盘排序，数据超过 `sort_buffer_size` 才落盘
- 8.0 起 GROUP BY 不再隐式排序，需要有序结果必须写 ORDER BY

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#一、explain-字段总览)

### Q22：慢查询如何定位？优化器选错索引怎么办？

**核心结论**：开启慢查询日志（`slow_query_log=1`，`long_query_time` 设到 1 秒或更低）→ 用 `pt-query-digest` 按**总耗时**聚合出 TOP SQL → `EXPLAIN` / `EXPLAIN ANALYZE` 看计划 → 必要时用 Optimizer Trace 看优化器为什么这么选。选错索引时从轻到重处理：`ANALYZE TABLE` 更新统计信息 → 对倾斜列建直方图 → 优化器 hint（`/*+ INDEX(t idx) */`）→ `FORCE INDEX` 应急。

- 正在执行的语句看 `SHOW PROCESSLIST`；历史 TOP 语句看 `sys.statement_analysis`、`sys.statements_with_full_table_scans`（按数值排序用 `x$` 前缀的视图）
- 补联合索引或改写 SQL 通常比强制索引更持久；想验证去掉某个索引的影响，先把它设为 INVISIBLE
- 常见性能案例：隐式转换（Q9）、深分页（Q10）、无索引 JOIN（Q24）、大事务与长事务阻塞 DDL（Q25）

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#四、慢-sql-定位)、[SQL 执行流程](/database/1_mysql/6_topic_execution#_4、优化器)

### Q23：`COUNT(*)`、`COUNT(1)`、`COUNT(字段)` 的区别？

**核心结论**：`COUNT(*)` 和 `COUNT(1)` 处理方式相同，都统计行数且最快；`COUNT(主键)` 要取出主键值，略慢；`COUNT(普通字段)` 只统计非 NULL 值，语义不同。InnoDB 在 MVCC 下不同事务看到的行数可能不同，所以不存总行数，`COUNT(*)` 必须扫描索引。

- 8.0.13 起无 WHERE 的 `SELECT COUNT(*) FROM t` 走专门优化：优先遍历最小的二级索引，扫描聚簇索引时可由 `innodb_parallel_read_threads` 并行读
- 大表总数：能接受近似值就用 `information_schema.TABLES.TABLE_ROWS` 或 EXPLAIN 的 rows；需要精确且高频，维护计数表（与业务写入在同一事务内更新）或用缓存计数

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#六、count-的性能)

### Q24：JOIN 是怎么执行的？8.0.20 之后 BNL 去哪了？

**核心结论**：被驱动表的关联字段**有索引**时用 Index Nested-Loop Join：驱动表每行用索引查找被驱动表，代价约为驱动表行数 × 树高。没有可用索引时，8.0.18 起用 **Hash Join**：较小的一侧在 `join_buffer` 中建哈希表，另一侧逐行探测，内存不够时分片落盘。8.0.20 起 Hash Join 完全取代了 Block Nested-Loop，EXPLAIN 显示 `Using join buffer (hash join)`。

- 给被驱动表的关联字段加索引，比依赖 Hash Join 更好
- 「小表驱动大表」的「小」指过滤后参与 JOIN 的数据量，不是表的总行数，优化器一般能选对
- 关联列的类型、字符集必须一致，否则发生转换导致索引失效
- 「JOIN 不超过 3 张表」的规范主要是为了可维护性和日后拆库，性能问题的根源是无索引和中间结果过大

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#七、join-原理与优化)

### Q25：大表 DDL 为什么会卡住整张表？Online DDL 和 gh-ost 怎么选？

**核心结论**：DDL 要拿表的 **MDL 写锁**，而任何访问过该表、尚未提交的事务都持有 MDL 读锁。DDL 排队等锁时，后续对这张表的所有读写都排在它后面，整张表被「卡住」。8.0.29 起加列、删列都是 INSTANT，真正的风险往往是等 MDL，而不是执行本身。

| 算法 | 做法 | 并发 DML | 典型操作 |
|------|------|---------|---------|
| `INSTANT` | 只改数据字典 | 允许 | 加列、删列（8.0.29+ 任意位置）、改默认值、重命名列 |
| `INPLACE` | 引擎内完成，可能重建表 | 大多允许 | 加二级索引、加主键、`OPTIMIZE TABLE` |
| `COPY` | 建新表逐行拷贝 | 不允许 | 修改列类型、修改字符集 |

- 执行前查长事务（`information_schema.innodb_trx`），DDL 会话设置较短的 `lock_wait_timeout`；卡住时查 `sys.schema_table_lock_waits`
- 显式写出 `ALGORITHM` 与 `LOCK`，做不到时直接报错，而不是悄悄退化成 COPY
- INSTANT 受表的行版本数上限约束（8.4 为 64，9.1 起为 255），用尽后只能重建表
- 千万行以上需要重建的变更用 **gh-ost**（读 binlog 同步增量，无触发器，可限速；要求 ROW + `binlog_row_image=FULL`，不支持外键）或 **pt-online-schema-change**（触发器同步增量）；INPLACE 重建期间副本延迟会持续累积

→ 详见 [MySQL 避坑指南](/database/1_mysql/3_fallible_point#七、大表-ddl-与-online-ddl)

## 六、主从与高可用

### Q26：MySQL 主从复制的原理？binlog 有哪几种格式？

**核心结论**：主库写 binlog；从库的**接收线程**（receiver，原 I/O 线程）连接主库，主库的 Binlog Dump 线程把事件推送过来，写入本地 relay log；**协调线程**（coordinator，原 SQL 线程）读取 relay log，按事务依赖分发给 **worker** 并行回放。默认是**异步**复制。binlog 有 ROW、STATEMENT、MIXED 三种格式，**只推荐 ROW**。

| 格式 | 记录内容 | 现状 |
|------|---------|------|
| ROW | 每行变更前后的数据 | 5.7.7 起默认，CDC 依赖它 |
| STATEMENT | SQL 原文 | `NOW()`、`UUID()`、无序 `LIMIT` 等可能导致主从不一致 |
| MIXED | 按语句自动切换 | 遗留格式 |

- `binlog_format` 变量自 8.0.34 弃用，未来只保留 ROW；CDC 场景保持 `binlog_row_image=FULL`
- 8.4 移除了所有 MASTER / SLAVE 语句，改用 `CHANGE REPLICATION SOURCE TO`、`START REPLICA`、`SHOW REPLICA STATUS`、`SHOW BINARY LOG STATUS`
- 多线程回放 8.0.27 起默认开启（`replica_parallel_workers=4`）

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#二、复制原理)

### Q27：GTID 和半同步复制分别解决什么问题？

**核心结论**：**GTID**（`source_uuid:序号`）解决「切换主库要人工找 binlog 文件名和位置」的问题：从库按自己已执行的 GTID 集合自动定位复制起点（`SOURCE_AUTO_POSITION=1`）。**半同步**解决「异步复制下主库宕机丢最后一批事务」的问题：主库提交时至少等一个从库确认收到事件并写入 relay log。

| 等待点 | 主库何时等从库确认 | 主库宕机切换后 |
|--------|------------------|--------------|
| `AFTER_SYNC`（默认，无损半同步） | binlog 落盘后、引擎提交前 | 等待期间其他会话看不到这笔事务，不会出现「旧主上读到过、新主上没有」 |
| `AFTER_COMMIT` | 引擎提交后、返回客户端前 | 其他会话可能已经读到，新主上却没有 |

- 等待超过 `rpl_semi_sync_source_timeout`（默认 10000 毫秒）会**自动降级为异步**，要监控降级
- 8.0.26 起插件名为 `rpl_semi_sync_source`（主库）/ `rpl_semi_sync_replica`（从库）
- 复制账号默认 `caching_sha2_password`，需要 `SOURCE_SSL=1` 或 `GET_SOURCE_PUBLIC_KEY=1`，否则报错 2061
- 从库初始化用 clone 插件（8.0.17+）

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#三、gtid-复制)

### Q28：主从延迟的原因和解决办法？为什么 `Seconds_Behind_Source` 不可靠？

**核心结论**：延迟来自主库**大事务和大表 DDL**、回放并行度不足、从库跑大查询、从库 IO 能力差、**无主键表**（ROW 格式下每行变更都要全表扫描定位）。MySQL 层面：拆小事务、给所有表加主键、确认多线程回放生效（8.4 固定按 WRITESET 计算依赖，只需调 `replica_parallel_workers`）、分析查询走专用从库；业务层面用强制读主、读己之写等策略。

- `Seconds_Behind_Source` 依据正在回放的事件时间戳计算，回放线程空闲时显示 0，即使接收线程已经卡住、事件根本没传过来；用 `pt-heartbeat` 心跳表，或比较 `performance_schema.replication_applier_status_by_worker` 中的原始提交时间与回放完成时间
- 读己之写：主库会话开启 `session_track_gtids=OWN_GTID` 拿到本事务的 GTID，从库读之前执行 `WAIT_FOR_EXECUTED_GTID_SET(gtid, 超时秒数)`
- 系统级策略见 [高并发面试题解答](/interview/13_high_con#q23-读写分离如何处理主从延迟)

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#五、复制延迟与多线程回放)

### Q29：MySQL 有哪几种高可用方案？

**核心结论**：自建首选 8.4 LTS 上的 **InnoDB Cluster**（组复制 MGR + MySQL Shell + MySQL Router），跨地域再叠加 **ClusterSet**；不需要自动切换时用 **ReplicaSet**；上云直接用托管服务。MHA 多年未更新、依赖 8.4 已移除的旧复制语句，不建议新建。

| 方案 | 组成 | 特点 |
|------|------|------|
| 主从 + 半同步 + 切换工具 | 异步或半同步复制 + Orchestrator 等 | 灵活；切换和防脑裂要自己保证，选工具前确认其维护状态与 8.4 支持 |
| InnoDB Cluster | MGR + Shell + Router | 多数派认证，自动选主，故障切换不丢已提交事务，官方首选 |
| InnoDB ClusterSet（8.0.27+） | 主 Cluster + 异地副本 Cluster | 跨地域容灾，支持计划内切换与紧急故障转移 |
| InnoDB ReplicaSet | 异步复制 + Shell + Router | 手动切换，只简化运维 |
| 云托管 | RDS、Aurora 等 | 关注切换时间与数据丢失承诺 |

- MGR 默认**单主**，最多 9 个成员，组内成员应在同一地域；多数派认证不等于从节点强一致读：`group_replication_consistency` 在 8.4 默认 `BEFORE_ON_PRIMARY_FAILOVER`（8.0 为 `EVENTUAL`），需要读己之写时用 `BEFORE`、`AFTER` 或 `BEFORE_AND_AFTER`
- 读写分离：应用层用 ShardingSphere-JDBC，代理层用 MySQL Router、ProxySQL
- 通用的冗余与切换策略见 [冗余与故障转移](/high-avail/2_redundancy_failover)

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#六、高可用方案)

### Q30：MySQL 8.0 停止支持后如何升级？8.4 LTS 有哪些需要注意的变化？

**核心结论**：8.0 已于 2026 年 4 月随 8.0.46 停止维护，应升级到 **8.4 LTS**，之后可升到 **9.7 LTS**（2026 年 4 月 GA）。跨 LTS 只能逐个升级（8.0 → 8.4 → 9.7），不能跳过。8.4 的风险集中在**移除项**和 **InnoDB 默认值变化**。

| 类别 | 变化 |
|------|------|
| 复制语句 | MASTER / SLAVE 语法全部移除，监控脚本、高可用组件、CDC 工具要先确认兼容 |
| 配置项 | `expire_logs_days`、`default_authentication_plugin`、`binlog_transaction_dependency_tracking` 已移除，留在 my.cnf 中会导致无法启动 |
| 认证 | `mysql_native_password` 默认不加载，9.0 起彻底移除；先升级驱动，再把账号改为 `caching_sha2_password` |
| InnoDB 默认值 | 自适应哈希索引、Change Buffer 默认关闭；`innodb_io_capacity` 200 → 10000；Linux 上默认 `O_DIRECT` |
| 版本号 | 9.7 之后 Innovation 和 LTS 都改用日历版本号（如 26.7），版本号本身不再体现是否 LTS |

- 步骤：MySQL Shell `util.checkForServerUpgrade()` 预检 → 清理配置与脚本 → 预发压测默认值变化 → 先升级副本再切主
- 8.4 不能原地降级回 8.0，回退要依赖备份或逻辑复制

→ 详见 [MySQL 版本特性](/database/1_mysql/1_feature#七、8-0-升级到-8-4-的检查清单)

## 七、PostgreSQL

### Q31：PostgreSQL 与 MySQL 的关键差异？如何选择？

**核心结论**：根本差异在存储与并发模型：PG 是**堆表**，所有索引（含主键）都指向行的物理位置 `ctid`，没有聚簇索引；旧版本留在堆里靠 VACUUM 回收；每个连接一个进程。MySQL InnoDB 是聚簇索引 + undo + 线程模型。功能上 PG 的 SQL 标准支持、JSONB 和扩展生态更强。

| 维度 | MySQL InnoDB | PostgreSQL |
|------|-------------|------------|
| 存储 | 聚簇索引，二级索引存主键 | 堆表，所有索引存 `ctid` |
| 默认隔离级别 | RR | RC |
| 旧版本清理 | undo + purge 线程 | VACUUM |
| 连接模型 | 每连接一个线程 | 每连接一个进程，需要连接池（见 Q46） |
| DDL 与事务 | DDL 原子但隐式提交 | 绝大多数 DDL 可在事务中回滚 |
| JSON | JSON 列，靠生成列、多值索引建索引 | JSONB + GIN 索引 |
| 标识符 | 表名大小写取决于 `lower_case_table_names` | 未加双引号一律折叠为小写 |
| 扩展 | 少 | PostGIS、pgvector、TimescaleDB 等 |

- 常规 OLTP、团队熟悉 MySQL、分库分表与 CDC 等周边工具成熟 → MySQL
- 复杂查询与分析、地理信息、JSONB 文档、向量检索、需要事务性 DDL → PostgreSQL
- 从 MySQL 迁到 PG 常踩的坑：标识符大小写、默认隔离级别与 40001 重试、PG 15 起普通用户不能在 `public` schema 建表

→ 详见 [PostgreSQL 基础](/database/2_postgresql/0_overview#二、与-mysql-的差异-java-开发视角)

### Q32：PG 的 MVCC 与 InnoDB 有何不同？RR 下什么时候会报 40001？

**核心结论**：InnoDB 原地修改行、旧值写入 undo；PG **不改旧行**，UPDATE 等于把旧元组的 `xmax` 设为当前事务、再插入一个新元组，旧版本留在堆里，可见性由元组头的 `xmin` / `xmax` 与事务快照判断。PG 的 RR 是**快照隔离**：要修改的行在快照之后被其他事务修改并提交，当前事务直接报错 `could not serialize access due to concurrent update`（SQLSTATE 40001），而不是像 InnoDB 那样读最新版本继续改。

| 场景 | InnoDB RR | PostgreSQL RR |
|------|----------|---------------|
| 普通 SELECT | 事务级快照 | 事务级快照 |
| 幻读 | 快照读无幻读；当前读靠 Next-Key Lock | 快照隔离本身无幻读，没有间隙锁 |
| 并发更新同一行 | 当前读拿最新版本继续更新 | 报 40001，由应用重试整个事务 |
| SERIALIZABLE | 普通 SELECT 变为加共享锁的读 | SSI：跟踪读写依赖，可能破坏串行化时以 40001 失败 |

- PG 默认 RC：遇到并发更新会等对方提交，在新版本上重新检查 WHERE 后再更新，不报错
- Java 侧在 RR / SERIALIZABLE 下捕获 40001（死锁是 40P01），在事务方法外层重试
- 行锁记在元组的 `xmax` 中而不是内存锁表，锁多少行都不存在锁升级

→ 详见 [MVCC 与 VACUUM](/database/2_postgresql/2_topic_mvcc#三、隔离级别-写给-mysql-用户)

### Q33：VACUUM 解决什么问题？HOT 更新、表膨胀和 XID 回卷怎么处理？

**核心结论**：UPDATE 和 DELETE 留下的死元组要靠 **VACUUM** 回收（登记到空闲空间映射供复用），它还负责更新可见性映射、冻结老元组。三个风险：**表膨胀**（回收不及时，普通 VACUUM 一般不缩小文件）、**写放大**（非 HOT 更新要在所有索引中插入新条目）、**XID 回卷**（32 位事务 ID 绕回前必须冻结）。共同根因常是**清理边界被卡住**：长事务、废弃的复制槽、备库 `hot_standby_feedback`、遗留的两阶段事务。

| 问题 | 处理 |
|------|------|
| HOT 比例低 | 只有不改被索引的列且页内有空闲空间时才能 HOT；更新频繁的表设 `fillfactor=85`，少在 `updated_at` 这类频繁更新的列上建索引 |
| 表膨胀 | 热点表单独调低 `autovacuum_vacuum_scale_factor`，调高 `autovacuum_vacuum_cost_limit`；已膨胀的大表用 `pg_repack` 在线重建，`VACUUM FULL` 持 ACCESS EXCLUSIVE 锁，只在停服窗口使用 |
| XID 回卷 | 监控 `age(datfrozenxid)`；超过 `autovacuum_freeze_max_age`（2 亿）强制防回卷 VACUUM；距回卷剩 300 万个 XID 时停止分配、写入全部失败（14 起的阈值） |
| 清理边界卡住 | `idle_in_transaction_session_timeout`、`transaction_timeout`（17+）限制长事务；删除废弃的复制槽 |

- 不要关闭 autovacuum；停止分配 XID 后先解除卡住边界的因素，再在正常模式下对最老的表执行 VACUUM

→ 详见 [MVCC 与 VACUUM](/database/2_postgresql/2_topic_mvcc#五、vacuum)

### Q34：GIN、GiST、BRIN 等索引分别适合什么场景？

**核心结论**：PG 内置 6 种索引访问方法：B-tree（默认，等值、范围、排序）、Hash（超长键的纯等值）、**GIN**（倒排：JSONB、数组、全文检索、`pg_trgm` 模糊匹配）、**GiST**（地理位置、范围类型、最近邻、排他约束）、SP-GiST（IP 段、文本前缀等可递归划分的数据）、**BRIN**（值与物理顺序强相关的超大追加表，只存块范围摘要）。部分索引、表达式索引和 `INCLUDE` 是叠加在这些方法上的特性。

| 查询特征 | 推荐 |
|---------|------|
| 等值、范围、排序、`LIKE 'x%'` | B-tree，需要免回堆时加 `INCLUDE` |
| 超大只追加表按时间范围查 | BRIN |
| JSONB 任意属性包含查询、数组包含与重叠 | GIN |
| JSONB 只查某个固定字段 | 表达式 B-tree |
| 全文检索、`LIKE '%xx%'` | GIN（`tsvector` / `pg_trgm`） |
| 地理位置、范围重叠、最近邻 | GiST |
| 只有少部分行会被查询 | 部分索引 |

- PG 没有聚簇索引，Index Only Scan 依赖可见性映射：刚大量写入、还没被 VACUUM 的表，`Heap Fetches` 会很高
- GIN 查询快、写入代价高
- 生产建索引用 `CREATE INDEX CONCURRENTLY`：不能放在事务块里，失败会留下 INVALID 索引，要手动删除重建

→ 详见 [PostgreSQL 索引类型](/database/2_postgresql/3_topic_index#九、如何选择)

### Q35：PG 的流复制和逻辑复制有什么区别？`synchronous_commit` 和复制槽要注意什么？

**核心结论**：PG 只有一种日志 **WAL**，同时承担崩溃恢复和复制，没有 binlog，也不需要两阶段提交协调两种日志。**流复制**传页级 WAL，备库与主库逐字节一致、只读，用于高可用和读扩展；**逻辑复制**把 WAL 解码成行变更，按表发布订阅，可跨大版本，用于大版本升级、数据分发和 CDC，但不复制 DDL 和序列当前值。

| `synchronous_commit` | 提交时等待 | 对照 MySQL |
|---------------------|-----------|-----------|
| `off` | 不等本地 WAL 落盘 | 类似 `innodb_flush_log_at_trx_commit=0` |
| `local` | 本地 WAL 落盘 | 「双 1」的单机部分 |
| `remote_write` | 同步备库写入操作系统缓存 | 最接近 AFTER_SYNC 半同步 |
| `on`（默认） | 同步备库 WAL 刷盘 | 强于 MySQL 半同步 |
| `remote_apply` | 同步备库已重放，备库可读到 | 无直接对应 |

- 除 `off`、`local` 外，只有设置了 `synchronous_standby_names` 才会等待备库；只配一个同步备库时它宕机会让主库提交全部挂起
- 复制槽保留消费者未消费的 WAL，消费者不回来就**一直堆积到磁盘写满**；用 `max_slot_wal_keep_size`（13+）、`idle_replication_slot_timeout`（18+）兜底，废弃的 CDC 槽及时删除
- 内核不负责故障切换：主流是 Patroni（etcd 等保存领导者租约），全面上 K8s 时用 CloudNativePG

→ 详见 [PostgreSQL 复制与高可用](/database/2_postgresql/5_topic_replication#二、wal-与流复制)

## 八、分布式数据库与分库分表

### Q36：什么时候需要分库分表？分片键如何选择？

**核心结论**：分库分表是数据层扩展的**最后一步**：先优化索引与 SQL、加缓存、读写分离、归档冷数据，单库的容量、写入 TPS 或连接数确实撑不住时才拆。垂直拆分按业务拆库，水平拆分按分片键把行分散到多个库表。分片键选**最高频查询条件中分布均匀、不会修改**的字段（如 user_id），让绝大多数查询只落到一个分片。

- 非分片键查询用映射表、冗余表或搜索引擎；跨分片排序分页的代价随偏移量和分片数增长，见 Q37
- 分片算法、平滑扩容、分布式 ID 等系统级方案在高并发专题，这里不展开

→ 详见 [高并发面试题解答](/interview/13_high_con#q24-什么时候需要分库分表-分片键如何选择)、[数据层扩展](/high-con/5_data_scaling#四、分库分表)

### Q37：ShardingSphere-JDBC 和 Proxy 有什么区别？跨分片查询和事务如何处理？

**核心结论**：**ShardingSphere-JDBC** 是应用内的 jar，作为 JDBC 驱动工作，没有额外网络跳转，只支持 Java；**ShardingSphere-Proxy** 是独立部署的数据库代理（MySQL / PostgreSQL 协议），任何语言都能用，统一管控并支持 DistSQL 和数据迁移，但多一跳网络且要自己做高可用。常见组合是应用走 JDBC，DBA 和运维走 Proxy，共享一套规则。5.3.0 起移除了 Spring Boot starter，统一用 `ShardingSphereDriver` + YAML 接入。

- 跨分片查询：逻辑 SQL 改写后在各分片并发执行再归并；`LIMIT 100, 10` 会被改写为每个分片 `LIMIT 0, 110`，深分页应改为游标分页；`AVG` 改写为 `SUM` 和 `COUNT`；不带分片键的查询会路由到所有分片
- 事务：LOCAL（默认）、XA、BASE（Seata AT），只协调同一个 ShardingSphere 实例内的数据源；跨服务事务见 [分布式面试题解答](/interview/10_distributed)
- 数据迁移：Proxy 上的 DistSQL（`MIGRATE TABLE`、`CHECK MIGRATION`、`COMMIT MIGRATION`）基于全量 + binlog 增量

→ 详见 [分库分表与中间件](/database/5_practice/2_sharding#二、两种接入形态)

### Q38：TiDB 的数据如何分片与复制？事务和 MySQL 有什么不同？

**核心结论**：TiDB 由计算层 TiDB Server、存储层 TiKV、调度中心 PD 组成。表数据和索引编码成有序的 Key，按范围切成 **Region**（v8.4.0 起默认 256 MiB），每个 Region 的副本组成一个 **Raft Group**，读写走 Leader，PD 负责分裂、合并和均衡。事务基于 **Percolator**：PD 分配时间戳，Prewrite 对所有 Key 加锁，提交 Primary Key 即代表提交成功；5.0 起默认开启 Async Commit 与 1PC。

| 与 MySQL 的差异 | TiDB 8.5 |
|---------------|----------|
| 隔离级别与锁 | RR 实际是快照隔离；悲观模式（新集群默认）**没有 Gap Lock**，靠 `FOR UPDATE` 锁范围防插入的逻辑要改为唯一约束 |
| 自增 ID | 默认各 TiDB Server 缓存号段，唯一但不连续；写热点用 `AUTO_RANDOM` |
| 不支持 | 存储过程、触发器、事件、自定义函数；自建版不支持 FULLTEXT |
| 大事务 | 受 `txn-total-size-limit` 限制，批量写入要分批提交 |

- 单调递增主键的写入会集中到最后一个 Region，形成热点
- HTAP：TiFlash 以 Raft Learner 异步复制列存副本，查询时用 Read Index 等本地追平再按快照读取，结果与 TiKV 一致

→ 详见 [分布式数据库](/database/3_relational/1_distributed_db#一、tidb)

### Q39：分库分表和分布式数据库怎么选？TiDB、OceanBase、Aurora / PolarDB 有什么区别？

**核心结论**：分库分表复用成熟的 MySQL，成本低，但跨分片 JOIN、事务、扩容都要业务和中间件承担；分布式数据库把分片、复制和分布式事务做进内核，对业务透明，代价是新的运维体系和更高的资源门槛。分片键清晰、查询模式稳定 → 分库分表；需要强一致的跨分片事务、透明扩展或 HTAP → 分布式数据库。

| | TiDB | OceanBase | Aurora / PolarDB |
|---|------|-----------|-----------------|
| 路线 | Shared-Nothing，按 Region 的 Raft | Shared-Nothing，按日志流的 Multi-Paxos | 存算分离 + 共享存储 |
| 兼容 | MySQL 8.0 协议 | MySQL 模式；企业版有 Oracle 模式 | MySQL / PostgreSQL |
| 写扩展 | 加节点 | 加节点 | 以单写节点为主，写扩展要选分布式形态（Aurora PostgreSQL Limitless、PolarDB-X 等） |
| 典型场景 | MySQL 扩容、HTAP | 金融核心、Oracle 迁移、多租户 | 读多写少、从 RDS 平滑升级 |

- OceanBase 4.x 多数派持久化即提交，RPO = 0，官方给出的 RTO 小于 8 秒
- 单表千万级、单库能承受时，先优化索引、归档、加缓存，不急于分库分表或上分布式数据库

→ 详见 [分布式数据库](/database/3_relational/1_distributed_db#三、tidb-与-oceanbase-选型对比)、[分库分表与中间件](/database/5_practice/2_sharding#八、选型建议)

## 九、NoSQL 与选型

### Q40：MongoDB 如何建模？多文档事务有哪些限制？

**核心结论**：建模原则是**一起读的数据放在一起**：一对一、一对少量且随父文档一起读写的子数据**内嵌**（订单与订单项），一对大量、多对多或需要独立访问的数据**引用**（用户与订单）。单文档写入本身是原子的，把需要一起更新的数据内嵌到同一文档，就能避开多文档事务。

- 单文档上限 16MB，会持续增长的数组（评论、日志）不要内嵌
- 多文档事务：4.0 支持副本集，4.2 支持分片集群；默认须在 60 秒内完成，官方建议单个事务修改不超过 1000 个文档；事务会持有快照、增加缓存压力，冲突时需要重试
- 写关注 5.0 起默认 `w: "majority"`，故障切换后不会回滚；从 Secondary 读可能读到旧数据，读己之写用因果一致性会话或读 Primary
- 分片键要覆盖主要查询条件：哈希分片分布均匀但范围查询要广播，单调递增的键做范围分片会形成写热点；5.0 起可在线重新分片

→ 详见 [文档数据库](/database/4_nosql/2_document_db#二、文档建模)

### Q41：Elasticsearch 为什么能快速全文检索？写入后为什么不能立刻搜到？

**核心结论**：ES 基于 Lucene 的**倒排索引**（词项 → 文档 ID 列表）：先在 FST 词典中定位词项，再读取 Posting List，多个词项时求交集，代价与命中量相关，而不是与全量数据成正比。写入先进入内存 Buffer 并写 Translog，**refresh**（默认 1 秒）生成新 Segment 后才可被搜索，所以是**近实时**的。

| 操作 | 作用 |
|------|------|
| 写 Translog | 持久性来源；默认每个请求返回前 fsync |
| refresh | 生成新 Segment，变为可搜索，但尚未 fsync |
| flush | Lucene commit：Segment 落盘并截断 Translog |
| merge | 合并小 Segment，物理清除已删除的文档 |

- 文本在写入和查询时都经过分析器（字符过滤 → 分词 → 词元过滤）；`standard` 分词器把中文切成单字，中文用 IK（第三方插件，版本须与 ES 完全一致）或官方的 smartcn / ICU
- 主分片数创建后不能直接修改，可用 `_split`（倍数）、`_shrink`（因数），改字段类型时才需要 Reindex
- 许可：ES 8.16 起增加 AGPL 选项；OpenSearch 从 7.10.2 分叉，3.x 与 ES 客户端不兼容

→ 详见 [搜索数据库](/database/4_nosql/3_search_db#_3、倒排索引)、[搜索数据库](/database/4_nosql/3_search_db#_1、写入链路)

### Q42：ES 深分页怎么做？数据如何从数据库同步到 ES？

**核心结论**：`from + size` 默认不能超过 10000（`index.max_result_window`），越往后越慢；翻页用 **`search_after` + PIT**（Point in Time，排序带 `_shard_doc` 兜底），`scroll` 只用于离线导出。同步的基本模式是**业务库为事实源、ES 为查询侧投影**：通过 Outbox、MQ 或 **CDC** 捕获变更，组装成宽文档写入 ES，用外部版本号（`version_type: external`）或更新时间处理乱序与重复。

- 业务代码同时写数据库和 ES 的双写无法保证一致，失败补偿复杂，优先 CDC 或可靠消息
- 全量重建用新索引 + 别名切换，见 [搜索系统设计](/scenario/9_search_system)
- 缓存与数据库的一致性是另一个问题，见 [缓存面试题解答](/interview/8_cache)

→ 详见 [搜索数据库](/database/4_nosql/3_search_db#_3、深分页)、[搜索数据库](/database/4_nosql/3_search_db#六、数据同步)

### Q43：HBase、ClickHouse、Doris / StarRocks 有什么区别？ClickHouse 为什么不适合频繁更新？

**核心结论**：HBase 是**宽列 KV**：按 RowKey 有序，擅长海量数据的按键随机读写；ClickHouse、Doris、StarRocks 是**列式 OLAP**：每列单独存储压缩、向量化执行，擅长大范围扫描聚合。ClickHouse 单表宽表分析最快；Doris / StarRocks 多表 JOIN、主键模型实时 UPSERT 和 MySQL 协议兼容更友好。ClickHouse 每次 INSERT 生成新的不可变 Part 再由后台合并，更新和删除只能打标记或重写 Part。

- 更新方式：轻量级 DELETE（23.3 GA）先打删除标记；轻量级 UPDATE（25.7 引入，Beta）；旧的 `ALTER TABLE ... UPDATE / DELETE` 是重写整个 Part 的 Mutation，只适合低频批量修正
- ReplacingMergeTree 只在后台合并时、同一分区内去重，读时要 `FINAL` 或 `argMax` 才能拿到正确结果
- 批量写入：每次至少 1000 行，最好 1 万～10 万行，约每秒一次；小客户端多时开启 `async_insert`
- HBase 的单调递增 RowKey 会形成写热点，用哈希前缀、反转或加盐打散，代价是范围扫描要扫多个桶

→ 详见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db#四、选型对比)

### Q44：时序数据为什么不用 MySQL 存？什么时候需要图数据库？

**核心结论**：时序数据写多读少、按时间追加、按时间窗口聚合、按时间批量过期。MySQL 的 B+ 树随机写扛不住高频写入，按时间删除是海量行 DELETE，压缩也远不如时序专用编码；TSDB 用顺序写结构、按时间分块整块丢弃、delta-of-delta / Gorilla 等编码压缩。图数据库适合**多跳关系**：深度 3 跳以上、要沿路径过滤或返回路径本身时，关系型每一跳是一次 JOIN，原生图存储每一跳的代价只与节点的度数相关。

| 场景 | 推荐 |
|------|------|
| 系统监控告警 | Prometheus，长期存储接 VictoriaMetrics / Thanos / Mimir |
| 已有 PostgreSQL 技术栈 | TimescaleDB，能与业务表 JOIN |
| 工业 IoT、设备采集 | TDengine、IoTDB |
| 通用时序 | InfluxDB 3 |
| 社交关系、风控团伙、知识图谱 | Neo4j、NebulaGraph |

- 时序数据库的第一大坑是**高基数**：user_id、订单号放进 tag / label 会让序列数爆炸
- 图数据库怕超级节点，遍历要限制关系类型、方向和深度；层级浅的关系用 SQL 递归 CTE 即可
- 各类数据库的整体选型见 [数据库选型参考](/database/6_reference/1_selection_guide)

→ 详见 [时序数据库](/database/4_nosql/1_time_series_db#六、选型对比)、[图数据库](/database/4_nosql/4_graph_db#五、选型对比)

## 十、连接池、CDC 与备份

### Q45：连接池大小怎么设？`maxLifetime`、`keepaliveTime` 与 `wait_timeout` 是什么关系？

**核心结论**：连接池不是越大越好。HikariCP 文档引用的经验公式「连接数 = **数据库服务器** CPU 核数 × 2 + 有效磁盘数」算的是数据库侧同时活跃连接的**总数**，要分摊到所有应用实例；所有实例的池大小之和（含扩容后）不超过 `max_connections` 的约 80%。`maxLifetime` 要比 MySQL `wait_timeout`（默认 28800 秒）以及防火墙、负载均衡的空闲超时都短，`keepaliveTime` 要小于其中最短的那个，否则池里会留着已被断开的连接，报 Communications link failure。

- 例：数据库 16 核、SSD，总活跃连接约 33，部署 4 个实例时每个 8～10 个即可；用「峰值 QPS × 平均持有时间」反推出的值远大于公式时，先缩短持有时间（慢 SQL、事务内远程调用）
- HikariCP 默认：`maximumPoolSize=10`、`connectionTimeout=30 秒`、`maxLifetime=30 分钟`、`keepaliveTime=2 分钟`（6.2.1 起）
- 池耗尽（`Connection is not available, request timed out`）：看 `hikaricp.connections.pending`，查慢 SQL 和长事务，打线程 Dump；泄漏用 `leakDetectionThreshold` 定位
- HikariCP 只做连接池，监控走 Micrometer；Druid 自带 SQL 监控和 wall 防火墙，监控页要做好访问控制

→ 详见 [数据库连接池](/database/5_practice/3_connection_pool#_4、池大小估算)、[高并发面试题解答](/interview/13_high_con#q37-数据库连接池是不是越大越好-水平扩容时要注意什么)

### Q46：PostgreSQL 为什么需要 PgBouncer？transaction 模式有什么限制？

**核心结论**：PG 为每个连接 fork 一个后端进程，单连接开销大，`max_connections` 一般只配几百，微服务实例一多总连接数就会超限。PgBouncer 是轻量的连接池代理，把大量客户端连接复用到少量服务端连接上，生产常用 **transaction 模式**（事务结束即归还服务端连接），代价是不能依赖会话级状态。

| 模式 | 服务端连接何时归还 | 限制 |
|------|-----------------|------|
| `session`（默认） | 客户端断开时 | 无，复用率低 |
| `transaction` | 事务结束时 | 会话级 `SET`（改用 `SET LOCAL`）、会话级 advisory lock、`LISTEN`、跨事务的临时表、`WITH HOLD` 游标不可用 |
| `statement` | 每条语句结束时 | 不允许多语句事务 |

- 预编译语句：PgJDBC 默认同一语句执行 5 次后改用服务端预编译，需要 PgBouncer 1.21 及以上并设置 `max_prepared_statements`；更老的版本在 JDBC URL 上加 `prepareThreshold=0`
- 应用内仍保留 HikariCP 控制并发，PgBouncer 负责收敛到数据库的真实连接

→ 详见 [数据库连接池](/database/5_practice/3_connection_pool#五、pgbouncer)

### Q47：基于 binlog 的 CDC 原理是什么？Canal、Debezium、Flink CDC 怎么选？

**核心结论**：CDC 工具**伪装成一个从库**，用复制协议从 MySQL 拉取 binlog，解析 ROW 格式中每行变更的前后镜像，转成事件投递给下游。前提：binlog 为 ROW 格式且 `binlog_row_image=FULL`；账号有 `REPLICATION SLAVE`、`REPLICATION CLIENT` 权限；`server_id` 在整个复制拓扑中唯一（重复时两个客户端会互相踢下线、交替重连）。

| 工具 | 形态 | 全量快照 | 适合 |
|------|------|---------|------|
| mysql-binlog-connector-java | 嵌入应用的 Java 库，只给原始事件 | 不支持 | 单个服务监听少量表 |
| Canal | 独立 Server + 客户端或投递 MQ | 不支持 | 已有 Canal 体系、只同步 MySQL |
| Debezium | Kafka Connect 连接器，或 Debezium Server | 支持 | 已有 Kafka、多种数据库、Outbox |
| Flink CDC | Flink Source 与 YAML 管道 | 无锁增量快照 | 实时计算、整库入仓入湖 |

- 投递语义基本是至少一次，下游必须**幂等**（按主键 upsert、按 GTID 或版本号去重），并按主键分区保证同一行的事件有序
- binlog 保留时间要长于 CDC 可能的最长停机；PostgreSQL 用逻辑复制槽，下游停摆时 WAL 会持续堆积
- Debezium 事件包含 `before` / `after` / `source` / `op`，`op` 取 `c`、`u`、`d`、`r`（快照）、`t`（截断）
- 用 CDC 删除缓存的一致性方案见 [缓存一致性](/cache/10_cache_consistency)

→ 详见 [CDC 工具](/database/5_practice/0_cdc_tools#一、工具对比)、[Flink CDC](/flink/6_cdc)

### Q48：如何设计 MySQL / PostgreSQL 的备份与时间点恢复（PITR）？

**核心结论**：备份策略由 **RPO**（最多允许丢多少数据）和 **RTO**（最多多久恢复）决定，基本形态是「**定期全量 + 持续日志归档**」：全量提供基线，binlog / WAL 归档把数据补到任意时间点。大库用物理备份（恢复快），逻辑备份用于跨版本迁移和按表恢复。**未经恢复演练的备份等于没有备份**。

| | MySQL | PostgreSQL |
|---|-------|-----------|
| 逻辑备份 | `mysqldump --single-transaction --source-data=2`、MySQL Shell dump 工具 | `pg_dump`（`-Fd -j` 并行） |
| 物理备份 | XtraBackup（版本须与服务器匹配）、CLONE 插件、MySQL Enterprise Backup | `pg_basebackup`；17 起支持增量备份（需 `summarize_wal`） |
| 日志归档 | `mysqlbinlog --read-from-remote-server --raw --stop-never` 保存原始 binlog | `archive_command` 归档 WAL |
| 恢复到时间点 | 全量恢复后用 `mysqlbinlog --stop-datetime` 重放，或 `--exclude-gtids` 跳过误操作事务 | `restore_command` + `recovery_target_time`，并创建 `recovery.signal` |

- XtraBackup 增量 prepare：除最后一个增量外都要加 `--apply-log-only`，否则后续增量的 LSN 接不上
- PG 恢复时忘记创建 `recovery.signal`，服务器会正常启动并忽略所有恢复参数
- 3-2-1 原则：3 份副本、2 种介质、1 份异地；定期做全量恢复与 PITR 演练，记录实际 RTO

→ 详见 [数据备份与恢复](/database/5_practice/1_backup_recovery)

---
description: 事务、索引、锁、InnoDB、SQL 优化、主从、PostgreSQL、分库分表、NoSQL、连接池与 CDC
---

# 数据库面试题解答

> 题目清单见 [数据库面试题](/database/99_interview)，细节见 [数据库总览](/database/0_overview)；缓存一致性、分布式事务、系统级分库分表见 [缓存面试题解答](/interview/8_cache)、[分布式面试题解答](/interview/10_distributed)、[高并发面试题解答](/interview/13_high_con)。
>
> 版本基线：MySQL 8.4 LTS、PostgreSQL 18，其他组件取当前主流版本，差异处单独说明。

## 一、事务与隔离级别

### Q1：MySQL 有哪四种隔离级别？各自能解决什么问题？默认是哪一种？

**一句话**：从低到高是读未提交、读已提交（RC）、可重复读（RR）、串行化，级别越高防住的并发问题越多、性能越差。InnoDB 默认 RR，Oracle、PostgreSQL、SQL Server 默认 RC。

| 隔离级别 | 脏读 | 不可重复读 | 幻读 |
|---------|:---:|:---------:|:---:|
| READ UNCOMMITTED | 可能 | 可能 | 可能 |
| READ COMMITTED | 避免 | 可能 | 可能 |
| REPEATABLE READ（默认） | 避免 | 避免 | 基本避免（见 Q3） |
| SERIALIZABLE | 避免 | 避免 | 避免 |

- 很多团队把 MySQL 改成 RC：锁更少、死锁更少，代价是同一事务里两次读可能不一样
- 查看当前级别：`SELECT @@transaction_isolation;`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_2、四种隔离级别)

### Q2：脏读、不可重复读、幻读的区别？

**一句话**：都是一个事务里读到了别的事务造成的变化。脏读是读到别人还没提交的数据；不可重复读是同一行读两次值变了；幻读是同一个条件查两次，多出了新插入的行。

- 脏读：B 改了余额还没提交，A 就读到了，B 随后回滚，A 读到的是「不存在」的数据
- 不可重复读：A 两次读 id=1，中间 B 修改并提交了这一行
- 幻读：A 两次查 `age > 18`，中间 B 插入了一个 20 岁的用户
- 防不可重复读只要保护「读过的行」；防幻读要保护「还不存在的行」，所以要锁住行之间的空隙（间隙锁）

**常见坑**：两个事务同时改同一行导致的「丢失更新」不属于这三类，要靠加锁或乐观锁版本号解决。

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_1、三种并发读问题)

### Q3：快照读和当前读有什么区别？RR 能在多大程度上避免幻读？

**一句话**：普通 SELECT 是快照读，读的是事务开始时的「照片」，不加锁；`FOR UPDATE`、UPDATE、DELETE、INSERT 是当前读，读最新数据并加锁。RR 下只做快照读或只做当前读都不会幻读，两者混用就可能看到别人新插入的行。

- 快照读防幻读：整个事务都用同一张「照片」
- 当前读防幻读：靠锁住范围（Next-Key Lock，即锁住记录和记录前的空隙），别人插不进来
- 混用的例子：先 SELECT 查到 0 行，别人插入并提交，再 UPDATE 却更新到了这行，之后 SELECT 就能看到它
- RC 下当前读不锁空隙，幻读照常出现

**常见坑**：「先查再改」的业务第一步就用 `SELECT ... FOR UPDATE`，或直接执行带条件的 UPDATE 并检查影响行数。

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_3、快照读与当前读)

### Q4：MVCC 的原理是什么？undo log 和 Read View 如何配合？RC 与 RR 有何不同？

**一句话**：MVCC 就是一行数据保留多个历史版本，读的时候挑一个「自己该看到的」版本，这样读不用加锁。

- 每行藏着两个字段：最后修改它的事务 ID、指向上一个版本的指针；旧版本存在 undo log 里，串成一条版本链
- Read View 是一份「快照名单」：记录创建时哪些事务还没提交
- 读的时候沿版本链往回找：自己改的、或创建名单前已提交的版本可见，还没提交的不可见
- RC 每次 SELECT 都新建 Read View，所以能读到别人刚提交的；RR 只在第一次 SELECT 时建一次，之后一直复用

**常见坑**：长事务一直拿着旧的 Read View，旧版本清理不掉，undo 越积越多；用 `information_schema.innodb_trx` 找出长事务。

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#三、mvcc-多版本并发控制)

### Q5：redo log、undo log、binlog 有什么区别？两阶段提交如何保证崩溃恢复一致？

**一句话**：undo 用来回滚和提供历史版本；redo 用来宕机后把已提交但还没写到数据文件的修改补回来；binlog 是 MySQL 层的变更记录，用来做主从复制和按时间点恢复。

| 对比 | undo log | redo log | binlog |
|------|---------|----------|--------|
| 所属 | InnoDB | InnoDB | MySQL Server 层 |
| 记录 | 怎么撤销 | 页改成了什么 | 每行改成了什么 |
| 用途 | 回滚、MVCC | 崩溃恢复 | 复制、恢复到时间点、CDC |

- 两阶段提交：先把 redo 标记为「准备好」，再写 binlog，最后标记「已提交」
- 崩溃恢复时看 binlog：binlog 里有这个事务就提交，没有就回滚，保证主库和从库、备份的数据一致
- 「双 1」配置：`innodb_flush_log_at_trx_commit=1`、`sync_binlog=1`（都是默认值），每次提交都刷盘，不丢数据

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_4、两阶段提交与崩溃恢复)

## 二、索引

### Q6：InnoDB 为什么用 B+ 树？B 树真的不能做范围查询吗？三层 B+ 树能存多少行？

**一句话**：B 树也能做范围查询，只是效率差。B+ 树非叶子节点只存键，一个节点能放更多键，树更矮；数据都在叶子上，叶子之间用链表串起来，范围查询找到起点后顺着往后读就行。

- 二叉树（红黑树等）太高，千万数据要二十多层，每层一次磁盘读
- B 树非叶子节点也存数据，放的键少、树更高；范围查询要上下来回跳
- 哈希只能做等值查询，不能范围、排序、前缀匹配
- 三层约 2000 万行：16KB 一页，非叶子页约放 1170 个指针，叶子页按每行 1KB 放 16 行，1170 × 1170 × 16 ≈ 2000 万

**常见坑**：2000 万不是分表阈值，行越宽这个数越小；它只说明点查只需读 2～3 页。

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#一、b-树数据结构)

### Q7：聚簇索引和二级索引的区别？什么是回表和覆盖索引？

**一句话**：主键索引就是聚簇索引，叶子上存整行数据；二级索引叶子上只存「索引列 + 主键」。用二级索引查别的列，要拿主键再去主键索引查一次，这叫回表；要的列二级索引上都有，就不用回表，这叫覆盖索引。

| 对比 | 聚簇索引 | 二级索引 |
|------|---------|---------|
| 数量 | 每表一个 | 可以多个 |
| 叶子存什么 | 整行 | 索引列 + 主键 |

- EXPLAIN 的 Extra 显示 `Using index` 才是覆盖索引
- 主键越长，每个二级索引都越大
- 回表的行很多时就是大量随机读，是慢查询的常见原因

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#三、聚簇索引与二级索引)

### Q8：联合索引的最左前缀原则是什么？范围条件之后的列完全用不上吗？

**一句话**：联合索引 `(a, b, c)` 先按 a 排、a 相同再按 b 排，以此类推，所以必须从 a 开始连续用等值条件才能快速定位。遇到范围条件后，后面的列不能再缩小查找范围，但还能用来提前过滤，减少回表。

- `a = 1 AND b = 2 AND c = 3`：三列都能用
- `a = 1 AND c = 3`：只用 a 定位，c 在索引上过滤
- `a = 1 AND b > 2 AND c = 3`：用 a、b 定位，c 在索引上过滤
- 「在索引上过滤」叫索引下推（ICP），EXPLAIN 显示 `Using index condition`
- 只查 `b = 2` 一般用不上；8.0 在条件合适时可以「跳跃扫描」（Skip Scan）

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#六、最左前缀原则)

### Q9：索引失效的常见场景有哪些？

**一句话**：分两类：一是对索引列做了加工，索引的顺序用不上了；二是索引能用，但优化器算下来觉得全表扫描更便宜。到底走没走索引，以 `EXPLAIN` 为准。

- 对列用函数或运算：`YEAR(create_time) = 2024`，改成时间范围条件
- 类型不一致：字符串列 `phone = 13800138000`（没加引号），列会被转换成数字
- 左模糊 `LIKE '%abc'`：开头不确定，没法定位；包含匹配用全文索引或 ES
- OR 有一侧没索引、`!=`、`NOT IN`、区分度低（如 `status` 只有几种值）：优化器可能放弃索引
- 没有「命中超过 30% 就不走索引」这种固定规则，都是按成本估算

**常见坑**：关联的两张表字符集或排序规则不一致，JOIN 时一侧被转换，索引失效。

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#七、索引失效的常见场景)

### Q10：深度分页如何优化？

**一句话**：`LIMIT 100000, 20` 要先读出 10 万行再扔掉，`SELECT *` 时每行还要回表。要跳页就用延迟关联，只查下一页就用游标翻页。

- 延迟关联：子查询在覆盖索引上只取 20 个 id，外层再按 id 查整行，只回表 20 次
- 游标翻页：记住上一页最后一条的排序值和 id，下一页用 `WHERE` 接着查，速度和页数无关
- 游标翻页不能随意跳到第 N 页；产品上也可以限制最大页数

```sql
WHERE user_id = ? AND (create_time < ? OR (create_time = ? AND id < ?)) ORDER BY create_time DESC, id DESC LIMIT 20
```

**常见坑**：排序字段可能重复，游标必须带上 id，否则会漏数据或重复。

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#九、深度分页优化)

### Q11：如何设计合理的索引？唯一索引和普通索引怎么选？

**一句话**：围绕高频查询建联合索引，尽量做到覆盖索引，控制索引数量。数据该唯一就用唯一索引，不要为了那点写入性能改成普通索引。

- 该建：WHERE、JOIN、ORDER BY、GROUP BY 里常用、区分度高的列
- 列顺序：等值条件的列在前，范围条件的列在后；`WHERE a = ? ORDER BY b` 建 `(a, b)`
- 慎建：区分度低的列单独建索引、频繁更新的列、很长的字符串；每个索引都会拖慢写入
- 「普通索引写入更快」靠的是 Change Buffer（先把修改攒在内存里），MySQL 8.4 默认已关闭它

**常见坑**：直接删索引有风险，先设为不可见观察：`ALTER TABLE t ALTER INDEX idx INVISIBLE`。

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#十、索引设计原则)

## 三、锁

### Q12：InnoDB 有哪些锁？Record Lock、Gap Lock、Next-Key Lock 的区别和加锁规则？

**一句话**：行锁分共享锁（S）和排他锁（X）；按锁的范围分：Record Lock 锁一条记录，Gap Lock 锁两条记录之间的空隙，Next-Key Lock 是两者加起来。RR 下当前读默认加 Next-Key Lock，而且是加在扫描到的每条索引记录上。

| 锁 | 锁住什么 |
|----|---------|
| Record Lock | 一条索引记录 |
| Gap Lock | 记录之间的空隙，只防插入 |
| Next-Key Lock | 空隙 + 记录 |
| 插入意向锁 | INSERT 前申请，会被空隙上的锁挡住 |

- 唯一索引等值查中了：只锁这一条；没查中：锁它所在的空隙
- 普通索引等值查：锁命中记录和它前后的空隙
- RC 下基本不加间隙锁
- 实际加了哪些锁，看 `performance_schema.data_locks`

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#五、锁)

### Q13：没走索引的 UPDATE 会锁住哪些行？

**一句话**：InnoDB 不会把行锁升级成表锁，但锁是加在扫描到的记录上的。没走索引就要扫全表，RR 下每一行和每个空隙都被锁住，效果上整张表都不能更新和插入。

- 锁一直持有到事务结束
- RC 下不满足条件的行判断完就释放锁，影响小得多，但全表扫描本身还是慢
- 走了索引但范围很大，同样会锁住大量记录

```sql
UPDATE orders SET status = 2 WHERE remark = 'urgent';  -- remark 无索引：等于锁全表
```

**常见坑**：UPDATE、DELETE、`FOR UPDATE` 上线前用 EXPLAIN 确认走了索引；大批量修改按主键范围分批执行。

→ 详见 [MySQL 避坑指南](/database/1_mysql/3_fallible_point#_3、select-for-update-锁住了整张表)

### Q14：死锁是怎么产生的？如何排查和预防？

**一句话**：两个事务互相等对方手里的锁，谁也走不下去就是死锁。InnoDB 会自动发现，回滚其中一个，返回错误 1213。

- 常见原因一：两个事务加锁顺序相反（A 先锁 1 再锁 2，B 先锁 2 再锁 1）
- 常见原因二：RR 下两个事务都先 `FOR UPDATE` 查一个不存在的行（都拿到同一个空隙锁），再各自 INSERT，互相被对方的空隙锁挡住
- 排查：`SHOW ENGINE INNODB STATUS` 看最近一次死锁；开 `innodb_print_all_deadlocks=ON` 把每次死锁都记进错误日志
- 预防：统一加锁顺序、拆小事务、条件走索引；「不存在就插入」改用唯一键 + `INSERT ... ON DUPLICATE KEY UPDATE`

**常见坑**：应用捕获 1213 后要重试整个事务，不是只重试那一条 SQL。

→ 详见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction#_6、死锁)

### Q15：高并发下如何安全地修改同一行数据？

**一句话**：最简单的是带条件的原子 UPDATE；逻辑复杂、冲突少用乐观锁（版本号），冲突多用悲观锁（`FOR UPDATE`）。单行写入量太大（如秒杀扣库存）时，要靠 Redis 预扣、分桶等系统层面的办法。

| 方式 | 写法 | 适用 |
|------|------|------|
| 条件 UPDATE | `SET num = num - 1 WHERE id = ? AND num >= 1`，看影响行数 | 扣减、计数 |
| 乐观锁 | `WHERE id = ? AND version = ?`，影响 0 行就重试 | 冲突少 |
| 悲观锁 | 事务里先 `SELECT ... FOR UPDATE` 再改 | 冲突多 |
| 热点治理 | Redis 预扣、分桶库存、合并写 | 单行每秒上千次写 |

- 条件要命中主键或唯一索引，否则锁的范围会变大（见 Q13）
- 跨服务、跨库的互斥要用分布式锁

→ 详见 [高并发面试题解答](/interview/13_high_con#q30-秒杀场景下同一行库存的高并发扣减如何优化)、[热点问题](/high-con/6_hotspot#三、写热点-热点行更新)

## 四、存储引擎

### Q16：InnoDB 和 MyISAM 的区别？

**一句话**：InnoDB 支持事务、行锁、外键和崩溃后自动恢复；MyISAM 只有表锁、没有事务，崩溃后容易坏表。InnoDB 早就是默认引擎，新项目没有理由用 MyISAM。

| 对比 | InnoDB | MyISAM |
|------|--------|--------|
| 事务 | 支持 | 不支持 |
| 锁 | 行锁 | 表锁 |
| 崩溃恢复 | 靠 redo 自动恢复 | 容易损坏 |
| 索引 | 聚簇索引 | 索引存行地址 |
| `COUNT(*)` | 要扫描索引 | 直接返回存好的行数 |

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#七、存储引擎对比)

### Q17：InnoDB 为什么推荐自增主键？不定义主键会怎样？

**一句话**：数据按主键顺序存放。自增主键让新行总是加在最后，不用在中间插队挪数据（页分裂）；主键短，所有二级索引也更小。随机主键（如 UUID v4）会到处插，页分裂多、空间浪费大。

- 分布式下要全局唯一又大致递增：用雪花 ID、号段或 UUID v7
- 自增 ID 不连续是正常的（回滚、批量插入都会跳号），不要拿它当业务序号
- 不定义主键：InnoDB 先找一个非空唯一索引当主键，找不到就用隐藏的 6 字节 row_id
- 没有主键的表在主从复制时，每次行变更从库都要全表扫描找行，造成复制延迟

→ 详见 [MySQL 索引](/database/1_mysql/4_topic_index#_1、聚簇索引-clustered-index)

### Q18：什么是页？InnoDB 的存储层次和行溢出是怎样的？

**一句话**：页是 InnoDB 读写磁盘和缓存数据的最小单位，默认 16KB，B+ 树的一个节点就是一页。层次从大到小是：表空间 → 段 → 区 → 页 → 行。

- 表空间：通常每张表一个 `.ibd` 文件，存这张表的数据和索引
- 段：每个索引分叶子段和非叶子段；区：64 个连续页（1MB），让相关的页在磁盘上挨着
- 行溢出：一页至少放两行，单行超过约 8KB 时，最长的变长字段整个挪到单独的溢出页，行里只留一个指针
- 页大小只能在初始化实例时设定，之后不能改

**常见坑**：大字段（富文本、大 JSON）拆到附表，否则每页放的行变少，读的时候还要额外读溢出页。

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#一、表空间层次-段、区、页、行)

### Q19：Buffer Pool 如何管理内存？Double Write 解决什么问题？MySQL 偶尔「抖」一下是什么原因？

**一句话**：Buffer Pool 是 InnoDB 在内存里缓存数据页的地方，用改进的 LRU 淘汰旧页。修改过的页（脏页）由后台慢慢写回磁盘；redo 快写满或空闲页不够时被迫集中写回，就是 MySQL 偶尔「抖一下」的常见原因。

- 改进的 LRU：新读进来的页先放在「冷区」，过 1 秒后再被访问才进「热区」，防止一次全表扫描把热数据挤掉
- Double Write：16KB 的页写到一半断电，这页就坏了，redo 也没法在坏页上恢复；所以先把页完整写一份副本，坏了就用副本修
- 调优：`innodb_buffer_pool_size` 设为物理内存的 50%～75%；redo 容量留足；`innodb_io_capacity` 按磁盘能力设置

→ 详见 [InnoDB 存储结构](/database/1_mysql/8_topic_innodb#三、buffer-pool)

## 五、SQL 执行与优化

### Q20：一条 SQL 的执行流程是什么？SELECT 和 UPDATE 有何不同？

**一句话**：连接器验证身份 → 分析器检查语法和表、列是否存在 → 优化器选索引和 JOIN 顺序 → 执行器调用存储引擎取数据。UPDATE 多了写的步骤：加锁、写 undo、改内存里的页、写 redo 和 binlog，提交时走两阶段提交（见 Q5）。

- 查询缓存在 8.0 已经删除
- 连接空闲超过 `wait_timeout`（默认 8 小时）会被服务端断开
- 优化器靠统计信息估算成本，统计信息不准就可能选错索引（见 Q22）
- 为什么不直接改磁盘上的数据：那是随机写，很慢；先顺序写日志（WAL，先写日志后写数据），数据页由后台慢慢刷

→ 详见 [SQL 执行流程](/database/1_mysql/6_topic_execution#二、各组件职责)

### Q21：EXPLAIN 各字段的含义？type 从好到差的顺序是什么？

**一句话**：重点看四样：`type`（怎么访问表）、`key`（用了哪个索引）、`rows`（估计扫多少行）、`Extra`（有没有回表、额外排序、临时表）。type 常见的从好到差是 `const` > `eq_ref` > `ref` > `range` > `index` > `ALL`，核心查询至少要到 `range`。

- `key_len`：看联合索引实际用到了几列
- Extra 里 `Using index` 是覆盖索引；`Using filesort` 是额外排序；`Using temporary` 用了临时表
- `index` 是扫整个索引，`ALL` 是扫全表，都要警惕
- `EXPLAIN ANALYZE` 会真正执行语句，给出实际耗时和行数，能和估算对比

**常见坑**：`Using filesort` 不一定是磁盘排序，数据超过排序缓冲区才会落盘。

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#一、explain-字段总览)

### Q22：慢查询如何定位？优化器选错索引怎么办？

**一句话**：打开慢查询日志 → 用 `pt-query-digest` 按总耗时找出最该优化的 SQL → 用 `EXPLAIN` 看执行计划。选错索引时从轻到重处理：更新统计信息、建直方图、加索引提示，最后才 `FORCE INDEX`。

- 慢日志：`slow_query_log=1`，`long_query_time` 设到 1 秒或更低
- 正在跑的语句看 `SHOW PROCESSLIST`；历史 TOP 语句看 `sys.statement_analysis`
- `ANALYZE TABLE` 更新统计信息；数据分布不均的列建直方图，让优化器估得更准
- 补合适的联合索引、改写 SQL，通常比强制指定索引更长久

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#四、慢-sql-定位)、[SQL 执行流程](/database/1_mysql/6_topic_execution#_4、优化器)

### Q23：`COUNT(*)`、`COUNT(1)`、`COUNT(字段)` 的区别？

**一句话**：`COUNT(*)` 和 `COUNT(1)` 一样快，都是数行数；`COUNT(主键)` 要取出主键值，稍慢；`COUNT(普通字段)` 只数不为 NULL 的值，意思都不一样。

- InnoDB 不存总行数：不同事务看到的行数可能不同（MVCC），所以 `COUNT(*)` 必须扫描
- 没有 WHERE 时，MySQL 会挑最小的索引来扫，比扫主键索引快
- 大表要总数：能接受近似值就用 `information_schema.TABLES` 的估算值；要精确又频繁，就单独维护一张计数表

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#六、count-的性能)

### Q24：JOIN 是怎么执行的？8.0.20 之后 BNL 去哪了？

**一句话**：被关联的表在关联字段上有索引时，驱动表每一行都拿去索引里查一次（Index Nested-Loop）；没有索引时，8.0.18 起用 Hash Join：把小的一边放进内存建哈希表，另一边逐行去查。8.0.20 起 Hash Join 完全取代了老的 BNL（块嵌套循环）。

- EXPLAIN 显示 `Using join buffer (hash join)`，说明被关联的表没有可用索引
- 给关联字段加索引，比依赖 Hash Join 更好
- 「小表驱动大表」的「小」指过滤后参与 JOIN 的数据量，优化器一般能选对
- 关联字段的类型、字符集要一致，否则索引失效

→ 详见 [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#七、join-原理与优化)

### Q25：大表 DDL 为什么会卡住整张表？Online DDL 和 gh-ost 怎么选？

**一句话**：改表结构要拿表的元数据写锁（MDL），只要有没提交的事务访问过这张表，DDL 就得等；而 DDL 一排队，后面所有读写这张表的请求都排在它后面，整张表就卡住了。真正危险的往往是等锁，不是 DDL 本身。

| 方式 | 做法 | 能否同时读写 |
|------|------|-------------|
| INSTANT | 只改元数据，秒完成 | 能 |
| INPLACE | 引擎内部完成，可能重建表 | 大多能 |
| COPY | 建新表逐行复制 | 不能 |

- 加列、删列在 8.0.29 起是 INSTANT；改列类型、改字符集要 COPY
- 执行前先查长事务，并把 DDL 会话的 `lock_wait_timeout` 设短，等不到就放弃，别堵住业务
- 千万行以上要重建的表用 gh-ost（读 binlog 同步增量、可限速）或 pt-online-schema-change（用触发器同步）

→ 详见 [MySQL 避坑指南](/database/1_mysql/3_fallible_point#七、大表-ddl-与-online-ddl)

## 六、主从与高可用

### Q26：MySQL 主从复制的原理？binlog 有哪几种格式？

**一句话**：主库把变更写进 binlog；从库的接收线程把 binlog 拉过来存成 relay log（中继日志），再由回放线程执行一遍。默认是异步复制。binlog 有 ROW、STATEMENT、MIXED 三种格式，只推荐 ROW。

| 格式 | 记录什么 | 现状 |
|------|---------|------|
| ROW | 每行改前改后的数据 | 默认，CDC 依赖它 |
| STATEMENT | SQL 原文 | `NOW()`、`UUID()` 等可能导致主从不一致 |
| MIXED | 自动切换 | 遗留格式 |

- 从库默认多线程并行回放
- 8.4 删除了所有 MASTER / SLAVE 语法，改用 `CHANGE REPLICATION SOURCE TO`、`START REPLICA`、`SHOW REPLICA STATUS`

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#二、复制原理)

### Q27：GTID 和半同步复制分别解决什么问题？

**一句话**：GTID 给每个事务一个全局编号，切换主库时从库能自动知道从哪接着复制，不用人工找 binlog 文件和位置。半同步解决异步复制下主库宕机丢最后几笔事务的问题：主库提交时至少等一个从库确认收到。

| 等待时机 | 主库什么时候等 | 切换后 |
|---------|-------------|-------|
| `AFTER_SYNC`（默认） | 写完 binlog、提交前 | 不会出现「旧主读到过、新主没有」 |
| `AFTER_COMMIT` | 提交后、返回客户端前 | 可能别人读到了，新主上却没有 |

- GTID 格式是 `源库 UUID:序号`，开启自动定位用 `SOURCE_AUTO_POSITION=1`
- 半同步等太久（默认 10 秒）会自动退回异步，要监控这种降级

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#三、gtid-复制)

### Q28：主从延迟的原因和解决办法？为什么 `Seconds_Behind_Source` 不可靠？

**一句话**：延迟主要来自主库的大事务和大表 DDL、从库回放不够并行、从库在跑大查询、没有主键的表。解决办法是拆小事务、所有表加主键、开多线程回放；业务上对实时性要求高的读走主库。

- 无主键表：ROW 格式下每改一行，从库都要全表扫描找这一行
- `Seconds_Behind_Source` 只看正在回放的事件，回放线程空闲时显示 0，哪怕事件根本没传过来
- 更准的监控：用 `pt-heartbeat` 在主库定时写心跳时间，从库读出来比较
- 读己之写：拿到自己事务的 GTID，从库读前用 `WAIT_FOR_EXECUTED_GTID_SET` 等它回放完

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#五、复制延迟与多线程回放)

### Q29：MySQL 有哪几种高可用方案？

**一句话**：自建首选官方的 InnoDB Cluster（组复制 MGR + MySQL Shell + MySQL Router），自动选主、切换不丢已提交事务；跨地域再加 ClusterSet；上云直接用托管服务。MHA 多年没更新，不建议新建。

| 方案 | 特点 |
|------|------|
| 主从 + 半同步 + 切换工具 | 灵活，切换和防脑裂要自己保证 |
| InnoDB Cluster | 多数派确认，自动选主，官方首选 |
| InnoDB ClusterSet | 多个 Cluster 跨地域容灾 |
| InnoDB ReplicaSet | 异步复制，手动切换 |
| 云托管（RDS、Aurora 等） | 看切换时间和丢数据承诺 |

- MGR 默认单主，最多 9 个成员，成员应在同一地域
- 读写分离：应用内用 ShardingSphere-JDBC，或用 MySQL Router、ProxySQL 做代理

→ 详见 [MySQL 主从与高可用](/database/1_mysql/9_topic_replication#六、高可用方案)

### Q30：MySQL 8.0 停止支持后如何升级？8.4 LTS 有哪些需要注意的变化？

**一句话**：8.0 已在 2026 年 4 月停止维护，应升级到 8.4 LTS，之后再到 9.7 LTS；只能一个 LTS 一个 LTS 地升，不能跳。8.4 的风险主要是删掉了一些语法和配置，以及 InnoDB 默认值变了。

- 复制语法：MASTER / SLAVE 全部删除，监控脚本、高可用组件、CDC 工具要先确认兼容
- 配置项：`expire_logs_days` 等已删除，留在 my.cnf 里会启动失败
- 认证：`mysql_native_password` 默认不加载，先升级驱动，再把账号改成 `caching_sha2_password`
- 默认值：Change Buffer、自适应哈希索引默认关闭，`innodb_io_capacity` 调大，要在预发环境压测
- 步骤：用 MySQL Shell 的 `util.checkForServerUpgrade()` 预检 → 清理配置 → 先升从库再切主

**常见坑**：8.4 不能原地降回 8.0，回退只能靠备份或逻辑复制。

→ 详见 [MySQL 版本特性](/database/1_mysql/1_feature#七、8-0-升级到-8-4-的检查清单)

## 七、PostgreSQL

### Q31：PostgreSQL 与 MySQL 的关键差异？如何选择？

**一句话**：最根本的区别在存储方式：PG 的数据放在堆表里，所有索引都直接指向行的物理位置，没有聚簇索引；旧版本数据留在表里，靠 VACUUM 清理；每个连接是一个进程。功能上 PG 的 SQL 支持、JSONB 和扩展更强。

| 对比 | MySQL InnoDB | PostgreSQL |
|------|-------------|------------|
| 存储 | 聚簇索引 | 堆表 |
| 默认隔离级别 | RR | RC |
| 旧版本清理 | undo + purge | VACUUM |
| 连接 | 每连接一个线程 | 每连接一个进程，要配连接池 |
| DDL 能否回滚 | 不能 | 大多能 |

- 常规业务、团队熟 MySQL、分库分表和 CDC 工具成熟 → MySQL
- 复杂查询、地理信息、JSON 文档、向量检索 → PostgreSQL（PostGIS、pgvector 等扩展）

**常见坑**：从 MySQL 迁到 PG，表名、列名不加双引号会一律变成小写。

→ 详见 [PostgreSQL 基础](/database/2_postgresql/0_overview#二、与-mysql-的差异-java-开发视角)

### Q32：PG 的 MVCC 与 InnoDB 有何不同？RR 下什么时候会报 40001？

**一句话**：InnoDB 是直接改行，旧值放进 undo；PG 不改旧行，UPDATE 等于把旧行标记为作废、再插入一行新的。PG 的 RR 下，要改的行在你开始之后被别人改过并提交了，就直接报 40001 错误，而不是像 InnoDB 那样基于最新值接着改。

| 场景 | InnoDB RR | PostgreSQL RR |
|------|----------|---------------|
| 防幻读 | 快照读 + 间隙锁 | 快照本身就没有幻读，不需要间隙锁 |
| 并发改同一行 | 读最新版本继续改 | 报 40001，应用重试 |

- PG 默认 RC：遇到并发更新会等对方提交，然后基于新值重新判断条件再改，不报错
- Java 里在 RR / SERIALIZABLE 下捕获 40001，在事务方法外层重试整个事务
- PG 的行锁记在行上，不占内存锁表，锁再多行也不会升级

→ 详见 [MVCC 与 VACUUM](/database/2_postgresql/2_topic_mvcc#三、隔离级别-写给-mysql-用户)

### Q33：VACUUM 解决什么问题？HOT 更新、表膨胀和 XID 回卷怎么处理？

**一句话**：PG 的 UPDATE、DELETE 会留下作废的旧行，VACUUM 负责把它们的空间回收复用，还负责「冻结」老数据。清理不及时会导致表膨胀，严重时事务 ID 用完（XID 回卷），数据库会停止写入。

- HOT 更新：没改被索引的列、页里还有空位时，新版本放同一页，不用改索引；更新频繁的表可设 `fillfactor=85` 预留空间
- 表膨胀：热点表把 autovacuum 调得更勤；已膨胀的大表用 `pg_repack` 在线重建
- XID 回卷：事务 ID 只有 32 位会绕回，要监控 `age(datfrozenxid)`
- 清理卡住的常见原因：长事务、废弃的复制槽；用 `idle_in_transaction_session_timeout` 限制长事务

**常见坑**：不要关闭 autovacuum；`VACUUM FULL` 会锁全表，只能在停服窗口用。

→ 详见 [MVCC 与 VACUUM](/database/2_postgresql/2_topic_mvcc#五、vacuum)

### Q34：GIN、GiST、BRIN 等索引分别适合什么场景？

**一句话**：B-tree 是默认，管等值、范围、排序；GIN 是倒排索引，管「包含」类查询（JSONB、数组、全文检索）；GiST 管地理位置和范围重叠；BRIN 只记每一块数据的最小最大值，适合按时间追加的超大表。

| 查询特征 | 推荐 |
|---------|------|
| 等值、范围、排序 | B-tree |
| JSONB 任意属性、数组包含、全文检索 | GIN |
| 地理位置、范围重叠、最近邻 | GiST |
| 超大只追加表按时间范围查 | BRIN |
| 只有少部分行会被查 | 部分索引 |

- GIN 查得快、写入代价高
- `LIKE '%xx%'` 可用 GIN + `pg_trgm` 扩展

**常见坑**：生产建索引用 `CREATE INDEX CONCURRENTLY`，失败会留下无效索引，要手动删掉重建。

→ 详见 [PostgreSQL 索引类型](/database/2_postgresql/3_topic_index#九、如何选择)

### Q35：PG 的流复制和逻辑复制有什么区别？`synchronous_commit` 和复制槽要注意什么？

**一句话**：PG 只有一种日志 WAL，既管崩溃恢复也管复制，没有 binlog。流复制把 WAL 原样传过去，备库和主库一模一样、只读，用于高可用；逻辑复制把 WAL 解析成行变更，可以只同步部分表、跨大版本，用于升级、数据分发和 CDC。

- `synchronous_commit`：控制提交时等到哪一步，从「不等本地落盘」到「等备库重放完」分好几档，默认 `on` 是等同步备库落盘
- 只有配置了同步备库才会等；只配一个同步备库时，它挂了主库的提交会全部卡住
- 复制槽会为消费者保留 WAL，消费者一直不来，WAL 就一直堆到磁盘写满；用 `max_slot_wal_keep_size` 设上限
- 逻辑复制不同步 DDL 和序列的当前值
- 故障切换要靠外部工具，主流是 Patroni

→ 详见 [PostgreSQL 复制与高可用](/database/2_postgresql/5_topic_replication#二、wal-与流复制)

## 八、分布式数据库与分库分表

### Q36：什么时候需要分库分表？分片键如何选择？

**一句话**：分库分表是最后一招。先优化索引和 SQL、加缓存、读写分离、归档冷数据，单库的容量、写入量或连接数确实扛不住了再拆。分片键选最常用的查询条件里分布均匀、不会修改的字段，比如 user_id。

- 垂直拆分：按业务拆成不同的库
- 水平拆分：按分片键把一张表的行分散到多个库表
- 分片键选得好，大部分查询只落到一个分片
- 不按分片键的查询：用映射表、冗余表或搜索引擎

→ 详见 [高并发面试题解答](/interview/13_high_con#q24-什么时候需要分库分表-分片键如何选择)、[数据层扩展](/high-con/5_data_scaling#四、分库分表)

### Q37：ShardingSphere-JDBC 和 Proxy 有什么区别？跨分片查询和事务如何处理？

**一句话**：JDBC 版是应用里的一个 jar，当作数据库驱动用，没有额外网络开销，只支持 Java；Proxy 版是独立部署的数据库代理，任何语言都能连，方便统一管理，但多一跳网络、要自己做高可用。常见做法是应用用 JDBC 版，DBA 用 Proxy 版。

| 对比 | JDBC | Proxy |
|------|------|-------|
| 形态 | 应用内 jar | 独立服务 |
| 语言 | 只支持 Java | 任意 |
| 性能 | 无额外网络开销 | 多一跳 |

- 跨分片查询：SQL 改写后发给各分片并行执行，再合并结果；不带分片键就要查所有分片
- 跨分片分页：`LIMIT 100, 10` 会变成每个分片都查 `LIMIT 0, 110`，深分页要改成游标分页
- 事务：支持本地事务、XA 和柔性事务（Seata），只管同一个 ShardingSphere 实例里的数据源

→ 详见 [分库分表与中间件](/database/5_practice/2_sharding#二、两种接入形态)

### Q38：TiDB 的数据如何分片与复制？事务和 MySQL 有什么不同？

**一句话**：TiDB 分三层：TiDB Server 负责计算 SQL，TiKV 负责存数据，PD 负责调度。数据按主键范围切成一个个 Region（默认 256 MiB），每个 Region 有多个副本用 Raft 协议保持一致，PD 负责拆分和搬迁 Region。

- 隔离级别：RR 实际是快照隔离，没有间隙锁；靠 `FOR UPDATE` 锁范围防插入的写法要改成唯一约束
- 自增 ID：唯一但不连续；写入热点用 `AUTO_RANDOM`
- 不支持存储过程、触发器、自定义函数
- 大事务有大小限制，批量写入要分批提交

**常见坑**：单调递增的主键会让写入都集中到最后一个 Region，形成热点。

→ 详见 [分布式数据库](/database/3_relational/1_distributed_db#一、tidb)

### Q39：分库分表和分布式数据库怎么选？TiDB、OceanBase、Aurora / PolarDB 有什么区别？

**一句话**：分库分表复用成熟的 MySQL，成本低，但跨分片 JOIN、事务、扩容都要业务和中间件自己扛；分布式数据库把这些做进了数据库内部，对业务透明，代价是新的运维体系和更多资源。分片键清楚、查询模式稳定就分库分表；要跨分片强一致事务或透明扩容就选分布式数据库。

| 对比 | TiDB | OceanBase | Aurora / PolarDB |
|------|------|-----------|-----------------|
| 架构 | 多节点各存一部分 | 多节点各存一部分 | 计算和存储分离，共享存储 |
| 兼容 | MySQL | MySQL；企业版兼容 Oracle | MySQL / PostgreSQL |
| 写扩展 | 加节点 | 加节点 | 一般只有一个写节点 |
| 典型场景 | MySQL 扩容、HTAP | 金融核心、Oracle 迁移 | 读多写少、从 RDS 升级 |

**常见坑**：单表千万级、单库扛得住时，先优化索引、归档和加缓存，不急着上分库分表或分布式数据库。

→ 详见 [分布式数据库](/database/3_relational/1_distributed_db#三、tidb-与-oceanbase-选型对比)、[分库分表与中间件](/database/5_practice/2_sharding#八、选型建议)

## 九、NoSQL 与选型

### Q40：MongoDB 如何建模？多文档事务有哪些限制？

**一句话**：一起读的数据就放一起：一对一、一对少量且一起读写的子数据直接内嵌（订单和订单项），一对大量、多对多或要单独访问的用引用（用户和订单）。单个文档的写入本身是原子的，能内嵌就能避开多文档事务。

- 单文档上限 16MB，会不断增长的数组（评论、日志）不要内嵌
- 多文档事务：默认要在 60 秒内完成，官方建议一次不超过 1000 个文档，冲突时要重试
- 写入默认要多数节点确认（`w: "majority"`）；从从节点读可能读到旧数据
- 分片键要覆盖主要查询条件；单调递增的键做范围分片会形成写热点

→ 详见 [文档数据库](/database/4_nosql/2_document_db#二、文档建模)

### Q41：Elasticsearch 为什么能快速全文检索？写入后为什么不能立刻搜到？

**一句话**：ES 用的是倒排索引，就像书后面的索引页：从「词」直接查到「包含它的文档列表」，不用逐篇扫描。写入的数据先在内存里，要等 refresh（默认每 1 秒一次）生成新的段文件后才能被搜到，所以叫「近实时」。

- 写入先进内存缓冲，同时写 Translog（事务日志）保证不丢
- refresh：生成新段、可以被搜到；flush：把段真正写到磁盘并清空 Translog
- 后台会合并小段，删除的文档在合并时才真正清除
- 中文分词：默认分词器把中文切成单字，要用 IK 等中文分词插件

**常见坑**：主分片数建好后不能直接改，规划时要留余量。

→ 详见 [搜索数据库](/database/4_nosql/3_search_db#_3、倒排索引)、[搜索数据库](/database/4_nosql/3_search_db#_1、写入链路)

### Q42：ES 深分页怎么做？数据如何从数据库同步到 ES？

**一句话**：`from + size` 默认最多翻到第 10000 条，越往后越慢；翻页用 `search_after` 配合 PIT（固定一个时间点的视图），`scroll` 只用于离线导出。同步数据时以数据库为准，通过 CDC 或消息队列捕获变更，再写入 ES。

- `search_after`：带上上一页最后一条的排序值往后查，和游标翻页一个思路
- 同步：Outbox、MQ 或 CDC 捕获变更，组装成完整文档写入 ES
- 消息可能乱序或重复：用版本号或更新时间，旧版本不覆盖新版本
- 全量重建：建新索引，导完后用别名一次切过去

**常见坑**：在业务代码里同时写数据库和 ES（双写），一边失败就不一致，优先用 CDC 或可靠消息。

→ 详见 [搜索数据库](/database/4_nosql/3_search_db#_3、深分页)、[搜索数据库](/database/4_nosql/3_search_db#六、数据同步)

### Q43：HBase、ClickHouse、Doris / StarRocks 有什么区别？ClickHouse 为什么不适合频繁更新？

**一句话**：HBase 是按行键排序的超大 KV 存储，擅长海量数据按 key 随机读写；ClickHouse、Doris、StarRocks 是列式分析数据库，每列单独存、压缩率高，擅长大范围统计。ClickHouse 每次写入都生成一个不可修改的数据块，改和删只能打标记或重写整块，所以不适合频繁更新。

| 对比 | 擅长 |
|------|------|
| HBase | 海量数据按 key 读写 |
| ClickHouse | 单张大宽表的分析，速度最快 |
| Doris / StarRocks | 多表 JOIN、实时更新、兼容 MySQL 协议 |

- ClickHouse 写入要攒批：每次至少 1000 行，最好 1 万～10 万行
- HBase 的行键单调递增会形成写热点，用哈希前缀或加盐打散

→ 详见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db#四、选型对比)

### Q44：时序数据为什么不用 MySQL 存？什么时候需要图数据库？

**一句话**：时序数据写得多、按时间追加、按时间段统计、过期按时间整批删。MySQL 扛不住这么高频的写入，按时间删数据要 DELETE 海量行，压缩也差；时序数据库在这些方面都专门做了优化。图数据库适合查多层关系，比如「朋友的朋友的朋友」，关系型数据库每多一层就多一次 JOIN。

| 场景 | 推荐 |
|------|------|
| 系统监控告警 | Prometheus |
| 已经在用 PostgreSQL | TimescaleDB |
| 工业 IoT、设备采集 | TDengine、IoTDB |
| 社交关系、风控团伙 | Neo4j、NebulaGraph |

- 关系只有一两层时，用 SQL 的递归查询就够了，不必上图数据库

**常见坑**：时序数据库里把 user_id、订单号这种取值很多的字段当标签，序列数会爆炸。

→ 详见 [时序数据库](/database/4_nosql/1_time_series_db#六、选型对比)、[图数据库](/database/4_nosql/4_graph_db#五、选型对比)

## 十、连接池、CDC 与备份

### Q45：连接池大小怎么设？`maxLifetime`、`keepaliveTime` 与 `wait_timeout` 是什么关系？

**一句话**：连接池不是越大越好。经验公式「数据库 CPU 核数 × 2 + 磁盘数」算的是数据库那边总共需要的活跃连接数，要分给所有应用实例。`maxLifetime` 要比数据库和防火墙的空闲超时都短，否则池里会留着已经被断开的连接。

- 例子：数据库 16 核 SSD，总共约 33 个连接，4 个应用实例每个配 8～10 个就够
- 所有实例的连接池加起来（包括扩容后）不要超过数据库 `max_connections` 的约 80%
- `keepaliveTime` 要小于所有空闲超时中最短的那个，定期探活
- 池被用光时：先查慢 SQL 和长事务，再看是否连接泄漏（`leakDetectionThreshold` 可以定位）

**常见坑**：报 Communications link failure，多半是连接被数据库或防火墙断了，池里还在用。

→ 详见 [数据库连接池](/database/5_practice/3_connection_pool#_4、池大小估算)、[高并发面试题解答](/interview/13_high_con#q37-数据库连接池是不是越大越好-水平扩容时要注意什么)

### Q46：PostgreSQL 为什么需要 PgBouncer？transaction 模式有什么限制？

**一句话**：PG 每个连接是一个进程，开销大，一般只能开几百个连接，微服务实例一多就不够用。PgBouncer 把大量客户端连接复用到少量真实连接上；生产常用 transaction 模式，事务结束就归还连接，代价是不能用会话级的状态。

| 模式 | 什么时候归还真实连接 | 限制 |
|------|-----------------|------|
| `session`（默认） | 客户端断开时 | 没限制，但复用率低 |
| `transaction` | 事务结束时 | 不能用会话级 `SET`、`LISTEN`、跨事务的临时表等 |
| `statement` | 每条语句结束时 | 不能用多语句事务 |

- 会话级 `SET` 改用 `SET LOCAL`（只在当前事务内生效）
- 应用里仍保留 HikariCP 控制并发，PgBouncer 负责收拢到数据库的真实连接

**常见坑**：JDBC 预编译语句在旧版 PgBouncer 下会出错，要升级到 1.21 以上，或在 JDBC URL 加 `prepareThreshold=0`。

→ 详见 [数据库连接池](/database/5_practice/3_connection_pool#五、pgbouncer)

### Q47：基于 binlog 的 CDC 原理是什么？Canal、Debezium、Flink CDC 怎么选？

**一句话**：CDC 工具把自己伪装成一个从库，从 MySQL 拉取 binlog，解析出每行改前改后的数据，转成事件发给下游。前提是 binlog 为 ROW 格式、账号有复制权限、`server_id` 不和别的从库重复。

| 工具 | 形态 | 适合 |
|------|------|------|
| Canal | 独立服务，可投递到 MQ | 已有 Canal 体系、只同步 MySQL |
| Debezium | Kafka Connect 连接器 | 已有 Kafka、多种数据库、Outbox |
| Flink CDC | Flink 数据源 | 实时计算、整库入仓入湖 |

- 消息至少投递一次，可能重复，下游必须幂等（按主键 upsert 或按版本号去重）
- 按主键分区，保证同一行的变更按顺序处理
- binlog 保留时间要比 CDC 可能停机的时间长

**常见坑**：`server_id` 重复时两个客户端会互相把对方踢下线、反复重连。

→ 详见 [CDC 工具](/database/5_practice/0_cdc_tools#一、工具对比)、[Flink CDC](/flink/6_cdc)

### Q48：如何设计 MySQL / PostgreSQL 的备份与时间点恢复（PITR）？

**一句话**：备份方案由两个目标决定：最多能丢多少数据（RPO）、最多多久恢复（RTO）。基本做法是「定期全量备份 + 持续归档日志」：全量提供起点，再用 binlog / WAL 把数据补到任意时间点。没做过恢复演练的备份等于没有备份。

| 对比 | MySQL | PostgreSQL |
|------|-------|-----------|
| 逻辑备份 | `mysqldump --single-transaction` | `pg_dump` |
| 物理备份 | XtraBackup、CLONE 插件 | `pg_basebackup` |
| 日志归档 | 持续保存 binlog | `archive_command` 归档 WAL |
| 恢复到时间点 | 全量恢复后用 `mysqlbinlog` 重放到指定时间 | 设置 `recovery_target_time` 恢复 |

- 大库用物理备份，恢复快；逻辑备份用于跨版本迁移、单表恢复
- 3-2-1 原则：3 份副本、2 种介质、1 份异地

**常见坑**：PG 做时间点恢复时忘了创建 `recovery.signal` 文件，数据库会正常启动并忽略所有恢复参数。

→ 详见 [数据备份与恢复](/database/5_practice/1_backup_recovery)

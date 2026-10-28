---
description: WAL 与崩溃恢复、B+ 树、LSM-Tree、Compaction、读写放大与 RUM、RocksDB、选型
---

# 存储引擎：B+ 树与 LSM-Tree

> 前置阅读：[树](/algorithms/1_data_structures/3_tree)、[文件系统与磁盘 IO](/os/7_file_io)、[内存管理与 Page Cache](/os/3_memory)

存储引擎决定一条数据怎么写进磁盘、怎么被找回来，主流只有原地更新的 B+ 树和追加写的 LSM-Tree 两大流派。本篇讲两种结构的原理、Compaction 与读写放大，以及各数据库的取舍，基线为 MySQL 8.4 与 RocksDB 10。

---

## 一、存储引擎要解决什么

### 1、三件事：写、读、不丢

存储引擎对上层只提供几个接口：按 key 写入、按 key 读取、按范围扫描、删除。难点在于同时满足三个要求：

| 要求 | 含义 | 难在哪里 |
|------|------|----------|
| 写得快 | 每秒能接住多少次写入 | 磁盘随机写慢，每次都把数据放到「正确位置」代价高 |
| 读得快 | 点查和范围查要几次 IO | 数据越有序越好读，但维持有序需要写时付出代价 |
| 不丢 | 提交成功的数据断电后还在 | 内存里的修改随时可能丢，刷盘又慢 |

B+ 树和 LSM-Tree 的分歧就在第一、二行：B+ 树写时就把数据放到最终位置，读最省事；LSM-Tree 写时只管追加，把整理工作推迟到后台。

### 2、WAL 与崩溃恢复

两种结构都靠 **WAL（Write-Ahead Log，预写日志）** 保证不丢：修改数据结构之前，先把「改了什么」顺序追加到日志文件并 `fsync`，然后才返回成功。

- 数据页或内存表可以晚一点刷盘，断电时内存里的修改虽然丢了，重启后重放 WAL 即可恢复
- WAL 是纯追加写，比把数据页写回原位快得多，这也是「先写日志」划算的原因
- 日志不能无限增长，需要 **检查点（Checkpoint）**：确认某个位置之前的修改都已落到数据文件，之前的日志就可以回收

InnoDB 的 WAL 叫 redo log，RocksDB / LevelDB 直接叫 WAL，HBase 叫 HLog。InnoDB 的 redo、undo 与 Double Write 细节见 [InnoDB 存储结构](../1_mysql/8_topic_innodb#四、double-write)；`fsync` 到底保证到哪一层见 [内存管理与 Page Cache](/os/3_memory#五、write、fsync-与脏页回写) 与 [文件系统与磁盘 IO](/os/7_file_io#六、持久化语义)。

### 3、顺序 IO 与随机 IO

顺序写比随机写快得多：HDD 上差两个数量级，SSD 上差距变小，但大块顺序写的写放大最小、延迟最稳定。LSM-Tree 的全部设计都围绕「把随机写变成顺序写」展开，原理见 [为什么 Kafka 与 LSM 偏爱顺序写](/os/7_file_io#_5、为什么-kafka-与-lsm-偏爱顺序写)。

---

## 二、B+ 树

![B+ 树与 LSM-Tree：结构与写路径对比](../../assets/database/btree-vs-lsm-write.svg)

### 1、页、扇出与高度

B+ 树把数据切成固定大小的 **页（Page）**，页是读写磁盘的最小单位，也是树的一个节点：InnoDB 默认 16KB，PostgreSQL 8KB，SQLite 4KB。

- 内部节点只存「键 + 子页指针」，叶子节点存完整数据（或行指针），叶子之间用双向链表串起来
- **扇出（Fan-out）** 是一个内部节点能挂多少个子节点。16KB 页、BIGINT 主键时约 1000 多个，三层就能放两千万行级别的数据
- 树高通常只有 3～4 层，根和上层内部节点基本常驻内存，一次点查实际只读 1～2 个页

B+ 树作为数据结构与 B 树、红黑树的区别见 [树](/algorithms/1_data_structures/3_tree)；InnoDB 里三层能放多少行的推算见 [MySQL 索引](../1_mysql/4_topic_index#一、b-树数据结构)。

### 2、原地更新

B+ 树是 **原地更新（Update-in-place）** 结构：修改一行时，先从根找到它所在的叶子页，在页内改掉，页变成脏页，之后由后台线程把整页写回原位置。

- 改 100 字节也要写回整个 16KB 页，这是 B+ 树写放大的主要来源；InnoDB 为防止页写一半断电，还要再写一份 Double Write
- 脏页分散在文件各处，刷盘是随机写；写入量一大，刷脏跟不上就会出现周期性的抖动
- 好处是每个 key 只存一份，读的时候不用合并多个版本（MVCC 的历史版本另由 undo 或旧元组保存）

### 3、页分裂与合并

页的大小固定，插入时页满了就要 **页分裂（Page Split）**：申请新页，把一部分记录搬过去，再在父节点插入新的分隔键，父节点满了继续向上分裂。

- 主键递增时，新数据总落在最右边的页，InnoDB 会识别顺序插入，不做对半分裂，页几乎能填满
- 主键随机（如 UUID v4）时，插入落在任意页，频繁分裂导致页只填一半左右、空间浪费且产生大量随机写
- 删除使页利用率低于阈值时（InnoDB 默认 50%），会尝试与相邻页 **合并（Merge）**

这就是 InnoDB 推荐自增主键的原因，设计建议见 [MySQL 索引](../1_mysql/4_topic_index#十、索引设计原则)。

### 4、缓冲池

B+ 树引擎都有自己的页缓存，InnoDB 叫 **Buffer Pool**，PostgreSQL 叫 shared buffers。读页先查缓冲池，没有才读盘；写页只改缓冲池里的副本，由检查点和刷脏线程决定何时写回。缓冲池命中率直接决定 B+ 树的读性能，InnoDB 的 LRU 冷热分离与关键参数见 [InnoDB 存储结构](../1_mysql/8_topic_innodb#三、buffer-pool)。

### 5、为什么适合读多和范围查询

- **点查稳定**：任何 key 都是根到叶固定 3～4 层，延迟可预期，没有「多版本合并」的额外开销
- **范围查询快**：找到起点后顺着叶子链表往后读，数据在页内和页间都有序
- **一份数据一个位置**：便于加行锁、做唯一性检查，事务实现更直接

代价是写入要先读后写、随机写多，高并发写入时页分裂和刷脏会成为瓶颈。

---

## 三、LSM-Tree

LSM-Tree（Log-Structured Merge-Tree，日志结构合并树）由 O'Neil 等人在 1996 年提出，LevelDB 把它带进工程主流，RocksDB 在此基础上成为事实标准。核心思路是 **写入永远追加，有序化工作交给后台合并**。

![LSM-Tree 读写路径与多层 Compaction](../../assets/database/lsm-read-write-compaction.svg)

### 1、写路径

1. **追加 WAL**：顺序写日志，保证不丢
2. **写入 MemTable**：内存中的有序结构，通常是跳表，写入就是一次内存插入
3. **冻结**：MemTable 达到大小上限（RocksDB 默认 64MB）后变成 **不可变 MemTable（Immutable MemTable）**，同时新开一个 MemTable 接收写入
4. **Flush**：后台线程把不可变 MemTable 按 key 顺序整块写成一个 **SSTable（Sorted String Table）** 文件，放在 L0，对应的 WAL 随之可以删除

写入路径上没有任何随机磁盘写，也不用先读旧数据，所以 LSM 的写吞吐远高于 B+ 树。更新和删除也是追加：更新写一条新版本，删除写一条 **墓碑（Tombstone）** 标记，真正清理要等 Compaction。

### 2、SSTable 与多层结构

SSTable 一旦写完就不再修改，内部由三部分组成：

- **数据块**：按 key 有序排列的键值对，默认 4KB 一块，可单独压缩
- **块索引（Index Block）**：记录每个数据块的最后一个 key 和偏移量，查找时先二分索引再读一个数据块
- **过滤块（Filter Block）**：布隆过滤器，快速判断这个文件里「肯定没有」某个 key

文件按层组织：L0 由 Flush 直接产生，文件之间 key 范围可能重叠；L1 及以下每一层内部整体有序、文件之间 key 不重叠，且每层容量约为上一层的 10 倍。

### 3、读路径

点查一个 key 时，按「从新到旧」的顺序查找，找到就停：

1. 活跃 MemTable
2. 不可变 MemTable
3. L0 的所有文件（彼此重叠，只能逐个查，新文件优先）
4. L1 到 Ln，每层根据 key 范围最多定位到 1 个文件

最坏情况下一次点查要碰很多个文件，这就是 LSM 的读放大。范围查询更麻烦：需要对 MemTable 和每层的迭代器做多路归并，再跳过被覆盖的旧版本和墓碑。

### 4、布隆过滤器与块索引

让 LSM 读得不慢的关键是尽量不去读不相关的文件：

- **布隆过滤器（Bloom Filter）**：每个 SSTable 一个，判断「不存在」时一定准确，判断「可能存在」时才去读块索引和数据块。RocksDB 常用每个 key 10 bit，误判率约 1%，点查不存在的 key 时几乎不碰盘
- **块索引**：命中文件后只需读一个数据块，配合块缓存（Block Cache）把热点块留在内存
- 布隆过滤器只对点查有效，范围查询用不上（RocksDB 的前缀布隆可以覆盖固定前缀的扫描）

布隆过滤器的原理和在缓存防穿透中的用法见 [Redis 典型应用场景 · 布隆过滤器](/cache/4_redis_scenario#二、布隆过滤器)。

---

## 四、Compaction

Flush 只会不断产生新文件，如果不整理，读要查的文件越来越多，被覆盖的旧版本和墓碑也一直占着空间。**Compaction** 就是后台把多个 SSTable 读出来做归并排序，丢弃旧版本和已过期的墓碑，写出新的 SSTable。

### 1、Leveled 与 Tiered

两种主流策略的分歧在于「什么时候合并、合并多少」：

| 对比 | Leveled（分层） | Tiered / Size-tiered（分级） |
|------|------|------|
| 做法 | 每层只保留一个有序段，上层文件下推时与下层重叠的文件一起重写 | 每层攒够若干个大小相近的段再整体合并成一个更大的段推到下一层 |
| 写放大 | 高（常见 10～30 倍） | 低（大致等于层数） |
| 读放大 | 低，每层最多查 1 个文件 | 高，同层多个段都可能要查 |
| 空间放大 | 低，约 1.1 倍 | 高，合并期间可能临时翻倍 |
| 代表 | RocksDB 默认、LevelDB | Cassandra STCS、RocksDB Universal、HBase |
| 适合 | 读多、对磁盘空间敏感 | 写入极重、读较少 |

此外还有按时间窗口合并的策略（Cassandra TWCS、RocksDB FIFO），适合时序和带 TTL 的数据：整段过期后直接删文件，几乎没有合并开销。Cassandra 5 起提供统一压缩策略（UCS），可以在 Leveled 与 Tiered 之间按参数切换。

### 2、抖动与限速

Compaction 和前台请求抢同一块磁盘和 CPU，是 LSM 线上问题的主要来源：

- **IO 抖动**：大合并瞬间打满磁盘带宽，前台读写延迟出现毛刺
- **写停顿（Write Stall）**：写入速度长期超过 Compaction 速度时，L0 文件堆积或待合并数据超限，RocksDB 会主动降速甚至暂停写入，保护读性能不被拖垮
- **空间尖峰**：合并期间新旧文件同时存在，磁盘要预留余量

常见对策：用限速器（RocksDB `rate_limiter`）给后台 IO 设上限；增加后台线程数让合并跟得上；按业务低峰安排大合并（OceanBase 的每日合并就是这个思路，见 [分布式数据库](../3_relational/1_distributed_db#_4、存储引擎-lsm-tree-变体)）；监控 L0 文件数和待合并字节数并提前告警。

---

## 五、读写放大与 RUM 猜想

### 1、三种放大

衡量存储引擎的开销通常看三个比值：

- **读放大（Read Amplification）**：一次逻辑读实际读了多少个页或文件。B+ 树是树高，LSM 是需要检查的文件数
- **写放大（Write Amplification）**：写入磁盘的总字节数 ÷ 应用写入的字节数。B+ 树来自整页回写与 Double Write，LSM 来自同一数据在各层被反复 Compaction
- **空间放大（Space Amplification）**：磁盘实际占用 ÷ 有效数据量。B+ 树来自页内碎片与分裂后的半空页，LSM 来自尚未清理的旧版本和墓碑

写放大除了影响吞吐，还直接消耗 SSD 寿命，SSD 自身的写放大见 [文件系统与磁盘 IO](/os/7_file_io#_4、写放大)。

### 2、两种结构的对比

| 维度 | B+ 树 | LSM-Tree（Leveled） |
|------|------|------|
| 写入方式 | 先读页再原地改，随机写 | 追加 WAL + 内存表，顺序写 |
| 写放大 | 中，小行改动也写整页 | 高，但都是顺序大块写 |
| 点查 | 稳定，3～4 次页访问 | 依赖布隆过滤器和缓存，命中最新层时很快 |
| 范围查询 | 顺叶子链表，很快 | 多路归并，略慢 |
| 空间利用 | 页填充率 50%～100% | 压缩率高，旧版本占用临时空间 |
| 延迟抖动来源 | 刷脏、页分裂 | Compaction、写停顿 |
| 压缩 | 页级压缩效果有限 | 文件不可变，按块压缩效果好 |

### 3、RUM 猜想

2016 年 Athanassoulis 等人提出 **RUM 猜想**：读开销（Read）、更新开销（Update）、内存与空间开销（Memory）三者不可能同时做到最优，优化其中两个必然牺牲第三个。

- B+ 树偏向读，付出更新和空间的代价
- LSM-Tree 偏向写，付出读的代价；Leveled 与 Tiered 是在读和空间之间再做取舍
- 哈希索引点查和写入都快，但不支持范围查询，且索引要占大量内存

所以不存在「最好的存储引擎」，只有和读写比例、访问模式匹配的引擎。

---

## 六、谁用哪种

| 结构 | 产品 | 说明 |
|------|------|------|
| B+ 树 | MySQL InnoDB | 聚簇索引组织表，数据就挂在主键 B+ 树的叶子上，见 [InnoDB 存储结构](../1_mysql/8_topic_innodb) |
| B+ 树 | PostgreSQL | 数据存在无序的堆表（heap），索引默认是 B-tree；更新写新元组而非原地改，见 [MVCC 与 VACUUM](../2_postgresql/2_topic_mvcc) |
| B+ 树 | SQLite | 单文件嵌入式库，表和索引都是 B 树页 |
| LSM | LevelDB / RocksDB | LevelDB 是经典实现，RocksDB 是其工业级分支，见第七节 |
| LSM | HBase | WAL + MemStore + HFile，按 Region 拆分，见 [列式与 OLAP 数据库](/nosql/3_column_db#_4、读写流程-lsm-树) |
| LSM | Cassandra | 每个节点一套 LSM，传统默认 Size-tiered，适合多写少读的大规模集群 |
| LSM | TiKV | 每个节点的数据存进 RocksDB，上层用 Raft 复制，见 [分布式数据库](../3_relational/1_distributed_db#_3、tikv-region-与-raft) |
| LSM 变体 | InfluxDB 1.x / 2.x TSM | 针对时间序列优化的 LSM，按序列列式压缩，见 [时序数据库](/nosql/4_time_series_db) |
| LSM 变体 | ClickHouse MergeTree | 每次插入生成一个不可变的有序数据片段，后台合并；没有 MemTable，所以要求批量写，见 [列式与 OLAP 数据库](/nosql/3_column_db#_3、mergetree-引擎) |
| LSM 变体 | OceanBase | 增量 MemTable + 基线 SSTable，每日合并 |
| 两者 | WiredTiger | 引擎层面实现过 B 树和 LSM 两种表，MongoDB 实际使用其 B 树 |

一个经验规律：OLTP 关系库大多是 B+ 树，因为它们读多写少、需要稳定的点查和范围查询；分布式 KV、宽列、时序、日志类系统大多是 LSM，因为写入量巨大且以追加为主。

---

## 七、RocksDB：通用 LSM 引擎

### 1、为什么到处都是它

RocksDB 由 Facebook 在 2012 年基于 LevelDB 分支开发，提供列族、事务、多线程 Compaction、多种压缩策略和丰富的调优参数，以嵌入式库形式被大量系统当作底层存储：

- **TiKV**：每个节点用 RocksDB 存储 MVCC 数据
- **CockroachDB**：早期用 RocksDB，后来换成用 Go 重写、格式兼容 RocksDB 的 Pebble
- **Flink**：RocksDB 状态后端把大状态放在本地磁盘，Flink 2 新增基于它改造的分离式状态后端 ForSt，见 [Flink 状态与容错](/flink/4_state_checkpoint#_2、rocksdb-要点)
- **Kafka Streams**：持久化状态存储默认就是 RocksDB
- 其他：MyRocks（MySQL 的 RocksDB 引擎）、Ceph BlueStore 的元数据、各类自研 KV 与消息存储

RocksDB、TiKV、etcd 与嵌入式数据库的用法和选型见 [键值与嵌入式数据库](/nosql/1_kv_db)。

### 2、关键调优参数

| 参数 | 一句话 |
|------|------|
| `write_buffer_size` / `max_write_buffer_number` | 单个 MemTable 大小和最多几个，调大能吸收写入峰值，但占内存、拉长恢复时间 |
| `level0_file_num_compaction_trigger` | L0 攒几个文件开始合并（默认 4） |
| `level0_slowdown_writes_trigger` / `level0_stop_writes_trigger` | L0 文件数到多少开始降速、停写，写停顿时先看它 |
| `max_bytes_for_level_base` / `max_bytes_for_level_multiplier` | L1 的目标大小和逐层倍数（默认 10），决定层数与写放大 |
| `max_background_jobs` | Flush 和 Compaction 的后台线程数，合并跟不上时调大 |
| `rate_limiter` | 限制后台写盘速率，平滑 Compaction 带来的 IO 毛刺 |
| `compaction_style` | Level（默认）、Universal（即 Tiered）或 FIFO |
| `block_cache` | 数据块缓存大小，读性能的关键，多个实例可共享一个 |
| `filter_policy` | 布隆过滤器，常用每个 key 10 bit |
| `compression_per_level` | 上层用 LZ4 求速度，最底层用 ZSTD 求压缩率 |

调优顺序一般是：先看写停顿统计和 L0 文件数，再看各层大小与 Compaction 积压，最后才动缓存和压缩。

---

## 八、怎么选

### 1、按读写比例

- **读多写少、要范围查询和事务**：B+ 树。典型是订单、账户、商品等业务主库，用 MySQL 或 PostgreSQL
- **写多读少、数据追加为主**：LSM。典型是日志、埋点、监控指标、IoT 上报、消息与状态存储，用 HBase、Cassandra、时序库或 RocksDB
- **读写都重、要求水平扩展**：基于 LSM 的分布式数据库（TiDB、OceanBase、CockroachDB），用缓存和布隆过滤器弥补读放大
- **大批量写入后做聚合分析**：MergeTree 一类的列存 LSM 变体，如 ClickHouse

### 2、选型清单

- 写入峰值是多少，B+ 树的刷脏和页分裂能否扛住
- 读请求以点查为主还是范围扫描为主，点查是否大量查询不存在的 key
- 更新和删除多不多：LSM 下频繁覆盖和删除会积累旧版本与墓碑，扫描变慢
- 能否接受后台合并带来的延迟毛刺，P99 要求多严格
- 磁盘是 HDD 还是 SSD，空间是否紧张，是否在意 SSD 寿命
- 团队是否有能力调 LSM 参数；没有专门的存储团队时，成熟的 B+ 树关系库通常是更稳的默认选择

整体数据库选型（关系库、分布式库与各类 NoSQL）见 [数据库选型参考](./2_selection_guide)。

---

## 小结

- 存储引擎的核心矛盾是写入速度、读取速度与空间三者的取舍，两大流派都靠 WAL 保证提交后不丢
- B+ 树原地更新：页、扇出决定树高，页满分裂、过空合并，缓冲池决定读性能；点查稳定、范围查询快，代价是随机写和整页回写
- LSM-Tree 追加写：WAL + MemTable → 不可变 MemTable → SSTable，多层组织；写入全是顺序 IO，读要逐层查找，靠布隆过滤器、块索引和块缓存减少 IO
- Compaction 负责归并与清理，Leveled 读快省空间但写放大高，Tiered 写放大低但读和空间放大高；合并抖动和写停顿要靠限速与监控控制
- RUM 猜想说明读、写、空间不可兼得，选引擎就是选取舍
- OLTP 关系库多用 B+ 树，分布式 KV、宽列、时序和流计算状态多用 LSM，RocksDB 是最常见的通用 LSM 底座

## 参考资料

- Patrick O'Neil et al.：[The Log-Structured Merge-Tree (LSM-Tree)](https://www.cs.umb.edu/~poneil/lsmtree.pdf)
- Manos Athanassoulis et al.：[Designing Access Methods: The RUM Conjecture](https://stratos.seas.harvard.edu/files/stratos/files/rum.pdf)
- RocksDB Wiki：[Leveled Compaction](https://github.com/facebook/rocksdb/wiki/Leveled-Compaction)、[Universal Compaction](https://github.com/facebook/rocksdb/wiki/Universal-Compaction)
- RocksDB Wiki：[RocksDB Tuning Guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide)、[Write Stalls](https://github.com/facebook/rocksdb/wiki/Write-Stalls)
- RocksDB Wiki：[RocksDB Bloom Filter](https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter)
- MySQL 8.4 Reference Manual：[InnoDB On-Disk Structures](https://dev.mysql.com/doc/refman/8.4/en/innodb-on-disk-structures.html)
- Apache Cassandra Documentation：[Compaction](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/overview.html)

> 下一篇：[数据库选型参考](./2_selection_guide) —— 全景选型矩阵、按场景选型、经典组合架构、评估维度、常见误区

---
description: 表空间与页、行格式、Buffer Pool、Double Write、刷脏、8.4 默认值
---

# InnoDB 存储结构

> **本篇目标**：建立 InnoDB 从表空间、段、区、页到行的存储层次，弄清四种行格式与行溢出规则，理解 Buffer Pool 的冷热分离、Double Write 与刷脏机制，并掌握 MySQL 8.4 LTS 中与存储相关的默认值变化。
>
> **前置阅读**：[MySQL 索引](./4_topic_index)、[MySQL 事务与锁](./5_topic_transaction)

本篇以 MySQL 8.4 LTS 为基准，8.0 的差异单独标注。

---

## 一、表空间层次：段、区、页、行

### 1、存储层次

```sql
-- 8.0 起默认每张表独立表空间（*.ibd 文件）
SHOW VARIABLES LIKE 'innodb_file_per_table';  -- ON
```

| 层次 | 大小 | 说明 |
|------|------|------|
| **表空间（Tablespace）** | — | 独立表空间是一个 `.ibd` 文件，包含一张表的数据和索引 |
| **段（Segment）** | — | 逻辑概念：每个索引有一个**叶子节点段**（leaf node segment，常被称为数据段）和一个**非叶子节点段**（non-leaf node segment，常被称为索引段）；回滚段位于 undo 表空间 |
| **区（Extent）** | 1MB（页大小 ≤ 16KB 时） | 16KB 页时为 64 个连续页；按区分配让同一段的页物理相邻，利于顺序 IO |
| **页（Page）** | 默认 **16KB** | **磁盘 IO 的最小单位**，B+ 树的一个节点就是一页；`innodb_page_size` 可在初始化实例时设为 4K～64K，之后不能修改 |
| **行（Row）** | — | 按行格式存放在页内 |

三层 B+ 树能存多少行的估算见 [MySQL 索引](./4_topic_index)。

### 2、系统级文件

| 文件 | 位置与默认值 | 说明 |
|------|-------------|------|
| 系统表空间 | `ibdata1` | 8.0 起数据字典已迁到 `mysql.ibd`；系统表空间主要剩下 change buffer 等，`innodb_file_per_table=ON` 时用户表不在这里 |
| 通用表空间 | `CREATE TABLESPACE ... ADD DATAFILE` | 多张表共享一个文件，较少使用 |
| undo 表空间 | `undo_001`、`undo_002` | 8.0.14 起默认两个独立 undo 表空间，可用 `CREATE UNDO TABLESPACE` 增加；`innodb_undo_log_truncate` 默认 ON，超过 `innodb_max_undo_log_size`（默认 1GiB）时自动截断 |
| redo log | `#innodb_redo/` 目录 | 8.0.30 起由 `innodb_redo_log_capacity` 控制总容量（默认 100MiB），InnoDB 在该目录中维护 32 个文件，可在线调整 |
| Double Write 文件 | `#ib_16384_0.dblwr` 等 | 8.0.20 起从系统表空间独立出来，见第四节 |
| 临时表空间 | `ibtmp1`、`#innodb_temp/` | 全局临时表空间存放用户临时表的回滚段；会话临时表空间存放用户创建的临时表和优化器内部临时表 |

undo log 与 redo log 在事务中的作用见 [MySQL 事务与锁](./5_topic_transaction)，本篇只关心它们落在哪些文件。

---

## 二、行格式与行溢出

### 1、四种行格式

| 行格式 | 版本 | 变长大字段的存放方式 | 索引键前缀上限 |
|--------|------|-------------------|---------------|
| `REDUNDANT` | 最早的格式，兼容用 | 行内存前 768 字节，其余放溢出页 | 767 字节 |
| `COMPACT` | 5.0.3～5.7.8 的默认格式 | 同 REDUNDANT，但行头更紧凑（NULL 位图、变长字段长度列表） | 767 字节 |
| `DYNAMIC` | **5.7.9 起默认**（`innodb_default_row_format`） | 放得下就存在行内；放不下时整列移到溢出页，行内只留 20 字节指针；不超过 40 字节的 TEXT / BLOB 始终存在行内 | 3072 字节 |
| `COMPRESSED` | 需显式指定 | 与 DYNAMIC 相同的溢出方式，额外对页做 zlib 压缩 | 3072 字节 |

3072 字节是 16KB 页的上限；页大小为 8KB 时是 1536 字节，4KB 时是 768 字节。这个上限由行格式和页大小决定，与行溢出无关。

### 2、行溢出

- InnoDB 要求一页至少放两行，所以 16KB 页中单行（不含溢出部分）最大约 8KB
- 行超过这个大小时，InnoDB 会把最长的变长列（VARCHAR / VARBINARY / TEXT / BLOB）挪到溢出页，直到行能放进页内
- 另有一个与引擎无关的限制：MySQL 单行所有列定义的总长度不能超过 65535 字节（TEXT / BLOB 只计 9～12 字节）

工程启示：大字段（JSON 详情、富文本）**拆到附表**。即使 DYNAMIC 会把它们移出行，读取时仍要额外读溢出页，而且宽行会降低每页能放的行数。

---

## 三、Buffer Pool

### 1、结构

InnoDB 的核心内存区，缓存数据页和索引页，读写都先经过它：

![InnoDB Buffer Pool 结构](../../assets/mysql/mysql-buffer-pool.svg)

| 链表 | 管理对象 | 行为 |
|------|---------|------|
| **Free List** | 空闲页 | 读入新页时从这里分配；用尽后淘汰 LRU 冷端的页 |
| **LRU List** | 已缓存页 | 冷热分离，决定谁被淘汰 |
| **Flush List** | 脏页 | 按最早修改的 LSN 排序，checkpoint 从队头刷起 |

### 2、LRU 冷热分离

朴素 LRU 的问题：**一次大表全表扫描或逻辑备份就能把热点页全部挤出去**。InnoDB 的改进：

1. LRU 按约 5:3 分为 **young 区（热端）** 和 **old 区（冷端）**，old 区比例由 `innodb_old_blocks_pct`（默认 37%）控制
2. 新读入的页插入 **old 区头部**，而不是链表头
3. 页在 old 区停留超过 `innodb_old_blocks_time`（默认 **1 秒**）后**再次被访问**，才晋升到 young 区

全表扫描的页顺序读一遍，1 秒内不会再访问，只在 old 区停留就被淘汰，热点数据不受影响。

### 3、关键配置

```ini
[mysqld]
# 专用数据库服务器通常取物理内存的 50%～75%
innodb_buffer_pool_size = 8G
# innodb_buffer_pool_instances 保持默认即可，8.4 会按内存和 CPU 自动计算

# 或者让 InnoDB 按服务器内存和 CPU 自动设置 buffer pool 大小与 redo 容量
# innodb_dedicated_server = ON

# 重启时恢复热点页，避免冷启动（默认均为 ON）
innodb_buffer_pool_dump_at_shutdown = ON
innodb_buffer_pool_load_at_startup = ON
```

`innodb_buffer_pool_instances` 只有在 buffer pool 总大小 ≥ 1GiB 时才生效。8.4 的默认值：buffer pool ≤ 1GiB 时为 1；否则取"buffer pool 大小 / chunk 大小的一半"与"逻辑 CPU 数的四分之一"中较小者，范围 1～64。8.0 的默认值是 8。

```sql
-- 观察命中率：命中率 = 1 - Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
-- OLTP 实例的健康值一般在 99% 以上
```

### 4、自适应哈希索引与 Change Buffer

两者都依附于 Buffer Pool，在 8.4 中默认关闭：

| 参数 | 8.4 默认 | 8.0 默认 | 说明 |
|------|---------|---------|------|
| `innodb_adaptive_hash_index` | OFF | ON | 自适应哈希索引在高并发下常成为争用点 |
| `innodb_change_buffering` | none | all | Change Buffer 对 SSD 收益有限；原理见 [MySQL 索引](./4_topic_index) |

---

## 四、Double Write

### 1、为什么需要

**部分页写失效**：InnoDB 页 16KB，文件系统和磁盘的原子写单位通常是 4KB。写一个数据页途中断电，可能留下"一半新一半旧"的损坏页。redo log 记录的是对页的修改，需要在一个完整的页上重放，**无法修复损坏页**。

### 2、怎么做

刷脏页时先把页**顺序写**进 Double Write 文件并落盘，再写回表空间的原位置。崩溃恢复时如果发现某个数据页校验失败，就用 Double Write 中的完整副本覆盖，再重放 redo log。

| 版本 | 存放位置 |
|------|---------|
| 8.0.19 及更早 | 系统表空间 `ibdata1` 中的一块区域 |
| 8.0.20 起 | 独立文件 `#ib_<页大小>_<序号>.dblwr`，目录由 `innodb_doublewrite_dir` 指定（默认数据目录） |

相关参数（8.4）：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `innodb_doublewrite` | ON | 8.0.30 起可选 `DETECT_AND_RECOVER`（等同 ON）、`DETECT_ONLY`（只写元数据，能发现但不能修复损坏页）、`OFF` |
| `innodb_doublewrite_files` | 2 | 8.0 中默认为 `innodb_buffer_pool_instances × 2` |
| `innodb_doublewrite_pages` | 128 | 每个线程一次批量写入的最大页数；8.0 中默认为 `innodb_write_io_threads` |

> 只有文件系统或存储能保证 16KB 原子写（如部分支持原子写的存储、ZFS）时才考虑关闭 Double Write。

---

## 五、脏页刷盘

### 1、刷盘时机

| 触发条件 | 说明 | 影响 |
|---------|------|------|
| redo log 空间不足 | checkpoint 被迫推进，**更新会被阻塞** | 最坏情况，redo 容量要够 |
| 脏页比例过高 | 超过 `innodb_max_dirty_pages_pct`（默认 90%）时加速刷；超过 `innodb_max_dirty_pages_pct_lwm`（默认 10%）就开始预刷 | 后台加速 |
| Free List 不足 | 要淘汰的恰好是脏页，必须先刷盘再复用 | 查询变慢的常见隐因 |
| 系统空闲 / 正常关闭 | 后台匀速刷 | 理想状态 |

> **"MySQL 偶尔抖一下"** 的两个常见原因就在这里：集中刷脏页、redo log 空间不足。

### 2、相关参数

```ini
[mysqld]
# 后台刷脏和合并的 IO 能力估计；8.4 默认 10000（8.0 默认 200），SSD / NVMe 保持默认即可
innodb_io_capacity = 10000
# 紧急刷脏时的上限，8.4 默认为 2 × innodb_io_capacity
# innodb_io_capacity_max = 20000

# 8.0.30 起的 redo 总容量参数，可在线调整（默认 100MiB，写入量大时需调大）
innodb_redo_log_capacity = 4G
```

`innodb_io_capacity` 不是越大越好：在机械盘或云盘 IOPS 受限的环境中设得过高，会让后台刷脏抢占前台 IO。

---

## 六、MySQL 8.4 的 InnoDB 默认值变化

8.4 LTS 根据现代硬件调整了一批默认值。从 8.0 升级时，如果 `my.cnf` 中显式写了旧值，新默认值不会生效，需要逐项复核：

| 参数 | 8.4 默认 | 8.0 默认 |
|------|---------|---------|
| `innodb_io_capacity` | 10000 | 200 |
| `innodb_buffer_pool_instances` | 按内存和 CPU 计算（见第三节） | 8（buffer pool < 1GiB 时为 1） |
| `innodb_adaptive_hash_index` | OFF | ON |
| `innodb_change_buffering` | none | all |
| `innodb_log_buffer_size` | 64MiB | 16MiB |
| `innodb_doublewrite_files` | 2 | buffer pool 实例数 × 2 |
| `innodb_doublewrite_pages` | 128 | `innodb_write_io_threads`（默认 4） |
| `innodb_flush_method`（Linux） | 支持时为 `O_DIRECT`，否则 `fsync` | `fsync` |
| `innodb_use_fdatasync` | ON | OFF |
| `innodb_page_cleaners` | 等于 `innodb_buffer_pool_instances` | 4 |
| `innodb_read_io_threads` | 逻辑 CPU 数 / 2，最小 4 | 4 |
| `innodb_purge_threads` | 逻辑 CPU ≤ 16 时为 1，否则 4 | 4 |
| `innodb_parallel_read_threads` | 逻辑 CPU 数 / 8，最小 4 | 4 |
| `temptable_max_ram` | 物理内存的 3%（1～4GiB） | 1GiB |

8.0 已于 2026 年 4 月停止支持，存量实例应规划升级到 8.4 LTS 或 9.7 LTS（2026 年 4 月 GA）；LTS 只能逐个系列升级，不能从 8.0 直接跳到 9.7。

---

## 七、存储引擎对比

```sql
SHOW ENGINES;
```

| 维度 | InnoDB | MyISAM | MEMORY |
|------|--------|--------|--------|
| 事务 | 支持 | 不支持 | 不支持 |
| 锁粒度 | 行锁 | 表锁 | 表锁 |
| 外键 | 支持 | 不支持 | 不支持 |
| 崩溃恢复 | 依靠 redo log 自动恢复 | 易损坏，需要修复 | 重启后数据全部丢失 |
| 索引结构 | 聚簇索引（数据即索引） | 非聚簇（索引存行地址） | 默认哈希索引 |
| `COUNT(*)` 无条件 | 需扫描索引 | 直接读取维护的行数 | 直接读取 |

InnoDB 自 5.5 起是默认引擎，8.0 起系统表也全部迁到 InnoDB。MyISAM 已是遗留引擎，新项目没有理由选择；内部临时表在 8.0 起默认使用 TempTable 引擎而不是 MEMORY。

---

## 小结

- InnoDB 的存储层次是表空间、段、区、页、行；页默认 16KB，是磁盘 IO 和 B+ 树节点的单位
- 8.0 之后的文件布局：数据字典在 `mysql.ibd`，undo 默认两个独立表空间，redo 在 `#innodb_redo/`（8.0.30 起），Double Write 在独立 `.dblwr` 文件（8.0.20 起）
- DYNAMIC 是默认行格式：能放下就行内存储，放不下整列移出，只留 20 字节指针；COMPACT / REDUNDANT 行内保留 768 字节前缀；索引键前缀上限取决于行格式和页大小
- Buffer Pool 用 old / young 两段 LRU 防止全表扫描污染；实例数在 8.4 中自动计算，一般保持默认
- Double Write 解决部分页写失效，redo log 无法修复损坏页
- 刷脏受 redo 容量、脏页比例和 `innodb_io_capacity` 影响；8.4 默认 `innodb_io_capacity=10000`，AHI 与 Change Buffer 默认关闭
- 从 8.0 升级时要复核 `my.cnf` 中显式写死的旧默认值

## 参考资料

- MySQL 8.4 Reference Manual：[What Is New in MySQL 8.4 since MySQL 8.0](https://dev.mysql.com/doc/refman/8.4/en/mysql-nutshell.html)
- MySQL 8.4 Reference Manual：[InnoDB Row Formats](https://dev.mysql.com/doc/refman/8.4/en/innodb-row-format.html)
- MySQL 8.4 Reference Manual：[Buffer Pool](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html)
- MySQL 8.4 Reference Manual：[Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.4/en/innodb-doublewrite-buffer.html)
- MySQL 8.4 Reference Manual：[Redo Log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)、[Undo Tablespaces](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-tablespaces.html)
- MySQL 8.4 Reference Manual：[Configuring Buffer Pool Flushing](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool-flushing.html)
- MySQL 8.4 Reference Manual：[Limits on InnoDB Tables](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html)

> 下一篇：[MySQL 主从与高可用](./9_topic_replication) —— 从 binlog 到 GTID、半同步、并行复制，再到 InnoDB Cluster 与 ClusterSet。

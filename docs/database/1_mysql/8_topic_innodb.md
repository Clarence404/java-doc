# MySQL 专项 - InnoDB 存储结构与 Buffer Pool

## 一、表空间层次：段 / 区 / 页 / 行

```sql
-- 8.0 默认每张表独立表空间（*.ibd 文件）
SHOW VARIABLES LIKE 'innodb_file_per_table';  -- ON
```

| 层次 | 大小 | 说明 |
|------|------|------|
| **表空间（Tablespace）** | — | `.ibd` 文件，包含一张表的数据 + 索引 |
| **段（Segment）** | — | 逻辑概念：数据段（B+ 树叶节点）、索引段（非叶节点）、回滚段 |
| **区（Extent）** | 1MB | 64 个连续页；按区分配保证页物理连续，利于顺序 I/O |
| **页（Page）** | **16KB** | **磁盘 I/O 的最小单位**，B+ 树的一个节点就是一页 |
| **行（Row）** | — | 按行格式存储在页内 |

> 页大小 16KB 是"三层 B+ 树约存 2000 万行"估算的基础：非叶节点一页可放约 1170 个键（bigint + 页指针），1170 × 1170 × 15 ≈ 2000 万。

---

## 二、行格式与行溢出

| 行格式 | 说明 |
|--------|------|
| `COMPACT` | 5.7 前默认 |
| `DYNAMIC` | 5.7+ 默认；大字段（TEXT/BLOB/超长 VARCHAR）完全存溢出页，行内只留 20 字节指针 |

- 一页至少放 2 行，单行超过约 8KB 就会触发**行溢出**（大字段挪到溢出页）
- 这也是索引键长度上限的来源：`DYNAMIC` 下索引键最大 **3072 字节**（`COMPACT` 为 767）
- 工程启示：大字段（如 JSON 详情、富文本）**拆到附表**，避免主表行过宽拖慢所有查询的页利用率

---

## 三、Buffer Pool

InnoDB 的核心内存区，缓存数据页和索引页，读写都先走它：

![InnoDB Buffer Pool 结构](../../assets/mysql/mysql-buffer-pool.svg)

### 三条链表

| 链表 | 管理对象 | 行为 |
|------|---------|------|
| **Free List** | 空闲页 | 读入新页时从此分配；耗尽后淘汰 LRU 冷端页腾位置 |
| **LRU List** | 已缓存页 | 冷热分离（见下），决定谁被淘汰 |
| **Flush List** | 脏页 | 按最早修改的 LSN 排序，checkpoint 从队头刷起 |

### LRU 冷热分离：为什么不是朴素 LRU

朴素 LRU 有个致命问题：**一次大表全表扫描 / mysqldump 备份就能把热点页全部冲掉**。InnoDB 的改进：

1. LRU 按 5:3 分为 **young 区（热端）** 和 **old 区（冷端）**，比例由 `innodb_old_blocks_pct`（默认 37%）控制
2. 新读入的页插入 **old 区头部**，而不是链表头
3. 页在 old 区停留超过 `innodb_old_blocks_time`（默认 **1 秒**）后**再次被访问**，才晋升 young 区

全表扫描的页：顺序读一遍、1 秒内不会二次访问 → 只在 old 区打转就被淘汰，热点数据不受影响。

### 关键配置

```ini
[mysqld]
# 专用数据库服务器建议物理内存的 60%~70%
innodb_buffer_pool_size = 8G
# 大内存实例拆多个实例减少并发锁争用（每实例 ≥ 1G 才生效）
innodb_buffer_pool_instances = 8
```

```sql
-- 观察命中率（Innodb_buffer_pool_read_requests vs Innodb_buffer_pool_reads）
SHOW STATUS LIKE 'Innodb_buffer_pool_read%';
-- 命中率 = 1 - reads / read_requests，健康值 > 99%
```

---

## 四、Double Write Buffer

**问题（部分页写失效）**：InnoDB 页 16KB，操作系统页 4KB。刷一个数据页 = 4 次 OS 写，中途断电会产生"半个新半个旧"的损坏页 —— redo log 是物理增量日志，**无法在损坏页上重放**。

**解法**：刷脏时先把整页**顺序写**到共享表空间的 Double Write 区，成功后再写目标位置。崩溃恢复时若发现损坏页，用 Double Write 区的完整副本还原，再重放 redo log。

> 顺序写一份的开销远小于两倍随机写，实测性能损耗约 5%~10%。

---

## 五、脏页刷盘时机

| 触发条件 | 说明 | 影响 |
|---------|------|------|
| redo log 写满 | checkpoint 被迫推进，**阻塞所有更新** | ❌ 最坏情况，redo log 容量要够 |
| 脏页比例过高 | 超过 `innodb_max_dirty_pages_pct`（默认 90%）| 后台加速刷 |
| Free List 不足 | 淘汰的恰好是脏页，需先刷盘再复用 | 查询变慢的常见隐因 |
| 空闲时 / 正常关闭 | 后台匀速刷 | ✅ 理想状态 |

```ini
# 告知 InnoDB 磁盘能力，刷脏速度按此比例调节（SSD 可设 2000+）
innodb_io_capacity = 2000
# 8.0.30+ 在线调整 redo log 总容量
innodb_redo_log_capacity = 2G
```

> **"MySQL 偶尔抖一下"** 的两大常见原因就在这里：刷脏页、redo log 写满。

---

## 六、存储引擎对比

```sql
SHOW ENGINES;
```

| 维度 | InnoDB | MyISAM | Memory |
|------|--------|--------|--------|
| 事务 | ✅ | ❌ | ❌ |
| 锁粒度 | 行锁 | 表锁 | 表锁 |
| 外键 | ✅ | ❌ | ❌ |
| 崩溃恢复 | ✅ redo log | ❌ 易损坏 | 数据全丢 |
| 索引结构 | 聚簇索引（数据即索引）| 非聚簇（索引存行地址）| 哈希索引为主 |
| COUNT(*) | 需扫描 | O(1)（维护了行数）| O(1) |
| 适用场景 | **一切 OLTP（5.5+ 默认）** | 只读归档（已边缘化）| 临时表、8.0 起被 TempTable 替代 |

> 5.5 起 InnoDB 是默认引擎，新项目没有理由选 MyISAM；8.0 已把系统表全部迁到 InnoDB。

---

## 七、相关专项

- Buffer Pool 之上的读写链路 → [SQL 执行流程专项](./6_topic_execution)
- 二级索引写入优化 Change Buffer → [索引专项](./4_topic_index)
- redo log 与两阶段提交 → [事务、MVCC 与锁专项](./5_topic_transaction)

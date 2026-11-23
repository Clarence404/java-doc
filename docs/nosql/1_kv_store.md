---
description: 键值存储定位、RocksDB 嵌入式引擎、TiKV 事务 KV、etcd 强一致存储、选型与常见坑
---

# 键值存储：RocksDB、TiKV 与 etcd

> 前置阅读：[存储引擎：B+ 树与 LSM-Tree](/database/0_fundamentals/1_storage_engine)、[Redis 基础](/cache/1_redis_base)

键值存储只提供按键读写，却是 TiDB、Flink、Kubernetes 的底座。本篇讲 RocksDB、TiKV、etcd 的定位、用法和选型，基线为 RocksDB 10、etcd 3。

---

## 一、键值存储的定位

### 1、接口最简单的数据库

键值（KV）存储只认「键 → 值」，值对它来说就是一串字节，接口通常只有四个：

| 操作 | 含义 | 说明 |
|------|------|------|
| `get(key)` | 按键读 | 点查，最快的路径 |
| `put(key, value)` | 写入或覆盖 | 大多支持批量写（WriteBatch）保证原子 |
| `delete(key)` | 删除 | LSM 引擎里先写一条删除标记（tombstone），压缩时才真正清掉 |
| `scan(start, end)` | 按键范围遍历 | 只有**有序** KV（RocksDB、TiKV、etcd）支持，哈希型 KV 不支持 |

没有 SQL、没有二级索引、没有 JOIN，换来的是实现简单、性能可预测、容易做水平拆分。很多「高级」数据库本质上是在有序 KV 之上再盖一层：TiDB 把表和索引编码成有序 key 存进 TiKV，CockroachDB、MyRocks 也是同样的思路。所以设计 key 的格式（前缀、分隔符、定长编码）就是 KV 存储的「建模」。

### 2、和 Redis、关系库的边界

| 维度 | Redis | 磁盘型 KV（RocksDB / TiKV / etcd） | 关系库（MySQL / PostgreSQL） |
|------|------|------|------|
| 数据位置 | 内存为主 | 磁盘为主，内存做缓存 | 磁盘为主 |
| 容量 | 受内存限制 | 受磁盘限制，TB 级（etcd 例外，见[第四节](#四、强一致小数据-kv-etcd)） | TB 级 |
| 数据结构 | String / Hash / ZSet 等丰富类型 | 字节数组，结构由应用编码 | 表、行、列 |
| 查询能力 | 按键 + 类型命令 | 按键 + 范围扫描 | SQL、二级索引、JOIN |
| 持久化语义 | RDB / AOF，可能丢最后一段 | 写 WAL 后才确认 | 写 redo / WAL 后才确认 |
| 典型用途 | 缓存、计数、排行榜 | 存储引擎、元数据、状态存储 | 业务主数据 |

Redis 的数据类型与持久化见 [Redis 基础](/cache/1_redis_base)，这里不展开。

![键值与嵌入式存储全景](../assets/nosql/kv-landscape.svg)

按「部署形态 × 数据位置」看：嵌入式库没有网络开销，但也没有高可用，进程挂了数据就只在本机磁盘上；分布式 KV 多副本容错，代价是每次访问都要走网络。图中的嵌入式关系库 SQLite、H2、DuckDB 见 [嵌入式数据库：SQLite、H2 与 DuckDB](./2_embedded_db)。

---

## 二、嵌入式 KV 引擎：RocksDB

### 1、是什么

RocksDB 是 Meta 在 LevelDB 基础上开发的 **嵌入式 KV 引擎**：它不是一个服务，而是链接进进程的 C++ 库，数据写在本地目录里。底层是 LSM-Tree：写入先进 WAL 和内存表（MemTable），写满后刷成不可变的 SST 文件，后台再按层压缩（Compaction）。LSM 与 B+ 树的读写放大对比见 [存储引擎：B+ 树与 LSM-Tree](/database/0_fundamentals/1_storage_engine)。

核心能力：

- **有序**：key 按字节序排列，支持前缀扫描和范围迭代
- **列族（Column Family）**：一个 DB 里多个逻辑「表」，各自有独立的 MemTable、SST 和参数，但共享 WAL，所以跨列族的 WriteBatch 仍是原子的
- **WriteBatch**：一批写入原子生效
- **快照（Snapshot）与迭代器**：读取某一时刻的一致视图，不阻塞写入
- **事务**：`TransactionDB`（悲观，加锁）和 `OptimisticTransactionDB`（乐观，提交时检查冲突）
- **单进程独占**：同一目录同时只能被一个进程以读写方式打开（目录里有 `LOCK` 文件），只读和 Secondary 实例除外

### 2、谁在用

| 系统 | 用 RocksDB 做什么 |
|------|------|
| TiKV | 每个节点的本地存储，Raft 日志和数据都落在 RocksDB |
| Flink | `rocksdb` 状态后端，大状态作业的首选，详见 [状态与容错](/flink/4_state_checkpoint#五、状态后端) |
| Kafka Streams | 有状态算子（聚合、Join、窗口）的默认本地状态存储 |
| MyRocks | MySQL 的 RocksDB 存储引擎，压缩率高、写放大小 |

规律是：**需要在本机持久化大量 KV、又不想引入一个外部服务**时，就把 RocksDB 嵌进去，高可用由上层（Raft、Checkpoint、changelog topic）负责。

### 3、Java 用法：rocksdbjni

依赖 `org.rocksdb:rocksdbjni`，JNI 包里自带各平台的原生库。下面演示打开、读写、批量写和前缀扫描：

```java
import static java.nio.charset.StandardCharsets.UTF_8;

RocksDB.loadLibrary();
try (Options options = new Options().setCreateIfMissing(true);
     RocksDB db = RocksDB.open(options, "/data/order-kv")) {

    db.put("order:1001".getBytes(UTF_8), "PAID".getBytes(UTF_8));
    byte[] status = db.get("order:1001".getBytes(UTF_8));   // 不存在时返回 null

    // 多个写入原子生效
    try (WriteBatch batch = new WriteBatch(); WriteOptions wo = new WriteOptions()) {
        batch.put("order:1002".getBytes(UTF_8), "CREATED".getBytes(UTF_8));
        batch.delete("order:1000".getBytes(UTF_8));
        db.write(wo, batch);
    }

    // 前缀扫描：key 有序，seek 到前缀后顺序遍历（startsWith 是比较字节数组前缀的小工具方法，此处省略）
    byte[] prefix = "order:".getBytes(UTF_8);
    try (RocksIterator it = db.newIterator()) {
        for (it.seek(prefix); it.isValid() && startsWith(it.key(), prefix); it.next()) {
            System.out.println(new String(it.key(), UTF_8) + " = " + new String(it.value(), UTF_8));
        }
    }
}
```

`Options`、`RocksIterator`、`WriteBatch` 等对象都持有原生内存，**必须关闭**（try-with-resources），否则是 GC 管不到的堆外内存泄漏。

### 4、关键参数

| 参数 | 作用 | 调整方向 |
|------|------|------|
| `write_buffer_size` / `max_write_buffer_number` | 单个 MemTable 大小与个数 | 写多时调大，减少刷盘与写停顿 |
| Block Cache（`LRUCache` / `HyperClockCache`） | 缓存 SST 数据块 | 读多时调大；多个 DB / 列族共享一个 Cache 才好控总内存 |
| Bloom Filter（`BlockBasedTableConfig.setFilterPolicy`） | 点查时跳过不含该 key 的 SST | 点查为主时开启，每 key 约 10 bit |
| `compaction_style` | Level（默认，读放大小）/ Universal（写放大小） | 写入极重、能接受空间放大时考虑 Universal |
| `compression_per_level` | 每层压缩算法 | 上层 LZ4 求快，底层 ZSTD 求压缩率 |
| `max_background_jobs` | 后台刷盘 + 压缩线程数 | 压缩跟不上（L0 文件堆积、写停顿）时调大 |

写停顿（write stall）是 RocksDB 最常见的线上问题：L0 文件数或待压缩字节数超过阈值，RocksDB 会主动降速甚至停写，日志里能看到 `Stalling writes`。

---

## 三、分布式事务 KV：TiKV

TiKV 是 PingCAP 开源、CNCF 毕业的分布式 KV，可以理解为「把 RocksDB 用 Raft 复制、按范围分片、再加上分布式事务」：

- **Raft 多副本**：key 空间按范围切成 Region，每个 Region 默认 3 副本组成一个 Raft Group，多数派写成功即提交
- **Region 分裂与调度**：Region 超过阈值（8.4 起默认 256 MiB）自动分裂，PD 负责把 Region 和 Leader 均衡到各节点
- **Percolator 事务**：一句话概括，从 PD 取全局时间戳做快照，两阶段提交时以一个 Primary Key 的提交作为整个事务的提交点
- **两套 API**：TxnKV（事务、快照读）和 RawKV（无事务、更快，可设 TTL）

| 用法 | 说明 |
|------|------|
| 作为 TiDB 底座 | 最常见；SQL 层把行和索引编码成 key，架构、Region 与事务细节见 [分布式数据库](/database/3_relational/2_distributed_db#_3、tikv-region-与-raft) |
| 独立使用 | 需要「容量大、强一致、可水平扩展」的 KV，如文件系统元数据（JuiceFS 支持 TiKV 做元数据引擎）、大规模用户画像存储；Java 用 `org.tikv:tikv-client-java` |

单独用 TiKV 意味着运维 PD + TiKV 集群，规模不大时不值得；如果业务本来就要 SQL，直接用 TiDB 更省事。

---

## 四、强一致小数据 KV：etcd

### 1、定位

etcd 是用 Go 写的强一致 KV，Raft 复制、所有写入走 Leader，**底层存储是 bbolt（B+ 树），不是 LSM**。它的设计目标是保存「少量但必须正确」的数据：集群配置、服务元数据、选主与锁的状态。

| 限制 | 默认值 | 含义 |
|------|------|------|
| 单个请求大小 `--max-request-bytes` | 1.5 MiB | value 一般控制在 KB 级 |
| 存储配额 `--quota-backend-bytes` | 2 GiB | 超出触发 `NOSPACE` 告警，集群只读；官方建议上限 8 GiB |
| 集群规模 | 3 或 5 节点 | 节点越多写入越慢，不是越多越好 |

所以 etcd 不是「大数据量的 KV」，它对磁盘 fsync 延迟非常敏感，生产要用 SSD，并与其他高 IO 服务隔离。

### 2、MVCC 与 revision

![etcd MVCC：revision、历史读与 Watch](../assets/nosql/etcd-mvcc-watch.svg)

- **revision**：集群级的全局计数器，每个写事务加 1，可以理解为整个 KV 空间的「版本号」
- 每个 key 记录三个值：`create_revision`（创建时）、`mod_revision`（最后修改时）、`version`（被修改的次数）
- 旧版本保留在 bbolt 里，可以按 `--rev` 读历史；**Compaction** 清理某个 revision 之前的历史，**Defrag** 才真正把空间还给文件系统
- 事务 `Txn(If ... Then ... Else ...)` 用 `mod_revision` 做比较，即乐观锁（CAS）

### 3、Watch 与 Lease

- **Watch**：订阅一个 key 或前缀，从指定 revision 开始推送 PUT / DELETE 事件；断线重连时带上最后处理的 revision + 1，就不会漏事件。起始 revision 已被压缩时返回 `ErrCompacted`，客户端只能重新全量读取后再 Watch
- **Lease**：带 TTL 的租约，key 绑定租约后，租约过期 key 自动删除；客户端用 KeepAlive 续约。进程挂掉 → 停止续约 → key 消失，这就是临时节点的实现方式

### 4、谁在用

**Kubernetes 的全部集群状态都存在 etcd**（默认前缀 `/registry`）：API Server 是唯一直接读写 etcd 的组件，对象的 `resourceVersion` 就来自 etcd 的 revision，控制器的 List + Watch 机制直接建立在 etcd Watch 之上。etcd 慢或空间满，整个集群的变更都会卡住。

用 etcd 做分布式锁（Lease + `create_revision` 排队）见 [分布式锁](/distributed/4_lock#六、etcd-分布式锁)；作为注册中心与 Nacos、Consul 的对比见 [注册发现 · 注册中心对比](/service-governance/1_service_registry#二、注册中心对比)。

---

## 五、选型

| 场景 | 推荐 | 理由 |
|------|------|------|
| 缓存、计数、排行榜、会话 | Redis | 内存、数据结构丰富，丢少量数据可接受 |
| 进程内持久化大量 KV（状态存储、本地索引） | RocksDB | 嵌入式、写入快、TB 级 |
| 需要水平扩展、强一致的大容量 KV | TiKV | Raft 多副本 + 分布式事务 |
| 配置、选主、服务元数据、K8s 状态 | etcd | 强一致、Watch、Lease，数据量小 |

客户端本地库、单机分析和数据库测试的选型见 [嵌入式数据库：SQLite、H2 与 DuckDB](./2_embedded_db#四、选型)。

Redis 何时就够用：数据能放进内存、能容忍故障时丢失最后一小段写入（或者开了 AOF `everysec` 能接受最多约 1 秒）、访问模式就是按键读写和简单结构操作，这时不必引入磁盘型 KV。反过来，数据量远超内存、必须写入即持久、需要强一致选主，或者要在本进程里存状态避免网络开销，才考虑 RocksDB、TiKV 或 etcd。

---

## 六、常见坑

| 坑 | 现象 | 对策 |
|------|------|------|
| 把 etcd 当通用数据库 | 存大 value 或大量业务数据，配额满后 `NOSPACE`，集群只读 | 只存元数据；监控 DB 大小，定期 Compaction + Defrag |
| etcd 放在慢盘上 | WAL fsync 慢导致心跳超时、频繁选主 | 独占 SSD，关注 `wal_fsync_duration_seconds` 的 P99 |
| Watch 不处理 `ErrCompacted` | 断线重连后 Watch 失败或漏事件 | 记录已处理 revision；被压缩时全量重读再 Watch |
| RocksDB 对象不关闭 | 堆内存正常但容器 RSS 持续上涨被 OOM Kill | 所有原生对象 try-with-resources；限制 Block Cache 与 MemTable 总量 |
| RocksDB 写停顿 | 写入延迟周期性飙高，日志出现 `Stalling writes` | 调大后台线程与 MemTable，检查 L0 文件堆积 |
| 两个进程打开同一 RocksDB 目录 | 第二个进程报 `LOCK` 文件被占用 | 一个目录只给一个进程；多实例各用各的目录 |
| key 设计成单调递增 | TiKV 写入集中在最后一个 Region | key 前加哈希前缀打散，或用随机 ID |

---

## 小结

- KV 存储接口最简单（get / put / delete / scan），有序 KV 是很多分布式数据库的底座，key 的编码就是它的建模
- RocksDB 是进程内的 LSM 引擎，支持列族、WriteBatch、快照与事务，TiKV、Flink、Kafka Streams 都用它做本地存储；Java 用 rocksdbjni，原生对象必须关闭
- TiKV = Raft 多副本 + Region 自动分裂 + Percolator 事务，主要作为 TiDB 底座，也能独立当大容量强一致 KV
- etcd 用 Raft + bbolt，靠 revision 实现 MVCC、历史读和不漏事件的 Watch，用 Lease 实现临时 key；只适合 GB 级以内的元数据，Kubernetes 的状态全在里面
- 数据进得了内存、能容忍丢少量写入时，Redis 就够用

## 参考资料

- RocksDB Wiki：[https://github.com/facebook/rocksdb/wiki](https://github.com/facebook/rocksdb/wiki)
- RocksDB Java API：[https://github.com/facebook/rocksdb/wiki/RocksJava-Basics](https://github.com/facebook/rocksdb/wiki/RocksJava-Basics)
- RocksDB Write Stalls：[https://github.com/facebook/rocksdb/wiki/Write-Stalls](https://github.com/facebook/rocksdb/wiki/Write-Stalls)
- TiKV 文档：[https://tikv.org/docs/](https://tikv.org/docs/)
- etcd 数据模型：[https://etcd.io/docs/v3.6/learning/data_model/](https://etcd.io/docs/v3.6/learning/data_model/)
- etcd 系统限制：[https://etcd.io/docs/v3.6/dev-guide/limit/](https://etcd.io/docs/v3.6/dev-guide/limit/)
- etcd 维护（压缩、碎片整理、配额）：[https://etcd.io/docs/v3.6/op-guide/maintenance/](https://etcd.io/docs/v3.6/op-guide/maintenance/)

> 下一篇：[嵌入式数据库：SQLite、H2 与 DuckDB](./2_embedded_db) —— SQLite 单文件库与 WAL 模式、H2 测试替身的利弊、DuckDB 进程内 OLAP、选型与常见坑

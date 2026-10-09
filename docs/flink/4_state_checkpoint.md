---
description: 状态类型与 TTL、状态后端与 ForSt、Checkpoint、Savepoint、重启策略、端到端精确一次
---

# 状态与容错

> **本篇目标**：理解 Flink 状态的分类与存储方式，能为作业选择状态后端、配置 TTL；理解 Checkpoint 基于 barrier 的一致性快照原理，区分 Checkpoint 与 Savepoint；掌握两阶段提交与幂等 Sink 实现端到端精确一次的条件，并能定位和优化 Checkpoint 耗时过长的问题。
>
> **前置阅读**：[DataStream API](./2_datastream)、[时间、水位线与窗口](./3_time_window)

流计算的「有状态」指算子会记住历史：窗口里的累加器、去重用的已见 ID、定时器、Kafka 读到的 offset。Flink 把这些状态交给引擎托管——**算子只管读写，存储、快照、恢复、扩缩容时的重新分配都由引擎负责**。这是 Flink 能在故障后给出精确一次结果的基础。

---

## 一、状态的分类

### 1、Keyed State 与 Operator State

| 维度 | Keyed State | Operator State |
|------|-------------|----------------|
| 作用域 | 每个 key 一份，只能在 `keyBy` 之后使用 | 每个算子子任务一份，与 key 无关 |
| 访问方式 | `getRuntimeContext().getState(...)` | 实现 `CheckpointedFunction` |
| 扩缩容 | 按 **Key Group** 自动重新分配 | 按列表均分（even-split）或全量广播（union） |
| 典型使用者 | 业务代码：去重、累计、会话、超时检测 | 连接器：Source 的读取位置、Sink 的待提交事务 |

**Key Group 与最大并行度**：Keyed State 不是按 key 直接分配给子任务，而是先把 key 哈希到固定数量的 Key Group（数量 = `maxParallelism`），再把连续的 Key Group 区间分给子任务。扩缩容时只需移动 Key Group，而不需要重新哈希每个 key。因此：

- 并行度最多只能扩到 `maxParallelism`；
- **修改 `maxParallelism` 会导致状态无法恢复**，首次上线时就要设定（例如 `env.setMaxParallelism(720)`，选一个因数多的数便于均匀分配）。

### 2、Broadcast State

一种特殊的 Operator State：一条低流量的规则 / 配置流被广播到所有子任务，每个子任务持有同一份 Map 形式的状态，与主数据流配合（`KeyedBroadcastProcessFunction`）。典型场景是**动态规则**：风控规则变更后无需重启作业即可生效。

---

## 二、Keyed State 类型

| 类型 | 结构 | 典型用途 |
|------|------|----------|
| `ValueState<T>` | 单值 | 每个 key 的最新状态、定时器时间戳、去重标记 |
| `ListState<T>` | 列表 | 缓存待处理的明细 |
| `MapState<K, V>` | 键值对 | 每个 key 下的子维度统计；RocksDB 中每个 entry 单独存储，读写单个 entry 不需要反序列化整个 Map |
| `ReducingState<T>` | 自动 reduce 的单值 | 累计和 |
| `AggregatingState<IN, OUT>` | 自动 aggregate 的单值 | 累计平均值等 |

**示例：订单去重（带 TTL）**

上游 at-least-once 投递导致订单消息重复，按 `orderId` 去重，24 小时后自动清理：

```java
public class DedupFunction extends KeyedProcessFunction<String, OrderEvent, OrderEvent> {

    private transient ValueState<Boolean> seen;

    @Override
    public void open(OpenContext openContext) {
        StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofHours(24))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .cleanupInRocksdbCompactFilter(1000, Duration.ofHours(1))
                .build();
        ValueStateDescriptor<Boolean> desc = new ValueStateDescriptor<>("seen", Types.BOOLEAN);
        desc.enableTimeToLive(ttl);
        seen = getRuntimeContext().getState(desc);
    }

    @Override
    public void processElement(OrderEvent e, Context ctx, Collector<OrderEvent> out) throws Exception {
        if (seen.value() == null) {
            seen.update(true);
            out.collect(e);
        }
    }
}

// orders.keyBy(OrderEvent::orderId).process(new DedupFunction()).uid("dedup")
```

> **坑**：状态里不要存「大对象 + 频繁整体更新」。`ValueState<List<X>>` 在 RocksDB 中每次读写都要反序列化 / 序列化整个列表，应该改成 `ListState<X>` 或 `MapState`。

---

## 三、状态 TTL

key 空间无限增长的状态（按用户、按订单、按设备）如果没有 TTL，状态会一直膨胀，最终 Checkpoint 越来越慢、恢复越来越慢、磁盘写满。

| 配置 | 选项 | 说明 |
|------|------|------|
| 过期时间 | `newBuilder(Duration)` | 必填 |
| 刷新时机 `setUpdateType` | `OnCreateAndWrite`（默认）/ `OnReadAndWrite` | 读也续期适合「活跃即保留」的会话类状态 |
| 可见性 `setStateVisibility` | `NeverReturnExpired`（默认）/ `ReturnExpiredIfNotCleanedUp` | 是否返回已过期但还没被物理清理的值 |
| 清理策略 | `cleanupFullSnapshot()` | 全量快照时过滤过期数据，只缩小快照，不清理运行时状态 |
| | `cleanupIncrementally(n, perRecord)` | 堆状态后端：每次访问状态时顺带检查 n 条 |
| | `cleanupInRocksdbCompactFilter(n, period)` | RocksDB：在 Compaction 时过滤过期数据，**RocksDB 首选** |

注意事项：

- **TTL 只基于处理时间**，不支持事件时间。回溯历史数据时，TTL 仍按当前机器时间计算。需要按事件时间过期的，用事件时间定时器自行 `clear()`。
- **开关 TTL 与版本有关**：Flink 2.2 之前，原来没有 TTL 的状态加上 TTL（或反过来）后从 Savepoint 恢复会报 `StateMigrationException`；**Flink 2.2 起支持有无 TTL 之间的无缝迁移**。即便如此，TTL 时长和更新策略仍应在首次上线时设计好，避免上线后才发现状态膨胀。
- 过期是「惰性 + 后台」清理，过期数据不会在到期那一刻立刻消失，评估磁盘用量时要留出余量。

---

## 四、Operator State

业务代码很少直接使用 Operator State，主要是连接器在用（新 Source / Sink V2 由框架接口管理自身状态）。了解它的两种重分配方式即可：

| 方式 | 获取方法 | 扩缩容时 |
|------|----------|----------|
| even-split | `getListState(descriptor)` | 所有子任务的列表合并后均分给新子任务 |
| union | `getUnionListState(descriptor)` | 每个新子任务都拿到**完整列表**，自行挑选属于自己的部分 |

`CheckpointedFunction` 有两个方法：`snapshotState()` 在 Checkpoint 时把内存数据写入状态，`initializeState()` 在启动或恢复时读回。union 方式在并行度大时会让每个子任务都加载全量状态，状态大时要慎用。

---

## 五、状态后端

状态后端决定**运行时状态存在哪里**；Checkpoint 存储决定**快照写到哪里**（生产上一律是 S3 / HDFS / OSS 等分布式存储）。二者是两个独立的配置。

| 后端 | `state.backend.type` | 运行时状态位置 | 访问开销 | 状态规模 | 增量 Checkpoint | 状态 |
|------|----------------------|----------------|----------|----------|-----------------|------|
| HashMapStateBackend | `hashmap`（默认） | TaskManager JVM 堆，Java 对象 | 最低，无序列化 | 受堆内存限制，几 GB 级 | 不支持 | 生产可用 |
| EmbeddedRocksDBStateBackend | `rocksdb` | TaskManager 本地磁盘（RocksDB），序列化字节 | 每次读写都要序列化 | 受本地磁盘限制，TB 级 | **支持** | **大状态生产首选** |
| ForStStateBackend | `forst` | 远端存储（S3 / HDFS）为主，本地磁盘做缓存 | 远端 I/O，依赖异步状态访问掩盖延迟 | 理论上只受远端存储限制 | 始终增量 | **实验特性**，官方说明 API 与配置在后续版本可能变化 |

选择建议：

- 状态小（例如几百 MB 以内）、追求极致吞吐：`hashmap`。注意 GC 压力与 Checkpoint 时的全量快照。
- 状态大、key 多、窗口长、有 TTL：`rocksdb` + 增量 Checkpoint。这是国内生产环境最常见的组合。
- `forst`：Flink 2.x 存算分离的方向，目标是让 Checkpoint 轻量化、恢复时无需下载状态、状态规模不受本地磁盘限制。现阶段适合评估测试，关注后续版本的成熟度。

### 1、配置方式（Flink 2.x）

`FsStateBackend` / `MemoryStateBackend` 已在 2.0 中删除，统一通过配置项设置：

```yaml
# config.yaml
state.backend.type: rocksdb
execution.checkpointing.storage: filesystem
execution.checkpointing.dir: s3://my-bucket/flink/checkpoints
execution.checkpointing.incremental: true
```

```java
Configuration conf = new Configuration();
conf.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
conf.set(CheckpointingOptions.CHECKPOINT_STORAGE, "filesystem");
conf.set(CheckpointingOptions.CHECKPOINTS_DIRECTORY, "s3://my-bucket/flink/checkpoints/user-amount");
conf.set(CheckpointingOptions.INCREMENTAL_CHECKPOINTS, true);
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment(conf);
```

### 2、RocksDB 要点

- **内存**：默认 `state.backend.rocksdb.memory.managed: true`，RocksDB 的写缓冲、Block Cache、索引都限制在 Slot 的托管内存内（托管内存默认占 Flink 内存的 `taskmanager.memory.managed.fraction` = 0.4）。容器被 OOM Kill 时，先检查是否被改成了非托管模式。
- **磁盘**：本地状态目录放在 SSD 上；可设置 `state.backend.rocksdb.predefined-options`（如 `FLASH_SSD_OPTIMIZED`）作为调优起点。
- **序列化成本**：每次状态访问都要序列化，状态类型务必是 POJO / record，避免 Kryo。
- **ForSt 的关键配置**：`state.backend.type: forst`，配合 `execution.checkpointing.incremental: true`、本地缓存 `state.backend.forst.cache.size-based-limit` 等；SQL 作业还需 `table.exec.async-state.enabled: true` 开启异步状态访问（同时要关闭 mini-batch、使用单阶段聚合）。只有支持异步状态的算子（目前主要是部分 SQL 算子：Join、窗口聚合、非 distinct 聚合、Rank、行时间去重等）能充分发挥其优势，不支持的算子会自动退回同步访问。

---

## 六、Checkpoint 原理

### 1、基于 barrier 的异步快照

Flink 的 Checkpoint 基于 Chandy-Lamport 分布式快照算法的变体（异步屏障快照，ABS）：

![Checkpoint：barrier 注入、对齐与异步快照](../assets/flink/flink-checkpoint-barrier.svg)

1. JobMaster 中的 CheckpointCoordinator 定时向所有 Source 注入编号为 n 的 **barrier**；Source 记录当前读取位置（如 Kafka offset）作为自己的状态。
2. barrier 作为特殊记录随数据流向下游流动，**把数据流切成「属于 Checkpoint n 之前」和「之后」两部分**。
3. 算子从所有输入通道都收到 barrier n 后，对自身状态做快照，并把 barrier 转发给下游。
4. 快照分两步：**同步阶段**只做很轻的拷贝 / 刷盘（RocksDB 做一次 flush 并记录 SST 文件列表），**异步阶段**在后台线程把文件上传到 Checkpoint 存储，期间算子继续处理数据。
5. 所有算子（包括 Sink）都确认后，Coordinator 写入元数据文件，Checkpoint n 完成，并通知所有算子 `notifyCheckpointComplete`。

恢复时：所有算子加载 Checkpoint n 的状态，Source 回到记录的位置重新读取。因为状态与读取位置是同一个一致性切面，**状态层面的结果是精确一次的**——记录可能被重复处理，但对状态的影响只计一次。

### 2、对齐与非对齐

| 模式 | 行为 | 优点 | 缺点 |
|------|------|------|------|
| 对齐（默认，`EXACTLY_ONCE`） | 先收到 barrier 的通道**暂停读取**，等所有通道的 barrier 到齐再快照 | 快照只含状态，体积小 | **反压时 barrier 被堵在缓冲区中**，对齐耗时长、Checkpoint 超时 |
| `AT_LEAST_ONCE` | 不对齐，先到 barrier 的通道继续处理 | 无对齐等待 | 恢复后状态可能重复计入，不再是精确一次 |
| 非对齐（Unaligned） | barrier 直接「越过」缓冲区中的数据，把在途数据（in-flight buffers）一起写入快照 | 反压下 Checkpoint 时间与反压无关 | 快照包含在途数据，体积更大，恢复时要重放这些数据 |

推荐配置：**对齐超时后自动切换为非对齐**，平时用体积小的对齐快照，反压时才退化：

```java
env.enableCheckpointing(60_000, CheckpointingMode.EXACTLY_ONCE);   // org.apache.flink.core.execution.CheckpointingMode
CheckpointConfig cp = env.getCheckpointConfig();
cp.setMinPauseBetweenCheckpoints(30_000);          // 两次 Checkpoint 之间至少留 30s 给业务处理
cp.setCheckpointTimeout(10 * 60_000);              // 超时时间，默认 10 分钟
cp.setMaxConcurrentCheckpoints(1);
cp.setTolerableCheckpointFailureNumber(3);         // 连续失败 3 次才让作业失败，默认 0
cp.setExternalizedCheckpointRetention(ExternalizedCheckpointRetention.RETAIN_ON_CANCELLATION);
cp.enableUnalignedCheckpoints();
cp.setAlignedCheckpointTimeout(Duration.ofSeconds(30));   // 对齐超过 30s 才切换为非对齐
```

> `tolerable-failed-checkpoints` 默认为 0，意味着**一次 Checkpoint 超时就会让作业重启**。对 Checkpoint 偶发超时容忍度高的作业建议调大，但要配合告警，避免长期没有成功的 Checkpoint 而不自知。

### 3、增量 Checkpoint

全量 Checkpoint 每次都上传全部状态；RocksDB 的增量 Checkpoint 只上传自上次以来新生成的 SST 文件，旧文件被多个 Checkpoint 共享引用。状态 100 GB、每分钟变化 1 GB 时，差距是数量级的。代价是恢复时可能需要下载较多历史文件，且 Checkpoint 目录的清理由 Flink 负责，**不要手工删除 `shared` 目录下的文件**。

---

## 七、Checkpoint 与 Savepoint

| 维度 | Checkpoint | Savepoint |
|------|------------|-----------|
| 目的 | 故障自动恢复 | 计划内运维：升级代码、改并行度、迁移集群、升级 Flink 版本 |
| 触发 | 引擎定时自动触发 | 用户手动触发 |
| 所有权 | Flink 管理，默认作业取消时删除（可配置保留） | 用户管理，Flink 不会自动删除 |
| 格式 | 状态后端原生格式，可增量 | 默认标准（canonical）格式，可跨状态后端恢复；也可选 native 格式，速度更快 |
| 轻重 | 轻量、频繁 | 较重、偶尔 |

```bash
# 触发 Savepoint（不停止作业）
bin/flink savepoint <jobId> s3://my-bucket/flink/savepoints
# 停止作业并原子地做 Savepoint（发布升级的标准做法）
bin/flink stop --savepointPath s3://my-bucket/flink/savepoints <jobId>
# 从 Savepoint 启动新版本；-n 允许跳过已删除算子的状态（谨慎使用）
bin/flink run -s s3://my-bucket/flink/savepoints/savepoint-xxxx -n new-job.jar
```

能否从 Savepoint 恢复，关键在于**状态如何映射回算子**：Flink 按算子 `uid` 匹配状态。没有显式设置 `uid` 时使用自动生成的 ID，而这个 ID 会随着拓扑变化而改变，结果就是「改了一行代码，状态全部丢失」。**所有有状态算子（包括窗口、Source、Sink）都要设置稳定的 `uid`**。

从快照恢复时可指定 claim 模式：默认 `NO_CLAIM` 表示 Flink 不接管快照文件、首个 Checkpoint 强制为全量，可以从同一个快照启动多个作业；`CLAIM` 表示由 Flink 接管并在不需要时删除，不能再手动删除或被其他作业复用。

---

## 八、重启策略与故障转移

| 策略 | `restart-strategy.type` | 行为 |
|------|-------------------------|------|
| 指数退避 | `exponential-delay` | **开启 Checkpoint 时的默认值**：初始 1s，每次乘以 1.5，最大 1 分钟，带抖动 |
| 固定延迟 | `fixed-delay` | 固定间隔重试 N 次，次数用尽则作业失败 |
| 失败率 | `failure-rate` | 时间窗口内失败超过阈值才判定失败 |
| 不重启 | `none` | 未开启 Checkpoint 时的默认值 |

Flink 2.0 删除了 `RestartStrategies` 类与 `ExecutionConfig#setRestartStrategy`，统一通过配置设置：

```java
Configuration conf = new Configuration();
conf.set(RestartStrategyOptions.RESTART_STRATEGY, "fixed-delay");
conf.set(RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_ATTEMPTS, 10);
conf.set(RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_DELAY, Duration.ofSeconds(10));
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment(conf);
```

**故障转移范围**由 `jobmanager.execution.failover-strategy` 控制，默认 `region`：只重启与失败 Task 相连的流水线区域。但对 `keyBy` 全连接的流作业来说，所有 Task 往往在同一个区域，效果等同于全部重启。

---

## 九、端到端精确一次

Checkpoint 只保证 **Flink 内部状态**精确一次。要让外部系统看到的结果也精确一次，需要三个条件同时满足：

| 环节 | 要求 | 例子 |
|------|------|------|
| Source | 可重放，读取位置随 Checkpoint 保存 | Kafka（offset）、CDC（binlog 位点）、文件 |
| 引擎 | Checkpoint 开启，`EXACTLY_ONCE` 模式 | 对齐或非对齐 Checkpoint |
| Sink | **事务写入**（两阶段提交）或**幂等写入** | KafkaSink 事务、主键 upsert |

精确一次与幂等的通用理论见 [Kafka](/messaging/2_kafka) 的事务一节与 [幂等方案总结](/architecture/5_idempotence)。

### 1、两阶段提交 Sink

![两阶段提交 Sink 与 Checkpoint 的配合](../assets/flink/flink-2pc-sink.svg)

1. **写入**：两次 Checkpoint 之间的数据写入当前事务，对外不可见。
2. **预提交**：barrier 到达 Sink 时 flush 当前事务，把「待提交事务」记录进状态，开启下一个事务。
3. **提交**：Checkpoint 全部完成后，在 `notifyCheckpointComplete` 中提交事务，数据才对外可见。
4. **恢复**：从上一个 Checkpoint 恢复时，状态里记录的待提交事务会被重新提交（提交必须幂等），其余未完成的事务被 abort。

Sink V2 中，这一过程由 `SinkWriter` 产出待提交对象、实现 `SupportsCommitter` 的 Sink 提供 `Committer` 来完成。

### 2、Kafka 事务 Sink 的生产要点

| 要点 | 说明 |
|------|------|
| `transactionalIdPrefix` | 必填，同一 Kafka 集群中每个作业唯一；两个作业用了相同前缀会互相 fence |
| 事务超时 | `transaction.timeout.ms` 要大于「最大 Checkpoint 间隔 + 最长重启时间」，否则 Broker 在提交前就把事务中止，导致**数据丢失**；同时不能超过 Broker 端 `transaction.max.timeout.ms`（Kafka 默认 15 分钟） |
| 下游隔离级别 | 消费方必须设置 `isolation.level=read_committed`，否则会读到未提交、之后可能被中止的数据 |
| 端到端延迟 | 数据要等 Checkpoint 完成才可见，**延迟下限约等于 Checkpoint 间隔**；需要秒级可见性时就不能用分钟级 Checkpoint |
| `ProducerFencedException` | 多数是 Broker 端事务超时中止了事务，先检查事务超时与 Checkpoint 耗时 |

### 3、幂等 Sink：更简单的选择

如果目标系统支持按主键覆盖写，往往不需要事务：

| 目标 | 幂等写法 |
|------|----------|
| MySQL / PostgreSQL | `INSERT ... ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO UPDATE`，主键用业务键或窗口键 |
| Elasticsearch | 用业务键作为文档 `_id` |
| Redis | `SET` / `HSET` 覆盖写，而不是 `INCR` |
| Paimon / Hudi 等主键表 | 按主键 upsert |

恢复后重放的数据会覆盖写同一行，最终结果一致（effectively-once）。代价是：重放期间外部可能短暂看到「回退后又重新追上」的中间值，且**只适用于覆盖写语义**——`INCR`、追加写明细表都不是幂等的。实践中，**能用幂等 Sink 就不用事务 Sink**：更简单、延迟更低、不受 Checkpoint 间隔限制。

---

## 十、Checkpoint 耗时调优

Checkpoint 慢的直接后果是：超时失败 → 作业重启 → 积压 → 更慢，形成恶性循环。Web UI 的 Checkpoint 详情页按子任务列出了几个关键指标，先定位再优化：

| 指标 | 含义 | 偏大时的原因 | 优化方向 |
|------|------|--------------|----------|
| Start Delay | barrier 从注入到抵达该算子的时间 | **反压**，barrier 排在大量缓冲数据之后 | 先解决反压；开启非对齐 Checkpoint 或对齐超时；开启 `taskmanager.network.memory.buffer-debloat.enabled` 减少在途缓冲 |
| Alignment Duration | 等待所有输入 barrier 到齐的时间 | 上游各通道进度不一、数据倾斜 | 处理倾斜；非对齐 Checkpoint |
| Sync Duration | 同步阶段耗时 | RocksDB flush 慢、状态对象拷贝慢（hashmap） | SSD；状态过大考虑换 RocksDB |
| Async Duration | 上传到远端存储耗时 | 状态大、未开增量、存储带宽不足 | 开启增量 Checkpoint；TTL 控制状态规模；检查对象存储带宽与限流 |
| Checkpointed Data Size | 本次快照大小 | 状态膨胀 | TTL、`MapState` 替代大对象、清理无用状态 |

其他经验：

- **间隔不是越短越好**：间隔决定了故障时的重放量与事务 Sink 的可见延迟，但过短会让 Checkpoint 挤占处理资源。常见取值 1～5 分钟，并设置 `min-pause` 保证两次之间有喘息时间。
- **反压是 Checkpoint 慢的头号原因**：优先找到反压源头（Web UI 的 BackPressure / Busy 指标），而不是一味调大超时。
- **Checkpoint 成功率、耗时、大小都要接入监控告警**，指标体系见 [指标监控](/observability/2_metrics)。

---

## 小结

- Keyed State 按 Key Group 分配，`maxParallelism` 决定扩容上限且不能修改；Operator State 主要供连接器使用，Broadcast State 适合动态规则
- 状态类型按访问模式选：大集合用 `MapState` / `ListState` 而不是 `ValueState<List>`；无限增长的 key 空间必须配 TTL
- TTL 只基于处理时间；2.2 之前开关 TTL 会导致状态不兼容，2.2 起支持无缝迁移；RocksDB 用 Compaction Filter 清理
- 状态后端：小状态 `hashmap`，大状态 `rocksdb` + 增量 Checkpoint；Flink 2.x 的 ForSt 存算分离仍是实验特性
- Checkpoint 基于 barrier 的异步快照：Source 位置与算子状态构成一致切面；对齐模式在反压下变慢，用对齐超时自动切换非对齐
- Savepoint 用于升级与扩缩容，所有有状态算子必须设置稳定 `uid`；默认 `NO_CLAIM` 恢复
- 开启 Checkpoint 时默认指数退避重启；`tolerable-failed-checkpoints` 默认 0，一次超时即重启
- 端到端精确一次 = 可重放 Source + Checkpoint + 事务或幂等 Sink；Kafka 事务 Sink 注意事务超时、唯一前缀、`read_committed` 与 Checkpoint 间隔带来的延迟；能幂等就不用事务
- Checkpoint 慢先看 Start Delay / Alignment（反压）还是 Async Duration（状态大小与存储带宽），对症优化

## 参考资料

- 使用状态：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/state/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/state/)
- 状态后端：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/state_backends/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/state_backends/)
- 存算分离状态：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/disaggregated_state/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/disaggregated_state/)
- Checkpointing：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/checkpointing/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/checkpointing/)
- Savepoints：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/savepoints/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/savepoints/)
- 重启策略：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/task_failure_recovery/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/state/task_failure_recovery/)
- 论文 Lightweight Asynchronous Snapshots for Distributed Dataflows：[https://arxiv.org/abs/1506.08603](https://arxiv.org/abs/1506.08603)

> 下一篇：[Flink SQL 与 Table API](./5_sql) —— 用 SQL 表达流计算：动态表与 changelog、窗口 TVF、各类 Join、Top-N 与去重。

---
description: 选型与架构、DataStream、水位线与窗口、状态与 Checkpoint、精确一次、SQL 与 CDC、部署调优
---

# 开发总结 - Flink

> 精华提炼，细节详见 [Flink 总览](/flink/0_overview)；题目清单见 [Flink 面试题](/flink/99_interview)，本页按清单的分组与顺序作答。
> 版本基线：Flink 2.2.x（2.3 已发布，外部连接器尚未适配）、Flink CDC 3.6、JDK 17（Java 21 为实验性支持）；与 1.x 不同之处在答案中单独标注。

## 一、基础与架构

### Q1：Flink 与 Spark Streaming、Kafka Streams 如何选型？

**核心结论**：选 Kafka Streams 的条件是数据进出都在 Kafka、逻辑简单。选 Spark 的条件是已有 Spark 离线体系、能接受分钟级延迟。多源异构、大状态、毫秒级延迟、需要事件时间语义或 CDC 入湖时，选 Flink。

| 维度 | Flink | Spark Structured Streaming | Kafka Streams |
|------|-------|----------------------------|---------------|
| 处理模型 | 逐条处理，批是有界流 | 微批为主 | 逐条处理 |
| 延迟 | 毫秒级 | 秒级 | 毫秒级 |
| 状态 | 内置，支持 TB 级（RocksDB / ForSt） | 内置，规模一般 | RocksDB + changelog topic |
| 部署 | 独立集群（K8s / YARN） | Spark 集群 | 一个 Jar 库，嵌入应用 |
| 数据源 | 任意 | 任意 | 只能 Kafka 进、Kafka 出 |

- Flink 的代价是运维复杂度：需要独立集群、状态存储，升级要走 Savepoint；团队没有平台化能力时优先用云厂商托管服务
- Storm 不建议新项目选用

→ 详见 [Flink 概览](/flink/1_basics#二、为什么选-flink-与其他方案对比)

### Q2：JobManager 的 Dispatcher、ResourceManager、JobMaster 各负责什么？Slot 隔离什么？一个作业需要多少 Slot？

**核心结论**：Dispatcher 是入口，ResourceManager 管 Slot，JobMaster 每个作业一个，负责调度和 Checkpoint。Slot 只隔离托管内存，不隔离 CPU。默认开启 Slot 共享，所以作业所需 Slot 数等于最大算子并行度。

| 组件 | 职责 | 数量 |
|------|------|------|
| Dispatcher | REST 接收提交，为作业启动 JobMaster，承载 Web UI | 每集群一个 |
| ResourceManager | 向 K8s / YARN 申请或释放 TaskManager，分配 Slot | 每集群一个 |
| JobMaster | JobGraph 展开为 ExecutionGraph、调度 Task、协调 Checkpoint、故障恢复 | 每作业一个 |

- TaskManager 是工作进程，Slot 是它的资源切片；Slot 数常取容器 CPU 核数
- Slot 共享让一个 Slot 容纳整条流水线，所以所需 Slot 数不等于各算子并行度之和
- JobManager 需要 HA（ZooKeeper 或 Kubernetes），以便恢复最近一次完成的 Checkpoint 指针

→ 详见 [Flink 概览](/flink/1_basics#三、运行时架构)

### Q3：什么是算子链？什么情况下会断链？

**核心结论**：满足四个条件的上下游算子会合并成一个 Task，由同一个线程执行，记录通过方法调用传递，没有序列化、网络缓冲和线程切换。四个条件是 forward 连接、并行度相同、同一个 Slot 共享组、没有禁用链。`keyBy`、`rebalance` 和并行度变化都会断链。

- 手动控制：`disableChaining()`、`startNewChain()`、`env.disableOperatorChaining()`（全局关闭，一般只用于排查）
- 生产默认不关链；只在需要定位链内哪个算子慢、观察反压位置时临时断开
- Web UI 上一条链显示为一个节点，看不出链内瓶颈

→ 详见 [Flink 概览](/flink/1_basics#_3、并行度与算子链)

### Q4：Flink 2.0 有哪些破坏性变化？为什么移除 Per-Job 模式？

**核心结论**：Flink 2.0（2025 年 3 月）删除了一批旧 API 和旧部署方式，**与 1.x 不保证状态兼容**。旧连接器全部失效，必须换成适配 2.x 的版本。Per-Job 模式被移除，因为 Application 模式能完全替代它：`main()` 在集群侧执行，提交机上不用下载依赖、生成 JobGraph，也更适合容器化交付。

| 移除项 | 替代 |
|--------|------|
| DataSet API、Scala API | DataStream（`BATCH` 模式）、Table API / SQL、Java API |
| `SourceFunction` / `SinkFunction` / Sink V1 | 新 Source API（FLIP-27）/ Sink V2 |
| `open(Configuration)` | `open(OpenContext)` |
| `RestartStrategies`、`FsStateBackend` / `MemoryStateBackend` | 配置项 `restart-strategy.*`、`state.backend.type` |
| `Time` 类 | `java.time.Duration` |
| `flink-conf.yaml` | 标准 YAML 的 `config.yaml` |
| Per-Job 模式 | Application 模式 |

- 运行环境：不再支持 Java 8，默认 Java 17，Java 21 为实验性支持；Kryo 升级到 5.6
- 新能力：ForSt 存算分离状态（实验特性）、物化表、DataStream API V2（实验性）

→ 详见 [Flink 概览](/flink/1_basics#六、flink-2-x-的关键变化)

### Q5：为什么 maxParallelism 上线后不能改？Key Group 是什么？

**核心结论**：Keyed State 先按 key 哈希到固定数量的 Key Group，Key Group 的数量等于 `maxParallelism`，连续的 Key Group 区间再分给各子任务。扩缩容时只需要移动 Key Group，不用对每个 key 重新哈希。修改 `maxParallelism` 会改变 key 到 Key Group 的映射，旧状态因此无法恢复。

- 并行度最多只能扩到 `maxParallelism`
- 首次上线就显式设置一个因数多的值（如 720、1024），不设置时按初始并行度推导，后续扩容可能受限

→ 详见 [状态与容错](/flink/4_state_checkpoint#_1、keyed-state-与-operator-state)

## 二、DataStream

### Q6：KafkaSource 的 offset 以什么为准？提交到 Kafka 的 offset 有什么用？

**核心结论**：作业从 Checkpoint 或 Savepoint 恢复时，读取位置以状态里记录的 offset 为准，`setStartingOffsets` 只在首次启动时生效。Checkpoint 完成后提交回 Kafka 的 offset **只用于监控消费延迟，不参与容错**。

- 消费组 lag 偶尔「倒退」不代表丢数据
- Source 并行度不要超过分区数，多出来的 Reader 空闲，不产生水位线，会卡住下游窗口
- 补数、回溯用 `setBounded(...)` 做有界读取

→ 详见 [DataStream API](/flink/2_datastream#_2、kafkasource)

### Q7：解析失败为什么不能抛异常？脏数据怎么处理？

**核心结论**：抛异常会触发作业重启。重启后从 Checkpoint 重放，又会遇到同一条脏数据，作业就陷入无限重启，这种消息称为毒丸消息。正确做法是 catch 住异常，用**侧输出**把脏数据送到死信 topic，并对死信数量告警、人工处理。

- `OutputTag` 用匿名子类创建以保留泛型；`ctx.output(tag, value)` 输出，`getSideOutput(tag)` 取流
- `ObjectMapper` 等不可序列化对象声明为 `transient`，在 `open()` 中创建
- SQL 里的 `json.ignore-parse-errors` 会静默跳过脏数据，上线前确认这是期望的行为

→ 详见 [DataStream API](/flink/2_datastream#五、侧输出-side-output)

### Q8：维表关联为什么用异步 I/O？有序与无序模式有什么区别？timeout 要注意什么？

**核心结论**：在 `map` 里同步查询时，每条记录都要等一次网络往返，10 ms 延迟意味着单个子任务每秒只能处理 100 条。异步 I/O 让一个子任务同时挂起多个请求，吞吐约为「容量 / 延迟」。

| 要点 | 说明 |
|------|------|
| 客户端 | 必须是真正的异步客户端，在 `asyncInvoke` 里调用阻塞 API 等于没用异步 |
| `unorderedWait` | 先完成先输出，延迟低；事件时间下也不会越过水位线乱序 |
| `orderedWait` | 保持输入顺序，有额外缓冲开销 |
| `capacity` | 在途请求上限，满了会反压上游，同时保护下游服务 |
| `timeout()` | **默认实现抛异常导致作业重启**，生产必须覆盖为降级逻辑 |

- 可加本地缓存（如 Caffeine）减少请求；重试用 `unorderedWaitWithRetry`
- SQL 里对应 Lookup Join

→ 详见 [DataStream API](/flink/2_datastream#七、异步-i-o-维表关联)

### Q9：为什么要避免 Kryo 序列化？Lambda 的泛型擦除怎么解决？

**核心结论**：Flink 识别不了的类型会回退到 Kryo。Kryo 序列化慢，状态也不支持 Schema 演进，类改了字段就无法从 Savepoint 恢复。生产作业应使用 POJO 或 record（1.19 起 record 也被识别为 POJO），并设置 `pipeline.generic-types: false`，让回退在开发期就直接报错。

- POJO 规则：public 独立类、public 无参构造器、字段 public 非 final 或有 getter / setter；字段是接口、缺无参构造器都会导致整个类回退
- POJO / record 支持增删字段，不支持修改字段类型
- Lambda 返回 `Tuple2` 等泛型时，Flink 推断不出类型，报 `InvalidTypesException`：用 `.returns(Types.TUPLE(...))` 或 `TypeHint` 声明，或改用匿名类、具名类

→ 详见 [DataStream API](/flink/2_datastream#九、序列化与类型信息的坑)

## 三、时间与窗口

### Q10：什么是水位线？多输入算子的水位线如何计算？

**核心结论**：水位线是混在数据流中的特殊记录，携带时间戳 T，表示「事件时间 ≤ T 的数据都已到达」，窗口和事件时间定时器据此触发。它是在延迟和完整性之间做取舍。多输入算子的水位线取**所有输入通道水位线的最小值**，所以最慢的分区决定整个作业的进度。

- `forBoundedOutOfOrderness(d)`：水位线 = 已见最大时间戳 − d − 1ms，最常用；默认每 200 ms 生成一次
- 乱序容忍度取「事件时间与到达时间之差」的 P99 / P999，剩余长尾交给迟到数据机制
- 优先在 `fromSource` 上分配：KafkaSource 按分区分别跟踪水位线再取最小值，也只有这种方式支持水位线对齐

→ 详见 [时间、水位线与窗口](/flink/3_time_window#二、水位线-watermark)

### Q11：窗口迟迟不触发是什么原因？怎么解决？（空闲分区 / idleness）

**核心结论**：常见原因是某些分区或 Source 子任务没有数据，它们的水位线停在原地，拖住了下游的最小水位线。例如并行度大于分区数，或者夜间部分分区没有流量。解决办法是 `withIdleness(Duration)`，把一段时间没有数据的分片标记为空闲，计算最小水位线时暂时忽略它。SQL 中对应的配置是 `table.exec.source.idle-timeout`。

- 空闲超时要明显大于正常的数据间隔，否则低流量分区会被误判为空闲，它的数据反而变成迟到数据
- Flink 2.0 起，反压和对齐造成的阻塞不再计入空闲超时
- 另一类问题是回溯时快慢分区差距过大、状态暴涨，用 `withWatermarkAlignment` 暂停快分区；它只对新 Source API 生效

→ 详见 [时间、水位线与窗口](/flink/3_time_window#_4、空闲检测-idleness)

### Q12：迟到数据有哪三道防线？allowedLateness 对下游有什么要求？

**核心结论**：水位线越过窗口结束时间后才到的数据默认被丢弃。处理迟到数据有三道防线：乱序容忍度、`allowedLateness`、侧输出。开启 `allowedLateness` 后，同一个窗口会**输出多次**，下游必须按窗口主键 upsert。

| 防线 | 机制 | 代价 |
|------|------|------|
| 水位线延迟 | `forBoundedOutOfOrderness` 容忍度 | 所有窗口统一推迟输出 |
| `allowedLateness` | 窗口触发后保留状态，迟到数据到达时再次触发 | 状态保留更久，下游收到多次结果 |
| `sideOutputLateData` | 超过允许迟到时间的数据走侧输出 | 需要单独补偿或对账 |

- 下游如果是追加写的明细表，同一窗口会被重复累加

→ 详见 [时间、水位线与窗口](/flink/3_time_window#三、迟到数据)

### Q13：滚动、滑动、会话窗口有什么区别？滑动窗口为什么可能状态爆炸？按自然日统计要注意什么？

**核心结论**：滚动窗口固定大小、互不重叠，滑动窗口按步长滑动、可以重叠，会话窗口在数据间隔超过 gap 时切分。滑动窗口会把每条数据复制到 `size / slide` 个窗口中，步长太小时状态和 CPU 都会爆炸。窗口按 UTC 纪元对齐，所以在中国按自然日统计要设 −8 小时偏移。

| 窗口 | 特点 | 场景 |
|------|------|------|
| 滚动 | 固定大小、不重叠 | 每分钟 PV、每小时 GMV |
| 滑动 | 固定大小、可重叠 | 最近 10 分钟、每分钟刷新 |
| 会话 | 无固定大小，按间隔切分，会合并 | 用户会话分析 |
| 全局 | 默认永不触发 | 配自定义 Trigger，如计数窗口 |

- 1 小时窗口、1 秒步长时，每条数据要进入 3600 个窗口；改用「滚动小窗口 + 下游累加」或 `KeyedProcessFunction`
- 自然日：`TumblingEventTimeWindows.of(Duration.ofDays(1), Duration.ofHours(-8))`；SQL 用 `TIMESTAMP_LTZ` 加 `table.local-time-zone`
- 会话窗口的聚合必须实现 `merge`；`windowAll` 并行度为 1，尽量避免

→ 详见 [时间、水位线与窗口](/flink/3_time_window#四、窗口类型)

### Q14：增量聚合与全量窗口函数有什么区别？如何组合使用？

**核心结论**：`reduce` / `aggregate` 是增量聚合，状态里只有一个累加器，但拿不到窗口信息。`ProcessWindowFunction` 是全量聚合，缓存窗口内全部元素，能拿到窗口起止时间。生产首选两者组合，写成 `aggregate(agg, processWindowFunction)`：状态只保留累加器，触发时再把结果和窗口信息一起输出。

- 只有需要全部元素时（中位数、窗口内排序）才用纯 `ProcessWindowFunction`，并注意窗口数据量
- Evictor 会让增量聚合失效；复杂触发逻辑用 `KeyedProcessFunction` + 定时器更直观

→ 详见 [时间、水位线与窗口](/flink/3_time_window#五、窗口函数)

### Q15：Window Join 与 Interval Join 有什么区别？

**核心结论**：Window Join 把两条流按 key 放进同一个窗口，窗口触发时配对，窗口边界会切断关联，例如订单 4:59 创建、5:01 支付就关联不上。Interval Join 以一侧事件为基准，关联另一侧在时间区间内的数据，没有边界问题，是更常用的写法。

| 要点 | Interval Join |
|------|---------------|
| 时间语义 | 只支持事件时间 |
| 连接类型 | 只支持内连接 |
| 状态 | 两侧都缓存，水位线越过区间才清理，区间越大状态越大 |
| 外连接 | 用 `connect` + `KeyedCoProcessFunction` + 定时器，或 Flink SQL |

- 一侧是缓慢变化的维表时，不用双流 Join，改用异步 I/O 或 Broadcast State

→ 详见 [时间、水位线与窗口](/flink/3_time_window#七、双流-join)

## 四、状态与容错

### Q16：状态 TTL 的语义是什么？有哪些坑？

**核心结论**：TTL 让 key 空间无限增长的状态自动过期，否则状态会一直膨胀，Checkpoint 和恢复越来越慢，最终写满磁盘。有三个坑：**TTL 只基于处理时间**；**2.2 之前开启或关闭 TTL 会导致状态不兼容**（2.2 起支持有无 TTL 之间无缝迁移）；过期数据是惰性清理的，不会到期立即消失。

- 刷新时机：默认 `OnCreateAndWrite`，会话类状态用 `OnReadAndWrite`
- 清理策略：RocksDB 首选 `cleanupInRocksdbCompactFilter`，堆状态后端用 `cleanupIncrementally`
- 回溯历史数据时 TTL 仍按机器时间算；需要按事件时间过期时，用事件时间定时器自己 `clear()`
- TTL 要在首次上线时设计好；SQL 的 TTL 见 Q26

→ 详见 [状态与容错](/flink/4_state_checkpoint#三、状态-ttl)

### Q17：HashMap、RocksDB、ForSt 状态后端如何选择？

**核心结论**：状态小、追求吞吐时用 `hashmap`（默认值）。状态大、key 多、窗口长时用 `rocksdb` 加增量 Checkpoint，这是国内生产最常见的组合。`forst` 是 Flink 2.x 的存算分离方向，目前仍是实验特性，只适合评估。

| 后端 | 运行时状态位置 | 访问开销 | 规模 | 增量 Checkpoint |
|------|----------------|----------|------|-----------------|
| `hashmap` | JVM 堆上的 Java 对象 | 最低 | GB 级，受堆限制 | 不支持 |
| `rocksdb` | 本地磁盘，存序列化字节 | 每次读写都序列化 | TB 级，受磁盘限制 | 支持 |
| `forst` | 远端存储为主，本地做缓存 | 远端 I/O，靠异步访问掩盖延迟 | 只受远端存储限制 | 始终增量 |

- 状态后端（运行时位置）与 Checkpoint 存储（快照写到哪里）是两个独立配置，2.x 统一用配置项设置
- RocksDB 使用托管内存（默认占 Flink 内存的 40%），本地目录放 SSD；`ValueState<List>` 改用 `ListState` / `MapState`

→ 详见 [状态与容错](/flink/4_state_checkpoint#五、状态后端)

### Q18：Checkpoint 的原理是什么（barrier、对齐）？非对齐 Checkpoint 解决什么问题？

**核心结论**：Checkpoint 是基于 barrier 的异步快照，属于 Chandy-Lamport 算法的变体。Source 注入 barrier 并记录读取位置，barrier 随数据流向下游，把流切成前后两段。算子收到所有输入的 barrier 后做快照，同步阶段很轻，异步阶段上传文件。所有算子确认后 Checkpoint 完成，Source 位置与算子状态构成一致切面。非对齐 Checkpoint 解决的是**反压时 barrier 被堵在缓冲区**、对齐耗时过长导致超时的问题。

| 模式 | 行为 | 取舍 |
|------|------|------|
| 对齐（默认） | 先到 barrier 的通道暂停读取，等齐再快照 | 快照小，反压时很慢 |
| 非对齐 | barrier 越过缓冲数据，在途数据一起写入快照 | 与反压无关，快照更大 |

- 推荐对齐超时自动切换：`enableUnalignedCheckpoints()` + `setAlignedCheckpointTimeout(30s)`
- RocksDB 增量 Checkpoint 只上传新 SST 文件；不要手工删除 `shared` 目录

→ 详见 [状态与容错](/flink/4_state_checkpoint#六、checkpoint-原理)

### Q19：Checkpoint 与 Savepoint 有什么区别？为什么要给算子设置 uid？

**核心结论**：Checkpoint 由引擎定时触发、由 Flink 管理，用于故障自动恢复。Savepoint 由用户手动触发、由用户管理，用于升级代码、改并行度、迁移集群。从 Savepoint 恢复时，Flink **按算子 uid 把状态映射回算子**。不设 uid 时使用自动生成的 ID，拓扑一变 ID 就变，结果是改一行代码就丢掉全部状态。

| 维度 | Checkpoint | Savepoint |
|------|------------|-----------|
| 触发 | 自动、频繁 | 手动、偶尔 |
| 生命周期 | 默认作业取消时删除 | Flink 不自动删除 |
| 格式 | 状态后端原生格式，可增量 | 默认标准格式，可跨状态后端 |

- 发布升级用 `flink stop --savepointPath`，停止作业并原子地做 Savepoint；不要加 `--drain`，它会触发所有窗口，只用于永久下线
- 恢复默认 `NO_CLAIM`：Flink 不接管快照文件，同一个快照可以启动多个作业

→ 详见 [状态与容错](/flink/4_state_checkpoint#七、checkpoint-与-savepoint)

### Q20：如何实现端到端精确一次？两阶段提交的流程是什么？Kafka 事务 Sink 要注意什么？

**核心结论**：端到端精确一次需要三个条件：**可重放的 Source**、`EXACTLY_ONCE` 模式的 Checkpoint、**事务 Sink 或幂等 Sink**。两阶段提交的流程是：数据写入当前事务 → barrier 到达时预提交并记入状态 → Checkpoint 完成后提交 → 恢复时重新提交待提交事务，未完成的事务 abort。

| Kafka 事务 Sink 要点 | 说明 |
|----------------------|------|
| `transactionalIdPrefix` | 必填，同一 Kafka 集群内每个作业唯一，否则互相 fence |
| `transaction.timeout.ms` | 大于最大 Checkpoint 间隔 + 重启时间，否则 Broker 中止事务导致**丢数据**；不超过 Broker 的 `transaction.max.timeout.ms` |
| 下游 | 必须 `isolation.level=read_committed` |
| 延迟 | 数据在 Checkpoint 完成后才可见，延迟下限约等于 Checkpoint 间隔 |

- `ProducerFencedException` 多数是 Broker 端事务超时
- 能用幂等 Sink（主键 upsert、ES `_id`、Redis `SET`）就不用事务 Sink，更简单、延迟更低；`INCR` 和追加写不幂等

→ 详见 [状态与容错](/flink/4_state_checkpoint#九、端到端精确一次)

### Q21：Checkpoint 超时或耗时长如何排查与优化？

**核心结论**：先看 Web UI 中各子任务的指标，判断问题出在哪里。Start Delay 或 Alignment 大，说明是**反压**，这是头号原因。Async Duration 大，说明状态太大或存储带宽不够。不要一味调大超时。

| 指标偏大 | 原因 | 优化 |
|----------|------|------|
| Start Delay | 反压，barrier 排队 | 先解决反压；非对齐 Checkpoint；buffer debloat |
| Alignment Duration | 通道进度不一、倾斜 | 处理倾斜；非对齐 Checkpoint |
| Sync Duration | RocksDB flush 慢 | SSD；状态大时换 RocksDB |
| Async Duration | 状态大、未开增量、带宽不足 | 增量 Checkpoint；TTL；检查对象存储限流 |

- `tolerable-failed-checkpoints` 默认 0，一次超时就重启，建议调到 3 左右并配告警
- 间隔常取 1～5 分钟，配 `min-pause`；Checkpoint 成功率、耗时、大小都要接入监控

→ 详见 [状态与容错](/flink/4_state_checkpoint#十、checkpoint-耗时调优)、[部署与运维](/flink/7_deployment#五、checkpoint-失败)

## 五、SQL 与 CDC

### Q22：什么是动态表？+I / -U / +U / -D 分别何时出现？append、retract、upsert 流有什么区别？

**核心结论**：Flink SQL 是**连续查询**。输入流被看作一张不断变化的动态表，查询结果也是动态表，以带 `RowKind` 的 changelog 输出给下游。

| RowKind | 出现场景 |
|---------|----------|
| `+I` | 所有查询 |
| `-U` / `+U` | 非窗口聚合、Regular Join、Top-N |
| `-D` | CDC 源、Top-N 挤出、外连接撤回补 null 的行 |

- **Append 流**只有 `+I`：过滤、投影、窗口聚合、Interval Join，可以写任何 Sink
- **Retract 流**把更新拆成 `-U` + `+U`，下游必须能撤回
- **Upsert 流**有主键，只发 `+I` / `+U` / `-D`（省掉 `-U`），下游按主键覆盖写，如 upsert-kafka、带主键的 JDBC
- 用 `EXPLAIN CHANGELOG_MODE` 查看每个算子的 changelog 模式

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#一、动态表与-changelog)

### Q23：为什么一条 SQL 写 Kafka 会报 doesn't support consuming update changes？怎么解决？

**核心结论**：这条 SQL 的结果是更新流，比如无界 `GROUP BY` 或 Regular Join，而普通 `kafka` 连接器只支持追加写。有两种解法：Sink 换成声明了主键的 **upsert-kafka**，或者把查询改写成窗口聚合、Interval Join 这类只追加的形式。

- upsert-kafka 把主键写入消息 key，`-D` 写成墓碑消息，配合 compact 主题就是一张「最新值表」
- upsert-kafka 作为源表时，规划器会加 `ChangelogNormalize` 算子，它按主键缓存全部最新值，是隐藏的状态大户

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#_2、upsert-kafka-把更新流写进-kafka)

### Q24：为什么窗口 TVF 优于无界 GROUP BY？CUMULATE 适合什么场景？

**核心结论**：无界 `GROUP BY` 每来一条数据就发一次 `-U/+U`，状态永不过期。窗口 TVF 在水位线越过窗口后一次性输出并清理状态，结果只追加，下游简单得多。`CUMULATE` 用于「当天累计、每分钟输出一次」这类场景，在实时性和只追加之间取了折中。

- TVF 有 `TUMBLE` / `HOP` / `CUMULATE` / `SESSION` 四种，会给每行追加 `window_start` / `window_end` / `window_time`，还能接 Window Top-N、Window Join
- TVF 只认 DDL 中声明了 `WATERMARK FOR` 的事件时间列
- 代价是结果要等水位线推进；大窗口的 `COUNT(DISTINCT)` 要配合 mini-batch 与 distinct 拆分

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#三、窗口-tvf)

### Q25：Regular、Interval、Temporal、Lookup Join 的状态占用和结果确定性有什么差异？如何选型？

**核心结论**：Regular Join 的状态无界。Interval Join 按时间区间清理状态。Temporal Join 只保留维表的必要版本，结果可重放。Lookup Join 在 Flink 侧几乎没有状态，但结果不可重放。

| Join | 状态 | 确定性 | 适用 |
|------|------|--------|------|
| Regular | 两侧全量，无界 | 确定 | 无时间约束的全量关联，必须配 TTL |
| Interval | 按区间清理，有界 | 确定，输出只追加 | 两条事实流有时间约束 |
| Temporal | 右表每个主键的必要版本 | 按事件时刻关联，可重放 | 汇率、价格等版本表 |
| Lookup | 几乎无 | 处理时间查询，不可重放 | 大维表、变化慢 |

- Temporal Join 的右表要有主键和水位线（CDC 表或 upsert-kafka 表）
- Lookup Join 用 `PARTIAL` 缓存 + 异步 + `lookup_miss` 重试
- Delta Join（2.1 引入、2.2 增强）把双流 Join 改为到对侧存储按键查询，去掉大状态，但适用条件较窄

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#四、join-与状态)

### Q26：table.exec.state.ttl 默认值是多少？TTL 过期对聚合与 Join 结果有什么影响？

**核心结论**：默认值是 0，表示**永不清理**，这是无界聚合和 Regular Join 上线后状态无限增长的头号原因。TTL 的含义是「空闲多久后清理」，期间被访问过就续期。状态被清理后，同一个 key 再来数据时会被当作新 key：聚合从 0 重新开始，Join 匹配不到旧数据。TTL 是**用正确性换资源**。

- 三个粒度：作业级 `table.exec.state.ttl`；查询级 `STATE_TTL` 提示，按表设置，有别名时必须用别名；算子级通过 `COMPILE PLAN` 修改 JSON 计划
- TTL 按业务最大间隔设置，并在监控中关注状态大小

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#_1、三个粒度的-ttl)

### Q27：Flink CDC 的无锁增量快照算法如何保证全量与增量衔接一致？

**核心结论**：全量阶段按主键把表切成 chunk 并行读取。读每个 chunk 前后各记一次 binlog 位点（LOW / HIGH），再把 LOW 到 HIGH 之间属于该 chunk 主键范围的变更回放到读出的数据上，得到与 HIGH 时刻一致的快照。所有 chunk 完成后，由单个 binlog reader 从 HIGH 位点之后续读，已修正过的变更不会重复输出。

- 不加全局读锁，也不需要 `RELOAD` 权限；全量阶段可并行；以 chunk 为粒度断点续传
- binlog reader 要等全部 chunk 完成**且随后一次 Checkpoint 完成**才启动，所以不开 Checkpoint 时增量阶段永远不会开始
- chunk 默认 8096 行；无主键表必须指定唯一的 `chunk.key-column`

→ 详见 [Flink CDC](/flink/6_cdc#二、无锁增量快照)

### Q28：MySQL CDC 需要哪些数据库配置与权限？server-id 冲突会怎样？

**核心结论**：账号需要 `SELECT`、`SHOW DATABASES`、`REPLICATION SLAVE`、`REPLICATION CLIENT` 四项权限。binlog 要满足 `ROW` 格式、`binlog_row_image = FULL`、保留期大于作业最长停机时间，主从切换场景还要开启 GTID。CDC 以伪从库身份连接 MySQL，`server-id` 必须在**整个 MySQL 集群内唯一**。冲突时会报 server_id 重复，连接被踢掉。

- 增量快照下 `server-id` 配一个区间（如 `5401-5404`），区间大小须大于源并行度；每个作业分配独立区间并统一登记
- binlog 保留期太短时，恢复会报位点不存在，只能重做全量
- `server-time-zone` 与数据库时区不一致时，时间字段会偏移 8 小时

→ 详见 [Flink CDC](/flink/6_cdc#三、mysql-cdc-源)

### Q29：Flink CDC 的端到端精确一次在哪一段成立？下游为什么必须有主键？

**核心结论**：Source 到 Flink 状态这一段由连接器保证：binlog 位点和已完成的 chunk 都随 Checkpoint 保存，变更事件进入 Flink 时不丢不重。Flink 到外部系统这一段取决于 Sink。Paimon、Kafka 事务 Sink 能做到精确一次。Doris、StarRocks、JDBC 在故障后会重放数据，但按主键 upsert 时结果不变，效果上等价于精确一次。所以**下游表一定要有主键**，无主键的追加写在重放时会产生重复行。

- StarRocks 官方说明为至少一次 + 主键表幂等写
- Kafka Pipeline Sink 默认把所有记录写到 0 号分区，整库同步要改为 `hash-by-key`

→ 详见 [Flink CDC](/flink/6_cdc#六、精确一次)

## 六、部署与调优

### Q30：TaskManager 内存由哪几部分组成？容器被 OOMKilled 但 JVM 无异常，通常是什么原因？

**核心结论**：TaskManager 内存分为 Framework 堆与堆外、Task 堆与堆外、Network、Managed、Metaspace、JVM Overhead。容器部署只配 `taskmanager.memory.process.size`，其余部分按比例推导。JVM 没有异常、容器却被 OOMKilled，多半是**堆外内存超限**：RocksDB 原生内存、glibc 碎片、线程栈超出容器限制后，内核直接杀掉进程。

| 现象 | 区域 | 处理 |
|------|------|------|
| `Java heap space` | Task Heap | HashMap 状态过大换 RocksDB；减少 managed |
| `Direct buffer memory` | Task Off-Heap / Network | 调大 `task.off-heap.size` |
| `Metaspace` | Metaspace | Session 集群类加载器泄漏，改 Application 模式 |
| OOMKilled 无异常 | Overhead / RocksDB | 调大 `jvm-overhead`，确认 `rocksdb.memory.managed: true` |

- Managed 默认 40%，HashMap 状态后端的流作业用不到，应调小
- Network 默认 10%，不够时报 `Insufficient number of network buffers`

→ 详见 [部署与运维](/flink/7_deployment#二、内存模型)

### Q31：如何定位反压的根源算子？

**核心结论**：沿数据流**往下游**找，第一个 busy 高、自己却不被反压的算子就是瓶颈。

1. 看每个子任务的 `busyTimeMsPerSecond` / `backPressuredTimeMsPerSecond` / `idleTimeMsPerSecond`；Web UI 中 OK 为 0～10%、LOW 为 10%～50%、HIGH 为 50%～100%
2. 只有部分子任务忙 → 数据倾斜
3. 所有子任务都忙 → 开火焰图（`rest.flamegraph.enabled`）找热点，常见的是 Kryo 回退、JSON 解析、同步调用外部服务
4. Sink 忙 → 外部系统写入慢，加批量、异步，或扩容外部系统
5. 周期性反压 → 对照 Checkpoint 时间点，可能是 RocksDB compaction 或上传在抢 I/O

- 算子链会把多个算子合成一个节点，排查时可以临时 `disableChaining()`

→ 详见 [部署与运维](/flink/7_deployment#四、反压诊断)

### Q32：Flink 数据倾斜有哪几种来源？如何处理？为什么加并行度无效？

**核心结论**：倾斜有三种来源：Source 分区不均、`keyBy` 热点 key、窗口或 Join 热点。热点 key 的数据总是落在同一个子任务上，所以**加并行度无效**，要把热点打散。

| 来源 | 处理 |
|------|------|
| Source 倾斜 | 修上游分区键，或 Source 后 `rebalance()` |
| keyBy 热点 | 两阶段聚合：先 `key + 随机后缀` 局部聚合，再按原 key 汇总 |
| Join 热点 | 大 key 单独走广播或 Lookup |
| 异常大 key | 测试账号、爬虫流量在 Source 后直接过滤 |

- 两阶段聚合只适用于 SUM、COUNT、MAX 这类可分解的聚合，`COUNT(DISTINCT)` 要按去重字段打散
- SQL 里开启 mini-batch + `TWO_PHASE` 聚合 + distinct 拆分即可，不用手写

→ 详见 [部署与运维](/flink/7_deployment#六、数据倾斜)、[Flink SQL 与 Table API](/flink/5_sql#_2、聚合调优)

### Q33：升级作业时哪些改动会导致无法从 Savepoint 恢复？Kubernetes Operator 的 upgradeMode 有什么区别？

**核心结论**：以下改动会导致无法恢复：有状态算子没设 `uid` 且拓扑变了、Kryo 序列化的状态类改了字段、POJO 改了字段类型、修改了最大并行度、开关了 TTL（2.2 之前）、SQL 改动导致执行计划和算子 uid 变化、从 1.x 跨大版本升级到 2.x。

| upgradeMode | 行为 | 适用 |
|-------------|------|------|
| `stateless` | 直接重启，丢弃状态 | 无状态作业 |
| `savepoint` | 先做 Savepoint 再停，用它启动新版本 | 有状态作业，作业健康时，生产首选 |
| `last-state` | 用 HA 元数据中最近的 Checkpoint 恢复，不要求作业健康 | 作业已不健康、做不出 Savepoint 时兜底，需开 HA |

- 删除了旧算子时加 `--allowNonRestoredState` 跳过对应状态
- SQL 大改通常要重跑或双跑切换；1.x 升 2.x 可用 State Processor API 迁移状态

→ 详见 [部署与运维](/flink/7_deployment#八、用-savepoint-升级)

### Q34：用 Flink 实现实时 GMV 大屏，如何保证口径准确、0 点清零与幂等写入？

**核心结论**：按支付时间（事件时间）统计，用 `CUMULATE` 窗口做当日累计、每分钟输出，结果表以「日期 + 类目 + 窗口结束时间」为主键 upsert。

- **口径**：事件时间统计，重启、积压追数后结果与离线一致；迟到数据的剩余差异由 T+1 离线报表校准
- **0 点清零**：`CUMULATE` 的日窗口结束后状态自动清理；`table.local-time-zone = 'Asia/Shanghai'` 保证一天从北京时间 0 点开始
- **幂等**：结果主键 upsert，重放覆盖同一行；重复消息由上游 DWD 作业按订单号去重（保留第一条，配 TTL）
- **热点与读取**：大类目的 `COUNT(DISTINCT)` 开 mini-batch 与 distinct 拆分；大屏后端查询结果并缓存，不让客户端直接查库

→ 详见 [实战场景](/flink/8_scenarios#一、实时-gmv-大屏)

### Q35：维表关联有哪些方案？维度数据晚到怎么办？

**核心结论**：维表小、变化需要实时生效时用 Broadcast State。维表大时用 Lookup Join 加缓存和异步。必须按事件时刻关联时用 Temporal Join。维度晚到时，用 `lookup_miss` 延迟重试，或者把关联不上的数据输出到侧输出流稍后补偿。

| 方案 | 维度一致性 | Flink 状态 | 适用 |
|------|-----------|-----------|------|
| Lookup Join + 缓存 | 处理时刻的值，缓存期内可能旧 | 几乎无 | 大维表、变化慢 |
| Temporal Join | 事件时刻的值，可重放 | 维表全量版本 | 汇率、价格 |
| Broadcast State | 最新值 | 维表全量 × 并行度 | 小维表、规则配置 |
| 预加载 + 定时刷新 | 刷新周期内可能旧 | 堆内存 | 很小且几乎不变的码表 |

- `lookup_miss` 的重试参数没有默认值，需要全部显式设置；`PARTIAL` 缓存默认缓存空值，与重试要一起权衡
- Broadcast State 启动时事实流可能先到，维表加载完成前先把事实数据缓存在 keyed state 中

→ 详见 [实战场景](/flink/8_scenarios#四、维表关联策略)、[Flink SQL 与 Table API](/flink/5_sql#_4、lookup-join-维表查询)

---
description: 选型与架构、DataStream、水位线与窗口、状态与 Checkpoint、精确一次、SQL 与 CDC、部署调优
---

# Flink 面试题解答

> 题目清单见 [Flink 面试题](/flink/99_interview)；细节详见 [Flink 总览](/flink/0_overview)。
>
> 版本基线：Flink 2.2.x、Flink CDC 3.6，与 1.x 不同处单独说明。

## 一、基础与架构

### Q1：Flink 与 Spark Streaming、Kafka Streams 如何选型？

**一句话**：数据进出都在 Kafka、逻辑简单，用 Kafka Streams；已经有 Spark 离线体系、能接受秒到分钟级延迟，用 Spark；要毫秒级延迟、大状态、按事件发生时间算，或者做 CDC 入湖，用 Flink。

| 对比 | Flink | Spark Structured Streaming | Kafka Streams |
|------|-------|----------------------------|---------------|
| 处理方式 | 来一条处理一条 | 攒一小批处理一次（微批） | 来一条处理一条 |
| 延迟 | 毫秒级 | 秒级 | 毫秒级 |
| 部署 | 独立集群（K8s / YARN） | Spark 集群 | 一个 Jar 包，嵌在应用里 |
| 数据源 | 任意 | 任意 | 只能 Kafka 进、Kafka 出 |

- Flink 的代价是运维重：要独立集群、状态存储，升级要先做 Savepoint；团队没有平台能力时优先用云厂商托管版
- 新项目不建议再选 Storm

→ 详见 [Flink 概览](/flink/1_basics#二、为什么选-flink-与其他方案对比)

### Q2：JobManager 的 Dispatcher、ResourceManager、JobMaster 各负责什么？Slot 隔离什么？一个作业需要多少 Slot？

**一句话**：Dispatcher 是接收作业的入口，ResourceManager 管资源和 Slot，JobMaster 每个作业一个、负责调度和 Checkpoint。Slot 只隔离托管内存（Flink 自己管理的那块内存），不隔离 CPU；默认多个算子能挤进同一个 Slot，所以作业需要的 Slot 数等于最大的算子并行度。

- Dispatcher：接收提交、给作业启动 JobMaster、提供 Web UI，每个集群一个
- ResourceManager：向 K8s / YARN 申请或释放 TaskManager（干活的进程），分配 Slot，每个集群一个
- JobMaster：把作业拆成任务去调度、协调 Checkpoint、故障恢复，每个作业一个
- Slot 是 TaskManager 的一份资源，个数一般取容器的 CPU 核数
- JobManager 要开高可用（ZooKeeper 或 K8s），挂了才能找回最近一次的 Checkpoint

→ 详见 [Flink 概览](/flink/1_basics#三、运行时架构)

### Q3：什么是算子链？什么情况下会断链？

**一句话**：上下游算子满足条件时会合并成一个任务，在同一个线程里直接方法调用传数据，省掉序列化、网络传输和线程切换。`keyBy`、`rebalance` 这类重新分发数据的操作，以及并行度变化，都会断链。

- 合并条件：一对一直连、并行度相同、在同一个 Slot 共享组、没有手动禁用
- 手动控制：`disableChaining()`、`startNewChain()`；`env.disableOperatorChaining()` 全局关闭，一般只用来排查
- 生产默认不关；Web UI 上一条链只显示一个节点，要定位链里哪个算子慢时才临时断开

→ 详见 [Flink 概览](/flink/1_basics#_3、并行度与算子链)

### Q4：Flink 2.0 有哪些破坏性变化？为什么移除 Per-Job 模式？

**一句话**：Flink 2.0 删了一批旧 API 和旧部署方式，**状态不保证能从 1.x 直接恢复**，连接器也要换成适配 2.x 的版本。Per-Job 被删是因为 Application 模式完全能替代它：`main()` 在集群里跑，提交机不用下载依赖，也更适合容器。

- 删掉的 API：DataSet API 和 Scala API（改用 DataStream 批模式、Table API / SQL）；旧的 `SourceFunction` / `SinkFunction`（改用新 Source / Sink API）
- 写法变化：`open(Configuration)` 改为 `open(OpenContext)`；`Time` 类改用 `java.time.Duration`
- 配置变化：`flink-conf.yaml` 改为标准 YAML 的 `config.yaml`；重启策略、状态后端改用配置项设置
- 运行环境：不再支持 Java 8，默认 Java 17

→ 详见 [Flink 概览](/flink/1_basics#六、flink-2-x-的关键变化)

### Q5：为什么 maxParallelism 上线后不能改？Key Group 是什么？

**一句话**：Flink 先把每个 key 哈希到固定数量的「Key Group」（数量就是 `maxParallelism`），再把一段段 Key Group 分给各个子任务。改了 `maxParallelism`，key 落到哪个 Key Group 就全变了，旧状态对不上，无法恢复。

- 好处：扩缩容时只要整块搬 Key Group，不用对每个 key 重新哈希
- 并行度最多只能扩到 `maxParallelism`
- 首次上线就显式设一个因数多的值（如 720、1024）；不设会按初始并行度推算，以后扩容可能受限

→ 详见 [状态与容错](/flink/4_state_checkpoint#_1、keyed-state-与-operator-state)

## 二、DataStream

### Q6：KafkaSource 的 offset 以什么为准？提交到 Kafka 的 offset 有什么用？

**一句话**：从 Checkpoint 或 Savepoint 恢复时，以状态里记录的 offset 为准；`setStartingOffsets` 只在第一次启动时有用。提交回 Kafka 的 offset **只给监控看消费延迟，不参与容错**。

- 所以消费组的 lag 偶尔「倒退」不代表丢数据
- Source 并行度不要超过分区数：多出来的读取任务没数据，水位线不前进，会卡住下游窗口
- 补数、回溯历史数据用 `setBounded(...)`，读到指定位置就结束

→ 详见 [DataStream API](/flink/2_datastream#_2、kafkasource)

### Q7：解析失败为什么不能抛异常？脏数据怎么处理？

**一句话**：抛异常会让作业重启，重启后从 Checkpoint 重放又碰到同一条脏数据，作业就无限重启（这种消息叫「毒丸」）。正确做法是 catch 住，把脏数据从侧输出送到死信 topic，再对死信数量告警、人工处理。

- 侧输出：用 `OutputTag` 定义一个旁路出口，`ctx.output(tag, value)` 发出去，`getSideOutput(tag)` 拿到这条流
- `ObjectMapper` 这类不能序列化的对象加 `transient`，在 `open()` 里创建
- SQL 的 `json.ignore-parse-errors` 会悄悄跳过脏数据，上线前确认这是你想要的

→ 详见 [DataStream API](/flink/2_datastream#五、侧输出-side-output)

### Q8：维表关联为什么用异步 I/O？有序与无序模式有什么区别？timeout 要注意什么？

**一句话**：在 `map` 里同步查库，每条都要等一次网络往返，10 ms 延迟意味着一个子任务每秒只能处理 100 条。异步 I/O 让一个子任务同时挂起很多请求，吞吐大约是「同时在途请求数 / 延迟」。

- 客户端必须是真异步的；在 `asyncInvoke` 里调用阻塞 API 等于没异步
- `unorderedWait`：谁先返回谁先输出，延迟低；`orderedWait`：保持输入顺序，多一些缓冲开销
- `capacity` 是在途请求上限，满了会让上游慢下来，也顺便保护了被查的服务
- 可以加本地缓存（如 Caffeine）减少请求；SQL 里对应的是 Lookup Join

**常见坑**：`timeout()` 默认实现是抛异常，会导致作业重启，生产必须重写成降级逻辑。

→ 详见 [DataStream API](/flink/2_datastream#七、异步-i-o-维表关联)

### Q9：为什么要避免 Kryo 序列化？Lambda 的泛型擦除怎么解决？

**一句话**：Flink 认不出的类型会退回用 Kryo 通用序列化，又慢、又不支持改字段，类加个字段就无法从 Savepoint 恢复。生产用 POJO 或 record，并配 `pipeline.generic-types: false`，让退回 Kryo 在开发时就直接报错。

- POJO 规则：public 类、public 无参构造器、字段 public 或有 getter / setter；有一个字段不合规，整个类都会退回 Kryo
- POJO / record 支持增删字段，不支持改字段类型
- Lambda 返回 `Tuple2` 这类泛型时 Java 会擦掉类型，Flink 推断不出来报错：加 `.returns(Types.TUPLE(...))`，或改用匿名类

→ 详见 [DataStream API](/flink/2_datastream#九、序列化与类型信息的坑)

## 三、时间与窗口

### Q10：什么是水位线？多输入算子的水位线如何计算？

**一句话**：水位线是夹在数据里的一个时间标记 T，意思是「事件时间不超过 T 的数据应该都到了」，窗口和定时器据此触发。一个算子有多个输入时，取所有输入里**最小的**水位线，所以最慢的分区决定整个作业的进度。

- 本质是取舍：等得越久数据越全，但结果出来越晚
- 最常用 `forBoundedOutOfOrderness(d)`：水位线 = 见过的最大时间戳 − d（再减 1 ms）
- 乱序容忍度 d 按「事件时间和到达时间的差」的 P99 定，剩下的长尾交给迟到数据处理
- 尽量在 `fromSource` 上设置：KafkaSource 会按分区分别算水位线再取最小值

→ 详见 [时间、水位线与窗口](/flink/3_time_window#二、水位线-watermark)

### Q11：窗口迟迟不触发是什么原因？怎么解决？（空闲分区 / idleness）

**一句话**：通常是某些分区没数据，它们的水位线停住不动，把下游的最小水位线拖住了，比如并行度大于分区数、夜里部分分区没流量。解决办法是 `withIdleness(Duration)`：一段时间没数据就标记为空闲，算最小值时先不算它。

- SQL 里对应 `table.exec.source.idle-timeout`
- 另一种情况是回溯时快分区跑得太远、状态暴涨，用 `withWatermarkAlignment` 让快分区等一等

**常见坑**：空闲超时设得比正常数据间隔还短，低流量分区被误判为空闲，它的数据反而变成迟到数据。

→ 详见 [时间、水位线与窗口](/flink/3_time_window#_4、空闲检测-idleness)

### Q12：迟到数据有哪三道防线？allowedLateness 对下游有什么要求？

**一句话**：水位线已经过了窗口结束时间才到的数据，默认直接丢掉。三道防线依次是：水位线多等一会儿、`allowedLateness` 窗口关了再留一段时间、超时的走侧输出。开了 `allowedLateness`，同一个窗口会**输出多次**，下游必须按窗口主键覆盖写。

| 防线 | 做法 | 代价 |
|------|------|------|
| 水位线延迟 | 调大乱序容忍度 | 所有窗口都晚出结果 |
| `allowedLateness` | 窗口触发后保留状态，迟到数据来了再触发一次 | 状态留得更久，下游收到多次结果 |
| 侧输出 | 再晚的数据走 `sideOutputLateData` | 要单独补偿或对账 |

**常见坑**：下游是只追加的明细表，同一窗口的结果会被重复累加。

→ 详见 [时间、水位线与窗口](/flink/3_time_window#三、迟到数据)

### Q13：滚动、滑动、会话窗口有什么区别？滑动窗口为什么可能状态爆炸？按自然日统计要注意什么？

**一句话**：滚动窗口大小固定、互不重叠；滑动窗口按步长往前滑、会重叠；会话窗口在两条数据间隔超过 gap 时切开。滑动窗口会把每条数据复制进「窗口大小 / 步长」个窗口，步长太小状态就爆炸。

| 窗口 | 特点 | 场景 |
|------|------|------|
| 滚动 | 固定大小、不重叠 | 每分钟 PV、每小时 GMV |
| 滑动 | 固定大小、会重叠 | 最近 10 分钟，每分钟刷新 |
| 会话 | 大小不固定，按空闲间隔切分 | 用户会话分析 |

- 1 小时窗口、1 秒步长，每条数据要进 3600 个窗口；改用「滚动小窗口 + 下游累加」
- 窗口按 UTC 时间对齐，在中国按自然日统计要偏移 −8 小时：`TumblingEventTimeWindows.of(Duration.ofDays(1), Duration.ofHours(-8))`

**常见坑**：`windowAll` 并行度只有 1，量大时成为瓶颈。

→ 详见 [时间、水位线与窗口](/flink/3_time_window#四、窗口类型)

### Q14：增量聚合与全量窗口函数有什么区别？如何组合使用？

**一句话**：`reduce` / `aggregate` 是增量聚合，来一条算一条，状态里只存一个累加结果，但拿不到窗口信息；`ProcessWindowFunction` 先把窗口里的数据全存下来，触发时一次处理，能拿到窗口起止时间。生产首选两者组合。

- 组合写法：`aggregate(agg, processWindowFunction)`，状态只存累加结果，触发时再把结果和窗口时间一起输出
- 只有真的需要全部数据时（中位数、窗口内排序）才单用 `ProcessWindowFunction`，并注意窗口数据量
- 触发逻辑复杂时，用 `KeyedProcessFunction` + 定时器写更直观

→ 详见 [时间、水位线与窗口](/flink/3_time_window#五、窗口函数)

### Q15：Window Join 与 Interval Join 有什么区别？

**一句话**：Window Join 把两条流按 key 放进同一个窗口里配对，窗口边界会把本该配上的数据切开，比如订单 4:59 下单、5:01 支付就关联不上。Interval Join 以一边的事件为准，去找另一边在前后一段时间内的数据，没有边界问题，更常用。

- Interval Join 只支持事件时间、只支持内连接
- 两边数据都要缓存，水位线过了时间区间才清理，区间越大状态越大
- 要外连接：用 `connect` + `KeyedCoProcessFunction` + 定时器自己写，或用 Flink SQL
- 一边是变化很慢的维表时不要用双流 Join，改用异步 I/O 或广播状态

→ 详见 [时间、水位线与窗口](/flink/3_time_window#七、双流-join)

## 四、状态与容错

### Q16：状态 TTL 的语义是什么？有哪些坑？

**一句话**：TTL 让状态在一段时间后自动过期。key 越来越多的状态不设 TTL，会一直膨胀，Checkpoint 和恢复越来越慢，最后撑满磁盘。

- **只按机器时间算**：回溯历史数据时也按当前时间过期；要按事件时间过期，自己注册定时器 `clear()`
- **过期不是立刻删**：是读到或后台清理时才删；RocksDB 用 `cleanupInRocksdbCompactFilter`，堆内状态用 `cleanupIncrementally`
- 何时续期：默认创建和写入时续期，会话类状态改成读写都续期
- SQL 的 TTL 见 Q26

**常见坑**：2.2 之前给已有状态开启或关闭 TTL 会导致状态不兼容，TTL 要在首次上线时就设计好（2.2 起可以平滑切换）。

→ 详见 [状态与容错](/flink/4_state_checkpoint#三、状态-ttl)

### Q17：HashMap、RocksDB、ForSt 状态后端如何选择？

**一句话**：状态小、追求吞吐用 `hashmap`（默认）；状态大、key 多、窗口长用 `rocksdb` 加增量 Checkpoint，这是生产最常见的组合；`forst` 把状态放到远端存储，目前还是实验特性，只适合评估。

| 后端 | 状态放在哪 | 读写开销 | 能存多大 |
|------|-----------|---------|---------|
| `hashmap` | JVM 堆里的 Java 对象 | 最低 | GB 级，受堆大小限制 |
| `rocksdb` | 本地磁盘，存序列化后的字节 | 每次读写都要序列化 | TB 级，受磁盘限制 |
| `forst` | 远端存储为主，本地做缓存 | 远程读写，靠异步掩盖延迟 | 只受远端存储限制 |

- 状态后端（运行时放哪）和 Checkpoint 存储（快照写到哪）是两个独立配置
- RocksDB 本地目录放 SSD；大列表用 `ListState` / `MapState`，不要用 `ValueState<List>` 整个读写

→ 详见 [状态与容错](/flink/4_state_checkpoint#五、状态后端)

### Q18：Checkpoint 的原理是什么（barrier、对齐）？非对齐 Checkpoint 解决什么问题？

**一句话**：Source 往数据流里插一个特殊标记 barrier，并记下当前读到哪；barrier 随数据流到下游，把数据分成「之前」和「之后」。每个算子收到所有输入的 barrier 就给自己的状态拍快照，全部算子拍完，就得到一份前后一致的全局快照。

- 对齐（默认）：先收到 barrier 的输入先暂停，等其他输入的 barrier 都到了再拍快照；快照小，但反压时 barrier 堵在缓冲区里，等很久
- 非对齐：barrier 直接越过缓冲区里的数据，把这些在途数据一起存进快照；不受反压影响，但快照更大
- 推荐组合：开启非对齐，并设 `setAlignedCheckpointTimeout(30s)`，对齐超时后才自动切换
- 拍快照分两步：同步阶段很短，上传文件放在异步阶段，不挡数据处理

**常见坑**：RocksDB 增量 Checkpoint 的 `shared` 目录被多个快照共用，不要手工删。

→ 详见 [状态与容错](/flink/4_state_checkpoint#六、checkpoint-原理)

### Q19：Checkpoint 与 Savepoint 有什么区别？为什么要给算子设置 uid？

**一句话**：Checkpoint 是 Flink 自动定时做的，用于故障自动恢复；Savepoint 是人手动做的，用于升级代码、改并行度、迁移集群。从 Savepoint 恢复时按算子 uid 把状态对回去，不设 uid 就用自动生成的 ID，拓扑一改 ID 就变，状态全丢。

| 对比 | Checkpoint | Savepoint |
|------|------------|-----------|
| 谁触发 | Flink 自动、频繁 | 人手动、偶尔 |
| 谁删除 | 默认作业取消时删 | Flink 不删，自己管理 |
| 格式 | 状态后端原生格式，可增量 | 标准格式，可换状态后端 |

- 发布升级用 `flink stop --savepointPath`，停作业和做 Savepoint 一步完成

**常见坑**：升级时加了 `--drain`，它会强制触发所有窗口输出，只适合永久下线。

→ 详见 [状态与容错](/flink/4_state_checkpoint#七、checkpoint-与-savepoint)

### Q20：如何实现端到端精确一次？两阶段提交的流程是什么？Kafka 事务 Sink 要注意什么？

**一句话**：要同时满足三件事：Source 能重放、Checkpoint 用 `EXACTLY_ONCE` 模式、Sink 是事务写或幂等写。两阶段提交就是：数据先写进一个事务 → barrier 到达时预提交 → 整个 Checkpoint 成功后才正式提交 → 恢复时把没提交的补提交、没完成的回滚。

- `transactionalIdPrefix` 必填，同一 Kafka 集群内每个作业不能重复，否则互相踢掉对方的事务
- 下游消费者必须设 `isolation.level=read_committed`，只读已提交的数据
- 数据要等 Checkpoint 完成才可见，所以延迟至少是一个 Checkpoint 间隔
- 能用幂等写（按主键 upsert、Redis `SET`）就别用事务，更简单、延迟更低；`INCR` 和追加写不算幂等

**常见坑**：`transaction.timeout.ms` 小于「Checkpoint 间隔 + 重启时间」，Kafka 会先把事务中止掉，导致丢数据。

→ 详见 [状态与容错](/flink/4_state_checkpoint#九、端到端精确一次)

### Q21：Checkpoint 超时或耗时长如何排查与优化？

**一句话**：先看 Web UI 里每个子任务的 Checkpoint 耗时拆分，判断慢在哪一步。barrier 迟迟到不了，就是反压，这是头号原因；上传阶段慢，就是状态太大或存储带宽不够。不要一味调大超时。

| 哪项偏大 | 原因 | 怎么办 |
|---------|------|-------|
| Start Delay（barrier 到达慢） | 反压，barrier 在排队 | 先解决反压；开非对齐 Checkpoint |
| Alignment（对齐慢） | 各输入进度差太多、数据倾斜 | 处理倾斜；开非对齐 |
| Async（异步上传慢） | 状态大、没开增量、带宽不够 | 开增量；设 TTL；查对象存储限流 |

- `tolerable-failed-checkpoints` 默认 0，失败一次就重启，建议调到 3 左右并配告警
- 间隔一般 1～5 分钟；成功率、耗时、大小都接入监控

→ 详见 [状态与容错](/flink/4_state_checkpoint#十、checkpoint-耗时调优)、[部署与运维](/flink/7_deployment#五、checkpoint-失败)

## 五、SQL 与 CDC

### Q22：什么是动态表？+I / -U / +U / -D 分别何时出现？append、retract、upsert 流有什么区别？

**一句话**：Flink SQL 是一个一直在跑的查询：输入流被看成一张不断变化的表，查询结果也是一张不断变化的表，结果的每次变化用「新增 / 撤回 / 更新 / 删除」标记发给下游。

- `+I` 新增一行，所有查询都有；`-U` / `+U` 是「撤回旧值 / 写入新值」，出现在不开窗的聚合、普通 Join、Top-N
- `-D` 删除，出现在 CDC 源、Top-N 被挤出、外连接撤回补 null 的行
- Append 流：只有 `+I`，比如过滤、窗口聚合，写到任何 Sink 都行
- Retract 流：更新拆成 `-U` + `+U`，下游要能撤回；Upsert 流：有主键，省掉 `-U`，下游按主键覆盖写
- 用 `EXPLAIN CHANGELOG_MODE` 能看到每个算子输出哪种流

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#一、动态表与-changelog)

### Q23：为什么一条 SQL 写 Kafka 会报 doesn't support consuming update changes？怎么解决？

**一句话**：这条 SQL 的结果会更新（比如不开窗的 `GROUP BY` 或普通 Join），而普通 `kafka` 连接器只能追加写。两种解法：Sink 换成声明了主键的 upsert-kafka；或者把查询改成窗口聚合、Interval Join 这类只追加的写法。

- upsert-kafka 把主键写进消息 key，删除写成值为空的消息，配合 compact 主题就是一张「最新值表」

**常见坑**：upsert-kafka 当源表读时，Flink 会自动加一个按主键缓存全部最新值的算子，是隐藏的状态大户。

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#_2、upsert-kafka-把更新流写进-kafka)

### Q24：为什么窗口 TVF 优于无界 GROUP BY？CUMULATE 适合什么场景？

**一句话**：不开窗的 `GROUP BY` 每来一条就发一次更新，状态永不过期；窗口 TVF 等水位线过了窗口才一次性输出并清掉状态，结果只追加，下游简单得多。`CUMULATE` 用于「当天累计、每分钟出一次」这种场景。

- 窗口 TVF 就是在 `FROM` 里写 `TUMBLE` / `HOP` / `CUMULATE` / `SESSION` 窗口函数，每行会多出 `window_start` / `window_end` 列
- 必须用 DDL 里声明了 `WATERMARK FOR` 的时间列
- 代价是结果要等水位线推进才出来

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#三、窗口-tvf)

### Q25：Regular、Interval、Temporal、Lookup Join 的状态占用和结果确定性有什么差异？如何选型？

**一句话**：Regular Join 两边全存、状态无限增长；Interval Join 按时间区间清理；Temporal Join 只存维表必要的历史版本，结果能重放；Lookup Join 每条去外部查，Flink 几乎不存状态，但结果没法重放。

| Join | 状态 | 重跑结果一样吗 | 适用 |
|------|------|--------------|------|
| Regular | 两边全量，无限增长 | 一样 | 无时间约束的关联，必须配 TTL |
| Interval | 按时间区间清理 | 一样 | 两条事实流，有时间范围 |
| Temporal | 维表每个主键的必要版本 | 一样，按事件发生时的值关联 | 汇率、价格这类版本表 |
| Lookup | 几乎没有 | 不一样，查的是当时最新值 | 大维表、变化慢 |

- Temporal Join 的右表要有主键和水位线（CDC 表或 upsert-kafka 表）
- Lookup Join 配缓存 + 异步查询

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#四、join-与状态)

### Q26：table.exec.state.ttl 默认值是多少？TTL 过期对聚合与 Join 结果有什么影响？

**一句话**：默认是 0，也就是**永不清理**，这是 SQL 作业上线后状态无限增长的头号原因。TTL 的意思是「多久没被访问就清理」；清理后同一个 key 再来数据会被当成新 key：聚合从 0 开始算，Join 匹配不到旧数据。TTL 本质是拿正确性换资源。

- 三种粒度：整个作业用 `table.exec.state.ttl`；单个查询用 `STATE_TTL` 提示按表设置；单个算子要改编译出的执行计划
- TTL 按业务上同一个 key 最长的间隔来定，并监控状态大小

→ 详见 [Flink SQL 与 Table API](/flink/5_sql#_1、三个粒度的-ttl)

### Q27：Flink CDC 的无锁增量快照算法如何保证全量与增量衔接一致？

**一句话**：全量阶段按主键把表切成很多小块（chunk）并行读。读每块前后各记一次 binlog 位置（LOW / HIGH），把这段时间里属于这块的变更补到读出的数据上，得到 HIGH 时刻的准确数据。全部块读完后，再从 binlog 接着读增量，已经补过的变更不会重复。

- 好处：不加全局读锁、全量能并行、按块断点续传
- 增量阶段要等所有块读完且之后一次 Checkpoint 成功才开始，所以不开 Checkpoint 时增量永远不会开始
- 没有主键的表必须指定一个唯一列 `chunk.key-column` 来切块

→ 详见 [Flink CDC](/flink/6_cdc#二、无锁增量快照)

### Q28：MySQL CDC 需要哪些数据库配置与权限？server-id 冲突会怎样？

**一句话**：账号要 `SELECT`、`SHOW DATABASES`、`REPLICATION SLAVE`、`REPLICATION CLIENT` 四个权限；binlog 要用 `ROW` 格式、`binlog_row_image = FULL`。CDC 是伪装成从库连 MySQL 的，`server-id` 必须在整个 MySQL 集群里唯一，冲突时连接会被踢掉。

- `server-id` 配一个区间（如 `5401-5404`），区间大小要大于 Source 并行度；每个作业分配独立区间并登记
- binlog 保留时间要长于作业最长停机时间，否则恢复时找不到位点，只能重做全量
- 有主从切换的场景要开启 GTID

**常见坑**：`server-time-zone` 和数据库时区不一致，时间字段差 8 小时。

→ 详见 [Flink CDC](/flink/6_cdc#三、mysql-cdc-源)

### Q29：Flink CDC 的端到端精确一次在哪一段成立？下游为什么必须有主键？

**一句话**：数据库到 Flink 这一段由连接器保证：binlog 位置随 Checkpoint 保存，变更进 Flink 时不丢不重。Flink 到下游这一段看 Sink：Paimon、Kafka 事务写能做到精确一次；Doris、StarRocks、JDBC 故障后会重放，但只要按主键覆盖写，结果还是一样。所以**下游表一定要有主键**。

- 没有主键的追加写，重放时会多出重复行
- StarRocks 官方的说法是「至少一次 + 主键表幂等写」

**常见坑**：Kafka Pipeline Sink 默认把所有数据写到 0 号分区，整库同步要改成按主键哈希分区。

→ 详见 [Flink CDC](/flink/6_cdc#六、精确一次)

## 六、部署与调优

### Q30：TaskManager 内存由哪几部分组成？容器被 OOMKilled 但 JVM 无异常，通常是什么原因？

**一句话**：TaskManager 内存分成堆、堆外、网络缓冲、托管内存（给 RocksDB 等用）、元空间和 JVM 额外开销几块；容器部署只需配总量 `taskmanager.memory.process.size`，其余按比例算。JVM 没报错容器却被杀，多半是**堆外内存超了**：RocksDB 自己申请的内存、线程栈等超过容器限制，被系统直接杀掉。

| 现象 | 怎么办 |
|------|-------|
| `Java heap space` | HashMap 状态太大，换 RocksDB |
| `Direct buffer memory` | 调大 `task.off-heap.size` |
| `Metaspace` | Session 集群类加载器泄漏，改 Application 模式 |
| 被 OOMKilled 但没异常 | 调大 `jvm-overhead`，确认 `rocksdb.memory.managed: true` |

- 托管内存默认占 40%，用 HashMap 状态后端的流作业用不上，应调小

→ 详见 [部署与运维](/flink/7_deployment#二、内存模型)

### Q31：如何定位反压的根源算子？

**一句话**：顺着数据流往下游找，第一个自己很忙、但没有被下游反压的算子就是瓶颈。

- 看每个子任务的三个指标：忙碌时间、被反压时间、空闲时间（Web UI 上 HIGH 表示超过 50%）
- 只有部分子任务忙 → 数据倾斜，见 Q32
- 所有子任务都忙 → 开火焰图找热点，常见是退回 Kryo、JSON 解析、同步调外部服务
- Sink 忙 → 外部系统写得慢，改批量、异步写或扩容外部系统；周期性反压 → 对照 Checkpoint 时间，可能是磁盘 I/O 被抢

**常见坑**：算子链会把多个算子合成一个节点，排查时可临时 `disableChaining()` 拆开看。

→ 详见 [部署与运维](/flink/7_deployment#四、反压诊断)

### Q32：Flink 数据倾斜有哪几种来源？如何处理？为什么加并行度无效？

**一句话**：倾斜有三种来源：Source 分区不均、`keyBy` 有热点 key、窗口或 Join 有热点。同一个 key 的数据总是落到同一个子任务，所以**加并行度没用**，要把热点打散。

| 来源 | 处理 |
|------|------|
| Source 分区不均 | 修上游分区键，或读完后 `rebalance()` |
| keyBy 热点 | 两阶段聚合：先给 key 加随机后缀局部聚合，再按原 key 汇总 |
| Join 热点 | 大 key 单独走广播或 Lookup |
| 异常大 key | 测试账号、爬虫流量在 Source 后直接过滤 |

- 两阶段聚合只适合 SUM、COUNT、MAX 这类能分开算再合并的聚合
- SQL 打开 mini-batch 和两阶段聚合配置即可，不用手写

→ 详见 [部署与运维](/flink/7_deployment#六、数据倾斜)、[Flink SQL 与 Table API](/flink/5_sql#_2、聚合调优)

### Q33：升级作业时哪些改动会导致无法从 Savepoint 恢复？Kubernetes Operator 的 upgradeMode 有什么区别？

**一句话**：常见的有：有状态算子没设 uid 且拓扑变了、Kryo 序列化的类改了字段、POJO 改了字段类型、改了 `maxParallelism`、2.2 之前开关 TTL、SQL 改动导致执行计划变化、从 1.x 跨大版本升到 2.x。

| upgradeMode | 做法 | 适用 |
|-------------|------|------|
| `stateless` | 直接重启，不要状态 | 无状态作业 |
| `savepoint` | 先做 Savepoint 再停，用它启动新版本 | 作业健康时，生产首选 |
| `last-state` | 用最近一次 Checkpoint 恢复 | 作业已不健康、做不出 Savepoint 时兜底，需开高可用 |

- 删掉了旧算子时加 `--allowNonRestoredState`，跳过对不上的状态
- SQL 大改通常要重跑或新旧双跑再切换

→ 详见 [部署与运维](/flink/7_deployment#八、用-savepoint-升级)

### Q34：用 Flink 实现实时 GMV 大屏，如何保证口径准确、0 点清零与幂等写入？

**一句话**：按支付时间（事件时间）统计，用 `CUMULATE` 窗口做当日累计、每分钟出一次结果，结果表以「日期 + 类目 + 窗口结束时间」为主键覆盖写。

- **口径准**：按事件时间算，重启或积压后追数结果不变；迟到数据造成的少量差异由第二天的离线报表校准
- **0 点清零**：一天的窗口结束后状态自动清理；设 `table.local-time-zone = 'Asia/Shanghai'`，一天从北京时间 0 点开始
- **幂等**：按主键覆盖写，重放只会覆盖同一行；重复消息由上游按订单号去重
- **读取**：大屏后端查结果并缓存，不让前端直接查库

→ 详见 [实战场景](/flink/8_scenarios#一、实时-gmv-大屏)

### Q35：维表关联有哪些方案？维度数据晚到怎么办？

**一句话**：维表小、变更要马上生效，用广播状态；维表大，用 Lookup Join 加缓存和异步；必须按事件发生时的值关联，用 Temporal Join。维度数据晚到时，用 Lookup Join 的查不到重试（`lookup_miss`），或把关联不上的数据放到侧输出稍后补。

| 方案 | 拿到的维度值 | Flink 状态 | 适用 |
|------|------------|-----------|------|
| Lookup Join + 缓存 | 处理时的值，缓存期内可能旧 | 几乎无 | 大维表、变化慢 |
| Temporal Join | 事件发生时的值，可重放 | 维表全部版本 | 汇率、价格 |
| 广播状态 | 最新值 | 维表全量 × 并行度 | 小维表、规则配置 |

**常见坑**：广播状态启动时事实数据可能比维表先到，维表加载完前要先把事实数据暂存起来。

→ 详见 [实战场景](/flink/8_scenarios#四、维表关联策略)、[Flink SQL 与 Table API](/flink/5_sql#_4、lookup-join-维表查询)

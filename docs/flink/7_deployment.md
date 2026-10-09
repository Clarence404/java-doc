---
description: Operator 部署、内存模型、slot、反压、checkpoint 失败、倾斜、监控、savepoint 升级
---

# 部署与运维

> **本篇目标**：能用 Flink Kubernetes Operator 以 Application 模式部署作业，算清 TaskManager 内存和 slot，按指标定位反压、checkpoint 失败与数据倾斜，接好 Prometheus 监控，并用 savepoint 安全地升级作业。
>
> **前置阅读**：[状态与容错](./4_state_checkpoint)、[Flink SQL 与 Table API](./5_sql)

Kubernetes 本身的概念与运维见 [Kubernetes](/cloud-native/6_kubernetes)，指标平台见 [指标监控](/observability/2_metrics)；本篇只讲 Flink 特有的部分。

---

## 一、部署模式与 Kubernetes Operator

### 1、Application 模式是默认选择

| 模式 | 说明 | 2.x 状态 |
|------|------|----------|
| Application | 一个作业一个集群，`main()` 在 JobManager 里执行，作业结束集群销毁 | 生产首选 |
| Session | 常驻集群，多个作业共享 TaskManager | 适合开发、短作业、SQL Gateway 平台 |
| Per-Job | 客户端生成 JobGraph 再提交到独立集群 | **Flink 2.0 已移除**，迁移到 Application 模式 |

Application 模式资源隔离彻底，一个作业 OOM 不会拖垮别人，也不需要在提交机上下载依赖、生成 JobGraph。Session 模式省资源、提交快，但作业之间争抢资源、共用类加载环境，故障会互相影响。

### 2、Operator 管什么

Flink Kubernetes Operator 把 Flink 作业变成 Kubernetes 自定义资源：

- **FlinkDeployment**：Application 集群（带 `job`）或 Session 集群（不带 `job`）。
- **FlinkSessionJob**：提交到某个 Session 集群上的作业。
- 负责生命周期：部署、带状态升级、回滚、故障自愈；Autoscaler 可按负载调整并行度；新版本还支持蓝绿部署（新版本健康后再切换）。

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: order-gmv
spec:
  image: registry.example.com/flink-jobs/order-gmv:1.4.0
  flinkVersion: v2_2
  serviceAccount: flink
  flinkConfiguration:
    taskmanager.numberOfTaskSlots: "2"
    state.backend.type: rocksdb
    execution.checkpointing.interval: 60s
    execution.checkpointing.incremental: "true"
    execution.checkpointing.dir: s3://flink/checkpoints/order-gmv
    execution.checkpointing.savepoint-dir: s3://flink/savepoints/order-gmv
    high-availability.type: kubernetes
    high-availability.storageDir: s3://flink/ha/order-gmv
    metrics.reporter.prom.factory.class: org.apache.flink.metrics.prometheus.PrometheusReporterFactory
    metrics.reporter.prom.port: "9249"
  jobManager:
    resource:
      memory: "2048m"
      cpu: 1
  taskManager:
    resource:
      memory: "8192m"
      cpu: 2
  job:
    jarURI: local:///opt/flink/usrlib/order-gmv.jar
    entryClass: com.example.gmv.GmvJob
    parallelism: 8
    upgradeMode: savepoint
    state: running
```

- 作业 jar 打进镜像（`local://` 路径），镜像版本就是作业版本，回滚即换镜像标签。
- 写 S3 / OSS 需要在镜像里启用对应文件系统插件（放进 `plugins/` 目录）。
- `upgradeMode` 决定改 spec 后怎么升级：

| upgradeMode | 行为 | 适用 |
|-------------|------|------|
| `stateless` | 直接重启，丢弃状态 | 无状态作业 |
| `savepoint` | 先做 savepoint 再停，用它启动新版本 | 有状态作业，作业健康时 |
| `last-state` | 用 HA 元数据里最近的 checkpoint 恢复，不需要作业健康 | 有状态作业，需要开启 HA |

生产建议 `savepoint` 为主；作业已经不健康、做不出 savepoint 时，`last-state` 能从最近的 checkpoint 拉起。两者都依赖持久化的 checkpoint / savepoint 目录和 Kubernetes HA。

---

## 二、内存模型

### 1、TaskManager 内存组成

![TaskManager 内存模型（taskmanager.memory.*）](../assets/flink/flink-tm-memory.svg)

Flink 把 TaskManager 进程内存拆成 8 块，配置时只需要给一个总量，其余按默认比例推导：

- **容器部署配 `taskmanager.memory.process.size`**（Operator 里的 `taskManager.resource.memory` 就是它），保证 JVM 总占用不超过容器限制。
- 独立部署可以配 `taskmanager.memory.flink.size`，JVM 自身开销另算。
- **Managed Memory** 默认占 Flink 内存的 40%，供 RocksDB / ForSt 状态后端、批处理排序与哈希、Python UDF 使用。用 HashMap 状态后端（状态在堆上）的流作业用不到它，应把 `taskmanager.memory.managed.fraction` 调小，把内存让给 Task Heap。
- **Network** 默认 10%（最小 64m），算子之间 shuffle 的缓冲区；并行度高、shuffle 多时不够会报 `Insufficient number of network buffers`。

### 2、OOM 分类排查

| 现象 | 对应区域 | 处理 |
|------|----------|------|
| `java.lang.OutOfMemoryError: Java heap space` | Task Heap | HashMap 状态过大（换 RocksDB / ForSt）、窗口缓存元素过多、用户代码大对象；调大 heap 或减少 managed |
| `OutOfMemoryError: Direct buffer memory` | Task Off-Heap / Network | 用户代码或客户端（如 Netty、Kafka）用了直接内存，调大 `task.off-heap.size` |
| `OutOfMemoryError: Metaspace` | Metaspace | Session 集群反复提交作业导致类加载器泄漏；改 Application 模式或调大 metaspace |
| 容器被 OOMKilled，JVM 无异常 | JVM Overhead / RocksDB 原生内存 | RocksDB 超出 managed 预算、线程过多；调大 `jvm-overhead`，确认 `state.backend.rocksdb.memory.managed` 为 true |

**堆外内存是 Flink 容器被 OOMKilled 的主因**：JVM 堆有上限会抛异常，而 RocksDB、glibc 分配器碎片、线程栈都在堆外，超出容器限制时内核直接杀进程，日志里什么都没有。遇到无异常的重启先看 Pod 事件是否为 `OOMKilled`。

---

## 三、并行度与 slot

### 1、概念

- **Slot** 是 TaskManager 的资源切片，`taskmanager.numberOfTaskSlots`（默认 1）决定一个 TM 有几个 slot；managed memory 按 slot 均分，CPU 不隔离。
- **Slot 共享**：默认同一作业不同算子的子任务可以放进同一个 slot，因此**作业需要的 slot 数 = 最大算子并行度**，而不是各算子并行度之和。
- **最大并行度**（`pipeline.max-parallelism`）决定 keyed state 的 key group 数量，是扩容上限。**一旦有状态作业上线就不能修改**，否则状态无法恢复；不显式设置时会按初始并行度推导出默认值，后续扩容可能受限，因此首次上线就应显式设置一个足够大的值（如 720、1024）。

### 2、怎么定

1. **Source 并行度**对齐上游：Kafka Source 并行度不超过分区数，多出的子任务会空闲。
2. **按瓶颈算子估算**：压测单个子任务的处理能力（records/s），用峰值流量除以它再留 30%～50% 余量。
3. **单 TM slot 数**：常见 1 slot 配 1 核；状态大、单 key 计算重时用「少 slot 大内存」，轻量无状态作业可以一个 TM 多 slot 节省 JVM 开销。
4. **Sink 并行度**受外部系统约束：写 MySQL 的并行度过高只会把数据库打满，单独为 Sink 设置较小并行度（中间会多一次 rebalance）。

Operator 的 Autoscaler 可以基于每个算子的处理能力和积压自动调整并行度，适合流量有明显峰谷的作业；开启前要确保作业能从 savepoint 正常重启，且已显式设置最大并行度。

---

## 四、反压诊断

### 1、看哪几个指标

每个子任务的时间被划分为三份，相加约等于 1000ms：

- `busyTimeMsPerSecond`：在干活。
- `backPressuredTimeMsPerSecond`：输出缓冲区满，被下游堵住。
- `idleTimeMsPerSecond`：在等输入。

Web UI 的反压状态按被反压时间占比划分：OK（0～10%）、LOW（10%～50%）、HIGH（50%～100%）；作业图中黑色表示被反压、红色表示忙、蓝色表示空闲，颜色取各子任务最大值。

![反压定位：找第一个「忙但不被反压」的算子](../assets/flink/flink-backpressure.svg)

### 2、定位步骤

1. 从被标为 HIGH 的算子沿数据流**往下游**找，第一个 busy 高、自己却不被反压的算子就是瓶颈。
2. 只有部分子任务忙、其他空闲 → 数据倾斜（第六节）。
3. 所有子任务都忙 → 计算能力不足：开启火焰图（`rest.flamegraph.enabled: true`）看热点，常见是序列化（Kryo 回退）、正则、JSON 解析、同步调用外部服务。
4. Sink 忙 → 外部系统写入慢：加批量、调大缓冲、用异步 I/O，或者扩外部系统。
5. 周期性反压 → 对照 checkpoint 时间点，RocksDB compaction 或 checkpoint 上传抢占 I/O。

注意：算子链（operator chain）会把多个算子合并成一个任务，UI 上看不出是链里哪个算子慢。排查时可以临时 `disableChaining()` 或用 `slotSharingGroup` 拆开，确认后再恢复。

---

## 五、Checkpoint 失败

### 1、常见原因

- **超时**：`execution.checkpointing.timeout` 默认 10 分钟。最常见的根因是反压——barrier 跟着数据排队，下游迟迟收不到。
- **状态太大**：全量快照上传慢；没开增量 checkpoint（`execution.checkpointing.incremental` 默认 false）。
- **存储问题**：S3 / HDFS 限流、权限、网络抖动。
- **Sink 两阶段提交失败**：如 Kafka 事务超时（事务超时须大于 checkpoint 间隔 + 超时时间）。
- **容忍次数为 0**：`execution.checkpointing.tolerable-failed-checkpoints` 默认 0，一次失败就触发作业重启，偶发的存储抖动也会导致作业反复重启。

### 2、推荐配置

```yaml
# config.yaml（Flink 2.0 起只支持标准 YAML 的 config.yaml，旧 flink-conf.yaml 需用迁移工具转换）
execution.checkpointing.interval: 60s
execution.checkpointing.min-pause: 30s
execution.checkpointing.timeout: 10min
execution.checkpointing.tolerable-failed-checkpoints: 3
execution.checkpointing.incremental: true
# 反压严重时：barrier 可越过缓冲数据，checkpoint 时间不再受反压影响
execution.checkpointing.unaligned.enabled: true
execution.checkpointing.aligned-checkpoint-timeout: 30s
# 按吞吐自动调整在途缓冲量，减少 barrier 排队
taskmanager.network.memory.buffer-debloat.enabled: true
```

- **非对齐 checkpoint** 把在途数据也写进 checkpoint，换来对反压不敏感；代价是 checkpoint 体积变大。`aligned-checkpoint-timeout` 大于 0 时先尝试对齐，超时再切换为非对齐，兼顾两者。
- **min-pause** 保证两次 checkpoint 之间至少留给作业正常处理的时间，避免 checkpoint 首尾相接。
- 状态 TB 级、恢复慢时，可以评估 Flink 2.0 引入的分离式状态存储（ForSt 状态后端，以远端存储为主存储），它让 checkpoint 和扩缩容不再需要搬运大量本地状态；该能力较新，上线前做好压测。

状态后端与 checkpoint 的原理见 [状态与容错](./4_state_checkpoint)。

---

## 六、数据倾斜

### 1、识别

Web UI 中同一算子各子任务的 `Records Received` / `Bytes Received` 差异明显，或只有个别子任务 busy 接近 100%，即为倾斜。来源有三种：

- **Source 倾斜**：Kafka 分区数据不均，或分区数少于并行度。修上游的分区键，或者在 Source 后 `rebalance()`。Flink 2.3 为 Rebalance / Rescale 分区器增加了按下游负载选择通道的可选能力（`taskmanager.network.adaptive-partitioner.enabled`，默认关闭），升级到 2.3 后可按需评估。
- **keyBy 热点**：少数 key（大店铺、爆款商品）数据量远超其他。
- **窗口 / Join 热点**：同一个 key 在某些窗口内数据激增。

### 2、两阶段聚合（加盐打散）

```java
import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.java.tuple.Tuple2;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;

// orders：已分配时间戳与水位线的 DataStream<OrderEvent>，OrderEvent 为含 shopId 字段的 POJO
DataStream<Tuple2<String, Long>> partial = orders
        // 第一阶段：key 加随机后缀，把热点 key 打散到 16 个子 key
        .map(o -> Tuple2.of(o.shopId + "#" + ThreadLocalRandom.current().nextInt(16), 1L))
        .returns(Types.TUPLE(Types.STRING, Types.LONG))
        .keyBy(t -> t.f0)
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
        .sum(1);

DataStream<Tuple2<String, Long>> result = partial
        // 第二阶段：去掉后缀，按原 key 汇总局部结果
        .map(t -> Tuple2.of(t.f0.substring(0, t.f0.lastIndexOf('#')), t.f1))
        .returns(Types.TUPLE(Types.STRING, Types.LONG))
        .keyBy(t -> t.f0)
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
        .sum(1);
```

第一阶段窗口输出的时间戳是窗口结束时间减 1ms，第二阶段同尺寸的滚动窗口能精确对齐。只适用于可分解的聚合（SUM、COUNT、MAX）；`COUNT(DISTINCT)` 要按去重字段打散。Flink SQL 里不用手写，开启 mini-batch + 两阶段聚合 + distinct 拆分即可，见 [Flink SQL 与 Table API](./5_sql)。

### 3、其他手段

- **Join 热点**：大 key 单独拎出来走广播或 Lookup，其余正常关联。
- **业务过滤**：测试账号、爬虫流量这类异常大 key 在 Source 后直接过滤。
- **不要只加并行度**：热点 key 总落在同一个子任务上，加并行度无效。

---

## 七、监控

### 1、接入 Prometheus

```yaml
metrics.reporter.prom.factory.class: org.apache.flink.metrics.prometheus.PrometheusReporterFactory
metrics.reporter.prom.port: 9249
```

官方文档列出的 Reporter 默认可用，在 Pod 上开放 9249 端口，用 PodMonitor / ServiceMonitor 抓取即可。不建议在大规模集群用 PushGateway：作业结束后指标残留，需要额外清理。Prometheus 与告警体系见 [指标监控](/observability/2_metrics)。

### 2、核心指标与告警

| 关注点 | 指标 | 告警建议 |
|--------|------|----------|
| 作业存活 | `numRestarts`（旧的 `fullRestarts` 已移除）、`runningTime`（`uptime` 已废弃） | 重启次数在 10 分钟内增长即告警 |
| 消费延迟 | Kafka Source 的 `pendingRecords`、消费组 lag | 积压持续上升 |
| 数据时效 | `currentOutputWatermark` 与当前时间的差 | 水位线落后超过业务容忍 |
| 反压 | `backPressuredTimeMsPerSecond` | 持续 5 分钟以上 > 500 |
| Checkpoint | `numberOfFailedCheckpoints`、`lastCheckpointDuration`、`lastCheckpointSize` | 失败次数增长、耗时接近超时 |
| 资源 | JVM 堆使用率、GC 时间、容器内存与 CPU | 老年代 GC 频繁、容器内存接近上限 |

消费延迟和水位线延迟是最贴近业务的两个指标，其他指标用来定位原因。

---

## 八、用 savepoint 升级

### 1、savepoint 与 checkpoint

| | Checkpoint | Savepoint |
|---|---|---|
| 触发方 | Flink 周期自动 | 人工或 Operator |
| 用途 | 故障恢复 | 升级、迁移、改并行度、A/B |
| 生命周期 | 自动清理（可配置保留） | 手动管理 |
| 格式 | 可增量、与状态后端相关 | 默认标准格式，可跨状态后端；`native` 格式更快但受限 |

### 2、升级步骤

```bash
# 1. 停止作业并做 savepoint（stop-with-savepoint 保证 Sink 随 savepoint 提交；不要加 --drain，它会发送最大水位线触发所有窗口，只用于永久下线）
./bin/flink stop --savepointPath s3://flink/savepoints/order-gmv <jobId>

# 2. 用新 jar 从 savepoint 启动；删除了旧算子时加 --allowNonRestoredState
./bin/flink run -s s3://flink/savepoints/order-gmv/savepoint-xxxx -d order-gmv-1.5.0.jar
```

在 Operator 上则是修改 FlinkDeployment 的镜像标签，`upgradeMode: savepoint` 会自动完成「做 savepoint → 停止 → 用新镜像恢复」。

**能否恢复取决于以下几点：**

- **每个有状态算子都显式设置 `uid()`**。不设置时 uid 由作业拓扑生成，加一个算子就全变了，状态对不上。
- 状态类型兼容：POJO 增删字段可以演进，Kryo 序列化的类改了基本无法恢复，状态对象应避免回退到 Kryo。
- 最大并行度不变。
- **SQL 作业**：改 SQL 可能改变执行计划和算子 uid，不保证能从旧 savepoint 恢复；大改通常要重跑或双跑切换。
- **大版本升级**：官方不保证 Flink 1.x 与 2.x 之间的状态兼容，从 1.x 升级到 2.x 需按发布说明评估，必要时用 State Processor API 迁移状态，或双跑新旧作业后切流。

---

## 九、生产常见问题

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 作业频繁重启，Pod 状态 OOMKilled | 堆外内存超限（RocksDB、直接内存） | 调大 `jvm-overhead`、确认 RocksDB 使用 managed 内存，按第二节排查 |
| 窗口一直不输出 | 某分区无数据导致水位线不前进 | 设置 idleness / `table.exec.source.idle-timeout` |
| Checkpoint 持续超时 | 反压导致 barrier 排队 | 先解决反压，再开非对齐 checkpoint 与 buffer debloat |
| 状态无限增长 | 无界聚合、Regular Join 未配 TTL | 配置状态 TTL，改窗口或 Interval Join |
| 从 savepoint 恢复失败 | 算子未设 uid、状态类型变化、修改了最大并行度 | 补 uid，`--allowNonRestoredState` 跳过已删算子，状态迁移 |
| Kafka 消费积压但 CPU 很低 | Source 并行度 > 分区数，或 Sink 写外部系统阻塞 | 增加分区、Sink 改为异步 / 批量 |
| 重启后数据重复 | Sink 非幂等且非事务 | Sink 按主键 upsert，或启用事务 Sink + `read_committed` 消费 |
| 个别子任务 busy 100% | 数据倾斜 | 两阶段聚合、热点 key 拆分 |
| `Insufficient number of network buffers` | 并行度高、Network 内存不足 | 调大 `network.fraction` 或 `network.max` |
| 升级后指标或配置不生效 | 2.x 移除了旧配置文件与部分指标 | 迁移到 `config.yaml`，监控改用 `numRestarts` 等新指标 |

---

## 小结

- Flink 2.0 移除了 Per-Job 模式，生产用 Application 模式；Kubernetes 上用 Operator 的 FlinkDeployment 管理，`upgradeMode: savepoint` 为主，`last-state` 兜底
- 容器部署只配 `taskmanager.memory.process.size`；Managed Memory 默认 40% 给 RocksDB / ForSt，HashMap 状态后端应调小；无异常的 OOMKilled 多半是堆外内存
- 作业所需 slot 数等于最大算子并行度；最大并行度首次上线就显式设置，之后不可改
- 反压沿数据流反向传播，找第一个「忙但不被反压」的算子；部分子任务忙即倾斜
- Checkpoint 超时多由反压引起；开启增量、非对齐、buffer debloat，容忍次数不要为 0
- 倾斜用两阶段聚合打散热点 key，加并行度无效；SQL 作业打开 mini-batch 与两阶段聚合
- 监控以消费积压和水位线延迟为核心，Prometheus Reporter 直接抓取 9249 端口
- 升级靠 savepoint：每个有状态算子设 `uid()`，状态避免 Kryo，最大并行度不变；1.x 到 2.x 不保证状态兼容

## 参考资料

- Flink Kubernetes Operator（1.16）：[https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/)
- TaskManager 内存配置：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/memory/mem_setup_tm/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/memory/mem_setup_tm/)
- 配置项参考：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/config/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/config/)
- 反压监控：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/monitoring/back_pressure/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/monitoring/back_pressure/)
- Metric Reporters：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/metric_reporters/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/metric_reporters/)
- Flink 2.0 Release Notes：[https://nightlies.apache.org/flink/flink-docs-release-2.2/release-notes/flink-2.0/](https://nightlies.apache.org/flink/flink-docs-release-2.2/release-notes/flink-2.0/)

> 下一篇：[实战场景](./8_scenarios) —— 实时 GMV 大屏、CEP 风控、实时数仓分层和维表关联，把前面的知识串成完整方案。

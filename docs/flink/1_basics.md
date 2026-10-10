---
description: 流与批、选型对比、JobManager / TaskManager / Slot、算子链、生命周期、部署、2.x 变化
---

# Flink 概览

> 前置阅读：[Kafka](/messaging/2_kafka)

Flink 是一个有状态的分布式流计算引擎。本篇讲它解决什么问题、与 Spark Streaming / Kafka Streams 怎么选、作业如何拆成 Task 运行及 2.x 的破坏性变化，基线为 Flink 2.2。

---

## 一、流与批

本模块的连接器为 `flink-connector-kafka:5.0.0-2.2`，JDK 17（Java 21 为实验性支持）；Flink 2.3 已发布但官方 Kafka 连接器尚无适配版本，依赖 Kafka 的作业建议先停在 2.2.x。

### 1、有界流与无界流

| 概念 | 含义 | 典型数据 | 计算何时结束 |
|------|------|----------|--------------|
| 无界流（Unbounded） | 有开始、没有结束，数据持续到达 | Kafka topic、binlog、埋点、IoT 上报 | 永不结束，结果持续更新 |
| 有界流（Bounded） | 有开始、有结束 | 一个 Hive 分区、一批文件、某天的快照 | 读完数据即结束 |

传统做法是「批处理系统算有界数据 + 流处理系统算无界数据」，两套代码、两套语义，口径经常对不上。Flink 的立场是：**批只是有界的流**。同一份 DataStream / SQL 代码，在 `STREAMING` 模式下持续增量计算、持续输出更新；在 `BATCH` 模式下引擎知道数据有界，可以按阶段调度、排序后聚合、不需要水位线和 Checkpoint，吞吐更高。

```java
// 同一个作业，切换执行模式即可（也可用配置 execution.runtime-mode）
env.setRuntimeMode(RuntimeExecutionMode.BATCH);      // 有界输入，批式调度
env.setRuntimeMode(RuntimeExecutionMode.STREAMING);  // 默认，持续计算
```

### 2、流计算要解决的三个难题

| 难题 | 现象 | Flink 的解法 |
|------|------|--------------|
| 乱序与延迟 | 手机断网后补传、多分区消费速度不同，数据按到达顺序算就会错 | 事件时间 + 水位线（见[时间、水位线与窗口](./3_time_window)） |
| 中间状态 | 去重、累计、会话、Join 都要记住历史 | 托管的 Keyed State，随 Checkpoint 持久化（见[状态与容错](./4_state_checkpoint)） |
| 故障一致性 | 进程挂了，重启后不能少算也不能多算 | 分布式快照 + 可重放的 Source + 事务 / 幂等 Sink |

能否回答好「数据来晚了怎么办」「重启后结果对不对」，是判断一个流处理方案是否可用于生产的标准。

---

## 二、为什么选 Flink：与其他方案对比

### 1、选型对比

| 维度 | Flink | Spark Structured Streaming | Kafka Streams | Storm |
|------|-------|----------------------------|---------------|-------|
| 处理模型 | 逐条处理（真流），批是有界流 | 微批为主 | 逐条处理 | 逐条处理 |
| 延迟 | 毫秒级 | 秒级（受批间隔影响） | 毫秒级 | 毫秒级 |
| 状态管理 | 内置，支持超大状态（RocksDB / ForSt） | 内置，状态规模一般 | 内置（RocksDB + changelog topic） | 无内置状态，需自己存 |
| 一致性 | 端到端精确一次（配合事务 / 幂等 Sink） | 精确一次（依赖 Sink 幂等） | Kafka 内精确一次 | 至少一次（Trident 可精确一次） |
| 事件时间 / 乱序 | 水位线体系最完整 | 支持水位线 | 支持，表达力较弱 | 弱 |
| 部署形态 | 独立集群（K8s / YARN / Standalone） | Spark 集群 | **只是一个 Jar 库**，嵌入应用 | 独立集群 |
| 数据源 | 任意（Kafka、CDC、文件、消息队列、湖仓） | 任意 | **只能 Kafka 进、Kafka 出** | 任意 |
| SQL | Flink SQL 成熟，流批统一 | Spark SQL 生态最强 | 无（ksqlDB 是另一个产品） | 无 |
| 典型场景 | 实时数仓、实时风控、CDC 同步、复杂事件处理 | 已有 Spark 离线体系，准实时 | 微服务内轻量流处理 | 存量系统 |

### 2、选型建议

- **数据进出都在 Kafka、逻辑简单、不想维护计算集群**：Kafka Streams，它就是应用里的一个库，扩容等于多起几个实例。详见 [Kafka](/messaging/2_kafka) 的 Kafka Streams 一节。
- **已有 Spark 离线数仓、对延迟要求是分钟级**：Spark Structured Streaming，复用技术栈与资源。
- **多源异构、大状态、毫秒级延迟、需要事件时间语义或 CDC 入湖**：Flink。国内实时数仓、实时风控、数据同步的事实标准。
- **Storm**：不建议新项目选用，社区与生态已明显落后。

> Flink 的代价是运维复杂度：需要一个独立集群、状态存储（对象存储 / HDFS）、作业升级要走 Savepoint。团队没有平台化能力时，优先考虑云厂商托管的 Flink 服务。

---

## 三、运行时架构

![Flink 运行时架构](../assets/flink/flink-architecture.svg)

### 1、JobManager：作业的大脑

JobManager 是一个进程，内部有三个组件：

| 组件 | 职责 | 数量 |
|------|------|------|
| Dispatcher | 提供 REST 接口接收作业提交，为每个作业启动 JobMaster，承载 Web UI | 每集群一个 |
| ResourceManager | 管理 Task Slot：向 K8s / YARN 申请或释放 TaskManager，把空闲 Slot 分配给作业 | 每集群一个 |
| JobMaster | 负责**单个作业**：把 JobGraph 展开为 ExecutionGraph、调度 Task、协调 Checkpoint、处理失败恢复 | **每个作业一个** |

Checkpoint 的触发与确认由 JobMaster 内的 CheckpointCoordinator 负责，这就是为什么 JobManager 挂掉需要高可用（ZooKeeper 或 Kubernetes HA）来恢复「最近一次完成的 Checkpoint 指针」。

### 2、TaskManager 与 Slot

- **TaskManager**：工作进程（一个 JVM），执行 Task、缓冲与交换数据。
- **Task Slot**：TaskManager 资源的固定切片。**Slot 只隔离托管内存（managed memory），不隔离 CPU**；一个 TaskManager 有几个 Slot，就能并发跑几个 Task 链。
- Slot 少 → 作业间隔离好（不同 JVM）；Slot 多 → 共享 JVM 内的 TCP 连接、心跳、堆外内存，单任务开销更低。常见做法是 Slot 数 ≈ 容器 CPU 核数。

**Slot 共享（默认开启）**：同一作业不同算子的子任务可以放进同一个 Slot，一个 Slot 可以容纳整条流水线。结论是：**一个作业需要的 Slot 数 = 作业中最大的并行度**，而不是所有算子并行度之和。

### 3、并行度与算子链

![逻辑图与物理执行：算子链](../assets/flink/flink-operator-chain.svg)

每个算子可以独立设置并行度，优先级：算子 `setParallelism()` > `env.setParallelism()` > 提交参数 `-p` > 配置 `parallelism.default`。

**算子链（Operator Chaining）**：上下游满足「forward 连接 + 并行度相同 + 同一 Slot 共享组 + 未禁用链」时，会被合并成一个 Task，由同一个线程执行，记录通过方法调用传递，**没有序列化、没有网络缓冲、没有线程切换**。`keyBy`、`rebalance`、并行度变化都会断链。

```java
stream.map(...).name("parse").uid("parse")
      .disableChaining();                 // 当前算子不与前后链接
stream.map(...).startNewChain();          // 从当前算子开始新链
env.disableOperatorChaining();            // 全局关闭，一般只用于排查
```

> **生产建议**：默认不要关链。只有当某个算子 CPU 极重、想把它单独拆出来观察反压位置时才手动断链。另外**每个有状态算子都要设置稳定的 `uid()`**，否则修改作业拓扑后无法从 Savepoint 恢复状态（见[状态与容错](./4_state_checkpoint)）。

### 4、从代码到执行图

| 图 | 生成位置 | 内容 |
|----|----------|------|
| StreamGraph | Client | 用户代码直接翻译出的算子拓扑 |
| JobGraph | Client | 做完算子链合并后的图，提交给集群的就是它 |
| ExecutionGraph | JobMaster | 按并行度展开，每个顶点拆成多个子任务（ExecutionVertex） |
| 物理执行 | TaskManager | 子任务部署到 Slot 中运行 |

Application 模式下，`main()` 在 JobManager 上执行，StreamGraph / JobGraph 也在集群侧生成。

---

## 四、作业生命周期

作业状态（`JobStatus`）在 Web UI 和 REST API 中可见：

| 状态 | 含义 |
|------|------|
| INITIALIZING / CREATED | 作业已提交，JobMaster 初始化中 / 等待资源 |
| RUNNING | 至少有一个 Task 已调度，正常运行 |
| FAILING → RESTARTING | Task 失败，按重启策略取消并重新部署 |
| FAILED | 重启次数用尽或遇到不可恢复错误，终态 |
| CANCELLING → CANCELED | 用户取消，终态 |
| FINISHED | 所有 Task 正常结束（有界流读完），终态 |
| SUSPENDED | JobManager 失去领导权（HA 场景），由新 Leader 接管 |

一个流作业的典型运维周期：

1. **首次启动**：`flink run` 提交，Source 从配置的起始位点读取（如 Kafka `earliest` / 已提交 offset）。
2. **持续运行**：周期性 Checkpoint；单个 Task 失败时自动按重启策略恢复，**不需要人工干预**。
3. **升级发布**：`flink stop --savepointPath ...` 停止并做 Savepoint → 部署新 Jar → `flink run -s <savepoint>` 从 Savepoint 恢复。
4. **扩缩容**：同样通过 Savepoint 停止后以新并行度启动；Keyed State 按 Key Group 重新分配，最大并行度（`maxParallelism`）决定了扩容上限，**首次上线就要定好且之后不能改**。

---

## 五、部署模式

### 1、Application 模式与 Session 模式

| 模式 | 集群生命周期 | `main()` 在哪执行 | 隔离性 | 适用 |
|------|--------------|-------------------|--------|------|
| Application | 每个应用一个专属集群，应用结束集群销毁 | JobManager | 应用级隔离 | **生产流作业的首选** |
| Session | 预先启动一个长期集群，多个作业共享 TaskManager | Client | 一个作业搞垮 TaskManager 会影响其他作业 | 开发测试、大量短小的批作业、SQL Gateway |

**Flink 2.0 已移除 Per-Job 模式**，原先依赖 Per-Job 的场景改用 Application 模式；SQL Gateway 也已支持以 Application 模式提交 SQL。

Application 模式要求用户 Jar 随 Flink 镜像一起发布，这与容器化交付天然契合：一个作业 = 一个镜像 = 一个 K8s Deployment。高可用场景下 Application 模式只支持单个 `execute()` 调用。

### 2、资源提供方

| 方式 | 说明 |
|------|------|
| Standalone | 只需要 JVM，手动启动 JobManager / TaskManager；Docker Compose、非原生的 K8s 部署也属于这一类 |
| Native Kubernetes | Flink 直接调用 K8s API 动态申请 TaskManager Pod |
| YARN | 传统 Hadoop 环境 |
| Flink Kubernetes Operator | 社区维护的 K8s Operator，用 `FlinkDeployment` CRD 声明作业，自动管理 Savepoint 升级与故障恢复，**云原生环境下的主流选择** |

Flink 在 K8s 上的部署、内存配置与监控见 [部署与运维](./7_deployment)；K8s 本身的概念见 [Kubernetes](/cloud-native/6_kubernetes)。

### 3、本地开发

```xml
<properties>
    <flink.version>2.2.1</flink.version>
</properties>
<dependencies>
    <!-- 集群已提供，打包时 provided；IDE 里运行需勾选 "include provided" -->
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-streaming-java</artifactId>
        <version>${flink.version}</version>
        <scope>provided</scope>
    </dependency>
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-clients</artifactId>
        <version>${flink.version}</version>
        <scope>provided</scope>
    </dependency>
    <!-- 连接器不在 Flink 发行包里，必须打进作业 fat jar -->
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-connector-kafka</artifactId>
        <version>5.0.0-2.2</version>
    </dependency>
</dependencies>
```

连接器版本号形如 `5.0.0-2.2`：前半段是连接器自身版本，后半段是适配的 Flink 版本。**连接器与 Flink 主版本必须匹配**，1.x 的连接器在 2.x 上无法运行。打包用 `maven-shade-plugin` 生成 fat jar，并排除 `flink-streaming-java` 等 provided 依赖，否则会出现类冲突。

在 IDE 中直接运行 `main()` 时，`StreamExecutionEnvironment.getExecutionEnvironment()` 会自动创建一个本地 MiniCluster，适合单步调试。

---

## 六、Flink 2.x 的关键变化

Flink 2.0 于 2025 年 3 月发布，是 1.0 之后的第一个大版本，**与 1.x 不保证状态兼容**，升级需要评估。

### 1、移除的 API（升级必改）

| 移除项 | 替代方案 |
|--------|----------|
| DataSet API | DataStream API（`BATCH` 模式）或 Table API / SQL |
| Scala DataStream / DataSet API | Java DataStream API（Scala 代码可以直接调用 Java API） |
| `SourceFunction` / `SinkFunction` / Sink V1 | 新 Source API（FLIP-27）/ Sink V2 |
| `TableSource` / `TableSink` / `TableSchema` | `DynamicTableSource` / `DynamicTableSink` / `Schema` |
| `RichFunction#open(Configuration)` | `open(OpenContext)` |
| `ExecutionConfig#setRestartStrategy`、`RestartStrategies` 类 | 通过 `Configuration` 设置 `restart-strategy.*` |
| `FsStateBackend` / `MemoryStateBackend` | `HashMapStateBackend` + 检查点存储配置 |
| `org.apache.flink.streaming.api.windowing.time.Time` | `java.time.Duration` |
| Per-Job 部署模式 | Application 模式 |

**连接器影响最大**：基于 `SourceFunction` / `SinkFunction` 实现的旧连接器在 2.x 上全部无法使用，必须换成适配 2.x 的新版本连接器。

### 2、运行环境与配置

- **Java**：不再支持 Java 8；默认与推荐版本从 Java 11 改为 **Java 17**，最低要求 Java 11，Java 21 为实验性支持。
- **配置文件**：不再支持 `flink-conf.yaml`，改用标准 YAML 语法的 `config.yaml`，官方提供迁移脚本。大量废弃的配置项被删除，Checkpoint 相关配置统一到 `execution.checkpointing.*` 前缀下。
- **序列化**：Kryo 升级到 5.6；内置 Map / List / Set 序列化器默认开启。这也是 1.x 状态不兼容的原因之一。

### 3、新能力

- **存算分离状态（Disaggregated State）**：新的 ForSt 状态后端可以把状态主存放在 S3 / HDFS 等远端存储，配合异步状态访问模型，目标是解决超大状态下的本地磁盘瓶颈、Checkpoint 慢、恢复慢等问题。目前仍是**实验特性**，详见[状态与容错](./4_state_checkpoint)。
- **物化表（Materialized Table）**：用一条 SQL 声明表与新鲜度，引擎自动决定以流还是批的方式刷新，目前与 Paimon 集成。
- **批处理优化**：自适应 Broadcast Join、自动处理 Join 倾斜。
- **DataStream API V2**：新一代 DataStream API，目前为实验性，本模块仍以成熟的 V1 API 为准。

### 4、生态版本

| 组件 | 当前版本线 |
|------|-----------|
| Flink | 2.2.x（2.3 已发布） |
| flink-connector-kafka | 5.0.0-2.2（适配 Flink 2.2） |
| Flink CDC | 3.6.0 起支持 Flink 1.20.x / 2.2.x |

---

## 小结

- Flink 是有状态流计算引擎：批是有界流，状态是一等公民，事件时间 + 水位线处理乱序，分布式快照保证故障一致性
- 选型：Kafka 进出且逻辑简单用 Kafka Streams；已有 Spark 体系、分钟级延迟用 Spark；多源、大状态、毫秒延迟、CDC 入湖用 Flink
- JobManager = Dispatcher（入口）+ ResourceManager（Slot）+ 每作业一个 JobMaster（调度与 Checkpoint）；TaskManager 是工作进程，Slot 只隔离托管内存
- 默认 Slot 共享，作业所需 Slot 数 = 最大并行度；forward 且并行度相同的算子会链成一个 Task，keyBy 和并行度变化会断链
- 有状态算子必须设置稳定的 `uid()`，`maxParallelism` 首次上线就要定好
- 生产用 Application 模式 + Flink Kubernetes Operator；Flink 2.0 已移除 Per-Job 模式
- Flink 2.x 移除了 DataSet、Scala API、`SourceFunction` / `SinkFunction`、`Time` 类、`flink-conf.yaml`，不再支持 Java 8，与 1.x 状态不保证兼容；连接器版本必须与 Flink 主版本匹配

## 参考资料

- Flink 官方文档（稳定版）：[https://nightlies.apache.org/flink/flink-docs-stable/](https://nightlies.apache.org/flink/flink-docs-stable/)
- Flink 架构：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/concepts/flink-architecture/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/concepts/flink-architecture/)
- Flink 2.0 发布公告：[https://flink.apache.org/2025/03/24/apache-flink-2.0.0-a-new-era-of-real-time-data-processing/](https://flink.apache.org/2025/03/24/apache-flink-2.0.0-a-new-era-of-real-time-data-processing/)
- Flink 2.0 Release Notes：[https://nightlies.apache.org/flink/flink-docs-release-2.0/release-notes/flink-2.0/](https://nightlies.apache.org/flink/flink-docs-release-2.0/release-notes/flink-2.0/)
- 部署概览：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/overview/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/overview/)

> 下一篇：[DataStream API](./2_datastream) —— 从 Source 到 Sink 写一个完整的 Kafka 实时聚合作业，掌握 ProcessFunction、侧输出、异步 I/O 与序列化的坑。

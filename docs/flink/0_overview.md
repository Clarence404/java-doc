# Flink 总览

Flink 是有状态的分布式流计算引擎，国内实时数仓、实时风控、数据库实时同步大多以它为底座。本模块先讲运行时架构，再讲 DataStream 开发链路、事件时间与水位线、状态与 Checkpoint，然后是 Flink SQL 与 Flink CDC，最后落到 Kubernetes 部署、反压与倾斜排查，以及几个完整的业务场景。Kafka、CDC 基础、Kubernetes、监控等通用知识在各自模块展开，这里只讲 Flink 特有的部分。

版本基线：**Flink 2.2.x**（`flink-connector-kafka:5.0.0-2.2`）、**Flink CDC 3.6**、**JDK 17**（Java 21 为实验性支持）。Flink 2.3 已于 2026 年 6 月发布，但 Kafka 等外部连接器还没有适配 2.3 的版本，依赖这些连接器的作业建议暂时停留在 2.2.x。Flink 2.0 移除了 DataSet API、Scala API、`SourceFunction` / `SinkFunction`、Per-Job 模式和 `flink-conf.yaml`，也不再支持 Java 8。与 1.x 行为不同的地方，文中会单独标出。

---

## 一、学习路线

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **架构与 API** | Flink 和 Spark、Kafka Streams 怎么选？作业在集群里怎样运行？一个 Kafka 实时作业从头到尾怎么写？ | [Flink 概览](./1_basics) → [DataStream API](./2_datastream) |
| **核心机制** | 乱序数据和迟到数据怎么处理？状态存在哪里？故障后怎样做到不丢数据、也不重复计算？ | [时间、水位线与窗口](./3_time_window) → [状态与容错](./4_state_checkpoint) |
| **SQL 与数据集成** | 怎样用 SQL 表达流计算、控制状态大小？怎样不锁表地把业务库实时同步到下游？ | [Flink SQL 与 Table API](./5_sql) → [Flink CDC](./6_cdc) |
| **生产与实战** | 内存、并行度怎么配？反压、Checkpoint 失败、数据倾斜怎么排查？典型业务怎样落地？ | [部署与运维](./7_deployment) → [实战场景](./8_scenarios) |

---

## 二、模块导航

<ModuleNav />

---

## 三、推荐阅读路径

按顺序阅读，每篇末尾的「下一篇」串起整条链路。

1. [Flink 概览](./1_basics)：流与批的关系、选型对比、JobManager / TaskManager / Slot、算子链、部署模式，以及 2.x 的破坏性变化
2. [DataStream API](./2_datastream)：KafkaSource、ProcessFunction 与定时器、侧输出处理脏数据、异步 I/O 关联维表、Sink V2，以及类型与序列化的坑
3. [时间、水位线与窗口](./3_time_window)：事件时间、水位线的生成与传播、空闲分区、迟到数据的三道防线、窗口函数和双流 Join
4. [状态与容错](./4_state_checkpoint)：Keyed State 与 TTL、状态后端选择、barrier 快照与非对齐 Checkpoint、Savepoint、端到端精确一次
5. [Flink SQL 与 Table API](./5_sql)：动态表与 changelog、窗口 TVF、四种 Join 的状态差异、Top-N 与去重、状态 TTL 与聚合调优
6. [Flink CDC](./6_cdc)：无锁增量快照、MySQL CDC 源、YAML 整库同步与 Schema 演进、Sink 选择与精确一次
7. [部署与运维](./7_deployment)：Kubernetes Operator、TaskManager 内存模型、反压定位、Checkpoint 失败、数据倾斜、监控与 Savepoint 升级
8. [实战场景](./8_scenarios)：实时 GMV 大屏、CEP 风控、实时数仓分层和维表关联策略

按目标挑读：

- **第一次接触 Flink**：先读 1～4 篇。前四篇讲的是 Flink 的核心机制，SQL 和 CDC 都建立在这些机制之上。
- **主要写 Flink SQL**：读完 1、3、4 篇后直接读第 5 篇，重点看 changelog、Join 状态和 TTL。
- **要做数据库实时同步、数据入湖**：重点读 [Flink CDC](./6_cdc)，CDC 的通用概念和工具对比见 [CDC 工具](/database/5_practice/0_cdc_tools)。
- **准备上线或排查线上问题**：直接看 [部署与运维](./7_deployment) 的排查步骤和常见问题表。

[高频面试题](./99_interview) 只列题目，答案在 [Flink 面试题解答](/interview/6_flink)。

---

## 四、关联模块

- [Kafka](/messaging/2_kafka)：Flink 最常见的 Source 与 Sink，分区、消费组和事务机制在那里展开
- [CDC 工具](/database/5_practice/0_cdc_tools)：binlog 原理，以及 Canal、Debezium、Flink CDC 的横向选型；[MySQL 主从与高可用](/database/1_mysql/9_topic_replication) 讲 binlog 格式与 GTID
- [幂等设计](/architecture/5_idempotence)：Sink 端幂等写入与消费端去重的通用做法
- [Kubernetes](/cloud-native/6_kubernetes)：Flink on Kubernetes 用到的基础概念，更多内容见 [云原生总览](/cloud-native/0_overview)
- [指标监控](/observability/2_metrics)：Prometheus 指标与告警体系，更多内容见 [可观测性总览](/observability/0_overview)
- [海量数据架构选型](/scenario/2_big_data)：离线与实时计算在大数据场景中的整体位置
- [Vert.x 总览](/vertx/0_overview) / [Quarkus 总览](/quarkus/0_overview)：同属框架生态，面向在线服务而非流计算
- [Flink 面试题解答](/interview/6_flink)：本模块高频问题的答案汇总

## 参考资料

- Flink 官方文档（稳定版）：[https://nightlies.apache.org/flink/flink-docs-stable/](https://nightlies.apache.org/flink/flink-docs-stable/)
- Flink 2.2 文档：[https://nightlies.apache.org/flink/flink-docs-release-2.2/](https://nightlies.apache.org/flink/flink-docs-release-2.2/)
- Flink CDC 文档：[https://nightlies.apache.org/flink/flink-cdc-docs-stable/](https://nightlies.apache.org/flink/flink-cdc-docs-stable/)
- Flink Kubernetes Operator 文档：[https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/)

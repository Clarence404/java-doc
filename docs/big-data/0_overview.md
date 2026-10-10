# 大数据总览

大数据平台回答的是：业务系统每天产生的订单、日志、埋点，怎样**汇集到一处、加工成统一口径的数据**，再以报表、接口、特征的形式交还给业务。本模块站在 Java 后端的视角讲这条链路——后端工程师最常接触的是数据从哪里来（binlog、埋点、消息）、指标口径怎么定、加工好的数据怎么以接口形式提供出去，因此重点放在数仓建模、批处理引擎、湖仓存储、集成、调度、OLAP 与治理这几块能直接影响日常开发的内容，不追求覆盖整个 Hadoop 生态。

流计算的细节（DataStream、事件时间、状态、Flink SQL、Flink CDC）在 [Flink](/flink/0_overview) 模块展开，列式与 OLAP 数据库的原理在 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)，本模块只讲它们在数据平台中的位置并给出链接。全模块示例统一使用**电商订单**业务：`order_info`（订单）、`order_item`（订单明细）、`user_info`（用户）、`product`（商品）几张业务表，加上 App 端的浏览、加购埋点日志。

**版本基线（2026 年 10 月）**：Spark 4.2（2026 年 7 月发布，4.0 起要求 JDK 17+、Scala 2.13，4.2 新增 Java 25 支持；4.1 / 4.0 仍有维护版，3.5.x 为 3.x 最后一条维护线）；Hadoop 3.5（2026 年 4 月发布，服务端要求 Java 17，客户端支持 Java 17 / 21，移除了 WASB 文件系统）与 3.4.x；Iceberg 1.12（2026 年 9 月）；Paimon 2.0（2026 年 8 月）；Hudi 1.2.x；Flink 2.2 / Flink CDC 3.6（见 [Flink 总览](/flink/0_overview)）；DolphinScheduler 3.4.x；Airflow 3.3.x；SeaTunnel 3.0（2.3.x 文档已标记为不再维护）；DataX 开源版最近一次发布仍是 `datax_v202309`；Doris 4.1.x 与 StarRocks 4.1.x。以上项目均为 Apache License 2.0。文中涉及版本差异的地方会单独标出。

---

## 一、后端视角下的数据平台

业务系统（OLTP）和数据平台（OLAP / 数仓）处理的是同一份业务事实，但目标完全不同：

| 维度 | 业务系统（订单服务） | 数据平台（数仓） |
|------|----------------------|------------------|
| 服务对象 | 用户的一次次请求 | 分析师、运营、报表、算法 |
| 典型操作 | 按主键读写单行，高并发短事务 | 扫描百万到百亿行做聚合与关联 |
| 数据模型 | 三范式，避免冗余 | 维度建模，适度冗余换查询简单 |
| 数据时效 | 实时一致 | T+1 为主，实时链路做到秒级到分钟级 |
| 历史 | 通常只保留当前状态 | 保留历史，能回答"上个月某天是什么样" |
| 存储 | MySQL / PostgreSQL 行存 | 列存文件（Parquet / ORC）+ 湖仓表格式，或 OLAP 数据库 |

Java 后端和数据平台打交道，主要在四个接口上：

- **数据产出**：业务库要开启 binlog 并保证表有主键、有 `update_time`，方便 CDC 和增量同步；埋点要有统一的事件规范（事件名、用户标识、时间戳、公共属性），否则下游清洗成本会成倍增加
- **口径对齐**：「GMV」「下单用户数」到底算不算取消单、退款单，要由业务和数据团队共同定义成指标，写进指标字典，而不是各个接口各写一套 SQL（见 [数仓分层与建模](./2_data_warehouse) 第九节）
- **数据回流**：加工好的结果（用户标签、商品热度、报表数据）通过数据服务接口、OLAP 查询或回写到业务库 / Redis 供在线系统使用（见 [OLAP 查询与数据服务](./7_olap_service)）
- **任务协作**：后端定时任务和数仓任务的依赖（比如对账任务要等 T+1 订单汇总完成）通过调度系统表达，而不是靠"凌晨三点应该跑完了"的约定（见 [任务调度](./6_scheduling)）

::: tip 数据量不大时先别上大数据
订单表千万行级别、报表需求不复杂时，MySQL 只读副本加汇总表、或者一个单机 Doris / ClickHouse 往往就够了。引入 Spark、湖仓、调度、治理一整套组件的前提，是数据量、数据源数量或分析需求已经超出业务库能承担的范围。判断依据见 [海量数据架构选型](/scenario/2_big_data)。
:::

---

## 二、技术栈全景

![大数据技术栈全景](../assets/big-data/overview-bigdata-stack.svg)

一条典型的离线 + 实时数据链路分为五层，调度与治理横跨各层：

| 层 | 职责 | 常见选择 | 本模块 |
|----|------|----------|--------|
| 数据源 | 产生业务事实 | MySQL 业务库、App / 服务端埋点日志、Kafka 业务消息、第三方文件 | — |
| 数据集成 | 把数据搬进数据平台，或把结果搬出去 | 批量：DataX、SeaTunnel；实时：Flink CDC、Debezium、Kafka Connect | [数据集成](./5_data_integration) |
| 存储 | 以开放格式长期保存全部数据 | 对象存储（S3 / OSS / MinIO）或 HDFS，上面是 Iceberg / Paimon / Hudi 表格式，存量系统大量是 Hive 表 | [大数据基础](./1_basics)、[数据湖与湖仓](./4_lakehouse) |
| 计算 | 清洗、关联、聚合 | 批处理：Spark（存量 Hive on MR / Tez）；流处理：Flink；资源管理：YARN 或 Kubernetes | [Spark](./3_spark)、[Flink](/flink/0_overview) |
| 查询与服务 | 交互式分析与对外提供数据 | Doris、StarRocks、Trino、ClickHouse；数据服务 API、BI 报表 | [OLAP 查询与数据服务](./7_olap_service) |
| 调度（横跨） | 按依赖与时间触发任务、重试、补数 | DolphinScheduler、Airflow | [任务调度](./6_scheduling) |
| 治理（横跨） | 元数据、血缘、质量、权限、成本 | 元数据目录、数据质量规则、Ranger 类权限系统 | [数据治理](./8_governance) |

几个理解整张图的要点：

- **数据怎么组织比用什么引擎更重要**：同样的 Spark，分层清楚、口径统一的数仓好维护；ODS 直接出报表、每个需求一张宽表的数仓，换什么引擎都会失控。所以本模块先讲 [数仓分层与建模](./2_data_warehouse)，再讲引擎
- **存储与计算正在解耦**：数据以开放的表格式（Iceberg / Paimon）放在对象存储上，Spark、Flink、Trino、Doris 都能读写同一份数据，引擎可以按场景替换，原理见 [大数据基础](./1_basics) 第二节
- **离线与实时在收敛**：早期离线（Hive / Spark）和实时（Kafka + Flink）是两套完全独立的链路；湖仓表格式支持流式读写后，越来越多团队用一套存储同时服务批和流，实践见 [实时数仓实战](./9_realtime_dw)
- **调度和治理决定能否长期运行**：几百个任务之后，真正的痛点不是"能不能算出来"，而是"上游延迟了谁受影响""这个字段是从哪来的""昨天的数据对不对"

---

## 三、模块导航

<ModuleNav />

---

## 四、推荐阅读路径

1. **建立整体概念**：读 [大数据基础](./1_basics)（批与流、存算分离、Lambda / Kappa、HDFS 与 YARN 的现状、对象存储作为数据湖底座），知道每个组件解决什么问题。
2. **先学怎么组织数据**：读 [数仓分层与建模](./2_data_warehouse)（ODS / DWD / DWS / ADS、维度建模、缓慢变化维、指标定义），这是后面所有文章的共同语言。
3. **掌握批处理与存储**：读 [Spark](./3_spark)（执行模型、Shuffle、Spark SQL 调优）和 [数据湖与湖仓](./4_lakehouse)（Iceberg / Paimon / Hudi 的表格式原理与选型）。
4. **把链路串起来**：读 [数据集成](./5_data_integration) 和 [任务调度](./6_scheduling)，理解数据如何进出平台、几百个任务如何按依赖可靠运行；实时同步细节对照 [Flink CDC](/flink/6_cdc)。
5. **面向使用与长期运营**：读 [OLAP 查询与数据服务](./7_olap_service) 与 [数据治理](./8_governance)，最后在 [实时数仓实战](./9_realtime_dw) 中把 Flink、Paimon、Doris 组合成一条完整的实时链路。

复习时用 [高频面试题](./99_interview) 自测，答案在 [大数据面试题解答](/interview/26_bigdata)。

---

## 五、关联模块

- 流计算引擎：DataStream、事件时间与窗口、状态与 Checkpoint、Flink SQL → [Flink](/flink/0_overview)；Flink 实时数仓分层与维表关联 → [实战场景](/flink/8_scenarios)
- 业务库实时同步：binlog 前置配置、Canal / Debezium / Flink CDC 对比 → [CDC 工具](/database/5_practice/0_cdc_tools)、[Flink CDC](/flink/6_cdc)
- 列存原理、ClickHouse、Doris / StarRocks 数据模型 → [列式与 OLAP 数据库](/database/4_nosql/0_column_db)
- 数据集成与实时链路的消息总线 → [Kafka](/messaging/2_kafka)
- 业务侧定时任务、XXL-JOB 等分布式调度 → [分布式调度](/distributed/6_job_scheduler)；审批类流程编排 → [工作流引擎](/distributed/7_work_flow)
- 冷热分层与归档 → [数据冷热分离](/architecture/1_cold_hot_data)；对象存储原理与选型 → [对象存储](/architecture/4_object_storage)
- 海量数据场景的整体选型 → [海量数据架构选型](/scenario/2_big_data)；读写分离到异构存储 → [数据层扩展](/high-con/5_data_scaling)
- 数据回流到在线系统时的缓存设计 → [缓存总览](/cache/0_overview)；高并发查询场景 → [高并发总览](/high-con/0_overview)

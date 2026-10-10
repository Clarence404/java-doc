---
description: 元数据目录与血缘、OpenLineage、质量规则与调度门禁、命名与指标口径、权限脱敏、生命周期与成本
---

# 数据治理

> 前置阅读：[数仓分层与建模](./2_data_warehouse)、[任务调度](./6_scheduling)

数据治理是用一套标准、工具和流程，持续回答"字段从哪来、改动影响谁、数据对不对、表还有没有人用"这类问题。本篇讲元数据目录与血缘、质量规则与调度门禁、命名与指标口径、权限脱敏、生命周期与成本，示例沿用电商订单业务（`order_info`、`order_item`、`user_info`、`product` 与 App 埋点），引擎以 Flink 2.2、Spark 4.2、Paimon 2.0、StarRocks 4.1 为准。

---

## 一、数据治理管什么

数仓刚建起来时，几十张表、几个人维护，靠口头约定就够了。表涨到几千张、任务涨到几百个之后，问题就从"能不能算出来"变成了："这个字段是从哪来的""上游改了表结构会影响谁""昨天的 GMV 和财务对不上是谁的问题""这张 3 TB 的表还有人用吗"。

![数据治理闭环](../assets/big-data/governance-loop.svg)

数据治理常被讲成一个大而空的概念，落到工程上其实是六件具体的事：

| 领域 | 回答的问题 | 主要产出 | 典型工具 |
|------|------------|----------|----------|
| 数据标准 | 表怎么命名、字段用什么类型、GMV 怎么算 | 命名规范、字段标准、指标字典 | 文档 + 建表检查、指标平台 |
| 元数据与血缘 | 有哪些表、谁负责、数据从哪来到哪去 | 数据目录、Owner、表级 / 字段级血缘 | DataHub、OpenMetadata、OpenLineage |
| 数据质量 | 今天的数据对不对、到没到 | 质量规则、检查结果、质量门禁 | Great Expectations、调度内置质量任务、自研 SQL 规则 |
| 安全与合规 | 谁能看哪些数据、敏感字段怎么处理 | 分级分类、角色权限、脱敏策略、访问审计 | 引擎 RBAC、Apache Ranger |
| 生命周期与成本 | 数据存多久、放哪一层存储、没人用的表怎么下线 | 保留策略、冷热分层、下线流程 | 表格式的过期机制、对象存储生命周期规则 |
| 度量与改进 | 治理做得怎么样 | 健康分、问题工单、复盘 | 数据目录的统计、自建看板 |

落地顺序上有三条经验：

- **从核心链路起步**：先选 GMV、订单明细这类出了错会直接被老板和财务发现的链路，把它涉及的二三十张表的 Owner、口径、质量规则、血缘做全，比一次性给几千张表补描述有用得多
- **每张表必须有 Owner**：治理的问题最终都要落到人。没有 Owner 的表，质量告警没人接，下线时没人确认。新建表时在建表流程中强制登记 Owner，存量表按血缘和最近写入任务的负责人认领
- **标准要靠工具执行，而不是靠文档**：命名规范写在 Wiki 里没人看，写成建表审核和 CI 检查才会被遵守；质量规则写在文档里不会自己跑，接进调度才会真正拦住坏数据

::: tip 治理不是一个独立的项目
最常见的失败是成立一个"数据治理项目"，花半年补齐元数据和文档，项目结束后新表又回到无人管理的状态。治理要嵌进日常研发流程：建表时登记 Owner 和分级，上线任务时自动采集血缘，发布前跑质量规则，每季度按访问记录清理无用表。
:::

---

## 二、元数据管理

### 1、三类元数据

| 类型 | 内容 | 来源 |
|------|------|------|
| 技术元数据 | 库表结构、字段类型、分区、存储位置、文件数与大小、表格式快照 | 自动采集：Hive Metastore / Paimon Catalog / StarRocks `information_schema` |
| 业务元数据 | 表和字段的中文含义、所属业务域、Owner、术语表、指标口径、敏感等级标签 | 人工维护为主，可从建表注释和指标平台同步 |
| 操作元数据 | 任务运行记录、产出时间、数据量、查询次数、血缘 | 自动采集：调度系统、OpenLineage 事件、引擎审计日志 |

技术元数据和操作元数据必须自动采集，人工维护一定会过期；业务元数据需要人写，但要把入口放在研发流程里，例如建表 SQL 的 `COMMENT` 必填、上线任务时填写所属业务域。

### 2、数据目录选型

数据目录（Data Catalog）把三类元数据汇总到一个可搜索的界面，是治理的"总台账"。开源方案里最常见的是 DataHub 和 OpenMetadata，两者都是 Apache License 2.0：

| 维度 | DataHub | OpenMetadata | Apache Atlas |
|------|---------|--------------|--------------|
| 出身 | LinkedIn 开源，现由 DataHub 公司（原 Acryl Data）主导 | 前 Uber 数据平台团队成员创建，Collate 公司主导 | Hortonworks 开源，Hadoop 生态 |
| 版本现状（2026-10） | 1.x，当前 LTS 线为 1.6 | 2.0.x | 更新缓慢，多见于存量 CDH / HDP 集群 |
| 架构 | GMS 元数据服务 + Kafka 事件流 + Elasticsearch / OpenSearch + MySQL 等 | 单体 API 服务 + MySQL / PostgreSQL + Elasticsearch / OpenSearch | HBase + Solr + Kafka |
| 采集方式 | Python 采集框架（pull）+ 事件推送（push） | 内置采集连接器，统一在界面中配置 | 依赖各组件的 Hook |
| 特色 | 元数据变更以事件流传播，扩展性强 | 数据质量、数据合约、协作功能内置，上手快 | 与 Ranger 联动的标签策略 |

选型建议：已有 Kafka、愿意投入平台开发的团队选 DataHub；希望开箱即用、团队规模较小的选 OpenMetadata；Atlas 只在维护存量 Hadoop 集群时考虑。

数据目录上线后最先做的三件事：

- **接入核心数据源**：Paimon / Hive Catalog、StarRocks、业务 MySQL、Kafka，让技术元数据每天自动同步
- **登记 Owner 与业务域**：每张表至少有一个技术 Owner（负责产出任务）和一个业务 Owner（负责口径解释）
- **打敏感标签**：给手机号、身份证号、地址等字段打上 `PII` 之类的标签，后面的权限策略和脱敏规则按标签生效（第六节）

---

## 三、数据血缘

### 1、血缘用来做什么

| 场景 | 例子 |
|------|------|
| 影响分析 | 订单服务要把 `order_info.amount` 从分改成元，变更前查出所有下游表、报表和接口，逐一通知 Owner |
| 根因定位 | ADS 报表的 GMV 突然下跌，沿血缘往上游逐层检查，定位到某个 DWD 任务的过滤条件写错 |
| 补数范围 | 上游修复了某天的数据，根据血缘确定需要重跑哪些下游任务（见 [任务调度](./6_scheduling)） |
| 合规与下线 | 证明敏感字段只流向了授权系统；确认一张表没有下游后再下线 |

血缘有表级和字段级两种粒度。表级血缘足以支撑影响分析和补数；字段级血缘对口径追溯和敏感字段追踪更有价值，但采集难度大得多。

### 2、两种采集方式

- **静态解析**：解析调度系统里的 SQL 文本，提取 `INSERT INTO ... SELECT ... FROM ...` 中的输入输出表和字段映射。实现简单、覆盖历史任务，但处理不了动态拼接的 SQL、Spark / Flink 的 DataStream 代码和临时视图嵌套
- **运行时采集**：引擎在作业运行时把实际读写的数据集上报出来。准确性高，能覆盖代码类作业，代价是要在每个引擎上装集成插件。OpenLineage 就是这一类的开放标准

两者通常结合使用：运行时采集为主，静态解析补齐还没接入插件的老任务。

### 3、OpenLineage

OpenLineage 是 LF AI & Data 基金会下的开放血缘标准（Apache License 2.0），定义了一套事件模型和各引擎的集成实现，Marquez 是它的参考实现后端，DataHub、OpenMetadata 也都能接收 OpenLineage 事件。

事件模型只有三个核心对象：

| 对象 | 含义 | 例子 |
|------|------|------|
| Job | 一个作业的定义 | `dwd_trade_order_detail_inc` 的 Spark 任务 |
| Run | Job 的一次运行，带运行 ID | 2026-10-09 这天的那次调度 |
| Dataset | 作业读写的数据集，按 namespace + name 标识 | `s3://mall-lake` 下的 `dwd.dwd_trade_order_detail_inc` |

每次运行会发送一组 `RunEvent`，`eventType` 取 `START`、`RUNNING`、`COMPLETE`、`FAIL`、`ABORT`，事件里带上输入输出数据集；表结构、字段级血缘、数据量等附加信息以 facet（扩展字段）的形式挂在对象上。

**Flink 2.x 接入**：Flink 2.x 提供了原生的血缘接口（FLIP-314），OpenLineage 的 Flink 2 集成基于它实现，**不需要改作业代码，并且支持 Flink SQL**（Flink 1.x 的集成需要在代码里注册 Listener，且不支持 SQL）。把 `openlineage-flink` 放到 classpath，再在 Flink 配置中注册监听器和传输方式：

```yaml
# Flink 配置文件（config.yaml）
execution.job-status-changed-listeners: io.openlineage.flink.listener.OpenLineageJobStatusChangedListenerFactory
openlineage.transport.type: http
openlineage.transport.url: http://lineage-gateway:5000
# 运行中作业每隔多少秒上报一次 RUNNING 事件，默认 60
openlineage.trackingIntervalInSeconds: 60
```

**Spark 接入**：通过 `SparkListener` 采集，Spark SQL 和 DataFrame 作业都能覆盖：

```bash
spark-submit \
  --conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener \
  --conf spark.openlineage.transport.type=http \
  --conf spark.openlineage.transport.url=http://lineage-gateway:5000 \
  --conf spark.openlineage.namespace=mall-batch \
  --class com.mall.dw.DwdTradeOrderDetailJob \
  dw-jobs.jar --dt 2026-10-09
```

`openlineage-spark` 的 jar 要和集群的 Scala 版本匹配（Spark 4.x 为 Scala 2.13）。`transport.url` 指向接收端：用 Marquez 时是 Marquez 的 API 地址；DataHub、OpenMetadata 的接收路径在不同版本中有过调整，以所用版本文档为准。

::: tip 血缘要和调度任务对得上
OpenLineage 的 Job 名默认来自作业名或 Spark 应用名。如果调度系统里叫 `dwd_trade_order_detail_inc`、Spark 里叫 `DwdJob`、数据目录里又是另一个名字，血缘图上就会出现三个对不上的节点。约定调度任务名、作业名、产出表名三者一致，是血缘可用的前提。
:::

---

## 四、数据质量

### 1、质量维度与规则

| 维度 | 含义 | 规则示例（订单明细 `dwd_trade_order_detail_inc`） |
|------|------|------------------------------------------------|
| 完整性 | 该有的数据都有 | `order_id`、`user_id`、`pay_time` 非空；当日行数不低于近 7 日均值的 50% |
| 唯一性 | 不该重复的不重复 | `(order_id, sku_id)` 唯一 |
| 有效性 | 取值在合法范围内 | `amount >= 0`；`status` 在码表 `('CREATED','PAID','SHIPPED','FINISHED','CANCELED')` 中 |
| 一致性 | 跨表、跨系统对得上 | DWD 当日支付金额合计与业务库对账结果差异小于 0.1% |
| 及时性 | 在约定时间前产出 | 每天 05:00 前 `dt=T-1` 分区产出完成；实时链路延迟小于 10 分钟 |
| 准确性 | 和真实世界一致 | 抽样与业务后台核对，一般通过一致性规则间接保证 |

规则按影响分两级：

- **强规则**：失败说明数据不可用，继续往下游跑只会扩大影响，例如主键重复、当日数据量为零、金额为负。失败时阻断下游任务并电话告警
- **弱规则**：失败说明数据可疑但不一定错，例如数据量波动超过 30%、某个非核心字段空值率上升。失败时只告警并生成问题单，下游照常运行

### 2、用 SQL 表达规则

质量规则的本质是"一条返回异常数的 SQL + 一个阈值"，不依赖特定工具。下面是 `dwd_trade_order_detail_inc` 的一组规则，可以在 Spark SQL、Flink 批模式或 StarRocks 中执行：

```sql
-- 规则 1（强）：主键唯一，期望返回 0
SELECT COUNT(*) AS bad_rows
FROM (
  SELECT order_id, sku_id
  FROM dwd.dwd_trade_order_detail_inc
  WHERE dt = '2026-10-09'
  GROUP BY order_id, sku_id
  HAVING COUNT(*) > 1
) t;

-- 规则 2（强）：关键字段非空、金额非负，期望返回 0
SELECT SUM(CASE WHEN order_id IS NULL OR user_id IS NULL OR pay_time IS NULL THEN 1 ELSE 0 END)
     + SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS bad_rows
FROM dwd.dwd_trade_order_detail_inc
WHERE dt = '2026-10-09';

-- 规则 3（弱）：当日行数与近 7 日均值相比的波动比例，阈值 0.3
SELECT ABS(cur.cnt - hist.avg_cnt) / hist.avg_cnt AS fluctuation
FROM (SELECT COUNT(*) AS cnt FROM dwd.dwd_trade_order_detail_inc WHERE dt = '2026-10-09') cur
CROSS JOIN (
  SELECT AVG(cnt) AS avg_cnt
  FROM (
    SELECT dt, COUNT(*) AS cnt
    FROM dwd.dwd_trade_order_detail_inc
    WHERE dt BETWEEN '2026-10-02' AND '2026-10-08'
    GROUP BY dt
  ) d
) hist;
```

把规则存成配置（表名、规则 SQL、阈值、级别、Owner），由一个通用的质量检查任务按表加载执行，比每张表写一个检查脚本好维护得多。DolphinScheduler 等调度系统自带数据质量任务类型，也可以直接使用，见 [任务调度](./6_scheduling)。

### 3、用 Great Expectations 写规则

Great Expectations（GX Core，Apache License 2.0，当前 1.x）是常用的 Python 数据质量库，把规则叫作 Expectation，能直接校验 Pandas、Spark DataFrame 和 SQL 表。下面在 Spark 中读取 Paimon 表的一个分区并校验：

```python
import sys
import great_expectations as gx
from pyspark.sql import SparkSession

dt = sys.argv[1]  # 调度传入的业务日期，如 2026-10-09

spark = (SparkSession.builder.appName(f"dq_dwd_trade_order_detail_{dt}")
         .config("spark.sql.catalog.paimon", "org.apache.paimon.spark.SparkCatalog")
         .config("spark.sql.catalog.paimon.warehouse", "s3://mall-lake/warehouse")
         .getOrCreate())
df = spark.sql(f"SELECT * FROM paimon.dwd.dwd_trade_order_detail_inc WHERE dt = '{dt}'")

context = gx.get_context()
batch_def = (context.data_sources.add_spark(name="paimon")
             .add_dataframe_asset(name="dwd_trade_order_detail_inc")
             .add_batch_definition_whole_dataframe("daily_partition"))

suite = context.suites.add(gx.ExpectationSuite(name="dwd_trade_order_detail_strong"))
suite.add_expectation(gx.expectations.ExpectTableRowCountToBeBetween(min_value=1))
suite.add_expectation(gx.expectations.ExpectColumnValuesToNotBeNull(column="order_id"))
suite.add_expectation(gx.expectations.ExpectColumnValuesToNotBeNull(column="pay_time"))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(column="amount", min_value=0))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeInSet(
    column="status", value_set=["CREATED", "PAID", "SHIPPED", "FINISHED", "CANCELED"]))

validation = context.validation_definitions.add(
    gx.ValidationDefinition(name="dwd_trade_order_detail_daily", data=batch_def, suite=suite))
result = validation.run(batch_parameters={"dataframe": df})

print(result.describe())
sys.exit(0 if result.success else 1)  # 非 0 退出码让调度判定任务失败
```

`(order_id, sku_id)` 这类组合唯一性用 `ExpectCompoundColumnsToBeUnique`。GX 的价值在于规则库丰富、结果报告可读；如果团队以 SQL 为主、不想引入 Python 运行环境，上一小节的 SQL 规则方案同样可行。

### 4、接入调度：质量门禁

![调度中的质量门禁](../assets/big-data/governance-quality-gate.svg)

质量检查只有放在数据流转的路径上才有意义。做法是把检查作为一个独立的调度任务，插在产出任务和下游任务之间：

- **强规则检查任务**：失败（退出码非 0）时任务失败，调度系统按依赖关系阻断所有下游，Owner 修复数据后重跑产出任务和检查任务，下游自动继续
- **弱规则检查任务**：作为旁路任务，失败时只告警，不阻断下游；也可以把强弱规则放在同一个任务里，弱规则失败时只记录不改变退出码
- **及时性规则**：不需要读数据，用调度系统的"任务超时告警"或"截止时间未完成告警"实现，例如 `dwd_trade_order_detail_inc` 05:00 前未成功即告警
- **实时链路**：Paimon 表可以配置分区完成标记（`partition.mark-done-action`），分区在一段时间内不再有新数据后写出 `_SUCCESS` 文件，离线质量检查任务以它为依赖，具体配置见 [实时数仓实战](./9_realtime_dw) 第三节

::: warning 门禁要有逃生通道
强规则偶尔会误报（例如大促当天数据量暴涨被判为异常，或者业务确实没有数据）。要给 Owner 留一个"人工确认放行"的操作，并记录是谁、因为什么放行，否则大家会因为怕误报而把规则都降成弱规则。
:::

### 5、数据合约

质量问题有很大一部分来自上游的"无声变更"：业务库删了一个字段、埋点改了事件名、枚举值多了一种。数据合约（Data Contract）把上游产出方和下游消费方之间的约定写成一份机器可读的文件：表结构、字段含义、取值范围、更新频率、SLA、Owner，变更需要双方确认。Bitol 项目维护的 Open Data Contract Standard（ODCS）是目前较常见的 YAML 格式，OpenMetadata 也内置了数据合约功能。

落地时不必一开始就引入完整规范，先做到两点就能挡住大部分问题：业务库表结构变更在上线评审时检查是否被数仓订阅（查血缘），埋点事件新增或修改必须走埋点平台登记（见 [实时数仓实战](./9_realtime_dw) 第一节）。

---

## 五、数据标准与指标口径

数据域划分、表命名模式、原子 / 派生 / 衍生指标的拆解方法和指标字典的字段，已经在 [数仓分层与建模](./2_data_warehouse) 第八、九节定义；指标层与语义层的落地方式见 [OLAP 查询与数据服务](./7_olap_service) 第十节。本节只讲治理侧的两件事：标准怎么被强制执行，口径怎么保持一致。

### 1、字段标准

命名之外，字段类型和取值的标准同样要统一，这些是跨表关联和对账出错的主要来源：

| 类别 | 标准 | 不统一的后果 |
|------|------|--------------|
| 金额 | `DECIMAL(18, 2)`，单位元；需要分的场景字段名带 `_fen` | `DOUBLE` 累加有精度误差；分和元混用是对账差异的头号来源 |
| 时间 | 统一为 `Asia/Shanghai` 本地时间，跨时区业务另存 UTC 字段 | 混用 UTC 与本地时间会让"当天"的边界差 8 小时 |
| 标识 | 同一实体在全仓用同一个字段名和类型，如 `user_id BIGINT` | 关联时隐式类型转换导致索引失效或关联丢数据；主数据不统一时先建映射表，见 [主数据管理](/architecture/7_master_data) |
| 枚举 | 保留源系统编码，含义在码表中维护 | 下游各自翻译编码，产生多套口径 |
| 注释 | 表和字段 `COMMENT` 必填 | 业务元数据缺失，数据目录里只剩英文字段名 |

### 2、标准靠检查执行

规范只写在文档里一定会被绕过。把检查放在三个位置：

- **建表时**：建表走工单或 Git 提交，审核脚本检查表名是否符合 `{层}_{数据域}_...` 模式、数据域是否在登记的枚举里、是否填写 Owner 和 `COMMENT`、是否设置分区和保留期，不通过不允许执行
- **上线时**：任务 SQL 在 CI 中做静态检查，例如 ADS 任务不允许直接读 ODS 表（跨层引用）、禁止 `SELECT *` 写入下游表
- **存量巡检**：定期扫描元数据，找出违规的存量表，生成整改单派给 Owner

存量巡检直接查引擎的元数据即可。以 StarRocks 为例，找出金额字段用了浮点类型、以及缺少注释的表：

```sql
-- 金额字段使用了 FLOAT / DOUBLE
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE column_name LIKE '%amount%'
  AND data_type IN ('float', 'double');

-- 表注释为空
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('ads', 'dws')
  AND (table_comment IS NULL OR table_comment = '');
```

### 3、口径一致

口径不一致的根源通常不是定义写错，而是同一个指标被算了多次。治理上守住三条：

- **只算一次**：派生指标只在 DWS 层由一个任务计算，所有报表、接口、看板都从同一张表或同一个指标层取数，禁止在 ADS 或接口里重新从 DWD 拼 SQL。新报表评审时检查它引用的指标是否已存在
- **变更走流程**：口径变更需要业务 Owner 和数据 Owner 共同评审；评审前用血缘查出所有使用该指标的表、报表和接口；上线时新旧口径双跑一段时间并对比差异，指标字典记录版本和生效日期，对外公告
- **对账规则化**：关键指标之间的一致性写成质量规则，例如 DWS 当日支付 GMV 与业务库支付流水合计的差异小于 0.1%、ADS 报表与 DWS 汇总完全相等，失败即告警，而不是等业务方发现两个看板数字不同

---

## 六、访问控制与脱敏

### 1、先分级再授权

数据分级的原则和合规要求见 [数据安全](/security/7_data_security) 第一节。在数据平台上，分级结果以标签形式挂在数据目录的字段上，常见四级：

| 级别 | 示例字段 | 默认策略 |
|------|----------|----------|
| L1 公开 | 商品类目、城市 | 全员可读 |
| L2 内部 | 订单量、GMV 汇总 | 按业务域授权 |
| L3 敏感 | 用户 ID 明细、订单明细 | 按需申请，审批后限时开通 |
| L4 高敏 | 手机号、身份证号、详细地址 | 默认脱敏，原文仅限少数系统账号，访问留审计 |

L4 字段最好在进入数仓时就处理：ODS 层存密文或哈希值（便于关联但无法还原），明文只留在业务库，真正需要明文的场景走业务系统的接口。这样数仓内大部分表天然不含高敏数据，授权和审计的压力小很多。

### 2、StarRocks 角色授权

查询入口统一收口到 OLAP 引擎时，权限也在这里管理。StarRocks 使用 RBAC（模型原理见 [RBAC 与 ABAC](/security/5_rbac_abac)），按"角色 = 业务域 × 级别"设计，人只绑定角色：

```sql
-- 运营分析师：可读 ADS 库全部表和物化视图
CREATE ROLE ads_reader;
GRANT SELECT ON ALL TABLES IN DATABASE ads TO ROLE ads_reader;
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE ads TO ROLE ads_reader;

-- 数据开发：可以通过外部 Catalog 查询 Paimon 湖仓
CREATE ROLE lake_reader;
GRANT USAGE ON CATALOG paimon_lake TO ROLE lake_reader;
SET CATALOG paimon_lake;
GRANT SELECT ON ALL TABLES IN DATABASE dwd TO ROLE lake_reader;
SET CATALOG default_catalog;

-- 把角色授予用户
GRANT ads_reader TO USER 'analyst_li'@'%';
```

服务账号（例如 [实时数仓实战](./9_realtime_dw) 中的查询服务）单独建角色，只授予它查询的那几张表，不复用个人账号。

### 3、脱敏

字段加密、密钥管理、脱敏函数的实现细节见 [数据安全](/security/7_data_security)，这里只讲它们在数据平台中的落地方式。脱敏有两种实现方式：

- **脱敏视图**：对含敏感字段的表建一个视图，把敏感列替换为脱敏表达式，普通角色只授权视图、不授权原表。实现简单、所有引擎通用，缺点是表多了视图维护成本高

```sql
CREATE VIEW ads.v_user_order_masked AS
SELECT
  order_id,
  user_id,
  CONCAT(LEFT(receiver_phone, 3), '****', RIGHT(receiver_phone, 4)) AS receiver_phone,
  province,
  city,
  pay_amount,
  dt
FROM ads.ads_user_order;

GRANT SELECT ON VIEW ads.v_user_order_masked TO ROLE ads_reader;
```

- **策略引擎**：用 Apache Ranger 集中配置访问策略、列脱敏策略和行级过滤策略，按用户组或标签生效。StarRocks 自 3.1.9 起支持接入 Ranger，Hive、Spark、Trino 等也有对应插件，适合多引擎、多团队的平台。外部 Catalog 的表可以复用对应数据源（如 Hive）的 Ranger 服务，上线前在测试环境验证脱敏和行过滤对外部表是否按预期生效

导出数据同样要受控：查询平台限制单次导出行数、导出文件加水印、导出动作写审计日志。审计日志的字段设计与防篡改存储见 [数据安全](/security/7_data_security) 第四节。

---

## 七、生命周期与成本

### 1、按层设定保留策略

数据不是存得越久越好。每一层按用途定保留期，用表格式自带的机制自动执行：

| 层 | 建议保留 | 理由 |
|----|----------|------|
| Kafka 原始消息 | 3–7 天 | 只用于故障重放，超过最长恢复时间即可 |
| ODS | 30–90 天热数据，之后归档到低频存储或删除 | 可以从源头重新抽取的数据不必长期保留 |
| DWD | 1–3 年 | 明细回溯、同比分析的基础 |
| DWS / ADS | 按需求，汇总数据体积小可长期保留 | — |
| 临时表 | 7 天 | 由清理任务删除 |

以 Paimon 为例，分区过期和快照保留都是表属性：

```sql
ALTER TABLE ods.ods_app_event_inc SET (
  'partition.expiration-time' = '30 d',          -- 分区超过 30 天自动删除
  'partition.expiration-check-interval' = '1 h', -- 检查间隔，默认 1 h
  'partition.timestamp-formatter' = 'yyyy-MM-dd',
  'partition.timestamp-pattern' = '$dt',
  'snapshot.time-retained' = '24 h'              -- 快照保留时长，决定能时间旅行回溯多远
);
```

`snapshot.time-retained` 默认只有 1 小时：保留越久，能回溯的时间越长，但旧快照引用的数据文件也不能删除，存储成本随之上升。按"最长故障发现时间"设定即可，长期回溯需求用定期打 tag 的方式满足。表格式的快照与过期机制见 [数据湖与湖仓](./4_lakehouse)。StarRocks 物化视图和分区表可以用 `partition_ttl` 属性自动删除过期分区。

### 2、冷热分层

热数据放在高性能存储上供频繁查询，冷数据转到低成本存储。业务库的冷热分离（归档迁移、分区交换）见 [数据冷热分离](/architecture/1_cold_hot_data)；在湖仓中，数据本来就在对象存储上，分层主要靠对象存储的生命周期规则：

- 按路径前缀为 ODS、DWD 的历史分区配置生命周期规则，超过 N 天转为低频访问或归档存储
- 归档存储的读取需要先解冻、有最短存储时长要求，只适合几乎不再查询的数据；会被定期回溯的表转低频访问即可
- OLAP 引擎中只保留近期热数据（如近 90 天），更早的数据通过外部 Catalog 直接查湖仓，或用存算分离模式把数据放在对象存储、本地只做缓存

### 3、找出没人用的表

数仓的存储和计算成本里，往往有相当一部分花在没人用的表和任务上。下线流程：

1. **识别候选**：结合三类信息——血缘上没有下游、引擎审计日志中 90 天内无查询、数据目录中无人收藏或订阅
2. **通知 Owner 确认**：在数据目录中标记"待下线"，通知 Owner 和最近的查询人，给出两周确认期
3. **先停任务再删数据**：先暂停产出任务，表改为只读并保留一段观察期（如 30 天），期间无人反馈再删除数据和元数据
4. **度量收益**：统计每月下线的表数、释放的存储量和节省的计算时长，作为治理成果的直接证据

另外两个常见的成本黑洞：小文件过多（流式写入每次 checkpoint 都产生新文件，需要依赖表格式的 compaction 或定期合并），以及重复建设（多个团队各自从 ODS 算同一个指标，通过指标字典和血缘发现后合并）。

---

## 小结

- 数据治理落到工程上是六件事：标准、元数据与血缘、质量、安全、生命周期与成本、度量改进；从核心链路起步，每张表必须有 Owner，标准靠工具执行
- 元数据分技术、业务、操作三类，前后两类自动采集；数据目录选 DataHub（扩展性强）或 OpenMetadata（开箱即用），两者都是 Apache License 2.0
- 血缘以运行时采集为主：OpenLineage 的 Flink 2 集成基于原生血缘接口，免改代码且支持 Flink SQL；Spark 通过 `OpenLineageSparkListener` 接入；调度任务名、作业名、表名保持一致
- 质量规则是"返回异常数的 SQL + 阈值"，分强弱两级；检查任务插在产出与下游之间，强规则失败阻断下游，并保留人工放行通道
- 表命名 `{层}_{数据域}_{业务过程或主题}_{后缀}`，金额 `DECIMAL`、时间统一时区；指标拆成原子指标 + 修饰词 + 时间周期，派生指标只在 DWS 计算一次
- 敏感数据先分级，高敏字段在入仓时加密或哈希；OLAP 引擎按角色授权，脱敏用视图或 Ranger 策略
- 按层设定保留期，Paimon 用分区过期和快照保留自动执行；冷数据靠对象存储生命周期规则转低频存储；定期按血缘和访问记录下线无用表

## 参考资料

- DataHub 文档：[DataHub Documentation](https://docs.datahub.com/)
- DataHub 版本发布：[DataHub Releases](https://github.com/datahub-project/datahub/releases)
- OpenMetadata 文档：[OpenMetadata Docs](https://docs.open-metadata.org/)
- OpenLineage 规范与对象模型：[OpenLineage Documentation](https://openlineage.io/docs/)
- OpenLineage Flink 2 集成：[Flink 2.x Integration](https://openlineage.io/docs/integrations/flink/flink2/)、[Flink Configuration](https://openlineage.io/docs/integrations/flink/configuration)
- OpenLineage Spark 集成：[Spark Configuration Usage](https://openlineage.io/docs/integrations/spark/configuration/usage)
- OpenLineage 传输配置：[Java Client Configuration](https://openlineage.io/docs/client/java/configuration)
- Flink 原生血缘接口：[FLIP-314: Support Customized Job Lineage Listener](https://cwiki.apache.org/confluence/display/FLINK/FLIP-314%3A+Support+Customized+Job+Lineage+Listener)
- Great Expectations：[GX Core Documentation](https://docs.greatexpectations.io/docs/core/introduction/)
- 数据合约标准：[Open Data Contract Standard](https://bitol-io.github.io/open-data-contract-standard/latest/)
- StarRocks 授权：[GRANT](https://docs.starrocks.io/docs/sql-reference/sql-statements/account-management/GRANT/)、[Apache Ranger 插件](https://docs.starrocks.io/docs/administration/user_privs/authorization/ranger_plugin/)
- Paimon 表属性（分区过期、快照保留、分区完成标记）：[Paimon Configurations](https://paimon.apache.org/docs/2.0/maintenance/configurations/)

> 下一篇：[实时数仓实战](./9_realtime_dw)

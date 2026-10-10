---
description: DAG 依赖、数据时间与运行时间、DolphinScheduler、补数与重跑、幂等分区覆盖、Airflow 3 对比、SLA 监控
---

# 任务调度

> 前置阅读：[数仓分层与建模](./2_data_warehouse)、[数据集成](./5_data_integration)

数据任务调度让离线链路按依赖和业务日期正确运行，失败能重跑、历史能补数。本篇讲 DAG 依赖、数据时间、补数与重跑、幂等写入和 SLA 监控，基线为 DolphinScheduler 3.4。

---

## 一、数据调度要解决什么

本篇以 Apache DolphinScheduler 3.4 和 Apache Airflow 3.3 为基线，示例统一使用电商订单日报链路 `order_daily`，目标是核心报表按时产出。

### 1、和业务定时任务的区别

业务定时任务关心"到点执行一次、不重复"，数据任务关心"按依赖顺序、对某一天的数据算对"。两者的关注点差异如下：

| 维度 | crontab | 业务调度器（XXL-JOB 等） | 数据工作流调度器（DolphinScheduler / Airflow） |
|------|---------|--------------------------|------------------------------------------------|
| 触发 | 时间 | 时间 + 手动 | 时间、上游完成、数据就绪事件 |
| 依赖 | 无，靠错开时间 | 简单父子任务 | DAG 内依赖 + 跨工作流依赖 |
| 时间语义 | 只有当前时间 | 只有当前时间 | 每个实例绑定一个业务日期 / 数据区间 |
| 补历史 | 手工改脚本 | 不支持 | 按日期范围批量生成实例（补数 / backfill） |
| 失败处理 | 无 | 重试、告警 | 重试、从失败节点恢复、下游自动等待 |
| 任务类型 | Shell | Java 方法（Bean / GLUE） | SQL、Spark、Flink、Shell、数据同步、HTTP、子流程等 |

Flink 流作业是常驻进程，不靠调度器周期拉起，部署方式见 [Flink 部署与运维](/flink/7_deployment)。

### 2、核心诉求

离线数仓每天要跑几十到几千个任务：先把业务库同步到 ODS，再逐层清洗、汇总，最后产出报表。这些任务有严格的先后顺序，要按"昨天的数据"计算，失败要重跑，历史数据有问题要补数，核心报表还要保证早上 8 点前产出。

- **依赖正确**：`dwd_trade_order_detail_inc` 必须等 `ods_order_info_inc` 同步完成才能跑，否则算出来的是半天的数据。靠"同步 1 点开始，清洗 2 点开始"这种错峰方式，一旦同步变慢就会静默产出错误结果
- **时间可回放**：任务逻辑由"业务日期"驱动，而不是读取系统当前时间，这样今天可以重算上个月任意一天
- **可重跑**：同一天的任务跑两次，结果与跑一次相同（第六节）
- **可观测**：哪个任务失败、核心报表是否按时产出、链路上最慢的是哪一步，都要能看到并告警

---

## 二、DAG 与依赖

### 1、工作流内的 DAG

![订单日报工作流的 DAG 与补数实例](../assets/big-data/scheduling-dag-backfill.svg)

一个工作流（Workflow）是一张有向无环图：节点是任务，边是"上游成功后才能运行下游"。上图上半部分是 `order_daily` 的依赖：ODS 同步 → DWD 明细 → 两张 DWS 汇总并行 → ADS 报表 → 写就绪标记。调度器按拓扑序执行，没有依赖关系的节点（两张 DWS）并行运行。

划分工作流的经验：

- **按主题和产出边界切分**：一个工作流对应一个业务主题的一段链路（如"订单主题日更"），20～50 个节点比较合适。把整个数仓塞进一张几百节点的大 DAG，任何一个节点改动都要重新发布整个流程，排查也困难
- **一个节点只产出一张表**：节点名和表名一致，失败时一眼能看出是哪张表没有产出，重跑粒度也最小
- **不要在 DAG 里成环**：A 依赖 B、B 又依赖 A 的"环"通常意味着表设计有问题，应该把公共部分拆成第三张表

### 2、跨工作流依赖

订单主题的 ADS 报表还依赖"用户主题"工作流产出的 `dim_user_zip`。两个工作流由不同团队维护、调度时间不同，不能合并成一张 DAG，这时用跨工作流依赖：

| 方式 | DolphinScheduler | Airflow 3 |
|------|------------------|-----------|
| 依赖另一个工作流的某个任务或整个工作流 | 依赖节点（Dependent），检查上游工作流 / 单个任务在某个周期内是否成功 | `ExternalTaskSensor`，等待另一个 DAG 中某个任务在对应逻辑日期成功 |
| 依赖"数据已产出"这一事件 | 上游写就绪标记，下游用依赖节点或 SQL / Shell 节点轮询 | Asset（2.x 中的 Dataset）：上游任务声明产出某个 Asset，下游 DAG 以 `schedule=[asset]` 触发 |

DolphinScheduler 依赖节点的要点：

- 依赖周期按自然周期对齐：日任务依赖小时任务时，可以选择"依赖上游当天全部 24 个实例成功"，周 / 月周期指整个自然周（周一至周日）或自然月
- 检查间隔默认 10 秒；上游失败时可选"失败"（本节点立即失败）或"等待"（在设定的等待时长内继续等）
- 多个依赖项之间可以组合"且 / 或"关系，例如"`dim_user_zip` 成功且 `dim_product_full` 成功"

依赖设计原则：**依赖产出，不依赖时间**。下游永远通过依赖节点或就绪事件确认上游完成，而不是假设"上游 3 点前一定跑完"。

---

## 三、数据时间与运行时间

### 1、两个时间

- **运行时间**：任务实际开始执行的墙钟时间，例如 `2026-10-10 02:00:13`
- **数据时间（业务日期，bizdate）**：这次运行负责计算哪一段数据，例如"2026-10-09 这一天的订单"

日更任务通常在每天凌晨运行、计算前一天的数据，两者相差一天。补数和重跑时差距更大：10 月 10 日重跑 10 月 1 日的任务，运行时间是 10 日，数据时间仍是 1 日。**任务里所有日期都必须来自数据时间参数**，SQL 里出现 `current_date()`、`now()`、Java 里出现 `LocalDate.now()` 都是隐患：今天能跑对，补数时就会算错。

### 2、DolphinScheduler 的时间参数

DolphinScheduler 每个实例都有一个"调度时间"（定时触发时就是触发时刻，补数时是所选的日期），内置参数基于它计算：

| 参数 | 含义 | 2026-10-10 02:00 触发时的值 |
|------|------|------------------------------|
| `${system.biz.date}` | 调度时间的前一天，`yyyyMMdd` | `20261009` |
| `${system.biz.curdate}` | 调度时间当天，`yyyyMMdd` | `20261010` |
| `${system.datetime}` | 调度时间，`yyyyMMddHHmmss` | `20261010020000` |
| `$[yyyy-MM-dd-1]` | 自定义格式，调度日期减 1 天 | `2026-10-09` |
| `$[add_months(yyyyMMdd,-1)]` | 调度日期减 1 个月 | `20260910` |
| `$[month_first_day(yyyy-MM-dd,-1)]` | 上个月第一天 | `2026-09-01` |

推荐在工作流全局参数里定义一个 `dt`，值为 `$[yyyy-MM-dd-1]`，所有节点统一引用 `${dt}`，不要每个节点各自写一遍时间表达式。

### 3、Airflow 3 的时间参数

Airflow 每个 DAG Run 有一个 `logical_date`（Airflow 2 里的 `execution_date` 在 3.0 中已从任务上下文移除）和一个数据区间 `data_interval_start` / `data_interval_end`。Airflow 3 有一处容易踩的默认值变化：

- `schedule="0 2 * * *"` 这类 cron 字符串在 3.0 起默认使用 `CronTriggerTimetable`：`logical_date` 等于触发时刻，数据区间的起止都是触发时刻，**不再自动表示"前一天"**
- Airflow 2 的默认行为是 `CronDataIntervalTimetable`：`logical_date` 等于数据区间起点，即"昨天 0 点"
- 想在 3.x 里得到"昨天"这个区间，可以给 `CronTriggerTimetable` 传 `interval=timedelta(days=1)`，此时数据区间为"触发时刻往前推 1 天"到"触发时刻"

另一个常见坑是时区：模板里的 `data_interval_start` 是带时区的时间（内部以 UTC 存储），北京时间 02:00 触发的运行，直接格式化 UTC 时间会得到前一天 18:00，日期差一天。生成业务日期前先转到业务时区（第七节示例）。

### 4、迟到数据

业务日期只是"逻辑上的一天"，真实数据可能迟到：凌晨 0 点 05 分才落库的 23:59 订单、第二天才回传的支付状态。常见处理：

- 调度时间留出缓冲：日任务在 01:00～02:00 之后再开始，而不是 00:00
- ODS 同步按"更新时间"而不是"创建时间"抽取，DWD 层按业务主键合并
- 对允许修正的指标，每天顺带重算最近 N 天的分区（滚动回刷），代价是计算量乘以 N

---

## 四、DolphinScheduler 3.x

### 1、架构

DolphinScheduler 是 Java 实现的分布式工作流调度平台，Apache 2.0 许可，提供可视化 DAG 编辑。主要组件：

| 组件 | 职责 |
|------|------|
| API Server | Web UI 与 REST API 的后端，负责项目、工作流定义、权限等管理操作 |
| Master Server | 生成工作流实例、解析 DAG、按依赖把任务分发给 Worker，多个 Master 去中心化分担工作流 |
| Worker Server | 执行具体任务（启动 Shell、提交 Spark / Flink、执行 SQL），按 Worker 分组隔离资源 |
| Alert Server | 接收告警事件并通过告警插件发送 |
| 注册中心 | Master / Worker 的注册与容错，默认 ZooKeeper，也可使用 etcd 或基于数据库的 JDBC 注册中心 |
| 元数据库 | MySQL 或 PostgreSQL，保存工作流定义、实例、任务状态 |

Master 或 Worker 宕机时，注册中心感知节点下线，其上的工作流 / 任务由其他节点接管（容错），这是它相对单机 crontab 和早期 Azkaban 的优势之一。

### 2、核心概念

| 概念 | 说明 |
|------|------|
| 项目（Project） | 权限与资源的组织单元，通常对应一个业务主题或团队 |
| 工作流定义 | DAG 的定义：节点、连线、全局参数、超时设置；修改会产生新版本 |
| 工作流实例 | 工作流定义的一次运行，绑定一个调度时间 |
| 任务定义 / 任务实例 | 单个节点的定义及其一次运行 |
| 定时（Schedule） | 工作流的触发规则，使用 Quartz 风格的 cron 表达式，如 `0 0 2 * * ? *`；新建后为下线状态，上线才生效 |
| 租户（Tenant） | Worker 以哪个 Linux 用户执行任务，用于隔离文件与权限 |
| Worker 分组 | 把任务限定在某组 Worker 上运行，例如"Spark 提交机"和"普通 Shell 机"分开 |
| 任务组（Task Group） | 跨工作流限制同类任务的并发数，例如"同时最多 5 个任务写 ClickHouse" |
| 环境 / 数据源 | 预先配置的环境变量与数据库连接，节点按名称引用，不在脚本里写密码 |

### 3、任务类型

| 类别 | 任务类型 | 典型用途 |
|------|----------|----------|
| 通用 | Shell、Python、Java、HTTP、gRPC | 调脚本、调接口、执行打包好的 Java 程序 |
| SQL | SQL、存储过程 | 在 Hive / Spark Thrift / MySQL / Doris / StarRocks 等数据源上执行 SQL |
| 计算引擎 | Spark、Flink、MapReduce、Hive CLI、EMR / 云 Serverless Spark | 提交批处理作业，Flink 节点适合提交批作业或一次性启动流作业 |
| 数据同步 | DataX、SeaTunnel、ChunJun、Sqoop | ODS 层抽取，见 [数据集成](./5_data_integration) |
| 逻辑控制 | 依赖（Dependent）、条件（Conditions）、分支（Switch）、子工作流（Sub Workflow） | 跨工作流依赖、按上游结果走不同分支、复用公共流程 |
| 容器 / 机器学习 | Kubernetes、Jupyter、MLflow、SageMaker 等 | 在集群中运行一次性容器、训练任务 |

任务类型以插件形式实现，具体列表以所用版本的文档为准。

### 4、一个 SQL 节点

`order_daily` 的 `dwd_trade_order_detail_inc` 节点使用 SQL 类型，数据源选 Spark Thrift Server（HiveServer2 协议），工作流全局参数定义 `dt = $[yyyy-MM-dd-1]`：

```sql
-- 节点：dwd_trade_order_detail_inc（SQL 任务，非查询类）
INSERT OVERWRITE TABLE dwd.dwd_trade_order_detail_inc PARTITION (dt = '${dt}')
SELECT o.order_id,
       o.user_id,
       o.shop_id,
       i.sku_id,
       i.quantity,
       i.pay_amount,
       o.pay_time,
       o.order_status
FROM ods.ods_order_info_inc o
JOIN ods.ods_order_item_inc i
  ON i.order_id = o.order_id AND i.dt = '${dt}'
WHERE o.dt = '${dt}'
  AND o.is_test = 0;
```

节点上还要设置：

- **失败重试**：重试次数 2～3 次、间隔几分钟，覆盖网络抖动、集群资源暂时不足这类瞬时故障；SQL 本身写错的问题重试不会好转，次数不宜过多
- **超时告警**：开启"超时告警"并按历史耗时的 2～3 倍设置时长，可选"超时失败"，避免任务卡住却没人知道
- **优先级**：核心链路设为 HIGH，资源紧张时优先被 Master 调度

### 5、工作流即代码

可视化编辑方便上手，但几百个工作流靠手工点选难以评审和回滚。DolphinScheduler 提供 Python SDK（PyPI 包 `apache-dolphinscheduler`），可以用 Python 定义工作流并提交，配合 Git 做代码评审；工作流定义也可以导出为 JSON 纳入版本管理。团队规模变大后，建议至少把核心链路纳入代码管理。

---

## 五、补数与重跑

### 1、补数（Complement）

补数就是"对一段历史日期，每天生成一个工作流实例并运行"。典型场景：新上线一张表需要初始化最近 90 天的数据；上游数据修复后，下游要重算受影响的日期。

在工作流定义上点击"运行"，勾选补数，关键参数：

| 参数 | 说明 |
|------|------|
| 运行模式 | 串行：按日期逐个执行，前一天跑完再跑下一天；并行：多个日期同时执行 |
| 并行度 | 并行模式下同时运行的实例上限，例如 5 天数据、并行度 2，每次 2 个实例 |
| 依赖模式 | 是否同时补直接依赖本工作流的下游工作流（下游需已上线定时） |
| 调度日期 | 页面选择日期范围，或手动输入逗号分隔的多个日期 |

上图下半部分演示了并行度 2 的补数。有两个要点：

- **所选日期是调度时间，不是业务日期**：节点使用 `${system.biz.date}` 或 `$[yyyy-MM-dd-1]` 时，选择 10-01 实际计算的是 09-30。要补 10-01～10-05 的数据，应选择 10-02～10-06。这个错误非常常见，补完一定抽查分区
- **串行还是并行**：任务之间有"跨天依赖"（例如累计值、拉链表依赖前一天的结果）必须串行；每天独立的任务可以并行，但并行度要按集群余量设置，补 90 天、并行度 30 足以把一个共享集群打满，影响当天的正常调度

已配置定时的工作流，补数会按定时规则在所选范围内生成实例；例如每小时触发的工作流补一天，会生成 24 个实例。

### 2、重跑与恢复

工作流实例上的常用操作：

| 操作 | 适用状态 | 行为 |
|------|----------|------|
| 重跑 | 已结束（成功 / 失败 / 停止） | 整个实例的所有节点重新执行一遍 |
| 恢复失败 | 失败 | 从失败的节点开始继续执行，已成功的节点不再运行 |
| 暂停 / 恢复暂停 | 运行中 / 已暂停 | 暂停等待正在执行的节点结束、不再启动新节点；恢复后从暂停处继续 |
| 停止 | 运行中 | 杀掉正在运行的任务进程 |
| 编辑实例 | 已结束 | 修改本次实例的节点后重跑，可选择是否同步回工作流定义 |

此外，在工作流定义中选中某个节点运行时，可以选择只运行该节点、向后（运行它及所有下游）或向前（运行它及所有上游）执行，用于"只修了 DWS 某张表，重算它和下游 ADS"的场景。

所有重跑、恢复操作的前提都是任务幂等：如果 `dwd_trade_order_detail_inc` 用 `INSERT INTO` 追加写，"恢复失败"之前已经写了一半的数据就会重复。

### 3、Airflow 的 backfill

Airflow 3.0 起，backfill 由调度器统一管理，可以在 UI、REST API 或 CLI 中创建，并能在 UI 中暂停或取消，不再依赖一个长时间运行的命令行进程：

```bash
airflow backfill create --dag-id order_daily \
    --from-date 2026-10-01 \
    --to-date 2026-10-05 \
    --reprocess-behavior failed \
    --max-active-runs 2
```

`--reprocess-behavior` 决定已存在的运行如何处理：`none` 只补缺失的日期，`failed` 额外重跑失败的日期，`completed` 全部重跑。`--max-active-runs` 是本次补数的并发上限，与 DAG 自身的 `max_active_runs` 相互独立；`--run-backwards` 可以从最近的日期往前补。Airflow 3 中 DAG 的 `catchup` 默认值改为 `False`，DAG 上线后不会自动补跑 `start_date` 以来的历史区间，需要时显式开启或手动创建 backfill。

---

## 六、幂等任务与分区覆盖

### 1、原则

数据任务的幂等指：**同一个业务日期，任务执行一次和执行 N 次，输出完全相同**。做到这一点有三条规则：

1. **输出只由业务日期和输入数据决定**：所有时间来自参数，不读系统时间、不依赖"上一次运行留下的状态"
2. **按分区整体覆盖写**：一次运行负责一个（或一组确定的）分区，写入方式是"覆盖该分区"，而不是追加
3. **外部副作用可去重**：写 MySQL、发消息、调接口这类调度器无法回滚的操作，要以业务日期作为去重键

### 2、数仓表：INSERT OVERWRITE

Hive / Spark SQL 的静态分区覆盖已经在第四节示例中出现：`INSERT OVERWRITE TABLE ... PARTITION (dt = '${dt}')` 会先清空该分区再写入，跑几次结果都一样。

需要按数据内容写多个分区时（例如回刷最近 3 天），用动态分区覆盖。对 Spark 数据源表（`USING parquet` 等），要把覆盖模式设为 `dynamic`，否则默认的 `static` 模式会先删除与 `PARTITION (dt)` 匹配的全部分区，也就是整张表：

```sql
SET spark.sql.sources.partitionOverwriteMode = dynamic;

INSERT OVERWRITE TABLE dws.dws_trade_shop_order_1d PARTITION (dt)
SELECT shop_id,
       SUM(pay_amount)          AS gmv,
       COUNT(DISTINCT order_id) AS order_cnt,
       dt
FROM dwd.dwd_trade_order_detail_inc
WHERE dt BETWEEN date_sub('${dt}', 2) AND '${dt}'
GROUP BY shop_id, dt;
```

`dynamic` 模式只覆盖查询结果中实际出现的分区。注意它的反面：如果某天上游没有数据，该分区不会被清空，旧数据会残留。湖格式表（Iceberg / Paimon / Hudi）的覆盖语义略有不同，见 [数据湖与湖仓](./4_lakehouse)。

### 3、OLAP 表：分区覆盖或主键 UPSERT

ADS 结果写入 Doris / StarRocks 供查询时，两种幂等写法：

```sql
-- 方式一：按日期分区覆盖（Doris 语法；StarRocks 写作 INSERT OVERWRITE ads.ads_trade_gmv_1d PARTITION (...)，不带 TABLE）
INSERT OVERWRITE TABLE ads.ads_trade_gmv_1d PARTITION (p20261009)
SELECT tenant_id, dt, channel, province, gmv, order_cnt, buyer_cnt
FROM dws_external.dws_trade_province_order_1d
WHERE dt = '2026-10-09';

-- 方式二：ads_trade_gmv_1d 建为主键模型表，重复写入同一主键即覆盖
INSERT INTO ads.ads_trade_gmv_1d
SELECT tenant_id, dt, channel, province, gmv, order_cnt, buyer_cnt
FROM dws_external.dws_trade_province_order_1d
WHERE dt = '2026-10-09';
```

分区覆盖在一个事务内替换整个分区，查询方要么看到旧数据、要么看到新数据，不会看到一半；主键 UPSERT 无法删除"这次没出现、上次出现过"的行（例如某个渠道当天被下线），需要配合按日期先删除。分区名要与日期一致（如 `p20261009`），在节点中用 `$[yyyyMMdd-1]` 拼接。

### 4、写回业务库

把 ADS 结果回写 MySQL 供业务系统使用时，在一个事务内先删后插：

```sql
START TRANSACTION;
DELETE FROM report_shop_daily WHERE stat_date = '2026-10-09';
INSERT INTO report_shop_daily (stat_date, shop_id, gmv, order_cnt)
SELECT ...;   -- 由同步工具或程序批量写入
COMMIT;
```

数据量大时用"写临时表 → `RENAME TABLE` 原子交换"代替大事务。推送消息、发送日报邮件这类操作，在发送记录表里以 `(任务名, 业务日期)` 作为唯一键，重跑时先查后发，详细的幂等设计见 [幂等设计](/architecture/5_idempotence)。

### 5、常见的非幂等写法

| 写法 | 问题 | 改法 |
|------|------|------|
| `INSERT INTO` 追加写分区表 | 重跑后数据翻倍 | `INSERT OVERWRITE` 指定分区 |
| `WHERE dt = date_sub(current_date(), 1)` | 补数时永远算"昨天" | 改用调度参数 `${dt}` |
| 增量任务读"上次运行的最大 ID" | 重跑时增量范围变化 | 按业务日期或更新时间范围读取 |
| 全量表每天 `TRUNCATE` 再写 | 写入中途失败时下游读到空表 | 写入新分区或临时表后切换 |
| 一个节点写多张表 | 部分成功后无法单独重跑 | 拆成一个节点一张表 |

---

## 七、Airflow 3 对比

### 1、Airflow 3 的变化

Airflow 是 Python 生态的工作流平台，DAG 用 Python 代码定义。3.0 于 2025 年 4 月发布，是一次大版本重构，当前最新为 3.3.x（2026 年 9 月发布 3.3.2）。与写 DAG 直接相关的变化：

- **Task SDK**：DAG 作者使用 `airflow.sdk` 包中的接口（`DAG`、`dag`、`task`、`Asset` 等），任务通过 Task Execution API 与调度器通信，**任务代码不能再直接访问 Airflow 元数据库**
- **Asset**：2.x 的 Dataset 更名为 Asset，支持基于数据产出触发下游；3.3 加入了资产分区（asset partitioning）
- **DAG 版本管理**：UI 中能看到每次运行对应的 DAG 代码版本
- **调度器托管的 backfill**、**`catchup` 默认 `False`**、**cron 字符串默认 `CronTriggerTimetable`**（见前文）
- **SLA 功能移除**：2.x 的 `sla` 参数与 `sla_miss_callback` 在 3.0 中删除，3.1 引入替代方案 Deadline Alerts（3.1 中为实验特性）

### 2、同一条链路的 Airflow 写法

```python
from datetime import datetime, timedelta

from airflow.providers.common.sql.operators.sql import SQLExecuteQueryOperator
from airflow.sdk import DAG
from airflow.timetables.trigger import CronTriggerTimetable


def biz_date(interval_start):
    # 先转到业务时区再取日期，避免 UTC 导致的日期偏移
    return interval_start.in_timezone("Asia/Shanghai").strftime("%Y-%m-%d")


with DAG(
    dag_id="order_daily",
    schedule=CronTriggerTimetable(
        "0 2 * * *", timezone="Asia/Shanghai", interval=timedelta(days=1)
    ),
    start_date=datetime(2026, 10, 1),
    catchup=False,
    max_active_runs=1,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    user_defined_macros={"biz_date": biz_date},
    template_searchpath=["/opt/airflow/sql"],
    tags=["dw", "order"],
):
    dwd = SQLExecuteQueryOperator(
        task_id="dwd_trade_order_detail_inc",
        conn_id="spark_thrift",          # HiveServer2 类型连接，指向 Spark Thrift Server
        sql="dwd_trade_order_detail_inc.sql",
    )
    dws_user = SQLExecuteQueryOperator(
        task_id="dws_trade_user_order_1d", conn_id="spark_thrift", sql="dws_trade_user_order_1d.sql"
    )
    dws_sku = SQLExecuteQueryOperator(
        task_id="dws_trade_sku_order_1d", conn_id="spark_thrift", sql="dws_trade_sku_order_1d.sql"
    )
    ads = SQLExecuteQueryOperator(
        task_id="ads_trade_gmv_1d", conn_id="spark_thrift", sql="ads_trade_gmv_1d.sql"
    )

    dwd >> [dws_user, dws_sku] >> ads
```

SQL 文件中用 `{{ biz_date(data_interval_start) }}` 引用业务日期，例如 `PARTITION (dt = '{{ biz_date(data_interval_start) }}')`。`SQLExecuteQueryOperator` 来自 `apache-airflow-providers-common-sql`，连接 Spark Thrift Server 还需要安装 Hive provider。

### 3、对比与选型

| 维度 | DolphinScheduler 3.4 | Airflow 3.3 |
|------|----------------------|-------------|
| 语言生态 | Java，部署和二次开发对 Java 团队友好 | Python，DAG 与扩展都是 Python |
| 定义方式 | 可视化拖拽为主，Python SDK / JSON 导出为辅 | 代码为主，天然纳入 Git 与 CI |
| 补数 | UI 选日期范围，串行 / 并行，可连带下游 | 调度器托管 backfill，UI / API / CLI，按已有运行状态决定是否重跑 |
| 跨流程依赖 | 依赖节点，按周期配置 | `ExternalTaskSensor`、Asset 事件驱动 |
| 多租户与权限 | 项目、租户、Worker 分组、数据源授权，内置较完整 | RBAC 由认证管理器提供，多团队隔离需要额外设计 |
| 任务生态 | 内置 SQL / Spark / Flink / DataX / SeaTunnel 等插件 | Provider 生态庞大，覆盖各类云服务 |
| 告警 | 告警组 + 邮件、钉钉、企业微信、飞书、Slack、Telegram、HTTP、脚本等插件 | 回调函数 + Notifier，Deadline Alerts |
| 适合团队 | 国内数据平台、Java 后端主导、需要给分析师用 UI 配置 | 数据工程团队以 Python 为主、追求代码化与云服务集成 |

两者都能胜任离线数仓调度，选型更多取决于团队语言和使用者：需要业务分析师自己在界面上配置 SQL 任务，DolphinScheduler 更顺手；团队习惯代码评审、CI 校验 DAG，Airflow 更自然。

---

## 八、失败告警与 SLA 监控

### 1、告警的层次

| 层次 | 关注什么 | 手段 |
|------|----------|------|
| 任务失败 | 节点重试用尽仍失败 | 工作流运行时的通知策略选"失败时发送"，绑定告警组 |
| 任务超时 | 节点运行时间超出预期 | 节点超时告警（可设超时即失败），工作流级超时 |
| 依赖等待 | 上游迟迟没有完成 | 依赖节点设置等待时长，超时后失败并告警 |
| 产出时间（SLA） | 核心表是否在约定时间前产出 | 独立的产出检查 + 预警，见下文 |
| 平台自身 | Master / Worker 存活、任务积压 | 采集调度器暴露的指标接入 Prometheus，见 [告警体系](/observability/4_alerting) |

告警要分级：核心链路失败打电话或即时消息并 @ 值班人，非核心任务汇总成日报。所有任务失败都推到一个群里，最终的结果是没人看。

### 2、产出 SLA

业务真正关心的不是"某个任务失败了"，而是"8 点的经营日报能不能按时出来"。SLA 监控的做法：

- **定义保障对象**：只为少数核心 ADS 表定义承诺时间，例如 `ads_trade_gmv_1d` 每天 07:30 前产出
- **识别关键路径**：从该表沿依赖向上找到所有祖先任务，这些任务都纳入保障，优先级设为最高；链路上任何一个任务的延迟都会传导到终点
- **预警而非事后告警**：根据各任务历史耗时推算"最晚开始时间"，例如 DWD 节点必须在 05:00 前开始，否则 07:30 一定来不及。到了预警点上游还没完成，就提前通知值班人介入，而不是等 07:30 才发现
- **独立的产出检查**：在调度器外（或用一个独立的检查工作流）定时查询就绪标记表，到点没有当天记录就告警。这样即使调度器本身故障、整条链路根本没有被触发，也能发现问题

就绪标记可以是一张简单的表：

```sql
CREATE TABLE dw_meta.data_ready (
    table_name  VARCHAR(128) NOT NULL,
    biz_date    DATE         NOT NULL,
    ready_time  DATETIME     NOT NULL,
    row_count   BIGINT       NOT NULL,
    PRIMARY KEY (table_name, biz_date)
);
```

ADS 节点成功后写入一行（重跑时用 `REPLACE INTO` 或 `INSERT ... ON DUPLICATE KEY UPDATE` 保持幂等），下游的查询服务、缓存失效、数据推送都以这张表为准，下一篇的报表缓存会用到它。`row_count` 还可以做最简单的质量校验：今天的行数比过去 7 天均值低 50%，大概率是上游数据缺失，应拦截而不是对外发布，完整的质量规则见 [数据治理](./8_governance)。

Airflow 中可以用 3.1 起的 Deadline Alerts 为 DAG Run 配置"相对排队时间或逻辑日期的截止时长"并触发回调；DolphinScheduler 中用工作流 / 节点超时告警结合上述独立检查。

---

## 小结

- 数据任务调度关注依赖、数据时间、补数和重跑，与业务定时任务是两类系统；业务定时任务见 [分布式调度](/distributed/6_job_scheduler)
- 工作流按主题切分，一个节点产出一张表；跨工作流用依赖节点、Sensor 或就绪事件，依赖产出而不是依赖时间
- 所有日期来自业务日期参数：DolphinScheduler 的 `${system.biz.date}` / `$[yyyy-MM-dd-1]` 基于调度时间计算；Airflow 3 的 cron 字符串默认使用 `CronTriggerTimetable`，需要 `interval` 或显式计算才能得到"前一天"，并注意 UTC 时区
- DolphinScheduler 补数支持串行 / 并行与连带下游，所选日期是调度时间；恢复失败从失败节点继续；Airflow 3 的 backfill 由调度器托管，`catchup` 默认关闭
- 幂等是重跑与补数的前提：按分区覆盖写、Spark 多分区覆盖用 `dynamic` 模式、写回业务库先删后插、外部副作用以业务日期去重
- 告警分级，核心报表按产出时间定义 SLA，沿关键路径提前预警，并用调度器之外的就绪检查兜底

## 参考资料

- DolphinScheduler 官方文档：[Apache DolphinScheduler Documentation](https://dolphinscheduler.apache.org/en-us/docs)
- DolphinScheduler 工作流定义、运行参数与补数：[Workflow Definition](https://github.com/apache/dolphinscheduler/blob/dev/docs/docs/en/guide/project/workflow-definition.md)
- DolphinScheduler 工作流实例操作：[Workflow Instance](https://github.com/apache/dolphinscheduler/blob/dev/docs/docs/en/guide/project/workflow-instance.md)
- DolphinScheduler 内置参数与时间格式：[Built-in Parameter](https://github.com/apache/dolphinscheduler/blob/dev/docs/docs/en/guide/parameter/built-in.md)
- DolphinScheduler 依赖节点：[Dependent Node](https://github.com/apache/dolphinscheduler/blob/dev/docs/docs/en/guide/task/dependent.md)
- DolphinScheduler 版本发布：[DolphinScheduler Releases](https://github.com/apache/dolphinscheduler/releases)
- Airflow 3 升级指南：[Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)
- Airflow Backfill：[Backfill](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/backfill.html)
- Airflow Timetable：[Timetables](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/timetable.html)
- Airflow 版本说明：[Airflow Release Notes](https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html)
- Airflow Deadline Alerts 设计：[AIP-86 Deadline Alerts](https://cwiki.apache.org/confluence/spaces/AIRFLOW/pages/323488182/AIP-86+Deadline+Alerts+Formerly+SLA)
- Spark 动态分区覆盖配置：[Spark SQL Configuration](https://spark.apache.org/docs/latest/configuration.html#runtime-sql-configuration)

> 下一篇：[OLAP 查询与数据服务](./7_olap_service)

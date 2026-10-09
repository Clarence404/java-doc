---
description: 重复执行、ShedLock、分片与错过触发、幂等、XXL-JOB、ElasticJob、PowerJob
---

# 分布式调度

> **本篇目标**：理解多实例部署后定时任务会遇到的问题（重复执行、单点、任务量过大），掌握「只执行一次、分片、错过触发、阻塞与超时、幂等」这些核心概念，能在 ShedLock、Quartz 集群、XXL-JOB、ElasticJob、PowerJob 与数据工作流调度器之间做选型。
>
> **前置阅读**：[分布式锁](./3_lock)

单实例内的定时任务（`@Scheduled`、`ScheduledThreadPoolExecutor`）见 [异步任务与定时任务](/spring-boot/9_async_schedule)，本篇只讲多实例与调度平台。

---

## 一、多实例下的定时任务问题

应用部署三个实例，每个实例里的 `@Scheduled` 都会按时触发，同一任务被执行三次。随之而来的问题：

| 问题 | 表现 |
|------|------|
| 重复执行 | 重复发券、重复对账、重复推送 |
| 无法分摊 | 一个实例处理全部数据，其他实例空闲，任务越来越慢 |
| 不可观测 | 没有统一的执行记录、失败告警、手动重跑入口 |
| 改配置要发版 | Cron 写在代码里，调整时间需要重新部署 |

按需求从轻到重有几种解法：

| 方案 | 做法 | 适合 |
|------|------|------|
| ShedLock | `@Scheduled` 照旧，执行前抢一把锁（DB / Redis / ZooKeeper），抢到的实例执行 | 已有少量定时任务，只需防重复 |
| Quartz 集群 | JDBC JobStore 共享数据库，靠 `QRTZ_LOCKS` 表的行锁保证一次触发只由一个节点执行，节点故障时其他节点接管 | 不想引入额外服务，需要持久化与故障转移 |
| Kubernetes CronJob | 由 K8s 按 Cron 启动一个 Pod 执行任务后退出 | 批处理脚本、与业务进程解耦的任务 |
| 调度平台 | XXL-JOB、ElasticJob、PowerJob：控制台配置、分片、重试、告警、日志 | 任务多、需要分片与运维能力 |

ShedLock 示例：

```java
@Configuration
@EnableScheduling
@EnableSchedulerLock(defaultLockAtMostFor = "PT30M")
public class SchedulingConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(JdbcTemplateLockProvider.Configuration.builder()
                .withJdbcTemplate(new JdbcTemplate(dataSource))
                .usingDbTime()                     // 用数据库时间，避免各实例时钟不一致
                .build());
    }
}

@Component
public class ReportJob {

    @Scheduled(cron = "0 0 2 * * *")
    @SchedulerLock(name = "dailyReport", lockAtMostFor = "PT30M", lockAtLeastFor = "PT1M")
    public void dailyReport() {
        // 只会在抢到锁的实例上执行
    }
}
```

`lockAtMostFor` 是锁的最长持有时间，必须大于任务的正常耗时，否则任务没跑完锁就过期、别的实例又开始执行；`lockAtLeastFor` 防止各实例时钟略有偏差时，任务很快跑完后另一个实例在同一周期内再次触发。ShedLock 属于效率锁，任务本身仍应幂等（见 [分布式锁](./3_lock)）。

---

## 二、核心概念

### 1、只执行一次

调度平台通常由「调度中心」决定何时触发、交给哪个执行器，执行器只负责执行。调度中心自身多实例时，要保证同一次触发只被一个调度实例发出（XXL-JOB 用数据库行锁，ElasticJob 用 ZooKeeper 选主）。

### 2、路由策略

单个执行器执行时，调度中心按路由策略挑选实例：第一个、轮询、随机、一致性哈希（同一任务固定到同一实例）、最不经常使用、故障转移（依次探测直到找到健康实例）、忙碌转移等。

### 3、分片

数据量大的任务拆给多个实例并行处理。调度中心把 `shardIndex`（本实例序号）与 `shardTotal`（实例总数）传给每个执行器，执行器只处理属于自己的数据，例如 `WHERE id % #{shardTotal} = #{shardIndex}`。实例数变化时分片自动重新分配。

### 4、错过触发（Misfire）

调度中心停机、线程不够或上一次还没执行完，都可能让某次触发错过。常见处理策略：

- **忽略**：错过就算了，等下一次
- **立即补一次**：恢复后马上执行一次，之后按正常节奏
- **全部补齐**：把错过的每一次都执行（Quartz 的部分策略），任务要能承受

### 5、阻塞策略与超时

上一次还没执行完，新一次又到了：单机串行（排队）、丢弃后续调度、覆盖之前调度（中断旧的）。同时给任务设置超时时间，避免卡死的任务一直占用执行线程。

### 6、重试与幂等

调度平台的失败重试、故障转移、人工重跑都会让同一批数据被处理多次，**任务必须幂等**：按业务键去重、用状态机推进、或写入时依赖唯一约束，见 [幂等设计](/architecture/5_idempotence)。

### 7、调度系统自身的高可用

调度中心多实例部署、元数据存在高可用数据库中；执行器多实例并注册到调度中心。调度中心不可用时任务不会执行，要监控「应触发未触发」并告警。

---

## 三、XXL-JOB

XXL-JOB 是许雪里（xuxueli）开源的轻量级分布式调度平台，国内使用最广。3.x 要求 JDK 17+（截至 2026 年 6 月最新为 3.4.2），主干分支已升级到 Spring Boot 4。

![XXL-JOB 调度架构](../assets/distributed/xxl-job-arch.svg)

- **调度中心**（xxl-job-admin）：多实例共享一个 MySQL；早期版本基于 Quartz，2.1.0 起替换为自研调度：用 `xxl_job_lock` 表的行锁保证同一时刻只有一个实例扫描到期任务，再用时间轮精确触发
- **执行器**：嵌入业务应用，启动后向调度中心注册并定时心跳，接收调度中心的 HTTP 触发请求执行任务，结果异步回调
- **能力**：Cron / 固定频率、路由策略、分片广播、阻塞策略、超时、失败重试、告警、GLUE 在线脚本、任务依赖

执行器代码：

```java
@Component
@RequiredArgsConstructor
public class OrderSyncJob {

    private final OrderSyncService orderSyncService;

    @XxlJob("orderSyncJob")
    public void orderSyncJob() {
        int shardIndex = XxlJobHelper.getShardIndex();
        int shardTotal = XxlJobHelper.getShardTotal();
        int count = orderSyncService.syncShard(shardIndex, shardTotal);   // 只处理 id % total == index 的数据，且幂等
        XxlJobHelper.log("shard {}/{} synced {}", shardIndex, shardTotal, count);
        XxlJobHelper.handleSuccess();
    }
}
```

执行器通过 `XxlJobSpringExecutor` Bean 配置调度中心地址、`appname`、`accessToken` 和日志目录。`accessToken` 务必设置，调度中心与执行器之间的通信不要暴露到公网。

---

## 四、其他调度框架

### 1、Quartz

Java 老牌调度库（当前 2.5.x），提供 Trigger / Job / Scheduler 模型、Cron 与日历调度、Misfire 策略。它是**库**而不是平台：没有控制台，集群靠 JDBC JobStore + 数据库行锁实现故障转移，但不支持分片。Spring Boot 有 `spring-boot-starter-quartz`。ElasticJob-Lite 内部也使用 Quartz 做本地触发。

### 2、Apache ShardingSphere ElasticJob

由当当网开源，后捐献给 Apache，成为 ShardingSphere 的子项目。ElasticJob-Lite 是去中心化的：没有独立的调度中心，各实例通过 ZooKeeper 选主与分配分片，Quartz 负责本地触发；以「弹性分片」为核心，实例增减时自动重新分片。ElasticJob-Cloud 已停止维护。项目发布节奏较慢（3.0.x），新项目选用前确认社区活跃度。

### 3、PowerJob

社区开源项目（原名 OhMyScheduler，由个人开发者发起，后成立 PowerJob 组织），当前 5.x。特点是支持 MapReduce 式的分布式计算任务和 DAG 工作流，执行器与服务端之间支持多种通信协议，调度服务器可水平扩展。适合需要「大任务拆小任务并行计算」或任务依赖编排的场景。

---

## 五、数据工作流调度

另一类调度器面向数据工程：以 DAG 编排 ETL、Spark、Flink、SQL 等任务，关注依赖、补数与回溯，而不是业务应用里的定时任务。

| 工具 | 说明 |
|------|------|
| Apache DolphinScheduler | Java 实现，可视化 DAG 设计，Master / Worker 去中心化架构，任务类型丰富，国内数据平台常用 |
| Apache Airflow | Python 生态，DAG 以代码定义，Airflow 3.0（2025 年 4 月）重构了任务执行接口与 UI，数据工程领域事实标准 |
| Azkaban | LinkedIn 早期的 Hadoop 批处理调度器，已多年没有实质更新，新项目不建议选用 |

业务定时任务不要放进数据工作流调度器，反之亦然。Flink 流式作业的部署与调度见 [Flink 总览](/flink/0_overview)。

---

## 六、对比与选型

| 框架 | 架构 | 分片 | 控制台 | 依赖 | 适合 |
|------|------|------|--------|------|------|
| ShedLock | 库，锁防重复 | 不支持 | 无 | DB / Redis | 少量 `@Scheduled` 任务防重复 |
| Quartz 集群 | 库，DB 行锁 | 不支持 | 无 | DB | 需要持久化与故障转移，不想引入新服务 |
| XXL-JOB | 中心化调度中心 + 执行器 | 分片广播 | 有 | MySQL | 业务定时任务的通用选择 |
| ElasticJob-Lite | 去中心化 | 弹性分片 | 可选 | ZooKeeper | 已有 ZooKeeper、重分片需求强 |
| PowerJob | 中心化，服务端可扩展 | MapReduce | 有 | DB | 分布式计算任务、任务依赖 |
| DolphinScheduler / Airflow | DAG 工作流 | 不适用 | 有 | DB 等 | 数据管道、ETL |

选型建议：

- 只有几个定时任务、主要问题是重复执行 → ShedLock
- 任务多、需要控制台、告警、分片 → XXL-JOB
- 需要把大任务拆成大量子任务计算 → PowerJob
- 数据仓库、ETL 依赖编排 → DolphinScheduler 或 Airflow
- 无论哪种，任务都要幂等、有超时，并监控「未按时触发」

---

## 小结

- 多实例下 `@Scheduled` 会重复执行；轻量解法是 ShedLock 或 Quartz 集群，任务多时用调度平台
- 核心概念：只执行一次、路由、分片、错过触发、阻塞与超时、重试与幂等、调度系统自身高可用
- XXL-JOB 2.1.0 起不再依赖 Quartz，用 `xxl_job_lock` 行锁 + 时间轮调度；3.x 要求 JDK 17
- ElasticJob 来自当当网，现为 Apache ShardingSphere 子项目；PowerJob 是社区项目，擅长 MapReduce 与工作流
- 数据工作流调度（DolphinScheduler、Airflow）与业务定时任务是两类工具

## 参考资料

- XXL-JOB 文档：[https://www.xuxueli.com/xxl-job/](https://www.xuxueli.com/xxl-job/)
- XXL-JOB GitHub：[https://github.com/xuxueli/xxl-job](https://github.com/xuxueli/xxl-job)
- Quartz Scheduler：[https://www.quartz-scheduler.org/](https://www.quartz-scheduler.org/)
- Apache ShardingSphere ElasticJob：[https://shardingsphere.apache.org/elasticjob/](https://shardingsphere.apache.org/elasticjob/)
- ElasticJob GitHub：[https://github.com/apache/shardingsphere-elasticjob](https://github.com/apache/shardingsphere-elasticjob)
- PowerJob GitHub：[https://github.com/PowerJob/PowerJob](https://github.com/PowerJob/PowerJob)
- ShedLock：[https://github.com/lukas-krecan/ShedLock](https://github.com/lukas-krecan/ShedLock)
- Kubernetes CronJob：[https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- Apache DolphinScheduler：[https://dolphinscheduler.apache.org/](https://dolphinscheduler.apache.org/)
- Apache Airflow：[https://airflow.apache.org/](https://airflow.apache.org/)

> 下一篇：[工作流引擎](./7_work_flow) —— BPMN 审批流引擎与持久化执行引擎，Flowable、Camunda、Apache KIE 与 Temporal 的现状与选型。

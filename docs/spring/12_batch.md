---
description: Chunk 读写、Tasklet、流程控制、重启语义、分区扩展、监控、Batch 6 变化
---

# Spring Batch 批处理

> 前置阅读：[事务管理](./4_transaction)

Spring Batch 处理「大量数据、离线、可中断可恢复」的任务，只负责把批处理执行得可靠、可观测、可重启，不负责调度。本篇基于 Spring Boot 4（Spring Batch 6），讲 Job / Step / Chunk 模型、JDBC 作业仓库、跳过 / 重试 / 重启，以及多线程与分区扩展。

---

## 一、核心模型

### 1、架构

![Spring Batch 架构](../assets/spring/spring_batch_arch.svg)

| 组件 | 说明 |
|------|------|
| `Job` | 批处理作业，由一个或多个 `Step` 组成 |
| `Step` | 作业步骤：Chunk 步骤（读-处理-写）或 Tasklet 步骤（单个动作） |
| `ItemReader` | 逐条读取数据（DB / CSV / JSON / MQ） |
| `ItemProcessor` | 校验、转换、过滤（可选） |
| `ItemWriter` | 按批写入（DB / 文件 / 外部系统） |
| `JobRepository` | 记录作业与步骤的执行状态，是重启的依据；6.0 起同时承担原 `JobExplorer` 的查询职责 |
| `JobOperator` | 启动、停止、重启、恢复作业；6.0 起继承 `JobLauncher`，取代后者成为唯一入口 |

### 2、Chunk 处理模型

每次读取 `chunkSize` 条 → 逐条处理 → 整批写入，**一个 chunk 一个事务**。写入成功后提交事务，并把读取进度（如已读行数）写入 `ExecutionContext`；失败时回滚当前 chunk，之前已提交的 chunk 不受影响。chunk 大小决定了事务粒度、内存占用和失败重做量，常见取值 100～1000。

### 3、JobInstance 与 JobExecution

| 概念 | 含义 |
|------|------|
| `JobInstance` | 作业名 + **标识性参数**（identifying parameters）确定的一次逻辑运行，如「2026-10-08 的对账」 |
| `JobExecution` | 对某个 `JobInstance` 的一次物理执行；失败后重启会产生新的 `JobExecution`，但属于同一个 `JobInstance` |
| `StepExecution` | 某个 Step 的一次执行，记录读、写、过滤、跳过、提交、回滚次数 |
| `ExecutionContext` | 随每次 chunk 提交持久化的键值对，保存读取位置等断点信息 |

这些状态都由 `JobRepository` 管理。用 JDBC 存储时落在 `BATCH_JOB_INSTANCE`、`BATCH_JOB_EXECUTION`、`BATCH_STEP_EXECUTION` 等元数据表中。

---

## 二、依赖与配置

### 1、Boot 4 的两个 starter

| starter | 作业仓库 | 适用 |
|---------|---------|------|
| `spring-boot-starter-batch` | 内存 / Resourceless，不持久化任何状态 | 一次性脚本、无需重启的简单任务 |
| `spring-boot-starter-batch-jdbc` | JDBC，元数据写入数据库，自动初始化建表 | **生产环境**：需要重启、防重复执行、执行历史 |

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-batch-jdbc</artifactId>
</dependency>
<!-- 业务写库用 JdbcBatchItemWriter 即可，不需要 JPA；再加上数据库驱动 -->
<dependency>
    <groupId>com.mysql</groupId>
    <artifactId>mysql-connector-j</artifactId>
    <scope>runtime</scope>
</dependency>
```

```yaml
spring:
  batch:
    job:
      enabled: false              # 启动时不自动运行 Job（默认 true；多个 Job 时需配合 spring.batch.job.name）
    jdbc:
      initialize-schema: never    # 默认 embedded：只对内嵌库自动建表；生产用 Flyway 管理元数据表
      table-prefix: BATCH_
```

> Boot 3.x 只有一个 `spring-boot-starter-batch`，默认就是 JDBC 仓库，需要 DataSource。Spring Batch 元数据表的建表脚本随 `spring-batch-core` 发布（按数据库区分的 `schema-*.sql`），可拷进 Flyway 迁移脚本。

### 2、陷阱：不要加 `@EnableBatchProcessing`

在 Spring Boot 中加 `@EnableBatchProcessing`（或继承 `DefaultBatchConfiguration`），**Boot 的批处理自动配置会整体退让**：

- `spring.batch.*` 配置全部失效，包括 `job.enabled` 与 `jdbc.initialize-schema`，元数据表不会被创建
- Spring Batch 6 中 `@EnableBatchProcessing` 不再绑定 JDBC，单独使用时得到的是 **Resourceless 作业仓库**：什么都不持久化，重启和防重复执行全部失效，而且没有任何报错

结论：Boot 项目直接依赖自动配置。确实需要完全手动控制时，再显式组合注解，并改用注解属性而不是配置项：

```java
@Configuration
@EnableBatchProcessing(taskExecutorRef = "batchTaskExecutor")
@EnableJdbcJobRepository(dataSourceRef = "batchDataSource",
                         transactionManagerRef = "batchTransactionManager")
public class ManualBatchConfig {
}
```

作业元数据想放在独立数据源时，Boot 方式是在对应 Bean 上标 `@BatchDataSource` / `@BatchTransactionManager`，不需要关闭自动配置。

### 3、Batch 6 包路径迁移

从 Boot 3（Batch 5）升级到 Boot 4（Batch 6）时最常见的编译错误来自包路径调整：

| 类 | Batch 5 | Batch 6 |
|----|---------|---------|
| `Job`、`JobExecution`、`JobInstance` | `org.springframework.batch.core` | `org.springframework.batch.core.job` |
| `JobParameters`、`JobParametersBuilder`、`RunIdIncrementer` | `org.springframework.batch.core`（`RunIdIncrementer` 在 `...launch.support`） | `org.springframework.batch.core.job.parameters` |
| `Step`、`StepExecution`、`StepContribution` | `org.springframework.batch.core` | `org.springframework.batch.core.step` |
| `Partitioner` | `org.springframework.batch.core.partition.support` | `org.springframework.batch.core.partition` |
| 读写器、`ItemReader`、`ItemProcessor`、`RepeatStatus`、`ExecutionContext` | `org.springframework.batch.item.*` / `...repeat` | `org.springframework.batch.infrastructure.item.*` / `...infrastructure.repeat` |

其他变化：`JobLauncher` 由 `JobOperator` 取代；`StepBuilder#chunk(int, PlatformTransactionManager)` 废弃，改用 `ChunkOrientedStepBuilder`；重试基于 Spring Framework 7 的核心重试（不再依赖 Spring Retry）；JSON 读写默认 Jackson 3。另外 Batch 6 修改了作业参数的序列化格式，**Batch 5 下失败的作业实例不能在 Batch 6 中重启**，升级前要先把它们跑完或标记为 ABANDONED。

---

## 三、完整示例：CSV 导入数据库

### 1、数据模型

```java
public record UserRecord(Long id, String name, String email) {}   // CSV 原始行
public record User(Long id, String name, String email) {}         // 清洗后的入库对象
```

### 2、ItemReader：读 CSV

文件路径来自作业参数，所以 Reader 必须是 `@StepScope`（每次 Step 执行时创建，才能拿到当次的参数）：

```java
@Bean
@StepScope
public FlatFileItemReader<UserRecord> csvReader(
        @Value("#{jobParameters['inputFile']}") String inputFile) {
    return new FlatFileItemReaderBuilder<UserRecord>()
        .name("csvReader")                       // 作为 ExecutionContext 中的键前缀，重启时据此恢复读取位置
        .resource(new FileSystemResource(inputFile))
        .delimited()
        .names("id", "name", "email")
        .targetType(UserRecord.class)            // 支持 record
        .linesToSkip(1)                          // 跳过表头
        .build();
}
```

### 3、ItemProcessor：校验与清洗

```java
@Bean
public ItemProcessor<UserRecord, User> userProcessor() {
    return record -> {
        if (record.email() == null || !record.email().contains("@")) {
            return null;   // 返回 null 是「过滤」：计入 filterCount，不算跳过，也不会触发 SkipListener
        }
        return new User(record.id(), record.name().trim(), record.email().toLowerCase());
    };
}
```

过滤（filter）是业务上「这条不要」，跳过（skip）是「这条出错了但容忍」，两者在 `StepExecution` 中分别统计，对账时不要混在一起。

### 4、ItemWriter：批量写库

```java
@Bean
public JdbcBatchItemWriter<User> dbWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<User>()
        .dataSource(dataSource)
        .sql("""
             INSERT INTO users (id, name, email) VALUES (:id, :name, :email)
             ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email)
             """)                                 // 幂等写入：重启重做某个 chunk 时不会主键冲突
        .itemSqlParameterSourceProvider(u -> new MapSqlParameterSource()
            .addValue("id", u.id())
            .addValue("name", u.name())
            .addValue("email", u.email()))
        .build();
}
```

> `.beanMapped()` 通过 JavaBean 的 `getId()` 取值，record 只有 `id()` 访问器，用它会导致参数解析不到。record 用上面的 `itemSqlParameterSourceProvider`，或改用普通类。

### 5、Step 与 Job 组装

```java
@Configuration
public class UserImportJobConfig {

    @Bean
    public Step importStep(JobRepository jobRepository,
                           PlatformTransactionManager txManager,
                           FlatFileItemReader<UserRecord> csvReader,
                           ItemProcessor<UserRecord, User> userProcessor,
                           JdbcBatchItemWriter<User> dbWriter) {
        return new ChunkOrientedStepBuilder<UserRecord, User>("importStep", jobRepository, 500)
            .reader(csvReader)
            .processor(userProcessor)
            .writer(dbWriter)
            .transactionManager(txManager)              // 必须显式设置，默认是不做事务的 ResourcelessTransactionManager
            .faultTolerant()
            .skip(FlatFileParseException.class)         // 解析错误的行跳过
            .skipLimit(10)                              // 超过 10 行则 Step 失败
            .retry(TransientDataAccessException.class)  // 数据库瞬时故障重试
            .retryLimit(3)
            .build();
    }

    @Bean
    public Job importJob(JobRepository jobRepository, Step importStep) {
        return new JobBuilder("importJob", jobRepository)
            .start(importStep)
            .build();
    }
}
```

更复杂的策略用 `.skipPolicy(SkipPolicy)` 与 `.retryPolicy(RetryPolicy)`（`org.springframework.core.retry.RetryPolicy`，可配置退避）。

> Batch 5 写法：`new StepBuilder("importStep", jobRepository).<UserRecord, User>chunk(500, txManager)...faultTolerant().skip(...).skipLimit(10)`。在 Batch 6 中仍可编译，但已废弃。

### 6、触发 Job

```java
@Service
@RequiredArgsConstructor
public class UserImportService {

    private final JobOperator jobOperator;
    private final Job importJob;

    public JobExecution importFile(String inputFile, LocalDate bizDate) throws Exception {
        JobParameters params = new JobParametersBuilder()
            .addString("inputFile", inputFile)          // 标识性参数
            .addLocalDate("bizDate", bizDate)           // 标识性参数：同一文件同一业务日只会成功执行一次
            .addString("operator", "admin", false)      // 非标识参数：不参与 JobInstance 判定
            .toJobParameters();
        return jobOperator.start(importJob, params);
    }
}
```

`JobOperator` 默认在调用线程中同步执行整个作业。从 HTTP 接口触发时，应提供异步的批处理任务执行器（Boot 中用 `@BatchTaskExecutor` 标注），立即返回 `JobExecution` 的 ID，再通过查询接口看进度。

---

## 四、Tasklet 步骤

不需要读-处理-写的单个动作（清理临时目录、调用存储过程、发送通知）用 `Tasklet`：

```java
@Bean
public Step cleanupStep(JobRepository jobRepository) {
    return new StepBuilder("cleanupStep", jobRepository)
        .tasklet((contribution, chunkContext) -> {
            // 递归删除整个暂存目录；Files.deleteIfExists 遇到非空目录会抛 DirectoryNotEmptyException
            FileSystemUtils.deleteRecursively(Path.of("/data/import_staging"));
            return RepeatStatus.FINISHED;
        })
        .build();
}
```

Batch 6 中 Tasklet 步骤的事务管理器也是可选的；Tasklet 内要写数据库时，用 `.tasklet(tasklet, txManager)` 传入真实的事务管理器。

---

## 五、Job 流程控制

### 1、顺序执行

```java
return new JobBuilder("etlJob", jobRepository)
    .start(extractStep)
    .next(transformStep)
    .next(loadStep)
    .build();
```

任何一步失败，整个 Job 即为 FAILED，后续 Step 不执行。

### 2、条件分支

`on(...)` 作用于**紧挨着它的上一个 Step**。要给同一个 Step 再加一条分支，必须先用 `from(...)` 回到该 Step：

```java
return new JobBuilder("conditionalJob", jobRepository)
    .start(validationStep)
        .on("FAILED").to(errorNotifyStep)   // 校验失败 → 发通知
        .on("*").fail()                     // 作用于 errorNotifyStep：通知后把作业标记为 FAILED，便于修复数据后重启
    .from(validationStep)
        .on("*").to(processStep)            // 校验的其他结果 → 正常处理
    .end()
    .build();
```

常见错误写法是 `.start(validationStep).on("FAILED").to(errorNotifyStep).on("*").to(processStep)`：第二个 `on("*")` 实际作用于 `errorNotifyStep`，校验成功时没有匹配的分支，作业以异常结束。

需要根据业务数据而不是 Step 状态做分支时，用 `JobExecutionDecider` 返回自定义的 `FlowExecutionStatus`。

### 3、并行流

```java
Flow userFlow  = new FlowBuilder<SimpleFlow>("userFlow").start(importUserStep).build();
Flow orderFlow = new FlowBuilder<SimpleFlow>("orderFlow").start(importOrderStep).build();

return new JobBuilder("parallelJob", jobRepository)
    .start(userFlow)
    .split(new SimpleAsyncTaskExecutor("batch-"))   // 两个 Flow 并行执行
    .add(orderFlow)
    .next(summaryStep)                              // 都完成后再汇总
    .end()
    .build();
```

---

## 六、重启语义

![JobInstance 与重启](../assets/spring/spring_batch_restart.svg)

### 1、规则

- **标识性参数决定 JobInstance**：作业名 + 标识性参数相同，就是同一个 JobInstance
- **COMPLETED 的实例不能再次执行**：再用相同参数启动会抛 `JobInstanceAlreadyCompleteException`，这正是防止日终任务被重复执行的机制
- **FAILED / STOPPED 的实例可以重启**：已完成的 Step 默认跳过；失败的 Chunk Step 从 `ExecutionContext` 中记录的位置继续，已提交的 chunk 不会重做
- 断点续读依赖 Reader 实现 `ItemStream`（Spring Batch 自带的 Reader 都实现了），并且 Reader 设置了 `name`；自定义 Reader 需要自己在 `update()` 中保存位置
- 重启时最后一个未提交的 chunk 会被重新处理，所以 Writer 仍需幂等

### 2、不要用时间戳参数「保证唯一」

`addLong("timestamp", System.currentTimeMillis())` 让每次启动都是新的 JobInstance，失败后再次触发不会从断点续跑，而是从头开始，等于放弃了重启能力，还会让「同一业务日只跑一次」的保护失效。正确做法：

| 需求 | 做法 |
|------|------|
| 按业务日 / 文件执行，失败后续跑 | 用业务参数作为标识性参数（如 `bizDate`、`inputFile`），失败后用**相同参数**重启 |
| 无业务参数、每次都要新实例 | 给 Job 配 `.incrementer(new RunIdIncrementer())`，用 `jobOperator.startNextInstance(job)` 启动 |
| 只用于记录、不参与判定的参数 | 声明为非标识参数：`addString("operator", "admin", false)` |

> Job 配置了 incrementer 时，`start` 传入的用户参数会被忽略（并打印警告）。

### 3、运维操作

```java
JobExecution last = jobRepository.getLastJobExecution("importJob", params);

jobOperator.restart(last);    // 重启 FAILED / STOPPED 的执行
jobOperator.stop(last);       // 发送停止信号，Step 在当前 chunk 结束后停止
jobOperator.abandon(last);    // 标记为 ABANDONED，此后不能再重启
jobOperator.recover(last);    // 6.0 新增：把异常中断（如进程被强杀）的执行恢复为可重启状态
```

进程被强杀后，执行记录会停留在 STARTED 状态，此时重启会报「已有执行在运行」。Batch 6 之前需要手工修改元数据表，现在用 `recover` 处理。Batch 6 还支持优雅停机：收到停机信号时停止当前 Step，并把仓库状态更新为可重启的一致状态。

---

## 七、扩展与性能

| 方式 | 原理 | 适用 | 注意 |
|------|------|------|------|
| 本地多线程 Chunk | `.taskExecutor(...)`：6.0 中由生产者-消费者模型并行处理 chunk | 单机 CPU 或 IO 未打满 | Reader 必须线程安全；处理顺序不再保证 |
| 并行流 | `split(...)` 并行执行互不依赖的 Step | 多张表、多个文件互不相关 | 共享资源（连接池）要扩容 |
| 分区（Partitioning） | Manager Step 用 `Partitioner` 把数据切成 N 份，每份由一个 Worker Step 独立执行 | 大表按 ID 范围、按日期、按文件拆分 | 每个分区有独立的 `StepExecution`，可单独重启 |
| 远程分块 / 远程分区 | Worker 运行在其他节点，通过 Spring Integration 与 MQ 通信 | 单机资源不够，需要横向扩展 | 引入 MQ，运维复杂度上升 |

### 1、按 ID 范围分区

![分区处理](../assets/spring/spring_batch_partition.svg)

```java
@Bean
public Partitioner idRangePartitioner(JdbcTemplate jdbcTemplate) {
    return gridSize -> {
        long min = jdbcTemplate.queryForObject("SELECT MIN(id) FROM orders", Long.class);
        long max = jdbcTemplate.queryForObject("SELECT MAX(id) FROM orders", Long.class);
        long size = (max - min) / gridSize + 1;
        Map<String, ExecutionContext> partitions = new HashMap<>();
        for (int i = 0; i < gridSize; i++) {
            ExecutionContext ctx = new ExecutionContext();
            ctx.putLong("minId", min + i * size);
            ctx.putLong("maxId", Math.min(min + (i + 1) * size - 1, max));
            partitions.put("partition" + i, ctx);
        }
        return partitions;
    };
}

@Bean
public ThreadPoolTaskExecutor partitionExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(8);
    executor.setThreadNamePrefix("partition-");
    return executor;                                // 作为 Bean 由容器负责初始化与关闭
}

@Bean
public Step managerStep(JobRepository jobRepository, Partitioner idRangePartitioner,
                        Step workerStep, ThreadPoolTaskExecutor partitionExecutor) {
    return new StepBuilder("managerStep", jobRepository)
        .partitioner("workerStep", idRangePartitioner)
        .step(workerStep)
        .gridSize(8)
        .taskExecutor(partitionExecutor)
        .build();
}

// Worker 的 Reader 读取各自分区的范围：分页读取，避免一次性加载
@Bean
@StepScope
public JdbcPagingItemReader<OrderRow> orderReader(DataSource dataSource,
        @Value("#{stepExecutionContext['minId']}") Long minId,
        @Value("#{stepExecutionContext['maxId']}") Long maxId) {
    return new JdbcPagingItemReaderBuilder<OrderRow>()
        .name("orderReader")
        .dataSource(dataSource)
        .selectClause("SELECT id, user_id, amount, status")
        .fromClause("FROM orders")
        .whereClause("WHERE id BETWEEN :minId AND :maxId")
        .parameterValues(Map.of("minId", minId, "maxId", maxId))
        .sortKeys(Map.of("id", Order.ASCENDING))    // 分页必须有唯一排序键
        .pageSize(1000)
        .rowMapper(new DataClassRowMapper<>(OrderRow.class))   // OrderRow 为 record
        .build();
}
```

### 2、读取方式的选择

- **分页读取**（`JdbcPagingItemReader`）：每页一条 SQL，线程安全，可用于多线程与分区；排序键必须唯一，且翻页期间数据有变动可能漏读
- **游标读取**（`JdbcCursorItemReader`）：一条长连接流式读取，单线程性能最好；不是线程安全的，长时间占用连接
- MySQL 游标读取要设置 `fetchSize(Integer.MIN_VALUE)` 或开启 `useCursorFetch=true`，否则驱动会把结果集全部加载到内存

IO 密集的 Worker 可以使用虚拟线程执行器，原理与注意事项见 [虚拟线程](/java/30_topic_virtual_thread)；远程分块 / 分区基于 Spring Integration 的消息通道，见 [Spring Integration](./13_integration)。

---

## 八、监听与监控

```java
@Component
@Slf4j
public class ImportJobListener implements JobExecutionListener {

    @Override
    public void afterJob(JobExecution jobExecution) {
        jobExecution.getStepExecutions().forEach(s -> log.info(
            "step={} read={} write={} filter={} skip={} rollback={}",
            s.getStepName(), s.getReadCount(), s.getWriteCount(),
            s.getFilterCount(), s.getSkipCount(), s.getRollbackCount()));
        if (jobExecution.getStatus() == BatchStatus.FAILED) {
            // 发送告警：作业名、参数、失败异常
        }
    }
}
```

在 `JobBuilder` 上用 `.listener(importJobListener)` 注册。Step 级别有 `StepExecutionListener`、`ChunkListener`、`SkipListener`（记录被跳过的行，便于事后补录）。

- **指标**：Spring Batch 通过 Micrometer 输出 `spring.batch.job`、`spring.batch.step`、`spring.batch.item.read`、`spring.batch.chunk.write` 等指标，经 Actuator 暴露；`ChunkOrientedStepBuilder` 默认使用 `ObservationRegistry.NOOP`，需要指标时用 `.observationRegistry(registry)` 传入
- **JFR**：6.0 新增作业、步骤、读写与事务边界的 JFR 事件，可用于定位慢 chunk
- 告警与指标体系见 [指标监控](/observability/2_metrics)

---

## 九、与定时任务的关系

Spring Batch 只负责**一次批处理怎么执行**，不负责**什么时候执行**。常见的触发方式：

| 触发方式 | 适用场景 |
|----------|---------|
| `@Scheduled` | 单节点简单定时，多实例部署时需要分布式锁防重 |
| Quartz | 集群定时触发，精确 Cron |
| XXL-Job / ElasticJob | 分布式调度，支持分片、失败告警、控制台 |
| Kubernetes CronJob | 作业打成独立镜像，每次运行一个 Pod，跑完即退出 |

JobInstance 机制本身就能防止同一业务参数被重复执行成功，可作为调度层防重之外的第二道保护。调度方案对比见 [分布式调度](/distributed/6_job_scheduler)。

---

## 小结

- 一个 chunk 一个事务，进度写入 `ExecutionContext`；作业名 + 标识性参数确定 JobInstance，COMPLETED 不可重跑，FAILED 从断点续跑
- Boot 4 生产环境用 `spring-boot-starter-batch-jdbc`；`spring-boot-starter-batch` 是 Resourceless 仓库，不持久化任何状态
- Boot 项目不要加 `@EnableBatchProcessing`：它会让自动配置和 `spring.batch.*` 全部失效，Batch 6 下还会静默退化为 Resourceless 仓库
- Batch 6：核心类迁到 `core.job` / `core.step` / `core.job.parameters`，基础设施迁到 `infrastructure.*`；用 `ChunkOrientedStepBuilder` 并显式设置事务管理器；`JobOperator` 取代 `JobLauncher`
- 过滤（Processor 返回 null）与跳过（异常被容忍）分开统计；Writer 要幂等，以应对重启时重做最后一个 chunk
- 条件分支中 `on()` 作用于上一个 Step，同一 Step 的多个分支用 `from()` 回到该 Step
- 不用时间戳参数「保证唯一」；需要每次新实例时用 `RunIdIncrementer` + `startNextInstance`；进程被杀后用 `recover` 修复
- 扩展顺序：多线程 Chunk → 并行流 → 分区 → 远程分块 / 分区；分页读取线程安全，游标读取单线程最快

## 参考资料

- Spring Batch 官方文档：[https://docs.spring.io/spring-batch/reference/](https://docs.spring.io/spring-batch/reference/)
- Spring Batch 6.0 新特性：[https://docs.spring.io/spring-batch/reference/whatsnew.html](https://docs.spring.io/spring-batch/reference/whatsnew.html)
- Spring Batch 6.0 迁移指南：[https://github.com/spring-projects/spring-batch/wiki/Spring-Batch-6.0-Migration-Guide](https://github.com/spring-projects/spring-batch/wiki/Spring-Batch-6.0-Migration-Guide)
- Spring Boot 中的 Spring Batch：[https://docs.spring.io/spring-boot/reference/io/spring-batch.html](https://docs.spring.io/spring-boot/reference/io/spring-batch.html)

> 下一篇：[Spring Integration](./13_integration) —— 用消息通道和企业集成模式连接文件、HTTP、MQ 等外部系统，并与 Apache Camel 对比。

# Spring Batch

> 参考资料：
> * Spring Batch 官方文档：[https://docs.spring.io/spring-batch/reference/](https://docs.spring.io/spring-batch/reference/)
> * Spring Batch 入门：[https://www.baeldung.com/introduction-to-spring-batch](https://www.baeldung.com/introduction-to-spring-batch)

## 一、核心架构

![Spring Batch 架构](../../assets/spring/spring_batch_arch.svg)

**核心组件：**

| 组件 | 说明 |
|------|------|
| `Job` | 批处理作业，由多个 `Step` 组成 |
| `Step` | 批处理步骤，可以是 Chunk 步骤或 Tasklet 步骤 |
| `ItemReader` | 读取数据（DB / CSV / JSON / MQ） |
| `ItemProcessor` | 处理 / 转换数据（可选） |
| `ItemWriter` | 写入数据（DB / 文件 / 外部系统） |
| `JobRepository` | 持久化 Job 执行状态，默认写入数据库 |
| `JobLauncher` | 触发 Job 执行 |

**Chunk 处理模型：**

每次读取 `chunkSize` 条记录 → 逐条处理 → 批量写入，事务按 chunk 提交，兼顾内存和性能。

---

## 二、适用场景

- 数据迁移（旧系统 → 新系统）
- 报表生成（定时汇总大量数据）
- 对账（批量核对交易记录）
- ETL（数据抽取 / 转换 / 加载）

---

## 三、依赖与配置

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-batch</artifactId>
</dependency>
<!-- Job 元数据持久化需要数据库 -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
```

```yaml
spring:
  batch:
    job:
      enabled: false        # 禁止启动时自动执行所有 Job（推荐手动触发）
    jdbc:
      initialize-schema: always   # 自动建 batch 元数据表（生产改 never）
```

---

## 四、完整示例：CSV 导入数据库

### 4.1 数据模型

```java
public record UserRecord(Long id, String name, String email) {}
```

### 4.2 ItemReader — 读 CSV

```java
@Bean
public FlatFileItemReader<UserRecord> csvReader() {
    return new FlatFileItemReaderBuilder<UserRecord>()
        .name("csvReader")
        .resource(new ClassPathResource("users.csv"))
        .delimited()
        .names("id", "name", "email")
        .targetType(UserRecord.class)
        .linesToSkip(1)         // 跳过表头
        .build();
}
```

### 4.3 ItemProcessor — 清洗数据

```java
@Bean
public ItemProcessor<UserRecord, User> userProcessor() {
    return record -> {
        if (record.email() == null || !record.email().contains("@")) {
            return null;    // 返回 null 表示跳过该条记录
        }
        return new User(record.id(), record.name().trim(), record.email().toLowerCase());
    };
}
```

### 4.4 ItemWriter — 写数据库

```java
@Bean
public JdbcBatchItemWriter<User> dbWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<User>()
        .dataSource(dataSource)
        .sql("INSERT INTO users (id, name, email) VALUES (:id, :name, :email)")
        .beanMapped()
        .build();
}
```

### 4.5 Step + Job 组装

```java
@Configuration
@EnableBatchProcessing
public class UserImportJobConfig {

    @Bean
    public Step importStep(JobRepository jobRepository,
                           PlatformTransactionManager txManager,
                           FlatFileItemReader<UserRecord> reader,
                           ItemProcessor<UserRecord, User> processor,
                           JdbcBatchItemWriter<User> writer) {
        return new StepBuilder("importStep", jobRepository)
            .<UserRecord, User>chunk(500, txManager)   // 每批 500 条
            .reader(reader)
            .processor(processor)
            .writer(writer)
            .faultTolerant()
            .skip(FlatFileParseException.class)         // 跳过解析错误行
            .skipLimit(10)                              // 最多跳过 10 行
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

### 4.6 手动触发 Job

```java
@Service
@RequiredArgsConstructor
public class BatchService {

    private final JobLauncher jobLauncher;
    private final Job importJob;

    public void runImport() throws Exception {
        JobParameters params = new JobParametersBuilder()
            .addLong("timestamp", System.currentTimeMillis())  // 保证每次参数唯一
            .toJobParameters();
        jobLauncher.run(importJob, params);
    }
}
```

---

## 五、Tasklet 步骤

不需要 Reader/Processor/Writer 的简单任务（如清理临时文件、发送通知）用 `Tasklet`：

```java
@Bean
public Step cleanupStep(JobRepository jobRepository,
                        PlatformTransactionManager txManager) {
    return new StepBuilder("cleanupStep", jobRepository)
        .tasklet((contribution, chunkContext) -> {
            // 清理临时目录
            Files.deleteIfExists(Path.of("/tmp/import_staging"));
            return RepeatStatus.FINISHED;
        }, txManager)
        .build();
}
```

---

## 六、Job 流程控制

### 6.1 顺序执行多个 Step

```java
return new JobBuilder("etlJob", jobRepository)
    .start(extractStep)
    .next(transformStep)
    .next(loadStep)
    .build();
```

### 6.2 条件分支

```java
return new JobBuilder("conditionalJob", jobRepository)
    .start(validationStep)
        .on("FAILED").to(errorNotifyStep)
        .on("*").to(processStep)
    .end()
    .build();
```

---

## 七、与定时任务的关系

Spring Batch 专注**批量处理逻辑**，本身不负责调度。通常配合：

| 触发方式 | 适用场景 |
|----------|---------|
| `@Scheduled` | 简单定时触发，单节点 |
| Quartz | 集群定时触发，精确 Cron |
| XXL-Job / Elastic-Job | 分布式调度，支持分片、监控 |

详见 → [分布式任务调度](/distributed/5_job_scheduler)

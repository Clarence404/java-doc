---
description: "@Async 执行器与异常、@Scheduled 线程与 Cron、ShedLock / XXL-JOB、虚拟线程开关"
---

# 异步任务与定时任务

> 前置阅读：[线程池](/java/28_topic_thread_pool)

`@Async` 和 `@Scheduled` 的行为取决于它们背后的执行器。本篇以 Spring Boot 4.x 为基线（执行器行为在 3.5 已基本定型，3.x 差异在正文中标出），讲 `spring.task.*` 与自定义线程池、单线程调度、自调用失效、多实例重复执行等坑，以及虚拟线程开关改变了什么。

---

## 一、@Async 的执行器

### 1、谁在执行 @Async 方法

`@EnableAsync` 之后，`@Async` 方法交给哪个执行器，按以下规则决定：

| 场景 | `@Async` 使用的执行器 |
|------|---------------------|
| 什么都不配 | Boot 自动配置的 `applicationTaskExecutor`：`ThreadPoolTaskExecutor`；开启虚拟线程后换成基于虚拟线程的 `SimpleAsyncTaskExecutor` |
| 自己声明了任意 `Executor` Bean | 自动配置**整体退让**，`@Async` 用你的 Bean（多个时取 `@Primary` 或名为 `taskExecutor` 的那个） |
| 声明了 `AsyncConfigurer` Bean | 用 `getAsyncExecutor()` 返回的执行器 |
| `spring.task.execution.mode=force`（3.5+） | 即使有自定义 `Executor`，也照常创建 `applicationTaskExecutor` 并用于 `@Async`；此时只有 `AsyncConfigurer` 能改 |
| `@Async("orderExecutor")` | 直接用指定名称的 Bean |

由此得出两个经常被忽略的结论：

- **虚拟线程开关只作用于自动配置的执行器**。一旦用 `AsyncConfigurer` 返回自己 new 的 `ThreadPoolTaskExecutor`，或声明了自己的 `Executor` Bean，`spring.threads.virtual.enabled=true` 对 `@Async` 不再生效
- **自定义 `Executor` Bean 会让 `applicationTaskExecutor` 消失**，而 Spring MVC 的异步请求、WebFlux 的阻塞调用等也依赖这个 Bean。需要多个业务线程池时，配合 `spring.task.execution.mode=force` 保留它

另外，Boot 3.5 起自动配置的执行器只注册 `applicationTaskExecutor` 这一个名字，之前的 `taskExecutor` 别名已去掉，按名字注入 `taskExecutor` 的旧代码会启动失败。

### 2、用配置调整默认执行器

大多数项目只需要把默认执行器配成有界的：

```yaml
spring:
  task:
    execution:
      thread-name-prefix: async-
      pool:
        core-size: 8                 # 默认 8
        max-size: 32                 # 默认 Integer.MAX_VALUE
        queue-capacity: 1000         # 默认 Integer.MAX_VALUE，即无界队列
        keep-alive: 60s
      shutdown:
        await-termination: true      # 关闭时等待已提交任务执行完
        await-termination-period: 30s
```

默认的队列和最大线程数都是 `Integer.MAX_VALUE`，等价于无界队列——任务堆积时不会扩容、不会拒绝，只会吃光内存。队列满且线程数到达 `max-size` 后，默认拒绝策略是抛 `TaskRejectedException`，调用方要处理。线程池参数怎么估算、拒绝策略怎么选见 [线程池](/java/28_topic_thread_pool)。

### 3、多个业务线程池

不同业务混用一个池会互相拖累（慢的 IO 任务占满线程，快的任务全在排队）。按业务隔离：

```java
import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@Configuration
@EnableAsync
public class ExecutorConfig {

    @Bean
    public ThreadPoolTaskExecutor ossExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("oss-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());  // 满了由调用方执行，形成背压
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        return executor;   // 作为 Bean 返回：容器管理初始化与关闭，Actuator 也能采集其指标
    }
}
```

```yaml
spring:
  task:
    execution:
      mode: force          # 声明了 ossExecutor 后仍保留 applicationTaskExecutor 作为默认执行器
```

- 线程池**一定要作为 Bean 暴露**。在 `AsyncConfigurer#getAsyncExecutor` 里 `new` 出来再 `initialize()` 的池不受容器管理：关闭时不会等任务完成，也没有执行器指标
- `CallerRunsPolicy` 会让提交线程（往往是 Tomcat 请求线程）去执行任务，起到限流作用，但也会拉长接口耗时；对丢弃可接受的任务用 `DiscardPolicy` 并记录日志
- 需要透传 MDC / traceId 时给执行器设置 `TaskDecorator`，写法与「恢复而不是清空」的坑见 [线程池](/java/28_topic_thread_pool) 与 [日志](./12_logging)

### 4、异常处理

```java
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.concurrent.Executor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.scheduling.annotation.AsyncConfigurer;

@Configuration
public class AsyncExceptionConfig implements AsyncConfigurer {

    private static final Logger log = LoggerFactory.getLogger(AsyncExceptionConfig.class);

    private final ObjectProvider<AsyncTaskExecutor> applicationTaskExecutor;

    public AsyncExceptionConfig(
            @Qualifier("applicationTaskExecutor") ObjectProvider<AsyncTaskExecutor> applicationTaskExecutor) {
        this.applicationTaskExecutor = applicationTaskExecutor;
    }

    // 显式返回 Boot 自动配置的执行器：既保留 spring.task.execution.* 与虚拟线程开关，
    // 又避免返回 null 后 Spring 在多个 TaskExecutor Bean 中找不到默认值而退回 SimpleAsyncTaskExecutor
    @Override
    public Executor getAsyncExecutor() {
        return applicationTaskExecutor.getObject();
    }

    // 只对返回 void 的 @Async 方法生效
    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (Throwable ex, Method method, Object... params) ->
                log.error("异步方法 {} 执行异常，参数: {}", method.getName(), Arrays.toString(params), ex);
    }
}
```

返回 `CompletableFuture` 的 `@Async` 方法，异常会被包进 Future，**不会**进入 `AsyncUncaughtExceptionHandler`；调用方必须 `join()` / `exceptionally()` 处理，否则异常被静默吞掉。

### 5、使用 @Async

```java
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class NotifyService {

    private static final Logger log = LoggerFactory.getLogger(NotifyService.class);

    private final MailClient mailClient;
    private final ReportService reportService;
    private final OssClient ossClient;

    public NotifyService(MailClient mailClient, ReportService reportService, OssClient ossClient) {
        this.mailClient = mailClient;
        this.reportService = reportService;
        this.ossClient = ossClient;
    }

    @Async                                   // fire-and-forget，异常进 AsyncUncaughtExceptionHandler
    public void sendWelcomeMail(String email, String username) {
        log.info("发送欢迎邮件给 {}，线程: {}", email, Thread.currentThread().getName());
        mailClient.send(email, "欢迎注册", "Hello " + username);
    }

    @Async                                   // 有返回值：异常在 Future 里
    public CompletableFuture<Report> generateReport(Long userId) {
        return CompletableFuture.completedFuture(reportService.generate(userId));
    }

    @Async("ossExecutor")                    // 指定业务线程池
    public void upload(String filePath) {
        ossClient.upload(filePath);
    }
}
```

并行调用多个 `@Async` 方法再汇总时，用 `CompletableFuture.allOf(...)` 等待，并给整体加超时（`orTimeout`），组合方式见 [CompletableFuture](/java/29_topic_completable_future)。`@Async` 方法的返回值只能是 `void`、`Future` 及其子类型，Framework 6.0 起 `ListenableFuture` 废弃，7.0 已移除。

### 6、@Async 不生效的常见原因

- **同类内部调用**：`this.sendWelcomeMail()` 绕过了代理，和 `@Transactional` 自调用失效是同一个原因，见 [AOP](/spring/2_aop) 的「自调用失效问题」，代理机制见 [动态代理](/java/16_topic_proxy)
- 方法是 `private` 或 `final`、类是 `final`：代理无法拦截
- 忘了 `@EnableAsync`：方法会在调用线程中同步执行，不报错

测试 `@Async` 方法时用 Awaitility 等待结果，见 [Spring Boot 测试](./13_testing)。

---

## 二、定时任务 @Scheduled

### 1、开启与三种触发方式

```java
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Configuration
@EnableScheduling
public class ScheduleConfig { }

@Component
public class MaintenanceTasks {

    private static final Logger log = LoggerFactory.getLogger(MaintenanceTasks.class);

    private final FileService fileService;
    private final ReportService reportService;

    public MaintenanceTasks(FileService fileService, ReportService reportService) {
        this.fileService = fileService;
        this.reportService = reportService;
    }

    // fixedRate：按固定频率触发；同一任务不会并发，上次超时则本次在其结束后立即开始
    @Scheduled(fixedRate = 5, timeUnit = TimeUnit.SECONDS)
    public void heartbeat() {
        log.debug("心跳检测");
    }

    // fixedDelay：上次结束后再等 N 毫秒；initialDelay 避开启动高峰
    @Scheduled(fixedDelay = 10_000, initialDelay = 30_000)
    public void cleanTempFiles() {
        fileService.cleanOlderThan(Duration.ofDays(7));
    }

    // cron：按日历触发，zone 指定时区，避免容器默认 UTC 导致错点
    @Scheduled(cron = "0 0 2 * * *", zone = "Asia/Shanghai")
    public void dailyReport() {
        reportService.generateDailyReport();
    }
}
```

### 2、默认只有一个调度线程

没开虚拟线程时，Boot 自动配置的 `ThreadPoolTaskScheduler` **默认只有 1 个线程**，所有 `@Scheduled` 方法排队执行：一个任务卡住 10 分钟，其他任务全部延迟 10 分钟。按任务数调大：

```yaml
spring:
  task:
    scheduling:
      thread-name-prefix: sched-
      pool:
        size: 4
      shutdown:
        await-termination: true
        await-termination-period: 30s
```

耗时长的任务不要占着调度线程：在任务方法里把实际工作提交给业务线程池（或给方法再加 `@Async("xxxExecutor")`），调度线程只负责按时触发。注意加了 `@Async` 后同一任务**可能并发执行**，需要自己防重入。

### 3、Cron 表达式

Spring 的 cron 是 **6 个字段**（`秒 分 时 日 月 周`），比 Linux crontab 多了开头的「秒」，直接照抄 crontab 的 5 段表达式会启动报错。

| 表达式 | 含义 |
|--------|------|
| `0 0 2 * * *` | 每天 02:00 |
| `0 */5 * * * *` | 每 5 分钟 |
| `0 */5 9-18 * * MON-FRI` | 工作日 9:00–18:59 每 5 分钟 |
| `0 0 0 1 * *` | 每月 1 日 00:00 |
| `0 0 8 * * MON` | 每周一 08:00 |
| `0 0 0 L * *` | 每月最后一天 00:00 |
| `0 0 9 ? * 6#3` | 每月第三个周六 09:00 |
| `@daily` | 等价于 `0 0 0 * * *`，另有 `@hourly`、`@weekly`、`@monthly`、`@yearly` |

`L`、`W`、`#` 等 Quartz 风格写法从 Spring 5.3 起支持；`?` 与 `*` 在日、周字段中等价。表达式可以外置，按环境覆盖：

```java
@Scheduled(cron = "${task.report.cron:0 0 2 * * *}", zone = "Asia/Shanghai")
public void reportTask() { /* ... */ }
```

把 cron 配成 `-` 可以在某个环境中禁用该任务（`@Scheduled(cron = "${task.report.cron:-}")`）。

---

## 三、多实例下的定时任务

`@Scheduled` 是进程内调度，部署 N 个实例就会执行 N 次。按需求选择：

| 需求 | 方案 |
|------|------|
| 只是「多实例只执行一次」，任务量不大 | ShedLock：给 `@Scheduled` 加分布式锁 |
| 需要可视化管理、手动触发、失败重试、告警、分片 | XXL-JOB、Apache ShardingSphere-ElasticJob、PowerJob 等调度平台 |
| 需要持久化的触发器、错过补偿 | Quartz 集群模式 |

各调度平台的架构与对比见 [分布式调度](/distributed/6_job_scheduler)，下面只讲 Boot 侧接入。

### 1、ShedLock：最轻量的方案

```xml
<dependency>
    <groupId>net.javacrumbs.shedlock</groupId>
    <artifactId>shedlock-spring</artifactId>
    <version>7.10.1</version>   <!-- 7.x 支持 Spring Boot 4.x / 3.5 / 3.4 -->
</dependency>
<dependency>
    <groupId>net.javacrumbs.shedlock</groupId>
    <artifactId>shedlock-provider-jdbc-template</artifactId>
    <version>7.10.1</version>
</dependency>
```

```sql
CREATE TABLE shedlock (
    name       VARCHAR(64)  NOT NULL PRIMARY KEY,
    lock_until TIMESTAMP(3) NOT NULL,
    locked_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    locked_by  VARCHAR(255) NOT NULL
);
```

```java
import javax.sql.DataSource;
import net.javacrumbs.shedlock.core.LockAssert;
import net.javacrumbs.shedlock.core.LockProvider;
import net.javacrumbs.shedlock.provider.jdbctemplate.JdbcTemplateLockProvider;
import net.javacrumbs.shedlock.spring.annotation.EnableSchedulerLock;
import net.javacrumbs.shedlock.spring.annotation.SchedulerLock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Configuration
@EnableScheduling
@EnableSchedulerLock(defaultLockAtMostFor = "10m")
public class SchedulerLockConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(JdbcTemplateLockProvider.Configuration.builder()
                .withJdbcTemplate(new JdbcTemplate(dataSource))
                .usingDbTime()                 // 用数据库时间，避免各实例时钟不一致
                .build());
    }
}

@Component
public class SettlementTask {

    @Scheduled(cron = "0 0 1 * * *", zone = "Asia/Shanghai")
    @SchedulerLock(name = "dailySettlement", lockAtMostFor = "30m", lockAtLeastFor = "1m")
    public void settle() {
        LockAssert.assertLocked();             // 防止配置失误导致无锁运行
        // 结算逻辑
    }
}
```

- `lockAtMostFor`：持锁实例宕机时锁的最长保留时间，要明显大于任务正常耗时
- `lockAtLeastFor`：最短持锁时间，抵消各实例时钟偏差，防止任务很快结束后另一个实例又跑一次
- ShedLock 只保证「同一时刻最多一个实例执行」，不负责补跑错过的任务，也不分片

### 2、XXL-JOB 接入

`xxl-job-core` 没有 Spring Boot 自动配置，只写 yml 不会生效，必须自己声明 `XxlJobSpringExecutor` Bean：

```xml
<dependency>
    <groupId>com.xuxueli</groupId>
    <artifactId>xxl-job-core</artifactId>
    <version>3.4.2</version>   <!-- 3.x 需要 JDK 17+ -->
</dependency>
```

```yaml
xxl:
  job:
    admin-addresses: http://xxl-job-admin:8080/xxl-job-admin
    access-token: ${XXL_JOB_ACCESS_TOKEN}   # 与调度中心一致，不要使用默认值
    executor:
      appname: order-service
      port: 9999
      log-path: /data/applogs/xxl-job/jobhandler
      log-retention-days: 30
```

```java
import com.xxl.job.core.executor.impl.XxlJobSpringExecutor;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@ConfigurationProperties(prefix = "xxl.job")
record XxlJobProperties(String adminAddresses, String accessToken, Executor executor) {
    record Executor(String appname, int port, String logPath, int logRetentionDays) { }
}

@Configuration
@EnableConfigurationProperties(XxlJobProperties.class)
public class XxlJobConfig {

    @Bean
    public XxlJobSpringExecutor xxlJobExecutor(XxlJobProperties props) {
        XxlJobSpringExecutor executor = new XxlJobSpringExecutor();
        executor.setAdminAddresses(props.adminAddresses());
        executor.setAccessToken(props.accessToken());
        executor.setAppname(props.executor().appname());
        executor.setPort(props.executor().port());
        executor.setLogPath(props.executor().logPath());
        executor.setLogRetentionDays(props.executor().logRetentionDays());
        return executor;
    }
}
```

```java
import com.xxl.job.core.context.XxlJobHelper;
import com.xxl.job.core.handler.annotation.XxlJob;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class OrderJobHandler {

    private final OrderSyncService orderSyncService;

    public OrderJobHandler(OrderSyncService orderSyncService) {
        this.orderSyncService = orderSyncService;
    }

    @XxlJob("orderSyncHandler")
    public void syncOrders() {
        int shardIndex = XxlJobHelper.getShardIndex();   // 分片广播时当前实例的序号
        int shardTotal = XxlJobHelper.getShardTotal();
        int page = 0;
        while (true) {
            List<Order> batch = orderSyncService.fetchPending(shardIndex, shardTotal, page++, 500);
            if (batch.isEmpty()) {
                break;
            }
            orderSyncService.syncToWarehouse(batch);
            XxlJobHelper.log("已同步第 {} 页，{} 条", page, batch.size());
        }
        XxlJobHelper.handleSuccess();
    }
}
```

`accessToken` 是调度中心调用执行器的唯一凭证，执行器端口还应只对调度中心开放。调度中心的部署、路由与阻塞策略见 [分布式调度](/distributed/6_job_scheduler)。

---

## 四、虚拟线程

> 虚拟线程的原理、钉住问题与诊断见 [虚拟线程](/java/30_topic_virtual_thread)，本节只讲 Boot 侧集成。

### 1、一个开关

```yaml
spring:
  threads:
    virtual:
      enabled: true     # Boot 3.2+，需要 JDK 21+
```

开启后由 Boot **自动配置**的组件切换为虚拟线程：

| 组件 | 变化 |
|------|------|
| Tomcat / Jetty | 每个请求跑在虚拟线程上，`server.tomcat.threads.max` 不再是并发上限 |
| `@Async`（`applicationTaskExecutor`） | 换成基于虚拟线程的 `SimpleAsyncTaskExecutor`，`spring.task.execution.pool.*` 不再生效 |
| `@Scheduled`（`taskScheduler`） | 换成基于虚拟线程的 `SimpleAsyncTaskScheduler`，`spring.task.scheduling.pool.*` 不再生效 |
| Kafka / RabbitMQ 监听容器 | 使用虚拟线程 |

再次强调：**自己声明的线程池不受这个开关影响**。需要虚拟线程版的业务执行器时，注入 Boot 自动配置的 `SimpleAsyncTaskExecutorBuilder`（开关打开时它默认构建虚拟线程执行器）来创建，而不是手工 new 一个 `ThreadPoolTaskExecutor`。

虚拟线程都是守护线程，如果应用里没有 Web 服务器之类的非守护线程（例如纯定时任务应用），需要设置 `spring.main.keep-alive=true`，否则 JVM 启动后会直接退出。

### 2、收益边界

虚拟线程的价值是**让阻塞变得便宜**：线程在等 IO（数据库、HTTP 调用）时让出载体线程。典型的「一个请求大部分时间在等下游」的 Web 应用收益明显；CPU 密集型任务没有收益，还失去了线程池的并发上限保护，计算任务继续用固定大小的平台线程池。

### 3、三个必知的坑

1. **钉住（pinning）**：JDK 21–23 上，虚拟线程在 `synchronized` 块内阻塞会连同载体线程一起被钉住，高并发下吞吐退化；JDK 24 起（JEP 491）已解决。仍在 21 上运行时要排查热点路径上的 `synchronized` + 阻塞，生产基线建议 JDK 25
2. **并发上限消失**：虚拟线程不该池化，原来靠线程池大小兜底的「最多 N 个任务同时打下游」没有了。对下游的并发控制改用连接池上限、`Semaphore`，或 Framework 7 的 `@ConcurrencyLimit`（需 `@EnableResilientMethods`，见 [Spring Boot 版本演进](./11_versions)）；开关打开时也可以用 `spring.task.execution.simple.concurrency-limit` 给 `@Async` 整体设上限
3. **`ThreadLocal` 成本**：每个任务一个虚拟线程，靠 `ThreadLocal` 缓存昂贵对象的做法失效且放大内存；上下文传递在 JDK 25 起可用 `ScopedValue`，见 [虚拟线程](/java/30_topic_virtual_thread)

**与线程池的取舍**：IO 密集的异步任务直接用虚拟线程开关，不再手工调 `corePoolSize`；需要明确的限流语义（最多同时 N 个任务）时，用 `@ConcurrencyLimit` / `Semaphore`，或保留一个有界的平台线程池。

---

## 小结

- `@Async` 默认用 `applicationTaskExecutor`；自定义 `Executor` Bean 会让它整体退让，`spring.task.execution.mode=force`（3.5+）可以保留；`AsyncConfigurer` 优先级最高
- 默认执行器的 `max-size` 和 `queue-capacity` 都是无界的，用 `spring.task.execution.pool.*` 设上限；自定义线程池必须作为 Bean 暴露，才能被优雅关闭和监控
- `void` 方法的异常进 `AsyncUncaughtExceptionHandler`，`CompletableFuture` 的异常在 Future 里；同类自调用不走代理
- `@Scheduled` 默认只有 1 个调度线程，用 `spring.task.scheduling.pool.size` 调大，长任务交给业务线程池；cron 是 6 段，记得写 `zone`
- 多实例「只跑一次」用 ShedLock；需要管理台、分片、重试用 XXL-JOB 等平台，`xxl-job-core` 需要手动声明 `XxlJobSpringExecutor`
- 虚拟线程开关只影响 Boot 自动配置的组件；对下游的并发上限改用 `@ConcurrencyLimit`、`Semaphore` 或连接池，JDK 25 是推荐的生产基线

## 参考资料

- Spring Boot Task Execution and Scheduling：[https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html)
- Spring Framework Task Execution and Scheduling：[https://docs.spring.io/spring-framework/reference/integration/scheduling.html](https://docs.spring.io/spring-framework/reference/integration/scheduling.html)
- ShedLock：[https://github.com/lukas-krecan/ShedLock](https://github.com/lukas-krecan/ShedLock)
- XXL-JOB：[https://www.xuxueli.com/xxl-job/](https://www.xuxueli.com/xxl-job/)

> 下一篇：[接口文档](./10_api_doc) —— 用 springdoc-openapi 从代码生成 OpenAPI 文档，并控制好分组、鉴权与生产环境开关。

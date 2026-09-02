# 异步任务与定时任务

> 参考资料：
> * Spring 异步支持：[https://docs.spring.io/spring-framework/docs/current/reference/html/integration.html#scheduling](https://docs.spring.io/spring-framework/docs/current/reference/html/integration.html#scheduling)

## 一、异步任务 @Async

### 1.1 开启并配置线程池

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public Executor getAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(5);          // 核心线程数
        executor.setMaxPoolSize(20);           // 最大线程数
        executor.setQueueCapacity(500);        // 任务队列容量
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("async-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }

    // 异步异常处理器
    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            log.error("异步方法 [{}] 执行异常，参数: {}", method.getName(),
                Arrays.toString(params), ex);
            // 可在此报警、入库等
        };
    }
}
```

### 1.2 使用 @Async

```java
@Service
@Slf4j
public class EmailService {

    // void 异步方法（fire-and-forget）
    @Async
    public void sendWelcomeEmail(String email, String username) {
        log.info("发送欢迎邮件给 {}，线程: {}", email, Thread.currentThread().getName());
        // 模拟耗时
        try {
            Thread.sleep(2000);
            emailClient.send(email, "欢迎注册", "Hello " + username);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // 有返回值的异步方法
    @Async
    public CompletableFuture<String> generateReport(Long userId) {
        String report = reportService.generate(userId);
        return CompletableFuture.completedFuture(report);
    }

    // 指定线程池（多个线程池场景）
    @Async("ioExecutor")
    public void uploadToOss(String filePath) {
        ossClient.upload(filePath);
    }
}
```

### 1.3 等待多个异步结果

```java
@Service
@RequiredArgsConstructor
public class DashboardService {

    private final UserService userService;
    private final OrderService orderService;
    private final ProductService productService;

    public DashboardVO getDashboard(Long userId) {
        // 三个查询并行执行
        CompletableFuture<UserVO>        userFuture    = userService.getUserAsync(userId);
        CompletableFuture<List<OrderVO>> orderFuture   = orderService.getRecentAsync(userId);
        CompletableFuture<List<ProductVO>> productFuture = productService.getRecommendAsync(userId);

        // 等待全部完成
        CompletableFuture.allOf(userFuture, orderFuture, productFuture).join();

        return DashboardVO.builder()
            .user(userFuture.join())
            .recentOrders(orderFuture.join())
            .recommendations(productFuture.join())
            .build();
    }
}
```

> ⚠️ 同类内部调用 `@Async` 方法会失效（AOP 代理问题），解决方案同事务。

---

## 二、定时任务 @Scheduled

### 2.1 开启与使用

```java
@Configuration
@EnableScheduling
public class ScheduleConfig {}

@Component
@Slf4j
public class DataCleanupTask {

    // fixedRate：上次开始后 N 毫秒执行（不管上次是否结束）
    @Scheduled(fixedRate = 5000)
    public void heartbeat() {
        log.debug("心跳检测");
    }

    // fixedDelay：上次结束后 N 毫秒执行
    @Scheduled(fixedDelay = 10000, initialDelay = 30000)
    public void cleanTempFiles() {
        log.info("清理临时文件");
        fileService.cleanOlderThan(Duration.ofDays(7));
    }

    // cron 表达式：精确调度
    @Scheduled(cron = "0 0 2 * * ?")      // 每天凌晨 2 点
    public void dailyReport() {
        reportService.generateDailyReport();
    }

    @Scheduled(cron = "0 */5 9-18 * * MON-FRI")   // 工作日 9:00-18:00 每 5 分钟
    public void syncFromERP() {
        erpService.syncOrders();
    }
}
```

### 2.2 Cron 表达式

```
秒  分  时  日  月  周
0   0   2   *   *   ?   每天凌晨 2 点
0  */5  *   *   *   ?   每 5 分钟
0   0   0   1   *   ?   每月 1 号 0 点
0   0   8   ?   *  MON  每周一 8 点
0   0   0   L   *   ?   每月最后一天
```

### 2.3 从配置文件读取 Cron

```java
@Scheduled(cron = "${task.report.cron:0 0 2 * * ?}")
public void reportTask() { ... }
```

```yaml
task:
  report:
    cron: "0 30 1 * * ?"   # 每天 1:30，可按环境覆盖
```

---

## 三、分布式定时任务

`@Scheduled` 在多实例部署时**每个实例都会执行**，需引入分布式调度框架：

| 框架 | 说明 | 推荐场景 |
|------|------|---------|
| XXL-Job | 国内主流，可视化界面，易上手 | 中小项目 |
| Elastic-Job | 支持分片，云原生友好 | 大数据量分片处理 |
| Quartz | 老牌框架，集群模式成熟 | 精确 Cron + 集群 |

> 详见：[分布式任务调度](/distributed/5_job_scheduler)

### 3.1 XXL-Job 快速接入

```xml
<dependency>
    <groupId>com.xuxueli</groupId>
    <artifactId>xxl-job-core</artifactId>
    <version>2.4.1</version>
</dependency>
```

```yaml
xxl:
  job:
    admin:
      addresses: http://xxl-job-admin:8080/xxl-job-admin
    accessToken: default_token
    executor:
      appname: my-service
      port: 9999
      logpath: /data/applogs/xxl-job/jobhandler
      logretentiondays: 30
```

```java
@Component
public class OrderJobHandler {

    @XxlJob("orderSyncHandler")
    public void syncOrders() throws Exception {
        XxlJobHelper.log("开始同步订单");
        int page = 0;
        while (true) {
            List<Order> batch = orderService.fetchPending(page++, 500);
            if (batch.isEmpty()) break;
            orderService.syncToWarehouse(batch);
            XxlJobHelper.log("已同步第 {} 页，{}条", page, batch.size());
        }
        XxlJobHelper.handleSuccess();
    }
}
```

## 四、虚拟线程（Boot 3.2+）

> 虚拟线程的语言层原理（JEP 444 / Project Loom）见 [Java 版本特性](../java/2_version)，本节只讲 Boot 侧集成。

一个开关，全家桶生效：

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

开启后 Boot 自动切换的组件：

| 组件 | 变化 |
|------|------|
| Tomcat / Jetty | 每个请求跑在虚拟线程上，不再受 `server.tomcat.threads.max`（200）限制 |
| `@Async` | 默认执行器换成虚拟线程 per-task 执行器 |
| `@Scheduled` | 调度任务跑在虚拟线程 |
| RabbitMQ / Kafka Listener | 监听容器使用虚拟线程 |

### 收益边界：只救"阻塞等待"，不救"CPU 计算"

虚拟线程的价值是**阻塞成本趋近于零**——线程在等 IO（DB 查询、HTTP 调用）时让出载体线程。适合典型的"一个请求大部分时间在等下游"的 Web 应用；CPU 密集型任务毫无收益，反而少了池化的并发上限保护。

### 三个必知的坑

1. **`synchronized` 钉住（pinning）**：虚拟线程在 `synchronized` 块内阻塞时，JDK 21 会把载体线程一起钉住，高并发下退化。JDK 24（JEP 491）已修复；21 上的库/自身代码热点路径建议用 `ReentrantLock` 替代
2. **池化语义消失**：虚拟线程不复用、不该池化。原来靠线程池上限兜底的"最大并发保护"没了——对下游（DB 连接池、第三方接口）的并发控制要改用 `Semaphore` 或连接池自身上限
3. **`ThreadLocal` 慎用**：百万级虚拟线程下每个都携带 ThreadLocal 副本，内存放大；框架级透传考虑 ScopedValue（JDK 21 预览）

**与 `@Async` 线程池的取舍**：IO 密集的异步任务直接用虚拟线程开关，不再手工调 `corePoolSize`；需要**限流语义**（最多同时 N 个任务打下游）时，保留自定义平台线程池或加信号量。

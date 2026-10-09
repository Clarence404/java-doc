---
description: 自动配置与 Starter、启动流程、配置管理、Web 与数据、异步与定时、运维可观测、测试、版本与启动优化
---

# Spring Boot 面试题解答

> 题目清单见 [Spring Boot 面试题](/spring-boot/99_interview)，模块入口见 [Spring Boot 总览](/spring-boot/0_overview)；IoC、AOP、事务、MVC 等 Spring 本身的题目见 [Spring 面试题解答](/interview/5_spring)。
>
> 版本基线：Spring Boot 4 / Spring Framework 7（JDK 17+），与 Boot 3.x 不同处单独说明。

## 一、自动配置与 Starter

### Q1：Spring Boot 自动配置的原理是什么？`@SpringBootApplication` 做了什么？为什么用户定义的 Bean 总是优先？

**一句话**：`@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan`。自动配置会等用户的配置全部处理完才执行，读取各 jar 里登记的自动配置类，按条件决定装不装；因为用户的 Bean 先注册，`@ConditionalOnMissingBean` 能看到它，自动配置就让路。

- `@ComponentScan` 从主类所在的包往下扫描
- 自动配置类登记在各 jar 的 `META-INF/spring/…AutoConfiguration.imports` 文件里
- 判断前先用编译期生成的元数据快速过滤，不用加载类，几百个候选也不拖慢启动
- 排除某个自动配置：`exclude` 属性或 `spring.autoconfigure.exclude`

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#三、自动配置原理)

### Q2：`spring.factories` 与 `AutoConfiguration.imports` 有什么区别？Boot 4 的模块化自动配置改变了什么？

**一句话**：自动配置类原来登记在 `spring.factories` 里，2.7 引入新的 `AutoConfiguration.imports`，3.0 起只认新文件，写在旧文件里的自动配置会静默失效。`spring.factories` 没废弃，仍用来登记监听器、`EnvironmentPostProcessor` 等扩展。

- Boot 4 把一个大的自动配置包拆成了按技术划分的小模块，每个模块对应一个 `spring-boot-starter-<技术>`
- 引了哪个 starter 才有哪部分自动配置
- 代码里直接引用了自动配置类的（`exclude`、`@EntityScan` 等）要改包名
- 过渡期可以用 `spring-boot-starter-classic` 拿回全部自动配置

**常见坑**：只引 `flyway-core` 而不引 `spring-boot-starter-flyway`，迁移脚本静默不执行。

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_2、登记文件的演进)

### Q3：`@ConditionalOnBean` 为什么只在自动配置类里可靠？如何排查某个自动配置为什么生效或没生效？

**一句话**：`@ConditionalOnBean` 的结果取决于判断那一刻已经注册了哪些 Bean。自动配置在用户配置之后执行，相互之间也能用 `after` 指定顺序；普通 `@Configuration` 之间的顺序不确定，可能判断错。

- 排查一：启动加 `--debug`，会打印条件评估报告，列出每个自动配置为什么生效或没生效
- 排查二：运行中看 `/actuator/conditions`；确认最终用的是哪个 Bean 看 `/actuator/beans`
- 类上的 `@ConditionalOnClass(X.class)` 是安全的（不会真的加载类）

**常见坑**：在 `@Bean` 方法上引用可能不存在的类会报 `NoClassDefFoundError`，要改用 `name = "..."` 字符串写法或拆到嵌套配置类。

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_4、条件注解)

### Q4：如何自定义一个 Spring Boot Starter？装配顺序、条件、配置元数据和测试要注意什么？

**一句话**：命名用 `<名称>-spring-boot-starter`（`spring-boot` 开头是官方保留的），拆成两个模块：autoconfigure 放自动配置类和属性类，starter 只负责聚合依赖；自动配置类登记到 `AutoConfiguration.imports`。

- 顺序：用 `@AutoConfiguration(after = ...)` 声明在哪个自动配置之后
- 条件：Bean 上加 `@ConditionalOnMissingBean`，让用户可以覆盖；开关用 `@ConditionalOnBooleanProperty`（3.5+）
- 属性类：只用 `@EnableConfigurationProperties` 登记，不要加 `@Component`
- 元数据：引入 `spring-boot-configuration-processor`，IDE 里就有配置提示
- 测试：用 `ApplicationContextRunner` 覆盖默认装配、关闭开关、用户覆盖、缺少依赖四种情况

→ 详见 [自定义 Starter](/spring-boot/8_custom_starter)

## 二、启动流程

### Q5：`SpringApplication.run()` 的启动流程是什么？各生命周期事件的顺序？

**一句话**：先判断应用类型（Servlet / 响应式 / 非 Web），然后准备配置环境 → 创建容器 → 刷新容器（创建所有 Bean、启动 Web 服务器）→ 执行 Runner → 应用就绪。

事件顺序：

- `ApplicationStartingEvent`：刚开始
- `ApplicationEnvironmentPreparedEvent`：配置文件加载完
- `ApplicationContextInitializedEvent`、`ApplicationPreparedEvent`：容器已创建、还没刷新
- `ContextRefreshedEvent`：容器刷新完，Web 服务器已启动
- `ApplicationStartedEvent` → 执行 Runner → `ApplicationReadyEvent`：可以接流量了

**常见坑**：启动失败会发布 `ApplicationFailedEvent`，由 `FailureAnalyzer` 打印易读的原因，先看这段输出。

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#二、springapplication-run-启动流程)、[IoC 容器](/spring/1_ioc)

### Q6：为什么用 `@Component` 监听不到 `ApplicationEnvironmentPreparedEvent`？

**一句话**：前四个事件发布时容器还没刷新，`@Component` 的 Bean 根本还没创建，自然收不到。这类监听器要写在 `META-INF/spring.factories` 里，或者启动前用 `application.addListeners(...)` 注册。

- 想在加载配置阶段修改配置，用 `EnvironmentPostProcessor`
- 监听 `ContextRefreshedEvent` 可能被触发多次（父子容器、手动刷新），一次性的初始化逻辑放到 `ApplicationReadyEvent`

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_2、run-主流程与生命周期事件)

### Q7：Runner 执行期间就绪探针为什么不通过？启动后的预热逻辑应该放在哪里？

**一句话**：Runner 在 `ApplicationStartedEvent` 之后、`ApplicationReadyEvent` 之前执行，而「可以接流量」要到 Ready 时才发布，所以 Runner 执行期间就绪探针不通过。这正好可以用来做缓存预热：没预热完就不接流量。

- Runner 抛异常会导致整个应用启动失败，非关键任务自己捕获异常
- 很耗时又不影响接流量的任务不要放在 Runner 里同步执行，交给异步线程
- 配合 K8s 的 `startupProbe`，防止启动慢被反复重启

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_4、applicationrunner-与-commandlinerunner)、[Actuator 监控](/spring-boot/7_actuator#四、存活-就绪探针与健康分组)

## 三、配置管理

### Q8：Spring Boot 配置源的优先级是怎样的？为什么 `-D` 系统属性会覆盖环境变量？

**一句话**：常用的从高到低是：命令行参数 > Java 系统属性（`-D`）> 操作系统环境变量 > 配置文件 > 默认值。系统属性排在环境变量前面是 Boot 规定的顺序。

- 配置文件之间：jar 外优先于 jar 内，带 Profile 的（`application-prod.yml`）优先于默认的
- 同一位置 `.properties` 优先于 `.yml`
- 排查某个值从哪来的，看 `/actuator/env`

**常见坑**：镜像里 `JAVA_OPTS="-Dspring.profiles.active=prod"` 写死后，K8s 注入的 `SPRING_PROFILES_ACTIVE` 环境变量不生效。

→ 详见 [配置管理](/spring-boot/6_config#一、配置源优先级)

### Q9：`@Value` 与 `@ConfigurationProperties` 有什么区别？松散绑定与校验怎么用，如何绑定到 record？

**一句话**：`@Value` 适合零散的单个值；成组的配置用 `@ConfigurationProperties`，推荐写成 record + `@Validated`，配置不合法时启动就失败。

| 对比 | `@Value` | `@ConfigurationProperties` |
|------|---------|---------------------------|
| 松散绑定 | 有限 | 完整支持 |
| 校验 | 不支持 | 支持 `@Validated` |
| IDE 提示 | 没有 | 有 |

- 松散绑定：配置文件写 `my.first-name`，环境变量写 `MY_FIRSTNAME`（点换下划线、去掉横线、全大写）都能绑定上
- Boot 3.0 起只有一个构造器时自动用构造器绑定，record 直接能用
- 用 `@ConfigurationPropertiesScan` 或 `@EnableConfigurationProperties` 注册，不要再加 `@Component`

**常见坑**：嵌套对象要加 `@Valid` 才会一起校验。

→ 详见 [配置管理](/spring-boot/6_config#二、属性注入)

### Q10：`spring.config.import` 有什么用？（`optional:`、`configtree:`、Nacos / Vault）

**一句话**：Boot 2.4 起在配置文件里引入额外配置来源的统一写法，导入的内容优先级高于发起导入的文件。不加 `optional:` 时目标不存在就启动失败。

- `optional:file:./extra.yml`：可选的额外配置文件
- `configtree:/etc/secrets/`：读取 K8s 挂载的 Secret，文件名是键、文件内容是值
- `nacos:order-service.yaml`：接入 Nacos 配置中心
- `vault://`：从 Vault 拉取密钥
- Spring Cloud 2020.0 起默认不用 bootstrap 配置了，配置中心统一走这个入口

→ 详见 [配置管理](/spring-boot/6_config#四、spring-config-import)、[配置中心](/spring-cloud/4_config_center)

## 四、Web 与数据访问

### Q11：Boot 4 为什么移除了 Undertow？开启虚拟线程后 Tomcat 的线程配置还有效吗？

**一句话**：Boot 4 基于 Servlet 6.1，而 Undertow 还不支持，所以被移除，只剩 Tomcat 和 Jetty（Boot 3 仍可用 Undertow）。开启虚拟线程后，每个请求跑在虚拟线程上，`server.tomcat.threads.max` 不再限制并发数。

- 并发上限变成了下游：数据库连接池、HTTP 客户端连接池成为真正的瓶颈，要单独设上限，或用 `@ConcurrencyLimit` / `Semaphore`
- JDK 21–23 上 `synchronized` 里阻塞会把虚拟线程卡住，JDK 24 起解决，生产建议 JDK 25
- 没有特别理由就用默认的 Tomcat

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#五、内嵌-web-服务器)、[虚拟线程](/java/30_topic_virtual_thread)

### Q12：加了 `@EnableWebMvc` 会发生什么？

**一句话**：Boot 的 Spring MVC 自动配置会整个失效：静态资源映射、Jackson 消息转换器的默认配置、`spring.mvc.*` 配置全都不生效。

- 常见症状：静态资源 404，日期格式和 `spring.jackson.*` 配置不起作用
- 想定制 MVC，实现 `WebMvcConfigurer` 接口即可，不要加 `@EnableWebMvc`

→ 详见 [Web 开发](/spring-boot/2_web_dev#_1、starter-与默认装配)

### Q13：Filter 中的异常为什么进不了 `@RestControllerAdvice`？Filter 相对 Spring Security 的顺序如何确定？

**一句话**：`@RestControllerAdvice` 是在 `DispatcherServlet` 里面处理异常的，Filter 在 `DispatcherServlet` 外面执行，它抛的异常只会被容器转到 `/error`。Filter 里的错误要在 Filter 里自己写响应。

- Spring Security 整条链作为一个 Filter 注册，顺序默认是 -100（`spring.security.filter.order`）
- 自定义 Filter 的 `@Order` 比 -100 小就在认证之前执行，比它大就在认证之后
- `/error` 返回哪些字段由 `server.error.include-*` 控制，生产保持 `never`

→ 详见 [Web 开发](/spring-boot/2_web_dev#四、错误响应-error-与-problemdetail)

### Q14：`allowedOriginPatterns("*")` + `allowCredentials(true)` 有什么风险？

**一句话**：这样配置等于对任何来源都放行，而且允许带 Cookie，任何网站都能带着用户的登录态调用你的接口并读到结果。带凭证时必须写明确的域名白名单。

- `allowedOrigins("*")` + 凭证框架会直接报错；换成 `allowedOriginPatterns("*")` 能跑，但更危险
- 可以用可信的子域名通配，如 `https://*.example.com`
- 用 Bearer Token、不依赖 Cookie 的接口通常不需要 `allowCredentials(true)`
- 用了 Spring Security 要在安全配置里开启 CORS；微服务下只在网关配一次

→ 详见 [Web 开发](/spring-boot/2_web_dev#_2、携带凭证时的安全陷阱)

### Q15：JPA 实体为什么不能用 `@Data`？open-in-view、N+1 与 `LazyInitializationException` 怎么处理？

**一句话**：`@Data` 生成的 `toString`、`equals`、`hashCode` 会访问所有字段，包括懒加载的关联：事务外调用抛 `LazyInitializationException`，双向关联还会无限递归。实体用 `@Getter` / `@Setter`，`equals` 基于 id 写。

- `LazyInitializationException`：在事务里用 `JOIN FETCH` 或 `@EntityGraph` 一次查齐，或直接查 DTO
- 关掉 `open-in-view`：它让数据库连接一直占到请求结束，还把 N+1 问题藏到了 Controller 层
- N+1（查 1 次列表再逐条查 N 次关联）：用 `@EntityGraph`、`JOIN FETCH` 或批量抓取
- 只读查询加 `@Transactional(readOnly = true)`，省掉脏检查开销

**常见坑**：主键用 `IDENTITY` 自增时，Hibernate 无法批量插入，批量写用 `JdbcClient` 或换 ID 生成方式。

→ 详见 [数据访问](/spring-boot/3_data_access#_4、常见问题)

### Q16：Boot 如何选择事务管理器？dynamic-datasource 在外层事务中 `@DS` 为什么失效？

**一句话**：只有 JDBC / MyBatis 时 Boot 配置 `JdbcTransactionManager`，引入 JPA 后配置 `JpaTransactionManager`（它也能管同一数据源上的 MyBatis 操作）。`@DS` 失效是因为外层事务开始时已经从主库拿了连接并绑定到线程，内层全都复用这个连接，根本没机会切换数据源。

- 自己声明多个数据源时，Boot 只给 `@Primary` 那个建事务管理器，其他的要自己声明，并在 `@Transactional("...")` 里指定
- 读写分离时，在写事务里调 `@DS("slave")` 的查询，实际查的还是主库
- `@DSTransactional` 只是本地多数据源事务，不是分布式事务
- `@DS` 基于 AOP，类内部调用也会失效

→ 详见 [数据访问](/spring-boot/3_data_access#_2、路由原理与事务陷阱)

### Q17：多实例同时启动时 Flyway 迁移会冲突吗？MySQL 上脚本执行失败后如何修复？

**一句话**：不会冲突。Flyway 迁移前会加数据库锁，后启动的实例等待，拿到锁后发现脚本都执行过了就直接跳过。

- 真正要注意的：大表改结构会锁表；滚动发布时新旧代码同时在跑，表结构变更必须向后兼容
- MySQL 的 DDL 不能回滚：一个脚本三条 `ALTER`，第二条失败时第一条已经生效
- 修复步骤：手工把表结构改对 → `flyway repair` 清掉失败记录 → 重新迁移；所以 MySQL 上一个脚本只做一件事
- 已执行过的脚本永远不要改；生产环境禁用 `clean`

**常见坑**：Boot 4 必须引入 `spring-boot-starter-flyway`；Flyway 10+ 还要引数据库模块（如 `flyway-mysql`），否则报 `Unsupported Database`。

→ 详见 [数据库版本迁移](/spring-boot/4_flyway#_5、并发迁移与发布)

### Q18：Flyway 与 Liquibase 怎么选？生产上是回滚还是向前修复？

**一句话**：单一数据库、习惯写 SQL 选 Flyway（大多数项目）；同一套变更要适配多种数据库，或者对回滚有明确要求时选 Liquibase。生产上更常用向前修复，再写一个新脚本改回来。

| 对比 | Flyway | Liquibase |
|------|--------|-----------|
| 变更写法 | 以 SQL 为主 | XML / YAML / SQL，可跨数据库 |
| 回滚 | 撤销功能只在付费版 | 免费 |
| 进程被杀后 | 锁自动释放 | 要手动 `release-locks` |

- 为什么少用回滚：回滚 DDL 常常丢数据（删掉新列，列里的数据也没了），只适合发布失败、还没写入数据时的快速撤回

→ 详见 [数据库版本迁移](/spring-boot/4_flyway#_4、与-flyway-对比)

## 五、中间件、异步与定时

### Q19：Lettuce 需要连接池吗？Kafka 消息反序列化失败为什么会卡住分区？

**一句话**：Lettuce 的连接是线程安全的，默认所有线程共用一个连接，普通命令不需要连接池；只有 `BLPOP` 这类阻塞命令和 `MULTI` 事务才需要。Kafka 的反序列化发生在拉取消息时，一条格式错误的消息会让每次拉取都失败，位置一直前进不了，分区就卡住了。

- Lettuce 连接池要生效还得引入 `commons-pool2`，否则 `pool` 配置被悄悄忽略
- Kafka 解法：用 `ErrorHandlingDeserializer` 包一层，配合 `DeadLetterPublishingRecoverer` 把坏消息送进死信 Topic
- `trusted.packages` 只写事件类所在的包

**常见坑**：在监听方法里 catch 异常后只打日志，消息被确认消费，就此丢失。

→ 详见 [中间件集成](/spring-boot/5_middleware)、[Kafka](/messaging/2_kafka)

### Q20：`@Async` 默认用哪个执行器？为什么开启虚拟线程后 `@Async` 可能不受影响？

**一句话**：什么都不配时用 Boot 自动配置的 `applicationTaskExecutor`，开启虚拟线程后它会换成虚拟线程版本。但只要你自己声明了任何 `Executor` Bean，这个自动配置就整个退出，`@Async` 改用你的执行器，虚拟线程开关对它就不起作用了。

- 多个 `Executor` 时，取 `@Primary` 的或名叫 `taskExecutor` 的
- 指定执行器：`@Async("orderExecutor")`
- 默认执行器的队列和最大线程数都是无界的，要用 `spring.task.execution.pool.*` 设上限
- `void` 方法的异常进 `AsyncUncaughtExceptionHandler`；返回 `CompletableFuture` 的异常在 Future 里

**常见坑**：忘了加 `@EnableAsync` 或在同一个类里调用，`@Async` 方法会同步执行。

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#_1、谁在执行-async-方法)、[线程池](/java/28_topic_thread_pool)

### Q21：`@Scheduled` 默认用几个线程？如何避免任务互相阻塞？

**一句话**：没开虚拟线程时，默认只有 1 个调度线程，所有 `@Scheduled` 任务排队执行：一个任务卡 10 分钟，其他任务全部晚 10 分钟。

- 用 `spring.task.scheduling.pool.size` 按任务数调大
- 长任务把实际工作交给业务线程池，调度线程只负责按时触发；这时同一任务可能并发执行，要自己防重入
- `fixedRate` 按固定频率触发；`fixedDelay` 等上次执行完再开始计时
- Spring 的 cron 有 6 位（第一位是秒），建议写上 `zone` 时区

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#_2、默认只有一个调度线程)

### Q22：多实例部署时如何让定时任务只执行一次？（ShedLock vs XXL-JOB）

**一句话**：`@Scheduled` 只管本进程，部署 N 个实例就执行 N 次。只要「只执行一次」用 ShedLock 加分布式锁；需要管理界面、手动触发、失败重试、告警、分片时用 XXL-JOB 这类调度平台。

- ShedLock：`lockAtMostFor`（锁最长持有时间）要明显大于任务正常耗时；只保证同一时刻最多一个实例在跑，不补跑、不分片
- XXL-JOB：没有 Boot 自动配置，要手动声明 `XxlJobSpringExecutor`；访问令牌从环境变量读，执行器端口只对调度中心开放
- 需要持久化触发器、错过了要补跑，可以用 Quartz 集群

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#三、多实例下的定时任务)、[分布式调度](/distributed/6_job_scheduler)

## 六、运维与可观测

### Q23：Actuator 的暴露（exposure）与访问（access）有什么区别？生产环境如何保护管理端点？

**一句话**：暴露决定端点能不能通过 HTTP 访问到（默认只暴露 `health`）；访问级别（3.4+）决定允许做什么操作：不允许、只读、不限制。两者是两件事。

- 用独立的管理端口：网关只转发业务端口，监控和 K8s 探针访问管理端口
- 给管理端点单独配一条 `SecurityFilterChain` 做鉴权
- `heapdump`、`shutdown` 不要开放；`env`、`configprops` 默认会把敏感值打码，不要关掉

**常见坑**：生产环境配 `exposure.include: "*"` 把所有端点都暴露出去。

→ 详见 [Actuator 监控](/spring-boot/7_actuator#_2、暴露与访问是两件事)

### Q24：存活探针与就绪探针有什么区别？为什么外部依赖不能放进存活探针？

**一句话**：存活探针问「进程还活着吗」，失败了 K8s 会重启容器；就绪探针问「能接流量吗」，失败了只是不给它分流量，不重启。

- 如果存活探针里检查了数据库，数据库一抖，所有 Pod 会被同时重启，一个依赖故障被放大成全部重启
- Boot 4 起探针分组默认开启（Boot 3 只在检测到 K8s 时开启）
- 共享依赖要不要放进就绪探针也要谨慎，系统级取舍见高可用答案页

→ 详见 [Actuator 监控](/spring-boot/7_actuator#四、存活-就绪探针与健康分组)、[高可用面试题解答](/interview/14_high_avail#q9-k8s-的-liveness-和-readiness-探针有什么区别-为什么探针不建议检查数据库等共享依赖)

### Q25：如何用 Micrometer 写自定义业务指标？如何避免高基数？Observation API 做什么？

**一句话**：注入 Boot 提供的 `MeterRegistry`，在构造器里创建计数器、计时器并存成 `final` 字段。避免高基数就是标签值必须是有限的几种。

- 标签值有限：`channel`、`result` 可以；用户 ID、订单号、完整 URL 不行，每种组合都会多一条时间序列，监控系统会被撑爆
- 同一个指标名，标签的键要一致
- 命名用点分小写，如 `order.created`，导出到 Prometheus 会变成 `order_created_total`
- Observation API：埋一次点，同时得到计时指标和链路追踪数据，Spring MVC、`RestClient`、Kafka 内部都用它

→ 详见 [Actuator 监控](/spring-boot/7_actuator#六、指标-micrometer-与-prometheus)

### Q26：Boot 3.4+ 的结构化日志怎么用？traceId 如何进入日志，跨线程如何传递？

**一句话**：把 `logging.structured.format.console`（或 `file`）设成 `ecs`、`logstash` 或 `gelf`，日志就输出成 JSON，MDC 里的值自动变成字段。引入 Micrometer Tracing 后，它会自动把 traceId 放进 MDC，不用自己生成。

- 线程池 / `@Async`：给执行器配一个 `TaskDecorator`，把调用方的 MDC 复制到子线程
- 响应式链路：设 `spring.reactor.context-propagation=auto`
- 跨服务：Micrometer Tracing 会自动在请求头里带上 `traceparent`
- 常见组合：本地开发用文本格式，生产容器输出 JSON 到标准输出

→ 详见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)

### Q27：如何在生产环境真正关闭接口文档？

**一句话**：用 springdoc 自己的开关 `springdoc.api-docs.enabled=false`（Swagger UI 同理）。更稳的做法是默认关闭，只在 dev / test 的配置文件里打开。

- 给文档路径单独配一条安全规则，生产环境不放行
- 版本：Boot 4 用 springdoc-openapi 3.x，Boot 3 用 2.x

**常见坑**：给自己的 `OpenApiConfig` 加 `@Profile("!prod")` 只去掉了自定义配置，springdoc 自动配置还在，`/v3/api-docs` 照样能访问。

→ 详见 [接口文档](/spring-boot/10_api_doc#五、按环境关闭)

## 七、测试

### Q28：`@SpringBootTest` 与切片测试怎么选？Boot 4 的测试有哪些变化？

**一句话**：能不启动 Spring 就不启动：纯单元测试 → 切片测试（只加载某一层，如 `@WebMvcTest`、`@DataJpaTest`）→ `@SpringBootTest` + Testcontainers，越往后越慢，数量越少。只有要验证 Spring 帮你做的事（绑定、校验、事务、序列化）时才往后走。

Boot 4 的变化：

- 升级到 JUnit 6
- 测试也按技术拆成模块，切片注解换了包名
- `@SpringBootTest` 不再自动提供 MockMvc 等测试客户端，要显式加 `@AutoConfigureMockMvc` 等
- `@MockBean` 被删除，改用 `@MockitoBean`

**常见坑**：`@WebMvcTest` 不会加载 `@Service`，Controller 的依赖要用 `@MockitoBean` 提供。

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#一、测试依赖与分层)

### Q29：`@MockBean` 为什么被 `@MockitoBean` 取代？为什么 Mock 一多测试就变慢？

**一句话**：Spring Framework 6.2 自己提供了 `@MockitoBean`，Boot 3.4 起 `@MockBean` 废弃，Boot 4 删除。变慢是因为 Spring 测试会缓存并复用容器，而 Mock 了哪些 Bean 是缓存的依据之一，Mock 组合不同就要重新启动一个容器。

- 例子：A 类 Mock 了支付客户端，B 类 Mock 了短信客户端，C 类什么都不 Mock，就要启动三次容器
- 解法：把「外部依赖统一 Mock」收进一个测试基类或组合注解，所有集成测试共用一个容器
- 其他打破缓存的因素：不同的 `@ActiveProfiles`、不同的属性、`@DirtiesContext`

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#四、mock-bean-mockitobean-与-mockitospybean)

### Q30：Testcontainers 如何与 Spring Boot 集成？`@ServiceConnection` 做了什么？

**一句话**：`@ServiceConnection`（Boot 3.1+）让 Boot 直接从容器里读出连接信息，自动连上数据库、Redis、Kafka，不用再手写 `@DynamicPropertySource` 一个个填地址和密码。

- 推荐把容器声明成 `@Bean`，由 Spring 管理生命周期；所有集成测试 `@Import` 同一个配置类，共用一套容器
- 通用容器 `GenericContainer` 看不出是什么服务，要写 `@ServiceConnection(name = "redis")`
- 同一份配置还能用于本地开发启动，本机不用装数据库

**常见坑**：用 `@Container` 静态字段时，测试类结束容器就停了，但缓存的 Spring 容器还在，下一个测试类会连到已停止的容器。

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#五、testcontainers-集成)、[Testcontainers](/testing/5_testcontainers)

### Q31：测试方法上的 `@Transactional` 什么时候不会回滚？

**一句话**：测试事务默认会回滚，但只能回滚同一线程、同一事务里的写入。以下情况不会回滚：用 `RANDOM_PORT` 启动真实服务器（请求在服务器线程里执行）、`REQUIRES_NEW` 开的新事务、`@Async` 等其他线程里的写入。

- 想保留数据看结果，加 `@Commit`
- 要验证真实的事务行为（传播、回滚规则），就别用测试事务，自己清理数据

**常见坑**：JPA 的写入可能还没真正发到数据库，断言前要调用 `flush()`，否则测试通过了但 SQL 根本没执行。

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#六、事务回滚语义与陷阱)

## 八、版本与启动优化

### Q32：Spring Boot 2.x → 3.x → 4.x 的关键变化是什么？老项目如何升级？

**一句话**：2 → 3 是破坏性升级：JDK 8 升 17，`javax` 包名改 `jakarta`；3 → 4 是整理性升级：JDK 仍是 17，但 starter 拆分、Jackson 3、一批废弃 API 删除，会带来很多编译错误。截至 2026-10，2.x 和 3.x 的开源支持都已结束。

- 2.7 → 3.x 常见问题：`jakarta` 包名；自动配置改登记文件；`spring.redis.*` 改成 `spring.data.redis.*`；Security 适配器类没了
- 3.5 → 4.x 常见问题：starter 改名和拆分；Jackson 3；`@MockBean` 删除；Undertow 删除
- 升级路线：2.x → 2.7 → 3.5 → 4.x，不要跳级，每一步先清掉所有废弃警告
- 工具：`spring-boot-properties-migrator` 提示配置改名，OpenRewrite 自动改代码；Spring Cloud 等依赖按兼容表一起升

→ 详见 [Spring Boot 版本演进](/spring-boot/11_versions#五、升级指南)

### Q33：Spring Boot 应用启动慢怎么优化？懒加载、CDS / AOT 缓存、Native Image 怎么选？

**一句话**：先测量再优化：用 `/actuator/startup` 找出最慢的 Bean（常见原因是启动时调远程服务、建连接），先去掉无用依赖、处理启动期 IO，再按场景选构建期的方案。

| 方案 | 启动速度 | 主要代价 |
|------|---------|---------|
| 懒加载 | 较快 | 配置错误推迟到第一个请求才暴露，建议只在开发 / 测试开 |
| CDS / AOT 缓存 | 快，几乎不改代码 | 镜像构建时要多一次训练运行；缓存和 JDK 版本绑定 |
| Native Image | 毫秒级，内存最低 | 构建慢，反射要额外配置，峰值性能偏低 |

- JVM 部署的默认选择：JDK 25+ 用 AOT 缓存，JDK 21 用 CDS，放进镜像构建流程
- Native Image 只在 Serverless、频繁扩缩容这种启动速度和内存特别关键的场景使用

→ 详见 [启动与部署优化](/spring-boot/14_startup#九、方案对比与选型)

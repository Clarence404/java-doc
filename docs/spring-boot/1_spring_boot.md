---
description: 启动流程与生命周期事件、自动配置加载链路、条件注解、Boot 4 模块化、配置绑定、内嵌 Web 服务器
---

# 启动流程与自动配置

> 前置阅读：[IoC 容器](/spring/1_ioc)

Spring Boot 的核心是 `SpringApplication.run()` 启动流程与自动配置。本篇讲启动步骤与生命周期事件、自动配置链路、Boot 4 模块化、属性绑定与内嵌 Web 服务器，基线为 Spring Boot 4.x。

---

## 一、启动入口与 @SpringBootApplication

本篇对应 Spring Framework 7.x，与 3.x 不同处单独标出；自动配置部分从 `AutoConfiguration.imports` 一直讲到条件判定。

### 1、启动入口

```java
@SpringBootApplication
@ConfigurationPropertiesScan          // 扫描 @ConfigurationProperties 类，见第四节
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

主类应放在**根包**下（如 `com.example`），因为组件扫描和 `@EntityScan` 等默认都从主类所在包开始向下扫描。

### 2、@SpringBootApplication 拆解

| 组成注解 | 作用 | 细节 |
|---------|------|------|
| `@SpringBootConfiguration` | 标记主配置类 | 本身被 `@Configuration` 元注解；测试切片（`@WebMvcTest` 等）靠它向上查找应用配置，一个应用只能有一个 |
| `@EnableAutoConfiguration` | 开启自动配置 | 通过 `AutoConfigurationImportSelector` 导入候选自动配置类，见第三节 |
| `@ComponentScan` | 扫描组件 | 默认带 `TypeExcludeFilter`（测试切片用来排除无关 Bean）与 `AutoConfigurationExcludeFilter`（防止自动配置类被当作普通组件扫进来） |

`@SpringBootApplication(exclude = ...)`、`scanBasePackages`、`proxyBeanMethods` 都是这三个注解属性的别名。

---

## 二、SpringApplication.run() 启动流程

![SpringApplication.run() 启动流程与事件](../assets/spring-boot/startup-flow.svg)

### 1、构造阶段

`new SpringApplication(primarySources)` 只做准备工作，不创建容器：

1. **推断应用类型**：classpath 只有 WebFlux 而没有 Spring MVC 为 `REACTIVE`；有 Servlet 相关类为 `SERVLET`；都没有为 `NONE`。可用 `spring.main.web-application-type` 覆盖
2. **加载扩展点**：通过 `SpringFactoriesLoader` 从各 jar 的 `META-INF/spring.factories` 读取 `BootstrapRegistryInitializer`、`ApplicationContextInitializer`、`ApplicationListener`
3. **推断主类**：从调用栈找到 `main` 方法所在类，用于日志与 Banner

### 2、run() 主流程与生命周期事件

| 顺序 | 步骤 | 发布的事件 | 典型用途 |
|------|------|-----------|---------|
| 1 | `listeners.starting()` | `ApplicationStartingEvent` | 最早的钩子，只能做极轻量的初始化（如日志系统预初始化） |
| 2 | `prepareEnvironment()` | `ApplicationEnvironmentPreparedEvent` | 配置文件在这一步加载（`ConfigDataEnvironmentPostProcessor`）；`EnvironmentPostProcessor` 在这里改写配置 |
| 3 | `printBanner()` + `createApplicationContext()` | 无 | `ApplicationContextFactory` 按应用类型创建容器，不要硬编码具体容器类 |
| 4 | `prepareContext()` | `ApplicationContextInitializedEvent`、`ApplicationPreparedEvent` | 执行 `ApplicationContextInitializer`、注册主配置类；此时 BeanDefinition 还没解析 |
| 5 | `refreshContext()` | `WebServerInitializedEvent`、`ContextRefreshedEvent` | 解析配置类与自动配置、创建并启动 Web 服务器、实例化单例 |
| 6 | `listeners.started()` | `ApplicationStartedEvent` | 同时发布 `LivenessState.CORRECT` |
| 7 | `callRunners()` | 无 | 执行 `ApplicationRunner` / `CommandLineRunner` |
| 8 | `listeners.ready()` | `ApplicationReadyEvent` | 同时发布 `ReadinessState.ACCEPTING_TRAFFIC`，此后就绪探针才返回成功 |

启动失败时发布 `ApplicationFailedEvent`，并由 `FailureAnalyzer` 输出可读的失败原因（如端口被占用、缺少 Bean）。

前 4 个事件发生时 Bean 还不存在，**用 `@Component` + `@EventListener` 监听不到**，监听器必须写进 `META-INF/spring.factories` 的 `ApplicationListener` 键，或在启动前 `application.addListeners(...)` 注册。

### 3、refresh 阶段做了什么

`refreshContext()` 调用的是 Spring Framework 的 `AbstractApplicationContext#refresh()`，Boot 只在其中插入了 Web 服务器：

- `invokeBeanFactoryPostProcessors`：`ConfigurationClassPostProcessor` 解析主类，处理 `@ComponentScan`、`@Import`，自动配置也在这一步导入并做条件判定
- `onRefresh`：`ServletWebServerApplicationContext` 在这里创建内嵌 Tomcat / Jetty（只创建，还不接收请求）
- `finishBeanFactoryInitialization`：实例化所有非懒加载单例，依赖注入、`@PostConstruct`、AOP 代理都在这里完成
- `finishRefresh`：`SmartLifecycle` 启动，Web 服务器开始监听端口，发布 `WebServerInitializedEvent`，最后发布 `ContextRefreshedEvent`

refresh 内部的 Bean 生命周期与循环依赖处理见 [IoC 容器](/spring/1_ioc)。

### 4、ApplicationRunner 与 CommandLineRunner

```java
@Slf4j
@Component
@Order(1)                         // 多个 Runner 时按 @Order 执行
@RequiredArgsConstructor
public class CacheWarmUpRunner implements ApplicationRunner {

    private final CacheService cacheService;    // 项目内的缓存服务

    @Override
    public void run(ApplicationArguments args) {
        if (args.containsOption("skip-warm-up")) {   // --skip-warm-up
            return;
        }
        log.info("预热缓存");
        cacheService.warmUp();
    }
}
```

- `ApplicationRunner` 拿到解析好的 `ApplicationArguments`，`CommandLineRunner` 拿到原始 `String...`，按需二选一
- Runner 在 `ApplicationReadyEvent` 之前执行：**预热期间就绪探针不会通过**，这正是想要的效果；但 Runner 抛异常会让整个应用启动失败，非关键任务自己捕获异常
- 耗时很长的任务不要放在 Runner 里阻塞启动，交给异步线程池，见 [异步任务与定时任务](./9_async_schedule)

### 5、启动问题排查

| 现象 | 手段 |
|------|------|
| 某个自动配置没生效 / 意外生效 | `--debug` 启动或 `logging.level.org.springframework.boot.autoconfigure=debug`，查看条件评估报告；运行中查 `/actuator/conditions` |
| 启动慢，不知道慢在哪 | `BufferingApplicationStartup` + `/actuator/startup` 记录每个步骤耗时，见 [启动与部署优化](./14_startup) |
| 配置值不对 | `/actuator/env` 查看属性来源与优先级，见 [配置管理](./6_config) |

---

## 三、自动配置原理

### 1、加载链路

![自动配置的加载链路](../assets/spring-boot/auto-config-flow.svg)

- `AutoConfigurationImportSelector` 是 `DeferredImportSelector`：**等所有用户配置类都解析完才执行**，所以自动配置里的 `@ConditionalOnMissingBean` 能看到用户自己声明的 Bean，用户 Bean 永远优先
- 候选列表来自所有 jar 里的 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`，每行一个全限定类名
- 快速过滤阶段读取编译期生成的 `META-INF/spring-autoconfigure-metadata.properties`，不加载类就能判断 `@ConditionalOnClass` 等条件，这是数百个候选类不拖慢启动的关键
- 排除方式：`@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)`、`excludeName`（类不在 classpath 时用字符串），或配置 `spring.autoconfigure.exclude`

### 2、登记文件的演进

| 版本 | 自动配置登记位置 | 说明 |
|------|-----------------|------|
| 2.6 及以前 | `META-INF/spring.factories` 的 `EnableAutoConfiguration` 键 | 与其他扩展点混在一个文件 |
| 2.7 | 新增 `AutoConfiguration.imports` 与 `@AutoConfiguration` | 两种方式并存 |
| 3.x / 4.x | 只认 `AutoConfiguration.imports` | `spring.factories` 里的 `EnableAutoConfiguration` 键不再生效 |

`spring.factories` 并没有废弃，它仍负责 `ApplicationListener`、`EnvironmentPostProcessor`、`FailureAnalyzer` 等启动期扩展点。从 2.x 升级时，自定义 Starter 必须把自动配置类迁到 `AutoConfiguration.imports`，否则会**静默失效**。完整的 Starter 写法见 [自定义 Starter](./8_custom_starter)。

### 3、Boot 4 的模块化自动配置

3.x 把几乎所有技术的自动配置都放在一个巨大的 `spring-boot-autoconfigure` jar 里，classpath 上有对应的类就会尝试装配。Boot 4 把它拆成按技术划分的模块：

- 模块命名 `spring-boot-<技术>`，根包 `org.springframework.boot.<技术>`，例如 JDBC 相关的自动配置在 `spring-boot-jdbc` 模块的 `org.springframework.boot.jdbc.autoconfigure` 包中
- 每个模块自带一份 `AutoConfiguration.imports`，starter 与模块一一对应（`spring-boot-starter-<技术>`），引入哪个 starter 才有哪部分自动配置
- 直接引用了自动配置类的代码要改包名：`exclude = ...`、测试里的 `@ImportAutoConfiguration(...)`；`@EntityScan` 移到了 `org.springframework.boot.persistence.autoconfigure`
- 迁移过渡期可以先用 `spring-boot-starter-classic` / `spring-boot-starter-test-classic` 拿回全部自动配置，再逐步换成精确的 starter

starter 改名清单与升级步骤见 [Spring Boot 版本演进](./11_versions)。

### 4、条件注解

| 注解 | 触发条件 |
|------|---------|
| `@ConditionalOnClass` / `@ConditionalOnMissingClass` | classpath 中存在 / 不存在指定类 |
| `@ConditionalOnBean` / `@ConditionalOnMissingBean` | 容器中存在 / 不存在指定 Bean |
| `@ConditionalOnSingleCandidate` | 指定类型的 Bean 只有一个，或有一个 `@Primary` |
| `@ConditionalOnProperty` | 属性存在且满足 `havingValue` |
| `@ConditionalOnBooleanProperty`（3.5+） | 布尔属性为 true，比 `@ConditionalOnProperty` 更直观 |
| `@ConditionalOnResource` | 指定资源文件存在 |
| `@ConditionalOnWebApplication` / `@ConditionalOnNotWebApplication` | 是 / 不是 Web 应用，可细分 SERVLET / REACTIVE |
| `@ConditionalOnThreading`（3.2+） | 平台线程或虚拟线程（`spring.threads.virtual.enabled`） |
| `@ConditionalOnCloudPlatform` | 运行在 Kubernetes、Cloud Foundry 等平台 |
| `@ConditionalOnExpression` | SpEL 表达式为 true，能用前面的注解就不用它 |

```java
@AutoConfiguration(after = DataRedisAutoConfiguration.class)   // Boot 4 包名见上一节
@ConditionalOnClass(RedisTemplate.class)
@ConditionalOnBooleanProperty(name = "myapp.cache.enabled", matchIfMissing = true)
@EnableConfigurationProperties(MyCacheProperties.class)
public class MyCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean          // 用户自己声明了 CacheService 就让位
    public CacheService cacheService(RedisTemplate<String, Object> redisTemplate,
                                     MyCacheProperties props) {
        return new RedisCacheService(redisTemplate, props);
    }
}
```

两个容易踩的坑：

- **`@ConditionalOnBean` 只在自动配置类里可靠**。它的结果取决于判定时已经注册了哪些 BeanDefinition；普通 `@Configuration` 之间的处理顺序不确定，可能误判
- **类级的 `@ConditionalOnClass(X.class)` 是安全的**（Boot 用 ASM 读注解，不加载类），但在 `@Bean` 方法上引用不存在的类会在反射时报 `NoClassDefFoundError`，方法级应写 `@ConditionalOnClass(name = "com.x.X")` 或拆到嵌套配置类里

---

## 四、配置属性绑定

推荐用 record 写不可变的配置类（构造器绑定），比 `@Data` + setter 更安全：

```java
@Validated
@ConfigurationProperties(prefix = "myapp.cache")
public record MyCacheProperties(
        @DefaultValue("true") boolean enabled,
        @DefaultValue("1h") Duration ttl,                // 支持 30s、10m、1h 等写法
        @DefaultValue("default") @NotEmpty List<String> names,
        @DefaultValue Map<String, Duration> ttlOverrides  // 空 @DefaultValue：未配置时为空 Map 而非 null
) {
}
```

```yaml
myapp:
  cache:
    enabled: true
    ttl: 30m
    names: [users, products]
    ttl-overrides:
      users: 10m
```

- 注册方式：主类加 `@ConfigurationPropertiesScan`，或在自动配置里用 `@EnableConfigurationProperties`
- `@Validated` 校验需要 `spring-boot-starter-validation`，校验失败会让启动直接失败，比运行时才发现配置错误好得多
- 加 `spring-boot-configuration-processor`（`optional`）生成元数据，IDE 才能补全和提示自定义属性
- 配置源优先级、Profile、`@Value` 与 `@ConfigurationProperties` 的取舍见 [配置管理](./6_config)

---

## 五、内嵌 Web 服务器

### 1、可选容器

| 技术栈 | 默认 | 可选 | 说明 |
|--------|------|------|------|
| Servlet（Spring MVC） | Tomcat 11 | Jetty 12.1 | Boot 4 基于 Servlet 6.1 |
| Reactive（WebFlux） | Reactor Netty | Tomcat、Jetty | |
| Undertow | Boot 4 已移除 | Boot 3.x 仍可用 | Undertow 尚不支持 Servlet 6.1，Boot 4.0 删除了 starter 与内嵌支持，升级前需换成 Tomcat 或 Jetty |

### 2、切换为 Jetty

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <!-- Boot 4 的 Web starter；3.x 为 spring-boot-starter-web -->
    <artifactId>spring-boot-starter-webmvc</artifactId>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-tomcat</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jetty</artifactId>
</dependency>
```

Tomcat 与 Jetty 在典型业务负载下性能差距不大，没有明确理由时保持默认的 Tomcat，社区资料与排障经验最多。

### 3、常用配置

```yaml
server:
  port: 8080
  servlet:
    context-path: /api
  shutdown: graceful            # 3.4+ 默认即 graceful，显式写出更清楚
  tomcat:
    threads:
      max: 200                  # 平台线程模式下的最大工作线程数
      min-spare: 10
    accept-count: 100           # 线程全忙时的等待队列长度
    max-connections: 8192       # 同时保持的最大连接数
    connection-timeout: 20s

spring:
  threads:
    virtual:
      enabled: true             # 3.2+，JDK 21+：Tomcat 用虚拟线程处理请求
```

- 开启虚拟线程后，`threads.max` 不再限制并发，并发上限转移到下游：数据库连接池、HTTP 客户端连接池会成为真正的瓶颈，需要单独设上限。原理与 pinning 等限制见 [虚拟线程](/java/30_topic_virtual_thread)
- 优雅停机的完整流程（摘流量、等待在途请求、K8s preStop）见 [优雅上下线与变更](/high-avail/8_graceful_release)
- 打 WAR 部署到外部 Tomcat 时，Boot 4 把 `spring-boot-starter-tomcat` 换成 `spring-boot-starter-tomcat-runtime`（`provided` 作用域）

---

## 小结

- `SpringApplication` 构造阶段推断应用类型并从 `spring.factories` 加载初始化器与监听器；`run()` 依次准备 Environment、创建并刷新容器、执行 Runner
- 生命周期事件顺序：Starting → EnvironmentPrepared → ContextInitialized → Prepared → (refresh) → Started → Ready；前四个事件监听器只能通过 `spring.factories` 或 `addListeners` 注册
- `ApplicationReadyEvent` 时才发布 `ReadinessState.ACCEPTING_TRAFFIC`，Runner 执行期间应用不会接流量
- 自动配置由 `DeferredImportSelector` 在用户配置之后导入，读取 `AutoConfiguration.imports`，经过排除、快速过滤、排序与完整条件判定后注册；3.0 起 `spring.factories` 登记自动配置无效
- Boot 4 把自动配置拆成 `spring-boot-<技术>` 模块，包名随之变化，可先用 `spring-boot-starter-classic` 过渡
- `@ConditionalOnBean` 只在自动配置类里可靠；方法级条件不要引用可能缺失的类
- 配置类优先用 record + 构造器绑定 + `@Validated`
- Boot 4 移除 Undertow，Servlet 栈只剩 Tomcat 与 Jetty；开启虚拟线程后要给下游资源设并发上限

## 参考资料

- SpringApplication：[https://docs.spring.io/spring-boot/reference/features/spring-application.html](https://docs.spring.io/spring-boot/reference/features/spring-application.html)
- Creating Your Own Auto-configuration：[https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
- Embedded Web Servers：[https://docs.spring.io/spring-boot/how-to/webserver.html](https://docs.spring.io/spring-boot/how-to/webserver.html)
- Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- GitHub：[https://github.com/spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)

> 下一篇：[Web 开发](./2_web_dev) —— 参数绑定与校验、错误响应、Filter 注册、CORS 与新一代 HTTP 客户端。

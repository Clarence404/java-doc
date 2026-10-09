# Spring 总览

Spring Framework 是 Java 后端的基础框架：IoC 容器负责创建与装配对象，AOP 把事务、缓存、权限等横切逻辑从业务代码中剥离，在此之上提供 Web（Spring MVC / WebFlux）、事务、数据访问等能力。本模块讲 Framework 本身的机制与常用组件，以及 Spring Security、Spring Batch、Spring Integration 等周边项目；Spring Boot 的自动配置与工程化放在 [Spring Boot](/spring-boot/0_overview) 模块，微服务组件放在 [Spring Cloud](/spring-cloud/0_overview) 模块。

版本基线：**Spring Framework 7.x / Spring Boot 4.x / Spring Security 7 / JDK 17+（推荐 21 / 25）**，与 Framework 6.x / Boot 3.x 行为不同的地方在文中单独标出。

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

按侧边栏分组顺序阅读，每篇末尾的「下一篇」串起整条链路。

**核心容器（1–4）**

1. [IoC 容器](./1_ioc)：refresh 流程、依赖注入、Bean 定义来源、作用域、生命周期、扩展点与循环依赖
2. [AOP](./2_aop)：通知类型与执行顺序、切点表达式、代理选择、自调用失效
3. [MVC](./3_mvc)：DispatcherServlet 流程、参数解析与校验、消息转换、ProblemDetail 异常处理、API 版本
4. [事务管理](./4_transaction)：@Transactional 原理、传播行为、回滚规则、编程式事务与失效场景

**常用组件（5–8）**

5. [Cache 抽象](./5_cache)：缓存注解、CacheManager、Redis 序列化与常见陷阱
6. [Retry 重试](./6_retry)：退避策略与熔断，Framework 7 内置弹性注解
7. [事件机制](./7_event)：同步 / 异步事件、事务事件与事件驱动解耦
8. [WebFlux](./8_webflux)：Reactor、背压、WebClient 与 R2DBC

**安全（9–11）**

9. [Spring Security](./9_security)：过滤器链、JWT、方法级与动态权限
10. [安全框架对比](./10_auth_framework)：Spring Security、Shiro、Sa-Token 的取舍
11. [Spring SSO 接入](./11_single_sign_on)：LDAP、CAS、SAML2、OIDC、Keycloak、自建授权服务器

**批处理与集成（12–13）**

12. [Spring Batch 批处理](./12_batch)：Job / Step、分块读写与重启
13. [Spring Integration](./13_integration)：消息通道、集成 DSL 与 Camel 对比

**题目清单（99）**：[面试高频题](./99_interview)，答案见 [开发总结 - Spring 与 Spring Boot](/interview/5_spring)。

---

## 三、关联模块

- [Spring Boot](/spring-boot/0_overview)：自动配置、Starter、配置体系、测试与启动优化；版本差异见 [Spring Boot 版本演进](/spring-boot/11_versions)
- [Spring Cloud](/spring-cloud/0_overview)：注册发现、网关、服务调用、配置中心与治理
- [Java · 动态代理](/java/16_topic_proxy)：JDK 代理与 CGLIB 的实现细节，AOP 与事务的底层
- [Java · 虚拟线程](/java/30_topic_virtual_thread)：Framework 6.1 / Boot 3.2 起的虚拟线程支持
- [数据库 · MySQL 事务与锁](/database/1_mysql/5_topic_transaction)：隔离级别、MVCC 与锁，事务管理的数据库侧
- [应用安全](/security/0_overview)：JWT、OAuth2、OIDC、SSO 的协议原理
- [开发总结 - Spring 与 Spring Boot](/interview/5_spring)：本模块高频问题的答案汇总

---

## 四、核心模块与版本演进

### 1、Framework 核心模块

| 模块 | 内容 |
|------|------|
| `spring-core` | 基础工具、`Resource` 抽象、类型转换基础、注解元数据（`MergedAnnotations`） |
| `spring-beans` | `BeanFactory`、`BeanDefinition`、依赖注入与 Bean 生命周期 |
| `spring-context` | `ApplicationContext`、注解配置、事件、国际化、校验、调度、缓存抽象 |
| `spring-expression` | SpEL 表达式语言 |
| `spring-aop` / `spring-aspects` | 基于代理的 AOP、AspectJ 集成 |
| `spring-tx` | 事务抽象（`PlatformTransactionManager`、`@Transactional`） |
| `spring-jdbc` / `spring-orm` / `spring-r2dbc` | `JdbcClient` / `JdbcTemplate`、JPA / Hibernate 集成、响应式 SQL |
| `spring-web` / `spring-webmvc` / `spring-webflux` | HTTP 抽象与客户端、Servlet 栈 MVC、响应式 Web |
| `spring-messaging` / `spring-websocket` | 消息抽象、WebSocket 与 STOMP |
| `spring-test` | `TestContext` 框架、MockMvc、`@MockitoBean` |

Spring Boot 不是 Framework 的替代品：它在 Framework 之上提供依赖版本管理、自动配置（Boot 3+/4 通过 `META-INF/spring/...AutoConfiguration.imports` 注册）、内嵌 Web 服务器与外部化配置，原理见 [启动流程与自动配置](/spring-boot/1_spring_boot)。

### 2、版本演进

| 版本 | 发布 | 关键变化 |
|------|------|----------|
| 5.x | 2017 | JDK 8+；WebFlux 响应式栈；Kotlin 支持；5.3 为最后一个 javax 版本（对应 Boot 2.x） |
| 6.0 | 2022.11 | JDK 17+；`javax.*` → `jakarta.*`（Jakarta EE 9+）；AOT 与 GraalVM 原生镜像；HTTP Interface；`ProblemDetail`（RFC 7807 / 9457）；非 public 方法可被 CGLIB 代理事务化（对应 Boot 3.0） |
| 6.1 | 2023.11 | 虚拟线程支持（[虚拟线程](/java/30_topic_virtual_thread)）；`RestClient`、`JdbcClient`；MVC 内置方法参数校验；CRaC 检查点（对应 Boot 3.2） |
| 6.2 | 2024.11 | Bean 后台初始化；`@MockitoBean` / `@MockitoSpyBean`；`@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)`；单例锁机制重构（对应 Boot 3.4 / 3.5） |
| 7.0 | 2025.11 | Jakarta EE 11（Servlet 6.1）；JSpecify 空安全注解；默认 Jackson 3（Jackson 2 支持废弃）；MVC / WebFlux 内置 API 版本控制；`@Retryable` / `@ConcurrencyLimit` 内置弹性注解；`@ImportHttpServices` 注册 HTTP 服务客户端；`HttpMessageConverters` 构建器（对应 Boot 4.0） |
| 7.1 | 2026 | `RestTemplate` 标记废弃，推荐 `RestClient`（对应 Boot 4.1） |

Spring Boot 各版本的升级清单与支持周期见 [Spring Boot 版本演进](/spring-boot/11_versions)。

## 参考资料

- Spring Framework 参考文档：[https://docs.spring.io/spring-framework/reference/](https://docs.spring.io/spring-framework/reference/)
- Spring Framework 项目页：[https://spring.io/projects/spring-framework](https://spring.io/projects/spring-framework)
- 各项目版本亮点：[https://spring.io/projects/release-highlights/](https://spring.io/projects/release-highlights/)

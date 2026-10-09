---
description: 自动配置与 Starter、启动流程、配置管理、Web 与数据、异步与定时、运维可观测、测试、版本与启动优化
---

# 面试高频题

> 汇总 Spring Boot 方向的高频面试问题，完整解答见 <RouteLink to="/interview/5_spring">开发总结 - Spring 与 Spring Boot</RouteLink> 的「Spring Boot」部分。
>
> IoC、AOP、事务、MVC 等 Framework 本身的问题见 <RouteLink to="/spring/99_interview">Spring 面试题</RouteLink>；探针与优雅停机的系统级策略见 <RouteLink to="/high-avail/99_interview">高可用面试题</RouteLink>。

## 一、自动配置与 Starter

- **Spring Boot 自动配置的原理是什么？`@SpringBootApplication` 做了什么？为什么用户定义的 Bean 总是优先？**
- **`spring.factories` 与 `AutoConfiguration.imports` 有什么区别？Boot 4 的模块化自动配置改变了什么？**
- **`@ConditionalOnBean` 为什么只在自动配置类里可靠？如何排查某个自动配置为什么生效或没生效？**
- **如何自定义一个 Spring Boot Starter？装配顺序、条件、配置元数据和测试要注意什么？**  
  → 详见 <RouteLink to="/spring-boot/1_spring_boot">启动流程与自动配置</RouteLink>、<RouteLink to="/spring-boot/8_custom_starter">自定义 Starter</RouteLink>

## 二、启动流程

- **`SpringApplication.run()` 的启动流程是什么？各生命周期事件的顺序？**
- **为什么用 `@Component` 监听不到 `ApplicationEnvironmentPreparedEvent`？**
- **Runner 执行期间就绪探针为什么不通过？启动后的预热逻辑应该放在哪里？**  
  → 详见 <RouteLink to="/spring-boot/1_spring_boot">启动流程与自动配置</RouteLink>

## 三、配置管理

- **Spring Boot 配置源的优先级是怎样的？为什么 `-D` 系统属性会覆盖环境变量？**
- **`@Value` 与 `@ConfigurationProperties` 有什么区别？松散绑定与校验怎么用，如何绑定到 record？**
- **`spring.config.import` 有什么用？（`optional:`、`configtree:`、Nacos / Vault）**  
  → 详见 <RouteLink to="/spring-boot/6_config">配置管理</RouteLink>

## 四、Web 与数据访问

- **Boot 4 为什么移除了 Undertow？开启虚拟线程后 Tomcat 的线程配置还有效吗？**
- **加了 `@EnableWebMvc` 会发生什么？**
- **Filter 中的异常为什么进不了 `@RestControllerAdvice`？Filter 相对 Spring Security 的顺序如何确定？**
- **`allowedOriginPatterns("*")` + `allowCredentials(true)` 有什么风险？**
- **JPA 实体为什么不能用 `@Data`？open-in-view、N+1 与 `LazyInitializationException` 怎么处理？**
- **Boot 如何选择事务管理器？dynamic-datasource 在外层事务中 `@DS` 为什么失效？**
- **多实例同时启动时 Flyway 迁移会冲突吗？MySQL 上脚本执行失败后如何修复？**
- **Flyway 与 Liquibase 怎么选？生产上是回滚还是向前修复？**  
  → 详见 <RouteLink to="/spring-boot/1_spring_boot">启动流程与自动配置</RouteLink>、<RouteLink to="/spring-boot/2_web_dev">Web 开发</RouteLink>、<RouteLink to="/spring-boot/3_data_access">数据访问</RouteLink>、<RouteLink to="/spring-boot/4_flyway">数据库版本迁移</RouteLink>

## 五、中间件、异步与定时

- **Lettuce 需要连接池吗？Kafka 消息反序列化失败为什么会卡住分区？**
- **`@Async` 默认用哪个执行器？为什么开启虚拟线程后 `@Async` 可能不受影响？**
- **`@Scheduled` 默认用几个线程？如何避免任务互相阻塞？**
- **多实例部署时如何让定时任务只执行一次？（ShedLock vs XXL-JOB）**  
  → 详见 <RouteLink to="/spring-boot/5_middleware">中间件集成</RouteLink>、<RouteLink to="/spring-boot/9_async_schedule">异步任务与定时任务</RouteLink>

## 六、运维与可观测

- **Actuator 的暴露（exposure）与访问（access）有什么区别？生产环境如何保护管理端点？**
- **存活探针与就绪探针有什么区别？为什么外部依赖不能放进存活探针？**
- **如何用 Micrometer 写自定义业务指标？如何避免高基数？Observation API 做什么？**
- **Boot 3.4+ 的结构化日志怎么用？traceId 如何进入日志，跨线程如何传递？**
- **如何在生产环境真正关闭接口文档？**  
  → 详见 <RouteLink to="/spring-boot/7_actuator">Actuator 监控</RouteLink>、<RouteLink to="/spring-boot/12_logging">日志</RouteLink>、<RouteLink to="/spring-boot/10_api_doc">接口文档</RouteLink>

## 七、测试

- **`@SpringBootTest` 与切片测试怎么选？Boot 4 的测试有哪些变化？**
- **`@MockBean` 为什么被 `@MockitoBean` 取代？为什么 Mock 一多测试就变慢？**
- **Testcontainers 如何与 Spring Boot 集成？`@ServiceConnection` 做了什么？**
- **测试方法上的 `@Transactional` 什么时候不会回滚？**  
  → 详见 <RouteLink to="/spring-boot/13_testing">Spring Boot 测试</RouteLink>

## 八、版本与启动优化

- **Spring Boot 2.x → 3.x → 4.x 的关键变化是什么？老项目如何升级？**
- **Spring Boot 应用启动慢怎么优化？懒加载、CDS / AOT 缓存、Native Image 怎么选？**  
  → 详见 <RouteLink to="/spring-boot/11_versions">Spring Boot 版本演进</RouteLink>、<RouteLink to="/spring-boot/14_startup">启动与部署优化</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/5_spring">开发总结 - Spring 与 Spring Boot</RouteLink>
:::

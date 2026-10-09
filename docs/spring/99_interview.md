---
description: IoC 与生命周期、AOP、事务、MVC、常用组件、WebFlux、Security、批处理与集成、版本演进
---

# 面试高频题

> 汇总 Spring Framework 及其周边项目的高频面试问题，分组与侧边栏一致，完整解答见 <RouteLink to="/interview/5_spring">开发总结 - Spring 与 Spring Boot</RouteLink>。
>
> 自动配置、启动流程、配置管理、Actuator、测试等 Spring Boot 问题见 <RouteLink to="/spring-boot/99_interview">Spring Boot 面试题</RouteLink>；JDK 动态代理与 CGLIB 的实现细节见 <RouteLink to="/java/99_interview">Java 面试题</RouteLink>。

## 一、IoC 与 DI

- **IoC 和 DI 的区别？Spring IoC 容器的作用是什么？**
- **`BeanFactory` 和 `ApplicationContext` 的区别？`refresh()` 有哪几个关键阶段？**
- **Bean 的注入方式有哪些？构造器注入、Setter 注入、字段注入各有什么优缺点？**
- **`@Autowired` 和 `@Resource` 的区别？有多个候选 Bean 时如何消歧义？**
- **`@Bean` 的 full 模式与 lite 模式（`proxyBeanMethods`）有什么区别？**
- **`@Import` 能导入哪些东西？`ImportSelector` 与 `ImportBeanDefinitionRegistrar` 在自动配置和 `@EnableXxx` 中起什么作用？**
- **Spring Boot 2.6+ 为什么启动时报循环依赖？如何解决？三级缓存的原理是什么，为什么需要三级？**  
  → 详见 <RouteLink to="/spring/1_ioc">IoC 容器</RouteLink>

## 二、Bean 生命周期与扩展点

- **Spring Bean 的完整生命周期是什么？Aware 回调、`@PostConstruct`、`afterPropertiesSet`、`init-method` 与 AOP 代理创建的先后顺序？**
- **Bean 的作用域有哪些？单例中如何使用 prototype 和 request / session 作用域的 Bean？**
- **Spring 有哪些核心扩展点？`FactoryBean` 和 `BeanFactory` 有什么区别？**  
  → 详见 <RouteLink to="/spring/1_ioc">IoC 容器</RouteLink>

## 三、AOP

- **AOP 的核心概念（切面、切点、通知、连接点）是什么？Spring AOP 与 AspectJ 有什么区别？**
- **Spring 如何在 JDK 动态代理和 CGLIB 之间选择？Spring Boot 默认用哪种？**
- **通知的执行顺序是什么？多个切面如何排序？自定义切面如何放到事务的外层？**
- **`@Transactional` 等注解为什么在同一个类内部调用会失效？正确的修复方式有哪些，为什么不推荐注入自身？**  
  → 详见 <RouteLink to="/spring/2_aop">AOP</RouteLink>、<RouteLink to="/java/16_topic_proxy">动态代理</RouteLink>

## 四、事务

- **`@Transactional` 的实现原理是什么？**
- **Spring 事务的传播行为有哪几种？`REQUIRED`、`REQUIRES_NEW`、`NESTED` 有什么区别和风险？**
- **什么情况下会出现 `UnexpectedRollbackException`（rollback-only）？如何避免？**
- **受检异常默认会回滚吗？Framework 6.2 的 `rollbackOn` 改变了什么？**
- **`@Transactional` 失效的常见场景有哪些？**
- **声明式事务和编程式事务的区别？什么时候用 `TransactionTemplate`？**  
  → 详见 <RouteLink to="/spring/4_transaction">事务管理</RouteLink>

## 五、Spring MVC

- **Spring MVC 的请求处理流程（DispatcherServlet 工作原理）？**
- **`@Controller` 和 `@RestController` 的区别？**
- **过滤器（Filter）和拦截器（Interceptor）的区别？**
- **Servlet 的生命周期是怎样的？Servlet 是线程安全的吗？**
- **Framework 6.1 起 MVC 参数校验有什么变化？`MethodArgumentNotValidException` 与 `HandlerMethodValidationException` 分别在什么时候抛出？**
- **什么是 ProblemDetail？如何基于 `ResponseEntityExceptionHandler` 做统一异常处理？**
- **Jackson 3 / Boot 4 下如何定制 JSON 序列化？**  
  → 详见 <RouteLink to="/spring/3_mvc">MVC</RouteLink>

## 六、常用组件

- **`@Cacheable` 缓存 null 是防穿透还是导致穿透？`disableCachingNullValues` 有什么副作用？**
- **Spring Data Redis 4 / Jackson 3 下 Redis 缓存序列化要注意什么？**
- **`@Cacheable(sync = true)` 能解决集群下的缓存击穿吗？**
- **`@Retryable` 与 `@Transactional` 一起用时，重试应该在事务内还是事务外？**
- **`@TransactionalEventListener` 有哪些阶段？AFTER_COMMIT 里写库为什么不生效？**
- **Spring 进程内事件可靠吗？怎么保证不丢？**  
  → 详见 <RouteLink to="/spring/5_cache">Cache 抽象</RouteLink>、<RouteLink to="/spring/6_retry">Retry 重试</RouteLink>、<RouteLink to="/spring/7_event">事件机制</RouteLink>

## 七、WebFlux 与响应式

- **WebFlux 和 Spring MVC 有什么区别？有了虚拟线程还需要 WebFlux 吗？**
- **Mono / Flux 是什么？为什么说「订阅之前什么都不会发生」？**
- **为什么不能在事件循环线程上阻塞？`publishOn` 与 `subscribeOn` 有什么区别？阻塞调用如何包装？**
- **什么是背压？HTTP 链路上背压能跨网络传递吗？**
- **响应式链路中 ThreadLocal / MDC 为什么会失效？如何传递上下文？**  
  → 详见 <RouteLink to="/spring/8_webflux">WebFlux</RouteLink>

## 八、Spring Security

- **Spring Security 的过滤器链是如何工作的？授权由哪个组件完成？**
- **Security 6 / 7 的配置方式有哪些变化？**
- **JWT 认证用 OAuth2 Resource Server 和自定义过滤器有什么区别？自定义过滤器有哪些坑？**
- **如何实现方法级权限和数据库驱动的动态 URL 权限？**
- **Spring Security、Sa-Token、Shiro 如何选型？Sa-Token 的注解为什么不生效？**
- **Keycloak 接入 OIDC 时如何实现单点登出？登录应用里为什么拿不到角色？**
- **如何用 Spring Authorization Server 搭建授权服务器？Security 7 中有什么变化？**  
  → 详见 <RouteLink to="/spring/9_security">Spring Security</RouteLink>、<RouteLink to="/spring/10_auth_framework">安全框架对比</RouteLink>、<RouteLink to="/spring/11_single_sign_on">Spring SSO 接入</RouteLink>

## 九、批处理与集成

- **Spring Batch 中 JobInstance 与 JobExecution 有什么区别？失败的作业如何从断点续跑？**
- **在 Boot 项目里加 `@EnableBatchProcessing` 会发生什么？**
- **Chunk 步骤中 filter 与 skip 有什么区别？**
- **Spring Batch 有哪些扩展方式（多线程 Step、分区、远程分块）？**
- **Spring Integration 与 Spring Cloud Stream、Apache Camel 是什么关系？如何选择？**  
  → 详见 <RouteLink to="/spring/12_batch">Spring Batch 批处理</RouteLink>、<RouteLink to="/spring/13_integration">Spring Integration</RouteLink>

## 十、版本演进

- **Spring Framework 5 → 6 → 7 有哪些关键变化？**
- **`RestTemplate`、`RestClient`、`WebClient`、HTTP Service Clients 怎么选？**
- **Framework 7 内置的 `@Retryable` 与 Spring Retry 有什么区别？`@ConcurrencyLimit` 为什么和虚拟线程有关？**  
  → 详见 <RouteLink to="/spring/0_overview">Spring 总览</RouteLink>、<RouteLink to="/spring-boot/2_web_dev">Web 开发</RouteLink>、<RouteLink to="/spring/6_retry">Retry 重试</RouteLink>、<RouteLink to="/spring-boot/11_versions">Spring Boot 版本演进</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/5_spring">开发总结 - Spring 与 Spring Boot</RouteLink>
:::

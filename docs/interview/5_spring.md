---
description: IoC、生命周期、AOP、事务、MVC、WebFlux、Security、自动配置、启动、配置、测试、版本演进
---

# 开发总结 - Spring 与 Spring Boot

> 精华提炼，细节详见 [Spring 总览](/spring/0_overview) 与 [Spring Boot 总览](/spring-boot/0_overview)；题目清单见 [Spring 面试题](/spring/99_interview) 与 [Spring Boot 面试题](/spring-boot/99_interview)，本页按清单的分组与顺序作答：一至十组对应 Spring 题单，十一至十八组对应 Spring Boot 题单。
> 版本基线：Spring Framework 7.x / Spring Boot 4.x / Spring Security 7（JDK 17+，推荐 21 / 25），与 Framework 5.x–6.x、Boot 2.x–3.x 不同之处在答案中单独标注。JDK 动态代理与 CGLIB 的实现细节见 [开发总结 - Java](/interview/1_java)。

## 一、IoC 与 DI

### Q1：IoC 和 DI 的区别？Spring IoC 容器的作用是什么？

**核心结论**：IoC（控制反转）是思想——对象的创建和依赖装配不再由业务代码 `new`，而是交给容器；DI（依赖注入）是实现手段——容器创建 Bean 时把依赖注入进去。IoC 是目标，DI 是手段。

| 容器职责 | 说明 |
|---------|------|
| 创建与装配 | 把注解 / `@Bean` / `@Import` 解析成 `BeanDefinition`，实例化并注入依赖 |
| 生命周期管理 | 初始化与销毁回调、作用域控制 |
| 解耦 | 业务只依赖接口，替换实现不改调用方 |
| 扩展基础 | AOP、事务、缓存、`@Async` 都建立在 `BeanPostProcessor` 等扩展点之上 |

→ 详见 [IoC 容器](/spring/1_ioc)

### Q2：`BeanFactory` 和 `ApplicationContext` 的区别？`refresh()` 有哪几个关键阶段？

**核心结论**：`BeanFactory`（`spring-beans`）是最底层的容器，首次 `getBean` 才创建单例；`ApplicationContext`（`spring-context`）在其上增加事件、国际化、`Environment`、自动注册后置处理器，并在 `refresh()` 末尾预实例化全部非懒加载单例，让配置错误在启动期暴露。实际开发只用 `ApplicationContext`。

`refresh()` 有十二步，记住三步即可：

| 步骤 | 做什么 |
|------|-------|
| 第 5 步 `invokeBeanFactoryPostProcessors` | `ConfigurationClassPostProcessor` 解析 `@Configuration`、`@ComponentScan`、`@Import`、`@Bean` 为 `BeanDefinition`，Boot 自动配置在此导入 |
| 第 6 步 `registerBeanPostProcessors` | 按 `PriorityOrdered` → `Ordered` → 普通顺序注册 BPP，之后创建的 Bean 才会被它们处理 |
| 第 11 步 `finishBeanFactoryInitialization` | 实例化非懒加载单例：依赖注入、生命周期回调、AOP 代理都在这里发生 |

- 第 9 步 `onRefresh` 中 Boot 创建内嵌 Tomcat / Jetty，第 12 步 `finishRefresh` 启动 `SmartLifecycle`（Web 服务器开始监听）并发布 `ContextRefreshedEvent`

→ 详见 [IoC 容器](/spring/1_ioc#一、容器与启动流程)

### Q3：Bean 的注入方式有哪些？构造器注入、Setter 注入、字段注入各有什么优缺点？

**核心结论**：首选构造器注入，可选依赖用 Setter 或 `ObjectProvider`，不推荐字段注入。

| 方式 | 优点 | 缺点 | 建议 |
|------|------|------|------|
| 构造器注入 | 字段可 `final`；依赖缺失启动即失败；单测直接 `new` | 依赖多时构造器臃肿（这本身是该拆分的信号） | 推荐，单构造器可省略 `@Autowired` |
| Setter 注入 | 可选依赖、可重新配置 | 对象可能处于半初始化状态 | 可选依赖使用 |
| 字段注入 | 写法最短 | 不能 `final`，脱离容器无法测试，依赖数量被隐藏 | 不推荐 |

- 可选依赖用 `ObjectProvider<T>#ifAvailable` 比 `@Autowired(required = false)` 更清晰

→ 详见 [IoC 容器](/spring/1_ioc#_1、三种注入方式)

### Q4：`@Autowired` 和 `@Resource` 的区别？有多个候选 Bean 时如何消歧义？

**核心结论**：`@Autowired` 先按类型查找，多个候选时依次按 `@Primary`、`@Priority`、参数名 / 字段名与 Bean 名匹配，仍无法确定抛 `NoUniqueBeanDefinitionException`；`@Resource` 指定 `name` 时只按名称查找（找不到直接失败，不回退到类型），未指定时先按字段名、找不到再按类型。

| 对比 | `@Autowired` | `@Resource` |
|------|-------------|-------------|
| 来源 | Spring | Jakarta Annotations（`jakarta.annotation.Resource`） |
| 可用位置 | 构造器、方法、字段、参数 | 字段、setter，不支持构造器 |
| 可选依赖 | `required = false` | 不支持 |
| 消歧义 | `@Qualifier`、`@Primary` | `name` 属性 |

- 策略分发场景直接注入 `Map<String, T>`（key 为 Bean 名）或 `List<T>`（按 `@Order` 排序），比调用 `getBean(name)` 更易测试
- Spring 6 起只识别 `jakarta.*`，残留的 `javax.annotation.Resource` / `PostConstruct` 会被**静默忽略**

→ 详见 [IoC 容器](/spring/1_ioc#_2、多个候选-bean-的消歧义)

### Q5：`@Bean` 的 full 模式与 lite 模式（`proxyBeanMethods`）有什么区别？

**核心结论**：full 模式（`@Configuration` 默认 `proxyBeanMethods = true`）把配置类做成 CGLIB 子类，`@Bean` 方法互相调用会被拦截并返回容器中的单例；lite 模式（`proxyBeanMethods = false`，或 `@Bean` 写在 `@Component` 里）不生成子类，方法互调就是普通 Java 调用，**每次都 new 一个新对象**。

| 对比 | full | lite |
|------|------|------|
| 配置类 | CGLIB 子类，类与 `@Bean` 方法不能 `final` | 原始类 |
| `@Bean` 方法互调 | 返回容器单例 | 创建新对象 |
| 启动与 AOT | 多一次字节码生成 | 更快，对原生镜像更友好 |

- Boot 的自动配置类全部是 lite 模式；业务配置也推荐 lite，并把依赖写成 `@Bean` 方法参数

→ 详见 [IoC 容器](/spring/1_ioc#_2、-bean-full-模式与-lite-模式)

### Q6：`@Import` 能导入哪些东西？`ImportSelector` 与 `ImportBeanDefinitionRegistrar` 在自动配置和 `@EnableXxx` 中起什么作用？

**核心结论**：`@Import` 能导入普通配置类、`ImportSelector`（运行时返回要导入的类名）和 `ImportBeanDefinitionRegistrar`（拿到 `BeanDefinitionRegistry` 编程式注册），所有 `@EnableXxx` 注解都是「元注解 + `@Import`」。

| 导入对象 | 典型例子 |
|---------|---------|
| 普通配置类 | `@Import(DataSourceConfig.class)` |
| `ImportSelector` / `DeferredImportSelector` | Boot 的 `AutoConfigurationImportSelector` 读取 `AutoConfiguration.imports`；Deferred 版本在所有用户配置类处理完后才执行 |
| `ImportBeanDefinitionRegistrar` | `@MapperScan`、`@EnableFeignClients`、`@ImportHttpServices`，按注解属性扫描接口并注册代理的定义 |

→ 详见 [IoC 容器](/spring/1_ioc#_3、-import)

### Q7：Spring Boot 2.6+ 为什么启动时报循环依赖？如何解决？三级缓存的原理是什么，为什么需要三级？

**核心结论**：Boot 2.6 起 `spring.main.allow-circular-references` 默认 `false`（3.x / 4.x 沿用），任何循环依赖都在启动时以 `BeanCurrentlyInCreationException` 失败。处理顺序：**重构**（抽第三个 Bean 或用事件解耦）→ 在一个注入点用 `@Lazy` / `ObjectProvider` 延迟获取（构造器循环也能打破）→ 最后才临时打开开关。

三级缓存（打开开关后才起作用）：

| 缓存 | 字段 | 内容 |
|------|------|------|
| 一级 | `singletonObjects` | 完整初始化的单例 |
| 二级 | `earlySingletonObjects` | 已被别的 Bean 拿走的早期引用（可能是代理） |
| 三级 | `singletonFactories` | `ObjectFactory`，调用时执行 `getEarlyBeanReference` |

- **存工厂而不是对象**：AOP 代理本应在初始化后创建，工厂让「只有真的出现循环时才提前生成代理」，否则要么注入原始对象（事务失效），要么所有 Bean 都得提前代理
- **二级缓存保证唯一**：工厂只调用一次，A 同时被 B、C 依赖时拿到同一个早期引用
- **解决不了**：构造器循环（实例化前就要对方）、prototype 循环、早期引用注入后又被 `@Async` 等不参与提前代理的 BPP 包装（报 "injected into other beans ... in its raw version"）

→ 详见 [IoC 容器](/spring/1_ioc#七、循环依赖)

## 二、Bean 生命周期与扩展点

### Q8：Spring Bean 的完整生命周期是什么？Aware 回调、`@PostConstruct`、`afterPropertiesSet`、`init-method` 与 AOP 代理创建的先后顺序？

**核心结论**：实例化 → 属性填充 → Aware 回调 → 初始化前（`@PostConstruct`）→ 初始化（`afterPropertiesSet` → `init-method`）→ 初始化后（生成 AOP 代理）→ 就绪 → 销毁（`@PreDestroy` → `DisposableBean#destroy` → `destroy-method`）。

| 阶段 | 关键点 |
|------|-------|
| Aware 分两批 | `BeanNameAware` / `BeanClassLoaderAware` / `BeanFactoryAware` 直接调用；`ApplicationContextAware`、`EnvironmentAware` 等由 `ApplicationContextAwareProcessor` 在初始化前回调 |
| `@PostConstruct` | 不是独立步骤，由 `CommonAnnotationBeanPostProcessor` 在 `postProcessBeforeInitialization` 中调用，所以早于 `afterPropertiesSet` |
| AOP 代理 | `AbstractAutoProxyCreator` 在 `postProcessAfterInitialization` 中返回代理，容器保存的是代理 |
| 销毁 | 只回调单例；prototype 不调用销毁方法 |

- 推论：在 `@PostConstruct` 里调用本类 `@Transactional` 方法不会开启事务；需要全部单例就绪的逻辑用 `SmartInitializingSingleton` 或 `ApplicationReadyEvent`

→ 详见 [IoC 容器](/spring/1_ioc#五、bean-生命周期)

### Q9：Bean 的作用域有哪些？单例中如何使用 prototype 和 request / session 作用域的 Bean？

**核心结论**：`singleton`（默认）、`prototype`、`request`、`session`、`application`、`websocket`。单例只在创建时注入一次，直接注入 prototype 永远是同一个对象，要用 `ObjectProvider` / `@Lookup` 每次获取；注入 request / session Bean 要用**作用域代理**（`@RequestScope` 默认 `TARGET_CLASS` 代理），代理是单例，每次调用再路由到当前请求的实例。

| 作用域 | 注意 |
|--------|------|
| `singleton` | 必须无状态或线程安全 |
| `prototype` | 容器只负责创建，不调用 `@PreDestroy`；不支持循环依赖 |
| `request` / `session` | 依赖当前线程绑定的请求，`@Async`、MQ 消费线程中调用抛 `No thread-bound request found` |

→ 详见 [IoC 容器](/spring/1_ioc#四、bean-作用域)

### Q10：Spring 有哪些核心扩展点？`FactoryBean` 和 `BeanFactory` 有什么区别？

**核心结论**：按生命周期位置记扩展点；`BeanFactory` 是**容器本身**，`FactoryBean` 是**一个生产 Bean 的 Bean**——`getBean("x")` 拿到 `getObject()` 的产品，`getBean("&x")` 才拿到工厂本身。

| 扩展点 | 时机 | 典型实现 |
|--------|------|---------|
| `BeanDefinitionRegistryPostProcessor` | refresh 第 5 步最先执行，可增删定义 | `ConfigurationClassPostProcessor`、`MapperScannerConfigurer` |
| `BeanFactoryPostProcessor` | 任何 Bean 实例化前，修改定义 | `PropertySourcesPlaceholderConfigurer` |
| `SmartInstantiationAwareBeanPostProcessor` | 选构造器、循环依赖时 | `AbstractAutoProxyCreator#getEarlyBeanReference` |
| `BeanPostProcessor` | 每个 Bean 初始化前后 | AOP 代理、`@Async`、`@Validated` |
| `SmartInitializingSingleton` | 全部单例创建完成后 | `@EventListener` 方法注册 |
| `ImportSelector` / `ImportBeanDefinitionRegistrar` | 解析配置类时 | 自动配置、`@EnableXxx` |
| `SmartLifecycle` | refresh 末尾启动、关闭时停止 | Web 服务器、Kafka 监听容器 |

- 在配置类中声明 BFPP / BPP 的 `@Bean` 方法要写成 `static`，否则配置类被提前实例化，日志出现 "is not eligible for getting processed by all BeanPostProcessors"

→ 详见 [IoC 容器](/spring/1_ioc#六、核心扩展点)

## 三、AOP

### Q11：AOP 的核心概念（切面、切点、通知、连接点）是什么？Spring AOP 与 AspectJ 有什么区别？

**核心结论**：切面（Aspect）= 切点（Pointcut，选哪些连接点）+ 通知（Advice，在连接点上做什么）；Spring AOP 中连接点只有「方法执行」一种。Spring AOP 复用 AspectJ 的注解与切点语法，但织入靠**运行时代理**；AspectJ 是编译期 / 类加载期**字节码织入**。

| 对比 | Spring AOP | AspectJ |
|------|-----------|---------|
| 连接点 | Spring Bean 的方法执行 | 方法调用与执行、构造器、字段读写等 |
| 自调用 | 拦截不到 | 能拦截 |
| `private` / `final` / `static` 方法、非 Spring 对象 | 不能 | 能 |
| 成本 | 零配置（Boot 4 引入 `spring-boot-starter-aspectj` 即自动开启） | 需要 ajc 或 `-javaagent` |

→ 详见 [AOP](/spring/2_aop#七、spring-aop-与-aspectj)

### Q12：Spring 如何在 JDK 动态代理和 CGLIB 之间选择？Spring Boot 默认用哪种？

**核心结论**：纯 Spring Framework 默认（`proxyTargetClass = false`）下，Bean 实现了接口用 JDK 代理，否则用 CGLIB；**Spring Boot 2.0 起 `spring.aop.proxy-target-class` 默认 `true`，一律 CGLIB**，避免按实现类注入时报类型错误。选择依据是**能力而不是性能**，现代 JDK 上两者调用开销可以忽略。

- CGLIB 通过生成子类实现：`final` 类无法代理，`final`、`private`、`static` 方法**静默不被拦截**（不报错，事务就这样丢了）
- Spring 使用自己 repackage 的 CGLIB（`org.springframework.cglib`，内置于 `spring-core`），不依赖已停更的上游 CGLIB
- 代理创建时机：`AbstractAutoProxyCreator` 在 `postProcessAfterInitialization` 中判断切点是否匹配，匹配则返回代理替换原 Bean

→ 详见 [AOP](/spring/2_aop#四、spring-的代理选择)、[动态代理](/java/16_topic_proxy)

### Q13：通知的执行顺序是什么？多个切面如何排序？自定义切面如何放到事务的外层？

**核心结论**：同一切面内（Spring 5.2.7+）正常调用顺序为 `@Around` 前半 → `@Before` → 目标方法 → `@AfterReturning`（异常时 `@AfterThrowing`）→ `@After` → `@Around` 后半。多个切面用 `@Order` 排序，**数值越小越在外层**：进入时最先执行、退出时最后执行。

- 同一切面内两个同类型通知（如两个 `@Before`）顺序不确定，应合并或拆到不同切面
- 事务通知默认 `Ordered.LOWEST_PRECEDENCE`，处在最内层：分布式锁、重试这类必须包住事务的切面给更高优先级（如 `@Order(Ordered.HIGHEST_PRECEDENCE + 10)`），保证事务提交后才释放锁或重试；要在事务内写审计表的切面优先级要低于事务
- 也可以用 `@EnableTransactionManagement(order = ...)` 调整事务通知自身的位置

→ 详见 [AOP](/spring/2_aop#二、通知类型与执行顺序)

### Q14：`@Transactional` 等注解为什么在同一个类内部调用会失效？正确的修复方式有哪些，为什么不推荐注入自身？

**核心结论**：调用方持有的是代理，`this.method()` 中的 `this` 是目标对象本身，不经过代理，所以 `@Transactional`、`@Async`、`@Cacheable`、`@Retryable`、`@PreAuthorize` 等所有基于代理的注解都会失效。

| 修复方式（按推荐程度） | 说明 |
|---------------------|------|
| 拆分 Bean | 首选：把被调方法移到另一个 Bean，职责清晰、易测试 |
| 编程式事务 | 只适用于事务：`TransactionTemplate` 控制边界 |
| 延迟获取自身代理 | 注入 `ObjectProvider<Self>` 或 `@Lazy`，能用但意图不直观 |
| `AopContext.currentProxy()` | 需 `@EnableAspectJAutoProxy(exposeProxy = true)`，与 AOP 实现耦合，`@Async` 线程中拿不到 |
| AspectJ 织入 | `mode = AdviceMode.ASPECTJ`，构建复杂，很少使用 |

- **不要 `@Autowired private Self self`**：这本质是循环依赖，Boot 2.6+ 默认禁止，应用直接启动失败

```java
public void importUsers(List<User> users) {
    users.forEach(userWriter::createOne);   // 经过另一个 Bean 的代理，事务生效
}
```

→ 详见 [AOP](/spring/2_aop#六、自调用失效问题)

## 四、事务

### Q15：`@Transactional` 的实现原理是什么？

**核心结论**：`@Transactional` 是一个 Advisor：切点匹配带注解的方法，通知是环绕型的 `TransactionInterceptor`，它通过 `PlatformTransactionManager` 按传播行为开启 / 加入 / 挂起事务，并把连接绑定到当前线程。

1. 调用进入代理 → `TransactionInterceptor#invokeWithinTransaction`
2. 解析事务属性：传播行为、隔离级别、超时、只读、回滚规则
3. 事务管理器新建事务时从连接池取连接、`setAutoCommit(false)`
4. `TransactionSynchronizationManager` 把连接放进 `ThreadLocal`，`JdbcTemplate`、MyBatis、JPA 通过 `DataSourceUtils` 拿到同一个连接
5. 正常返回提交；异常按回滚规则决定回滚或提交；最后解绑连接、恢复被挂起的事务

- 由此推出三条边界：**不经过代理没有事务**、**换了线程没有事务**、**绕开 Spring 管理的连接不在事务中**
- 响应式栈用 `ReactiveTransactionManager`，事务上下文放在 Reactor `Context` 而不是 `ThreadLocal`

→ 详见 [事务管理](/spring/4_transaction#一、-transactional-的工作原理)

### Q16：Spring 事务的传播行为有哪几种？`REQUIRED`、`REQUIRES_NEW`、`NESTED` 有什么区别和风险？

**核心结论**：七种传播行为中常用三种：`REQUIRED`（默认，加入或新建）、`REQUIRES_NEW`（挂起外层、独立提交）、`NESTED`（同一物理事务中的保存点）。传播行为只在**跨代理调用**时生效。

| 对比 | `REQUIRED` | `REQUIRES_NEW` | `NESTED` |
|------|-----------|---------------|----------|
| 物理事务 | 与外层同一个 | 两个独立事务 | 同一个，内层是保存点 |
| 连接数 | 1 | 2（外层挂起期间仍占用） | 1 |
| 内层失败 | 整个事务被标记 rollback-only | 只回滚内层 | 回滚到保存点，外层可继续 |
| 外层失败 | 一起回滚 | 内层已提交，不受影响 | 内层一起回滚 |
| 典型场景 | 绝大多数业务 | 审计日志、发号器 | 批量处理允许部分失败 |

- `REQUIRES_NEW` 的风险：一次调用占两个连接，高并发下所有连接被外层占满、内层永远拿不到连接，形成连接池耗尽式的「死锁」；不要在循环里调用
- `NESTED` 的前提：依赖 JDBC `Savepoint`，`DataSourceTransactionManager` / `JdbcTransactionManager` 默认支持；`JpaTransactionManager` 默认不支持（`nestedTransactionAllowed = false`），开启后也只对 JDBC 操作有效；JTA 下抛 `NestedTransactionNotSupportedException`；方法必须放在另一个 Bean 中

→ 详见 [事务管理](/spring/4_transaction#_2、required、requires-new-与-nested)

### Q17：什么情况下会出现 `UnexpectedRollbackException`（rollback-only）？如何避免？

**核心结论**：外层 `@Transactional` 方法调用另一个 Bean 的 `REQUIRED` 方法，内层抛出 RuntimeException 时 `TransactionInterceptor` 已把**整个事务**标记为 rollback-only；外层即使 catch 住异常继续执行，提交时也会整体回滚并抛 `UnexpectedRollbackException: Transaction silently rolled back because it has been marked as rollback-only`。

| 避免方式 | 说明 |
|---------|------|
| 内层改 `NESTED` | 失败只回滚到保存点，外层可继续提交 |
| 内层改 `REQUIRES_NEW` | 内层独立事务，注意连接占用 |
| 内层不开事务 | 由外层统一控制，内层只做数据访问 |
| 先校验再调用 | 不用异常控制正常业务分支 |

→ 详见 [事务管理](/spring/4_transaction#_5、rollback-only-与-unexpectedrollbackexception)

### Q18：受检异常默认会回滚吗？Framework 6.2 的 `rollbackOn` 改变了什么？

**核心结论**：默认只有 `RuntimeException` 和 `Error` 回滚，**受检异常会提交**（沿用 EJB 约定）。修正方式有两种：逐个方法写 `rollbackFor = Exception.class`；或者 Framework 6.2+ 在 `@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)` 全局改为所有异常都回滚，Spring 参考文档也建议这么做（Kotlin 项目尤甚）。

- 需要「某个业务异常不回滚」时用 `noRollbackFor` 精确排除
- catch 后不想重新抛出又要回滚：`TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()`

→ 详见 [事务管理](/spring/4_transaction#_1、回滚规则)

### Q19：`@Transactional` 失效的常见场景有哪些？

**核心结论**：失效分两类——**没经过代理**（自调用、方法不可覆盖、对象不是 Bean）和**与代理无关**（异常被吞、受检异常、传播行为、线程、连接、存储引擎）。

| 场景 | 原因 / 处理 |
|------|------------|
| 同类方法自调用 | `this` 不经过代理，见 Q14 |
| `private` / `final` / `static` 方法 | CGLIB 无法覆盖，永远不生效。Framework 6.0 起 `protected` 与包可见方法在 CGLIB 代理（Boot 默认）下**可以**生效；JDK 接口代理仍要求是接口中的 public 方法 |
| 对象不是 Spring Bean | `new` 出来的对象没有代理 |
| 异常被 catch 吞掉 | 拦截器看不到异常，照常提交 |
| 抛出受检异常 | 默认不回滚，见 Q18 |
| 内层 `REQUIRED` 失败、外层 catch | rollback-only，见 Q17 |
| 传播行为选错 | `SUPPORTS` / `NOT_SUPPORTED` / `NEVER` 可能以非事务执行 |
| 多数据源用错事务管理器 | 默认用 `@Primary` 的，需 `@Transactional(transactionManager = "...")` |
| 在其他线程访问数据库 | 连接绑定在 `ThreadLocal` |
| 在 `@PostConstruct` 中调用 | 代理尚未生成且是 `this` 调用 |
| 直接 `dataSource.getConnection()` | 拿到的是另一个连接 |
| MySQL MyISAM | 不支持事务 |

→ 详见 [事务管理](/spring/4_transaction#六、事务失效的常见场景)

### Q20：声明式事务和编程式事务的区别？什么时候用 `TransactionTemplate`？

**核心结论**：声明式（`@Transactional`）以整个方法为边界，靠代理实现、侵入低；编程式（`TransactionTemplate`）在代码块级控制边界、不受代理限制。方法中只有一段需要事务、前后是远程调用或文件处理时，用编程式把事务缩到只包数据库操作，**避免长事务**。

```java
PayResult result = txTemplate.execute(status -> {
    recordRepo.save(PayRecord.of(req));
    if (accountRepo.deduct(req.userId(), req.amount()) == 0) {
        status.setRollbackOnly();          // 不抛异常也能回滚
        return PayResult.fail("余额不足");
    }
    return PayResult.success();
});
```

- 需要定制隔离级别、超时时在类内自己 `new TransactionTemplate(txManager)`，不要用 `@Bean` 覆盖 Boot 自动配置的全局实例
- 发 MQ、短信等副作用放到提交之后（`@TransactionalEventListener`），否则回滚撤不回副作用

→ 详见 [事务管理](/spring/4_transaction#五、编程式事务)

## 五、Spring MVC

### Q21：Spring MVC 的请求处理流程（DispatcherServlet 工作原理）？

**核心结论**：请求先过 Servlet 容器的 Filter 链，再由前端控制器 `DispatcherServlet#doDispatch` 统一分发：HandlerMapping 找处理器 → 拦截器 `preHandle` → HandlerAdapter 解析参数、校验并调用 Controller → 返回值处理 → `postHandle` → 视图渲染（REST 没有）→ `afterCompletion`。

1. `HandlerMapping` 返回 `HandlerExecutionChain`（处理器 + 拦截器），找不到返回 404
2. 拦截器 `preHandle` 依次执行，任一返回 `false` 即中断
3. `RequestMappingHandlerAdapter` 用 `HandlerMethodArgumentResolver` 绑定参数、执行校验，反射调用方法
4. `@ResponseBody` / `ResponseEntity` 由 `HttpMessageConverter` 直接写响应体；返回视图名得到 `ModelAndView`
5. 逆序执行 `postHandle`：此时 `@ResponseBody` 的响应体**已经写出**，改响应头要用 `ResponseBodyAdvice`
6. 逆序执行 `afterCompletion`，无论成功失败都回调，适合清理 `ThreadLocal`
7. 第 1–5 步的异常交给 `HandlerExceptionResolver`（`@ExceptionHandler` 等）

→ 详见 [MVC](/spring/3_mvc#一、dispatcherservlet-请求处理流程)

### Q22：`@Controller` 和 `@RestController` 的区别？

**核心结论**：`@RestController = @Controller + @ResponseBody`。`@Controller` 方法的返回值默认是**视图名**，交给 `ViewResolver` 渲染页面，需要返回 JSON 时在方法上单独加 `@ResponseBody`；`@RestController` 所有方法的返回值都经 `HttpMessageConverter` 序列化写入响应体，适合前后端分离的 REST 接口。

→ 详见 [MVC](/spring/3_mvc)

### Q23：过滤器（Filter）和拦截器（Interceptor）的区别？

**核心结论**：Filter 是 Servlet 规范，由容器在 `DispatcherServlet` **之前**调用；Interceptor 是 Spring MVC 组件，由 `DispatcherServlet` 在处理器**前后**调用，能拿到 `HandlerMethod` 和方法注解。

| 对比 | Filter | HandlerInterceptor |
|------|--------|--------------------|
| 作用范围 | 所有请求，含静态资源和 `/error` | 只拦截映射到处理器的请求 |
| 能拿到的信息 | 原始请求 / 响应，可包装请求体 | 处理器方法及其注解 |
| 抛出的异常 | **不会**进入 `@RestControllerAdvice` | 由 `HandlerExceptionResolver` 统一处理 |
| 在 Boot 中注册 | `@Component` 即自动注册并可注入依赖；需要 URL 匹配或顺序时用 `FilterRegistrationBean`（二选一，否则注册两次） | `WebMvcConfigurer#addInterceptors` |
| 典型用途 | 编码、CORS、认证、请求日志、traceId | 登录态、用户上下文、按注解做权限或幂等 |

执行顺序：Filter → `DispatcherServlet` → `preHandle` → Controller → `postHandle` → `afterCompletion` → Filter 返回。

→ 详见 [MVC](/spring/3_mvc#_3、filter-与-handlerinterceptor)、[Web 开发](/spring-boot/2_web_dev#五、filter-与拦截器的注册)

### Q24：Servlet 的生命周期是怎样的？Servlet 是线程安全的吗？

**核心结论**：Servlet 由容器（Tomcat / Jetty）管理，**每个 Servlet 声明只有一个实例**：加载并实例化 → `init` 一次 → 每个请求在工作线程上调用一次 `service` → 卸载时 `destroy` 一次。同一实例被多个线程并发调用，所以它**不是线程安全的**，不能在实例字段里保存请求相关的可变状态。

| 阶段 | 时机 | 次数 |
|------|------|------|
| 实例化 | 默认首次请求时；`load-on-startup` ≥ 0 时随容器启动 | 1 |
| `init(ServletConfig)` | 处理任何请求前 | 1 |
| `service(req, resp)` | 每个请求，`HttpServlet` 再分派到 `doGet` / `doPost` | 每请求 1 次 |
| `destroy()` | 应用卸载或容器关闭 | 1 |

- 请求数据只放在局部变量和 `request` / `response` 中；`SingleThreadModel` 早已废弃，Servlet 6.0 已移除
- Spring MVC 只有一个 `DispatcherServlet`，`init` 中关联 `WebApplicationContext` 并初始化 HandlerMapping 等组件；Boot 默认 `spring.mvc.servlet.load-on-startup=-1`，首个请求稍慢，可设为 1
- Controller 默认单例，同样不能在字段里放请求状态；Filter 也是单实例多线程
- 包名为 `jakarta.servlet`；Boot 4 基于 Servlet 6.1，内嵌容器只剩 Tomcat 11 与 Jetty 12.1

→ 详见 [MVC](/spring/3_mvc)

### Q25：Framework 6.1 起 MVC 参数校验有什么变化？`MethodArgumentNotValidException` 与 `HandlerMethodValidationException` 分别在什么时候抛出？

**核心结论**：6.1（Boot 3.2）起 Spring MVC **内置方法参数校验**，`@PathVariable` / `@RequestParam` 上直接写约束注解即可，不再需要在 Controller 类上加 `@Validated`。两类异常**都要处理**：

| 触发条件 | 失败异常 |
|---------|---------|
| 只有 `@RequestBody` / `@ModelAttribute` 对象参数标了 `@Valid` | `MethodArgumentNotValidException` |
| 参数上直接写约束（如 `@PathVariable @Positive`），或返回值有约束；此时 `@Valid` 对象的失败也会被并入 | `HandlerMethodValidationException` |
| Controller 类上仍加 `@Validated`（旧写法，AOP 方法校验） | `ConstraintViolationException` |

- **6.1 起去掉 Controller 上的 `@Validated`**：否则校验走 AOP 代理，抛出的 `ConstraintViolationException` 不被 `ResponseEntityExceptionHandler` 处理，落入兜底 500；`@Validated` 留给 Service 层与分组校验
- 继承 `ResponseEntityExceptionHandler` 时覆写 `handleMethodArgumentNotValid` / `handleHandlerMethodValidationException`，再写 `@ExceptionHandler` 会因映射重复启动失败

→ 详见 [MVC](/spring/3_mvc#三、参数校验)、[Web 开发](/spring-boot/2_web_dev#_2、两条校验路径)

### Q26：什么是 ProblemDetail？如何基于 `ResponseEntityExceptionHandler` 做统一异常处理？

**核心结论**：ProblemDetail 是 Framework 6.0 起支持的 RFC 9457（原 RFC 7807）标准错误体，响应类型 `application/problem+json`，字段为 `type` / `title` / `status` / `detail` / `instance`，扩展字段放进 `properties` 后序列化为顶层字段。生产上通常写一个继承 `ResponseEntityExceptionHandler` 的 `@RestControllerAdvice`：父类已把所有 Spring MVC 内置异常转成 ProblemDetail，子类再补业务异常和兜底异常。

| 组件 | 作用 |
|------|------|
| `ProblemDetail` | 错误响应体 |
| `ErrorResponse` / `ErrorResponseException` | 携带状态码与 ProblemDetail 的异常契约；业务异常继承它可以不写 `@ExceptionHandler` |
| `ResponseEntityExceptionHandler` | 处理 MVC 内置异常（400、405、415 等）的基类 |
| `spring.mvc.problemdetails.enabled=true` | Boot 自动注册一个该处理器，容器中已有同类 Bean 时退让 |

- 异常处理链：`ExceptionHandlerExceptionResolver` → `ResponseStatusExceptionResolver` → `DefaultHandlerExceptionResolver`，都处理不了的转发到 `/error`
- Filter 中的异常、Spring Security 的 401 / 403（`AuthenticationEntryPoint` / `AccessDeniedHandler`）不经过这条链
- 仍要统一 `{code, message, data}` 包装时，至少让校验失败、未认证、服务器错误返回正确的 HTTP 状态码

→ 详见 [MVC](/spring/3_mvc#五、统一异常处理)

### Q27：Jackson 3 / Boot 4 下如何定制 JSON 序列化？

**核心结论**：Framework 7 / Boot 4 默认 Jackson 3（包名 `tools.jackson`，注解包 `com.fasterxml.jackson.annotation` 不变），自动配置的是 `JsonMapper`，转换器是 `JacksonJsonHttpMessageConverter`。定制顺序：先用 `spring.jackson.*` 配置，再用 `JsonMapperBuilderCustomizer`，**不要自己 new 一个 Mapper 塞进转换器**——那会绕过 Boot 的配置与自动注册的模块。

| 场景 | Boot 4（Jackson 3） | Boot 3.x（Jackson 2） |
|------|--------------------|----------------------|
| 定制 Mapper | `JsonMapperBuilderCustomizer` | `Jackson2ObjectMapperBuilderCustomizer` |
| 自定义序列化器 | `@JacksonComponent` | `@JsonComponent` |
| 完全替换 | 声明 `JsonMapper` Bean | 声明 `ObjectMapper` Bean |
| 读写特性 | `spring.jackson.json.read.*` / `write.*` | `spring.jackson.read.*` / `write.*` |

- Jackson 3 内置 Java 时间类型支持，默认不再把日期写成时间戳；部分默认值与 2.x 不同，升级过渡可设 `spring.jackson.use-jackson2-defaults=true`
- 纯 Framework 7 中替换转换器用 `configureMessageConverters(HttpMessageConverters.ServerBuilder)`，旧的 `List` 版本已废弃

→ 详见 [MVC](/spring/3_mvc#_2、jackson-3-与-boot-4)、[Web 开发](/spring-boot/2_web_dev#_2、jackson-3)

## 六、常用组件

### Q28：`@Cacheable` 缓存 null 是防穿透还是导致穿透？`disableCachingNullValues` 有什么副作用？

**核心结论**：**缓存 null（配合短 TTL）是防穿透的手段**：不存在的 key 也能命中缓存，挡住对数据库的重复查询。关闭 null 缓存（`RedisCacheConfiguration#disableCachingNullValues`）后，查询不存在的 id 每次都打到数据库；而且此时 `@Cacheable` 方法返回 null 会抛 `IllegalArgumentException`，必须加 `unless = "#result == null"`。

| 做法 | 效果 | 注意 |
|------|------|------|
| 缓存 null（默认）+ 短 TTL | 挡住穿透 | JSON 序列化需 `enableSpringCacheNullValueSupport()`；TTL 要短，避免新增数据长时间查不到 |
| `disableCachingNullValues()` | null 不进缓存 | 必须配 `unless = "#result == null"` |
| 布隆过滤器前置 | 海量随机 key 攻击时更省内存 | 见缓存模块 |

→ 详见 [Cache 抽象](/spring/5_cache#_3、空值策略与缓存穿透)、[缓存一致性](/cache/10_cache_consistency)

### Q29：Spring Data Redis 4 / Jackson 3 下 Redis 缓存序列化要注意什么？

**核心结论**：Boot 4 对应 Spring Data Redis 4，`GenericJackson2JsonRedisSerializer` 被标记为待移除，换成 `GenericJacksonJsonRedisSerializer`。三个变化要注意：

- **默认不写类型信息**：旧序列化器默认开启 default typing，新的默认关闭，读回来是 `LinkedHashMap`，强转业务类型抛 `ClassCastException`；需要多态时用 `builder().enableDefaultTyping(validator)`，配置 `PolymorphicTypeValidator` 限定可反序列化的包
- **不要用 `enableUnsafeDefaultTyping()`**：允许反序列化任意类型，Redis 数据被篡改即可触发远程代码执行；只存一种类型时用 `JacksonJsonRedisSerializer<T>` 建专用模板
- **存量数据兼容**：Jackson 3 写出的 JSON 可能与旧格式不同，升级时清空缓存、换 key 前缀等旧 key 过期，或过渡期继续用旧序列化器读旧数据
- Boot 自动配置的 `RedisCacheManager` / `RedisTemplate<Object, Object>` 默认是 JDK 序列化，值不可读且要求 `Serializable`

→ 详见 [Cache 抽象](/spring/5_cache#_2、redis-cachemanager-spring-data-redis-4-jackson-3)、[中间件集成](/spring-boot/5_middleware#_2、序列化-jackson-3)

### Q30：`@Cacheable(sync = true)` 能解决集群下的缓存击穿吗？

**核心结论**：**只能解决单个 JVM 内的击穿**。`sync = true` 让同一 key 的加载串行化，只有一个线程执行方法，其他线程等结果；但 Caffeine 是进程内锁，RedisCache 的同步也只在单个 JVM 内，N 个实例仍会各自回源一次。跨实例互斥要用分布式锁或逻辑过期。

- 限制：不能和 `unless` 同用，同一方法上只能有这一个缓存操作
- 配套：TTL 加随机抖动防雪崩（`RedisCacheManager` 支持按条目计算 TTL）

→ 详见 [Cache 抽象](/spring/5_cache#_2、热点-key-击穿-sync-true)、[缓存一致性](/cache/10_cache_consistency)

### Q31：`@Retryable` 与 `@Transactional` 一起用时，重试应该在事务内还是事务外？

**核心结论**：**重试要包住事务**，每次重试都是一个新事务。如果在同一个事务内部重试，第一次失败可能已把事务标记为 rollback-only，之后的重试即使成功也提交不了；乐观锁冲突、死锁这类需要重新读数据的场景，同一事务里重试也读不到新快照。

- 推荐把两者放在**不同 Bean**：外层 Bean 的方法标 `@Retryable`，调用内层 Bean 的 `@Transactional` 方法，顺序一目了然
- 同一方法上同时标两个注解时，拦截器先后取决于各自的 order，不直观，不建议依赖
- 只重试幂等操作与瞬时错误，且只在一层重试（网关、客户端、业务各最多调用 3 次即 27 倍放大）

→ 详见 [Retry 重试](/spring/6_retry#_2、重试要包住事务-而不是在事务里重试)

### Q32：`@TransactionalEventListener` 有哪些阶段？AFTER_COMMIT 里写库为什么不生效？

**核心结论**：四个阶段：`BEFORE_COMMIT`（仍在原事务内，适合写 Outbox）、`AFTER_COMMIT`（默认，发 MQ、通知、删缓存）、`AFTER_ROLLBACK`、`AFTER_COMPLETION`。AFTER_COMMIT 时原事务已提交，但连接、`EntityManager` **仍绑定在当前线程**，监听器里的写操作会「加入」这个已结束的事务、不会再提交——更新静默丢失。正确写法是给监听器加 `@Transactional(propagation = REQUIRES_NEW)`。

- Framework 6.1 起启动时校验：`@TransactionalEventListener` 方法上的 `@Transactional` 只能是 `REQUIRES_NEW` 或 `NOT_SUPPORTED`，否则启动失败
- 没有活动事务时发布事件，监听器**默认不执行**（事件被丢弃），需要时设 `fallbackExecution = true`
- AFTER_COMMIT 监听器抛出的异常只记日志，不影响原事务也不抛给发布方

→ 详见 [事件机制](/spring/7_event#六、事务事件-transactionaleventlistener)

### Q33：Spring 进程内事件可靠吗？怎么保证不丢？

**核心结论**：进程内事件是**至多一次**：事务提交后、监听器完成前进程崩溃，或监听器执行失败，事件就丢了，没有重试也没有记录。事务事件只解决了「回滚了还发消息」，没解决「提交了却没发出去」。不能丢的事件要持久化：

| 方案 | 做法 | 适用 |
|------|------|------|
| 事务性 Outbox | 业务事务内写消息表，提交后由定时任务或 CDC 投递到 MQ | 跨服务，通用方案 |
| Spring Modulith 事件发布注册表 | `spring-modulith-starter-jdbc` 在原事务内记录发布，监听成功后标记完成，可重启重投 | 单体 / 模块化单体内部 |
| 事务消息 | RocketMQ 半消息 + 回查 | 已用 RocketMQ |

- 会重投就必须幂等；`@ApplicationModuleListener` = `@Async` + `REQUIRES_NEW` + `@TransactionalEventListener`
- 一致性要求不同的后续动作分开处理：同库扣库存用同步监听同一事务，发积分用 AFTER_COMMIT + 防丢机制，发通知用 AFTER_COMMIT + `@Async`

→ 详见 [事件机制](/spring/7_event#_3、可靠性边界-至多一次)、[分布式事务](/distributed/4_transaction)

## 七、WebFlux 与响应式

### Q34：WebFlux 和 Spring MVC 有什么区别？有了虚拟线程还需要 WebFlux 吗？

**核心结论**：MVC 是每请求一线程的阻塞模型；WebFlux 基于 Reactive Streams，用约等于 CPU 核数的事件循环线程处理大量请求，**前提是整条链路都不阻塞**。虚拟线程让「阻塞写法 + 高并发」变得廉价，削弱了为扩展性引入 WebFlux 的理由；但背压、流式处理、取消传播、组合多个异步源仍是响应式独有的。

| 对比 | Spring MVC | Spring WebFlux |
|------|-----------|----------------|
| 线程模型 | 每请求一线程（可换虚拟线程） | 少量事件循环线程 |
| 容器 | Tomcat / Jetty | 默认 Reactor Netty，也可 Tomcat / Jetty |
| 数据访问 | JDBC / JPA | R2DBC、响应式 Redis / MongoDB |
| 调试成本 | 低 | 高（堆栈不连续、线程跳转、上下文传递） |
| 适合 | 常规业务系统 | 网关、流式推送、大量异步调用聚合 |

- 常规 CRUD 优先 MVC + 虚拟线程（`spring.threads.virtual.enabled=true`）；在 WebFlux 里调 JDBC 会卡住事件循环，吞吐反而低于 MVC

→ 详见 [WebFlux](/spring/8_webflux#二、spring-mvc-vs-spring-webflux)

### Q35：Mono / Flux 是什么？为什么说「订阅之前什么都不会发生」？

**核心结论**：`Mono` 是 0..1 个元素、`Flux` 是 0..N 个元素的异步序列。响应式链路分三个阶段：组装（调用操作符只是层层包装，不执行业务）→ 订阅（`subscribe()` 自下而上传递，下游发出 `request(n)`）→ 执行（数据自上而下流动）。没有订阅就没有执行。

| 对比 | `CompletableFuture` | `Mono` / `Flux` |
|------|--------------------|-----------------|
| 触发 | 创建即执行 | 订阅才执行，可重复订阅 |
| 背压 / 取消 | 无 / 不中断已在跑的任务 | 有 / 沿链路向上传播 |

常见误区：

- Service 里调用 `repository.save(entity)` 却没把返回的 `Mono` 接入链路——没人订阅，**不会写库**
- `doOnNext(x -> repo.save(x))` 同样没有订阅，应改为 `flatMap(repo::save)`
- `Mono.just(remoteCall())` 在组装阶段就执行了，包耗时操作用 `fromCallable` / `defer`
- 同一个 `Mono` 订阅两次会执行两次（发两次请求），要复用结果用 `cache()`

→ 详见 [WebFlux](/spring/8_webflux#七、reactor-执行模型)

### Q36：为什么不能在事件循环线程上阻塞？`publishOn` 与 `subscribeOn` 有什么区别？阻塞调用如何包装？

**核心结论**：一个事件循环线程负责成百上千个连接，在它上面阻塞，等于让这些连接一起停摆。`publishOn(s)` 只影响**它之后**的操作符，可多次切换；`subscribeOn(s)` 影响**订阅与源头发射**，写在哪都一样，多个时只有最靠近源头的生效。

| 调度器 | 用途 |
|--------|------|
| `Schedulers.parallel()` | CPU 密集计算，绝不可阻塞 |
| `Schedulers.boundedElastic()` | 包装阻塞调用（默认上限 CPU × 10 个线程） |

```java
Mono.fromCallable(() -> legacyClient.fetch(id))       // 用 fromCallable，不要 Mono.just(...)
    .subscribeOn(Schedulers.boundedElastic());
```

- 链路中禁止 `block()`，在 parallel / Netty 线程上调用会直接抛 `IllegalStateException`；测试中用 BlockHound 兜底检测
- `boundedElastic` 是隔离手段不是扩容手段，大量阻塞说明这部分业务不适合响应式；Reactor 3.6+ / JDK 21+ 可让它基于虚拟线程

→ 详见 [WebFlux](/spring/8_webflux#八、线程模型与调度器)

### Q37：什么是背压？HTTP 链路上背压能跨网络传递吗？

**核心结论**：背压是下游通过 `Subscription.request(n)` 告诉上游自己还能处理多少，上游最多发 n 个。进程内的操作符链路完整遵守背压；到了 HTTP 边界，协议没有按条请求的语义，只剩 **TCP 流控**的间接效果。RSocket 有协议级背压（`REQUEST_N` 帧），R2DBC 能否映射为游标分批取决于驱动。

- `publishOn` 默认预取 256、`flatMap` 默认并发 256，把下游的无限需求转换为对上游的分批请求；`limitRate` 保护会一次拉太多的上游
- 无法减速的源（`Flux.interval`、`Sinks`、WebSocket 消息）必须选策略：`onBackpressureBuffer(max)`（满了报错）、`onBackpressureDrop`、`onBackpressureLatest`、`onBackpressureError`

→ 详见 [WebFlux](/spring/8_webflux#九、背压-backpressure)

### Q38：响应式链路中 ThreadLocal / MDC 为什么会失效？如何传递上下文？

**核心结论**：一个请求会在事件循环线程、boundedElastic 线程、WebClient 回调线程间跳转，一个线程又交替处理多个请求，所以入口放进 `ThreadLocal` 的值后续**可能读不到，甚至读到别的请求的值**。替代方案是绑定在**订阅**上的 Reactor `Context`。

| 手段 | 说明 |
|------|------|
| Reactor `Context` | 不可变；`contextWrite` 只对写在它**上游**的操作符可见；业务用 `deferContextual` 读；`ReactiveSecurityContextHolder` 基于它实现 |
| 自动上下文传播 | Boot 3.2+ 设 `spring.reactor.context-propagation=auto`（默认 `limited`），每个操作符执行时把 Context 中已注册的值恢复到 ThreadLocal，traceId 由此进入 MDC |
| 自定义字段 | 业务放进 MDC 的字段（如 tenantId）要注册 `ThreadLocalAccessor`，并在 `WebFilter` 中写入 Context |

- 响应式事务也靠 Context 传递连接，链路外另起的 `subscribe()` 不在事务里

→ 详见 [WebFlux](/spring/8_webflux#十、context-与上下文传播)

## 八、Spring Security

### Q39：Spring Security 的过滤器链是如何工作的？授权由哪个组件完成？

**核心结论**：Servlet 应用中 Spring Security 本质是一组 Filter：容器只认识 `DelegatingFilterProxy`，它转交给 Spring 容器中的 `FilterChainProxy`，后者选出**第一条匹配**的 `SecurityFilterChain` 依次执行。授权由链尾的 `AuthorizationFilter` 交给 `AuthorizationManager` 判定。

| 过滤器 | 职责 |
|--------|------|
| `SecurityContextHolderFilter` | 加载 `SecurityContext`（无状态 API 每次为空） |
| `CsrfFilter` | 校验 CSRF Token，无状态 Bearer Token API 可关闭 |
| 认证过滤器 | `BearerTokenAuthenticationFilter`、`UsernamePasswordAuthenticationFilter` 等，成功后写入 `Authentication` |
| `ExceptionTranslationFilter` | 未认证 → `AuthenticationEntryPoint`（401），无权限 → `AccessDeniedHandler`（403） |
| `AuthorizationFilter` | 最后一道关，委托 `AuthorizationManager` |

- 多条链用 `securityMatcher` 限定范围、`@Order` 决定匹配顺序
- `SecurityContextHolder` 默认 `ThreadLocal`：`@Async`、线程池、虚拟线程中要用 `DelegatingSecurityContextAsyncTaskExecutor` 等包装执行器
- 排查时 `logging.level.org.springframework.security=TRACE` 会打印每条链的过滤器列表

→ 详见 [Spring Security](/spring/9_security#一、核心架构)

### Q40：Security 6 / 7 的配置方式有哪些变化？

**核心结论**：配置从「继承适配器」变成「声明 Bean + Lambda DSL」，授权从 Access API 换成 `AuthorizationManager`。

| 旧写法（5.x） | 新写法（6.x / 7.x） |
|--------------|-------------------|
| 继承 `WebSecurityConfigurerAdapter`（6.0 移除） | 声明 `SecurityFilterChain` Bean |
| `authorizeRequests()` + `FilterSecurityInterceptor` | `authorizeHttpRequests()` + `AuthorizationFilter` |
| `antMatchers` / `mvcMatchers` | `requestMatchers`，按声明顺序先具体后宽泛，`anyRequest()` 放最后 |
| `@EnableGlobalMethodSecurity` | `@EnableMethodSecurity`（基于 `AuthorizationManager`） |
| `AccessDecisionManager` 等 Access API | Security 7 移入遗留模块 `spring-security-access`，新代码不用 |

- Security 7 起 Spring Authorization Server 并入主项目；Boot 4 的 OAuth2 相关 starter 改名为 `spring-boot-starter-security-oauth2-*`
- `hasRole("ADMIN")` 实际检查 `ROLE_ADMIN`，`hasAuthority("order:delete")` 原样比对；密码用 `DelegatingPasswordEncoder`

→ 详见 [Spring Security](/spring/9_security#二、securityfilterchain-配置)、[Spring Boot 版本演进](/spring-boot/11_versions)

### Q41：JWT 认证用 OAuth2 Resource Server 和自定义过滤器有什么区别？自定义过滤器有哪些坑？

**核心结论**：Resource Server 是 Spring Security 自带的 JWT 校验能力：从 `Authorization: Bearer` 取 Token、验签、校验 `exp` / `nbf` / `iss`、用 `JwtAuthenticationConverter` 把 claims 映射成权限，不用自己写过滤器和解析代码，**优先使用**。对接授权服务器只需配 `issuer-uri`，自签发时声明 `JwtEncoder` / `JwtDecoder`（优先 RS256 / ES256）。

自定义 JJWT 过滤器（存量写法）的常见坑：

| 坑 | 正确做法 |
|----|---------|
| 声明成 `@Component` | Boot 会自动注册为 Servlet Filter，链外链内各执行一次；直接 `new` 后加入安全链 |
| 每个请求 `loadUserByUsername` 查库 | 权限直接取自 claims，这才是无状态的意义 |
| 解析多次、手写 `isExpired` | 解析一次，`parseSignedClaims` 已校验过期 |
| principal 强转业务类型失败 | `UserDetailsService` 返回自定义 `UserDetails` 带出 userId |

- 无状态的代价：权限变更要等 Token 过期，访问 Token 要短并配合刷新 Token；吊销与轮换见安全模块

→ 详见 [Spring Security](/spring/9_security#四、jwt-认证-oauth2-resource-server-推荐)、[JWT 令牌机制](/security/1_jwt)

### Q42：如何实现方法级权限和数据库驱动的动态 URL 权限？

**核心结论**：方法级用 `@EnableMethodSecurity` + `@PreAuthorize`；动态 URL 权限实现 `AuthorizationManager<RequestAuthorizationContext>`，在内存中按请求匹配规则，通过 `.anyRequest().access(manager)` 挂到 `AuthorizationFilter` 上。

- `@PreAuthorize` 基于代理，**自调用不生效**；按参数名引用（`#userId`）依赖 `-parameters`；`@PostAuthorize` 在方法执行后判断，只适合只读方法；权限码多时用元注解模板（Security 6.4+）
- 动态规则缓存在内存，**不要每个请求查库**，权限数据变更时刷新缓存；「未配置规则时放行还是拒绝」是安全策略，默认拒绝更安全
- 用户拥有的权限码来自 Token，调整角色要等 Token 刷新；要即时生效就在 `AuthorizationManager` 中按 userId 查缓存的最新权限
- 旧的 `FilterInvocationSecurityMetadataSource` + `AccessDecisionManager` 方案属于已移入遗留模块的 Access API

→ 详见 [Spring Security](/spring/9_security#七、动态权限-authorizationmanager)、[权限系统架构设计](/architecture/6_access_control)

### Q43：Spring Security、Sa-Token、Shiro 如何选型？Sa-Token 的注解为什么不生效？

**核心结论**：Spring Security 能力最全、与 Spring 生态绑定最深（OAuth2、Actuator、Spring Session、授权服务器）；Sa-Token 上手最快、会话管理（踢人、封禁、多端登录）开箱即用；Shiro 适合非 Spring 或存量项目，3.0 起支持 Boot 3 / 4，1.x / 2.x 已 EOL。

| 场景 | 推荐 |
|------|------|
| 标准企业项目、需要 OAuth2 / OIDC 与 Spring 生态集成 | Spring Security（+ Authorization Server 或 Keycloak） |
| 国内中小项目，追求开发速度与会话管理能力 | Sa-Token（集群部署接 Redis） |
| 非 Spring 项目或存量 Shiro | Shiro 3.x，升级 Boot 4 时评估迁移 |

- **Sa-Token 注解由 `SaInterceptor` 解析**，不注册拦截器时 `@SaCheckLogin` 等注解全部不生效；`StpInterface` 每次鉴权都会回调，要读缓存
- 一个应用只用一个安全框架，两套框架各有「当前用户」和过滤器链，会互相干扰

→ 详见 [安全框架对比](/spring/10_auth_framework#五、选型建议)

### Q44：Keycloak 接入 OIDC 时如何实现单点登出？登录应用里为什么拿不到角色？

**核心结论**：单点登出要两个方向都配：本应用 → Keycloak 用 `OidcClientInitiatedLogoutSuccessHandler`（自动带 `id_token_hint`，Keycloak 18 起必需）；Keycloak → 本应用用 `.oidcLogout(l -> l.backChannel(...))` 接收 Back-Channel 登出通知。角色拿不到是因为 **Keycloak 默认只把 `realm_access.roles` 放进 access_token**，ID Token 和 UserInfo 里没有。

- 角色的两种解法：在 Keycloak 的 `roles` 客户端作用域中打开「Add to ID token」，再用 `GrantedAuthoritiesMapper` 映射；或让后端资源服务器从 access_token 读取（微服务更常见）
- Back-Channel 是服务器对服务器的 POST，Keycloak 必须能直接访问应用地址
- 多实例部署要提供共享的 `OidcSessionRegistry`，否则登出通知落到 A 实例时 B 实例的会话不会失效

→ 详见 [Spring SSO 接入](/spring/11_single_sign_on#六、keycloak-实战)、[OIDC](/security/3_oidc)

### Q45：如何用 Spring Authorization Server 搭建授权服务器？Security 7 中有什么变化？

**核心结论**：Security 7.0 起 SAS 并入 Spring Security 主项目（1.5.x 是最后一个独立版本线），坐标仍是 `spring-security-oauth2-authorization-server`、版本跟随 Security，Boot 4 starter 为 `spring-boot-starter-security-oauth2-authorization-server`，DSL 入口变成 `HttpSecurity#oauth2AuthorizationServer(...)`。

搭建要点：

- **两条过滤器链**：第一条只匹配协议端点（`/oauth2/authorize`、`/oauth2/token`、`/.well-known/*`），第二条负责用户登录
- **持久化**：`RegisteredClientRepository`、授权记录、授权同意用 JDBC 实现，建表脚本在 jar 内，纳入 Flyway
- **客户端**：前端用授权码 + PKCE，服务间用 client_credentials
- **生产**：issuer 固定且与对外域名一致；签名密钥来自密钥库或 KMS 并定期轮换（先发布新公钥再切私钥）；定时清理过期授权记录

需要开箱即用的用户管理、社交登录、管理后台时，用 Keycloak 比自建更省事。

→ 详见 [Spring SSO 接入](/spring/11_single_sign_on#七、spring-authorization-server-实战)、[OAuth2](/security/2_oauth2)

## 九、批处理与集成

### Q46：Spring Batch 中 JobInstance 与 JobExecution 有什么区别？失败的作业如何从断点续跑？

**核心结论**：作业名 + 标识性参数确定一个 **JobInstance**（一次逻辑运行，如「6 月 1 日的对账」）；每次启动是一个 **JobExecution**，一个实例可以有多次执行。COMPLETED 的实例不能再次执行（抛 `JobInstanceAlreadyCompleteException`，正是防重复的机制）；FAILED / STOPPED 的实例可以重启。

- **断点续跑**：一个 chunk 一个事务，提交时把读取位置写入 `ExecutionContext`；重启时已完成的 Step 跳过，失败的 Chunk Step 从记录位置继续，已提交的 chunk 不重做
- 前提：Reader 实现 `ItemStream` 并设置 `name`；最后一个未提交的 chunk 会重做，Writer 必须幂等
- **不要用时间戳参数「保证唯一」**：每次都成了新实例，失败后从头开始，还破坏了「同一业务日只跑一次」的保护；需要每次新实例用 `RunIdIncrementer` + `startNextInstance`
- 进程被强杀后执行记录停在 STARTED，Batch 6 用 `JobOperator#recover` 修复；Batch 5 下失败的实例不能在 Batch 6 中重启

→ 详见 [Spring Batch 批处理](/spring/12_batch#六、重启语义)

### Q47：在 Boot 项目里加 `@EnableBatchProcessing` 会发生什么？

**核心结论**：Boot 的批处理自动配置会**整体退让**：`spring.batch.*` 配置全部失效（包括 `job.enabled`、`jdbc.initialize-schema`，元数据表不会创建）；而且 Spring Batch 6 中 `@EnableBatchProcessing` 不再绑定 JDBC，单独使用得到的是 **Resourceless 作业仓库**——什么都不持久化，重启和防重复执行全部失效，且没有任何报错。

- Boot 项目直接依赖自动配置；生产用 `spring-boot-starter-batch-jdbc`（Boot 4 的 `spring-boot-starter-batch` 本身是 Resourceless 仓库）
- 元数据放独立数据源时用 `@BatchDataSource` / `@BatchTransactionManager`，不需要关闭自动配置
- Batch 6 还有：`JobOperator` 取代 `JobLauncher`，用 `ChunkOrientedStepBuilder` 并显式设置事务管理器

→ 详见 [Spring Batch 批处理](/spring/12_batch#_2、陷阱-不要加-enablebatchprocessing)

### Q48：Chunk 步骤中 filter 与 skip 有什么区别？

**核心结论**：**filter 是业务上「这条不要」**——Processor 返回 null，该条不进入 Writer，计入 `filterCount`；**skip 是「这条出错了但可以容忍」**——读、处理或写时抛出配置为可跳过的异常，计入 `skipCount`，超过 `skipLimit` 作业失败。两者在 `StepExecution` 中分开统计，对账时不要混在一起。

- 被跳过的记录用 `SkipListener` 记下来，便于事后补录
- 写阶段发生可跳过异常时，框架会回滚当前 chunk 并逐条重试以找出坏记录，Writer 要能承受重复执行

→ 详见 [Spring Batch 批处理](/spring/12_batch#_3、itemprocessor-校验与清洗)

### Q49：Spring Batch 有哪些扩展方式（多线程 Step、分区、远程分块）？

**核心结论**：按成本从低到高：多线程 Chunk Step → 并行流（`split` 让互不依赖的 Step 并行）→ 分区（Manager Step 用 `Partitioner` 按 ID 范围切分，多个 Worker Step 并行处理，可本地也可远程）→ 远程分块 / 远程分区（基于 Spring Integration 的消息通道把工作分发到其他进程）。

| 读取方式 | 特点 |
|---------|------|
| 分页读取 `JdbcPagingItemReader` | 线程安全，可用于多线程与分区；排序键必须唯一 |
| 游标读取 `JdbcCursorItemReader` | 单线程最快，非线程安全，长时间占连接；MySQL 要设 `fetchSize(Integer.MIN_VALUE)` 或 `useCursorFetch=true` |

- 多线程 Step 下重启语义会变弱（多个线程共享读取位置），需要可靠重启时优先用分区
- IO 密集的 Worker 可以用虚拟线程执行器

→ 详见 [Spring Batch 批处理](/spring/12_batch#七、扩展与性能)

### Q50：Spring Integration 与 Spring Cloud Stream、Apache Camel 是什么关系？如何选择？

**核心结论**：Spring Integration 是企业集成模式（EIP）的 Spring 实现（Message + Channel + Endpoint + Adapter），面向文件、DB、HTTP、FTP、MQ 的多协议集成管道；**Spring Cloud Stream 构建在它之上**，Binding 背后就是 MessageChannel，专注服务间的事件驱动消息。Apache Camel 是同样以 EIP 为核心的独立集成框架，组件数量最多、运行时更多样。

| 选择 | 场景 |
|------|------|
| Spring Integration | 技术栈全是 Spring，集成流不多，需要与 Spring 事务、Spring Batch 深度协作 |
| Apache Camel | 对接大量异构系统（SaaS、FTP、EDI），集成路由多，运行在 Quarkus 上，希望用 YAML 或可视化维护；4.19 起 camel-spring-boot 只支持 Boot 4，Boot 3 项目用 4.18 LTS |
| Spring Cloud Stream | 服务间发布 / 订阅事件，希望保留换 MQ 的自由度 |
| 原生 Spring Kafka / AMQP | 只是消费一个主题 |

→ 详见 [Spring Integration](/spring/13_integration#六、apache-camel-对比)

## 十、版本演进

### Q51：Spring Framework 5 → 6 → 7 有哪些关键变化？

**核心结论**：6.0 是破坏性升级（JDK 17、`javax` → `jakarta`），7.0 是基线与 API 的整理（Jakarta EE 11、Jackson 3、JSpecify），新能力主要集中在 HTTP 客户端、API 版本与内置弹性。

| 版本 | 对应 Boot | 关键变化 |
|------|----------|---------|
| 5.3 | 2.x | JDK 8+，最后一个 `javax` 版本，WebFlux |
| 6.0 | 3.0 | JDK 17+；`jakarta.*`；AOT 与 GraalVM 原生镜像；HTTP Interface；ProblemDetail；非 public 方法可被 CGLIB 代理事务化 |
| 6.1 | 3.2 | 虚拟线程支持；`RestClient`、`JdbcClient`；MVC 内置方法参数校验；CRaC |
| 6.2 | 3.4 / 3.5 | Bean 后台初始化；`@MockitoBean`；`rollbackOn = ALL_EXCEPTIONS` |
| 7.0 | 4.0 | Jakarta EE 11（Servlet 6.1）；JSpecify 空安全；默认 Jackson 3；MVC / WebFlux 内置 API 版本控制；`@Retryable` / `@ConcurrencyLimit`；`@ImportHttpServices` |
| 7.1 | 4.1 | `RestTemplate` 标记 `@Deprecated`，计划 8.0 移除 |

→ 详见 [Spring 总览](/spring/0_overview#_2、版本演进)、[Spring Boot 版本演进](/spring-boot/11_versions)

### Q52：`RestTemplate`、`RestClient`、`WebClient`、HTTP Service Clients 怎么选？

**核心结论**：同步调用用 `RestClient`（6.1 / Boot 3.2+）；调用面宽、希望收口成接口时用 HTTP Service Clients（`@HttpExchange` 接口，Framework 7 / Boot 4 用 `@ImportHttpServices` 按组注册、`spring.http.serviceclient.<group>.*` 配置）；响应式栈用 `WebClient`；`RestTemplate` 在 7.1 废弃，只维护存量代码。

| 客户端 | 风格 | 状态 |
|--------|------|------|
| `RestTemplate` | 模板方法 | 7.1 `@Deprecated`，计划 8.0 移除；Boot 只提供 `RestTemplateBuilder` |
| `RestClient` | 同步、Fluent | 同步场景的推荐方案 |
| `WebClient` | 响应式 | 持续维护；Boot 4 只想在 MVC 应用里用时引 `spring-boot-starter-webclient` |
| HTTP Service Clients | 声明式接口 | 微服务内部调用的推荐方式，取代功能冻结的 OpenFeign |

- 注入 Boot 预配置的 `RestClient.Builder` 构造客户端；**所有客户端都要设超时**，默认可能无限等待

→ 详见 [Web 开发](/spring-boot/2_web_dev#七、http-客户端)、[服务通信](/spring-cloud/3_communication)

### Q53：Framework 7 内置的 `@Retryable` 与 Spring Retry 有什么区别？`@ConcurrencyLimit` 为什么和虚拟线程有关？

**核心结论**：Framework 7 把重试收进 `spring-context`（`@EnableResilientMethods` 开启，不需要 Spring Retry 和 AspectJ starter），Spring Retry 已归档、Boot 4 不再管理其版本。`@ConcurrencyLimit` 限制同时进入方法的线程数，**主要用来给虚拟线程补回并发上限**：虚拟线程不池化，没有了「线程池大小」这道闸，大量并发会压垮数据库连接池或限频的下游。

| 概念 | Spring Retry | Framework 7 |
|------|-------------|-------------|
| 次数 | `maxAttempts`（**含**首次，默认 3） | `maxRetries`（**不含**首次，默认 3） |
| 退避 | `@Backoff(delay, multiplier, maxDelay, random)` | `delay` / `multiplier` / `maxDelay` / `jitter` |
| 兜底 | `@Recover` | 无，调用方 catch 或用 `RetryTemplate` |
| 熔断 | `@CircuitBreaker`（只按失败次数） | 无，用 Resilience4j / Sentinel |
| 响应式 | 不支持 | 返回 `Mono` / `Flux` 时自动套用 Reactor 重试 |

- 迁移换算：`maxAttempts = 3` 对应 `maxRetries = 2`
- `@ConcurrencyLimit` 是单实例内的并发闸门，不是集群限流；`policy` 默认 `BLOCK`，可选 `REJECT`

→ 详见 [Retry 重试](/spring/6_retry#三、并发限制-concurrencylimit)、[Spring Boot 版本演进](/spring-boot/11_versions#_7、内置弹性注解-retryable-concurrencylimit)

## 十一、自动配置与 Starter

### Q54：Spring Boot 自动配置的原理是什么？`@SpringBootApplication` 做了什么？为什么用户定义的 Bean 总是优先？

**核心结论**：`@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan`。`@EnableAutoConfiguration` 导入 `AutoConfigurationImportSelector`，它是 `DeferredImportSelector`，**等所有用户配置类解析完才执行**：读取各 jar 的 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` → 排除 → 用编译期元数据快速过滤 → 排序 → 完整条件判定后注册。因为用户 Bean 先注册，自动配置里的 `@ConditionalOnMissingBean` 能看到它，于是退让。

| 组成注解 | 细节 |
|---------|------|
| `@SpringBootConfiguration` | 被 `@Configuration` 元注解；测试切片靠它向上查找应用配置，一个应用只能有一个 |
| `@ComponentScan` | 从主类所在包向下扫描，带 `TypeExcludeFilter` 与 `AutoConfigurationExcludeFilter` |
| `@EnableAutoConfiguration` | 导入自动配置候选 |

- 快速过滤读取 `META-INF/spring-autoconfigure-metadata.properties`，不加载类就能判断 `@ConditionalOnClass`，数百个候选类因此不拖慢启动
- 排除：`exclude` / `excludeName` 或 `spring.autoconfigure.exclude`

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#三、自动配置原理)

### Q55：`spring.factories` 与 `AutoConfiguration.imports` 有什么区别？Boot 4 的模块化自动配置改变了什么？

**核心结论**：自动配置的登记位置从 `spring.factories` 的 `EnableAutoConfiguration` 键迁到了 `AutoConfiguration.imports`：2.7 引入，**3.0 起只认后者**，旧方式静默失效。`spring.factories` 并没有废弃，仍负责 `ApplicationListener`、`EnvironmentPostProcessor`、`FailureAnalyzer` 等启动期扩展点。

| 版本 | 自动配置登记 |
|------|------------|
| 2.6 及以前 | `spring.factories` |
| 2.7 | 两者并存，新增 `@AutoConfiguration` |
| 3.x / 4.x | 只认 `AutoConfiguration.imports` |

Boot 4 把一个巨大的 `spring-boot-autoconfigure` 拆成按技术划分的模块（`spring-boot-<技术>`，根包 `org.springframework.boot.<技术>`），每个模块自带 imports 文件、与 `spring-boot-starter-<技术>` 一一对应：

- **引哪个 starter 才有哪部分自动配置**：只引 `flyway-core` 不引 `spring-boot-starter-flyway`，迁移静默不执行
- 直接引用自动配置类的代码要改包名（`exclude`、`@ImportAutoConfiguration`、`@EntityScan`）
- 过渡期用 `spring-boot-starter-classic` / `spring-boot-starter-test-classic` 拿回全部自动配置

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_2、登记文件的演进)

### Q56：`@ConditionalOnBean` 为什么只在自动配置类里可靠？如何排查某个自动配置为什么生效或没生效？

**核心结论**：`@ConditionalOnBean` / `@ConditionalOnMissingBean` 的结果取决于**判定时已注册了哪些 BeanDefinition**。自动配置类在用户配置之后、且可用 `@AutoConfiguration(after = ...)` 控制相互顺序；普通 `@Configuration` 之间的处理顺序不确定，可能误判。

- 类级 `@ConditionalOnClass(X.class)` 是安全的（ASM 读注解、不加载类）；`@Bean` 方法上引用可能缺失的类会 `NoClassDefFoundError`，应写 `name = "..."` 或拆到嵌套配置类

| 排查手段 | 用途 |
|---------|------|
| `--debug` 或 `logging.level.org.springframework.boot.autoconfigure=debug` | 启动时打印条件评估报告（匹配 / 不匹配及原因） |
| `/actuator/conditions` | 运行中查看条件评估报告 |
| `/actuator/beans` | 确认最终注册了哪个 Bean |
| `ConditionEvaluationReportLoggingListener` | 在 `ApplicationContextRunner` 测试中打印原因 |

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_4、条件注解)

### Q57：如何自定义一个 Spring Boot Starter？装配顺序、条件、配置元数据和测试要注意什么？

**核心结论**：命名 `<名称>-spring-boot-starter`（`spring-boot` 开头留给官方），拆成 autoconfigure（自动配置类、属性类、imports 文件，集成的库标 `optional`）与 starter（只做依赖聚合）两个模块，自动配置类登记到 `AutoConfiguration.imports`。

| 关注点 | 做法 |
|--------|------|
| 装配顺序 | `@AutoConfiguration(after = DataRedisAutoConfiguration.class)`；Boot 4 依赖具体的 `spring-boot-<技术>` 模块，3.x 类名不同（`RedisAutoConfiguration`） |
| 条件 | Bean 上加 `@ConditionalOnMissingBean` 允许覆盖；开关用 `@ConditionalOnBooleanProperty`（3.5+） |
| 属性类 | 只用 `@EnableConfigurationProperties` 登记，不加 `@Component` |
| Bean 依赖 | `@AutoConfiguration` 是 lite 模式，依赖写成方法参数 |
| 元数据 | `spring-boot-configuration-processor` 生成 IDE 提示，`spring-boot-autoconfigure-processor` 生成条件预过滤元数据 |
| 测试 | `ApplicationContextRunner` 覆盖默认装配、关闭开关、用户覆盖、缺少依赖（`FilteredClassLoader`）四类分支 |

→ 详见 [自定义 Starter](/spring-boot/8_custom_starter)

## 十二、启动流程

### Q58：`SpringApplication.run()` 的启动流程是什么？各生命周期事件的顺序？

**核心结论**：构造阶段推断应用类型（SERVLET / REACTIVE / NONE）、从 `spring.factories` 加载 `BootstrapRegistryInitializer`、`ApplicationContextInitializer`、`ApplicationListener`，推断主类；`run()` 依次准备 Environment、创建并刷新容器、执行 Runner。

| 顺序 | 步骤 | 事件 |
|------|------|------|
| 1 | `listeners.starting()` | `ApplicationStartingEvent` |
| 2 | `prepareEnvironment()`：加载配置文件，`EnvironmentPostProcessor` 改写配置 | `ApplicationEnvironmentPreparedEvent` |
| 3 | `createApplicationContext()`：`ApplicationContextFactory` 按类型创建 | — |
| 4 | `prepareContext()`：执行 Initializer、注册主配置类 | `ApplicationContextInitializedEvent`、`ApplicationPreparedEvent` |
| 5 | `refreshContext()`：解析配置与自动配置；`onRefresh` 创建 Web 服务器，`finishRefresh` 中 `SmartLifecycle` 启动它 | `WebServerInitializedEvent`、`ContextRefreshedEvent` |
| 6 | `listeners.started()` | `ApplicationStartedEvent`，`LivenessState.CORRECT` |
| 7 | `callRunners()` | — |
| 8 | `listeners.ready()` | `ApplicationReadyEvent`，`ReadinessState.ACCEPTING_TRAFFIC` |

- 启动失败发布 `ApplicationFailedEvent`，由 `FailureAnalyzer` 输出可读原因

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#二、springapplication-run-启动流程)、[IoC 容器](/spring/1_ioc)

### Q59：为什么用 `@Component` 监听不到 `ApplicationEnvironmentPreparedEvent`？

**核心结论**：前四个事件（Starting、EnvironmentPrepared、ContextInitialized、Prepared）发布时容器还没刷新，`@Component` + `@EventListener` 的 Bean 根本不存在。这类监听器必须写进 `META-INF/spring.factories` 的 `ApplicationListener` 键，或在启动前 `application.addListeners(...)` 注册。

- 想在配置加载阶段改写配置，用 `EnvironmentPostProcessor`（Boot 4 中移到 `org.springframework.boot` 包，`spring.factories` 键同步修改）
- 监听 `ContextRefreshedEvent` 做一次性初始化要防重：父子容器、手动 `refresh()` 时会触发多次，一次性逻辑放 `ApplicationReadyEvent`

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_2、run-主流程与生命周期事件)

### Q60：Runner 执行期间就绪探针为什么不通过？启动后的预热逻辑应该放在哪里？

**核心结论**：`ApplicationRunner` / `CommandLineRunner` 在 `ApplicationStartedEvent` 之后、`ApplicationReadyEvent` 之前执行，而 `ReadinessState.ACCEPTING_TRAFFIC` 在 Ready 时才发布，所以 **Runner 期间就绪探针不通过**——这正好用来做缓存预热：预热完成前不接流量。

- Runner 抛异常会让整个应用启动失败，非关键任务自己捕获异常
- 耗时很长且不影响接流量的任务不要阻塞启动，交给异步线程池
- 也可以发布 `AvailabilityChangeEvent` 主动切换就绪状态；配合 K8s 的 `startupProbe` 防止慢启动被反复重启

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#_4、applicationrunner-与-commandlinerunner)、[Actuator 监控](/spring-boot/7_actuator#四、存活-就绪探针与健康分组)

## 十三、配置管理

### Q61：Spring Boot 配置源的优先级是怎样的？为什么 `-D` 系统属性会覆盖环境变量？

**核心结论**：从高到低：DevTools 全局设置 > 测试属性 > 命令行参数 > `SPRING_APPLICATION_JSON` > Servlet / JNDI 参数 > **Java 系统属性 > 操作系统环境变量** > `random.*` > 配置文件 > `@PropertySource` > 默认属性。系统属性排在环境变量之前是 Boot 规定的顺序，容器里最容易踩坑：镜像里 `JAVA_OPTS="-Dspring.profiles.active=prod"` 写死的值会压过 Kubernetes 注入的 `SPRING_PROFILES_ACTIVE`。

| 配置文件内部顺序（高 → 低） |
|---------------------------|
| jar 外的 `application-{profile}.yml` |
| jar 外的 `application.yml` |
| jar 内的 Profile 文件 |
| jar 内的默认文件 |

- 同位置 `.properties` 优先于 `.yml`；`@PropertySource` 在刷新时才加入，对 `logging.*`、`spring.main.*` 无效
- 排查用 `/actuator/env` 查看属性来源

→ 详见 [配置管理](/spring-boot/6_config#一、配置源优先级)

### Q62：`@Value` 与 `@ConfigurationProperties` 有什么区别？松散绑定与校验怎么用，如何绑定到 record？

**核心结论**：`@Value` 适合零散单值，不支持校验、不生成元数据、松散绑定有限；结构化配置用 `@ConfigurationProperties`，推荐 **record + 构造器绑定 + `@Validated`**（Boot 3.0 起单构造器自动构造器绑定，不再需要 `@ConstructorBinding`）。

| 对比 | `@Value` | `@ConfigurationProperties` |
|------|---------|---------------------------|
| 松散绑定 | 有限，注解里必须写规范形式（小写 kebab-case） | 完整 |
| 校验 | 不支持 | `@Validated`，失败则**启动失败** |
| IDE 元数据 | 无 | `spring-boot-configuration-processor` 生成 |
| 动态刷新（Spring Cloud） | 所在 Bean 需 `@RefreshScope` | JavaBean 写法原地重绑定；record 不可变不会重绑定 |

- 松散绑定：配置文件写 `my.main-project.person.first-name`，环境变量写 `MY_MAINPROJECT_PERSON_FIRSTNAME`（`.` 换 `_`、去掉 `-`、全大写）
- 注册用 `@ConfigurationPropertiesScan` 或 `@EnableConfigurationProperties`，不要再加 `@Component`；嵌套对象需 `@Valid` 才级联校验

→ 详见 [配置管理](/spring-boot/6_config#二、属性注入)

### Q63：`spring.config.import` 有什么用？（`optional:`、`configtree:`、Nacos / Vault）

**核心结论**：Boot 2.4 起在配置文件里声明额外配置源的统一入口，被导入的内容优先级高于发起导入的文件；不带 `optional:` 时目标不存在直接启动失败，适合生产必需的配置。

| 写法 | 用途 |
|------|------|
| `optional:file:./extra.yml` | 可选的额外文件 |
| `configtree:/etc/secrets/` | 读取 K8s 挂载的 Secret，文件名为键、内容为值；不会出现在进程环境变量中 |
| `nacos:order-service.yaml` | Spring Cloud Alibaba 2025.1 起唯一的 Nacos 配置接入方式（取消 bootstrap） |
| `vault://` | 拉取 Vault 密钥，生产认证用 `KUBERNETES` / `APPROLE` |

- Spring Cloud 2020.0 起 bootstrap 上下文默认关闭，配置中心统一走 `spring.config.import`

→ 详见 [配置管理](/spring-boot/6_config#四、spring-config-import)、[配置中心](/spring-cloud/4_config_center)

## 十四、Web 与数据访问

### Q64：Boot 4 为什么移除了 Undertow？开启虚拟线程后 Tomcat 的线程配置还有效吗？

**核心结论**：Boot 4 基于 Jakarta EE 11 / Servlet 6.1，Undertow 尚不支持 Servlet 6.1，所以 4.0 删除了它的 starter 与内嵌支持，Servlet 栈只剩 Tomcat 11 与 Jetty 12.1（Boot 3.x 仍可用 Undertow）。开启 `spring.threads.virtual.enabled=true` 后每个请求跑在虚拟线程上，`server.tomcat.threads.max` **不再是并发上限**。

- 并发上限转移到下游：数据库连接池、HTTP 客户端连接池成为真正的瓶颈，要单独设上限，或用 `@ConcurrencyLimit` / `Semaphore`
- 虚拟线程开关在 JDK 21–23 上要排查 `synchronized` 内阻塞导致的钉住，JDK 24 起已解决，生产基线建议 JDK 25
- 没有明确理由时保持默认 Tomcat

→ 详见 [启动流程与自动配置](/spring-boot/1_spring_boot#五、内嵌-web-服务器)、[虚拟线程](/java/30_topic_virtual_thread)

### Q65：加了 `@EnableWebMvc` 会发生什么？

**核心结论**：Boot 的 Spring MVC 自动配置**整体退出**：静态资源映射、基于 Jackson 的消息转换器、`spring.mvc.*` 配置等默认装配全部失效，常见症状是静态资源 404、日期格式和 `spring.jackson.*` 配置不生效。定制 MVC 应实现 `WebMvcConfigurer`，不要加 `@EnableWebMvc`。

→ 详见 [Web 开发](/spring-boot/2_web_dev#_1、starter-与默认装配)

### Q66：Filter 中的异常为什么进不了 `@RestControllerAdvice`？Filter 相对 Spring Security 的顺序如何确定？

**核心结论**：`@RestControllerAdvice` 由 `DispatcherServlet` 内的 `HandlerExceptionResolver` 处理，Filter 在 `DispatcherServlet` **之外**执行，它抛出的异常只能被容器转发到 `/error`（`BasicErrorController`）。Filter 层的错误要在 Filter 内自己写响应，或交给 Spring Security 的 `AuthenticationEntryPoint`。

- Spring Security 的过滤器链整体作为一个 Filter 注册，顺序为 `spring.security.filter.order`（默认 -100）：`@Order` 比它小的 Filter 在认证**之前**执行，比它大的在认证**之后**执行
- `/error` 返回字段由 `server.error.include-*` 控制，生产保持 `never`

→ 详见 [Web 开发](/spring-boot/2_web_dev#四、错误响应-error-与-problemdetail)

### Q67：`allowedOriginPatterns("*")` + `allowCredentials(true)` 有什么风险？

**核心结论**：`allowedOrigins("*")` + 凭证会被框架直接禁止（抛 `IllegalArgumentException`）；而把它换成 `allowedOriginPatterns("*")` 能运行，但等于**把任意来源原样回显**到 `Access-Control-Allow-Origin`，任何网站都能带着用户 Cookie 调用接口并读取响应。携带凭证时必须用明确的域名白名单，或可信的子域通配（`https://*.example.com`）。

- 使用 Bearer Token 而不依赖 Cookie 的接口通常不需要 `allowCredentials(true)`
- 启用 Spring Security 时要在安全配置中开启 CORS，否则预检请求先被过滤器链拦下；CORS 不是鉴权手段
- 微服务下 CORS 只在网关处理一次，下游再加会出现重复响应头

→ 详见 [Web 开发](/spring-boot/2_web_dev#_2、携带凭证时的安全陷阱)

### Q68：JPA 实体为什么不能用 `@Data`？open-in-view、N+1 与 `LazyInitializationException` 怎么处理？

**核心结论**：`@Data` 生成的 `toString` 会访问懒加载关联（事务外触发 `LazyInitializationException`，双向关联 `StackOverflowError`），`equals` / `hashCode` 基于全部字段（遍历集合触发查询、放入 `HashSet` 后改字段再也找不到），全量 setter 破坏封装。用 `@Getter` / `@Setter` + 基于 id 的 `equals`。

| 问题 | 处理 |
|------|------|
| `LazyInitializationException` | 在事务内用 `JOIN FETCH` / `@EntityGraph` 取齐，或查 DTO 投影；**关闭 `open-in-view`**，不要靠它掩盖（它让连接持有到视图渲染结束，并把 N+1 推到 Controller 层） |
| N+1 | `@EntityGraph`、`JOIN FETCH`、`hibernate.default_batch_fetch_size` |
| 批量插入慢 | `IDENTITY` 主键无法批量插入，改用 `JdbcClient` 批量或序列 / 雪花 ID |
| 只读查询有脏检查开销 | `@Transactional(readOnly = true)` 或 DTO 投影 |

→ 详见 [数据访问](/spring-boot/3_data_access#_4、常见问题)

### Q69：Boot 如何选择事务管理器？dynamic-datasource 在外层事务中 `@DS` 为什么失效？

**核心结论**：Boot 自动开启注解事务（不需要 `@EnableTransactionManagement`），只有 JDBC / MyBatis 时配置 `JdbcTransactionManager`，引入 JPA 后配置 `JpaTransactionManager`（它同样管理同一数据源上的 JDBC / MyBatis 操作）；自己声明多个 `DataSource` 时只为唯一或 `@Primary` 的那个创建事务管理器，其他要自己声明并在 `@Transactional("...")` 中指定。

`@DS` 失效的原因：**外层事务开始时连接已从 primary 取出并绑定到线程**，内层所有操作复用这个连接，`@DS` 的路由根本没机会发生。读写分离时「在写事务里调一个 `@DS("slave")` 的查询」实际查的是主库。

- `@DSTransactional` 只是本地多数据源事务，提交阶段部分失败仍会不一致，不是分布式事务
- `@DS` 基于 AOP，自调用同样失效；从库有复制延迟，写后立即读要强制走主库

→ 详见 [数据访问](/spring-boot/3_data_access#_2、路由原理与事务陷阱)

### Q70：多实例同时启动时 Flyway 迁移会冲突吗？MySQL 上脚本执行失败后如何修复？

**核心结论**：**不会冲突，也不需要分布式锁**：Flyway 迁移前获取数据库级锁（MySQL 命名锁、PostgreSQL advisory lock），后启动的实例等待，拿到锁后发现没有待执行脚本直接跳过。真正要关注的是大表 DDL 锁表、滚动发布期间新旧代码并存（变更必须向后兼容、先扩展后收缩）、迁移拖慢启动（可放到 K8s Job / initContainer）。

MySQL 的 DDL 会隐式提交、无法回滚：一个脚本里三条 `ALTER TABLE`，第二条失败时第一条已生效，历史表留下失败记录。修复是**手工修正表结构 → `flyway repair` 清除失败记录 → 重新迁移**，所以 MySQL 上一个脚本只做一件事（PostgreSQL 支持事务性 DDL，没有这个问题）。

- Boot 4 必须引入 `spring-boot-starter-flyway`；Flyway 10+ 还要引入数据库模块（如 `flyway-mysql`），否则报 `Unsupported Database`
- 已执行的脚本永远不改，`clean` 在生产永远禁用

→ 详见 [数据库版本迁移](/spring-boot/4_flyway#_5、并发迁移与发布)

### Q71：Flyway 与 Liquibase 怎么选？生产上是回滚还是向前修复？

**核心结论**：单一数据库、团队习惯写 SQL 选 Flyway（多数项目的首选）；同一套变更要适配多种数据库，或对回滚、按环境选择性执行有明确要求时选 Liquibase。生产上**更常用向前修复**：回滚 DDL 往往伴随数据丢失（删掉新列，列里的数据也没了），回滚脚本主要用于发布失败、数据尚未写入时的快速撤回。

| 对比 | Flyway | Liquibase |
|------|--------|-----------|
| 变更描述 | SQL 为主 | XML / YAML / JSON / SQL，可跨数据库 |
| 回滚 | 撤销迁移（`U`）仅付费版 | 免费，部分变更可自动推导 |
| 并发控制 | 数据库锁，进程退出自动释放 | 锁表，进程被强杀需 `release-locks` |
| 选择性执行 | 按 `locations` | `context`、`labels`、前置条件 |

→ 详见 [数据库版本迁移](/spring-boot/4_flyway#_4、与-flyway-对比)

## 十五、中间件、异步与定时

### Q72：Lettuce 需要连接池吗？Kafka 消息反序列化失败为什么会卡住分区？

**核心结论**：Lettuce 连接线程安全，默认所有线程**共享一个连接**，普通命令不需要连接池；只有阻塞命令（`BLPOP`）和事务（`MULTI`）需要独占连接时池才有意义，而且池生效还要引入 `commons-pool2`，否则 `pool` 配置被静默忽略。Kafka 反序列化发生在 `poll` 阶段、在监听方法之前，直接使用 `JacksonJsonDeserializer` 时一条格式错误的消息会让每次 poll 都失败，offset 无法前进，分区永远卡住。

- 用 `ErrorHandlingDeserializer` 包一层，把坏消息交给 `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` 送进死信 Topic
- Boot 4 的 Kafka 序列化器换成 Jackson 3 版本（`JacksonJsonSerializer` / `JacksonJsonDeserializer`），`trusted.packages` 只写事件类所在包
- 不要在监听方法里 catch 后只打日志：offset 照常提交，消息就此丢失

→ 详见 [中间件集成](/spring-boot/5_middleware)、[Kafka](/messaging/2_kafka)

### Q73：`@Async` 默认用哪个执行器？为什么开启虚拟线程后 `@Async` 可能不受影响？

**核心结论**：什么都不配时用 Boot 自动配置的 `applicationTaskExecutor`（`ThreadPoolTaskExecutor`，开启虚拟线程后换成基于虚拟线程的 `SimpleAsyncTaskExecutor`）。但**一旦声明了任意 `Executor` Bean 或 `AsyncConfigurer`，自动配置就整体退让**，`@Async` 改用你的执行器，虚拟线程开关对它不再生效。

| 场景 | `@Async` 用的执行器 |
|------|-------------------|
| 什么都不配 | `applicationTaskExecutor` |
| 声明了 `Executor` Bean | 你的 Bean（多个时取 `@Primary` 或名为 `taskExecutor` 的） |
| 声明了 `AsyncConfigurer` | `getAsyncExecutor()` 返回的 |
| `spring.task.execution.mode=force`（3.5+） | 有自定义 `Executor` 也保留 `applicationTaskExecutor` |
| `@Async("orderExecutor")` | 指定名称的 Bean |

- 默认执行器的 `queue-capacity` 与 `max-size` 都是无界的，用 `spring.task.execution.pool.*` 设上限
- 自定义 `Executor` 会让 `applicationTaskExecutor` 消失，而 MVC 异步请求、WebFlux 阻塞调用也依赖它
- 返回 `CompletableFuture` 的异常在 Future 里，`void` 方法的异常进 `AsyncUncaughtExceptionHandler`；同类自调用、忘了 `@EnableAsync` 都会让它同步执行

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#_1、谁在执行-async-方法)、[线程池](/java/28_topic_thread_pool)

### Q74：`@Scheduled` 默认用几个线程？如何避免任务互相阻塞？

**核心结论**：未开启虚拟线程时，Boot 自动配置的 `ThreadPoolTaskScheduler` **默认只有 1 个线程**，所有 `@Scheduled` 方法排队执行：一个任务卡 10 分钟，其他任务全部延迟 10 分钟。

- 用 `spring.task.scheduling.pool.size` 按任务数调大
- 长任务在方法里把实际工作提交给业务线程池（或加 `@Async("xxx")`），调度线程只负责按时触发；此时同一任务可能并发执行，要自己防重入
- `fixedRate` 按固定频率触发、`fixedDelay` 在上次结束后计时；Spring 的 cron 是 6 段（含秒），要写 `zone`

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#_2、默认只有一个调度线程)

### Q75：多实例部署时如何让定时任务只执行一次？（ShedLock vs XXL-JOB）

**核心结论**：`@Scheduled` 是进程内调度，N 个实例执行 N 次。只要「多实例只执行一次」用 **ShedLock** 给任务加分布式锁；需要管理台、手动触发、失败重试、告警、分片时用 **XXL-JOB** 等调度平台；需要持久化触发器与错过补偿用 Quartz 集群。

| 方案 | 要点 |
|------|------|
| ShedLock | `lockAtMostFor` 要明显大于正常耗时；`lockAtLeastFor` 抵消时钟偏差；只保证同一时刻最多一个实例执行，不补跑、不分片 |
| XXL-JOB | `xxl-job-core` 没有 Boot 自动配置，必须手动声明 `XxlJobSpringExecutor` Bean；`accessToken` 从环境变量取，执行器端口只对调度中心开放 |

→ 详见 [异步任务与定时任务](/spring-boot/9_async_schedule#三、多实例下的定时任务)、[分布式调度](/distributed/6_job_scheduler)

## 十六、运维与可观测

### Q76：Actuator 的暴露（exposure）与访问（access）有什么区别？生产环境如何保护管理端点？

**核心结论**：暴露决定端点能否通过 HTTP / JMX 被访问到（`management.endpoints.web.exposure.include`，默认只暴露 `health`）；访问级别（3.4+）决定允许哪些操作（`management.endpoint.<id>.access`：`none` / `read-only` / `unrestricted`），`max-permitted` 是全应用上限。3.4 之前的 `management.endpoint.<id>.enabled` 已废弃。

生产保护：

- **独立管理端口**：网关只转发业务端口，Prometheus、K8s 探针访问管理端口
- **`EndpointRequest` 单独建一条 `SecurityFilterChain`** 为管理端点鉴权；未自定义链时 Boot 默认保护除 `/health` 外的全部端点
- `heapdump`（3.5 起默认 `none`）、`shutdown` 不要开放；`env` / `configprops` 默认脱敏，不要把 `show-values` 设成 `always`
- `exposure.include: "*"` 在任何版本都不该用于生产

→ 详见 [Actuator 监控](/spring-boot/7_actuator#_2、暴露与访问是两件事)

### Q77：存活探针与就绪探针有什么区别？为什么外部依赖不能放进存活探针？

**核心结论**：存活（`/actuator/health/liveness`）回答「进程还活着吗」，失败时 K8s **重启容器**；就绪（`/actuator/health/readiness`）回答「能接流量吗」，失败时**只摘流量不重启**。数据库抖动时如果存活探针包含数据库检查，所有 Pod 会被同时重启，一次依赖故障被放大成全量重启。

- Boot 4 起探针分组默认开启（3.x 只在检测到 K8s 时自动开启）；`add-additional-paths=true` 在业务端口提供 `/livez`、`/readyz`
- 共享依赖要不要进就绪分组同样要谨慎，系统级取舍见高可用答案页

→ 详见 [Actuator 监控](/spring-boot/7_actuator#四、存活-就绪探针与健康分组)、[开发总结 - 高可用](/interview/14_high_avail#q9-k8s-的-liveness-和-readiness-探针有什么区别-为什么探针不建议检查数据库等共享依赖)

### Q78：如何用 Micrometer 写自定义业务指标？如何避免高基数？Observation API 做什么？

**核心结论**：注入 Boot 自动配置的 `MeterRegistry`，在构造器里创建 Meter 并保存为 `final` 字段。三条规则：**同名同键**（同一指标名的标签键集合必须一致）、**标签值有限**（`channel`、`result` 可以，用户 ID、订单号、完整 URL 不行，每个组合都是一条时间序列）、**命名用点分小写**（`order.created` 会被转成 `order_created_total`）。

- Observation API（Micrometer 1.10+）一次埋点同时产出 Timer 指标和链路 Span，Spring MVC、`RestClient`、Kafka 内部都基于它；方法上用 `@Observed` 需 AspectJ starter 并开启 `management.observations.annotations.enabled`
- Prometheus 开关是 `management.prometheus.metrics.export.enabled`；环境标签在抓取配置里加，不要用 `${spring.profiles.active}`

→ 详见 [Actuator 监控](/spring-boot/7_actuator#六、指标-micrometer-与-prometheus)

### Q79：Boot 3.4+ 的结构化日志怎么用？traceId 如何进入日志，跨线程如何传递？

**核心结论**：设置 `logging.structured.format.console` / `file` 为 `ecs`、`logstash` 或 `gelf` 即输出 JSON，无需 `logstash-logback-encoder`，MDC 中的键值对自动成为字段。引入 Micrometer Tracing 后它会把当前 Span 的 `traceId` / `spanId` 写入 MDC，**不需要自己生成 traceId**；用 `logging.pattern.correlation` 定制文本格式。

| 场景 | 传递方式 |
|------|---------|
| 线程池 / `@Async` | 执行器设置 `TaskDecorator`（Boot 4 起多个 `TaskDecorator` Bean 自动组合）；恢复而不是清空调用方的 MDC |
| 响应式链路 | `spring.reactor.context-propagation=auto` |
| 跨服务 | Micrometer Tracing 自动注入 W3C `traceparent` 等请求头 |

- 常见组合：本地开发控制台用文本，生产容器只输出 stdout 的 JSON
- Boot 4 中 `management.tracing.enabled` 更名为 `management.tracing.export.enabled`

→ 详见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)

### Q80：如何在生产环境真正关闭接口文档？

**核心结论**：用 springdoc 的配置开关 `springdoc.api-docs.enabled=false`（Swagger UI 同理），而不是给 `OpenApiConfig` 加 `@Profile("!prod")`——后者只去掉了自定义的 `OpenAPI` / `GroupedOpenApi` Bean，springdoc 的自动配置仍会用默认信息提供 `/v3/api-docs` 和 Swagger UI。更稳妥的是**默认关闭、按需开启**：`application.yml` 里设为 `false`，只在 dev / test 的 Profile 文件中打开。

- 文档路径单独一条 `SecurityFilterChain`，生产不放行
- 版本：Boot 4 用 springdoc-openapi 3.x，Boot 3 用 2.x；Knife4j 只作为 Boot 3 项目的可选 UI（使用时再加 `knife4j.production: true`）

→ 详见 [接口文档](/spring-boot/10_api_doc#五、按环境关闭)

## 十七、测试

### Q81：`@SpringBootTest` 与切片测试怎么选？Boot 4 的测试有哪些变化？

**核心结论**：能不启动 Spring 就不启动：纯单元测试 → 切片测试（`@WebMvcTest`、`@DataJpaTest`、`@JsonTest`、`@RestClientTest`，只加载某一层）→ `@SpringBootTest` + Testcontainers → `RANDOM_PORT` 端到端，越往上越慢、越少。只有要验证「Spring 帮你做的事」（绑定、校验、事务、序列化、自动配置）时才往上走。

| Boot 4 变化 | 说明 |
|------------|------|
| JUnit 6 | Framework 7 的最低要求，JUnit 4 支持类废弃 |
| 测试模块化 | `spring-boot-starter-<技术>-test`，切片注解换包（如 `org.springframework.boot.webmvc.test.autoconfigure`） |
| 不再自动提供测试客户端 | `@SpringBootTest` 需显式加 `@AutoConfigureMockMvc`、`@AutoConfigureRestTestClient` 等 |
| 新客户端 | `MockMvcTester`（6.2+，AssertJ 风格）、`RestTestClient`（7.0+，Mock 与真实服务器两用） |
| `@MockBean` 删除 | 改用 `@MockitoBean` / `@MockitoSpyBean` |

- `@WebMvcTest` 不扫描 `@Service`，依赖要用 `@MockitoBean` 提供；它会加载安全过滤器链

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#一、测试依赖与分层)

### Q82：`@MockBean` 为什么被 `@MockitoBean` 取代？为什么 Mock 一多测试就变慢？

**核心结论**：Framework 6.2 在 TestContext 层提供了 `@MockitoBean` / `@MockitoSpyBean`，Boot 3.4 起 `@MockBean` / `@SpyBean` 废弃、**Boot 4.0 删除**；新注解只能写在测试类（及父类、`@Nested` 外层类）上，Framework 7 起还能覆盖非单例 Bean。变慢的原因是 **Mock 参与上下文缓存键**：A 类 Mock 了 `PaymentClient`、B 类 Mock 了 `SmsClient`、C 类什么都不 Mock，就是三个上下文各启动一次。

- 把「外部依赖一律 Mock」收敛成组合注解或测试基类，所有集成测试共享一个上下文；同一 Bean 的 Mock 字段名也要一致
- 打碎缓存的其他因素：不同的 `properties` / `@ActiveProfiles` / `@DynamicPropertySource`、`@DirtiesContext`；缓存默认最多 32 个

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#四、mock-bean-mockitobean-与-mockitospybean)

### Q83：Testcontainers 如何与 Spring Boot 集成？`@ServiceConnection` 做了什么？

**核心结论**：`@ServiceConnection`（Boot 3.1+）让 Boot 直接从容器生成 `ConnectionDetails`，自动配置据此连接数据库、Redis、Kafka 等，取代手写 `@DynamicPropertySource` 逐个填 URL、用户名、密码。推荐把容器**声明成 `@Bean`** 交给 Spring 管理生命周期，所有集成测试 `@Import` 同一个配置类，共享一个上下文和一组容器。

- `@Container` 静态字段随测试类结束而停止，但上下文还在缓存里，下一个复用它的测试类会连到已停止的容器
- `GenericContainer` 无法推断服务类型，要写 `@ServiceConnection(name = "redis")`
- 同一份容器配置可用于本地开发：`spring-boot:test-run` / `bootTestRun` 启动，不用本地装数据库
- Testcontainers 2.0 起 artifact 加 `testcontainers-` 前缀

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#五、testcontainers-集成)、[Testcontainers](/testing/5_testcontainers)

### Q84：测试方法上的 `@Transactional` 什么时候不会回滚？

**核心结论**：测试事务默认回滚，但它只能回滚**同一线程、同一事务**中的写入：`RANDOM_PORT` / `DEFINED_PORT` 下请求在服务器线程中执行、`REQUIRES_NEW` 开启的独立事务、`@Async` 等其他线程中的写入都**不会回滚**。另外 JPA 写入可能还在持久化上下文中没 flush，断言前要 `flush()`，否则测试通过了但 SQL 根本没执行。

- 想看到落库结果用 `@Commit`；不要测试事务用 `propagation = NOT_SUPPORTED`
- 验证真实事务边界（传播、回滚规则）时去掉测试事务，自己清理数据

→ 详见 [Spring Boot 测试](/spring-boot/13_testing#六、事务回滚语义与陷阱)

## 十八、版本与启动优化

### Q85：Spring Boot 2.x → 3.x → 4.x 的关键变化是什么？老项目如何升级？

**核心结论**：2 → 3 是破坏性升级（Java 8 → 17、`javax` → `jakarta`、Hibernate 6、Sleuth → Micrometer Tracing、Security 6）；3 → 4 是整理性升级（Java 基线仍是 17，但模块化 starter、Jackson 3、Jakarta EE 11 与一批废弃 API 的删除带来大量编译错误）。截至 2026-10，2.x 与 3.x 的 OSS 支持已全部结束，新项目直接用 4.x。

| 升级 | 典型问题 |
|------|---------|
| 2.7 → 3.x | `jakarta` 包名；自动配置改登记到 `AutoConfiguration.imports`；`spring.redis.*` → `spring.data.redis.*`；`WebSecurityConfigurerAdapter` 不存在；尾斜杠匹配默认关闭 |
| 3.5 → 4.x | starter 改名（`webmvc`、`aspectj`、`security-oauth2-*`）与模块化；Jackson 3（`tools.jackson`）；`@MockBean` 删除；Undertow 删除；`spring.data.mongodb.*` → `spring.mongodb.*`；Spring Retry 版本需自管 |

升级路线：**2.x → 2.7.x 最新 → 3.5.x 最新 → 4.x，不跳级**，每步先清掉所有废弃警告；借助 `spring-boot-properties-migrator` 与 OpenRewrite 配方，Spring Cloud 等非 Boot 管理的依赖按兼容表同步升级，最后靠全量测试、接口 JSON 对比与灰度兜底。

→ 详见 [Spring Boot 版本演进](/spring-boot/11_versions#五、升级指南)

### Q86：Spring Boot 应用启动慢怎么优化？懒加载、CDS / AOT 缓存、Native Image 怎么选？

**核心结论**：启动时间 = 类加载链接 + Bean 创建 + JIT 预热。先度量（`BufferingApplicationStartup` + `/actuator/startup` 找最慢的 Bean，常见元凶是启动期远程调用和连接建立），再做低成本优化（去掉无用 starter、处理启动期 IO），最后按场景选构建期方案。

| 方案 | 启动 | 主要代价 |
|------|------|---------|
| 懒加载 | 较快 | 配置错误推迟到首个请求暴露，建议只在开发 / 测试开启 |
| CDS（JDK 21） / AOT 缓存（JDK 25+ 优先） | 快，几乎无代码改造 | 需 `jarmode=tools extract` 解压布局 + `spring.context.exit=onRefresh` 训练运行；缓存与应用版本、JVM 绑定 |
| CRaC | 恢复即峰值 | 特定 JDK + Linux；快照包含密钥等敏感数据 |
| Native Image | 毫秒级、内存最低 | 封闭世界，Bean 定义构建期固定，反射需提示，构建慢，峰值吞吐偏低 |

- JVM 部署的默认选择：Java 25+ 用 AOT 缓存、Java 21 用 CDS，放进镜像构建流水线（Buildpacks 用 `BP_JVM_AOTCACHE_ENABLED` / `BP_JVM_CDS_ENABLED`）
- Native Image 只在 Serverless、频繁扩缩容等启动与内存是核心指标的场景采用

→ 详见 [启动与部署优化](/spring-boot/14_startup#九、方案对比与选型)

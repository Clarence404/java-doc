---
description: IoC、Bean 生命周期、AOP、事务、MVC、常用组件、WebFlux、Security、批处理与集成、版本演进
---

# Spring 面试题解答

> 题目清单见 [Spring 面试题](/spring/99_interview)，模块入口见 [Spring 总览](/spring/0_overview)；Spring Boot 的题目见 [Spring Boot 面试题解答](/interview/5_spring_boot)；JDK 代理与 CGLIB 的细节见 [Java 基础面试题解答](/interview/1_java)。
>
> 版本基线：Spring Framework 7 / Spring Boot 4 / Spring Security 7（JDK 17+），与旧版本不同处单独说明。

## 一、IoC 与 DI

### Q1：IoC 和 DI 的区别？Spring IoC 容器的作用是什么？

**一句话**：IoC（控制反转）是思想：对象不再由业务代码自己 `new`，而是交给容器创建和组装；DI（依赖注入）是做法：容器创建对象时把它需要的依赖塞进去。

- IoC 是目标，DI 是实现它的手段
- 容器负责创建对象并注入依赖：把注解、`@Bean` 等解析成 Bean 定义，再实例化
- 容器负责生命周期：初始化、销毁回调，以及单例 / 多例等作用域
- 解耦：业务只依赖接口，换实现不用改调用方
- AOP、事务、缓存、`@Async` 都是建立在容器扩展点（`BeanPostProcessor`）之上的

→ 详见 [IoC 容器](/spring/1_ioc)

### Q2：`BeanFactory` 和 `ApplicationContext` 的区别？`refresh()` 有哪几个关键阶段？

**一句话**：`BeanFactory` 是最底层的容器，用到时才创建 Bean；`ApplicationContext` 在它之上加了事件、国际化、环境配置等功能，并且启动时就把单例全部建好，配置错误在启动时就能暴露。实际开发只用 `ApplicationContext`。

`refresh()` 共 12 步，记住三步：

- 第 5 步：解析 `@Configuration`、`@ComponentScan`、`@Import`、`@Bean`，生成 Bean 定义；Boot 自动配置在这里导入
- 第 6 步：注册 `BeanPostProcessor`（对 Bean 做加工的后置处理器），之后创建的 Bean 才会被它们处理
- 第 11 步：创建所有非懒加载的单例，依赖注入、初始化回调、AOP 代理都在这一步发生
- 另外：Boot 在第 9 步创建内嵌 Tomcat，第 12 步启动它开始监听端口

→ 详见 [IoC 容器](/spring/1_ioc#一、容器与启动流程)

### Q3：Bean 的注入方式有哪些？构造器注入、Setter 注入、字段注入各有什么优缺点？

**一句话**：首选构造器注入；可选依赖用 Setter 或 `ObjectProvider`；不推荐字段注入。

| 方式 | 优点 | 缺点 |
|------|------|------|
| 构造器注入 | 字段可以 `final`；缺依赖启动就报错；单测直接 `new` | 依赖多时构造器很长（说明该拆类了） |
| Setter 注入 | 适合可选依赖 | 对象可能没初始化完整就被使用 |
| 字段注入 | 写法最短 | 不能 `final`，离开容器没法测试，依赖多少看不出来 |

- 只有一个构造器时可以省略 `@Autowired`
- 可选依赖用 `ObjectProvider<T>#ifAvailable` 比 `@Autowired(required = false)` 更清楚

→ 详见 [IoC 容器](/spring/1_ioc#_1、三种注入方式)

### Q4：`@Autowired` 和 `@Resource` 的区别？有多个候选 Bean 时如何消歧义？

**一句话**：`@Autowired` 先按类型找，找到多个再按 `@Primary`、`@Priority`、变量名去匹配；`@Resource` 先按名字找，没写 `name` 时找不到名字才按类型找。

| 对比 | `@Autowired` | `@Resource` |
|------|-------------|-------------|
| 来源 | Spring | Jakarta 标准注解 |
| 可用位置 | 构造器、方法、字段、参数 | 字段、setter，不能用在构造器 |
| 消歧义 | `@Qualifier`、`@Primary` | `name` 属性 |

- 都匹配不上时 `@Autowired` 抛 `NoUniqueBeanDefinitionException`
- 策略分发时可以直接注入 `Map<String, T>`（key 是 Bean 名）或 `List<T>`，比手动 `getBean` 好测试

**常见坑**：Spring 6 起只认 `jakarta.*`，残留的 `javax.annotation.Resource` / `PostConstruct` 会被直接忽略，不报错。

→ 详见 [IoC 容器](/spring/1_ioc#_2、多个候选-bean-的消歧义)

### Q5：`@Bean` 的 full 模式与 lite 模式（`proxyBeanMethods`）有什么区别？

**一句话**：full 模式下配置类会被生成一个 CGLIB 子类，`@Bean` 方法之间互相调用返回的是容器里那个单例；lite 模式不生成子类，互相调用就是普通方法调用，每次都 `new` 一个新对象。

| 对比 | full（`@Configuration` 默认） | lite（`proxyBeanMethods = false`） |
|------|------|------|
| 配置类 | 生成子类，类和方法不能 `final` | 原始类 |
| `@Bean` 方法互调 | 返回容器单例 | 创建新对象 |
| 启动速度 | 多一次字节码生成 | 更快，对原生镜像更友好 |

- `@Bean` 写在 `@Component` 类里也是 lite 模式
- Boot 的自动配置全部是 lite；业务配置也推荐 lite，把依赖写成 `@Bean` 方法的参数

→ 详见 [IoC 容器](/spring/1_ioc#_2、-bean-full-模式与-lite-模式)

### Q6：`@Import` 能导入哪些东西？`ImportSelector` 与 `ImportBeanDefinitionRegistrar` 在自动配置和 `@EnableXxx` 中起什么作用？

**一句话**：`@Import` 能导入三种东西：普通配置类、`ImportSelector`（运行时返回要导入哪些类）、`ImportBeanDefinitionRegistrar`（用代码直接注册 Bean 定义）。所有 `@EnableXxx` 本质上都是一个带 `@Import` 的注解。

- 普通配置类：`@Import(DataSourceConfig.class)`
- `ImportSelector`：Boot 自动配置就靠它读取 `AutoConfiguration.imports` 文件；它的延迟版本 `DeferredImportSelector` 会等用户配置都处理完才执行
- `ImportBeanDefinitionRegistrar`：`@MapperScan`、`@EnableFeignClients` 用它扫描接口，为每个接口注册一个代理

→ 详见 [IoC 容器](/spring/1_ioc#_3、-import)

### Q7：Spring Boot 2.6+ 为什么启动时报循环依赖？如何解决？三级缓存的原理是什么，为什么需要三级？

**一句话**：Boot 2.6 起默认禁止循环依赖，有循环就启动失败。解决顺序：先重构（抽出第三个 Bean 或改用事件）；其次在一个注入点加 `@Lazy` 或用 `ObjectProvider` 延迟获取；最后才临时打开 `spring.main.allow-circular-references`。

- 三级缓存（打开开关才起作用）：一级存完整的单例；二级存已被别人提前拿走的「半成品」；三级存一个工厂，调用时才生成半成品
- 为什么存工厂：AOP 代理本应在初始化之后才生成，工厂让「真的出现循环时才提前生成代理」，否则别的 Bean 拿到的是原始对象，事务就失效了
- 二级缓存的作用：工厂只调一次，A 同时被 B、C 依赖时拿到的是同一个对象
- 解决不了：构造器循环、prototype 循环、提前暴露后又被 `@Async` 等再包一层代理的情况

→ 详见 [IoC 容器](/spring/1_ioc#七、循环依赖)

## 二、Bean 生命周期与扩展点

### Q8：Spring Bean 的完整生命周期是什么？Aware 回调、`@PostConstruct`、`afterPropertiesSet`、`init-method` 与 AOP 代理创建的先后顺序？

**一句话**：实例化 → 属性注入 → Aware 回调 → `@PostConstruct` → `afterPropertiesSet` → `init-method` → 生成 AOP 代理 → 使用 → 销毁（`@PreDestroy` → `destroy` → `destroy-method`）。

- Aware 回调：让 Bean 拿到容器信息，如 Bean 名、`ApplicationContext`
- `@PostConstruct` 由一个后置处理器在「初始化前」调用，所以早于 `afterPropertiesSet`
- AOP 代理在「初始化后」生成，容器里最终保存的是代理
- 只有单例会回调销毁方法，prototype 不会

**常见坑**：在 `@PostConstruct` 里调本类的 `@Transactional` 方法没有事务（代理还没生成，而且是 `this` 调用）；需要所有 Bean 都就绪的逻辑放到 `ApplicationReadyEvent`。

→ 详见 [IoC 容器](/spring/1_ioc#五、bean-生命周期)

### Q9：Bean 的作用域有哪些？单例中如何使用 prototype 和 request / session 作用域的 Bean？

**一句话**：有 `singleton`（默认）、`prototype`、`request`、`session`、`application`、`websocket`。单例只在创建时注入一次，所以直接注入短作用域的 Bean 拿到的永远是同一个对象，要用特殊方式获取。

- 用 prototype：注入 `ObjectProvider<T>` 或用 `@Lookup`，每次调用时再取一个新的
- 用 request / session：用作用域代理（`@RequestScope` 默认就是），注入的是一个单例代理，每次调用再转到当前请求的那个对象
- 单例 Bean 必须无状态或线程安全
- prototype 容器只管创建，不会调 `@PreDestroy`

**常见坑**：在 `@Async` 线程或 MQ 消费线程里用 request Bean，会报 `No thread-bound request found`（这些线程里没有当前请求）。

→ 详见 [IoC 容器](/spring/1_ioc#四、bean-作用域)

### Q10：Spring 有哪些核心扩展点？`FactoryBean` 和 `BeanFactory` 有什么区别？

**一句话**：`BeanFactory` 是容器本身；`FactoryBean` 是一个「生产 Bean 的 Bean」：`getBean("x")` 拿到的是它生产的对象，`getBean("&x")` 才拿到工厂自己。

扩展点按执行时机记：

- `BeanFactoryPostProcessor`：Bean 实例化前修改 Bean 定义，如处理 `${}` 占位符
- `BeanPostProcessor`：每个 Bean 初始化前后加工，AOP 代理、`@Async` 都靠它
- `ImportSelector` / `ImportBeanDefinitionRegistrar`：解析配置类时批量注册，自动配置和 `@EnableXxx` 用它
- `SmartInitializingSingleton`：所有单例创建完之后回调
- `SmartLifecycle`：容器启动完成时启动、关闭时停止，如 Web 服务器、Kafka 监听

**常见坑**：在配置类里声明 `BeanFactoryPostProcessor` / `BeanPostProcessor` 的 `@Bean` 方法要写成 `static`，否则配置类被提前创建，日志出现 "not eligible for getting processed by all BeanPostProcessors"。

→ 详见 [IoC 容器](/spring/1_ioc#六、核心扩展点)

## 三、AOP

### Q11：AOP 的核心概念（切面、切点、通知、连接点）是什么？Spring AOP 与 AspectJ 有什么区别？

**一句话**：切面 = 切点（选哪些方法）+ 通知（在这些方法前后做什么）；连接点是能被拦截的位置，Spring AOP 里只有「方法执行」这一种。

| 对比 | Spring AOP | AspectJ |
|------|-----------|---------|
| 原理 | 运行时生成代理 | 编译期 / 类加载期改字节码 |
| 能拦截 | Spring Bean 的方法 | 方法、构造器、字段读写等 |
| 同类内部调用 | 拦截不到 | 能拦截 |
| `private` / `final` / `static` 方法 | 不能 | 能 |
| 成本 | 几乎零配置 | 需要特殊编译器或 `-javaagent` |

- Spring AOP 借用了 AspectJ 的注解和切点写法，但实现完全不同

→ 详见 [AOP](/spring/2_aop#七、spring-aop-与-aspectj)

### Q12：Spring 如何在 JDK 动态代理和 CGLIB 之间选择？Spring Boot 默认用哪种？

**一句话**：纯 Spring 下，Bean 实现了接口就用 JDK 代理，否则用 CGLIB；Spring Boot 2.0 起默认一律用 CGLIB，避免按实现类注入时报类型错误。

- 选哪种看能力不看性能，现代 JDK 上两者开销差不多
- CGLIB 是生成子类：`final` 类代理不了；`final`、`private`、`static` 方法不会被拦截，而且不报错
- Spring 自带一份 CGLIB（在 `spring-core` 里），不依赖外部 CGLIB 包
- 代理在 Bean 初始化之后生成，匹配到切点就用代理替换原对象

**常见坑**：把 `@Transactional` 写在 `final` 方法上，事务静默失效。

→ 详见 [AOP](/spring/2_aop#四、spring-的代理选择)、[动态代理](/java/16_topic_proxy)

### Q13：通知的执行顺序是什么？多个切面如何排序？自定义切面如何放到事务的外层？

**一句话**：同一切面内，正常顺序是 `@Around` 前半 → `@Before` → 目标方法 → `@AfterReturning`（异常时 `@AfterThrowing`）→ `@After` → `@Around` 后半。多个切面用 `@Order` 排序，数字越小越在外层。

- 外层的意思：进入时最先执行，退出时最后执行
- 事务切面默认优先级最低，处在最内层
- 分布式锁、重试这类要包住事务的切面，给一个更小的 `@Order`，保证事务提交后才释放锁或重试
- 要在事务里写审计记录的切面，`@Order` 要比事务大
- 同一切面里两个同类型通知（如两个 `@Before`）顺序不确定，应合并或拆开

→ 详见 [AOP](/spring/2_aop#二、通知类型与执行顺序)

### Q14：`@Transactional` 等注解为什么在同一个类内部调用会失效？正确的修复方式有哪些，为什么不推荐注入自身？

**一句话**：外部拿到的是代理对象，而类内部 `this.method()` 的 `this` 是原始对象，不经过代理，所以 `@Transactional`、`@Async`、`@Cacheable`、`@PreAuthorize` 这些靠代理实现的注解全都不生效。

修复方式（按推荐顺序）：

- 拆分 Bean：把被调方法移到另一个 Bean，最清晰、也好测试
- 只是事务的话：用 `TransactionTemplate` 在代码里控制事务
- 延迟获取自己的代理：注入 `ObjectProvider<自己>` 或加 `@Lazy`，能用但不直观
- `AopContext.currentProxy()`：要开启 `exposeProxy`，和 AOP 实现绑死，不推荐

**常见坑**：直接 `@Autowired` 注入自己，本质是循环依赖，Boot 2.6+ 默认启动失败。

→ 详见 [AOP](/spring/2_aop#六、自调用失效问题)

## 四、事务

### Q15：`@Transactional` 的实现原理是什么？

**一句话**：靠 AOP 代理：调用进入代理后，事务拦截器通过事务管理器开启事务、从连接池拿一个连接关掉自动提交，并把连接放进当前线程；方法正常返回就提交，抛异常按规则回滚。

- 连接放在 `ThreadLocal` 里，`JdbcTemplate`、MyBatis、JPA 都从这里拿到同一个连接，所以它们在同一个事务里
- 拦截器会读取注解上的传播行为、隔离级别、超时、只读、回滚规则
- 由此推出三条边界：不经过代理就没有事务；换了线程就没有事务；自己另拿的连接不在事务里
- 响应式（WebFlux）事务把连接放在 Reactor `Context` 里，而不是 `ThreadLocal`

→ 详见 [事务管理](/spring/4_transaction#一、-transactional-的工作原理)

### Q16：Spring 事务的传播行为有哪几种？`REQUIRED`、`REQUIRES_NEW`、`NESTED` 有什么区别和风险？

**一句话**：共 7 种，常用 3 种：`REQUIRED`（默认，有事务就加入，没有就新建）、`REQUIRES_NEW`（挂起外层，自己开一个独立事务）、`NESTED`（同一个事务里打一个保存点）。传播行为只在跨 Bean 调用时生效。

| 对比 | `REQUIRED` | `REQUIRES_NEW` | `NESTED` |
|------|-----------|---------------|----------|
| 事务个数 | 和外层同一个 | 两个独立事务 | 同一个，内层是保存点 |
| 占用连接 | 1 | 2 | 1 |
| 内层失败 | 整个事务都要回滚 | 只回滚内层 | 回滚到保存点，外层可继续 |
| 外层失败 | 一起回滚 | 内层已提交，不受影响 | 一起回滚 |

- `REQUIRES_NEW` 的风险：一次调用占两个连接，高并发时外层占满连接池，内层永远拿不到连接，系统卡死；不要在循环里调用
- `NESTED` 依赖 JDBC 保存点，JDBC 事务管理器支持，JPA 事务管理器默认不支持

→ 详见 [事务管理](/spring/4_transaction#_2、required、requires-new-与-nested)

### Q17：什么情况下会出现 `UnexpectedRollbackException`（rollback-only）？如何避免？

**一句话**：外层事务方法调用另一个 Bean 的 `REQUIRED` 方法，内层抛了运行时异常，整个事务就被标记成「只能回滚」；外层即使 catch 住异常继续执行，提交时也会整体回滚，并抛出 `UnexpectedRollbackException`。

- 内层改成 `NESTED`：失败只回滚到保存点，外层还能正常提交
- 内层改成 `REQUIRES_NEW`：内层独立事务，注意多占一个连接
- 内层不开事务：由外层统一控制
- 先校验再调用：不要用异常来控制正常的业务分支

→ 详见 [事务管理](/spring/4_transaction#_5、rollback-only-与-unexpectedrollbackexception)

### Q18：受检异常默认会回滚吗？Framework 6.2 的 `rollbackOn` 改变了什么？

**一句话**：不会。默认只有 `RuntimeException` 和 `Error` 回滚，受检异常（如 `IOException`）会照常提交。

- 逐个方法修正：`@Transactional(rollbackFor = Exception.class)`
- 全局修正（Framework 6.2+）：`@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)`，所有异常都回滚，官方文档也推荐
- 某个业务异常不想回滚：用 `noRollbackFor` 排除
- catch 住异常不再抛、但又要回滚：`TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()`

→ 详见 [事务管理](/spring/4_transaction#_1、回滚规则)

### Q19：`@Transactional` 失效的常见场景有哪些？

**一句话**：分两类：一类是根本没经过代理，一类是经过了代理但异常、线程、连接等条件不对。

- 没经过代理：同类内部调用（见 Q14）；`private` / `final` / `static` 方法；对象是自己 `new` 的不是 Bean；在 `@PostConstruct` 里调用
- 异常问题：异常被 catch 吞掉，拦截器看不到；抛的是受检异常，默认不回滚（见 Q18）
- 传播行为：内层失败外层 catch（见 Q17）；选了 `SUPPORTS` / `NOT_SUPPORTED` / `NEVER` 可能不开事务
- 线程和连接：在其他线程里操作数据库；自己调 `dataSource.getConnection()` 拿了另一个连接
- 其他：多数据源时用错了事务管理器（默认用 `@Primary` 的）；MySQL 表用的是不支持事务的 MyISAM

**常见坑**：Framework 6.0 起，在 CGLIB 代理（Boot 默认）下 `protected` 和包可见方法上的事务也会生效，不再只限 public。

→ 详见 [事务管理](/spring/4_transaction#六、事务失效的常见场景)

### Q20：声明式事务和编程式事务的区别？什么时候用 `TransactionTemplate`？

**一句话**：声明式（`@Transactional`）以整个方法为事务范围，写法简单；编程式（`TransactionTemplate`）可以只把某一段代码放进事务，也不受代理限制。

- 方法里只有一段要事务、前后还有远程调用或文件处理时，用编程式把事务缩小，避免长事务占着连接
- 在回调里调 `status.setRollbackOnly()`，不抛异常也能回滚
- 发 MQ、短信这类撤不回的动作，放到事务提交之后（`@TransactionalEventListener`）

```java
txTemplate.execute(status -> { recordRepo.save(record); return accountRepo.deduct(id, amount); });
```

**常见坑**：要定制隔离级别时自己 `new TransactionTemplate(txManager)`，不要用 `@Bean` 覆盖 Boot 提供的全局实例。

→ 详见 [事务管理](/spring/4_transaction#五、编程式事务)

## 五、Spring MVC

### Q21：Spring MVC 的请求处理流程（DispatcherServlet 工作原理）？

**一句话**：请求先经过 Filter，再交给 `DispatcherServlet` 统一分发：找到处理方法 → 拦截器 `preHandle` → 解析参数并调用 Controller → 写出返回值 → `postHandle` → `afterCompletion`。

- `HandlerMapping` 根据 URL 找到对应的 Controller 方法，找不到就 404
- 拦截器的 `preHandle` 依次执行，任何一个返回 `false` 就中断
- `HandlerAdapter` 负责绑定参数、做校验，再调用 Controller 方法
- `@ResponseBody` 的返回值由消息转换器直接转成 JSON 写进响应
- 中间出的异常交给异常解析器处理，`@ExceptionHandler` 就在这里生效；`afterCompletion` 无论成败都会执行，适合清理 `ThreadLocal`

**常见坑**：在 `postHandle` 里改响应头没用，`@ResponseBody` 的响应体这时已经写出去了，要用 `ResponseBodyAdvice`。

→ 详见 [MVC](/spring/3_mvc#一、dispatcherservlet-请求处理流程)

### Q22：`@Controller` 和 `@RestController` 的区别？

**一句话**：`@RestController` = `@Controller` + `@ResponseBody`。`@Controller` 的方法返回值默认当作页面名去渲染页面；`@RestController` 的所有方法返回值都直接转成 JSON 写进响应体。

- 用 `@Controller` 又想返回 JSON，就在方法上单独加 `@ResponseBody`
- 前后端分离的 REST 接口统一用 `@RestController`

→ 详见 [MVC](/spring/3_mvc)

### Q23：过滤器（Filter）和拦截器（Interceptor）的区别？

**一句话**：Filter 是 Servlet 规范的东西，在 `DispatcherServlet` 之前执行；拦截器是 Spring MVC 的东西，在 Controller 方法前后执行，能拿到要调用的是哪个方法、方法上有什么注解。

| 对比 | Filter | 拦截器 |
|------|--------|--------|
| 拦截范围 | 所有请求，包括静态资源 | 只拦截映射到 Controller 的请求 |
| 能拿到 | 原始请求和响应 | Controller 方法及其注解 |
| 抛出的异常 | 进不了 `@RestControllerAdvice` | 能被统一异常处理 |
| 典型用途 | 编码、跨域、认证、traceId | 登录态、用户上下文、按注解做权限 |

- 执行顺序：Filter → `DispatcherServlet` → `preHandle` → Controller → `postHandle` → `afterCompletion` → Filter 返回

**常见坑**：Filter 既加了 `@Component` 又用 `FilterRegistrationBean` 注册，会执行两次，二选一。

→ 详见 [MVC](/spring/3_mvc#_3、filter-与-handlerinterceptor)、[Web 开发](/spring-boot/2_web_dev#五、filter-与拦截器的注册)

### Q24：Servlet 的生命周期是怎样的？Servlet 是线程安全的吗？

**一句话**：每个 Servlet 只有一个实例：创建后调一次 `init`，每个请求调一次 `service`，卸载时调一次 `destroy`。同一个实例被多个线程同时调用，所以它不是线程安全的。

- 默认第一次请求时才创建；配置 `load-on-startup` ≥ 0 时随容器启动创建
- `service` 再按请求方法分给 `doGet`、`doPost`
- 请求相关的数据只能放局部变量或 request 里，不能放实例字段
- Spring MVC 只有一个 `DispatcherServlet`；Controller、Filter 也是单实例多线程，同样不能在字段里存请求状态

**常见坑**：Boot 默认第一个请求才初始化 `DispatcherServlet`，首个请求偏慢，可设 `spring.mvc.servlet.load-on-startup=1`。

→ 详见 [MVC](/spring/3_mvc)

### Q25：Framework 6.1 起 MVC 参数校验有什么变化？`MethodArgumentNotValidException` 与 `HandlerMethodValidationException` 分别在什么时候抛出？

**一句话**：6.1（Boot 3.2）起 Spring MVC 自己就能校验方法参数，在 `@PathVariable`、`@RequestParam` 上直接写 `@Positive` 这类约束即可，Controller 类上不用再加 `@Validated`。

| 情况 | 校验失败抛出 |
|------|-------------|
| 只有 `@RequestBody` 对象加了 `@Valid` | `MethodArgumentNotValidException` |
| 参数上直接写了约束注解 | `HandlerMethodValidationException` |
| Controller 类上还加着 `@Validated`（旧写法） | `ConstraintViolationException` |

- 前两种异常都要在统一异常处理里处理
- 6.1 起去掉 Controller 上的 `@Validated`，`@Validated` 留给 Service 层和分组校验

**常见坑**：保留旧的 `@Validated`，抛出的 `ConstraintViolationException` 没被处理，前端拿到 500 而不是 400。

→ 详见 [MVC](/spring/3_mvc#三、参数校验)、[Web 开发](/spring-boot/2_web_dev#_2、两条校验路径)

### Q26：什么是 ProblemDetail？如何基于 `ResponseEntityExceptionHandler` 做统一异常处理？

**一句话**：ProblemDetail 是一种标准的错误响应格式（RFC 9457），字段有 `type`、`title`、`status`、`detail`、`instance`，Framework 6.0 起支持。统一异常处理就写一个继承 `ResponseEntityExceptionHandler` 的 `@RestControllerAdvice`。

- 父类已经把 Spring MVC 自带的异常（400、405、415 等）转成 ProblemDetail，子类只需补业务异常和兜底异常
- 业务异常可以继承 `ErrorResponseException`，自带状态码，不用再写 `@ExceptionHandler`
- Boot 开启 `spring.mvc.problemdetails.enabled=true` 会自动注册一个默认的处理器
- 项目要统一 `{code, message, data}` 格式也可以，但至少让校验失败、未登录、服务器错误返回正确的 HTTP 状态码

**常见坑**：Filter 里的异常和 Spring Security 的 401 / 403 不经过这套处理，要单独处理。

→ 详见 [MVC](/spring/3_mvc#五、统一异常处理)

### Q27：Jackson 3 / Boot 4 下如何定制 JSON 序列化？

**一句话**：Boot 4 默认用 Jackson 3（包名从 `com.fasterxml.jackson` 改成 `tools.jackson`，但注解包没变）。定制顺序：先用 `spring.jackson.*` 配置，不够再写 `JsonMapperBuilderCustomizer`。

| 场景 | Boot 4（Jackson 3） | Boot 3（Jackson 2） |
|------|--------------------|----------------------|
| 定制 Mapper | `JsonMapperBuilderCustomizer` | `Jackson2ObjectMapperBuilderCustomizer` |
| 自定义序列化器 | `@JacksonComponent` | `@JsonComponent` |
| 完全替换 | 声明 `JsonMapper` Bean | 声明 `ObjectMapper` Bean |

- Jackson 3 内置 Java 时间类型支持，默认不再把日期写成时间戳
- 部分默认值和 Jackson 2 不同，升级过渡期可设 `spring.jackson.use-jackson2-defaults=true`

**常见坑**：自己 `new` 一个 Mapper 塞进消息转换器，会绕过 Boot 的配置和自动注册的模块。

→ 详见 [MVC](/spring/3_mvc#_2、jackson-3-与-boot-4)、[Web 开发](/spring-boot/2_web_dev#_2、jackson-3)

## 六、常用组件

### Q28：`@Cacheable` 缓存 null 是防穿透还是导致穿透？`disableCachingNullValues` 有什么副作用？

**一句话**：缓存 null 是防穿透的手段：查不到的 key 也存一个空值进缓存，下次直接命中，不再打到数据库。关掉 null 缓存后，查不存在的 id 每次都会查库。

- 缓存 null 时 TTL 要短，否则新增的数据很久查不到
- 用 JSON 序列化缓存 null，要开启 `enableSpringCacheNullValueSupport()`
- 海量随机 key 的攻击，用布隆过滤器挡在前面更省内存

**常见坑**：开了 `disableCachingNullValues()` 后，方法返回 null 会直接抛 `IllegalArgumentException`，必须加 `unless = "#result == null"`。

→ 详见 [Cache 抽象](/spring/5_cache#_3、空值策略与缓存穿透)、[缓存一致性](/cache/10_cache_consistency)

### Q29：Spring Data Redis 4 / Jackson 3 下 Redis 缓存序列化要注意什么？

**一句话**：Boot 4 对应 Spring Data Redis 4，旧的 `GenericJackson2JsonRedisSerializer` 要换成 `GenericJacksonJsonRedisSerializer`，而新的默认不再写入类型信息。

- 不写类型信息：读回来是 `LinkedHashMap`，强转成业务类会报 `ClassCastException`；需要时用 `enableDefaultTyping(validator)` 并限定允许的包
- 只存一种类型时，用 `JacksonJsonRedisSerializer<T>` 建一个专用模板更简单
- 老数据兼容：新旧 JSON 格式可能不同，升级时清缓存、换 key 前缀，或过渡期继续用旧序列化器
- Boot 默认的 `RedisTemplate<Object, Object>` 用的是 JDK 序列化，存进去的值人看不懂，还要求实现 `Serializable`

**常见坑**：用 `enableUnsafeDefaultTyping()` 允许反序列化任意类型，Redis 数据被篡改就可能远程执行代码。

→ 详见 [Cache 抽象](/spring/5_cache#_2、redis-cachemanager-spring-data-redis-4-jackson-3)、[中间件集成](/spring-boot/5_middleware#_2、序列化-jackson-3)

### Q30：`@Cacheable(sync = true)` 能解决集群下的缓存击穿吗？

**一句话**：只能解决单个 JVM 内的击穿。`sync = true` 让同一个 key 只有一个线程去查数据库，其他线程等结果；但锁只在本进程内，N 个实例还是会各查一次库。

- 跨实例只查一次，要用分布式锁或逻辑过期
- 限制：不能和 `unless` 一起用，同一方法上只能有这一个缓存注解
- 配套：TTL 加随机值，防止大量 key 同时过期（雪崩）

→ 详见 [Cache 抽象](/spring/5_cache#_2、热点-key-击穿-sync-true)、[缓存一致性](/cache/10_cache_consistency)

### Q31：`@Retryable` 与 `@Transactional` 一起用时，重试应该在事务内还是事务外？

**一句话**：重试要包在事务外面，每次重试都开一个新事务。在同一个事务里重试，第一次失败可能已经把事务标记为只能回滚，后面成功了也提交不了。

- 乐观锁冲突、死锁这类要重新读数据的情况，在同一事务里重试也读不到新数据
- 推荐放在两个 Bean：外层方法加 `@Retryable`，调用内层 Bean 的 `@Transactional` 方法
- 同一方法上同时加两个注解，谁在外层取决于 order 配置，不直观
- 只对幂等操作和临时性错误重试，而且只在一层重试（三层各重试 3 次就是 27 倍请求）

→ 详见 [Retry 重试](/spring/6_retry#_2、重试要包住事务-而不是在事务里重试)

### Q32：`@TransactionalEventListener` 有哪些阶段？AFTER_COMMIT 里写库为什么不生效？

**一句话**：四个阶段：`BEFORE_COMMIT`（提交前，还在原事务里）、`AFTER_COMMIT`（默认，提交后）、`AFTER_ROLLBACK`、`AFTER_COMPLETION`。AFTER_COMMIT 时原事务已经提交，但连接还绑在当前线程上，监听器里写库会加入这个已结束的事务，不会再提交，数据静默丢失。

- 正确写法：监听器上加 `@Transactional(propagation = REQUIRES_NEW)`，单独开新事务
- AFTER_COMMIT 适合发 MQ、发通知、删缓存
- 没有事务时发布事件，监听器默认不执行，需要时设 `fallbackExecution = true`
- 监听器抛异常只打日志，不影响原事务

→ 详见 [事件机制](/spring/7_event#六、事务事件-transactionaleventlistener)

### Q33：Spring 进程内事件可靠吗？怎么保证不丢？

**一句话**：不可靠，最多投递一次：事务提交后、监听器跑完前进程挂了，或者监听器执行失败，事件就丢了，没有重试也没有记录。不能丢的事件要先存到数据库。

- 事务性 Outbox：在业务事务里写一张消息表，提交后再由定时任务或 CDC（监听数据库变更日志）投递到 MQ，跨服务通用
- Spring Modulith 事件发布注册表：自动在原事务里记录事件，监听成功才标记完成，重启后可以重投，适合单体内部
- 用 RocketMQ 的话可以用事务消息
- 会重投就必须保证监听器幂等

→ 详见 [事件机制](/spring/7_event#_3、可靠性边界-至多一次)、[分布式事务](/distributed/4_transaction)

## 七、WebFlux 与响应式

### Q34：WebFlux 和 Spring MVC 有什么区别？有了虚拟线程还需要 WebFlux 吗？

**一句话**：MVC 是一个请求占一个线程的阻塞模型；WebFlux 用很少的线程（约等于 CPU 核数）处理大量请求，前提是整条链路都不能阻塞。有了虚拟线程，普通业务用 MVC 就能扛高并发，WebFlux 的必要性小了很多。

| 对比 | Spring MVC | Spring WebFlux |
|------|-----------|----------------|
| 线程模型 | 一请求一线程（可换虚拟线程） | 少量事件循环线程 |
| 数据访问 | JDBC / JPA | R2DBC、响应式 Redis 等 |
| 调试难度 | 低 | 高，调用栈不连续 |
| 适合 | 常规业务系统 | 网关、流式推送、大量异步调用聚合 |

- 普通 CRUD 优先 MVC + 虚拟线程（`spring.threads.virtual.enabled=true`）
- WebFlux 仍有优势的地方：背压、流式处理、取消传播、组合多个异步来源

**常见坑**：在 WebFlux 里调 JDBC 会卡住事件循环线程，吞吐反而不如 MVC。

→ 详见 [WebFlux](/spring/8_webflux#二、spring-mvc-vs-spring-webflux)

### Q35：Mono / Flux 是什么？为什么说「订阅之前什么都不会发生」？

**一句话**：`Mono` 表示 0 或 1 个元素的异步结果，`Flux` 表示 0 到 N 个。调用 `map`、`flatMap` 只是在搭流水线，要等有人订阅（`subscribe`）才真正执行。

- 和 `CompletableFuture` 的区别：`CompletableFuture` 创建就开始执行；`Mono` 订阅才执行，订阅几次执行几次
- `Mono` / `Flux` 支持背压和取消，`CompletableFuture` 不支持
- `Mono.just(remoteCall())` 在搭流水线时就调用了，耗时操作要用 `fromCallable` 或 `defer`
- 同一个 `Mono` 订阅两次会发两次请求，要复用结果用 `cache()`

**常见坑**：调用 `repository.save(entity)` 却没把返回的 `Mono` 接到链路上，没人订阅，数据根本没写进去；`doOnNext(x -> repo.save(x))` 同理，应改成 `flatMap(repo::save)`。

→ 详见 [WebFlux](/spring/8_webflux#七、reactor-执行模型)

### Q36：为什么不能在事件循环线程上阻塞？`publishOn` 与 `subscribeOn` 有什么区别？阻塞调用如何包装？

**一句话**：一个事件循环线程要服务成百上千个连接，在它上面阻塞，这些连接就全停了。阻塞调用要用 `fromCallable` 包起来，并用 `subscribeOn(Schedulers.boundedElastic())` 换到专门的线程池上执行。

- `publishOn`：只影响写在它后面的操作，可以多次切换线程
- `subscribeOn`：影响数据源头在哪个线程执行，写在哪里都一样，多个时只有最靠近源头的生效
- `Schedulers.parallel()` 给 CPU 计算用，绝对不能阻塞；`boundedElastic()` 专门放阻塞调用

```java
Mono.fromCallable(() -> legacyClient.fetch(id)).subscribeOn(Schedulers.boundedElastic());
```

**常见坑**：在链路里调 `block()`，在 Netty 线程上会直接抛 `IllegalStateException`；测试时可以用 BlockHound 检测阻塞调用。

→ 详见 [WebFlux](/spring/8_webflux#八、线程模型与调度器)

### Q37：什么是背压？HTTP 链路上背压能跨网络传递吗？

**一句话**：背压就是下游告诉上游「我还能处理 n 个」（`request(n)`），上游最多只发 n 个，防止下游被压垮。在一个进程内是完整生效的；跨了 HTTP 就没有这种按条请求的机制了，只能靠 TCP 流量控制间接减速。

- RSocket 协议本身支持背压，可以跨网络传递
- `publishOn`、`flatMap` 默认一次向上游要 256 个；`limitRate` 可以限制一次拉取的数量
- 无法减速的源头（定时器、WebSocket 消息）必须选一种策略：缓冲（满了报错）、丢弃新的、只保留最新的、直接报错

→ 详见 [WebFlux](/spring/8_webflux#九、背压-backpressure)

### Q38：响应式链路中 ThreadLocal / MDC 为什么会失效？如何传递上下文？

**一句话**：一个请求会在多个线程之间跳来跳去，一个线程又轮流处理多个请求，所以 `ThreadLocal` 里的值后面可能读不到，甚至读到别的请求的值。要改用绑定在订阅上的 Reactor `Context`。

- `Context` 用 `contextWrite` 写入，只对写在它上游的操作可见；用 `deferContextual` 读取
- 自动传播：Boot 3.2+ 设 `spring.reactor.context-propagation=auto`，每一步执行时自动把值还原到 `ThreadLocal`，traceId 就能进 MDC
- 自定义的 MDC 字段（如租户 ID）要注册 `ThreadLocalAccessor`，并在 `WebFilter` 里写入 `Context`
- 响应式事务也靠 `Context` 传连接，链路外另起的 `subscribe()` 不在事务里

→ 详见 [WebFlux](/spring/8_webflux#十、context-与上下文传播)

## 八、Spring Security

### Q39：Spring Security 的过滤器链是如何工作的？授权由哪个组件完成？

**一句话**：Spring Security 本质是一串 Filter。Servlet 容器只认识一个 `DelegatingFilterProxy`，它转给 Spring 里的 `FilterChainProxy`，再选出第一条匹配当前请求的 `SecurityFilterChain` 依次执行。授权由链尾的 `AuthorizationFilter` 交给 `AuthorizationManager` 判断。

- 链上的关键过滤器：加载登录状态 → 校验 CSRF → 认证（解析 Token 或表单登录）→ 异常转换 → 授权
- 异常转换：没登录返回 401，没权限返回 403
- 多条链用 `securityMatcher` 限定 URL 范围，用 `@Order` 决定先匹配哪条
- 当前用户默认存在 `ThreadLocal` 里，在 `@Async` 或线程池里要用 `DelegatingSecurityContextAsyncTaskExecutor` 这类包装执行器传过去

**常见坑**：排查时打开 `logging.level.org.springframework.security=TRACE`，能看到每条链有哪些过滤器。

→ 详见 [Spring Security](/spring/9_security#一、核心架构)

### Q40：Security 6 / 7 的配置方式有哪些变化？

**一句话**：从「继承适配器类」改成「声明一个 `SecurityFilterChain` Bean + Lambda 写法」，授权改用 `AuthorizationManager`。

| 旧写法（5.x） | 新写法（6.x / 7.x） |
|--------------|-------------------|
| 继承 `WebSecurityConfigurerAdapter`（6.0 删除） | 声明 `SecurityFilterChain` Bean |
| `authorizeRequests()` | `authorizeHttpRequests()` |
| `antMatchers` / `mvcMatchers` | `requestMatchers` |
| `@EnableGlobalMethodSecurity` | `@EnableMethodSecurity` |

- `requestMatchers` 按声明顺序匹配，先写具体的再写宽泛的，`anyRequest()` 放最后
- `hasRole("ADMIN")` 实际检查的是 `ROLE_ADMIN`；`hasAuthority("order:delete")` 原样比较
- Security 7 把授权服务器（Authorization Server）并进主项目，Boot 4 的 OAuth2 starter 改名为 `spring-boot-starter-security-oauth2-*`

→ 详见 [Spring Security](/spring/9_security#二、securityfilterchain-配置)、[Spring Boot 版本演进](/spring-boot/11_versions)

### Q41：JWT 认证用 OAuth2 Resource Server 和自定义过滤器有什么区别？自定义过滤器有哪些坑？

**一句话**：Resource Server 是 Spring Security 自带的 JWT 校验功能：取 Token、验签名、查过期时间、把 Token 里的信息转成权限，都不用自己写，优先用它。对接授权服务器时只需配置 `issuer-uri`。

自己写 JWT 过滤器的常见问题：

- 过滤器加了 `@Component`：Boot 会再把它注册成普通 Filter，一个请求执行两次；应该直接 `new` 出来加到安全链里
- 每个请求都查一次数据库加载用户：权限应直接从 Token 里取，这才是无状态
- 重复解析、自己判断过期：解析一次就够，解析时库已经校验过期了

**常见坑**：JWT 无状态，改了权限要等 Token 过期才生效，所以访问 Token 有效期要短，配合刷新 Token 使用。

→ 详见 [Spring Security](/spring/9_security#四、jwt-认证-oauth2-resource-server-推荐)、[JWT 令牌机制](/security/1_jwt)

### Q42：如何实现方法级权限和数据库驱动的动态 URL 权限？

**一句话**：方法级用 `@EnableMethodSecurity` + `@PreAuthorize`；动态 URL 权限就实现一个 `AuthorizationManager`，按内存里的规则判断，再用 `.anyRequest().access(manager)` 挂上去。

- `@PreAuthorize` 基于代理，类内部调用不生效
- `@PostAuthorize` 在方法执行后才判断，只适合只读方法
- 动态规则缓存在内存里，不要每个请求查库；规则变了再刷新缓存
- 没配置规则的 URL 默认拒绝更安全

**常见坑**：用户权限来自 Token，调整角色后要等 Token 刷新；要立即生效就在 `AuthorizationManager` 里按用户 ID 查缓存中的最新权限。

→ 详见 [Spring Security](/spring/9_security#七、动态权限-authorizationmanager)、[权限系统架构设计](/architecture/6_access_control)

### Q43：Spring Security、Sa-Token、Shiro 如何选型？Sa-Token 的注解为什么不生效？

**一句话**：Spring Security 功能最全、和 Spring 生态结合最深；Sa-Token 上手最快，踢人下线、封禁、多端登录这些会话功能开箱即用；Shiro 适合非 Spring 项目或老项目。

| 场景 | 推荐 |
|------|------|
| 标准企业项目，需要 OAuth2 / OIDC | Spring Security |
| 中小项目，追求开发速度 | Sa-Token（集群部署接 Redis） |
| 非 Spring 项目或老 Shiro 项目 | Shiro 3.x |

- 一个应用只用一个安全框架，两套框架会互相干扰

**常见坑**：Sa-Token 的注解靠 `SaInterceptor` 解析，没注册这个拦截器，`@SaCheckLogin` 等注解全都不生效。

→ 详见 [安全框架对比](/spring/10_auth_framework#五、选型建议)

### Q44：Keycloak 接入 OIDC 时如何实现单点登出？登录应用里为什么拿不到角色？

**一句话**：单点登出两个方向都要配：应用通知 Keycloak 用 `OidcClientInitiatedLogoutSuccessHandler`；Keycloak 通知应用用 Back-Channel 登出（服务器直接调应用接口）。拿不到角色是因为 Keycloak 默认只把角色放在 access_token 里，ID Token 和用户信息接口里都没有。

- 角色解法一：在 Keycloak 里打开「Add to ID token」，应用里用 `GrantedAuthoritiesMapper` 转成权限
- 角色解法二：让后端资源服务器从 access_token 里读（微服务更常见）
- Back-Channel 登出要求 Keycloak 能直接访问到应用的地址
- 多实例部署要共享会话登记，否则登出通知打到 A 实例，B 实例的会话还在

→ 详见 [Spring SSO 接入](/spring/11_single_sign_on#六、keycloak-实战)、[OIDC](/security/3_oidc)

### Q45：如何用 Spring Authorization Server 搭建授权服务器？Security 7 中有什么变化？

**一句话**：Security 7 起授权服务器并入 Spring Security 主项目，版本跟着 Security 走，Boot 4 用 `spring-boot-starter-security-oauth2-authorization-server`。搭建时要配两条过滤器链。

- 两条链：第一条只处理协议接口（`/oauth2/authorize`、`/oauth2/token` 等），第二条处理用户登录页面
- 持久化：客户端信息、授权记录用 JDBC 存，建表脚本放进 Flyway
- 客户端：前端用授权码 + PKCE，服务之间用 client_credentials
- 生产：issuer 地址固定且和对外域名一致；签名密钥放密钥库并定期轮换；定期清理过期授权记录
- 需要现成的用户管理、社交登录、管理后台，直接用 Keycloak 更省事

→ 详见 [Spring SSO 接入](/spring/11_single_sign_on#七、spring-authorization-server-实战)、[OAuth2](/security/2_oauth2)

## 九、批处理与集成

### Q46：Spring Batch 中 JobInstance 与 JobExecution 有什么区别？失败的作业如何从断点续跑？

**一句话**：作业名 + 关键参数确定一个 JobInstance，代表一次逻辑上的运行（如「6 月 1 日的对账」）；每次启动是一个 JobExecution，一个实例可以执行多次。已成功的实例不能再跑，失败的可以重启。

- 断点续跑：每处理完一批（chunk）提交一次事务，同时记下读到了哪里；重启时跳过已完成的步骤，从记录的位置继续
- 前提：Reader 要能保存位置（实现 `ItemStream` 并设置 `name`）；最后一批没提交的会重做，所以 Writer 要幂等
- 进程被强杀后记录会停在 STARTED，Batch 6 用 `JobOperator#recover` 修复

**常见坑**：用时间戳当参数来「保证唯一」，每次都是新实例，失败后只能从头跑，还失去了「同一天只跑一次」的保护；要新实例用 `RunIdIncrementer`。

→ 详见 [Spring Batch 批处理](/spring/12_batch#六、重启语义)

### Q47：在 Boot 项目里加 `@EnableBatchProcessing` 会发生什么？

**一句话**：Boot 的批处理自动配置会整个退出，`spring.batch.*` 配置全部失效，元数据表也不会自动创建；Batch 6 下还会得到一个什么都不存的作业仓库，重启和防重复执行全部失效，而且不报任何错。

- Boot 项目不要加这个注解，直接用自动配置
- 生产要持久化元数据，引入 `spring-boot-starter-batch-jdbc`（Boot 4 的 `spring-boot-starter-batch` 本身不存数据）
- 元数据放在单独的数据源，用 `@BatchDataSource` 标注即可，不用关掉自动配置

→ 详见 [Spring Batch 批处理](/spring/12_batch#_2、陷阱-不要加-enablebatchprocessing)

### Q48：Chunk 步骤中 filter 与 skip 有什么区别？

**一句话**：filter 是业务上「这条不要」：Processor 返回 null，这条不会写出，计入 `filterCount`；skip 是「这条出错了但可以容忍」：抛出配置为可跳过的异常，计入 `skipCount`，超过上限作业失败。

- 两个计数分开统计，对账时不要混在一起
- 被跳过的记录用 `SkipListener` 记下来，方便事后补录
- 写的时候出现可跳过异常，框架会回滚这一批再逐条重试找出坏记录，所以 Writer 要能承受重复执行

→ 详见 [Spring Batch 批处理](/spring/12_batch#_3、itemprocessor-校验与清洗)

### Q49：Spring Batch 有哪些扩展方式（多线程 Step、分区、远程分块）？

**一句话**：按成本从低到高：多线程 Step → 并行执行互不依赖的 Step → 分区（按 ID 范围切成多份并行处理）→ 远程分块 / 远程分区（通过消息把工作分给其他进程）。

- 多线程 Step 下多个线程共用读取位置，重启不够可靠；需要可靠重启时优先用分区
- 分页读取（`JdbcPagingItemReader`）线程安全，能用于多线程和分区，排序字段必须唯一
- 游标读取（`JdbcCursorItemReader`）单线程最快，但不是线程安全的，而且长时间占着连接
- IO 密集的任务可以用虚拟线程执行

→ 详见 [Spring Batch 批处理](/spring/12_batch#七、扩展与性能)

### Q50：Spring Integration 与 Spring Cloud Stream、Apache Camel 是什么关系？如何选择？

**一句话**：Spring Integration 是企业集成模式的 Spring 实现，用来搭建对接文件、数据库、HTTP、FTP、MQ 的集成管道；Spring Cloud Stream 是建在它之上的，专门做服务之间的消息收发；Apache Camel 是同类的独立框架，支持的组件最多。

| 选择 | 场景 |
|------|------|
| Spring Integration | 全是 Spring 技术栈，集成流不多 |
| Apache Camel | 要对接大量不同系统（SaaS、FTP、EDI） |
| Spring Cloud Stream | 服务间发布 / 订阅事件，想保留换 MQ 的自由 |
| 原生 Spring Kafka / AMQP | 只是消费一个主题 |

→ 详见 [Spring Integration](/spring/13_integration#六、apache-camel-对比)

## 十、版本演进

### Q51：Spring Framework 5 → 6 → 7 有哪些关键变化？

**一句话**：6.0 是破坏性升级（要求 JDK 17，`javax` 包名改成 `jakarta`）；7.0 主要是整理（Jakarta EE 11、默认 Jackson 3、空安全注解），新功能集中在 HTTP 客户端、API 版本控制和内置重试。

| 版本 | 对应 Boot | 关键变化 |
|------|----------|---------|
| 5.3 | 2.x | JDK 8+，最后一个 `javax` 版本 |
| 6.0 | 3.0 | JDK 17+、`jakarta.*`、原生镜像支持、ProblemDetail |
| 6.1 | 3.2 | 虚拟线程、`RestClient`、`JdbcClient`、MVC 内置参数校验 |
| 7.0 | 4.0 | Jakarta EE 11、Jackson 3、API 版本控制、内置 `@Retryable` |

- 7.1 起 `RestTemplate` 标记为废弃，计划 8.0 删除

→ 详见 [Spring 总览](/spring/0_overview#_2、版本演进)、[Spring Boot 版本演进](/spring-boot/11_versions)

### Q52：`RestTemplate`、`RestClient`、`WebClient`、HTTP Service Clients 怎么选？

**一句话**：同步调用用 `RestClient`；调用的接口多、想写成 Java 接口的用 HTTP Service Clients（`@HttpExchange`）；响应式项目用 `WebClient`；`RestTemplate` 只维护老代码。

| 客户端 | 风格 | 现状 |
|--------|------|------|
| `RestTemplate` | 模板方法 | 7.1 废弃，计划 8.0 删除 |
| `RestClient` | 同步、链式调用 | 同步场景首选 |
| `WebClient` | 响应式 | 继续维护 |
| HTTP Service Clients | 声明式接口 | 推荐用于微服务内部调用，替代 OpenFeign |

- 用 Boot 提供的 `RestClient.Builder` 来构造，能自动带上通用配置

**常见坑**：不设超时，默认可能无限等待，所有客户端都要设超时。

→ 详见 [Web 开发](/spring-boot/2_web_dev#七、http-客户端)、[服务通信](/spring-cloud/3_communication)

### Q53：Framework 7 内置的 `@Retryable` 与 Spring Retry 有什么区别？`@ConcurrencyLimit` 为什么和虚拟线程有关？

**一句话**：Framework 7 把重试功能直接放进了 Spring 核心，用 `@EnableResilientMethods` 开启，不再需要 Spring Retry（已停止维护）。`@ConcurrencyLimit` 限制同时进入方法的线程数，主要用来给虚拟线程加上并发上限。

| 对比 | Spring Retry | Framework 7 |
|------|-------------|-------------|
| 次数参数 | `maxAttempts`，包含第一次 | `maxRetries`，不含第一次 |
| 失败兜底 | `@Recover` | 没有，调用方自己 catch |
| 响应式 | 不支持 | 支持 `Mono` / `Flux` |

- 迁移换算：`maxAttempts = 3` 对应 `maxRetries = 2`
- 为什么和虚拟线程有关：虚拟线程不用线程池，没了「线程池大小」这道闸门，大量并发会压垮数据库连接池或下游
- `@ConcurrencyLimit` 只限单个实例，不是集群限流

→ 详见 [Retry 重试](/spring/6_retry#三、并发限制-concurrencylimit)、[Spring Boot 版本演进](/spring-boot/11_versions#_7、内置弹性注解-retryable-concurrencylimit)

---
description: IoC、Bean 生命周期、循环依赖、AOP、事务、MVC、自动配置
---

# 开发总结 - Spring

> 精华提炼，细节详见 [Spring](/spring/0_overview) / [Spring Boot](/spring-boot/1_spring_boot)

## 一、IoC 和 DI 的区别？Spring IoC 容器的作用是什么？

- **IoC（控制反转）**是一种设计思想：对象的创建和依赖关系的维护不再由业务代码 `new` 出来，而是交给容器管理。
- **DI（依赖注入）**是 IoC 的实现手段：容器在创建 Bean 时，把它依赖的对象注入进去。
- 一句话：**IoC 是目标，DI 是手段**。

**IoC 容器的作用**：

| 职责 | 说明 |
|------|------|
| 创建与装配 | 读取配置（注解 / XML / JavaConfig）生成 `BeanDefinition`，实例化并注入依赖 |
| 生命周期管理 | 初始化回调、销毁回调、作用域控制 |
| 解耦 | 面向接口编程，替换实现无需改调用方 |
| 扩展基础 | AOP、事务、事件等能力都建立在容器的扩展点（`BeanPostProcessor`）之上 |

详见：<RouteLink to="/spring/1_ioc">IoC 容器</RouteLink>

## 二、Bean 的注入方式有哪些？各有什么优缺点？

| 方式 | 优点 | 缺点 | 建议 |
|------|------|------|------|
| **构造器注入** | 依赖不可变（`final`）、不会为 null、便于单测、依赖过多一眼可见 | 参数多时构造器臃肿；无法解决构造器循环依赖 | ✅ 官方推荐，强制依赖首选 |
| Setter 注入 | 可选依赖、可重新注入 | 对象可能处于"半初始化"状态 | 可选依赖使用 |
| 字段注入（`@Autowired` 字段）| 写法最简洁 | 无法 `final`、脱离容器难测试、隐藏依赖数量 | ❌ 不推荐 |

```java
@Service
@RequiredArgsConstructor           // Lombok 生成构造器，单构造器可省略 @Autowired
public class OrderService {
    private final UserService userService;
}
```

详见：<RouteLink to="/spring/1_ioc">IoC 与 DI</RouteLink>

## 三、`@Autowired` 和 `@Resource` 的区别？

| 对比项 | `@Autowired` | `@Resource` |
|--------|-------------|-------------|
| 来源 | Spring | JSR-250（`jakarta.annotation`）|
| 默认匹配 | **按类型（byType）** | **按名称（byName）**，找不到再按类型 |
| 多个候选 | 配合 `@Qualifier` / `@Primary` | 用 `name` 属性指定 |
| 必需性 | `required = false` 可选 | 不支持 `required` |
| 可用位置 | 字段、Setter、构造器、方法参数 | 字段、Setter（不支持构造器）|

## 四、Spring 如何解决循环依赖？三级缓存的原理是什么？

**三级缓存**（`DefaultSingletonBeanRegistry`）：

| 缓存 | 名称 | 存放内容 |
|------|------|---------|
| 一级 | `singletonObjects` | 完整初始化好的单例 |
| 二级 | `earlySingletonObjects` | 提前暴露的早期引用（可能已是代理）|
| 三级 | `singletonFactories` | `ObjectFactory`，调用时执行 `getEarlyBeanReference()` |

**A ↔ B 解决流程**：

1. 创建 A：实例化后，把 A 的 `ObjectFactory` 放入三级缓存
2. A 属性填充发现依赖 B → 去创建 B
3. B 属性填充依赖 A → 依次查一、二、三级缓存，从三级缓存拿到工厂，生成 A 的早期引用放入二级缓存
4. B 完成初始化进入一级缓存 → A 拿到 B 完成初始化 → A 进入一级缓存

**为什么要三级而不是两级**：如果 A 需要 AOP 代理，正常流程是在初始化后（`BeanPostProcessor` after）才创建代理。三级缓存用工厂**延迟决定**是否提前生成代理——只有真的发生循环依赖时才提前代理，保证注入给 B 的是代理对象而不是原始对象。

**解决不了的情况**：

- 构造器注入的循环依赖（实例化前就要依赖，无法提前暴露）
- `prototype` 作用域的循环依赖
- `@Async` 等在后置处理阶段才替换对象的场景可能报 `BeanCurrentlyInCreationException`

::: warning 注意
Spring Boot 2.6+ 默认**禁止**循环依赖（`spring.main.allow-circular-references=false`）。出现循环依赖首先应重构设计（抽取公共服务、事件解耦），而不是开开关或加 `@Lazy`。
:::

详见：<RouteLink to="/spring/1_ioc">三级缓存解循环依赖</RouteLink>

## 五、AOP 的核心概念是什么？

| 概念 | 含义 | 类比 |
|------|------|------|
| 切面（Aspect）| 横切逻辑的模块化封装（`@Aspect` 类）| 日志模块 |
| 连接点（JoinPoint）| 可被拦截的点，Spring AOP 中**只有方法执行** | 每个方法 |
| 切点（Pointcut）| 匹配连接点的表达式 | `execution(* com.xx.service..*(..))` |
| 通知（Advice）| 在切点处执行的动作及时机 | `@Before` / `@Around` |
| 目标对象（Target）| 被代理的原始对象 | `OrderServiceImpl` |
| 织入（Weaving）| 把切面应用到目标生成代理的过程 | Spring 在运行期织入 |

详见：<RouteLink to="/spring/2_aop">AOP</RouteLink>

## 六、Spring AOP 的实现方式？JDK 动态代理和 CGLIB 的选择策略？

| 对比项 | JDK 动态代理 | CGLIB |
|--------|------------|-------|
| 原理 | 实现目标的**接口**，`InvocationHandler` 反射调用 | 运行时生成目标类的**子类**，重写方法 |
| 前提 | 目标必须实现接口 | 类和方法不能是 `final` / `private` |
| 性能 | JDK 8+ 后差距很小 | 生成类稍慢，调用快 |

**选择策略**：

- Spring Framework：目标实现了接口 → JDK 代理；否则 → CGLIB
- **Spring Boot 2.x 起默认 `spring.aop.proxy-target-class=true`，统一使用 CGLIB**（避免按实现类注入时报类型错误）

**代理创建时机**：`AbstractAutoProxyCreator`（一个 `BeanPostProcessor`）在 Bean 初始化后的 `postProcessAfterInitialization` 中判断是否匹配切点，匹配则返回代理对象替换原 Bean。

详见：<RouteLink to="/spring/2_aop">JDK 动态代理 vs CGLIB</RouteLink>

## 七、`@Transactional` 为什么在同一个类内部调用会失效？

**根因**：事务靠 AOP 代理实现，只有**经过代理对象**的调用才会被拦截。类内部 `this.methodB()` 调用的是原始对象，绕过了代理。

```java
public void methodA() {
    this.methodB();   // ❌ this 是原始对象，事务不生效
}

@Transactional
public void methodB() { ... }
```

**解决方式**：

1. 拆到另一个 Bean 中调用（推荐）
2. 注入自身：`@Lazy @Autowired private OrderService self;` 然后 `self.methodB()`
3. `AopContext.currentProxy()`（需 `@EnableAspectJAutoProxy(exposeProxy = true)`）
4. 使用编程式事务 `TransactionTemplate`

详见：<RouteLink to="/spring/2_aop">自调用失效问题</RouteLink>

## 八、AOP 的通知类型有哪些？执行顺序是什么？

| 通知 | 时机 |
|------|------|
| `@Before` | 目标方法执行前 |
| `@AfterReturning` | 正常返回后 |
| `@AfterThrowing` | 抛出异常后 |
| `@After` | 无论成功失败都执行（类似 finally）|
| `@Around` | 包裹目标方法，可控制是否执行、修改参数与返回值 |

**同一切面内执行顺序（Spring 5.2.7+）**：

- 正常：`@Around` 前半 → `@Before` → 目标方法 → `@AfterReturning` → `@After` → `@Around` 后半
- 异常：`@Around` 前半 → `@Before` → 目标方法 → `@AfterThrowing` → `@After`

**多个切面**：用 `@Order` 或实现 `Ordered` 控制，值越小越先进入、越后退出（洋葱模型）。

## 九、Spring Bean 的完整生命周期是什么？

1. **实例化**：根据 `BeanDefinition` 反射调用构造器（`createBeanInstance`）
2. **属性填充**：依赖注入（`populateBean`，`@Autowired` 由 `AutowiredAnnotationBeanPostProcessor` 处理）
3. **Aware 回调**：`BeanNameAware` → `BeanClassLoaderAware` → `BeanFactoryAware`（`ApplicationContextAware` 在下一步由后置处理器回调）
4. **`BeanPostProcessor#postProcessBeforeInitialization`**：`@PostConstruct` 在这一步执行
5. **初始化**：`InitializingBean#afterPropertiesSet` → 自定义 `init-method`
6. **`BeanPostProcessor#postProcessAfterInitialization`**：**AOP 代理在这里生成**
7. **使用**：放入一级缓存，供业务使用
8. **销毁**：`@PreDestroy` → `DisposableBean#destroy` → 自定义 `destroy-method`

::: tip 记忆口诀
实例化 → 填属性 → Aware → 前置处理 → 初始化 → 后置处理（代理）→ 使用 → 销毁
:::

详见：<RouteLink to="/spring/1_ioc">Bean 生命周期</RouteLink>

## 十、`@PostConstruct`、`InitializingBean`、`init-method` 的执行顺序？

**顺序**：`@PostConstruct` → `InitializingBean#afterPropertiesSet()` → `init-method`（`@Bean(initMethod = "...")`）

- `@PostConstruct` 由 `CommonAnnotationBeanPostProcessor` 在**前置处理**阶段调用，所以最早
- 销毁顺序对称：`@PreDestroy` → `DisposableBean#destroy()` → `destroy-method`

**选择建议**：优先 `@PostConstruct`（标准注解、与 Spring 解耦）；第三方类无法加注解时用 `init-method`。

## 十一、`BeanFactory` 和 `ApplicationContext` 的区别？

| 对比项 | `BeanFactory` | `ApplicationContext` |
|--------|--------------|---------------------|
| 定位 | 最底层的 IoC 容器接口 | `BeanFactory` 的子接口，面向应用的"高级容器" |
| 单例加载 | **懒加载**，首次 `getBean` 才创建 | 启动时**预实例化**所有非懒加载单例，问题尽早暴露 |
| 后置处理器 | 需手动注册 | 自动检测并注册 `BeanPostProcessor` / `BeanFactoryPostProcessor` |
| 额外能力 | 无 | 国际化 `MessageSource`、事件发布、资源加载、环境 `Environment` |

实际开发几乎只用 `ApplicationContext`；`BeanFactory` 更多是理解原理用。

## 十二、Bean 的作用域有哪些？`prototype` 和单例有什么区别？

| 作用域 | 说明 |
|--------|------|
| `singleton`（默认）| 容器内唯一实例 |
| `prototype` | 每次获取都新建 |
| `request` / `session` / `application` | Web 环境，分别绑定请求、会话、ServletContext |
| `websocket` | 绑定 WebSocket 会话 |

**singleton vs prototype**：

- 单例由容器管理完整生命周期；**prototype 容器只负责创建，不调用销毁回调**
- prototype 不支持循环依赖
- **单例注入 prototype 时只会注入一次**，想每次拿新对象需用 `ObjectProvider<T>` / `@Lookup` / `proxyMode = ScopedProxyMode.TARGET_CLASS`
- 单例 Bean 非线程安全，不要在其中保存可变的成员状态

详见：<RouteLink to="/spring/1_ioc">Bean 作用域</RouteLink>

## 十三、Spring 事务的传播行为有哪几种？`REQUIRED` 和 `REQUIRES_NEW` 的区别？

| 传播行为 | 当前有事务 | 当前无事务 |
|---------|----------|----------|
| **`REQUIRED`（默认）** | 加入 | 新建 |
| `SUPPORTS` | 加入 | 非事务执行 |
| `MANDATORY` | 加入 | 抛异常 |
| **`REQUIRES_NEW`** | 挂起当前，新建独立事务 | 新建 |
| `NOT_SUPPORTED` | 挂起当前，非事务执行 | 非事务执行 |
| `NEVER` | 抛异常 | 非事务执行 |
| **`NESTED`** | 嵌套事务（Savepoint）| 新建 |

**REQUIRED vs REQUIRES_NEW vs NESTED**：

| 场景 | REQUIRED | REQUIRES_NEW | NESTED |
|------|---------|-------------|--------|
| 内层异常，外层 catch | 整体回滚（`UnexpectedRollbackException`，事务已被标记 rollback-only）| 仅内层回滚，外层可提交 | 回滚到保存点，外层可提交 |
| 外层异常 | 一起回滚 | 内层**已提交不受影响** | 一起回滚 |
| 典型用途 | 常规业务 | 操作日志、审计记录（必须落库）| 可局部失败的子步骤 |

详见：<RouteLink to="/spring/4_transaction">事务传播行为</RouteLink>

## 十四、`@Transactional` 失效的常见场景有哪些？

| 场景 | 原因 |
|------|------|
| 类内部自调用 | 绕过代理 |
| 方法非 `public`（Spring 6 之前）/ `final` / `static` | 代理无法拦截 |
| 异常被 `catch` 吞掉 | 拦截器感知不到异常 |
| 抛出受检异常（`Exception`）| 默认只回滚 `RuntimeException` 和 `Error`，需 `rollbackFor = Exception.class` |
| 类没被 Spring 管理 | 没有代理 |
| 传播行为设置错误 | 如 `NOT_SUPPORTED`、`NEVER` |
| 多线程调用 | 事务绑定在 `ThreadLocal`，子线程拿不到连接 |
| 数据库引擎不支持 | MySQL MyISAM 无事务 |
| 多数据源未指定事务管理器 | 用错了 `TransactionManager` |

详见：<RouteLink to="/spring/4_transaction">事务失效的常见场景</RouteLink>

## 十五、Spring 声明式事务和编程式事务的区别？

| 对比项 | 声明式（`@Transactional`）| 编程式（`TransactionTemplate`）|
|--------|-------------------------|------------------------------|
| 实现 | AOP 代理 | 代码中显式控制 |
| 粒度 | 方法级 | 代码块级，可精确控制范围 |
| 侵入性 | 低 | 高 |
| 坑 | 自调用失效、长事务不易察觉 | 无代理问题 |

```java
transactionTemplate.executeWithoutResult(status -> {
    orderMapper.insert(order);
    stockMapper.deduct(order.getSkuId());
});
```

**建议**：常规业务用声明式；方法内有 RPC、文件 IO 等耗时操作时，用编程式把事务范围缩到只包 DB 操作，**避免长事务**。

详见：<RouteLink to="/spring/4_transaction">编程式事务</RouteLink>

## 十六、Spring Boot 自动配置的原理是什么？`@SpringBootApplication` 做了什么？

**`@SpringBootApplication` = 三个注解的组合**：

| 注解 | 作用 |
|------|------|
| `@SpringBootConfiguration` | 本质是 `@Configuration`，标识配置类 |
| `@ComponentScan` | 扫描启动类所在包及子包 |
| `@EnableAutoConfiguration` | 开启自动配置 |

**自动配置流程**：

1. `@EnableAutoConfiguration` 通过 `@Import(AutoConfigurationImportSelector.class)` 导入选择器
2. 选择器（`DeferredImportSelector`，在用户配置之后处理）读取 classpath 下所有 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 中的配置类
3. 排除 `exclude` 指定的类，再经过 `@Conditional` 系列条件过滤
4. 满足条件的配置类注册 Bean，属性通过 `@ConfigurationProperties` 绑定 `application.yml`

**核心条件注解**：`@ConditionalOnClass`（有某类才生效）、`@ConditionalOnMissingBean`（用户没定义才生效，**这就是"约定优于配置、用户配置优先"的关键**）、`@ConditionalOnProperty`。

详见：<RouteLink to="/spring-boot/1_spring_boot">自动配置原理</RouteLink>

## 十七、`spring.factories` / `AutoConfiguration.imports` 的作用？

两者都是 **SPI 式的配置清单**，告诉 Spring Boot "有哪些类需要加载"。

| 文件 | 版本 | 用途 |
|------|------|------|
| `META-INF/spring.factories` | 早期全部使用 | key-value 格式，登记自动配置类、`ApplicationListener`、`ApplicationContextInitializer`、`EnvironmentPostProcessor` 等 |
| `META-INF/spring/...AutoConfiguration.imports` | 2.7 引入，**3.0 起自动配置只认它** | 每行一个自动配置类全限定名 |

::: warning 升级注意
Spring Boot 3.x 中 `spring.factories` 里的 `EnableAutoConfiguration` 条目**不再生效**，自定义 Starter 升级时必须迁移到 `AutoConfiguration.imports`；其他扩展（Listener、Initializer 等）仍可放在 `spring.factories`。
:::

## 十八、如何自定义一个 Spring Boot Starter？

1. **命名**：第三方用 `xxx-spring-boot-starter`（官方才用 `spring-boot-starter-xxx`）
2. **模块**：`xxx-spring-boot-autoconfigure`（自动配置代码）+ `xxx-spring-boot-starter`（只做依赖聚合），简单场景可合并
3. **属性类**：`@ConfigurationProperties(prefix = "xxx")`
4. **自动配置类**：`@AutoConfiguration` + `@EnableConfigurationProperties` + 条件注解，Bean 上加 `@ConditionalOnMissingBean` 允许用户覆盖
5. **注册**：在 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 写入配置类全名
6. **测试**：用 `ApplicationContextRunner` 验证条件装配

```java
@AutoConfiguration
@ConditionalOnClass(RedisTemplate.class)
@EnableConfigurationProperties(MyCacheProperties.class)
public class MyCacheAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean
    public MyCacheClient myCacheClient(MyCacheProperties props) {
        return new MyCacheClient(props);
    }
}
```

详见：<RouteLink to="/spring-boot/8_custom_starter">自定义 Starter</RouteLink>

## 十九、Spring Boot 启动流程是什么？

**第一阶段：`new SpringApplication()`**

- 推断应用类型（Servlet / Reactive / None）
- 从 `spring.factories` 加载 `ApplicationContextInitializer` 和 `ApplicationListener`
- 推断主类

**第二阶段：`run()`**

1. 获取并启动 `SpringApplicationRunListeners`，发布 starting 事件
2. **准备 Environment**：加载命令行参数、`application.yml`、Profile
3. 打印 Banner
4. **创建 ApplicationContext**（Servlet 环境为 `AnnotationConfigServletWebServerApplicationContext`）
5. **prepareContext**：执行 Initializer，注册启动类为 BeanDefinition
6. **refreshContext**（核心，即 Spring 的 `refresh()`）：
   - `invokeBeanFactoryPostProcessors`：`ConfigurationClassPostProcessor` 解析配置类、组件扫描、**处理自动配置**
   - `registerBeanPostProcessors`：注册后置处理器
   - `onRefresh`：**创建内嵌 Web 服务器（Tomcat）**
   - `finishBeanFactoryInitialization`：实例化所有非懒加载单例
   - `finishRefresh`：启动 Web 服务器，发布 `ContextRefreshedEvent`
7. 调用 `ApplicationRunner` / `CommandLineRunner`
8. 发布 `ApplicationReadyEvent`，启动完成

详见：<RouteLink to="/spring-boot/1_spring_boot">Spring Boot 启动流程</RouteLink>

## 二十、Spring MVC 的请求处理流程（DispatcherServlet 工作原理）？

1. 请求进入 **`DispatcherServlet#doDispatch`**（前端控制器，统一入口）
2. **`HandlerMapping`** 根据 URL 找到处理器，返回 `HandlerExecutionChain`（Handler + 拦截器链）
3. 找到能执行该 Handler 的 **`HandlerAdapter`**（注解方式为 `RequestMappingHandlerAdapter`）
4. 执行拦截器 **`preHandle`**，返回 false 则中断
5. `HandlerAdapter` 调用 Controller：`HandlerMethodArgumentResolver` 解析参数，`HttpMessageConverter` 反序列化 `@RequestBody`
6. 返回值处理：
   - `@ResponseBody` / `@RestController`：`HttpMessageConverter`（Jackson）直接写响应体，不走视图
   - 返回视图名：得到 `ModelAndView`
7. 执行拦截器 **`postHandle`**
8. `ViewResolver` 解析视图并渲染（仅页面场景）
9. 执行拦截器 **`afterCompletion`**（无论是否异常）
10. 期间异常由 `HandlerExceptionResolver` 处理（`@ControllerAdvice` + `@ExceptionHandler`）

详见：<RouteLink to="/spring/3_mvc">DispatcherServlet 请求处理流程</RouteLink>

## 二十一、`@Controller` 和 `@RestController` 的区别？

- `@RestController = @Controller + @ResponseBody`
- `@Controller`：方法返回值默认作为**视图名**，交给 `ViewResolver` 渲染页面；需要返回 JSON 时单独在方法上加 `@ResponseBody`
- `@RestController`：所有方法返回值都经 `HttpMessageConverter` 序列化写入响应体，适合前后端分离的 REST 接口

## 二十二、过滤器（Filter）和拦截器（Interceptor）的区别？

| 对比项 | Filter | Interceptor |
|--------|--------|-------------|
| 规范 | Servlet 规范 | Spring MVC 组件 |
| 作用位置 | `DispatcherServlet` **之前**，Servlet 容器调用 | `DispatcherServlet` **之内**，Handler 前后 |
| 拦截范围 | 所有请求（含静态资源）| 只拦截进入 MVC 的请求 |
| 能否拿到 Handler | ❌ | ✅ 可获取 `HandlerMethod`、方法注解 |
| 回调 | `doFilter` | `preHandle` / `postHandle` / `afterCompletion` |
| 能否使用 Spring Bean | 需注册为 Bean（`FilterRegistrationBean`）| ✅ 天然可注入 |
| 典型用途 | 编码、CORS、XSS 过滤、请求包装、TraceId 注入 | 登录校验、权限注解、接口耗时统计 |

**执行顺序**：Filter → DispatcherServlet → Interceptor#preHandle → Controller → postHandle → afterCompletion → Filter 返回。

详见：<RouteLink to="/spring/3_mvc">拦截器实现</RouteLink>

## 二十三、Servlet 的生命周期是怎样的？Servlet 是线程安全的吗？

**核心结论**：Servlet 由容器（Tomcat / Jetty / Undertow）管理，**每个 Servlet 声明只创建一个实例**，生命周期分四步：加载并实例化 → `init` 一次 → 每个请求调用一次 `service` → 卸载时 `destroy` 一次。同一个实例被容器的多个工作线程并发调用，所以它**不是线程安全的**，不能在实例字段里保存请求相关的可变状态。

| 阶段 | 时机 | 次数 |
|------|------|------|
| 加载与实例化 | 默认在第一次请求时；配置 `load-on-startup` ≥ 0 时在容器启动时，数值越小越先 | 1 次 |
| `init(ServletConfig)` | 实例化后、处理任何请求前，读取初始化参数、建立资源 | 1 次 |
| `service(req, resp)` | 每个请求在容器的工作线程上调用，`HttpServlet` 再按方法分派到 `doGet` / `doPost` 等 | 每请求 1 次 |
| `destroy()` | 应用卸载或容器关闭时，释放资源 | 1 次 |

- **线程安全**：请求数据只放在方法局部变量和 `request` / `response` 对象里；共享状态用不可变对象或并发容器。`SingleThreadModel` 早已废弃，Servlet 6.0（Jakarta EE 10）已将其移除
- **与 Spring MVC 的关系**：整个 MVC 只有一个 `DispatcherServlet`，它的 `init` 中创建 / 关联 `WebApplicationContext` 并初始化 `HandlerMapping` 等组件。Spring Boot 默认 `spring.mvc.servlet.load-on-startup=-1`，所以第一个请求会稍慢，可设为 1 让它随启动初始化
- Controller 默认也是单例，被多个请求线程共享，同样不能把请求状态放在字段里
- 包名：Spring Boot 3 / Jakarta EE 9+ 起是 `jakarta.servlet`，不再是 `javax.servlet`
- Filter 的 `init` / `doFilter` / `destroy` 生命周期与 Servlet 相同，也是单实例多线程

详见：<RouteLink to="/spring/3_mvc">MVC</RouteLink>

## 二十四、`@Transactional` 的实现原理是什么？

1. `@EnableTransactionManagement`（Boot 自动开启）注册 `BeanFactoryTransactionAttributeSourceAdvisor`
2. 自动代理创建器发现 Bean 方法上有 `@Transactional`，为其生成代理
3. 调用时进入 **`TransactionInterceptor#invoke`** → `invokeWithinTransaction`：
   - 解析事务属性（传播、隔离、超时、只读、回滚规则）
   - 通过 `PlatformTransactionManager`（如 `DataSourceTransactionManager`）按传播行为获取 / 新建事务：从连接池取连接，`setAutoCommit(false)`
   - **连接绑定到 `ThreadLocal`**（`TransactionSynchronizationManager`），MyBatis / JdbcTemplate 从这里拿同一连接
   - 执行业务方法；异常且匹配回滚规则 → `rollback`，否则 `commit`
   - 清理 `ThreadLocal`，恢复被挂起的事务

**由此推出的结论**：自调用失效（没过代理）、多线程失效（`ThreadLocal`）、吞异常不回滚（拦截器看不到异常）。

详见：<RouteLink to="/spring/4_transaction">事务</RouteLink>

## 二十五、Spring 常用扩展点有哪些？`FactoryBean` 和 `BeanFactory` 的区别？

| 扩展点 | 时机 | 典型应用 |
|--------|------|---------|
| `BeanFactoryPostProcessor` | BeanDefinition 加载后、Bean 实例化前，可修改定义 | `PropertySourcesPlaceholderConfigurer` 解析 `${}` |
| `BeanDefinitionRegistryPostProcessor` | 比上者更早，可**注册**新的 BeanDefinition | `ConfigurationClassPostProcessor`、MyBatis `MapperScannerConfigurer` |
| `BeanPostProcessor` | 每个 Bean 初始化前后 | `@Autowired` 注入、`@PostConstruct`、**AOP 代理** |
| `FactoryBean` | 用工厂方法定制复杂 Bean 的创建 | MyBatis `SqlSessionFactoryBean`、Feign 客户端 |
| `Aware` 系列 | 属性填充后 | 获取 `ApplicationContext`、BeanName |
| `ApplicationListener` / `@EventListener` | 容器事件发布时 | 启动完成后预热缓存 |
| `ApplicationRunner` / `CommandLineRunner` | 应用启动完成后 | 初始化数据 |
| `ImportSelector` / `ImportBeanDefinitionRegistrar` | 配置类解析时 | `@EnableXxx` 注解、自动配置 |

**`FactoryBean` vs `BeanFactory`**：

- `BeanFactory`：**容器本身**，负责管理所有 Bean
- `FactoryBean`：**一个特殊的 Bean**，它的 `getObject()` 返回的对象才是真正注册的 Bean；`getBean("xxx")` 拿到的是产品对象，`getBean("&xxx")` 才拿到 `FactoryBean` 本身

详见：<RouteLink to="/spring/1_ioc">核心扩展点</RouteLink>

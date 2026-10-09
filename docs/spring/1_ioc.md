---
description: refresh 流程、依赖注入与类型转换、Bean 定义来源、作用域、生命周期、扩展点、循环依赖
---

# IoC 容器

> **本篇目标**：理解 `ApplicationContext` 从 `refresh()` 到所有单例就绪的完整过程，能正确选择注入方式、Bean 定义方式和作用域，知道每个扩展点在生命周期中的位置，并能定位和消除循环依赖。
>
> **前置阅读**：[Spring 总览](./0_overview)、[反射](/java/15_topic_reflection)

> 参考资料：
> * Spring Framework 参考文档 - IoC 容器：[https://docs.spring.io/spring-framework/reference/core/beans.html](https://docs.spring.io/spring-framework/reference/core/beans.html)
> * 作用域：[https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)
> * 容器扩展点：[https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html](https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html)
> * 基于 Java 的配置：[https://docs.spring.io/spring-framework/reference/core/beans/java.html](https://docs.spring.io/spring-framework/reference/core/beans/java.html)

**IoC（控制反转）** 指对象的创建和依赖装配不再由业务代码 `new` 出来，而是交给容器；**DI（依赖注入）** 是 IoC 的实现方式：容器创建对象时把它依赖的对象注入进去。业务代码只声明「我需要什么」，由容器决定「给你哪个实现」。

---

## 一、容器与启动流程

### 1、BeanFactory 与 ApplicationContext

| 对比 | `BeanFactory` | `ApplicationContext` |
|------|---------------|----------------------|
| 所在模块 | `spring-beans` | `spring-context` |
| 定位 | 最底层的 Bean 容器：定义注册、依赖注入、生命周期 | 在 `BeanFactory` 之上的应用上下文 |
| 单例创建时机 | 首次 `getBean` 时 | `refresh()` 末尾预实例化全部非懒加载单例，配置错误在启动期暴露 |
| 额外能力 | 无 | 自动注册 BeanPostProcessor、事件发布、国际化、`Environment` 与 Profile、资源加载 |

实际开发只用 `ApplicationContext`。Spring Boot 按应用类型选择实现：Servlet 应用是 `AnnotationConfigServletWebServerApplicationContext`，响应式应用是 `AnnotationConfigReactiveWebServerApplicationContext`，非 Web 应用是 `AnnotationConfigApplicationContext`。

### 2、refresh() 十二步

`AbstractApplicationContext.refresh()` 是容器启动的模板方法，Spring Boot 的 `SpringApplication.run()` 在准备好 `Environment` 和上下文后也是调用它。

![AbstractApplicationContext.refresh() 十二步](../assets/spring/spring-refresh-flow.svg)

需要记住的是三个关键阶段：

- **第 5 步 `invokeBeanFactoryPostProcessors`**：此时还没有任何业务 Bean 实例。`ConfigurationClassPostProcessor`（一个 `BeanDefinitionRegistryPostProcessor`）在这里解析 `@Configuration`、`@ComponentScan`、`@Import`、`@Bean`，把它们变成 `BeanDefinition`。Boot 的自动配置也在这一步通过 `@Import` 进入容器
- **第 6 步 `registerBeanPostProcessors`**：按 `PriorityOrdered` → `Ordered` → 普通的顺序实例化并注册所有 `BeanPostProcessor`。之后创建的 Bean 才会被它们处理
- **第 11 步 `finishBeanFactoryInitialization`**：冻结配置，按定义顺序 `getBean` 实例化所有非懒加载单例，依赖注入、生命周期回调、AOP 代理都发生在这里；最后回调 `SmartInitializingSingleton`

第 9 步 `onRefresh` 是留给子类的钩子，Boot 的 Web 上下文在这里创建内嵌 Tomcat / Jetty（Boot 4 已移除 Undertow），第 12 步 `finishRefresh` 启动 `SmartLifecycle` Bean（例如 Web 服务器开始接收请求、消息监听容器开始消费）并发布 `ContextRefreshedEvent`。启动过程中任一步抛异常，`refresh()` 会销毁已创建的单例并重新抛出。

| 方式 | 入口 | 典型场景 |
|------|------|---------|
| 纯 Spring | `new AnnotationConfigApplicationContext(AppConfig.class)` | 非 Web 工具、框架自身测试 |
| Spring Boot | `SpringApplication.run(App.class, args)` | 生产应用，启动流程见 [启动流程与自动配置](/spring-boot/1_spring_boot) |

---

## 二、依赖注入

### 1、三种注入方式

| 注入方式 | 写法 | 结论 |
|---------|------|------|
| 构造器注入 | 唯一构造器（可省略 `@Autowired`），或 Lombok `@RequiredArgsConstructor` | 推荐：字段可为 `final`，依赖缺失在启动时暴露，单元测试直接 `new` |
| Setter 注入 | `@Autowired` 标在 setter 上 | 用于可选依赖或需要重新配置的依赖 |
| 字段注入 | `@Autowired` 标在字段上 | 不推荐：无法声明 `final`，脱离容器无法测试，依赖过多也不易察觉 |

```java
// 推荐：构造器注入
@Service
@RequiredArgsConstructor
public class OrderService {
    private final UserRepository userRepository;
    private final InventoryService inventoryService;
}

// 可选依赖：ObjectProvider 比 @Autowired(required = false) 更清晰
@Service
public class NotificationService {

    private final ObjectProvider<EmailSender> emailSender;

    public NotificationService(ObjectProvider<EmailSender> emailSender) {
        this.emailSender = emailSender;
    }

    public void notify(String to, String text) {
        emailSender.ifAvailable(sender -> sender.send(to, text));   // 没有该 Bean 时跳过
    }
}
```

### 2、多个候选 Bean 的消歧义

`@Autowired` 按类型查找，找到多个候选时依次按 `@Primary`、`@Priority`、参数名或字段名与 Bean 名称匹配，仍无法确定则抛 `NoUniqueBeanDefinitionException`。

```java
@Configuration
public class PayClientConfig {

    @Bean
    @Primary                                   // 默认实现
    public PayClient alipayClient() { return new AlipayClient(); }

    @Bean
    public PayClient wechatClient() { return new WechatPayClient(); }
}

@Service
public class PayService {

    private final PayClient defaultClient;           // 注入 @Primary 的 alipayClient
    private final PayClient wechatClient;
    private final Map<String, PayClient> clients;    // key 为 Bean 名称，策略分发常用

    public PayService(PayClient defaultClient,
                      @Qualifier("wechatClient") PayClient wechatClient,
                      Map<String, PayClient> clients) {
        this.defaultClient = defaultClient;
        this.wechatClient = wechatClient;
        this.clients = clients;
    }

    public PayClient route(String channel) {
        PayClient client = clients.get(channel + "Client")   // alipay → alipayClient;
        if (client == null) {
            throw new IllegalArgumentException("不支持的支付渠道: " + channel);
        }
        return client;
    }
}
```

注入 `List<PayClient>` 时顺序遵循 `@Order` / `Ordered`；注入 `Map<String, PayClient>` 时 key 是 Bean 名称，比在代码里调用 `ApplicationContext.getBean(name)` 更容易测试，也不依赖容器 API。

| 对比 | `@Autowired` | `@Resource` |
|------|--------------|-------------|
| 来源 | Spring | Jakarta Annotations（`jakarta.annotation.Resource`） |
| 匹配顺序 | 先按类型，再用 `@Qualifier` / 名称消歧义 | 指定 `name` 时按名称；未指定时先按字段名找，找不到再按类型 |
| 支持位置 | 构造器、方法、字段、参数 | 字段、setter（不支持构造器） |
| 可选依赖 | `required = false` | 不支持 |

Spring 6 起只识别 `jakarta.*` 注解：项目里残留的 `javax.annotation.Resource`、`javax.annotation.PostConstruct` 会被**静默忽略**，升级时要全局替换。

### 3、注入是怎么发生的

依赖注入不是容器的硬编码逻辑，而是由两个 `BeanPostProcessor` 在属性填充阶段完成：

- `AutowiredAnnotationBeanPostProcessor`：处理 `@Autowired`、`@Value`、`@Inject`。它在 `determineCandidateConstructors` 中决定用哪个构造器，在 `postProcessProperties` 中反射注入字段和方法
- `CommonAnnotationBeanPostProcessor`：处理 `@Resource`，以及 `@PostConstruct` / `@PreDestroy`

`@Lazy` 标在注入点上时，注入的是一个延迟解析代理，目标 Bean 在第一次调用代理方法时才从容器中查找，目标本身仍是普通单例。这能打破构造器循环依赖，但代价是错误推迟到运行时，见下文第七节。

### 4、类型转换

`@Value("${order.timeout}")`、MVC 的 `@RequestParam`、配置属性绑定都需要把字符串转成目标类型。Spring 的统一抽象是 `ConversionService`，扩展时实现 `Converter<S, T>`：

```java
public class StringToLocalDateConverter implements Converter<String, LocalDate> {

    private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    @Override
    public LocalDate convert(String source) {
        return LocalDate.parse(source.trim(), FORMAT);
    }
}

// Web 层参数转换：注册到 MVC 的 FormattingConversionService
@Configuration
public class WebConversionConfig implements WebMvcConfigurer {

    @Override
    public void addFormatters(FormatterRegistry registry) {
        registry.addConverter(new StringToLocalDateConverter());
    }
}
```

| 场景 | 注册方式 |
|------|----------|
| MVC / WebFlux 参数绑定 | `WebMvcConfigurer#addFormatters`；Boot 会把容器中的 `Converter` / `Formatter` Bean 自动加入 |
| `@ConfigurationProperties` 绑定 | 在 `Converter` Bean 上加 `@ConfigurationPropertiesBinding` |
| `@Value` 等容器内转换 | `BeanFactory` 的 `ConversionService`：纯 Spring 取名为 `conversionService` 的 Bean，Boot 默认设置为 `ApplicationConversionService` |

不要为了一个转换器自己声明一个 `conversionService` Bean 替换掉默认实现，那会丢失 Boot 预置的 `Duration`、`DataSize` 等转换。

---

## 三、Bean 定义的来源

容器里的每个 Bean 都先有一个 `BeanDefinition`（类名、作用域、构造参数、依赖、初始化方法等），再按定义创建实例。定义的来源有四种。

### 1、@Component 扫描

`@ComponentScan`（Boot 中由 `@SpringBootApplication` 带入，扫描启动类所在包及子包）找到 `@Component` 及其派生注解 `@Service`、`@Repository`、`@Controller`、`@Configuration` 标注的类。`@Repository` 额外会把持久层异常翻译成 `DataAccessException`。

### 2、@Bean：full 模式与 lite 模式

```java
@Configuration   // 默认 proxyBeanMethods = true，即 full 模式
public class DataSourceConfig {

    @Bean
    public DataSource dataSource() {
        return new HikariDataSource();
    }

    @Bean
    public JdbcTemplate jdbcTemplate() {
        // full 模式：配置类被 CGLIB 增强，这里拿到的是容器中的单例 dataSource
        return new JdbcTemplate(dataSource());
    }
}

@Configuration(proxyBeanMethods = false)   // lite 模式
public class CacheConfig {

    @Bean
    public CacheManager cacheManager(RedisConnectionFactory factory) {   // 依赖通过方法参数注入
        return RedisCacheManager.create(factory);
    }
}
```

| 对比 | full（`proxyBeanMethods = true`） | lite（`proxyBeanMethods = false`，或 `@Bean` 写在 `@Component` 中） |
|------|-------------------------------|----------------------------------------------------------|
| 配置类 | CGLIB 子类，类和 `@Bean` 方法不能是 `final` | 原始类，不生成子类 |
| `@Bean` 方法互相调用 | 被拦截，返回容器中的单例 | 普通 Java 调用，**每次创建新对象** |
| 启动与 AOT | 多一次字节码生成 | 更快，GraalVM 原生镜像更友好 |

Boot 的自动配置类全部使用 lite 模式。业务配置类推荐也用 lite 模式，并把依赖写成 `@Bean` 方法参数，这样不会因为方法互调意外创建出第二个实例。

### 3、@Import

`@Import` 可以导入三类东西，是各种 `@EnableXxx` 注解的基础：

| 导入对象 | 作用 | 典型例子 |
|----------|------|----------|
| 普通配置类 | 直接注册该类及其 `@Bean` | `@Import(DataSourceConfig.class)` |
| `ImportSelector` | 运行时返回要导入的类名数组；`DeferredImportSelector` 在所有用户配置类处理完后才执行 | Boot 的 `AutoConfigurationImportSelector` 读取 `AutoConfiguration.imports` |
| `ImportBeanDefinitionRegistrar` | 直接拿到 `BeanDefinitionRegistry` 编程式注册定义 | `@MapperScan`、`@EnableFeignClients`、`@ImportHttpServices` |

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@Import(AuditRegistrar.class)
public @interface EnableAudit {
    String topic() default "audit";
}

public class AuditRegistrar implements ImportBeanDefinitionRegistrar {

    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata, BeanDefinitionRegistry registry) {
        Map<String, Object> attrs = metadata.getAnnotationAttributes(EnableAudit.class.getName());
        String topic = attrs == null ? "audit" : (String) attrs.get("topic");
        registry.registerBeanDefinition("auditPublisher",
                BeanDefinitionBuilder.genericBeanDefinition(AuditPublisher.class)
                        .addConstructorArgValue(topic)
                        .getBeanDefinition());
    }
}
```

### 4、@Conditional 条件装配

`@Conditional(XxxCondition.class)` 让定义只在条件满足时注册，Spring 4 引入，`@Profile` 就是它的一个实现。Boot 在此基础上提供了 `@ConditionalOnClass`、`@ConditionalOnMissingBean`、`@ConditionalOnProperty` 等，这是自动配置「用户定义优先、缺省兜底」的核心，详见 [启动流程与自动配置](/spring-boot/1_spring_boot)。

---

## 四、Bean 作用域

| Scope | 实例数量 | 说明 |
|-------|----------|------|
| `singleton` | 每个容器一个 | 默认值；必须无状态或线程安全 |
| `prototype` | 每次获取一个 | 容器只负责创建，不管理销毁，`@PreDestroy` 不会被调用 |
| `request` | 每个 HTTP 请求一个 | 仅 Web 上下文 |
| `session` | 每个 HTTP Session 一个 | 仅 Web 上下文 |
| `application` | 每个 `ServletContext` 一个 | 仅 Web 上下文，与 singleton 的区别是跨多个容器共享 |
| `websocket` | 每个 WebSocket 会话一个 | STOMP over WebSocket 场景 |

### 1、单例依赖 prototype

单例只在创建时注入一次，直接注入 prototype 得到的永远是同一个对象。每次都要新实例时用 `ObjectProvider` 或 `@Lookup`：

```java
@Component
@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
public class TaskProcessor {
    public void execute() { /* 持有单次任务的状态 */ }
}

@Service
@RequiredArgsConstructor
public class BatchService {

    private final ObjectProvider<TaskProcessor> processorProvider;

    public void run() {
        TaskProcessor processor = processorProvider.getObject();   // 每次新建
        processor.execute();
    }
}

// @Lookup：容器用 CGLIB 覆盖该方法，每次调用都从容器获取（只对组件扫描的类生效，@Bean 工厂方法创建的不生效）
@Component
public abstract class ReportService {

    @Lookup
    protected abstract TaskProcessor newProcessor();

    public void generate() {
        newProcessor().execute();
    }
}
```

### 2、作用域代理

把 request / session 作用域的 Bean 注入单例时，单例创建时根本不存在请求。解决办法是注入一个**作用域代理**：代理本身是单例，每次方法调用时再到当前请求或会话中查找真实对象。

```java
@Component
@RequestScope   // 等价于 @Scope(value = "request", proxyMode = ScopedProxyMode.TARGET_CLASS)
public class RequestContext {
    private String tenantId;
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
}

@Service
@RequiredArgsConstructor
public class TenantService {

    private final RequestContext requestContext;   // 注入的是 CGLIB 作用域代理

    public String currentTenant() {
        return requestContext.getTenantId();       // 路由到当前请求的实例
    }
}
```

作用域代理依赖当前线程绑定的请求。在 `@Async` 线程池、MQ 消费线程中调用会抛 `IllegalStateException: No thread-bound request found`，这类场景应把需要的值作为参数显式传入。

---

## 五、Bean 生命周期

![单例 Bean 生命周期](../assets/spring/spring-bean-lifecycle.svg)

图中有几处容易记错的地方：

- **Aware 回调分两批**：`BeanNameAware`、`BeanClassLoaderAware`、`BeanFactoryAware` 在 `invokeAwareMethods` 中直接调用；`ApplicationContextAware`、`EnvironmentAware`、`ResourceLoaderAware` 等由 `ApplicationContextAwareProcessor`（一个 BeanPostProcessor）在初始化前回调
- **`@PostConstruct` 不是独立步骤**：它由 `CommonAnnotationBeanPostProcessor` 在 `postProcessBeforeInitialization` 中调用，因此早于 `afterPropertiesSet` 和自定义 `init-method`
- **AOP 代理在初始化之后生成**：`AbstractAutoProxyCreator` 在 `postProcessAfterInitialization` 中返回代理对象，容器中保存的是代理。因此在 `@PostConstruct` 中调用本类的 `@Transactional` 方法不会开启事务
- **销毁顺序**：`@PreDestroy` → `DisposableBean#destroy` → 自定义 `destroy-method`；只有单例会被回调。`@Bean` 默认会推断名为 `close` 或 `shutdown` 的公共方法作为销毁方法

```java
import jakarta.annotation.PostConstruct;   // Spring 6+ 只识别 jakarta 包
import jakarta.annotation.PreDestroy;

@Slf4j
@Component
public class ConnectionPool implements InitializingBean, DisposableBean, ApplicationContextAware {

    private ApplicationContext applicationContext;

    @Override
    public void setApplicationContext(ApplicationContext ctx) {   // 1. Aware 回调
        this.applicationContext = ctx;
    }

    @PostConstruct
    public void init() {                                         // 2. 初始化前（BPP 中调用）
        log.info("@PostConstruct: 预热连接");
    }

    @Override
    public void afterPropertiesSet() {                           // 3. 初始化
        log.info("InitializingBean: 校验配置");
    }

    @PreDestroy
    public void shutdown() {                                     // 4. 销毁
        log.info("@PreDestroy: 关闭连接");
    }

    @Override
    public void destroy() {                                      // 5. 销毁
        log.info("DisposableBean: 释放资源");
    }
}
```

`@PostConstruct` 里只做本 Bean 的初始化，不要依赖其他 Bean 的「已完全就绪」状态，更不要做远程调用或长耗时预热。需要所有单例就绪后执行的逻辑，用 `SmartInitializingSingleton` 或监听 `ApplicationReadyEvent`。

---

## 六、核心扩展点

| 扩展点 | 触发时机 | 能做什么 | 典型实现 |
|--------|---------|---------|---------|
| `BeanDefinitionRegistryPostProcessor` | refresh 第 5 步，最先执行 | 新增、删除 `BeanDefinition` | `ConfigurationClassPostProcessor`、MyBatis `MapperScannerConfigurer` |
| `BeanFactoryPostProcessor` | refresh 第 5 步，任何 Bean 实例化前 | 修改已有 `BeanDefinition` | `PropertySourcesPlaceholderConfigurer` |
| `InstantiationAwareBeanPostProcessor` | 实例化前后、属性填充时 | 实例化前返回替代对象短路创建；跳过属性填充；处理注入注解 | `AutowiredAnnotationBeanPostProcessor` |
| `SmartInstantiationAwareBeanPostProcessor` | 推断类型、选择构造器、循环依赖时 | `predictBeanType`、`determineCandidateConstructors`、`getEarlyBeanReference` | `AbstractAutoProxyCreator`（提前生成 AOP 代理） |
| `BeanPostProcessor` | 初始化前后 | 包装或替换 Bean | AOP 代理、`@Async`、`@Validated` 方法校验 |
| `SmartInitializingSingleton` | 所有非懒加载单例创建完成后 | 需要全部 Bean 就绪的初始化 | `EventListenerMethodProcessor` 注册 `@EventListener` |
| `FactoryBean<T>` | `getBean` 时 | 用代码构造复杂对象，容器暴露的是 `getObject()` 的结果 | MyBatis `SqlSessionFactoryBean`、`MapperFactoryBean` |
| `ImportSelector` / `ImportBeanDefinitionRegistrar` | 解析配置类时 | 按条件导入配置、编程式注册定义 | Boot 自动配置、`@EnableXxx` |
| `SmartLifecycle` | refresh 末尾启动、关闭时停止 | 管理需要启停的组件，按 phase 排序 | Web 服务器、Kafka 监听容器 |

### 1、BeanPostProcessor 示例

```java
@Slf4j
@Component
public class SlowInitDetector implements BeanPostProcessor {

    private static final long THRESHOLD_NANOS = TimeUnit.MILLISECONDS.toNanos(500);
    private final Map<String, Long> startTimes = new ConcurrentHashMap<>();

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        startTimes.put(beanName, System.nanoTime());
        return bean;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        Long start = startTimes.remove(beanName);
        if (start != null) {
            long elapsed = System.nanoTime() - start;
            if (elapsed > THRESHOLD_NANOS) {
                log.warn("Bean [{}] 初始化耗时 {}ms", beanName, TimeUnit.NANOSECONDS.toMillis(elapsed));
            }
        }
        return bean;
    }
}
```

两条生产经验：

- 在配置类中用 `@Bean` 声明 `BeanFactoryPostProcessor` 或 `BeanPostProcessor` 时，方法要声明为 `static`，否则配置类会被提前实例化，日志中出现「is not eligible for getting processed by all BeanPostProcessors」，其中的 `@Autowired`、AOP 都可能失效
- BeanPostProcessor 自己依赖的 Bean 会被提前创建，同样得不到完整处理，BPP 的依赖要尽量少。完整的启动耗时分析用 Boot 的 `ApplicationStartup`，见 [启动优化](/spring-boot/14_startup)

### 2、FactoryBean 与 SmartInitializingSingleton

```java
// 容器中名为 "signer" 的 Bean 是 Signer 对象；"&signer" 才是工厂本身
@Component("signer")
public class SignerFactoryBean implements FactoryBean<Signer> {

    @Override
    public Signer getObject() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        // 加载证书、组装私钥等复杂构造过程
        return new Signer(keyStore);
    }

    @Override
    public Class<?> getObjectType() {
        return Signer.class;
    }
}

// 所有单例创建完成后，收集全部处理器做一致性校验
@Component
@RequiredArgsConstructor
public class HandlerRegistryValidator implements SmartInitializingSingleton {

    private final List<OrderHandler> handlers;

    @Override
    public void afterSingletonsInstantiated() {
        Set<String> types = new HashSet<>();
        for (OrderHandler handler : handlers) {
            if (!types.add(handler.type())) {
                throw new IllegalStateException("重复的订单处理器类型: " + handler.type());
            }
        }
    }
}
```

---

## 七、循环依赖

### 1、Spring Boot 2.6 起默认禁止

A 依赖 B、B 又依赖 A 就是循环依赖。纯 Spring Framework 默认允许字段 / setter 循环依赖，但 **Spring Boot 2.6 起 `spring.main.allow-circular-references` 默认为 `false`**，Boot 3 / 4 沿用：任何循环依赖都会在启动时失败，报 `BeanCurrentlyInCreationException`，并打印「The dependencies of some of the beans in the application context form a cycle」以及环路上的 Bean。

循环依赖通常意味着职责划分有问题，正确的处理顺序是：

1. **重构**：把双方共同依赖的逻辑抽到第三个 Bean，或改用事件解耦（见 [事件机制](./7_event)）
2. **延迟获取**：在其中一个注入点用 `@Lazy` 或 `ObjectProvider<T>`，构造器循环也能这样打破
3. **最后手段**：设置 `spring.main.allow-circular-references=true` 恢复三级缓存机制，只适合迁移老项目时临时使用

```java
@Service
public class OrderService {

    private final ObjectProvider<CouponService> couponService;   // 不在构造时解析

    public OrderService(ObjectProvider<CouponService> couponService) {
        this.couponService = couponService;
    }

    public void place(Order order) {
        couponService.getObject().lock(order.getCouponId());     // 使用时再获取
    }
}
```

### 2、三级缓存的工作流程

即使 Boot 默认禁止，理解三级缓存也有助于看懂报错和代理相关问题。`DefaultSingletonBeanRegistry` 中的三个 Map（当前版本都是 `ConcurrentHashMap`）：

| 缓存 | 字段 | 存放内容 |
|------|------|---------|
| 一级 | `singletonObjects` | 完整初始化后的单例 |
| 二级 | `earlySingletonObjects` | 已经被其他 Bean 拿走的早期引用（可能是代理） |
| 三级 | `singletonFactories` | `ObjectFactory`，调用时执行 `getEarlyBeanReference` 生成早期引用 |

![三级缓存解决 A 与 B 的字段 / setter 循环依赖](../assets/spring/spring-circular-dependency.svg)

为什么要三级：

- **三级缓存存工厂而不是对象**，是为了**只在真正出现循环时才提前生成代理**。AOP 代理正常应该在初始化后（`postProcessAfterInitialization`）创建；如果直接把早期对象放入缓存，要么注入的是原始对象（事务失效），要么每个需要代理的 Bean 都得在实例化后立即创建代理。工厂里调用的 `SmartInstantiationAwareBeanPostProcessor#getEarlyBeanReference`（`AbstractAutoProxyCreator` 实现）会在需要时提前返回代理，并记下该 Bean 已经代理过，后续初始化阶段不再重复代理
- **二级缓存保证唯一性**：工厂只调用一次，结果放入二级缓存并删除工厂。A 同时被 B、C 循环依赖时，B 和 C 拿到的是同一个早期引用，而不是两个不同的代理

### 3、解决不了的情况

| 情况 | 原因 | 做法 |
|------|------|------|
| 构造器循环依赖 | 实例化之前就需要对方，还没有早期引用可暴露 | 在一个构造参数上加 `@Lazy`，或注入 `ObjectProvider` |
| prototype 循环依赖 | prototype 不进入缓存 | 重构 |
| 早期引用被注入后，Bean 又被其他 BPP 包装 | 例如 `@Async` 由 `AsyncAnnotationBeanPostProcessor` 在初始化后才生成代理，它不参与提前代理，最终对象与已注入的早期引用不一致 | 报「has been injected into other beans ... in its raw version」；拆分 Bean 或用 `@Lazy` |

---

## 八、按名称获取 Bean

需要运行时按名称选择实现时，优先注入 `Map<String, T>`（见第二节），只有在 Bean 是动态注册、或名称在编译期无法确定时，才直接使用容器 API：

```java
@Component
@RequiredArgsConstructor
public class DynamicDispatcher {

    private final ApplicationContext ctx;   // 直接注入，无需实现 ApplicationContextAware

    public void dispatch(String handlerName, Object data) {
        Handler handler = ctx.getBean(handlerName, Handler.class);   // 带类型，避免强转
        handler.handle(data);
    }
}
```

`ApplicationContext` 同时是事件发布器，发布与监听的完整用法见 [事件机制](./7_event)。

---

## 小结

- `ApplicationContext.refresh()` 的关键是三步：第 5 步 BeanFactoryPostProcessor 把配置类解析成 `BeanDefinition`，第 6 步注册 BeanPostProcessor，第 11 步实例化全部非懒加载单例
- 注入优先用构造器，可选依赖用 `ObjectProvider`，多实现用 `@Primary` / `@Qualifier` / `Map<String, T>`；Spring 6 起只识别 `jakarta.annotation.*`
- `@Bean` 有 full / lite 两种模式，lite 模式下方法互调会创建新对象，依赖应写成方法参数；`@Import` 的 `ImportSelector` / `ImportBeanDefinitionRegistrar` 是 Boot 自动配置与 `@EnableXxx` 的基础
- 单例依赖 prototype 用 `ObjectProvider` / `@Lookup`，依赖 request / session 作用域用作用域代理
- 生命周期：实例化 → 属性填充 → Aware → 初始化前（含 `@PostConstruct`）→ 初始化 → 初始化后（生成 AOP 代理）→ 就绪 → 销毁
- Boot 2.6+ 默认禁止循环依赖，首选重构，其次 `@Lazy` / `ObjectProvider`；三级缓存的意义是只在出现循环时才提前生成代理，二级缓存保证早期引用唯一

> 下一篇：[AOP](./2_aop) —— 在 IoC 容器之上，看 Spring 如何用代理把事务、日志、权限等横切逻辑织入 Bean。

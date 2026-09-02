# 总览

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-framework/reference/](https://docs.spring.io/spring-framework/reference/)

## 一、Spring 是什么

Spring 是 Java 生态中最主流的企业级开发框架，核心目标是**简化 Java 开发**。通过 IoC（控制反转）和 AOP（面向切面编程）两大核心机制，解耦对象依赖、分离横切关注点。

## 二、核心模块

| 模块 | 说明 |
|------|------|
| spring-core | IoC 容器基础，BeanFactory |
| spring-context | ApplicationContext，事件机制，国际化 |
| spring-aop | AOP 代理实现 |
| spring-webmvc | Web 层，DispatcherServlet |
| spring-webflux | 响应式 Web 框架 |
| spring-tx | 事务管理抽象 |
| spring-jdbc | JDBC 封装，JdbcTemplate |
| spring-test | 测试支持，MockMvc |

## 三、Spring 与 Spring Boot 的关系

- **Spring Framework** 是基础框架，提供 IoC / AOP / MVC 等核心能力
- **Spring Boot** 是在 Spring Framework 之上的**自动配置层**，消除繁琐的 XML 配置
- Spring Boot 不替代 Spring，而是让 Spring 更易用

## 四、版本演进

| 版本 | 亮点 |
|------|------|
| Spring 3.x | 全注解驱动，Java Config |
| Spring 4.x | WebSocket / @Conditional 条件注解 |
| Spring 5.x | 响应式编程 WebFlux，要求 JDK 8+ |
| Spring 6.x | 要求 JDK 17+，Virtual Thread，GraalVM 原生镜像 |

## 五、容器初始化流程（refresh 核心步骤）

`ApplicationContext.refresh()` 是容器启动的核心方法，按顺序执行以下步骤：

```
refresh()
  ① prepareRefresh()              准备：标记启动时间、校验必须属性
  ② obtainFreshBeanFactory()      创建 BeanFactory，加载 BeanDefinition
  ③ prepareBeanFactory()          配置 BeanFactory：添加内置处理器、注册内置 Bean
  ④ postProcessBeanFactory()      子类扩展（Web 容器注册 Scope 等）
  ⑤ invokeBeanFactoryPostProcessors()   执行 BeanFactoryPostProcessor（加载配置、处理注解）
  ⑥ registerBeanPostProcessors()  注册 BeanPostProcessor（排序后存入列表）
  ⑦ initMessageSource()           初始化国际化
  ⑧ initApplicationEventMulticaster() 初始化事件广播器
  ⑨ onRefresh()                   子类扩展（Web 容器创建内嵌 Tomcat）
  ⑩ registerListeners()           注册监听器
  ⑪ finishBeanFactoryInitialization()  实例化所有单例 Bean（核心：getBean 流程）
  ⑫ finishRefresh()               发布 ContextRefreshedEvent，启动完成
```

**加载入口对比：**

| 方式 | 入口 | 典型场景 |
|------|------|---------|
| 纯 Spring | `new AnnotationConfigApplicationContext(Config.class)` | 单元测试、非 Web |
| Spring Boot | `SpringApplication.run(App.class, args)` | 生产应用 |

---

## 六、依赖注入原理

```java
// @Autowired 注解处理器：AutowiredAnnotationBeanPostProcessor
// 在 postProcessProperties() 中完成字段/方法注入

// 同类型多个 Bean 时的消歧义
@Service
public class PayService {
    // 方式一：@Primary 标注首选 Bean
    // 方式二：@Qualifier 按名称指定
    @Autowired
    @Qualifier("alipayClient")
    private PayClient payClient;

    // 方式三：注入所有实现（策略模式）
    @Autowired
    private List<PayClient> allClients;

    @Autowired
    private Map<String, PayClient> clientMap;  // key = Bean 名称
}

// @Lazy 懒加载：解决循环依赖的另一种方式
@Service
public class A {
    @Autowired
    @Lazy
    private B b;   // B 不会在 A 初始化时就创建，而是在首次调用时才创建
}
```

---

## 七、类型转换

```java
// 自定义 Converter（String → LocalDate）
@Component
public class StringToLocalDateConverter implements Converter<String, LocalDate> {

    @Override
    public LocalDate convert(String source) {
        return LocalDate.parse(source, DateTimeFormatter.ofPattern("yyyy-MM-dd"));
    }
}

// 注册到 ConversionService（Spring Boot 自动扫描 @Component Converter）
// 手动注册：
@Bean
public ConversionService conversionService() {
    DefaultConversionService service = new DefaultConversionService();
    service.addConverter(new StringToLocalDateConverter());
    return service;
}
```

---

## 八、模块导读

**核心原理**：

- [IoC 容器](./1_ioc)：Bean 作用域 / 生命周期 / 三级缓存解循环依赖
- [AOP](./2_aop)：动态代理 / 切点表达式 / 自调用失效
- [MVC](./3_mvc)：DispatcherServlet 流程 / 统一返回与异常
- [事务管理](./4_transaction)：传播行为 / 隔离级别 / 失效场景

**周边能力**：

- [Cache 抽象](./5_cache)：注解缓存 / 两级缓存架构
- [Retry 重试](./6_retry)：退避策略 / 断路器
- [事件机制](./7_event)：同步异步 / 事务事件 / 事件驱动解耦
- [WebFlux](./8_webflux)：响应式编程 / Mono/Flux / R2DBC

**安全体系**：

- [Security](./9_security)：过滤器链 / JWT / 方法级权限
- [安全框架对比](./10_auth_framework)：Security vs Shiro vs Sa-Token
- [SSO 单点登录](./11_single_sign_on)：CAS / OIDC / 单点登出

**企业集成**：

- [Batch 批处理](./12_batch)：大批量数据的分块读写
- [Integration 集成](./13_integration)：消息通道 / 系统集成 DSL




---
description: Spring 与 Quarkus 概念对照、Spring 兼容扩展及其限制、迁移步骤、常见坑、何时值得迁移
---

# 从 Spring Boot 迁移

> **本篇目标**：建立 Spring Boot 与 Quarkus 的概念对照，清楚 Spring 兼容扩展能帮到什么程度、在哪里会失效；掌握一条可落地的迁移路径和常见坑，并能判断一个服务到底值不值得迁移。
>
> **前置阅读**：[Quarkus 概览](./1_basics)、[REST 与数据访问](./2_rest_data)、[原生镜像与云原生部署](./3_native)

> 参考资料：
> * Spring DI 兼容层：[https://quarkus.io/guides/spring-di](https://quarkus.io/guides/spring-di)
> * Spring Web 兼容层：[https://quarkus.io/guides/spring-web](https://quarkus.io/guides/spring-web)
> * Spring Data JPA 兼容层：[https://quarkus.io/guides/spring-data-jpa](https://quarkus.io/guides/spring-data-jpa)
> * 升级与迁移工具 `quarkus update`：[https://quarkus.io/guides/update-quarkus](https://quarkus.io/guides/update-quarkus)
> * OpenRewrite 配方（添加 Spring 兼容扩展）：[https://docs.openrewrite.org/recipes/quarkus/spring/addspringcompatibilityextensions](https://docs.openrewrite.org/recipes/quarkus/spring/addspringcompatibilityextensions)
> * Quarkiverse Nacos 配置扩展：[https://docs.quarkiverse.io/quarkus-config-extensions/dev/nacos.html](https://docs.quarkiverse.io/quarkus-config-extensions/dev/nacos.html)

---

## 一、概念对照

### 1、核心编程模型

| Spring Boot | Quarkus | 说明 |
|-------------|---------|------|
| `@SpringBootApplication` + `main` | 不需要；自定义入口用 `@QuarkusMain` | 没有组件扫描入口，Bean 由构建期索引发现 |
| `@Component` / `@Service` / `@Repository` | `@ApplicationScoped` 或 `@Singleton` | 前者懒加载 + 客户端代理，后者无代理 |
| `@Autowired` | `@Inject` 或构造器注入 | 推荐构造器注入，单构造器可省略 `@Inject` |
| `@Configuration` + `@Bean` | CDI Bean 中的 `@Produces` 方法 | |
| `@Value("${x}")` | `@ConfigProperty(name = "x")` | |
| `@ConfigurationProperties` | `@ConfigMapping`（接口） | 构建期生成实现并校验 |
| `@Profile` | `@IfBuildProfile` / `@UnlessBuildProfile` | **构建期**决定 |
| `@ConditionalOnProperty` | `@IfBuildProperty`（构建期）、`@LookupIfProperty`（运行期查找） | 没有通用的运行期条件装配 |
| `@PostConstruct`、`ApplicationRunner` | `@Observes StartupEvent`、`@Startup` | |
| `ApplicationEventPublisher` / `@EventListener` | CDI `Event<T>` + `@Observes` / `@ObservesAsync` | |
| `@Aspect` AOP | CDI 拦截器：`@InterceptorBinding` + `@Interceptor` + `@AroundInvoke` | 没有 AspectJ 切点表达式，只能按注解绑定 |

### 2、Web 与数据

| Spring Boot | Quarkus |
|-------------|---------|
| `@RestController` + `@GetMapping` | `@Path` + `@GET`（Jakarta REST） |
| `@PathVariable` / `@RequestParam` | `@PathParam` / `@QueryParam`，或 Quarkus REST 的 `@RestPath` / `@RestQuery` |
| `@ControllerAdvice` + `@ExceptionHandler` | `@ServerExceptionMapper` |
| `RestClient` / OpenFeign | REST Client（`@RegisterRestClient`） |
| WebFlux `Mono` / `Flux` | Mutiny `Uni` / `Multi` |
| Spring Data JPA | Hibernate ORM with Panache（或 Spring Data JPA 兼容层） |
| `org.springframework...@Transactional` | `jakarta.transaction.Transactional` |
| `@Scheduled` | `io.quarkus.scheduler.Scheduled`（`quarkus-scheduler`） |
| `@Async` | `ManagedExecutor`、Mutiny、`@RunOnVirtualThread` |
| `@Cacheable` | `@CacheResult`（`quarkus-cache`） |
| `@KafkaListener` / `KafkaTemplate` | `@Incoming` / `Emitter`（见 [响应式与消息](./4_reactive)） |
| Resilience4j | SmallRye Fault Tolerance（`@Retry`、`@CircuitBreaker`、`@Timeout`） |

### 3、配置、运维与测试

| Spring Boot | Quarkus |
|-------------|---------|
| `application.yml` | `application.properties`（YAML 需 `quarkus-config-yaml`） |
| `spring.profiles.active` | `quarkus.profile`，属性用 `%dev.` 等前缀 |
| Actuator health | SmallRye Health：`/q/health/live`、`/q/health/ready` |
| Actuator + Micrometer | Micrometer：`/q/metrics` |
| Spring Security | `quarkus-security`、`@RolesAllowed`、`quarkus-oidc` |
| `@SpringBootTest` | `@QuarkusTest` |
| `@MockitoBean`（原 `@MockBean`） | `@InjectMock` |
| Testcontainers 手动配置 | Dev Services 自动起容器 |
| Spring Native / AOT | 原生模式（扩展原生支持） |

---

## 二、Spring 兼容扩展

### 1、有哪些

Quarkus 提供了一组 Spring API 兼容扩展，让部分 Spring 注解可以直接在 Quarkus 中编译运行：

| 扩展 | 覆盖范围 |
|------|----------|
| `quarkus-spring-di` | `@Component`、`@Service`、`@Autowired`、`@Qualifier`、`@Value`、`@Configuration`、`@Bean`、`@Scope` 等 |
| `quarkus-spring-web` | `@RestController`、`@RequestMapping` 系列、参数注解、`@RestControllerAdvice` 中的 `@ExceptionHandler` |
| `quarkus-spring-data-jpa` | `Repository`、`CrudRepository`、`JpaRepository` 等接口的派生查询与 `@Query` |
| `quarkus-spring-boot-properties` | `@ConfigurationProperties` |
| 其他 | `spring-security`（部分注解）、`spring-cache`、`spring-scheduled`、`spring-data-rest`、`spring-cloud-config-client` |

截至 3.40 LTS，这些扩展仍在官方指南中维护；它们在 Quarkus 4 中的状态以 4.0 迁移指南为准。

### 2、它们是怎么工作的

**兼容扩展不会启动 Spring 容器**。它们在构建期把 Spring 注解翻译成 CDI / Jakarta REST 的等价物，Spring 的类只用来读元数据和作为类型签名。直接后果：

- `ApplicationContext`、`BeanPostProcessor`、`BeanFactoryPostProcessor` 等 Spring 基础设施**都不会执行**
- 引入任意 Spring 生态库（某个 Starter、自定义自动配置）**不会生效**
- 不是所有注解属性都被支持

### 3、主要限制

| 扩展 | 不支持 / 有差异 |
|------|-----------------|
| spring-di | `@Conditional` 被忽略；`@ComponentScan`、`@Import` 无意义；不支持按名称回退注入；集合注入只支持 `List`，不支持 `Set` / `Map`；不支持 `@Autowired(required = false)` |
| spring-web | 只支持 REST，不支持 `@Controller` + 视图；`@ExceptionHandler` 只能写在 `@RestControllerAdvice` 中；Reactive 栈下不能使用 `HttpServletRequest`；返回值只支持基本类型、`String`、POJO、`ResponseEntity` |
| spring-data-jpa | 不支持 `JpaSpecificationExecutor`、QueryDSL、Query by Example；`@Query` 不支持原生 SQL 与命名查询；不支持 `Future` 返回值与自定义 `SimpleJpaRepository` 基类 |

官方的态度很明确：兼容层是**过渡工具**，新代码推荐直接使用 Jakarta REST、CDI 与 Panache。

---

## 三、迁移步骤

![从 Spring Boot 迁移到 Quarkus 的推荐步骤](../assets/quarkus/quarkus-migration-steps.svg)

### 1、评估

先按依赖清单逐项确认替代方案，以下几类是迁移成本的大头：

- **Spring 生态强绑定的库**：Spring Cloud 全家桶、Spring Batch、Spring Integration、Spring Statemachine、各类自研 Starter
- **国内中间件客户端**：Nacos（Quarkiverse 有配置扩展 `quarkus-config-nacos`，服务发现需另行评估）、Apollo、Sentinel、Seata、XXL-JOB 等大多没有成熟的 Quarkus 扩展，只能以普通库形式在 JVM 模式下使用
- **运行期动态性**：基于 `@Conditional` 的条件装配、运行期注册 Bean、按字符串名字查 Bean、大量 AspectJ 切点
- **模板与视图**：Thymeleaf 等服务端渲染需换成 Qute

### 2、代码迁移

推荐「先兼容、后替换」两步走：

1. 引入 `quarkus-spring-di`、`quarkus-spring-web`、`quarkus-spring-data-jpa`，让大部分代码先编译通过，跑通核心链路
2. 按模块把 Spring 注解替换为 CDI / Jakarta REST / Panache，替换完一个模块就移除对应兼容依赖

OpenRewrite 提供 Quarkus 相关配方，其中一个会扫描代码中的 Spring 注解并自动添加对应的兼容扩展，可作为起点，结果仍需人工审查。

替换示例：

```java
// 迁移前（Spring）
@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable long id) {
        return orderService.find(id);
    }
}
```

```java
// 迁移后（Quarkus）
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import org.jboss.resteasy.reactive.RestPath;

@Path("/orders")
public class OrderResource {
    private final OrderService orderService;

    OrderResource(OrderService orderService) {
        this.orderService = orderService;
    }

    @GET
    @Path("/{id}")
    public OrderDto get(@RestPath long id) {
        return orderService.find(id);
    }
}
```

Jakarta REST 资源类默认是单例作用域，构造器注入直接可用。

### 3、AOP 改为拦截器

```java
import jakarta.interceptor.InterceptorBinding;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@InterceptorBinding
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
public @interface Audited {}
```

```java
import jakarta.annotation.Priority;
import jakarta.interceptor.AroundInvoke;
import jakarta.interceptor.Interceptor;
import jakarta.interceptor.InvocationContext;
import org.jboss.logging.Logger;

@Audited
@Interceptor
@Priority(Interceptor.Priority.APPLICATION)
public class AuditInterceptor {

    private static final Logger LOG = Logger.getLogger(AuditInterceptor.class);

    @AroundInvoke
    Object audit(InvocationContext ctx) throws Exception {
        long start = System.nanoTime();
        try {
            return ctx.proceed();
        } finally {
            LOG.infof("%s.%s took %d us", ctx.getMethod().getDeclaringClass().getSimpleName(),
                      ctx.getMethod().getName(), (System.nanoTime() - start) / 1000);
        }
    }
}
```

和 Spring AOP 一样，**同类内部的自调用不会经过拦截器**；区别是 Quarkus 只能「按注解绑定」，没有 `execution(* com.example..*Service.*(..))` 这类表达式，原来靠切点表达式批量织入的逻辑需要显式加注解。

### 4、配置与测试

- `application.yml` 可以借助 `quarkus-config-yaml` 保留格式，但键名要换成 Quarkus 的（如 `server.port` → `quarkus.http.port`、`spring.datasource.url` → `quarkus.datasource.jdbc.url`）
- 多环境从 `application-dev.yml` 改为 `%dev.` 前缀或 `application-dev.properties`
- 测试从 `@SpringBootTest` 改为 `@QuarkusTest`，`@MockitoBean` 改为 `@InjectMock`；依赖 Testcontainers 的集成测试大多可以改用 Dev Services，删掉容器配置代码
- 切片测试（`@WebMvcTest`、`@DataJpaTest`）没有直接对应，Quarkus 的思路是整应用启动一次、所有测试复用

### 5、上线

先以 JVM 模式灰度上线，对比启动时间、内存、吞吐、P99 延迟和错误率，确认业务无回归后，再按 [原生镜像与云原生部署](./3_native) 的取舍决定是否原生化。

---

## 四、常见坑

| 坑 | 现象 | 处理 |
|----|------|------|
| 动态查找的 Bean 被移除 | 运行期 `CDI.current().select()` 找不到 | 加 `@Unremovable` 或在配置中声明 |
| `@ApplicationScoped` 懒加载 | 启动时预期执行的初始化没有执行 | 监听 `StartupEvent` 或加 `@Startup` |
| 在 I/O 线程阻塞 | 返回 `Uni` 的端点里调用 JDBC 报错，或事件循环被阻塞的警告 | 改同步签名、`@Blocking` 或 `@RunOnVirtualThread` |
| 构建期配置固化 | 运行时改 `db-kind` 等属性无效 | 查配置参考中的锁图标，按环境分别构建或改用运行期属性 |
| 兼容扩展静默不生效 | Spring 某个注解属性或某个 Starter 没起作用，且不报错 | 不依赖兼容层的边缘特性，尽快替换为原生 API |
| 私有成员注入 | 需要走反射，原生模式下多出反射登记 | 改为包级可见或构造器注入 |
| Lombok 与构建期增强 | 一般可用，但需确认注解处理器顺序 | 新代码优先用 `record` |
| 团队排障习惯 | 日志框架是 JBoss Logging，Actuator 端点不存在 | 统一日志格式（JSON 日志用 `quarkus-logging-json`），更新运维手册 |

---

## 五、什么时候迁，什么时候不迁

### 1、值得迁移

- **冷启动和内存直接影响成本或体验**：Serverless、按需扩缩的任务型服务、大规模实例的边缘服务
- **新建的、边界清晰的微服务**：没有历史包袱，直接用 Quarkus 原生 API 开发
- **团队已有 Jakarta EE / MicroProfile 背景**：从应用服务器迁过来，Quarkus 比 Spring 更顺手

### 2、不建议迁移

- **深度依赖 Spring 生态**的存量系统：Spring Cloud Alibaba、Spring Batch、Spring Security 复杂定制、大量自研 Starter
- **强依赖国内中间件 SDK** 且这些 SDK 没有 Quarkus 扩展的系统
- **启动和内存不是瓶颈**的长时间运行服务：Spring Boot 自身也有 CDS / AOT 缓存、虚拟线程、原生镜像等手段（见 [启动与部署优化](/spring-boot/14_startup)），优化成本远低于迁移
- 团队规模大、招聘依赖 Spring 技能栈的组织：国内 Quarkus 人才和中文资料都明显少于 Spring

### 3、折中方案

- 新服务用 Quarkus，存量服务保持 Spring Boot，两者通过 HTTP / gRPC / MQ 通信，统一可观测性与部署规范
- 只在冷启动敏感的边缘服务试点，用真实数据证明收益后再扩大范围

---

## 小结

- Spring 的组件、注入、配置、Web、事务、调度、缓存、事件在 Quarkus 中都有对应物，差异集中在「构建期确定」：条件装配、Profile、Bean 发现都提前到构建期
- Spring 兼容扩展不启动 Spring 容器，只翻译注解，Spring 生态库与基础设施接口都不会生效，定位是过渡工具
- 迁移路径：评估依赖 → 兼容扩展跑通 → 逐模块替换为原生 API → 配置与测试迁移 → JVM 模式灰度 → 视收益原生化
- AOP 改为基于注解绑定的 CDI 拦截器，自调用同样不生效；`@ApplicationScoped` 懒加载、Bean 被移除、构建期配置固化是高频坑
- 冷启动与内存敏感的新服务值得用 Quarkus；深度依赖 Spring 生态或国内中间件的存量系统不建议迁移

> 下一篇：[其他 Java 框架](./6_other_frameworks) —— Micronaut、Helidon、Solon、Javalin 各自的定位，以及与 Spring Boot、Quarkus、Vert.x 的选型对比。

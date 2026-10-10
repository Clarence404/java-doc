---
description: 2.x / 3.x / 4.x 基线对照、各版本核心特性、支持周期、2.7 → 3.x → 4.x 升级路线与常见坑
---

# Spring Boot 版本演进

> 前置阅读：[启动流程与自动配置](./1_spring_boot)

Spring Boot 的大版本跟着 Spring Framework 走：Boot 2.x / 3.x / 4.x 分别对应 Framework 5.x / 6.x / 7.x，每次升级的核心都是**基线抬升**（Java、Jakarta EE、Servlet、Hibernate、Jackson），它决定了依赖能不能编译、能不能启动。本篇梳理每一代的基线与新能力，并给出 2.7 → 3.5 → 4.x 的升级步骤。

---

## 一、三代基线对照

![Spring Boot 大版本演进与基线](../assets/spring-boot/spring-boot-versions.svg)

JDK 本身的版本特性见 [Java 版本演进](/java/2_version)。

| 维度 | Boot 2.7 | Boot 3.x（3.0 – 3.5） | Boot 4.x |
|------|----------|-----------------------|----------|
| Spring Framework | 5.3 | 6.0 – 6.2 | 7.0 起 |
| 最低 Java | 8 | 17 | 17（官方推荐最新 LTS 25） |
| 企业 API 命名空间 | `javax.*` | `jakarta.*`（Jakarta EE 10） | `jakarta.*`（Jakarta EE 11） |
| Servlet / 内嵌 Tomcat | Servlet 4.0 / Tomcat 9 | Servlet 6.0 / Tomcat 10.1 | Servlet 6.1 / Tomcat 11.0（Jetty 12.1） |
| JPA 实现 | Hibernate 5.6 | Hibernate 6.x（groupId 改为 `org.hibernate.orm`） | Hibernate 7.x |
| Jackson | 2.x | 2.x | 3.x（2.x 兼容模块已废弃） |
| 链路追踪 | Spring Cloud Sleuth | Micrometer Tracing | Micrometer Tracing / OpenTelemetry starter |
| 原生镜像 | 实验项目 Spring Native | 内置 AOT，GraalVM 22.3+ | GraalVM 25+ |

三个结论：

- **2 → 3 是「破坏性」升级**：Java 8 → 17、`javax` → `jakarta`，几乎每个项目都要改代码和依赖
- **3 → 4 是「整理性」升级**：Java 基线不变（仍是 17），但模块化 starter、Jackson 3、一批废弃 API 的删除会带来大量编译错误，工作量主要在依赖坐标和包名
- **4.x 才是新项目的默认选择**：3.5 虽然有长期商业支持，但 OSS 免费维护已于 2026-06 结束（见第四节）

---

## 二、Spring Boot 3.x：Jakarta 迁移与云原生能力

### 1、基线：Java 17 + Jakarta EE

Framework 6.0 把最低要求提到 Java 17 和 Jakarta EE 9+，Boot 3.0 选用了 Jakarta EE 10 兼容的依赖（Servlet 6.0）。最直接的影响是所有 Java EE API 的包名从 `javax.*` 换成 `jakarta.*`：

```java
// Boot 2.x
import javax.persistence.Entity;
import javax.servlet.http.HttpServletRequest;
import javax.validation.constraints.NotBlank;

// Boot 3.x 起
import jakarta.persistence.Entity;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.NotBlank;
```

注意只有「Jakarta EE 规范」的包改名，JDK 自带的 `javax.sql.DataSource`、`javax.crypto.*` 等**不改**。第三方库如果仍依赖 `javax.servlet`，必须升级到其 Jakarta 版本，否则运行时直接 `ClassNotFoundException`。

### 2、AOT 与 GraalVM 原生镜像（3.0）

Framework 6 / Boot 3 内置了 AOT（Ahead-of-Time）处理：构建期提前完成 Bean 定义解析、生成反射与代理的元数据，再交给 GraalVM `native-image` 编译成原生可执行文件。收益是毫秒级启动、更低内存，代价是构建慢、动态特性（反射、动态代理、运行时字节码生成）受限，`@Profile` / `@ConditionalOnProperty` 这类条件在构建期就被固定。JIT 与 AOT 的原理对比见 [JIT 编译](/jvm/7_jit)。

```bash
# Maven：需要 GraalVM 与 native profile
mvn -Pnative native:compile
# 或直接构建原生镜像容器
mvn -Pnative spring-boot:build-image
```

### 3、可观测性：Micrometer Observation 与 Tracing（3.0）

Boot 3.0 支持 Micrometer 1.10 引入的 Observation API——一次埋点同时产出指标和链路 Span，并自动配置 Micrometer Tracing（支持 Brave、OpenTelemetry 桥接，导出到 Zipkin 等）。Spring Cloud Sleuth 不再适用于 Boot 3，链路追踪统一改用 Micrometer Tracing。Boot 侧的端点与指标配置见 [Actuator 监控](./7_actuator)，整体可观测性体系见 [可观测性总览](/observability/0_overview)。

### 4、ProblemDetail：标准化错误响应（3.0）

Framework 6.0 支持 RFC 7807（现为 RFC 9457）Problem Details，错误响应使用 `application/problem+json`。Boot 中开启：

```yaml
spring:
  mvc:
    problemdetails:
      enabled: true
```

开启后框架内置异常（参数校验失败、405、415 等）统一输出 `type` / `title` / `status` / `detail` / `instance` 结构；业务异常可在 `@RestControllerAdvice` 中直接返回 `ProblemDetail`：

```java
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(OrderNotFoundException.class)
    public ProblemDetail handle(OrderNotFoundException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Order Not Found");
        pd.setProperty("orderId", ex.getOrderId());   // 扩展字段
        return pd;
    }
}
```

### 5、HTTP 客户端：HTTP Interface（3.0）与 RestClient（3.2）

- Framework 6.0 引入基于 `@HttpExchange` 的声明式 HTTP 接口客户端
- Framework 6.1 / Boot 3.2 引入同步的 `RestClient`，取代 `RestTemplate` 成为同步调用的推荐写法

两者的用法与选型已在 [Web 开发 - HTTP 客户端](./2_web_dev) 展开，这里不重复。Boot 4 对 HTTP Interface 的进一步简化见第三节。

### 6、开发期服务与 SSL Bundle（3.1 / 3.2）

| 能力 | 说明 |
|------|------|
| Docker Compose 支持 | 新模块 `spring-boot-docker-compose`：启动应用时自动 `docker compose up`，并根据容器自动生成连接配置，本地不用再手写数据库 / Redis 地址 |
| `@ServiceConnection` | `spring-boot-testcontainers` 提供，标在 `@Container` 字段上即可自动注入连接信息，替代手写 `@DynamicPropertySource`；测试细节见 [Testcontainers](/testing/5_testcontainers) |
| 开发期 Testcontainers | 通过测试目录下的 main 方法启动应用（Maven `spring-boot:test-run` / Gradle `bootTestRun`），开发时也用容器提供依赖服务 |
| SSL Bundle | 用统一的 `spring.ssl.bundle.*` 配置证书，Web 服务器、Redis、Kafka 等按名称引用，取代分散的 keystore 配置 |

3.2 起 SSL Bundle 支持证书文件变化后热加载（需 bundle 设置 `reload-on-update: true`，消费方目前支持 Tomcat、Netty 服务器），配合 Let's Encrypt 这类短期证书很实用：

```yaml
spring:
  ssl:
    bundle:
      pem:
        webserver:
          reload-on-update: true
          keystore:
            certificate: "file:/etc/letsencrypt/live/example.com/fullchain.pem"
            private-key: "file:/etc/letsencrypt/live/example.com/privkey.pem"
server:
  ssl:
    bundle: webserver
```

### 7、虚拟线程与 JdbcClient（3.2）

- **虚拟线程**：运行在 Java 21 上并设置 `spring.threads.virtual.enabled=true`，Tomcat / Jetty 请求处理、`@Async`（`applicationTaskExecutor`）、`@Scheduled`（`taskScheduler`）、Kafka / RabbitMQ 监听容器都会改用虚拟线程。适用场景与钉住（pinning）等坑见 [异步任务与定时任务 - 虚拟线程](./9_async_schedule)
- **JdbcClient**：Framework 6.1 新增的流式 JDBC API，Boot 3.2 基于 `NamedParameterJdbcTemplate` 自动配置，轻量查询不必再引入 ORM

```java
List<Order> orders = jdbcClient.sql("select * from t_order where user_id = :userId")
        .param("userId", userId)
        .query(Order.class)
        .list();
```

- **嵌套 JAR 加载器重写**：启动器类改到 `org.springframework.boot.loader.launch` 包下，若有自定义启动脚本写死了旧类名需同步修改

### 8、结构化日志、@MockitoBean 与其他（3.4）

| 变化 | 说明 |
|------|------|
| 结构化日志 | `logging.structured.format.console` / `logging.structured.format.file` 直接输出 JSON，内置 `ecs`、`logstash`、`gelf` 三种格式，详见 [日志](./12_logging) |
| `@MockitoBean` / `@MockitoSpyBean` | Framework 6.2 提供，Boot 3.4 起 `@MockBean` / `@SpyBean` 废弃，**Boot 4.0 删除** |
| HTTP 客户端选择 | `spring.http.client.factory` 指定底层实现（`http-components` / `jetty` / `reactor` / `jdk` / `simple`） |
| 优雅停机默认开启 | 内嵌服务器默认 graceful shutdown，要恢复旧行为设 `server.shutdown=immediate` |
| Actuator 访问控制 | `management.endpoint.<id>.enabled` 废弃，改用 `management.endpoint.<id>.access`（`none` / `read-only` / `unrestricted`） |

```java
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest
class OrderServiceTest {

    @MockitoBean
    PaymentClient paymentClient;   // 替代旧的 @MockBean
}
```

### 9、最后一个 3.x：3.5

3.5（2025-05）是 3.x 的最后一个版本线，主要为 4.0 做铺垫：`spring.mvc.converters.preferred-json-mapper` 等属性迁到 `spring.http.*` 前缀、`heapdump` 端点默认 `access=none`、自动配置的执行器 Bean 只保留 `applicationTaskExecutor` 名称。它也是 **3.x 升级到 4.x 的必经跳板**——迁移指南要求先升到最新 3.5.x 并清除所有废弃 API 调用。

---

## 三、Spring Boot 4.x / Spring Framework 7

### 1、基线

- Java 17 起步，官方推荐使用最新 LTS（Java 25）；Kotlin 2.2；GraalVM 25+
- Jakarta EE 11：Servlet 6.1、JPA 3.2、Bean Validation 3.1；内嵌 Tomcat 11.0 / Jetty 12.1
- 主要依赖：Spring Security 7.0、Spring Data 2025.1、Spring Batch 6.0、Hibernate ORM 7.x、Micrometer 1.16、Testcontainers 2.0、Kafka 客户端 4.1

### 2、模块化 starter 与改名

Boot 4 把原来一个巨大的 `spring-boot-autoconfigure` 拆成按技术划分的小模块，命名规则统一为：模块 `spring-boot-<技术>`、starter `spring-boot-starter-<技术>`、测试 starter `spring-boot-starter-<技术>-test`。带来的变化：

| 旧 starter | 新 starter |
|------------|------------|
| `spring-boot-starter-web` | `spring-boot-starter-webmvc` |
| `spring-boot-starter-web-services` | `spring-boot-starter-webservices` |
| `spring-boot-starter-aop` | `spring-boot-starter-aspectj`（只有用到 `@Aspect` 等 AspectJ 注解才需要） |
| `spring-boot-starter-oauth2-client` | `spring-boot-starter-security-oauth2-client` |
| `spring-boot-starter-oauth2-resource-server` | `spring-boot-starter-security-oauth2-resource-server` |
| `spring-boot-starter-oauth2-authorization-server` | `spring-boot-starter-security-oauth2-authorization-server` |

另外两个容易踩的点：

- **只引第三方库不再生效**：例如只引 `flyway-core` 而不引 `spring-boot-starter-flyway`，Flyway 自动配置不会加载——因为对应的自动配置类已经在独立模块里了
- **测试 starter 拆分**：`@WithMockUser` 需要 `spring-boot-starter-security-test`；各技术的 `-test` starter 会传递引入 `spring-boot-starter-test`

迁移时可先用 `spring-boot-starter-classic` / `spring-boot-starter-test-classic` 一次性拿回全部自动配置，先让项目编译通过，再逐步换成精确的模块化 starter。自动配置的加载机制见 [启动流程与自动配置](./1_spring_boot)。

### 3、Jackson 3

Framework 7 默认使用 Jackson 3，包名从 `com.fasterxml.jackson` 变为 `tools.jackson`；但 **`jackson-annotations` 保持原包名**，`@JsonProperty`、`@JsonIgnore` 等注解不用改。

| Boot 3.x | Boot 4.x |
|----------|----------|
| `com.fasterxml.jackson.databind.ObjectMapper` | `tools.jackson.databind.json.JsonMapper`（自定义时声明 `JsonMapper` Bean，而不是 `ObjectMapper`） |
| `Jackson2ObjectMapperBuilderCustomizer` | `JsonMapperBuilderCustomizer` |
| `@JsonComponent` / `@JsonMixin` | `@JacksonComponent` / `@JacksonMixin` |
| `spring.jackson.read.*` / `spring.jackson.write.*` | `spring.jackson.json.read.*` / `spring.jackson.json.write.*` |

Jackson 3 的部分默认值与 2.x 不同，输出 JSON 可能变化；过渡期可设 `spring.jackson.use-jackson2-defaults=true` 贴近 2.x 行为，或引入已废弃的 `spring-boot-jackson2` 模块继续使用 Jackson 2（配置前缀 `spring.jackson2`）。

### 4、JSpecify 空安全

Framework 7 废弃了自家基于 JSR 305 语义的空值注解（`org.springframework.lang.Nullable` / `NonNull` 等），改用 [JSpecify](https://jspecify.dev/)（`org.jspecify.annotations.Nullable` / `@NullMarked`），并把空值声明细化到泛型参数、数组元素。对 Java 用户主要是 IDE 与 NullAway 等静态检查更准确；Kotlin 用户会看到部分 API 的可空性变化，可能引发编译错误。

### 5、API 版本控制

Framework 7 在 Spring MVC 与 WebFlux 中内置 API 版本控制，版本可来自请求头、查询参数、媒体类型参数或路径，Boot 4 提供 `spring.mvc.apiversion.*` / `spring.webflux.apiversion.*` 自动配置：

```yaml
spring:
  mvc:
    apiversion:
      default: 1.0.0
      use:
        header: X-Version
```

```java
@RestController
@RequestMapping("/account/{id}")
public class AccountController {

    @GetMapping(version = "1.1")      // 仅匹配 1.1
    public Account getV1_1() { ... }

    @GetMapping(version = "1.2+")     // 匹配 1.2 及以上已支持的版本
    public Account getV1_2() { ... }
}
```

支持的版本默认从控制器映射上声明的版本自动收集。请求的版本不在支持列表中会抛 `InvalidApiVersionException`，返回 400；启用版本控制后默认要求请求携带版本，缺失时抛 `MissingApiVersionException`（同样 400），配置了默认版本（如上例 `default`）则缺失时按默认版本处理。需要多种解析策略组合时，在 `WebMvcConfigurer#configureApiVersioning` 中编程配置。API 版本设计的通用规范（路径版本 vs 请求头版本）属于 API 设计话题，这里只讲框架支持。

### 6、HTTP 服务客户端注册

Boot 3 中使用 HTTP Interface 需要为每个接口手写 `HttpServiceProxyFactory` 的 Bean；Framework 7 新增 `@ImportHttpServices` 按分组批量注册，Boot 4 再用 `spring.http.serviceclient.<group>.*` 配置每组的地址、超时等：

```java
import org.springframework.web.service.registry.ImportHttpServices;

@SpringBootApplication
@ImportHttpServices(group = "inventory", basePackages = "com.example.client.inventory")
public class Application { ... }
```

```yaml
spring:
  http:
    clients:
      connect-timeout: 1s           # 所有 HTTP 客户端的全局默认值
    serviceclient:
      inventory:
        base-url: "http://inventory-service"
        read-timeout: 2s
```

接口本身仍是普通的 `@GetExchange` / `@PostExchange` 声明，直接注入使用；按组定制（加统一请求头、拦截器）声明 `RestClientHttpServiceGroupConfigurer` Bean。微服务内部调用的方案对比见 [Spring Cloud 服务通信](/spring-cloud/3_communication)。

### 7、内置弹性注解：@Retryable / @ConcurrencyLimit

Spring Retry 项目的核心能力被收进 Framework 7 本身，不再需要额外依赖：

```java
import org.springframework.resilience.annotation.ConcurrencyLimit;
import org.springframework.resilience.annotation.EnableResilientMethods;
import org.springframework.resilience.annotation.Retryable;
import org.springframework.web.client.RestClientException;

@Configuration
@EnableResilientMethods           // 开启 @Retryable 与 @ConcurrencyLimit
public class ResilienceConfig { }

@Service
public class NotificationService {

    // 仅对 RestClientException 重试：最多重试 4 次，100ms 起指数退避，单次等待上限 1s
    @Retryable(includes = RestClientException.class,
               maxRetries = 4, delay = 100, multiplier = 2, maxDelay = 1000)
    public void send(Notification n) { ... }

    // 同一时刻最多 10 个线程进入，适合在虚拟线程下保护下游
    @ConcurrencyLimit(10)
    public Report generate(Long id) { ... }
}
```

- 默认重试任意异常、`maxRetries = 3`、间隔 1 秒；总调用次数 = 1 + `maxRetries`
- 返回 `Mono` / `Flux` 的响应式方法会自动套上 Reactor 的重试
- 编程式用法是 `org.springframework.core.retry.RetryTemplate` + `RetryPolicy`，注意它与 `@Retryable` 注解同名的 `org.springframework.core.retry.Retryable` 接口不是一个东西
- Boot 4 不再管理 Spring Retry 的依赖版本，继续用 Spring Retry 需显式写版本号

它只覆盖方法级重试与并发上限；熔断、限流、舱壁等完整治理仍用 Resilience4j / Sentinel，系统级策略见 [高可用 - 限流熔断降级](/high-avail/0_overview)。

### 8、移除与废弃

| 类别 | 内容 | 替代 |
|------|------|------|
| 移除 | Undertow 内嵌服务器与 starter | Tomcat / Jetty |
| 移除 | `@MockBean` / `@SpyBean` | `@MockitoBean` / `@MockitoSpyBean` |
| 移除 | 可执行 JAR 内嵌启动脚本（`fully executable jar`） | `java -jar` 或容器镜像 |
| 移除 | `javax.annotation` / `javax.inject` 注解支持（如 `javax.annotation.PostConstruct`） | `jakarta.annotation` / `jakarta.inject` |
| 移除 | 路径匹配的尾斜杠匹配、后缀匹配等选项 | `UrlHandlerFilter` |
| 移除 | `ListenableFuture` | `CompletableFuture` |
| 移除 | Spring Session Hazelcast / MongoDB、Reactive Pulsar 自动配置、Spock 集成 | — |
| 行为变化 | `@SpringBootTest` 不再自动提供 MockMvc、`TestRestTemplate` | 显式加 `@AutoConfigureMockMvc` / `@AutoConfigureTestRestTemplate`，或改用新的 `RestTestClient` |
| 行为变化 | 存活 / 就绪探针默认开启；DevTools LiveReload 默认关闭 | `management.endpoint.health.probes.enabled` / `spring.devtools.livereload.enabled` |
| 废弃 | Jackson 2 支持、JUnit 4 支持（`SpringRunner` 等）、Boot 的 `HttpMessageConverters` | Jackson 3、JUnit Jupiter（`SpringExtension`）、`ClientHttpMessageConvertersCustomizer` / `ServerHttpMessageConvertersCustomizer` |
| 行为变化 | 低层 Elasticsearch `RestClient` 自动配置 | 改为自动配置新的 `Rest5Client` |
| 废弃 | `RestTemplate`（7.0 在文档中标记废弃，计划 7.1 加 `@Deprecated`） | `RestClient` |

---

## 四、支持周期

数据来自 spring.io 官方支持周期（月份为发布月 / 截止月），**OSS** 指社区免费维护（Bug 与安全补丁），**商业**指 Broadcom（VMware Tanzu）付费支持：

| 版本线 | 首发 | OSS 支持截止 | 商业支持截止 | 对应 Framework |
|--------|------|--------------|--------------|----------------|
| 2.7 | 2022-05 | 2023-06 | 2029-06 | 5.3 |
| 3.0 | 2022-11 | 2023-12 | 2024-12 | 6.0 |
| 3.1 | 2023-05 | 2024-06 | 2025-06 | 6.0 |
| 3.2 | 2023-11 | 2024-12 | 2025-12 | 6.1 |
| 3.3 | 2024-05 | 2025-06 | 2026-06 | 6.1 |
| 3.4 | 2024-11 | 2025-12 | 2026-12 | 6.2 |
| 3.5 | 2025-05 | 2026-06 | 2032-06 | 6.2 |
| 4.0 | 2025-11 | 2026-12 | 2027-12 | 7.0 |
| 4.1 | 2026-06 | 2027-07 | 2028-07 | 7.0 |
| 4.2（计划） | 2026-11 | 2027-12 | 2028-12 | 7.1 |

规律与选型：

- **每半年一个小版本**（5 月、11 月），普通版本线 OSS 支持约 13 个月；2.7 和 3.5 作为大版本的最后一个版本线获得超长商业支持
- 截至 2026-10，**所有 2.x 与 3.x 的 OSS 支持都已结束**，继续使用只能靠商业支持或自行承担安全风险
- 新项目直接上 4.x 最新版本线 + Java 21 / 25；存量 3.x 项目先升到 3.5 再规划迁移 4.x

---

## 五、升级指南

### 1、总路线：逐个大版本走，不跳级

路线是 **2.x 任意版本 → 2.7.x 最新 → 3.5.x 最新 → 4.x**。每一步都遵循同一套动作：**先升到当前大版本的最后一个版本线并清掉所有废弃警告**（废弃 API 会在下一个大版本删除），再跨大版本。不建议 2.7 直接跳 4.x——两次迁移的问题会叠在一起，很难定位。

通用工具：

- **`spring-boot-properties-migrator`**：启动时扫描配置，打印被改名 / 删除的属性并临时按新名生效，迁移完成后删掉

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-properties-migrator</artifactId>
    <scope>runtime</scope>
</dependency>
```

- **OpenRewrite**：自动改依赖、包名、废弃 API，配方 `org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5`、`org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0`（位于 `rewrite-spring`）。自动改完仍需人工审查 diff 并跑全量测试
- **配套组件同步升级**：Spring Cloud、MyBatis-Plus、Knife4j / SpringDoc、ShardingSphere 等非 Boot 管理的依赖要换成支持目标版本的版本，Spring Cloud 必须按官方兼容表选择对应的 release train

```bash
mvn -U org.openrewrite.maven:rewrite-maven-plugin:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:RELEASE \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5
```

### 2、2.7 → 3.x 检查清单

| 问题 | 现象 | 处理 |
|------|------|------|
| JDK | 编译失败 | 构建与运行环境升到 Java 17+（建议直接 21） |
| `javax.*` 包名 | 大量编译错误；第三方库运行时 `NoClassDefFoundError: javax/servlet/...` | 全局替换为 `jakarta.*`（只换 Jakarta EE 规范的包）；升级不支持 Jakarta 的三方库 |
| 自动配置注册 | 自定义 starter 不生效 | `spring.factories` 中 `EnableAutoConfiguration` 键的注册方式在 3.0 删除，改写到 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`（2.7 起已支持），见 [自定义 Starter](./8_custom_starter) |
| 尾斜杠匹配 | `/orders/` 返回 404，原来能匹配 `/orders` | Framework 6 默认关闭尾斜杠匹配；客户端改用规范路径，过渡期可在 `configurePathMatch` 中 `setUseTrailingSlashMatch(true)`（4.x 已删除该选项） |
| Hibernate 6 | 依赖坐标找不到；HQL / 主键生成行为变化 | groupId 改为 `org.hibernate.orm`；`spring.jpa.hibernate.use-new-id-generator-mappings` 已删除，检查 ID 生成策略与原生 SQL |
| Redis 配置前缀 | 连不上 Redis（仍连 localhost） | `spring.redis.*` 改为 `spring.data.redis.*` |
| Actuator | `/actuator/httptrace` 404；`/env` 值全是 `******` | 端点改名 `httpexchanges`；`/env`、`/configprops` 默认脱敏，用 `show-values` 控制 |
| 链路追踪 | Sleuth 不生效 | 换成 Micrometer Tracing + 对应的 bridge / exporter |
| 日志时间格式 | 日志采集解析失败 | 默认日期改为 ISO-8601，可用 `logging.pattern.dateformat` 恢复 |
| Spring Security 6 | `WebSecurityConfigurerAdapter` 不存在 | 改为声明 `SecurityFilterChain` Bean，建议先在 2.7 上升到 Security 5.8 完成改造 |
| Elasticsearch | `RestHighLevelClient` 自动配置消失 | 改用新的 Elasticsearch Java Client |

### 3、3.5 → 4.x 检查清单

| 问题 | 现象 | 处理 |
|------|------|------|
| starter 改名 / 模块化 | 依赖解析失败，或 Flyway 等自动配置不加载 | 按第三节改名表替换；第三方库补上对应 starter；过渡期用 `spring-boot-starter-classic` |
| Jackson 3 | `com.fasterxml.jackson.databind` 编译错误；JSON 输出格式变化 | 包名改为 `tools.jackson`（注解包不变）；自定义 `ObjectMapper` Bean 改为 `JsonMapper`；对比接口快照，必要时 `spring.jackson.use-jackson2-defaults=true` |
| 测试 | `@MockBean` 不存在；MockMvc / `TestRestTemplate` 注入失败 | 换 `@MockitoBean`；加 `@AutoConfigureMockMvc` / `@AutoConfigureTestRestTemplate` |
| 包迁移 | `@EntityScan`、`EnvironmentPostProcessor` 等找不到 | `@EntityScan` 移到 `org.springframework.boot.persistence.autoconfigure`；`EnvironmentPostProcessor` 移到 `org.springframework.boot`，同步修改 `spring.factories` 中的键 |
| 尾斜杠 | 3.x 中靠 `setUseTrailingSlashMatch(true)` 兜底的接口编译失败 | 改用 `UrlHandlerFilter` 统一去掉尾斜杠 |
| Undertow | 依赖不存在 | 换回 Tomcat 或 Jetty |
| Spring Retry | 版本号缺失 | 显式声明版本，或迁到 Framework 7 的 `@Retryable` |
| 属性改名 | 配置不生效 | 典型：`spring.session.redis.*` → `spring.session.data.redis.*`，MongoDB 连接属性 `spring.data.mongodb.*` → `spring.mongodb.*`，`management.tracing.enabled` → `management.tracing.export.enabled`；交给 properties-migrator 检查 |
| Kotlin / 空安全 | Kotlin 代码可空性编译错误 | 按 JSpecify 新的可空声明调整 |

`UrlHandlerFilter` 的写法（注册为普通 `Filter` Bean 即可）：

```java
import org.springframework.http.HttpStatus;
import org.springframework.web.filter.UrlHandlerFilter;

@Bean
public UrlHandlerFilter urlHandlerFilter() {
    return UrlHandlerFilter
            .trailingSlashHandler("/api/**").wrapRequest()                         // 内部改写，不跳转
            .trailingSlashHandler("/blog/**").redirect(HttpStatus.PERMANENT_REDIRECT) // 308 跳转
            .build();
}
```

### 4、落地顺序

1. 建升级分支，确认测试覆盖关键链路（没有测试的升级等于盲改，测试体系见 [测试工程](/testing/0_overview)）
2. 升到当前大版本的最新补丁版，修完所有废弃警告
3. 加 `spring-boot-properties-migrator`，跑 OpenRewrite 配方
4. 修编译错误 → 修启动错误 → 跑全量测试 → 对比关键接口的 JSON 输出与监控指标名
5. 灰度发布，观察错误率、延迟、GC 与线程数，确认后删除 properties-migrator 与 classic starter

---

## 小结

- Boot 大版本跟随 Framework：2.x ↔ 5.x、3.x ↔ 6.x、4.x ↔ 7.x；升级的本质是基线抬升
- 3.0：Java 17、`javax` → `jakarta`（Jakarta EE 10 / Servlet 6.0）、Hibernate 6、AOT 原生镜像、Micrometer Observation / Tracing、ProblemDetail、HTTP Interface
- 3.x 小版本：3.1 Docker Compose / `@ServiceConnection` / SSL Bundle，3.2 RestClient / 虚拟线程 / JdbcClient，3.4 结构化日志 / `@MockitoBean`，3.5 是 3.x 的最后一个版本线
- 4.0：Java 17 起步（推荐 25）、Jakarta EE 11 / Servlet 6.1、模块化 starter 与改名、Jackson 3（`tools.jackson`）、JSpecify、API 版本控制、`@ImportHttpServices`、`@Retryable` / `@ConcurrencyLimit` 进入核心框架；Undertow、`@MockBean`、尾斜杠匹配被删除
- 截至 2026-10，2.x 与 3.x 的 OSS 支持已全部结束；新项目用 4.x
- 升级路线 2.7 → 3.5 → 4.x 不跳级，每步先清废弃警告，借助 properties-migrator 与 OpenRewrite，自动化改完必须靠测试与灰度兜底

## 参考资料

- Spring Boot 4.0 Release Notes：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Release-Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Release-Notes)
- Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- Spring Boot 3.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.0-Migration-Guide)
- Spring Framework 7.0 Release Notes：[https://github.com/spring-projects/spring-framework/wiki/Spring-Framework-7.0-Release-Notes](https://github.com/spring-projects/spring-framework/wiki/Spring-Framework-7.0-Release-Notes)
- Spring Framework 6.0 Release Notes：[https://github.com/spring-projects/spring-framework/wiki/Spring-Framework-6.0-Release-Notes](https://github.com/spring-projects/spring-framework/wiki/Spring-Framework-6.0-Release-Notes)
- 支持周期：[https://spring.io/projects/spring-boot#support](https://spring.io/projects/spring-boot#support)
- OpenRewrite Spring 配方：[https://docs.openrewrite.org/recipes/java/spring](https://docs.openrewrite.org/recipes/java/spring)

> 下一篇：[日志](./12_logging) —— 从日志门面到结构化日志，看看 Spring Boot 应用的日志该怎么配、怎么采集。

---
description: "@SpringBootTest、切片测试、@MockitoBean、Testcontainers、事务回滚、上下文缓存"
---

# Spring Boot 测试

> 前置阅读：[启动流程与自动配置](./1_spring_boot)

Spring 与 Spring Boot 提供了从切片到全量上下文的测试支持。本篇讲按「单元 → 切片 → 全量」分层写测试，MockMvcTester / RestTestClient / @MockitoBean / @ServiceConnection 的用法，以及事务回滚与上下文缓存的坑，版本基线为 Spring Boot 4.x（Spring Framework 7.x，JUnit 6），3.x 差异单独标出。

---

## 一、测试依赖与分层

测试分层、覆盖率等通用原则见 [测试工程总览](/testing/0_overview)，Mockito 本身的用法见 [Mock 测试](/testing/2_mock)，Testcontainers 本身见 [Testcontainers](/testing/5_testcontainers)。

### 1、spring-boot-starter-test 里有什么

`spring-boot-starter-test`（`test` 作用域）一次带齐常用测试库：

| 库 | 作用 |
|----|------|
| JUnit（Boot 4 为 JUnit 6，Boot 3.x 为 JUnit 5） | 测试引擎与 `@Test`、`@Nested`、`@ParameterizedTest` |
| Spring Test / Spring Boot Test | TestContext 框架、`@SpringBootTest`、切片测试 |
| AssertJ | 流式断言，`MockMvcTester` 也基于它 |
| Hamcrest | Matcher 风格断言（`MockMvc` 的 `jsonPath` 常用） |
| Mockito | Mock / Spy |
| JSONassert | JSON 宽松 / 严格比较 |
| JsonPath | 按路径提取 JSON 字段 |
| Awaitility | 异步结果轮询断言 |

Spring Framework 7 把 JUnit 6 作为最低要求，并废弃了 JUnit 4 的支持类（`SpringRunner`、`SpringClassRule`、`SpringMethodRule` 等）。老的 JUnit 4 测试可以加 `junit-vintage-engine` 过渡运行，新代码一律用 JUnit Jupiter。版本由 Boot 依赖管理统一控制，不要再额外导入 JUnit BOM。

### 2、Boot 4 的测试模块化

Boot 4 把自动配置按技术拆成独立模块，测试支持也随之拆分：

- 每种技术有对应测试 starter：`spring-boot-starter-<技术>-test`，如 `spring-boot-starter-webmvc-test`、`spring-boot-starter-webflux-test`、`spring-boot-starter-data-jpa-test`；它们会传递引入 `spring-boot-starter-test`
- 切片注解随之换包，根包为 `org.springframework.boot.<技术>.test`，例如 `@WebMvcTest` 在 `org.springframework.boot.webmvc.test.autoconfigure`，`@DataJpaTest` 在 `org.springframework.boot.data.jpa.test.autoconfigure`（例外：`@JsonTest` 仍在 `org.springframework.boot.test.autoconfigure.json`）
- 一时迁不动可先用 `spring-boot-starter-test-classic` 过渡

```xml
<!-- Boot 4：按用到的技术引入测试 starter -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc-test</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa-test</artifactId>
    <scope>test</scope>
</dependency>
```

升级到 Boot 4 时，测试代码最常见的编译错误就是切片注解的 import 变了，按上面的包名规律替换即可。

### 3、Spring 项目里的测试分层

![Spring Boot 测试分层](../assets/spring-boot/boot-test-layers.svg)

| 层次 | 写法 | 启动什么 | 适合测什么 |
|------|------|----------|------------|
| 纯单元测试 | JUnit + Mockito，`new` 出被测对象 | 不启动 Spring | 领域规则、计算逻辑、分支与异常 |
| 切片测试 | `@WebMvcTest`、`@DataJpaTest` 等 | 只加载某一层的 Bean | Controller 的参数绑定 / 校验 / 序列化，Repository 的查询，JSON 映射 |
| 集成测试 | `@SpringBootTest` + Testcontainers | 完整上下文 + 真实中间件 | 跨层协作、事务、真实 SQL、MQ 收发 |
| 端到端 | `@SpringBootTest(webEnvironment = RANDOM_PORT)` | 真实 Web 服务器 | 过滤器链、错误页、安全配置等依赖真实容器的行为 |

原则：**能不启动 Spring 就不启动**。构造器注入的 Service 直接 `new` 出来传入 Mock 就能测，比任何 Spring 测试都快；只有要验证「Spring 帮你做的事」（绑定、校验、事务、序列化、自动配置）时才往上走。

---

## 二、@SpringBootTest

### 1、webEnvironment 四种模式

`@SpringBootTest` 从测试类所在包向上查找 `@SpringBootApplication`（或 `@SpringBootConfiguration`），用 `SpringApplication` 加载完整上下文。

| 模式 | 行为 | 典型搭配 |
|------|------|----------|
| `MOCK`（默认） | Web 上下文 + Mock Servlet 环境，不启动服务器；无 Web 依赖时退化为普通上下文 | `@AutoConfigureMockMvc`、`@AutoConfigureRestTestClient` |
| `RANDOM_PORT` | 启动真实服务器，监听随机端口 | `@AutoConfigureRestTestClient`、`@LocalServerPort` |
| `DEFINED_PORT` | 启动真实服务器，使用配置的端口（默认 8080） | 很少用，端口冲突风险高 |
| `NONE` | 普通上下文，没有任何 Web 环境 | 批处理、消息消费等非 Web 逻辑 |

### 2、Boot 4 不再自动提供测试客户端

Boot 3.x 下，`@SpringBootTest` 会顺带配置一些测试客户端；**Boot 4 起需要显式声明**：

| 需要 | Boot 4 写法 | 说明 |
|------|-------------|------|
| `MockMvc` / `MockMvcTester` | `@AutoConfigureMockMvc` | 来自 `spring-boot-webmvc-test` |
| `RestTestClient` | `@AutoConfigureRestTestClient` | Framework 7 新增，阻塞式的 `WebTestClient` 对等物，迁移指南建议用它替代 `TestRestTemplate` |
| `WebTestClient` | `@AutoConfigureWebTestClient` | WebFlux 应用 |
| `TestRestTemplate` | `@AutoConfigureTestRestTemplate` | 需 `spring-boot-resttestclient`（test）+ `spring-boot-restclient`，类移到 `org.springframework.boot.resttestclient` |

`RestTestClient` 在 `MOCK` 模式下绑定 MockMvc，在 `RANDOM_PORT` 下请求真实服务器，同一套断言两种场景都能用：

```java
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
class OrderApiE2eTests {

    @Autowired
    RestTestClient client;

    @Test
    void getOrder() {
        client.get().uri("/orders/{id}", 1001)
              .exchange()
              .expectStatus().isOk()
              .expectBody()
              .jsonPath("$.status").isEqualTo("PAID");
    }
}
```

### 3、@TestConfiguration：补充而不是替换

| 写法 | 效果 |
|------|------|
| 测试类内部的静态 `@TestConfiguration` | 在主配置**之外追加** Bean |
| 测试类内部的静态 `@Configuration` | **替换**主配置，`@SpringBootApplication` 不再被加载（通常不是你想要的） |
| 顶层 `@TestConfiguration` 类 | 不会被组件扫描捡到，需在测试类上 `@Import` |

```java
@SpringBootTest
@Import(TestDataConfig.class)
class BillingServiceTests { /* ... */ }

@TestConfiguration(proxyBeanMethods = false)
class TestDataConfig {

    @Bean
    OrderFixtures orderFixtures(OrderRepository repository) {   // 只在测试里存在的造数工具，追加到主配置之上
        return new OrderFixtures(repository);
    }
}
```

> 想用测试 Bean 覆盖同名生产 Bean，推荐 Framework 6.2+ 的 `@TestBean`，或让生产配置 `@ConditionalOnMissingBean`；Boot 默认禁止 Bean 定义覆盖，直接在 `@TestConfiguration` 里定义同名 Bean 会启动失败。

### 4、测试专用属性

| 方式 | 适用 |
|------|------|
| `@SpringBootTest(properties = "app.feature.x=true")` | 少量属性，只对本类生效 |
| `@TestPropertySource(properties = ...)` / `locations = ...` | 也可用于切片测试；优先级高于 `application.yml` |
| `@ActiveProfiles("test")` + `application-test.yml` | 整套测试环境配置 |
| `@DynamicPropertySource` | 值要到运行期才知道（容器端口、随机地址） |
| `DynamicPropertyRegistrar` Bean（Framework 6.2+） | 同上，但可以写在 `@TestConfiguration` 里复用 |

```java
@DynamicPropertySource
static void props(DynamicPropertyRegistry registry) {
    registry.add("app.payment.base-url", () -> "http://localhost:" + wireMock.getPort());
}
```

注意：这些注解的值都参与上下文缓存键，每个测试类写一套不同的属性，就会各自启动一个上下文（见第八节）。

---

## 三、切片测试

切片测试只加载某一层需要的自动配置和 Bean，其余依赖用 `@MockitoBean` 替身，启动快、失败定位准。

| 注解 | 加载什么 | 注入的测试工具 |
|------|----------|----------------|
| `@WebMvcTest` | `@Controller`、`@ControllerAdvice`、`Converter`、`Filter`、`HandlerInterceptor`、`WebMvcConfigurer` 等 MVC 组件 | `MockMvc` / `MockMvcTester` |
| `@WebFluxTest` | `@Controller`、`WebFluxConfigurer`、`WebFilter` 等 | `WebTestClient` |
| `@DataJpaTest` | JPA 实体、Repository、`DataSource`，默认事务回滚 | `TestEntityManager` |
| `@JsonTest` | Jackson `JsonMapper`（Boot 4 默认 Jackson 3）、`@JacksonComponent` 与 `JacksonModule` | `JacksonTester` |
| `@RestClientTest` | `RestClient.Builder` / `RestTemplateBuilder` 与被测客户端 | `MockRestServiceServer` |

`@WebMvcTest` 不扫描普通 `@Component`、`@Service` 与 `@ConfigurationProperties` Bean，Controller 依赖的 Service 必须用 `@MockitoBean` 提供，否则启动报找不到 Bean。

### 1、@WebMvcTest + MockMvcTester

`MockMvcTester`（Framework 6.2+）是 MockMvc 的 AssertJ 版本：不用再静态导入一堆 `status()`、`jsonPath()`，断言链可读性更好，Boot 4 文档的示例也全部改用它。

```java
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.assertj.MockMvcTester;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.given;

@WebMvcTest(OrderController.class)
class OrderControllerTests {

    @Autowired
    MockMvcTester mvc;

    @MockitoBean
    OrderService orderService;

    @Test
    void getOrder() {
        given(orderService.find(1001L)).willReturn(new OrderView(1001L, "PAID"));

        assertThat(mvc.get().uri("/orders/{id}", 1001))
                .hasStatusOk()
                .bodyJson()
                .extractingPath("$.status").isEqualTo("PAID");
    }

    @Test
    void rejectInvalidRequest() {
        assertThat(mvc.post().uri("/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"skuId": null, "quantity": 0}
                                """))
                .hasStatus(HttpStatus.BAD_REQUEST);
    }
}
```

`@WebMvcTest` 会把应用里的 Spring Security 过滤器链一起加载。要测鉴权就配合 `@WithMockUser`（Boot 4 需要 `spring-boot-starter-security-test`）；只想测业务就在测试里提供宽松的 `SecurityFilterChain`。

### 2、@WebFluxTest + WebTestClient

```java
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest;
import org.springframework.test.web.reactive.server.WebTestClient;

@WebFluxTest(OrderController.class)
class OrderControllerReactiveTests {

    @Autowired
    WebTestClient client;

    @MockitoBean
    OrderService orderService;

    @Test
    void getOrder() {
        given(orderService.find(1001L)).willReturn(Mono.just(new OrderView(1001L, "PAID")));

        client.get().uri("/orders/1001").exchange()
              .expectStatus().isOk()
              .expectBody().jsonPath("$.status").isEqualTo("PAID");
    }
}
```

`@WebFluxTest` 检测不到函数式路由 `RouterFunction` 和自定义 `SecurityWebFilterChain`，需要 `@Import` 相应配置或改用 `@SpringBootTest`。

### 3、@DataJpaTest

```java
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;

@DataJpaTest
class OrderRepositoryTests {

    @Autowired
    TestEntityManager em;

    @Autowired
    OrderRepository repository;

    @Test
    void findPaidOrders() {
        em.persist(new Order("u1", OrderStatus.PAID));
        em.persist(new Order("u1", OrderStatus.CREATED));
        em.flush();   // 强制落 SQL，否则约束错误要等到提交才暴露，而测试最后会回滚
        em.clear();   // 清一级缓存，确保下面的查询真正打到数据库

        assertThat(repository.findByUserIdAndStatus("u1", OrderStatus.PAID)).hasSize(1);
    }
}
```

关于数据库：`@DataJpaTest` 默认用嵌入式数据库替换应用的 `DataSource`。Boot 4 中 `@AutoConfigureTestDatabase` 的默认值是 `Replace.NON_TEST`：如果数据源本身就是测试库（`@ServiceConnection` 的 Testcontainers 容器、`@DynamicPropertySource` 提供的 URL、Testcontainers JDBC URL），就不替换。生产用 MySQL / PostgreSQL 时，**建议直接配 Testcontainers 测真实方言**，H2 的兼容模式掩盖不了方言差异、函数和锁行为的不同。

### 4、@JsonTest

```java
import org.springframework.boot.test.autoconfigure.json.JsonTest;
import org.springframework.boot.test.json.JacksonTester;

@JsonTest
class OrderViewJsonTests {

    @Autowired
    JacksonTester<OrderView> json;

    @Test
    void serialize() throws Exception {
        var content = json.write(new OrderView(1001L, "PAID"));
        assertThat(content).extractingJsonPathStringValue("$.status").isEqualTo("PAID");
        assertThat(content).doesNotHaveJsonPath("$.internalNote");   // 敏感字段不能出现在响应里
    }
}
```

适合守住 API 契约：字段命名策略、日期格式、`@JsonIgnore`、自定义序列化器都在这里锁住。

### 5、@RestClientTest

测试调用外部 HTTP 服务的客户端代码，不用起真实服务，也不用 WireMock：

```java
import org.springframework.boot.restclient.test.autoconfigure.RestClientTest;
import org.springframework.test.web.client.MockRestServiceServer;

import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

@RestClientTest(PaymentClient.class)
class PaymentClientTests {

    @Autowired
    PaymentClient client;

    @Autowired
    MockRestServiceServer server;

    @Test
    void queryStatus() {
        server.expect(requestTo("https://pay.example.com/payments/p1"))
              .andRespond(withSuccess("""
                      {"id":"p1","status":"SUCCESS"}
                      """, MediaType.APPLICATION_JSON));

        assertThat(client.query("p1").status()).isEqualTo("SUCCESS");
    }
}
```

被测客户端需要通过注入的 `RestClient.Builder`（或 `RestTemplateBuilder`）构建。用 `RestClient.Builder` 时，期望里要写完整 URI；只有 `RestTemplateBuilder` 调用了 `baseUri(...)` 时才可以只写相对路径。

---

## 四、Mock Bean：@MockitoBean 与 @MockitoSpyBean

### 1、版本变迁

| 注解 | 来源 | 状态 |
|------|------|------|
| `@MockBean` / `@SpyBean` | Spring Boot（`org.springframework.boot.test.mock.mockito`） | Boot 3.4 废弃，**Boot 4.0 删除** |
| `@MockitoBean` / `@MockitoSpyBean` | Spring Framework 6.2+（`org.springframework.test.context.bean.override.mockito`） | 当前唯一方案 |
| `@TestBean` | Spring Framework 6.2+ | 用工厂方法返回的真实对象替换 Bean |

迁移基本是改注解和 import；区别在于 `@MockitoBean` 只能写在**测试类**（及其父类、接口、`@Nested` 外层类）上，不能再写在 `@Configuration` 类里。Framework 7 起还可以覆盖原型等非单例 Bean。

### 2、在多个测试类间共享同一组 Mock

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@MockitoBean(types = {PaymentClient.class, SmsClient.class})
public @interface MockExternalClients {
}

@SpringBootTest
@MockExternalClients
class CheckoutTests {

    @Autowired
    PaymentClient paymentClient;   // 拿到的就是 Mock，可直接 given(...)
}
```

类级别声明必须用 `types` 指定类型。把「外部依赖一律 Mock」收敛成一个组合注解，所有集成测试用同一组 Mock，正好也解决了下面的缓存问题。

### 3、为什么 @MockitoBean 会拖慢测试

Mock 会被纳入上下文缓存键：A 类 Mock 了 `PaymentClient`，B 类 Mock 了 `SmsClient`，C 类什么都不 Mock，就是三个不同的上下文，各启动一次。官方还特别提醒：**同一个 Bean 在不同测试类里的 Mock 字段名也要保持一致**，字段名会作为限定符参与缓存键。

Mock 默认在每个测试方法后重置（`reset = MockReset.AFTER`），不用手动 `reset()`。

---

## 五、Testcontainers 集成

Testcontainers 的基本概念与通用用法见 [Testcontainers](/testing/5_testcontainers)，这里只讲 Spring Boot 的集成方式。需要的测试依赖：`spring-boot-testcontainers`，以及对应的 Testcontainers 模块（Testcontainers 2.0 起 artifact 统一加 `testcontainers-` 前缀，如 `org.testcontainers:testcontainers-postgresql`，类也移到了 `org.testcontainers.postgresql` 等模块包下）。

### 1、@ServiceConnection（Boot 3.1+）

以前要用 `@DynamicPropertySource` 把容器的 URL、用户名、密码逐个写进属性；`@ServiceConnection` 让 Boot 直接从容器生成 `ConnectionDetails`，自动配置据此连接，一行搞定：

```java
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;

@Testcontainers
@SpringBootTest
class OrderFlowIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:17-alpine");

    @Test
    void placeOrder() { /* ... */ }
}
```

- 支持 JDBC 数据库、Redis、MongoDB、Kafka、RabbitMQ、Elasticsearch 等常见服务；`GenericContainer` 无法从类型推断服务种类，要写 `@ServiceConnection(name = "redis")`
- `@ServiceConnection` 不覆盖的属性（如自定义的业务地址）仍然用 `@DynamicPropertySource`

### 2、把容器声明成 Bean，所有测试共享

`@Container` 静态字段的生命周期跟着测试类走：类结束容器就停，但上下文还在缓存里，下一个复用该上下文的类会连到已停止的容器。官方推荐把容器声明成 Bean，交给 Spring 管理生命周期：

```java
@TestConfiguration(proxyBeanMethods = false)
public class ContainersConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer postgres() {
        return new PostgreSQLContainer("postgres:17-alpine");
    }

    @Bean
    @ServiceConnection(name = "redis")
    GenericContainer<?> redis() {
        return new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);
    }
}

@SpringBootTest
@Import(ContainersConfig.class)
class OrderFlowIT { /* ... */ }
```

所有集成测试 `@Import` 同一个配置类，就共享同一个上下文和同一组容器。多个容器可用 `spring.testcontainers.beans.startup=parallel` 并行启动（默认 `sequential`）。

### 3、开发期直接用容器启动应用

同一份 `ContainersConfig` 还能用于本地开发：在 `src/test/java` 下写一个启动类，不用本地装数据库就能跑起整个应用：

```java
public class TestOrderApplication {

    public static void main(String[] args) {
        SpringApplication.from(OrderApplication::main)
                .with(ContainersConfig.class)
                .run(args);
    }
}
```

用 `./mvnw spring-boot:test-run` 或 `./gradlew bootTestRun` 启动。配合 DevTools 时给容器 Bean 加 `@RestartScope`，热重启时容器不会重建、数据不丢。

想让容器在多次 `mvn test` 之间也保留，可以用 Testcontainers 自身的容器复用机制，具体配置见 [Testcontainers](/testing/5_testcontainers)。

---

## 六、事务回滚语义与陷阱

### 1、默认规则

- 测试方法上（或类上）加 `@Transactional`，测试结束**默认回滚**；`@DataJpaTest` 自带事务，同样回滚
- 想看到落库结果：`@Commit`（等价 `@Rollback(false)`），一般只在排查时临时用
- 不想要测试事务：`@Transactional(propagation = Propagation.NOT_SUPPORTED)`

### 2、常见陷阱

| 陷阱 | 原因 | 对策 |
|------|------|------|
| `RANDOM_PORT` / `DEFINED_PORT` 测试的数据不回滚 | HTTP 客户端与服务端在不同线程，服务端开启的是另一个事务，测试方法上的 `@Transactional` 管不到 | 用唯一业务数据隔离，或 `@AfterEach` / `@Sql` 清理 |
| 约束冲突、唯一索引错误没暴露 | JPA 写操作在 flush 时才发 SQL，测试最后直接回滚，SQL 根本没执行 | 断言前 `flush()` |
| 测试里能懒加载，线上 `LazyInitializationException` | 测试事务包住了整个方法，Session 一直打开 | 对涉及懒加载的流程不要加测试事务，或 `clear()` 后在事务外验证 |
| `REQUIRES_NEW`、`@Async`、MQ 消费的写入没回滚 | 它们在独立事务或其他线程里 | 按「真实提交」处理，测试后显式清理 |
| 测试通过但线上事务不生效 | 测试事务包住了被测方法，掩盖了同类自调用、异常被吞等导致的事务失效 | 关键事务流程用不带测试事务的集成测试验证 |

一句话：**测试事务适合 Repository 与单层逻辑；验证真实事务边界时去掉测试事务，自己管理数据清理。**

---

## 七、异步、定时与日志输出

### 1、@Async：用 Awaitility 等待结果

`@Async` 方法在另一个线程执行，测试方法返回时它可能还没跑完；不要用 `Thread.sleep` 赌时间，用 Awaitility 轮询断言（`@Async` 本身的配置见 [异步任务与定时任务](./9_async_schedule)）：

```java
import java.time.Duration;

import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;

@SpringBootTest
class OrderNotifyTests {

    @Autowired
    OrderService orderService;

    @MockitoBean
    SmsClient smsClient;

    @Test
    void sendSmsAfterPaid() {
        orderService.markPaid(1001L);   // 内部异步发短信

        await().atMost(Duration.ofSeconds(5))
               .untilAsserted(() -> verify(smsClient).send(eq("13800000000"), anyString()));
    }
}
```

`atMost` 只是上限，条件满足即刻返回，不会白等。

### 2、@Scheduled：测逻辑，不测调度器

- 定时任务的业务逻辑抽成普通方法，在单元测试里直接调用，不等 cron 触发
- 把 `@EnableScheduling` 放到单独的配置类，并用属性开关（如 `@ConditionalOnProperty`）控制，测试环境关闭，避免任务在集成测试中途触发、污染数据
- 真要验证「会被调度」，在专门的测试里把 cron 调到每秒一次，再用 Awaitility 等待副作用出现

### 3、捕获日志与控制台输出

```java
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

@ExtendWith(OutputCaptureExtension.class)
class AuditLogTests {

    @Test
    void writeAuditLog(CapturedOutput output) {
        new AuditLogger().log("u1", "login");
        assertThat(output).contains("action=login");
    }
}
```

可用于验证告警日志、脱敏效果（`doesNotContain` 手机号原文）等。

---

## 八、上下文缓存与测试提速

### 1、上下文缓存的工作方式

Spring TestContext 把加载过的 `ApplicationContext` 缓存在 JVM 静态变量里，配置相同的测试类直接复用，启动成本只付一次。缓存键由这些内容组成：

- `@ContextConfiguration` 的 classes / locations / initializers 与 contextLoader
- `@ActiveProfiles`
- `@TestPropertySource` 与 `@SpringBootTest(properties = ...)`
- `ContextCustomizer`：`@MockitoBean`、`@MockitoSpyBean`、`@TestBean`、`@DynamicPropertySource`，以及 `@AutoConfigureMockMvc` 等 Boot 测试特性
- `@ContextHierarchy` 的父上下文

缓存默认最多 32 个，按 LRU 淘汰（`spring.test.context.cache.maxSize` 可调）。Framework 7 起，暂时用不到的缓存上下文会被暂停（停止定时任务、消息监听等生命周期组件），用到时再恢复，减少后台资源争抢（JVM 系统属性 `spring.test.context.cache.pause`，取值 `always` / `on_context_switch`（默认）/ `never`）。

### 2、什么会打破缓存

| 行为 | 后果 |
|------|------|
| 每个测试类 Mock 不同的 Bean 组合 | 每种组合一个新上下文 |
| 同一 Bean 的 Mock 字段名不一致 | 也被视为不同上下文 |
| 各测试类零散写 `properties`、`@TestPropertySource` | 每种属性组合一个新上下文 |
| 混用多个 `@ActiveProfiles` | 每个 profile 组合一个新上下文 |
| `@DirtiesContext` | 用完就销毁，下一个测试重新启动 |
| 构建工具每个测试类单独 fork JVM | 静态缓存失效，等于完全没有缓存 |

### 3、提速清单

- 多写纯单元测试和切片测试，`@SpringBootTest` 只留给真正跨层的场景
- 为集成测试定义统一基类或组合注解（同一组 `@MockitoBean`、同一份 `@Import(ContainersConfig.class)`、同一个 profile），让它们共享一个上下文
- 避免 `@DirtiesContext`：被测试改坏的通常是 Bean 状态，改用数据清理或 Mock 自动重置解决
- 容器声明成 Bean 共享，不在每个类里各起一套
- 构建配置里保持测试类在同一 JVM 中运行（Surefire 默认 `reuseForks=true`，不要改成每类一个 fork）
- 开启 `org.springframework.test.context.cache` 的 DEBUG 日志，查看缓存命中情况，找出「意外多出来的上下文」

---

## 小结

- 测试分四层：纯单元测试 → 切片测试 → `@SpringBootTest` + Testcontainers → `RANDOM_PORT` 端到端，越往上越慢、越少；能不启动 Spring 就不启动
- Boot 4 基于 JUnit 6，测试支持按技术拆成 `spring-boot-starter-<技术>-test`，切片注解换包；`@SpringBootTest` 不再自动提供 MockMvc / TestRestTemplate，需要 `@AutoConfigureMockMvc`、`@AutoConfigureRestTestClient` 等显式声明
- 新代码用 `MockMvcTester`（6.2+）和 `RestTestClient`（7.0+），前者 AssertJ 风格，后者 Mock 与真实服务器两用
- `@MockBean` 在 Boot 4 已删除，改用 Framework 的 `@MockitoBean` / `@MockitoSpyBean`；它们参与上下文缓存键，Mock 组合要收敛
- Testcontainers 用 `@ServiceConnection` 免去手写连接属性，容器声明为 Bean 便于共享，同一份配置还能通过 `SpringApplication.from(...).with(...)` 用于本地开发
- 测试事务默认回滚，但 `RANDOM_PORT`、`REQUIRES_NEW`、异步线程中的写入不回滚；JPA 断言前记得 `flush()`
- 异步用 Awaitility 轮询断言，定时任务测逻辑不测调度器，日志用 `OutputCaptureExtension` 验证
- 测试套件慢，多半是上下文缓存被打碎：统一 Mock、属性、profile，少用 `@DirtiesContext`，别让每个测试类单独 fork

## 参考资料

- Spring Boot Testing：[https://docs.spring.io/spring-boot/reference/testing/index.html](https://docs.spring.io/spring-boot/reference/testing/index.html)
- Testing Spring Boot Applications：[https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html](https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html)
- Testcontainers 集成：[https://docs.spring.io/spring-boot/reference/testing/testcontainers.html](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html)
- Spring TestContext Framework：[https://docs.spring.io/spring-framework/reference/testing/testcontext-framework.html](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework.html)
- Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)

> 下一篇：[启动与部署优化](./14_startup) —— 测试跑稳之后，再看如何让应用启动更快、部署更稳。

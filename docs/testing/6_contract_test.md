---
description: 消费者驱动契约、Spring Cloud Contract、Pact 与 Broker、can-i-deploy
---

# 契约测试

> 前置阅读：[Mock 测试](./2_mock)、[集成测试](./3_integration_test)、[微服务设计模式](/microservices/2_patterns)

契约测试在端到端测试和 Mock 之间保证服务之间的接口兼容。本篇讲消费者驱动契约流程、Spring Cloud Contract 与 Pact JVM 的用法以及 Pact Broker 与 can-i-deploy，版本基线为 JDK 21、Spring Boot 4.0、Spring Cloud Contract **5.0.3**、Pact JVM **4.7.5**、pact-broker-cli 0.9。

---

## 一、契约测试解决什么问题

微服务之间的调用有两种常见测法，各有硬伤：

- **端到端测试**：把 billing-service、order-service 和它们的数据库全部部署起来跑真实调用。能发现问题，但慢、环境难维护，一个服务挂了所有用例都红，失败时也很难判断是谁的错
- **调用方自己 Mock 对方**：billing-service 用 WireMock 或 Mockito 模拟 order-service 的响应。快且稳定，但 Mock 是调用方「以为」的接口：order-service 把 `amount` 改名为 `totalAmount`，Mock 不会知道，测试照样全绿，上线后才报错

契约测试的思路是把「调用方以为的接口」写成一份双方都要遵守的契约：**调用方用契约生成的桩做测试，提供方用同一份契约验证自己的实现**。契约变了，双方的测试至少有一边会失败，而且都在各自的 CI 里、不需要把对方部署起来。

| 测试类型 | 验证什么 | 需要部署对方吗 | 速度 | 失败时能定位到 |
|----------|----------|----------------|------|----------------|
| 单元测试 | 本服务内部逻辑 | 否 | 毫秒级 | 具体方法 |
| 集成测试 | 本服务与数据库、MQ 的配合 | 否（用容器） | 秒级 | 本服务的某个组件 |
| 契约测试 | 两个服务对接口的理解一致 | 否 | 秒级 | 哪个交互、哪个字段不兼容 |
| 端到端测试 | 整条业务链路 | 是 | 分钟级 | 往往只知道「流程失败了」 |

契约测试不验证业务逻辑正不正确（那是提供方自己单元测试的事），只验证**请求和响应的结构与语义约定**：路径、方法、请求头、状态码、字段名和类型、哪些字段必有。

服务内部与数据库、中间件的配合见 [集成测试](./3_integration_test) 和 [Testcontainers](./5_testcontainers)。

---

## 二、消费者驱动契约

![消费者驱动契约流程](../assets/testing/contract-test-cdc-flow.svg)

契约由谁来写，决定了它的约束力。**消费者驱动契约**（Consumer-Driven Contract，CDC）让调用方提出契约：

1. **消费者写测试**：billing-service 在测试里声明「我会发这样的请求，期望收到包含这些字段的响应」，对着工具提供的 Mock 服务端运行，测试通过后产出契约文件
2. **契约交给提供方**：通过 Broker、制品库或 Git 仓库传递
3. **提供方验证**：order-service 在自己的 CI 中拉取所有消费者的契约，逐条把请求打到自己的实现上，比对响应是否满足契约
4. **部署前检查**：任何一方要部署时，先确认目标环境中对端的版本与自己的版本互相验证通过

CDC 带来的一个重要性质：**契约只包含消费者真正用到的字段**。order-service 的响应有 20 个字段，billing-service 只用 4 个，契约里就只有这 4 个。order-service 删除或改名其他 16 个字段时，验证照样通过；只有动到有人在用的字段才会失败。提供方因此能准确知道「这个字段还有谁在用」，放心演进接口。

两个常用工具的分工思路不同：

- **Spring Cloud Contract**：契约文件放在**提供方仓库**，由提供方生成测试和桩，消费者下载桩来测试。消费者通过给提供方仓库提 PR 来「驱动」契约
- **Pact**：契约由**消费者测试生成**，发布到 Pact Broker，提供方从 Broker 拉取验证。更贴近 CDC 的原意，也支持多语言

本篇示例中 billing-service（账单服务）调用 order-service 的 `GET /api/orders/{id}` 查询订单，并消费 order-service 发出的 OrderCreated 事件。

---

## 三、Spring Cloud Contract

::: warning 项目归属变化
2026 年 7 月 Spring 团队宣布把 Spring Cloud Contract 移交给其创始人维护，以 Stubborn Contract（stubborn.sh）的名义继续开发，仍为 Apache 2.0 开源。Spring Cloud 2025.1.0～2025.1.2 管理的是 5.0.x（最后一版为 2025.1.2 中的 5.0.3），**2025.1.3 起 `spring-cloud-dependencies` 不再包含它**，后续版本也不会再收录，因此下面的示例显式导入 `spring-cloud-contract-dependencies` 5.0.3。新项目或准备长期使用的项目，建议规划迁移到 Stubborn Contract，见本节第 5 小节。
:::

### 1、生产者：依赖与插件

order-service 引入验证器依赖和 Maven 插件。插件在 `generate-test-sources` 阶段读取 `src/test/resources/contracts` 下的契约，生成 JUnit 测试；在 `package` 阶段把契约转换成 WireMock 映射，打成 `-stubs.jar`：

```xml
<properties>
    <spring-cloud-contract.version>5.0.3</spring-cloud-contract.version>
</properties>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-contract-dependencies</artifactId>
            <version>${spring-cloud-contract.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>org.springframework.cloud</groupId>
        <artifactId>spring-cloud-starter-contract-verifier</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>

<build>
    <plugins>
        <plugin>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-contract-maven-plugin</artifactId>
            <version>${spring-cloud-contract.version}</version>
            <extensions>true</extensions>
            <configuration>
                <testFramework>JUNIT5</testFramework>
                <baseClassForTests>com.example.order.contract.ContractVerifierBase</baseClassForTests>
            </configuration>
        </plugin>
    </plugins>
</build>
```

`testFramework` 默认就是 `JUNIT5`（生成 Jupiter 测试，在 JUnit 6 平台上直接运行），`testMode` 默认 `MOCKMVC`，即生成的测试通过 RestAssured MockMvc 调用控制器，不启动真实服务器。

### 2、写契约：YAML 或 Groovy DSL

契约按消费者分目录存放，目录名会成为生成的测试类名（`contracts/billing` 生成 `BillingTest`）：

```yaml
# src/test/resources/contracts/billing/shouldReturnOrderById.yml
description: 账单服务按订单号查询订单
name: should_return_order_by_id
request:
  method: GET
  url: /api/orders/o-1001
  headers:
    Accept: application/json
response:
  status: 200
  headers:
    Content-Type: application/json
  body:
    id: o-1001
    customerId: c-2001
    amount: 99.90
    status: PAID
  matchers:
    body:
      - path: $.customerId
        type: by_regex
        value: "c-[0-9]+"
      - path: $.amount
        type: by_type
      - path: $.status
        type: by_regex
        value: "CREATED|PAID|CANCELLED"
```

```groovy
// src/test/resources/contracts/billing/shouldReturn404WhenOrderMissing.groovy
import org.springframework.cloud.contract.spec.Contract

Contract.make {
    description "订单不存在时返回 404"
    name "should_return_404_when_order_missing"
    request {
        method GET()
        url "/api/orders/o-404"
        headers {
            accept(applicationJson())
        }
    }
    response {
        status NOT_FOUND()
    }
}
```

`matchers` 决定验证的严格程度：没有匹配器的字段（如 `id`）要求值完全相等；`by_regex` 只要求符合正则；`by_type` 只要求类型一致。**对提供方而言，匹配器越宽松，契约越不脆弱**：客户号具体是多少不重要，格式对就行。

### 3、生产者：基类与生成的测试

生成的测试都继承基类，基类负责把被测控制器准备好，并把依赖的服务打桩成契约需要的状态：

```java
package com.example.order.contract;

import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;

import java.math.BigDecimal;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;

import com.example.order.OrderController;
import com.example.order.OrderService;
import com.example.order.OrderView;

import io.restassured.module.mockmvc.RestAssuredMockMvc;

public abstract class ContractVerifierBase {

    @BeforeEach
    void setUp() {
        OrderService orderService = mock(OrderService.class);
        given(orderService.findById("o-1001"))
                .willReturn(Optional.of(new OrderView("o-1001", "c-2001", new BigDecimal("99.90"), "PAID")));
        given(orderService.findById("o-404")).willReturn(Optional.empty());

        RestAssuredMockMvc.standaloneSetup(new OrderController(orderService));
    }
}
```

`./mvnw verify` 时插件在 `target/generated-test-sources/contracts` 下生成 `BillingTest`，每条契约对应一个 `validate_<契约名>` 方法：用 RestAssured MockMvc 发出契约中的请求，再逐项断言状态码、响应头，无匹配器的字段断言值相等，`by_regex` 字段断言匹配正则，`by_type` 字段断言类型。生成的代码不要手改，契约变了重新构建即可。

基类只用 `standaloneSetup` 装配控制器、Mock 掉服务层，契约测试就聚焦在「HTTP 层的输入输出」上，不连数据库，速度与单元测试相当。需要全局异常处理、序列化配置等 Spring 行为时，改用 `@WebMvcTest` 切片加 `RestAssuredMockMvc.mockMvc(mockMvc)`。

构建产物除了普通 jar，还有 `order-service-1.0.0-stubs.jar`，里面是契约原文和转换后的 WireMock 映射（`META-INF/<groupId>/<artifactId>/<version>/mappings/...`）。`./mvnw deploy` 把它和主 jar 一起发布到 Nexus / Artifactory。

### 4、消费者：Stub Runner

billing-service 引入 `spring-cloud-starter-contract-stub-runner`，测试时 Stub Runner 下载 order-service 的桩 jar，在指定端口启动 WireMock 并加载映射：

```java
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.contract.stubrunner.spring.AutoConfigureStubRunner;
import org.springframework.cloud.contract.stubrunner.spring.StubRunnerProperties;

@SpringBootTest(properties = "order-service.base-url=http://localhost:8091")
@AutoConfigureStubRunner(
        ids = "com.example:order-service:+:stubs:8091",
        stubsMode = StubRunnerProperties.StubsMode.LOCAL)
class OrderClientStubRunnerTest {

    @Autowired
    OrderClient orderClient;

    @Test
    void readsOrderFromProducerStub() {
        assertThat(orderClient.findOrder("o-1001"))
                .hasValueSatisfying(order -> {
                    assertThat(order.status()).isEqualTo("PAID");
                    assertThat(order.amount()).isEqualByComparingTo("99.90");
                });
    }

    @Test
    void returnsEmptyWhenOrderMissing() {
        assertThat(orderClient.findOrder("o-404")).isEmpty();
    }
}
```

被测的 `OrderClient` 是 billing-service 里基于 `RestClient` 的普通客户端，404 时返回 `Optional.empty()`：

```java
import java.math.BigDecimal;
import java.util.Optional;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;

public class OrderClient {

    private final RestClient restClient;

    public OrderClient(RestClient.Builder builder, String baseUrl) {
        this.restClient = builder.baseUrl(baseUrl).build();
    }

    public Optional<OrderSummary> findOrder(String orderId) {
        return Optional.ofNullable(restClient.get()
                .uri("/api/orders/{id}", orderId)
                .accept(MediaType.APPLICATION_JSON)
                .exchange((request, response) -> {
                    if (response.getStatusCode() == HttpStatus.NOT_FOUND) {
                        return null;
                    }
                    return response.bodyTo(OrderSummary.class);
                }));
    }

    public record OrderSummary(String id, String customerId, BigDecimal amount, String status) {
    }
}
```

`ids` 的格式是 `groupId:artifactId:版本:分类器:端口`，版本写 `+` 表示最新。`stubsMode` 决定从哪里取桩：

| 模式 | 来源 | 场景 |
|------|------|------|
| `CLASSPATH` | 测试 classpath 上的桩 jar（作为 test 依赖引入） | 版本固定、离线构建 |
| `LOCAL` | 本机 Maven 仓库 `~/.m2` | 本地联调：先在 order-service 执行 `mvn install` |
| `REMOTE` | `repositoryRoot` 指定的远程仓库 | CI 中拉取提供方已发布的桩 |

这个测试与第一节「自己 Mock 对方」的区别在于：桩来自 order-service 的契约，而 order-service 的 CI 已经用同一份契约验证过实现。order-service 改了字段却没改契约，它自己的生成测试会失败；改了契约，billing-service 下次拉到新桩时测试会失败，两边都无法悄悄破坏兼容。

### 5、契约放在哪里，以及迁移到 Stubborn

**契约的存放方式**有两种：放在提供方仓库（上面的做法，消费者给提供方提 PR 修改契约），或者放在一个所有团队共享的**契约仓库**里，提供方插件通过 `contractsMode`、`contractsRepositoryUrl` 从仓库拉取契约。服务多、团队多时，共享仓库便于集中评审；服务少时，放在提供方仓库最简单。

**迁移到 Stubborn Contract**：Stubborn 官方声明它「不是分叉也不是重写」，契约 DSL、验证器、Stub Runner 的工作方式保持不变，变化集中在坐标和包名：

| 项目 | Spring Cloud Contract | Stubborn Contract |
|------|-----------------------|-------------------|
| groupId | `org.springframework.cloud` | `sh.stubborn` |
| 验证器 starter | `spring-cloud-starter-contract-verifier` | `stubborn-contract-starter-verifier` |
| Stub Runner starter | `spring-cloud-starter-contract-stub-runner` | `stubborn-contract-starter-stub-runner` |
| Maven 插件 | `spring-cloud-contract-maven-plugin` | `stubborn-contract-maven-plugin` |
| BOM | `spring-cloud-contract-dependencies` | `stubborn-contract-dependencies` |
| Java 包 | `org.springframework.cloud.contract...` | `sh.stubborn.contract...` |

Stubborn 提供了 OpenRewrite 配方 `sh.stubborn.contract.migration.MigrateFromSpringCloudContract`（位于 `sh.stubborn:stubborn-contract-migration`），一次性替换依赖坐标、Java 包名和配置属性，并移除 JUnit 4 相关用法。它在 2026 年 8 月发布 0.1.0，目前仍是 0.x 版本，迁移前先在一个服务上试跑并对比生成的测试与桩。

---

## 四、Pact JVM

### 1、依赖

```xml
<!-- 消费者 billing-service -->
<dependency>
    <groupId>au.com.dius.pact.consumer</groupId>
    <artifactId>junit5</artifactId>
    <version>4.7.5</version>
    <scope>test</scope>
</dependency>

<!-- 提供方 order-service：Spring 7 / Spring Boot 4 用 spring7 模块 -->
<dependency>
    <groupId>au.com.dius.pact.provider</groupId>
    <artifactId>spring7</artifactId>
    <version>4.7.5</version>
    <scope>test</scope>
</dependency>
```

Pact JVM 4.7.x 需要 JDK 17+，对应 Pact 规范 V4。提供方的 Spring 集成按 Framework 大版本分了模块：`junit5spring` 编译自 Spring 5，`spring6` 对应 Spring 6，`spring7` 对应 Spring 7 / Boot 4。在 Boot 4 项目里误用 `junit5spring` 的 `MockMvcTestTarget`，运行时会因为 `MockHttpServletRequestBuilder` 的方法签名变化抛 `NoSuchMethodError`。

### 2、消费者测试

消费者测试分两部分：`@Pact` 方法声明期望的交互，`@Test` 方法让真实的 `OrderClient` 去调用 Pact 启动的 Mock 服务端：

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

import au.com.dius.pact.consumer.MockServer;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.dsl.PactDslWithProvider;
import au.com.dius.pact.consumer.junit5.PactConsumerTest;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.V4Pact;
import au.com.dius.pact.core.model.annotations.Pact;

@PactConsumerTest
@PactTestFor(providerName = "order-service", pactVersion = PactSpecVersion.V4)
class OrderClientPactTest {

    @Pact(consumer = "billing-service")
    V4Pact paidOrder(PactDslWithProvider builder) {
        return builder
                .given("order o-1001 exists and is paid")
                .uponReceiving("get order o-1001")
                    .method("GET")
                    .path("/api/orders/o-1001")
                    .headers("Accept", "application/json")
                .willRespondWith()
                    .status(200)
                    .headers(Map.of("Content-Type", "application/json"))
                    .body(new PactDslJsonBody()
                            .stringValue("id", "o-1001")
                            .stringMatcher("customerId", "c-\\d+", "c-2001")
                            .decimalType("amount", 99.90)
                            .stringMatcher("status", "CREATED|PAID|CANCELLED", "PAID"))
                .toPact(V4Pact.class);
    }

    @Pact(consumer = "billing-service")
    V4Pact missingOrder(PactDslWithProvider builder) {
        return builder
                .given("order o-404 does not exist")
                .uponReceiving("get missing order o-404")
                    .method("GET")
                    .path("/api/orders/o-404")
                .willRespondWith()
                    .status(404)
                .toPact(V4Pact.class);
    }

    @Test
    @PactTestFor(pactMethod = "paidOrder")
    void readsPaidOrder(MockServer mockServer) {
        OrderClient client = new OrderClient(RestClient.builder(), mockServer.getUrl());

        assertThat(client.findOrder("o-1001"))
                .hasValueSatisfying(order -> assertThat(order.status()).isEqualTo("PAID"));
    }

    @Test
    @PactTestFor(pactMethod = "missingOrder")
    void returnsEmptyForMissingOrder(MockServer mockServer) {
        OrderClient client = new OrderClient(RestClient.builder(), mockServer.getUrl());

        assertThat(client.findOrder("o-404")).isEmpty();
    }
}
```

- `@PactConsumerTest` 等价于 `@ExtendWith(PactConsumerTestExt.class)`；`pactVersion` 显式写成 V4，让 Mock 服务端与生成的契约文件都按 Pact 规范 V4 处理，与 `@Pact` 方法返回的 `V4Pact` 保持一致
- `given(...)` 是**提供方状态**：一段双方约定的文字，提供方验证时据此准备数据。它描述前提，不描述实现
- `stringMatcher`、`decimalType` 等匹配器与 Spring Cloud Contract 的 `by_regex`、`by_type` 作用相同，示例值只用于 Mock 响应
- 如果 `OrderClient` 实际发出的请求与声明不符（路径拼错、少了请求头），或者声明的交互没有被调用，测试失败，契约不会生成

测试通过后，Maven 项目在 `target/pacts/billing-service-order-service.json` 生成契约文件（Gradle 为 `build/pacts`）。文件按 V4 规范记录每条交互的类型（`Synchronous/HTTP`、`Asynchronous/Messages`）、提供方状态、请求、响应示例和 `matchingRules`（如 `$.customerId` 的正则），这份 JSON 就是要交给提供方验证的契约。

### 3、提供方验证

order-service 加载契约，为每条交互生成一个测试，按提供方状态准备数据后回放请求。下面先用本地目录加载，便于理解：

```java
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;

import java.math.BigDecimal;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestTemplate;
import org.junit.jupiter.api.extension.ExtendWith;

import com.example.order.OrderController;
import com.example.order.OrderService;
import com.example.order.OrderView;

import au.com.dius.pact.provider.junit5.PactVerificationContext;
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.State;
import au.com.dius.pact.provider.junitsupport.loader.PactFolder;
import au.com.dius.pact.provider.spring.spring7.Spring7MockMvcTestTarget;

@Provider("order-service")
@PactFolder("pacts")
class OrderProviderPactTest {

    private final OrderService orderService = mock(OrderService.class);

    @BeforeEach
    void setUp(PactVerificationContext context) {
        Spring7MockMvcTestTarget target = new Spring7MockMvcTestTarget();
        target.setControllers(new OrderController(orderService));
        context.setTarget(target);
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verifyPact(PactVerificationContext context) {
        context.verifyInteraction();
    }

    @State("order o-1001 exists and is paid")
    void paidOrderExists() {
        given(orderService.findById("o-1001"))
                .willReturn(Optional.of(new OrderView("o-1001", "c-2001", new BigDecimal("99.90"), "PAID")));
    }

    @State("order o-404 does not exist")
    void orderMissing() {
        given(orderService.findById("o-404")).willReturn(Optional.empty());
    }
}
```

- `@PactFolder("pacts")` 从测试 classpath 的 `pacts` 目录加载契约，演示时把消费者生成的 JSON 复制到 `src/test/resources/pacts` 即可
- `@Provider` 的名字必须与消费者 `@PactTestFor(providerName)` 一致，否则加载不到契约
- `@State` 方法的文字与消费者 `given(...)` 逐字匹配；找不到对应的状态方法时验证失败
- `Spring7MockMvcTestTarget` 用 MockMvc 直接调用控制器，不占端口；要验证过滤器、安全配置等完整链路时，改用 `@SpringBootTest(webEnvironment = RANDOM_PORT)` 加 `HttpTestTarget("localhost", port)`，在状态方法里往测试库写数据

### 4、接入 Pact Broker

本地目录只适合演示。真实项目通过 **Pact Broker**（开源，可用 `pactfoundation/pact-broker` 镜像自建）或其托管版 PactFlow 交换契约。Broker 记录每个契约来自消费者的哪个版本和分支、被提供方的哪个版本验证过、各环境当前部署了哪些版本，从而回答「这两个版本能不能一起上线」。

提供方改为从 Broker 加载，并用**消费者版本选择器**决定验证哪些契约：

```java
import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.loader.PactBroker;
import au.com.dius.pact.provider.junitsupport.loader.PactBrokerAuth;
import au.com.dius.pact.provider.junitsupport.loader.PactBrokerConsumerVersionSelectors;
import au.com.dius.pact.provider.junitsupport.loader.SelectorBuilder;

@Provider("order-service")
@PactBroker(
        url = "${pactbroker.url}",
        authentication = @PactBrokerAuth(token = "${pactbroker.auth.token}"),
        providerBranch = "${pact.provider.branch}",
        enablePendingPacts = "true",
        includeWipPactsSince = "2026-01-01")
class OrderProviderBrokerPactTest {

    @PactBrokerConsumerVersionSelectors
    static SelectorBuilder consumerVersionSelectors() {
        return new SelectorBuilder()
                .mainBranch()
                .deployedOrReleased()
                .matchingBranch();
    }

    // setUp、verifyPact 与 @State 方法同上
}
```

| 配置 | 含义 |
|------|------|
| `mainBranch()` | 每个消费者主干分支上的最新契约 |
| `deployedOrReleased()` | 每个消费者当前已部署到各环境的版本的契约，保证不会破坏线上的调用方 |
| `matchingBranch()` | 与提供方当前分支同名的消费者分支，便于双方在同名特性分支上协同开发 |
| `enablePendingPacts` | 提供方从未验证通过的新契约标记为 pending，验证失败不让提供方构建变红，避免消费者的新需求阻塞提供方 |
| `includeWipPactsSince` | 把该日期之后新出现、尚未被选择器选中的契约也纳入验证（WIP），提前暴露问题 |

验证结果需要回传 Broker，在测试 JVM 上设置系统属性：`pact.verifier.publishResults=true`、`pact.provider.version`（建议用 Git 提交 SHA）、`pact.provider.branch`。只在 CI 中开启回传，本地运行不要污染 Broker 的数据。

### 5、发布契约与 can-i-deploy

版本号统一用 Git 提交 SHA，分支用 Git 分支名，这是 Pact 官方推荐的做法：每个版本唯一对应一次构建。消费者流水线的关键步骤：

```yaml
# billing-service/.github/workflows/ci.yml（节选）
jobs:
  contract:
    runs-on: ubuntu-24.04
    env:
      PACT_BROKER_BASE_URL: ${{ vars.PACT_BROKER_BASE_URL }}
      PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: ./mvnw -B -ntp test
      - uses: pact-foundation/pact-broker-cli@v0.9.0
      - name: Publish pacts
        run: >
          pact-broker-cli publish target/pacts
          --consumer-app-version ${{ github.sha }}
          --branch ${{ github.head_ref || github.ref_name }}

  deploy-production:
    needs: contract
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    environment: production
    env:
      PACT_BROKER_BASE_URL: ${{ vars.PACT_BROKER_BASE_URL }}
      PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
    steps:
      - uses: pact-foundation/pact-broker-cli@v0.9.0
      - name: Can I deploy?
        run: >
          pact-broker-cli can-i-deploy
          --pacticipant billing-service
          --version ${{ github.sha }}
          --to-environment production
          --retry-while-unknown 12
          --retry-interval 10
      - name: Deploy
        run: ./deploy.sh production
      - name: Record deployment
        run: >
          pact-broker-cli record-deployment
          --pacticipant billing-service
          --version ${{ github.sha }}
          --environment production
```

- **can-i-deploy** 查询 Broker 的兼容矩阵：billing-service 的这个版本，是否与 production 环境中当前部署的 order-service 版本互相验证通过。没有通过或结果未知时返回非零退出码，流水线停在部署之前
- `--retry-while-unknown` 用于等待提供方的验证结果：消费者刚发布新契约时，提供方的验证可能还在跑
- **record-deployment** 告诉 Broker「这个版本已在 production」，`deployedOrReleased()` 选择器和后续的 can-i-deploy 都依赖这条记录，部署成功后一定要执行
- 提供方的流水线对称：运行验证测试并回传结果，部署前同样 `can-i-deploy --pacticipant order-service`，部署后 `record-deployment`
- 在 Broker 上配置 `contract_requiring_verification_published` 类型的 Webhook，消费者发布了需要验证的新契约时自动触发提供方的验证构建，不必等提供方下次提交代码

流水线的整体编排、环境与审批见 [CI/CD](/devops/2_ci_cd)。

---

## 五、两者怎么选

| 维度 | Spring Cloud Contract | Pact |
|------|-----------------------|------|
| 契约由谁产出 | 提供方仓库中的 YAML / Groovy 文件 | 消费者测试自动生成 |
| 语言生态 | JVM 为主（Stub Runner 也有 Docker 版供其他语言使用） | 多语言：Java、JS、Go、Python、.NET、Rust 等 |
| 契约交换 | Maven 制品库中的 stubs jar，或共享契约 Git 仓库 | Pact Broker / PactFlow |
| 部署安全检查 | 无内建机制，需要自己按版本管理桩 | can-i-deploy + 部署记录，开箱即用 |
| 提供方测试 | 插件生成的测试类，继承基类 | 运行时加载契约并回放，状态方法准备数据 |
| 消费者测试 | 用下载的 WireMock 桩 | 对 Pact Mock 服务端测试 |
| 项目状态 | 2026 年起移交 Stubborn Contract 维护 | Pact Foundation 持续维护 |

选择建议：

- **团队全是 Spring / JVM、已经在用 Spring Cloud Contract**：继续用，规划迁移到 Stubborn Contract，坐标与包名的替换有官方配方
- **多语言团队、或新引入契约测试**：优先 Pact，Broker 和 can-i-deploy 直接解决「两个版本能不能一起上线」这个最难的问题
- **调用方是外部客户、数量不可控**：CDC 不适用（你没法让外部客户写契约），改用 OpenAPI 规范 + 破坏性变更检查，见第七节

---

## 六、消息契约

异步消息同样有契约：OrderCreated 事件的字段被 billing-service 依赖，order-service 改名字段一样会悄悄破坏消费方。两个工具都支持消息契约，思路与 HTTP 相同，只是「请求 - 响应」换成了「触发 - 发出的消息」。

**Spring Cloud Contract** 的消息契约由提供方触发，`triggeredBy` 是基类中的方法名，生成的测试调用它后从目标通道接收消息并校验：

```yaml
# src/test/resources/contracts/events/orderCreated.yml
description: 订单创建后发布 OrderCreated 事件
label: order_created
input:
  triggeredBy: publishOrderCreated()
outputMessage:
  sentTo: order-created
  headers:
    contentType: application/json
  body:
    orderId: o-1001
    customerId: c-2001
    amount: 99.90
  matchers:
    body:
      - path: $.orderId
        type: by_regex
        value: "o-[0-9]+"
```

生成的测试通过 `ContractVerifierMessaging` 收消息，基类需要配置消息验证环境（`@AutoConfigureMessageVerifier`，以及 Spring Cloud Stream 测试绑定器、Kafka 或 RabbitMQ 的对应支持）。消费者侧用 Stub Runner 的 `StubTrigger.trigger("order_created")` 按 `label` 触发桩发出消息。

**Pact** 的消息契约用 V4 的异步消息交互。消费者声明期望收到的消息内容，测试只验证自己的消息处理逻辑能解析它，不需要真实的 Broker：

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import au.com.dius.pact.consumer.MessagePactBuilder;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.junit5.PactConsumerTest;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.consumer.junit5.ProviderType;
import au.com.dius.pact.core.model.PactSpecVersion;
import au.com.dius.pact.core.model.V4Interaction;
import au.com.dius.pact.core.model.V4Pact;
import au.com.dius.pact.core.model.annotations.Pact;

@PactConsumerTest
@PactTestFor(providerName = "order-service", providerType = ProviderType.ASYNCH,
        pactVersion = PactSpecVersion.V4)
class OrderCreatedEventPactTest {

    @Pact(consumer = "billing-service")
    V4Pact orderCreated(MessagePactBuilder builder) {
        return builder
                .expectsToReceive("an OrderCreated event")
                .withMetadata(Map.of("contentType", "application/json"))
                .withContent(new PactDslJsonBody()
                        .stringMatcher("orderId", "o-\\d+", "o-1001")
                        .stringType("customerId", "c-2001")
                        .decimalType("amount", 99.90))
                .toPact(V4Pact.class);
    }

    @Test
    void parsesOrderCreatedEvent(List<V4Interaction.AsynchronousMessage> messages) {
        byte[] payload = messages.get(0).getContents().getContents().getValue();
        JsonNode event = JsonMapper.builder().build().readTree(payload);

        assertThat(event.get("orderId").asString()).startsWith("o-");
    }
}
```

提供方用 `@PactVerifyProvider` 方法产出真实的消息内容供比对，测试目标换成 `MessageTestTarget`。同一份契约文件里同时有 HTTP 和消息交互时，在前面的 `OrderProviderPactTest` 中按交互类型切换目标，并增加产出消息的方法（`MessageTestTarget` 位于 `au.com.dius.pact.provider.junit5`，`PactVerifyProvider` 与 `MessageAndMetadata` 位于 `au.com.dius.pact.provider`）：

```java
@BeforeEach
void setUp(PactVerificationContext context) {
    if (context.getInteraction().isAsynchronousMessage()) {
        context.setTarget(new MessageTestTarget());
    } else {
        Spring7MockMvcTestTarget target = new Spring7MockMvcTestTarget();
        target.setControllers(new OrderController(orderService));
        context.setTarget(target);
    }
}

@PactVerifyProvider("an OrderCreated event")
MessageAndMetadata orderCreatedEvent() {
    OrderCreatedEvent event = new OrderCreatedEvent("o-1001", "c-2001", new BigDecimal("99.90"));
    byte[] payload = JsonMapper.builder().build().writeValueAsBytes(event);
    return new MessageAndMetadata(payload, Map.of("contentType", "application/json"));
}
```

`@PactVerifyProvider` 的描述与消费者 `expectsToReceive(...)` 逐字一致。这个方法应该调用生产代码里真正构造事件的逻辑（例如事件工厂或序列化器），而不是在测试里手写一个对象，否则验证的只是测试自己。消息的序列化格式（JSON、Avro、Protobuf）若已由 Schema Registry 管理兼容性，契约测试主要补充「消费者实际依赖哪些字段」这层信息，Kafka 侧的兼容策略见 [消息队列](/messaging/0_overview)。

---

## 七、与 OpenAPI 规范的关系

OpenAPI 规范和契约测试经常被放在一起比较，它们回答的是不同问题：

| | OpenAPI + 破坏性变更检查 | 消费者驱动契约 |
|---|---|---|
| 描述的是 | 提供方**提供了什么**：全部接口、全部字段 | 消费者**用了什么**：用到的交互和字段 |
| 能发现 | 删除接口、删除字段、新增必填参数等结构性破坏 | 某个消费者依赖的字段或行为被改动 |
| 不能发现 | 「这个字段有没有人用」；实现与规范是否一致需另行校验 | 没有消费者声明的部分 |
| 适用 | 对外开放的 API、消费者不可控 | 内部服务之间、消费者可协作 |

两者可以叠加：用 OpenAPI 作为接口文档与代码生成的来源，在 CI 中用 oasdiff 拦截结构性破坏（见 [API 文档 · CI 中的规范检查](/engineering/5_api_doc#六、ci-中的规范检查)），同时对内部调用方用 CDC 守住真实依赖。PactFlow 的双向契约测试（Bi-Directional Contract Testing）把这两者结合：提供方上传 OpenAPI 规范与自测结果，消费者上传 Pact 契约，由平台比对二者是否兼容，适合提供方不愿或不能运行 Pact 验证的场景。版本号与废弃策略见 [API 设计规范](/engineering/7_api_design_rule)。

OpenAPI 规范本身、代码生成和 oasdiff 破坏性变更检查见 [API 文档](/engineering/5_api_doc)。

---

## 八、落地关注点

### 1、契约写什么、不写什么

- **只写消费者依赖的东西**：用到的字段、必须的状态码、关键请求头。不要把提供方响应原样复制进契约，否则提供方任何无关改动都会打破契约
- **用匹配器代替具体值**：ID、时间戳、金额写类型或正则匹配，除非消费者确实依赖具体取值（例如状态枚举）
- **不测业务规则**：「金额超过 1 万要审批」是提供方单元测试的事。契约只关心「请求格式对时返回 200 且有这些字段」「订单不存在时返回 404」
- **覆盖消费者真正处理的错误分支**：消费者对 404、409 有不同处理逻辑时，为每个分支写一条交互；只是统一报错的分支不必逐一列出

### 2、提供方状态要可维护

状态名是双方共享的「接口」，用业务语言描述前提（`order o-1001 exists and is paid`），不要写实现细节（`insert row into orders table`）。提供方的状态方法尽量复用测试数据构建器，状态数量多了以后集中放在一个基类里维护。

### 3、兼容性规则

提供方演进接口时遵循「宽进严出」：

- 新增响应字段：安全，消费者契约不会要求「不能有多余字段」
- 新增可选请求参数：安全
- 删除或改名字段、改变类型、收紧取值范围：只有在所有消费者契约都不再依赖时才可以，can-i-deploy 会给出答案
- 必须破坏兼容时：先发布新字段或新版本接口，等消费者迁移并发布新契约后，再删除旧字段（扩展 - 迁移 - 收缩）

消费者也要做「宽容的读者」：反序列化时忽略未知字段（Spring Boot 默认的 Jackson 配置即如此），不要因为提供方多返回一个字段就失败。

### 4、CI 门禁与所有权

- 契约测试作为普通测试在每个 PR 上运行；提供方的验证失败、消费者 can-i-deploy 不通过，都应阻止部署
- 新契约用 pending 机制引入，避免消费者的新需求在提供方尚未实现时把提供方主干弄红
- 明确所有权：契约变更由消费者发起，提供方评审；共享契约仓库要有 CODEOWNERS
- 契约测试不能完全替代端到端测试：保留少量覆盖核心链路的冒烟测试，验证网关、鉴权、服务发现等契约覆盖不到的部分

---

## 小结

- 契约测试把「调用方以为的接口」固化成双方都要验证的契约，用秒级、互不依赖的测试替代大部分端到端测试，并能准确指出哪个交互、哪个字段不兼容
- 消费者驱动契约只包含消费者真正用到的字段，提供方因此能知道每个字段还有谁在用
- Spring Cloud Contract：契约放在提供方，插件生成测试和 stubs jar，消费者用 Stub Runner 加载桩；2026 年起移交 Stubborn Contract，Spring Cloud 2025.1.3 不再管理其版本，需显式导入 5.0.3 BOM 或迁移
- Pact JVM 4.7：消费者测试生成 V4 契约，提供方用 `@State` 准备数据回放验证；Boot 4 项目用 `spring7` 模块
- Pact Broker 记录契约、验证结果与部署记录，用版本选择器、pending、WIP 管理验证范围，can-i-deploy + record-deployment 构成部署门禁
- 消息契约与 HTTP 契约思路一致；对外 API 用 OpenAPI + oasdiff，内部服务用 CDC，两者互补

## 参考资料

- Spring Cloud Contract 参考文档：[Spring Cloud Contract Reference](https://docs.spring.io/spring-cloud-contract/reference/)
- Spring Cloud Contract 入门（生产者与消费者）：[Developing Your First Spring Cloud Contract-based Application](https://docs.spring.io/spring-cloud-contract/reference/getting-started/first-application.html)
- Spring Cloud 2025.1.0 发布说明：[Spring Cloud 2025.1.0 (aka Oakwood) has been released](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released/)
- Spring Cloud Contract 移交公告：[A New Home for Spring Cloud Contract: Transitioning to Stubborn.sh](https://spring.io/blog/2026/07/06/spring-cloud-contract-transition-to-stubbornsh/)
- Stubborn Contract 官网与迁移指南：[stubborn.sh](https://stubborn.sh)
- Pact 文档首页：[Pact Docs](https://docs.pact.io/)
- Pact JVM 项目（支持的 JDK、Spring 模块）：[pact-jvm](https://github.com/pact-foundation/pact-jvm)
- Pact JVM 消费者 JUnit 5：[JUnit 5 consumer](https://docs.pact.io/implementation_guides/jvm/consumer/junit5)
- Pact JVM 提供方 JUnit 5：[JUnit 5 provider](https://docs.pact.io/implementation_guides/jvm/provider/junit5)
- 版本号建议：[Versioning in the Pact Broker](https://docs.pact.io/getting_started/versioning_in_the_pact_broker)
- can-i-deploy：[Can I Deploy](https://docs.pact.io/pact_broker/can_i_deploy)
- pact-broker-cli：[Pact Broker CLI](https://docs.pact.io/implementation_guides/cli/pact-broker-cli)

> 下一篇：[性能测试](./7_performance_test)

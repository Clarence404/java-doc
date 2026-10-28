---
description: 测试边界、REST Assured、测试数据与临时环境、Playwright、Flaky 治理、CI 分层与拨测
---

# 接口自动化与端到端测试

> 前置阅读：[测试工程总览](./0_overview)、[集成测试](./3_integration_test)、[契约测试](./6_contract_test)

接口自动化与端到端测试通过 HTTP 或浏览器访问一套已经部署、正在运行的服务，验证用户真正走的那条路能不能走通。本篇讲工具选型、测试数据与环境、Playwright、不稳定测试治理、CI 分层与线上拨测，基线为 JUnit 6、Spring Boot 4、JDK 21。

---

## 一、定位：测的是跑起来的服务

### 1、在测试金字塔中的位置

在 [测试金字塔](./0_overview#三、测试分层与比例) 里，它们位于集成测试和契约测试之上：

- **接口自动化**：不经过界面，直接调用部署好的服务的 HTTP 接口，覆盖一条接口链路的成功、失败与权限场景。比 E2E 快得多、稳得多，用例数可以多一些
- **端到端（E2E）**：用真实浏览器模拟用户操作，从页面一直走到数据库、消息和下游服务。最接近用户，也最慢、最脆，只留关键路径

两者的共同点是**被测对象是一个独立运行的进程**：测试代码与应用不在同一个 JVM 里，不能注入 Bean、不能 Mock 内部类，只能通过对外接口观察结果。

### 2、和集成测试、契约测试的边界

| 维度 | 集成测试 | 契约测试 | 接口自动化 | 端到端测试 |
|------|----------|----------|------------|------------|
| 被测对象 | 应用 + 真实中间件（容器） | 两个服务之间的请求 / 响应格式 | 部署好的单个服务或一组服务 | 部署好的整套系统 + 前端 |
| 运行方式 | 测试与应用同 JVM，`@SpringBootTest` | 消费者生成契约，提供方回放验证 | 远程 HTTP 调用 | 浏览器驱动 |
| 依赖来源 | Testcontainers、WireMock | Stub / Mock Server | 环境里的真实服务，外部第三方用替身 | 环境里的真实服务 |
| 失败说明什么 | 某段代码与中间件协作有误 | 哪个字段被破坏 | 某个接口的行为或配置有误 | 「某处坏了」，要靠日志与链路定位 |
| 主文档 | [集成测试](./3_integration_test) | [契约测试](./6_contract_test) | 本篇 | 本篇 |

同一件事不在多层重复测：字段格式交给契约测试，SQL 与事务交给集成测试，接口自动化只验证「部署后的配置、网关、鉴权、跨服务调用」这些只有跑起来才能暴露的问题。`@SpringBootTest(RANDOM_PORT)` 启动应用再发 HTTP 请求，本质仍是集成测试，写法见 [Spring Boot 测试](/spring-boot/10_testing)。

---

## 二、接口自动化

### 1、工具选型：REST Assured 还是 RestTestClient

| 工具 | 适合场景 | 特点 |
|------|----------|------|
| REST Assured | 独立的接口自动化工程，测远程环境 | `given / when / then` 风格，JSON Path 断言、JSON Schema 校验、过滤器、日志都很成熟；与框架无关 |
| `RestTestClient`（Spring Framework 7） | 已经是 Spring 工程、想复用同一套断言 | 阻塞式，可绑定 MockMvc，也可用 `bindToServer()` 指向任意 URL；生态比 REST Assured 薄 |
| `WebTestClient` | WebFlux 应用 | 响应式，同样可以 `bindToServer()` 测远程服务 |

建议：**测远程环境的独立工程用 REST Assured**，它不需要 Spring 上下文，失败日志也更完整；应用内的 `RANDOM_PORT` 测试用 `RestTestClient`。下面的示例都基于 REST Assured。

### 2、依赖与配置

接口测试通常放在独立模块（如 `order-api-tests`），只依赖测试库，不依赖被测应用的代码：

```xml
<dependencies>
    <dependency>
        <groupId>io.rest-assured</groupId>
        <artifactId>rest-assured</artifactId>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>io.rest-assured</groupId>
        <artifactId>json-schema-validator</artifactId>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>org.junit.jupiter</groupId>
        <artifactId>junit-jupiter</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
```

版本交给 Spring Boot 的依赖管理（继承 `spring-boot-starter-parent` 或导入 `spring-boot-dependencies`），它管理了 REST Assured 和 JUnit 的版本。目标环境地址和账号从环境变量读，不写进代码：

```java
import io.restassured.RestAssured;
import io.restassured.builder.RequestSpecBuilder;
import io.restassured.filter.log.LogDetail;
import io.restassured.http.ContentType;
import io.restassured.specification.RequestSpecification;
import org.junit.jupiter.api.BeforeAll;

public abstract class ApiTestSupport {

    protected static RequestSpecification spec;

    @BeforeAll
    static void setUpSpec() {
        String baseUri = System.getenv().getOrDefault("API_BASE_URI", "http://localhost:8080");
        spec = new RequestSpecBuilder()
                .setBaseUri(baseUri)
                .setContentType(ContentType.JSON)
                .addHeader("Authorization", "Bearer " + TokenProvider.token())
                .addHeader("X-Test-Run", TestRun.id())   // 标记测试流量，便于日志检索与清理
                .build();
        // 只在失败时打印请求与响应，成功用例不刷屏
        RestAssured.enableLoggingOfRequestAndResponseIfValidationFails(LogDetail.ALL);
    }
}
```

### 3、鉴权：token 只取一次

每个用例都登录一次既慢又容易触发风控。做法是进程内缓存，过期前复用：

```java
import static io.restassured.RestAssured.given;

import java.time.Instant;

public final class TokenProvider {

    private static String token;
    private static Instant expiresAt = Instant.EPOCH;

    public static synchronized String token() {
        if (Instant.now().isAfter(expiresAt.minusSeconds(60))) {
            var resp = given()
                    .baseUri(System.getenv("AUTH_BASE_URI"))
                    .formParam("grant_type", "client_credentials")
                    .formParam("client_id", System.getenv("E2E_CLIENT_ID"))
                    .formParam("client_secret", System.getenv("E2E_CLIENT_SECRET"))
                    .post("/oauth2/token")
                    .then().statusCode(200)
                    .extract().jsonPath();
            token = resp.getString("access_token");
            expiresAt = Instant.now().plusSeconds(resp.getLong("expires_in"));
        }
        return token;
    }
}
```

- 测试账号是专用的，权限最小化，凭据放 CI 的 Secrets，不同环境用不同账号
- 越权场景（普通用户访问管理接口、A 用户查 B 的订单）准备多个身份，每个身份单独缓存 token
- token 不要打印到日志里；REST Assured 的日志过滤器可以用 `LogConfig.blacklistHeader("Authorization")` 屏蔽

### 4、完整示例：下单接口

```java
import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.*;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class OrderApiTest extends ApiTestSupport {

    private Long orderId;

    @Test
    void createOrder_thenQuery() {
        orderId = given(spec)
                .header("Idempotency-Key", TestRun.id() + "-create")
                .body("""
                      {"skuId": 10001, "quantity": 2, "couponCode": null}
                      """)
            .when()
                .post("/api/orders")
            .then()
                .statusCode(201)
                .time(lessThan(2000L))                          // 粗粒度兜底，不代替性能测试
                .body(matchesJsonSchemaInClasspath("schemas/order.json"))
                .body("status", equalTo("CREATED"))
                .body("items", hasSize(1))
                .body("totalAmount", equalTo("199.00"))
                .extract().jsonPath().getLong("id");

        given(spec)
            .when()
                .get("/api/orders/{id}", orderId)
            .then()
                .statusCode(200)
                .body("id", equalTo(orderId.intValue()))
                .body("status", equalTo("CREATED"));
    }

    @Test
    void createOrder_withoutStock_returns409() {
        given(spec)
                .body("""
                      {"skuId": 99999, "quantity": 1}
                      """)
            .when()
                .post("/api/orders")
            .then()
                .statusCode(409)
                .body("code", equalTo("STOCK_NOT_ENOUGH"));
    }

    @AfterEach
    void cleanUp() {
        if (orderId != null) {
            given(spec).delete("/test-support/orders/{id}", orderId);   // 见第三节：清理接口
        }
    }
}
```

断言写法的几个要点：

- **状态码 + 业务字段 + 结构**三层都断言：状态码说明协议层，`status` / `code` 说明业务结果，JSON Schema 说明结构没有被悄悄改掉
- **JSON Schema 放 `src/test/resources/schemas/`**，校验必填字段、类型、枚举值；REST Assured 的 `json-schema-validator` 模块基于 draft-04，Schema 文件按这个版本写。有 OpenAPI 文档时可以从中导出，避免两份定义不一致
- **只断言关心的字段**，不比对整个响应体，否则新增一个无关字段就会让所有用例失败
- 金额用字符串或 `BigDecimal` 比较，不用浮点数

### 5、数据驱动：@ParameterizedTest

同一个接口的多组输入，用 JUnit 6 的参数化测试表达，每组参数在报告里单独显示：

```java
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class OrderValidationApiTest extends ApiTestSupport {

    @ParameterizedTest(name = "[{index}] quantity={0} → {1} {2}")
    @CsvSource(textBlock = """
            0,    400, QUANTITY_INVALID
            -1,   400, QUANTITY_INVALID
            1000, 400, QUANTITY_EXCEEDS_LIMIT
            """)
    void rejectInvalidQuantity(int quantity, int status, String code) {
        given(spec)
                .body("""
                      {"skuId": 10001, "quantity": %d}
                      """.formatted(quantity))
            .when()
                .post("/api/orders")
            .then()
                .statusCode(status)
                .body("code", equalTo(code));
    }
}
```

用例多时改用 `@CsvFileSource(resources = "/cases/order-validation.csv", useHeadersInDisplayName = true)`，让测试同学直接维护 CSV；需要构造复杂对象时用 `@MethodSource`。参数化测试的通用写法见 [单元测试](./1_unit_test)。

---

## 三、测试数据与环境

### 1、固定测试环境与临时环境

| 方式 | 做法 | 优点 | 问题 |
|------|------|------|------|
| 固定测试环境 | 共享的 test / staging，见 [环境管理](/devops/6_env_management) | 与生产拓扑接近，搭建成本一次性 | 多人多流水线共用，数据互相污染；有人部署了半成品，全员失败 |
| 临时环境（ephemeral） | 每个 PR 在独立命名空间（如 `pr-123`）部署一套，跑完销毁 | 互不干扰、可并行，失败一定是本次改动引起的 | 部署耗时、占资源；依赖的其他服务需要固定版本或替身 |

常见组合：**PR 阶段在临时环境跑接口冒烟，合并后在固定 test 环境跑全量**，staging 只跑冒烟和回归，不让大批自动化用例长期占用预发。

### 2、数据准备与清理

在共享环境里，测试数据的原则是**自己造、自己用、自己删，不依赖别人留下的数据**：

- **通过接口造数**：优先调用业务接口或专用的测试支撑接口（只在非生产环境的 Profile 下注册）准备数据，比直接写库更不容易绕过业务规则
- **唯一前缀**：所有数据带上本次运行的 ID（`TestRun.id()`，如 CI 的 run id），用户名、订单备注等字段可以据此识别，即使清理失败也能按前缀批量删除
- **幂等 seed**：基础数据（商品、价格、测试账号）用幂等脚本初始化，「存在就跳过、不存在就插入」，每次运行前执行一遍，不怕重复跑
- **清理放在 `@AfterEach` / `@AfterAll`**，并配一个定时任务按前缀和创建时间兜底清理残留数据
- 断言不依赖全局计数，例如「列表总数为 10」在共享环境里必然不稳定，改成「列表中包含我刚创建的那条」

### 3、外部依赖用替身

支付、短信、物流这类第三方服务，测试环境里不能真调，也不能指望它们的沙箱永远可用：

- 在环境里部署 **WireMock** 作为第三方的替身，应用配置指向它；用例开始前通过 WireMock 的管理接口注册本用例需要的响应（成功、超时、失败）
- 临时环境可以用 Testcontainers 的 WireMock 模块或直接部署 WireMock 镜像，写法见 [集成测试](./3_integration_test#_3、第三方-http-wiremock-模拟网关行为) 与 [Testcontainers](./5_testcontainers)
- 内部的其他微服务尽量用真实版本；跨团队依赖不稳定时，由契约测试保证兼容，E2E 里用固定版本的部署

### 4、时间与随机数可控

单元测试里注入 `Clock` 就能固定时间，但被测服务在另一个进程里，测试代码改不了它的时钟：

- 断言用相对时间，例如「创建时间在测试开始前后 1 分钟内」，不写死具体时刻
- 「30 分钟未支付自动关单」这类场景，在测试环境把超时配置调短，或提供仅测试 Profile 可用的「触发关单任务」接口，不要 `Thread.sleep` 等 30 分钟
- 验证码、随机优惠码在测试环境使用固定值或可查询的接口返回，避免用例靠读日志、读库来拿随机值

---

## 四、端到端测试：Playwright for Java

### 1、只覆盖关键路径

E2E 用例一条往往要几十秒，又受前端改版、网络、浏览器影响，数量必须克制：

- 只覆盖**一旦坏掉就直接损失收入或用户**的路径：登录、搜索下单支付、退款、核心配置保存
- 一条路径一两条用例，分支组合（各种优惠叠加、各种校验失败）交给接口自动化和单元测试
- 用例按「用户完成了什么」命名，例如 `userCanPayForOrder`，而不是按页面元素命名

### 2、依赖与第一个用例

```xml
<dependency>
    <groupId>com.microsoft.playwright</groupId>
    <artifactId>playwright</artifactId>
    <version>${playwright.version}</version>
    <scope>test</scope>
</dependency>
```

浏览器二进制需要单独安装，CI 中先执行 `mvn exec:java -e -Dexec.mainClass=com.microsoft.playwright.CLI -Dexec.args="install --with-deps chromium"`，或直接使用官方的 Playwright Java 镜像。

```java
import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

import com.microsoft.playwright.*;
import java.nio.file.Paths;
import org.junit.jupiter.api.*;

class CheckoutE2eTest {

    static Playwright playwright;
    static Browser browser;
    BrowserContext context;
    Page page;

    @BeforeAll
    static void launch() {
        playwright = Playwright.create();
        browser = playwright.chromium().launch();               // 默认无头
    }

    @BeforeEach
    void newContext() {
        // 每个用例一个独立上下文：Cookie、localStorage 互不影响
        context = browser.newContext(new Browser.NewContextOptions()
                .setBaseURL(System.getenv("WEB_BASE_URL"))
                .setStorageStatePath(Paths.get("target/auth/buyer.json")));  // 复用登录态
        context.tracing().start(new Tracing.StartOptions()
                .setScreenshots(true).setSnapshots(true).setSources(true));
        page = context.newPage();
    }

    @Test
    void userCanPayForOrder() {
        String orderId = TestData.createCartWithSku(10001);     // 通过接口造数，不走 UI

        page.navigate("/cart");
        page.getByTestId("checkout-button").click();
        page.getByTestId("pay-method-balance").check();
        page.getByTestId("submit-payment").click();

        assertThat(page.getByTestId("order-status")).hasText("已支付");
        assertThat(page).hasURL(java.util.regex.Pattern.compile(".*/orders/.+"));
    }

    @AfterEach
    void closeContext(TestInfo info) {
        String name = info.getDisplayName().replaceAll("\\W+", "_");
        context.tracing().stop(new Tracing.StopOptions()
                .setPath(Paths.get("target/playwright/" + name + "-trace.zip")));
        context.close();
    }

    @AfterAll
    static void close() {
        playwright.close();
    }
}
```

几点说明：

- **登录态复用**：在 `@BeforeAll` 或单独的准备步骤里用接口登录一次，把 `context.storageState()` 存成文件，后续上下文直接加载，不必每个用例都在页面上输入账号密码
- **造数走接口**：购物车、地址这些前置条件用 API 准备，UI 只操作要验证的那一段
- Playwright 1.45 起还提供了 `@UsePlaywright` 的 JUnit 扩展，可以自动注入 `Page`，手动管理生命周期更直观，便于加 trace

### 3、选择器：用 data-testid

| 选择器 | 稳定性 | 说明 |
|--------|--------|------|
| `getByTestId("submit-payment")` | 高 | 与样式、文案解耦，前端约定专门为测试保留的属性 |
| `getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))` | 较高 | 贴近用户感知，兼顾无障碍；文案改了要同步 |
| CSS 类名、`nth-child`、XPath 绝对路径 | 低 | 改个样式或调整布局就失效 |

`getByTestId` 默认匹配 `data-testid`，属性名可以通过 `playwright.selectors().setTestIdAttribute(...)` 修改。和前端约定：**关键交互元素必须带 `data-testid`，改名要在评审里说明**。

### 4、等待：交给自动等待

- Playwright 的操作（`click`、`fill`）会自动等待元素可见、可用、稳定后再执行，**不需要也不应该写 `Thread.sleep`**
- 断言用 `PlaywrightAssertions.assertThat(locator).hasText(...)`，它会在超时内重试直到满足；先 `textContent()` 取值再用 AssertJ 比较则只判断一次，是 flaky 的常见来源
- 依赖后端异步结果时，等待具体的信号：`page.waitForResponse(predicate, action)` 等待某个接口返回，或断言页面上出现最终状态
- 默认超时用 `page.setDefaultTimeout` 与 `PlaywrightAssertions.setDefaultAssertionTimeout` 统一配置，不在单个用例里随手加大

### 5、截图与 trace

![一个 E2E 用例的执行与产物](../assets/testing/api-e2e-execution-artifacts.svg)

- **trace**：记录每一步操作前后的 DOM 快照、截图、网络请求与控制台日志，失败后用 `show-trace` 命令或 trace.playwright.dev 打开回放，比看截图高效得多
- **截图**：`page.screenshot(new Page.ScreenshotOptions().setPath(...).setFullPage(true))`，一般只在失败时保存
- 产物体积不小，可以只保留失败用例的 trace：用例通过时调用 `tracing().stop()` 不传路径即可丢弃
- 页面请求带上 `traceparent` 或在报告中记录后端返回的 traceId，便于从失败用例跳到 [链路追踪](/observability/3_tracing)

---

## 五、不稳定测试治理

### 1、flaky 从哪里来

| 来源 | 典型表现 | 对策 |
|------|----------|------|
| 固定等待 | `sleep(2000)` 有时不够 | 等待具体条件：自动等待、Awaitility、`waitForResponse` |
| 共享数据 | 两条用例改了同一个账户余额 | 每个用例自己造数，带唯一前缀 |
| 环境不稳 | 有人同时在部署、下游服务重启 | 用例开始前检查健康接口；部署与测试串行 |
| 外部依赖 | 第三方沙箱偶发超时 | 替换为 WireMock |
| 顺序依赖 | 单独跑通过，一起跑失败 | 用例之间不共享状态，随机顺序跑一遍暴露问题 |
| 选择器脆弱 | 前端改版后大面积失败 | `data-testid` 约定 |

集成测试层的 flaky 治理思路相同，见 [集成测试](./3_integration_test#五、flaky-测试治理)。

### 2、重试的边界

- 重试是**止血手段**，不是修复：Failsafe 的 `-Dfailsafe.rerunFailingTestsCount=2` 会把「重跑后通过」的用例单独标记为 Flake，要把这个数字当成指标看，而不是让它静默消失
- 只对 E2E 和接口自动化开重试，单元测试和集成测试不重试
- **有副作用的用例重试前要确认幂等**：下单用例第一次其实成功了只是响应超时，重试会再下一单，断言也可能误判
- 连续多次需要重试才通过的用例，移入隔离标签（`@Tag("quarantine")`），不阻塞流水线，同时建工单限期修复

### 3、隔离与并行

- 并行的前提是用例之间零共享：独立账号、独立数据、独立浏览器上下文
- 接口用例可开启 JUnit 并行（`junit.jupiter.execution.parallel.enabled=true`），共享资源用 `@ResourceLock` 串行化；E2E 每个线程持有自己的 `Playwright` 实例，Playwright 对象不是线程安全的
- 并发度受被测环境容量限制，测试环境被打满时，失败的原因会变成「环境扛不住」

### 4、定位工具

- **测试报告**：JUnit XML + Allure 或 CI 自带的测试报告，按用例看历史通过率，找出「最近 30 次失败 3 次」的用例
- **请求日志**：REST Assured 失败时打印完整请求与响应；Playwright trace 里有全部网络请求
- **服务端证据**：测试流量带上 `X-Test-Run` 头或固定的用户标识，按它在日志平台里检索，再沿 traceId 看完整调用链

---

## 六、接入 CI/CD

### 1、分层执行

![分层测试在流水线中的位置](../assets/testing/api-e2e-pipeline-layers.svg)

| 阶段 | 跑什么 | 环境 | 时间预算 |
|------|--------|------|----------|
| PR | 接口冒烟：核心接口的成功路径，几十条以内 | 临时环境 | 5 分钟内 |
| 合并到 main | 接口自动化全量 + E2E 关键路径 | 固定 test 环境 | 30 分钟内 |
| 晋级 staging | E2E 冒烟 + 回归 | staging | 15 分钟内 |
| 发布到生产 | 部署后冒烟（只读或可回收的操作）+ 持续拨测 | 生产 | 几分钟 |

用 JUnit 的 `@Tag("smoke")`、`@Tag("regression")` 区分，Failsafe 通过 `-Dgroups=smoke` 选择执行。

### 2、在流水线里怎么接

- E2E 放在独立 Job，依赖部署 Job（`needs: deploy-staging`），只有部署成功才执行
- 目标地址用环境变量（`vars`）传入，测试账号凭据用 Secrets，不同环境各一套
- 浏览器先执行 Playwright CLI 的 `install --with-deps chromium`，或直接用官方 Playwright Java 镜像作为 Job 容器
- 执行命令只选本阶段的标签：`./mvnw -pl e2e-tests verify -Dgroups=smoke -Dfailsafe.rerunFailingTestsCount=1`
- `if: failure()` 时把 `target/playwright/` 下的 trace 与截图上传为构建产物

Job 编排、第三方 Action 固定到提交 SHA、Environment 审批、晋级同一个镜像 digest 的完整写法见 [CI/CD](/devops/4_ci_cd)。

### 3、报告与门禁

- **门禁按阶段定**：PR 冒烟失败不能合并；staging 冒烟失败不能晋级生产；生产冒烟失败触发回滚或人工确认
- **报告要能直达证据**：失败用例附带请求响应、截图、trace，评论到 PR 或推送到群里时给出产物链接
- **Flake 率进看板**：重跑次数、隔离用例数、套件耗时按周看趋势，持续上升说明测试在腐化

---

## 七、线上拨测与合成监控

发布后的冒烟只跑一次，线上拨测则**持续地、从用户侧**执行关键用例，发现「应用自己的指标看不出问题」的故障，例如 DNS、证书、网关、CDN 出错。

- **接口拨测**：Prometheus blackbox_exporter 探测 HTTP 状态码、TLS 证书有效期、响应时间；云厂商和 Grafana Synthetic Monitoring 支持多地域定时执行
- **浏览器拨测**：把 E2E 冒烟脚本改造成定时任务，或使用支持 Playwright 脚本的合成监控平台，覆盖登录、搜索等只读路径
- **只读或可回收**：线上拨测使用专用账号，不产生真实订单与资金流动；必须写入的场景用测试商户、测试 SKU，并在业务报表中排除
- **频率与地域**：关键接口 1 分钟一次，多个地域同时探测，连续多点失败才判定异常，避免单点网络抖动误报

拨测失败接入告警体系，作为「症状告警」直接通知值班，规则写法见 [告警](/observability/4_alerting)；拨测在 SLO 体系中的作用见 [可用性度量](/high-avail/1_sla_slo)。

---

## 八、常见反模式

| 反模式 | 后果 | 改进 |
|--------|------|------|
| 用 E2E 穷举业务分支 | 套件跑一小时、天天红，没人看结果 | 分支下沉到单元和接口测试，E2E 只留关键路径 |
| 用例依赖执行顺序（先跑注册，再跑登录） | 单独跑或并行跑就失败 | 每个用例自己准备前置数据 |
| 依赖环境里「现成」的数据 | 别人改了数据，用例莫名失败 | 自己造数、带前缀、自己清理 |
| 到处 `Thread.sleep` | 又慢又不稳 | 自动等待、等待具体条件 |
| 用 CSS 类名、XPath 定位 | 前端改样式就大面积失败 | `data-testid` 或 `getByRole` |
| 失败就重跑，直到绿 | 真实缺陷被重跑掉 | 重试次数作为指标，flaky 隔离并限期修复 |
| 断言整个响应体 | 加个字段全部失败 | 只断言关心的字段，结构交给 Schema |
| 凭据写在代码里、token 打进日志 | 泄露风险 | Secrets 注入，日志屏蔽 `Authorization` |
| 自动化在生产执行写操作 | 产生脏数据、真实扣款 | 线上只做只读或可回收操作，用专用测试账号 |

---

## 小结

- 接口自动化和 E2E 测的是部署好、独立运行的服务，负责发现配置、网关、鉴权、跨服务调用这些只有跑起来才暴露的问题；格式兼容交给契约测试，SQL 与事务交给集成测试
- 远程接口测试用 REST Assured，断言覆盖状态码、业务字段和 JSON Schema；token 进程内缓存，多组输入用 `@ParameterizedTest`
- 测试数据自己造、自己用、自己删，带唯一前缀，基础数据用幂等 seed；第三方用 WireMock 替身，时间靠配置和测试接口控制
- E2E 用 Playwright，只覆盖关键路径，选择器用 `data-testid`，等待交给自动等待和 Web-First 断言，失败靠 trace 回放
- 重试只是止血，Flake 率要进看板；PR 跑冒烟、合并后跑全量、发布后跑冒烟和持续拨测

## 参考资料

- REST Assured 使用指南：[Usage](https://github.com/rest-assured/rest-assured/wiki/Usage)
- REST Assured JSON Schema 校验：[JSON Schema Validation](https://github.com/rest-assured/rest-assured/wiki/Usage#json-schema-validation)
- Spring Framework `RestTestClient`：[RestTestClient](https://docs.spring.io/spring-framework/reference/testing/resttestclient.html)
- JUnit 参数化测试：[Parameterized Tests](https://docs.junit.org/current/user-guide/#writing-tests-parameterized-tests)
- Playwright for Java：[Getting started](https://playwright.dev/java/docs/intro)
- Playwright 定位器：[Locators](https://playwright.dev/java/docs/locators)
- Playwright 自动等待：[Auto-waiting](https://playwright.dev/java/docs/actionability)
- Playwright Trace Viewer：[Trace viewer](https://playwright.dev/java/docs/trace-viewer)
- Playwright CI：[Continuous Integration](https://playwright.dev/java/docs/ci)
- Maven Failsafe 重跑失败用例：[Rerun Failing Tests](https://maven.apache.org/surefire/maven-failsafe-plugin/examples/rerun-failing-tests.html)
- WireMock：[WireMock Documentation](https://wiremock.org/docs/)
- Prometheus blackbox_exporter：[GitHub 仓库](https://github.com/prometheus/blackbox_exporter)

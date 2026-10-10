---
description: 测试边界、依赖替代、测试数据隔离、Flaky 治理、Surefire / Failsafe 分离、并行与 CI
---

# 集成测试

> 前置阅读：[单元测试](./1_unit_test)、[Spring Boot 测试](/spring-boot/13_testing)

集成测试验证代码与数据库、缓存、消息等真实依赖能否正确协作。本篇讲测什么、依赖怎么替代、数据怎么管、为什么不稳定以及构建与 CI 里怎么跑，基线为 Spring Boot 4.x。

---

## 一、集成测试测什么

版本基线：JDK 21、Spring Boot 4.x（Spring Framework 7、JUnit 6）、Testcontainers 2.x、Maven Surefire / Failsafe 3.6。

示例统一用 order-service：下单写 PostgreSQL、订单缓存放 Redis、消费 Kafka 上的支付成功事件、调用第三方支付网关。

### 1、三种测试的分工

单元测试验证「我的代码逻辑对不对」，集成测试验证「我的代码和它依赖的东西接起来对不对」，端到端测试验证「整条业务链路对不对」。

| 维度 | 单元测试 | 集成测试 | 端到端测试 |
|------|----------|----------|------------|
| 范围 | 一个类或一小组类 | 一个服务 + 它的真实依赖（数据库、缓存、MQ） | 多个服务 + 前端 + 真实环境 |
| 依赖 | 全部用 Mock / 内存实现 | 自己能启动的用真实实例，外部系统用替身 | 全部真实 |
| 速度 | 毫秒级 | 秒级（容器启动一次后每个测试几十到几百毫秒） | 分钟级 |
| 失败时定位 | 精确到方法 | 精确到服务与依赖之间 | 只知道链路某处坏了 |
| 典型数量 | 最多 | 中等 | 最少，只覆盖核心路径 |

集成测试的价值集中在**跨进程边界**的地方，这些地方单元测试用 Mock 一替换就测不到了：

- **SQL 与数据库方言**：手写 SQL、JPA 生成的查询、`ON CONFLICT` / `FOR UPDATE SKIP LOCKED` 这类数据库特有语法、索引与唯一约束
- **事务边界**：传播行为、回滚规则、乐观锁冲突，以及「同类自调用导致 `@Transactional` 不生效」这种只有真实代理才会暴露的问题
- **序列化**：Redis 里存的 JSON、Kafka 消息的格式、HTTP 请求与响应的字段映射
- **消息收发**：消费者能否收到、失败是否按配置重试、重试耗尽是否进死信
- **配置与自动装配**：连接池、超时、序列化器等配置是否真的生效

![集成测试的边界](../assets/testing/integration-test-boundaries.svg)

### 2、边界划在哪里

一个实用的划分：**自己团队拥有、能在本地启动的依赖用真实实例；别人拥有、无法在本地启动的依赖用替身**。

- order-service 的 PostgreSQL、Redis、Kafka 由本服务独占或可以在容器里起一份 → 真实实例
- 第三方支付网关、短信服务商 → 用 WireMock 模拟 HTTP 行为，包括超时和错误码
- 公司内其他微服务（库存、用户） → 本服务的集成测试里用替身；两边接口是否对得上交给 [契约测试](./6_contract_test)，不要为了测 order-service 把库存服务也拉起来

Spring 项目里，集成测试通常是 `@SpringBootTest` 加载完整上下文；只想验证一层（Controller 绑定、Repository 查询）时用切片测试更快，两者的写法与取舍见 [Spring Boot 测试 · 测试分层](/spring-boot/13_testing)。

---

## 二、依赖怎么替代：三种方式

| 方式 | 例子 | 优点 | 问题 |
|------|------|------|------|
| 内存替身 | H2 代替 PostgreSQL、`@EmbeddedKafka`、嵌入式 Redis | 无需 Docker，启动快 | 方言、函数、锁行为与生产不同；「测试绿、上线红」 |
| 真实容器 | Testcontainers 启动 `postgres:17-alpine`、`apache/kafka` | 与生产同版本同行为；每次全新、互不干扰 | 需要 Docker；首次拉镜像慢 |
| 共享测试环境 | 连公司的 dev / test 数据库 | 不用本地资源 | 数据被别人改、并发跑互相踩；环境挂了测试全红 |

推荐顺序：**真实容器优先，内存替身只用于确实没有差异的场景，共享环境不用于自动化测试**。

H2 的问题不是「偶尔不兼容」，而是它会让你回避数据库特性：为了让测试通过，团队开始避免用 PostgreSQL 的 `jsonb`、部分索引、`SKIP LOCKED`，或者在 Flyway 脚本里写两套方言。用容器后这些顾虑都没有了。容器的启动、复用与提速技巧见 [Testcontainers](./5_testcontainers)。

Spring Boot 的 `@SpringBootTest`、切片测试、`@ServiceConnection` 见 [Spring Boot 测试](/spring-boot/13_testing)，容器本身的生命周期、等待策略和复用见 [Testcontainers](./5_testcontainers)，服务之间的接口兼容见 [契约测试](./6_contract_test)。

---

## 三、两个典型场景

### 1、统一的测试基类

先把所有集成测试共用的东西收拢到一处：同一组容器、同一个 profile、同一套清理逻辑。这样所有测试类命中同一个 Spring 上下文缓存，容器也只启动一次（原理见 [Spring Boot 测试 · 上下文缓存](/spring-boot/13_testing)）。

```java
// src/test/java/com/example/order/ContainersConfig.java
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.kafka.KafkaContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;

@TestConfiguration(proxyBeanMethods = false)
public class ContainersConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer postgres() {
        return new PostgreSQLContainer("postgres:17-alpine");
    }

    @Bean
    @ServiceConnection
    KafkaContainer kafka() {
        return new KafkaContainer("apache/kafka:4.1.0");
    }
}
```

```java
// src/test/java/com/example/order/AbstractIT.java
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@Import(ContainersConfig.class)
@ActiveProfiles("it")
public abstract class AbstractIT {

    @Autowired
    protected JdbcTemplate jdbc;

    @BeforeEach
    void cleanDatabase() {
        // 业务表清空并重置自增序列；flyway_schema_history 不动
        jdbc.execute("TRUNCATE TABLE order_status_log, order_item, orders RESTART IDENTITY CASCADE");
    }
}
```

```yaml
# src/test/resources/application-it.yaml
spring:
  kafka:
    consumer:
      auto-offset-reset: earliest   # 消费者晚于消息分配到分区时也能读到
```

不要在 `src/test/resources` 下放 `application.yaml`：它会遮住 `src/main/resources` 里的同名文件，导致主配置整个不生效。测试专用配置放在 profile 文件里。

### 2、消息消费：用 Awaitility 等结果

被测代码：order-service 消费支付成功事件，把订单置为已支付（消费者的可靠性配置见 [Kafka](/messaging/2_kafka)）。

```java
@Component
class PaymentEventListener {

    private final OrderService orderService;

    PaymentEventListener(OrderService orderService) {
        this.orderService = orderService;
    }

    @KafkaListener(topics = "payment-succeeded", groupId = "order-service")
    void onPaymentSucceeded(String orderNo) {
        orderService.markPaid(orderNo);   // 内部按订单状态做幂等
    }
}
```

消费发生在监听器线程里，测试方法发完消息就返回了，必须等待结果出现：

```java
import java.math.BigDecimal;
import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.KafkaTemplate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

class PaymentEventListenerIT extends AbstractIT {

    @Autowired
    KafkaTemplate<String, String> kafkaTemplate;

    @Autowired
    OrderRepository orderRepository;

    @Test
    void markOrderPaidWhenPaymentSucceeded() {
        String orderNo = "ORD-" + UUID.randomUUID();
        orderRepository.save(Order.created(orderNo, new BigDecimal("99.00")));

        kafkaTemplate.send("payment-succeeded", orderNo, orderNo);

        await().atMost(Duration.ofSeconds(10))
               .untilAsserted(() -> assertThat(orderRepository.findByOrderNo(orderNo))
                       .hasValueSatisfying(o -> assertThat(o.getStatus()).isEqualTo(OrderStatus.PAID)));
    }

    @Test
    void duplicateEventIsHarmless() {
        String orderNo = "ORD-" + UUID.randomUUID();
        orderRepository.save(Order.created(orderNo, new BigDecimal("99.00")));

        kafkaTemplate.send("payment-succeeded", orderNo, orderNo);
        kafkaTemplate.send("payment-succeeded", orderNo, orderNo);   // 模拟重复投递

        await().atMost(Duration.ofSeconds(10))
               .untilAsserted(() -> assertThat(jdbc.queryForObject(
                       "select count(*) from order_status_log where order_no = ? and status = 'PAID'",
                       Integer.class, orderNo)).isEqualTo(1));
    }
}
```

要点：

- **不要用 `Thread.sleep`**：睡短了偶发失败，睡长了拖慢整个套件；`atMost` 只是上限，条件满足立即返回
- **断言最终状态，而不是中间过程**：查数据库里的订单状态，比去拦截监听器方法更稳
- **订单号用 UUID**：即使清理遗漏或测试并行，也不会读到别的测试的数据
- 第二个测试验证「重复投递只生效一次」，这是 MQ 至少一次语义下必须有的保障，幂等设计见 [幂等性](/architecture/5_idempotence)

`@EmbeddedKafka`（spring-kafka-test）也能跑这个测试，但它和真实 Broker 的版本、配置不一定一致；已经在用 Testcontainers 时没有理由再引入它。

### 3、第三方 HTTP：WireMock 模拟网关行为

支付网关无法在本地运行，用 WireMock 起一个本地 HTTP 服务，按测试需要返回成功、错误码或超时。WireMock 3.x 的 Maven 坐标是 `org.wiremock:wiremock-standalone`（`test` 作用域），JUnit Jupiter 扩展在 `com.github.tomakehurst.wiremock.junit5` 包下。

```java
import java.math.BigDecimal;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;

class PaymentGatewayClientIT extends AbstractIT {

    @RegisterExtension
    static WireMockExtension gateway = WireMockExtension.newInstance()
            .options(wireMockConfig().dynamicPort())
            .build();

    @DynamicPropertySource
    static void gatewayProperties(DynamicPropertyRegistry registry) {
        registry.add("payment.gateway.base-url", gateway::baseUrl);
    }

    @Autowired
    PaymentGatewayClient client;

    @Test
    void chargeSucceeded() {
        gateway.stubFor(post("/v1/charges")
                .willReturn(okJson("{\"status\":\"SUCCEEDED\",\"txnId\":\"T-1\"}")));

        assertThat(client.charge("ORD-1", new BigDecimal("99.00"))).isEqualTo(ChargeResult.SUCCEEDED);
        gateway.verify(postRequestedFor(urlEqualTo("/v1/charges"))
                .withHeader("Idempotency-Key", equalTo("ORD-1")));
    }

    @Test
    void readTimeoutBecomesPending() {
        // 客户端读超时配置为 1 秒，网关 3 秒才响应
        gateway.stubFor(post("/v1/charges").willReturn(ok().withFixedDelay(3_000)));

        assertThat(client.charge("ORD-2", new BigDecimal("99.00"))).isEqualTo(ChargeResult.PENDING);
    }
}
```

超时、5xx、畸形响应这类「对方出问题」的场景，正是 WireMock 比真实沙箱环境更有用的地方：沙箱很难稳定地制造超时。

注意 `@DynamicPropertySource` 会参与上下文缓存键，这个类会得到一个独立的上下文。网关替身用到的地方多时，把 WireMock 也提到基类，或改成固定配置的 Bean。只测 `RestClient` 的请求与解析、不需要完整上下文时，`@RestClientTest` + `MockRestServiceServer` 更轻，见 [Spring Boot 测试 · 切片测试](/spring-boot/13_testing)。

---

## 四、测试数据管理

集成测试最大的不稳定来源是数据：上一个测试留下的行、并发测试插入的同名记录、手工改过的共享库。目标只有一个：**每个测试开始时看到的数据都是确定的**。

### 1、表结构：交给 Flyway

测试库的表结构与生产一样，用同一套 Flyway 迁移脚本创建：容器启动后 Boot 自动执行 `db/migration` 下的脚本。这顺带测试了迁移脚本本身，比 `spring.jpa.hibernate.ddl-auto=create` 可靠得多（后者建出来的表与线上不一致）。Flyway 的依赖与配置见 [数据库版本迁移](/spring-boot/4_flyway)。

测试专用的种子数据不要写进 `db/migration`，否则会被带到生产。可以放在只在测试 profile 生效的额外目录：

```yaml
# src/test/resources/application-it.yaml
spring:
  flyway:
    locations: classpath:db/migration,classpath:db/testdata
```

### 2、每个测试的数据隔离

| 策略 | 做法 | 适用 | 局限 |
|------|------|------|------|
| 测试事务回滚 | 测试方法加 `@Transactional`，结束自动回滚 | Repository、单层 Service | 管不到 `RANDOM_PORT` 请求、`@Async`、MQ 消费、`REQUIRES_NEW` 中的写入；还会掩盖事务失效问题 |
| 测试前清空 | `@BeforeEach` 执行 `TRUNCATE` | 跨线程、跨事务的完整流程 | 每个测试多一次 SQL；表多时要维护清单 |
| 唯一业务键 | 每个测试生成自己的订单号、用户 ID | 任何场景，尤其是并行 | 断言只能按键查，不能断言「表里共几行」 |
| `@Sql` 脚本 | 测试前执行指定 SQL 准备数据 | 需要固定基线数据的查询测试 | 脚本与实体变更容易脱节 |

测试事务回滚的具体陷阱（flush 时机、懒加载被掩盖、跨线程不回滚）在 [Spring Boot 测试 · 事务回滚语义与陷阱](/spring-boot/13_testing) 中有完整列表，这里不重复。对集成测试的建议是：

- **完整流程类测试不加测试事务**，在 `@BeforeEach` 里清空（前面基类的做法），再叠加唯一业务键
- **清理放在测试前而不是测试后**：测试失败时数据还留在库里，方便排查；也不怕上一个测试中途崩溃没执行清理
- **不要用 Flyway `clean` 做每测试清理**：它会删掉所有对象再重新迁移，慢一个数量级；Boot 默认也禁用了 `clean`（`spring.flyway.clean-disabled=true`）
- Redis、本地缓存同样要清：用 `RedisConnection.serverCommands().flushDb()`（或按前缀删除）和 `CacheManager` 逐个 `clear()`，否则缓存里的旧订单会让测试读到「不存在的数据」

### 3、准备数据：用构建器而不是长 SQL

```java
public final class OrderFixtures {

    private OrderFixtures() {
    }

    public static Order createdOrder() {
        return Order.created("ORD-" + UUID.randomUUID(), new BigDecimal("99.00"));
    }

    public static Order paidOrder() {
        Order order = createdOrder();
        order.markPaid();
        return order;
    }
}
```

测试里只写与本用例相关的字段，其余用合理默认值；实体加字段时只改这一处。准备数据走 Repository 或领域方法而不是直接 `INSERT`，可以保证准备出来的数据本身满足业务约束。

---

## 五、Flaky 测试治理

Flaky 测试指代码没变、结果时红时绿的测试。它的危害不在于那一次失败，而在于团队学会了「红了就重跑」，真正的回归也会被当成偶发问题放过。

### 1、常见原因与对策

| 原因 | 典型表现 | 对策 |
|------|----------|------|
| 依赖当前时间 | 跨零点、月末、夏令时那天失败 | 注入 `Clock`，测试里用固定时钟 |
| 异步未等待 | 本机快能过，CI 机器慢就失败 | Awaitility 轮询断言，禁止 `Thread.sleep` |
| 测试顺序依赖 | 单独跑能过，整体跑失败（或反之） | 每个测试自己准备数据；用随机顺序暴露依赖 |
| 共享状态 | 静态变量、单例缓存、Redis 中的残留 | 测试前清理；避免可变静态字段 |
| 固定端口 | 本机端口被占用、并行时冲突 | 一律用随机端口（Testcontainers 映射端口、WireMock `dynamicPort()`） |
| 时区与区域设置 | 开发机 UTC+8 能过，CI（UTC）失败 | 构建里固定 `-Duser.timezone`，代码中显式传 `ZoneId` |
| 集合无序 | `HashMap` / `HashSet` 遍历顺序变化 | 断言用 `containsExactlyInAnyOrder`，或在查询里明确 `ORDER BY` |
| 外部资源 | 拉镜像超时、连真实第三方 | 预拉镜像、固定镜像 tag；第三方一律替身 |

### 2、时间：注入 Clock

```java
@Configuration
class ClockConfig {

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}

@Service
class OrderTimeoutService {

    private static final Duration PAY_TIMEOUT = Duration.ofMinutes(30);

    private final Clock clock;

    OrderTimeoutService(Clock clock) {
        this.clock = clock;
    }

    boolean isPayTimeout(Order order) {
        return order.getCreatedAt().plus(PAY_TIMEOUT).isBefore(Instant.now(clock));
    }
}
```

集成测试里用 Framework 6.2+ 的 `@TestBean` 替换成固定时钟。它按字段名查找同名的静态工厂方法：

```java
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import org.springframework.test.context.bean.override.convention.TestBean;

class OrderTimeoutIT extends AbstractIT {

    @TestBean
    Clock clock;

    static Clock clock() {
        return Clock.fixed(Instant.parse("2026-10-01T10:00:00Z"), ZoneOffset.UTC);
    }

    // 测试中以固定时间为基准构造 createdAt，断言 29 分钟未超时、31 分钟超时
}
```

`@TestBean` 同样参与上下文缓存键，只在确实依赖时间的测试类里用；纯逻辑部分在单元测试里直接 `new OrderTimeoutService(fixedClock)` 更简单。

### 3、顺序：让依赖暴露出来

JUnit 的默认方法顺序是确定的但刻意不明显，测试之间的隐式依赖可能长期潜伏。定期（或在 CI 中）用随机顺序跑一次，把它们暴露出来：

```properties
# src/test/resources/junit-platform.properties
junit.jupiter.testmethod.order.default=org.junit.jupiter.api.MethodOrderer$Random
junit.jupiter.testclass.order.default=org.junit.jupiter.api.ClassOrderer$Random
```

默认种子取自 `System.nanoTime()`，只以 java.util.logging 的 `CONFIG` 级别记录，默认日志配置下看不到。更实用的做法是在 CI 中显式传入种子（例如用构建号），失败时用同一个值本地复现：

```bash
./mvnw verify -Djunit.jupiter.execution.order.random.seed=20261010
```

命令行上的 `-D` 属性会被 Surefire / Failsafe 作为系统属性传给测试 JVM，JUnit 从系统属性读取配置参数；也可以写在插件的 `<configurationParameters>` 里（见第七节）。

### 4、发现与隔离

- **重跑只用来识别，不用来掩盖**：Surefire / Failsafe 的 `rerunFailingTestsCount`（命令行 `-Dsurefire.rerunFailingTestsCount=2`、`-Dfailsafe.rerunFailingTestsCount=2`）会把「重跑后通过」的测试标记为 Flake，报告中记为 `flakyFailure`，构建仍然通过。把这些报告收集起来，就有了一份待修复的 Flaky 清单
- **隔离而不是删除**：确认是 Flaky 的测试打上 `@Tag("flaky")`，在主流水线中用 `<excludedGroups>flaky</excludedGroups>` 排除，另起一个定时任务单独跑；给它挂上负责人和期限，修好后移回
- **不要给整套测试开重跑**：重跑会让新引入的 Flaky 测试悄无声息地混进来

---

## 六、Maven：Surefire 与 Failsafe 分离

### 1、为什么要两个插件

![Maven 生命周期中的单元测试与集成测试](../assets/testing/integration-test-maven-lifecycle.svg)

| 插件 | 默认匹配 | 生命周期阶段 | 失败处理 |
|------|----------|--------------|----------|
| Surefire | `**/Test*.java`、`**/*Test.java`、`**/*Tests.java`、`**/*TestCase.java` | `test` | 立即让构建失败 |
| Failsafe | `**/IT*.java`、`**/*IT.java`、`**/*ITCase.java` | `integration-test` 运行，`verify` 判定 | 先记下失败，等 `post-integration-test` 执行完清理再在 `verify` 判定 |

分开的好处：

- `mvn test` 只跑单元测试，开发时几秒钟就有反馈；`mvn verify` 才跑集成测试
- Failsafe 在 `package` 之后运行，可以测试打好的 jar，并保证清理阶段一定执行
- 两类测试的报告分别输出到 `target/surefire-reports` 与 `target/failsafe-reports`，CI 中能分开统计耗时与失败

所以命名本身就是配置：**单元测试以 `Test` 结尾，集成测试以 `IT` 结尾**，前面的 `PaymentEventListenerIT`、`PaymentGatewayClientIT` 都遵守这个约定。

### 2、pom 配置

继承 `spring-boot-starter-parent` 时，parent 已经在 `pluginManagement` 中管理了两个插件的版本，并为 Failsafe 配好了 `integration-test` / `verify` 目标和 `classesDirectory`，在 `build/plugins` 中声明 Failsafe 即可启用（写法见 [构建工具 · 单元测试与集成测试分开跑](/engineering/1_build_tools)）。不用 parent（例如公司有统一父 POM、只导入 Boot BOM）时，完整配置如下：

```xml
<properties>
    <!-- 自定义开关：-DskipUTs=true 时只跳过单元测试 -->
    <skipUTs>false</skipUTs>
</properties>

<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-surefire-plugin</artifactId>
            <version>3.6.0</version>
            <configuration>
                <skipTests>${skipUTs}</skipTests>
                <excludedGroups>flaky</excludedGroups>
            </configuration>
        </plugin>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-failsafe-plugin</artifactId>
            <version>3.6.0</version>
            <configuration>
                <!-- spring-boot:repackage 之后 jar 结构变了，让 Failsafe 直接用编译输出目录 -->
                <classesDirectory>${project.build.outputDirectory}</classesDirectory>
                <excludedGroups>flaky</excludedGroups>
                <argLine>-Duser.timezone=UTC</argLine>
            </configuration>
            <executions>
                <execution>
                    <goals>
                        <goal>integration-test</goal>
                        <goal>verify</goal>
                    </goals>
                </execution>
            </executions>
        </plugin>
    </plugins>
</build>
```

`integration-test` 和 `verify` 两个目标缺一不可：只绑定 `integration-test` 时，集成测试失败了构建依然显示成功。

### 3、常用命令

```bash
./mvnw test                                   # 只跑单元测试
./mvnw verify                                 # 单元测试 + 集成测试
./mvnw verify -DskipUTs=true                  # 只跑集成测试（依赖上面的自定义开关）
./mvnw verify -DskipITs                       # 只跳过集成测试
./mvnw verify -Dit.test=PaymentEventListenerIT                    # 只跑一个集成测试类
./mvnw verify -Dit.test='PaymentEventListenerIT#duplicateEventIsHarmless'   # 只跑一个方法
```

`-Dit.test` 是 Failsafe 的过滤参数，Surefire 对应的是 `-Dtest`。同时还会跑全部单元测试；想只跑这一个 IT，再加 `-DskipUTs=true`。

### 4、Gradle 的对应做法

Gradle 没有 Failsafe，惯用做法是 [JVM Test Suite 插件](https://docs.gradle.org/current/userguide/jvm_test_suite_plugin.html)：声明一个 `integrationTest` 套件，源码放在 `src/integrationTest/java`，生成独立的 `integrationTest` 任务，再让 `check` 依赖它。效果与 Maven 相同：`./gradlew test` 只跑单元测试，`./gradlew check` 两者都跑。

---

## 七、并行执行

集成测试慢，第一反应往往是并行。但集成测试共享数据库、Kafka 主题和 Spring 上下文，盲目并行带来的 Flaky 比节省的时间更贵。建议按下面的顺序优化：

1. **先让上下文只启动一次**：统一基类、统一 Mock 组合、容器声明成 Bean 共享（第三节）。这一步通常收益最大
2. **再考虑进程级并行**：`forkCount` 大于 1 时每个 fork 是独立 JVM，有自己的 Spring 上下文和自己的一套容器，数据天然隔离；代价是内存和容器数量翻倍
3. **最后才是 JVM 内并行**：需要每个测试都用唯一业务键、不做 `TRUNCATE` 这类全局清理

### 1、进程级：forkCount

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-failsafe-plugin</artifactId>
    <configuration>
        <forkCount>2</forkCount>
        <reuseForks>true</reuseForks>
    </configuration>
</plugin>
```

`reuseForks` 必须保持 `true`（默认值）：设为 `false` 会每个测试类起一个新 JVM，Spring 上下文缓存完全失效。用 Testcontainers 时每个 fork 自动拿到自己的容器；如果连接的是预先建好的外部数据库，可以用 `${surefire.forkNumber}` 占位符（取值 1 到 forkCount）让每个 fork 连不同的库：

```xml
<systemPropertyVariables>
    <spring.datasource.url>jdbc:postgresql://it-db:5432/order_it_${surefire.forkNumber}</spring.datasource.url>
</systemPropertyVariables>
```

### 2、JVM 内：JUnit 并行执行

JUnit 的并行由配置参数控制，适合无共享状态的单元测试。把参数只写在 Surefire 的配置里，集成测试就不受影响：

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
    <configuration>
        <properties>
            <configurationParameters>
                junit.jupiter.execution.parallel.enabled = true
                junit.jupiter.execution.parallel.mode.default = same_thread
                junit.jupiter.execution.parallel.mode.classes.default = concurrent
            </configurationParameters>
        </properties>
    </configuration>
</plugin>
```

这组配置让不同测试类并发执行、同一类内的方法顺序执行，是最稳妥的起点。线程数默认按 CPU 核数动态计算（`config.strategy=dynamic`，系数 1.0）。

个别测试必须独占某个资源时，用注解声明，而不是关掉整个并行：

- `@ResourceLock(Resources.SYSTEM_PROPERTIES)`：修改系统属性的测试互斥执行，类似的还有 `TIME_ZONE`、`LOCALE`、`SYSTEM_OUT`
- `@ResourceLock("orders-table")`：自定义资源名，声明同一个名字的测试不会同时运行
- `@Isolated`：这个类运行时不允许任何其他测试并发

---

## 八、在 CI 中运行

### 1、流水线里的位置

集成测试应该在每个 PR 上跑，而不是只在夜间构建里跑：合并之后才发现的问题，修复成本和定位难度都高得多。完整的流水线编排见 [CI/CD](/devops/2_ci_cd)，集成测试相关的要点：

- **一次 `verify` 跑完两类测试**：项目不大时最简单，Failsafe 的失败会让 `verify` 失败、阻止合并
- **测试多时拆成两个 Job**：单元测试 Job 跑 `./mvnw test`，几分钟给出反馈；集成测试 Job 跑 `./mvnw verify -DskipUTs=true`，二者并行
- **Docker 可用性**：GitHub Actions 的 Ubuntu Runner 自带 Docker，Testcontainers 开箱即用；自建 Runner 运行在容器里时要处理 Docker-in-Docker 或挂载宿主 Docker Socket，具体见 [Testcontainers](./5_testcontainers)
- **固定镜像 tag**：容器镜像写明版本（`postgres:17-alpine` 而不是 `postgres:latest`），否则某天上游发布新版本，测试会在没人改代码的情况下变红
- **失败时保留报告**：`failsafe-reports` 里有每个测试的输出和堆栈，上传为构建产物

### 2、拆分 Job 的示例

```yaml
# .github/workflows/ci.yml（节选）
jobs:
  unit-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: ./mvnw -B -ntp test

  integration-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: ./mvnw -B -ntp verify -DskipUTs=true
      - name: 上传集成测试报告
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v7
        with:
          name: failsafe-reports
          path: target/failsafe-reports/
          retention-days: 7
```

两个 Job 都要设置 `timeout-minutes`：集成测试卡住（例如容器一直等不到就绪）时，不设超时会一直占着 Runner 直到默认的 6 小时上限。

### 3、观察测试套件本身

- 统计每个 IT 类的耗时，最慢的 10% 往往贡献了一半时间，常见原因是独立上下文（零散的 `@MockitoBean`、`@DynamicPropertySource`）和每个类各起一套容器
- 统计 Flake 次数（来自 `flakyFailure`），按测试排序，挂到团队看板上
- 集成测试总时长超过 10 分钟时，先排查上下文缓存，再考虑并行

---

## 小结

- 集成测试验证「自己的代码 + 真实依赖」能否接起来，价值集中在 SQL、事务、序列化、消息收发和配置这些跨进程边界的地方
- 自己能启动的依赖用真实容器，第三方系统用 WireMock 等替身，其他微服务交给契约测试；H2 和共享测试环境都不适合做自动化集成测试
- 所有集成测试共用一个基类（同一组容器、同一 profile、同一套清理），让 Spring 上下文只启动一次
- 异步结果用 Awaitility 等待，断言最终状态；MQ 消费要额外测重复投递
- 表结构用 Flyway 创建，测试前 `TRUNCATE` 加唯一业务键隔离数据；测试事务回滚只适合单层测试
- Flaky 的主要来源是时间、异步、顺序、共享状态和固定端口；注入 `Clock`、随机顺序暴露依赖，重跑只用来识别 Flaky，不用来掩盖
- Surefire 跑 `*Test`、Failsafe 跑 `*IT`，Failsafe 必须同时绑定 `integration-test` 和 `verify`；`mvn test` 快速反馈，`mvn verify` 跑全量
- 并行先做上下文共享，再考虑 `forkCount`，JVM 内并行只给无状态的单元测试；CI 中每个 PR 都跑集成测试，固定镜像 tag、设置超时、保留报告

## 参考资料

- Maven Failsafe Plugin：[Maven Failsafe Plugin 文档](https://maven.apache.org/surefire/maven-failsafe-plugin/)
- Failsafe 参数说明：[failsafe:integration-test](https://maven.apache.org/surefire/maven-failsafe-plugin/integration-test-mojo.html)
- 重跑失败测试与 Flake 报告：[Rerun Failing Tests](https://maven.apache.org/surefire/maven-surefire-plugin/examples/rerun-failing-tests.html)
- JUnit 并行执行：[Parallel Execution](https://docs.junit.org/current/writing-tests/parallel-execution.html)
- JUnit 测试执行顺序：[Test Execution Order](https://docs.junit.org/current/writing-tests/test-execution-order.html)
- Spring Boot 测试：[Testing Spring Boot Applications](https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html)
- Spring Boot 与 Testcontainers：[Testcontainers](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html)
- Spring Framework Bean 覆盖（`@TestBean`）：[Bean Overriding in Tests](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/bean-overriding.html)
- Testcontainers Kafka 模块：[Kafka Module](https://java.testcontainers.org/modules/kafka/)
- WireMock JUnit Jupiter 扩展：[JUnit 5+ Jupiter](https://wiremock.org/docs/junit-jupiter/)
- Awaitility：[Awaitility 使用指南](https://github.com/awaitility/awaitility/wiki/Usage)
- Gradle JVM Test Suite：[The JVM Test Suite Plugin](https://docs.gradle.org/current/userguide/jvm_test_suite_plugin.html)

> 下一篇：[TDD 测试驱动开发](./4_tdd)

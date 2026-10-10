---
description: 工作原理与 Ryuk、2.x 依赖与包名、JUnit 集成、等待策略、常用模块、单例与复用、CI 中的 Docker
---

# Testcontainers

> 前置阅读：[集成测试](./3_integration_test)、[Docker](/cloud-native/5_docker)

Testcontainers 通过 Docker API 为测试拉起真实的 PostgreSQL、Redis、Kafka、LocalStack。本篇用纯 JUnit 讲 2.x 的依赖与包名、容器生命周期、等待策略、单例与复用提速以及 CI 中的 Docker 配置，版本基线为 JDK 21、JUnit 6、Testcontainers **2.0.5**（Spring Boot 4.0 / 4.1 的依赖管理同为 2.0.5）。

---

## 一、为什么用真实容器

示例沿用 order-service：订单写 PostgreSQL、状态缓存放 Redis、事件发到 Kafka、发票存 S3。

集成测试要回答的问题是「我的代码和这个中间件配合得对不对」，替身回答不了这个问题。

| 方式 | 典型做法 | 能发现的问题 | 盲区 |
|------|----------|--------------|------|
| 内存替身 | H2 代替 PostgreSQL、嵌入式 Redis、`@EmbeddedKafka` | 基本 CRUD、序列化 | 方言、函数、锁、索引行为与生产不同；嵌入式 Redis 项目多已停更 |
| 共享测试环境 | 所有人连同一个 test 库 | 与真实环境一致 | 数据互相污染，环境一挂全体变红，无法并行 |
| Testcontainers | 每次测试拉起与生产同版本的容器 | 真实 SQL、约束、事务、协议细节 | 需要 Docker，首次拉镜像慢 |

Testcontainers 的价值在于三点：**版本与生产一致**（`postgres:17-alpine` 就是线上那个大版本）、**每次全新**（没有上次残留的数据）、**用完即删**（不污染开发机）。代价是启动时间和对 Docker 的依赖，这两点本篇第八、九节分别处理。

---

## 二、工作原理

![Testcontainers 运行时](../assets/testing/testcontainers-lifecycle.svg)

一次测试运行中发生的事：

1. **发现 Docker**：按「环境变量 → `~/.testcontainers.properties` → 本机默认 socket」的顺序找到 Docker 引擎，支持 Docker Engine、Docker Desktop、Podman（兼容 Docker API）以及远程 Docker
2. **启动 Ryuk**：先拉起一个 `testcontainers/ryuk` 容器，测试 JVM 与它保持一条 TCP 连接
3. **创建业务容器**：拉取镜像、按配置创建容器并打上本次会话的标签，容器端口映射到**主机的随机端口**，避免与本机已有服务或并行构建冲突
4. **等待就绪**：容器进程启动不等于服务可用，Testcontainers 按等待策略（第五节）确认就绪后才把控制权交给测试
5. **测试直连**：测试通过 `getHost()` 与 `getMappedPort(5432)` 拿到真实地址，流量不经过 Docker API
6. **清理**：测试结束时显式停止；即使 JVM 被 `kill -9`、IDE 强行终止，Ryuk 发现连接断开后也会删除带同一会话标签的容器、网络和卷

::: tip 端口永远别写死
容器内端口是固定的（PostgreSQL 5432），主机端口每次不同。任何地方都通过 `getMappedPort()` 或模块提供的 `getJdbcUrl()`、`getBootstrapServers()` 获取地址，不要在配置文件里写 `localhost:5432`。
:::

---

## 三、2.x 依赖与包名

### 1、Maven 依赖

用 BOM 统一版本（Spring Boot 项目已由父 POM 管理，可省略 BOM）：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.testcontainers</groupId>
            <artifactId>testcontainers-bom</artifactId>
            <version>2.0.5</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>org.testcontainers</groupId>
        <artifactId>testcontainers-junit-jupiter</artifactId>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>org.testcontainers</groupId>
        <artifactId>testcontainers-postgresql</artifactId>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
```

### 2、从 1.x 升级要改什么

2.0.0 于 2025 年 10 月发布，是一次「改名」为主的大版本：

| 变化 | 1.x | 2.x |
|------|-----|-----|
| 模块 artifact | `org.testcontainers:postgresql`、`kafka`、`junit-jupiter` | 统一加前缀：`testcontainers-postgresql`、`testcontainers-kafka`、`testcontainers-junit-jupiter` |
| 容器类包名 | `org.testcontainers.containers.PostgreSQLContainer` | 按模块分包：`org.testcontainers.postgresql.PostgreSQLContainer`、`org.testcontainers.kafka.KafkaContainer`、`org.testcontainers.localstack.LocalStackContainer` |
| 泛型 | `PostgreSQLContainer<?>` | 模块容器类不再带泛型参数：`PostgreSQLContainer` |
| 构造器 | 部分模块有无参构造（隐式使用默认镜像） | 无参构造全部删除，必须显式写镜像与 tag |
| JUnit 4 | `@Rule` / `@ClassRule` 支持 | 删除，只保留 JUnit Jupiter 扩展 |

`GenericContainer`、`Network`、`Wait` 等核心类仍在 `org.testcontainers.containers` 包下，用法不变。Docker Engine 29 把最低 API 版本提高到 1.44，老客户端会报「client version is too old」，至少升级到 2.0.2 才能兼容。

JUnit 6 沿用 Jupiter 编程模型和扩展 API，`testcontainers-junit-jupiter` 直接可用，无需额外适配。

---

## 四、JUnit 集成：@Testcontainers 与 @Container

### 1、第一个容器测试

被测代码是一个纯 JDBC 的订单仓储，测试真实验证 SQL、`RETURNING` 子句和 CHECK 约束：

```sql
-- src/test/resources/db/schema.sql
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id VARCHAR(64)    NOT NULL,
    amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    status      VARCHAR(16)    NOT NULL,
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
```

```java
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.sql.SQLException;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@Testcontainers(disabledWithoutDocker = true)
class JdbcOrderRepositoryTest {

    @Container
    static PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:17-alpine")
            .withDatabaseName("orders")
            .withInitScript("db/schema.sql");

    private JdbcOrderRepository repository;

    @BeforeEach
    void setUp() {
        repository = new JdbcOrderRepository(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }

    @Test
    void savesAndLoadsOrder() throws SQLException {
        long id = repository.save(new Order(null, "c-1001", new BigDecimal("99.90"), "CREATED"));

        assertThat(repository.findById(id))
                .hasValueSatisfying(order -> {
                    assertThat(order.customerId()).isEqualTo("c-1001");
                    assertThat(order.amount()).isEqualByComparingTo("99.90");
                });
    }

    @Test
    void rejectsNonPositiveAmount() {
        assertThatThrownBy(() ->
                repository.save(new Order(null, "c-1001", BigDecimal.ZERO, "CREATED")))
                .isInstanceOf(SQLException.class)
                .hasMessageContaining("orders_amount_check");
    }
}
```

- `@Testcontainers` 注册扩展，扩展扫描所有 `@Container` 字段并管理其启停
- `disabledWithoutDocker = true`：没有 Docker 的机器上跳过而不是失败，适合部分开发者本地没装 Docker 的团队；CI 上不要依赖它掩盖环境问题，也可以用方法级的 `@EnabledIfDockerAvailable`
- `withInitScript` 从 classpath 执行建表脚本；真实项目更推荐让 Flyway 执行迁移脚本，顺带测试迁移本身，见 [集成测试 · 测试数据管理](./3_integration_test#四、测试数据管理)
- 第二个用例能抓到 H2 很可能放过的问题：约束名、错误信息、`NUMERIC` 精度都是 PostgreSQL 的真实行为

### 2、static 与实例字段：生命周期不同

| 声明方式 | 启动时机 | 停止时机 | 适用 |
|----------|----------|----------|------|
| `static` 字段 | 类中第一个测试前 | 类中最后一个测试后 | 绝大多数场景，同一类共享一个容器 |
| 实例字段 | 每个测试方法前 | 每个测试方法后 | 需要绝对干净的容器，代价是每个方法都等一次启动 |
| 单例（第八节） | 第一次用到时 | JVM 退出时由 Ryuk 清理 | 多个测试类共享 |

`@Testcontainers(parallel = true)` 可以让同一类中的多个容器并行启动，缩短等待；它不改变上表的生命周期。官方说明扩展**不支持与 JUnit 的并行测试执行同时使用**，并行跑测试类时改用单例容器或进程级并行（见 [集成测试 · 并行执行](./3_integration_test#七、并行执行)）。

在 Spring Boot 里用 `@ServiceConnection` 自动注入连接信息、把容器声明成 Bean 共享、开发期用容器启动应用，见 [Spring Boot 测试 · Testcontainers 集成](/spring-boot/13_testing#五、testcontainers-集成)。

---

## 五、等待策略与启动超时

`GenericContainer` 默认等待第一个暴露端口可连接，最长 60 秒。端口能连上不代表服务能用：PostgreSQL 初始化期间会短暂监听又重启，HTTP 服务端口开了但应用还在加载。模块类（`PostgreSQLContainer`、`KafkaContainer` 等）已内置合适的策略，自己用 `GenericContainer` 时要选对等待方式。

| 策略 | 判定方式 | 适用 |
|------|----------|------|
| `Wait.forListeningPort()` | 暴露端口可连接（默认） | 启动即可用的简单服务 |
| `Wait.forHttp(path)` | HTTP 请求返回期望状态码或内容 | 有健康检查接口的服务 |
| `Wait.forLogMessage(regex, times)` | 日志出现指定内容若干次 | 启动完成会打日志的中间件 |
| `Wait.forHealthcheck()` | 镜像自带的 Docker `HEALTHCHECK` 变为 healthy | 镜像已定义健康检查 |
| `Wait.forSuccessfulCommand(cmd)` | 容器内执行命令返回 0 | 需要用客户端工具探测 |

```java
import java.time.Duration;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;

class WaitStrategyExamples {

    GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine")
            .withExposedPorts(6379)
            .waitingFor(Wait.forLogMessage(".*Ready to accept connections.*\\n", 1));

    GenericContainer<?> wiremock = new GenericContainer<>("wiremock/wiremock:3.13.2")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHttp("/__admin/health")
                    .forPort(8080)
                    .forStatusCode(200))
            .withStartupTimeout(Duration.ofSeconds(90));

    GenericContainer<?> withHealthcheck = new GenericContainer<>("order-service:1.4.0")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHealthcheck());
}
```

日志正则要匹配整行（Testcontainers 按行匹配，结尾带换行），所以写成 `.*关键字.*\\n`。CI 机器比开发机慢、首次还要拉镜像，启动超时宁可放宽到 90～120 秒，也不要让测试在冷启动时偶发失败。

---

## 六、常用模块

### 1、关系数据库

`testcontainers-postgresql`、`testcontainers-mysql` 等模块提供 `getJdbcUrl()`、`getUsername()`、`getPassword()`，默认库名 / 用户名 / 密码都是 `test`。另一种零代码方式是 **JDBC URL 驱动**：把 `jdbc:` 改成 `jdbc:tc:`，第一次建立连接时自动启动容器：

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;

import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.EnabledIfDockerAvailable;

@EnabledIfDockerAvailable
class JdbcUrlExampleTest {

    @Test
    void connectsThroughTcUrl() throws Exception {
        String url = "jdbc:tc:postgresql:17-alpine:///orders?TC_INITSCRIPT=db/schema.sql";
        try (Connection conn = DriverManager.getConnection(url);
             ResultSet rs = conn.createStatement().executeQuery("SELECT count(*) FROM orders")) {
            rs.next();
            assertThat(rs.getLong(1)).isZero();
        }
    }
}
```

URL 格式是 `jdbc:tc:<模块>:<镜像 tag>:///<库名>`，主机、端口和库名部分会被忽略；`TC_INITSCRIPT` 从 classpath 执行初始化脚本。默认在最后一个连接关闭时停止容器，加 `TC_DAEMON=true` 可让它一直存活到 JVM 退出。这种方式适合只需要一个数据源的老项目，改一行配置就能从 H2 切到真实数据库。

### 2、Redis

官方没有 Redis 专用模块，用 `GenericContainer` 即可（社区的 `com.redis:testcontainers-redis` 提供了集群、Redis Stack 等封装，需要时再引入）：

```java
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;

@Testcontainers
class OrderCacheRedisTest {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine")
            .withExposedPorts(6379)
            .waitingFor(Wait.forLogMessage(".*Ready to accept connections.*\\n", 1));

    @Test
    void cachesOrderStatusWithTtl() {
        String uri = "redis://" + redis.getHost() + ":" + redis.getMappedPort(6379);
        RedisClient client = RedisClient.create(uri);
        try (StatefulRedisConnection<String, String> conn = client.connect()) {
            RedisCommands<String, String> cmd = conn.sync();
            cmd.setex("order:o-1:status", 60, "PAID");

            assertThat(cmd.get("order:o-1:status")).isEqualTo("PAID");
            assertThat(cmd.ttl("order:o-1:status")).isBetween(1L, 60L);
        } finally {
            client.shutdown();
        }
    }
}
```

### 3、Kafka

`testcontainers-kafka` 里有两个类：`KafkaContainer` 对应 Apache 官方镜像 `apache/kafka` 与 GraalVM 原生版 `apache/kafka-native`（KRaft 模式，无 ZooKeeper），`ConfluentKafkaContainer` 对应 `confluentinc/cp-kafka` 7.4 及以上。新项目用前者，镜像版本与生产集群保持一致：

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.kafka.KafkaContainer;

@Testcontainers
class OrderEventKafkaTest {

    @Container
    static KafkaContainer kafka = new KafkaContainer("apache/kafka:4.1.2");

    @Test
    void publishesAndConsumesOrderCreatedEvent() throws Exception {
        Map<String, Object> producerProps = Map.of(
                ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers(),
                ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        try (var producer = new KafkaProducer<String, String>(producerProps)) {
            producer.send(new ProducerRecord<>("order-created", "o-1", "{\"orderId\":\"o-1\"}")).get();
        }

        Map<String, Object> consumerProps = Map.of(
                ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers(),
                ConsumerConfig.GROUP_ID_CONFIG, "order-test",
                ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest",
                ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class,
                ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        try (var consumer = new KafkaConsumer<String, String>(consumerProps)) {
            consumer.subscribe(List.of("order-created"));
            List<ConsumerRecord<String, String>> received = new ArrayList<>();
            long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
            while (received.isEmpty() && System.nanoTime() < deadline) {
                consumer.poll(Duration.ofMillis(500)).forEach(received::add);
            }
            assertThat(received).singleElement()
                    .satisfies(r -> assertThat(r.key()).isEqualTo("o-1"));
        }
    }
}
```

消费端循环 `poll` 而不是只调用一次：新消费者第一次 `poll` 可能还在加入消费组、分配分区，一次拿不到消息不代表消息没发出去。在 Spring 应用里测 `@KafkaListener` 时用 Awaitility 等待副作用，见 [集成测试 · 两个典型场景](./3_integration_test#三、两个典型场景)。

### 4、LocalStack：AWS 服务

`testcontainers-localstack` 用 LocalStack 在本地模拟 S3、SQS、DynamoDB 等服务。注意 2026 年 3 月起 `localstack/localstack` 镜像启动需要 `LOCALSTACK_AUTH_TOKEN`，缺少时容器无法启动，CI 中把 token 配成密钥变量：

```java
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.S3Object;

@Testcontainers
class InvoiceStorageS3Test {

    @Container
    static LocalStackContainer localstack = new LocalStackContainer("localstack/localstack:2026.9")
            .withServices("s3")
            .withEnv("LOCALSTACK_AUTH_TOKEN", System.getenv("LOCALSTACK_AUTH_TOKEN"));

    @Test
    void uploadsInvoicePdf() {
        try (S3Client s3 = S3Client.builder()
                .endpointOverride(localstack.getEndpoint())
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(localstack.getAccessKey(), localstack.getSecretKey())))
                .region(Region.of(localstack.getRegion()))
                .forcePathStyle(true)
                .build()) {

            s3.createBucket(b -> b.bucket("invoices"));
            s3.putObject(b -> b.bucket("invoices").key("o-1.pdf"), RequestBody.fromString("%PDF-1.7"));

            assertThat(s3.listObjectsV2(b -> b.bucket("invoices")).contents())
                    .extracting(S3Object::key)
                    .containsExactly("o-1.pdf");
        }
    }
}
```

关键是 `endpointOverride` 指向容器、凭证与区域取自容器；`forcePathStyle(true)` 让 S3 请求走 `endpoint/bucket` 路径形式，避免虚拟主机风格的域名解析问题。只用 S3 时，也可以考虑 MinIO 镜像（`testcontainers-minio` 模块），不需要 token。

### 5、Network：容器之间互通

测试代码访问容器走「主机 + 映射端口」，容器之间互访则走 Docker 网络和别名。典型场景是把被测服务的镜像和它的数据库一起拉起，做黑盒测试：

```java
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.postgresql.PostgreSQLContainer;

class NetworkExample {

    static Network network = Network.newNetwork();

    static PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:17-alpine")
            .withNetwork(network)
            .withNetworkAliases("db");

    static GenericContainer<?> orderService = new GenericContainer<>("order-service:1.4.0")
            .withNetwork(network)
            .withEnv("SPRING_DATASOURCE_URL", "jdbc:postgresql://db:5432/test")
            .withEnv("SPRING_DATASOURCE_USERNAME", "test")
            .withEnv("SPRING_DATASOURCE_PASSWORD", "test")
            .withExposedPorts(8080)
            .dependsOn(postgres)
            .waitingFor(Wait.forHttp("/actuator/health").forStatusCode(200));
}
```

容器之间用别名和**容器内端口**（`db:5432`），而不是映射端口；`dependsOn` 保证启动顺序。依赖更多时也可以用 `ComposeContainer` 直接复用 `compose.yaml`，但 Compose 文件里写死的端口和网络更容易与并行构建冲突，能用 `Network` 表达时优先用代码。

---

## 七、测试数据：每个测试看到确定的数据

容器在一个类甚至整个套件内共享时，数据隔离就要靠测试自己。常用三种做法，按隔离强度排列：

| 做法 | 实现 | 注意 |
|------|------|------|
| 每个测试前清表 | `@BeforeEach` 执行 `TRUNCATE ... RESTART IDENTITY CASCADE` | 简单可靠；不能与同一库上的并行测试共存 |
| 每个测试用唯一业务键 | 订单号、客户号带随机后缀，断言只查自己的数据 | 支持并行；断言不能写「表里只有一行」 |
| 事务回滚 | 测试在事务中执行，结束回滚 | 只适用于被测代码与测试共用一个连接 / 事务的场景，Spring 中的陷阱见 [Spring Boot 测试](/spring-boot/13_testing#六、事务回滚语义与陷阱) |

清表的写法见下一节的 `OrderQueryIT`。Kafka 主题无法「清空」，用每个测试独立的主题名或消费组，或者只断言带本测试唯一键的消息。数据策略的完整讨论（Flyway 建表、种子数据、并发隔离）见 [集成测试 · 测试数据管理](./3_integration_test#四、测试数据管理)。

集成测试该测什么、数据怎么隔离、Surefire / Failsafe 怎么分，见 [集成测试](./3_integration_test)。

---

## 八、提速：少启动、晚销毁

容器启动是集成测试最大的固定成本：PostgreSQL 约 1～3 秒，Kafka 约 5～10 秒，冷启动还要加上拉镜像时间。提速的思路是让一次 JVM 运行里每种容器只启动一次。

### 1、单例容器

在抽象基类的静态初始化块中手动 `start()`，所有子类共享同一个容器，JVM 结束时由 Ryuk 清理。注意**不要**再给它加 `@Container`，否则扩展会在每个测试类结束时把它停掉：

```java
import org.testcontainers.postgresql.PostgreSQLContainer;

public abstract class AbstractPostgresIT {

    protected static final PostgreSQLContainer POSTGRES =
            new PostgreSQLContainer("postgres:17-alpine")
                    .withDatabaseName("orders")
                    .withInitScript("db/schema.sql");

    static {
        POSTGRES.start();
    }
}
```

```java
import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OrderQueryIT extends AbstractPostgresIT {

    private final JdbcOrderRepository repository = new JdbcOrderRepository(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());

    @BeforeEach
    void cleanTables() throws SQLException {
        try (Connection conn = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement st = conn.createStatement()) {
            st.execute("TRUNCATE TABLE orders RESTART IDENTITY CASCADE");
        }
    }

    @Test
    void firstOrderGetsIdOne() throws SQLException {
        long id = repository.save(new Order(null, "c-2001", new BigDecimal("10.00"), "CREATED"));
        assertThat(id).isEqualTo(1L);
    }
}
```

Spring Boot 项目不需要手写单例：把容器声明为 `@Bean` 后由 Spring 管理生命周期，同一上下文缓存内天然只启动一次，见 [Spring Boot 测试 · Testcontainers 集成](/spring-boot/13_testing#五、testcontainers-集成)。

### 2、容器复用：跨多次运行保留容器

单例只能在一次 JVM 运行内共享。本地反复执行 `mvn test` 或在 IDE 里一遍遍点运行时，可以开启**复用**，让容器在测试结束后不删除，下次运行配置相同就直接接上：

第一步，在开发者自己的 `~/.testcontainers.properties`（Windows 为 `C:/Users/<用户名>/.testcontainers.properties`）中开启，也可以设置环境变量 `TESTCONTAINERS_REUSE_ENABLE=true`：

```properties
testcontainers.reuse.enable=true
```

第二步，容器声明 `withReuse(true)` 并手动启动：

```java
import org.testcontainers.postgresql.PostgreSQLContainer;

class ReusableExample {

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine")
            .withDatabaseName("orders")
            .withReuse(true);

    static {
        POSTGRES.start();
    }
}
```

复用的规则与限制：

- **只能在用户目录或环境变量里开启**，放在项目 classpath 的 `testcontainers.properties` 中不生效。这是有意设计：复用是开发者本机的选择，不应随代码进入 CI
- **不能与 `@Container` 或 `stop()` 一起用**：扩展或 try-with-resources 会在测试后停止容器，复用就失去意义
- **按配置哈希匹配**：镜像、环境变量、命令等任何一项变化都会新建容器；JDBC URL 方式需要加 `?TC_REUSABLE=true`
- **复用的容器不受 Ryuk 管理**，测试结束后一直运行，数据也保留，测试自己必须先清理数据；不用时手动 `docker rm -f` 删除
- 官方仍将其标记为实验特性，并明确**不适合 CI**：CI 每次都是全新环境，复用没有收益，还可能残留状态

### 3、其他提速手段

- **固定镜像 tag 并预拉取**：写 `postgres:17-alpine` 而不是 `latest`，CI 中可以在测试前 `docker pull`，或把镜像层缓存起来
- **私有镜像仓库代理**：公司网络访问 Docker Hub 慢或受限时，设置 `hub.image.name.prefix=registry.example.com/mirror/`（或环境变量 `TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX`），Testcontainers 会给所有 Docker Hub 镜像自动加前缀，代码里的镜像名不用改
- **选轻量镜像**：`-alpine` 变体、`apache/kafka-native` 启动更快
- **只在需要时启动**：单元测试不要继承集成测试基类；用 Failsafe 把带容器的测试分开，见 [集成测试 · Surefire 与 Failsafe 分离](./3_integration_test#六、maven-surefire-与-failsafe-分离)

---

## 九、在 CI 中让 Docker 可用

Testcontainers 只需要一个可访问的 Docker API。不同 CI 环境差别在于「Docker 在哪里」。

| 环境 | Docker 来源 | 要做的事 |
|------|-------------|----------|
| GitHub Actions `ubuntu-*` 托管 Runner | Runner 自带 Docker Engine | 无需配置，直接运行 |
| 自建 Runner，作业跑在容器中 | 挂载宿主机 `/var/run/docker.sock` | 测试启动的容器与作业容器是「兄弟」，需要时用 `TESTCONTAINERS_HOST_OVERRIDE` 指定宿主机地址 |
| GitLab CI Docker executor | `docker:dind` 服务 | 设置 `DOCKER_HOST` 指向 dind 服务 |
| Kubernetes 上的 Runner | DinD sidecar 或远程 Docker | 通常需要特权容器；或改用远端 Docker 环境 |
| 无 Docker 的环境 | Testcontainers Cloud | 安装其 agent 后容器在云端运行，测试代码不变 |

GitHub Actions 的完整流水线和集成测试 Job 拆分见 [集成测试 · 在 CI 中运行](./3_integration_test#八、在-ci-中运行)，这里不重复。GitLab CI 使用 Docker-in-Docker 的写法：

```yaml
# .gitlab-ci.yml（节选）
integration-test:
  image: eclipse-temurin:21-jdk
  services:
    - name: docker:dind
      command: ["--tls=false"]
  variables:
    DOCKER_HOST: "tcp://docker:2375"
    DOCKER_TLS_CERTDIR: ""
    DOCKER_DRIVER: overlay2
  script:
    - ./mvnw -B -ntp verify
```

- `--tls=false` 与清空 `DOCKER_TLS_CERTDIR` 一起关闭 TLS。新版 Docker 在不带 TLS 监听网络地址时会刻意延迟启动，不显式关闭会导致前几次 API 调用失败
- DinD 需要 Runner 以特权模式运行（`privileged = true`），这是官方把它称为「最后手段」的原因；能挂载宿主 socket 时优先挂载
- 挂载 socket 的方式下，若测试还要把本地文件挂进容器（`withFileSystemBind`），工作目录必须以相同路径挂进作业容器，否则宿主机上找不到该路径

### Ryuk 相关

- 某些环境（部分 Kubernetes、启用了 SELinux 的主机）中 Ryuk 需要特权才能访问 Docker socket，可在 `~/.testcontainers.properties` 中设置 `ryuk.container.privileged=true`
- 实在无法运行 Ryuk 时可设置 `TESTCONTAINERS_RYUK_DISABLED=true`，此时依赖 JVM 关闭钩子清理，进程被强杀会留下孤儿容器，只建议用于每次用完即销毁的临时 CI 环境
- `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` 用于 socket 不在默认路径的情况（如 rootless Docker、Podman），Ryuk 等辅助容器会据此挂载 socket

---

## 十、优缺点与适用边界

| 维度 | 评价 |
|------|------|
| 真实性 | 与生产同版本同行为，方言、约束、协议细节都能测到，是它最大的价值 |
| 隔离性 | 每次全新容器、随机端口，可并行构建，不污染共享环境 |
| 速度 | 比内存替身慢；单例 + 上下文缓存后，一个中型套件的容器总开销通常在十几秒量级 |
| 环境依赖 | 必须有 Docker；Windows / macOS 依赖 Docker Desktop 或兼容实现，CI 需要按上一节准备 |
| 资源 | Kafka、Elasticsearch 等容器占用数百 MB 到数 GB 内存，多 fork 并行时要算好 Runner 规格 |
| 覆盖范围 | 验证「我与中间件」的配合；「我与其他服务」的接口兼容交给 [契约测试](./6_contract_test)，完整业务链路交给少量端到端测试 |

---

## 小结

- Testcontainers 通过 Docker API 为测试拉起真实中间件，端口映射到主机随机端口，Ryuk 保证进程被强杀时也能清理容器
- 2.x 的模块 artifact 统一加 `testcontainers-` 前缀，容器类移到 `org.testcontainers.<模块>` 包下且不再带泛型，删除了 JUnit 4 支持；Docker Engine 29 需要 2.0.2 以上
- `@Testcontainers` + `@Container`：static 字段按类共享，实例字段每个方法重建；扩展不支持与 JUnit 并行执行同时使用
- 自定义容器要选对等待策略，CI 中放宽启动超时；地址一律取 `getHost()` / `getMappedPort()`
- PostgreSQL / MySQL / Kafka / LocalStack 用官方模块，Redis 用 `GenericContainer`；Kafka 新项目用 `apache/kafka` 镜像，LocalStack 现需 auth token
- 提速靠单例容器（Spring 项目用容器 Bean），本地反复运行可在 `~/.testcontainers.properties` 开启 `testcontainers.reuse.enable`，复用不进 CI
- CI 中托管 Runner 开箱即用，自建环境在挂载 socket 与 DinD 之间优先选前者

## 参考资料

- Testcontainers for Java 文档首页：[Testcontainers for Java](https://java.testcontainers.org/)
- 2.0.0 发布说明（artifact 改名、包迁移、移除 JUnit 4）：[Release 2.0.0](https://github.com/testcontainers/testcontainers-java/releases/tag/2.0.0)
- JUnit Jupiter 集成：[Jupiter / JUnit 5](https://java.testcontainers.org/test_framework_integration/junit_5/)
- 手动生命周期与单例容器：[Manual container lifecycle control](https://java.testcontainers.org/test_framework_integration/manual_lifecycle_control/)
- 等待策略：[Waiting for containers to start or be ready](https://java.testcontainers.org/features/startup_and_waits/)
- 容器复用：[Reusable Containers](https://java.testcontainers.org/features/reuse/)
- 配置项（Ryuk、Docker 地址、属性文件优先级）：[Custom configuration](https://java.testcontainers.org/features/configuration/)
- 镜像名替换与私有仓库前缀：[Image name substitution](https://java.testcontainers.org/features/image_name_substitution/)
- JDBC URL 方式：[JDBC support](https://java.testcontainers.org/modules/databases/jdbc/)
- PostgreSQL 模块：[Postgres Module](https://java.testcontainers.org/modules/databases/postgres/)
- Kafka 模块：[Kafka Module](https://java.testcontainers.org/modules/kafka/)
- LocalStack 模块：[LocalStack Module](https://java.testcontainers.org/modules/localstack/)
- 网络与容器互通：[Networking and communicating with containers](https://java.testcontainers.org/features/networking/)
- CI 中的 Docker 模式：[Patterns for running tests inside a Docker container](https://java.testcontainers.org/supported_docker_environment/continuous_integration/dind_patterns/)
- GitLab CI：[GitLab CI](https://java.testcontainers.org/supported_docker_environment/continuous_integration/gitlab_ci/)
- Spring Boot 中的 Testcontainers：[Testcontainers](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html)

> 下一篇：[契约测试](./6_contract_test)

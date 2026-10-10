---
description: 构建期增强、扩展、ArC 依赖注入、Dev Mode、Dev Services、配置与 Profile、版本线
---

# Quarkus 概览

> 前置阅读：[启动流程与自动配置](/spring-boot/1_spring_boot)、[Vert.x 概览](/vertx/1_basics)

Quarkus 是 Red Hat 主导的 Java 框架，把运行期的扫描与装配挪到构建期，因此启动快、内存省。本篇讲扩展、ArC 依赖注入、开发模式与 Dev Services、配置体系和版本线。

---

## 一、为什么启动快：构建期增强

### 1、传统框架的启动开销在哪

一个典型的 Spring Boot 应用启动时要做：

- 扫描类路径，找出带注解的类；读取 `AutoConfiguration.imports` 中的几百个候选配置
- 逐个评估 `@Conditional`，用反射读取注解元数据
- 生成 CGLIB / JDK 动态代理（事务、AOP、`@Configuration` 增强）
- 解析配置文件、绑定 `@ConfigurationProperties`

这些工作**每次启动都重做一遍**，而且结果在同一个制品里永远一样。同时，为完成这些工作加载的类（注解解析器、条件评估器、XML 解析器）在启动完成后就不再使用，却一直占着元空间与堆。

### 2、Quarkus 的做法

![Quarkus 构建期增强流程](../assets/quarkus/quarkus-build-time.svg)

Quarkus 把构建拆成两个阶段：普通的 `javac` 编译之后，还有一个**增强（Augmentation）**阶段。每个扩展分为两个模块：

| 模块 | 作用 | 是否进入运行期 |
|------|------|----------------|
| `runtime` | 运行期真正需要的代码（如 Hibernate Session 管理） | 是 |
| `deployment` | 一组 `@BuildStep` 方法：读取 Jandex 索引、解析注解、决定生成什么字节码 | 否 |

`deployment` 模块在构建期执行，用 **Recorder** 把「启动时要调用哪些初始化方法、传什么参数」录制成字节码。运行期启动时只需回放这段字节码，不再扫描、不再解析注解、不再生成代理。

由此直接得出几个结论：

- **启动快、内存低**：元数据处理相关的类不进入运行期类路径，堆和元空间都更小
- **Bean 图在构建期确定**：没被注入的 Bean 会被移除（`quarkus.arc.remove-unused-beans` 默认开启），运行期动态注册 Bean 的玩法基本行不通
- **天然适合原生镜像**：反射、代理需求在构建期已知，扩展能自动生成 GraalVM 需要的注册信息（见 [原生镜像与云原生部署](./3_native)）
- **部分配置在构建期固化**：例如数据库类型、启用哪些扩展，改了要重新构建（见第六节）

---

## 二、扩展（Extension）

### 1、扩展是什么

Quarkus 的第三方库集成都以扩展形式提供，地位相当于 Spring Boot 的 Starter，但职责更重：Starter 只负责「引依赖 + 自动配置」，扩展还要负责**让这个库适配构建期增强与原生镜像**——把库的初始化挪到构建期、登记反射、替换不兼容原生镜像的代码。

```bash
# 创建项目并添加扩展（Quarkus CLI）
quarkus create app com.example:order-service --extension='rest-jackson,hibernate-orm-panache,jdbc-postgresql'
quarkus ext add smallrye-health micrometer-registry-prometheus
quarkus ext list --installable | grep kafka
```

### 2、没有扩展的库能用吗

能。普通 Java 库在 **JVM 模式**下直接作为依赖使用即可，只是享受不到构建期优化；要编译**原生镜像**时，往往需要手工登记反射与资源。选型时优先看 [code.quarkus.io](https://code.quarkus.io) 与 Quarkiverse 中有没有对应扩展。

### 3、平台 BOM

Quarkus 用 `quarkus-bom`（平台 BOM）统一管理扩展版本，作用与 `spring-boot-dependencies` 相同。Quarkiverse 社区扩展有自己的版本号，升级 Quarkus 时要同步检查。

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.quarkus.platform</groupId>
      <artifactId>quarkus-bom</artifactId>
      <version>${quarkus.platform.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

---

## 三、依赖注入：ArC 与 Spring IoC

### 1、ArC 是什么

ArC 是 Quarkus 自带的依赖注入实现，基于 Jakarta CDI 规范的 **CDI Lite** 子集，并在构建期完成 Bean 发现与校验。注解来自 `jakarta.inject` / `jakarta.enterprise`：

```java
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.config.inject.ConfigProperty;

@ApplicationScoped
public class OrderService {

    private final PriceCalculator calculator;

    @ConfigProperty(name = "order.max-items", defaultValue = "100")
    int maxItems;

    @Inject // 只有一个构造器时可省略
    public OrderService(PriceCalculator calculator) {
        this.calculator = calculator;
    }

    public long total(java.util.List<Long> prices) {
        if (prices.size() > maxItems) {
            throw new IllegalArgumentException("too many items");
        }
        return calculator.sum(prices);
    }
}
```

### 2、和 Spring IoC 的关键差异

| 维度 | Spring IoC | ArC |
|------|-----------|-----|
| Bean 发现 | 运行期类路径扫描（`@ComponentScan`） | 构建期 Jandex 索引 |
| 依赖校验 | 启动时，缺 Bean 抛 `NoSuchBeanDefinitionException` | **构建期**，缺依赖或有歧义直接构建失败 |
| 默认作用域 | 单例 | 无注解的类不是 Bean；常用 `@ApplicationScoped`（客户端代理、延迟创建）或 `@Singleton`（无代理） |
| 条件装配 | `@Conditional*` 运行期评估 | `@IfBuildProfile`、`@LookupIfProperty` 等，多在构建期决定 |
| 代理 | CGLIB 运行期生成 | 构建期生成字节码 |
| 私有字段注入 | 支持（反射） | 支持但需要反射，官方推荐包级可见字段或构造器注入 |
| 未使用 Bean | 全部创建 | 默认移除 |

两个常见坑：

- **`@ApplicationScoped` 是懒加载 + 客户端代理**：Bean 在第一次调用方法时才创建；需要启动即初始化时监听 `StartupEvent` 或加 `@Startup`
- **Bean 被意外移除**：只通过 `CDI.current().select(...)` 或字符串名字动态查找的 Bean，在构建期看不到注入点，会被当作未使用移除，需要加 `@Unremovable`

---

## 四、开发模式与持续测试

### 1、Dev Mode

```bash
quarkus dev        # 或 ./mvnw quarkus:dev
```

Dev Mode 下修改 Java 代码、配置或资源后，**下一次 HTTP 请求触发热重载**：Quarkus 重新编译变动的类并重新执行增强，通常在一秒级完成。它不是 JVM HotSwap，可以改方法签名、加类、加注解。

Dev Mode 同时提供 Dev UI（`/q/dev-ui`），可以查看 Bean 列表、配置项、扩展状态、Dev Services 启动的容器连接信息。

### 2、持续测试

在 Dev Mode 终端按 `r` 开启持续测试：Quarkus 在后台根据代码变更**只重跑受影响的测试**，结果直接显示在终端与 Dev UI。测试使用 `@QuarkusTest`：

```java
import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;
import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;

@QuarkusTest
class OrderResourceTest {

    @Test
    void shouldReturnOrder() {
        given().when().get("/orders/1")
               .then().statusCode(200)
               .body("id", is(1));
    }
}
```

`@QuarkusTest` 会启动一次应用并在测试类之间复用，比每个测试类都起一次上下文的方式快得多；需要替换 Bean 时用 `@InjectMock`（`quarkus-junit5-mockito`）或 `@TestProfile` 切换配置。

---

## 五、Dev Services

**引入了扩展但没有配置连接地址时，Quarkus 在开发与测试模式下自动用容器拉起对应服务**（底层是 Testcontainers），并把连接信息注入配置。例如引入 `jdbc-postgresql` 而不配置 `quarkus.datasource.jdbc.url`，`quarkus dev` 时就会自动启动一个 PostgreSQL 容器。

| 要点 | 说明 |
|------|------|
| 生效范围 | 只在 dev / test 模式；代码位于 deployment 模块，不进入生产制品 |
| 前置条件 | 本机有 Docker 或 Podman |
| 自动关闭 | 配置了连接地址（如 JDBC URL、`kafka.bootstrap.servers`）即不再启动 |
| 全局开关 | `quarkus.devservices.enabled=false` |
| 容器共享 | 开发模式下多个应用可通过标签发现并共享同一容器 |
| 支持范围 | 数据库、Kafka、Redis、RabbitMQ、MongoDB、Keycloak/OIDC、Elasticsearch 等 |

生产配置用 `%prod.` 前缀写真实地址，dev / test 保持不配，两边互不干扰：

```properties
quarkus.datasource.db-kind=postgresql
%prod.quarkus.datasource.jdbc.url=jdbc:postgresql://db:5432/orders
%prod.quarkus.datasource.username=${DB_USER}
%prod.quarkus.datasource.password=${DB_PASSWORD}
```

> 注意 CI 环境：Runner 没有 Docker 时 Dev Services 会启动失败，测试直接报错。要么给 Runner 提供 Docker，要么在 CI Profile 中显式配置外部服务地址。

---

## 六、配置：MicroProfile Config 与 Profile

### 1、配置来源与优先级

Quarkus 的配置实现是 SmallRye Config（MicroProfile Config 规范）。默认来源按优先级从高到低：

1. 系统属性（`-Dquarkus.http.port=8081`）
2. 环境变量（`QUARKUS_HTTP_PORT=8081`，点和横线转为下划线并大写）
3. 工作目录下的 `.env` 文件
4. `config/application.properties`（工作目录）
5. `src/main/resources/application.properties`

需要 YAML 时引入 `quarkus-config-yaml` 扩展。

### 2、Profile

内置 `dev` / `test` / `prod` 三个 Profile，用 `%profile.` 前缀覆盖：

```properties
quarkus.http.port=8080
%dev.quarkus.log.level=DEBUG
%test.order.max-items=5
```

自定义 Profile 通过 `quarkus.profile=staging` 激活，也支持 `application-staging.properties` 的文件形式。

### 3、类型安全的配置映射

```java
import io.smallrye.config.ConfigMapping;
import io.smallrye.config.WithDefault;
import java.time.Duration;

@ConfigMapping(prefix = "order")
public interface OrderConfig {

    @WithDefault("100")
    int maxItems();

    @WithDefault("PT5S")
    Duration paymentTimeout();
}
```

`@ConfigMapping` 是接口，在构建期生成实现并校验，等价于 Spring 的 `@ConfigurationProperties`。

### 4、构建期配置与运行期配置

这是从 Spring 迁过来最容易踩的坑：**一部分配置在构建期就被固化进制品**，运行时改了不生效。例如 `quarkus.datasource.db-kind`（数据库类型决定了构建期选用哪个驱动与方言）、各扩展的功能开关等。官方配置参考中带「锁」图标的属性就是构建期属性。

判断方法：

- 查看 [全量配置参考](https://quarkus.io/guides/all-config)，带锁图标的是构建期固化
- 构建产物运行时如果传入了被固化的属性且值不同，启动日志会给出警告
- 需要「同一制品、多环境不同行为」的地方，只能用运行期属性或 Profile

---

## 七、版本线与生态关系

### 1、当前版本线（2026 年 10 月）

| 版本 | 状态 | 社区维护到 |
|------|------|------------|
| 3.40 LTS | 最新 LTS，生产推荐 | 2027-09-30 |
| 3.33 LTS | 仍在维护 | 2027-03-25 |
| 3.27 LTS | 已结束维护 | 2026-09-24 |
| 4.0 | 2026-10-01 发布 Beta1，计划 11 月底 GA | — |

- LTS 每 6 个月一个、维护 12 个月；非 LTS 小版本大约每月一个，只维护到下一个小版本
- Quarkus 3 的 JVM 模式支持 JDK 17–25；**Quarkus 4 最低要求 Java 21**，并升级到 Vert.x 5、Netty 4.2、Jackson 3、Hibernate ORM 8、Jakarta REST 4 等
- 升级用 `quarkus update`，它基于 OpenRewrite 自动改写依赖与代码

### 2、与 Vert.x 的关系

Quarkus 的 HTTP 层、事件总线、响应式客户端都跑在 Vert.x 之上：

- HTTP 请求由 Vert.x 的事件循环（I/O 线程）接收，Quarkus REST 再决定端点在 I/O 线程、Worker 线程还是虚拟线程上执行（见 [REST 与数据访问](./2_rest_data)）
- 响应式 API 用 Mutiny 包装 Vert.x（`io.vertx.mutiny.*`），见 [响应式与消息](./4_reactive)
- 可以直接注入 `io.vertx.mutiny.core.Vertx` 使用 Vert.x 原生能力

所以「Quarkus 是 Vert.x 之上的全栈框架」这个理解大体成立：Vert.x 提供事件循环与非阻塞 I/O，Quarkus 提供 DI、配置、ORM、构建期优化和开发体验。Vert.x 本身的模型见 [Vert.x 概览](/vertx/1_basics)。

### 3、标准化取向

Quarkus 大量采用 Jakarta EE 与 MicroProfile 规范（CDI、Jakarta REST、JPA、Bean Validation、MicroProfile Config / Health / Fault Tolerance / OpenAPI），API 风格与 Spring 差异较大，但与 Jakarta EE 应用服务器的代码迁移成本较低。

---

## 小结

- Quarkus 的核心是构建期增强：扩展的 deployment 模块在构建期完成扫描、注解解析与代理生成，运行期只回放录制好的初始化，因此启动快、内存低
- 扩展比 Starter 职责更重，还要负责原生镜像适配；没有扩展的库在 JVM 模式可用，原生模式需要手工登记
- ArC 是构建期的 CDI Lite 实现：依赖错误在构建期暴露，未使用 Bean 默认移除，动态查找的 Bean 需加 `@Unremovable`
- Dev Mode 热重载 + 持续测试 + Dev Services 自动起容器，是 Quarkus 开发体验的三件套；CI 需要 Docker 或显式配置外部服务
- 配置用 SmallRye Config 与 `%profile.` 前缀，注意构建期固化的属性运行时改不了
- 当前生产推荐 3.40 LTS；Quarkus 4 最低 Java 21，基于 Vert.x 5

## 参考资料

- 官方指南：[https://quarkus.io/guides/](https://quarkus.io/guides/)
- 版本与支持周期：[https://quarkus.io/releases](https://quarkus.io/releases)
- CDI 参考（ArC）：[https://quarkus.io/guides/cdi-reference](https://quarkus.io/guides/cdi-reference)
- Dev Services：[https://quarkus.io/guides/dev-services](https://quarkus.io/guides/dev-services)
- 配置参考：[https://quarkus.io/guides/config-reference](https://quarkus.io/guides/config-reference)
- Quarkus 4.0.0.Beta1 发布说明：[https://quarkus.io/blog/quarkus-4-0-0-beta1-released/](https://quarkus.io/blog/quarkus-4-0-0-beta1-released/)

> 下一篇：[REST 与数据访问](./2_rest_data) —— 端点跑在哪个线程上、REST Client 与 Panache 怎么用，是 Quarkus 写业务代码的主线。

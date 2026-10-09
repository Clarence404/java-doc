---
description: 配置优先级、松散绑定、@ConfigurationProperties、Profile、配置导入、敏感配置
---

# 配置管理

> **本篇目标**：弄清 Spring Boot 外部化配置的完整优先级与查找路径，能用 `@ConfigurationProperties`（含 record 与校验）安全地绑定配置，正确组织多环境 Profile 与 `spring.config.import`，并知道敏感配置和动态刷新该交给谁。
>
> **前置阅读**：[启动流程与自动配置](./1_spring_boot)

> 参考资料：
> * Spring Boot Externalized Configuration：[https://docs.spring.io/spring-boot/reference/features/external-config.html](https://docs.spring.io/spring-boot/reference/features/external-config.html)
> * Spring Boot Profiles：[https://docs.spring.io/spring-boot/reference/features/profiles.html](https://docs.spring.io/spring-boot/reference/features/profiles.html)
> * Spring Cloud Vault：[https://spring.io/projects/spring-cloud-vault](https://spring.io/projects/spring-cloud-vault)

本篇以 Spring Boot 4.x 为基线；外部化配置的机制从 2.4 起基本稳定，3.x 与 4.x 的写法一致，个别差异在正文中标出。

---

## 一、配置源优先级

![Spring Boot 配置源优先级](../assets/spring-boot/config-precedence.svg)

### 1、完整顺序

下表从**高到低**排列，高优先级覆盖低优先级（同名属性只取最高者，不同属性会合并）：

| 优先级 | 配置源 | 说明 |
|--------|--------|------|
| 1 | DevTools 全局设置 | `$HOME/.config/spring-boot/` 下的文件，仅 DevTools 生效时 |
| 2 | 测试专用属性 | `@TestPropertySource`、`@DynamicPropertySource`、`@SpringBootTest(properties = …)` 及切片测试的 `properties` |
| 3 | 命令行参数 | `--server.port=9090` |
| 4 | `SPRING_APPLICATION_JSON` | 环境变量或系统属性里的一段内联 JSON |
| 5 | `ServletConfig` / `ServletContext` 初始化参数 | 传统 WAR 部署时 |
| 6 | JNDI 属性 | `java:comp/env` |
| 7 | **Java 系统属性** | `-Dserver.port=9090`，高于环境变量 |
| 8 | 操作系统环境变量 | `SERVER_PORT=9090` |
| 9 | `RandomValuePropertySource` | 仅 `random.*`，如 `${random.uuid}` |
| 10 | 配置数据文件 | `application*.properties` / `.yml`，内部顺序见下文 |
| 11 | `@PropertySource` | 在上下文刷新时才加入，对 `logging.*`、`spring.main.*` 等启动早期属性无效 |
| 12 | 默认属性 | `SpringApplication.setDefaultProperties` |

第 7、8 两行在容器里最容易踩坑：镜像里通过 `JAVA_OPTS="-Dspring.profiles.active=prod"` 写死的值会压过 Kubernetes 注入的 `SPRING_PROFILES_ACTIVE` 环境变量。

### 2、配置数据文件的内部顺序

同属第 10 级的配置文件，从高到低：

1. jar 外的 Profile 文件：`application-{profile}.yml`
2. jar 外的默认文件：`application.yml`
3. jar 内的 Profile 文件
4. jar 内的默认文件

同一位置下 `.properties` 优先于 `.yml`，项目里应只用一种格式。

### 3、查找位置

Boot 依次加载以下位置，**后加载的覆盖先加载的**：

| 顺序 | 位置 |
|------|------|
| 1 | `classpath:/` |
| 2 | `classpath:/config/` |
| 3 | `file:./`（当前工作目录） |
| 4 | `file:./config/` |
| 5 | `file:./config/*/`（`config` 的直接子目录，按名称排序） |

可用 `spring.config.location` 完全替换默认位置，或用 `spring.config.additional-location` 在默认位置之外追加；这两个属性必须在配置文件之外设置（命令行、环境变量或系统属性）。

---

## 二、属性注入

### 1、`@Value`

```java
@Value("${server.port}")
private int serverPort;

@Value("${app.name:default-name}")   // 冒号后为默认值
private String appName;

@Value("${app.tags}")                // "a,b,c" 自动转换为 List
private List<String> tags;
```

`@Value` 适合零散的单个值；它不支持校验、不生成 IDE 元数据，松散绑定也只部分支持（见本节第 3 小节），批量或结构化配置都应该用 `@ConfigurationProperties`。

### 2、`@ConfigurationProperties`

**record 构造器绑定（推荐）**：Boot 3.0 起，类只有一个构造器时自动按构造器绑定，不再需要 `@ConstructorBinding`；record 天然不可变，最合适。

```java
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

@ConfigurationProperties(prefix = "app.notify")
@Validated
public record NotifyProperties(
        @NotBlank String host,
        @DefaultValue("25") @Min(1) @Max(65535) int port,
        @DefaultValue("5s") Duration timeout,          // 支持 5s、500ms、1m 等写法
        @NotEmpty List<String> to,
        Map<String, String> headers,
        @Valid @DefaultValue Retry retry) {            // 嵌套对象：@DefaultValue 让它在缺省时也被创建

    public record Retry(@DefaultValue("3") int maxAttempts,
                        @DefaultValue("1s") Duration backoff) { }
}
```

```yaml
app:
  notify:
    host: smtp.example.com
    port: 587
    timeout: 3s
    to:
      - admin@example.com
      - ops@example.com
    headers:
      X-Source: backend
    retry:
      max-attempts: 5
```

注册方式二选一，**不要**在属性类上同时加 `@Configuration` / `@Component`：

```java
@SpringBootApplication
@ConfigurationPropertiesScan("com.example.config")   // 扫描包内所有 @ConfigurationProperties
public class Application { }

// 或在某个配置类上精确登记
@Configuration
@EnableConfigurationProperties(NotifyProperties.class)
public class NotifyConfig { }
```

要点：

- `@Validated` 需要 classpath 上有 Bean Validation 实现，即引入 `spring-boot-starter-validation`；校验失败时应用**启动失败**，把配置错误挡在上线之前
- 嵌套对象上的约束要在字段上加 `@Valid` 才会级联校验
- 加 `spring-boot-configuration-processor`（`optional`）会在编译期生成元数据，IDE 里有补全与文档提示；record 组件上的 Javadoc 也会进入元数据
- 可变的 JavaBean 写法（字段 + getter/setter）仍然支持，适合需要在运行时被 Spring Cloud 重新绑定的属性类
- 类名避免与 Boot 自带的属性类同名（如 `MailProperties`、`DataSourceProperties`），否则排查时容易混淆

### 3、松散绑定（Relaxed Binding）

以 `@ConfigurationProperties(prefix = "my.main-project.person")` 中的 `firstName` 字段为例，下列写法等价：

| 写法 | 适用 |
|------|------|
| `my.main-project.person.first-name` | kebab-case，**`.properties` / `.yml` 推荐写法** |
| `my.main-project.person.firstName` | camelCase |
| `my.main-project.person.first_name` | 下划线，不推荐 |
| `MY_MAINPROJECT_PERSON_FIRSTNAME` | 大写下划线，**环境变量写法** |

环境变量的转换规则：`.` 换成 `_`、去掉 `-`、全部大写。所以 `main-project` 变成 `MAINPROJECT`，而不是 `MAIN_PROJECT`。列表下标用前后下划线包住：`MY_SERVICE_HOSTS_0_` 对应 `my.service.hosts[0]`。

注意两点：

- 松散绑定针对的是**属性名与 Java 字段名**之间的映射，`server.port` 与 `serverPort` 并不等价——前者是 `server` 对象下的 `port` 字段
- `@Value` 只有有限的松散绑定，必须在注解里写规范形式（小写 kebab-case，如 `@Value("${my.main-project.person.first-name}")`），这样才能同时匹配 yml 与环境变量

---

## 三、多环境 Profiles

### 1、按文件拆分

| 文件 | 用途 |
|------|------|
| `application.yml` | 公共配置 |
| `application-dev.yml` | 开发环境 |
| `application-test.yml` | 测试环境 |
| `application-prod.yml` | 生产环境 |

激活方式（优先级从高到低）：命令行 `--spring.profiles.active=prod`、系统属性 `-Dspring.profiles.active=prod`、环境变量 `SPRING_PROFILES_ACTIVE=prod`、`application.yml` 里的 `spring.profiles.active`。生产环境建议由部署平台注入，不要写死在包内的 `application.yml` 里。

### 2、单文件多文档

一个 yml 文件可以用 `---` 分成多个文档，用 `spring.config.activate.on-profile` 指定生效条件：

```yaml
spring:
  application:
    name: order-service
server:
  port: 8080
---
spring:
  config:
    activate:
      on-profile: prod
server:
  port: 80
---
spring:
  config:
    activate:
      on-profile: "dev | test"      # 支持 !、&、| 表达式
logging:
  level:
    com.example: debug
```

旧写法 `spring.profiles: prod`（用于标记文档）从 2.4 起废弃。**`spring.profiles.active`、`spring.profiles.include`、`spring.profiles.group` 不能写在 Profile 专属文件或带 `on-profile` 的文档里**，否则启动报错——激活哪些 Profile 必须在非 Profile 文档中决定。

### 3、Profile 分组与包含

```yaml
spring:
  profiles:
    group:
      production:            # 激活 production 时同时激活下面两个
        - prod-db
        - prod-mq
    include:                 # 无论激活什么都额外包含
      - common
```

分组用于把细粒度的 Profile 组合成部署环境；`include` 适合放所有环境都要的公共片段。

### 4、`@Profile` 按环境加载 Bean

```java
@Bean
@Profile("dev")
public SmsSender mockSmsSender() { return new LoggingSmsSender(); }

@Bean
@Profile("!dev")             // 非 dev 环境
public SmsSender aliyunSmsSender(SmsProperties props) { return new AliyunSmsSender(props); }
```

---

## 四、spring.config.import

### 1、导入额外配置

Boot 2.4 起，可以在配置文件里用 `spring.config.import` 引入其他配置源，被导入的内容优先级高于发起导入的文件：

```yaml
spring:
  config:
    import:
      - optional:file:./local-override.yml       # optional: 文件不存在也不报错
      - classpath:datasource.yml
      - optional:configtree:/etc/secrets/         # Kubernetes Secret 挂载目录
```

没有 `optional:` 前缀时，导入目标不存在会直接启动失败，这适合生产环境的必需配置。

### 2、configtree：读取挂载的 Secret

Kubernetes 把 Secret 挂载成「文件名为键、文件内容为值」的目录：

| 挂载文件 | 绑定后的属性 |
|----------|-------------|
| `/etc/secrets/spring/datasource/password` | `spring.datasource.password` |
| `/etc/secrets/app.api-key` | `app.api-key` |

`configtree:` 会把子目录层级转成 `.` 分隔的属性名。相比把 Secret 注入成环境变量，挂载文件不会出现在进程环境（`/proc/<pid>/environ`）和 `/actuator/env` 的原始值里，轮换时也不必重建 Pod 的环境。

### 3、配置中心与密钥服务

`spring.config.import` 也是接入外部配置中心的统一入口，Spring Cloud 2020.0 起不再默认启用 bootstrap 上下文：

```yaml
spring:
  config:
    import:
      - optional:nacos:order-service.yaml     # Spring Cloud Alibaba 2025.1
      - optional:vault://                      # Spring Cloud Vault
```

Nacos 的接入与命名空间、分组规划见 [配置中心](/spring-cloud/4_config_center)。

---

## 五、敏感配置

配置文件进 Git、镜像会被分发，密码、Token、私钥**不能以明文出现在任何 `application*.yml` 中**。Boot 侧的推荐顺序：

1. **运行时注入**：通过环境变量或 `configtree:` 挂载的 Secret 提供，配置文件里只写占位符 `password: ${DB_PASSWORD}`
2. **密钥管理服务**：Vault、云厂商 KMS / Secrets Manager，用 `spring.config.import` 拉取；生产环境的 Vault 认证用 `KUBERNETES` 或 `APPROLE`，不要把长期 `TOKEN` 写进配置
3. **配置文件加密**（Jasypt 的 `ENC(…)`）：只能挡住「仓库被看到」，解密主密钥仍要在运行时注入，属于兜底方案

另外两个 Boot 相关的点：

- `/actuator/env`、`/actuator/configprops` 从 Boot 3.0 起默认把值显示为 `******`，不要为了排查把 `show-values` 设成 `always`，见 [Actuator 监控](./7_actuator)
- 日志里不要打印 `@ConfigurationProperties` 对象的 `toString()`，record 默认的 `toString()` 会输出全部字段

Jasypt 的算法选择、Vault 动态凭证与密钥轮换统一见 [数据安全](/security/7_data_security)。

---

## 六、动态刷新

Boot 本身只在启动时绑定配置，**运行时修改配置需要 Spring Cloud**：`spring-cloud-context` 提供 `@RefreshScope` 和 `refresh` 端点，配置中心推送变更后触发刷新。两条规律：

- `@ConfigurationProperties` 的 JavaBean 类会在刷新事件中**原地重新绑定**，不需要 `@RefreshScope`；record 等构造器绑定的类不可变，不会被重新绑定
- `@Value` 注入的字段只有所在 Bean 标了 `@RefreshScope` 才会更新

刷新原理、Nacos 推送与配置中心选型见 [配置中心](/spring-cloud/4_config_center)。

---

## 小结

- 优先级从高到低：测试属性 > 命令行 > `SPRING_APPLICATION_JSON` > **Java 系统属性 > 环境变量** > 配置文件 > `@PropertySource` > 默认属性；配置文件内部是 jar 外优先于 jar 内、Profile 文件优先于默认文件
- 批量配置用 `@ConfigurationProperties`：record + 构造器绑定 + `@Validated`，通过 `@ConfigurationPropertiesScan` 或 `@EnableConfigurationProperties` 注册
- 松散绑定映射的是属性名与字段名；配置文件写 kebab-case，环境变量全大写、去 `-`、`.` 换 `_`；`@Value` 里写规范形式
- 多环境用 Profile 文件或 `on-profile` 多文档，`spring.profiles.active` 不能写在 Profile 专属文档里；分组和 `include` 组合环境
- `spring.config.import` 统一接入额外文件、`configtree:` Secret、Nacos、Vault；`optional:` 控制缺失时是否启动失败
- 密钥走运行时注入或密钥服务，Jasypt 只作兜底；动态刷新属于 Spring Cloud 的能力

> 下一篇：[Actuator 监控](./7_actuator) —— 健康检查、探针、指标与端点安全，让 Boot 应用在生产环境可观测、可运维。

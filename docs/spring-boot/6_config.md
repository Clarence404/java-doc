# 配置管理

> 参考资料：
> * Spring Boot 外部化配置：[https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.external-config](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.external-config)

## 一、配置源优先级

Spring Boot 外部化配置优先级从高到低（高优先级覆盖低优先级）：

| 优先级 | 配置源 |
|--------|--------|
| 1 | 命令行参数 `--server.port=9090` |
| 2 | `SPRING_APPLICATION_JSON` 环境变量（JSON 串） |
| 3 | 操作系统环境变量 |
| 4 | `application-{profile}.yml`（外部目录） |
| 5 | `application.yml`（外部目录） |
| 6 | `application-{profile}.yml`（classpath） |
| 7 | `application.yml`（classpath） |
| 8 | `@PropertySource` 注解引入的属性文件 |
| 9 | 默认属性（`SpringApplication.setDefaultProperties`） |

> 外部目录指 jar 包同级的 `/config` 子目录或当前工作目录。

---

## 二、application.yml 配置

### 2.1 基础语法

```yaml
server:
  port: 8080
  servlet:
    context-path: /api

spring:
  datasource:
    url: jdbc:mysql://localhost:3306/demo
    username: root
    password: ${DB_PASSWORD}   # 从环境变量读取
```

### 2.2 `@Value` 注入

```java
@Value("${server.port}")
private int serverPort;

@Value("${app.name:default-name}")  // 带默认值
private String appName;

@Value("${app.tags}")               // 逗号分隔 → List
private List<String> tags;
```

### 2.3 `@ConfigurationProperties` 绑定

比 `@Value` 更适合批量绑定、嵌套对象、集合：

```java
@Configuration
@ConfigurationProperties(prefix = "app.mail")
@Validated
public class MailProperties {

    @NotBlank
    private String host;

    private int port = 25;       // 默认值

    private List<String> to;

    private Map<String, String> headers;

    // getter / setter
}
```

```yaml
app:
  mail:
    host: smtp.example.com
    port: 587
    to:
      - admin@example.com
      - ops@example.com
    headers:
      X-Source: backend
```

### 2.4 松散绑定（Relaxed Binding）

以下写法均绑定到 `serverPort`：

| 配置文件写法 | 说明 |
|------------|------|
| `server-port` | kebab-case（推荐） |
| `serverPort` | camelCase |
| `SERVER_PORT` | 大写下划线（环境变量） |
| `server.port` | 标准点分隔 |

---

## 三、多环境 Profiles

### 3.1 配置文件分环境

```
resources/
├── application.yml          公共配置
├── application-dev.yml      开发环境
├── application-test.yml     测试环境
└── application-prod.yml     生产环境
```

激活方式：

```yaml
# application.yml
spring:
  profiles:
    active: dev   # 可被命令行 --spring.profiles.active=prod 覆盖
```

```bash
java -jar app.jar --spring.profiles.active=prod
```

### 3.2 Profile 分组（Boot 2.4+）

```yaml
spring:
  profiles:
    group:
      production:
        - prod
        - monitoring   # 激活 production 时同时激活这两个 profile
```

### 3.3 `@Profile` 按环境加载 Bean

```java
@Bean
@Profile("dev")
public DataSource devDataSource() { ... }

@Bean
@Profile("prod")
public DataSource prodDataSource() { ... }

@Bean
@Profile("!test")   // 非 test 环境
public NotificationService notificationService() { ... }
```

---

## 四、配置加密

### 4.1 Jasypt（本地加密）

```xml
<dependency>
    <groupId>com.github.ulisesbocchio</groupId>
    <artifactId>jasypt-spring-boot-starter</artifactId>
    <version>3.0.5</version>
</dependency>
```

```yaml
jasypt:
  encryptor:
    password: ${JASYPT_KEY}   # 加密主密钥，从环境变量注入

spring:
  datasource:
    password: ENC(加密后的密文)  # Jasypt 自动解密
```

```bash
# 生成密文
java -cp jasypt-3.0.5.jar org.jasypt.intf.cli.JasyptPBEStringEncryptionCLI \
  input="my-db-password" password="my-jasypt-key" algorithm=PBEWithMD5AndDES
```

### 4.2 Spring Cloud Vault（生产推荐）

```yaml
spring:
  cloud:
    vault:
      host: vault.example.com
      port: 8200
      scheme: https
      authentication: TOKEN
      token: ${VAULT_TOKEN}
      kv:
        enabled: true
        backend: secret
        default-context: application
```

---

## 五、动态刷新（Spring Cloud Config）

结合 Spring Cloud Config Server + `@RefreshScope`，无需重启即可刷新配置：

```java
@RestController
@RefreshScope   // 标记该 Bean 在 /actuator/refresh 后重新创建
public class ConfigController {

    @Value("${feature.flag:false}")
    private boolean featureFlag;
}
```

```bash
# 触发配置刷新（POST 请求）
curl -X POST http://localhost:8080/actuator/refresh
```

> 更完整的配置中心方案见微服务模块 → 配置中心章节。

# Spring Boot

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-boot/docs/current/reference/html/](https://docs.spring.io/spring-boot/docs/current/reference/html/)
> * GitHub：[https://github.com/spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)

## 一、Spring Boot 启动流程

### 1.1 启动入口

```java
@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}

// @SpringBootApplication 是以下三个注解的组合
// @Configuration        支持 @Bean 声明
// @ComponentScan        扫描当前包路径及子包
// @EnableAutoConfiguration  开启自动配置
```

### 1.2 `SpringApplication.run()` 启动流程

```
① 创建 SpringApplication 对象（判断应用类型 SERVLET / REACTIVE / NONE）
② 从 spring.factories 加载 ApplicationContextInitializer 和 ApplicationListener
③ 推断 main 类
④ run() 执行：
   → 创建 Environment（加载所有配置源）
   → 发布 ApplicationStartingEvent
   → 打印 Banner
   → 创建 ApplicationContext（AnnotationConfigServletWebServerApplicationContext）
   → 执行 ApplicationContextInitializer
   → 加载 BeanDefinition（扫描 + 自动配置）
   → 调用 context.refresh()（IoC 容器初始化）
   → 发布 ApplicationStartedEvent
   → 执行 CommandLineRunner / ApplicationRunner
   → 发布 ApplicationReadyEvent
```

### 1.3 CommandLineRunner / ApplicationRunner

```java
// 应用启动完成后执行（适合初始化数据、预热缓存）
@Component
@Order(1)   // 多个 Runner 时指定执行顺序
@RequiredArgsConstructor
@Slf4j
public class DataInitRunner implements CommandLineRunner {

    private final CacheService cacheService;

    @Override
    public void run(String... args) throws Exception {
        log.info("应用启动，预热缓存...");
        cacheService.warmUp();
    }
}

// ApplicationRunner：参数解析更方便
@Component
@Order(2)
public class ConfigCheckRunner implements ApplicationRunner {

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (args.containsOption("check-config")) {
            // 检查配置
        }
    }
}
```

---

## 二、自动配置原理

### 2.1 配置加载机制

**Spring Boot 2.x（`spring.factories`）**

```
META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
  com.example.MyAutoConfiguration
```

**Spring Boot 3.x（`AutoConfiguration.imports`，推荐）**

```
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.MyAutoConfiguration
```

> `spring.factories` 在 Boot 3.x 中仍受支持但已被标记为 legacy，新项目应使用 `AutoConfiguration.imports`。

- `SpringFactoriesLoader` / `ImportCandidates.load()` 负责读取配置文件
- `@EnableAutoConfiguration` 触发 `AutoConfigurationImportSelector` 加载候选类
- 通过 `@ConditionalOnXxx` 按需激活，避免全量加载

### 2.2 条件注解

| 注解 | 触发条件 |
|------|---------|
| `@ConditionalOnClass` | 指定 Class 存在于 classpath |
| `@ConditionalOnMissingBean` | 容器中不存在指定 Bean |
| `@ConditionalOnMissingClass` | 指定 Class 不存在于 classpath |
| `@ConditionalOnProperty` | 配置文件中属性满足条件 |
| `@ConditionalOnWebApplication` | 当前是 Web 环境 |
| `@ConditionalOnExpression` | SpEL 表达式为 true |

```java
// 自定义自动配置类示例
@AutoConfiguration
@ConditionalOnClass(RedisTemplate.class)
@ConditionalOnProperty(prefix = "myapp.cache", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(MyCacheProperties.class)
public class MyCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean   // 允许用户覆盖
    public CacheService cacheService(MyCacheProperties props) {
        return new RedisCacheService(props);
    }
}
```

### 2.3 `@ConfigurationProperties` 属性绑定

```java
@ConfigurationProperties(prefix = "myapp.cache")
@Validated
@Data
public class MyCacheProperties {

    /** 是否启用 */
    private boolean enabled = true;

    /** 默认 TTL（秒） */
    @Min(1)
    @Max(86400)
    private long ttl = 3600;

    /** 缓存名称列表 */
    private List<String> names = List.of("default");

    /** 各缓存 TTL 覆盖 */
    private Map<String, Long> ttlOverrides = new HashMap<>();
}
```

```yaml
myapp:
  cache:
    enabled: true
    ttl: 1800
    names:
      - users
      - products
    ttl-overrides:
      users: 600
      products: 3600
```

---

## 三、核心注解速查

| 注解 | 作用 |
|------|------|
| `@SpringBootApplication` | 组合注解：@Configuration + @ComponentScan + @EnableAutoConfiguration |
| `@Configuration` | 声明配置类，支持 @Bean |
| `@Bean` | 声明一个由 Spring 管理的 Bean |
| `@ComponentScan` | 扫描指定包路径，注册 @Component 等标注的类 |
| `@EnableAutoConfiguration` | 触发自动配置加载 |
| `@ConditionalOnXxx` | 条件化 Bean 注册 |
| `@ConfigurationProperties` | 将配置文件属性绑定到对象 |
| `@EnableConfigurationProperties` | 激活 @ConfigurationProperties 类 |

---

## 四、内嵌 Web 服务器

Spring Boot 默认内嵌 Tomcat，可通过排除依赖切换：

```xml
<!-- 切换为 Undertow（推荐高并发场景）-->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-tomcat</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-undertow</artifactId>
</dependency>
```

```yaml
server:
  port: 8080
  servlet:
    context-path: /api
  tomcat:
    threads:
      max: 200
      min-spare: 10
    connection-timeout: 20000ms
```

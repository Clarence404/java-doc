# 自定义 Starter

> 参考资料：
> * Spring Boot Starter 开发指南：[https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration)

自定义 Starter 是理解 Spring Boot **自动配置原理**的最佳切入点——写一遍就知道 Boot 启动时那几百个 AutoConfiguration 是怎么被找到、筛选、装配的。

## 一、自动配置的加载原理

`@SpringBootApplication` → `@EnableAutoConfiguration` → `AutoConfigurationImportSelector`，启动时做三件事：

1. **扫描候选**：读取 classpath 下所有 jar 的 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`，收集全部自动配置类名（Boot 2.x 读 `spring.factories`）
2. **条件过滤**：逐个评估 `@ConditionalOnXxx` 注解，不满足的直接跳过（这一步让"引了依赖才生效"成为可能）
3. **有序装配**：按 `@AutoConfigureBefore/After/Order` 排序后注册 Bean，**用户自己的 Bean 先注册**，所以 `@ConditionalOnMissingBean` 能实现"默认配置可覆盖"

> 排查某个自动配置为什么没生效：启动参数加 `--debug`，控制台输出 CONDITIONS EVALUATION REPORT，列出每个配置类的匹配/不匹配原因。

## 二、命名规范

| 场景 | 命名 | 示例 |
|------|------|------|
| 官方 Starter | `spring-boot-starter-xxx` | spring-boot-starter-web |
| **第三方 / 自定义** | `xxx-spring-boot-starter` | mybatis-spring-boot-starter |

官方前缀是保留的，自定义放前面——这是社区强约定，发布公共包必须遵守。

## 三、项目结构

```
my-cache-spring-boot-starter/
├── my-cache-spring-boot-autoconfigure/   自动配置模块（核心代码）
│   └── src/main/resources/META-INF/spring/
│       └── org.springframework.boot.autoconfigure.AutoConfiguration.imports  ← Boot 3.x
└── my-cache-spring-boot-starter/         依赖聚合模块（只有 pom.xml，引 autoconfigure + 三方依赖）
```

> Boot 2.x 对应文件为 `META-INF/spring.factories`；需要同时兼容两代时两个文件并存。
> 小项目也可以不拆两个模块，autoconfigure 与 starter 合一。

## 四、完整实战：RedisCacheStarter

### 1、配置属性类

```java
@ConfigurationProperties(prefix = "my.cache")
public class RedisCacheProperties {
    /** 是否启用（IDE 提示里会显示这行注释） */
    private boolean enabled = true;
    /** 全局过期时间 */
    private Duration ttl = Duration.ofMinutes(30);
    /** key 前缀 */
    private String keyPrefix = "cache:";
    // getter / setter 省略
}
```

### 2、自动配置类

```java
@AutoConfiguration                                     // Boot 3.x 专用注解（含 @Configuration）
@ConditionalOnClass(RedisTemplate.class)               // 引了 redis 依赖才装配
@ConditionalOnProperty(prefix = "my.cache", name = "enabled",
                       havingValue = "true", matchIfMissing = true)  // 可配置开关
@EnableConfigurationProperties(RedisCacheProperties.class)
public class RedisCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean                          // 用户自己定义了就用用户的
    public RedisTemplate<String, Object> cacheRedisTemplate(
            RedisConnectionFactory factory) {
        RedisTemplate<String, Object> tpl = new RedisTemplate<>();
        tpl.setConnectionFactory(factory);
        tpl.setKeySerializer(new StringRedisSerializer());
        tpl.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        return tpl;
    }

    @Bean
    @ConditionalOnMissingBean
    public MyCacheClient myCacheClient(RedisTemplate<String, Object> tpl,
                                       RedisCacheProperties props) {
        return new MyCacheClient(tpl, props.getTtl(), props.getKeyPrefix());
    }
}
```

### 3、注册自动配置类

```properties
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.cache.RedisCacheAutoConfiguration
```

### 4、配置提示元数据（IDE 自动补全）

```xml
<!-- autoconfigure 模块加注解处理器，编译期生成 spring-configuration-metadata.json -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-configuration-processor</artifactId>
  <optional>true</optional>
</dependency>
```

加上后，使用方在 `application.yaml` 敲 `my.cache.` 就有补全和 javadoc 提示——公共 Starter 的必备体验项。

### 5、使用方

```xml
<dependency>
  <groupId>com.example</groupId>
  <artifactId>my-cache-spring-boot-starter</artifactId>
  <version>1.0.0</version>
</dependency>
```

```yaml
my:
  cache:
    ttl: 10m
    key-prefix: "order:"
```

零代码即可注入 `MyCacheClient` 使用；想换实现时自己声明同类型 Bean 即可覆盖默认。

## 五、条件注解速查

| 注解 | 条件 | 典型用途 |
|------|------|---------|
| `@ConditionalOnClass` | classpath 存在某类 | "引了依赖才生效"的开关 |
| `@ConditionalOnMissingBean` | 容器中没有该类型 Bean | 默认实现允许用户覆盖 |
| `@ConditionalOnBean` | 容器中已有某 Bean | 依赖其他组件先就绪 |
| `@ConditionalOnProperty` | 配置项匹配 | 功能开关（配 `matchIfMissing`）|
| `@ConditionalOnWebApplication` | 是 Web 应用 | Web 专属配置 |
| `@AutoConfigureAfter/Before` | —（排序）| 在 RedisAutoConfiguration 之后装配 |

> 条件评估**有顺序成本**：`@ConditionalOnClass` 放类上最先短路，属性/Bean 条件其次——把最容易不满足的条件放最外层。

## 六、测试：ApplicationContextRunner

不启动完整应用，专测"各种条件下装配对不对"：

```java
class RedisCacheAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(RedisCacheAutoConfiguration.class));

    @Test
    void 默认装配() {
        runner.withBean(RedisConnectionFactory.class, () -> mock(RedisConnectionFactory.class))
              .run(ctx -> assertThat(ctx).hasSingleBean(MyCacheClient.class));
    }

    @Test
    void 关闭开关后不装配() {
        runner.withPropertyValues("my.cache.enabled=false")
              .run(ctx -> assertThat(ctx).doesNotHaveBean(MyCacheClient.class));
    }

    @Test
    void 用户自定义Bean优先() {
        runner.withBean("custom", MyCacheClient.class, () -> mock(MyCacheClient.class))
              .withBean(RedisConnectionFactory.class, () -> mock(RedisConnectionFactory.class))
              .run(ctx -> assertThat(ctx).getBean(MyCacheClient.class)
                                         .isSameAs(ctx.getBean("custom")));
    }
}
```

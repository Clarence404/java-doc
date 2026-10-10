---
description: 命名与模块、imports 注册、装配顺序、条件注解、配置元数据、ApplicationContextRunner
---

# 自定义 Starter

> 前置阅读：[启动流程与自动配置](./1_spring_boot)

自定义 Starter 是检验自己是否理解自动配置的最好方式：写一遍就知道上百个自动配置类是如何被找到、筛选和排序的。本篇按 Boot 4 的约定讲模块拆分、自动配置类的顺序与条件、配置属性的 IDE 提示，以及用 `ApplicationContextRunner` 测清各种装配分支。

---

## 一、命名与模块结构

### 1、命名规范

| 场景 | 命名 | 示例 |
|------|------|------|
| 官方 Starter | `spring-boot-starter-<技术>` | `spring-boot-starter-webmvc`、`spring-boot-starter-data-redis` |
| 官方技术模块（Boot 4） | `spring-boot-<技术>` | `spring-boot-data-redis`（自动配置 + 相关支持代码） |
| 第三方 / 自定义 | `<名称>-spring-boot-starter` | `mybatis-spring-boot-starter` |

`spring-boot` 开头的名字留给官方，自定义 Starter 把项目名放在前面；配置前缀也不要占用 `spring.*`、`management.*` 等 Boot 自己的命名空间。

### 2、模块拆分

| 模块 | 内容 | 依赖 |
|------|------|------|
| `my-cache-spring-boot-autoconfigure` | 自动配置类、属性类、`AutoConfiguration.imports` | `spring-boot-autoconfigure`；被集成的库标为 `optional` |
| `my-cache-spring-boot-starter` | 只有 pom，把 autoconfigure 和必需依赖聚合在一起 | autoconfigure 模块 + 实际要用的库 |

autoconfigure 模块中的第三方依赖标 `optional`，这样使用方没引对应库时，`@ConditionalOnClass` 才能让配置安全地跳过。功能简单、只有一种用法时，两个模块可以合一。

Boot 4 把自动配置按技术拆成了独立模块（详见 [Spring Boot 版本演进](./11_versions)），所以 Starter 依赖的不再是一个大而全的 `spring-boot-autoconfigure`，而是具体的技术模块：例如基于 Redis 的 Starter 应依赖 `spring-boot-data-redis`（或直接依赖 `spring-boot-starter-data-redis`），否则 Redis 的自动配置类根本不在 classpath 上。

---

## 二、完整实战：RedisCacheStarter

### 1、配置属性类

```java
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * 缓存 Starter 的配置。
 *
 * @param enabled   是否启用
 * @param ttl       全局过期时间
 * @param keyPrefix key 前缀
 */
@ConfigurationProperties(prefix = "my.cache")
public record RedisCacheProperties(
        @DefaultValue("true") boolean enabled,
        @DefaultValue("30m") Duration ttl,
        @DefaultValue("cache:") String keyPrefix) { }
```

库中的属性类**只通过 `@EnableConfigurationProperties` 登记**，不要加 `@Component`，也不要依赖使用方的 `@ConfigurationPropertiesScan` 去扫描。Javadoc 中的 `@param` 说明会被注解处理器写进元数据，成为 IDE 提示文本。

### 2、自动配置类

```java
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.data.redis.autoconfigure.DataRedisAutoConfiguration;   // Boot 4
import org.springframework.context.annotation.Bean;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializer;

@AutoConfiguration(after = DataRedisAutoConfiguration.class)     // 在 Boot 的 Redis 自动配置之后装配
@ConditionalOnClass(RedisTemplate.class)                          // 引了 Spring Data Redis 才生效
@ConditionalOnBooleanProperty(name = "my.cache.enabled", matchIfMissing = true)   // 3.5+
@EnableConfigurationProperties(RedisCacheProperties.class)
public class RedisCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(name = "myCacheRedisTemplate")
    public RedisTemplate<String, Object> myCacheRedisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, Object> tpl = new RedisTemplate<>();
        tpl.setConnectionFactory(factory);
        tpl.setKeySerializer(RedisSerializer.string());
        tpl.setValueSerializer(RedisSerializer.json());   // Spring Data Redis 4：基于 Jackson 3
        tpl.setHashKeySerializer(RedisSerializer.string());
        tpl.setHashValueSerializer(RedisSerializer.json());
        return tpl;
    }

    @Bean
    @ConditionalOnMissingBean
    public MyCacheClient myCacheClient(
            @Qualifier("myCacheRedisTemplate") RedisTemplate<String, Object> template,
            RedisCacheProperties props) {
        return new MyCacheClient(template, props.ttl(), props.keyPrefix());
    }
}
```

几个要点：

- **装配顺序写在 `@AutoConfiguration` 的 `before` / `after` 属性里**，不再单独加 `@AutoConfigureAfter`；`after` 只影响自动配置类之间的顺序，用户自己的 `@Configuration` 总是先于所有自动配置处理
- **Boot 3.x 的类名不同**：Redis 自动配置类是 `org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration`；不想在代码里依赖具体类时，可以用 `afterName = "…"` 写全限定名字符串。`@ConditionalOnBooleanProperty` 是 3.5 新增的，更早的版本写 `@ConditionalOnProperty(prefix = "my.cache", name = "enabled", havingValue = "true", matchIfMissing = true)`
- **Jackson 3 序列化器**：Spring Data Redis 4.0 起 `RedisSerializer.json()` 返回基于 Jackson 3 的 `GenericJacksonJsonRedisSerializer`，原来的 `GenericJackson2JsonRedisSerializer` 已废弃。新序列化器**默认不开启 default typing**（不在 JSON 里写类型信息），需要反序列化成具体类型时，用 `GenericJacksonJsonRedisSerializer.builder()` 显式开启并配置类型校验器。两者的 JSON 格式不同，升级时要考虑 Redis 里的存量数据
- 自定义的 `RedisTemplate` 起一个**专属的 Bean 名**，并用 `@ConditionalOnMissingBean(name = …)` 判断，避免和 Boot 默认的 `redisTemplate` 或使用方自己的模板互相顶替
- `@AutoConfiguration` 的 `proxyBeanMethods` 默认为 `false`，Bean 方法之间直接调用会得到新实例，所以 Bean 之间的依赖一律通过方法参数注入

### 3、注册自动配置类

```properties
# src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.cache.RedisCacheAutoConfiguration
```

这个文件从 **Boot 2.7** 开始支持，3.x、4.x 都只认它；`spring.factories` 中 `EnableAutoConfiguration` 键的注册方式在 3.0 已删除。只有还要兼容 2.6 及更早版本时，才需要两种文件并存。

### 4、注解处理器

```xml
<!-- 生成 META-INF/spring-configuration-metadata.json：IDE 补全与文档提示 -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>
</dependency>
<!-- 生成 META-INF/spring-autoconfigure-metadata.properties：条件预过滤 -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-autoconfigure-processor</artifactId>
    <optional>true</optional>
</dependency>
```

- **configuration-processor**：使用方在 `application.yaml` 中敲 `my.cache.` 就有补全和说明。需要补充提示（可选值、废弃说明）时，在 `META-INF/additional-spring-configuration-metadata.json` 中手写，处理器会合并进去
- **autoconfigure-processor**：把 `@ConditionalOnClass`、`@AutoConfiguration(after = …)` 等信息提前写进元数据文件，Boot 启动时不用加载类就能先过滤掉不满足条件的配置，减少类加载、加快启动（启动优化见 [启动与部署优化](./14_startup)）

使用 Maven 时，如果项目显式配置了 `annotationProcessorPaths`，这两个处理器也要加进去，否则不会生效。

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

不用写任何配置代码即可注入 `MyCacheClient`；想换实现时，自己声明一个同类型 Bean 就会覆盖默认的。

---

## 三、条件注解速查

| 注解 | 条件 | 典型用途 |
|------|------|---------|
| `@ConditionalOnClass` / `@ConditionalOnMissingClass` | classpath 中存在 / 不存在某类 | 「引了依赖才生效」 |
| `@ConditionalOnBean` / `@ConditionalOnMissingBean` | 容器中已有 / 没有某 Bean | 依赖其他组件；默认实现允许覆盖 |
| `@ConditionalOnProperty` | 配置项匹配指定值 | 字符串型开关 |
| `@ConditionalOnBooleanProperty`（3.5+） | 布尔配置项为 true（可改） | 功能开关 |
| `@ConditionalOnWebApplication` | Servlet / Reactive Web 应用 | Web 专属配置 |
| `@ConditionalOnThreading`（3.2+） | 平台线程 / 虚拟线程 | 按 `spring.threads.virtual.enabled` 选择执行器 |
| `@ConditionalOnResource` | 存在某资源文件 | 有配置文件才装配 |

两条经验：

- `@ConditionalOnBean` / `@ConditionalOnMissingBean` 只能看到**已经处理过**的 Bean 定义，所以只应在自动配置类中使用，并通过 `after` 保证被依赖的配置先处理
- `@ConditionalOnClass` 放在类上时，注解里引用的类在类加载前就会通过元数据解析，即使该类不存在也不会报错；放在 `@Bean` 方法上时，方法签名里引用的类型仍可能触发类加载失败，这时应把相关 Bean 放进带 `@ConditionalOnClass` 的嵌套静态配置类

---

## 四、测试：ApplicationContextRunner

不启动完整应用，只针对自动配置类，在毫秒级验证各种条件分支：

```java
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;

class RedisCacheAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(RedisCacheAutoConfiguration.class))
            .withBean(RedisConnectionFactory.class, () -> mock(RedisConnectionFactory.class));

    @Test
    @DisplayName("默认装配 MyCacheClient，属性取默认值")
    void createsClientByDefault() {
        runner.run(ctx -> {
            assertThat(ctx).hasSingleBean(MyCacheClient.class);
            assertThat(ctx.getBean(RedisCacheProperties.class).keyPrefix()).isEqualTo("cache:");
        });
    }

    @Test
    @DisplayName("关闭开关后不装配")
    void backsOffWhenDisabled() {
        runner.withPropertyValues("my.cache.enabled=false")
              .run(ctx -> assertThat(ctx).doesNotHaveBean(MyCacheClient.class));
    }

    @Test
    @DisplayName("用户自定义 Bean 优先")
    void userBeanWins() {
        MyCacheClient custom = mock(MyCacheClient.class);
        runner.withBean("custom", MyCacheClient.class, () -> custom)
              .run(ctx -> assertThat(ctx).getBean(MyCacheClient.class).isSameAs(custom));
    }

    @Test
    @DisplayName("classpath 中没有 Spring Data Redis 时整体跳过")
    void backsOffWithoutRedis() {
        runner.withClassLoader(new FilteredClassLoader(RedisTemplate.class))
              .run(ctx -> assertThat(ctx).doesNotHaveBean(MyCacheClient.class));
    }
}
```

- `withClassLoader(new FilteredClassLoader(...))` 模拟使用方没有引入某个库，专门用来验证 `@ConditionalOnClass`
- 条件不满足的原因可以在测试里打印：`ConditionEvaluationReportLoggingListener.forLogLevel(LogLevel.INFO)` 作为 initializer 传给 runner
- Web 相关的配置用 `WebApplicationContextRunner` / `ReactiveWebApplicationContextRunner`
- 测试中 `withBean` 注册的 Bean 属于「用户配置」，会先于自动配置处理，正好用来验证 `@ConditionalOnMissingBean` 的覆盖逻辑

Spring Boot 测试的整体分层与切片测试见 [Spring Boot 测试](./13_testing)。

---

## 小结

- 自定义 Starter 命名为 `<名称>-spring-boot-starter`，拆成 autoconfigure 与 starter 两个模块，集成的库在 autoconfigure 中标 `optional`
- Boot 4 自动配置按技术模块拆分，Starter 要依赖具体的 `spring-boot-<技术>` 模块；Redis 自动配置类是 `DataRedisAutoConfiguration`（3.x 为 `RedisAutoConfiguration`）
- 用 `@AutoConfiguration(after = …)` 声明顺序，在 `AutoConfiguration.imports` 中注册（2.7+），`spring.factories` 注册方式在 3.0 删除
- 属性类只用 `@EnableConfigurationProperties` 登记；configuration-processor 生成 IDE 提示，autoconfigure-processor 生成条件预过滤元数据
- Spring Data Redis 4 用 Jackson 3 的 `GenericJacksonJsonRedisSerializer`，默认不写类型信息，注意存量数据格式
- 用 `ApplicationContextRunner` + `FilteredClassLoader` 覆盖默认装配、关闭开关、用户覆盖、缺少依赖四类分支

自动配置的加载流程（`AutoConfigurationImportSelector` 读取 imports 文件 → 条件过滤 → 排序注册，用户 Bean 优先）见 [启动流程与自动配置](./1_spring_boot)。

## 参考资料

- Creating Your Own Auto-configuration：[https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
- Configuration Metadata：[https://docs.spring.io/spring-boot/specification/configuration-metadata/index.html](https://docs.spring.io/spring-boot/specification/configuration-metadata/index.html)
- Spring Data Redis 4.0 升级说明：[https://docs.spring.io/spring-data/redis/reference/4.0/upgrading.html](https://docs.spring.io/spring-data/redis/reference/4.0/upgrading.html)

> 下一篇：[异步任务与定时任务](./9_async_schedule) —— `@Async` 与 `@Scheduled` 的执行器配置、多实例调度和虚拟线程开关。

# 自定义 Starter

> 参考资料：
> * Spring Boot Starter 开发指南：[https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration)

## 一、Starter 项目结构

```
my-spring-boot-starter/
├── my-spring-boot-autoconfigure/   自动配置模块
│   └── src/main/resources/
│       └── META-INF/spring/
│           └── org.springframework.boot.autoconfigure.AutoConfiguration.imports  ← Boot 3.x
└── my-spring-boot-starter/         依赖聚合模块（只有 pom.xml）
```

> Boot 2.x 对应文件为 `META-INF/spring.factories`；Boot 3.x 改为上述路径，两者可共存以兼容。

## 二、实现步骤

1. 创建 `XxxProperties` 配置属性类（`@ConfigurationProperties`）
2. 创建核心功能 Bean
3. 创建 `XxxAutoConfiguration`（`@Configuration` + `@ConditionalOnXxx` + `@AutoConfiguration`）
4. 注册自动配置类：
   - **Boot 3.x**：在 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 中写入类全名（每行一个）
   - **Boot 2.x 兼容**：同时保留 `META-INF/spring.factories` 中 `EnableAutoConfiguration` 条目
5. 打包发布（本地 Maven / 私有仓库）

```java
// Boot 3.x 推荐：用 @AutoConfiguration 替代 @Configuration
@AutoConfiguration
@ConditionalOnClass(RedisTemplate.class)
@EnableConfigurationProperties(RedisCacheProperties.class)
public class RedisCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory,
                                                        RedisCacheProperties props) {
        RedisTemplate<String, Object> tpl = new RedisTemplate<>();
        tpl.setConnectionFactory(factory);
        Jackson2JsonRedisSerializer<Object> serializer =
            new Jackson2JsonRedisSerializer<>(Object.class);
        tpl.setValueSerializer(serializer);
        tpl.setKeySerializer(new StringRedisSerializer());
        return tpl;
    }
}
```

```properties
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.cache.RedisCacheAutoConfiguration
```

## 三、条件控制最佳实践

- `@ConditionalOnMissingBean`：允许用户覆盖默认 Bean
- `@ConditionalOnProperty`：通过配置项开关功能
- `@AutoConfigureAfter` / `@AutoConfigureBefore`：控制加载顺序

## 四、实战案例

- 手写 `RedisCacheStarter`：封装 RedisTemplate 默认配置

> [!warning]
> 待补充

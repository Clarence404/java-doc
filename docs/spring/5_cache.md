---
description: 核心注解、CacheManager 配置、Jackson 3 序列化、SpEL Key、常见陷阱
---

# Cache 抽象

> 前置阅读：[AOP](./2_aop)

Spring Cache 是一层基于 AOP 的缓存抽象：方法上加注解，代理在调用前后读写 `Cache`，存储由 `CacheManager` 决定。本篇讲注解语义与 SpEL Key、Spring Boot 4 下 Redis / Caffeine 的 CacheManager 配置，以及自调用失效、击穿等常见坑。

---

## 一、核心注解

| 注解 | 作用 |
|------|------|
| `@EnableCaching` | 启用缓存注解处理（配置类上） |
| `@Cacheable` | 先查缓存，未命中才执行方法并把结果放入缓存 |
| `@CachePut` | 总是执行方法，并用返回值更新缓存 |
| `@CacheEvict` | 删除缓存条目，`allEntries = true` 清空整个缓存 |
| `@Caching` | 在一个方法上组合多个缓存操作 |
| `@CacheConfig` | 类级别公共配置（`cacheNames`、`keyGenerator`、`cacheManager`） |

- `cacheNames` 与 `value` 互为别名，推荐写 `cacheNames`，语义更清楚
- 一个 `cacheName` 对应 Redis 中的一个 Key 前缀（默认 `users::`），对应 Caffeine 中的一个独立 Cache 实例
- 除了普通返回值，Framework 6.1 起 `@Cacheable` 也支持 `CompletableFuture`、`Mono`、`Flux` 返回类型（需要底层 Cache 支持异步读取，Redis 与 Caffeine 均支持）

---

## 二、CacheManager 配置

### 1、Spring Boot 自动配置

引入 `spring-boot-starter-cache`，再按存储引入 `spring-boot-starter-data-redis` 或 `com.github.ben-manes.caffeine:caffeine`，Boot 会按类路径自动选择 CacheManager，也可以用 `spring.cache.type` 显式指定：

```yaml
spring:
  cache:
    type: redis
    cache-names: users,products
    redis:
      time-to-live: 30m          # 默认 TTL
      cache-null-values: true    # 是否缓存 null，默认 true
      key-prefix: "app:"         # 统一前缀，多应用共用 Redis 时区分
      use-key-prefix: true
```

自动配置的 RedisCacheManager 默认使用 **JDK 序列化**，值不可读且要求实现 `Serializable`，生产上一般换成 JSON 序列化，见下一节。

### 2、Redis CacheManager（Spring Data Redis 4 / Jackson 3）

Boot 4 对应 Spring Data Redis 4.0，默认 JSON 库换成 **Jackson 3**（包名 `tools.jackson`）。原来的 `GenericJackson2JsonRedisSerializer` 被标记为待移除，替代品是 `GenericJacksonJsonRedisSerializer`：

```java
import java.time.Duration;
import java.util.Map;
import org.springframework.boot.cache.autoconfigure.RedisCacheManagerBuilderCustomizer;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.serializer.GenericJacksonJsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext.SerializationPair;
import org.springframework.data.redis.serializer.RedisSerializer;
import tools.jackson.databind.jsontype.BasicPolymorphicTypeValidator;

@Configuration
@EnableCaching
public class RedisCacheConfig {

    @Bean
    public RedisCacheConfiguration redisCacheConfiguration() {
        // 只允许反序列化本项目的类型，避免多态反序列化漏洞
        var typeValidator = BasicPolymorphicTypeValidator.builder()
            .allowIfSubType("com.example.")
            .allowIfSubType("java.util.")
            .allowIfSubType("java.time.")
            .allowIfSubType("java.math.")
            .build();

        RedisSerializer<Object> valueSerializer = GenericJacksonJsonRedisSerializer.builder()
            .enableDefaultTyping(typeValidator)       // 写入 @class 类型信息，读回原类型
            .enableSpringCacheNullValueSupport()      // 允许缓存 null（序列化 NullValue）
            .build();

        return RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofHours(1))
            .serializeKeysWith(SerializationPair.fromSerializer(RedisSerializer.string()))
            .serializeValuesWith(SerializationPair.fromSerializer(valueSerializer));
    }

    // 不同 cacheName 不同 TTL：在自动配置的 RedisCacheManager 上追加，不必自己 new
    @Bean
    public RedisCacheManagerBuilderCustomizer perCacheTtl(RedisCacheConfiguration base) {
        return builder -> builder.withInitialCacheConfigurations(Map.of(
            "users",    base.entryTtl(Duration.ofMinutes(30)),
            "products", base.entryTtl(Duration.ofHours(2)),
            "configs",  base.entryTtl(Duration.ofDays(1))
        ));
    }
}
```

要点：

- **默认类型信息**：旧的 `GenericJackson2JsonRedisSerializer` 默认开启 default typing，新的 `GenericJacksonJsonRedisSerializer` **默认不开启**。不开启时读回来是 `LinkedHashMap`，强转业务类型会抛 `ClassCastException`；需要多态时用 `enableDefaultTyping(validator)`，不要用 `enableUnsafeDefaultTyping()`
- **数据兼容**：Jackson 3 写出的 JSON 可能与 Jackson 2 不同。升级时要么清空缓存，要么在迁移期继续用 `GenericJackson2JsonRedisSerializer` 读旧数据
- **自定义 Bean 的方式**：Boot 发现容器里有 `RedisCacheConfiguration` Bean 会直接用它作为默认配置，此时 `spring.cache.redis.time-to-live` 等属性不再生效（TTL 写在 Bean 里）；按缓存名差异化用 `RedisCacheManagerBuilderCustomizer`。完全自己声明 `RedisCacheManager` 也可以，但自动配置整体退出
- Boot 3.x 项目继续使用 `GenericJackson2JsonRedisSerializer` 即可，写法与上面相同；`RedisCacheManagerBuilderCustomizer` 在 3.x 的包名是 `org.springframework.boot.autoconfigure.cache`

### 3、空值策略与缓存穿透

**缓存 null 是防穿透的手段，而不是反过来。** 不缓存 null 时，查询不存在的 id 每次都会打到数据库：

| 做法 | 效果 | 注意 |
|------|------|------|
| 缓存 null（默认，配合短 TTL） | 不存在的 Key 也命中缓存，挡住穿透 | JSON 序列化需 `enableSpringCacheNullValueSupport()`；TTL 要短，避免数据新增后长时间查不到 |
| `disableCachingNullValues()` | null 不进缓存，穿透直达数据库 | 此时 `@Cacheable` 方法返回 null 会抛 `IllegalArgumentException`，必须加 `unless = "#result == null"` |
| 布隆过滤器前置 | 海量随机 Key 攻击时更省内存 | 见 [缓存最佳实践](/cache/11_cache_rule) 的穿透防护与 [Redis 典型应用场景](/cache/4_redis_scenario) |

### 4、Caffeine CacheManager（本地缓存）

```yaml
spring:
  cache:
    type: caffeine
    cache-names: dict,region
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=600s,recordStats
```

需要按缓存名设置不同策略时，声明 `CaffeineCacheManager` 并逐个 `registerCustomCache`：

```java
@Bean
public CacheManager caffeineCacheManager() {
    CaffeineCacheManager manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
        .maximumSize(1_000)
        .expireAfterWrite(Duration.ofMinutes(10))
        .recordStats());                     // 配合 Actuator 暴露命中率
    manager.registerCustomCache("dict",
        Caffeine.newBuilder().maximumSize(100).expireAfterWrite(Duration.ofHours(1)).build());
    return manager;
}
```

容器里同时有多个 CacheManager 时，用 `@Primary` 指定默认的，注解上用 `cacheManager = "caffeineCacheManager"` 选另一个。Caffeine 的淘汰算法、过期策略、统计见 [Caffeine](/cache/7_caffeine)。

### 5、两级缓存

Spring Cache 本身没有两级缓存实现。需要 Caffeine + Redis 组合时，直接用 JetCache、Redisson 等现成方案，或自定义 `Cache` / `CacheManager` 包装两层并处理 L1 失效广播。读写流程、多实例 L1 一致性与完整实现见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)。

Redis 本身、本地缓存原理、一致性策略见 [缓存总览](/cache/0_overview)。

---

## 三、注解使用示例

```java
@Service
@RequiredArgsConstructor
@CacheConfig(cacheNames = "users")          // 类级别统一缓存名
public class UserService {

    private final UserRepository userRepo;

    // Redis Key：users::1（cacheName 已经是前缀，key 里不必再写 'user::'）
    @Cacheable(key = "#id", unless = "#result == null")
    public UserVO getById(Long id) {
        return userRepo.findById(id).map(UserVO::from).orElse(null);
    }

    // 更新：执行方法并用返回值覆盖缓存
    @CachePut(key = "#user.id")
    public UserVO update(User user) {
        return UserVO.from(userRepo.save(user));
    }

    // 删除单条
    @CacheEvict(key = "#id")
    public void delete(Long id) {
        userRepo.deleteById(id);
    }

    // 组合：删除用户详情 + 清空列表缓存
    @Caching(evict = {
        @CacheEvict(key = "#userId"),
        @CacheEvict(cacheNames = "userList", allEntries = true)
    })
    public void deleteUser(Long userId) {
        userRepo.deleteById(userId);
    }
}
```

> 原写法 `key = "'user::' + #id"` 叠加默认前缀会得到 `users::user::1`，信息冗余。确实需要自定义前缀格式时，用 `RedisCacheConfiguration.computePrefixWith(name -> "app:" + name + ":")` 统一处理。

更新时用 `@CachePut` 还是 `@CacheEvict`：数据库更新后**删除缓存**（Cache Aside）在并发下更安全，`@CachePut` 适合「返回值就是最新完整对象」的场景。两者的并发问题与延迟双删见 [缓存一致性](/cache/10_cache_consistency)。

---

## 四、SpEL Key 表达式

| 表达式 | 说明 | 示例 |
|--------|------|------|
| `#参数名` / `#p0` / `#a0` | 方法参数（按名称或下标） | `#id`、`#p0` |
| `#参数.属性` | 参数的属性 | `#user.id` |
| `#result` | 方法返回值 | 可用于 `unless`、`@CachePut` 的 key、`beforeInvocation = false` 的 `@CacheEvict`；**不能用于 `condition` 和 `@Cacheable` 的 key** |
| `'字面量'` | 固定字符串 | `'list'` |
| `#root.methodName` | 方法名 | |
| `#root.args[0]` | 第一个参数 | |
| `#root.caches[0].name` | 当前缓存名 | |

`condition` 在方法执行**前**求值（不满足就不走缓存），`unless` 在方法执行**后**求值（满足就不放入缓存）：

```java
// 组合 key
@Cacheable(cacheNames = "products", key = "#category + ':' + #page + ':' + #size")
public Page<Product> listByCategory(String category, int page, int size) { ... }

// condition：只有 id > 0 才走缓存
@Cacheable(cacheNames = "users", key = "#id", condition = "#id > 0")
public UserVO getByIdIfPositive(Long id) { ... }

// unless：结果为 null 或已逻辑删除时不缓存
@Cacheable(cacheNames = "users", key = "#id", unless = "#result == null || #result.deleted")
public UserVO getActiveById(Long id) { ... }
```

> 按参数名引用（`#id`）依赖编译参数 `-parameters`。Framework 6.1 移除了基于调试信息的 `LocalVariableTableParameterNameDiscoverer`，没有 `-parameters` 时参数名取不到，`#id` 求值为 null。继承 `spring-boot-starter-parent` 或使用 Boot Gradle 插件会自动开启；自己管理构建时需显式加上，或改用 `#p0`。

---

## 五、自定义 KeyGenerator

不写 `key` 时使用 `SimpleKeyGenerator`：无参返回 `SimpleKey.EMPTY`，单参数直接用参数本身，多参数组合成 `SimpleKey`。它**不包含方法名**，同一 cacheName 下两个参数相同的方法会互相覆盖，所以要么显式写 `key`，要么自定义 KeyGenerator：

```java
@Component("methodArgsKeyGenerator")
public class MethodArgsKeyGenerator implements KeyGenerator {

    @Override
    public Object generate(Object target, Method method, Object... params) {
        // 格式：类名:方法名:参数1:参数2
        return target.getClass().getSimpleName() + ":"
             + method.getName() + ":"
             + Arrays.stream(params).map(String::valueOf).collect(Collectors.joining(":"));
    }
}

@Cacheable(cacheNames = "reports", keyGenerator = "methodArgsKeyGenerator")
public ReportVO generateReport(String type, LocalDate start, LocalDate end) { ... }
```

`key` 与 `keyGenerator` 互斥，同时指定会在启动时报错。

---

## 六、常见陷阱

### 1、自调用不走缓存

缓存注解靠代理生效，同一个类里 `this.getById(id)` 不经过代理，缓存完全不起作用；`private` 方法同理。原因与解决办法和事务一致，见 [AOP · 自调用失效问题](./2_aop)。

### 2、热点 Key 击穿：sync = true

热点 Key 过期瞬间，大量并发请求同时未命中，全部打到数据库：

```java
@Cacheable(cacheNames = "hot", key = "#id", sync = true)
public ProductVO getHot(Long id) { ... }
```

- `sync = true` 让同一 Key 的加载串行化，只有一个线程执行方法，其他线程等待结果
- 限制：不能和 `unless` 一起用，且同一方法上只能有这一个缓存操作
- 锁的范围取决于 Cache 实现：Caffeine 是进程内锁；RedisCache 的同步也是**单 JVM 内**的，多实例仍会各自回源一次，跨实例互斥需要分布式锁或逻辑过期，见 [缓存最佳实践](/cache/11_cache_rule)

### 3、雪崩：TTL 加随机抖动

大批 Key 用相同 TTL 同时写入，会同时过期。RedisCacheManager 支持按条目计算 TTL：

```java
RedisCacheConfiguration.defaultCacheConfig()
    .entryTtl((key, value) -> Duration.ofMinutes(30)
        .plusSeconds(ThreadLocalRandom.current().nextInt(0, 300)));   // 30 分钟 + 0~5 分钟抖动
```

缓存 TTL、大 Key、命名等规范见 [缓存最佳实践](/cache/11_cache_rule)。

### 4、@CacheEvict 的时机与事务

- 默认 `beforeInvocation = false`：方法**成功返回后**才删除，方法抛异常则不删除
- `beforeInvocation = true`：方法执行前删除，无论成功失败都会删
- 在 `@Transactional` 方法里删缓存，删除通常发生在**事务提交之前**：提交前的窗口内其他线程可能把旧值重新读回缓存。要求严格时把删缓存放到事务提交之后，例如用 `@TransactionalEventListener(phase = AFTER_COMMIT)`（见 [事件机制](./7_event)），或给 `RedisCacheManager` 开启 `transactionAware()`，让 put / evict 延迟到提交后执行

### 5、缓存对象被修改

Caffeine 存的是对象引用，调用方修改返回对象会直接改掉缓存里的值；Redis 每次反序列化出新对象，没有这个问题。本地缓存的值对象应设计为不可变（record）或返回副本。

---

## 小结

- Spring Cache 是基于代理的抽象，注解决定「何时读写」，`CacheManager` 决定「存在哪」
- Boot 4 / Spring Data Redis 4 改用 Jackson 3：用 `GenericJacksonJsonRedisSerializer`，它默认不写类型信息，需要时用带校验器的 `enableDefaultTyping`；升级注意旧缓存数据兼容
- 缓存 null（短 TTL）是防穿透手段；关闭 null 缓存时必须配 `unless = "#result == null"`
- cacheName 已是 Key 前缀，key 里不要重复写前缀；按参数名写 SpEL 依赖 `-parameters`
- 常见坑：自调用失效、热点击穿用 `sync = true`（仅进程内）、TTL 加抖动防雪崩、事务内删缓存的时机
- 两级缓存不在 Spring Cache 内实现，见缓存模块

## 参考资料

- Spring Framework Cache Abstraction：[https://docs.spring.io/spring-framework/reference/integration/cache.html](https://docs.spring.io/spring-framework/reference/integration/cache.html)
- Spring Boot Caching：[https://docs.spring.io/spring-boot/reference/io/caching.html](https://docs.spring.io/spring-boot/reference/io/caching.html)
- Spring Data Redis 升级说明（Jackson 3）：[https://docs.spring.io/spring-data/redis/reference/upgrading.html](https://docs.spring.io/spring-data/redis/reference/upgrading.html)

> 下一篇：[Retry 重试](./6_retry) —— Framework 7 内置 `@Retryable` 与并发限制，远程调用失败如何按退避策略自动重试。

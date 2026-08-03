# Spring Cache 抽象

> 参考资料：
> * Spring 官方文档 - Cache：[https://docs.spring.io/spring-framework/reference/integration/cache.html](https://docs.spring.io/spring-framework/reference/integration/cache.html)
> * Spring Cache + Redis：[https://www.baeldung.com/spring-cache-tutorial](https://www.baeldung.com/spring-cache-tutorial)

## 一、核心注解

| 注解 | 作用 |
|------|------|
| `@Cacheable` | 查询时先查缓存，缓存未命中才执行方法，结果存入缓存 |
| `@CachePut` | 每次都执行方法，结果更新到缓存（用于更新操作） |
| `@CacheEvict` | 执行后清除缓存（用于删除操作） |
| `@Caching` | 组合多个缓存操作 |
| `@EnableCaching` | 启用缓存功能（启动类或配置类上） |

---

## 二、CacheManager 配置

### 2.1 Redis CacheManager（分布式缓存）

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        // 默认缓存配置（1 小时过期）
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofHours(1))
            .serializeKeysWith(
                RedisSerializationContext.SerializationPair.fromSerializer(new StringRedisSerializer()))
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair.fromSerializer(
                    new GenericJackson2JsonRedisSerializer()))
            .disableCachingNullValues();   // null 值不缓存（防止缓存穿透）

        // 不同缓存名称配置不同 TTL
        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "users",    defaultConfig.entryTtl(Duration.ofMinutes(30)),
            "products", defaultConfig.entryTtl(Duration.ofHours(2)),
            "configs",  defaultConfig.entryTtl(Duration.ofDays(1))
        );

        return RedisCacheManager.builder(connectionFactory)
            .cacheDefaults(defaultConfig)
            .withInitialCacheConfigurations(cacheConfigs)
            .build();
    }
}
```

### 2.2 Caffeine CacheManager（本地缓存）

```java
@Bean
@Primary
public CacheManager caffeineCacheManager() {
    CaffeineCacheManager manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
        .initialCapacity(100)
        .maximumSize(1000)
        .expireAfterWrite(10, TimeUnit.MINUTES)
        .recordStats());   // 开启统计（命中率等）
    return manager;
}
```

```yaml
# 或用 application.yml 配置 Caffeine
spring:
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=600s
```

---

## 三、注解使用示例

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepo;

    // 查询：key = "user::{id}"
    @Cacheable(value = "users", key = "'user::' + #id", unless = "#result == null")
    public UserVO getById(Long id) {
        return userRepo.findById(id).map(this::toVO).orElse(null);
    }

    // 更新：执行方法并更新缓存
    @CachePut(value = "users", key = "'user::' + #user.id")
    public UserVO update(User user) {
        userRepo.save(user);
        return toVO(user);
    }

    // 删除：清除单条缓存
    @CacheEvict(value = "users", key = "'user::' + #id")
    public void delete(Long id) {
        userRepo.deleteById(id);
    }

    // 删除：清除整个 users 命名空间
    @CacheEvict(value = "users", allEntries = true)
    public void clearAll() { }

    // 组合操作：同时清除多个缓存
    @Caching(evict = {
        @CacheEvict(value = "users",    key = "'user::' + #userId"),
        @CacheEvict(value = "userList", allEntries = true)
    })
    public void deleteUser(Long userId) {
        userRepo.deleteById(userId);
    }
}
```

---

## 四、SpEL Key 表达式

| 表达式 | 说明 | 示例 |
|--------|------|------|
| `#参数名` | 方法参数 | `#id` → 参数 `id` 的值 |
| `#参数.属性` | 参数的属性 | `#user.id` |
| `#result` | 方法返回值（仅 @CachePut / unless） | `#result.id` |
| `'字面量'` | 固定字符串 | `'prefix::'` |
| `#root.method.name` | 方法名 | |
| `#root.args[0]` | 第一个参数 | |

```java
// 组合 key
@Cacheable(value = "products", key = "#category + ':' + #page + ':' + #size")
public Page<Product> listByCategory(String category, int page, int size) { ... }

// 条件缓存（只有 id > 0 才缓存）
@Cacheable(value = "users", key = "#id", condition = "#id > 0")
public UserVO getById(Long id) { ... }

// unless（结果满足条件时不缓存）
@Cacheable(value = "users", key = "#id", unless = "#result == null || #result.deleted")
public UserVO getById(Long id) { ... }
```

---

## 五、自定义 KeyGenerator

```java
@Component("methodArgsKeyGenerator")
public class MethodArgsKeyGenerator implements KeyGenerator {

    @Override
    public Object generate(Object target, Method method, Object... params) {
        // 格式：类名:方法名:参数1:参数2
        return target.getClass().getSimpleName() + ":"
             + method.getName() + ":"
             + Arrays.stream(params)
                     .map(String::valueOf)
                     .collect(Collectors.joining(":"));
    }
}

// 使用自定义 KeyGenerator
@Cacheable(value = "reports", keyGenerator = "methodArgsKeyGenerator")
public ReportVO generateReport(String type, LocalDate start, LocalDate end) { ... }
```

---

## 六、两级缓存架构（Caffeine + Redis）

本地缓存（Caffeine）+ 分布式缓存（Redis）组合，兼顾性能与一致性：

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class TwoLevelCacheService {

    @Qualifier("caffeineCacheManager")
    private final CacheManager localCacheManager;

    @Qualifier("redisCacheManager")
    private final CacheManager remoteCacheManager;

    public <T> T get(String cacheName, String key, Supplier<T> loader, Class<T> type) {
        // 1. 先查 L1（本地）
        Cache localCache = localCacheManager.getCache(cacheName);
        T value = localCache != null ? localCache.get(key, type) : null;
        if (value != null) {
            log.debug("L1 命中: {}/{}", cacheName, key);
            return value;
        }

        // 2. 再查 L2（Redis）
        Cache remoteCache = remoteCacheManager.getCache(cacheName);
        value = remoteCache != null ? remoteCache.get(key, type) : null;
        if (value != null) {
            log.debug("L2 命中: {}/{}", cacheName, key);
            if (localCache != null) localCache.put(key, value);  // 回填 L1
            return value;
        }

        // 3. 查数据库
        value = loader.get();
        if (value != null) {
            if (localCache  != null) localCache.put(key, value);
            if (remoteCache != null) remoteCache.put(key, value);
        }
        return value;
    }
}
```

> 完整的两级缓存方案详见：[缓存模块 → 两级缓存架构](/cache/0_redis_base)

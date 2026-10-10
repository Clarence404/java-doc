---
description: 两级缓存架构、Lettuce 配置、方法注解、QuickConfig 编程式 API、多实例同步
---

# JetCache

> 前置阅读：[Caffeine](./7_caffeine)、[两级缓存（L1 + L2）](./8_two_level_cache)

JetCache 是阿里开源的 Java 缓存框架，在 Spring Cache 风格注解上补了两级缓存、自动刷新等能力。本篇讲注解、编程式 API、多实例同步和与 Spring Cache 的取舍，基线为 2.7。

---

## 一、架构与能力

写作时最新稳定版为 2.7.8，2.8 处于 RC 阶段；JetCache 还提供空值缓存、加载合并与统计等能力。

![JetCache 架构](../assets/cache/jetcache_arch.svg)

| 能力 | 用法 | 说明 |
|------|------|------|
| 方法缓存 | `@Cached` | 类似 `@Cacheable`，可选 `LOCAL` / `REMOTE` / `BOTH` |
| 更新 / 删除 | `@CacheUpdate` / `@CacheInvalidate` | 类似 `@CachePut` / `@CacheEvict` |
| 自动刷新 | `@CacheRefresh` | 定时异步刷新，长时间无访问后停止刷新 |
| 加载合并 | `@CachePenetrationProtect` | 同一 key 在本 JVM 内只有一个线程回源 |
| 空值缓存 | `@Cached(cacheNullValue = true)` | 防缓存穿透 |
| 两级缓存 | `cacheType = CacheType.BOTH` | 本地 + 远程，`localExpire` 可单独设本地 TTL |
| 多实例 L1 同步 | `broadcastChannel` / `syncLocal(true)` | 2.7 起提供，**默认不开启** |
| 编程式 API | `CacheManager.getOrCreateCache(QuickConfig)` | 替代已废弃的 `@CreateCache` |
| 统计 | `statIntervalMinutes` | 定期输出命中率等统计日志 |

---

## 二、接入与配置

2.7 起 `@CreateCache` 与 `@EnableCreateCacheAnnotation` 已废弃；在 Spring Boot 4 上使用前，先在官方 Release 与 Issue 中确认兼容性。

### 1、依赖

```xml
<dependency>
    <groupId>com.alicp.jetcache</groupId>
    <artifactId>jetcache-starter-redis-lettuce</artifactId>
    <version>2.7.8</version>
</dependency>
```

### 2、配置（Lettuce）

```yaml
jetcache:
  statIntervalMinutes: 15            # 统计日志输出间隔（分钟），0 表示不统计
  areaInCacheName: false
  local:
    default:
      type: caffeine
      limit: 1000                    # 每个本地缓存实例的最大条数
      keyConvertor: fastjson2
      expireAfterWriteInMillis: 100000
  remote:
    default:
      type: redis.lettuce
      keyConvertor: fastjson2
      broadcastChannel: order-service    # 开启 BOTH 缓存的跨实例 L1 失效，不配置则不同步
      valueEncoder: java
      valueDecoder: java
      uri: redis://127.0.0.1:6379/
      # 集群：mode: cluster，uri 写成节点列表
```

- Lettuce 使用单连接多路复用，**不需要也不支持** `poolConfig`；`poolConfig` 只对 `type: redis`（Jedis）有效
- `keyConvertor: fastjson2` 需要工程中有 fastjson2 依赖；方法缓存必须配置 key 转换器
- `valueEncoder` 在 2.7 中可选 `java` / `kryo`：`java` 要求值实现 `Serializable`，体积较大且只能被 Java 读取；`kryo` 更紧凑，需要额外引入 Kryo 依赖。2.8 起默认开启反序列化安全过滤，使用 `java` 编码时要通过 `decodeFilterAllowPatterns` 放行自己的类
- `broadcastChannel` 是 Redis Pub/Sub 频道名，同一业务的所有实例配置相同的值

### 3、启用方法缓存

```java
@SpringBootApplication
@EnableMethodCache(basePackages = "com.example")
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

不再需要 `@EnableCreateCacheAnnotation`（2.7 起已废弃）。

---

## 三、方法注解

```java
@Service
public class UserService {

    // 两级缓存：远程 10 分钟、本地 30 秒；缓存空值防穿透；本 JVM 内同 key 只回源一次
    @Cached(name = "user:", key = "#id", expire = 600, localExpire = 30,
            cacheType = CacheType.BOTH, cacheNullValue = true)
    @CachePenetrationProtect
    public User getUser(long id) {
        return userDao.findById(id);
    }

    // 删除缓存
    @CacheInvalidate(name = "user:", key = "#id")
    public void evictUser(long id) {
    }

    // 热点列表：每 60 秒异步刷新，超过 120 秒无访问停止刷新
    @Cached(name = "product:hot", expire = 3600, cacheType = CacheType.BOTH)
    @CacheRefresh(refresh = 60, stopRefreshAfterLastAccess = 120, timeUnit = TimeUnit.SECONDS)
    public List<Product> getHotProducts() {
        return productDao.getHotList();
    }
}
```

- **只删不更新**：数据更新优先 `@CacheInvalidate`（Cache Aside），`@CacheUpdate` 在并发写时可能把旧值写回，原因见 [缓存一致性](./10_cache_consistency)
- **删缓存要在事务提交之后**：把 `@CacheInvalidate` 和 `@Transactional` 放在同一个方法上，删除可能发生在提交之前，提交前的窗口里旧值会被读回。做法是在事务提交后的监听器里调用 `evictUser`（另一个 Bean 调用才会走代理），或用编程式 API 在 `AFTER_COMMIT` 中删除
- **`@CacheRefresh` 的刷新**：`REMOTE` / `BOTH` 下会用分布式锁保证同一时刻只有一个实例刷新（`refreshLockTimeout` 默认 60 秒）
- **`@CachePenetrationProtect`** 只在单 JVM 内合并加载，多实例仍会各自回源一次
- **代理限制**：注解基于 Spring AOP，同类内部调用（`this.getUser()`）不走缓存；注解也可以写在接口上
- **SpEL 参数名**：`#id` 依赖编译参数 `-parameters`（Spring Boot 的父 POM 默认开启），否则改用 `args[0]`
- **远程操作可能失败**：`@CacheUpdate` / `@CacheInvalidate` 访问 Redis 失败时不会重试，务必设置 `expire` 让脏数据最终过期

---

## 四、编程式 API

```java
@Service
public class OrderCacheService {

    private final CacheManager cacheManager;        // com.alicp.jetcache.CacheManager
    private final OrderDao orderDao;
    private Cache<Long, Order> orderCache;

    public OrderCacheService(CacheManager cacheManager, OrderDao orderDao) {
        this.cacheManager = cacheManager;
        this.orderDao = orderDao;
    }

    @PostConstruct
    public void init() {
        QuickConfig qc = QuickConfig.newBuilder("order:")
                .expire(Duration.ofSeconds(200))
                .cacheType(CacheType.BOTH)          // 两级缓存
                .syncLocal(true)                    // 更新后让所有实例的本地缓存失效（需配置 broadcastChannel）
                .build();
        orderCache = cacheManager.getOrCreateCache(qc);
    }

    public Order get(long orderId) {
        return orderCache.computeIfAbsent(orderId, orderDao::findById);
    }

    public void evict(long orderId) {
        orderCache.remove(orderId);
    }
}
```

`@CreateCache` 字段注入的写法自 2.7 起废弃，统一改为上面的 `CacheManager.getOrCreateCache(QuickConfig)`。

---

## 五、多实例本地缓存同步

`CacheType.BOTH` 并不会自动同步各实例的本地缓存：

- **未配置 `broadcastChannel`**：一个实例更新或删除缓存，只影响自己的 L1 和远程 L2，其他实例的 L1 直到本地过期才会更新
- **配置 `broadcastChannel`**：更新或删除后通过 Redis Pub/Sub 通知其他实例删除 L1；编程式缓存还要在 `QuickConfig` 上设置 `syncLocal(true)`
- **Pub/Sub 不持久化**：实例断线、重启期间的通知会丢失，所以 `localExpire` 仍要设置得较短，作为兜底

这与 [两级缓存（L1 + L2）](./8_two_level_cache) 中的「广播失效 + L1 短 TTL」是同一套思路，只是由框架代劳。

---

## 六、与 Spring Cache 对比

| 维度 | JetCache | Spring Cache |
|------|----------|--------------|
| 两级缓存 | `CacheType.BOTH` 原生支持 | 无内置实现，需自定义 `CacheManager` |
| 跨实例 L1 失效 | `broadcastChannel`，需显式配置 | 需自行实现 |
| 自动刷新 | `@CacheRefresh`，远程缓存下用分布式锁协调 | Caffeine 配 `CacheLoader` 可用 `refreshAfterWrite`，仅限本地 |
| 防击穿 | `@CachePenetrationProtect`（单 JVM） | `@Cacheable(sync = true)`（单 JVM） |
| 每个缓存单独设置 TTL | 注解上直接写 `expire` | 需在 `CacheManager` 中按缓存名配置 |
| 统计监控 | 内置统计日志 | Actuator + Micrometer 暴露命中、未命中、淘汰等指标 |
| key 表达式 | SpEL | SpEL |
| 维护情况 | 社区项目，发版节奏较慢 | Spring 官方，随 Spring 版本演进 |

**选型建议**：需要两级缓存、每个方法单独 TTL、远程缓存定时刷新时，JetCache 能省掉大量样板代码；只用单层缓存或团队希望少引入第三方框架时，Spring Cache（见 [Cache 抽象](/spring/5_cache)）足够。引入 JetCache 前评估其发版活跃度与 Spring Boot 版本兼容性。

---

## 小结

- JetCache = 注解 / 编程式入口 + 统一 Cache 接口 + 本地 / 远程两级实现
- 2.7 起 `@CreateCache` 废弃，用 `CacheManager.getOrCreateCache(QuickConfig)` 创建编程式缓存
- Lettuce 远程缓存不配置 `poolConfig`；`keyConvertor`、`valueEncoder` 的依赖与序列化取舍要明确
- `CacheType.BOTH` 的跨实例 L1 失效必须配置 `broadcastChannel`（编程式另加 `syncLocal(true)`），并保留较短的 `localExpire` 兜底
- 更新数据优先删缓存，且删除放在事务提交之后
- `cacheNullValue` 防穿透、`@CachePenetrationProtect` 防单 JVM 内击穿

## 参考资料

- JetCache GitHub：[https://github.com/alibaba/jetcache](https://github.com/alibaba/jetcache)
- JetCache 文档 · Configuration：[https://github.com/alibaba/jetcache/blob/master/docs/EN/Config.md](https://github.com/alibaba/jetcache/blob/master/docs/EN/Config.md)
- JetCache 文档 · Method cache：[https://github.com/alibaba/jetcache/blob/master/docs/EN/MethodCache.md](https://github.com/alibaba/jetcache/blob/master/docs/EN/MethodCache.md)
- JetCache 文档 · CreateCache（废弃说明与 QuickConfig）：[https://github.com/alibaba/jetcache/blob/master/docs/EN/CreateCache.md](https://github.com/alibaba/jetcache/blob/master/docs/EN/CreateCache.md)
- JetCache 文档 · Redis with Lettuce：[https://github.com/alibaba/jetcache/blob/master/docs/EN/RedisWithLettuce.md](https://github.com/alibaba/jetcache/blob/master/docs/EN/RedisWithLettuce.md)

> 下一篇：[缓存一致性](./10_cache_consistency) —— Cache Aside 等缓存模式的一致性边界，以及提交后删除、延迟双删与 binlog 订阅失效。

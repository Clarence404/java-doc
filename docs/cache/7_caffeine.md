---
description: W-TinyLFU、三种 Cache 用法、过期与刷新、容量控制、Spring Boot 集成、监控指标
---

# Caffeine

> **本篇目标**：理解 Caffeine 的 W-TinyLFU 淘汰机制，会正确使用 `Cache` / `LoadingCache` / `AsyncLoadingCache`，分清过期与刷新，并知道 Spring Boot 在什么条件下用 Caffeine 作为缓存实现。
>
> **前置阅读**：[集合框架](/java/21_topic_collection)（LinkedHashMap 一节）、[Cache 抽象](/spring/5_cache)

Caffeine 是 Java 的高性能进程内缓存库，借鉴了 Guava Cache 和 ConcurrentLinkedHashMap 的设计并重新实现，提供与 Guava 兼容的 API 适配层。Guava 官方也建议新项目改用 Caffeine。

**版本基线**：Caffeine 3.x（3.0 起要求 Java 11+，2.x 是 Java 8 的版本线），版本号通常交给 Spring Boot 依赖管理。

---

## 一、核心特性

- **W-TinyLFU 淘汰**：兼顾访问频率与最近访问，在多数访问轨迹上命中率明显优于 LRU，接近理论最优
- **低锁竞争**：数据存放在 `ConcurrentHashMap` 中，读写事件先写入分段缓冲区，淘汰、过期等维护工作在锁内异步批量执行，读路径几乎不阻塞
- **丰富的策略**：按条数或权重限容、写后 / 访问后 / 自定义过期、异步刷新、弱 / 软引用、统计
- **同 key 加载合并**：`get(key, loader)` 对同一个 key 只执行一次加载，其他线程等待结果

### 1、W-TinyLFU 结构

![W-TinyLFU 结构：窗口区、频率准入过滤、分段主区](../assets/cache/caffeine_wtinylfu.svg)

- **窗口区（Window LRU，约占 1%）**：新数据先进入窗口，给突发的新热点一个积累频率的机会
- **TinyLFU 准入**：窗口淘汰出的候选者与主区的淘汰候选者比较访问频率，频率高的留下；频率用 Count-Min Sketch 近似统计，每个计数只占 4 bit，并定期减半实现「老化」
- **主区（Segmented LRU）**：分为试用区（probation）与保护区（protected），再次命中的数据晋升到保护区
- 窗口区比例会根据命中率自适应调整（hill climbing），以适配偏重最近性或偏重频率的负载

LRU 只看最近访问，一次全表扫描就能把真正的热点挤出去；W-TinyLFU 用频率做准入，扫描流量很难进入主区。

---

## 二、基本使用

### 1、引入依赖

```xml
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
    <!-- Spring Boot 已管理版本，通常无需指定 -->
</dependency>
```

### 2、Cache：手动读写

```java
Cache<String, User> cache = Caffeine.newBuilder()
        .maximumSize(1_000)                          // 最多 1000 条
        .expireAfterWrite(Duration.ofMinutes(10))    // 写入 10 分钟后过期
        .recordStats()                               // 开启统计
        .build();

cache.put("user:1", user);
User cached = cache.getIfPresent("user:1");          // 不存在返回 null

// 未命中时执行加载函数，同一 key 并发调用只加载一次；函数返回 null 时不缓存
User loaded = cache.get("user:1", key -> userDao.findById(1L));
```

### 3、LoadingCache：绑定加载函数

```java
LoadingCache<Long, User> loadingCache = Caffeine.newBuilder()
        .maximumSize(1_000)
        .refreshAfterWrite(Duration.ofMinutes(5))    // 写入 5 分钟后，下一次访问触发异步刷新
        .expireAfterWrite(Duration.ofMinutes(10))    // 10 分钟没刷新成功则过期
        .build(id -> userDao.findById(id));          // CacheLoader

User user = loadingCache.get(1L);
Map<Long, User> users = loadingCache.getAll(List.of(1L, 2L, 3L));
```

### 4、AsyncLoadingCache：异步加载

```java
AsyncLoadingCache<Long, User> asyncCache = Caffeine.newBuilder()
        .maximumSize(1_000)
        .expireAfterWrite(Duration.ofMinutes(10))
        // AsyncCacheLoader：自己返回 CompletableFuture，并使用 Caffeine 传入的 executor
        .buildAsync((id, executor) -> CompletableFuture.supplyAsync(() -> userDao.findById(id), executor));

CompletableFuture<User> future = asyncCache.get(1L);
```

`buildAsync` 也接受普通的 `CacheLoader`（如 `.buildAsync(id -> userDao.findById(id))`），Caffeine 会把它放到默认的 `ForkJoinPool.commonPool()` 执行；加载涉及阻塞 IO 时，用 `.executor(...)` 指定专用线程池。

---

## 三、过期与刷新

| 策略 | 方法 | 说明 |
|------|------|------|
| 写后过期 | `expireAfterWrite(Duration)` | 写入后固定时间过期，无论是否被读 |
| 访问后过期 | `expireAfterAccess(Duration)` | 最后一次读 / 写后经过指定时间过期 |
| 自定义过期 | `expireAfter(Expiry)` | 每个条目单独计算过期时间 |
| 异步刷新 | `refreshAfterWrite(Duration)` | 写入超过指定时间后，**下一次访问**触发异步重载，期间返回旧值 |

**过期与刷新的区别**：

- 过期是删除：条目过期后访问会同步等待加载
- 刷新不删除：到达刷新间隔后不会主动刷新，而是在下一次访问时触发异步重载，重载完成前读到旧值；刷新失败时保留旧值
- 刷新需要加载函数，只能用于 `LoadingCache` / `AsyncLoadingCache`
- 同时配置时让 `refreshAfterWrite` 小于 `expireAfterWrite`：常被访问的条目靠刷新保持新鲜，长期不访问的条目靠过期回收
- `expireAfterWrite` 与 `expireAfterAccess` 可以同时设置，任一满足即过期

**过期清理的时机**：Caffeine 默认在读写操作时顺带清理过期条目，长时间没有访问的缓存里过期条目会滞留。需要准时清理（例如配合 `removalListener` 做资源释放）时，配置 `.scheduler(Scheduler.systemScheduler())`。

---

## 四、容量控制

```java
// 按条数
Cache<Long, User> byCount = Caffeine.newBuilder()
        .maximumSize(10_000)
        .build();

// 按权重：权重由 weigher 估算，单位由业务自定
Cache<String, byte[]> byWeight = Caffeine.newBuilder()
        .maximumWeight(64L * 1024 * 1024)                     // 约 64 MB 的 value 字节数
        .weigher((String key, byte[] value) -> value.length)
        .build();
```

- `maximumSize` 与 `maximumWeight` 只能二选一
- 权重是业务估算值，不等于真实堆占用：对象头、引用、Map 节点的开销都不计入，按权重限容时要留余量
- `weakKeys()` 让 key 按 `==` 比较，字符串、Long 等值类型 key 基本无法命中，一般不要用
- `softValues()` 让 GC 决定何时回收缓存，内存紧张时会引发频繁 Full GC，生产环境优先用明确的容量上限

---

## 五、Spring Boot 集成

Spring Boot 在**没有用户自定义 `CacheManager`** 时按固定顺序探测缓存实现：Generic → JCache → Hazelcast → Infinispan → Couchbase → Redis → Caffeine → Cache2k → Simple。也就是说：

- 只引入 Caffeine 时，自动配置 `CaffeineCacheManager`
- 同时引入了 Redis 时，Redis 排在前面会被优先选中，需要 `spring.cache.type=caffeine` 显式指定
- 什么都没引入时用 `simple`（基于 `ConcurrentHashMap`，没有过期与容量控制，不适合生产）

下面两种配置方式**二选一**：

### 1、方式一：保留自动配置

```yaml
spring:
  cache:
    type: caffeine
    cache-names: users,products
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=600s,recordStats
```

也可以不写 `spec`，改为声明一个 `Caffeine` 或 `CaffeineSpec` Bean，自动配置会使用它（优先级：`spec` 属性 > `CaffeineSpec` Bean > `Caffeine` Bean）：

```java
@Bean
public Caffeine<Object, Object> caffeineConfig() {
    return Caffeine.newBuilder()
            .maximumSize(1_000)
            .expireAfterWrite(Duration.ofMinutes(10))
            .recordStats();
}
```

需要 `refreshAfterWrite` 时再声明一个 `CacheLoader<Object, Object>` Bean，自动配置只识别这个泛型。

### 2、方式二：自定义 CacheManager（每个缓存不同策略）

```java
@Configuration
@EnableCaching
public class CaffeineCacheConfig {

    @Bean
    public CacheManager cacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager();
        manager.setCaffeine(Caffeine.newBuilder()                 // 未单独注册的缓存使用的默认策略
                .maximumSize(1_000)
                .expireAfterWrite(Duration.ofMinutes(10))
                .recordStats());
        manager.registerCustomCache("users", Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofMinutes(30))
                .recordStats()
                .build());
        return manager;
    }
}
```

自定义 `CacheManager` 后自动配置整体失效，`spring.cache.caffeine.spec` 不再生效。`@Cacheable` 等注解的用法、`sync = true` 防击穿、`@CacheEvict` 与事务的时机见 [Cache 抽象](/spring/5_cache)。

---

## 六、统计与监控

```java
CacheStats stats = cache.stats();     // 需要在构建时 recordStats()
stats.hitRate();                      // 命中率
stats.evictionCount();                // 淘汰次数
stats.averageLoadPenalty();           // 平均加载耗时（纳秒）
```

生产环境不要手工打印统计，而是接入 Micrometer：

- 通过 `CacheManager` 管理、且启动时已存在的缓存，Spring Boot Actuator 会自动注册 `cache.gets`、`cache.puts`、`cache.evictions` 等指标
- 手动创建的缓存用 `CaffeineCacheMetrics.monitor(meterRegistry, cache, "userLocalCache")` 绑定
- 不开启 `recordStats()` 时命中率类指标为空

---

## 七、并发加载与击穿

`cache.get(key, loader)` 和 `LoadingCache.get(key)` 会对**同一个 key** 合并并发加载：只有一个线程执行加载函数，其余线程等待结果，这在单个 JVM 内天然防止了缓存击穿。注意两点：

- 合并只在**单个 JVM 内**有效，N 个实例仍会各自回源一次；跨实例的互斥重建见 [缓存最佳实践](./11_cache_rule)
- 加载函数在 `ConcurrentHashMap.compute` 内执行，耗时长会阻塞同一哈希桶的其他写操作，且加载函数内**不能再操作同一个缓存**（递归加载会抛异常或死锁），慢加载优先用 `AsyncLoadingCache`

另外 Caffeine 缓存的是对象引用，调用方修改返回对象会直接改掉缓存中的值，值对象应设计为不可变（如 record）。

---

## 小结

- Caffeine 3.x 需要 Java 11+，W-TinyLFU 以频率准入，抗扫描、命中率接近最优
- 读写通过缓冲区异步维护，锁竞争很低，并不是「无锁」
- `refreshAfterWrite` 在下一次访问时异步刷新、返回旧值，需配合加载函数，并小于 `expireAfterWrite`
- 权重是估算值，`weakKeys` / `softValues` 一般不用
- Spring Boot 只在没有更靠前的缓存实现（如 Redis）时才自动选用 Caffeine；`spec` 配置与自定义 `CacheManager` 二选一
- 监控交给 Micrometer；同 key 加载合并只在单 JVM 内有效

## 参考资料

- Caffeine GitHub：[https://github.com/ben-manes/caffeine](https://github.com/ben-manes/caffeine)
- Caffeine Wiki · Efficiency（W-TinyLFU 与命中率）：[https://github.com/ben-manes/caffeine/wiki/Efficiency](https://github.com/ben-manes/caffeine/wiki/Efficiency)
- Caffeine Wiki · Refresh：[https://github.com/ben-manes/caffeine/wiki/Refresh](https://github.com/ben-manes/caffeine/wiki/Refresh)
- Caffeine Wiki · Eviction：[https://github.com/ben-manes/caffeine/wiki/Eviction](https://github.com/ben-manes/caffeine/wiki/Eviction)
- Spring Boot Reference · Caching：[https://docs.spring.io/spring-boot/reference/io/caching.html](https://docs.spring.io/spring-boot/reference/io/caching.html)
- TinyLFU 论文（Einziger, Friedman, Manes）：[https://arxiv.org/abs/1512.00727](https://arxiv.org/abs/1512.00727)

> 下一篇：[两级缓存（L1 + L2）](./8_two_level_cache) —— Caffeine + Redis 组合的读写流程，以及多实例下如何让本地缓存失效。

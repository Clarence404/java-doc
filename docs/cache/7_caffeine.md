# Caffeine

官方仓库：[https://github.com/ben-manes/caffeine](https://github.com/ben-manes/caffeine)

Caffeine 是 Java 本地缓存库（进程内缓存），基于 Google Guava Cache 重写，性能接近最优理论值，是 Spring Boot 默认的本地缓存实现。

## 一、核心特性

- 基于 **W-TinyLFU** 淘汰算法（比 LRU 命中率更高）
- 支持异步加载、自动刷新、弱引用、统计
- 线程安全，高并发无锁设计
- 与 Spring Cache 无缝集成

## 二、基本使用

### 引入依赖

```xml
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
</dependency>
<!-- Spring Boot 已管理版本，通常无需指定 -->
```

### 手动创建 Cache

```java
Cache<String, User> cache = Caffeine.newBuilder()
    .maximumSize(1000)                          // 最大条数
    .expireAfterWrite(10, TimeUnit.MINUTES)     // 写入后10分钟过期
    .expireAfterAccess(5, TimeUnit.MINUTES)     // 最后访问后5分钟过期
    .recordStats()                              // 开启统计
    .build();

// 手动读写
cache.put("user:1", user);
User user = cache.getIfPresent("user:1");       // 不存在返回 null

// 带加载函数（缓存未命中时自动加载）
User user = cache.get("user:1", key -> userDao.findById(1L));
```

### LoadingCache（自动加载）

```java
LoadingCache<Long, User> loadingCache = Caffeine.newBuilder()
    .maximumSize(1000)
    .expireAfterWrite(10, TimeUnit.MINUTES)
    .refreshAfterWrite(5, TimeUnit.MINUTES)     // 5分钟后异步刷新（不阻塞）
    .build(id -> userDao.findById(id));         // 加载函数

User user = loadingCache.get(1L);              // 自动加载
```

### AsyncLoadingCache（异步加载）

```java
AsyncLoadingCache<Long, User> asyncCache = Caffeine.newBuilder()
    .maximumSize(1000)
    .expireAfterWrite(10, TimeUnit.MINUTES)
    .buildAsync(id -> CompletableFuture.supplyAsync(() -> userDao.findById(id)));

CompletableFuture<User> future = asyncCache.get(1L);
```

---

## 三、过期策略

| 策略 | 方法 | 说明 |
|------|------|------|
| 写入后过期 | `expireAfterWrite(n, unit)` | 写入 n 时间后过期，无论是否被读 |
| 访问后过期 | `expireAfterAccess(n, unit)` | 最后一次读/写后 n 时间过期 |
| 自定义过期 | `expireAfter(Expiry)` | 每个 key 独立的过期时间 |
| 自动刷新 | `refreshAfterWrite(n, unit)` | n 时间后下次访问时**异步**刷新（旧值仍可用）|

**`expireAfterWrite` vs `refreshAfterWrite`：**
- `expireAfterWrite`：过期后访问会等待加载（同步阻塞）
- `refreshAfterWrite`：过期后返回旧值同时异步加载新值，不阻塞请求，但可能短暂读到旧数据

---

## 四、容量控制

```java
// 基于条数
.maximumSize(10_000)

// 基于权重（如按字节数）
.maximumWeight(100 * 1024 * 1024)  // 100MB
.weigher((key, value) -> value.getBytes().length)
```

---

## 五、与 Spring Cache 集成

```yaml
spring:
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=600s
```

```java
@EnableCaching
@Configuration
public class CacheConfig {

    @Bean
    public CacheManager cacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager();
        manager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(1000)
            .expireAfterWrite(10, TimeUnit.MINUTES)
            .recordStats());
        return manager;
    }
}
```

```java
@Cacheable(value = "users", key = "#id")
public User getUser(Long id) { ... }
```

---

## 六、统计监控

```java
Cache<String, Object> cache = Caffeine.newBuilder()
    .maximumSize(1000)
    .recordStats()
    .build();

CacheStats stats = cache.stats();
stats.hitRate();        // 命中率
stats.missRate();       // 未命中率
stats.evictionCount();  // 淘汰次数
stats.loadSuccessCount(); // 加载成功次数
```

---

## 七、常见面试问题

**Q：Caffeine 的 W-TinyLFU 和 LRU 有什么区别？**
LRU 只考虑最近访问时间，容易被一次性大量扫描"污染"（把真正的热点数据挤出去）。W-TinyLFU 结合了访问频率（LFU）和最近性（LRU），用 Count-Min Sketch 以极低内存近似统计访问频率，命中率通常高于 LRU 5-10%。

**Q：`expireAfterWrite` 和 `expireAfterAccess` 如何选择？**
- 数据有明确的有效期（如价格每分钟更新）→ `expireAfterWrite`
- 数据没有明确有效期但长期不用应释放 → `expireAfterAccess`
- 两者可以同时设置，任一满足就过期

**Q：Caffeine 如何避免缓存击穿？**
`LoadingCache.get()` 对同一个 key 的并发加载会自动合并（只有一个线程执行加载函数），其他线程等待第一个线程加载完成后直接使用结果，天然防止击穿。

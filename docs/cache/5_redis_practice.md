---
description: Spring Boot 4 集成、Jackson 3 序列化、Spring Cache、大 Key / 热 Key、监控
---

# Redis 实战

> 前置阅读：[Redis 核心原理](./2_redis_core)、[Redis 集群](./3_redis_cluster)

Spring Data Redis 是 Spring 项目里用 Redis 的标准方式。本篇讲连接与序列化配置、Spring Cache 安全用法、大 Key / 热 Key 治理和监控，基线为 Spring Boot 4。

---

## 一、Spring Data Redis 集成

Spring Data Redis 通过 Lettuce / Jedis 连接，同样适用于 Valkey（Valkey 官方另提供含 Java 的多语言客户端 GLIDE）；示例基于 Spring Boot 4 / Spring Data Redis 4。

Spring Cache 注解本身的语义（`@Cacheable` / `@CacheEvict` 的属性、代理机制）见 [Cache 抽象](/spring/5_cache)，这里只讲 Redis 相关的配置与踩坑。

### 1、依赖与配置

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
<!-- 可选：Lettuce 的连接池依赖它，只有用到阻塞命令或事务时才需要 -->
<dependency>
    <groupId>org.apache.commons</groupId>
    <artifactId>commons-pool2</artifactId>
</dependency>
```

```yaml
spring:
  data:
    redis:                      # Spring Boot 3.0 起前缀为 spring.data.redis，旧的 spring.redis 已失效
      host: 127.0.0.1
      port: 6379
      password: ${REDIS_PASSWORD}
      database: 0
      timeout: 2s               # 命令超时，避免 Redis 卡顿时线程长时间挂起
      connect-timeout: 1s
      lettuce:
        pool:                   # classpath 有 commons-pool2 时默认启用
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 1s          # 取连接超时，快速失败
```

Lettuce 默认所有线程**共享一条**基于 Netty 的连接（`shareNativeConnection = true`），普通 `GET` / `SET` 不走连接池，不引入 commons-pool2 也能正常工作。连接池只在阻塞命令（`BLPOP`、`XREAD BLOCK`）、`MULTI` 事务等需要独占连接时使用，所以不要靠调大 `max-active` 解决 Redis 慢的问题。若调用 `setShareNativeConnection(false)` 关闭共享，所有操作都会走连接池，此时 `max-active` 要按访问 Redis 的线程峰值估算。

### 2、Lettuce 与 Jedis

| | Lettuce | Jedis |
|--|---------|-------|
| 线程安全 | 单个连接可多线程共享（Netty 异步） | 单个 `Jedis` 实例不安全；`JedisPool` / `JedisPooled` 安全 |
| 同步 / 异步 / 响应式 | 都支持 | 只有同步 |
| Spring Boot 默认 | 是 | 否，需排除 Lettuce 后引入 |
| Cluster 拓扑刷新 | 支持自适应刷新 | 支持 |

连接池大小的经验值：Jedis 每条命令独占一个连接，`maxTotal` 约等于访问 Redis 的线程峰值；Redisson 用 `connectionPoolSize`（默认 64）和 `connectionMinimumIdleSize`（默认 24）控制每个节点的连接数，一般保持默认即可。
| 推荐 | 首选 | 兼容老项目 |

### 3、RedisTemplate 序列化

Boot 自动配置的 `RedisTemplate<Object, Object>` 用 JDK 序列化，不可读、体积大，还要求类实现 `Serializable`，一般改为 key 用字符串、value 用 JSON。Spring Data Redis 4 以 Jackson 3（包名 `tools.jackson`）为主，Jackson 2 版序列化器均已废弃：

| Spring Data Redis 4（Boot 4，Jackson 3） | Spring Data Redis 3（Boot 3，Jackson 2，已废弃） |
|-----------------------------------------|----------------------------------------------|
| `GenericJacksonJsonRedisSerializer` | `GenericJackson2JsonRedisSerializer` |
| `JacksonJsonRedisSerializer<T>` | `Jackson2JsonRedisSerializer<T>` |
| `JacksonHashMapper` | `Jackson2HashMapper` |

```java
import tools.jackson.databind.jsontype.BasicPolymorphicTypeValidator;
import tools.jackson.databind.jsontype.PolymorphicTypeValidator;

@Configuration
public class RedisConfig {

    // 只允许反序列化本项目和必要的 JDK 类型，防止缓存数据被篡改后触发反序列化漏洞
    static PolymorphicTypeValidator typeValidator() {
        return BasicPolymorphicTypeValidator.builder()
                .allowIfSubType("com.example.")
                .allowIfSubType("java.util.")
                .allowIfSubType("java.time.")
                .allowIfSubType("java.math.")
                .build();
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        GenericJacksonJsonRedisSerializer json = GenericJacksonJsonRedisSerializer.builder()
                .enableDefaultTyping(typeValidator())   // 写入类型信息，读取时还原具体类型
                .build();

        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);
        template.setKeySerializer(RedisSerializer.string());
        template.setHashKeySerializer(RedisSerializer.string());
        template.setValueSerializer(json);
        template.setHashValueSerializer(json);
        return template;                         // 作为 Bean 时 afterPropertiesSet 由容器调用
    }
}
```

几点说明：

- **新版默认不写类型信息**：旧的 `GenericJackson2JsonRedisSerializer` 默认开启 default typing，新的 `GenericJacksonJsonRedisSerializer` **默认不开启**，读回来是 `LinkedHashMap`，强转业务类型会抛 `ClassCastException`；需要多态时像上面一样用 `enableDefaultTyping(validator)` 显式开启
- **不要用无校验的默认类型**：`LaissezFaireSubTypeValidator` 或 builder 的 `enableUnsafeDefaultTyping()` 允许反序列化任意类，缓存数据一旦可被写入就可能被利用执行任意代码。能确定类型时，优先用 `new JacksonJsonRedisSerializer<>(Product.class)` 建专用模板，不写类型信息，JSON 更干净，也没有多态反序列化风险
- **Jackson 3 内置 java.time 支持**，不再需要注册 `JavaTimeModule`
- **升级时注意兼容**：Jackson 3 写出的 JSON 可能与 Jackson 2 不同。过渡期可继续用已废弃的 Jackson 2 序列化器读旧数据，或给新格式的 key 换前缀等旧 key 过期，或直接清空缓存（缓存数据本来就应可重建）；Boot 3.x 项目继续用 `GenericJackson2JsonRedisSerializer`，写法相同
- 只存字符串时直接用 Boot 自动配置的 `StringRedisTemplate`

### 4、Spring Cache 配置

自动配置的 `RedisCacheManager` 同样默认用 JDK 序列化。不必继承已废弃的 `CachingConfigurerSupport`，也不建议自己 new 一个 `RedisCacheManager`（自动配置会整体退出）。声明一个 `RedisCacheConfiguration` Bean 作为默认配置，再用 `RedisCacheManagerBuilderCustomizer` 按缓存名微调：

```java
@EnableCaching
@Configuration
public class CacheConfig {

    @Bean
    public RedisCacheConfiguration redisCacheConfiguration() {
        RedisSerializer<Object> json = GenericJacksonJsonRedisSerializer.builder()
                .enableDefaultTyping(RedisConfig.typeValidator())   // 同上一节的白名单校验器
                .enableSpringCacheNullValueSupport()                // 允许缓存 null（序列化 NullValue）
                .build();
        return RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(30))
                .serializeKeysWith(SerializationPair.fromSerializer(RedisSerializer.string()))
                .serializeValuesWith(SerializationPair.fromSerializer(json));
    }

    @Bean
    public RedisCacheManagerBuilderCustomizer redisCacheCustomizer(RedisCacheConfiguration base) {
        return builder -> builder
                .transactionAware()   // 在事务提交后才真正执行 put / evict
                .withCacheConfiguration("configs", base.entryTtl(Duration.ofDays(1)))
                .withCacheConfiguration("product", base
                        .entryTtl(Duration.ofMinutes(10))
                        .serializeValuesWith(SerializationPair
                                .fromSerializer(new JacksonJsonRedisSerializer<>(Product.class))));
    }
}
```

- **Bean 优先于属性**：容器里有 `RedisCacheConfiguration` Bean 时 Boot 直接用它作为默认配置，`spring.cache.redis.time-to-live` 等属性不再生效（TTL 写在 Bean 里）；按缓存名差异化用 `RedisCacheManagerBuilderCustomizer`（`withCacheConfiguration` 逐个加，或 `withInitialCacheConfigurations` 传 Map）
- **缓存 null 需要显式支持**：JSON 序列化器要开启 `enableSpringCacheNullValueSupport()` 才能写入 Spring Cache 的 `NullValue` 占位，空值策略与穿透防护见 [Cache 抽象](/spring/5_cache#_3、空值策略与缓存穿透)
- Boot 3.x 中 `RedisCacheManagerBuilderCustomizer` 的包名是 `org.springframework.boot.autoconfigure.cache`，Boot 4 移到 `org.springframework.boot.cache.autoconfigure`

```java
@Service
public class ProductService {

    @Cacheable(cacheNames = "product", key = "#id", unless = "#result == null", sync = true)
    public Product getById(Long id) { ... }        // sync = true：同一 key 并发未命中时只放一个线程查库

    @Transactional
    @CacheEvict(cacheNames = "product", key = "#product.id")
    public void update(Product product) { ... }    // 先更新数据库，提交后删除缓存

    @Transactional
    @CacheEvict(cacheNames = "product", key = "#id")
    public void delete(Long id) { ... }
}
```

更新时用 `@CacheEvict` 删缓存，而不是 `@CachePut` 写缓存：两个并发更新的「写库」与「写缓存」可能交错，导致缓存里留下旧值且长期不过期；删除后由下一次读请求回填，配合 TTL 可以收敛。这仍是最终一致而非强一致，并发窗口、延迟双删和基于 binlog 的失效方案见 [缓存一致性](./10_cache_consistency)。

---

## 二、大 Key

**定义**：没有统一标准，常用经验值是 String 超过 10KB、集合类元素超过 5000 个或总大小超过 10MB，按实例规格和延迟要求调整。

**危害**：

- 读写和删除耗时长，阻塞主线程，`DEL` 一个百万元素的集合可能卡住秒级
- 单次返回数据量大，占满网卡和客户端缓冲区
- Cluster 下导致分片内存不均，槽迁移时阻塞源节点和目标节点

**排查**：

```bash
redis-cli -h host -p 6379 --bigkeys -i 0.1   # 按元素数找每种类型最大的 key，每 100 次 SCAN 休眠 0.1 秒
redis-cli -h host -p 6379 --memkeys -i 0.1   # 按内存占用找最大的 key
MEMORY USAGE user:1001                       # 单个 key 的内存占用（字节）
```

`--bigkeys` / `--memkeys` 基于 `SCAN`，不会长时间阻塞，但会增加实例负载，建议在从节点或低峰期执行。`DEBUG OBJECT` 的 `serializedlength` 是序列化后的长度而不是内存占用，且 7.0 起 `DEBUG` 命令默认禁用（`enable-debug-command no`）。离线分析可以解析 RDB 文件。

**治理**：

- 大 String：压缩（如 Snappy / Zstd）后存储，或只缓存需要的字段
- 大集合：按 ID 取模拆成多个 key（如 `cart:1001:{0..15}`），读取用 `HSCAN` / `SSCAN` / `ZSCAN` 分批
- 删除：用 `UNLINK` 代替 `DEL`，在后台线程释放内存；或开启 `lazyfree-lazy-user-del yes`（默认 no）让 `DEL` 也异步释放
- 过期与淘汰时的释放同样可以异步：`lazyfree-lazy-expire yes`、`lazyfree-lazy-eviction yes`

---

## 三、热 Key

**定义**：某个 key 的访问量远超其他 key，单个分片的 CPU 或网卡被打满。Cluster 中一个 key 只属于一个槽、一个主节点，加分片分散不了单个热 key。

**Redis 侧排查**：

```bash
redis-cli --hotkeys -i 0.1    # 需要 maxmemory-policy 为 allkeys-lfu 或 volatile-lfu，否则直接报错
```

- `MONITOR` 能看到全部命令，但会让实例吞吐明显下降，生产只在必要时短时开启
- Redis 8 可用 Top-k 结构（`TOPK.ADD` / `TOPK.LIST`）在服务端近似统计
- 多副本 key 不要用 hash tag（`{item:1}#0`），否则副本仍落在同一槽，可用 `CLUSTER KEYSLOT` 校验

实时探测架构（客户端统计、集中式探测）与治理手段（本地缓存兜底、key 打散多副本、读从节点）见 [热点问题](/high-con/6_hotspot#一、热点-key-探测)；本地 + Redis 的两级缓存实现见 [两级缓存（L1 + L2）](./8_two_level_cache)。

---

## 四、性能优化与监控

### 1、避免慢命令

| 禁用 / 慎用 | 替代方案 |
|-----------|---------|
| `KEYS *`（全量遍历，阻塞） | `SCAN` 游标分批 |
| `HGETALL` / `SMEMBERS` / `LRANGE 0 -1`（大集合全量返回） | `HSCAN` / `SSCAN` / 分页 |
| `DEL` 大 key | `UNLINK` |
| 循环里逐条 `GET` / `SET` | `MGET` / `MSET` 或 Pipeline |
| `FLUSHALL` / `FLUSHDB` | 加 `ASYNC`，并用 ACL 或 `rename-command` 限制 |

### 2、诊断命令

```bash
redis-cli info stats          # 命中、淘汰、过期、命令数
redis-cli info memory         # 内存与碎片率
redis-cli info replication    # 主从状态与复制偏移量
redis-cli slowlog get 10      # 慢日志，阈值 slowlog-log-slower-than 默认 10000 微秒（10ms）
redis-cli --latency           # 客户端到服务端的往返延迟
```

### 3、关键指标

| 指标（`INFO` 字段） | 含义 | 关注点 |
|-------------------|------|-------|
| `used_memory` / `maxmemory` | 已用内存 / 上限 | 超过 80% 告警 |
| `mem_fragmentation_ratio` | 碎片率 | 长期大于 1.5 考虑开启 `activedefrag` |
| `keyspace_hits` / `keyspace_misses` | 命中 / 未命中次数 | 计算命中率，突降通常是缓存被清或 key 设计问题 |
| `evicted_keys` | 被淘汰的 key 数 | 持续增长说明内存不足 |
| `connected_clients` / `blocked_clients` | 连接数 / 阻塞中的连接 | 连接泄漏、阻塞命令堆积 |
| `instantaneous_ops_per_sec` | 实时 QPS | 容量规划 |
| `master_repl_offset` 与从节点 `offset` 差值 | 复制延迟 | 读写分离时尤其要看 |
| `latest_fork_usec` | 最近一次 fork 耗时（微秒） | 大实例持久化导致的卡顿 |

指标采集通常用 redis_exporter 接入 Prometheus，告警体系见 [可观测性总览](/observability/0_overview)。

---

## 小结

- Spring Boot 3+ 用 `spring.data.redis.*`；Lettuce 默认共享单连接，commons-pool2 只为阻塞命令和事务服务
- Spring Data Redis 4 用 Jackson 3 序列化器（`GenericJacksonJsonRedisSerializer` / `JacksonJsonRedisSerializer`），默认类型要配限制性的 `PolymorphicTypeValidator`，能用具体类型就不用默认类型
- Spring Cache 用 `RedisCacheConfiguration` Bean + Builder 定制，更新时先写库再 `@CacheEvict`，开启 `transactionAware()` 让删除发生在提交之后
- 大 Key 用 `--bigkeys` / `--memkeys` / `MEMORY USAGE` 排查，`UNLINK` 删除、拆分存储
- 单个热 Key 无法被 Cluster 分散，靠本地缓存、多副本 key、读从节点
- 监控内存、命中率、淘汰数、复制延迟和慢日志

## 参考资料

- Spring Data Redis 参考文档：[https://docs.spring.io/spring-data/redis/reference/](https://docs.spring.io/spring-data/redis/reference/)
- Spring Data Redis 4.0 迁移指南（Jackson 3 序列化器）：[https://docs.spring.io/spring-data/redis/reference/upgrading.html](https://docs.spring.io/spring-data/redis/reference/upgrading.html)
- Spring Boot NoSQL（Redis 配置）：[https://docs.spring.io/spring-boot/reference/data/nosql.html](https://docs.spring.io/spring-boot/reference/data/nosql.html)
- Spring Boot Caching（Redis）：[https://docs.spring.io/spring-boot/reference/io/caching.html](https://docs.spring.io/spring-boot/reference/io/caching.html)
- redis-cli（--bigkeys / --memkeys / --hotkeys）：[https://redis.io/docs/latest/develop/tools/cli/](https://redis.io/docs/latest/develop/tools/cli/)
- MEMORY USAGE：[https://redis.io/docs/latest/commands/memory-usage/](https://redis.io/docs/latest/commands/memory-usage/)
- Redis latency diagnosis：[https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- Valkey GLIDE：[https://github.com/valkey-io/valkey-glide](https://github.com/valkey-io/valkey-glide)

> 下一篇：[Redisson](./6_redisson) —— 分布式锁、限流器、延迟队列与本地缓存 Map 等 Redisson 高级对象的用法。

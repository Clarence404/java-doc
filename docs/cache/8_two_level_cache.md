---
description: L1 + L2 读写流程、提交后失效、多实例 L1 失效方案、手动实现、框架方案
---

# 两级缓存（L1 + L2）

> **本篇目标**：掌握「本地缓存 L1 + Redis L2」的读写流程，知道失效为什么必须在事务提交之后、多实例 L1 有哪几种失效方式及各自的丢失风险，并能写出一个可用的两级缓存实现。
>
> **前置阅读**：[Caffeine](./7_caffeine)、[Redis 基础](./1_redis_base)、[缓存架构设计](/high-con/3_cache_architecture)

两级缓存在系统架构中的位置、多级缓存命中率的计算见 [缓存架构设计](/high-con/3_cache_architecture)；缓存与数据库之间的一致性方案（Cache Aside、延迟双删、binlog 失效）见 [缓存一致性](./10_cache_consistency)。本篇聚焦两级缓存自身的实现与 L1 失效。

---

## 一、为什么需要两级缓存

| 维度 | L1（本地缓存，Caffeine） | L2（分布式缓存，Redis） |
|------|------------------------|------------------------|
| 访问延迟 | 进程内读取，百纳秒到微秒级 | 一次网络往返 + 反序列化，同机房通常 0.1–1 ms |
| 数据共享 | 仅本进程可见 | 所有实例看到同一份 |
| 容量 | 受 JVM 堆限制 | 独立部署，可扩容 |
| 与数据库的一致性 | 多一层副本，失效最难 | 仍可能与数据库短暂不一致 |
| 故障影响 | 无外部依赖 | Redis 故障时请求回落到数据库 |

**两级缓存的价值**：热点数据在本地命中，大幅减少 Redis 请求与网络 IO，热点 key 不会把单个 Redis 分片打满。代价是多了一层需要失效的副本。无论几级缓存，**数据库都是唯一可信来源**，缓存不承担「数据不丢」的职责。

适合放 L1 的数据：读多写少、体积小、允许秒级不一致，例如字典、配置、商品基础信息、热点详情。库存、余额等强一致数据不放 L1。

---

## 二、读写流程

![两级缓存的读路径与写路径](../assets/cache/two_level_read_write.svg)

**读路径**：

1. 查 L1，命中直接返回
2. L1 未命中查 L2，命中后回填 L1
3. L2 也未命中查数据库，回填 L2 与 L1；数据不存在时缓存一个空值占位（短 TTL），防止穿透
4. 同一个 key 的并发未命中，在本 JVM 内只让一个线程回源（Caffeine `get(key, loader)`）

**写路径**：

1. 更新数据库并**提交事务**
2. 提交之后删除 L2（不回写新值）
3. 广播失效消息，所有实例删除各自的 L1（含本实例）

删除必须发生在**事务提交之后**：如果在事务内删除，提交前的窗口里其他线程会把旧值重新读回 L2 / L1；如果事务回滚，失效消息却已经发出。Spring 中用 `@TransactionalEventListener(phase = AFTER_COMMIT)` 或 `TransactionSynchronization.afterCommit()` 实现（见第四节）。

`AFTER_COMMIT` 仍有缺口：**提交后、删除前进程崩溃**，或删除 Redis 失败，L2 会一直是旧值直到 TTL。要求更高时，用 binlog 订阅（Canal / Debezium）驱动删除并重试，或用本地消息表保证失效消息必达，见 [缓存一致性](./10_cache_consistency) 与 [消息队列基础](/messaging/1_basics)。

---

## 三、多实例 L1 失效

**核心难点**：每个实例都有自己的 L1，数据更新后要让所有实例的 L1 失效。

### 1、Redis Pub/Sub 广播

写操作提交后 `PUBLISH cache:invalidate <key>`，每个实例订阅该频道并删除本地条目。实现简单、延迟低（毫秒级），但 Pub/Sub **不持久化**：订阅者断线、重连间隙、实例重启期间的消息都会丢失。

### 2、MQ 广播

失效消息发到 MQ，每个实例都消费一份（RocketMQ 用广播消费模式，Kafka 每个实例使用独立的消费者组）。消息持久化，断线后能补消费，代价是引入 MQ、延迟稍高；配合本地消息表或 binlog 订阅，可以做到「提交即必达」。

### 3、Redis 服务端失效推送（Client-side caching）

Redis 6 起提供 `CLIENT TRACKING`：服务端记录客户端读过的 key（或按前缀广播），key 被修改时主动推送失效通知，Redis 8.x / Valkey 8.x 均支持。Lettuce 通过 `ClientSideCaching` 使用它（需 RESP3 连接）：

```java
Map<String, String> clientCache = new ConcurrentHashMap<>();          // 生产环境应换成有容量上限的 Map
StatefulRedisConnection<String, String> connection = redisClient.connect();
CacheFrontend<String, String> frontend = ClientSideCaching.enable(
        CacheAccessor.forMap(clientCache), connection, TrackingArgs.Builder.enabled());

String value = frontend.get("user:info:10001");                        // 本地未命中才访问 Redis
```

优点是不需要自己发失效消息，任何客户端修改 key 都会触发失效；局限是失效粒度跟 Redis key 绑定，L1 存的必须是 Redis 中的原始值，且 Spring Data Redis 没有直接封装。断线期间同样会丢通知，重连后应清空本地缓存。

### 4、L1 短 TTL 兜底

L1 只设较短的 TTL（如 5–30 秒），到期后从 L2 重新加载。它不能单独保证及时失效，但能**为前三种方案兜底**：任何失效消息丢失，最多不一致一个 L1 TTL。生产环境应当「广播失效 + L1 短 TTL」一起用。

| 方案 | 失效延迟 | 丢失风险 | 额外依赖 | 适用 |
|------|---------|---------|---------|------|
| Redis Pub/Sub | 毫秒级 | 断线、重启期间丢失 | 无（复用 Redis） | 大多数场景，配合短 TTL |
| MQ 广播 | 毫秒到秒级 | 低，可补消费 | MQ | 对失效可靠性要求高 |
| Redis 失效推送 | 毫秒级 | 断线期间丢失 | RESP3 客户端 | L1 直接缓存 Redis 原值 |
| 仅 L1 短 TTL | 等于 L1 TTL | 无（必然过期） | 无 | 允许秒级不一致的数据 |

**L1 TTL 参考**：

| 数据类型 | L1 TTL | 说明 |
|---------|--------|------|
| 配置、字典（极少变更） | 30–60 秒 | 广播失效为主，TTL 兜底 |
| 商品基础信息、详情页 | 5–10 秒 | 容忍秒级旧数据 |
| 库存、价格、余额 | 不放 L1 | 强一致要求，直接读 L2 或数据库 |

---

## 四、手动实现

基线：Spring Boot 4 + Spring Data Redis 4 + Jackson 3（`tools.jackson.databind.json.JsonMapper`，其异常 `JacksonException` 为非受检异常）。

### 1、两级缓存组件

```java
@Component
public class TwoLevelCache {

    public static final String CHANNEL = "cache:invalidate";
    private static final String NULL_JSON = "@@NULL@@";          // Redis 中的空值占位
    private static final Object NULL_VALUE = new Object();       // L1 中的空值占位

    private final Cache<String, Object> local = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofSeconds(30))            // L1 短 TTL，兜底丢失的失效消息
            .build();

    private final StringRedisTemplate redis;
    private final JsonMapper jsonMapper;

    public TwoLevelCache(StringRedisTemplate redis, JsonMapper jsonMapper) {
        this.redis = redis;
        this.jsonMapper = jsonMapper;
    }

    public <T> T get(String key, Class<T> type, Supplier<? extends T> dbLoader) {
        // 同一 key 的并发未命中，本 JVM 内只有一个线程执行 loadFromRemote
        Object value = local.get(key, k -> loadFromRemote(k, type, dbLoader));
        return value == NULL_VALUE ? null : type.cast(value);
    }

    private Object loadFromRemote(String key, Class<?> type, Supplier<?> dbLoader) {
        String json = redis.opsForValue().get(key);
        if (json != null) {
            return NULL_JSON.equals(json) ? NULL_VALUE : jsonMapper.readValue(json, type);
        }
        Object fromDb = dbLoader.get();
        if (fromDb == null) {
            redis.opsForValue().set(key, NULL_JSON, Duration.ofSeconds(60));   // 防穿透：空值短 TTL
            return NULL_VALUE;
        }
        Duration ttl = Duration.ofSeconds(1800 + ThreadLocalRandom.current().nextInt(300)); // 抖动防雪崩
        redis.opsForValue().set(key, jsonMapper.writeValueAsString(fromDb), ttl);
        return fromDb;
    }

    /** 事务提交后调用：删 L2、删本实例 L1、通知其他实例 */
    public void evict(String key) {
        redis.delete(key);
        local.invalidate(key);
        redis.convertAndSend(CHANNEL, key);
    }

    /** 收到广播后调用：只删本地 L1 */
    public void evictLocal(String key) {
        local.invalidate(key);
    }
}
```

- 缓存 `List<User>` 等泛型类型时，`Class<T>` 不够用，改为传 `TypeReference` 并用 `jsonMapper.readValue(json, typeRef)` 反序列化
- L1 中存的是对象引用，返回给调用方的对象不应被修改，值对象建议用 record
- 空值在 L1 中也会缓存 30 秒，数据新建后依赖失效广播清除

### 2、订阅失效频道

```java
@Configuration
public class CacheInvalidationConfig {

    @Bean
    public RedisMessageListenerContainer cacheInvalidationContainer(RedisConnectionFactory connectionFactory,
                                                                    TwoLevelCache cache) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(
                (message, pattern) -> cache.evictLocal(new String(message.getBody(), StandardCharsets.UTF_8)),
                new ChannelTopic(TwoLevelCache.CHANNEL));
        return container;
    }
}
```

不注册 `RedisMessageListenerContainer`，监听器就不会收到任何消息。

### 3、在事务提交后失效

```java
public record UserChanged(long userId) {}

@Service
public class UserService {

    private final UserRepository userRepository;
    private final ApplicationEventPublisher events;

    public UserService(UserRepository userRepository, ApplicationEventPublisher events) {
        this.userRepository = userRepository;
        this.events = events;
    }

    @Transactional
    public void rename(long userId, String name) {
        userRepository.updateName(userId, name);
        events.publishEvent(new UserChanged(userId));     // 只登记事件，提交后才处理
    }
}

@Component
public class UserCacheInvalidator {

    private final TwoLevelCache cache;

    public UserCacheInvalidator(TwoLevelCache cache) {
        this.cache = cache;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onUserChanged(UserChanged event) {
        cache.evict("user:info:" + event.userId());
    }
}
```

`@TransactionalEventListener` 只在有活动事务时触发，没有事务时事件默认被丢弃（可设 `fallbackExecution = true`）。删除失败要记录并重试；需要「提交即必达」时改用 binlog 订阅驱动删除。

---

## 五、现成方案

- **JetCache**：`CacheType.BOTH` 提供 L1 + L2，但跨实例的 L1 失效**默认不开启**，需要配置 `jetcache.remote.<area>.broadcastChannel`（编程式缓存还需 `syncLocal(true)`），见 [JetCache](./9_jetcache)
- **Redisson**：`RLocalCachedMap` 内置本地缓存，基于 Pub/Sub 通知其他实例失效，存在与方案一相同的丢失问题，需配置 `reconnectionStrategy`（`CLEAR` / `LOAD`），见 [Redisson](./6_redisson)
- **Lettuce**：`ClientSideCaching` 基于 Redis 服务端失效推送，见第三节
- **Spring Cache**：没有两级缓存实现，需要自定义 `Cache` / `CacheManager` 包装两层，见 [Cache 抽象](/spring/5_cache)

---

## 小结

- L1 换来进程内的读取速度，代价是多了一层最难失效的副本；数据库始终是唯一可信来源
- 读路径逐级回填，空值短 TTL 防穿透，Caffeine `get(key, loader)` 合并本 JVM 内的并发回源
- 写路径只删不写，且必须在事务提交之后执行；提交后崩溃的缺口用 binlog 订阅或本地消息表弥补
- L1 失效方式有 Pub/Sub、MQ 广播、Redis 服务端失效推送，三者都要配合 L1 短 TTL 兜底
- 强一致数据（库存、余额）不放 L1
- JetCache 的两级同步要显式配置 `broadcastChannel`，Redisson 本地缓存要配置重连策略

## 参考资料

- Redis 官方文档 · Client-side caching：[https://redis.io/docs/latest/develop/reference/client-side-caching/](https://redis.io/docs/latest/develop/reference/client-side-caching/)
- Redis 官方文档 · CLIENT TRACKING：[https://redis.io/docs/latest/commands/client-tracking/](https://redis.io/docs/latest/commands/client-tracking/)
- Lettuce 文档 · Client-side caching：[https://redis.github.io/lettuce/advanced-usage/#client-side-caching](https://redis.github.io/lettuce/advanced-usage/#client-side-caching)
- Spring Framework 文档 · Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Spring Data Redis 文档 · Redis Messaging (Pub/Sub)：[https://docs.spring.io/spring-data/redis/reference/redis/pubsub.html](https://docs.spring.io/spring-data/redis/reference/redis/pubsub.html)
- Caffeine GitHub：[https://github.com/ben-manes/caffeine](https://github.com/ben-manes/caffeine)

> 下一篇：[JetCache](./9_jetcache) —— 用注解与 `QuickConfig` 统一管理本地 + 远程两级缓存，以及多实例本地缓存同步的配置。

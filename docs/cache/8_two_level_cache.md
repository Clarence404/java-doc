---
description: 读写流程、两级一致性、手动实现与框架方案
---

# 两级缓存（L1 + L2）

## 一、为什么需要两级缓存

| | L1（本地缓存，Caffeine）| L2（分布式缓存，Redis）|
|--|----------------------|---------------------|
| 访问延迟 | < 1ms（内存直接读）| 1-10ms（网络 + 序列化）|
| 数据共享 | 仅本进程可见 | 所有实例共享 |
| 容量 | 受 JVM 堆内存限制 | 独立部署，容量大 |
| 一致性 | 多实例间需同步 | 天然一致 |
| 故障影响 | 无外部依赖 | Redis 宕机全部失效 |

**两级缓存的价值：** 大幅减少对 Redis 的请求，降低网络 IO，提升接口响应速度；同时 Redis 作为兜底，保证数据不丢失。

---

## 二、读写流程

### 读流程

```
请求 → L1（Caffeine）命中 → 返回
         ↓ 未命中
       L2（Redis）命中 → 写入 L1 → 返回
         ↓ 未命中
       查询数据库 → 写入 L2 → 写入 L1 → 返回
```

### 写流程（更新数据）

```
更新数据库 → 删除 L2（Redis）→ 发布失效消息（MQ/Redis Pub/Sub）→ 所有实例收到消息删除 L1
```

---

## 三、两级缓存一致性问题

**核心难点：** 多个服务实例各自有 L1 缓存，更新数据时如何让所有实例的 L1 失效？

### 方案一：Redis Pub/Sub 广播失效

```java
// 数据更新时发布失效消息
redisTemplate.convertAndSend("cache:invalidate", key);

// 每个实例订阅并清除本地缓存
@Component
public class CacheInvalidateListener implements MessageListener {
    @Autowired
    private CaffeineCache localCache;

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String key = new String(message.getBody());
        localCache.evict(key);
    }
}
```

**缺陷：** Redis Pub/Sub 不持久化，订阅者离线期间的消息会丢失。

### 方案二：MQ 消息广播（可靠）

```
写操作 → 更新DB → 发送MQ消息（key列表）
所有实例监听MQ → 删除本地缓存
```

优点：消息持久化，不丢失；缺点：引入 MQ 依赖，延迟稍高（ms 级）。

### 方案三：短 TTL + 接受短暂不一致

```java
// L1 设置较短 TTL（如 5-30 秒），到期自动从 L2 刷新
// 适合允许秒级不一致的场景（商品详情、配置信息等）
Caffeine.newBuilder()
    .expireAfterWrite(10, TimeUnit.SECONDS)
    ...
```

**大多数业务场景推荐此方案**，简单可靠，秒级不一致可接受。

---

## 四、手动实现两级缓存

```java
@Component
public class TwoLevelCacheService {

    private final Cache<String, Object> localCache = Caffeine.newBuilder()
        .maximumSize(5000)
        .expireAfterWrite(30, TimeUnit.SECONDS)
        .build();

    @Autowired
    private StringRedisTemplate redisTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    public <T> T get(String key, Class<T> type, Supplier<T> loader) {
        // 1. 查 L1
        Object local = localCache.getIfPresent(key);
        if (local != null) return type.cast(local);

        // 2. 查 L2
        String json = redisTemplate.opsForValue().get(key);
        if (json != null) {
            T value = objectMapper.readValue(json, type);
            localCache.put(key, value);
            return value;
        }

        // 3. 查 DB
        T value = loader.get();
        if (value != null) {
            redisTemplate.opsForValue().set(key, objectMapper.writeValueAsString(value),
                Duration.ofMinutes(30));
            localCache.put(key, value);
        }
        return value;
    }

    public void evict(String key) {
        localCache.invalidate(key);
        redisTemplate.delete(key);
        // 通知其他实例
        redisTemplate.convertAndSend("cache:invalidate", key);
    }
}
```

---

## 五、JetCache / Redisson 的两级缓存

- **JetCache**：`@Cached(cacheType=CacheType.BOTH)` 注解直接实现两级缓存，自动处理本地与远程同步 → 详见 [8_jetcache](./9_jetcache)
- **Redisson**：`RLocalCachedMap` 内置本地缓存 + Redis，支持多实例间本地缓存失效通知 → 详见 [5_redisson](./6_redisson)

---

## 六、常见面试问题

**Q：两级缓存最大的挑战是什么？**
多实例本地缓存的一致性。数据更新时，需要通知所有实例清除各自的 L1，否则会读到脏数据。常用方案是 Pub/Sub 广播或短 TTL。

**Q：L1 TTL 设置多少合适？**
没有固定答案，取决于业务对一致性的容忍度：
- 配置类数据（低频更新）：30-60 秒
- 商品信息（允许短暂不一致）：5-10 秒
- 库存/价格（强一致要求）：不建议 L1 缓存，或 1 秒以内

**Q：两级缓存和直接用 Redis 相比性能差多少？**
Caffeine 本地读取在 100ns 量级，Redis 在 1ms 量级，差距约 10000 倍。高 QPS 接口（如每秒几万次读同一热点数据）本地缓存收益极大。

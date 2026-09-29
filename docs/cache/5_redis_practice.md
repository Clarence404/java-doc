# Redis 实战

## 一、Spring Data Redis 集成

### 依赖与配置

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
<!-- 连接池（Lettuce 默认已内置，Jedis 需额外引入） -->
<dependency>
    <groupId>org.apache.commons</groupId>
    <artifactId>commons-pool2</artifactId>
</dependency>
```

```yaml
spring:
  redis:
    host: 127.0.0.1
    port: 6379
    password: yourpassword
    database: 0
    lettuce:
      pool:
        max-active: 16     # 最大连接数
        max-idle: 8        # 最大空闲连接
        min-idle: 2        # 最小空闲连接
        max-wait: 3000ms   # 获取连接等待超时
```

### Lettuce vs Jedis

| | Lettuce | Jedis |
|--|---------|-------|
| 线程安全 | ✅ 连接可共享（Netty）| ❌ 每线程独立连接 |
| 异步/响应式 | ✅ | ❌ |
| Spring Boot 默认 | ✅ | ❌ |
| 简单性 | 中 | 简单 |
| 推荐 | **首选** | 兼容老项目 |

### RedisTemplate 序列化配置

默认使用 JDK 序列化（二进制，不可读），推荐改为 JSON：

```java
@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);

        Jackson2JsonRedisSerializer<Object> serializer =
            new Jackson2JsonRedisSerializer<>(Object.class);
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.activateDefaultTyping(
            LaissezFaireSubTypeValidator.instance,
            ObjectMapper.DefaultTyping.NON_FINAL);  // 保存类型信息，反序列化时可还原
        serializer.setObjectMapper(mapper);

        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(serializer);
        template.setHashValueSerializer(serializer);
        template.afterPropertiesSet();
        return template;
    }
}
```

### Spring Cache 注解

```java
@EnableCaching
@Configuration
public class CacheConfig extends CachingConfigurerSupport {
    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration config = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(30))
            .serializeKeysWith(RedisSerializationContext.SerializationPair
                .fromSerializer(new StringRedisSerializer()))
            .serializeValuesWith(RedisSerializationContext.SerializationPair
                .fromSerializer(new GenericJackson2JsonRedisSerializer()));
        return RedisCacheManager.builder(factory).cacheDefaults(config).build();
    }
}
```

```java
@Service
public class ProductService {

    @Cacheable(value = "product", key = "#id", unless = "#result == null")
    public Product getById(Long id) { ... }       // 查询时缓存

    @CachePut(value = "product", key = "#product.id")
    public Product update(Product product) { ... } // 更新缓存

    @CacheEvict(value = "product", key = "#id")
    public void delete(Long id) { ... }            // 删除缓存

    @CacheEvict(value = "product", allEntries = true)
    public void clearAll() { ... }                 // 清空整个缓存
}
```

---

## 二、大 Key 问题

**定义：** String > 10KB，或 Hash/List/Set/ZSet 元素数 > 10000

**危害：**
- 读写操作耗时，阻塞单线程（`DEL` 大 key 可能卡秒级）
- 网络传输压力大
- 主从复制时影响延迟

**排查：**
```bash
redis-cli --bigkeys                           # 扫描大key（会占用CPU，生产谨慎）
redis-cli -h host -p port --bigkeys --sleep 0.1  # 限速扫描
# 或使用 DEBUG OBJECT key 查看序列化大小
```

**解决：**
- 大 String → 压缩（Snappy / Gzip）后存储
- 大 Hash/List → 分片存储（`hash:{0-99}:key`）
- 大 ZSet → 按时间/分类拆分多个 ZSet
- 删除大 key → 用 `UNLINK`（异步删除，不阻塞）代替 `DEL`

---

## 三、热 Key 问题

**定义：** 某个 key 被极高频访问（QPS 远超其他 key）

**危害：** 单节点压力集中，成为性能瓶颈

**解决方案：**

```java
// 1. 本地缓存兜底（L1缓存，减少Redis请求）
private final Cache<String, Object> localCache =
    Caffeine.newBuilder().expireAfterWrite(5, TimeUnit.SECONDS).maximumSize(1000).build();

public Object get(String key) {
    return localCache.get(key, k -> redisTemplate.opsForValue().get(k));
}

// 2. key 分片（读写分散到多个副本key）
String shardKey = "hot:product:" + (System.nanoTime() % SHARD_COUNT);
// 写入时同步所有分片，读取时随机选分片

// 3. Redis Cluster 将热key分散到不同slot（Hash Tag避免）
```

---

## 四、性能优化

### 连接池调优

```yaml
lettuce:
  pool:
    max-active: 根据QPS和RT计算，经验值：核心数 × 2
    max-wait: 不要设太长（3s以内），超时快速失败
```

### 避免耗时命令

| 禁用/慎用 | 替代方案 |
|---------|---------|
| `KEYS *`（全量扫描，阻塞）| `SCAN`（游标分批扫描）|
| `SMEMBERS`（大Set全量返回）| `SSCAN` |
| `DEL` 大key | `UNLINK`（异步）|
| 大量 `GET/SET` 逐条执行 | Pipeline 批量 |

### 监控指标

```bash
redis-cli info stats          # 命令统计
redis-cli info memory         # 内存使用
redis-cli info replication    # 主从状态
redis-cli slowlog get 10      # 慢查询（默认>10ms）

# 关键指标
used_memory_human             # 内存占用
keyspace_hits / keyspace_misses  # 命中率
connected_clients             # 当前连接数
instantaneous_ops_per_sec     # 实时QPS
```

---

## 五、常见面试问题

**Q：Redis 热 key 如何发现？**
1. 业务预估（已知的活动商品、热门榜单）
2. `redis-cli --hotkeys`（4.0+，需 LFU 淘汰策略）
3. 客户端埋点统计访问频率
4. 网络抓包分析

**Q：Redis 内存满了怎么办？**
1. 检查是否有大 key / 内存泄漏（`redis-cli --bigkeys`）
2. 确认 `maxmemory-policy` 配置是否合理（建议 `allkeys-lru`）
3. 扩容（升级实例 / 迁移到 Cluster）
4. 检查业务是否有无效数据未设 TTL

**Q：Redis 如何保证高性能写入？**
Pipeline 批量发送（减少 RTT）、合理设置连接池、避免慢命令、选择合适的序列化方案（JSON 比 JDK 序列化更快更小）。

---
description: Key / Value / TTL 规范、穿透与击穿防护、逻辑过期、雪崩、禁止事项、监控告警
---

# 缓存最佳实践

> 前置阅读：[Redis 实战](./5_redis_practice)、[缓存一致性](./10_cache_consistency)

本篇是缓存模块的规范清单，也是穿透、击穿防护代码的主文档。内容覆盖 Key / Value / TTL 规范、穿透击穿雪崩的防护写法、禁止事项与监控告警。

---

## 一、Key 设计规范

格式：`业务名:模块名:唯一标识[:字段]`，例如：

- `user:info:10001`
- `order:detail:20240601:88888`
- `product:stock:sku:A001`

规则：

- **统一前缀**：按业务、模块分段，避免不同业务的 key 冲突，也便于按前缀统计和清理（用 `SCAN` + `MATCH`，不要用 `KEYS`）
- **简短可读**：key 越长，占用的内存、网络带宽越多，比较也越慢；段名可以缩写，团队约定一个长度上限（例如 128 字节以内）
- **不用中文和特殊字符**：避免编码不一致导致的命中失败，也便于命令行排查
- **不要过于通用**：不要直接用 `id`、`list` 这类无业务含义的 key
- **Cluster 下的多 key 操作**：需要同一 slot 的 key 用 hash tag，如 `cart:{10001}:items` 与 `cart:{10001}:count`

---

## 二、Value 设计规范

- **拒绝大 Key**：单个 String 过大、集合元素过多都会导致读写阻塞、网络拥塞和迁移困难，需要拆分；判定标准、排查与拆分方法见 [Redis 实战](./5_redis_practice)
- **序列化**：优先 JSON（可读、跨语言），数值直接存字符串；不用 Java 原生序列化（体积大、不跨语言、有反序列化安全风险）
- **压缩**：较大的文本值（如超过 1 KB）可以考虑 Snappy、LZ4 等压缩，用 CPU 换内存与带宽
- **按需缓存**：不把整张表或全量列表塞进一个 key；列表类数据缓存 ID 列表 + 单条详情，或分页缓存

---

## 三、过期时间规范

- **缓存 key 必须有 TTL**：数据自然过期、内存可回收；在 `volatile-lru` / `volatile-lfu` 等淘汰策略下，没有 TTL 的 key 永远不会被淘汰。TTL 也是缓存与数据库不一致时的最后一道兜底
- **淘汰策略**：Redis 默认 `maxmemory-policy noeviction`，内存达到上限后写命令直接报错。纯缓存实例用 `allkeys-lfu`（或 `allkeys-lru`）；与必须保留的数据混用时用 `volatile-lfu`，并确保缓存 key 都带 TTL
- **TTL 加随机抖动**：避免大量 key 同时过期引发雪崩；写入与设置 TTL 要在**一条命令**里完成，分开调用 `set` 再 `expire`，进程在两步之间崩溃会留下永不过期的 key

```java
// 不推荐：两条命令，非原子，且没有抖动
redis.opsForValue().set(key, json);
redis.expire(key, Duration.ofSeconds(3600));

// 推荐：SET key value EX ttl 一步完成，TTL 加 0–300 秒抖动
long ttl = 3600 + ThreadLocalRandom.current().nextInt(300);
redis.opsForValue().set(key, json, Duration.ofSeconds(ttl));
```

- **逻辑过期是唯一的例外形式**：热点 key 使用逻辑过期时，物理 TTL 仍然要设置，只是设得远大于逻辑过期时间（见第五节）

---

## 四、缓存穿透防护

**穿透**：请求的数据在缓存和数据库中都不存在，每次都打到数据库，常见于恶意构造的 ID。

### 1、缓存空值

```java
private static final String NULL_VALUE = "@@NULL@@";   // 空值占位，不会与 JSON 冲突

/** hit=false 表示未命中；hit=true 且 value=null 表示命中了缓存的空值 */
private record CacheResult<T>(boolean hit, T value) {}

private CacheResult<User> readCache(String key) {
    String json = redis.opsForValue().get(key);
    if (json == null) {
        return new CacheResult<>(false, null);
    }
    if (NULL_VALUE.equals(json)) {
        return new CacheResult<>(true, null);
    }
    return new CacheResult<>(true, jsonMapper.readValue(json, User.class));
}

private void writeCache(String key, User user) {
    if (user == null) {
        redis.opsForValue().set(key, NULL_VALUE, Duration.ofSeconds(60));          // 空值短 TTL
    } else {
        long ttl = 3600 + ThreadLocalRandom.current().nextInt(300);
        redis.opsForValue().set(key, jsonMapper.writeValueAsString(user), Duration.ofSeconds(ttl));
    }
}
```

- 空值 TTL 要短（几十秒到几分钟），数据新建后写路径也要删除对应 key
- 用 `CacheResult` 区分「未命中」与「命中空值」，不要用 `null` 同时表示两者
- `redis` 为 `StringRedisTemplate`，`jsonMapper` 为 Jackson 3 的 `JsonMapper`

### 2、布隆过滤器与参数校验

- ID 空间大、攻击流量随机时，空值缓存会被大量不同 key 撑满，改用布隆过滤器前置拦截，实现见 [Redis 典型应用场景](./4_redis_scenario)
- 入口先做参数校验（ID 格式、范围），非法请求直接拒绝；持续的恶意流量交给限流，见 [限流与过载保护](/high-avail/7_rate_limiting)

---

## 五、缓存击穿防护

**击穿**：某个热点 key 过期的瞬间，大量并发请求同时回源数据库。

### 1、单 JVM 内合并回源

先在进程内把同一 key 的并发回源合并为一次，能挡住绝大部分重复请求，也减少了对 Redis 锁的争抢：

- Caffeine 的 `cache.get(key, loader)`，见 [Caffeine](./7_caffeine)
- Spring Cache 的 `@Cacheable(sync = true)`，见 [Cache 抽象](/spring/5_cache)
- JetCache 的 `@CachePenetrationProtect`，见 [JetCache](./9_jetcache)
- 手写 Single Flight，见 [热点问题](/high-con/6_hotspot)

这些手段都只在单个 JVM 内有效，N 个实例仍会各自回源一次。实例数多、回源代价大时，再加跨实例的互斥重建。

### 2、互斥重建（跨实例）

```java
private static final DefaultRedisScript<Long> UNLOCK_SCRIPT = new DefaultRedisScript<>(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        Long.class);

public Optional<User> getUser(long id) {
    String key = "user:info:" + id;
    String lockKey = "lock:user:info:" + id;

    for (int attempt = 0; attempt < 20; attempt++) {                 // 最多等待约 1 秒
        CacheResult<User> cached = readCache(key);
        if (cached.hit()) {
            return Optional.ofNullable(cached.value());
        }
        String token = UUID.randomUUID().toString();                 // 锁的值用随机 token 标识持有者
        if (Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(lockKey, token, Duration.ofSeconds(10)))) {
            try {
                cached = readCache(key);                             // 双重检查：别人可能刚重建完
                if (cached.hit()) {
                    return Optional.ofNullable(cached.value());
                }
                User user = userDao.findById(id);                    // 可能为 null
                writeCache(key, user);                               // null 时写入空值占位
                return Optional.ofNullable(user);
            } finally {
                redis.execute(UNLOCK_SCRIPT, List.of(lockKey), token);  // 只删除自己持有的锁
            }
        }
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(50));    // 没抢到锁，稍后重读缓存
    }
    // 等待超时：降级为直接查库（也可以返回兜底数据），不能返回 null 冒充「数据不存在」
    return Optional.ofNullable(userDao.findById(id));
}
```

- **`setIfAbsent` 返回 `Boolean`**，在管道或事务中可能为 `null`，用 `Boolean.TRUE.equals(...)` 判断，避免自动拆箱空指针
- **解锁必须校验持有者**：数据库加载超过锁的 10 秒租期时，锁已过期并被其他线程拿到，直接 `DEL` 会删掉别人的锁；用随机 token + Lua 比较后删除。也可以直接用 Redisson 的 `RLock`，原理见 [分布式锁](/distributed/3_lock)
- **锁过期后可能有两个线程同时重建**：对缓存重建而言只是多一次回源，可以接受；锁只是减少回源次数，不承担数据正确性
- **等待要有上限**：没抢到锁的请求有限次重读缓存，超时后降级，而不是一直等或返回 `null`

### 3、逻辑过期

对极热、允许短暂读到旧值的 key，可以让请求永远不等待回源：

- 缓存值中带逻辑过期时间，如 `{"data": {...}, "expireAt": 1767225600000}`
- 读到的值已逻辑过期时，**先返回旧值**，同时用 `tryLock`（同上的 token 锁）抢重建权，抢到的线程把重建任务提交到有界线程池异步执行
- **物理 TTL 仍要设置**，并远大于逻辑过期时间（例如逻辑 10 分钟、物理 1 天），既满足「所有 key 都有 TTL」，也防止数据不再被访问后永久占用内存
- key 不存在（未预热或物理过期）时，退化为上一小节的互斥重建；热点数据上线前应先预热
- 只适用于热点、可容忍旧值的数据；数据更新时仍按 Cache Aside 删除 key，下次读取走互斥重建

| 方案 | 请求是否等待 | 一致性 | 适用 |
|------|------------|--------|------|
| 单 JVM 合并回源 | 同 key 的并发请求等待一次加载 | 好 | 所有本地 / 远程缓存的默认手段 |
| 互斥重建 | 未抢到锁的请求短暂等待 | 好 | 回源代价大、实例多 |
| 逻辑过期 | 不等待，返回旧值 | 重建完成前读到旧值 | 极热且容忍旧值的数据 |

---

## 六、缓存雪崩防护

**雪崩**：大量 key 同时过期，或缓存服务整体不可用，请求集中打到数据库。

- TTL 加随机抖动（见第三节），批量预热的数据尤其要打散
- Redis 用哨兵或 Cluster 保证高可用，见 [Redis 集群](./3_redis_cluster)
- 本地缓存兜底热点数据，见 [两级缓存（L1 + L2）](./8_two_level_cache)
- 缓存不可用时对数据库限流、降级，见 [限流与过载保护](/high-avail/7_rate_limiting) 与 [降级](/high-avail/6_degradation)

---

## 七、缓存与数据库一致性

1. 先更新数据库，**事务提交后**删除缓存，不要更新缓存
2. 删除失败要重试；可靠的兜底是 binlog / CDC 订阅删除
3. 读从库或高并发场景加延迟双删，第二次删除用延迟消息实现
4. 所有缓存 key 都有 TTL

完整方案见 [缓存一致性](./10_cache_consistency)。

---

## 八、禁止事项

| 禁止 | 原因 | 替代方案 |
|------|------|---------|
| `KEYS *` | 遍历全部 key，O(N) 阻塞主线程 | `SCAN` 游标分批扫描 |
| `DEL` 大 key | 同步释放大量内存，阻塞主线程 | `UNLINK` 异步删除，或开启 `lazyfree-lazy-user-del yes` 让 `DEL` 也异步释放 |
| 对大集合 `HGETALL` / `SMEMBERS` / `LRANGE 0 -1` | O(N)，一次返回大量数据 | `HSCAN` / `SSCAN` 分批，或按需取字段 |
| 不设 TTL 的缓存 key | 内存只增不减，`volatile-*` 策略下无法被淘汰 | 写入时一并设置 TTL |
| 用 `WATCH` + `MULTI` 实现复杂读改写 | 乐观事务：冲突时 `EXEC` 失败需要重试，高并发下反复失败；没有回滚；超大事务在 `EXEC` 时一次性执行会阻塞 | Lua 脚本或 Functions（Redis 7.0+）；脚本执行期间同样阻塞，要保持短小 |
| 循环内逐条 `GET` / `SET` | N 次网络往返 | `MGET` / `MSET` 或 Pipeline |
| 明文缓存敏感信息 | 缓存的访问控制与审计通常弱于数据库 | 加密后存储或不缓存，见 [数据安全](/security/7_data_security) |
| 用 `setIfAbsent` + `DEL` 手写锁 | 解锁不校验持有者，会误删别人的锁 | token + Lua 解锁，或 Redisson `RLock` |

---

## 九、监控告警

下表阈值为参考值，需按业务负载调整：

| 指标 | 来源 | 参考告警阈值 |
|------|------|-------------|
| 命中率 | `INFO stats`：`keyspace_hits / (keyspace_hits + keyspace_misses)` | 明显低于历史基线（如 < 80%） |
| 内存使用 | `INFO memory`：`used_memory` / `maxmemory` | > 80% |
| 淘汰数 | `INFO stats`：`evicted_keys` 增速 | 持续增长 |
| 慢命令 | `SLOWLOG GET`，阈值由 `slowlog-log-slower-than` 配置（默认 10000 微秒即 10 ms） | 出现超过 10 ms 的命令即排查 |
| 连接数 | `INFO clients`：`connected_clients` / `maxclients`，及客户端连接池使用率 | > 80% |
| 大 Key / 热 Key | `redis-cli --bigkeys`、`--hotkeys`（需 LFU 策略） | 定期巡检 |
| 客户端 GC | 应用 JVM 监控 | 反序列化大对象导致 GC 频繁 |

---

## 小结

- Key 统一前缀、简短可读；Value 拒绝大 Key、不用 Java 原生序列化
- 所有缓存 key 都有 TTL，写入与 TTL 用一条命令完成并加随机抖动；纯缓存实例用 `allkeys-lfu`
- 穿透：空值短 TTL + 区分未命中与空值，ID 空间大时用布隆过滤器
- 击穿：先在单 JVM 内合并回源，再按需加跨实例互斥重建；锁用随机 token + Lua 解锁，等待有上限并降级
- 逻辑过期返回旧值、异步重建，物理 TTL 仍要设置且远大于逻辑过期
- 一致性：提交后删缓存 + 重试 + binlog 兜底 + TTL
- 禁止 `KEYS`、同步删大 key、`WATCH` 实现复杂逻辑；用 `SCAN`、`UNLINK`、Lua

缓存架构层面的预热、多级缓存与三大问题的整体策略见 [缓存架构设计](/high-con/3_cache_architecture)，热点 key 的探测与治理见 [热点问题](/high-con/6_hotspot)。

## 参考资料

- Redis 官方文档 · Key eviction：[https://redis.io/docs/latest/develop/reference/eviction/](https://redis.io/docs/latest/develop/reference/eviction/)
- Redis 官方文档 · Transactions：[https://redis.io/docs/latest/develop/interact/transactions/](https://redis.io/docs/latest/develop/interact/transactions/)
- Redis 官方文档 · Distributed locks with Redis：[https://redis.io/docs/latest/develop/use/patterns/distributed-locks/](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)
- Redis 官方文档 · SLOWLOG：[https://redis.io/docs/latest/commands/slowlog/](https://redis.io/docs/latest/commands/slowlog/)
- Redis 官方文档 · UNLINK：[https://redis.io/docs/latest/commands/unlink/](https://redis.io/docs/latest/commands/unlink/)
- Redis 官方文档 · INFO：[https://redis.io/docs/latest/commands/info/](https://redis.io/docs/latest/commands/info/)

> 返回：[缓存总览](./0_overview)

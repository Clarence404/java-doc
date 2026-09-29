# Redisson

## 一、Redisson 是什么

Redisson 是基于 Redis 的 **Java 分布式工具包**，不只是 Redis 客户端，更提供了分布式锁、分布式集合、限流器等高级分布式功能。

## 二、与其他 Redis 客户端对比

| 对比项 | Redisson | Lettuce | Jedis |
|--------|----------|---------|-------|
| 基础操作 | ✅ | ✅ | ✅ |
| 异步/响应式 | ✅ | ✅ | ❌ |
| 分布式锁 | ✅ 内置 | ❌ | ❌ |
| 高级数据结构 | ✅ | ❌ | ❌ |
| 二级缓存 | ✅ | ❌ | ❌ |
| 使用复杂度 | 中 | 中 | 简单 |
| 适合场景 | 企业级分布式系统 | Spring Boot 默认缓存 | 简单读写 |

## 三、核心功能

### 分布式锁

```java
RLock lock = redissonClient.getLock("order:lock:" + orderId);

// 方式1：自动续期（看门狗，不设超时）
lock.lock();
try {
    // 业务逻辑
} finally {
    lock.unlock();
}

// 方式2：指定超时（不启用看门狗）
lock.lock(10, TimeUnit.SECONDS);

// 方式3：尝试获取（不阻塞）
if (lock.tryLock(0, 10, TimeUnit.SECONDS)) {
    try { ... } finally { lock.unlock(); }
}
```

**看门狗机制：** 不指定超时时间时，Redisson 默认加锁30秒，后台每隔10秒检查业务是否还在执行，是则续期30秒，防止锁因业务耗时超过TTL而提前释放。

**建议：** 业务明确耗时上限时，指定超时时间并关闭看门狗（避免看门狗线程开销）。

### 公平锁

```java
RLock fairLock = redissonClient.getFairLock("fair:lock");
// 按请求先后顺序获取，防止饥饿
```

### 读写锁

```java
RReadWriteLock rwLock = redissonClient.getReadWriteLock("rw:lock");

// 读锁（多个线程可同时持有）
RLock readLock = rwLock.readLock();
readLock.lock();
try { ... } finally { readLock.unlock(); }

// 写锁（独占）
RLock writeLock = rwLock.writeLock();
writeLock.lock();
try { ... } finally { writeLock.unlock(); }
```

### 联锁（MultiLock）

```java
// 同时锁多个资源，解决 RedLock 多节点问题
RLock lock1 = redissonClient.getLock("lock1");
RLock lock2 = redissonClient.getLock("lock2");
RLock multiLock = redissonClient.getMultiLock(lock1, lock2);
multiLock.lock();
```

### 限流器

```java
RRateLimiter limiter = redissonClient.getRateLimiter("api:rate");
// 全局每秒最多5次
limiter.trySetRate(RateType.OVERALL, 5, 1, RateIntervalUnit.SECONDS);

if (limiter.tryAcquire()) {
    // 放行
} else {
    throw new RateLimitException("请求频繁，请稍后重试");
}
```

### 延迟队列

```java
RBlockingQueue<String> blockingQueue = redissonClient.getBlockingQueue("delay:queue");
RDelayedQueue<String> delayedQueue = redissonClient.getDelayedQueue(blockingQueue);

// 生产：延迟30秒执行
delayedQueue.offer(orderId, 30, TimeUnit.SECONDS);

// 消费
String task = blockingQueue.take();  // 阻塞直到有到期任务
```

### 分布式 Map（带本地缓存）

```java
RLocalCachedMap<String, User> map = redissonClient.getLocalCachedMap(
    "users",
    LocalCachedMapOptions.defaults()
        .evictionPolicy(EvictionPolicy.LFU)
        .cacheSize(1000)
        .timeToLive(10, TimeUnit.MINUTES)
);
// 读操作优先读本地缓存，写操作同步到 Redis 并通知其他节点更新本地缓存
```

## 四、Spring Boot 集成

```xml
<dependency>
    <groupId>org.redisson</groupId>
    <artifactId>redisson-spring-boot-starter</artifactId>
    <version>3.24.3</version>
</dependency>
```

```yaml
spring:
  redis:
    host: 127.0.0.1
    port: 6379
```

```java
@Autowired
private RedissonClient redissonClient;
```

## 五、常见面试问题

**Q：Redisson 看门狗的续期间隔是多少？**
默认锁超时时间是30秒，看门狗每 `lockWatchdogTimeout / 3 = 10秒` 检查一次并续期。

**Q：Redisson 分布式锁如何实现可重入？**
底层用 Hash 结构存储 `{线程ID: 重入次数}`，同一线程再次加锁时计数+1，释放时-1，减到0才真正释放。

**Q：RedLock 是什么？有什么问题？**
RedLock 是 Redis 作者 antirez 提出的多节点锁方案：向5个独立 Redis 节点申请锁，超过半数成功才视为加锁成功。争议在于：时钟漂移、GC 暂停、网络延迟等情况下仍可能出现两个客户端同时持锁，Martin Kleppmann 等人认为不应用于严格要求互斥的场景。

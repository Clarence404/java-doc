---
description: 客户端对比、锁 API 与看门狗、限流器、延迟队列、本地缓存 Map、Spring Boot 集成
---

# Redisson

> **本篇目标**：会用 Redisson 的锁、限流器、延迟队列与本地缓存 Map 这几类常用对象，知道每个 API 的语义边界（看门狗何时生效、`leaseTime` 的风险、`trySetRate` 只设置一次等），并能在 Spring Boot 4 下正确接入。
>
> **前置阅读**：[Redis 基础](./1_redis_base)、[Redis 实战](./5_redis_practice)、[分布式锁](/distributed/3_lock)

Redisson 是基于 Redis 的 **Java 分布式对象库**：除了基础读写，还把锁、信号量、限流器、队列、带本地缓存的 Map 等封装成 Java 对象，底层用 Lua 脚本和 Pub/Sub 保证原子性与通知。本篇只讲 Redisson 的 API 用法与语义；分布式锁的原理、Redlock 争议、fencing token 的必要性见 [分布式锁](/distributed/3_lock)。

**版本基线**：Redisson 4.x（Spring Boot Starter 写作时为 4.8.0，支持 Spring Boot 1.3 – 4.1），服务端 Redis 8.x / Valkey 8.x。

---

## 一、与其他 Redis 客户端对比

| 对比项 | Redisson | Lettuce | Jedis |
|--------|----------|---------|-------|
| 基础命令 | 支持（以对象 API 为主） | 支持 | 支持 |
| 异步 / 响应式 | 支持 | 支持（基于 Netty） | 不支持 |
| 分布式锁、信号量、限流器 | 内置 | 无，需自己写 Lua | 无，需自己写 Lua |
| 带本地缓存的 Map | 内置 `RLocalCachedMap` | 提供客户端缓存（RESP3 tracking） | 无 |
| 连接模型 | Netty 连接池 | 单连接多路复用 | 连接池 |
| 定位 | 分布式对象与协调工具 | Spring Boot 默认的 Redis 客户端 | 轻量同步客户端 |

常见组合：Spring Data Redis 继续用 Lettuce 做普通读写，Redisson 只用于锁、限流器等协调类对象；也可以让 Redisson 直接充当 Spring Data Redis 的连接工厂（见第六节）。

---

## 二、分布式锁 API

### 1、RLock：看门狗与 leaseTime

```java
RLock lock = redissonClient.getLock("lock:order:" + orderId);

// 方式 1：不指定 leaseTime，启用看门狗自动续期
lock.lock();
try {
    // 业务逻辑
} finally {
    lock.unlock();
}

// 方式 2：等待最多 3 秒，不指定 leaseTime（仍启用看门狗）
if (lock.tryLock(3, TimeUnit.SECONDS)) {
    try {
        // 业务逻辑
    } finally {
        if (lock.isHeldByCurrentThread()) {
            lock.unlock();
        }
    }
}

// 方式 3：指定 leaseTime = 10 秒，看门狗不生效，10 秒后锁自动过期
if (lock.tryLock(3, 10, TimeUnit.SECONDS)) {
    try {
        // 业务逻辑（必须确定能在 10 秒内完成）
    } finally {
        if (lock.isHeldByCurrentThread()) {
            lock.unlock();
        }
    }
}
```

- **看门狗**：不指定 `leaseTime` 时，锁的默认过期时间为 `lockWatchdogTimeout`（默认 30 秒），持锁期间每隔 `lockWatchdogTimeout / 3`（10 秒）续期一次；持锁的 Redisson 实例宕机后不再续期，锁最多 30 秒后自动释放
- **指定 `leaseTime` 的风险**：业务一旦超过 `leaseTime`，锁已过期、另一个线程已拿到锁，原线程仍在执行，互斥被打破；之后原线程 `unlock()` 会抛 `IllegalMonitorStateException`。耗时不确定的业务应使用看门狗
- **解锁前判断持有者**：`isHeldByCurrentThread()` 避免在超时、未拿到锁等分支里误解锁；Redisson 解锁本身会校验持有者，不会删掉别人的锁
- **看门狗不是万能的**：长时间 GC 停顿、网络分区期间，锁仍可能过期而原持有者不知情。对正确性要求严格的写操作，需要在资源侧校验 fencing token（见下一小节）
- **可重入**：锁在 Redis 中是一个 Hash，field 为「Redisson 实例 UUID + 线程 ID」，value 为重入次数，同一线程重复加锁计数加 1，计数减到 0 才删除 key

### 2、RFencedLock：带 fencing token 的锁

```java
RFencedLock lock = redissonClient.getFencedLock("lock:stock:" + skuId);
Long token = lock.lockAndGetToken();     // 每次加锁返回单调递增的 token
try {
    // 资源侧只接受比已记录 token 更大的写入，旧持有者的迟到写入会被拒绝
    int updated = stockMapper.updateWithFence(skuId, newStock, token);
    // SQL 示例：UPDATE stock SET qty = ?, fence = ? WHERE sku_id = ? AND fence < ?
} finally {
    lock.unlock();
}
```

fencing token 解决的是「客户端以为自己还持有锁」的问题：即使锁因停顿过期，旧持有者的写入也会因 token 较小被资源侧拒绝。前提是被保护的资源（数据库、存储服务）支持按 token 做条件写。

### 3、公平锁、读写锁与联锁

```java
// 公平锁：按请求顺序（FIFO）获取，避免饥饿；吞吐低于普通锁
RLock fairLock = redissonClient.getFairLock("lock:fair:report");

// 读写锁：读锁可被多个线程同时持有，写锁独占
RReadWriteLock rwLock = redissonClient.getReadWriteLock("lock:rw:config");
RLock readLock = rwLock.readLock();
readLock.lock();
try {
    // 读配置
} finally {
    readLock.unlock();
}

// 联锁：把多把锁当作一把锁，必须全部加锁成功才算成功
RLock lockA = redissonClient.getLock("lock:account:" + fromId);
RLock lockB = redissonClient.getLock("lock:account:" + toId);
RLock multiLock = redissonClient.getMultiLock(lockA, lockB);
multiLock.lock();
try {
    // 同时操作两个账户
} finally {
    multiLock.unlock();
}
```

- 公平锁的等待线程如果宕机，Redisson 会等它 5 秒再交给下一个，等待队列里死线程越多延迟越大
- 联锁（MultiLock）用于**同时锁住多个资源**，要求每一把都成功，它不是 Redlock；Redlock 需要在多个独立主节点上拿到多数派
- `RedissonRedLock` 已被官方标记为废弃，推荐改用 `RLock` 或 `RFencedLock`；Redlock 的争议见 [分布式锁](/distributed/3_lock)

> 秒杀扣库存不要把分布式锁当作防超卖的主手段，应使用 Lua 原子扣减或数据库条件更新（`WHERE stock >= ?`），锁只用来降低冲突。

---

## 三、限流器 RRateLimiter

```java
RRateLimiter limiter = redissonClient.getRateLimiter("rate:api:createOrder");
// 只在限流器尚未配置时生效：全局每秒 5 个许可；限流器对象 1 小时无访问后自动过期
limiter.trySetRate(RateType.OVERALL, 5, Duration.ofSeconds(1), Duration.ofHours(1));

if (!limiter.tryAcquire()) {
    throw new TooManyRequestsException("请求频繁，请稍后重试");   // 业务自定义异常
}
```

- `RateType.OVERALL`：所有 Redisson 实例共享同一个额度；`RateType.PER_CLIENT`：每个 Redisson 实例各自一份额度
- `trySetRate` **只在首次设置时生效**，已有配置时返回 `false`；要修改速率用 `setRate`
- 带 `RateIntervalUnit` 的旧重载已废弃，改用 `Duration` 版本
- 获取许可本身要访问 Redis，限流器自身成为热点时要考虑网关层或本地限流

限流算法的选型（固定窗口、滑动窗口、令牌桶、漏桶）以及网关、Sentinel 方案见 [限流与过载保护](/high-avail/7_rate_limiting)。

---

## 四、延迟队列

```java
RBlockingQueue<String> destQueue = redissonClient.getBlockingQueue("queue:order:timeout");
RDelayedQueue<String> delayedQueue = redissonClient.getDelayedQueue(destQueue);

// 生产：30 分钟后进入目标队列
delayedQueue.offer(orderNo, 30, TimeUnit.MINUTES);

// 消费：阻塞直到有到期元素
String due = destQueue.take();
```

- 开源版的 `RDelayedQueue` 已被官方标记为废弃，替代品 `RReliableQueue`（支持按消息设置延迟、确认与重投）仅在 Redisson PRO 中提供
- `RDelayedQueue` 的元素先放在内部有序集合里，由客户端的定时任务转移到目标队列：**至少要有一个打开了该延迟队列的 Redisson 实例存活**，元素才会按时转移
- 元素被 `take()` 取出后就从队列删除，消费失败没有重投机制，需要业务自己补偿

订单超时取消这类需要可靠投递的业务，优先使用 MQ 的延迟消息（RocketMQ 5.x 支持任意延迟时间，见 [RocketMQ](/messaging/3_rocketmq)）；基于 ZSet 的手写延迟队列见 [Redis 典型应用场景](./4_redis_scenario)。

---

## 五、带本地缓存的 Map：RLocalCachedMap

```java
LocalCachedMapOptions<String, User> options = LocalCachedMapOptions.<String, User>name("users")
        .cacheSize(1000)                                                  // 本地最多 1000 条
        .evictionPolicy(LocalCachedMapOptions.EvictionPolicy.LFU)
        .timeToLive(Duration.ofMinutes(10))                               // 本地条目 TTL
        .syncStrategy(LocalCachedMapOptions.SyncStrategy.INVALIDATE)      // 其他实例收到变更后失效本地条目
        .reconnectionStrategy(LocalCachedMapOptions.ReconnectionStrategy.CLEAR); // 断线重连后清空本地缓存

RLocalCachedMap<String, User> users = redissonClient.getLocalCachedMap(options);
User u = users.get("10001");   // 先读本地，未命中再读 Redis
```

（`LocalCachedMapOptions` 位于 `org.redisson.api.options` 包；旧的 `LocalCachedMapOptions.defaults()` 写法已废弃。）

- 读：优先读本地缓存，未命中读 Redis Hash 并回填本地
- 写：先写 Redis，再通过 Pub/Sub 通知其他实例；`syncStrategy` 默认 `INVALIDATE`（其他实例删除本地条目），`UPDATE` 会把新值推给其他实例，`NONE` 不同步
- 断线期间的通知会丢失：`reconnectionStrategy` 默认 `NONE`，生产环境应设为 `CLEAR`（重连后清空）或 `LOAD`（重连后只删除断线期间变更过的 key）
- 它适合数据量小、读多写少的字典 / 配置类数据；与数据库的一致性仍要按 [缓存一致性](./10_cache_consistency) 处理

本地缓存与 Redis 两级组合的通用做法见 [两级缓存（L1 + L2）](./8_two_level_cache)。

---

## 六、Spring Boot 集成

```xml
<dependency>
    <groupId>org.redisson</groupId>
    <artifactId>redisson-spring-boot-starter</artifactId>
    <version>4.8.0</version>
</dependency>
```

```yaml
spring:
  data:
    redis:                      # Spring Boot 3+ 的前缀；2.x 时代的 spring.redis.* 已不再生效
      host: 127.0.0.1
      port: 6379
      password: ${REDIS_PASSWORD:}
```

```java
@Service
public class OrderService {

    private final RedissonClient redissonClient;

    public OrderService(RedissonClient redissonClient) {
        this.redissonClient = redissonClient;
    }
}
```

- Starter 读取 `spring.data.redis.*` 自动创建 `RedissonClient`；需要哨兵、集群、线程数等 Redisson 专属配置时，按官方文档在 `spring.redis.redisson.file`（或 `config`）中指定 Redisson 自己的 YAML
- Starter 会同时注册 `RedissonConnectionFactory`，`RedisTemplate` 也会改走 Redisson 连接；只想用 Redisson 的分布式对象时，可单独引入 `redisson` 并自建 `RedissonClient`
- Starter 依赖与最新 Spring Boot 对应的 `redisson-spring-data-xx` 模块（Spring Boot 4.0 对应 `redisson-spring-data-40`）；在旧版 Spring Boot 上使用时，需排除默认模块并换成对应版本

---

## 小结

- Redisson 是分布式对象库：锁、限流器、队列、本地缓存 Map 都以 Java 对象的形式提供
- 锁默认用看门狗续期（30 秒租期、每 10 秒续一次）；指定 `leaseTime` 会关闭看门狗，业务超时就会打破互斥
- 解锁前用 `isHeldByCurrentThread()` 判断；严格互斥的写操作用 `RFencedLock` + 资源侧 token 校验
- MultiLock 是「多把锁都要拿到」，不是 Redlock；`RedissonRedLock` 已废弃
- `RRateLimiter.trySetRate` 只在首次设置时生效，新代码用 `Duration` 重载
- 开源版 `RDelayedQueue` 已废弃且依赖客户端转移，可靠延迟任务优先用 MQ 延迟消息
- `RLocalCachedMap` 默认 `INVALIDATE` 同步，生产环境要配置 `reconnectionStrategy`
- Spring Boot 3+ 用 `spring.data.redis.*` 配置，Starter 4.x 已支持 Spring Boot 4

## 参考资料

- Redisson 官方文档 · Locks and synchronizers：[https://redisson.pro/docs/data-and-services/locks-and-synchronizers/](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)
- Redisson 官方文档 · Objects（RateLimiter）：[https://redisson.pro/docs/data-and-services/objects/](https://redisson.pro/docs/data-and-services/objects/)
- Redisson 官方文档 · Collections（Local cache）：[https://redisson.pro/docs/data-and-services/collections/](https://redisson.pro/docs/data-and-services/collections/)
- Redisson 官方文档 · Queues：[https://redisson.pro/docs/data-and-services/queues/](https://redisson.pro/docs/data-and-services/queues/)
- Redisson 官方文档 · Integration with Spring：[https://redisson.pro/docs/integration-with-spring/](https://redisson.pro/docs/integration-with-spring/)
- Redisson GitHub：[https://github.com/redisson/redisson](https://github.com/redisson/redisson)

> 下一篇：[Caffeine](./7_caffeine) —— 进程内缓存的淘汰算法、过期与刷新策略，以及在 Spring Boot 中的接入方式。

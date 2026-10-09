---
description: Redis 锁与 Redisson、Fencing Token、Redlock 争议、ZooKeeper 与 etcd
---

# 分布式锁

> **本篇目标**：写出正确的 Redis 锁（加锁带 owner 与过期时间、解锁先校验 owner），理解看门狗能解决什么、解决不了什么，知道「效率锁」与「正确性锁」的区别以及 Fencing Token 的用法，能在 Redis、ZooKeeper、etcd 之间做选型。
>
> **前置阅读**：[分布式理论](./2_theorem)

---

## 一、为什么需要分布式锁

`synchronized` / `ReentrantLock` 只在一个 JVM 内有效。多个实例要互斥地访问同一资源（同一张订单、同一个定时任务、同一个外部账户），就需要跨进程的锁。

一个可用的分布式锁要满足：

| 要求 | 含义 |
|------|------|
| 互斥 | 同一时刻只有一个客户端持有锁 |
| 不死锁 | 持有者崩溃后锁能自动释放（靠过期时间、会话或租约） |
| 只能由持有者释放 | 解锁要校验 owner，不能删掉别人的锁 |
| 容错 | 锁服务部分节点故障时仍可用 |

先分清用锁的目的，它决定了要多严格：

- **效率锁**：避免重复干活，比如多实例只让一个去刷新缓存。偶尔两个客户端同时持锁，代价只是多做一次，Redis 单实例锁足够
- **正确性锁**：同时持锁会写坏数据，比如两个进程同时改同一账户。仅靠任何基于租约的锁都不够，被保护的资源还要校验 Fencing Token 或使用条件更新（见第三节）

---

## 二、Redis 分布式锁

### 1、加锁与解锁

加锁用一条原子命令同时完成「不存在才设置」和「设置过期时间」，value 存本次加锁的唯一标识：

```bash
SET lock:order:1001 8f14e45f-ceea-4e7a NX PX 30000
```

不要用 `SETNX` 再 `EXPIRE` 两步：中间崩溃就会留下永不过期的锁。

解锁必须先比较 value 再删除，并且两步是原子的。Redis 8.4 起有原生命令：

```bash
DELEX lock:order:1001 IFEQ 8f14e45f-ceea-4e7a
```

Redis 8.4 之前的版本和 Valkey 用 Lua 脚本：

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

为什么 value 要唯一：A 加锁后执行太久，锁过期被 B 拿到；A 执行完直接 `DEL`，删掉的是 B 的锁，C 又能进来。

Spring Data Redis 中的写法：

```java
@Component
@RequiredArgsConstructor
public class RedisLock {

    private static final RedisScript<Long> UNLOCK = RedisScript.of("""
            if redis.call('get', KEYS[1]) == ARGV[1] then
                return redis.call('del', KEYS[1])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    /** 加锁成功返回 token，失败返回 null */
    public String tryLock(String key, Duration ttl) {
        String token = UUID.randomUUID().toString();
        Boolean ok = redis.opsForValue().setIfAbsent(key, token, ttl);   // SET key token NX PX ttl
        return Boolean.TRUE.equals(ok) ? token : null;
    }

    public boolean unlock(String key, String token) {
        Long n = redis.execute(UNLOCK, List.of(key), token);
        return n != null && n == 1L;
    }
}
```

### 2、Redisson 与看门狗

手写锁很难处理好续期、可重入和等待。生产中一般直接用 Redisson（API 细节见 [Redisson](/cache/6_redisson)）：

```java
RLock lock = redisson.getLock("lock:order:" + orderId);
if (!lock.tryLock(3, TimeUnit.SECONDS)) {          // 最多等 3 秒，不传 leaseTime → 启用看门狗
    throw new BizException("处理中，请稍后重试");
}
try {
    // 业务逻辑
} finally {
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

看门狗的真实行为：

- **只在不指定 leaseTime 时生效**（`lock()`、`tryLock(waitTime, unit)`）。调用 `lock(10, SECONDS)` 或 `tryLock(3, 10, SECONDS)` 指定了 leaseTime，就不会续期，到点即释放
- 默认锁过期时间是 `lockWatchdogTimeout` = 30 秒，每 10 秒（三分之一）续期一次
- 续期只看 JVM 和 Redisson 客户端是否存活，**不看业务线程是否还在正常推进**。业务线程卡死而进程活着，锁会被一直续下去
- 进程崩溃后续期停止，锁最多 30 秒后过期

可重入：Redisson 用 Hash 存锁，field 是 `客户端 UUID:线程 ID`（只用线程 ID 会在不同 JVM 间冲突），value 是重入次数，减到 0 才删除 key。

### 3、主从切换导致锁丢失

Redis 主从复制是异步的：

1. 客户端 A 在主节点加锁成功
2. 锁还没复制到从节点，主节点宕机
3. 从节点被提升为新主节点，上面没有这把锁
4. 客户端 B 加锁成功，A 和 B 同时持锁

`WAIT numreplicas timeout`（以及 Redis 7.2 起的 `WAITAOF`）可以等写入复制到从节点再继续，能缩小窗口，但不能消除：切换时被选中的从节点未必是已确认的那个。

---

## 三、租约过期与 Fencing Token

所有带过期时间的锁（Redis TTL、ZooKeeper 会话、etcd 租约）都有同一个问题：**持有者以为自己还持有锁，而锁其实已经过期**。

![租约过期与 Fencing Token](../assets/distributed/lock-fencing-token.svg)

触发原因有长时间的 GC 停顿（STW）、进程被换出、网络延迟导致请求晚到。看门狗挡不住这种情况：停顿期间续期线程同样停着，或续期请求被网络阻断。

解决办法是让**被保护的资源自己做最后一道检查**：

- **Fencing Token**：锁服务每次加锁返回一个单调递增的编号，写存储时带上，存储拒绝比已见过的编号更小的请求
- **条件更新**：直接用数据库的原子条件更新保证正确性，锁只用来减少冲突

Redisson 提供 `RFencedLock`：

```java
RFencedLock lock = redisson.getFencedLock("lock:account:" + accountId);
Long token = lock.tryLockAndGetToken(3, TimeUnit.SECONDS);   // 失败返回 null
if (token == null) {
    throw new BizException("处理中，请稍后重试");
}
try {
    // 存储侧校验：拒绝比已见过的更小的 token
    int rows = jdbc.update("""
            UPDATE account SET balance = ?, fence_token = ?
            WHERE id = ? AND fence_token <= ?
            """, newBalance, token, accountId, token);
    if (rows == 0) {
        throw new BizException("锁已失效，放弃本次写入");
    }
} finally {
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

ZooKeeper 可以用临时顺序节点的序号或节点的 `czxid` 作为 token，etcd 可以用锁 key 的 `CreateRevision`。

---

## 四、Redlock 及其争议

### 1、算法

Redlock 由 Redis 作者 antirez 提出，用 N 个**相互独立**的 Redis 主节点（通常 5 个，彼此没有复制关系）：

1. 记录开始时间
2. 用相同的 key、随机 value、TTL 向所有节点加锁（可以并行发送），每个请求的超时远小于 TTL
3. 在多数节点（N/2 + 1）加锁成功，且耗时小于 TTL，才算成功
4. 锁的有效时间 = TTL − 加锁耗时 − 时钟漂移余量
5. 失败时向所有节点发送解锁

节点崩溃重启后如果没有持久化锁数据，锁会丢失。官方要求要么 `appendfsync always`，要么崩溃后延迟一个 TTL 再重启。

### 2、争议

| | Martin Kleppmann | antirez |
|---|---|---|
| 核心观点 | 任何基于租约的锁，没有 Fencing Token 都不安全；Redlock 还依赖「时钟漂移有界、网络延迟有界」这类时序假设，GC 停顿或时钟跳变就会让两个客户端同时持锁 | 在声明的假设（时钟漂移有界，且加锁后会检查耗时）下 Redlock 是安全的；随机 value 也可以起到类似 token 的作用 |
| 建议 | 效率锁用单 Redis 即可；正确性锁用 ZooKeeper / etcd 等共识系统并配合 Fencing Token | Redlock 适用于需要比单实例更高容错的锁 |

工程上的共识是：**Redlock 的部署和运维成本高，却仍不能替代 Fencing Token**。Redisson 已把 `RedissonRedLock`（以及 `getRedLock`）标为废弃，推荐用 `RLock` 或 `RFencedLock`。需要严格正确性时，用 Fencing Token 或数据库条件更新，而不是加更多 Redis 节点。

---

## 五、ZooKeeper 分布式锁

### 1、原理

利用**临时顺序节点**和 **Watch**：

1. 在 `/locks/order` 下创建临时顺序节点，例如 `lock-0000000007`
2. 获取所有子节点并排序，自己序号最小则加锁成功
3. 否则只 Watch **紧邻的前一个节点**的删除事件（只盯前一个，避免所有等待者被同时唤醒的羊群效应）
4. 收到通知后**重新获取子节点列表判断**，不能直接认为自己拿到了锁：前一个节点可能是因为会话过期而被删除，而它前面还有别的节点
5. 解锁时删除自己的节点

客户端崩溃后会话过期，临时节点自动删除，锁自然释放。但这也意味着 ZooKeeper 锁同样有租约问题：GC 停顿超过会话超时，节点被删，别人拿到锁，自己恢复后还以为持有锁。

### 2、Curator 实现

```java
CuratorFramework client = CuratorFrameworkFactory.newClient(
        "zk1:2181,zk2:2181,zk3:2181", new ExponentialBackoffRetry(1000, 3));
client.start();

InterProcessMutex lock = new InterProcessMutex(client, "/locks/order/" + orderId);
if (!lock.acquire(3, TimeUnit.SECONDS)) {
    throw new BizException("处理中，请稍后重试");
}
try {
    // 业务逻辑
} finally {
    lock.release();
}
```

`InterProcessMutex` 支持可重入，Curator 还提供读写锁 `InterProcessReadWriteLock` 和信号量 `InterProcessSemaphoreV2`。

---

## 六、etcd 分布式锁

### 1、原理

- **Lease**：key 绑定租约，租约到期 key 自动删除；持有者用 KeepAlive 续约
- **只加一次的锁**：用事务 `Txn(If CreateRevision(key) == 0, Then Put(key, lease))` 实现「不存在才写入」，etcd 没有 `NX` 参数
- **公平锁**（官方 `concurrency.Mutex` 与 Lock 服务的做法）：每个客户端在前缀下写自己的 key（`/locks/order/<leaseId>`），按 `CreateRevision` 排序，最小者获得锁；其他客户端只等待 `CreateRevision` 紧邻更小的那个 key 被删除，避免羊群效应
- **Revision**：每次写入都会让全局 revision 单调递增，锁 key 的 `CreateRevision` 可以直接当 Fencing Token

### 2、jetcd 示例

Lock 服务返回的是**持有者 key**（锁名加租约 ID），解锁必须传这个 key，传锁名删不掉任何东西，只能等租约过期：

```java
import static java.nio.charset.StandardCharsets.UTF_8;

try (Client client = Client.builder().endpoints("http://etcd1:2379").build()) {
    Lease leaseClient = client.getLeaseClient();
    Lock lockClient = client.getLockClient();

    long leaseId = leaseClient.grant(30).get().getID();
    try (CloseableClient keepAlive = leaseClient.keepAlive(leaseId, Observers.observer(resp -> { }))) {
        ByteSequence ownerKey = lockClient
                .lock(ByteSequence.from("/locks/order", UTF_8), leaseId)
                .get(3, TimeUnit.SECONDS)
                .getKey();
        try {
            // 业务逻辑
        } finally {
            lockClient.unlock(ownerKey).get();
        }
    } finally {
        leaseClient.revoke(leaseId).get();
    }
}
```

---

## 七、常见坑

1. **锁在事务提交前释放**：在 `@Transactional` 方法内部加锁和解锁，解锁时事务还没提交，下一个线程拿到锁却读不到刚写的数据。加锁要放在事务边界之外，或在提交后再解锁
2. **tryLock 失败后仍然 unlock**：没拿到锁也在 finally 里调用 `unlock()`，Redisson 会抛 `IllegalMonitorStateException`。检查返回值，或用 `isHeldByCurrentThread()` 判断
3. **锁粒度过粗**：用一把全局锁保护所有订单，所有请求串行。key 要细到资源 ID，如 `lock:order:{orderId}`
4. **leaseTime 短于业务耗时**：指定 leaseTime 会关闭看门狗，业务没执行完锁就过期。不确定耗时就不要指定 leaseTime，同时给业务本身设超时
5. **用锁当秒杀防超卖的主手段**：一把锁把所有扣库存请求串行化，吞吐被锁的往返时间限制。库存扣减应使用原子操作：Redis Lua 判断库存后 `DECR`，或数据库条件更新 `UPDATE stock SET n = n - 1 WHERE id = ? AND n > 0`，详见 [秒杀](/scenario/4_seckill)
6. **用锁代替幂等**：锁只保证同一时刻不并发，挡不住锁释放后的重复请求。重复提交、重复消费要靠唯一约束或状态机，见 [幂等设计](/architecture/5_idempotence)

---

## 八、方案对比与选型

| 维度 | Redis（Redisson） | ZooKeeper（Curator） | etcd |
|------|-------------------|----------------------|------|
| 复制与一致性 | 异步复制，切换可能丢锁 | ZAB，写多数派确认 | Raft，多数派确认 |
| 性能 | 最高 | 中 | 中 |
| 自动释放 | key 过期 | 会话过期删除临时节点 | 租约过期 |
| 续期 | 看门狗 | 会话心跳 | Lease KeepAlive |
| 可重入 | 支持 | 支持 | Lock 服务不支持，需自行封装 |
| 公平等待 | 默认非公平，有 `getFairLock` | 顺序节点天然公平 | 按 CreateRevision 排队 |
| Fencing Token | `RFencedLock` | 序号或 czxid | CreateRevision |
| 运维成本 | 低（通常已有 Redis） | 高 | 中（K8s 环境已有） |

选型建议：

| 场景 | 方案 |
|------|------|
| 效率锁：防重复计算、缓存重建、任务防并发 | Redis + Redisson，已有 Redis 时首选 |
| 正确性锁：同时持锁会写坏数据 | 任一种锁 + Fencing Token，或直接用数据库条件更新 |
| 已有 ZooKeeper 集群 | Curator，不必再引入组件 |
| K8s / 云原生环境 | etcd |
| 秒杀扣库存、余额扣减 | 不用锁做主手段，用原子 Lua 或数据库条件更新 |

---

## 小结

- Redis 锁：`SET key token NX PX ttl` 加锁，校验 token 后删除；Redis 8.4+ 用 `DELEX key IFEQ token`，更早版本与 Valkey 用 Lua
- Redisson 看门狗只在不指定 leaseTime 时生效，按进程存活续期，挡不住 STW 和网络分区造成的租约过期
- 主从异步复制会在切换时丢锁，`WAIT` 只能缩小窗口
- 任何基于租约的锁都可能「以为自己持有」，正确性场景要让资源校验 Fencing Token 或用条件更新
- Redlock 运维成本高且仍需 Fencing，Redisson 已废弃 `RedissonRedLock`
- ZooKeeper 锁只 Watch 前一个节点，被唤醒后要重新判断；etcd 解锁要传 Lock 返回的持有者 key
- 锁不能替代幂等，也不该作为秒杀防超卖的主手段

## 参考资料

- Redis 分布式锁模式：[https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- Redis DELEX 命令：[https://redis.io/docs/latest/commands/delex/](https://redis.io/docs/latest/commands/delex/)
- Redis WAIT 命令：[https://redis.io/docs/latest/commands/wait/](https://redis.io/docs/latest/commands/wait/)
- Redisson Locks and Synchronizers：[https://redisson.pro/docs/data-and-services/locks-and-synchronizers/](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)
- Redisson GitHub：[https://github.com/redisson/redisson](https://github.com/redisson/redisson)
- Martin Kleppmann, How to do distributed locking：[https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- antirez, Is Redlock safe?：[https://antirez.com/news/101](https://antirez.com/news/101)
- ZooKeeper Recipes（Locks）：[https://zookeeper.apache.org/doc/current/recipes.html](https://zookeeper.apache.org/doc/current/recipes.html)
- Apache Curator Recipes：[https://curator.apache.org/docs/recipes-shared-reentrant-lock](https://curator.apache.org/docs/recipes-shared-reentrant-lock)
- etcd Lock API：[https://etcd.io/docs/v3.5/dev-guide/api_concurrency_reference_v3/](https://etcd.io/docs/v3.5/dev-guide/api_concurrency_reference_v3/)
- jetcd：[https://github.com/etcd-io/jetcd](https://github.com/etcd-io/jetcd)

> 下一篇：[分布式事务](./4_transaction) —— 2PC / XA、TCC、Saga、本地消息表与事务消息、Seata 四种模式的原理与选型。

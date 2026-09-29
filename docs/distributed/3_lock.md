# 分布式锁

> 优秀开源实现参考：
> - Redisson：[https://github.com/redisson/redisson](https://github.com/redisson/redisson)
> - Lock4j：[https://gitee.com/baomidou/lock4j](https://gitee.com/baomidou/lock4j)

---

## 一、为什么需要分布式锁

单机环境下，`synchronized` / `ReentrantLock` 基于 JVM 内存实现，只在同一进程内有效。分布式场景下多个服务实例共享同一资源（库存、订单、定时任务），需要跨进程的互斥机制。

**分布式锁三个核心要求：**

| 要求 | 说明 |
|------|------|
| 互斥性 | 同一时刻只有一个客户端持有锁 |
| 不死锁 | 持锁客户端宕机后锁能自动释放 |
| 容错性 | 部分节点故障不影响锁的整体可用性 |

---

## 二、Redis 分布式锁

### 2.1 基本原理

利用 Redis `SET key value NX PX ttl` 原子命令实现加锁，`value` 存入唯一标识（UUID），解锁时用 Lua 脚本校验 + 删除，保证原子性。

**加锁（原子）：**
```bash
SET lock_key unique_value NX PX 30000
```

**解锁（Lua 保证原子）：**
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

**为什么 value 要用唯一标识？**
防止误删：A 加锁 → 锁超时自动释放 → B 加锁 → A 逻辑执行完来删锁，若不校验 value 会把 B 的锁删掉。

### 2.2 锁续期（看门狗机制）

锁过期时间设短了业务没执行完锁就释放；设长了宕机后等待时间过长。

Redisson 的解决方案：**看门狗（Watchdog）**
- 默认锁超时 30s，每隔 10s 检测一次，若持锁客户端还活着就自动续期
- 客户端宕机后心跳停止，锁自动过期释放

```java
RLock lock = redissonClient.getLock("order_lock");
lock.lock(); // 自动开启看门狗
try {
    // 业务逻辑
} finally {
    lock.unlock();
}
```

### 2.3 可重入锁

Redisson 用 Hash 结构存储锁：`key → {threadId: count}`，同一线程多次加锁 count 递增，unlock 时递减至 0 才真正释放，实现可重入。

---

## 三、Redlock 算法及其争议

### 3.1 单节点 Redis 锁的问题

单节点 Redis 存在**主从切换**风险：
1. 客户端 A 在 Master 加锁成功
2. Master 宕机，锁还未同步到 Slave
3. Slave 晋升为新 Master
4. 客户端 B 在新 Master 加锁成功 → **两个客户端同时持锁**

### 3.2 Redlock 算法（antirez 提出）

使用 **N 个独立的 Redis 节点**（通常 5 个），加锁需在多数节点（≥ N/2+1）成功才算持锁。

**加锁流程：**
1. 记录当前时间 `T1`
2. 依次向 5 个节点用相同 key/value/TTL 请求加锁
3. 计算实际消耗时间 `elapsed = now - T1`
4. 若成功节点 ≥ 3 且 `elapsed < TTL`，则加锁成功，有效时间 = `TTL - elapsed`
5. 否则向所有节点发送解锁请求

### 3.3 争议：Kleppmann vs antirez

| | Martin Kleppmann（质疑方） | antirez（设计方） |
|---|---|---|
| 核心观点 | Redlock 不能保证安全性，时钟漂移 / GC Stop-the-World 会导致锁失效期间有两个客户端同时持锁 | Redlock 的目标是高可用，而非强一致；时钟漂移在合理范围内是可接受的工程假设 |
| 解决建议 | 真正需要强一致用 ZooKeeper / etcd（基于 Raft），并加 fencing token 防重放 | Redis 已满足大多数分布式锁场景 |
| 适用场景 | 安全要求极高的场景（如金融） | 高可用要求高于强一致的场景 |

**Fencing Token 方案（Kleppmann 推荐）：**
每次加锁返回一个单调递增的 token，下游服务校验 token 是否比上次大，拒绝旧 token 的请求，从根本上解决锁失效后的重放问题。

::: tip 结论
- 对**强一致**有要求 → 用 ZooKeeper 或 etcd
- 对**高可用**要求高、可接受极小概率失效 → Redis 单节点锁 + 看门狗已够用
- Redlock 适合介于两者之间的场景，但工程复杂度较高，慎用
:::

---

## 四、ZooKeeper 分布式锁

### 4.1 原理

利用 ZooKeeper **临时顺序节点** + **Watch 机制**实现。

**加锁流程：**
1. 在 `/locks/` 下创建临时顺序节点，如 `/locks/lock_0000000001`
2. 获取 `/locks/` 下所有子节点并排序
3. 若自己是序号最小的节点 → 加锁成功
4. 否则监听（Watch）前一个节点的删除事件，等待唤醒

**解锁：** 删除自己创建的临时节点，触发下一个等待节点的 Watch 回调。

**宕机自动释放：** 临时节点与 Session 绑定，客户端宕机后 Session 超时，临时节点自动删除。

### 4.2 优缺点

| 优点 | 缺点 |
|------|------|
| 基于 ZAB 协议，强一致 | 性能低于 Redis（节点写入需过半确认） |
| 天然支持锁等待队列 | 频繁创建/删除节点对 ZK 压力大 |
| 客户端宕机自动释放 | 依赖 ZooKeeper 集群，运维成本高 |

### 4.3 Curator 实现

Apache Curator 封装了 ZooKeeper 分布式锁，开箱即用：

```java
InterProcessMutex lock = new InterProcessMutex(client, "/locks/order");
if (lock.acquire(10, TimeUnit.SECONDS)) {
    try {
        // 业务逻辑
    } finally {
        lock.release();
    }
}
```

---

## 五、etcd 分布式锁

### 5.1 为什么用 etcd

etcd 基于 **Raft 共识协议**，提供强一致的 KV 存储，是 Kubernetes 的元数据存储核心。相比 ZooKeeper，etcd 的 API 更简洁（gRPC），运维更轻量。

### 5.2 核心机制

**Lease（租约）：** 类似 Redis 的过期时间，key 绑定 Lease，Lease 到期后 key 自动删除（实现锁自动释放）。

**KeepAlive：** 持锁方定期续约，宕机后续约停止，Lease 到期，锁自动释放（类似看门狗）。

**Revision（版本号）：** etcd 中每次写操作都会产生全局单调递增的 Revision，天然实现 Fencing Token。

### 5.3 加锁流程

```
1. 创建 Lease（TTL=30s）
2. PUT /locks/order → 绑定 LeaseID，NX（not exist）
3. 若 PUT 成功 → 加锁成功，开启 KeepAlive 续约
4. 若 PUT 失败 → Watch /locks/order 的删除事件，等待
5. 解锁：删除 key 或 Lease 到期自动释放
```

**Java 示例（jetcd）：**
```java
Client client = Client.builder().endpoints("http://localhost:2379").build();
Lease leaseClient = client.getLeaseClient();
Lock lockClient = client.getLockClient();

long leaseId = leaseClient.grant(30).get().getID();
leaseClient.keepAlive(leaseId, Observers.observer(response -> {}));

lockClient.lock(ByteSequence.from("/locks/order", UTF_8), leaseId).get();
try {
    // 业务逻辑
} finally {
    lockClient.unlock(ByteSequence.from("/locks/order", UTF_8)).get();
}
```

### 5.4 优缺点

| 优点 | 缺点 |
|------|------|
| Raft 强一致，无主从切换问题 | 性能低于 Redis |
| Revision 天然 Fencing Token | 部署相对复杂（Go 技术栈） |
| API 简洁，gRPC 协议 | Java 生态不如 Redis/ZK 成熟 |
| Kubernetes 原生，云原生友好 | |

---

## 六、三种方案横向对比

| 维度 | Redis | ZooKeeper | etcd |
|------|-------|-----------|------|
| 一致性协议 | 异步复制（最终一致） | ZAB（强一致） | Raft（强一致） |
| 性能 | 最高 | 中等 | 中等 |
| 锁自动释放 | TTL 过期 | Session 断开 | Lease 过期 |
| 锁续期 | 看门狗（Redisson） | Session keepAlive | Lease keepAlive |
| 可重入 | Redisson 支持 | Curator 支持 | 不原生支持 |
| Fencing Token | 需额外实现 | Revision 可用 | Revision 天然支持 |
| 运维复杂度 | 低 | 高 | 中 |
| 适用场景 | 高并发、高可用优先 | 强一致、等待队列 | 云原生、K8s 环境 |

::: tip 选型建议
- **电商秒杀 / 高并发扣减**：Redis + Redisson，性能最佳
- **金融 / 强一致要求**：etcd 或 ZooKeeper
- **已有 K8s 体系**：etcd，与基础设施统一
- **已有 ZooKeeper 集群**：直接用 Curator，避免引入新组件
:::

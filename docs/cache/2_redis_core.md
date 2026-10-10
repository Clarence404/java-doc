---
description: 线程模型与 I/O 线程、RDB / Multi-Part AOF、淘汰与过期、事务、Pipeline、Lua
---

# Redis 核心原理

> 前置阅读：[Redis 基础](./1_redis_base)

Redis 的性能与可靠性取决于线程模型、持久化和内存回收这几块核心机制。本篇讲线程模型与 Redis 8 的 I/O 线程、RDB / AOF 的默认配置与取舍、淘汰与过期机制，以及原子 Lua 脚本的正确写法。

---

## 一、线程模型

### 1、命令执行是单线程

Redis 的**命令执行**始终在一个主线程里顺序进行：每条命令天然原子、没有锁竞争。数据在内存里、命令大多是 O(1) / O(log N)，单核就能跑出十万级 QPS，瓶颈通常是网络读写而不是 CPU。持久化（fork 子进程）、`UNLINK` 异步释放、AOF fsync 等则由子进程或后台线程完成。

代价是一条慢命令（`KEYS *`、大 key 的 `DEL`、长 Lua 脚本）会阻塞所有客户端，这是 Redis 使用规范的出发点。

### 2、I/O 线程：6.x 与 8.0 的区别

![Redis 线程模型演进](../assets/cache/redis-thread-model.svg)

| 版本 | 读取与解析请求 | 执行命令 | 写回响应 |
|------|--------------|---------|---------|
| 6.0 以前 | 主线程 | 主线程 | 主线程 |
| 6.x / 7.x（`io-threads > 1`） | 默认主线程；开 `io-threads-do-reads yes` 后由 I/O 线程并行 | 主线程 | I/O 线程并行 |
| 8.0+（`io-threads > 1`） | I/O 线程：主线程把客户端分配给固定 I/O 线程，读完并解析后通知主线程 | 主线程 | I/O 线程 |

8.0 重写了 I/O 线程实现，读、解析、写都交给 I/O 线程，不再需要 `io-threads-do-reads`；Valkey 8.0 也引入了类似的异步 I/O 线程。

```bash
# redis.conf：默认 io-threads 1（不开启）
io-threads 4
```

官方建议：只有实例确实被网络 I/O 吃满 CPU 时才开启；至少 4 核再开，并留出一个空闲核，例如 4 核用 3 个线程、8 核用 7 个线程。压测时 `redis-benchmark` 也要加 `--threads`，否则测不出差异。

---

## 二、持久化机制

### 1、RDB（快照）

定时把内存数据**快照**写入 `.rdb` 文件。

```bash
# 7.0+ 默认（未配置 save 时生效）：3600 秒内 1 次修改、300 秒内 100 次、60 秒内 10000 次
save 3600 1 300 100 60 10000
# 纯缓存实例可关闭 RDB
save ""

BGSAVE          # fork 子进程后台生成快照
SAVE            # 主线程同步生成，会阻塞，生产禁用
```

**原理（写时复制 Copy-On-Write）**：`BGSAVE` fork 出子进程遍历内存写 RDB；父进程继续处理请求，只有被修改的内存页才会复制。写多的大实例在 fork 期间内存最多接近翻倍，fork 本身也会卡住主线程（与内存页表大小成正比），需要留足内存并关闭透明大页（THP）。

- **优点**：文件紧凑、加载快，适合备份与全量复制
- **缺点**：两次快照之间的写入会丢失，按默认规则可能丢几分钟数据

### 2、AOF（追加日志）

把每条写命令追加到 AOF 日志，重启时重放。

```bash
appendonly yes
appendfsync everysec      # always：每次写都 fsync / everysec：每秒 fsync（推荐）/ no：交给操作系统
appenddirname "appendonlydir"
```

`everysec` 正常最多丢 1 秒数据；磁盘繁忙导致 fsync 跟不上时主线程最多再等约 1 秒，极端情况下约丢 2 秒。

**Multi-Part AOF（7.0+）**：AOF 不再是单个文件，而是 `appendonlydir` 目录下的三类文件：

| 文件 | 作用 |
|------|------|
| `*.base.rdb` / `*.base.aof` | 基准文件，重写时生成；开启 `aof-use-rdb-preamble`（5.0 起默认 yes）时是 RDB 格式 |
| `*.incr.aof` | 基准之后的增量写命令，可能有多个 |
| `*.manifest` | 清单文件，记录当前生效的 base 与 incr 文件 |

**AOF 重写**：日志过大时 fork 子进程，根据当前内存生成新的 base 文件；同时主进程把新写入打开到一个新的 incr 文件，重写完成后原子更新 manifest 并删除旧文件。相比 7.0 以前，不再需要在内存里维护重写缓冲区并在结束时双写。

```bash
BGREWRITEAOF                       # 手动触发
auto-aof-rewrite-percentage 100    # 比上次重写后大 100% 时
auto-aof-rewrite-min-size 64mb     # 且不小于 64MB
```

### 3、选型建议

| 场景 | 推荐 |
|------|------|
| 纯缓存，数据可从数据库重建 | 关闭持久化，或只保留低频 RDB 用于快速预热 |
| 可接受分钟级丢失 | RDB |
| 最多丢 1~2 秒 | AOF `everysec`（base 默认是 RDB 格式，即混合持久化） |
| 不能丢任何写入 | Redis 不适合作为唯一数据源，用数据库兜底 |

AOF 和 RDB 同时开启时，重启优先加载 AOF，因为它的数据更完整。

---

## 三、缓存淘汰策略

内存达到 `maxmemory` 上限时，新写入触发淘汰。

```bash
maxmemory 4gb
maxmemory-policy allkeys-lru    # 默认是 noeviction
maxmemory-samples 5             # 默认采样 5 个 key
```

| 策略 | 说明 | 推荐场景 |
|------|------|---------|
| `noeviction` | **默认**，不淘汰，写命令直接报 OOM 错误 | 把 Redis 当存储用、不允许丢 key |
| `allkeys-lru` | 所有 key 中淘汰最近最少使用 | **通用缓存首选** |
| `allkeys-lfu` | 所有 key 中淘汰访问频率最低 | 冷热差异大；也是 `--hotkeys` 的前提 |
| `allkeys-random` | 所有 key 随机淘汰 | 访问均匀时 |
| `volatile-lru` / `volatile-lfu` | 只在设置了过期时间的 key 中按 LRU / LFU 淘汰 | 缓存与不可丢的数据混放 |
| `volatile-ttl` | 淘汰剩余 TTL 最短的 key | 同上 |
| `volatile-random` | 设置了过期时间的 key 中随机淘汰 | 很少用 |

Redis 的 LRU / LFU 都是**近似算法**：每次随机采样 `maxmemory-samples` 个 key，从中挑最该淘汰的，调大采样数更精确但更耗 CPU。LFU（4.0+）用对数计数器加衰减（`lfu-log-factor` / `lfu-decay-time`）表示频率，对「扫描一次就把热数据挤掉」这类偶发批量访问更稳。

用作缓存的实例应显式改成 `allkeys-lru` 或 `allkeys-lfu`，否则内存满后所有写入都会失败。

---

## 四、过期键删除

设置了过期时间的 key 由两种机制共同清理：

- **惰性删除**：访问 key 时检查是否过期，过期就删除并返回空。保证读不到过期数据，但不再被访问的 key 会一直占内存
- **定期删除**：后台周期任务（默认每秒 10 次，`hz 10`）随机抽样带过期时间的 key，删除其中已过期的；某轮过期比例较高时继续抽样，同时限制单轮耗时。6.0 起可用 `active-expire-effort`（1~10）调高清理力度

两点要注意：

- **从节点不主动删除过期 key**：由主节点删除后向从节点同步 `DEL`。从节点读到逻辑上已过期的 key 时会返回空，但内存要等主节点的 `DEL` 才释放
- 大量 key 同一时刻过期会让定期删除占用更多 CPU，同时造成缓存雪崩；TTL 要加随机偏移，规范见 [缓存最佳实践](./11_cache_rule)

---

## 五、事务、Pipeline 与 Lua

### 1、事务（MULTI / EXEC）

```bash
MULTI
SET k1 v1
INCR counter
EXEC        # 依次执行队列中的命令；DISCARD 放弃
```

Redis 事务保证队列中的命令连续执行、不被其他客户端插入，但**不支持回滚**：入队时的语法错误会让整个事务取消；执行期的错误（如对 String 执行 `LPUSH`）只让该命令失败，其余命令照常执行。

### 2、WATCH（乐观锁）

```bash
WATCH balance
MULTI
DECRBY balance 100
EXEC        # WATCH 之后 balance 被别人改过，EXEC 返回 nil，需要重试
```

### 3、Pipeline

把多条命令一次发出、一次收回，减少网络往返（RTT）。Pipeline 只是客户端批量发送，命令之间可能插入其他客户端的命令，**不保证原子性**。

```java
// RedisTemplate.executePipelined 与底层驱动无关（Lettuce / Jedis 都支持）
List<Object> results = redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
    for (int i = 0; i < 1000; i++) {
        connection.stringCommands().set(("key:" + i).getBytes(StandardCharsets.UTF_8),
                ("val:" + i).getBytes(StandardCharsets.UTF_8));
    }
    return null;   // 必须返回 null，结果由 executePipelined 收集
});
```

`RedisConnection` 上直接调用 `set` / `bitCount` 等命令方法从 Spring Data Redis 3.0 起已废弃，改用 `stringCommands()`、`hashCommands()` 等分组接口。单批建议几百到几千条，过大的批次会占用大量客户端与服务端缓冲区。

### 4、Lua 脚本

Lua 脚本在服务端整体执行，执行期间不会插入其他命令，是「读-判断-写」复合操作的首选。

```bash
# 原子扣减库存：库存不足返回 0，成功返回 1；key 不存在按 0 处理
EVAL "
  local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
  local n = tonumber(ARGV[1])
  if stock >= n then
    redis.call('DECRBY', KEYS[1], n)
    return 1
  end
  return 0
" 1 product:stock:1001 2
```

使用要点：

- **脚本要短**：执行期间整个实例被阻塞。超过 `busy-reply-threshold`（旧名 `lua-time-limit`，默认 5 秒）后其他客户端收到 `BUSY` 错误，只能 `SCRIPT KILL`（未写入时）或 `SHUTDOWN NOSAVE`
- **key 必须通过 `KEYS` 传入**：Cluster 下脚本访问的所有 key 必须在同一个 slot，用 Hash Tag 保证，见 [Redis 集群](./3_redis_cluster)
- **生产用 `EVALSHA`**：先 `SCRIPT LOAD` 拿到 SHA1，客户端遇到 `NOSCRIPT` 再回退到 `EVAL`；Spring 的 `DefaultRedisScript` 已自动处理
- **Functions（7.0+）**：`FUNCTION LOAD` 把函数库持久化并随复制同步到从节点，用 `FCALL` 调用，适合多个服务共用的原子逻辑
- **及时打补丁**：2025 年披露了多个 Lua 相关漏洞（如 CVE-2025-49844，可导致远程代码执行），要升级到修复版本，并用 ACL 限制不需要的用户执行 `EVAL`

---

## 小结

- 命令执行始终单线程；I/O 线程只分担网络读写，8.0 的新实现让读、解析、写都由 I/O 线程完成，只在网络 I/O 吃满 CPU 时开启
- RDB 默认 `save 3600 1 300 100 60 10000`；AOF 7.0 起是 Multi-Part（base + incr + manifest），base 默认 RDB 格式；`everysec` 极端情况下约丢 2 秒
- `maxmemory-policy` 默认 `noeviction`，缓存实例要显式改为 `allkeys-lru` / `allkeys-lfu`；LRU / LFU 都是采样近似
- 过期删除靠惰性 + 定期，从节点等主节点同步 `DEL`
- 事务不回滚，Pipeline 不原子；复合原子操作用 Lua 或 Functions，脚本要短且所有 key 在同一 slot

## 参考资料

- Redis persistence：[https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- Key eviction：[https://redis.io/docs/latest/develop/reference/eviction/](https://redis.io/docs/latest/develop/reference/eviction/)
- EXPIRE（过期机制说明）：[https://redis.io/docs/latest/commands/expire/](https://redis.io/docs/latest/commands/expire/)
- Transactions：[https://redis.io/docs/latest/develop/interact/transactions/](https://redis.io/docs/latest/develop/interact/transactions/)
- Scripting with Lua：[https://redis.io/docs/latest/develop/interact/programmability/eval-intro/](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
- Redis Functions：[https://redis.io/docs/latest/develop/interact/programmability/functions-intro/](https://redis.io/docs/latest/develop/interact/programmability/functions-intro/)
- Redis 8.0 redis.conf（THREADED I/O 一节）：[https://github.com/redis/redis/blob/8.0/redis.conf](https://github.com/redis/redis/blob/8.0/redis.conf)
- Redis Open Source 8.0 release notes：[https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/)

> 下一篇：[Redis 集群](./3_redis_cluster) —— 主从复制、哨兵、Cluster 分片与重定向、脑裂与部署建议。

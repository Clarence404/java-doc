---
description: Redis 数据类型与编码、线程模型与持久化、过期与淘汰、主从哨兵集群、缓存问题治理、缓存一致性、本地与两级缓存、Redisson
---

# 缓存面试题解答

> 题目清单见 [缓存面试题](/cache/99_interview)；细节见 [缓存总览](/cache/0_overview)。
>
> 版本基线：Redis 8.x（兼顾 7.x）、Valkey 8.x、Spring Boot 4 / Spring Data Redis 4、Redisson 4.x、Caffeine 3.x、JetCache 2.7+。

## 一、数据类型与编码

### Q1：Redis 有哪些数据类型？各适合什么场景？

**一句话**：五种基础类型（String、Hash、List、Set、ZSet）覆盖大部分缓存与计数需求；Bitmap、HyperLogLog、GEO、Stream 解决特定统计与队列问题；Redis 8 还把 JSON、布隆过滤器、时序等原 Redis Stack 能力并入了核心。

| 类型 | 典型场景 |
|------|---------|
| String | 缓存对象、计数器、分布式锁 |
| Hash | 对象的多个字段，单独读改某个字段 |
| List / Set | 简单队列；去重、共同好友（交集） |
| ZSet | 排行榜、延迟队列（score 存时间） |
| Bitmap / HyperLogLog / GEO | 签到、UV 估算（误差约 0.81%）、附近的人 |

- Redis 8 内置：`JSON.*`、`BF.*` / `CF.*`（布隆 / 布谷鸟过滤器）、`TOPK.*`、`TS.*`（时序）、`FT.*`（查询引擎）、Vector Set
- Valkey 没有这些内置类型，要另装模块，选型前先确认目标环境

**常见坑**：用 `LRANGE` 对大 List 做深分页，复杂度 O(S+N)，越往后越慢，还会把 List 养成大 key。

→ 详见 [Redis 基础](/cache/1_redis_base)

### Q2：ZSet 底层为什么用跳表 + 哈希表？小 ZSet 用什么编码？

**一句话**：元素少时用紧凑的 listpack，超过阈值转成「跳表 + 哈希表」：跳表负责按分数排序和范围查询，哈希表让按成员查分数做到 O(1)。

- 切换阈值：`zset-max-listpack-entries 128`、`zset-max-listpack-value 64`；listpack 是 7.0 起替代 ziplist 的编码，没有连锁更新问题
- 选跳表而不是平衡树：作者给的理由是实现和调试简单，范围操作找到起点后顺序遍历即可，内存可通过层数概率调节
- 「单线程所以跳表锁粒度小」「跳表缓存局部性好」都不是原因，命令本来就单线程执行
- 用 `OBJECT ENCODING key` 查看实际编码

→ 详见 [Redis 基础](/cache/1_redis_base#四、底层编码总结)

### Q3：Redis 能当消息队列吗？List、Pub/Sub、Stream 怎么选？

**一句话**：能做轻量队列，但持久化和复制都是异步的，故障时可能丢最近的消息；可靠性要求高的业务消息还是交给专业 MQ。

| 方式 | 特点 |
|------|------|
| List + `BLMOVE` | 取出时转移到「处理中」列表，处理成功再删除，崩溃后可恢复 |
| Pub/Sub | 不持久化，订阅者不在线就收不到，只适合通知类消息 |
| Stream | 消费组 + ACK + 待确认列表（PEL），`XAUTOCLAIM` 接管超时未确认的消息 |

- 延迟任务可以用 ZSet（score 存执行时间），要做到「处理成功才确认、超时重新入队」，并保证业务幂等

**常见坑**：用 List 的 `RPOP` 取完就算消费成功，处理中进程崩溃，消息就丢了。

→ 详见 [Redis 典型应用场景](/cache/4_redis_scenario#五、redis-做消息队列)

### Q4：Redis 8 的许可有什么变化？Redis 和 Valkey 怎么选？

**一句话**：Redis 8.0 起改名 Redis Open Source，在 RSALv2 / SSPLv1 之外新增 AGPLv3 可选；Valkey 是 Redis 7.2.4 的 BSD 许可分支，命令和协议兼容。

- Redis 8 优势：JSON、概率结构、时序、查询引擎、Vector Set 都在核心里，开箱即用
- Valkey 优势：许可宽松（BSD），云厂商托管版普遍提供；需要上面那些能力时要另装模块
- 业务只用基础命令时两者几乎可以互换；用了 Redis 8 内置类型，就要确认部署环境是 Redis 8
- AGPLv3 对「修改后以网络服务形式提供」有开源义务，私有化交付前做好许可评估

→ 详见 [缓存总览](/cache/0_overview)

## 二、线程模型与持久化

### Q5：Redis 为什么快？它是单线程还是多线程？

**一句话**：命令执行始终在一个主线程里顺序进行；快是因为数据在内存里、数据结构高效、没有锁竞争，网络 I/O 用多路复用（epoll）。

- 单线程执行：每条命令天然原子，不需要加锁；大部分命令是 O(1) / O(log N)
- 瓶颈通常是网络读写而不是 CPU，所以后来加的 I/O 线程只分担网络读写
- 后台线程 / 子进程负责 fork 持久化、`UNLINK` 异步释放内存、AOF fsync
- 代价：一条慢命令（`KEYS *`、`DEL` 大 key、长 Lua 脚本）会阻塞所有客户端

→ 详见 [Redis 核心原理](/cache/2_redis_core#一、线程模型)

### Q6：Redis 6.x 和 8.0 的 I/O 线程有什么区别？什么时候开？

**一句话**：两者都只是把网络读写交给 I/O 线程，命令仍由主线程执行；8.0 重写了实现，读、解析、写都由 I/O 线程完成，不再需要 `io-threads-do-reads`。

| 版本 | 读取与解析 | 执行命令 | 写回响应 |
|------|-----------|---------|---------|
| 6.x / 7.x | 默认主线程，开 `io-threads-do-reads` 后并行 | 主线程 | I/O 线程 |
| 8.0+ | I/O 线程（客户端固定分配给某个线程） | 主线程 | I/O 线程 |

- 默认 `io-threads 1` 即不开启；只有网络 I/O 把 CPU 吃满时才开，至少 4 核并留一个空闲核
- 压测时 `redis-benchmark` 也要加 `--threads`，否则测不出差异

→ 详见 [Redis 核心原理](/cache/2_redis_core#_2、i-o-线程-6-x-与-8-0-的区别)

### Q7：RDB 和 AOF 怎么选？

**一句话**：RDB 是定时快照，文件小、恢复快，但两次快照之间的写入会丢；AOF 记录每条写命令，`everysec` 正常最多丢 1 秒（磁盘卡顿时约 2 秒）。生产一般开 AOF，它的 base 文件默认就是 RDB 格式（混合持久化）。

| 场景 | 推荐 |
|------|------|
| 纯缓存，可从数据库重建 | 关闭持久化或只留低频 RDB |
| 可接受分钟级丢失 | RDB（7.0+ 默认 `save 3600 1 300 100 60 10000`） |
| 最多丢 1~2 秒 | AOF `everysec` |
| 一条都不能丢 | Redis 不该做唯一数据源，以数据库为准 |

- `BGSAVE` 靠 fork + 写时复制，写多的大实例 fork 期间内存可能接近翻倍，要留足内存并关闭透明大页
- 两者都开时，重启优先加载 AOF

→ 详见 [Redis 核心原理](/cache/2_redis_core#二、持久化机制)

### Q8：AOF 重写的原理是什么？Multi-Part AOF 是什么？

**一句话**：重写是 fork 子进程按当前内存生成一份新的基准文件，把冗长的命令历史压成最小集合；7.0 起 AOF 拆成 base、incr、manifest 三类文件，重写期间新写入直接进新的 incr 文件。

- base 文件：重写时生成，`aof-use-rdb-preamble yes`（5.0 起默认）时是 RDB 格式
- incr 文件：base 之后的增量写命令
- manifest：记录当前生效的 base 和 incr，重写完成后原子更新并删除旧文件
- 相比 7.0 以前，不再需要在内存里维护重写缓冲区、结束时再双写
- 触发：`auto-aof-rewrite-percentage 100` 加 `auto-aof-rewrite-min-size 64mb`，或手动 `BGREWRITEAOF`

→ 详见 [Redis 核心原理](/cache/2_redis_core#_2、aof-追加日志)

### Q9：Redis 事务、Pipeline、Lua 有什么区别？

**一句话**：事务（MULTI / EXEC）保证一组命令连续执行但不回滚；Pipeline 只是批量发送、减少往返，不保证原子；Lua 脚本在服务端整体执行，是「读-判断-写」复合操作的首选。

| 对比 | 事务 | Pipeline | Lua / Functions |
|------|------|----------|-----------------|
| 原子执行 | 是（不被插入） | 否 | 是 |
| 能根据中间结果做判断 | 不能 | 不能 | 能 |
| 出错回滚 | 不回滚 | — | 不回滚，已执行的写入保留 |

- `WATCH` + `MULTI` 是乐观锁，高并发下 `EXEC` 频繁失败要重试，所以复杂读改写用 Lua
- 脚本要短：执行期间整个实例阻塞；Cluster 下脚本里的 key 必须在同一个槽（用 Hash Tag）
- 7.0 起可用 Functions（`FUNCTION LOAD` + `FCALL`），函数随复制同步，适合多服务共用的原子逻辑

→ 详见 [Redis 核心原理](/cache/2_redis_core#五、事务、pipeline-与-lua)

## 三、过期与淘汰

### Q10：过期 key 是怎么删除的？从节点会主动删除吗？

**一句话**：惰性删除 + 定期删除两种机制配合：访问时发现过期就删；后台每秒 10 次随机抽样带 TTL 的 key，删掉已过期的。

- 惰性删除保证读不到过期数据，但不再被访问的 key 会一直占内存
- 定期删除某轮过期比例高就继续抽样，同时限制单轮耗时；`active-expire-effort` 可调清理力度
- 从节点不主动删过期 key：读到逻辑过期的 key 返回空，内存要等主节点同步 `DEL` 后才释放
- 漏网的过期 key 最终靠内存淘汰兜底

**常见坑**：大量 key 设置相同 TTL，同一时刻过期，既让清理占满 CPU，又造成缓存雪崩；TTL 要加随机偏移。

→ 详见 [Redis 核心原理](/cache/2_redis_core#四、过期键删除)

### Q11：Redis 内存用完会怎样？有哪些淘汰策略？

**一句话**：要看 `maxmemory`：64 位版本默认是 0（不限制），内存会一直涨直到被操作系统 OOM 杀掉；设置了上限后，按 `maxmemory-policy` 淘汰，默认 `noeviction` 是不淘汰、写命令直接报 OOM 错误。

| 策略 | 说明 |
|------|------|
| `noeviction`（默认） | 不淘汰，写入报错 |
| `allkeys-lru` / `allkeys-lfu` | 所有 key 中淘汰最近最少用 / 访问频率最低的，缓存首选 |
| `volatile-lru` / `volatile-lfu` / `volatile-ttl` | 只在设置了 TTL 的 key 中淘汰 |
| `allkeys-random` / `volatile-random` | 随机淘汰 |

- 用作缓存的实例一定要设 `maxmemory`，并显式改成 `allkeys-lru` 或 `allkeys-lfu`
- 缓存和不能丢的数据混在一个实例时，才考虑 `volatile-*`

→ 详见 [Redis 核心原理](/cache/2_redis_core#三、缓存淘汰策略)

### Q12：Redis 的 LRU / LFU 是精确的吗？手写 LRU 怎么写？

**一句话**：都是近似算法：每次随机采样 `maxmemory-samples`（默认 5）个 key，从里面挑最该淘汰的，不维护全局链表，省内存也省 CPU。

- 采样数调大更接近真实 LRU，但更耗 CPU
- LFU（4.0+）用对数计数器加衰减表示频率，比 LRU 更不怕「扫描一次就把热点挤掉」
- 手写 LRU 最短写法：`new LinkedHashMap<>(cap, 0.75f, true)`（按访问顺序）并重写 `removeEldestEntry` 返回 `size() > cap`
- 面试要 O(1) 手写版本时：HashMap 存 key → 节点，双向链表维护访问顺序，访问时移到表尾、超容量删表头

→ 详见 [Redis 核心原理](/cache/2_redis_core#三、缓存淘汰策略)

## 四、主从、哨兵与集群

### Q13：主从复制的全量同步和增量同步是怎样的？

**一句话**：首次连接走全量同步（主节点发 RDB，再补发期间的写入）；断线重连时，如果缺的数据还在主节点的复制积压缓冲区里，就只补发缺的部分。

- 全量：从节点发 `PSYNC ? -1`，主节点回 `FULLRESYNC` 并生成 RDB；7.0 起默认无盘复制（RDB 直接经 socket 发送）
- 传输期间的新写入缓存在从节点输出缓冲区，超过 `client-output-buffer-limit` 会断开并重新全量同步
- 增量：`PSYNC <replid> <offset>`，offset 还在 `repl-backlog-size`（默认 1MB）内就只补发缺失命令；写多的实例应调大到几十 MB
- PSYNC2（4.0+）保存上一任主节点的复制 ID，故障切换后其他从节点也能部分重同步

**常见坑**：复制是异步的，从节点读到的可能是旧值，「写后立即读」要读主节点。

→ 详见 [Redis 集群](/cache/3_redis_cluster#二、主从复制)

### Q14：哨兵如何判断主节点下线并完成切换？quorum 和多数派有什么区别？

**一句话**：单个哨兵超时没收到回复判「主观下线」；认为下线的哨兵数达到 quorum 判「客观下线」；再由获得全部哨兵多数票的那个哨兵执行切换。

- quorum 只决定「什么时候算客观下线」；能不能切换，取决于能否拿到多数哨兵的授权
- 网络分区时，少数派一侧的哨兵即使达到 quorum 也选不出 Leader，不会误切换
- 选新主顺序：`replica-priority`（越小越优先）→ 复制偏移量（越大越新）→ run ID
- 常见部署：1 主 2 从 + 3 个哨兵，quorum = 2，哨兵分布在不同主机或可用区

**常见坑**：以为 Cluster 也靠哨兵切换。Cluster 是节点之间互相判定故障，由多数主节点投票选出新主，不需要哨兵。

→ 详见 [Redis 集群](/cache/3_redis_cluster#三、哨兵模式-sentinel)

### Q15：Cluster 如何分片？为什么是 16384 个槽？MOVED 和 ASK 有什么区别？

**一句话**：`slot = CRC16(key) mod 16384`，每个主节点负责一部分槽，扩缩容就是迁移槽；它不是一致性哈希，槽与节点的映射由集群显式维护。

| | MOVED | ASK |
|--|-------|-----|
| 含义 | 槽已经稳定归属另一个节点 | 槽正在迁移，这个 key 已迁到目标节点 |
| 客户端动作 | 更新本地槽表并重发 | 先发 `ASKING` 再发原命令，不更新槽表 |

- 16384 的原因：心跳要带槽位图，16384 个槽是 2KB，65536 就是 8KB；集群建议不超过约 1000 个主节点，16384 已够均匀
- 多 key 命令、事务、Lua 的 key 必须同槽，用 Hash Tag：`{user:1}:name`、`{user:1}:age`
- Cluster 只有 0 号库，跨节点的 `KEYS` / `SCAN` 要逐个主节点执行

→ 详见 [Redis 集群](/cache/3_redis_cluster#四、cluster-模式)

### Q16：Redis 会丢已确认的写吗？脑裂怎么发生，`min-replicas-to-write` 能杜绝吗？

**一句话**：会。复制是异步的，主节点确认写入后宕机，没同步的写入随故障切换丢失；分区时旧主还在少数派一侧接受写入，恢复后降级为从节点并清空数据，这段写入全丢。

- `min-replicas-to-write 1` + `min-replicas-max-lag 10`：旧主失联后最多再接受约 10 秒写入，缩小窗口但不能消除
- `WAIT` / `WAITAOF`（7.2+）等待副本确认，超时也不会回滚，同样只能降低概率
- Redis 不是强一致系统，不能丢的数据以数据库为准，或在业务上做对账

**常见坑**：把 `min-replicas-to-write` 理解成「从节点同步成功才写入」，它只是限制失联后的写入时长。

→ 详见 [Redis 集群](/cache/3_redis_cluster#五、异步复制下的一致性)

## 五、缓存问题治理

### Q17：缓存穿透是什么？怎么解决？

**一句话**：查的数据缓存里没有、数据库里也没有，每次都打到数据库，常见于恶意构造的 ID。解法是缓存空值、布隆过滤器前置拦截，再加参数校验和限流。

- 缓存空值：TTL 要短（几十秒到几分钟），数据新建后要删掉这个空值 key
- 区分「未命中」和「命中空值」，不要用 `null` 同时表示两者
- 布隆过滤器：ID 空间大、攻击 ID 随机时用，Redis 8 可直接用 `BF.*`，或 Redisson `RBloomFilter`；它说「不存在」就一定不存在
- 入口先校验 ID 格式与范围，持续的恶意流量交给限流

→ 详见 [缓存最佳实践](/cache/11_cache_rule#四、缓存穿透防护)

### Q18：缓存击穿是什么？互斥重建有哪些坑？什么时候用逻辑过期？

**一句话**：某个热点 key 过期的瞬间，大量并发请求同时回源数据库。先在本 JVM 内合并回源，实例多、回源贵时再加跨实例互斥重建；极热且能容忍旧值的数据用逻辑过期。

- 单 JVM 合并：Caffeine `get(key, loader)`、`@Cacheable(sync = true)`，N 个实例仍各回源一次
- 互斥重建的坑：`setIfAbsent` 返回 `Boolean` 可能为 null，用 `Boolean.TRUE.equals` 判断；解锁要随机 token + Lua 校验持有者；等待要有次数上限，超时降级
- 逻辑过期：值里带过期时间，过期了先返回旧值，抢到锁的线程异步重建；物理 TTL 仍要设，并远大于逻辑过期时间

**常见坑**：没抢到锁的请求直接返回 null 或无限等待，前者让用户看到空数据，后者把线程池拖满。

→ 详见 [缓存最佳实践](/cache/11_cache_rule#五、缓存击穿防护)

### Q19：缓存雪崩是什么？Redis 整体挂了怎么办？

**一句话**：大量 key 同时过期，或缓存服务整体不可用，请求集中压到数据库。前者靠 TTL 打散，后者靠高可用 + 本地缓存兜底 + 限流降级。

- TTL 加随机抖动，批量预热的数据尤其要打散
- 事前：哨兵或 Cluster 保证 Redis 高可用
- 事中：热点数据用本地缓存（Caffeine）兜底；对数据库限流、降级，用 Sentinel 或 Resilience4j（Hystrix 早已停止维护）
- 事后：开持久化的实例重启后快速加载数据；纯缓存实例重启要分批预热，避免预热本身压垮数据库

→ 详见 [缓存最佳实践](/cache/11_cache_rule#六、缓存雪崩防护)、[缓存架构设计](/high-con/3_cache_architecture)

### Q20：大 Key 如何发现与治理？

**一句话**：大 key 读写和删除都慢，会阻塞主线程、占满网卡，Cluster 下还让分片不均、槽迁移卡顿。用 `--bigkeys` / `--memkeys` 扫描发现，拆分、压缩，删除用 `UNLINK`。

- 经验阈值：String 超过 10KB、集合元素超过 5000 个或总大小超过 10MB，按实例规格调整
- 发现：`redis-cli --bigkeys -i 0.1`（按元素数）、`--memkeys`（按内存）、`MEMORY USAGE key`；建议在从节点或低峰执行
- 治理：大集合按 ID 取模拆成多个 key，读取用 `HSCAN` / `SSCAN` 分批；大 String 压缩或只缓存需要的字段
- 删除：`UNLINK` 后台释放；或开 `lazyfree-lazy-user-del yes` 让 `DEL` 也异步

→ 详见 [Redis 实战](/cache/5_redis_practice#二、大-key)

### Q21：热 Key 如何发现与处理？为什么加分片不管用？

**一句话**：单个 key 永远只属于一个槽、一个主节点，加分片分散不了它。要在 Redis 之前挡住请求：本地缓存、多副本 key、读从节点。

- 发现：`redis-cli --hotkeys`（需要 LFU 淘汰策略）、客户端埋点、代理层统计，或 Redis 8 的 `TOPK.*` 近似统计
- 本地缓存：Caffeine 缓存热 key 几秒，先读本地、未命中再读 Redis
- 多副本 key：`hot:product:1001:0` ~ `:7` 落在不同槽，读时随机选一个，写时更新或删除全部副本，容忍短暂不一致
- 读从节点：读多写少、能接受复制延迟时分流

**常见坑**：副本 key 写成 `{hot:product:1001}:n`，Hash Tag 让所有副本落进同一个槽，打散失效。

→ 详见 [Redis 实战](/cache/5_redis_practice#三、热-key)、[热点问题](/high-con/6_hotspot)

## 六、缓存一致性

### Q22：Cache Aside、Read / Write Through、Write Behind 有什么区别？

**一句话**：Cache Aside 由应用自己读缓存、写库后删缓存，是绝大多数业务的选择；Through 由缓存层代为读写数据库；Write Behind 只写缓存、异步批量落库，最快但可能丢数据。三种都只是最终一致。

| 维度 | Cache Aside | Read / Write Through | Write Behind |
|------|-------------|----------------------|--------------|
| 谁维护缓存 | 应用 | 缓存层 | 缓存层 |
| 写路径 | 写库 → 删缓存 | 写缓存层 → 同步写库 | 写缓存 → 异步写库 |
| 主要风险 | 并发下旧值回填 | 缓存层单点 | 宕机丢数据 |

- Spring Cache 的 `@Cacheable` + `@CacheEvict` 属于 Cache Aside
- Caffeine `LoadingCache` 只是 Read Through，3.0 已移除 `CacheWriter`
- Write Behind 适合计数、点赞、浏览量这类允许少量误差的数据

→ 详见 [缓存一致性](/cache/10_cache_consistency#一、三种缓存模式)

### Q23：为什么是「先更新数据库再删缓存」？它还剩什么竞态？

**一句话**：删除是幂等的，乱序也不怕；新值由下一次读按数据库最新状态重建。其他三种顺序都有更大的窗口，这种只在少见的并发时序下出错。

- 先更新库再**更新**缓存：两个并发写可能乱序，缓存留下旧值
- 先删缓存再更新库：删完、提交前，读请求从库里读到旧值又写回缓存，窗口等于整个事务
- 先改缓存再改库：库写失败或回滚，缓存里就是从未生效的数据
- 残留竞态：读请求 A 未命中、读到旧值 → 写请求 B 更新并删缓存 → A 把旧值写回；读写分离、A 发生 GC 停顿时窗口会放大

**常见坑**：以为删缓存就能做到强一致；任何组合都只是缩小窗口，所以所有缓存 key 必须有 TTL 兜底。

→ 详见 [缓存一致性](/cache/10_cache_consistency#二、cache-aside-的写顺序)

### Q24：为什么要在事务提交之后删缓存？删除失败怎么办？

**一句话**：「先更新数据库」指的是事务提交。在 `@Transactional` 方法里删缓存，删除发生在提交之前，提交前的窗口里旧值会被重新读回缓存；回滚时缓存也白删了。

- 做法：`@TransactionalEventListener(phase = AFTER_COMMIT)` 或 `TransactionSynchronization.afterCommit()`
- 仍有两个缺口：删除失败（网络抖动）；提交后、删除前进程崩溃
- 补法：删除失败进 MQ 重试；或由 binlog 订阅驱动删除；或把「待失效 key」和业务数据写进同一本地事务，由投递任务保证必达
- 无论哪种，缓存 key 都要有 TTL 作为最后一道兜底

→ 详见 [缓存一致性](/cache/10_cache_consistency#三、删除时机-事务提交之后)

### Q25：延迟双删怎么做？延迟时间怎么定？

**一句话**：提交后删一次，延迟一段时间再删一次，第二次专门清掉并发读请求回填的旧值。它只能降低、不能消除不一致。

- 延迟 > 读请求「读库 + 写缓存」的 P99 耗时 + 主从复制延迟（读从库时），常见几百毫秒到 1~2 秒，以监控为准
- 用 MQ 延迟消息承载第二次删除，失败由 MQ 重试；RocketMQ 5.x 支持任意延迟
- 不要在请求线程里 `sleep`，也不要用内存定时器或每次 `new Thread`：拖慢接口，进程重启第二次删除就丢了

**常见坑**：把延迟定成「事务提交所需时间」，真正要覆盖的是并发读请求从读库到写缓存的耗时。

→ 详见 [缓存一致性](/cache/10_cache_consistency#四、延迟双删)

### Q26：binlog / CDC 订阅失效有什么优势？

**一句话**：由 Canal、Debezium、Flink CDC 订阅 binlog，把行变更转成待删除的 key，交给独立消费者删除。只有提交成功的变更才会进 binlog，天然满足「提交后删除」，还能重试和重放。

- 业务服务只写库，进程崩溃不影响删除；多个服务、批量脚本、手工 SQL 改同一张表都能失效
- 以主键作为 MQ 分区键，保证同一 key 的变更有序；失败退避重试，超过次数进死信并告警
- 代价：要运维 CDC 和 MQ，端到端延迟几十到几百毫秒
- 推荐组合：所有 key 有 TTL + 提交后删一次（快）+ binlog 订阅再删一次（可靠）

→ 详见 [缓存一致性](/cache/10_cache_consistency#五、binlog-cdc-订阅失效)

### Q27：用 Spring Cache 更新数据时，为什么用 `@CacheEvict` 而不是 `@CachePut`？

**一句话**：`@CachePut` 是「写库后写缓存」，两个并发更新的写库和写缓存可能交错，缓存里留下旧值且长期不过期；`@CacheEvict` 删除后由下一次读回填，配合 TTL 能收敛。

- `@Cacheable(sync = true)`：同一 key 并发未命中时只放一个线程查库，只在单 JVM 内有效
- `@CacheEvict` 和 `@Transactional` 在同一个方法上，要让删除发生在提交后（如 `RedisCacheManager` 开启 `transactionAware()`）
- 注解基于代理，同类内部调用 `this.xxx()` 不走缓存
- 序列化用 Jackson 3 的 JSON 序列化器，开启类型信息时要配受限的类型校验器，不要放开所有类型

→ 详见 [Redis 实战](/cache/5_redis_practice#_4、spring-cache-配置)

## 七、本地缓存与多级缓存

### Q28：Caffeine 的 W-TinyLFU 比 LRU 好在哪？

**一句话**：LRU 只看最近访问，一次全表扫描就能把真正的热点挤出去；W-TinyLFU 用访问频率做准入，扫描流量很难进入主区，多数访问模式下命中率明显更高。

- 窗口区（约 1%）：新数据先进窗口，给突发热点积累频率的机会
- TinyLFU 准入：窗口淘汰的候选者与主区淘汰候选者比频率，高的留下；频率用 Count-Min Sketch 近似统计，定期减半实现老化
- 主区（分段 LRU）：试用区 + 保护区，再次命中晋升到保护区
- 窗口比例按命中率自适应调整

→ 详见 [Caffeine](/cache/7_caffeine#_1、w-tinylfu-结构)

### Q29：Caffeine 的 `refreshAfterWrite` 和 `expireAfterWrite` 有什么区别？

**一句话**：过期是删除，过期后访问要同步等加载；刷新不删除，到点后由下一次访问触发异步重载，重载完成前返回旧值，失败也保留旧值。

| 对比 | `expireAfterWrite` | `refreshAfterWrite` |
|------|-------------------|---------------------|
| 到点后 | 条目被移除 | 条目保留 |
| 下一次访问 | 同步等待加载 | 立即返回旧值，后台重载 |
| 前提 | 任意 Cache | 需要加载函数（`LoadingCache`） |

- 同时配置时让刷新间隔小于过期时间：常访问的靠刷新保鲜，久不访问的靠过期回收
- 过期清理默认在读写时顺带进行，需要准时清理时配 `Scheduler.systemScheduler()`

**常见坑**：以为引入 Caffeine 后 Spring Boot 一定用它。类路径上同时有 Redis 时，Redis 在探测顺序里排在前面，要设 `spring.cache.type=caffeine`。

→ 详见 [Caffeine](/cache/7_caffeine#三、过期与刷新)

### Q30：两级缓存（本地 + Redis）如何让多实例的本地缓存失效？

**一句话**：写操作提交后删 Redis，再广播失效消息让所有实例删本地条目；广播都可能丢，所以本地缓存必须配短 TTL 兜底。

| 方案 | 延迟 | 丢失风险 |
|------|------|---------|
| Redis Pub/Sub | 毫秒级 | 断线、重启期间丢失 |
| MQ 广播 | 毫秒到秒级 | 低，可补消费 |
| Redis 服务端失效推送（`CLIENT TRACKING`） | 毫秒级 | 断线期间丢失 |

- 库存、价格、余额这类强一致数据不放本地缓存
- JetCache `CacheType.BOTH` 默认不同步各实例的本地缓存，要配 `broadcastChannel`（编程式缓存还要 `syncLocal(true)`）
- Redisson `RLocalCachedMap` 要把 `reconnectionStrategy` 设为 `CLEAR` 或 `LOAD`，否则断线期间的失效通知丢了也不知道

→ 详见 [两级缓存（L1 + L2）](/cache/8_two_level_cache#三、多实例-l1-失效)、[JetCache](/cache/9_jetcache#五、多实例本地缓存同步)

## 八、Redisson 与分布式锁要点

### Q31：Redisson 看门狗多久续期一次？指定 leaseTime 会怎样？可重入锁在 Redis 里怎么存？

**一句话**：不传 leaseTime 时锁默认 30 秒过期，每 10 秒续期一次；一旦传了 leaseTime，看门狗就不工作，业务超时锁就提前释放。

- 续期只看客户端进程是否存活，不看业务线程是否正常推进；进程崩溃后锁最多 30 秒释放
- 可重入：锁是一个 Hash，field 为「实例 UUID:线程 ID」，value 是重入次数，减到 0 才删 key
- 解锁前用 `isHeldByCurrentThread()` 判断，避免在超时、未拿到锁的分支里误解锁抛异常
- GC 停顿、网络分区时锁仍可能过期，严格正确性要靠 fencing token（`RFencedLock`）或数据库条件更新

**常见坑**：以为看门狗能解决一切锁过期问题；停顿期间续期线程也停着，见 [分布式面试题解答](/interview/10_distributed#二、分布式锁)。

→ 详见 [Redisson](/cache/6_redisson#_1、rlock-看门狗与-leasetime)、[分布式锁](/distributed/3_lock#_2、redisson-与看门狗)

### Q32：MultiLock 和 Redlock 有什么区别？Redisson 的延迟队列能直接用于订单超时吗？

**一句话**：MultiLock 是同时锁住多个资源、每一把都要成功；Redlock 是在多个独立主节点上拿到多数派。`RedissonRedLock` 已被官方标记废弃，推荐 `RLock` 或 `RFencedLock`。

- Redlock 的争议核心：依赖时钟和网络延迟有界的假设，且没有 fencing token，详见分布式锁一文
- 开源版 `RDelayedQueue` 已废弃，替代品 `RReliableQueue` 只在 PRO 版提供
- `RDelayedQueue` 靠客户端定时搬运，没有存活的客户端就不会按时投递，`take()` 后失败也不会重投
- 订单超时这类要可靠投递的场景，用 RocketMQ 5.x 定时消息 + 定时扫描兜底

→ 详见 [Redisson](/cache/6_redisson#_3、公平锁、读写锁与联锁)、[订单系统设计](/scenario/5_order_system#四、超时关单)

---
description: CAP 与 PACELC、共识算法、分布式锁与 Fencing Token、分布式事务与 Seata、分布式 ID、一致性哈希、调度与会话
---

# 分布式面试题解答

> 题目清单见 [分布式面试题](/distributed/99_interview)；细节见 [分布式总览](/distributed/0_overview)。
>
> 版本基线：Redis 8.x、Redisson 4.x、Apache Seata 2.x（`org.apache.seata`）、RocketMQ 5.x、Kafka 4.x（仅 KRaft）、XXL-JOB 3.x、Spring Boot 4 / Spring Session 4。

## 一、理论基础

### Q1：CAP 为什么不是「三选二」？PACELC 补充了什么？

**一句话**：网络分区在分布式系统里无法排除，所以 P 不是可选项；CAP 说的是「发生分区时，只能在一致性和可用性之间选一个」，没有分区时两者可以兼得。

- C 指线性一致：读一定能读到最近一次完成的写，不是数据库 ACID 里的 C
- CP：分区时少数派一侧拒绝服务（etcd、ZooKeeper）；AP：各侧继续服务、事后合并（Eureka、Nacos 临时实例）
- PACELC：分区时在 A 和 C 间选；**没有分区时**在延迟（L）和一致性（C）间选，更贴近日常的「同步复制到多数派」还是「本地写完就返回」
- Redis Cluster 偏 AP，故障切换可能丢已确认的写；MySQL 异步、半同步复制都不保证线性一致

→ 详见 [分布式理论](/distributed/2_theorem#一、cap-与-pacelc)

### Q2：BASE 是什么？和 ACID 是什么关系？

**一句话**：BASE（基本可用、软状态、最终一致）是 AP 路线的工程原则：故障时允许降级，允许副本短暂不一致，但没有新写入后最终收敛。

| 对比 | ACID | BASE |
|------|------|------|
| 一致性 | 强一致 | 最终一致 |
| 典型范围 | 单个数据库的本地事务 | 跨服务、跨存储 |
| 实现 | 锁 + 日志 | 异步复制、可靠消息、补偿 |

- 两者不是二选一：服务内部用 ACID 本地事务，跨服务用 BASE 的最终一致
- 最终一致的常见实现：读修复、反熵（Merkle Tree 比对）、可靠消息 + 幂等消费
- 「会话一致」（读己之写）是常用的折中：写后读主库

→ 详见 [分布式理论](/distributed/2_theorem#二、base-与一致性模型)

### Q3：Raft 的选举与日志复制是怎样的？新 Leader 为什么一定有全部已提交日志？

**一句话**：Follower 超时没收到心跳就把任期加一、投自己一票、向其他节点拉票，拿到多数票成为 Leader；Leader 把日志复制到多数派后提交。

- 投票限制：投票者只投给日志「至少和自己一样新」的候选者（先比最后一条的 term，再比 index）
- 已提交的日志一定在多数派上，当选也要多数派投票，两个多数派必有交集，所以新 Leader 不会缺已提交日志
- 选举超时取随机值（论文示例 150~300ms），减少平票
- 线性一致读：直接读 Leader 本地不安全，要用 ReadIndex（先确认自己仍是 Leader）或依赖时钟的 Lease Read

**常见坑**：说「当选后任期加一」。任期是在发起选举、成为 Candidate 时就加一的。

→ 详见 [分布式理论](/distributed/2_theorem#五、raft)

### Q4：Paxos、ZAB、Raft 有什么区别？

**一句话**：Basic Paxos 只解决「一个值」的共识，工程落地要自己补很多；Raft 和 ZAB 都是单 Leader + 多数派确认，Raft 的设计目标是易于理解和正确实现。

| 对比 | Paxos | ZAB | Raft |
|------|-------|-----|------|
| 逻辑时钟 | 提案编号 | epoch + ZXID | term + log index |
| Leader | Multi-Paxos 才选稳定 Leader | 有 | 强 Leader |
| 典型应用 | Chubby、MySQL Group Replication（XCom） | ZooKeeper | etcd、Consul、TiKV、Kafka KRaft |

- ZooKeeper 用的是 ZAB，不是 Paxos；它的读默认是顺序一致，要读最新值先调 `sync()`
- 所有共识算法都满足：任何时候不违反安全性，只在网络足够稳定时保证进展（FLP 定理的工程绕法）

→ 详见 [分布式理论](/distributed/2_theorem#四、paxos)、[ZAB](/distributed/2_theorem#六、zab)

### Q5：Gossip 协议的原理是什么？用在哪里？

**一句话**：每个节点周期性随机挑几个节点交换信息，像流言一样扩散，没有中心节点；信息传遍全网约需 O(log N) 轮。

- 三种方式：Push、Pull、Push-Pull（双向交换，收敛最快）
- 优点：去中心、容错强，任意节点故障不影响传播
- 缺点：最终一致、有传播延迟，会重复发送对方已知的信息
- 应用：Redis Cluster 节点间交换心跳、槽位和故障判定；Cassandra 传播节点状态；Consul / Serf 基于 SWIM 做成员管理

→ 详见 [分布式理论](/distributed/2_theorem#七、gossip)

### Q6：Quorum NWR 是什么？W + R > N 就是强一致吗？

**一句话**：N 个副本，写成功要 W 个，读要 R 个；W + R > N 时读写集合必有交集，读能碰到最新写，再用版本号挑出最新值。

- W > N / 2 可以避免两个并发写同时成功
- 常见取值 N=3、W=2、R=2；要写快降低 W，要读快降低 R（Cassandra 的 `QUORUM` 就是这个思路）
- 它不等于线性一致：节点故障、读修复的时机仍可能产生异常读，严格保证要靠共识协议
- 多数派也是防脑裂的基础：分区时只有多数派一侧能选主、能提交

→ 详见 [分布式理论](/distributed/2_theorem#_4、quorum-nwr)

## 二、分布式锁

### Q7：分布式锁有哪些实现？怎么选？

**一句话**：先分清用锁的目的：只为避免重复干活的「效率锁」，Redis 单实例就够；同时持锁会写坏数据的「正确性锁」，任何锁都要再配 Fencing Token 或数据库条件更新。

| 方案 | 自动释放 | 一致性 | 特点 |
|------|---------|--------|------|
| Redis（Redisson） | key 过期 | 异步复制，切换可能丢锁 | 性能最高，已有 Redis 时首选 |
| ZooKeeper（Curator） | 会话过期删临时节点 | ZAB 多数派 | 顺序节点天然公平 |
| etcd | 租约过期 | Raft 多数派 | K8s 环境现成 |
| 数据库 | 无 | 本地事务 | 行锁或唯一索引，性能差 |

- 秒杀扣库存、余额扣减不用锁做主手段，用 Lua 原子扣减或数据库条件更新

→ 详见 [分布式锁](/distributed/3_lock#八、方案对比与选型)

### Q8：Redis 分布式锁的正确写法是什么？

**一句话**：加锁用一条原子命令 `SET key <唯一值> NX PX <毫秒>`，解锁先比较 value 再删除，比较和删除必须原子。

- 不要 `SETNX` 再 `EXPIRE` 两步：中间崩溃就留下永不过期的锁
- value 必须唯一（UUID）：A 执行超时锁过期被 B 拿到，A 直接 `DEL` 会删掉 B 的锁
- 解锁用 Lua：`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`
- Redis 8.4 起有原生 `DELEX key IFEQ value`；更省心的是直接用 Redisson（可重入、续期、等待都处理好了）
- 主从异步复制：主节点加锁后没同步就宕机，新主上没有这把锁，两个客户端同时持锁

→ 详见 [分布式锁](/distributed/3_lock#二、redis-分布式锁)

### Q9：Redisson 看门狗什么时候不生效？能防住 GC 停顿导致的双持锁吗？

**一句话**：传了 leaseTime 看门狗就不续期；即使在续期，长时间 GC 停顿或网络分区也会让锁过期，原持有者恢复后还以为自己持锁。看门狗防不住，要靠资源侧的 Fencing Token。

- 默认 30 秒过期、每 10 秒续期；只看进程是否存活，业务线程卡死而进程活着，锁会一直续下去
- Fencing Token：每次加锁返回单调递增编号，写存储时带上，存储拒绝比已见过更小的编号
- 实现：Redisson `RFencedLock`；ZooKeeper 用顺序节点序号或 `czxid`；etcd 用 `CreateRevision`
- 资源不支持按 token 条件写时，直接用数据库条件更新（`WHERE version = ?`）保证正确性，锁只减少冲突

→ 详见 [分布式锁](/distributed/3_lock#三、租约过期与-fencing-token)

### Q10：Redlock 是什么？争议的焦点在哪？

**一句话**：Redlock 在 5 个相互独立的 Redis 主节点上加锁，多数成功且耗时小于 TTL 才算拿到锁。争议是它依赖「时钟漂移和网络延迟有界」的假设，又没有 Fencing Token，GC 停顿或时钟跳变时仍可能两个客户端同时持锁。

- Kleppmann：任何租约锁没有 Fencing Token 都不安全；正确性锁用 ZooKeeper / etcd 配合 Token
- antirez：在声明的假设下 Redlock 是安全的，加锁后会检查耗时
- 工程共识：部署运维成本高，仍替代不了 Fencing Token；Redisson 已把 `RedissonRedLock` 标为废弃
- 节点崩溃重启前若没持久化锁数据，要延迟一个 TTL 再重启

→ 详见 [分布式锁](/distributed/3_lock#四、redlock-及其争议)

### Q11：ZooKeeper 和 etcd 的锁是怎么实现的？ZooKeeper 锁会不会「丢锁」？

**一句话**：ZooKeeper 用临时顺序节点：序号最小者得锁，其余只 Watch 紧邻的前一个节点；etcd 用租约 + 按 `CreateRevision` 排队。两者都基于租约，同样会在停顿时失效。

- 只盯前一个节点，避免所有等待者被同时唤醒（羊群效应）；被唤醒后要重新取子节点列表判断
- 客户端崩溃后会话过期，临时节点自动删除，锁自然释放
- 会丢：GC 停顿超过会话超时，节点被删、别人拿到锁，自己恢复后还以为持锁，也要配 Fencing Token
- Curator `InterProcessMutex` 支持可重入；etcd 解锁要传 `lock()` 返回的持有者 key，而不是锁名

→ 详见 [分布式锁](/distributed/3_lock#五、zookeeper-分布式锁)

### Q12：分布式锁有哪些常见坑？秒杀扣库存为什么不该靠锁？

**一句话**：最常见的是锁和事务边界错位、没拿到锁也去解锁、锁粒度过粗；秒杀用一把锁会把所有请求串行化，吞吐被锁的往返时间卡死。

- 锁在事务提交前释放：`@Transactional` 方法内部加锁解锁，下一个线程拿到锁却读不到刚写的数据；加锁放在事务边界之外，或提交后再解锁
- `tryLock` 失败仍 `unlock`：Redisson 抛 `IllegalMonitorStateException`，先检查返回值
- 锁粒度要细到资源 ID，如 `lock:order:{orderId}`
- 用锁代替幂等：锁只挡并发，挡不住锁释放后的重复请求，重复提交要靠唯一约束或状态机
- 防超卖用 Lua 判断后 `DECR`，或 `UPDATE ... SET n = n - 1 WHERE id = ? AND n > 0`

→ 详见 [分布式锁](/distributed/3_lock#七、常见坑)、[秒杀](/scenario/4_seckill)

## 三、分布式事务

### Q13：分布式事务有哪些方案？怎么选？

**一句话**：第一步是尽量不产生分布式事务（调整服务边界）；能异步的用本地消息表或事务消息；必须同步拿结果时，资金类用 TCC，内部非热点业务可用 Seata AT；长流程用 Saga。

| 方案 | 一致性 | 适用 |
|------|--------|------|
| 本地消息表 / 事务消息 | 最终一致 | 写库后通知下游，最通用 |
| TCC | 最终一致，资源预留隔离 | 资金、库存预留 |
| Saga | 最终一致，无隔离 | 长流程、调用外部系统 |
| Seata AT | 最终一致，全局锁写隔离 | 内部系统、非热点数据 |
| XA / Seata XA | 强一致 | 低并发、强一致 |

- 所有方案都要有对账和人工补偿兜底，下游都要幂等

**常见坑**：把 TCC 说成强一致。Try 之后、Confirm 之前存在中间状态，只是被冻结字段隔离了。

→ 详见 [分布式事务](/distributed/4_transaction#九、方案选型)

### Q14：2PC / XA 有什么问题？3PC 解决了吗？

**一句话**：2PC 分准备和提交两阶段，参与者从 Prepare 到 Commit 一直持有锁；协调者在发出决议前宕机，参与者只能干等。3PC 引入超时默认提交，分区时反而会不一致，工程上几乎没人用。

- 同步阻塞：热点行在整个两阶段期间被锁住，吞吐大幅下降
- 协调者单点：已 Prepare 的参与者不知道该提交还是回滚
- 部分提交：Commit 只到达了部分参与者，需要协调者恢复后重发
- 实际可用：MySQL XA + Atomikos / Narayana，或 Seata XA 模式，适合低并发、跨少量数据库

→ 详见 [分布式事务](/distributed/4_transaction#二、2pc-与-xa)

### Q15：TCC 是什么？空回滚、幂等、悬挂怎么处理？

**一句话**：TCC 是业务层的两阶段：Try 冻结资源，Confirm 用掉冻结的资源，Cancel 释放；网络超时和重试会让三个接口乱序或重复到达，要靠一张事务控制表兜住。

| 问题 | 场景 | 处理 |
|------|------|------|
| 空回滚 | Try 没到达，Cancel 先来 | 没有 Try 记录就直接成功，并记「已回滚」 |
| 幂等 | Confirm / Cancel 被重试 | 按全局事务 ID + 分支 ID 记录状态 |
| 悬挂 | Cancel 之后迟到的 Try 才到 | Try 前检查已有「已回滚」记录就拒绝 |

- 控制表记录要和业务操作在同一个本地事务里写
- Seata 1.5 起有 TCC Fence：`useTCCFence = true` 后由 `tcc_fence_log` 表自动处理这三个问题
- Confirm / Cancel 必须幂等且最终成功，失败只能重试或转人工

→ 详见 [分布式事务](/distributed/4_transaction#三、tcc)

### Q16：Saga 某一步失败时补偿哪些步骤？编排与协同怎么选？和 TCC 有什么区别？

**一句话**：Saga 把长事务拆成 T1…Tn，Ti 失败时它自己的本地事务已回滚，逆序补偿**已完成**的步骤（C(i-1) → … → C1）。补偿要幂等、可重试直到成功、允许空补偿。

| 对比 | TCC | Saga |
|------|-----|------|
| 隔离 | 资源预留，中间状态不可用 | 无隔离，需要语义锁等对策 |
| 时长 | 秒级短流程 | 可以是分钟到天的长流程 |
| 场景 | 扣款、扣积分 | 订单全流程、旅行预订 |

- 编排：中心编排器驱动，流程集中、易监控，编排器要持久化每一步（Seata Saga 状态机、Temporal）
- 协同：各服务发事件接力，松耦合，但流程分散难追踪
- 隔离对策：语义锁（中间状态）、可交换的更新（增减而不是覆盖）、执行前重读校验

→ 详见 [分布式事务](/distributed/4_transaction#四、saga)

### Q17：Seata AT 的原理是什么？全局锁和读隔离是怎样的？回滚什么时候会失败？

**一句话**：一阶段解析 SQL 记录前后镜像写 `undo_log`，与业务 SQL 同一本地事务，拿到全局锁后提交；二阶段提交时只异步删 `undo_log`，回滚时用前镜像生成反向 SQL。

- 写隔离：全局锁保证一个全局事务没结束前，其他全局事务改不了同一行
- 读隔离：全局层面默认**读未提交**，能读到之后会回滚的数据；要读已提交用 `SELECT ... FOR UPDATE`，本地方法加 `@GlobalLock`
- 回滚失败：后镜像与当前数据不一致，说明被 Seata 之外的写入改过（脏写），只能人工处理
- 热点行在整个全局事务期间被全局锁串行化，不适合秒杀库存

**常见坑**：其他系统绕过 Seata 数据源代理直接改同一张表，是回滚失败的主要来源。

→ 详见 [分布式事务](/distributed/4_transaction#_3、at-模式)；依赖与配置见 [Spring Cloud 面试题解答](/interview/11_spring_cloud#四、分布式事务)

### Q18：Seata 的 AT、TCC、Saga、XA 怎么选？

**一句话**：想零侵入快速落地用 AT（避开热点行）；资金类、非关系型资源用 TCC；长流程、遗留系统用 Saga；要强一致且并发低用 XA。

| 模式 | 一致性 | 隔离 | 侵入 | 性能 |
|------|--------|------|------|------|
| AT | 最终一致 | 全局锁写隔离，读未提交 | 几乎无 | 较高，热点受限 |
| TCC | 最终一致 | 业务资源预留 | 高 | 高 |
| Saga | 最终一致 | 无 | 中 | 高 |
| XA | 强一致 | 数据库 XA | 几乎无 | 低 |

- Seata 2.x 是 Apache 孵化项目，groupId 和包名都是 `org.apache.seata`
- 一个业务流程只选一种方案，不要 Seata 全局事务和事务消息混用

→ 详见 [分布式事务](/distributed/4_transaction#_2、四种模式)

### Q19：怎么用消息实现最终一致？RocketMQ 事务消息回查查不到记录时该返回什么？

**一句话**：不在数据库事务里直接发 MQ；用本地消息表（业务表和消息表同一本地事务，投递任务发 MQ）或 RocketMQ 事务消息（半消息 + 本地事务 + 回查），消费端幂等。

- 本地消息表：提交后立即投递，扫表兜底；多实例扫表用 `SKIP LOCKED`；也可以用 CDC 读 binlog 投递
- 回查可能在本地事务还没执行完时到达，查不到记录不代表失败，要返回 `UNKNOW` 让 Broker 稍后再查
- Kafka 事务只保证多分区写入的原子性，绑不了外部数据库，「写库 + 发消息」仍要本地消息表或 CDC
- 跨企业回调用最大努力通知 + 对账查询兜底

→ 详见 [分布式事务](/distributed/4_transaction#五、本地消息表-transactional-outbox)、[消息队列面试题解答](/interview/9_mq#五、分布式事务)

## 四、分布式 ID

### Q20：分布式 ID 有哪些方案？UUIDv7 为什么适合做主键？

**一句话**：UUIDv4 完全随机，作主键会让 B+ 树频繁页分裂；UUIDv7（RFC 9562）前 48 位是毫秒时间戳，按时间有序，本地生成无需协调。要 64 位就用 Snowflake 或号段模式。

| 方案 | 有序性 | 长度 | 主要风险 |
|------|--------|------|---------|
| UUIDv4 / v7 | 无序 / 按毫秒有序 | 128 位 | 占空间 |
| 数据库自增 | 单库递增 | 64 位 | 单点、扩容难 |
| Snowflake | 趋势递增 | 64 位 | 时钟回拨、workerId 冲突 |
| 号段模式 | 节点内递增 | 64 位 | 重启丢号段 |

- JDK 21 / 25 只内置 v3 / v4，v7 要用第三方库；MySQL 用 `BINARY(16)` 存，PostgreSQL 18 起有 `uuidv7()`
- 对外的订单号、短码不要直接暴露有序 ID，能被推算出业务量

→ 详见 [分布式 ID 生成](/distributed/8_id_generator#二、uuid)

### Q21：Snowflake 的结构是什么？时钟回拨和生产中有哪些坑？

**一句话**：64 位 = 1 位符号 + 41 位相对自定义起点的毫秒时间戳（约 69 年）+ 10 位机器 ID + 12 位序列号（每毫秒 4096 个）。

- 时钟回拨：小幅回拨等时钟追上；大幅回拨拒绝发号并告警，或切换备用 workerId；启动时发现时间早于上次记录就拒绝启动
- workerId 冲突：容器里进程号常是 1、网卡信息雷同，按 MAC / PID 推导会撞；从配置中心、数据库、ZooKeeper 领取，或用 StatefulSet 序号
- 前端精度：超过 2^53 的 long 在 JavaScript 里末几位变 0，接口里序列化为字符串
- 分片倾斜：低 QPS 时序列号几乎总是 0，`id % 分片数` 会严重倾斜，先哈希再取模

→ 详见 [分布式 ID 生成](/distributed/8_id_generator#四、雪花算法-snowflake)

### Q22：号段模式和双 Buffer 是什么？美团 Leaf 和百度 UidGenerator 分别解决了什么？

**一句话**：号段模式每次从数据库批量领一段 ID 在内存发放；双 Buffer 在当前号段用掉一部分时异步预取下一段，切换时不用等数据库。

- 领号段用一条 `UPDATE ... SET max_id = max_id + step` 在事务里完成，行锁保证不重叠，不需要版本号
- ID 只在单节点内递增，重启丢弃未发完的号段，业务不能依赖连续
- Leaf：Segment 模式只依赖数据库；Snowflake 模式用 ZooKeeper 分配 workerId 并在启动时校验时钟，能检测回拨但不能消除；项目已基本不更新
- UidGenerator：RingBuffer 预生成 ID，时间用自增秒计数并可借用未来时间，运行中不受回拨影响；每次重启换新 workerId

→ 详见 [分布式 ID 生成](/distributed/8_id_generator#五、号段模式)、[UidGenerator](/distributed/8_id_generator#七、百度-uidgenerator)

## 五、分片与路由

### Q23：一致性哈希是什么？虚拟节点有什么用？

**一句话**：`hash % N` 在节点数变化时几乎所有 key 都换位置；一致性哈希把节点和 key 映射到同一个环上，key 顺时针找第一个节点，增删一个节点只移动约 1/N 的 key。

- 节点少时环上间隔不均，会严重倾斜；每个物理节点放多个虚拟节点（ketama 每台 160 个点），负载接近 1/N
- 节点下线时，它的数据分散到多个节点，而不是全压给一个后继
- 可按机器性能分配不同数量的虚拟节点实现加权
- 应用：Memcached 客户端（ketama）、Nginx `hash $key consistent`、Dubbo `ConsistentHashLoadBalance`
- 变体：Jump Hash（只能在末尾增删）、Rendezvous、Maglev（查表 O(1)）、有界负载一致性哈希

→ 详见 [一致性哈希](/distributed/9_consistent_hashing#三、虚拟节点)

### Q24：Redis Cluster 用的是一致性哈希吗？Kafka 分区路由呢？

**一句话**：都不是。Redis Cluster 用固定的 16384 个槽，`CRC16(key) % 16384`，槽与节点的映射是显式维护的表；Kafka 有 key 时用 `murmur2(key) % 分区数`。

- 槽位和一致性哈希都做到「扩容只动一部分数据」，区别是槽位能精确控制每个槽放哪，迁移由运维触发
- 迁移期间客户端会收到 `MOVED` / `ASK` 重定向
- Kafka 没有 key 时用粘性分区；加分区会改变 key 到分区的映射，严格有序的 topic 要一次规划好分区数
- RocketMQ 顺序消息常用 `key.hashCode() % 队列数`，同样是取模

→ 详见 [一致性哈希](/distributed/9_consistent_hashing#五、在缓存与负载均衡中的应用)

## 六、调度与会话

### Q25：多实例下 `@Scheduled` 重复执行怎么解决？XXL-JOB 怎么保证只执行一次？

**一句话**：每个实例的 `@Scheduled` 都会触发，任务被执行 N 次。轻量做法是 ShedLock 抢锁执行，任务多时上调度平台（XXL-JOB、ElasticJob、PowerJob），由调度中心决定何时触发、交给哪个执行器。

- ShedLock：`lockAtMostFor` 必须大于任务正常耗时；Quartz 集群靠 `QRTZ_LOCKS` 行锁
- XXL-JOB 2.1.0 起自研调度：`xxl_job_lock` 行锁保证同一时刻只有一个调度实例扫描到期任务，再用时间轮触发；3.x 要求 JDK 17+
- 大任务用分片广播：执行器拿到 `shardIndex` / `shardTotal`，只处理 `id % total = index` 的数据
- 重试、故障转移、人工重跑都会重复处理，任务本身必须幂等

→ 详见 [分布式调度](/distributed/6_job_scheduler#一、多实例下的定时任务问题)

### Q26：分布式 Session 有哪些方案？Spring Session 和 JWT 怎么选？

**一句话**：主流是集中存储（Spring Session + Redis），所有实例共享会话、可随时失效；JWT 无状态、适合移动端和开放 API，但签发后难以主动失效。

| 维度 | Spring Session + Redis | JWT |
|------|------------------------|-----|
| 状态存放 | Redis | 客户端 |
| 主动失效 / 踢人 | 支持 | 需要黑名单或版本号 |
| 每次请求开销 | 一次 Redis 访问 | 验签 |

- 粘性会话在实例宕机时丢会话，会话复制随实例数膨胀，都不适合规模化
- Spring Boot 4 用 `spring-boot-starter-session-data-redis`，配置前缀 `spring.session.data.redis.*`；自己加 `@EnableRedisHttpSession` 会关掉自动配置
- JWT 常用短期 Access Token + 可吊销的 Refresh Token；浏览器里放 HttpOnly Cookie，不放 `localStorage`

→ 详见 [分布式会话](/distributed/5_session#四、方案对比)、[JWT 令牌机制](/security/1_jwt)

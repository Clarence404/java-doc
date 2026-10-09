---
description: CAP / BASE、共识算法、分布式锁、分布式事务、分布式 ID
---

# 分布式面试题解答

> 精华提炼，细节详见 [distributed/](../distributed/2_theorem)

## 一、CAP 理论是什么？为什么分布式系统只能选 CP 或 AP？

**CAP 三要素**：
- **C（Consistency）一致性**：所有节点在同一时刻看到相同的数据
- **A（Availability）可用性**：每个请求都能收到响应（不管数据是否最新）
- **P（Partition Tolerance）分区容忍性**：网络分区时系统仍能继续运行

**为什么 P 不可放弃**：分布式系统节点之间通过网络通信，网络故障是常态，不容忍分区就意味着放弃分布式，退化为单机。所以 P 是必选项，只能在 C 和 A 之间权衡。

**常见中间件的选择**：

| 中间件 | 选择 | 原因 |
|--------|------|------|
| Zookeeper | CP | 选主期间停止服务，保证数据一致 |
| Eureka | AP | 节点故障时仍可用，允许数据短暂不一致 |
| Nacos | 可切换（默认 AP）| 注册中心用 AP，配置中心用 CP |
| Redis Cluster | AP | 主从切换期间可能读到旧数据 |

## 二、BASE 理论是什么？和 ACID 有什么区别？

**BASE**：
- **BA（Basically Available）基本可用**：出现故障时，允许损失部分可用性（如响应时间延长、降级）
- **S（Soft State）软状态**：允许数据在同步过程中存在中间状态
- **E（Eventually Consistent）最终一致性**：数据最终会达到一致，但不保证实时

**ACID vs BASE**：

| | ACID | BASE |
|--|------|------|
| 一致性 | 强一致 | 最终一致 |
| 适用场景 | 单机事务、金融核心 | 分布式系统、互联网业务 |
| 性能 | 较低（锁+同步）| 较高（异步+解耦）|
| 典型实现 | MySQL 事务 | 分布式事务（Saga、消息最终一致）|

## 三、分布式锁有哪些实现方式？各有什么优缺点？

更多详情见：<RouteLink to="/distributed/3_lock">分布式-分布式锁</RouteLink>

| 实现方式 | 原理 | 优点 | 缺点 |
|---------|------|------|------|
| **Redis（推荐）** | `SET key value NX PX ttl` + Lua 原子释放 | 性能高，使用简单 | 主从切换可能丢锁 |
| **Redisson** | Redis 锁 + 看门狗自动续期 | 解决锁过期问题，支持重入 | 依赖 Redis |
| **ZooKeeper** | 临时顺序节点 + Watch 机制 | 天然公平锁，不会丢锁 | 性能低于 Redis，依赖 ZK |
| **数据库** | 唯一索引 / select for update | 无额外依赖 | 性能差，有死锁风险 |

**Redis 锁的常见坑**：
1. **锁过期业务未完成**：用 Redisson 看门狗自动续期解决
2. **主从切换丢锁**：主节点未同步就宕机，Redlock（5 节点多数派）解决，但有争议
3. **误删他人的锁**：释放时用 Lua 脚本原子校验 value 是否是自己的

```lua
-- 释放锁：先判断是否是自己持有的锁，再删除（原子操作）
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

## 四、分布式事务有哪些解决方案？

更多详情见：<RouteLink to="/distributed/4_transaction">分布式-分布式事务</RouteLink>

| 方案 | 原理 | 一致性 | 侵入性 | 适用场景 |
|------|------|-------|-------|---------|
| **2PC** | 协调者 + 两阶段提交 | 强一致 | 低 | 跨库事务，性能差，有阻塞问题 |
| **TCC** | Try-Confirm-Cancel 业务补偿 | 强一致 | 高 | 金融、资金类强一致场景 |
| **Saga** | 长事务拆分 + 补偿事务 | 最终一致 | 中 | 长流程业务（订单、出行）|
| **本地消息表** | 业务 DB + 消息表同库事务 | 最终一致 | 中 | 跨服务数据同步 |
| **RocketMQ 事务消息** | 半消息 + 本地事务 + 回查 | 最终一致 | 低 | 跨服务异步场景 |
| **Seata AT** | 自动生成 undo log 回滚 | 最终一致 | 低 | 快速接入，非极端场景 |

**如何选择**：对账严格（金融）用 TCC；长流程业务用 Saga；快速接入用 Seata AT；异步解耦用消息最终一致。

## 五、分布式 ID 有哪些生成方案？

更多详情见：<RouteLink to="/distributed/8_id_generator">分布式-分布式ID</RouteLink>

| 方案 | 优点 | 缺点 |
|------|------|------|
| UUID | 简单，无需中心 | 无序，索引性能差，太长（36字符）|
| 数据库自增 | 简单，有序 | 单点、性能瓶颈，步长分配方案可水平扩展 |
| **Snowflake** | 趋势递增，高性能，无中心 | 依赖时钟，时钟回拨会产生重复 ID |
| 数据库号段 | 批量申请，性能好 | 重启时会浪费号段 |
| Redis INCR | 简单高效 | 依赖 Redis 高可用 |
| Leaf（美团）| 号段 + Snowflake 双模式，ZK 分配 workerID | 生产级可用，解决时钟问题 |

**Snowflake 64 位结构**：1位符号位 + 41位时间戳（ms）+ 10位机器ID + 12位序列号，同一毫秒可生成 4096 个 ID。

## 六、一致性哈希是什么？解决了什么问题？

更多详情见：<RouteLink to="/distributed/9_consistent_hashing">分布式-一致性哈希</RouteLink>

**普通取模哈希的问题**：节点数从 N 变为 N+1 时，几乎所有 key 都需要重新映射，缓存全部失效（缓存雪崩）。

**一致性哈希**：将节点和 key 都映射到一个 0~2³² 的哈希环上，key 顺时针找到的第一个节点就是它的归属节点。增减节点时只影响相邻的一小段 key。

**虚拟节点**：每个真实节点映射为多个虚拟节点，均匀分布在哈希环上，避免数据倾斜。

```java
// 虚拟节点实现（TreeMap 模拟哈希环）
TreeMap<Integer, String> ring = new TreeMap<>();
for (String node : realNodes)
    for (int i = 0; i < 150; i++)  // 每个真实节点 150 个虚拟节点
        ring.put(hash(node + "#" + i), node);

public String getNode(String key) {
    Map.Entry<Integer, String> entry = ring.ceilingEntry(hash(key));
    return (entry == null ? ring.firstEntry() : entry).getValue();
}
```

**应用**：Redis Cluster（16384 个 slot 分配给节点）、Nginx upstream、Kafka producer 分区路由。

## 七、Raft 和 Paxos 有什么区别？

| | Paxos | Raft |
|--|-------|------|
| 理解难度 | 非常复杂，仅描述核心协议 | 设计目标就是易理解 |
| 角色 | Proposer / Acceptor / Learner | Leader / Follower / Candidate |
| Leader | 无固定 Leader，任何节点都可提议 | 强 Leader，所有写请求走 Leader |
| 日志 | 可以乱序提交 | 严格顺序，Leader 日志即权威 |
| 应用 | Chubby（Google）、早期 ZK | etcd、TiKV、CockroachDB、Kafka KRaft |

**Raft Leader 选举**：节点启动后超时（150~300ms 随机）未收到 Leader 心跳，转为 Candidate 发起投票，获得多数票成为 Leader，任期（term）+1。

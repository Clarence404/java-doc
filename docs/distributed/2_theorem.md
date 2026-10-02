---
description: CAP、BASE、Paxos、Raft、ZAB、Gossip、FLP
---

# 分布式理论

> 分布式系统的核心理论基础，理解这些原理是设计高可用、强一致系统的前提。

---

## 一、CAP 理论

### 1.1 三个性质

CAP 理论由 Eric Brewer 在 2000 年提出，指出分布式系统**无法同时满足**以下三个性质：

| 性质 | 全称 | 说明 |
|------|------|------|
| **C** | Consistency（一致性） | 所有节点在同一时刻看到的数据相同（强一致） |
| **A** | Availability（可用性） | 每个请求都能收到响应（不保证是最新数据） |
| **P** | Partition Tolerance（分区容错） | 网络分区时系统仍能继续运行 |

### 1.2 为什么只能三选二？

网络分区（P）在分布式系统中**不可避免**（网络故障、机房断联都会发生），所以 P 必须保留。实际上只能在 C 和 A 之间做取舍：

**CP 系统（保一致，牺牲可用性）：**
网络分区时，拒绝服务（返回错误），直到各节点数据同步一致。
> 典型：ZooKeeper、etcd、HBase

**AP 系统（保可用，牺牲一致性）：**
网络分区时，继续提供服务，但各节点数据可能不一致，最终一致即可。
> 典型：Cassandra、CouchDB、Eureka、DynamoDB

### 1.3 常见中间件的 CAP 定位

| 中间件 | 定位 | 说明 |
|--------|------|------|
| ZooKeeper | CP | 选举期间不可用，保证强一致 |
| etcd | CP | 基于 Raft，过半节点存活才提供服务 |
| Eureka | AP | 节点故障时其他节点仍提供服务，数据可能短暂不一致 |
| Nacos | CP/AP 可切换 | 服务注册默认 AP，配置中心默认 CP |
| Cassandra | AP | 可调一致性级别（Quorum 可近似 CP） |
| Redis Cluster | AP | 主节点宕机切换期间可能丢数据 |
| MySQL 主从 | CP（同步复制）/ AP（异步复制）| 视配置而定 |

---

## 二、BASE 理论

### 2.1 三个概念

BASE 是 CAP 中 AP 路线的延伸，由 eBay 架构师 Dan Pritchett 提出，是对强一致性的妥协：

| 概念 | 全称 | 说明 |
|------|------|------|
| **BA** | Basically Available（基本可用） | 允许损失部分可用性（延迟增加、降级服务），核心功能仍可用 |
| **S** | Soft State（软状态） | 允许系统中存在中间状态，不同节点数据可以短暂不一致 |
| **E** | Eventually Consistent（最终一致性） | 经过一段时间同步后，所有节点数据最终达到一致 |

### 2.2 最终一致性的实现模式

| 模式 | 说明 |
|------|------|
| 读时修复 | 读操作发现数据不一致时触发修复（Cassandra Read Repair） |
| 写时修复 | 写操作时检测并修复过期副本 |
| 异步修复 | 后台任务定期比对并同步数据（Anti-entropy） |
| 因果一致性 | 保证有因果关系的操作顺序一致（不相关操作可乱序） |
| 会话一致性 | 同一会话内保证读自己写（Read Your Writes） |

### 2.3 ACID vs BASE

| | ACID（关系型数据库） | BASE（分布式系统） |
|---|---|---|
| 一致性 | 强一致 | 最终一致 |
| 隔离性 | 严格隔离 | 弱隔离 |
| 可用性 | 优先一致 | 优先可用 |
| 适用场景 | 金融、交易 | 互联网、高并发 |

---

## 三、Paxos 算法

### 3.1 解决的问题

在**可能发生节点故障和消息丢失**的分布式系统中，如何让多个节点就某个值达成一致（共识）？

Paxos 由 Leslie Lamport 在 1989 年提出（2001 年正式发表），是分布式共识的理论奠基算法。

**FLP 不可能定理**：在异步网络中，即使只有一个节点故障，分布式系统也无法在有限时间内达成一致性。现实系统通过引入超时（Timeout）绕过这一限制。

### 3.2 角色

| 角色 | 说明 |
|------|------|
| Proposer（提议者） | 提出提案（Proposal），请求 Acceptor 接受 |
| Acceptor（接受者） | 对提案进行投票，过半接受则达成共识 |
| Learner（学习者） | 学习已达成共识的值（不参与投票） |

### 3.3 两阶段流程（Basic Paxos）

**Phase 1 — Prepare（准备）：**
```
1. Proposer 生成全局唯一递增编号 n，广播 Prepare(n) 给所有 Acceptor
2. Acceptor 收到 Prepare(n)：
   - 若 n 大于已承诺的最大编号 → 回复 Promise(n, 已接受的最大提案)
   - 否则 → 拒绝
```

**Phase 2 — Accept（接受）：**
```
3. Proposer 收到过半 Promise 后，广播 Accept(n, value)
   - value 取所有 Promise 中编号最大的提案值（若都为空则自由选择）
4. Acceptor 收到 Accept(n, value)：
   - 若 n ≥ 已承诺的最大编号 → 接受，回复 Accepted
5. 过半 Acceptor 接受 → 共识达成，Learner 学习该值
```

### 3.4 局限性

- **活锁问题**：两个 Proposer 互相抢占，导致无限循环无法达成共识
- **Multi-Paxos**：Basic Paxos 每次决策都需要两轮通信，效率低；Multi-Paxos 引入 Leader 角色，稳定期只需一轮
- **实现复杂**：Lamport 自己也承认论文非常难理解，工程实现极难

> 实际工程中几乎不直接使用 Paxos，而是使用更易理解和实现的 **Raft**。Raft 本质上是 Multi-Paxos 的工程化简化版本。

---

## 四、Raft 算法

### 4.1 设计目标

Raft 由 Diego Ongaro 和 John Ousterhout 在 2014 年提出，核心目标是"**比 Paxos 更易理解**"。将共识问题分解为三个相对独立的子问题：
1. **Leader 选举**
2. **日志复制**
3. **安全性保证**

### 4.2 角色

| 角色 | 说明 |
|------|------|
| Leader（领导者） | 同一时刻只有一个，处理所有客户端请求，负责日志复制 |
| Follower（跟随者） | 被动接受 Leader 的日志，参与投票 |
| Candidate（候选人） | 选举期间的临时状态，竞选 Leader |

### 4.3 任期（Term）

Raft 用**单调递增的任期（Term）**标识不同的领导时期，相当于逻辑时钟：

```
Term 1: Leader A 正常工作
Term 2: A 宕机，选举产生 Leader B
Term 3: B 宕机，选举产生 Leader C
...
```

节点看到更大的 Term 会立即更新自己的 Term，过时 Leader 收到更大 Term 后自动退位为 Follower。

### 4.4 Leader 选举

**触发条件**：Follower 在 **Election Timeout**（随机 150ms～300ms）内未收到 Leader 心跳。

**选举流程：**
```
1. Follower 超时 → 转为 Candidate，Term+1
2. Candidate 投票给自己，广播 RequestVote(term, lastLogIndex, lastLogTerm)
3. 其他节点收到投票请求：
   - 本 Term 未投过票 且 Candidate 的日志不落后于自己 → 投票
4. Candidate 获得过半票 → 成为 Leader，立即广播心跳宣示主权
5. 若出现平票 → 等待随机超时后重新选举（随机超时减少平票概率）
```

### 4.5 日志复制

**正常流程：**
```
1. 客户端请求到达 Leader
2. Leader 将请求追加到本地日志（未提交状态）
3. Leader 并行发送 AppendEntries RPC 给所有 Follower
4. 过半 Follower 确认写入 → Leader 提交（commit）日志
5. Leader 通知 Follower 提交，返回结果给客户端
```

**日志一致性保证：**
- Leader 永远不会覆盖自己的日志，只追加
- 若两个日志在相同 index 和 term 上的 entry 相同，则该 index 之前的所有 entry 也相同（Raft 日志匹配性质）
- Leader 当选后，会强制 Follower 的日志与自己一致（以 Leader 为准）

### 4.6 安全性

**选举限制**：只有日志比过半节点更"新"（lastLogTerm 更大，或 term 相同但 index 更大）的 Candidate 才能当选，保证新 Leader 包含所有已提交的日志。

**提交限制**：Leader 只能提交自己任期内的日志（通过当前任期日志的提交来间接提交之前任期的日志），避免已提交的日志被覆盖。

**脑裂保护**：Raft 选举和日志提交都需要多数（Quorum），网络分区时少数派无法完成选举和写入，多数派继续工作。

### 4.7 实际应用

| 系统 | 说明 |
|------|------|
| etcd | 使用 Raft，Kubernetes 元数据存储核心 |
| CockroachDB | 分布式 SQL 数据库，Raft 保证副本一致 |
| TiKV | PingCAP 开源，TiDB 底层存储，Multi-Raft |
| Consul | 服务发现与配置，Raft 实现强一致 |
| Kafka（KRaft 模式）| Kafka 2.8+ 用 KRaft 替代 ZooKeeper 依赖 |

---

## 五、ZAB（ZooKeeper Atomic Broadcast）

ZAB 是 ZooKeeper 专用的原子广播协议，用于保证 ZooKeeper 集群数据的强一致性。

### 5.1 ZAB vs Raft

| 对比 | Raft | ZAB |
|------|------|-----|
| 应用系统 | etcd、Kafka KRaft、TiKV、Consul | ZooKeeper |
| 核心概念 | Term + Log Index | Epoch + ZXID（事务ID）|
| Leader 选举 | 基于日志完整性的投票 | 基于 ZXID 大小（最大 ZXID 优先）|
| 日志提交 | 过半 Follower ACK | 过半 Follower ACK |
| 崩溃恢复 | Leader 重新选举后同步日志 | 恢复模式（Recovery）+ 同步模式（Sync）|
| 工程友好性 | 更简洁，易理解 | 与 ZooKeeper 数据模型强耦合 |

### 5.2 ZXID 结构

```
ZXID（64位）= Epoch（高32位）+ Counter（低32位）
```

Epoch 相当于 Raft 的 Term；Counter 是该 Epoch 内的事务计数器。ZXID 最大的节点在选举中优先成为 Leader。

---

## 六、Gossip 协议

### 6.1 解决的问题

在大规模节点集群（数百至数千节点）中，如何高效地让信息传播到所有节点？

如果用 Leader 广播：Leader 压力大，且 Leader 故障就停了。
Gossip（流言/八卦协议）模仿流言传播：**每个节点周期性随机选几个邻居同步信息，像病毒一样扩散**。

### 6.2 传播方式

| 方式 | 说明 |
|------|------|
| Push | 节点 A 主动把信息推给随机节点 B |
| Pull | 节点 A 询问随机节点 B 有无新信息，拉取差异 |
| Push-Pull | A 推给 B 的同时，B 也把 A 没有的信息推回来（最高效） |

### 6.3 特性

| 特性 | 说明 |
|------|------|
| 最终一致性 | 不保证强一致，信息扩散有延迟 |
| 去中心化 | 无 Leader，任意节点故障不影响整体传播 |
| 容错性强 | 消息会多路冗余传播，即使部分节点宕机也能扩散 |
| 扩展性好 | 传播时间复杂度 O(log N)，适合大规模集群 |
| 带宽消耗 | 冗余消息较多，同步已知信息产生浪费 |

### 6.4 收敛时间

假设集群有 N 个节点，每轮每个节点随机选 K 个邻居同步，理论收敛轮数约为：

```
收敛轮数 ≈ log(N) / log(K)
```

N=1000，K=3 时，约 7 轮即可全网同步。

### 6.5 Anti-Entropy（反熵）

Gossip 的常见变体：每轮节点互相比对状态摘要（如 Merkle Tree 哈希），只传输差异部分，用于数据同步而非仅消息广播。Cassandra 的跨节点数据修复用的就是 Anti-Entropy。

### 6.6 实际应用

| 系统 | 用途 |
|------|------|
| Cassandra | 节点状态（存活/宕机）传播、Token 环信息同步 |
| Redis Cluster | 节点间心跳、槽位信息传播 |
| Consul | 成员关系管理（基于 SWIM 协议，Gossip 变种） |
| Eureka | 注册表在多个 Eureka Server 间同步 |
| Amazon DynamoDB | 内部使用 Gossip 传播成员状态 |

---

## 七、理论总结

| 理论 | 核心思想 | 工程价值 |
|------|---------|---------|
| CAP | 分布式系统 C/A/P 三选二 | 指导中间件选型（CP vs AP） |
| BASE | AP 系统的设计原则，最终一致 | 互联网高并发系统的设计范式 |
| Paxos | 分布式共识的理论基础 | 理解 Raft 的前提 |
| Raft | 可理解的共识算法 | etcd/TiKV/Consul 等的实现基础 |
| ZAB | ZooKeeper 专用原子广播 | ZooKeeper 强一致的基础 |
| Gossip | 去中心化信息扩散 | 大规模集群状态同步的高效方案 |

### 协议对比

| 协议 | 一致性强度 | 核心思想 | 主要应用 | 是否需要 Leader |
|------|-----------|---------|---------|----------------|
| Raft | 强一致（线性化）| 日志复制 + 多数投票 | etcd、Kafka KRaft | ✅ |
| ZAB | 强一致 | 原子广播 + ZXID 顺序 | ZooKeeper | ✅ |
| Paxos | 强一致 | 两阶段提案 | Chubby（Google）| 可选（Multi-Paxos 有 Leader）|
| Gossip | 最终一致 | 随机传播 | Cassandra、Consul | ❌ |

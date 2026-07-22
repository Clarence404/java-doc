# 分布式协议

> 官方规范：[Raft 论文](https://raft.github.io/raft.pdf) / [Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf) / [ZooKeeper ZAB](https://zookeeper.apache.org/doc/current/zookeeperInternals.html)

---

## 一、分布式一致性问题

分布式系统中多个节点需要对某个值（状态）达成一致，面临三个核心挑战：

```
节点 A  ─┐
节点 B  ─┤── 网络（可能丢包/延迟/分区）── 如何达成一致？
节点 C  ─┘
```

**FLP 不可能定理**：在异步网络中，即使只有一个节点故障，分布式系统也无法在有限时间内达成一致性。现实系统通过引入超时（Timeout）绕过这一限制。

---

## 二、Raft

Raft 是目前工程中最广泛采用的分布式一致性协议，etcd、Kafka KRaft、TiKV 均基于 Raft 实现。核心设计目标：**可理解性**。

### 三种角色

```
Leader（领导者）：处理所有客户端写入，并向 Followers 复制日志
Follower（跟随者）：被动接收 Leader 的日志复制
Candidate（候选者）：Leader 失效时，Follower 转为 Candidate 发起选举
```

### Leader 选举流程

```
① 初始状态：所有节点均为 Follower
② Follower 超时未收到 Leader 心跳 → 转为 Candidate
③ Candidate 递增 term，向其他节点发送 RequestVote RPC
④ 节点投票规则：
   - 每个 term 只投一票（先到先得）
   - 只投给日志至少和自己一样新的 Candidate（日志完整性保证）
⑤ Candidate 获得多数票（n/2+1）→ 成为新 Leader
⑥ 新 Leader 开始发送心跳，其他节点转回 Follower
```

**脑裂保护**：Raft 选举和日志提交都需要多数（Quorum），网络分区时少数派无法完成选举和写入，多数派继续工作。

### 日志复制流程

```
① 客户端向 Leader 写入：Leader 将日志追加到本地（未提交）
② Leader 并发向所有 Followers 发送 AppendEntries RPC
③ 多数 Followers 写入成功 → Leader 将日志标记为已提交（Commit）
④ Leader 在下次心跳中通知 Followers 提交，Followers 应用到状态机
```

### 任期（Term）

```
Term 1          Term 2        Term 3
[Leader A]─────►[选举]──────►[Leader B]─────►...
```

Term 是单调递增的逻辑时钟，每次选举产生新 Term。节点看到更高 Term 的消息时立即更新自己的 Term 并转为 Follower，防止旧 Leader 的消息干扰。

---

## 三、ZAB（ZooKeeper Atomic Broadcast）

ZAB 是 ZooKeeper 专用的原子广播协议，用于保证 ZooKeeper 集群数据的强一致性。

### ZAB vs Raft

| 对比 | Raft | ZAB |
|------|------|-----|
| 应用系统 | etcd、Kafka KRaft、TiKV、Consul | ZooKeeper |
| 核心概念 | Term + Log Index | Epoch + ZXID（事务ID）|
| Leader 选举 | 基于日志完整性的投票 | 基于 ZXID 大小（最大 ZXID 优先）|
| 日志提交 | 过半 Follower ACK | 过半 Follower ACK |
| 崩溃恢复 | Leader 重新选举后同步日志 | 恢复模式（Recovery）+ 同步模式（Sync）|
| 工程友好性 | 更简洁，易理解 | 与 ZooKeeper 数据模型强耦合 |

### ZXID 结构

```
ZXID（64位）= Epoch（高32位）+ Counter（低32位）
```

Epoch 相当于 Raft 的 Term；Counter 是该 Epoch 内的事务计数器。ZXID 最大的节点在选举中优先成为 Leader。

---

## 四、Paxos

Paxos 是分布式一致性协议的理论基础，由 Lamport 于 1989 年提出，但以**难以理解**著称。

### Basic Paxos 两阶段

```
Phase 1 - Prepare：
  Proposer → Acceptors: Prepare(n)   [n 为提案编号]
  Acceptor → Proposer: Promise(n, 已接受的最大编号和值)

Phase 2 - Accept：
  Proposer → Acceptors: Accept(n, v)  [v 取 Promise 中最大编号对应的值，若无则自选]
  Acceptor → Proposer: Accepted(n, v) [若 n >= 已承诺的编号则接受]
  多数 Accepted → 该值被选定
```

**问题**：Basic Paxos 只能决定单个值，Multi-Paxos 将 Prepare 阶段优化为 Leader 独占，减少轮次，但实现复杂。Raft 本质上是 Multi-Paxos 的工程化简化版本。

---

## 五、Gossip 协议

Gossip（流言蜚语）是一种去中心化的信息传播协议，节点随机选择部分邻居互传消息，像流言一样扩散到整个集群。

```
节点 A 知道信息 X
A → 随机选择 B, D 传播 X
B → 随机选择 A, C, E 传播 X
D → 随机选择 A, F 传播 X
...最终所有节点都知道 X
```

| 特性 | 说明 |
|------|------|
| **去中心化** | 无需 Leader，节点对等 |
| **最终一致** | 不保证强一致，信息最终扩散到全部节点 |
| **容错性强** | 节点宕机不影响协议运行 |
| **收敛速度** | O(log N) 轮次收敛（N 为节点数）|
| **带宽消耗** | 存在冗余传播，不适合高频大数据量 |
| **应用** | Cassandra（成员管理）、Consul（健康检测）、Redis Cluster（MEET 消息）|

### Anti-Entropy（反熵）

Gossip 的常见变体：每轮节点互相比对状态摘要（如 Merkle Tree 哈希），只传输差异部分，用于数据同步而非仅消息广播。Cassandra 的跨节点数据修复用的就是 Anti-Entropy。

---

## 六、协议对比总结

| 协议 | 一致性强度 | 核心思想 | 主要应用 | 是否需要 Leader |
|------|-----------|---------|---------|----------------|
| Raft | 强一致（线性化）| 日志复制 + 多数投票 | etcd、Kafka KRaft | ✅ |
| ZAB | 强一致 | 原子广播 + ZXID 顺序 | ZooKeeper | ✅ |
| Paxos | 强一致 | 两阶段提案 | Chubby（Google）| 可选（Multi-Paxos 有 Leader）|
| Gossip | 最终一致 | 随机传播 | Cassandra、Consul | ❌ |

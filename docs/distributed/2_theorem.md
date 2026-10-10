---
description: CAP 与 PACELC、BASE、一致性模型、Quorum、FLP、Paxos、Raft、ZAB、Gossip
---

# 分布式理论

> 前置阅读：[分布式架构](./1_distributed)

分布式理论描述多节点系统在一致性、可用性与延迟之间的取舍。本篇讲 CAP 与 PACELC、各种一致性模型、Paxos / Raft / ZAB 的核心流程与 Gossip，并用它们判断常见中间件的一致性行为。

---

## 一、CAP 与 PACELC

### 1、CAP 到底说了什么

CAP 由 Eric Brewer 在 2000 年提出猜想，2002 年由 Gilbert 和 Lynch 证明。三个性质的严格含义：

| 性质 | 含义 |
|------|------|
| **C**（Consistency） | 线性一致性（Linearizability）：所有操作看起来像在单副本上按某个全局顺序瞬时完成，读一定能读到最近一次已完成的写 |
| **A**（Availability） | 每个发往**未故障节点**的请求都能在有限时间内得到非错误响应 |
| **P**（Partition Tolerance） | 节点之间消息可能任意丢失（网络分区）时，系统仍按约定工作 |

定理的结论是：**发生网络分区时，只能在 C 和 A 之间选一个**。这不是「三选二」：

- 分布式系统无法排除分区，所以 P 不是可选项
- 没有分区时，系统完全可以同时提供 C 和 A
- CP / AP 描述的是分区期间的行为：CP 系统让少数派一侧拒绝服务，AP 系统让各侧继续服务、事后合并

### 2、PACELC：没有分区时也在取舍

Daniel Abadi 在 2010 年提出 PACELC：**分区时（P）在可用性（A）与一致性（C）之间选；否则（E）在延迟（L）与一致性（C）之间选**。它更贴近日常：大部分时间没有分区，真正的取舍是「同步复制到多数派再返回（一致但慢）」还是「本地写完就返回（快但可能读到旧值）」。

| 系统 | 分区时 | 正常时 | 说明 |
|------|--------|--------|------|
| etcd / ZooKeeper / Consul（KV） | PC | EC | 写入走多数派共识 |
| Cassandra | PA | EL | 一致性级别可按请求调（ONE / QUORUM / ALL） |
| MySQL 异步复制 | PA | EL | 主库提交即返回，从库可能落后 |
| MySQL Group Replication | PC | EC | 基于 Paxos 变体，多数派认证后提交 |

### 3、常见中间件的一致性定位

| 中间件 | 定位 | 说明 |
|--------|------|------|
| ZooKeeper | CP | 写是线性一致的；读默认是顺序一致，跟随者可能返回旧数据，需要最新值时先调用 `sync()` |
| etcd | CP | Raft，默认读也是线性一致的（经 ReadIndex），可选 serializable 读换取低延迟 |
| Eureka | AP | Server 之间点对点 HTTP 复制注册表，有自我保护模式 |
| Nacos 注册中心 | 按实例类型 | 临时实例（默认 `ephemeral=true`）走 Distro 协议，AP；持久实例走 JRaft，CP |
| Nacos 配置中心 | 依赖存储 | 配置存在外部 MySQL；集群内嵌模式下用 Derby + Raft |
| Redis Cluster | 偏 AP | 主从异步复制，故障切换时可能丢失已确认的写 |
| MySQL 主从 | 视复制模式 | 异步复制与半同步复制都不保证线性一致，半同步超时（`rpl_semi_sync_source_timeout`）后会退化为异步；只有 Group Replication / InnoDB Cluster 提供多数派共识 |

---

## 二、BASE 与一致性模型

### 1、BASE

BASE 由 eBay 的 Dan Pritchett 在 2008 年系统阐述，是 AP 路线的工程原则：

| 概念 | 含义 |
|------|------|
| **BA**（Basically Available） | 出故障时允许损失部分功能或性能（降级、限流），核心功能可用 |
| **S**（Soft State） | 允许存在中间状态，副本之间短暂不一致 |
| **E**（Eventually Consistent） | 没有新写入时，所有副本最终收敛到相同值 |

ACID 与 BASE 不是二选一：一个系统里，单个服务内部用数据库 ACID 事务，跨服务用 BASE 的最终一致（见 [分布式事务](./4_transaction)）。

### 2、一致性模型（从强到弱）

| 模型 | 保证 | 典型实现 |
|------|------|----------|
| 线性一致（Linearizable） | 存在全局实时顺序，读一定看到最新完成的写 | etcd 默认读、Raft ReadIndex |
| 顺序一致（Sequential） | 所有节点看到相同的操作顺序，但不保证与真实时间一致 | ZooKeeper 读 |
| 因果一致（Causal） | 有因果关系的操作按因果顺序可见，无关操作可乱序 | MongoDB 因果一致会话 |
| 会话一致（读己之写、单调读） | 同一客户端会话内能读到自己的写、读到的版本不回退 | 读写分离时「写后读主库」 |
| 最终一致（Eventual） | 停止写入后最终收敛 | DNS、异步复制、缓存 |

### 3、最终一致的实现机制

| 机制 | 做法 |
|------|------|
| 读修复（Read Repair） | 读多个副本发现版本不一致时，用新值修复旧副本 |
| 提示移交（Hinted Handoff） | 目标副本不可用时，由其他节点暂存写入，恢复后再转交 |
| 反熵（Anti-Entropy） | 后台用 Merkle Tree 比对副本差异，只同步不同的部分 |
| Quorum NWR | 见下一节，通过读写副本数的重叠保证读到最新写 |

### 4、Quorum NWR

N 为副本数，W 为写成功需要的副本数，R 为读需要的副本数：

- **W + R > N**：读集合与写集合必然有交集，读能看到最新写（还需要版本号或时间戳挑出最新值）
- **W > N / 2**：两个并发写不可能同时成功，避免写冲突
- 常见取值 N=3、W=2、R=2；要写快就降低 W、读快就降低 R

Cassandra 的 `QUORUM` 一致性级别就是这个思路。注意 Quorum 本身不等于线性一致，节点故障与读修复时机仍可能产生异常读，需要共识协议才能严格保证。

---

## 三、FLP 不可能定理

Fischer、Lynch、Paterson 在 1985 年证明：**在完全异步的系统中，只要有一个进程可能崩溃，就不存在总能在有限时间内终止的确定性共识算法**。

它并不是说共识做不了，而是说「安全性」和「一定能结束」不能在纯异步模型下同时保证。工程上的绕法：

- **部分同步假设**：网络大部分时间延迟有上限，用超时检测故障、触发选举（Paxos、Raft 都是这样，只在网络稳定时保证进展）
- **随机化**：引入随机数打破对称，以概率 1 终止（如 Raft 的随机选举超时）

所有共识算法的共同选择是：**任何时候都不违反安全性，活性（进展）只在网络足够稳定时保证**。

---

## 四、Paxos

### 1、解决的问题与历史

在节点可能崩溃、消息可能丢失或延迟的前提下，让多个节点就**一个值**达成一致。Leslie Lamport 在 1989 年前后写成《The Part-Time Parliament》，1998 年发表于 ACM TOCS；2001 年的《Paxos Made Simple》是通俗重述。

### 2、角色

| 角色 | 职责 |
|------|------|
| Proposer | 提出提案（编号 n，值 v） |
| Acceptor | 对提案投票，多数派接受即达成共识 |
| Learner | 学习已选定的值，不参与投票 |

### 3、Basic Paxos 两阶段

阶段一：Prepare / Promise

1. Proposer 选一个全局唯一且递增的编号 n，向多数派 Acceptor 发送 `Prepare(n)`
2. Acceptor 若 n 大于它承诺过的最大编号，就承诺不再接受编号小于 n 的提案，并回复 `Promise(n, 已接受的最大编号提案)`；否则拒绝

阶段二：Accept / Accepted

1. Proposer 收到多数派的 Promise 后发送 `Accept(n, v)`；v 必须取这些回复中编号最大的已接受提案的值，都为空时才能用自己的值
2. Acceptor 若没有承诺过比 n 更大的编号，就接受该提案并回复 `Accepted`
3. 多数派接受后值被选定，Learner 学习该值

「v 必须沿用已接受的值」是安全性的关键：一旦某个值被多数派接受，之后任何提案都只能提出这个值。

### 4、局限与 Multi-Paxos

- **活锁**：两个 Proposer 交替用更大编号抢占，谁也走不到阶段二；用随机退避或选出唯一 Leader 解决
- **效率**：每个值两轮往返。Multi-Paxos 选出稳定 Leader 后可跳过阶段一，每条日志只需一轮
- **工程难度**：论文只描述单值共识，成员变更、日志压缩等都需要自行设计

实际落地多用 Raft，或 Paxos 变体（Google Chubby、MySQL Group Replication 使用的 XCom）。Raft 与 Multi-Paxos 在容错能力和性能上相当，它的设计目标是**更容易理解与正确实现**，而不是 Paxos 的简化版。

---

## 五、Raft

### 1、设计思路

Raft 由 Diego Ongaro 和 John Ousterhout 在 2014 年提出，把共识拆成三个子问题：**Leader 选举、日志复制、安全性**。所有写入都经过唯一的 Leader。

![Raft 节点状态转换](../assets/distributed/raft-states.svg)

### 2、任期（Term）

Term 是单调递增的整数，相当于逻辑时钟，每次选举开始一个新 Term。节点看到更大的 Term 会立即更新自己的 Term，Leader 或 Candidate 看到更大的 Term 会退回 Follower。

### 3、Leader 选举

1. Follower 在选举超时（随机值，论文建议 150～300ms）内没收到 Leader 心跳，转为 Candidate，Term 加一并投自己一票
2. 向其他节点发送 `RequestVote(term, lastLogIndex, lastLogTerm)`
3. 投票者在该 Term 内还没投过票，**且候选者的日志至少和自己一样新**时才投票。「新」的比较规则：先比 lastLogTerm，大者新；相同再比 lastLogIndex
4. 获得多数票即成为 Leader，立刻发送心跳
5. 平票则各自等待新的随机超时后重新选举

因为每个已提交的日志都在多数派上，而当选需要多数派投票，两个多数派必有交集，所以**新 Leader 一定包含所有已提交的日志**。

### 4、日志复制

1. Leader 把客户端命令追加到本地日志
2. 并行发送 `AppendEntries` 给所有 Follower，携带前一条日志的 index 和 term 做一致性检查
3. 多数派写入后，Leader 推进 commitIndex，应用到状态机并返回客户端
4. 后续的 `AppendEntries`（包括心跳）把 commitIndex 带给 Follower，Follower 再应用

日志匹配性质：两个日志在同一 index 上 term 相同，则该 index 之前的所有条目都相同。Follower 日志与 Leader 不一致时，Leader 回退 nextIndex 找到分叉点，用自己的日志覆盖 Follower 的多余条目。

### 5、安全性要点

- **提交限制**：Leader 只通过「当前任期的日志达到多数派」来提交日志，之前任期的日志随之间接提交，避免已复制到多数派的旧日志被覆盖
- **脑裂保护**：选举和提交都需要多数派，分区时少数派一侧选不出 Leader、也提交不了写入；旧 Leader 发现更大 Term 后退位

### 6、线性一致读

直接读 Leader 本地状态并不安全：它可能已被新 Leader 取代而不自知。两种做法：

- **ReadIndex**：记录当前 commitIndex，向多数派发一轮心跳确认自己仍是 Leader，等状态机应用到该 index 后再读
- **Lease Read**：依赖时钟，在租约内省去心跳，延迟更低，但时钟漂移过大时不安全

### 7、实际应用

| 系统 | 说明 |
|------|------|
| etcd | Kubernetes 元数据存储 |
| TiKV / CockroachDB | 按数据分片运行多个 Raft 组（Multi-Raft） |
| Consul | 服务目录与 KV 存储 |
| Kafka KRaft | Kafka 3.3 起可用于生产，4.0（2025 年 3 月）移除 ZooKeeper 模式，只剩 KRaft |
| Nacos | 持久实例与内嵌配置存储使用 JRaft |

---

## 六、ZAB

ZAB（ZooKeeper Atomic Broadcast）是 ZooKeeper 专用的原子广播协议，与 Raft 思路相近：单 Leader、多数派确认、崩溃恢复。

### 1、ZXID

ZXID 是 64 位事务 ID：高 32 位是 epoch（每选出一个新 Leader 加一，相当于 Raft 的 Term），低 32 位是该 epoch 内的递增计数器。所有写入按 ZXID 全局有序。

### 2、选举与恢复

- **快速选举**（Fast Leader Election）按 (epoch, zxid, myid) 依次比较投票，拥有最新数据的节点胜出，相同时 myid 大者胜出
- 选出准 Leader 后依次经历三个阶段：**Discovery**（确定新 epoch、找到最新历史）→ **Synchronization**（让 Follower 与 Leader 历史一致）→ **Broadcast**（正常处理写请求）

### 3、与 Raft 对比

| 对比 | Raft | ZAB |
|------|------|-----|
| 逻辑时钟 | Term + Log Index | Epoch + ZXID |
| 选举依据 | 投票者只投给日志不比自己旧的候选者 | (epoch, zxid, myid) 最大者 |
| 提交 | 多数派写入后提交 | 多数派 ACK 后发送 COMMIT |
| 读 | 可通过 ReadIndex 做线性一致读 | 默认本地读，顺序一致，`sync()` 后读最新 |
| 应用 | etcd、Consul、TiKV、Kafka KRaft | ZooKeeper |

---

## 七、Gossip

### 1、思路

大规模集群（数百到数千节点）里，用中心节点广播状态会成为瓶颈。Gossip 让每个节点周期性地随机挑选少数节点交换信息，像流言一样扩散，没有中心节点。

| 方式 | 做法 |
|------|------|
| Push | 把自己的新信息推给随机节点 |
| Pull | 向随机节点索取对方有而自己没有的信息 |
| Push-Pull | 双向交换，收敛最快 |

### 2、特性

- **收敛快**：信息传遍全网需要 O(log N) 轮；粗略估算轮数约为 log(N) / log(K+1)（K 为每轮挑选的节点数），1000 个节点、K=3 时大约 5 轮
- **去中心、容错强**：任意节点故障不影响整体传播
- **最终一致**：有传播延迟，不适合需要强一致的数据
- **冗余流量**：会重复发送对方已知的信息，通常配合摘要比对减少开销

### 3、实际应用

| 系统 | 用途 |
|------|------|
| Cassandra | 节点存活状态与 token 分布传播 |
| Redis Cluster | 节点之间通过 Cluster Bus 交换心跳、槽位与故障判定信息 |
| Consul / Serf | 基于 SWIM 协议的成员管理与故障检测 |
| Amazon Dynamo（2007 年论文） | 成员关系与故障检测（这是论文中的设计，不等于 DynamoDB 服务的实现） |

---

## 小结

| 理论 | 一句话 | 工程价值 |
|------|--------|----------|
| CAP | 分区发生时只能在线性一致与可用之间选一个 | 判断中间件在故障期间的行为 |
| PACELC | 没有分区时也要在延迟与一致之间取舍 | 解释同步复制与异步复制的选择 |
| BASE | 允许中间状态，追求最终一致 | 跨服务业务的设计范式 |
| Quorum | W + R > N 保证读写重叠 | 可调一致性的基础 |
| FLP | 纯异步下共识无法保证终止 | 所有共识算法都靠超时或随机化保活性 |
| Paxos | 两阶段 + 沿用已接受的值 | 共识的理论基础 |
| Raft | 单 Leader + 日志复制 + 选举限制 | etcd、TiKV、KRaft 的实现基础 |
| ZAB | ZooKeeper 的原子广播 | 写线性一致，读默认顺序一致 |
| Gossip | 随机扩散，O(log N) 轮收敛 | 大规模集群的成员与状态传播 |

| 协议 | 一致性 | 是否需要 Leader | 主要应用 |
|------|--------|-----------------|----------|
| Paxos | 强一致 | Basic Paxos 不需要，Multi-Paxos 需要 | Chubby、MySQL Group Replication |
| Raft | 线性一致（配合 ReadIndex 读） | 需要 | etcd、TiKV、Kafka KRaft |
| ZAB | 写线性一致，读顺序一致 | 需要 | ZooKeeper |
| Gossip | 最终一致 | 不需要 | Cassandra、Redis Cluster、Consul |

## 参考资料

- Eric Brewer, Towards Robust Distributed Systems（PODC 2000 主题演讲）：[https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf)
- Gilbert & Lynch, Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services（2002）：[https://dl.acm.org/doi/10.1145/564585.564601](https://dl.acm.org/doi/10.1145/564585.564601)
- Eric Brewer, CAP Twelve Years Later（2012）：[https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/)
- Daniel Abadi, Consistency Tradeoffs in Modern Distributed Database System Design（PACELC，2012）：[https://doi.org/10.1109/MC.2012.33](https://doi.org/10.1109/MC.2012.33)
- Dan Pritchett, BASE: An Acid Alternative（ACM Queue 2008）：[https://queue.acm.org/detail.cfm?id=1394128](https://queue.acm.org/detail.cfm?id=1394128)
- Fischer, Lynch, Paterson, Impossibility of Distributed Consensus with One Faulty Process（1985）：[https://dl.acm.org/doi/10.1145/3149.214121](https://dl.acm.org/doi/10.1145/3149.214121)
- Leslie Lamport, Paxos Made Simple（2001）：[https://lamport.azurewebsites.net/pubs/paxos-simple.pdf](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)
- Raft 官网与论文：[https://raft.github.io/](https://raft.github.io/)
- ZooKeeper Internals（ZAB）：[https://zookeeper.apache.org/doc/current/zookeeperInternals.html](https://zookeeper.apache.org/doc/current/zookeeperInternals.html)
- Kafka KRaft 文档：[https://kafka.apache.org/documentation/#kraft](https://kafka.apache.org/documentation/#kraft)
- Nacos 临时实例与持久化实例：[https://nacos.io/docs/latest/manual/user/java-sdk/usage/](https://nacos.io/docs/latest/manual/user/java-sdk/usage/)

> 下一篇：[分布式锁](./3_lock) —— Redis、ZooKeeper、etcd 三种实现，租约过期与 Fencing Token，以及 Redlock 争议。

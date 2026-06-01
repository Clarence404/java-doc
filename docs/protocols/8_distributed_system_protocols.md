# 分布式协议

这些协议用于保证分布式系统中的一致性、可靠性和数据同步。

## 官方规范入口

| 协议 / 算法 | 原始资料 |
|-------------|----------|
| Raft | [Raft 官网](https://raft.github.io/) / [Raft 论文](https://raft.github.io/raft.pdf) |
| Paxos | [The Part-Time Parliament](https://lamport.azurewebsites.net/pubs/lamport-paxos.pdf) |
| Gossip / Epidemic | [Epidemic Algorithms for Replicated Database Maintenance](https://dl.acm.org/doi/10.1145/41840.41841) |
| SWIM | [SWIM Paper](https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf) |
| ZAB | [ZAB Paper](https://www.usenix.org/legacy/event/atc10/tech/full_papers/Hunt.pdf) |
| ZooKeeper | [Apache ZooKeeper Documentation](https://zookeeper.apache.org/doc/current/) |

- **Raft**：一致性协议，用于分布式系统的 Leader 选举和日志复制。
- **Paxos**：经典的一致性协议，应用于分布式数据库、Zookeeper 等。
- **Gossip Protocol**：用于分布式系统中节点信息传播，如 Cassandra、Consul 采用该协议。
- **ZAB（Zookeeper Atomic Broadcast）**：Zookeeper 使用的一致性协议，保证数据一致性和主从切换。

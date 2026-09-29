# 分布式协议

> 官方规范：[Raft 论文](https://raft.github.io/raft.pdf) / [Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf) / [ZooKeeper ZAB](https://zookeeper.apache.org/doc/current/zookeeperInternals.html)

分布式协议解决多个节点对同一状态达成一致或传播信息的问题，下表为速查，FLP、Raft 选举与日志复制、ZAB、Gossip 等原理详见 [分布式理论](/distributed/2_theorem)。

| 协议 | 一致性强度 | 核心思想 | 主要应用 | 是否需要 Leader |
|------|-----------|---------|---------|----------------|
| Raft | 强一致（线性化）| 日志复制 + 多数投票 | etcd、Kafka KRaft | ✅ |
| ZAB | 强一致 | 原子广播 + ZXID 顺序 | ZooKeeper | ✅ |
| Paxos | 强一致 | 两阶段提案 | Chubby（Google）| 可选（Multi-Paxos 有 Leader）|
| Gossip | 最终一致 | 随机传播 | Cassandra、Consul | ❌ |

> 详细内容：[分布式理论](/distributed/2_theorem)

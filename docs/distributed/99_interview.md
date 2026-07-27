# 面试高频题

> 汇总分布式系统核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/7_distributed">开发总结-分布式</RouteLink>

## 一、理论基础

- **CAP 理论是什么？为什么分布式系统只能选 CP 或 AP？**
- **BASE 理论是什么？和 ACID 有什么区别？**
- **Raft 和 Paxos 有什么区别？Raft 的 Leader 选举过程是什么？**
- **Gossip 协议的原理？适用于哪些场景？**

## 二、分布式锁

- **Redis 分布式锁的实现原理？如何保证原子释放？**
- **Redisson 看门狗机制是什么？如何解决锁过期问题？**
- **Redlock 算法是什么？有什么争议？**
- **ZooKeeper 分布式锁和 Redis 分布式锁的对比？**
- **分布式锁有哪些常见坑？**  
  → 详见 <RouteLink to="/distributed/2_lock">分布式锁</RouteLink>

## 三、分布式事务

- **2PC 的两个阶段是什么？有哪些问题？**
- **TCC 的 Try-Confirm-Cancel 是什么？空回滚、幂等、悬挂如何处理？**
- **Saga 和 TCC 的区别？各适合什么场景？**
- **Seata AT 模式的原理是什么？**
- **消息最终一致性（本地消息表 / RocketMQ 事务消息）如何实现？**  
  → 详见 <RouteLink to="/distributed/3_transaction">分布式事务</RouteLink>

## 四、分布式 ID

- **Snowflake 的 64 位结构是怎样的？时钟回拨如何处理？**
- **数据库号段模式的原理是什么？双 buffer 优化解决什么问题？**
- **UUID 为什么不适合做数据库主键？**
- **美团 Leaf 和百度 UidGenerator 分别解决了什么问题？**  
  → 详见 <RouteLink to="/distributed/7_id_generator">分布式 ID</RouteLink>

## 五、一致性哈希

- **普通取模哈希有什么问题？一致性哈希如何解决？**
- **虚拟节点的作用是什么？**
- **Redis Cluster 是如何分片的？slot 是什么？**  
  → 详见 <RouteLink to="/distributed/8_consistent_hashing">一致性哈希</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/7_distributed">开发总结-分布式</RouteLink>
:::

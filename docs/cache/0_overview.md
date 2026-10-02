# 缓存总览

缓存模块覆盖分布式缓存 Redis、本地缓存 Caffeine、两级缓存与 JetCache，以及缓存一致性和使用规范。阅读时建议按“数据结构与原理 → 集群与高可用 → 场景与实战 → 本地/多级缓存 → 一致性与规范”的顺序推进。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. 先读 [Redis 基础](./1_redis_base) 与 [Redis 核心原理](./2_redis_core)，掌握数据结构、持久化和淘汰机制。
2. 再读 [Redis 集群](./3_redis_cluster)，理解主从、哨兵与 Cluster 的高可用取舍。
3. 然后读 [典型应用场景](./4_redis_scenario)、[Redis 实战](./5_redis_practice) 与 [Redisson](./6_redisson)，落地到业务代码。
4. 接着读 [Caffeine](./7_caffeine)、[两级缓存](./8_two_level_cache)、[JetCache](./9_jetcache)，建立本地 + 分布式的多级缓存视角。
5. 最后读 [缓存一致性](./10_cache_consistency) 与 [缓存最佳实践](./11_cache_rule)，形成团队规范。

## 三、关联模块

- 缓存架构设计（多级缓存、预热、热点探测）→ [高并发 - 缓存架构设计](/high-con/3_cache_architecture)
- 热点 Key / 热点行治理 → [高并发 - 热点问题](/high-con/6_hotspot)
- 分布式锁（Redis / Redlock / ZooKeeper 对比）→ [分布式锁](/distributed/3_lock)
- Spring Cache 抽象 → [Spring Cache](/spring/5_cache)

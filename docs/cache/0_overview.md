# 缓存总览

缓存模块覆盖分布式缓存 Redis、本地缓存 Caffeine、两级缓存与 JetCache，以及缓存一致性和使用规范。本模块负责 Redis 本身与缓存一致性的技术细节；系统级的多级缓存架构与热点治理策略放在 [高并发](/high-con/0_overview)，分布式锁放在 [分布式](/distributed/0_overview)，限流放在 [高可用](/high-avail/0_overview)。

版本基线：

- **Redis 8.x**：8.0（2025-05 GA）起改名 Redis Open Source，许可证在 RSALv2 / SSPLv1 之外新增 AGPLv3 可选；原 Redis Stack 的 JSON、Time Series、概率结构（Bloom / Cuckoo / Count-min / Top-k / t-digest）与查询引擎并入核心，并新增 Vector Set（预览）
- **Valkey 8.x**：Redis 7.2.4 的 BSD 许可分支，命令与协议兼容，不含上述 Redis 8 新增模块
- **客户端与框架**：Spring Boot 4 / Spring Data Redis 4（配置前缀 `spring.data.redis.*`，JSON 序列化器换成 Jackson 3 版本）、Redisson 4.x（4.0 起支持 Spring Boot 4）、Caffeine 3.x、JetCache 2.7+

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读 [Redis 基础](./1_redis_base) 与 [Redis 核心原理](./2_redis_core)，掌握数据类型、线程模型、持久化和淘汰机制。
2. 再读 [Redis 集群](./3_redis_cluster)，理解主从、哨兵与 Cluster 的高可用取舍。
3. 然后读 [Redis 典型应用场景](./4_redis_scenario)、[Redis 实战](./5_redis_practice) 与 [Redisson](./6_redisson)，落地到业务代码。
4. 接着读 [Caffeine](./7_caffeine)、[两级缓存（L1 + L2）](./8_two_level_cache)、[JetCache](./9_jetcache)，建立本地 + 分布式的多级缓存视角。
5. 最后读 [缓存一致性](./10_cache_consistency) 与 [缓存最佳实践](./11_cache_rule)，形成团队规范。

[高频面试题](./99_interview) 只列题目，答案在 [缓存面试题解答](/interview/8_cache)。

---

## 三、关联模块

- 缓存架构设计（多级缓存、预热、热点探测）→ [缓存架构设计](/high-con/3_cache_architecture)
- 热点 Key / 热点行治理 → [热点问题](/high-con/6_hotspot)
- 分布式锁（Redis / Redlock / ZooKeeper 对比）→ [分布式锁](/distributed/3_lock)
- 分布式会话 → [分布式会话](/distributed/5_session)
- 限流算法与 Redis + Lua 实现 → [限流与过载保护](/high-avail/7_rate_limiting)
- 排行榜系统设计 → [排行榜和积分](/scenario/7_rank_system)
- Redis Stream / List 做队列时的可靠性对比 → [消息队列总览](/messaging/0_overview)
- 幂等方案 → [幂等设计](/architecture/5_idempotence)
- Spring Cache 抽象 → [Cache 抽象](/spring/5_cache)
- 本模块高频问题的答案汇总 → [缓存面试题解答](/interview/8_cache)

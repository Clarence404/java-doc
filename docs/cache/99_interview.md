# 面试高频题

> 汇总 Redis 与缓存核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/2_cache">开发总结-缓存</RouteLink>

## 一、Redis 数据结构

- **Redis 有哪些常用数据类型？各自的应用场景是什么？**
- **ZSet（有序集合）的底层实现是什么？（跳表 + 哈希表）**
- **Redis Stream 是什么？和消息队列有什么区别？**  
  → 详见 <RouteLink to="/cache/0_redis_base">Redis 基础</RouteLink>

## 二、持久化

- **RDB 和 AOF 的区别？各自的优缺点？**
- **AOF 重写的原理是什么？**
- **生产环境如何配置持久化策略？**

## 三、过期与淘汰

- **Redis 的过期策略有哪两种？（惰性删除 + 定期删除）**
- **Redis 内存用完会发生什么？有哪些淘汰策略？**
- **LRU 算法如何实现？（LinkedHashMap / HashMap + 双向链表）**

## 四、缓存问题三件套

- **缓存穿透是什么？如何解决？（布隆过滤器 + 缓存空值）**
- **缓存击穿是什么？如何解决？（互斥锁 + 逻辑过期）**
- **缓存雪崩是什么？如何解决？（随机过期时间 + 多级缓存 + Redis 高可用）**

## 五、一致性

- **如何保证缓存和数据库的一致性？**
- **延迟双删策略是什么？有什么缺点？**
- **先改库后删缓存 vs 先删缓存后改库，哪种更好？**  
  → 详见 <RouteLink to="/cache/9_cache_consistency">缓存一致性</RouteLink>

## 六、Redis 高级

- **Redis 分布式锁如何实现？Redisson 的看门狗机制是什么？**
- **Redis 热 Key 问题如何解决？**
- **Redis 大 Key 问题如何解决？**
- **Redis 线程模型是单线程吗？Redis 6.x 为何引入多线程？**
- **Redis Cluster 的分片原理？slot 是什么？**  
  → 详见 <RouteLink to="/cache/2_redis_cluster">Redis 集群</RouteLink>

## 七、本地缓存

- **Caffeine 和 Redis 的区别？各适合什么场景？**
- **二级缓存的设计思路是什么？如何保证一致性？**  
  → 详见 <RouteLink to="/cache/7_two_level_cache">二级缓存</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/2_cache">开发总结-缓存</RouteLink>
:::

# 面试高频题

> 汇总高并发方向的核心面试问题，完整解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink>（线程池、锁等 Java 并发题见 <RouteLink to="/interview/9_concurrent">开发总结-Java 并发</RouteLink>）

## 一、总体设计

- **如何设计一个高并发系统？从哪些维度入手？**  
  → 详见 <RouteLink to="/high-con/0_overview">高并发总览</RouteLink>
- **高并发、高性能、高可用三者的区别与联系？**
- **读多写少的场景如何设计？（CDN + 多级缓存 + 读写分离）**
- **写多的场景如何设计？（MQ 削峰 + 异步处理）**

## 二、水平扩展

- **垂直扩展和水平扩展的区别？各自适用什么场景？**
- **什么是无状态服务？应用中有哪些常见的"状态"需要外置？**
- **Session 在集群环境下如何共享？**  
  → 详见 <RouteLink to="/high-con/1_scale_out">水平扩展与无状态化</RouteLink>
- **K8s HPA 自动扩容有哪些局限？应用扩容后下游会出现什么问题？**

## 三、缓存架构

- **多级缓存的架构是怎样的？各层的一致性如何取舍？**
- **缓存穿透、缓存击穿、缓存雪崩分别是什么？如何解决？**
- **如何做缓存预热？**
- **如何发现突发热点 key？**  
  → 详见 <RouteLink to="/high-con/2_cache_architecture">缓存架构设计</RouteLink>

## 四、异步与削峰

- **MQ 如何实现削峰填谷？消费速率如何控制？**
- **消息积压了怎么处理？**
- **流量整形和限流有什么区别？**
- **异步化之后如何保证最终一致性？本地消息表的原理是什么？**  
  → 详见 <RouteLink to="/high-con/3_async_peak_shaving">异步与削峰</RouteLink>

## 五、数据层扩展

- **读写分离如何处理主从延迟？**
- **什么时候需要分库分表？分片键如何选择？**
- **分库分表后如何按非分片键查询？跨分片分页怎么做？**
- **分库分表如何平滑扩容？**  
  → 详见 <RouteLink to="/high-con/4_data_scaling">数据层扩展</RouteLink>

## 六、热点问题

- **Redis 热点 key 如何处理？（探测 + 本地缓存 + key 打散）**
- **秒杀场景下同一行库存的高并发扣减如何优化？**
- **什么是分桶库存？有什么代价？**
- **什么是请求合并（Single Flight）？适用于什么场景？**  
  → 详见 <RouteLink to="/high-con/5_hotspot">热点问题</RouteLink>

## 七、线程池与参数调优

- **线程池的核心参数有哪些？执行流程是什么？**
- **有哪几种拒绝策略？`CallerRunsPolicy` 的作用是什么？**
- **为什么禁止使用 `Executors` 工厂方法？**  
  → 详见 <RouteLink to="/java/28_topic_thread_pool">线程池</RouteLink>
- **线程数如何设置？CPU 密集型和 IO 密集型有何不同？**
- **Tomcat 的 `threads.max`、`max-connections`、`accept-count` 分别是什么关系？**
- **数据库连接池是不是越大越好？如何确定大小？**
- **服务器出现大量 TIME_WAIT 是什么原因？如何解决？**  
  → 详见 <RouteLink to="/high-con/6_concurrency_tuning">并发参数调优</RouteLink>

## 八、容量评估

- **如何从 DAU 估算系统的峰值 QPS？**
- **如何评估单机能力？需要多少台机器？**
- **大促前需要做哪些准备？**
- **如何压测一个高并发系统？关注哪些核心指标？**  
  → 详见 <RouteLink to="/high-con/7_capacity_planning">容量评估与规划</RouteLink> / <RouteLink to="/testing/7_performance_test">压测</RouteLink>

## 九、JUC 并发工具

- **`synchronized` 和 `ReentrantLock` 的区别？**
- **`synchronized` 的锁升级过程（偏向锁 → 轻量级锁 → 重量级锁）？**
- **`volatile` 关键字的作用？为什么不能保证原子性？**
- **CAS 是什么？ABA 问题如何解决？**
- **`ConcurrentHashMap` 在 JDK 7 和 JDK 8 中有何不同？**
- **`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别和应用场景？**

## 十、并发问题

- **死锁的四个必要条件是什么？如何预防和排查？**
- **`jstack` 如何排查死锁？**
- **活锁和线程饥饿的区别？如何解决？**

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink> 与 <RouteLink to="/interview/9_concurrent">开发总结-Java 并发</RouteLink>
:::

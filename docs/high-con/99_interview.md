---
description: 高并发方向题目清单
---

# 面试高频题

> 汇总高并发方向的核心面试问题，完整解答见 <RouteLink to="/interview/13_high_con">开发总结 - 高并发</RouteLink>；锁、volatile、CAS、同步器、死锁等 Java 语言层并发题见 <RouteLink to="/java/99_interview">Java 面试高频题</RouteLink> 与 <RouteLink to="/interview/2_concurrent">开发总结 - Java 并发</RouteLink>

## 一、总体设计

- **如何设计一个高并发系统？从哪些维度入手？**
- **高并发、高性能、高可用三者的区别与联系？**
- **读多写少的场景如何设计？（CDN + 多级缓存 + 读写分离）**
- **写多的场景如何设计？（MQ 削峰 + 异步处理）**  
  → 详见 <RouteLink to="/high-con/0_overview">高并发总览</RouteLink>

## 二、接入层

- **一个请求从 DNS 到应用服务要经过哪些层？每层解决什么问题？**
- **四层负载均衡（LVS）和七层负载均衡（Nginx）有什么区别？为什么常组合使用？**
- **CDN 的原理是什么？动态内容能否走 CDN？**
- **什么是页面静态化？适合什么场景？**
- **为什么要在接入层做 TLS 卸载？**
- **长连接网关如何支撑百万级连接？**  
  → 详见 <RouteLink to="/high-con/1_access_layer">接入层架构</RouteLink>

## 三、水平扩展

- **垂直扩展和水平扩展的区别？各自适用什么场景？**
- **什么是无状态服务？应用中有哪些常见的"状态"需要外置？**
- **Session 在集群环境下如何共享？**
- **K8s HPA 自动扩容有哪些局限？应用扩容后下游会出现什么问题？**  
  → 详见 <RouteLink to="/high-con/2_scale_out">水平扩展与无状态化</RouteLink>

## 四、缓存架构

- **多级缓存的架构是怎样的？各层的一致性如何取舍？**
- **缓存穿透、缓存击穿、缓存雪崩分别是什么？如何解决？**
- **如何做缓存预热？预热时如何避免压垮数据库？**  
  → 详见 <RouteLink to="/high-con/3_cache_architecture">缓存架构设计</RouteLink>

## 五、异步与削峰

- **MQ 如何实现削峰填谷？消费速率如何控制？**
- **消息积压了怎么处理？**
- **流量整形和限流有什么区别？**
- **异步化之后如何保证最终一致性？本地消息表的原理是什么？多实例下如何避免重复投递？**  
  → 详见 <RouteLink to="/high-con/4_async_peak_shaving">异步与削峰</RouteLink>

## 六、数据层扩展

- **数据层扩展的演进顺序是什么？为什么不一上来就分库分表？**
- **读写分离如何处理主从延迟？**
- **什么时候需要分库分表？分片键如何选择？**
- **哈希、范围、一致性哈希几种分片算法各有什么优缺点？**
- **分库分表后如何按非分片键查询？跨分片分页怎么做？**
- **分库分表如何平滑扩容？**  
  → 详见 <RouteLink to="/high-con/5_data_scaling">数据层扩展</RouteLink>

## 七、热点问题

- **如何发现突发热点 key？集中式探测的原理是什么？**
- **Redis 热点 key 如何处理？（探测 + 本地缓存 + key 打散）**
- **秒杀场景下同一行库存的高并发扣减如何优化？**
- **什么是分桶库存？有什么代价？**
- **什么是 Single Flight？和批量请求合并有什么区别？**  
  → 详见 <RouteLink to="/high-con/6_hotspot">热点问题</RouteLink>

## 八、并发参数调优

- **线程数如何设置？CPU 密集型和 IO 密集型有何不同？**
- **线程池核心线程满了之后，是先扩到最大线程数还是先进队列？Tomcat 线程池有何不同？**
- **队列长度如何确定？为什么不是越大越好？**
- **Tomcat 的 `threads.max`、`max-connections`、`accept-count` 分别是什么关系？开启虚拟线程后哪些还生效？**
- **数据库连接池是不是越大越好？水平扩容时要注意什么？**
- **Lettuce 需要配置连接池吗？什么时候池才会被使用？**
- **服务器出现大量 TIME_WAIT 是什么原因？如何解决？**  
  → 详见 <RouteLink to="/high-con/7_concurrency_tuning">并发参数调优</RouteLink>，线程池原理见 <RouteLink to="/java/28_topic_thread_pool">Java 线程池</RouteLink>

## 九、容量评估

- **如何从 DAU 估算系统的峰值 QPS？**
- **如何评估单机能力？需要多少台机器？多可用区部署时冗余系数怎么算？**
- **什么是全链路压测？如何保证压测数据不污染生产？（流量染色、影子库、挡板）**
- **生产环境压测有哪些风险？如何控制？**
- **大促前需要做哪些准备？**
- **容量水位如何监控？HPA 扩容阈值和容量规划水位有什么区别？**  
  → 详见 <RouteLink to="/high-con/8_capacity_planning">容量评估与规划</RouteLink> / <RouteLink to="/testing/7_performance_test">性能测试</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/13_high_con">开发总结 - 高并发</RouteLink>
:::

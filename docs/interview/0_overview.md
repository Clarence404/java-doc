# 开发总结总览

开发总结是全站高频问题的**答案汇总**，按技术方向组织，适合临考速查与复盘。各技术模块末尾的「面试高频题」（`99_interview`）只列题目，并链接到这里的对应答案页；想深入某个知识点时，再从答案页的「详见」链接回到模块正文。

## 一、答案页导航

| 答案页 | 覆盖方向 | 对应题目清单 |
|--------|----------|--------------|
| [Java](./1_java) | 语言基础、集合、String、类加载、Lambda 等 | [Java](/java/99_interview) |
| [数据库](./2_db) | MySQL 索引、事务与锁、MVCC、分库分表 | [数据库](/database/99_interview) |
| [缓存](./3_cache) | Redis 数据结构、持久化、集群、缓存三大问题、一致性 | [缓存](/cache/99_interview) |
| [JVM](./4_jvm) | 内存结构、GC、调优 | [JVM](/jvm/99_interview) |
| [Spring](./5_spring) | IoC、Bean 生命周期、循环依赖、AOP、事务、MVC、自动配置 | [Spring](/spring/99_interview) |
| [Spring Cloud](./6_spring_cloud) | 注册中心、网关、OpenFeign、配置中心、Sentinel、Seata | [Spring Cloud](/spring-cloud/99_interview) / [微服务](/microservices/99_interview) |
| [消息队列](./7_mq) | Kafka / RocketMQ / RabbitMQ、可靠性、顺序、幂等 | [消息队列](/messaging/99_interview) |
| [分布式](./8_distributed) | CAP / BASE、共识算法、分布式锁、分布式事务、分布式 ID | [分布式](/distributed/99_interview) |
| [Java 并发](./9_concurrent) | 线程池、synchronized vs ReentrantLock、volatile、CAS、ConcurrentHashMap、死锁 | [Java](/java/99_interview) |
| [三高](./10_high_avail) | 高性能、高并发、高可用 | [高并发](/high-con/99_interview) / [高可用](/high-avail/99_interview) / [高性能](/high-perf/99_interview) |
| [Netty](./11_netty) | IO 模型、Reactor、粘包拆包、长连接 | [Netty](/netty/99_interview) |
| [网络协议](./12_network) | TCP / UDP、HTTP、HTTPS / TLS | [协议体系](/protocols/99_interview) |
| [系统架构](./13_architecture) | 架构设计、DDD、幂等、权限系统 | [系统架构](/architecture/99_interview) |

## 二、使用建议

1. **系统复习**：先读模块正文建立体系，再用对应的题目清单自测，最后对照答案页查漏补缺。
2. **临考速查**：直接按方向阅读答案页，每题只保留核心结论、对比表和关键代码。
3. **项目准备**：结合 [业务场景](/scenario/0_overview) 中的秒杀、订单等综合案例，以及 [项目亮点与难点](/scenario/3_work_star)，把知识点落到自己的项目表述中。

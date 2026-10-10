# Vert.x 总览

本模块讲 JVM 上的事件驱动非阻塞工具包 Vert.x：先讲定位和线程模型，再讲 Event Bus、Web 与数据访问，最后讲集群与生产实践。

**版本基线（2026 年 10 月）**：Vert.x 5.2、JDK 21 / 25

---

## 一、学习路线

Vert.x 在 Netty 之上补齐了 HTTP、路由、响应式数据库客户端、消息、集群、指标与链路等能力，但不带依赖注入容器，也不规定应用结构；Quarkus 的 HTTP 层和响应式客户端就跑在 Vert.x 之上。Netty 内部机制和 Reactor 通用概念在各自模块展开，这里只讲 Vert.x 特有的部分。版本说明：Vert.x 5 最低要求 JDK 11，删除了回调 API、只保留 Future，新增 `VerticleBase`、`Vertx.builder()` 和虚拟线程 Verticle；4.5.x 线仍有维护补丁，但新项目应直接使用 5.x，与 4.x 不同处文中单独标出。

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **定位与模型** | Vert.x 和 Netty、WebFlux、Quarkus 是什么关系？为什么不能阻塞 Event Loop？三种 Verticle 怎么选？ | [Vert.x 概览](./1_basics) → [Event Loop 与 Verticle](./2_core) |
| **通信与 Web** | Verticle 之间怎样解耦通信？投递有什么保证？REST 服务、认证、错误处理和下游调用怎么写？ | [Event Bus](./3_eventbus) → [Vert.x Web 与 HTTP 客户端](./4_web) |
| **数据与生产** | 数据库、Redis、Kafka 怎样做到不阻塞？集群、监控、测试、停机和调优要注意什么？ | [响应式数据访问](./5_data) → [集群与生产实践](./6_production) |

---

## 二、模块导航

<ModuleNav />

---

## 三、阅读建议

- **第一次接触 Vert.x**：按顺序读完前两篇，并把 [Vert.x 概览](./1_basics) 里的最小示例在本地跑一遍。线程模型是写对 Vert.x 代码的前提。
- **用 Vert.x 写 REST 服务**：读完前两篇后，重点读 [Vert.x Web 与 HTTP 客户端](./4_web) 和 [响应式数据访问](./5_data)，注意 Handler 链的失败处理和连接池默认值。
- **做网关、IoT 接入或实时推送**：先读 [Netty 总览](/netty/0_overview) 理解底层，再读 [Event Bus](./3_eventbus) 和 [集群与生产实践](./6_production)。
- **在 Vert.x 和其他框架之间犹豫**：看 [Vert.x 概览](./1_basics) 的对比与选型一节，再对照 [其他 Java 框架](/quarkus/6_other_frameworks) 的选型表。

---

## 四、关联模块

- [Netty 总览](/netty/0_overview)：Vert.x 的网络层，Reactor 线程模型见 [Reactor 模型](/netty/2_reactor)
- [WebFlux](/spring/8_webflux)：同层的响应式框架，Reactor、背压等通用概念在那里展开
- [Quarkus 总览](/quarkus/0_overview)：建立在 Vert.x 之上的全栈框架，补上了依赖注入、配置、ORM 和构建期优化
- [虚拟线程](/java/30_topic_virtual_thread)：虚拟线程 Verticle 的基础，阻塞写法与响应式写法的取舍
- [Kafka](/messaging/2_kafka)：Event Bus 不持久化，关键业务事件应交给消息队列
- [Kubernetes](/cloud-native/6_kubernetes)：集群 Event Bus 的成员发现与部署，更多内容见 [云原生总览](/cloud-native/0_overview)
- [指标监控](/observability/2_metrics) / [OpenTelemetry](/observability/5_opentelemetry)：Micrometer 指标与链路追踪的接入，更多内容见 [可观测性总览](/observability/0_overview)
- [Flink 总览](/flink/0_overview)：同属框架生态，面向流计算而非在线服务

## 参考资料

- Vert.x 官方文档：[https://vertx.io/docs/](https://vertx.io/docs/)
- Vert.x 5 迁移指南：[https://vertx.io/docs/guides/vertx-5-migration-guide/](https://vertx.io/docs/guides/vertx-5-migration-guide/)
- What's new in Vert.x 5：[https://vertx.io/blog/whats-new-in-vert-x-5/](https://vertx.io/blog/whats-new-in-vert-x-5/)

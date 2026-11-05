# Vert.x 与 Quarkus 总览

本模块是选读：Vert.x 是 Netty 之上的事件驱动非阻塞工具包，Quarkus 是把装配挪到构建期、HTTP 层跑在 Vert.x 上的云原生框架，两者都是 Spring 体系之外的选型参考，日常开发与面试都不是重点。先按下面的适用场景判断要不要读，需要时再按两条阅读线展开。

**版本基线（2026 年 10 月）**：Vert.x 5、Quarkus 3 LTS、JDK 21 / 25、Mandrel / GraalVM 25

---

## 一、模块导航

<ModuleNav />

---

## 二、定位与适用场景

两者的关系：Vert.x 在 Netty 之上补齐了 HTTP、路由、响应式数据库客户端、消息、集群、指标与链路等能力，但不带依赖注入容器，也不规定应用结构；Quarkus 在 Vert.x 之上补上依赖注入（ArC）、配置、ORM 和构建期优化，是完整的应用框架。Netty 内部机制、Reactor 通用概念、GraalVM 原理和虚拟线程在各自模块展开，这里只讲两者特有的部分。

| 场景 | 建议 | 先读 |
|------|------|------|
| 已是 Spring 体系的业务系统，需要高并发 | 留在 Spring：Spring Boot + 虚拟线程优先，确有需要再上 WebFlux | [启动流程与自动配置](/spring-boot/1_spring_boot)、[WebFlux](/spring/8_webflux) |
| IoT 设备接入、网关、长连接推送等事件驱动、高并发的基础设施组件 | Vert.x：轻量、贴近 Netty，又不用自己写 Pipeline | [Vert.x 概览](./1_vertx/1_basics) |
| Serverless、Kubernetes 上要秒级启动、低内存、高密度部署的微服务 | Quarkus：构建期增强 + 原生镜像 | [Quarkus 概览](./2_quarkus/1_basics) |
| 已有 Spring Boot 服务，想压启动时间和镜像体积 | 先试 Spring Boot 自己的 CDS / AOT / 原生方案，不够再评估迁到 Quarkus | [启动与部署优化](/spring-boot/13_startup)、[从 Spring Boot 迁移](./2_quarkus/5_from_spring) |
| 在 Micronaut、Helidon、Solon、Javalin 等轻量框架之间选型 | 对照选型表 | [其他 Java 框架](./2_quarkus/6_other_frameworks) |

版本说明：

- **Vert.x 5**：最低要求 JDK 11，删除了回调 API、只保留 Future，新增 `VerticleBase`、`Vertx.builder()` 和虚拟线程 Verticle；4.5.x 线仍有维护补丁，但新项目应直接使用 5.x，与 4.x 不同处文中单独标出。
- **Quarkus 3**：3.40 LTS 维护到 2027-09-30，JVM 模式支持 JDK 17–25。Quarkus 4.0 已于 2026-10-01 发布 Beta1，最低要求 Java 21，并升级到 Vert.x 5、Jackson 3 和 Hibernate ORM 8，计划 11 月底 GA；本模块以 3.40 LTS 为准，Quarkus 4 的变化在文中单独标出。

---

## 三、推荐阅读路径

**Vert.x 线**（6 篇）：

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **定位与模型** | Vert.x 和 Netty、WebFlux、Quarkus 是什么关系？为什么不能阻塞 Event Loop？三种 Verticle 怎么选？ | [Vert.x 概览](./1_vertx/1_basics) → [Event Loop 与 Verticle](./1_vertx/2_core) |
| **通信与 Web** | Verticle 之间怎样解耦通信？投递有什么保证？REST 服务、认证、错误处理和下游调用怎么写？ | [Event Bus](./1_vertx/3_eventbus) → [Vert.x Web 与 HTTP 客户端](./1_vertx/4_web) |
| **数据与生产** | 数据库、Redis、Kafka 怎样做到不阻塞？集群、监控、测试、停机和调优要注意什么？ | [响应式数据访问](./1_vertx/5_data) → [集群与生产实践](./1_vertx/6_production) |

- **第一次接触**：按顺序读完前两篇，并把 [Vert.x 概览](./1_vertx/1_basics) 里的最小示例在本地跑一遍，线程模型是写对 Vert.x 代码的前提。
- **做网关、IoT 接入或实时推送**：先读 [Netty 总览](/netty/0_overview) 理解底层，再读 [Event Bus](./1_vertx/3_eventbus) 和 [集群与生产实践](./1_vertx/6_production)。

**Quarkus 线**（6 篇）：

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **核心原理** | Quarkus 为什么启动快？扩展、ArC、Dev Services 和构建期配置分别是什么？ | [Quarkus 概览](./2_quarkus/1_basics) |
| **业务开发** | 端点跑在哪个线程上？REST Client、Panache 和事务怎么用？ | [REST 与数据访问](./2_quarkus/2_rest_data) → [响应式与消息](./2_quarkus/4_reactive) |
| **云原生部署** | 原生镜像要注意哪些坑？怎样打容器镜像、部署到 Kubernetes？什么时候该用 JVM 模式？ | [原生镜像与云原生部署](./2_quarkus/3_native) |
| **迁移与选型** | 从 Spring Boot 迁移要改什么？什么时候不值得迁？其他轻量框架怎么选？ | [从 Spring Boot 迁移](./2_quarkus/5_from_spring) → [其他 Java 框架](./2_quarkus/6_other_frameworks) |

- **从 Spring Boot 转过来**：读完 [Quarkus 概览](./2_quarkus/1_basics) 后直接读 [从 Spring Boot 迁移](./2_quarkus/5_from_spring) 的概念对照，再回头读第 2～4 篇。
- **关注启动速度与资源占用**：重点读 [原生镜像与云原生部署](./2_quarkus/3_native)，并对照 [启动与部署优化](/spring-boot/13_startup) 中 Spring Boot 的 CDS、AOT 缓存与原生方案。

复习时用 [高频面试题](./99_interview) 自测，答案在 [Vert.x 面试题解答](/interview/10_vertx) 与 [Quarkus 面试题解答](/interview/11_quarkus)。

---

## 四、关联模块

- [Netty 总览](/netty/0_overview)：Vert.x 的网络层，Reactor 线程模型见 [Reactor 模型](/netty/2_reactor)
- [Spring Boot 总览](/spring-boot/0_overview)：主线框架；启动优化与原生方案见 [启动与部署优化](/spring-boot/13_startup)，可与 Quarkus 的做法对照
- [WebFlux](/spring/8_webflux)：同层的响应式框架，Reactor、背压等通用概念在那里展开，可与 Mutiny 对照
- [JIT 编译](/jvm/7_jit)：GraalVM Native Image 的静态分析、闭世界假设与 AOT 编译原理
- [虚拟线程](/java/30_topic_virtual_thread)：虚拟线程 Verticle 与 `@RunOnVirtualThread` 的基础，阻塞写法与响应式写法的取舍
- [Kafka 架构与存储](/messaging/2_kafka)：Event Bus 不持久化，关键业务事件应交给消息队列；客户端见 [Kafka 生产与消费](/messaging/2_kafka_client)
- [Kubernetes](/cloud-native/6_kubernetes)：集群 Event Bus 的成员发现、Quarkus 生成的部署清单与健康探针，更多内容见 [云原生总览](/cloud-native/0_overview)
- [IoT 总览](/iot/0_overview)：设备接入层常用 Vert.x / Netty 承载长连接
- [指标监控](/observability/2_metrics) / [OpenTelemetry](/observability/5_opentelemetry)：Micrometer 指标与链路追踪的接入，更多内容见 [可观测性总览](/observability/0_overview)

## 参考资料

- Vert.x 官方文档：[https://vertx.io/docs/](https://vertx.io/docs/)
- Vert.x 5 迁移指南：[https://vertx.io/docs/guides/vertx-5-migration-guide/](https://vertx.io/docs/guides/vertx-5-migration-guide/)
- What's new in Vert.x 5：[https://vertx.io/blog/whats-new-in-vert-x-5/](https://vertx.io/blog/whats-new-in-vert-x-5/)
- Quarkus 官方指南：[https://quarkus.io/guides/](https://quarkus.io/guides/)
- Quarkus 版本与支持周期：[https://quarkus.io/releases](https://quarkus.io/releases)
- Quarkus 3.40 发布说明：[https://quarkus.io/blog/quarkus-3-40-released/](https://quarkus.io/blog/quarkus-3-40-released/)

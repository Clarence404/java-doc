# Quarkus 总览

Quarkus 是 Red Hat 主导的云原生 Java 框架，它和 Spring Boot 解决的是同一类问题。两者的区别在于：Spring Boot 在运行期完成扫描、注解解析、代理生成和 Bean 装配，Quarkus 把这些工作挪到了构建期，所以启动更快、内存更低，原生镜像也更容易做。本模块先讲构建期增强、扩展和依赖注入，再讲 REST、数据访问、原生镜像和响应式消息，最后讲怎样从 Spring Boot 迁移，以及 Micronaut、Helidon、Solon、Javalin 等框架的对比。GraalVM 的通用原理、虚拟线程和 Reactor 在各自模块展开，这里只讲 Quarkus 特有的部分。

版本基线：**Quarkus 3.40 LTS**（维护到 2027-09-30），**JDK 21 / 25**（Quarkus 3 的 JVM 模式支持 JDK 17–25），原生构建使用 **Mandrel / GraalVM 25**。Quarkus 4.0 已于 2026-10-01 发布 Beta1，最低要求 Java 21，并升级到 Vert.x 5、Jackson 3 和 Hibernate ORM 8，计划 11 月底 GA。本模块以 3.40 LTS 为准，Quarkus 4 的变化在文中单独标出。

> 参考资料：
> * Quarkus 官方指南：[https://quarkus.io/guides/](https://quarkus.io/guides/)
> * Quarkus 版本与支持周期：[https://quarkus.io/releases](https://quarkus.io/releases)
> * Quarkus 3.40 发布说明：[https://quarkus.io/blog/quarkus-3-40-released/](https://quarkus.io/blog/quarkus-3-40-released/)

---

## 一、学习路线

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **核心原理** | Quarkus 为什么启动快？扩展、ArC、Dev Services 和构建期配置分别是什么？ | [Quarkus 概览](./1_basics) |
| **业务开发** | 端点跑在哪个线程上？REST Client、Panache 和事务怎么用？ | [REST 与数据访问](./2_rest_data) → [响应式与消息](./4_reactive) |
| **云原生部署** | 原生镜像要注意哪些坑？怎样打容器镜像、部署到 Kubernetes？什么时候该用 JVM 模式？ | [原生镜像与云原生部署](./3_native) |
| **迁移与选型** | 从 Spring Boot 迁移要改什么？什么时候不值得迁？其他轻量框架怎么选？ | [从 Spring Boot 迁移](./5_from_spring) → [其他 Java 框架](./6_other_frameworks) |

---

## 二、模块导航

<ModuleNav />

---

## 三、阅读建议

- **第一次接触 Quarkus**：按顺序读完前两篇。[Quarkus 概览](./1_basics) 讲的构建期增强，是理解后面所有特性和限制的前提。
- **从 Spring Boot 转过来**：读完 [Quarkus 概览](./1_basics) 后直接读 [从 Spring Boot 迁移](./5_from_spring) 的概念对照，再回头读第 2～4 篇。
- **关注启动速度与资源占用**：重点读 [原生镜像与云原生部署](./3_native)，并对照 [启动与部署优化](/spring-boot/14_startup) 中 Spring Boot 的 CDS、AOT 缓存与原生方案。
- **做框架选型**：看 [其他 Java 框架](./6_other_frameworks) 的选型对比，以及 [Vert.x 概览](/vertx/1_basics) 中 Vert.x 的定位。

---

## 四、关联模块

- [Vert.x 总览](/vertx/0_overview)：Quarkus 的 HTTP 层、事件总线和响应式客户端都跑在 Vert.x 之上
- [启动与部署优化](/spring-boot/14_startup)：Spring Boot 的启动优化与原生方案，可与 Quarkus 的做法对照；Spring Boot 本身见 [Spring Boot 总览](/spring-boot/0_overview)
- [JIT 编译](/jvm/7_jit)：GraalVM Native Image 的静态分析、闭世界假设与 AOT 编译原理
- [WebFlux](/spring/8_webflux)：Reactor 的执行模型与背压，可与 Mutiny 对照
- [虚拟线程](/java/30_topic_virtual_thread)：`@RunOnVirtualThread` 的基础，钉住与 ThreadLocal 的坑
- [Kafka](/messaging/2_kafka)：Kafka 本身的可靠性配置、幂等消费与 Exactly-Once
- [Kubernetes](/cloud-native/6_kubernetes)：Kubernetes 扩展生成的部署清单与健康探针，更多内容见 [云原生总览](/cloud-native/0_overview)
- [指标监控](/observability/2_metrics) / [OpenTelemetry](/observability/5_opentelemetry)：Micrometer 指标与链路追踪，更多内容见 [可观测性总览](/observability/0_overview)
- [Flink 总览](/flink/0_overview)：同属框架生态，面向流计算而非在线服务

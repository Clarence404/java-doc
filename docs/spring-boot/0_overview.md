# Spring Boot 总览

Spring Boot 模块从启动流程与自动配置原理出发，覆盖 Web 开发、数据访问、数据库版本迁移、中间件集成、配置管理、Actuator 监控、自定义 Starter、异步与定时任务、接口文档，以及版本演进、日志、测试与启动部署优化。版本基线为 Spring Boot 4.x / Spring Framework 7.x，3.x 的差异在文中单独标注。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. 先读 [启动流程与自动配置](./1_spring_boot)，理解“约定优于配置”的实现原理。
2. 再读 [Web 开发](./2_web_dev) 与 [数据访问](./3_data_access)，覆盖日常 CRUD 开发的主干。
3. 然后读 [配置管理](./6_config)、[中间件集成](./5_middleware)、[异步与定时任务](./9_async_schedule)。
4. 接着读 [日志](./12_logging) 与 [Spring Boot 测试](./13_testing)，补齐日常开发的基础设施。
5. 最后读 [Actuator 监控](./7_actuator)、[自定义 Starter](./8_custom_starter) 与 [启动与部署优化](./14_startup)，面向生产运维与组件封装。
6. 从 2.x / 3.x 升级时先看 [Spring Boot 版本演进](./11_versions)。

## 三、关联模块

- Spring Framework（IoC / AOP / 事务 / MVC）→ [Spring](/spring/0_overview)
- 微服务组件 → [Spring Cloud](/spring-cloud/0_overview)
- 测试分层与 Mock、Testcontainers → [测试工程](/testing/0_overview)
- 日志采集与平台 → [可观测性](/observability/0_overview)
- JDK 版本特性 → [Java 模块：版本演进](/java/2_version)
- 优雅停机与服务预热 → [高可用 - 优雅上下线与变更](/high-avail/8_graceful_release)

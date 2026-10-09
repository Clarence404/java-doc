# Spring Boot 总览

Spring Boot 模块从启动流程与自动配置原理出发，覆盖 Web 开发、数据访问、数据库版本迁移、中间件集成、配置管理、Actuator 监控、自定义 Starter、异步与定时任务、接口文档，以及版本演进、日志、测试与启动部署优化。Spring Framework 本身的 IoC、AOP、事务与 MVC 机制在 [Spring 总览](/spring/0_overview) 模块讲解，这里只讲 Boot 在其之上的装配、配置与工程实践。

版本基线：**Spring Boot 4.x / Spring Framework 7.x**（JDK 17 起步，推荐 21 / 25），3.x 的差异在文中单独标注。

> 参考资料：
> * Spring Boot 参考文档：[https://docs.spring.io/spring-boot/](https://docs.spring.io/spring-boot/)
> * Spring Boot 项目页：[https://spring.io/projects/spring-boot](https://spring.io/projects/spring-boot)
> * Spring Boot Release Notes：[https://github.com/spring-projects/spring-boot/wiki](https://github.com/spring-projects/spring-boot/wiki)

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读 [启动流程与自动配置](./1_spring_boot)，理解“约定优于配置”的实现原理。
2. 再读 [Web 开发](./2_web_dev)、[数据访问](./3_data_access) 与 [数据库版本迁移](./4_flyway)，覆盖日常 CRUD 开发的主干。
3. 然后读 [配置管理](./6_config)、[中间件集成](./5_middleware)、[异步任务与定时任务](./9_async_schedule) 与 [接口文档](./10_api_doc)。
4. 接着读 [日志](./12_logging) 与 [Spring Boot 测试](./13_testing)，补齐日常开发的基础设施。
5. 最后读 [Actuator 监控](./7_actuator)、[自定义 Starter](./8_custom_starter) 与 [启动与部署优化](./14_startup)，面向生产运维与组件封装。
6. 从 2.x / 3.x 升级时先看 [Spring Boot 版本演进](./11_versions)。

[面试高频题](./99_interview) 只列题目，答案在 [开发总结 - Spring 与 Spring Boot](/interview/5_spring)。

---

## 三、关联模块

- [Spring 总览](/spring/0_overview)：IoC、AOP、事务、MVC 等 Framework 机制，本模块只讲 Boot 层面的装配
- [Spring Cloud 总览](/spring-cloud/0_overview)：注册发现、网关、服务通信等微服务组件
- [测试工程总览](/testing/0_overview)：测试分层、Mock 与 Testcontainers
- [可观测性总览](/observability/0_overview)：日志采集、指标与链路追踪平台
- [版本演进](/java/2_version)：各 JDK 版本的语言与平台特性
- [优雅上下线与变更](/high-avail/8_graceful_release)：优雅停机、服务预热与数据库变更的发布顺序

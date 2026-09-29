# 分布式调度

分布式调度系统用于在多节点环境下统一管理和执行任务（Job），常见于定时任务、批处理任务、数据同步、日志清理等场景。
相比传统的 `@Scheduled` 或 `Timer`，这些框架提供了任务可视化、分片执行、失败重试、告警通知等高级能力。

---

## XXL-JOB

> 又名：**XXL 分布式任务调度平台**

轻量级、开源、易上手的分布式任务调度框架。
由开源作者 **许雪里（xuxueli）** 开发，提供调度中心（admin）与执行器（executor）两部分。

**特性：**

* 支持任务分片、失败重试
* Web 可视化任务管理
* 支持动态配置 Cron 表达式
* 丰富的执行日志与监控
* Spring Boot 集成友好

**官网：** [https://www.xuxueli.com/xxl-job/](https://www.xuxueli.com/xxl-job/)

---

## Quartz

> 又名：**Quartz Scheduler**

历史悠久的 Java 定时任务调度框架。
是许多分布式调度框架（包括 XXL-JOB、ElasticJob）的底层灵感来源。

**特性：**

* 支持 Cron、简单间隔、日历调度等多种方式
* 可持久化任务与状态（JDBC、内存等）
* 可通过集群方式实现高可用

**官网：** [http://www.quartz-scheduler.org/](http://www.quartz-scheduler.org/)

---

## ElasticJob

> 又名：**ElasticJob-Lite / ElasticJob-Cloud**

阿里巴巴开源的分布式任务调度解决方案。
依托 Zookeeper 实现任务协调、分片与容错。

**特性：**

* 分布式分片调度
* 动态扩容缩容
* 作业追踪与事件监控
* 支持 Spring Boot Starter

**GitHub：** [https://github.com/elasticjob/elasticjob](https://github.com/elasticjob/elasticjob)

---

## PowerJob

> 又名：**想天开源分布式任务调度系统**

京东开源的分布式任务调度框架，基于 Akka 与 Spring 构建。

**特性：**

* Web 管理控制台
* 支持任务依赖、分片与重试
* 强大的任务日志与可观察性
* REST API 集成方便

**GitHub：** [https://github.com/PowerJob/PowerJob](https://github.com/PowerJob/PowerJob)

---

## DolphinScheduler

> 又名：**Apache DolphinScheduler**

Apache 顶级项目，专注于 **数据处理与工作流调度**。
广泛用于数据工程、ETL、数据仓库任务管理。

**特性：**

* DAG 工作流编排
* 多任务类型（Shell、Spark、Flink、Python等）
* 高可用 Master/Worker 架构
* 可视化工作流设计器

**官网：** [https://dolphinscheduler.apache.org/](https://dolphinscheduler.apache.org/)

---

## Airflow

> 又名：**Apache Airflow（Python生态）**

虽然主语言为 Python，但在 Java 系统中也常通过 REST API 或 CLI 调用使用。
擅长 **复杂依赖的任务编排**。

**特性：**

* 基于 DAG（有向无环图）的任务依赖管理
* 支持插件化 Operator 扩展
* 可视化任务监控与历史重跑
* 适合数据管道调度

**官网：** [https://airflow.apache.org/](https://airflow.apache.org/)

---

## Azkaban

> 又名：**LinkedIn Azkaban**

LinkedIn 开源的工作流调度工具，用于 Hadoop 批处理任务管理。
与 Java 系统结合良好，常用于大数据批任务调度。

**特性：**

* 简单的工作流定义与依赖管理
* 基于 Web 的任务运行与监控
* 可与 Hadoop、Spark 等集成

**GitHub：** [https://github.com/azkaban/azkaban](https://github.com/azkaban/azkaban)

---

## 比较建议（汇总表）

| 框架                   | 主语言    | 类型    | 特点              | 适用场景               |
| -------------------- | ------ | ----- | --------------- | ------------------ |
| **XXL-JOB**          | Java   | 分布式调度 | 分片、重试、Web 控制台   | 微服务任务调度            |
| **Quartz**           | Java   | 定时调度  | 轻量、经典、可持久化      | 单机或集群任务            |
| **ElasticJob**       | Java   | 分布式调度 | Zookeeper 协调、分片 | 高并发调度              |
| **PowerJob**         | Java   | 分布式调度 | 任务依赖、日志完善       | 企业任务平台             |
| **DolphinScheduler** | Java   | 工作流调度 | DAG 工作流         | 数据管道、ETL           |
| **Airflow**          | Python | 工作流调度 | DAG 依赖、插件化      | 数据工程               |
| **Azkaban**          | Java   | 工作流调度 | 简单依赖、批处理        | Hadoop / Spark 批任务 |

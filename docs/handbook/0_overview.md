---
description: 实战手册定位、速查表与故障案例的用法、模块导航与推荐阅读路径
---

# 实战手册总览

实战手册把散落在各模块里的排查命令和线上故障收拢成一本随手可翻的工具书：速查表只给能直接复制的命令，故障案例按「现象、排查、根因、修复、预防」复盘真实问题。原理一律链接到对应模块的主文档，这里不重复展开。

**版本基线（2026 年 10 月）**：JDK 21 / 25、Spring Boot 4、MySQL 8.4、Redis 8、Kafka 4、Kubernetes 1.37、Arthas 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

本模块分两部分，用法不同：

- **速查表**：日常开发和值班时按场景查命令，表格固定为「场景 | 命令 | 说明」，复制后把 `<pid>`、`<pod>` 等占位符换成实际值即可
  1. [Linux 排查命令速查](./1_cheatsheet/0_linux)：负载、内存、磁盘、网络、进程、日志与 Java 进程
  2. [Git 命令速查](./1_cheatsheet/1_git)：日常提交、分支同步、整理历史、撤销与找回、定位问题
  3. [Docker 与 kubectl 速查](./1_cheatsheet/2_container)：容器与 Pod 的状态、日志、进入、发布回滚、资源与网络
  4. [Arthas 速查](./1_cheatsheet/3_arthas)：附着、全局概览、方法级观察、类加载器、热修复与收尾
  5. [JVM 参数与 GC 日志速查](./1_cheatsheet/4_jvm)：堆与容器参数、GC 选择、GC 日志与运行时查看
  6. [MySQL 排查速查](./1_cheatsheet/5_mysql)：慢查询、执行计划、连接、锁等待、死锁与复制状态
  7. [Redis 运维命令速查](./1_cheatsheet/6_redis)：大 Key / 热 Key、延迟、内存淘汰、慢日志与集群
  8. [Maven 与 Gradle 命令速查](./1_cheatsheet/7_build)：构建与单测、多模块、依赖分析、版本升级与构建排障
- **故障案例**：用于故障演练和面试准备，先只看「现象」自己推一遍排查思路，再对照后面的排查过程和根因；每个案例的处置命令都能在速查表里找到

建议的节奏：先把速查表各过一遍，知道每类问题该用哪个命令；再按故障案例做演练，遇到不熟的原理顺着文中链接回到主文档补齐。

复习时用 [高频面试题](./99_interview) 自测，答案在 [实战手册面试题解答](/interview/20_handbook)。

---

## 三、关联模块

- Linux 基础、systemd、信号与 fd 上限 → [Linux 概览](/cloud-native/1_linux)；USE 排查方法 → [性能分析方法论](/high-perf/2_methodology)
- 分支模型、Commit 规范与提交钩子 → [Git 工作流](/devops/1_git_workflow)
- 镜像构建与容器原理 → [Docker](/cloud-native/5_docker)；探针、滚动发布与常见 Pod 故障 → [Kubernetes](/cloud-native/6_kubernetes)
- JDK 自带诊断工具 → [诊断工具](/jvm/8_monitoring_tools)；OOM、CPU 飙高、死锁的排查流程 → [故障排查](/jvm/9_troubleshooting)
- Arthas 原理、容器附着与安全守则 → [线上诊断](/engineering/7_diagnosis)
- 慢 SQL 与执行计划 → [EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)；Redis 生产问题 → [Redis 实战](/cache/5_redis_practice)；消息堆积与重复消费 → [消息队列基础](/messaging/1_basics)
- 优雅停机与发布 → [优雅上下线与变更](/high-avail/8_graceful_release)；故障分级、止血与复盘 → [故障应急与复盘](/high-avail/11_incident_response)

---

## 参考资料

- Linux man pages：[man7.org](https://man7.org/linux/man-pages/)
- Git 官方文档：[Git Reference](https://git-scm.com/docs)
- Docker CLI 参考：[Docker CLI reference](https://docs.docker.com/reference/cli/docker/)
- kubectl 参考：[kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- Arthas 官方文档：[Arthas 用户文档](https://arthas.aliyun.com/doc/)
- Google SRE 手册：[Site Reliability Engineering](https://sre.google/sre-book/table-of-contents/)

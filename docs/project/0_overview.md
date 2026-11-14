# 项目演进总览

项目演进模块用一个虚构的「示例商城」订单服务，按真实项目的成长顺序，从单体起步一路演进到分布式、上线运维。每篇只讲这个阶段遇到的问题、可选方案、最终决策和代价，原理与细节都链接到各模块的主文档。

**版本基线（2026 年 10 月）**：JDK 21、Spring Boot 4、Spring Cloud 2025.1、MySQL 8.4、Redis 8、RocketMQ 5、Kubernetes 1.37

---

## 一、项目背景

示例商城是一家做生鲜与日用品的中型电商，本模块只跟踪其中的**订单服务**：用户下单、扣减库存、支付、发货通知到售后的主链路。全系列共用下面这套设定，各篇的数字、命名都以此为准。

| 设定 | 取值 |
|------|------|
| 仓库 | [`mall-evolution`](https://github.com/Clarence404/mall-evolution)，Maven 多模块，Java 包名 `io.github.clarence404.mall`；每篇文章对应一个章节 tag（如 `ch04-cache`），四个阶段各有 tag 与 [Release](https://github.com/Clarence404/mall-evolution/releases)（`stage-1-monolith`、`stage-2-cache-async`、`stage-3-split`、`stage-4-stability`）；每个章节 tag 上都跑了完整构建并发布 [测试报告](https://clarence404.github.io/mall-evolution/)，前九篇的「验证」一节列出关键结论与证明它的测试；本地体验：`docker compose --profile demo up -d --build` 一条命令起全套服务，浏览器打开 `http://localhost:9000/` 进入演示控制台（详见仓库 README）；`main` 在全系列写完后仍在维护，与各章标签的差异见下文「主线后来的变化」 |
| 核心实体 | 用户、商品、库存、订单、支付单 |
| 团队 | 起步 3 人全栈，阶段三扩到 20 人、4 个小组，阶段四新增 1 名专职 SRE |
| 部署 | 起步两台云主机；阶段三起迁到 Kubernetes |

本系列与 [订单](/scenario/5_order_system) 的分工：那篇是订单系统的通用设计题答案，表名、事件名、关单方式等细节与示例商城不完全相同；这里讲示例商城的订单服务**怎么一步步演进**、每一步为什么这么选，示例商城的实际做法以本系列为准。

---

## 二、演进路线

| 阶段 | 规模 | 主要矛盾 | 对应文章 |
|------|------|---------|---------|
| [一、单体起步](https://github.com/Clarence404/mall-evolution/releases/tag/stage-1-monolith) | 日订单 1 万，下单峰值约 20 QPS | 尽快上线，同时别给后面埋坑 | [工程搭建](./1_project_setup)、[数据建模](./2_data_model)、[接口设计](./3_api_design) |
| [二、读多扛流量](https://github.com/Clarence404/mall-evolution/releases/tag/stage-2-cache-async) | 日订单 10 万，下单峰值约 30 QPS，商品详情读约 2000 QPS | 数据库读压力大、同步调用拖慢下单 | [引入缓存](./4_cache)、[异步化](./5_async) |
| [三、拆分服务](https://github.com/Clarence404/mall-evolution/releases/tag/stage-3-split) | 日订单 100 万，20 人 4 个小组 | 单体发布互相阻塞、库存与支付需要独立扩容 | [拆分服务](./6_split)、[跨服务一致性](./7_consistency) |
| [四、大促稳定性](https://github.com/Clarence404/mall-evolution/releases/tag/stage-4-stability) | 大促下单峰值 5000 QPS，日常约 300 QPS | 流量尖峰、依赖故障扩散、问题难定位 | [稳定性](./8_stability)、[可观测与发布](./9_observability_release) |

每个阶段的数字只用来说明「为什么到了这一步要变」：在上一阶段就引入下一阶段的方案，往往是过度设计；到了瓶颈还不变，则会在线上付出代价。最后一篇 [复盘](./10_retrospective) 把全部决策串起来，整理成讲项目时的思路。

---

## 三、主线后来的变化

各篇正文与对应的章节 tag、阶段 tag 一致，照着标签读代码不会对不上。`main` 在全系列写完后还在继续维护，下面几处与正文示例不同；照着 `main` 在本地跑时，以仓库 [README](https://github.com/Clarence404/mall-evolution#readme) 为准。

| 变化 | 正文（各章标签） | `main` 现在 |
|------|----------------|------------|
| Spring Boot 版本 | 4.0.x | 4.1.2；Spring Cloud 2025.1.4、Spring Cloud Alibaba 2025.1.0.0 |
| 本地覆盖配置 | 仓库根目录下不提交的 `application-local.yml` | 固定放在 `config/application-local.yml`（模板 `config/application-local.example.yml`），以 `dev,local` 两个 profile 启动时读取 |
| 管理端口 | Actuator 与业务同一个端口：健康检查、探针、Prometheus 抓取都走 8080 | 独立管理端口：dev 为业务端口 + 10000（18080 / 18082 / 18083 / 19000），prod 与 Kubernetes 统一 18080；管理端口只放行 health、info、prometheus，业务端口上匿名访问 `/actuator/prometheus` 返回 401 |
| Kubernetes 清单 | 探针指向容器端口 8080 | 容器端口分为 `http`（8080）与 `management`（18080），存活 / 就绪 / 启动探针与 PodMonitor 都指向 `management`，Service 只暴露 `http`；云主机部署的健康检查也走 18080 |
| 演示数据 | 2 个普通演示用户与 1 个运营账号 | 普通演示用户增加到 8 个（给流量模拟器分散用户）；demo profile 多了查库存与补货接口（`/api/demo/inventory/stocks`） |
| 流量模拟器 | 无 | `simulator` 模块：演示账号经网关长期模拟真人浏览、下单、支付，让监控面板一直有数据；与 `perf`（Gatling 压测）不同，速率低、一直跑 |
| Grafana 面板 | 业务大盘 | 新增 JVM / HTTP 通用面板（`deploy/observability/grafana/jvm-http-dashboard.json`） |
| 本地监控 | 无 | 可以借用 mall-assistant 仓库 `monitoring/` 的那套 Prometheus + Grafana（compose 项目名 `mall-monitoring`），加上抓四个服务管理端口的任务即可，见 [生产化：共享状态与监控落地 · 监控落地：真的跑起来、真的测过](/ai/7_practice/10_production#七、监控落地-真的跑起来、真的测过) |

正文里受影响的示例旁边都有一句提示指回这里，示例本身不改。

---

## 四、模块导航

<ModuleNav />

---

## 五、推荐阅读路径

建议按编号顺序读，每篇开头都会交代承接的上一步；只关心某个阶段时，也可以从对应的文章单独读起。每篇都按同一个结构写：

1. **背景**：项目走到这一步，出现了什么问题，有哪些数字
2. **选项**：可选的几种方案，各自的代价
3. **决策**：选了哪个、为什么，以及明确不做什么
4. **关键实现**：只放最能说明决策的少量代码与配置
5. **代价与后续**：这个决策带来的新问题，由后面哪一篇解决
6. **验证**：关键结论分别由哪个测试证明，没有自动化测试的也如实标出

复习时用 [高频面试题](./99_interview) 自测，答案在 [项目难点与亮点面试题解答](/interview/25_scenario_highlights)。

---

## 六、关联模块

- [工程结构与分包](/architecture/2_package_structure)：仓库布局、模块划分与包结构的通用做法
- [系统设计方法论](/scenario/1_design_method)：需求澄清、容量估算到架构取舍的答题流程
- [订单](/scenario/5_order_system)：订单系统的最终架构与关键设计
- [学习路线](/interview/91_routes)：「从 CRUD 到架构」路线的最后一站

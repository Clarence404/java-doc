# DevOps 总览

> 参考资料：
> * The DevOps Handbook：[https://itrevolution.com/product/the-devops-handbook/](https://itrevolution.com/product/the-devops-handbook/)
> * Google SRE：[https://sre.google/sre-book/table-of-contents/](https://sre.google/sre-book/table-of-contents/)

## 一、DevOps 核心理念

DevOps = Development + Operations，打通开发与运维的协作壁垒，以自动化手段缩短软件交付周期、提升发布质量。

| 阶段 | 活动 | 工具示例 |
|------|------|---------|
| 计划 | 需求管理 / 迭代规划 | Jira / 禅道 |
| 编码 | 版本控制 / 代码规范 | Git / SonarQube |
| 构建 | 编译 / 依赖管理 | Maven / Gradle |
| 测试 | 自动化测试 / 覆盖率 | JUnit / JaCoCo |
| 发布 | 流水线 / 制品管理 | Jenkins / GitHub Actions |
| 部署 | 容器化 / 编排 | Docker / Kubernetes |
| 运营 | 监控 / 告警 | Prometheus / Grafana |

## 二、核心指标（DORA Metrics）

Google DevOps Research and Assessment 定义的四项关键指标：

| 指标 | 说明 | Elite 水平 |
|------|------|-----------|
| **部署频率** | 生产环境部署次数 | 按需，每天多次 |
| **变更前置时间** | 代码提交到生产部署的时间 | < 1 小时 |
| **变更失败率** | 导致生产故障的变更比例 | < 5% |
| **服务恢复时间（MTTR）** | 生产故障从发现到恢复的时间 | < 1 小时 |

## 三、模块导航

<ModuleNav />

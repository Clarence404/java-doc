# DevOps 工程实践概览

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

## 二、本模块结构

- **Git 工作流**：分支策略 / Commit 规范 / PR 流程
- **CI/CD**：持续集成 / 持续部署流水线
- **代码质量**：Code Review / 静态分析
- **团队规范**：开发规范 / 日志规范
- **发布策略**：滚动发布 / 蓝绿发布 / 金丝雀发布 / 回滚
- **制品与版本管理**：制品仓库 / 版本规范 / 构建追溯

> [!warning]
> 待补充

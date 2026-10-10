---
description: DevOps 生命周期、DORA 五项交付指标、模块导航与推荐阅读路径
---

# DevOps 总览

DevOps 把开发和运维放进同一条交付链路，用版本控制、自动化流水线和可度量的反馈，让变更又快又稳地到达生产。本模块讲 Java 后端团队要落地的分支、评审、规范、流水线、制品、环境与发布。

**版本基线（2026 年 10 月）**：Git 2.56、GitHub Actions、Jenkins LTS 2.5xx、Kubernetes 1.37、Argo CD 3.x、SemVer 2.0.0、SLSA 1.2、JDK 21、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

![DevOps 生命周期](../assets/devops/overview-devops-lifecycle.svg)

全站统一的交付约定：分支模型采用 **主干开发 / GitHub Flow**（短命分支、`main` 始终可发布、在 `main` 上打 tag 发版，不设长期 `develop` 分支）；同一个制品从测试环境一路晋级到生产，环境差异只靠配置注入；未完成的功能用 Feature Flag 隐藏，而不是靠长期分支隔离。CI 示例以 GitHub Actions 为主，同时给出 GitLab CI 与 Jenkins 写法（Jenkins 自 2.555.1 起要求 Java 21 或 25）；南北向入口用 Gateway API（社区版 ingress-nginx 已于 2026 年 3 月停止维护）；供应链安全参照 SLSA 与 Sigstore。

按一次变更从写代码到上线的顺序阅读：

1. [Git 工作流](./1_git_workflow)：主干开发与 GitHub Flow、分支保护规则集、Conventional Commits、提交钩子
2. [Code Review](./3_code_review)：PR 模板与评审清单（全站唯一版本）、评审礼仪与时效
3. [开发规范](./4_dev_standards)：命名、异常、日志、代码坏味道示例
4. [CI/CD](./2_ci_cd)：流水线结构、质量门禁、缓存与并发、部署触发
5. [制品与版本管理](./6_artifact_version)：版本号、制品仓库、镜像标签与按 digest 部署、签名与来源证明
6. [环境管理](./7_env_management)：多环境划分与配置注入、Feature Flag、环境数据
7. [发布策略](./5_release_strategy)：滚动、蓝绿、金丝雀与回滚

文件编号与阅读顺序不完全一致：发布策略编号靠前，但它依赖制品和环境两篇的概念，建议放在最后读。

---

## 三、交付效能度量（DORA）

DORA（DevOps Research and Assessment）是一个长期跟踪软件交付效能的研究项目，现属 Google Cloud。它的指标是衡量本模块各项实践是否有效的通用标尺，目前为五项：

| 类别 | 指标 | 含义 | 在本模块里从哪采集 |
|------|------|------|------|
| 吞吐 | 变更前置时间（Change lead time） | 代码提交到部署上生产的时长 | 提交时间与生产部署记录 |
| 吞吐 | 部署频率（Deployment frequency） | 一段时间内生产部署的次数 | CD 流水线或 Argo CD 同步记录 |
| 吞吐 | 失败部署恢复时间（Failed deployment recovery time） | 一次需要立即干预的失败部署，从发生到恢复的时长 | 回滚 / 热修复的部署记录 |
| 不稳定性 | 变更失败率（Change fail rate） | 部署后需要立即干预（回滚、热修复）的比例 | 部署记录与故障工单关联 |
| 不稳定性 | 部署返工率（Deployment rework rate） | 由生产事故触发的计划外部署占全部部署的比例 | 标记为计划外的部署 |

几点变化需要注意：

- 早期的「服务恢复时间（MTTR）」在 2023 年报告中改为「失败部署恢复时间」，只统计由变更引起的故障，机房断电这类外部故障不再计入
- 2024 年报告新增了「返工率」，失败部署恢复时间也从稳定性一侧移到了吞吐一侧
- 2025 年报告不再给出 Elite / High / Medium / Low 四档划分，网上常见的「Elite：前置时间小于 1 小时、失败率小于 5%」属于旧版分档，只能作历史参考
- 指标用来看团队自己的趋势，不用于团队之间排名，更不能拿来考核个人，否则很快会被「刷数」

---

## 四、关联模块

- 代码质量门禁（SonarQube、JaCoCo、格式化工具）→ [代码质量](/engineering/3_code_quality)
- 构建工具与依赖调解 → [构建工具](/engineering/1_build_tools)；BOM、依赖扫描、许可证与 SBOM → [依赖治理](/engineering/6_dependency_governance)
- REST 约定与统一响应 → [API 设计规范](/engineering/7_api_design_rule)
- 测试分层与 CI 中的测试 → [测试工程总览](/testing/0_overview)
- 多环境配置与 Profile → [配置管理](/spring-boot/6_config)；数据库迁移随发布执行 → [数据库版本迁移](/spring-boot/4_flyway)
- 部署平台 → [Kubernetes](/cloud-native/6_kubernetes)、[Helm](/cloud-native/8_helm)、[Argo CD](/cloud-native/9_argocd)；基础设施变更走 PR → [IaC 工程实践](/cloud-native/12_iac_practice)
- 探针、优雅停机与滚动参数 → [优雅上下线与变更](/high-avail/8_graceful_release)；故障处置与复盘 → [故障应急与复盘](/high-avail/11_incident_response)
- 发布后的监控与告警 → [可观测性总览](/observability/0_overview)
- 密钥管理与漏洞防护 → [应用安全总览](/security/0_overview)

---

## 参考资料

- DORA 指标定义：[DORA's software delivery performance metrics](https://dora.dev/guides/dora-metrics/)
- DORA 研究报告：[DORA Research](https://dora.dev/research/)
- Google SRE 手册：[Site Reliability Engineering](https://sre.google/sre-book/table-of-contents/)
- The DevOps Handbook：[IT Revolution](https://itrevolution.com/product/the-devops-handbook-second-edition/)
- 主干开发：[Trunk Based Development](https://trunkbaseddevelopment.com/)
- 语义化版本：[Semantic Versioning 2.0.0](https://semver.org/)
- 软件供应链等级：[SLSA specification](https://slsa.dev/spec/)
- Jenkins LTS 变更日志：[LTS Changelog](https://www.jenkins.io/changelog-stable/)

---
description: 构建工具、开发工具、代码质量、线上诊断、API 文档、依赖治理与 API 设计规范
---

# 工程效率总览

工程效率模块关注「一个 Java 后端工程师每天手上用的东西」：用 Maven / Gradle 把代码稳定地构建出来，用 IDE 与调试工具写得更快，用静态分析、覆盖率和格式化守住代码质量，用 BOM、扫描、自动升级和 SBOM 管住依赖，用 Arthas / JFR 在线上定位问题，并用统一的 API 设计规范和接口文档让前后端、服务之间少扯皮。

本模块只写「工程内部」的工具与规范：流水线编排、Git 分支模型（全站统一为 trunk-based / GitHub Flow）、制品签名与发布策略在 [DevOps 总览](/devops/0_overview)；单元测试、Mock、集成测试在 [测试工程总览](/testing/0_overview)。

**版本基线（2026 年 10 月）**：JDK 21 LTS（JDK 25 LTS 已发布，新项目可直接选用）；Spring Boot 4.1.x / Spring Framework 7（Boot 4 默认使用 Jackson 3，groupId 为 `tools.jackson.core`）；Spring Cloud 2025.1.x（Oakwood）；Maven 3.9.x（3.9.16，Maven 4.0.0 仍处于 RC 阶段，最新为 rc-7，尚未 GA）；Gradle 9.x（9.8，运行 Gradle 本身需要 JDK 17+）；JaCoCo 0.8.14（支持 Java 25 字节码）；springdoc-openapi 3.x；Arthas 4.x。

![工程效率链路](../assets/engineering/overview-efficiency-map.svg)

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. **先把工程搭稳**：读 [构建工具](./1_build_tools) 掌握生命周期、作用域、依赖调解与多模块结构，再读 [依赖治理](./6_dependency_governance) 建立 BOM、版本约束、漏洞扫描、自动升级和 SBOM 的闭环。
2. **再守住质量**：读 [代码质量](./3_code_quality)，把 Sonar 质量门禁、JaCoCo 覆盖率和格式化检查接进构建。
3. **统一接口约定**：读 [API 设计规范](./7_api_design_rule) 定下 URL、状态码、错误格式与版本策略，再读 [API 文档](./5_api_doc) 让文档从代码生成并进入 CI。
4. **提升日常效率**：按需读 [开发工具](./2_dev_tools)，调整 IDE、远程调试与接口调试工具。
5. **线上问题定位**：读 [线上诊断](./4_diagnosis) 掌握 Arthas 的常用命令与容器环境下的注意事项。

本模块没有面试题单与答案页：内容以工具用法和团队规范为主，相关面试点分散在 Java、JVM、Spring Boot 等模块的答案页中。

---

## 三、关联模块

- CI/CD 流水线 → [CI/CD](/devops/2_ci_cd)；Git 工作流 → [Git 工作流](/devops/1_git_workflow)
- PR 模板与评审清单 → [Code Review](/devops/3_code_review)；命名与代码坏味道示例 → [开发规范](/devops/4_dev_standards)
- Nexus、镜像标签、制品签名与溯源 → [制品与版本管理](/devops/6_artifact_version)
- Lombok / MapStruct / Guava 等效率库 → [效率工具库](/java/98_dev_tool)
- JDK 自带诊断工具（jstack / jmap / jcmd / JFR）→ [诊断工具](/jvm/8_monitoring_tools)；按故障类型排查 → [故障排查](/jvm/9_troubleshooting)
- async-profiler 与火焰图 → [性能分析工具](/high-perf/3_profilers)
- 测试体系 → [测试工程总览](/testing/0_overview)；Spring Boot 测试切片 → [Spring Boot 测试](/spring-boot/13_testing)
- SpringDoc 集成细节 → [接口文档](/spring-boot/10_api_doc)；Boot 版本升级 → [Spring Boot 版本演进](/spring-boot/11_versions)
- 接口幂等 → [幂等设计](/architecture/5_idempotence)；接口鉴权、限流与签名 → [API 安全](/security/6_api_security)

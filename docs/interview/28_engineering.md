---
description: 依赖调解与 BOM、构建与质量门禁、覆盖率、Arthas 线上诊断、API 设计与版本规范
---

# 工程效率面试题解答

> 题目清单见 [工程效率面试题](/engineering/99_interview)，细节见 [工程效率总览](/engineering/0_overview)；分支、CI/CD 与发布见 [DevOps 面试题解答](/interview/27_devops)。
>
> 版本基线：Maven 3.9、Gradle 9、Arthas 4.x、JDK 21 / Spring Boot 4。

## 一、构建、依赖与代码质量

### Q1：Maven 依赖冲突怎么调解？为什么会出现 `NoSuchMethodError`？

**一句话**：同一构件出现多个版本时，Maven 按「最短路径优先、同深度先声明优先」只留一个，**不比较版本高低**，近的低版本会压过远的高版本，运行时就可能找不到新方法。

- Gradle 默认选最高版本，同一棵依赖树在两种工具里可能解析出不同结果
- 排查用 `mvn dependency:tree` 看清谁赢了；类到底从哪个 jar 加载，线上可用 Arthas `sc -d` 看 code-source
- 修正首选 `dependencyManagement`：它压过调解规则，对传递依赖也生效
- 不该出现的传递依赖用 `<exclusions>` 整个剔除
- 让冲突在构建期失败：enforcer 的 `requireUpperBoundDeps`（防近的低版本压过高版本）、`dependencyConvergence`（最严格）

→ 详见 [构建工具](/engineering/1_build_tools#三、依赖调解)

### Q2：BOM 是什么？多个 BOM 管同一个库时谁生效？

**一句话**：BOM 是只含 `dependencyManagement` 的 POM，`type=pom` + `scope=import` 导入后它管理的构件都不用写版本；版本优先级是「直接写的 > 本 POM 显式管理 > 先 import 的 BOM > 后 import 的 BOM > 调解」。

- BOM 导入必须写在 `<dependencyManagement>` 里，`import` 作用域只在这里合法
- 想让某个 BOM 赢，就把它放在前面，或者在自己的 `dependencyManagement` 里显式写
- 继承 `spring-boot-starter-parent` 时，子 POM 再 import 新的 Jackson / Netty BOM 不会生效，要用 parent 的版本属性覆盖
- 团队自定义 BOM 不要继承 Boot parent，否则会把 Boot 的全部托管版本带进来
- 修漏洞临时覆盖版本时写清 CVE 编号和「Boot 升到哪版后删除」，否则会悄悄把版本钉死

→ 详见 [依赖治理](/engineering/2_dependency_governance#二、bom-策略)

### Q3：依赖漏洞和许可证风险怎么治理？

**一句话**：按「声明 → 约束 → 扫描 → 研判 → 升级 → 合规留档」做成闭环：统一版本来源，自动小步升级，扫描后按可达性分级处理，再用许可证检查和 SBOM 兜底。

- 自动升级：Renovate / Dependabot 二选一，设冷却期，patch 自动合并；每周小步升级比一年后跨大版本便宜得多
- 扫描：PR 上跑快的（OSV-Scanner、Trivy），每天全量跑一次 Dependency-Check；后者要配 NVD API Key 和明确的 CVSS 阈值（默认 11 等于永不失败）
- 研判三问：漏洞函数是否可达、组件是否暴露在外部输入上、有没有修复版本；误报抑制要写理由和 `until` 到期日
- 许可证：MIT / Apache 风险低，GPL 分发需法务评估，AGPL 在 SaaS 场景通常禁用；警惕改成 BSL / SSPL 的项目
- SBOM：Boot parent 已内置 CycloneDX，SBOM 随 jar 发布，可经 `/actuator/sbom` 读取

→ 详见 [依赖治理](/engineering/2_dependency_governance#五、漏洞扫描)、[License 合规](/engineering/2_dependency_governance#六、license-合规)

### Q4：质量门禁怎么设计？覆盖率阈值定多少合适？

**一句话**：每个工具管一件事、一条 `mvn verify` 跑完，Sonar 统一判定；门禁只卡新代码，合并门槛只有一个：Sonar 新代码覆盖率 ≥ 80%。

- 分工：Spotless 管格式、Checkstyle 管规范、SpotBugs / PMD 找缺陷、ArchUnit 守分层、JaCoCo 采覆盖率
- 只卡新代码：老项目一次清零不现实，「存量不追究、增量不放过」；主干开发把新代码基准设为 `main`
- JaCoCo `check` 只做只升不降的整体底线（如 60%），不作合并依据
- `sonar.qualitygate.wait=true` 让门禁失败时这一步失败，再配分支保护的必需检查才真正拦得住
- 覆盖率高不等于测试有效：没断言的测试也能刷到 100%，想看断言质量用变异测试 PIT

**常见坑**：POM 里自定义 `<argLine>` 没写 `@{argLine}`，JaCoCo agent 被覆盖，覆盖率为 0。

→ 详见 [代码质量](/engineering/3_code_quality#一、质量门禁全景)

## 二、线上诊断与 API 设计

### Q5：线上 CPU 飙高、接口变慢，用 Arthas 怎么排查？

**一句话**：先看全局再下钻：`dashboard` 看总览，CPU 高用 `thread -n` 找最忙线程的栈、再用 `profiler` 采火焰图；慢接口用 `trace` 一层层拆耗时，`watch` 看入参返回值。

- `thread -n 3`：直接看到最忙的 3 个线程在执行什么；偶发、分散的热点用内置 async-profiler 采样
- `trace 类 方法`：输出每个子调用的耗时，只展开一层，找到大头后对它再 trace
- `monitor` 定时统计调用次数、失败率和平均耗时；`watch` 看入参、返回值、异常，条件里可用 `#cost` 只抓慢调用
- `tt` 记录调用现场事后查看；版本不对用 `sc -d` + `jad` 确认线上跑的是哪份代码
- 增强命令一律带 `-n` 限次数或加条件，高 QPS 接口上无条件观察会拖慢业务

**常见坑**：`thread -b` 只认 `synchronized`，`ReentrantLock` 的死锁要看 `jstack` 输出。

→ 详见 [线上诊断](/engineering/7_diagnosis#三、按症状选命令)、[方法级观察](/engineering/7_diagnosis#四、方法级观察-watch-trace-stack-monitor-tt)

### Q6：Arthas 的原理是什么？在生产上用要注意什么？

**一句话**：Arthas 通过 JDK 的 Attach API 把 Agent 动态加载进目标 JVM，再用 Instrumentation + ASM 改写类的字节码来观察方法；它本质上是进程内的远程执行入口，要按生产变更来管。

- 附着条件：发起端要完整 JDK、和目标进程同一用户、看到同一个 `/tmp`；容器里 JRE 镜像可用 `kubectl debug --target` 带 JDK 进去
- Spring Boot fat jar 上 `ognl`、`vmtool`、`logger` 要指定 `LaunchedClassLoader`，否则找不到类或改了没效果
- 热修复 `mc` + `retransform` 只能改方法体，效果在 `stop` 后仍保留，只是止血，要尽快走正常发布替换
- `tt -p` 会用记录的参数真实再调用一次，有副作用的方法（下单、扣款）禁止使用
- 安全守则：只监听 `127.0.0.1`、远程连接配密码、输出按敏感数据对待；收尾用 `stop` 而不是 `quit`

→ 详见 [线上诊断](/engineering/7_diagnosis#一、arthas-的附着原理与启动)、[生产诊断安全守则](/engineering/7_diagnosis#八、生产诊断安全守则)

### Q7：REST 接口怎么设计？错误响应用什么格式？

**一句话**：URL 用名词复数、方法表达语义、状态码必须真实；错误统一用 RFC 9457 Problem Details，业务码用稳定的字符串而不是模仿 HTTP 状态码。

- URL：`/api/v1/orders`，小写连字符，嵌套不超过两级；取消、审批这类业务动作用 `POST /orders/{id}/cancel`
- 状态码：创建返回 201 带 `Location`；参数格式错 400，业务规则不满足 422 / 409；并发冲突用 `If-Match` + 412
- 不能出错了也返回 200 再在 body 里写错误码，网关、监控、重试和缓存都会误判
- Problem Details 字段为 `type`、`title`、`status`、`detail`、`instance`，可扩展 `code`、`traceId`；Spring 用 `ProblemDetail` + 继承 `ResponseEntityExceptionHandler`
- 数据格式：时间用带时区的 RFC 3339，64 位 ID 和金额序列化为字符串（JS 超过 2^53 会丢精度）

→ 详见 [API 设计规范](/engineering/4_api_design_rule#二、http-方法与状态码)、[错误响应](/engineering/4_api_design_rule#五、错误响应-problem-details)

### Q8：API 版本怎么管理？旧版本怎么下线？

**一句话**：主版本号放在 URL 路径里，只有破坏性变更才升主版本；旧版本按「并行 → 宣布废弃 → 迁移窗口 → 下线返回 410」的流程退场。

- 兼容变更不升版本：新增响应字段、新增可选参数、放宽校验
- 破坏性变更：删改字段、改字段类型（`int` 改 `long` 也算）、可选改必填、改错误码含义、改 `operationId`
- 判断交给工具：CI 里用 oasdiff 比较两版 OpenAPI 规范，发现破坏性变更就拦下
- 废弃时响应带 `Deprecation`、`Sunset`、`Link` 头；Spring Framework 7 内置版本控制，可由废弃处理器自动输出
- 迁移窗口按调用方统计 v1 调用量逐个跟进，对外 API 通常不少于 6 个月；下线后网关对 v1 返回 `410 Gone`

→ 详见 [API 设计规范](/engineering/4_api_design_rule#八、版本管理)、[废弃与下线](/engineering/4_api_design_rule#九、废弃与下线)

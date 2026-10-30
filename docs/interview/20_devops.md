---
description: 分支与评审、CI/CD、制品与供应链、发布策略、DORA、依赖治理、质量门禁、Arthas 诊断、API 规范
---

# 研发效能面试题解答

> 题目清单见 [DevOps 面试题](/devops/99_interview)、[工程效率面试题](/engineering/99_interview)；细节见 [DevOps 总览](/devops/0_overview)、[工程效率总览](/engineering/0_overview)。
>
> 版本基线：Git 2.56、GitHub Actions、Kubernetes 1.37、Argo Rollouts 1.10、SemVer 2.0.0、SLSA 1.2、Maven 3.9、Gradle 9、Arthas 4.x、JDK 21 / Spring Boot 4。

## 一、Git 工作流与 Code Review

### Q1：主干开发和 Git Flow 有什么区别？怎么选？

**一句话**：主干开发只有 `main` 一个长期分支，功能分支一两天内合回去、在 `main` 上打 tag 发版；Git Flow 多一条 `develop` 和一堆 release / hotfix 分支，只适合要同时维护多个已发布版本的产品。

| 模型 | 长期分支 | 发版方式 | 适合 |
|------|---------|---------|------|
| 主干开发 / GitHub Flow | 只有 `main` | `main` 上打 tag | 持续交付的服务端项目 |
| Git Flow | `main` + `develop` | 从 `release/*` 发版再合回两边 | SDK、私有化部署等多版本产品 |

- 主干开发的前提：`main` 始终可发布，未完成的功能用 Feature Flag（功能开关）藏起来，而不是在分支上囤几周
- 环境差异不靠分支表达，同一个制品从测试环境一路晋级到生产
- 紧急修复也先进 `main`；要给旧版本打补丁时从 tag 拉 `release/1.4.x`，再用 `cherry-pick -x` 把修复摘过去
- Git Flow 的作者 2020 年也写了反思：持续交付的 Web 服务建议改用 GitHub Flow

→ 详见 [Git 工作流](/devops/1_git_workflow#一、分支模型选型)

### Q2：merge、rebase、squash 合并有什么区别？团队怎么约定？

**一句话**：merge 保留分支历史并多出一个合并提交，rebase 把提交挪到最新主干后面、历史是一条直线，squash 把整个 PR 压成一个提交；主干开发一般「`main` 只允许 squash，功能分支用 rebase 跟上主干」。

- squash：一个 PR 对应 `main` 上一个提交，回滚和生成变更日志都方便；分支里的「wip」「改评审意见」不会进主干
- squash 后 PR 标题就是主干上的提交信息，所以 PR 标题必须按 Conventional Commits 写
- 跟上主干用 `git rebase origin/main`，不要反复把 `main` merge 进功能分支
- 变基后强推用 `--force-with-lease --force-if-includes`（远程被别人更新过就拒绝覆盖），只用于自己的分支
- 规则集开启「线性历史 + 只允许 squash」，`main` 上就不会出现合并提交

**常见坑**：撤销一个合并提交要写 `git revert -m 1`，指明保留主干一侧。

→ 详见 [Git 工作流](/devops/1_git_workflow#_4、squash-合并下以-pr-标题为准)、[分支保护规则集](/devops/1_git_workflow#_1、main-的推荐规则集)

### Q3：Conventional Commits 是什么？和版本号有什么关系？

**一句话**：一种提交信息格式 `type(scope)!: subject`，type 写清这次改了什么性质的东西，工具就能据此自动算下一个版本号、生成变更日志。

- `feat` → 次版本号 +1，`fix` → 修订号 +1；任何 type 带 `!` 或 `BREAKING CHANGE` 脚注 → 主版本号 +1
- `refactor`、`docs`、`test`、`build`、`ci`、`chore` 不影响版本号
- release-please、semantic-release 这类工具读提交历史自动发版
- 校验放两层：本地钩子（pre-commit 框架或 `core.hooksPath`）尽早提醒，CI 再校验 PR 标题兜底
- 本地钩子能被 `--no-verify` 跳过，所以 CI 那一层不能省

→ 详见 [Git 工作流](/devops/1_git_workflow#四、commit-规范-conventional-commits)

### Q4：怎么把 Code Review 做好？

**一句话**：Review 的目标是让主干代码只变好不变差、顺便共享知识；做法是「先机器后人工」，PR 要小、响应要快，阻塞意见要明确标出来。

- PR 净改动不超过 400 行，首次响应在 1 个工作日内；大改动按「先重构、后行为」拆开
- 格式、测试、静态分析、安全扫描都交给 CI，CI 没绿不请人看；人只看设计、正确性、边界这些机器判断不了的
- 用规则集强制：CODEOWNERS 指派负责人、新提交使旧批准作废、最后一次推送要别人批准、评论全部解决才能合并
- 评论用 Conventional Comments（`issue`、`suggestion`、`nitpick` 等标签），阻塞合并的必须带 `(blocking)`
- AI 评审只提供线索，批准权留给人；AI 写的代码按同一标准审

**常见坑**：把 Review 指标拿去考核个人，结果大家走过场点 Approve。

→ 详见 [Code Review](/devops/2_code_review#二、流程-先机器-后人工)

## 二、CI/CD 与制品

### Q5：持续集成、持续交付、持续部署有什么区别？一条好的流水线做哪些事？

**一句话**：CI 是每次提交自动构建测试；持续交付是每个通过 CI 的提交都能发布、上生产点一下审批；持续部署连这一下都自动。好的流水线「PR 跑门禁、合并后构建一次、tag 只做晋级」。

| 事件 | 跑什么 |
|------|--------|
| PR 指向 main | 编译、测试、质量门禁、安全扫描，作为合并的必需检查 |
| 合并到 main | 构建镜像（只此一次）、签发来源证明、部署 staging |
| 推送 tag `v*` | 找到该提交已有的镜像加版本标签，审批后部署生产 |

- 三条原则：一次构建多处晋级、制品不可变（按 SHA / digest 标识）、门禁前移到 PR 上
- 最小权限：顶层只给 `contents: read`，写权限按 Job 单独申请
- `concurrency` 让 PR 只保留最新一次运行、同一环境串行部署；依赖和镜像层用缓存提速

→ 详见 [CI/CD](/devops/4_ci_cd#一、流水线的组成)

### Q6：为什么要按 digest 部署，而不是部署 `latest`？

**一句话**：tag 是可以被改指向的名字，digest（`image@sha256:...`）是内容哈希、永远指向同一份字节；按 digest 部署才能保证测过的和上线的是同一个东西，也能追溯和回滚。

- `latest` 内容会变，无法追溯；而且 Deployment 里镜像字符串没变，`kubectl set image` 根本不会触发滚动更新
- 回滚就是把 digest 改回上一个；即使有人覆盖了某个 tag，线上也不受影响
- 签名和来源证明也都针对 digest，签 tag 没有意义
- 镜像仓库开启 tag 不可变，release 仓库禁止重复部署同一版本
- 发布时不要重新构建：tag 触发重新 `mvn package` 会产出不同的 digest，等于没测过

→ 详见 [制品与版本管理](/devops/5_artifact_version#_2、按-digest-部署)、[CI/CD 常见坑](/devops/4_ci_cd#九、常见坑)

### Q7：语义化版本怎么递增？Maven 的 SNAPSHOT 和 RELEASE 有什么区别？

**一句话**：SemVer 是 `MAJOR.MINOR.PATCH`，不兼容改动升主版本、兼容的新功能升次版本、修 bug 升修订号；SNAPSHOT 是 Maven 的「开发中、内容会变」的版本，生产只能用不可变的 RELEASE。

| 维度 | SNAPSHOT | RELEASE |
|------|----------|---------|
| 部署 | 每次生成带时间戳的唯一版本 | 一个版本只能部署一次 |
| 依赖解析 | 按策略（默认每天）检查远端更新 | 解析一次后不再变 |
| 适用 | 开发期联调 | 上线、被别人依赖的产物 |

- 预发版本排在正式版之前：`alpha < beta < rc < 正式版`；`+` 后的构建元数据比较时忽略
- `0.y.z` 表示初始开发阶段，任何变更都可能不兼容；已发布版本不得修改，修错只能发新版
- CI 里用 enforcer 的 `requireReleaseDeps` 拦住依赖 SNAPSHOT 的发布

→ 详见 [制品与版本管理](/devops/5_artifact_version#二、版本号规范)

### Q8：软件供应链安全怎么做？签名、SBOM、来源证明分别是什么？

**一句话**：要回答三个问题：镜像里有什么（SBOM）、是不是我们流水线构建的（签名）、用哪份源码哪个流程构建的（来源证明）；然后在部署时强制校验。

- SBOM：机器可读的组件清单，漏洞爆发时几分钟就能查出受影响的服务
- 签名：cosign keyless 模式不用管私钥，用 CI 的 OIDC 令牌换短期证书，签名记录进公开透明日志
- 来源证明（Provenance）：记录哪个仓库、哪个提交、哪个 workflow 构建，格式遵循 SLSA，GitHub 用 `actions/attest` 生成
- SLSA 构建等级：L1 有来源证明、L2 由托管平台签名、L3 构建环境隔离、证明无法篡改
- 部署防线：集群准入用 Kyverno `ImageValidatingPolicy` 拒绝未签名的镜像，先 Audit 观察再切 Deny

→ 详见 [制品与版本管理](/devops/5_artifact_version#六、供应链安全-签名、溯源与部署验证)

### Q9：CI 流水线本身有哪些安全风险？怎么防？

**一句话**：流水线手里有制品仓库和集群的写权限，是供应链攻击的首选目标；核心做法是第三方 Action 固定 SHA、部署用 OIDC 短期凭证、不执行陌生人的代码、用户输入不直接拼进 Shell。

- 固定到完整提交 SHA：2026 年 3 月 trivy-action 的版本标签被强推到恶意提交，只有按 SHA 引用的流水线没中招
- OIDC 代替长期密钥：GitHub 签发的令牌只有几分钟有效，去云上换来的临时凭证默认 1 小时，仓库里没有能泄露的 AccessKey
- 不要用 `pull_request_target` 检出 fork 代码：等于拿仓库权限执行陌生人的代码
- 表达式注入：PR 标题这类用户可控内容先放进 `env`，再在 `run` 里引用
- 生产环境配必需审批人，审批前 Job 连 OIDC 令牌都拿不到

→ 详见 [CI/CD](/devops/4_ci_cd#六、流水线自身的安全)

### Q10：多环境怎么划分？环境差异怎么处理？

**一句话**：一般分 dev / test / staging / prod 四层，四个环境跑同一个镜像 digest，差异只来自注入的配置和密钥；晋级的是制品，不是代码。

- dev 做 PR 预览，test 跟随 `main`，staging 与生产同规格，prod 只部署 staging 验证过的 digest
- 晋级落地为改 GitOps 仓库中对应环境的 digest，回滚就是 `git revert`
- Jar 里不写默认激活的 Profile：漏配环境变量时宁可启动失败，也不要带着 dev 配置静默运行
- 密钥不进 Git：K8s Secret 只是 Base64，用 External Secrets、Sealed Secrets 或 Vault；各环境凭证互不相同
- Namespace 不是安全边界：生产用独立集群，非生产按命名空间隔离并配额度和网络策略

→ 详见 [环境管理](/devops/6_env_management#一、标准四环境分层)

## 三、发布策略与度量

### Q11：滚动、蓝绿、金丝雀发布有什么区别？怎么选？

**一句话**：滚动是分批替换实例，蓝绿是两套完整环境一次切全部流量，金丝雀是先放一小部分流量看指标再逐步放大；默认滚动，高风险变更用金丝雀，新旧版本不能共存时用蓝绿。

| 方式 | 回滚速度 | 额外资源 | 适用 |
|------|---------|---------|------|
| 滚动 | 慢（再滚一遍） | 少 | 常规迭代、无状态服务 |
| 蓝绿 | 秒级（切回旧环境） | 双倍 | 重大版本、不能新旧并存 |
| 金丝雀 | 快（权重归零） | 少 | 核心链路、高风险变更 |

- 滚动用 `maxUnavailable: 0` + `maxSurge` 保证可用实例不减少；新旧版本会同时处理请求，接口和表结构要前后兼容
- 蓝绿切换不是瞬时的：长连接还会留在旧环境，旧环境要保留到观察期结束
- 金丝雀按比例分流要靠入口层权重（Gateway API HTTPRoute）；Argo Rollouts 能按步骤放量、用 Prometheus 指标自动分析，不达标自动回滚

→ 详见 [发布策略](/devops/7_release_strategy#一、发布方式全景)、[渐进式交付](/devops/7_release_strategy#五、渐进式交付-argo-rollouts)

### Q12：Feature Flag（功能开关）解决什么问题？有什么成本？

**一句话**：开关把「部署」和「发布」分开：代码先上线但默认关闭，再按用户、租户、比例逐步打开，出问题关开关就止损，比回滚部署快得多。

- 主干开发靠它让半成品安全合入 `main`，不用长期分支
- 典型放量：内部账号 → 1% → 5% → 全量，每一步看和金丝雀相同的 SLO 指标
- 配置中心实现时用 `@ConfigurationProperties` 承载，才能随配置推送刷新；`@Value` 字段拿不到新值
- 开关是技术债：发布开关全量后 1–2 个迭代内删掉，每个开关登记负责人和预计删除时间
- 开关多了用专业平台，OpenFeature 提供与厂商无关的 API；生产开关修改要留审计

→ 详见 [环境管理 · 功能开关](/devops/6_env_management#五、功能开关-feature-flag)、[发布策略](/devops/7_release_strategy#六、功能开关与暗发布)

### Q13：发布出问题怎么回滚？数据库变更怎么保证能回滚？

**一句话**：第一原则是「代码可以随时退，数据不能退」；代码按发布方式各有回滚手段，表结构按「先扩展后收缩」演进，让回滚代码时不需要回滚数据。

- 滚动：`kubectl rollout undo`；蓝绿：selector 指回旧版本；金丝雀：`argo rollouts abort` 权重归零；开关：直接关
- 用了 Argo CD 自动同步时，回滚要在配置仓库 `git revert`，直接改集群会被同步改回去
- 扩展：新增列（可空或有默认值），新代码双写新旧字段
- 迁移：回填历史数据，切换为读新字段；收缩：观察至少一个发布周期后再删旧列
- 改列名、改类型同样拆成「加新列 → 双写 → 切读 → 删旧列」

**常见坑**：发布脚本 `ADD COLUMN`、回滚脚本 `DROP COLUMN`，一回滚就丢掉发布后写入的数据。

→ 详见 [发布策略](/devops/7_release_strategy#八、回滚)

### Q14：DORA 指标有哪些？怎么用？

**一句话**：DORA 是衡量软件交付效能的通用标尺，目前五项：三项看吞吐（快不快），两项看不稳定性（稳不稳），研究结论是两者并不冲突。

| 类别 | 指标 | 含义 |
|------|------|------|
| 吞吐 | 变更前置时间 | 代码提交到上生产的时长 |
| 吞吐 | 部署频率 | 一段时间内生产部署的次数 |
| 吞吐 | 失败部署恢复时间 | 失败部署从发生到恢复的时长 |
| 不稳定性 | 变更失败率 | 部署后需要回滚或热修复的比例 |
| 不稳定性 | 部署返工率 | 由生产事故触发的计划外部署占比 |

- 旧的 MTTR 已改为「失败部署恢复时间」，只算变更引起的故障；返工率是 2024 年新增的
- 2025 年报告不再给 Elite / High / Medium / Low 分档，网上的「Elite 前置时间小于 1 小时」只是旧版参考
- 只看团队自己的趋势，不在团队间排名、更不能考核个人，否则很快被刷数

→ 详见 [DevOps 总览](/devops/0_overview#三、交付效能度量-dora)

## 四、构建、依赖与代码质量

### Q15：Maven 依赖冲突怎么调解？为什么会出现 `NoSuchMethodError`？

**一句话**：同一构件出现多个版本时，Maven 按「最短路径优先、同深度先声明优先」只留一个，**不比较版本高低**，近的低版本会压过远的高版本，运行时就可能找不到新方法。

- Gradle 默认选最高版本，同一棵依赖树在两种工具里可能解析出不同结果
- 排查用 `mvn dependency:tree` 看清谁赢了；类到底从哪个 jar 加载，线上可用 Arthas `sc -d` 看 code-source
- 修正首选 `dependencyManagement`：它压过调解规则，对传递依赖也生效
- 不该出现的传递依赖用 `<exclusions>` 整个剔除
- 让冲突在构建期失败：enforcer 的 `requireUpperBoundDeps`（防近的低版本压过高版本）、`dependencyConvergence`（最严格）

→ 详见 [构建工具](/engineering/1_build_tools#三、依赖调解)

### Q16：BOM 是什么？多个 BOM 管同一个库时谁生效？

**一句话**：BOM 是只含 `dependencyManagement` 的 POM，`type=pom` + `scope=import` 导入后它管理的构件都不用写版本；版本优先级是「直接写的 > 本 POM 显式管理 > 先 import 的 BOM > 后 import 的 BOM > 调解」。

- BOM 导入必须写在 `<dependencyManagement>` 里，`import` 作用域只在这里合法
- 想让某个 BOM 赢，就把它放在前面，或者在自己的 `dependencyManagement` 里显式写
- 继承 `spring-boot-starter-parent` 时，子 POM 再 import 新的 Jackson / Netty BOM 不会生效，要用 parent 的版本属性覆盖
- 团队自定义 BOM 不要继承 Boot parent，否则会把 Boot 的全部托管版本带进来
- 修漏洞临时覆盖版本时写清 CVE 编号和「Boot 升到哪版后删除」，否则会悄悄把版本钉死

→ 详见 [依赖治理](/engineering/2_dependency_governance#二、bom-策略)

### Q17：依赖漏洞和许可证风险怎么治理？

**一句话**：按「声明 → 约束 → 扫描 → 研判 → 升级 → 合规留档」做成闭环：统一版本来源，自动小步升级，扫描后按可达性分级处理，再用许可证检查和 SBOM 兜底。

- 自动升级：Renovate / Dependabot 二选一，设冷却期，patch 自动合并；每周小步升级比一年后跨大版本便宜得多
- 扫描：PR 上跑快的（OSV-Scanner、Trivy），每天全量跑一次 Dependency-Check；后者要配 NVD API Key 和明确的 CVSS 阈值（默认 11 等于永不失败）
- 研判三问：漏洞函数是否可达、组件是否暴露在外部输入上、有没有修复版本；误报抑制要写理由和 `until` 到期日
- 许可证：MIT / Apache 风险低，GPL 分发需法务评估，AGPL 在 SaaS 场景通常禁用；警惕改成 BSL / SSPL 的项目
- SBOM：Boot parent 已内置 CycloneDX，SBOM 随 jar 发布，可经 `/actuator/sbom` 读取

→ 详见 [依赖治理](/engineering/2_dependency_governance#五、漏洞扫描)、[License 合规](/engineering/2_dependency_governance#六、license-合规)

### Q18：质量门禁怎么设计？覆盖率阈值定多少合适？

**一句话**：每个工具管一件事、一条 `mvn verify` 跑完，Sonar 统一判定；门禁只卡新代码，合并门槛只有一个：Sonar 新代码覆盖率 ≥ 80%。

- 分工：Spotless 管格式、Checkstyle 管规范、SpotBugs / PMD 找缺陷、ArchUnit 守分层、JaCoCo 采覆盖率
- 只卡新代码：老项目一次清零不现实，「存量不追究、增量不放过」；主干开发把新代码基准设为 `main`
- JaCoCo `check` 只做只升不降的整体底线（如 60%），不作合并依据
- `sonar.qualitygate.wait=true` 让门禁失败时这一步失败，再配分支保护的必需检查才真正拦得住
- 覆盖率高不等于测试有效：没断言的测试也能刷到 100%，想看断言质量用变异测试 PIT

**常见坑**：POM 里自定义 `<argLine>` 没写 `@{argLine}`，JaCoCo agent 被覆盖，覆盖率为 0。

→ 详见 [代码质量](/engineering/3_code_quality#一、质量门禁全景)

## 五、线上诊断与 API 设计

### Q19：线上 CPU 飙高、接口变慢，用 Arthas 怎么排查？

**一句话**：先看全局再下钻：`dashboard` 看总览，CPU 高用 `thread -n` 找最忙线程的栈、再用 `profiler` 采火焰图；慢接口用 `trace` 一层层拆耗时，`watch` 看入参返回值。

- `thread -n 3`：直接看到最忙的 3 个线程在执行什么；偶发、分散的热点用内置 async-profiler 采样
- `trace 类 方法`：输出每个子调用的耗时，只展开一层，找到大头后对它再 trace
- `monitor` 定时统计调用次数、失败率和平均耗时；`watch` 看入参、返回值、异常，条件里可用 `#cost` 只抓慢调用
- `tt` 记录调用现场事后查看；版本不对用 `sc -d` + `jad` 确认线上跑的是哪份代码
- 增强命令一律带 `-n` 限次数或加条件，高 QPS 接口上无条件观察会拖慢业务

**常见坑**：`thread -b` 只认 `synchronized`，`ReentrantLock` 的死锁要看 `jstack` 输出。

→ 详见 [线上诊断](/engineering/7_diagnosis#三、按症状选命令)、[方法级观察](/engineering/7_diagnosis#四、方法级观察-watch-trace-stack-monitor-tt)

### Q20：Arthas 的原理是什么？在生产上用要注意什么？

**一句话**：Arthas 通过 JDK 的 Attach API 把 Agent 动态加载进目标 JVM，再用 Instrumentation + ASM 改写类的字节码来观察方法；它本质上是进程内的远程执行入口，要按生产变更来管。

- 附着条件：发起端要完整 JDK、和目标进程同一用户、看到同一个 `/tmp`；容器里 JRE 镜像可用 `kubectl debug --target` 带 JDK 进去
- Spring Boot fat jar 上 `ognl`、`vmtool`、`logger` 要指定 `LaunchedClassLoader`，否则找不到类或改了没效果
- 热修复 `mc` + `retransform` 只能改方法体，效果在 `stop` 后仍保留，只是止血，要尽快走正常发布替换
- `tt -p` 会用记录的参数真实再调用一次，有副作用的方法（下单、扣款）禁止使用
- 安全守则：只监听 `127.0.0.1`、远程连接配密码、输出按敏感数据对待；收尾用 `stop` 而不是 `quit`

→ 详见 [线上诊断](/engineering/7_diagnosis#一、arthas-的附着原理与启动)、[生产诊断安全守则](/engineering/7_diagnosis#八、生产诊断安全守则)

### Q21：REST 接口怎么设计？错误响应用什么格式？

**一句话**：URL 用名词复数、方法表达语义、状态码必须真实；错误统一用 RFC 9457 Problem Details，业务码用稳定的字符串而不是模仿 HTTP 状态码。

- URL：`/api/v1/orders`，小写连字符，嵌套不超过两级；取消、审批这类业务动作用 `POST /orders/{id}/cancel`
- 状态码：创建返回 201 带 `Location`；参数格式错 400，业务规则不满足 422 / 409；并发冲突用 `If-Match` + 412
- 不能出错了也返回 200 再在 body 里写错误码，网关、监控、重试和缓存都会误判
- Problem Details 字段为 `type`、`title`、`status`、`detail`、`instance`，可扩展 `code`、`traceId`；Spring 用 `ProblemDetail` + 继承 `ResponseEntityExceptionHandler`
- 数据格式：时间用带时区的 RFC 3339，64 位 ID 和金额序列化为字符串（JS 超过 2^53 会丢精度）

→ 详见 [API 设计规范](/engineering/4_api_design_rule#二、http-方法与状态码)、[错误响应](/engineering/4_api_design_rule#五、错误响应-problem-details)

### Q22：API 版本怎么管理？旧版本怎么下线？

**一句话**：主版本号放在 URL 路径里，只有破坏性变更才升主版本；旧版本按「并行 → 宣布废弃 → 迁移窗口 → 下线返回 410」的流程退场。

- 兼容变更不升版本：新增响应字段、新增可选参数、放宽校验
- 破坏性变更：删改字段、改字段类型（`int` 改 `long` 也算）、可选改必填、改错误码含义、改 `operationId`
- 判断交给工具：CI 里用 oasdiff 比较两版 OpenAPI 规范，发现破坏性变更就拦下
- 废弃时响应带 `Deprecation`、`Sunset`、`Link` 头；Spring Framework 7 内置版本控制，可由废弃处理器自动输出
- 迁移窗口按调用方统计 v1 调用量逐个跟进，对外 API 通常不少于 6 个月；下线后网关对 v1 返回 `410 Gone`

→ 详见 [API 设计规范](/engineering/4_api_design_rule#八、版本管理)、[废弃与下线](/engineering/4_api_design_rule#九、废弃与下线)

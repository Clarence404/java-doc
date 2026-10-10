---
description: PR 规模与流程、CODEOWNERS 与规则集、PR 模板、检查清单、评论规范、AI 辅助
---

# Code Review

> 前置阅读：[Git 工作流](./1_git_workflow)、[CI/CD](./2_ci_cd)

在主干开发下 PR 是合入 `main` 的唯一入口，Code Review 就是主干质量的最后一道人工关口。本篇讲 PR 大小与响应时限、CODEOWNERS 与规则集、PR 模板与检查清单、评论写法和 AI 辅助 Review，是 **PR 模板与 Review 检查清单的唯一出处**。

---

## 一、原则：Review 的目的和底线

### 1、为什么要 Review

Review 首先保证**主干代码整体健康度只升不降**，其次是知识共享：至少两个人理解每一处改动，减少「只有他能改」的模块。它不是挑错比赛，也不是作者的考试。Google 工程实践的标准很务实：只要改动确实改善了代码库的整体状况，就应该批准，哪怕它不完美。

### 2、团队约定

| 约定 | 本站建议 | 说明 |
|------|----------|------|
| PR 大小 | 净改动不超过 **400 行**（不含生成代码、锁文件） | 超过 400 行的 Review 发现问题的效率明显下降；Google 的经验是 100 行左右合适、1000 行基本过大 |
| 首次响应 | **1 个工作日内** | 先给出第一轮意见，而不是一次看完；被阻塞的作者会切换上下文，代价比 Review 本身更大 |
| 批准人数 | 至少 1 名，涉及的目录需 Code Owner 批准 | 用规则集强制，见第三节 |
| 对事不对人 | 评论针对代码，不针对作者 | 用「这里」「这个方法」，避免「你又……」 |
| 分清轻重 | 阻塞问题必须标明，风格偏好不阻塞 | 用第六节的 Conventional Comments 标签区分 |
| 看不懂就问 | Reviewer 看不懂是信号 | 要么代码需要简化，要么缺注释或文档，都应在 PR 里解决 |

::: tip 大改动怎么拆
按「先重构、后行为」拆：第一个 PR 只做纯重构（提取方法、移动类，行为不变），第二个 PR 在新结构上加功能；数据库变更、接口新增字段、调用方切换各自独立成 PR。未完成的功能用特性开关隐藏，允许半成品安全地进入主干，这也是主干开发能成立的前提。
:::

---

## 二、流程：先机器，后人工

![PR 从提交到合并的流程](../assets/devops/code-review-flow.svg)

人的注意力很贵，凡是机器能判断的事都不应该占用 Reviewer：

| 阶段 | 由谁负责 | 内容 | 详见 |
|------|----------|------|------|
| 作者自检 | 作者 | 拆分 PR、填写模板、本地构建通过、自己先通读一遍 diff | 第四节 |
| 自动检查 | CI | 编译、单元 / 集成测试、格式检查（Spotless / Checkstyle）、静态分析与覆盖率（SonarQube / JaCoCo） | [CI/CD](./2_ci_cd)、[代码质量](/engineering/3_code_quality) |
| 安全扫描 | CI / 平台 | CodeQL 等 SAST、密钥扫描（推送保护）、依赖漏洞扫描 | [漏洞防护](/security/8_vulnerabilities)、[依赖治理](/engineering/6_dependency_governance) |
| AI 预审 | 机器人（可选） | 自动留下评论和修改建议，供作者和 Reviewer 参考 | 第七节 |
| 人工 Review | Reviewer / Code Owner | 设计、正确性、边界、可维护性等机器判断不了的问题 | 第五节 |
| 合并 | 作者 | 所有必需检查通过、阻塞评论已解决后 Squash 合并到 `main` | [Git 工作流](./1_git_workflow) |

几条执行细节：

- **CI 没绿不请人看**：草稿 PR（Draft）阶段可以先跑流水线，绿了再转为 Ready for review
- **格式问题不在评论里讨论**：格式由格式化工具在 CI 中强制，Reviewer 看到格式差异说明工具配置有缺口，应修工具而不是写评论
- **作者推送新提交后，旧批准作废**：防止「批准后又偷偷改了一大块」，由规则集的 dismiss stale approvals 实现

---

## 三、仓库配置：CODEOWNERS 与规则集

### 1、CODEOWNERS：自动指派负责人

在 `.github/CODEOWNERS`（也可放在仓库根目录或 `docs/`）里按路径声明负责人。PR 触及对应路径时，GitHub 自动把负责人加为 Reviewer：

```text
# 语法与 .gitignore 类似；同一文件匹配多行时，最后一条匹配生效，所以兜底规则放最前
*                         @acme/backend-leads

/order-service/           @acme/order-team
/payment-service/         @acme/payment-team @acme/security
**/db/migration/          @acme/dba
/.github/workflows/       @acme/platform
/.github/CODEOWNERS       @acme/backend-leads
```

注意几点：

- 负责人必须对仓库有写权限，团队写法是 `@组织/团队`
- 把 `CODEOWNERS` 文件本身也纳入保护，否则任何人都能改掉负责人
- 数据库迁移脚本、CI 配置、鉴权与支付模块这类「改错代价大」的路径，单独指定负责人

### 2、规则集：把约定变成强制

在仓库（或组织）的 Settings → Rules → Rulesets 中为 `main` 建一个规则集，推荐开启：

| 规则 | 作用 |
|------|------|
| Require a pull request before merging | 禁止直接推送 `main` |
| Required approvals：1（核心仓库 2） | 最少批准人数 |
| Dismiss stale pull request approvals when new commits are pushed | 新提交使旧批准失效 |
| Require review from Code Owners | 涉及的路径必须由对应 Code Owner 批准 |
| Require approval of the most recent reviewable push | 最后一次推送必须由推送者以外的人批准，防止自己给自己放行 |
| Require conversation resolution before merging | 所有评论线程解决后才能合并 |
| Require status checks to pass | 指定 CI 中的构建、测试、扫描任务为必需检查 |
| Require code scanning results | CodeQL 等扫描出高危告警时阻止合并 |
| Allowed merge methods：Squash | 主干上一 PR 一提交，便于回滚和追溯 |

规则集比旧的分支保护规则更灵活：可以一次作用于多个分支、在组织层统一下发，并可设置旁路名单（例如发布机器人）。旁路名单要尽量短，且定期审计。

---

## 四、作者职责与 PR 模板

### 1、提交前自检

- 本地构建和测试通过，没有被注释掉的测试
- diff 自己先完整看一遍：没有调试输出、临时代码、无关的格式化改动
- 变更聚焦一件事；顺手发现的问题另开 PR
- 说明「为什么」：背景、方案取舍、影响范围和风险，以及 Reviewer 应重点看哪里
- 涉及数据库迁移、配置项、对外接口变更时，写明兼容性和回滚方式
- 对 AI 工具生成的代码同样逐行理解，作者对提交的每一行负责

### 2、PR 模板（全站统一版本）

放在 `.github/pull_request_template.md`（也支持仓库根目录或 `docs/` 下），新建 PR 时自动填充：

```markdown
## 背景与目标
<!-- 为什么要做这次改动？关联需求或问题单 -->
Closes #

## 变更内容
<!-- 做了什么；有方案取舍时说明为什么选这个 -->

## 变更类型
- [ ] feat 新功能
- [ ] fix 缺陷修复
- [ ] refactor 重构（不改变行为）
- [ ] perf 性能优化
- [ ] docs / test / chore

## 影响与风险
- [ ] 涉及数据库迁移（说明是否向后兼容、如何回滚）
- [ ] 涉及对外接口或消息格式变更（说明兼容策略）
- [ ] 涉及配置项或特性开关（列出名称与默认值）
- [ ] 无上述影响

## 测试
- [ ] 新增或更新了单元测试，覆盖核心分支与异常路径
- [ ] 集成测试 / 手工验证（写明场景）

## 自检
- [ ] CI 全部通过
- [ ] 无调试代码、无敏感信息（密钥、密码、真实用户数据）
- [ ] 变更聚焦，净改动不超过 400 行（超出请说明原因）

## 请 Reviewer 重点关注
<!-- 指出最需要把关的地方，例如并发处理、边界条件 -->
```

变更类型与 [Git 工作流](./1_git_workflow) 中的 Conventional Commits 类型保持一致，Squash 合并时 PR 标题直接作为主干上的提交信息，所以 **PR 标题也按 `type(scope): subject` 写**。

---

## 五、Reviewer 检查清单（全站统一版本）

按「影响从大到小」看：先确认方向对，再看细节。下面每一项对应的代码正反例见 [开发规范](./4_dev_standards)。

具体的代码坏味道正反例集中在 [开发规范](./4_dev_standards)，这里只列检查项。

### 1、设计与正确性（阻塞级）

- [ ] 改动解决的是 PR 描述里的问题，方案没有明显更简单的替代
- [ ] 职责放在正确的层：Controller 不写业务，Service 不拼 SQL，领域逻辑不依赖框架细节
- [ ] 边界条件：`null`、空集合、零与负数、超长输入、时区与跨天
- [ ] 异常处理：没有吞异常，没有「记录日志后又抛出」导致重复记录，业务异常与系统异常区分清楚
- [ ] 事务边界正确：`@Transactional` 不在同类自调用中失效，事务内不做远程调用
- [ ] 金额用 `BigDecimal` 且显式指定精度与舍入方式

### 2、并发与资源（阻塞级）

- [ ] 共享可变状态有正确的同步，非线程安全类（如 `SimpleDateFormat`）没有被共享
- [ ] 线程池有界、有名字、有拒绝策略；IO 密集场景考虑虚拟线程
- [ ] `ThreadLocal` 在 `finally` 中清理；流、连接用 try-with-resources 关闭
- [ ] 外部调用都设置了超时，重试有上限且接口幂等

### 3、安全（阻塞级）

- [ ] SQL 全部参数化，MyBatis 中没有用 `${}` 拼接用户输入
- [ ] 接口有鉴权，并校验数据归属（防止越权访问他人数据）
- [ ] 日志、异常信息、接口响应中没有密码、Token、完整证件号或手机号
- [ ] 输入做了校验，上传文件校验类型和大小

### 4、性能（视影响定级）

- [ ] 没有循环内查库或远程调用（N+1），批量操作有分批
- [ ] 新增查询有合适的索引，没有大表全表扫描
- [ ] 没有一次性把大结果集加载进内存；缓存有过期时间和容量上限

### 5、可维护性与可观测性（一般非阻塞）

- [ ] 命名表达意图，方法短小，没有复制粘贴的重复逻辑
- [ ] 注释解释「为什么」，没有过时注释和无主的 TODO
- [ ] 关键路径有日志（含业务主键与 traceId），新功能有必要的指标

### 6、测试与兼容（阻塞级）

- [ ] 核心分支和异常路径有测试，测试断言的是行为而不是实现细节
- [ ] 数据库迁移向后兼容（先加列、后切换、再删旧列），可在新旧版本并存时运行
- [ ] 对外接口与消息格式向后兼容，或已按废弃流程通知调用方

---

## 六、评论怎么写：Conventional Comments

### 1、格式

[Conventional Comments](https://conventionalcomments.org/) 约定每条评论以「标签 + 可选修饰 + 冒号」开头：

```text
<label> [decorations]: <subject>

[discussion]
```

常用标签：

| 标签 | 含义 | 默认是否阻塞 |
|------|------|--------------|
| `issue` | 指出一个具体问题，最好同时给出建议 | 视修饰而定，通常阻塞 |
| `suggestion` | 提出改进方案，说明改什么、为什么更好 | 视修饰而定 |
| `todo` | 小而必要的修改 | 阻塞 |
| `question` | 有疑虑但不确定，请作者解释或确认 | 否 |
| `nitpick` | 个人偏好层面的小问题 | 否 |
| `thought` | 评审中想到的点子，供参考 | 否 |
| `note` | 提醒读者注意某事 | 否 |
| `chore` | 合并前必须完成的流程性事项（如补变更说明） | 阻塞 |
| `praise` | 真诚的正向反馈 | 否 |

修饰写在标签后的括号里：`(blocking)` 表示不解决不能合并，`(non-blocking)` 表示不阻塞，`(if-minor)` 表示改动很小时才需要处理。团队可以只约定一条规则：**凡是阻塞合并的评论，必须带 `(blocking)`**，没带的作者可以自行决定。

### 2、示例

```text
issue (blocking): userId 直接拼进了 SQL，存在注入风险。
请改成 #{userId} 参数绑定。

suggestion (non-blocking): 这段过滤逻辑可以用 stream().filter(Order::isActive).toList() 表达，
读起来更直接。

question: 这里为什么用同步调用库存服务？如果只是通知，异步消息是否更合适？

nitpick: tmp 改成 pendingOrders 会更清楚。

praise: 用唯一索引兜底幂等，并发重复提交也能挡住，考虑得很周全。
```

### 3、直接给出修改建议

GitHub 评论中可以用 `suggestion` 代码块写出替换后的代码，作者一键提交，适合改名、补判空这类小修改：

````markdown
nitpick: 名字没有表达用途。
```suggestion
List<Order> pendingOrders = orderRepository.findByStatus(OrderStatus.PENDING);
```
````

### 4、Reviewer 的效率技巧

- 先读 PR 描述和测试，再读实现：测试揭示了作者对需求的理解
- 一次集中看完再统一提交（Start a review → Submit），避免逐条通知轰炸作者
- 单次连续 Review 控制在 60 分钟以内，超出就休息或要求拆分
- 意见分歧超过两轮来回，改为当面或语音沟通，结论回写到 PR

---

## 七、AI 辅助 Review

到 2026 年，GitHub Copilot code review 等 AI 评审工具已被很多团队接入 PR 流程，可以通过个人设置或规则集对每个 PR 自动触发。它的定位是**辅助**，不替代人工 Review：

| 方面 | 适合交给 AI | 仍需人工判断 |
|------|-------------|--------------|
| 问题类型 | 明显的空指针、资源未关闭、拼写、重复代码、遗漏的判空 | 方案是否合理、是否符合业务规则、架构边界 |
| 上下文 | 当前 diff 及仓库内可见代码 | 需求背景、线上历史事故、团队约定 |
| 结论 | 给出线索和修改建议 | 是否批准合并 |

落地时注意：

- **批准权留给人**：Copilot 的评审默认不计入必需批准数；即使组织开启了让 AI 参与批准的预览功能，也建议保留至少一名人类 Code Owner 的批准
- **AI 评论按普通评论对待**：作者可以采纳、反驳或忽略，误报不需要强行修改；把高频误报整理进仓库的自定义指令或规则配置
- **AI 生成的代码不降低标准**：无论代码来自人还是 AI，审查标准完全相同，作者对每一行负责，见 [AI 工具](/ai/6_tools/0_ai_tools)
- **注意数据边界**：使用第三方 AI 服务前确认组织的代码外发策略

---

## 八、度量与持续改进

Review 流程是否健康，可以看几个指标（用于发现瓶颈，**不要用作个人考核**，否则会催生走过场的 Approve）：

| 指标 | 含义 | 异常信号 |
|------|------|----------|
| 首次响应时间 | PR 打开到第一条 Review 意见 | 持续超过 1 个工作日 |
| PR 周期时间 | PR 打开到合并 | 大量 PR 挂起数天 |
| PR 规模分布 | 净改动行数的分位数 | 超过 400 行的 PR 占比高 |
| 返工轮次 | 作者因阻塞意见重新推送的次数 | 长期偏高说明需求或设计没在编码前对齐 |

这些指标与 DORA 的变更前置时间直接相关：Review 等待往往是前置时间里最大的一段。

---

## 小结

- Review 的目标是让主干健康度只升不降并共享知识；PR 不超过 400 行、1 个工作日内首次响应
- 先机器后人工：格式、测试、静态分析、安全扫描交给 CI，人只看机器判断不了的设计与正确性
- 用 CODEOWNERS 自动指派负责人，用规则集强制批准人数、Code Owner 批准、新提交使旧批准失效和必需检查
- PR 模板和检查清单以本篇为准；代码正反例见开发规范
- 评论用 Conventional Comments，阻塞意见必须标 `(blocking)`
- AI 评审只提供线索，不替代人工批准；AI 写的代码按同一标准审查

## 参考资料

- Google 工程实践：[Code Review Developer Guide](https://google.github.io/eng-practices/review/)
- Google 工程实践，小改动：[Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
- Google 工程实践，响应速度：[Speed of Code Reviews](https://google.github.io/eng-practices/review/reviewer/speed.html)
- Conventional Comments 规范：[conventionalcomments.org](https://conventionalcomments.org/)
- GitHub 文档，CODEOWNERS：[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- GitHub 文档，规则集可用规则：[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- GitHub 文档，PR 模板：[Creating a pull request template](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository)
- GitHub 文档，评论中的修改建议：[Commenting on a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request)
- GitHub 文档，Copilot 代码评审：[About GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)

> 下一篇：[开发规范](./4_dev_standards)

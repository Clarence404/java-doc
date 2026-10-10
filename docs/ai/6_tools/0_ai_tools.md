---
description: AI 编程工具分类、选型维度、项目规则文件、团队使用规范（审查、测试、密钥与权限）
---

# AI 编程工具怎么选

> 前置阅读：[AI Agent 智能体](../5_advanced/0_agent)、[MCP 协议](../5_advanced/1_mcp)

AI 编程工具分 IDE 助手、编程 Agent CLI、对话助手三类，产品形态与价格几乎每月都在变。本篇不列价格与型号，只讲稳定的选型维度与团队使用规范，具体功能以各家官方文档为准。

---

## 一、工具分类

| 类别 | 形态 | 代表产品 | 擅长 |
|------|------|----------|------|
| **IDE 助手** | IDE 插件或基于编辑器改造的 IDE | GitHub Copilot、Cursor、JetBrains AI Assistant / Junie、Windsurf | 补全、就地修改、在编辑器里对话，也提供 Agent 模式 |
| **编程 Agent CLI** | 终端里运行的 Agent，可读写文件、执行命令 | Claude Code、OpenAI Codex、Gemini CLI | 跨多文件的完整任务：改代码、跑测试、修复、提交 PR，可接入 CI |
| **对话助手** | 网页或桌面聊天应用 | ChatGPT、Claude、Gemini | 方案讨论、解释概念、写文档、分析日志片段 |

三类的边界正在模糊：IDE 助手都有了 Agent 模式，CLI 工具也提供 IDE 插件和桌面、网页界面。选型时看的是**主要工作方式**：以补全和就地修改为主选 IDE 助手，以「交代任务、审查结果」为主选 Agent 类工具，两者经常搭配使用。

---

## 二、选型维度

### 1、IDE 集成

Java 团队的主力 IDE 多是 IntelliJ IDEA，首先确认工具对 JetBrains 系列的支持程度：是原生插件、只提供部分功能，还是要求切换到基于 VS Code 的编辑器。切换 IDE 的成本（快捷键、调试、Maven / Gradle 集成、代码检查）往往比工具本身的差异更大。

### 2、Agent 能力

- **能做什么**：只给建议，还是能直接改多个文件、执行构建与测试命令、根据失败结果自行修复
- **在哪执行**：本地工作区、隔离沙箱，还是云端后台任务（适合长时间运行的批量修改）
- **权限控制**：执行命令、改文件前是否需要确认，能否配置允许和禁止的操作清单
- **与流程集成**：能否在 Pull Request 上做审查、在 CI 中运行、从 Issue 直接领取任务

### 3、上下文处理

- **代码库理解**：是否对整个仓库建索引、能否按需搜索文件，还是只看当前打开的文件
- **项目规则文件**：是否支持在仓库里写约定让工具自动读取，见第三节
- **外部上下文**：是否支持 MCP 接入数据库结构、Issue、内部文档等

### 4、隐私与数据政策

这一项决定能不能用，要由安全或法务一起确认：

- **训练使用**：代码和对话是否会被用于训练模型，企业版默认策略与个人版是否不同
- **数据保留**：请求内容保留多久，是否提供零数据保留选项
- **部署与区域**：能否使用私有部署、指定数据存储区域，或通过自己的云账号调用模型
- **内容排除**：能否配置哪些文件不得被读取或上传

### 5、团队管理

- 单点登录与账号回收、席位分配
- 组织级策略：允许使用的模型、是否允许联网与执行命令、可接入的 MCP Server
- 审计日志与用量报表，便于追溯和成本分摊

### 6、计费模式

常见三种：按席位订阅（每人每月固定费用，含一定额度）、按用量计费（按 Token 或请求次数）、两者混合（订阅包含基础额度，超出部分按量计费）。估算团队成本时用：月成本 ≈ 席位数 × 席位单价 + 超出额度的用量 × 用量单价。Agent 类任务一次就可能消耗大量 Token，试点期间要观察真实用量，再决定采购方式。

### 7、选型检查清单

| 维度 | 要回答的问题 |
|------|--------------|
| IDE 集成 | 团队主力 IDE 是否原生支持？需要换编辑器吗？ |
| Agent 能力 | 能否改多文件、跑测试、自我修复？命令执行能否逐项授权？ |
| 上下文 | 是否理解整个仓库？是否读取项目规则文件？是否支持 MCP？ |
| 数据政策 | 是否用于训练？保留多久？能否排除敏感文件？ |
| 团队管理 | 是否支持 SSO、组织策略、审计日志？ |
| 计费 | 按席位还是按量？试点期间的真实用量是多少？ |

---

## 三、项目规则文件

让 AI 工具遵守项目约定，最有效的办法是把约定写进仓库里的规则文件，工具在每次会话开始时自动读取：

| 文件 | 读取方 |
|------|--------|
| `AGENTS.md` | 跨工具的开放约定，Codex、Cursor、GitHub Copilot 编程 Agent、Gemini CLI、Junie 等均支持，由 Agentic AI Foundation 维护 |
| `CLAUDE.md` | Claude Code；仓库已有 `AGENTS.md` 时也可以读取它 |
| `.github/copilot-instructions.md` | GitHub Copilot 仓库级指令，另可用 `.github/instructions/*.instructions.md` 按路径生效 |
| `.cursor/rules/*.mdc` | Cursor 项目规则 |

建议写入的内容：

- 构建、测试、格式化的命令（如 `./mvnw verify`）
- 技术栈与版本基线（JDK、Spring Boot、主要框架）
- 代码约定：分层结构、命名、异常处理、日志规范、禁止使用的 API
- 禁止事项：不得修改的目录、不得提交的文件、需要人工确认的操作

多个工具并存时，以 `AGENTS.md` 为主，其他文件保持同步或引用它，避免几份规则互相矛盾。本站仓库就同时维护了内容一致的 `CLAUDE.md` 与 `AGENTS.md`。

---

## 四、团队使用规范

### 1、审查 AI 写的代码

- **作者负责制**：提交者对 AI 生成的每一行代码负责，审查标准与人写的代码完全相同，审查流程见 [Code Review](/devops/3_code_review)
- **小步提交**：让 AI 一次只做一件事，生成大段改动时拆成多个 PR，审查者才看得过来
- **重点检查**：边界条件与异常路径、并发与事务、SQL 与输入校验、权限判断，以及「看起来合理但调用了不存在的 API」的幻觉代码
- **依赖要核实**：AI 推荐的依赖包先确认真实存在、来源可信、许可证合规，防止被抢注的同名恶意包混入

### 2、测试

- 用 AI 写测试很高效，但要审查断言是否真的验证了业务规则，而不是对着当前实现「照抄输出」
- 改动必须通过 CI 中的完整测试，不能只看 AI 声称「测试已通过」
- 先让 AI 补齐测试再重构，是降低遗留代码改造风险的好办法；测试分层与工具见 [测试工程总览](/testing/0_overview)

### 3、密钥与敏感数据

- 不要把密钥、令牌、生产数据、客户信息粘贴进对话
- 用工具提供的排除机制阻止读取敏感文件，例如 `.env`、证书、包含凭据的配置
- 密钥只通过环境变量或密钥管理服务注入，仓库启用密钥扫描（如 gitleaks）兜底，避免 AI 顺手把密钥写进代码或日志
- 数据分级与脱敏要求见 [数据安全](/security/7_data_security)

### 4、Agent 的权限

- 本地运行的 Agent 拥有与你相同的系统权限，不要对删除、推送、发布、数据库写入等命令开启自动批准
- 涉及生产环境的操作一律人工执行，Agent 只负责生成命令或脚本供审查
- 只接入可信来源的 MCP Server，并为其配置最小权限，风险说明见 [MCP 协议](../5_advanced/1_mcp)
- 读取外部内容（网页、Issue、依赖源码）时，警惕其中夹带的指令诱导 Agent 执行危险操作

### 5、落地节奏

先选一两个小组试点，约定规则文件和上述规范，跑一到两个迭代后对比交付周期、缺陷率、审查耗时与实际费用，再决定推广范围和采购方式。

---

## 小结

- 三类工具：IDE 助手重补全与就地修改，编程 Agent CLI 重完整任务，对话助手重讨论与解释，常常组合使用
- 选型六个维度：IDE 集成、Agent 能力、上下文处理、数据政策、团队管理、计费模式，其中数据政策是一票否决项
- 用 `AGENTS.md` 等规则文件把构建命令、技术栈、代码约定交给工具，多工具时以 `AGENTS.md` 为主
- 团队规范：作者对 AI 代码负责、测试以 CI 为准、密钥不进对话与仓库、高风险命令不自动批准
- 先试点、再度量、后推广，不追逐每月变化的产品排名

模型的接入方式见 [API 直接接入](../3_integration/1_api_access)。

## 参考资料

- AGENTS.md：[https://agents.md/](https://agents.md/)
- Claude Code 文档：[https://code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview)
- OpenAI Codex：[https://developers.openai.com/codex](https://developers.openai.com/codex)
- Gemini CLI：[https://github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- GitHub Copilot 文档：[https://docs.github.com/en/copilot](https://docs.github.com/en/copilot)
- GitHub Copilot 仓库自定义指令：[https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)
- Cursor 项目规则：[https://cursor.com/docs/context/rules](https://cursor.com/docs/context/rules)
- JetBrains AI Assistant：[https://www.jetbrains.com/help/ai-assistant/](https://www.jetbrains.com/help/ai-assistant/)
- gitleaks：[https://github.com/gitleaks/gitleaks](https://github.com/gitleaks/gitleaks)
- OWASP Top 10 for LLM Applications：[https://genai.owasp.org/llm-top-10/](https://genai.owasp.org/llm-top-10/)

> 返回：[AI 总览](../0_overview)

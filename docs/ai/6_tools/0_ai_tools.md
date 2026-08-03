# AI 工具总览

> 汇总当前主流 AI 产品与开发者工具，覆盖对话助手、编程辅助等方向。
> 最后更新：2026-07-30

## 横向对比

| 工具 | 厂商 | 定位 | 适用场景 |
|------|------|------|---------|
| ChatGPT | OpenAI | 通用对话 / 写作 / 代码 | 日常问答、文档生成、代码辅助 |
| Claude | Anthropic | 长上下文对话 / 代码 | 大文档分析、代码审查、写作 |
| Gemini | Google | 多模态对话 / 搜索增强 | 图文理解、Google 生态集成 |
| Cursor | Anysphere | AI 编程 IDE | 代码补全、重构、云端 Agent |
| GitHub Copilot | GitHub / OpenAI | IDE 插件代码补全 | VS Code / JetBrains 代码辅助 |
| Claude Code | Anthropic | 终端 AI 编程助手 | 命令行代码生成、项目理解 |
| Devin Desktop | Cognition（原 Windsurf） | AI 编程 IDE + 多 Agent 平台 | 代码补全、自主 Agent 执行、多 Agent 协调 |

---

## 一、ChatGPT

> 官网：[https://chatgpt.com](https://chatgpt.com)
> 模型文档：[https://developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models)

ChatGPT 是 OpenAI 面向终端用户的对话产品。旗舰模型已升级至 **GPT-5.6 系列**，上下文窗口达 **1.05M tokens**，知识截止日期为 2026 年 2 月。

**GPT-5.6 三档定位：**

| 模型 | 定位 | API 定价（input/output） |
|------|------|--------------------------|
| **GPT-5.6 Sol** | 旗舰，复杂推理与编码 | $5 / $30 per MTok |
| **GPT-5.6 Terra** | 性能与成本平衡 | $2.50 / $15 per MTok |
| **GPT-5.6 Luna** | 高吞吐、低成本 | $1 / $6 per MTok |

此外还有专用模型：GPT Image 2（图像生成）、GPT-Realtime 系列（语音实时对话）、GPT Transcribe（语音转文字）。

**核心功能：**

- **超长上下文**：1.05M tokens，可处理超大代码库或完整项目文档
- **多模态对话**：文本、图片、文件、语音输入均支持
- **代码执行（Code Interpreter）**：Python 沙箱环境，可处理数据、绘图、文件转换
- **联网搜索**：可检索实时信息，附来源引用
- **Custom GPT / GPT Store**：可创建或使用他人制作的定制化 GPT
- **Projects**：将多轮对话、文件、指令组织成项目，持久化上下文

**订阅：** 免费版有基础额度；**Plus（$20/月）** 可使用 GPT-5.6 Sol 等旗舰模型；**Pro** 提供更高额度和优先访问。

**与 Claude 的差异**：ChatGPT 生态最成熟、插件最丰富，更适合日常通用任务；Claude 在长文档和代码深度分析上更具优势。

---

## 二、Claude & Claude Code

> Claude 官网：[https://claude.ai](https://claude.ai)
> Claude Code 文档：[https://docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)

**Claude（Web/API）** 是 Anthropic 的对话产品，以超长上下文和出色的代码理解能力著称。2026 年 6 月正式发布 **Claude Fable 5**（旗舰）和邀请制的 **Claude Mythos 5**（Project Glasswing）。

**当前模型阵列（2026）：**

| 模型 | 定位 | 上下文 | API 定价（input/output） |
|------|------|--------|--------------------------|
| **Claude Fable 5** | 最强，长时 Agent 任务 | 1M tokens | $10 / $50 per MTok |
| **Claude Mythos 5** | 邀请制，防御性安全工作流 | 1M tokens | 同 Fable 5 |
| **Claude Opus 5** | 复杂 Agentic 编码 / 企业级 | 1M tokens | $5 / $25 per MTok |
| **Claude Sonnet 5** | 速度与智能最佳平衡 | 1M tokens | $3 / $15 per MTok |
| **Claude Haiku 4.5** | 最快，接近前沿水平 | 200K tokens | $1 / $5 per MTok |

**新特性（2025–2026）：**

- **Adaptive Thinking（自适应思考）**：Fable 5、Opus 5、Sonnet 5 均支持，模型根据任务复杂度动态分配推理深度，取代旧的 Extended Thinking 手动参数
- **1M token 上下文**：可放入完整 Java 微服务项目的所有源文件进行整体分析
- **Max 输出 128K tokens**：适合生成完整的单元测试套件或详尽的代码审查报告
- **Claude Cowork**：新增协作功能，支持团队多人共同使用同一 Claude 会话

**订阅计划：**

| 计划 | 价格 | 特性 |
|------|------|------|
| Free | 免费 | 基础对话、代码生成、联网搜索 |
| Pro | $20/月 | 扩展额度、Claude Code、Claude Cowork |
| Max | $100–$200/月 | 5× 或 20× Pro 额度，高峰期优先访问 |
| Team | $20–$100/座/月 | 中央管理、SSO、企业搜索 |
| Enterprise | 定制 | HIPAA、SCIM、审计日志、细粒度权限 |

**Claude Code** 是 Anthropic 官方推出的命令行 AI 编程工具，随 Pro 计划免费提供：

- **终端内对话**：在 shell 中直接与 Claude 对话，无需切换到浏览器
- **文件读写**：可读取、编辑、创建项目文件，理解整个代码库结构
- **命令执行**：可执行 shell 命令（测试、构建、git 操作）并根据输出进行推理
- **MCP 扩展**：通过 MCP（Model Context Protocol）集成外部工具和数据源
- **Hooks 自动化**：配置 pre/post 钩子，在特定操作前后自动执行脚本

**适用场景**：复杂多文件重构、自动化调试修复、代码库整体理解、CI/CD 集成，与 Cursor 的图形化 IDE 体验互补。

---

## 三、Google Gemini

> 官网：[https://gemini.google.com](https://gemini.google.com)
> Google AI Studio：[https://aistudio.google.com](https://aistudio.google.com)

Gemini 已升级至 **3.x 系列**，在超长上下文、多模态理解和 Google 生态集成方面持续领先。

**当前模型（2026）：**

| 模型 | 定位 |
|------|------|
| **Gemini 3.6 Flash** | 编码、知识问答与多模态任务的最高 token 效率 |
| **Gemini 3.5 Flash-Lite** | 高吞吐低成本，适合大规模任务 |
| **Gemini 3.1 Pro** | 复杂任务与创意工作 |
| **Gemini 3.1 Deep Think** | 科学、研究与工程等严苛推理场景 |

**核心功能：**

- **超长上下文**：支持超大代码库、完整视频文件的整体理解
- **Agentic 编码**：Gemini 3.1 Pro / Deep Think 具备多步骤、长时程的自主执行能力
- **Deep Research**：自主规划多步搜索路径，生成带引文的深度研究报告
- **多模态理解**：原生支持图片、PDF、视频帧、音频分析
- **Google Search 集成**：实时联网检索，答案有来源引用
- **Gemini Workspace**：嵌入 Google Docs / Sheets / Gmail / Meet，在办公场景中调用 AI

**与 ChatGPT 的差异**：Gemini 在 Google 生态集成和超长上下文上领先，Deep Research 比 ChatGPT 搜索更深入；但插件市场和第三方集成生态不如 ChatGPT 丰富。

---

## 四、Cursor

> 官网：[https://www.cursor.com](https://www.cursor.com)
> 文档：[https://docs.cursor.com](https://docs.cursor.com)

Cursor 是基于 VSCode 深度改造的 **AI 原生编程 IDE**，已发展为支持云端 Agent 自主执行的完整 AI 开发平台，被超过半数的 Fortune 500 企业采用。

**支持模型（2026）：**Claude Opus 5、GPT-5.6 Sol、Gemini 3.1 Pro、Grok 4.5 等，可切换或自定义 API。

**核心功能：**

| 功能 | 说明 |
|------|------|
| **Tab 智能补全** | 基于上下文的多行代码预测，支持整块代码预测 |
| **Chat（代码问答）** | 侧边栏对话，可引用当前文件、选中代码、整个代码库 |
| **Composer / Agent 模式** | 跨多个文件同时生成/修改代码，完成完整功能实现 |
| **云端 Agent** | 在云端后台独立运行数小时，自主构建、测试、演示功能 |
| **Automations** | 按计划或触发器运行的持续在线 Agent |
| **Design Mode** | 上传 UI 设计稿，直接用界面示意图驱动代码生成 |

**平台扩展（2026 新增）：**

- **Cursor for iPad / iOS**：支持在移动端继续开发工作
- **Terminal 集成**：Agent 直接在终端中工作
- **Slack 协作**：Agent 可在 Slack 频道中协作
- **GitHub PR 审查**：Agent 自动 Review Pull Request
- **Marketplace**：第三方扩展市场

**使用技巧：**

- `Ctrl+K`：内联编辑，选中代码后直接描述要修改的内容
- `Ctrl+L`：打开 Chat 侧边栏，支持 `@文件名`、`@代码库` 引用上下文
- `Ctrl+I`：打开 Composer，适合新增功能、重构模块等多文件任务
- **Cursor Rules**（`.cursorrules` 文件）：为项目定制 AI 行为规范，类似 CLAUDE.md

**与 Claude Code 的差异**：Cursor 是图形化 IDE，上手直观，适合日常编码；Claude Code 是纯命令行，适合深度自动化任务和 CI 集成。

---

## 五、GitHub Copilot

> 官网：[https://github.com/features/copilot](https://github.com/features/copilot)
> 文档：[https://docs.github.com/en/copilot](https://docs.github.com/en/copilot)

GitHub Copilot 是 GitHub（微软）与 OpenAI 合作推出的 **IDE 插件形式**的 AI 编程助手，与 GitHub 仓库和工作流无缝衔接。2026 年进化为支持自主 Agent 执行、多模型选择的完整开发平台。

**订阅计划（2026）：**

| 计划 | 价格 | 特性 |
|------|------|------|
| **Free** | 免费 | 每月 2,000 次补全，基础功能 |
| **Pro** | ~$10/月 | 无限补全，Copilot Chat |
| **Pro+** | $39/月 | 访问高端模型（含 Opus 级别）、审计日志 |
| **Max** | $100/月 | 最高模型优先级、最大额度 |
| **Business** | $19/座/月 | 团队管理、知识库、代码引用检测 |
| **Enterprise** | $39/座/月 | 知识库、PR 摘要、合规审计 |

**产品组成：**

| 组件 | 说明 |
|------|------|
| **Copilot 代码补全** | IDE 内联补全，支持 VS Code、JetBrains、Neovim、Visual Studio |
| **Copilot Chat** | 侧边栏对话，可引用代码、文件、PR、Issue |
| **Copilot Edits** | 跨文件代码修改（类似 Cursor Composer） |
| **Copilot Agents** | 可将任务分配给 Copilot、Claude、OpenAI Codex 等 Agent 自主执行 |
| **Copilot in GitHub.com** | 在 PR、Issue、代码审查页面直接使用 AI |
| **Copilot Extensions** | 集成 Jira、Datadog、Azure 等第三方服务 |

**多模型选择**：可按任务在速度、精度、成本之间选择最优模型，不再锁定单一模型。

**企业版特性：**

- **知识库（Knowledge Bases）**：上传企业私有文档，让 Copilot 理解内部代码规范
- **Pull Request 摘要**：自动生成 PR 描述和变更摘要
- **审计日志**：企业级安全合规，所有请求可审计
- **代码引用检测**：标记补全内容是否来自公开代码库，规避版权风险

**注意**：自 2026 年 4 月起，GitHub 默认将 Free / Pro / Pro+ 用户数据用于模型训练，如需退出须主动关闭此选项。

**与 Cursor 的差异**：Copilot 是轻量插件，不改变原有 IDE 体验，更适合团队统一部署；Cursor 是独立 IDE，AI 能力更激进，适合个人重度用户。

---

## 六、Devin Desktop（原 Windsurf）

> 官网：[https://devin.ai/desktop](https://devin.ai/desktop)（windsurf.com 已永久重定向至此）

原 Codeium 出品的 **Windsurf** 已更名为 **Devin Desktop**，windsurf.com 于 2026 年完成永久重定向。核心 IDE 体验（插件、设置、工作流、JetBrains 支持）完全保留，并在此基础上扩展为 **多 Agent 管理平台**。

**核心功能：**

| 功能 | 说明 |
|------|------|
| **Cascade** | 上下文感知对话，能感知整个代码库的变化历史和依赖关系 |
| **Flows（智能体）** | 多步骤自主执行：读文件 → 修改 → 运行测试 → 修复错误，全程自动 |
| **Supercomplete** | 比普通 Tab 补全更大范围的多行预测 |
| **深度上下文感知** | 自动索引整个代码库，无需手动 `@` 引用文件 |
| **Agent Command Center** | 新增多 Agent 管理中心，包含 Spaces（项目空间）和 Kanban（任务看板）视图 |

**与 Cursor 的对比：**

| 维度 | Cursor | Devin Desktop（原 Windsurf） |
|------|--------|-------------------------------|
| 底层模型 | Claude Opus 5 / GPT-5.6 / Gemini 3.1（可选） | 自研 + Claude / GPT |
| Agent 能力 | Composer + 云端 Agent（成熟） | Flows + Agent Command Center（更自主） |
| 多 Agent | Automations（并行执行） | Spaces + Kanban（可视化协调） |
| 上下文感知 | 手动引用 `@文件` 或自动索引 | 自动感知，减少手动操作 |
| 平台扩展 | iPad / iOS / Slack / GitHub | 主要在桌面端 |
| 适合人群 | 追求精细控制 + 跨平台 | 希望 AI 更自主执行 + 多 Agent 协调 |

> **JetBrains 版本**：Windsurf for JetBrains 插件独立维护，IntelliJ IDEA 用户可继续使用，无需迁移到 Devin Desktop。

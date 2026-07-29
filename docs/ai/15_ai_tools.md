# AI 工具总览

> 汇总当前主流 AI 产品与开发者工具，覆盖对话助手、编程辅助等方向。

## 横向对比

| 工具 | 厂商 | 定位 | 适用场景 |
|------|------|------|---------|
| ChatGPT | OpenAI | 通用对话 / 写作 / 代码 | 日常问答、文档生成、代码辅助 |
| Claude | Anthropic | 长上下文对话 / 代码 | 大文档分析、代码审查、写作 |
| Gemini | Google | 多模态对话 / 搜索增强 | 图文理解、Google 生态集成 |
| Cursor | Anysphere | AI 编程 IDE | 代码补全、重构、内联对话 |
| GitHub Copilot | GitHub / OpenAI | IDE 插件代码补全 | VS Code / JetBrains 代码辅助 |
| Claude Code | Anthropic | 终端 AI 编程助手 | 命令行代码生成、项目理解 |
| Windsurf | Codeium | AI 编程 IDE | 代码补全、Flows 智能体 |

---

## 一、ChatGPT

> 官网：[https://chatgpt.com](https://chatgpt.com)
> 模型列表：[https://platform.openai.com/docs/models](https://platform.openai.com/docs/models)

ChatGPT 是 OpenAI 面向终端用户的对话产品，也是目前用户量最大的 AI 助手。免费版使用 GPT-4o-mini，**Plus 订阅（$20/月）**可使用 GPT-4o、o3 等旗舰模型，并解锁 DALL·E 图像生成、数据分析（Code Interpreter）和 GPT Store 插件市场。GPT-4o 原生支持多模态输入，可直接上传图片、截图、PDF 进行分析；Advanced Voice Mode 支持实时语音对话。

**核心功能：**

- **多模态对话**：文本、图片、文件、语音输入均支持
- **代码执行（Code Interpreter）**：Python 沙箱环境，可处理数据、绘图、文件转换
- **联网搜索**：GPT-4o 可联网检索实时信息（Plus 功能）
- **Custom GPT / GPT Store**：可创建或使用他人制作的定制化 GPT
- **Projects**：将多轮对话、文件、指令组织成项目，持久化上下文

**与 Claude 的差异**：ChatGPT 生态最成熟、插件最丰富，更适合日常通用任务；Claude 在长文档和代码深度分析上更具优势。

---

## 二、Claude & Claude Code

> Claude 官网：[https://claude.ai](https://claude.ai)
> Claude Code 文档：[https://docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)

**Claude（Web/API）** 是 Anthropic 的对话产品，以 200K 超长上下文和出色的代码理解能力著称，尤其适合上传整个代码文件、长篇技术文档进行深度分析。Claude 在指令遵循、格式输出和代码审查方面表现一致，是开发者做 Code Review、架构讨论的常用工具。

**Claude Code** 是 Anthropic 官方推出的命令行 AI 编程工具，在终端内直接操作：

- **终端内对话**：直接在 shell 中与 Claude 对话，无需切换到浏览器
- **文件读写**：可读取、编辑、创建项目文件，理解整个代码库结构
- **命令执行**：可执行 shell 命令（测试、构建、git 操作）并根据输出进行推理
- **MCP 扩展**：通过 MCP（Model Context Protocol）集成外部工具和数据源
- **Hooks 自动化**：可配置 pre/post 钩子，在特定操作前后自动执行脚本

**适用场景**：复杂多文件重构、自动化调试修复、代码库理解、CI/CD 集成，更适合需要深度代码任务的开发者，与 Cursor 的图形化 IDE 体验互补。

---

## 三、Google Gemini

> 官网：[https://gemini.google.com](https://gemini.google.com)
> Google AI Studio：[https://aistudio.google.com](https://aistudio.google.com)

Gemini 是 Google 的对话 AI 产品，底层使用 Gemini 2.5 Pro/Flash 模型，最大上下文达 **1M tokens**，可直接处理超大代码库或完整视频文件。Gemini 与 Google 生态深度集成，可在 Gmail、Google Docs、Drive 中直接使用。

**核心功能：**

- **超长上下文**：1M token 窗口，可上传整个 GitHub 仓库或长视频
- **Deep Research**：自主规划多步搜索路径，生成带引文的深度研究报告（类似 Perplexity 增强版）
- **多模态理解**：原生支持图片、PDF、视频帧、音频分析，不需要额外插件
- **Google Search 集成**：实时联网检索，答案有来源引用，减少幻觉
- **Gemini Workspace**：嵌入 Google Docs/Sheets/Gmail/Meet，在办公场景中调用 AI

**与 ChatGPT 的差异**：Gemini 在 Google 生态集成和超长上下文上领先，Deep Research 功能比 ChatGPT 的搜索更深入；但插件市场和第三方集成生态不如 ChatGPT 丰富。

---

## 四、Cursor

> 官网：[https://www.cursor.com](https://www.cursor.com)
> 文档：[https://docs.cursor.com](https://docs.cursor.com)

Cursor 是基于 VSCode 深度改造的 **AI 原生编程 IDE**，在 VSCode 的完整功能基础上叠加了全套 AI 编程能力，对已有 VSCode 用户几乎零迁移成本（支持导入所有插件和配置）。底层模型可选 Claude Sonnet/Opus、GPT-4o、自定义 API，灵活度高。

**三大核心功能：**

| 功能 | 说明 |
|------|------|
| **Tab 智能补全** | 基于上下文的多行代码预测，比 Copilot 补全范围更大，支持整块代码预测 |
| **Chat（代码问答）** | 侧边栏对话，可引用当前文件、选中代码、整个代码库进行问答和解释 |
| **Composer（跨文件编辑）** | Agent 模式，可跨多个文件同时生成/修改代码，完成完整功能实现 |

**使用技巧：**

- `Ctrl+K`：内联编辑，选中代码后直接描述要修改的内容
- `Ctrl+L`：打开 Chat 侧边栏，支持 `@文件名`、`@代码库` 引用上下文
- `Ctrl+I`：打开 Composer，适合新增功能、重构模块等多文件任务
- **Cursor Rules**（`.cursorrules` 文件）：为项目定制 AI 行为规范，类似 CLAUDE.md

**与 Claude Code 的差异**：Cursor 是图形化 IDE，上手直观，适合日常编码；Claude Code 是纯命令行，适合深度自动化任务和 CI 集成。

---

## 五、GitHub Copilot & Codex

> 官网：[https://github.com/features/copilot](https://github.com/features/copilot)
> 文档：[https://docs.github.com/en/copilot](https://docs.github.com/en/copilot)

GitHub Copilot 是 GitHub（微软）与 OpenAI 合作推出的 **IDE 插件形式**的 AI 编程助手，以深度集成开发环境为核心优势，与 GitHub 仓库和工作流无缝衔接。底层模型为 GPT-4o / Claude（Individual/Business 版本可选）。

**产品组成：**

| 组件 | 说明 |
|------|------|
| **Copilot 代码补全** | IDE 内联补全，支持 VS Code、JetBrains、Neovim、Visual Studio |
| **Copilot Chat** | 侧边栏对话，可引用代码、文件、PR、issue 进行问答 |
| **Copilot Edits** | 跨文件代码修改（类似 Cursor Composer） |
| **Copilot in GitHub.com** | 在 PR、Issue、代码审查页面直接使用 AI |
| **Copilot Extensions** | 第三方扩展，可集成 Jira、Datadog、Azure 等 |

**企业版（Copilot Business/Enterprise）特性：**

- **知识库（Knowledge Bases）**：上传企业私有文档，让 Copilot 理解内部代码规范
- **Pull Request 摘要**：自动生成 PR 描述和变更摘要
- **审计日志**：企业级安全合规，所有请求可审计
- **代码引用检测**：标记补全内容是否来自公开代码库，规避版权风险

**与 Cursor 的差异**：Copilot 是轻量插件，不改变原有 IDE 体验，更适合团队统一部署；Cursor 是独立 IDE，AI 能力更激进，适合个人重度用户。

---

## 六、Windsurf

> 官网：[https://windsurf.com](https://windsurf.com)
> 文档：[https://docs.windsurf.com](https://docs.windsurf.com)

Windsurf 是 Codeium 出品的 **AI 编程 IDE**（同样基于 VSCode），主打 Agent 驱动的多步骤自主执行能力。Codeium 在 Copilot 之前就提供免费代码补全服务，积累了大量工程数据，Windsurf 是其进入 AI IDE 赛道的旗舰产品。

**核心功能：**

| 功能 | 说明 |
|------|------|
| **Cascade** | 上下文感知对话，能感知整个代码库的变化历史和依赖关系 |
| **Flows（智能体）** | 多步骤自主执行：读文件 → 修改 → 运行测试 → 修复错误，全程自动 |
| **Supercomplete** | 比普通 Tab 补全更大范围的多行预测 |
| **深度上下文感知** | 自动索引整个代码库，无需手动 `@` 引用文件 |

**与 Cursor 的对比：**

| 维度 | Cursor | Windsurf |
|------|--------|----------|
| 底层模型 | Claude / GPT-4o（可选） | 自研 + Claude / GPT |
| Agent 能力 | Composer（稳定成熟） | Flows（更自主，偶尔过激） |
| 价格 | $20/月（Pro） | 有免费额度，Pro $15/月 |
| 上下文感知 | 手动引用 `@文件` | 自动感知，减少手动操作 |
| 适合人群 | 追求精细控制的开发者 | 希望 AI 更自主执行的开发者 |

Windsurf 的 Flows 模式比 Cursor Composer 更激进，适合"描述目标让 AI 自动完成"的工作流；Cursor 则更注重开发者对每一步的掌控感。

# 大语言模型（LLM）

> 参考资料：
> * LMSYS Chatbot Arena（模型能力榜单）：[https://chat.lmsys.org/](https://chat.lmsys.org/)
> * Open LLM Leaderboard：[https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard)
> * Anthropic 模型文档：[https://docs.anthropic.com/en/docs/about-claude/models/](https://docs.anthropic.com/en/docs/about-claude/models/)
> * OpenAI 模型文档：[https://platform.openai.com/docs/models](https://platform.openai.com/docs/models)
> * Gemini 模型文档：[https://ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)

---

## 一、闭源商业模型

| 模型系列 | 厂商 | 代表模型 | 上下文窗口 | 特点 |
|---------|------|---------|-----------|------|
| GPT-5.6 系列 | OpenAI | gpt-5.6-sol | 1.05M | 综合能力强，生态最成熟 |
| Claude 5 系列 | Anthropic | claude-sonnet-5 | 1M | 长上下文，代码与 Agent 见长 |
| Gemini 系列 | Google | gemini-3.5-flash | 2M | 多模态，与 Google 生态集成 |

### 1.1 GPT 系列（OpenAI）

> 官网：[https://platform.openai.com/docs/models](https://platform.openai.com/docs/models)

GPT-5.6 系列是 OpenAI 全新命名体系下的旗舰产品线，三款模型在能力与成本之间形成梯度。**gpt-5.6-sol**（可通过别名 `gpt-5.6` 调用）是旗舰模型，面向复杂推理和代码任务；**gpt-5.6-terra** 在智能与成本之间取得平衡；**gpt-5.6-luna** 面向成本敏感型高并发场景。GPT-4o 和 o3 现已归入 Legacy 模型。

| 模型 | API 标识 | 上下文 | 定价（输入/输出，$/MTok） | 适用场景 |
|------|---------|--------|--------------------------|---------|
| GPT-5.6 Sol | gpt-5.6-sol / gpt-5.6 | 1.05M | $5 / $30 | 复杂推理、编码、企业旗舰 |
| GPT-5.6 Terra | gpt-5.6-terra | 1.05M | $2.50 / $15 | 智能与成本均衡 |
| GPT-5.6 Luna | gpt-5.6-luna | 1.05M | $1 / $6 | 高频低成本调用 |

- 三款模型均支持 1.05M 超长上下文，可装入大型代码库或长篇文档
- API 生态最完善：Function Calling、Structured Output、Assistants API、Batch API 均支持
- 计费按 token，建议用 `tiktoken` 库提前估算 token 数量控制成本
- GPT-4o / o3 已标记为 Legacy，新项目应迁移至 GPT-5.6 系列

### 1.2 Claude 系列（Anthropic）

> 官网：[https://docs.anthropic.com/en/docs/about-claude/models/](https://docs.anthropic.com/en/docs/about-claude/models/)

Claude 5 系列由 Anthropic 开发，以**长上下文处理**、**多步骤 Agent 任务**和**代码与文档分析**见长，安全性设计（Constitutional AI）是其核心差异。全系列支持 1M token 上下文（Haiku 4.5 为 200K），Claude 5 模型支持**自适应思考**（Adaptive Thinking），可在推理深度和响应速度间动态权衡；**claude-fable-5** 专为长时运行 Agent 场景优化；Haiku 4.5 支持扩展思考（Extended Thinking）。

| 模型 | API 标识 | 上下文 | 定价（输入/输出，$/MTok） | 适用场景 |
|------|---------|--------|--------------------------|---------|
| Claude Fable 5 | claude-fable-5 | 1M | $10 / $50 | 长时运行 Agent、高精度推理 |
| Claude Opus 5 | claude-opus-5 | 1M | $5 / $25 | 复杂 Agentic 编码、企业级任务 |
| Claude Sonnet 5 | claude-sonnet-5 | 1M | $3 / $15 | 速度与智能最佳平衡 |
| Claude Haiku 4.5 | claude-haiku-4-5-20251001 | 200K | $1 / $5 | 最快响应，高频调用 |

- **Adaptive Thinking**（自适应思考）：Claude 5 系列根据任务复杂度自动调整推理深度，无需手动开关
- **Extended Thinking**：Haiku 4.5 支持，开启后模型内部进行链式推理，适合准确性优先的场景
- 1M token 上下文可装入整个代码仓库或超长文档，长文档处理为首选
- Claude Code（命令行工具）默认底层即使用 Claude 系列模型

### 1.3 Gemini 系列（Google）

> 官网：[https://ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)

Gemini 系列是 Google 的旗舰多模态模型，原生支持文本、图像、视频、音频、PDF 和代码。**gemini-3.5-flash** 是当前稳定主力，在 Agentic 任务和编码场景达到前沿性能；**gemini-3.1-pro**（Preview）面向高复杂度问题求解；**gemini-3.1-flash-lite** 以更低成本提供接近前沿的性能。Gemini 2.5 Pro/Flash 已标记为"previous models"（逐步弃用）。新增 **Gemini Embedding 2** 支持文本、图像、视频、音频、PDF 的多模态向量化。

| 模型 | 状态 | 特点 |
|------|------|------|
| gemini-3.5-flash | 稳定版 | Agentic/编码首选，前沿性能 |
| gemini-3.1-flash-lite | 稳定版 | 低成本，接近前沿效果 |
| gemini-3.1-pro | 预览版 | 高级智能，复杂问题求解 |
| gemini-3 (flash) | 预览版 | 新一代基础版 |
| Gemini Embedding 2 | 稳定版 | 多模态 Embedding（文本/图像/视频/音频/PDF） |

- **Deep Research**：可自主规划搜索路径，生成带引用的深度研究报告
- **多模态原生支持**：可直接传入图片、视频帧、PDF 文件进行理解分析
- 与 Google Workspace 集成：Docs、Gmail、Sheets 中可直接调用 Gemini 能力
- Vertex AI 提供企业级部署，支持私有化 fine-tuning

---

## 二、开源模型

| 模型系列 | 机构 | 代表模型 | 特点 |
|---------|------|---------|------|
| Llama 4 系列 | Meta | Llama-4-Maverick-17B-128E | 开源 MoE，超长上下文，多模态 |
| DeepSeek 系列 | 深度求索 | DeepSeek-V3 / R1 | 国产，性价比极高，推理能力强 |
| Qwen3 系列 | 阿里 | Qwen3-235B-A22B | 思考/非思考双模式，中文能力突出 |
| Mistral 系列 | Mistral AI | Mistral Large | 欧洲出品，轻量高效 |

### 2.1 Llama 4 系列（Meta）

> Hugging Face：[https://huggingface.co/meta-llama](https://huggingface.co/meta-llama)

Llama 4 是 Meta 最新一代开源大模型，采用**混合专家（MoE）架构**，原生支持多模态（文本+图像），在 12 种语言上支持文本生成和代码输出。使用 Llama 4 Community License，满足条件可商业使用。**Scout** 适合超长文档处理（10M 上下文）；**Maverick** 拥有 128 个专家，性能更强，适合高难度推理和视觉任务。

| 模型 | 激活参数 / 总参数 | 上下文 | 特点 |
|------|-----------------|--------|------|
| Llama-4-Scout-17B-16E-Instruct | 17B / ~109B（16 专家） | 10M | 超长上下文，多模态，轻量部署 |
| Llama-4-Maverick-17B-128E-Instruct | 17B / ~400B（128 专家） | 1M | 更强推理与视觉，高性能旗舰 |
| Llama-4-Maverick-17B-128E-Instruct-FP8 | 17B / ~400B | 1M | FP8 量化版，降低显存需求 |

- **MoE 架构**：每次推理仅激活 17B 参数，计算成本远低于同等稠密模型
- **Scout 10M 超长上下文**：适合处理超大代码库、长篇文档、全量日志分析
- **多模态原生**：可直接传入图片进行视觉推理、图像描述、文档分析
- 可通过 Ollama、vLLM、llama.cpp 等主流工具链部署，社区生态丰富

### 2.2 DeepSeek 系列

> 官网：[https://www.deepseek.com/](https://www.deepseek.com/)
> API 文档：[https://api-docs.deepseek.com/](https://api-docs.deepseek.com/)

DeepSeek 是深度求索（国内）发布的高性价比大模型，以**极低 API 价格**和**接近顶级闭源模型的性能**著称，国内访问稳定无需代理。**DeepSeek-V3** 是通用对话旗舰，综合能力对标 GPT-4o；**DeepSeek-R1** 引入强化学习推理，在数学、代码、逻辑推理上大幅超越同规模模型，性能接近 o1。

| 模型 | 类型 | 特点 |
|------|------|------|
| DeepSeek-V3 | 通用对话 | 综合能力强，价格约 ¥1/M tokens |
| DeepSeek-R1 | 推理增强 | 强化学习训练，数学/代码/逻辑见长 |
| DeepSeek-R1-Distill | 蒸馏开源版 | 7B/14B/32B，可本地 Ollama 运行 |

- API 兼容 OpenAI 格式，迁移成本几乎为零（替换 `base_url` 和 `api_key` 即可）
- **国内访问稳定**：`api.deepseek.com` 无需科学上网，适合国内企业采购
- 开源版（R1-Distill）可通过 Ollama 在本地部署，实现零成本推理
- 价格极低：V3 输入约 ¥0.5/M tokens，输出约 ¥2/M tokens（比 GPT-4o 低一个数量级）

### 2.3 Qwen3 系列（阿里）

> 官网：[https://qwenlm.github.io/](https://qwenlm.github.io/)
> Hugging Face：[https://huggingface.co/Qwen](https://huggingface.co/Qwen)
> 通义千问 API：[https://dashscope.aliyuncs.com](https://dashscope.aliyuncs.com)

Qwen3（通义千问第三代）是阿里巴巴开源的最新大模型系列，**中文能力**在同规模开源模型中表现最突出，支持 100+ 种语言，覆盖稠密模型（0.5B 至 32B）与混合专家模型（30B-A3B、235B-A22B）的完整规模。核心创新是**思考/非思考双模式**：思考模式下输出含 `<think>...</think>` 推理链，非思考模式下直接对话高效响应，无需切换模型即可兼顾推理精度与响应速度。全系列采用 **Apache 2.0 协议**，完全可商用。

| 模型 | 架构 | 激活参数 / 总参数 | 上下文 | 特点 |
|------|------|-----------------|--------|------|
| Qwen3-0.5B | 稠密 | 0.5B | 32K / 128K | 极轻量，边缘设备首选 |
| Qwen3-1.7B | 稠密 | 1.7B | 32K / 128K | 低资源场景 |
| Qwen3-4B | 稠密 | 4B | 32K / 128K | 轻量高效 |
| Qwen3-8B | 稠密 | 8B | 32K / 128K | 综合均衡，本地部署主力 |
| Qwen3-14B | 稠密 | 14B | 32K / 128K | 能力与资源平衡 |
| Qwen3-32B | 稠密 | 32B | 32K / 128K | 开源稠密旗舰 |
| Qwen3-30B-A3B | MoE | 3B / 30B | 32K / 128K | 轻量 MoE，低部署成本 |
| Qwen3-235B-A22B | MoE | 22B / 235B（128 专家，8 激活） | 32K / 128K | 开源最强，接近前沿闭源模型 |

> 上下文说明：原生 32K token，通过 YaRN 缩放可扩展至 128K。

- **思考模式**（Thinking Mode）：推理任务开启，输出含链式推理步骤，Temperature 建议 0.6
- **非思考模式**（Non-thinking Mode）：对话/检索场景关闭，高效直接响应，Temperature 建议 0.7
- Qwen3-8B 在思考模式下超越 Qwen2.5-72B 和 QwQ，在非思考模式下超越 Qwen2.5 指令模型
- **Apache 2.0 协议**：所有规模模型均可免费商用，无需申请额外许可
- Ollama 支持：`ollama pull qwen3:8b`，是本地中文场景的首选模型
- 通义千问 API（DashScope）兼容 OpenAI 格式，国内访问稳定，价格有竞争力

---

## 三、模型选型参考

### 3.1 按使用场景选型

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 企业 API 集成 | claude-sonnet-5 / gpt-5.6-sol | 稳定、文档完善、SDK 成熟 |
| 成本敏感型项目 | DeepSeek-V3 / gpt-5.6-luna | 价格极低，效果不差 |
| 本地私有化部署 | Qwen3-8B / Llama-4-Scout / DeepSeek-R1-Distill | 开源可商用，支持 Ollama 运行 |
| 长文档处理（超长） | Llama-4-Scout（10M） / claude-sonnet-5（1M） | 超长上下文窗口 |
| 中文场景 | Qwen3 / DeepSeek | 中文训练数据充分，双语表现最优 |
| 多步骤 Agent 任务 | claude-fable-5 / claude-opus-5 | 专为长时运行 Agent 优化 |
| 数学/逻辑推理 | DeepSeek-R1 / Qwen3（思考模式）| 强化学习推理，链式思维 |
| 多模态（图像/视频）| Gemini-3.5-flash / Llama-4-Maverick | 原生多模态支持 |

### 3.2 本地部署推荐参数

| 显存 / 内存 | 推荐模型大小 | 示例 |
|------------|------------|------|
| 8GB 显存 | 7B ~ 8B 量化版 | Qwen3-8B-Q4 / Llama-4-Scout（部分量化） |
| 16GB 显存 | 14B 量化版 | Qwen3-14B-Q4 |
| 24GB 显存 | 30B ~ 32B 量化版 | Qwen3-32B-Q4 / DeepSeek-R1-32B-Q4 |
| 48GB 显存（双卡）| Qwen3-30B-A3B（MoE）| 激活参数仅 3B，推理成本极低 |
| 纯 CPU / 内存 | 3B ~ 4B 量化 | Qwen3-4B-Q4，速度较慢，适合测试 |

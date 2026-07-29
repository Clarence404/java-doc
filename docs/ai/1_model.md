# 主流大语言模型

> 参考资料：
> * LMSYS Chatbot Arena（模型能力榜单）：[https://chat.lmsys.org/](https://chat.lmsys.org/)
> * Open LLM Leaderboard：[https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard)

---

## 一、闭源商业模型

| 模型系列 | 厂商 | 代表模型 | 上下文窗口 | 特点 |
|---------|------|---------|-----------|------|
| GPT 系列 | OpenAI | GPT-4o / o3 | 128K | 综合能力强，生态最成熟 |
| Claude 系列 | Anthropic | Claude 3.7 Sonnet | 200K | 长上下文，代码与分析见长 |
| Gemini 系列 | Google | Gemini 2.5 Pro | 1M | 多模态，与 Google 生态集成 |

### 1.1 GPT 系列（OpenAI）

> 官网：[https://platform.openai.com/docs/models](https://platform.openai.com/docs/models)

GPT 系列是目前生态最成熟的商业大模型，OpenAI 提供完善的 API、SDK 和文档。主力模型 **GPT-4o** 支持文本、图像、音频多模态输入，在综合能力和响应速度间取得平衡；**GPT-4o-mini** 大幅降低成本，适合高频低延迟场景；**o 系列**（o1、o3）引入"慢思考"推理机制，通过链式推理解决复杂数学、逻辑、代码问题，但响应时间更长。

| 模型 | 上下文 | 特点 | 适用场景 |
|------|--------|------|---------|
| GPT-4o | 128K | 多模态，速度与能力平衡 | API 集成、通用问答、代码 |
| GPT-4o-mini | 128K | 低成本，速度快 | 高频调用、RAG 检索增强 |
| o3 | 200K | 深度推理，慢但准确 | 复杂逻辑、数学、代码调试 |

- o 系列 vs 普通版：o 系列内部进行多步推理（Chain-of-Thought），输出前会有较长等待，不适合实时对话，但在推理类任务上显著超越 GPT-4o
- API 生态最完善：Function Calling、Structured Output、Assistants API、Batch API 均支持
- 计费按 token，建议用 `tiktoken` 库提前估算 token 数量控制成本

### 1.2 Claude 系列（Anthropic）

> 官网：[https://docs.anthropic.com/en/docs/about-claude/models/](https://docs.anthropic.com/en/docs/about-claude/models/)

Claude 系列由 Anthropic 开发，以**长上下文处理**和**代码与文档分析**见长，安全性设计（Constitutional AI）是其核心差异。**Claude 3.5 Sonnet** 在代码生成和指令遵循上表现突出；**Claude 3.7 Sonnet** 引入 Extended Thinking（扩展思考）模式，可在回答前进行深度内部推理，适合复杂分析；**Claude 4 系列**（Opus 4 / Sonnet 4）进一步提升多步骤任务执行和长文档理解能力。

| 模型 | 上下文 | 特点 |
|------|--------|------|
| Claude 3.5 Sonnet | 200K | 代码、写作，速度与能力平衡 |
| Claude 3.7 Sonnet | 200K | 支持 Extended Thinking，推理增强 |
| Claude 4 Sonnet | 200K | 最新主力，长文档与代码任务最强 |
| Claude 4 Opus | 200K | 旗舰推理，适合复杂多步骤任务 |

- **Extended Thinking**：开启后模型会在内部"思考"更长时间，输出可包含思维链，适合需要准确性高于速度的场景
- 200K 上下文可装入整个代码仓库或长篇报告，是处理大型文档的首选模型
- Claude Code（命令行工具）默认底层即使用 Claude 系列模型

### 1.3 Gemini 系列（Google）

> 官网：[https://ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)

Gemini 系列是 Google 的旗舰多模态模型，原生支持文本、图像、视频、音频和代码。**Gemini 2.5 Pro** 拥有高达 **1M token** 的超长上下文窗口，可处理整部小说或超大代码库；**Gemini 2.5 Flash** 在速度和成本上优化，适合高吞吐场景。Gemini 深度集成 Google 生态，可通过 Google AI Studio 或 Vertex AI 接入，并与 Google Search、Google Workspace 等服务联动。

| 模型 | 上下文 | 特点 |
|------|--------|------|
| Gemini 2.5 Pro | 1M | 超长上下文，多模态，深度推理 |
| Gemini 2.5 Flash | 1M | 速度快，成本低，适合高频调用 |
| Gemini 2.5 Flash-8B | 1M | 轻量版，延迟最低 |

- **Deep Research**：可自主规划搜索路径，生成带引用的深度研究报告
- **多模态原生支持**：可直接传入图片、视频帧、PDF 文件进行理解分析
- 与 Google Workspace 集成：Docs、Gmail、Sheets 中可直接调用 Gemini 能力
- Vertex AI 提供企业级部署，支持私有化 fine-tuning

---

## 二、开源模型

| 模型系列 | 机构 | 代表模型 | 特点 |
|---------|------|---------|------|
| Llama 系列 | Meta | Llama 3.3 70B | 开源生态最广，社区活跃 |
| DeepSeek 系列 | 深度求索 | DeepSeek-V3 / R1 | 国产，性价比极高，推理能力强 |
| Qwen 系列 | 阿里 | Qwen2.5 72B | 中文能力突出，多语言支持好 |
| Mistral 系列 | Mistral AI | Mistral Large | 欧洲出品，轻量高效 |

### 2.1 Llama 系列（Meta）

> 官网：[https://llama.meta.com/](https://llama.meta.com/)

Llama 是 Meta 开源的大语言模型系列，采用开源可商用许可证（Llama 3 Community License），是目前社区生态最丰富的开源 LLM。**Llama 3.x** 在 8B 和 70B 参数规模上性能表现优异，工具链支持最全面，可通过 Ollama、vLLM、llama.cpp、Hugging Face Transformers 等方式部署。

| 模型 | 参数 | 特点 |
|------|------|------|
| Llama 3.2 3B | 3B | 极轻量，适合边缘设备 |
| Llama 3.2 11B | 11B | 多模态（文本+图像） |
| Llama 3.3 70B | 70B | 开源最强综合能力 |

- **开源可商用**：可用于商业产品，无需向 Meta 支付费用（满足用户量条件时需申请许可）
- **社区工具链丰富**：Ollama 一键运行，vLLM 高吞吐部署，llama.cpp 支持纯 CPU 推理
- 适合**私有化部署场景**：金融、医疗等对数据合规有严格要求的行业
- Llama 也是 Meta 量化（GGUF）格式的主流模型，量化后 7B 仅需 4GB 显存

### 2.2 DeepSeek 系列

> 官网：[https://www.deepseek.com/](https://www.deepseek.com/)
> API 文档：[https://api-docs.deepseek.com/](https://api-docs.deepseek.com/)

DeepSeek 是深度求索（国内）发布的高性价比大模型，以**极低 API 价格**和**接近 GPT-4o 的性能**著称，国内访问稳定无需代理。**DeepSeek-V3** 是通用对话旗舰，综合能力对标 GPT-4o；**DeepSeek-R1** 引入强化学习推理，在数学、代码、逻辑推理上大幅超越同规模模型，性能接近 o1。

| 模型 | 类型 | 特点 |
|------|------|------|
| DeepSeek-V3 | 通用对话 | 综合能力强，价格约 ¥1/M tokens |
| DeepSeek-R1 | 推理增强 | 强化学习训练，数学/代码/逻辑见长 |
| DeepSeek-R1-Distill | 蒸馏开源版 | 7B/14B/32B，可本地 Ollama 运行 |

- API 兼容 OpenAI 格式，迁移成本几乎为零（替换 `base_url` 和 `api_key` 即可）
- **国内访问稳定**：`api.deepseek.com` 无需科学上网，适合国内企业采购
- 开源版（R1-Distill）可通过 Ollama 在本地部署，实现零成本推理
- 价格极低：V3 输入约 ¥0.5/M tokens，输出约 ¥2/M tokens（比 GPT-4o 低一个数量级）

### 2.3 Qwen 系列（阿里）

> 官网：[https://qwenlm.github.io/](https://qwenlm.github.io/)
> Hugging Face：[https://huggingface.co/Qwen](https://huggingface.co/Qwen)
> 通义千问 API：[https://dashscope.aliyuncs.com](https://dashscope.aliyuncs.com)

Qwen（通义千问）是阿里巴巴开源的大语言模型系列，**中文能力**在同规模开源模型中表现最突出，覆盖从 0.5B 到 72B 的完整参数规模。**Qwen2.5** 系列在代码（Qwen2.5-Coder）、数学（Qwen2.5-Math）等垂直领域有专项优化版本；72B 旗舰版采用 Apache 2.0 协议，可完全商用。

| 模型 | 参数 | 特点 |
|------|------|------|
| Qwen2.5 7B | 7B | 轻量高效，中文表现优异 |
| Qwen2.5 72B | 72B | 开源旗舰，商用最强中文模型 |
| Qwen2.5-Coder 7B/32B | 7B/32B | 代码专项优化 |
| Qwen2.5-Math 7B | 7B | 数学推理专项 |

- **中文训练数据充分**：在中文理解、生成、翻译任务上优于同规模 Llama
- **Apache 2.0 协议**：72B 以下模型均可免费商用，无需申请额外许可
- Ollama 支持：`ollama pull qwen2.5:7b`，是本地中文场景的首选模型
- 通义千问 API（DashScope）兼容 OpenAI 格式，国内访问稳定，价格有竞争力

---

## 三、模型选型参考

### 3.1 按使用场景选型

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 企业 API 集成 | GPT-4o / Claude 3.7 | 稳定、文档完善、SDK 成熟 |
| 成本敏感型项目 | DeepSeek-V3 / Qwen2.5 | 价格极低，效果不差 |
| 本地私有化部署 | Llama 3 / DeepSeek / Qwen | 开源可商用，支持 Ollama 运行 |
| 长文档处理 | Claude 3.7（200K） / Gemini 2.5（1M） | 超长上下文窗口 |
| 中文场景 | Qwen2.5 / DeepSeek | 中文训练数据充分 |

### 3.2 本地部署推荐参数

| 显存 / 内存 | 推荐模型大小 | 示例 |
|------------|------------|------|
| 8GB 显存 | 7B 量化版 | Qwen2.5-7B-Q4 |
| 16GB 显存 | 13B / 14B | Llama3-13B |
| 24GB 显存 | 32B 量化版 | DeepSeek-R1-32B-Q4 |
| 纯 CPU / 内存 | 3B ~ 7B 量化 | 速度较慢，适合测试 |

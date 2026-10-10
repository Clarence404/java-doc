---
description: 选型维度、主流模型家族、按场景选型、成本估算公式、Tokenizer 计数、本地部署显存估算
---

# 大模型选型

> **本篇目标**：建立一套不依赖具体型号的模型选型方法：按能力档位、延迟、上下文、价格档位、数据驻留、开源与否和许可证做取舍，会用公式估算调用成本和本地部署显存，知道去哪里查最新型号。
>
> **前置阅读**：[AI 总览](../0_overview)

模型型号几乎每个季度都会更新，价格和上下文长度也随之变化。本篇只写选型方法和模型家族，型号、价格、上下文长度一律以文末各厂商官方模型页为准（基线时间：2026-10）。

---

## 一、选型维度

### 1、七个维度

| 维度 | 要回答的问题 | 怎么判断 |
|------|-------------|---------|
| 能力档位 | 任务需要旗舰、均衡还是轻量模型 | 用自己业务的 50～200 条样本做小评测，公开榜单只做初筛 |
| 延迟 | 首 Token 时间、整体响应时间能接受多少 | 交互式对话看首 Token 延迟，批处理看吞吐；推理模型思考越深延迟越高 |
| 上下文 | 单次请求要装多少内容 | 先算「系统提示 + 检索结果 + 历史 + 输出」的 Token 总数，再留余量；能用 RAG 裁剪就不要硬塞长上下文 |
| 价格档位 | 单次请求和月度预算能承受多少 | 用第四节的公式估算，不要只看输入单价 |
| 数据驻留 | 数据能不能出境、能不能出公司 | 合规要求高的场景选境内云厂商、私有化部署或开源模型自部署 |
| 开源与闭源 | 是否需要拿到权重自己部署、微调 | 闭源模型能力上限高、免运维；开源权重可私有化、可微调，但要自己承担推理成本 |
| 许可证 | 商用是否受限 | 开源权重不等于开源许可：有的用 Apache 2.0 / MIT，有的用厂商自定义许可（附加月活上限、用途限制等），商用前通读模型卡里的 License |

### 2、能力档位而不是型号

各家都按「旗舰 / 均衡 / 轻量」三档出模型，同一档位内的模型可以互相替换。工程上建议把型号做成配置项，代码只依赖档位：

```yaml
# application.yml：型号随厂商更新调整，代码不改
app:
  ai:
    tier:
      flagship: ${FLAGSHIP_MODEL_ID}   # 复杂推理、Agent 主控
      balanced: ${BALANCED_MODEL_ID}   # 日常问答、RAG 生成
      light: ${LIGHT_MODEL_ID}         # 分类、抽取、路由、摘要
```

```java
@ConfigurationProperties(prefix = "app.ai.tier")
public record ModelTierProperties(String flagship, String balanced, String light) {}
```

调用时按任务选档位，例如意图分类走 `light`、最终回答走 `balanced`、多步规划走 `flagship`。档位路由配合降级（旗舰超时或限流时降到均衡档）是控制成本和可用性最直接的手段。

---

## 二、主流模型家族

### 1、闭源商业模型

| 家族 | 厂商 | 特点 | 官方模型页 |
|------|------|------|-----------|
| GPT | OpenAI | 生态最成熟，三档齐全；新功能优先落在 Responses API，Assistants API 已归入 Legacy | [OpenAI Models](https://developers.openai.com/api/docs/models) |
| Claude | Anthropic | 长上下文、代码与 Agent 任务见长；新模型默认自适应思考，用 `effort` 控制推理深度 | [Claude Models](https://platform.claude.com/docs/en/about-claude/models/overview) |
| Gemini | Google | 原生多模态（文本、图像、音频、视频、PDF），分 Pro / Flash / Flash-Lite 三档 | [Gemini Models](https://ai.google.dev/gemini-api/docs/models) |

### 2、开源权重与国产模型

| 家族 | 机构 | 特点 | 官方入口 |
|------|------|------|---------|
| DeepSeek | 深度求索 | API 同时兼容 OpenAI 与 Anthropic 格式，换 `base_url` 即可接入；R1 是用强化学习训练推理能力的代表作，当前 API 已换成新一代模型 | [DeepSeek API Docs](https://api-docs.deepseek.com/) |
| Qwen | 阿里 | 中文能力突出，开源权重规模覆盖从端侧小模型到大 MoE，支持思考模式；旗舰版本通过阿里云百炼以 API 提供 | [Qwen](https://qwenlm.github.io/) / [Hugging Face](https://huggingface.co/Qwen) |
| Llama | Meta | MoE 架构、多模态；使用 Meta 自定义社区许可证，附带月活上限等条款，不是 OSI 意义上的开源许可 | [Hugging Face](https://huggingface.co/meta-llama) |
| Mistral | Mistral AI | 欧洲厂商，既有开源权重也有商业 API | [Mistral Docs](https://docs.mistral.ai/) |

开源权重模型的许可证按版本、按规模可能不同，以对应模型卡为准。

---

## 三、按场景选型

| 场景 | 推荐档位 / 类型 | 理由 |
|------|----------------|------|
| 企业 API 集成、对外产品 | 闭源均衡档 | 稳定性、SLA、SDK 和文档最完善 |
| 高并发低成本（分类、抽取、路由） | 闭源轻量档或国产 API | 单价低、延迟低，简单任务效果足够 |
| 多步骤 Agent、复杂编码 | 闭源旗舰档 | 长链路任务对规划与工具调用准确率最敏感 |
| 数学、逻辑、复杂分析 | 推理模型或开启思考模式 | 用 `effort` / `reasoning_effort` / 思考开关调深度，而不是靠 Prompt 硬写推理步骤 |
| 数据不能出公司 | 开源权重模型私有化部署 | 按第五节估算显存，用 Ollama、vLLM 等部署 |
| 中文为主 | Qwen、DeepSeek 或闭源均衡档 | 中文语料充分；最终以自有样本评测为准 |
| 长文档、整库代码分析 | 长上下文模型 + 缓存，或 RAG | 超长上下文贵且慢，能检索裁剪就先裁剪 |
| 图像、音频、视频理解 | 原生多模态模型（如 Gemini） | 不用自己拼 OCR、ASR 链路 |

---

## 四、成本估算

### 1、计费公式

API 按 Token 计费，输入、输出、缓存命中分别定价。一次请求的成本可以写成：

> 单次成本 = 未命中缓存的输入 Token × 输入单价 + 缓存写入 Token × 缓存写入单价 + 缓存命中 Token × 缓存读取单价 + 输出 Token × 输出单价

几个容易漏算的地方：

- **推理 Token 按输出计费**：推理模型的思考过程即使不返回给你，也按输出 Token 计费，并占用 `max_tokens`；思考越深，成本越高
- **多轮对话的历史会被重复计费**：第 N 轮请求要把前 N−1 轮全部带上，长会话成本近似按轮数平方增长，需要做历史截断或摘要
- **工具定义也算输入**：每个工具的 JSON Schema 都会进入输入 Token，几十个工具一起挂上，固定开销不小
- **输出通常比输入贵数倍**：控制输出长度（`max_tokens`、要求简洁、结构化输出）往往比压缩输入更省钱

月度预算再乘以调用量：

> 月成本 ≈ 单次平均成本 × 日均调用量 × 30 × 重试放大系数

### 2、两种折扣

| 折扣 | 做法 | 适用场景 |
|------|------|---------|
| Prompt Caching | 把不变的内容（系统提示、工具定义、长文档）放在请求最前面，命中缓存的部分按折扣价计费，延迟也更低 | 固定系统提示、多轮对话、同一文档反复提问 |
| Batch API | 把不要求实时返回的请求打包异步提交，按折扣价计费，结果在规定时间窗口内返回 | 离线打标、批量摘要、评测集回放 |

缓存的前提是前缀完全一致：在系统提示里拼当前时间、用户 ID 这类每次都变的内容，会让缓存全部失效。各家缓存的写入价、读取价、有效期和最小长度不同，以各自价格页为准。

### 3、Token 怎么数

Token 是模型的计费和长度单位，一个汉字、一个英文单词对应多少 Token 取决于具体模型的分词器（Tokenizer），不同厂商、不同代际差别很大，不要用固定换算比例估算。

- **以响应里的 `usage` 字段为准**：所有主流 API 都在响应中返回输入、输出、缓存 Token 数，这是计费依据，应记录到日志和监控
- **发送前预估**：Anthropic 提供 `count_tokens` 接口；OpenAI 系模型使用的 cl100k / o200k 等编码在 Java 中可以用 [jtokkit](https://github.com/knuddelsgmbh/jtokkit) 离线计数（Python 对应 tiktoken）
- **开源模型**：用模型自带的 tokenizer 文件计数，本地推理框架一般也会在响应中返回 Token 数

---

## 五、本地部署显存估算

### 1、权重显存

本地部署时显存主要花在三块：模型权重、KV Cache、运行时开销。权重部分：

> 权重显存 ≈ 总参数量 × 每个参数的字节数

| 精度 | 每参数字节数 | 8B 模型权重 | 30B 模型权重 | 70B 模型权重 |
|------|-------------|------------|-------------|-------------|
| FP16 / BF16 | 2 | 约 16 GB | 约 60 GB | 约 140 GB |
| INT8 / Q8 | 约 1 | 约 8 GB | 约 30 GB | 约 70 GB |
| 4-bit（Q4） | 约 0.5～0.6 | 约 4.5～5 GB | 约 17～19 GB | 约 40 GB |

4-bit 量化每参数实际略高于 0.5 字节，因为量化还要存缩放因子等元数据。

### 2、MoE 模型按总参数算显存

MoE（混合专家）模型每个 Token 只激活一部分专家，所以**计算量**由激活参数决定，但所有专家的权重都必须加载，**显存**仍由总参数决定。例如一个「30B 总参数、3B 激活」的 MoE 模型，Q4 量化后权重约 17～19 GB，速度接近 3B 稠密模型，显存却接近 30B 稠密模型。显存不够时，部分推理框架可以把一部分专家放到内存里，能跑但速度明显下降。

### 3、KV Cache 与运行时开销

KV Cache 随上下文长度和并发数线性增长：

> KV Cache ≈ 2 × 层数 × KV 头数 × 每头维度 × 上下文长度 × 每元素字节数 × 并发请求数

层数、KV 头数、每头维度可以在模型的 `config.json` 里查到。长上下文、多并发时 KV Cache 可能比权重还大；再加上 10%～20% 的运行时开销，就是总显存需求。

### 4、快速对照

| 可用显存 / 内存 | 能跑的规模（4-bit 量化，短上下文） |
|----------------|----------------------------------|
| 纯 CPU，16 GB 内存 | 3B～4B，速度慢，只适合测试 |
| 8 GB 显存 | 7B～8B |
| 16 GB 显存 | 13B～14B |
| 24 GB 显存 | 30B～32B 稠密模型，或 30B 级 MoE |
| 48 GB 显存 | 70B 级稠密模型 |

模型从哪里拉取、怎么调参见 [Ollama](../3_integration/0_ollama)。

---

## 小结

- 选型按七个维度取舍：能力档位、延迟、上下文、价格档位、数据驻留、开源与否、许可证；最终以自有业务样本的小评测为准
- 代码里只依赖「旗舰 / 均衡 / 轻量」档位，型号放配置，配合按任务路由和降级
- 成本 = 各类 Token × 各自单价之和；推理 Token 按输出计费，多轮历史会被重复计费，缓存和 Batch 是两大折扣来源
- Token 数以响应的 `usage` 为准，预估用厂商计数接口或对应分词器（Java 用 jtokkit），不要用固定字数比例
- 本地部署显存 ≈ 总参数 × 每参数字节数 + KV Cache + 运行时开销；MoE 省的是计算，不省显存

## 参考资料

- OpenAI Models：[https://developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models)
- OpenAI Pricing：[https://developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing)
- Claude Models Overview：[https://platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- Claude Prompt Caching：[https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Claude Token Counting：[https://platform.claude.com/docs/en/build-with-claude/token-counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- Gemini Models：[https://ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
- DeepSeek API Docs：[https://api-docs.deepseek.com/](https://api-docs.deepseek.com/)
- Qwen：[https://qwenlm.github.io/](https://qwenlm.github.io/)
- Meta Llama（Hugging Face）：[https://huggingface.co/meta-llama](https://huggingface.co/meta-llama)
- jtokkit：[https://github.com/knuddelsgmbh/jtokkit](https://github.com/knuddelsgmbh/jtokkit)
- LMArena（模型对战榜单）：[https://lmarena.ai/](https://lmarena.ai/)

> 下一篇：[Prompt 工程](./1_prompt)

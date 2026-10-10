---
description: 何时微调、SFT / DPO / LoRA / QLoRA、数据准备、评估、Java 侧部署调用
---

# 模型微调

> 前置阅读：[RAG 检索增强生成](../4_core_tech/2_rag)

微调是用自有数据继续训练模型以改变其行为与输出格式的手段，训练环节基本在 Python 生态完成。本篇讲 Prompt / RAG / 微调的选择、SFT / DPO / LoRA / QLoRA 的区别、数据准备与评估，以及微调模型的部署与 Java 侧调用。

---

## 一、先别急着微调

### 1、三种方案对比

| 维度 | Prompt 工程 | RAG | 微调 |
|------|-------------|-----|------|
| 原理 | 用指令、示例引导模型 | 检索外部知识注入上下文 | 用训练数据更新模型权重 |
| 投入 | 极低，改文本即可 | 中等，需要向量库与入库流程 | 高，需要标注数据、算力与评估体系 |
| 知识更新 | 改提示词即生效 | 更新文档即生效 | 需要重新训练 |
| 擅长 | 通用任务、快速验证 | 私有知识、时效信息、可追溯来源 | 固定输出格式、语气风格、领域任务习惯、用小模型替代大模型 |
| 不擅长 | 超长规则、稳定的复杂格式 | 改变模型行为方式 | 注入频繁变化的知识 |
| 幻觉 | 取决于模型本身 | 有文档依据时较低 | 不会因微调自动减少，学到错误样本还会放大 |

### 2、推荐顺序

1. **先写评估集**：没有评估集就无法判断任何方案是否有效，后面每一步都靠它比较
2. **Prompt 工程**：清晰的指令、少量示例、结构化输出（JSON Schema），多数需求到这一步就解决了
3. **RAG**：缺的是知识而不是能力时，用 RAG
4. **微调**：同时满足下面几条才考虑

- 需要稳定的输出格式或风格，Prompt 加示例仍然达不到要求
- 任务依赖的是「做事方式」而不是「知道什么」，RAG 帮不上忙
- 有足够的高质量样本（至少几百条），并且有人能持续维护
- 有明确的收益：如用微调后的小模型替换大模型降低成本和延迟，或去掉很长的系统提示词

**常见误区**：想让模型「记住公司的产品手册」而去微调。知识类需求用 RAG，微调学到的知识难以更新、无法引用来源，而且容易和原有知识混淆。

---

## 二、微调方法

### 1、按训练目标分

| 方法 | 训练数据 | 用途 |
|------|----------|------|
| **SFT（监督微调）** | 输入 + 期望输出 | 学会固定格式、任务流程、领域语气，最常用 |
| **DPO（偏好优化）** | 输入 + 好的输出 + 差的输出 | 调整风格偏好，如更简洁、更礼貌，不需要训练奖励模型 |
| **RFT（强化微调）** | 输入 + 评分规则 | 用评分器打分强化推理能力，适合有明确对错标准的复杂任务 |
| **蒸馏** | 大模型生成的高质量输出 | 用大模型的结果训练小模型，降低推理成本，是企业最常见的落地方式 |

### 2、按更新的参数分

| 方法 | 资源需求 | 优点 | 缺点 |
|------|----------|------|------|
| **全量微调** | 最高，需要多卡并保存完整权重副本 | 效果上限高 | 成本高，容易灾难性遗忘，每个任务一份完整模型 |
| **LoRA** | 中等，只训练少量新增参数 | 训练快，产物只有几十到几百 MB 的适配器，可按任务切换 | 效果略逊于全量，需要选择插入的层和秩 |
| **QLoRA** | 低，基座以 4 bit 量化加载 | 单张消费级显卡也能微调中等规模模型 | 训练速度比 LoRA 慢，量化带来少量精度损失 |

### 3、LoRA 与 QLoRA 原理

LoRA（Low-Rank Adaptation）冻结原始权重 W，在旁边加一条由两个小矩阵组成的旁路：A 把输入从 d 维降到 r 维，B 再升回 d 维，训练时只更新 A 和 B。输出变为 h = W·x + B·A·x，其中 r 远小于 d（常取 8、16、32），需要训练的参数通常只占原模型的 1% 以下。

![LoRA 低秩旁路](../../assets/ai/lora-adapter.svg)

QLoRA 是一种**训练**技巧：基座模型以 4 bit 量化形式加载以节省显存，LoRA 适配器仍以较高精度训练。部署时常见两种方式：把适配器合并回 16 bit 的基座权重后导出完整模型，或者在推理框架中「基座 + 适配器」动态加载，后者便于一个基座服务多个任务。

---

## 三、数据准备

### 1、格式

主流工具都接受「对话消息」格式的 JSONL，每行一条完整样本（下面为了阅读做了换行，实际文件中一条样本必须写在一行）：

```json
{
  "messages": [
    {"role": "system", "content": "你是 Java 代码审查助手，用 Markdown 列表输出审查意见。"},
    {"role": "user", "content": "审查以下代码：\nString sql = \"SELECT * FROM user WHERE id = \" + userId;"},
    {"role": "assistant", "content": "- **高危**：SQL 拼接存在注入风险。\n- **建议**：使用 PreparedStatement 或 MyBatis 的 #{} 参数绑定。"}
  ]
}
```

DPO 样本额外包含一条「更好的回答」和一条「更差的回答」，具体字段名以所用平台或工具的文档为准。

### 2、数据量

| 样本量 | 适用阶段 |
|--------|----------|
| 50～100 条 | 验证可行性，看方向对不对 |
| 几百条 | 单一、明确的任务，如分类、格式转换 |
| 1000～几千条 | 复杂任务，追求稳定效果 |

### 3、质量原则

- **质量优先**：100 条精心校对的样本胜过 1000 条噪声样本，错误样本会被模型忠实地学会
- **覆盖面**：包含边界情况、错误输入、各种表达方式，以及「应该拒绝或说不知道」的样本
- **一致性**：同类任务的输出格式必须完全统一，格式不一致是微调失败最常见的原因
- **人工复核**：至少抽检 20%；用大模型生成或改写的样本更要复核
- **合规与脱敏**：训练数据里的个人信息、密钥、客户数据要先脱敏，上传到第三方平台前确认数据协议，见 [数据安全](/security/7_data_security)
- **切分**：按 9:1 左右划分训练集和验证集，验证集不少于几十条，并且与训练集没有重复

---

## 四、托管微调与本地微调

### 1、托管微调

云厂商提供「上传数据 → 创建任务 → 得到新模型 ID」的托管服务，不用管 GPU 与训练细节，适合已经在用该厂商模型的团队。各平台支持的基座模型、方法和价格变化很快，以官方文档为准：

- OpenAI：提供 SFT、DPO、RFT 和视觉微调，但官方文档已说明正在收缩微调平台，新用户无法开通，已有用户在过渡期内仍可创建任务，已微调模型在其基座模型下线前可继续调用
- Google Vertex AI：Gemini 等模型的调优服务
- Amazon Bedrock：多家基座模型的定制，包括微调与蒸馏等方式
- 阿里云百炼：通义千问系列模型的训练与部署

托管微调产出的模型通过原来的 API 调用，只是把模型 ID 换成微调后的 ID，Java 侧不需要改代码，见第六节。

### 2、本地微调

开源模型（如 Qwen、Llama、Mistral 等系列）可以在自己的 GPU 上微调，数据不出内网，产物完全自有。常用工具：

| 工具 | 特点 | 适用 |
|------|------|------|
| LLaMA-Factory | Web UI + 命令行，支持模型多，中文资料丰富 | 快速实验 |
| Unsloth | 显存占用低、训练快，可导出 GGUF | 单卡微调 |
| Axolotl | 配置文件驱动 | 工程化、接入 CI |
| Hugging Face TRL / PEFT | 官方训练库，SFT、DPO 等方法齐全 | 需要定制训练流程 |

以 LLaMA-Factory 为例，训练参数写在 YAML 里，命令只负责启动：

```yaml
# qlora_sft.yaml
model_name_or_path: <base-model>   # 基座模型，如 Hugging Face 上的 Qwen 系列 Instruct 模型
template: <template>               # 与基座匹配的对话模板，见 LLaMA-Factory 文档
stage: sft
finetuning_type: lora
lora_rank: 16
quantization_bit: 4                # 4 bit 加载基座，即 QLoRA
dataset: code_review               # 在 data/dataset_info.json 中登记的数据集
num_train_epochs: 3
per_device_train_batch_size: 2
gradient_accumulation_steps: 8
val_size: 0.1
output_dir: ./output/code-review-lora
```

```bash
llamafactory-cli train qlora_sft.yaml
# 训练完成后用 export 子命令把适配器合并进基座，导出完整模型
```

---

## 五、评估

### 1、看 Loss 曲线

- **正常收敛**：训练 loss 与验证 loss 同步下降后趋于平稳
- **过拟合**：训练 loss 持续下降，验证 loss 在某一轮之后开始上升；应减少训练轮数、增加数据多样性或降低学习率
- **欠拟合**：两条曲线都下降得很慢或停在高位；检查数据格式与模板是否正确，再考虑增加轮数或提高秩

### 2、看业务指标

Loss 低不代表效果好，最终要用评估集比较：

- **基线对比**：同一评估集上比较「原模型 + 最佳 Prompt」与「微调模型」，微调必须明显更好才值得维护
- **任务指标**：分类任务看准确率与召回率，格式任务看结构校验通过率，生成任务用评分标准人工或 LLM 打分
- **通用能力回归**：抽查与训练任务无关的问题，确认没有出现灾难性遗忘
- **安全回归**：确认微调没有削弱拒答能力，例如不会因为训练样本而输出敏感信息

### 3、版本管理

每个微调模型记录：基座模型与版本、训练数据版本（文件哈希）、超参数、评估结果、上线和下线时间。模型 ID 写在配置中心里，回滚只需要改配置。

---

## 六、Java 侧部署与调用

### 1、部署方式

| 来源 | 部署方式 | Java 侧接入 |
|------|----------|-------------|
| 托管微调 | 厂商托管，得到新模型 ID | 原有 SDK / Spring AI 配置，把模型 ID 换掉 |
| 本地微调 → Ollama | 合并后导出 safetensors 或 GGUF，在 Modelfile 中用 `FROM` 指向它，`ollama create` 生成模型 | Spring AI Ollama starter，见 [Ollama](../3_integration/0_ollama) |
| 本地微调 → vLLM 等推理服务 | 推理框架加载基座与适配器，提供 OpenAI 兼容接口 | Spring AI OpenAI starter，`base-url` 指向推理服务 |

### 2、调用：模型 ID 走配置

无论哪种来源，Java 代码都不应写死模型 ID：

```yaml
spring:
  ai:
    openai:
      api-key: ${LLM_API_KEY}
      base-url: ${LLM_BASE_URL}      # 托管服务地址，或自建 vLLM 的 OpenAI 兼容地址
      chat:
        model: ${CODE_REVIEW_MODEL_ID}   # 微调后得到的模型 ID，放在配置中心便于切换与回滚
        temperature: 0.2
```

```java
@Service
public class CodeReviewService {

    private final ChatClient chatClient;

    public CodeReviewService(ChatClient.Builder builder) {
        // 系统提示词与训练数据保持一致，否则微调效果会打折
        this.chatClient = builder
                .defaultSystem("你是 Java 代码审查助手，用 Markdown 列表输出审查意见。")
                .build();
    }

    public String review(String code) {
        return chatClient.prompt()
                .user("审查以下代码：\n" + code)
                .call()
                .content();
    }
}
```

上线时按灰度比例把流量切到微调模型，同时保留原模型作为降级方案，监控两者的效果指标与延迟。

### 3、成本估算

- **训练成本** ≈ 训练集总 Token 数 × 训练轮数 × 训练单价（托管）；本地训练则是 GPU 时长 × 单位成本
- **推理成本** ≈ 调用次数 × 每次的输入与输出 Token × 推理单价；微调模型的单价可能高于同基座的原模型
- **收益**：去掉长系统提示词与 few-shot 示例节省的输入 Token，以及换用小模型节省的单价

例如 1000 条样本、每条平均 500 Token、训练 3 轮，训练 Token 为 1000 × 500 × 3 = 150 万。单价以各平台定价页为准。

---

## 小结

- 微调排在 Prompt 工程和 RAG 之后：先建评估集，知识类需求用 RAG，行为与格式类需求才考虑微调
- SFT 最常用，DPO 调偏好，RFT 强化推理，蒸馏用于把大模型能力迁移到小模型
- LoRA 只训练低秩旁路，QLoRA 进一步以 4 bit 加载基座降低显存，部署时可合并或动态加载适配器
- 数据质量和格式一致性决定成败；评估要同时看 loss、业务指标、通用能力与安全回归
- Java 侧通过 Ollama 或 OpenAI 兼容接口调用微调模型，模型 ID 走配置，灰度上线并保留降级

Prompt 工程、RAG、微调三者的对比只在本篇维护。

## 参考资料

- OpenAI 模型优化与微调：[https://developers.openai.com/api/docs/guides/model-optimization](https://developers.openai.com/api/docs/guides/model-optimization)
- Google Vertex AI 模型调优：[https://cloud.google.com/vertex-ai/generative-ai/docs/models/tune-models](https://cloud.google.com/vertex-ai/generative-ai/docs/models/tune-models)
- Amazon Bedrock 自定义模型：[https://docs.aws.amazon.com/bedrock/latest/userguide/custom-models.html](https://docs.aws.amazon.com/bedrock/latest/userguide/custom-models.html)
- 阿里云百炼模型训练：[https://www.alibabacloud.com/help/en/model-studio/model-training-on-console](https://www.alibabacloud.com/help/en/model-studio/model-training-on-console)
- LoRA 论文：[https://arxiv.org/abs/2106.09685](https://arxiv.org/abs/2106.09685)
- QLoRA 论文：[https://arxiv.org/abs/2305.14314](https://arxiv.org/abs/2305.14314)
- LLaMA-Factory：[https://github.com/hiyouga/LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)
- Unsloth 文档：[https://docs.unsloth.ai/](https://docs.unsloth.ai/)
- Hugging Face PEFT：[https://huggingface.co/docs/peft/index](https://huggingface.co/docs/peft/index)
- Hugging Face TRL：[https://huggingface.co/docs/trl/index](https://huggingface.co/docs/trl/index)
- Ollama 导入模型：[https://docs.ollama.com/import](https://docs.ollama.com/import)

> 下一篇：[AI 编程工具怎么选](../6_tools/0_ai_tools)

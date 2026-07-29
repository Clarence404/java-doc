# 模型微调

> 参考资料：
> * OpenAI Fine-tuning：[https://platform.openai.com/docs/guides/fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
> * Hugging Face Fine-tuning：[https://huggingface.co/docs/transformers/training](https://huggingface.co/docs/transformers/training)
> * LLaMA Factory：[https://github.com/hiyouga/LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)

---

## 一、是什么 & 何时用

微调（Fine-tuning）是在预训练模型的基础上，用特定领域的标注数据继续训练，使模型适应特定任务或风格。

### 三种方案对比

| 维度 | Prompt Engineering | RAG | Fine-tuning |
|---|---|---|---|
| **原理** | 通过精心设计 Prompt 引导模型 | 检索外部知识注入上下文 | 在训练数据上更新模型权重 |
| **成本** | 极低（仅调整文本） | 中等（向量库 + 检索服务） | 高（GPU 算力 + 标注数据） |
| **知识更新** | 随 Prompt 即时更新 | 更新向量库即可 | 需重新训练 |
| **输出风格控制** | 有限，依赖 Prompt 提示 | 有限 | 强，能固化特定格式和语气 |
| **幻觉风险** | 中等 | 低（有文档依据） | 中等（仍可能幻觉） |
| **适用场景** | 通用任务、快速原型 | 知识密集型问答、文档检索 | 固定格式输出、专业领域语气、替换 few-shot |

### 何时选择微调

满足以下条件时才考虑微调，否则优先用 Prompt Engineering 或 RAG：

- 需要**固定的输出格式**（如特定 JSON 结构），few-shot 也无法稳定达到
- 需要**特定的语气或领域词汇**（如企业内部术语、行业缩写）
- 有**足够的高质量标注数据**（≥ 50 条，推荐 500～2000 条）
- **RAG 无法满足**（任务不依赖外部文档，而是依赖行为模式）
- **推理延迟敏感**（微调后可用更小的模型替代大模型 + 长 System Prompt）

---

## 二、微调类型

| 类型 | 资源需求 | 适用模型规模 | 优点 | 缺点 |
|---|---|---|---|---|
| **全量微调**（Full Fine-tuning） | 极高（多块 A100） | 7B 以下 | 效果上限最高 | 成本高，容易灾难性遗忘 |
| **LoRA** | 中等（单卡 16GB+） | 7B～70B | 参数量少，训练快，效果接近全量 | 需要合并或加载 adapter |
| **QLoRA** | 低（单卡 8GB）| 7B～70B | 量化后显存需求极低 | 推理时需要反量化，有轻微精度损失 |
| **PEFT（统称）** | 取决于具体方法 | 通用 | 官方库统一管理多种方法 | 配置较复杂 |

**实践建议：** 本地资源有限时首选 QLoRA + LLaMA Factory；有预算且使用 OpenAI 模型时直接用 OpenAI Fine-tuning API（内部托管，无需关心训练细节）。

---

## 三、数据准备

### JSONL 格式（OpenAI / LLaMA Factory 通用）

每行一个 JSON 对象，包含 `system`、`user`、`assistant` 三段对话：

```jsonl
{"messages": [{"role": "system", "content": "你是一个 Java 代码审查助手，以结构化 Markdown 列表格式输出审查意见。"}, {"role": "user", "content": "审查以下代码：\npublic List<User> getUsers() {\n    return userRepository.findAll();\n}"}, {"role": "assistant", "content": "## 代码审查意见\n\n- **性能风险**：`findAll()` 会加载全表数据，数据量大时会导致 OOM，建议改为分页查询。\n- **建议**：使用 `findAll(Pageable pageable)` 并在接口层接收分页参数。"}]}
{"messages": [{"role": "system", "content": "你是一个 Java 代码审查助手，以结构化 Markdown 列表格式输出审查意见。"}, {"role": "user", "content": "审查以下代码：\nString sql = \"SELECT * FROM user WHERE id = \" + userId;"}, {"role": "assistant", "content": "## 代码审查意见\n\n- **高危漏洞**：存在 SQL 注入风险，用户传入的 `userId` 未经任何过滤直接拼接 SQL。\n- **建议**：使用 PreparedStatement 参数化查询，或改用 MyBatis/JPA 的参数绑定机制。"}]}
```

### 数据量建议

| 数量 | 适用场景 |
|---|---|
| 50～100 条 | 概念验证，验证可行性 |
| 200～500 条 | 单一简单任务（分类、格式转换） |
| 500～2000 条 | 复杂任务，效果稳定 |
| 2000 条以上 | 高精度要求、多场景覆盖 |

**数据质量原则：**

- **质量 > 数量**：100 条高质量数据优于 1000 条低质量数据
- **多样性**：覆盖边界情况、错误输入、不同表达方式
- **一致性**：同类任务输出格式必须完全统一，格式不一致是微调失败的主要原因
- **人工校验**：至少抽查 20% 的数据确认准确性

---

## 四、OpenAI Fine-tuning API

### 完整流程

#### 1. 上传训练文件

```bash
curl https://api.openai.com/v1/files \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F purpose="fine-tune" \
  -F file="@training_data.jsonl"

# 返回示例：
# {"id": "file-abc123", "object": "file", ...}
```

#### 2. 创建 Fine-tuning Job

```bash
curl https://api.openai.com/v1/fine_tuning/jobs \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "training_file": "file-abc123",
    "model": "gpt-4o-mini-2024-07-18",
    "hyperparameters": {
      "n_epochs": 3
    },
    "suffix": "code-reviewer"
  }'

# 返回示例：
# {"id": "ftjob-xyz789", "status": "queued", ...}
```

#### 3. 监控训练进度

```bash
curl https://api.openai.com/v1/fine_tuning/jobs/ftjob-xyz789 \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# 查看训练事件（含 loss 曲线数据）
curl https://api.openai.com/v1/fine_tuning/jobs/ftjob-xyz789/events \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

#### 4. 使用微调后的模型（Java SDK）

```java
// 微调完成后，模型 ID 格式为：ft:gpt-4o-mini-2024-07-18:org-name:code-reviewer:xxxx
@Service
public class FineTunedReviewService {

    private final OpenAIClient client;

    public FineTunedReviewService() {
        this.client = OpenAIOkHttpClient.fromEnv();
    }

    public String review(String code) {
        ChatCompletion response = client.chat().completions().create(
            ChatCompletionCreateParams.builder()
                // 替换为实际的微调模型 ID
                .model("ft:gpt-4o-mini-2024-07-18:my-org:code-reviewer:abc123")
                .addSystemMessage("你是一个 Java 代码审查助手，以结构化 Markdown 列表格式输出审查意见。")
                .addUserMessage("审查以下代码：\n" + code)
                .build()
        );

        return response.choices().get(0).message().content().orElse("");
    }
}
```

---

## 五、LoRA 本地微调（概念）

### LoRA 原理

LoRA（Low-Rank Adaptation）的核心思路：冻结原始模型权重，只在每个 Transformer 层的权重矩阵旁边插入两个小矩阵 A 和 B（低秩分解），训练时只更新 A 和 B。

```
原始权重矩阵 W（d×d）不更新
新增 ΔW = B × A，其中 B(d×r)、A(r×d)，r << d（如 r=8 或 r=16）
推理时：output = (W + ΔW) × input
```

**优势：** 对于 7B 参数的模型，LoRA 仅需训练约 0.1%～1% 的参数量，显存需求从 80GB+ 降至 16GB 以内；配合 QLoRA（4-bit 量化）可在 8GB 消费级 GPU 上完成微调。

### LLaMA Factory 快速上手

```bash
# 安装
pip install llamafactory

# 使用 Web UI 配置并启动训练（推荐新手）
llamafactory-cli webui

# 命令行启动 QLoRA 训练
llamafactory-cli train \
  --stage sft \
  --model_name_or_path meta-llama/Llama-3.1-8B-Instruct \
  --dataset my_dataset \
  --dataset_dir ./data \
  --template llama3 \
  --finetuning_type lora \
  --lora_rank 8 \
  --output_dir ./output/llama3-lora \
  --per_device_train_batch_size 2 \
  --gradient_accumulation_steps 4 \
  --num_train_epochs 3 \
  --quantization_bit 4

# 导出合并后的完整模型
llamafactory-cli export \
  --model_name_or_path meta-llama/Llama-3.1-8B-Instruct \
  --adapter_name_or_path ./output/llama3-lora \
  --export_dir ./output/llama3-merged \
  --template llama3
```

**常用工具对比：**

| 工具 | 特点 | 适用场景 |
|---|---|---|
| **LLaMA Factory** | Web UI + 命令行，支持 100+ 模型 | 快速实验，中文社区友好 |
| **Axolotl** | 配置文件驱动，灵活 | 工程化、CI/CD 集成 |
| **Hugging Face TRL** | 官方库，支持 RLHF/DPO | 需要 RLHF 对齐 |

---

## 六、评估与注意事项

### 训练集/验证集划分

```text
推荐比例：训练集 90% / 验证集 10%
最小验证集：50 条（少于此数量，验证集 loss 统计意义有限）
```

OpenAI Fine-tuning API 支持传入 `validation_file` 参数，训练过程中会同时输出验证集 loss。

### 通过 Loss 曲线判断过拟合

```text
正常收敛：
  训练 loss 平稳下降 → 趋于稳定
  验证 loss 同步下降 → 趋于稳定

过拟合信号：
  训练 loss 持续下降
  验证 loss 在某个 epoch 后开始上升

处理方式：
  减少训练轮次（n_epochs）
  增加训练数据多样性
  适当增大 dropout（本地训练时）
```

### 模型版本管理

```text
命名规范（推荐）：
  ft:gpt-4o-mini:{org}:{task}-v{版本号}:{job-id}
  示例：ft:gpt-4o-mini:acme:code-reviewer-v2:abc123

版本记录内容：
  - 训练日期
  - 训练数据版本（文件 hash 或数据集版本号）
  - 超参数（epochs, learning_rate_multiplier）
  - 验证集指标（loss, 业务指标）
  - 上线/下线时间
```

### OpenAI 微调成本参考

| 模型 | 训练价格 | 推理价格（输入/输出）|
|---|---|---|
| gpt-4o-mini-2024-07-18 | $0.003 / 1K tokens | $0.003 / $0.012 per 1K |
| gpt-4o-2024-08-06 | $0.025 / 1K tokens | $0.003 / $0.015 per 1K |

**估算示例：** 1000 条训练数据，每条平均 500 tokens，训练 3 个 epoch：
`1000 × 500 × 3 = 1,500,000 tokens ≈ $4.5`（使用 gpt-4o-mini）

> 注意：价格会随时调整，以 [OpenAI 官方定价页](https://openai.com/pricing) 为准。

---
description: 预测下一个 Token、训练三阶段、分词与计数、上下文窗口、采样参数、幻觉、结构化输出、流式响应
---

# 大模型基础概念

> 前置阅读：[AI 总览](../0_overview)

大模型是按概率逐个生成 Token 的外部服务，Token、上下文窗口和采样参数直接决定成本、效果与稳定性。本篇讲模型在做什么、Token 与上下文窗口、采样参数、幻觉、结构化输出与流式响应，基线为 Spring AI 2。

---

## 一、大模型在做什么

### 1、预测下一个 Token

大语言模型（LLM）只做一件事：给定前面的文本，算出「下一个 Token」的概率分布，从中选一个，拼到末尾，再预测下一个，如此循环直到输出结束标记或达到长度上限。这个过程叫**自回归生成**。

由此可以推出几个工程上的直觉：

- **输出是逐个生成的**：输出越长越慢，所以首 Token 延迟和总耗时是两个指标，也是流式响应存在的原因
- **模型没有记忆**：每次请求都是独立计算，多轮对话靠调用方把历史重新发一遍
- **模型不查数据库**：它只能利用训练时学到的知识和本次请求里给的内容，这是幻觉的根源（见第五节）
- **输出有随机性**：每一步都是从概率分布里抽样，抽样方式由采样参数控制（见第四节）

### 2、预训练、指令微调与 RLHF

一个可用的对话模型通常经过三个阶段：

| 阶段 | 做什么 | 得到什么 |
|------|--------|---------|
| 预训练 | 在海量文本上做「预测下一个 Token」 | 基座模型：懂语言、有知识，但只会续写，不会听指令 |
| 指令微调（SFT） | 用人工整理的「指令 → 回答」样本继续训练 | 会按指令回答问题、遵守格式 |
| 偏好对齐（RLHF 等） | 让人或模型给多个回答打分排序，用强化学习让模型偏向高分回答 | 回答更有用、更安全，更符合人类偏好 |

RLHF（基于人类反馈的强化学习）之后还出现了 DPO 等更简单的偏好对齐方法，以及用强化学习专门训练推理能力的推理模型。对调用方来说，记住两点就够了：模型的知识停在训练数据截止日期；它被训练成「给出看起来令人满意的回答」，而不是「只说确定的事」。推理模型怎么用见 [Prompt 工程](./1_prompt#四、推理模型与思维链)，自己微调见 [模型微调](../5_advanced/2_fine_tuning)。

---

## 二、Token 与分词

### 1、分词器怎么切

模型不直接处理字符，而是先用**分词器（Tokenizer）**把文本切成 Token，再把每个 Token 映射成一个整数 ID。主流分词器基于 BPE（字节对编码）一类算法：从字节或字符出发，把训练语料里高频出现的片段合并成一个 Token，最终得到一个固定大小的词表。

- 常见英文单词往往是一个 Token，罕见词会被拆成几段
- 空格、标点、换行、代码缩进都会占 Token
- 同一段文本，不同厂商、不同代际的模型切出来的 Token 数可能差很多

### 2、中文为什么 Token 数不同

词表是从训练语料里统计出来的。如果语料以英文为主，中文片段被合并成整词的机会就少，一个汉字可能是一个 Token，也可能被拆成多个字节级 Token；词表更大、中文语料更多的分词器，同样一句中文用的 Token 更少。

所以「一个汉字约等于几个 Token」没有通用答案：同一份中文 Prompt 在不同模型上的 Token 数、成本和占用的窗口都不同。换模型时要用新模型的分词器重新统计，不要沿用旧的换算比例。

### 3、为什么限制按 Token 算

模型内部的计算量、KV Cache 显存都和 Token 数成正比，所以上下文长度、最大输出、限流（每分钟 Token 数）和计费都以 Token 为单位，而不是字符数或字节数。

Token 数以响应里的 `usage` 字段为准，发送前预估可以用厂商的计数接口或对应的分词器，具体方法见 [大模型选型](./0_model#_3、token-怎么数)。

---

## 三、上下文窗口

### 1、输入和输出共享窗口

**上下文窗口**是模型单次请求能处理的 Token 上限。它不是「输入上限」，而是输入和输出共用的总预算：系统提示、工具定义、对话历史、检索到的文档、本轮用户输入，加上模型这次要生成的输出（推理模型还包括思考过程），都要装进同一个窗口。

![一次请求的上下文窗口构成](../../assets/ai/context-window.svg)

几个直接后果：

- 输入塞得越满，留给输出的空间越少；输入加上最大输出长度超过窗口时，有的厂商直接拒绝请求，有的生成到窗口上限就截断
- 推理模型的思考 Token 占用最大输出长度，最大输出设得太小，可能还没给出答案就被截断
- 缓存命中的前缀只是计费打折，仍然占窗口

### 2、长上下文的代价

窗口大不等于应该塞满，长上下文有三个代价：

- **成本**：每个输入 Token 都要计费，多轮对话还会重复计费
- **延迟**：输入越长，模型读完输入、吐出第一个 Token 的时间越长
- **效果下降**：输入越长，模型对其中信息的利用越差。斯坦福等机构的「Lost in the Middle」研究发现，关键信息放在开头或结尾时效果最好，放在长输入的中间时准确率明显下降；Anthropic 文档把这种随长度增长准确率下降的现象称为 context rot

对应的做法：只放和本次任务相关的内容，能用 [RAG](../4_core_tech/2_rag) 挑片段就不要整篇塞入；最重要的指令和问题放在开头或末尾；不变的长内容放在前缀，配合 Prompt 缓存降低成本和延迟（见 [Prompt 工程](./1_prompt#_1、为缓存排好顺序)）。

### 3、多轮对话的历史管理

模型无状态，第 N 轮请求要带上前 N−1 轮的全部消息，历史会一直增长，直到撞上窗口上限，成本也随轮数快速上升。常见的裁剪策略：

| 策略 | 做法 | 优缺点 |
|------|------|--------|
| 滑动窗口 | 只保留最近 N 条消息或最近 N 个 Token | 简单可控；早期信息直接丢失 |
| 摘要压缩 | 历史超过阈值时，用一个轻量模型把早期对话压缩成摘要，替换原始消息 | 保留要点；多一次模型调用，细节会丢 |
| 检索记忆 | 把历史消息存进向量库，每轮只检索和当前问题相关的几条 | 适合超长会话；实现复杂 |
| 厂商侧压缩 | 部分厂商提供服务端自动压缩或清理旧工具结果的能力 | 省事；依赖特定厂商 |

裁剪时有两条规则：系统提示永远保留；工具调用请求和对应的工具结果要成对保留或成对删除，只删一半会导致请求报错。Spring AI 自带的消息窗口记忆见 [Spring AI](../2_frameworks/0_spring_ai#_2、对话记忆)。

---

## 四、采样参数

模型每一步都会给出所有候选 Token 的概率，采样参数决定怎么从中挑一个。

### 1、temperature

temperature 调整概率分布的「尖锐程度」：值越低，高概率的 Token 越占优势，输出越稳定、越保守；值越高，分布越平坦，低概率的 Token 也有机会被选中，输出越发散。

| 场景 | 建议 |
|------|------|
| 信息抽取、分类、结构化输出、代码生成 | 低值（接近 0） |
| 日常问答、RAG 回答 | 中低值，或直接用厂商默认值 |
| 文案、头脑风暴 | 较高值 |

取值范围和默认值各家不同（例如有的是 0～1，有的是 0～2），部分推理模型不允许修改 temperature，传了会报错，以模型文档为准。

### 2、top_p 与 top_k

- **top_p**（核采样）：把候选 Token 按概率从高到低累加，只在累计概率达到 p 的那一小撮里抽样，例如 0.9 表示砍掉概率最低、合计 10% 的长尾
- **top_k**：只在概率最高的 k 个候选里抽样；不是所有厂商都支持

temperature、top_p、top_k 作用类似，一般只调一个，其余保持默认；同时调多个很难判断是哪个起了作用，有的模型还不允许同时设置 temperature 和 top_p。

### 3、最大输出长度与停止序列

- **最大输出 Token 数**：生成到这个数就强制停止，是控制成本和延迟最直接的手段。注意它是硬截断，截断时响应的结束原因会标明是「达到长度上限」，代码要检查结束原因，否则会把半截 JSON 当成完整结果。不同厂商、不同模型参数名不同（例如 OpenAI 推理模型要用 `max_completion_tokens`）
- **停止序列（stop sequences）**：输出中出现指定字符串时立即停止，适合「只要第一行」「遇到某个分隔符就结束」这类场景；停止序列本身通常不会出现在输出里

### 4、seed 与输出不一致

即使 temperature 设为 0，同样的请求也不保证每次输出完全一样，原因包括：

- 服务端批处理、并行计算中的浮点运算顺序不同，会带来微小数值差异，在概率接近的分叉点上放大成不同输出
- 厂商会更新模型和推理系统，同一个模型别名背后的实现可能变化
- MoE 模型的路由、服务端负载等因素也会引入不确定性

部分厂商支持 `seed` 参数，官方表述是「尽力」做到可复现，并不保证。业务上需要确定性时，不要依赖采样参数，而要在系统设计上解决：缓存首次结果、对输出做结构化校验、关键判断交给代码。

### 5、Spring AI 2.0 设置参数

Spring AI 用可移植的 `ChatOptions` 表达通用参数（`temperature`、`maxTokens`、`topP`、`topK`、`stopSequences` 等）。2.0 中 `defaultOptions()` 和 `options()` 都接收 Builder，单次请求只覆盖显式设置的字段：

```java
import java.util.List;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.ChatOptions;
import org.springframework.stereotype.Service;

@Service
public class ExtractService {

    private final ChatClient chatClient;

    public ExtractService(ChatClient.Builder builder) {
        // 默认参数：对这个 ChatClient 的所有请求生效
        this.chatClient = builder
                .defaultOptions(ChatOptions.builder()
                        .temperature(0.3)
                        .maxTokens(1024))
                .build();
    }

    public String extractOrderNo(String text) {
        // 单次请求覆盖：只覆盖显式设置的字段，其余沿用默认值
        return chatClient.prompt()
                .user(u -> u.text("从下面的文本中找出订单号，只输出订单号本身，找不到输出 NONE：\n{text}")
                        .param("text", text))
                .options(ChatOptions.builder()
                        .temperature(0.0)
                        .maxTokens(32)
                        .stopSequences(List.of("\n")))
                .call()
                .content();
    }
}
```

`seed`、`max_completion_tokens` 这类厂商特有参数要用对应的实现类（如 `OpenAiChatOptions`）；对推理模型不要设置 temperature。配置文件写法、2.0 去掉默认 temperature 等细节见 [Spring AI](../2_frameworks/0_spring_ai#_2、配置)。

---

## 五、幻觉

### 1、为什么会幻觉

**幻觉**指模型输出看起来合理、实际错误或无中生有的内容，例如编造不存在的 API、论文、订单状态。原因来自它的工作方式：

- **目标是「像」而不是「对」**：模型按概率生成最像正确答案的文本，没有内置的「我不知道」机制
- **知识缺失**：训练数据里没有的私有数据、截止日期之后的新知识，它只能按模式去猜
- **训练偏好**：偏好对齐会奖励「给出完整回答」，模型倾向于自信作答而不是拒答
- **上下文问题**：输入过长、关键信息在中间、检索到的资料互相矛盾，都会让它答错

### 2、怎么降低

幻觉无法根除，只能分层降低并让错误可发现：

| 手段 | 做法 | 详见 |
|------|------|------|
| RAG | 把最新、私有的资料检索后放进上下文，代替模型「回忆」 | [RAG 检索增强生成](../4_core_tech/2_rag) |
| 依据约束（Grounding） | 要求只依据给定资料回答、标注来源；资料里没有时明确回答「未找到依据」 | [Prompt 工程](./1_prompt) |
| 工具调用 | 订单状态、库存、汇率等实时数据让模型调接口查询，而不是让它生成 | [Function Calling（工具调用）](./2_function_calling) |
| 结构化输出 | 用 Schema 约束输出格式，方便代码逐字段校验 | 本篇第六节 |
| 校验 | 代码校验字段合法性和业务规则；关键结论用第二次调用或规则复核；高风险操作需要人工确认 | — |

**常见坑**：结构化输出只保证格式正确，不保证内容正确；低 temperature 只让输出更稳定，稳定地错也是错。

---

## 六、结构化输出与流式响应

### 1、结构化输出

后端要解析模型的返回值时，不要靠 Prompt 里一句「请返回 JSON」。主流厂商有两档能力：

- **JSON 模式**：保证输出是合法 JSON，但不保证字段和类型符合预期
- **Schema 约束（结构化输出）**：请求里附上 JSON Schema，模型在解码阶段按 Schema 生成，字段、类型、必填项都有保证

能用 Schema 约束就不用 JSON 模式。即便如此，仍要处理两种情况：输出因达到长度上限被截断；模型出于安全原因拒答。在 Spring AI 中用 `.entity(Xxx.class)` 即可让框架生成 Schema 并反序列化，各家协议写法和框架用法见 [Prompt 工程](./1_prompt#五、结构化输出)。

### 2、流式响应

由于输出是逐个 Token 生成的，API 可以边生成边返回，通常走 SSE（Server-Sent Events）协议：

- **体验**：用户在首 Token 到达时就能看到内容，不用等整段生成完；总耗时不变
- **超时**：长输出用非流式调用容易触发网关或客户端的读超时，流式响应能持续有数据返回
- **代价**：中途出错时已经输出了一半；结构化输出要等流结束再整体解析；Token 用量、结束原因通常在最后一个事件里返回

Spring AI 用 `stream()` 返回 `Flux`，写法见 [Spring AI](../2_frameworks/0_spring_ai#_3、流式输出)；SSE 协议本身与网关缓冲问题见 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 七、Embedding

Embedding（向量化）模型和对话模型是两类模型：它不生成文本，而是把一段文本映射成一个固定长度的浮点数向量，语义相近的文本向量距离也近。语义搜索、RAG 检索、去重和推荐都建立在它之上，对话模型负责「生成」，Embedding 模型负责「找到相关内容」。原理、选型与接入见 [Embedding 向量化](../4_core_tech/0_embedding)。

---

## 小结

- 大模型按概率逐个生成 Token，没有记忆、不查数据库，知识停在训练截止日期；训练分预训练、指令微调、偏好对齐三个阶段
- Token 由分词器切分，同一段中文在不同模型上的 Token 数不同；长度、限流、计费都按 Token 算
- 上下文窗口由输入和输出共享；长上下文更贵、更慢，中间位置的信息容易被忽略；多轮历史要用滑动窗口、摘要或检索记忆裁剪
- temperature、top_p、top_k 一般只调一个；最大输出是硬截断，要检查结束原因；temperature 为 0 加 seed 也不保证完全确定
- 幻觉靠 RAG、依据约束、工具调用、结构化输出和代码校验分层降低；结构化输出优先用 Schema 约束，流式响应改善首屏体验

## 参考资料

- Claude - Context windows：[https://platform.claude.com/docs/en/build-with-claude/context-windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- Claude - Token counting：[https://platform.claude.com/docs/en/build-with-claude/token-counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- Claude - Messages API：[https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages)
- OpenAI - Structured Outputs：[https://developers.openai.com/api/docs/guides/structured-outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- Spring AI - Chat Client API：[https://docs.spring.io/spring-ai/reference/api/chatclient.html](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- Spring AI - ChatOptions（2.0.1 Javadoc）：[https://docs.spring.io/spring-ai/docs/2.0.1/api/org/springframework/ai/chat/prompt/ChatOptions.html](https://docs.spring.io/spring-ai/docs/2.0.1/api/org/springframework/ai/chat/prompt/ChatOptions.html)
- Liu et al. - Lost in the Middle: How Language Models Use Long Contexts：[https://arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172)
- Ouyang et al. - Training language models to follow instructions with human feedback（InstructGPT）：[https://arxiv.org/abs/2203.02155](https://arxiv.org/abs/2203.02155)

> 下一篇：[大模型选型](./0_model)

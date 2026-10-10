---
description: Embedding 原理、模型选型、相似度与归一化、维度与成本、Spring AI / LangChain4j 接入
---

# Embedding 向量化

> **本篇目标**：理解 Embedding 把文本变成向量的意义，能按语言、部署方式、许可证选出合适的模型，算清维度带来的存储与调用成本，并在 Spring AI 和 LangChain4j 中完成接入。
>
> **前置阅读**：[大模型选型](../1_concepts/0_model)（Token 与上下文的概念）

Embedding 是 RAG、语义搜索、推荐去重的地基：检索质量的上限，很大程度上在选模型和切块那一刻就定了。本篇代码基线为 JDK 21 / Spring Boot 4 / Spring AI 2.0.1 / LangChain4j 1.22.0；向量怎么存、怎么建索引见下一篇 [向量数据库](./1_vector_db)。

---

## 一、Embedding 是什么

### 1、把语义映射成向量

**Embedding（嵌入）** 用一个模型把文本（或图片、音频）映射成固定长度的浮点数组。训练目标让「意思相近的文本，向量方向也相近」，于是「找语义相似的内容」就变成了「找距离最近的向量」。

直观理解：「猫」「狗」都是宠物，向量会挨得很近；「猫」和「汽车」则离得很远。真实模型的维度在几百到几千之间，每一维没有可解释的含义，语义分布在所有维度的组合里。

### 2、典型用途

- **语义搜索**：用户说「怎么退款」，也能命中标题为「售后与退货流程」的文档，不依赖关键词重合
- **RAG 检索**：问题和文档片段都向量化，按相似度取出最相关的片段交给 LLM，见 [RAG 检索增强生成](./2_rag)
- **分类、聚类、去重**：直接在向量空间里算距离，例如工单自动归类、相似问题合并
- **推荐**：用户画像与物品都向量化，用相似度做召回

---

## 二、模型怎么选

### 1、主流模型家族

下表只列模型家族与稳定的结构参数，具体型号、上下文长度与价格变化较快，以各家官方模型页为准。

| 模型家族 | 提供方 | 默认维度 | 部署方式 | 许可 / 说明 |
|----------|--------|----------|----------|-------------|
| `text-embedding-3-small` / `-large` | OpenAI | 1536 / 3072，可用 `dimensions` 缩短 | API | 闭源；`text-embedding-ada-002` 为上一代，新项目不再选用 |
| `gemini-embedding-001` / `gemini-embedding-2` | Google | 3072，可缩短到 768 / 1536 等 | API | 闭源；`-2` 支持图片、音频等多模态输入 |
| Qwen3-Embedding（0.6B / 4B / 8B） | 阿里通义 | 1024 / 2560 / 4096，支持自定义维度 | 自部署 / Ollama | Apache-2.0，中文与多语言表现好，查询侧可加任务指令 |
| BGE-M3 | BAAI | 1024 | 自部署 / Ollama（`bge-m3`） | MIT，同时输出稠密、稀疏、多向量三种表示 |
| nomic-embed-text | Nomic AI | 768 | 自部署 / Ollama | 开源，体积小，适合本地开发 |
| jina-embeddings-v3 | Jina AI | 1024 | API / 自部署 | 权重为 CC BY-NC 4.0，仅限非商用，商用需走官方授权或 API |

### 2、选型要点

- **语言**：中文为主的知识库优先试 Qwen3-Embedding、BGE-M3 这类中文语料充足的模型
- **数据能否出境 / 出内网**：不能出网就只能自部署，Ollama 是 Java 团队最省事的本地方案，见 [Ollama](../3_integration/0_ollama)
- **许可证**：开源不等于可商用，上线前确认权重许可
- **榜单只作初筛**：[MTEB 排行榜](https://huggingface.co/spaces/mteb/leaderboard) 能缩小范围，最终要用自己业务的几十到几百条「问题 → 应命中文档」样本实测召回率，评估方法见 [RAG 检索增强生成](./2_rag)

**常见坑**：一个索引只能用一个模型、一个维度。不同模型产出的向量不在同一个空间里，混在一起检索结果毫无意义；换模型就要全量重新向量化，所以入库时把模型名和维度写进元数据。

---

## 三、相似度与归一化

### 1、三种相似度

设两个向量为 A、B：

- **余弦相似度**：`cos(A, B) = (A · B) / (‖A‖ × ‖B‖)`，取值 [-1, 1]，只看方向不看长度，是文本语义检索的默认选择
- **点积（内积）**：`A · B = Σ aᵢ × bᵢ`，同时受方向和长度影响；向量已归一化（长度为 1）时与余弦相似度完全等价，且少一次除法
- **欧氏距离（L2）**：`‖A − B‖ = √Σ (aᵢ − bᵢ)²`，值越小越相似；对归一化向量，L2 排序结果与余弦一致

| 方法 | 适用场景 | 注意 |
|------|----------|------|
| 余弦相似度 | 语义搜索、RAG 检索（默认） | 未归一化的向量也能用 |
| 点积 | 已归一化向量的快速比较 | 向量未归一化时长向量会被高估 |
| 欧氏距离 | 聚类、K-NN 分类 | 与索引的距离类型保持一致 |

向量库建索引时要指定距离类型，必须与模型推荐的度量一致，否则索引按一种距离组织、查询按另一种距离排序，召回率会明显下降。

### 2、归一化：先确认再处理

- **OpenAI**：官方文档说明 Embedding 已归一化到长度 1，可直接用点积代替余弦
- **Gemini `gemini-embedding-001`**：只有默认 3072 维输出是归一化的，缩短维度后需要自己归一化；`gemini-embedding-2` 会自动归一化缩短后的向量
- **开源模型**：是否归一化取决于推理框架和调用参数（如 sentence-transformers 的 `normalize_embeddings`），不能一概而论；上线前抽几条向量算一下 L2 范数，接近 1 就是已归一化
- **自己截断了维度**：无论哪个模型，手动截断后都要重新归一化

需要手动处理时，归一化就是除以自身的 L2 范数：

```java
public static float[] normalize(float[] vec) {
    double sum = 0;
    for (float v : vec) {
        sum += v * v;
    }
    double norm = Math.sqrt(sum);
    if (norm == 0) {
        return vec;
    }
    float[] result = new float[vec.length];
    for (int i = 0; i < vec.length; i++) {
        result[i] = (float) (vec[i] / norm);
    }
    return result;
}
```

---

## 四、维度与成本

### 1、存储成本

原始向量的存储量 = 向量条数 × 维度 × 每维字节数（float32 为 4 字节，half 精度为 2 字节）。按 100 万条 float32 估算：

| 维度 | 原始向量体积 | 说明 |
|------|--------------|------|
| 384 | 约 1.5 GB | 小模型，适合原型 |
| 768 | 约 3.1 GB | 本地模型常见维度 |
| 1024 | 约 4.1 GB | BGE-M3、Qwen3-Embedding-0.6B |
| 1536 | 约 6.1 GB | text-embedding-3-small 默认 |
| 3072 | 约 12.3 GB | text-embedding-3-large、gemini-embedding 默认 |

这只是原始数据，HNSW 等索引还要额外占用内存，且常驻内存才能保证延迟。维度越高，单次距离计算越慢、内存越贵，召回质量的提升却是边际递减的。

### 2、缩短维度（Matryoshka）

OpenAI text-embedding-3、Gemini Embedding、Qwen3-Embedding 都采用 Matryoshka 表示学习训练，向量前面的维度信息量最大，可以只取前 N 维：OpenAI 用请求参数 `dimensions`，Gemini 用 `output_dimensionality`。实践中常把 3072 维缩到 1024 或 768，存储减到三分之一以下，召回损失通常很小，但要用自己的评估集确认。

维度还会碰到向量库的硬限制：pgvector 的 HNSW 索引对 `vector` 类型最多支持 2000 维，3072 维要么缩短维度，要么改用 `halfvec`（最多 4000 维），详见 [向量数据库](./1_vector_db)。

### 3、调用成本

调用 API 的费用 = 向量化的总 Token 数 × 单价，单价以官方定价页为准。总 Token 数 = 首次全量入库的文档 Token + 每次增量更新的 Token + 每次查询的问题 Token。全量重建（换模型、换切块策略）会再付一次全量费用，这也是要在早期把模型和切块定下来的原因。自部署模型没有按量费用，成本转为 GPU / CPU 资源与运维。

---

## 五、Spring AI 接入

Spring AI 用 `EmbeddingModel` 统一抽象各家 Embedding 服务，版本由 `spring-ai-bom` 管理（BOM 写法见 [Spring AI](../2_frameworks/0_spring_ai)）。

### 1、OpenAI

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
</dependency>
```

Spring AI 2.0 的模型参数直接写在 `spring.ai.openai.embedding.*` 下。默认模型是旧的 `text-embedding-ada-002`，务必显式指定：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        model: ${EMBEDDING_MODEL_ID}   # 如 text-embedding-3-small，型号见 OpenAI 模型页
        dimensions: 1024               # 可选：Matryoshka 缩短维度
```

```java
@Service
public class EmbeddingService {

    private final EmbeddingModel embeddingModel;

    public EmbeddingService(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    public float[] embed(String text) {
        return embeddingModel.embed(text);
    }

    // 批量接口一次请求处理多条，比逐条调用少很多网络往返
    public List<float[]> embedBatch(List<String> texts) {
        return embeddingModel.embed(texts);
    }

    public int dimensions() {
        return embeddingModel.dimensions();
    }
}
```

### 2、切换到 Ollama 本地模型

换成 `spring-ai-starter-model-ollama`，模型先用 `ollama pull bge-m3` 拉到本地：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-ollama</artifactId>
</dependency>
```

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      embedding:
        model: bge-m3
```

两个 starter 同时存在时，用 `spring.ai.model.embedding=ollama`（或 `openai`）指定由谁提供 `EmbeddingModel`，否则会出现两个候选 Bean。

---

## 六、LangChain4j 接入

### 1、依赖

LangChain4j 的稳定模块与 beta 模块版本号不同，统一用 BOM 管理，各模块不写版本：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-bom</artifactId>
            <version>1.22.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>dev.langchain4j</groupId>
        <artifactId>langchain4j-open-ai</artifactId>
    </dependency>
    <!-- 本地 ONNX 小模型，无需 API Key，适合单元测试与原型 -->
    <dependency>
        <groupId>dev.langchain4j</groupId>
        <artifactId>langchain4j-embeddings-all-minilm-l6-v2</artifactId>
    </dependency>
</dependencies>
```

### 2、调用

```java
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.embedding.onnx.allminilml6v2.AllMiniLmL6V2EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;

EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName(System.getenv("EMBEDDING_MODEL_ID"))  // 型号见 OpenAI 模型页
        .dimensions(1024)
        .build();

Embedding one = embeddingModel.embed("Java 并发编程").content();
float[] vector = one.vector();

List<TextSegment> segments = List.of(
        TextSegment.from("Spring Boot 自动配置原理"),
        TextSegment.from("Redis 缓存穿透解决方案"));
List<Embedding> batch = embeddingModel.embedAll(segments).content();

// 进程内运行的 384 维小模型
EmbeddingModel localModel = new AllMiniLmL6V2EmbeddingModel();
```

接 Ollama 时换成 `langchain4j-ollama` 模块的 `OllamaEmbeddingModel`（`baseUrl` + `modelName`）。在 Spring Boot 4 中，`langchain4j-open-ai-spring-boot4-starter` 会按 `langchain4j.open-ai.embedding-model.*` 配置自动创建 `EmbeddingModel` Bean。

---

## 七、工程实践

- **批量与限流**：用批量接口，单次条数与 Token 上限见各家文档；遇到 429 按 `Retry-After` 或指数退避重试，入库任务限制并发
- **按内容哈希缓存**：以「模型名 + 维度 + 文本哈希」为键缓存向量，增量入库时跳过未变化的片段，能省掉大部分重复费用
- **查询与文档区别对待**：部分模型要求查询和文档用不同的前缀或任务类型，如 Qwen3-Embedding 在查询侧加任务指令、`gemini-embedding-001` 设置 `task_type`，用错会拉低召回
- **记录版本**：元数据里写入模型名、维度、切块策略版本，换模型时按版本双写、灰度切换，验证后再删除旧索引
- **敏感数据**：送往外部 API 的文本即离开了内网，涉及个人信息与商业机密的内容先脱敏或改用自部署模型，见 [数据安全](/security/7_data_security)

---

## 小结

- Embedding 把语义变成向量，检索就是找最近的向量；同一索引只能用同一个模型与维度，换模型要全量重建
- 选型看语言、能否出网、许可证，榜单只做初筛，最终用自己的评估集测召回
- 余弦相似度是默认选择；归一化与否要按模型和推理框架确认，截断维度后必须重新归一化
- 存储量 = 条数 × 维度 × 字节数，调用费用 = 总 Token × 单价；Matryoshka 缩短维度是最直接的降本手段
- Spring AI 2.0 用 `spring.ai.<厂商>.embedding.model` 指定模型，LangChain4j 用 BOM 管理版本

## 参考资料

- OpenAI Embeddings：[https://developers.openai.com/api/docs/guides/embeddings](https://developers.openai.com/api/docs/guides/embeddings)
- Gemini Embeddings：[https://ai.google.dev/gemini-api/docs/embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- Qwen3-Embedding：[https://huggingface.co/Qwen/Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- BGE-M3：[https://huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)
- jina-embeddings-v3：[https://huggingface.co/jinaai/jina-embeddings-v3](https://huggingface.co/jinaai/jina-embeddings-v3)
- Ollama 嵌入模型（bge-m3）：[https://ollama.com/library/bge-m3](https://ollama.com/library/bge-m3)
- MTEB 排行榜：[https://huggingface.co/spaces/mteb/leaderboard](https://huggingface.co/spaces/mteb/leaderboard)
- Spring AI Embeddings：[https://docs.spring.io/spring-ai/reference/api/embeddings.html](https://docs.spring.io/spring-ai/reference/api/embeddings.html)
- LangChain4j RAG（含 Embedding 模型）：[https://docs.langchain4j.dev/tutorials/rag](https://docs.langchain4j.dev/tutorials/rag)

> 下一篇：[向量数据库](./1_vector_db)

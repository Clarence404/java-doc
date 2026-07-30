# Embedding

> 参考资料：
> * OpenAI Embeddings：[https://platform.openai.com/docs/guides/embeddings](https://platform.openai.com/docs/guides/embeddings)
> * Sentence Transformers：[https://www.sbert.net/](https://www.sbert.net/)
> * Spring AI EmbeddingModel：[https://docs.spring.io/spring-ai/reference/api/embeddings.html](https://docs.spring.io/spring-ai/reference/api/embeddings.html)

---

## 一、是什么

**Embedding（嵌入）** 是将文本（或图片、音频等）映射到高维实数向量空间的技术。语义相近的文本，在向量空间中的距离也更近。

直觉理解：假设用 3 维向量粗略表示词义，"猫"和"狗"都是家养动物，它们的向量可能是 `[0.8, 0.7, 0.1]` 和 `[0.75, 0.72, 0.08]`，而"猫"和"汽车"差异极大，汽车向量可能是 `[0.1, 0.05, 0.95]`。实际模型使用 768～3072 维，语义信息被精确编码在每一维中。

这种特性使 Embedding 成为以下任务的核心：

- **语义搜索**：不依赖关键字，找到语义相近的文档
- **RAG 检索**：将问题和文档片段都向量化，通过相似度匹配找到相关上下文
- **文本分类、聚类、去重**：直接在向量空间操作
- **推荐系统**：用户行为和物品都映射为向量，计算偏好相似度

---

## 二、常用模型

| 模型 | 提供方 | 维度 | 特点 | 是否开源 | 适用场景 |
|------|--------|------|------|----------|----------|
| `text-embedding-3-small` | OpenAI | 1536（可缩减） | 性价比高，速度快 | 否（API） | 通用语义搜索、RAG |
| `text-embedding-3-large` | OpenAI | 3072（可缩减） | 精度最高的 OpenAI 模型 | 否（API） | 高精度场景 |
| `text-embedding-ada-002` | OpenAI | 1536 | 旧版，已被 v3 替代 | 否（API） | 兼容旧系统 |
| `BGE-M3` | BAAI | 1024 | 多语言、多粒度，中文效果强 | 是 | 中文 RAG、多语言场景 |
| `nomic-embed-text` | Nomic AI | 768 | 完全开源，支持本地部署，8192 上下文 | 是 | 本地部署、长文档 |
| `jina-embeddings-v3` | Jina AI | 1024 | 多任务，支持 retrieval/clustering 等任务类型 | 是（权重） | 多任务场景 |

> **选型建议**：有预算且数据可出境 → `text-embedding-3-small`；需要中文优化或本地化部署 → `BGE-M3` 或 `nomic-embed-text`（通过 Ollama 运行）。

---

## 三、相似度计算

向量化之后，通过相似度函数衡量两段文本的语义距离。

### 余弦相似度（推荐）

```
cosine_similarity(A, B) = (A · B) / (‖A‖ × ‖B‖)
```

- 值域：[-1, 1]，1 表示完全相同，0 表示无关，-1 表示语义相反
- **不受向量长度影响**，只关注方向，适合文本语义比较
- OpenAI 的 Embedding 已归一化，此时余弦相似度等价于点积

### 点积（Dot Product）

```
dot_product(A, B) = A · B = Σ(aᵢ × bᵢ)
```

- 同时受方向和模长影响；向量未归一化时结果不稳定
- 计算比余弦相似度稍快（省去除法），适合**已归一化**的向量

### 欧氏距离（L2 Distance）

```
euclidean(A, B) = √(Σ(aᵢ - bᵢ)²)
```

- 值域：[0, +∞)，0 表示完全相同，值越大越不相似
- 适合聚类算法（如 K-Means），不适合高维稀疏语义比较（受维度诅咒影响）

| 方法 | 适用场景 | 不适用场景 |
|------|----------|------------|
| 余弦相似度 | 语义搜索、RAG 检索（首选） | 需要考虑向量模长的场景 |
| 点积 | 归一化向量的快速比较 | 向量未归一化时 |
| 欧氏距离 | 聚类、K-NN 分类 | 高维语义向量直接比较 |

---

## 四、Spring AI 接入

Spring AI 通过 `EmbeddingModel` 接口统一抽象不同的 Embedding 提供商。

**依赖：**

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
</dependency>
```

**application.yaml 配置（OpenAI）：**

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
          # dimensions: 512  # text-embedding-3-x 支持缩减维度，节省存储
```

**代码示例：**

```java
@Service
@RequiredArgsConstructor
public class EmbeddingService {

    private final EmbeddingModel embeddingModel;

    // 单条文本嵌入（返回 float[]）
    public float[] embed(String text) {
        return embeddingModel.embed(text);
    }

    // 批量嵌入（推荐：减少 API 调用次数）
    public List<float[]> embedBatch(List<String> texts) {
        EmbeddingResponse response = embeddingModel.embedForResponse(texts);
        return response.getResults().stream()
            .map(result -> result.getOutput())
            .collect(Collectors.toList());
    }

    // 计算余弦相似度
    public double cosineSimilarity(float[] vec1, float[] vec2) {
        double dot = 0, norm1 = 0, norm2 = 0;
        for (int i = 0; i < vec1.length; i++) {
            dot   += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }
        return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }
}
```

**切换 Ollama 本地模型（零成本）：**

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      embedding:
        options:
          model: nomic-embed-text
```

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-ollama-spring-boot-starter</artifactId>
</dependency>
```

---

## 五、LangChain4j 接入

```java
// 使用 OpenAI Embedding
EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
    .apiKey(System.getenv("OPENAI_API_KEY"))
    .modelName("text-embedding-3-small")
    .build();

// 单条嵌入
Response<Embedding> response = embeddingModel.embed("Java 并发编程");
float[] vector = response.content().vector();
System.out.println("维度: " + vector.length);  // 1536

// 批量嵌入 TextSegment
List<TextSegment> segments = List.of(
    TextSegment.from("Spring Boot 自动配置原理"),
    TextSegment.from("Redis 缓存穿透解决方案"),
    TextSegment.from("Kafka 消息积压处理")
);
Response<List<Embedding>> batchResponse = embeddingModel.embedAll(segments);
```

**使用本地 ONNX 模型（无需 API Key）：**

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-all-minilm-l6-v2</artifactId>
    <version>0.35.0</version>
</dependency>
```

```java
EmbeddingModel localModel = new AllMiniLmL6V2EmbeddingModel();
// 完全本地运行，384 维，适合快速原型
```

---

## 六、实用技巧

**批量 Embedding 注意事项**

- 优先使用批量接口（`embedForResponse(List)`），比逐条调用减少 70%+ 的网络往返延迟。
- OpenAI API 单次批量上限为 2048 条，超过需分批提交。
- 高并发场景下设置合理的速率限制，避免触发 API 限流（429 错误）。

**向量归一化**

- OpenAI `text-embedding-3-x` 系列输出已归一化（L2 范数为 1），可直接用点积代替余弦相似度。
- 自部署的开源模型（如 BGE-M3）输出**未归一化**，建议在存入向量库前手动归一化：

```java
public float[] normalize(float[] vec) {
    double norm = 0;
    for (float v : vec) norm += v * v;
    norm = Math.sqrt(norm);
    float[] result = new float[vec.length];
    for (int i = 0; i < vec.length; i++) result[i] = (float)(vec[i] / norm);
    return result;
}
```

**维度对性能的影响**

| 维度 | 存储（百万向量） | 检索速度 | 精度 |
|------|-----------------|----------|------|
| 384 | ~1.5 GB | 最快 | 较低 |
| 768 | ~3 GB | 快 | 中等 |
| 1536 | ~6 GB | 中等 | 高 |
| 3072 | ~12 GB | 较慢 | 最高 |

`text-embedding-3-small/large` 支持**维度缩减**（Matryoshka 表示法），可在 API 请求中指定 `dimensions` 参数（如 256、512）以节省存储和加快检索，同时保持较好精度。

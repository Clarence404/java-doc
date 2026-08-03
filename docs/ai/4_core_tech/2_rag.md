# RAG 检索增强生成

> 参考资料：
> * RAG 概念：[https://www.pinecone.io/learn/retrieval-augmented-generation/](https://www.pinecone.io/learn/retrieval-augmented-generation/)
> * LangChain RAG：[https://python.langchain.com/docs/tutorials/rag/](https://python.langchain.com/docs/tutorials/rag/)
> * Spring AI RAG：[https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html](https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html)

---

## 一、是什么

**RAG（Retrieval-Augmented Generation，检索增强生成）** 是一种将外部知识检索与大语言模型生成相结合的架构模式，用于解决两个核心痛点：

- **幻觉问题**：LLM 倾向于生成看似合理但实际错误的内容；引入检索到的真实文档作为上下文，可大幅降低幻觉率。
- **知识截止问题**：LLM 训练数据有截止日期，无法感知最新信息；RAG 可实时注入最新文档、内部知识库、私有数据。

核心思路：**先检索，再生成**——用户问题先通过语义检索找到最相关的文档片段，将这些片段拼入 Prompt 作为上下文，最后由 LLM 基于该上下文生成回答。

### RAG vs 微调（Fine-tuning）对比

| 维度 | RAG | 微调 |
|------|-----|------|
| 知识更新 | 实时更新，修改文档即生效 | 需要重新训练，周期长 |
| 成本 | 低（无需 GPU 训练） | 高（需要 GPU 和标注数据） |
| 可解释性 | 高（可追溯来源文档） | 低（知识内化在参数中） |
| 适用场景 | 知识库问答、文档检索、动态数据 | 风格迁移、特定领域术语、行为对齐 |
| 幻觉风险 | 较低（有事实锚点） | 较高（依赖训练数据质量） |

---

## 二、完整流程

RAG 分为两个阶段：**索引阶段**（离线构建）和**查询阶段**（在线推理）。

**索引阶段**（预处理，通常一次性或增量执行）：

1. **文档加载**：从 PDF、Word、网页、数据库等数据源读取原始文档。
2. **文档切块（Chunking）**：将长文档拆分为语义连贯的小片段（Chunk），避免超出模型上下文窗口。
3. **向量化（Embedding）**：用嵌入模型将每个 Chunk 转换为高维向量。
4. **存入向量库**：将向量和原始文本元数据一起存入向量数据库（如 Qdrant、pgvector）。

**查询阶段**（每次用户提问时执行）：

1. **问题向量化**：用相同的嵌入模型将用户问题转换为向量。
2. **相似性检索**：在向量库中执行 ANN（近似最近邻）搜索，找到与问题语义最相近的 Top-K 个 Chunk。
3. **拼入 Prompt**：将检索到的 Chunk 内容拼接到 Prompt 模板中，作为 LLM 的上下文。
4. **LLM 生成**：LLM 基于注入的上下文生成回答，而非依赖参数中的记忆。

---

## 三、文档切块策略

切块质量直接影响检索效果。Chunk 太大会引入噪声，太小则可能缺失上下文。

| 策略 | 描述 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|----------|
| **固定大小切块** | 按字符/Token 数强制截断 | 实现简单，性能可预测 | 可能截断句子，语义不完整 | 结构化程度低的纯文本 |
| **按句子切块** | 以句号、问号等标点为边界 | 语义完整性好 | Chunk 大小不均，可能过碎 | 叙述类文章 |
| **递归字符切块** | 按段落→句子→字符递进尝试切分，保持语义完整 | 最常用，平衡效果与实现复杂度 | 需调参 | **通用推荐** |
| **按标题/结构切块** | 基于 Markdown/HTML 标题层级切分 | 保留文档结构语义 | 依赖文档有清晰结构 | 技术文档、Wiki |

**推荐默认参数**：`chunk_size=512 tokens`，`chunk_overlap=64 tokens`。overlap 确保跨 Chunk 边界的语义不丢失。

---

## 四、Spring AI 实战

Spring AI 的 RAG 流程以 `DocumentReader → TextSplitter → EmbeddingModel → VectorStore → Advisor` 为主线。

**依赖（pom.xml）：**

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-pdf-document-reader</artifactId>
</dependency>
<!-- 以 pgvector 为例 -->
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-pgvector-store-spring-boot-starter</artifactId>
</dependency>
```

**索引阶段：加载、切块、向量化并存储**

```java
@Service
@RequiredArgsConstructor
public class DocumentIngestionService {

    private final VectorStore vectorStore;

    public void ingestPdf(Resource pdfResource) {
        // 1. 加载 PDF
        DocumentReader reader = new PagePdfDocumentReader(pdfResource,
            PdfDocumentReaderConfig.builder()
                .withPagesPerDocument(1)  // 每页作为一个文档
                .build());
        List<Document> documents = reader.get();

        // 2. 切块
        TextSplitter splitter = new TokenTextSplitter(512, 64, 5, 10000, true);
        List<Document> chunks = splitter.apply(documents);

        // 3. 向量化并存入向量库（EmbeddingModel 自动调用）
        vectorStore.add(chunks);
    }

    public void ingestText(String text, Map<String, Object> metadata) {
        Document doc = new Document(text, metadata);
        TextSplitter splitter = new TokenTextSplitter();
        vectorStore.add(splitter.apply(List.of(doc)));
    }
}
```

**查询阶段：使用 QuestionAnswerAdvisor**

```java
@Service
@RequiredArgsConstructor
public class RagChatService {

    private final ChatClient.Builder chatClientBuilder;
    private final VectorStore vectorStore;

    public String chat(String userMessage) {
        ChatClient chatClient = chatClientBuilder
            .defaultAdvisors(
                new QuestionAnswerAdvisor(
                    vectorStore,
                    SearchRequest.defaults()
                        .withTopK(5)                    // 检索 Top-5 片段
                        .withSimilarityThreshold(0.7)   // 相似度阈值
                )
            )
            .build();

        return chatClient.prompt()
            .user(userMessage)
            .call()
            .content();
    }
}
```

**application.yaml 配置：**

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: COSINE_DISTANCE
        dimensions: 1536
```

---

## 五、LangChain4j 实战

LangChain4j 通过 `EmbeddingStoreIngestor` 完成索引，通过 `AiServices` + `ContentRetriever` 完成检索增强对话。

**依赖：**

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-spring-boot-starter</artifactId>
    <version>0.35.0</version>
</dependency>
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-all-minilm-l6-v2</artifactId>
    <version>0.35.0</version>
</dependency>
```

**索引阶段：**

```java
@Bean
public EmbeddingStore<TextSegment> embeddingStore() {
    // 使用内存存储（生产环境替换为 Qdrant/pgvector）
    return new InMemoryEmbeddingStore<>();
}

@Service
@RequiredArgsConstructor
public class KnowledgeBaseService {

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> embeddingStore;

    public void ingest(String documentText) {
        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
            .documentSplitter(
                DocumentSplitters.recursive(512, 64)  // chunkSize=512, overlap=64
            )
            .embeddingModel(embeddingModel)
            .embeddingStore(embeddingStore)
            .build();

        ingestor.ingest(Document.from(documentText));
    }
}
```

**查询阶段：AiServices + ContentRetriever**

```java
// 定义 AI 服务接口
public interface KnowledgeAssistant {
    String answer(String question);
}

@Configuration
@RequiredArgsConstructor
public class AiConfig {

    private final ChatModel chatModel;
    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> embeddingStore;

    @Bean
    public KnowledgeAssistant knowledgeAssistant() {
        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
            .embeddingStore(embeddingStore)
            .embeddingModel(embeddingModel)
            .maxResults(5)
            .minScore(0.7)
            .build();

        return AiServices.builder(KnowledgeAssistant.class)
            .chatModel(chatModel)
            .contentRetriever(retriever)
            .build();
    }
}
```

---

## 六、RAG 优化方向

基础 RAG 在复杂查询下效果有限，以下是常见的进阶优化手段：

| 优化方向 | 核心思路 | 适用场景 |
|----------|----------|----------|
| **Reranking（重排序）** | 初检索得到 Top-20，再用交叉编码器（Cross-Encoder）精排，最终取 Top-5 送入 LLM；交叉编码器同时编码查询和文档，精度远高于向量相似度 | 对准确度要求高的问答 |
| **HyDE（假设性文档嵌入）** | 先让 LLM 根据问题生成一段假设性答案，用该假设答案的向量去检索，比原始问题向量更接近真实文档的分布 | 问题与文档表述风格差异大时 |
| **查询扩展** | 将一个问题改写为多个角度不同的子问题，分别检索再合并结果，提高召回率 | 复杂多跳推理问题 |
| **Contextual Compression** | 检索后对文档片段再压缩，只保留与问题相关的句子，减少噪声输入 LLM | 文档片段内容混杂时 |
| **元数据过滤** | 在向量检索前先用元数据（时间、类别、作者）过滤候选集，缩小检索范围 | 有明确属性的结构化知识库 |

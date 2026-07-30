# 向量数据库

> 参考资料：
> * Milvus：[https://milvus.io/docs](https://milvus.io/docs)
> * Weaviate：[https://weaviate.io/developers/weaviate](https://weaviate.io/developers/weaviate)
> * pgvector：[https://github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)
> * Chroma：[https://docs.trychroma.com/](https://docs.trychroma.com/)
> * Qdrant：[https://qdrant.tech/documentation/](https://qdrant.tech/documentation/)

---

## 一、是什么

向量数据库是专门为**高维向量的相似性检索**设计的存储系统。

传统关系型数据库（MySQL、PostgreSQL）基于精确匹配和范围查询，对 `WHERE age > 30` 这类条件很高效，但面对"找出语义最接近这段文字的 Top-5 记录"时极为低效——暴力计算百万条向量的余弦相似度是 O(n) 的，延迟无法接受。

向量数据库的核心能力：

- **ANN 检索（近似最近邻）**：使用 HNSW、IVF 等索引结构，在亚线性时间内找到最相似的向量，查询延迟通常在 10ms 以内。
- **元数据过滤**：支持在向量检索时附加结构化条件（如 `category = 'finance' AND date > '2024-01-01'`），兼顾精确过滤和语义检索。
- **向量 CRUD**：支持向量的增删改查及版本管理。

**典型使用场景**：RAG 知识库、图片/视频相似搜索、推荐系统、基因序列比对。

---

## 二、主流选型对比

| 数据库 | 类型 | 部署方式 | 核心特点 | 适用场景 |
|--------|------|----------|----------|----------|
| **Milvus** | 专用向量库 | 自托管（分布式/单机） | 云原生架构，支持水平扩展，PB 级数据 | 超大规模生产环境 |
| **Qdrant** | 专用向量库 | 自托管 / 托管云 | Rust 实现，性能高，API 设计优雅，支持丰富过滤 | 中大型生产，首选专用库 |
| **Weaviate** | 专用向量库 | 自托管 / 托管云 | 自带模块化向量化，GraphQL API，支持混合搜索 | 需要内置向量化的场景 |
| **Pinecone** | 专用向量库 | 全托管 SaaS | 零运维，开箱即用，按量付费 | 快速上线，不想维护基础设施 |
| **pgvector** | PostgreSQL 扩展 | 依托现有 PG 实例 | 无需额外组件，SQL 原生操作，事务支持 | 已有 PG、规模较小的项目 |
| **Redis Vector** | Redis 模块（RediSearch） | 自托管 / Redis Cloud | 内存级速度，与现有 Redis 缓存共存 | 对延迟极敏感的实时场景 |
| **Chroma** | 专用向量库 | 内嵌 / 自托管 | Python 优先，轻量，开发调试友好 | 原型验证、Python 项目、本地测试 |

---

## 三、pgvector（PostgreSQL 扩展）

pgvector 是成本最低的方案——如果项目已经使用 PostgreSQL，只需安装一个扩展，无需引入新的基础设施组件。

**安装与建表：**

```sql
-- 安装扩展（需要 PostgreSQL 12+，pgvector 0.5+）
CREATE EXTENSION IF NOT EXISTS vector;

-- 建表：存储文档片段及其向量
CREATE TABLE document_chunk (
    id          BIGSERIAL PRIMARY KEY,
    content     TEXT         NOT NULL,
    metadata    JSONB,
    embedding   VECTOR(1536) NOT NULL,   -- 维度需与 Embedding 模型匹配
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- 创建 HNSW 索引（推荐，查询更快）
CREATE INDEX ON document_chunk
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 或创建 IVFFlat 索引（内存占用更小）
-- CREATE INDEX ON document_chunk
--     USING ivfflat (embedding vector_cosine_ops)
--     WITH (lists = 100);
```

**相似性查询：**

```sql
-- 查找与目标向量最相似的 5 条记录（余弦距离 <=>，值越小越相似）
SELECT id, content, metadata,
       1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS similarity
FROM document_chunk
WHERE metadata->>'category' = 'java'          -- 元数据过滤
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;

-- 操作符说明：
-- <=>  余弦距离（1 - 余弦相似度），最常用
-- <->  欧氏距离（L2）
-- <#>  负内积（用于归一化向量的点积相似度）
```

**Spring AI 配置（pgvector）：**

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: ${DB_USER}
    password: ${DB_PASSWORD}
  ai:
    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: COSINE_DISTANCE
        dimensions: 1536
        initialize-schema: true   # 自动建表，生产环境建议改为 false 手动管理
```

```java
@Service
@RequiredArgsConstructor
public class PgVectorExample {

    private final VectorStore vectorStore;

    public void store(List<Document> docs) {
        vectorStore.add(docs);
    }

    public List<Document> search(String query, int topK) {
        return vectorStore.similaritySearch(
            SearchRequest.query(query)
                .withTopK(topK)
                .withSimilarityThreshold(0.75)
                .withFilterExpression("category == 'java'")  // 元数据过滤
        );
    }
}
```

---

## 四、Qdrant 接入（Spring AI）

Qdrant 是当前性能和易用性最均衡的专用向量数据库，推荐作为生产环境首选。

**Docker Compose 快速启动：**

```yaml
# docker-compose.yml
version: '3.8'
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"   # REST API
      - "6334:6334"   # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-}  # 可选，本地开发留空

volumes:
  qdrant_data:
```

启动：`docker compose up -d`，访问 `http://localhost:6333/dashboard` 查看控制台。

**依赖：**

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-qdrant-store-spring-boot-starter</artifactId>
</dependency>
```

**application.yaml 配置：**

```yaml
spring:
  ai:
    vectorstore:
      qdrant:
        host: localhost
        port: 6334             # gRPC 端口
        api-key: ${QDRANT_API_KEY:}
        collection-name: knowledge_base
        use-tls: false
        initialize-schema: true  # 自动创建 collection
```

**存取示例：**

```java
@Service
@RequiredArgsConstructor
public class QdrantExample {

    private final VectorStore vectorStore;  // 自动注入 QdrantVectorStore

    // 存储文档（自动调用 EmbeddingModel 向量化）
    public void store(String text, Map<String, Object> metadata) {
        Document doc = new Document(text, metadata);
        vectorStore.add(List.of(doc));
    }

    // 语义检索
    public List<Document> retrieve(String question) {
        return vectorStore.similaritySearch(
            SearchRequest.query(question)
                .withTopK(5)
                .withSimilarityThreshold(0.7)
        );
    }

    // 带元数据过滤的检索
    public List<Document> retrieveWithFilter(String question, String category) {
        return vectorStore.similaritySearch(
            SearchRequest.query(question)
                .withTopK(5)
                .withFilterExpression("category == '" + category + "'")
        );
    }
}
```

---

## 五、选型建议

| 规模 / 场景 | 推荐方案 | 理由 |
|-------------|----------|------|
| **小项目 / 已有 PostgreSQL** | **pgvector** | 零新增基础设施，SQL 操作熟悉，百万级数据完全够用 |
| **中型生产环境（百万～千万向量）** | **Qdrant** | 性能优秀，API 友好，Docker 易部署，Spring AI 原生支持 |
| **大型生产环境（亿级向量）** | **Milvus** | 云原生分布式，支持水平扩展，完整的企业级特性 |
| **快速原型 / Python 项目** | **Chroma** | 内嵌模式无需部署，2 行代码启动 |
| **不想维护基础设施** | **Pinecone** | 全托管 SaaS，专注业务逻辑 |
| **延迟极敏感（< 1ms）** | **Redis Vector** | 内存存储，复用现有 Redis，但成本较高 |
| **需要内置向量化 + GraphQL** | **Weaviate** | 模块化 vectorizer，适合 schema-driven 场景 |

**决策流程**：

1. 项目已有 PG 且向量数 < 500 万 → **pgvector**，最省事
2. 需要专用向量库且自托管 → **Qdrant**，首选
3. 数据量超过亿级或需要多副本分片 → **Milvus**
4. 不想运维 → **Pinecone**

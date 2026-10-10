---
description: HNSW / IVF / 量化、过滤检索、pgvector、向量库选型、Spring AI VectorStore
---

# 向量数据库

> 前置阅读：[Embedding 向量化](./0_embedding)

向量数据库用 ANN 索引在海量向量中快速找出最相近的结果，本篇是站内向量检索原理的主文档。内容覆盖 HNSW / IVF / 量化的取舍、pgvector 建表索引与过滤查询、主流向量库选型和 Spring AI 2.0 `VectorStore` 存取，代码基线为 JDK 21 / Spring Boot 4 / Spring AI 2.0.1。

---

## 一、为什么需要向量数据库

关系型数据库擅长精确匹配和范围查询（`WHERE age > 30`），却回答不了「和这段话意思最接近的 5 条记录是哪些」。暴力做法是把查询向量和库里每一条都算一遍距离，复杂度 O(n × d)：百万条 1536 维向量，每次查询要做十几亿次乘加，延迟和 CPU 都扛不住。

向量数据库（或带向量能力的数据库）提供三样东西：

- **ANN 检索（近似最近邻）**：用 HNSW、IVF 等索引把查询变成亚线性复杂度，代价是结果不保证 100% 精确，用召回率衡量
- **元数据过滤**：检索时附加结构化条件，如 `tenant = 'a' AND category = 'java'`，这是做多租户隔离和权限控制的基础
- **向量的增删改与持久化**：支持增量写入、按条件删除、备份与扩容

查询延迟取决于数据规模、索引参数、召回率要求和是否带过滤，没有放之四海皆准的数字，以自己的数据压测为准。

---

## 二、ANN 索引原理

### 1、HNSW：分层图

HNSW（Hierarchical Navigable Small World）把向量组织成多层图：最上层节点少、边长，用来快速跳到目标区域；越往下节点越多、边越短，最底层包含所有向量。查询从顶层入口出发，每层贪心地走向更近的邻居，再下沉一层继续，直到最底层取出 Top-K。

- **建索引参数**：`m`（每个节点的邻居数）越大，图越稠密，召回越高，内存越大；`ef_construction` 越大，建图越慢、质量越好
- **查询参数**：`ef_search`（候选队列长度）越大，召回越高、延迟越高，可以按请求动态调整
- **特点**：召回率和延迟都很好，支持边写边查，代价是内存占用大、建索引慢，是目前多数场景的默认选择

### 2、IVF：先聚类再查

IVF（Inverted File）先用 K-Means 把向量分成 `lists` 个簇，查询时只在离查询向量最近的 `probes` 个簇里暴力比较。

- 建索引快、内存小，但需要先有足够数据才能训练出好的聚类中心，数据分布大幅变化后要重建
- `probes` 越大召回越高、越慢；`probes = lists` 时退化为全量扫描

### 3、量化：用精度换内存

量化把每个 float32 维度压成更少的比特，向量越多越值得做：

- **标量量化（SQ / int8）**：每维 4 字节压成 1 字节，内存约为原来的 1/4，召回损失通常较小
- **乘积量化（PQ）**：把向量切成若干段，每段用码本中最近的中心编号表示，压缩比更高，召回损失也更大
- **二值量化（BQ）**：每维只留 1 比特，配合原始向量重排（rescore）使用

常见做法是「量化索引粗筛 + 原始向量精排」，在内存与召回之间取平衡。

### 4、怎么取舍

| 方案 | 召回率 | 查询延迟 | 内存 | 建索引 | 适用 |
|------|--------|----------|------|--------|------|
| 暴力扫描（无索引） | 100% | 随数据线性增长 | 原始大小 | 无 | 数万条以内、离线评估的基准 |
| HNSW | 高 | 低 | 大（原始 + 图） | 慢 | 默认选择，内存够用时 |
| IVF | 中高 | 中 | 小 | 快 | 数据量大、内存紧张、可接受定期重建 |
| HNSW / IVF + 量化 | 略降 | 低 | 很小 | 中 | 亿级数据，配合重排 |

### 5、过滤检索的陷阱

带 `WHERE` 条件的 ANN 查询有两种执行方式：先按向量取 Top-K 再过滤（后过滤），或先过滤再在子集上检索（前过滤）。后过滤在条件很严格时会「过滤过头」：索引只返回了 40 个候选，过滤后剩 2 个，结果不满 `LIMIT`。Qdrant、Milvus 等专用库在索引内部做过滤；pgvector 0.8 起提供迭代扫描来缓解，见下一节。

---

## 三、pgvector

如果项目已经在用 PostgreSQL，pgvector 是成本最低的方案：装一个扩展，向量与业务数据同库同事务，用 SQL 即可查询。当前版本线为 0.8.x，支持 PostgreSQL 13 及以上，建议使用最新补丁版本（0.8.2 修复了并行构建 HNSW 索引时的溢出问题）。

### 1、建表与索引

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunk (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   VARCHAR(64)  NOT NULL,
    content     TEXT         NOT NULL,
    metadata    JSONB,
    embedding   VECTOR(1024) NOT NULL,   -- 维度必须与 Embedding 模型一致
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- HNSW 索引：操作符类要与查询用的距离一致（这里是余弦）
CREATE INDEX ON document_chunk
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 过滤字段建普通索引
CREATE INDEX ON document_chunk (tenant_id);
```

HNSW 索引对 `vector` 类型最多支持 2000 维。3072 维的模型要么用 `dimensions` 缩短，要么改用半精度类型 `halfvec`（最多 4000 维，存储减半）：

```sql
CREATE INDEX ON document_chunk
    USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
-- 查询时同样转换：ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072)
```

### 2、距离操作符

| 操作符 | 含义 | 对应操作符类 |
|--------|------|--------------|
| `<=>` | 余弦距离（1 − 余弦相似度），最常用 | `vector_cosine_ops` |
| `<->` | 欧氏距离（L2） | `vector_l2_ops` |
| `<#>` | 负内积，用于归一化向量 | `vector_ip_ops` |
| `<+>` | L1 距离 | `vector_l1_ops` |

### 3、过滤查询与迭代扫描

```sql
-- 召回率不够时调大候选队列（默认 40）
SET hnsw.ef_search = 100;

-- 0.8 起：过滤后结果不足时继续扫描索引，避免过滤过头
SET hnsw.iterative_scan = relaxed_order;

SELECT id, content, 1 - (embedding <=> $1) AS similarity
FROM document_chunk
WHERE tenant_id = $2
ORDER BY embedding <=> $1
LIMIT 5;
```

`relaxed_order` 允许结果顺序略有偏差以换取性能，需要严格顺序时用 `strict_order`。查询向量用 JDBC 参数绑定传入，不要拼接到 SQL 字符串里。

---

## 四、其他主流方案

| 方案 | 类型 | 核心特点 | 适用场景 |
|------|------|----------|----------|
| **pgvector** | PostgreSQL 扩展 | 与业务数据同库、支持事务与 SQL 过滤 | 已有 PG，千万级以内 |
| **Milvus** | 专用向量库（分布式） | 存算分离、水平扩展，支持多种索引与量化；2.5 起内置 BM25 全文检索，可与稠密向量做混合检索；2026 年发布 3.0 | 亿级以上、需要独立扩容 |
| **Qdrant** | 专用向量库（Rust） | 索引内过滤、payload 索引、量化，单机易部署，也支持集群 | 中大型生产的专用库首选之一 |
| **Redis** | 内存数据库 | Redis 8 开源版内置查询引擎（向量索引 + 过滤）；另有原生 Vector Set 类型（`VADD` / `VSIM`，HNSW，默认 int8 量化） | 已有 Redis、数据量能放进内存、低延迟 |
| **Elasticsearch / OpenSearch** | 搜索引擎 | `dense_vector` kNN 与 BM25 在同一个引擎里，RRF 做混合排序 | 已有 ES，需要关键词 + 语义混合检索 |
| **Pinecone 等托管服务** | SaaS | 免运维，按量计费 | 不想维护基础设施、数据可出网 |

几点补充：

- Redis 的 Vector Set 是 Redis 8 新增的数据类型，Valkey 等分支没有；用法与缓存场景见 [缓存总览](/cache/0_overview)
- Elasticsearch 的倒排索引与分词原理见 [搜索数据库](/database/4_nosql/3_search_db)，混合检索在 RAG 中的用法见 [RAG 检索增强生成](./2_rag)
- Chroma 这类以 Python 为主的轻量库适合原型验证，Java 生产项目一般不选

### 1、选型建议

| 场景 | 推荐 | 理由 |
|------|------|------|
| 已有 PostgreSQL，向量在千万级以内 | pgvector | 零新增组件，向量和业务数据一起做事务与权限过滤 |
| 需要独立的专用库，单机或小集群 | Qdrant | 部署简单，过滤能力强，Spring AI 原生支持 |
| 亿级以上、需要分片与存算分离 | Milvus | 云原生分布式架构，索引与量化选项最全 |
| 已有 Elasticsearch，重视关键词召回 | Elasticsearch | 一个引擎同时做 BM25 与向量，混合检索最省事 |
| 已有 Redis，数据量能常驻内存 | Redis | 复用现有集群，延迟低，但内存成本高 |
| 不想运维 | 托管服务 | 按量付费，注意数据出网合规 |

原则与数据库选型一致：**先看手里有什么，能复用就不引入新组件**。

---

## 五、Spring AI VectorStore

Spring AI 用 `VectorStore` 接口屏蔽了各家差异：`add` 写入时自动调用 `EmbeddingModel` 向量化，`similaritySearch` 查询，`delete` 支持按 ID 或过滤表达式删除。

### 1、依赖与配置

| 向量库 | Starter |
|--------|---------|
| pgvector | `spring-ai-starter-vector-store-pgvector` |
| Qdrant | `spring-ai-starter-vector-store-qdrant` |
| Milvus | `spring-ai-starter-vector-store-milvus` |
| Redis | `spring-ai-starter-vector-store-redis` |
| Elasticsearch | `spring-ai-starter-vector-store-elasticsearch` |

pgvector 配置示例（数据源沿用 `spring.datasource`）：

```yaml
spring:
  ai:
    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: COSINE_DISTANCE
        dimensions: 1024
        initialize-schema: false   # 默认 false；生产用 Flyway 管理表结构，开发环境可设 true
```

Qdrant 配置示例（端口是 gRPC 的 6334）：

```yaml
spring:
  ai:
    vectorstore:
      qdrant:
        host: localhost
        port: 6334
        api-key: ${QDRANT_API_KEY:}
        collection-name: knowledge_base
        initialize-schema: true
```

本地启动 Qdrant 时固定镜像版本，不要用 `latest`：

```yaml
# compose.yaml
services:
  qdrant:
    image: qdrant/qdrant:v1.19.2
    ports:
      - "6333:6333"   # REST 与控制台
      - "6334:6334"   # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY}

volumes:
  qdrant_data:
```

### 2、存取与过滤

过滤条件用 `FilterExpressionBuilder` 构造，不要把用户输入拼进过滤字符串，否则会出现与 SQL 注入同类的「过滤表达式注入」，例如传入 `java' || tenant == 'other` 就能越权读到别的租户的数据。

```java
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.Filter;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;

@Service
public class KnowledgeStore {

    private final VectorStore vectorStore;

    public KnowledgeStore(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public void save(String text, String tenantId, String category) {
        vectorStore.add(List.of(new Document(text,
                Map.of("tenant", tenantId, "category", category))));
    }

    public List<Document> search(String question, String tenantId, String category) {
        FilterExpressionBuilder b = new FilterExpressionBuilder();
        Filter.Expression filter = b.and(
                b.eq("tenant", tenantId),
                b.eq("category", category)).build();

        return vectorStore.similaritySearch(SearchRequest.builder()
                .query(question)
                .topK(5)
                .similarityThreshold(0.7)
                .filterExpression(filter)
                .build());
    }

    public void deleteTenant(String tenantId) {
        vectorStore.delete(new FilterExpressionBuilder().eq("tenant", tenantId).build());
    }
}
```

`tenantId` 必须来自服务端的登录态，而不是请求参数。`similarityThreshold` 的合适取值与模型和数据有关，0.7 只是起点，用评估集调参。Spring AI 1.0 之前的 `SearchRequest.query(q).withTopK(...)` 写法已删除，旧代码升级时要改成 builder。

---

## 小结

- 向量库的核心是 ANN 索引：HNSW 召回高、延迟低但吃内存，IVF 省内存但要训练与重建，量化用少量召回换大量内存
- 带过滤的 ANN 查询要警惕结果不足，pgvector 0.8 用 `hnsw.iterative_scan` 缓解，专用库在索引内过滤
- pgvector 的 HNSW 对 `vector` 最多 2000 维，更高维度用 `halfvec` 或缩短维度；操作符类必须与查询距离一致
- 选型先看现有组件：PG 用 pgvector，ES 用 ES，Redis 用 Redis；独立部署选 Qdrant，亿级以上选 Milvus
- Spring AI 2.0 用 `spring-ai-starter-vector-store-*` 与 `SearchRequest.builder()`，过滤条件用 `FilterExpressionBuilder` 构造，租户条件来自服务端

数据库层面的全量选型对比见 [数据库选型参考](/database/6_reference/1_selection_guide)，全文检索引擎本身见 [搜索数据库](/database/4_nosql/3_search_db)。

## 参考资料

- HNSW 论文：[https://arxiv.org/abs/1603.09320](https://arxiv.org/abs/1603.09320)
- pgvector：[https://github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)
- Milvus 文档：[https://milvus.io/docs](https://milvus.io/docs)
- Qdrant 文档：[https://qdrant.tech/documentation/](https://qdrant.tech/documentation/)
- Redis Vector Sets：[https://redis.io/docs/latest/develop/data-types/vector-sets/](https://redis.io/docs/latest/develop/data-types/vector-sets/)
- Elasticsearch kNN 检索：[https://www.elastic.co/docs/solutions/search/vector/knn](https://www.elastic.co/docs/solutions/search/vector/knn)
- Spring AI Vector Databases：[https://docs.spring.io/spring-ai/reference/api/vectordbs.html](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)
- Spring AI PGvector：[https://docs.spring.io/spring-ai/reference/api/vectordbs/pgvector.html](https://docs.spring.io/spring-ai/reference/api/vectordbs/pgvector.html)

> 下一篇：[RAG 检索增强生成](./2_rag)

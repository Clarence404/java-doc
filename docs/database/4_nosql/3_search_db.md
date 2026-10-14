---
description: 搜索库定位、ES / OpenSearch / Solr / Meilisearch / 库内全文检索、向量检索、选型
---

# 搜索数据库

> 前置阅读：[MySQL 索引](../1_mysql/4_topic_index)、[文档数据库](./2_document_db)

搜索数据库按关键词、相关性和过滤条件快速查找，通常是由业务库同步出来的查询侧索引，而不是主库。本篇讲搜索库的定位、各引擎速览、向量检索与选型，基线为 Elasticsearch 9 / OpenSearch 3。

---

## 一、典型场景与定位

索引数据通常由业务库经 CDC、消息队列或同步任务写入，同步方案见 [Elasticsearch 实战](./3_search_es_practice#五、与-mysql-同步)。

| 场景 | 需求特点 | 常见方案 |
|------|----------|----------|
| 站内搜索 | 关键词、分词、高亮、排序、筛选 | Elasticsearch / OpenSearch / Solr |
| 日志检索 | 高写入、按时间查询、聚合分析 | Elasticsearch / OpenSearch |
| 商品检索 | 过滤条件多、排序维度多、召回与精排分离 | Elasticsearch / OpenSearch |
| 语义检索 / RAG | 向量召回 + 关键词召回混合排序 | Elasticsearch / OpenSearch / 向量数据库 |
| 轻量应用搜索 | 部署简单、数据量中小、功能聚焦 | Meilisearch / Typesense |
| 后台简单检索 | 数据量小、只求「能搜到」 | 数据库内置全文检索 |

与关系型数据库的分工：

| 对比项 | 关系型数据库 | 搜索数据库 |
|--------|--------------|------------|
| 核心目标 | 事务一致性、结构化查询 | 文本检索、相关性排序、聚合分析 |
| 查询方式 | SQL、B+ 树索引、JOIN | 倒排索引、DSL、相关性评分 |
| 数据模型 | 表、行、列、约束 | 文档、字段、Mapping |
| 一致性 | 强一致 | 近实时（默认 1 秒可见），与主库最终一致 |
| 适合角色 | 主数据源 | 查询加速与搜索视图 |

---

## 二、各引擎速览

### 1、Elasticsearch

基于 Lucene 的分布式搜索与分析引擎，当前主线为 9.x（2025 年 4 月 GA，基于 Lucene 10），8.0 起默认开启安全认证（TLS + 用户名密码）。功能最全、生态最成熟，覆盖站内搜索、日志分析（ELK）和向量检索。

- 倒排索引与分词、写入与近实时、查询两阶段、集群选主等机制见 [Elasticsearch 原理](./3_search_es)
- Mapping 设计、深分页、别名与 ILM、同步、调优与故障排查见 [Elasticsearch 实战](./3_search_es_practice)

### 2、OpenSearch

2021 年从 Elasticsearch 7.10.2 分叉，2024 年 9 月起由 Linux 基金会下的 OpenSearch 软件基金会管理，当前主线为 3.x（2025 年发布，基于 Lucene 10），Apache 2.0 许可。

- 底层同为 Lucene，倒排索引、段、近实时等原理与 ES 一致
- 与 ES 7.10 之后的 API 已经分化，ES 8 / 9 的客户端不能直接连接 OpenSearch，反之亦然
- 索引生命周期用 ISM（Index State Management），不是 ES 的 ILM；向量检索通过 k-NN 插件和 Neural Search 提供
- Amazon OpenSearch Service 是主要的托管形态

### 3、Apache Solr

同样基于 Lucene，历史比 ES 更早，当前主线为 9.x。集群模式（SolrCloud）依赖 ZooKeeper 做协调，配置以 schema 文件为中心，上手门槛比 ES 高。9.0 起支持 `DenseVectorField` 与 KNN 查询。新项目较少选择，主要存在于已有技术栈中。

### 4、Meilisearch / Typesense

面向应用内搜索的轻量引擎：开箱即用的拼写容错、前缀即时搜索、分面筛选，配置项少、单二进制部署。适合数据量中小（百万到千万级文档）、团队不想维护 ES 集群的场景；不适合日志分析、复杂聚合或超大规模数据。两者也都提供向量与混合检索。

### 5、数据库内置全文检索

数据已经在关系库里、规模不大时，可以先不引入搜索引擎：

| 数据库 | 能力 | 中文 |
|--------|------|------|
| MySQL | InnoDB `FULLTEXT` 索引 + `MATCH ... AGAINST`，支持自然语言与布尔模式 | 内置 ngram 解析器按固定长度切词，没有词典 |
| PostgreSQL | `tsvector` / `tsquery` + GIN 索引，支持权重与排序函数 | 需要 zhparser、pg_jieba 等扩展 |
| MongoDB | 传统 `$text` 索引；Atlas Search 基于 Lucene | `$text` 不支持中文分词 |

共同的短板是相关性难调、分面聚合要多次查询、与业务库争资源。MySQL 与 ES 的逐项对比见 [搜索](/scenario/9_search_system#_1、mysql-全文检索够不够)，PG 全文检索的用法见 [PostgreSQL 高级 SQL](../2_postgresql/4_topic_advanced_sql)，MongoDB 的检索能力见 [文档数据库](./2_document_db)。

---

## 三、向量与混合检索

主流搜索引擎都已内置向量检索，可以在一个引擎里同时做关键词召回和语义召回：

- **`dense_vector` + kNN**：ES 基于 HNSW 的近似最近邻检索，可与 `bool` 过滤组合
- **量化**：`int8` / `int4` 量化以及 8.16 引入的 BBQ（Better Binary Quantization），大幅降低向量内存占用
- **`semantic_text`**：写入时自动调用推理端点生成向量，查询时直接 `semantic` 查询，省去手动管理 embedding
- **混合检索**：用 RRF（Reciprocal Rank Fusion）把 BM25 关键词结果与向量结果按排名融合

```http
GET /docs/_search
{
  "retriever": {
    "rrf": {
      "retrievers": [
        { "standard": { "query": { "match": { "content": "分布式事务" } } } },
        { "knn": { "field": "content_vector", "query_vector": [0.12, -0.08, 0.33], "k": 10, "num_candidates": 100 } }
      ]
    }
  }
}
```

OpenSearch 通过 k-NN 插件和 Neural Search 提供类似能力，Solr 9 起支持 KNN 查询。HNSW 与量化原理、与 pgvector / Milvus / Qdrant 等专用向量库的对比见 [向量数据库](/ai/4_core_tech/1_vector_db)，RAG 中的混合检索见 [RAG 检索增强生成](/ai/4_core_tech/2_rag)。

---

## 四、选型对比

| 维度 | Elasticsearch | OpenSearch | Apache Solr | Meilisearch / Typesense |
|------|---------------|------------|-------------|-------------------------|
| 当前主线 | 9.x | 3.x | 9.x | Meilisearch 1.x / Typesense |
| 开源协议 | AGPLv3 / SSPL / Elastic License 2.0 三选一（AGPL 自 8.16 起提供） | Apache 2.0 | Apache 2.0 | MIT（Meilisearch 社区版）/ GPLv3（Typesense） |
| 治理 | Elastic 公司 | OpenSearch 软件基金会（Linux 基金会） | Apache 软件基金会 | 各自公司 |
| 上手难度 | 中 | 中 | 较高 | 低 |
| 向量检索 | 支持 | 支持 | 9.0 起支持 | 支持 |
| 云托管 | Elastic Cloud、各云厂商 | Amazon OpenSearch Service 等 | 自建为主 | 官方云 |
| 适合场景 | 全功能、日志、大规模 | 偏好 Apache 2.0 许可、AWS 环境 | 已有 Solr 技术栈 | 轻量、低运维、中小规模 |

选型建议：

- 新项目、复杂检索、日志分析 → Elasticsearch（生态最成熟，AGPL 选项缓解了许可顾虑；对外提供托管服务等场景仍需评估许可）
- 要求 Apache 2.0 许可或深度使用 AWS → OpenSearch
- 功能轻量、团队希望低运维 → Meilisearch / Typesense
- 已有 Solr 技术栈 → 继续使用；新项目一般不选 Solr
- 数据量小、只做后台检索 → 先用 MySQL / PostgreSQL 内置全文检索，确有分词质量和相关性需求再引入搜索引擎

日志场景还可以考虑 Loki、ClickHouse 等非倒排方案，对比见 [日志体系](/observability/1_logging)。

---

## 五、常见风险

- **把搜索库当主库**：适合做查询视图，不适合作为订单、库存、账户等强一致数据源
- **Mapping 无治理**：动态映射让字段类型失控，生产索引建议 `dynamic: strict` 或模板约束，见 [Elasticsearch 实战](./3_search_es_practice#一、mapping-设计)
- **同步链路不可观测**：监控延迟、失败重试、死信、漏同步，定期与主库对账
- **大字段无节制入索引**：放大磁盘、内存和合并成本，区分可检索、可过滤和仅展示字段
- **查询不设边界**：深分页、高基数聚合、前缀通配符查询都可能拖垮集群
- **插件与版本绑定**：IK 等插件版本必须与 ES 一致，升级前先确认
- **许可与兼容性**：ES 与 OpenSearch 的 API、客户端、生命周期管理已经分化，选定后迁移成本不低

---

## 小结

- 搜索库是查询侧投影，不做主库；与主库是最终一致，默认 1 秒可见
- Elasticsearch 功能最全，原理与实战分别见 [Elasticsearch 原理](./3_search_es) 与 [Elasticsearch 实战](./3_search_es_practice)
- OpenSearch 由 Linux 基金会旗下基金会治理，3.x 与 ES 8 / 9 的 API 和客户端已不兼容，生命周期管理用 ISM
- Solr 依赖 ZooKeeper、9 起支持向量，适合存量项目；Meilisearch / Typesense 适合轻量低运维场景
- 数据量小时数据库内置全文检索就够用，中文需注意分词能力
- 许可：Elasticsearch 自 8.16 起可选 AGPLv3；向量与混合检索各引擎都已支持，专用向量库对比见 AI 模块

## 参考资料

- Elasticsearch 文档：[https://www.elastic.co/docs/reference/elasticsearch](https://www.elastic.co/docs/reference/elasticsearch)
- Elasticsearch 许可说明：[https://www.elastic.co/pricing/faq/licensing](https://www.elastic.co/pricing/faq/licensing)
- OpenSearch 文档：[https://docs.opensearch.org/latest/](https://docs.opensearch.org/latest/)
- OpenSearch 软件基金会：[https://foundation.opensearch.org/](https://foundation.opensearch.org/)
- Solr 稠密向量检索：[https://solr.apache.org/guide/solr/latest/query-guide/dense-vector-search.html](https://solr.apache.org/guide/solr/latest/query-guide/dense-vector-search.html)
- Meilisearch 文档：[https://www.meilisearch.com/docs](https://www.meilisearch.com/docs)
- Typesense 文档：[https://typesense.org/docs/](https://typesense.org/docs/)
- MySQL ngram 全文解析器：[https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)
- PostgreSQL 全文检索：[https://www.postgresql.org/docs/current/textsearch.html](https://www.postgresql.org/docs/current/textsearch.html)

> 下一篇：[Elasticsearch 原理](./3_search_es) —— 倒排索引与分词、写入与近实时、查询两阶段与集群机制

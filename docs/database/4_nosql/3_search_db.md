---
description: ES 9 / OpenSearch 3、倒排索引与分析器、Mapping 与 DSL、写入与分片、向量检索、选型
---

# 搜索数据库

> **本篇目标**：理解倒排索引与分析器如何支撑全文检索，掌握 Elasticsearch 的 Mapping、查询 DSL、聚合、写入链路（refresh / translog / flush）与分片规划，了解向量与混合检索，并清楚 Elasticsearch、OpenSearch、Solr 等产品的许可与选型差异。
>
> **前置阅读**：[MySQL 索引](../1_mysql/4_topic_index)（B+ 树与 LIKE 的局限）、[文档数据库](./2_document_db)

搜索数据库解决「按关键词、相关性、过滤条件、聚合统计快速查找数据」的问题。它通常不是主库，而是由业务库通过 CDC、消息队列或同步任务构建出来的**查询侧索引**。

---

## 一、典型场景与定位

| 场景 | 需求特点 | 常见方案 |
|------|----------|----------|
| 站内搜索 | 关键词、分词、高亮、排序、筛选 | Elasticsearch / OpenSearch / Solr |
| 日志检索 | 高写入、按时间查询、聚合分析 | Elasticsearch / OpenSearch |
| 商品检索 | 过滤条件多、排序维度多、召回与精排分离 | Elasticsearch / OpenSearch |
| 语义检索 / RAG | 向量召回 + 关键词召回混合排序 | Elasticsearch / OpenSearch / 向量数据库 |
| 轻量应用搜索 | 部署简单、数据量中小、功能聚焦 | Meilisearch / Typesense |

与关系型数据库的分工：

| 对比项 | 关系型数据库 | 搜索数据库 |
|--------|--------------|------------|
| 核心目标 | 事务一致性、结构化查询 | 文本检索、相关性排序、聚合分析 |
| 查询方式 | SQL、B+ 树索引、JOIN | 倒排索引、DSL、相关性评分 |
| 数据模型 | 表、行、列、约束 | 文档、字段、Mapping |
| 一致性 | 强一致 | 近实时（默认 1 秒可见），与主库最终一致 |
| 适合角色 | 主数据源 | 查询加速与搜索视图 |

---

## 二、Elasticsearch / OpenSearch 基础

### 1、产品与版本

- **Elasticsearch**：基于 Lucene 的分布式搜索与分析引擎，当前主线为 9.x（2025 年 4 月 GA，基于 Lucene 10）。8.0 起默认开启安全认证（TLS + 用户名密码）
- **OpenSearch**：2021 年从 Elasticsearch 7.10.2 分叉，2024 年 9 月起由 Linux 基金会下的 OpenSearch 软件基金会管理，当前主线为 3.x（2025 年发布，基于 Lucene 10）。它与 ES 7.10 之后的 API 已经分化，ES 8 / 9 的客户端不能直接连接 OpenSearch，反之亦然

### 2、基本概念

| 概念 | 类比关系型 | 说明 |
|------|-----------|------|
| Index | 表 | 文档的集合；7.0 起一个索引只有一种类型，8.0 起彻底移除 mapping type |
| Document | 行 | JSON 格式，最小存储单元 |
| Field | 列 | 文档中的字段 |
| Mapping | 表结构 | 字段类型与分析器定义 |
| Shard | 分区 | 索引的分片，每个分片是一个 Lucene 索引 |
| Replica | 副本 | 分片的副本，提供高可用和读扩展 |

### 3、倒排索引

全文检索的核心数据结构：**词项 → 文档 ID 列表（Posting List）**。

![倒排索引（Inverted Index）结构](../../assets/database/es-inverted-index.svg)

与 `LIKE '%keyword%'` 的全表扫描相比，倒排索引先在词典（FST 结构）中定位词项，再读取对应的 Posting List，多个词项时用跳表做交集。查询代价与词项长度、命中文档数和 Posting List 长度相关，而不是与全表数据量成正比。

### 4、分析器（Analyzer）

文档写入和查询时，文本都要经过分析器处理成词项：

![Elasticsearch 分析器处理链](../../assets/database/es-analyzer-pipeline.svg)

| 步骤 | 作用 | 常用实现 |
|------|------|---------|
| Character Filter | 字符预处理 | `html_strip`、`mapping` |
| Tokenizer | 切分词元，每个分析器只有一个 | `standard`（按 Unicode 文本分段规则 UAX #29 切分，中文会切成单字）、`whitespace`（只按空白切分）、`ik_max_word` / `ik_smart`（中文） |
| Token Filter | 词元加工，可以有多个 | `lowercase`、`stop`、`stemmer`、`synonym` |

中文分词：

- **IK 分词器**是第三方插件（由 infinilabs 维护），插件版本必须与 ES 版本**完全一致**，升级 ES 前先确认对应版本的 IK 已发布
- 官方插件 `analysis-smartcn`（中文智能分词）和 `analysis-icu`（基于 ICU 的分词）是替代方案

```http
PUT /articles
{
  "settings": {
    "analysis": {
      "analyzer": {
        "ik_smart_analyzer": {
          "type": "custom",
          "tokenizer": "ik_smart",
          "filter": ["lowercase"]
        }
      }
    }
  }
}
```

> 本文的 `http` 代码块是 Kibana Dev Tools Console 语法（第一行是方法与路径），不是纯 JSON。

### 5、Mapping 字段映射

```http
PUT /products
{
  "mappings": {
    "properties": {
      "name": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "price":       { "type": "scaled_float", "scaling_factor": 100 },
      "tags":        { "type": "keyword" },
      "status":      { "type": "keyword" },
      "created_at":  { "type": "date", "format": "yyyy-MM-dd HH:mm:ss||epoch_millis" },
      "description": { "type": "text", "index": false }
    }
  }
}
```

- 同一字段既要全文检索又要精确匹配、排序、聚合时，用 **multi-fields**（上例的 `name.keyword`），不要另建一个冗余字段
- 金额用 `scaled_float`（按分存储）或直接存整数分，避免 `float` 的精度问题

| 类型 | 用途 | 说明 |
|------|------|------|
| `text` | 全文检索 | 分词后建倒排索引，不能直接排序 / 聚合 |
| `keyword` | 精确匹配、排序、聚合 | 不分词，原样存储 |
| `long` / `scaled_float` / `double` | 数值范围查询 | — |
| `date` | 时间范围查询 | 支持多种格式 |
| `dense_vector` | 向量检索 | 见第五节 |
| `index: false` | 不建索引 | 只随 `_source` 返回，节省空间 |

字段类型一旦确定不能修改，改类型需要新建索引并 Reindex。

---

## 三、查询与聚合

### 1、常用查询 DSL

```http
GET /products/_search
{
  "query": {
    "bool": {
      "must":     [ { "match": { "name": "java 编程" } } ],
      "filter":   [
        { "term":  { "status": "active" } },
        { "range": { "price": { "gte": 10, "lte": 200 } } },
        { "terms": { "tags": ["backend", "java"] } }
      ],
      "must_not": [ { "term": { "tags": "deprecated" } } ],
      "should":   [ { "term": { "tags": "bestseller" } } ]
    }
  },
  "highlight": { "fields": { "name": {} } },
  "sort": [ { "_score": "desc" }, { "created_at": "desc" } ],
  "from": 0,
  "size": 10,
  "_source": ["name", "price", "tags"]
}
```

- `must` / `should` 参与相关性打分（默认 BM25）；`filter` / `must_not` 不打分且可缓存，结构化条件尽量放 `filter`
- `bool` 中有 `must` 或 `filter` 时，`should` 默认只影响打分，不是必须命中

### 2、聚合

```http
GET /orders/_search
{
  "size": 0,
  "aggs": {
    "by_status": {
      "terms": { "field": "status", "size": 10 },
      "aggs": {
        "total": { "sum": { "field": "amount" } },
        "avg":   { "avg": { "field": "amount" } }
      }
    },
    "daily": {
      "date_histogram": {
        "field": "created_at",
        "calendar_interval": "day",
        "format": "yyyy-MM-dd"
      },
      "aggs": { "daily_revenue": { "sum": { "field": "amount" } } }
    }
  }
}
```

`terms` 聚合在多分片上是近似结果（每个分片取 Top N 再合并），对精度敏感时调大 `shard_size`。

### 3、深分页

`from + size` 默认不能超过 `index.max_result_window`（10000），越往后越慢。深分页用 **`search_after` + PIT（Point in Time）**；`scroll` 只适合离线导出，不再推荐用于翻页。

```http
POST /products/_pit?keep_alive=1m

GET /_search
{
  "size": 10,
  "pit": { "id": "<上一步返回的 pit id>", "keep_alive": "1m" },
  "sort": [ { "created_at": "desc" }, { "_shard_doc": "asc" } ],
  "search_after": [ 1704067200000, 4294967298 ]
}
```

`search_after` 取上一页最后一条结果的 `sort` 值，`_shard_doc` 作为唯一的排序兜底字段。

---

## 四、写入与集群

### 1、写入链路

![Elasticsearch 写入流程](../../assets/database/es-write-flow.svg)

| 操作 | 触发时机 | 作用 |
|------|---------|------|
| 写 Translog | 每次写请求 | 保证持久性；默认 `index.translog.durability: request`，每个请求返回前 fsync |
| refresh | 默认每 1 秒（索引有搜索请求时） | 内存 Buffer 生成新 Segment，进入文件系统缓存，**变为可搜索**，但尚未 fsync 落盘 |
| flush | Translog 达到阈值或定期 | Lucene commit：Segment fsync 落盘，并截断已无需保留的 Translog |
| merge | 后台持续 | 合并小 Segment，物理清理已删除文档 |

所以「写入成功」的持久性来自 Translog，而不是 refresh；refresh 只决定什么时候能搜到。把 `durability` 改为 `async` 可以提升写入吞吐，但宕机时可能丢失最近 `sync_interval`（默认 5 秒）的数据。

大批量导入时：

```http
PUT /my_index/_settings
{ "index": { "refresh_interval": "-1", "number_of_replicas": 0 } }

PUT /my_index/_settings
{ "index": { "refresh_interval": "1s", "number_of_replicas": 1 } }
```

导入前关闭 refresh 并去掉副本，用 `_bulk` 批量写入（单批 5~15MB 为宜），导入完成后恢复两项设置，副本会从主分片整体复制。

### 2、集群与分片

![Elasticsearch 集群架构](../../assets/database/es-cluster.svg)

分片规划原则：

- 单个分片建议 10~50GB，每个分片文档数不超过 2 亿
- 时间序列类数据（日志）用数据流（Data Stream）+ ILM 按大小或时间滚动，而不是一个大索引
- 副本数可以随时动态调整
- 主分片数创建后不能直接修改，但不一定要 Reindex：
  - `_split`：拆成更多主分片，目标数必须是原分片数的倍数，源索引需先设为只读
  - `_shrink`：缩成更少主分片，目标数必须是原分片数的因数，源索引需只读且所有分片副本集中在同一节点
  - 其他情况（如改字段类型）才需要 Reindex

```http
PUT /logs-old/_settings
{ "index.blocks.write": true }

POST /logs-old/_split/logs-new
{ "settings": { "index.number_of_shards": 6 } }
```

### 3、常用运维操作

```http
GET /_cluster/health

GET /_cat/indices?v&h=index,health,docs.count,store.size&s=store.size:desc

PUT /my_index/_settings
{
  "index.search.slowlog.threshold.query.warn": "5s",
  "index.search.slowlog.threshold.fetch.warn": "1s"
}

POST /_reindex
{
  "source": { "index": "old_index" },
  "dest":   { "index": "new_index" }
}

POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}
```

业务始终通过别名访问索引，重建索引后原子切换别名，实现零停机变更 Mapping。

---

## 五、向量与混合检索

- **`dense_vector` + kNN**：基于 HNSW 的近似最近邻检索，可与 `bool` 过滤组合
- **量化**：`int8` / `int4` 量化以及 8.16 引入的 BBQ（Better Binary Quantization），大幅降低向量内存占用
- **`semantic_text`**：写入时自动调用推理端点生成向量，查询时直接 `semantic` 查询，省去手动管理 embedding
- **混合检索**：用 RRF（Reciprocal Rank Fusion）把 BM25 关键词结果与向量结果融合排序

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

OpenSearch 通过 k-NN 插件和 Neural Search 提供类似能力；Solr 从 9.0 起支持 `DenseVectorField` 与 KNN 查询。RAG 场景的整体设计见 [AI 总览](/ai/0_overview)。

---

## 六、数据同步

常见做法是「业务库作为事实源，搜索库作为查询侧投影」：业务写入 MySQL / PostgreSQL，通过 Outbox、MQ 或 CDC 捕获变更，同步服务组装成面向搜索的宽文档写入 ES，并用版本号（`version_type: external`）或更新时间处理乱序与重复。

- CDC 工具（Canal、Debezium 等）的原理与选型见 [CDC 工具](../5_practice/0_cdc_tools)
- 用 Flink CDC 做多表关联后写 ES 见 [Flink CDC](/flink/6_cdc)
- 商品搜索的完整业务设计（同步链路、全量重建、别名切换）见 [搜索系统设计](/scenario/9_search_system)
- Spring Boot 中接入 Elasticsearch 见 [中间件集成](/spring-boot/5_middleware)

---

## 七、选型对比

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

---

## 八、常见风险

- **把搜索库当主库**：适合做查询视图，不适合作为订单、库存、账户等强一致数据源
- **Mapping 无治理**：动态映射让字段类型失控，生产索引建议 `dynamic: strict` 或模板约束
- **同步链路不可观测**：监控延迟、失败重试、死信、漏同步，定期与主库对账
- **大字段无节制入索引**：放大磁盘、内存和合并成本，区分可检索、可过滤和仅展示字段
- **查询不设边界**：深分页、高基数聚合、前缀通配符查询都可能拖垮集群
- **插件与版本绑定**：IK 等插件版本必须与 ES 一致，升级前先确认

---

## 小结

- 搜索库是查询侧投影，不做主库；与主库是最终一致，默认 1 秒可见
- 倒排索引通过词典定位词项再读 Posting List，代价与命中量相关，并非 O(1)
- `standard` 分词器按 UAX #29 切分、中文切单字；中文用 IK（第三方，版本需完全匹配）或官方 smartcn / ICU
- Mapping 用 multi-fields 兼顾全文与精确匹配，金额用 `scaled_float` 或整数分；字段类型改不了，靠新索引 + Reindex + 别名切换
- 持久性来自 Translog（默认每请求 fsync），refresh 只管可见性，flush 是 Lucene commit 加截断 Translog
- 主分片数可通过 `_split` / `_shrink` 在约束下调整；深分页用 `search_after` + PIT
- 许可：Elasticsearch 自 8.16 起可选 AGPLv3；OpenSearch 由 Linux 基金会旗下基金会治理，3.x 与 ES 8 / 9 的 API 和客户端已不兼容；Solr 9 起支持向量

## 参考资料

- Elasticsearch 文档：[https://www.elastic.co/docs/reference/elasticsearch](https://www.elastic.co/docs/reference/elasticsearch)
- Elasticsearch 许可说明：[https://www.elastic.co/pricing/faq/licensing](https://www.elastic.co/pricing/faq/licensing)
- Standard tokenizer：[https://www.elastic.co/docs/reference/text-analysis/analysis-standard-tokenizer](https://www.elastic.co/docs/reference/text-analysis/analysis-standard-tokenizer)
- Translog 设置：[https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog](https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog)
- Split index API：[https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-indices-split](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-indices-split)
- 分页与 search_after：[https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)
- OpenSearch 文档：[https://docs.opensearch.org/latest/](https://docs.opensearch.org/latest/)
- OpenSearch 软件基金会：[https://foundation.opensearch.org/](https://foundation.opensearch.org/)
- Solr 稠密向量检索：[https://solr.apache.org/guide/solr/latest/query-guide/dense-vector-search.html](https://solr.apache.org/guide/solr/latest/query-guide/dense-vector-search.html)
- IK 分词插件：[https://github.com/infinilabs/analysis-ik](https://github.com/infinilabs/analysis-ik)

> 下一篇：[图数据库](./4_graph_db) —— 关系是一等公民：Neo4j、NebulaGraph 与图查询语言

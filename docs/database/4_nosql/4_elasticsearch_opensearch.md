# Elasticsearch 与 OpenSearch

## 一、核心概念

### 1、定位
- 基于 **Lucene** 的分布式搜索与分析引擎
- 核心能力：全文搜索、日志分析（ELK 栈）、聚合分析、近实时（NRT）
- **OpenSearch**：AWS fork 的 Elasticsearch 开源版本，API 与 ES 7.x 兼容

### 2、基本概念

| ES 概念 | 类比关系型 | 说明 |
|---------|-----------|------|
| Index | 表 | 文档的集合 |
| Document | 行 | JSON 格式，最小存储单元 |
| Field | 列 | 文档中的字段 |
| Shard | 分区 | 索引的分片，分散存储，支持并行查询 |
| Replica | 副本 | 分片的副本，提供高可用和读扩展 |
| Mapping | 表结构 | 字段类型定义 |

---

## 二、倒排索引原理

全文搜索的核心数据结构：**词 → 文档 ID 列表（Posting List）**

```
文档1: "Java is fast and powerful"
文档2: "Java and Python are popular"
文档3: "Python is easy to learn"

分词后的倒排索引：
Term      Posting List
"java"  → [doc1, doc2]
"python"→ [doc2, doc3]
"fast"  → [doc1]
"easy"  → [doc3]
"learn" → [doc3]

查询 "java AND fast" → 取交集 → [doc1]
查询 "java OR python" → 取并集 → [doc1, doc2, doc3]
```

相比关系型数据库的 LIKE '%keyword%'（全表扫描），倒排索引查询时间复杂度接近 O(1)。

---

## 三、分析器（Analyzer）

文档写入和查询时，文本经过分析器处理成词（Term）：

```
原始文本 → Character Filters → Tokenizer → Token Filters → Terms（词项）
```

| 步骤 | 作用 | 常用实现 |
|------|------|---------|
| Character Filter | 字符预处理 | html_strip（去 HTML 标签）|
| Tokenizer | 分词 | standard（英文空格）、ik_max_word（中文 IK）|
| Token Filter | 词处理 | lowercase、stop（停用词）、stemmer（词干提取）|

```json
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

---

## 四、Mapping 字段映射

```json
PUT /products/_mapping
{
  "properties": {
    "name":       { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "name_kw":    { "type": "keyword" },
    "price":      { "type": "float" },
    "tags":       { "type": "keyword" },
    "status":     { "type": "keyword" },
    "created_at": { "type": "date", "format": "yyyy-MM-dd HH:mm:ss||epoch_millis" },
    "description":{ "type": "text", "index": false }
  }
}
```

| 类型 | 用途 | 说明 |
|------|------|------|
| `text` | 全文搜索 | 分词后建倒排索引 |
| `keyword` | 精确匹配、排序、聚合 | 不分词，原样存储 |
| `integer/float/double` | 数值范围查询 | — |
| `date` | 时间范围查询 | 支持多种格式 |
| `index: false` | 不建索引 | 节省空间，只用于 _source 返回 |

---

## 五、常用查询 DSL

```json
GET /products/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "name": "java 编程" } }
      ],
      "filter": [
        { "term":  { "status": "active" } },
        { "range": { "price": { "gte": 10, "lte": 200 } } },
        { "terms": { "tags": ["backend", "java"] } }
      ],
      "must_not": [
        { "term": { "tags": "deprecated" } }
      ],
      "should": [
        { "term": { "tags": "bestseller" } }
      ],
      "minimum_should_match": 0
    }
  },
  "highlight": {
    "fields": { "name": { "pre_tags": ["<em>"], "post_tags": ["</em>"] } }
  },
  "sort": [
    { "_score": "desc" },
    { "created_at": "desc" }
  ],
  "from": 0,
  "size": 10,
  "_source": ["name", "price", "tags"]
}
```

---

## 六、聚合（Aggregation）

```json
GET /orders/_search
{
  "size": 0,
  "aggs": {
    "by_status": {
      "terms": { "field": "status", "size": 10 },
      "aggs": {
        "total":   { "sum": { "field": "amount" } },
        "avg":     { "avg": { "field": "amount" } },
        "max":     { "max": { "field": "amount" } }
      }
    },
    "daily": {
      "date_histogram": {
        "field": "created_at",
        "calendar_interval": "day",
        "format": "yyyy-MM-dd"
      },
      "aggs": {
        "daily_revenue": { "sum": { "field": "amount" } }
      }
    },
    "price_ranges": {
      "range": {
        "field": "amount",
        "ranges": [
          { "to": 100 },
          { "from": 100, "to": 500 },
          { "from": 500 }
        ]
      }
    }
  }
}
```

---

## 七、写入与查询流程

### 写入流程

```
Client → Coordinating Node
  → 按路由算法（shard = hash(doc_id) % primary_count）找 Primary Shard
  → Primary 写入 Translog + Memory Buffer
  → 同步复制到 Replica Shard
  → 返回 ACK

后台异步：
  refresh（默认每1s）→ Buffer 写入 Segment → 数据可被搜索（NRT）
  flush（定时）→ Segment + Translog 持久化到磁盘，清空 Translog
```

### refresh vs flush

| 操作 | 触发时机 | 作用 | 对性能的影响 |
|------|---------|------|------------|
| refresh | 默认每 1s | Buffer → Segment（数据可搜索）| 频繁 refresh 影响写入吞吐 |
| flush | Translog 过大/定时 | 持久化到磁盘 | I/O 密集 |

```json
// 大批量导入时关闭 refresh 提升写入速度
PUT /my_index/_settings
{ "index": { "refresh_interval": "-1" } }

// 导入完成后恢复
PUT /my_index/_settings
{ "index": { "refresh_interval": "1s" } }
```

---

## 八、集群架构

```
Client
  ↓
Coordinating Node（路由请求、聚合结果）
  ↓
Data Node × N（存储 Primary/Replica Shard）
  ↑
Master Node（集群元数据管理，选主，不处理数据）
```

**分片规划原则**：
- 单个 Shard 建议 10~50GB，不超过 50GB
- 主分片数创建后不可修改（需 Reindex）
- Replica 数可动态调整

```json
PUT /my_index
{
  "settings": {
    "number_of_shards":   3,
    "number_of_replicas": 1
  }
}
```

---

## 九、常用运维操作

```json
// 查看集群健康
GET /_cluster/health

// 查看索引状态
GET /_cat/indices?v&h=index,health,docs.count,store.size&s=store.size:desc

// 查看慢查询日志
PUT /my_index/_settings
{
  "index.search.slowlog.threshold.query.warn":  "5s",
  "index.search.slowlog.threshold.fetch.warn": "1s"
}

// Reindex（跨索引迁移/修改 Mapping）
POST /_reindex
{
  "source": { "index": "old_index" },
  "dest":   { "index": "new_index" }
}

// 别名（零停机切换索引）
POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}
```

---

## 十、ES vs OpenSearch vs Solr

| 维度 | Elasticsearch | OpenSearch | Apache Solr |
|------|:------------:|:----------:|:-----------:|
| 开源协议 | SSPL（7.11+ 非完全开源）| Apache 2.0 | Apache 2.0 |
| 维护方 | Elastic 公司 | AWS + 社区 | Apache 基金会 |
| API 兼容 | — | 兼容 ES 7.x | 独立 API |
| 可视化 | Kibana | OpenSearch Dashboards | Solr Admin UI |
| 云托管 | Elastic Cloud | AWS OpenSearch Service | 自建为主 |
| 机器学习 | ✅（部分付费）| ✅（开源）| 弱 |
| 向量搜索 | ✅ | ✅ | ✅（8.x+）|

**选型建议**：
- 新项目首选 **Elasticsearch**（生态最成熟，文档最丰富）
- AWS 环境或开源协议有要求 → **OpenSearch**
- 已有 Solr 技术栈 → 继续用 Solr；新项目不建议选 Solr

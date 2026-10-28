---
description: 倒排索引与分词、Mapping 基础、分片副本、写入与近实时、段合并、Query/Fetch 与 BM25、集群选主
---

# Elasticsearch 原理

> 前置阅读：[搜索数据库](./5_search_db)、[MySQL 索引](/database/1_mysql/4_topic_index)

Elasticsearch 是基于 Lucene 的分布式搜索引擎，靠倒排索引换取全文检索速度，靠分片副本做水平扩展。本篇讲倒排索引与分词、Mapping、写入与近实时、查询两阶段和集群机制，基线为 Elasticsearch 9。

---

## 一、核心概念

| 概念 | 类比关系型 | 说明 |
|------|-----------|------|
| Index | 表 | 文档的集合；7.0 起一个索引只有一种类型，8.0 起彻底移除 mapping type |
| Document | 行 | JSON 格式，最小存储单元，原文保存在 `_source` 中 |
| Field | 列 | 文档中的字段 |
| Mapping | 表结构 | 字段类型与分析器定义 |
| Shard | 分区 | 索引的分片，每个分片是一个独立的 Lucene 索引 |
| Replica | 副本 | 分片的副本，提供高可用和读扩展 |
| Segment | — | Lucene 的不可变索引文件，一个分片由多个段组成 |

OpenSearch 是 ES 7.10 的分叉，底层同样是 Lucene，本篇的倒排索引、段、近实时等机制对它同样适用，差异见 [搜索数据库](./5_search_db#二、各引擎速览)。

---

## 二、倒排索引与分词

### 1、倒排索引

全文检索的核心数据结构：**词项 → 文档 ID 列表（Posting List）**。

![倒排索引（Inverted Index）结构](../assets/database/es-inverted-index.svg)

与 `LIKE '%keyword%'` 的全表扫描相比，倒排索引先在词典（FST 结构，前缀共享、常驻内存）中定位词项，再读取对应的 Posting List，多个词项时用跳表做交集。查询代价与词项长度、命中文档数和 Posting List 长度相关，而不是与全表数据量成正比。

倒排索引擅长「哪些文档包含这个词」，却不擅长「这篇文档这个字段的值是多少」。排序和聚合需要后者，所以 Lucene 另外按列存了一份 **doc_values**（磁盘上的列式结构），`keyword`、数值、日期默认都开启。两者的使用取舍见 [Elasticsearch 实战](./5_search_es_practice#_2、聚合与-doc-values)。

### 2、分析器链

文档写入和查询时，`text` 字段都要经过分析器处理成词项：

![Elasticsearch 分析器处理链](../assets/database/es-analyzer-pipeline.svg)

| 步骤 | 作用 | 常用实现 |
|------|------|---------|
| Character Filter | 字符预处理，可以有多个 | `html_strip`、`mapping` |
| Tokenizer | 切分词元，每个分析器只有一个 | `standard`（按 Unicode 文本分段规则 UAX #29 切分，中文会切成单字）、`whitespace`（只按空白切分）、`ik_max_word` / `ik_smart`（中文） |
| Token Filter | 词元加工，可以有多个 | `lowercase`、`stop`、`stemmer`、`synonym` |

写入用的分析器（`analyzer`）和查询用的分析器（`search_analyzer`）可以不同，但两边产出的词项必须能对上，否则会出现「明明存了却搜不到」。用 `_analyze` 接口可以直接看切词结果，排查分词问题时先跑一遍：

```http
GET /_analyze
{
  "analyzer": "ik_smart",
  "text": "分布式搜索引擎"
}
```

> 本文的 `http` 代码块是 Kibana Dev Tools Console 语法（第一行是方法与路径），不是纯 JSON。

### 3、中文分词

`standard` 把中文切成单字，「手机」会变成「手」「机」，召回多但不准，生产环境要换中文分词器：

- **IK 分词器**：第三方插件（由 infinilabs 维护），提供 `ik_max_word`（穷举所有可能的词，切得细、召回高）和 `ik_smart`（最粗粒度切分，更准）。常见搭配是写入用 `ik_max_word`、查询用 `ik_smart`
- **词典**：IK 支持自定义词库和停用词，可以通过远程词典 URL 热更新；新增词只影响之后写入的文档，历史文档要重建索引才生效
- **版本绑定**：IK 插件版本必须与 ES 版本**完全一致**，升级 ES 前先确认对应版本的 IK 已发布
- **官方替代**：`analysis-smartcn`（中文智能分词）和 `analysis-icu`（基于 ICU 的分词），不依赖第三方，但词典不可定制

```http
PUT /articles
{
  "settings": {
    "analysis": {
      "analyzer": {
        "ik_smart_analyzer": {
          "type": "custom",
          "char_filter": ["html_strip"],
          "tokenizer": "ik_smart",
          "filter": ["lowercase"]
        }
      }
    }
  }
}
```

---

## 三、文档与 Mapping 基础

Mapping 决定每个字段怎么建索引：

| 类型 | 用途 | 说明 |
|------|------|------|
| `text` | 全文检索 | 分词后建倒排索引，默认没有 doc_values，不能直接排序 / 聚合 |
| `keyword` | 精确匹配、排序、聚合 | 不分词，原样作为一个词项 |
| `long` / `scaled_float` / `double` | 数值范围查询 | 用 BKD 树索引，范围查询高效 |
| `date` | 时间范围查询 | 内部存为毫秒时间戳，支持多种输入格式 |
| `nested` | 对象数组独立查询 | 每个对象是一个隐藏的子文档 |
| `dense_vector` | 向量检索 | HNSW 索引，见 [搜索数据库](./5_search_db#三、向量与混合检索) |

几条底层约束：

- **动态映射**：写入未定义的字段时，ES 会按值猜类型（字符串默认映射为 `text` + `keyword` 子字段），方便但容易失控
- **类型不能改**：字段一旦建好倒排索引和 doc_values，改类型就意味着所有段要重建，所以 ES 只允许新增字段，不允许改已有字段的类型，只能新建索引再 Reindex
- **更新即重写**：段是不可变的，「更新」一个文档实际是标记删除旧文档再写入新文档，部分更新（`_update`）也是在内部读出 `_source` 合并后整篇重写

Mapping 的设计方法（multi-field、关闭动态映射、nested 与扁平化）见 [Elasticsearch 实战](./5_search_es_practice#一、mapping-设计)。

---

## 四、分片与副本

![Elasticsearch 集群架构](../assets/database/es-cluster.svg)

文档落到哪个分片由路由决定：

```text
shard = hash(_routing) % number_of_primary_shards
```

`_routing` 默认是文档 `_id`。公式依赖主分片数，所以**主分片数创建后不能直接修改**，否则已有文档都找不到了。在约束下可以用 `_split`（倍数扩）和 `_shrink`（因数缩）调整，操作方法见 [Elasticsearch 实战](./5_search_es_practice#_3、调整主分片数)。

- **副本**：每个主分片可以有 0 到多个副本，副本数随时可调；同一分片的主副本不会分配在同一节点上
- **读扩展**：查询可以落在主分片或任意副本上，副本越多读吞吐越高，但写入要同步到所有副本，写放大也越大
- **分片大小**：单个分片建议 10~50GB、文档数不超过 2 亿；分片过多会占用堆内存和集群元数据，过少则无法利用多节点并行

---

## 五、写入流程

### 1、写入链路

![Elasticsearch 写入流程](../assets/database/es-write-flow.svg)

1. 客户端请求到达任意节点，该节点作为**协调节点**，按路由公式算出主分片
2. 主分片写入内存 Buffer 并追加 Translog，然后把操作并行转发给所有 in-sync 副本
3. in-sync 副本都写完后，主分片向协调节点确认，协调节点返回客户端

`wait_for_active_shards`（默认 1，即只要求主分片可用）控制的是**写之前**的检查：活跃分片副本数不够就拒绝写入。它不改变写入要同步到所有 in-sync 副本这件事。

### 2、refresh、Translog 与 flush

| 操作 | 触发时机 | 作用 |
|------|---------|------|
| 写 Translog | 每次写请求 | 保证持久性；默认 `index.translog.durability: request`，每个请求返回前 fsync |
| refresh | 默认每 1 秒（索引有搜索请求时） | 内存 Buffer 生成新 Segment，进入文件系统缓存，**变为可搜索**，但尚未 fsync 落盘 |
| flush | Translog 达到阈值或定期 | Lucene commit：Segment fsync 落盘，并截断已无需保留的 Translog |
| merge | 后台持续 | 合并小 Segment，物理清理已删除文档 |

- **近实时（NRT）**：写入成功后最多约 1 秒才能被搜到，这就是 ES 被称为近实时的原因。确实需要「写完立刻可搜」时，可以在写请求上加 `refresh=wait_for`（等下一次 refresh 再返回），不要用 `refresh=true` 每次强刷，会制造大量小段
- **持久性来自 Translog**：refresh 只决定什么时候能搜到；节点宕机重启后靠重放 Translog 恢复最近一次 commit 之后的写入
- **async 的代价**：把 `durability` 改为 `async` 可以提升写入吞吐，但宕机时可能丢失最近 `sync_interval`（默认 5 秒）的数据
- **搜索空闲**：一个分片 30 秒（`index.search.idle.after`）没有收到搜索请求就会暂停定时 refresh，下次搜索时再触发，以节省写入密集索引的资源
- **按 ID 读是实时的**：`GET /index/_doc/1` 默认 `realtime: true`，即使还没 refresh 也能读到最新版本

### 3、段合并

段一旦写出就不可变，删除和更新只是在 `.liv` 文件里把旧文档标记为已删除。结果是：

- 每秒 refresh 一次就会产生大量小段，查询要逐段搜索再合并，段越多越慢
- 被标记删除的文档仍占磁盘，也仍参与词频统计

后台合并线程按分层合并策略（Tiered Merge Policy）把大小相近的小段合成大段，同时物理丢弃已删除文档。合并很耗 IO，ES 会自动限速，写入高峰时合并跟不上也会反过来限制写入。

对不再写入的历史索引（如过期的日志索引），可以手动 `_forcemerge` 到 1 个段，减少段数、提升查询速度；**仍在写入的索引不要 force merge**，会产生超过 5GB 的大段，之后再也不会被自动合并，删除的文档迟迟清理不掉。

```http
POST /logs-2026.09/_forcemerge?max_num_segments=1
```

---

## 六、读流程

### 1、Query then Fetch

搜索请求分两个阶段执行，先找到「哪些文档」，再取「文档内容」：

![Elasticsearch 查询两阶段](../assets/database/es-query-then-fetch.svg)

- **Query 阶段**：协调节点把查询发给每个分片的一份副本（主或副本，按自适应副本选择挑响应最快的），各分片本地检索、打分，只返回排序靠前的 `from + size` 个 docID 和排序值
- **Fetch 阶段**：协调节点全局排序后，只向持有最终结果的分片取 `_source`、生成高亮
- **深分页为什么慢**：要拿第 10000 条起的 10 条，每个分片都要返回 10010 条，协调节点在内存里排序「分片数 × 10010」条，所以 `from + size` 默认被限制在 10000 以内，替代方案见 [Elasticsearch 实战](./5_search_es_practice#三、深分页)

### 2、相关性评分 BM25

ES 默认用 BM25 给 `match` 等全文查询打分，直觉上由三部分决定：

| 因子 | 含义 | 影响 |
|------|------|------|
| 词频（TF） | 词在该文档字段里出现几次 | 越多分越高，但有饱和上限（参数 `k1`，默认 1.2），堆关键词收益递减 |
| 逆文档频率（IDF） | 词在多少文档里出现过 | 越稀有分越高，「的」这种词几乎不加分 |
| 字段长度归一 | 字段越短，命中越有分量 | 参数 `b`（默认 0.75）控制归一强度，标题命中通常比正文命中分高 |

- IDF 是**按分片**统计的，数据量小或分布不均时，同一个词在不同分片上的 IDF 不同，排序会有轻微偏差。测试环境数据少时尤其明显，可以用 `search_type=dfs_query_then_fetch` 先收集全局词频再打分，代价是多一次网络往返
- 想知道一条结果为什么排在前面，给查询加 `"explain": true`，返回每个因子的计算明细
- 业务排序（销量、时效、个性化）不靠改 BM25 参数，而是用 `function_score` 或重排融合，见 [搜索](/scenario/9_search_system#七、相关性调优)

---

## 七、集群

### 1、节点角色

通过 `node.roles` 指定，一个节点可以有多个角色：

| 角色 | 职责 | 建议 |
|------|------|------|
| `master` | 有资格当选主节点，管理集群状态（索引、Mapping、分片分配） | 生产环境 3 个专用主节点，不承担数据与查询 |
| `data` / `data_hot` / `data_warm` / `data_cold` / `data_frozen` | 存储分片，执行写入、搜索与聚合 | 冷热分层时按硬件分配不同的数据层角色 |
| `ingest` | 写入前用 Pipeline 预处理文档 | 处理量大时独立部署 |
| 协调节点（`node.roles: []`） | 只路由请求、合并结果 | 大量聚合查询时可独立部署，分担数据节点压力 |

### 2、选主、脑裂与 quorum

- 7.0 起 ES 重写了集群协调层：主节点由有资格的节点投票选出，**必须获得投票配置（voting configuration）中过半数的票**，集群状态变更也要过半数确认
- 投票配置由 ES 自动维护，节点增减时自动调整，旧版本需要手工设置的 `discovery.zen.minimum_master_nodes` 已被移除
- **脑裂**：网络分区时，两边各自选出一个主节点，各写各的，恢复后数据冲突。过半数规则保证任何时刻最多一边能凑够票，少数派一侧选不出主、拒绝写入
- 主节点资格节点应为**奇数个、至少 3 个**：3 个能容忍 1 个故障；2 个节点时任何一个挂掉都凑不够过半数
- `cluster.initial_master_nodes` 只在**新集群首次启动**时用于引导选举，集群形成后要从配置中删掉，否则重启时可能误引导出一个新集群

### 3、分片分配

主节点决定每个分片放在哪个节点上，常见规则：

- **主副本分离**：同一分片的主分片与副本不能在同一节点；单节点集群因此永远是 yellow
- **磁盘水位**：磁盘使用率达到 85%（low）后不再往该节点分配新分片，90%（high）开始把分片迁出，95%（flood stage）给该节点上的索引加只读块，写入直接报错
- **机架 / 可用区感知**：配置 `cluster.routing.allocation.awareness.attributes: zone` 后，主副本会尽量分到不同可用区，单个可用区故障不丢数据
- **集群健康**：green 表示主副本全部分配；yellow 表示主分片都在、有副本未分配；red 表示有主分片未分配，对应数据不可读写。排查方法见 [Elasticsearch 实战](./5_search_es_practice#_1、集群-red-与-yellow)

---

## 小结

- 倒排索引通过词典（FST）定位词项再读 Posting List，代价与命中量相关；排序聚合走另一份列存 doc_values
- `standard` 分词器把中文切成单字；中文用 IK（第三方，版本需完全匹配，写入 `ik_max_word`、查询 `ik_smart`）或官方 smartcn / ICU
- 字段类型改不了，因为倒排和 doc_values 已按旧类型建好；段不可变，更新等于删除加新增
- 路由按 `hash(_routing) % 主分片数`，所以主分片数不能随意改；副本数随时可调
- 持久性来自 Translog（默认每请求 fsync），refresh（默认 1 秒）只管可见性，flush 是 Lucene commit 加截断 Translog
- 搜索分 Query 和 Fetch 两阶段，深分页贵在每个分片都要返回 `from + size` 条；相关性默认 BM25，IDF 按分片统计
- 集群用过半数投票选主防脑裂，主节点资格节点至少 3 个；磁盘水位 85% / 90% / 95% 影响分配与写入

## 参考资料

- Elasticsearch 文档：[https://www.elastic.co/docs/reference/elasticsearch](https://www.elastic.co/docs/reference/elasticsearch)
- Standard tokenizer：[https://www.elastic.co/docs/reference/text-analysis/analysis-standard-tokenizer](https://www.elastic.co/docs/reference/text-analysis/analysis-standard-tokenizer)
- IK 分词插件：[https://github.com/infinilabs/analysis-ik](https://github.com/infinilabs/analysis-ik)
- Translog 设置：[https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog](https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog)
- Near real-time search：[https://www.elastic.co/docs/manage-data/data-store/near-real-time-search](https://www.elastic.co/docs/manage-data/data-store/near-real-time-search)
- 集群协调与投票配置：[https://www.elastic.co/docs/deploy-manage/distributed-architecture/discovery-cluster-formation](https://www.elastic.co/docs/deploy-manage/distributed-architecture/discovery-cluster-formation)
- 磁盘水位设置：[https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings)
- Lucene BM25Similarity：[https://lucene.apache.org/core/10_0_0/core/org/apache/lucene/search/similarities/BM25Similarity.html](https://lucene.apache.org/core/10_0_0/core/org/apache/lucene/search/similarities/BM25Similarity.html)

> 下一篇：[Elasticsearch 实战](./5_search_es_practice) —— Mapping 设计、查询与分页、索引生命周期、同步、调优与故障排查

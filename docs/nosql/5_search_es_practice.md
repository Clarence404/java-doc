---
description: Mapping 设计、bool 查询与聚合、深分页、别名与 ILM、MySQL 同步、调优、Java 客户端、故障排查
---

# Elasticsearch 实战

> 前置阅读：[Elasticsearch 原理](./5_search_es)、[CDC 工具](/database/5_practice/0_cdc_tools)

ES 用得好不好，主要看 Mapping 设计、查询写法和索引怎么滚动重建。本篇讲 Mapping 设计、查询与深分页、索引生命周期、与 MySQL 同步、性能调优、Java 客户端和常见故障，基线为 Elasticsearch 9。

---

## 一、Mapping 设计

### 1、keyword 与 text

| 需求 | 字段类型 | 示例 |
|------|---------|------|
| 分词后全文检索 | `text` | 标题、描述、正文 |
| 精确匹配、排序、聚合 | `keyword` | 状态、标签、品牌、订单号 |
| 两种都要 | `text` + `keyword` 子字段（multi-field） | 商品名既要搜索又要按名称聚合 |
| 只展示、不检索 | `"index": false` | 图片 URL、长描述 |

```http
PUT /products_v1
{
  "mappings": {
    "dynamic": "strict",
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
      "image_url":   { "type": "keyword", "index": false }
    }
  },
  "aliases": { "products": {} }
}
```

> 本文的 `http` 代码块是 Kibana Dev Tools Console 语法（第一行是方法与路径），不是纯 JSON。

- 同一字段既要全文检索又要精确匹配、排序、聚合时，用 **multi-field**（上例的 `name.keyword`），不要在业务里另存一个冗余字段
- 金额用 `scaled_float`（按分存储）或直接存整数分，避免 `float` 的精度问题
- 订单号、手机号这类「看起来是数字」的标识用 `keyword`：它们只做精确匹配，数值类型的 BKD 树对 `term` 查询反而不如 `keyword` 快
- 物理索引名带版本号、业务只认别名，为后面的零停机重建留出口子

### 2、关闭动态映射

动态映射会让任何新字段自动进入 Mapping，日志或用户自定义属性很容易把字段数撑爆。生产索引建议显式控制：

| `dynamic` 取值 | 遇到未定义字段 | 适用 |
|---------------|---------------|------|
| `true`（默认） | 自动推断类型并加入 Mapping | 开发、探索阶段 |
| `strict` | 直接拒绝写入 | 业务索引，字段需要评审 |
| `false` | 保留在 `_source`，但不建索引、不可搜索 | 透传扩展字段 |
| `runtime` | 作为运行时字段，查询时现算 | 偶尔查询的字段，以查询性能换存储 |

同一类索引（如每天一个的日志索引）用**索引模板**（`_index_template`）统一 settings 和 mappings，新索引按名字匹配自动套用，避免每个索引各长各的。

### 3、nested 与扁平化

ES 默认把对象数组「拍平」成多值字段，数组里对象之间的对应关系会丢失：

```json
{ "skus": [ { "color": "红", "size": "L" }, { "color": "蓝", "size": "M" } ] }
```

拍平后是 `skus.color: [红, 蓝]`、`skus.size: [L, M]`，查询「红色且 M 码」也会命中，尽管并不存在红色 M 码。处理方式：

- **`nested` 类型**：每个数组元素存为一个隐藏子文档，配合 `nested` 查询保持对应关系。代价是文档数成倍增加，单文档的 nested 对象默认最多 1 万个（`index.mapping.nested_objects.limit`），更新任何一个子对象都要重写整篇文档
- **扁平化**：把需要组合查询的维度拼成一个字段，如 `sku_key: "红_M"`，或干脆每个 SKU 一篇文档、商品信息冗余进去。查询最快，是商品搜索的常见做法
- **`join` 父子文档**：父子分开更新，但查询代价高、父子必须在同一分片，一般不推荐

能扁平化就扁平化，对象数组确实需要逐元素匹配、且数组不大时再用 `nested`。

---

## 二、查询与聚合

### 1、bool 查询：must 与 filter

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

| 子句 | 必须命中 | 参与打分 | 可缓存 |
|------|---------|---------|-------|
| `must` | 是 | 是 | 否 |
| `filter` | 是 | 否 | 是 |
| `should` | 视情况 | 是 | 否 |
| `must_not` | 必须不命中 | 否 | 是 |

- 状态、类目、价格区间这类「是不是」的条件放 `filter`：不算分省 CPU，结果以位图形式缓存在节点查询缓存里，重复查询直接复用
- 只有关键词这类「有多相关」的条件放 `must`
- `bool` 中有 `must` 或 `filter` 时，`should` 默认只影响打分，不是必须命中；需要「至少命中 N 个」时显式写 `minimum_should_match`

### 2、聚合与 doc_values

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

- 聚合和排序读的是 **doc_values**（磁盘列存，靠操作系统页缓存加速），`keyword`、数值、日期默认开启；确定不聚合不排序的字段可以设 `"doc_values": false` 省磁盘
- `text` 字段没有 doc_values，对它聚合会报错。不要为此打开 `fielddata`：它把词项加载进 JVM 堆，大索引上很容易触发熔断甚至 OOM，正确做法是聚合 `name.keyword`
- `terms` 聚合在多分片上是近似结果（每个分片取 Top N 再合并），对精度敏感时调大 `shard_size`
- 高基数字段要翻页遍历所有桶时用 `composite` 聚合，不要把 `terms.size` 设成几十万
- `cardinality`（去重计数）基于 HyperLogLog++，是近似值，误差随 `precision_threshold` 调整

只要聚合结果、不要命中文档时写 `"size": 0`，结果才能进入分片请求缓存。

---

## 三、深分页

`from + size` 每个分片都要返回 `from + size` 条结果（原理见 [Elasticsearch 原理](./5_search_es#_1、query-then-fetch)），默认不能超过 `index.max_result_window`（10000）。

| 方式 | 原理 | 适用 | 限制 |
|------|------|------|------|
| `from + size` | 每页重新查询并跳过前面的结果 | 前几十页的跳页 | 不超过 10000 条，越往后越慢 |
| `search_after` + PIT | 带上一页最后一条的排序值继续查，PIT 固定数据视图 | 无限滚动、深度翻页、导出 | 只能逐页往后翻，不能跳页 |
| `scroll` | 服务端保存一份搜索上下文快照 | 已有的离线导出任务 | 官方已不推荐用于深分页，改用 `search_after` + PIT |

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

- `search_after` 取上一页最后一条结果的 `sort` 值，`_shard_doc` 作为唯一的排序兜底字段，保证不重不漏
- 使用 PIT 时请求路径不带索引名，索引已经绑定在 PIT 上；用完调用 `DELETE /_pit` 及时释放，否则会占住旧段不被合并删除
- 产品上最简单有效的办法是限制可翻页数（如前 100 页），绝大多数用户不会翻到那里

---

## 四、索引生命周期

### 1、别名与零停机 reindex

改字段类型、换分词器都要新建索引重灌数据。业务始终通过别名访问，切换一次就完成：

![别名切换实现零停机 Reindex](../assets/database/es-alias-reindex.svg)

```http
POST /_reindex?wait_for_completion=false&slices=auto
{
  "source": { "index": "products_v1" },
  "dest":   { "index": "products_v2", "version_type": "external" }
}

GET /_tasks/<上一步返回的 task id>

POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}
```

- `_reindex` 异步执行并按分片切片并行，进度用 `_tasks` 查看；导入期间对新索引关闭 refresh、副本数设 0，导完再恢复
- `_aliases` 里的多个动作是原子的，不存在「别名指向空」的瞬间
- 关键是**重建期间的增量变更不能丢**：先启动写新索引的增量同步，再做全量导入，靠外部版本号让旧数据不覆盖新数据。完整的商品索引重建流程见 [搜索](/scenario/9_search_system#_3、零停机重建索引)

### 2、滚动索引与 ILM

日志、监控、埋点这类时间序列数据不断追加、按时间删除，不应写进一个越来越大的索引。用**数据流（Data Stream）+ ILM（Index Lifecycle Management）**按大小或时间自动滚动：

```http
PUT /_ilm/policy/logs-policy
{
  "policy": {
    "phases": {
      "hot":    { "actions": { "rollover": { "max_primary_shard_size": "50gb", "max_age": "1d" } } },
      "warm":   { "min_age": "7d",  "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "delete": { "min_age": "30d", "actions": { "delete": {} } }
    }
  }
}
```

- **rollover**：当前写索引达到大小或时间阈值后，自动建新的后备索引并切换写入，分片大小始终受控
- **warm / cold**：旧索引缩分片、合并段，迁到便宜的节点
- **delete**：过期整索引删除，比 `delete_by_query` 逐条删高效得多
- 索引模板中引用该策略，数据流新建的后备索引会自动套用
- OpenSearch 不支持 ILM，对应功能叫 **ISM（Index State Management）**，策略写法不同，迁移时需要改写

### 3、调整主分片数

主分片数创建后不能直接修改，但不一定要 Reindex：

- `_split`：拆成更多主分片，目标数必须是原分片数的倍数，源索引需先设为只读
- `_shrink`：缩成更少主分片，目标数必须是原分片数的因数，源索引需只读且所有分片副本集中在同一节点
- 其他情况（如改字段类型）才需要 Reindex

```http
PUT /logs-old/_settings
{ "index.blocks.write": true }

POST /logs-old/_split/logs-new
{ "settings": { "index.number_of_shards": 6 } }
```

---

## 五、与 MySQL 同步

原则是「业务库作为事实源，ES 作为查询侧投影」：

| 方案 | 做法 | 问题 |
|------|------|------|
| 业务双写 | 写完 MySQL 在代码里同步写 ES | 一边失败就不一致，业务代码耦合，不推荐 |
| 定时扫描 | 按 `updated_at` 增量拉取 | 分钟级延迟，物理删除扫不到 |
| MQ 事件 | 业务提交后发事件，消费者写 ES | 要用 Outbox（本地消息表）保证事件不丢 |
| CDC | Canal / Debezium 订阅 binlog 发到 MQ | 与业务解耦、不漏改，推荐 |

不管哪种方案，消费端都要处理三件事：

- **顺序**：同一实体的变更按 ID 分区发送，保证同一文档的事件按序消费
- **乱序与重复**：写 ES 时用行上的版本号作为外部版本号（`version_type: external`），旧版本写入会被拒绝（409），直接忽略
- **可观测**：监控同步延迟、失败重试、死信，并定期与主库对账

CDC 工具的部署与选型见 [CDC 工具](/database/5_practice/0_cdc_tools)，多表关联成宽文档见 [Flink CDC](/flink/6_cdc)，商品搜索里完整的同步消费者代码见 [搜索](/scenario/9_search_system#五、数据同步-mysql-→-es)。

---

## 六、性能调优

### 1、写入

- **批量写**：用 `_bulk`，单批 5~15MB 为宜，多线程并发发送；遇到 429（队列满）要退避重试
- **调大 refresh 间隔**：实时性要求不高的索引把 `refresh_interval` 调到 `30s`，大批量导入时设为 `-1`
- **导入时去掉副本**：副本数设 0，导完再恢复，副本会从主分片整体复制，比逐条同步快
- **用自动生成 ID**：自己指定 `_id` 时，ES 要先查一下该 ID 是否已存在；没有更新需求的日志类数据让 ES 生成 ID 更快
- **Translog 异步**：`durability: async` 能明显提升吞吐，但要接受宕机丢最近几秒数据

```http
PUT /my_index/_settings
{ "index": { "refresh_interval": "-1", "number_of_replicas": 0 } }

PUT /my_index/_settings
{ "index": { "refresh_interval": "1s", "number_of_replicas": 1 } }
```

### 2、查询

- **条件进 filter**：不打分、能缓存，见上文
- **自定义 routing**：按租户或用户 ID 指定 `routing`，写入和查询都只落到一个分片，避免广播；代价是大租户会形成热点分片
- **避免前缀通配符**：`*phone` 要遍历整个词典，非常慢。后缀匹配可以存一份反转的字段，任意子串匹配用 `ngram` 分词或 `wildcard` 字段类型
- **少用脚本**：`script` 查询和脚本排序逐文档执行，能在写入时算好的值就提前存成字段
- **只取需要的字段**：用 `_source` 过滤或 `fields`，大字段不要整篇返回
- **定位慢在哪**：给查询加 `"profile": true`，看每个子查询、每个分片的耗时

### 3、JVM 与分片

- JVM 堆一般不超过物理内存的一半且低于约 31GB（保持指针压缩），剩下的内存留给操作系统页缓存，Lucene 的段文件靠它加速
- 分片数宁少勿多：每个分片都有固定的堆开销，大量几百 MB 的小分片比少量几十 GB 的分片更伤集群

---

## 七、Java 客户端

官方客户端是 Elasticsearch Java API Client（`co.elastic.clients:elasticsearch-java`），版本号与 ES 主版本对齐；旧的 `RestHighLevelClient` 在 7.15 废弃，8.x 起不再提供。

```java
try (ElasticsearchClient client = ElasticsearchClient.of(b -> b
        .host("https://localhost:9200")
        .apiKey(apiKey))) {

    // 批量写入
    BulkRequest.Builder br = new BulkRequest.Builder();
    for (Product p : products) {
        br.operations(op -> op.index(i -> i
                .index("products")
                .id(String.valueOf(p.id()))
                .document(p)));
    }
    BulkResponse bulk = client.bulk(br.build());
    if (bulk.errors()) {
        bulk.items().stream()
            .filter(item -> item.error() != null)
            .forEach(item -> log.warn("bulk 失败 id={} reason={}", item.id(), item.error().reason()));
    }

    // 关键词 + 过滤条件查询
    SearchResponse<Product> resp = client.search(s -> s
            .index("products")
            .query(q -> q.bool(bq -> bq
                    .must(m -> m.match(t -> t.field("name").query(keyword)))
                    .filter(f -> f.term(t -> t.field("status").value("active")))
                    .filter(f -> f.range(r -> r.number(n -> n.field("price").gte(10.0).lte(200.0))))))
            .size(10),
        Product.class);

    resp.hits().hits().forEach(hit -> System.out.println(hit.score() + " " + hit.source()));
}
```

- 请求与响应都是强类型的，`document` 和返回的 `source` 默认用 Jackson 序列化
- `_bulk` 部分失败不会抛异常，必须检查 `errors()` 并逐条处理
- 客户端线程安全，应用里做成单例复用，不要每次请求新建

Spring 项目可以用 Spring Data Elasticsearch：`ElasticsearchOperations` 做模板式调用，`ElasticsearchRepository` 按方法名派生查询，适合简单 CRUD；复杂 DSL 仍建议直接用上面的客户端。版本对应与配置见 [中间件集成](/spring-boot/6_middleware)，完整的搜索服务代码见 [搜索](/scenario/9_search_system#四、搜索查询)。

---

## 八、常见故障

### 1、集群 red 与 yellow

```http
GET /_cluster/health

GET /_cat/shards?v&h=index,shard,prirep,state,unassigned.reason&s=state

GET /_cluster/allocation/explain
```

| 状态 | 含义 | 常见原因 |
|------|------|---------|
| yellow | 主分片都在，有副本未分配 | 单节点集群却配了副本；节点刚重启、副本恢复中；磁盘超过 high 水位 |
| red | 有主分片未分配，对应数据不可读写 | 持有主分片的节点宕机且没有副本；磁盘损坏；分配规则冲突 |

- `_cluster/allocation/explain` 会直接说明某个分片为什么分配不了，先看它再动手
- 磁盘到 95% 被加了只读块后，清理空间后 ES 会自动解除；早期版本需要手工删除 `index.blocks.read_only_allow_delete`
- 副本数 0 的索引一旦丢节点就是 red，生产索引至少 1 个副本

### 2、Mapping 爆炸

症状是集群状态越来越大、主节点 CPU 和内存吃紧、写入变慢，根因通常是把动态 key（用户 ID、属性名、URL 参数）当字段名写入：

- 单索引字段数默认上限 1000（`index.mapping.total_fields.limit`），触顶后写入报错。不要简单调大上限，要改数据结构
- 改成 `dynamic: strict` 或 `false`，阻止新字段自动进入 Mapping
- 任意键值对用 `flattened` 类型整体存为一个字段，或改成 `[{ "key": "...", "value": "..." }]` 的 nested 结构

### 3、慢查询日志

```http
PUT /my_index/_settings
{
  "index.search.slowlog.threshold.query.warn": "5s",
  "index.search.slowlog.threshold.query.info": "2s",
  "index.search.slowlog.threshold.fetch.warn": "1s",
  "index.indexing.slowlog.threshold.index.warn": "5s"
}
```

- 慢日志按分片记录，query 阶段慢通常是查询本身（通配符、正则、大范围聚合），fetch 阶段慢通常是 `_source` 太大或高亮太重
- 拿到慢查询后用 `profile` 拆解耗时，再对照上文调优项逐个排查
- 常见元凶：前缀通配符、深分页、高基数 `terms` 聚合、`script` 查询

---

## 小结

- Mapping 用 multi-field 兼顾全文与精确匹配，标识类数字用 `keyword`；生产索引 `dynamic: strict`，用索引模板统一
- 对象数组默认被拍平会串号，能扁平化就扁平化，必要时用 `nested`
- 结构化条件放 `filter`（不打分、可缓存）；聚合走 doc_values，不要对 `text` 开 fielddata
- 深分页用 `search_after` + PIT，`scroll` 只留给已有的离线导出
- 业务只认别名，重建索引靠先开增量、再全量、最后原子切别名；时间序列数据用数据流 + ILM（OpenSearch 是 ISM）
- 同步以主库为准，优先 CDC，按 ID 分区保序，外部版本号防乱序
- 写入调优靠 bulk、调大 refresh、导入时去副本；查询调优靠 filter、routing、避免前缀通配符
- red 看主分片、yellow 看副本，先用 `allocation/explain` 找原因；Mapping 爆炸靠关动态映射和 `flattened`

## 参考资料

- Mapping 参数 dynamic：[https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dynamic](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dynamic)
- Nested 字段类型：[https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/nested](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/nested)
- 分页与 search_after：[https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)
- Index lifecycle management：[https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management](https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management)
- Split index API：[https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-indices-split](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-indices-split)
- 写入速度调优：[https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed)
- Elasticsearch Java API Client：[https://www.elastic.co/docs/reference/elasticsearch/clients/java](https://www.elastic.co/docs/reference/elasticsearch/clients/java)
- OpenSearch Index State Management：[https://docs.opensearch.org/latest/im-plugin/ism/index/](https://docs.opensearch.org/latest/im-plugin/ism/index/)

> 下一篇：[图数据库](./6_graph_db) —— 关系是一等公民：Neo4j、NebulaGraph 与图查询语言

# 搜索系统设计

> 搜索是电商、内容平台的核心功能，从简单的 MySQL LIKE 到 Elasticsearch 全文检索，涉及索引构建、相关性排序、数据同步等多个维度。

---

## 一、为什么不用 MySQL 做搜索

| 问题 | 说明 |
|------|------|
| LIKE 查询不走索引 | `WHERE title LIKE '%手机%'` 全表扫描，百万级数据慢到不可用 |
| 无相关性排序 | MySQL 无法按关键词匹配程度排序 |
| 无分词能力 | "苹果手机" 无法匹配 "手机 苹果" |
| 无高亮支持 | 需要自己处理关键词高亮 |

**结论**：搜索功能必须使用专用搜索引擎，Elasticsearch（ES）是 Java 生态首选。

---

## 二、Elasticsearch 核心概念

| 概念 | 对应 MySQL | 说明 |
|------|-----------|------|
| Index（索引） | Table（表） | 同类文档的集合 |
| Document（文档） | Row（行） | 一条数据，JSON 格式 |
| Field（字段） | Column（列） | 文档的属性 |
| Mapping（映射） | Schema（表结构） | 定义字段类型和分析器 |
| Shard（分片） | 分区 | 索引水平拆分，支持分布式 |
| Replica（副本） | 从库 | 主分片的副本，提高可用性 |

---

## 三、商品搜索设计

### 3.1 索引 Mapping 设计

```json
PUT /products
{
  "mappings": {
    "properties": {
      "id":          { "type": "long" },
      "title":       {
        "type": "text",
        "analyzer": "ik_max_word",      // 中文分词（IK 分词器）
        "search_analyzer": "ik_smart",  // 搜索时用智能分词
        "fields": {
          "keyword": { "type": "keyword" }  // 支持精确匹配和排序
        }
      },
      "description": { "type": "text", "analyzer": "ik_max_word" },
      "category_id": { "type": "integer" },
      "brand":       { "type": "keyword" },   // 精确匹配（品牌筛选）
      "price":       { "type": "double" },
      "sales_count": { "type": "long" },      // 销量（用于排序）
      "score":       { "type": "float" },     // 综合评分
      "tags":        { "type": "keyword" },   // 标签（数组）
      "status":      { "type": "integer" },   // 上下架状态
      "created_at":  { "type": "date" }
    }
  }
}
```

### 3.2 搜索查询实现

```java
// 组合查询：关键词 + 分类筛选 + 价格区间 + 品牌 + 排序
public SearchResult search(SearchRequest req) {
    BoolQueryBuilder boolQuery = QueryBuilders.boolQuery()
        // must：关键词匹配（影响相关性评分）
        .must(QueryBuilders.multiMatchQuery(req.getKeyword(), "title^3", "description")
              // title 权重 3 倍
        )
        // filter：条件过滤（不影响评分，性能更好）
        .filter(QueryBuilders.termQuery("status", 1)) // 只搜上架商品
        .filter(req.getCategoryId() != null
            ? QueryBuilders.termQuery("category_id", req.getCategoryId()) : null)
        .filter(req.getBrand() != null
            ? QueryBuilders.termQuery("brand", req.getBrand()) : null)
        .filter(QueryBuilders.rangeQuery("price")
            .gte(req.getMinPrice()).lte(req.getMaxPrice()));

    SearchSourceBuilder sourceBuilder = new SearchSourceBuilder()
        .query(boolQuery)
        .sort(buildSort(req.getSortField(), req.getSortOrder()))
        .highlighter(new HighlightBuilder()
            .field("title").preTags("<em>").postTags("</em>"))
        .from(req.getPage() * req.getSize())
        .size(req.getSize());

    SearchResponse response = client.search(
        new SearchRequest("products").source(sourceBuilder), RequestOptions.DEFAULT);
    return parseResponse(response);
}

private SortBuilder buildSort(String field, String order) {
    return switch (field) {
        case "price"  -> SortBuilders.fieldSort("price").order(SortOrder.fromString(order));
        case "sales"  -> SortBuilders.fieldSort("sales_count").order(SortOrder.DESC);
        default       -> SortBuilders.scoreSort(); // 默认按相关性
    };
}
```

---

## 四、数据同步（MySQL → ES）

### 4.1 方案对比

| 方案 | 原理 | 优缺点 |
|------|------|--------|
| 双写 | 写 MySQL 同时写 ES | 实时，但代码耦合，失败需补偿 |
| 定时同步 | 定时扫描更新时间，批量同步 | 简单，但有延迟（分钟级） |
| Canal 订阅 binlog | 监听 MySQL binlog，异步同步 | 实时，解耦，推荐 |
| MQ 驱动 | 业务写成功后发 MQ，消费端同步 ES | 实时，解耦，依赖 MQ 可靠性 |

### 4.2 Canal + MQ 方案（推荐）

```
MySQL binlog → Canal Server → MQ（Kafka/RocketMQ）→ ES Sync Consumer → ES
```

```java
// ES 同步消费者
@KafkaListener(topics = "mysql-product-changes")
public void syncToES(ConsumerRecord<String, String> record) {
    BinlogEvent event = JSON.parseObject(record.value(), BinlogEvent.class);

    switch (event.getType()) {
        case INSERT, UPDATE -> {
            Product product = productService.getById(event.getId());
            if (product != null && product.getStatus() == 1) {
                esProductService.upsert(product);
            } else {
                esProductService.delete(event.getId()); // 下架则从 ES 删除
            }
        }
        case DELETE -> esProductService.delete(event.getId());
    }
}
```

### 4.3 全量重建索引

上线或 Mapping 变更时需要全量重建：

```
1. 创建新索引 products_v2（新 Mapping）
2. 全量数据导入 products_v2（不影响线上）
3. 验证数据正确性
4. 切换别名：products → products_v2（原子操作）
5. 删除旧索引 products_v1
```

```bash
# ES 别名切换（原子）
POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}
```

---

## 五、搜索建议（Search Suggest）

### 5.1 前缀补全（Completion Suggester）

```json
// Mapping 中定义 completion 字段
"suggest": {
  "type": "completion",
  "analyzer": "ik_smart"
}

// 查询
POST /products/_search
{
  "suggest": {
    "product_suggest": {
      "prefix": "苹果",
      "completion": { "field": "suggest", "size": 10 }
    }
  }
}
```

### 5.2 搜索热词（基于历史搜索）

```java
// 用户搜索时，记录搜索词到 Redis ZSet（按搜索频次排序）
public void recordSearch(String keyword) {
    redisTemplate.opsForZSet().incrementScore("search:hot:words", keyword, 1);
}

// 获取热搜 Top 10
public List<String> getHotWords() {
    return redisTemplate.opsForZSet()
        .reverseRange("search:hot:words", 0, 9)
        .stream().map(Object::toString).collect(Collectors.toList());
}
```

---

## 六、相关性调优

### 6.1 权重调整

```java
// 标题权重高于描述
QueryBuilders.multiMatchQuery(keyword, "title^3", "description^1", "tags^2")
```

### 6.2 Function Score（综合评分）

将相关性评分与业务指标（销量、评分、时效性）结合：

```json
{
  "function_score": {
    "query": { "match": { "title": "手机" } },
    "functions": [
      {
        "field_value_factor": {
          "field": "sales_count",
          "factor": 0.1,
          "modifier": "log1p"  // log(1 + sales_count)，防止大值主导
        }
      },
      {
        "gauss": {
          "created_at": {
            "origin": "now",
            "scale": "30d",   // 30 天内的商品，距今越近分越高
            "decay": 0.5
          }
        }
      }
    ],
    "score_mode": "sum",    // 各 function 分数相加
    "boost_mode": "multiply" // 与 query 分数相乘
  }
}
```

---

## 七、性能优化

| 优化点 | 方案 |
|--------|------|
| 搜索结果缓存 | 热门搜索词结果缓存 Redis（TTL 5min） |
| 深分页 | 禁止跳页到 10000+，用 search_after 代替 from/size |
| 只返回需要字段 | `_source: ["id", "title", "price"]`，减少传输量 |
| Filter 优先 | Filter Context 结果可缓存，Query Context 不缓存 |
| 副本数 | 读多写少场景增加副本，提高读吞吐 |
| 索引按时间分片 | 日志/订单按月分索引，查询时指定时间范围索引 |

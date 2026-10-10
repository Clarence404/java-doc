---
description: MySQL 全文检索边界、商品 Mapping、Java API Client、CDC 同步、零停机重建、热词
---

# 搜索

> 前置阅读：[搜索数据库](/database/4_nosql/3_search_db)、[CDC 工具](/database/5_practice/0_cdc_tools)

商品搜索要先判断何时需要专用搜索引擎，再解决索引、查询、同步与相关性问题。本篇讲 Mapping 与组合查询、MySQL → ES 同步、零停机重建、相关性调优，基线为 Elasticsearch 9.x。

---

## 一、MySQL 全文检索够不够

示例使用官方 Java 客户端 `co.elastic.clients:elasticsearch-java` 9.x（旧的 `RestHighLevelClient` 在 7.15 废弃，8.x 起不再提供）。

| 能力 | MySQL | Elasticsearch |
|------|-------|---------------|
| `LIKE '%手机%'` | 前导通配符用不上 B+ 树索引，大表全表扫描 | — |
| 中文分词 | InnoDB `FULLTEXT` + 内置 ngram 解析器（5.7.6+），按固定长度切词，没有词典 | IK 等词典分词，可配同义词、自定义词库 |
| 相关性 | 自然语言模式下 `MATCH ... AGAINST` 返回相关度分数，但几乎不能调权 | BM25 + 字段权重 + function_score，可控 |
| 筛选与聚合 | 多条件筛选 + 分面统计要靠多次 SQL | filter 上下文可缓存，aggregation 一次算出分面 |
| 扩展 | 单表、与业务库争资源 | 分片 + 副本水平扩展 |

```sql
ALTER TABLE product ADD FULLTEXT INDEX ft_title (title) WITH PARSER ngram;

SELECT id, title, MATCH(title) AGAINST('苹果手机') AS score
FROM product
WHERE MATCH(title) AGAINST('苹果手机' IN NATURAL LANGUAGE MODE)
ORDER BY score DESC
LIMIT 20;
```

**结论**：数据量小、只需「能搜到」的后台检索，MySQL ngram 全文索引就够；面向用户的商品搜索需要分词质量、相关性可调、分面筛选和水平扩展，才值得引入 ES。

---

## 二、商品索引设计

业务始终通过别名 `products` 访问，物理索引带版本号（`products_v1`），方便后面零停机重建：

Elasticsearch 的概念、倒排索引、分析器、深分页、别名等机制见 [搜索数据库](/database/4_nosql/3_search_db)。

```http
PUT /products_v1
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id":          { "type": "long" },
      "title": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart",
        "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } }
      },
      "description": { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
      "category_id": { "type": "integer" },
      "brand":       { "type": "keyword" },
      "price":       { "type": "scaled_float", "scaling_factor": 100 },
      "sales_count": { "type": "long" },
      "rating":      { "type": "float" },
      "tags":        { "type": "keyword" },
      "status":      { "type": "byte" },
      "suggest":     { "type": "completion", "analyzer": "ik_smart" },
      "created_at":  { "type": "date" }
    }
  },
  "aliases": { "products": {} }
}
```

- **分词**：写入用 `ik_max_word` 切得细、召回高；搜索用 `ik_smart` 切得粗、更准。IK 是第三方插件（infinilabs/analysis-ik），插件版本必须与 ES 版本**完全一致**，升级 ES 时要同步升级插件
- **价格**：`scaled_float` + `scaling_factor: 100` 按「分」精确存储，避免 `double` 的精度问题；也可以直接存整数分
- **`dynamic: strict`**：写入未定义字段直接报错，防止脏字段让 Mapping 膨胀
- **`status`**：下架只更新状态、查询时过滤，不删文档，避免同步链路里「删除」与「更新」乱序

---

## 三、搜索查询

请求 DTO 不要命名为 `SearchRequest`，会和客户端的同名类冲突：

```java
public record ProductSearchQuery(String keyword, Integer categoryId, String brand,
                                 BigDecimal minPrice, BigDecimal maxPrice,
                                 String sort, int page, int size) {}

@Service
@RequiredArgsConstructor
public class ProductSearchService {

    private final ElasticsearchClient client;      // Spring Boot 根据 spring.elasticsearch.* 自动配置

    public SearchResponse<ProductDoc> search(ProductSearchQuery q) throws IOException {
        // filter：只做过滤、不参与打分，结果可缓存；条件为空时不要加，null 子句会直接报错
        List<Query> filters = new ArrayList<>();
        filters.add(Query.of(f -> f.term(t -> t.field("status").value(1))));
        if (q.categoryId() != null) {
            filters.add(Query.of(f -> f.term(t -> t.field("category_id").value(q.categoryId()))));
        }
        if (q.brand() != null) {
            filters.add(Query.of(f -> f.term(t -> t.field("brand").value(q.brand()))));
        }
        if (q.minPrice() != null || q.maxPrice() != null) {
            filters.add(Query.of(f -> f.range(r -> r.number(n -> {
                n.field("price");
                if (q.minPrice() != null) n.gte(q.minPrice().doubleValue());
                if (q.maxPrice() != null) n.lte(q.maxPrice().doubleValue());
                return n;
            }))));
        }

        Query must = StringUtils.hasText(q.keyword())
                ? Query.of(m -> m.multiMatch(mm -> mm.query(q.keyword()).fields("title^3", "tags^2", "description")))
                : Query.of(m -> m.matchAll(a -> a));

        int size = Math.min(q.size(), 50);
        int from = q.page() * size;
        if (from + size > 10_000) {
            throw new BizException("请缩小筛选范围");   // 深分页另行处理，见第七节
        }

        return client.search(s -> s
                        .index("products")
                        .query(qq -> qq.bool(b -> b.must(must).filter(filters)))
                        .sort(sortOf(q.sort()))
                        .highlight(h -> h.fields(NamedValue.of("title",
                                HighlightField.of(hf -> hf.preTags("<em>").postTags("</em>")))))
                        .source(src -> src.filter(sf -> sf.includes("id", "title", "price", "brand", "sales_count")))
                        .from(from)
                        .size(size),
                ProductDoc.class);
    }

    private List<SortOptions> sortOf(String sort) {
        return switch (sort == null ? "" : sort) {
            case "price_asc"  -> List.of(SortOptions.of(o -> o.field(f -> f.field("price").order(SortOrder.Asc))));
            case "price_desc" -> List.of(SortOptions.of(o -> o.field(f -> f.field("price").order(SortOrder.Desc))));
            case "sales"      -> List.of(SortOptions.of(o -> o.field(f -> f.field("sales_count").order(SortOrder.Desc))));
            default           -> List.of(SortOptions.of(o -> o.score(sc -> sc.order(SortOrder.Desc))));   // 相关性
        };
    }
}
```

- 关键词放 `must`（参与打分），筛选条件放 `filter`（不打分、可缓存）
- Java 客户端 9.1 起 `Highlight.fields` 改为 `NamedValue` 列表，9.0 及 8.x 用 `fields("title", f -> ...)` 的 Map 写法
- 只取列表页需要的字段，详情页再按 ID 查数据库或缓存

---

## 四、数据同步（MySQL → ES）

### 1、方案对比

| 方案 | 原理 | 问题 |
|------|------|------|
| 业务双写 | 写 MySQL 后同步写 ES | 代码耦合；ES 写失败或进程崩溃就不一致，需要补偿 |
| 定时扫描 | 按 `updated_at` 增量拉取 | 分钟级延迟；物理删除扫不到 |
| CDC 订阅 binlog | Canal / Debezium 捕获变更发到 MQ | 推荐：与业务解耦、近实时，不漏改 |
| 业务发事件 | 业务提交后发 MQ | 要用本地消息表保证不丢，见 [消息队列基础](/messaging/1_basics) |

### 2、CDC + MQ 链路

![MySQL → ES 同步链路](../assets/scenario/search-sync.svg)

消费端的三个要点：

- **按商品 ID 分区**：同一商品的变更进同一个分区，按顺序消费
- **回查数据库**：事件只当作「这个商品变了」的通知，消费时按 ID 读最新的行再组装文档。商品文档往往要关联类目、品牌、库存等多张表，回查也避免了用事件里的旧值覆盖新值
- **外部版本号**：用行上的 `version`（或毫秒级 `updated_at`）作为 ES 的外部版本号写入，重放、重试、全量导入与增量交错时，旧版本的写入会被 ES 拒绝（409），直接忽略即可

```java
@KafkaListener(topics = "cdc.shop.product", groupId = "es-sync-products-v1")
public void onChange(ConsumerRecord<String, String> record) throws IOException {
    long productId = CdcKeys.productId(record.key());       // 解析 Debezium 的主键 key
    Product p = productMapper.selectById(productId);
    if (p == null) {
        client.delete(d -> d.index("products").id(String.valueOf(productId)));   // 物理删除（少见）
        return;
    }
    try {
        client.index(i -> i.index("products")
                .id(String.valueOf(p.getId()))
                .version(p.getVersion())
                .versionType(VersionType.External)
                .document(ProductDoc.from(p)));
    } catch (ElasticsearchException e) {
        if (e.status() != 409) throw e;                     // 409：ES 里已是更新的版本，忽略
    }
}
```

抛出的其他异常交给 Spring Kafka 的错误处理器重试，多次失败进入死信 Topic 并告警。CDC 工具的部署与选型见 [CDC 工具](/database/5_practice/0_cdc_tools)，用 Flink CDC 做多表宽表见 [Flink CDC](/flink/6_cdc)。

### 3、零停机重建索引

Mapping 改字段类型、换分词器时必须重建。关键是**重建期间的增量变更不能丢**：

1. 创建 `products_v2`（新 Mapping），导入期间关闭刷新、不建副本：

   ```http
   PUT /products_v2/_settings
   { "index": { "refresh_interval": "-1", "number_of_replicas": 0 } }
   ```

2. **先**启动一个新的消费组（如 `es-sync-products-v2`）从当前位点消费 CDC 事件，直接写 `products_v2`，相当于对新索引双写
3. **再**从 MySQL 按主键分批全量导入 `products_v2`，同样带外部版本号。导入与增量谁先谁后都不要紧，旧版本会被拒绝
4. 恢复 `refresh_interval` 和副本数，等集群变绿，比对文档数、抽样比对内容
5. 原子切换别名 `products` 到 `products_v2`（`_aliases` 请求见 [搜索数据库](/database/4_nosql/3_search_db)），停掉 v1 消费组
6. `products_v1` 保留一段时间用于回滚，确认无误后删除

---

## 五、搜索建议与热词

### 1、前缀补全

用 Mapping 中的 `completion` 字段（`suggest`），同步时把标题、品牌等写进去：

```http
POST /products/_search
{
  "_source": false,
  "suggest": {
    "product_suggest": {
      "prefix": "苹果",
      "completion": { "field": "suggest", "size": 10, "skip_duplicates": true }
    }
  }
}
```

### 2、热搜词

一个不过期的大 ZSet 会无限增长，也没有时间衰减。按小时分桶，再定时合并成滑动窗口：

```java
private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
private static final DateTimeFormatter HOUR = DateTimeFormatter.ofPattern("yyyyMMddHH");

public void record(String rawKeyword) {
    String kw = KeywordNormalizer.normalize(rawKeyword);     // 去空格、转小写、全角转半角、截断长度
    if (kw.isEmpty()) return;
    String key = "search:hot:{h}:" + LocalDateTime.now(ZONE).format(HOUR);   // {h} 哈希标签：Cluster 下才能 ZUNIONSTORE
    redis.opsForZSet().incrementScore(key, kw, 1);
    redis.expire(key, Duration.ofHours(26));
}

// 每分钟由分布式调度执行一次：近 24 小时按时间衰减加权合并
public void rebuildHotWords() {
    LocalDateTime now = LocalDateTime.now(ZONE);
    List<String> keys = new ArrayList<>();
    List<Double> weights = new ArrayList<>();
    for (int i = 0; i < 24; i++) {
        keys.add("search:hot:{h}:" + now.minusHours(i).format(HOUR));
        weights.add(Math.pow(0.9, i));                        // 越久远权重越低
    }
    redis.opsForZSet().unionAndStore(keys.get(0), keys.subList(1, keys.size()), "search:hot:{h}:24h",
            Aggregate.SUM, Weights.of(weights.stream().mapToDouble(Double::doubleValue).toArray()));
    redis.opsForZSet().removeRange("search:hot:{h}:24h", 0, -1001);   // 只保留前 1000
}
```

- 展示前过敏感词过滤，并支持运营人工置顶、屏蔽
- 防刷：同一用户同一时段对同一个词只计一次（可用 `SET NX EX` 标记）
- 热搜 key 本身是读热点，前面加本地缓存，见 [热点问题](/high-con/6_hotspot)

---

## 六、相关性调优

### 1、字段权重

`multi_match` 的 `fields` 里用 `^` 指定权重，如 `title^3`、`tags^2`、`description`：标题命中比描述命中更相关。

### 2、Function Score：融合业务指标

```http
POST /products/_search
{
  "query": {
    "function_score": {
      "query": { "match": { "title": "手机" } },
      "functions": [
        { "field_value_factor": { "field": "sales_count", "factor": 0.1, "modifier": "log1p", "missing": 0 } },
        { "gauss": { "created_at": { "origin": "now", "scale": "30d", "decay": 0.5 } } }
      ],
      "score_mode": "sum",
      "boost_mode": "multiply"
    }
  }
}
```

- `field_value_factor`：先乘 `factor` 再套 `modifier`，`log1p` 是 `log10(1 + factor × value)`（以 10 为底），压低销量极大值的影响
- `gauss`：越接近 `origin` 分越高，距今 30 天时衰减到 0.5
- `score_mode` 决定各函数分数如何合并，`boost_mode` 决定它与查询分数如何合并
- 调优要靠数据：用一组标注过的查询做离线评估（ES 的 Ranking Evaluation API），再小流量 A/B 验证点击率与转化

---

## 七、性能优化

| 优化点 | 方案 |
|--------|------|
| 结果缓存 | 热门查询的首页结果缓存 1 到 5 分钟，结合本地缓存挡读热点 |
| 深分页 | 用户翻页限制在前 100 页左右；导出、无限滚动用 `search_after` + PIT，见 [搜索数据库](/database/4_nosql/3_search_db) |
| 只取需要的字段 | `_source` includes，列表页不返回大字段 |
| Filter 优先 | 不需要打分的条件放 filter 上下文 |
| 副本 | 读多写少时增加副本提升读吞吐 |
| 写入 | 同步链路用 bulk 批量写；全量导入时关闭刷新、暂不建副本 |

---

## 小结

- MySQL ngram 全文索引能分词、能给相关度，但分词质量、可调相关性、分面和扩展性不足，面向用户的商品搜索用 ES
- 索引带版本号、业务走别名；价格用 `scaled_float` 或整数分；IK 插件版本与 ES 严格一致
- 查询用官方 Java API Client：关键词进 `must`、条件进 `filter`，空条件不加
- 同步走 CDC + MQ：按商品 ID 分区、回查数据库、外部版本号防乱序；下架只改状态
- 重建索引先起新消费组写新索引，再全量导入，验证后原子切别名
- 热搜按小时分桶 + 加权合并做滑动窗口，Cluster 下用哈希标签

## 参考资料

- Elasticsearch Java 客户端：[https://www.elastic.co/docs/reference/elasticsearch/clients/java](https://www.elastic.co/docs/reference/elasticsearch/clients/java)
- MySQL ngram 全文解析器：[https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)
- MySQL 自然语言全文检索：[https://dev.mysql.com/doc/refman/8.4/en/fulltext-natural-language.html](https://dev.mysql.com/doc/refman/8.4/en/fulltext-natural-language.html)
- 数值类型（含 scaled_float）：[https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/number](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/number)
- Index API（外部版本号）：[https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-index](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-index)
- 别名：[https://www.elastic.co/docs/manage-data/data-store/aliases](https://www.elastic.co/docs/manage-data/data-store/aliases)
- Completion 字段：[https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/completion](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/completion)
- Function score query：[https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query)
- ZUNIONSTORE：[https://redis.io/docs/latest/commands/zunionstore/](https://redis.io/docs/latest/commands/zunionstore/)
- IK 分词插件：[https://github.com/infinilabs/analysis-ik](https://github.com/infinilabs/analysis-ik)

> 下一篇：[大文件上传](./10_file_upload) —— 分片直传、断点续传、秒传校验与对象存储选型。

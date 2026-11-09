---
description: 切块与重叠、元数据与确定性 ID、哈希增量入库、bge-m3 与 nomic 对比、memory 与 pgvector
---

# 知识入库

> 前置阅读：[工具调用](./3_tool_calling)、[Embedding 向量化](../4_core_tech/0_embedding)、[向量数据库](../4_core_tech/1_vector_db)

第 4 章把商城规则文档变成可以按意思检索的知识库，为第 5 章 RAG 做准备。本篇讲切块、元数据与增量入库、向量模型的选择、memory 与 pgvector 两种向量库，以及 Spring AI 2.0.2 里踩到的坑，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、本章做什么

客服要能回答「七天无理由退货要什么条件」「发票什么时候能开」这类**规则问题**，答案不在商城接口里，而在规则文档里。本章只做入库与检索调试，不接进对话；第 5 章再把检索结果交给模型回答。

![第 4 章的入库流水线](../../assets/ai/mall-assistant-ingest-flow.svg)

本章新增的类都在 `knowledge` 包下：

| 类 | 职责 |
|----|------|
| `MarkdownKnowledgeReader` / `KnowledgeDocument` | 读 `knowledge/*.md`，拆出 front matter（标题、版本、更新日期）和正文 |
| `MarkdownChunker` / `KnowledgeChunk` | 先按标题分节，超长的节再按长度切块，相邻两块重叠 |
| `ChunkDocumentFactory` / `ChunkMetadata` | 每块变成 Spring AI 的 `Document`：文字带标题路径、确定性 UUID、十个元数据；算文档的内容哈希 |
| `IngestPlanner` / `IngestPlan` | 比对磁盘上的文档和库里的汇总，分成新增 / 更新 / 跳过 / 删除 |
| `KnowledgeIngestionService` / `IngestReport` | 按计划写库，检查库里是不是别的模型生成的，出入库报告 |
| `KnowledgeSearchService` / `KnowledgeHit` | 相似度检索（只检索、不回答）与知识库概况 |
| `KnowledgeEmbedding` / `PrefixedEmbeddingModel` | 当前向量模型：模型名、维度探测、表名后缀；按模型加查询 / 文档前缀 |
| `KnowledgeStore` 与 `MemoryKnowledgeStore`、`PgVectorKnowledgeStore`、`PgVectorConfig` | 两种向量库：memory（默认）与 pgvector |
| `KnowledgeController` / `KnowledgeStartupIngest` | `POST /api/knowledge/ingest`、`GET /api/knowledge/search`、`GET /api/knowledge/stats`；启动时自动入库一次 |

页面最下面多了「知识库」调试区：概况一行（库类型、模型、维度、文档数 / 块数），输入问题点「检索」看命中哪些块和分数，「入库」再跑一次增量，勾上「清空重建」就全部重来。

---

## 二、知识文档

`src/main/resources/knowledge/` 下 6 篇虚构的「示例商城」规则：退换货、配送与运费、支付与发票、积分与会员、售后与投诉、账户安全。内容具体到天数、金额和例外情况，这样检索对不对一眼能看出来：

```markdown
---
title: 退换货规则
version: 2026.10
updated: 2026-10-15
---

# 退换货规则

## 七天无理由退货

### 适用条件

自签收次日起 7 天内（含第 7 天），可以申请无理由退货，需同时满足以下条件：
```

- **front matter 记版本**：`title` 是标题路径的第一级，`version`、`updated` 写进每块的元数据，第 5 章引用来源时能说清「依据哪一版规则」
- **自己解析而不用 `MarkdownDocumentReader`**：Spring AI 自带的读取器只记住当前这一级标题，拿不到「退换货规则 > 七天无理由退货 > 适用条件」这样的完整路径，也不认 front matter；规则文档结构简单，自己解析几十行就够
- **只认最简单的写法**：front matter 一行一个 `键: 值`，标题只认行首 1～6 个 `#`，不处理代码块和表格，对本项目的文档够用

---

## 三、切块：先按标题，再按长度

```java
public List<String> split(String text) {
    String t = text.strip();
    if (t.length() <= maxChars) {
        return t.isEmpty() ? List.of() : List.of(t);
    }
    List<String> pieces = new ArrayList<>();
    int start = 0;
    while (start < t.length()) {
        int end = Math.min(start + maxChars, t.length());
        if (end < t.length()) {
            int cut = lastBoundary(t, start + maxChars / 2, end);   // 在后半段从后往前找句末标点
            if (cut > 0) {
                end = cut;
            }
        }
        pieces.add(t.substring(start, end).strip());
        if (end >= t.length()) {
            break;
        }
        start = Math.max(end - overlap, start + 1);                // 往回退 overlap 个字，至少前进 1
    }
    return pieces;
}
```

- **按标题分节**：规则文档天然按标题组织，一节讲一件事，按节切最符合语义，块的边界不会把两件事搅在一起
- **超长的节再按长度切**：`max-chars: 300`、`overlap: 50`。节太长时向量会把好几件事平均掉，检索不准；太短又丢了上下文。本项目的规则一节一两百字，大多一节一块，6 篇切成 38 块
- **尽量在句末断开**：在 `[start + maxChars/2, end)` 里往回找 `。！？；` 和换行，找到就断在标点之后；只看后半段，避免一块切得太短
- **重叠**：按长度硬切时句子可能被切断，相邻两块重叠 50 字，跨边界的内容在两块里都完整出现；「至少前进 1」防止 overlap 很大时死循环
- **切块参数写进签名**：`signature()` 返回 `md-v1:300:50`，算进文档的内容哈希，改了参数再入库会全部重切

切块大小、重叠与其他切块策略的取舍见 [RAG 检索增强生成 · 文档切块](../4_core_tech/2_rag#三、文档切块)。

---

## 四、元数据与确定性 ID

```java
String text = chunk.headingPath() + "\n" + chunk.body();
Map<String, Object> metadata = new LinkedHashMap<>();
metadata.put(ChunkMetadata.SOURCE, document.source());
metadata.put(ChunkMetadata.HEADING_PATH, chunk.headingPath());
metadata.put(ChunkMetadata.CHUNK_INDEX, chunk.index());
metadata.put(ChunkMetadata.DOC_HASH, docHash);
metadata.put(ChunkMetadata.EMBEDDING_MODEL, embeddingModel);
// 另有 title、chunkCount、chunkHash、docVersion、docUpdated，共十个
String id = UUID.nameUUIDFromBytes(
                (document.source() + "#" + chunk.index() + "#" + docHash).getBytes(StandardCharsets.UTF_8))
        .toString();
documents.add(Document.builder().id(id).text(text).metadata(metadata).build());
```

- **块文字带上标题路径**：切开的段落常常丢了主语（「需同时满足以下条件」），带上「退换货规则 > 七天无理由退货 > 适用条件」，向量里才有「退货」「七天无理由」的意思。`EmbeddingModel#getEmbeddingContent` 默认只取 `getText()`，元数据不会拼进向量化的文字，所以必须自己写进去
- **确定性 ID**：「来源 + 序号 + 文档哈希」算出的 UUID，同样的内容每次得到同样的 ID，重复写入只会覆盖、不会多一份；用 `randomUUID` 的话每入库一次就多一份。pgvector 的 id 列是 uuid 类型，必须是 UUID 格式
- **元数据各有用处**：`source` 用来按文档删除和汇总，`docHash` 判断增量，`embeddingModel` 发现「库里是别的模型生成的」，`headingPath`、`docVersion` 留给第 5 章标注引用来源

---

## 五、内容哈希做增量

```java
public String docHash(KnowledgeDocument document) {
    return sha256(chunker.signature() + "\n" + documentPrefix + "\n" + document.raw());
}
```

调向量模型是入库里最慢、用云端模型时最花钱的一步，文档没变就不该重新向量化。`IngestPlanner` 按 source 比对磁盘上的文档和库里的汇总：

| 情况 | 归类 | 怎么处理 |
|------|------|---------|
| 磁盘上有、库里没有 | 新增 | 切块后 `add` |
| 两边都有、哈希不同 | 更新 | 先按 source 删掉旧块，再 `add` 新块 |
| 两边都有、哈希相同 | 跳过 | 什么都不做，不调模型 |
| 库里有、磁盘上没有 | 删除 | 按 source 删除 |

- **哈希比修改时间可靠**：git checkout、复制文件都会改修改时间，内容没变哈希就不变；哈希里还算上切块签名和文档前缀，改了切法或换了前缀，原文没变也会重切
- **更新不能只 `add`**：新版本切出的块可能比旧版少，按 ID 覆盖会留下多出来的旧块，所以先 `delete(bySource(...))`。过滤表达式与向量库无关，pgvector 会翻译成 jsonpath 查询
- **全部跳过时不碰向量库**：取向量库要探测维度、会去连模型；重启后文档都没变，模型没启动也能「入库成功」
- **中途失败也不怕**：删了旧块、写新块时模型挂了，库里这篇文档的块不全，下次入库哈希对不上会重写一遍；方法加了 `synchronized`，防止启动时的自动入库和手动入库交错、互相删对方刚写的块

第一次启动日志是「新增 6 篇，写入 38 块」，再次入库全部跳过、毫秒级完成。

---

## 六、向量模型：bge-m3 与 nomic-embed-text

默认用 Ollama 的 `bge-m3`，可选 `nomic-embed-text`，用环境变量 `OLLAMA_EMBEDDING_MODEL` 切换：

| | bge-m3 | nomic-embed-text |
|---|---|---|
| 维度 | 1024 | 768 |
| 体积 | 约 1.2 GB | 约 270 MB |
| 语言 | 多语言，中文好 | 以英文为主 |
| 前缀 | 不需要 | 查询加 `search_query: `，文档加 `search_document: ` |

- **维度不写死**：`dimensions: 0` 表示第一次用到时调一次模型看向量多长（Spring AI 的模型类会缓存），也可以配置成固定值；不在启动时探测，模型没启动会拖慢启动，而知识库只是辅助功能
- **前缀按模型配置**：nomic 训练时约定用前缀区分「问题」和「被检索的文档」，不加效果明显变差。前缀写在 `assistant.knowledge.model-profiles`，按模型名前缀匹配，只在调模型时加，不存进库里
- **前缀靠调用的方法区分**：`PrefixedEmbeddingModel` 包住真正的模型，覆盖 `embed(String)` 加查询前缀，覆盖 `embed(Document)` 与 `getEmbeddingContent(Document)` 加文档前缀。检索时两种库都调 `embed(String)`；入库时 SimpleVectorStore 逐块调 `embed(Document)`，PgVectorStore 批量入库走 `getEmbeddingContent`
- **别把文档加成查询前缀**：`embed(Document)` 里要调 `delegate.embed(...)`，调到自己的 `embed(String)` 会再加一次查询前缀

本机实测（仅 CPU 的 Ollama，6 篇文档 38 块，`topK=3`，memory 与 pgvector 的结果和分数完全一致）：

| 问题 | bge-m3 | nomic-embed-text |
|------|--------|------------------|
| 首次入库耗时 | 约 10 秒 | 约 6 秒 |
| 七天无理由退货要什么条件 | ① 适用条件 0.81 | ① 适用条件 0.75 |
| 发票什么时候能开 | ① 发票 > 开票时间 0.77 | ① 配送 > 签收与查件（错），开票时间不在前三 |
| 积分多久过期 | ① 积分有效期 0.81 | ① 会员权益（错），积分有效期不在前三 |
| 被骗了说要我提供验证码 | ① 账户安全 > 防诈骗提醒 0.70 | ① 售后 > 申请售后（错） |
| 东西坏了能退吗 | 前三都在退换货规则，但「质量问题退换货」没进前三 | 前三分散在发票、配送、退款时效 |

- **中文规则用 bge-m3**：四个问题全对；nomic 只有字面重合度高的「七天无理由」找对了，其余三条中文问题都错
- **分数只能在同一个模型内比较**：nomic 的 0.75 不比 bge-m3 的 0.81「差」，两个模型的分数分布不同；最高分只有 0.8 左右也正常，「意思相近」不等于「向量相同」
- **口语化问题两个都没找到**：「东西坏了能退吗」和原文用词差得远，bge-m3 也只找到了大方向。多召回几块、改写问题、加关键词检索，留给第 5 章

模型选型与相似度的原理见 [Embedding 向量化 · 模型怎么选](../4_core_tech/0_embedding#二、模型怎么选)。

---

## 七、换模型就要重建

不同模型的向量不在同一个「坐标系」里：bge-m3 的第 1 维和 nomic 的第 1 维含义完全不同，维度也不一样，pgvector 的 `vector(1024)` 列根本放不下 768 维的向量。

- **每个模型一张表 / 一个文件**：表名按模型生成（`knowledge_chunk_bge_m3`、`knowledge_chunk_nomic_embed_text`），内存版的 JSON 文件同理。换模型后第一次启动自动入库到新表，旧模型的数据原样留着，来回切换对比效果时不用每次重建
- **混用时报 409**：手动把两个模型指到同一张表（`assistant.knowledge.pgvector.table`）时，入库和检索会发现维度或元数据里的模型名对不上，返回 `INDEX_MODEL_MISMATCH`，提示 `POST /api/knowledge/ingest?rebuild=true` 删表重建
- **为什么是 409 不是 503**：请求本身没问题，是和服务端已有的数据冲突，不重建就一直错，重试没用
- **维度从表上读**：pgvector 把 `vector(1024)` 的 1024 存在列的类型修饰符 `atttypmod` 里，建表前先读出已有表的维度比对

另一种做法是只用一张表、发现不一致就要求重建，适合不常换模型的线上环境；学习项目要来回对比，所以选分表。

---

## 八、两种向量库

| | memory（默认） | pgvector（可选） |
|---|---|---|
| 实现 | Spring AI 的 `SimpleVectorStore`，入库后存成 JSON 文件 | PostgreSQL + pgvector 扩展，`PgVectorStore` |
| 依赖 | 只要 Ollama 上有向量模型，不装 Docker、不配数据库 | 数据库，Docker 镜像 `pgvector/pgvector:0.8.1-pg17` |
| 检索 | 问题向量和**每一块**算余弦相似度再排序 | `ORDER BY embedding <=> ?`，有 HNSW 索引时不用逐行算 |
| 写入 | 逐块调模型，一块一次请求 | 按 token 数分批调模型，`INSERT … ON CONFLICT (id) DO UPDATE` |

切到 pgvector 用 `ASSISTANT_KNOWLEDGE_STORE=pgvector`，连接信息写进不入库的 `application-local.yml` 或环境变量。`PgVectorConfig` 自己建连接池和 `PgVectorStore`：

```java
static PgVectorStore createStore(
        JdbcTemplate jdbc, KnowledgeEmbedding embedding, KnowledgeProperties.PgVector pg, String table, int dimensions) {
    PgVectorStore store = PgVectorStore.builder(jdbc, embedding.model())
            .schemaName(pg.schema())
            .vectorTableName(table)                       // 默认是 vector_store，所有模型挤一张表
            .dimensions(dimensions)                       // 显式传入，不让它自己探测
            .distanceType(PgDistanceType.COSINE_DISTANCE) // <=>，余弦距离 = 1 − 余弦相似度
            .indexType(PgIndexType.HNSW)
            .idType(PgIdType.UUID)
            .initializeSchema(pg.initializeSchema())
            .build();
    store.afterPropertiesSet();                           // 建表在这里，它不是 Spring Bean，没人替我们调
    return store;
}
```

- **不用 pgvector 的 Starter**：Starter 依赖 Spring Boot 的 JDBC 自动配置，类路径上一有它，应用启动就要求配好 `spring.datasource.*`，默认的 memory 模式也会因为没有数据源起不来。这里只引入不带自动配置的 `spring-ai-pgvector-store`，选了 pgvector 才自己建数据源
- **余弦距离**：只看方向不看长度，文本向量最常用；检索结果的 score 由 PgVectorStore 换算成 1 − 距离
- **HNSW**：把向量连成多层的邻居图，检索时从顶层粗跳到底层细找，百万行也是毫秒级，代价是建索引慢、占内存、结果是「近似」最近；IVFFlat 建得快但要先有数据再建索引才准
- **延迟建表**：`PgVectorKnowledgeStore` 第一次用到时才探测维度、建表，探测失败报 `EMBEDDING_UNAVAILABLE`，不会建出一张错误维度的表
- **表名只允许安全字符**：schema 和表名会拼进 SQL，只允许小写字母、数字、下划线，最长 57 个字符（加上自动拼的 `_index` 不超过 63）

```sql
\d knowledge_chunk_bge_m3     -- embedding vector(1024)，索引 USING hnsw (embedding vector_cosine_ops)
SELECT metadata->>'source', count(*) FROM knowledge_chunk_bge_m3 GROUP BY 1;
```

**两种库的分数口径一致**：内存版直接算余弦相似度，pgvector 查出余弦距离再换算成 `1 − 距离`；同一个模型、同一个问题，两边的分数到第 4 位小数都一样。检索接口返回的 `score` 与 `distance` 都保留 4 位小数。pgvector 的建表、距离运算符与过滤查询见 [向量数据库 · pgvector](../4_core_tech/1_vector_db#三、pgvector)。

---

## 九、Spring AI 2.0.2 的几个坑

- **SimpleVectorStore 列不出全部块**：存块的 Map 是 protected 字段，值类型 `SimpleVectorStoreContent` 是包内可见的，别的包里连类名都写不出来。`MemoryKnowledgeStore` 用一个子类把 Map 露出来，按公开接口 `Content` 取元数据；另外 `add` 传空列表直接抛 `IllegalArgumentException`，`save(File)` 不建父目录
- **PgVectorStore 探测维度失败时静默按 1536 建表**：没传 `dimensions` 时它自己调模型探测，模型临时连不上就打一行警告、按 OpenAI 的 1536 维建表，之后 1024 维的向量一条也写不进去。所以自己先探测、失败就报错，成功了再显式传维度
- **metadata 列是 `json` 不是 `jsonb`**：建表用 `json`，插入时却写 `?::jsonb`；按条件删除失败时把 SQL 异常包成 `IllegalStateException`，所以 `KnowledgeException.classify` 沿着 cause 链找数据库异常
- **「全部接受」的阈值其实是 0**：`similarityThresholdAll()` 设的是 0.0，余弦相似度为负的块两种库都会被过滤掉；真实模型的中文文本很少出现负值，但自己写的假模型要注意
- **Hikari 默认启动即连库**：创建连接池时就连一次数据库，连不上直接抛异常、整个应用起不来。`initializationFailTimeout = -1` 推迟到第一次使用，连接超时设 3 秒快速失败，`minimumIdle = 0` 不常驻空闲连接
- **初始化要建扩展的权限**：会执行 `CREATE EXTENSION IF NOT EXISTS` 建 `vector`、`hstore`、`uuid-ossp` 三个扩展；`pgvector/pgvector` 镜像里用 `POSTGRES_USER` 建的用户是超级用户，共享库上要先让管理员装好扩展

---

## 十、故障不影响对话

知识库只是辅助功能，向量模型或向量库不可用时，应用照常启动、对话照常可用：

| 情况 | 启动 | 知识库接口 |
|------|------|-----------|
| 向量模型没启动、没 pull、调用报错 | 照常启动，打一行警告 | 503 `EMBEDDING_UNAVAILABLE` |
| pgvector 连不上、SQL 报错 | 照常启动，打一行警告 | 503 `VECTOR_STORE_UNAVAILABLE` |
| 库里是别的模型生成的向量 | 照常启动，概况里说明原因 | 409 `INDEX_MODEL_MISMATCH` |

- **启动时入库只记警告**：`KnowledgeStartupIngest` 在 `ApplicationReadyEvent` 后入库，任何异常都只打一行原因、不往外抛（抛出去 Spring 会认为启动失败），堆栈放 DEBUG 级别；模型或向量库就绪后调 `POST /api/knowledge/ingest` 重试
- **错误码沿用第 1 章的格式**：`ApiExceptionHandler` 按 `KnowledgeFailure` 填 ProblemDetail 的状态码、title 与 code，提示信息里只有模型名和库的位置，没有连接串和密码
- **概况接口不依赖模型**：`/api/knowledge/stats` 的文档汇总直接查存储，维度探测失败就为空并在 `warning` 里说明
- **命令行模型也有知识库**：`claude-cli` / `codex-cli` 两个 profile 没有向量模型，同样用 Ollama 的；`openai` profile 用兼容接口的 `/v1/embeddings`，没有这个接口的厂商（如 DeepSeek）知识库返回 503，对话不受影响

错误分类与 ProblemDetail 的写法见 [接入模型与流式对话](./1_model_streaming)。

---

## 十一、测试

| 层 | 做法 |
|----|------|
| 单元（假向量模型） | `FakeEmbeddingModel` 用字符 n-gram 哈希生成向量，不联网、结果确定，「字面越像的文字向量越近」；测切块、元数据、增量、写库、检索排序与前缀 |
| 接口（假向量模型） | MockMvc 走入库、检索、概况三个接口；模型设成「调用就抛异常」时返回 503，对话照常可用；`KnowledgeStartupTest` 验证启动时入库与模型不可用时照样启动 |
| 集成（真实 pgvector） | `PgVectorStoreIT` 用 Testcontainers 起 `pgvector/pgvector:0.8.1-pg17`，只建、删一张随机名字的表 |
| 集成（真实 Ollama） | `OllamaEmbeddingIT` 起 Ollama + `nomic-embed-text`，入库、探测出 768 维、检索不报错 |

- **假模型只认字面**：「东西坏了」和「质量问题」在它眼里毫无关系，真实的 bge-m3 能对上。用它验证的是流水线对不对，不是模型准不准；检索效果靠上一节的实测对比
- **假模型能计数**：记录每次收到的文字，断言「没变的文档真的没调模型」「库里不存前缀」
- **最后一维加偏置**：全 0 的向量算不了余弦相似度，SimpleVectorStore 会抛异常，假模型固定给最后一维一点偏置
- **CI 用 nomic 而不是 bge-m3**：nomic 约 270 MB，bge-m3 约 1.2 GB；两者走的代码路径完全一样，前缀逻辑还能顺带测到
- **没有 Docker 也能跑集成测试**：设置 `PGVECTOR_IT_URL`、`EMBEDDING_IT_OLLAMA_URL` 等环境变量指向现成的服务，都没有就跳过，命令见仓库 `docs/ch04.md`

---

## 十二、常见坑

- **只哈希原文**：改了切块参数或前缀后再入库，所有文档都被「跳过」，库里还是旧切法的块；哈希要把影响块内容的参数都算进去
- **用随机 UUID**：每次入库多一份，检索结果里同一块出现好几次；更新时又删不干净
- **换了模型没重建**：维度相同的两个模型混在一张表里不会报错，检索结果却毫无意义；用元数据里的模型名兜底检查
- **把元数据当成会被向量化**：`getEmbeddingContent` 默认只取文字，标题路径只放在元数据里，向量里就没有这层意思
- **默认表名 `vector_store`**：不设表名时所有模型、所有应用挤在一张表里，换模型就冲突

---

## 十三、验证

下表列出本篇关键结论与证明它的测试；本章代码在 `ch04-done` 上跑完整构建的结果见 [测试报告](https://clarence404.github.io/mall-assistant/reports/ch04-done/)。

| 结论 | 测试 | 类型 |
|------|------|------|
| 没有标点时硬切，相邻两块正好重叠 overlap 个字，去掉重叠能拼回原文 | [`MarkdownChunkerTest#hardCutWithExactOverlapWhenNoBoundary`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/MarkdownChunkerTest.java) | 单元 |
| 同样的内容每次得到同样的 UUID | [`ChunkDocumentFactoryTest#idsAreDeterministicUuids`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/ChunkDocumentFactoryTest.java) | 单元 |
| 改了内容、切块参数或前缀，文档哈希都会变 | [`ChunkDocumentFactoryTest#docHashChangesWithContentChunkingOrPrefix`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/ChunkDocumentFactoryTest.java) | 单元 |
| 第二次入库全部跳过，且不调向量模型 | [`KnowledgeIngestionServiceTest#unchangedDocumentsAreSkippedWithoutCallingTheModel`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/KnowledgeIngestionServiceTest.java) | 单元 |
| 文档改短后再入库，旧块删干净 | [`KnowledgeIngestionServiceTest#changedDocumentReplacesItsOldChunks`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/KnowledgeIngestionServiceTest.java) | 单元 |
| 库里是别的模型生成的块时要求重建 | [`KnowledgeIngestionServiceTest#otherModelInStoreRequiresRebuild`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/KnowledgeIngestionServiceTest.java) | 单元 |
| nomic 的查询前缀与文档前缀走对路径，库里不存前缀 | [`PrefixedEmbeddingModelTest#nomicPrefixesFlowThroughIngestAndSearch`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/PrefixedEmbeddingModelTest.java) | 单元 |
| 向量模型挂了时知识库接口 503，对话照常可用 | [`KnowledgeApiTest#chatStillWorksWhenEmbeddingIsDown`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/chat/KnowledgeApiTest.java) | 接口（假向量模型） |
| 按模型建表，维度正确，带余弦 HNSW 索引 | [`PgVectorStoreIT#ingestCreatesTableWithDimensionsAndCosineHnswIndex`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/PgVectorStoreIT.java) | 集成（真实 pgvector） |
| pgvector 与内存版的检索分数一致 | [`PgVectorStoreIT#searchScoresMatchInMemoryCosineSimilarity`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/PgVectorStoreIT.java) | 集成（真实 pgvector） |
| 维度不同的已有表拒绝写入 | [`PgVectorStoreIT#existingTableWithOtherDimensionsIsRejected`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/PgVectorStoreIT.java) | 集成（真实 pgvector） |
| 真实 Ollama + `nomic-embed-text` 入库、探测出 768 维、检索不报错 | [`OllamaEmbeddingIT#realEmbeddingModelIngestsAndSearches`](https://github.com/Clarence404/mall-assistant/blob/ch04-done/src/test/java/io/github/clarence404/assistant/knowledge/OllamaEmbeddingIT.java) | 集成（真实 Ollama） |

---

## 小结

- 6 篇带 front matter 的规则文档先按标题分节，超长的节再按 300 字切块、重叠 50 字；块文字带上标题路径，向量里才有「这一节讲什么」
- 每块带十个元数据，ID 是「来源 + 序号 + 文档哈希」算出的 UUID，重复写只会覆盖
- 文档哈希含切块参数与前缀，入库按哈希分成新增 / 更新 / 跳过 / 删除：没变的不调模型，变了的先按 source 删再写
- 中文规则用 bge-m3（1024 维），nomic-embed-text 中文四个问题错三条，且要加查询 / 文档前缀；口语化问题两个都找不准，留给第 5 章
- 不同模型的向量不能混用：每个模型一张表 / 一个文件，混用时返回 409 `INDEX_MODEL_MISMATCH` 要求重建
- 默认 memory 零依赖，可选 pgvector（自建连接池、HNSW、余弦距离、显式传维度、延迟建表），两种库的分数口径一致
- Spring AI 2.0.2：PgVectorStore 探测失败静默按 1536 建表、metadata 是 json、阈值 0 过滤负相似度、Hikari 启动即连库；模型或库不可用时只返回 503，不影响启动和对话

> 本篇代码：[ch04-done](https://github.com/Clarence404/mall-assistant/tree/ch04-done) · 练习起点：[ch04-start](https://github.com/Clarence404/mall-assistant/tree/ch04-start)

## 参考资料

- Spring AI Reference · Embeddings Model API：[https://docs.spring.io/spring-ai/reference/api/embeddings.html](https://docs.spring.io/spring-ai/reference/api/embeddings.html)
- Spring AI Reference · Vector Databases：[https://docs.spring.io/spring-ai/reference/api/vectordbs.html](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)
- Spring AI Reference · PGvector：[https://docs.spring.io/spring-ai/reference/api/vectordbs/pgvector.html](https://docs.spring.io/spring-ai/reference/api/vectordbs/pgvector.html)
- pgvector：[https://github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)
- Ollama · bge-m3：[https://ollama.com/library/bge-m3](https://ollama.com/library/bge-m3)
- Ollama · nomic-embed-text：[https://ollama.com/library/nomic-embed-text](https://ollama.com/library/nomic-embed-text)

> 返回：[AI 总览](../0_overview)

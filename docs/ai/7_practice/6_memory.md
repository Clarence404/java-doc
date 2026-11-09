---
description: 会话 ID、ChatMemory 存储、轮数与字数裁剪、追问改写、订单号沿用、会话隔离、完成后写记忆
---

# 多轮对话与记忆

> 前置阅读：[RAG 检索增强回答](./5_rag)、[Spring AI](../2_frameworks/0_spring_ai)、[Prompt 工程](../1_concepts/1_prompt)

第 6 章让客服记得上文：问完「七天无理由退货要什么条件」再问「那运费谁出」，它知道「那」指什么。本篇讲会话 ID 与记忆存储、上下文裁剪、存什么不存什么、追问改写与订单号沿用、会话隔离、什么时候写记忆，以及小模型的实测表现，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、本章做什么

先记住一句话：**模型本身没有状态**，Ollama、OpenAI 的接口都是「一次请求一次回答」，第 2 轮的请求里不带第 1 轮，模型根本不知道第 1 轮发生过。所谓多轮对话，是应用把历史存下来，每次请求挑一部分一起发过去；存在哪、存什么、带多少、谁能看，都是应用层的事。

![第 6 章的一轮多轮对话](../../assets/ai/mall-assistant-memory-flow.svg)

本章新增的类都在 `memory` 包下：

| 类 | 职责 |
|----|------|
| `ConversationMemory` / `Conversation` | 打开会话（确认归属、占住会话、读历史、裁剪、判断过期），写回、查看、清空、定时清理 |
| `HistoryWindow` | 提示词窗口：按轮数、字数两道限制裁剪历史，一问一答一起丢 |
| `MemoryMessages` | 存什么：用户原话、去掉 [n] 的回答、时间戳、摘要的放法 |
| `QuestionCondenser` | 追问改写：有历史时把追问改写成独立问题，结果做跑题检查 |
| `ConversationEntities` | 订单号 / SKU 的核对与沿用 |
| `ConversationOwners` / `ConversationOwner` | 会话归属（匿名 / 商城用户）与记忆键 |
| `LazyJdbcChatMemoryRepository` | JDBC 记忆：第一次用到时才建表、才创建 Spring AI 的仓库 |
| `ConversationSummarizer` | 可选的摘要记忆，默认关 |
| `MemoryConfig` / `MemoryProperties` | `assistant.memory.*`：存储、过期、两个窗口、改写、摘要、归属缓存 |
| `ConversationController` | `GET /api/conversations/{id}/messages` 恢复历史、`DELETE /api/conversations/{id}` 清空 |

`ChatService` 多了一步 `begin`（打开会话 → 改写 → 识别意图 → 沿用），阻塞响应多了 `memory` 字段，流式在 intent 之后多一个 `memory` 事件；调试面板「记忆」一栏显示带了几轮历史、裁掉几轮、改写后的问题、沿用的订单号。不带会话 ID 时和第 5 章一模一样。

---

## 二、会话 ID：页面生成，放在请求体

```java
public record ChatRequest(
        @NotBlank @Size(max = 2000) String message,
        @Pattern(regexp = ConversationIds.PATTERN) String conversationId) {}   // 小写 UUID，可以不带
```

- **页面生成，服务端不「创建会话」**：页面生成一个随机 UUID 存进 localStorage，刷新页面、重开浏览器还是同一个，历史就接得上；点「新对话」换一个，登录、退出时也自动换。省一次请求，UUID 的随机部分有 122 位也猜不出来
- **只认小写 UUID**：格式不对直接 400，日志里打出来也安全
- **放请求体不放请求头**：它和这条消息是一回事（「这句话是哪个对话里说的」），调试时看请求体就全知道；商城令牌这种每个请求都一样的横切信息才放请求头

---

## 三、记忆存储：ChatMemory

Spring AI 的对话记忆分三层，本项目只用前两层：

| 层 | 类 | 本项目 |
|----|----|-------|
| 存储 | `ChatMemoryRepository`：`InMemoryChatMemoryRepository`、`JdbcChatMemoryRepository` 等 | `assistant.memory.store`：`memory`（默认，零依赖，重启就没了）或 `jdbc`（PostgreSQL 的 `SPRING_AI_CHAT_MEMORY` 表，默认和第 4 章 pgvector 同一个库） |
| 策略 | `ChatMemory`：`MessageWindowChatMemory` | 存储窗口 `max-messages: 40`，超出删最早的 |
| 自动读写 | `MessageChatMemoryAdvisor` 等 | 没用，见 [十、为什么没用 MessageChatMemoryAdvisor](#十、为什么没用-messagechatmemoryadvisor) |

```java
@Bean
public ChatMemory chatMemory(ChatMemoryRepository repository, MemoryProperties properties) {
    return MessageWindowChatMemory.builder()
            .chatMemoryRepository(repository)          // memory 或 jdbc，按配置二选一
            .maxMessages(properties.maxMessages())
            .build();
}
```

- **会话空闲 30 分钟过期**：`ttl: 30m`，最后一句之后超过它再来就当新会话；后台每 10 分钟清理一次，内存模式不清会一直占内存
- **过期靠消息上的时间戳判断**：每条消息写入时带上时间，两种存储都能读回来，JDBC 怎么存下时间戳见 [十一、Spring AI 2.0.2 的几个坑](#十一、spring-ai-2-0-2-的几个坑)
- **同一个会话同时只能有一个请求**：两个请求读到同样的历史、各自写回，后写的会覆盖先写的；内存里记一个「正在回答」集合，后到的直接 409「上一条还在回答中」。只在单个进程里有效，多实例要换成分布式锁或乐观锁
- **记忆挂了不影响对话**：登录失效、商城不可用、数据库连不上时这一轮照常回答，只是不带历史、不写回，`memory.active=false` 并写明原因；查看、清空接口则如实返回 401 / 503

记忆三层的原理见 [Spring AI · 对话记忆](../2_frameworks/0_spring_ai#_2、对话记忆)。

---

## 四、上下文裁剪：轮数 + 字数

存储窗口防「一个会话无限变长」，提示词窗口防「提示词太长」：上下文越长越慢、越贵，小模型还会被早先的话题带偏。`HistoryWindow` 每轮打开会话时裁一次：

```java
List<List<Message>> turns = turns(dialogue);          // 每条用户消息开始新的一轮，回答归进这一轮
int from = Math.max(0, turns.size() - maxTurns);      // 先按轮数：只留最后 6 轮
int chars = 0;
for (int i = from; i < turns.size(); i++) {
    chars += chars(turns.get(i));
}
while (from < turns.size() && chars > budgetChars) {  // 再按字数：超出 2000 字从最早一轮丢
    chars -= chars(turns.get(from));
    from++;
}
List<Message> kept = new ArrayList<>();
turns.subList(from, turns.size()).forEach(kept::addAll);
return new Window(summary, kept, turns.size() - from, from, chars);
```

- **两道都要**：只按轮数不够，一轮可能是五百字的回答；只按字数又会带上十几轮零碎寒暄。`window-turns: 6`、`budget-chars: 2000`，字数是 token 的粗略估算，中文大致一两个字一个 token
- **按轮丢、不按条丢**：只丢用户那句、留下回答，模型会看到一句没头没尾的话；最近一轮本身就超预算时整轮丢掉
- **系统提示词不进记忆**：每次请求现渲染，永远在最前面，不参与裁剪
- **历史用 `.messages(history)` 放进去**：ChatClient 拼 Prompt 的顺序固定是 system → messages → user，历史自然夹在系统提示词和这一轮的问题之间，第 3 章的直接查询和第 5 章的 RAG 两条路都一样

**摘要记忆默认关**（`summary.enabled: false`）。窗口裁剪是「硬遗忘」，第 7 轮时第 1 轮说的话就看不到了；摘要记忆把挤出窗口的早期对话压成一段摘要、原话删掉。代价：每次压缩多一次模型调用，而且在回答之后同步做，用户要多等；小模型的摘要会丢细节、会说错，原话删了就找不回来。客服对话大多几轮就结束，窗口裁剪就够了。打开时摘要放进带 `<早期对话摘要>` 标签的用户消息，不进系统消息，因为它是根据用户的话写的，可能被带偏。

---

## 五、存什么，不存什么

记忆里只有两样：用户**原话**和助手**最终的回答**（去掉 [n] 引用编号）。

| 不存 | 为什么 |
|------|--------|
| 商城令牌 | 第 3 章起令牌只走 ToolContext，不出现在任何消息里，记忆也一样 |
| 工具的查询结果 | 体积大，一笔订单的 JSON 几百字，几轮就把预算吃光；会过期，「待发货」下一分钟就可能「已发货」，旧结果会误导模型 |
| RAG 的参考资料 | 同样占预算；而且来自外部，存进历史就脱离了 `<参考资料>` 标签的保护，以「助手说过的话」的身份出现在之后每一轮，成了提示注入的入口 |
| 回答里的 [n] | 编号只对那一轮的资料有效 |

下一轮要用订单状态、要用规则，就重新查、重新检索。拒答和「没找到相关规定」也是这一轮的回答，照样写，下一轮的模型才知道上一句被拒了。

---

## 六、追问改写：意图识别和检索都用改写后的问题

「那运费谁出」拿去检索，向量和关键词都只看得到「运费」两个字，很可能找到「买多少钱包邮」；意图识别也只看这一句。检索器和意图识别器都没有记忆，上文必须由改写这一步翻译进问题里。`ChatService#begin` 在有历史时，每一轮先改写：

```java
public ChatTurn begin(String message, String conversationId, String mallToken) {
    Conversation conversation = memory == null ? Conversation.none() : memory.open(conversationId, mallToken);
    try {
        String question = condense(message, conversation);          // 没有历史或改写失败时就是原话
        IntentResult intent = conversation.carryOver(intentService.classify(question), message);
        return new ChatTurn(message, intent, mallToken, conversation);
    } catch (RuntimeException e) {
        conversation.close();
        throw e;
    }
}
```

**为什么意图识别也用改写结果**：第一版只在 RAG 路径改写、意图识别仍看原话，录制时 1.5b 把「那能抵多少钱」分成了问商品（`PRODUCT_INFO`），不走 RAG，然后编了一个「1000 积分 = 1 元」，规则其实是 100 积分抵 1 元。所以改写挪到每一轮的开头。单轮对话不改写，意图识别的输入和第 2 章完全一样，前几章的录制都不用重录。

改写请求照第 2 章意图识别的写法拼，提示词是 `prompts/memory-condense.st`，温度 0、不注册工具：

```text
你负责改写客服对话里用户的最新一句：根据对话历史，把它改写成不看上文也能看懂的完整问题。
最新一句用了「那」「它」「这个」「这单」，或者省略了说的是什么时，把上文正在讨论的事物补进去。
最新一句本身已经完整、是打招呼，或者换了新话题时，原样输出。
订单号、商品编号等数字原样保留，不要改动。
只输出改写后的一句话，不要回答问题，不要解释。
```

小模型改写得并不好：会照抄示例（第一版的示例是「那专票呢」→「增值税专用发票怎么开」，问「那专票呢」时两个模型都原样输出了示例）、会把新话题改回旧话题、会把上一句的回答整段塞进来。对策两条：

- **示例换成和商城规则无关的话题**：会员等级、快递公司、道谢三组「历史 → 最新一句 → 改写」，照抄了也不至于答非所问
- **结果做跑题检查**：用第 5 章的切词，原话里的字至少六成要还在改写结果里，不然退回原话；只看单字不看双字词，「运费谁出」改成「运费由谁承担」是正常换说法。为空、超过 120 字、和原话一样、模型调用失败，也都退回原话

```java
static boolean plausible(String original, String condensed) {
    Set<String> terms = new LinkedHashSet<>();
    for (String term : Terms.of(original)) {
        if (term.length() == 1 || Character.UnicodeScript.of(term.charAt(0)) != Character.UnicodeScript.HAN) {
            terms.add(term);                                     // 汉字只取单字，数字和英文词照收
        }
    }
    if (terms.isEmpty()) {
        return true;                                             // 全是语气词时不做要求
    }
    String lower = condensed.toLowerCase(java.util.Locale.ROOT);
    long kept = terms.stream().filter(lower::contains).count();
    return (double) kept / terms.size() >= MIN_TERM_COVERAGE;   // 0.6
}
```

真实冒烟的一遍里，17 次改写有 7 次被这道检查挡掉。**代价**是每个追问多一次模型调用，本地 1.5b 约 0.5～2 秒，命令行模型 3～7 秒；嫌慢可以 `--assistant.memory.condense.enabled=false`，订单追问靠下一节的沿用，规则追问就只能用原话检索了。这一步和第 5 章可选的 `RewriteQueryTransformer` 是一类事，区别是带着历史。

---

## 七、订单号沿用：模型改写 + 代码核对

「订单 2118… 到哪了」→「它什么时候下的单」：改写会把订单号补进问题，意图识别就能抽出来。但 23 位数字小模型可能少抄、错抄一位，格式校验照样通过，查到的是别人的单（商城返回 404）或根本不存在的单。所以 `ConversationEntities` 再核对一遍：

```java
if (intent.orderNo() != null && !mentioned(intent.orderNo(), message, history)) {
    intent = intent.withOrderNo(null);                  // 原话和历史里都没原样出现过：当作抄错了
}
if (intent.intent() == Intent.ORDER_STATUS
        && intent.orderNo() == null
        && !LIST_REQUEST.matcher(message).find()) {     // 「我有哪些订单」不沿用
    String orderNo = lastMatch(history, maxTurns, ORDER_NO);   // 最近 3 轮里最近提到的
    if (orderNo != null) {
        return new Carried(intent.withOrderNo(orderNo), orderNo, null);
    }
}
```

- **模型给的号必须原样出现过**：在用户原话或历史里能找到才用，否则扔掉再沿用
- **沿用只看最近 3 轮**（`entity-turns: 3`），从新往旧找，用和第 2 章同一套格式规则（19 / 23 位数字）；助手列出的几笔订单取第一笔，也就是最新的一笔
- **沿用之后照样走第 3 章的直接查询**，不靠模型自己调工具；SKU 同理，但要有「SKU」「商品编号」字样，光是一串短数字不算
- **改写关掉或失败时，订单追问全靠这一步**；「第二笔呢」这种按序号指代的处理不了

---

## 八、会话隔离：归属问商城，记忆键按归属算

会话 ID 可能被别人看到（截图、日志、共用电脑）。如果记忆只按会话 ID 存取，拿到 ID 的人就能读到别人的订单对话，还能往里塞话，下一轮模型会把它当成用户说过的。

```java
public ConversationOwner resolve(String mallToken) {
    if (mallToken == null) {
        return ConversationOwner.ANONYMOUS;
    }
    String fingerprint = fingerprint(mallToken);          // SHA-256，内存里不留令牌原文
    Cached cached = cache.get(fingerprint);
    if (cached != null && cached.expiresAt().isAfter(clock.instant())) {
        return cached.owner();
    }
    MallResult<MallModels.UserProfile> me = mallApi.me(mallToken);   // GET /api/users/me
    // 成功：按用户 ID 归属，缓存 5 分钟；401 → LOGIN_EXPIRED；其他失败 → OWNER_UNVERIFIED，都不缓存
}

public String memoryKey(ConversationOwner owner, String conversationId) {
    return UUID.nameUUIDFromBytes((owner.key() + "/" + conversationId).getBytes(StandardCharsets.UTF_8))
            .toString();
}
```

- **不自己解析 JWT**：商城令牌是 JWT，解开中间一段就有用户 ID，但我们没有商城的密钥、验不了签名，伪造一个写着别人 ID 的令牌轻而易举；让商城验，拿到的 ID 才可信
- **不用令牌指纹当归属**：不问商城确实简单，但商城令牌 30 分钟就过期，重新登录后之前的会话就再也打不开了
- **记忆键 = 归属 + 会话 ID 算出的 UUID**：别人拿着你的 ID 来，算出的是他自己的键，读到的是空会话、写进的也是他自己的会话；不用另建「会话归属表」，也不会因为哪个接口忘了校验而漏掉。还要算成 UUID，是因为 JDBC 表的会话 ID 列只有 36 个字符，放不下「user:10001/会话 ID」
- **别人的会话返回 404**：查看、清空别人的会话和不存在的会话一样，不暴露这个 ID 有没有人在用，和商城对别人的订单返回 404 一个道理
- **匿名与登录不混用**：匿名会话谁拿到 ID 都能看（ID 本身就是凭证）；登录前后是两个会话，页面在登录、退出时自动换新对话

---

## 九、回答完成后才写记忆

阻塞接口在回答成功、返回之前写；模型调用失败时异常直接抛出，不写。流式要等最后一段文字推完：

```java
StringBuilder reply = new StringBuilder();
return parts.doOnNext(part -> {
            if (part instanceof AnswerPart.Text text) {
                reply.append(text.text());                       // 边推边拼
            }
        })
        .concatWith(Mono.<AnswerPart>fromRunnable(() -> conversation.save(turn.message(), reply.toString()))
                .subscribeOn(Schedulers.boundedElastic()))       // 写记忆可能是一次数据库操作
        .doFinally(signal -> conversation.close());              // 放开「正在回答」的标记
```

- **`concatWith` 只在上游正常完成时才订阅后面的部分**：模型中途出错、超时、用户关掉页面（取消订阅）都不会写，半截的回答不进历史，用户重问即可
- **用户原话也不写**：下一轮如果带着一句没回答的问题，模型会去回答它
- **写记忆放到 `boundedElastic`**：流式的最后一个信号可能来自网络 IO 线程，不能在那里阻塞
- **写回失败只记日志**：这一轮的回答已经给了用户，不受影响

---

## 十、为什么没用 MessageChatMemoryAdvisor

`MessageChatMemoryAdvisor` 挂到 ChatClient 上，调模型前把历史塞进 Prompt、调完把这一轮写回，几行就能搭起多轮对话，适合快速验证。本项目在 `ConversationMemory` 里自己决定什么时候读、写什么、什么时候写，读 2.0.2 的源码看得很清楚：

- **它在调模型之前就写**：用户消息在 `before()` 里写、回答在 `after()` 里写，模型调用失败或流式被取消时，记忆里会留下一句没有回答的话
- **它写的是发给模型的那条用户消息**：`before()` 取最后一条用户消息写进记忆，第 3 章直接查询时那条拼了查询结果，第 5 章拼了参考资料，整段都会进记忆，正好违反上一节的「不存」
- **只按条数裁**：就是 `MessageWindowChatMemory`，没有字数预算，也做不了追问改写、订单号沿用这些「检索之前」的事
- **意图识别和回答共用一个 ChatClient**：挂上它，意图识别的请求也会带上历史、写进记忆

---

## 十一、Spring AI 2.0.2 的几个坑

- **模型 Starter 自带一个 ChatMemory**：`spring-ai-autoconfigure-model-chat-memory` 随 Ollama / OpenAI Starter 传递进来，容器里没有时自动配一个内存存储 + 20 条窗口的 `MessageWindowChatMemory`；自己声明 `ChatMemory` / `ChatMemoryRepository` Bean 把它顶掉，窗口大小才由自己定
- **不能用 JDBC 记忆的 Starter**：和第 4 章 pgvector 一样，`spring-ai-starter-model-chat-memory-repository-jdbc` 会拉进 JDBC 自动配置、要求 `spring.datasource.*`，默认的 memory 模式就起不来。只引非 Starter 的 `spring-ai-model-chat-memory-repository-jdbc`，自己建连接池、自己执行它 jar 里的 `schema-postgresql.sql`
- **`JdbcChatMemoryRepository.builder().build()` 会当场连库**：明确指定了方言也要读一次数据库产品名做比对，连不上时等满超时、打一大段警告；所以放进 `LazyJdbcChatMemoryRepository`，第一次读写时才建表、才创建（双重检查，失败不缓存）
- **表里只存内容、类型、时间戳**：放进 metadata 的东西都会丢，只有键为 `JdbcChatMemoryRepository.CONVERSATION_TS` 的 `Instant` 会写进 timestamp 列、读出来再放回 metadata；消息的时间戳就借用这个键，内存和 JDBC 两种存储都能判断过期
- **会话 ID 列只有 36 个字符**：`conversation_id VARCHAR(36)` 正好一个 UUID，所以记忆键要算成 UUID，代价是数据库里的键和页面上的会话 ID 对不上，排查时要用同样的算法算一遍
- **`saveAll` 是删掉整个会话再全部插入**：`MessageWindowChatMemory#add` 每次都「读全部 → 追加 → 整体写回」，不是原子的，并发写同一个会话会丢更新，这也是要 409 的原因；存储窗口也不宜太大

---

## 十二、RAG 门槛按向量模型配置

第 5 章的相似度门槛 0.6 是按 bge-m3 定的，nomic-embed-text 的分数分布完全不同。本章顺带把门槛改成按模型名前缀匹配，和第 4 章的查询前缀一样写在配置里，没列到的模型用 `min-score`：

```yaml
assistant:
  rag:
    min-score: 0.6
    model-profiles:
      - match: bge-m3
        min-score: 0.6
      - match: nomic-embed-text   # 中文请用 bge-m3
        min-score: 0.72
```

`OllamaEmbeddingIT#similarityThresholdSweep` 用 20 道正例和 6 道知识库里没有的反例扫了一遍（覆盖率门槛固定 0.6）：

| 门槛 | bge-m3 正例过门槛 | bge-m3 反例短路 | nomic 正例过门槛 | nomic 反例短路 |
|------|------------------|----------------|-----------------|---------------|
| 0.6 | **20/20** | **5/6** | 13/20 | 0/6 |
| 0.65 | 20/20 | 6/6 | 10/20 | 2/6 |
| 0.7 | 16/20 | 6/6 | 6/20 | 5/6 |
| 0.72 | 14/20 | 6/6 | **5/20** | **6/6** |

- **bge-m3 保持 0.6**：正例 0.665～0.814、反例 0.488～0.636，基本分得开；0.65 在这份评测集上能全部分开，但离最低的正例只差一点
- **nomic 取 0.72**：6 道反例的最高分在 0.64～0.71，和正确答案的分数重叠；0.6 时 6 道反例全部拿着不相关的资料去问模型，0.72 才全部短路
- **这是 nomic 不适合中文规则的又一证据**：取 0.72 时 20 道正常题只剩 5 道答得出来，向量分数实际上已经不起作用，等于只靠关键词覆盖率。按「宁可说不知道，也不要说错」取 0.72，配置注释里写明中文请用 bge-m3

---

## 十三、真实模型的表现

开发机（仅 CPU）上的 Ollama，qwen2.5:1.5b + bge-m3，商城是本机的 mall-evolution；memory 与 jdbc 记忆各跑一遍，行为一致：

| 场景 | 结果 | 耗时 |
|------|------|------|
| 七天无理由 → 那运费谁出 | 带 1 轮历史；1.5b 只改写成「运费谁出」，没补上主题，检索第 1 条偏到「质量问题 > 处理方式与运费」，答成了质量问题的运费 ✗ | 6～12 秒 / 句 |
| 积分多久过期 → 那能抵多少钱 | 改写照抄上一句，被跑题检查挡掉，按原话识别成 `PRODUCT_INFO`，没走 RAG ✗ | 3～7 秒 |
| 订单 … 到哪了 → 它什么时候下的单 | 第二句改写成「订单 … 是什么时候下的单」，订单号核对通过，直接查询，答出下单时间 ✓ | 5～7 秒 |
| 连续 12 轮 | 第 7 轮起带满 6 轮，「裁掉」从 1 涨到 5，历史始终在 2000 字以内（最多 382 字）；17 次改写挡掉 7 次 | 2～28 秒 / 句 |
| 流式「发票什么时候能开」→「那专票呢」 | 事件 `intent → memory → source × N → token … → done`，memory 事件里是改写后的问题 | 4～13 秒 |
| 刷新恢复 / 清空 | 恢复 24 条；DELETE 204，再查 404 | 毫秒级 |
| 越权 | 别的用户查看 404、删除 404，匿名查看 404，伪造令牌 401；别的用户往这个 ID 里说话，原会话不受影响，他的提示词里也没有原会话的历史 | — |

同样两段换成 `claude-cli`（haiku）：「那运费谁出」改写成「七天无理由退货的运费谁出」，答对寄回运费由买家承担并标了 [1]；「那能抵多少钱」改写成「积分能抵多少钱」，答「100 积分抵 1 元」，每轮约 10 秒。

- **机制是对的，效果卡在小模型的改写能力上**：改写对了，后面的检索、回答就跟着对；1.5b 大约一半对一半错，跑题检查只能挡掉明显的错
- **0.5b 的录制更不稳定**：「那运费谁出」反而改写对了，但订单那段第一句就被分成 `OUT_OF_SCOPE` 拒答，第二句查到了订单、回答却是复述问题
- **长对话会把小模型带偏**：第 11 轮「我想投诉找谁」1.5b 只回了一个「[1]」，这也是提示词窗口要收紧的原因

---

## 十四、测试

| 层 | 做法 |
|----|------|
| 单元（假模型） | 裁剪、改写与跑题检查、订单号核对与沿用、归属与记忆键、过期与清理、并发 409、按归属隔离、降级；`MultiTurnChatFlowTest` 用 `FakeChatModel` 走完整多轮流程，断言历史在系统消息和问题之间、记忆里没有查询结果 / 令牌 / 参考资料、流式失败和取消不写 |
| 接口（假模型） | `ConversationApiTest` 走 `/api/chat` 与会话接口：`memory` 字段、会话 ID 格式 400、恢复、清空、越权 404、伪造令牌 401、流式 `intent → memory → token → done` |
| 录制回放 | `ConversationRecordingIT` 录多轮对话：3 段 × 2 个模型，每一句的意图、改写、沿用、检索用的问题、回答，以及这段对话里每一次模型调用的 Prompt 指纹和原样输出 |
| 集成 | `JdbcChatMemoryIT` 用 Testcontainers 起 PostgreSQL：jdbc 记忆端到端、表里只有原话和回答且键不是会话 ID、时间戳经过数据库还在、重复建表无害 |

- **指纹覆盖 Prompt 里的全部消息**：第 5 章只看系统消息和最后一条用户消息，多轮时历史也在 Prompt 里；改了改写提示词或示例、历史的拼法、裁剪规则，回放就会报「没有录制」
- **前几章的录制不用重录**：单轮不改写，意图识别和回答的输入都没变
- **单元测试 420 个**，每次 `./mvnw verify` 都跑；录制命令和没有 Docker 时怎么跑 `JdbcChatMemoryIT` 见仓库 `docs/ch06.md`

---

## 十五、常见坑

- **把发给模型的那段整个存进记忆**：查询结果和参考资料跟着进了历史，占预算、会过期，还丢了标签的保护；只存原话和最终回答
- **调模型之前就写记忆**：失败或取消时留下一句没回答的话，下一轮模型会去回答它
- **追问原话直接拿去识别意图和检索**：「那能抵多少钱」只看这一句，意图分错、检索偏题；先改写，改写结果还要校验
- **相信模型抄过来的订单号**：少抄一位格式照样合法，查到的是别人的单；要在原话或历史里原样出现过
- **只按会话 ID 存取记忆**：拿到 ID 的人就能读写别人的对话；记忆键要带上归属
- **自己解析 JWT 拿用户 ID**：没有密钥验不了签名，伪造一个就能冒充别人；让签发方验

---

## 十六、验证

下表列出本篇关键结论与证明它的测试；本章代码在 `ch06-done` 上跑完整构建的结果见 [测试报告](https://clarence404.github.io/mall-assistant/reports/ch06-done/)。

| 结论 | 测试 | 类型 |
|------|------|------|
| 只带最近几轮，超出字数从最早一轮丢 | [`HistoryWindowTest#budgetDropsOldestTurnsFirst`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/HistoryWindowTest.java) | 单元 |
| 最近一轮本身超预算时整轮丢掉 | [`HistoryWindowTest#singleTurnOverBudgetIsDroppedEntirely`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/HistoryWindowTest.java) | 单元 |
| 改写跑题时退回原话 | [`QuestionCondenserTest#offTopicRewriteIsRejected`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/QuestionCondenserTest.java) | 单元 |
| 改写失败不抛异常，用原话 | [`QuestionCondenserTest#failureFallsBackToOriginal`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/QuestionCondenserTest.java) | 单元 |
| 原话和历史里没出现过的订单号被扔掉 | [`ConversationEntitiesTest#numbersNotSeenAnywhereAreDropped`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/ConversationEntitiesTest.java) | 单元 |
| 要看列表时不沿用上一笔订单号 | [`ConversationEntitiesTest#listRequestIsNotCarried`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/ConversationEntitiesTest.java) | 单元 |
| 记忆键随归属变化，且是 36 位 UUID | [`ConversationOwnersTest#memoryKeyDependsOnOwnerAndConversation`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/ConversationOwnersTest.java) | 单元 |
| 同一个会话的第二个请求返回 409 | [`ConversationMemoryTest#concurrentRequestOnSameConversationIsBusy`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/ConversationMemoryTest.java) | 单元 |
| 历史在系统消息和这一轮的问题之间 | [`MultiTurnChatFlowTest#historyGoesBetweenSystemAndUserMessage`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/MultiTurnChatFlowTest.java) | 单元（假模型） |
| 记忆里只有原话和最终回答，没有查询结果和令牌 | [`MultiTurnChatFlowTest#onlyOriginalWordsAndFinalReplyAreStored`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/MultiTurnChatFlowTest.java) | 单元（假模型） |
| RAG 参考资料不进记忆 | [`MultiTurnChatFlowTest#ragSourcesAreNotStored`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/MultiTurnChatFlowTest.java) | 单元（假模型） |
| 意图识别用改写后的问题 | [`MultiTurnChatFlowTest#intentIsClassifiedOnCondensedQuestion`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/MultiTurnChatFlowTest.java) | 单元（假模型） |
| 流式中途失败时不写记忆 | [`MultiTurnChatFlowTest#streamFailureIsNotStored`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/MultiTurnChatFlowTest.java) | 单元（假模型） |
| 别的用户查看、删除都返回 404 | [`ConversationApiTest#otherUsersCannotReadOrDelete`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/ConversationApiTest.java) | 接口（假模型） |
| 流式事件顺序为 `intent → memory → token → done`，完成后记住 | [`ConversationApiTest#streamSendsMemoryEventAndRemembers`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/chat/ConversationApiTest.java) | 接口（假模型） |
| 两个模型的 3 段多轮对话按录制结果走完 | [`ConversationReplayTest#conversationReplaysLikeReferenceImplementation`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/ConversationReplayTest.java) | 录制回放 |
| 时间戳经过数据库还在，过期照样判断 | [`JdbcChatMemoryIT#timestampsSurviveTheDatabaseSoTtlWorks`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/memory/JdbcChatMemoryIT.java) | 集成（真实 PostgreSQL） |
| 门槛扫描：nomic 取 0.72 反例全部短路 | [`OllamaEmbeddingIT#similarityThresholdSweep`](https://github.com/Clarence404/mall-assistant/blob/ch06-done/src/test/java/io/github/clarence404/assistant/knowledge/OllamaEmbeddingIT.java) | 集成（真实 Ollama） |

---

## 小结

- 模型没有状态，多轮对话就是每次把挑过的历史一起发过去；会话 ID 由页面生成（小写 UUID，存 localStorage），放在请求体 `conversationId`，不带时和第 5 章一样
- 记忆用 `ChatMemory`：默认内存、可选 PostgreSQL，空闲 30 分钟过期、每会话最多 40 条；同一会话一次一个请求，记忆挂了对话照常
- 提示词窗口按 6 轮 + 2000 字两道裁剪，一问一答一起丢；摘要记忆默认关，代价是多一次调用、可能丢细节
- 只存用户原话和最终回答，不存令牌、工具结果、RAG 资料；回答完成后才写，流式中途失败或取消不写
- 有历史时每轮先改写追问，意图识别和检索都用改写结果，六成字检查挡掉跑题的改写；订单号必须在原话或历史里原样出现，否则从最近 3 轮沿用
- 归属问商城 `/api/users/me`、按令牌指纹缓存 5 分钟，记忆键由归属 + 会话 ID 算成 UUID，别人的会话 404
- 没用 `MessageChatMemoryAdvisor`（调模型前就写、写的是拼了数据的那条）；Spring AI 2.0.2 要自己顶掉默认 ChatMemory、不用 JDBC Starter、延迟建库、借时间戳键判断过期
- RAG 门槛按向量模型分别配：bge-m3 0.6、nomic 0.72（正常题只剩 5/20，中文请用 bge-m3）；1.5b 的改写一半对一半错，换 haiku 两段追问都答对

> 本篇代码：[ch06-done](https://github.com/Clarence404/mall-assistant/tree/ch06-done) · 练习起点：[ch06-start](https://github.com/Clarence404/mall-assistant/tree/ch06-start)

## 参考资料

- Spring AI Reference · Chat Memory：[https://docs.spring.io/spring-ai/reference/api/chat-memory.html](https://docs.spring.io/spring-ai/reference/api/chat-memory.html)
- Spring AI Reference · Chat Client API：[https://docs.spring.io/spring-ai/reference/api/chatclient.html](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- Testcontainers · PostgreSQL Module：[https://java.testcontainers.org/modules/databases/postgres/](https://java.testcontainers.org/modules/databases/postgres/)
- Liu et al., Lost in the Middle: How Language Models Use Long Contexts：[https://arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172)
- OWASP Top 10 for LLM Applications（Prompt Injection）：[https://genai.owasp.org/llm-top-10/](https://genai.owasp.org/llm-top-10/)

> 下一篇：[售后 Agent 与人工确认](./7_agent)

---
description: 提示词模板与版本、意图识别结构化输出、解析重试与兜底、结果校验、拒答短路、录制回放测试
---

# Prompt 与结构化输出

> 前置阅读：[接入模型与流式对话](./1_model_streaming)、[Prompt 工程](../1_concepts/1_prompt)、[Spring AI](../2_frameworks/0_spring_ai)

第 2 章让小模型更「听话」，并拿到程序能直接用的结果：先识别意图，超出范围的直接拒答。本篇讲带变量、分版本的提示词模板，结构化输出的重试、兜底与校验，以及录制回放测试，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、本章做什么

![第 2 章的请求流程](../../assets/ai/mall-assistant-intent-flow.svg)

每条用户消息先过一次意图识别，再决定拒答还是交给回答模型。本章新增与改动的类：

| 类 | 职责 |
|----|------|
| `AssistantPrompts` / `PromptProperties` | 按 `assistant.prompt.version` 选系统提示词模板，每次请求渲染商城名、服务范围、今天的日期；渲染拒答话术 |
| `IntentService` | 调模型做意图识别，输出转成 `IntentResult`；解析失败重试一次，仍失败兜底 `UNKNOWN` |
| `Intent` / `IntentResult` | 6 种意图的枚举（宽松解析）；识别结果 record 与 `sanitized()` 校验 |
| `IntentController` | 新增 `POST /api/intent`，只返回识别结果 |
| `ChatService` / `ChatController` | 阻塞响应多一个 `intent` 字段，流式最先推 `intent` 事件；把握够大的 `OUT_OF_SCOPE` 直接回拒答话术 |

意图识别多花一次模型调用，换来两样东西：超出范围的问题省掉一次更慢的回答调用；第 3 章按意图决定调哪个工具，结构化的 `orderNo`、`skuId` 直接当参数用。

---

## 二、提示词模板与版本

第 1 章用 `defaultSystem` 固定了人设，本章人设里有「今天」这种每天都变的值，改成每次请求时渲染；`ChatClientConfig` 只剩 `builder.build()`，意图识别另有自己的系统提示词。

```java
public Resource systemTemplate() {
    String path = "prompts/system-" + properties.version() + ".st";
    Resource template = new ClassPathResource(path);
    if (!template.exists()) {
        throw new IllegalStateException(
                "找不到系统提示词模板 " + path + "，检查 assistant.prompt.version=" + properties.version());
    }
    return template;
}

public Map<String, Object> variables() {
    return Map.of(
            "shopName", properties.shopName(),
            "assistantName", properties.assistantName(),
            "supportScope", properties.supportScope(),
            "today", LocalDate.now(clock).format(TODAY));
}

public void applySystem(ChatClient.PromptSystemSpec spec) {
    spec.text(systemTemplate()).params(variables());
}
```

调用处写成 `chatClient.prompt().system(prompts::applySystem).user(message)`，阻塞与流式共用。

- **按版本存文件**：`prompts/system-v1.st`、`system-v2.st` 并排放，`assistant.prompt.version`（默认 `v2`）切换；改提示词时新增一个版本，旧版本留着对比与回滚
- **版本写错就起不来**：构造器里先调一次 `systemTemplate()`，文件不存在直接抛异常、应用启动失败，而不是等第一个用户提问才报错
- **变量每次重新算**：`today` 用注入的 `Clock` 取，测试可以固定「今天」；服务器常跑在 UTC，时钟按 `assistant.prompt.zone`（默认 `Asia/Shanghai`）创建，否则北京时间早上 8 点前会算成昨天
- **只在给了参数时才渲染**：Spring AI 2.0.2 下 `text(resource)` 不配 `params(...)` 就不经过模板引擎，`{shopName}` 会原样发给模型；给了参数但少一个，渲染时直接报错

v2 比 v1 多了几条更硬的规则：用户用英文提问也只用简体中文回答；与购物无关的请求（写代码、翻译、天气等）不回答内容本身；明确「你查不到任何订单、物流、库存、价格的实时信息」，绝不编造。v2 还带了三条 few-shot 示例，都是「查不到实时信息时怎么回」和「英文提问用中文答」。开发时加过一条拒答示例，0.5b 学成了几乎什么都拒答，于是拿掉：示例对小模型的影响比规则大得多，加一条就要用几条正常问题回归一遍。

模板外置与版本化、Few-shot 的写法见 [Prompt 工程 · 模板外置与版本化](../1_concepts/1_prompt#_2、模板外置与版本化) 与 [Prompt 工程 · Few-shot 提示](../1_concepts/1_prompt#三、few-shot-提示)，模板参数的用法见 [Spring AI · 模板参数](../2_frameworks/0_spring_ai#_1、模板参数)。

---

## 三、结构化输出：意图识别

识别结果是一个 record，字段上的 `@JsonPropertyDescription` 会写进 JSON Schema，等于给模型的字段说明：

```java
public record IntentResult(
        @JsonPropertyDescription("用户消息的意图") Intent intent,
        @JsonPropertyDescription("对分类有多大把握，0 到 1 之间的小数") double confidence,
        @JsonPropertyDescription("消息里的订单号（一串数字），没有则为 null") String orderNo,
        @JsonPropertyDescription("消息里的商品编号 SKU（一串数字），没有则为 null") String skuId) {}
```

`intent` 取 `ORDER_STATUS` / `PRODUCT_INFO` / `AFTER_SALES` / `CHITCHAT` / `OUT_OF_SCOPE` / `UNKNOWN` 之一，`prompts/intent-v1.st` 逐个说明含义并给 5 条示例。一次调用：

```java
IntentResult callModel(String message, boolean strict) {
    String template = strict ? USER_TEMPLATE + "\n\n" + STRICT_REMINDER : USER_TEMPLATE;
    try {
        return chatClient
                .prompt()
                .system(intentPrompt)
                .user(u -> u.text(template).param("message", message))
                .options(ChatOptions.builder().temperature(TEMPERATURE))
                .call()
                .entity(IntentResult.class, spec -> spec.useProviderStructuredOutput());
    } catch (JacksonException e) {
        log.info("意图识别：输出不是合法的 JSON：{}", e.getOriginalMessage());
        return null;
    } catch (RuntimeException e) {
        throw ModelCallException.from(e);
    }
}
```

- **`entity()` 背后是 `BeanOutputConverter`**：按 record 生成 JSON Schema，拿到输出后用 Jackson 反序列化，能容忍外面包一层 Markdown 代码块
- **默认做法是把格式说明拼进用户消息**：一大段英文的「Your response should be in JSON format…」加完整 Schema，接在用户消息后面
- **`useProviderStructuredOutput()` 把 Schema 交给厂商**：作为模型参数传过去（Ollama 的 `format`、OpenAI 的 `response_format`），由模型在解码时约束 JSON 结构，用户消息里不再有格式说明；不支持的模型自动退回拼进提示词
- **原生方式对小模型明显更好**：录制用的 12 条消息，qwen2.5:0.5b 在格式说明拼进提示词时只分对 2 条，改用原生方式分对 6 条；qwen2.5:1.5b 分对 11 条。长长的英文 Schema 说明本身就会干扰小模型
- **温度只在这一次调成 0**：`.options(ChatOptions.builder().temperature(0.0))` 是单次请求覆盖，分类要稳定可复现；回答仍用配置文件里的 0.3
- **用户原文用标签圈起来**：`USER_TEMPLATE` 把消息放进 `<message>…</message>`，模型更不容易把里面的话当成给它的指令

结构化输出的原理与各家协议见 [Prompt 工程 · 结构化输出](../1_concepts/1_prompt#五、结构化输出)，`.entity()` 的其他用法见 [Spring AI · 结构化输出](../2_frameworks/0_spring_ai#六、结构化输出)，隔离不可信内容见 [Prompt 工程 · 提示注入防护](../1_concepts/1_prompt#八、提示注入防护)。

---

## 四、解析失败怎么办

```java
public IntentResult classify(String message) {
    IntentResult result = callModel(message, false);
    if (result == null) {
        log.info("意图识别：模型输出无法解析，带上更严格的提醒重试一次");
        result = callModel(message, true);
    }
    if (result == null) {
        log.warn("意图识别：重试后仍无法解析，按 UNKNOWN 处理");
        return IntentResult.unknown();
    }
    return result.sanitized();
}
```

- **两类失败分开处理**：输出不是合法 JSON 是**格式问题**，换个说法再问一次可能就好了；连不上、超时是**服务问题**，重试也没用，转成 `ModelCallException` 原样抛出，接口照第 1 章返回 503
- **按异常类型区分**：Spring Boot 4 用的是 Jackson 3，解析异常是 `tools.jackson.core.JacksonException`（包名从 `com.fasterxml.jackson` 改成了 `tools.jackson`），它也是 `RuntimeException`，所以 `catch` 要写在 `RuntimeException` 前面
- **重试只一次，带一句提醒**：`STRICT_REMINDER` 是「注意：上一次的输出无法解析。这一次只输出一个 JSON 对象……」，追加在用户消息模板后面；最多两次模型调用，延迟可控
- **兜底 `UNKNOWN` 而不是报错**：意图识别是辅助步骤，识别不出来照常交给回答模型，`/api/intent` 也返回 200 和 `{"intent":"UNKNOWN","confidence":0.0}`，绝不把解析异常抛给用户
- **标签写错不算解析失败**：`Intent.from` 用 `@JsonCreator` 宽松解析，忽略大小写、空格与连字符（`order-status` 也认），认不出的记 `UNKNOWN`，不为一个标签重试

---

## 五、结果校验

模型输出「结构对了」不等于「内容对了」。录制文件里能看到 0.5b 把没有的字段写成字符串 `"null"` 或空串、把 `ABC123` 当订单号，所以解析成功后还要过一遍 `sanitized()`：

```java
public IntentResult sanitized() {
    Intent safeIntent = intent == null ? Intent.UNKNOWN : intent;
    double safeConfidence = Double.isNaN(confidence) ? 0.0 : Math.clamp(confidence, 0.0, 1.0);
    return new IntentResult(safeIntent, safeConfidence, valid(orderNo, ORDER_NO), valid(skuId, SKU_ID));
}
```

- **`confidence` 夹到 [0, 1]**：模型可能给 `95`（按百分制）或负数，NaN 记 0
- **订单号按业务格式校验**：`ORDER_NO` 是 `\d{19}|\d{23}`，对应 mall-evolution 的 19 位雪花 ID 或 19 位 + 4 位用户基因；位数不对多半是模型编的，置为 null，不往第 3 章的查单工具里传
- **SKU 必须是数字**：`\d{1,19}`，对应 mall-evolution 的 long 型 ID；「蓝牙耳机」「}」这种一律丢掉
- **record 不可变**：校验后返回新对象，去掉首尾空白后再匹配

---

## 六、拒答短路

```java
public ChatReply chat(String message) {
    IntentResult intent = intentService.classify(message);
    if (shouldRefuse(intent)) {
        return new ChatReply(prompts.refusal(), intent);
    }
    return new ChatReply(reply(message), intent);
}

boolean shouldRefuse(IntentResult intent) {
    return intent.intent() == Intent.OUT_OF_SCOPE && intent.confidence() >= properties.refuseMinConfidence();
}
```

- **只拒「把握够大的 `OUT_OF_SCOPE`」**：阈值 `assistant.chat.refuse-min-confidence` 默认 0.6。小模型经常判错，错拒一个正常问题比多答一句无关问题代价大，拿不准就交给回答模型，它的系统提示词里也有拒答规则
- **省一次模型调用**：拒答话术由 `prompts/refusal.st` 用同一套变量渲染（「抱歉，我是示例商城的客服小示，只能解答购物相关的问题……」），不调回答模型，几乎瞬间返回
- **`UNKNOWN` 照常回答**：解析失败兜底的 `UNKNOWN` 不触发拒答，识别失败不影响用户拿到回答
- 想关掉短路只看意图，把阈值调到 `1.1` 即可

---

## 七、流式里的意图事件

流式接口在第 1 章三种事件之前加一个 `intent` 事件，data 就是 `IntentResult`：

```java
return Mono.fromCallable(() -> intentService.classify(message))
        .flatMapMany(intent -> Flux.concat(
                Mono.just(event(StreamEvents.INTENT, intent)),
                chatService
                        .answerStream(message, intent)
                        .filter(text -> !text.isEmpty())
                        .map(text -> event(StreamEvents.TOKEN, new StreamEvents.Token(text)))))
        .concatWith(Mono.fromSupplier(() -> event(StreamEvents.DONE, StreamEvents.Done.stop())))
        .onErrorResume(e -> Mono.just(errorEvent(e)));
```

- **事件顺序**：正常回答是 `intent, token…, done`；拒答时 `answerStream` 返回 `Flux.just(refusal)`，只有 `intent, token, done`；意图识别时模型调不通，只有一个 `error`
- **识别放进 `Mono.fromCallable`**：意图识别是一次阻塞调用，包成 Mono 后它抛出的 `ModelCallException` 也走 `onErrorResume`，和回答阶段的错误是同一个出口
- **旧前端不受影响**：只认 `token` / `done` / `error` 的前端忽略 `intent` 即可；页面调试面板的「意图识别」一栏就读这个事件

事件格式与 `concatWith`、`onErrorResume` 的顺序见上一篇 [接入模型与流式对话 · SSE 事件设计](./1_model_streaming#七、sse-事件设计)。

---

## 八、录制回放测试

假模型只能验证「我们的代码」，结构化输出的难点在**真实模型会输出什么**：多一层代码块、字段写成 `"null"`、标签不在枚举里……手写假数据想不全。本章引入 [测试分层](./0_intro#四、llm-应用的测试分层) 的第二层：用真实模型跑一遍，把原样输出录下来，之后不联网回放。

| 文件 | 作用 |
|------|------|
| `recordings/intent-cases.json` | 要录制的 12 条用户消息，以及人工标注的期望意图 |
| `recordings/intent-qwen2.5-0.5b.json`、`intent-qwen2.5-1.5b.json` | 每条消息的每次模型调用：Prompt 指纹、模型原样输出，以及参考实现解析出的 `IntentResult` |
| `ReplayChatModel` | 按 Prompt 指纹查出录下的输出返回，查不到直接抛异常 |
| `IntentReplayTest` | 两个模型共 24 条录制逐条回放，断言解析结果和调用次数（含重试）与录制时一致，顺带打印准确率 |
| `IntentRecordingIT` | 录制工具，只有设置了环境变量 `RECORD_OLLAMA_URL` 才运行，CI 里永远跳过 |

- **指纹是「系统消息 + 用户消息」的 SHA-256**：改了意图提示词或用户消息模板，指纹就对不上，回放直接报「没有录制」并提示重新录制，而不是拿旧输出假装通过；但只改 `IntentResult` 的字段**不会**让指纹变化（原生结构化输出的 Schema 作为模型参数传出，不在消息文本里），这种情况要自己记得重新录制
- **断言「和录制时一致」，不断言「分类正确」**：分类对不对是模型的事，交给第 9 章的评估集；回放只保证代码对真实输出的处理（重试、兜底、校验）没有回退
- **回放要声明同样的能力**：录制时 Ollama 支持原生结构化输出，Schema 不在用户消息里；`ReplayChatModel` 的 `getOptions()` 也返回 `StructuredOutputChatOptions`，发出的 Prompt 和指纹才与录制时一致
- **重新录制**：设置 `RECORD_OLLAMA_URL`、`RECORD_OLLAMA_MODEL` 后单独跑 `IntentRecordingIT`（命令见仓库 `docs/ch02.md`），录完用 `git diff src/test/resources/recordings` 看模型输出变了什么；模型服务地址只从环境变量读，不写进录制文件

---

## 九、常见坑

- **0.5b 的 `confidence` 几乎总是 0.9**：它照抄了意图提示词示例里的值，判错时也是 0.9，所以 0.6 的阈值对它基本不起作用：录制里「订单 18492033857208325120001 怎么还没发货」被判成 `OUT_OF_SCOPE`、`confidence` 0.9，会被直接拒答。模型自评的把握只能作参考，更可靠的来源是多次采样投票、logprobs 或规则兜底；想体验正常效果换 `qwen2.5:1.5b`，或把阈值调到 `1.1` 关掉短路
- **模板里不能随手写花括号**：用户消息模板和重试提醒都要经过模板引擎渲染，`STRICT_REMINDER` 里写个 `{}` 示例就会被当成占位符报错；要在提示词里放 JSON 示例，只能放在不经渲染的文件里（如 `intent-v1.st` 作为 `system(Resource)` 直接传入，不配 `params`）
- **改一个字就要重新录制**：意图提示词、`USER_TEMPLATE` 任何一处改动都会让指纹失效，这是有意的；改 `IntentResult` 的字段指纹不会变，但模型的输出结构变了，同样要重录；不想每次都录，就先在提示词和字段定稿后再录
- **Windows 上指纹对不上**：Spring AI 拼格式说明时用的是系统换行符，Windows 上是 `\r\n`；`promptHash` 先把换行统一成 `\n` 再算哈希，否则在 Windows 录的文件到 Linux CI 上全部回放失败
- **v1 会编库存**：`--assistant.prompt.version=v1` 启动后问「这件外套有 XL 码吗」，v1 常常直接答「有的」，v2 会说查不到实时库存，请以商品页为准；对比时两版都用同一个模型

---

## 十、验证

下表列出本篇关键结论与证明它的测试；本章代码在 `ch02-done` 上跑完整构建的结果见 [测试报告](https://clarence404.github.io/mall-assistant/reports/ch02-done/)。

| 结论 | 测试 | 类型 |
|------|------|------|
| 版本号写错时启动失败，错误信息带上找不到的模板文件名 | [`AssistantPromptsTest#unknownVersionFailsFastAtStartup`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/prompt/AssistantPromptsTest.java) | 单元 |
| 发给模型的系统消息已渲染，带商城名与按商城时区的今天，不剩占位符 | [`AssistantPromptsTest#renderedSystemMessageHasNoPlaceholdersLeft`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/prompt/AssistantPromptsTest.java) | 单元 |
| Schema 作为模型参数交给厂商、用户消息里没有格式说明，温度为 0 | [`IntentServiceTest#schemaGoesToProviderAndTemperatureIsZero`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/intent/IntentServiceTest.java) | 单元 |
| 输出解析不了时带提醒重试一次，仍失败兜底 `UNKNOWN`，恰好 2 次调用 | [`IntentServiceTest#garbageIsRetriedOnceWithStricterReminderThenFallsBackToUnknown`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/intent/IntentServiceTest.java) | 单元 |
| 模型连不上时不重试，抛出 `MODEL_UNAVAILABLE` | [`IntentServiceTest#modelUnavailableIsNotSwallowed`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/intent/IntentServiceTest.java) | 单元 |
| 订单号只认 19 或 23 位数字，其余置为 null | [`IntentResultTest#orderNoMustLookLikeMallOrderNo`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/intent/IntentResultTest.java) | 单元 |
| 把握够大的 `OUT_OF_SCOPE` 直接回拒答话术，不调回答模型 | [`IntentApiTest#outOfScopeIsRefusedWithoutCallingAnswerModel`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/chat/IntentApiTest.java) | 接口（假模型） |
| 流式接口先推 `intent` 事件，再推 `token` 与 `done` | [`IntentApiTest#streamStartsWithIntentEvent`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/chat/IntentApiTest.java) | 接口（假模型） |
| 两个模型的 24 条真实输出逐条回放，解析结果与调用次数和录制时一致 | [`IntentReplayTest#replayedOutputParsesLikeReferenceImplementation`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/intent/IntentReplayTest.java) | 录制回放 |
| 真实 Ollama + `qwen2.5:0.5b` 把「我的订单 1849203385720832512 到哪了？」识别为 `ORDER_STATUS` | [`OllamaChatIT#obviousOrderQuestionIsOrderStatus`](https://github.com/Clarence404/mall-assistant/blob/ch02-done/src/test/java/io/github/clarence404/assistant/chat/OllamaChatIT.java) | 集成（真实 Ollama） |

「录制回放」不联网、每次 `./mvnw verify` 都跑；录制工具 `IntentRecordingIT` 只在设置了 `RECORD_OLLAMA_URL` 时运行。

---

## 小结

- 系统提示词按 `assistant.prompt.version` 选 `prompts/system-<版本>.st`，版本不存在启动失败；变量每次请求重新渲染，`today` 按商城时区；不传参数时 Spring AI 不渲染模板
- v2 加了只用简体中文、绝不编造实时信息等规则；few-shot 示例对小模型影响很大，拒答示例让 0.5b 什么都拒，已拿掉
- 意图识别用 `entity()` + `useProviderStructuredOutput()`，Schema 交给 Ollama 的 `format`，温度单次调成 0；0.5b 上比拼进提示词准得多（6/12 对 2/12）
- JSON 解析失败（`JacksonException`）带提醒重试一次，仍失败兜底 `UNKNOWN`；连不上、超时不重试，照常 503
- `sanitized()` 夹紧 `confidence`、按 mall-evolution 的格式校验订单号与 SKU；把握够大的 `OUT_OF_SCOPE` 直接回拒答话术，省一次模型调用
- 流式接口最先推 `intent` 事件；录制回放按 Prompt 指纹回放真实输出，提示词一改就要求重新录制

> 本篇代码：[ch02-done](https://github.com/Clarence404/mall-assistant/tree/ch02-done) · 练习起点：[ch02-start](https://github.com/Clarence404/mall-assistant/tree/ch02-start)

## 参考资料

- Spring AI Reference · Structured Output Converter：[https://docs.spring.io/spring-ai/reference/api/structured-output-converter.html](https://docs.spring.io/spring-ai/reference/api/structured-output-converter.html)
- Spring AI Reference · Chat Client API：[https://docs.spring.io/spring-ai/reference/api/chatclient.html](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- Spring AI Reference · Prompts：[https://docs.spring.io/spring-ai/reference/api/prompt.html](https://docs.spring.io/spring-ai/reference/api/prompt.html)
- Ollama · Structured Outputs：[https://docs.ollama.com/capabilities/structured-outputs](https://docs.ollama.com/capabilities/structured-outputs)

> 下一篇：[工具调用](./3_tool_calling)

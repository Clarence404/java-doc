---
description: ChatClient 与系统提示词、阻塞与流式超时、错误归类、ProblemDetail、SSE 事件设计、切换模型厂商
---

# 接入模型与流式对话

> 前置阅读：[AI 应用实战概览](./0_intro)、[Spring AI](../2_frameworks/0_spring_ai)、[SSE（Server-Sent Events）](/netty/11_sse)

第 1 章把模型接进智能客服，做出阻塞与 SSE 流式两个接口，模型挂了或超时都只给用户一句人话。本篇讲系统提示词、两种调用的超时、错误归类与响应、SSE 事件设计，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、请求链路

![一次对话请求的流转](../../assets/ai/mall-assistant-chat-flow.svg)

本章的全部后端代码就是图上这几个类：

| 类 | 职责 |
|----|------|
| `ChatController` | `POST /api/chat` 返回 `{"reply": …}`；`POST /api/chat/stream` 返回 `text/event-stream` |
| `ChatService` | 调 `ChatClient`，阻塞调用包 try/catch，流式调用加空闲超时，失败统一转成 `ModelCallException` |
| `ChatClientConfig` | 用自动配置的 `ChatClient.Builder` 加上系统提示词 |
| `ModelCallException` / `ModelFailure` | 把各种底层异常归成 `MODEL_TIMEOUT`、`MODEL_UNAVAILABLE` 两类，枚举里放给用户看的提示语 |
| `ApiExceptionHandler` | 阻塞接口的错误出口：503 + ProblemDetail |

失败分两条路：阻塞接口抛出的 `ModelCallException` 由 `ApiExceptionHandler` 转成 503；流式接口的错误在 `ChatController` 里用 `onErrorResume` 换成一个 `error` 事件。两条路用同一套错误码，前端只认 `code`。

---

## 二、系统提示词与 ChatClient

`ChatClient.Builder` 由 Spring AI 自动配置注入，背后是 Ollama 还是 OpenAI 兼容接口由 `spring.ai.model.chat` 决定，这里只负责「人设」：

```java
@Bean
public ChatClient chatClient(
        ChatClient.Builder builder, @Value("classpath:prompts/system.st") Resource systemPrompt) {
    return builder.defaultSystem(systemPrompt).build();
}
```

- `defaultSystem` 设置的是默认系统消息，之后每次 `prompt()` 都自动带上，业务代码只管写 `user(message)`
- 提示词放在 `src/main/resources/prompts/system.st`，不写死在 Java 字符串里：改措辞不用动代码，评审时 diff 也清楚；第 2 章的模板参数也从这里开始
- 提示词里写清楚身份（「示例商城」客服「小示」）、语言与长度（只用简体中文、一般不超过三句）、范围（只答商城相关）、底线（不编造订单状态、库存、价格、物流单号）

Prompt 怎么写见 [Prompt 工程](../1_concepts/1_prompt)，Builder 的其他默认项见 [Spring AI · 注入 ChatClient](../2_frameworks/0_spring_ai#_3、注入-chatclient)。

---

## 三、阻塞调用与超时

```java
public String reply(String message) {
    try {
        String content = chatClient.prompt().user(message).call().content();
        return Objects.requireNonNullElse(content, "");
    } catch (RuntimeException e) {
        throw ModelCallException.from(e);
    }
}
```

阻塞调用要等模型把整段回答生成完，超时靠 HTTP 客户端的读超时，在 `application.yml` 统一配置：

```yaml
  http:
    clients:                 # 作用于自动配置的 RestClient（阻塞调用）与 WebClient（流式调用）
      connect-timeout: 3s
      read-timeout: 60s      # 阻塞调用要等整段回答生成完，给足时间；流式调用是两段之间的间隔
  ai:
    retry:                   # 默认会重试 10 次、指数退避，模型挂了要等好几分钟才报错；客服场景快速失败
      max-attempts: 1
      backoff:
        initial-interval: 500ms
        max-interval: 2s
```

- **连接超时短、读超时长**：连不上说明服务没起，3 秒足够判断；读超时要覆盖小模型在 CPU 上生成一整段回答的时间
- **重试调到 1 次**：Spring AI 默认对模型调用重试多次并指数退避，模型真挂了时用户要等几分钟才看到报错，还会把本就过载的模型服务压得更死。客服是交互场景，快速失败、让用户稍后再问（响应带 `Retry-After`）比后台默默重试更好；`openai` profile 里 OpenAI 客户端自己的 `max-retries` 也设成了 1
- **整体兜底**：`spring.mvc.async.request-timeout: 3m` 限制流式接口一次请求的最长时长

超时与重试的通用取舍见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 四、流式调用

```java
public Flux<String> stream(String message) {
    return chatClient.prompt().user(message).stream()
            .content()
            .timeout(properties.streamTimeout())
            .onErrorMap(ModelCallException::from);
}
```

- **`Flux#timeout` 是空闲超时，不是总时长**：从订阅起等第一个元素、之后每两个元素之间，超过 `assistant.chat.stream-timeout`（默认 30s）没有新片段就以 `TimeoutException` 结束。长回答只要一直在吐字就不会被掐断，模型卡住不动才会超时
- **`onErrorMap` 只换异常类型**：上游任何错误（连接失败、读超时、`TimeoutException`）都换成 `ModelCallException`，已经发出的片段不受影响，下游的 Controller 只需要处理一种异常
- 流式调用底层走 WebClient，`read-timeout` 在这里约束的也是两段之间的间隔；两层超时谁先到算谁，结果都归为 `MODEL_TIMEOUT`

`stream().content()` 只给文本片段，需要 Token 用量、结束原因时改用 `stream().chatResponse()`，见 [Spring AI · 流式输出](../2_frameworks/0_spring_ai#_3、流式输出)。

---

## 五、错误归类

底层抛出来的异常五花八门：`ResourceAccessException` 包着 `ConnectException` 或 `SocketTimeoutException`，Reactor 的 `TimeoutException`，Netty 的 `ReadTimeoutException`，Spring AI 的 `TransientAiException` / `NonTransientAiException`。给用户只需要两类：超时，或者不可用。

```java
public static ModelCallException from(Throwable error) {
    if (error instanceof ModelCallException alreadyClassified) {
        return alreadyClassified;
    }
    ModelFailure failure = isTimeout(error) ? ModelFailure.MODEL_TIMEOUT : ModelFailure.MODEL_UNAVAILABLE;
    return new ModelCallException(failure, error);
}

private static boolean isTimeout(Throwable error) {
    Throwable current = error;
    for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
        if (current instanceof TimeoutException // Reactor 的 Flux.timeout
                || current instanceof SocketTimeoutException // RestClient 阻塞调用读超时
                || current instanceof HttpTimeoutException // JDK HttpClient
                // Netty 的 ReadTimeoutException 等第三方超时异常，按类名识别，避免编译期依赖它们
                || current.getClass().getSimpleName().endsWith("TimeoutException")) {
            return true;
        }
        current = current.getCause();
    }
    return false;
}
```

- **沿 cause 链找**：超时异常常被包好几层，只看最外层会把读超时误判成不可用
- **深度上限 16**：cause 链理论上可以成环或很深，设上限避免死循环，正常的包装不会超过几层
- **Netty 按类名后缀识别**：不为了一个 `instanceof` 引入 Netty 的编译期依赖，换 HTTP 客户端实现也不用改这里
- **已归类的原样返回**：`ChatService` 里已经转过一次，Controller 的 `onErrorResume` 再调 `from` 不会套第二层，也不会把 `MODEL_TIMEOUT` 重新判成 `MODEL_UNAVAILABLE`
- **保留原始 cause**：给用户的只有错误码和提示语，原始异常留给日志排查

---

## 六、错误响应

```java
@ExceptionHandler(ModelCallException.class)
public ResponseEntity<ProblemDetail> handleModelFailure(ModelCallException e) {
    ModelFailure failure = e.failure();
    // 细节只进日志，不给前端
    log.warn("调用模型失败：{}", failure, e.getCause());
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, failure.message());
    problem.setTitle(failure.title());
    problem.setProperty("code", failure.name());
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .header(HttpHeaders.RETRY_AFTER, "5")
            .body(problem);
}
```

响应体是 `application/problem+json`：`title` 为「模型服务暂时不可用」，`status` 为 503，`detail` 为「智能客服暂时无法连接模型服务，请稍后再试。」，再加一个扩展字段 `"code": "MODEL_UNAVAILABLE"`。

- **两类都返回 503**：无论超时还是连不上，对调用方来说都是「服务暂时不可用、稍后可以再试」，不用 504（那是网关等上游超时的语义）也不用 500（不是本服务的 bug）
- **`code` 扩展字段**：前端和日志按 `code` 区分原因，`detail` 是给用户看的中文提示，由 `ModelFailure` 枚举统一维护
- **`Retry-After: 5`**：告诉客户端多久后再试，和关掉重试相呼应：服务端不重试，把节奏交给用户
- **细节只进日志**：异常类名、堆栈、模型服务地址都不出现在响应里，配合 `server.error.include-stacktrace: never` 与 `include-message: never`；参数校验失败（400）交给 `spring.mvc.problemdetails.enabled=true` 自带的 ProblemDetail

ProblemDetail 的字段约定见 [API 设计规范 · 错误响应：Problem Details](/engineering/4_api_design_rule#五、错误响应-problem-details)。

---

## 七、SSE 事件设计

流式接口推三种事件，名字和 data 结构固定在 `StreamEvents` 里：

| 事件 | data | 含义 |
|------|------|------|
| `token` | `{"text": "签收后"}` | 一段增量文本，前端按顺序拼接 |
| `done` | `{"reason": "stop"}` | 正常结束，之后连接关闭 |
| `error` | `{"code": "MODEL_UNAVAILABLE", "message": "…"}` | 出错结束，之后连接关闭，不再有 `done`；`code` 与阻塞接口一致 |

```java
@PostMapping(value = "/api/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<Object>> stream(@Valid @RequestBody ChatRequest request) {
    return chatService.stream(request.message())
            .filter(text -> !text.isEmpty())
            .map(text -> event(StreamEvents.TOKEN, new StreamEvents.Token(text)))
            .concatWith(Mono.fromSupplier(() -> event(StreamEvents.DONE, StreamEvents.Done.stop())))
            .onErrorResume(e -> Mono.just(errorEvent(e)));
}
```

- **data 用 JSON 不用纯文本**：模型的增量片段里常有换行和前导空格。SSE 规定一条 `data:` 只占一行，片段里的换行会被拆成多行 data，冒号后的一个空格也会被解析器吃掉；包成 JSON 后换行变成 `\n`、空格在引号里，前端拿到的就是原文
- **错误必须是事件**：流式响应一开始就以 200 和 `text/event-stream` 写出了响应头，之后出错已经改不了状态码，也没法再写一个 ProblemDetail；只能在流里推一个 `error` 事件，前端按事件名区分正常结束和出错
- **`concatWith` 在前、`onErrorResume` 在后**：`concatWith` 只在上游**正常完成**时才接上 `done`；上游出错时错误越过 `concatWith` 到达 `onErrorResume`，被换成一个 `error` 事件后结束，于是出错时只有 `token…, error`，不会再有 `done`。两者顺序反过来，`error` 之后还会跟一个 `done`
- **`Mono.fromSupplier`**：`done` 事件在上游结束后才构造，不在组装 Flux 时提前创建
- **`filter` 丢空片段**：有的模型会推空字符串，过滤掉避免前端收到空 `token`

Spring MVC 直接支持返回 `Flux`：每个元素写成一条 SSE，Flux 结束时关闭连接，不需要手动管理 `SseEmitter`。SSE 的协议格式、重连与网关缓冲问题见 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 八、本章代码的提供方切换

代码里没有任何厂商相关的类，换模型厂商只换 profile：

```yaml
# application-ollama.yml（默认 profile）
spring:
  ai:
    model:
      chat: ollama
    ollama:
      base-url: ${OLLAMA_BASE_URL:http://localhost:11434}
      chat:
        model: ${OLLAMA_CHAT_MODEL:qwen2.5:0.5b}
        temperature: 0.3
        keep-alive: 10m
```

- `application.yml` 里 `spring.profiles.default: ollama`，不指定 profile 就用本机 Ollama
- `--spring.profiles.active=openai` 切到任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问兼容模式、vLLM、Ollama 的 `/v1`），地址、密钥、模型名来自 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` 或不入库的 `application-local.yml`
- 两个 Starter 同时在类路径上，`spring.ai.model.chat` 决定启用哪一个；本章只用对话模型，embedding、image 等其余能力设为 `none`，免得 openai Starter 要求配置 api-key
- `ProviderSwitchTest` 只启动上下文、不发请求，确认默认 profile 下是 `OllamaChatModel`、`openai` profile 下是 `OpenAiChatModel`

各家接入方式的差异见 [API 直接接入](../3_integration/1_api_access) 与 [Spring AI · 多模型 Starter](../2_frameworks/0_spring_ai#_3、多模型-starter)。

---

## 九、常见坑

- **0.5b 模型不听系统提示词**：`qwen2.5:0.5b` 经常答非所问、用英文回答或超出三句话。这是模型能力问题，不是代码问题；换 `qwen3:0.6b` 或更大的模型对比（`OLLAMA_CHAT_MODEL` 环境变量），第 2 章再用 Prompt 技巧和结构化输出改善。集成测试因此只断言「回答里有中文」「以 `done` 结束」，不断言具体内容
- **Windows 终端用 curl 测试乱码或 400**：Windows PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，要写 `curl.exe`；命令行参数里的中文按系统代码页（GBK）传给 curl，后端按 UTF-8 解析会乱码甚至报 JSON 解析错误。把请求体存成 UTF-8 文件再用 `curl.exe -N -H "Content-Type: application/json" --data-binary "@body.json" http://localhost:8088/api/chat/stream` 发送，输出乱码时先执行 `chcp 65001`；最省事的是直接用页面测试
- **端口冲突**：Spring Boot 默认端口 8080 与 mall-evolution 的 `mall-app` 冲突，第 3 章两个项目要同时运行，所以本仓库默认用 8088，可用环境变量 `SERVER_PORT` 修改

---

## 十、验证

下表列出本篇关键结论与证明它的测试；本章代码在 `ch01-done` 上跑完整构建的结果见 [测试报告](https://clarence404.github.io/mall-assistant/reports/ch01-done/)。

| 结论 | 测试 | 类型 |
|------|------|------|
| 系统提示词来自 classpath，每次请求都带上 | [`ChatServiceTest#systemPromptFromClasspathIsSentWithEveryRequest`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/ChatServiceTest.java) | 单元 |
| 超时异常无论包在 cause 链哪一层，都归为 `MODEL_TIMEOUT` | [`ModelCallExceptionTest#timeoutsAnywhereInCauseChainAreModelTimeout`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/error/ModelCallExceptionTest.java) | 单元 |
| 已归类的异常原样返回，不重复包装 | [`ModelCallExceptionTest#alreadyClassifiedExceptionIsReturnedAsIs`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/error/ModelCallExceptionTest.java) | 单元 |
| 模型一直不出片段时，流式调用按空闲超时结束，归为 `MODEL_TIMEOUT` | [`ChatServiceTest#streamTimesOutWhenModelStaysSilent`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/ChatServiceTest.java) | 单元 |
| 模型不可用时阻塞接口返回 503 ProblemDetail，带 `code` 与 `Retry-After`，不含异常类名与内部地址 | [`ChatApiTest#modelUnavailableBecomes503ProblemDetail`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/ChatApiTest.java) | 接口（假模型） |
| 流式接口推多个 `token` 后以 `done` 结束，片段里的换行原样保留 | [`ChatStreamApiTest#streamsTokenEventsThenDone`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/ChatStreamApiTest.java) | 接口（假模型） |
| 流式中途失败时推 `token…, error`，没有 `done`，不暴露异常信息 | [`ChatStreamApiTest#failureEndsStreamWithErrorEventAndNoDone`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/ChatStreamApiTest.java) | 接口（假模型） |
| 真实 Ollama + `qwen2.5:0.5b` 下流式接口有中文回答且以 `done` 结束 | [`OllamaChatIT#streamCompletesWithTokensAndDone`](https://github.com/Clarence404/mall-assistant/blob/ch01-done/src/test/java/io/github/clarence404/assistant/chat/OllamaChatIT.java) | 集成（真实 Ollama） |

「接口（假模型）」指整个应用用 MockMvc 跑起来、只把 `ChatModel` 换成 `FakeChatModel`；集成测试在没有 Docker 的机器上自动跳过，CI 上真实执行。

---

## 小结

- `ChatClient.Builder` 由 Starter 按 `spring.ai.model.chat` 提供，`defaultSystem` 从 classpath 加载人设，业务代码只写 `user(message)`
- 阻塞调用靠 HTTP 客户端 `read-timeout`；流式调用靠 `Flux#timeout`，它是首段与相邻两段之间的空闲超时，不是总时长；`spring.ai.retry.max-attempts` 调到 1，快速失败
- `ModelCallException.from` 沿 cause 链（最多 16 层）找超时，Netty 按类名后缀识别，已归类的原样返回，其余一律算不可用
- 阻塞接口返回 503 + ProblemDetail，带 `code` 与 `Retry-After`，细节只进日志
- 流式接口推 `token` / `done` / `error` 三种 JSON 事件；200 已经写出后错误只能是事件，`concatWith` 在前、`onErrorResume` 在后，保证出错时没有 `done`
- 换模型厂商只换 profile（`ollama` / `openai`），代码不动

> 本篇代码：[ch01-done](https://github.com/Clarence404/mall-assistant/tree/ch01-done) · 练习起点：[ch01-start](https://github.com/Clarence404/mall-assistant/tree/ch01-start)

## 参考资料

- Spring AI Reference · Chat Client API：[https://docs.spring.io/spring-ai/reference/api/chatclient.html](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- Spring AI Reference · Ollama Chat：[https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html](https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html)
- Ollama API：[https://docs.ollama.com/api](https://docs.ollama.com/api)
- WHATWG HTML Standard · Server-sent events：[https://html.spec.whatwg.org/multipage/server-sent-events.html](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- RFC 9457 · Problem Details for HTTP APIs：[https://www.rfc-editor.org/rfc/rfc9457](https://www.rfc-editor.org/rfc/rfc9457)
- Reactor Flux#timeout：[https://projectreactor.io/docs/core/release/api/reactor/core/publisher/Flux.html#timeout-java.time.Duration-](https://projectreactor.io/docs/core/release/api/reactor/core/publisher/Flux.html#timeout-java.time.Duration-)

> 返回：[AI 总览](../0_overview)

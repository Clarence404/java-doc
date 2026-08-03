# API 直接接入

> 参考资料：
> * OpenAI 官方文档：[https://platform.openai.com/docs](https://platform.openai.com/docs)
> * Gemini API 文档：[https://ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs)
> * Anthropic 官方文档：[https://docs.anthropic.com](https://docs.anthropic.com)

---

## 一、OpenAI

### 模型总览

| 模型 | 别名 | 用途 | 上下文窗口 | 价格（输入 / 输出，/MTok） |
|------|------|------|-----------|--------------------------|
| gpt-5.6-sol | gpt-5.6 | 旗舰推理与编程 | 1.05M tokens | $5 / $30 |
| gpt-5.6-terra | — | 智能与成本均衡 | 1.05M tokens | $2.50 / $15 |
| gpt-5.6-luna | — | 高性价比高吞吐 | 1.05M tokens | $1 / $6 |
| text-embedding-3-small | — | 文本向量化 | 8191 tokens | 按 Token 计费，RAG 首选 |

### 官方 Java SDK

```xml
<dependency>
    <groupId>com.openai</groupId>
    <artifactId>openai-java</artifactId>
    <version>4.46.0</version>
</dependency>
```

```java
import com.openai.client.OpenAIClient;
import com.openai.client.okhttp.OpenAIOkHttpClient;
import com.openai.models.chat.completions.*;
import com.openai.models.ChatModel;

OpenAIClient client = OpenAIOkHttpClient.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .build();

ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_LUNA)
        .maxTokens(512)
        .addSystemMessage("你是一位 Java 后端专家，回答简洁专业。")
        .addUserMessage("请解释 Java 虚拟线程的使用场景。")
        .build();

String content = client.chat().completions().create(params)
        .choices().get(0).message().content().orElse("");
```

**流式响应：**

```java
try (Stream<ServerSentEvent<ChatCompletionChunk>> stream =
             client.chat().completions().createStreaming(params).stream()) {
    stream.forEach(event -> {
        ChatCompletionChunk chunk = event.data();
        if (chunk != null) {
            chunk.choices().forEach(choice ->
                choice.delta().content().ifPresent(System.out::print)
            );
        }
    });
}
```

### Spring AI 接入

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
</dependency>
```

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        model: gpt-5.6-luna
        temperature: 0.7
        max-tokens: 1024
      embedding:
        model: text-embedding-3-small
```

### Function Calling

定义工具 → 第一轮获取 `tool_call` → 执行函数 → 第二轮回传结果，与其他厂商模式一致，详见官方文档。

### 限流与费用

OpenAI 按账户消费分 Tier 1–5，Tier 越高 RPM / TPM 越大。遇到 `RateLimitException` 时使用指数退避重试：

```java
public ChatCompletion createWithRetry(OpenAIClient client,
                                      ChatCompletionCreateParams params) {
    int maxRetries = 5;
    long delayMs = 1000;
    for (int i = 0; i < maxRetries; i++) {
        try {
            return client.chat().completions().create(params);
        } catch (RateLimitException e) {
            if (i == maxRetries - 1) throw e;
            Thread.sleep(delayMs * (1L << i));
        }
    }
    throw new RuntimeException("超过最大重试次数");
}
```

---

## 二、Gemini

### 模型总览

| 模型 | 状态 | 用途 | 上下文窗口 |
|------|------|------|-----------|
| gemini-3.5-flash | 稳定版 | Agent / 编程任务首选 | 1M tokens |
| gemini-3.1-flash-lite | 稳定版 | 高频低成本调用 | 1M tokens |
| gemini-3.1-pro-preview | 预览版 | 高级推理与复杂分析 | 1M tokens |
| gemini-embedding-2 | 稳定版 | 多模态向量化 | 8K tokens |

> 1M tokens 超长上下文，特别适合整个代码库分析、长文档场景。

### 官方 Java SDK

```xml
<dependency>
    <groupId>com.google.genai</groupId>
    <artifactId>google-genai</artifactId>
    <version>1.64.0</version>
</dependency>
```

```java
import com.google.genai.Client;
import com.google.genai.types.*;

Client client = Client.builder()
        .apiKey(System.getenv("GEMINI_API_KEY"))
        .build();

GenerateContentResponse response = client.models().generateContent(
        "gemini-3.5-flash",
        Content.builder()
                .role("user")
                .addPart(Part.fromText("请用三句话解释 Redis 的持久化机制。"))
                .build(),
        null
);
System.out.println(response.text());
```

**多模态（图片 + 文本）：**

```java
byte[] imageBytes = Files.readAllBytes(Paths.get("architecture.png"));
GenerateContentResponse response = client.models().generateContent(
        "gemini-3.5-flash",
        Content.builder()
                .role("user")
                .addPart(Part.fromBytes(imageBytes, "image/png"))
                .addPart(Part.fromText("请描述这张架构图中各个服务的职责。"))
                .build(),
        null
);
```

**流式响应：**

```java
try (ResponseStream<GenerateContentResponse> stream = client.models().generateContentStream(
        "gemini-3.5-flash",
        Content.builder().role("user").addPart(Part.fromText("...")).build(), null)) {
    for (GenerateContentResponse chunk : stream) {
        System.out.print(chunk.text());
    }
}
```

### Spring AI 接入

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-google-genai</artifactId>
</dependency>
```

```yaml
spring:
  ai:
    google:
      genai:
        api-key: ${GEMINI_API_KEY}
        chat:
          model: gemini-3.5-flash
          temperature: 0.7
          max-output-tokens: 2048
```

> **Google AI Studio vs Vertex AI**：AI Studio 用 API Key，适合开发测试；Vertex AI 用 Google Cloud 服务账号，适合生产与企业合规场景。

---

## 三、Claude（Anthropic）

### 模型总览

| 模型 | 用途 | 上下文窗口 | 价格（输入 / 输出，/MTok） |
|------|------|-----------|--------------------------|
| claude-fable-5 | 顶级智能 / 长时间 Agent 任务 | 1M tokens | $10 / $50 |
| claude-opus-5 | 复杂 Agent 编程与企业级任务 | 1M tokens | $5 / $25 |
| claude-sonnet-5 | 智能与速度均衡，生产主力 | 1M tokens | $3 / $15 |
| claude-haiku-4-5-20251001 | 高吞吐低延迟任务 | 200K tokens | $1 / $5 |

### 官方 Java SDK

```xml
<dependency>
    <groupId>com.anthropic</groupId>
    <artifactId>anthropic-java</artifactId>
    <version>2.52.0</version>
</dependency>
```

```java
import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.models.messages.*;

AnthropicClient client = AnthropicOkHttpClient.builder()
        .apiKey(System.getenv("ANTHROPIC_API_KEY"))
        .build();

MessageCreateParams params = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .system("你是一位专业的 Java 后端架构师，回答精确且有深度。")
        .addUserMessage("请解释 Java 虚拟线程与平台线程的核心区别。")
        .build();

Message message = client.messages().create(params);
message.content().forEach(block ->
    block.asText().ifPresent(text -> System.out.println(text.text()))
);
```

**流式响应：**

```java
try (StreamResponse<RawMessageStreamEvent> stream =
             client.messages().createStreaming(params)) {
    stream.stream().forEach(event -> {
        if (event.isContentBlockDelta()) {
            event.asContentBlockDelta().delta().asText()
                    .ifPresent(t -> System.out.print(t.text()));
        }
    });
}
```

### Spring AI 接入

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-anthropic</artifactId>
</dependency>
```

```yaml
spring:
  ai:
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}
      chat:
        model: claude-sonnet-5
        max-tokens: 2048
        temperature: 0.7
```

### Prompt Caching（提示缓存）

缓存长 System Prompt 或大段文档，**命中时仅收取 10% 费率**，可节省高达 90% Token 费用。

```java
MessageCreateParams params = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .system(List.of(
                TextBlockParam.builder()
                        .text("你是 Acme 公司专属助手，以下是公司代码规范（共 5000 字）：...")
                        .cacheControl(CacheControlEphemeral.builder().build())
                        .build()
        ))
        .addUserMessage("帮我 review 这段 Service 代码是否符合规范。")
        .build();

// 查看缓存统计
response.usage().cacheReadInputTokens()
        .ifPresent(n -> System.out.println("缓存命中 tokens：" + n));
```

适用场景：长系统提示词、RAG 文档块、Few-shot 示例、代码库分析。

---

## 四、框架选型对比

| 维度 | Spring AI | 官方 SDK（各厂商）|
|------|-----------|-----------------|
| 接入成本 | 低，自动配置 + 统一 API | 中，需熟悉各厂商特定概念 |
| 多模型切换 | 换 Starter + yaml 即可 | 各套 SDK 互不兼容 |
| 功能覆盖 | Chat / Embedding / Tool 基础能力 | 全量 API（Caching / Batch / Vision 等） |
| 推荐场景 | 企业多模型集成、快速原型 | 深度使用厂商特有功能 |

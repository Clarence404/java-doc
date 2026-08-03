# OpenAI API

> 参考资料：
> * OpenAI 官方文档：[https://platform.openai.com/docs](https://platform.openai.com/docs)
> * OpenAI Java SDK：[https://github.com/openai/openai-java](https://github.com/openai/openai-java)
> * Spring AI OpenAI：[https://docs.spring.io/spring-ai/reference/api/chat/openai-chat.html](https://docs.spring.io/spring-ai/reference/api/chat/openai-chat.html)

---

## 一、模型总览

> gpt-4o / o3 系列已进入 Legacy 状态，新项目请使用 GPT-5.6 系列。

| 模型 | 别名 | 用途 | 上下文窗口 | 输入/输出价格（/MTok） |
|------|------|------|-----------|----------------------|
| gpt-5.6-sol | gpt-5.6 | 旗舰推理与编程 | 1.05M tokens | $5 / $30 |
| gpt-5.6-terra | — | 智能与成本均衡 | 1.05M tokens | $2.50 / $15 |
| gpt-5.6-luna | — | 高性价比高吞吐 | 1.05M tokens | $1 / $6 |
| text-embedding-3-small | — | 文本向量化 | 8191 tokens | 按 Token 计费，RAG/语义搜索首选 |

---

## 二、官方 Java SDK 快速接入

### Maven 依赖

```xml
<dependency>
    <groupId>com.openai</groupId>
    <artifactId>openai-java</artifactId>
    <version>4.46.0</version>
</dependency>
```

### 初始化客户端

```java
import com.openai.client.OpenAIClient;
import com.openai.client.okhttp.OpenAIOkHttpClient;

OpenAIClient client = OpenAIOkHttpClient.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .build();
```

### Chat Completions 基础调用

```java
import com.openai.models.chat.completions.*;
import com.openai.models.ChatModel;

ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_LUNA)
        .maxTokens(512)
        .addSystemMessage("你是一位 Java 后端专家，回答简洁专业。")
        .addUserMessage("请解释 Java 虚拟线程的使用场景。")
        .build();

ChatCompletion completion = client.chat().completions().create(params);

String content = completion.choices().get(0).message().content().orElse("");
System.out.println(content);
```

---

## 三、流式响应

```java
import com.openai.models.chat.completions.ChatCompletionChunk;
import java.util.stream.Stream;

ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_LUNA)
        .addUserMessage("用一段话介绍 Spring Boot 自动配置原理。")
        .build();

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
System.out.println(); // 换行
```

---

## 四、Function Calling / Tool Use

### 定义工具

```java
import com.openai.models.chat.completions.*;
import com.openai.core.JsonValue;
import java.util.Map;

// 工具 JSON Schema（通过 JsonValue.from 传入 Map）
Map<String, Object> parameters = Map.of(
    "type", "object",
    "properties", Map.of(
        "city", Map.of("type", "string", "description", "城市名称"),
        "unit", Map.of("type", "string", "enum", new String[]{"celsius", "fahrenheit"})
    ),
    "required", new String[]{"city"}
);

ChatCompletionTool weatherTool = ChatCompletionTool.builder()
        .type(ChatCompletionTool.Type.FUNCTION)
        .function(FunctionDefinition.builder()
                .name("get_weather")
                .description("获取指定城市的当前天气信息")
                .parameters(JsonValue.from(parameters))
                .build())
        .build();
```

### 第一轮：发送请求，获取 tool_call

```java
ChatCompletionCreateParams round1 = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_LUNA)
        .addUserMessage("北京今天天气怎么样？")
        .tools(List.of(weatherTool))
        .toolChoice(ChatCompletionToolChoiceOption.ofAuto())
        .build();

ChatCompletion response1 = client.chat().completions().create(round1);
ChatCompletionMessage assistantMsg = response1.choices().get(0).message();

// 解析 tool_call
assistantMsg.toolCalls().ifPresent(toolCalls -> {
    toolCalls.forEach(call -> {
        String functionName = call.function().name();
        String arguments = call.function().arguments(); // JSON 字符串
        System.out.println("调用函数：" + functionName + "，参数：" + arguments);
    });
});
```

### 第二轮：回传工具执行结果

```java
String toolCallId = assistantMsg.toolCalls().get().get(0).id();
String toolResult = "{\"temperature\": 22, \"condition\": \"晴天\", \"humidity\": 45}";

ChatCompletionCreateParams round2 = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_LUNA)
        .addUserMessage("北京今天天气怎么样？")
        .addMessage(assistantMsg)  // 带 tool_calls 的 assistant 消息
        .addToolMessage(toolCallId, toolResult)
        .build();

ChatCompletion finalResponse = client.chat().completions().create(round2);
System.out.println(finalResponse.choices().get(0).message().content().orElse(""));
```

---

## 五、Vision（图片理解）

```java
import com.openai.models.chat.completions.ChatCompletionContentPartImage;
import com.openai.models.chat.completions.ChatCompletionContentPartText;

// 通过 URL 传入图片
ChatCompletionContentPartImage imagePart = ChatCompletionContentPartImage.builder()
        .type(ChatCompletionContentPartImage.Type.IMAGE_URL)
        .imageUrl(ChatCompletionContentPartImage.ImageUrl.builder()
                .url("https://example.com/architecture.png")
                .detail(ChatCompletionContentPartImage.ImageUrl.Detail.HIGH)
                .build())
        .build();

ChatCompletionContentPartText textPart = ChatCompletionContentPartText.builder()
        .type(ChatCompletionContentPartText.Type.TEXT)
        .text("请描述这张架构图中各组件的关系。")
        .build();

ChatCompletionCreateParams visionParams = ChatCompletionCreateParams.builder()
        .model(ChatModel.GPT_5_6_SOL)
        .addUserMessageParts(List.of(imagePart, textPart))
        .build();

ChatCompletion visionResult = client.chat().completions().create(visionParams);
System.out.println(visionResult.choices().get(0).message().content().orElse(""));
```

---

## 六、Spring AI 接入

### Maven 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
</dependency>
```

### application.yaml 配置

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

### ChatClient 调用示例

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class OpenAiChatService {

    private final ChatClient chatClient;

    public OpenAiChatService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一位专业的 Java 后端开发专家。")
                .build();
    }

    // 同步调用
    public String chat(String userMessage) {
        return chatClient.prompt()
                .user(userMessage)
                .call()
                .content();
    }

    // 流式调用
    public Flux<String> chatStream(String userMessage) {
        return chatClient.prompt()
                .user(userMessage)
                .stream()
                .content();
    }
}
```

### Spring AI vs 官方 SDK 对比

| 维度 | Spring AI | 官方 OpenAI Java SDK |
|------|-----------|----------------------|
| 抽象层 | 统一 AI 抽象，可切换模型 | 绑定 OpenAI，API 最全 |
| 上手难度 | 低，与 Spring Boot 无缝集成 | 中，需熟悉 OpenAI 特定概念 |
| 功能覆盖 | 基础能力（Chat/Embedding/Tool） | 全量 API（Fine-tuning/Batch/Assistant 等） |
| 推荐场景 | 企业多模型集成、快速原型 | 深度使用 OpenAI 特性 |

---

## 七、费用与限流

### Tier 机制简介

OpenAI 按账户消费金额分为 Tier 1–5，Tier 越高，RPM（每分钟请求数）和 TPM（每分钟 Token 数）配额越大。

| Tier | 月消费门槛 | GPT-5.6 系列 RPM | GPT-5.6 系列 TPM |
|------|-----------|-----------------|-----------------|
| Tier 1 | $5 充值 | 500 | 30,000 |
| Tier 2 | $50+ | 5,000 | 450,000 |
| Tier 3 | $100+ | 5,000 | 800,000 |
| Tier 5 | $1,000+ | 10,000 | 2,000,000 |

### 限流应对：指数退避重试

```java
import java.time.Duration;

public ChatCompletion createWithRetry(OpenAIClient client,
                                      ChatCompletionCreateParams params) {
    int maxRetries = 5;
    long delayMs = 1000;

    for (int i = 0; i < maxRetries; i++) {
        try {
            return client.chat().completions().create(params);
        } catch (RateLimitException e) {
            if (i == maxRetries - 1) throw e;
            try {
                Thread.sleep(delayMs * (1L << i)); // 1s, 2s, 4s, 8s, 16s
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new RuntimeException(ie);
            }
        }
    }
    throw new RuntimeException("超过最大重试次数");
}
```

### Token 计费估算

- 使用 [tiktoken](https://github.com/openai/tiktoken) Python 库或在线 [Tokenizer](https://platform.openai.com/tokenizer) 预估 Token 数。
- 中文字符约 1–2 token/字，英文约 0.75 token/词。
- 建议在请求中设置 `maxTokens` 防止超额消费。
- 开启 Prompt Caching（Batch API）可节省重复 System Prompt 的费用。

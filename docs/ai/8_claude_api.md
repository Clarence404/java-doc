# Claude API

> 参考资料：
> * Anthropic 官方文档：[https://docs.anthropic.com](https://docs.anthropic.com)
> * Anthropic Java SDK：[https://github.com/anthropics/anthropic-sdk-java](https://github.com/anthropics/anthropic-sdk-java)
> * Spring AI Claude：[https://docs.spring.io/spring-ai/reference/api/chat/anthropic-chat.html](https://docs.spring.io/spring-ai/reference/api/chat/anthropic-chat.html)

---

## 一、模型总览

| 模型 | 用途 | 上下文窗口 | 特点 | 价格（输入/输出，每百万 Token） |
|------|------|-----------|------|-------------------------------|
| claude-fable-5 | 顶级智能 / 长时间 Agent 任务 | 1M tokens | 最强能力，知识密集与编程首选 | $10 / $50 |
| claude-opus-5 | 复杂 Agent 编程与企业级任务 | 1M tokens | 强推理，长时间运行 Agent | $5 / $25 |
| claude-sonnet-5 | 智能与速度均衡 | 1M tokens | 生产主力，综合性价比最高（8 月 31 日前优惠价 $2 / $10） | $3 / $15 |
| claude-haiku-4-5-20251001 | 高吞吐低延迟任务 | 200K tokens | 速度最快，适合实时交互 | $1 / $5 |

> Sonnet 5 / Opus 5 / Fable 5 均支持 1M tokens 超长上下文，可处理约 75 万词的内容。

---

## 二、官方 Java SDK 快速接入

### Maven 依赖

```xml
<dependency>
    <groupId>com.anthropic</groupId>
    <artifactId>anthropic-java</artifactId>
    <version>2.52.0</version>
</dependency>
```

### 初始化客户端

```java
import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;

AnthropicClient client = AnthropicOkHttpClient.builder()
        .apiKey(System.getenv("ANTHROPIC_API_KEY"))
        .build();
```

### Messages API 基础调用

```java
import com.anthropic.models.messages.*;

MessageCreateParams params = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .system("你是一位专业的 Java 后端架构师，回答精确且有深度。")
        .addUserMessage("请解释 Java 虚拟线程（Virtual Threads）与平台线程的核心区别。")
        .build();

Message message = client.messages().create(params);

// 提取文本内容
message.content().forEach(block ->
    block.asText().ifPresent(text -> System.out.println(text.text()))
);
```

---

## 三、流式响应

```java
import com.anthropic.core.http.StreamResponse;
import com.anthropic.models.messages.*;

MessageCreateParams params = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(2048)
        .addUserMessage("详细讲解 Spring AOP 的代理机制与切面执行顺序。")
        .build();

try (StreamResponse<RawMessageStreamEvent> stream = client.messages().createStreaming(params)) {
    stream.stream().forEach(event -> {
        if (event.isContentBlockDelta()) {
            RawContentBlockDeltaEvent deltaEvent = event.asContentBlockDelta();
            if (deltaEvent.delta().isText()) {
                System.out.print(deltaEvent.delta().asText().text());
            }
        }
    });
}
System.out.println();
```

---

## 四、Tool Use（工具调用）

### 定义工具

```java
import com.anthropic.models.messages.*;
import com.anthropic.core.JsonValue;
import java.util.List;
import java.util.Map;

Map<String, Object> inputSchema = Map.of(
    "type", "object",
    "properties", Map.of(
        "query",    Map.of("type", "string",  "description", "数据库查询关键词"),
        "limit",    Map.of("type", "integer", "description", "返回记录数，默认 10")
    ),
    "required", List.of("query")
);

Tool dbQueryTool = Tool.builder()
        .name("search_database")
        .description("在产品数据库中搜索记录，返回匹配结果列表")
        .type(Tool.Type.CUSTOM)
        .inputSchema(Tool.InputSchema.builder()
                .properties(JsonValue.from(inputSchema))
                .build())
        .build();
```

### 第一轮：发送请求，获取 tool_use block

```java
MessageCreateParams round1 = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .tools(List.of(dbQueryTool))
        .addUserMessage("帮我查一下所有名称包含'微服务'的文档。")
        .build();

Message response1 = client.messages().create(round1);

// 解析 tool_use block
response1.content().forEach(block -> {
    block.asToolUse().ifPresent(toolUse -> {
        System.out.println("工具名称：" + toolUse.name());
        System.out.println("输入参数：" + toolUse.input());
    });
});
```

### 第二轮：回传 tool_result

```java
import java.util.stream.Collectors;

// 假设从数据库取得了结果
String toolUseId = response1.content().stream()
        .filter(b -> b.isToolUse())
        .findFirst()
        .map(b -> b.asToolUse().get().id())
        .orElseThrow();

String toolResult = "[{\"id\":1,\"title\":\"微服务架构设计\"},{\"id\":2,\"title\":\"微服务拆分实战\"}]";

MessageCreateParams round2 = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .tools(List.of(dbQueryTool))
        .addUserMessage("帮我查一下所有名称包含'微服务'的文档。")
        .addAssistantMessageOfBlockParams(                       // 含 tool_use 的 assistant 消息
                response1.content().stream()
                        .map(ContentBlock::toParam)
                        .collect(Collectors.toList())
        )
        .addUserMessageOfBlockParams(List.of(                    // tool_result 消息
                ContentBlockParam.ofToolResult(
                        ToolResultBlockParam.builder()
                                .toolUseId(toolUseId)
                                .content(toolResult)
                                .build()
                )
        ))
        .build();

Message finalResponse = client.messages().create(round2);
finalResponse.content().forEach(block ->
    block.asText().ifPresent(text -> System.out.println(text.text()))
);
```

---

## 五、Vision（图片输入）

```java
import com.anthropic.models.messages.*;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

byte[] imageBytes = Files.readAllBytes(Paths.get("system-design.png"));
String base64Data = Base64.getEncoder().encodeToString(imageBytes);

ImageBlockParam imageBlock = ImageBlockParam.builder()
        .type(ImageBlockParam.Type.IMAGE)
        .source(ImageBlockParam.Source.builder()
                .type(ImageBlockParam.Source.Type.BASE64)
                .mediaType(ImageBlockParam.Source.MediaType.IMAGE_PNG)
                .data(base64Data)
                .build())
        .build();

TextBlockParam textBlock = TextBlockParam.builder()
        .type(TextBlockParam.Type.TEXT)
        .text("请分析这张系统设计图，指出潜在的性能瓶颈。")
        .build();

MessageCreateParams visionParams = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        .addUserMessage(List.of(imageBlock, textBlock))
        .build();

Message visionResult = client.messages().create(visionParams);
visionResult.content().forEach(block ->
    block.asText().ifPresent(text -> System.out.println(text.text()))
);
```

---

## 六、Prompt Caching（提示缓存）

Prompt Caching 可以缓存长 System Prompt 或大段文档，避免每次请求重复计费，节省高达 90% 的 Token 费用（缓存命中时按 10% 费率计费）。

### 工作原理

- 在 System Prompt 或消息块末尾添加 `cache_control: {"type": "ephemeral"}` 标记
- 缓存默认保留 5 分钟（最长可达 1 小时）
- 超过 1024 tokens 的内容才有缓存收益

### 代码示例

```java
import com.anthropic.models.messages.*;

// 长 System Prompt（如公司代码规范、大段知识库文档）
String longSystemPrompt = """
        你是 Acme 公司专属的 Java 技术助手，以下是公司代码规范（共 5000 字）：
        1. 所有 Service 层方法必须添加事务注解...
        2. 禁止在 Controller 层编写业务逻辑...
        [更多规范内容省略]
        """;

MessageCreateParams params = MessageCreateParams.builder()
        .model(Model.CLAUDE_SONNET_5)
        .maxTokens(1024)
        // 通过 CacheControlEphemeral 标记 system 块开启缓存
        .system(List.of(
                TextBlockParam.builder()
                        .text(longSystemPrompt)
                        .cacheControl(CacheControlEphemeral.builder().build())
                        .build()
        ))
        .addUserMessage("帮我 review 这段 Service 代码是否符合规范。")
        .build();

Message response = client.messages().create(params);

// 查看缓存统计（首次请求写入缓存，后续命中缓存）
response.usage().cacheCreationInputTokens()
        .ifPresent(n -> System.out.println("缓存写入 tokens：" + n));
response.usage().cacheReadInputTokens()
        .ifPresent(n -> System.out.println("缓存命中 tokens：" + n));
```

### 适用场景

| 场景 | 说明 |
|------|------|
| 长系统提示词 | 固定的角色设定、公司规范、领域知识 |
| RAG 文档块 | 将检索到的大段文档放入 cache 块 |
| Few-shot 示例 | 多个示例对话放在缓存块，每次请求复用 |
| 代码库分析 | 将整个代码文件传入并缓存，多轮问答 |

---

## 七、Spring AI 接入

### Maven 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-anthropic-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

### application.yaml 配置

```yaml
spring:
  ai:
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}
      chat:
        options:
          model: claude-sonnet-5
          max-tokens: 2048
          temperature: 0.7
```

### ChatClient 同步 + 流式示例

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
public class ClaudeChatService {

    private final ChatClient chatClient;

    public ClaudeChatService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一位资深 Java 后端架构师。")
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

    // 携带自定义 System Prompt
    public String chatWithContext(String systemContext, String userMessage) {
        return chatClient.prompt()
                .system(systemContext)
                .user(userMessage)
                .call()
                .content();
    }
}
```

### Spring AI 与官方 SDK 对比

| 维度 | Spring AI | 官方 Anthropic Java SDK |
|------|-----------|------------------------|
| 抽象层 | 统一接口，可多模型切换 | 绑定 Anthropic，功能最全 |
| Prompt Caching | 暂不支持精细控制 | 完整支持 cache_control |
| Tool Use | 通过 @Tool 注解简化 | 手动构建，灵活度最高 |
| 流式响应 | Flux 响应式，开箱即用 | 基于 Stream，需手动处理 |
| 推荐场景 | 多模型集成、快速开发 | 需要 Caching/批处理等高级特性 |

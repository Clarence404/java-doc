# Spring AI

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-ai/reference/](https://docs.spring.io/spring-ai/reference/)
> * GitHub：[https://github.com/spring-projects/spring-ai](https://github.com/spring-projects/spring-ai)

---

## 一、是什么

Spring AI 是 Spring 官方推出的 AI 集成框架，目标是用 Spring 的编程模型把大模型能力引入 Spring Boot 应用，开箱即用。

**核心优势：**

- 与 Spring Boot 4.x 深度集成，自动配置、`@Bean`、`application.yaml` 全套生效
- 统一抽象层（`ChatModel`、`EmbeddingModel`、`VectorStore`），换模型只改依赖和配置，业务代码不动
- 原生支持 Tool Calling、RAG、Structured Output、Multimodal
- 官方维护，迭代快，社区活跃

---

## 二、快速接入

### Maven 依赖

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>2.0.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- 以 OpenAI 为例，换模型只换这一个 starter -->
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
  </dependency>
</dependencies>
```

### application.yaml

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      base-url: https://api.openai.com   # 可改为代理地址
      chat:
        model: gpt-4o-mini
        temperature: 0.7   # 2.0 已移除默认值 0.7，需显式配置
```

启动后 Spring AI 自动注册 `ChatModel`、`ChatClient.Builder` 等 Bean，直接注入即用。

> **注意（2.0 迁移）**：配置项 `spring.ai.<provider>.chat.options.*` 中的 `.options` 层级已移除，直接写 `spring.ai.<provider>.chat.*`；各 provider 默认 temperature 已取消，须显式配置。

---

## 三、ChatClient

`ChatClient` 是 Spring AI 最核心的高层 API，提供流畅的链式调用。

### 注入方式

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class AiService {

    private final ChatClient chatClient;

    // ChatClient.Builder 由自动配置注入
    public AiService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }
}
```

### 基础调用

```java
// 最简单的单次问答
String answer = chatClient.prompt()
        .user("Java 中 HashMap 的扩容机制是什么？")
        .call()
        .content();
```

### PromptTemplate 用法

```java
import org.springframework.ai.chat.prompt.PromptTemplate;
import org.springframework.ai.chat.prompt.Prompt;

PromptTemplate template = new PromptTemplate("""
        你是一位 {role}，请用 {language} 回答：{question}
        """);

Prompt prompt = template.create(Map.of(
        "role",     "Java 架构师",
        "language", "中文",
        "question", "什么情况下用 ConcurrentHashMap？"
));

String answer = chatClient.prompt(prompt).call().content();
```

### SystemMessage 预设角色

```java
String answer = chatClient.prompt()
        .system("你是一位经验丰富的 Java 后端架构师，回答简洁、务实。")
        .user("Redis 和本地缓存如何选择？")
        .call()
        .content();
```

---

## 四、流式响应

大模型逐 token 返回时使用流式，避免前端长时间白屏。Spring AI 用 Reactor `Flux<String>` 承接。

```java
import reactor.core.publisher.Flux;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class StreamController {

    private final ChatClient chatClient;

    public StreamController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    // 浏览器 EventSource / fetch ReadableStream 均可消费
    @GetMapping(value = "/stream", produces = "text/event-stream")
    public Flux<String> stream(@RequestParam String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content();   // Flux<String>，每个元素是一个 token 片段
    }
}
```

> `stream().chatResponse()` 可拿到带 metadata（token 用量、finish reason）的完整 `Flux<ChatResponse>`。

---

## 五、Tool Calling（工具调用）

让模型在需要时主动调用你注册的 Java 方法，典型场景：查询数据库、调用外部 API、执行计算。

### 定义工具

```java
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.stereotype.Component;

@Component
public class WeatherTools {

    /**
     * 模型会根据描述决定是否调用此方法
     * @param city 城市名
     * @return 天气信息
     */
    @Tool(description = "查询指定城市的当前天气，返回温度和天气状况")
    public String getCurrentWeather(String city) {
        // 实际调用天气 API，这里模拟返回
        return city + "：晴，25°C，湿度 60%";
    }

    @Tool(description = "查询指定城市未来 3 天的天气预报")
    public String getWeatherForecast(String city) {
        return city + " 未来三天：晴/多云/小雨，温度 22-28°C";
    }
}
```

### 注册到 ChatClient

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class WeatherService {

    private final ChatClient chatClient;

    public WeatherService(ChatClient.Builder builder, WeatherTools weatherTools) {
        this.chatClient = builder
                .defaultTools(weatherTools)  // 全局注册，每次请求都携带
                .build();
    }

    public String ask(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .content();
    }
}
```

也可以在单次请求时动态注入工具：

```java
String result = chatClient.prompt()
        .user("北京今天天气怎么样？")
        .tools(weatherTools)   // 仅此次请求携带
        .call()
        .content();
```

> **2.0 变更**：`ToolCallingAdvisor` 现在由 ChatClient 自动注册，无需手动 `.advisors(ToolCallingAdvisor.builder().build())` 显式添加。旧版的 `toolNames()`（按 Spring Bean 名称注册工具）API 已移除，统一改用 `@Tool` 注解或 `ToolCallback` bean。

---

## 六、多模型支持

| 模型提供商 | Starter 依赖 artifactId（2.0.0 新命名） |
|---|---|
| OpenAI（GPT-4o / o1） | `spring-ai-starter-model-openai` |
| Anthropic（Claude 3.x） | `spring-ai-starter-model-anthropic` |
| Ollama（本地模型） | `spring-ai-starter-model-ollama` |
| Azure OpenAI | `spring-ai-starter-model-openai`（2.0 已移除独立 azure 模块，配置 `base-url` 指向 Azure 端点） |
| Google GenAI / Vertex AI（Gemini） | `spring-ai-starter-model-google-genai` |
| Mistral AI | `spring-ai-starter-model-mistral-ai` |
| DeepSeek | `spring-ai-starter-model-deepseek`（2.0 新增独立 starter） |

> **2.0 Starter 命名规则变更**：旧版 `spring-ai-<provider>-spring-boot-starter` 统一改为 `spring-ai-starter-model-<provider>`，升级时需全部替换。

切换模型只需替换 Starter 依赖 + 修改 `application.yaml` 中对应的 api-key 和 model，业务代码无需改动。

---

## 七、RAG 集成

Spring AI 内置 `VectorStore`、`EmbeddingModel`、`DocumentReader` 等 RAG 组件，可快速构建基于本地知识库的问答系统。

详见 [RAG 检索增强生成](./11_rag.md)。

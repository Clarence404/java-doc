---
description: ChatClient、Advisor、对话记忆、Tool Calling、结构化输出、RAG、MCP、可观测性
---

# Spring AI

> 前置阅读：[Function Calling（工具调用）](../1_concepts/2_function_calling)、[Spring Boot 总览](/spring-boot/0_overview)

Spring AI 是 Spring 官方的 AI 集成框架，用自动配置、Bean、配置属性的方式把大模型、向量库、工具调用接进应用。本篇以 Spring AI 2.0.x（截至 2026-10 最新为 2.0.1，支持 Spring Boot 4.0.x / 4.1.x，示例用 JDK 21）为基线，讲 ChatClient、Advisor、对话记忆、Tool Calling、结构化输出及从 1.x（Spring Boot 3.5 线）升级的要点。

---

## 一、核心抽象

Spring AI 的 API 分两层：底层 `ChatModel` 对接各家厂商，上层 `ChatClient` 提供链式调用，中间用 Advisor 链插入记忆、检索、工具调用等横切逻辑。

| 抽象 | 作用 |
|------|------|
| `ChatModel` | 单次调用某个厂商的对话接口，每个 Starter 提供一个实现 |
| `ChatClient` | 面向业务的链式 API，组装 system / user / options / tools，调用后返回文本或实体 |
| `Advisor` | 拦截一次 ChatClient 调用的前后，类似 Servlet Filter，按顺序组成链 |
| `ChatMemory` | 按会话 ID 存取历史消息，由 `MessageChatMemoryAdvisor` 接入 |
| `ToolCallback` / `@Tool` | 暴露给模型调用的 Java 方法 |
| `EmbeddingModel` / `VectorStore` | 向量化与向量存储，RAG 的基础 |

一次 `chatClient.prompt()...call()` 的执行顺序如下。2.0 起工具调用循环不再藏在 `ChatModel` 里，而是由自动注册的 `ToolCallingAdvisor` 在 Advisor 链中驱动：

![Spring AI 2.0 ChatClient 请求链路](../../assets/ai/spring-ai-advisor-chain.svg)

---

## 二、快速接入

### 1、依赖

用 BOM 统一版本，再按厂商选一个模型 Starter：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>2.0.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <!-- 以 OpenAI 为例，换厂商只换这个 Starter -->
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
  </dependency>
</dependencies>
```

### 2、配置

2.0 把配置项拍平了：模型参数直接写在 `spring.ai.<provider>.chat.*` 下，不再有 `.options` 这一层（旧写法仍以废弃属性的形式兼容，后续版本会删除）。

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        model: ${OPENAI_CHAT_MODEL}         # 型号见厂商 Models 页，不要写死在代码里
        max-completion-tokens: 2048         # 推理模型用这个；非推理模型用 max-tokens，二者互斥
      embedding:
        model: ${OPENAI_EMBEDDING_MODEL}
```

几个容易踩的点：

- 2.0 取消了 Spring AI 自带的默认 temperature（1.x 多数厂商默认 0.7），不配置就使用厂商自己的默认值
- 推理类模型（如 OpenAI GPT-5 系列）不接受自定义 temperature，配了会直接报错；需要调 temperature 时先查模型文档
- 同时引入多个模型 Starter 时，用 `spring.ai.model.chat=openai` 这类属性指定由谁提供 `ChatModel`

### 3、注入 ChatClient

自动配置会注册一个原型作用域的 `ChatClient.Builder`，构造器注入后按需定制：

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class AiService {

    private final ChatClient chatClient;

    public AiService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一位经验丰富的 Java 后端架构师，回答简洁、务实。")
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

---

## 三、ChatClient 调用

### 1、模板参数

用户消息里的 `{name}` 占位符可以直接在链式调用里填值，也可以先用 `PromptTemplate` 生成 `Prompt`：

```java
String answer = chatClient.prompt()
        .user(u -> u.text("你是一位 {role}，请用 {language} 回答：{question}")
                .param("role", "Java 架构师")
                .param("language", "中文")
                .param("question", "什么情况下用 ConcurrentHashMap？"))
        .call()
        .content();
```

```java
import java.util.Map;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.prompt.PromptTemplate;

PromptTemplate template = new PromptTemplate("你是一位 {role}，请用 {language} 回答：{question}");
Prompt prompt = template.create(Map.of(
        "role", "Java 架构师",
        "language", "中文",
        "question", "什么情况下用 ConcurrentHashMap？"));

String answer = chatClient.prompt(prompt).call().content();
```

### 2、单次请求覆盖参数

2.0 的 `options()` 接收的是 Builder 而不是构建好的对象，只覆盖你显式设置的字段，其余沿用配置文件：

```java
import org.springframework.ai.openai.OpenAiChatOptions;

String summary = chatClient.prompt()
        .user("用一句话总结 CAP 定理")
        .options(OpenAiChatOptions.builder()
                .model(cheapModelId)           // 简单任务换小模型
                .maxCompletionTokens(256))
        .call()
        .content();
```

### 3、流式输出

`stream()` 返回 Reactor `Flux`，每个元素是一段增量文本。Spring AI 的 ChatClient 本身依赖 reactor-core，所以 Spring MVC 项目也能直接返回 `Flux`，MVC 会把它当作异步结果逐段写出；WebFlux 项目写法相同。

```java
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamController {

    private final ChatClient chatClient;

    public StreamController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping(value = "/ai/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> stream(@RequestParam String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content();
    }
}
```

需要 token 用量、结束原因等元数据时，用 `stream().chatResponse()` 拿 `Flux<ChatResponse>`。SSE 协议本身、断线重连与网关缓冲问题见 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 四、Advisor 与对话记忆

### 1、Advisor 链

Advisor 包住一次 ChatClient 调用，可以改写请求、增强上下文、处理响应。注册方式有两种：

- `builder.defaultAdvisors(...)`：对这个 ChatClient 的所有请求生效
- `prompt().advisors(...)`：只对本次请求生效，也用来传参数，如 `a -> a.param(ChatMemory.CONVERSATION_ID, id)`

顺序由每个 Advisor 的 `getOrder()` 决定，数值越小越靠外。几个内置 Advisor 的默认位置：`MessageChatMemoryAdvisor` 在 `HIGHEST_PRECEDENCE + 200`，处于工具循环之外，一轮对话只读写一次历史；`ToolCallingAdvisor` 在 `HIGHEST_PRECEDENCE + 300`，它内侧的 Advisor 会在每一轮工具调用中重复执行。调试时可以加 `SimpleLoggerAdvisor` 并把 `org.springframework.ai.chat.client.advisor` 的日志级别调到 DEBUG，生产环境注意日志里的敏感数据。

### 2、对话记忆

模型本身无状态，多轮对话靠每次把历史消息带上。Spring AI 自动配置了一个 `ChatMemory`（`MessageWindowChatMemory`，默认保留最近 20 条，存储在内存），把它挂到 `MessageChatMemoryAdvisor` 上即可：

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.stereotype.Service;

@Service
public class ChatService {

    private final ChatClient chatClient;

    public ChatService(ChatClient.Builder builder, ChatMemory chatMemory) {
        this.chatClient = builder
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    public String chat(String userId, String sessionId, String message) {
        return chatClient.prompt()
                .user(message)
                // 会话 ID 必填，缺失会抛 IllegalArgumentException
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, userId + ":" + sessionId))
                .call()
                .content();
    }
}
```

- 会话 ID 要由服务端根据登录态拼出来，不能直接用前端传的值，否则用户可以读到别人的对话
- 多实例部署时内存存储不共享，引入 `spring-ai-starter-model-chat-memory-repository-jdbc` 后自动配置的 `ChatMemory` 会改用 JDBC 存储；Redis 等其他实现见官方 Chat Memory 文档
- 窗口越大，每次请求带的 token 越多，成本和延迟同步上升；长对话可以定期把早期消息摘要后再存

---

## 五、Tool Calling

协议层的两轮调用流程见 [Function Calling（工具调用）](../1_concepts/2_function_calling)，这里只讲 Spring AI 的写法。

### 1、定义工具

`@Tool` 的 `description` 是模型判断何时调用的唯一依据，要写清楚用途和返回内容；参数说明用 `@ToolParam`，Javadoc 不会发给模型。返回值可以是 record，框架会序列化成 JSON。

```java
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

@Component
public class WeatherTools {

    public record Weather(String city, String condition, int temperature) {}

    @Tool(description = "查询指定城市的当前天气，返回天气状况和温度")
    public Weather currentWeather(@ToolParam(description = "城市名，如 北京") String city) {
        return new Weather(city, "晴", 25);   // 示例数据，实际调用天气服务
    }
}
```

参数默认都是必填。模型拿不到某个必填参数的值时会自己编一个，所以只把确实能从对话中得到的参数设为必填，其余用 `@ToolParam(required = false)`。

### 2、注册工具

```java
@Service
public class WeatherService {

    private final ChatClient chatClient;

    public WeatherService(ChatClient.Builder builder, WeatherTools weatherTools) {
        this.chatClient = builder
                .defaultTools(weatherTools)   // 只读、低风险工具可以作为默认工具
                .build();
    }
}
```

有副作用或高风险的工具按请求注册，只在确实需要的场景带上：

```java
String reply = chatClient.prompt()
        .user("帮我查一下订单 A1001 的状态")
        .tools(orderTools)
        .toolContext(Map.of("tenantId", currentTenantId()))
        .call()
        .content();
```

### 3、ToolContext 与 returnDirect

- `ToolContext`：把租户 ID、用户 ID 这类不该让模型看到也不该让模型决定的数据传给工具，方法签名里加一个 `ToolContext` 参数即可读取；这部分数据不会发给模型
- `@Tool(returnDirect = true)`：工具结果直接作为最终响应返回调用方，不再回传模型二次加工，适合查询结果本身就是答案的场景

```java
@Tool(description = "按订单号查询当前用户的订单状态")
public Order findOrder(@ToolParam(description = "订单号") String orderId, ToolContext context) {
    String tenantId = (String) context.getContext().get("tenantId");
    return orderRepository.findByIdAndTenant(orderId, tenantId);   // 用服务端身份做权限过滤
}
```

### 4、2.0 的工具循环

- 循环由 `ToolCallingAdvisor` 驱动，ChatClient 自动注册，不需要手动添加；直接调用 `ChatModel` 时返回的 tool call 不会被自动执行
- 默认上限是每个工具 40 次、每轮共 150 次，超限后以特定结束原因返回，防止模型陷入死循环
- 工具抛出 `RuntimeException` 时默认把异常消息回传给模型，受检异常和 `Error` 直接抛出；`spring.ai.tools.throw-exception-on-error=true` 改为全部抛给调用方。异常消息会进入模型上下文，不要在里面带内部细节
- 1.x 的 `toolNames(...)`（按 Bean 名解析工具）和 `FunctionCallback` 已删除，统一用 `@Tool` 或 `ToolCallback` Bean

### 5、安全边界

工具以应用自身的权限运行，模型只是“建议调用”，真正执行的是你的代码。几条底线：

- **最小权限**：工具只暴露完成任务必需的操作，查询类与写入类分开，写入类按请求注册
- **身份不由模型决定**：用户、租户等身份信息从 `ToolContext` 或安全上下文取，不作为模型可填的参数
- **副作用需人工确认**：下单、转账、删除这类操作，让工具只生成待确认的草稿，由用户在界面上确认后再由业务代码执行；官方文档也建议用自定义 `ToolAdvisor` 在执行前插入审批
- **间接提示注入**：工具返回、检索到的文档、MCP Server 的输出都可能夹带“忽略之前的指令”之类的文本，模型会把它当成上下文读进去；对这些内容做来源标注，不要让一次工具结果触发另一个高风险工具

更系统的防护思路见 [常见漏洞与防护](/security/8_vulnerabilities) 与 [API 安全](/security/6_api_security)。

---

## 六、结构化输出

`call().entity(...)` 把模型输出直接转换成 Java 对象，框架会根据目标类型生成 JSON Schema 并附在请求里：

```java
import java.util.List;
import org.springframework.core.ParameterizedTypeReference;

public record ActorFilms(String actor, List<String> movies) {}

ActorFilms films = chatClient.prompt()
        .user("列出周星驰的 5 部代表作")
        .call()
        .entity(ActorFilms.class);

List<ActorFilms> list = chatClient.prompt()
        .user("分别列出周星驰和刘德华的 3 部代表作")
        .call()
        .entity(new ParameterizedTypeReference<List<ActorFilms>>() {});
```

默认做法是把 Schema 写进提示词，模型偶尔会输出不合规的 JSON。对可靠性要求高时打开两个开关：

```java
ActorFilms films = chatClient.prompt()
        .user("列出周星驰的 5 部代表作")
        .call()
        .entity(ActorFilms.class, spec -> spec
                .useProviderStructuredOutput()   // 用厂商原生的结构化输出约束，而不是提示词
                .validateSchema());               // 按 Schema 校验，不通过带着错误信息自动重试
```

流式调用目前不能直接返回实体，需要先把 `Flux<String>` 聚合成完整文本，再用 `BeanOutputConverter` 转换。

---

## 七、RAG、MCP 与多模型

### 1、RAG

Spring AI 用 Advisor 接入检索增强：`QuestionAnswerAdvisor`（依赖 `spring-ai-vector-store-advisor`）在调用前按用户问题查 `VectorStore`，把命中文档拼进上下文；`RetrievalAugmentationAdvisor`（依赖 `spring-ai-rag`）把查询改写、检索、合并、上下文增强拆成可替换的模块，适合需要定制流程的场景。多租户场景一定要在检索时带上过滤条件，只返回当前用户有权访问的文档：

```java
String answer = chatClient.prompt()
        .advisors(QuestionAnswerAdvisor.builder(vectorStore)
                .searchRequest(SearchRequest.builder()
                        .topK(5)
                        .similarityThreshold(0.6)
                        .filterExpression("tenant == '" + tenantId + "'")   // tenantId 来自服务端登录态
                        .build())
                .build())
        .user("公司请假流程是什么？")
        .call()
        .content();
```

文档切块、混合检索、重排与评估见 [RAG 检索增强生成](../4_core_tech/2_rag)，向量库内部原理与选型见 [向量数据库](../4_core_tech/1_vector_db)。

### 2、MCP

Spring AI 提供 MCP 的客户端和服务端 Starter，客户端会把远端 MCP Server 的工具自动注册成 `ToolCallback`，和本地 `@Tool` 一起参与工具循环：

| Starter | 用途 |
|---------|------|
| `spring-ai-starter-mcp-client` | MCP 客户端，支持 stdio、Streamable HTTP、SSE |
| `spring-ai-starter-mcp-client-webflux` | 基于 WebFlux 的 HTTP 客户端传输 |
| `spring-ai-starter-mcp-server` | stdio 服务端 |
| `spring-ai-starter-mcp-server-webmvc` / `-webflux` | HTTP 服务端，`spring.ai.mcp.server.protocol` 选 `STREAMABLE`、`STATELESS` 或 SSE |

接第三方 MCP Server 时用 `McpToolFilter` 只放行需要的工具；远程 HTTP 传输按 MCP 规范用 OAuth 做授权，不要把长期令牌硬编码在配置里。协议细节与完整示例见 [MCP 协议](../5_advanced/1_mcp)。

### 3、多模型 Starter

| 厂商 | Starter |
|------|---------|
| OpenAI 及 OpenAI 兼容服务 | `spring-ai-starter-model-openai` |
| Anthropic | `spring-ai-starter-model-anthropic` |
| Google Gemini（Gemini API / Vertex AI） | `spring-ai-starter-model-google-genai` |
| DeepSeek | `spring-ai-starter-model-deepseek` |
| Mistral AI | `spring-ai-starter-model-mistral-ai` |
| Ollama（本地模型） | `spring-ai-starter-model-ollama` |

业务代码只依赖 `ChatClient` / `ChatModel` 接口，换厂商只改依赖和配置。各厂商的配置写法与官方 SDK 对照见 [API 直接接入](../3_integration/1_api_access)，本地模型见 [Ollama](../3_integration/0_ollama)。

---

## 八、可观测性

Spring AI 基于 Micrometer 为 ChatClient、Advisor、ChatModel、工具调用和 VectorStore 产生观测数据，引入 `spring-boot-starter-actuator` 和对应的指标或链路后端即可采集：

| 观测名 | 覆盖范围 |
|--------|----------|
| `spring.ai.chat.client` | 一次 ChatClient 调用，含所有 Advisor |
| `spring.ai.advisor` | 单个 Advisor 的耗时 |
| `gen_ai.client.operation` | ChatModel / EmbeddingModel 调用厂商接口 |
| `spring.ai.tool` | 单次工具执行 |
| `db.vector.client.operation` | 向量库的写入、删除、查询 |

成本监控看 `gen_ai.client.token.usage`（Prometheus 中为 `gen_ai_client_token_usage_total`，按 input / output 区分）。提示词、模型输出、工具参数和结果默认不导出，排障时才用 `spring.ai.chat.client.observations.log-prompt` 等开关临时打开。指标与链路的通用做法见 [可观测性总览](/observability/0_overview) 与 [Actuator 监控](/spring-boot/7_actuator)。

---

## 九、版本与迁移

### 1、版本线

| Spring AI | Spring Boot | 状态（2026-10） |
|-----------|-------------|-----------------|
| 2.0.x | 4.0.x / 4.1.x | 当前主线，本文基线 |
| 1.1.x | 3.5.x | 维护中，Boot 3 项目使用 |
| 2.1.0-M1 | 4.2 | 里程碑版，不建议生产使用 |

### 2、1.x 升级到 2.0 的要点

| 变化 | 处理方式 |
|------|----------|
| 配置拍平：`spring.ai.<provider>.chat.options.*` 改为 `spring.ai.<provider>.chat.*`，Embedding 等其他模型同理 | 去掉 `.options`；旧属性暂时兼容 |
| 取消默认 temperature | 需要固定值时显式配置 |
| `ToolCallingAdvisor` 自动注册，`ChatModel` 不再内部执行工具 | 删掉手动添加的工具 Advisor；直接用 `ChatModel` 的代码要自己处理 tool call |
| 删除 `toolNames(...)`、`FunctionCallback` | 改用 `@Tool` 或 `ToolCallback` Bean |
| Options 变为不可变，`copy()` 改为 `mutate()`；`ChatClient.options()` 接收 Builder | 按新 API 调整 |
| OpenAI 模块改用官方 `openai-java` SDK，Anthropic 模块改用官方 `anthropic-java` SDK（`maxTokens` 默认改为 4096） | 配置前缀不变；直接用底层 `AnthropicApi` 等类的代码需要重写 |
| 删除 `spring-ai-azure-openai` 模块 | 改用 OpenAI 模块，类名去掉 `Azure` 前缀，属性按升级文档调整 |
| Ollama 的 `think-option` 改名为 `think` | 改配置 |

Starter 的命名（`spring-ai-<provider>-spring-boot-starter` 改为 `spring-ai-starter-model-<provider>`）是在 1.0.0-M7 完成的，不是 2.0 的变化；从 1.0 GA 之前的版本升级才需要处理。完整清单以官方 Upgrade Notes 为准。

---

## 小结

- Spring AI 2.0.x 对应 Spring Boot 4，1.1.x 对应 Boot 3.5；配置写在 `spring.ai.<provider>.chat.*` 下，模型型号放配置不写死
- `ChatClient` 是主入口，Advisor 链负责记忆、检索、日志等横切逻辑，工具循环由自动注册的 `ToolCallingAdvisor` 驱动
- 对话记忆靠 `MessageChatMemoryAdvisor` 加会话 ID，会话 ID 由服务端根据登录态生成，多实例用 JDBC 等持久化存储
- 工具描述写清楚、必填参数要少、身份走 `ToolContext`；有副作用的工具按请求注册并要求人工确认，警惕工具输出与检索文档里的间接注入
- `entity()` 直接拿结构化结果，关键场景打开厂商原生约束和 Schema 校验
- RAG 用 `QuestionAnswerAdvisor` / `RetrievalAugmentationAdvisor` 并带权限过滤，MCP 工具和本地工具走同一套循环，观测数据通过 Micrometer 输出

## 参考资料

- Spring AI Reference：[https://docs.spring.io/spring-ai/reference/](https://docs.spring.io/spring-ai/reference/)
- Spring AI Upgrade Notes：[https://docs.spring.io/spring-ai/reference/upgrade-notes.html](https://docs.spring.io/spring-ai/reference/upgrade-notes.html)
- ChatClient API：[https://docs.spring.io/spring-ai/reference/api/chatclient.html](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- Tool Calling：[https://docs.spring.io/spring-ai/reference/api/tools.html](https://docs.spring.io/spring-ai/reference/api/tools.html)
- Chat Memory：[https://docs.spring.io/spring-ai/reference/api/chat-memory.html](https://docs.spring.io/spring-ai/reference/api/chat-memory.html)
- Observability：[https://docs.spring.io/spring-ai/reference/observability/index.html](https://docs.spring.io/spring-ai/reference/observability/index.html)
- GitHub Releases：[https://github.com/spring-projects/spring-ai/releases](https://github.com/spring-projects/spring-ai/releases)

> 下一篇：[LangChain4j](./1_langchain4j) —— AiServices 声明式接口、记忆与工具、RAG、MCP 客户端与 Agent 编排。

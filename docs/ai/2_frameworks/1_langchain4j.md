---
description: AiServices、ChatMemory、Tools、结构化输出与护栏、RAG、MCP 客户端、Agentic 编排
---

# LangChain4j

> 前置阅读：[Spring AI](./0_spring_ai)、[Function Calling（工具调用）](../1_concepts/2_function_calling)

LangChain4j 是独立于 Spring 的 Java LLM 框架，用接口声明 AI 能力、由框架生成实现。本篇讲 AiServices、记忆与工具、护栏、RAG 与 MCP、Agent 编排，基线为 1.22。

---

## 一、与 Spring AI 怎么选

示例基于 LangChain4j 1.22.0，JDK 21（最低 JDK 17）。

两者能力已大面积重合，差别主要在编程模型和生态位置：

| 维度 | Spring AI | LangChain4j |
|------|-----------|-------------|
| 出身 | Spring 官方项目 | 独立社区项目 |
| 编程模型 | `ChatClient` 链式调用 + Advisor 链 | AiServices 接口代理 + 可组合组件 |
| Spring 集成 | 原生自动配置、Micrometer 观测 | 提供 Spring Boot 3 / 4 Starter，可选 |
| 非 Spring 项目 | 可用但不是主场 | 纯 Java 即可使用，也有 Quarkus 等集成 |
| Agent 编排 | 基于 Advisor 与工具循环自行组织 | 有实验性的 `langchain4j-agentic` 模块 |

选型建议：Spring Boot 项目、看重与 Spring 生态（配置、观测、安全）一致性，优先 Spring AI；非 Spring 项目、偏好接口声明式写法，或想用现成的 Agent 编排模块，选 LangChain4j。两者都能对接主流厂商和 MCP，不必因为某个单点功能做决定。

---

## 二、快速接入

它的模块分两类：核心与主流厂商模块版本号形如 `1.22.0`，处于实验阶段的模块（MCP、Agentic、Spring Boot Starter、部分文档解析器等）版本号形如 `1.22.0-beta32`，统一用 BOM 管理即可。

### 1、依赖

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>dev.langchain4j</groupId>
      <artifactId>langchain4j-bom</artifactId>
      <version>1.22.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- 高层 API：AiServices、RAG、记忆等 -->
  <dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
  </dependency>
  <!-- 厂商实现，换厂商只换这个 -->
  <dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-open-ai</artifactId>
  </dependency>
</dependencies>
```

### 2、底层 ChatModel

```java
import java.time.Duration;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;

ChatModel model = OpenAiChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName(System.getenv("OPENAI_MODEL"))   // 型号见厂商 Models 页
        .timeout(Duration.ofSeconds(60))
        .maxRetries(2)
        .build();

String answer = model.chat("Java 中 volatile 解决了什么问题？");
```

### 3、Spring Boot 集成

Starter 按 Spring Boot 大版本分两套，版本号相同：Boot 4 用 `-spring-boot4-starter` 后缀，Boot 3（3.5+）用 `-spring-boot-starter` 后缀。

```xml
<!-- Spring Boot 4：厂商 Starter + AiServices Starter，版本由 BOM 管理 -->
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-open-ai-spring-boot4-starter</artifactId>
</dependency>
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-spring-boot4-starter</artifactId>
</dependency>
```

```yaml
langchain4j:
  open-ai:
    chat-model:
      api-key: ${OPENAI_API_KEY}
      model-name: ${OPENAI_MODEL}
```

接口加 `@AiService`，Starter 会生成实现并注册成 Bean，自动装配容器里的 `ChatModel`、记忆、工具等组件：

```java
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.spring.AiService;

@AiService
public interface SupportAssistant {

    @SystemMessage("你是公司内部 IT 支持助手，只回答与公司系统相关的问题。")
    String chat(String question);
}
```

Boot 4 下使用异步调用（如流式模型）的 OpenAI、Mistral、Ollama Starter 还需要引入 `spring-boot-starter-webclient`，否则会抛 `AsyncNotSupportedException`。

---

## 三、AiServices

AiServices 的执行过程：业务代码调用接口方法，代理解析注解组装请求，依次经过护栏、记忆、检索、工具等组件，再把模型输出转换成方法的返回类型。

![LangChain4j AiServices 调用链路](../../assets/ai/langchain4j-aiservices.svg)

### 1、定义接口

```java
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface JavaAssistant {

    @SystemMessage("你是一位经验丰富的 Java 架构师，回答简洁、务实，使用中文。")
    String chat(String question);

    @SystemMessage("你是一位代码审查专家，请找出以下代码的潜在问题。")
    @UserMessage("代码如下：\n{{code}}\n请给出审查意见。")
    String reviewCode(@V("code") String code);
}
```

### 2、创建与调用

```java
import dev.langchain4j.service.AiServices;

JavaAssistant assistant = AiServices.create(JavaAssistant.class, model);

String answer = assistant.chat("ThreadLocal 有哪些内存泄漏风险？");
String review = assistant.reviewCode("""
        for (int i = 0; i <= list.size(); i++) {
            System.out.println(list.get(i));
        }
        """);
```

需要记忆、工具、检索等组件时改用 `AiServices.builder(JavaAssistant.class)` 逐项配置，后面几节都是这种写法。

### 3、结构化输出

方法返回值写成 record，AiServices 会要求模型按对应结构输出 JSON 并反序列化：

```java
import java.util.List;

public record CodeIssue(String line, String severity, String suggestion) {}
public record ReviewReport(String summary, List<CodeIssue> issues) {}

public interface Reviewer {
    @UserMessage("审查以下代码并按结构返回问题清单：\n{{code}}")
    ReviewReport review(@V("code") String code);
}
```

默认是把结构要求写进提示词。所用厂商支持 JSON Schema 约束时（如 OpenAI），在模型 builder 上开启对应能力可以让输出更稳定，具体参数见官方 Structured Outputs 文档。返回类型还可以写成 `Result<T>`，同时拿到内容、token 用量和检索来源。

### 4、护栏

护栏（Guardrails）在调用模型前后做校验：输入护栏拦截超长、越权或明显的注入输入，输出护栏校验格式、敏感信息，失败时可以拒绝或要求模型重写。

```java
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.guardrail.InputGuardrail;
import dev.langchain4j.guardrail.InputGuardrailResult;
import dev.langchain4j.service.guardrail.InputGuardrails;

public class InputLengthGuard implements InputGuardrail {
    @Override
    public InputGuardrailResult validate(UserMessage userMessage) {
        if (userMessage.singleText().length() > 4000) {
            return failure("输入过长");
        }
        return success();
    }
}

public interface GuardedAssistant {
    @InputGuardrails(InputLengthGuard.class)
    String chat(String question);
}
```

护栏是一层兜底，不能替代权限控制：关键词或规则拦不住所有提示注入，真正的边界在工具权限和数据访问控制上。

---

## 四、ChatMemory

模型无状态，多轮对话靠把历史消息一起发送。LangChain4j 有两种窗口策略：`MessageWindowChatMemory` 按消息条数保留，`TokenWindowChatMemory` 按 token 数保留（需要提供分词估算器）。

### 1、多用户隔离

方法参数加 `@MemoryId`，配合 `chatMemoryProvider` 为每个会话创建独立记忆：

```java
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.UserMessage;

public interface MultiUserAssistant {
    String chat(@MemoryId String conversationId, @UserMessage String message);
}

MultiUserAssistant assistant = AiServices.builder(MultiUserAssistant.class)
        .chatModel(model)
        .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
                .id(memoryId)
                .maxMessages(20)
                .build())
        .build();

// conversationId 由服务端根据登录用户和会话拼出，不直接使用前端传入的值
assistant.chat("u1001:s1", "我叫小明");
assistant.chat("u1001:s1", "我叫什么？");   // 能答出“小明”
```

### 2、持久化

默认存在内存里，重启丢失、多实例不共享。实现 `ChatMemoryStore` 接口（`getMessages` / `updateMessages` / `deleteMessages` 三个方法），用 `ChatMessageSerializer` 把消息序列化成 JSON 存到 Redis 或数据库，再在 `chatMemoryProvider` 里构建 `MessageWindowChatMemory` 时通过 `.chatMemoryStore(store)` 挂上。

---

## 五、Tools

### 1、定义工具

`@Tool` 的描述和 `@P` 的参数说明会作为工具定义发给模型，返回值可以是 record：

```java
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.agent.tool.ToolMemoryId;

public class OrderTools {

    public record UserInfo(long id, String name, String email) {}

    @Tool("根据用户 ID 查询用户信息，返回姓名和邮箱")
    public UserInfo getUserById(@P("用户 ID") long userId) {
        return userRepository.findById(userId);
    }

    @Tool("查询指定商品的可售库存")
    public int getStock(@P("商品名称") String productName) {
        return inventoryService.available(productName);
    }

    @Tool("为当前登录用户创建订单，返回待确认的订单草稿号")
    public String createOrderDraft(@ToolMemoryId String conversationId,
                                   @P("商品名称") String productName,
                                   @P("数量") int quantity) {
        // 用户身份从会话 ID 解析，不让模型传 userId；只生成草稿，用户确认后再由业务代码下单
        return orderService.createDraft(conversationId, productName, quantity);
    }
}
```

### 2、绑定到 AiServices

```java
public interface OrderAssistant {
    @SystemMessage("你是电商客服助手，可以查询用户信息、商品库存，并为用户生成订单草稿。")
    String handle(@MemoryId String conversationId, @UserMessage String userRequest);
}

OrderAssistant assistant = AiServices.builder(OrderAssistant.class)
        .chatModel(model)
        .chatMemoryProvider(id -> MessageWindowChatMemory.withMaxMessages(20))
        .tools(new OrderTools())
        .executeToolsConcurrently()   // 同一轮返回多个工具调用时并发执行
        .build();
```

`executeToolsConcurrently()` 只影响模型在同一轮里一次性请求的多个工具调用，默认是串行执行；有先后依赖的调用（先查用户再下单）由模型在后续轮次中发起，框架不保证顺序。也可以传入 `Executor`，例如 `Executors.newVirtualThreadPerTaskExecutor()`。

### 3、错误处理与补偿

- 工具抛异常时默认把异常消息回传给模型，可能泄露内部细节；用 `toolExecutionErrorHandler` / `toolArgumentsErrorHandler` 改成返回通用错误或直接失败
- 模型调用了不存在的工具时默认抛异常，可以用 `hallucinatedToolNameStrategy` 改为回复模型一条提示
- `@CompensateFor` 标注某个方法是另一个 `@Tool` 的补偿动作，在 builder 上开启 `compensateOnToolErrors(true)` 后，后续工具失败时会按逆序调用已成功工具的补偿方法；它只是声明式的补偿钩子，不是数据库事务，补偿逻辑本身要幂等

### 4、安全边界

工具以应用权限执行，原则与 Spring AI 一致：只暴露必要操作，身份信息通过 `@ToolMemoryId` 或服务端上下文获取，有副作用的操作只生成草稿并由用户确认，工具返回内容可能携带间接提示注入。详见 [Spring AI](./0_spring_ai) 的“安全边界”一节与 [常见漏洞与防护](/security/8_vulnerabilities)。

---

## 六、流式输出

底层模型用 `StreamingChatModel` 加回调：

```java
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;

StreamingChatModel streamingModel = OpenAiStreamingChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName(System.getenv("OPENAI_MODEL"))
        .build();

streamingModel.chat("请详细解释 Java 内存模型（JMM）", new StreamingChatResponseHandler() {

    @Override
    public void onPartialResponse(String partialResponse) {
        System.out.print(partialResponse);   // 实际场景推送到 SSE
    }

    @Override
    public void onCompleteResponse(ChatResponse completeResponse) {
        System.out.println("\n总 token：" + completeResponse.metadata().tokenUsage().totalTokenCount());
    }

    @Override
    public void onError(Throwable error) {
        error.printStackTrace();
    }
});
```

AiServices 中把返回类型写成 `TokenStream`：

```java
import dev.langchain4j.service.TokenStream;

public interface StreamingAssistant {
    TokenStream chat(String message);
}

StreamingAssistant assistant = AiServices.builder(StreamingAssistant.class)
        .streamingChatModel(streamingModel)
        .build();

assistant.chat("请解释 Java 虚拟线程")
        .onPartialResponse(System.out::print)
        .onCompleteResponse(response -> System.out.println("\n完成"))
        .onError(Throwable::printStackTrace)
        .start();
```

在 Spring 中把回调桥接到 `SseEmitter` 或 `Flux` 即可推给前端，SSE 细节见 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 七、RAG

核心组件是 `EmbeddingStoreIngestor`（加载、切块、向量化、入库）和 `EmbeddingStoreContentRetriever`（按问题检索并注入提示词）。`FileSystemDocumentLoader` 默认只按纯文本解析，PDF 需要引入 `langchain4j-document-parser-apache-pdfbox` 并传入解析器，Word 等格式用 Apache Tika 解析器。

```java
import java.nio.file.Path;
import java.util.List;
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.loader.FileSystemDocumentLoader;
import dev.langchain4j.data.document.parser.apache.pdfbox.ApachePdfBoxDocumentParser;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName(System.getenv("OPENAI_EMBEDDING_MODEL"))
        .build();

EmbeddingStore<TextSegment> embeddingStore = new InMemoryEmbeddingStore<>();   // 生产换成向量库实现

List<Document> documents = FileSystemDocumentLoader.loadDocuments(
        Path.of("/data/knowledge"), new ApachePdfBoxDocumentParser());
documents.forEach(doc -> doc.metadata().put("tenant", "acme"));   // 入库时写入权限元数据

EmbeddingStoreIngestor.builder()
        .documentSplitter(DocumentSplitters.recursive(500, 50))
        .embeddingModel(embeddingModel)
        .embeddingStore(embeddingStore)
        .build()
        .ingest(documents);
```

检索器绑定到 AiServices，并按当前用户的租户做元数据过滤：

```java
import static dev.langchain4j.store.embedding.filter.MetadataFilterBuilder.metadataKey;

import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;

public interface KnowledgeAssistant {
    String ask(String question);
}

EmbeddingStoreContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
        .embeddingStore(embeddingStore)
        .embeddingModel(embeddingModel)
        .maxResults(5)
        .minScore(0.6)
        .dynamicFilter(query -> metadataKey("tenant").isEqualTo(currentTenant()))
        .build();

KnowledgeAssistant assistant = AiServices.builder(KnowledgeAssistant.class)
        .chatModel(model)
        .contentRetriever(retriever)
        .build();
```

切块策略、混合检索、重排与评估见 [RAG 检索增强生成](../4_core_tech/2_rag)，向量库选型见 [向量数据库](../4_core_tech/1_vector_db)。

---

## 八、MCP 客户端

`langchain4j-mcp` 模块把远端 MCP Server 的工具接成 `ToolProvider`，和本地工具一样参与工具调用：

```java
import java.util.Map;
import dev.langchain4j.mcp.McpToolProvider;
import dev.langchain4j.mcp.client.DefaultMcpClient;
import dev.langchain4j.mcp.client.McpClient;
import dev.langchain4j.mcp.client.transport.McpTransport;
import dev.langchain4j.mcp.client.transport.http.StreamableHttpMcpTransport;

McpTransport transport = StreamableHttpMcpTransport.builder()
        .url("https://mcp.example.com/mcp")
        .customHeaders(Map.of("Authorization", "Bearer " + accessToken))   // 令牌按 OAuth 流程获取
        .build();

McpClient mcpClient = DefaultMcpClient.builder()
        .key("docs-server")
        .transport(transport)
        .build();

McpToolProvider toolProvider = McpToolProvider.builder()
        .mcpClients(mcpClient)
        .filterToolNames("search_docs", "get_doc")   // 只放行需要的工具
        .build();

Bot bot = AiServices.builder(Bot.class)
        .chatModel(model)
        .toolProvider(toolProvider)
        .build();
```

本地子进程形式的 MCP Server 用 `StdioMcpTransport`。第三方 MCP Server 的工具描述和返回内容都可能被投毒，接入前审查来源、只放行白名单工具，远程 HTTP 传输按 MCP 规范用 OAuth 授权。协议细节见 [MCP 协议](../5_advanced/1_mcp)。

---

## 九、Agent 编排：langchain4j-agentic 与 LangGraph4j

单个 AiService 加工具已经是一个简单 Agent；需要多个 Agent 按流程协作时有两个选择。

**langchain4j-agentic**：LangChain4j 自带的模块（`dev.langchain4j:langchain4j-agentic`，beta 版本，官方明确为实验性，API 可能变化）。用 `@Agent` 标注单方法接口，再用 `AgenticServices` 组合：

- `sequenceBuilder()` 顺序执行，`parallelBuilder()` 并行执行，`loopBuilder()` 循环直到满足退出条件或达到最大次数，`conditionalBuilder()` 按条件激活
- `supervisorBuilder()` 由 LLM 规划下一步调用哪个子 Agent
- `humanInTheLoopBuilder()` 在流程中插入等待人工输入的节点
- 子 Agent 通过共享的 `AgenticScope` 按 `outputKey` 读写中间结果

```java
import java.util.Map;
import dev.langchain4j.agentic.Agent;
import dev.langchain4j.agentic.AgenticServices;
import dev.langchain4j.agentic.UntypedAgent;

public interface CreativeWriter {
    @UserMessage("围绕主题 {{topic}} 写一个 3 句话的小故事")
    @Agent(description = "根据主题写故事", outputKey = "story")
    String write(@V("topic") String topic);
}

public interface AudienceEditor {
    @UserMessage("把下面的故事改写得适合 {{audience}} 阅读：{{story}}")
    @Agent(description = "按目标读者改写故事", outputKey = "story")
    String edit(@V("story") String story, @V("audience") String audience);
}

CreativeWriter writer = AgenticServices.agentBuilder(CreativeWriter.class)
        .chatModel(model)
        .outputKey("story")
        .build();
AudienceEditor editor = AgenticServices.agentBuilder(AudienceEditor.class)
        .chatModel(model)
        .outputKey("story")
        .build();

UntypedAgent pipeline = AgenticServices.sequenceBuilder()
        .subAgents(writer, editor)
        .outputKey("story")
        .build();

String story = (String) pipeline.invoke(Map.of("topic", "分布式锁", "audience", "初级工程师"));
```

**LangGraph4j**：独立的开源项目（groupId `org.bsc.langgraph4j`，核心包 `langgraph4j-core`，与 LangChain4j 集成用 `langgraph4j-langchain4j`，版本号独立，截至 2026-10 为 1.9.x），用有状态的图（节点 + 边）描述流程，支持回环、条件分支和检查点持久化，适合需要中断恢复的长流程。

| 场景 | 建议 |
|------|------|
| 单 Agent 加工具、RAG 问答 | AiServices 即可 |
| 固定的顺序 / 并行 / 循环流程 | `langchain4j-agentic` 的工作流构建器 |
| 流程复杂、需要检查点持久化与中断恢复 | LangGraph4j |

Agent 的通用模式（ReAct、规划、多 Agent 协作）见 [AI Agent 智能体](../5_advanced/0_agent)。

---

## 十、0.x 升级到 1.x 的要点

| 0.x | 1.x |
|-----|-----|
| `ChatLanguageModel` / `StreamingChatLanguageModel` | `ChatModel` / `StreamingChatModel` |
| `model.generate(...)` | `model.chat(...)` |
| `StreamingResponseHandler`：`onNext` / `onComplete` | `StreamingChatResponseHandler`：`onPartialResponse` / `onCompleteResponse` |
| `AiServices.builder(...).chatLanguageModel(...)` | `.chatModel(...)` |
| 统一的 `langchain4j-spring-boot-starter` 承担一切 | 厂商 Starter 与 AiServices Starter 分开，Boot 4 另有 `-spring-boot4-starter` 系列 |

---

## 小结

- 用 `langchain4j-bom` 管理版本，稳定模块与 `-betaN` 实验模块混用时不必手写版本号
- AiServices 用接口声明 AI 能力，记忆、工具、检索、护栏都在 builder 上组合，返回值可以是 String、record、`Result<T>` 或 `TokenStream`
- 多用户靠 `@MemoryId` + `chatMemoryProvider` 隔离，会话 ID 由服务端生成，持久化实现 `ChatMemoryStore`
- `executeToolsConcurrently()` 只并发同一轮的多个调用；工具身份走 `@ToolMemoryId`，有副作用的工具只出草稿并让用户确认
- RAG 入库时写权限元数据、检索时用 `dynamicFilter` 过滤；PDF 等格式要显式指定解析器
- MCP 工具用 `McpToolProvider` 接入并按白名单过滤；多 Agent 流程用实验性的 `langchain4j-agentic`，复杂有状态流程考虑 LangGraph4j

## 参考资料

- LangChain4j 文档：[https://docs.langchain4j.dev/](https://docs.langchain4j.dev/)
- AI Services：[https://docs.langchain4j.dev/tutorials/ai-services](https://docs.langchain4j.dev/tutorials/ai-services)
- Tools：[https://docs.langchain4j.dev/tutorials/tools](https://docs.langchain4j.dev/tutorials/tools)
- MCP：[https://docs.langchain4j.dev/tutorials/mcp](https://docs.langchain4j.dev/tutorials/mcp)
- Agents and Agentic AI：[https://docs.langchain4j.dev/tutorials/agents](https://docs.langchain4j.dev/tutorials/agents)
- Spring Boot Integration：[https://docs.langchain4j.dev/tutorials/spring-boot-integration](https://docs.langchain4j.dev/tutorials/spring-boot-integration)
- GitHub：[https://github.com/langchain4j/langchain4j](https://github.com/langchain4j/langchain4j)
- LangGraph4j：[https://github.com/langgraph4j/langgraph4j](https://github.com/langgraph4j/langgraph4j)

> 下一篇：[Ollama](../3_integration/0_ollama) —— 本地运行开源模型，原生与 OpenAI 兼容 API，Spring AI / LangChain4j 接入与调优。

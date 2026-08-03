# LangChain4j

> 参考资料：
> * 官方文档：[https://docs.langchain4j.dev/](https://docs.langchain4j.dev/)
> * GitHub：[https://github.com/langchain4j/langchain4j](https://github.com/langchain4j/langchain4j)

---

## 一、是什么

LangChain4j 是 LangChain（Python）的 Java 移植，提供从底层 LLM 调用到高层 Agent 编排的完整工具链。

**与 Spring AI 的核心差异：**

| 维度 | Spring AI | LangChain4j |
|---|---|---|
| 定位 | Spring 官方，与 Boot 深度集成 | 独立框架，Spring Boot 可选集成 |
| 适用场景 | 标准 ChatBot / RAG / Tool Calling | 复杂 Agent、多步推理、Memory 管理 |
| 抽象风格 | Spring Bean / 自动配置 | 接口驱动、AiServices 代理 |
| 灵活性 | 偏约定，配置简单 | 更底层，组合自由度高 |
| 工具补偿 | 不支持 | 支持（@CompensateFor，事务回滚） |
| 并发工具执行 | 不支持 | 支持（executeToolsConcurrently） |
| 思考模型流式 | 不支持 | 支持（onPartialThinking 回调） |

简单项目用 Spring AI 足够；需要多轮对话记忆管理、复杂工具链、自定义 Agent 时选 LangChain4j。

---

## 二、快速接入

### Maven 依赖

```xml
<!-- 核心 + OpenAI 实现 -->
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j</artifactId>
  <version>1.18.1</version>
</dependency>
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-open-ai</artifactId>
  <version>1.18.1</version>
</dependency>

<!-- 可选：Spring Boot Starter（按 provider 选择，自动配置） -->
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-open-ai-spring-boot-starter</artifactId>
  <version>1.18.1</version>
</dependency>
```

> **说明**：1.x 版本将 Spring Boot Starter 拆分为按 provider 的子包（如 `langchain4j-open-ai-spring-boot-starter`），不再使用旧版统一的 `langchain4j-spring-boot-starter`。

### 基础调用（不依赖 Spring）

```java
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;

// 1.x：ChatLanguageModel 已重命名为 ChatModel
ChatModel model = OpenAiChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4o-mini")
        .temperature(0.7)
        .build();

// 1.x：generate() 已重命名为 chat()
String answer = model.chat("Java 中 volatile 解决了什么问题？");
System.out.println(answer);
```

---

## 三、AiServices（高层 API）

AiServices 是 LangChain4j 最推荐的用法：用接口定义 AI 行为，框架自动生成实现。

### 定义接口

```java
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface JavaAssistant {

    @SystemMessage("你是一位经验丰富的 Java 架构师，回答简洁、务实，使用中文。")
    String chat(@UserMessage String question);

    @SystemMessage("你是一位代码审查专家，请找出以下代码的潜在问题。")
    @UserMessage("代码如下：\n{{code}}\n请给出审查意见。")
    String reviewCode(@V("code") String code);
}
```

### 创建实例并使用

```java
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;

ChatModel model = OpenAiChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4o-mini")
        .build();

JavaAssistant assistant = AiServices.create(JavaAssistant.class, model);

String answer = assistant.chat("ThreadLocal 有哪些内存泄漏风险？");
System.out.println(answer);

String review = assistant.reviewCode("""
        public void process(List<String> list) {
            for (int i = 0; i <= list.size(); i++) {
                System.out.println(list.get(i));
            }
        }
        """);
System.out.println(review);
```

> **1.x 变更**：`AiServices.builder()` 中 `.chatLanguageModel()` 已重命名为 `.chatModel()`。

---

## 四、ChatMemory（对话记忆）

默认情况下每次调用都是无状态的。`ChatMemory` 让 AI 记住上下文，实现真正的多轮对话。

### MessageWindowChatMemory

```java
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.service.AiServices;

// 保留最近 10 条消息（超出自动滑窗）
MessageWindowChatMemory memory = MessageWindowChatMemory.withMaxMessages(10);

JavaAssistant assistant = AiServices.builder(JavaAssistant.class)
        .chatModel(model)          // 1.x：chatLanguageModel → chatModel
        .chatMemory(memory)
        .build();

// 第一轮
assistant.chat("我叫小明，是一名 Java 开发者。");

// 第二轮：模型能记住"小明"
String response = assistant.chat("你知道我是做什么的吗？");
// 输出：你是一名 Java 开发者，小明。
System.out.println(response);
```

### 多用户隔离（每用户独立 Memory）

```java
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.UserMessage;

public interface MultiUserAssistant {
    String chat(@MemoryId String userId, @UserMessage String message);
}

// 使用 memoryId 区分不同用户的会话
MultiUserAssistant assistant = AiServices.builder(MultiUserAssistant.class)
        .chatModel(model)
        .chatMemoryProvider(memoryId ->
                MessageWindowChatMemory.builder()
                        .id(memoryId)
                        .maxMessages(10)
                        .build())
        .build();

assistant.chat("user-001", "我叫小明");
assistant.chat("user-002", "我叫小红");

// 两用户记忆完全隔离
System.out.println(assistant.chat("user-001", "我叫什么？")); // 小明
System.out.println(assistant.chat("user-002", "我叫什么？")); // 小红
```

---

## 五、Tools（工具调用）

LangChain4j 用 `@Tool` 注解定义工具，比 Spring AI 更灵活，支持复杂参数和返回类型。

### 定义工具类

```java
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.agent.tool.P;

public class DatabaseTools {

    @Tool("根据用户 ID 查询用户信息，返回用户姓名和邮箱")
    public String getUserById(@P("用户ID") long userId) {
        // 实际查数据库，这里模拟
        return String.format("用户ID=%d，姓名=张三，邮箱=zhangsan@example.com", userId);
    }

    @Tool("查询指定商品的库存数量")
    public int getStock(@P("商品名称") String productName) {
        // 模拟库存查询
        return (int) (Math.random() * 100);
    }

    @Tool("创建订单，返回订单编号")
    public String createOrder(@P("用户ID") long userId,
                              @P("商品名称") String productName,
                              @P("数量") int quantity) {
        return "ORDER-" + System.currentTimeMillis();
    }
}
```

### 绑定到 AiServices

```java
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public interface OrderAssistant {
    @SystemMessage("你是一个电商客服助手，可以查询用户信息、商品库存，并帮用户下单。")
    String handle(@UserMessage String userRequest);
}

DatabaseTools tools = new DatabaseTools();

OrderAssistant assistant = AiServices.builder(OrderAssistant.class)
        .chatModel(model)
        .tools(tools)                        // 注册工具实例
        .executeToolsConcurrently(true)      // 1.x 新增：支持并发工具执行
        .build();

String result = assistant.handle("帮用户ID=1001查询一下，然后给他下一个笔记本电脑的订单，数量1件");
System.out.println(result);
// 模型会自动按顺序调用 getUserById → getStock → createOrder
```

---

## 六、Streaming（流式输出）

```java
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;

// 1.x：StreamingChatLanguageModel 已重命名为 StreamingChatModel
StreamingChatModel streamingModel = OpenAiStreamingChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4o-mini")
        .build();

// 1.x：StreamingResponseHandler → StreamingChatResponseHandler
streamingModel.chat("请详细解释 Java 内存模型（JMM）", new StreamingChatResponseHandler() {

    @Override
    public void onPartialResponse(String partialResponse) {
        // 1.x：onNext() → onPartialResponse()
        // 每收到一个 token 立即处理（如推送到 SSE）
        System.out.print(partialResponse);
    }

    @Override
    public void onCompleteResponse(ChatResponse completeResponse) {
        // 1.x：onComplete(Response<AiMessage>) → onCompleteResponse(ChatResponse)
        System.out.println("\n--- 完成，总 token：" +
                completeResponse.metadata().tokenUsage().totalTokenCount());
    }

    @Override
    public void onError(Throwable error) {
        error.printStackTrace();
    }
});
```

在 Spring Boot 中配合 `SseEmitter` 或 WebFlux `Flux` 可直接推送到前端。

### AiServices 流式（TokenStream）

```java
import dev.langchain4j.service.TokenStream;

public interface StreamingAssistant {
    TokenStream chat(String message);
}

StreamingAssistant assistant = AiServices.builder(StreamingAssistant.class)
        .streamingChatModel(streamingModel)
        .build();

assistant.chat("请解释 Java 虚拟线程")
        .onPartialResponse(token -> System.out.print(token))
        .onCompleteResponse(response -> System.out.println("\n完成"))
        .onError(Throwable::printStackTrace)
        .start();
```

---

## 七、RAG 集成

LangChain4j 提供 `EmbeddingStoreIngestor`（文档入库）和 `EmbeddingStoreContentRetriever`（检索增强）两个核心组件。

```java
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.document.loader.FileSystemDocumentLoader;  // 1.x 包路径已调整
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

// 1. 准备 Embedding 模型和向量存储
EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("text-embedding-3-small")
        .build();

EmbeddingStore<TextSegment> embeddingStore = new InMemoryEmbeddingStore<>();

// 2. 文档入库（支持 PDF、TXT、Markdown 等）
List<Document> documents = FileSystemDocumentLoader.loadDocuments("/docs/knowledge");
EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
        .embeddingModel(embeddingModel)
        .embeddingStore(embeddingStore)
        .build();
ingestor.ingest(documents);

// 3. 构建检索器并绑定到 AiServices
EmbeddingStoreContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
        .embeddingStore(embeddingStore)
        .embeddingModel(embeddingModel)
        .maxResults(5)
        .minScore(0.6)
        .build();

public interface KnowledgeAssistant {
    String ask(@UserMessage String question);
}

KnowledgeAssistant assistant = AiServices.builder(KnowledgeAssistant.class)
        .chatModel(model)                   // 1.x：chatLanguageModel → chatModel
        .contentRetriever(retriever)        // 自动检索相关内容注入 prompt
        .build();

String answer = assistant.ask("公司请假流程是什么？");
```

详细的 RAG 架构和向量数据库选型见 [RAG 检索增强生成](../4_core_tech/2_rag.md)。

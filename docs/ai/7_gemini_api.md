# Gemini API

> 参考资料：
> * Google AI for Developers：[https://ai.google.dev/](https://ai.google.dev/)
> * Gemini API 文档：[https://ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs)
> * Spring AI Gemini：[https://docs.spring.io/spring-ai/reference/api/chat/vertexai-gemini-chat.html](https://docs.spring.io/spring-ai/reference/api/chat/vertexai-gemini-chat.html)

---

## 一、模型总览

| 模型 | 状态 | 用途 | 上下文窗口 | 特点 |
|------|------|------|-----------|------|
| gemini-3.5-flash | 稳定版 | Agent / 编程任务首选 | 1M tokens | 智能体与代码生成最优模型 |
| gemini-3.1-flash-lite | 稳定版 | 轻量多任务处理 | 1M tokens | 成本最低，适合高频调用 |
| gemini-3.1-pro-preview | 预览版 | 高级推理与复杂分析 | 1M tokens | 最强综合智能，适合复杂任务 |
| gemini-3-flash-preview | 预览版 | 快速多模态任务 | 1M tokens | 轻量快速，适合实验性功能 |
| gemini-embedding-2 | 稳定版 | 多模态向量化 | 8K tokens | 支持文本与图像，语义检索/RAG 推荐 |

> **上一代模型**（gemini-2.5-pro / gemini-2.5-flash）仍可使用，但推荐迁移到 3.x 系列。
>
> 1M tokens 超长上下文使 Gemini 特别适合处理整个代码库、长文档分析等场景。

---

## 二、Google AI Studio vs Vertex AI

| 维度 | Google AI Studio | Vertex AI |
|------|------------------|-----------|
| 定位 | 开发测试、个人项目 | 生产环境、企业级 |
| 认证方式 | API Key（简单） | Google Cloud 服务账号（IAM） |
| 配额 | 免费额度，较低 | 按需付费，高配额 |
| 功能 | Gemini 核心能力 | 更多企业功能（Fine-tuning / MLOps） |
| 数据隐私 | 默认用于模型改进 | 数据不用于训练，符合企业合规 |

### 获取 API Key

1. 访问 [Google AI Studio](https://aistudio.google.com/)，登录 Google 账号
2. 点击右上角 **Get API key** → Create API key
3. 将 Key 存入环境变量：`export GEMINI_API_KEY=your_key`

---

## 三、官方 Java SDK 快速接入

### Maven 依赖

```xml
<dependency>
    <groupId>com.google.genai</groupId>
    <artifactId>google-genai</artifactId>
    <version>1.64.0</version>
</dependency>
```

### 初始化客户端

```java
import com.google.genai.Client;

Client client = Client.builder()
        .apiKey(System.getenv("GEMINI_API_KEY"))
        .build();
```

### 基础文本生成

```java
import com.google.genai.types.GenerateContentResponse;
import com.google.genai.types.Content;
import com.google.genai.types.Part;

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

---

## 四、多模态（图片 + 文本）

```java
import com.google.genai.types.Blob;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

// 读取本地图片并 base64 编码
byte[] imageBytes = Files.readAllBytes(Paths.get("architecture.png"));
String base64Image = Base64.getEncoder().encodeToString(imageBytes);

Blob imageBlob = Blob.builder()
        .mimeType("image/png")
        .data(imageBytes)
        .build();

GenerateContentResponse response = client.models().generateContent(
        "gemini-3.5-flash",
        Content.builder()
                .role("user")
                .addPart(Part.fromBytes(imageBytes, "image/png"))
                .addPart(Part.fromText("请描述这张架构图中各个服务的职责。"))
                .build(),
        null
);

System.out.println(response.text());
```

---

## 五、流式响应

```java
import com.google.genai.ResponseStream;
import com.google.genai.types.GenerateContentResponse;

ResponseStream<GenerateContentResponse> stream = client.models().generateContentStream(
        "gemini-3.5-flash",
        Content.builder()
                .role("user")
                .addPart(Part.fromText("详细讲解 Kafka 消费者组的 Rebalance 过程。"))
                .build(),
        null
);

for (GenerateContentResponse chunk : stream) {
    System.out.print(chunk.text());
}
System.out.println();
stream.close();
```

---

## 六、Function Calling

### 定义 FunctionDeclaration

```java
import com.google.genai.types.*;
import java.util.List;
import java.util.Map;

Schema cityParam = Schema.builder()
        .type("STRING")
        .description("城市名称，例如：北京、上海")
        .build();

FunctionDeclaration weatherFunc = FunctionDeclaration.builder()
        .name("get_weather")
        .description("获取指定城市的实时天气信息")
        .parameters(Schema.builder()
                .type("OBJECT")
                .properties(Map.of("city", cityParam))
                .required(List.of("city"))
                .build())
        .build();

Tool tool = Tool.builder()
        .functionDeclarations(List.of(weatherFunc))
        .build();

GenerateContentConfig config = GenerateContentConfig.builder()
        .tools(List.of(tool))
        .build();
```

### 第一轮：获取 functionCall

```java
GenerateContentResponse round1 = client.models().generateContent(
        "gemini-3.5-flash",
        Content.builder()
                .role("user")
                .addPart(Part.fromText("上海今天的天气如何？"))
                .build(),
        config
);

// 解析 functionCall
round1.candidates().get(0).content().parts().forEach(part -> {
    part.functionCall().ifPresent(fc -> {
        System.out.println("函数名：" + fc.name());
        System.out.println("参数：" + fc.args());
    });
});
```

### 第二轮：回传 functionResponse

```java
FunctionResponse funcResult = FunctionResponse.builder()
        .name("get_weather")
        .response(Map.of(
            "temperature", 28,
            "condition", "多云转晴",
            "humidity", "65%"
        ))
        .build();

GenerateContentResponse round2 = client.models().generateContent(
        "gemini-3.5-flash",
        List.of(
            Content.builder().role("user")
                    .addPart(Part.fromText("上海今天的天气如何？")).build(),
            round1.candidates().get(0).content(),  // model 的 functionCall 消息
            Content.builder().role("function")
                    .addPart(Part.fromFunctionResponse(funcResult)).build()
        ),
        config
);

System.out.println(round2.text());
```

---

## 七、Spring AI 接入

### Maven 依赖

```xml
<!-- 使用 Vertex AI Gemini（推荐生产环境） -->
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-vertex-ai-gemini-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

### application.yaml 配置

```yaml
spring:
  ai:
    vertex:
      ai:
        gemini:
          project-id: ${GCP_PROJECT_ID}
          location: us-central1
          chat:
            options:
              model: gemini-3.5-flash
              temperature: 0.7
              max-output-tokens: 2048
```

> 使用 Google AI Studio（API Key）时改用 `spring-ai-google-genai-spring-boot-starter`，配置 `spring.ai.google.genai.api-key`。

### ChatClient 调用示例

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
public class GeminiChatService {

    private final ChatClient chatClient;

    public GeminiChatService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一位专业的 Java 后端工程师。")
                .build();
    }

    public String chat(String message) {
        return chatClient.prompt()
                .user(message)
                .call()
                .content();
    }

    public Flux<String> chatStream(String message) {
        return chatClient.prompt()
                .user(message)
                .stream()
                .content();
    }
}
```

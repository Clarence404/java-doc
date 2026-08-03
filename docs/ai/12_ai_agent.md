# AI Agent

> 参考资料：
> * LangChain Agents：[https://python.langchain.com/docs/concepts/agents/](https://python.langchain.com/docs/concepts/agents/)
> * LangChain4j Agents：[https://docs.langchain4j.dev/tutorials/ai-services](https://docs.langchain4j.dev/tutorials/ai-services)

---

## 一、是什么

### Agent 与普通 LLM 调用的区别

普通 LLM 调用是单轮的：给一个输入，得到一个输出，调用结束。

AI Agent 则是**自主循环执行**的系统：LLM 作为"大脑"，根据目标自主规划步骤，按需调用外部工具，将工具结果再输入 LLM 继续推理，直到任务完成。

| 维度 | 普通 LLM 调用 | AI Agent |
|------|--------------|---------|
| 执行方式 | 单轮请求-响应 | 多轮循环，自主决策 |
| 工具使用 | 不支持 | 按需调用工具 |
| 记忆 | 无持久化 | 可跨轮次保留上下文 |
| 适用场景 | 问答、摘要、翻译 | 复杂多步任务、需要外部信息 |

### 适用场景

- **复杂多步任务**：如"分析竞品、生成报告、发送邮件"，需要多步骤协作
- **需要外部信息**：如查询数据库、调用 API、读写文件
- **不确定步骤数**：任务边界模糊，需要 LLM 自主判断何时结束

---

## 二、核心组件

| 组件 | 职责 | 说明 |
|------|------|------|
| **LLM（大脑）** | 推理与决策 | 分析当前状态，决定下一步调用哪个工具，或直接返回最终答案 |
| **Memory（记忆）** | 上下文管理 | Short-term：当前对话历史；Long-term：向量数据库存储的历史摘要 |
| **Tools（工具）** | 执行能力扩展 | 搜索、计算器、数据库查询、HTTP 请求、代码执行等 |
| **Planning（规划）** | 任务分解 | 将复杂目标拆解为可执行的子任务序列，如 ReAct、CoT、ToT |

---

## 三、ReAct 模式

ReAct（Reasoning + Acting）是目前最主流的 Agent 推理框架，核心思路：**将推理与行动交织在一起**，每一步都先 Think 再 Act，观察结果后继续 Think。

**循环流程：**

![ReAct 推理循环](../assets/ai/react-loop.svg)

每一轮 Thought-Action-Observation 构成一个"推理步"，Agent 自主决定循环次数，通常会设置最大步数防止无限循环。

---

## 四、Tool Calling（工具调用）

### LLM 如何决定调用哪个工具

开发者在初始化 Agent 时注册所有可用工具，每个工具包含名称、描述和参数 Schema。LLM 在 Thought 阶段分析目标，匹配最合适的工具，生成结构化的调用指令（JSON 格式），框架负责解析并执行实际调用，将结果作为 Observation 返回给 LLM。

### 工具定义示例（JSON Schema）

```json
{
  "name": "get_weather",
  "description": "获取指定城市的当前天气",
  "parameters": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "城市名称，如 '上海'"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "温度单位"
      }
    },
    "required": ["city"]
  }
}
```

### 调用-返回-再推理循环

```
LLM 输出：{"tool": "get_weather", "args": {"city": "上海"}}
    ↓ 框架执行工具
工具返回：{"temperature": 28, "condition": "晴天"}
    ↓ 框架将结果拼入对话上下文
LLM 继续推理：温度28度，晴天，生成最终回复
```

---

## 五、LangChain4j 实战

### 依赖

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-spring-boot-starter</artifactId>
    <version>0.36.2</version>
</dependency>
```

### 定义工具

```java
@Component
public class AgentTools {

    @Tool("获取指定城市的当前天气")
    public String getWeather(@P("城市名称") String city) {
        // 实际调用天气 API
        return city + "：晴天，28°C";
    }

    @Tool("发送邮件给指定收件人")
    public String sendEmail(
            @P("收件人邮箱") String to,
            @P("邮件正文") String body) {
        // 实际调用邮件服务
        return "邮件已发送至 " + to;
    }
}
```

### 定义 AI Service 接口

```java
// @AiService 让 LangChain4j 自动实现该接口
public interface WeatherAssistant {
    String chat(String userMessage);
}
```

### 注册 Agent（Spring Boot 配置）

```java
@Configuration
public class AgentConfig {

    @Bean
    public WeatherAssistant weatherAssistant(
            ChatLanguageModel model,
            AgentTools tools) {
        return AiServices.builder(WeatherAssistant.class)
                .chatLanguageModel(model)
                .tools(tools)                        // 注册工具
                .chatMemory(MessageWindowChatMemory.withMaxMessages(20))
                .build();
    }
}
```

### 调用示例（多步骤任务）

```java
@RestController
@RequiredArgsConstructor
public class AgentController {

    private final WeatherAssistant assistant;

    @GetMapping("/agent/chat")
    public String chat(@RequestParam String message) {
        // 用户："查一下上海天气，然后把结果发邮件给 test@example.com"
        // Agent 会自动：
        //   1. 调用 getWeather("上海")
        //   2. 调用 sendEmail("test@example.com", "上海天气：晴天28°C")
        //   3. 返回最终文字确认
        return assistant.chat(message);
    }
}
```

---

## 六、Spring AI 实战

### 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
</dependency>
```

### 定义工具

```java
@Component
public class WeatherService {

    @Tool(description = "获取指定城市的当前天气信息")
    public String getWeather(String city) {
        return city + "：晴天，28°C";
    }

    @Tool(description = "查询数据库获取用户信息")
    public String getUserInfo(String userId) {
        return "用户 " + userId + "：张三，VIP用户";
    }
}
```

### 注册工具并调用

```java
@Service
@RequiredArgsConstructor
public class AgentService {

    private final ChatClient.Builder chatClientBuilder;
    private final WeatherService weatherService;

    public String chat(String userMessage) {
        ChatClient chatClient = chatClientBuilder
                .defaultTools(weatherService)   // 注册工具
                .build();

        return chatClient.prompt()
                .user(userMessage)
                .call()
                .content();
    }
}
```

### 配置

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o
          temperature: 0.7
```

---

## 七、Multi-Agent 模式

### Orchestrator-Worker 模式

当单个 Agent 难以处理极复杂任务时，可以引入多 Agent 协作：

- **Orchestrator（编排者）**：主 Agent，负责理解用户目标、任务分解、分配给子 Agent、汇总结果
- **Worker（执行者）**：专门化的子 Agent，各自有专属工具和职责（如"搜索 Agent"、"数据分析 Agent"、"报告生成 Agent"）

![Multi-Agent Orchestrator-Worker 模式](../assets/ai/multi-agent.svg)

### LangChain4j 实现思路

```java
// 每个 Worker Agent 是独立的 AiService
public interface SearchAgent {
    String search(String query);
}

public interface AnalysisAgent {
    String analyze(String data);
}

// Orchestrator 将 Worker Agent 作为工具注册
@Component
public class OrchestratorTools {

    private final SearchAgent searchAgent;
    private final AnalysisAgent analysisAgent;

    @Tool("搜索互联网信息")
    public String delegateSearch(String query) {
        return searchAgent.search(query);
    }

    @Tool("分析数据并生成摘要")
    public String delegateAnalysis(String data) {
        return analysisAgent.analyze(data);
    }
}

// 主 Orchestrator
public interface OrchestratorAgent {
    String execute(String task);
}

@Bean
public OrchestratorAgent orchestratorAgent(
        ChatLanguageModel model,
        OrchestratorTools tools) {
    return AiServices.builder(OrchestratorAgent.class)
            .chatLanguageModel(model)
            .tools(tools)
            .build();
}
```

> **注意事项：**
> - 控制最大递归深度，防止 Agent 相互调用陷入循环
> - Orchestrator 需要比 Worker 更强的模型（如 GPT-4o 而非 GPT-4o-mini）
> - Worker Agent 之间保持无状态，通过返回值传递信息

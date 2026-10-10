---
description: 协议流程、各家差异、tool_choice、strict 模式、@Tool 用法、工具安全
---

# Function Calling（工具调用）

> 前置阅读：[Prompt 工程](./1_prompt)

Function Calling 让模型用结构化方式请求调用外部工具，是 Agent 与 MCP 的基础。本篇讲两轮协议、各家差异、tool_choice 与 strict 模式、@Tool 写法和工具安全。

---

## 一、解决什么问题

LLM 本身只会生成文本：不知道现在几点、查不了数据库、发不了请求。Function Calling（也叫 Tool Calling、Tool Use）让模型以结构化的方式表达「我想调用哪个工具、传什么参数」，由应用代码真正执行后把结果交回给模型。它是 LLM 连接外部世界的基础协议，Agent、MCP 都构建在它之上。

**最关键的一点：模型从不执行函数。** 它只输出调用意图（工具名 + JSON 参数），执行永远发生在你的代码里，所以权限控制、参数校验、审计都是应用的责任。

---

## 二、协议流程

![Function Calling 协议流程](../../assets/ai/function-calling-flow.svg)

一次完整的工具调用是**两轮请求**。下面以 OpenAI Chat Completions 格式为例，这也是 DeepSeek、通义千问、Ollama 等兼容接口普遍采用的格式；其他格式的差异见第三节。

### 1、第一轮：带工具定义请求

```json
{
  "model": "${MODEL_ID}",
  "messages": [
    {"role": "user", "content": "北京今天多少度？"}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "查询指定城市的当前天气。用户询问天气、气温、是否下雨时使用",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "城市名，如：北京"}
        },
        "required": ["city"],
        "additionalProperties": false
      },
      "strict": true
    }
  }]
}
```

### 2、模型返回调用意图

模型判断需要工具时，返回的不是文本而是调用意图：

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\": \"北京\"}"}
      }]
    }
  }]
}
```

### 3、第二轮：执行后回传结果

应用解析 `arguments`、执行真实函数，把结果以 `role=tool` 消息追加后**再次请求**：

```json
{
  "messages": [
    {"role": "user", "content": "北京今天多少度？"},
    {"role": "assistant", "tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"北京\"}"}}]},
    {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temp\": -2, \"condition\": \"晴\"}"}
  ],
  "tools": ["...与第一轮相同..."]
}
```

模型这次返回自然语言「北京今天晴，气温零下 2 度」，`finish_reason` 为 `stop`。

在这个格式里，`arguments` 是**字符串形式的 JSON**，要再解析一次；`tool_call_id` 必须和调用意图里的 `id` 一一对应，多个调用靠它配对。

---

## 三、各家协议差异

概念相同，字段不同。直接对接 API 时要按各自格式解析；用 Spring AI、LangChain4j 时由框架抹平差异。

| 环节 | OpenAI Chat Completions | OpenAI Responses API | Anthropic Messages API |
|------|------------------------|---------------------|-----------------------|
| 工具定义 | `tools[].function.parameters` | `tools[]`（`type: function`，`parameters` 平铺在工具对象上） | `tools[].input_schema` |
| 需要调用的信号 | `finish_reason: "tool_calls"` | `output` 中出现 `type: function_call` 的条目 | `stop_reason: "tool_use"` |
| 调用意图 | `message.tool_calls[]`，`arguments` 为 JSON 字符串 | `function_call` 条目，含 `call_id`、`name`、`arguments`（JSON 字符串） | `content` 中的 `tool_use` 块，含 `id`、`name`、`input`（JSON 对象） |
| 回传结果 | `role: "tool"` 消息，带 `tool_call_id` | `type: function_call_output` 输入条目，带 `call_id` | `role: "user"` 消息中的 `tool_result` 块，带 `tool_use_id`，出错时可设 `is_error` |

OpenAI 的新模型和新功能优先落在 Responses API 上，部分新模型只在 Responses API 上支持工具调用；Anthropic 的模型在调用工具前通常还会输出一段说明文字，代码不要假设 `content` 里只有 `tool_use` 块。

---

## 四、进阶机制

### 1、并行调用

一次响应里可以返回**多个**调用意图（如「对比北京和上海的天气」得到两个 `get_weather`）。应用可以并发执行，再把全部结果按各自的 ID 一起回传。不希望并行时，OpenAI 可设 `parallel_tool_calls: false`，每轮最多调用一个工具。

### 2、tool_choice：控制是否调用

| 语义 | OpenAI Chat Completions | OpenAI Responses API | Anthropic |
|------|------------------------|---------------------|-----------|
| 模型自行判断（默认） | `"auto"` | `"auto"` | `{"type": "auto"}` |
| 禁止调用，只生成文本 | `"none"` | `"none"` | `{"type": "none"}` |
| 必须调用，调哪个由模型选，可以调多个 | `"required"` | `"required"` | `{"type": "any"}` |
| 必须调用指定工具 | `{"type": "function", "function": {"name": "get_weather"}}` | `{"type": "function", "name": "get_weather"}` | `{"type": "tool", "name": "get_weather"}` |

注意两点：

- `required` / `any` 只保证「至少调用一个工具」，不指定是哪一个；要锁定某个工具必须用指定工具的写法
- 并不是所有模型都支持强制调用：Anthropic 文档注明部分最新模型以及手动开启扩展思考时，`any` 和 `tool` 会直接返回 400 错误，这时应改用 `auto` + strict 工具，或改用结构化输出

### 3、strict 模式：保证参数符合 Schema

开启 strict 后，模型生成的参数一定能通过工具的 JSON Schema 校验，从根源上减少「缺字段、类型错、枚举值不存在」这类参数幻觉。OpenAI 在函数定义上设 `"strict": true`（官方建议始终开启），Anthropic 在工具定义上设 `"strict": true`。strict 模式一般要求对象都写 `"additionalProperties": false`、所有字段都列入 `required`，可选字段用 `null` 类型表达。

Schema 合法不等于业务合法：订单号是否属于当前用户、金额是否超限，仍要在工具实现里校验。

### 4、与结构化输出的关系

早期常定义一个假工具只为拿到 JSON，现在各家都有专门的原生结构化输出（约束**最终回答**的格式），写法见 [Prompt 工程](./1_prompt)。两者分工：**要执行动作用 Function Calling，只要格式化数据用结构化输出**。

### 5、多轮循环：Agent 的雏形

把「第二轮」推广成循环，就是 ReAct 式 Agent 的骨架。下面是伪代码，`llm`、`execute` 代表模型客户端和工具分发逻辑：

```java
// 伪代码：手写工具循环
static final int MAX_ROUNDS = 8;

String run(List<Message> messages, List<ToolSpec> tools) {
    for (int round = 0; round < MAX_ROUNDS; round++) {
        LlmResponse resp = llm.chat(messages, tools);
        if (!resp.hasToolCalls()) {
            return resp.text();                         // 模型认为任务完成
        }
        messages.add(resp.assistantMessage());          // 调用意图原样带回
        for (ToolCall call : resp.toolCalls()) {
            String result = execute(call);              // 校验参数、鉴权、执行
            messages.add(Message.toolResult(call.id(), result));
        }
    }
    throw new IllegalStateException("工具调用超过 " + MAX_ROUNDS + " 轮，终止");
}
```

实际项目中这个循环由框架完成（见第五节），规划与记忆见 [AI Agent 智能体](../5_advanced/0_agent)。

---

## 五、框架中的 @Tool

### 1、Spring AI 2.0

```java
import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;

public record OrderStatus(String orderNo, String status, String logistics) {}

@Component
public class OrderTools {

    private final OrderService orderService;

    public OrderTools(OrderService orderService) {
        this.orderService = orderService;
    }

    @Tool(description = "按订单号查询订单状态和物流信息。用户询问订单进度、发货、物流时使用。只能查询当前登录用户自己的订单")
    public OrderStatus getOrderStatus(
            @ToolParam(description = "订单号，如 202610090001") String orderNo,
            ToolContext toolContext) {
        Long userId = (Long) toolContext.getContext().get("userId");   // 身份来自应用，不来自模型
        return orderService.findStatus(userId, orderNo);
    }
}

@Service
public class SupportAssistant {

    private final ChatClient chatClient;
    private final OrderTools orderTools;

    public SupportAssistant(ChatClient.Builder builder, OrderTools orderTools) {
        this.chatClient = builder.build();
        this.orderTools = orderTools;
    }

    public String chat(Long userId, String question) {
        return chatClient.prompt()
            .user(question)
            .tools(orderTools)
            .toolContext(Map.of("userId", userId))
            .call()
            .content();
    }
}
```

- `@Tool` 的 `name` 默认取方法名，`description` 就是给模型看的 Prompt；`@ToolParam` 的参数默认必填，可设 `required = false`
- `ToolContext` 里的数据只传给工具，不会发给模型，适合放用户 ID、租户 ID 等身份信息
- 工具循环由框架自动完成；2.0 默认对每轮的工具调用次数设了上限，可通过 `spring.ai.tools.limits.max-calls-per-tool-default`、`spring.ai.tools.limits.max-total-tool-calls` 调整
- 需要在执行前插入审批步骤时，可以关闭自动循环，用 `ToolCallingManager` 自己驱动每一轮，详见 [Spring AI](../2_frameworks/0_spring_ai)

### 2、LangChain4j 1.x

```java
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.service.AiServices;

public class WeatherTools {

    @Tool("查询指定城市的当前天气。用户询问天气、气温、是否下雨时使用")
    public String getWeather(@P("城市名，如：北京") String city) {
        return weatherClient.current(city);
    }
}

interface Assistant {
    String chat(String message);
}

Assistant assistant = AiServices.builder(Assistant.class)
    .chatModel(chatModel)
    .tools(new WeatherTools())
    .maxToolCallingRoundTrips(8)     // 限制工具循环轮数
    .build();
```

工具方法抛出的异常信息默认会作为工具结果交给模型，让它自行修正参数或换一种方式；`@Tool` 的 `returnBehavior` 可以让工具结果直接返回给调用方而不再经过模型。AI Service 的其他用法见 [LangChain4j](../2_frameworks/1_langchain4j)。

---

## 六、工具安全

模型的调用意图可能被提示注入操纵，工具设计要假设「模型会被说服去调用任何它能调用的工具」：

| 原则 | 做法 |
|------|------|
| 最小权限 | 只挂当前任务需要的工具；能只读就只读；工具以当前用户的身份和权限执行，不用全能服务账号 |
| 身份不由模型决定 | 用户 ID、租户 ID 从会话中取（Spring AI 的 `ToolContext`），不作为工具参数让模型填写，否则模型可以替别人查数据 |
| 副作用人工确认 | 发送、支付、删除、对外写入等工具，只生成「待确认操作」，用户在界面确认后再执行 |
| 工具输出不可信 | 网页、邮件、文档、第三方接口、MCP Server 的返回值都可能夹带指令，属于间接提示注入的入口；回传前截断、清洗，并在 Prompt 中标明它只是数据 |
| 超时、幂等与审计 | 工具按对外接口的标准实现超时与幂等，每次调用记录调用者、参数和结果摘要 |

提示注入的完整防护思路见 [Prompt 工程](./1_prompt)，权限模型见 [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)。

---

## 七、工程实践与常见坑

| 坑 | 说明 | 应对 |
|----|------|------|
| **描述写得随意** | 工具名、描述、参数描述都是给模型看的 Prompt，直接决定命中率和参数准确度 | 像写 API 文档一样写：做什么、什么时候用、什么时候不用、参数格式给示例 |
| **参数幻觉** | 模型编造不存在的枚举值、格式错误的日期 | 开启 strict 模式；解析后做业务校验，非法时把错误信息作为工具结果回传，让模型修正 |
| **循环失控** | Agent 循环里模型反复调同一个工具 | 设最大轮数和单工具调用次数上限，检测重复调用 |
| **工具太多** | 几十个工具全挂上，命中率下降、输入 Token 暴涨 | 按意图分组、动态检索候选工具，合并相近的工具；这也是 [MCP 协议](../5_advanced/1_mcp) 和 Agent 框架要解决的问题 |
| **结果太大** | 工具返回整页 JSON，挤占上下文 | 只返回模型做下一步决策需要的字段，大结果分页或摘要 |
| **强制调用报错** | 对不支持的模型使用 `required` / `any` / 指定工具 | 查模型文档，必要时改用 `auto` + strict 或结构化输出 |

---

## 八、在技术版图中的位置

![Function Calling 在技术版图中的位置](../../assets/ai/fc-landscape.svg)

- **框架**（Spring AI / LangChain4j）：把「生成 JSON Schema、解析调用意图、回传结果、循环」封装成注解和自动循环，开发者只写方法
- **Agent**：解决「何时调、按什么顺序调」，在协议之上加规划、记忆与循环
- **MCP**：解决「工具从哪来」，把工具做成跨应用共享的标准服务端，模型侧仍然走 Function Calling

---

## 小结

- 模型只输出调用意图，执行、鉴权、校验、审计都在应用代码里
- 一次工具调用是两轮请求：带工具定义请求 → 模型返回调用意图 → 执行后回传结果 → 模型生成回答；调用意图和结果靠 ID 配对
- OpenAI Chat Completions、Responses API 与 Anthropic 的字段不同，Anthropic 的参数是 JSON 对象、结果放在 user 消息的 `tool_result` 块里
- `tool_choice` 的 `required` / `any` 只保证至少调一个工具，锁定工具要用指定写法，且部分模型不支持强制调用；strict 模式保证参数符合 Schema
- Spring AI 用 `@Tool` + `@ToolParam` + `ToolContext`，LangChain4j 用 `@Tool` + `@P` + `AiServices`，两者都要限制循环轮数
- 工具设计按最小权限、身份不由模型决定、副作用人工确认、工具输出不可信四条原则

本篇是 Function Calling 的主文档，[Spring AI](../2_frameworks/0_spring_ai)、[LangChain4j](../2_frameworks/1_langchain4j)、[AI Agent 智能体](../5_advanced/0_agent)、[MCP 协议](../5_advanced/1_mcp) 中涉及工具调用协议的部分都以本篇为准。

## 参考资料

- OpenAI Function Calling：[https://developers.openai.com/api/docs/guides/function-calling](https://developers.openai.com/api/docs/guides/function-calling)
- Anthropic Tool Use：[https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- Anthropic Define Tools（tool_choice）：[https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- Spring AI Tool Calling：[https://docs.spring.io/spring-ai/reference/api/tools.html](https://docs.spring.io/spring-ai/reference/api/tools.html)
- LangChain4j Tools：[https://docs.langchain4j.dev/tutorials/tools](https://docs.langchain4j.dev/tutorials/tools)
- OWASP LLM01 Prompt Injection：[https://genai.owasp.org/llmrisk/llm01-prompt-injection/](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)

> 下一篇：[Spring AI](../2_frameworks/0_spring_ai)

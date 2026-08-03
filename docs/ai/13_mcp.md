# MCP 协议

> 参考资料：
> * MCP 官方文档（中文）：[https://mcp-docs.cn/introduction](https://mcp-docs.cn/introduction)
> * MCP 官网：[https://modelcontextprotocol.io/](https://modelcontextprotocol.io/)
> * Spring AI MCP：[https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html)

---

## 一、是什么

MCP（Model Context Protocol）是 Anthropic 于 2024 年底推出的**开放协议**，目标是标准化 LLM 应用与外部工具、数据源之间的连接方式。

**类比**：MCP 之于 AI 工具，就像 USB-C 之于外设——统一接口，即插即用，无需为每个组合单独适配。

### 解决的问题

在 MCP 出现之前，每个 AI 应用（Claude、Cursor、Copilot 等）都需要针对每种数据源（数据库、GitHub、Slack、文件系统等）单独开发集成代码，导致：

- **重复开发**：同一个"查 GitHub Issues"功能，每个 AI 工具都要各自实现一遍
- **维护成本高**：数据源 API 变更时，所有 AI 工具都要同步更新
- **生态碎片化**：工具能力无法在不同 AI 应用之间复用

MCP 通过标准化协议，让任意 MCP Server 可以被任意 MCP 兼容的 AI 应用直接使用。

---

## 二、架构模型

MCP 定义了三个核心角色：

| 角色 | 说明 | 典型示例 |
|------|------|----------|
| **MCP Host** | 运行 LLM 的宿主应用，发起 MCP 连接 | Claude Desktop、Cursor、VS Code Copilot |
| **MCP Client** | Host 内部负责管理与 MCP Server 连接的组件 | 维护连接、发送请求、接收响应 |
| **MCP Server** | 对外暴露工具、资源、提示模板的轻量级服务 | 文件系统 Server、GitHub Server、数据库 Server |

**调用链路：**

![MCP 调用链路](../assets/ai/mcp-arch.svg)

MCP Server 可以运行在本地（stdio 传输）或远程（HTTP/SSE 传输），Host 和 Server 通过标准化的 JSON-RPC 2.0 协议通信。

---

## 三、核心概念对比

| 能力 | 用途 | 示例 |
|------|------|------|
| **Tools（工具调用）** | LLM 主动调用，执行有副作用的操作 | 创建 GitHub Issue、发送 Slack 消息、执行 SQL |
| **Resources（资源读取）** | 向 LLM 提供只读的上下文数据，类似文件读取 | 读取项目文件内容、获取数据库 schema、读取配置 |
| **Prompts（提示模板）** | 预定义的提示模板，用户可通过斜杠命令触发 | `/code-review` 触发代码审查模板、`/summarize` 触发摘要模板 |

---

## 四、MCP vs 传统 Function Calling

| 维度 | 传统 Function Calling | MCP |
|------|----------------------|-----|
| **标准化程度** | 各家 API 格式不同（OpenAI/Claude/Gemini 各异） | 统一协议，所有 MCP 兼容应用通用 |
| **跨应用复用** | 不可复用，各应用各自实现 | 一个 MCP Server 可被所有兼容 Host 使用 |
| **服务端部署** | 工具逻辑通常内嵌在客户端代码中 | Server 独立部署，可远程访问 |
| **动态发现** | 工具列表需要硬编码在请求中 | Client 可动态查询 Server 暴露的工具列表 |
| **生态** | 依赖 LLM 厂商自有生态 | 开放生态，社区贡献的 Server 可直接复用 |

---

## 五、Spring AI MCP Client 实战

### 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-mcp-client-spring-boot-starter</artifactId>
</dependency>
```

### 配置连接到本地 MCP Server

```yaml
spring:
  ai:
    mcp:
      client:
        enabled: true
        servers:
          # 连接本地文件系统 MCP Server（stdio 传输）
          filesystem:
            transport: stdio
            command: npx
            args:
              - "-y"
              - "@modelcontextprotocol/server-filesystem"
              - "/Users/yourname/projects"
          # 连接远程 MCP Server（SSE 传输）
          remote-server:
            transport: sse
            url: http://localhost:8081/mcp/sse
```

### 调用 MCP 工具

```java
@Service
@RequiredArgsConstructor
public class McpAgentService {

    private final ChatClient.Builder chatClientBuilder;
    // Spring AI 自动注入所有已配置 MCP Server 的 ToolCallbackProvider
    private final ToolCallbackProvider mcpToolCallbacks;

    public String chat(String userMessage) {
        ChatClient chatClient = chatClientBuilder
                .defaultTools(mcpToolCallbacks.getToolCallbacks()) // 注册所有 MCP 工具
                .build();

        return chatClient.prompt()
                .user(userMessage)
                .call()
                .content();
    }
}
```

### 查询可用工具列表

```java
@RestController
@RequiredArgsConstructor
public class McpInfoController {

    private final McpSyncClientCustomizer mcpClientCustomizer;
    private final ToolCallbackProvider mcpToolCallbacks;

    @GetMapping("/mcp/tools")
    public List<String> listTools() {
        // 返回所有 MCP Server 暴露的工具名称
        return Arrays.stream(mcpToolCallbacks.getToolCallbacks())
                .map(tool -> tool.getToolDefinition().name())
                .toList();
    }
}
```

---

## 六、Java 编写 MCP Server

### 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-mcp-server-spring-boot-starter</artifactId>
</dependency>
```

### 配置

```yaml
spring:
  ai:
    mcp:
      server:
        name: my-java-mcp-server
        version: 1.0.0
        # stdio：标准输入输出（本地进程调用，适合 Claude Desktop）
        # sse：HTTP SSE（远程调用，适合网络部署）
        transport: stdio
```

### 暴露工具

```java
@Component
public class DatabaseTools {

    @Tool(description = "根据用户ID查询用户信息，返回姓名、邮箱等基本信息")
    public String getUserById(@ToolParam(description = "用户ID") String userId) {
        // 实际查询数据库
        return String.format("{\"id\":\"%s\",\"name\":\"张三\",\"email\":\"zhangsan@example.com\"}", userId);
    }

    @Tool(description = "查询指定日期范围内的订单列表")
    public String getOrders(
            @ToolParam(description = "开始日期，格式 yyyy-MM-dd") String startDate,
            @ToolParam(description = "结束日期，格式 yyyy-MM-dd") String endDate) {
        // 实际查询订单
        return "[{\"orderId\":\"1001\",\"amount\":299.00,\"status\":\"已完成\"}]";
    }
}
```

### 启动类

```java
@SpringBootApplication
public class MyMcpServerApplication {

    public static void main(String[] args) {
        // stdio 传输时使用 SpringApplication.run 即可
        // MCP Server 会自动监听 stdin/stdout
        SpringApplication app = new SpringApplication(MyMcpServerApplication.class);
        // stdio 模式关闭 banner 避免干扰 MCP 通信
        app.setBannerMode(Banner.Mode.OFF);
        app.run(args);
    }

    // 将 @Tool 方法所在的 Bean 注册为 MCP 工具源
    @Bean
    public ToolCallbackProvider mcpTools(DatabaseTools databaseTools) {
        return MethodToolCallbackProvider.builder()
                .toolObjects(databaseTools)
                .build();
    }
}
```

### SSE 模式配置（远程部署）

```yaml
spring:
  ai:
    mcp:
      server:
        transport: sse
  # SSE 模式需要 Web 服务器
  mvc:
    async:
      request-timeout: -1  # SSE 长连接不超时
server:
  port: 8081
```

---

## 七、常见 MCP Server 推荐

| MCP Server | 安装方式 | 主要用途 |
|------------|----------|----------|
| **文件系统** | `@modelcontextprotocol/server-filesystem` | 读写本地文件和目录 |
| **GitHub** | `@modelcontextprotocol/server-github` | 管理 Issues、PR、代码搜索 |
| **PostgreSQL** | `@modelcontextprotocol/server-postgres` | 查询 PostgreSQL 数据库 |
| **SQLite** | `@modelcontextprotocol/server-sqlite` | 读写 SQLite 数据库 |
| **Slack** | `@modelcontextprotocol/server-slack` | 发送消息、查询频道历史 |
| **Google Maps** | `@modelcontextprotocol/server-google-maps` | 地点搜索、路线规划 |
| **Brave Search** | `@modelcontextprotocol/server-brave-search` | 网页搜索（需要 API Key） |
| **Puppeteer** | `@modelcontextprotocol/server-puppeteer` | 浏览器自动化、截图、爬取 |
| **Memory** | `@modelcontextprotocol/server-memory` | 跨会话持久化知识图谱 |
| **自定义 Java Server** | Spring AI MCP Server Starter | 接入企业内部系统、数据库、微服务 |

> 完整社区 Server 列表参考：[https://github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

# AI 总览

AI 模块从 Java 后端视角讲大模型应用开发：选模型、写 Prompt、工具调用，用 Spring AI / LangChain4j 接入模型，用 RAG 接入私有知识，用 Agent、MCP 编排工具。

**版本基线（2026 年 10 月）**：JDK 21、Spring Boot 4、Spring AI 2.0、LangChain4j 1.22、MCP 规范 2026-07-28

---

## 一、模块导航

<ModuleNav />

---

## 二、各部分一句话

| 部分 | 一句话 | 入口 |
|------|--------|------|
| 基础概念 | 模型选型与成本估算、Prompt 写法与结构化输出、Function Calling 协议 | [大模型选型](./1_concepts/0_model) |
| Java 框架 | Spring AI 与 Spring Boot 深度集成；LangChain4j 以 AiServices 声明式接口见长 | [Spring AI](./2_frameworks/0_spring_ai) / [LangChain4j](./2_frameworks/1_langchain4j) |
| 模型接入 | 本地用 Ollama 跑开源模型，线上直连各家 API | [Ollama](./3_integration/0_ollama) / [API 直接接入](./3_integration/1_api_access) |
| 核心技术 | Embedding 把文本变成向量，向量库做近似检索，RAG 先检索再生成 | [RAG 检索增强生成](./4_core_tech/2_rag) |
| 高阶应用 | Agent 在工具调用之上加规划与循环；MCP 把工具做成跨应用共享的标准服务；微调用领域数据改造模型 | [AI Agent 智能体](./5_advanced/0_agent) / [MCP 协议](./5_advanced/1_mcp) |
| AI 工具生态 | AI 编程工具的选型维度、项目规则文件与团队使用规范 | [AI 编程工具怎么选](./6_tools/0_ai_tools) |

MCP（Model Context Protocol）由 Anthropic 于 2024 年发起，2025 年 12 月捐赠给 Linux 基金会旗下的 Agentic AI Foundation（AAIF），现由该基金会中立治理；它是协议而不是安全保障，远程 MCP Server 的授权（HTTP 传输按规范走 OAuth）、工具权限与工具输出带来的间接提示注入都要应用自己把关，详见 [MCP 协议](./5_advanced/1_mcp)。

---

## 三、推荐阅读路径

1. 先读基础概念：[大模型选型](./1_concepts/0_model) → [Prompt 工程](./1_concepts/1_prompt) → [Function Calling（工具调用）](./1_concepts/2_function_calling)，后面所有框架和 Agent 都建立在这三篇之上
2. 选一个框架上手：Spring 技术栈优先 [Spring AI](./2_frameworks/0_spring_ai)，需要声明式 AI 服务或非 Spring 项目看 [LangChain4j](./2_frameworks/1_langchain4j)
3. 模型接入：开发环境用 [Ollama](./3_integration/0_ollama) 本地跑，生产对接云端见 [API 直接接入](./3_integration/1_api_access)
4. 私有知识问答：[Embedding 向量化](./4_core_tech/0_embedding) → [向量数据库](./4_core_tech/1_vector_db) → [RAG 检索增强生成](./4_core_tech/2_rag)
5. 复杂任务编排：[AI Agent 智能体](./5_advanced/0_agent) → [MCP 协议](./5_advanced/1_mcp)；Prompt 和 RAG 都解决不了时再考虑 [模型微调](./5_advanced/2_fine_tuning)
6. 最后浏览 [AI 编程工具怎么选](./6_tools/0_ai_tools)，了解日常开发可用的 AI 工具

复习时用 [高频面试题](./99_interview) 自测，答案在 [AI 面试题解答](/interview/25_ai)。

---

## 四、关联模块

模型训练和算法原理不在本模块范围内，只讲「把模型当作外部服务，如何稳定、安全、可控地用好它」。Spring Boot 3 项目对应 Spring AI 1.1.x，API 大体相同，差异在正文单独标出；LangChain4j 通过 `langchain4j-bom` 统一版本。模型型号、价格、上下文长度变化很快，正文只写模型家族和选型方法，具体数值以各厂商官方模型页为准。

- 认证授权、API 安全、权限模型（工具最小权限、MCP 的 OAuth 授权） → [应用安全总览](/security/0_overview)
- 关键词与向量混合检索（Elasticsearch / OpenSearch） → [搜索数据库](/database/4_nosql/3_search_db)
- 大模型流式输出的传输层（SSE） → [SSE（Server-Sent Events）](/netty/11_sse)
- 调用链路、Token 用量与延迟监控 → [可观测性总览](/observability/0_overview)
- 限流、超时、重试、降级等调用外部服务的通用治理 → [高可用总览](/high-avail/0_overview)
- Spring Boot 自动配置与 Starter 机制 → [Spring Boot 总览](/spring-boot/0_overview)
- 本模块高频问题的答案汇总 → [AI 面试题解答](/interview/25_ai)

---

## 参考资料

- Spring AI Reference：[https://docs.spring.io/spring-ai/reference/](https://docs.spring.io/spring-ai/reference/)
- Spring AI Releases：[https://github.com/spring-projects/spring-ai/releases](https://github.com/spring-projects/spring-ai/releases)
- LangChain4j 文档：[https://docs.langchain4j.dev/](https://docs.langchain4j.dev/)
- LangChain4j Releases：[https://github.com/langchain4j/langchain4j/releases](https://github.com/langchain4j/langchain4j/releases)
- Model Context Protocol：[https://modelcontextprotocol.io/](https://modelcontextprotocol.io/)
- MCP 版本说明：[https://modelcontextprotocol.io/specification/versioning](https://modelcontextprotocol.io/specification/versioning)
- Anthropic - Donating the Model Context Protocol and establishing the Agentic AI Foundation：[https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)
- Andrej Karpathy - Intro to Large Language Models：[https://www.youtube.com/watch?v=zjkBMFhNj_g](https://www.youtube.com/watch?v=zjkBMFhNj_g)

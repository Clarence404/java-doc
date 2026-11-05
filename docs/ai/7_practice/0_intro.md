---
description: 智能客服章节路线、start 与 done 标签、三层测试、本地运行、与 mall-evolution 的关系
---

# AI 应用实战概览

> 前置阅读：[Spring AI](../2_frameworks/0_spring_ai)、[Ollama](../3_integration/0_ollama)

前面各篇讲原理，本系列用配套仓库 mall-assistant 给示例商城做一个智能客服，一章加一项能力，自己动手写出来。本篇讲章节路线、练习方式、测试分层与本地运行，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、做什么

做一个「示例商城」的在线客服「小示」：用户在网页上提问，后端调大模型回答；后面几章逐步让它会查订单、会读商城规则、记得上下文、能走完售后流程，最后评估上线。

| 设定 | 取值 |
|------|------|
| 仓库 | [`mall-assistant`](https://github.com/Clarence404/mall-assistant)，单模块 Maven 工程，包名 `io.github.clarence404.assistant` |
| 版本 | JDK 21、Spring Boot 4.0、Spring AI 2.0（2.0.2）、Testcontainers 2 |
| 默认模型 | 本机 Ollama + `qwen2.5:0.5b`（约 400 MB，CPU 也跑得动）；换成任意 OpenAI 兼容接口只改 profile |
| 页面 | `static/index.html`，原生 HTML / JS，已写好，各章只写后端 |
| 端口 | 8088 |
| 要调用的业务系统 | [项目演进](/project/0_overview) 系列的 `mall-evolution`，第 3 章起通过它的网关查订单、查库存 |

选 0.5b 的小模型是为了让每个人在笔记本上就能跑通、CI 上几分钟内跑完集成测试；它的回答质量不高，正好用来体会 Prompt、结构化输出和评估为什么必要。

---

## 二、练习方式：start 与 done 标签

每章在仓库里有两个标签：

| 标签 | 内容 | `./mvnw verify` |
|------|------|-----------------|
| `chNN-start` | 上一章的参考答案 + 本章骨架：要写的地方留了 `TODO chNN`，验收测试已经写好 | 本章的验收测试失败（预期） |
| `chNN-done` | 本章参考答案 | 全部通过 |

```bash
git clone https://github.com/Clarence404/mall-assistant.git
cd mall-assistant
git switch -c my-ch01 ch01-start     # 从起点拉自己的分支
# 按 docs/ch01.md 补全 TODO，直到 ./mvnw verify 通过
git diff ch01-done -- src/main       # 卡住了再对照参考答案
```

这样设计有三个考虑：

- **测试就是验收标准**：骨架加上先失败的测试，「做完」的定义很明确，变绿就算过，不用自己判断写得对不对
- **只写本章的东西**：配置、页面、请求响应 record、错误码枚举都已给好，注意力集中在本章要练的几个点上
- **卡住有台阶**：每章的 `docs/chNN.md` 给出目标、背景阅读、分级提示（思路 → 关键 API → 参考答案）和本地运行步骤，建议卡住超过 15 分钟再看下一级提示

每次推送标签，GitHub Actions 都会跑完整构建（含真实 Ollama 的集成测试）并发布 [测试报告](https://clarence404.github.io/mall-assistant/)，`chNN-start` 的报告里测试失败是预期的。

---

## 三、章节路线

| 章节 | 做什么 | 对应原理文章 |
|------|--------|-------------|
| 1 [接入模型与流式对话](./1_model_streaming) | ChatClient + 系统提示词，阻塞与 SSE 流式接口，超时与友好报错，按 profile 切换模型厂商 | [Spring AI](../2_frameworks/0_spring_ai)、[Ollama](../3_integration/0_ollama) |
| 2 Prompt 与结构化输出 | 提示词模板、意图识别、模型输出直接转成 Java 对象 | [Prompt 工程](../1_concepts/1_prompt) |
| 3 工具调用 | 调 mall-evolution 的接口查订单、查库存 | [Function Calling（工具调用）](../1_concepts/2_function_calling) |
| 4 知识入库 | 商城规则文档切块、向量化、存入 pgvector | [Embedding 向量化](../4_core_tech/0_embedding)、[向量数据库](../4_core_tech/1_vector_db) |
| 5 RAG | 检索增强回答、引用来源 | [RAG 检索增强生成](../4_core_tech/2_rag) |
| 6 多轮对话与记忆 | 会话 ID、ChatMemory、上下文裁剪 | [Spring AI · 对话记忆](../2_frameworks/0_spring_ai#_2、对话记忆) |
| 7 Agent | 售后退款流程，关键操作人工确认 | [AI Agent 智能体](../5_advanced/0_agent) |
| 8 MCP | 把商城能力暴露成 MCP Server | [MCP 协议](../5_advanced/1_mcp) |
| 9 评估与上线 | 回归评测集、Token 用量、限流与监控 | [LLM 应用评估与上线](../5_advanced/3_llm_eval) |

目前已完成第 1 章，其余章节按顺序陆续发布；原理文章讲「是什么、为什么」，本系列只讲在这个项目里怎么落地、踩了哪些坑。

---

## 四、LLM 应用的测试分层

模型的输出不确定、调用又慢又可能收费，直接拿真实模型跑全部测试既不稳定也跑不快。本系列按下面三层组织测试，越往下越真实、越慢、越少：

| 层 | 做法 | 验证什么 | 在本仓库 |
|----|------|---------|---------|
| 假模型单元测试 | 自己实现一个 `ChatModel`（`FakeChatModel`），按预设返回回答、片段或异常，并记下收到的 Prompt | 自己写的代码：提示词有没有带上、错误怎么归类、SSE 事件顺序，结果完全确定，毫秒级 | 第 1 章起，`*Test` |
| 录制回放 | 用真实模型跑一次，把请求与响应录下来存成文件，之后回放 | 依赖模型输出格式的逻辑（如结构化输出、工具调用参数解析），不用每次调模型 | 从结构化输出、工具调用的章节开始引入 |
| 真模型集成测试 | Testcontainers 起真实 Ollama、拉小模型，走一遍 HTTP 接口 | 配置、序列化、流式链路真的能通；只断言「有中文回答」「以 done 结束」这类稳定事实 | 第 1 章起，`*IT`，没有 Docker 时自动跳过 |

三层都只回答「代码对不对」，回答**好不好**要靠评估集：一批带标准答案或评分规则的问题，每次改 Prompt、换模型都跑一遍并和基线比较，第 9 章接入。评估方法本身见 [LLM 应用评估与上线](../5_advanced/3_llm_eval)，Testcontainers 的用法见 [Testcontainers](/testing/5_testcontainers)。

---

## 五、本地运行

需要 JDK 21 和一个模型服务，默认用本机 Ollama，不需要 Docker（只有集成测试要 Docker）：

1. 安装 Ollama：Windows 下载 `OllamaSetup.exe` 直接安装，装好后在后台监听 `http://localhost:11434`
2. 拉取模型：`ollama pull qwen2.5:0.5b`，可以先用 `ollama run qwen2.5:0.5b "你好"` 试一句
3. 启动：`./mvnw spring-boot:run`（Windows PowerShell 用 `.\mvnw.cmd spring-boot:run`），默认 profile 是 `ollama`
4. 打开 `http://localhost:8088/` 提问，右上角可切换流式 / 阻塞，底部调试面板显示耗时与错误码

**不在本机跑模型**时，把仓库根目录的 `application-local.example.yml` 复制为 `application-local.yml`（已被 `.gitignore` 忽略），填上远程 Ollama 的地址，或取消注释 `openai` 一段填 base-url、api-key、模型名，再以 `ollama,local`（或 `openai,local`）profile 启动。地址和密钥只放在这个本地文件里，不写进 `src/main/resources`。

**用 IntelliJ IDEA** 时，仓库的 `.run/` 带了三个共享运行配置：「智能客服（本地 Ollama）」「智能客服（OpenAI 兼容接口）」都已带上 `local` profile，「测试：mvn verify」等同命令行的 `./mvnw verify`。这些配置文件是入库的，不要在里面填密钥。

换模型只需设置环境变量 `OLLAMA_CHAT_MODEL`（如 `qwen3:0.6b`），先 `ollama pull` 好。

---

## 六、与 mall-evolution 的关系

[项目演进](/project/0_overview) 系列的 `mall-evolution` 是智能客服要服务的业务系统：订单、商品、库存都在那边。两个仓库各自独立，互不依赖代码：

- 第 1、2 章只和模型打交道，不需要启动 mall-evolution
- 第 3 章起，智能客服把「查订单」「查库存」做成工具，通过 HTTP 调用 mall-evolution 的网关（端口 9000），和普通前端一样走对外接口，不直连它的数据库
- 智能客服用 8088 端口，避开 mall-evolution 的 `mall-app`（8080）等服务，两个项目可以在同一台机器上同时运行

---

## 小结

- 本系列在 mall-assistant 仓库里一章一章做出示例商城的智能客服，技术栈为 JDK 21、Spring Boot 4、Spring AI 2，默认用本机 Ollama 的 `qwen2.5:0.5b`
- 每章有 `chNN-start`（骨架 + 先失败的测试）与 `chNN-done`（参考答案）两个标签，测试变绿即完成，`docs/chNN.md` 提供分级提示
- 9 章依次覆盖接入与流式、Prompt 与结构化输出、工具调用、知识入库、RAG、记忆、Agent、MCP、评估上线，每章对应一篇原理文章
- 测试分三层：假模型单元测试保证代码逻辑，录制回放覆盖依赖输出格式的逻辑，Testcontainers 真模型集成测试确认链路能通；回答质量交给评估集
- 第 3 章起通过 mall-evolution 的网关（9000）调用业务接口，智能客服自身用 8088 端口

## 参考资料

- mall-assistant 仓库：[https://github.com/Clarence404/mall-assistant](https://github.com/Clarence404/mall-assistant)
- mall-assistant 测试报告：[https://clarence404.github.io/mall-assistant/](https://clarence404.github.io/mall-assistant/)
- Spring AI Reference：[https://docs.spring.io/spring-ai/reference/](https://docs.spring.io/spring-ai/reference/)
- Ollama 下载：[https://ollama.com/download](https://ollama.com/download)
- Testcontainers Ollama Module：[https://java.testcontainers.org/modules/ollama/](https://java.testcontainers.org/modules/ollama/)

> 下一篇：[接入模型与流式对话](./1_model_streaming)

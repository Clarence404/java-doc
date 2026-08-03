# AI 开发总览

> 参考资料：
> * Andrej Karpathy - The spelled-out intro to LLMs：[https://www.youtube.com/watch?v=zjkBMFhNj_g](https://www.youtube.com/watch?v=zjkBMFhNj_g)
> * AWS - What is Generative AI：[https://aws.amazon.com/what-is/generative-ai/](https://aws.amazon.com/what-is/generative-ai/)

---

## 一、核心概念

### 1.1 LLM（大语言模型）

Large Language Model，基于海量文本数据训练的神经网络模型，通过预测下一个 Token 来生成文本。

核心特征：
- **预训练**：在大规模语料上学习语言规律
- **涌现能力**：规模足够大时，自发出现推理、代码生成等能力
- **上下文窗口**：模型单次处理的最大 Token 数，影响长文档处理能力

### 1.2 Token

模型处理文本的基本单位，不等同于字符或单词。中文一个汉字约 1.5 个 Token，英文一个单词约 1-2 个 Token。Token 数量直接影响 API 调用费用。

### 1.3 Prompt

输入给模型的文本指令，分为：
- **System Prompt**：定义模型角色与行为约束
- **User Prompt**：用户的实际问题或任务
- **Assistant**：模型历史回复，用于多轮对话

---

## 二、Java 开发框架

> 官网入口汇总：
> * **Spring AI**：[https://docs.spring.io/spring-ai/](https://docs.spring.io/spring-ai/)
> * **LangChain4j**：[https://github.com/langchain4j/langchain4j](https://github.com/langchain4j/langchain4j)
> * **Jlama**：[https://github.com/tjake/Jlama](https://github.com/tjake/Jlama)

| 框架 | 定位 | 适用场景 |
|------|------|---------|
| Spring AI | Spring 官方出品，与 Spring Boot 深度集成 | 企业级 Java AI 应用 |
| LangChain4j | LangChain 的 Java 移植，功能丰富 | 复杂 AI 工作流、Agent |
| Jlama | 轻量级本地推理 | 边缘部署、小型项目 |

### 2.1 Spring AI

Spring 官方推出的 AI 集成框架，支持多种 LLM 接入与 Prompt 管理。适用于与 Spring Boot 紧密集成的企业级开发场景。

### 2.2 LangChain4j

LangChain 的 Java 实现，支持链式调用、工具接入、RAG 模式等，适用于构建复杂的 AI 工作流。

### 2.3 Jlama

一个轻量级 Java LLM 接入库，关注本地部署与快速集成，适合小型项目或边缘部署场景。

---

## 三、核心技术栈

### 3.1 RAG（检索增强生成）

全称：Retrieval-Augmented Generation

结合知识库与大模型，先检索、后生成，提升大模型回答的准确性与上下文相关性。

> 详见：[RAG](./4_core_tech/2_rag.md)

### 3.2 Fine-tuning（微调）

在基础模型之上，利用领域数据做再训练，使模型更好适配特定业务场景或风格要求。

> 详见：[模型微调](./5_advanced/2_fine_tuning.md)

### 3.3 Embedding（向量化）

将文本转换为高维向量，用于语义相似度计算，是 RAG 的核心组件。

> 详见：[Embedding](./4_core_tech/0_embedding.md)

### 3.4 AI Agent（智能体）

具备自主规划与工具调用能力的 AI 系统，可以拆解任务、调用外部工具、循环执行直至完成目标。

> 详见：[AI Agent](./5_advanced/0_agent.md)

---

## 四、MCP 协议简介

> 官网：[https://mcp-docs.cn/introduction](https://mcp-docs.cn/introduction)

MCP（Model Context Protocol）是 Anthropic 推出的开放协议，用于标准化 LLM 与外部数据、工具集成的接口方式。

可以将 MCP 理解为 AI 系统中的 **USB-C 接口**，让模型与各种外部资源的连接更统一、更易扩展。

- ✅ 标准化工具调用接口，降低接入成本
- ✅ 兼容多种 LLM 提供商
- ✅ 支持本地部署，数据安全可控

> 详见：[MCP 协议](./5_advanced/1_mcp.md)

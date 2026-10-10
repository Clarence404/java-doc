---
description: 本地部署与 Docker、原生 / OpenAI 兼容 API、结构化输出与工具调用、Java 接入、调优、安全
---

# Ollama

> **本篇目标**：用 Ollama 在本机或内网跑开源模型，掌握原生 `/api/chat` 与 OpenAI 兼容接口、结构化输出、工具调用和思考模式，能在 Spring AI / LangChain4j 中接入，知道并发、上下文长度、内存怎么调，以及对外暴露时的安全问题。
>
> **前置阅读**：[大模型选型](../1_concepts/0_model)、[Spring AI](../2_frameworks/0_spring_ai)

Ollama 是基于 llama.cpp 的本地模型运行工具：一条命令拉取量化模型，内置 HTTP 服务，同时提供原生 API 和 OpenAI 兼容 API。它适合开发联调、离线环境、数据不出内网的小规模场景；高并发的生产推理通常交给专门的推理服务（见二、4）。

---

## 一、是什么

- **跨平台**：macOS、Linux、Windows 均可运行；Apple Silicon 通过 Metal 加速，NVIDIA / AMD 显卡自动使用 GPU，没有 GPU 时用 CPU 推理（速度明显变慢）
- **模型管理**：官方模型库提供大量开源模型的量化版本，`ollama pull` 下载、`ollama run` 运行，也可以用 Modelfile 自定义参数
- **HTTP 服务**：默认监听 `127.0.0.1:11434`，原生 API 支持流式、工具调用、结构化输出、思考模式、向量化
- **本地与云端**：Ollama 现在也提供云端模型和网络搜索等云功能。只使用本地模型时数据才不会离开本机；需要严格离线时设置 `OLLAMA_NO_CLOUD=1`，或在 `~/.ollama/server.json` 中加 `"disable_ollama_cloud": true`

---

## 二、安装与部署

### 1、本机安装

```bash
# Linux：官方安装脚本，会注册为 systemd 服务
curl -fsSL https://ollama.com/install.sh | sh
```

macOS 和 Windows 从 [https://ollama.com/download](https://ollama.com/download) 下载安装包；Windows 安装包 `OllamaSetup.exe` 默认装在用户目录，不需要管理员权限，需要作为服务运行时可以用官方提供的独立 zip 包。

### 2、Docker

```bash
# 仅 CPU
docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama

# NVIDIA GPU（需先安装 NVIDIA Container Toolkit）
docker run -d --gpus=all -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama

# AMD GPU（ROCm）
docker run -d --device /dev/kfd --device /dev/dri -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama:rocm
```

模型文件很大，务必挂载数据卷；`-p 11434:11434` 会把端口暴露到宿主机所有网卡，只在本机使用时改成 `-p 127.0.0.1:11434:11434`。容器基础知识见 [Docker](/cloud-native/5_docker)。

### 3、常用命令

```bash
ollama pull qwen3              # 拉取模型，不写标签默认取 latest
ollama run qwen3               # 交互式对话（没有会先拉取）
ollama list                    # 本地已下载的模型
ollama ps                      # 当前加载在内存 / 显存中的模型
ollama show qwen3              # 查看参数、模板、能力（tools / thinking / vision）
ollama stop qwen3              # 从内存卸载
ollama rm qwen3                # 删除模型文件
ollama serve                   # 前台启动服务（安装为服务时不需要）
```

### 4、Ollama 在生产中的位置

Ollama 的强项是易用，默认每个模型同时只处理 1 个请求（可调），批处理和多卡调度能力有限。在线服务需要高吞吐时，常见做法是开发环境用 Ollama，生产用 vLLM 等专门的推理服务器，两者都暴露 OpenAI 兼容接口，应用侧只需切换 `base-url` 和模型名。

---

## 三、REST API

### 1、`/api/chat`

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3",
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是一位 Java 后端专家，回答简洁。" },
    { "role": "user", "content": "HashMap 和 ConcurrentHashMap 的区别？" }
  ],
  "options": { "temperature": 0.2, "num_ctx": 8192 },
  "keep_alive": "10m"
}'
```

- `stream` 默认为 `true`，返回按行分隔的 JSON（NDJSON），每行一个增量片段，最后一行 `done: true` 带上耗时与 token 统计
- 消息角色有 `system`、`user`、`assistant`、`tool`，多模态模型可以在消息里带 `images`（base64）
- 单轮补全用 `/api/generate`，向量化用 `/api/embed`

### 2、结构化输出

`format` 传 `"json"` 只保证输出是合法 JSON，传 JSON Schema 才能约束字段结构，生产环境用后者：

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3",
  "stream": false,
  "messages": [{ "role": "user", "content": "从这句话提取订单信息：张三买了 2 台笔记本，单价 5999" }],
  "format": {
    "type": "object",
    "properties": {
      "customer": { "type": "string" },
      "product":  { "type": "string" },
      "quantity": { "type": "integer" },
      "price":    { "type": "number" }
    },
    "required": ["customer", "product", "quantity", "price"]
  }
}'
```

提示词里最好也说明要输出 JSON，并把 temperature 调低，结果更稳定。

### 3、工具调用

请求里带 `tools`（函数名、描述、参数 JSON Schema），支持工具调用的模型会在响应的 `message.tool_calls` 里给出要调用的函数和参数。应用执行函数后，把结果作为 `role: "tool"` 的消息追加到对话再请求一次。流程与云端 API 一致，见 [Function Calling（工具调用）](../1_concepts/2_function_calling)。模型是否支持工具调用，看模型库页面的 tools 标签或 `ollama show` 的能力列表。

### 4、思考模式

带思考能力的模型（如 qwen3、deepseek-r1、gpt-oss）可以用 `think` 参数控制：`true` / `false` 开关，个别模型（如 gpt-oss）接受 `"low"` / `"medium"` / `"high"` 这类强度值，具体以 `ollama show` 列出的为准。开启后推理过程在 `message.thinking`，最终答案在 `message.content`。不需要推理过程的简单任务关闭思考，能明显降低延迟。

### 5、OpenAI 兼容接口

| 接口 | 说明 |
|------|------|
| `/v1/chat/completions` | 支持流式、工具、图片、`response_format` |
| `/v1/embeddings` | 字符串或字符串数组输入 |
| `/v1/models` | 列出本地模型 |
| `/v1/responses` | v0.13.3 起支持，仅无状态用法 |

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{ "model": "qwen3", "messages": [{ "role": "user", "content": "Hello" }] }'
```

本地服务会忽略 API Key，但多数 OpenAI SDK 要求非空，随便填一个即可。OpenAI 协议里没有设置上下文长度的参数，走兼容接口时需要用服务端环境变量或 Modelfile 调整（见第七节）。

---

## 四、模型选择

Ollama 模型库更新很快，下表只列模型家族和用途，具体尺寸与标签以 [https://ollama.com/library](https://ollama.com/library) 为准：

| 用途 | 可选家族 | 说明 |
|------|----------|------|
| 通用对话、中文 | qwen3 / qwen3.5 / qwen3.6、gemma4、llama3.x | Qwen 系列中文能力强，多数支持工具调用与思考模式 |
| 推理 | deepseek-r1、gpt-oss、开启思考的 qwen3 | 输出带思考过程，延迟和 token 消耗更高 |
| 编程 | qwen3-coder | 面向代码生成与 Agent 场景 |
| 视觉 | qwen3-vl、gemma4、qwen3.5 | 模型库标签为 vision |
| 向量化 | nomic-embed-text、bge-m3、qwen3-embedding、embeddinggemma | bge-m3、qwen3-embedding 对中文和多语言更友好 |

选尺寸时先估内存。权重占用约等于参数量乘以每参数字节数，常用的 4 bit 量化约 0.5～0.6 字节 / 参数，即 8B 模型约 5 GB；在此之上还要加 KV Cache，它随上下文长度和并发数线性增长：

- 总内存 ≈ 权重 + KV Cache
- KV Cache ∝ 上下文长度 × 并发数 × 模型层数与隐藏维度

显存放不下时，Ollama 会把部分层放到 CPU，速度大幅下降，用 `ollama ps` 的 PROCESSOR 列能看出 GPU / CPU 的分配比例。向量化模型一旦选定，入库与查询必须使用同一个，换模型要全量重建向量，见 [Embedding 向量化](../4_core_tech/0_embedding)。

---

## 五、Spring AI 接入

```xml
<dependency>
  <groupId>org.springframework.ai</groupId>
  <artifactId>spring-ai-starter-model-ollama</artifactId>
</dependency>
```

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      init:
        pull-model-strategy: when_missing   # 启动时缺模型就拉取，默认 never
      chat:
        model: ${OLLAMA_CHAT_MODEL:qwen3}
        keep-alive: 10m
        think: false                        # 2.0 由 think-option 改名而来
      embedding:
        model: ${OLLAMA_EMBEDDING_MODEL:nomic-embed-text}
```

ChatClient 的用法与云端模型完全一致，切换厂商不改业务代码：

```java
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class OllamaService {

    private final ChatClient chatClient;

    public OllamaService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public record OrderInfo(String customer, String product, int quantity, double price) {}

    public OrderInfo extract(String text) {
        return chatClient.prompt()
                .user("从这句话提取订单信息：" + text)
                .call()
                .entity(OrderInfo.class);
    }
}
```

需要用 JSON Schema 强约束输出时，可以在 `OllamaChatOptions.builder().outputSchema(schema)` 中传入 Schema，对应原生 API 的 `format` 字段。另一种接法是用 OpenAI Starter 指向 `http://localhost:11434/v1`，适合生产要换成其他 OpenAI 兼容推理服务的场景，代价是 Ollama 特有参数要通过额外请求体传递。

---

## 六、LangChain4j 接入

```xml
<!-- 版本由 langchain4j-bom 管理 -->
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-ollama</artifactId>
</dependency>
```

```java
import java.time.Duration;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.ollama.OllamaChatModel;
import dev.langchain4j.model.ollama.OllamaEmbeddingModel;
import dev.langchain4j.model.output.Response;

ChatModel model = OllamaChatModel.builder()
        .baseUrl("http://localhost:11434")
        .modelName("qwen3")
        .temperature(0.2)
        .numCtx(8192)                       // 显式设置上下文长度，避免长提示被截断
        .think(false)
        .timeout(Duration.ofMinutes(2))     // 本地首次加载模型较慢
        .build();

String answer = model.chat("解释一下 Spring Boot 自动配置的原理");

EmbeddingModel embeddingModel = OllamaEmbeddingModel.builder()
        .baseUrl("http://localhost:11434")
        .modelName("nomic-embed-text")
        .build();

Response<Embedding> response = embeddingModel.embed("Spring AOP 原理");
float[] vector = response.content().vector();
```

`OllamaChatModel` 可以直接交给 AiServices 使用，工具、记忆、RAG 的写法见 [LangChain4j](../2_frameworks/1_langchain4j)。

---

## 七、性能调优

### 1、服务端环境变量

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `OLLAMA_HOST` | `127.0.0.1:11434` | 监听地址 |
| `OLLAMA_NUM_PARALLEL` | 1 | 每个模型同时处理的请求数，内存占用随它乘以上下文长度增长 |
| `OLLAMA_MAX_QUEUE` | 512 | 排队请求上限，超出返回 503 |
| `OLLAMA_MAX_LOADED_MODELS` | GPU 数 × 3，纯 CPU 为 3 | 同时加载的模型数（前提是内存放得下） |
| `OLLAMA_KEEP_ALIVE` | 5m | 模型空闲多久后卸载，负数表示常驻，0 表示用完即卸载；请求里的 `keep_alive` 优先 |
| `OLLAMA_CONTEXT_LENGTH` | 4096（以官方 FAQ 为准） | 默认上下文长度 |
| `OLLAMA_FLASH_ATTENTION` | 支持时自动启用 | 设为 0 强制关闭 |
| `OLLAMA_KV_CACHE_TYPE` | `f16` | KV Cache 量化，`q8_0` 约省一半内存，`q4_0` 约省四分之三，精度略降 |
| `OLLAMA_MODELS` | 各系统用户目录下 | 模型存储路径 |
| `OLLAMA_ORIGINS` | 本机来源 | 允许跨域访问的来源 |
| `OLLAMA_NO_CLOUD` | 未设置 | 设为 1 关闭云端模型与网络搜索 |

上下文长度对 RAG 影响最大：检索到的文档加上历史消息一旦超过上下文长度，前面的内容会被截断，模型“看不到”检索结果却不会报错。做 RAG 时按“系统提示 + 检索片段 + 历史 + 预留输出”估算所需长度，用 `OLLAMA_CONTEXT_LENGTH` 或请求里的 `num_ctx` 调大。

### 2、设置方式

Linux 用安装脚本装成 systemd 服务后，在服务配置里加环境变量，而不是在命令行前面临时设置：

```bash
sudo systemctl edit ollama.service
# 在打开的文件中加入：
# [Service]
# Environment="OLLAMA_NUM_PARALLEL=4"
# Environment="OLLAMA_CONTEXT_LENGTH=16384"
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Docker 用 `-e OLLAMA_NUM_PARALLEL=4`；Windows 在系统环境变量里设置后，从托盘退出 Ollama 再重新打开。

### 3、请求级参数

`options` 字段（或 Modelfile 中的 `PARAMETER`）可以按请求调整：

| 参数 | 作用 |
|------|------|
| `num_ctx` | 本次请求的上下文长度 |
| `num_predict` | 最多生成多少 token，-1 为不限制 |
| `temperature` / `top_k` / `top_p` / `min_p` | 采样参数 |
| `seed` | 固定随机种子，配合低 temperature 便于复现 |
| `stop` | 停止序列 |

调优顺序建议：先确认模型完整放进显存（`ollama ps`），再按需要的上下文长度设 `num_ctx`，最后按并发需求调 `OLLAMA_NUM_PARALLEL`，三者共同决定内存占用。

---

## 八、安全

- **API 没有鉴权**：任何能访问 11434 端口的人都能调用模型、拉取和删除模型。默认只监听 127.0.0.1，设置 `OLLAMA_HOST=0.0.0.0` 或 Docker 映射端口后就暴露给整个网络
- **对外提供服务时加一层网关**：在 Nginx 或 API 网关上做认证、TLS、限流和访问日志，Ollama 本身只监听本机或内网地址，见 [HTTPS 与 TLS](/protocols/3_https_tls) 与 [API 安全](/security/6_api_security)
- **浏览器跨域**：`OLLAMA_ORIGINS` 只放行确实需要的来源，不要设成 `*`，否则任意网页都能借用户浏览器调用本机模型
- **模型来源**：只从官方库或可信来源拉取模型，自定义 Modelfile 里的系统提示同样会影响输出
- **数据边界**：使用云端模型时请求会离开本机，有合规要求时关闭云功能并在网络层限制出站

---

## 小结

- Ollama 适合开发、离线和小规模内网场景，高并发生产推理考虑专门的推理服务，应用侧通过 OpenAI 兼容接口平滑切换
- 原生 `/api/chat` 支持流式、工具调用、JSON Schema 结构化输出和思考模式，兼容接口覆盖 Chat Completions、Embeddings 与无状态 Responses
- 模型按家族和用途选，尺寸由内存决定：权重加 KV Cache，后者随上下文长度和并发线性增长
- 默认上下文较短，RAG 场景要显式调大 `num_ctx` 或 `OLLAMA_CONTEXT_LENGTH`，否则检索内容会被静默截断
- 并发由 `OLLAMA_NUM_PARALLEL` 控制，Linux 服务通过 `systemctl edit` 设置环境变量
- API 无鉴权，对外暴露必须经过带认证和 TLS 的网关；需要数据不出本机时关闭云功能

## 参考资料

- Ollama 官网与模型库：[https://ollama.com/library](https://ollama.com/library)
- Ollama 文档：[https://docs.ollama.com](https://docs.ollama.com)
- API 参考（Chat）：[https://docs.ollama.com/api/chat](https://docs.ollama.com/api/chat)
- OpenAI 兼容接口：[https://docs.ollama.com/api/openai-compatibility](https://docs.ollama.com/api/openai-compatibility)
- FAQ（环境变量、网络暴露、云功能）：[https://docs.ollama.com/faq](https://docs.ollama.com/faq)
- Docker 部署：[https://docs.ollama.com/docker](https://docs.ollama.com/docker)
- Spring AI Ollama Chat：[https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html](https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html)
- GitHub：[https://github.com/ollama/ollama](https://github.com/ollama/ollama)

> 下一篇：[API 直接接入](./1_api_access) —— OpenAI / Claude / Gemini 官方 Java SDK、OpenAI 兼容协议、重试限流与 Prompt Caching。

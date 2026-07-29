# Ollama

Ollama 官方地址：[https://ollama.com/](https://ollama.com/)

Github 开源地址：[https://github.com/ollama](https://github.com/ollama)

Ollama 官方文档：[https://github.com/ollama/ollama/tree/main/docs](https://github.com/ollama/ollama/tree/main/docs)

---

## 一、是什么

Ollama 是一个开源的**本地大语言模型运行工具**，一条命令即可在本机拉取并运行主流开源 LLM（如 Llama、Qwen、DeepSeek、Mistral 等）。

核心特点：

- **跨平台**：支持 macOS、Linux、Windows，原生支持 Apple Silicon（MPS）
- **无需 GPU**：纯 CPU 也可运行（速度较慢），有 GPU 自动加速
- **模型管理**：内置模型注册表，`ollama pull` 一键下载量化模型
- **内置 HTTP Server**：本地启动 REST API，兼容 OpenAI API 格式
- **隐私安全**：数据完全本地处理，不走任何外部网络

---

## 二、安装与基本使用

### 安装

```bash
# macOS（Homebrew）
brew install ollama

# Linux（官方脚本）
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# 到 https://ollama.com/download 下载安装包
```

### 常用命令

```bash
# 拉取模型（自动选择量化版本）
ollama pull qwen2.5:7b
ollama pull llama3.2:3b
ollama pull nomic-embed-text

# 运行模型（交互式对话）
ollama run qwen2.5:7b

# 列出本地已下载模型
ollama list

# 启动后台服务（默认监听 localhost:11434）
ollama serve

# 删除模型
ollama rm qwen2.5:7b

# 查看模型信息
ollama show qwen2.5:7b
```

---

## 三、REST API

Ollama 内置 HTTP 服务，默认监听 `http://localhost:11434`，同时提供**原生 API** 和兼容 **OpenAI API** 两套接口。

### `/api/generate`（单轮补全）

```bash
curl http://localhost:11434/api/generate \
  -d '{
    "model": "qwen2.5:7b",
    "prompt": "用一句话解释什么是 JVM",
    "stream": false
  }'
```

### `/api/chat`（多轮对话）

```bash
curl http://localhost:11434/api/chat \
  -d '{
    "model": "qwen2.5:7b",
    "stream": false,
    "messages": [
      { "role": "user", "content": "Java 中 HashMap 和 ConcurrentHashMap 的区别？" }
    ]
  }'
```

### OpenAI 兼容接口

```bash
# 使用 /v1/chat/completions，可直接替换 OpenAI base URL
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

---

## 四、Java 接入（Spring AI）

Spring AI 通过 `spring-ai-ollama-spring-boot-starter` 原生支持 Ollama。

### 依赖

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-ollama-spring-boot-starter</artifactId>
</dependency>
```

### application.yaml

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: qwen2.5:7b
          temperature: 0.7
      embedding:
        options:
          model: nomic-embed-text
```

### ChatClient 调用示例

```java
@Service
public class OllamaService {

    private final ChatClient chatClient;

    public OllamaService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public String chat(String userMessage) {
        return chatClient.prompt()
                .user(userMessage)
                .call()
                .content();
    }
}
```

---

## 五、Java 接入（LangChain4j）

LangChain4j 通过 `langchain4j-ollama` 模块支持 Ollama。

### 依赖

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-ollama</artifactId>
    <version>${langchain4j.version}</version>
</dependency>
```

### OllamaChatModel 调用示例

```java
OllamaChatModel model = OllamaChatModel.builder()
        .baseUrl("http://localhost:11434")
        .modelName("qwen2.5:7b")
        .temperature(0.7)
        .build();

String response = model.generate("解释一下 Spring Boot 自动配置的原理");
System.out.println(response);
```

### OllamaEmbeddingModel（RAG 向量化）

```java
OllamaEmbeddingModel embeddingModel = OllamaEmbeddingModel.builder()
        .baseUrl("http://localhost:11434")
        .modelName("nomic-embed-text")
        .build();

Response<Embedding> embedding = embeddingModel.embed("Spring AOP 原理");
```

---

## 六、常用模型推荐

| 模型 | 大小（Q4量化） | 用途 | 备注 |
|------|--------------|------|------|
| `qwen2.5:7b` | ~4.7GB | 通用对话、代码、中文 | 中文能力强，推荐首选 |
| `qwen2.5:14b` | ~9GB | 更强通用能力 | 需 16GB+ 内存 |
| `llama3.2:3b` | ~2GB | 轻量英文对话 | 速度快，资源占用低 |
| `deepseek-r1:7b` | ~4.9GB | 推理、数学、逻辑 | R1 蒸馏版，推理能力突出 |
| `codellama:7b` | ~3.8GB | 代码补全与生成 | 专门针对代码微调 |
| `nomic-embed-text` | ~274MB | 文本向量嵌入（RAG） | 轻量高质量 Embedding 模型 |

---

## 七、性能调优

### GPU 层数控制

```bash
# 控制卸载到 GPU 的 Transformer 层数（-1 = 全部）
# macOS / Linux
OLLAMA_NUM_GPU_LAYERS=28 ollama serve

# Windows PowerShell
$env:OLLAMA_NUM_GPU_LAYERS=28; ollama serve
```

### 并发与内存

```bash
# 同时保留多个模型在内存中（默认 1）
OLLAMA_MAX_LOADED_MODELS=2 ollama serve

# 请求队列大小
OLLAMA_MAX_QUEUE=10 ollama serve

# 模型空闲卸载时间（0 = 立即卸载，-1 = 永不卸载）
OLLAMA_KEEP_ALIVE=5m ollama serve
```

### 推理参数（通过 API 传入）

```json
{
  "model": "qwen2.5:7b",
  "options": {
    "num_ctx": 4096,
    "num_batch": 512,
    "num_thread": 8,
    "temperature": 0.7,
    "top_p": 0.9
  }
}
```

| 参数 | 说明 |
|------|------|
| `num_ctx` | 上下文窗口大小，越大占用内存越多 |
| `num_batch` | 批处理大小，影响 prompt 处理速度 |
| `num_thread` | CPU 线程数，纯 CPU 推理时关键 |
| `num_gpu` | 使用 GPU 数量 |

# Netty 总览

Netty 模块从操作系统 IO 模型出发，经过 Reactor 线程模型，落到 Netty 的核心组件与工程问题（粘包拆包、自定义协议），并覆盖 WebSocket、SSE 两种服务端推送方案。

## 一、模块导航

| 文档 | 覆盖内容 |
|------|----------|
| [IO 模型](./1_io_model) | 五种 IO 模型、select / poll / epoll 对比、LT / ET 触发模式 |
| [Reactor 模型](./2_reactor) | 单 Reactor 单线程 / 多线程、主从 Reactor、EventLoop 与 Channel 绑定 |
| [Netty 概述](./3_netty_desc) | 核心组件、Bootstrap、ByteBuf、高性能原因 |
| [粘包与拆包](./4_stick_split) | 成因、四种解决方案、Netty 内置解码器 |
| [WebSocket](./5_websocket) | 协议基础、Netty 服务端实现、Spring WebSocket、适用场景 |
| [SSE](./6_sse) | 协议基础、SseEmitter、WebFlux 与 Netty 原生实现 |
| [自定义私有协议](./7_custom_protocol) | 帧格式设计、LengthFieldBasedFrameDecoder、编解码器、心跳保活、IoT 实战 |
| [面试高频题](./99_interview) | Netty 方向题目清单 |

## 二、推荐阅读路径

1. 先读 [IO 模型](./1_io_model) 与 [Reactor 模型](./2_reactor)，理解 Netty 高性能的底层基础。
2. 再读 [Netty 概述](./3_netty_desc)，掌握 Channel、Pipeline、EventLoop、ByteBuf 等核心组件。
3. 然后读 [粘包与拆包](./4_stick_split) 与 [自定义私有协议](./7_custom_protocol)，解决 TCP 长连接的工程问题。
4. 最后按需阅读 [WebSocket](./5_websocket) 与 [SSE](./6_sse)，选择合适的服务端推送方案。

## 三、关联模块

- Java 侧 NIO API 与零拷贝 → [Java 专项 - IO / NIO](/java/18_topic_io)
- 网络协议基础（TCP / HTTP / WebSocket）→ [协议体系](/protocols/0_overview)
- IO 与网络层性能优化 → [高性能 - IO 与网络优化](/high-perf/7_io_network)

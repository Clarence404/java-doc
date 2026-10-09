# Netty 总览

Netty 是 Java 生态中使用最广的网络通信框架。Dubbo、gRPC-Java、RocketMQ、Spring WebFlux、Spring Cloud Gateway 等组件的网络层都建立在它之上。本模块从操作系统的 IO 模型讲起，逐步深入 Netty 的线程模型、核心组件和内存管理，再落到协议设计、长连接应用和生产调优，共分四个阶段。

## 一、学习路线

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **原理基础** | 操作系统如何处理网络 IO？事件就绪后由哪些线程来处理？ | [IO 模型](./1_io_model) → [Reactor 模型](./2_reactor) |
| **入门与核心** | Netty 解决了原生 NIO 的哪些问题？它的核心组件如何协作？ | [Netty 入门](./3_netty_desc) → [Channel 与 EventLoop](./4_channel_eventloop) → [Pipeline 与 Handler](./5_pipeline_handler) → [ByteBuf 与内存管理](./6_bytebuf) |
| **协议与编解码** | 如何在 TCP 字节流上界定消息？如何设计私有协议、维持长连接？ | [粘包与拆包](./7_stick_split) → [自定义私有协议](./8_custom_protocol) → [心跳与连接管理](./9_heartbeat) |
| **应用与生产** | 如何实现服务端推送？上线前要调哪些参数、避开哪些坑？ | [WebSocket](./10_websocket) → [SSE](./11_sse) → [生产实践与调优](./12_production) |

## 二、模块导航

<ModuleNav />

## 三、阅读建议

- **第一次接触 Netty**：按顺序读完前五篇，并把 [Netty 入门](./3_netty_desc) 里的 Echo 示例在本地跑一遍，再接着往下读。
- **要做 RPC 或设备接入**：重点阅读第 6～8 篇，再结合 [IoT - Java 实战](/iot/6_java_iot) 中带 CRC 校验的完整实现。
- **要做实时推送**：先读 [心跳与连接管理](./9_heartbeat)，再根据是否需要客户端上行消息，在 [WebSocket](./10_websocket) 和 [SSE](./11_sse) 之间选择。
- **准备上线或排查线上问题**：直接看 [生产实践与调优](./12_production) 的参数表和常见坑。

## 四、关联模块

- Java 侧的 NIO API（Channel、Buffer、Selector）与零拷贝 → [Java IO 与 NIO](/java/18_topic_io)
- TCP、HTTP、WebSocket 等协议基础 → [网络协议](/protocols/0_overview)
- IO 与网络层性能优化 → [高性能 - IO 与网络优化](/high-perf/9_io_network)
- 答案汇总 → [开发总结 - Netty](/interview/6_netty)

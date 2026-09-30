# Netty 总览

Netty 是 Java 生态中使用最广的网络通信框架。Dubbo、gRPC-Java、RocketMQ、Spring WebFlux、Spring Cloud Gateway 等组件的网络层都建立在它之上。本模块从操作系统的 IO 模型讲起，逐步深入 Netty 的线程模型、核心组件和内存管理，再落到协议设计、长连接应用和生产调优，共分四个阶段。

## 一、学习路线

| 阶段 | 要解决的问题 | 文章 |
|------|-------------|------|
| **原理基础** | 操作系统如何处理网络 IO？事件就绪后由哪些线程来处理？ | [IO 模型](./1_io_model) → [Reactor 模型](./2_reactor) |
| **入门与核心** | Netty 解决了原生 NIO 的哪些问题？它的核心组件如何协作？ | [Netty 入门](./3_netty_desc) → [核心组件](./4_core_components) → [ByteBuf 与内存管理](./5_bytebuf) |
| **协议与编解码** | 如何在 TCP 字节流上界定消息？如何设计私有协议、维持长连接？ | [粘包与拆包](./6_stick_split) → [自定义私有协议](./7_custom_protocol) → [心跳与连接管理](./8_heartbeat) |
| **应用与生产** | 如何实现服务端推送？上线前要调哪些参数、避开哪些坑？ | [WebSocket](./9_websocket) → [SSE](./10_sse) → [生产实践与调优](./11_production) |

## 二、模块导航

| 文档 | 覆盖内容 |
|------|----------|
| [IO 模型](./1_io_model) | 一次读操作的两个阶段、五种 IO 模型、select / poll / epoll、LT / ET 触发模式 |
| [Reactor 模型](./2_reactor) | 单线程、单 Reactor 多线程、主从 Reactor，以及 Reactor 与 Proactor 的区别 |
| [Netty 入门](./3_netty_desc) | 原生 NIO 的痛点、Netty 的定位与架构、第一个 Echo 程序、核心组件速览、Bootstrap 配置 |
| [核心组件](./4_core_components) | Channel 生命周期、ChannelFuture、EventLoop 运行机制、Pipeline 事件传播、Handler、业务线程池 |
| [ByteBuf 与内存管理](./5_bytebuf) | 读写指针、堆内与直接内存、池化、引用计数、泄漏检测、零拷贝、内存池原理 |
| [粘包与拆包](./6_stick_split) | 成因与复现、四种界定方案、Netty 内置帧解码器及其工作原理 |
| [自定义私有协议](./7_custom_protocol) | 帧格式与字段设计、LengthFieldBasedFrameDecoder、编解码器体系、请求与响应的匹配 |
| [心跳与连接管理](./8_heartbeat) | 半开连接、IdleStateHandler、心跳方案、断线重连、在线会话管理 |
| [WebSocket](./9_websocket) | 握手与帧格式、Netty 与 Spring 两种实现、集群部署下的消息推送 |
| [SSE](./10_sse) | 数据格式、SseEmitter 与 WebFlux、Netty 原生实现、反向代理配置 |
| [生产实践与调优](./11_production) | 线程模型与原生传输、关键参数、写水位与背压、优雅停机、监控指标、常见坑 |
| [面试高频题](./99_interview) | Netty 方向题目清单 |

## 三、阅读建议

- **第一次接触 Netty**：按顺序读完前五篇，并把 [Netty 入门](./3_netty_desc) 里的 Echo 示例在本地跑一遍，再接着往下读。
- **要做 RPC 或设备接入**：重点阅读第 6～8 篇，再结合 [IoT - Java 实战](/iot/6_java_iot) 中带 CRC 校验的完整实现。
- **要做实时推送**：先读 [心跳与连接管理](./8_heartbeat)，再根据是否需要客户端上行消息，在 [WebSocket](./9_websocket) 和 [SSE](./10_sse) 之间选择。
- **准备上线或排查线上问题**：直接看 [生产实践与调优](./11_production) 的参数表和常见坑。

## 四、关联模块

- Java 侧的 NIO API（Channel、Buffer、Selector）与零拷贝 → [Java 专项 - IO / NIO](/java/18_topic_io)
- TCP、HTTP、WebSocket 等协议基础 → [网络协议](/protocols/0_overview)
- IO 与网络层性能优化 → [高性能 - IO 与网络优化](/high-perf/9_io_network)
- 答案汇总 → [开发总结 - Netty](/interview/11_netty)

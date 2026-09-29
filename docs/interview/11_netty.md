# 开发总结-Netty

> 精华提炼，细节详见 [netty/](../netty/1_io_model)

## 一、BIO、NIO、AIO 的区别？

| 模型 | 全称 | 特点 | 适用场景 |
|------|------|------|---------|
| **BIO** | Blocking IO | 一连接一线程，读写阻塞；简单但资源消耗大 | 连接数少的场景 |
| **NIO** | Non-blocking IO | Selector 多路复用，一个线程处理多个连接 | 高并发短连接 |
| **AIO** | Asynchronous IO | 内核完成 IO 后主动回调，全异步 | Windows IOCP 成熟，Linux 支持一般，实际少用 |

**BIO 的问题**：1000 个连接就需要 1000 个线程，线程切换开销巨大，且大量线程在等 IO 时完全浪费。

**NIO 的核心**：`Selector` 负责监听多个 Channel 的事件（连接、读、写），哪个 Channel 就绪就处理哪个，一个线程搞定多个连接。

## 二、select、poll、epoll 的区别？

三者都是 IO 多路复用的系统调用，NIO 底层用的就是这类机制。

| | select | poll | epoll |
|--|--------|------|-------|
| 最大连接数 | 1024（FD_SETSIZE 限制）| 无限制 | 无限制 |
| fd 集合拷贝 | 每次调用全量拷贝到内核 | 每次调用全量拷贝 | mmap 共享内存，无需拷贝 |
| 查找就绪 fd | 遍历全部 fd，O(n) | 遍历全部 fd，O(n) | 内核维护就绪队列，O(1) |
| 适合场景 | 少量连接 | 少量连接 | 高并发首选 |

**epoll 为什么快**：基于事件驱动，只有就绪的 fd 才会通知，不需要轮询所有连接。Java NIO 在 Linux 上底层就是 epoll。

## 三、Netty 的线程模型是什么？

Netty 使用**主从 Reactor 多线程模型**：

```
客户端连接
     ↓
BossGroup（通常 1 个线程）
  └── 专门处理 Accept，接受新连接后注册到 WorkerGroup
     ↓
WorkerGroup（CPU * 2 个线程）
  └── 处理每个连接的 Read / Write / Handler 业务逻辑
```

每个 `EventLoop` 是一个单线程，绑定若干 `Channel`，轮询就绪事件并处理。**同一个 Channel 的所有事件都由同一个 EventLoop 处理**，天然线程安全，无需加锁。

**与其他 Reactor 模型对比**：

| 模型 | 特点 | 缺点 |
|------|------|------|
| 单 Reactor 单线程 | 简单，Acceptor + Handler 同线程 | Handler 耗时影响 Acceptor |
| 单 Reactor 多线程 | Handler 交给线程池 | Reactor 单线程仍是瓶颈 |
| **主从 Reactor（Netty）** | Boss 只 Accept，Worker 处理 IO | — |

## 四、粘包和拆包是什么？如何解决？

**原因**：TCP 是流协议，没有消息边界。多条消息可能被合并发送（粘包），一条消息也可能被分多次发送（拆包）。

**Netty 提供的解码器**：

| 解码器 | 原理 | 适用场景 |
|--------|------|---------|
| `FixedLengthFrameDecoder` | 每条消息固定 N 字节 | 定长协议 |
| `LineBasedFrameDecoder` | 以 `\n` 或 `\r\n` 为分隔符 | 文本协议 |
| `DelimiterBasedFrameDecoder` | 自定义分隔符 | 自定义文本协议 |
| `LengthFieldBasedFrameDecoder` | 消息头携带长度字段 | **二进制协议首选** |

```java
// 常用配置：消息头 4 字节表示消息体长度
pipeline.addLast(new LengthFieldBasedFrameDecoder(
    65535,  // maxFrameLength：最大帧长度
    0,      // lengthFieldOffset：长度字段偏移量
    4,      // lengthFieldLength：长度字段占 4 字节
    0,      // lengthAdjustment：长度补偿
    4       // initialBytesToStrip：跳过长度字段本身
));
```

## 五、Netty 为什么高性能？

1. **主从 Reactor 模型**：IO 线程与业务逻辑分离，互不干扰
2. **零拷贝**：`CompositeByteBuf`（逻辑合并不拷贝）、`FileRegion`（底层 sendfile 直接传文件）
3. **内存池**：`PooledByteBufAllocator` 复用 ByteBuf 对象，减少 GC 压力
4. **无锁化**：Channel 绑定固定 EventLoop，单线程处理，无竞争
5. **直接内存**：堆外内存，减少 JVM 堆到内核的一次拷贝

## 六、WebSocket 和 HTTP 长轮询的区别？

| | HTTP 短轮询 | HTTP 长轮询 | SSE | WebSocket |
|--|-----------|-----------|-----|-----------|
| 通信方向 | 客户端拉 | 客户端拉（hold 住请求）| 服务端推（单向）| 双向全双工 |
| 连接 | 每次新建 | 服务端有数据或超时才响应 | 长连接 | 长连接（升级自 HTTP）|
| 实时性 | 低 | 较高 | 较高 | 最高 |
| 服务端开销 | 低 | 中（hold 连接占资源）| 低 | 低 |
| 适用场景 | 简单定时刷新 | 消息推送（兼容性要求高）| 日志流、ChatGPT 打字效果 | 聊天、游戏、实时协作 |

**Netty 实现 WebSocket**（握手升级由框架自动处理）：

```java
pipeline.addLast(new HttpServerCodec());
pipeline.addLast(new HttpObjectAggregator(65536));
pipeline.addLast(new WebSocketServerProtocolHandler("/ws"));  // 自动处理握手
pipeline.addLast(new MyWebSocketFrameHandler());
```

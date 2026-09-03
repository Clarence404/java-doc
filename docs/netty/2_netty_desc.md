# Netty 概述

## 一、Netty 是什么

Netty 是一个**异步事件驱动**的网络应用框架，基于 Java NIO 构建，对 Java 原生 NIO 的复杂性进行了高度封装，使开发者可以专注于业务逻辑而非底层 I/O 细节。

**核心优势：**

- **高性能**：零拷贝、内存池、无锁化设计，吞吐量远超传统 BIO
- **高并发**：Reactor 线程模型，少量线程处理大量连接
- **低延迟**：直接内存操作，减少 GC 压力
- **易扩展**：ChannelPipeline 责任链，功能以 Handler 插拔方式组合

**典型使用场景：**

| 场景 | 代表项目 |
|------|----------|
| RPC 框架底层传输 | Dubbo、gRPC-Java、Thrift |
| IoT 设备接入 | MQTT Broker、CoAP 网关 |
| 游戏服务器 | 实时对战、长连接推送 |
| API 网关 | Soul Gateway、自研网关 |

---

## 二、核心组件

![Netty 架构分层](../assets/netty/netty-arch.svg)

### Channel

`Channel` 是 Netty 对网络连接的抽象，替代了 Java NIO 原生的 `SocketChannel`。它屏蔽了底层传输协议的差异，提供统一的 I/O 操作 API（`read`、`write`、`connect`、`bind`）。常见实现：

- `NioSocketChannel`：基于 NIO 的 TCP 客户端 Channel
- `NioServerSocketChannel`：基于 NIO 的 TCP 服务端 Channel
- `NioDatagramChannel`：UDP Channel

### EventLoop 与 EventLoopGroup

`EventLoop` 是一个**单线程的事件循环**，负责处理注册到其上的所有 `Channel` 的 I/O 事件。`EventLoopGroup` 是多个 `EventLoop` 的集合。

**Channel 与 EventLoop 的绑定关系（一对多）：**

- 一个 `Channel` 在其生命周期内只绑定到一个 `EventLoop`
- 一个 `EventLoop` 可以服务多个 `Channel`

**为什么 Channel 绑定固定 EventLoop？**

1. **避免线程切换**：所有该 Channel 的 I/O 操作都在同一线程执行，无需加锁
2. **保证事件顺序**：同一 Channel 上的读写事件严格按顺序处理，不会乱序

### ChannelPipeline

`ChannelPipeline` 是一条 `ChannelHandler` 组成的**责任链**，入站和出站事件在链上双向流动：

- **入站事件**（Inbound）：从链头流向链尾，如 `channelRead`、`channelActive`
- **出站事件**（Outbound）：从链尾流向链头，如 `write`、`connect`、`flush`

**传播机制的三个关键点**（实战第一坑位）：

```java
pipeline.addLast(new InboundA())    // 入站顺序：A → B
        .addLast(new InboundB())
        .addLast(new OutboundC())   // 出站顺序：D → C（与添加顺序相反）
        .addLast(new OutboundD());
```

1. **传播不是自动的**：入站 Handler 必须调用 `ctx.fireChannelRead(msg)`（或继承 Adapter 的默认实现）事件才会继续向后走——忘记调用，后面的 Handler 全部收不到，这是"解码器加了却不生效"的头号原因
2. **`ctx.write()` vs `channel.write()`**：前者从**当前 Handler 向前**找出站 Handler，后者从**链尾**走完整条出站链——位置感知错误会导致编码器被跳过
3. **异常传播只走入站方向**：`exceptionCaught` 沿入站链继续向后传播，出站异常需要通过 `ChannelFuture.addListener` 捕获；惯例是在**链尾放一个统一异常处理 Handler** 兜底（记日志 + 关连接），否则异常只会打印 "An exceptionCaught() event was fired..." 警告后被丢弃

### ChannelHandler

处理 I/O 事件或拦截 I/O 操作的接口，分为两类：

| 类型 | 接口 | 用途 |
|------|------|------|
| 入站处理器 | `ChannelInboundHandler` | 处理读事件、连接事件、异常等 |
| 出站处理器 | `ChannelOutboundHandler` | 处理写操作、连接操作等 |

实际开发通常继承 `ChannelInboundHandlerAdapter` 或 `SimpleChannelInboundHandler<T>`。

### ByteBuf

Netty 自研的字节容器，采用**读写双指针**设计：

- `readerIndex`：下一次读取的起始位置
- `writerIndex`：下一次写入的起始位置

**对比 NIO `ByteBuffer` 的优势：**

| 特性 | NIO ByteBuffer | Netty ByteBuf |
|------|---------------|---------------|
| 读写切换 | 需要手动调用 `flip()` | 无需 flip，读写指针独立 |
| 扩容 | 固定容量，不支持动态扩容 | 自动扩容 |
| 池化 | 不支持 | 支持（`PooledByteBufAllocator`） |
| 零拷贝 | 有限支持 | `CompositeByteBuf`、`wrap` 等多种方式 |

---

## 三、引导类（Bootstrap）

引导类负责配置和启动 Netty 应用，服务端和客户端使用不同的引导类：

| 特性 | `ServerBootstrap` | `Bootstrap` |
|------|-------------------|-------------|
| 用途 | 服务端 | 客户端 |
| EventLoopGroup 数量 | 2 个（BossGroup + WorkerGroup） | 1 个 |
| 绑定操作 | `bind(port)` | `connect(host, port)` |

**ServerBootstrap 典型配置：**

```java
EventLoopGroup bossGroup   = new NioEventLoopGroup(1);   // 接受连接
EventLoopGroup workerGroup = new NioEventLoopGroup();    // 处理 I/O

ServerBootstrap bootstrap = new ServerBootstrap()
    .group(bossGroup, workerGroup)
    .channel(NioServerSocketChannel.class)
    .option(ChannelOption.SO_BACKLOG, 128)
    .childOption(ChannelOption.SO_KEEPALIVE, true)
    .childHandler(new ChannelInitializer<SocketChannel>() {
        @Override
        protected void initChannel(SocketChannel ch) {
            ch.pipeline()
              .addLast(new LengthFieldBasedFrameDecoder(65536, 0, 4))
              .addLast(new MyBusinessHandler());
        }
    });

ChannelFuture future = bootstrap.bind(8080).sync();
future.channel().closeFuture().sync();
```

---

## 四、ByteBuf 详解

### 三种使用模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| 堆缓冲区（HeapByteBuf） | 数据存储在 JVM 堆内存 | 频繁创建/销毁的短生命周期对象 |
| 直接缓冲区（DirectByteBuf） | 数据存储在堆外内存，避免从堆到 OS 的拷贝 | 需要直接与 I/O 交互的场景 |
| 复合缓冲区（CompositeByteBuf） | 逻辑上合并多个 ByteBuf，物理上不复制 | 协议头 + 协议体拼装（零拷贝） |

### 池化 vs 非池化

- **池化**（`PooledByteBufAllocator`）：复用已分配的内存块，减少 GC 频率，生产环境推荐
- **非池化**（`UnpooledByteBufAllocator`）：每次分配新内存，简单但 GC 压力大

Netty 默认在 Android 之外的平台使用池化分配器。

### 引用计数与内存泄漏防范

`ByteBuf` 实现了 `ReferenceCounted` 接口，采用引用计数管理内存：

- 初始引用计数为 **1**
- `retain()`：计数 +1
- `release()`：计数 -1，归零时释放内存
- 若最终 `release()` 未调用，Netty 会在 GC 时通过 `ResourceLeakDetector` 报告泄漏

```java
ByteBuf buf = ctx.alloc().buffer();
try {
    // 使用 buf
    ctx.writeAndFlush(buf.retain()); // 传递时 retain，让接收方持有
} finally {
    buf.release(); // 本方使用完毕后 release
}
```

> [!warning]
> 使用 `SimpleChannelInboundHandler` 时，Netty 会自动调用 `release()`；若使用 `ChannelInboundHandlerAdapter` 则需要手动释放或调用 `ReferenceCountUtil.release(msg)`。

---

## 五、高性能原因

### 零拷贝

Netty 的零拷贝在用户态层面消除不必要的内存复制：

- **`CompositeByteBuf`**：将多个 `ByteBuf` 逻辑合并为一个视图，不做物理拷贝
- **`Unpooled.wrappedBuffer()`**：包装已有字节数组为 `ByteBuf`，不复制数据
- **`FileRegion`**：调用底层 `transferTo()`，将文件内容直接传输到 `Channel`（依赖 OS sendfile）

### 内存池（PooledByteBufAllocator）

基于 **jemalloc** 思想实现的内存分配器，将堆外内存划分为多级结构（Arena → Chunk → Page → Subpage），通过对象复用大幅减少 GC 压力。

### 无锁化设计

所有 I/O 操作都在 Channel 绑定的唯一 `EventLoop` 线程中串行执行，不存在多线程竞争，无需对 `Channel` 状态加锁。业务逻辑中若需要与其他线程交互，建议通过 `ctx.executor().submit()` 将任务切回 EventLoop 线程。

### 高效的 I/O 线程模型

采用 **主从 Reactor 多线程模型**：

- **BossGroup**：专门负责接受客户端连接（`accept`），将连接注册到 WorkerGroup
- **WorkerGroup**：处理已建立连接的读写 I/O 事件，每个 EventLoop 绑定一批 Channel

这一模型使少量线程即可支撑数万乃至百万级并发连接。

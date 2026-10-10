---
description: 原生 NIO 的痛点、Netty 的定位与架构、第一个 Echo 程序、核心组件速览、Bootstrap 配置
---

# Netty 入门

> 前置阅读：[Reactor 模型](./2_reactor)

Netty 是对原生 NIO 的封装，解决了其 API 繁琐和诸多坑点。本篇讲 Netty 解决了哪些问题、一个完整的 Echo 服务端 / 客户端，以及一次请求在 Netty 中怎么流动。

## 一、为什么需要 Netty

**JDK NIO 只提供了多路复用的原始能力，离一个可上线的网络服务还差很远**。线程模型、协议拆包、连接管理、异常处理都要自己搭，而且有不少容易踩的坑。

| 原生 JDK NIO 的痛点 | Netty 的解决方式 |
|--------------------|-----------------|
| API 繁琐：`Selector`、`SelectionKey`、`ByteBuffer` 要手动配合，`flip()` / `clear()` 用错就读写错位 | 用 `Channel`、`ChannelHandler` 等高层抽象屏蔽细节；`ByteBuf` 读写双指针，不需要 `flip()` |
| TCP 半包、粘包要自己处理 | 内置 `LineBasedFrameDecoder`、`LengthFieldBasedFrameDecoder` 等帧解码器 |
| 断线重连、心跳检测、空闲连接清理都要自己实现 | `IdleStateHandler` 空闲检测，配合监听器实现重连 |
| JDK epoll 空轮询 bug：`select()` 在无事件时反复立即返回，导致 CPU 100% | 统计 `select()` 连续提前返回的次数，超过阈值（默认 512）就重建 `Selector` |
| 线程模型要自己设计，多线程读写同一连接容易出现并发问题 | 内置主从 Reactor；Channel 绑定单个 EventLoop，Handler 默认串行执行 |
| 异常处理、资源释放分散在各处，容易泄漏连接和内存 | 异常沿 Pipeline 传播统一处理；`ByteBuf` 引用计数 + 泄漏检测 |
| HTTP、WebSocket、SSL 等协议要从零实现 | 提供 HTTP/1.1、HTTP/2、WebSocket、SSL/TLS 等现成编解码器 |

## 二、Netty 是什么

Netty 是一个**异步、事件驱动**的网络应用框架，基于 Java NIO（也支持 Linux 原生 epoll 等传输）构建，用于开发高性能的协议服务端和客户端。

这里的"异步"指的是**编程接口**：`bind`、`connect`、`write` 等操作立即返回一个 `ChannelFuture`，结果通过监听器回调得到；底层 IO 模型仍是[上一篇](./1_io_model)讲的同步非阻塞 + 多路复用。

### 1、谁在用 Netty

| 领域 | 典型项目 | 用途 |
|------|---------|------|
| RPC 框架 | Dubbo、gRPC-Java | 服务间通信的网络传输层 |
| 消息队列 | RocketMQ | Broker、NameServer、客户端之间的通信（remoting 模块）|
| 搜索引擎 | Elasticsearch | 节点间通信与 HTTP 接口（transport-netty4 模块）|
| 响应式 Web | Reactor Netty（Spring WebFlux 默认服务器）| 非阻塞 HTTP 服务端 / 客户端 |
| API 网关 | Spring Cloud Gateway | 基于 WebFlux + Reactor Netty 的网关 |
| Redis 客户端 | Lettuce | Spring Boot 默认的 Redis 客户端，基于 Netty 实现非阻塞通信 |
| 应用框架 | Vert.x | 底层网络基于 Netty |
| 大数据 | Apache Flink | TaskManager 之间的数据交换 |

### 2、架构分层

![Netty 架构分层](../assets/netty/netty-arch.svg)

| 层 | 包含内容 | 作用 |
|----|---------|------|
| 用户代码 | 自定义 `ChannelHandler` | 编解码、协议处理、业务分发，是开发者主要编写的部分 |
| Pipeline | `ChannelPipeline`、Handler 链 | 组织 Handler，负责入站 / 出站事件的传播 |
| Transport | `Channel`、`EventLoop`、`ByteBuf` | 抽象连接、线程模型和内存管理，同一套 API 可切换 NIO / epoll 等传输 |
| 底层支撑 | JDK NIO（`Selector`、`SocketChannel`）或原生传输 | 真正执行系统调用的地方 |

## 三、第一个 Netty 程序：Echo 服务

**Echo 服务把收到的每一行文本原样写回**。它足够小，但已经包含了 Netty 程序的全部骨架：线程组、引导类、Pipeline、Handler、优雅关闭。

依赖（Maven）：

```xml
<dependency>
    <groupId>io.netty</groupId>
    <artifactId>netty-all</artifactId>
    <version>4.1.115.Final</version>
</dependency>
```

### 1、服务端

```java
public final class EchoServer {

    public static void main(String[] args) throws InterruptedException {
        EventLoopGroup bossGroup = new NioEventLoopGroup(1);   // 主 Reactor：accept
        EventLoopGroup workerGroup = new NioEventLoopGroup();  // 从 Reactor：读写，默认 CPU 核数 × 2 个线程
        try {
            ServerBootstrap b = new ServerBootstrap()
                    .group(bossGroup, workerGroup)
                    .channel(NioServerSocketChannel.class)
                    .option(ChannelOption.SO_BACKLOG, 1024)
                    .childOption(ChannelOption.TCP_NODELAY, true)
                    .childHandler(new ChannelInitializer<SocketChannel>() {
                        @Override
                        protected void initChannel(SocketChannel ch) {
                            ch.pipeline()
                              .addLast(new LineBasedFrameDecoder(1024))          // 按换行符拆帧
                              .addLast(new StringDecoder(CharsetUtil.UTF_8))     // ByteBuf → String
                              .addLast(new StringEncoder(CharsetUtil.UTF_8))     // String → ByteBuf
                              .addLast(new EchoServerHandler());                 // 业务处理
                        }
                    });

            ChannelFuture f = b.bind(8080).sync();   // 绑定端口，等待绑定完成
            f.channel().closeFuture().sync();        // 阻塞主线程，直到服务端 Channel 关闭
        } finally {
            bossGroup.shutdownGracefully();          // 优雅关闭：处理完已提交任务再退出
            workerGroup.shutdownGracefully();
        }
    }
}
```

```java
public class EchoServerHandler extends SimpleChannelInboundHandler<String> {

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, String msg) {
        ctx.writeAndFlush(msg + "\n");               // 原样写回，补回被解码器去掉的换行符
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        ctx.close();                                 // 出现异常直接关闭连接
    }
}
```

### 2、客户端

```java
public final class EchoClient {

    public static void main(String[] args) throws InterruptedException {
        EventLoopGroup group = new NioEventLoopGroup();        // 客户端只需一个线程组
        try {
            Bootstrap b = new Bootstrap()
                    .group(group)
                    .channel(NioSocketChannel.class)
                    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
                    .handler(new ChannelInitializer<SocketChannel>() {
                        @Override
                        protected void initChannel(SocketChannel ch) {
                            ch.pipeline()
                              .addLast(new LineBasedFrameDecoder(1024))
                              .addLast(new StringDecoder(CharsetUtil.UTF_8))
                              .addLast(new StringEncoder(CharsetUtil.UTF_8))
                              .addLast(new SimpleChannelInboundHandler<String>() {
                                  @Override
                                  protected void channelRead0(ChannelHandlerContext ctx, String msg) {
                                      System.out.println("收到回显: " + msg);
                                  }
                              });
                        }
                    });

            Channel ch = b.connect("127.0.0.1", 8080).sync().channel();
            ch.writeAndFlush("hello netty\n");                 // 以换行符结尾，匹配服务端的拆帧规则
            ch.closeFuture().await(5, TimeUnit.SECONDS);
        } finally {
            group.shutdownGracefully();
        }
    }
}
```

::: tip 为什么要加 LineBasedFrameDecoder
TCP 是字节流，没有消息边界，一次读到的数据可能是半行，也可能是多行。`LineBasedFrameDecoder` 按换行符把字节流切成完整的一行再往后传。去掉它，Demo 在本机通常也能跑通，但在真实网络下会出现消息错乱，详见 [粘包与拆包](./7_stick_split)。
:::

### 3、一次请求在 Netty 中怎么流动

以客户端发送 `hello netty\n` 为例：

1. **accept**：bossGroup 的 EventLoop 在 `NioServerSocketChannel` 上监听到连接事件，accept 得到一个新的 `NioSocketChannel`
2. **注册到 worker**：`ServerBootstrapAcceptor` 为新连接设置 `childOption`、添加 `childHandler`，并把它注册到 `workerGroup` 中选出的一个 EventLoop；此后这个连接的所有事件都由该 EventLoop 处理
3. **初始化 Pipeline**：注册完成后执行 `ChannelInitializer.initChannel()`，把解码器、编码器、业务 Handler 装进 Pipeline，随后 `ChannelInitializer` 自动从 Pipeline 中移除
4. **读事件**：数据到达，worker EventLoop 的 Selector 返回读就绪，Netty 把数据读入一个 `ByteBuf`，调用 `pipeline.fireChannelRead(byteBuf)`
5. **入站传播**：`LineBasedFrameDecoder` 切出完整的一行 → `StringDecoder` 转成 `String` → `EchoServerHandler.channelRead0()` 收到 `"hello netty"`
6. **写回**：Handler 调用 `ctx.writeAndFlush()`，写事件从当前 Handler 位置**向链头方向**传播，经过 `StringEncoder` 编码成 `ByteBuf`
7. **出站与 flush**：`write` 先把数据放进该 Channel 的发送缓冲队列，`flush` 再真正写入 Socket；如果 Socket 发送缓冲区已满，Netty 会注册写事件，等可写时继续发送

入站走"链头 → 链尾"，出站走"链尾 → 链头"。Pipeline 的传播规则和常见坑在 [Pipeline 与 Handler](./5_pipeline_handler) 中详细展开。

## 四、核心组件速览

**Echo 程序里出现的每个类，都对应 Netty 的一个核心概念**。这里只建立整体印象，深入内容见后续两篇。

| 组件 | 是什么 | 作用 | 详见 |
|------|--------|------|------|
| `Channel` | 通道，对一个网络连接的抽象 | 提供 `read`、`write`、`bind`、`connect`、`close` 等统一操作 | [Channel 与 EventLoop](./4_channel_eventloop) |
| `EventLoop` / `EventLoopGroup` | 事件循环 / 事件循环组 | 一个 EventLoop 是一个线程，处理所绑定 Channel 的 IO 事件和任务；Group 是一组 EventLoop | [Channel 与 EventLoop](./4_channel_eventloop) |
| `ChannelFuture` | 异步操作的结果 | IO 操作立即返回 Future，通过 `addListener` 获取完成结果 | [Channel 与 EventLoop](./4_channel_eventloop) |
| `ChannelPipeline` | 流水线，Handler 组成的双向链表 | 每个 Channel 一条，负责入站 / 出站事件的传播 | [Pipeline 与 Handler](./5_pipeline_handler) |
| `ChannelHandler` / `ChannelHandlerContext` | 处理器 / 处理器上下文 | Handler 处理事件；Context 表示 Handler 在 Pipeline 中的位置，用于继续传播事件 | [Pipeline 与 Handler](./5_pipeline_handler) |
| `ByteBuf` | Netty 的字节容器 | 读写双指针、可扩容、支持池化与堆外内存 | [ByteBuf 与内存管理](./6_bytebuf) |
| `Bootstrap` / `ServerBootstrap` | 引导类 | 把线程组、Channel 类型、参数、Handler 组装起来并启动 | 本篇第五节 |

## 五、Bootstrap 常用配置

### 1、ServerBootstrap 与 Bootstrap

| 对比项 | `ServerBootstrap` | `Bootstrap` |
|--------|-------------------|-------------|
| 用途 | 服务端 | 客户端（也用于 UDP）|
| EventLoopGroup | 通常两个：boss + worker | 一个 |
| Channel 类型 | `NioServerSocketChannel` | `NioSocketChannel` |
| 启动方法 | `bind(port)` | `connect(host, port)` |
| Handler 配置 | `handler()` 作用于监听 Channel，`childHandler()` 作用于每个新连接 | 只有 `handler()` |
| 参数配置 | `option()` + `childOption()` | 只有 `option()` |

### 2、option 与 childOption

服务端有两类 Channel，所以参数也分两类：

- **`option()`**：作用于监听端口的 `NioServerSocketChannel`，只有一个，如 `SO_BACKLOG`
- **`childOption()`**：作用于每个 accept 进来的 `NioSocketChannel`，如 `TCP_NODELAY`、`SO_KEEPALIVE`
- 把连接级参数错写到 `option()` 上，它只会作用于监听 Channel，对已建立的连接不起作用

### 3、最常用的几个参数

| 参数 | 设置位置 | 作用 | 说明 |
|------|---------|------|------|
| `SO_BACKLOG` | 服务端 `option` | 已完成三次握手、等待 accept 的连接队列长度 | 实际值还受系统 `net.core.somaxconn` 限制；突发建连多时需调大 |
| `TCP_NODELAY` | `childOption` / 客户端 `option` | 关闭 Nagle 算法，小包立即发送 | 对延迟敏感的场景应开启，Netty 在多数平台默认已开启 |
| `SO_KEEPALIVE` | `childOption` / 客户端 `option` | 开启 TCP 层保活探测 | Linux 默认空闲 2 小时才探测，不能代替应用层心跳，见 [心跳与连接管理](./9_heartbeat) |
| `CONNECT_TIMEOUT_MILLIS` | 客户端 `option` | 建立连接的超时时间 | 默认 30 秒，客户端通常要调小 |

完整的参数调优、原生 epoll 传输、线程数配置见 [生产实践与调优](./12_production)。

## 六、Netty 为什么快（总览）

**Netty 的性能来自"线程模型 + 内存管理 + 传输层"三方面的共同设计**，每一点都在后续文章中单独展开：

- **主从 Reactor 线程模型**：少量线程处理大量连接，accept 与读写分离 → [Reactor 模型](./2_reactor)
- **无锁串行化**：Channel 绑定单个 EventLoop，同一连接上的处理不需要加锁，也没有线程切换 → [Channel 与 EventLoop](./4_channel_eventloop)
- **池化直接内存与零拷贝**：`PooledByteBufAllocator` 复用内存、减少 GC；堆外内存减少一次拷贝；`CompositeByteBuf`、`FileRegion` 避免多余的数据复制 → [ByteBuf 与内存管理](./6_bytebuf)
- **原生 epoll 传输**：绕过 JDK Selector，使用 ET 模式并支持更多 Socket 参数 → [生产实践与调优](./12_production)

## 小结

- JDK NIO 只提供多路复用的基础能力，Netty 补齐了线程模型、拆包、连接管理、协议支持，并规避了 epoll 空轮询 bug
- Netty 的"异步"指编程接口返回 `ChannelFuture`，底层仍是同步非阻塞 + 多路复用
- 一个 Netty 程序的骨架：两个 EventLoopGroup + ServerBootstrap + ChannelInitializer 装配 Pipeline + 业务 Handler + 优雅关闭
- 请求流动路径：boss accept → 注册到 worker EventLoop → 入站解码 → 业务 Handler → 出站编码 → flush 写入 Socket
- `option()` 作用于监听 Channel，`childOption()` 作用于每个客户端连接

> 下一篇：[Channel 与 EventLoop](./4_channel_eventloop) —— 深入连接与线程两个核心抽象，弄清 EventLoop 的线程模型细节。

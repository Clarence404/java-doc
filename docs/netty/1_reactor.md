# Reactor 模型

![Reactor 三种模式对比](../assets/netty/reactor-patterns.svg)

Reactor 模型是**基于 IO 多路复用的事件驱动架构**：Reactor（反应器）负责监听 IO 事件，并把就绪事件**分发**给对应的 Handler 处理。它回答的问题是——多路复用拿到一批就绪事件之后，**用什么线程结构去消费**。

## 一、三种实现模式

### 1、单线程 Reactor

- **结构**：一个线程包揽监听连接、读写数据、执行业务逻辑
- **优点**：无锁、无上下文切换，实现最简单
- **缺点**：任何一个 Handler 耗时（慢业务、大包）都会拖住整个事件循环
- **代表**：Redis 6.0 之前（业务是纯内存操作、足够快，单线程反而是优势）

```java
Selector selector = Selector.open();
while (true) {
    selector.select();                 // 监听所有事件
    for (SelectionKey key : selector.selectedKeys()) {
        if (key.isAcceptable()) accept(); // 处理新连接
        if (key.isReadable())   read();   // 读取数据
        if (key.isWritable())   write();  // 发送数据
    }
}
```

### 2、单 Reactor 多线程

- **结构**：Reactor 线程只负责监听和收发，**业务逻辑丢给线程池**
- **优点**：慢业务不再阻塞事件循环
- **缺点**：单个 Reactor 既管 accept 又管所有连接的读写，连接量大时它自己成为瓶颈

### 3、主从 Reactor（Netty 采用）

- **结构**：**主 Reactor**（Boss）只负责 `accept` 新连接，把建立好的连接分配给**从 Reactor 组**（Worker）；每个从 Reactor 独立事件循环，负责自己名下连接的读写
- **优点**：连接接入和 IO 处理分离，多核并行，支撑十万到百万级连接
- **代表**：Netty、Kafka 网络层（Acceptor + Processor 线程组）

```java
EventLoopGroup bossGroup   = new NioEventLoopGroup(1); // 主 Reactor：接受连接
EventLoopGroup workerGroup = new NioEventLoopGroup();  // 从 Reactor 组：处理读写
ServerBootstrap bootstrap = new ServerBootstrap()
    .group(bossGroup, workerGroup)
    .channel(NioServerSocketChannel.class)
    .childHandler(new ChannelInitializer<>() {
        protected void initChannel(SocketChannel ch) {
            ch.pipeline().addLast(new MyHandler()); // 添加业务处理器
        }
    });
```

## 二、IO 模型与 Reactor 的关系

| 层次 | 回答的问题 | 概念 |
|------|-----------|------|
| IO 模型（操作系统层）| 一次 IO 怎么等、怎么拿数据 | 阻塞/非阻塞、同步/异步、epoll |
| Reactor（应用架构层）| 一批就绪事件用什么线程结构消费 | 单线程 / 多线程 / 主从 |

| 方案 | 底层 IO | 线程结构 |
|------|---------|---------|
| BIO 服务器 | 阻塞 IO | 每连接一线程 |
| Redis（6.0 前）| epoll 多路复用 | 单线程 Reactor |
| Tomcat NIO | 多路复用 | 单 Reactor（Poller）+ 业务线程池 |
| **Netty** | 多路复用（NIO / native epoll）| **主从 Reactor** |
| AIO 服务器 | 异步 IO | Proactor 模式（Java 中极少用）|

> Reactor 的对偶概念是 **Proactor**：Reactor 在"就绪时"通知你自己读，Proactor 在"读完后"把数据交给你——分别对应同步多路复用与异步 IO。

## 三、EventLoop 与 Channel 绑定

- **EventLoop 本质**：单线程 + 任务队列，负责处理 Channel 的所有 I/O 事件和定时任务
- **绑定规则**：Channel 注册时永久绑定到一个 EventLoop（一个 EventLoop 可服务多个 Channel）
- **为什么不能切换 EventLoop**：保证 Channel 内所有操作串行执行，无需加锁；切换会引入竞态条件
- **NioEventLoopGroup 默认线程数** = CPU 核心数 × 2

```java
channel.eventLoop().execute(() -> {
    // 从其他线程提交任务，仍在该 Channel 的 EventLoop 线程中执行
});
```

> **实战守则**：EventLoop 线程里绝不能做阻塞操作（同步 DB 查询、RPC 调用、`Thread.sleep`）——它名下所有 Channel 都会被卡住。慢逻辑丢业务线程池，结果再 `execute` 切回来。

## 四、总结

- IO 模型解决"**怎么等数据**"，Reactor 解决"**事件就绪后谁来干活**"，两者是上下层关系
- 单线程 → 多线程 → 主从，演进方向就是把"接连接、搬数据、算业务"三件事逐步拆给不同线程
- Netty = 主从 Reactor + epoll 多路复用 + Pipeline 责任链，详见 [Netty 概述](./2_netty_desc)

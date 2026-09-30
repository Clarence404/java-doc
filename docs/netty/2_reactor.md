# Reactor 模型

> **本篇目标**：能画出三种 Reactor 模式的线程结构，说清 Netty 的 BossGroup / WorkerGroup 分别对应什么，以及 Reactor 与 Proactor 的区别。
>
> **前置阅读**：[IO 模型](./1_io_model)

## 一、为什么需要 Reactor

**多路复用只解决了"等"的问题，没有规定"谁来干活"**。`epoll_wait` 返回一批就绪事件后，还要有人去 accept 新连接、读数据、解码、执行业务、写回响应，这些工作怎么分配给线程，就是 Reactor 模型要回答的问题。

Reactor（反应器）是一种事件驱动的设计模式，核心角色只有两个：

| 角色 | 职责 |
|------|------|
| Reactor | 运行事件循环：调用多路复用等待事件，把就绪事件**分发**出去 |
| Handler | 处理具体事件：Acceptor 处理连接事件，其他 Handler 处理读写与业务 |

按"Reactor 有几个、业务在哪个线程执行"，演化出三种经典模式（Doug Lea 在《Scalable IO in Java》中系统总结过）。

## 二、三种实现模式

![Reactor 三种模式对比](../assets/netty/reactor-patterns.svg)

演进方向很明确：把"**接连接、搬数据、算业务**"三件事逐步拆给不同的线程。

### 1、单 Reactor 单线程

- **结构**：一个线程完成全部工作：监听事件、accept、读写、业务处理
- **优点**：没有锁、没有线程切换，实现最简单
- **缺点**：只能用一个 CPU 核；任何一个 Handler 变慢（慢业务、大包编解码）都会拖住所有连接
- **代表**：Redis 6.0 之前。命令都是内存操作、执行很快，单线程反而省去了并发控制

```java
Selector selector = Selector.open();
while (true) {
    selector.select();                               // 等待事件
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();
        if (key.isAcceptable()) accept(key);         // 新连接
        else if (key.isReadable()) read(key);        // 读数据 + 执行业务
        else if (key.isWritable()) write(key);       // 发送数据
    }
}
```

### 2、单 Reactor 多线程

- **结构**：Reactor 线程负责监听、accept 和读写，**解码后的业务逻辑交给线程池**
- **优点**：慢业务不再阻塞事件循环，可以利用多核执行业务
- **缺点**：所有连接的 accept 和读写仍集中在一个 Reactor 线程，连接数和流量上来后它本身成为瓶颈；业务线程写回结果时要交还给 Reactor，处理更复杂

```java
ExecutorService bizPool = Executors.newFixedThreadPool(16);

void read(SelectionKey key) throws IOException {
    SocketChannel ch = (SocketChannel) key.channel();
    ByteBuffer buf = ByteBuffer.allocate(1024);
    if (ch.read(buf) > 0) {                          // IO 仍在 Reactor 线程
        buf.flip();
        bizPool.execute(() -> {
            byte[] resp = handle(buf);               // 业务在线程池执行
            // 写回：放入待写队列并 selector.wakeup()，由 Reactor 线程完成发送
        });
    }
}
```

### 3、主从 Reactor 多线程（Netty 采用）

- **结构**：**主 Reactor** 只负责 accept 新连接，把建立好的连接分配给某个**从 Reactor**；每个从 Reactor 有独立的事件循环，负责自己名下连接的读写；需要时再配一个业务线程池
- **优点**：连接接入与 IO 处理分离；从 Reactor 数量可按 CPU 核数扩展，IO 处理能力随核数线性增长
- **缺点**：结构最复杂，但这些复杂度可以由框架封装
- **代表**：Netty、Memcached、Kafka 网络层（Acceptor + Processor 线程组）

### 4、三种模式对比

| 对比项 | 单 Reactor 单线程 | 单 Reactor 多线程 | 主从 Reactor 多线程 |
|--------|------------------|------------------|--------------------|
| accept | Reactor 线程 | Reactor 线程 | 主 Reactor |
| 读写 IO | Reactor 线程 | Reactor 线程 | 从 Reactor 组 |
| 业务逻辑 | Reactor 线程 | 业务线程池 | 从 Reactor 或业务线程池 |
| 多核利用 | 否 | 仅业务部分 | 是 |
| 瓶颈 | 单线程整体 | 单个 Reactor 的 IO | 基本无单点瓶颈 |
| 典型代表 | Redis（6.0 前）| Tomcat NIO（近似）| Netty、Memcached |

## 三、Netty 中的主从 Reactor

**Netty 用两个 EventLoopGroup 实现主从 Reactor**：BossGroup 是主 Reactor，WorkerGroup 是从 Reactor 组，每个 Channel 上的 ChannelPipeline 就是事件分发后的 Handler 链。

| Reactor 概念 | Netty 中的实现 |
|-------------|---------------|
| 主 Reactor | `bossGroup` 中的 `EventLoop`，监听 `NioServerSocketChannel` 的 accept 事件 |
| Acceptor | `ServerBootstrapAcceptor`，把新连接注册到 `workerGroup` 的某个 `EventLoop` |
| 从 Reactor 组 | `workerGroup`，每个 `EventLoop` 负责一批 `NioSocketChannel` 的读写 |
| Handler | 每个连接的 `ChannelPipeline` 上的 `ChannelHandler` 链 |
| 业务线程池（可选）| 自定义线程池，或 `pipeline.addLast(EventExecutorGroup, ...)` |

```java
EventLoopGroup bossGroup   = new NioEventLoopGroup(1);  // 主 Reactor：只负责 accept
EventLoopGroup workerGroup = new NioEventLoopGroup();   // 从 Reactor 组：负责读写
EventExecutorGroup bizGroup = new DefaultEventExecutorGroup(16); // 业务线程池（可选）

ServerBootstrap bootstrap = new ServerBootstrap()
        .group(bossGroup, workerGroup)
        .channel(NioServerSocketChannel.class)
        .childHandler(new ChannelInitializer<SocketChannel>() {
            @Override
            protected void initChannel(SocketChannel ch) {
                ch.pipeline()
                  .addLast(new MyDecoder())                   // 在 worker EventLoop 执行
                  .addLast(bizGroup, "biz", new BizHandler()); // 在 bizGroup 线程执行
            }
        });
```

::: tip bossGroup 为什么通常只配 1 个线程
一个 `ServerSocketChannel` 只会注册到 bossGroup 中的一个 `EventLoop` 上，只监听一个端口时多配线程也不会被用到。只有同时 bind 多个端口时，bossGroup 多线程才有意义。
:::

## 四、EventLoop：Reactor 在 Netty 中的落地

每个从 Reactor 在 Netty 里就是一个 `EventLoop`（事件循环）。先记住两条结论，细节在 [核心组件深入](./4_core_components) 展开：

- **EventLoop = 单线程 + 任务队列**：一个线程循环执行"等待 IO 事件 → 处理 IO 事件 → 执行队列中的任务"
- **Channel 终身绑定一个 EventLoop**：同一连接上的所有事件都在同一线程串行处理，Handler 内部无需加锁

::: warning EventLoop 线程绝不能阻塞
一个 EventLoop 同时服务成百上千个 Channel。在 Handler 里做同步 DB 查询、同步 RPC、`Thread.sleep`、大量计算，会让该 EventLoop 名下所有连接一起卡住。慢逻辑要交给业务线程池，结果通过 `ctx.writeAndFlush()` 写回即可（非 EventLoop 线程调用时，Netty 会自动把写操作提交回 EventLoop 执行）。
:::

## 五、Reactor 与 Proactor

**Reactor 在"数据就绪"时通知你自己去读，Proactor 在"数据读完"后把结果交给你**。两者分别建立在同步多路复用和异步 IO 之上。

| 对比项 | Reactor | Proactor |
|--------|---------|----------|
| 底层 IO | 同步 IO 多路复用（epoll / kqueue）| 异步 IO（IOCP、io_uring）|
| 通知时机 | 事件就绪，可以读写了 | 读写已完成 |
| 数据拷贝 | 应用线程调用 `read` 完成 | 内核完成 |
| 编程复杂度 | 较低 | 较高，需要管理异步完成回调与缓冲区生命周期 |
| 典型实现 | Netty、Redis、Nginx | Windows IOCP、Java AIO |

Linux 长期缺少成熟的网络异步 IO，所以 Linux 上的高性能网络框架几乎都是 Reactor。

## 六、IO 模型与 Reactor 的关系

**IO 模型解决"怎么等数据"，Reactor 解决"事件就绪后谁来干活"**，两者是上下层关系，组合起来才是一个服务器的完整线程模型。

| 层次 | 回答的问题 | 典型选项 |
|------|-----------|---------|
| IO 模型（操作系统层）| 一次 IO 怎么等、数据怎么到用户空间 | 阻塞 / 非阻塞、多路复用、异步 IO |
| Reactor（应用架构层）| 就绪事件由什么线程结构消费 | 单线程 / 多线程 / 主从 |

**常见系统的线程模型**：

| 系统 | 底层 IO | 线程结构 |
|------|---------|---------|
| 传统 BIO 服务器 | 阻塞 IO | 每连接一线程 |
| Redis（6.0 前）| epoll 多路复用 | 单 Reactor 单线程 |
| Redis（6.0+）| epoll 多路复用 | 可选多线程 IO，命令执行仍是单线程 |
| Nginx | epoll 多路复用 | 多个 worker 进程，每个进程一个事件循环 |
| Tomcat NIO | 多路复用 | Acceptor 线程 + Poller（Selector）+ 业务线程池 |
| Kafka Broker | 多路复用 | Acceptor + Processor 线程组 + 请求处理线程池 |
| **Netty** | 多路复用（JDK NIO / 原生 epoll）| **主从 Reactor** |
| Java AIO 服务器 | 异步 IO | Proactor |

## 小结

- 多路复用只提供就绪事件，Reactor 决定用什么线程结构去消费这些事件
- 三种模式的演进，就是把"接连接、搬数据、算业务"逐步拆给不同线程
- Netty 采用主从 Reactor：bossGroup 负责 accept，workerGroup 负责读写，Pipeline 负责事件处理
- EventLoop 是单线程 + 任务队列，Channel 终身绑定一个 EventLoop，所以 EventLoop 线程绝不能阻塞
- Reactor 建立在同步多路复用之上，Proactor 建立在异步 IO 之上

> 下一篇：[Netty 入门](./3_netty_desc) —— 看 Netty 如何把主从 Reactor 封装成几十行就能跑起来的服务端。

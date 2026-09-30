# 开发总结-Netty

> 精华提炼，细节详见 [Netty 总览](/netty/0_overview)

## 一、IO 模型

### 1、一次网络读分哪两个阶段？五种 IO 模型区别在哪？

**核心结论**：一次 `read` 分为**等待数据就绪**（数据到达内核 Socket 缓冲区）和**数据拷贝**（内核 → 用户空间）两个阶段；五种模型的区别只在于这两个阶段里应用线程在干什么。

| 模型 | 阶段一：等待就绪 | 阶段二：拷贝 | 分类 |
|------|:---:|:---:|------|
| 阻塞 IO | 阻塞 | 阻塞 | 同步阻塞 |
| 非阻塞 IO | 不阻塞（应用轮询）| 阻塞 | 同步非阻塞 |
| IO 多路复用 | 阻塞在 select / epoll_wait（一次等一批）| 阻塞 | 同步非阻塞 |
| 信号驱动 IO | 不阻塞（SIGIO 通知）| 阻塞 | 同步 |
| 异步 IO | 不阻塞 | **内核完成** | 异步 |

- 阻塞 / 非阻塞看阶段一（没数据时线程是否挂起）；同步 / 异步看阶段二（拷贝由谁完成）
- 前四种阶段二都由应用线程完成，都是同步 IO，只有 AIO 是真正的异步

→ 详见 [IO 模型](/netty/1_io_model)

### 2、BIO、NIO、AIO 的区别？为什么说 Java NIO 是"同步非阻塞"？

**核心结论**：BIO 一连接一线程、全程阻塞；NIO 用非阻塞 Channel + Selector 多路复用，一个线程照看多个连接；AIO 由内核完成两个阶段后回调。NIO 的数据仍由应用线程调用 `read` 拷贝，所以是"同步非阻塞"。

| 模型 | 线程模型 | 特点 | 现状 |
|------|---------|------|------|
| BIO | 一连接一线程 | 写法简单；线程大部分时间空等，每线程栈约 1MB，扛不住 C10K | 连接数少的场景 |
| NIO | 一个线程 + Selector 管多个连接 | 线程数不随连接数增长 | Netty、主流框架的基础 |
| AIO | 发起请求立即返回，完成后 `CompletionHandler` 回调 | Windows 基于 IOCP 是真异步；Linux 上是 epoll + 线程池模拟，无性能优势 | 很少使用，Netty 也未采用 |

- "非阻塞"：Channel 可 `configureBlocking(false)`，无数据时 `read` 立即返回 0
- "同步"：Selector 只告诉你"可以读了"，拷贝仍要应用线程自己做
- NIO 通常解读为 New IO，核心是非阻塞与多路复用，而不是异步

→ 详见 [IO 模型](/netty/1_io_model)

### 3、select、poll、epoll 的区别？epoll 为什么高效？

**核心结论**：select / poll 每次调用都要把全量 fd 集合拷进内核并线性扫描；epoll 把"注册"（`epoll_ctl`）和"等待"（`epoll_wait`）拆开，靠红黑树 + 就绪链表只处理就绪的 fd，等待开销与连接总数无关。

| 对比项 | select | poll | epoll |
|--------|--------|------|-------|
| fd 存储 | 固定位图 `fd_set` | `pollfd` 数组 | 内核红黑树 + 就绪链表 |
| fd 上限 | 默认 1024（`FD_SETSIZE`）| 无硬上限 | 无硬上限 |
| 每次调用传参 | 全量拷贝到内核 | 同 select | 无需重复传，注册一次即可 |
| 发现就绪 | 线性扫描 O(n) | O(n) | 数据到达时回调把 fd 放入就绪链表 |
| 返回结果 | 应用再遍历全部 fd | 同 select | 只返回就绪 fd |
| 触发模式 | 仅 LT | 仅 LT | LT（默认）/ ET |

- **epoll 快的原因**：红黑树增删改 O(log n) 且只在建连 / 断连时调用；内核回调维护就绪链表；`epoll_wait` 只需取就绪项
- 连接越多、活跃比例越低（IM、推送等长连接），epoll 优势越明显；Java NIO 的 `Selector` 在 Linux 上默认就是 epoll

→ 详见 [IO 模型](/netty/1_io_model)

### 4、epoll 的 LT 和 ET 有什么区别？Netty 用哪种？

**核心结论**：LT（水平触发）只要缓冲区还有未读数据就一直通知；ET（边缘触发）只在"无数据 → 有新数据"时通知一次，必须循环读到 `EAGAIN`。Netty 默认 NIO 传输是 LT，原生 epoll 传输是 ET。

| 对比项 | LT（默认）| ET |
|--------|----------|----|
| 触发时机 | 有未读数据就每次返回 | 状态变化时通知一次 |
| 读取要求 | 可分多次读 | 必须一次读到 `EAGAIN` |
| 漏读风险 | 低 | 高 |
| 系统调用次数 | 较多 | 较少 |
| 典型使用 | JDK NIO | Nginx、Netty 原生 epoll |

- `NioEventLoopGroup`（基于 JDK `Selector`）→ LT
- `EpollEventLoopGroup`（`netty-transport-native-epoll`）→ ET，这是原生传输吞吐更高的原因之一

→ 详见 [IO 模型](/netty/1_io_model)

## 二、Reactor 模型

### 5、Reactor 有哪三种模式？各有什么优缺点？

**核心结论**：按"Reactor 有几个、业务在哪个线程执行"分为单 Reactor 单线程、单 Reactor 多线程、主从 Reactor 多线程，演进方向是把"接连接、搬数据、算业务"逐步拆给不同线程。

| 模式 | accept / 读写 / 业务 | 优点 | 缺点 | 代表 |
|------|---------------------|------|------|------|
| 单 Reactor 单线程 | 全部在一个线程 | 无锁、无切换、最简单 | 只用一个核；任一 Handler 变慢拖住所有连接 | Redis（6.0 前）|
| 单 Reactor 多线程 | Reactor 线程做 accept + 读写，业务进线程池 | 慢业务不阻塞事件循环 | 单 Reactor 的 IO 成为瓶颈；写回要交还 Reactor | Tomcat NIO（近似）|
| 主从 Reactor 多线程 | 主 Reactor 只 accept，从 Reactor 组负责读写，业务可再进线程池 | 接入与 IO 分离，IO 能力随核数扩展 | 结构最复杂（由框架封装）| Netty、Memcached、Kafka 网络层 |

→ 详见 [Reactor 模型](/netty/2_reactor)

### 6、Netty 用哪种 Reactor？BossGroup 和 WorkerGroup 各做什么？

**核心结论**：Netty 用两个 `EventLoopGroup` 实现**主从 Reactor**：BossGroup 是主 Reactor，只负责 accept；WorkerGroup 是从 Reactor 组，负责已建立连接的读写与 Pipeline 处理。

| Reactor 概念 | Netty 实现 |
|-------------|-----------|
| 主 Reactor | `bossGroup` 的 `EventLoop`，监听 `NioServerSocketChannel` 的 accept 事件 |
| Acceptor | `ServerBootstrapAcceptor`，把新连接注册到 `workerGroup` 的某个 `EventLoop` |
| 从 Reactor 组 | `workerGroup`，每个 `EventLoop` 负责一批 `NioSocketChannel` 的读写 |
| Handler | 每个连接 `ChannelPipeline` 上的 Handler 链 |
| 业务线程池（可选）| 自定义线程池或 `addLast(EventExecutorGroup, handler)` |

- **bossGroup 通常配 1 个线程**：一个 `ServerSocketChannel` 只注册到一个 EventLoop，只监听一个端口时多配也用不上
- **workerGroup 默认 CPU 核数 × 2**

→ 详见 [Reactor 模型](/netty/2_reactor)

### 7、Reactor 和 Proactor 有什么区别？

**核心结论**：Reactor 在"数据就绪"时通知应用自己去读，Proactor 在"数据读完"后把结果交给应用；前者基于同步多路复用，后者基于异步 IO。

| 对比项 | Reactor | Proactor |
|--------|---------|----------|
| 底层 IO | epoll / kqueue 多路复用 | IOCP、io_uring |
| 通知时机 | 可以读写了 | 读写已完成 |
| 数据拷贝 | 应用线程 `read` | 内核完成 |
| 编程复杂度 | 较低 | 较高（管理完成回调与缓冲区生命周期）|
| 典型实现 | Netty、Redis、Nginx | Windows IOCP、Java AIO |

Linux 长期缺少成熟的网络异步 IO，所以 Linux 上的高性能网络框架几乎都是 Reactor。

→ 详见 [Reactor 模型](/netty/2_reactor)

## 三、Netty 入门与核心组件

### 8、原生 JDK NIO 有哪些问题？Netty 如何解决？

**核心结论**：JDK NIO 只提供多路复用的原始能力，线程模型、拆包、连接管理、协议都要自己搭，还有 epoll 空轮询 bug；Netty 把这些都封装好了。

| JDK NIO 痛点 | Netty 解决方式 |
|-------------|---------------|
| API 繁琐，`ByteBuffer` 要 `flip()`，易读写错位 | `Channel` / `ChannelHandler` 高层抽象；`ByteBuf` 读写双指针 |
| 半包、粘包要自己处理 | 内置 `LineBasedFrameDecoder`、`LengthFieldBasedFrameDecoder` 等 |
| 心跳、重连、空闲连接清理要自己实现 | `IdleStateHandler` + 监听器重连 |
| epoll 空轮询 bug：`select()` 无事件时反复立即返回，CPU 100% | 统计连续提前返回次数，超过阈值（默认 512）重建 `Selector` |
| 线程模型自己设计，多线程读写同一连接易出并发问题 | 内置主从 Reactor；Channel 绑定单个 EventLoop，串行执行 |
| 异常处理、资源释放分散，易泄漏 | 异常沿 Pipeline 统一处理；`ByteBuf` 引用计数 + 泄漏检测 |
| HTTP、WebSocket、SSL 要从零实现 | 提供现成编解码器 |

::: tip Netty 的"异步"
指编程接口：`bind` / `connect` / `write` 立即返回 `ChannelFuture`；底层 IO 仍是同步非阻塞 + 多路复用。
:::

→ 详见 [Netty 入门](/netty/3_netty_desc)

### 9、Netty 的核心组件有哪些？一次请求如何流动？

**核心结论**：Channel 是连接，EventLoop 是干活的线程，Pipeline 是处理流水线，Handler 是流水线上的工位；另有 `ChannelFuture`（异步结果）、`ByteBuf`（字节容器）、`Bootstrap`（引导类）。

| 组件 | 作用 |
|------|------|
| `Channel` | 连接的抽象，统一 `read / write / bind / connect / close` |
| `EventLoop` / `EventLoopGroup` | 单线程事件循环，服务若干 Channel；Group 是一组 EventLoop |
| `ChannelFuture` | IO 操作的异步结果，用 `addListener` 获取 |
| `ChannelPipeline` | 每个 Channel 一条，由 `ChannelHandlerContext` 组成的双向链表 |
| `ChannelHandler` / `ChannelHandlerContext` | 处理事件 / 表示 Handler 在 Pipeline 中的位置、用于传播事件 |
| `ByteBuf` | 读写双指针、可扩容、支持池化与堆外内存 |
| `ServerBootstrap` / `Bootstrap` | 组装线程组、Channel 类型、参数、Handler 并启动 |

**请求流动**：

1. boss EventLoop 监听到 accept，得到新的 `NioSocketChannel`
2. `ServerBootstrapAcceptor` 设置 `childOption`、添加 `childHandler`，注册到 worker 中某个 EventLoop（此后终身绑定）
3. `ChannelInitializer.initChannel()` 装配 Pipeline 后自动移除
4. 数据到达，worker 读入 `ByteBuf`，`pipeline.fireChannelRead()`
5. 入站 Head → Tail：帧解码 → 协议解码 → 业务 Handler
6. `ctx.writeAndFlush()` 出站向 Head 方向经过编码器
7. `write` 进入 `ChannelOutboundBuffer`，`flush` 写入 Socket；Socket 写满时注册写事件等待可写

→ 详见 [Netty 入门](/netty/3_netty_desc)、[核心组件](/netty/4_core_components)

### 10、EventLoop 的工作机制？为什么 Channel 要绑定固定的 EventLoop？

**核心结论**：一个 EventLoop = 一个线程 + 一个 Selector + 任务队列，死循环里轮流处理 IO 事件和任务；Channel 终身绑定一个 EventLoop，换来**串行无锁**和**消息有序**。

- **事件循环三步**：`select` 等待就绪 → `processSelectedKeys` 处理 IO 事件驱动 Pipeline → `runAllTasks` 执行普通任务和到期定时任务；两者时间配比由 `ioRatio` 控制，默认 50
- **分配策略**：注册时由 `EventExecutorChooser` 轮询分配（线程数是 2 的幂用 `idx & (n - 1)`，否则取模）
- **绑定的收益**：同一 Channel 的 Handler 不会被并发调用，内部状态无需加锁；读按到达顺序处理，写按调用顺序发出；也没有线程切换
- **代价**：一个 EventLoop 服务多个 Channel，任何阻塞都拖慢它名下所有连接
- **外部线程操作 Channel**：`inEventLoop()` 判断，不在则 `execute()` 投递；`write` / `writeAndFlush` 内部已做此判断，任意线程调用都安全

→ 详见 [核心组件](/netty/4_core_components)

### 11、Pipeline 中入站 / 出站事件的传播方向？`ctx.write()` 和 `channel.write()` 的区别？

**核心结论**：入站事件 Head → Tail，出站操作 Tail → Head，且只经过对应类型的 Handler；`ctx.write()` 从**当前 Handler** 向 Head 方向传播，`channel.write()` 从 **Tail** 开始走完整条出站链。

| 调用 | 起点 | 经过的出站 Handler |
|------|------|------------------|
| `ctx.write(msg)` | 当前 Handler 位置 | 只有排在当前 Handler 之前的出站 Handler |
| `ctx.channel().write(msg)` / `ctx.pipeline().write(msg)` | Tail | 全部出站 Handler |

- 业务 Handler 排在编码器前面时，`ctx.write()` 会跳过编码器，发出未编码对象 → **编解码器放前面，业务 Handler 放最后**
- 入站传播不是自动的：覆写 `channelRead` 后必须 `ctx.fireChannelRead(msg)`，否则后面的 Handler 收不到
- 异常沿入站方向传播，链尾没人处理只打一条警告、不关连接 → 链尾放统一异常处理 Handler
- 出站 `write` 失败不触发 `exceptionCaught`，只标记在 `ChannelFuture` 上

→ 详见 [核心组件](/netty/4_core_components)

### 12、什么样的 Handler 可以加 `@Sharable`？

**核心结论**：只有**无状态**（不持有连接相关成员变量）且线程安全的 Handler 才能加 `@Sharable` 在多个 Channel 间共享；`@Sharable` 只是声明，Netty 不保证线程安全。

| Handler 类型 | 能否共享 | 做法 |
|-------------|---------|------|
| 无状态（编码器、统一异常处理、无状态业务分发）| 可以 | 标注 `@Sharable`，定义为单例 |
| 有状态（成员变量记录连接数据）| 不可以 | `initChannel()` 中每次 `new` |
| `ByteToMessageDecoder` 子类（各种 FrameDecoder）、`IdleStateHandler` | 禁止 | 内部有累积缓冲区 / 计时状态，每连接 `new` |

- 未标注却被重复添加 → `ChannelPipelineException`（"is not a @Sharable handler"）
- 共享实例会被多个 EventLoop 线程并发调用；连接级数据放 Channel 的 `AttributeKey`

→ 详见 [核心组件](/netty/4_core_components)

### 13、为什么不能在 EventLoop 线程里阻塞？业务逻辑放在哪执行？

**核心结论**：一个 EventLoop 同时服务成百上千个 Channel，同步查库、同步 RPC、`sleep`、重计算会让它名下所有连接一起卡住；慢逻辑要交给业务线程池，结果用 `ctx.writeAndFlush()` 写回（Netty 自动投递回 EventLoop）。

| 维度 | 方式一：`addLast(eventExecutorGroup, handler)` | 方式二：Handler 内提交到自有线程池 |
|------|------|------|
| 同连接消息顺序 | 保证（每个 Channel 固定一个线程）| 不保证 |
| 负载均衡 | 慢连接会拖住同线程其他连接 | 任务级调度，更均衡 |
| 背压 / 拒绝策略 | 能力有限 | 有界队列 + 拒绝策略可精细控制 |
| 改造成本 | 一行代码 | 需处理线程切换和资源释放 |
| 适合 | 有序性要求高（IoT 指令）| 请求相互独立（RPC、HTTP）|

::: warning
Handler 中不要 `future.sync()` / `await()`：等于让线程等自己，Netty 会抛 `BlockingOperationException`，一律改用 `addListener`。交给业务线程的若是 `ByteBuf`，要先 `retain()` 并在业务线程释放。
:::

→ 详见 [核心组件](/netty/4_core_components)

## 四、ByteBuf 与内存

### 14、ByteBuf 相比 NIO ByteBuffer 有哪些优势？

**核心结论**：ByteBuf 用读写双指针替代 `flip()`，支持自动扩容、池化、引用计数和组合 / 切片，既好用又高效。

| 特性 | `ByteBuffer` | `ByteBuf` |
|------|-------------|-----------|
| 读写切换 | 共用 position，要 `flip()` | `readerIndex` / `writerIndex` 双指针 |
| 容量 | 固定 | 自动扩容（4MB 内翻倍，之后按 4MB 步长）|
| 内存复用 | 无池化 | `PooledByteBufAllocator` 池化 |
| 生命周期 | 依赖 GC | 引用计数，用完立即归还 |
| 组合与切片 | 能力有限 | `CompositeByteBuf`、`slice`、`wrappedBuffer` 减少拷贝 |

- 三个区域：可丢弃 `[0, readerIndex)`、可读 `[readerIndex, writerIndex)`、可写 `[writerIndex, capacity)`
- `read*` / `write*` 移动指针，`get*` / `set*` 不移动；`slice` / `duplicate` 共享内存，`copy` 才复制

→ 详见 [ByteBuf 与内存管理](/netty/5_bytebuf)

### 15、ByteBuf 的引用计数是怎么回事？什么时候需要手动 `release`？

**核心结论**：池化内存不能等 GC 回收，所以用引用计数显式管理：分配后 `refCnt=1`，`retain()` +1，`release()` -1，归零即回收；原则是**谁最后使用，谁负责释放**。

| 场景 | 是否要释放 |
|------|-----------|
| 入站：继承 `ChannelInboundHandlerAdapter` 且消息在这里被消费 | **要**，`finally { ReferenceCountUtil.release(msg) }` |
| 入站：`fireChannelRead(msg)` 传给下一个 Handler | 不要，所有权已转移 |
| 入站：继承 `SimpleChannelInboundHandler` | 不要，`channelRead0` 返回后自动释放 |
| 出站：交给 `write` / `writeAndFlush` | 不要，Netty 写出或失败后释放；再释放会 `IllegalReferenceCountException` |
| 同一 ByteBuf 发给多个 Channel | 每次 `retainedDuplicate()`，最后释放自己那一份（或用 `ChannelGroup`）|
| 使用 `retain()` / `retainedSlice()`，或把消息交给其他线程 | 要配对 `release()` |
| 写前检查不可写而放弃发送 | 要自行释放 |

- 计数为 0 后再访问抛 `IllegalReferenceCountException`
- `SimpleChannelInboundHandler` 自动释放，不要把 msg 保存或交给其他线程，确需时先 `retain()`

→ 详见 [ByteBuf 与内存管理](/netty/5_bytebuf)

### 16、如何排查 Netty 的内存泄漏？

**核心结论**：用 `ResourceLeakDetector`：ByteBuf 被 GC 时计数未归零就打印 `LEAK:` 日志；测试环境开 `PARANOID`，按日志中最后一次访问记录定位 Handler，并结合直接内存监控。

| 级别 | 采样 | 适用 |
|------|------|------|
| `SIMPLE`（默认）| 抽样，只报有泄漏及创建位置 | 生产 |
| `ADVANCED` | 抽样，额外记录最近访问位置 | 线上排查 |
| `PARANOID` | 每次分配都检测 | 单元测试、CI |

排查步骤：

1. `-Dio.netty.leakDetection.level=paranoid` 复现
2. 从 `Recent access records` 的 `#1` 找到自己的类，检查它是否既没释放也没向后传递
3. 常见原因：Adapter 消费后未释放、提前 `return` 分支漏释放、异步处理异常路径漏释放、`retain` 未配对
4. 监控 `PooledByteBufAllocatorMetric.usedDirectMemory()`：只涨不跌即泄漏或写缓冲积压

→ 详见 [ByteBuf 与内存管理](/netty/5_bytebuf)、[生产实践与调优](/netty/11_production)

### 17、Netty 的零拷贝体现在哪？和操作系统零拷贝有什么区别？

**核心结论**：分两层。OS 层是真零拷贝：`FileRegion` 底层 `transferTo` → `sendfile`，数据从页缓存直达 Socket，不经用户态；Netty 用户态是"少拷贝"：避免 JVM 内多余的内存复制。

| 层面 | 手段 | 作用 |
|------|------|------|
| 操作系统 | `DefaultFileRegion`（sendfile）| 文件发送不经用户态 |
| Netty 用户态 | `CompositeByteBuf` | 协议头 + 体逻辑拼接，不复制 |
| Netty 用户态 | `Unpooled.wrappedBuffer` | 包装已有 `byte[]` / ByteBuf，不复制 |
| Netty 用户态 | `slice` / `readSlice` | 切视图，不复制 |
| 直接内存 | IO 默认用 Direct ByteBuf | 省掉堆内存到堆外的一次中转拷贝 |

::: warning
启用 TLS（`SslHandler`）后数据必须在用户态加密，无法用 `FileRegion`，改用 `ChunkedWriteHandler` + `ChunkedFile`。
:::

→ 详见 [ByteBuf 与内存管理](/netty/5_bytebuf)

## 五、粘包拆包与协议设计

### 18、什么是 TCP 粘包 / 拆包？原因是什么？为什么 UDP 没有？

**核心结论**：TCP 是字节流，只保证有序可靠、不保证消息边界。粘包是多条消息被一次读到，拆包是一条消息被分多次读到，实际中常同时发生；UDP 面向数据报，每个数据报天然有边界。

| 成因 | 位置 |
|------|------|
| Nagle 算法合并小包 | 发送端 |
| 发送缓冲区 `SO_SNDBUF` 多次 write 连成一片 | 发送端 |
| MSS / MTU 限制切分 | 传输层 / 网络层 |
| 接收缓冲区 `SO_RCVBUF` 累积，读取不及时 | 接收端 |
| 每次 read 只取缓冲区现有内容，与 write 次数无关 | 接收端 |

- 关掉 Nagle（`TCP_NODELAY`，Netty 默认已开）也解决不了，**唯一可靠的办法是在应用层定义消息边界**：定长、分隔符、长度字段（主流）

→ 详见 [粘包与拆包](/netty/6_stick_split)

### 19、Netty 有哪些解决粘包拆包的解码器？`ByteToMessageDecoder` 如何处理半包？

**核心结论**：内置四种帧解码器，放在 Pipeline 最前面；它们都继承 `ByteToMessageDecoder`，靠**累积缓冲区 + 循环解码**处理半包：数据不够一帧就原样留着，等下次数据到达再拼。

| 解码器 | 方案 |
|--------|------|
| `FixedLengthFrameDecoder` | 定长 |
| `DelimiterBasedFrameDecoder` | 自定义分隔符 |
| `LineBasedFrameDecoder` | 按行（`\n` / `\r\n`）|
| `LengthFieldBasedFrameDecoder` | 长度字段（二进制协议首选）|

**`ByteToMessageDecoder` 流程**：

1. 新数据追加到累积缓冲区 cumulation（默认 `MERGE_CUMULATOR` 复制合并，可选 `COMPOSITE_CUMULATOR`）
2. 只要有可读字节就循环调用子类 `decode`：够一帧就读出放入 `out`；不够就不读任何字节直接返回，循环结束
3. 把 `out` 中的帧依次 `fireChannelRead`
4. 缓冲区读完即释放，有残留则保留

- 自写 `decode` 约定：数据不够时不能读字节（或 `mark` / `reset` 回退）；产出消息却没读字节会抛 `DecoderException`
- `maxFrameLength` 是安全防线，超限抛 `TooLongFrameException`，应直接关连接；发送端用 `LengthFieldPrepender` 配套

→ 详见 [粘包与拆包](/netty/6_stick_split)

### 20、`LengthFieldBasedFrameDecoder` 的五个参数如何配置？

**核心结论**：五个参数描述长度字段在哪、多长、值代表什么、拆出后是否去掉帧头；核心公式：**整帧长度 = lengthFieldOffset + lengthFieldLength + Length 值 + lengthAdjustment**。

| 参数 | 含义 |
|------|------|
| `maxFrameLength` | 单帧最大字节数（按**整帧**含帧头计算）|
| `lengthFieldOffset` | Length 字段距帧起始的偏移 |
| `lengthFieldLength` | Length 字段自身字节数（1 / 2 / 3 / 4 / 8）|
| `lengthAdjustment` | 修正量 = "Length 字段后实际剩余字节数" − "Length 值" |
| `initialBytesToStrip` | 拆出整帧后从头丢弃多少字节（0 = 保留完整帧）|

| 场景 | offset | length | adjustment | strip |
|------|--------|--------|------------|-------|
| Length 在最前，值不含自身，只要消息体 | 0 | 2 | 0 | 2 |
| Length 在最前，值**含**自身 2 字节 | 0 | 2 | -2 | 0 |
| Magic(2) + Ver(1) + Cmd(1) + Length(2)，值仅为 Payload | 4 | 2 | 0 | 0 |
| 同上 + 末尾 CRC(2)，Length 不含 CRC | 4 | 2 | 2 | 0 |
| 同上，Length 值为整帧长度 | 4 | 2 | -6 | 0 |

- 常见错误：`maxFrameLength` 只按 Payload 上限设置，导致最大合法消息被拒；2 字节长度按无符号读，最大 65535

→ 详见 [自定义私有协议](/netty/7_custom_protocol)

### 21、设计私有协议需要哪些字段？一条连接上如何让请求和响应一一对应？

**核心结论**：帧头每个字段都回答"接收方需要知道什么才能安全处理这条消息"，魔数、版本、类型、长度必备，RPC 还需请求 ID 与序列化方式；请求-响应匹配靠帧头里的 `requestId` + 客户端在途 Future 表。

| 字段 | 作用 |
|------|------|
| 魔数（2~4B）| 快速识别是否本协议，不符直接断开 |
| 版本（1B）| 新旧版本并存、按版本解析 |
| 序列化方式（1B）| JSON / Protobuf / Hessian 平滑切换 |
| 消息类型（1B）| 请求 / 响应 / 心跳 / 业务指令 |
| 请求 ID（4~8B）| 响应与请求对应，支撑单连接并发 |
| 状态码（1B）| 响应成功与错误类型 |
| 长度（2~4B）| 帧解码器据此拆包 |
| 消息体 | 业务数据 |
| CRC（可选）| 不可靠链路上校验损坏 |

**请求-响应匹配**：

- 客户端 `AtomicLong` 生成连接内唯一的 `requestId`，登记 `Map<requestId, CompletableFuture>` 后发送
- 服务端原样回写 `requestId`，可并发处理、乱序返回
- 响应 Handler 按 `requestId` 从表中取出 Future 并 `complete`
- 必须有超时清理（否则在途表无限增长）；`channelInactive` 时让所有在途请求快速失败
- `complete` 在 EventLoop 线程执行，调用方回调有慢逻辑要用 `thenApplyAsync(fn, bizExecutor)`

→ 详见 [自定义私有协议](/netty/7_custom_protocol)

## 六、长连接与推送

### 22、有了 TCP keepalive 为什么还要应用层心跳？`IdleStateHandler` 的作用？

**核心结论**：对端宕机、断网、NAT 超时时不会有 FIN / RST 到达，形成**半开连接**；TCP keepalive 默认空闲 2 小时才探测、全局配置、只能确认对端内核在响应，发现不了进程卡死，所以必须用应用层心跳。`IdleStateHandler` 本身不发心跳，只负责空闲计时并抛出 `IdleStateEvent`。

| 维度 | TCP keepalive | 应用层心跳 |
|------|---------------|-----------|
| 探测时机 | Linux 默认空闲 7200s 后 | 自定义，常见 10~60s |
| 检测范围 | 对端内核 | 对端进程在正常处理 |
| 经过代理 | 只到最近一跳 | 端到端 |

- **三个参数**：`readerIdleTime` / `writerIdleTime` / `allIdleTime`，0 表示关闭；到期触发 `READER_IDLE` / `WRITER_IDLE` / `ALL_IDLE`
- **原理**：在所属 EventLoop 上调度定时任务，比较当前时间与最后读 / 写时间，超时则 `fireUserEventTriggered`，不额外建线程
- **位置**：放在业务 Handler 之前、Pipeline 前部；有计时状态，每个 Channel `new` 一个
- **常用方案**：客户端写空闲发 PING，服务端读空闲超时关闭连接；服务端超时 ≈ 客户端心跳间隔 × 3；任何业务消息都算心跳

→ 详见 [心跳与连接管理](/netty/8_heartbeat)

### 23、客户端断线重连应该如何实现？

**核心结论**：在 `connect()` 失败回调和 `channelInactive` 两个时机触发，用 `eventLoop().schedule()` 按**指数退避 + 随机抖动 + 上限**延迟重连，复用同一个 `Bootstrap` 和 `EventLoopGroup`。

| 要点 | 做法 |
|------|------|
| 触发时机 | `connect` 失败 + 已建立连接断开（`channelInactive`）|
| 退避 | 1s、2s、4s… 设上限（如 60s），成功后归零 |
| 抖动 | 叠加随机量，避免服务端重启后客户端同时涌入 |
| 调度 | `eventLoop().schedule(...)`，不阻塞、不建线程 |
| 资源复用 | `Bootstrap` 可反复 `connect`；`EventLoopGroup` 全局只建一次，否则线程越积越多 |
| 主动停止 | 关闭时设标志位，避免停机过程中又触发重连 |
| 会话恢复 | 重连后重新鉴权、重新订阅，按消息序号补拉断线期间消息 |

- 客户端可统计连续未收到 PONG 的次数（如 3 次），超限主动断开交给重连逻辑

→ 详见 [心跳与连接管理](/netty/8_heartbeat)

### 24、WebSocket、SSE、HTTP 长轮询的区别？各适合什么场景？

**核心结论**：需要双向实时通信选 WebSocket；只需服务端单向推送优先 SSE（更简单、浏览器自动重连）；长轮询只作兼容兜底。

| 维度 | HTTP 长轮询 | SSE | WebSocket |
|------|-----------|-----|-----------|
| 协议 | 普通 HTTP | HTTP（`text/event-stream`）| WS / WSS（RFC 6455），HTTP Upgrade 握手后返回 101 |
| 方向 | 客户端拉取（模拟推送）| 服务端单向 | 全双工 |
| 连接 | 请求挂起，有数据或超时返回再发下一次 | 一条长连接持续写 | 一条持久双向连接 |
| 消息开销 | 每次完整 HTTP 头 | 小 | 最小（帧头 2~14 字节）|
| 数据格式 | 任意 | 仅 UTF-8 文本 | 文本或二进制 |
| 断线重连 | 天然 | 浏览器自动，带 `Last-Event-ID` 续传 | 需自行实现 |
| 适用 | 兼容性优先、低频更新 | 通知、日志流、AI 流式输出、进度 | 聊天、游戏、协同编辑 |

- SSE 注意：HTTP/1.1 下同域名浏览器并发连接约 6 个，SSE 长期占用一个，启用 HTTP/2 可缓解；反向代理需关闭响应缓冲
- WebSocket 注意：`Sec-WebSocket-Accept` 只做协议确认、不是鉴权，鉴权在握手阶段做并校验 `Origin`；Netty 中 `WebSocketServerProtocolHandler` 自动处理握手、Ping/Pong、Close

→ 详见 [WebSocket](/netty/9_websocket)、[SSE](/netty/10_sse)

### 25、WebSocket 集群部署时，如何推送到连在其他节点上的用户？

**核心结论**：WebSocket 连接有状态，会话表只在本机内存；要么**广播到所有节点，由持有连接的节点下发**，要么**维护 `userId → nodeId` 路由表定向转发**。

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| Redis Pub/Sub 广播 | 所有节点订阅同一频道，查本地会话表，持有者下发 | 简单，无需路由 | 消息放大到所有节点；不持久化，断开期间会丢 |
| MQ 广播消费 | 每个节点独立消费组 / 广播模式订阅 | 可靠、可堆积、可重放 | 引入 MQ，同样有放大 |
| 路由表定向转发 | 建连时写 Redis `userId → nodeId`，推送时查表发到该节点专属频道 / 队列 | 无放大，适合大规模 | 要维护一致性，节点宕机需清理（TTL + 心跳续期）|

- 选型：节点少、量小 → Pub/Sub；不能丢 → MQ + 客户端按序号补拉；连接规模大、以单用户推送为主 → 路由表
- Spring 体系可用 STOMP `enableStompBrokerRelay` 中转到外部 Broker
- Nginx 需 `proxy_http_version 1.1`、透传 `Upgrade` / `Connection`，`proxy_read_timeout` 大于心跳间隔；粘性会话非必需（SockJS 降级除外）

→ 详见 [WebSocket](/netty/9_websocket)

## 七、生产实践

### 26、Netty 服务上线前需要调整哪些参数？

**核心结论**：大部分保持默认，重点确认线程数、原生传输、`SO_BACKLOG`、`TCP_NODELAY`、客户端连接超时和写水位，拿不准默认值的一律显式设置；同时限制直接内存。

| 类别 | 参数 | 建议 |
|------|------|------|
| 线程 | bossGroup | 每个监听端口 1 个线程 |
| 线程 | workerGroup | 默认 CPU × 2；容器内确认 `availableProcessors()` 实际值 |
| 传输 | Epoll | Linux 用 `EpollEventLoopGroup`，`Epoll.isAvailable()` 判断并回退 NIO |
| option | `SO_BACKLOG` | 显式设置（如 1024），实际取与 `net.core.somaxconn` 的较小值 |
| option | `SO_REUSEADDR` | 显式开启 |
| childOption | `TCP_NODELAY` | 显式 `true` |
| childOption | `SO_KEEPALIVE` | 可开启兜底，不替代应用层心跳 |
| childOption | `WRITE_BUFFER_WATER_MARK` | 默认低 32KB / 高 64KB，按单连接吞吐调整 |
| childOption | `SO_RCVBUF` / `SO_SNDBUF` | 一般不设，交给 OS 自动调节 |
| 客户端 | `CONNECT_TIMEOUT_MILLIS` | 默认 30s，调小到 3~5s |
| JVM | `-XX:MaxDirectMemorySize` | 显式设置；堆 + 直接内存 + 元空间 + 线程栈 < 容器限制 |
| 系统 | `ulimit -n` / `fs.file-max` | 每连接一个 fd，调大 |

- `option()` 作用于监听 Channel，`childOption()` 作用于每个子连接，写错位置不生效

→ 详见 [生产实践与调优](/netty/11_production)

### 27、对端消费很慢时一直 `writeAndFlush` 会怎样？如何做背压？

**核心结论**：`writeAndFlush` 不阻塞也不拒绝，内核发送缓冲区满后数据在 `ChannelOutboundBuffer` 中无上限堆积，最终撑爆直接内存；写水位只是信号，必须业务自己在写前检查 `isWritable()`。

- **水位机制**：待发送字节超过高水位 → `isWritable()=false`，触发 `channelWritabilityChanged`；降到低水位以下恢复可写并再次触发
- **出站背压**：写前检查 `isWritable()`，不可写时丢弃、降级（只推最新状态）或持续不可写时断开；放弃发送的引用计数消息要自行释放
- **入站背压**（代理 / 转发）：下游不可写时 `inboundChannel.config().setAutoRead(false)`，可写时恢复，压力经 TCP 滑动窗口反推给源头
- **flush 优化**：批量 `write` 后一次 `flush`，或在 `channelReadComplete` 统一 flush，或用 `FlushConsolidationHandler` 合并

```java
if (!ch.isWritable()) {
    ReferenceCountUtil.release(msg); // 慢消费者：丢弃 / 降级 / 断开
    return false;
}
ch.writeAndFlush(msg);
```

→ 详见 [生产实践与调优](/netty/11_production)

### 28、Netty 服务如何优雅停机？

**核心结论**：先摘流量、关监听端口停止接新连接，再通知存量连接下线并等待在途请求完成，最后按 boss → worker → 业务线程池顺序 `shutdownGracefully`。

| 步骤 | 动作 |
|------|------|
| 1 | 从注册中心 / 负载均衡摘除本节点 |
| 2 | `serverChannel.close()` 停止 accept |
| 3 | 通知存量长连接（WebSocket Close 帧 1001、私有协议 GOAWAY）让客户端重连到其他节点 |
| 4 | 等待在途请求完成（设上限）|
| 5 | `bossGroup` → `workerGroup` → 业务线程池依次关闭 |

- `shutdownGracefully(quietPeriod, timeout, unit)`：静默期内有新任务则重新计时，超时强制关闭；默认 2s / 15s；方法异步，需要等待时 `.syncUninterruptibly()`
- Spring 中用 `SmartLifecycle` 接入生命周期；K8s 下 `preStop` 与 `terminationGracePeriodSeconds` 要覆盖停机耗时

→ 详见 [生产实践与调优](/netty/11_production)

### 29、Netty 开发中有哪些常见的坑？

**核心结论**：高频坑集中在四类：阻塞 EventLoop、ByteBuf 释放、Pipeline 与 Handler 共享、长连接治理（背压 / 心跳 / 帧长度）。

| 坑 | 现象 | 正确做法 |
|----|------|---------|
| EventLoop 中执行 DB / RPC / `sleep` | 同 EventLoop 所有连接卡顿 | 交给业务线程池 |
| EventLoop 中 `sync()` / `await()` | `BlockingOperationException` | 改用 `addListener` |
| 忘记 `release` | 直接内存上涨、LEAK 日志 | 谁最后使用谁释放，或用 `SimpleChannelInboundHandler` |
| 重复 `release` | `IllegalReferenceCountException` | 向后传递或交给 write 后不再释放 |
| 只 `write` 不 `flush` | 对端收不到，内存上涨 | `writeAndFlush` 或统一 flush |
| 覆写 `channelRead` 忘记 fire | 后续 Handler 收不到消息 | `ctx.fireChannelRead(msg)` |
| 业务 Handler 在编码器前用 `ctx.write()` | 编码器被跳过 | 编解码器在前，业务在后 |
| 未标 `@Sharable` 却复用 / 有状态却共享 | `ChannelPipelineException` / 连接状态串扰 | 有状态每连接 `new` |
| 不检查 `isWritable()` 持续推送 | 直接内存 OOM | 写前检查 + 水位 + 降级 |
| 未设置 `maxFrameLength` 或过大 | 恶意长度字段耗尽内存 | 按协议上限设置，超限断开 |
| 每次重连新建 `EventLoopGroup` | 线程数不断增加 | 全局复用 |
| 未实现 `exceptionCaught` | 异常到链尾仅警告，连接不关闭 | 链尾统一异常处理并 `close()` |
| 未设心跳 | 半开连接只增不减 | `IdleStateHandler` + 应用层心跳 |
| JDK epoll 空轮询 bug | CPU 100% | Netty 已规避（超 512 次重建 Selector），了解即可 |

→ 详见 [生产实践与调优](/netty/11_production)

---
description: IO 模型、Reactor、ByteBuf、粘包拆包、心跳、生产调优
---

# Netty 面试题解答

> 题目清单见 [Netty 面试题](/netty/99_interview)；细节详见 [Netty 总览](/netty/0_overview)。
>
> 版本基线：Netty 4.x。

## 一、IO 模型

### Q1：一次网络读分哪两个阶段？五种 IO 模型区别在哪？

**一句话**：一次 `read` 分两步：先**等数据到达**内核缓冲区，再把数据**从内核拷到程序内存**。五种 IO 模型的区别，就在于这两步里程序线程是在干等还是去做别的事。

| 模型 | 等数据 | 拷数据 |
|------|-------|-------|
| 阻塞 IO | 线程挂起等 | 线程自己拷 |
| 非阻塞 IO | 不挂起，程序反复来问 | 线程自己拷 |
| IO 多路复用 | 一个线程一次等一批连接（select / epoll） | 线程自己拷 |
| 信号驱动 IO | 不等，内核发信号通知 | 线程自己拷 |
| 异步 IO | 不等 | 内核拷好再通知 |

- 阻塞 / 非阻塞看第一步：没数据时线程挂不挂起
- 同步 / 异步看第二步：拷数据是不是程序自己做；前四种都是同步，只有异步 IO 是真异步

→ 详见 [IO 模型](/netty/1_io_model)

### Q2：BIO、NIO、AIO 的区别？为什么说 Java NIO 是"同步非阻塞"？

**一句话**：BIO 一个连接占一个线程，全程阻塞；NIO 一个线程借助 Selector 照看很多连接；AIO 由内核把数据读好再回调。NIO 的数据还是程序线程自己调 `read` 拷的，所以叫「同步非阻塞」。

| 对比 | BIO | NIO | AIO |
|------|-----|-----|-----|
| 线程 | 一连接一线程 | 一个线程管多个连接 | 发起后立即返回，完成后回调 |
| 特点 | 简单，但线程多数时间空等，连接一多扛不住 | 线程数不随连接数增长 | Linux 上是模拟出来的，没有性能优势 |
| 现状 | 连接少的场景 | Netty 等主流框架的基础 | 很少用，Netty 也没用 |

- 「非阻塞」：Channel 设成非阻塞后，没数据时 `read` 立即返回 0
- 「同步」：Selector 只告诉你「可以读了」，拷贝还得自己做

→ 详见 [IO 模型](/netty/1_io_model)

### Q3：select、poll、epoll 的区别？epoll 为什么高效？

**一句话**：select / poll 每次调用都要把所有连接交给内核、内核再挨个检查一遍；epoll 把「登记连接」和「等待事件」拆开，连接只登记一次，内核在数据到达时主动把就绪的连接放进一个列表，等待时只取这个列表。

| 对比 | select | poll | epoll |
|------|--------|------|-------|
| 连接数上限 | 默认 1024 | 无硬上限 | 无硬上限 |
| 每次调用 | 全部连接拷进内核 | 同 select | 不用重复传，登记一次即可 |
| 找就绪连接 | 挨个扫一遍 | 挨个扫一遍 | 直接取就绪列表 |

- 所以 epoll 的等待开销和连接总数无关；连接多、活跃少（IM、推送这类长连接）时优势最明显
- Java NIO 的 `Selector` 在 Linux 上默认就是 epoll

→ 详见 [IO 模型](/netty/1_io_model)

### Q4：epoll 的 LT 和 ET 有什么区别？Netty 用哪种？

**一句话**：LT（水平触发）只要缓冲区里还有没读完的数据，每次都提醒你；ET（边缘触发）只在新数据到来时提醒一次，必须一口气读到读不出为止。Netty 的 NIO 传输是 LT，原生 epoll 传输是 ET。

| 对比 | LT（默认） | ET |
|------|----------|----|
| 提醒次数 | 没读完就一直提醒 | 有新数据时提醒一次 |
| 读取要求 | 可以分几次读 | 必须一次读完 |
| 漏读风险 | 低 | 高 |
| 系统调用 | 较多 | 较少 |

- `NioEventLoopGroup`（基于 JDK `Selector`）是 LT
- `EpollEventLoopGroup`（Netty 原生 epoll）是 ET，这是它吞吐更高的原因之一

→ 详见 [IO 模型](/netty/1_io_model)

## 二、Reactor 模型

### Q5：Reactor 有哪三种模式？各有什么优缺点？

**一句话**：按「有几个 Reactor（事件分发线程）、业务在哪个线程跑」分成三种，演进方向是把「接新连接、读写数据、跑业务」逐步拆给不同的线程。

| 模式 | 分工 | 优点 | 缺点 | 代表 |
|------|------|------|------|------|
| 单 Reactor 单线程 | 全在一个线程 | 无锁、最简单 | 只用一个核；一个慢操作卡住所有连接 | Redis（6.0 前） |
| 单 Reactor 多线程 | 一个线程接连接和读写，业务进线程池 | 慢业务不卡事件循环 | 读写集中在一个线程，成瓶颈 | Tomcat NIO（近似） |
| 主从 Reactor 多线程 | 主线程只接连接，一组从线程负责读写 | 读写能力随核数扩展 | 结构最复杂（框架封装好了） | Netty、Kafka 网络层 |

→ 详见 [Reactor 模型](/netty/2_reactor)

### Q6：Netty 用哪种 Reactor？BossGroup 和 WorkerGroup 各做什么？

**一句话**：Netty 用两个线程组实现主从 Reactor：BossGroup 只负责接收新连接，WorkerGroup 负责已建立连接的读写和 Pipeline 处理。

- 新连接被 boss 接到后，交给 worker 里的某一个线程，此后一直由它负责
- 每个连接有一条 `ChannelPipeline`，上面挂着处理数据的 Handler 链
- bossGroup 一般配 1 个线程：一个监听端口只会注册到一个线程上，多配也用不上
- workerGroup 默认线程数是 CPU 核数 × 2
- 慢业务可以再交给自定义的业务线程池

→ 详见 [Reactor 模型](/netty/2_reactor)

### Q7：Reactor 和 Proactor 有什么区别？

**一句话**：Reactor 在「数据可以读了」时通知程序自己去读；Proactor 在「数据已经读好了」时把结果交给程序。前者基于多路复用，后者基于异步 IO。

| 对比 | Reactor | Proactor |
|------|---------|----------|
| 底层 | epoll / kqueue | Windows IOCP、io_uring |
| 通知时机 | 可以读写了 | 读写已完成 |
| 谁拷数据 | 程序线程 | 内核 |
| 编程难度 | 较低 | 较高 |
| 例子 | Netty、Redis、Nginx | Windows IOCP、Java AIO |

- Linux 长期缺少成熟的网络异步 IO，所以 Linux 上的高性能网络框架几乎都是 Reactor

→ 详见 [Reactor 模型](/netty/2_reactor)

## 三、Netty 入门与核心组件

### Q8：原生 JDK NIO 有哪些问题？Netty 如何解决？

**一句话**：JDK NIO 只给了最底层的能力，线程模型、拆包、心跳、协议都得自己写，还有 epoll 空轮询 bug；Netty 把这些都封装好了。

- API 难用：`ByteBuffer` 读写共用一个指针，要 `flip()` 切换；Netty 的 `ByteBuf` 读写指针分开
- 粘包拆包、心跳重连要自己写；Netty 内置各种帧解码器和 `IdleStateHandler`
- 空轮询 bug：`select()` 没事件也反复立即返回，CPU 100%；Netty 统计到连续 512 次就重建 `Selector`
- 多线程读写同一连接容易出错；Netty 让每个连接固定绑一个线程，串行执行
- HTTP、WebSocket、SSL 要从零实现；Netty 都有现成的编解码器

Netty 的「异步」指的是接口：`write` 等操作立即返回一个 `ChannelFuture`，底层仍是同步非阻塞 + 多路复用。

→ 详见 [Netty 入门](/netty/3_netty_desc)

### Q9：Netty 的核心组件有哪些？一次请求如何流动？

**一句话**：Channel 是连接，EventLoop 是干活的线程，Pipeline 是处理流水线，Handler 是流水线上的一个个工位；另外 `ByteBuf` 装字节，`ChannelFuture` 拿异步结果，`Bootstrap` 负责组装启动。

- 接入：boss 线程收到新连接，把它注册到某个 worker 线程上，从此终身绑定
- 装配：`ChannelInitializer` 给这个连接的 Pipeline 加好 Handler，然后把自己移除
- 读入：数据到达，worker 读进 `ByteBuf`，从 Pipeline 头往尾走：拆帧 → 解码 → 业务 Handler
- 写出：业务调 `ctx.writeAndFlush()`，数据往回经过编码器，先进发送缓冲区，`flush` 时写到 Socket

→ 详见 [Netty 入门](/netty/3_netty_desc)、[Channel 与 EventLoop](/netty/4_channel_eventloop)、[Pipeline 与 Handler](/netty/5_pipeline_handler)

### Q10：EventLoop 的工作机制？为什么 Channel 要绑定固定的 EventLoop？

**一句话**：一个 EventLoop 就是一个线程 + 一个 Selector + 一个任务队列，在死循环里轮流处理 IO 事件和排队的任务。Channel 终身绑定一个 EventLoop，换来的是**不用加锁**和**消息有序**。

- 循环三步：等事件 → 处理 IO 事件（驱动 Pipeline）→ 执行队列里的任务和到期的定时任务；两者时间比例由 `ioRatio` 控制，默认 50
- 绑定的好处：同一连接的 Handler 不会被多个线程同时调用，状态不用加锁；读写按顺序进行，也没有线程切换
- 代价：一个 EventLoop 管很多连接，任何阻塞都会拖慢它名下所有连接
- 其他线程要操作 Channel，会把任务投递到它的 EventLoop；`write` / `writeAndFlush` 内部已做了这一步，任何线程调用都安全

→ 详见 [Channel 与 EventLoop](/netty/4_channel_eventloop)

### Q11：Pipeline 中入站 / 出站事件的传播方向？`ctx.write()` 和 `channel.write()` 的区别？

**一句话**：入站事件（读到数据）从 Head 往 Tail 走，出站操作（写数据）从 Tail 往 Head 走。`ctx.write()` 从**当前 Handler** 往前走，`channel.write()` 从**链尾**开始走完所有出站 Handler。

- 入站不会自动往下传：重写了 `channelRead` 就要调 `ctx.fireChannelRead(msg)`，否则后面的 Handler 收不到
- 异常沿入站方向传，链尾没人处理只打一条警告、不关连接，所以链尾要放统一异常处理
- 写失败不会触发 `exceptionCaught`，只记在返回的 `ChannelFuture` 上

**常见坑**：业务 Handler 排在编码器前面又用 `ctx.write()`，编码器被跳过，发出去的是没编码的对象；应该编解码器放前面、业务 Handler 放最后。

→ 详见 [Pipeline 与 Handler](/netty/5_pipeline_handler)

### Q12：什么样的 Handler 可以加 `@Sharable`？

**一句话**：只有**不保存任何连接相关数据**、且线程安全的 Handler，才能加 `@Sharable` 让多个连接共用一个实例。`@Sharable` 只是一个声明，Netty 不会替你保证线程安全。

- 可以共享：编码器、统一异常处理、无状态的业务分发，做成单例
- 不能共享：有成员变量记录连接数据的 Handler，在 `initChannel()` 里每次 `new`
- 禁止共享：各种帧解码器（内部有累积缓冲区）、`IdleStateHandler`（内部有计时状态）
- 连接自己的数据放在 Channel 的属性（`AttributeKey`）里

**常见坑**：没加 `@Sharable` 却把同一个实例加到多个连接，会抛 `ChannelPipelineException`。

→ 详见 [Pipeline 与 Handler](/netty/5_pipeline_handler)

### Q13：为什么不能在 EventLoop 线程里阻塞？业务逻辑放在哪执行？

**一句话**：一个 EventLoop 同时服务成百上千个连接，在里面同步查库、同步调 RPC、`sleep` 或做重计算，它名下所有连接都会一起卡住。慢逻辑交给业务线程池，处理完用 `ctx.writeAndFlush()` 写回，Netty 会自动切回 EventLoop。

| 对比 | `addLast(executorGroup, handler)` | Handler 里提交到自己的线程池 |
|------|------|------|
| 同一连接的消息顺序 | 保证（每个连接固定一个线程） | 不保证 |
| 负载均衡 | 慢连接会拖累同线程的其他连接 | 按任务调度，更均衡 |
| 改造成本 | 一行代码 | 要处理线程切换和资源释放 |
| 适合 | 要求顺序（如 IoT 指令） | 请求互相独立（RPC、HTTP） |

**常见坑**：在 Handler 里调 `future.sync()` / `await()`，等于线程等自己，Netty 会抛 `BlockingOperationException`，要改用 `addListener`；把 `ByteBuf` 交给业务线程前要先 `retain()`，用完在业务线程释放。

→ 详见 [Channel 与 EventLoop](/netty/4_channel_eventloop)

## 四、ByteBuf 与内存

### Q14：ByteBuf 相比 NIO ByteBuffer 有哪些优势？

**一句话**：ByteBuf 读和写各有一个指针，不用 `flip()` 切换；还能自动扩容、池化复用、按引用计数及时回收，又好用又高效。

| 对比 | `ByteBuffer` | `ByteBuf` |
|------|-------------|-----------|
| 读写切换 | 共用一个位置，要 `flip()` | 读、写指针分开 |
| 容量 | 固定 | 自动扩容 |
| 内存复用 | 没有池化 | 支持池化 |
| 回收 | 等 GC | 引用计数，用完立即归还 |

- `read*` / `write*` 会移动指针，`get*` / `set*` 不移动
- `slice` / `duplicate` 和原对象共享内存，`copy` 才真正复制一份

→ 详见 [ByteBuf 与内存管理](/netty/6_bytebuf)

### Q15：ByteBuf 的引用计数是怎么回事？什么时候需要手动 `release`？

**一句话**：池化的内存不能等 GC 回收，所以用计数管理：创建时为 1，`retain()` 加 1，`release()` 减 1，减到 0 就还回池里。原则是**谁最后用，谁释放**。

- 要释放：继承 `ChannelInboundHandlerAdapter` 并在这里把消息用掉，在 `finally` 里 `ReferenceCountUtil.release(msg)`
- 不用释放：通过 `fireChannelRead(msg)` 传给了下一个 Handler；继承 `SimpleChannelInboundHandler`（方法返回后自动释放）；交给了 `write`（Netty 写完会释放）
- 自己调了 `retain()`，或者把消息交给别的线程，要配对 `release()`
- 计数已经是 0 还去访问或再释放，会抛 `IllegalReferenceCountException`

**常见坑**：用 `SimpleChannelInboundHandler` 时把 msg 存起来或交给别的线程，方法返回后它已被释放；确实要留用先 `retain()`。

→ 详见 [ByteBuf 与内存管理](/netty/6_bytebuf)

### Q16：如何排查 Netty 的内存泄漏？

**一句话**：靠 Netty 自带的泄漏检测：ByteBuf 被 GC 回收时计数还没归零，就打一条 `LEAK:` 日志。测试环境调到最严格级别复现，按日志里的访问记录找到出问题的 Handler。

- 检测级别：`SIMPLE`（默认，抽样，生产用）、`ADVANCED`（抽样，多记最近访问位置）、`PARANOID`（每次都查，用于测试和 CI）
- 复现：加 `-Dio.netty.leakDetection.level=paranoid`，从日志的访问记录里找到自己的类，看它是不是既没释放也没往后传
- 常见原因：消费后没释放、提前 `return` 的分支漏了释放、异常路径漏了释放、`retain` 没配对
- 线上监控池化分配器的直接内存用量，只涨不跌就是泄漏或写缓冲积压

→ 详见 [ByteBuf 与内存管理](/netty/6_bytebuf)、[生产实践与调优](/netty/12_production)

### Q17：Netty 的零拷贝体现在哪？和操作系统零拷贝有什么区别？

**一句话**：分两层。操作系统层是真零拷贝：`FileRegion` 底层用 `sendfile`，文件数据从内核直接到网卡，不经过程序内存；Netty 自己这一层是「少拷贝」：在 JVM 里尽量不做多余的内存复制。

- `CompositeByteBuf`：把协议头和消息体逻辑上拼成一个，不复制
- `Unpooled.wrappedBuffer`：直接包装已有的 `byte[]`，不复制
- `slice`：切出一段视图，不复制
- IO 默认用堆外内存，省掉一次「堆内 → 堆外」的中转拷贝

**常见坑**：开了 TLS 后数据要在程序里加密，用不了 `FileRegion`，改用 `ChunkedWriteHandler` 分块发送。

→ 详见 [ByteBuf 与内存管理](/netty/6_bytebuf)

## 五、粘包拆包与协议设计

### Q18：什么是 TCP 粘包 / 拆包？原因是什么？为什么 UDP 没有？

**一句话**：TCP 传的是一串连续的字节，只保证有序、不丢，不管消息从哪到哪。粘包是几条消息被一次读到，拆包是一条消息被分几次读到；UDP 一个数据报就是一条消息，天然有边界。

- 发送端：Nagle 算法把小包合并发送；多次 write 在发送缓冲区连成一片
- 网络：超过单包大小上限（MSS / MTU）会被切开
- 接收端：每次 read 只是把缓冲区现有的内容取走，和对方 write 了几次无关
- 唯一可靠的解法是在应用层定义消息边界：定长、分隔符、长度字段（最主流）

**常见坑**：以为关掉 Nagle（`TCP_NODELAY`）就能解决粘包，其实不能。

→ 详见 [粘包与拆包](/netty/7_stick_split)

### Q19：Netty 有哪些解决粘包拆包的解码器？`ByteToMessageDecoder` 如何处理半包？

**一句话**：内置四种拆帧解码器，放在 Pipeline 最前面。它们都继承 `ByteToMessageDecoder`，处理半包的办法是：把收到的数据攒在一个缓冲区里，够一帧就切出来，不够就先留着，等下次数据到了再拼。

- `FixedLengthFrameDecoder` 按固定长度；`DelimiterBasedFrameDecoder` 按分隔符；`LineBasedFrameDecoder` 按换行
- `LengthFieldBasedFrameDecoder` 按长度字段，二进制协议首选；发送端用 `LengthFieldPrepender` 配套
- 自己写 `decode` 时：数据不够一帧就一个字节都不要读，直接返回

**常见坑**：不设或设太大 `maxFrameLength`，对方发一个超大的长度值就能耗尽内存；超限时应直接关连接。

→ 详见 [粘包与拆包](/netty/7_stick_split)

### Q20：`LengthFieldBasedFrameDecoder` 的五个参数如何配置？

**一句话**：五个参数说清楚四件事：长度字段在哪、占几个字节、它的值代表多长、切出来后要不要去掉帧头。核心公式：**整帧长度 = lengthFieldOffset + lengthFieldLength + 长度字段的值 + lengthAdjustment**。

- `maxFrameLength`：一帧最大字节数，按**整帧**（含帧头）算
- `lengthFieldOffset`：长度字段离帧开头多少字节；`lengthFieldLength`：长度字段本身占几个字节
- `lengthAdjustment`：修正量 =「长度字段后面实际还有多少字节」−「长度字段的值」
- `initialBytesToStrip`：切出整帧后从头丢掉几个字节，0 表示保留完整帧
- 例：长度字段在最前、占 2 字节、值包含自己这 2 字节 → offset 0、length 2、adjustment −2、strip 0

**常见坑**：`maxFrameLength` 只按消息体上限设，导致最大的合法消息被拒。

→ 详见 [自定义私有协议](/netty/8_custom_protocol)

### Q21：设计私有协议需要哪些字段？一条连接上如何让请求和响应一一对应？

**一句话**：帧头的每个字段都在回答「接收方要知道什么才能正确处理这条消息」：魔数、版本、消息类型、长度是必备的，RPC 还要请求 ID 和序列化方式。请求和响应靠帧头里的请求 ID 对上。

- 魔数：一眼认出是不是本协议，不对直接断开；版本：新旧版本并存
- 序列化方式：JSON / Protobuf 可以平滑切换；长度：给拆帧解码器用
- 匹配流程：客户端生成连接内唯一的请求 ID，存一张「请求 ID → Future」的表再发送；服务端原样带回 ID，可以并发处理、乱序返回；客户端收到后按 ID 找到 Future 完成它
- 表里的请求要有超时清理，否则越积越多；连接断开时让所有在途请求立刻失败

→ 详见 [自定义私有协议](/netty/8_custom_protocol)

## 六、长连接与推送

### Q22：有了 TCP keepalive 为什么还要应用层心跳？`IdleStateHandler` 的作用？

**一句话**：对方宕机、断网时连接可能悄无声息地断掉（半开连接）。TCP keepalive 默认空闲 2 小时才探测，而且只能确认对方系统还在，发现不了进程卡死，所以要自己做应用层心跳。`IdleStateHandler` 不发心跳，只负责计时，空闲超时就发出一个事件。

| 对比 | TCP keepalive | 应用层心跳 |
|------|---------------|-----------|
| 多久探测 | Linux 默认空闲 2 小时后 | 自己定，常见 10～60 秒 |
| 能发现什么 | 对方系统还在 | 对方程序在正常处理 |
| 经过代理 | 只到最近一跳 | 端到端 |

- 三个参数：读空闲、写空闲、读写都空闲的时长，0 表示不检测
- 常用做法：客户端写空闲时发 PING；服务端读空闲超时就关连接，超时时间约为心跳间隔的 3 倍
- 有计时状态，每个连接都要 `new` 一个

→ 详见 [心跳与连接管理](/netty/9_heartbeat)

### Q23：客户端断线重连应该如何实现？

**一句话**：在连接失败和连接断开（`channelInactive`）两个时机触发重连，用 `eventLoop().schedule()` 延迟执行，间隔逐次翻倍、加随机抖动、设上限，并复用同一个 `Bootstrap` 和线程组。

- 间隔：1s、2s、4s… 最多到比如 60 秒，连上后归零
- 随机抖动：避免服务端重启后所有客户端同一时刻涌进来
- 主动关闭时先设一个标志位，免得停机过程中又触发重连
- 重连后要重新鉴权、重新订阅，按消息序号补拉断线期间的消息

**常见坑**：每次重连都新建 `EventLoopGroup`，线程越积越多；线程组应该全局只建一次。

→ 详见 [心跳与连接管理](/netty/9_heartbeat)

### Q24：WebSocket、SSE、HTTP 长轮询的区别？各适合什么场景？

**一句话**：要双向实时通信选 WebSocket；只需要服务端往下推，优先 SSE，更简单，浏览器还会自动重连；长轮询只作兼容兜底。

| 对比 | HTTP 长轮询 | SSE | WebSocket |
|------|-----------|-----|-----------|
| 方向 | 客户端反复拉（模拟推送） | 服务端单向推 | 双向 |
| 数据 | 任意 | 只能文本 | 文本或二进制 |
| 断线重连 | 天然就是一次次重连 | 浏览器自动，可断点续传 | 要自己实现 |
| 适合 | 兼容优先、更新少 | 通知、日志流、AI 流式输出 | 聊天、游戏、协同编辑 |

- SSE：HTTP/1.1 下同一域名浏览器只有约 6 个并发连接，SSE 会长期占一个，用 HTTP/2 可缓解；反向代理要关掉响应缓冲
- WebSocket：鉴权要在握手阶段自己做，并校验 `Origin`；Netty 的 `WebSocketServerProtocolHandler` 自动处理握手和 Ping/Pong

→ 详见 [WebSocket](/netty/10_websocket)、[SSE](/netty/11_sse)

### Q25：WebSocket 集群部署时，如何推送到连在其他节点上的用户？

**一句话**：用户连在哪台机器上，只有那台机器知道。办法有两种：**广播给所有节点，谁持有这个连接谁下发**；或者**记一张「用户 → 节点」路由表，直接发给对应节点**。

| 方案 | 优点 | 缺点 |
|------|------|------|
| Redis Pub/Sub 广播 | 简单，不用维护路由 | 每条消息发给所有节点；不持久化，可能丢 |
| MQ 广播 | 可靠，能堆积、能重放 | 要引入 MQ，同样发给所有节点 |
| 路由表定向转发 | 不浪费，适合大规模 | 要维护路由表，节点宕机要清理 |

- 选型：节点少、量小用 Pub/Sub；不能丢用 MQ + 客户端按序号补拉；连接多、主要是单用户推送用路由表
- Nginx 要用 HTTP/1.1、透传 `Upgrade` / `Connection` 头，读超时要大于心跳间隔

→ 详见 [WebSocket](/netty/10_websocket)

## 七、生产实践

### Q26：Netty 服务上线前需要调整哪些参数？

**一句话**：大多数保持默认，重点确认线程数、Linux 原生传输、连接队列长度、`TCP_NODELAY`、客户端连接超时和写水位；拿不准默认值的一律显式设置，同时限制直接内存。

- 线程：bossGroup 每个监听端口 1 个；workerGroup 默认 CPU × 2，容器里要确认识别到的核数对不对
- 传输：Linux 用 `EpollEventLoopGroup`，先判断 `Epoll.isAvailable()`，不可用再退回 NIO
- 连接：`SO_BACKLOG`（等待接入的连接队列）显式设如 1024；`TCP_NODELAY` 显式 `true`；客户端连接超时默认 30 秒，调小到 3～5 秒
- 内存：显式设 `-XX:MaxDirectMemorySize`，堆 + 直接内存 + 元空间 + 线程栈要小于容器限制
- 系统：每个连接占一个文件句柄，调大 `ulimit -n`

**常见坑**：`option()` 作用于监听端口，`childOption()` 作用于每个连接，写错位置不生效。

→ 详见 [生产实践与调优](/netty/12_production)

### Q27：对端消费很慢时一直 `writeAndFlush` 会怎样？如何做背压？

**一句话**：`writeAndFlush` 不会阻塞也不会拒绝，对方收得慢时数据就在 Netty 的发送缓冲区里无限堆积，最后撑爆直接内存。写水位只是一个信号，业务必须自己在写之前检查 `isWritable()`。

- 水位：待发数据超过高水位（默认 64KB）就变成不可写，降到低水位（默认 32KB）以下恢复可写
- 出站背压：写前查 `isWritable()`，不可写时丢弃、降级（只推最新状态）或断开；放弃发送的消息要自己释放
- 入站背压（代理转发场景）：下游写不动时对上游连接 `setAutoRead(false)` 暂停读，可写时再打开
- flush 优化：多次 `write` 后一次 `flush`，减少系统调用

```java
if (!ch.isWritable()) { ReferenceCountUtil.release(msg); return false; }   // 丢弃 / 降级 / 断开
```

→ 详见 [生产实践与调优](/netty/12_production)

### Q28：Netty 服务如何优雅停机？

**一句话**：先把流量摘掉、关掉监听端口不再接新连接，再通知已有连接下线并等在途请求处理完，最后按 boss → worker → 业务线程池的顺序关闭。

- 第一步：从注册中心 / 负载均衡摘掉本节点，再 `serverChannel.close()` 停止接新连接
- 第二步：通知长连接客户端（如 WebSocket 发 Close 帧）去连别的节点，并等待在途请求完成（设上限）
- 第三步：依次 `shutdownGracefully()`，它有静默期（默认 2 秒）和总超时（默认 15 秒），是异步的，要等就加 `.syncUninterruptibly()`
- K8s 下 `preStop` 和 `terminationGracePeriodSeconds` 要覆盖整个停机耗时

→ 详见 [生产实践与调优](/netty/12_production)

### Q29：Netty 开发中有哪些常见的坑？

**一句话**：集中在四类：阻塞了 EventLoop、ByteBuf 没释放或重复释放、Pipeline 和 Handler 用错、长连接没治理（不控写速度、不设心跳、不限帧长度）。

| 坑 | 后果 | 正确做法 |
|----|------|---------|
| EventLoop 里查库、调 RPC、`sleep` | 同线程所有连接卡住 | 交给业务线程池 |
| 忘记 `release` / 重复 `release` | 内存上涨 / 抛异常 | 谁最后用谁释放 |
| 有状态 Handler 被多个连接共享 | 连接数据串了 | 有状态的每连接 `new` |
| 不检查 `isWritable()` 一直推 | 直接内存 OOM | 写前检查 + 降级 |
| 每次重连新建 `EventLoopGroup` | 线程越来越多 | 全局复用 |

- 另外几个：只 `write` 不 `flush`，对方收不到；重写 `channelRead` 忘了往下传；链尾没有异常处理，出错了连接也不关；不设心跳，半开连接越积越多

→ 详见 [生产实践与调优](/netty/12_production)

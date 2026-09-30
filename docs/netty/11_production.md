# 生产实践与调优

> **本篇目标**：掌握 Netty 服务上线前必须确认的线程模型、关键参数、背压、内存、优雅停机与监控，并避开最常见的坑。
>
> **前置阅读**：[SSE（Server-Sent Events）](./10_sse)

前面各篇解决了"能跑起来"，本篇解决"跑得稳"。内容按上线检查的顺序组织：先配线程和参数，再防住写爆内存，最后做好停机和监控。

---

## 一、线程模型配置

**结论：boss 每个监听端口 1 个线程足够，worker 默认 CPU 核数 × 2，业务耗时逻辑一律交给独立线程池；Linux 上优先使用 Epoll 原生传输。**

### 1、线程数

| 线程组 | 建议 | 说明 |
|--------|------|------|
| bossGroup | `new NioEventLoopGroup(1)` | 每个 `ServerChannel` 只注册到一个 EventLoop，只监听 1 个端口时多配线程也用不上 |
| workerGroup | 默认（CPU 核数 × 2） | 可用 `-Dio.netty.eventLoopThreads` 调整；纯 IO 场景一般无需改动 |
| 业务线程池 | 按业务耗时单独评估 | 数据库、RPC、复杂计算等阻塞操作不能在 EventLoop 中执行 |

业务线程池的两种接入方式（`addLast(executorGroup, handler)` 与在 Handler 中手动提交）及其取舍，见 [核心组件](./4_core_components)。

::: warning 容器环境
容器内获取到的 CPU 核数取决于 JDK 版本与 cgroup 配置，可能与宿主机不一致。上线前确认 `Runtime.getRuntime().availableProcessors()` 的实际值，必要时显式指定 worker 线程数。
:::

### 2、原生传输（Native Transport）

**结论：Linux 生产环境推荐 Epoll，它直接调用系统 epoll，产生的垃圾更少，并支持更多 TCP 选项。**

| 传输 | 平台 | EventLoopGroup / Channel | 依赖 |
|------|------|--------------------------|------|
| NIO | 全平台 | `NioEventLoopGroup` / `NioServerSocketChannel` | 内置 |
| Epoll | Linux | `EpollEventLoopGroup` / `EpollServerSocketChannel` | `netty-transport-native-epoll`（带平台 classifier，如 `linux-x86_64`） |
| KQueue | macOS / BSD | `KQueueEventLoopGroup` / `KQueueServerSocketChannel` | `netty-transport-native-kqueue` |
| io_uring | 较新 Linux 内核 | `IOUringEventLoopGroup` 等 | 4.1 中为孵化项目 `netty-incubator-transport-io_uring`，生产使用需充分验证 |

按平台自动选择，不可用时回退 NIO：

```java
@Slf4j
public final class TransportFactory {

    private static final boolean EPOLL = Epoll.isAvailable();

    public static EventLoopGroup newGroup(int threads) {
        return EPOLL ? new EpollEventLoopGroup(threads) : new NioEventLoopGroup(threads);
    }

    public static Class<? extends ServerChannel> serverChannelClass() {
        return EPOLL ? EpollServerSocketChannel.class : NioServerSocketChannel.class;
    }

    static {
        if (!EPOLL) {
            // 打印不可用原因，便于排查依赖或 classifier 配置问题
            log.info("Epoll 不可用，回退 NIO: {}", Epoll.unavailabilityCause().getMessage());
        }
    }
}
```

::: tip SO_REUSEPORT
Epoll 传输支持 `EpollChannelOption.SO_REUSEPORT`，可以让多个 boss 线程（多次 bind）同时监听同一端口，由内核分摊新连接，适合短连接建连压力极大的场景。
:::

---

## 二、关键参数

**结论：大部分参数保持默认即可，重点关注 backlog、TCP_NODELAY、连接超时和写水位；拿不准默认值的参数一律显式设置。**

```java
ServerBootstrap b = new ServerBootstrap()
        .group(bossGroup, workerGroup)
        .channel(TransportFactory.serverChannelClass())
        // 服务端监听 Channel 的参数
        .option(ChannelOption.SO_BACKLOG, 1024)
        .option(ChannelOption.SO_REUSEADDR, true)
        // 每个客户端连接（子 Channel）的参数
        .childOption(ChannelOption.TCP_NODELAY, true)
        .childOption(ChannelOption.SO_KEEPALIVE, true)
        .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK, new WriteBufferWaterMark(32 * 1024, 64 * 1024))
        .childOption(ChannelOption.ALLOCATOR, PooledByteBufAllocator.DEFAULT)
        .childHandler(initializer);
```

| 参数 | 作用于 | 作用 | 默认值与建议 |
|------|--------|------|--------------|
| `SO_BACKLOG` | option | 已完成三次握手、等待 accept 的队列长度 | 默认取系统 `somaxconn`；建议显式设置（如 1024），实际生效值为它与内核 `net.core.somaxconn` 的较小者 |
| `SO_REUSEADDR` | option | 允许重启时立即绑定仍处于 TIME_WAIT 的端口 | 各平台默认不同，建议显式开启 |
| `TCP_NODELAY` | childOption | 关闭 Nagle 算法，小包立即发送 | Netty 在非 Android 平台默认开启；为免歧义建议显式设为 `true` |
| `SO_KEEPALIVE` | childOption | TCP 层保活探测 | 默认关闭；可开启兜底，但不能替代 [应用层心跳](./8_heartbeat) |
| `SO_RCVBUF` / `SO_SNDBUF` | childOption | 内核收发缓冲区大小 | 一般不设置，交给操作系统自动调节；手动设置后 Linux 会关闭该连接的自动调节 |
| `CONNECT_TIMEOUT_MILLIS` | option（客户端） | 建连超时 | 默认 30s，客户端建议按业务调小（如 3～5s） |
| `WRITE_BUFFER_WATER_MARK` | childOption | 出站缓冲区高 / 低水位，决定 `isWritable()` | 默认低 32KB、高 64KB，按单连接吞吐调整 |
| `ALLOCATOR` | childOption | ByteBuf 分配器 | 默认池化分配器（`PooledByteBufAllocator`），一般无需修改 |
| `RCVBUF_ALLOCATOR` | childOption | 每次读取分配多大的 ByteBuf | 默认自适应（`AdaptiveRecvByteBufAllocator`），根据历史读取量动态调整 |
| `AUTO_READ` | childOption | 是否自动注册读事件 | 默认 `true`；做入站背压时临时关闭，见下文 |

TCP 层面的原理（三次握手、TIME_WAIT 等）见 [网络通信协议](/protocols/1_network_protocols)。

---

## 三、写水位与背压

**结论：`writeAndFlush` 不会阻塞也不会拒绝，对端读得慢时数据会一直堆在出站缓冲区里，最终撑爆直接内存；写之前必须检查 `isWritable()`。**

### 1、为什么会 OOM

- 每个 Channel 有一个 `ChannelOutboundBuffer`，`write` 的数据先进入这里，等 socket 可写时再真正发出。
- 对端网络差或处理慢时，内核发送缓冲区写满，数据就在 `ChannelOutboundBuffer` 中持续累积，**没有上限**。
- 典型场景：推送服务向大量慢客户端广播、代理服务上游快下游慢。

### 2、水位线机制

| 状态 | 条件 | 表现 |
|------|------|------|
| 可写 → 不可写 | 待发送字节数超过高水位 | `isWritable()` 返回 `false`，触发 `channelWritabilityChanged` |
| 不可写 → 可写 | 待发送字节数降到低水位以下 | `isWritable()` 返回 `true`，再次触发 `channelWritabilityChanged` |

::: warning
水位线只是"信号"，不可写时 `write` 依然会被接受。是否暂停写入必须由业务代码判断。
:::

### 3、出站背压：写前检查

```java
@Slf4j
@Component
@RequiredArgsConstructor
public class PushService {

    private final MeterRegistry meterRegistry;

    public boolean push(Channel ch, Object msg) {
        if (!ch.isActive()) {
            return false;
        }
        if (!ch.isWritable()) {
            // 慢消费者：丢弃、降级（只推最新状态）或在持续不可写时断开
            meterRegistry.counter("netty.push.unwritable").increment();
            ReferenceCountUtil.release(msg);   // 未写出的引用计数消息需要自行释放
            return false;
        }
        ch.writeAndFlush(msg).addListener(f -> {
            if (!f.isSuccess()) {
                log.warn("推送失败: {}", ch.remoteAddress(), f.cause());
            }
        });
        return true;
    }
}
```

### 4、入站背压：关闭 autoRead

代理 / 转发场景中，下游写不动时应让上游**暂停读取**，把压力通过 TCP 滑动窗口反推给源头：

```java
/** 挂在下游（outbound）连接上：下游可写性变化时，控制上游连接是否继续读 */
@RequiredArgsConstructor
public class BackpressureHandler extends ChannelInboundHandlerAdapter {

    private final Channel inboundChannel;   // 上游连接

    @Override
    public void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception {
        // 下游不可写 → 上游停止读；下游恢复可写 → 上游继续读
        inboundChannel.config().setAutoRead(ctx.channel().isWritable());
        super.channelWritabilityChanged(ctx);
    }
}
```

---

## 四、flush 策略

**结论：`write` 只写入缓冲区，`flush` 才触发系统调用；高吞吐场景应批量 write、一次 flush，或使用 `FlushConsolidationHandler` 自动合并。**

| 操作 | 行为 | 代价 |
|------|------|------|
| `write(msg)` | 放入 `ChannelOutboundBuffer` | 很低 |
| `flush()` | 把缓冲区数据写入 socket | 一次或多次系统调用 |
| `writeAndFlush(msg)` | 上述两步合一 | 每条消息都触发系统调用 |

### 1、手动批量 flush

```java
// 一次循环中写多条，最后统一 flush
for (Message m : batch) {
    ctx.write(m);
}
ctx.flush();
```

在 `channelRead` 中处理请求时，也可以只 `write`，在 `channelReadComplete` 中统一 `flush`：一次读事件可能包含多个请求，合并后能明显减少系统调用。

### 2、FlushConsolidationHandler

```java
// 放在 Pipeline 最前面，合并连续的 flush 调用
ch.pipeline().addFirst(new FlushConsolidationHandler(256, true));
```

- 第一个参数：最多合并多少次 flush 后强制真正 flush（默认 256）。
- 第二个参数：没有读操作进行时是否也合并（为 `true` 时由异步任务稍后 flush，吞吐更高、延迟略增）。

::: tip
延迟敏感的场景（如游戏、交易）不要过度合并；吞吐优先的场景（如 RPC、推送）收益明显。
:::

---

## 五、内存与泄漏

**结论：Netty 默认使用池化直接内存，它不受堆大小约束，必须单独设上限、开启泄漏检测并做监控。**

### 1、直接内存上限

| 配置 | 说明 |
|------|------|
| `-XX:MaxDirectMemorySize` | JVM 直接内存上限；未设置时默认与最大堆大小相当 |
| `-Dio.netty.maxDirectMemory` | Netty 自身统计的直接内存上限；一般保持默认，跟随 JVM 配置 |

容器环境中：**堆 + 直接内存 + 元空间 + 线程栈** 之和要小于容器内存限制，否则会被系统 OOM Kill，而 JVM 日志里看不到任何异常。

### 2、泄漏检测级别

| 级别 | 采样 | 适用环境 |
|------|------|----------|
| `DISABLED` | 关闭 | 不推荐 |
| `SIMPLE`（默认） | 小比例采样，只报告是否泄漏 | 生产 |
| `ADVANCED` | 小比例采样，报告最近访问位置 | 预发 / 排查问题 |
| `PARANOID` | 每个 ByteBuf 都跟踪 | 单元测试、CI |

```bash
# 测试环境：尽早暴露泄漏
-Dio.netty.leakDetection.level=PARANOID
```

日志中出现 `LEAK: ByteBuf.release() was not called before it's garbage-collected` 即表示存在泄漏。引用计数规则与排查方法见 [ByteBuf](./5_bytebuf)。

### 3、监控池化内存

```java
@Component
public class NettyMemoryMetrics {

    public NettyMemoryMetrics(MeterRegistry registry) {
        PooledByteBufAllocatorMetric metric = PooledByteBufAllocator.DEFAULT.metric();
        Gauge.builder("netty.allocator.direct.used", metric, PooledByteBufAllocatorMetric::usedDirectMemory)
             .baseUnit("bytes").register(registry);
        Gauge.builder("netty.allocator.heap.used", metric, PooledByteBufAllocatorMetric::usedHeapMemory)
             .baseUnit("bytes").register(registry);
    }
}
```

直接内存曲线只涨不跌，基本可以判定为泄漏或写缓冲积压。

---

## 六、优雅停机

**结论：先关监听端口停止接新连接，再通知存量连接、等待在途请求处理完，最后按 boss → worker → 业务线程池的顺序 `shutdownGracefully`。**

### 1、shutdownGracefully 的语义

```java
// 静默期 2s、最长等待 15s（与无参版本的默认值一致）
group.shutdownGracefully(2, 15, TimeUnit.SECONDS);
```

- **静默期（quietPeriod）**：静默期内若仍有新任务提交，则重新开始计时，确保"最近一段时间确实没活干了"再退出。
- **超时（timeout）**：无论是否还有任务，到达该时间后强制关闭。
- **异步**：方法立即返回 `Future`，需要等待时调用 `.syncUninterruptibly()`。

### 2、停机步骤

| 步骤 | 动作 | 目的 |
|------|------|------|
| 1 | 从注册中心 / 负载均衡摘除本节点 | 新连接不再进来 |
| 2 | `serverChannel.close()` | 停止 accept |
| 3 | 向存量长连接发送下线通知（如 WebSocket Close 帧 1001、私有协议 GOAWAY 指令） | 客户端主动重连到其他节点 |
| 4 | 等待在途请求处理完成（设上限） | 不丢请求 |
| 5 | `bossGroup` → `workerGroup` → 业务线程池依次关闭 | 释放线程与内存 |

### 3、接入 Spring 生命周期

```java
@Slf4j
@Component
@RequiredArgsConstructor
public class NettyServerLifecycle implements SmartLifecycle {

    private final NettyProperties props;
    private final ChannelInitializer<SocketChannel> initializer;

    private EventLoopGroup bossGroup;
    private EventLoopGroup workerGroup;
    private Channel serverChannel;
    private volatile boolean running;

    @Override
    public void start() {
        bossGroup = TransportFactory.newGroup(1);
        workerGroup = TransportFactory.newGroup(0);   // 0 表示使用默认线程数
        serverChannel = new ServerBootstrap()
                .group(bossGroup, workerGroup)
                .channel(TransportFactory.serverChannelClass())
                .childHandler(initializer)
                .bind(props.getPort())
                .syncUninterruptibly()
                .channel();
        running = true;
        log.info("Netty 服务启动，端口 {}", props.getPort());
    }

    @Override
    public void stop() {
        log.info("Netty 服务开始停机");
        // 1. 停止接收新连接
        serverChannel.close().syncUninterruptibly();
        // 2. 此处可通知存量连接下线，并等待在途请求（略）
        // 3. 按顺序关闭线程组
        bossGroup.shutdownGracefully(2, 15, TimeUnit.SECONDS).syncUninterruptibly();
        workerGroup.shutdownGracefully(2, 15, TimeUnit.SECONDS).syncUninterruptibly();
        running = false;
        log.info("Netty 服务已停止");
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        // phase 越大越晚启动、越早停止
        return Integer.MAX_VALUE - 1000;
    }
}
```

::: tip
`SmartLifecycle` 默认 `isAutoStartup()` 为 `true`，Spring 容器刷新完成后自动启动。与 Kubernetes 配合时，还要让 `preStop` 等待时间、`terminationGracePeriodSeconds` 覆盖上述停机耗时，详见 [优雅上下线与变更](/high-avail/9_graceful_release)。
:::

---

## 七、监控指标

**结论：长连接服务至少要监控连接数、EventLoop 积压、写缓冲、直接内存和异常断连五类指标。**

| 指标 | 采集方式 | 告警关注点 |
|------|----------|------------|
| 当前连接数 | `channelActive` / `channelInactive` 计数，或 `ChannelGroup.size()` | 突降（节点故障、网络抖动）、逼近 fd 上限 |
| 新建 / 断开速率 | 同上，按分钟统计 | 大量重连风暴 |
| EventLoop 待处理任务数 | 遍历 group，读取 `SingleThreadEventExecutor.pendingTasks()` | 持续增长说明 IO 线程被阻塞或过载 |
| 不可写次数 | `channelWritabilityChanged` 或写前检查计数 | 慢消费者增多 |
| 直接内存使用 | `PooledByteBufAllocatorMetric.usedDirectMemory()` | 只涨不跌 |
| 解码错误数 | 解码器异常 / `DecoderException` 计数 | 协议不兼容或遭受攻击 |
| 心跳超时断开数 | `READER_IDLE` 关闭时计数 | 网络质量或客户端异常 |
| 业务线程池队列长度 | 线程池 `getQueue().size()` | 处理能力不足 |

EventLoop 积压的采集示例：

```java
public static void registerPendingTasks(MeterRegistry registry, EventLoopGroup group) {
    int i = 0;
    for (EventExecutor executor : group) {
        if (executor instanceof SingleThreadEventExecutor ex) {
            Gauge.builder("netty.eventloop.pending.tasks", ex, SingleThreadEventExecutor::pendingTasks)
                 .tag("loop", String.valueOf(i++))
                 .register(registry);
        }
    }
}
```

指标体系与告警设计见 [指标监控](/observability/2_metrics)。

---

## 八、常见坑

| # | 问题 | 现象 | 正确做法 |
|---|------|------|----------|
| 1 | 在 EventLoop 中执行阻塞操作（DB、RPC、`Thread.sleep`） | 同一 EventLoop 上所有连接一起卡顿 | 交给业务线程池，见 [核心组件](./4_core_components) |
| 2 | 在 EventLoop 线程中调用 `future.sync()` / `await()` | 自己等自己，Netty 直接抛出 `BlockingOperationException` | 改用 `addListener` 异步回调 |
| 3 | 忘记 `release` ByteBuf | 直接内存持续上涨，出现 LEAK 日志 | 遵循"谁最后使用谁释放"，或用 `SimpleChannelInboundHandler` |
| 4 | 重复 `release` | `IllegalReferenceCountException` | 向后传递消息后不要再释放 |
| 5 | 只 `write` 不 `flush` | 对端收不到数据，内存上涨 | 使用 `writeAndFlush`，或确保有地方统一 `flush` |
| 6 | 未标注 `@Sharable` 的 Handler 被多个 Pipeline 复用 | 添加时抛出 `ChannelPipelineException` | 每个连接 new 新实例 |
| 7 | 带状态的 Handler 标注 `@Sharable` 并共享 | 多个连接状态互相串扰 | 有状态就不共享；共享 Handler 只放无状态逻辑 |
| 8 | 不检查 `isWritable()` 就持续推送 | 慢客户端导致直接内存 OOM | 写前检查，配合写水位与降级策略 |
| 9 | 解码器未设置 `maxFrameLength` 或设置过大 | 恶意超大长度字段耗尽内存 | 按协议上限显式设置，超限直接断开 |
| 10 | 每次重连都新建 `EventLoopGroup` | 线程数随重连次数不断增加 | 全局复用一个 Group，见 [心跳与连接管理](./8_heartbeat) |
| 11 | 未实现 `exceptionCaught` | 异常到达 Pipeline 尾部仅打印警告，连接不会被关闭，逐渐泄漏 | 在最后一个 Handler 中记录日志并按需 `close()` |
| 12 | 未设置心跳，半开连接无人清理 | 连接数只增不减、推送失败无报错 | `IdleStateHandler` + 应用层心跳 |
| 13 | JDK NIO epoll 空轮询 bug | `select` 不阻塞，CPU 100% | Netty 已规避：空轮询次数超过阈值（默认 512）自动重建 Selector，了解即可 |

---

## 小结

- 线程模型：boss 每端口 1 线程，worker 默认核数 × 2，阻塞逻辑交给业务线程池；Linux 上用 Epoll 并保留 NIO 回退。
- 参数：显式设置 `SO_BACKLOG`、`TCP_NODELAY`、客户端连接超时与写水位，缓冲区大小交给操作系统。
- 背压：写前检查 `isWritable()`，代理场景用 `autoRead` 把压力反推给上游；高吞吐场景合并 flush。
- 内存与停机：限制直接内存、测试环境 `PARANOID` 泄漏检测；停机先关端口、通知连接，再依次 `shutdownGracefully`。
- 上线前对照监控指标与常见坑表逐项检查。

> 回到 [模块总览](./0_overview) 查看完整学习路径，或前往 [开发总结-Netty](/interview/11_netty) 复习高频问题。

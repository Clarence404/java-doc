# 心跳与连接管理

> **本篇目标**：掌握用 `IdleStateHandler` 实现应用层心跳、断线重连与在线连接管理，让长连接"断了能发现、发现了能恢复"。
>
> **前置阅读**：[自定义私有协议](./7_custom_protocol)

长连接服务的难点不在"连上"，而在"连着"。本篇依次回答三个问题：怎么发现连接已经坏了（心跳），坏了之后怎么恢复（重连），成千上万条连接怎么管（会话表）。

---

## 一、为什么需要应用层心跳

**结论：TCP 本身无法及时发现"对端已经不在了"，必须由应用层周期性地互发消息来确认连接可用。**

### 1、半开连接

正常关闭时，一方会发送 FIN，另一方的 `channelInactive` 随之触发。但下面几种情况**没有任何报文到达本端**，连接在本端看来依然"正常"：

- **对端宕机或断电**：进程和内核都没机会发 FIN / RST
- **网络中断**：网线拔掉、基站切换、Wi-Fi 掉线
- **NAT / 防火墙超时**：中间设备悄悄删掉了空闲连接的映射表项，之后的报文被直接丢弃

这类连接称为**半开连接**。它们持续占用文件描述符、内存和会话表，服务端向其推送的消息全部石沉大海，而且不会报错。

### 2、TCP keepalive 为什么不够

TCP 自带 keepalive 机制，但它更像一个"兜底"，而不是可依赖的检测手段：

| 维度 | TCP keepalive | 应用层心跳 |
|------|---------------|------------|
| 默认探测时机 | Linux 默认空闲 2 小时后才开始探测（`tcp_keepalive_time=7200`） | 自定义，常见 10s～60s |
| 配置粒度 | 内核参数全局生效，单连接调整依赖平台扩展选项 | 每种连接、每个业务可独立配置 |
| 检测范围 | 只能确认**对端内核**还在响应 | 能确认**对端进程**在正常处理消息 |
| 经过代理 | 只探测到最近一跳（如 Nginx / LB） | 端到端，穿透各级代理 |
| 附带信息 | 无 | 可携带时间戳、负载、版本号等业务数据 |

::: tip 两者可以共存
`SO_KEEPALIVE` 可以打开作为兜底，但心跳判定必须由应用层来做。进程卡死（如 Full GC、死锁）时内核仍会回应 keepalive，只有应用层心跳能发现"连接活着，服务死了"。
:::

---

## 二、IdleStateHandler：空闲检测

**结论：`IdleStateHandler` 本身不发心跳，它只负责"计时"：在指定时间内没有读 / 写时，向后续 Handler 抛出一个 `IdleStateEvent`，由业务决定发心跳还是断连。**

### 1、三个参数

```java
// 读空闲 60s、写空闲 0（不检测）、读写都空闲 0（不检测）
new IdleStateHandler(60, 0, 0, TimeUnit.SECONDS);
```

| 参数 | 触发条件 | 事件状态 | 典型用途 |
|------|----------|----------|----------|
| `readerIdleTime` | 指定时间内没有读到任何数据 | `IdleState.READER_IDLE` | 服务端判定客户端失联 |
| `writerIdleTime` | 指定时间内没有写出任何数据 | `IdleState.WRITER_IDLE` | 客户端定时发送 PING |
| `allIdleTime` | 指定时间内既没读也没写 | `IdleState.ALL_IDLE` | 双向都安静时才探测 |

参数为 `0` 表示关闭对应检测。

### 2、工作原理

- **记录时间**：每次 `channelRead` / `channelReadComplete` 刷新"最后读时间"；每次写操作完成时刷新"最后写时间"。
- **定时检查**：Channel 激活后，在该 Channel 所属的 EventLoop 上调度定时任务；到期时比较"当前时间 − 最后读/写时间"。
- **触发事件**：若已超时，调用 `ctx.fireUserEventTriggered(IdleStateEvent)`，并重新调度下一轮；否则按剩余时间重新调度。

整个过程运行在 IO 线程上，不额外创建线程，开销很小。

::: tip observeOutput
`IdleStateHandler` 还有一个带 `observeOutput` 参数的构造方法。开启后，即使写操作尚未完成，只要出站缓冲区中的数据在被消费，也视为"有写活动"，适合大消息慢速发送的场景。多数业务保持默认（关闭）即可。
:::

### 3、放在 Pipeline 的什么位置

- **放在业务 Handler 之前**：`IdleStateEvent` 沿 Pipeline 向后传播，处理心跳的 Handler 必须在它之后。
- **通常放在编解码器附近的前部**：越靠前，越能统计到所有原始读写，包括尚未解码完成的半包数据。
- **每个 Channel 必须 new 一个实例**：它内部保存计时状态，不是 `@Sharable`。

```java
@Override
protected void initChannel(SocketChannel ch) {
    ch.pipeline()
      .addLast(new IdleStateHandler(90, 0, 0, TimeUnit.SECONDS)) // 空闲检测（每个连接独立实例）
      .addLast(new LengthFieldBasedFrameDecoder(65535, 4, 2, 0, 0))
      .addLast(new ProtocolDecoder())
      .addLast(new ProtocolEncoder())
      .addLast(new HeartbeatServerHandler())                      // 处理空闲事件与 PING
      .addLast(businessHandler);
}
```

---

## 三、心跳方案设计

**结论：最常用的方案是"客户端写空闲时发 PING，服务端读空闲超时就关闭连接"，服务端的超时时间取客户端心跳间隔的 3 倍左右。**

![心跳检测与断线重连](../assets/netty/heartbeat-reconnect.svg)

### 1、谁发、谁判

| 角色 | 空闲检测 | 动作 |
|------|----------|------|
| 客户端 | 写空闲 30s | 发送 PING；连续多次收不到 PONG 则主动断开并重连 |
| 服务端 | 读空闲 90s | 回复 PONG；超时未收到任何数据则关闭连接、清理会话 |

为什么由客户端发起：

- **服务端连接数远多于客户端**，由服务端给几十万连接定时发 PING，成本高
- **客户端更关心连接是否可用**，它需要在断开后第一时间重连
- **任何业务消息都算心跳**：读写空闲是按"有无数据"判断的，业务繁忙时自然不会触发 PING

### 2、超时时间怎么取

**服务端读空闲时间 ≈ 客户端心跳间隔 × 3**（至少 2～3 个间隔）。

- 容忍偶发丢包：丢一两个 PING 不会误杀连接
- 容忍网络抖动与 GC 停顿：客户端可能晚发几秒
- 过大则失联发现慢，过小则误判多，按"业务能接受多久发现断连"来反推

| 场景 | 客户端心跳间隔 | 服务端读空闲 |
|------|----------------|--------------|
| IM / 推送（移动端） | 30s～60s | 90s～180s |
| IoT 设备 | 30s～120s | 间隔 × 3 |
| 内网 RPC | 10s～30s | 30s～90s |

::: warning 移动端与 NAT
运营商 NAT 可能在几分钟内回收空闲映射，心跳间隔不宜超过它；移动端还要兼顾耗电，可按网络类型动态调整间隔。
:::

### 3、服务端：读空闲关闭 + 回复 PONG

以下沿用 [自定义私有协议](./7_custom_protocol) 中的 `ProtocolMessage`，约定 `0x10` 为 PING、`0x11` 为 PONG。

```java
@Slf4j
public class HeartbeatServerHandler extends ChannelInboundHandlerAdapter {

    private static final byte CMD_PING = 0x10;
    private static final byte CMD_PONG = 0x11;

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof IdleStateEvent idle && idle.state() == IdleState.READER_IDLE) {
            // 读空闲超时：客户端大概率已失联，关闭连接（会触发 channelInactive 清理会话）
            log.warn("读空闲超时，关闭连接: {}", ctx.channel().remoteAddress());
            ctx.close();
            return;
        }
        super.userEventTriggered(ctx, evt);
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        if (msg instanceof ProtocolMessage pm && pm.getCommand() == CMD_PING) {
            // 收到 PING 直接回复 PONG，不再向业务 Handler 传递
            ctx.writeAndFlush(ProtocolMessage.of(CMD_PONG, new byte[0]));
            return;
        }
        ctx.fireChannelRead(msg);
    }
}
```

::: tip
`ProtocolMessage.of(cmd, payload)` 是一个示意用的静态工厂，负责填充魔数、版本号等固定字段。`ProtocolMessage` 不含 `ByteBuf`，拦截后无需手动 release；若消息体是引用计数对象，拦截时记得 `ReferenceCountUtil.release(msg)`。
:::

### 4、客户端：写空闲发 PING + 统计丢失的 PONG

```java
@Slf4j
public class HeartbeatClientHandler extends ChannelInboundHandlerAdapter {

    private static final byte CMD_PING = 0x10;
    private static final byte CMD_PONG = 0x11;
    private static final int MAX_MISSED_PONG = 3;

    /** 连续未收到 PONG 的次数；每个连接独立实例，只在 IO 线程访问，无需同步 */
    private int missedPong;

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof IdleStateEvent idle && idle.state() == IdleState.WRITER_IDLE) {
            if (missedPong >= MAX_MISSED_PONG) {
                // 连续多次无响应：主动断开，交给重连逻辑处理
                log.warn("连续 {} 次未收到 PONG，断开连接", missedPong);
                ctx.close();
                return;
            }
            missedPong++;
            ctx.writeAndFlush(ProtocolMessage.of(CMD_PING, new byte[0]))
               .addListener(ChannelFutureListener.CLOSE_ON_FAILURE);
            return;
        }
        super.userEventTriggered(ctx, evt);
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        // 收到任何消息都说明链路可用，清零计数
        missedPong = 0;
        if (msg instanceof ProtocolMessage pm && pm.getCommand() == CMD_PONG) {
            return;
        }
        ctx.fireChannelRead(msg);
    }
}
```

客户端 Pipeline 对应配置 `new IdleStateHandler(0, 30, 0, TimeUnit.SECONDS)`。

---

## 四、断线重连

**结论：在连接失败和 `channelInactive` 两个时机触发重连，用指数退避控制间隔，并复用同一个 `Bootstrap` 和 `EventLoopGroup`。**

### 1、设计要点

| 要点 | 做法 |
|------|------|
| 触发时机 | `connect()` 失败的回调 + 已建立连接断开时的 `channelInactive` |
| 退避策略 | 1s、2s、4s…… 指数增长，设置上限（如 60s），连接成功后归零 |
| 随机抖动 | 在延迟上叠加随机量，避免服务端重启后所有客户端同一时刻涌入 |
| 调度方式 | `eventLoop().schedule(...)`，不阻塞、不额外建线程 |
| 资源复用 | `Bootstrap` 可反复 `connect()`；`EventLoopGroup` 全局只建一次 |
| 主动停止 | 应用关闭时设置标志位，避免关闭过程中又触发重连 |

### 2、代码示例

```java
@Slf4j
public class ReconnectClient {

    private static final long BASE_DELAY_MS = 1_000;
    private static final long MAX_DELAY_MS = 60_000;

    private final String host;
    private final int port;
    /** 全局唯一：绝不能每次重连都 new 一个，否则线程会越积越多 */
    private final EventLoopGroup group = new NioEventLoopGroup();
    private final Bootstrap bootstrap = new Bootstrap();
    private final AtomicInteger attempts = new AtomicInteger();
    private volatile boolean stopped;
    private volatile Channel channel;

    public ReconnectClient(String host, int port) {
        this.host = host;
        this.port = port;
        bootstrap.group(group)
                 .channel(NioSocketChannel.class)
                 .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5_000)
                 .handler(new ChannelInitializer<SocketChannel>() {
                     @Override
                     protected void initChannel(SocketChannel ch) {
                         ch.pipeline()
                           .addLast(new IdleStateHandler(0, 30, 0, TimeUnit.SECONDS))
                           .addLast(new LengthFieldBasedFrameDecoder(65535, 4, 2, 0, 0))
                           .addLast(new ProtocolDecoder())
                           .addLast(new ProtocolEncoder())
                           .addLast(new HeartbeatClientHandler())
                           .addLast(new ReconnectHandler(ReconnectClient.this));
                     }
                 });
    }

    public void connect() {
        if (stopped) {
            return;
        }
        bootstrap.connect(host, port).addListener((ChannelFuture f) -> {
            if (f.isSuccess()) {
                attempts.set(0);
                channel = f.channel();
                log.info("连接成功: {}:{}", host, port);
            } else {
                log.warn("连接失败: {}", f.cause().getMessage());
                scheduleReconnect(f.channel().eventLoop());
            }
        });
    }

    void scheduleReconnect(EventLoop loop) {
        if (stopped) {
            return;
        }
        int n = attempts.getAndIncrement();
        long delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS << Math.min(n, 6));
        // 叠加 0～20% 的随机抖动，打散重连洪峰
        delay += ThreadLocalRandom.current().nextLong(delay / 5 + 1);
        log.info("第 {} 次重连，{} ms 后执行", n + 1, delay);
        loop.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
    }

    public void shutdown() {
        stopped = true;
        if (channel != null) {
            channel.close();
        }
        group.shutdownGracefully();
    }
}
```

```java
@Slf4j
@ChannelHandler.Sharable
public class ReconnectHandler extends ChannelInboundHandlerAdapter {

    private final ReconnectClient client;

    public ReconnectHandler(ReconnectClient client) {
        this.client = client;
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        log.warn("连接断开: {}", ctx.channel().remoteAddress());
        // 断开后在当前 EventLoop 上调度重连
        client.scheduleReconnect(ctx.channel().eventLoop());
        super.channelInactive(ctx);
    }
}
```

::: warning 重连后要恢复会话
TCP 重连成功只是第一步。客户端通常还要重新登录鉴权、重新订阅主题，并按需补拉断线期间的消息（依赖消息序号或 `Last-Event-ID` 一类的游标）。
:::

---

## 五、连接管理

**结论：广播用 `ChannelGroup`，定向推送用"用户 → Channel"会话表，两者都要在连接关闭时自动清理。**

### 1、ChannelGroup：批量操作

`DefaultChannelGroup` 是一个线程安全的 Channel 集合，**Channel 关闭时会自动从组中移除**，适合广播、批量关闭等场景。

```java
// 全局广播组
private static final ChannelGroup ALL = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);

ALL.add(channel);                                  // 连接建立时加入
ALL.writeAndFlush(ProtocolMessage.of(CMD_NOTICE, payload)); // 广播
ALL.close().awaitUninterruptibly();                // 停机时批量关闭（勿在 IO 线程中调用）
```

### 2、在线会话表：用户 → Channel

定向推送需要按用户找到连接。用 `ConcurrentHashMap` 维护映射，同时用 `AttributeKey` 把用户 ID 绑定到 Channel 上，便于反查。

```java
@Slf4j
@Component
public class SessionManager {

    public static final AttributeKey<String> USER_ID = AttributeKey.valueOf("userId");

    private final ConcurrentMap<String, Channel> sessions = new ConcurrentHashMap<>();

    /** 登录鉴权成功后调用 */
    public void bind(String userId, Channel channel) {
        channel.attr(USER_ID).set(userId);
        Channel old = sessions.put(userId, channel);
        if (old != null && old != channel) {
            // 同一账号重复登录：踢掉旧连接（也可改为允许多端，value 换成集合）
            log.info("用户 {} 重复登录，关闭旧连接 {}", userId, old.remoteAddress());
            old.close();
        }
    }

    /** channelInactive 时调用 */
    public void unbind(Channel channel) {
        String userId = channel.attr(USER_ID).get();
        if (userId != null) {
            // 两参数 remove：只有映射的仍是当前 Channel 才删除，避免误删新连接
            sessions.remove(userId, channel);
        }
    }

    public boolean push(String userId, Object msg) {
        Channel ch = sessions.get(userId);
        if (ch == null || !ch.isActive()) {
            return false;
        }
        ch.writeAndFlush(msg);
        return true;
    }

    public int onlineCount() {
        return sessions.size();
    }
}
```

```java
@ChannelHandler.Sharable
@RequiredArgsConstructor
public class SessionCleanupHandler extends ChannelInboundHandlerAdapter {

    private final SessionManager sessionManager;

    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        // 无论主动关闭、心跳超时还是对端断开，最终都会走到这里
        sessionManager.unbind(ctx.channel());
        super.channelInactive(ctx);
    }
}
```

::: tip 多节点部署
会话表只存在于本机内存，集群中用户可能连在任意节点上。跨节点推送的方案见 [WebSocket → 集群部署与消息推送](./9_websocket)，无状态化思路见 [水平扩展与无状态化](/high-con/2_scale_out)。
:::

### 3、单机能撑多少连接

空闲长连接本身几乎不消耗 CPU，单机上限主要受以下因素约束：

| 因素 | 说明 | 调整方式 |
|------|------|----------|
| 文件描述符 | 每条连接占用一个 fd，默认 `ulimit -n` 常为 1024 | 调大进程 `nofile` 限制及系统 `fs.file-max` |
| 内存 | 内核 socket 缓冲区 + Netty 对象与缓冲区 + 会话数据 | 控制单连接缓冲大小，合理设置堆与直接内存 |
| 心跳与推送频率 | 连接数 × 心跳频率决定了基础负载 | 适当拉长心跳间隔，合并推送 |
| 端口 | 服务端以四元组区分连接，**不受 65535 端口限制**；只有客户端（或压测机）连同一目标时受本地端口数约束 | 压测机扩大 `ip_local_port_range` 或使用多个源 IP |

具体的内核参数、内存与监控配置见 [生产实践与调优](./11_production)。

---

## 小结

- 半开连接无法被 TCP 及时发现，TCP keepalive 默认 2 小时且只探测内核，必须依赖应用层心跳。
- `IdleStateHandler` 只负责空闲计时并抛出 `IdleStateEvent`，每个 Channel 独立实例、放在业务 Handler 之前。
- 常用方案：客户端写空闲发 PING，服务端读空闲（约 3 倍心跳间隔）关闭连接；任何业务消息都等同于心跳。
- 断线重连在连接失败和 `channelInactive` 时触发，指数退避 + 随机抖动 + 上限，复用 `Bootstrap` 与 `EventLoopGroup`。
- 连接管理用 `ChannelGroup` 做广播、`ConcurrentHashMap` + `AttributeKey` 做定向推送，并在 `channelInactive` 中两参数 `remove` 清理。

> 下一篇：[WebSocket](./9_websocket) —— 把心跳与连接管理用到浏览器长连接上，并解决集群推送问题。

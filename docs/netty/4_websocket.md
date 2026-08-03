# WebSocket

## 一、WebSocket 基础

### 1.1 WebSocket vs HTTP 长轮询 vs SSE

| 维度 | HTTP 长轮询 | SSE | WebSocket |
|------|------------|-----|-----------|
| 协议 | HTTP/1.1 | HTTP/1.1（text/event-stream） | WS / WSS（RFC 6455） |
| 通信方向 | 客户端拉取（伪推送） | 服务端单向推送 | 全双工双向 |
| 连接模型 | 每次请求建立新连接 | 一条长连接，服务端持续写 | 一条持久双向连接 |
| 延迟 | 高（受轮询间隔影响） | 低 | 极低 |
| 服务端并发连接数 | 高（频繁新建连接） | 中（长连接但仅推送） | 中（长连接双向） |
| 浏览器支持 | 全支持 | 全支持（IE 除外） | 全支持（IE 10+） |
| 适用场景 | 兼容性优先、低频更新 | 日志流、通知推送、AI 输出 | 实时聊天、游戏、协同编辑 |

### 1.2 握手升级过程（HTTP → WebSocket）

WebSocket 连接通过 HTTP/1.1 的协议升级机制（Upgrade）发起。

**客户端请求：**

```http
GET /ws HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

**服务端响应：**

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

服务端将 `Sec-WebSocket-Key` 与固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` 拼接后做 SHA-1 + Base64 编码，得到 `Sec-WebSocket-Accept`。握手成功后，底层 TCP 连接继续保持，协议切换为 WebSocket 帧格式，HTTP 不再参与。

---

## 二、Netty 实现 WebSocket 服务端

### 2.1 依赖

```xml
<dependency>
    <groupId>io.netty</groupId>
    <artifactId>netty-all</artifactId>
    <version>4.1.110.Final</version>
</dependency>
```

### 2.2 WebSocketServer（启动类）

```java
public class WebSocketServer {

    private final int port;

    public WebSocketServer(int port) {
        this.port = port;
    }

    public void run() throws InterruptedException {
        EventLoopGroup bossGroup   = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup();
        try {
            ServerBootstrap bootstrap = new ServerBootstrap();
            bootstrap.group(bossGroup, workerGroup)
                     .channel(NioServerSocketChannel.class)
                     .childHandler(new WebSocketServerInitializer("/ws"))
                     .option(ChannelOption.SO_BACKLOG, 128)
                     .childOption(ChannelOption.SO_KEEPALIVE, true);

            ChannelFuture future = bootstrap.bind(port).sync();
            System.out.println("WebSocket server started on port " + port);
            future.channel().closeFuture().sync();
        } finally {
            bossGroup.shutdownGracefully();
            workerGroup.shutdownGracefully();
        }
    }

    public static void main(String[] args) throws InterruptedException {
        new WebSocketServer(8080).run();
    }
}
```

### 2.3 WebSocketServerInitializer（Pipeline 组装）

```java
public class WebSocketServerInitializer extends ChannelInitializer<SocketChannel> {

    private final String websocketPath;

    public WebSocketServerInitializer(String websocketPath) {
        this.websocketPath = websocketPath;
    }

    @Override
    protected void initChannel(SocketChannel ch) {
        ChannelPipeline pipeline = ch.pipeline();

        // HTTP 编解码（WebSocket 握手通过 HTTP 完成）
        pipeline.addLast(new HttpServerCodec());
        // 将多个 HttpContent 聚合为一个 FullHttpRequest（握手需要完整请求）
        pipeline.addLast(new HttpObjectAggregator(65536));
        // 心跳检测：读空闲 60s、写空闲 0、全空闲 0
        pipeline.addLast(new IdleStateHandler(60, 0, 0, TimeUnit.SECONDS));
        // WebSocket 握手、ping/pong、close 帧由此处理器自动处理
        pipeline.addLast(new WebSocketServerProtocolHandler(websocketPath, null, true));
        // 业务帧处理
        pipeline.addLast(new WebSocketFrameHandler());
    }
}
```

### 2.4 WebSocketFrameHandler（业务处理）

```java
public class WebSocketFrameHandler extends SimpleChannelInboundHandler<WebSocketFrame> {

    private static final ChannelGroup channels =
            new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);

    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        channels.add(ctx.channel());
        System.out.println("Client connected: " + ctx.channel().remoteAddress());
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        channels.remove(ctx.channel());
        System.out.println("Client disconnected: " + ctx.channel().remoteAddress());
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, WebSocketFrame frame) {
        if (frame instanceof TextWebSocketFrame textFrame) {
            String text = textFrame.text();
            System.out.println("Received: " + text);
            // 广播给所有连接的客户端
            channels.writeAndFlush(new TextWebSocketFrame("Broadcast: " + text));

        } else if (frame instanceof PingWebSocketFrame pingFrame) {
            // 手动处理 Ping：回复 Pong（WebSocketServerProtocolHandler 已自动处理，此处演示手动方式）
            ctx.writeAndFlush(new PongWebSocketFrame(pingFrame.content().retain()));

        } else if (frame instanceof BinaryWebSocketFrame) {
            // 处理二进制帧（如文件传输）
            System.out.println("Binary frame received, size: " + frame.content().readableBytes());

        } else {
            throw new UnsupportedOperationException("Unsupported frame type: " + frame.getClass().getName());
        }
    }

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof IdleStateEvent idleEvent) {
            if (idleEvent.state() == IdleState.READER_IDLE) {
                System.out.println("Reader idle, closing channel: " + ctx.channel().remoteAddress());
                ctx.close();
            }
        } else {
            super.userEventTriggered(ctx, evt);
        }
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        cause.printStackTrace();
        ctx.close();
    }
}
```

### 2.5 心跳机制说明

| 帧类型 | 作用 | Netty 处理方式 |
|--------|------|---------------|
| Ping | 客户端或服务端探活 | `WebSocketServerProtocolHandler` 自动回复 Pong |
| Pong | 对 Ping 的响应 | 直接消费，不传递给业务 Handler |
| `IdleStateHandler` | 检测读/写空闲 | 触发 `IdleStateEvent`，业务代码决定是否关闭连接 |

推荐做法：`IdleStateHandler` 的读空闲时间设置为客户端心跳间隔的 1.5 倍，避免网络抖动误判。

---

## 三、Spring WebSocket

### 3.1 依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-websocket</artifactId>
</dependency>
```

### 3.2 WebSocketHandler（消息处理）

```java
@Component
public class ChatWebSocketHandler extends TextWebSocketHandler {

    private final CopyOnWriteArrayList<WebSocketSession> sessions = new CopyOnWriteArrayList<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        String payload = message.getPayload();
        // 广播
        for (WebSocketSession s : sessions) {
            if (s.isOpen()) {
                s.sendMessage(new TextMessage("Broadcast: " + payload));
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }
}
```

### 3.3 WebSocket 配置

```java
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    @Autowired
    private ChatWebSocketHandler chatWebSocketHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(chatWebSocketHandler, "/ws/chat")
                .setAllowedOrigins("*");           // 生产环境替换为具体域名
    }
}
```

### 3.4 与 STOMP/SockJS 的关系

- **SockJS**：为不支持 WebSocket 的浏览器提供降级方案（长轮询等），通过 `.withSockJS()` 启用。
- **STOMP**：基于 WebSocket 的消息协议，提供订阅/发布语义，Spring 通过 `@MessageMapping` + `@SendTo` 支持。

---

## 四、使用场景

| 场景 | 说明 |
|------|------|
| 实时聊天 | 文字、表情、文件，需要双向通信，WebSocket 是首选 |
| 在线协同编辑 | 多用户光标同步、文档变更广播（如 Google Docs） |
| 股票 / 行情推送 | 服务端高频推送价格变动，客户端偶发下单指令 |
| 多人实时游戏 | 玩家操作、位置同步，延迟敏感，要求极低 RTT |
| IoT 设备控制 | 服务端下发控制指令，设备上报状态 |

---
description: 握手与帧格式、Netty 与 Spring 两种实现、集群部署下的消息推送
---

# WebSocket

> **本篇目标**：理解 WebSocket 的握手与帧格式，能用 Netty 和 Spring 分别实现服务端，并解决集群部署下的消息推送问题。
>
> **前置阅读**：[心跳与连接管理](./9_heartbeat)

WebSocket 是浏览器与服务端之间的全双工长连接协议。前面学到的编解码、心跳、会话管理，在这里都会用上；新的问题是：浏览器怎么升级协议，以及用户连在不同节点时消息怎么送达。

---

## 一、WebSocket 基础

### 1、三种"服务端推送"方案对比

**结论：需要双向实时通信选 WebSocket；只需服务端单向推送优先考虑 SSE；长轮询仅作兼容兜底。**

| 维度 | HTTP 长轮询 | SSE | WebSocket |
|------|-------------|-----|-----------|
| 协议 | 普通 HTTP 请求 | HTTP（`text/event-stream`） | WS / WSS（RFC 6455） |
| 通信方向 | 客户端拉取（模拟推送） | 服务端单向推送 | 全双工双向 |
| 连接模型 | 请求挂起，有数据或超时后返回，再发起下一次 | 一条长连接，服务端持续写 | 一条持久双向连接 |
| 实时性 | 一般（每条消息后需重新发起请求） | 高 | 高 |
| 消息开销 | 每次都带完整 HTTP 头 | 小（纯文本行） | 最小（帧头 2～14 字节） |
| 数据格式 | 任意 | 仅 UTF-8 文本 | 文本或二进制 |
| 断线重连 | 天然（每次都是新请求） | 浏览器自动重连 | 需自行实现 |
| 适用场景 | 兼容性优先、低频更新 | 通知、日志流、AI 流式输出 | 聊天、游戏、协同编辑 |

SSE 的细节见下一篇 [SSE（Server-Sent Events）](./11_sse)。

### 2、握手：从 HTTP 升级为 WebSocket

**结论：WebSocket 借用一次 HTTP/1.1 请求完成握手，服务端返回 `101 Switching Protocols` 后，同一条 TCP 连接改为传输 WebSocket 帧。**

客户端请求：

```http
GET /ws HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Origin: https://example.com
```

服务端响应：

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

`Sec-WebSocket-Accept` 的计算方式：

```text
Base64( SHA-1( Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" ) )
```

- **作用**：证明服务端确实理解 WebSocket 协议，防止普通 HTTP 服务被误当成 WebSocket 服务端；它**不是**安全认证手段。
- **鉴权**：通常在握手阶段完成，例如校验 URL 中的 token、Cookie 或 `Origin` 头。

### 3、帧格式

**结论：握手之后，所有数据都以"帧"为单位传输，帧头很小，并通过 opcode 区分文本、二进制和控制帧。**

| 字段 | 长度 | 说明 |
|------|------|------|
| FIN | 1 bit | 是否为消息的最后一帧；大消息可拆成多个分片帧 |
| RSV1～3 | 3 bit | 扩展使用，如压缩扩展 `permessage-deflate` 使用 RSV1 |
| opcode | 4 bit | 帧类型，见下表 |
| MASK | 1 bit | 负载是否掩码；**客户端发往服务端的帧必须掩码**，服务端发出的帧不掩码 |
| Payload len | 7 / 7+16 / 7+64 bit | 负载长度：≤125 直接表示，126 / 127 表示后续 2 / 8 字节为真实长度 |
| Masking-key | 0 / 32 bit | MASK=1 时存在，用于异或还原负载 |
| Payload | 变长 | 实际数据 |

| opcode | 帧类型 | Netty 对应类 |
|--------|--------|--------------|
| `0x0` | 延续帧（分片消息的后续部分） | `ContinuationWebSocketFrame` |
| `0x1` | 文本帧（UTF-8） | `TextWebSocketFrame` |
| `0x2` | 二进制帧 | `BinaryWebSocketFrame` |
| `0x8` | 关闭帧（可携带状态码，如 1000 正常关闭、1001 服务端离开） | `CloseWebSocketFrame` |
| `0x9` | Ping | `PingWebSocketFrame` |
| `0xA` | Pong | `PongWebSocketFrame` |

::: tip 为什么客户端必须掩码
掩码是为了防止恶意页面构造特定字节流，污染中间代理的缓存（缓存投毒攻击），与数据保密无关。真正的加密请使用 `wss://`（WebSocket over TLS）。
:::

---

## 二、Netty 实现 WebSocket 服务端

**结论：Netty 已内置 HTTP 编解码与 WebSocket 协议处理器，业务只需关心文本 / 二进制帧，握手、Ping/Pong、Close 均由框架处理。**

### 1、依赖

```xml
<dependency>
    <groupId>io.netty</groupId>
    <artifactId>netty-all</artifactId>
    <version>4.1.115.Final</version>
</dependency>
```

### 2、启动类

```java
@Slf4j
public class WebSocketServer {

    private final int port;

    public WebSocketServer(int port) {
        this.port = port;
    }

    public void run() throws InterruptedException {
        EventLoopGroup bossGroup = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup();
        try {
            ServerBootstrap bootstrap = new ServerBootstrap();
            bootstrap.group(bossGroup, workerGroup)
                     .channel(NioServerSocketChannel.class)
                     .option(ChannelOption.SO_BACKLOG, 1024)
                     .childOption(ChannelOption.TCP_NODELAY, true)
                     .childHandler(new WebSocketServerInitializer("/ws"));

            Channel serverChannel = bootstrap.bind(port).sync().channel();
            log.info("WebSocket 服务启动，端口 {}", port);
            serverChannel.closeFuture().sync();
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

### 3、Pipeline 组装

```java
public class WebSocketServerInitializer extends ChannelInitializer<SocketChannel> {

    private final String websocketPath;
    /** 无状态 Handler 可共享，避免每个连接都新建 */
    private final WebSocketFrameHandler frameHandler = new WebSocketFrameHandler();

    public WebSocketServerInitializer(String websocketPath) {
        this.websocketPath = websocketPath;
    }

    @Override
    protected void initChannel(SocketChannel ch) {
        ChannelPipeline pipeline = ch.pipeline();
        // 1. 空闲检测：90s 未收到任何数据判定失联（原理见《心跳与连接管理》）
        pipeline.addLast(new IdleStateHandler(90, 0, 0, TimeUnit.SECONDS));
        // 2. HTTP 编解码：握手阶段仍是 HTTP 请求
        pipeline.addLast(new HttpServerCodec());
        // 3. 聚合为 FullHttpRequest：握手需要完整请求
        pipeline.addLast(new HttpObjectAggregator(65536));
        // 4. 可选：permessage-deflate 压缩扩展，需配合 allowExtensions=true
        pipeline.addLast(new WebSocketServerCompressionHandler());
        // 5. 协议处理：握手、Ping/Pong、Close、分片校验；最大帧 64KB（按业务显式设置）
        pipeline.addLast(new WebSocketServerProtocolHandler(websocketPath, null, true, 65536));
        // 6. 业务帧处理
        pipeline.addLast(frameHandler);
    }
}
```

`WebSocketServerProtocolHandler` 替我们做了这些事：

| 帧 / 事件 | 默认处理 | 业务 Handler 是否可见 |
|-----------|----------|------------------------|
| 握手请求 | 校验并返回 101，随后替换 Pipeline 中的 HTTP 编解码为帧编解码 | 否，握手完成后收到 `HandshakeComplete` 事件 |
| Ping | 自动回复 Pong | 否 |
| Pong | 默认丢弃 | 否 |
| Close | 回复 Close 帧并关闭连接 | 否 |
| Text / Binary / Continuation | 原样向后传递 | 是 |

### 4、业务 Handler

```java
@Slf4j
@ChannelHandler.Sharable
public class WebSocketFrameHandler extends SimpleChannelInboundHandler<WebSocketFrame> {

    private static final ChannelGroup CHANNELS = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof WebSocketServerProtocolHandler.HandshakeComplete handshake) {
            // 握手完成：可在这里基于 URI / 请求头做鉴权并绑定用户会话
            log.info("握手完成: {}, uri={}", ctx.channel().remoteAddress(), handshake.requestUri());
            CHANNELS.add(ctx.channel());
            return;
        }
        if (evt instanceof IdleStateEvent idle && idle.state() == IdleState.READER_IDLE) {
            log.warn("读空闲超时，关闭连接: {}", ctx.channel().remoteAddress());
            // 按协议先发 Close 帧再断开，1001 表示服务端主动离开
            ctx.writeAndFlush(new CloseWebSocketFrame(1001, "idle timeout"))
               .addListener(ChannelFutureListener.CLOSE);
            return;
        }
        super.userEventTriggered(ctx, evt);
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, WebSocketFrame frame) {
        if (frame instanceof TextWebSocketFrame textFrame) {
            String text = textFrame.text();
            // 浏览器 API 无法发送 Ping 帧，常用应用层文本消息作为心跳
            if ("ping".equals(text)) {
                ctx.writeAndFlush(new TextWebSocketFrame("pong"));
                return;
            }
            log.debug("收到消息: {}", text);
            CHANNELS.writeAndFlush(new TextWebSocketFrame("Broadcast: " + text));
        } else if (frame instanceof BinaryWebSocketFrame) {
            log.debug("收到二进制帧，大小 {} 字节", frame.content().readableBytes());
        } else {
            // Ping / Pong / Close 已被协议处理器消费，不会走到这里
            log.warn("不支持的帧类型: {}", frame.getClass().getSimpleName());
        }
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        log.error("连接异常: {}", ctx.channel().remoteAddress(), cause);
        ctx.close();
    }
}
```

说明：

- **`ChannelGroup` 会在 Channel 关闭时自动移除**，无需在 `channelInactive` 中手动 remove；定向推送所需的"用户 → Channel"会话表见 [心跳与连接管理 → 连接管理](./9_heartbeat)。
- **`SimpleChannelInboundHandler` 会自动 release 帧**，若要把帧转交给其他线程处理，需先 `frame.retain()`。
- **大消息会被拆成分片**：若业务需要完整消息，可在协议处理器之后加 `WebSocketFrameAggregator`。

### 5、心跳怎么做

**结论：服务端用 `IdleStateHandler` 检测读空闲；心跳消息由客户端发送，浏览器端通常用应用层文本消息实现。**

| 方案 | 做法 | 说明 |
|------|------|------|
| 客户端应用层心跳（推荐） | 浏览器每 30s 发 `"ping"` 文本，服务端回 `"pong"` | 浏览器 WebSocket API 不支持主动发 Ping 帧 |
| 服务端发 Ping 帧 | 服务端写空闲时发 `PingWebSocketFrame` | 浏览器会自动回 Pong，但 JS 层感知不到，客户端无法据此判断断线 |

服务端读空闲时间取客户端心跳间隔的 3 倍左右，理由见 [心跳与连接管理](./9_heartbeat)。

客户端示例：

```javascript
const ws = new WebSocket('wss://example.com/ws?token=xxx');
let heartbeatTimer;

ws.onopen = () => {
    // 每 30s 发送一次应用层心跳
    heartbeatTimer = setInterval(() => ws.send('ping'), 30_000);
};
ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    console.log('收到消息', e.data);
};
ws.onclose = () => {
    clearInterval(heartbeatTimer);
    // 在此按指数退避重连
};
```

---

## 三、Spring WebSocket

**结论：Spring Boot 项目优先使用 `spring-boot-starter-websocket`，简单场景用 `WebSocketHandler`，需要订阅 / 发布语义时用 STOMP。**

### 1、依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-websocket</artifactId>
</dependency>
```

### 2、WebSocketHandler

```java
@Slf4j
@Component
public class ChatWebSocketHandler extends TextWebSocketHandler {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // WebSocketSession.sendMessage 不支持并发调用，用装饰器包装：限制发送耗时与缓冲大小
        WebSocketSession safe = new ConcurrentWebSocketSessionDecorator(session, 10_000, 512 * 1024);
        sessions.put(session.getId(), safe);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String payload = message.getPayload();
        sessions.values().forEach(s -> {
            try {
                if (s.isOpen()) {
                    s.sendMessage(new TextMessage("Broadcast: " + payload));
                }
            } catch (IOException e) {
                log.warn("推送失败: {}", s.getId(), e);
            }
        });
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session.getId());
    }
}
```

### 3、注册与跨域

```java
@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class WebSocketConfig implements WebSocketConfigurer {

    private final ChatWebSocketHandler chatWebSocketHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(chatWebSocketHandler, "/ws/chat")
                // 显式列出允许的来源；需要通配时使用 setAllowedOriginPatterns
                .setAllowedOriginPatterns("https://*.example.com");
    }
}
```

::: warning 不要在生产环境使用 setAllowedOrigins("*")
浏览器发起 WebSocket 握手时会自动携带 Cookie，且 WebSocket 不受同源策略限制。放开所有来源等于允许任意网站以当前用户身份建立连接（跨站 WebSocket 劫持，CSWSH）。务必校验 `Origin`，并在握手时做独立的 token 鉴权。
:::

### 4、@ServerEndpoint、STOMP 与 SockJS

| 方式 | 说明 |
|------|------|
| `@ServerEndpoint` | Jakarta WebSocket（JSR-356）标准注解，使用内嵌容器时需注册 `ServerEndpointExporter` Bean；每个连接一个端点实例，Spring 依赖注入不便 |
| STOMP | 基于 WebSocket 的消息协议，提供订阅 / 发布语义。`@EnableWebSocketMessageBroker` 开启，`@MessageMapping` 处理消息，`SimpMessagingTemplate.convertAndSendToUser` 定向推送 |
| SockJS | 为不支持 WebSocket 的环境提供降级（流式、长轮询等），通过 `.withSockJS()` 启用 |

::: tip
STOMP 可通过 `enableStompBrokerRelay` 把消息中转到 RabbitMQ 等外部 Broker，天然支持多节点，是 Spring 体系下解决集群推送的一种省事方案。
:::

---

## 四、集群部署与消息推送

**结论：WebSocket 连接是有状态的，集群下要么"广播到所有节点，由持有连接的节点下发"，要么"维护用户 → 节点路由表，定向转发"。**

### 1、问题：用户连在哪个节点

业务服务要给用户 u1 推送消息时，并不知道 u1 的连接在哪台 WS 节点上，而每个节点的会话表只在本机内存中。

![WebSocket 集群推送](../assets/netty/websocket-cluster.svg)

### 2、方案对比

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| Redis Pub/Sub 广播 | 所有节点订阅同一频道；消息发布后每个节点查本地会话表，持有连接的节点下发 | 实现简单，无需维护路由 | 每条消息都发给所有节点；Pub/Sub 不持久化，节点断开期间的消息会丢失 |
| MQ 广播消费 | 每个节点以独立消费组（或广播模式）订阅推送主题 | 可靠、可堆积、可重放 | 引入 MQ，节点数多时同样有放大 |
| 路由表定向转发 | 连接建立时写入 Redis：`userId → nodeId`；推送时查表，发到该节点专属的频道 / 队列 | 无广播放大，适合大规模 | 需维护路由一致性：节点宕机后要清理脏数据（TTL + 心跳续期） |

选型建议：

- **节点少、消息量不大**：Redis Pub/Sub 广播，最快落地。
- **消息不能丢**：MQ 广播消费，配合客户端按消息序号补拉。
- **连接规模大、推送以单用户为主**：路由表定向转发。

### 3、Redis Pub/Sub 广播示例

```java
@Slf4j
@Configuration
@RequiredArgsConstructor
public class WsPushConfig {

    public static final String PUSH_TOPIC = "ws:push";

    private final SessionManager sessionManager;   // 本机会话表
    private final ObjectMapper objectMapper;

    @Bean
    public RedisMessageListenerContainer wsPushListener(RedisConnectionFactory factory) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        container.addMessageListener((message, pattern) -> {
            try {
                PushMessage msg = objectMapper.readValue(message.getBody(), PushMessage.class);
                // 只有本机持有该用户连接时才下发，其余节点直接忽略
                if (sessionManager.push(msg.userId(), new TextWebSocketFrame(msg.content()))) {
                    log.debug("已推送给用户 {}", msg.userId());
                }
            } catch (IOException e) {
                log.error("推送消息解析失败", e);
            }
        }, new ChannelTopic(PUSH_TOPIC));
        return container;
    }
}

public record PushMessage(String userId, String content) {}
```

```java
// 业务侧：任意节点、任意服务均可发布
stringRedisTemplate.convertAndSend(WsPushConfig.PUSH_TOPIC, objectMapper.writeValueAsString(msg));
```

### 4、负载均衡与 Nginx 配置

**结论：反向代理必须透传 `Upgrade` / `Connection` 头并使用 HTTP/1.1，同时把读超时调大到心跳间隔以上。**

```nginx
# 根据是否有 Upgrade 头决定 Connection 取值
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream ws_backend {
    server 10.0.0.11:8080;
    server 10.0.0.12:8080;
}

server {
    listen 443 ssl;
    server_name ws.example.com;

    location /ws {
        proxy_pass http://ws_backend;
        proxy_http_version 1.1;                        # WebSocket 升级依赖 HTTP/1.1
        proxy_set_header Upgrade $http_upgrade;        # 透传升级头
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;                       # 默认 60s，需大于心跳间隔
        proxy_send_timeout 300s;
    }
}
```

- **粘性会话不是必需的**：WebSocket 建立后始终走同一条 TCP 连接，不存在"请求被分到别的节点"的问题；但 SockJS 的 HTTP 降级传输会发起多次请求，此时需要粘性会话。
- **负载可能不均**：长连接一旦建立不会重新分配，新节点上线后只能分到新连接。可以在发布时让部分客户端断开重连，逐步摊平。
- **节点下线**：先发送 Close 帧（1001）通知客户端，再停止服务，客户端重连会被分到其他节点。停机细节见 [生产实践与调优](./12_production)。

---

## 五、使用场景

| 场景 | 说明 |
|------|------|
| 实时聊天 | 文字、表情、文件，需要双向通信，WebSocket 是首选 |
| 在线协同编辑 | 多用户光标同步、文档变更广播 |
| 股票 / 行情推送 | 服务端高频推送价格变动，客户端偶发下单指令 |
| 多人实时游戏 | 玩家操作、位置同步，延迟敏感 |
| IoT 设备控制 | 服务端下发控制指令，设备上报状态 |

HTTP 升级与 TCP 基础可参考 [HTTP](/protocols/2_http) 与 [TCP 与 UDP](/protocols/1_tcp_udp)。

---

## 小结

- WebSocket 通过一次 HTTP/1.1 Upgrade 握手建立，`Sec-WebSocket-Accept` 只用于协议确认，鉴权要另做。
- 帧头只有 2～14 字节，opcode 区分文本、二进制与 Close / Ping / Pong；客户端发出的帧必须掩码。
- Netty 中 `WebSocketServerProtocolHandler` 已处理握手、Ping/Pong、Close，业务只处理数据帧；心跳用 `IdleStateHandler` + 客户端应用层 ping。
- Spring 中注意 `sendMessage` 非线程安全、`Origin` 必须校验；STOMP 适合订阅 / 发布场景。
- 集群推送三选一：Redis Pub/Sub 广播、MQ 广播、路由表定向转发；Nginx 需透传升级头并调大 `proxy_read_timeout`。

> 下一篇：[SSE（Server-Sent Events）](./11_sse) —— 只需服务端单向推送时，更轻量的 HTTP 流式方案。

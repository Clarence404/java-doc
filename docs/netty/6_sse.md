# SSE（Server-Sent Events）

## 一、SSE 基础

### 1.1 SSE vs WebSocket

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | 服务端单向推送 | 全双工双向 |
| 协议 | HTTP/1.1（text/event-stream） | WS / WSS（RFC 6455） |
| 连接建立 | 标准 HTTP 请求，无需升级握手 | 需要 HTTP Upgrade 握手 |
| 浏览器原生支持 | EventSource API，全现代浏览器 | WebSocket API，全现代浏览器 |
| 自动重连 | 浏览器原生支持（`retry` 字段可配置） | 需客户端手动实现 |
| 代理 / 负载均衡 | 兼容性好，HTTP 协议无需特殊配置 | 部分代理需开启 WebSocket 支持 |
| 适用场景 | 通知推送、日志流、AI token 输出、进度条 | 聊天、游戏、协同编辑 |

### 1.2 SSE 数据格式

SSE 响应的 `Content-Type` 为 `text/event-stream`，每条消息由若干字段行组成，以空行（`\n\n`）结束。

```
id: 42\n
event: orderUpdate\n
data: {"orderId":"ORD-001","status":"SHIPPED"}\n
retry: 3000\n
\n
```

| 字段 | 含义 | 说明 |
|------|------|------|
| `data:` | 事件数据 | 多行 `data:` 会被拼接为一个消息（用 `\n` 连接） |
| `event:` | 事件类型 | 默认为 `message`，客户端可按类型注册监听器 |
| `id:` | 事件 ID | 断线重连时浏览器会在 `Last-Event-ID` 请求头中携带此值 |
| `retry:` | 重连等待（毫秒） | 浏览器重连间隔，默认约 3000ms |

---

## 二、Spring MVC SseEmitter

### 2.1 Controller

```java
@RestController
@RequestMapping("/sse")
public class SseController {

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream() {
        // 超时时间设置为 5 分钟；设为 0L 表示永不超时（需结合心跳机制）
        SseEmitter emitter = new SseEmitter(5 * 60 * 1000L);

        // 在独立线程中推送，避免阻塞 HTTP 线程池
        CompletableFuture.runAsync(() -> {
            try {
                for (int i = 1; i <= 10; i++) {
                    emitter.send(
                        SseEmitter.event()
                                  .id(String.valueOf(i))
                                  .name("progress")
                                  .data("Step " + i + " completed")
                                  .reconnectTime(3000)
                    );
                    Thread.sleep(500);
                }
                emitter.complete();
            } catch (IOException | InterruptedException e) {
                emitter.completeWithError(e);
            }
        });

        emitter.onTimeout(emitter::complete);
        emitter.onError(emitter::completeWithError);

        return emitter;
    }
}
```

### 2.2 客户端 JavaScript（EventSource）

```javascript
const es = new EventSource('/sse/stream');

// 监听默认 message 事件
es.onmessage = (event) => {
    console.log('data:', event.data, 'lastEventId:', event.lastEventId);
};

// 监听自定义事件类型
es.addEventListener('progress', (event) => {
    console.log('progress:', event.data);
});

es.onerror = (err) => {
    console.error('SSE error', err);
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    if (es.readyState === EventSource.CLOSED) {
        console.log('Connection closed');
    }
};

// 主动关闭连接
// es.close();
```

### 2.3 SseEmitter 生命周期与注意事项

- `emitter.complete()`：正常结束，客户端收到后不再重连。
- `emitter.completeWithError(ex)`：以错误结束，客户端会按 `retry` 间隔尝试重连。
- 默认超时（30s）会触发 `SseEmitter$SseEmitterHandler` 抛出异常，务必配置合适的超时或设为 `0L`。
- 生产环境推荐维护一个 `ConcurrentHashMap<String, SseEmitter>` 按用户 ID 存储，用于服务端主动推送特定用户。

---

## 三、Spring WebFlux（响应式）

### 3.1 Flux 返回 SSE 流

```java
@RestController
@RequestMapping("/sse")
public class ReactiveSseController {

    @GetMapping(value = "/flux", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> fluxStream() {
        return Flux.interval(Duration.ofMillis(500))
                   .take(20)
                   .map(seq -> ServerSentEvent.<String>builder()
                           .id(String.valueOf(seq))
                           .event("tick")
                           .data("Tick #" + seq)
                           .retry(Duration.ofSeconds(3))
                           .build());
    }
}
```

### 3.2 结合外部数据源（如 Kafka / RabbitMQ）

```java
@GetMapping(value = "/orders/{userId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<OrderEvent>> orderUpdates(@PathVariable String userId) {
    return orderEventService.streamByUser(userId)   // 返回 Flux<OrderEvent>
            .map(event -> ServerSentEvent.<OrderEvent>builder()
                    .id(event.getEventId())
                    .event("orderUpdate")
                    .data(event)
                    .build())
            .doOnCancel(() -> log.info("Client {} disconnected", userId));
}
```

> [!tip]
> WebFlux 的背压（backpressure）机制可天然防止慢消费者拖垮服务端，是高并发推送场景的推荐选择。

---

## 四、Netty 原生实现 SSE

适用于不使用 Spring 框架，需要直接基于 Netty 提供 SSE 端点的场景。

### 4.1 Pipeline 组装

```java
public class SseServerInitializer extends ChannelInitializer<SocketChannel> {

    @Override
    protected void initChannel(SocketChannel ch) {
        ch.pipeline()
          .addLast(new HttpServerCodec())
          .addLast(new HttpObjectAggregator(65536))
          .addLast(new SseHandler());
    }
}
```

### 4.2 SseHandler

```java
public class SseHandler extends SimpleChannelInboundHandler<FullHttpRequest> {

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (!request.uri().startsWith("/sse")) {
            ctx.fireChannelRead(request.retain());
            return;
        }

        // 发送 SSE 响应头（Transfer-Encoding: chunked + text/event-stream）
        HttpResponse response = new DefaultHttpResponse(
                HttpVersion.HTTP_1_1, HttpResponseStatus.OK);
        response.headers()
                .set(HttpHeaderNames.CONTENT_TYPE, "text/event-stream; charset=UTF-8")
                .set(HttpHeaderNames.CACHE_CONTROL, "no-cache")
                .set(HttpHeaderNames.CONNECTION, HttpHeaderValues.KEEP_ALIVE)
                .set(HttpHeaderNames.TRANSFER_ENCODING, HttpHeaderValues.CHUNKED);
        ctx.writeAndFlush(response);

        // 模拟周期性推送（实际场景替换为业务数据源）
        ctx.executor().scheduleAtFixedRate(() -> {
            if (!ctx.channel().isActive()) return;
            String event = "data: " + System.currentTimeMillis() + "\n\n";
            ByteBuf buf = ctx.alloc().buffer();
            buf.writeCharSequence(event, CharsetUtil.UTF_8);
            ctx.writeAndFlush(new DefaultHttpContent(buf));
        }, 0, 1, TimeUnit.SECONDS);
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        cause.printStackTrace();
        ctx.close();
    }
}
```

> [!warning]
> 上述示例中的定时任务未做生命周期管理。生产场景应在 `channelInactive` 中取消 `ScheduledFuture`，避免内存泄漏。

---

## 五、使用场景

| 场景 | 说明 |
|------|------|
| AI 流式输出（LLM Token Streaming） | ChatGPT / DeepSeek 等 LLM 逐 token 推送，用 SSE 实现打字机效果 |
| 订单 / 支付状态推送 | 支付回调后服务端主动通知前端页面，无需轮询 |
| 实时日志展示 | CI/CD 构建日志、容器启动日志实时回显到浏览器 |
| 进度条与任务状态 | 文件导出、数据处理等长任务的进度实时上报 |
| 通知与消息提醒 | 服务端向已登录用户推送系统通知，替代轮询 `/notifications` |

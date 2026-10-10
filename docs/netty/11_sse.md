---
description: 数据格式、SseEmitter 与 WebFlux、Netty 原生实现、反向代理配置
---

# SSE（Server-Sent Events）

> 前置阅读：[WebSocket](./10_websocket)

SSE 是基于普通 HTTP 响应的服务端单向推送，无需协议升级，是通知、进度、AI 流式输出等场景的首选。本篇讲它的数据格式、Spring MVC / WebFlux / Netty 三种实现，以及超时、心跳和反向代理缓冲的处理。

---

## 一、SSE 基础

### 1、SSE vs WebSocket

**结论：只需服务端推送时选 SSE，更简单、自带重连；需要客户端高频上行或传输二进制时选 WebSocket。**

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | 服务端单向推送（客户端上行走普通 HTTP 请求） | 全双工双向 |
| 协议 | 普通 HTTP 响应（`text/event-stream`） | WS / WSS（RFC 6455） |
| 连接建立 | 标准 GET 请求，无需升级握手 | 需要 HTTP Upgrade 握手 |
| 数据格式 | 仅 UTF-8 文本 | 文本或二进制 |
| 浏览器 API | `EventSource` | `WebSocket` |
| 自动重连 | 浏览器原生支持，可用 `retry` 字段调整间隔，携带 `Last-Event-ID` 续传 | 需自行实现 |
| 代理 / 网关 | 走普通 HTTP，但需关闭响应缓冲 | 需代理支持 Upgrade |
| 适用场景 | 通知推送、日志流、AI token 输出、进度条 | 聊天、游戏、协同编辑 |

### 2、数据格式

**结论：每条事件由若干 `字段: 值` 行组成，以一个空行结束；以冒号开头的行是注释，常用作心跳。**

响应头：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=UTF-8
Cache-Control: no-cache
Connection: keep-alive
```

响应体（每行以 `\n` 结尾，事件之间用空行分隔）：

```text
id: 42
event: orderUpdate
data: {"orderId":"ORD-001","status":"SHIPPED"}
retry: 3000

: ping

data: 第一行
data: 第二行

```

| 字段 | 含义 | 说明 |
|------|------|------|
| `data:` | 事件数据 | 同一事件内多行 `data:` 会用 `\n` 拼接成一条消息 |
| `event:` | 事件类型 | 缺省为 `message`，客户端可按类型分别监听 |
| `id:` | 事件 ID | 断线重连时浏览器会在 `Last-Event-ID` 请求头中带上最后收到的 ID |
| `retry:` | 重连间隔（毫秒） | 告诉浏览器断开后等待多久再重连，浏览器默认值由实现决定（通常为数秒） |
| `: 注释` | 注释行 | 客户端忽略，常用于心跳保活 |

### 3、浏览器连接数限制

**结论：HTTP/1.1 下浏览器对同一域名的并发连接通常只有 6 个，SSE 会长期占用其中一个；多开标签页时容易耗尽，HTTP/2 下可缓解。**

- **HTTP/1.1**：每个 SSE 连接独占一条 TCP 连接。同一浏览器打开多个标签页，每页一个 SSE，很快占满 6 个连接，其他普通请求开始排队。
- **HTTP/2**：多个请求复用同一条连接，并发流数量由双方协商（通常为 100 左右），基本不再受此限制。
- **应对**：优先在网关启用 HTTP/2；或让同一页面只建一个 SSE，多种事件用 `event` 字段区分；多标签页可借助 `BroadcastChannel` / `SharedWorker` 共享连接。

---

## 二、Spring MVC：SseEmitter

### 1、基本用法

**结论：`SseEmitter` 基于 Servlet 异步请求，Controller 立即返回，后续由其他线程调用 `send()` 推送；务必显式设置超时并注册回调。**

```java
@Slf4j
@RestController
@RequestMapping("/sse")
@RequiredArgsConstructor
public class SseController {

    /** 专用线程池：不要用 ForkJoinPool.commonPool 执行可能阻塞的推送任务 */
    private final ThreadPoolTaskExecutor sseExecutor;

    @GetMapping(value = "/progress", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter progress() {
        // 显式超时 5 分钟
        SseEmitter emitter = new SseEmitter(Duration.ofMinutes(5).toMillis());

        // 先注册回调，再启动异步任务
        emitter.onTimeout(() -> {
            log.info("SSE 超时");
            emitter.complete();
        });
        emitter.onError(e -> log.warn("SSE 异常: {}", e.getMessage()));
        emitter.onCompletion(() -> log.debug("SSE 结束"));

        sseExecutor.execute(() -> {
            try {
                for (int i = 1; i <= 10; i++) {
                    emitter.send(SseEmitter.event()
                            .id(String.valueOf(i))
                            .name("progress")
                            .data("Step " + i + " completed")
                            .reconnectTime(3000));
                    Thread.sleep(500);
                }
                emitter.complete();
            } catch (IOException e) {
                // 通常是客户端已断开
                emitter.completeWithError(e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                emitter.completeWithError(e);
            }
        });
        return emitter;
    }
}
```

### 2、超时与生命周期

| 方法 / 回调 | 含义 |
|-------------|------|
| `new SseEmitter(timeout)` | 设置本次异步请求超时（毫秒）；传 `0L` 表示不超时，须配合心跳和清理 |
| `new SseEmitter()` | 未指定时回退到 MVC 异步请求超时 `spring.mvc.async.request-timeout`；若也未配置，则使用 Servlet 容器默认值（Tomcat 通常为 30s） |
| `complete()` | 正常结束响应 |
| `completeWithError(ex)` | 以异常结束，交由 MVC 异常处理流程 |
| `onTimeout` | 超时时回调；若不处理，Spring 通常会以 `AsyncRequestTimeoutException` 结束请求 |
| `onError` | 异步处理出错（如客户端断开导致写失败）时回调 |
| `onCompletion` | 无论正常结束、超时还是出错，最终都会回调，**适合放清理逻辑** |

::: warning 重连语义
`complete()` 只是结束了这次 HTTP 响应，**浏览器 `EventSource` 仍会按 `retry` 间隔自动重连**。若希望彻底停止，需要客户端调用 `es.close()`，或服务端返回 204 等非 200 响应让浏览器放弃重连。
:::

### 3、用户维度推送：Emitter 注册表

**结论：按用户 ID 维护 `ConcurrentHashMap<String, SseEmitter>`，在回调中两参数 `remove` 清理，并定时发送注释行心跳。**

```java
@Slf4j
@Component
public class SseEmitterRegistry {

    private static final long TIMEOUT_MS = Duration.ofMinutes(30).toMillis();

    private final ConcurrentMap<String, SseEmitter> emitters = new ConcurrentHashMap<>();

    /** 用户建立 SSE 连接时调用 */
    public SseEmitter register(String userId) {
        SseEmitter emitter = new SseEmitter(TIMEOUT_MS);

        // 两参数 remove：只删除仍指向当前 emitter 的映射，避免误删新连接
        Runnable cleanup = () -> emitters.remove(userId, emitter);
        emitter.onCompletion(cleanup);
        emitter.onTimeout(emitter::complete);
        emitter.onError(e -> cleanup.run());

        SseEmitter old = emitters.put(userId, emitter);
        if (old != null) {
            old.complete();   // 同一用户重复连接，结束旧连接
        }
        return emitter;
    }

    /** 业务侧定向推送 */
    public boolean send(String userId, String event, Object data) {
        SseEmitter emitter = emitters.get(userId);
        if (emitter == null) {
            return false;
        }
        try {
            emitter.send(SseEmitter.event().name(event).data(data));
            return true;
        } catch (IOException e) {
            log.debug("推送失败，移除连接: {}", userId);
            emitters.remove(userId, emitter);
            emitter.completeWithError(e);
            return false;
        }
    }

    /** 每 15s 发送注释行心跳，防止代理 / 负载均衡切断空闲连接（需 @EnableScheduling） */
    @Scheduled(fixedRate = 15_000)
    public void heartbeat() {
        emitters.forEach((userId, emitter) -> {
            try {
                emitter.send(SseEmitter.event().comment("ping"));   // 输出 ": ping"
            } catch (IOException e) {
                emitters.remove(userId, emitter);
                emitter.completeWithError(e);
            }
        });
    }
}
```

```java
@GetMapping(value = "/subscribe", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter subscribe(@AuthenticationPrincipal UserPrincipal user) {
    return registry.register(user.getId());
}
```

::: tip
- **多标签页 / 多端**：同一用户需要多个连接时，把 value 换成 `Set<SseEmitter>`（如 `ConcurrentHashMap.newKeySet()`）。
- **集群部署**：注册表只在本机内存，跨节点推送与 WebSocket 相同，见 [WebSocket → 集群部署与消息推送](./10_websocket)。
- **同一 emitter 不要并发 send**：多个线程可能同时推送时，对单个 emitter 加锁或串行化。
:::

### 4、客户端：EventSource

```javascript
const es = new EventSource('/sse/subscribe', { withCredentials: true });

// 默认 message 事件
es.onmessage = (e) => console.log('data:', e.data, 'id:', e.lastEventId);

// 自定义事件类型（对应服务端 name("orderUpdate")）
es.addEventListener('orderUpdate', (e) => {
    const order = JSON.parse(e.data);
    console.log('订单更新', order);
});

es.onerror = () => {
    // readyState：0=CONNECTING（正在重连）、1=OPEN、2=CLOSED
    if (es.readyState === EventSource.CLOSED) {
        console.warn('连接已关闭，不再自动重连');
    }
};

// 页面不再需要时主动关闭，避免浏览器持续重连
// es.close();
```

::: tip
原生 `EventSource` 只支持 GET，且不能自定义请求头（无法携带 `Authorization`）。需要 POST 请求体或自定义头时（如 AI 对话接口），可以用 `fetch` + `ReadableStream` 自行解析事件流。
:::

---

## 三、Spring WebFlux：Flux 流

**结论：WebFlux 直接返回 `Flux<ServerSentEvent<T>>`，客户端断开时自动取消订阅，天然具备背压，适合高并发推送。**

### 1、基本用法

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

### 2、业务事件 + 心跳合流

```java
@GetMapping(value = "/orders/{userId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<OrderEvent>> orderUpdates(@PathVariable String userId) {
    // 业务事件流（来自 Kafka / RabbitMQ / Redis 等）
    Flux<ServerSentEvent<OrderEvent>> events = orderEventService.streamByUser(userId)
            .map(event -> ServerSentEvent.<OrderEvent>builder()
                    .id(event.getEventId())
                    .event("orderUpdate")
                    .data(event)
                    .build());

    // 每 15s 一条注释心跳
    Flux<ServerSentEvent<OrderEvent>> heartbeat = Flux.interval(Duration.ofSeconds(15))
            .map(i -> ServerSentEvent.<OrderEvent>builder().comment("ping").build());

    return Flux.merge(events, heartbeat)
               .doOnCancel(() -> log.info("用户 {} 断开 SSE", userId));
}
```

::: tip
WebFlux 下客户端断开会触发取消信号，上游订阅随之释放，不需要像 `SseEmitter` 那样手动维护注册表的清理逻辑。
:::

---

## 四、Netty 原生实现 SSE

**结论：先写一个不带 Content-Length 的响应头，之后持续写 `HttpContent` 分块；定时任务的 `ScheduledFuture` 要在连接断开时取消。**

适用于不使用 Spring、直接基于 Netty 提供 SSE 端点的场景。

### 1、Pipeline 组装

```java
public class SseServerInitializer extends ChannelInitializer<SocketChannel> {

    @Override
    protected void initChannel(SocketChannel ch) {
        ch.pipeline()
          .addLast(new HttpServerCodec())
          .addLast(new HttpObjectAggregator(65536))
          .addLast(new SseHandler());   // 持有定时任务状态，每个连接独立实例
    }
}
```

### 2、SseHandler

```java
@Slf4j
public class SseHandler extends SimpleChannelInboundHandler<FullHttpRequest> {

    /** 当前连接的推送任务；Handler 非共享，字段只在 IO 线程访问 */
    private ScheduledFuture<?> pushTask;

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (!request.uri().startsWith("/sse")) {
            ctx.fireChannelRead(request.retain());
            return;
        }

        // 1. 响应头：text/event-stream + chunked，不设置 Content-Length
        HttpResponse response = new DefaultHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK);
        response.headers()
                .set(HttpHeaderNames.CONTENT_TYPE, "text/event-stream; charset=UTF-8")
                .set(HttpHeaderNames.CACHE_CONTROL, "no-cache")
                .set(HttpHeaderNames.CONNECTION, HttpHeaderValues.KEEP_ALIVE)
                .set(HttpHeaderNames.TRANSFER_ENCODING, HttpHeaderValues.CHUNKED)
                .set("X-Accel-Buffering", "no");   // 提示 Nginx 不缓冲该响应
        ctx.writeAndFlush(response);

        // 2. 周期推送（实际场景替换为业务数据源）
        pushTask = ctx.executor().scheduleAtFixedRate(() -> {
            if (!ctx.channel().isActive()) {
                return;
            }
            String event = "data: " + System.currentTimeMillis() + "\n\n";
            ByteBuf buf = ctx.alloc().buffer();
            buf.writeCharSequence(event, CharsetUtil.UTF_8);
            ctx.writeAndFlush(new DefaultHttpContent(buf));
        }, 0, 1, TimeUnit.SECONDS);
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        // 3. 连接断开时取消定时任务，否则任务会一直留在 EventLoop 中
        if (pushTask != null) {
            pushTask.cancel(false);
            pushTask = null;
        }
        super.channelInactive(ctx);
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        log.warn("SSE 连接异常: {}", ctx.channel().remoteAddress(), cause);
        ctx.close();
    }
}
```

要点：

- `HttpServerCodec` 看到 `Transfer-Encoding: chunked` 后，会把后续每个 `HttpContent` 编码为一个分块。
- 定时任务运行在该 Channel 的 EventLoop 上，与 IO 操作同线程，不存在并发写问题。
- 生产中通常把数据源换成消息订阅，并结合 [生产实践与调优](./12_production) 中的写水位检查，避免慢客户端撑爆出站缓冲区。

---

## 五、反向代理配置

**结论：SSE 最常见的问题是"本地正常、上线后收不到"或"一次性收到一堆"，几乎都是代理缓冲、压缩或读超时造成的。**

```nginx
location /sse/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;              # 使用 HTTP/1.1 与后端保持长连接
    proxy_set_header Connection "";      # 清除 Connection: close
    proxy_set_header Host $host;

    proxy_buffering off;                 # 关键：关闭响应缓冲，事件即时下发
    proxy_cache off;
    gzip off;                            # 压缩会攒够数据再输出，导致事件延迟
    proxy_read_timeout 3600s;            # 默认 60s，无数据即断开；需大于心跳间隔
}
```

| 问题 | 原因 | 处理 |
|------|------|------|
| 事件攒一批才到 | Nginx 默认开启 `proxy_buffering` | `proxy_buffering off`，或后端返回 `X-Accel-Buffering: no` 头 |
| 开启压缩后事件延迟 | 网关 / CDN 对 `text/event-stream` 做了压缩，压缩器会攒数据 | 对该路径关闭 gzip |
| 约 60s 自动断开 | `proxy_read_timeout` 默认 60s | 调大超时 + 服务端定时发 `: ping` 注释心跳 |
| 多层代理仍被切断 | LB、CDN、API 网关各有空闲超时 | 心跳间隔小于整条链路上最短的空闲超时 |

---

## 六、使用场景

| 场景 | 说明 |
|------|------|
| AI 流式输出 | 大模型逐 token 返回，前端实现打字机效果，主流 LLM API 均采用 SSE，详见 [AI 模块](/ai/0_overview) |
| 订单 / 支付状态推送 | 支付回调后服务端主动通知前端，无需轮询 |
| 实时日志展示 | CI/CD 构建日志、容器日志实时回显到浏览器 |
| 进度条与任务状态 | 文件导出、数据处理等长任务的进度上报 |
| 通知与消息提醒 | 向已登录用户推送站内通知，替代轮询 |

---

## 小结

- SSE 是普通 HTTP 响应上的单向推送，格式为 `字段: 值` 行 + 空行，自带重连和 `Last-Event-ID` 续传。
- `SseEmitter` 务必显式设置超时，未设置时回退到 MVC / 容器的异步超时（Tomcat 通常 30s），清理逻辑放在 `onCompletion`。
- 用户维度推送用 `ConcurrentHashMap` 注册表 + 两参数 `remove`，并定时发送 `: ping` 注释心跳。
- Netty 原生实现需在 `channelInactive` 中取消 `ScheduledFuture`；WebFlux 断开时自动取消订阅。
- 上线前检查代理：关闭 `proxy_buffering` 与 gzip、调大 `proxy_read_timeout`；HTTP/1.1 下注意浏览器同域 6 连接限制。

## 参考资料

- SSE 规范（事件格式、EventSource、重连）：[HTML Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- 浏览器端用法：[MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- Spring MVC SseEmitter：[Spring Framework Reference: Asynchronous Requests](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)
- Spring WebFlux 流式响应：[Spring Framework Reference: WebFlux @ResponseBody](https://docs.spring.io/spring-framework/reference/web/webflux/controller/ann-methods/responsebody.html)
- Nginx proxy_buffering / proxy_read_timeout：[NGINX: ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

> 下一篇：[生产实践与调优](./12_production) —— 线程模型、关键参数、背压与优雅停机，把 Netty 服务真正推上生产。

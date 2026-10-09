---
description: 地址、send / publish / request、编解码器、集群 Event Bus、投递语义与陷阱
---

# Event Bus

> **本篇目标**：掌握 Event Bus 的地址模型与三种通信模式，能为自定义类型写编解码器，理解本地与集群 Event Bus 的差别以及「尽力而为、至多一次」的投递语义，知道哪些场景该用 Event Bus、哪些场景必须换成真正的消息队列。
>
> **前置阅读**：[Event Loop 与 Verticle](./2_core)

Event Bus 是 Vert.x 的「神经系统」：每个 `Vertx` 实例有且只有一个 Event Bus，Verticle 之间不直接持有引用，而是往**地址**上发消息、在地址上注册 consumer。它让一个进程内的多个 Verticle 像 Actor 一样通过消息协作；加上 Cluster Manager 后，同一套 API 又能跨进程、跨机器通信。

---

## 一、地址与 consumer

### 1、地址

地址就是一个字符串，没有预先声明，也没有 Topic / Queue 之分。推荐用点分命名空间组织：

| 约定 | 例子 |
|------|------|
| `领域.实体.动作` | `order.payment.completed` |
| 服务调用 | `svc.user.query`、`svc.inventory.reserve` |
| 内部通知 | `internal.config.changed` |

地址字符串最好集中定义为常量，散落在代码里的字符串拼写错误只会表现为「消息没人收」。

### 2、注册与注销

```java
import io.vertx.core.eventbus.EventBus;
import io.vertx.core.eventbus.MessageConsumer;
import io.vertx.core.json.JsonObject;

EventBus bus = vertx.eventBus();

MessageConsumer<JsonObject> consumer = bus.consumer("order.payment.completed", msg -> {
  JsonObject body = msg.body();
  String traceId = msg.headers().get("x-trace-id");
  // 处理消息……
});

// 集群模式下注册需要传播到所有节点，completion() 完成后才能确保其他节点能投递过来
consumer.completion().onSuccess(v -> log.info("consumer ready"));

// 注销（在 Verticle 中注册的 consumer 卸载时会自动注销）
consumer.unregister();
```

consumer 的 Handler 运行在**注册它的 Verticle 的 Context** 上，所以和普通 Handler 一样受黄金法则约束：在标准 Verticle 中注册的 consumer 不能阻塞。

---

## 二、三种通信模式

![Event Bus 三种通信模式](../assets/vertx/eventbus-patterns.svg)

### 1、send：点对点

```java
bus.send("svc.mail.send", new JsonObject().put("to", email).put("tpl", "welcome"));
```

同一地址上有多个 consumer 时，`send` 按**非严格轮询**只投递给其中一个。这是 Vert.x 内建的负载均衡：把一个消费型 Verticle 部署 4 个实例，消息就会在 4 个实例之间分摊。

### 2、publish：广播

```java
bus.publish("internal.config.changed", new JsonObject().put("key", "rate.limit"));
```

地址上的**每一个** consumer 都会收到。典型用途是本地缓存失效通知、配置变更推送、把一条业务事件同时分发给统计与推送两个 Verticle。

### 3、request：请求响应

```java
import io.vertx.core.eventbus.DeliveryOptions;
import io.vertx.core.eventbus.ReplyException;
import io.vertx.core.eventbus.ReplyFailure;

// 服务端
bus.<JsonObject>consumer("svc.user.query", msg -> {
  long id = msg.body().getLong("id");
  userRepo.findById(id)
      .onSuccess(user -> msg.reply(user.toJson()))
      .onFailure(err -> msg.fail(500, err.getMessage()));   // 显式返回失败
});

// 调用端
bus.<JsonObject>request("svc.user.query", new JsonObject().put("id", 42),
        new DeliveryOptions().setSendTimeout(3_000))
    .onSuccess(reply -> log.info("user {}", reply.body()))
    .onFailure(err -> {
      if (err instanceof ReplyException re) {
        switch (re.failureType()) {
          case TIMEOUT -> log.warn("timeout");            // 默认 30s 未收到回复
          case NO_HANDLERS -> log.warn("no consumer");     // 地址上没有任何 consumer
          case RECIPIENT_FAILURE -> log.warn("biz error {} {}", re.failureCode(), re.getMessage());
          default -> log.error("event bus error", re);
        }
      }
    });
```

要点：

- **发送超时默认 30 秒**，对同步调用链来说太长，按下游 SLA 显式设置 `setSendTimeout`；
- 失败分四类：`TIMEOUT`、`NO_HANDLERS`、`RECIPIENT_FAILURE`（对方调用了 `msg.fail`）、`ERROR`，调用方要区分处理，尤其不要对 `RECIPIENT_FAILURE` 无脑重试；
- 服务端如果既不 `reply` 也不 `fail`，调用方只能等到超时，所以 consumer 内的每条异步分支都必须有结局；
- `msg.replyAndRequest(...)` 支持多轮对话，但实际很少需要，多轮交互通常意味着接口设计有问题。

### 4、DeliveryOptions

| 选项 | 默认值 | 作用 |
|------|--------|------|
| `setSendTimeout(ms)` | 30000 | request 的回复超时 |
| `addHeader(k, v)` | 无 | 消息头，常用于传 traceId、租户、版本号 |
| `setCodecName(name)` | 按类型自动选择 | 指定编解码器 |
| `setLocalOnly(true)` | `false` | 集群模式下只投递给本节点的 consumer（对 reply 无效） |
| `setTracingPolicy(...)` | `PROPAGATE` | 链路追踪策略，有活动 trace 时才上报 span |

---

## 三、消息类型与编解码

### 1、开箱支持的类型

基本类型及包装类、`String`、`Buffer`、`JsonObject`、`JsonArray`、`byte[]` 等可以直接发送。**约定俗成的做法是一律用 `JsonObject`**：跨语言（Event Bus 桥可以连浏览器和其他语言客户端）、易于演进、集群序列化无额外配置。

注意本地投递时 `JsonObject` 会被**拷贝**一份，避免发送方和接收方共享可变对象；大消息频繁发送时这份拷贝会带来可观的 GC 压力。

### 2、自定义编解码器

发送领域对象需要实现 `MessageCodec<S, R>`：

```java
import io.vertx.core.buffer.Buffer;
import io.vertx.core.eventbus.MessageCodec;
import io.vertx.core.json.JsonObject;

public record OrderEvent(long orderId, String status) {}

public class OrderEventCodec implements MessageCodec<OrderEvent, OrderEvent> {

  @Override
  public void encodeToWire(Buffer buffer, OrderEvent e) {        // 集群传输时序列化
    Buffer json = new JsonObject().put("orderId", e.orderId()).put("status", e.status()).toBuffer();
    buffer.appendInt(json.length()).appendBuffer(json);
  }

  @Override
  public OrderEvent decodeFromWire(int pos, Buffer buffer) {      // 集群接收时反序列化
    int len = buffer.getInt(pos);
    JsonObject json = buffer.getBuffer(pos + 4, pos + 4 + len).toJsonObject();
    return new OrderEvent(json.getLong("orderId"), json.getString("status"));
  }

  @Override
  public OrderEvent transform(OrderEvent e) {                     // 本地投递：不可变对象直接返回
    return e;
  }

  @Override
  public String name() {
    return "order-event";
  }

  @Override
  public byte systemCodecID() {
    return -1;                                                    // 用户编解码器固定返回 -1
  }
}

// 注册为该类型的默认编解码器，之后 send(addr, orderEvent) 自动使用
vertx.eventBus().registerDefaultCodec(OrderEvent.class, new OrderEventCodec());
```

设计要点：

- `transform` 决定本地投递的语义：对象不可变时（如 `record`）直接返回原对象，**零拷贝**；可变对象必须深拷贝，否则发送方后续修改会影响接收方，破坏 Verticle 的单线程隔离；
- `encodeToWire` / `decodeFromWire` 只在集群跨节点时使用。纯本地使用时可以抛 `UnsupportedOperationException`，但要写明；
- 编解码器要在**每个节点**上注册，集群滚动升级时新旧版本的格式必须兼容；
- `registerCodec` + `DeliveryOptions#setCodecName` 用于同一类型多种编码；`codecSelector(fn)` 可以按对象动态选择编解码器。

### 3、集群模式下的 Java 序列化

集群模式下，实现了 `ClusterSerializable` 或 `java.io.Serializable` 的对象**默认被拒绝**，需要通过 `clusterSerializableChecker` / `serializableChecker` 按类名放行。这是有意的安全设计：反序列化任意类是经典的 RCE 入口。生产环境不建议放行 Java 序列化，用 JSON 或自定义编解码器即可。

---

## 四、本地与集群 Event Bus

### 1、本地 Event Bus

不配置 Cluster Manager 时，Event Bus 只在当前 JVM 内工作：消息投递就是把任务排到目标 consumer 所在 Context 的队列里，没有网络、没有序列化（只有 `transform`），开销在微秒级。

### 2、集群 Event Bus

配置 Cluster Manager 后，各节点通过 Cluster Manager 共享「地址 → 节点」的订阅表，消息本身走**节点之间的 TCP 直连**，不经过 Cluster Manager 中转：

| 环节 | 机制 |
|------|------|
| 注册 consumer | 写入 Cluster Manager 的订阅表，`completion()` 在传播完成后成功 |
| 发送 | 查订阅表选出目标节点，序列化后经 TCP 发送 |
| 本地优先 | 不要依赖选择策略的实现细节；必须只投本节点时用 `localConsumer` 或 `setLocalOnly` |
| 节点下线 | 由 Cluster Manager 检测后清理订阅表，清理完成前发往该节点的消息会失败或丢失 |

`localConsumer(address, handler)` 注册的 consumer 不会传播到集群，适合「每个节点各自处理本地事件」的场景，比如本节点的 WebSocket 连接推送。集群搭建与网络配置见 [集群与生产实践](./6_production)。

### 3、Event Bus 桥

Vert.x Web 提供 SockJS / TCP 桥，把 Event Bus 的一部分地址暴露给浏览器或其他语言客户端：

```java
import io.vertx.ext.bridge.PermittedOptions;
import io.vertx.ext.web.handler.sockjs.SockJSBridgeOptions;
import io.vertx.ext.web.handler.sockjs.SockJSHandler;

SockJSBridgeOptions opts = new SockJSBridgeOptions()
    .addOutboundPermitted(new PermittedOptions().setAddressRegex("push\\.user\\..+"))
    .addInboundPermitted(new PermittedOptions().setAddress("svc.chat.send"));

router.route("/eventbus/*").subRouter(SockJSHandler.create(vertx).bridge(opts));
```

SockJS 的 `POST` 传输需要读取请求体，桥接路径之前要挂好 `BodyHandler`。

**必须用白名单精确控制可访问的地址**，否则外部客户端可以向任意内部服务地址发消息。另外，在桥接入口还需要做鉴权，并把用户身份写进消息头，而不是信任客户端自报的字段。通用的 WebSocket 集群推送方案见 [WebSocket](/netty/10_websocket)。

---

## 五、投递语义

### 1、尽力而为，至多一次

官方对 Event Bus 投递的描述是 **best-effort**：消息在内存中流转，没有持久化，没有确认重传。

| 情况 | 结果 |
|------|------|
| 地址上暂时没有 consumer | `send` / `publish` 直接丢弃；`request` 立即以 `NO_HANDLERS` 失败 |
| 接收节点崩溃 | 已发出、未处理的消息丢失 |
| consumer 处理时抛异常 | 消息不会重投 |
| 进程重启 | 内存中所有在途消息丢失 |
| consumer 处理太慢 | 消息在 consumer 缓冲区堆积；暂停（`pause()`）期间缓冲上限默认 1000 条（`MessageConsumerOptions#setMaxBufferedMessages`），超出部分丢弃 |

因此 Event Bus 的语义可以归纳为**至多一次（at-most-once）**。官方建议：consumer 要幂等，发送方在故障恢复后重试——这就把它变成了业务层的至少一次，幂等的通用做法见 [幂等设计](/architecture/5_idempotence)。

### 2、顺序

同一个发送方发往同一个 consumer 的消息按发送顺序到达。但：

- `send` 在多个 consumer 之间轮询，**跨 consumer 没有顺序**；
- consumer 内部如果发起异步操作，完成顺序取决于下游响应时间，处理结果可能乱序；
- 需要按 key 有序时，可以把 key 哈希到不同地址（如 `order.events.0` … `order.events.7`），每个地址只部署一个 consumer。

### 3、什么时候必须换成消息队列

| 需求 | Event Bus | Kafka / RocketMQ |
|------|-----------|------------------|
| 进程内 Verticle 解耦 | 合适 | 过重 |
| 节点间低延迟 RPC 式调用 | 合适（集群模式） | 不合适 |
| 消息不能丢（订单、支付） | **不合适** | 合适 |
| 消费者离线后补消费、回放 | 不支持 | 支持 |
| 削峰填谷、大量积压 | 不支持（内存） | 支持 |
| 跨团队、跨语言的事件契约 | 弱 | 强 |

**涉及资金与状态变更的事件必须落到持久化消息队列**，Event Bus 只负责进程内的分发。Vert.x 访问 Kafka 的方式见 [响应式数据访问](./5_data)，Kafka 本身的可靠性配置见 [Kafka](/messaging/2_kafka)。

---

## 六、常见模式与陷阱

### 1、服务代理

手写「地址 + JSON + request」的调用样板很多。`vertx-service-proxy` 可以从接口生成代理：调用方像调用本地接口一样拿到 `Future`，底层仍是 Event Bus request。服务端用 `ServiceBinder` 注册，调用方用 `ServiceProxyBuilder` 创建代理。它适合 Verticle 数量多、接口稳定的系统，代价是引入代码生成。

### 2、拦截器

```java
bus.addOutboundInterceptor(dc -> {
  dc.message().headers().add("x-trace-id", currentTraceId());
  dc.next();                              // 必须调用，否则消息被拦截
});
bus.addInboundInterceptor(dc -> {
  metrics.count(dc.message().address());
  dc.next();
});
```

拦截器适合做统一的消息头注入、审计、指标。**忘记调用 `next()` 会让消息静默消失**，这是排查「消息丢失」时首先要看的地方。

### 3、陷阱清单

| 陷阱 | 表现 | 处理 |
|------|------|------|
| consumer 里阻塞 | 同 Event Loop 上所有 Handler 变慢 | 把 consumer 放进 Worker / 虚拟线程 Verticle |
| request 不设超时 | 下游挂了，调用方 30s 后才失败，连接与内存堆积 | 显式 `setSendTimeout`，并配合熔断 |
| 用 Event Bus 传大对象 | 本地拷贝与集群序列化开销大，阻塞 Event Loop | 传 ID 或引用，大数据走共享存储 |
| 可变对象 + `transform` 直接返回 | 发送方与接收方并发修改同一对象 | 用不可变对象或深拷贝 |
| 集群中 consumer 注册未完成就发消息 | 偶发 `NO_HANDLERS` | 等 `completion()` 成功后再宣告就绪 |
| 把 Event Bus 当可靠队列 | 节点重启后订单消息丢失 | 关键事件走 Kafka 等持久化队列 |
| 桥接未设白名单 | 外部可调内部服务地址 | 只放行明确的地址或正则 |

---

## 小结

- 地址是任意字符串，用点分命名空间并集中定义；consumer 在注册它的 Context 上执行，同样不能阻塞
- `send` 点对点轮询、`publish` 广播、`request` 请求响应；request 默认超时 30s，失败分 TIMEOUT / NO_HANDLERS / RECIPIENT_FAILURE / ERROR
- 默认用 `JsonObject` 传消息；自定义类型实现 `MessageCodec`，`transform` 决定本地是否拷贝，集群下默认拒绝 Java 序列化
- 集群 Event Bus 由 Cluster Manager 维护订阅表，消息走节点间 TCP 直连；`localConsumer` / `setLocalOnly` 限定本节点
- 投递是尽力而为、至多一次，无持久化无重投；关键业务事件必须落持久化消息队列，consumer 要幂等
- 拦截器忘记 `next()`、桥接不设白名单、传大对象是最常见的三个坑

## 参考资料

- Vert.x Core 手册 Event Bus 章节：[https://vertx.io/docs/vertx-core/java/#event_bus](https://vertx.io/docs/vertx-core/java/#event_bus)
- `EventBus` API：[https://vertx.io/docs/apidocs/io/vertx/core/eventbus/EventBus.html](https://vertx.io/docs/apidocs/io/vertx/core/eventbus/EventBus.html)
- `DeliveryOptions` API：[https://vertx.io/docs/apidocs/io/vertx/core/eventbus/DeliveryOptions.html](https://vertx.io/docs/apidocs/io/vertx/core/eventbus/DeliveryOptions.html)
- `MessageCodec` API：[https://vertx.io/docs/apidocs/io/vertx/core/eventbus/MessageCodec.html](https://vertx.io/docs/apidocs/io/vertx/core/eventbus/MessageCodec.html)

> 下一篇：[Vert.x Web 与 HTTP 客户端](./4_web) —— 用 Router 和 Handler 链构建 REST 服务，并用 WebClient 调用下游。

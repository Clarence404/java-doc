---
description: 多 Reactor、黄金法则、三种 Verticle、executeBlocking、Context、Future 组合
---

# Event Loop 与 Verticle

> **本篇目标**：理解 Vert.x 的多 Reactor 线程模型与「不要阻塞 Event Loop」这条黄金法则背后的原因；掌握标准、Worker、虚拟线程三种 Verticle 的取舍，学会用 `executeBlocking`、Context 与 Future 组合写出不阻塞、不丢错误的异步代码。
>
> **前置阅读**：[Vert.x 概览](./1_basics)、[Reactor 模型](/netty/2_reactor)

> 参考资料：
> * Vert.x Core 手册：[https://vertx.io/docs/vertx-core/java/](https://vertx.io/docs/vertx-core/java/)
> * `VertxOptions` API：[https://vertx.io/docs/apidocs/io/vertx/core/VertxOptions.html](https://vertx.io/docs/apidocs/io/vertx/core/VertxOptions.html)
> * `ThreadingModel` API：[https://vertx.io/docs/apidocs/io/vertx/core/ThreadingModel.html](https://vertx.io/docs/apidocs/io/vertx/core/ThreadingModel.html)
> * `Future` API：[https://vertx.io/docs/apidocs/io/vertx/core/Future.html](https://vertx.io/docs/apidocs/io/vertx/core/Future.html)

---

## 一、多 Reactor 线程模型

### 1、Event Loop 是什么

Event Loop 是一个循环处理事件的线程：网络数据到达、定时器到期、Event Bus 消息投递、异步操作完成，都会变成一个任务排进某个 Event Loop 的队列，由它依次执行对应的 Handler。Node.js 只有一个 Event Loop，Vert.x 则在每个 `Vertx` 实例里放了**多个 Event Loop**，官方称之为 **Multi-Reactor** 模式：

![Vert.x 多 Reactor 线程模型](../assets/vertx/multi-reactor.svg)

| 线程池 | 默认大小 | 用途 | 配置 |
|--------|----------|------|------|
| Event Loop | 2 × CPU 核数 | IO 事件与所有非阻塞回调 | `VertxOptions#setEventLoopPoolSize` |
| Worker 池 | 20 | `executeBlocking`、Worker Verticle、`blockingHandler` | `VertxOptions#setWorkerPoolSize` |
| 内部阻塞池 | 20 | Vert.x 自己的阻塞操作（如部分文件系统调用） | `VertxOptions#setInternalBlockingPoolSize` |

关键约束：**同一个 Verticle 实例（更准确地说，同一个 Context）的所有 Handler 总是在同一个 Event Loop 线程上执行**。因此 Verticle 内部的字段可以按单线程方式读写，不需要加锁——这是 Vert.x「像写单线程代码一样写并发程序」的根基。

### 2、黄金法则：永远不要阻塞 Event Loop

一个 Event Loop 线程要服务成百上千个连接。如果某个 Handler 里调用了 `Thread.sleep()`、同步 JDBC、`future.get()`、`synchronized` 等锁等待、大文件的同步读写或者一次 200 ms 的 CPU 密集计算，**这个线程上排队的所有其他请求都会被一起拖住**。在 8 核机器上只有 16 个 Event Loop，阻塞两三个就足以让 P99 延迟飙升。

常见的隐性阻塞来源：

| 来源 | 例子 | 处理方式 |
|------|------|----------|
| 同步驱动 | JDBC、同步 Redis 客户端、老版本 SDK | 换响应式客户端，或放到 Worker / 虚拟线程 |
| 同步日志 | 日志直接写网络 Appender、磁盘满导致写阻塞 | 用异步 Appender，见 [日志体系](/observability/1_logging) |
| DNS 解析 | JDK `InetAddress` 同步解析 | Vert.x 自带异步 DNS 解析器，不要绕过 |
| CPU 密集 | 大 JSON 序列化、加解密、压缩、正则回溯 | 拆分或放 Worker |
| 等待异步结果 | `toCompletionStage().toCompletableFuture().join()` | 用 `compose` 串联，或在虚拟线程里 `await()` |

### 3、阻塞线程检查器

Vert.x 内置了一个检查线程，定期检查 Event Loop 与 Worker 线程是否执行单个任务过久：

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `blockedThreadCheckInterval` | 1000 ms | 检查周期 |
| `maxEventLoopExecuteTime` | 2 s | Event Loop 单次执行超时阈值 |
| `maxWorkerExecuteTime` | 60 s | Worker 单次执行超时阈值 |
| `warningExceptionTime` | 5 s | 阻塞超过该时长时，告警附带线程堆栈 |

告警形如 `Thread vertx-eventloop-thread-3 has been blocked for 20458 ms`。它**只告警不打断**，检测到时伤害已经发生；但它是线上排查「为什么偶发全体变慢」最直接的线索。生产建议：

```java
VertxOptions options = new VertxOptions()
    .setMaxEventLoopExecuteTime(200)
    .setMaxEventLoopExecuteTimeUnit(TimeUnit.MILLISECONDS)   // 比默认 2s 更严格
    .setWarningExceptionTime(1)
    .setWarningExceptionTimeUnit(TimeUnit.SECONDS);           // 阻塞超 1s 打堆栈
Vertx vertx = Vertx.vertx(options);
```

把 Event Loop 阈值调低到 100–200 ms 并接入日志告警，能在压测阶段暴露大部分隐性阻塞。开发环境调试断点时会触发大量告警，可以临时调大阈值。

---

## 二、三种 Verticle

### 1、Verticle 的本质

Verticle 是 Vert.x 的部署单元，可以理解为「绑定到一个 Context 上的一组 Handler」。部署时 Vert.x 为它分配一个 Context，而 Context 决定了 Handler 在哪类线程上执行。Vert.x 5 用 `ThreadingModel` 枚举表示这一点：

| `ThreadingModel` | 执行线程 | 能否阻塞 | 典型用途 |
|------------------|----------|----------|----------|
| `EVENT_LOOP`（默认） | 固定的某个 Event Loop | 不能 | HTTP 服务、协议处理、绝大多数业务 |
| `WORKER` | Worker 池中的平台线程，同一实例同一时刻只有一个线程执行 | 可以 | 包装阻塞 SDK、批处理 |
| `VIRTUAL_THREAD` | 虚拟线程（JDK 21+） | 可以，用 `await()` 等待 | 用同步风格写异步逻辑 |
| `EXTERNAL` | 非当前 Vertx 管理的线程 | — | 不用于部署，表示外部线程调用 Vert.x API |

### 2、标准 Verticle

```java
import io.vertx.core.Future;
import io.vertx.core.VerticleBase;
import io.vertx.core.http.HttpServer;

public class ApiVerticle extends VerticleBase {

  private HttpServer server;
  private long requestCount;   // 单线程访问，不需要 AtomicLong

  @Override
  public Future<?> start() {
    return vertx.createHttpServer()
        .requestHandler(req -> {
          requestCount++;
          req.response().end("ok " + requestCount);
        })
        .listen(config().getInteger("port", 8080))
        .onSuccess(s -> server = s);
  }

  @Override
  public Future<?> stop() {
    // 优雅关闭：停止接新请求，等待在途请求完成（默认最长 30s）
    return server == null ? Future.succeededFuture() : server.shutdown();
  }
}
```

`requestCount` 只在本实例自己的 Event Loop 上被访问，所以普通 `long` 足够。**但多个实例之间不共享字段**——部署了 8 个实例就有 8 个计数器，需要全局状态时用 `SharedData` 或外部存储。

### 3、Worker Verticle

```java
DeploymentOptions options = new DeploymentOptions()
    .setThreadingModel(ThreadingModel.WORKER)
    .setWorkerPoolName("legacy-sdk-pool")   // 独立的命名池，避免挤占默认 Worker 池
    .setWorkerPoolSize(8)
    .setInstances(4);
vertx.deployVerticle(LegacySdkVerticle::new, options);
```

Worker Verticle 的实例**不会被多个线程并发执行**，但不同时刻可能由不同线程执行。Vert.x 5 中所有 Worker Verticle 共享同一个 Event Loop（4.x 是每个实例一个），这对普通业务没影响，但不要在 Worker Verticle 里承担高吞吐的网络 IO。

### 4、虚拟线程 Verticle

```java
import io.vertx.core.Future;
import io.vertx.core.VerticleBase;
import io.vertx.ext.web.client.WebClient;
import io.vertx.ext.web.client.HttpResponse;
import io.vertx.core.buffer.Buffer;

public class OrderSyncVerticle extends VerticleBase {

  private WebClient client;

  @Override
  public Future<?> start() {
    client = WebClient.create(vertx);
    vertx.eventBus().<String>consumer("order.sync", msg -> {
      // 运行在虚拟线程上：await() 挂起当前虚拟线程，不占用 Event Loop
      try {
        HttpResponse<Buffer> resp = client.get(8081, "inventory", "/stock/" + msg.body())
            .send()
            .await();
        msg.reply(resp.bodyAsString());
      } catch (Exception e) {
        msg.fail(500, e.getMessage());           // await() 以异常形式抛出失败
      }
    });
    return Future.succeededFuture();
  }
}

// 部署
vertx.deployVerticle(new OrderSyncVerticle(),
    new DeploymentOptions().setThreadingModel(ThreadingModel.VIRTUAL_THREAD));
```

`Future#await()` 会挂起当前线程直到结果返回，**在 Event Loop 或 Worker 线程上调用会抛 `IllegalStateException`**，只能在虚拟线程（或 Vert.x 之外的普通线程）里用。它取代了 4.x 的 Vert.x Sync。注意：

- `await()` 失败时抛出异常而不是返回失败的 Future，要用 `try/catch` 处理；
- 虚拟线程的钉住问题、`ThreadLocal` 开销等通用注意事项见 [虚拟线程](/java/30_topic_virtual_thread)；
- 虚拟线程 Verticle 适合「编排多个下游调用」的业务逻辑，**高吞吐的协议处理仍然放在标准 Verticle**。

### 5、部署与实例数

```java
DeploymentOptions options = new DeploymentOptions()
    .setInstances(Runtime.getRuntime().availableProcessors())
    .setConfig(new JsonObject().put("port", 8080));

vertx.deployVerticle(ApiVerticle::new, options)
    .onSuccess(deploymentId -> log.info("deployed {}", deploymentId))
    .onFailure(err -> log.error("deploy failed", err));

// 卸载：会依次调用每个实例的 stop()，并自动注销其 Event Bus consumer、取消定时器
vertx.undeploy(deploymentId);
```

实例数的经验值：

- **HTTP 服务 Verticle**：实例数 = CPU 核数，让每个核心都有 Event Loop 接连接（多实例共享端口，连接被轮询分配）；
- **Event Bus 消费型 Verticle**：按吞吐压测决定，`send` 会在多个 consumer 之间轮询；
- **单例语义的 Verticle**（如定时调度器）：实例数必须为 1，集群下还要配合分布式锁。

`deployVerticle` 中的 `Supplier` 会在调用线程上执行，构造函数里不要做 IO；初始化逻辑放 `start()`，其返回的 Future 失败会让整个部署失败。

---

## 三、executeBlocking 与 Context

### 1、executeBlocking

Vert.x 5 中 `executeBlocking` 接收一个 `Callable`：

```java
Future<byte[]> pdf = vertx.executeBlocking(() -> pdfRenderer.render(order));   // 默认 ordered = true

pdf.onSuccess(bytes -> ctx.response()
        .putHeader("Content-Type", "application/pdf")
        .end(Buffer.buffer(bytes)))
   .onFailure(ctx::fail);
```

- 代码在 Worker 线程执行，结果回到**调用者原来的 Context**（即原来的 Event Loop）上回调，所以回调里依然可以放心访问 Verticle 字段；
- `ordered` 默认 `true`：同一个 Context 上多次调用会**串行执行**。如果任务彼此独立，传 `false` 才能并行，否则一个慢任务会堵住后面所有任务；
- 默认 Worker 池只有 20 个线程且全局共享，**不同类型的阻塞任务应当用不同的命名池隔离**：

```java
WorkerExecutor reportPool = vertx.createSharedWorkerExecutor("report-pool", 4);
reportPool.executeBlocking(() -> heavyReport(params), false);
// 不再使用时调用 reportPool.close()
```

这和 [池化技术](/high-perf/7_pooling) 中「线程池按业务隔离」是同一个思路。

### 2、Context

Context 是 Vert.x 调度的核心：每个 Handler 都在某个 Context 上执行，Context 绑定了线程模型、所属部署、配置与一个本地数据 Map。

```java
Context context = vertx.getOrCreateContext();

context.runOnContext(v -> {
  // 在该 Context 的线程上异步执行
});

context.put("tenant", "t-001");     // Context 级数据，同一 Context 上的 Handler 可见
String tenant = context.get("tenant");

boolean onLoop = Context.isOnEventLoopThread();
ThreadingModel model = context.threadingModel();
```

两个常见误用：

1. **从外部线程调用 Vert.x API**：在 Kafka 原生客户端回调、JDK 线程池里直接操作 Verticle 字段会破坏单线程假设。正确做法是先拿到目标 Context，再 `context.runOnContext(...)` 切回去；
2. **把 Context 数据当请求上下文**：一个 Event Loop 的 Context 会被大量并发请求共享，`context.put` 不是请求级别的。请求级数据放 `RoutingContext`；需要跨异步调用传递的追踪信息交给 Vert.x 的 tracing 集成。

---

## 四、Future 与 Promise

### 1、读端与写端

`Promise<T>` 是写端，负责完成结果；`Future<T>` 是读端，负责注册回调和组合。对外 API 只暴露 `Future`：

```java
public Future<User> loadUser(long id) {
  Promise<User> promise = Promise.promise();
  legacyCallbackApi.find(id, (user, err) -> {
    if (err != null) promise.fail(err);
    else promise.complete(user);
  });
  return promise.future();
}
```

与 `CompletableFuture` 互转：`Future.fromCompletionStage(stage)`、`future.toCompletionStage()`。

### 2、组合操作

| 方法 | 作用 | 类比 |
|------|------|------|
| `map(fn)` | 成功值同步转换 | `thenApply` |
| `compose(fn)` / `flatMap(fn)` | 成功后接一个新的异步操作 | `thenCompose` |
| `recover(fn)` | 失败时返回另一个 Future 兜底 | `exceptionallyCompose` |
| `otherwise(fn / value)` | 失败时给默认值 | `exceptionally` |
| `transform(fn)` | 无论成败都接一个新 Future | `handle` + compose |
| `eventually(supplier)` | 无论成败都执行清理（返回 Future），结果保持原样 | `finally` |
| `andThen(handler)` | 旁路观察结果，不改变结果 | `whenComplete` |
| `timeout(time, unit)` | 超时则失败 | `orTimeout` |
| `expecting(expectation)` | 按条件把成功转成失败（如 HTTP 状态码） | — |

串行调用示例：

```java
Future<OrderView> view = orderRepo.findById(orderId)
    .compose(order -> userClient.get(order.userId())
        .map(user -> new OrderView(order, user)))
    .recover(err -> err instanceof NotFoundException
        ? Future.failedFuture(new HttpException(404))
        : Future.failedFuture(err))
    .timeout(2, TimeUnit.SECONDS);
```

### 3、并发组合：all / any / join

```java
Future<User> user = userClient.get(uid);
Future<List<Coupon>> coupons = couponClient.list(uid);
Future<Integer> points = pointClient.balance(uid);

Future.all(user, coupons, points)
    .map(cf -> new Profile(cf.resultAt(0), cf.resultAt(1), cf.resultAt(2)));
```

| 方法 | 成功条件 | 失败条件 |
|------|----------|----------|
| `Future.all` | 全部成功 | **任一失败立即失败**（其余仍在执行） |
| `Future.any` | 任一成功 | 全部失败 |
| `Future.join` | 全部成功 | 等**全部完成**后，若有失败则失败 |

需要「部分失败也返回部分结果」时，先对每个 Future 做 `otherwise(默认值)`，再 `all`。

### 4、错误处理的坑

- **链尾必须处理失败**：没有 `onFailure` 的失败 Future 会被静默吞掉，请求永远挂起直到客户端超时。HTTP 场景下统一 `.onFailure(ctx::fail)` 交给 failureHandler；
- **Handler 里抛异常**：回调中抛出的未捕获异常会交给 `vertx.exceptionHandler(...)` 或 Context 的异常处理器，不会自动变成失败的 Future。务必设置全局异常处理器记录日志；
- **不要在 `map` 里做 IO**：`map` 是同步转换，返回 Future 的操作要用 `compose`，否则得到的是 `Future<Future<T>>`。

---

## 五、定时器

```java
long timerId = vertx.setTimer(5_000, id -> log.info("5 秒后执行一次"));

long periodicId = vertx.setPeriodic(1_000, 10_000, id -> refreshCache());   // 首次延迟 1s，之后每 10s

vertx.cancelTimer(periodicId);

// Future 风格：到期后 Future 成功
vertx.timer(3, TimeUnit.SECONDS).onSuccess(v -> log.info("timeout"));
```

- 定时器回调在**创建它的 Context** 上执行，所以同样不能阻塞；
- `setPeriodic` 不会等上一次执行结束：如果回调里发起了耗时 15s 的异步刷新而周期是 10s，就会出现重叠。需要「上次结束后再等 N 秒」的语义时，用 `setTimer` 在回调完成后递归再设；
- 在 Verticle 中创建的定时器会在卸载时自动取消；在 Verticle 之外创建的要自己管理；
- 定时器只在当前进程内有效，集群中需要「只有一个节点执行」的定时任务，要配合分布式锁或外部调度系统，参考 [分布式调度](/distributed/6_job_scheduler)。

---

## 小结

- 每个 `Vertx` 有多个 Event Loop（默认 2 × 核数），同一 Verticle 实例的回调始终在同一线程执行，内部状态不需要加锁
- 黄金法则：不阻塞 Event Loop；阻塞检查器默认 Event Loop 2s、Worker 60s 告警，生产建议把 Event Loop 阈值降到 100–200 ms
- Vert.x 5 用 `ThreadingModel` 区分 `EVENT_LOOP` / `WORKER` / `VIRTUAL_THREAD`；虚拟线程 Verticle 里可用 `Future#await()`，在 Event Loop 上调用会抛异常
- HTTP Verticle 实例数取核数并共享端口；单例语义的 Verticle 实例数为 1
- `executeBlocking` 默认 `ordered=true` 会串行，独立任务传 `false`；不同阻塞任务用命名 `WorkerExecutor` 隔离
- Future 组合：`compose` 串行、`Future.all/any/join` 并发；链尾必须处理失败，否则请求静默挂起
- `setPeriodic` 不等上次执行结束，集群单点任务需要分布式锁

> 下一篇：[Event Bus](./3_eventbus) —— Verticle 之间如何通过地址解耦通信，以及点对点、广播、请求响应三种模式的语义与陷阱。

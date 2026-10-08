---
description: 回调线程与默认执行器、任务组合、异常传播、join 与 get、超时与取消、上下文传递、常见坑
---

# CompletableFuture

> **本篇目标**：搞清楚每个回调由哪个线程执行、异常如何沿链传播，能用 `CompletableFuture` 写出线程池隔离、异常可见、有超时预算且能传递 traceId 的并行编排代码，并知道 JDK 21+ 下什么时候改用虚拟线程。
>
> **前置阅读**：[线程基础](./23_topic_thread_basics)、[线程池](./28_topic_thread_pool)

> 参考资料：
> * JDK 25 API：[CompletableFuture](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CompletableFuture.html)、[CompletionStage](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CompletionStage.html)
> * JEP 266（JDK 9 新增超时与延迟执行器等 API）：[https://openjdk.org/jeps/266](https://openjdk.org/jeps/266)
> * [捡田螺的小男孩 - 实现异步的 9 种方式](https://mp.weixin.qq.com/s/eTQwT-zFgHgNVJ_nNAZidw)

`Future` 只能阻塞 `get()`，不能在完成时触发后续动作，也不能组合多个结果。`CompletableFuture`（JDK 8）同时实现了 `Future` 和 `CompletionStage`：既是一个可以被**手动完成**的结果容器，又能在完成时**触发回调链**。后面所有规则都从这两个身份推出来。

---

## 一、创建与完成

### 1、由任务驱动

```java
ExecutorService ioPool = ...;   // 专用、有界的线程池，配置见「线程池」

CompletableFuture<Void>   f1 = CompletableFuture.runAsync(() -> audit(order), ioPool);
CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> userClient.name(uid), ioPool);

CompletableFuture<String> done   = CompletableFuture.completedFuture("cached");             // 已成功完成
CompletableFuture<String> failed = CompletableFuture.failedFuture(new IllegalStateException()); // JDK 9+，已异常完成
```

### 2、手动完成：桥接回调式 API

`new CompletableFuture<>()` 得到一个未完成的 Future，由任意线程调用 `complete` / `completeExceptionally` 完成它，常用于把回调式 API（Netty、异步 HTTP 客户端、MQ 发送回调）转成 `CompletableFuture`：

```java
public CompletableFuture<SendResult> sendAsync(Message msg) {
    CompletableFuture<SendResult> cf = new CompletableFuture<>();
    producer.send(msg, new SendCallback() {
        @Override public void onSuccess(SendResult r)  { cf.complete(r); }
        @Override public void onException(Throwable e) { cf.completeExceptionally(e); }
    });
    return cf;
}
```

- `complete` 只有**第一次**生效，返回 `true`；之后再调用返回 `false`，结果不变。
- 只想把结果暴露给调用方、不允许外部 `complete` 时，返回 `cf.minimalCompletionStage()`（JDK 9+）或 `cf.copy()`。

---

## 二、回调由哪个线程执行

### 1、三种变体

每个回调方法都有三个版本，区别只在**由谁执行**：

![CompletableFuture 回调由哪个线程执行](../assets/java/completable_future_threads.svg)

| 写法 | 执行线程 |
|------|---------|
| `thenApply(fn)` | 注册时上游**未完成**：由**完成上游的那个线程**执行；注册时上游**已完成**：由**调用 `thenApply` 的线程**立即执行 |
| `thenApplyAsync(fn)` | 默认执行器：`ForkJoinPool.commonPool()` |
| `thenApplyAsync(fn, executor)` | 传入的 `executor` |

同步变体从不向任何线程池提交任务，它"搭便车"在别人的线程上执行。这带来两个后果：

- 上游由 `ioPool` 完成时，`thenApply` 的逻辑也跑在 `ioPool` 线程上，耗时的同步回调会占住 IO 线程。
- 上游由 Netty EventLoop、HTTP 客户端的 IO 线程完成时（第一节的桥接写法），同步回调会**阻塞 IO 线程**。重活一律用 `xxxAsync(fn, executor)` 切走。

```java
CompletableFuture.supplyAsync(() -> log("supply"), ioPool)         // io-1
    .thenApply(v -> log("thenApply"))                               // 多半是 io-1；若 supply 已完成则是 main
    .thenApplyAsync(v -> log("async"))                              // ForkJoinPool.commonPool-worker-1
    .thenApplyAsync(v -> log("async+executor"), cpuPool);           // cpu-1
```

### 2、默认执行器与为什么要传自己的

不传执行器的 `xxxAsync` 使用 `CompletableFuture.defaultExecutor()`：

- `ForkJoinPool.commonPool()` 的并行度 **大于 1** 时，就用 `commonPool`；
- 否则（容器只给了 1～2 核，`commonPool` 并行度为 1）退化为 **每个任务新建一个线程**（内部的 `ThreadPerTaskExecutor`），线程数不受控。

生产代码**始终传入自己的线程池**，原因有三：

| 原因 | 说明 |
|------|------|
| 隔离 | `commonPool` 被 `parallelStream` 和所有不传执行器的异步代码共享，阻塞 IO 会拖慢整个 JVM 的并行计算 |
| 容量可控 | 自建线程池有界、可命名、可监控；`commonPool` 大小跟随 CPU 核数，不适合 IO 等待 |
| 上下文传递 | 只有自己的执行器才能统一包装 MDC / ThreadLocal，见第七节 |

需要让某个子类默认使用自定义线程池时，可以重写 `defaultExecutor()` 和 `newIncompleteFuture()`（JDK 9+）。

---

## 三、API 地图

| 方法族 | 入参 | 返回 | 用途 |
|--------|------|------|------|
| `thenApply` | `Function<T, U>` | `CF<U>` | 转换结果 |
| `thenAccept` | `Consumer<T>` | `CF<Void>` | 消费结果 |
| `thenRun` | `Runnable` | `CF<Void>` | 不关心结果，只关心完成 |
| `thenCompose` | `Function<T, CompletionStage<U>>` | `CF<U>` | 下一步本身是异步调用，扁平化 |
| `thenCombine` | 另一个 stage + `BiFunction<T, U, V>` | `CF<V>` | 两个都成功后合并 |
| `thenAcceptBoth` / `runAfterBoth` | 另一个 stage + 消费 / 动作 | `CF<Void>` | 两个都完成后消费 / 执行 |
| `applyToEither` / `acceptEither` / `runAfterEither` | 另一个 stage + 函数 | `CF<U>` / `CF<Void>` | 两者先完成的一个 |
| `exceptionally` | `Function<Throwable, T>` | `CF<T>` | 仅失败时恢复 |
| `handle` | `BiFunction<T, Throwable, U>` | `CF<U>` | 成功失败都处理，可改变结果 |
| `whenComplete` | `BiConsumer<T, Throwable>` | `CF<T>` | 旁路观察，不改变结果 |
| `exceptionallyCompose`（JDK 12） | `Function<Throwable, CompletionStage<T>>` | `CF<T>` | 失败时用另一个异步调用兜底 |

每个方法族都有 **同步 / `Async` / `Async(executor)`** 三个版本；`exceptionally` 的 `Async` 版本与 `exceptionallyCompose` 都是 JDK 12 才加入的。

---

## 四、任务组合

### 1、串行：thenApply 与 thenCompose

```java
// 下一步是同步计算：thenApply
CompletableFuture<UserVO> vo = userF.thenApply(UserVO::from);

// 下一步本身返回 CompletableFuture：thenCompose，否则会得到 CF<CF<List<Order>>>
CompletableFuture<List<Order>> orders = userF.thenCompose(u -> orderClient.listAsync(u.id()));
```

### 2、两两合并：thenCombine

```java
CompletableFuture<Product> productF = CompletableFuture.supplyAsync(() -> productClient.get(id), ioPool);
CompletableFuture<Price>   priceF   = CompletableFuture.supplyAsync(() -> priceClient.get(id), ioPool);

CompletableFuture<DetailVO> detail = productF.thenCombine(priceF, DetailVO::of);   // 两个都成功才执行
```

任意一个失败，合并函数都不会执行，`thenCombine` 产生的 stage 以该异常完成；注意它要等**两个都结束**才完成，不会因为一方先失败就提前返回。

### 3、多个任务：allOf 与 anyOf

`allOf` 返回 `CompletableFuture<Void>`，不带结果；收集结果的惯用写法是在它完成后逐个 `join`（此时不会阻塞）：

```java
static <T> CompletableFuture<List<T>> allAsList(List<CompletableFuture<T>> futures) {
    return CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new))
            .thenApply(v -> futures.stream().map(CompletableFuture::join).toList());
}
```

| | `allOf` | `anyOf` |
|--|---------|---------|
| 何时完成 | **所有**任务都完成（含失败）才完成 | **任意一个**完成（含失败）即完成 |
| 有任务失败时 | 等全部结束后以其中一个异常完成，**不会快速失败** | 第一个完成的若是失败，结果就是失败 |
| 结果类型 | `CompletableFuture<Void>` | `CompletableFuture<Object>`，需要强转 |
| 其他任务 | — | **不会被取消**，仍在继续执行 |

需要"任一失败立即返回"时，给每个子任务挂 `whenComplete`，失败时 `completeExceptionally` 一个外层 Future；JDK 25 也可以用预览中的结构化并发，见第九节。

---

## 五、异常处理

### 1、传播规则

![CompletableFuture 异常沿链传播](../assets/java/completable_future_exception.svg)

- 某个 stage 异常完成后，下游所有**依赖它结果**的 stage（`thenApply`、`thenAccept`、`thenCompose`、`thenCombine`……）**都不会执行**，直接以同一个异常完成。
- 下游看到的异常被包装成 **`CompletionException`**，`getCause()` 才是原始异常。即使是 `supplyAsync` 自身抛出的异常，在它直接挂的 `exceptionally` 里通常也已经是 `CompletionException`。
- 只有 `exceptionally`、`handle`、`whenComplete`（及其 `Async` / `Compose` 版本）会在失败时被调用。

所以异常处理代码**先解包再判断类型**：

```java
static Throwable unwrap(Throwable t) {
    while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
        t = t.getCause();
    }
    return t;
}

priceF.exceptionally(ex -> {
    if (unwrap(ex) instanceof TimeoutException) {
        return Price.UNKNOWN;
    }
    throw new CompletionException(ex);   // 不能处理的继续向下游传播
});
```

### 2、exceptionally、handle、whenComplete 的区别

| | `exceptionally(fn)` | `handle(fn)` | `whenComplete(action)` |
|--|---------------------|--------------|------------------------|
| 何时调用 | **仅失败** | 成功、失败都调用 | 成功、失败都调用 |
| 入参 | `Throwable` | `(result, throwable)`，失败时 `throwable` 非 null、`result` 为 null | 同 `handle` |
| 能否改变结果 | 能：返回值成为新的成功结果 | 能：返回值成为新结果（类型可以变） | **不能**：原样传递原结果或原异常 |
| 回调自身抛异常 | 新 stage 以该异常失败 | 新 stage 以该异常失败 | 原来成功则变为失败；原来已失败则保留原异常 |
| 典型用途 | 降级为默认值 | 统一转换为 `Result` 对象 | 打日志、打点、释放资源 |

```java
// exceptionally：只在失败时降级
CompletableFuture<List<Review>> reviews = reviewF.exceptionally(ex -> List.of());

// handle：成功失败统一成一个结果对象
CompletableFuture<Result<Price>> result = priceF.handle((p, ex) ->
        ex == null ? Result.ok(p) : Result.fail(unwrap(ex).getMessage()));

// whenComplete：旁路记录，不影响下游拿到的结果
CompletableFuture<Price> logged = priceF.whenComplete((p, ex) -> {
    if (ex != null) log.warn("查价失败 id={}", id, unwrap(ex));
});

// exceptionallyCompose（JDK 12+）：失败时换一个异步数据源
CompletableFuture<Price> withFallback = priceF.exceptionallyCompose(ex -> priceCache.getAsync(id));
```

不要把它们串在一起当 try-catch-finally 用：`exceptionally` 已经恢复之后再接 `handle`，`handle` 收到的 `throwable` 永远是 `null`，失败分支成了死代码。

### 3、join、get 与其他取值方法

| 方法 | 失败时抛出 | 受检异常 | 说明 |
|------|-----------|---------|------|
| `get()` | `ExecutionException`（cause 为原始异常） | 是，还要处理 `InterruptedException` | 来自 `Future` 接口，可被中断 |
| `get(timeout, unit)` | 同上，超时抛 `TimeoutException` | 是 | 只是**调用方不再等待**，任务不受影响 |
| `join()` | `CompletionException`（cause 为原始异常） | 否 | 适合在 Lambda、Stream 中使用；不响应中断 |
| `getNow(default)` | `CompletionException` | 否 | 未完成时立即返回默认值，不阻塞 |
| `resultNow()`（JDK 19+） | 非成功完成时抛 `IllegalStateException` | 否 | 确定已成功时取值，如 `allOf` 之后 |
| `state()`（JDK 19+） | — | — | 返回 `RUNNING` / `SUCCESS` / `FAILED` / `CANCELLED` |

被取消时，`get()` 与 `join()` 都直接抛 `CancellationException`，不做包装。

---

## 六、超时与取消

### 1、orTimeout 与 completeOnTimeout（JDK 9+）

```java
CompletableFuture<Price> price = CompletableFuture
        .supplyAsync(() -> priceClient.get(id), ioPool)
        .orTimeout(300, TimeUnit.MILLISECONDS);                   // 超时则以 TimeoutException 失败

CompletableFuture<List<Review>> reviews = CompletableFuture
        .supplyAsync(() -> reviewClient.top(id), ioPool)
        .completeOnTimeout(List.of(), 200, TimeUnit.MILLISECONDS); // 超时则用默认值成功完成
```

::: warning 超时只完成 Future，不会停止任务
`orTimeout` / `completeOnTimeout` 只是由一个内部的守护调度线程在到期时**完成这个 Future**。正在执行的 `priceClient.get()` 不会被中断，线程和连接一直被占用，直到下游返回或客户端自身超时。所以 **HTTP / RPC / JDBC 客户端必须配置自己的连接与读超时**，并且不大于这里的预算，否则慢下游会逐渐占满线程池。
:::

JDK 8 没有这两个方法，常见的替代做法是用一个 `ScheduledExecutorService` 在到期时调用 `completeExceptionally(new TimeoutException())`，语义相同。

### 2、cancel(true) 不会中断执行线程

```java
CompletableFuture<String> f = CompletableFuture.supplyAsync(this::slowCall, ioPool);
f.cancel(true);   // f 立即以 CancellationException 完成，但 slowCall() 仍在 ioPool 里继续执行
```

`CompletableFuture` 不持有执行它的线程，`mayInterruptIfRunning` 参数在这里**没有任何效果**。确实需要中断时，自己用 `ExecutorService.submit` 拿到能中断的 `Future`，在外层 Future 失败（取消或超时）时转发：

```java
<T> CompletableFuture<T> interruptibleAsync(Callable<T> task, ExecutorService pool) {
    CompletableFuture<T> cf = new CompletableFuture<>();
    Future<?> running = pool.submit(() -> {
        try {
            cf.complete(task.call());
        } catch (Throwable t) {
            cf.completeExceptionally(t);
        }
    });
    cf.whenComplete((v, ex) -> {
        if (ex != null) running.cancel(true);   // 被 cancel、orTimeout 等提前完成时中断任务
    });
    return cf;
}
```

即便如此，任务也要**响应中断**才会真正停下：传统 `Socket` 阻塞读不响应中断，靠的仍是客户端读超时。

### 3、延迟执行

```java
Executor delayed = CompletableFuture.delayedExecutor(1, TimeUnit.SECONDS, ioPool);   // JDK 9+
CompletableFuture.runAsync(this::retryOnce, delayed);                                // 1 秒后在 ioPool 中执行
```

适合简单的延迟重试；需要退避、次数控制时用重试框架，见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 七、上下文传递

MDC（traceId）、`ThreadLocal`、Spring Security 的 `SecurityContextHolder` 都绑定在**线程**上。异步回调换了线程，这些上下文就丢了：日志断链、取不到当前用户。

**做法：在执行器上统一包装，提交时捕获、执行前设置、执行后恢复。**

```java
public final class ContextAwareExecutor implements Executor {
    private final Executor delegate;

    public ContextAwareExecutor(Executor delegate) {
        this.delegate = delegate;
    }

    @Override
    public void execute(Runnable task) {
        Map<String, String> captured = MDC.getCopyOfContextMap();          // 提交线程的上下文
        delegate.execute(() -> {
            Map<String, String> previous = MDC.getCopyOfContextMap();      // 执行线程原有的上下文
            setOrClear(captured);
            try {
                task.run();
            } finally {
                setOrClear(previous);   // 恢复而不是 clear：任务可能就在提交线程上执行（如 CallerRunsPolicy）
            }
        });
    }

    private static void setOrClear(Map<String, String> context) {
        if (context == null) MDC.clear(); else MDC.setContextMap(context);
    }
}

Executor io = new ContextAwareExecutor(ioPool);
CompletableFuture.supplyAsync(() -> priceClient.get(id), io)
        .thenApplyAsync(this::enrich, io);   // 每一个 Async 阶段都要传包装后的执行器
```

- **同步回调**（`thenApply`）跑在完成上游的线程上：上游由包装后的执行器完成时，上下文还在；上游由 Netty 等外部线程完成时就丢了，此时改用 `thenApplyAsync(fn, io)`。
- 不传执行器的 `xxxAsync` 会落到 `commonPool`，**绕过所有包装**，这也是"始终传执行器"的理由之一。
- Spring 的 `ThreadPoolTaskExecutor` 用 `TaskDecorator` 做同样的事，见 [线程池](./28_topic_thread_pool)（Spring 中的线程池一节）；`ThreadLocal` 跨线程池传递的通用方案 TTL 见 [线程基础](./23_topic_thread_basics)；链路追踪框架自带的上下文传播见 [链路追踪](/observability/3_tracing)。

---

## 八、常见坑

| 坑 | 现象 | 解决 |
|----|------|------|
| 不传执行器 | 阻塞 IO 占满 `commonPool`；1～2 核容器里每任务新建线程 | 所有 `xxxAsync` 显式传入专用线程池 |
| 同步回调里做重活 | IO 线程 / EventLoop 被阻塞，吞吐骤降 | 耗时逻辑用 `thenApplyAsync(fn, executor)` |
| `instanceof` 判断异常类型失败 | 拿到的是 `CompletionException` | 先 `unwrap` 再判断 |
| `exceptionally` 后接 `handle` | `handle` 永远看不到异常 | 按用途三选一，不要叠加 |
| 链尾没有处理异常也不 `join` | 异常无声无息丢失 | 链尾 `whenComplete` 记录，或由调用方 `join` |
| 以为 `orTimeout` / `cancel(true)` 能停止任务 | 线程、连接被慢下游持续占用 | 客户端自身超时；需要中断时用第六节的转发写法 |
| `allOf` 当成快速失败 | 一个失败了仍要等最慢的那个 | 自己挂 `whenComplete` 提前失败，或用结构化并发 |
| 在池内线程里 `join` 同池任务 | 线程池饥饿死锁 | 用 `thenCompose` / `thenCombine` 组合，不在池内阻塞等待 |
| 上下文丢失 | 日志没有 traceId，取不到登录用户 | 包装执行器，见第七节 |

---

## 九、JDK 21+ 的取舍

虚拟线程让"阻塞"重新变得廉价。很多为了不阻塞线程而写的 `CompletableFuture` 回调链，在 JDK 21+ 上可以改回直白的阻塞代码，并发靠"每任务一个虚拟线程"获得：

```java
// 虚拟线程 + 阻塞写法：可读性好，栈追踪完整
try (ExecutorService vt = Executors.newVirtualThreadPerTaskExecutor()) {
    Future<Product> product = vt.submit(() -> productClient.get(id));
    Future<Price>   price   = vt.submit(() -> priceClient.get(id));
    return DetailVO.of(product.get(), price.get());
}
```

这种写法里一个子任务失败，另一个仍会跑完，`close()` 也会等它。需要"一个失败就取消其余"时，JDK 25 / 26 提供了**预览中**的结构化并发 `StructuredTaskScope`，见 [虚拟线程](./30_topic_virtual_thread)。

| 场景 | 推荐 |
|------|------|
| JDK 8 / 17，IO 并行聚合 | `CompletableFuture` + 专用线程池 |
| JDK 21+，请求内的少量并行调用 | 虚拟线程 + 阻塞写法；生产稳定 API 优先，结构化并发转正前按团队对预览特性的接受程度选择 |
| 下游 API 本身就是异步回调（Netty、异步客户端、MQ 发送） | `CompletableFuture` 桥接，不要为了阻塞而阻塞 |
| 需要声明式组合、对外暴露异步接口（如 `@Async` 返回值） | `CompletableFuture`，Spring 写法见 [异步任务与定时任务](/spring-boot/9_async_schedule) |

并行聚合在业务中的完整落地（整体超时预算、核心与非核心数据的降级）见 [异步与批量](/high-perf/8_async_batch)。

---

## 小结

- 同步回调由"完成上游的线程"或"注册回调的线程"执行，从不提交到线程池；`Async` 不传执行器走 `commonPool`，并行度不足 2 时每任务新建线程
- 生产代码所有 `xxxAsync` 都传专用线程池：隔离、容量可控、可统一传递上下文
- `thenCompose` 扁平化异步调用，`thenCombine` 合并两个结果，`allOf` 等全部完成且不快速失败，`anyOf` 取第一个完成的且不取消其余
- 异常沿链传播并包装成 `CompletionException`，处理前先解包；`exceptionally` 只管失败，`handle` 可改结果，`whenComplete` 只观察
- `join` 抛非受检的 `CompletionException`，`get` 抛受检的 `ExecutionException`
- `orTimeout` / `completeOnTimeout` 只完成 Future，`cancel(true)` 不中断线程；真正止损靠客户端超时
- MDC / ThreadLocal 通过包装执行器传递，执行后恢复原上下文
- JDK 21+ 的请求内并行可以用虚拟线程 + 阻塞写法，回调式 API 仍适合 `CompletableFuture`

> 下一篇：[虚拟线程](./30_topic_virtual_thread) —— JDK 21 的轻量线程：挂载与卸载、钉住问题的版本演进、ScopedValue 与结构化并发。

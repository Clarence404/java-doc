---
description: 异步编排、任务组合、异常处理与常见坑
---

# CompletableFuture

> Java 8 引入的异步编排工具，弥补了 [Future](./23_topic_thread_basics.md#二、future-接口-异步结果) 只能阻塞 `get()` 的不足，支持链式转换、组合多个异步任务与统一的异常处理。

参考链接：
> [实现异步的9种方式-捡田螺的小男孩](https://mp.weixin.qq.com/s/eTQwT-zFgHgNVJ_nNAZidw)

## 一、基本使用

```java
// 异步执行，无返回值
CompletableFuture<Void> f1 = CompletableFuture.runAsync(() -> doWork(), executor);

// 异步执行，有返回值
CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> fetchData(), executor);

// 链式处理
CompletableFuture<String> result = CompletableFuture
    .supplyAsync(() -> fetchUser(userId))          // 异步获取用户
    .thenApply(user -> enrichUser(user))           // 同步转换（在完成线程执行）
    .thenApplyAsync(user -> fetchOrders(user), executor)  // 异步转换（切换到指定线程池）
    .thenCompose(orders -> buildResponse(orders)); // 扁平化（返回值本身是 CompletableFuture）

// 异常处理
CompletableFuture<String> safe = result
    .exceptionally(t -> "默认值")                   // 异常时返回默认值
    .handle((val, t) -> t != null ? "错误" : val);  // 统一处理正常和异常
```

## 二、组合多个任务

```java
// allOf：等待所有任务完成
CompletableFuture<Void> all = CompletableFuture.allOf(f1, f2, f3);
all.join();
// 获取结果需手动调用各 future.join()
List<String> results = List.of(f1.join(), f2.join(), f3.join());

// anyOf：任意一个完成即返回
CompletableFuture<Object> any = CompletableFuture.anyOf(f1, f2, f3);
Object first = any.join();
```

## 三、常见坑

- `thenApply/thenRun` 不传 Executor 时，在**触发完成的线程**执行，可能阻塞 ForkJoinPool 公共池
- 生产代码中**务必传自定义线程池**（避免使用 `ForkJoinPool.commonPool()`）
- 链式调用中的异常若不处理，`join()` 会抛出 `CompletionException`

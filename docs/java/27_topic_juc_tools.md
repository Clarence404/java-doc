---
description: CountDownLatch、CyclicBarrier、Semaphore、Phaser、Exchanger、选型
---

# 同步工具类

> 前置阅读：[显式锁（Lock）](./25_topic_lock)

锁管「同一时刻只让一个线程进」，同步工具类管线程间的协调：等别人做完、到齐再走、最多放进 N 个。本篇讲 `CountDownLatch`、`CyclicBarrier`、`Semaphore`、`Phaser`、`Exchanger`，基线为 JDK 21 / 25。

---

## 一、总览

下文对比各工具的实现与语义差异、生产写法，以及 JDK 21 / 25 上的替代方案。

本文示例中的 `warmUp`、`compute`、`doPhase`、`callApi` 等为业务方法，`pool` 为已创建的 `ExecutorService`，`log` 为日志对象，`threads` 为并发线程数。

| 工具 | 底层实现 | 状态含义 |
|------|----------|----------|
| `CountDownLatch` | 内部类 `Sync` 继承 AQS，共享模式 | state = 剩余计数 |
| `Semaphore` | 内部类 `Sync` 继承 AQS，共享模式，分公平 / 非公平 | state = 剩余许可数 |
| `CyclicBarrier` | **不继承 AQS**：`ReentrantLock` + `Condition` + `Generation` 对象 | `count` = 本代还没到达的线程数 |
| `Phaser` | 自己实现：一个 `long` 状态字段 + 等待者链表 | 阶段号、已注册数、未到达数打包在一个 `long` 里 |
| `Exchanger` | 自己实现：CAS 槽位 + 竞争时的消除数组 | 无计数 |

`CyclicBarrier` 常被误说成「基于 AQS」，实际上它只是通过 `ReentrantLock` 间接用到 AQS。AQS 本身的结构与流程见 [显式锁（Lock）](./25_topic_lock)。

![CountDownLatch 与 CyclicBarrier](../assets/java/latch-vs-barrier.svg)

两者最本质的区别：`CountDownLatch` 是「**一组线程等待另一组事件**」，计数的线程（调用 `countDown`）不阻塞，等待的线程（调用 `await`）阻塞；`CyclicBarrier` 是「**一组线程互相等待**」，每个参与者既计数又等待，到齐后自动进入下一代。

---

## 二、CountDownLatch

### 1、原理

- 构造时 `state = count`
- `countDown()`：CAS 把 state 减 1；**减到 0 的那一次**返回 `true`，触发 `releaseShared`，唤醒所有等待者；state 已经是 0 时再调用不做任何事
- `await()`：`tryAcquireShared` 在 `state == 0` 时返回成功，否则进入同步队列 park；归零后共享唤醒逐个向后传播，所有 `await` 的线程都会放行
- 计数**不能重置**，归零后再 `await` 立即返回；需要重复使用就新建一个，或改用 `CyclicBarrier` / `Phaser`

### 2、等待多个任务完成

```java
public void warmUpAll(List<String> services) throws InterruptedException {
    CountDownLatch latch = new CountDownLatch(services.size());
    for (String service : services) {
        pool.execute(() -> {
            try {
                warmUp(service);
            } catch (RuntimeException e) {
                log.error("预热失败: {}", service, e);
            } finally {
                latch.countDown();            // 必须放在 finally：任务抛异常也要计数，否则 await 永远等不到 0
            }
        });
    }
    if (!latch.await(30, TimeUnit.SECONDS)) { // 生产代码用带超时的 await，并处理超时
        throw new IllegalStateException("预热超时，未完成 " + latch.getCount() + " 个");
    }
}
```

两条生产规则：

- `countDown()` 一定放在 `finally` 里。任务抛异常、或者被拒绝策略静默丢弃（如 `DiscardPolicy`）都会导致少减一次，主线程永久阻塞
- 用 `await(timeout, unit)` 代替 `await()`，返回 `false` 表示超时，此时 `getCount()` 能告诉你还差几个

### 3、发令枪：让多个线程同时开始

计数为 1 的 latch 可以反过来用：多个线程 `await`，一个线程 `countDown` 把它们同时放行，常用于并发测试：

```java
CountDownLatch startGate = new CountDownLatch(1);
CountDownLatch endGate = new CountDownLatch(threads);

for (int i = 0; i < threads; i++) {
    pool.execute(() -> {
        try {
            startGate.await();                // 全部就位后等发令
            try {
                callApi();
            } finally {
                endGate.countDown();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    });
}
long start = System.nanoTime();
startGate.countDown();                        // 发令
endGate.await();
long elapsed = System.nanoTime() - start;
```

注意这只是让线程在同一时刻被唤醒，并不能保证它们在同一纳秒真正执行；需要严格的微基准测试请用 JMH，见 [基准测试（JMH）](/high-perf/4_benchmark)。

---

## 三、CyclicBarrier

### 1、原理

`CyclicBarrier` 内部有一把 `ReentrantLock`、一个 `Condition trip`、参与方数量 `parties`、本代剩余计数 `count`，以及一个代表「当前这一代」的 `Generation` 对象（只有一个 `broken` 标志）：

1. 线程调用 `await()`：加锁，`--count`
2. `count` 不为 0：在 `trip` 上 `await`，释放锁等待
3. `count` 减到 0（最后一个到达）：**由这个线程执行 `barrierAction`**，然后 `trip.signalAll()` 唤醒所有人，把 `count` 复位为 `parties`，创建新的 `Generation`
4. 被唤醒的线程发现代已经换了，返回

计数是**递减到 0 触发**的，复用是**自动**的：每一代结束后自动开启下一代，不需要调用 `reset()`。`await()` 的返回值是到达序号，第一个到达的是 `parties - 1`，最后一个是 0。

### 2、用法：多轮分阶段计算

```java
int parties = 4;
CyclicBarrier barrier = new CyclicBarrier(parties,
        () -> mergePartialResults());          // 每一轮到齐后，由最后到达的线程执行

for (int i = 0; i < parties; i++) {
    int shard = i;
    pool.execute(() -> {
        try {
            for (int round = 0; round < 10; round++) {
                compute(shard, round);
                barrier.await(10, TimeUnit.SECONDS);   // 等其他分片完成本轮
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (BrokenBarrierException | TimeoutException e) {
            log.warn("分片 {} 退出：屏障已破损", shard, e);
        }
    });
}
```

`await` 会抛受检异常 `InterruptedException`、`BrokenBarrierException`（带超时的版本还有 `TimeoutException`），而 `Runnable` 不能抛受检异常，所以在 `execute` 的 lambda 里必须捕获。

注意线程池大小至少要等于 `parties`：如果池里只有 3 个线程却要等 4 方到齐，前 3 个永久等待，第 4 个任务永远排不上队。

### 3、破损：BrokenBarrierException

屏障是「同生共死」的。只要发生下列任一情况，当前这一代就被标记为 broken，**所有正在等待和之后到达的线程**都会收到 `BrokenBarrierException`：

- 某个等待线程被中断（它自己收到 `InterruptedException`）
- 某个线程的 `await(timeout)` 超时（它自己收到 `TimeoutException`）
- `barrierAction` 抛出异常（执行它的线程收到该异常）
- 有线程调用了 `reset()`

破损后可以用 `isBroken()` 判断，必须调用 `reset()` 才能继续使用。`reset()` 的作用是**放弃当前这一代**并开启新的一代，而不是「复用」的手段；在有线程等待时调用它，等于让这些线程全部失败。复杂的恢复逻辑通常不如直接新建一个 `CyclicBarrier`。

---

## 四、Semaphore

### 1、原理

`Semaphore` 的 `Sync` 继承 AQS 共享模式，state 就是剩余许可数：

- `acquire(n)`：CAS 把 state 减 n，结果为负就排队等待
- `release(n)`：CAS 把 state 加 n，并唤醒等待者
- **非公平**（默认）：只要 state 足够就直接扣减，允许插队
- **公平**（`new Semaphore(n, true)`）：先检查 `hasQueuedPredecessors()`，有人排在前面就去排队；但无参 `tryAcquire()` 即使在公平模式下也会直接抢

| 方法 | 行为 |
|------|------|
| `acquire()` / `acquire(n)` | 阻塞获取，可被中断 |
| `acquireUninterruptibly()` | 阻塞获取，不响应中断 |
| `tryAcquire()` | 立即尝试，失败返回 `false` |
| `tryAcquire(timeout, unit)` | 限时等待，适合「拿不到就快速失败」的保护逻辑 |
| `release()` / `release(n)` | 归还许可 |
| `availablePermits()` | 当前可用许可数，可作为监控指标 |

### 2、用法：限制对下游的并发

```java
public class DownstreamGuard {
    private final Semaphore permits = new Semaphore(20);   // 下游最多承受 20 个并发请求

    public <T> T call(Supplier<T> action) throws InterruptedException {
        if (!permits.tryAcquire(200, TimeUnit.MILLISECONDS)) {
            throw new RejectedExecutionException("下游繁忙，快速失败");
        }
        try {                                  // 只有拿到许可才进入 try
            return action.get();
        } finally {
            permits.release();                 // 必须在 finally 归还，否则许可永久泄漏
        }
    }
}
```

`acquire` / `tryAcquire` 要放在 `try` **之外**：如果放在 `try` 里面，获取失败（超时或被中断）时 `finally` 也会执行 `release()`，凭空多出一个许可。

### 3、许可没有持有者

`Semaphore` 不记录是哪个线程拿了许可，**任何线程都可以 `release()`**，而且 `release()` 次数多于 `acquire()` 时许可数会超过初始值——构造时的 `permits` 只是初始值，不是上限。常见 bug：

- 获取失败的路径也调用了 `release()`（上一节的写法问题）
- 异步回调里重复释放（成功回调和超时回调各释放一次）
- 忘记释放：异常路径没走 `finally`，许可逐渐泄漏，最终所有请求都拿不到许可

这也意味着 `Semaphore(1)` 虽然能当互斥锁用，但它不可重入、没有持有者检查，通常不如 `ReentrantLock`。

### 4、限流的边界

- `Semaphore` 限制的是**并发数**（同时在处理的请求数），不是 **QPS**（每秒请求数）。请求处理 10 ms 时 20 个许可能撑 2000 QPS，处理 1 s 时只有 20 QPS。按速率限流用令牌桶 / 漏桶（Guava `RateLimiter`、Resilience4j `RateLimiter`）
- 它只在单个 JVM 内生效，集群总量控制需要分布式限流，见 [限流与过载保护](/high-avail/7_rate_limiting)
- 在虚拟线程下，线程数不再是天然的并发上限，对数据库、下游 HTTP 服务的并发要用 `Semaphore` 单独控制，而不是再用一个固定大小的线程池去「限流」，见 [线程池](./28_topic_thread_pool) 的虚拟线程一节

---

## 五、Phaser

`Phaser`（JDK 7）是更灵活的可复用屏障，可以看作 `CountDownLatch` 和 `CyclicBarrier` 的合体加强版：

- **参与方可动态增减**：`register()` / `bulkRegister(n)` 加入，`arriveAndDeregister()` 退出
- **多阶段**：每次所有已注册方都到达，阶段号（phase）加 1，自动进入下一阶段
- **到达和等待可以分开**：`arrive()` 只报到不等待（类似 `countDown`），`arriveAndAwaitAdvance()` 报到并等待（类似 `CyclicBarrier.await`），`awaitAdvance(phase)` 只等待某个阶段结束
- **可终止**：重写 `onAdvance(phase, registeredParties)`，返回 `true` 时 Phaser 终止；默认实现在注册方减到 0 时终止
- 单个 Phaser 最多 65535 个参与方，更多时可以构造父子树（tiering）分摊竞争

```java
Phaser phaser = new Phaser(1);                 // 主线程先注册自己，防止任务注册过程中阶段提前推进
for (int i = 0; i < 3; i++) {
    phaser.register();
    int id = i;
    pool.execute(() -> {
        for (int phase = 0; phase < 3; phase++) {
            doPhase(id, phase);
            phaser.arriveAndAwaitAdvance();    // 等本阶段所有参与方完成
        }
        phaser.arriveAndDeregister();          // 完成后退出，不再参与后续阶段
    });
}
phaser.arriveAndDeregister();                  // 主线程注册完毕后退出，交给工作线程推进阶段
```

和 `CyclicBarrier` 一样，等待中的参与方需要有线程承载，线程池大小要足够。`Phaser` 等待时不响应中断（`awaitAdvanceInterruptibly` 除外），参与方异常退出时要确保调用 `arriveAndDeregister()`，否则其他人会一直等。

---

## 六、Exchanger

`Exchanger<V>` 让**两个线程**在同步点交换对象：先到的线程在 `exchange(x)` 上等待，后到的线程把自己的对象交给它并拿走它的对象，两者同时返回。典型用法是双缓冲：生产线程填满一个缓冲区后与消费线程交换空缓冲区，避免分配新对象。

```java
Exchanger<List<String>> exchanger = new Exchanger<>();

// 生产线程
List<String> buffer = new ArrayList<>();
// ... 填满 buffer
buffer = exchanger.exchange(buffer, 1, TimeUnit.SECONDS);   // 换回一个已清空的缓冲区
```

它只适用于恰好成对的线程；`exchange` 会抛 `InterruptedException`，带超时的版本还会抛 `TimeoutException`。业务代码中很少用到，多数场景用 `BlockingQueue` 更直观。

---

## 七、现代替代方案

在 JDK 21 / 25 的业务代码里，「把一批任务分发出去、等它们都完成」这类扇出 / 扇入场景，往往不需要手写 `CountDownLatch`：

| 方式 | 说明 |
|------|------|
| `CompletableFuture.allOf(...)` | 异步编排，能拿到每个任务的结果和异常，见 [CompletableFuture](./29_topic_completable_future) |
| `ExecutorService.invokeAll(tasks, timeout, unit)` | 同步提交一批 `Callable`，统一超时，返回 `Future` 列表 |
| `try (var executor = Executors.newVirtualThreadPerTaskExecutor())` | JDK 19 起 `ExecutorService` 实现 `AutoCloseable`，`close()` 会等待所有已提交任务结束，配合虚拟线程写法最简单 |
| `StructuredTaskScope` | 结构化并发，子任务失败自动取消兄弟任务；JDK 25 中仍是预览特性（JEP 505，API 改为 `StructuredTaskScope.open()` + `Joiner`），生产代码暂不建议依赖 |

`CountDownLatch` 仍然适合「等待若干个**事件**」而不是「等待若干个**任务**」的场景，比如等待多个外部连接建立、等待组件初始化回调。`Semaphore` 在虚拟线程时代反而更重要。

---

## 八、对比与选型

| 工具 | 谁等谁 | 可否复用 | 底层实现 | 典型场景 |
|------|--------|----------|----------|----------|
| `CountDownLatch` | 一组线程等待 N 个事件；计数方不阻塞 | 否，归零后作废 | AQS 共享模式 | 等待多个初始化任务、发令枪式并发测试 |
| `CyclicBarrier` | N 个参与方互相等待，到齐一起走 | 是，每代自动复位 | `ReentrantLock` + `Condition` | 固定参与方的多轮分阶段计算 |
| `Semaphore` | 获取不到许可的线程等待别人归还 | 是 | AQS 共享模式，可选公平 | 限制对数据库、下游服务、文件句柄的并发 |
| `Phaser` | 动态参与方互相等待，可只报到不等待 | 是，多阶段 | 独立实现（`long` 状态 + 等待链表） | 参与方数量会变化的多阶段任务 |
| `Exchanger` | 两个线程互相等待并交换数据 | 是 | 独立实现（CAS 槽位） | 双缓冲、成对流水线 |

---

## 小结

- 只有 `CountDownLatch` 和 `Semaphore` 直接基于 AQS 共享模式；`CyclicBarrier` 基于 `ReentrantLock + Condition`，`Phaser`、`Exchanger` 是独立实现
- `CountDownLatch` 计数方不阻塞、等待方阻塞，不可重置；`countDown()` 必须放在 `finally`，`await` 要带超时
- `CyclicBarrier` 计数递减到 0 触发，`barrierAction` 由最后到达的线程执行，之后自动进入下一代；中断、超时、`barrierAction` 异常、`reset()` 都会让所有等待者收到 `BrokenBarrierException`
- `Semaphore` 的许可没有持有者，多释放会让许可超过初始值；`acquire` 放在 `try` 之外、`release` 放在 `finally`；它限的是并发数而不是 QPS，且只在单 JVM 内有效
- `Phaser` 支持动态注册和多阶段，`Exchanger` 只用于两个线程交换数据
- 扇出 / 扇入场景优先考虑 `CompletableFuture.allOf`、`invokeAll` 或虚拟线程 + `try-with-resources` 的 `ExecutorService`；结构化并发在 JDK 25 仍为预览

## 参考资料

- CountDownLatch（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CountDownLatch.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CountDownLatch.html)
- CyclicBarrier（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CyclicBarrier.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CyclicBarrier.html)
- Semaphore（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Semaphore.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Semaphore.html)
- Phaser（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Phaser.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Phaser.html)
- JEP 505 — Structured Concurrency (Fifth Preview)：[https://openjdk.org/jeps/505](https://openjdk.org/jeps/505)

> 下一篇：[线程池](./28_topic_thread_pool) —— 线程从哪里来：ThreadPoolExecutor 的原理、参数、异常处理与虚拟线程。

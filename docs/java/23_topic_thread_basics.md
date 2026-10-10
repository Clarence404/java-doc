---
description: 线程状态、线程创建、中断协议、wait / notify、守护线程、ThreadLocal、ScopedValue
---

# 线程基础

> 前置阅读：[JMM 内存模型](./22_topic_jmm)

线程是 Java 并发的基本执行单元。本篇讲线程状态转换、创建方式（含 JDK 21 的 `Thread.Builder`）、中断协议与线程协作，以及 ThreadLocal 的结构、泄漏原因和线程池 / 虚拟线程下的上下文传递。

---

## 一、线程的生命周期

`Thread.getState()` 返回 `Thread.State` 枚举，共 6 种状态：

![Thread.State 六种状态与转换](../assets/java/thread-states.svg)

| 状态 | 含义 | 进入方式 |
|------|------|---------|
| `NEW` | 已创建，尚未 `start()` | `new Thread(...)`、`Thread.Builder.unstarted(...)` |
| `RUNNABLE` | 可运行：可能正在 CPU 上执行，也可能在等待 CPU | `start()`；阻塞式 Socket / 文件 IO 期间，平台线程在 JVM 看来仍是 `RUNNABLE` |
| `BLOCKED` | 等待进入 `synchronized` 块或方法 | 抢 monitor 失败；从 `wait()` 被唤醒后重新抢 monitor 也会短暂处于此状态 |
| `WAITING` | 无限期等待其他线程的动作 | `Object.wait()`、`Thread.join()`、`LockSupport.park()` |
| `TIMED_WAITING` | 带超时的等待 | `Thread.sleep(n)`、`wait(n)`、`join(n)`、`LockSupport.parkNanos` |
| `TERMINATED` | `run()` 正常返回或抛出异常 | 执行结束 |

几个容易混淆的点：

- **`BLOCKED` 只对应 `synchronized`**。等待 `ReentrantLock` 的线程是通过 `LockSupport.park` 挂起的，状态是 `WAITING` / `TIMED_WAITING`，`jstack` 中显示为 `parking to wait for <0x...>`
- 一个线程只能 `start()` 一次，再次调用抛 `IllegalThreadStateException`
- 虚拟线程使用同一套状态，阻塞时会从载体线程上卸载，详见 [虚拟线程](./30_topic_virtual_thread)

---

## 二、创建线程

### 1、Runnable 与 Thread

线程只有一种创建方式：构造 `Thread` 对象并 `start()`。所谓「继承 Thread」「实现 Runnable」只是任务代码放在哪里的区别。

```java
Runnable task = () -> System.out.println(Thread.currentThread().getName() + " running");

new Thread(task, "worker-1").start();          // 推荐：任务与线程分离

class LegacyThread extends Thread {             // 不推荐：占用唯一的继承位，任务与线程耦合
    @Override
    public void run() { System.out.println("legacy"); }
}
```

直接调用 `run()` 不会创建新线程，只是在当前线程里执行一次方法。

### 2、Thread.Builder（JDK 21）

JDK 21 起，`Thread.ofPlatform()` 和 `Thread.ofVirtual()` 返回的构建器统一了平台线程和虚拟线程的创建：

```java
// 平台线程：命名带自增序号、设置守护与异常处理器
Thread platform = Thread.ofPlatform()
        .name("order-worker-", 0)               // order-worker-0, order-worker-1 ...
        .daemon(false)
        .uncaughtExceptionHandler((t, e) -> System.err.println(t.getName() + " died: " + e))
        .start(task);

// 虚拟线程
Thread virtual = Thread.ofVirtual().name("vt-", 0).start(task);
Thread quick = Thread.startVirtualThread(task);

// 作为 ThreadFactory 交给线程池或框架
ThreadFactory factory = Thread.ofPlatform().name("io-", 0).factory();
```

生产代码中线程都应该**有意义地命名**，否则 `jstack`、日志、监控中全是 `Thread-12`，无法定位。未捕获的异常默认只打印到 `System.err` 然后线程终止，务必设置 `UncaughtExceptionHandler` 接入日志。

### 3、Callable

`Callable<V>` 是 Java 5 引入的任务接口，与 `Runnable` 的区别是**有返回值、可以抛受检异常**，Java 8 起可以用 Lambda 表示（函数式接口）。它不能直接交给 `Thread`，需要提交给 `ExecutorService`，或包装成 `FutureTask`：

```java
Callable<String> call = () -> {
    Thread.sleep(100);
    return "done";
};

FutureTask<String> futureTask = new FutureTask<>(call);   // FutureTask 同时实现 Runnable 和 Future
Thread.ofPlatform().start(futureTask);
String result = futureTask.get();
```

---

## 三、Future 异步结果

`Future` 代表一个异步计算的结果，`ExecutorService.submit` 返回它：

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {   // JDK 19 起 ExecutorService 是 AutoCloseable
    Future<String> future = executor.submit(() -> {
        Thread.sleep(1000);
        return "Callable task completed";
    });

    // 主线程做其他事情 ...

    String result = future.get(2, TimeUnit.SECONDS);   // 生产代码永远带超时
    System.out.println(result);
}   // close() 等待所有任务结束后关闭
```

| 方法 | 说明 |
|------|------|
| `get()` / `get(timeout, unit)` | 阻塞等待结果；任务异常时抛 `ExecutionException`，超时抛 `TimeoutException` |
| `isDone()` / `isCancelled()` | 是否完成（正常、异常、取消都算完成）/ 是否被取消 |
| `cancel(mayInterrupt)` | 取消任务；`true` 时向运行中的线程发中断，任务能否停下取决于它是否响应中断 |
| `state()`（JDK 19） | 返回 `RUNNING` / `SUCCESS` / `FAILED` / `CANCELLED` |
| `resultNow()` / `exceptionNow()`（JDK 19） | 已知任务完成时直接取结果或异常，未完成则抛 `IllegalStateException` |

`invokeAll` 提交一批任务并等待全部完成，`invokeAny` 返回第一个成功的结果并取消其余任务。`Future` 只能阻塞获取结果、无法组合，需要编排多个异步步骤时用 [CompletableFuture](./29_topic_completable_future)。

---

## 四、中断：协作式取消

Java 没有安全的强制终止线程的方法。`Thread.stop` 会在任意位置抛出 `ThreadDeath` 并释放所有锁，可能留下不一致的对象状态，自 JDK 20 起直接抛 `UnsupportedOperationException`；`suspend` / `resume` 容易死锁，同样不可用并已从 API 中移除。取消线程只能靠**中断**：一个线程请求，另一个线程在合适的位置自己退出。

### 1、中断相关方法

| 方法 | 作用 |
|------|------|
| `t.interrupt()` | 设置 t 的中断标志；如果 t 正阻塞在可中断方法上，则把它唤醒 |
| `t.isInterrupted()` | 查询中断标志，不清除 |
| `Thread.interrupted()` | 静态方法，查询**当前线程**的中断标志并**清除** |

响应中断的阻塞方法：`Thread.sleep`、`Object.wait`、`Thread.join`、`BlockingQueue.put` / `take`、`Lock.lockInterruptibly`、`Future.get`、`CountDownLatch.await` 等。它们被中断时抛出 `InterruptedException`，**并清除中断标志**。

不响应中断的阻塞：等待进入 `synchronized`、`Lock.lock()`、传统 `java.io` 流读写。NIO 的 `InterruptibleChannel` 被中断时会关闭通道并抛 `ClosedByInterruptException`。

### 2、正确处理 InterruptedException

```java
public void run() {
    try {
        while (!Thread.currentThread().isInterrupted()) {    // 非阻塞的计算循环要主动检查
            Job job = queue.take();                          // 阻塞点会抛 InterruptedException
            process(job);
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();                  // 恢复中断标志，让上层也能感知
    } finally {
        releaseResources();
    }
}
```

规则只有两条：

- **能向上抛就向上抛**：方法签名声明 `throws InterruptedException`
- **不能抛时恢复标志**：调用 `Thread.currentThread().interrupt()`，再退出或返回

最常见的错误是 `catch (InterruptedException e) {}` 空吞异常，或者打一行日志继续循环。中断标志被清掉后，线程池的 `shutdownNow()`、`Future.cancel(true)` 都会失效，线程关不掉。

---

## 五、线程的等待与唤醒机制

### 1、wait / notify：等待方与通知方

`wait` / `notify` / `notifyAll` 必须在持有该对象 monitor 时调用（在 `synchronized (lock)` 内），否则抛 `IllegalMonitorStateException`。标准写法分成两个角色：

```java
public class Mailbox {
    private final Object lock = new Object();
    private String message;                       // 受 lock 保护的状态

    // 等待方：循环检查条件
    public String take() throws InterruptedException {
        synchronized (lock) {
            while (message == null) {             // 必须用 while：防止虚假唤醒、被唤醒后条件又被别人改掉
                lock.wait();                      // 释放 lock 并进入 WaitSet
            }
            String m = message;
            message = null;
            lock.notifyAll();                     // 状态变了，通知可能在等「空位」的 put
            return m;
        }
    }

    // 通知方：先改状态，再在同一把锁下通知
    public void put(String m) throws InterruptedException {
        synchronized (lock) {
            while (message != null) {
                lock.wait();
            }
            message = m;
            lock.notifyAll();
        }
    }
}
```

要点：

- **用 `while` 而不是 `if`**：JLS 允许虚假唤醒（spurious wakeup），被唤醒也只说明「可能有变化」
- **优先 `notifyAll`**：`notify` 只唤醒 WaitSet 中任意一个线程，当等待者等的条件不同（如上例「有消息」和「有空位」）时，可能唤醒错误的一方导致所有线程都在等
- **状态修改与通知在同一把锁内**：否则可能在等待方检查条件和调用 `wait` 之间丢失通知
- 被唤醒的线程要重新竞争 monitor，拿到锁后才从 `wait()` 返回
- 不要在 `Thread` 对象上 `wait` / `notify`：`Thread.join` 的实现会使用它

实际项目中优先用 `BlockingQueue`、`CountDownLatch` 等 [同步工具类](./27_topic_juc_tools)，而不是手写 `wait` / `notify`。

### 2、Condition

`Condition` 是 `Lock` 版本的 `wait` / `notify`，一把锁可以有多个条件队列，上例的「有消息」和「有空位」可以分别等待、精确唤醒，`ArrayBlockingQueue` 就是这样实现的：

```java
private final ReentrantLock lock = new ReentrantLock();
private final Condition notEmpty = lock.newCondition();
private final Condition notFull = lock.newCondition();

public String take() throws InterruptedException {
    lock.lock();
    try {
        while (message == null) {
            notEmpty.await();
        }
        String m = message;
        message = null;
        notFull.signal();          // 只唤醒等空位的线程
        return m;
    } finally {
        lock.unlock();
    }
}
```

### 3、LockSupport

`park()` / `unpark(thread)` 是 AQS、`FutureTask` 等的底层阻塞工具，不需要持有锁，以线程为单位唤醒。每个线程有一个「许可」：先 `unpark` 再 `park` 不会阻塞，不会丢信号。`park` 也可能无故返回，调用方同样需要循环检查条件。

### 4、sleep、yield、join

| 方法 | 行为 |
|------|------|
| `Thread.sleep(millis)` / `sleep(Duration)`（JDK 19） | 当前线程进入 `TIMED_WAITING`，**不释放已持有的 monitor**；虚拟线程睡眠时会卸载、释放载体线程 |
| `Thread.yield()` | 提示调度器让出 CPU，可能没有任何效果，不要用它做同步 |
| `t.join()` / `join(Duration)`（JDK 19） | 等待 t 终止；t 的所有操作 hb `join` 返回 |

`sleep` 只适合固定延迟、退避重试，不是限流手段；限流见 [限流与过载保护](/high-avail/7_rate_limiting)。

### 5、对比

| 机制 | 释放锁 | 依赖锁 | 唤醒粒度 | 场景 |
|------|-------|-------|---------|------|
| `wait` / `notify` | 释放 monitor | `synchronized` | 任意一个或全部 | 简单的条件等待 |
| `Condition` | 释放 Lock | `Lock` | 指定条件队列 | 多条件精确唤醒 |
| `LockSupport` | 不涉及锁 | 否 | 指定线程 | 构建同步器 |
| `sleep` | 不释放 | 否 | 超时返回 | 固定延迟 |

---

## 六、守护线程

- 守护线程（daemon）不阻止 JVM 退出：只剩守护线程时，JVM 直接退出，守护线程中的 `finally` 块**不保证执行**
- 必须在 `start()` 之前调用 `setDaemon(true)`，之后调用抛 `IllegalThreadStateException`
- 新线程默认继承创建者的守护属性；`main` 线程是非守护线程
- **虚拟线程总是守护线程**，`setDaemon(false)` 会抛 `IllegalArgumentException`
- 适合 GC 辅助、监控采集、缓存刷新等后台工作；不要用来写文件、提交事务等需要完整收尾的任务

---

## 七、ThreadLocal

`ThreadLocal` 为每个线程保存一份独立的变量值，常用于在同一线程的调用链中隐式传递上下文：用户身份、TraceId、数据库连接、`SimpleDateFormat` 这类非线程安全对象。

### 1、结构：值存在线程里

![ThreadLocalMap：弱引用 key、强引用 value](../assets/java/threadlocal-map.svg)

- 每个 `Thread` 对象有一个 `threadLocals` 字段，类型是 `ThreadLocalMap`
- `ThreadLocalMap` 是 `Entry[]` 数组，用开放寻址（线性探测）解决冲突，哈希值来自每个 `ThreadLocal` 实例固定的 `threadLocalHashCode`（按黄金分割数 `0x61c88647` 递增，分布均匀）
- `Entry` 继承 `WeakReference<ThreadLocal<?>>`：**key 是弱引用，value 是强引用**
- `tl.get()` 实际是 `Thread.currentThread().threadLocals.get(tl)`，所以不需要任何同步

### 2、内存泄漏与数据串用

key 用弱引用，是为了在 `ThreadLocal` 实例本身不再被使用时能被 GC 回收。但 value 仍沿着 `Thread → ThreadLocalMap → Entry → value` 强引用可达：

- 线程池中的线程长期存活，value 就一直不被回收。key 为 null 的过期 Entry 只会在后续 `get` / `set` / `remove` 碰到时**顺带清理**，不可依赖
- 更常见的问题是**数据串用**：上一个任务 `set` 的用户信息没有清除，下一个复用该线程的任务读到了别人的身份

正确写法是**在 `finally` 中 `remove()`**：

```java
private static final ThreadLocal<UserContext> CURRENT_USER = new ThreadLocal<>();

public void handle(Request req) {
    CURRENT_USER.set(authenticate(req));
    try {
        service.process(req);              // 调用链中任意位置通过 CURRENT_USER.get() 取用户
    } finally {
        CURRENT_USER.remove();             // 无论成功还是异常都清理
    }
}
```

把 `ThreadLocal` 声明为 `static final`：实例本身只需要一个，弱引用 key 也就不会被回收，过期 Entry 的问题不会出现，剩下的只有 value 是否 `remove`。

### 3、InheritableThreadLocal

`InheritableThreadLocal` 在**创建子线程时**把父线程的值复制给子线程（浅拷贝，可重写 `childValue` 定制）：

```java
private static final InheritableThreadLocal<String> TRACE_ID = new InheritableThreadLocal<>();

TRACE_ID.set("req-42");
Thread.ofPlatform().start(() -> System.out.println(TRACE_ID.get()));   // req-42
```

复制只发生在线程创建那一刻。线程池中的线程是预先或第一次提交时创建的，之后复用，后续任务拿到的是**创建线程时**那个请求的值，而不是提交任务时的值。普通 `ThreadLocal` 则根本不会传递到其他线程。

### 4、TransmittableThreadLocal（TTL）

阿里开源的 TTL 解决「提交任务时捕获、执行任务时回放、执行完恢复」的问题，适合线程池中传递 TraceId、租户等上下文：

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>transmittable-thread-local</artifactId>
    <version>2.14.5</version>
</dependency>
```

```java
private static final TransmittableThreadLocal<String> TRACE_ID = new TransmittableThreadLocal<>();

// 包装线程池：每次 submit 时捕获当前值，任务执行前设置、执行后恢复
ExecutorService pool = TtlExecutors.getTtlExecutorService(Executors.newFixedThreadPool(4));

TRACE_ID.set("req-42");
pool.submit(() -> System.out.println(TRACE_ID.get()));   // req-42
```

只用一种方式即可：包装线程池（上例），或者用 `TtlRunnable.get(task)` 包装单个任务，或者以 Java Agent 方式启动自动增强 JDK 线程池，不要叠加。Spring 体系中也可以用 Micrometer Context Propagation 在 Reactor、`@Async` 之间传递上下文。

### 5、ScopedValue（JDK 25）

在虚拟线程场景中，`ThreadLocal` 有两个问题：百万级虚拟线程各自持有一份副本，内存放大明显；值可变、生命周期不受控。JDK 25 正式发布的 `ScopedValue`（JEP 506）提供了替代：**不可变、只在一个代码块的动态作用域内有效、作用域结束自动解绑**。

```java
private static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();

void handle(Request req) {
    ScopedValue.where(TRACE_ID, req.traceId())
               .run(() -> service.process(req));   // process 及其调用链中可 TRACE_ID.get()
}                                                   // 离开 run 后自动失效，无需 remove
```

结构化并发 `StructuredTaskScope` 中 fork 的子任务会自动继承 ScopedValue 绑定，但结构化并发在 JDK 25 仍是预览特性。更多见 [虚拟线程](./30_topic_virtual_thread)。

### 6、选型

| 方案 | 传递时机 | 线程池中 | 可变 | 适合 |
|------|---------|---------|------|------|
| `ThreadLocal` | 不传递 | 需 `finally remove()` | 可变 | 单线程调用链内的上下文 |
| `InheritableThreadLocal` | 创建子线程时复制 | 复用后值错误 | 可变 | 只在显式 new 线程时使用 |
| TTL | 提交任务时捕获 | 正确 | 可变 | JDK 8 / 17 项目的线程池上下文传递 |
| `ScopedValue` | 作用域内绑定 | 不适用（面向虚拟线程） | 不可变 | JDK 25+，虚拟线程与结构化并发 |

---

## 八、线程池（Executors）

生产代码不直接 `new Thread` 处理请求，而是交给线程池或虚拟线程执行器。`Executors` 的 `newFixedThreadPool` / `newSingleThreadExecutor` 使用无界 `LinkedBlockingQueue`，`newCachedThreadPool` 线程数无上限，`newScheduledThreadPool` / `newSingleThreadScheduledExecutor` 的 `DelayedWorkQueue` 同样无界，任务堆积时都可能 OOM；CPU 密集或需要隔离的业务应直接用 `ThreadPoolExecutor` 配置有界队列和拒绝策略，阻塞 IO 密集的任务在 JDK 21+ 优先考虑 `Executors.newVirtualThreadPerTaskExecutor()`。线程池的原理、参数和使用陷阱见 [线程池](./28_topic_thread_pool)，线程数如何确定见 [并发参数调优](/high-con/7_concurrency_tuning)。

---

## 小结

- 6 种线程状态中，`BLOCKED` 只对应等待 `synchronized`；等待 `Lock` 的线程是 `WAITING`
- 创建线程只有 `new Thread` + `start` 一种方式；JDK 21 用 `Thread.ofPlatform()` / `ofVirtual()` 统一构建，线程要命名并设置异常处理器
- `Callable` 有返回值、可抛受检异常；`Future.get` 必须带超时，JDK 19 新增 `state()` / `resultNow()`，需要编排时用 `CompletableFuture`
- 取消线程只能靠中断：捕获 `InterruptedException` 后要么上抛，要么恢复中断标志，不能吞掉
- `wait` 必须在 `while` 循环中调用，状态修改与 `notifyAll` 在同一把锁内；实际项目优先用 JUC 工具类
- 守护线程不阻止 JVM 退出、`finally` 不保证执行；虚拟线程总是守护线程
- ThreadLocal 的值存在线程的 `ThreadLocalMap` 中，key 弱引用、value 强引用；线程池中必须在 `finally` 中 `remove()`
- 跨线程传递：`InheritableThreadLocal` 只在创建线程时复制，线程池用 TTL，JDK 25 的虚拟线程场景用 `ScopedValue`

## 参考资料

- `java.lang.Thread` API（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html)
- Java Thread Primitive Deprecation：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/doc-files/threadPrimitiveDeprecation.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/doc-files/threadPrimitiveDeprecation.html)
- JEP 444 Virtual Threads：[https://openjdk.org/jeps/444](https://openjdk.org/jeps/444)
- JEP 506 Scoped Values：[https://openjdk.org/jeps/506](https://openjdk.org/jeps/506)
- TransmittableThreadLocal：[https://github.com/alibaba/transmittable-thread-local](https://github.com/alibaba/transmittable-thread-local)

> 下一篇：[synchronized](./24_topic_synchronized) —— 从字节码到 HotSpot 的锁实现，以及偏向锁移除、新轻量级锁和虚拟线程带来的变化。

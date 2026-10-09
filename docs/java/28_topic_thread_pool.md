---
description: 执行流程、ctl 与 Worker、队列与拒绝策略、异常处理、关闭与监控、定时任务、Fork/Join
---

# 线程池

> **本篇目标**：读懂 `ThreadPoolExecutor` 的执行流程、`ctl` 状态与 `Worker` 复用机制，能写出参数合理、异常可见、可监控、能优雅关闭的生产级线程池，并知道 Fork/Join、虚拟线程与它的分工。
>
> **前置阅读**：[线程基础](./23_topic_thread_basics)、[集合框架](./21_topic_collection)（BlockingQueue 一节）

线程池解决两件事：**复用**线程以省去创建销毁开销，用有界的线程数和队列给并发**设上限**。池化的通用原理见 [池化技术](/high-perf/7_pooling)，线程数怎么估算、动态线程池怎么落地见 [并发参数调优](/high-con/7_concurrency_tuning)；本篇只讲 JDK 线程池本身。

---

## 一、ThreadPoolExecutor 底层原理

### 1、类继承视图

![Executor 体系的类关系](../assets/java/thread_pool_hierarchy.svg)

- `Executor`：只定义了 `execute(Runnable)`，把"任务提交"和"任务执行"解耦。
- `ExecutorService`：增加 `submit`、`invokeAll` / `invokeAny`、`shutdown` 等生命周期方法；JDK 19 起继承 `AutoCloseable`。
- `AbstractExecutorService`：用 `newTaskFor` 把任务包装成 `FutureTask`，实现了 `submit` 系列方法。
- `ThreadPoolExecutor`：通用线程池实现；`ScheduledThreadPoolExecutor` 在其基础上支持延迟 / 周期任务。
- `ForkJoinPool`：同样继承 `AbstractExecutorService`，但用每线程一个双端队列 + 工作窃取，见第六节。

### 2、构造参数

```java
// JDK 21 源码（JDK 11 起已没有 SecurityManager 相关的 acc 字段）
public ThreadPoolExecutor(int corePoolSize,
                          int maximumPoolSize,
                          long keepAliveTime,
                          TimeUnit unit,
                          BlockingQueue<Runnable> workQueue,
                          ThreadFactory threadFactory,
                          RejectedExecutionHandler handler) {
    if (corePoolSize < 0 ||
        maximumPoolSize <= 0 ||
        maximumPoolSize < corePoolSize ||
        keepAliveTime < 0)
        throw new IllegalArgumentException();
    if (workQueue == null || threadFactory == null || handler == null)
        throw new NullPointerException();
    this.corePoolSize = corePoolSize;
    this.maximumPoolSize = maximumPoolSize;
    this.workQueue = workQueue;
    this.keepAliveTime = unit.toNanos(keepAliveTime);
    this.threadFactory = threadFactory;
    this.handler = handler;
}
```

| 参数 | 含义 | 要点 |
|------|------|------|
| `corePoolSize` | 核心线程数 | 默认**懒创建**（有任务才建），可用 `prestartAllCoreThreads()` 预热；默认不因空闲回收 |
| `maximumPoolSize` | 最大线程数 | 只有**队列满了**才会创建核心线程以外的线程，配合无界队列时形同虚设 |
| `keepAliveTime` + `unit` | 空闲线程存活时间 | 默认只作用于超出核心数的线程；`allowCoreThreadTimeOut(true)` 后核心线程也会超时回收 |
| `workQueue` | 阻塞队列 | 生产环境必须有界，见本节第 7 小节 |
| `threadFactory` | 线程工厂 | 至少给线程起**带业务含义的名字**，便于 `jstack` 排查 |
| `handler` | 拒绝策略 | 默认 `AbortPolicy`，见本节第 8 小节 |

```java
// 自定义 ThreadFactory：业务前缀 + 自增序号 + 未捕获异常兜底
public class NamedThreadFactory implements ThreadFactory {
    private final AtomicInteger seq = new AtomicInteger(1);
    private final String prefix;

    public NamedThreadFactory(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public Thread newThread(Runnable r) {
        Thread t = new Thread(r, prefix + "-" + seq.getAndIncrement());
        t.setDaemon(false);
        t.setUncaughtExceptionHandler((th, ex) -> log.error("线程 {} 异常退出", th.getName(), ex));
        return t;
    }
}
```

JDK 21 起也可以用线程构建器得到同样效果：`Thread.ofPlatform().name("order-", 1).factory()` 返回一个按 `order-1`、`order-2` 命名的 `ThreadFactory`。

### 3、工作流程

![ThreadPoolExecutor.execute 提交流程](../assets/java/thread_pool_execute_flow.svg)

1. 线程数小于 `corePoolSize`：新建核心线程，并把当前任务作为它的第一个任务。
2. 否则尝试入队：`workQueue.offer(task)` 成功就等待空闲线程来取。
3. 队列已满：线程数小于 `maximumPoolSize` 就新建非核心线程执行该任务。
4. 以上都不满足（或线程池已关闭）：交给拒绝策略。

**容易误解的两点**：

- 顺序是"**核心线程 → 队列 → 非核心线程 → 拒绝**"，不是"先把线程开到最大再排队"。想让线程优先扩容（Tomcat 的 `TaskQueue`、Dubbo 的 `EagerThreadPoolExecutor` 都这么做），需要自定义队列：`offer` 时若线程数未达上限就返回 `false`，迫使线程池新建线程。
- 即使有核心线程处于空闲，只要当前线程数 `< corePoolSize`，新任务也会**新建线程**，而不是交给空闲线程。

### 4、ctl：一个 int 同时记录状态和线程数

`ThreadPoolExecutor` 用一个 `AtomicInteger ctl` 同时保存**运行状态**（高 3 位）和**工作线程数**（低 29 位），一次 CAS 就能原子地同时判断和修改两者。

```java
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
private static final int COUNT_BITS = Integer.SIZE - 3;        // 29
private static final int COUNT_MASK = (1 << COUNT_BITS) - 1;   // 低 29 位全 1

private static final int RUNNING    = -1 << COUNT_BITS;  // 111
private static final int SHUTDOWN   =  0 << COUNT_BITS;  // 000
private static final int STOP       =  1 << COUNT_BITS;  // 001
private static final int TIDYING    =  2 << COUNT_BITS;  // 010
private static final int TERMINATED =  3 << COUNT_BITS;  // 011

private static int runStateOf(int c)     { return c & ~COUNT_MASK; }
private static int workerCountOf(int c)  { return c & COUNT_MASK; }
private static int ctlOf(int rs, int wc) { return rs | wc; }
```

![ctl 的位布局与线程池状态流转](../assets/java/thread_pool_state.svg)

| 状态 | 接收新任务 | 处理队列中的任务 | 进入方式 |
|------|-----------|-----------------|---------|
| `RUNNING` | 是 | 是 | 初始状态 |
| `SHUTDOWN` | 否 | 是 | 调用 `shutdown()` |
| `STOP` | 否 | 否，并中断正在执行的线程 | 调用 `shutdownNow()` |
| `TIDYING` | 否 | 否 | 线程数为 0 且队列为空，即将执行 `terminated()` 钩子 |
| `TERMINATED` | 否 | 否 | `terminated()` 执行完毕 |

状态值按 `RUNNING < SHUTDOWN < STOP < TIDYING < TERMINATED` 单调递增，源码中大量用 `runStateAtLeast(c, SHUTDOWN)` 这类大小比较来判断状态。

### 5、execute 核心流程

```java
public void execute(Runnable command) {
    if (command == null)
        throw new NullPointerException();
    int c = ctl.get();
    // 1. 线程数 < corePoolSize：新建核心线程，任务作为它的第一个任务
    if (workerCountOf(c) < corePoolSize) {
        if (addWorker(command, true))
            return;
        c = ctl.get();
    }
    // 2. 线程池在运行且入队成功
    if (isRunning(c) && workQueue.offer(command)) {
        int recheck = ctl.get();
        if (!isRunning(recheck) && remove(command))
            reject(command);               // 入队后发现已关闭：移出并拒绝
        else if (workerCountOf(recheck) == 0)
            addWorker(null, false);        // 没有线程了：补一个不带首任务的线程
    }
    // 3. 入队失败：尝试新建非核心线程，失败则拒绝
    else if (!addWorker(command, false))
        reject(command);
}
```

**三个细节**：

- `addWorker(command, true)` 的第二个参数表示以 `corePoolSize` 还是 `maximumPoolSize` 作为上限。
- 任务入队后要**二次检查**：线程池已关闭就把任务移出队列并拒绝；线程数为 0（`corePoolSize = 0`，或核心线程都已超时回收）就补一个线程去消费队列。所以 `corePoolSize = 0` 时任务仍会执行，只是队列满之前最多只有 1 个线程。
- `addWorker` 先用 CAS 把线程数加一，再在 `mainLock` 保护下把 `Worker` 放进 `workers` 集合并启动线程；启动失败会回滚计数。

### 6、Worker 与线程复用原理

每个工作线程都被包装成一个 `Worker`。它继承 AQS、实现 `Runnable`，持有真正的 `Thread` 和第一个任务：

```java
private final class Worker extends AbstractQueuedSynchronizer implements Runnable {
    final Thread thread;
    Runnable firstTask;
    volatile long completedTasks;

    Worker(Runnable firstTask) {
        setState(-1);                                   // 在 runWorker 之前禁止中断
        this.firstTask = firstTask;
        this.thread = getThreadFactory().newThread(this);
    }

    public void run() { runWorker(this); }
    // tryAcquire / tryRelease：不可重入的独占锁
}
```

`Worker` 自己实现了一把**不可重入锁**：线程执行任务时持有锁，空闲时不持有。`shutdown()` 通过 `tryLock()` 判断哪些线程空闲、只中断空闲线程。之所以不用 `ReentrantLock`，是为了防止任务代码里调用 `setCorePoolSize` 等控制方法时重入这把锁、把自己当成空闲线程中断掉。

**线程复用的核心是 `runWorker` 的循环**（JDK 17 / 21 一致，精简）：

```java
final void runWorker(Worker w) {
    Thread wt = Thread.currentThread();
    Runnable task = w.firstTask;
    w.firstTask = null;
    w.unlock();                                  // 允许中断
    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) {   // 不断从队列取任务
            w.lock();
            try {
                beforeExecute(wt, task);
                try {
                    task.run();
                    afterExecute(task, null);
                } catch (Throwable ex) {
                    afterExecute(task, ex);
                    throw ex;                    // 异常会让当前线程退出
                }
            } finally {
                task = null;
                w.completedTasks++;
                w.unlock();
            }
        }
        completedAbruptly = false;
    } finally {
        processWorkerExit(w, completedAbruptly); // 移除 Worker，必要时补充新线程
    }
}
```

**线程回收的核心是 `getTask`**（精简）：

```java
private Runnable getTask() {
    boolean timedOut = false;
    for (;;) {
        int c = ctl.get();
        // 已 SHUTDOWN 且队列空，或已 STOP：线程退出
        if (runStateAtLeast(c, SHUTDOWN) && (runStateAtLeast(c, STOP) || workQueue.isEmpty())) {
            decrementWorkerCount();
            return null;
        }
        int wc = workerCountOf(c);
        // 超过核心线程数（或允许核心线程超时）时，取任务带超时
        boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;
        if ((wc > maximumPoolSize || (timed && timedOut)) && (wc > 1 || workQueue.isEmpty())) {
            if (compareAndDecrementWorkerCount(c))
                return null;                     // 返回 null → runWorker 退出循环 → 线程结束
            continue;
        }
        try {
            Runnable r = timed
                ? workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS)
                : workQueue.take();              // 核心线程阻塞等待，不会退出
            if (r != null)
                return r;
            timedOut = true;
        } catch (InterruptedException retry) {
            timedOut = false;
        }
    }
}
```

::: tip 一句话总结
线程池里的线程并不"区分"核心和非核心：谁在 `getTask` 里用 `poll(keepAliveTime)` 超时拿不到任务，谁就退出；剩下的线程用 `take()` 阻塞，成为事实上的核心线程。
:::

### 7、BlockingQueue 的选择

`workQueue` 是线程池的缓冲区：核心线程都忙时，新任务进入队列等待。各队列的底层实现见 [集合框架 - BlockingQueue](./21_topic_collection.md#五、blockingqueue-线程池-生产消费核心)，这里只看它们**作为线程池队列**时的行为。

| 类型 | 容量 | 作为线程池队列的行为 | 适用 |
|------|------|------|------|
| `ArrayBlockingQueue` | 有界 | 数组 + 一把锁，可选公平 | 生产首选之一 |
| `LinkedBlockingQueue(capacity)` | 指定容量即有界 | 链表 + 入队 / 出队两把锁，吞吐通常更高 | 生产首选之一，**必须传容量** |
| `LinkedBlockingQueue()` | `Integer.MAX_VALUE` | 实际无界，`maximumPoolSize` 永不生效，积压到 OOM | `Executors.newFixedThreadPool` 用它，生产禁用 |
| `SynchronousQueue` | 0 | 不存任务，没有空闲线程接手就 `offer` 失败 → 立即扩线程 | `newCachedThreadPool` 用它；需配合有限的 `maximumPoolSize` |
| `LinkedTransferQueue` | 无界 | `offer` 永远成功，同样让 `maximumPoolSize` 失效 | 不适合做 TPE 队列 |
| `PriorityBlockingQueue` | 无界 | 按优先级出队；`submit` 会把任务包成不可比较的 `FutureTask`，抛 `ClassCastException` | 只用 `execute` 提交实现了 `Comparable` 的任务，或重写 `newTaskFor`；还要自行限长 |
| `DelayedWorkQueue` | 无界 | 按触发时间排序的堆 | `ScheduledThreadPoolExecutor` 内部专用 |

> **生产建议**：有界队列（`ArrayBlockingQueue` 或带容量的 `LinkedBlockingQueue`）+ 明确的拒绝策略。队列长度按"可接受的排队时延 × 处理速率"估算，不是越大越好，见 [并发参数调优](/high-con/7_concurrency_tuning#一、线程池参数调优)。

### 8、拒绝策略

当线程数已达 `maximumPoolSize` 且队列已满（或线程池已关闭）时，触发拒绝策略：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `AbortPolicy`（默认）| 抛出 `RejectedExecutionException` | 需要调用方感知并处理拒绝 |
| `CallerRunsPolicy` | 由提交任务的线程直接执行 | 不允许丢任务，可接受提交方变慢 |
| `DiscardPolicy` | 静默丢弃，不抛异常 | 任务确实可丢（如采样统计）|
| `DiscardOldestPolicy` | 丢弃队列头部最老的任务，再重新提交新任务 | 只关心最新任务 |
| 自定义 | 实现 `RejectedExecutionHandler` | 记录日志、告警、落库或写 MQ 兜底 |

```java
// 自定义拒绝策略：记录日志 + 指标，再交给降级逻辑
public class LoggingRejectionHandler implements RejectedExecutionHandler {
    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        log.error("线程池已满，任务被拒绝: {}, 队列大小: {}, 活跃线程: {}",
            r, executor.getQueue().size(), executor.getActiveCount());
        if (executor.isShutdown()) {
            throw new RejectedExecutionException("线程池已关闭");
        }
        // 降级：同步执行、写消息队列或返回失败，按业务选择
        r.run();
    }
}
```

**注意**：

- 拒绝策略在线程池**已关闭**时也会被触发。`CallerRunsPolicy` 在线程池关闭后会直接丢弃任务；自定义策略要自己判断 `executor.isShutdown()`。
- `CallerRunsPolicy` 本质是**反压**：提交方被迫亲自干活，提交速度自然降下来。但如果提交方是 Tomcat 请求线程，高峰期会连带拖慢整个 Web 容器。
- `DiscardPolicy` 丢任务无任何痕迹，除非任务确实可丢，否则至少要记日志和指标。

---

## 二、任务提交与异常处理

### 1、execute vs submit

| | `execute(Runnable)` | `submit(Runnable / Callable)` |
|--|---------------------|-------------------------------|
| 定义位置 | `Executor` | `ExecutorService` |
| 返回值 | 无 | `Future<?>`，可取结果、取消任务 |
| 任务包装 | 原样执行 | 包装为 `FutureTask` |
| 任务抛出异常时 | 异常抛出到工作线程，交给 `UncaughtExceptionHandler` 打印堆栈，**该线程退出并被替换** | 异常被捕获并保存在 `Future` 里，**不调用 `get()` 就无声无息** |

### 2、submit "吞异常" 示例

```java
ExecutorService pool = Executors.newFixedThreadPool(1);   // 仅演示，生产不要用 Executors

pool.execute(() -> { throw new IllegalStateException("execute 异常"); });
// 控制台打印：Exception in thread "pool-1-thread-1" java.lang.IllegalStateException: execute 异常

Future<?> f = pool.submit(() -> { throw new IllegalStateException("submit 异常"); });
// 控制台什么都没有

f.get();  // 此时才抛出 ExecutionException，cause 为 IllegalStateException
```

### 3、四种异常处理方式

| 方式 | 做法 | 适用 |
|------|------|------|
| 任务内 try-catch | 在 `run` / `call` 里自行捕获并记录 | 最直接，推荐作为默认习惯 |
| `Future.get()` | 调用方获取结果时处理 `ExecutionException` | 需要结果的 `submit` 场景 |
| 重写 `afterExecute` | 在线程池层面统一记录异常 | 统一兜底，`execute` / `submit` 都能覆盖 |
| `UncaughtExceptionHandler` | 通过 `ThreadFactory` 设置 | **只对 `execute` 生效**，`submit` 的异常不会走到这里 |

`afterExecute` 的标准写法（来自 `ThreadPoolExecutor` 文档示例，同时兼容 `submit`）：

```java
public class SafeThreadPoolExecutor extends ThreadPoolExecutor {

    public SafeThreadPoolExecutor(int core, int max, BlockingQueue<Runnable> queue, ThreadFactory factory) {
        super(core, max, 60, TimeUnit.SECONDS, queue, factory);
    }

    @Override
    protected void afterExecute(Runnable r, Throwable t) {
        super.afterExecute(r, t);
        // submit 提交的任务被包装成 FutureTask，异常不会传到 t，需要从 Future 中取出
        if (t == null && r instanceof Future<?> future && future.isDone()) {
            try {
                future.get();
            } catch (CancellationException ce) {
                t = ce;
            } catch (ExecutionException ee) {
                t = ee.getCause();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
        }
        if (t != null) {
            log.error("线程池任务执行异常", t);
        }
    }
}
```

### 4、按完成顺序取结果：ExecutorCompletionService

批量提交后按提交顺序逐个 `get()`，会被最慢的那个挡住。`ExecutorCompletionService` 把完成的 `Future` 放进内部队列，谁先完成先处理谁：

```java
CompletionService<Quote> cs = new ExecutorCompletionService<>(ioPool);
for (QuoteClient client : clients) {
    cs.submit(() -> client.quote(sku));
}
for (int i = 0; i < clients.size(); i++) {
    Future<Quote> done = cs.poll(300, TimeUnit.MILLISECONDS);  // 按完成顺序取
    if (done == null) break;                                   // 剩余的都超时了
    handle(done.get());
}
```

需要编排依赖关系、合并结果时用 [CompletableFuture](./29_topic_completable_future)。

---

## 三、关闭线程池

| 方法 | 行为 | 返回 |
|------|------|------|
| `shutdown()` | 不再接收新任务；已提交的任务（含队列中的）继续执行；只中断空闲线程 | 立即返回，不等待 |
| `shutdownNow()` | 不再接收新任务；清空队列；对所有工作线程调用 `interrupt()` | 返回队列中未执行的任务列表 |
| `awaitTermination(timeout)` | 阻塞等待线程池进入 `TERMINATED` | 超时前终止返回 `true` |
| `close()`（JDK 19+） | `ExecutorService` 实现了 `AutoCloseable`：shutdown 后一直等待终止，等待中被中断则转为 `shutdownNow()` | 可用于 try-with-resources |

::: warning
`shutdownNow()` 只是**发中断信号**。任务如果不响应中断（没有检查 `Thread.interrupted()`，也不调用 `sleep`、`wait`、`BlockingQueue.take` 这类可中断的阻塞方法），就会一直跑完。传统 `java.net.Socket` 的阻塞读同样不响应中断，只能靠读超时。
:::

优雅关闭的标准写法（来自 `ExecutorService` 文档）：

```java
void shutdownAndAwaitTermination(ExecutorService pool) {
    pool.shutdown();                                         // 1. 拒绝新任务
    try {
        if (!pool.awaitTermination(60, TimeUnit.SECONDS)) {  // 2. 等待存量任务完成
            pool.shutdownNow();                              // 3. 超时则强制中断
            if (!pool.awaitTermination(60, TimeUnit.SECONDS)) {
                log.error("线程池未能正常终止");
            }
        }
    } catch (InterruptedException ex) {
        pool.shutdownNow();
        Thread.currentThread().interrupt();                  // 恢复中断标记
    }
}

// JDK 19+：局部、一次性的批量任务可以直接用 try-with-resources
try (ExecutorService pool = Executors.newFixedThreadPool(4)) {   // 仅演示
    pool.submit(task1);
    pool.submit(task2);
}   // 离开代码块时等待所有任务完成，没有超时
```

应用里的全局线程池应在进程退出前关闭：Spring 管理的 `ThreadPoolTaskExecutor` 会随容器销毁自动关闭；自己 new 的线程池可以注册为 Bean 并指定 `destroyMethod`，或注册 JVM ShutdownHook。服务下线流程见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 四、扩展与监控

### 1、钩子方法

`ThreadPoolExecutor` 预留了三个空实现的 `protected` 方法，子类重写即可扩展：

| 方法 | 调用时机 | 常见用途 |
|------|---------|---------|
| `beforeExecute(Thread t, Runnable r)` | 任务执行前，在工作线程中调用 | 记录开始时间、设置 MDC / 上下文 |
| `afterExecute(Runnable r, Throwable t)` | 任务执行后（含异常） | 统计耗时、异常兜底、清理 ThreadLocal |
| `terminated()` | 线程池进入 `TERMINATED` 前 | 释放资源、打印最终统计 |

```java
// 统计任务耗时，超过阈值打印告警
public class TimingThreadPoolExecutor extends ThreadPoolExecutor {
    private final ThreadLocal<Long> startTime = new ThreadLocal<>();
    private final long slowThresholdMs;

    public TimingThreadPoolExecutor(int core, int max, BlockingQueue<Runnable> queue, long slowThresholdMs) {
        super(core, max, 60, TimeUnit.SECONDS, queue);
        this.slowThresholdMs = slowThresholdMs;
    }

    @Override
    protected void beforeExecute(Thread t, Runnable r) {
        super.beforeExecute(t, r);
        startTime.set(System.nanoTime());
    }

    @Override
    protected void afterExecute(Runnable r, Throwable t) {
        try {
            long costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startTime.get());
            if (costMs > slowThresholdMs) {
                log.warn("慢任务: {} 耗时 {} ms", r, costMs);
            }
        } finally {
            startTime.remove();
            super.afterExecute(r, t);
        }
    }
}
```

### 2、运行时指标

| 方法 | 含义 |
|------|------|
| `getPoolSize()` | 当前线程数 |
| `getActiveCount()` | 正在执行任务的线程数（近似值） |
| `getLargestPoolSize()` | 历史峰值线程数，可判断是否曾触达上限 |
| `getQueue().size()` | 队列积压任务数，**最关键的告警指标** |
| `getTaskCount()` / `getCompletedTaskCount()` | 已提交 / 已完成任务数（近似值） |
| `getCorePoolSize()` / `getMaximumPoolSize()` | 当前配置 |

```java
// 定时采集线程池指标；接入 Micrometer 时可直接用 ExecutorServiceMetrics 绑定
scheduler.scheduleAtFixedRate(() -> log.info(
        "pool={} size={} active={} queue={} completed={}",
        name, pool.getPoolSize(), pool.getActiveCount(),
        pool.getQueue().size(), pool.getCompletedTaskCount()),
    0, 10, TimeUnit.SECONDS);
```

`getActiveCount`、`getCompletedTaskCount` 等方法内部会获取 `mainLock` 并遍历所有 Worker，采集间隔以秒为单位即可，不要在每次提交任务时调用。指标如何进入监控与告警体系见 [指标监控](/observability/2_metrics)。

### 3、运行时调整参数

`setCorePoolSize`、`setMaximumPoolSize`、`setKeepAliveTime`、`setRejectedExecutionHandler` 都可以在运行中调用并立即生效，这是 DynamicTP 等**动态线程池**的实现基础。

- 调大 `corePoolSize` 时，如果队列中有积压，会立即预启动新线程去消费。
- 调小时，多余的线程会在空闲后逐步退出。
- **顺序有约束**（JDK 9 起）：`setCorePoolSize` 在新值大于当前 `maximumPoolSize` 时抛 `IllegalArgumentException`，`setMaximumPoolSize` 在新值小于当前 `corePoolSize` 时同样抛异常。所以**扩容先调 max 再调 core，缩容先调 core 再调 max**。
- **队列容量不能动态修改**（`ArrayBlockingQueue` 的容量是 `final`）。动态线程池框架一般会提供可修改容量的自定义队列。

```java
void resize(ThreadPoolExecutor pool, int newCore, int newMax) {
    if (newMax >= pool.getMaximumPoolSize()) {   // 扩容：先 max 后 core
        pool.setMaximumPoolSize(newMax);
        pool.setCorePoolSize(newCore);
    } else {                                     // 缩容：先 core 后 max
        pool.setCorePoolSize(newCore);
        pool.setMaximumPoolSize(newMax);
    }
}
```

---

## 五、ScheduledThreadPoolExecutor

用于执行**延迟任务**和**周期任务**，是 `Timer` 的替代品。它内部使用按执行时间排序的 `DelayedWorkQueue`（无界），只用核心线程执行，`maximumPoolSize` 不起作用。

```java
ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2, new NamedThreadFactory("schedule"));

// 延迟 5 秒执行一次
scheduler.schedule(() -> log.info("延迟任务"), 5, TimeUnit.SECONDS);

// 固定频率：每 10 秒开始一次（以上一次的开始时间计算）
scheduler.scheduleAtFixedRate(this::syncData, 0, 10, TimeUnit.SECONDS);

// 固定延迟：上一次结束后再等 10 秒
scheduler.scheduleWithFixedDelay(this::cleanCache, 0, 10, TimeUnit.SECONDS);
```

| | `scheduleAtFixedRate` | `scheduleWithFixedDelay` |
|--|-----------------------|--------------------------|
| 间隔计算 | 上一次**开始**到下一次开始 | 上一次**结束**到下一次开始 |
| 执行耗时超过周期时 | 下一次在上一次结束后**立即**开始，不会并发执行 | 不受影响，始终保持固定间隔 |
| 适用 | 心跳、固定频率采样 | 轮询、清理等需要稳定间隔的任务 |

::: warning 周期任务抛异常会"静默停止"
周期任务一旦抛出未捕获的异常，**后续调度全部取消**，而且不会有任何日志（异常被保存在返回的 `ScheduledFuture` 中）。周期任务体内务必 try-catch：
```java
scheduler.scheduleAtFixedRate(() -> {
    try {
        syncData();
    } catch (Exception e) {
        log.error("同步任务失败", e);
    }
}, 0, 10, TimeUnit.SECONDS);
```
:::

| | `Timer` | `ScheduledThreadPoolExecutor` |
|--|---------|-------------------------------|
| 线程数 | 单线程，一个任务慢会拖累所有任务 | 可配置多线程 |
| 异常影响 | 任一任务抛异常，**整个 Timer 终止** | 只影响该任务自身 |
| 时间基准 | `System.currentTimeMillis`，改系统时钟会受影响 | `System.nanoTime` 相对时间 |

集群环境下的分布式定时任务见 [分布式调度](/distributed/6_job_scheduler)。

---

## 六、Fork/Join

### 1、工作窃取

Fork/Join 框架用于**递归分治**任务。每个工作线程有自己的双端队列：自己 `fork` 出的子任务从 top 端压入、弹出（LIFO，缓存局部性好）；空闲线程从别人队列的 base 端**窃取**（FIFO，偷到的是最早 fork、粒度最大的任务），两端操作，竞争很小。

![Fork/Join 工作窃取](../assets/java/forkjoin_work_stealing.svg)

```java
public class SumTask extends RecursiveTask<Long> {
    private static final int THRESHOLD = 1000;
    private final long[] arr;
    private final int start, end;

    public SumTask(long[] arr, int start, int end) {
        this.arr = arr;
        this.start = start;
        this.end = end;
    }

    @Override
    protected Long compute() {
        if (end - start <= THRESHOLD) {
            long sum = 0;                  // 任务足够小，直接计算
            for (int i = start; i < end; i++) sum += arr[i];
            return sum;
        }
        int mid = (start + end) >>> 1;     // 拆分任务
        SumTask left = new SumTask(arr, start, mid);
        SumTask right = new SumTask(arr, mid, end);
        left.fork();                       // 左半部分压入自己的队列，可能被别人窃取
        return right.compute()             // 当前线程直接算右半部分
             + left.join();                // 等待左半部分；等待期间会帮忙执行其他任务
    }
}

long result = ForkJoinPool.commonPool().invoke(new SumTask(arr, 0, arr.length));
```

`parallelStream` 与不传执行器的 `CompletableFuture.xxxAsync` 默认都使用 `ForkJoinPool.commonPool()`。

### 2、ForkJoinPool vs ThreadPoolExecutor

| | `ForkJoinPool` | `ThreadPoolExecutor` |
|--|----------------|----------------------|
| 任务队列 | 每个线程一个双端队列 + 工作窃取 | 所有线程共享一个阻塞队列 |
| 适合的任务 | 可递归拆分的 CPU 密集型计算 | 相互独立的业务任务，包括 IO 密集型 |
| 任务间关系 | 父任务 `join` 等待子任务，等待时线程会去执行其他任务 | 任务之间最好没有依赖，否则可能饥饿死锁 |
| 默认并行度 | `commonPool` 为 CPU 核数 − 1（至少 1） | 由构造参数决定 |

::: warning commonPool 是全 JVM 共享的
`parallelStream`、不传执行器的 `CompletableFuture.xxxAsync` 都在用它。在里面执行阻塞 IO，会拖慢整个应用的并行计算，IO 任务请使用独立的线程池。

它的并行度来自 `Runtime.availableProcessors()`，容器里取的是 cgroup 的 CPU 限额：限额 1～2 核时 `commonPool` 并行度只有 1（此时 `CompletableFuture` 甚至会退化为每任务新建线程，见 [CompletableFuture](./29_topic_completable_future)）。可以用 `-XX:ActiveProcessorCount` 或 `-Djava.util.concurrent.ForkJoinPool.common.parallelism` 调整，容器 CPU 感知见 [JVM 层性能策略](/high-perf/5_jvm_tuning)。
:::

JDK 21 的虚拟线程调度器也是一个 `ForkJoinPool`，但它是**独立实例**，与 `commonPool` 互不影响。

---

## 七、虚拟线程与线程池（JDK 21+）

虚拟线程把"线程"从稀缺资源变成了廉价对象，它和线程池的分工可以概括为：

- **IO 密集、数量巨大的阻塞任务**：用 `Executors.newVirtualThreadPerTaskExecutor()`，每任务一个虚拟线程，**不要池化**；对下游的并发上限改用 `Semaphore` 或连接池大小控制。
- **CPU 密集任务、需要精确限流的任务**：仍用大小固定的平台线程池。
- JDK 21 还提供了 `Executors.newThreadPerTaskExecutor(ThreadFactory)`，可传入 `Thread.ofVirtual().name("vt-", 0).factory()` 给虚拟线程统一命名。

挂载 / 卸载原理、钉住（pinning）的版本差异、诊断手段与 `ScopedValue` 见 [虚拟线程](./30_topic_virtual_thread)。

---

## 八、Spring 中的线程池

| 组件 | 说明 |
|------|------|
| `ThreadPoolTaskExecutor` | Spring 对 `ThreadPoolExecutor` 的封装，支持 Bean 生命周期（容器关闭时自动 shutdown）、`TaskDecorator` |
| `SimpleAsyncTaskExecutor` | **每个任务新建一个线程**，不复用。没有 Spring Boot 自动配置、也没有自定义执行器时，`@Async` 回退到它，高并发下线程数失控 |
| Spring Boot 自动配置 | 提供名为 `applicationTaskExecutor` 的 `ThreadPoolTaskExecutor`，通过 `spring.task.execution.pool.*` 配置；开启 `spring.threads.virtual.enabled=true`（Boot 3.2+、JDK 21+）后换成基于虚拟线程的 `SimpleAsyncTaskExecutor` |

`@Async` 的配置方式、自定义执行器与虚拟线程开关的完整写法见 [异步任务与定时任务](/spring-boot/9_async_schedule)，这里只强调两个线程池层面的坑。

**一、默认执行器是无界的**：Boot 自动配置的 `applicationTaskExecutor` 队列容量和最大线程数默认都是 `Integer.MAX_VALUE`，本质上和 `newFixedThreadPool` 一样是无界队列。生产环境要么显式限制 `queue-capacity`，要么为不同业务定义独立的线程池，并在 `@Async("orderExecutor")` 上显式指定。

**二、TaskDecorator 传 MDC 要"恢复"而不是"清空"**：

```java
executor.setTaskDecorator(runnable -> {
    Map<String, String> captured = MDC.getCopyOfContextMap();     // 提交线程的上下文
    return () -> {
        Map<String, String> previous = MDC.getCopyOfContextMap(); // 执行线程原有的上下文
        setOrClear(captured);
        try {
            runnable.run();
        } finally {
            setOrClear(previous);                                 // 恢复，而不是 MDC.clear()
        }
    };
});

private static void setOrClear(Map<String, String> context) {
    if (context == null) MDC.clear(); else MDC.setContextMap(context);
}
```

为什么不能直接 `MDC.clear()`：配了 `CallerRunsPolicy` 时，被拒绝的任务在**提交线程**（例如 Tomcat 请求线程）里执行，`finally` 里的 `clear()` 会把调用方自己的 traceId 一起抹掉，后续日志全部丢失链路信息。日志上下文的完整方案见 [日志](/spring-boot/12_logging)。

---

## 九、常见坑

| 坑 | 现象 | 解决 |
|----|------|------|
| 使用 `Executors` 创建 | `newFixedThreadPool` / `newSingleThreadExecutor` 无界队列积压 OOM；`newCachedThreadPool` / `newScheduledThreadPool` 线程数无上限 | 手动 `new ThreadPoolExecutor`，有界队列 + 明确拒绝策略 |
| 父子任务共用一个线程池 | 父任务占满线程并等待子任务，子任务在队列里排队 → **线程池饥饿死锁** | 父子任务使用不同线程池，或改为 `CompletableFuture` 异步编排，不在池内阻塞等待 |
| `submit` 后不调用 `get` | 异常被吞掉，问题无从排查 | 任务内 try-catch，或重写 `afterExecute` |
| 周期任务抛异常 | 后续调度静默停止 | 任务体整体 try-catch |
| ThreadLocal 未清理 | 线程复用导致数据串到下一个任务、内存泄漏 | `finally` 中 `remove()`；跨线程传递用 TTL（见 [线程基础](./23_topic_thread_basics)） |
| 在方法内部 new 线程池且不关闭 | 每次调用都创建新线程池，核心线程不退出 → 线程泄漏 | 线程池定义为单例或 Spring Bean |
| 线程没有命名 | `jstack` 里全是 `pool-3-thread-7`，无法定位业务 | 自定义 `ThreadFactory` 加业务前缀 |
| 所有业务共用一个线程池 | 某个慢业务占满线程，拖垮其他业务 | 按业务隔离线程池（舱壁模式，见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)） |
| 在 `commonPool` 里做阻塞 IO | `parallelStream` / `CompletableFuture` 全局变慢 | IO 任务传入自定义线程池 |
| `CallerRunsPolicy` 用在 Web 请求链路上 | 高峰期 Tomcat 线程被拖去执行任务，接口整体超时 | 核心链路优先考虑快速失败 + 降级 |
| `PriorityBlockingQueue` + `submit` | `ClassCastException`：`FutureTask` 不可比较 | 用 `execute` 提交 `Comparable` 任务，或重写 `newTaskFor` |
| 动态调参顺序错误 | `setCorePoolSize` 抛 `IllegalArgumentException` | 扩容先 max 后 core，缩容先 core 后 max |

父子任务死锁的最小复现：

```java
ExecutorService pool = Executors.newFixedThreadPool(2);   // 仅演示

for (int i = 0; i < 2; i++) {
    pool.submit(() -> {
        // 父任务占住 2 个线程，又提交子任务并等待结果
        Future<String> child = pool.submit(() -> "child");
        return child.get();   // 子任务永远排在队列里，没有线程执行 → 永久阻塞
    });
}
```

---

## 小结

- 执行顺序是"核心线程 → 队列 → 非核心线程 → 拒绝"；`ctl` 用高 3 位存状态、低 29 位存线程数，一次 CAS 同时维护两者
- 线程复用靠 `runWorker` 循环调用 `getTask`；线程回收靠 `poll(keepAliveTime)` 超时返回 `null`，核心与非核心只是"谁超时谁退出"
- 队列必须有界：`ArrayBlockingQueue` 或带容量的 `LinkedBlockingQueue`；无界队列、`LinkedTransferQueue` 会让 `maximumPoolSize` 失效，`PriorityBlockingQueue` 不能配 `submit`
- `submit` 的异常藏在 `Future` 里，用任务内 try-catch 或 `afterExecute` 兜底；周期任务抛异常会静默停止
- 关闭用 `shutdown` + `awaitTermination` + `shutdownNow` 三步；`shutdownNow` 只发中断信号
- 动态调参注意 core / max 的先后顺序，队列容量不能改
- `commonPool` 全局共享且并行度受容器 CPU 限额影响，阻塞 IO 不要放进去；虚拟线程不池化，限流改用 `Semaphore`
- Spring 中显式指定 `@Async` 执行器，`TaskDecorator` 传 MDC 时恢复原上下文而不是清空

## 参考资料

- JDK 25 API：[ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- JDK 25 API：[ExecutorService](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ExecutorService.html)、[ForkJoinPool](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ForkJoinPool.html)
- [程序员老猫 - 背会了常见的几个线程池用法，结果被问翻](https://mp.weixin.qq.com/s/xWbSPHJG_TztJpM4Pv9knw)
- [程序员追风 - 线程池灵魂 8 连问](https://mp.weixin.qq.com/s/7ub5RhxfuklzYsa84tGAzQ)

> 下一篇：[CompletableFuture](./29_topic_completable_future) —— 在线程池之上编排异步任务：回调线程、组合、异常传播与超时。

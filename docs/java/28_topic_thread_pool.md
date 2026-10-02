---
description: ThreadPoolExecutor 原理（ctl / Worker）、异常处理、优雅关闭、监控、定时任务、Fork/Join、虚拟线程、常见坑
---

# 专项 - 线程池

> `Executors` 快捷创建方式见 [线程基础 - 线程池基础](./23_topic_thread_basics.md#四、线程池基础-executors)，本文着重介绍 `ThreadPoolExecutor` 的原理、使用与常见坑，以及 Fork/Join、虚拟线程。线程数如何设置、动态线程池等生产调优见 [高并发 - 并发参数调优](/high-con/7_concurrency_tuning#一、线程池参数调优)。

参考文章：

> [程序员老猫-背会了常见的几个线程池用法，结果被问翻](https://mp.weixin.qq.com/s/xWbSPHJG_TztJpM4Pv9knw)

> [程序员追风-面试官：线程池灵魂8连问，你挡的住吗？](https://mp.weixin.qq.com/s/7ub5RhxfuklzYsa84tGAzQ)

> [JDK 17 API：ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)

## 一、什么是线程池？

说到 **线程池**，其实我们要先聊到 **池化技术**。

池化技术：我们将资源或者任务放入池子，使用时从池中取，用完之后交给池子管理。通过优化资源分配的效率，达到性能的调优。

**池化技术优点**：

- 资源被重复使用，减少了资源在分配销毁过程中的系统的调度消耗。

::: tip
比如，在IO密集型的服务器上，并发处理过程中的子线程或子进程的 创建和销毁过程，带来的系统开销将是难以接受的。
所以在业务实现上，通常把一些资源预先分配好，如线程池，数据库连接池，Redis连接池， HTTP连接池等，来减少系统消耗，提升系统性能。
:::

- 池化技术分配资源，会集中分配，这样有效避免了碎片化的问题。

- 可以对资源的整体使用做限制，相关资源预分配且只在预分配后生成，后续不再动态添加，从而限制了整个系统对资源的使用上限。

所以我们说线程池是 **提升线程可重复利用率、可控性的池化技术的一种。**

## 二、ThreadPoolExecutor 底层原理

### 1、类继承视图

![img.png](../assets/concurrency/ThreadPoolExecutor.png)

- `Executor`：只定义了 `execute(Runnable)`，把"任务提交"和"任务执行"解耦。
- `ExecutorService`：增加 `submit`、`invokeAll/invokeAny`、`shutdown` 等生命周期管理方法。
- `AbstractExecutorService`：用 `newTaskFor` 把任务包装成 `FutureTask`，实现了 `submit` 系列方法。
- `ThreadPoolExecutor`：真正的线程池实现；`ScheduledThreadPoolExecutor` 在其基础上支持延迟/周期任务。

### 2、构造函数说明

```java
// JDK 8 源码（JDK 17 起已移除 SecurityManager 相关的 acc 字段）
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
    this.acc = System.getSecurityManager() == null ?
            null :
            AccessController.getContext();
    this.corePoolSize = corePoolSize;
    this.maximumPoolSize = maximumPoolSize;
    this.workQueue = workQueue;
    this.keepAliveTime = unit.toNanos(keepAliveTime);
    this.threadFactory = threadFactory;
    this.handler = handler;
}
```

下面我们来解释一下几个参数的含义：

- **corePoolSize**：核心线程数。核心线程默认**懒创建**（有任务来才创建），也可以调用 `prestartAllCoreThreads()` 预热；默认不会因空闲被回收。

- **maximumPoolSize**：最大线程数。只有**队列满了**才会创建核心线程以外的线程，所以配合无界队列时这个参数形同虚设。

- **keepAliveTime**：线程池中线程的最大闲置生命周期。默认只作用于非核心线程；调用 `allowCoreThreadTimeOut(true)` 后核心线程空闲超时也会被回收。

- **unit**：针对keepAliveTime的时间单位。

- **workQueue**：阻塞队列。

- **threadFactory**：创建线程的线程工厂。生产环境务必自定义，至少给线程起**带业务含义的名字**，便于 `jstack` 排查。

- **handler**：拒绝策略。

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

### 3、工作流程概述

![img.png](../assets/concurrency/work_process.png)

::: tip 流程解析

1. 当发起任务时候，会计算线程池中存在的线程数量与核心线程数量（corePoolSize）进行比较，如果小于，则在线程池中创建线程，否则，进行下一步判断。

2. 如果不满足条件1，则会将任务添加到阻塞队列中。等待线程池中的线程空闲下来后，获取队列中的任务进行执行。

3. 但是条件2中如果阻塞队列满了之后，此时又会重新获取当前线程的数量和最大线程数(maximumPoolSize)进行比较，如果发现小于最大线程数，那么继续添加到线程池中即可。

4. 如果都不满足上述条件，那么此时会放到拒绝策略中。

:::

**容易误解的两点**：

- 顺序是"**核心线程 → 队列 → 非核心线程 → 拒绝**"，不是"先把线程开到最大再排队"。想让线程优先扩容（如 Tomcat 的做法），需要自定义队列：在 `offer` 时若线程数未达上限就返回 `false`，迫使线程池新建线程。
- 即使有核心线程处于空闲，只要当前线程数 `< corePoolSize`，新任务也会**新建线程**而不是复用空闲线程。

### 4、ctl：一个 int 同时记录状态和线程数

`ThreadPoolExecutor` 用一个 `AtomicInteger ctl` 同时保存**运行状态**（高 3 位）和**工作线程数**（低 29 位），这样一次 CAS 就能原子地同时判断和修改两者。

```java
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
private static final int COUNT_BITS = Integer.SIZE - 3;        // 29
private static final int COUNT_MASK = (1 << COUNT_BITS) - 1;   // 低 29 位全 1，线程数上限约 5 亿

private static final int RUNNING    = -1 << COUNT_BITS;  // 111
private static final int SHUTDOWN   =  0 << COUNT_BITS;  // 000
private static final int STOP       =  1 << COUNT_BITS;  // 001
private static final int TIDYING    =  2 << COUNT_BITS;  // 010
private static final int TERMINATED =  3 << COUNT_BITS;  // 011

private static int runStateOf(int c)     { return c & ~COUNT_MASK; }
private static int workerCountOf(int c)  { return c & COUNT_MASK; }
private static int ctlOf(int rs, int wc) { return rs | wc; }
```

| 状态 | 接收新任务 | 处理队列中的任务 | 进入方式 |
|------|-----------|-----------------|---------|
| `RUNNING` | ✅ | ✅ | 初始状态 |
| `SHUTDOWN` | ❌ | ✅ | 调用 `shutdown()` |
| `STOP` | ❌ | ❌（并中断正在执行的线程） | 调用 `shutdownNow()` |
| `TIDYING` | ❌ | ❌ | 线程数为 0 且队列为空，即将执行 `terminated()` 钩子 |
| `TERMINATED` | ❌ | ❌ | `terminated()` 执行完毕 |

状态值按 `RUNNING < SHUTDOWN < STOP < TIDYING < TERMINATED` 单调递增，源码中大量用 `runStateAtLeast(c, SHUTDOWN)` 这类大小比较来判断状态。

### 5、execute核心流程

```java
/**
 * Executes the given task sometime in the future.  The task
 * may execute in a new thread or in an existing pooled thread.
 *
 * If the task cannot be submitted for execution, either because this
 * executor has been shutdown or because its capacity has been reached,
 * the task is handled by the current {@code RejectedExecutionHandler}.
 *
 * @param command the task to execute
 * @throws RejectedExecutionException at discretion of
 *         {@code RejectedExecutionHandler}, if the task
 *         cannot be accepted for execution
 * @throws NullPointerException if {@code command} is null
 */
public void execute(Runnable command) {
    if (command == null)
        throw new NullPointerException();
    /*
     * Proceed in 3 steps:
     *
     * 1. If fewer than corePoolSize threads are running, try to
     * start a new thread with the given command as its first
     * task.  The call to addWorker atomically checks runState and
     * workerCount, and so prevents false alarms that would add
     * threads when it shouldn't, by returning false.
     *
     * 2. If a task can be successfully queued, then we still need
     * to double-check whether we should have added a thread
     * (because existing ones died since last checking) or that
     * the pool shut down since entry into this method. So we
     * recheck state and if necessary roll back the enqueuing if
     * stopped, or start a new thread if there are none.
     *
     * 3. If we cannot queue task, then we try to add a new
     * thread.  If it fails, we know we are shut down or saturated
     * and so reject the task.
     */
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) {
        if (addWorker(command, true))
            return;
        c = ctl.get();
    }
    if (isRunning(c) && workQueue.offer(command)) {
        int recheck = ctl.get();
        if (! isRunning(recheck) && remove(command))
            reject(command);
        else if (workerCountOf(recheck) == 0)
            addWorker(null, false);
    }
    else if (!addWorker(command, false))
        reject(command);
}
```

**三个细节**：

- `addWorker(command, true)` 的第二个参数表示以 `corePoolSize` 还是 `maximumPoolSize` 作为上限。
- 任务入队后要**二次检查**：若此时线程池已关闭，就把任务移出队列并拒绝；若线程数为 0（例如 `corePoolSize = 0`，或核心线程都已超时回收），就补一个不带首任务的线程去消费队列。
- `addWorker` 内部先用 CAS 把线程数加一，再在 `mainLock` 保护下把 `Worker` 放进 `workers` 集合并启动线程；启动失败会回滚计数。

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

`Worker` 自己实现了一把**不可重入锁**：线程执行任务时持有锁，空闲时不持有。`shutdown()` 通过 `tryLock()` 判断哪些线程是空闲的、只中断空闲线程。之所以不用 `ReentrantLock`，是为了防止任务代码里调用 `setCorePoolSize` 等控制方法时重入锁、把自己中断掉。

**线程复用的核心是 `runWorker` 的循环**（JDK 17，精简）：

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

**线程回收的核心是 `getTask`**（JDK 17，精简）：

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

### 7、BlockingQueue

`workQueue` 是线程池的缓冲队列，当所有核心线程都在工作时，新任务进入队列等待。

| 类型 | 容量 | 特点 | 适用场景 |
|------|------|------|---------|
| `LinkedBlockingQueue` | 默认无界（Integer.MAX_VALUE）| 吞吐量高，存在内存溢出风险 | `Executors.newFixedThreadPool` 默认使用 |
| `ArrayBlockingQueue` | 有界 | 有界，公平/非公平可配置 | 需要限制队列大小防止 OOM |
| `SynchronousQueue` | 0 | 不存储任务，直接交给线程 | `Executors.newCachedThreadPool` 使用，要求有线程立即接收 |
| `LinkedTransferQueue` | 无界 | 结合 `SynchronousQueue` 和 `LinkedBlockingQueue` 优点 | 高吞吐场景 |
| `PriorityBlockingQueue` | 无界 | 按优先级排序（需任务实现 Comparable）| 任务有优先级区分的场景 |
| `DelayedWorkQueue` | 无界 | 按执行时间排序的堆 | `ScheduledThreadPoolExecutor` 内部使用 |

> **生产建议**：使用 `ArrayBlockingQueue`（有界）+ 合理的拒绝策略，避免无界队列导致 OOM。队列的底层实现对比见 [集合框架 - BlockingQueue](./21_topic_collection.md#五、blockingqueue-线程池-生产消费核心)。

---

### 8、拒绝策略说明

当线程数已达 `maximumPoolSize` 且队列已满时，触发拒绝策略：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `AbortPolicy`（默认）| 抛出 `RejectedExecutionException` | 需要调用方感知并处理拒绝 |
| `CallerRunsPolicy` | 由提交任务的线程直接执行 | 不允许丢任务，可接受主线程变慢 |
| `DiscardPolicy` | 静默丢弃，不抛异常 | 任务可接受丢失（如日志统计）|
| `DiscardOldestPolicy` | 丢弃队列中最老的任务，重新提交新任务 | 优先保证最新任务执行 |
| 自定义 | 实现 `RejectedExecutionHandler` | 记录日志、告警、持久化等 |

```java
// 自定义拒绝策略：记录日志 + 降级处理
public class LoggingRejectionHandler implements RejectedExecutionHandler {
    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        log.error("线程池已满，任务被拒绝: {}, 队列大小: {}, 活跃线程: {}",
            r, executor.getQueue().size(), executor.getActiveCount());
        // 降级：同步执行或写消息队列
        r.run();
    }
}
```

**注意**：

- 拒绝策略在线程池**已关闭**时也会被触发。`CallerRunsPolicy` 在线程池关闭后会直接丢弃任务；上面自定义策略里的 `r.run()` 则会照常执行，需要时先判断 `executor.isShutdown()`。
- `CallerRunsPolicy` 本质是一种**反压**：提交方被迫亲自干活，提交速度自然降下来。但如果提交方是 Tomcat 请求线程，高峰期会连带拖慢整个 Web 容器。
- `DiscardPolicy` 丢任务无任何痕迹，除非任务确实可丢，否则至少要记日志和指标。

---

## 三、任务提交与异常处理

### 1、execute vs submit

| | `execute(Runnable)` | `submit(Runnable / Callable)` |
|--|---------------------|-------------------------------|
| 定义位置 | `Executor` | `ExecutorService` |
| 返回值 | 无 | `Future<?>`，可取结果、取消任务 |
| 任务包装 | 原样执行 | 包装为 `FutureTask` |
| 任务抛出异常时 | 异常抛出到工作线程，打印堆栈（交给 `UncaughtExceptionHandler`），**该线程退出并被替换** | 异常被捕获并保存在 `Future` 里，**不调用 `get()` 就无声无息** |

### 2、submit "吞异常" 示例

```java
ExecutorService pool = Executors.newFixedThreadPool(1);

pool.execute(() -> { throw new IllegalStateException("execute 异常"); });
// 控制台打印：Exception in thread "pool-1-thread-1" java.lang.IllegalStateException: execute 异常

Future<?> f = pool.submit(() -> { throw new IllegalStateException("submit 异常"); });
// 控制台什么都没有！

f.get();  // 此时才抛出 ExecutionException，cause 为 IllegalStateException
```

### 3、四种异常处理方式

| 方式 | 做法 | 适用 |
|------|------|------|
| 任务内 try-catch | 在 `run/call` 里自行捕获并记录 | 最直接，推荐作为默认习惯 |
| `Future.get()` | 调用方获取结果时处理 `ExecutionException` | 需要结果的 `submit` 场景 |
| 重写 `afterExecute` | 在线程池层面统一记录异常 | 统一兜底，`execute` / `submit` 都能覆盖 |
| `UncaughtExceptionHandler` | 通过 `ThreadFactory` 设置 | **只对 `execute` 生效**，`submit` 的异常不会走到这里 |

`afterExecute` 的标准写法（来自 JDK 文档示例，同时兼容 `submit`）：

```java
public class SafeThreadPoolExecutor extends ThreadPoolExecutor {
    // 构造方法略

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

---

## 四、关闭线程池

| 方法 | 行为 | 返回 |
|------|------|------|
| `shutdown()` | 不再接收新任务；已提交的任务（含队列中的）继续执行；只中断空闲线程 | 立即返回，不等待 |
| `shutdownNow()` | 不再接收新任务；清空队列；对所有工作线程调用 `interrupt()` | 返回队列中未执行的任务列表 |
| `awaitTermination(timeout)` | 阻塞等待线程池进入 `TERMINATED` | 超时前终止返回 `true` |
| `close()`（JDK 19+） | `ExecutorService` 实现了 `AutoCloseable`，等价于 shutdown + 等待终止 | 可用于 try-with-resources |

::: warning
`shutdownNow()` 只是**发中断信号**。任务如果不响应中断（没有检查 `Thread.interrupted()`，也不调用 `sleep`、`wait`、`BlockingQueue.take` 这类可中断的阻塞方法），就会一直跑完。
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

// JDK 19+ 可以直接用 try-with-resources
try (ExecutorService pool = Executors.newFixedThreadPool(4)) {
    pool.submit(task1);
    pool.submit(task2);
}   // 离开代码块时自动等待所有任务完成
```

应用里的全局线程池应在进程退出前关闭：Spring 管理的 `ThreadPoolTaskExecutor` 会随容器销毁自动关闭；自己 new 的线程池可以注册为 Bean 并指定 `destroyMethod`，或注册 JVM ShutdownHook。服务下线流程见 [高可用 - 优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 五、扩展与监控

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
// 定时采集线程池指标，接入监控系统（Micrometer 也可直接用 ExecutorServiceMetrics 绑定）
scheduler.scheduleAtFixedRate(() -> log.info(
        "pool={} size={} active={} queue={} completed={}",
        name, pool.getPoolSize(), pool.getActiveCount(),
        pool.getQueue().size(), pool.getCompletedTaskCount()),
    0, 10, TimeUnit.SECONDS);
```

`getActiveCount`、`getCompletedTaskCount` 等方法内部会获取 `mainLock` 并遍历所有 Worker，采集间隔以秒为单位即可，不要在每次提交任务时调用。

### 3、运行时调整参数

`setCorePoolSize`、`setMaximumPoolSize`、`setKeepAliveTime`、`setRejectedExecutionHandler` 都可以在运行中调用并立即生效，这正是 DynamicTP 等**动态线程池**的实现基础。

- 调大 `corePoolSize` 时，如果队列中有积压，会立即创建新线程去消费。
- 调小时，多余的线程会在空闲后逐步退出。
- **队列容量不能动态修改**（`ArrayBlockingQueue` 的容量是 final）。动态线程池框架一般会提供可修改容量的自定义队列。

---

## 六、ScheduledThreadPoolExecutor

用于执行**延迟任务**和**周期任务**，是 `Timer` 的替代品。它内部使用按执行时间排序的 `DelayedWorkQueue`，只用核心线程执行，`maximumPoolSize` 不起作用。

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
| 时间基准 | 系统时间，改系统时钟会受影响 | `System.nanoTime` 相对时间 |

集群环境下的分布式定时任务见 [分布式调度](/distributed/6_job_scheduler)。

---

## 七、Fork/Join

### 1、Fork/Join 工作窃取算法

Fork/Join 框架用于**递归分治**任务，每个工作线程有一个双端队列（Deque），空闲线程从其他线程队列**尾部窃取**任务。

```java
public class SumTask extends RecursiveTask<Long> {
    private static final int THRESHOLD = 1000;
    private final long[] arr;
    private final int start, end;

    @Override
    protected Long compute() {
        if (end - start <= THRESHOLD) {
            // 任务足够小，直接计算
            long sum = 0;
            for (int i = start; i < end; i++) sum += arr[i];
            return sum;
        }
        // 拆分任务
        int mid = (start + end) / 2;
        SumTask left = new SumTask(arr, start, mid);
        SumTask right = new SumTask(arr, mid, end);
        left.fork();               // 异步执行左半部分
        return right.compute()     // 当前线程执行右半部分
             + left.join();        // 等待左半部分结果
    }
}

ForkJoinPool pool = new ForkJoinPool();
long result = pool.invoke(new SumTask(arr, 0, arr.length));
```

`parallelStream` 与 `CompletableFuture` 的默认线程池都是 `ForkJoinPool.commonPool()`。

### 2、ForkJoinPool vs ThreadPoolExecutor

| | `ForkJoinPool` | `ThreadPoolExecutor` |
|--|----------------|----------------------|
| 任务队列 | 每个线程一个双端队列 + 工作窃取 | 所有线程共享一个阻塞队列 |
| 适合的任务 | 可递归拆分的 CPU 密集型计算 | 相互独立的业务任务，包括 IO 密集型 |
| 任务间关系 | 父任务 `join` 等待子任务，且等待时线程会去帮忙执行其他任务 | 任务之间最好没有依赖，否则可能死锁 |
| 默认并行度 | `commonPool` 为 CPU 核数 - 1 | 由构造参数决定 |

::: warning
`commonPool` 是**全 JVM 共享**的：`parallelStream`、不传 Executor 的 `CompletableFuture.xxxAsync` 都在用它。在里面执行阻塞 IO，会拖慢整个应用的并行计算。IO 任务请使用独立的线程池。
:::

---

## 八、虚拟线程与线程池（JDK 21+）

虚拟线程由 JVM 调度，创建和阻塞的成本极低（百万级也没问题），**不需要、也不应该池化**：

```java
// 每个任务一个虚拟线程
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 10_000; i++) {
        int id = i;
        executor.submit(() -> callRemoteService(id));   // 阻塞 IO 时虚拟线程会让出载体线程
    }
}
```

| | 平台线程池 | 虚拟线程 |
|--|-----------|---------|
| 线程成本 | 1:1 映射 OS 线程，MB 级栈，数量有限 | 由 JVM 调度，KB 级栈，可大量创建 |
| 池化 | 必须池化复用 | **不池化**，用完即弃 |
| 限流方式 | 靠线程数 + 队列长度 | 线程不再是瓶颈，需要用 `Semaphore` 等方式单独限制对下游的并发 |
| 适合 | CPU 密集型任务、需要精确控制并发的场景 | 大量阻塞 IO 的高并发任务 |

```java
// 虚拟线程下控制对下游的并发数：用信号量而不是线程池大小
private final Semaphore permits = new Semaphore(50);

void callWithLimit() throws InterruptedException {
    permits.acquire();
    try {
        callRemoteService();
    } finally {
        permits.release();
    }
}
```

**注意**：

- 在 JDK 21–23 中，虚拟线程在 `synchronized` 块内阻塞会**钉住**（pin）载体线程，无法让出。这类代码需要改用 `ReentrantLock`。JDK 24（JEP 491）已消除 `synchronized` 导致的钉住。
- 虚拟线程上的 `ThreadLocal` 依然可用，但虚拟线程数量巨大，在 ThreadLocal 里缓存大对象会显著放大内存占用。
- CPU 密集型任务用虚拟线程没有收益，仍然使用大小固定的平台线程池。

Spring Boot 3.2+ 开启 `spring.threads.virtual.enabled=true` 即可让 Tomcat 和 `@Async` 使用虚拟线程，详见 [异步任务与定时任务](/spring-boot/9_async_schedule)。

---

## 九、Spring 中的线程池

| 组件 | 说明 |
|------|------|
| `ThreadPoolTaskExecutor` | Spring 对 `ThreadPoolExecutor` 的封装，支持 Bean 生命周期（容器关闭时自动 shutdown）、`TaskDecorator` |
| `SimpleAsyncTaskExecutor` | **每个任务新建一个线程**，不复用。没有 Spring Boot 自动配置时，`@Async` 默认使用它，高并发下线程数会失控 |
| Spring Boot 自动配置 | 提供名为 `applicationTaskExecutor` 的 `ThreadPoolTaskExecutor`，通过 `spring.task.execution.pool.*` 配置 |

```java
@Bean("orderExecutor")
public ThreadPoolTaskExecutor orderExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(16);
    executor.setQueueCapacity(500);
    executor.setThreadNamePrefix("order-");
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    // 把调用线程的 MDC（traceId）复制到工作线程
    executor.setTaskDecorator(runnable -> {
        Map<String, String> context = MDC.getCopyOfContextMap();
        return () -> {
            try {
                if (context != null) MDC.setContextMap(context);
                runnable.run();
            } finally {
                MDC.clear();
            }
        };
    });
    executor.setWaitForTasksToCompleteOnShutdown(true);
    executor.setAwaitTerminationSeconds(30);
    return executor;
}

@Async("orderExecutor")   // 显式指定线程池，不要依赖默认值
public void createOrderAsync(OrderDTO dto) { ... }
```

::: tip
Spring Boot 默认的 `applicationTaskExecutor` 的队列容量和最大线程数都是 `Integer.MAX_VALUE`，本质上和 `newFixedThreadPool` 一样是无界队列。生产环境要么在配置里显式限制，要么为不同业务定义独立的线程池。
:::

---

## 十、常见坑

| 坑 | 现象 | 解决 |
|----|------|------|
| 使用 `Executors` 创建 | 无界队列 / 无上限线程导致 OOM | 手动 `new ThreadPoolExecutor`，使用有界队列（见 [线程基础](./23_topic_thread_basics.md#四、线程池基础-executors)） |
| 父子任务共用一个线程池 | 父任务占满线程并等待子任务，子任务在队列里排队 → **线程池饥饿死锁** | 父子任务使用不同线程池，或改为 `CompletableFuture` 异步编排 |
| `submit` 后不调用 `get` | 异常被吞掉，问题无从排查 | 任务内 try-catch，或重写 `afterExecute` |
| 周期任务抛异常 | 后续调度静默停止 | 任务体整体 try-catch |
| ThreadLocal 未清理 | 线程复用导致数据串到下一个任务、内存泄漏 | `finally` 中 `remove()`；跨线程传递用 TTL（见 [线程基础 - ThreadLocal](./23_topic_thread_basics.md#五、threadlocal)） |
| 在方法内部 new 线程池且不关闭 | 每次调用都创建新线程池，核心线程不退出 → 线程泄漏 | 线程池定义为单例或 Spring Bean |
| 线程没有命名 | `jstack` 里全是 `pool-3-thread-7`，无法定位业务 | 自定义 `ThreadFactory` 加业务前缀 |
| 所有业务共用一个线程池 | 某个慢业务占满线程，拖垮其他业务 | 按业务隔离线程池（舱壁模式，见 [高可用 - 隔离、重试与超时](/high-avail/4_timeout_retry_bulkhead)） |
| 在 `commonPool` 里做阻塞 IO | `parallelStream` / `CompletableFuture` 全局变慢 | IO 任务传入自定义线程池 |
| `CallerRunsPolicy` 用在 Web 请求链路上 | 高峰期 Tomcat 线程被拖去执行任务，接口整体超时 | 核心链路优先考虑快速失败 + 降级 |

父子任务死锁的最小复现：

```java
ExecutorService pool = Executors.newFixedThreadPool(2);

for (int i = 0; i < 2; i++) {
    pool.submit(() -> {
        // 父任务占住 2 个线程，又提交子任务并等待结果
        Future<String> child = pool.submit(() -> "child");
        return child.get();   // 子任务永远排在队列里，没有线程执行 → 永久阻塞
    });
}
```

---

## 十一、常见面试问题

**Q：线程池的核心参数有哪些？任务提交后的执行流程？**

7 个参数：核心线程数、最大线程数、空闲存活时间及单位、工作队列、线程工厂、拒绝策略。流程是"核心线程 → 队列 → 非核心线程 → 拒绝"：线程数小于核心数就新建线程；否则入队；队列满了且线程数小于最大值就新建非核心线程；都不满足则执行拒绝策略。

**Q：线程池是如何复用线程的？非核心线程是如何被回收的？**

每个线程被包装成 `Worker`，在 `runWorker` 里循环调用 `getTask()` 从队列取任务执行，所以一个线程能执行很多个任务。当线程数超过核心数时，`getTask` 用 `poll(keepAliveTime)` 取任务；超时拿不到就返回 `null`，线程退出循环后结束。核心线程用 `take()` 一直阻塞，所以不会被回收（除非设置了 `allowCoreThreadTimeOut`）。

**Q：线程池有哪几种状态？`shutdown` 和 `shutdownNow` 的区别？**

五种：RUNNING、SHUTDOWN、STOP、TIDYING、TERMINATED，与线程数一起保存在 `ctl` 中（高 3 位是状态）。`shutdown` 不接收新任务，但会把队列中的任务执行完，只中断空闲线程；`shutdownNow` 会清空队列、中断所有线程，并返回未执行的任务列表。

**Q：`execute` 和 `submit` 有什么区别？任务抛异常会怎样？**

`submit` 会把任务包装成 `FutureTask` 并返回 `Future`；异常被保存在 `Future` 中，调用 `get()` 时才以 `ExecutionException` 抛出，不调用就看不到。`execute` 的异常会直接抛到工作线程，打印堆栈后该线程退出，线程池再补一个新线程。

**Q：核心线程数设置为 0 会怎样？**

任务会直接进入队列。`execute` 在入队后二次检查时发现线程数为 0，会调用 `addWorker(null, false)` 补一个线程去消费队列，所以任务依然会执行，只是始终只有少量线程（队列满之前最多 1 个）。

**Q：如何让线程池先扩容到最大线程数，再使用队列？**

自定义队列：在 `offer` 中如果当前线程数小于 `maximumPoolSize` 就返回 `false`，让线程池以为队列满了而去新建线程。Tomcat 的 `TaskQueue` 和 Dubbo 的 `EagerThreadPoolExecutor` 都是这个思路。

**Q：线程数应该设置多少？**

CPU 密集型约为核数 + 1，IO 密集型按 `核数 × (1 + 等待时间 / 计算时间)` 估算，最终以压测结果为准，并结合动态线程池在线调整。详见 [高并发 - 并发参数调优](/high-con/7_concurrency_tuning#一、线程池参数调优)。

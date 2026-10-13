---
description: ScheduledThreadPoolExecutor 延迟与周期任务、fixedRate 与 fixedDelay、Timer 对比、工作窃取、ForkJoinPool 与 commonPool
---

# Fork/Join 与定时任务

> 前置阅读：[线程池](./28_topic_thread_pool)

`ScheduledThreadPoolExecutor` 和 `ForkJoinPool` 是 `ThreadPoolExecutor` 之外最常用的两种 JDK 执行器，前者负责延迟与周期调度，后者用工作窃取跑递归分治计算。本篇讲周期任务的两种节奏与异常陷阱、工作窃取原理、`ForkJoinPool` 与普通线程池的分工以及 `commonPool` 的共享风险，基线为 JDK 21。

---

## 一、ScheduledThreadPoolExecutor

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

## 二、Fork/Join

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

## 小结

- `ScheduledThreadPoolExecutor` 内部是无界的 `DelayedWorkQueue`，只用核心线程执行，`maximumPoolSize` 不起作用
- `scheduleAtFixedRate` 按上一次开始计算间隔、超时不会并发执行；`scheduleWithFixedDelay` 按上一次结束计算间隔
- 周期任务抛出未捕获异常会静默停止后续调度，任务体必须整体 try-catch；用它替代单线程、一抛异常就整体终止的 `Timer`
- Fork/Join 每线程一个双端队列：自己 LIFO 取任务，空闲线程从别人队列 FIFO 窃取；适合可递归拆分的 CPU 密集计算
- `commonPool` 全 JVM 共享，`parallelStream` 与不传执行器的 `CompletableFuture.xxxAsync` 都在用，并行度受容器 CPU 限额影响，阻塞 IO 不要放进去
- 集群级定时任务见 [分布式调度](/distributed/6_job_scheduler)，Spring 的 `@Scheduled` 见 [异步任务与定时任务](/spring-boot/7_async_schedule)

## 参考资料

- JDK 25 API：[ScheduledThreadPoolExecutor](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ScheduledThreadPoolExecutor.html)
- JDK 25 API：[ForkJoinPool](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ForkJoinPool.html)、[RecursiveTask](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/RecursiveTask.html)

> 下一篇：[CompletableFuture](./29_topic_completable_future) —— 在线程池之上编排异步任务：回调线程、组合、异常传播与超时。

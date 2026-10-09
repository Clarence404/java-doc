---
description: M:N 调度与挂载卸载、钉住与 JEP 491、诊断、ScopedValue、结构化并发、适用边界
---

# 虚拟线程

> **本篇目标**：理解虚拟线程为什么能廉价地阻塞（载体线程、挂载与卸载、Continuation），掌握"不池化、用信号量限流"的使用方式，清楚钉住问题在 JDK 21–23 与 JDK 24+ 的差别和诊断手段，并知道 `ScopedValue`、结构化并发的现状与它们的边界。
>
> **前置阅读**：[线程池](./28_topic_thread_pool)、[CompletableFuture](./29_topic_completable_future)

---

## 一、为什么需要虚拟线程

典型的 Web 服务是 **thread-per-request**：一个请求占一个线程，大部分时间在等数据库、等下游 HTTP。按 Little 定律，**并发数 = 吞吐量 × 平均耗时**：要扛 5000 QPS、每个请求 200 ms，就需要约 1000 个线程同时在途。

平台线程（`java.lang.Thread` 的传统实现）与 OS 线程 1:1 绑定，每个线程预留 MB 级栈空间（64 位 Linux 默认 1 MB）、占用内核调度资源，上下文切换在微秒级。线程数到几千就会触到内存与调度的天花板，于是出现了两条路：

| 路线 | 做法 | 代价 |
|------|------|------|
| 线程池 + 阻塞代码 | 线程数有上限，超出部分排队 | 吞吐被线程数卡住，线程大部分时间在空等 |
| 异步 / 反应式（`CompletableFuture`、WebFlux） | 不阻塞线程，少量线程处理大量请求 | 回调链难写难调试，栈追踪断裂，整条链路都要异步化 |
| **虚拟线程**（JDK 21） | 线程本身变廉价，阻塞时让出底层 OS 线程 | 保持同步写法，按需创建百万级线程 |

虚拟线程提升的是**吞吐量**（同时在途的阻塞任务数），不是单个任务的**速度**。它对 CPU 密集型任务没有帮助。

---

## 二、实现原理

### 1、M:N 调度：虚拟线程与载体线程

- **虚拟线程**是 `Thread` 的一种实现，由 JVM 而不是 OS 调度。它本身只是堆上的一个对象，加上一段可增长的栈帧数据。
- **载体线程**（carrier thread）是真正运行代码的平台线程。M 个虚拟线程复用 N 个载体线程。
- **调度器**是一个**专用的 `ForkJoinPool`**（FIFO 模式），与 `ForkJoinPool.commonPool()` 互不相干。

| 系统属性 | 默认值 | 作用 |
|---------|-------|------|
| `jdk.virtualThreadScheduler.parallelism` | CPU 核数（`availableProcessors`） | 同时运行虚拟线程的载体线程数 |
| `jdk.virtualThreadScheduler.maxPoolSize` | 256 | 载体线程上限，补偿期间可临时超过 `parallelism` |

载体线程数约等于 CPU 核数：CPU 一直是满的，阻塞的虚拟线程不占载体。这也解释了为什么 CPU 密集型任务用虚拟线程没有收益——任务不阻塞，载体就不会被让出，并行度仍然是核数。

### 2、挂载与卸载

![虚拟线程在载体线程上的挂载与卸载](../assets/java/virtual_thread_mount.svg)

1. **挂载（mount）**：调度器从队列取出一个就绪的虚拟线程，在某个载体线程上恢复它的执行。此时 `Thread.currentThread()` 返回的是虚拟线程，载体线程对业务代码不可见。
2. **卸载（unmount）**：虚拟线程执行到阻塞点（socket 读写、`Thread.sleep`、`LockSupport.park`、`BlockingQueue.take` 等），JDK 不去阻塞 OS 线程，而是把它的栈帧保存到堆上，让出载体线程，载体线程立刻去执行下一个就绪的虚拟线程。
3. **恢复**：IO 就绪、锁被释放、睡眠到期时，`unpark` 把这个虚拟线程重新提交给调度器，它会被挂载到**任意**空闲的载体线程上继续执行，不一定是原来那个。

阻塞 socket IO 能卸载，是因为 JDK 把 `java.net` / `java.nio` 的阻塞调用改成了"把 socket 注册到内部 poller、park 当前虚拟线程"，IO 就绪后再 unpark。业务代码与 JDBC / HTTP 客户端写法完全不变。

### 3、Continuation

卸载 / 恢复的底层是 JDK 内部类 `jdk.internal.vm.Continuation`（不是公开 API）：

- 每个虚拟线程持有一个 `Continuation`，挂载就是在载体线程上调用 `cont.run()`；
- 遇到阻塞点调用 `Continuation.yield()`：**冻结（freeze）**当前栈帧，把它们拷贝到堆上的 `StackChunk` 对象中，`run()` 返回，载体线程空出来；
- 恢复时**解冻（thaw）**：把栈帧拷回载体线程的栈。解冻是**惰性**的，只先拷回顶部少量栈帧，返回到更深的帧时再按需拷贝，深调用栈的切换成本因此不高。

栈帧存放在堆上、由 GC 管理，所以虚拟线程的"栈"按需增长，空闲时只占几百字节到几 KB，这是能创建百万级虚拟线程的根本原因。

### 4、哪些操作不能卸载

| 情况 | JDK 21–23 | JDK 24+ |
|------|-----------|---------|
| `synchronized` 块 / 方法内阻塞 | **钉住**载体线程 | 可以卸载（JEP 491） |
| `Object.wait()` | 钉住，调度器临时增加载体线程补偿 | 可以卸载（JEP 491） |
| 文件 IO 等部分阻塞系统调用 | 占住载体线程，调度器临时增加载体线程补偿 | 同左 |
| 栈上有 native 方法 / FFM 外部函数帧，在其回调中阻塞 | 钉住 | 仍然钉住 |
| 类加载、类初始化（`<clinit>`）中阻塞，或等待其他线程完成类初始化 | 钉住 | 仍然钉住 |

"补偿"是指调度器发现载体线程被占住时，临时创建额外的载体线程（不超过 `maxPoolSize`），避免可运行的虚拟线程饿死。钉住的细节见第五节。

---

## 三、创建与使用

```java
// 1. 直接启动
Thread vt = Thread.startVirtualThread(() -> handle(request));

// 2. 构建器：可命名、可设置未捕获异常处理器
Thread worker = Thread.ofVirtual()
        .name("order-vt-", 0)                       // order-vt-0、order-vt-1……
        .uncaughtExceptionHandler((t, e) -> log.error("{} 异常", t.getName(), e))
        .start(() -> handle(request));

// 3. 每任务一个虚拟线程的执行器（最常用）
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<Quote>> quotes = suppliers.stream()
            .map(s -> executor.submit(() -> s.quote(sku)))
            .toList();
    // ... 收集结果
}   // close() 等待所有任务结束

// 4. 需要统一命名时：线程工厂 + newThreadPerTaskExecutor
ThreadFactory factory = Thread.ofVirtual().name("io-vt-", 0).factory();
ExecutorService named = Executors.newThreadPerTaskExecutor(factory);
```

虚拟线程与平台线程的行为差异：

| 特性 | 虚拟线程 |
|------|---------|
| 守护线程 | 永远是守护线程，`setDaemon(false)` 抛 `IllegalArgumentException` |
| 优先级 | 固定为 `NORM_PRIORITY`，`setPriority` 无效 |
| 线程组 | 不能指定，统一归入一个占位线程组 |
| 判断方式 | `thread.isVirtual()` |
| `Thread.getAllStackTraces()` | 只返回平台线程，不含虚拟线程 |
| `InheritableThreadLocal` | 默认继承，可用 `Thread.ofVirtual().inheritInheritableThreadLocals(false)` 关闭 |

---

## 四、使用原则

### 1、不要池化虚拟线程

线程池存在的意义是复用昂贵的线程、限制线程数。虚拟线程创建成本与一个普通对象相当，池化既没有收益，还会带来 `ThreadLocal` 串数据等池化特有的问题。**每个任务创建一个新的虚拟线程，用完即弃**。

把 `newFixedThreadPool(200)` 的线程工厂换成虚拟线程工厂，同样是误用：线程数仍被卡在 200，只是换了一种线程。

### 2、用 Semaphore 限制对下游的并发

线程池大小以前顺带起到了"最多 N 个任务同时打下游"的作用。改用虚拟线程后这道闸门消失，瞬间几万个虚拟线程会一起涌向数据库或第三方接口。并发上限要**按资源单独设置**：

```java
public class InventoryClient {
    private final Semaphore permits = new Semaphore(50);   // 下游最多承受 50 个并发

    public Stock query(long skuId) throws InterruptedException {
        if (!permits.tryAcquire(200, TimeUnit.MILLISECONDS)) {
            throw new RejectedExecutionException("库存服务并发已满");
        }
        try {
            return http.get("/stock/" + skuId);
        } finally {
            permits.release();
        }
    }
}
```

数据库则直接由连接池大小限流（HikariCP `maximumPoolSize`），虚拟线程拿不到连接时会在等待中卸载，不浪费载体线程。容器层的并发闸门（Tomcat `max-connections`）见 [并发参数调优](/high-con/7_concurrency_tuning)。

### 3、CPU 密集型任务不要用

计算任务不阻塞、不卸载，一直占着载体线程；载体线程数约等于核数，虚拟线程再多也不会更快，反而让同一调度器上的 IO 型虚拟线程排队。计算任务继续用固定大小的平台线程池或 `ForkJoinPool`。

### 4、ThreadLocal 的成本

`ThreadLocal` 在虚拟线程上照常工作，但要重新评估两种用法：

- **缓存昂贵对象**（如 `ThreadLocal<SimpleDateFormat>`）：在平台线程池里是"每线程一份、复用千万次"，在虚拟线程上变成"每任务一份、用一次就丢"，百万虚拟线程就是百万份。改用线程安全的替代（`DateTimeFormatter`）或显式的对象池。
- **传递上下文**（traceId、当前用户）：可变、生命周期不清晰、子线程继承要复制整张表。JDK 25 起有更合适的 `ScopedValue`，见第七节。

---

## 五、钉住（Pinning）

### 1、什么是钉住

虚拟线程在某些位置阻塞时**无法卸载**，它会连同载体线程一起阻塞，这称为钉住。少量短暂的钉住无害；但如果高并发路径上大量虚拟线程在钉住状态下等 IO，载体线程（约等于核数）很快全部被占满，其他虚拟线程无法运行，吞吐退化到甚至不如平台线程池，严重时表现为"假死"。

### 2、JDK 21–23：synchronized 是主要来源

在 JDK 21–23 中，对象监视器由 OS 线程持有，虚拟线程在 `synchronized` 内部阻塞（包括在 `synchronized` 里做 IO、或调用 `Object.wait()`）时无法卸载。典型的坑是：自己的代码没有问题，但用到的老版本 JDBC 驱动、连接池、日志框架在热点路径上用了 `synchronized`。

这些版本上的应对：

- 持锁期间会阻塞的代码改用 `ReentrantLock`（j.u.c 的锁基于 `LockSupport.park`，可以卸载）；
- 升级依赖库，主流驱动与框架已陆续把热点 `synchronized` 改为 `ReentrantLock`；
- 只在锁内做内存操作的短 `synchronized` 不需要改，它不阻塞，也就谈不上钉住。

### 3、JDK 24：JEP 491 消除了 synchronized 钉住

JEP 491 让虚拟线程可以独立于载体线程获取、持有、释放监视器：在 `synchronized` 内阻塞、在竞争监视器时等待、调用 `Object.wait()`，虚拟线程都会卸载。**JDK 24+ 不再需要为虚拟线程把 `synchronized` 改成 `ReentrantLock`**，两者的选择回到功能需求本身（可中断、超时、公平、多条件，见 [显式锁（Lock）](./25_topic_lock)）。

仍然会钉住的情况只剩少数：

- 栈上有 native 帧：通过 JNI 或 FFM API 调用本地代码，本地代码又回调 Java 并在其中阻塞；
- 类加载、类初始化：在 `<clinit>` 中阻塞，或等待另一个线程完成某个类的初始化。

### 4、版本建议

| 基线 | 建议 |
|------|------|
| JDK 17 及以下 | 没有虚拟线程，用线程池或 `CompletableFuture` |
| JDK 21 | 可以用，但要排查热点路径上的 `synchronized` + 阻塞，开启 JFR 观察钉住事件 |
| JDK 25 LTS | **推荐的虚拟线程生产基线**：没有 `synchronized` 钉住，`ScopedValue` 已正式 |

---

## 六、诊断

| 手段 | 用法 | 说明 |
|------|------|------|
| JSON 线程转储 | `jcmd <pid> Thread.dump_to_file -format=json /tmp/threads.json` | 包含虚拟线程及其栈，按执行器 / 结构化并发的树形结构组织；`jstack` 与 `jcmd Thread.print` 只列平台线程 |
| JFR 钉住事件 | `jdk.VirtualThreadPinned` | 默认开启，阻塞超过 20 ms 记录；JDK 24 起事件中带钉住原因与载体线程 |
| JFR 其他事件 | `jdk.VirtualThreadSubmitFailed`（默认开启）、`jdk.VirtualThreadStart` / `End`（默认关闭） | 提交失败通常意味着资源耗尽；起止事件开销大，按需开启 |
| `-Djdk.tracePinnedThreads=full` | JDK 21–23 打印钉住时的栈 | **JDK 24 已移除**，设置了也不生效，统一用 JFR |

```bash
# 录制 60 秒，查看钉住事件
jcmd <pid> JFR.start name=vt duration=60s filename=/tmp/vt.jfr
jfr print --events jdk.VirtualThreadPinned /tmp/vt.jfr
```

JFR 与 `jcmd` 的通用用法见 [诊断工具](/jvm/8_monitoring_tools)。

---

## 七、ScopedValue（JDK 25 正式）

`ScopedValue`（JEP 506）是为虚拟线程时代设计的上下文传递方式：在一个**有界的代码范围**内绑定一个**不可变**的值，范围结束自动解绑。

```java
public final class RequestContext {
    public static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();
}

// 入口处（如 Filter）：只在 run 的范围内绑定
ScopedValue.where(RequestContext.CURRENT_USER, user)
        .run(() -> chain.doFilter(request, response));

// 调用链任意深处读取
User user = RequestContext.CURRENT_USER.get();          // 未绑定时抛 NoSuchElementException
boolean bound = RequestContext.CURRENT_USER.isBound();

// 需要返回值时用 call
Order order = ScopedValue.where(RequestContext.CURRENT_USER, user).call(() -> orderService.place(cmd));
```

| | `ThreadLocal` | `ScopedValue` |
|--|---------------|---------------|
| 可变性 | 可随时 `set`，任何代码都能改 | 绑定后不可变，只能在内层范围重新绑定（遮蔽） |
| 生命周期 | 直到 `remove()` 或线程结束，忘记清理就泄漏 / 串数据 | 随 `run` / `call` 的代码块结束自动解绑 |
| 子线程继承 | `InheritableThreadLocal` 在创建线程时复制整张表 | **只有** `StructuredTaskScope` 中 fork 的子线程会继承，零拷贝共享 |
| 读取开销 | 哈希查找 | 可被 JIT 缓存，接近读字段 |
| 适合 | 可变的每线程状态、旧代码兼容 | 请求级只读上下文：当前用户、traceId、租户 |

注意 `ScopedValue` 不会传到普通线程池或 `CompletableFuture` 的回调里，这些场景仍需包装执行器（见 [CompletableFuture](./29_topic_completable_future) 的上下文传递一节）。JDK 21–24 中 `ScopedValue` 是预览特性，API 有过调整，生产使用以 JDK 25 为准。

---

## 八、结构化并发（预览）

::: warning 预览特性
`StructuredTaskScope` 在 JDK 25（JEP 505，第五次预览）和 JDK 26（JEP 525，第六次预览）中仍是**预览 API**，编译和运行都要加 `--enable-preview`，且每个版本都有不兼容调整。下面的代码基于 JDK 25；不要在生产中依赖它，除非团队接受随 JDK 升级修改代码。
:::

结构化并发把"一个任务拆成几个并发子任务"当作一个整体：子任务的生命周期不超过父任务的代码块，一个失败时其余自动取消，取消父任务时子任务一起取消，线程转储中能看到父子关系。

```java
// javac --release 25 --enable-preview
Profile loadProfile(long uid) throws InterruptedException {
    try (var scope = StructuredTaskScope.open()) {                 // 默认策略：全部成功，任一失败即取消其余
        Subtask<User>        user   = scope.fork(() -> userClient.get(uid));
        Subtask<List<Order>> orders = scope.fork(() -> orderClient.list(uid));
        scope.join();                                              // 任一失败时抛 StructuredTaskScope.FailedException
        return new Profile(user.get(), orders.get());
    }
}
```

- JDK 25 把原来的 `ShutdownOnFailure` / `ShutdownOnSuccess` 子类改为 `StructuredTaskScope.open(Joiner)` 静态工厂 + `Joiner` 策略：`Joiner.allSuccessfulOrThrow()`、`Joiner.anySuccessfulResultOrThrow()`、`Joiner.awaitAll()` 等；超时通过 `open(joiner, cf -> cf.withTimeout(Duration.ofSeconds(1)))` 配置。
- JDK 26 继续调整：`allSuccessfulOrThrow()` 的 `join()` 直接返回结果列表，`anySuccessfulResultOrThrow()` 更名为 `anySuccessfulOrThrow()`。
- 2026 年 9 月发布的 JDK 27（JEP 533）仍是预览，失败时 `join()` 抛出的异常类型又有调整，升级时以对应版本的 Javadoc 为准。
- fork 出的子任务默认运行在虚拟线程上，并继承父线程的 `ScopedValue` 绑定。

与 `CompletableFuture.allOf` 相比，它的核心价值是**快速失败与自动取消**，以及异常、线程转储都保持清晰的父子结构。

---

## 九、在 Spring Boot 中开启

Spring Boot 3.2+、JDK 21+ 设置 `spring.threads.virtual.enabled=true`，Tomcat / Jetty 的请求处理、`@Async` 默认执行器、`@Scheduled` 及部分消息监听容器都会改用虚拟线程。开关影响的组件清单与注意事项见 [异步任务与定时任务](/spring-boot/9_async_schedule)。开启前先确认两件事：对下游的并发是否已有连接池或信号量兜底；JDK 21–23 上依赖库是否在热点路径使用 `synchronized` 阻塞。

---

## 十、什么时候不用

| 场景 | 原因 | 替代 |
|------|------|------|
| CPU 密集型计算 | 不阻塞就不卸载，并行度仍是核数 | 固定大小的平台线程池、`ForkJoinPool`、`parallelStream` |
| 需要"最多 N 个任务同时执行"的限流语义 | 虚拟线程没有池大小这道闸门 | 平台线程池，或虚拟线程 + `Semaphore` |
| 大量时间耗在 native 调用里阻塞 | native 帧会钉住载体线程 | 平台线程池隔离 |
| 重度依赖 `ThreadLocal` 缓存大对象 | 每个虚拟线程一份，内存放大 | 先改造缓存方式 |
| JDK 21–23 且热点路径大量 `synchronized` + IO | 钉住导致吞吐退化 | 升级到 JDK 24+，或改用 `ReentrantLock` |
| 已经是全链路反应式（WebFlux + R2DBC） | 没有阻塞可以消除 | 维持现状 |

---

## 小结

- 虚拟线程是 JVM 调度的 `Thread`：M 个虚拟线程跑在约等于核数的载体线程上，调度器是专用的 `ForkJoinPool`
- 阻塞时 `Continuation.yield` 把栈帧冻结到堆上并卸载，就绪后挂载到任意载体线程继续；这让同步写法获得接近异步的吞吐
- 用法：`newVirtualThreadPerTaskExecutor()` 每任务一个线程，不池化；对下游的并发用 `Semaphore` 或连接池限制
- 钉住：JDK 21–23 的 `synchronized` 内阻塞与 `Object.wait()` 会钉住载体线程；JDK 24（JEP 491）已解决，只剩 native 帧与类初始化等少数情况
- 诊断用 `jcmd Thread.dump_to_file -format=json` 与 JFR `jdk.VirtualThreadPinned`；`-Djdk.tracePinnedThreads` 在 JDK 24 已移除
- `ScopedValue` 在 JDK 25 正式，是不可变、自动解绑的上下文传递方式，只通过 `StructuredTaskScope` 继承
- 结构化并发在 JDK 25 / 26 仍是预览，API 每版都在变
- CPU 密集型任务、需要池化限流语义的场景不用虚拟线程；JDK 25 LTS 是推荐的生产基线

## 参考资料

- JEP 444 Virtual Threads（JDK 21 正式）：[https://openjdk.org/jeps/444](https://openjdk.org/jeps/444)
- JEP 491 Synchronize Virtual Threads without Pinning（JDK 24）：[https://openjdk.org/jeps/491](https://openjdk.org/jeps/491)
- JEP 506 Scoped Values（JDK 25 正式）：[https://openjdk.org/jeps/506](https://openjdk.org/jeps/506)
- JEP 505 / 525 Structured Concurrency（JDK 25 第五次预览 / JDK 26 第六次预览）：[https://openjdk.org/jeps/505](https://openjdk.org/jeps/505)、[https://openjdk.org/jeps/525](https://openjdk.org/jeps/525)
- Oracle 官方指南：[Virtual Threads](https://docs.oracle.com/en/java/javase/25/core/virtual-threads.html)

> 下一篇：[效率工具库](./98_dev_tool) —— 并发主线到此结束，最后看看 Lombok、MapStruct、Hutool、Guava 这些日常提效的工具库。

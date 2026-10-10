---
description: 线程与中断、volatile、锁与 AQS、CAS、并发容器、ThreadLocal、线程池、虚拟线程
---

# Java 并发面试题解答

> 题目清单见 [Java 面试题](/java/99_interview)（本页答第四组「并发」，其余三组见 [Java 基础面试题解答](/interview/1_java)）；细节见 [Java 总览](/java/0_overview) 的并发部分，JMM、DCL、虚拟线程原理见 [JVM 面试题解答](/interview/3_jvm) Q42–Q51。
>
> 版本基线：JDK 21 / 25 LTS，与 JDK 8 / 17 不同处单独说明。

## 四、并发

### Q1：Java 线程有哪 6 种状态？BLOCKED 和 WAITING 的区别？`wait()` 为什么必须在 while 循环里调用？

**一句话**：6 种状态是 `NEW`、`RUNNABLE`、`BLOCKED`、`WAITING`、`TIMED_WAITING`、`TERMINATED`。`BLOCKED` 只表示在抢 `synchronized` 的锁；`wait()`、`join()`、`park()` 进入的是 `WAITING`。

- 所以等 `ReentrantLock` 的线程显示 `WAITING`，不是 `BLOCKED`（它底层用的是 `park`）
- 带超时的 `sleep(n)`、`wait(n)` 进入 `TIMED_WAITING`；线程卡在 Socket 读上时，JVM 看到的仍是 `RUNNABLE`
- `wait()` 要放在 while 里：醒来到重新拿到锁之间，条件可能又被别人改了；还可能没人 `notify` 也醒（虚假唤醒），所以醒来要重新检查
- `sleep` 不释放锁；`wait` 释放锁，醒来再重新抢；`wait` / `notify` 必须在持有该对象的锁时调用

**常见坑**：手写 `wait` / `notify` 容易出错，实际项目优先用 `BlockingQueue`、`CountDownLatch` 等现成工具。

→ 详见 [线程基础](/java/23_topic_thread_basics#一、线程的生命周期)

### Q2：如何正确停止一个线程？捕获 InterruptedException 后应该怎么处理？

**一句话**：Java 没有安全的强制停止，只能「打招呼」：调用 `interrupt()` 设置中断标志，线程自己在合适的地方检查标志并退出。`Thread.stop()` 早已废弃，JDK 20 起直接抛异常。

- 线程正在 `sleep`、`wait`、`queue.take()` 这类阻塞中时，会立刻抛 `InterruptedException`，同时把中断标志清掉
- 捕获后只有两种正确做法：能往上抛就声明 `throws`；不能抛（如在 `run()` 里）就恢复标志后退出
- 有些阻塞不响应中断（传统 Socket 读、等 `synchronized`），只能靠超时或关闭资源

```java
catch (InterruptedException e) { Thread.currentThread().interrupt(); }   // 恢复标志，让上层也能看到
```

**常见坑**：空 catch 吞掉中断，会让线程池的 `shutdownNow()`、`Future.cancel(true)` 失效。

→ 详见 [线程基础](/java/23_topic_thread_basics#四、中断-协作式取消)

### Q3：volatile 的作用？为什么不能保证原子性？为什么普通 boolean 标志位的循环可能永远不退出？

**一句话**：volatile 保证可见性（一个线程写了，别的线程马上能读到）和有序性（前后的读写不会被重排到它另一侧），但不保证原子性。

- `count++` 是读、加、写三步，两个线程可能读到同一个旧值、各加 1 写回，少加一次
- 标志位不退出：`while (!stop) {}` 里 `stop` 是普通字段时，JIT 可能只读一次就缓存起来，别的线程改了也看不到；加 `volatile` 后每次都会重新读
- 「volatile 写立即刷主内存、读不走 CPU 缓存」是常见的错误说法；真正的作用是禁止 JIT 缓存这个值，并用内存屏障（阻止重排序的指令）防止乱序
- 适合：状态标志、一写多读的引用、DCL；计数用 `AtomicInteger` / `LongAdder`

| 对比 | volatile | synchronized |
|------|----------|-------------|
| 可见性 / 有序性 | 保证 | 保证 |
| 复合操作原子性 | 不保证 | 保证 |
| 会不会阻塞 | 不会 | 竞争时会 |

→ 详见 [JMM 内存模型](/java/22_topic_jmm#四、volatile-的精确语义)

### Q4：synchronized 的锁升级过程是怎样的？JDK 15 / 18 / 23 之后有什么变化？

**一句话**：「无锁 → 偏向锁 → 轻量级锁 → 重量级锁」是 HotSpot 的内部优化，只适用于 JDK 8～14。新版本里偏向锁已经没有了，回答时要先说清是哪个 JDK。

- 偏向锁：无竞争时把线程 ID 记在对象头里，同一线程再进来不用任何操作；但撤销代价大，JDK 15 默认关闭，JDK 18 删除
- 轻量级锁：有线程交替使用、没有真正争抢时，用一次 CAS 加锁，不挂起线程；JDK 23 起换成了新的实现
- 重量级锁：真正有竞争时膨胀成 monitor，抢不到的线程挂起；自旋发生在这一层内部，不是单独的锁状态
- JIT 还会做锁消除（对象只在本线程用，锁直接去掉）和锁粗化（相邻的多个同步块合成一个）

**常见坑**：照搬 JDK 8 时代的「锁升级四步」回答新版本 JDK 的问题。

→ 详见 [synchronized](/java/24_topic_synchronized#四、hotspot-锁实现的版本演进)

### Q5：synchronized 和 ReentrantLock 的区别？虚拟线程下应该用哪个？

**一句话**：两者都是可重入的互斥锁，内存效果一样。默认用 `synchronized`，需要可中断、超时、公平、多个条件时才用 `ReentrantLock`；性能已经不是选型理由。

| 对比 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 释放 | 自动，异常时也释放 | 必须在 `finally` 里 `unlock()` |
| 可中断 / 超时 | 不支持 | `lockInterruptibly()`、`tryLock(timeout)` |
| 公平锁 | 不支持 | 可选 |
| 条件等待 | 一个（`wait` / `notify`） | 多个 `Condition`，可精确唤醒 |

- 虚拟线程：JDK 21～23 在 `synchronized` 块里做 IO 会「钉住」底层线程（让它没法去跑别的虚拟线程），这时改用 `ReentrantLock`
- JDK 24 起这个问题已修复，两者又回到按功能选
- 锁里只做内存操作、不阻塞的短代码块，任何版本都不用改

→ 详见 [显式锁（Lock）](/java/25_topic_lock#七、synchronized-与-reentrantlock-对比)

### Q6：AQS 的原理？等待线程是自旋还是挂起？ReentrantLock 的可重入与公平锁如何实现？

**一句话**：AQS 就是「一个 `state` 计数 + 一个排队的等待队列」。子类只规定 `state` 怎样算拿到、怎样算释放，排队、挂起、唤醒都由 AQS 做。

- 拿不到锁的线程进队列后挂起（`park`），不是一直自旋；只有排在队首的会在挂起前再试一两次
- `state` 的含义由子类定：`ReentrantLock` 是重入次数，`Semaphore` 是剩余许可，`CountDownLatch` 是剩余计数
- 可重入：持有者是当前线程时直接 `state + 1`，释放时减到 0 才真正放锁，所以 `lock` 几次就要 `unlock` 几次
- 非公平（默认）：来了先直接抢一次，抢不到再排队，吞吐更高；公平锁会先看队列里有没有更早的人
- `Condition.await` 会释放锁进条件队列，`signal` 只是把它挪回等待队列，重新拿到锁后才返回

**常见坑**：公平锁下无参 `tryLock()` 照样插队，要公平就用 `tryLock(0, TimeUnit.SECONDS)`。

→ 详见 [显式锁（Lock）](/java/25_topic_lock#二、aqs-原理)

### Q7：读写锁能否升级 / 降级？StampedLock 的乐观读有哪些限制？

**一句话**：`ReentrantReadWriteLock` 能降级（拿着写锁再拿读锁，然后放写锁），不能升级：拿着读锁去要写锁，自己就把自己卡死了，因为写锁要等所有读锁释放。

- 需要「读完可能要写」：先放读锁，再拿写锁，并在写锁里重新检查条件
- 读写锁适合读多写少、读操作比较长的场景；读很短时维护读计数的开销可能抵消收益
- `StampedLock` 的乐观读：不加锁，只拿一个版本号，读完用 `validate` 检查期间有没有人写过，有就退回加读锁
- 乐观读的限制：读到的可能是写了一半的数据，要先拷到局部变量、验证通过后再用；`StampedLock` 不可重入，也不支持 `Condition`

**常见坑**：持有 `StampedLock` 写锁时再调 `writeLock()` / `readLock()`，会自己锁死自己。

→ 详见 [显式锁（Lock）](/java/25_topic_lock#五、reentrantreadwritelock)

### Q8：CAS 是什么？有哪些缺点？ABA 问题如何解决？LongAdder 为什么比 AtomicLong 快？

**一句话**：CAS（比较并交换）是 CPU 提供的原子指令：内存里的值等于我预期的旧值，才写入新值，否则失败重试。原子类、AQS 都建立在它上面。

- 缺点一：竞争激烈时大量失败重试，白白耗 CPU
- 缺点二：只能保证一个变量；多个字段要包成一个不可变对象，用 `AtomicReference` 整体替换
- ABA：值从 A 变 B 又变回 A，CAS 以为没变过；数值通常无所谓，链表节点这类引用会出错，用带版本号的 `AtomicStampedReference`
- `LongAdder` 快的原因：不让所有线程挤在一个变量上，竞争时各线程加到不同的格子里，`sum()` 时再汇总

**常见坑**：`LongAdder.sum()` 在并发更新时只是近似值，不能用来生成 ID 或做精确判断，这时仍用 `AtomicLong`。

→ 详见 [原子类（Atomic）](/java/26_topic_atomic#一、cas-原子操作的硬件基础)

### Q9：ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？为什么不允许 null？`size()` 精确吗？先 get 再 put 安全吗？

**一句话**：JDK 7 把 Map 分成固定几段，每段一把锁；JDK 8 起结构和 HashMap 一样，空位置用 CAS 放，非空位置只锁这一个位置的头节点，锁更细。

| 对比 | JDK 7 | JDK 8+ |
|------|-------|--------|
| 锁 | 分段锁，段数构造后固定 | 空桶 CAS，非空桶 `synchronized` 锁桶头 |
| 扩容 | 各段自己扩 | 多个线程一起帮忙迁移 |
| `get` | 不加锁 | 不加锁 |

- 不允许 null：`get` 返回 null 时分不清是「没有」还是「值就是 null」，并发下又不能先 `containsKey` 再 `get`（中间可能被改）
- `size()` 是估计值，并发修改时不精确
- 先 get 再 put 不安全：单个方法线程安全，组合起来就不是；用 `putIfAbsent`、`computeIfAbsent`、`merge`

```java
counts.merge(word, 1L, Long::sum);   // 正确的并发计数
```

**常见坑**：`computeIfAbsent` 的函数执行时持有桶锁，要写得短小，不能在里面再改同一个 Map。

→ 详见 [集合框架](/java/21_topic_collection#八、concurrenthashmap)

### Q10：`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别？CyclicBarrier 基于 AQS 吗？Semaphore 能用来限流吗？

**一句话**：`CountDownLatch` 是「等别人干完」，一次性的；`CyclicBarrier` 是「大家互相等到齐再一起走」，可重复用；`Semaphore` 是许可证，限制同时干活的数量。

| 对比 | CountDownLatch | CyclicBarrier | Semaphore |
|------|---------------|---------------|-----------|
| 谁在等 | 调 `await` 的线程 | 每个到达的线程 | 拿不到许可的线程 |
| 能否复用 | 不能 | 能，自动进入下一轮 | 许可可反复借还 |
| 实现 | AQS | `ReentrantLock` + `Condition`，不直接用 AQS | AQS |

- `Semaphore` 限的是同时进行的数量，不是每秒请求数（QPS）；按速率限流用令牌桶（Guava `RateLimiter`、Sentinel），集群限流要用 Redis 等集中方案
- `countDown()` 放 `finally`，`await` 带超时，否则一个子任务出错主线程就永远等下去

**常见坑**：`Semaphore` 不记录谁拿了许可，多 `release()` 会让许可越来越多；`release` 只放在 `finally` 里且与 `acquire` 成对。

→ 详见 [同步工具类](/java/27_topic_juc_tools#八、对比与选型)

### Q11：ThreadLocal 的原理？为什么会内存泄漏？InheritableThreadLocal 在线程池中为什么失效，跨线程传递上下文怎么做？

**一句话**：值不存在 `ThreadLocal` 里，而是存在每个线程自己的一张 Map 里，`ThreadLocal` 只是 key。所以每个线程各拿各的，互不干扰。

- 内存泄漏：Map 的 key 是弱引用（没人用时能被 GC），但 value 是强引用；线程池的线程一直活着，value 就一直释放不了
- 更常见的事故是数据串用：上一个请求设置的用户信息没清，复用同一线程的下一个请求读到了别人的身份
- `InheritableThreadLocal` 只在创建子线程时复制一次，线程池的线程早就建好了，拿到的是旧值
- 线程池里传上下文：包装执行器或 Spring 的 `TaskDecorator`（提交时拷贝、执行完恢复），或阿里 TTL；JDK 25 的 `ScopedValue` 只传给结构化并发的子任务

**常见坑**：用完不 `remove()`；正确做法是声明为 `static final`，每次在 `finally` 里 `remove()`。

→ 详见 [线程基础](/java/23_topic_thread_basics#七、threadlocal)、[CompletableFuture](/java/29_topic_completable_future#七、上下文传递)

### Q12：线程池的核心参数与任务提交流程？线程如何复用、非核心线程如何回收？

**一句话**：提交顺序是「核心线程 → 队列 → 非核心线程 → 拒绝」，不是先把线程开到最大再排队。

- 7 个参数：核心线程数、最大线程数、空闲存活时间（及单位）、任务队列、线程工厂、拒绝策略
- 最大线程数只有队列满了才起作用，所以配无界队列时它形同虚设
- 复用：每个工作线程是一个循环，干完一个任务就去队列里取下一个
- 回收：线程从队列取任务等了 `keepAliveTime` 还没取到，且当前线程数超过核心数，就退出；核心线程和非核心线程本身没有区别，只是「谁超时谁走」
- 线程数怎么估算见 [并发参数调优](/high-con/7_concurrency_tuning)

**常见坑**：线程工厂不起名字，出问题时 jstack 里全是 `pool-1-thread-3`，没法定位是哪个业务。

→ 详见 [线程池](/java/28_topic_thread_pool#一、threadpoolexecutor-底层原理)

### Q13：线程池的队列和拒绝策略怎么选？为什么不推荐用 Executors 创建？运行时动态调整参数要注意什么？

**一句话**：生产环境用有界队列 + 明确的拒绝策略，自己 `new ThreadPoolExecutor`。`Executors` 的方法不是队列无界（任务堆到 OOM），就是线程数无上限。

| 拒绝策略 | 适用 |
|---------|------|
| `AbortPolicy`（默认） | 抛异常，调用方自己处理 |
| `CallerRunsPolicy` | 任务不能丢，让提交方自己执行，顺便放慢提交速度 |
| `DiscardPolicy` / `DiscardOldestPolicy` | 任务确实可以丢，至少记日志 |

- `newFixedThreadPool` / `newSingleThreadExecutor` 队列无界；`newCachedThreadPool` 最大线程数是 `Integer.MAX_VALUE`
- 想先扩线程再排队（IO 型任务常见）：自定义队列，线程没到上限时让入队失败，Tomcat 就是这样做的
- 动态调参：扩容先调最大线程数再调核心数，缩容反过来（核心数不能大于最大数）；队列容量不能直接改
- 重点监控队列积压，它是最关键的告警指标

→ 详见 [线程池](/java/28_topic_thread_pool#_7、blockingqueue-的选择)

### Q14：`execute` 与 `submit` 的区别？submit 的异常去哪了？`shutdown` 与 `shutdownNow` 有什么区别？

**一句话**：`execute` 没有返回值，任务异常会打印出来；`submit` 返回 `Future`，异常被存在 `Future` 里，不调 `get()` 就悄无声息。

- `submit` 的异常：调 `Future.get()` 时抛 `ExecutionException`，用 `getCause()` 拿原始异常；最稳的做法是任务内部自己 try-catch
- `shutdown()`：不再收新任务，已提交的（包括队列里的）继续跑完
- `shutdownNow()`：不再收新任务，清空队列并返回没跑的任务，再给所有工作线程发中断
- 优雅关闭：`shutdown()` → `awaitTermination` 等一会 → 超时再 `shutdownNow()`

**常见坑**：`scheduleAtFixedRate` 的任务抛一次异常，后面的调度就全部停止且没有日志，任务体必须 try-catch。

→ 详见 [线程池](/java/28_topic_thread_pool#二、任务提交与异常处理)

### Q15：CompletableFuture 的回调由哪个线程执行？不传线程池用的是什么？异常与超时怎么处理？

**一句话**：不带 `Async` 的回调（如 `thenApply`）由完成上一步的线程执行，如果上一步已经完成，就由注册回调的线程当场执行；带 `Async` 又不传线程池时用全局共享的 `ForkJoinPool.commonPool()`。

- 生产代码的 `xxxAsync` 一律传自己的线程池，否则会和并行流等抢同一个公共池
- 异常沿链往下传，会被包成 `CompletionException`，处理时先 `getCause()`
- `exceptionally` 只在失败时执行；`handle` 成功失败都执行，可改结果；`whenComplete` 只看不改
- 超时：`orTimeout` / `completeOnTimeout` 只是让 Future 提前结束，底层任务并没有停；真正止损要靠 HTTP、JDBC 客户端自己的超时

**常见坑**：以为 `cancel(true)` 能中断正在执行的任务，实际不会。

→ 详见 [CompletableFuture](/java/29_topic_completable_future#二、回调由哪个线程执行)

### Q16：虚拟线程适合什么场景？为什么不能池化？JDK 24 之后还有哪些情况会钉住载体线程？

**一句话**：虚拟线程适合大量阻塞 IO 的任务（一个请求一个线程的 Web 服务、调多个下游），提升的是同时能处理的任务数，不是单个任务的速度；CPU 密集型任务没有收益。

- 不池化：虚拟线程创建很便宜，每个任务新建一个、用完就扔；池化反而把并发卡在池大小上
- 限制对下游的并发数，改用 `Semaphore` 或连接池大小控制
- 钉住（pinning）：虚拟线程阻塞时没法让出底层的平台线程（载体线程），连带它一起卡住
- JDK 24 起 `synchronized` 和 `wait()` 不再钉住；剩下的情况是本地代码（JNI / FFM）回调 Java 后在其中阻塞、类初始化时阻塞
- 诊断：JFR 事件 `jdk.VirtualThreadPinned`；线程转储用 `jcmd <pid> Thread.dump_to_file`（`jstack` 看不到虚拟线程）

**常见坑**：用 `ThreadLocal` 缓存大对象，百万个虚拟线程就是百万份。

→ 详见 [虚拟线程](/java/30_topic_virtual_thread#四、使用原则)

### Q17：ScopedValue 和 ThreadLocal 有什么区别？结构化并发能用于生产吗？

**一句话**：`ScopedValue`（JDK 25 正式）在一段代码范围内绑定一个只读的值，范围结束自动解绑，适合当前用户、租户、traceId 这类请求级上下文。结构化并发到 JDK 25 仍是预览，不要用在生产。

| 对比 | ThreadLocal | ScopedValue |
|------|-------------|-------------|
| 能否修改 | 随时 `set` | 绑定后只读 |
| 清理 | 要手动 `remove()` | 范围结束自动解绑 |
| 子线程继承 | `InheritableThreadLocal` 复制 | 只传给结构化并发的子任务 |

```java
ScopedValue.where(CURRENT_USER, user).run(() -> service.process(request));   // 内层任意处 CURRENT_USER.get()
```

- `ScopedValue` 不会自动传进普通线程池或 `CompletableFuture` 回调，那里仍要包装执行器
- 结构化并发的价值：把一组并发子任务当一个整体，一个失败其余自动取消；定稿前先用 `CompletableFuture` 或虚拟线程执行器代替

→ 详见 [虚拟线程](/java/30_topic_virtual_thread#七、scopedvalue-jdk-25-正式)

### Q18：死锁的四个必要条件？如何预防、如何用 jstack 排查？活锁、饥饿与线程池饥饿死锁有什么区别？

**一句话**：死锁的四个条件是互斥、持有并等待、不可抢占、循环等待，破坏任意一个即可；最常用的是让所有线程按固定顺序加锁（比如按账户 ID 从小到大）。

- 其他预防办法：一次性拿全所有资源；用 `tryLock(timeout)`，拿不到就把已有的锁放掉再重试
- 排查：`jstack -l <pid>`，搜 `Found one Java-level deadlock`，JVM 会列出谁在等哪把锁、锁在谁手里
- 症状：接口没响应，线程大量 `BLOCKED` / `WAITING`，但 CPU 不高；死锁不会自己恢复，先留线程转储再重启止血

| 对比 | 现象 | 解决 |
|------|------|------|
| 死锁 | 互相等，全部卡住，CPU 低 | 固定加锁顺序、超时 |
| 活锁 | 线程一直在跑、反复谦让，谁也完成不了 | 随机等一会再重试 |
| 饥饿 | 部分线程长期拿不到锁或 CPU | 公平锁、缩短持锁时间 |
| 线程池饥饿死锁 | 父任务占满线程等子任务，子任务排不上 | 父子任务用不同线程池 |

→ 详见 [故障排查](/jvm/9_troubleshooting#十一、死锁)、[线程池](/java/28_topic_thread_pool#九、常见坑)

---

高并发系统层面的设计见 [高并发面试题解答](/interview/13_high_con)。

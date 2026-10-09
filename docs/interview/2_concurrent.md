---
description: 线程与中断、volatile、锁与 AQS、CAS、并发容器、ThreadLocal、线程池、虚拟线程
---

# Java 并发面试题解答

> 精华提炼，细节详见 [Java 总览](/java/0_overview) 的并发部分；题目清单见 [Java 面试题](/java/99_interview)，本页按清单第四组「并发」的顺序作答，其余三组见 [Java 面试题解答](/interview/1_java)。
> 版本基线：JDK 21 / 25 LTS，JDK 8 / 17 的差异单独标注。JMM 规则、DCL、虚拟线程挂载原理另见 [JVM 面试题解答](/interview/3_jvm) Q42–Q51，本页不重复展开。

## 四、并发

### Q1：Java 线程有哪 6 种状态？BLOCKED 和 WAITING 的区别？`wait()` 为什么必须在 while 循环里调用？

**核心结论**：`Thread.State` 有 `NEW`、`RUNNABLE`、`BLOCKED`、`WAITING`、`TIMED_WAITING`、`TERMINATED` 六种。**`BLOCKED` 只表示在等 `synchronized` 的 monitor**；`wait()`、`join()`、`LockSupport.park()` 进入 `WAITING`，所以等待 `ReentrantLock` 的线程是 `WAITING` 而不是 `BLOCKED`。

| 状态 | 进入方式 |
|------|---------|
| `RUNNABLE` | 正在运行或等 CPU；平台线程阻塞在 Socket / 文件 IO 上时，JVM 看到的也是 `RUNNABLE` |
| `BLOCKED` | 抢 monitor 失败；从 `wait()` 醒来重新抢 monitor 时也会短暂处于此状态 |
| `WAITING` | `Object.wait()`、`Thread.join()`、`LockSupport.park()`（`Lock`、`Condition` 都基于它） |
| `TIMED_WAITING` | `sleep(n)`、`wait(n)`、`join(n)`、`parkNanos` |

**`wait()` 必须放在 while 里**：线程被唤醒到重新拿到锁之间，条件可能已被其他线程改掉；还存在没有 `notify` 也返回的**虚假唤醒**。所以醒来后必须重新检查条件。`wait` / `notify` 必须在持有同一对象 monitor 时调用，否则抛 `IllegalMonitorStateException`。

| 对比 | `sleep` | `wait` |
|------|---------|--------|
| 所属 | `Thread` 静态方法 | `Object` 实例方法 |
| 是否释放锁 | **不释放** | 释放 monitor，醒来后重新竞争 |
| 唤醒方式 | 时间到或被中断 | `notify` / `notifyAll`、超时或中断 |

- 不确定该唤醒谁时用 `notifyAll`；实际项目优先用 `BlockingQueue`、`CountDownLatch` 等 JUC 工具，而不是手写 `wait` / `notify`

→ 详见 [线程基础](/java/23_topic_thread_basics#一、线程的生命周期)

### Q2：如何正确停止一个线程？捕获 InterruptedException 后应该怎么处理？

**核心结论**：Java 没有安全的强制停止，只能**协作式中断**：调用方 `thread.interrupt()` 设置中断标志，被中断的线程在合适的位置检查 `Thread.currentThread().isInterrupted()` 并自行退出；处于 `sleep`、`wait`、`join`、`BlockingQueue.take` 等可中断阻塞中的线程会立即抛 `InterruptedException`，同时**清除中断标志**。`Thread.stop()` 会在任意位置释放锁、留下不一致状态，早已废弃，JDK 20 起调用直接抛 `UnsupportedOperationException`。

捕获 `InterruptedException` 后只有两种正确做法：

```java
// 1. 能声明就向上抛，让调用方决定
void work() throws InterruptedException {
    task = queue.take();
}

// 2. 不能抛时（如 Runnable.run），恢复中断标志再退出
public void run() {
    try {
        while (!Thread.currentThread().isInterrupted()) {
            process(queue.take());
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();   // 恢复标志，让上层代码也能看到
    }
}
```

- **不能吞掉**：空 catch 会让线程池的 `shutdownNow()`、`Future.cancel(true)` 失效
- 不响应中断的阻塞（传统 `Socket` 读、`synchronized` 等锁）中断不了，要靠超时或关闭资源
- 任务内部用 `volatile boolean` 标志也可以，但无法唤醒正在阻塞的线程

→ 详见 [线程基础](/java/23_topic_thread_basics#四、中断-协作式取消)

### Q3：volatile 的作用？为什么不能保证原子性？为什么普通 boolean 标志位的循环可能永远不退出？

**核心结论**：volatile 保证**可见性和有序性**：对 volatile 变量的写 happens-before 之后对它的读，写之前的普通写也随之对读线程可见；JIT 和 CPU 不能把前后的读写越过它重排。它**不保证复合操作的原子性**：`count++` 是读、加、写三步，两个线程可以读到同一个旧值，各自加一后写回，丢失一次更新。

- 「volatile 写立即刷新主内存、读不读 CPU 缓存」是常见的错误说法：现代 CPU 缓存由一致性协议（MESI 一类）保持一致，volatile 读完全可以命中 L1。真正的作用是**禁止 JIT 把值缓存在寄存器里**，以及用内存屏障阻止 Store Buffer 和乱序执行造成的重排
- x86 上 volatile 读没有额外指令，volatile 写之后需要一个 StoreLoad 屏障（`lock addl` 或 `xchg`），所以写比读贵

**标志位不退出**：`while (!stop) {}` 中 `stop` 是普通字段时，C2 编译后可能把读取提升到循环外，只读一次；另一个线程改了 `stop` 也看不到。原因不是「写没刷回主内存」，而是两个线程之间没有 happens-before，JMM 允许这种优化。加 `volatile` 后 JIT 必须每次重新读取。

| 对比 | volatile | synchronized |
|------|----------|-------------|
| 可见性 / 有序性 | 保证 | 保证（acquire / release） |
| 复合操作原子性 | 不保证 | 保证 |
| 阻塞 | 不阻塞 | 竞争时阻塞 |
| 适用 | 状态标志、一写多读的引用（整体替换不可变对象）、DCL | 读改写、多个变量的不变式 |

计数用 `AtomicInteger` / `LongAdder`。happens-before 规则、DCL 的细节见 [JVM 面试题解答](/interview/3_jvm) Q42–Q45。

→ 详见 [JMM 内存模型](/java/22_topic_jmm#四、volatile-的精确语义)

### Q4：synchronized 的锁升级过程是怎样的？JDK 15 / 18 / 23 之后有什么变化？

**核心结论**：锁状态与升级是 **HotSpot 的实现优化**，不是语言规范，回答时先说 JDK 版本。经典的「无锁 → 偏向锁 → 轻量级锁 → 重量级锁」**只适用于 JDK 8 ～ 14**；JDK 17 起默认路径里没有偏向锁，JDK 23 起默认也不再用栈上 Lock Record 的经典轻量级锁。

| 版本 | 变化 |
|------|------|
| JDK 6 ～ 14 | 偏向锁默认开启：无竞争时把线程 ID 记在 Mark Word；有竞争撤销偏向（需要安全点）→ 栈锁（CAS 把 Mark Word 换成 Lock Record 指针）→ 竞争即膨胀为 ObjectMonitor |
| JDK 15 | JEP 374：偏向锁**默认关闭并废弃**，主要原因是撤销需要安全点，收益不抵维护成本 |
| JDK 18 | 偏向锁代码从 HotSpot **移除**，`-XX:+UseBiasedLocking` 无效 |
| JDK 21 / 23 | 引入新的轻量级锁（线程私有的 lock-stack 代替栈上 Lock Record），JDK 23 成为默认 |
| JDK 24 | JEP 491：虚拟线程在 `synchronized` 中阻塞不再钉住载体线程 |
| JDK 25 / 26 | 紧凑对象头转正（JEP 519）；JDK 26 起旧栈锁实现被移除，只剩新轻量级锁 |

- **自旋不是一种锁状态**：经典栈锁遇到竞争直接膨胀，自适应自旋发生在 ObjectMonitor 内部
- 调用对象的 identity `hashCode()` 或 `wait()` 会迫使锁膨胀
- JIT 还会做**锁消除**（逃逸分析证明对象不逃逸）和**锁粗化**（合并相邻的同步块）
- 字节码层面：同步块编译为 `monitorenter` + 两条 `monitorexit`（含异常路径），同步方法靠 `ACC_SYNCHRONIZED` 标志

→ 详见 [synchronized](/java/24_topic_synchronized#四、hotspot-锁实现的版本演进)

### Q5：synchronized 和 ReentrantLock 的区别？虚拟线程下应该用哪个？

**核心结论**：两者都是可重入的互斥锁，内存语义相同。`synchronized` 是 JVM 内置、自动释放；`ReentrantLock` 是基于 AQS 的 Java 实现，多了**可中断、超时、公平、多条件、运行时自省**。默认用 `synchronized`，需要这些能力时用 `ReentrantLock`。性能在无竞争和低竞争下相当，不再是选型依据。

| 对比 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 实现 | `monitorenter` / `monitorexit`、`ACC_SYNCHRONIZED` | AQS + `LockSupport.park` |
| 释放 | 自动，异常时也释放 | 必须在 `finally` 中 `unlock()` |
| 可中断 / 超时 | 不支持 | `lockInterruptibly()`、`tryLock(timeout)` |
| 公平性 | 非公平 | 默认非公平，可选公平 |
| 条件变量 | 一个等待集（`wait` / `notify`） | 多个 `Condition`，可精确唤醒 |
| 诊断 | `jstack` 显示 `waiting to lock` | `jstack -l` 显示 ownable synchronizers，`getQueueLength()` 等方法 |
| 虚拟线程 | JDK 21–23 在同步块内阻塞会**钉住**载体线程；JDK 24+ 不再钉住 | 一直不会钉住 |

**虚拟线程下的选择**：在 JDK 21–23 上，如果 `synchronized` 块里有 IO 等阻塞操作，用 `ReentrantLock` 替换可以避免钉住；**JDK 24（JEP 491）之后这条理由不再成立**，两者的选择回到功能需求本身。只在锁内做内存操作的短同步块不阻塞，任何版本都不需要改。

→ 详见 [显式锁（Lock）](/java/25_topic_lock#七、synchronized-与-reentrantlock-对比)

### Q6：AQS 的原理？等待线程是自旋还是挂起？ReentrantLock 的可重入与公平锁如何实现？

**核心结论**：AQS = 一个 `volatile int state` + 一个 **CLH 变体的双向同步队列**。子类只定义「state 怎样算获取成功、怎样算释放」（`tryAcquire` / `tryRelease`，共享模式为 `tryAcquireShared` / `tryReleaseShared`），排队、阻塞、唤醒、中断与超时都由 AQS 完成。获取失败的线程入队后 **park 挂起**，只有队首在 park 前短暂自旋，不像原始 CLH 锁那样在前驱上一直自旋。

| 同步器 | state 含义 |
|--------|-----------|
| `ReentrantLock` | 0 空闲，> 0 为持有者的重入次数 |
| `ReentrantReadWriteLock` | 高 16 位读锁总数，低 16 位写锁重入次数 |
| `Semaphore` | 剩余许可数 |
| `CountDownLatch` | 剩余计数 |

独占获取流程：`tryAcquire` 成功直接返回（无竞争时不建节点）→ 失败则 CAS 追加到队尾 → 是队首就再试一次 → 仍失败则标记 `WAITING` 并 `park` → 前驱释放时被 `unpark`，回到循环重试。

- **可重入**：`state` 为 0 时 CAS 成 1 并记录 `exclusiveOwnerThread`；持有者就是当前线程时直接 `state + 1`；释放时减到 0 才真正释放，所以 `lock` 几次就要 `unlock` 几次
- **非公平锁（默认）**：`lock()` 先直接 CAS 抢一次，失败再排队，刚释放的锁可能被正在运行的线程拿走，省一次唤醒，吞吐更高
- **公平锁**：state 为 0 时还要 `hasQueuedPredecessors()` 确认没有更早的等待者；但无参 `tryLock()` 照样插队，需要公平时用 `tryLock(0, TimeUnit.SECONDS)`
- **JDK 14 起** AQS 重写：节点分为 `ExclusiveNode` / `SharedNode` / `ConditionNode`，状态只剩 `WAITING` / `CANCELLED` / `COND`；老资料里的 `SIGNAL`、`PROPAGATE` 是 JDK 8 的实现
- `Condition.await` 释放锁进入条件队列，`signal` 只是把节点**转移到同步队列**，重新拿到锁后 `await` 才返回

→ 详见 [显式锁（Lock）](/java/25_topic_lock#二、aqs-原理)

### Q7：读写锁能否升级 / 降级？StampedLock 的乐观读有哪些限制？

**核心结论**：`ReentrantReadWriteLock` 支持**降级**（持有写锁 → 获取读锁 → 释放写锁），**不支持升级**：持有读锁再申请写锁，**单个线程就会永久阻塞**，因为写锁要求没有任何读锁持有者，而那个读锁就是它自己持有的。需要「读后可能写」时，先释放读锁再申请写锁，并在写锁内重新检查条件。

- 读写锁适合读多写少且读临界区较长的场景；读很短时维护读计数的开销可能抵消收益
- 非公平模式下有写饥饿风险；读锁不支持 `Condition`

**StampedLock**（JDK 8，不基于 AQS）提供写锁、悲观读锁和**乐观读**：`tryOptimisticRead()` 不加锁只拿版本号，读完用 `validate(stamp)` 检查期间是否有写，失败再退回悲观读锁。

| 限制 | 说明 |
|------|------|
| 读到的可能是中间状态 | 先把字段拷到局部变量，`validate` 通过后才能使用，不能拿来做数组下标等可能抛异常的操作 |
| 不可重入 | 持有写锁时再调用 `writeLock()` / `readLock()` 会自锁 |
| 不支持 `Condition` | 需要条件等待用 `ReentrantLock` |
| 普通 `readLock()` / `writeLock()` 不响应中断 | 用 `readLockInterruptibly()` 等变体 |
| 升级 | 可用 `tryConvertToWriteLock(stamp)` 尝试原地升级，失败要释放后重新申请 |

→ 详见 [显式锁（Lock）](/java/25_topic_lock#五、reentrantreadwritelock)

### Q8：CAS 是什么？有哪些缺点？ABA 问题如何解决？LongAdder 为什么比 AtomicLong 快？

**核心结论**：CAS（Compare-And-Swap）是硬件提供的原子指令：只有内存值等于期望值时才写入新值，否则失败重试。x86 上是 `lock cmpxchg`，ARM 上是 LL/SC 或 ARMv8.1 的 LSE 指令。原子类、AQS、`ConcurrentHashMap` 的空桶插入都建立在它之上；原子类的读写有 volatile 语义。

| 缺点 | 解决 |
|------|------|
| 竞争激烈时大量失败重试，空耗 CPU | 分散热点（`LongAdder`），或改用锁 |
| 只能保证**一个**变量的原子性 | 多个字段封装成不可变对象，用 `AtomicReference` 整体替换 |
| ABA 问题 | 带版本号 |

**ABA**：值从 A 变成 B 又变回 A，CAS 认为没有变化。对单纯的数值通常无害，对「无锁栈的栈顶节点」这类引用会出错。用 `AtomicStampedReference` 同时比较引用和版本号（只关心是否被改过用 `AtomicMarkableReference`）。注意它**按 `==` 比较引用**，期望值必须是 `get()` 拿到的那个对象；用超过缓存范围的 `Integer`（如 1000）做值时，自动装箱出的是新对象，CAS 会静默失败。

**LongAdder**：`AtomicLong` 在高并发下所有线程 CAS 同一个变量，失败重试和缓存行争抢严重。`LongAdder` = `base` + `Cell[]`：无竞争时 CAS `base`，竞争时各线程按探针值分散到不同的 `Cell`（`@Contended` 填充避免伪共享），`sum()` 时再汇总。

- `sum()` **不是原子快照**，并发更新时只是近似值，不能用来生成 ID 或做精确判断
- 无竞争时与 `AtomicLong` 开销相当；需要 `compareAndSet`、`incrementAndGet` 返回精确值时仍用 `AtomicLong`
- JDK 9+ 应用代码做字段级 CAS 用 `VarHandle`，`sun.misc.Unsafe` 的内存访问方法 JDK 23 起废弃、24 起使用时告警

→ 详见 [原子类（Atomic）](/java/26_topic_atomic#一、cas-原子操作的硬件基础)

### Q9：ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？为什么不允许 null？`size()` 精确吗？先 get 再 put 安全吗？

**核心结论**：JDK 7 是 **Segment 分段锁**（每个 Segment 是一把 `ReentrantLock`，并发度构造时确定、之后固定）；JDK 8 起改为与 HashMap 相同的 `Node[]` + 链表 / 红黑树，**空桶用 CAS 插入，非空桶用 `synchronized` 锁桶首节点**，锁粒度细到单个桶。

| 维度 | JDK 7 | JDK 8+ |
|------|-------|--------|
| 结构 | `Segment[]` → `HashEntry[]` + 链表 | `Node[]` + 链表 / 红黑树 |
| 锁 | Segment 继承 `ReentrantLock` | 空桶 CAS，非空桶 `synchronized` 桶首 |
| 并发度 | `concurrencyLevel` 决定（默认 16，可配置，构造后固定） | 等于桶数，随扩容增长 |
| 扩容 | 各 Segment 独立扩容 | 多线程协作迁移，逐桶加锁 |
| `size()` | 先不加锁累加几次，不稳定再锁全部 Segment | `baseCount` + `CounterCell[]`，不加锁 |

- **扩容**不是无锁的：发起线程创建 2 倍大小的新表，迁移任务按步长分段，线程 CAS `transferIndex` 认领一段；每个桶迁移时锁住桶首、按 `hash & n` 拆成两半，完成后在旧表放 `ForwardingNode`。其他线程 put 遇到它会 `helpTransfer` 一起迁移，get 遇到它则转到新表查找
- `get` 不加锁：`Node.val`、`Node.next` 是 volatile，数组元素用 acquire 语义读取
- **不允许 null** 是为了消除并发下的二义性：`get` 返回 null 时无法区分「不存在」和「值为 null」，而并发 Map 中 `containsKey` 与 `get` 两次调用之间可能已被修改
- **`size()` 是估计值**：计数思路与 `LongAdder` 相同，并发修改时不精确；可能超过 `int` 时用 `mappingCount()`
- **先 get 再 put 不安全**：单个方法线程安全，组合起来不是。用 `putIfAbsent`、`computeIfAbsent`、`merge`、`compute` 等原子复合方法；这些方法的函数在**持有桶锁**时执行，必须短小，不能在里面修改同一个 Map（JDK 9 起检测到会抛 `IllegalStateException: Recursive update`）

```java
counts.merge(word, 1L, Long::sum);                                 // 正确的并发计数
cache.computeIfAbsent(key, k -> new LongAdder()).increment();      // 高并发计数
```

→ 详见 [集合框架](/java/21_topic_collection#八、concurrenthashmap)

### Q10：`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别？CyclicBarrier 基于 AQS 吗？Semaphore 能用来限流吗？

**核心结论**：`CountDownLatch` 是「一个（或多个）线程等其他线程完成」，一次性；`CyclicBarrier` 是「一组线程互相等待到齐」，自动进入下一代、可重复使用；`Semaphore` 是许可证，**限制同时执行的数量**。只有 `CountDownLatch` 和 `Semaphore` 直接基于 AQS 共享模式，**`CyclicBarrier` 基于 `ReentrantLock` + `Condition`**。

| 对比 | CountDownLatch | CyclicBarrier | Semaphore |
|------|---------------|---------------|-----------|
| 实现 | AQS 共享模式，state = 剩余计数 | `ReentrantLock` + `Condition` + 代（Generation） | AQS 共享模式，state = 剩余许可 |
| 谁阻塞 | 只有 `await` 方阻塞，`countDown` 方不阻塞 | 每个到达的线程都阻塞，直到最后一个到达 | 拿不到许可的线程阻塞 |
| 复用 | 不可重置 | 计数归零后自动进入下一代 | 许可可反复获取释放 |
| 典型场景 | 等多个初始化任务完成、发令枪 | 多轮分阶段并行计算 | 限制对下游的并发数 |

- `countDown()` 放在 `finally` 里，`await` 带超时，否则一个子任务异常就让主线程永远等下去
- `CyclicBarrier` 的 `barrierAction` 由最后到达的线程执行；任一等待线程被中断、超时，或 `barrierAction` 抛异常，其余线程都会收到 `BrokenBarrierException`
- **Semaphore 限的是并发数，不是 QPS**：任务快时同样 10 个许可可以跑出很高的 QPS；按速率限流用令牌桶（Guava `RateLimiter`、Sentinel），且它只在单个 JVM 内有效，集群限流要用 Redis 等集中式方案
- **许可没有持有者**：任何线程都能 `release()`，多释放会让许可数超过初始值；`acquire` 放在 `try` 之外，`release` 放在 `finally`
- 扇出 / 扇入场景现在更常用 `CompletableFuture.allOf`、`invokeAll`，或虚拟线程执行器 + try-with-resources

→ 详见 [同步工具类](/java/27_topic_juc_tools#八、对比与选型)

### Q11：ThreadLocal 的原理？为什么会内存泄漏？InheritableThreadLocal 在线程池中为什么失效，跨线程传递上下文怎么做？

**核心结论**：值不是存在 `ThreadLocal` 里，而是存在**每个线程自己的 `ThreadLocalMap`** 中，`ThreadLocal` 实例只是 key。`ThreadLocalMap` 用开放地址法（线性探测），Entry 的 **key 是弱引用、value 是强引用**。

**内存泄漏与串数据**：

- key 用弱引用，是为了 `ThreadLocal` 实例不再使用时能被回收；但 value 沿 `Thread → ThreadLocalMap → Entry → value` 仍是强引用。线程池的线程长期存活，value 就一直不释放，过期 Entry 只会在后续 `get` / `set` / `remove` 时顺带清理
- 更常见的事故是**数据串用**：上一个任务 `set` 的用户信息没清除，复用同一线程的下一个任务读到了别人的身份
- 解决：`ThreadLocal` 声明为 `static final`，每次使用都在 `finally` 中 `remove()`

**跨线程传递**：

| 方案 | 机制 | 线程池中 |
|------|------|---------|
| `InheritableThreadLocal` | **创建子线程时**复制父线程的值 | 失效：线程池的线程早已创建并复用，拿到的是创建线程时那个请求的值 |
| TransmittableThreadLocal（阿里 TTL） | 提交任务时捕获、执行前回放、执行后恢复 | 可用，需包装线程池 |
| 包装执行器 / `TaskDecorator` | 提交时拷贝 MDC 等上下文，执行后**恢复原上下文**（不要 `MDC.clear()`，`CallerRunsPolicy` 下会清掉调用方自己的上下文） | 可用，Spring 推荐方式 |
| `ScopedValue`（JDK 25 正式） | 不可变绑定，只被 `StructuredTaskScope` 的子任务继承 | 不传入普通线程池 |

- 虚拟线程上 `ThreadLocal` 照常工作，但用它缓存昂贵对象会变成「每任务一份」，见 Q16
- 链路追踪的 traceId 传递也可以交给 OpenTelemetry / Micrometer Tracing 的上下文传播

→ 详见 [线程基础](/java/23_topic_thread_basics#七、threadlocal)、[CompletableFuture](/java/29_topic_completable_future#七、上下文传递)

### Q12：线程池的核心参数与任务提交流程？线程如何复用、非核心线程如何回收？

**核心结论**：提交顺序是「**核心线程 → 队列 → 非核心线程 → 拒绝**」，不是先把线程开到最大再排队。线程复用靠 `runWorker` 循环从队列取任务；回收靠 `getTask()` 中 `poll(keepAliveTime)` 超时返回 null，**核心与非核心只是「谁超时谁退出」**，线程本身没有标记。

| 参数 | 要点 |
|------|------|
| `corePoolSize` | 默认懒创建；线程数未到核心数时，即使有空闲线程，新任务也会新建线程；默认不因空闲回收，`allowCoreThreadTimeOut(true)` 后也会回收 |
| `maximumPoolSize` | 只有**队列满了**才会创建核心数以外的线程，配无界队列时形同虚设 |
| `keepAliveTime` | 超出核心数的线程空闲多久后回收 |
| `workQueue` | 生产必须有界 |
| `threadFactory` | 给线程起带业务含义的名字，设置未捕获异常处理器 |
| `handler` | 拒绝策略，默认 `AbortPolicy` |

- `ctl` 用一个 `AtomicInteger` 同时存运行状态（高 3 位：RUNNING / SHUTDOWN / STOP / TIDYING / TERMINATED）和线程数（低 29 位），一次 CAS 原子维护两者
- `corePoolSize = 0` 时任务仍会执行：入队后发现线程数为 0 会补一个线程，但队列满之前最多只有 1 个线程
- `execute` 的任务抛异常会让工作线程退出，线程池再补一个新线程
- 线程数怎么估算（CPU 密集约核数，IO 密集按等待 / 计算比例并以压测为准）见 [并发参数调优](/high-con/7_concurrency_tuning)

→ 详见 [线程池](/java/28_topic_thread_pool#一、threadpoolexecutor-底层原理)

### Q13：线程池的队列和拒绝策略怎么选？为什么不推荐用 Executors 创建？运行时动态调整参数要注意什么？

**核心结论**：生产用**有界队列** + **明确的拒绝策略**。`Executors` 的工厂方法要么是无界队列（任务积压到 OOM），要么线程数无上限（线程数失控），参数也藏在方法里看不到，所以统一手动 `new ThreadPoolExecutor`。

| `Executors` 方法 | 问题 |
|-----------------|------|
| `newFixedThreadPool` / `newSingleThreadExecutor` | `LinkedBlockingQueue()` 无界，积压到 OOM |
| `newCachedThreadPool` | `SynchronousQueue` + 最大线程数 `Integer.MAX_VALUE` |
| `newScheduledThreadPool` | 无界的 `DelayedWorkQueue`，最大线程数也不起作用 |

| 队列 | 作为线程池队列的行为 |
|------|-------------------|
| `ArrayBlockingQueue` / `LinkedBlockingQueue(capacity)` | 有界，生产首选 |
| `SynchronousQueue` | 不存任务，没有空闲线程就扩线程，需配合有限的最大线程数 |
| `PriorityBlockingQueue` | 无界；`submit` 把任务包成不可比较的 `FutureTask`，抛 `ClassCastException` |

| 拒绝策略 | 适用 |
|---------|------|
| `AbortPolicy`（默认） | 调用方感知并处理拒绝 |
| `CallerRunsPolicy` | 不能丢任务、可接受提交方变慢（反压）；提交方是 Web 请求线程时会拖慢整个容器 |
| `DiscardPolicy` / `DiscardOldestPolicy` | 任务确实可丢，至少要记日志和指标 |
| 自定义 | 记录、告警、落库或写 MQ 兜底 |

- **想先扩线程再排队**（IO 型任务常见）：自定义队列，`offer` 时线程数未达上限就返回 false，迫使线程池新建线程，Tomcat 的 `TaskQueue`、Dubbo 的 `EagerThreadPoolExecutor` 都这样做
- **动态调参**：`setCorePoolSize` / `setMaximumPoolSize` 运行中立即生效；JDK 9 起 core 不能大于 max，所以**扩容先调 max 再调 core，缩容先调 core 再调 max**；队列容量不能改，需要可变容量的自定义队列
- 监控 `getQueue().size()`、`getActiveCount()`、`getLargestPoolSize()`，队列积压是最关键的告警指标

→ 详见 [线程池](/java/28_topic_thread_pool#_7、blockingqueue-的选择)

### Q14：`execute` 与 `submit` 的区别？submit 的异常去哪了？`shutdown` 与 `shutdownNow` 有什么区别？

**核心结论**：`execute(Runnable)` 无返回值，任务异常抛到工作线程、交给 `UncaughtExceptionHandler` 打印，该线程退出并被替换；`submit` 把任务包成 `FutureTask`，异常被**保存在 `Future` 里**，不调用 `get()` 就无声无息。

| 异常处理方式 | 说明 |
|------------|------|
| 任务内 try-catch | 最直接，推荐作为默认习惯 |
| `Future.get()` | 抛 `ExecutionException`，`getCause()` 是原始异常 |
| 重写 `afterExecute` | 线程池层面统一兜底；`submit` 的任务要从 `Future` 中取异常 |
| `UncaughtExceptionHandler` | **只对 `execute` 生效** |

| 关闭方法 | 行为 |
|---------|------|
| `shutdown()` | 不再接收新任务，已提交的（含队列中的）继续执行，只中断空闲线程，立即返回 |
| `shutdownNow()` | 不再接收新任务，**清空队列并返回未执行的任务**，对所有工作线程 `interrupt()` |
| `awaitTermination(timeout)` | 阻塞等待进入 `TERMINATED` |
| `close()`（JDK 19+） | `shutdown` 后一直等待终止，可用于 try-with-resources |

- `shutdownNow()` 只是发中断信号，任务不响应中断就会一直跑完（见 Q2）
- 优雅关闭：`shutdown()` → `awaitTermination` → 超时再 `shutdownNow()`，被中断时恢复中断标志
- 周期任务（`scheduleAtFixedRate`）抛异常后**后续调度全部停止**且没有日志，任务体必须 try-catch

→ 详见 [线程池](/java/28_topic_thread_pool#二、任务提交与异常处理)

### Q15：CompletableFuture 的回调由哪个线程执行？不传线程池用的是什么？异常与超时怎么处理？

**核心结论**：不带 `Async` 的回调（`thenApply` 等）由**完成上游的线程**执行；注册回调时上游已经完成，则由**注册回调的线程**当场执行，从不提交到线程池。带 `Async` 且不传执行器时用 `ForkJoinPool.commonPool()`，**commonPool 并行度小于 2 时（如容器只给 1～2 核）每个任务新建一个线程**。生产代码的 `xxxAsync` 一律传入专用线程池。

| 问题 | 要点 |
|------|------|
| 组合 | `thenCompose` 扁平化异步调用，`thenCombine` 合并两个结果；`allOf` 等全部完成且**不快速失败**，`anyOf` 取第一个完成的、**不取消其余**、返回 `Object` |
| 异常传播 | 上游异常沿链传播，被包装成 `CompletionException`，处理前先 `getCause()` 解包 |
| `exceptionally` | 只在失败时执行，返回替代值 |
| `handle` | 成功失败都执行，可以改变结果 |
| `whenComplete` | 只观察（记录日志），不改变结果 |
| `join` vs `get` | `join` 抛非受检的 `CompletionException`；`get` 抛受检的 `ExecutionException` 和 `InterruptedException` |
| 超时 | `orTimeout` / `completeOnTimeout`（JDK 9）只是让 Future 提前完成，**不会取消底层任务**；`cancel(true)` 也**不中断**执行线程 |

- 真正的止损靠下游客户端自身的超时（HTTP 读超时、JDBC 查询超时）
- MDC / traceId 要通过包装执行器传递（见 Q11）
- JDK 21+ 请求内并行调用多个下游，也可以用虚拟线程 + 阻塞写法，代码更直观

→ 详见 [CompletableFuture](/java/29_topic_completable_future#二、回调由哪个线程执行)

### Q16：虚拟线程适合什么场景？为什么不能池化？JDK 24 之后还有哪些情况会钉住载体线程？

**核心结论**：虚拟线程适合**大量阻塞 IO 的任务**（thread-per-request 的 Web 服务、调用多个下游），它提升的是同时在途的任务数（吞吐），不是单个任务的速度；CPU 密集型任务没有收益。虚拟线程创建成本与普通对象相当，**每个任务新建一个、用完即弃**，不池化；对下游的并发上限改用 `Semaphore` 或连接池大小控制。

| 原则 | 原因 |
|------|------|
| 不池化 | 池化没有收益，还带来 `ThreadLocal` 串数据；把 `newFixedThreadPool(200)` 的线程工厂换成虚拟线程，并发仍被卡在 200 |
| 用 `Semaphore` / 连接池限流 | 线程池大小原本兼做「最多 N 个任务同时打下游」的闸门，换成虚拟线程后这道闸门消失 |
| CPU 密集型不用 | 不阻塞就不卸载，载体线程约等于核数，并行度没有变化 |
| 慎用 `ThreadLocal` 缓存大对象 | 百万虚拟线程就是百万份 |

**钉住（pinning）**：虚拟线程在某些位置阻塞时无法卸载，连同载体线程一起阻塞。JDK 21–23 中主要来源是在 `synchronized` 内阻塞和 `Object.wait()`；**JDK 24（JEP 491）后它们都能卸载**，剩下的钉住情况：

- 栈上有 native 帧：通过 JNI 或 FFM 调用本地代码，本地代码又回调 Java 并在其中阻塞
- 类加载、类初始化：在 `<clinit>` 中阻塞，或等待其他线程完成类初始化

文件 IO 等部分系统调用不算钉住，但会占住载体线程，调度器会临时增加载体线程补偿。

**诊断**：JFR 事件 `jdk.VirtualThreadPinned`（默认开启，阻塞超过 20 ms 记录）；`jcmd <pid> Thread.dump_to_file -format=json` 导出包含虚拟线程的线程转储（`jstack` 只列平台线程）。`-Djdk.tracePinnedThreads` 在 JDK 24 已移除。生产基线推荐 JDK 25 LTS。挂载 / 卸载原理见 [JVM 面试题解答](/interview/3_jvm) Q48–Q51。

→ 详见 [虚拟线程](/java/30_topic_virtual_thread#四、使用原则)

### Q17：ScopedValue 和 ThreadLocal 有什么区别？结构化并发能用于生产吗？

**核心结论**：`ScopedValue`（JDK 25 正式，JEP 506）在一个**有界的代码范围**内绑定一个**不可变**的值，范围结束自动解绑，适合请求级的只读上下文（当前用户、租户、traceId）；`ThreadLocal` 可随时修改、要手动 `remove`，适合可变的每线程状态和存量代码。**结构化并发在 JDK 25（第五次预览）、26、27 仍是预览**，每个版本都有不兼容调整，不要用于生产。

| 维度 | ThreadLocal | ScopedValue |
|------|-------------|-------------|
| 可变性 | 任何代码都能 `set` | 绑定后不可变，只能在内层范围重新绑定 |
| 生命周期 | 直到 `remove()` 或线程结束，忘记清理就泄漏 / 串数据 | 随 `run` / `call` 结束自动解绑 |
| 子线程继承 | `InheritableThreadLocal` 创建线程时复制整张表 | **只有** `StructuredTaskScope` fork 的子任务继承，零拷贝共享 |
| 读取开销 | 哈希查找 | 可被 JIT 优化，接近读字段 |

```java
static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

ScopedValue.where(CURRENT_USER, user).run(() -> service.process(request));
// 调用链任意深处：CURRENT_USER.get()，未绑定时抛 NoSuchElementException
```

- `ScopedValue` 不会传入普通线程池或 `CompletableFuture` 的回调，那里仍需包装执行器
- 结构化并发的价值是把一组并发子任务当成一个整体：子任务生命周期不超过父代码块，一个失败其余自动取消，线程转储保留父子关系。JDK 25 把 API 改成 `StructuredTaskScope.open(Joiner)`，JDK 21 的 `ShutdownOnFailure` 写法已无法编译。定稿前用 `CompletableFuture` 或虚拟线程执行器替代

→ 详见 [虚拟线程](/java/30_topic_virtual_thread#七、scopedvalue-jdk-25-正式)

### Q18：死锁的四个必要条件？如何预防、如何用 jstack 排查？活锁、饥饿与线程池饥饿死锁有什么区别？

**核心结论**：死锁的四个必要条件是**互斥、持有并等待、不可剥夺、循环等待**，破坏任意一个即可预防；互斥通常是资源本身的属性，一般从后三个入手，其中**固定加锁顺序**最常用。

| 破坏的条件 | 做法 |
|-----------|------|
| 持有并等待 | 一次性申请全部资源，拿不全就都不拿 |
| 不可剥夺 | `tryLock(timeout)` 失败时释放已持有的锁，退避后重试 |
| 循环等待 | 按全局固定顺序加锁（如按账户 ID 从小到大） |

**jstack 排查**：

```bash
jps -l                                     # 找到进程
jstack -l <pid> > dump.txt                 # -l 附带 ReentrantLock 等 j.u.c 锁的持有信息
grep -A 30 "Found one Java-level deadlock" dump.txt
```

- JVM 会自动检测 `synchronized` 与 j.u.c 锁形成的环，输出每个线程在等哪把锁、这把锁被谁持有；也可以用 `jcmd <pid> Thread.print -l`
- 症状通常是接口无响应、线程大量 `BLOCKED` / `WAITING`，CPU 却不高
- Arthas `thread -b` 只能找出阻塞其他线程的 `synchronized` 持有者，**不识别 j.u.c 锁**
- 死锁无法自行恢复：先保留线程转储，摘流量重启止血，再修复加锁顺序

| 对比 | 死锁 | 活锁 | 饥饿 | 线程池饥饿死锁 |
|------|------|------|------|-------------|
| 现象 | 互相等待，全部阻塞 | 线程一直 `RUNNABLE`，反复谦让重试却都完成不了 | 部分线程长期拿不到 CPU / 锁，其他线程正常 | 父任务占满线程并等待子任务，子任务在队列里永远排不上 |
| CPU | 低 | 可能很高 | 正常 | 低 |
| 典型原因 | 加锁顺序不一致 | 两个线程 `tryLock` 失败后以相同间隔重试；失败消息立即重回队头 | 非公平锁持续被插队；读多写少时写锁拿不到；慢任务占满共享线程池 | 父子任务共用同一个线程池且在池内阻塞等待 |
| 解决 | 固定顺序、超时 | **随机退避**、限制重试次数、失败消息进延迟或死信队列 | 公平锁（牺牲吞吐）、缩短持锁时间、按业务隔离线程池 | 父子任务用不同线程池，或改为异步编排不在池内等待 |

→ 详见 [故障排查](/jvm/9_troubleshooting#十一、死锁)、[线程池](/java/28_topic_thread_pool#九、常见坑)

---

高并发系统层面的设计（多级缓存、MQ 削峰、热点治理、分库分表、无状态扩展、线程池与连接池调优）见 [高并发面试题解答](/interview/13_high_con)。

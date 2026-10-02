---
description: 线程池、synchronized vs ReentrantLock、volatile、CAS、ConcurrentHashMap、死锁
---

# 开发总结 - Java 并发

> 精华提炼，细节详见 [Java 并发专题](/java/0_overview)；题目清单见 [Java 面试高频题](/java/99_interview) 的"并发基础"一节

## 一、线程池的核心参数有哪些？如何合理设置？

```java
new ThreadPoolExecutor(
    int corePoolSize,      // 核心线程数，长期保留不回收
    int maximumPoolSize,   // 最大线程数
    long keepAliveTime,    // 非核心线程空闲多久后回收
    TimeUnit unit,
    BlockingQueue<Runnable> workQueue,  // 任务缓冲队列
    ThreadFactory threadFactory,        // 线程工厂（建议命名）
    RejectedExecutionHandler handler    // 拒绝策略
)
```

**执行顺序**：提交任务 → 核心线程未满先建核心线程 → 满了入队 → 队满再建非核心线程 → 达到最大线程数触发拒绝策略。

**线程数参考公式**（只是起点，最终以阶梯压测拐点为准）：
- CPU 密集型：`N + 1`（N 为 CPU 核心数，+1 应对偶发缺页、中断）
- IO 密集型：`N × (1 + 等待时间 / 计算时间)`，等待 / 计算 = 9 时 8 核约 80 个线程
- 按流量反推：`目标 QPS × 单任务平均耗时`（Little 定律）

**四种拒绝策略**：

| 策略 | 行为 |
|------|------|
| `AbortPolicy`（默认）| 直接抛出 `RejectedExecutionException` |
| `CallerRunsPolicy` | 由调用者线程执行，起反压效果 |
| `DiscardPolicy` | 静默丢弃新任务 |
| `DiscardOldestPolicy` | 丢弃队头最旧任务，重新提交当前任务 |

::: warning 常见错误
禁止使用 `Executors.newFixedThreadPool`（使用无界 `LinkedBlockingQueue`，可能 OOM）和 `Executors.newCachedThreadPool`（线程数无上限）。
:::

→ 详见 [Java 线程池](/java/28_topic_thread_pool)；线程数、队列长度与 Tomcat 线程参数的调优见 [并发参数调优](/high-con/7_concurrency_tuning)

## 二、synchronized 和 ReentrantLock 的区别？

| 对比项 | synchronized | ReentrantLock |
|--------|-------------|---------------|
| 公平锁 | ❌ 不支持 | ✅ `new ReentrantLock(true)` |
| 可中断 | ❌ 不支持 | ✅ `lockInterruptibly()` |
| 超时获取 | ❌ 不支持 | ✅ `tryLock(time, unit)` |
| 条件变量 | 1 个（wait/notify）| 多个 `Condition`，精确唤醒 |
| 锁释放 | JVM 自动释放 | 必须手动 `unlock()`，放 finally |
| 锁升级 | HotSpot 按竞争程度膨胀（见下文） | 基于 AQS，无升级过程 |

**synchronized 锁升级过程**（HotSpot 的实现优化，不是语言规范，回答时先说 JDK 版本）：

| JDK 版本 | 路径 |
|---------|------|
| JDK 8 ~ 14 | 无锁 → 偏向锁（同一线程反复进入，无竞争）→ 轻量级锁（CAS 替换 Mark Word，竞争失败自旋等待）→ 重量级锁（ObjectMonitor，线程挂起） |
| JDK 15 ~ 17 | 偏向锁**默认关闭并废弃**，可用 `-XX:+UseBiasedLocking` 手动开启 |
| JDK 18+ | 偏向锁相关选项 obsolete，实际路径为 无锁 → 轻量级锁 → Monitor 锁 |

注意：自旋是竞争失败后的**等待策略**，不是 Mark Word 里独立的锁状态。

**如何选择**：大多数场景用 `synchronized` 足够；需要公平锁、超时、可中断、多条件通知时用 `ReentrantLock`。

→ 详见 [Java synchronized](/java/24_topic_synchronized) / [Lock 锁](/java/25_topic_lock)

## 三、volatile 关键字的作用？为什么不能保证原子性？

**两个作用**：
1. **可见性**：写操作立即刷新到主内存，读操作从主内存读取，不读 CPU 缓存
2. **有序性**：禁止指令重排序（插入内存屏障）

**为什么不能保证原子性**：

`volatile int i; i++` 在字节码层面是三步：读 i → 加 1 → 写 i。`volatile` 只保证每次读写主内存，但三步之间没有锁，多线程仍会交错执行。

**正确使用场景**：
- DCL 单例的 `instance` 字段（防止半初始化对象）
- 状态标志位（`volatile boolean stop`）

```java
// DCL 单例，instance 必须加 volatile
private static volatile Singleton instance;

public static Singleton getInstance() {
    if (instance == null) {
        synchronized (Singleton.class) {
            if (instance == null) {
                instance = new Singleton(); // 对象创建分三步，volatile 禁止重排序
            }
        }
    }
    return instance;
}
```

→ 详见 [Java JMM 内存模型](/java/22_topic_jmm)

## 四、CAS 是什么？ABA 问题如何解决？

**CAS（Compare And Swap）**：硬件级原子指令，比较内存值与期望值，相等才更新。是无锁乐观锁的基础。

**ABA 问题**：值从 A → B → A，CAS 认为没变化，实际上中间经历了变化。

**解决方案**：使用 `AtomicStampedReference`，加入版本号（stamp），每次更新版本号+1。

```java
AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(1, 0);
int[] stampHolder = {0};
Integer val = ref.get(stampHolder);  // 获取值和版本号
ref.compareAndSet(val, 2, stampHolder[0], stampHolder[0] + 1); // 同时比较值和版本号
```

**常用原子类**：`AtomicInteger`、`AtomicLong`、`AtomicReference`；高并发计数推荐 `LongAdder`（分段 Cell，减少竞争）。只关心"是否被改过"时可用 `AtomicMarkableReference`（布尔标记）。

**CAS 的其他代价**：竞争激烈时自旋重试消耗 CPU；只能保证单个变量的原子性，多个变量需合并为一个对象用 `AtomicReference` 或改用锁。

→ 详见 [Atomic 原子类](/java/26_topic_atomic)

## 五、ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？

更多详情见：<RouteLink to="/java/21_topic_collection#八、concurrenthashmap">Java基础：ConcurrentHashMap</RouteLink>

| | JDK 7 | JDK 8 |
|--|-------|-------|
| 数据结构 | Segment 数组 + HashEntry 链表 | 数组 + 链表/红黑树 |
| 锁粒度 | Segment 级别（分段锁，默认 16 段）| 桶（Node）级别 |
| 锁实现 | `ReentrantLock` | `synchronized` + CAS |
| 并发度 | 最大 16（Segment 数量）| 理论上等于数组长度 |
| 性能 | 分段锁并发度有限 | 细粒度锁 + 红黑树，性能更好 |

**JDK 8 put 流程**：计算 hash → 若桶为空，CAS 插入 → 桶非空，`synchronized` 锁住桶头 → 链表长度超 8 且数组长度 ≥ 64 时树化。

## 六、死锁的四个必要条件是什么？如何预防？

**死锁四个必要条件**：互斥、持有并等待、不可剥夺、循环等待。四个条件同时满足才会死锁，破坏任意一个即可预防；互斥通常是资源本身的属性，一般从后三个入手。

| 破坏的条件 | 做法 |
|-----------|------|
| 持有并等待 | 一次性申请全部资源，拿不全就都不拿 |
| 不可剥夺 | `tryLock(timeout)` 获取失败时主动释放已持有的锁，稍后重试 |
| 循环等待 | **固定加锁顺序**（如按账户 ID 从小到大加锁），最常用 |

**编码习惯**：避免嵌套锁、缩小临界区、锁内不调用外部方法和 RPC；读锁不要尝试升级为写锁（`ReentrantReadWriteLock` 两个线程同时升级会死锁）；父子任务不要共用同一个线程池，否则会出现线程池饥饿死锁（见 [Java 线程池](/java/28_topic_thread_pool)）。

→ 详见 [Lock 锁](/java/25_topic_lock)

## 七、如何用 jstack 排查死锁？

**核心结论**：`jstack -l <pid>` 会自动检测 Java 层面的死锁，输出 `Found one Java-level deadlock`，并列出每个线程在等哪把锁、这把锁被谁持有。

```bash
# 1. 找到 Java 进程 PID
jps -l

# 2. 输出线程堆栈（-l 附带 ReentrantLock 等 j.u.c 锁的持有信息）
jstack -l <pid> > thread_dump.txt

# 3. 搜索死锁报告
grep -A 30 "Found one Java-level deadlock" thread_dump.txt
```

**堆栈示例**（发现死锁特征）：

```text
Found one Java-level deadlock:
Thread-0 is waiting to lock <0x...> (held by Thread-1)
Thread-1 is waiting to lock <0x...> (held by Thread-0)
```

**要点**：

- 症状通常是应用无响应、大量线程 `BLOCKED`，CPU 却不高
- 找到环后看各线程的栈，定位两处加锁代码的顺序不一致之处
- 也可以用 `jcmd <pid> Thread.print`，或 Arthas `thread -b` 直接找出阻塞其他线程最多的线程
- 死锁线程无法自行恢复，线上先摘流量保留现场、再重启止血，修复加锁顺序后发布

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)、[线上诊断](/engineering/4_diagnosis)

## 八、说说 CountDownLatch、CyclicBarrier、Semaphore 的区别？

| 工具 | 特点 | 典型场景 |
|------|------|---------|
| `CountDownLatch` | 一次性倒计时，不可重置；主线程等待多个子线程 | 等待所有初始化任务完成后再启动 |
| `CyclicBarrier` | 可重置，所有线程互相等待到同一屏障点再继续 | 多阶段并行计算，每阶段同步一次 |
| `Semaphore` | 许可证机制，控制并发访问数量 | 数据库连接池限流、接口并发限制 |

```java
// Semaphore 限流示例：最多 10 个线程同时访问
Semaphore semaphore = new Semaphore(10);
semaphore.acquire();  // 获取许可，没有则阻塞
try {
    // 业务逻辑
} finally {
    semaphore.release();  // 释放许可
}
```

三者都基于 AQS 实现；`CountDownLatch` 是"一个（或多个）线程等其他线程"，`CyclicBarrier` 是"一组线程互相等待"，到达屏障时还可执行一个回调。

→ 详见 [并发工具类](/java/27_topic_juc_tools)

## 九、活锁和线程饥饿的区别？如何解决？

**核心结论**：三者都是"线程无法推进"，区别在线程的状态：**死锁**是互相等待、全部阻塞；**活锁**是线程没有阻塞、一直在运行，却因为互相"谦让"反复重试而谁也完成不了；**饥饿**是某些线程长期拿不到 CPU、锁或资源，而其他线程能正常推进。

| 对比 | 死锁 | 活锁 | 饥饿 |
|------|------|------|------|
| 线程状态 | `BLOCKED` / `WAITING`，互相等待 | `RUNNABLE`，不断重试 | 部分线程长期等待，其余正常 |
| CPU | 通常很低 | 可能很高（空转） | 正常 |
| 能否自行恢复 | 不能 | 偶然可能，通常不能 | 竞争缓解后可能恢复 |
| 典型场景 | 加锁顺序不一致 | 两个线程 `tryLock` 失败后都释放、都以相同间隔重试；消息处理失败立即重回队头、反复失败 | 非公平锁下某线程总被插队；高优先级线程长期占用；读多写少时写锁拿不到；线程池被慢任务占满、其他任务长期排队 |

**解决方式**：

- **活锁**：重试加**随机退避**（随机等待时间打破"同步谦让"），限制重试次数；失败消息进入延迟或死信队列，而不是立即重投
- **饥饿**：需要时用公平锁（`new ReentrantLock(true)`，代价是吞吐下降）；避免依赖线程优先级；缩短锁持有时间；慢任务与快任务使用不同线程池隔离；读写锁场景可用 `StampedLock` 乐观读减少写锁等待

→ 详见 [Lock 锁](/java/25_topic_lock)（公平锁与非公平锁）、[Java 线程池](/java/28_topic_thread_pool)（线程池饥饿死锁）

---

高并发系统层面的设计（多级缓存、MQ 削峰、热点治理、分库分表、无状态扩展、线程池与连接池调优）见 [开发总结 - 高并发](/interview/13_high_con)。

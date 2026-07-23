# 开发总结-高并发

> 精华提炼，细节详见 [high-con/](../high-con/0_juc)

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

**线程数参考公式**：
- CPU 密集型：`N + 1`（N 为 CPU 核心数，+1 防止偶发中断）
- IO 密集型：`2N`（线程大部分时间在等 IO，可以更多线程）

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

## 二、synchronized 和 ReentrantLock 的区别？

| 对比项 | synchronized | ReentrantLock |
|--------|-------------|---------------|
| 公平锁 | ❌ 不支持 | ✅ `new ReentrantLock(true)` |
| 可中断 | ❌ 不支持 | ✅ `lockInterruptibly()` |
| 超时获取 | ❌ 不支持 | ✅ `tryLock(time, unit)` |
| 条件变量 | 1 个（wait/notify）| 多个 `Condition`，精确唤醒 |
| 锁释放 | JVM 自动释放 | 必须手动 `unlock()`，放 finally |
| 锁升级 | 偏向锁 → 轻量级锁 → 重量级锁 | 基于 AQS，无升级过程 |

**synchronized 锁升级过程**：无锁 → 偏向锁（同一线程无竞争）→ 轻量级锁（CAS 自旋）→ 重量级锁（OS Mutex，线程挂起）。

**如何选择**：大多数场景用 `synchronized` 足够；需要公平锁、超时、多条件通知时用 `ReentrantLock`。

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

**常用原子类**：`AtomicInteger`、`AtomicLong`、`AtomicReference`；高并发计数推荐 `LongAdder`（分段 Cell，减少竞争）。

## 五、ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？

更多详情见：<RouteLink to="/java/1_base.md#四、concurrenthashmap-为何放弃分段锁">Java基础：ConcurrentHashMap</RouteLink>

| | JDK 7 | JDK 8 |
|--|-------|-------|
| 数据结构 | Segment 数组 + HashEntry 链表 | 数组 + 链表/红黑树 |
| 锁粒度 | Segment 级别（分段锁，默认 16 段）| 桶（Node）级别 |
| 锁实现 | `ReentrantLock` | `synchronized` + CAS |
| 并发度 | 最大 16（Segment 数量）| 理论上等于数组长度 |
| 性能 | 分段锁并发度有限 | 细粒度锁 + 红黑树，性能更好 |

**JDK 8 put 流程**：计算 hash → 若桶为空，CAS 插入 → 桶非空，`synchronized` 锁住桶头 → 链表长度超 8 且数组长度 ≥ 64 时树化。

## 六、如何排查生产中的死锁？

**死锁四个必要条件**：互斥、持有并等待、不可剥夺、循环等待。破坏任意一个即可预防。

**排查方式**：

```bash
# 1. 找到 Java 进程 PID
jps -l

# 2. 输出线程堆栈
jstack <pid> > thread_dump.txt

# 3. 搜索关键词
grep -A 20 "deadlock" thread_dump.txt
```

**堆栈示例**（发现死锁特征）：
```
Found one Java-level deadlock:
Thread-0 is waiting to lock <0x...> (held by Thread-1)
Thread-1 is waiting to lock <0x...> (held by Thread-0)
```

**预防策略**：
- 固定加锁顺序（破坏循环等待）
- 使用 `tryLock(timeout)` 超时释放（破坏持有并等待）
- 避免嵌套锁

## 七、说说 CountDownLatch、CyclicBarrier、Semaphore 的区别？

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

## 八、高并发系统设计的核心思路？

**读多写少**：多级缓存（Caffeine 本地 + Redis 分布式）→ 读写分离 → CDN 静态资源

**写多削峰**：消息队列（Kafka / RocketMQ）异步处理，消费者按能力消费

**热点问题**：
- 缓存穿透：BloomFilter + 缓存空值
- 缓存击穿：互斥锁重建 / 逻辑过期
- 缓存雪崩：过期时间加随机抖动 + 多级缓存

**数据库层**：连接池调优（HikariCP）、分库分表、慢查询优化

**无状态设计**：Session 外置（Redis）、服务节点无状态，支持水平扩展

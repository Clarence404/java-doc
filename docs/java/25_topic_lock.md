---
description: AQS 结构与流程、公平 / 非公平锁、Condition、读写锁、StampedLock、锁的选型
---

# 显式锁（Lock）

> 前置阅读：[synchronized](./24_topic_synchronized)、[JMM 内存模型](./22_topic_jmm)

`java.util.concurrent.locks` 里的锁是几乎全部建立在 AQS 之上的纯 Java 实现，理解了 AQS，`ReentrantLock`、读写锁、`Semaphore`、`CountDownLatch` 的行为都能推出来。本篇讲 JDK 14 之后的 AQS 实现、各类显式锁的用法与坑，以及 JDK 21 / 25 上（含虚拟线程）`synchronized` 与 `Lock` 的选择。

---

## 一、Lock 接口

| 方法 | 语义 | 对应 `synchronized` 能力 |
|------|------|--------------------------|
| `lock()` | 阻塞获取，不响应中断 | 进入同步块 |
| `lockInterruptibly()` | 阻塞获取，等待期间可被中断（抛 `InterruptedException`） | 无 |
| `tryLock()` | 立即尝试一次，成功返回 `true` | 无 |
| `tryLock(time, unit)` | 限时等待，超时返回 `false`，可被中断 | 无 |
| `unlock()` | 释放；非持有者调用抛 `IllegalMonitorStateException` | 退出同步块 |
| `newCondition()` | 创建条件变量，一把锁可以有多个 | 只有一个 `wait/notify` 等待集 |

标准写法：`lock()` 放在 `try` **之前**，`unlock()` 放在 `finally` 里。

```java
private final ReentrantLock lock = new ReentrantLock();

public void transfer() {
    lock.lock();            // 不放进 try：若 lock() 本身失败，finally 不会去 unlock 一把没拿到的锁
    try {
        // 临界区
    } finally {
        lock.unlock();      // 无论正常返回还是抛异常都释放
    }
}
```

---

## 二、AQS 原理

`AbstractQueuedSynchronizer`（AQS）是一个同步器框架：它负责**排队、阻塞、唤醒、中断与超时**这些通用逻辑，子类只需定义「state 怎样算获取成功、怎样算释放」。

### 1、state 与子类语义

AQS 用一个 `volatile int state` 表示同步状态，具体含义由子类决定：

| 同步器 | 模式 | state 含义 |
|--------|------|-----------|
| `ReentrantLock` | 独占 | 0 = 空闲，>0 = 持有者的重入次数 |
| `ReentrantReadWriteLock` | 独占 + 共享 | 高 16 位 = 读锁持有总数，低 16 位 = 写锁重入次数 |
| `Semaphore` | 共享 | 剩余许可数 |
| `CountDownLatch` | 共享 | 剩余计数，归零后所有 `await` 放行 |
| `ThreadPoolExecutor.Worker` | 独占（不可重入） | −1 = 尚未启动，0 = 空闲，1 = 正在执行任务 |

`CyclicBarrier` 不在这张表里：它没有继承 AQS，而是用 `ReentrantLock` + `Condition` 实现，只是间接用到 AQS，详见 [同步工具类](./27_topic_juc_tools)。

子类要实现的模板方法：

- `tryAcquire(int)` / `tryRelease(int)`：独占模式的获取与释放
- `tryAcquireShared(int)` / `tryReleaseShared(int)`：共享模式；`tryAcquireShared` 返回负数表示失败、0 表示成功但后续共享获取不会成功、正数表示后续也可能成功（需要继续向后传播唤醒）
- `isHeldExclusively()`：当前线程是否独占持有，`Condition` 依赖它

这些方法只操作 state（通常用 `compareAndSetState`），**不负责排队和阻塞**——那是 AQS 的事。

### 2、同步队列与节点（JDK 14+）

获取失败的线程会被包装成节点放进一个 **CLH 变体的双向链表**（同步队列）。JDK 14 对 AQS 做过一次重写（JDK-8229442），JDK 17 / 21 / 25 都是这一版：

![AQS 结构](../assets/java/aqs-structure.svg)

- 节点分为 `ExclusiveNode`、`SharedNode`、`ConditionNode` 三个子类，字段只有 `prev`、`next`、`waiter`（等待的线程）和 `status`
- `status` 只有三种标志：`WAITING`（已经或即将 park，需要被唤醒）、`CANCELLED`（超时或中断后放弃）、`COND`（在条件队列中等待）
- `head` 是一个不代表等待者的哑节点，在第一次发生竞争时惰性创建；拿到锁的节点会成为新的 `head`
- `ConditionNode` 实现了 `ForkJoinPool.ManagedBlocker`，在 ForkJoinPool 的工作线程里 `await` 时可以让池补偿线程

> JDK 8 的旧实现：节点类是单一的 `Node`，用 `Node.EXCLUSIVE` / `Node.SHARED` 常量区分模式，用 `waitStatus` 的 `SIGNAL(-1)`、`CANCELLED(1)`、`CONDITION(-2)`、`PROPAGATE(-3)` 表示状态，并且「是否需要唤醒」记在**前驱**节点上。很多老资料讲的 `SIGNAL`、`PROPAGATE` 在 JDK 14 以后都已不存在。

AQS 被称为「CLH 变体」，但它和原始 CLH 锁的关键区别是：**等待者不在前驱上自旋，而是 park 挂起**。队首节点在 park 之前只做极短的自旋（`Thread.onSpinWait()`），其余节点直接睡眠，等前驱释放时被 `unpark`。双向链接是为了取消节点时能快速找到前驱、跳过已取消节点。

### 3、获取与释放流程

![AQS 独占模式获取与释放](../assets/java/aqs-acquire-release.svg)

独占获取 `acquire(1)`：

1. 先调用一次 `tryAcquire`，成功直接返回，不创建任何节点（无竞争时的快速路径）
2. 失败则创建 `ExclusiveNode`，CAS 追加到 `tail`
3. 在一个循环里：如果自己是 `head` 的后继（队首），再 `tryAcquire` 一次，成功就把自己设为新 `head` 并返回
4. 仍失败：队首先短暂自旋；然后把自己的 `status` 置为 `WAITING`，再检查一次，最后 `LockSupport.park()`
5. 被唤醒后回到第 3 步重试；被中断时，`lockInterruptibly` 会取消节点并抛 `InterruptedException`，`lock()` 只记下中断标志继续等待，获取成功后再补发中断

释放 `release(1)`：`tryRelease` 把 state 减到 0 时返回 `true`，AQS 再对 `head` 的后继调用 `signalNext`，清除其 `WAITING` 标志并 `unpark`。

共享模式（`acquireShared`）流程相同，区别是获取成功后如果还有余量，会继续唤醒后面的 `SharedNode`——这就是 `CountDownLatch` 归零时所有等待线程一起放行的原因。

### 4、取消、中断与超时

- `tryLock(timeout)`、`lockInterruptibly()`、`await(timeout)` 失败时会把节点标记为 `CANCELLED` 并从队列中摘除，后续节点会跳过它们
- 超时等待用 `LockSupport.parkNanos`，每次醒来都重新计算剩余时间，耗尽即取消节点并返回失败
- 被 `unpark` 不代表一定能拿到锁（非公平模式下可能被插队），所以获取逻辑始终在循环里

---

## 三、ReentrantLock

### 1、可重入的实现

`ReentrantLock` 内部的 `Sync` 继承 AQS，并记录 `exclusiveOwnerThread`：

- 获取时如果 state 为 0，CAS 成 1 并记录持有者
- 如果 state 不为 0 但持有者就是当前线程，直接 state + 1（这一步不需要 CAS，因为只有持有者能修改）
- 释放时 state − 1，减到 0 才清空持有者并唤醒后继；`lock()` 几次就必须 `unlock()` 几次
- 重入次数上限是 `int` 最大值，溢出会抛 `Error("Maximum lock count exceeded")`

### 2、公平锁与非公平锁

```java
ReentrantLock unfair = new ReentrantLock();      // 默认非公平
ReentrantLock fair   = new ReentrantLock(true);  // 公平
```

| | 非公平锁（默认） | 公平锁 |
|--|------------------|--------|
| 获取规则 | `lock()` 先直接 CAS 抢一次，失败再排队 | state 为 0 时还要求队列中没有比自己更早的等待者（`hasQueuedPredecessors()`） |
| 吞吐量 | 高：刚释放的锁可能被正在运行的线程直接拿走，省掉一次唤醒和上下文切换 | 低：每次交接都要唤醒队首线程 |
| 饥饿 | 理论上可能，实际少见 | 不会被插队 |
| 适用 | 绝大多数场景 | 对等待顺序有硬性要求、持锁时间长且需要避免个别请求长时间饿死 |

两个细节：

- **公平锁的 `tryLock()`（无参）也会插队**：只要锁空闲就立即获取，不看队列；需要公平语义时用 `tryLock(0, TimeUnit.SECONDS)`
- 公平只针对锁的获取顺序，不保证线程调度公平；操作系统决定被唤醒的线程何时真正运行

### 3、诊断方法

`ReentrantLock` 提供了 `synchronized` 没有的运行时自省能力，适合写进监控或排查日志：

| 方法 | 用途 |
|------|------|
| `isLocked()` / `isHeldByCurrentThread()` | 断言锁状态，常用于 `assert` 或单元测试 |
| `getHoldCount()` | 当前线程的重入次数 |
| `getQueueLength()` / `hasQueuedThreads()` | 等待线程数（估算值），可作为锁竞争指标 |
| `getWaitQueueLength(condition)` | 某个条件上的等待线程数 |

线上排查：`jstack -l <pid>` 或 `jcmd <pid> Thread.print -l` 会在每个线程下打印 `Locked ownable synchronizers`，能看到哪个线程持有哪把 `ReentrantLock`；等待者显示为 `parking to wait for <0x...> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)`。JFR 中 `synchronized` 的竞争记录为 `jdk.JavaMonitorEnter`，`Lock` 的等待记录为 `jdk.ThreadPark`。

---

## 四、Condition

### 1、用法

`Condition` 是与某把 `Lock` 绑定的等待集，对应 `Object.wait/notify`，但一把锁可以有多个条件，能做到「只唤醒生产者」或「只唤醒消费者」：

```java
public class BoundedBuffer<E> {
    private final Object[] items;
    private int putIndex, takeIndex, count;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull  = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();

    public BoundedBuffer(int capacity) {
        this.items = new Object[capacity];
    }

    public void put(E e) throws InterruptedException {
        lock.lock();
        try {
            while (count == items.length) {   // 必须用 while：防止虚假唤醒和被其他线程抢先
                notFull.await();               // 释放锁并等待，被唤醒后重新获取锁才返回
            }
            items[putIndex] = e;
            putIndex = (putIndex + 1) % items.length;
            count++;
            notEmpty.signal();                 // 只唤醒等待「非空」的消费者
        } finally {
            lock.unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public E take() throws InterruptedException {
        lock.lock();
        try {
            while (count == 0) {
                notEmpty.await();
            }
            E e = (E) items[takeIndex];
            items[takeIndex] = null;
            takeIndex = (takeIndex + 1) % items.length;
            count--;
            notFull.signal();
            return e;
        } finally {
            lock.unlock();
        }
    }
}
```

`ArrayBlockingQueue` 内部就是这个结构。调用 `await/signal` 时必须持有对应的锁，否则抛 `IllegalMonitorStateException`。

### 2、原理：条件队列与同步队列

每个 `ConditionObject` 维护一条单向的**条件队列**（`ConditionNode`，通过 `nextWaiter` 链接），与锁的同步队列是两条不同的队列：

1. `await()`：创建 `ConditionNode` 加入条件队列 → **完全释放**锁（保存当前重入次数）→ park
2. `signal()`：把条件队列的第一个节点**转移到同步队列尾部**，它并不会立刻运行
3. 被转移的线程在同步队列里排队，重新获取锁（恢复原来的重入次数）后，`await()` 才返回

所以「被 signal」和「拿到锁」之间有时间差，其他线程可能先改变了条件，这也是必须用 `while` 重新检查条件的原因。`await` 还有 `awaitNanos`、`await(time, unit)`、`awaitUntil`、`awaitUninterruptibly` 等变体。

---

## 五、ReentrantReadWriteLock

### 1、state 拆分与读锁计数

读写锁把一个 `int state` 拆成两半：**高 16 位**是所有线程持有读锁的总数，**低 16 位**是写锁的重入次数，所以读锁总数、写锁重入次数都不能超过 65535。每个线程各自的读锁重入次数无法放进 state，因此保存在 `ThreadLocal`（`readHolds`）里，并用 `firstReader` 和 `cachedHoldCounter` 缓存最近的读者，减少 ThreadLocal 查找。

规则：

- 读读共享，读写、写写互斥
- 持有写锁的线程可以再获取读锁（这是锁降级的基础）
- 持有读锁的线程**不能**获取写锁

### 2、锁降级

持有写锁 → 获取读锁 → 释放写锁，这样数据更新后其他线程可以立刻并发读取，而当前线程在使用这份数据期间不会被别的写者修改：

```java
public class CachedData {
    private final ReentrantReadWriteLock rwl = new ReentrantReadWriteLock();
    private Object data;
    private boolean cacheValid;

    public void processCachedData() {
        rwl.readLock().lock();
        if (!cacheValid) {
            rwl.readLock().unlock();           // 必须先释放读锁，否则下一行会自锁
            rwl.writeLock().lock();
            try {
                if (!cacheValid) {             // 再检查：等待写锁期间可能已被别的线程刷新
                    data = loadData();
                    cacheValid = true;
                }
                rwl.readLock().lock();         // 降级：持有写锁时获取读锁
            } finally {
                rwl.writeLock().unlock();      // 释放写锁，仍持有读锁
            }
        }
        try {
            use(data);
        } finally {
            rwl.readLock().unlock();
        }
    }

    private Object loadData() { return new Object(); }
    private void use(Object d) { }
}
```

### 3、读锁不能升级为写锁

```java
rwl.readLock().lock();
rwl.writeLock().lock();   // 永久阻塞
```

**单个线程就会死锁**：写锁要求没有任何读锁持有者，而这个读锁正是当前线程自己持有的，它在等自己释放。两个线程同时尝试升级也会互相等待。需要「读后可能写」的场景，要么像上面那样先释放读锁再申请写锁（并在写锁内重新检查），要么用 `StampedLock.tryConvertToWriteLock`。

### 4、写饥饿与适用场景

- 读多写少、读操作耗时较长时收益明显；读操作很短时，维护读计数的开销可能抵消并发读的收益，不如直接用 `ReentrantLock` 或并发容器
- 非公平模式下，新来的读线程如果发现队首等待的是写线程会主动让步（`readerShouldBlock` 的启发式判断），这能缓解写饥饿但不能完全避免；对写延迟敏感时用公平模式或 `StampedLock`
- 写锁支持 `Condition`，读锁调用 `newCondition()` 会抛 `UnsupportedOperationException`

---

## 六、StampedLock

`StampedLock`（JDK 8）不是基于 AQS 的，它用一个 `long` 型的版本号（stamp）同时表示锁状态和版本，提供三种模式：

| 模式 | 方法 | 说明 |
|------|------|------|
| 写锁 | `writeLock()` / `unlockWrite(stamp)` | 独占 |
| 悲观读锁 | `readLock()` / `unlockRead(stamp)` | 共享，与写互斥 |
| 乐观读 | `tryOptimisticRead()` / `validate(stamp)` | 不加锁，只拿版本号，读完再校验期间是否有写 |

### 1、乐观读与写锁

```java
public class Point {
    private final StampedLock sl = new StampedLock();
    private double x, y;

    public void move(double dx, double dy) {
        long stamp = sl.writeLock();
        try {
            x += dx;
            y += dy;
        } finally {
            sl.unlockWrite(stamp);
        }
    }

    public double distanceFromOrigin() {
        long stamp = sl.tryOptimisticRead();   // 不阻塞，返回当前版本号
        double curX = x, curY = y;              // 先把字段读到局部变量
        if (!sl.validate(stamp)) {              // 读期间发生过写，退回悲观读锁重读
            stamp = sl.readLock();
            try {
                curX = x;
                curY = y;
            } finally {
                sl.unlockRead(stamp);
            }
        }
        return Math.hypot(curX, curY);          // validate 通过后才使用读到的值
    }
}
```

乐观读期间读到的字段可能是不一致的中间状态，**在 `validate` 通过之前不能拿它们做任何有副作用或可能抛异常的操作**（比如当作数组下标）。

### 2、升级：tryConvertToWriteLock

```java
public void moveIfAtOrigin(double newX, double newY) {
    long stamp = sl.readLock();
    try {
        while (x == 0.0 && y == 0.0) {
            long ws = sl.tryConvertToWriteLock(stamp);   // 尝试原地升级
            if (ws != 0L) {
                stamp = ws;
                x = newX;
                y = newY;
                break;
            }
            sl.unlockRead(stamp);                        // 升级失败：释放读锁，改为申请写锁
            stamp = sl.writeLock();
        }
    } finally {
        sl.unlock(stamp);                                // 按 stamp 的实际模式释放
    }
}
```

### 3、限制与坑

- **不可重入**：同一线程在持有写锁时再调用 `writeLock()` 或 `readLock()` 会自锁
- **不支持 `Condition`**：需要条件等待时用 `ReentrantLock` 或 `ReentrantReadWriteLock`
- **`readLock()` / `writeLock()` 不响应中断**：需要可中断时用 `readLockInterruptibly()` / `writeLockInterruptibly()`，或带超时的 `tryReadLock(time, unit)` / `tryWriteLock(time, unit)`
- 没有持有者概念：stamp 可以在任意线程释放，传错 stamp 会抛 `IllegalMonitorStateException`
- 需要 `Lock` / `ReadWriteLock` 接口时可以用 `asReadLock()`、`asWriteLock()`、`asReadWriteLock()` 视图，但视图同样不可重入、不支持 `Condition`

适用场景：读远多于写、读临界区很短且只是读几个字段（坐标、配置快照、统计值），并且代码完全在自己掌控之内。

---

## 七、synchronized 与 ReentrantLock 对比

`synchronized` 的对象头、锁升级与版本差异见 [synchronized](./24_topic_synchronized)，本篇不再重复。

| | `synchronized` | `ReentrantLock` |
|--|----------------|-----------------|
| 实现层级 | JVM 内置：同步块编译为 `monitorenter` / `monitorexit`，同步方法通过 `ACC_SYNCHRONIZED` 标志 | Java 代码，基于 AQS + `LockSupport.park` |
| 锁对象 | 实例方法锁 `this`，静态方法锁 `Class` 对象，同步块锁指定对象 | `Lock` 实例本身 |
| 释放方式 | 自动，异常时也会释放 | 必须在 `finally` 中 `unlock()` |
| 可中断 | 不支持 | `lockInterruptibly()` |
| 超时 / 尝试获取 | 不支持 | `tryLock()` / `tryLock(timeout)` |
| 公平性 | 非公平 | 默认非公平，可选公平 |
| 条件变量 | 一个等待集（`wait/notify`） | 多个 `Condition` |
| 诊断 | `jstack` 显示 `waiting to lock`，JFR `jdk.JavaMonitorEnter` | `jstack -l` 显示 ownable synchronizers，提供 `getQueueLength` 等方法 |
| 虚拟线程 | JDK 21–23：在 `synchronized` 内阻塞会钉住（pin）载体线程；JDK 24+（JEP 491）不再钉住 | 一直不会钉住，阻塞时虚拟线程从载体线程卸载 |
| 性能 | 无竞争和低竞争下与 `ReentrantLock` 相当，差异取决于场景，以压测为准 | 同左；高竞争下可借助 `tryLock`、读写分离等手段降低竞争 |

选择建议：

- 默认用 `synchronized`：代码短、不会忘记释放，JVM 还能做锁消除、锁粗化等优化
- 需要可中断、超时、公平、多条件、读写分离、运行时自省时用 `Lock`
- 虚拟线程：在 JDK 21–23 上，如果同步块里有 IO 等阻塞操作，用 `ReentrantLock` 替换 `synchronized` 可以避免钉住载体线程；**升级到 JDK 24+ 后这条理由不再成立**。JDK 24+ 仍会钉住的情况只剩栈上有 native 方法 / 外部函数帧，以及在类初始化器中阻塞或等待其他线程完成类初始化。JDK 24 起 `-Djdk.tracePinnedThreads` 已移除，排查钉住改用 JFR 的 `jdk.VirtualThreadPinned` 事件。虚拟线程本身见 [线程池](./28_topic_thread_pool) 的虚拟线程一节

---

## 八、LockSupport

AQS 的阻塞与唤醒最终都落在 `LockSupport.park()` / `unpark(thread)` 上。它按线程发放「许可」：`unpark` 可以先于 `park` 调用，许可不会丢失（但不累加，最多一个），因此不存在 `notify` 早于 `wait` 导致信号丢失的问题。`park` 也可能无故返回（虚假唤醒），调用方必须在循环里重新检查条件，AQS 正是这样做的。用法及与 `wait/notify`、`Condition` 的对比见 [线程基础](./23_topic_thread_basics)。

---

## 小结

- AQS = `volatile int state` + CLH 变体双向同步队列 + 条件队列；子类只定义 `tryAcquire/tryRelease`（独占）或 `tryAcquireShared/tryReleaseShared`（共享）
- JDK 14 起 AQS 节点改为 `ExclusiveNode / SharedNode / ConditionNode`，状态只剩 `WAITING / CANCELLED / COND`；等待者 park 挂起而不是在前驱上自旋，`SIGNAL / PROPAGATE` 是 JDK 8 时代的概念
- `CyclicBarrier` 不继承 AQS，它基于 `ReentrantLock + Condition`
- 非公平锁先抢再排队，吞吐更高；公平锁检查 `hasQueuedPredecessors()`，但无参 `tryLock()` 照样插队
- `Condition.await` 完全释放锁，`signal` 只是把节点从条件队列转移到同步队列，返回前必须重新获取锁，条件判断必须用 `while`
- 读写锁 state 高 16 位读、低 16 位写；支持写锁降级为读锁，读锁升级为写锁在单线程下就会死锁
- `StampedLock` 乐观读要先拷贝到局部变量再 `validate`；它不可重入、不支持 `Condition`、普通 `readLock/writeLock` 不响应中断
- 虚拟线程：JDK 21–23 用 `ReentrantLock` 规避 `synchronized` 钉住载体线程，JDK 24+（JEP 491）后两者都不会因锁阻塞而钉住

## 参考资料

- AbstractQueuedSynchronizer（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/locks/AbstractQueuedSynchronizer.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/locks/AbstractQueuedSynchronizer.html)
- java.util.concurrent.locks 包说明：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/locks/package-summary.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/locks/package-summary.html)
- Doug Lea, The java.util.concurrent Synchronizer Framework：[https://gee.cs.oswego.edu/dl/papers/aqs.pdf](https://gee.cs.oswego.edu/dl/papers/aqs.pdf)
- JEP 491 — Synchronize Virtual Threads without Pinning：[https://openjdk.org/jeps/491](https://openjdk.org/jeps/491)

> 下一篇：[原子类（Atomic）](./26_topic_atomic) —— 不加锁也能保证单变量的原子更新：CAS、VarHandle 与 LongAdder。

# Java 专项-Lock 锁

## 一、synchronized

### 底层原理

- **对象锁**：锁的是对象头中的 Mark Word，通过 `monitorenter` / `monitorexit` 字节码实现
- **类锁**：锁的是 Class 对象，`static synchronized` 方法或 `synchronized(Xxx.class)`
- Java 6 引入锁升级：**无锁 → 偏向锁 → 轻量级锁 → 重量级锁**（不可逆降级）

### 锁升级过程

```
无锁
  ↓ 第一个线程访问
偏向锁（Mark Word 记录线程 ID，无竞争时 CAS 免加锁）
  ↓ 有第二个线程竞争
轻量级锁（CAS 自旋，适合短暂竞争）
  ↓ 自旋超过阈值 / 线程数过多
重量级锁（OS Mutex，线程挂起，上下文切换）
```

### 注意事项

- 锁对象不能为 `null`，不建议锁 `String` 常量（池中共享，可能死锁）
- `synchronized` 方法和 `synchronized(this)` 等价，锁的是同一个对象

---

## 二、AbstractQueuedSynchronizer（AQS）

`ReentrantLock`、`Semaphore`、`CountDownLatch`、`CyclicBarrier` 等都基于 AQS 实现。

### 核心数据结构

```
state（volatile int）：同步状态，不同子类语义不同
  ReentrantLock：0=未锁，>0=重入次数
  Semaphore：剩余许可数
  CountDownLatch：剩余计数

CLH 变体双向队列：等待线程封装为 Node 排队
  Node.EXCLUSIVE（独占模式）
  Node.SHARED（共享模式）
```

### 独占锁获取流程

```
tryAcquire()  →  成功：直接返回
              →  失败：封装为 Node 加入队尾
                        ↓
                 自旋尝试获取（前驱是 head 才能尝试）
                        ↓
                 仍失败：LockSupport.park() 挂起线程
```

### 释放流程

```
tryRelease()  →  修改 state
              →  唤醒队列中 head.next 节点的线程（LockSupport.unpark）
```

---

## 三、ReentrantLock

```java
ReentrantLock lock = new ReentrantLock(true); // true = 公平锁

lock.lock();
try {
    // 临界区
} finally {
    lock.unlock(); // 必须在 finally 释放
}

// 可中断获取锁
lock.lockInterruptibly();

// 超时尝试
if (lock.tryLock(500, TimeUnit.MILLISECONDS)) {
    try { ... } finally { lock.unlock(); }
}
```

### 公平锁 vs 非公平锁

| | 公平锁 | 非公平锁（默认） |
|--|--------|------------------|
| 获取顺序 | 严格 FIFO | 允许插队 |
| 吞吐量 | 低（线程切换多） | **高**（减少上下文切换） |
| 饥饿 | 不会 | 可能 |

### Condition 条件变量

```java
Condition notFull  = lock.newCondition();
Condition notEmpty = lock.newCondition();

// 生产者
lock.lock();
try {
    while (isFull()) notFull.await();   // 释放锁并等待
    add(item);
    notEmpty.signal();                  // 唤醒消费者
} finally { lock.unlock(); }
```

---

## 四、ReadWriteLock / StampedLock

### ReentrantReadWriteLock

```java
ReentrantReadWriteLock rwl = new ReentrantReadWriteLock();
Lock readLock  = rwl.readLock();
Lock writeLock = rwl.writeLock();
```

- 读读不互斥，读写 / 写写互斥
- 写锁支持降级为读锁（持有写锁时获取读锁，再释放写锁）
- **读锁不支持升级为写锁**（会死锁）
- 写多读少时性能比 `synchronized` 差（锁状态维护开销）

### StampedLock（Java 8）

提供三种模式，支持**乐观读**以进一步减少锁竞争：

```java
StampedLock sl = new StampedLock();

// 乐观读（无锁，版本号校验）
long stamp = sl.tryOptimisticRead();
double x = this.x;
double y = this.y;
if (!sl.validate(stamp)) {         // 期间有写操作，升级为悲观读锁
    stamp = sl.readLock();
    try { x = this.x; y = this.y; }
    finally { sl.unlockRead(stamp); }
}

// 写锁
long stamp = sl.writeLock();
try { this.x = newX; }
finally { sl.unlockWrite(stamp); }
```

**注意**：StampedLock **不可重入**，且不支持 Condition。

---

## 五、synchronized vs ReentrantLock 对比

| | `synchronized` | `ReentrantLock` |
|--|----------------|-----------------|
| 实现层级 | JVM 内置，字节码指令 | Java 代码，基于 AQS |
| 释放方式 | 自动（异常也释放） | 必须手动 `unlock()` |
| 可中断 | ❌ | ✅ `lockInterruptibly()` |
| 超时获取 | ❌ | ✅ `tryLock(timeout)` |
| 公平锁 | ❌ | ✅ 构造参数控制 |
| 条件变量 | 单一 `wait/notify` | 多个 `Condition` |
| 性能 | Java 6 后差距不大 | 高竞争下略优 |
| 推荐场景 | 简单同步块 | 需要高级特性时 |

---

## 六、LockSupport

AQS 底层线程挂起/唤醒工具，比 `wait/notify` 更灵活：

```java
// 挂起当前线程（不需要持有锁）
LockSupport.park();
LockSupport.parkNanos(1000_000_000L); // 超时

// 唤醒指定线程（可先于 park 调用，不丢失信号）
LockSupport.unpark(thread);
```

`unpark` 可以在 `park` 之前调用（发放"许可证"），调用 `park` 时直接返回，解决了 `notify` 必须在 `wait` 之后的限制。

---

## 七、常见面试问题

**Q：ReentrantLock 的可重入如何实现？**
`tryAcquire` 时检查当前线程是否是已持有锁的线程，是则 state 加 1；释放时 state 减 1，减到 0 才真正释放。

**Q：为什么 AQS 用 CLH 变体而不是普通队列？**
CLH 队列节点自旋在前驱节点状态上，减少了全局状态的竞争；加入"虚拟头节点"和双向链接方便取消节点时快速找到前驱。

**Q：读写锁为什么不允许读升级写？**
若两个线程都持有读锁并同时尝试升级为写锁，双方都等对方释放读锁，造成死锁。

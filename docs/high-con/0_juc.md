# JUC

参考链接：
> [advanced-java 高并发架构](https://gitee.com/Doocs/advanced-java#%E9%AB%98%E5%B9%B6%E5%8F%91%E6%9E%B6%E6%9E%84)
> [实现异步的9种方式-捡田螺的小男孩](https://mp.weixin.qq.com/s/eTQwT-zFgHgNVJ_nNAZidw)

## 一、JUC - Atomic

Java 中的 `java.util.concurrent.atomic` 包提供了一组**原子变量类**，主要用于**高并发场景下的无锁编程**，比起使用
`synchronized`，这些类可以提升程序的性能和吞吐量。

### 1、核心思想

CAS（Compare-And-Swap）是实现原子操作的核心思想，其工作原理如下：

- **比较内存中的值与预期值**，如果一致，则将其更新为新的值。
- 它是一种**乐观锁机制**，通过尝试修改共享数据并检查是否发生了冲突来保证线程安全。

### 2、常用分类

#### 2.1. 基本类型原子类

| 类名              | 对应类型    |
|-----------------|---------|
| `AtomicInteger` | int     |
| `AtomicLong`    | long    |
| `AtomicBoolean` | boolean |

**示例：**

```java
private void test() {
    AtomicInteger counter = new AtomicInteger(0);
    counter.incrementAndGet();  // +1
    counter.addAndGet(5);       // +5
}
```

#### 2.2 引用类型原子类

| 类名                           | 说明           |
|------------------------------|--------------|
| `AtomicReference<T>`         | 原子更新引用       |
| `AtomicStampedReference<T>`  | 带版本戳，解决ABA问题 |
| `AtomicMarkableReference<T>` | 带布尔标记        |

**ABA问题解决示例：**

```java
private void test() {
    AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(1, 0);
    int[] stampHolder = new int[1];
    Integer value = ref.get(stampHolder);
    ref.compareAndSet(value, 2, stampHolder[0], stampHolder[0] + 1);
}
```

#### 2.3 数组原子类

| 类名                        | 说明        |
|---------------------------|-----------|
| `AtomicIntegerArray`      | 原子更新整型数组  |
| `AtomicLongArray`         | 原子更新长整型数组 |
| `AtomicReferenceArray<T>` | 原子更新引用数组  |

#### 2.4 高级类：`LongAdder` / `LongAccumulator`

为了解决高并发下 `AtomicLong` 的热点问题，引入了分段累加器：

```java
LongAdder adder = new LongAdder();
adder.increment(); // 内部分段，高并发下效率远高于 AtomicLong
long sum = adder.sum();
```

`LongAdder` 将计数分散到多个 Cell，减少 CAS 竞争；`sum()` 时汇总所有 Cell。适合**只需最终汇总、不需要实时精确值**的高并发计数场景。

### 3、优缺点对比

| 特点   | Atomic 原子类 | synchronized |
|------|------------|--------------|
| 是否阻塞 | 否（非阻塞）     | 是            |
| 性能   | 高          | 中            |
| 是否公平 | 否          | 是            |
| 可读性  | 一般         | 高            |

---

## 二、JUC - LOCK

### synchronized vs ReentrantLock

| 对比 | `synchronized` | `ReentrantLock` |
|------|--------------|----------------|
| 实现层 | JVM 内置关键字 | Java 类（`java.util.concurrent`）|
| 锁释放 | 自动（代码块结束/异常）| 必须手动 `unlock()`（放 finally）|
| 可中断 | 不支持 | `lockInterruptibly()` 支持 |
| 超时获取 | 不支持 | `tryLock(timeout)` 支持 |
| 公平锁 | 不支持 | `new ReentrantLock(true)` |
| 条件变量 | `wait/notify`（一个 condition）| `newCondition()`（多个 condition）|
| 锁状态可查询 | 不支持 | `isLocked()`、`getQueueLength()` |

```java
ReentrantLock lock = new ReentrantLock();

// 基本使用
lock.lock();
try {
    // 临界区
} finally {
    lock.unlock();  // 必须在 finally 中释放
}

// 超时尝试获取锁
if (lock.tryLock(1, TimeUnit.SECONDS)) {
    try {
        // 获取到锁
    } finally {
        lock.unlock();
    }
} else {
    // 未获取到锁的处理
}

// 多条件变量：分离生产者/消费者等待队列
Condition notFull = lock.newCondition();
Condition notEmpty = lock.newCondition();
```

---

### AQS（AbstractQueuedSynchronizer）

AQS 是 JUC 中 `ReentrantLock`、`CountDownLatch`、`Semaphore` 等同步工具的底层框架。

**核心结构：**
```
AQS
├── state（volatile int）        ← 同步状态，含义由子类定义
│     ReentrantLock: 0=未锁, n=重入次数
│     Semaphore: 剩余许可数
│     CountDownLatch: 剩余计数
└── CLH 等待队列（双向链表）       ← 获取锁失败的线程在此排队
      Node.EXCLUSIVE (独占模式)
      Node.SHARED    (共享模式)
```

**核心方法（子类实现）：**
- `tryAcquire(int)`：尝试独占获取
- `tryRelease(int)`：尝试独占释放
- `tryAcquireShared(int)`：尝试共享获取
- `tryReleaseShared(int)`：尝试共享释放

---

### CountDownLatch / CyclicBarrier / Semaphore

```java
// CountDownLatch：一个线程等待多个线程完成
CountDownLatch latch = new CountDownLatch(3);

for (int i = 0; i < 3; i++) {
    executor.submit(() -> {
        doWork();
        latch.countDown();  // 每完成一个任务，计数 -1
    });
}
latch.await();  // 等待计数降为 0
// 注意：CountDownLatch 不可重置，用完即废
```

```java
// CyclicBarrier：多个线程互相等待，到达屏障后一起继续
CyclicBarrier barrier = new CyclicBarrier(3, () -> {
    log.info("所有线程到达屏障，开始下一阶段");  // 所有线程到达时执行
});

for (int i = 0; i < 3; i++) {
    executor.submit(() -> {
        prepareData();
        barrier.await();  // 等待其他线程
        processData();    // 所有线程同时开始
    });
}
// CyclicBarrier 可复用（reset），适合多轮迭代
```

```java
// Semaphore：控制并发访问数量（资源池限流）
Semaphore semaphore = new Semaphore(5);  // 最多 5 个并发

executor.submit(() -> {
    semaphore.acquire();  // 获取许可（阻塞直到有可用）
    try {
        accessDatabase();
    } finally {
        semaphore.release();  // 释放许可
    }
});
```

| 工具 | 计数方向 | 是否可重置 | 典型场景 |
|------|---------|-----------|---------|
| `CountDownLatch` | 递减到 0 触发 | 否 | 等待多个初始化任务完成 |
| `CyclicBarrier` | 递增到阈值触发 | 是 | 多线程分阶段协调执行 |
| `Semaphore` | 限制并发数 | — | 资源池、并发连接限制 |

---

## 三、JUC - Fork/Join

### Fork/Join 工作窃取算法

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

---

## 四、JUC - CompletableFuture

### 基本使用

```java
// 异步执行，无返回值
CompletableFuture<Void> f1 = CompletableFuture.runAsync(() -> doWork(), executor);

// 异步执行，有返回值
CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> fetchData(), executor);

// 链式处理
CompletableFuture<String> result = CompletableFuture
    .supplyAsync(() -> fetchUser(userId))          // 异步获取用户
    .thenApply(user -> enrichUser(user))           // 同步转换（在完成线程执行）
    .thenApplyAsync(user -> fetchOrders(user), executor)  // 异步转换（切换到指定线程池）
    .thenCompose(orders -> buildResponse(orders)); // 扁平化（返回值本身是 CompletableFuture）

// 异常处理
CompletableFuture<String> safe = result
    .exceptionally(t -> "默认值")                   // 异常时返回默认值
    .handle((val, t) -> t != null ? "错误" : val);  // 统一处理正常和异常
```

### 组合多个任务

```java
// allOf：等待所有任务完成
CompletableFuture<Void> all = CompletableFuture.allOf(f1, f2, f3);
all.join();
// 获取结果需手动调用各 future.join()
List<String> results = List.of(f1.join(), f2.join(), f3.join());

// anyOf：任意一个完成即返回
CompletableFuture<Object> any = CompletableFuture.anyOf(f1, f2, f3);
Object first = any.join();
```

**常见坑：**
- `thenApply/thenRun` 不传 Executor 时，在**触发完成的线程**执行，可能阻塞 ForkJoinPool 公共池
- 生产代码中**务必传自定义线程池**（避免使用 `ForkJoinPool.commonPool()`）
- 链式调用中的异常若不处理，`join()` 会抛出 `CompletionException`

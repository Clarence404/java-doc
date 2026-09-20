# 专项 - JUC 基础

> Java 多线程基础：线程创建方式、Future 异步结果、等待/唤醒机制、线程池（Executors）、ThreadLocal 线程隔离与跨线程传递。

- API 地址：[https://docs.oracle.com/en/java/javase/](https://docs.oracle.com/en/java/javase/)

## 一、线程的创建方式

### 1、继承 Thread 类

```java
class MyThread extends Thread {
    @Override
    public void run() {
        System.out.println(Thread.currentThread().getName() + ": Hello from thread!");
    }

    public static void main(String[] args) {
        new MyThread().start();
    }
}
```

- 优点：简单直观。
- 缺点：Java 单继承限制，继承 Thread 后无法再继承其他类。

### 2、实现 Runnable 接口

```java
class MyRunnable implements Runnable {
    @Override
    public void run() {
        System.out.println(Thread.currentThread().getName() + ": Hello from Runnable!");
    }

    public static void main(String[] args) {
        new Thread(new MyRunnable()).start();
    }
}
```

- 优点：可实现多接口，更灵活，推荐优先使用。

### 3、实现 Callable 接口（带返回值）

`Callable` 是 Java 5 引入的功能性接口，支持**返回结果**和**抛出受检异常**，需与 `Future`、`ExecutorService` 搭配使用。

```java
class MyCallable implements Callable<String> {
    @Override
    public String call() throws Exception {
        Thread.sleep(1000);
        return "Hello from Callable";
    }
}
```

## 二、Future 接口（异步结果）

`Future` 表示一个**异步计算的结果**，可获取结果、检查状态或取消任务。

```java
ExecutorService executor = Executors.newSingleThreadExecutor();

Future<String> future = executor.submit(() -> {
    Thread.sleep(1000);
    return "Callable task completed";
});

System.out.println("Main thread doing other things...");

String result = future.get(); // 阻塞直到任务完成
System.out.println("Task result: " + result);

executor.shutdown();
```

| 方法 | 描述 |
|------|------|
| `get()` | 阻塞等待任务完成并返回结果 |
| `get(timeout, unit)` | 超时等待，超时抛 `TimeoutException` |
| `isDone()` | 任务是否已完成 |
| `cancel(true)` | 尝试取消任务（true 则中断运行中的线程） |
| `isCancelled()` | 任务是否已取消 |

## 三、线程的等待与唤醒机制

### 1、Object.wait() / notify() / notifyAll()

只能在 `synchronized` 块内调用，否则抛 `IllegalMonitorStateException`。

```java
synchronized (lock) {
    while (!condition) {
        lock.wait();   // 释放锁，进入等待队列
    }
    // 条件满足后执行
    lock.notify();     // 唤醒一个等待线程
}
```

### 2、Thread.sleep()

使当前线程进入睡眠，**不释放锁**，用于定时等待和限流。

```java
Thread.sleep(1000); // 休眠 1 秒
```

### 3、Condition.await() / signal()

与 `ReentrantLock` 配合，功能类似 `wait/notify`，支持**一个锁对应多个条件变量**：

```java
Lock lock = new ReentrantLock();
Condition condition = lock.newCondition();

lock.lock();
try {
    while (!conditionSatisfied) {
        condition.await();   // 释放锁，等待
    }
    condition.signal();      // 唤醒一个等待线程
} finally {
    lock.unlock();
}
```

### 4、LockSupport.park() / unpark()

更底层的线程阻塞工具，AQS 内部使用。不依赖锁，支持先 `unpark()` 后 `park()` 不丢信号。

```java
LockSupport.park();           // 阻塞当前线程
LockSupport.unpark(thread);   // 唤醒指定线程
```

### 5、对比

| 机制 | 是否释放锁 | 是否依赖锁 | 唤醒粒度 | 应用场景 |
|------|-------|-----------|--------|--------|
| `wait/notify` | 是 | 是（synchronized） | 不可控 | 经典线程协作 |
| `sleep` | 否 | 否 | 无需唤醒 | 定时等待 |
| `Condition` | 是 | 是（Lock） | 可控 | 精细并发控制 |
| `LockSupport` | 否 | 否 | 精确（线程级） | 高级并发工具 |

## 四、线程池基础（Executors）

`Executors` 工具类提供常用线程池的快捷创建方式：

```java
// 固定大小，适合负载稳定的场景
ExecutorService fixed = Executors.newFixedThreadPool(5);

// 可缓存，空闲线程自动回收（适合短时大量任务）
ExecutorService cached = Executors.newCachedThreadPool();

// 单线程，任务按序执行
ExecutorService single = Executors.newSingleThreadExecutor();

// 定时/周期任务
ScheduledExecutorService scheduled = Executors.newScheduledThreadPool(5);

// 工作窃取（ForkJoinPool 实现）
ExecutorService workStealing = Executors.newWorkStealingPool();
```

**为何不建议直接用 Executors？**

- `FixedThreadPool` / `SingleThreadPool`：队列为无界 `LinkedBlockingQueue`（容量 `Integer.MAX_VALUE`），大量请求时可能 OOM。
- `CachedThreadPool`：线程数无上限，可能创建大量线程导致 OOM。

> 生产环境建议直接使用 <RouteLink to="/high-con/1_thread_pool">ThreadPoolExecutor</RouteLink> 手动指定核心线程数、最大线程数和队列容量。

**invokeAll / invokeAny：**

```java
List<Callable<Integer>> tasks = List.of(() -> 1, () -> 2);

// 等待所有任务完成
List<Future<Integer>> results = executor.invokeAll(tasks);

// 等待任意一个完成，返回第一个结果
Integer first = executor.invokeAny(tasks);
```

## 五、ThreadLocal

`ThreadLocal` 为每个线程维护**独立的变量副本**，线程间互不干扰，常用于保存数据库连接、用户上下文等线程级数据。

### 底层原理

![img_5.png](../assets/java/threadlocal_usage.png)

### 内部结构

![img_5.png](../assets/java/threadlocal_structure.png)

### 示例

```java
private static ThreadLocal<Integer> threadLocalValue = ThreadLocal.withInitial(() -> 0);

Runnable task = () -> {
    int val = threadLocalValue.get();
    threadLocalValue.set(val + 1);
    System.out.println(Thread.currentThread().getName() + " → " + threadLocalValue.get());
    threadLocalValue.remove(); // 线程池场景必须手动清理，防止内存泄漏
};

new Thread(task).start(); // Thread-0 → 1
new Thread(task).start(); // Thread-1 → 1（各自独立）
```

> ⚠️ 在线程池中使用 ThreadLocal 必须在任务结束时调用 `remove()`，否则复用的线程会携带上一次任务的残留值。

## 六、TransmittableThreadLocal（TTL）

标准 `ThreadLocal` 在线程池中会丢失父线程的值（因为线程复用）。`TransmittableThreadLocal`（Alibaba TTL 库）解决了这一问题，**支持跨线程传递**。

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>transmittable-thread-local</artifactId>
    <version>2.14.x</version>
</dependency>
```

```java
private static TransmittableThreadLocal<Integer> ttl = new TransmittableThreadLocal<>();

ttl.set(10); // 主线程设置值

Runnable task = TtlRunnable.get(() -> {
    System.out.println(Thread.currentThread().getName() + " → " + ttl.get()); // 10
});

ExecutorService executor = TtlExecutors.getTtlExecutorService(Executors.newFixedThreadPool(2));
executor.submit(task);
```

| 特性 | ThreadLocal | TransmittableThreadLocal |
|------|-------------|--------------------------|
| 线程隔离 | ✅ | ✅ |
| 跨线程传递（线程池） | ❌ | ✅ |
| 适用场景 | 单线程局部存储 | 异步/线程池上下文传递 |
| 来源 | Java 标准库 | Alibaba TTL（第三方） |

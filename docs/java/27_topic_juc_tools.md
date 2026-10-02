---
description: CountDownLatch、CyclicBarrier、Semaphore
---

# 同步工具类

> `CountDownLatch`、`CyclicBarrier`、`Semaphore` 都基于 [AQS](./25_topic_lock.md#二、abstractqueuedsynchronizer-aqs) 实现，用于多线程之间的协调与限流。

## 一、CountDownLatch

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

## 二、CyclicBarrier

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

## 三、Semaphore

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

## 四、对比

| 工具 | 计数方向 | 是否可重置 | 典型场景 |
|------|---------|-----------|---------|
| `CountDownLatch` | 递减到 0 触发 | 否 | 等待多个初始化任务完成 |
| `CyclicBarrier` | 递增到阈值触发 | 是 | 多线程分阶段协调执行 |
| `Semaphore` | 限制并发数 | — | 资源池、并发连接限制 |

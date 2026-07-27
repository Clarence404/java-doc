# 面试高频题

> 汇总高并发方向的核心面试问题，完整解答见 <RouteLink to="/interview/8_concurrent">开发总结-高并发</RouteLink>

## 一、线程池

- **线程池的核心参数有哪些？执行流程是什么？**
- **线程数如何设置？CPU 密集型和 IO 密集型有何不同？**
- **有哪几种拒绝策略？`CallerRunsPolicy` 的作用是什么？**
- **为什么禁止使用 `Executors` 工厂方法？**  
  → 详见 <RouteLink to="/high-con/1_thread_pool">线程池</RouteLink>

## 二、JUC 并发工具

- **`synchronized` 和 `ReentrantLock` 的区别？**
- **`synchronized` 的锁升级过程（偏向锁 → 轻量级锁 → 重量级锁）？**
- **`volatile` 关键字的作用？为什么不能保证原子性？**
- **CAS 是什么？ABA 问题如何解决？**
- **`ConcurrentHashMap` 在 JDK 7 和 JDK 8 中有何不同？**
- **`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别和应用场景？**

## 三、并发问题

- **死锁的四个必要条件是什么？如何预防和排查？**
- **`jstack` 如何排查死锁？**
- **活锁和线程饥饿的区别？如何解决？**

## 四、高并发设计

- **缓存穿透、缓存击穿、缓存雪崩分别是什么？如何解决？**
- **读多写少的场景如何设计？（CDN + 多级缓存 + 读写分离）**
- **写多的场景如何设计？（MQ 削峰 + 异步处理）**
- **如何压测一个高并发系统？关注哪些核心指标？**  
  → 详见 <RouteLink to="/high-con/4_stress_test">压测</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/8_concurrent">开发总结-高并发</RouteLink>
:::

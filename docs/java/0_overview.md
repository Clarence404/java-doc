# Java 知识体系

> Java 后端技术知识体系文档站——从语言核心到并发、JVM、生态框架的完整覆盖。
> 学习路径：语言机制 → IO/集合 → 并发 → 框架应用 → 高频面试题。

- API 文档：[https://docs.oracle.com/en/java/javase/](https://docs.oracle.com/en/java/javase/)
- 源码仓库：[https://github.com/openjdk](https://github.com/openjdk)

---

## 综合文档

| 文档 | 说明 |
|------|------|
| [Java 高级特性](./1_advanced.md) | 泛型、Lambda/Stream API、反射、注解与元编程 |
| [版本演进（JDK 8–27）](./2_version.md) | 各版本核心新特性，含 Java 21/25 LTS |
| [效率工具库](./98_dev_tool.md) | Lombok、MapStruct、Hutool、Guava（IDE 与软件工具见 [工程效率](/engineering/2_dev_tools)） |

---

## 专题：语言机制

| 文档 | 说明 |
|------|------|
| [异常机制](./10_topic_exception.md) | 受检/非受检异常、自定义异常、最佳实践 |
| [字符串](./11_topic_string.md) | String 不可变原理、字符串池、StringBuilder 内部实现 |
| [枚举（Enum）](./12_topic_enum.md) | 枚举单例（防反射破坏）、EnumSet/EnumMap、switch 穷举 |
| [内部类](./13_topic_inner_class.md) | 4 种内部类、Lambda vs 匿名类、内存泄漏与 WeakReference |
| [泛型（Generics）](./14_topic_generics.md) | 类型擦除规则、通配符、PECS 原则、TypeToken |
| [反射（Reflection）](./15_topic_reflection.md) | Class 对象获取、MethodHandle 优化、Java 9+ 模块系统限制 |
| [动态代理](./16_topic_proxy.md) | JDK Proxy vs CGLIB，InvocationHandler，字节码生成 |

---

## 专题：IO 与数据

| 文档 | 说明 |
|------|------|
| [时间 API](./17_topic_time.md) | Date/Calendar 痛点 → java.time 完整迁移指南 |
| [IO / NIO API](./18_topic_io.md) | 字节流/字符流、Channel、Buffer、Selector、零拷贝（OS 层 IO 模型见 [Netty](/netty/1_io_model)） |
| [序列化](./19_topic_serialization.md) | Serializable、Externalizable、JSON 序列化对比 |
| [SPI 机制](./20_topic_spi.md) | ServiceLoader、双亲委派扩展点、Spring 的 SPI 变体 |
| [集合框架](./21_topic_collection.md) | List/Set/Queue、HashMap/ConcurrentHashMap/TreeMap 原理、线程安全选型 |

---

## 专题：并发

| 文档 | 说明 |
|------|------|
| [JMM 内存模型](./22_topic_jmm.md) | 主内存/工作内存、三大特性、happens-before、volatile 内存屏障、DCL |
| [线程基础](./23_topic_thread_basics.md) | 线程创建、Future、等待/唤醒机制、Executors、ThreadLocal、TTL |
| [synchronized 详解](./24_topic_synchronized.md) | Monitor 对象、偏向锁/轻量锁/重量锁升级路径 |
| [Lock 锁](./25_topic_lock.md) | AQS 原理、ReentrantLock、ReadWriteLock/StampedLock |
| [Atomic 原子类](./26_topic_atomic.md) | CAS、ABA 问题、LongAdder |
| [并发工具类](./27_topic_juc_tools.md) | CountDownLatch、CyclicBarrier、Semaphore |
| [线程池](./28_topic_thread_pool.md) | ThreadPoolExecutor 参数与执行流程、队列、拒绝策略、Fork/Join |
| [CompletableFuture](./29_topic_completable_future.md) | 异步编排、任务组合、异常处理与常见坑 |

> 线程数设置、压测、Profiler 等系统级内容见 [高并发](/high-con/0_overview)。

---

## 面试总结

| 文档 | 说明 |
|------|------|
| [Java 高频面试题](./99_interview.md) | 覆盖集合、并发、JVM、Spring 等方向高频问题汇总 |

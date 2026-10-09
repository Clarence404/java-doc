# Java 总览

本模块覆盖 Java 语言本身：语言机制（异常、字符串、枚举、内部类、泛型、反射、代理）、IO 与数据（时间、IO / NIO、序列化、SPI、集合）、并发编程（JMM、线程、锁、原子类、同步工具、线程池、CompletableFuture、虚拟线程）以及各版本新特性。JVM 内部原理与 Spring 等框架在各自模块展开，这里只在需要时一句话带过并给出链接。

版本基线：**JDK 21 / 25 LTS**，与 JDK 8 / 17 行为不同的地方在文中单独标出。

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

按侧边栏分组顺序阅读，每篇末尾的「下一篇」串起整条链路。

**综合（1–2）**

1. [Lambda、Stream 与注解](./1_advanced)：Lambda 的 `invokedynamic` 实现、Stream 求值模型与并行流、Optional 规范、注解处理器
2. [版本演进](./2_version)：JDK 8 到 27 的关键特性、预览到正式的路线、升级坑点与版本选型

**语言机制（10–16）**

3. [异常体系](./10_topic_exception)：受检与非受检异常的设计与生产中的处理规范
4. [String](./11_topic_string)：不可变性、常量池、拼接的编译优化
5. [枚举](./12_topic_enum)：枚举的本质、常用模式与枚举单例
6. [内部类](./13_topic_inner_class)：静态嵌套类、内部类、局部类与匿名类
7. [泛型](./14_topic_generics)：类型擦除、通配符与 PECS
8. [反射](./15_topic_reflection)：Class 对象、反射调用、MethodHandle 与模块封装
9. [动态代理](./16_topic_proxy)：JDK 代理与 CGLIB / ByteBuddy

**IO 与数据（17–21）**

10. [日期与时间](./17_topic_time)：`java.time` 体系与时区处理
11. [IO 与 NIO](./18_topic_io)：流体系、Buffer / Channel / Selector、零拷贝
12. [序列化](./19_topic_serialization)：JDK 序列化机制、风险与替代方案
13. [SPI 机制](./20_topic_spi)：`ServiceLoader` 与 JDBC / Spring Boot / Dubbo 的扩展机制
14. [集合框架](./21_topic_collection)：HashMap、ConcurrentHashMap 等核心集合的实现

**并发（22–30）**

15. [JMM 内存模型](./22_topic_jmm)：可见性、有序性、happens-before 与 volatile
16. [线程基础](./23_topic_thread_basics)：线程状态、中断、ThreadLocal
17. [synchronized](./24_topic_synchronized)：对象头、锁状态与 JDK 15 / 23 之后的变化
18. [显式锁（Lock）](./25_topic_lock)：AQS、ReentrantLock、读写锁
19. [原子类（Atomic）](./26_topic_atomic)：CAS、ABA、LongAdder
20. [同步工具类](./27_topic_juc_tools)：CountDownLatch、CyclicBarrier、Semaphore 等
21. [线程池](./28_topic_thread_pool)：ThreadPoolExecutor 参数、拒绝策略与生产配置
22. [CompletableFuture](./29_topic_completable_future)：异步编排与线程池选择
23. [虚拟线程](./30_topic_virtual_thread)：调度模型、pinning 与使用边界

**附录（98）**

24. [效率工具库](./98_dev_tool)：Lombok、MapStruct、Hutool、Guava 的用法、坑点与 JDK 内置替代

[高频面试题](./99_interview) 只列题目，答案在 [Java 面试题解答](/interview/1_java) 与 [Java 并发面试题解答](/interview/2_concurrent)。

---

## 三、关联模块

- [JVM 总览](/jvm/0_overview)：内存结构、类加载、GC、JIT 与调优，本模块涉及运行时原理处都链接到这里
- [Netty · IO 模型](/netty/1_io_model)：BIO / NIO / 多路复用与 epoll 原理
- [高性能 · 性能分析工具](/high-perf/3_profilers)：Profiler、JFR、火焰图；基准测试见 [基准测试（JMH）](/high-perf/4_benchmark)
- [高并发 · 并发参数调优](/high-con/7_concurrency_tuning)：线程数、连接池等系统级参数的设定方法
- [高性能 · 池化技术](/high-perf/7_pooling)：线程池、连接池的池化原理与取舍
- [Spring Boot · 异步任务与定时任务](/spring-boot/9_async_schedule)：在 Spring Boot 中使用线程池与虚拟线程
- [设计模式总览](/patterns/0_overview)：单例、代理等模式的完整实现
- [Java 面试题解答](/interview/1_java) / [Java 并发面试题解答](/interview/2_concurrent)：本模块高频问题的答案汇总

## 参考资料

- Java SE API 文档：[https://docs.oracle.com/en/java/javase/](https://docs.oracle.com/en/java/javase/)
- Java 语言规范（JLS）：[https://docs.oracle.com/javase/specs/](https://docs.oracle.com/javase/specs/)
- OpenJDK：[https://openjdk.org/](https://openjdk.org/)

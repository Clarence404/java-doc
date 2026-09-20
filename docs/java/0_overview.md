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
| [开发工具](./98_dev_tool.md) | IDE、构建工具、调试与诊断技巧 |

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
| [IO 模型](./18_topic_io.md) | BIO/NIO/AIO，Channel、Buffer、Selector |
| [序列化](./19_topic_serialization.md) | Serializable、Externalizable、JSON 序列化对比 |
| [SPI 机制](./20_topic_spi.md) | ServiceLoader、双亲委派扩展点、Spring 的 SPI 变体 |
| [集合框架](./21_topic_collection.md) | List/Set/Map 核心结构、线程安全选型、Iterator |

---

## 专题：并发

| 文档 | 说明 |
|------|------|
| [JMM 内存模型](./22_topic_jmm.md) | 主内存/工作内存、happens-before 八条规则、volatile 内存屏障 |
| [锁机制](./23_topic_lock.md) | synchronized/ReentrantLock/ReadWriteLock/AQS 原理 |
| [synchronized 详解](./24_topic_synchronized.md) | Monitor 对象、偏向锁/轻量锁/重量锁升级路径 |
| [线程基础](./25_topic_thread_basics.md) | 线程创建、Future、Executors、ThreadLocal、TTL |

---

## 面试总结

| 文档 | 说明 |
|------|------|
| [Java 高频面试题](./99_interview.md) | 覆盖集合、并发、JVM、Spring 等方向高频问题汇总 |

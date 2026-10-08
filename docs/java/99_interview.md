---
description: 综合与版本、语言机制、IO 与数据、并发四组高频题目清单
---

# 面试高频题

> 汇总 Java 语言与并发方向的高频面试问题，分组与侧边栏一致。「综合与版本」「语言机制」「IO 与数据」三组的解答见 <RouteLink to="/interview/1_java">开发总结 - Java</RouteLink>，「并发」一组的解答见 <RouteLink to="/interview/2_concurrent">开发总结 - Java 并发</RouteLink>。
>
> 类加载过程、双亲委派、父子类初始化顺序属于 JVM 方向，见 <RouteLink to="/jvm/99_interview">JVM 面试题</RouteLink>；Servlet 生命周期见 <RouteLink to="/spring/99_interview">Spring 面试题</RouteLink>。

## 一、综合与版本

- **`==` 和 `equals()` 的区别？为什么重写 `equals` 必须重写 `hashCode`？`Integer.valueOf(127) == Integer.valueOf(127)` 为什么是 true？**
- **抽象类和接口的区别？Java 为什么不支持类的多继承，接口默认方法冲突怎么解决？**
- **Lambda 的底层原理是什么？和匿名内部类有什么区别？为什么只能捕获 effectively final 的局部变量？**
- **Stream 的惰性求值是什么？有状态 / 无状态 / 短路操作有哪些？`Collectors.toMap` 有哪些坑？`Stream.toList()` 与 `Collectors.toList()` 有什么区别？**
- **并行流用的是哪个线程池？默认并行度是多少？为什么不能在并行流里做阻塞 IO？**
- **Optional 的正确用法？`orElse` 和 `orElseGet` 有什么区别？**
- **`@Retention` 三种策略有什么区别？注解处理器的原理是什么？Lombok 为什么特殊，JDK 23 之后为什么可能失效？与 MapStruct 同用要注意什么？**
- **Java 8 → 11 → 17 → 21 升级分别会遇到哪些兼容问题？**
- **JDK 21 和 JDK 25 各有哪些重要新特性？哪些仍是预览？record、sealed 与 switch 模式匹配配合解决什么问题？**
- **单例模式有几种写法？DCL 为什么要加 volatile？推荐哪种？**
- **`Arrays.sort()` 底层用的什么算法？对基本类型和对象有何不同？**  
  → 详见 <RouteLink to="/java/1_advanced">Lambda、Stream 与注解</RouteLink>、<RouteLink to="/java/2_version">版本演进</RouteLink>、<RouteLink to="/java/98_dev_tool">效率工具库</RouteLink>、<RouteLink to="/patterns/1_creational_singleton">单例模式</RouteLink>

## 二、语言机制

- **Error 和 Exception 的区别？受检与非受检异常如何判定？为什么业务异常通常继承 RuntimeException？异常的开销在哪？**
- **finally 一定会执行吗？finally 里 return 会怎样？try-with-resources 中 `close()` 抛出的异常去哪了？**
- **String 为什么不可变？JDK 9 之后底层结构和 `+` 拼接有什么变化？循环里为什么还要用 StringBuilder？**
- **`new String("abc")` 创建了几个对象？什么情况下 `==` 比较字符串为 true？`intern()` 有什么风险？**
- **枚举的本质是什么？一定是 final 吗？为什么枚举单例能防反射和序列化破坏？`ordinal()` 能持久化吗？**
- **静态嵌套类和内部类的区别？内部类 / 匿名类为什么会导致内存泄漏？**
- **泛型的类型擦除是什么？擦除后为什么还能在运行时拿到 `List<User>` 的泛型类型？什么是桥方法？**
- **`List<? extends Number>` 为什么不能 add？PECS 是什么？为什么不能创建泛型数组？**
- **反射有哪些典型应用？`getMethods()` 与 `getDeclaredMethods()`、`Class.forName` 与 `ClassLoader.loadClass` 有什么区别？**
- **反射为什么慢？JDK 18 之后实现有什么变化？JDK 17 之后反射访问 JDK 内部类报 `InaccessibleObjectException` 怎么处理？**
- **JDK 动态代理和 CGLIB 的区别？Spring / Spring Boot 默认用哪种？CGLIB 的 `invoke` 与 `invokeSuper` 有什么区别？**  
  → 详见 <RouteLink to="/java/10_topic_exception">异常体系</RouteLink>、<RouteLink to="/java/11_topic_string">String</RouteLink>、<RouteLink to="/java/12_topic_enum">枚举</RouteLink>、<RouteLink to="/java/13_topic_inner_class">内部类</RouteLink>、<RouteLink to="/java/14_topic_generics">泛型</RouteLink>、<RouteLink to="/java/15_topic_reflection">反射</RouteLink>、<RouteLink to="/java/16_topic_proxy">动态代理</RouteLink>

## 三、IO 与数据

- **`SimpleDateFormat` 为什么线程不安全？`LocalDateTime`、`OffsetDateTime`、`ZonedDateTime`、`Instant` 有什么区别？**
- **数据库里时间该怎么存？MySQL `DATETIME` 与 `TIMESTAMP` 有什么区别？夏令时会带来什么问题？**
- **Java IO 流有哪些分类？BIO / NIO / AIO 的区别？有了虚拟线程还需要 NIO / Netty 吗？**
- **零拷贝的原理？`transferTo` 与 `mmap` 各有什么限制？直接缓冲区的代价是什么？**
- **序列化的作用？`serialVersionUID` 有什么用？类新增 / 删除字段后反序列化会怎样？**
- **反序列化漏洞的原理？如何用 `ObjectInputFilter` 防护？序列化方案怎么选？**
- **SPI 是什么，与 API 有何区别？SPI 如何「打破」双亲委派？Dubbo SPI 和 Spring Boot 自动配置做了哪些增强？**
- **HashMap 的 put 流程？hash 为什么要 `h ^ (h >>> 16)`？容量为什么是 2 的幂？哈希冲突有哪些解决方式？**
- **HashMap 何时树化、何时退化？扩容时元素如何迁移？JDK 7 并发扩容为什么会死循环？**
- **ArrayList 的扩容机制？ArrayList 与 LinkedList 怎么选？fail-fast 与弱一致迭代器有什么区别？**
- **`List.of`、`Arrays.asList`、`Collections.unmodifiableList` 有什么区别？JDK 21 Sequenced Collections 解决了什么问题？**
- **如何用 LinkedHashMap 实现 LRU？TreeSet / TreeMap 为什么可能「丢」元素？**  
  → 详见 <RouteLink to="/java/17_topic_time">日期与时间</RouteLink>、<RouteLink to="/java/18_topic_io">IO 与 NIO</RouteLink>、<RouteLink to="/java/19_topic_serialization">序列化</RouteLink>、<RouteLink to="/java/20_topic_spi">SPI 机制</RouteLink>、<RouteLink to="/java/21_topic_collection">集合框架</RouteLink>

## 四、并发

- **Java 线程有哪 6 种状态？BLOCKED 和 WAITING 的区别？`wait()` 为什么必须在 while 循环里调用？**
- **如何正确停止一个线程？捕获 InterruptedException 后应该怎么处理？**
- **volatile 的作用？为什么不能保证原子性？为什么普通 boolean 标志位的循环可能永远不退出？**
- **synchronized 的锁升级过程是怎样的？JDK 15 / 18 / 23 之后有什么变化？**
- **synchronized 和 ReentrantLock 的区别？虚拟线程下应该用哪个？**
- **AQS 的原理？等待线程是自旋还是挂起？ReentrantLock 的可重入与公平锁如何实现？**
- **读写锁能否升级 / 降级？StampedLock 的乐观读有哪些限制？**
- **CAS 是什么？有哪些缺点？ABA 问题如何解决？LongAdder 为什么比 AtomicLong 快？**
- **ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？为什么不允许 null？`size()` 精确吗？先 get 再 put 安全吗？**
- **`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别？CyclicBarrier 基于 AQS 吗？Semaphore 能用来限流吗？**
- **ThreadLocal 的原理？为什么会内存泄漏？InheritableThreadLocal 在线程池中为什么失效，跨线程传递上下文怎么做？**
- **线程池的核心参数与任务提交流程？线程如何复用、非核心线程如何回收？**
- **线程池的队列和拒绝策略怎么选？为什么不推荐用 Executors 创建？运行时动态调整参数要注意什么？**
- **`execute` 与 `submit` 的区别？submit 的异常去哪了？`shutdown` 与 `shutdownNow` 有什么区别？**
- **CompletableFuture 的回调由哪个线程执行？不传线程池用的是什么？异常与超时怎么处理？**
- **虚拟线程适合什么场景？为什么不能池化？JDK 24 之后还有哪些情况会钉住载体线程？**
- **ScopedValue 和 ThreadLocal 有什么区别？结构化并发能用于生产吗？**
- **死锁的四个必要条件？如何预防、如何用 jstack 排查？活锁、饥饿与线程池饥饿死锁有什么区别？**  
  → 详见 <RouteLink to="/java/22_topic_jmm">JMM 内存模型</RouteLink>、<RouteLink to="/java/23_topic_thread_basics">线程基础</RouteLink>、<RouteLink to="/java/24_topic_synchronized">synchronized</RouteLink>、<RouteLink to="/java/25_topic_lock">显式锁（Lock）</RouteLink>、<RouteLink to="/java/26_topic_atomic">原子类（Atomic）</RouteLink>、<RouteLink to="/java/27_topic_juc_tools">同步工具类</RouteLink>、<RouteLink to="/java/28_topic_thread_pool">线程池</RouteLink>、<RouteLink to="/java/29_topic_completable_future">CompletableFuture</RouteLink>、<RouteLink to="/java/30_topic_virtual_thread">虚拟线程</RouteLink>

---

::: tip 完整解答
一至三组的解答见 <RouteLink to="/interview/1_java">开发总结 - Java</RouteLink>，第四组「并发」的解答见 <RouteLink to="/interview/2_concurrent">开发总结 - Java 并发</RouteLink>
:::

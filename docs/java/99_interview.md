# 面试高频题

> 汇总 Java 基础与进阶方向的高频面试问题，完整解答见 <RouteLink to="/interview/1_java">开发总结-Java</RouteLink>

## 一、基础类型与对象

- **Java 有哪 8 种基本数据类型？各占多少字节？**
- **String 为什么不可变？能被继承吗？**
- **== 和 equals() 的区别？hashCode() 为什么要一起重写？**
- **Integer 缓存范围是多少？`Integer.valueOf(127) == Integer.valueOf(127)` 为 true 吗？**

## 二、面向对象

- **抽象类和接口的区别？什么时候用抽象类，什么时候用接口？**
- **继承和聚合的区别（is-a vs has-a）？**
- **Java 为什么不支持多继承？接口的默认方法解决了什么问题？**

## 三、类加载与反射

- **说说类的加载机制（加载 → 连接 → 初始化）？**
- **双亲委派模型是什么？为什么需要它？**
- **父类和子类的静态块、构造方法执行顺序是什么？**
- **反射的底层原理？有哪些典型应用场景？**
- **JDK 动态代理和 CGLIB 的区别？**

## 四、并发基础

- **synchronized 和 ReentrantLock 的区别？**
- **synchronized 的锁升级过程（偏向锁 → 轻量级锁 → 重量级锁）？JDK 15 之后偏向锁有什么变化？**  
  → 详见 <RouteLink to="/java/24_topic_synchronized">专项 - synchronized</RouteLink> / <RouteLink to="/java/25_topic_lock">专项 - Lock 锁</RouteLink>
- **volatile 的作用？为什么不能保证原子性？**  
  → 详见 <RouteLink to="/java/22_topic_jmm">专项 - JMM 内存模型</RouteLink>
- **CAS 是什么？ABA 问题如何解决？**  
  → 详见 <RouteLink to="/java/26_topic_atomic">专项 - Atomic 原子类</RouteLink>
- **ConcurrentHashMap 在 JDK 7 和 JDK 8 中有何不同？**  
  → 详见 <RouteLink to="/java/21_topic_collection">专项 - 集合框架</RouteLink>
- **`CountDownLatch`、`CyclicBarrier`、`Semaphore` 的区别和应用场景？**  
  → 详见 <RouteLink to="/java/27_topic_juc_tools">专项 - 并发工具类</RouteLink>
- **死锁的四个必要条件是什么？如何预防？**
- **如何用 `jstack` 排查死锁？**
- **活锁和线程饥饿的区别？如何解决？**  
  → 完整解答见 <RouteLink to="/interview/9_concurrent">开发总结-Java 并发</RouteLink>

## 五、泛型与函数式

- **泛型的类型擦除是什么？T、E、K、V、? 各代表什么？**
- **Lambda 表达式的底层原理（invokedynamic + LambdaMetafactory）？**
- **Stream 流的中间操作和终端操作有哪些？parallel stream 底层用的什么？**

## 六、IO 与序列化

- **BIO / NIO / AIO 的区别？**  
  → 详见 <RouteLink to="/java/18_topic_io">IO 专题</RouteLink>
- **序列化的作用？serialVersionUID 有什么用？**  
  → 详见 <RouteLink to="/java/19_topic_serialization">序列化专题</RouteLink>
- **Java 有哪几种 IO 流分类方式（字节流/字符流、输入流/输出流）？**

## 七、其他高频

- **单例模式有几种写法？DCL 为什么要加 volatile？**
- **如何解决哈希冲突？链式哈希和开放地址法的区别？**
- **Servlet 的生命周期（加载 → 初始化 → 请求处理 → 销毁）？**
- **`Arrays.sort()` 底层用的什么算法？对基本类型和对象有何不同？**

---

::: tip 完整解答
以上问题的详细解答（含代码示例）见 <RouteLink to="/interview/1_java">开发总结-Java</RouteLink>
:::

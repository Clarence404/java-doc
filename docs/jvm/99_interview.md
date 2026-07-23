# JVM 面试高频题

> 汇总 JVM 核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/3_jvm">开发总结-JVM</RouteLink>

## 一、内存结构

- **JVM 的运行流程是什么？（类加载 → 运行时数据区 → 执行引擎）**
- **JVM 内存区域有哪些？各区域的作用是什么？**
- **堆和栈的区别？方法区在 JDK 8 后有什么变化？（永久代 → 元空间）**
- **什么是内存泄漏？和内存溢出的区别？**
- **OOM 有哪几种类型？各是什么原因？**
- **String 常量池在哪里？JDK 6 和 JDK 7+ 有什么区别？**
- **String.intern() 的作用和使用场景？**  
  → 详见 <RouteLink to="/jvm/0_memory">JVM 内存结构</RouteLink>

## 二、类加载

- **类加载的完整过程（加载 → 验证 → 准备 → 解析 → 初始化）？**
- **双亲委派模型的原理和作用？**
- **如何打破双亲委派？（SPI、Tomcat 类加载器、OSGi）**
- **类的初始化时机有哪些？（主动引用 vs 被动引用）**  
  → 详见 <RouteLink to="/jvm/1_class_loading">类加载</RouteLink>

## 三、垃圾回收

- **如何判断对象是否可以被回收？（引用计数 vs 可达性分析）**
- **有哪些 GC 根（GC Root）？**
- **常见垃圾回收算法有哪些？（标记清除、标记复制、标记压缩）**
- **分代收集的原理是什么？新生代和老年代用的是哪种算法？**
- **Minor GC 和 Full GC 的触发条件是什么？**

## 四、垃圾回收器

- **Serial、Parallel、CMS、G1、ZGC 各有什么特点？**
- **CMS 的垃圾回收过程？它有什么缺点？**
- **G1 的工作原理？Region 是什么？为什么它能预测停顿时间？**
- **ZGC 如何实现低延迟？（着色指针、读屏障）**  
  → 详见 <RouteLink to="/jvm/3_gc">垃圾回收</RouteLink>

## 五、Java 内存模型（JMM）

- **JMM 是什么？解决了什么问题？**
- **happens-before 的 8 条规则是什么？**
- **volatile 能保证原子性吗？适合什么场景？**
- **为什么 DCL 单例需要 volatile？不加会有什么问题？**
- **synchronized 除了互斥，还有什么内存语义？**
- **final 字段的内存语义是什么？**  
  → 详见 <RouteLink to="/jvm/9_jmm">Java 内存模型</RouteLink>

## 六、虚拟线程

- **虚拟线程和平台线程的区别？**
- **虚拟线程的挂载/卸载（mount/unmount）机制是什么？**
- **虚拟线程为什么不适合 CPU 密集型任务？**
- **虚拟线程中使用 synchronized 有什么问题？如何解决？**  
  → 详见 <RouteLink to="/jvm/6_jit">JIT 编译器 - 虚拟线程</RouteLink>

## 七、JVM 调优

- **JVM 常用参数有哪些？（`-Xms`、`-Xmx`、`-Xss`、`-XX:MetaspaceSize`）**
- **如何排查 CPU 100% 问题？（`top` → `jstack`）**
- **如何排查内存溢出问题？（`-XX:+HeapDumpOnOutOfMemoryError`）**
- **如何排查频繁 Full GC？**  
  → 详见 <RouteLink to="/jvm/8_troubleshooting">JVM 故障排查</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/3_jvm">开发总结-JVM</RouteLink>
:::

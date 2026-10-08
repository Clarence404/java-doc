---
description: JVM 方向题目清单
---

# 面试高频题

> 汇总 JVM 核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/3_jvm">开发总结 - JVM</RouteLink>

## 一、内存结构

- **JVM 的运行流程是什么？（类加载 → 运行时数据区 → 执行引擎）**
- **JVM 内存区域有哪些？各区域的作用是什么？**
- **堆和栈的区别？堆和方法区的区别？**
- **方法区在 JDK 8 后有什么变化？为什么用元空间替代永久代？**
- **Java 对象一定在堆上分配吗？**
- **什么是内存泄漏？和内存溢出的区别？**
- **OOM 有哪几种类型？各是什么原因？**
- **String 常量池在哪里？JDK 6 和 JDK 7+ 有什么区别？**
- **String.intern() 的作用和使用场景？**  
  → 详见 <RouteLink to="/jvm/1_memory">内存结构</RouteLink>

## 二、类加载

- **类加载的完整过程（加载 → 验证 → 准备 → 解析 → 初始化）？**
- **双亲委派模型的原理和作用？**
- **如何打破双亲委派？（SPI、Tomcat 类加载器、OSGi）为什么 Tomcat 要打破？**
- **类的初始化时机有哪些？（主动引用 vs 被动引用）**
- **如何判断两个类是否相同？**
- **`static final` 常量为什么在准备阶段就能赋值？**  
  → 详见 <RouteLink to="/jvm/2_class_loading">类加载机制</RouteLink>

## 三、字节码执行

- **JVM 字节码是基于栈还是基于寄存器执行的？**
- **`i++` 和 `++i` 的字节码有什么区别？**
- **Lambda 为什么用 `invokedynamic` 实现，而不是编译成匿名内部类？**  
  → 详见 <RouteLink to="/jvm/3_bytecode">字节码执行</RouteLink>

## 四、垃圾回收

- **如何判断对象是否可以被回收？（引用计数 vs 可达性分析）**
- **有哪些 GC Roots？为什么它们可以作为根？**
- **常见垃圾回收算法有哪些？（标记清除、标记复制、标记整理）**
- **分代收集的原理是什么？新生代和老年代用的是哪种算法？**
- **Minor GC、Major GC 和 Full GC 的区别与触发条件？**
- **Minor GC 需要扫描整个老年代吗？跨代引用怎么处理？**
- **什么是三色标记？并发标记为什么会漏标，CMS 和 G1 分别怎么解决？**
- **`System.gc()` 一定会触发 Full GC 吗？`-XX:+DisableExplicitGC` 有什么影响？**  
  → 详见 <RouteLink to="/jvm/4_gc_theory">GC 原理</RouteLink>

## 五、垃圾收集器

- **Serial、Parallel、CMS、G1、ZGC 各有什么特点？**
- **CMS 的垃圾回收过程？它有什么缺点？（浮动垃圾、碎片、Concurrent Mode Failure）**
- **G1 的工作原理？Region 是什么？为什么它能预测停顿时间？**
- **ZGC 如何实现低延迟？（着色指针、读屏障）**
- **什么是分代 ZGC？各 JDK 版本如何启用？**  
  → 详见 <RouteLink to="/jvm/5_gc_collectors">GC 收集器</RouteLink>

## 六、JIT 编译

- **为什么 Java 程序刚启动时慢，运行一段时间后变快？分层编译是怎样的？**
- **逃逸分析能保证对象在栈上分配吗？**
- **方法内联有什么好处和代价？**  
  → 详见 <RouteLink to="/jvm/7_jit">JIT 编译</RouteLink>

## 七、JVM 调优与排查

- **JVM 常用参数有哪些？（`-Xms`、`-Xmx`、`-Xss`、`-XX:MaxMetaspaceSize`）**
- **如何确定堆内存大小？`-Xms` 和 `-Xmx` 为什么推荐设成相同？**
- **容器中如何设置 JVM 内存？为什么会被 OOMKilled？**
- **jcmd 和 NMT 能做什么？**
- **如何排查 CPU 100% 问题？（`top -H` → `jstack`）**
- **如何排查内存溢出问题？线上能开 `-XX:+HeapDumpOnOutOfMemoryError` 吗？**
- **如何排查频繁 Full GC？**  
  → 详见 <RouteLink to="/jvm/6_gc_tuning">GC 调优</RouteLink>、<RouteLink to="/jvm/8_monitoring_tools">诊断工具</RouteLink>、<RouteLink to="/jvm/9_troubleshooting">故障排查</RouteLink>

## 八、Java 内存模型（JMM）

- **JMM 是什么？解决了什么问题？**
- **happens-before 的 8 条规则是什么？**
- **volatile 能保证原子性吗？适合什么场景？**
- **为什么 DCL 单例需要 volatile？不加会有什么问题？**
- **synchronized 除了互斥，还有什么内存语义？**
- **final 字段的内存语义是什么？**  
  → 详见 <RouteLink to="/java/22_topic_jmm">Java JMM 内存模型</RouteLink>

## 九、虚拟线程

- **虚拟线程和平台线程的区别？**
- **虚拟线程的挂载/卸载（mount/unmount）机制是什么？**
- **虚拟线程为什么不适合 CPU 密集型任务？**
- **虚拟线程中使用 synchronized 有什么问题？如何解决？**  
  → 详见 <RouteLink to="/java/30_topic_virtual_thread">虚拟线程</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/3_jvm">开发总结 - JVM</RouteLink>
:::

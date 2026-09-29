# JVM 总览

JVM 模块覆盖运行时内存结构、类加载、字节码与执行引擎、垃圾回收理论与收集器、GC 调优、JIT 编译，以及监控工具与线上故障排查。阅读时建议按“内存与类加载 → 执行引擎 → GC → 调优与排查”的顺序推进。

## 一、模块导航

| 文档 | 覆盖内容 |
|------|----------|
| [JVM 内存结构](./1_memory) | 运行时数据区、对象内存布局、TLAB、分配策略、String 常量池 |
| [类加载机制](./2_class_loading) | 加载过程、类加载器体系、双亲委派及打破方式 |
| [字节码与执行引擎](./3_bytecode) | Class 文件结构、栈帧、常用指令、invokedynamic 与 Lambda |
| [GC 基础理论](./4_gc_theory) | 可达性分析、引用类型、GC 算法、触发时机、STW |
| [垃圾收集器详解](./5_gc_collectors) | Serial / Parallel / CMS / G1 / ZGC / Shenandoah 对比与选型 |
| [GC 调优实践](./6_gc_tuning) | 调优目标、核心参数、G1 / ZGC 调优、GC 日志、常见问题 |
| [JIT 编译器](./7_jit) | 分层编译、逃逸分析与内联、OSR、Code Cache、GraalVM、虚拟线程 |
| [监控工具](./8_monitoring_tools) | jps / jstack / jmap / jstat、MAT、VisualVM、JFR、GC 日志分析 |
| [JVM 故障排查](./9_troubleshooting) | 各类 OOM、StackOverflowError、CPU 飙高、死锁、类加载失败 |
| [面试高频题](./99_interview) | JVM 方向题目清单 |

## 二、推荐阅读路径

1. 先读 [内存结构](./1_memory) 与 [类加载机制](./2_class_loading)，建立 JVM 运行时的基本模型。
2. 再读 [字节码与执行引擎](./3_bytecode)，理解代码是如何被执行的。
3. 然后读 [GC 基础理论](./4_gc_theory) 与 [垃圾收集器详解](./5_gc_collectors)，掌握回收机制与收集器选型。
4. 接着读 [GC 调优实践](./6_gc_tuning) 与 [JIT 编译器](./7_jit)，面向性能做参数调整。
5. 最后读 [监控工具](./8_monitoring_tools) 与 [故障排查](./9_troubleshooting)，具备线上问题定位能力。

## 三、关联模块

- Java 内存模型（JMM、happens-before、volatile）→ [Java 专项 - JMM](/java/22_topic_jmm)
- Arthas 在线诊断 → [工程效率 - 线上诊断](/engineering/4_diagnosis)
- 性能分析方法论与 Profiler → [高性能](/high-perf/0_overview)

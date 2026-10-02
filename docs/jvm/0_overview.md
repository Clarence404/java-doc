# JVM 总览

JVM 模块覆盖运行时内存结构、类加载、字节码执行、GC 原理与收集器、GC 调优、JIT 编译，以及诊断工具与线上故障排查。以 JDK 21 LTS 为基准视角，兼顾 JDK 8 / 17 与 25 的差异。阅读时建议按“内存与类加载 → 执行引擎 → GC → 调优与排查”的顺序推进。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. 先读 [内存结构](./1_memory) 与 [类加载机制](./2_class_loading)，建立 JVM 运行时的基本模型。
2. 再读 [字节码执行](./3_bytecode)，理解代码是如何被执行的。
3. 然后读 [GC 原理](./4_gc_theory) 与 [GC 收集器](./5_gc_collectors)，掌握回收机制与收集器选型。
4. 接着读 [GC 调优](./6_gc_tuning) 与 [JIT 编译](./7_jit)，面向性能做参数调整。
5. 最后读 [诊断工具](./8_monitoring_tools) 与 [故障排查](./9_troubleshooting)，具备线上问题定位能力。

## 三、关联模块

- Java 内存模型（JMM、happens-before、volatile）→ [专项 - JMM 内存模型](/java/22_topic_jmm)
- 虚拟线程与线程池 → [专项 - 线程池](/java/28_topic_thread_pool)
- 收集器选型、容器内存、JIT 预热等性能策略 → [JVM 层性能策略](/high-perf/5_jvm_tuning)
- 性能分析方法论与 Profiler → [高性能](/high-perf/0_overview)
- Arthas 在线诊断 → [线上诊断](/engineering/4_diagnosis)
- JVM 面试题完整解答 → [开发总结 - JVM](/interview/3_jvm)

---
description: 收集器选型、降低分配速率、堆与容器内存、JIT 预热与冷启动、何时需要 GC 调优
---

# JVM 层性能策略

> 前置阅读：[基准测试（JMH）](./4_benchmark)

本篇从性能目标出发讲 JVM 层的**策略与判断**，以 JDK 25 LTS 为主要视角：选哪个收集器、如何降低分配速率、容器里堆该给多大、如何消除冷启动毛刺，以及什么时候才需要 GC 调优。

---

## 一、按延迟 vs 吞吐选收集器

**收集器选型取决于目标：要稳定的低停顿，还是要最高的吞吐。**

**先记住优先级：先修代码（分配过多、内存泄漏），再选对收集器和堆大小，最后才动细节参数。** 多数服务用默认 G1 加上合理的堆大小就够了。

收集器原理见 [GC 收集器](/jvm/5_gc_collectors)。

| 收集器 | 典型停顿 | 吞吐 | 适用场景 | JDK 25 启用方式 |
|--------|----------|------|----------|----------------|
| G1 | 可设目标（默认 `MaxGCPauseMillis=200`），常见几十毫秒 | 中高 | 通用在线服务，默认首选 | 默认（满足"服务器级机器"条件时） |
| 分代 ZGC | 通常亚毫秒级，与堆大小基本无关 | 中高，并发阶段占用额外 CPU | P99 敏感的在线服务、大堆 | `-XX:+UseZGC`（JDK 24 起只有分代模式） |
| Parallel | 较长，随堆增大 | 最高 | 批处理、离线计算，只看总耗时 | `-XX:+UseParallelGC` |
| Serial | 长 | 低 | 1 核或很小内存的容器、工具进程 | `-XX:+UseSerialGC` |

选型要点：

- **显式指定收集器**：JDK 26 及以前，小规格容器（CPU < 2 或内存 < 1792MB）默认会落到 Serial；默认选择规则与按场景选型见 [GC 收集器 · 选型指南](/jvm/5_gc_collectors#八、选型指南)。
- **ZGC 不是免费的**：并发回收占用额外 CPU、堆要留余量，CPU 已经紧张的服务换 ZGC 前先压测；JDK 23 起只写 `-XX:+UseZGC` 即为分代模式。
- 停顿不是 P99 的主要来源时，换收集器收益有限——先用下文第五节的方法确认。

---

## 二、降低分配速率

**分配速率（每秒新分配的字节数）直接决定 Young GC 的频率，也决定对象过早晋升的压力。** 降低分配速率往往比调任何 GC 参数都有效，且对所有收集器都成立。

### 1、如何测量

| 手段 | 看什么 |
|------|--------|
| GC 日志 | Young GC 间隔与 Eden 大小，估算 `分配速率 ≈ Eden 大小 / Young GC 间隔` |
| async-profiler `-e alloc` | 分配火焰图，定位分配最多的调用栈，见 [性能分析工具](./3_profilers) |
| JFR | `ObjectAllocationSample` 等分配事件，JMC 中按类、按栈聚合 |
| JMH `-prof gc` | `gc.alloc.rate.norm`：每次操作分配的字节数，用于对比不同写法 |

### 2、常见手段

| 手段 | 说明 | 详见 |
|------|------|------|
| 避免装箱 | 热点路径用基本类型集合或数组 | [代码级优化](./6_code_optimization) |
| 集合、StringBuilder 预分配 | 避免扩容时的数组复制与废弃数组 | [代码级优化](./6_code_optimization) |
| 减少中间对象 | 避免无谓的字符串拼接、`String.format`、多层 DTO 转换 | [代码级优化](./6_code_optimization) |
| 流式处理 | 大结果集分页 / 游标读取，不一次性加载到内存 | [数据访问性能](./10_db_performance) |
| 复用缓冲区 | IO 场景复用 `byte[]` / `ByteBuffer`，Netty 使用池化 ByteBuf | [ByteBuf 与内存管理](/netty/6_bytebuf) |
| 避免大数组 | G1 中超过 Region 一半大小的对象是 Humongous 对象，分配和回收代价高 | [GC 调优](/jvm/6_gc_tuning) |

::: tip 逃逸分析
JIT 的逃逸分析可以把未逃逸的小对象做标量替换，不在堆上分配。但它依赖方法内联，效果不稳定，不要把性能寄托在它上面，以分配火焰图的实测为准。
:::

---

## 三、堆大小与容器内存

**容器里最常见的问题不是 GC 慢，而是进程总内存超过 limit 被内核杀掉（OOMKilled），这时不会有 Java 的 OOM 日志和堆 dump。**

策略上记住三点：堆只是进程内存的一部分，`MaxRAMPercentage` 通常取 50～75%（Netty、线程多等堆外用量大的应用取低值）；初始堆与最大堆设成一致，避免运行中扩缩堆的抖动；比例以 NMT 实测为准，不要凭经验把堆设满。容器感知、各内存区域构成与推荐参数见 [GC 调优 · 容器环境](/jvm/6_gc_tuning#四、容器环境)，被 OOMKilled 后的排查见 [故障排查](/jvm/9_troubleshooting#八、容器-oomkilled)。

---

## 四、JIT 预热与冷启动毛刺

**刚启动的 JVM 以解释执行和 C1 为主，热点方法要被调用足够多次后才由 C2 编译到峰值性能；叠加类加载、懒初始化、连接池和缓存为空，新实例的前几分钟 RT 和 CPU 往往明显偏高。** 滚动发布、扩容时新实例一上来就接满流量，就会形成 P99 毛刺。

JIT 原理见 [JIT 编译](/jvm/7_jit)。

### 1、应对手段

| 手段 | 做法 | 解决的问题 |
|------|------|-----------|
| 预热流量 | 启动后、就绪前主动调用核心接口若干轮（可用录制的只读请求） | JIT 编译、懒加载、连接建立 |
| 就绪探针后置 | 预热完成再让 readinessProbe 通过 | 避免未预热实例接流量 |
| 预热权重 | 负载均衡对新实例逐步放量（如 Dubbo 的 warmup 权重、Envoy 的 slow start） | 平滑接入 |
| 提前初始化 | 连接池 `minimumIdle`、缓存预加载、单例提前创建 | 首批请求建连与加载 |
| 保证 CPU | 启动阶段 JIT 编译线程与业务线程争抢 CPU，CPU limit 过小会显著拉长预热 | 编译速度 |
| 关注 Code Cache | 满了会停止 JIT 编译（日志出现 `CodeCache is full`），性能骤降 | 长期运行的大应用 |

预热与流量接入的发布流程见 [优雅上下线与变更](/high-avail/8_graceful_release)，分层编译原理见 [JIT 编译](/jvm/7_jit)。

### 2、缩短启动与预热的技术

| 技术 | 作用 | 成熟度 |
|------|------|--------|
| AppCDS（类数据共享） | 把类加载和解析结果存成归档，后续启动直接映射，缩短启动时间；JDK 13 起可用 `-XX:ArchiveClassesAtExit` 动态生成归档，Spring Boot 3.3 起提供 CDS 支持 | 成熟，JDK 主线特性 |
| Leyden AOT 缓存 | 在训练运行中记录类加载与链接结果（JDK 24，JEP 483），JDK 25 进一步缓存方法 profile，缩短启动和预热 | JDK 24 起的正式特性，**JDK 21 不可用**，仍在演进 |
| CRaC | 在预热完成后对进程做检查点快照，之后从快照恢复，几乎跳过启动与预热 | 不在 OpenJDK 主线，需要支持 CRaC 的发行版（如 Azul Zulu、BellSoft Liberica）且仅限 Linux；需处理快照前后的连接与密钥 |
| GraalVM Native Image | AOT 编译为原生可执行文件，毫秒级启动 | 成熟，但峰值吞吐与动态特性受限，见 [JIT 编译](/jvm/7_jit) |

::: warning 选型提示
AppCDS 主要缩短类加载，**解决不了 JIT 预热**；长期运行的在线服务通常用"预热流量 + 就绪后置 + 预热权重"就足够，只有启动时间直接影响弹性扩容或 Serverless 场景，才值得引入 CRaC、Native Image 这类改造成本较高的方案。
:::

---

## 五、何时需要 GC 调优

**生产环境应常开 GC 日志，它是判断要不要调优的唯一依据：先确认 GC 停顿与 P99 毛刺相关，再动参数。** 日志开启参数、关键指标与分析工具见 [GC 调优 · GC 日志分析](/jvm/6_gc_tuning#二、gc-日志分析)，在线观测见 [JVM 诊断工具](/jvm/8_monitoring_tools)。

| 现象 | 结论 | 下一步 |
|------|------|--------|
| GC 停顿与 P99 毛刺不相关 | 瓶颈不在 GC | 回到 [性能分析方法论](./2_methodology) 查其他层 |
| 老年代 GC 后持续上涨 | 内存泄漏 | 堆 dump 分析，见 [JVM 故障排查](/jvm/9_troubleshooting) |
| Young GC 过频、分配速率高 | 分配过多 | 用分配火焰图降低分配速率（第二节） |
| 停顿本身超过 SLO，分配已合理 | 收集器或堆不合适 | 调大堆 / 调整 `MaxGCPauseMillis` / 换分代 ZGC，见 [GC 调优](/jvm/6_gc_tuning) |
| 容器被 OOMKilled | 堆外内存未计入 | 用 NMT 核算堆外，调低堆比例或限制直接内存，见 [GC 调优 · 容器环境](/jvm/6_gc_tuning#四、容器环境) |

每次只改一个参数，并用压测对比改动前后的 P99 与 CPU，见 [性能分析方法论](./2_methodology) 的优化闭环。

---

## 小结

- 先修代码再调 JVM：多数服务用 G1 + 合理堆大小即可，P99 敏感且 CPU 有余量时考虑分代 ZGC，批处理用 Parallel
- 分配速率决定 GC 频率，用分配火焰图定位并降低，比调参更有效
- 容器内堆只是进程内存的一部分，`MaxRAMPercentage` 取 50～75%，以 NMT 实测为准，避免 OOMKilled
- 冷启动毛刺用"预热流量 + 就绪后置 + 预热权重"解决；AppCDS 缩短启动，CRaC / Leyden 按成熟度谨慎选用
- 常开 GC 日志，先确认 GC 与 P99 相关再调优，每次只改一个参数

## 参考资料

- 收集器选择与调优：[HotSpot Virtual Machine Garbage Collection Tuning Guide (Java 21)](https://docs.oracle.com/en/java/javase/21/gctuning/)
- 分代 ZGC：[JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
- MaxRAMPercentage 等参数：[Java SE 21: The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- AOT 类加载与链接（Leyden）：[JEP 483: Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483)
- 检查点恢复：[OpenJDK Project CRaC](https://openjdk.org/projects/crac/)

> 下一篇：[代码级优化](./6_code_optimization) —— 回到代码本身：对象、集合、字符串、锁等热点路径上的具体手段。

# JVM 层性能策略

> **本篇目标**：从性能目标出发做 JVM 层决策：选哪个收集器、如何降低分配速率、容器里堆该给多大、如何消除冷启动毛刺，以及什么时候才需要 GC 调优。
>
> **前置阅读**：[基准测试（JMH）](./4_benchmark)

本篇只讲**策略与判断**，以 JDK 21 LTS 为主要视角。收集器原理见 [GC 收集器](/jvm/5_gc_collectors)，参数细节见 [GC 调优](/jvm/6_gc_tuning)，JIT 原理见 [JIT 编译](/jvm/7_jit)，工具见 [JVM 诊断工具](/jvm/8_monitoring_tools)。

**先记住优先级：先修代码（分配过多、内存泄漏），再选对收集器和堆大小，最后才动细节参数。** 多数服务用默认 G1 加上合理的堆大小就够了。

---

## 一、按延迟 vs 吞吐选收集器

**收集器选型取决于目标：要稳定的低停顿，还是要最高的吞吐。**

| 收集器 | 典型停顿 | 吞吐 | 适用场景 | JDK 21 启用方式 |
|--------|----------|------|----------|----------------|
| G1 | 可设目标（默认 `MaxGCPauseMillis=200`），常见几十毫秒 | 中高 | 通用在线服务，默认首选 | 默认（满足"服务器级机器"条件时） |
| 分代 ZGC | 通常亚毫秒级，与堆大小基本无关 | 中高，并发阶段占用额外 CPU | P99 敏感的在线服务、大堆 | `-XX:+UseZGC -XX:+ZGenerational` |
| Parallel | 较长，随堆增大 | 最高 | 批处理、离线计算，只看总耗时 | `-XX:+UseParallelGC` |
| Serial | 长 | 低 | 1 核或很小内存的容器、工具进程 | `-XX:+UseSerialGC` |

选型要点：

- **默认不一定是 G1**：JVM 判断不是"服务器级机器"（可用 CPU 少于 2 个，或内存小于约 1792MB）时会选 Serial。容器 CPU limit 为 1 时尤其要注意，建议**显式指定收集器**。
- **分代 ZGC 的版本差异**：JDK 21 需要 `-XX:+ZGenerational` 才启用分代模式；JDK 23 起分代成为默认模式，JDK 24 移除了非分代模式，此时只写 `-XX:+UseZGC` 即可。
- **ZGC 的代价**：并发回收会占用额外 CPU，堆需要留出余量（分配速度快于回收时会出现 Allocation Stall）；ZGC 不使用压缩指针，小堆场景内存占用可能高于 G1。CPU 已经紧张的服务换 ZGC 前先压测。
- **Shenandoah** 定位与 ZGC 相近，在多数 OpenJDK 发行版中可用（Oracle JDK 不包含），选用前确认所用发行版。
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
| 复用缓冲区 | IO 场景复用 `byte[]` / `ByteBuffer`，Netty 使用池化 ByteBuf | [ByteBuf 与内存管理](/netty/5_bytebuf) |
| 避免大数组 | G1 中超过 Region 一半大小的对象是 Humongous 对象，分配和回收代价高 | [GC 调优](/jvm/6_gc_tuning) |

::: tip 逃逸分析
JIT 的逃逸分析可以把未逃逸的小对象做标量替换，不在堆上分配。但它依赖方法内联，效果不稳定，不要把性能寄托在它上面，以分配火焰图的实测为准。
:::

---

## 三、堆大小与容器内存

**容器里最常见的问题不是 GC 慢，而是进程总内存超过 limit 被内核杀掉（OOMKilled，退出码 137），这种情况下不会有 Java 的 OOM 日志和堆 dump。**

### 1、容器感知

- JDK 10 起默认开启 `-XX:+UseContainerSupport`（8u191 起也已支持），JVM 按容器的内存与 CPU limit 计算默认堆大小和线程数。cgroup v2 需要 JDK 15+（或 11.0.16、8u372 之后的更新版本）。
- 默认 `-XX:MaxRAMPercentage=25`，即最大堆只有容器内存的 1/4，对大多数服务偏保守。
- CPU limit 会影响 GC 线程数、JIT 编译线程数和 `ForkJoinPool.commonPool` 的并行度；必要时用 `-XX:ActiveProcessorCount` 显式指定。

### 2、堆只是进程内存的一部分

| 内存区域 | 说明 | 控制参数 |
|----------|------|----------|
| 堆 | 对象分配 | `-Xmx` 或 `-XX:MaxRAMPercentage` |
| Metaspace | 类元数据，类多、动态代理多的应用可达数百 MB | `-XX:MaxMetaspaceSize` |
| 直接内存 | NIO / Netty 直接缓冲区，默认上限约等于最大堆 | `-XX:MaxDirectMemorySize` |
| 线程栈 | Linux x64 默认每线程 1MB，几百个线程就是几百 MB | `-Xss`、控制线程数 |
| Code Cache | JIT 编译后的机器码，分层编译下默认预留 240MB | `-XX:ReservedCodeCacheSize` |
| GC 与其他 native | GC 数据结构、JNI、glibc malloc arena 等 | 用 NMT 观察 |

这些区域都计入容器内存配额，所以 **`MaxRAMPercentage` 通常取 50～75%**：堆外用量大的应用（Netty、大量线程）取低值。准确比例用 NMT 实测：`-XX:NativeMemoryTracking=summary` 启动后执行 `jcmd <pid> VM.native_memory summary`。

### 3、推荐配置

```bash
# 容器内：按比例设置堆，初始与最大一致，避免运行中扩缩堆带来的抖动
java -XX:InitialRAMPercentage=70 -XX:MaxRAMPercentage=70 \
     -XX:MaxDirectMemorySize=512m \
     -XX:MaxMetaspaceSize=256m \
     -XX:+UseG1GC \
     -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
     -XX:+ExitOnOutOfMemoryError \
     -jar app.jar
```

- 显式设置 `-Xmx` 时，`MaxRAMPercentage` 不再生效，两者二选一。
- `-XX:+ExitOnOutOfMemoryError` 让进程在 OOM 后立即退出、由编排系统重启，避免"半死不活"地继续接流量；堆 dump 路径应挂载到持久卷。
- `-XX:+AlwaysPreTouch` 启动时预先触碰堆内存页，避免运行期的缺页开销，但会拉长启动时间，大堆低延迟服务可以考虑。

---

## 四、JIT 预热与冷启动毛刺

**刚启动的 JVM 以解释执行和 C1 为主，热点方法要被调用足够多次后才由 C2 编译到峰值性能；叠加类加载、懒初始化、连接池和缓存为空，新实例的前几分钟 RT 和 CPU 往往明显偏高。** 滚动发布、扩容时新实例一上来就接满流量，就会形成 P99 毛刺。

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

## 五、GC 日志与何时需要调优

### 1、开启 GC 日志

**生产环境应常开 GC 日志，开销很小，是判断要不要调优的唯一依据。**

```bash
-Xlog:gc*,safepoint:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=20m
```

分析工具（GCEasy、GCViewer、JMC）见 [GC 调优](/jvm/6_gc_tuning)。

### 2、关键指标

| 指标 | 怎么看 | 异常信号 |
|------|--------|----------|
| 停顿分布 | 停顿的 P99 / Max，并与接口 P99 毛刺的时间点对照 | 停顿接近或超过接口延迟 SLO |
| GC 时间占比 | 一段时间内 GC 停顿总时长 / 墙钟时间 | 持续超过几个百分点（常见经验阈值约 5%） |
| 分配速率 | 见第二节 | 明显高于同类服务，Young GC 每秒多次 |
| 晋升速率与老年代 | 每次 GC 后老年代占用（近似活跃数据量） | 持续单调上涨 → 疑似内存泄漏，调参数无用 |
| Full GC | G1 日志中的 `Pause Full` | 稳态下出现即需排查 |
| 失败事件 | G1 的 `To-space exhausted` / Evacuation Failure，ZGC 的 `Allocation Stall` | 堆余量不足或分配过快 |
| Safepoint | `safepoint` 日志中的到达时间与总停顿 | 非 GC 原因的停顿（如线程迟迟到达不了安全点、频繁 jstack / 堆转储） |

### 3、判断流程

| 现象 | 结论 | 下一步 |
|------|------|--------|
| GC 停顿与 P99 毛刺不相关 | 瓶颈不在 GC | 回到 [性能分析方法论](./2_methodology) 查其他层 |
| 老年代 GC 后持续上涨 | 内存泄漏 | 堆 dump 分析，见 [JVM 故障排查](/jvm/9_troubleshooting) |
| Young GC 过频、分配速率高 | 分配过多 | 用分配火焰图降低分配速率（第二节） |
| 停顿本身超过 SLO，分配已合理 | 收集器或堆不合适 | 调大堆 / 调整 `MaxGCPauseMillis` / 换分代 ZGC，见 [GC 调优](/jvm/6_gc_tuning) |
| 容器被 OOMKilled | 堆外内存未计入 | 按第三节用 NMT 核算，调低堆比例或限制直接内存 |

每次只改一个参数，并用压测对比改动前后的 P99 与 CPU，见 [性能分析方法论](./2_methodology) 的优化闭环。

---

## 小结

- 先修代码再调 JVM：多数服务用 G1 + 合理堆大小即可，P99 敏感且 CPU 有余量时考虑分代 ZGC，批处理用 Parallel
- 分配速率决定 GC 频率，用分配火焰图定位并降低，比调参更有效
- 容器内堆只是进程内存的一部分，`MaxRAMPercentage` 取 50～75%，用 NMT 核算堆外，避免 OOMKilled
- 冷启动毛刺用"预热流量 + 就绪后置 + 预热权重"解决；AppCDS 缩短启动，CRaC / Leyden 按成熟度谨慎选用
- 常开 GC 日志，先确认 GC 与 P99 相关再调优，每次只改一个参数

> 下一篇：[代码级优化](./6_code_optimization) —— 回到代码本身：对象、集合、字符串、锁等热点路径上的具体手段。

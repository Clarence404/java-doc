---
description: 调优目标、核心参数、G1 / ZGC 调优、容器环境、GC 日志分析、常见问题
---

# GC 调优

> **本篇目标**：掌握 GC 调优的完整套路：先定目标、再读 GC 日志定位问题，最后有针对性地调整堆大小、收集器和关键参数。
>
> **前置阅读**：[GC 收集器](./5_gc_collectors)

GC 调优的第一原则是**先测量再动手**：大多数服务用默认 G1 加合理的堆大小就够了，真正需要调参的往往是 GC 日志里能看到的具体问题，比如停顿超出延迟预算、Full GC 频繁、Humongous 分配过多。

---

## 一、调优目标

**调优前先明确要优化什么：吞吐量、延迟、内存占用三者不可兼得，只能按业务侧重取舍。**

| 目标 | 关注指标 | 推荐收集器 | 典型场景 |
|------|---------|-----------|---------|
| 高吞吐量 | GC 时间占比（如 < 1%～5%） | Parallel | 批处理、离线计算 |
| 低延迟 | 单次停顿、P99 响应时间 | G1 / ZGC | 在线接口、交易系统 |
| 小内存占用 | 堆与进程总内存 | Serial / G1 | 小规格容器、边缘设备 |

落到具体问题上，调优通常是为了解决这几类现象：

- 减少 Full GC 的频率，消除长时间停顿
- 把 GC 停顿控制在服务的延迟预算之内
- 排查内存泄漏，以及由频繁 GC 引起的 CPU 飙升

::: tip 调优原则
先监控再调优，不要过早优化；每次只改一个参数并复测对比；优先检查代码层面的分配与泄漏问题，参数只是最后一环。
:::

---

## 二、GC 日志分析

**GC 日志是调优的第一手证据：停顿发生在哪个阶段、由什么原因触发、回收前后堆占用如何变化，都在日志里。** 生产环境建议始终开启，开销很小。

### 1、开启 GC 日志

JDK 9 起使用统一日志（Unified Logging）：

```bash
-Xlog:gc*:file=/logs/gc-%p.log:time,uptime,level,tags:filecount=10,filesize=20M
```

- `gc*` 输出所有 GC 相关标签；只看摘要可用 `gc`，排查安全点耗时可再加 `-Xlog:safepoint`
- 文件名中的 `%p` 替换为进程号、`%t` 替换为启动时间，避免重启后覆盖旧日志

JDK 8 使用旧参数：

```bash
-XX:+PrintGCDetails -XX:+PrintGCDateStamps
-Xloggc:/logs/gc.log
-XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=20M
```

一条 G1 Young GC 的摘要日志（JDK 17，`-Xlog:gc`）大致如下，依次为 GC 编号、类型与原因、回收前 → 回收后（堆总大小）、停顿时长：

```text
[2025-03-01T10:15:30.123+0800][info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 1843M->412M(4096M) 18.532ms
```

### 2、关键指标

| 指标 | 看什么 | 异常时的含义 |
|------|-------|-------------|
| 停顿时间 | 每次 GC 的 Pause 时长及分布（P99、最大值） | 超出延迟预算需要调优；Young GC 一般在几十毫秒内，Full GC 应尽量不出现 |
| GC 频率 | Young GC、Mixed GC、Full GC 的间隔 | Young GC 过频：Eden 太小或对象分配速率过高 |
| GC 时间占比 | GC 总耗时 / 运行时间 | 占比高说明吞吐受损，也是 CPU 飙升的常见原因 |
| 回收后老年代占用 | 每次 Mixed / Full GC 后的老年代大小，即活跃数据量 | 持续上涨、回收不掉：疑似内存泄漏 |
| 晋升速率 | 每次 Young GC 晋升到老年代的数据量 | 过高：Survivor 放不下或对象过早晋升 |

常见的 GC 触发原因：

| 日志中的原因 | 含义 |
|------------|------|
| `Allocation Failure` / `G1 Evacuation Pause` | Eden 放不下新对象，属于正常的 Young GC |
| `G1 Humongous Allocation` | 大对象分配触发，频繁出现说明 Humongous 对象过多 |
| `Metadata GC Threshold` | 元空间达到高水位 |
| `System.gc()` | 代码或框架显式调用 |
| `To-space exhausted` / `Evacuation Failure` | G1 转移时找不到空闲 Region，老年代或预留空间不足，可能继而 Full GC |
| `Pause Full` | Full GC，G1 下出现即需重点排查 |

### 3、可视化工具

| 工具 | 特点 |
|------|------|
| **GCEasy**（[gceasy.io](https://gceasy.io)） | 在线上传 GC 日志自动生成报告，免费版足够日常使用；注意日志中可能含主机信息，敏感环境先脱敏或使用离线工具 |
| **GCViewer** | 开源桌面工具，展示 GC 时间线、停顿分布、吞吐量 |
| **JDK Mission Control（JMC）** | 需单独下载，配合 JFR 录制分析 GC、分配热点、锁竞争 |

jstat、jcmd、JFR 等在线观测手段见 [诊断工具](./8_monitoring_tools)；如何根据日志判断"是否需要调优"可参考 [JVM 层性能策略](/high-perf/5_jvm_tuning)。

---

## 三、核心 JVM 参数

### 1、内存大小

```bash
# 堆：初始 = 最大，避免运行中扩缩容带来的抖动
-Xms4g -Xmx4g

# 年轻代：NewRatio = 老年代 / 年轻代，默认 2（年轻代占堆的 1/3）
-XX:NewRatio=2
-Xmn1g                          # 或直接指定年轻代大小（G1 下不建议，见后文）

# Eden : S0 : S1 = SurvivorRatio : 1 : 1，默认 8:1:1
-XX:SurvivorRatio=8

# 每线程栈大小（Linux x64 默认 1m，线程很多时可适当缩小）
-Xss512k

# 元空间：MetaspaceSize 是首次触发元空间 GC 的高水位，Max 是上限
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m
```

- **NewRatio 调大，年轻代反而变小**：`NewRatio=3` 表示老年代是年轻代的 3 倍，年轻代只占堆的 1/4
- **`-Xms` 与 `-Xmx` 设为相同值**：否则堆在两者之间扩缩容，扩容时伴随额外 GC 与内存申请开销
- **堆大小经验值**：先观察 Full GC（或 G1 并发标记后）老年代的稳定占用作为活跃数据量，堆取其 3～4 倍；ZGC 需要更多余量，建议至少 4 倍

### 2、选择收集器

```bash
-XX:+UseG1GC           # G1（JDK 9+ 默认）
-XX:+UseParallelGC     # Parallel（高吞吐）
-XX:+UseSerialGC       # Serial（小堆、单核）
-XX:+UseZGC            # ZGC：JDK 23+ 默认即分代模式
-XX:+UseZGC -XX:+ZGenerational   # JDK 21–22 开启分代 ZGC 时才需要 ZGenerational
```

### 3、晋升控制

```bash
-XX:MaxTenuringThreshold=15        # 晋升年龄上限（默认 15，也是最大值）
-XX:TargetSurvivorRatio=50         # Survivor 目标占用率，动态年龄判断以此为界
-XX:PretenureSizeThreshold=4m      # 大对象直接进老年代的阈值，仅 Serial / ParNew 有效
```

::: warning
`PretenureSizeThreshold` 对 Parallel、G1 都不生效。G1 中大小 ≥ Region 一半的对象会直接分配为 Humongous 对象，想减少 Humongous 分配应调大 `G1HeapRegionSize` 或优化代码。
:::

### 4、OOM 保护

```bash
-XX:+HeapDumpOnOutOfMemoryError           # OOM 时自动生成堆 dump
-XX:HeapDumpPath=/logs/                   # dump 目录，需保证磁盘空间 ≥ 堆大小
-XX:+ExitOnOutOfMemoryError               # OOM 后立即退出进程
# -XX:+CrashOnOutOfMemoryError            # 或：OOM 后以崩溃方式退出，额外生成 hs_err 文件
```

- **推荐 `ExitOnOutOfMemoryError`**：OOM 后进程往往处于"半死不活"状态，立即退出再由 K8s 或守护进程（systemd、supervisor）拉起，比继续接流量更安全
- 不再推荐 `-XX:OnOutOfMemoryError="kill -9 %p"`：依赖外部命令且粗暴，`Exit/Crash` 选项更可靠
- `HeapDumpOnOutOfMemoryError` 线上也建议开启：生成 dump 会有停顿，但 OOM 时服务已不可用，dump 是事后分析的关键证据；容器中 dump 目录要挂载到持久卷

---

## 四、容器环境

**容器里 JVM 最常见的问题不是 GC 慢，而是进程总内存超过 limit 被内核杀掉（OOMKilled），这时既没有 Java OOM 日志也没有堆 dump。**

- **容器感知**：JDK 10 起（8u191 回移）默认开启 `-XX:+UseContainerSupport`，JVM 按容器的内存与 CPU limit 计算默认堆大小、GC 线程数
- **按比例设置堆**：用 `-XX:MaxRAMPercentage` / `-XX:InitialRAMPercentage` 替代固定的 `-Xmx` / `-Xms`，规格调整时无需改参数；默认 `MaxRAMPercentage=25` 偏保守，通常取 50～75
- **给堆外留足空间**：元空间、直接内存、线程栈、Code Cache、GC 自身数据结构都计入容器内存，堆外占用大的应用（Netty、线程多）取低比例，并显式限制 `MaxDirectMemorySize`、`MaxMetaspaceSize`
- **小规格容器**：CPU < 2 或内存 < 1792MB 时 JVM 会默认选 Serial，建议显式指定收集器

```bash
java -XX:InitialRAMPercentage=70 -XX:MaxRAMPercentage=70 \
     -XX:MaxDirectMemorySize=512m -XX:MaxMetaspaceSize=256m \
     -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError \
     -jar app.jar
```

cgroup 版本兼容、各内存区域占比、NMT 实测方法详见 [JVM 层性能策略](/high-perf/5_jvm_tuning)。

---

## 五、G1 调优

**G1 的设计理念是"给目标、让它自适应"：优先设定合理的堆大小和 `MaxGCPauseMillis`，其余参数只在日志显示具体问题时再调。**

### 1、常用参数

```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200                # 目标停顿（软目标，默认 200ms）
-XX:G1HeapRegionSize=16m                # Region 大小（1–32MB，2 的幂；JDK 18+ 上限 512MB），默认按堆约 2048 个 Region 计算
-XX:InitiatingHeapOccupancyPercent=45   # IHOP 初始值（默认 45）
-XX:G1ReservePercent=10                 # 预留空闲空间比例，降低转移失败风险
-XX:G1MixedGCCountTarget=8              # 一次并发周期后 Mixed GC 的目标轮数
-XX:G1HeapWastePercent=5                # 可回收空间低于 5% 时不再做 Mixed GC
```

- **IHOP 默认自适应**：JDK 9 起 `-XX:+G1UseAdaptiveIHOP` 默认开启，G1 根据标记耗时与分配速率动态调整并发标记的启动时机，`InitiatingHeapOccupancyPercent` 只作为初始值；确需固定阈值时才关闭自适应
- **不要固定年轻代大小**：设置 `-Xmn` 或 `NewRatio` 后 G1 无法再动态调整年轻代，`MaxGCPauseMillis` 目标实际上失效

### 2、停顿时间过长的排查思路

1. **先看 GC 日志定位阶段**：长停顿来自 Young GC、Mixed GC、Remark（最终标记）还是 Full GC，不同阶段对策完全不同
2. **检查是否固定了年轻代**：去掉 `-Xmn`、`NewRatio`，让 G1 按停顿目标自适应
3. **合理设置 `MaxGCPauseMillis`**：目标过大停顿自然长，目标过小会导致 GC 过于频繁、吞吐下降甚至跟不上分配
4. **Humongous 对象过多**：日志中频繁出现 `G1 Humongous Allocation` 时，调大 `G1HeapRegionSize`，或在代码中避免超大数组 / 集合
5. **并发标记启动太晚**：出现 `To-space exhausted` 或 Full GC，说明回收跟不上，检查 IHOP 是否被固定得过高，适当增大 `G1ReservePercent` 或堆
6. **引用处理、根扫描耗时**：详细日志中 Ref Proc、Code Root Scanning 等子阶段耗时高时，排查大量软 / 弱引用、`finalize`、超多线程或类，必要时开启 `-XX:+ParallelRefProcEnabled`（较新 JDK 的 G1 下默认已开启，以所用 JDK 为准）

::: warning
调小 `G1HeapRegionSize` 并不能减少停顿，反而会让更多对象成为 Humongous 对象、RSet 开销变大。
:::

---

## 六、ZGC 调优

**ZGC 基本开箱即用，调优重点是给足堆空间：并发回收期间业务线程仍在分配，堆余量不足时会出现分配停顿（Allocation Stall）。**

```bash
# JDK 23+：默认即分代 ZGC
-XX:+UseZGC
-Xmx16g
-XX:SoftMaxHeapSize=12g           # 软上限：ZGC 尽量把堆控制在此值以下，突发时仍可用到 -Xmx

# JDK 21–22：需显式开启分代
# -XX:+UseZGC -XX:+ZGenerational
```

- **堆大小**：建议至少为活跃数据量的 4 倍；GC 日志中出现 `Allocation Stall` 说明回收跟不上分配，优先加大堆
- **`ConcGCThreads`**：默认动态调整并发 GC 线程数，一般无需设置；CPU 很紧张时再考虑显式限制
- **`ZCollectionInterval`**：默认 0，即不启用定时触发；只在需要定期回收（如长期低负载但希望归还内存）时设置

---

## 七、完整启动配置示例

### 1、通用服务（JDK 17+，G1）

```bash
java -Xms4g -Xmx4g \
     -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/logs/ \
     -XX:+ExitOnOutOfMemoryError \
     -Xlog:gc*:file=/logs/gc-%p.log:time,uptime,level,tags:filecount=10,filesize=20M \
     -jar app.jar
```

### 2、低延迟服务（JDK 23+，分代 ZGC）

```bash
java -Xms16g -Xmx16g \
     -XX:+UseZGC \
     -XX:SoftMaxHeapSize=12g \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/logs/ \
     -XX:+ExitOnOutOfMemoryError \
     -Xlog:gc*:file=/logs/gc-%p.log:time,uptime,level,tags:filecount=10,filesize=20M \
     -jar app.jar
```

JDK 21–22 在 `-XX:+UseZGC` 后加 `-XX:+ZGenerational`。

### 3、批处理（JDK 11+，Parallel）

```bash
java -Xms4g -Xmx4g \
     -XX:+UseParallelGC \
     -XX:MaxGCPauseMillis=500 \
     -XX:GCTimeRatio=19 \
     -jar batch.jar
```

---

## 八、常见 GC 问题处理

### 1、Full GC 频繁

| 原因 | 解决 |
|------|------|
| 堆整体偏小，活跃数据接近老年代容量 | 按活跃数据量的 3～4 倍增大堆 |
| 对象过早晋升（Survivor 放不下、年龄阈值过小） | 适当增大年轻代或 Survivor，调大 `MaxTenuringThreshold` |
| 大对象过多 | 优化代码；G1 调大 `G1HeapRegionSize`；Serial / ParNew 才能用 `PretenureSizeThreshold` |
| 元空间不足 | 调大 `MaxMetaspaceSize`，排查动态代理、脚本引擎等导致的类加载泄漏 |
| 代码显式调用 `System.gc()` | 定位调用方；需要保留时用 `-XX:+ExplicitGCInvokesConcurrent` |
| 内存泄漏 | dump 后用 MAT 分析，见 [故障排查](./9_troubleshooting) |

### 2、GC 停顿时间长

| 原因 | 解决 |
|------|------|
| 堆很大且停顿敏感 | 换 ZGC / Shenandoah |
| 固定了年轻代大小（G1） | 去掉 `-Xmn` / `NewRatio`，让停顿目标生效 |
| Humongous 对象多（G1） | 调大 `G1HeapRegionSize`，优化大对象 |
| 并发标记启动太晚导致 Full GC（G1） | 检查 IHOP，增大 `G1ReservePercent` 或堆 |
| GC 线程被限制或 CPU 不足 | 检查容器 CPU limit、`ParallelGCThreads` / `ConcGCThreads` |
| 等待进入安全点耗时长 | 开启 `-Xlog:safepoint` 排查长时间不进入安全点的循环 |

---

## 小结

- 先定**目标**（吞吐 / 延迟 / 内存），再用 **GC 日志**定位问题阶段和原因，每次只改一个参数
- **NewRatio 是老年代 / 年轻代**，调大年轻代变小；G1 下不要固定年轻代大小
- G1 优先设定堆和 `MaxGCPauseMillis`，IHOP 默认自适应；**调小 Region 不能减少停顿**
- OOM 后用 **`ExitOnOutOfMemoryError`** 退出并由编排系统重启；容器中用 **`MaxRAMPercentage`** 并给堆外留余量
- ZGC 重点是给足堆空间，JDK 23+ 只需 `-XX:+UseZGC`

> 下一篇：[JIT 编译](./7_jit) —— GC 管内存，JIT 管执行速度：热点代码如何被编译成机器码。

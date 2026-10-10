---
description: 排查流程、各类 OOM 与容器 OOMKilled、StackOverflowError、CPU 飙高、死锁、类加载失败
---

# 故障排查

> 前置阅读：[诊断工具](./8_monitoring_tools)

**排查线上 JVM 问题的核心是"先保现场，再找根因"**：进程重启后，堆、线程、GC 状态都会消失。本篇建立一套排查流程，按错误类型判断原因、取对现场、用对工具。

---

## 一、排查总流程

工具用法见 [诊断工具](./8_monitoring_tools)，GC 参数调整见 [GC 调优](./6_gc_tuning)。

**性能问题和故障走同一套闭环：明确现象 → 取证 → 定位 → 修复 → 复测。**

1. **明确现象与目标**：是报错（OOM / SOE / 类加载失败）、卡顿（CPU 高 / 死锁 / GC 停顿），还是性能不达标；性能问题先定目标（吞吐 / 延迟 / 内存）
2. **止血并保留现场**：先摘流量或扩容恢复服务，保留一台问题实例不重启
3. **看趋势**：GC 日志（频率、停顿、GC 后老年代占用）+ `jstat -gcutil` 实时观察 + 监控系统的 CPU、RSS、线程数曲线
4. **取现场**：按类型导出 heap dump、连续多次 thread dump、JFR 录制、NMT 汇总
5. **离线分析**：heap dump 用 MAT，thread dump 看状态与栈，JFR 用 JMC，GC 日志用 GCEasy / GCViewer
6. **定位根因并修复**：优先修代码（泄漏、死循环、锁顺序），其次调参数，**每次只改一个参数**
7. **复测验证**：压测或灰度对比改动前后的 P99、GC 停顿与 CPU，确认问题消失

::: tip 预先配置好取证参数
线上问题往往来不及手工取证，启动参数应预留：`-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=<持久卷>`、常开 GC 日志、`-XX:+ExitOnOutOfMemoryError`（OOM 后退出，由 K8s 或守护进程重启）。
:::

---

## 二、OOM 类型总览

**OutOfMemoryError 后面的消息说明了是哪块内存不够，排查方向完全不同。**

| 错误消息 | 不足的区域 | 典型原因 |
|---------|-----------|---------|
| `Java heap space` | 堆 | 内存泄漏、大对象、流量突增、堆过小 |
| `GC overhead limit exceeded` | 堆 | 堆几乎耗尽，GC 在做无用功 |
| `Metaspace` / `Compressed class space` | 元空间 / 压缩类空间 | 动态生成类过多、类加载器泄漏 |
| `Direct buffer memory` | 直接内存 | NIO / Netty 直接缓冲区泄漏或上限过小 |
| `unable to create native thread` | 操作系统线程资源 | 线程数超限、线程无界增长 |
| （无 Java 异常，进程被杀） | 容器内存配额 | 容器 OOMKilled，堆外内存未计入 |

---

## 三、OutOfMemoryError: Java heap space

**先判断是"泄漏"还是"不够用"**：GC 后老年代占用持续上涨、Full GC 后也降不下来是泄漏；占用平稳但峰值时被打满是容量不足。

**排查步骤：**

```bash
# 1. 确认 OOM 日志
grep "OutOfMemoryError" app.log

# 2. 观察老年代趋势（O 列持续升高不降 = 泄漏）
jstat -gcutil <pid> 1000

# 3. 导出 heap dump（优先使用 OOM 时自动生成的 dump）
jcmd <pid> GC.heap_dump /data/dump/heap.hprof
# 启动参数：-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/
```

4. MAT 分析：Leak Suspects Report 自动识别泄漏 → Dominator Tree 按 Retained Heap 排序 → Path to GC Roots 看引用链

**常见泄漏场景：**

- 静态集合（`static Map/List`）只增不减
- 监听器 / 回调注册后未移除
- `ThreadLocal` 使用后未 `remove()`（线程池复用线程时尤其危险）
- 本地缓存未设置容量上限和过期策略
- 一次性把大结果集加载进内存（全表查询、大文件读取）
- 类加载器泄漏（动态代理、热部署），通常同时伴随 Metaspace 上涨

---

## 四、OutOfMemoryError: GC overhead limit exceeded

**含义：GC 花掉了绝大部分时间却几乎回收不到内存。** 由 `-XX:+UseGCOverheadLimit`（默认开启）控制，主要在 Parallel GC 下出现：连续多次 GC 耗时超过 98%、回收的堆不足 2% 时抛出（以所用 JDK 与收集器为准）。

- 本质与 `Java heap space` 相同，按第三节排查泄漏或扩容
- 不要用 `-XX:-UseGCOverheadLimit` 关掉它：只会让进程在 GC 中卡更久，最终仍然 OOM

---

## 五、OutOfMemoryError: Metaspace

**元空间存放类元数据，类的数量只增不减通常意味着类或类加载器泄漏。**

**可能原因：**

- 动态生成大量类（CGLIB / ByteBuddy 代理、Groovy 脚本、反射生成的访问器）且不断生成新类
- 类加载器未释放（Web 应用反复热部署、自定义类加载器被缓存持有）
- `-XX:MaxMetaspaceSize` 设置过小；`Compressed class space` 则与 `-XX:CompressedClassSpaceSize` 有关

**排查步骤：**

```bash
# 1. 查看元空间使用（关注 MC / MU 是否持续增长）
jstat -gc <pid> 1000

# 2. 类加载器统计：哪个加载器加载了大量类
jcmd <pid> VM.classloader_stats
jmap -clstats <pid>

# 3. 跟踪类加载 / 卸载（JDK 9+ 统一日志，替代 -XX:+TraceClassLoading / TraceClassUnloading）
-Xlog:class+load=info
-Xlog:class+unload=info
```

从 `class+load` 日志找出反复出现、名字带序号的类（如 `$$EnhancerByCGLIB$$`、`$Proxy`），通常就能定位到生成类的代码。

---

## 六、OutOfMemoryError: Direct buffer memory

**直接内存用 `-XX:MaxDirectMemorySize` 限制（未设置时默认约等于最大堆），不足时说明 DirectByteBuffer 没有及时释放。**

**可能原因：**

- Netty / NIO 的直接缓冲区泄漏（ByteBuf 引用计数未归零）
- DirectByteBuffer 的回收依赖其堆内对象被 GC，堆很空闲、迟迟不 GC 时堆外内存释放不及时
- 开启了 `-XX:+DisableExplicitGC`：分配不足时 JDK 会调用 `System.gc()` 触发引用处理来回收直接内存，禁用后更容易 OOM，原理见 [GC 原理](./4_gc_theory)
- `MaxDirectMemorySize` 设置过小

**排查方向：**

- 监控 `BufferPoolMXBean`（JMX 中 `java.nio:type=BufferPool,name=direct`）的使用量曲线
- 用 NMT 查看堆外内存增长：`jcmd <pid> VM.native_memory summary.diff`，直接内存计入 `Other`
- Netty 场景开启泄漏检测（`-Dio.netty.leakDetection.level=paranoid`，仅测试环境），见 [ByteBuf 与内存管理](/netty/6_bytebuf)

---

## 七、OutOfMemoryError: unable to create new native thread

**JVM 向操作系统申请线程失败，与堆大小无关。**

**可能原因：**

- 线程数超过 OS 限制：用户进程数 `ulimit -u`、`/proc/sys/kernel/threads-max`、`pid_max`，容器的 `pids.limit`
- 线程无界增长：`newCachedThreadPool`、每请求 `new Thread`、线程池被重复创建
- 进程可用内存不足以分配新的线程栈（`-Xss` 过大或容器内存紧张）

**排查步骤：**

```bash
# 查看限制
ulimit -u

# 当前线程数
grep Threads /proc/<pid>/status

# 按线程名前缀归类，找出在增长的线程
jstack <pid> | grep '^"' | sed 's/[0-9]*"/"/; s/ .*//' | sort | uniq -c | sort -rn | head
```

---

## 八、容器 OOMKilled

**这不是 JVM 的 OOM：进程总内存超过容器 limit，被内核 OOM Killer 直接杀掉（退出码 137），不会有 Java 异常、heap dump 和 hs_err 日志。**

**确认方法：**

```bash
kubectl describe pod <pod>          # Last State: Terminated, Reason: OOMKilled, Exit Code: 137
dmesg -T | grep -i "killed process" # 宿主机内核日志
```

**常见原因与处理：**

| 原因 | 处理 |
|------|------|
| 堆设得太满，没给堆外留空间 | `-XX:MaxRAMPercentage` 通常取 50～75%，不要把 `-Xmx` 设成接近 limit |
| 直接内存、元空间无上限 | 显式设置 `-XX:MaxDirectMemorySize`、`-XX:MaxMetaspaceSize` |
| 线程过多 | 每个线程栈默认约 1MB，控制线程数 |
| 本地库 / glibc malloc arena | NMT 总量与 RSS 差距大时怀疑这里，可调 `MALLOC_ARENA_MAX` 或换用 jemalloc |

用 NMT 核算各区域占用：启动加 `-XX:NativeMemoryTracking=summary`，运行中执行 `jcmd <pid> VM.native_memory summary`。容器内存配置的完整思路见 [JVM 层性能策略](/high-perf/5_jvm_tuning)。

---

## 九、StackOverflowError

**线程栈深度超过 `-Xss` 限制（Linux x64 默认约 1MB）。** 异常抛出后栈帧随即展开，**thread dump 里看不到溢出现场，要看应用日志中的异常栈**。

**可能原因：**

- 递归无终止条件或终止条件错误
- 对象循环引用导致 `toString` / `equals` / `hashCode` / JSON 序列化无限递归（如双向关联的实体）
- 调用链过深（深层代理、拦截器嵌套）
- `-Xss` 设置过小

**排查方法：**

- 在日志的 `StackOverflowError` 栈中找**重复出现的帧**，那一组帧就是递归环
- 异常栈默认最多记录 1024 帧（`-XX:MaxJavaStackTraceDepth`），全是重复帧、看不到递归入口时可临时调大该值
- 增大 `-Xss`（如 `-Xss2m`）只能临时缓解，根本方案是修正递归或改为迭代

---

## 十、CPU 使用率高

**先分清是业务线程、GC 线程还是 JIT 编译线程在占 CPU。** 注意：死锁线程处于 BLOCKED，**不消耗 CPU**，死锁表现为"无响应 + CPU 低"。

**可能原因：**

- 死循环、自旋等待、活锁（线程不断重试却无进展）
- 频繁 GC（GC 线程占满 CPU，通常伴随停顿和吞吐下降）
- 正则表达式回溯爆炸（复杂模式匹配超长输入）
- 大对象序列化 / 压缩 / 加解密等计算密集操作
- 启动初期 JIT 编译线程（`C2 CompilerThread`）繁忙，通常是短时现象

**排查步骤：**

```bash
# 1. 找到高 CPU 的 Java 进程
top

# 2. 找到高 CPU 的线程（-H = 线程模式）
top -H -p <pid>

# 3. 将线程 TID 转为十六进制
printf "%x\n" <tid>   # 例：12345 → 3039

# 4. 在 thread dump 中搜索对应的 nid（间隔几秒多抓几次，确认一直在同一处）
jstack <pid> > thread_dump.txt
grep "nid=0x3039" thread_dump.txt -A 30

# 5. 若高 CPU 线程是 GC 线程（如 "GC Thread#0"、"G1 Conc#0"）→ 查 GC 日志
grep -E "Pause Full|Pause Young" gc.log | tail -20
```

Arthas 的 `thread -n 3` 可以一步列出最忙的 3 个线程及其栈，见 [线上诊断](/engineering/4_diagnosis)。

---

## 十一、死锁

**症状：** 部分请求一直无响应，相关线程长期 BLOCKED（`synchronized`）或 WAITING（`ReentrantLock`），CPU 并不高。

```bash
# jstack 会自动检测死锁，synchronized 和 j.u.c 锁都能检测到
jstack -l <pid> | grep -A 30 "Found one Java-level deadlock"
```

**输出示例：**

```
Found one Java-level deadlock:
=============================
"Thread-1":
  waiting to lock monitor 0x00007f... (object 0x..., a java.lang.Object),
  which is held by "Thread-0"
"Thread-0":
  waiting to lock monitor 0x00007f... (object 0x..., a java.lang.Object),
  which is held by "Thread-1"
```

- 程序内也可通过 `ThreadMXBean.findDeadlockedThreads()` 定期检测并告警
- **预防**：固定加锁顺序、用 `tryLock(timeout)` 代替无限等待、缩小锁粒度、避免持锁调用外部服务

---

## 十二、类加载失败

**先看异常类型：找不到类、类初始化失败、版本冲突，处理方式各不相同。**

| 异常 | 原因 |
|------|------|
| `ClassNotFoundException` | 按类名显式加载（`Class.forName`、`loadClass`）时 classpath 中找不到，通常是依赖缺失 |
| `NoClassDefFoundError`（情况一） | 编译期存在、运行期缺失：依赖 scope 错误、打包遗漏、jar 冲突被排除 |
| `NoClassDefFoundError: Could not initialize class X`（情况二） | 类的静态初始化曾经失败；**第一次**会抛 `ExceptionInInitializerError`（带真正的原因），之后再使用该类都抛这个错误 |
| `NoSuchMethodError` / `NoSuchFieldError` | 依赖版本冲突：编译时的版本与运行时加载的版本不一致 |
| `ClassCastException` / `LinkageError` | 同名类被不同类加载器加载，被视为不同类型 |
| `UnsupportedClassVersionError` | class 文件版本高于运行的 JDK |

::: warning 情况二要往前翻日志
看到 `Could not initialize class` 时，真正的原因在更早的 `ExceptionInInitializerError` 中（静态代码块或静态字段初始化抛出的异常），只看当前这条异常是找不到根因的。
:::

**排查命令：**

```bash
# 查看运行时 classpath
jcmd <pid> VM.system_properties | grep java.class.path

# 打印每个类从哪个 jar 加载（JDK 9+，替代 -XX:+TraceClassLoading）
-Xlog:class+load=info

# 查依赖冲突（Maven）
mvn dependency:tree -Dincludes=<groupId>:<artifactId>
```

Arthas 的 `sc -d <类名>` 可查看已加载类的来源 jar 与类加载器。类加载器与双亲委派原理见 [类加载机制](./2_class_loading)。

---

## 十三、常见问题速查表

| 现象 | 首先看 | 工具 |
|------|--------|------|
| OOM: Java heap space | GC 后老年代趋势 + heap dump | `jstat` + MAT |
| OOM: GC overhead limit exceeded | 同 heap space | `jstat` + MAT |
| OOM: Metaspace | 类加载器与类数量 | `jcmd VM.classloader_stats`、`-Xlog:class+load` |
| OOM: Direct buffer memory | 直接内存曲线、ByteBuf 是否释放 | NMT、BufferPoolMXBean、Netty 泄漏检测 |
| OOM: unable to create native thread | 线程数 / OS 限制 | `ulimit -u` + `jstack` |
| 容器 OOMKilled（退出码 137） | 堆外内存占用 | `kubectl describe`、`dmesg`、NMT |
| StackOverflowError | 应用日志中的重复栈帧 | 日志 |
| Full GC 频繁 | GC 日志频率和触发原因 | GC 日志、`jstat`、GCViewer |
| CPU 高 | 高 CPU 线程堆栈 | `top -H` + `jstack`，Arthas `thread -n` |
| 死锁 / 无响应 | 线程状态与锁持有关系 | `jstack -l` |
| 响应慢 | 线程状态 / GC 停顿 / 方法耗时 | `jstack` + GC 日志；Arthas `trace <class> <method> '#cost > 100'` |
| 方法行为异常 | 入参 / 返回值 / 异常 | Arthas `watch <class> <method> '{params, returnObj}'` |
| 类加载失败 | 异常类型、类来源 jar | `-Xlog:class+load`、`mvn dependency:tree` |

> Arthas 用法详见 [线上诊断](/engineering/4_diagnosis)。

---

## 小结

- 先止血、保现场，再按"趋势 → 取证 → 分析 → 修复 → 复测"推进，启动参数预留 OOM dump、GC 日志和 OOM 退出
- OOM 看消息定区域：堆看泄漏与容量，Metaspace 看类加载器，Direct buffer 看 ByteBuf 与 NMT，容器 OOMKilled 核算堆外
- SOE 看应用日志中的重复帧，thread dump 里看不到
- CPU 高先分清业务、GC、JIT 线程；死锁线程 BLOCKED 不耗 CPU，用 `jstack -l` 检测
- `NoClassDefFoundError` 分"运行期缺类"和"静态初始化失败"两种，后者要往前找 `ExceptionInInitializerError`

> 返回：[JVM 总览](./0_overview) —— 回顾模块全貌与推荐阅读路径。

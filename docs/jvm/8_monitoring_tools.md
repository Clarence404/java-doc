# 诊断工具

> **本篇目标**：掌握 JDK 自带的命令行与图形化诊断工具，知道每个问题该用哪个工具、在生产和容器中怎样安全地使用。
>
> **前置阅读**：[JIT 编译](./7_jit)

**JDK 9+ 首选 `jcmd`**：一个命令覆盖了 jstack、jmap、jinfo 的大部分功能，还能控制 JFR、查看 NMT。其余工具按场景补充。调优目标与 GC 日志分析见 [GC 调优](./6_gc_tuning)，完整的排查流程见 [故障排查](./9_troubleshooting)。

---

## 一、常用工具速查

**命令行工具用来取现场，图形化工具用来分析现场。**

| 工具 | 类型 | 功能 |
|------|------|------|
| `jcmd` | 命令行 | 诊断命令总入口：线程、堆、参数、JFR、NMT 等，JDK 9+ 首选 |
| `jps` | 命令行 | 查看 Java 进程列表 |
| `jstack` | 命令行 | 线程堆栈 / 死锁检测 |
| `jmap` | 命令行 | 对象直方图 / Heap Dump |
| `jhsdb` | 命令行 | 基于 Serviceability Agent 的调试工具，替代 `jmap -heap` 等（JDK 9+） |
| `jstat` | 命令行 | 实时 GC 统计 |
| `jinfo` | 命令行 | 查看 / 修改 JVM 参数（可用 `jcmd VM.flags` 替代） |
| NMT | JVM 内置 | 统计 JVM 自身的堆外内存（元空间、线程栈、Code Cache、GC 等） |
| JFR / JMC | 录制 + GUI | JDK Flight Recorder 低开销录制，JDK Mission Control 分析 |
| MAT | GUI | Eclipse Memory Analyzer，深度分析 heap dump |
| VisualVM | GUI | 综合监控（CPU / 内存 / 线程 / GC） |
| Arthas | 在线诊断 | 方法追踪 / 观察入参返回值 → 详见 [线上诊断](/engineering/4_diagnosis) |

---

## 二、jcmd：诊断命令总入口

**`jcmd <pid> <命令>` 通过 attach 机制在目标 JVM 内执行诊断命令**，可用命令因 JDK 版本而异，先用 `help` 查看。

```bash
jcmd                                    # 列出本机 Java 进程（等价于 jps -l）
jcmd <pid> help                         # 列出该 JVM 支持的全部诊断命令
jcmd <pid> help GC.heap_dump            # 查看某个命令的参数说明

jcmd <pid> VM.version                   # JDK 版本
jcmd <pid> VM.command_line              # 启动命令行
jcmd <pid> VM.flags                     # 生效的 JVM 参数（-all 显示全部）
jcmd <pid> VM.system_properties         # 系统属性

jcmd <pid> GC.heap_info                 # 堆各区域使用概况
jcmd <pid> GC.class_histogram           # 对象直方图（默认只统计存活对象，会触发 Full GC）
jcmd <pid> GC.heap_dump /data/dump/heap.hprof   # 导出 heap dump（默认只含存活对象，加 -all 导出全部）

jcmd <pid> Thread.print -l              # 线程堆栈 + 锁信息（等价于 jstack -l）

jcmd <pid> JFR.start name=rec duration=60s filename=/data/app.jfr   # 开始 JFR 录制
jcmd <pid> JFR.dump name=rec filename=/data/app.jfr                 # 导出正在进行的录制
jcmd <pid> JFR.stop name=rec

jcmd <pid> VM.native_memory summary     # NMT 汇总（需启动时开启 NMT）
jcmd <pid> VM.classloader_stats         # 类加载器统计
jcmd <pid> Compiler.codecache           # Code Cache 使用情况
```

| 传统工具 | jcmd 替代 |
|---------|----------|
| `jps -l` | `jcmd` |
| `jstack -l <pid>` | `jcmd <pid> Thread.print -l` |
| `jmap -histo:live <pid>` | `jcmd <pid> GC.class_histogram` |
| `jmap -dump:live,...` | `jcmd <pid> GC.heap_dump <file>` |
| `jinfo -flags <pid>` | `jcmd <pid> VM.flags` |
| `jmap -heap <pid>`（JDK 9 已移除） | `jcmd <pid> GC.heap_info` 或 `jhsdb jmap --heap --pid <pid>` |

::: warning 会造成停顿的命令
`GC.class_histogram`、`GC.heap_dump`（不加 `-all` 时）会先做一次 Full GC；heap dump 本身也在安全点上进行，大堆可能停顿数秒到数十秒。生产环境先摘流量再执行，或在 OOM 时自动 dump。
:::

---

## 三、jps

```bash
jps          # 列出 Java 进程的 PID 和主类名
jps -lvm     # 显示完整主类名 + JVM 参数 + main 参数
```

`jps` 和 `jstat` 读取 `/tmp/hsperfdata_<用户名>/` 下的性能数据文件：换了用户执行、`/tmp` 不共享、或目标进程加了 `-XX:-UsePerfData` / `-XX:+PerfDisableSharedMem` 时，会"看不到进程"。

---

## 四、jstack（线程分析）

```bash
jstack <pid>                                  # 打印所有线程堆栈
jstack -l <pid> > thread_dump.txt             # 输出到文件（含锁信息）
jstack -l <pid> | grep -A 20 "deadlock"       # 快速查找死锁
jstack <pid> | grep "java.lang.Thread.State" | sort | uniq -c   # 统计各状态线程数
```

**线程状态：**

| 状态 | 说明 | 排查方向 |
|------|------|---------|
| `RUNNABLE` | 正在运行或等待 CPU；阻塞在 socket 读等本地调用时也显示为 RUNNABLE | CPU 高时看具体栈帧 |
| `BLOCKED` | 等待进入 `synchronized` 块 | 死锁 / 锁竞争热点，此状态不消耗 CPU |
| `WAITING` | 无限期等待（`Object.wait()` / `LockSupport.park()`） | 线程池空闲线程常见；大量业务线程 WAITING 需看在等什么 |
| `TIMED_WAITING` | 有超时的等待（`Thread.sleep()` / `wait(long)` / `parkNanos()`） | 一般正常 |

- 单次 dump 只是瞬间快照，**间隔几秒连续抓 3 次**对比，才能区分"一直卡住"和"刚好在执行"
- 高 CPU 线程定位（`top -H` → 十六进制 TID → 搜索 `nid=0x...`）见 [故障排查](./9_troubleshooting)

---

## 五、jmap 与 jhsdb（堆内存分析）

```bash
jmap -histo:live <pid> | head -30              # 存活对象统计（按占用排序，会触发 Full GC）
jmap -histo <pid> | head -20                   # 统计全部对象（含未回收），不触发 GC
jmap -dump:live,format=b,file=heap.hprof <pid> # 只导出存活对象（更小，会触发 Full GC）
jmap -dump:format=b,file=heap.hprof <pid>      # 导出全部对象

# JDK 9 起 jmap -heap 已移除，改用 jhsdb 查看堆配置与使用概况
jhsdb jmap --heap --pid <pid>
```

- `jhsdb` 基于 Serviceability Agent，执行期间目标进程会被**暂停**；日常查看堆概况优先用 `jcmd <pid> GC.heap_info`
- 更稳妥的做法是在启动参数中预先开启 OOM 自动 dump，dump 路径挂载到持久卷：

```bash
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/
```

---

## 六、jstat（实时 GC 监控）

```bash
jstat -gc <pid> 1000 10    # 每 1 秒输出一次，共 10 次
jstat -gcutil <pid> 1000   # 以百分比显示各区使用率
jstat -gccause <pid> 1000  # 在 gcutil 基础上显示最近一次 GC 原因
```

**`-gc` 输出字段：**

| 字段 | 说明 |
|------|------|
| S0C / S1C、S0U / S1U | Survivor 0/1 容量 / 已使用（KB） |
| EC / EU | Eden 容量 / 已使用 |
| OC / OU | 老年代容量 / 已使用 |
| MC / MU | Metaspace 容量 / 已使用 |
| CCSC / CCSU | 压缩类空间容量 / 已使用 |
| YGC / YGCT | Young GC 次数 / 总时间（秒） |
| FGC / FGCT | Full GC 次数 / 总时间 |
| CGC / CGCT | 并发 GC 暂停次数 / 时间（较新的 JDK 才有） |
| GCT | GC 总时间 |

**读数要点：**

- 每次 Young GC 后 OU 阶梯式上涨且 Full GC 后降不下来 → 疑似内存泄漏
- FGC 频繁增长 → 老年代不足、晋升过快或泄漏
- 不同收集器、不同 JDK 版本下 FGC 的统计口径有差异，结论以 GC 日志为准

---

## 七、NMT（Native Memory Tracking）

**NMT 统计 JVM 自身申请的堆外内存，是排查"进程 RSS 远大于 -Xmx"、容器 OOMKilled 的主要工具。** 需在启动时开启，有一定开销（summary 模式较小，detail 模式更大）。

```bash
# 启动时开启
-XX:NativeMemoryTracking=summary        # 或 detail（可看到调用栈）

jcmd <pid> VM.native_memory summary scale=MB    # 各区域 reserved / committed
jcmd <pid> VM.native_memory baseline            # 记录基线
jcmd <pid> VM.native_memory summary.diff scale=MB   # 与基线对比，看哪块在增长
```

| NMT 区域 | 含义 |
|---------|------|
| Java Heap | 堆 |
| Class | 类元数据（Metaspace、压缩类空间） |
| Thread | 线程栈 |
| Code | Code Cache |
| GC | GC 自身数据结构（如 G1 的记忆集、卡表） |
| Compiler / Internal / Symbol | JIT 编译器、JVM 内部结构、符号表 |
| Other | 包括通过 `Unsafe` 申请的直接内存（DirectByteBuffer），不同 JDK 版本归类可能不同 |

- 看 **committed**（实际提交）而不是 reserved（只是预留地址空间）
- NMT **统计不到** JNI 本地库自行 malloc 的内存；NMT 总量与 RSS 差距大时，要怀疑本地库或 glibc malloc arena

---

## 八、JFR 与 JMC

**JFR（JDK Flight Recorder）是 JVM 内置的事件录制器，默认配置开销很低，生产环境可常开。** JDK 11 起开源（JEP 328），并回移到 OpenJDK 8u262；此前是 Oracle JDK 的商业特性。

```bash
# 启动时开始录制
-XX:StartFlightRecording=duration=120s,filename=/data/app.jfr,settings=profile

# 运行中按需录制
jcmd <pid> JFR.start name=rec duration=60s filename=/data/app.jfr

# 命令行查看录制内容（JDK 12+ 自带 jfr 工具）
jfr summary /data/app.jfr
jfr print --events jdk.GarbageCollection /data/app.jfr
```

- 能录到：GC 与停顿、对象分配采样、方法采样（CPU 热点）、锁竞争、线程阻塞、IO、异常、类加载等
- `settings=default` 开销最低，`settings=profile` 采样更细、开销略高
- **JMC（JDK Mission Control）** 用来可视化分析 `.jfr` 文件；JDK 11 起不再随 JDK 分发，需要**单独下载**

---

## 九、MAT（Memory Analyzer Tool）

**分析 heap dump 的首选工具，重点看支配树和到 GC Roots 的引用链。**

1. 导入 `heap.hprof`（File → Open Heap Dump）；大 dump 需调大 MAT 自身的 `-Xmx`
2. 查看 **Leak Suspects Report**（自动分析可能的内存泄漏）
3. 查看 **Dominator Tree**（按 Retained Heap 排序，找真正占内存的对象）
4. 右键大对象 → **List Objects → with outgoing references**（看它引用了什么）
5. 右键对象 → **Path to GC Roots → exclude weak/soft references**（看为什么没被回收）
6. 使用 **OQL** 查询特定对象：`SELECT * FROM java.util.HashMap`

| 概念 | 含义 |
|------|------|
| Shallow Heap | 对象自身占用的内存 |
| Retained Heap | 该对象被回收后能一起释放的内存总量，定位泄漏看这个 |

---

## 十、VisualVM

```bash
jvisualvm   # JDK 6u7–JDK 8 自带；JDK 9 起不再随 JDK 分发，需从官网单独下载 VisualVM
```

- 适合开发、测试环境的实时观察：CPU / 内存曲线、线程、采样分析、打开 heap dump
- 插件推荐：**Visual GC**（实时显示各代内存变化）
- 生产环境更推荐 JFR 录制后离线分析，避免远程 JMX 暴露端口

---

## 十一、容器中使用诊断工具

**jcmd、jstack、jmap 都依赖 attach 机制**：工具在目标进程的临时目录创建 `.attach_pid<pid>` 文件并发送 `SIGQUIT`，目标 JVM 启动 Attach Listener，双方通过 `/tmp/.java_pid<pid>` 这个 Unix Domain Socket 通信。容器中 attach 失败，通常是以下条件不满足：

| 条件 | 常见失败原因 | 解决 |
|------|------------|------|
| 同一用户 | 工具以 root 或其他用户执行，而 JVM 以应用用户运行 | 切换到与目标进程相同的用户执行 |
| 同一 PID 命名空间 | 在宿主机上用宿主机 PID 去 attach 容器内进程 | 进入容器执行，容器内 Java 进程通常是 PID 1 |
| 共享 `/tmp` | 工具与目标进程看到的 `/tmp` 不是同一个，socket 文件找不到 | 在同一容器内执行，或使用 sidecar 时共享 `/tmp` 卷 |
| 镜像里有工具 | 只装了 JRE 或精简镜像，没有 jcmd | 使用 JDK 镜像，或使用独立的 **jattach** 工具 |
| 未禁用 attach | 启动参数带了 `-XX:+DisableAttachMechanism` | 去掉该参数 |

```bash
# 推荐：进入容器，以应用用户执行 jcmd
kubectl exec -it <pod> -- jcmd 1 Thread.print

# 镜像中没有 JDK 工具时：jattach 是独立的小工具，可处理容器命名空间
jattach <pid> threaddump
jattach <pid> jcmd "GC.heap_info"
```

::: tip 生产环境的兜底配置
attach 随时可能不可用，关键现场要靠启动参数预留：`-XX:+HeapDumpOnOutOfMemoryError`、常开的 GC 日志、按需常开的 JFR。
:::

---

## 小结

- JDK 9+ 以 `jcmd` 为诊断总入口，`jmap -heap` 已移除，改用 `jcmd GC.heap_info` 或 `jhsdb jmap --heap`
- 线程问题用 `Thread.print` / `jstack` 连续抓多次；GC 趋势用 `jstat`；堆内容用 heap dump + MAT 看 Retained Heap 和 GC Roots 引用链
- 堆外内存用 NMT（`baseline` + `summary.diff`）核算，NMT 统计不到本地库自行申请的内存
- JFR 开销低、可常开，JDK 11 起开源；JMC、VisualVM 需单独下载
- 容器中 attach 失败多半是用户、PID 命名空间或 `/tmp` 不一致，进入容器执行 jcmd 或使用 jattach

> 下一篇：[故障排查](./9_troubleshooting) —— 把这些工具串成流程，逐类处理 OOM、CPU 飙高、死锁与类加载问题。

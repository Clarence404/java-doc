---
description: 堆与内存参数、容器参数、GC 选择、GC 日志配置与关键字、jcmd / jstat 运行时查看
---

# JVM 参数与 GC 日志速查

> 前置阅读：[GC 调优](/jvm/6_gc_tuning)、[诊断工具](/jvm/8_monitoring_tools)、[故障排查](/jvm/9_troubleshooting)

本篇按场景列出常用 JVM 启动参数、GC 日志配置与日志关键字，以及运行时查看参数和 GC 状态的命令，基线为 JDK 21 / 25。

---

## 一、堆与内存参数

| 场景 | 命令 | 说明 |
|------|------|------|
| 固定堆大小 | `-Xms4g -Xmx4g` | 初始堆等于最大堆，避免运行中扩缩容；物理机 / 虚机常用 |
| 线程栈大小 | `-Xss1m` | 递归深的应用可调大；线程多时调小可省内存 |
| 限制元空间 | `-XX:MaxMetaspaceSize=512m` | 默认不设上限，动态生成类泄漏时会吃光本机内存 |
| 限制直接内存 | `-XX:MaxDirectMemorySize=1g` | 默认约等于 `-Xmx`，Netty 等大量用堆外内存的应用要显式设置 |
| 限制代码缓存 | `-XX:ReservedCodeCacheSize=256m` | 代码缓存满会停止 JIT 编译，日志出现 `CodeCache is full` |
| OOM 时自动转储堆 | `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/` | 路径写目录时文件名为 `java_pid<pid>.hprof`；目录要有足够磁盘空间 |
| OOM 后直接退出 | `-XX:+ExitOnOutOfMemoryError` | 进程退出后由 K8s / systemd 拉起，避免半死不活；与上一条可同时使用 |
| 开启 NMT | `-XX:NativeMemoryTracking=summary` | 排查堆外内存时开启，有少量性能开销；配合 `jcmd <pid> VM.native_memory summary` |
| 紧凑对象头（JDK 25） | `-XX:+UseCompactObjectHeaders` | 对象头从 12 字节压到 8 字节，小对象多的应用堆占用明显下降 |

---

## 二、容器参数

| 场景 | 命令 | 说明 |
|------|------|------|
| 按容器内存比例设堆 | `-XX:MaxRAMPercentage=75.0` | 堆上限为容器 limit 的 75%，剩余留给元空间、线程栈、直接内存 |
| 初始堆比例 | `-XX:InitialRAMPercentage=75.0` | 与上一条取相同值，效果等同 `-Xms` 等于 `-Xmx` |
| 指定可用 CPU 数 | `-XX:ActiveProcessorCount=2` | 只设 CPU request 不设 limit 时，JVM 会按宿主机核数创建 GC / JIT 线程 |
| 查看 JVM 识别的容器限制 | `java -XshowSettings:system -version` | 输出容器的 CPU 与内存限制，确认 cgroup 识别正确 |
| 查看容器探测日志 | `java -Xlog:os+container=info -version` | 打印 cgroup 版本与读取到的各项限制 |
| 查看最终生效的默认值 | `java -XX:MaxRAMPercentage=75.0 -XX:+PrintFlagsFinal -version > flags.txt` | 在容器内执行，再用 `grep -w MaxHeapSize flags.txt` 查看算出的堆上限 |

---

## 三、GC 选择与调优参数

| 场景 | 命令 | 说明 |
|------|------|------|
| 使用 G1 | `-XX:+UseG1GC` | 服务端默认收集器；容器内 CPU 少于 2 或内存少于 1792 MB 时默认会退化为 Serial，建议显式指定 |
| G1 停顿目标 | `-XX:MaxGCPauseMillis=200` | 目标值不是保证值，设得过低会导致年轻代过小、GC 更频繁 |
| G1 提前并发标记 | `-XX:InitiatingHeapOccupancyPercent=45` | 老年代增长快、出现 Full GC 时调低；默认会自适应调整 |
| G1 Region 大小 | `-XX:G1HeapRegionSize=16m` | 大对象（超过 Region 一半）多时调大，减少 Humongous 分配 |
| G1 并发线程数 | `-XX:ConcGCThreads=2` | 并发标记跟不上分配速度时调大 |
| 使用 ZGC | `-XX:+UseZGC` | JDK 23 起默认分代模式，JDK 24 起不再支持非分代，无需再加 `ZGenerational` |
| ZGC 软上限 | `-XX:SoftMaxHeapSize=3g` | ZGC 尽量把堆控制在该值以内，`-Xmx` 留作突发余量 |
| 使用分代 Shenandoah（JDK 25） | `-XX:+UseShenandoahGC -XX:ShenandoahGCMode=generational` | JDK 25 起分代模式为正式特性 |
| 禁止代码里的 System.gc() | `-XX:+DisableExplicitGC` | 用了 NIO 直接内存的应用慎用，可能导致直接内存回收不及时 |
| 让 System.gc() 走并发回收 | `-XX:+ExplicitGCInvokesConcurrent` | G1 下把显式 GC 变成并发周期，替代上一条的折中方案 |

---

## 四、GC 日志配置

| 场景 | 命令 | 说明 |
|------|------|------|
| 生产标准配置 | `-Xlog:gc*:file=/data/logs/gc-%p-%t.log:time,uptime,level,tags:filecount=10,filesize=50m` | `%p` 为 PID，`%t` 为启动时间，避免重启覆盖；滚动保留 10 个文件 |
| 只看 GC 摘要 | `-Xlog:gc:file=/data/logs/gc.log:time,uptime` | 每次 GC 一行，适合长期开启、量小 |
| 看对象晋升年龄 | `-Xlog:gc+age=trace` | 输出 Survivor 中各年龄对象大小，判断是否过早晋升 |
| 看各阶段耗时 | `-Xlog:gc+phases=debug` | 输出每次停顿内部各阶段耗时，定位停顿长在哪一步 |
| 看安全点耗时 | `-Xlog:safepoint=info` | 排查「GC 很快但停顿很长」，关注到达安全点的耗时 |
| 运行中开启 GC 日志 | `jcmd <pid> VM.log output=/tmp/gc-rt.log what='gc*' decorators=time,uptime,level,tags` | 不重启即可补开日志，排查完用下一条关闭 |
| 运行中关闭日志 | `jcmd <pid> VM.log disable` | 关闭全部统一日志并清空配置，启动时配置的 GC 日志也会被关掉 |
| 查看当前日志配置 | `jcmd <pid> VM.log list` | 列出各输出目标、标签与级别 |
| 手动滚动日志 | `jcmd <pid> VM.log rotate` | 立即切换到新文件，便于截取某一时段的日志 |

---

## 五、GC 日志关键字

以下以 G1 为例，日志由第四节的标准配置产生。

| 场景 | 命令 | 说明 |
|------|------|------|
| 统计 Full GC | `grep -c "Pause Full" gc.log` | G1 出现 Full GC 即异常，括号内为原因，如 `(G1 Compaction Pause)` |
| 找疏散失败 | `grep -e "Evacuation Failure" -e "To-space exhausted" gc.log` | 复制存活对象时空间不足；JDK 21 起写作 `Evacuation Failure`，旧版本为 `To-space exhausted` |
| 找大对象分配 | `grep "Humongous Allocation" gc.log` | 大对象触发的 GC，频繁出现时调大 Region 或改代码避免大数组 |
| 找元空间触发的 GC | `grep "Metadata GC Threshold" gc.log` | 元空间达到阈值触发，持续出现说明类在不断加载 |
| 找代码里的显式 GC | `grep "System.gc()" gc.log` | 来自业务代码、RMI 或直接内存回收 |
| 找混合回收 | `grep "Pause Young (Mixed)" gc.log` | 并发标记后回收部分老年代，正常现象 |
| 找并发标记周期 | `grep -e "Concurrent Mark Cycle" -e "Pause Remark" gc.log` | 一个完整的老年代并发标记周期 |
| 找 ZGC 分配停滞 | `grep "Allocation Stall" gc.log` | ZGC 回收速度跟不上分配速度，线程被迫等待，需加大堆或 CPU |
| 看单次停顿时长 | `grep "Pause Young" gc.log` | 行尾为停顿毫秒数，`512M->128M(2048M)` 为回收前、回收后与堆总大小 |
| 找长时间安全点 | `grep "Reaching safepoint" gc.log` | 需开启 `-Xlog:safepoint`；到达耗时长通常是大循环、大数组拷贝 |

---

## 六、运行时查看与调整

| 场景 | 命令 | 说明 |
|------|------|------|
| 列出 Java 进程 | `jcmd -l` | 等同 `jps -l`；容器内需与目标进程同一用户 |
| 看实际生效的参数 | `jcmd <pid> VM.flags` | 只列出被设置过的参数，含 JVM 自动计算的值 |
| 看完整启动命令 | `jcmd <pid> VM.command_line` | 确认参数是否真的传进去了，常见于脚本拼接错误 |
| 看系统属性 | `jcmd <pid> VM.system_properties` | 查看 `file.encoding`、`user.timezone` 等 |
| 看 JVM 综合信息 | `jcmd <pid> VM.info` | 版本、参数、内存、GC、容器信息一次输出 |
| 看堆概况 | `jcmd <pid> GC.heap_info` | 各代或各 Region 的容量与使用量 |
| 看对象直方图 | `jcmd <pid> GC.class_histogram` | 按类统计实例数与字节数；会触发 Full GC，高峰期慎用 |
| 导出堆转储 | `jcmd <pid> GC.heap_dump -gz=1 /data/dump/heap-%p.hprof` | 只转储存活对象并压缩；`%p` 替换为 PID 需 JDK 24+（JDK-8334492）；转储期间进程暂停，先摘流量 |
| 看堆外内存 | `jcmd <pid> VM.native_memory summary scale=MB` | 需启动时开启 NMT；先 `baseline` 再 `summary.diff` 可看增长 |
| 归还 glibc 空闲内存 | `jcmd <pid> System.trim_native_heap` | 仅 Linux；RSS 远大于堆 + 堆外时可尝试 |
| 运行中改可管理参数 | `jcmd <pid> VM.set_flag HeapDumpOnOutOfMemoryError true` | 只有 `manageable` 参数能改，用 `VM.flags -all` 查看 |
| 录制 JFR | `jcmd <pid> JFR.start name=diag duration=60s settings=profile filename=/tmp/diag.jfr` | 录制 60 秒后自动落盘，用 JMC 打开分析 |
| 每秒看 GC 统计 | `jstat -gcutil <pid> 1000 10` | 每 1 秒输出 1 行共 10 行；O 列持续接近 100% 且 FGC 增长说明老年代回收不掉 |
| 看最近一次 GC 原因 | `jstat -gccause <pid> 1000` | 在 `-gcutil` 基础上增加 LGCC（上次原因）与 GCC（当前原因） |

---

## 七、启动参数模板

容器内 Spring Boot 服务的常用组合，按需删减：

```bash
java \
  -XX:MaxRAMPercentage=75.0 -XX:InitialRAMPercentage=75.0 \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:+ExitOnOutOfMemoryError \
  -Xlog:gc*:file=/data/logs/gc-%p-%t.log:time,uptime,level,tags:filecount=10,filesize=50m \
  -jar app.jar
```

::: tip 堆转储目录要挂卷
容器可写层在容器重启后丢失，emptyDir 在 Pod 重建后丢失。`HeapDumpPath` 与 GC 日志目录要挂载持久卷，或由 sidecar 及时上传，否则 OOM 现场随 Pod 一起消失。
:::

---

## 小结

最常用的 5 条：

1. `-XX:MaxRAMPercentage=75.0`：容器内按内存比例设堆
2. `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/`：保留 OOM 现场
3. `-Xlog:gc*:file=/data/logs/gc-%p-%t.log:time,uptime,level,tags:filecount=10,filesize=50m`：生产 GC 日志
4. `jstat -gcutil <pid> 1000 10`：实时看 GC 是否异常
5. `jcmd <pid> VM.flags`：确认参数实际生效

参数背后的原理与调优思路见 [GC 调优](/jvm/6_gc_tuning)，按症状排查见 [故障排查](/jvm/9_troubleshooting)。

---

## 参考资料

- java 命令参数：[The java Command（JDK 25）](https://docs.oracle.com/en/java/javase/25/docs/specs/man/java.html)
- jcmd 诊断命令：[The jcmd Command（JDK 25）](https://docs.oracle.com/en/java/javase/25/docs/specs/man/jcmd.html)
- jstat 输出列含义：[The jstat Command（JDK 25）](https://docs.oracle.com/en/java/javase/25/docs/specs/man/jstat.html)
- G1 调优：[Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/25/gctuning/garbage-first-garbage-collector-tuning.html)
- 统一日志：[JEP 158: Unified JVM Logging](https://openjdk.org/jeps/158)
- 紧凑对象头：[JEP 519: Compact Object Headers](https://openjdk.org/jeps/519)
- 分代 Shenandoah：[JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)

> 下一篇：[MySQL 排查速查](./5_mysql)

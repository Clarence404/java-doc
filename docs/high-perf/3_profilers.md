---
description: async-profiler 与火焰图、JFR、JProfiler、工具选择
---

# 性能分析工具

> 前置阅读：[性能分析方法论](./2_methodology)

本篇聚焦采样型 / 图形化 Profiler：用 async-profiler 抓火焰图并读懂它，用 JFR 做常驻录制，并说明不同场景该选哪个 Profiler。

---

## 一、async-profiler

源码：[github.com/async-profiler/async-profiler](https://github.com/async-profiler/async-profiler)

**开源、低开销的采样 Profiler，生产环境可用，输出火焰图。** 它基于 HotSpot 的 `AsyncGetCallTrace` 与 Linux `perf_events` 采样，不需要等线程进入 Safepoint，因此没有传统 Profiler 的 Safepoint 偏差，还能看到 native 与内核栈。

```bash
# 采样 CPU 30 秒，生成 HTML 火焰图（3.x 为 asprof，2.x 为 profiler.sh）
asprof -d 30 -f /tmp/cpu.html <pid>

# 采样内存分配 / 锁竞争
asprof -e alloc -d 30 -f /tmp/alloc.html <pid>
asprof -e lock  -d 30 -f /tmp/lock.html  <pid>

# wall-clock 模式：同时采样运行与阻塞中的线程，用于分析"CPU 不高但很慢"；-t 按线程拆分
asprof -e wall -t -d 30 -f /tmp/wall.html <pid>
```

Arthas 内置了 async-profiler，无需单独部署：

```bash
profiler start               # 默认采样 CPU
profiler stop --format html  # 停止并输出 HTML 火焰图
```

::: tip 容器内使用
容器中采样 `cpu` 事件依赖 `perf_events`，可能受 `perf_event_paranoid` 或容器安全策略限制；此时可改用 `-e itimer`，或按官方文档调整权限。
:::

---

## 二、读火焰图

### 1、基本规则

| 元素 | 含义 |
|------|------|
| 每个矩形 | 一个栈帧（方法） |
| 纵轴（自下而上） | 调用栈：下层调用上层，最底部是线程入口，最顶部是采样时正在执行的方法 |
| 横轴宽度 | 该方法（含其调用的子方法）在样本中出现的比例，**越宽越耗资源** |
| 横轴顺序 | 按字母排序合并相同栈，**不代表时间先后** |
| 颜色 | async-profiler 中通常区分 Java（绿）、JIT 内联（青）、C++/JVM（黄）、内核（橙）、native（红），颜色本身不表示热度 |

### 2、分析步骤

1. **找"平顶"**：顶部宽而平的矩形，表示该方法自身消耗了大量样本（self time），是直接热点。
2. **找"宽塔"**：某个中间层方法很宽，说明其下整个调用子树耗资源多，从这里向上展开看是哪个分支。
3. **点击放大、搜索高亮**：HTML 火焰图中点击某帧可放大到该子树，搜索框可高亮匹配的方法（如搜索业务包名）。
4. **对照业务代码**：序列化、正则、日志、反射、集合扩容等出现在顶部，往往是可以优化的信号。

### 3、不同事件的火焰图

| 事件 | 宽度代表 | 常见发现 |
|------|----------|----------|
| `cpu` | CPU 时间 | 计算热点、序列化、正则、GC 线程占比 |
| `wall` | 墙钟时间（含阻塞、等待） | 等待下游、等待锁、等待连接池；需结合 `-t` 按线程分开查看 |
| `alloc` | 分配的字节数 | 大量临时对象、集合扩容、字符串拼接，解释 GC 频繁的根因 |
| `lock` | 锁等待时间 | 竞争激烈的 `synchronized` / `ReentrantLock` 及其调用方 |

### 4、常见误区

- **把等待当热点**：wall 模式下 `Thread.sleep`、`Unsafe.park`、`epoll_wait` 很宽只说明线程在空闲或等待，要看**是谁在等、在等什么**。
- **只采样几秒**：样本太少有偶然性，一般采样 30～60 秒，并确保采样期间问题正在发生。
- **低负载时采样**：瓶颈往往只在高负载下出现，应在压测或高峰期采样。

---

## 三、JFR（JDK Flight Recorder）

**JDK 内置的事件录制器，默认配置开销通常在 1%～2% 以内，适合在生产环境持续录制，问题发生后回溯分析。** JDK 11 起开源免费，OpenJDK 8u262 起也已包含。

```bash
# 启动时开启，持续录制，保留最近 6 小时，退出时落盘
java -XX:StartFlightRecording=name=bg,settings=default,maxage=6h,dumponexit=true,filename=/data/jfr/app.jfr -jar app.jar

# 运行时对已启动的进程录制 60 秒（profile 模板采样更细，开销略高）
jcmd <pid> JFR.start name=diag settings=profile duration=60s filename=/tmp/diag.jfr

# 持续录制中，导出当前内存中的数据
jcmd <pid> JFR.dump name=bg filename=/tmp/snapshot.jfr
```

- 录制文件用 **JDK Mission Control（JMC）** 打开，可查看方法热点、分配、GC、锁、IO、异常等事件。
- 也可以用 async-profiler 自带的转换器 `jfrconv` 把 JFR 转成火焰图，或用 `jfr print` 命令行查看事件。

---

## 四、JProfiler

官网：[ej-technologies.com/jprofiler](https://www.ej-technologies.com/jprofiler)

**商业图形化 Profiler，适合开发 / 测试阶段深度分析。** 支持采样与插桩两种模式，插桩模式数据更精确但开销明显更高。

| 功能 | 说明 |
|------|------|
| CPU Profiling | 方法级 CPU 时间，生成调用树与热点列表 |
| 内存分析 | 对象分配堆栈、堆快照、内存泄漏检测 |
| 线程分析 | 线程时间线、锁竞争热点 |
| JDBC / HTTP 探针 | SQL、HTTP 调用的执行时间与次数 |

---

## 五、如何选择

命令行诊断工具见：

- JDK 自带工具（jps / jstack / jmap / jstat / MAT 等）→ [JVM 诊断工具](/jvm/8_monitoring_tools)
- Arthas 在线诊断（dashboard / trace / watch / jad / ognl 等）→ [线上诊断](/engineering/4_diagnosis)
- 按故障类型排查及常见问题速查表 → [JVM 故障排查](/jvm/9_troubleshooting)

| 工具 | 开销 | 生产可用 | 分析维度 | 优势 | 局限 |
|------|------|----------|----------|------|------|
| async-profiler | 低 | 是 | CPU、wall-clock、分配、锁、硬件事件 | 无 Safepoint 偏差，可看到 native 与内核栈，火焰图直观 | 主要支持 Linux / macOS |
| Arthas `profiler` | 低 | 是 | 同 async-profiler | 无需额外部署，与 `trace` / `watch` 配合排障 | 需 attach 到进程；是 async-profiler 的封装 |
| JFR + JMC | 很低 | 是，可常驻 | CPU、分配、GC、锁、IO、异常等事件 | JDK 内置、可持续录制、事后回溯 | CPU 采样粒度较粗，JMC 有学习成本 |
| JProfiler | 中～高（插桩模式更高） | 谨慎，通常用于测试环境 | CPU、内存、线程、JDBC、HTTP 等 | 图形界面强大，调用树和内存泄漏分析方便 | 商业授权，开销较大 |

选择建议：

- **生产环境突发问题**：先用 Arthas `dashboard` / `thread` 看整体，再用 `profiler` 或 async-profiler 抓 30～60 秒火焰图。
- **偶发、难复现的问题**：常驻 JFR，问题发生后用 `JFR.dump` 导出最近时间段的录制。
- **开发 / 测试环境深度分析**：JProfiler 或 JMC，逐层查看调用树与对象分配。
- **微观代码对比**：不要用 Profiler 下结论，用 [JMH](./4_benchmark) 验证。

---

## 小结

- async-profiler 无 Safepoint 偏差、开销低，是生产抓火焰图的首选；Arthas `profiler` 是它的封装
- 读火焰图看宽度不看顺序：找平顶（自身热点）和宽塔（热点子树），wall 模式下的等待帧不是热点
- 按问题选事件：CPU 高用 `cpu`，CPU 低但慢用 `wall`，GC 频繁用 `alloc`，锁竞争用 `lock`
- JFR 适合常驻录制、事后回溯；JProfiler 适合测试环境深度分析

> 下一篇：[基准测试（JMH）](./4_benchmark) —— Profiler 找到热点后，用 JMH 可靠地比较不同实现。

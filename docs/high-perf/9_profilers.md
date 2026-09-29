# 性能分析工具

> 本文聚焦图形化 / 采样型 Profiler。命令行诊断工具见：
> - JDK 自带工具（jps / jstack / jmap / jstat / MAT / JFR 等）→ [JVM 监控工具](/jvm/8_monitoring_tools)
> - Arthas 在线诊断（dashboard / trace / watch / jad / ognl 等）→ [线上诊断](/engineering/4_diagnosis)
> - 按故障类型排查及常见问题速查表 → [JVM 故障排查](/jvm/9_troubleshooting)
> - 分析思路与瓶颈定位流程 → [性能分析方法论](/high-perf/2_methodology)

---

## 一、JProfiler（商业工具）

官网：[ej-technologies.com/jprofiler](https://www.ej-technologies.com/jprofiler)

JProfiler 提供图形界面，适合开发阶段深度分析：

| 功能 | 说明 |
|------|------|
| CPU Profiling | 方法级 CPU 时间采样，生成调用树 |
| 内存分析 | 对象分配堆栈、内存泄漏检测 |
| 线程分析 | 线程时间线、锁竞争热点 |
| JDBC 监控 | SQL 执行时间、慢查询 |

---

## 二、async-profiler 与火焰图

源码：[github.com/async-profiler/async-profiler](https://github.com/async-profiler/async-profiler)

开源低开销采样 Profiler，基于 `AsyncGetCallTrace` + `perf_events`，无 Safepoint 偏差，可生产使用，输出**火焰图**（横轴宽度 = 采样占比，越宽越热；纵轴 = 调用栈深度）。

```bash
# 采样 CPU 30 秒，生成 HTML 火焰图（3.x 为 asprof，2.x 为 profiler.sh）
asprof -d 30 -f /tmp/cpu.html <pid>

# 采样内存分配 / 锁竞争
asprof -e alloc -d 30 -f /tmp/alloc.html <pid>
asprof -e lock  -d 30 -f /tmp/lock.html  <pid>

# wall-clock 模式：同时采样运行与阻塞中的线程，用于分析"CPU 不高但很慢"
asprof -e wall -t -d 30 -f /tmp/wall.html <pid>

# Arthas 内置 async-profiler
profiler start
profiler stop --format html
```

---

## 三、JFR（JDK Flight Recorder）

JFR 内置于 JDK（JDK 11 起开源免费，JDK 8u262+ 也已包含），开销通常低于 1%～2%，适合在生产环境**持续录制**，问题发生后回溯分析。

```bash
# 启动时开启，持续录制，保留最近 6 小时，退出时落盘
java -XX:StartFlightRecording=name=bg,settings=default,maxage=6h,dumponexit=true,filename=/data/jfr/app.jfr -jar app.jar

# 运行时对已启动的进程录制 60 秒（profile 模板采样更细，开销略高）
jcmd <pid> JFR.start name=diag settings=profile duration=60s filename=/tmp/diag.jfr
```

录制文件用 **JDK Mission Control（JMC）** 打开，可查看方法热点、分配、GC、锁、IO、异常等事件；也可以用 async-profiler 自带的转换器（`jfrconv`）把 JFR 转成火焰图。

---

## 四、如何选择 Profiler

| 工具 | 开销 | 生产可用 | 分析维度 | 优势 | 局限 |
|------|------|----------|----------|------|------|
| JFR + JMC | 很低 | 是，可常驻 | CPU、分配、GC、锁、IO、异常等事件 | JDK 内置、可持续录制、事后回溯 | CPU 采样粒度较粗，JMC 学习成本 |
| async-profiler | 低 | 是 | CPU、wall-clock、分配、锁、硬件事件 | 无 Safepoint 偏差，可看到 native 与内核栈，火焰图直观 | 主要支持 Linux / macOS |
| Arthas `profiler` | 低 | 是 | 同 async-profiler | 无需额外部署，与 `trace` / `watch` 配合排障 | 需 attach 到进程；功能是 async-profiler 的封装 |
| JProfiler | 中～高（插桩模式更高） | 谨慎，通常用于测试环境 | CPU、内存、线程、JDBC、HTTP 等 | 图形界面强大，内存泄漏和调用树分析方便 | 商业授权，开销较大 |

选择建议：

- **生产环境突发问题**：先用 Arthas `dashboard` / `thread` 看整体，再用 `profiler` 或 async-profiler 抓 30～60 秒火焰图。
- **偶发、难复现的问题**：常驻 JFR，问题发生后导出最近时间段的录制。
- **开发 / 测试环境深度分析**：JProfiler 或 JMC，逐层查看调用树与对象分配。
- **微观代码对比**：不要用 Profiler 下结论，用 [JMH](/high-perf/3_benchmark) 验证。

---

## 五、读火焰图

### 1、基本规则

| 元素 | 含义 |
|------|------|
| 每个矩形 | 一个栈帧（方法） |
| 纵轴（自下而上） | 调用栈：下层调用上层，最底部是线程入口，最顶部是采样时正在执行的方法 |
| 横轴宽度 | 该方法（含其调用的子方法）在采样中出现的比例，**越宽越耗资源** |
| 横轴顺序 | 按字母排序合并相同栈，**不代表时间先后** |
| 颜色 | async-profiler 中通常区分 Java（绿）、JIT 内联（青）、C++/JVM（黄）、内核（橙）、native（红），颜色本身不表示热度 |

### 2、分析步骤

1. **找"平顶"**：顶部宽而平的矩形，表示该方法自身消耗了大量样本（self time），是直接热点。
2. **找"宽塔"**：某个中间层方法很宽，说明其下的整个调用子树耗资源多，从这里向上展开看是哪个分支。
3. **点击放大**：在 HTML 火焰图中点击某个帧可放大到该子树，搜索框可高亮匹配的方法（如搜索业务包名）。
4. **对照业务代码**：确认热点是否合理——序列化、正则、日志、反射、集合扩容等出现在顶部往往是可以优化的信号。

### 3、不同事件的火焰图

| 事件 | 宽度代表 | 常见发现 |
|------|----------|----------|
| `cpu` | CPU 时间 | 计算热点、序列化、正则、GC 线程占比 |
| `wall` | 墙钟时间（含阻塞、等待） | 等待下游、等待锁、等待连接池；需结合 `-t` 按线程分开查看 |
| `alloc` | 分配的字节数 | 大量临时对象、集合扩容、字符串拼接，解释 GC 频繁的根因 |
| `lock` | 锁等待时间 | 竞争激烈的 `synchronized` / `ReentrantLock` 及其调用方 |

### 4、常见误区

- 看到 `Thread.sleep`、`Unsafe.park`、`epoll_wait` 很宽就以为是热点：在 wall 模式下这只是线程空闲或等待，需要看**是谁在等、在等什么**。
- 只采样几秒：样本太少会有偶然性，一般采样 30～60 秒，并确保采样期间问题正在发生。
- 在低负载时采样：瓶颈往往只在高负载下出现，应在压测或高峰期采样。

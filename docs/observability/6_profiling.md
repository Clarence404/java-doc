---
description: 持续剖析原理与开销、Java 方案、eBPF 原理、eBPF 剖析与自动插桩、平台选型、落地与风险
---

# 持续剖析与 eBPF

> 前置阅读：[性能分析工具](/high-perf/3_profilers)、[链路追踪](./3_tracing)、[用户态、内核态与系统调用](/os/2_kernel_mode)

持续剖析（Continuous Profiling）让 Profiler 在生产环境一直低开销地采样，把「哪段代码在耗资源」变成可以随时回看的第四种信号。本篇讲持续剖析的原理与 Java 方案、eBPF 的工作方式与可观测用法、平台选型与落地风险，基线为 JDK 21、Linux 6。

---

## 一、为什么需要持续剖析

### 1、从「出事后抓」到「一直在线」

传统做法是问题发生时登录机器，用 async-profiler 或 Arthas 抓 30～60 秒火焰图（读法见 [性能分析工具](/high-perf/3_profilers#二、读火焰图)）。这种方式有三个硬伤：

- **问题已经过去**：偶发的 CPU 尖刺、几分钟的 GC 风暴，等人登录时现场早已消失
- **没有基线**：只有「出事时」的火焰图，没有「平时」的火焰图可以对比，很难判断某个方法变宽是不是异常
- **依赖人和权限**：容器里 attach 受限、生产机器登录要审批，越紧急越慢

持续剖析的做法是：每个进程常驻一个低频采样器，按固定周期（通常 10～60 秒）把聚合后的调用栈上报到服务端，打上服务、版本、Pod 等标签长期存储。排障时直接在界面上选时间段和标签查看火焰图，或把两个时间段、两个版本做差分对比。

### 2、和其他信号的关系

| 信号 | 回答的问题 | 粒度 |
|------|------------|------|
| 指标 | CPU 是不是高了、P99 是不是涨了 | 服务 / 实例 |
| 链路 | 慢在哪个服务的哪个 Span | 请求 / 调用 |
| 日志 | 那一步发生了什么事件、什么异常 | 事件 |
| Profiles | 这段时间 CPU、内存、锁花在哪些方法上 | 代码行 / 调用栈 |

链路能告诉你「`OrderService.create` 这个 Span 花了 800ms」，但 Span 内部没有埋点的代码是一片空白；Profiles 正好补上这一段。两者关联的方式叫 **trace-to-profile**：采样时把当前 Span 的 `span_id` 作为标签写进 profile，界面上从一个慢 Span 直接跳到只包含该 Span 期间样本的火焰图。

![持续剖析架构](../assets/observability/profiling-architecture.svg)

OpenTelemetry 已把 Profiles 定义为与 traces、metrics、logs 并列的信号，2026 年 3 月进入公开 Alpha，数据模型仍可能变化，状态以 [OpenTelemetry](./5_opentelemetry#_3、信号成熟度) 与官方 Status 页为准；当前生产上主流仍是 Pyroscope、Parca 等平台自己的协议（多为 pprof 格式）。

---

## 二、采样原理与开销

### 1、四类常用采样

| 类型 | 触发方式 | 火焰图宽度代表 | 典型用途 |
|------|----------|----------------|----------|
| CPU | 按 CPU 时间定时中断（`perf_events` 或 `itimer`），记录正在运行线程的栈 | CPU 时间 | 计算热点、序列化、正则 |
| Wall-clock | 按墙钟时间定时对所有线程采样，含阻塞线程 | 墙钟时间 | CPU 不高但接口慢：等下游、等锁、等连接 |
| Alloc | 每分配一定字节（如 512KB）记录一次分配栈 | 分配字节数 | GC 频繁的根因 |
| Lock | 锁等待超过阈值时记录等待方的栈 | 锁等待时间 | `synchronized` / `ReentrantLock` 竞争 |

采样型 Profiler 不记录每次调用，而是统计「某个栈在样本里出现了多少次」，样本足够多时比例就逼近真实耗时分布。

### 2、采样频率与开销

- **频率**：持续剖析通常每秒 19～100 次（10～50ms 一次）。频率选质数（如 19Hz、99Hz）是为了避免和周期性任务同频，导致总是采到同一段代码
- **开销来源**：每次采样的栈遍历、样本在内存中聚合、周期性压缩上报。按官方说明，async-profiler 与 JFR 默认配置下 CPU 开销通常在 1%～2% 以内，eBPF 方案在内核里完成栈采集与计数，开销通常更低
- **按事件控制**：CPU 和 Alloc 常开；Wall-clock 样本量随线程数线性增长，线程多的服务只在需要时短时打开；Lock 设置合理阈值（如 10ms），避免记录大量短暂竞争

### 3、安全点偏差

JVMTI 的 `GetAllStackTraces` 一类接口只能在线程到达安全点（Safepoint）时取栈，样本会偏向安全点附近的代码，热点循环反而看不到。async-profiler 基于 `AsyncGetCallTrace` 与 `perf_events`，JFR 有自己的异步栈采样，二者都没有这个问题；细节见 [性能分析工具](/high-perf/3_profilers#一、async-profiler)。

---

## 三、Java 方案

### 1、JFR 持续录制

JFR 是 JDK 自带、可常开的事件录制器，命令详解见 [诊断工具](/jvm/8_monitoring_tools#八、jfr-与-jmc)。用作持续剖析时，关键是**限制保留量**并**定期取出上报**：

```bash
# 常驻录制：磁盘上最多保留 1 小时或 500MB，循环覆盖
java -XX:StartFlightRecording=name=continuous,settings=default,maxage=1h,maxsize=500m,disk=true \
     -XX:FlightRecorderOptions=repository=/data/jfr \
     -jar order-service.jar
```

上报有两种方式：

- **外部定期导出**：Sidecar 或定时任务执行 `jcmd <pid> JFR.dump name=continuous filename=...` 导出最近的数据，上传到 Pyroscope（支持 JFR 格式接入）或对象存储
- **进程内流式消费**：JDK 14 起提供 JFR Event Streaming（JEP 349），可在进程内订阅事件，自己聚合后上报

```java
var rs = new RecordingStream();
rs.enable("jdk.ExecutionSample").withPeriod(Duration.ofMillis(20));
rs.onEvent("jdk.ExecutionSample", e -> aggregator.add(e.getStackTrace()));
rs.startAsync();   // 在后台线程持续消费，应用关闭时调用 rs.close()
```

JFR 的优势是零依赖、事件丰富（GC、IO、线程、异常都有）；不足是默认 CPU 采样间隔较粗，且看不到 native 与内核栈。

### 2、async-profiler 持续模式

async-profiler 可以作为 agent 随进程启动，用 `loop` 参数按周期滚动输出文件：

```bash
java -agentpath:/opt/async-profiler/lib/libasyncProfiler.so=start,event=cpu,alloc=512k,lock=10ms,loop=1m,file=/data/prof/%t.jfr \
     -jar order-service.jar
```

每分钟生成一个 JFR 格式文件（同时包含 CPU、分配、锁样本），由采集程序上传。适合想保留 async-profiler 精度（含 native 与内核栈）又不想引入新平台 SDK 的场景。

### 3、Pyroscope Java agent

Grafana Pyroscope 的 Java agent 内部封装了 async-profiler，负责采样、按标签聚合和周期上报，是目前 Java 接入持续剖析最省事的方式：

```bash
export PYROSCOPE_APPLICATION_NAME=order-service
export PYROSCOPE_SERVER_ADDRESS=http://pyroscope.observability:4040
export PYROSCOPE_FORMAT=jfr                 # 用 JFR 格式上报，才能同时带上分配与锁样本
export PYROSCOPE_PROFILER_EVENT=itimer      # 容器内 perf_events 受限时用 itimer
export PYROSCOPE_PROFILER_ALLOC=512k
export PYROSCOPE_PROFILER_LOCK=10ms
export PYROSCOPE_LABELS=env=prod,version=1.8.3

java -javaagent:/opt/pyroscope/pyroscope.jar -jar order-service.jar
```

在 Kubernetes 上也可以不改启动命令，由节点上的 Grafana Alloy 用 `pyroscope.java` 组件发现 Java 进程并 attach 采样，Pod 标签自动带上。

### 4、与 Spring Boot 4 结合

- **标签来源**：`service` 取 `spring.application.name`，`version` 取构建信息（与 `/actuator/info` 里的 `build.version` 保持一致），`env` 取 profile；三处保持同一来源，才能在 Grafana 中跨信号对齐
- **trace-to-profile**：Pyroscope 提供 OpenTelemetry 集成（`SpanProcessor` 与 OTel Java agent 扩展），给本地根 Span 写入 profile 关联属性、给样本打上 `span_id` 标签。走 OTel agent 路线时以扩展 jar 加载；走 Micrometer 路线时，Boot 会自动收集容器中的 `SpanProcessor` Bean，把 Pyroscope 提供的实现注册为 Bean 即可，类名与支持的事件类型以 Pyroscope 文档为准
- **启动分析**：启动慢不靠持续剖析，用 Spring 的 `FlightRecorderApplicationStartup` 把启动步骤写成 JFR 事件，或用 `/actuator/startup` 查看，见 [启动与部署优化](/spring-boot/13_startup#二、先度量-时间花在哪)
- **分工**：Actuator 的 `threaddump`、`heapdump` 是一次性快照，持续剖析是连续的采样序列，两者互补，不要用定时调 `threaddump` 代替持续剖析

---

## 四、eBPF 基础

### 1、eBPF 是什么

eBPF 允许把一段受限的程序加载进 Linux 内核，在指定事件发生时运行，并通过共享内存把结果交给用户态。可以把它理解为「内核里的安全沙箱插件」：不需要改内核源码、不需要加载内核模块，也不会因为程序写错让内核崩溃。

![eBPF 程序加载与数据流](../assets/observability/ebpf-dataflow.svg)

| 组成 | 作用 |
|------|------|
| Verifier（校验器） | 加载前做静态检查：程序必须能终止、不能越界访问内存、只能调用允许的辅助函数；不通过直接拒绝加载 |
| JIT | 把校验通过的字节码编译成本机指令，运行开销接近原生代码 |
| Map | 内核与用户态共享的键值存储（哈希表、数组、栈跟踪表、Ring Buffer 等），eBPF 程序写入，用户态 Agent 读取 |
| 挂载点 | 决定程序在什么事件上运行：kprobe（内核函数入口 / 返回）、uprobe（用户态函数，如 `libssl` 的读写）、tracepoint（内核预定义的稳定事件点）、perf_event（定时采样） |

### 2、CO-RE：一次编译到处运行

早期 bcc 工具在目标机器上现场编译 eBPF 程序，需要装 clang 和内核头文件，启动慢、依赖重。CO-RE（Compile Once – Run Everywhere）利用内核导出的 BTF 类型信息，加载时由 libbpf 按当前内核的结构体布局重定位字段偏移，一份预编译的程序可以跑在不同版本的内核上。前提是内核开启了 `CONFIG_DEBUG_INFO_BTF`（存在 `/sys/kernel/btf/vmlinux`），主流发行版的 5.x 后期及 6.x 内核基本都已开启。

### 3、为什么开销低、无需改应用

- **数据在内核里先聚合**：剖析时 eBPF 程序在 perf_event 中断里取栈，只把「栈 ID → 次数」累加进 Map，用户态每隔几秒读一次汇总结果，而不是每个样本都拷贝到用户态
- **不经过 ptrace**：与 `strace` 让线程每次系统调用都停下来不同（见 [用户态、内核态与系统调用](/os/2_kernel_mode#四、用-strace-观察-java-进程)），eBPF 程序同步运行在事件上下文中，没有额外的上下文切换
- **对应用透明**：从内核视角观察进程，不需要 agent、不需要重启，一个节点级 DaemonSet 就能覆盖所有语言的进程

---

## 五、eBPF 在可观测中的用法

### 1、持续剖析

| 方案 | 说明 |
|------|------|
| Parca Agent | 基于 eBPF 的整机 CPU 剖析，数据发往 Parca 服务端，默认低频采样 |
| Pyroscope eBPF | 由 Grafana Alloy 的 `pyroscope.ebpf` 组件采集，与 Pyroscope Java agent 可以并存 |
| OpenTelemetry eBPF Profiler | 由 Elastic 捐赠给 OpenTelemetry，支持多种语言运行时的栈展开，通过 OTLP Profiles 导出，状态与 Profiles 信号一致，仍在演进 |

### 2、网络与延迟分析

bcc 工具集和 bpftrace 是临时排障的利器，在节点上直接运行：

```bash
biolatency -m 10 1        # 块设备 IO 延迟直方图，判断是不是磁盘慢
tcpretrans                # 实时打印 TCP 重传，排查网络抖动
runqlat 10 1              # CPU 运行队列等待时间，判断是不是 CPU 争抢 / 限流
offcputime -p <pid> 10    # 线程不在 CPU 上的时间与栈，即内核视角的 off-CPU 分析

# bpftrace：统计指定进程 10 秒内各系统调用的次数
bpftrace -e 'tracepoint:syscalls:sys_enter_* /pid == $1/ { @[probe] = count(); } interval:s:10 { exit(); }' <pid>

# bpftrace：按进程统计 read 返回的字节数分布
bpftrace -e 'tracepoint:syscalls:sys_exit_read /args->ret > 0/ { @bytes[comm] = hist(args->ret); }'
```

`runqlat` 在容器场景特别有用：CPU 使用率不高但 P99 抖动时，常常是 CFS 配额限流或邻居抢占，指标上看不出来，运行队列延迟一眼可见。

### 3、自动插桩：OTel eBPF Instrumentation

OpenTelemetry eBPF Instrumentation（简称 OBI）由 Grafana 将 Beyla 捐赠而来，Beyla 继续作为 Grafana 的发行版。它用 uprobe 和内核探针识别 HTTP、gRPC、SQL 等协议，**不改代码、不加 agent** 就能产出 RED 指标和简单的 Span，并支持传播 W3C 上下文。适合覆盖遗留服务、第三方组件或多语言混合的集群；它看不到应用内部的业务 Span 和方法级细节，Java 服务仍以 Micrometer 或 OTel agent 为主，OBI 作为补充。成熟度以官方文档为准。

### 4、Java 的符号化难题

eBPF 剖析器拿到的是指令地址，需要「符号化」成函数名。C、Go、Rust 的函数名在二进制的符号表里，而 Java 方法由 JIT 在运行时生成，地址只有 JVM 自己知道，结果就是火焰图上一片 `[unknown]` 或 `[perf-<pid>.map]`。常见解法：

| 办法 | 做法 | 代价 |
|------|------|------|
| perf map 文件 | JDK 17 起 `jcmd <pid> Compiler.perfmap` 输出 `/tmp/perf-<pid>.map`；早期版本用 perf-map-agent 这类 JVMTI agent | 只是导出时刻的快照，之后新编译或被回收的代码对不上，需定期刷新 |
| 保留帧指针 | `-XX:+PreserveFramePointer`，让基于帧指针的栈展开能穿过 Java 帧 | 少一个可用寄存器，有轻微性能损失 |
| 运行时感知的展开器 | OTel eBPF Profiler 等直接读取 HotSpot 内部数据结构还原 Java 帧 | 依赖对 JVM 版本的适配 |
| 进程内 agent | 让 Java 进程自己用 async-profiler / JFR 采样 | 回到了要加 agent 的方式 |

实践中，Java 服务通常用进程内 agent 拿精确的 Java 栈，eBPF 剖析覆盖节点上其他语言的进程与内核开销，两者在同一平台上按标签汇总。

---

## 六、平台选型对比

| 平台 | 采集方式 | Java 支持 | 存储与查询 | 与链路关联 | 适合 |
|------|----------|-----------|------------|------------|------|
| Grafana Pyroscope | 语言 agent、Alloy（Java attach / eBPF）、OTLP | Java agent 封装 async-profiler，CPU / 分配 / 锁 / wall | 对象存储，Grafana 中查询、差分 | Traces to Profiles（配合 Tempo） | 已用 Grafana / LGTM 栈 |
| Parca | eBPF Agent 为主，也可抓取 pprof 端点 | 依赖 eBPF 侧的 JVM 栈展开 | 列式存储，自带 UI | 较弱 | 以整机 CPU 剖析为主、多语言 |
| OTel eBPF Profiler + 兼容后端 | eBPF，OTLP Profiles | 读取 HotSpot 结构还原 Java 帧 | 取决于后端 | 依赖 OTel 生态演进 | 想押注统一标准、可接受 Alpha |
| 云厂商 / 商业 APM 的 Profiler | 自家 agent，部分支持 eBPF | 通常基于 JFR 或 async-profiler | 托管 | 与自家 APM 链路深度集成 | 已使用该 APM，不想自运维 |
| 自建 JFR 归档 | JFR 持续录制 + 定期导出 | 原生 | 对象存储 + JMC 离线分析 | 无 | 预算少、只需事后回溯 |

选型的三个判断点：现有可观测栈是什么（Grafana 系优先 Pyroscope）、是否要覆盖非 Java 进程（要则引入 eBPF）、是否必须做 trace-to-profile（这一项各平台差距最大）。

---

## 七、落地实践

1. **采样率与事件**：CPU 默认 100Hz 左右、分配阈值 512KB 起步、锁阈值 10ms；先在压测环境对比开启前后的吞吐与 P99，确认开销在 2% 以内再全量
2. **统一标签**：至少带 `service`、`version`、`env`、`pod` / `instance`，与指标、链路使用同一套命名（OTel 语义约定中的 `service.name`、`service.version`、`k8s.pod.name`）。不要把 userId、orderId 放进 profile 标签，和指标一样会造成高基数
3. **存储保留**：原始精度保留 7～14 天，足以覆盖「上周同一时间」的对比；更长时间只保留降采样数据或关键版本的快照
4. **差分火焰图做版本对比**：发布后选「新版本 vs 旧版本」或「本周 vs 上周同时段」生成差分火焰图，变宽的帧标红、变窄的标绿，可作为发布检查的一步，直接回答「新版本的 CPU 多花在哪」
5. **与告警联动**：告警仍由指标触发（CPU、P99、GC 时间占比），通知模板里附带指向 Pyroscope 的链接，带上服务名和告警时间窗，值班人员点开即是那段时间的火焰图；告警规则写法见 [告警体系](./4_alerting)
6. **与链路联动**：在 Grafana 的 Tempo 数据源中配置 Traces to Profiles，慢 Span 上出现「Profiles for this span」入口；只有 profile 和 trace 的服务名标签一致才能跳转

::: tip 先从一个服务开始
先在 CPU 占用最高、最常出性能问题的服务上开启，跑两周积累基线，再推广；一开始就全量铺开，往往因为标签不统一、存储没规划而返工。
:::

---

## 八、限制与风险

- **内核版本**：CO-RE 需要 BTF，ring buffer 需要 5.8+，部分 Agent 声明最低支持 5.4 或更高；老旧发行版（如 3.10 内核）基本无法使用现代 eBPF 工具，只能退回进程内 agent
- **权限**：加载 eBPF 程序需要 root 或相应 capability。5.8 起拆出 `CAP_BPF`，剖析和追踪通常还需要 `CAP_PERFMON`，部分功能需要 `CAP_SYS_ADMIN`；Kubernetes 上常见做法是特权 DaemonSet 并挂载 `/sys/kernel/debug`、`/sys/fs/bpf`，这等于给了它接近节点 root 的能力
- **非特权 eBPF 默认关闭**：`kernel.unprivileged_bpf_disabled` 在主流发行版上默认禁止普通用户加载 eBPF，不要为了让工具跑起来而打开它
- **安全审计**：eBPF Agent 能读取进程内存与网络数据（uprobe 挂在 `libssl` 上可以看到 TLS 加密前的明文），要纳入安全评审：镜像来源可信、版本固定、限定部署的节点与命名空间、记录加载了哪些程序（`bpftool prog list`）
- **托管环境限制**：Serverless 容器、部分托管 Kubernetes 节点不允许特权容器，只能用进程内 agent
- **数据敏感性**：profile 中包含方法名、类名，有时还有 SQL 或 URL 片段，存储与访问同样需要权限控制
- **标准仍在演进**：OTel Profiles 与 eBPF Profiler 处于 Alpha，数据格式与配置可能变化，生产上建议隔离一层（如经 Alloy / Collector 转发），便于后续切换

---

## 小结

- 持续剖析让 Profiler 常驻低频采样并按标签存储，解决「问题过去才抓、没有基线可比」的问题，是指标、日志、链路之外的第四种信号
- 常用 CPU、Wall、Alloc、Lock 四类采样，频率每秒几十次、开销通常在 1%～2% 以内；async-profiler 与 JFR 没有安全点偏差
- Java 接入可选 JFR 持续录制、async-profiler `loop` 模式或 Pyroscope Java agent；标签与 Spring Boot 的服务名、版本保持同源
- eBPF 是内核里经过 Verifier 校验、JIT 执行的沙箱程序，挂在 kprobe / uprobe / tracepoint / perf_event 上，通过 Map 与用户态交换数据，CO-RE 让一份程序跑在多版本内核上
- eBPF 用于整机剖析、bcc / bpftrace 排障与 OBI 自动插桩；Java 的 JIT 帧需要 perf map、帧指针或运行时感知的展开器才能符号化
- 落地看统一标签、保留周期、差分火焰图与告警和链路联动；风险在内核版本、特权权限与安全审计

## 参考资料

- OpenTelemetry Profiles：[OpenTelemetry Profiles Enters Public Alpha](https://opentelemetry.io/blog/2026/profiles-alpha/)、[Status](https://opentelemetry.io/status/)
- OTel eBPF Profiler：[opentelemetry-ebpf-profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler)
- OTel eBPF Instrumentation：[opentelemetry-ebpf-instrumentation](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation)
- Grafana Pyroscope：[Pyroscope documentation](https://grafana.com/docs/pyroscope/latest/)、[Java client](https://grafana.com/docs/pyroscope/latest/configure-client/language-sdks/java/)
- Parca：[Parca documentation](https://www.parca.dev/docs/overview)
- async-profiler：[async-profiler](https://github.com/async-profiler/async-profiler)
- JFR 事件流：[JEP 349: JFR Event Streaming](https://openjdk.org/jeps/349)
- eBPF 入门与生态：[What is eBPF?](https://ebpf.io/what-is-ebpf/)
- BPF CO-RE：[BPF CO-RE reference guide](https://nakryiko.com/posts/bpf-core-reference-guide/)
- bcc 工具集：[iovisor/bcc](https://github.com/iovisor/bcc)；bpftrace：[bpftrace](https://github.com/bpftrace/bpftrace)
- 火焰图与 off-CPU 分析：[Brendan Gregg: Flame Graphs](https://www.brendangregg.com/flamegraphs.html)

> 返回：[可观测性总览](./0_overview)

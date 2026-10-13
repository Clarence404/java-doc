---
description: 进程 / 线程 / 协程的区别、task_struct 与 clone、Java 1:1 与 M:N 线程模型、上下文切换成本、CFS 与 EEVDF 调度
---

# 进程、线程与协程

> 前置阅读：[线程基础](/java/23_topic_thread_basics)

进程是资源分配的单位，线程是 CPU 调度的单位，协程是在用户态自行调度的执行流。本篇讲三者的区别、Linux 如何用同一套结构表示进程和线程、Java 线程与内核线程的对应关系，以及上下文切换的成本与调度器，基线为 Linux 6.x、JDK 21。

---

## 一、三者的区别

| 维度 | 进程 | 线程 | 协程 |
|------|------|------|------|
| 定位 | 资源分配单位 | CPU 调度单位 | 用户态的执行流 |
| 拥有什么 | 独立地址空间、文件描述符表、信号处理 | 自己的栈、寄存器、线程局部存储；其余与同进程线程共享 | 一小段栈或状态对象，挂在某个线程上运行 |
| 谁来调度 | 内核 | 内核 | 语言运行时或库（用户态） |
| 创建成本 | 高：要复制页表等进程级结构 | 中：一次系统调用，加 MB 级栈预留 | 低：堆上分配一个对象 |
| 切换成本 | 最高：要切换地址空间 | 中：进内核保存恢复寄存器 | 低：不进内核，保存少量状态 |
| 隔离性 | 强：一个进程崩溃不影响其他进程 | 弱：一个线程踩坏内存，整个进程一起出问题 | 同线程 |

一句话记忆：**进程管"有什么"，线程管"谁在跑"，协程把"谁在跑"的决定权从内核拿回到用户态**。

---

## 二、Linux 中的实现：task_struct 与 clone

### 1、进程和线程都是 task

Linux 内核里没有单独的"线程"结构。每个可调度的实体都是一个 `task_struct`（内核源码里叫 task），进程和线程的区别只在于**几个 task 之间共享了多少资源**：

- 共享地址空间、文件描述符表、信号处理的一组 task，对外表现为"一个进程里的多个线程"
- 什么都不共享的 task，就是一个独立进程

### 2、clone：用参数决定共享什么

创建 task 的系统调用是 `clone`（以及更新的 `clone3`），通过标志位决定新 task 与父 task 共享什么：

| 调用方式 | 关键标志 | 结果 |
|---------|---------|------|
| `fork()` | 不带共享标志 | 新进程，地址空间按写时复制（Copy-On-Write）拷贝 |
| `pthread_create()` | `CLONE_VM`、`CLONE_FILES`、`CLONE_FS`、`CLONE_SIGHAND`、`CLONE_THREAD` 等 | 新线程，与父 task 共享地址空间和文件描述符，归入同一个线程组 |

`fork` 的写时复制意味着创建子进程时并不立刻复制物理内存，父子进程先共享同一批只读页，谁先写谁再复制那一页。Redis 的 RDB 快照就是靠这个机制在后台生成内存快照。

### 3、PID 与 TGID

| 用户态看到的 | 内核里的字段 | 含义 |
|-------------|-------------|------|
| 进程 ID | `tgid`（线程组 ID） | 同一进程的所有线程相同，等于主线程的 ID |
| 线程 ID | `pid` | 每个 task 唯一，`gettid()` 返回的就是它 |

所以 `top -H -p <pid>` 和 `ls /proc/<pid>/task` 列出的每一项，都是这个进程里的一个线程（内核视角的一个 task）。

---

## 三、Java 的线程模型

### 1、三种映射方式

用户态的执行流怎么映射到内核线程，有三种模型：

| 模型 | 映射 | 优点 | 缺点 | 例子 |
|------|------|------|------|------|
| 1:1 | 一个用户线程对应一个内核线程 | 实现简单，能用满多核，一个线程阻塞不影响其他线程 | 创建和切换都要进内核，线程数受内存和调度开销限制 | Java 平台线程、C 的 pthread |
| N:1 | 多个用户线程跑在一个内核线程上 | 切换极快 | 用不上多核，一个阻塞调用卡住全部 | 早期的绿色线程（JDK 1.1） |
| M:N | M 个用户线程复用 N 个内核线程 | 兼顾廉价与多核 | 运行时要接管所有阻塞点，实现复杂 | Java 虚拟线程、Go goroutine |

### 2、平台线程：1:1 的内核线程

HotSpot 在 Linux 上通过 `pthread_create` 创建线程，底层就是上一节的 `clone`。因此：

- 每个 `new Thread().start()` 都会在内核里多一个 task，由内核调度器决定它何时在哪个 CPU 上运行
- `jstack` 输出中的 `nid` 就是这个线程的内核线程 ID，可以和 `top -H` 的结果对应起来，定位高 CPU 线程的步骤见 [Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)
- 一个空闲的 Java 进程也有几十个线程：GC 线程、JIT 编译线程、信号分发线程、引用处理线程等，它们和业务线程一样都是内核线程

线程栈的大小由 `-Xss` 控制（64 位 Linux 默认 1 MB），这是虚拟内存预留，真正占用的物理内存取决于栈用到多深，原理见 [内存管理与 Page Cache](./3_memory)。

### 3、虚拟线程：JVM 实现的 M:N

JDK 21 正式发布的虚拟线程是 M:N 模型：大量虚拟线程跑在少量平台线程（载体线程）上，遇到阻塞时由 JVM 把它从载体线程上卸下来，内核看到的仍然只有那几个载体线程。挂载、卸载与钉住的细节见 [虚拟线程](/java/30_topic_virtual_thread)。

### 4、其他语言的协程

| 语言 | 实现 | 特点 |
|------|------|------|
| Go | goroutine，运行时 M:N 调度 | 有栈协程，栈按需增长，阻塞系统调用时运行时会补充新的内核线程 |
| Kotlin | `suspend` 函数，编译为状态机 | 无栈协程，挂起点由编译器显式标出，调用链上的函数都要标 `suspend` |
| Java | 虚拟线程，JVM 在 JDK 层面接管阻塞点 | 有栈，沿用 `Thread` API，已有的阻塞式代码不用改写 |

有栈协程可以在任意深度的调用中挂起，对已有代码透明；无栈协程只能在标记过的位置挂起，但每个协程占用的内存更小。

---

## 四、上下文切换

### 1、切换时要保存什么

CPU 从一个线程切换到另一个线程，内核要做这些事：

1. 保存当前线程的寄存器、程序计数器、栈指针到它的 `task_struct`
2. 由调度器选出下一个要运行的 task
3. 恢复下一个 task 的寄存器状态
4. 如果两个 task 属于**不同进程**，还要切换页表（x86 上是写 CR3 寄存器），TLB 中缓存的地址翻译随之失效（CPU 支持 PCID 时可以保留一部分）

同一进程的线程之间切换不用换页表，所以比进程切换便宜。

### 2、成本在哪里

| 成本 | 说明 |
|------|------|
| 直接成本 | 进出内核、保存恢复寄存器、调度器选择下一个 task，通常在微秒级 |
| 间接成本 | 新线程的数据不在 CPU 缓存里，要重新从内存加载；进程切换还会损失 TLB，这部分往往比直接成本更大 |

间接成本是"线程越多越慢"的主要原因：线程数远超 CPU 核数时，每个线程分到的时间片很短，刚把数据加载进缓存就被换走了。CPU 缓存的结构见 [CPU 缓存与伪共享](./4_cpu_cache)。

### 3、两类切换

| 类型 | 触发原因 | 观察方式 |
|------|---------|---------|
| 自愿切换（voluntary） | 线程主动让出 CPU：等 IO、等锁、`sleep` | `/proc/<pid>/status` 中的 `voluntary_ctxt_switches`，`pidstat -w` 的 `cswch/s` |
| 非自愿切换（involuntary） | 时间片用完或被更高优先级的 task 抢占 | `nonvoluntary_ctxt_switches`，`pidstat -w` 的 `nvcswch/s` |

- 自愿切换多：线程大量时间在等待，说明是 IO 密集或锁竞争激烈，后者见 [用户态、内核态与系统调用](./2_kernel_mode)
- 非自愿切换多：可运行的线程比 CPU 多，线程池可能开得过大，或容器的 CPU 配额不够

整机的切换次数看 `vmstat 1` 的 `cs` 列。线程池大小怎么取见 [线程池](/java/28_topic_thread_pool)。

---

## 五、调度基础

### 1、task 的状态

调度器只在**可运行**（`R`）的 task 之间分配 CPU，等 IO、等锁、`sleep` 的 task 处于睡眠状态（`S` 或 `D`），不参与竞争。各状态的含义与僵尸进程的成因见 [进程间通信与进程状态](./6_ipc_process)，`R` 与 `D` 状态如何构成系统负载见 [Load 与 CPU 利用率](./5_load_cpu)。

### 2、调度类

内核按调度类划分优先级，高优先级类中有可运行的 task 时，低优先级类得不到 CPU：

| 调度类 | 对应策略 | 用途 |
|--------|---------|------|
| deadline | `SCHED_DEADLINE` | 有明确截止时间的实时任务 |
| 实时（rt） | `SCHED_FIFO`、`SCHED_RR` | 实时任务，按固定优先级抢占 |
| 公平（fair） | `SCHED_NORMAL`、`SCHED_BATCH` | 普通进程，Java 线程默认在这里 |
| idle | `SCHED_IDLE` | 只在系统空闲时运行 |

### 3、公平调度：从 CFS 到 EEVDF

公平调度类的目标是让每个 task 按权重（由 nice 值决定）分到相应比例的 CPU 时间：

- **CFS**（Completely Fair Scheduler，Linux 2.6.23 起）：为每个 task 记录虚拟运行时间（vruntime），权重越高 vruntime 增长越慢；可运行的 task 按 vruntime 放在红黑树里，每次选 vruntime 最小的运行
- **EEVDF**（Earliest Eligible Virtual Deadline First，**Linux 6.6 起**替换了 CFS 的选择逻辑）：仍然追踪每个 task 应得与实得 CPU 时间的差值（lag），只在 lag 不为负、即"没有多拿"的 task 中，选**虚拟截止时间**最早的运行。task 可以申请更短的时间片来换取更早的截止时间，对延迟敏感的任务更友好，也去掉了 CFS 中大量为改善延迟而加的经验规则

EEVDF 仍属于公平调度类，很多文档和工具依然把这一类叫作 CFS。Linux 6.12 还合入了 sched_ext，允许用 BPF 程序实现自定义调度策略。

::: tip 容器中的 CPU 限制
Kubernetes 的 CPU limit 通过 cgroup 的带宽控制实现：每个周期（默认 100 ms）内容器最多使用配额规定的 CPU 时间，用完就被限流（throttled），直到下一个周期。这个机制的名字里带 CFS（`container_cpu_cfs_throttled_periods_total`），但与选择哪个 task 运行的调度算法无关。限流导致延迟抖动的案例见 [CPU 飙高](/handbook/2_incidents/3_cpu_high)。
:::

---

## 小结

- 进程是资源分配单位，线程是调度单位，协程在用户态调度；三者的成本差异来自是否切换地址空间、是否进内核
- Linux 中进程和线程都是 `task_struct`，`clone` 的标志位决定共享哪些资源；进程 ID 是线程组 ID，线程 ID 是 task 自己的 ID
- Java 平台线程与内核线程 1:1，`jstack` 的 `nid` 就是内核线程 ID；虚拟线程是 JVM 实现的 M:N 模型
- 上下文切换的直接成本在微秒级，更大的代价是缓存与 TLB 失效；自愿切换多看 IO 和锁，非自愿切换多看线程数和 CPU 配额
- 普通线程由公平调度类调度，Linux 6.6 起选择算法从 CFS 换成 EEVDF；容器的 CPU 限流是 cgroup 带宽控制，与调度算法无关

## 参考资料

- Linux man-pages：[clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html)
- Linux man-pages：[sched(7)](https://man7.org/linux/man-pages/man7/sched.7.html)
- Linux 内核文档：[EEVDF Scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html)
- Linux 内核文档：[CFS Scheduler](https://docs.kernel.org/scheduler/sched-design-CFS.html)
- Linux 内核文档：[Extensible Scheduler Class（sched_ext）](https://docs.kernel.org/scheduler/sched-ext.html)
- JEP 444 Virtual Threads：[https://openjdk.org/jeps/444](https://openjdk.org/jeps/444)

> 下一篇：[用户态、内核态与系统调用](./2_kernel_mode) —— 线程等 IO、等锁时会进入内核，看看这一步发生了什么、代价有多大。

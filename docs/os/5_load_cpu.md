---
description: Load 定义与 D 状态、Load 高 CPU 低、CPU 各项占比、PSI 与容器限流、线程数估算
---

# Load 与 CPU 利用率

> 前置阅读：[进程、线程与协程](./1_process_thread)、[Linux 概览](/cloud-native/1_linux)

Load 高不等于 CPU 忙，CPU 低也不等于系统闲，这两个数经常被读反。本篇讲 Load 的定义、Load 高而 CPU 低的成因、CPU 各项占比与线程数估算，基线为 Linux 6 与 cgroup v2。

---

## 一、Load Average 是什么

### 1、定义

```bash
$ cat /proc/loadavg
6.12 4.87 3.95 3/1874 92011
```

前三个数是最近 1、5、15 分钟的平均负载，第四项是「当前可运行的调度实体数 / 系统内调度实体总数」，最后是最近分配的 PID。

Linux 的 Load 统计的是**处于以下两种状态的任务数**，按指数衰减做滑动平均（内核每 5 秒左右采样一次）：

- **R**：正在 CPU 上运行，或在运行队列里排队等 CPU
- **D**：不可中断睡眠，通常在等磁盘 IO、等某些内核锁

两点容易忽略：

- 统计单位是**任务**，即线程，不是进程。一个 Java 进程有 200 个线程同时在跑，Load 就会贡献约 200
- 把 D 状态算进去是 Linux 独有的做法，其他 Unix 只算 R。所以 Linux 的 Load 衡量的是「系统需求」，而不只是「CPU 需求」

### 2、怎么判断高不高

Load 要和**逻辑 CPU 数**比较（`nproc`）：

| 情况 | 含义 |
|------|------|
| Load 明显低于核数 | 资源有富余 |
| Load 接近核数 | 基本跑满，开始出现排队 |
| Load 持续高于核数 | 有任务在等，要看等的是 CPU（R）还是 IO / 锁（D） |

三个数放在一起看趋势：1 分钟远大于 15 分钟，说明负载正在上升；反过来说明高峰已过。

### 3、更准确的指标：PSI

Load 只告诉你「有多少任务在等」，不告诉你「在等什么、等了多久」。内核 4.20 起提供 **PSI**（Pressure Stall Information），直接给出因资源不足而停顿的时间占比：

```bash
$ cat /proc/pressure/cpu
some avg10=12.31 avg60=8.02 avg300=5.11 total=902837261
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
$ cat /proc/pressure/io
some avg10=35.20 avg60=30.88 avg300=22.17 total=...
full avg10=18.45 avg60=15.02 avg300=10.90 total=...
```

- `some`：至少有一个任务因该资源停顿的时间占比
- `full`：所有非空闲任务同时停顿的时间占比，表示这段时间完全没有有效工作；系统级的 cpu `full` 恒为 0，只在 cgroup 级别有意义

cgroup v2 下每个 cgroup 也有自己的 `cpu.pressure` / `io.pressure` / `memory.pressure`，可以精确到某个容器。

::: warning 容器里的 Load 是宿主机的
`/proc/loadavg` 不受 cgroup 隔离，容器里看到的是整台宿主机的 Load，和容器自身的 CPU 限额没有可比性。判断容器是否缺 CPU，看本 cgroup 的 PSI 和下文的限流计数。
:::

---

## 二、Load 高而 CPU 低

### 1、常见成因

Load 高、`top` 里 CPU 却很空闲，说明排队的大多是 **D 状态**的任务，不是在抢 CPU：

| 成因 | 表现 | 进一步确认 |
|------|------|-----------|
| 磁盘 IO 慢或打满 | `wa` 偏高，`iostat` 的 `await` 升高、`%util` 高 | `iostat -x 1`、`iotop` |
| 网络存储挂起（NFS、云盘抖动） | 大量进程卡在 D 状态，`wa` 不一定高 | `ps` 看 `wchan`，内核日志里有 hung task 告警 |
| 内存紧张，直接回收或换页 | `free` 很少，有 Swap 读写，`si` / `so` 不为 0 | `vmstat 1`、`/proc/pressure/memory` |
| 大量线程等内核锁 | 如同时对同一文件系统做元数据操作 | `/proc/<pid>/stack` 查看内核栈 |

### 2、排查步骤

```bash
vmstat 1                       # r：可运行任务数；b：阻塞在 IO 上的任务数（D 状态的主要部分）
ps -eLo stat,pid,tid,wchan:32,comm | awk '$1 ~ /^D/'   # 列出所有 D 状态线程与等待点
cat /proc/<pid>/task/<tid>/stack                         # 某个线程的内核栈，需要 root
iostat -x 1                    # 磁盘延迟与使用率
cat /proc/pressure/io          # IO 压力
```

`vmstat` 的 `r` 远大于核数是 CPU 不够；`b` 持续不为 0 是在等 IO（`b` 只统计阻塞在 IO 上的任务，完整的 D 状态数用 `ps -eLo stat | grep -c ^D`）。`wchan` 列显示线程在哪个内核函数里睡眠，比如 `io_schedule`、`folio_wait_bit` 一类基本可以确定在等块设备，`rpc_wait_bit_killable` 一类指向 NFS。

### 3、反过来：CPU 高而 Load 不高

在核数多的机器上，少数几个线程把各自的核跑满，整体 CPU 可能只有 10%，Load 也只有几，但服务已经慢了。用 `mpstat -P ALL 1` 看每个核，用 `top -H -p <pid>` 看每个线程，单核打满、单线程打满都会在这里暴露，比如单线程的事件循环、某个网卡队列的软中断都集中在一个核上。

---

## 三、CPU 利用率拆解

### 1、各项含义

`top` 第三行、`mpstat`、`vmstat` 都把 CPU 时间拆成几类：

| 字段 | 含义 | 偏高时常见原因 |
|------|------|---------------|
| `us` | 用户态执行时间 | 业务计算、序列化、正则、JSON 解析，以及 GC 线程 |
| `sy` | 内核态执行时间 | 系统调用过多（小块读写）、锁竞争导致的 futex 调用、频繁上下文切换、缺页 |
| `ni` | 调低过优先级（nice > 0）的进程的用户态时间 | 批处理、后台任务 |
| `id` | 空闲 | — |
| `wa` | 空闲且有未完成的 IO | 磁盘慢；但它本质是一种空闲，只能参考 |
| `hi` | 硬中断 | 网卡、磁盘中断过多，通常很低 |
| `si` | 软中断 | 网络收发包，PPS 高时明显，常集中在少数核 |
| `st` | 被宿主机「偷走」的时间 | 虚拟机所在宿主机超卖，邻居在抢 CPU |

几条读法：

- **`wa` 不可靠**：它只在 CPU 空闲时才计入，CPU 一忙起来 `wa` 就会下降，哪怕 IO 一样慢。判断 IO 瓶颈看 `iostat` 的延迟和 PSI，不要只看 `wa`
- **`sy` 占比高要警惕**：正常业务 `us` 远大于 `sy`。`sy` 接近或超过 `us`，往往是系统调用、锁竞争或上下文切换出了问题，用 `pidstat -w` 看切换次数，系统调用的成本见 [用户态、内核态与系统调用](./2_kernel_mode)
- **`si` 集中在一个核**：网卡队列少或没开 RSS / RPS，所有收包软中断落在同一个核，整体 CPU 不高但网络吞吐上不去
- **`st` 持续大于 5%**：云主机所在宿主机资源紧张，应用侧无解，只能换规格或迁移

### 2、容器的 CPU 限流

容器设置了 CPU limit 后，cgroup 用 CFS 带宽控制按周期（默认 100 ms）分配配额。配额用完，容器里所有线程都要等下一个周期，即使宿主机 CPU 还很空：

```bash
cat /sys/fs/cgroup/cpu.max      # 例如 200000 100000，表示每 100 ms 最多用 200 ms，即 2 核
cat /sys/fs/cgroup/cpu.stat     # nr_throttled、throttled_usec 持续增长说明在被限流
```

典型现象是**平均 CPU 不高、P99 延迟却有规律地抖动**：GC 或请求突发时多个线程同时运行，几十毫秒就用完了配额，剩下的时间全部挂起。JVM 会按 limit 推算可用核数并据此设置 GC 线程数、`ForkJoinPool` 并行度，limit 与 requests 怎么设见 [Kubernetes](/cloud-native/6_kubernetes#三、资源模型与-qos)。

---

## 四、IO 密集与 CPU 密集

### 1、怎么判断

| 维度 | CPU 密集 | IO 密集 |
|------|---------|--------|
| CPU | `us` 高，接近核数满载 | `us` 不高，线程大量时间在等待 |
| `vmstat` | `r` 大于核数，`b` 接近 0 | `r` 不高；本地磁盘 IO 时 `b` 偏高 |
| 线程栈 | 栈顶是业务计算代码 | 栈顶是 socket 读、JDBC 调用、锁等待 |
| 加线程 | 吞吐不升反降（切换开销） | 吞吐上升，直到下游或连接池到顶 |

注意 Java 线程状态和 OS 状态并不一一对应：线程阻塞在 `SocketInputStream.read` 上时，`jstack` 显示 `RUNNABLE`，但在 OS 层它处于 S 状态，并不占 CPU。判断一个线程是否真在消耗 CPU，以 `top -H` 的 CPU 占比为准，不要只看 `jstack` 的状态。

网络 IO 等待通常是 S 状态，不计入 Load；本地磁盘 IO 等待是 D 状态，会推高 Load。所以「Web 服务调用下游慢」一般不会让 Load 升高，「日志刷盘慢」则会。

### 2、线程数怎么估

经典公式：

- CPU 密集：线程数 ≈ 核数（或核数 + 1）
- IO 密集：线程数 ≈ 核数 × 目标 CPU 利用率 × (1 + 等待时间 / 计算时间)

公式里最难的是**等待 / 计算比**，可以从 OS 和 JVM 两侧测：

- 单个请求的 CPU 时间：JFR、async-profiler 的 CPU 模式，或 `ThreadMXBean.getCurrentThreadCpuTime()` 在请求前后打点
- 单个请求的总耗时：链路追踪或接口耗时指标，两者相减就是等待时间
- 也可以反向推：压测时看 `us` 与 QPS，算出每个请求消耗多少 CPU 毫秒

公式只给出起点，下游连接池、数据库的承载能力往往先于 CPU 到顶，最终以阶梯压测的拐点为准。各类公式的对比与生产配置模板见 [并发参数调优](/high-con/7_concurrency_tuning#_1、线程数估算)，线程池本身的参数与队列选择见 [线程池](/java/28_topic_thread_pool)。对 IO 密集的阻塞式代码，JDK 21 起也可以直接用虚拟线程，不再为等待时间准备大量平台线程，见 [虚拟线程](/java/30_topic_virtual_thread)。

---

## 小结

- Linux 的 Load 是 R + D 状态线程数的滑动平均，衡量的是系统需求，要和逻辑核数比较
- Load 高 CPU 低，多半是 D 状态任务在等磁盘、网络存储或内存回收，用 `vmstat` 的 `b` 列（阻塞在 IO 上的任务数）、`ps` 的 `stat` / `wchan` 和 PSI 定位
- CPU 拆成 us / sy / wa / si / st 读：`sy` 高查系统调用和切换，`si` 集中查网卡队列，`st` 高是宿主机问题，`wa` 只作参考
- 容器内看 cgroup 的 PSI 和 `cpu.stat` 限流计数，不看 `/proc/loadavg`
- `jstack` 的 `RUNNABLE` 不等于在用 CPU；线程数按等待 / 计算比估算，最终以压测为准

## 参考资料

- proc_loadavg(5)：[https://man7.org/linux/man-pages/man5/proc_loadavg.5.html](https://man7.org/linux/man-pages/man5/proc_loadavg.5.html)
- Linux 内核文档 PSI - Pressure Stall Information：[https://docs.kernel.org/accounting/psi.html](https://docs.kernel.org/accounting/psi.html)
- Linux 内核文档 Control Group v2：[https://docs.kernel.org/admin-guide/cgroup-v2.html](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- Linux 内核文档 CFS Bandwidth Control：[https://docs.kernel.org/scheduler/sched-bwc.html](https://docs.kernel.org/scheduler/sched-bwc.html)
- top(1)：[https://man7.org/linux/man-pages/man1/top.1.html](https://man7.org/linux/man-pages/man1/top.1.html)
- Brendan Gregg, Linux Load Averages: Solving the Mystery：[https://www.brendangregg.com/blog/2017-08-08/linux-load-averages.html](https://www.brendangregg.com/blog/2017-08-08/linux-load-averages.html)

> 下一篇：[进程间通信与进程状态](./6_ipc_process) —— 管道、信号、共享内存与 Socket，进程状态与僵尸进程，以及容器里的 PID 1。

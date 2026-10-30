---
description: 进程线程协程、系统调用、虚拟内存、OOM Killer、Page Cache、伪共享、Load、IPC
---

# 操作系统面试题解答

> 题目清单见 [操作系统面试题](/os/99_interview)；细节见 [操作系统总览](/os/0_overview)。线程池、锁、JMM 的 Java 层面问题见 [Java 并发面试题解答](/interview/2_concurrent)，epoll 与 IO 模型见 [Netty 面试题解答](/interview/6_netty)。
>
> 版本基线：Linux 6.x 内核、cgroup v2、x86-64 / AArch64，Java 示例默认 JDK 21。

## 一、进程、线程与调度

### Q1：进程、线程、协程有什么区别？

**一句话**：进程管「有什么资源」，线程管「谁在 CPU 上跑」，协程把「谁在跑」的决定权从内核拿回用户态，所以越往后越轻、越便宜。

- 隔离性：一个进程崩了不影响别的进程，一个线程踩坏内存整个进程一起挂
- 协程分有栈（Go、Java 虚拟线程，任意深度可挂起）和无栈（Kotlin `suspend`，编译成状态机）
- Linux 内核里进程、线程都是 `task_struct`，区别只在共享多少资源；协程不归内核管，在用户态由运行时调度

| 维度 | 进程 | 线程 | 协程 |
|------|------|------|------|
| 地址空间 | 独立 | 与同进程线程共享 | 挂在线程上 |
| 谁调度 | 内核 | 内核 | 运行时 / 库 |
| 切换成本 | 最高（换页表） | 中（进内核） | 低（不进内核） |

→ 详见 [进程、线程与协程](/os/1_process_thread#一、三者的区别)

### Q2：Linux 里进程和线程是怎么实现的？fork 为什么快？

**一句话**：Linux 内核没有单独的「线程」结构，进程和线程都是 `task_struct`，区别只在于几个 task 之间共享了多少资源；`fork` 快是因为写时复制，不立即拷贝内存。

- `clone` 的标志位决定共享什么：带 `CLONE_VM`、`CLONE_FILES`、`CLONE_THREAD` 等就是线程，都不带就是新进程
- 进程 ID 其实是线程组 ID（`tgid`），线程 ID 是每个 task 自己的 `pid`
- 写时复制（COW）：父子进程先共用同一批只读物理页，谁先写谁再复制那一页
- Redis 的 RDB 后台快照就靠 `fork` + COW，写多时内存会明显上涨

→ 详见 [进程、线程与协程](/os/1_process_thread#_2、clone-用参数决定共享什么)

### Q3：Java 线程和操作系统线程是什么关系？虚拟线程呢？

**一句话**：平台线程和内核线程是 1:1，一个 `Thread` 就是内核里一个 task；虚拟线程是 M:N，大量虚拟线程跑在少量载体线程上，内核只看得到载体线程。

- 平台线程经 `pthread_create` → `clone` 创建，由内核调度器决定何时在哪个核上跑
- `jstack` 里的 `nid` 就是内核线程 ID，可以和 `top -H` 的结果对上，用来定位高 CPU 线程
- 平台线程贵在两处：MB 级栈预留（`-Xss`）和内核调度开销，所以线程数撑不到几十万
- 虚拟线程遇到阻塞时由 JVM 把它从载体线程上卸下来，阻塞式代码不用改写

→ 详见 [进程、线程与协程](/os/1_process_thread#三、java-的线程模型)

### Q4：上下文切换的成本在哪里？线程越多越快吗？

**一句话**：切换本身（保存恢复寄存器、调度器选下一个）只要微秒级，更贵的是切换后缓存和 TLB 失效要重新加载，所以线程远多于核数时反而变慢。

- 进程切换还要换页表，TLB（地址翻译缓存）随之失效，比同进程线程切换贵
- 自愿切换：线程主动让出 CPU（等 IO、等锁、`sleep`），多说明 IO 密集或锁竞争
- 非自愿切换：时间片用完被抢占，多说明可运行线程比 CPU 多，线程池开大了或容器 CPU 配额不够
- 观察：`pidstat -w` 的 `cswch/s`、`nvcswch/s`，整机看 `vmstat 1` 的 `cs` 列

→ 详见 [进程、线程与协程](/os/1_process_thread#四、上下文切换)

## 二、用户态与系统调用

### Q5：什么是用户态和内核态？为什么要分开？

**一句话**：靠 CPU 特权级把代码分成两类，用户态只能碰自己进程的内存和普通指令，内核态什么都能做；分开是为了隔离和保护，一个程序出错不至于拖垮整台机器。

- x86-64 上用户态是 Ring 3、内核态是 Ring 0；ARM64 对应 EL0 / EL1
- 进内核只有三条路：系统调用（主动请求）、异常（缺页、除零）、中断（网卡、时钟）
- 时钟中断让内核能定期拿回 CPU，这是抢占式调度的基础
- 用户态出错只死自己（段错误），内核态出错可能整机 panic

→ 详见 [用户态、内核态与系统调用](/os/2_kernel_mode#一、为什么要分两种态)

### Q6：一次系统调用发生了什么？开销大吗，怎么减少？

**一句话**：系统调用是同一个线程从用户态进内核再回来的「模式切换」，不涉及调度，单次只要百纳秒级；真正贵的是调用次数太多，以及调用中阻塞导致线程睡眠。

- 路径：Java native 方法 → glibc 把调用号放进寄存器 → `syscall` 指令进内核 → 按调用号执行 → 返回用户态
- 额外成本：Meltdown / Spectre 的缓解措施（如 KPTI 切页表）、内核与用户缓冲区之间的数据拷贝
- 减少次数：`BufferedOutputStream` 攒批、`writev` 一次写多个缓冲区、`epoll_wait` 一次等一批连接、`transferTo` 零拷贝
- `System.currentTimeMillis()` 走 vDSO（内核映射到用户空间的只读代码），通常不进内核
- 观察：`strace -f -c -p <pid>` 统计调用分布，但开销大，线上只做短时统计

→ 详见 [用户态、内核态与系统调用](/os/2_kernel_mode#三、系统调用的成本)

### Q7：Java 加锁会进内核吗？什么时候会？

**一句话**：没有竞争时不会，`synchronized` 和 `ReentrantLock` 加锁都是用户态的 CAS；只有抢不到锁、要睡眠等待时，才通过 `futex` 系统调用进内核。

- futex（快速用户态互斥量）的设计就是「无竞争走用户态，有竞争才进内核」
- 抢不到先短暂自旋，仍不行才 `park` → `futex(FUTEX_WAIT)` 睡眠，释放方 `FUTEX_WAKE` 唤醒
- 竞争激烈的信号：`strace -c` 里 `futex` 占比高、自愿切换数上升、CPU 的 `sy` 偏高
- `Thread.sleep`、`Object.wait`、`BlockingQueue.take` 在平台线程上最终也落到 `futex` 一类调用

→ 详见 [用户态、内核态与系统调用](/os/2_kernel_mode#_2、锁与-futex)

## 三、内存与 Page Cache

### Q8：什么是虚拟内存？为什么 Java 进程的 VIRT 比堆大很多？

**一句话**：每个进程用的都是虚拟地址，由 MMU 查页表按页（默认 4 KB）翻译成物理地址；申请虚拟内存几乎不花钱，用到哪页才真正分配物理内存，所以 VIRT 大不代表占得多，要看 RSS。

- 好处：进程间隔离、按需分配、多个进程可共享同一批物理页（共享库、Page Cache）
- TLB 是 CPU 里的地址翻译缓存，命中就不用查页表；大页（2 MB）能减少 TLB 未命中
- Java 进程的虚拟内存不只是堆：还有元空间、每个线程的栈、直接内存、JIT 代码缓存、GC 数据结构
- RSS 是真正驻留在物理内存里的部分；容器内存 limit 按 RSS 加必要的 Page Cache 留余量，监控看 working set

→ 详见 [内存管理与 Page Cache](/os/3_memory#_2、java-进程的虚拟内存)

### Q9：什么是缺页异常？Swap 为什么对 Java 特别不友好？

**一句话**：访问的虚拟页还没映射物理页时触发缺页，内核补上映射；只需建映射的是次缺页（微秒级），要读磁盘的是主缺页（毫秒级）。Swap 把堆页换到磁盘，GC 一扫堆就是大量主缺页。

- `-Xms` 再大，RSS 也是慢慢涨，因为堆页第一次写入时才通过缺页分配
- `-XX:+AlwaysPreTouch` 启动时把堆逐页写一遍，启动变慢但运行期不再为此缺页
- GC 要遍历、移动大片堆内存，有页被换出时停顿会从几十毫秒拉到秒级
- 做法：服务器关 Swap 或给足内存，`vmstat 1` 的 `si` / `so` 持续非零就要处理

**常见坑**：`vm.swappiness=0` 不等于禁用 Swap，内存极紧张时仍会换出。

→ 详见 [内存管理与 Page Cache](/os/3_memory#二、分页与缺页)、[Swap](/os/3_memory#三、swap)

### Q10：OOM Killer 和 Java 的 OutOfMemoryError 有什么区别？

**一句话**：`OutOfMemoryError` 是 JVM 发现堆或元空间满了抛的异常，进程还活着；OOM Killer 是内核发现整机（或容器）物理内存耗尽，直接用 `SIGKILL` 杀进程，应用连日志都来不及打。

- Linux 默认允许超额分配（overcommit），申请时只粗查，真用完时才由 OOM Killer 按评分挑进程
- 容器里堆没满却被杀，多半是直接内存、线程栈、元空间等堆外部分把总量撑过了 limit；用 NMT（启动加 `-XX:NativeMemoryTracking=summary`，再 `jcmd <pid> VM.native_memory`）核算堆外各区域
- 确认被杀：退出码 137（128 + SIGKILL），`dmesg -T | grep -i "killed process"`；K8s 里 `kubectl describe pod` 显示 `Last State: OOMKilled`
- 修复：`MaxRAMPercentage` 降到 50%～65%，直接内存、元空间显式封顶，加「工作集 / limit」告警

| 对比 | OutOfMemoryError | OOM Killer |
|------|------------------|------------|
| 谁触发 | JVM | 内核 |
| 原因 | 堆 / 元空间等达到 JVM 上限 | 物理内存（或 cgroup `memory.max`）耗尽 |
| 现象 | 异常栈、可配置堆转储 | 进程突然消失，退出码 137，`dmesg` 有记录 |

→ 详见 [内存管理与 Page Cache](/os/3_memory#_3、超额分配与-oom-killer)、[容器被 OOMKilled · 排查过程](/handbook/2_incidents/15_oom_killed#三、排查过程)

### Q11：write 返回成功，数据就落盘了吗？

**一句话**：没有。`write` 只是把数据拷进内核的 Page Cache、标成脏页就返回了，后台 flusher 线程过一阵才写回磁盘；要确保落盘必须调用 `fsync`（Java 里是 `FileChannel.force`）。

- 进程崩溃不丢数据（已在内核里），机器断电或内核崩溃会丢还没回写的脏页
- 脏页超过约 30 秒后，在下一轮回写（每 5 秒唤醒）中写出，即约 30–35 秒；或占比超过 `dirty_background_ratio` 时后台回写；超过 `dirty_ratio` 时 `write` 自己会被卡住
- `fdatasync` 只同步数据和必需的元数据，通常比 `fsync` 快；新建文件还要对所在目录做一次 `fsync`
- `fsync` 慢（毫秒级），所以 MySQL 用组提交、日志框架用异步刷盘来摊薄

→ 详见 [内存管理与 Page Cache](/os/3_memory#五、write、fsync-与脏页回写)、[文件系统与磁盘 IO · 持久化语义](/os/7_file_io#六、持久化语义)

### Q12：mmap 和 read / write 有什么区别？Kafka 为什么要依赖 Page Cache？

**一句话**：`mmap` 把文件映射进进程地址空间，直接读写 Page Cache，省掉一次内核到用户缓冲区的拷贝和每次读写的系统调用；Kafka 则干脆把缓存交给 Page Cache，不在 JVM 堆里自己缓存。

- 用 Page Cache 的好处：不占堆、不受 GC 影响，进程重启缓存还在，消费者紧跟生产者时读的就是刚写入的页
- Kafka 用 `FileChannel.write` 追加 + `sendfile` 发送，RocketMQ 用 `mmap` 写 CommitLog
- 部署这类中间件时，内存的大头要留给操作系统而不是堆

| 对比 | `read` / `write` | `mmap` |
|------|------------------|--------|
| 拷贝 | 每次多拷一次 | 直接访问 Page Cache |
| 系统调用 | 每次读写一次 | 只在映射 / 解除映射时 |
| 适合 | 顺序流式、小文件 | 大文件随机读写、多进程共享 |

→ 详见 [内存管理与 Page Cache](/os/3_memory#六、mmap)、[为什么 Kafka 与 RocketMQ 依赖 Page Cache](/os/3_memory#七、为什么-kafka-与-rocketmq-依赖-page-cache)

## 四、CPU 缓存、负载与进程

### Q13：什么是伪共享？怎么解决？

**一句话**：CPU 缓存按行（通常 64 字节）工作，两个线程各写不同的变量，但变量落在同一缓存行里，每次写都让对方那一行失效，效果就像在抢同一个变量。

- 根源是缓存一致性协议（MESI）：写之前必须拿到这一行的独占权，其他核的副本全部作废
- 只影响性能不影响正确性，常在「加核不加吞吐」时才暴露
- `@Contended`：字段前后各填充 128 字节，应用代码要加 `-XX:-RestrictContended`
- 类库常用继承层次手工填充（Disruptor 的 `Sequence`），或干脆不共享：按线程分槽再汇总
- `LongAdder` = 分槽减少争抢 + 每个 `Cell` 用 `@Contended` 填充

**常见坑**：对象数量多的类别乱填充，每个对象多出几百字节，内存和 GC 压力反而抵消收益；先用 JMH 或 `perf c2c` 确认再动手。

→ 详见 [CPU 缓存与伪共享](/os/4_cpu_cache#四、伪共享)

### Q14：Load 高但 CPU 使用率低，可能是什么原因？

**一句话**：Linux 的 Load 统计的是 R（运行或排队等 CPU）加 D（不可中断睡眠）状态的线程数，Load 高 CPU 低说明排队的大多是 D 状态，在等磁盘、网络存储或内存回收，而不是在抢 CPU。

- Load 要和逻辑核数比；统计单位是线程，不是进程
- 常见成因：磁盘慢或打满、NFS / 云盘抖动（`hard` 挂载的 NFS 一卡，访问它的线程全进 D 状态，连 `df` 都会卡住）、内存紧张导致直接回收或换页
- 排查：`vmstat 1` 的 `b` 列看阻塞在 IO 上的任务数（完整计数用 `ps -eLo stat | grep -c ^D`），`ps -eLo stat,wchan` 和 `/proc/<pid>/task/<tid>/stack` 看线程卡在哪个内核函数，`iostat -x 1` 看磁盘延迟
- 卡在 IO 上的 Java 线程在 jstack 里仍显示 `RUNNABLE`，要和系统线程状态对照看；修复上把访问共享存储放进独立线程池并设超时
- `wa` 只作参考（只在 CPU 空闲时才计入），更准的是 PSI（`/proc/pressure/io`）；容器里 `/proc/loadavg` 是宿主机的，看 cgroup 的 PSI 和 `cpu.stat` 限流计数

**常见坑**：只按「CPU 高」的思路解读 Load 告警，前面十几分钟都在找 CPU 消耗。

→ 详见 [Load 与 CPU 利用率](/os/5_load_cpu#二、load-高而-cpu-低)、[Load 高但 CPU 不高 · 排查过程](/handbook/2_incidents/18_load_high_cpu_low#三、排查过程)

### Q15：僵尸进程和孤儿进程是什么？容器里的 PID 1 要注意什么？

**一句话**：僵尸是已经退出、但父进程还没 `wait` 取走退出码的进程，只剩一个进程表项；孤儿是父进程先退出的子进程，会被 PID 1 接管。容器里的 PID 1 要负责转发信号和回收孤儿。

- 僵尸不占内存和 CPU，`kill -9` 也杀不掉；危害是占着 PID，堆多了新线程都建不出来
- 处理僵尸：让父进程回收，或结束父进程，僵尸转给 init 回收
- 孤儿本身无害，后台守护进程就是这么来的
- 容器里用 shell 形式启动时 PID 1 是 `sh`，不转发 `SIGTERM`，JVM 收不到停机信号；改用 exec 形式 `ENTRYPOINT ["java", ...]` 或脚本里 `exec java`
- 应用会调外部命令且可能派生子进程时，加 tini 或 `docker run --init` 负责回收

→ 详见 [进程间通信与进程状态](/os/6_ipc_process#_2、僵尸进程)、[容器里的 PID 1](/os/6_ipc_process#三、容器里的-pid-1)

### Q16：进程间通信有哪些方式？各适合什么场景？

**一句话**：进程地址空间互相隔离，交换数据必须走内核提供的通道：父子进程用管道，通知用信号，同机高性能用共享内存或 Unix 域套接字，跨机用 TCP。

- 管道：单向字节流，写满阻塞；Java 的 `ProcessBuilder` 子进程标准输入输出就是管道
- 信号：只传一个编号，`SIGTERM` 触发 JVM 的 shutdown hook，`SIGKILL` 不能捕获
- 共享内存：最快、零拷贝，但同步要自己做；Java 里用 `FileChannel.map` 映射同一个文件
- Unix 域套接字：API 同 TCP，但不走协议栈，同机比 `127.0.0.1` 更快，JDK 16 起原生支持

**常见坑**：`ProcessBuilder` 启动子进程后只 `waitFor` 不读输出，子进程写满管道阻塞，双方互相等待；要么读完输出，要么重定向，并且设超时。

→ 详见 [进程间通信与进程状态](/os/6_ipc_process#一、进程间通信)

## 五、文件系统与磁盘 IO

### Q17：inode、dentry、文件描述符是什么关系？硬链接和软链接有什么区别？

**一句话**：inode 是文件本体（元数据和数据块位置，不含文件名），dentry 是「文件名 → inode」的目录项，fd 是进程 fd 表的下标，指向一次 `open` 产生的 file 对象（记录读写偏移）。

- 改名只改目录项，所以同一文件系统内 `mv` 不复制数据
- 硬链接：再加一个目录项指向同一个 inode，不能跨文件系统、不能指向目录
- 软链接：独立的 inode，内容只是目标路径，原文件删了就悬空
- `rm` 只删目录项，链接数为 0 且没有进程打开时才真正释放空间

→ 详见 [文件系统与磁盘 IO](/os/7_file_io#一、vfs-与文件描述符)

### Q18：iostat 里 %util 到 100% 就说明磁盘打满了吗？

**一句话**：不一定。`%util` 只表示「设备有请求在处理的时间比例」，对一次只能干一件事的 HDD 才准；NVMe、云盘能并行处理很多请求，100% 时可能还有大量余量。

- 先看 `r_await` / `w_await`（含排队的平均耗时），明显升高才是真慢
- 再看 `aqu-sz`（在途请求数）和 `r/s`、`w/s`、`wkB/s` 是否顶到盘的 IOPS / 吞吐规格
- 云盘触顶的典型信号：`w/s` 稳定在一个整数附近，正好是配额
- 定位进程用 `pidstat -d 1`，看延迟分布用 `biolatency`

**常见坑**：`iostat -x` 第一屏是开机以来的平均值，要看后面几屏。

→ 详见 [文件系统与磁盘 IO](/os/7_file_io#_1、iostat-x-的关键列)

### Q19：Buffered IO、Direct IO、mmap、io_uring 有什么区别？Java 怎么用？

**一句话**：前三种是「数据走不走 Page Cache、要不要拷贝」的区别，io_uring 是「提交和等待能不能异步、批量」的区别。

| 方式 | 经 Page Cache | Java 对应 | 适合 |
|------|-------------|----------|------|
| Buffered IO | 是 | `FileChannel.read` / `write` | 绝大多数应用 |
| Direct IO | 否，需块对齐 | `ExtendedOpenOption.DIRECT` | 自带缓存的数据库 |
| mmap | 直接映射，少一次拷贝 | `FileChannel.map()` | 大文件随机读写 |
| io_uring | 都可 | JDK 无官方 API | 新一代存储引擎 |

**常见坑**：Direct IO 不等于落盘，要持久化照样得 `fsync`；Linux 上的 `AsynchronousFileChannel` 是线程池模拟的，不是内核异步。

→ 详见 [文件系统与磁盘 IO](/os/7_file_io#五、io-方式)

### Q20：怎么安全地覆盖写一个配置文件，保证断电后不会是半截？

**一句话**：不要原地覆盖，用「写临时文件 → `fsync` 临时文件 → `rename` 替换 → `fsync` 所在目录」，`rename` 在同一文件系统内是原子的，读者只会看到完整的旧文件或新文件。

- 少了第一次 `fsync`：`rename` 可能先于数据落盘，断电后得到空文件
- 少了目录 `fsync`：`rename` 本身可能丢失，重启后还是旧文件
- Java 写法：`FileChannel.force(true)` + `Files.move(..., ATOMIC_MOVE)` + 对目录的 `FileChannel` 调 `force`
- 文件系统日志只保证结构不坏，不保证没 `fsync` 的数据不丢

**常见坑**：`fsync` 报错后不能简单重试，内核可能已把脏页标为干净，第二次会假装成功。

→ 详见 [文件系统与磁盘 IO](/os/7_file_io#_2、原子替换文件)

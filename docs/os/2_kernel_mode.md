---
description: 特权级、系统调用的路径与成本、vDSO、用 strace 观察 Java 进程、IO 与锁为什么引起上下文切换、futex
---

# 用户态、内核态与系统调用

> 前置阅读：[进程、线程与协程](./1_process_thread)

用户态程序不能直接操作硬件和其他进程的内存，凡是读写文件、收发网络、创建线程，都要通过系统调用请内核代办。本篇讲特权级的划分、系统调用的路径与成本、如何用 `strace` 观察 Java 进程，以及 IO 和锁为什么会引起线程切换，基线为 Linux 6、JDK 21。

---

## 一、为什么要分两种态

CPU 在硬件层面提供了不同的特权级，操作系统据此把代码分成两类：

| 维度 | 用户态 | 内核态 |
|------|--------|--------|
| x86-64 特权级 | Ring 3 | Ring 0 |
| ARM64 异常级别 | EL0 | EL1 |
| 能访问的内存 | 只有本进程的用户地址空间 | 全部内存，包括内核空间 |
| 能执行的指令 | 普通指令 | 还包括特权指令：开关中断、改页表、访问 IO 端口 |
| 出错的后果 | 进程被内核杀掉（如段错误），其他进程不受影响 | 可能导致整机崩溃（kernel panic） |

分开的目的是**隔离与保护**：一个程序的 bug 或恶意代码不能直接改写其他进程或内核的数据，也不能独占硬件。代价是每次需要内核服务时，都要经过一次受控的切换。

用户态进入内核态只有三条路：

| 方式 | 触发者 | 例子 |
|------|--------|------|
| 系统调用 | 程序主动请求 | `read`、`write`、`epoll_wait`、`clone` |
| 异常 | 当前指令出了状况 | 缺页、除零、非法内存访问 |
| 中断 | 外部设备 | 网卡收到数据包、磁盘 IO 完成、时钟中断 |

时钟中断让内核能定期拿回控制权，这是 [上一篇](./1_process_thread) 讲的抢占式调度得以实现的基础。

---

## 二、系统调用的路径

![一次 read 系统调用从 Java 代码到内核的路径](../assets/os/syscall-path.svg)

以 Java 读文件为例：

1. `FileInputStream.read` 调用 JDK 的 native 方法，进入 `libjava` 中的 C 代码
2. C 代码调用 glibc 的 `read()`，glibc 把系统调用号和参数放入约定的寄存器，执行 `syscall` 指令
3. CPU 切换到 Ring 0，跳到内核预先登记的入口，保存用户态寄存器
4. 内核按系统调用号找到 `sys_read`，经过 VFS（虚拟文件系统）层找到对应的文件或 Socket，从 Page Cache 或 Socket 接收缓冲区把数据拷贝到用户缓冲区
5. 把返回值写入寄存器，执行 `sysret` 回到用户态

常见的 Java API 与系统调用的对应关系：

| Java API | 主要系统调用 |
|----------|-------------|
| `FileInputStream.read` / `FileOutputStream.write` | `read` / `write` |
| `FileChannel.force` | `fsync` / `fdatasync` |
| `FileChannel.transferTo` | `sendfile`（目标是 Socket 时） |
| `Selector.select`（Linux） | `epoll_wait` |
| `new Thread().start()` | `clone3` / `clone` |
| `ByteBuffer.allocateDirect` | `Unsafe.allocateMemory` → `malloc`（大块时 glibc 转用 `mmap`） |
| 堆扩容 | `mmap` |
| `LockSupport.park` 与锁竞争 | `futex` |

---

## 三、系统调用的成本

### 1、成本在哪里

一次系统调用是**模式切换**，不是上一篇讲的线程上下文切换：同一个线程从用户态进入内核态再回来，不涉及调度。它的成本主要来自：

| 成本 | 说明 |
|------|------|
| 进出内核本身 | 保存恢复寄存器、切换栈；空系统调用通常在百纳秒量级 |
| 安全缓解措施 | 为防御 Meltdown / Spectre 类漏洞，内核在切换时要做额外工作（如 KPTI 切换页表、清理分支预测状态），在部分 CPU 上让切换成本翻倍 |
| 数据拷贝 | `read` / `write` 要在内核缓冲区与用户缓冲区之间拷贝数据 |
| 可能的阻塞 | 数据没准备好时线程睡眠，这时才会引发上下文切换，成本立刻上升到微秒级 |

单次系统调用不贵，贵的是**次数多**和**引起阻塞**。

### 2、减少系统调用的常见手段

| 手段 | 做法 | Java 中的例子 |
|------|------|--------------|
| 缓冲 | 在用户态攒够一批再调用一次 | `BufferedOutputStream`、日志框架的缓冲 Appender |
| 批量与向量 IO | 一次调用读写多个缓冲区 | `GatheringByteChannel.write(ByteBuffer[])` 对应 `writev` |
| 多路复用 | 一次调用等待一批连接 | `Selector` 对应 `epoll_wait`，见 [IO 模型](/netty/1_io_model) |
| 零拷贝 | 数据不经过用户态 | `FileChannel.transferTo`，见 [IO 与 NIO · 零拷贝](/java/18_topic_io#四、零拷贝) |
| vDSO | 内核把部分只读服务映射到用户空间，调用时不进内核 | `System.currentTimeMillis()`、`System.nanoTime()` 最终走 `clock_gettime`，通常不进内核 |

Linux 5.1 起还提供了 io_uring：用户态和内核共享两个环形队列，提交 IO 和收取结果都不必每次发系统调用。JDK 目前没有直接使用它，Netty 有单独的 io_uring 传输实现。

---

## 四、用 strace 观察 Java 进程

`strace` 通过 ptrace 拦截目标进程的每一次系统调用，适合回答"这个进程此刻在和内核做什么"。

### 1、常用命令

```bash
# 统计 30 秒内各系统调用的次数与耗时（-f 跟踪所有线程，Java 进程必须加）
timeout 30 strace -f -c -p <pid>

# 只看网络与锁相关的调用，带时间戳与每次调用耗时
strace -f -tt -T -e trace=network,futex -p <pid>

# 只跟踪一个线程：tid 可由 top -H 或 jstack 的 nid 得到
strace -tt -T -p <tid>

# 看 JVM 启动时打开了哪些文件
strace -f -e trace=openat -o /tmp/open.log java -jar app.jar
```

### 2、怎么读结果

`strace -c` 的输出按耗时排序，Java 服务里常见的几类：

| 调用 | 多说明什么 |
|------|-----------|
| `futex` | 线程在等锁、等条件、`park`；占比高通常意味着锁竞争或大量空闲线程在等待任务 |
| `epoll_wait` | NIO / Netty 的事件循环在等网络事件，空闲时占比高是正常的 |
| `read` / `write` / `recvfrom` / `sendto` | 文件或网络 IO；次数极多而每次字节很少，说明缺少缓冲 |
| `fsync` / `fdatasync` | 有代码在强制刷盘，单次耗时直接影响写延迟 |
| `mmap` / `munmap` / `madvise` | 内存映射与归还，GC 调整堆大小或直接内存分配释放频繁时会多 |

::: warning 生产环境慎用 strace
ptrace 让目标线程每次系统调用都停下来交给 strace 处理，系统调用密集的进程可能慢上数倍甚至更多。线上只做短时间的 `-c` 统计，或改用开销小得多的 `perf trace`（基于内核 tracepoint）或 bpftrace 等 eBPF 工具。
:::

---

## 五、为什么 IO 和锁会引起切换

### 1、阻塞 IO

线程调用阻塞的 `read` 读 Socket 时，如果接收缓冲区里没有数据：

1. 内核把线程挂到这个 Socket 的等待队列上，状态改为 `S`（可中断睡眠）
2. 调度器把 CPU 交给别的线程，这是一次**自愿上下文切换**
3. 数据到达后，网卡中断与软中断处理把线程唤醒，放回运行队列
4. 线程再次被调度上 CPU，完成数据拷贝，`read` 返回

每个等待中的连接都占着一个睡眠的线程，这就是 BIO 线程数撑不住高并发的原因。NIO 用 `epoll_wait` 让一个线程等一批连接；虚拟线程则在 JDK 内部把阻塞调用改成"注册到 poller、卸载虚拟线程"，载体线程不进入睡眠，细节见 [IO 模型](/netty/1_io_model) 与 [虚拟线程](/java/30_topic_virtual_thread)。

### 2、锁与 futex

Java 的锁在没有竞争时**完全不进内核**：`synchronized` 和 `ReentrantLock` 的加锁都是用户态的 CAS 操作。只有拿不到锁、需要等待时才进内核：

1. 线程先在用户态短暂自旋，期望持有者很快释放
2. 仍拿不到就调用 `LockSupport.park`（`synchronized` 走 JVM 内部的等价路径），最终落到 `futex(FUTEX_WAIT)` 系统调用，线程进入睡眠
3. 持有者释放锁时，发现有人在等，调用 `futex(FUTEX_WAKE)` 唤醒一个等待者

futex（Fast Userspace Mutex）的设计正是"无竞争走用户态，有竞争才进内核"。所以：

| 情况 | 系统调用 | 上下文切换 |
|------|---------|-----------|
| 无竞争加锁、解锁 | 无 | 无 |
| 短暂竞争，自旋成功 | 无 | 无 |
| 竞争激烈，需要等待 | `futex` 等待与唤醒 | 每次等待各一次 |

锁竞争激烈时，`pidstat -w` 的自愿切换数和 `strace -c` 中的 `futex` 都会明显上升。减少竞争的手段（缩小临界区、分段、无锁结构）见 [synchronized](/java/24_topic_synchronized) 与 [显式锁](/java/25_topic_lock)。

`Thread.sleep`、`Object.wait`、`BlockingQueue.take` 等让线程等待的操作，在平台线程上同样最终落到 `futex` 或定时等待类系统调用。

---

## 小结

- 用户态与内核态由 CPU 特权级划分，目的是隔离与保护；进入内核只有系统调用、异常、中断三条路
- 系统调用是同一线程内的模式切换，单次在百纳秒量级；真正昂贵的是调用次数多和调用中发生阻塞
- 减少系统调用：用户态缓冲、批量与向量 IO、多路复用、零拷贝；获取时间走 vDSO，通常不进内核
- `strace -f -c -p <pid>` 可以快速看出 Java 进程的系统调用分布，但开销大，线上只做短时统计或改用 eBPF 工具
- 阻塞 IO 让线程睡眠并引发自愿切换；锁在无竞争时只是用户态 CAS，有竞争时经 `futex` 睡眠与唤醒

## 参考资料

- Linux man-pages：[syscalls(2)](https://man7.org/linux/man-pages/man2/syscalls.2.html)
- Linux man-pages：[syscall(2)](https://man7.org/linux/man-pages/man2/syscall.2.html)
- Linux man-pages：[vdso(7)](https://man7.org/linux/man-pages/man7/vdso.7.html)
- Linux man-pages：[futex(2)](https://man7.org/linux/man-pages/man2/futex.2.html)
- strace 官方手册：[strace(1)](https://man7.org/linux/man-pages/man1/strace.1.html)
- Linux man-pages：[io_uring(7)](https://man7.org/linux/man-pages/man7/io_uring.7.html)

> 下一篇：[内存管理与 Page Cache](./3_memory) —— 系统调用读写的数据最终落在哪里：虚拟内存、缺页，以及写入成功和真正落盘之间的那段距离。

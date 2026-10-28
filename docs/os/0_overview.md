# 操作系统总览

本模块从 Java 后端视角讲操作系统：线程怎么被调度、一次 IO 为什么要进内核、数据写到哪里才算落盘、CPU 缓存如何影响并发代码。内核源码与驱动开发不在范围内，示例以 Linux 为准。

**版本基线（2026 年 10 月）**：Linux 6 内核、JDK 21 / 25

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

Java 程序的线程、IO、内存最终都落到操作系统上：`Thread` 对应内核线程，`read` / `write` 是系统调用，堆和直接内存都是进程的虚拟内存，文件写入先进 Page Cache。按下面的顺序读，每篇都会落到一个 Java 里的具体现象。

1. [进程、线程与协程](./1_process_thread)：三者的区别、Linux 用 `task_struct` 与 `clone` 统一表示进程和线程、平台线程与虚拟线程的映射关系、上下文切换与调度器
2. [用户态、内核态与系统调用](./2_kernel_mode)：特权级、系统调用的路径与成本、用 `strace` 观察 Java 进程、IO 与锁为什么会引起切换
3. [内存管理与 Page Cache](./3_memory)：虚拟内存与分页、缺页与 Swap、Page Cache 读写路径、`write` 与 `fsync`、`mmap`
4. [CPU 缓存与伪共享](./4_cpu_cache)：缓存层级、缓存行与一致性协议、伪共享的成因与 `@Contended`
5. [Load 与 CPU 利用率](./5_load_cpu)：Load Average 的含义、Load 高而 CPU 低的成因、CPU 各项占比的拆解
6. [进程间通信与进程状态](./6_ipc_process)：管道、信号、共享内存与 Socket，进程状态、僵尸进程与容器中的 PID 1
7. [文件系统与磁盘 IO](./7_file_io)：VFS 与文件描述符、ext4 / xfs、块层与 IO 调度、Direct IO 与 io_uring、`fsync` 语义、`iostat` 与云盘限速

复习时用 [高频面试题](./99_interview) 自测，答案在 [操作系统面试题解答](/interview/4_computer_os)。

---

## 三、关联模块

- [IO 模型](/netty/1_io_model)：阻塞 IO、非阻塞 IO 与 epoll，是系统调用在网络编程上的具体应用
- [JMM 内存模型](/java/22_topic_jmm)：CPU 缓存、写缓冲与重排序在 Java 语言层面的约定
- [虚拟线程](/java/30_topic_virtual_thread)：JVM 在内核线程之上实现的 M:N 调度
- [Linux 概览](/cloud-native/1_linux)：进程与信号、文件描述符、systemd 等运维层面的 Linux 知识
- [Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)：CPU、内存、磁盘、网络的排查命令清单
- [高性能总览](/high-perf/0_overview)：把本模块的原理用到性能指标、Profiler 与 IO 优化上
- [操作系统面试题解答](/interview/4_computer_os)：本模块高频问题的答案汇总

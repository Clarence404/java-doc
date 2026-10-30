---
description: 虚拟内存与缺页、Swap 与 OOM Killer、Page Cache、write 与 fsync、脏页回写、mmap、容器内存
---

# 内存管理与 Page Cache

> 前置阅读：[用户态、内核态与系统调用](./2_kernel_mode)

进程看到的都是虚拟地址，由内核按页映射到物理内存，文件读写默认经过 Page Cache。本篇讲虚拟内存与缺页、Swap、Page Cache、`fsync` 与 `mmap`，基线为 Linux 6、JDK 21。

---

## 一、虚拟内存

### 1、每个进程一套地址空间

每个进程都以为自己独占一大片连续内存，实际上它用的是**虚拟地址**。CPU 访问内存时，由 MMU（内存管理单元）查**页表**把虚拟地址翻译成物理地址：

| 概念 | 说明 |
|------|------|
| 页 | 映射的最小单位，x86-64 上默认 4 KB |
| 页表 | 每个进程一份，记录虚拟页到物理页的映射与权限；x86-64 默认 4 级，48 位虚拟地址可寻址 256 TB |
| TLB | CPU 内的地址翻译缓存，命中时不用查页表；进程切换会让它失效 |

带来的好处：

- **隔离**：进程 A 的地址根本映射不到进程 B 的物理页
- **按需分配**：申请一大段虚拟地址几乎不花成本，用到哪一页才分配物理内存
- **共享**：多个进程可以把同一批物理页映射进各自的地址空间，例如共享库、Page Cache 中的文件页

### 2、Java 进程的虚拟内存

一个 Java 进程的地址空间里有这些区域，它们都是通过 `mmap` 等系统调用向内核申请的虚拟内存：

| 区域 | 控制参数 |
|------|---------|
| Java 堆 | `-Xms` / `-Xmx` |
| 元空间 | `-XX:MaxMetaspaceSize` |
| 线程栈 | `-Xss`，每个线程一份 |
| 直接内存 | `-XX:MaxDirectMemorySize` |
| JIT 代码缓存 | `-XX:ReservedCodeCacheSize` |
| GC 数据结构、JVM 自身、native 库 | 无统一上限 |

所以 `top` 里 Java 进程的 **VIRT**（虚拟内存）往往远大于堆，真正值得关心的是 **RSS**（实际驻留在物理内存中的部分）。各区域的大小与排查方法见 [内存结构](/jvm/1_memory)。

---

## 二、分页与缺页

### 1、缺页异常

虚拟页第一次被访问、或者对应的物理页已被换出时，MMU 查不到有效映射，触发**缺页异常**，CPU 转入内核处理：

| 类型 | 原因 | 代价 |
|------|------|------|
| 次缺页（minor fault） | 物理页还没分配，或数据已在 Page Cache 中，只需建立映射 | 微秒级，不读磁盘 |
| 主缺页（major fault） | 数据要从磁盘（文件或 Swap）读入 | 毫秒级，线程阻塞等 IO |

`ps -o min_flt,maj_flt -p <pid>` 可以看进程累计的缺页次数，`maj_flt` 持续增长说明在频繁读盘换页。

这也解释了 Java 堆的一个现象：`-Xms` 设得再大，启动后 RSS 也只是慢慢涨，因为堆页是在第一次写入时才通过缺页分配物理内存的。加上 `-XX:+AlwaysPreTouch` 会在启动时把整个堆逐页写一遍，启动变慢，但运行期不再为首次触碰堆页付出缺页代价。

### 2、大页

4 KB 的页对几十 GB 的堆来说太碎：页表很大，TLB 也只能覆盖很小一段内存。大页（x86-64 上 2 MB 或 1 GB）能减少页表项和 TLB 未命中：

- **透明大页（THP）**：内核自动把连续的小页合并成大页；`/sys/kernel/mm/transparent_hugepage/enabled` 为 `madvise` 时，只对主动申请的区域生效
- JVM 用 `-XX:+UseTransparentHugePages` 对堆申请透明大页，适合大堆、访问分散的应用；设为 `always` 时内核的后台整理偶尔会带来延迟抖动，延迟敏感的服务要实测

### 3、超额分配与 OOM Killer

Linux 默认允许**超额分配**（overcommit）：申请虚拟内存时只做粗略检查，因为大部分申请不会被全部用到。当物理内存和 Swap 真的耗尽、又回收不出内存时，内核的 **OOM Killer** 按评分挑一个进程杀掉，内存占用最大的 Java 进程往往首当其冲。

这和 JVM 的 `OutOfMemoryError` 是两回事：前者是内核直接用 `SIGKILL` 结束进程，应用来不及打日志；后者是堆或元空间用满，由 JVM 抛出异常。查看方法见 [Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)。

---

## 三、Swap

内存紧张时，内核可以把不常用的**匿名页**（堆、栈这类没有对应文件的内存）写到磁盘上的 Swap 区，腾出物理内存；之后再访问时发生主缺页，从 Swap 读回。

Swap 对 Java 服务尤其不友好：GC 要遍历存活对象、移动对象，会触碰大片堆内存。如果其中一部分已被换出，一次 GC 会引发大量主缺页，停顿从几十毫秒拉长到秒级。

| 做法 | 说明 |
|------|------|
| 关闭 Swap 或给足内存 | 服务器上常见做法；Kubernetes 节点默认也不启用 Swap |
| 调低 `vm.swappiness` | 默认 60，值越小内核越倾向于回收 Page Cache 而不是换出匿名页 |
| 监控换页 | `vmstat 1` 的 `si` / `so` 持续非零就要处理 |

`swappiness` 调为 0 并不等于禁用 Swap，内存极度紧张时仍可能换出。

---

## 四、Page Cache

### 1、是什么

Page Cache 是内核用空闲物理内存缓存文件内容的机制，以页为单位。除非显式绕过（如 `O_DIRECT`），所有普通文件的读写都经过它。

`free -h` 中的 `buff/cache` 主要就是 Page Cache。它的特点是**能用就用、需要就还**：空闲内存会被尽量拿来缓存文件，应用要内存时，内核回收干净的缓存页。所以判断内存是否够用看 `available`，而不是 `free`。

### 2、读写路径

![读写文件经过 Page Cache 的路径](../assets/os/page-cache-path.svg)

**读**：

1. 数据在 Page Cache 中（命中），直接从缓存页拷贝到用户缓冲区，不访问磁盘
2. 未命中时，内核分配缓存页，从磁盘读入后再拷贝给应用
3. 内核发现是顺序读时会**预读**后续的页，所以顺序读文件即使是首次也很快

**写**：

1. `write` 把数据从用户缓冲区拷贝到 Page Cache，把这些页标记为**脏页**，然后立即返回
2. 内核的 flusher 线程在后台把脏页写回磁盘，之后这些页变回干净页

这意味着 **`write` 返回成功只说明数据进了内核内存，不说明落了盘**。机器断电或内核崩溃时，还没写回的脏页会丢失；仅仅是进程崩溃则不影响，因为数据已经在内核里了。

### 3、回收

内存紧张时，内核把 Page Cache 页分成活跃和不活跃两组，优先回收长时间没被访问的干净页（Linux 6.1 起可选用多代 LRU，即 MGLRU，按访问时间分更多代来选择）。脏页要先写回才能回收，所以大量脏页会拖慢内存回收。

测试时常用 `echo 1 > /proc/sys/vm/drop_caches` 清空 Page Cache 来模拟冷启动，生产环境不要这样做，会导致之后的读请求全部打到磁盘。

---

## 五、write、fsync 与脏页回写

### 1、脏页何时写回

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `vm.dirty_expire_centisecs` | 3000（30 秒） | 脏页存在超过这个时间，下一轮回写时写出 |
| `vm.dirty_writeback_centisecs` | 500（5 秒） | flusher 线程被唤醒检查的间隔 |
| `vm.dirty_background_ratio` | 10 | 脏页占可用内存的比例超过它，后台开始回写，不阻塞应用 |
| `vm.dirty_ratio` | 20 | 超过它，执行 `write` 的进程自己被拖去参与回写，`write` 会卡住 |

写入密集的服务偶尔出现 `write` 延迟尖刺，常见原因就是脏页触到了 `dirty_ratio`。大内存机器上按比例算出的阈值可能有几十 GB，一次回写时间很长，可以改用 `vm.dirty_background_bytes` / `vm.dirty_bytes` 设成固定字节数。

### 2、需要落盘时

`write` 成功只说明数据进了 Page Cache，需要持久化保证时必须在 `write` 之后显式调用 `fsync` / `fdatasync`（Java 为 `FileChannel.force`），新建文件还要对所在目录做一次 `fsync`；绕过 Page Cache 的 `O_DIRECT` 适合自带 Buffer Pool 的引擎。各调用推进到哪一层、对应的 Java API、`fsync` 成本与 Direct IO 的用法见 [文件系统与磁盘 IO · 持久化语义](./7_file_io#六、持久化语义) 与 [文件系统与磁盘 IO · Direct IO](./7_file_io#_2、direct-io)。

---

## 六、mmap

`mmap` 把文件的一段映射到进程的虚拟地址空间，之后像访问内存一样读写文件：

1. 映射时只建立虚拟地址区间，不读任何数据
2. 第一次访问某一页触发缺页，内核把该页对应的 Page Cache 页（没有就先从磁盘读入）直接映射给进程
3. 写入直接修改 Page Cache 中的页，页变成脏页，回写规则与 `write` 相同；需要落盘时调用 `msync`

与 `read` / `write` 相比：

| 维度 | `read` / `write` | `mmap` |
|------|-----------------|--------|
| 数据拷贝 | 每次在 Page Cache 与用户缓冲区之间拷贝一次 | 直接访问 Page Cache，没有这次拷贝 |
| 系统调用 | 每次读写一次 | 只在映射与解除映射时 |
| 首次访问 | 随调用读入 | 每页一次缺页异常 |
| 适合 | 顺序流式读写、小文件 | 大文件的随机读写、多进程共享 |

Java 中对应 `FileChannel.map()`，它的 2 GB 限制、无法主动解除映射的问题，以及 JDK 22 FFM API 的替代写法见 [IO 与 NIO · 零拷贝](/java/18_topic_io#四、零拷贝)。`mmap` + `write` 与 `sendfile` 如何减少网络发送中的拷贝也在那一节，Netty 的用法见 [ByteBuf](/netty/6_bytebuf)。

---

## 七、为什么 Kafka 与 RocketMQ 依赖 Page Cache

两者都把消息顺序追加到磁盘文件，并有意把缓存交给操作系统，而不是在 JVM 堆里自己做：

- **不占堆、不受 GC 影响**：几十 GB 的热数据放在 Page Cache 里，JVM 堆可以保持较小，GC 停顿短
- **重启后缓存还在**：进程重启不会清空 Page Cache，热数据仍在内存，不用重新预热
- **写入即可读**：消费者通常紧跟生产者，读的正是刚写入、还在 Page Cache 中的页，几乎不访问磁盘
- **顺序 IO + 预读**：追加写和顺序读都能充分利用内核的回写合并与预读

两者在使用方式上有差别：

| 维度 | Kafka | RocketMQ |
|------|-------|----------|
| 写入方式 | `FileChannel.write` 追加到日志段 | `mmap` 映射 CommitLog，直接写映射区 |
| 刷盘策略 | 默认交给操作系统回写，持久性靠多副本 | 默认异步刷盘，可配置同步刷盘 |
| 发送给消费者 | `sendfile` 零拷贝 | 从映射区读取后发送 |

因此部署这类中间件时，**机器内存的大头应留给 Page Cache 而不是 JVM 堆**；同一台机器上混部其他吃内存的进程，会挤占缓存，导致消费者读盘、延迟上升。具体配置见 [Kafka 架构与存储](/messaging/2_kafka) 与 [RocketMQ](/messaging/3_rocketmq)。

---

## 八、容器中的 Page Cache

cgroup v2 把容器内进程读写文件产生的 Page Cache 也**计入容器的内存用量**（`memory.current`），因此：

- 一个写日志很多的容器，`memory.current` 可能逐渐接近 `memory.max`，但其中大部分是可回收的缓存，接近上限时内核会先回收它们，不会直接触发 OOM Kill
- 监控应看 **working set**（用量减去不活跃的文件缓存，即 `container_memory_working_set_bytes`），Kubernetes 判断内存压力和驱逐也基于它，见 [指标监控](/observability/2_metrics)
- 回收不掉的部分（匿名页、脏页、被频繁访问的缓存）才是真正的压力；脏页过多时，容器内的写入会因回写而变慢

给 Java 容器设内存 limit 时，除了堆，还要为直接内存、线程栈、元空间以及一定量的 Page Cache 留出余量。

---

## 小结

- 进程使用虚拟地址，经页表和 TLB 翻译成物理地址；物理内存在第一次访问时通过缺页异常分配，所以 Java 进程的 VIRT 远大于 RSS
- 主缺页要读磁盘，代价是毫秒级；`AlwaysPreTouch` 把首次触碰堆页的代价挪到启动时；大页减少 TLB 未命中
- 内存耗尽时内核的 OOM Killer 直接杀进程，与 JVM 的 `OutOfMemoryError` 不同；Swap 会让 GC 停顿急剧变长，Java 服务应避免换页
- 普通文件读写都经过 Page Cache：读有命中与预读，写只拷贝进缓存并标记脏页，由 flusher 线程在脏页超阈值时回写，或在脏页超过约 30 秒后的下一轮回写（每 5 秒唤醒）中写出，即约 30–35 秒
- `write` 成功不等于落盘，需要持久化时用 `fsync` / `fdatasync`（`FileChannel.force`），细节见文件系统与磁盘 IO 的持久化语义一节
- `mmap` 直接访问 Page Cache，省去一次拷贝和逐次系统调用，适合大文件随机读写
- Kafka、RocketMQ 把缓存交给 Page Cache，因此内存要留给操作系统；容器中的 Page Cache 计入内存用量，监控看 working set

## 参考资料

- Linux 内核文档：[Documentation for /proc/sys/vm/](https://docs.kernel.org/admin-guide/sysctl/vm.html)
- Linux 内核文档：[Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)
- Linux 内核文档：[Control Group v2 · Memory](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)
- Linux man-pages：[mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html)、[fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)、[open(2)](https://man7.org/linux/man-pages/man2/open.2.html)
- Apache Kafka 文档：[Persistence](https://kafka.apache.org/documentation/#persistence)
- JDK 25 API：[FileChannel](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/channels/FileChannel.html)

> 下一篇：[CPU 缓存与伪共享](./4_cpu_cache) —— 内存之上还有一层 CPU 缓存，它的最小单位缓存行会让看似无关的两个变量互相拖慢。

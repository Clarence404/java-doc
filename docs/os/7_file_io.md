---
description: VFS 与文件描述符、ext4 / xfs、块层与 IO 调度、磁盘性能、Direct IO 与 io_uring、fsync 语义、iostat、云盘限速
---

# 文件系统与磁盘 IO

> 前置阅读：[内存管理与 Page Cache](./3_memory)、[进程间通信与进程状态](./6_ipc_process)

Page Cache 之下，文件还要经过文件系统、块层和设备驱动才落到磁盘上，每一层都会影响延迟和持久性。本篇讲 VFS、文件系统选型、块层与 IO 调度、IO 方式、持久化语义与排查，基线为 Linux 6、JDK 21。

---

## 一、VFS 与文件描述符

### 1、inode、dentry 与 file 三层

Linux 用虚拟文件系统（VFS）把 ext4、xfs、procfs、网络文件系统统一成一套接口，`open` / `read` / `write` 不关心底下是哪种文件系统。VFS 里有三类核心对象：

| 对象 | 数量关系 | 保存什么 |
|------|---------|---------|
| inode | 每个文件一个 | 权限、属主、大小、时间戳、数据块位置、链接数；**不含文件名** |
| dentry | 每个路径分量一个 | 文件名到 inode 的映射，缓存在 dcache 中加速路径解析 |
| file | 每次 `open` 一个 | 当前读写偏移、打开标志（`O_APPEND`、`O_DIRECT` 等） |

![从文件描述符到磁盘：VFS 三层对象与块层路径](../assets/os/vfs-block-path.svg)

文件名只存在于目录项里，所以「改名」只是改目录项，`mv` 同一文件系统内的文件不复制数据。inode 数量在 ext4 上由 `mkfs` 时决定，海量小文件可能出现「`df -h` 有空间、`df -i` 满了」的情况，案例见 [磁盘写满](/handbook/2_incidents/20_disk_full#_1、确认是空间满还是-inode-满)。

### 2、文件描述符表

每个进程有一张 fd 表，fd 只是表的下标，指向内核里的 file 对象：

- 0、1、2 是标准输入、输出、错误，新打开的文件取最小的空闲编号
- 上限由 `ulimit -n`（`RLIMIT_NOFILE`）控制，超出就是 Java 里的 `Too many open files`；Socket 也占 fd
- `fork` 和 `dup` 产生的 fd 指向**同一个** file 对象，共享读写偏移；两次独立 `open` 则各有各的偏移
- `O_APPEND` 打开时，每次 `write` 前把偏移移到文件末尾的动作是原子的，多进程追加同一日志文件不会互相覆盖

`ls -l /proc/<pid>/fd` 能看到 Java 进程打开的全部文件与 Socket，排查 fd 泄漏时先数这里。

### 3、硬链接与软链接

| 维度 | 硬链接 | 软链接（符号链接） |
|------|-------|------------------|
| 本质 | 又一个目录项指向**同一个 inode** | 一个独立的 inode，内容是目标路径 |
| 跨文件系统 | 不能 | 能 |
| 指向目录 | 不能（防止目录树出环） | 能 |
| 删除原文件 | 数据仍在，链接数减一 | 链接悬空，访问报 `No such file` |

`ls -li` 第一列是 inode 号，第三列是链接数。Java 中对应 `Files.createLink` 与 `Files.createSymbolicLink`。

### 4、删除仍被打开的文件

`rm` 只删目录项、链接数减一；inode 和数据块要等**链接数为 0 且没有进程打开**才释放。所以正在写的日志被删后 `df` 不降、`du` 找不到，原理与处理见 [进程间通信与进程状态 · 删除正在写的文件](./6_ipc_process#四、删除正在写的文件-空间为什么不释放)。

---

## 二、常见文件系统

### 1、ext4 与 xfs 选型

| 维度 | ext4 | xfs |
|------|------|-----|
| 默认发行版 | Debian / Ubuntu | RHEL / Rocky 等红帽系 |
| inode 分配 | `mkfs` 时固定数量 | 按需动态分配，不易耗尽 |
| 并发写 | 一般 | 按分配组并行，多线程大文件写入更好 |
| 缩容 | 支持离线缩小 | **不支持缩小** |
| 适合 | 通用场景、系统盘 | 大文件、数据库与消息队列数据盘 |

两者都很成熟，没有明显性能短板时跟随发行版默认即可。数据盘规划时更关心挂载选项和 RAID / 云盘规格，而不是在两者间反复对比。

### 2、日志模式

文件系统的日志（journal）用来保证崩溃后**元数据**一致，不必全盘 `fsck`。ext4 有三种模式：

| 模式 | 写日志的内容 | 特点 |
|------|------------|------|
| `data=ordered`（默认） | 只写元数据，但保证数据块先于元数据落盘 | 崩溃后不会出现「文件变大了、内容是旧垃圾」 |
| `data=writeback` | 只写元数据，不约束数据顺序 | 最快，崩溃后文件尾部可能是旧数据 |
| `data=journal` | 数据和元数据都写日志 | 最安全，数据写两次，吞吐明显下降 |

xfs 只记录元数据日志。要注意：**日志保证的是文件系统结构不坏，不保证应用数据不丢**，没 `fsync` 的数据照样会丢，见第六节。

### 3、挂载选项

| 选项 | 作用 | 建议 |
|------|-----|------|
| `noatime` | 读文件不更新访问时间 | 数据盘推荐；默认的 `relatime` 已只在必要时更新，收益较小 |
| `nodiratime` | 目录不更新访问时间 | `noatime` 已包含 |
| `discard` | 删除时实时下发 TRIM | SSD 上多数场景改用定时 `fstrim`，避免删除时卡顿 |
| `nobarrier` | 关闭写屏障 | xfs 已移除该选项，ext4 仍接受；**不要**为了性能关掉 |

用 `findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS` 查看当前挂载参数。

---

## 三、块层与 IO 调度

### 1、请求如何下发

文件系统确定要读写哪些磁盘块后，构造 `bio`（一段连续扇区加内存页列表）交给块层。块层自 Linux 5.0 起只保留多队列框架 blk-mq：

1. 每个 CPU 有软件队列，`bio` 在这里与相邻请求合并成 `request`
2. 经 IO 调度器排序、调度（调度器为 `none` 时跳过）
3. 放入硬件派发队列，由驱动提交给设备
4. 设备用 DMA 完成数据搬运后中断通知内核，等待的线程被唤醒

等待 IO 完成的线程处于 D 状态，所以磁盘慢会推高 Load，见 [Load 与 CPU 利用率](./5_load_cpu#二、load-高而-cpu-低)。

### 2、IO 调度器

```bash
cat /sys/block/nvme0n1/queue/scheduler     # 方括号内是当前调度器，如 [none] mq-deadline kyber bfq
echo mq-deadline > /sys/block/sda/queue/scheduler
```

| 调度器 | 思路 | 适合 |
|-------|------|------|
| `none` | 不排序，直接下发 | NVMe 及云盘等自身有调度能力的设备，多数发行版对 NVMe 的默认值 |
| `mq-deadline` | 按扇区排序合并，为读写设截止时间防饿死 | SATA SSD、HDD，服务器的常见默认值 |
| `bfq` | 按进程公平分配带宽 | 桌面交互、需要按 cgroup 权重分配的场景，CPU 开销较高 |
| `kyber` | 按读写目标延迟限制队列深度 | 快速设备上想控制延迟的场景 |

调度器的意义随设备变快而变小：HDD 寻道昂贵，排序能省大量时间；NVMe 内部并行度高，额外调度只增加 CPU 开销。

### 3、NVMe 多队列

SATA / AHCI 只有 1 个队列、深度 32；NVMe 协议允许多达 64K 个队列、每队 64K 深度，通常每个 CPU 一对提交 / 完成队列，无需跨核加锁。这也是 NVMe 只有在**高并发（队列深度大）**时才能跑出标称 IOPS 的原因：单线程同步读写一次只有一个请求在途，看到的是单次延迟而不是设备上限。

---

## 四、磁盘性能特征

### 1、IOPS、吞吐与延迟

- **IOPS**：每秒完成的 IO 次数，小块随机读写看它
- **吞吐**：每秒传输的字节数，等于 IOPS × 单次大小，大块顺序读写看它
- **延迟**：单次 IO 从提交到完成的时间，同步写、`fsync` 看它

三者通过并发联系起来：在途请求数 ≈ IOPS × 延迟（利特尔定律）。单线程同步 4 KB 写、每次 0.1 ms，最多约 1 万 IOPS、40 MB/s，与设备标称上限无关。

### 2、HDD 与 SSD

| 介质 | 随机 4K IOPS | 顺序吞吐 | 典型延迟 | 瓶颈 |
|------|------------|---------|---------|------|
| HDD | 100–200 | 100–250 MB/s | 5–10 ms | 磁头寻道与盘片旋转 |
| SATA SSD | 数万到约 10 万 | 约 500 MB/s | 约 100 μs | SATA 接口带宽 |
| NVMe SSD | 数十万到百万级 | 数 GB/s | 数十 μs | 并发度与 CPU |

数值为数量级参考，具体以盘的规格与压测为准。HDD 的顺序吞吐尚可，随机 IOPS 却差三个数量级，**顺序与随机的差距在 HDD 上最大**。

### 3、顺序与随机

SSD 没有寻道，随机读与顺序读差距不大，但顺序 IO 仍然更快：

- 内核能合并相邻请求、做预读，请求数更少
- 大块写正好填满闪存页，减少 SSD 内部搬运
- 文件系统分配连续块，元数据更新更少

### 4、写放大

**写放大**指底层实际写入量大于应用写入量，SSD 上有两层来源：

- **闪存特性**：闪存按页写、按块擦，不能原地覆盖；改写数据要写到新页，旧页留待垃圾回收，回收时还要搬运块内的有效页
- **软件层**：文件系统日志、数据库双写、LSM 的 compaction 都会把同一份数据多写几遍

写放大既降低写吞吐，也消耗 SSD 寿命（TBW）。随机小写最容易放大，顺序大块写最友好。

### 5、为什么 Kafka 与 LSM 偏爱顺序写

Kafka 把消息追加到分段日志、RocketMQ 追加到 CommitLog，RocksDB、HBase 等 LSM 引擎先追加 WAL 再把内存表整块刷成 SSTable，都是把随机写变成顺序追加：

- HDD 上把毫秒级寻道变成连续传输，吞吐相差两个数量级
- SSD 上大块顺序写的写放大最小、延迟最稳定
- 追加写配合 Page Cache 与预读，消费者读刚写入的数据几乎不碰盘，见 [内存管理与 Page Cache](./3_memory#七、为什么-kafka-与-rocketmq-依赖-page-cache) 与 [Kafka 高性能原理](/messaging/2_kafka#三、高性能原理)

代价是读路径变复杂（LSM 要查多层文件）和后台 compaction 带来的写放大。

---

## 五、IO 方式

![四种文件 IO 方式的数据路径](../assets/os/io-modes.svg)

| 方式 | 是否经 Page Cache | 阻塞 | Java 对应 | 典型使用者 |
|------|----------------|------|----------|-----------|
| Buffered IO | 是 | 同步 | `FileChannel.read` / `write`、`Files` | 绝大多数应用、Kafka |
| Direct IO | 否 | 同步 | `ExtendedOpenOption.DIRECT`（JDK 10+） | InnoDB、自带缓存的存储引擎 |
| mmap | 是（直接映射） | 缺页时阻塞 | `FileChannel.map()` → `MappedByteBuffer` | RocketMQ CommitLog、索引文件 |
| libaio | 仅 `O_DIRECT` 时真正异步 | 异步 | 无 | MySQL、老一代存储引擎 |
| io_uring | 都支持 | 异步 | JDK 无；Netty 有网络传输实现 | PostgreSQL 18 可选、新一代存储 |

### 1、Buffered IO

默认方式，读有缓存和预读，写拷贝进 Page Cache 就返回，延迟低且对调用方透明；代价是多一次内存拷贝、持久性要靠 `fsync`。Java 的 `FileChannel.read(buf, position)` 对应 `pread`，多线程按位置读同一文件不用加锁。

### 2、Direct IO

绕过 Page Cache，在用户缓冲区和设备之间直接 DMA，避免数据库 Buffer Pool 与 Page Cache 的重复缓存。要求缓冲区地址、长度和文件偏移都按块大小对齐：

```java
// ExtendedOpenOption 位于 com.sun.nio.file 包（jdk.unsupported 模块）
Path path = Path.of("/data/direct.bin");
int block = Math.toIntExact(Files.getFileStore(path.getParent()).getBlockSize());
try (FileChannel ch = FileChannel.open(path, StandardOpenOption.CREATE,
        StandardOpenOption.WRITE, ExtendedOpenOption.DIRECT)) {
    ByteBuffer buf = ByteBuffer.allocateDirect(block * 2).alignedSlice(block); // 地址对齐
    buf.put(new byte[block]).flip();                                           // 长度为块大小整数倍
    ch.write(buf, 0);                                                          // 偏移也对齐
}
```

Direct IO **不等于落盘**：它跳过 Page Cache，但设备自身的写缓存和文件元数据仍可能未持久化，需要持久性时同样要 `fsync`。

### 3、mmap

把文件映射进地址空间，读写映射区就是读写 Page Cache，省掉拷贝和逐次系统调用，适合大文件随机访问。原理、与 `read` / `write` 的对比见 [内存管理与 Page Cache · mmap](./3_memory#六、mmap)。

### 4、异步 IO：libaio 与 io_uring

- **libaio**（Linux 原生 AIO）：只有配合 `O_DIRECT` 才真正异步，Buffered IO 下会退化为同步阻塞，所以只在数据库这类自管缓存的程序里常见
- **io_uring**（Linux 5.1+）：用户态与内核共享提交队列 SQ 和完成队列 CQ 两个环，批量提交、批量收割，可大幅减少系统调用；支持 Buffered IO、Direct IO 与网络
- **Java 现状**：`AsynchronousFileChannel` 在 Linux 上由 JDK 内部线程池模拟，并非内核异步；JDK 没有 io_uring 接口，需要时只能借助 Netty（网络）或 FFM 调第三方库
- **安全面**：io_uring 曾多次出现内核漏洞，部分容器运行时的默认 seccomp 配置会禁用它，上线前确认运行环境是否允许

对 Java 服务而言，文件 IO 的主力仍是 Buffered IO + 虚拟线程或线程池；把文件原样发到网络时用 `transferTo`，拷贝次数对比见 [IO 与 NIO · 零拷贝](/java/18_topic_io#四、零拷贝)。

---

## 六、持久化语义

### 1、写到哪一步算安全

一次 `write` 的数据要依次经过：用户缓冲区 → Page Cache → 设备写缓存 → 持久介质。各个调用把数据推进到哪一步：

| 调用 | 推进到 | 说明 |
|------|-------|------|
| `write` | Page Cache | 进程崩溃不丢，断电或内核崩溃会丢 |
| `fdatasync` | 持久介质 | 只同步数据和必要元数据（如文件大小），Java 为 `force(false)` |
| `fsync` | 持久介质 | 连同时间戳等全部元数据，Java 为 `force(true)` |
| `O_SYNC` / `O_DSYNC` | 持久介质 | 每次 `write` 都隐含一次同步，Java 为 `StandardOpenOption.SYNC` / `DSYNC` |

`fsync` 会让内核向设备发出缓存刷新（FLUSH / FUA）命令，所以设备写缓存也被覆盖；带掉电保护电容的企业级 SSD 能更快完成这一步。脏页回写参数与 `fsync` 成本见 [内存管理与 Page Cache · write、fsync 与脏页回写](./3_memory#五、write、fsync-与脏页回写)。

### 2、原子替换文件

直接覆盖写配置或快照文件，断电后可能得到一个写了一半的文件。标准做法是「写临时文件 + `rename`」，`rename` 在同一文件系统内是原子的，读者要么看到旧文件，要么看到新文件：

```java
static void atomicWrite(Path target, byte[] data) throws IOException {
    Path dir = target.getParent();
    Path tmp = dir.resolve(target.getFileName() + ".tmp");
    try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE,
            StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
        ByteBuffer buf = ByteBuffer.wrap(data);
        while (buf.hasRemaining()) ch.write(buf);
        ch.force(true);                                    // 1. 临时文件内容落盘
    }
    Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE); // 2. rename 原子替换
    try (FileChannel d = FileChannel.open(dir, StandardOpenOption.READ)) {
        d.force(true);                                     // 3. 目录落盘，rename 才持久（Linux 可行）
    }
}
```

三步缺一不可：少第 1 步，`rename` 可能先于数据持久化，断电后得到空文件；少第 3 步，`rename` 本身可能丢失，重启后还是旧文件。

### 3、掉电会丢什么

| 场景 | 结果 |
|------|------|
| 只 `write`，未 `fsync` | 最近约 30 秒内的写入可能整体丢失 |
| 覆盖写到一半断电 | 文件内容新旧混杂，ext4 `data=ordered` 也不能避免 |
| 新建文件只 `fsync` 文件 | 文件内容在，但目录项可能没了，文件「消失」 |
| 消费级 SSD 无掉电保护且关闭了 FLUSH | `fsync` 返回成功也可能丢，生产环境避免 |

::: tip fsync 失败后不要重试
`fsync` 返回错误时，内核可能已经把出错的脏页标记为干净，再次 `fsync` 会返回成功但数据并未写入。PostgreSQL 因此改为 `fsync` 失败直接崩溃、从 WAL 恢复。应用层遇到 `force` 抛 `IOException` 时，应视为数据可能丢失，而不是简单重试。
:::

---

## 七、观测与排查

### 1、iostat -x 的关键列

```bash
iostat -xz 1      # -x 扩展指标，-z 不显示空闲设备，1 秒刷新；第一屏是开机以来的平均值，看后续几屏
```

| 列 | 含义 | 怎么读 |
|----|------|-------|
| `r/s`、`w/s` | 每秒读、写完成次数（IOPS） | 与盘的 IOPS 上限对比 |
| `rkB/s`、`wkB/s` | 每秒读、写字节数 | 与吞吐上限对比 |
| `r_await`、`w_await` | 读、写请求平均耗时（ms），**含排队时间** | 应用感受到的延迟，最关键 |
| `aqu-sz` | 平均队列长度（在途请求数） | 持续大于设备并行能力即排队 |
| `rareq-sz`、`wareq-sz` | 平均单次请求大小（KB） | 区分小块随机与大块顺序 |
| `%util` | 统计周期内设备「有请求在途」的时间占比 | **只对 HDD 这类串行设备可靠** |

`%util` 是最常被误读的列：它只说明设备忙的时间比例，不说明并行能力用了多少。NVMe 和云盘能同时处理很多请求，`%util` 100% 时可能还有大量余量。判断饱和应看 **`await` 是否明显升高**，并对照 IOPS、吞吐是否触到规格上限。旧版的 `svctm` 列已经废弃，不要再用。

### 2、找到是哪个进程

```bash
pidstat -d 1            # 每进程的 kB_rd/s、kB_wr/s，iodelay 是等待块 IO 的时钟节拍数
pidstat -d -t -p <pid> 1  # 细到线程，配合 jstack 的 nid 找到 Java 线程
iotop -oP               # 只显示有 IO 的进程
```

`iotop` 的 `IO%` 依赖内核的延迟统计，Linux 5.14 起默认关闭，需要 `sysctl kernel.task_delayacct=1` 开启。注意 Buffered 写的 IO 多数由内核 flusher 线程在后台完成，`pidstat` 中的写入量按发起进程统计，与 `iostat` 的设备写入时间上不同步。

### 3、看延迟分布

平均值会掩盖长尾，需要分布时：

- `biolatency`（bcc / bpftrace 工具集）：按毫秒或微秒打印块 IO 延迟直方图，`-D` 按设备区分，开销很小，适合生产
- `biosnoop`：逐条打印每次块 IO 的进程、扇区、大小、耗时，定位偶发的慢 IO
- `blktrace` + `blkparse` / `btt`：记录请求在块层每个阶段（排队、合并、派发、完成）的时间点，用于分析是在调度器里排队还是设备本身慢

### 4、排查顺序

1. `iostat -xz 1`：哪块盘、`await` 是否升高、是否顶到 IOPS 或吞吐上限
2. `pidstat -d 1`：哪个进程在读写，读写量是否合理
3. Java 进程内：`jstack` 看线程是否卡在 `FileOutputStream.write`、`FileChannel.force` 等调用上
4. 延迟抖动而负载不高：用 `biolatency` 看分布，确认是否是云盘限速或设备本身

实际案例：日志写满云盘 IOPS 拖慢接口见 [日志打印拖慢接口](/handbook/2_incidents/23_log_bottleneck)，磁盘写满与 `rm` 不释放空间见 [磁盘写满](/handbook/2_incidents/20_disk_full)，IO 导致 Load 高见 [Load 高但 CPU 不高](/handbook/2_incidents/18_load_high_cpu_low)；命令清单见 [Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)。

---

## 八、容器与云盘

### 1、cgroup v2 的 IO 限制

cgroup v2 的 io 控制器按设备号（`major:minor`，`lsblk` 可查）限制容器的 IO：

```bash
# 对 8:16 号设备限制写 50 MB/s、读写各 2000 IOPS
echo "8:16 wbps=52428800 riops=2000 wiops=2000" > /sys/fs/cgroup/<group>/io.max
cat /sys/fs/cgroup/<group>/io.stat      # 该 cgroup 在各设备上的累计读写量与次数
cat /sys/fs/cgroup/<group>/io.pressure  # IO 压力（PSI），some / full 表示因 IO 等待损失的时间比例
```

- `io.max` 是硬上限，超出的请求被节流排队，表现为 `await` 升高、线程卡在 D 状态
- `io.weight` 按权重分配，需要 `bfq` 调度器或启用 `io.cost` 模型才生效
- cgroup v2 能把 Buffered 写的回写 IO 归属到发起写入的 cgroup，v1 对 Buffered 写基本限不住，这是 v2 的重要改进
- Docker 对应 `--device-write-bps`、`--device-read-iops` 等参数；Kubernetes 没有原生的 IO 限额字段，多靠节点级规划与独立数据盘隔离

### 2、云盘的配额与突发

云盘本质是通过网络访问的分布式存储，性能由**规格配额**决定，而不是物理盘本身：

- **IOPS 与吞吐双上限**：以 AWS gp3 为例，基线 3000 IOPS、125 MB/s，可单独付费调高；任何一项触顶都会被限速
- **突发额度**：部分规格（如 AWS gp2、小容量盘）平时积累额度、高峰时突发，额度耗尽后掉回基线，表现为「平时好好的，高峰持续几十分钟后突然变慢」
- **实例侧上限**：虚拟机本身也有云盘总带宽和总 IOPS 上限，挂多块盘不能超过它
- **延迟更高**：一次 IO 要过网络，延迟通常在亚毫秒到毫秒级，比本地 NVMe 高一个数量级，`fsync` 密集的场景尤其明显

触顶的典型信号是 `await` 升高、`w/s` 稳定在一个整数附近（正好是配额）。云厂商控制台的「IOPS 使用率」「突发余额」监控应纳入告警。

### 3、本地盘与云盘

| 维度 | 本地 NVMe（实例存储） | 云盘 |
|------|------------------|------|
| 延迟与 IOPS | 最好 | 受配额与网络限制 |
| 持久性 | 实例停止或迁移后**数据丢失** | 多副本，独立于实例存在 |
| 扩容与快照 | 不支持 | 在线扩容、快照 |
| 适合 | 自带副本的系统：Kafka、Elasticsearch、Cassandra、缓存 | 数据库主库、单副本服务、系统盘 |

选型原则：数据的可靠性如果已经由应用层多副本保证，本地盘能用更低成本换来更高性能；否则用云盘，靠规格配额买性能。

---

## 小结

- VFS 用 inode（元数据与数据块）、dentry（文件名）、file（偏移与标志）三层对象统一各类文件系统，fd 是进程 fd 表的下标；硬链接共享 inode，软链接存路径
- ext4 与 xfs 跟随发行版默认即可，数据盘用 `noatime`；文件系统日志只保证结构一致，不保证应用数据不丢
- 块层只剩 blk-mq，NVMe 用 `none`，HDD / SATA 用 `mq-deadline`；NVMe 要高队列深度才能跑出标称 IOPS
- IOPS、吞吐、延迟由并发联系起来；HDD 顺序与随机差距最大，SSD 也有写放大，所以 Kafka、LSM 把随机写变成顺序追加
- Buffered IO 是默认选择，Direct IO 给自管缓存的引擎，mmap 适合大文件随机访问，io_uring 是 Linux 新一代异步接口，Java 暂无官方支持
- 持久化要 `fsync`；原子替换文件用「写临时文件 + `fsync` + `rename` + 目录 `fsync`」；`fsync` 失败不能简单重试
- `iostat` 看 `await` 而不是 `%util`；容器用 cgroup v2 `io.max` 限速，云盘要关注 IOPS / 吞吐配额与突发额度

## 参考资料

- Linux 内核文档：[Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html)
- Linux 内核文档：[Multi-Queue Block IO Queueing Mechanism (blk-mq)](https://docs.kernel.org/block/blk-mq.html)
- Linux 内核文档：[ext4 General Information](https://docs.kernel.org/admin-guide/ext4.html)
- Linux 内核文档：[Control Group v2 · IO](https://docs.kernel.org/admin-guide/cgroup-v2.html#io)
- open(2)：[https://man7.org/linux/man-pages/man2/open.2.html](https://man7.org/linux/man-pages/man2/open.2.html)
- fsync(2)：[https://man7.org/linux/man-pages/man2/fsync.2.html](https://man7.org/linux/man-pages/man2/fsync.2.html)
- rename(2)：[https://man7.org/linux/man-pages/man2/rename.2.html](https://man7.org/linux/man-pages/man2/rename.2.html)
- io_uring(7)：[https://man7.org/linux/man-pages/man7/io_uring.7.html](https://man7.org/linux/man-pages/man7/io_uring.7.html)
- iostat(1)：[https://man7.org/linux/man-pages/man1/iostat.1.html](https://man7.org/linux/man-pages/man1/iostat.1.html)
- PostgreSQL Wiki：[Fsync Errors](https://wiki.postgresql.org/wiki/Fsync_Errors)
- BCC 工具集：[biolatency](https://github.com/iovisor/bcc/blob/master/tools/biolatency.py)
- JDK 21 API：[ExtendedOpenOption](https://docs.oracle.com/en/java/javase/21/docs/api/jdk.unsupported/com/sun/nio/file/ExtendedOpenOption.html)
- AWS 文档：[Amazon EBS volume types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)

---
description: 管道 / 信号 / 共享内存 / Socket、进程状态、僵尸与孤儿进程、容器 PID 1、删文件空间不释放
---

# 进程间通信与进程状态

> 前置阅读：[进程、线程与协程](./1_process_thread)、[Linux 概览](/cloud-native/1_linux)

进程之间地址空间相互隔离，交换数据必须经过内核提供的通道。本篇讲进程间通信方式、进程状态与僵尸 / 孤儿进程、容器 PID 1，以及删文件不释放空间的原理，基线为 Linux 6.x、JDK 21。

---

## 一、进程间通信

### 1、方式一览

| 方式 | 数据走向 | 适用范围 | 特点 | Java 里的对应 |
|------|---------|---------|------|--------------|
| 匿名管道 | 单向字节流 | 有亲缘关系的进程 | 内核缓冲区默认 64 KB，写满阻塞 | `Process` 的 stdin / stdout / stderr |
| 命名管道（FIFO） | 单向字节流 | 同一主机任意进程 | 在文件系统里有个名字，打开方式像文件 | 当普通文件读写 |
| 信号 | 只传一个编号 | 同一主机 | 异步通知，不携带数据 | `Runtime.addShutdownHook` 间接响应 |
| 消息队列 | 按消息收发 | 同一主机 | POSIX `mq_*`，有边界、可设优先级 | 无标准 API |
| 共享内存 | 双向，直接读写同一块内存 | 同一主机 | 最快，零拷贝，但同步要自己做 | `FileChannel.map` 得到的 `MappedByteBuffer` |
| 信号量 | 不传数据 | 同一主机 | 用来给共享内存加锁、计数 | 无标准 API |
| Unix 域套接字 | 双向流或数据报 | 同一主机 | 不走 TCP/IP 协议栈，可传递文件描述符 | JDK 16 起 `UnixDomainSocketAddress` |
| TCP / UDP 套接字 | 双向 | 跨主机 | 最通用，本机回环也要走完整协议栈 | `Socket`、NIO、Netty |

后端开发最常打交道的是**管道**（启动子进程）、**信号**（停机）、**套接字**（一切网络调用）和**共享内存**（高性能本地队列）。

### 2、管道

`ls | grep java` 中的 `|` 就是匿名管道：内核里的一块环形缓冲区，一端写一端读。写端写满时阻塞，读端读空时阻塞；所有写端关闭后，读端读到 EOF。

Java 里用 `ProcessBuilder` 启动子进程时，子进程的标准输入输出就是三条管道。一个常见的坑是**只等子进程结束、不读它的输出**：子进程输出超过管道缓冲区后写阻塞，父进程在 `waitFor()` 上等，双方互相等待。

```java
Process p = new ProcessBuilder("sh", "-c", "some-command")
        .redirectErrorStream(true)                       // 合并 stderr，只需读一条管道
        .redirectOutput(ProcessBuilder.Redirect.DISCARD) // 不关心输出时直接丢弃（JDK 9+）
        .start();
boolean finished = p.waitFor(30, TimeUnit.SECONDS);      // 必须设超时
```

需要输出时，在 `waitFor` 之前用单独的线程或 `p.getInputStream().transferTo(...)` 读完。

### 3、信号

信号是内核发给进程的异步通知，只有一个编号，进程可以选择默认动作、忽略或注册处理函数，`SIGKILL` 和 `SIGSTOP` 除外，它们不能被捕获或忽略。

JVM 对信号的处理：

- `SIGTERM`、`SIGINT`、`SIGHUP`：触发 JVM 正常退出，依次执行 shutdown hook，Spring Boot 的优雅停机就挂在这里
- `SIGQUIT`：把所有线程栈打印到标准输出，进程继续运行
- `SIGSEGV`、`SIGBUS` 等：JVM 自己会用，比如隐式空指针检查、安全点轮询，`hs_err` 崩溃日志也由它们触发

常用信号、`kill -15` 与 `kill -9` 的区别和退出码见 [Linux 概览](/cloud-native/1_linux#五、进程与信号)。

### 4、共享内存

两个进程把同一块物理内存映射到各自的地址空间，读写不再经过内核，是最快的 IPC。代价是同步要自己做：用信号量、文件锁，或在内存里用 CAS 维护读写指针。

Java 里通过 `FileChannel.map()` 映射同一个文件实现，映射到 `/dev/shm`（tmpfs）下的文件就完全在内存里。Chronicle Queue、Aeron 的 IPC 模式都是这种思路，跨进程延迟可以做到微秒级。`mmap` 的原理与 Page Cache 的关系见 [内存管理与 Page Cache](./3_memory)。

### 5、Unix 域套接字

API 和 TCP 套接字几乎一样，但地址是文件系统里的一个路径，数据在内核里直接从一端的缓冲区复制到另一端，不经过 TCP/IP 协议栈：没有校验和、没有拥塞控制、没有端口占用。同机通信时延迟和 CPU 开销都低于 `127.0.0.1`。

常见用法：Docker 守护进程的 `/var/run/docker.sock`、MySQL 与 PostgreSQL 的本地连接、Sidecar 与业务容器之间通信。它还能通过 `SCM_RIGHTS` 把打开的文件描述符传给另一个进程，以及获取对端进程的 UID / PID 做鉴权。

```java
// JDK 16+（JEP 380）：服务端
var address = UnixDomainSocketAddress.of("/tmp/app.sock");
try (var server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
    server.bind(address);
    try (SocketChannel ch = server.accept()) {
        ByteBuffer buf = ByteBuffer.allocate(1024);
        ch.read(buf);
    }
}

// 客户端
try (var ch = SocketChannel.open(UnixDomainSocketAddress.of("/tmp/app.sock"))) {
    ch.write(ByteBuffer.wrap("ping".getBytes(StandardCharsets.UTF_8)));
}
```

套接字文件在进程退出后不会自动删除，再次 `bind` 前要先删掉旧文件。Netty 的 epoll / kqueue 原生传输也支持 Unix 域套接字（`DomainSocketChannel`），原生传输的选择见 [生产实践与调优](/netty/12_production)。

---

## 二、进程状态

### 1、状态与转换

`ps` 的 `STAT` 列、`top` 的 `S` 列显示的是 Linux 任务状态，对进程和线程都适用：

![Linux 进程状态转换](../assets/os/process_states.svg)

| 状态 | 名称 | 说明 |
|------|------|------|
| R | 运行 / 就绪 | 正在 CPU 上执行，或在运行队列里等待调度 |
| S | 可中断睡眠 | 等待事件（网络数据、锁、定时器），可被信号唤醒；大多数线程大部分时间处于这个状态 |
| D | 不可中断睡眠 | 等待不能中途放弃的操作，通常是块设备 IO；不响应信号，`kill -9` 也要等它返回 |
| T / t | 停止 / 被跟踪停止 | 收到 `SIGSTOP`、`SIGTSTP`（Ctrl+Z），或被调试器暂停；`SIGCONT` 恢复 |
| Z | 僵尸 | 已经退出，只剩进程表项（PID、退出码、资源统计），等父进程回收 |
| I | 空闲内核线程 | 不计入 Load 的内核线程睡眠状态，只出现在内核线程上 |

R 和 D 会计入 Load Average，这就是 [Load 与 CPU 利用率](./5_load_cpu) 中「Load 高而 CPU 低」的来源。`STAT` 后面跟的附加字符：`s` 会话首进程、`l` 多线程、`+` 前台进程组、`<` 高优先级、`N` 低优先级。

### 2、僵尸进程

子进程退出时，内核释放它的内存、文件描述符等资源，但保留一个进程表项，存放退出码，等父进程调用 `wait` / `waitpid` 取走后才彻底删除。在被取走之前，它就是僵尸进程。

- **危害**：僵尸本身不占内存和 CPU，`kill -9` 对它也无效，因为它已经死了。问题在于它占着 PID，数量大时会耗尽 `pid_max` 或容器的 `pids.max`，新进程、新线程都创建不出来，Java 侧报 `unable to create native thread`
- **成因**：父进程不处理 `SIGCHLD`、也不调用 `wait`，比如启动子进程后从不 `waitFor` 的程序，或者写得不严谨的启动脚本
- **处理**：让父进程回收，或者结束父进程。父进程退出后，僵尸会被 init 接管，init 会负责回收

```bash
ps -eo pid,ppid,stat,cmd | awk '$3 ~ /^Z/'   # 找僵尸及其父进程 PPID
ps -o pid,cmd -p <ppid>                       # 看父进程是谁，处理父进程
```

JVM 对自己用 `ProcessBuilder` 启动的直接子进程有专门的回收线程（process reaper），这些子进程不会变成僵尸；但子进程再派生出的孙进程如果成了孤儿，就不归 JVM 管了。

### 3、孤儿进程

父进程先于子进程退出，子进程就成了孤儿。内核把它过继给 PID 1，或者过继给最近的、声明了自己是 subreaper 的祖先进程（`prctl(PR_SET_CHILD_SUBREAPER)`，systemd 和部分容器运行时会这样做）。孤儿进程本身无害，后台守护进程正是靠「父进程退出、让子进程被 init 接管」实现的。

孤儿与僵尸的关系在于：孤儿将来退出时，由新的父进程负责回收。如果这个新父进程不会回收，它们就会堆成僵尸，这正是容器里 PID 1 要面对的问题。

---

## 三、容器里的 PID 1

容器有自己的 PID 命名空间，`ENTRYPOINT` 启动的第一个进程在容器里就是 PID 1，承担 init 的两项职责，而 Java 应用通常并不是为此设计的：

| 职责 | 要求 | 不满足时的后果 |
|------|------|---------------|
| 处理信号 | 内核不会对命名空间内的 PID 1 执行信号的默认动作，没有注册处理函数的信号会被直接忽略 | 进程收不到停机信号，等到宽限期结束被 `SIGKILL` |
| 回收孤儿 | 所有孤儿都会过继给 PID 1，它必须 `wait` 回收 | 僵尸堆积，最终耗尽 `pids.max` |

对 Java 来说：

- **信号**：JVM 自己注册了 `SIGTERM` 处理函数，所以 `java` 直接作为 PID 1 时能正常响应停机。问题出在 shell 形式的 `ENTRYPOINT` 或启动脚本：PID 1 是 `sh`，它既不处理也不转发 `SIGTERM`，JVM 收不到。用 exec 形式 `ENTRYPOINT ["java", ...]`，或在脚本最后一行写 `exec java ...` 让 JVM 替换掉 shell
- **回收**：JVM 不会回收过继给它的孤儿。如果应用会执行外部命令（调用 shell 脚本、FFmpeg、浏览器等），而这些命令又派生了子进程，就可能留下僵尸

需要回收孤儿或必须保留启动脚本时，在前面加一个轻量 init：

```dockerfile
# 方式一：镜像里装 tini，由它做 PID 1，负责转发信号与回收僵尸
ENTRYPOINT ["/sbin/tini", "--", "java", "-jar", "/app/app.jar"]
```

```bash
# 方式二：Docker 运行时注入 init（docker-init，即 tini）
docker run --init my-app
```

Kubernetes 中还可以设置 Pod 的 `shareProcessNamespace: true`，此时 pause 容器成为 PID 1，由它回收僵尸，但所有容器能互相看到进程，有隔离上的代价。`SIGTERM` 送达之后的完整停机顺序（摘流量、`preStop`、宽限期）见 [Kubernetes 优雅终止](/cloud-native/6_kubernetes#_3、优雅终止)。

---

## 四、删除正在写的文件，空间为什么不释放

### 1、原理

Linux 的文件由两部分组成：目录项（文件名指向 inode）和 inode（文件的元数据与数据块）。`rm` 调用的是 `unlink`，只删除目录项、把 inode 的链接数减一。内核真正释放 inode 和磁盘块需要同时满足：

- 链接数为 0，没有任何文件名再指向它
- 没有任何进程还打开着它，打开的文件描述符计数为 0

所以一个正在被 Java 进程写的日志文件被 `rm` 后，文件名没了，但进程手里的 fd 仍然有效，还在继续往里写，空间一点也没释放。表现为 `df` 显示磁盘快满，`du` 却统计不出是谁占的，因为 `du` 按目录树统计，看不到已经没有名字的文件。

### 2、定位与处理

```bash
lsof +L1                          # 列出链接数小于 1（已删除）但仍被打开的文件
lsof -p <pid> | grep deleted      # 只看某个进程
ls -l /proc/<pid>/fd | grep deleted
```

处理方式按影响从小到大：

1. **截断而不是删除**：`: > /proc/<pid>/fd/<fd>` 把文件长度清零，空间立即释放，进程无感知、继续写
2. **让进程重新打开文件**：日志框架支持的话触发一次滚动；Nginx 等守护进程可以发 `SIGUSR1` 让它重新打开日志
3. **重启进程**：fd 关闭后空间随即释放

`/proc/<pid>/fd/<fd>` 还可以用来**找回误删的文件**：只要进程还没退出，`cp /proc/<pid>/fd/<fd> /path/restore.log` 就能把内容复制出来。

### 3、预防

- 日志清理交给日志框架的滚动策略（Logback 的 `maxHistory`、`totalSizeCap`）或 `logrotate`，不要手工 `rm` 正在写的文件
- `logrotate` 对不会重新打开文件的进程使用 `copytruncate`，代价是复制与截断之间可能丢少量日志
- 容器里的日志直接输出到标准输出，由容器运行时负责轮转

---

## 小结

- 进程间通信的选择：父子进程用管道，通知用信号，同机高性能用共享内存或 Unix 域套接字，跨机用 TCP；`ProcessBuilder` 要读完输出并设超时
- 进程状态 R / S / D / Z / T 中，R 和 D 计入 Load；D 状态不响应信号，僵尸只占 PID 不占内存，`kill -9` 对二者都无效
- 僵尸要靠父进程 `wait` 回收或结束父进程；孤儿会被 PID 1 或 subreaper 接管，本身无害
- 容器里的 PID 1 要负责处理信号和回收孤儿：Java 用 exec 形式启动，需要回收子进程时加 tini 或 `--init`
- 文件被 `rm` 后只要还有进程打开着，空间就不会释放；用 `lsof +L1` 定位，截断或重启进程解决

## 参考资料

- pipe(7)：[https://man7.org/linux/man-pages/man7/pipe.7.html](https://man7.org/linux/man-pages/man7/pipe.7.html)
- signal(7)：[https://man7.org/linux/man-pages/man7/signal.7.html](https://man7.org/linux/man-pages/man7/signal.7.html)
- unix(7)：[https://man7.org/linux/man-pages/man7/unix.7.html](https://man7.org/linux/man-pages/man7/unix.7.html)
- wait(2)：[https://man7.org/linux/man-pages/man2/wait.2.html](https://man7.org/linux/man-pages/man2/wait.2.html)
- pid_namespaces(7)：[https://man7.org/linux/man-pages/man7/pid_namespaces.7.html](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
- unlink(2)：[https://man7.org/linux/man-pages/man2/unlink.2.html](https://man7.org/linux/man-pages/man2/unlink.2.html)
- JEP 380 Unix-Domain Socket Channels：[https://openjdk.org/jeps/380](https://openjdk.org/jeps/380)
- Kubernetes 文档 Share Process Namespace between Containers in a Pod：[https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/)
- tini：[https://github.com/krallin/tini](https://github.com/krallin/tini)

> 下一篇：[文件系统与磁盘 IO](./7_file_io) —— Page Cache 之下，文件如何经过 VFS、文件系统和块层落到磁盘，以及怎么判断磁盘是不是瓶颈。

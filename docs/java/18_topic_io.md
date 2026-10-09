---
description: 字节流 / 字符流、Buffer、Selector、零拷贝、Files API、虚拟线程与阻塞 IO
---

# IO 与 NIO

> **本篇目标**：分清 `java.io` 与 `java.nio` 的分工，写出编码正确、不泄漏文件句柄的读写代码；掌握 Buffer 的状态切换、Selector 多路复用和零拷贝 API 的真实边界，并知道虚拟线程（JDK 21）出现后阻塞 IO 该怎么选。
>
> **前置阅读**：[日期与时间](./17_topic_time)

`java.io` 面向**流**：一次读写一个字节或字符，调用阻塞直到完成。`java.nio` 面向**缓冲区与通道**：数据先进 `Buffer`，再由 `Channel` 搬运，`Selector` 让一个线程同时等待多个通道。两套 API 并不互相替代。文件读写的首选是 `java.nio.file.Files`，网络服务通常交给 Netty，而 JDK 21 起虚拟线程又让「一连接一线程」的阻塞写法重新可用。

---

## 一、IO 体系结构

- **字节流**：`InputStream` / `OutputStream`，处理任意二进制数据
- **字符流**：`Reader` / `Writer`，底层仍是字节流，再按 `Charset` 编解码

两套体系都用**装饰器模式**组合功能：`FileInputStream` 负责数据来源，`BufferedInputStream`、`DataInputStream` 等一层层包在外面叠加能力（模式本身见 [装饰器模式](/patterns/9_structural_decorator)）。

### 1、字节流核心类

| 类 | 说明 |
|----|------|
| `FileInputStream / FileOutputStream` | 文件读写 |
| `BufferedInputStream / BufferedOutputStream` | 默认 8 KB 缓冲，减少系统调用 |
| `DataInputStream / DataOutputStream` | 按大端序读写基本类型 |
| `ObjectInputStream / ObjectOutputStream` | Java 原生序列化，见 [序列化](./19_topic_serialization) |
| `ByteArrayInputStream / ByteArrayOutputStream` | 内存字节数组，常用于拼装报文 |

JDK 9 起 `InputStream` 自带 `readAllBytes()`、`readNBytes(n)`、`transferTo(out)`，不必再手写 `while (read != -1)` 循环。

### 2、字符流核心类

| 类 | 说明 |
|----|------|
| `InputStreamReader / OutputStreamWriter` | 字节流与字符流的桥接，可指定编码 |
| `BufferedReader / BufferedWriter` | 带缓冲，`readLine()` 逐行读取 |
| `FileReader / FileWriter` | JDK 11 起有 `(File, Charset)` 构造器；不传编码时使用默认字符集 |
| `StringReader / StringWriter` | 字符串作为数据源或目标 |

**默认字符集**：JDK 18（JEP 400）起，`Charset.defaultCharset()` 在所有平台上都是 UTF-8。JDK 17 及以前取操作系统区域设置，中文 Windows 上是 GBK，同一份代码换台机器就乱码。仍运行在 JDK 17 及以下时，必须显式传 `StandardCharsets.UTF_8`；即使在 JDK 21 上，显式写出编码也能让代码意图更清楚。

### 3、推荐的文件读写写法

```java
Path path = Path.of("data/orders.csv");

// 逐行读：Files.newBufferedReader 不传编码时固定用 UTF-8（JDK 8 起即如此）
try (BufferedReader reader = Files.newBufferedReader(path)) {
    String line;
    while ((line = reader.readLine()) != null) {
        handle(line);
    }
}

// 流式处理：Files.lines 持有文件句柄，必须放进 try-with-resources
try (Stream<String> lines = Files.lines(path)) {
    long count = lines.filter(l -> l.startsWith("PAID")).count();
}

// 流复制（JDK 9+）
try (InputStream in = Files.newInputStream(path);
     OutputStream out = Files.newOutputStream(Path.of("backup.csv"))) {
    in.transferTo(out);
}
```

`Files.readString` / `readAllLines` / `readAllBytes` 会把整个文件读进内存，只适合小文件；大文件用 `newBufferedReader` 或 `lines` 逐行处理。

---

## 二、BIO / NIO / AIO 对比

| 模型 | Java API | 线程模型 | 现状 |
|------|----------|----------|------|
| BIO | `ServerSocket` / `Socket`、`InputStream` | 一连接一线程，读写阻塞 | 平台线程下撑不住大量连接；配合虚拟线程重新可用 |
| NIO | `ServerSocketChannel` / `SocketChannel` + `Selector` | 少量线程轮询就绪事件 | 高并发网络框架的基础（Netty） |
| AIO（NIO.2） | `AsynchronousSocketChannel` | 发起操作后由回调或 `Future` 拿结果 | 很少使用 |

AIO 只有在 Windows 上是真正的内核异步（IOCP）。Linux 上的 `AsynchronousSocketChannel` 由 JDK 用 epoll 加内部线程池模拟，既不是内核 AIO 也不是 io_uring，性能没有优势，所以 Netty 早已移除 AIO 传输，生产上基本只用 NIO。五种 IO 模型的原理与对比见 [IO 模型](/netty/1_io_model)。

### 1、虚拟线程下的阻塞 IO（JDK 21）

虚拟线程（JEP 444，JDK 21 正式）改变了 BIO 的成本结构：

- **Socket IO**：虚拟线程在 `Socket` / `SocketChannel` 上阻塞时，JDK 把底层 fd 注册到内部 poller（Linux 上是 epoll），然后让虚拟线程**卸载**，载体线程去执行别的虚拟线程，就绪后再挂载回来。写法是同步阻塞的，扩展性接近 NIO
- **文件 IO**：操作系统没有通用的异步文件接口，文件读写会占住载体线程。JDK 的做法是临时扩大调度器并行度来补偿，大量并发文件 IO 时载体线程数会上涨
- **固定（pinning）**：JDK 24（JEP 491）起，在 `synchronized` 中阻塞不再固定载体线程；本地方法帧和类初始化期间仍会固定。排查用 JFR 事件 `jdk.VirtualThreadPinned`（`-Djdk.tracePinnedThreads` 已在 JDK 24 移除）

结论：普通的「请求 → 调下游 HTTP / JDBC → 返回」业务，用虚拟线程加阻塞 API 最简单；需要自定义二进制协议、数万长连接、精细背压或零拷贝时，仍用 NIO / Netty。虚拟线程的 API 与限制见 [版本演进](./2_version)。

---

## 三、NIO 核心组件

### 1、Channel（通道）

Channel 代表到文件或 Socket 的连接，数据经 Buffer 读写。大多数 Channel 可读可写，但要看打开方式：从 `FileInputStream.getChannel()` 拿到的 `FileChannel` 只读，写入抛 `NonWritableChannelException`。推荐直接用 `FileChannel.open(path, options...)` 按需声明读写。

| Channel 类型 | 说明 |
|--------------|------|
| `FileChannel` | 文件读写、内存映射（`map`）、零拷贝（`transferTo` / `transferFrom`）、文件锁 |
| `SocketChannel / ServerSocketChannel` | TCP 客户端 / 服务端，可设为非阻塞并注册到 Selector |
| `DatagramChannel` | UDP |
| `AsynchronousFileChannel / AsynchronousSocketChannel` | AIO，回调或 `Future` 风格 |

### 2、Buffer（缓冲区）

Buffer 是一段固定容量的内存加上 4 个指针，始终满足 `0 ≤ mark ≤ position ≤ limit ≤ capacity`：

- `capacity`：容量，创建后不变
- `limit`：写模式下等于 capacity，读模式下等于已写入的数据量
- `position`：下一个读写位置
- `mark`：`mark()` 记下的位置，`reset()` 回到这里

![Buffer 指针在 put、flip、get、compact 之间的变化](../assets/java/nio_buffer_state.svg)

| 方法 | 作用 | 注意 |
|------|------|------|
| `flip()` | `limit = position; position = 0`，写模式切到读模式 | 忘记 flip 会读到空数据 |
| `clear()` | `position = 0; limit = capacity` | **只重置指针，不擦除数据**；未读完的数据会被覆盖 |
| `compact()` | 把未读数据移到开头，`position` 指向其后，`limit = capacity` | 半包场景用它而不是 `clear()` |
| `rewind()` | `position = 0`，limit 不变 | 重读一遍 |
| `mark()` / `reset()` | 记录 / 回到某个位置 | 解析协议时回退用 |

```java
ByteBuffer buf = ByteBuffer.allocate(1024);
int n = channel.read(buf);    // 写入 Buffer
buf.flip();                   // 切读模式
while (buf.remaining() >= 4) {
    int len = buf.getInt();   // 解析完整消息……
}
buf.compact();                // 保留半包，继续写入
```

### 3、直接缓冲区 vs 堆缓冲区

| | `ByteBuffer.allocate(n)` | `ByteBuffer.allocateDirect(n)` |
|--|--------------------------|--------------------------------|
| 内存位置 | Java 堆 | 堆外（本地内存） |
| 分配 / 释放成本 | 低 | 高，适合长期复用或池化 |
| IO 时的拷贝 | 多一次：先拷到临时直接缓冲区 | 直接交给系统调用 |
| 回收 | GC | Buffer 对象被 GC 后由 `Cleaner` 释放 |
| 上限 | `-Xmx` | `-XX:MaxDirectMemorySize` |

**为什么堆缓冲区多一次拷贝**：GC 可能移动堆上的数组，而系统调用需要地址稳定的内存，所以 JDK 先把数据拷到一块临时直接缓冲区再做 IO。这些临时缓冲区按线程缓存，大 Buffer 加上大量线程会让堆外内存悄悄膨胀，可用 `-Djdk.nio.maxCachedBufferSize` 限制单个缓存的大小。

直接缓冲区不是「越多越快」：分配一次的成本远高于堆分配，释放又依赖 GC 触发 `Cleaner`，频繁创建小的直接缓冲区反而更慢，还容易 `OutOfMemoryError: Direct buffer memory`。正确用法是少量、大块、复用（Netty 用池化的 `PooledByteBufAllocator`，见 [ByteBuf](/netty/6_bytebuf)）。直接内存的 JVM 视角见 [JVM 内存结构 · 直接内存](/jvm/1_memory#_6、直接内存)。

### 4、Selector（选择器）

一个 Selector 同时监听多个非阻塞 Channel，`select()` 返回后只处理就绪的那些：

```java
Selector selector = Selector.open();
ServerSocketChannel server = ServerSocketChannel.open();
server.bind(new InetSocketAddress(8080));
server.configureBlocking(false);
server.register(selector, SelectionKey.OP_ACCEPT);

while (true) {
    selector.select();                                   // 阻塞直到有就绪事件
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();                                     // 必须手动移除，否则下轮重复处理
        if (key.isAcceptable()) {
            SocketChannel client = server.accept();
            client.configureBlocking(false);
            client.register(selector, SelectionKey.OP_READ, ByteBuffer.allocate(4096));
        } else if (key.isReadable()) {
            SocketChannel client = (SocketChannel) key.channel();
            ByteBuffer buf = (ByteBuffer) key.attachment();
            if (client.read(buf) == -1) {                // 对端关闭
                key.cancel();
                client.close();
            }
        }
    }
}
```

- 四种事件：`OP_ACCEPT`、`OP_CONNECT`、`OP_READ`、`OP_WRITE`。`OP_WRITE` 只在发送缓冲区写满时临时注册，写完就取消，否则 Socket 几乎一直可写，循环会空转
- **底层实现**：Linux 用 epoll，macOS 用 kqueue；Windows 在 JDK 17 起默认基于 wepoll（JDK-8266369），之前是 select。IOCP 只用于 AIO 的 `Asynchronous*Channel`
- epoll 不需要每次把全部 fd 拷进内核再线性扫描，`epoll_wait` 的开销与**就绪** fd 数成正比，而不是与注册的总 fd 数成正比，详见 [select / poll / epoll 对比](/netty/1_io_model#二、select-poll-epoll-对比)

手写 Selector 循环还要处理半包粘包、写缓冲、空轮询等细节，生产上直接用 Netty。

---

## 四、零拷贝

把磁盘文件发到网络，传统写法是 `read()` 到用户缓冲区再 `write()` 到 Socket。零拷贝的目标是减少 CPU 拷贝和用户态 / 内核态切换：

![传统 read + write、mmap + write、sendfile 三种路径的拷贝次数与上下文切换对比](../assets/java/io_zero_copy.svg)

| 方案 | DMA 拷贝 | CPU 拷贝 | 上下文切换 | Java API |
|------|----------|----------|------------|----------|
| `read` + `write` | 2 | 2 | 4 | `InputStream` + `OutputStream` |
| `mmap` + `write` | 2 | 1 | 4 | `FileChannel.map()` |
| `sendfile` | 2 | 1 | 2 | `FileChannel.transferTo()` |
| `sendfile` + SG-DMA | 2 | 0 | 2 | 同上，网卡支持分散 / 聚集 DMA 时（Linux 2.4+） |

所谓「零拷贝」指 CPU 拷贝为零，只在 sendfile 且网卡支持 SG-DMA 时成立；否则内核里仍有一次页缓存到 Socket 缓冲区的 CPU 拷贝。

### 1、transferTo（sendfile）

```java
try (FileChannel file = FileChannel.open(path, StandardOpenOption.READ)) {
    long pos = 0, size = file.size();
    while (pos < size) {                                  // 单次调用可能少于请求长度，必须循环
        pos += file.transferTo(pos, size - pos, socketChannel);
    }
}
```

- 在 Linux 上，目标是 `SocketChannel` 时走 `sendfile`；单次调用最多传输约 2 GB，大文件必须循环
- 数据不经过用户态，应用无法修改内容。**开启 TLS 后必须在用户态加密，sendfile 失效**，Kafka、Netty 的 HTTPS 文件下载都受此影响，见 [Kafka](/messaging/2_kafka) 与 [IO 与网络优化](/high-perf/9_io_network)
- Netty 的 `DefaultFileRegion` 底层就是 `transferTo`，见 [ByteBuf](/netty/6_bytebuf)

### 2、map（mmap）

`FileChannel.map()` 返回 `MappedByteBuffer`，读写它就是读写页缓存，适合随机读写大文件（RocketMQ 的 CommitLog 就是 mmap）。限制有两条：

- 单个映射最大 `Integer.MAX_VALUE` 字节（约 2 GB），更大的文件要分段映射
- 没有公开的 unmap 方法，映射要等 Buffer 被 GC 才释放，期间文件在 Windows 上无法删除

JDK 22 正式发布的 FFM API（JEP 454）提供了替代：`FileChannel.map(mode, offset, size, arena)` 返回 `MemorySegment`，不受 2 GB 限制，`Arena` 关闭时立即解除映射。

```java
try (Arena arena = Arena.ofConfined();
     FileChannel ch = FileChannel.open(path, StandardOpenOption.READ)) {
    MemorySegment seg = ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size(), arena);
    byte first = seg.get(ValueLayout.JAVA_BYTE, 0);
}   // arena 关闭即 unmap
```

---

## 五、Files / Path API

`java.nio.file`（JDK 7 引入）取代 `java.io.File`：异常信息明确（`File.delete()` 只返回 false），支持符号链接、文件属性和原子移动。注意各方法的引入版本：

| API | 版本 |
|-----|------|
| `Paths.get`、`Files.copy / move / delete / readAllLines / newBufferedReader` | JDK 7 |
| `Files.lines / list / walk / find` | JDK 8 |
| `Path.of`、`Files.readString / writeString` | JDK 11 |
| `Files.mismatch`（比较两个文件，返回首个不同字节的位置或 -1） | JDK 12 |

```java
Path src = Path.of("data/in.txt");
Path dst = Path.of("data/out.txt");

String content = Files.readString(src);                   // 默认 UTF-8
Files.writeString(dst, content);                          // 默认 CREATE + TRUNCATE_EXISTING + WRITE

Files.createDirectories(Path.of("a/b/c"));
Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING);
// 目标已存在时，不带 REPLACE_EXISTING 会抛 FileAlreadyExistsException
Files.move(src, dst, StandardCopyOption.REPLACE_EXISTING);
Files.deleteIfExists(dst);

// 原子替换：先写临时文件，再 ATOMIC_MOVE（同一文件系统内；此时其他选项被忽略，
// 目标已存在时 Linux 上 rename 直接覆盖，是否覆盖由平台决定）
Path tmp = Files.createTempFile(dst.getParent(), "out", ".tmp");
Files.writeString(tmp, content);
Files.move(tmp, dst, StandardCopyOption.ATOMIC_MOVE);

// list / walk 返回的 Stream 持有目录句柄，必须关闭
try (Stream<Path> walk = Files.walk(Path.of("src"))) {
    walk.filter(p -> p.toString().endsWith(".java")).forEach(System.out::println);
}
```

写配置、导出文件时用上面「临时文件 + `ATOMIC_MOVE`」的写法，读方要么看到旧文件，要么看到完整的新文件，不会读到写了一半的内容。

---

## 小结

- 字符流 = 字节流 + 编解码；JDK 18 起默认字符集是 UTF-8，JDK 17 及以下必须显式指定编码
- 文件读写首选 `Files`：小文件 `readString`，大文件 `newBufferedReader` / `lines`，返回 Stream 的方法都要 try-with-resources
- Buffer 的核心是 `position / limit / capacity`：写完 `flip()` 再读，半包用 `compact()`，`clear()` 不擦数据
- 直接缓冲区省一次拷贝，但分配贵、释放靠 GC，只适合大块复用
- Selector 在 Linux 上是 epoll，Windows 上 JDK 17 起是 wepoll；AIO 在 Linux 上只是模拟，很少使用
- `transferTo` 对应 sendfile，要循环调用，TLS 下失效；`map` 对应 mmap，受 2 GB 和无法主动 unmap 限制，JDK 22 起可用 FFM 的 `MemorySegment` 替代
- JDK 21 虚拟线程让 Socket 阻塞 IO 不再占用平台线程，普通业务可回到同步写法；文件 IO 仍会占用载体线程

## 参考资料

- java.nio 包文档（JDK 25）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/package-summary.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/package-summary.html)
- JEP 400 默认字符集 UTF-8：[https://openjdk.org/jeps/400](https://openjdk.org/jeps/400)
- JEP 444 虚拟线程：[https://openjdk.org/jeps/444](https://openjdk.org/jeps/444)
- JEP 454 外部函数与内存 API：[https://openjdk.org/jeps/454](https://openjdk.org/jeps/454)

> 下一篇：[序列化](./19_topic_serialization) —— 对象如何变成字节：Java 原生序列化的兼容规则与安全风险，以及 JSON / Protobuf 等替代方案。

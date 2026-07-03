# Java 专项-IO / NIO

## 一、IO 体系结构

Java IO 分为**字节流**和**字符流**两套体系：

```
字节流：InputStream / OutputStream
字符流：Reader / Writer（底层仍是字节流 + 编码转换）
```

### 字节流核心类

| 类 | 说明 |
|----|------|
| `FileInputStream / FileOutputStream` | 文件读写 |
| `BufferedInputStream / BufferedOutputStream` | 带缓冲，减少系统调用，推荐包装使用 |
| `DataInputStream / DataOutputStream` | 读写基本数据类型 |
| `ObjectInputStream / ObjectOutputStream` | 对象序列化 / 反序列化 |
| `ByteArrayInputStream / ByteArrayOutputStream` | 内存字节数组操作 |

### 字符流核心类

| 类 | 说明 |
|----|------|
| `FileReader / FileWriter` | 文件字符读写（默认平台编码，不推荐） |
| `InputStreamReader / OutputStreamWriter` | 字节流转字符流的桥接类，**可指定编码** |
| `BufferedReader / BufferedWriter` | 带缓冲，`readLine()` 逐行读取 |
| `StringReader / StringWriter` | 字符串操作 |

### 正确读取文件的写法

```java
// 指定 UTF-8，避免平台编码问题
try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(new FileInputStream("file.txt"), StandardCharsets.UTF_8))) {
    String line;
    while ((line = reader.readLine()) != null) {
        System.out.println(line);
    }
}
```

---

## 二、BIO / NIO / AIO 对比

| 模型 | 线程模型 | 适用场景 |
|------|----------|----------|
| **BIO**（阻塞 IO） | 一连接一线程，阻塞等待 | 连接数少、开发简单 |
| **NIO**（非阻塞 IO） | Selector 多路复用，少量线程处理大量连接 | 高并发长连接（IM、网关） |
| **AIO**（异步 IO） | 内核完成后回调，完全异步 | Windows IOCP 成熟；Linux 实际多用 epoll 模拟 |

---

## 三、NIO 核心组件

### 1、Channel（通道）

与流的区别：Channel **双向读写**；流单向。

| Channel 类型 | 说明 |
|--------------|------|
| `FileChannel` | 文件读写，支持内存映射（mmap）和零拷贝 |
| `SocketChannel / ServerSocketChannel` | TCP 客户端 / 服务端 |
| `DatagramChannel` | UDP |

### 2、Buffer（缓冲区）

本质是一个可读写的内存数组，有三个核心指针：

```
capacity：总容量（不变）
limit：可读 / 写的边界
position：当前读写位置

写模式：position 随写入移动，limit = capacity
读模式：调用 flip() 后，limit = 写入量，position = 0
```

```java
ByteBuffer buf = ByteBuffer.allocate(1024);
buf.put("hello".getBytes());   // 写入
buf.flip();                    // 切换读模式
byte[] data = new byte[buf.remaining()];
buf.get(data);                 // 读取
buf.clear();                   // 重置，准备下次写
```

**直接缓冲区 vs 堆缓冲区**：
- `ByteBuffer.allocate(n)` → 堆内存，GC 管理
- `ByteBuffer.allocateDirect(n)` → 堆外内存，减少一次拷贝，适合频繁 IO 的大块数据

### 3、Selector（选择器）

一个 Selector 可以监听多个 Channel 的 IO 事件，实现单线程处理多连接：

```java
Selector selector = Selector.open();
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ);

while (true) {
    selector.select();  // 阻塞直到有就绪事件
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        if (key.isReadable()) { /* 处理读事件 */ }
        it.remove();
    }
}
```

四种事件类型：`OP_ACCEPT`、`OP_CONNECT`、`OP_READ`、`OP_WRITE`

---

## 四、零拷贝

传统文件传输需要 4 次拷贝（磁盘→内核缓冲区→用户缓冲区→Socket缓冲区→网卡）。

**零拷贝方案：**

| 方案 | 原理 | Java API |
|------|------|----------|
| `mmap` | 内核缓冲区映射到用户空间，省去内核→用户拷贝 | `FileChannel.map()` |
| `sendfile` | 数据不经过用户空间，内核直接传到网卡 | `FileChannel.transferTo()` |

Kafka 消费消息、Netty 文件传输都依赖 `transferTo()` 实现零拷贝。

---

## 五、Files / Path API（Java 7+）

推荐使用 `java.nio.file.Files` 和 `java.nio.file.Path` 替代 `java.io.File`：

```java
Path path = Path.of("data/file.txt");

// 读写
String content = Files.readString(path, StandardCharsets.UTF_8);
Files.writeString(path, "hello", StandardCharsets.UTF_8);

// 目录操作
Files.createDirectories(Path.of("a/b/c"));
Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING);
Files.move(src, dst);
Files.delete(path);

// 遍历目录（非递归）
try (Stream<Path> stream = Files.list(Path.of("."))) {
    stream.filter(Files::isRegularFile).forEach(System.out::println);
}

// 递归遍历
try (Stream<Path> walk = Files.walk(Path.of("."))) {
    walk.filter(p -> p.toString().endsWith(".java")).forEach(System.out::println);
}
```

---

## 六、常见面试问题

**Q：NIO 的 Selector 底层是什么？**
Linux 下基于 `epoll`，macOS 下基于 `kqueue`，Windows 下基于 `IOCP`。`epoll` 使用事件驱动，时间复杂度 O(1)，优于 `select/poll` 的 O(n)。

**Q：直接缓冲区为什么更快？**
堆内缓冲区在做 IO 操作前，JVM 会先把数据拷贝到一个临时的直接缓冲区再传给 OS；直接缓冲区跳过了这一步，减少了一次内存拷贝。

**Q：`FileChannel.transferTo()` 为什么是零拷贝？**
底层调用 `sendfile` 系统调用，数据从页缓存直接传输到 Socket 缓冲区，不经过用户态，CPU 拷贝次数从 2 次降为 0（DMA 完成）。

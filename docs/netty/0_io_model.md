# IO 模型

![IO 模型对比](../assets/netty/io-models.svg)

IO 模型描述的是**操作系统如何处理网络 IO 请求**。理解它是掌握 Netty、NIO、WebFlux 的地基。常见 5 种：

## 一、五种 IO 模型

### 1、阻塞 IO（Blocking IO / BIO）

- **特点**：每个连接一个线程，线程从等待数据到读取完成全程阻塞
- **缺点**：高并发下线程数爆炸（每线程约 1MB 栈内存 + 上下文切换开销）

```java
ServerSocket serverSocket = new ServerSocket(8080);
Socket socket = serverSocket.accept(); // 阻塞等待连接
InputStream inputStream = socket.getInputStream();
int data = inputStream.read();         // 阻塞等待数据
```

### 2、非阻塞 IO（Non-Blocking IO）

- **特点**：读不到数据立即返回，应用层自己轮询
- **缺点**：空转轮询烧 CPU，几乎不单独使用（它是多路复用的底层前提）

```java
socketChannel.configureBlocking(false);
int bytesRead = socketChannel.read(buffer); // 无数据返回 0，不阻塞
```

### 3、IO 多路复用（Multiplexing，主流方案）

- **特点**：用 `select` / `poll` / `epoll` 让**单个线程同时监视成千上万个连接**，谁就绪处理谁
- 这是 Java NIO、Netty、Redis、Nginx 的共同底座

```java
Selector selector = Selector.open();
socketChannel.register(selector, SelectionKey.OP_READ);
while (true) {
    selector.select();                  // 阻塞直到有事件就绪
    Set<SelectionKey> keys = selector.selectedKeys();
    for (SelectionKey key : keys) {
        if (key.isReadable()) {
            // 处理可读事件
        }
    }
}
```

### 4、信号驱动 IO（Signal-driven IO）

- 内核在数据就绪时发 `SIGIO` 信号通知应用。Java 中不使用，常见于 Linux 底层编程。

### 5、异步 IO（Asynchronous IO / AIO）

- **特点**：应用只管发起请求，**数据从内核拷贝到用户空间也由内核完成**，完成后回调通知——前四种模型这一步都要应用自己等
- Java AIO（NIO.2）在 Linux 上底层仍由 epoll 模拟，性能无优势，实际应用很少

```java
AsynchronousServerSocketChannel server = AsynchronousServerSocketChannel.open();
server.accept(null, new CompletionHandler<>() {
    public void completed(AsynchronousSocketChannel channel, Object attachment) {
        // 处理连接
    }
});
```

## 二、select / poll / epoll 对比

| | select | poll | epoll |
|---|---|---|---|
| fd 数量上限 | 1024（FD_SETSIZE）| 无硬上限 | 无硬上限 |
| fd 集合传递 | 每次调用全量拷贝进内核 | 同 select | 只注册一次（`epoll_ctl`）|
| 就绪检测 | 内核线性扫描 O(n) | O(n) | 回调置就绪链表，**O(1)** 取结果 |
| 就绪结果 | 返回后应用遍历全集 | 同 select | 只返回就绪的 fd |
| 适用 | 连接少、跨平台 | 略优于 select | **大量连接（Linux 主流）**|

> 连接数越大、活跃比例越低，epoll 优势越明显；Java NIO 的 `Selector` 在 Linux 上底层就是 epoll。

## 三、epoll 触发模式

| | LT（水平触发，默认）| ET（边缘触发）|
|---|---|---|
| 触发时机 | 只要 fd 可读就持续通知 | 仅在状态变化时通知一次 |
| 读取要求 | 不必一次读完 | 必须一次读完（循环到 EAGAIN）|
| 漏事件风险 | 低 | 高（未读完不再通知）|
| 性能 | 稍低（通知更频繁）| 更高（通知次数少）|
| 适用 | 通用场景 | 高性能场景（Nginx）|

> **Netty 的实际选择**：默认的 NIO 传输（基于 JDK Selector）是 **LT** 模式；换用 `netty-transport-native-epoll`（Linux 原生传输）后才是 **ET** 模式 + 循环读到 EAGAIN。这也是原生传输吞吐更高的原因之一。

## 四、总结：两个维度看五种模型

| 模型 | 等待数据就绪 | 内核拷贝数据到用户空间 | 分类 |
|------|:---:|:---:|------|
| 阻塞 IO | 阻塞 | 阻塞 | 同步阻塞 |
| 非阻塞 IO | 轮询 | 阻塞 | 同步非阻塞 |
| IO 多路复用 | select/epoll 阻塞等待（一次等一批）| 阻塞 | 同步非阻塞 |
| 信号驱动 | 信号通知 | 阻塞 | 同步 |
| 异步 IO | 内核通知 | **内核完成** | 异步 |

**关键结论**：前四种都是**同步** IO——"数据拷贝"这一步都要应用自己完成；只有 AIO 是真异步。所以"Java NIO 是同步非阻塞"这句话是准确的，NIO 的"N"指非阻塞，不是异步。

> 基于多路复用之上的事件驱动架构，见下一篇 [Reactor 模型](./1_reactor)。

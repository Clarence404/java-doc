---
description: 一次读操作的两个阶段、五种 IO 模型、select / poll / epoll、LT / ET 触发模式
---

# IO 模型

> **本篇目标**：能说清五种 IO 模型的区别、select / poll / epoll 为什么性能差距这么大，以及"Java NIO 是同步非阻塞"到底是什么意思。

先建立一个框架：应用调用一次 `read`，数据要经过两个阶段才能到手；**五种 IO 模型的区别，只在于这两个阶段里应用线程在干什么**。

![一次网络读的两个阶段](../assets/netty/io-two-phases.svg)

| 阶段 | 发生了什么 | 耗时特点 |
|------|-----------|---------|
| 阶段一：等待数据就绪 | 对端数据经网卡到达内核的 Socket 接收缓冲区 | 取决于网络和对端，可能很长（长连接大部分时间都在等） |
| 阶段二：数据拷贝 | 内核把数据从内核缓冲区拷贝到用户空间的缓冲区 | 内存拷贝，通常很短 |

带着这两个阶段去看下面的模型，差异会非常清楚：

![IO 模型对比](../assets/netty/io-models.svg)

## 一、五种 IO 模型

演进的主线是：**BIO 线程太多 → C10K 问题 → 非阻塞避免线程挂起 → 多路复用避免空轮询**。信号驱动和 AIO 是另外两条支线。

### 1、阻塞 IO（Blocking IO / BIO）

线程调用 `read` 后，两个阶段全程挂起，直到数据拷贝完成才返回。

```java
ServerSocket serverSocket = new ServerSocket(8080);
Socket socket = serverSocket.accept();          // 阻塞：等待新连接
InputStream in = socket.getInputStream();
int n = in.read(buf);                           // 阻塞：等待数据 + 拷贝
```

- **写法简单**：一个连接一个线程，代码就是顺序逻辑
- **问题**：线程在阶段一大部分时间是空等的，但仍占着资源。每个线程默认栈约 1MB（`-Xss`），上万线程还会带来大量上下文切换

这就引出了著名的 **C10K 问题**：单机如何同时服务 1 万个连接？靠"一连接一线程"撑不住，必须让**一个线程能照看多个连接**。

### 2、非阻塞 IO（Non-Blocking IO）

把 Socket 设为非阻塞后，阶段一数据没到时 `read` 立即返回（内核返回 `EAGAIN`，Java NIO 中返回 0），线程不会被挂起。

```java
socketChannel.configureBlocking(false);
int n = socketChannel.read(buffer);  // 无数据时立即返回 0
```

- **进步**：线程不再被单个连接卡住，理论上可以轮流检查多个连接
- **问题**：应用要自己不停轮询，每次检查都是一次系统调用，连接多、活跃少时大量 CPU 空转
- 阶段二的拷贝依然是阻塞的

非阻塞 IO 很少单独使用，它是多路复用的**前提**：只有 fd 是非阻塞的，事件循环才不会被某次读写卡住。

### 3、IO 多路复用（IO Multiplexing）

把"轮询哪个连接有数据"这件事交给内核：应用通过 `select` / `poll` / `epoll` **一次性等待一批连接**，内核返回其中已就绪的，应用再去读。

```java
Selector selector = Selector.open();
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ);

while (true) {
    selector.select();                               // 阻塞，直到至少一个通道就绪
    Iterator<SelectionKey> it = selector.selectedKeys().iterator();
    while (it.hasNext()) {
        SelectionKey key = it.next();
        it.remove();                                 // 必须手动移除，否则下次重复处理
        if (key.isReadable()) {
            // 此时 read 一定能读到数据（或读到 EOF）
        }
    }
}
```

- **核心收益**：阶段一由一个线程统一等待，线程数不再随连接数增长
- **代价**：`select()` 本身仍会阻塞，阶段二的拷贝仍由应用线程完成
- Java NIO、Netty、Redis、Nginx 都建立在这一模型之上

Selector / Channel / Buffer 的 API 细节见 [专项 - IO / NIO](/java/18_topic_io)，本篇只讲原理。

### 4、信号驱动 IO（Signal-driven IO）

应用通过 `fcntl` 开启 `O_ASYNC`，内核在数据就绪时发送 `SIGIO` 信号，应用在信号处理函数里再去读。

- 阶段一不阻塞、也不用轮询，但阶段二仍要应用自己拷贝
- 信号处理复杂，对 TCP 来说触发信号的事件太多、难以区分，实际很少使用；Java 中没有对应 API

### 5、异步 IO（Asynchronous IO / AIO）

应用发起读请求后立即返回，**两个阶段都由内核完成**，数据已经在用户缓冲区里了才通知应用。这是唯一一个阶段二也不需要应用参与的模型。

```java
AsynchronousServerSocketChannel server =
        AsynchronousServerSocketChannel.open().bind(new InetSocketAddress(8080));
server.accept(null, new CompletionHandler<AsynchronousSocketChannel, Void>() {
    @Override
    public void completed(AsynchronousSocketChannel ch, Void att) {
        server.accept(null, this);   // 继续接收下一个连接
        // 在 ch 上发起异步 read，数据就绪并拷贝完成后回调
    }
    @Override
    public void failed(Throwable exc, Void att) { }
});
```

::: tip Java AIO 为什么用得少
Java AIO（NIO.2）在 Windows 上基于 IOCP，是真正的异步；但在 Linux 上是用 epoll + 内部线程池模拟的，相比 NIO 没有性能优势，编程模型反而更复杂。Netty 也没有采用 AIO 传输。Linux 上真正的异步接口是较新的 io_uring。
:::

## 二、select / poll / epoll 对比

三者都是多路复用的系统调用，**差距在于"每次调用要做多少重复工作"**：select / poll 每次都要把整个 fd 集合交给内核扫一遍，epoll 把"注册"和"等待"拆开，只处理就绪的 fd。

| 对比项 | select | poll | epoll |
|--------|--------|------|-------|
| fd 存储结构 | 固定大小位图 `fd_set` | `pollfd` 数组 | 内核中的红黑树 + 就绪链表 |
| fd 数量上限 | 默认 1024（`FD_SETSIZE`）| 无硬上限（受进程 fd 上限约束）| 无硬上限（同左）|
| 每次调用传参 | 全量 fd 集合从用户态拷贝到内核 | 同 select | 无需重复传，`epoll_ctl` 注册一次即可 |
| 内核如何发现就绪 | 每次线性扫描全部 fd，O(n) | 同 select，O(n) | 数据到达时回调把 fd 放入就绪链表 |
| 返回结果 | 修改原集合，应用再遍历全部 fd 找就绪项 | 同 select | 只返回就绪的 fd，O(就绪数) |
| 触发模式 | 仅水平触发 | 仅水平触发 | 水平触发（默认）/ 边缘触发 |
| 平台 | 几乎所有平台 | POSIX 系统 | 仅 Linux（BSD / macOS 对应 kqueue）|

**epoll 的三个调用**：

| 调用 | 作用 |
|------|------|
| `epoll_create` | 在内核中创建一个 epoll 实例，返回它的 fd |
| `epoll_ctl` | 向实例添加 / 修改 / 删除要监听的 fd 及事件（`EPOLL_CTL_ADD / MOD / DEL`）|
| `epoll_wait` | 阻塞等待，返回已就绪的事件列表 |

**epoll 为什么快**：

- **红黑树**保存所有被监听的 fd，`epoll_ctl` 增删改是 O(log n)，而且只在连接建立、关闭时调用，不是每次等待都做
- 注册时内核给该 fd 挂上回调；数据到达时回调把它放进**就绪链表**
- `epoll_wait` 只需检查就绪链表是否为空，把就绪项拷贝给应用，代价与总连接数无关

::: tip 什么场景 epoll 优势最大
连接数越多、同一时刻活跃的比例越低（典型如大量长连接、IM、推送），epoll 相对 select / poll 的优势越明显。连接很少且都很活跃时，三者差别不大。Java NIO 的 `Selector` 在 Linux 上默认实现就是 epoll。
:::

## 三、epoll 的两种触发模式

**LT 是"只要还有数据就一直提醒"，ET 是"只在状态变化那一刻提醒一次"**。ET 通知次数少，但要求应用一次把数据读完。

| 对比项 | LT（水平触发，默认）| ET（边缘触发）|
|--------|--------------------|---------------|
| 触发时机 | 缓冲区只要有未读数据，每次 `epoll_wait` 都会返回 | 仅在"无数据 → 有新数据"时通知一次 |
| 读取要求 | 可以分多次读 | 必须循环读到返回 `EAGAIN` |
| 漏读风险 | 低 | 高（没读完且无新数据到达，就不会再通知）|
| 系统调用次数 | 较多 | 较少 |
| 典型使用 | select / poll 兼容语义、JDK NIO | Nginx、Netty 原生 epoll 传输 |

::: tip Netty 的实际选择
默认的 NIO 传输（`NioEventLoopGroup`，基于 JDK `Selector`）是 **LT** 模式；换用 `netty-transport-native-epoll`（`EpollEventLoopGroup`）后使用 **ET** 模式，并在读取时循环读到 `EAGAIN`。这是原生传输吞吐更高的原因之一，生产配置见 [生产实践与调优](./11_production)。
:::

## 四、总结：用两个阶段给五种模型归类

| 模型 | 阶段一：等待数据就绪 | 阶段二：内核拷贝到用户空间 | 分类 |
|------|:---:|:---:|------|
| 阻塞 IO | 阻塞 | 阻塞 | 同步阻塞 |
| 非阻塞 IO | 不阻塞（应用轮询）| 阻塞 | 同步非阻塞 |
| IO 多路复用 | 阻塞在 select / epoll_wait 上（一次等一批）| 阻塞 | 同步非阻塞 |
| 信号驱动 IO | 不阻塞（信号通知）| 阻塞 | 同步 |
| 异步 IO | 不阻塞（内核完成后通知）| **内核完成** | 异步 |

### 1、同步 / 异步与阻塞 / 非阻塞不是一回事

两组概念经常被混用，但它们描述的是不同的维度：

| 维度 | 关注点 | 判断方法 |
|------|--------|---------|
| 阻塞 / 非阻塞 | 数据没就绪时，调用线程**是否被挂起** | 看阶段一：调用是立即返回还是等着 |
| 同步 / 异步 | 数据拷贝这件事**由谁完成** | 看阶段二：应用自己调用 `read` 拷贝是同步；内核拷好后通知是异步 |

### 2、关键结论

- 前四种模型的阶段二都要应用线程自己完成，所以都是**同步 IO**，只有 AIO 是真正的异步
- 因此"**Java NIO 是同步非阻塞**"这句话是准确的：NIO 的 Channel 可以设为非阻塞，配合 Selector 多路复用，但数据仍由应用线程读取
- NIO 通常被解读为 New IO，它的核心能力是非阻塞与多路复用，而不是异步

## 小结

- 一次网络读分两个阶段：等待数据就绪、内核拷贝到用户空间，五种模型的差别都落在这两个阶段上
- BIO 的问题是线程数随连接数增长；非阻塞 IO 解决了线程挂起，却带来空轮询；多路复用让一个线程等待一批连接
- epoll 把"注册"和"等待"拆开，靠红黑树 + 就绪链表做到与连接总数无关的等待开销
- JDK NIO 使用 LT 模式，Netty 原生 epoll 传输使用 ET 模式
- 只有 AIO 是异步 IO，Java NIO 与 Netty 都是同步非阻塞 + 多路复用

> 下一篇：[Reactor 模型](./2_reactor) —— 多路复用拿到了就绪事件，接下来要用什么线程结构去处理它们。

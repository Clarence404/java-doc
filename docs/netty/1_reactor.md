# Reactor 模型

::: warning Todo 理解后优化
:::

Reactor 模型是 **基于 IO 多路复用的一种事件驱动模型**，用于处理高并发网络请求。

### **1、Reactor 核心原理**

- **Reactor（反应器）** 负责监听多个 IO 事件，并分发给对应的 **Handler（处理器）** 进行处理。

- 适用于 **高性能服务器（如 Netty、Tomcat、Redis、Kafka）**。

### **2、Reactor 的三种实现模式**

#### **① 单线程 Reactor**

- **特点**：单个 `Reactor` 线程负责监听连接、读写数据，并执行业务逻辑。

- **缺点**：在高并发下容易阻塞。

- **适用场景**：小规模并发，如 GUI 事件驱动。

  **示例（伪代码）：**
  ```java
  Selector selector = Selector.open();
  while (true) {
      selector.select(); // 监听所有事件
      for (SelectionKey key : selector.selectedKeys()) {
          if (key.isAcceptable()) accept(); // 处理新连接
          if (key.isReadable()) read();     // 读取数据
          if (key.isWritable()) write();   // 发送数据
      }
  }
  ```

#### **② 多线程 Reactor**

- **特点**：

    - `Reactor` 线程只负责监听事件，并将任务分发给 **线程池** 处理。

    - **避免单线程阻塞问题**，提高吞吐量。

- **适用场景**：一般的高并发服务器（如 Nginx、Netty）。

#### **③ 主从 Reactor（Master-Slave Reactor）**

- **特点**：

    - **主 Reactor** 负责监听连接请求，并将任务交给 **从 Reactor 线程池** 处理读写事件。

    - **从 Reactor** 负责真正的数据处理，减少主线程负担。
  
- **适用场景**：**超高并发场景**（如 Kafka、Redis、Netty）。

  **示例（Netty 使用的主从 Reactor）：**
  ```java
  EventLoopGroup bossGroup = new NioEventLoopGroup(1); // 处理连接
  EventLoopGroup workerGroup = new NioEventLoopGroup(); // 处理业务
  ServerBootstrap bootstrap = new ServerBootstrap()
      .group(bossGroup, workerGroup)
      .channel(NioServerSocketChannel.class)
      .childHandler(new ChannelInitializer<>() {
          protected void initChannel(SocketChannel ch) {
              ch.pipeline().addLast(new MyHandler()); // 添加业务处理器
          }
      });
  ```

---

## **3、IO 模型与 Reactor 的关系**

| 方案    | IO 模型              | 适用场景 |
|---------|----------------------|----------|
| **BIO** | 阻塞 IO              | 低并发  |
| **NIO** | 多路复用（Reactor 单线程） | 一般并发 |
| **Netty** | 多路复用（Reactor 多线程） | 高并发  |
| **AIO** | 异步 IO（Reactor 线程池） | 超高并发 |

---

## **4、IO和Reactor 总结**

- **IO 模型** 主要描述 **数据传输方式**（阻塞/非阻塞、同步/异步）。

- **Reactor 模型** 是基于 **IO 多路复用的事件驱动架构**，用于**高并发**网络服务器。

- **BIO、NIO、AIO** 对应不同的并发需求：

    - **BIO**：简单，但性能差。

    - **NIO（Reactor）**：主流方案，如 **Netty、Tomcat**。

    - **AIO（Proactor）**：适合超高并发（但 Java AIO 实际应用少）。

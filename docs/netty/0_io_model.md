# IO 模型

::: warning Todo 理解后优化
:::

在网络编程中，IO 模型和 Reactor 模型是两种重要的并发处理方式，主要用于高并发网络服务器的设计，特别是 **Java 的 Netty、NIO、Spring WebFlux** 等框架都会涉及。

---
IO 模型主要描述 **操作系统如何处理网络 IO 请求**。常见的 IO 模型有 5 种：

### **1、 阻塞IO（Blocking IO）**
- **特点**：每个请求需要一个线程处理，线程会一直阻塞，直到数据到达并完成读取。

- **缺点**：线程资源浪费，在高并发情况下容易造成性能瓶颈。

- **示例**：
  ```java
  ServerSocket serverSocket = new ServerSocket(8080);
  Socket socket = serverSocket.accept(); // 阻塞等待连接
  InputStream inputStream = socket.getInputStream();
  int data = inputStream.read(); // 阻塞等待数据
  ```

### **2、 非阻塞IO（Non-Blocking IO）**
- **特点**：进程不断轮询检查数据是否准备好，如果没有数据，立即返回，不会阻塞线程。

- **缺点**：CPU 资源消耗大，需要不断轮询。

- **示例**：
  ```java
  socketChannel.configureBlocking(false);
  int bytesRead = socketChannel.read(buffer); // 非阻塞读取
  ```

### **3、IO多路复用（Multiplexing IO，Select/epoll）**
- **特点**：使用 `select` / `poll` / `epoll` 让单个线程管理多个连接，避免了多个线程的资源开销。

- **优点**：适用于高并发场景，不需要每个连接创建一个线程。

- **示例（Java NIO）**：
  ```java
  Selector selector = Selector.open();
  socketChannel.register(selector, SelectionKey.OP_READ);
  while (true) {
      selector.select(); // 阻塞直到有事件发生
      Set<SelectionKey> keys = selector.selectedKeys();
      for (SelectionKey key : keys) {
          if (key.isReadable()) {
              // 处理可读事件
          }
      }
  }
  ```

### **4、信号驱动IO（Signal-driven IO）**

- **特点**：使用 `SIGIO` 信号通知应用程序数据已准备好。

- **应用场景**：很少用于 Java，更常见于 Linux 低级编程。

### **5、异步IO（Asynchronous IO，AIO）**
- **特点**：IO 操作完全由内核负责，应用程序只需要在数据准备好后接收通知，无需轮询。

- **优点**：彻底的异步模型，适用于超高并发场景。

- **示例（Java AIO）**：
  ```java
  AsynchronousServerSocketChannel server = AsynchronousServerSocketChannel.open();
  server.accept(null, new CompletionHandler<>() {
      public void completed(AsynchronousSocketChannel channel, Object attachment) {
          // 处理连接
      }
  });
  ```


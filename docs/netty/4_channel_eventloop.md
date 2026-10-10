---
description: Channel 生命周期与 AttributeKey、ChannelFuture 异步结果、EventLoop 运行机制与线程数、业务线程池
---

# Channel 与 EventLoop

> 前置阅读：[Netty 入门](./3_netty_desc)

**Channel 是连接，EventLoop 是干活的线程，Pipeline 是处理流水线，Handler 是流水线上的工位。** 本篇讲前两个：Channel 如何表示连接、IO 结果如何通过 ChannelFuture 异步返回、EventLoop 如何单线程串行处理连接，以及慢业务为什么必须交给业务线程池。

---

## 一、Channel：连接的抽象

**Channel 把"一条连接"封装成统一对象**：不论底层是 NIO、epoll 还是 UDP，上层都用同一套 `read / write / bind / connect / close` API。

四个核心组件的关系如下，Pipeline 与 Handler 见 [Pipeline 与 Handler](./5_pipeline_handler)：

| 组件 | 一句话定位 | 对应关系 | 所在篇 |
|------|-----------|---------|-------|
| `Channel` | 一条网络连接（或一个监听端口）的抽象 | 1 个 Channel 拥有 1 条 Pipeline | 本篇 |
| `EventLoop` | 单线程事件循环，负责若干 Channel 的全部 IO 与任务 | 1 个 EventLoop 服务 N 个 Channel | 本篇 |
| `ChannelPipeline` | Handler 组成的双向链表（责任链） | 1 条 Pipeline 串起 N 个 Handler | [下一篇](./5_pipeline_handler) |
| `ChannelHandler` | 处理入站事件 / 拦截出站操作的业务单元 | 通过 `ChannelHandlerContext` 挂在 Pipeline 上 | [下一篇](./5_pipeline_handler) |

### 1、常见实现

| 实现类 | 传输方式 | 说明 |
|--------|---------|------|
| `NioServerSocketChannel` | TCP 服务端 | 监听端口、接收新连接，跨平台 |
| `NioSocketChannel` | TCP 连接 | 服务端 accept 出来的子连接，或客户端连接 |
| `EpollServerSocketChannel` / `EpollSocketChannel` | TCP（Linux native） | 基于 JNI 直接调用 epoll，性能更好、支持更多 TCP 参数，需引入 `netty-transport-native-epoll` |
| `NioDatagramChannel` | UDP | 无连接，一个 Channel 收发所有数据报 |

::: tip 选择建议
开发机用 `Nio*` 保证跨平台；Linux 生产环境可切换 `Epoll*`（配套 `EpollEventLoopGroup`），通常用 `Epoll.isAvailable()` 做运行时判断。
:::

### 2、生命周期

Channel 的状态变化会以**入站事件**的形式沿 Pipeline 传播，Handler 覆写对应方法即可感知：

| 回调 | 触发时机 | 典型用途 |
|------|---------|---------|
| `channelRegistered` | Channel 注册到某个 EventLoop（Selector）上 | 很少直接使用 |
| `channelActive` | 连接建立完成（客户端 connect 成功 / 服务端 accept 完成），可以读写 | 记录上线、发送握手或登录包 |
| `channelInactive` | 连接断开（对端关闭、本端 close、网络异常） | 清理会话、设备下线通知 |
| `channelUnregistered` | Channel 从 EventLoop 注销 | 很少直接使用 |

正常流程是 `Registered → Active → (多次 channelRead) → Inactive → Unregistered`。

### 3、在 Channel 上挂数据：AttributeKey

**需要把"这条连接属于谁"记下来时，用 `AttributeKey`，不要自己维护 `Map<Channel, X>`**——属性随 Channel 一起销毁，天然不会泄漏。

```java
public final class ChannelAttrs {
    // 全局唯一的 key，建议定义为常量
    public static final AttributeKey<Long> USER_ID = AttributeKey.valueOf("userId");
}

// 登录成功后绑定用户
ctx.channel().attr(ChannelAttrs.USER_ID).set(10086L);

// 后续任意 Handler 中读取
Long userId = ctx.channel().attr(ChannelAttrs.USER_ID).get();
```

---

## 二、ChannelFuture：一切 IO 都是异步的

**Netty 中所有 IO 操作（bind、connect、write、close）都立即返回一个 `ChannelFuture`，操作结果要通过它获取。** 调用返回时，操作多半还没完成。

### 1、addListener 与 sync

| 方式 | 行为 | 适用场景 |
|------|------|---------|
| `addListener(listener)` | 非阻塞，操作完成后回调 | **业务代码首选**，尤其是在 Handler 中 |
| `sync()` | 阻塞等待，失败时抛出异常 | 启动流程（`bind(port).sync()`）、测试代码 |
| `await()` | 阻塞等待，失败时**不抛异常**，需自己检查 `isSuccess()` | 很少使用 |

```java
ctx.writeAndFlush(response).addListener((ChannelFutureListener) future -> {
    if (!future.isSuccess()) {
        // 写失败（连接已断、编码异常等），记录原因并关闭
        log.warn("响应发送失败", future.cause());
        future.channel().close();
    }
});
```

### 2、内置监听器

| 常量 | 作用 |
|------|------|
| `ChannelFutureListener.CLOSE` | 操作完成后关闭连接（如 HTTP 短连接回完响应就断开） |
| `ChannelFutureListener.CLOSE_ON_FAILURE` | 仅在失败时关闭连接 |
| `ChannelFutureListener.FIRE_EXCEPTION_ON_FAILURE` | 失败时触发 `exceptionCaught`，交给统一异常处理 Handler |

```java
// 发送最后一条消息后断开
ctx.writeAndFlush(byeMsg).addListener(ChannelFutureListener.CLOSE);
```

::: warning 不要在 EventLoop 线程里 sync() / await()
Handler 的回调默认就运行在 EventLoop 线程上。在这里调用 `future.sync()` 等于**让线程等待自己去完成这个操作**——Netty 检测到后会直接抛出 `BlockingOperationException`；即使侥幸绕过检测，也会形成死锁并卡住该 EventLoop 名下所有连接。Handler 内一律使用 `addListener`。
:::

---

## 三、EventLoop 与 EventLoopGroup：干活的线程

**一个 EventLoop = 一个线程 + 一个 Selector + 任务队列，它在死循环里轮流处理 IO 事件和提交进来的任务。** EventLoopGroup 则是一组 EventLoop，对应 [Reactor 模型](./2_reactor)中的"从 Reactor 组"。

### 1、事件循环在做什么

`NioEventLoop` 的 `run()` 大致是三步循环：

1. **select**：在 Selector 上等待 IO 就绪（有任务待执行时不会长时间阻塞）
2. **processSelectedKeys**：处理就绪的 accept / read / write 事件，驱动 Pipeline
3. **runAllTasks**：执行 `taskQueue`（`execute()` 提交的普通任务）和到期的 `scheduledTaskQueue`（`schedule()` 提交的定时任务）

两类工作的时间配比由 `ioRatio` 控制，**默认 50**，即 IO 处理与任务执行大致各占一半时间。

### 2、Channel 终身绑定一个 EventLoop

**Channel 注册时被分配给某个 EventLoop，此后它的所有 IO 事件和 Handler 回调都只在这一个线程上执行。**

- **串行无锁**：同一 Channel 的 Handler 不会被并发调用，Handler 内部状态无需加锁
- **天然有序**：读到的消息按到达顺序处理，写出的消息按调用顺序发出
- **代价**：一个 EventLoop 服务多个 Channel，**任何阻塞都会拖慢它名下的所有连接**（见第四节）

分配策略由 `EventExecutorChooser` 决定，本质是**轮询（round-robin）**：线程数是 2 的幂时用位运算 `idx & (n - 1)`，否则用取模。

### 3、线程数

`NioEventLoopGroup` 无参构造时，线程数默认 = **CPU 核数 × 2**（可用 `-Dio.netty.eventLoopThreads` 覆盖）。服务端通常这样配置：

```java
EventLoopGroup bossGroup   = new NioEventLoopGroup(1); // 只负责 accept，1 个线程足够
EventLoopGroup workerGroup = new NioEventLoopGroup();  // 负责读写，默认 CPU × 2
```

### 4、在 EventLoop 中执行任务

**从外部线程操作 Channel 时，把任务交给它的 EventLoop 执行，就能复用"串行无锁"的保证。** Netty 内部大量使用下面这个模式：

```java
EventLoop loop = channel.eventLoop();
if (loop.inEventLoop()) {
    doSomething();                   // 已在 IO 线程，直接执行
} else {
    loop.execute(this::doSomething); // 不在 IO 线程，投递到任务队列
}

// 定时任务：10 秒后检查是否完成登录
loop.schedule(() -> {
    if (channel.attr(ChannelAttrs.USER_ID).get() == null) {
        channel.close(); // 超时未登录，踢掉
    }
}, 10, TimeUnit.SECONDS);
```

::: tip
`channel.write()`、`writeAndFlush()` 等方法内部已经做了 `inEventLoop()` 判断，任何线程直接调用都是安全的，不需要自己包一层 `execute`。
:::

---

## 四、业务线程池：不要阻塞 EventLoop

**EventLoop 线程只做"搬数据"，查库、调 RPC、复杂计算这类慢操作必须交给独立线程池，否则一个慢请求会卡住同线程上的所有连接。** Netty 中有两种常见做法。

### 1、方式一：为 Handler 指定 EventExecutorGroup

```java
// 全局共享一个业务线程组
EventExecutorGroup businessGroup = new DefaultEventExecutorGroup(16);

@Override
protected void initChannel(SocketChannel ch) {
    ch.pipeline()
      .addLast(new LengthFieldBasedFrameDecoder(65535, 0, 2, 0, 2))
      .addLast(new ProtocolDecoder())
      .addLast(new ProtocolEncoder())
      .addLast(businessGroup, "biz", new BusinessHandler()); // 该 Handler 的回调在 businessGroup 中执行
}
```

Netty 会给每个 Channel 固定分配 `businessGroup` 中的一个线程来执行 `BusinessHandler`，**同一连接的消息仍然串行、有序**，Handler 写法不需要任何改变。

### 2、方式二：提交到自有线程池，再写回

```java
public class BusinessHandler extends SimpleChannelInboundHandler<Request> {
    private final ExecutorService bizPool; // 自定义的有界线程池

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, Request req) {
        bizPool.execute(() -> {
            Response resp = service.handle(req);   // 在业务线程中执行慢逻辑
            ctx.writeAndFlush(resp);               // 线程安全：Netty 会把写操作投递回 EventLoop
        });
    }
}
```

注意 `req` 必须是已解码的普通对象；如果传递的是 `ByteBuf`，要先 `retain()` 并在业务线程中负责释放。

### 3、对比

| 维度 | 方式一：`addLast(group, handler)` | 方式二：自有线程池 |
|------|-------------------------------|-----------------|
| 同一连接消息顺序 | 保证（每个 Channel 固定一个线程） | **不保证**，需要自己处理 |
| 线程利用 | 一个慢连接会拖住同线程上的其他连接 | 任务级调度，负载更均衡 |
| 背压与拒绝策略 | 能力有限 | 可用有界队列 + 拒绝策略精细控制 |
| 改造成本 | 低，一行代码 | 中，需要处理线程切换和资源释放 |
| 适合场景 | 业务有序性要求高，如 IoT 设备指令 | 请求之间相互独立，如 RPC、HTTP 接口 |

---

## 小结

- **Channel** 是连接，生命周期以入站事件传播；用 `AttributeKey` 在连接上挂会话数据
- **所有 IO 都异步返回 ChannelFuture**，Handler 里只用 `addListener`，绝不 `sync()`
- **EventLoop 单线程 + 任务队列**，Channel 终身绑定一个 EventLoop，换来串行无锁和消息有序
- 外部线程操作 Channel 时把任务投递给它的 EventLoop；慢业务交给业务线程池，不要阻塞 EventLoop

> 下一篇：[Pipeline 与 Handler](./5_pipeline_handler) —— 消息在连接上如何被一层层处理，以及 Handler 的编写规则。

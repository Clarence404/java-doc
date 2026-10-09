---
description: Channel 生命周期、ChannelFuture、EventLoop 运行机制、Pipeline 事件传播、Handler、业务线程池
---

# 核心组件：Channel、EventLoop 与 Pipeline

> **本篇目标**：吃透 Netty 的四大核心抽象，知道一条消息从进入 Socket 到交给业务代码，中间经过了谁、在哪个线程上执行。
>
> **前置阅读**：[Netty 入门](./3_netty_desc)

上一篇用 Echo 示例跑通了 Netty，这一篇把示例里出现的组件逐个拆开。先记住一句话：**Channel 是连接，EventLoop 是干活的线程，Pipeline 是处理流水线，Handler 是流水线上的工位。**

| 组件 | 一句话定位 | 对应关系 |
|------|-----------|---------|
| `Channel` | 一条网络连接（或一个监听端口）的抽象 | 1 个 Channel 拥有 1 条 Pipeline |
| `EventLoop` | 单线程事件循环，负责若干 Channel 的全部 IO 与任务 | 1 个 EventLoop 服务 N 个 Channel |
| `ChannelPipeline` | Handler 组成的双向链表（责任链） | 1 条 Pipeline 串起 N 个 Handler |
| `ChannelHandler` | 处理入站事件 / 拦截出站操作的业务单元 | 通过 `ChannelHandlerContext` 挂在 Pipeline 上 |

---

## 一、Channel：连接的抽象

**Channel 把"一条连接"封装成统一对象**：不论底层是 NIO、epoll 还是 UDP，上层都用同一套 `read / write / bind / connect / close` API。

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
- **代价**：一个 EventLoop 服务多个 Channel，**任何阻塞都会拖慢它名下的所有连接**（见第六节）

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

## 四、ChannelPipeline 与 ChannelHandlerContext：处理流水线

**Pipeline 是一条由 `ChannelHandlerContext` 组成的双向链表，头尾固定是 `HeadContext` 和 `TailContext`；入站事件从头往尾走，出站操作从尾往头走。**

![ChannelPipeline 事件传播方向](../assets/netty/pipeline-propagation.svg)

- **ChannelHandlerContext**（处理器上下文）：Handler 与 Pipeline 之间的"插座"，保存前后指针，Handler 通过它读写数据、传播事件
- **HeadContext**：同时实现入站和出站接口；出站操作最终在这里调用底层 `Unsafe` 真正读写 Socket
- **TailContext**：入站兜底，负责释放无人处理的消息、打印未处理的异常

### 1、传播方向与执行顺序

```java
pipeline.addLast(new InboundA())
        .addLast(new InboundB())
        .addLast(new OutboundC())
        .addLast(new OutboundD());
```

| 事件类型 | 例子 | 流向 | 本例经过的顺序 |
|---------|------|------|--------------|
| 入站（Inbound） | `channelActive`、`channelRead`、`exceptionCaught` | Head → Tail | A → B（跳过出站 Handler） |
| 出站（Outbound） | `bind`、`connect`、`write`、`flush`、`close` | Tail → Head | D → C（与添加顺序相反） |

每个事件只会经过"对应类型"的 Handler：入站事件跳过 C、D，出站操作跳过 A、B。

### 2、三个传播陷阱

这是 Netty 实战中最高频的一类问题，现象通常是"Handler 加了却不生效"。

**陷阱一：传播不是自动的。**
入站 Handler 必须显式调用 `ctx.fireChannelRead(msg)`，事件才会继续流向下一个 Handler。继承 `ChannelInboundHandlerAdapter` 且不覆写方法时，默认实现会帮你传播；**一旦覆写了 `channelRead` 又忘记 fire，后面的 Handler 全部收不到消息**。

**陷阱二：`ctx.write()` 与 `channel.write()` 起点不同。**

| 调用 | 起点 | 经过的出站 Handler |
|------|------|------------------|
| `ctx.write(msg)` | **当前 Handler 所在位置**，向 Head 方向找 | 只有排在当前 Handler **之前**的出站 Handler |
| `ctx.channel().write(msg)` / `ctx.pipeline().write(msg)` | **Tail** | 整条链上的所有出站 Handler |

如果业务 Handler 排在编码器**前面**，它调用 `ctx.write()` 时编码器就被跳过了，发出去的是未编码的对象（通常直接报类型不支持）。**经验做法：编解码器放前面，业务 Handler 放最后。**

**陷阱三：异常沿入站方向传播，需要兜底。**
Handler 中抛出的异常会触发 `exceptionCaught`，并从当前位置**向 Tail 方向**传播。如果一路没人处理，最终由 TailContext 打一条 "An exceptionCaught() event was fired... reached at the tail of the pipeline" 警告了事，连接也不会被关闭。因此惯例是在**链尾放一个统一异常处理 Handler**：

```java
@ChannelHandler.Sharable
public class GlobalExceptionHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        log.error("连接异常，remote={}", ctx.channel().remoteAddress(), cause);
        ctx.close(); // 记录日志后关闭连接，避免半死不活的连接堆积
    }
}
```

::: warning 出站失败不会触发 exceptionCaught
`write` 失败只会标记在返回的 `ChannelFuture` 上，默认不会走 `exceptionCaught`。需要统一处理时，给 future 加监听器，或使用 `FIRE_EXCEPTION_ON_FAILURE`。
:::

### 3、运行时动态增删 Handler

**Pipeline 可以在运行时修改，适合"只需执行一次"的逻辑**，例如认证通过后移除认证 Handler、协议探测后替换为具体的编解码器。

```java
public class AuthHandler extends SimpleChannelInboundHandler<LoginRequest> {
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, LoginRequest req) {
        if (authService.verify(req.getToken())) {
            ctx.channel().attr(ChannelAttrs.USER_ID).set(req.getUserId());
            ctx.pipeline().remove(this); // 认证通过，后续消息不再经过本 Handler
        } else {
            ctx.writeAndFlush(LoginResponse.fail()).addListener(ChannelFutureListener.CLOSE);
        }
    }
}
```

常用方法：`addFirst / addLast / addBefore / addAfter / remove / replace`，都支持给 Handler 起名字，便于后续按名称定位。

---

## 五、ChannelHandler：流水线上的工位

**Handler 分入站和出站两类；实际开发中几乎不直接实现接口，而是继承 Netty 提供的适配器类。**

### 1、入站与出站

| 类型 | 接口 | 常用基类 | 典型方法 |
|------|------|---------|---------|
| 入站处理器 | `ChannelInboundHandler` | `ChannelInboundHandlerAdapter`、`SimpleChannelInboundHandler<I>` | `channelActive`、`channelRead`、`userEventTriggered`、`exceptionCaught` |
| 出站处理器 | `ChannelOutboundHandler` | `ChannelOutboundHandlerAdapter` | `write`、`flush`、`connect`、`close` |
| 双向处理器 | 同时实现两者 | `ChannelDuplexHandler` | 入站 + 出站方法都可覆写（如 `IdleStateHandler`） |

### 2、Adapter 与 SimpleChannelInboundHandler

| 基类 | 消息类型 | 消息释放 | 适用场景 |
|------|---------|---------|---------|
| `ChannelInboundHandlerAdapter` | `Object`，需自己判断和强转 | **需手动释放**或继续 fire 给下一个 | 需要把消息透传下去的中间 Handler |
| `SimpleChannelInboundHandler<I>` | 泛型 `I`，类型不匹配的消息自动透传 | `channelRead0` 返回后**自动 release** | 消息在这里被"消费掉"的业务 Handler |

::: warning SimpleChannelInboundHandler 的自动释放
因为 `channelRead0` 返回后消息就被释放了，**不要把 msg 保存下来或交给其他线程异步使用**；确有需要时先 `retain()`，或转换成普通 POJO 再传递。引用计数的完整规则见 [ByteBuf 与内存管理](./5_bytebuf)。
:::

### 3、Handler 自身的生命周期

除了 Channel 事件，Handler 还有两个"加入 / 离开 Pipeline"的回调：

| 回调 | 触发时机 | 典型用途 |
|------|---------|---------|
| `handlerAdded` | Handler 被添加到 Pipeline 后 | 初始化资源（如 `IdleStateHandler` 在这里启动空闲检测定时器） |
| `handlerRemoved` | Handler 从 Pipeline 移除后 | 释放资源（`ByteToMessageDecoder` 会在这里处理未解码完的残留数据） |

`ChannelInitializer` 就是利用 `handlerAdded` 调用 `initChannel()` 装配 Pipeline，装配完成后把自己移除。

### 4、@Sharable：Handler 能否共享

**默认情况下，一个 Handler 实例只能被添加到一条 Pipeline 中；只有标注了 `@ChannelHandler.Sharable` 的 Handler 才能在多个 Channel 间共享同一个实例。**

- 未标注却重复添加时，Netty 抛出 `ChannelPipelineException`，提示该 Handler "is not a @Sharable handler"
- `@Sharable` 只是"声明"，Netty 不会帮你保证线程安全——**共享实例会被多个 EventLoop 线程并发调用**
- `ByteToMessageDecoder` 及其子类（如各种 FrameDecoder）内部持有累积缓冲区，**禁止**标注 `@Sharable`

| Handler 类型 | 能否共享 | 做法 |
|-------------|---------|------|
| 无状态（只依赖入参和线程安全的依赖） | 可以 | 标注 `@Sharable`，定义成单例（如 Spring Bean） |
| 有状态（成员变量记录连接相关数据） | 不可以 | 在 `initChannel()` 里每次 `new` |
| 解码器（`ByteToMessageDecoder` 子类） | 不可以 | 每次 `new` |

```java
@Override
protected void initChannel(SocketChannel ch) {
    ch.pipeline()
      .addLast(new LengthFieldBasedFrameDecoder(65535, 0, 2, 0, 2)) // 有状态，每连接 new
      .addLast(new SessionHandler())                               // 有状态，每连接 new
      .addLast(globalExceptionHandler);                            // 无状态 + @Sharable，共享单例
}
```

---

## 六、业务线程池：不要阻塞 EventLoop

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
- **Pipeline 入站 Head → Tail、出站 Tail → Head**；牢记三个坑：忘记 fire、`ctx.write` 跳过后面的编码器、链尾缺异常兜底
- 无状态 Handler 才能 `@Sharable` 共享；慢业务交给业务线程池，不要阻塞 EventLoop

> 下一篇：[ByteBuf 与内存管理](./5_bytebuf) —— Pipeline 里流动的数据长什么样，以及如何避免内存泄漏。

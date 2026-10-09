---
description: Pipeline 结构与事件传播、三个传播陷阱、动态增删 Handler、入站与出站 Handler、@Sharable 共享规则
---

# Pipeline 与 Handler

> **本篇目标**：掌握消息在一条连接上的处理路径：Pipeline 如何串起 Handler、入站与出站事件各往哪个方向走、最容易踩的三个传播陷阱，以及 Handler 的基类选择、生命周期和共享规则。
>
> **前置阅读**：[Channel 与 EventLoop](./4_channel_eventloop)

上一篇讲了连接（Channel）和线程（EventLoop）。每个 Channel 都拥有一条 **ChannelPipeline**，从 Socket 读到的数据、要写出去的数据都沿着它流动，流水线上的每个工位就是一个 **ChannelHandler**。Pipeline 上的所有回调默认都运行在该 Channel 绑定的 EventLoop 线程上，所以上一篇"不要阻塞 EventLoop"的规则在这里同样适用。

---

## 一、ChannelPipeline 与 ChannelHandlerContext：处理流水线

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

## 二、ChannelHandler：流水线上的工位

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
因为 `channelRead0` 返回后消息就被释放了，**不要把 msg 保存下来或交给其他线程异步使用**；确有需要时先 `retain()`，或转换成普通 POJO 再传递。引用计数的完整规则见 [ByteBuf 与内存管理](./6_bytebuf)。
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

## 小结

- **Pipeline 是 ChannelHandlerContext 组成的双向链表**，头尾固定为 HeadContext 和 TailContext
- **入站 Head → Tail、出站 Tail → Head**；牢记三个坑：忘记 fire、`ctx.write` 跳过后面的编码器、链尾缺异常兜底
- 只需执行一次的逻辑（认证、协议探测）可以在运行时从 Pipeline 移除或替换
- 中间 Handler 继承 `ChannelInboundHandlerAdapter` 并继续传播，消费消息的业务 Handler 用 `SimpleChannelInboundHandler`（自动释放）
- 无状态 Handler 才能 `@Sharable` 共享；解码器和有状态 Handler 每个连接 `new` 一个

> 下一篇：[ByteBuf 与内存管理](./6_bytebuf) —— Pipeline 里流动的数据长什么样，以及如何避免内存泄漏。

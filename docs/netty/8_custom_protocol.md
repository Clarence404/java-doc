---
description: 帧格式与字段设计、LengthFieldBasedFrameDecoder、编解码器体系、请求与响应的匹配
---

# 自定义私有协议

> **本篇目标**：从零设计一个二进制私有协议，完成帧格式、编解码器、Pipeline 组装，并实现 RPC 核心的请求-响应匹配。
>
> **前置阅读**：[粘包与拆包](./7_stick_split)

上一篇解决了"消息从哪结束"的问题，这一篇往前再走一步：**一条消息里应该放什么、怎么编码、收到后怎么交给正确的调用方。** 这正是 Dubbo、RocketMQ 等框架底层通信协议在做的事情。

---

## 一、帧格式设计

### 1、先选边界方案

[粘包与拆包](./7_stick_split)中介绍的三种方案，在私有协议中的取舍如下：

| 方案 | 原理 | 适用场景 |
|------|------|---------|
| 固定长度 | 每帧字节数固定 | 消息大小一致，如传感器定时上报 |
| 分隔符 | 特定字节（`\n`、`0x00`）标识帧尾 | 纯文本协议，如 Redis RESP |
| **长度字段** | 帧头包含 Length 字段 | **通用推荐**，支持变长二进制消息 |

私有协议几乎都选择长度字段方案，下文均以此为基础。

### 2、字段设计原则

**帧头的每个字段都应该回答一个问题：接收方需要知道什么，才能安全、正确地处理这条消息？**

| 字段 | 典型长度 | 作用 | 不设计会怎样 |
|------|---------|------|------------|
| 魔数（Magic） | 2~4 字节 | 固定值（如 `0xABCD`），快速识别"这是不是我的协议" | 端口扫描、误连的数据被当成正常消息解析 |
| 版本（Version） | 1 字节 | 协议升级时新旧版本并存、按版本解析 | 协议一改，新旧客户端全部不兼容 |
| 序列化方式 | 1 字节 | 标识 Payload 用 JSON、Protobuf 还是 Hessian | 无法平滑切换序列化方案 |
| 消息类型（Command） | 1 字节 | 区分请求 / 响应 / 心跳 / 业务指令 | 所有消息只能靠解析 Payload 才知道是什么 |
| 请求 ID（requestId） | 4~8 字节 | 把响应与请求一一对应（见第七节） | 一条连接只能"发一个、等一个"，无法并发 |
| 状态码 | 1 字节 | 响应是否成功、错误类型 | 错误信息只能塞进 Payload，处理不统一 |
| 长度（Length） | 2~4 字节 | Payload 字节数，帧解码器据此拆包 | 无法界定消息边界 |
| 消息体（Payload） | N 字节 | 业务数据 | —— |
| 校验（CRC，可选） | 2~4 字节 | 检测传输过程中的数据损坏 | 在不可靠链路（串口转 TCP 等）上可能收到脏数据 |

::: tip 字段取舍
字段越多越"完备"，但每条消息的固定开销也越大。IoT 设备链路带宽小，通常只保留魔数、版本、命令字、长度、CRC；RPC 场景则一定要有请求 ID 和序列化方式。
:::

### 3、本文示例帧格式

为了聚焦编解码流程，本文示例采用一个精简帧，**只包含魔数、版本、命令字、长度和消息体**，共 6 字节固定头：

![私有协议帧格式](../assets/netty/protocol-frame.svg)

| 字段 | 长度 | 说明 |
|------|------|------|
| Magic | 2 字节 | 固定 `0xABCD` |
| Version | 1 字节 | 协议版本，当前为 `1` |
| Command | 1 字节 | 消息类型，如 `0x01` 业务数据、`0x10` PING、`0x11` PONG |
| Length | 2 字节 | **仅 Payload 的字节数**（不含帧头），无符号，最大 65535 |
| Payload | N 字节 | 业务数据 |

第七节实现请求-响应匹配时，会在此基础上扩展一个 8 字节的 `requestId` 字段；带 CRC 的版本见第八节。

---

## 二、LengthFieldBasedFrameDecoder 参数详解

**`LengthFieldBasedFrameDecoder` 通过帧头中的长度字段拆包，是处理私有协议最常用的基础组件。** 它的五个参数只描述一件事：长度字段在哪、多长、值代表什么、拆出来后要不要去掉帧头。

```java
new LengthFieldBasedFrameDecoder(
    maxFrameLength,     // 单帧最大字节数（按整帧计算），超过则抛 TooLongFrameException
    lengthFieldOffset,  // Length 字段距帧起始的偏移量
    lengthFieldLength,  // Length 字段自身占几个字节（1 / 2 / 3 / 4 / 8）
    lengthAdjustment,   // 对 Length 值的修正量，使"长度字段之后还剩多少字节"算得正确
    initialBytesToStrip // 拆出整帧后，从帧头丢弃多少字节（0 = 保留完整帧）
)
```

解码器内部计算整帧长度的公式是：

> **整帧长度 = lengthFieldOffset + lengthFieldLength + Length 字段的值 + lengthAdjustment**

也就是说，`lengthAdjustment` 的含义是："Length 字段之后实际还有多少字节" 与 "Length 字段的值" 之间的差。

**对应本文帧结构**（Magic 2 + Version 1 + Command 1 + Length 2，Length 仅描述 Payload 长度）：

```java
new LengthFieldBasedFrameDecoder(
    65535 + 6, // maxFrameLength：Payload 最大 65535 + 6 字节帧头
    4,         // lengthFieldOffset：前 4 字节是 Magic + Version + Command
    2,         // lengthFieldLength：Length 字段占 2 字节
    0,         // lengthAdjustment：Length 之后恰好就是 Payload，无需修正
    0          // initialBytesToStrip：保留完整帧，交给后续解码器解析帧头
)
```

**典型场景对照**：

| 场景 | offset | length | adjustment | strip | 说明 |
|------|--------|--------|------------|-------|------|
| Length 在最前，值不含自身 | 0 | 2 | 0 | 0 | 输出含长度头的完整帧 |
| Length 在最前，值不含自身，只要消息体 | 0 | 2 | 0 | 2 | 去掉 2 字节长度头 |
| Length 在最前，值**含**自身 2 字节 | 0 | 2 | -2 | 0 | 值多算了自身 2 字节，需减去 |
| Magic(2) + Length(2)，值不含帧头 | 2 | 2 | 0 | 0 | 跳过 2 字节魔数找长度 |
| 本文帧结构 | 4 | 2 | 0 | 0 | 长度之后即 Payload |
| 本文帧结构 + 末尾 CRC(2) | 4 | 2 | 2 | 0 | Length 不含 CRC，需补上 2 字节（IoT 实战用法） |
| 本文帧结构，Length 值为**整帧长度** | 4 | 2 | -6 | 0 | 值多算了 6 字节帧头，需减去 |

::: warning 常见错误
- `maxFrameLength` 比较的是**整帧长度**（含帧头），只按 Payload 上限设置会导致最大的合法消息被拒绝
- 2 字节长度字段按**无符号**读取，最大 65535；需要更大的消息请使用 4 字节长度字段
:::

---

## 三、编解码器体系

**Netty 的编解码器按"输入是什么、输出是什么"分成几类，选对基类能省掉大量样板代码。**

| 基类 | 方向 | 输入 → 输出 | 何时使用 |
|------|------|-----------|---------|
| `ByteToMessageDecoder` | 入站 | 字节流 → 消息 | 需要自己处理半包（自带累积缓冲区），如自写帧解码器 |
| `ReplayingDecoder<S>` | 入站 | 字节流 → 消息 | 写法像"数据总是够的"，不够时框架自动重试；简单但性能略差 |
| `MessageToMessageDecoder<I>` | 入站 | 消息 → 消息 | 输入已是完整帧，只做转换，如 **ByteBuf 帧 → POJO** |
| `MessageToByteEncoder<I>` | 出站 | 消息 → 字节 | 把 POJO 写成 ByteBuf，最常用的编码器基类 |
| `MessageToMessageEncoder<I>` | 出站 | 消息 → 消息 | 对象之间的转换，如 POJO → 字符串 |
| `ByteToMessageCodec<I>` | 双向 | 字节 ↔ 消息 | 编码和解码逻辑写在一个类里 |
| `MessageToMessageCodec<IN, OUT>` | 双向 | 消息 ↔ 消息 | 两种对象模型互转，如内部消息 ↔ HTTP 对象 |

Netty 也内置了大量现成的编解码器，能用就不要自己写：

| 内置组件 | 作用 |
|---------|------|
| `StringDecoder` / `StringEncoder` | ByteBuf 与 String 互转 |
| `LengthFieldBasedFrameDecoder` / `LengthFieldPrepender` | 长度字段拆帧 / 加长度头 |
| `ProtobufVarint32FrameDecoder` / `ProtobufVarint32LengthFieldPrepender` | Protobuf 常用的 varint 长度前缀拆帧 / 加长度头 |
| `ProtobufDecoder` / `ProtobufEncoder` | ByteBuf 与 Protobuf 消息互转 |

---

## 四、编码器

**编码器把 `ProtocolMessage` 按帧格式写入 ByteBuf，继承 `MessageToByteEncoder` 即可，分配和写出缓冲区都由框架处理。**

先定义协议消息对象（Magic 和 Length 由编解码器处理，不作为业务字段暴露）：

```java
@Data
@AllArgsConstructor
public class ProtocolMessage {
    public static final int  MAGIC    = 0xABCD;
    public static final byte CMD_DATA = 0x01; // 业务数据
    public static final byte CMD_PING = 0x10; // 心跳请求
    public static final byte CMD_PONG = 0x11; // 心跳响应

    private byte   version;
    private byte   command;
    private byte[] payload;
}
```

编码器：

```java
@ChannelHandler.Sharable // 无状态，可在所有连接间共享
public class ProtocolEncoder extends MessageToByteEncoder<ProtocolMessage> {

    @Override
    protected void encode(ChannelHandlerContext ctx,
                          ProtocolMessage msg, ByteBuf out) {
        byte[] payload = msg.getPayload();
        out.writeShort(ProtocolMessage.MAGIC);  // Magic
        out.writeByte(msg.getVersion());        // Version
        out.writeByte(msg.getCommand());        // Command
        out.writeShort(payload.length);         // Length：Payload 字节数
        out.writeBytes(payload);                // Payload
    }
}
```

---

## 五、解码器

**帧解码器已经保证每次交下来的是恰好一帧，所以协议解码器不必再处理半包，继承 `MessageToMessageDecoder<ByteBuf>` 最合适。** 它在 `decode` 返回后会自动释放输入的 ByteBuf。

```java
public class ProtocolDecoder extends MessageToMessageDecoder<ByteBuf> {

    private static final int MAX_PAYLOAD = 65535;

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf frame, List<Object> out) {
        // 1. 校验魔数：不是本协议的数据，直接断开
        int magic = frame.readUnsignedShort();
        if (magic != ProtocolMessage.MAGIC) {
            log.warn("非法魔数 0x{}，关闭连接 {}", Integer.toHexString(magic), ctx.channel().remoteAddress());
            ctx.close();
            return;
        }

        byte version = frame.readByte();
        byte command = frame.readByte();
        int length   = frame.readUnsignedShort(); // 无符号读取，范围 0~65535

        // 2. 校验长度：声明的长度必须与实际剩余字节一致
        if (length > MAX_PAYLOAD || length != frame.readableBytes()) {
            log.warn("长度字段异常 length={}, actual={}", length, frame.readableBytes());
            ctx.close();
            return;
        }

        // 3. 读取 Payload（复制为 byte[]，与 ByteBuf 的生命周期解耦）
        byte[] payload = new byte[length];
        frame.readBytes(payload);

        out.add(new ProtocolMessage(version, command, payload));
    }
}
```

改用这种写法的几个原因：

- **为什么不用 `ByteToMessageDecoder`**：它为半包设计，要自己判断数据够不够；帧已完整时用它不仅多余，还会额外维护一个累积缓冲区
- **为什么用 `readUnsignedShort`**：`readShort` 返回有符号数，Length 超过 32767 时会变成负数，`new byte[负数]` 直接抛异常
- **为什么魔数错误要关连接**：数据流已经错位，后续字节无法再对齐；若只是回退读指针并返回，这些字节会一直卡在缓冲区里
- **为什么要再校验长度**：帧解码器只保证"凑够了 Length 声明的字节数"，业务层对最大长度、字段一致性的校验仍是安全防线

::: tip
如果协议需要按字节"搜索"下一个魔数来重新同步（例如串口透传的 IoT 设备），可以用 `ByteToMessageDecoder` 自行实现跳字节同步，IoT 实战中的 `DeviceMessageDecoder` 就是这种写法，见第八节。
:::

---

## 六、Pipeline 组装

**Pipeline 的顺序决定了数据流经的路径：入站按添加顺序从前往后，出站按相反方向从后往前。** 推荐的组装顺序如下：

```java
public class ServerChannelInitializer extends ChannelInitializer<SocketChannel> {

    // 以下两个实例在所有连接间共享，必须是无状态且标注了 @Sharable 的 Handler
    private final ProtocolEncoder encoder = new ProtocolEncoder();
    private final ChannelHandler businessHandler;

    public ServerChannelInitializer(ChannelHandler businessHandler) {
        this.businessHandler = businessHandler;
    }

    @Override
    protected void initChannel(SocketChannel ch) {
        ChannelPipeline pipeline = ch.pipeline();

        // 1. 空闲检测：读空闲 60s 触发 IdleStateEvent（双向 Handler，放最前面，统计最准确）
        pipeline.addLast(new IdleStateHandler(60, 0, 0, TimeUnit.SECONDS));

        // 2. 拆帧：解决粘包 / 拆包（有状态，每个连接 new 一个）
        pipeline.addLast(new LengthFieldBasedFrameDecoder(65535 + 6, 4, 2, 0, 0));

        // 3. 协议解码：ByteBuf 帧 → ProtocolMessage
        pipeline.addLast(new ProtocolDecoder());

        // 4. 协议编码：ProtocolMessage → ByteBuf（出站）
        pipeline.addLast(encoder);

        // 5. 心跳：处理 PING / PONG 与空闲事件
        pipeline.addLast(new HeartbeatHandler());

        // 6. 业务处理
        pipeline.addLast(businessHandler);
    }
}
```

- **入站路径**：`IdleStateHandler → FrameDecoder → ProtocolDecoder → HeartbeatHandler → businessHandler`
- **出站路径**：业务 Handler 调用 `ctx.writeAndFlush()` 后向 Head 方向经过 `ProtocolEncoder → IdleStateHandler`，所以**编码器必须排在业务 Handler 前面**
- `ChannelInitializer` 本身已标注 `@Sharable`，同一个实例可以直接传给 `childHandler()`，无需再加注解
- `businessHandler` 作为共享实例，**必须标注 `@Sharable` 且不能持有连接相关的成员变量**；连接级数据放到 Channel 的 `AttributeKey` 中

传播方向与 `ctx.write` / `channel.write` 的区别见 [Pipeline 与 Handler](./5_pipeline_handler)。

::: tip 心跳保活
长连接必须配合心跳：客户端在写空闲时发送 PING，服务端回复 PONG，并在读空闲超时后关闭连接。`IdleStateHandler` 的参数选择、客户端与服务端的分工、断线重连等完整方案见 [心跳与连接管理](./9_heartbeat)。
:::

---

## 七、请求-响应匹配（RPC 的核心）

**一条连接上可以同时有很多请求在途，响应返回的顺序也不一定与请求一致；靠帧头里的 `requestId` 才能把每个响应交还给正确的调用方。** 这就是 Dubbo 等 RPC 框架"单连接多路复用"的基础。

### 1、扩展帧头

在示例帧的 Command 之后加入 8 字节 `requestId`，请求与对应的响应携带相同的 ID：

| Magic | Version | Command | RequestId | Length | Payload |
|-------|---------|---------|-----------|--------|---------|
| 2 | 1 | 1 | **8** | 2 | N |

此时 Length 字段的偏移量变为 12，帧解码器相应改为 `new LengthFieldBasedFrameDecoder(65535 + 14, 12, 2, 0, 0)`。

### 2、客户端：发送请求并登记 Future

```java
public class RpcClient {

    private final Channel channel;
    private final AtomicLong idGenerator = new AtomicLong();
    // 在途请求表：requestId → 等待结果的 Future
    private final Map<Long, CompletableFuture<RpcResponse>> pending = new ConcurrentHashMap<>();

    public CompletableFuture<RpcResponse> send(RpcRequest request, long timeoutMs) {
        long requestId = idGenerator.incrementAndGet();
        request.setRequestId(requestId);

        CompletableFuture<RpcResponse> future = new CompletableFuture<>();
        pending.put(requestId, future);

        // 超时控制（Java 9+ orTimeout）：到期未响应则以 TimeoutException 完成
        // 无论成功、失败、超时，最终都从在途表中移除
        future.orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
              .whenComplete((resp, ex) -> pending.remove(requestId));

        // 发送失败（如连接已断）立即结束该请求
        channel.writeAndFlush(request).addListener((ChannelFutureListener) f -> {
            if (!f.isSuccess()) {
                future.completeExceptionally(f.cause());
            }
        });
        return future;
    }

    /** 由响应 Handler 调用 */
    void onResponse(RpcResponse response) {
        CompletableFuture<RpcResponse> future = pending.remove(response.getRequestId());
        if (future != null) {
            future.complete(response); // 已超时被移除的响应直接丢弃
        }
    }

    /** 连接断开时，让所有在途请求快速失败 */
    void failAll(Throwable cause) {
        pending.values().forEach(f -> f.completeExceptionally(cause));
        pending.clear();
    }
}
```

### 3、客户端：响应 Handler

```java
public class RpcResponseHandler extends SimpleChannelInboundHandler<RpcResponse> {

    private final RpcClient client;

    public RpcResponseHandler(RpcClient client) {
        this.client = client;
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, RpcResponse response) {
        client.onResponse(response); // 按 requestId 找到 Future 并完成
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        client.failAll(new IOException("连接已断开"));
        ctx.fireChannelInactive();
    }
}
```

::: warning 回调运行在 EventLoop 线程
`future.complete()` 由响应 Handler 调用，因此调用方用 `thenApply` / `thenAccept` 注册的回调也会在 **EventLoop 线程**中执行。回调中有慢逻辑时，改用 `thenApplyAsync(fn, bizExecutor)` 切换到业务线程池。
:::

### 4、要点

- **ID 唯一性**：同一连接内唯一即可，`AtomicLong` 自增足够
- **必须有超时清理**：否则服务端不响应的请求会让在途表无限增长，造成内存泄漏
- **断线快速失败**：连接断开时立即让所有在途请求失败，不要让调用方干等到超时
- **服务端**：原样回写请求中的 `requestId`，可以并发处理、乱序返回

---

## 八、IoT 完整实战

上面是通用模板（无 CRC 校验）。面向 IoT 设备接入、带 **CRC16 校验**与跳字节重新同步的完整实现，包含 `DeviceMessage`、`DeviceMessageDecoder`、`CrcUtil` 和业务 Handler，见：

[Netty 接入网关](/iot/9_netty_gateway#二、带-crc-的私有协议帧)

---

## 小结

- 私有协议首选**长度字段**方案；帧头字段按需取舍：魔数、版本、类型、长度必备，RPC 还需请求 ID 与序列化方式
- `LengthFieldBasedFrameDecoder` 的核心公式：**整帧 = offset + length + Length 值 + adjustment**
- 帧已完整时用 `MessageToMessageDecoder` 解析；长度用无符号读取，魔数或长度非法时直接关闭连接
- Pipeline 按"空闲检测 → 拆帧 → 解码 → 编码 → 心跳 → 业务"组装，共享的 Handler 必须无状态并标注 `@Sharable`
- `requestId` + 在途 Future 表是 RPC 单连接多路复用的核心，务必做好超时与断线清理

> 下一篇：[心跳与连接管理](./9_heartbeat) —— 长连接如何发现"假死"的对端，以及断线后如何自动重连。

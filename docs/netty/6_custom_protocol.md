# 自定义私有协议

> TCP 是流式协议，没有消息边界。私有协议的核心是**定义帧格式**让接收方知道每条消息从哪里开始、到哪里结束。

---

## 一、帧格式设计

### 常见三种方案

| 方案 | 原理 | 适用场景 |
|------|------|---------|
| 固定长度 | 每帧字节数固定 | 消息大小一致，如传感器定时上报 |
| 分隔符 | 特定字节（`\n`、`0x00`）标识帧尾 | 纯文本协议，如 Redis RESP |
| 长度字段 | 帧头包含 Length 字段 | **通用推荐**，支持变长消息 |

### 典型帧结构（长度字段方案）

```
┌────────┬─────────┬─────────┬──────────────┬─────────┐
│ Magic  │ Version │ Command │    Length    │ Payload │
│ 2 byte │  1 byte │  1 byte │    2 bytes   │  N byte │
└────────┴─────────┴─────────┴──────────────┴─────────┘
```

| 字段 | 说明 |
|------|------|
| Magic | 魔数，固定值（如 `0xABCD`），用于快速识别帧边界和协议版本 |
| Version | 协议版本，支持未来扩展 |
| Command | 消息类型，区分不同业务（心跳、数据、控制指令等） |
| Length | **Payload 字节数**（不含帧头本身） |
| Payload | 业务数据，JSON 或二进制编码 |

> 需要数据完整性校验时，可在 Payload 后追加 2 字节 CRC16。

---

## 二、LengthFieldBasedFrameDecoder 参数详解

Netty 内置的帧解码器，**通过长度字段拆包**，是处理私有协议最常用的基础组件。

```java
new LengthFieldBasedFrameDecoder(
    maxFrameLength,     // 单帧最大字节数，防止内存溢出
    lengthFieldOffset,  // Length 字段距帧起始的偏移量
    lengthFieldLength,  // Length 字段自身占几个字节
    lengthAdjustment,   // Length 字段的值需要加减多少才等于 Payload 实际长度
    initialBytesToStrip // 解码后从帧头丢弃多少字节（0 = 保留完整帧）
)
```

**对应上面的帧结构**（Magic=2 + Version=1 + Command=1 + Length=2，Length 仅描述 Payload 长度）：

```java
new LengthFieldBasedFrameDecoder(
    65535,  // maxFrameLength：最大帧 64 KB
    4,      // lengthFieldOffset：前 4 字节是 Magic+Version+Command，Length 从偏移 4 开始
    2,      // lengthFieldLength：Length 字段占 2 字节
    0,      // lengthAdjustment：Length 值即 Payload 长度，不需调整
    0       // initialBytesToStrip：保留完整帧，由后续 Decoder 自行解析
)
```

**典型场景对照**：

| 场景 | offset | length | adjustment | strip |
|------|--------|--------|------------|-------|
| Length 在最前，值含自身 2 字节 | 0 | 2 | -2 | 0 |
| Length 在最前，值不含自身 | 0 | 2 | 0 | 0 |
| Magic(2)+Length(2)，值不含帧头 | 2 | 2 | 0 | 0 |
| 本文帧结构 | 4 | 2 | 0 | 0 |

---

## 三、编码器（MessageToByteEncoder）

```java
public class ProtocolEncoder extends MessageToByteEncoder<ProtocolMessage> {

    @Override
    protected void encode(ChannelHandlerContext ctx,
                          ProtocolMessage msg, ByteBuf out) {
        out.writeShort(msg.getMagic());    // Magic
        out.writeByte(msg.getVersion());   // Version
        out.writeByte(msg.getCommand());   // Command
        byte[] payload = msg.getPayload();
        out.writeShort(payload.length);    // Length
        out.writeBytes(payload);           // Payload
    }
}
```

---

## 四、解码器（ByteToMessageDecoder）

`LengthFieldBasedFrameDecoder` 完成拆包后，每次 `decode()` 收到的 `ByteBuf` 已是**恰好一帧**，无需再处理粘包/拆包：

```java
public class ProtocolDecoder extends ByteToMessageDecoder {

    private static final short MAGIC = (short) 0xABCD;

    @Override
    protected void decode(ChannelHandlerContext ctx,
                          ByteBuf in, List<Object> out) {
        in.markReaderIndex();

        short magic = in.readShort();
        if (magic != MAGIC) {
            ctx.fireExceptionCaught(
                new IllegalStateException("非法魔数: 0x" + Integer.toHexString(magic & 0xFFFF)));
            in.resetReaderIndex();
            return;
        }

        byte version = in.readByte();
        byte command = in.readByte();
        short length = in.readShort();
        byte[] payload = new byte[length];
        in.readBytes(payload);

        ProtocolMessage msg = new ProtocolMessage();
        msg.setMagic(magic);
        msg.setVersion(version);
        msg.setCommand(command);
        msg.setPayload(payload);
        out.add(msg);
    }
}
```

> 与 IoT 实战中的 `DeviceMessageDecoder` 相比，这里省去了 CRC 校验步骤。需要可靠性保障时参考 [Java IoT 实战 § 六](../iot/6_java_iot.md#六netty-自定义私有协议接入)。

---

## 五、Pipeline 组装

```java
@ChannelHandler.Sharable
public class ServerChannelInitializer
        extends ChannelInitializer<SocketChannel> {

    private final ChannelHandler businessHandler;

    @Override
    protected void initChannel(SocketChannel ch) {
        ChannelPipeline pipeline = ch.pipeline();

        // 1. 拆包（帧边界识别）
        pipeline.addLast(new LengthFieldBasedFrameDecoder(65535, 4, 2, 0, 0));

        // 2. 解码（ByteBuf → ProtocolMessage）
        pipeline.addLast(new ProtocolDecoder());

        // 3. 编码（ProtocolMessage → ByteBuf），@Sharable 可复用
        pipeline.addLast(new ProtocolEncoder());

        // 4. 心跳超时检测：读空闲 30s 触发 IdleStateEvent
        pipeline.addLast(new IdleStateHandler(30, 0, 0, TimeUnit.SECONDS));

        // 5. 业务处理
        pipeline.addLast(businessHandler);
    }
}
```

---

## 六、心跳保活

```java
public class HeartbeatHandler extends ChannelInboundHandlerAdapter {

    private static final byte CMD_PING = 0x10;
    private static final byte CMD_PONG = 0x11;

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
        if (evt instanceof IdleStateEvent idle) {
            if (idle.state() == IdleState.READER_IDLE) {
                // 超过 30s 无数据，关闭连接（服务端策略：由客户端发心跳）
                ctx.close();
            }
        } else {
            ctx.fireUserEventTriggered(evt);
        }
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        if (msg instanceof ProtocolMessage pm && pm.getCommand() == CMD_PING) {
            // 收到 PING，回复 PONG
            ProtocolMessage pong = new ProtocolMessage();
            pong.setMagic((short) 0xABCD);
            pong.setVersion((byte) 1);
            pong.setCommand(CMD_PONG);
            pong.setPayload(new byte[0]);
            ctx.writeAndFlush(pong);
            return;
        }
        ctx.fireChannelRead(msg);
    }
}
```

---

## IoT 完整实战

上面是通用模板（无 CRC 校验）。带 CRC16 校验的完整 IoT 设备接入实现，包含 `DeviceMessage`、`DeviceMessageDecoder`、`CrcUtil` 和业务 Handler，见：

[Java IoT 实战 → 六、Netty 自定义私有协议接入](../iot/6_java_iot.md#六netty-自定义私有协议接入)

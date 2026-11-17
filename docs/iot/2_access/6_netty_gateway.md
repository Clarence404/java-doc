---
description: 带 CRC 的私有协议帧、跳字节重新同步、首帧鉴权、设备路由与集群下行、多协议适配与统一消息
---

# Netty 接入网关

> 前置阅读：[自定义私有协议](/netty/8_custom_protocol)、[心跳与连接管理](/netty/9_heartbeat)

很多存量设备只会通过 TCP 发自定义二进制帧，平台需要自研接入网关维持长连接并统一协议。本篇讲 CRC 帧解码、首帧鉴权、设备路由与集群下行、多协议适配与统一消息，基线为 Netty 4.2。

---

## 一、网关的职责

典型存量设备如 DTU、充电桩、工控终端。本篇只讲 IoT 场景特有的部分，心跳、本机连接表、服务端启停这些通用写法在 [Netty 总览](/netty/0_overview) 模块，用到时给出链接；版本基线为 JDK 21、Netty 4.2、Spring Boot 4。

![多协议设备接入网关](../../assets/iot/iot-gateway-arch.svg)

| 职责 | 说明 |
|------|------|
| 协议适配 | 私有 TCP、MQTT、Modbus 等各用一个适配器，把原始数据翻译成统一的 `TelemetryMessage` |
| 连接管理 | 鉴权、心跳、重复登录处理，维护"设备 ID → 连接"的映射 |
| 上行转发 | 统一消息写入 Kafka，由下游做入库、规则计算，网关本身不做重业务 |
| 下行路由 | 平台下发指令时，找到设备所在的网关节点和连接并写出 |

网关是无状态的连接层：设备状态放在 [设备影子](../3_platform/3_device_shadow)，业务规则放在 [规则引擎](../3_platform/6_rule_engine)。这样网关节点可以随时扩缩容，节点故障时设备重连到其他节点即可。

---

## 二、带 CRC 的私有协议帧

`LengthFieldBasedFrameDecoder` 的参数、编解码器体系见 [自定义私有协议](/netty/8_custom_protocol)，`IdleStateHandler` 的原理见 [心跳与连接管理](/netty/9_heartbeat)。

### 1、帧格式

| 字段 | 字节数 | 说明 |
|------|--------|------|
| Magic | 2 | 固定 `0xABCD`，用于识别和重新对齐帧边界 |
| Version | 1 | 协议版本 |
| Command | 1 | `0x01` 鉴权、`0x02` 数据上报、`0x10` PING、`0x11` PONG、`0x20` 下行指令 |
| Length | 2 | 仅 Payload 的字节数，**无符号** |
| Payload | N | 业务数据，JSON 或 TLV 二进制 |
| CRC16 | 2 | CRC-16/MODBUS，覆盖 Version 到 Payload 的全部字节 |

与 [自定义私有协议](/netty/8_custom_protocol) 中的通用帧相比，多了一个 CRC 字段：设备经串口转 TCP 的 DTU 接入时，链路上可能出现噪声字节，TCP 自身的校验管不到串口那一段。

### 2、两种解码策略，不要混用

| 链路 | 推荐解码方式 | 遇到坏帧 |
|------|------------|---------|
| 设备直连 TCP，链路可靠 | `LengthFieldBasedFrameDecoder` 拆帧 + `MessageToMessageDecoder` 解析 | 魔数、长度或 CRC 不对就关闭连接，设备重连后重新对齐 |
| 串口透传（DTU），可能有噪声 | 单个 `ByteToMessageDecoder` 自己找帧头、校验 CRC | 丢 1 个字节，从下一个 `0xABCD` 重新同步；连续错误过多再断开 |

**不能把两者叠在一起**：`LengthFieldBasedFrameDecoder` 已经按长度切出一帧，后面的解码器再"跳 1 字节找帧头"毫无意义，帧内剩下的字节只会被当成垃圾继续解析。第一种写法见 Netty 模块，下面实现第二种。

### 3、重新同步解码器

```java
public record DeviceFrame(byte version, byte command, byte[] payload) {
    public static final byte CMD_AUTH = 0x01, CMD_DATA = 0x02, CMD_PING = 0x10, CMD_PONG = 0x11, CMD_DOWN = 0x20;
}

/** 有状态（错误计数），每个连接 new 一个，不能标注 @Sharable */
public class DeviceFrameDecoder extends ByteToMessageDecoder {

    static final int MAGIC = 0xABCD;
    static final int HEADER = 6;            // Magic 2 + Version 1 + Command 1 + Length 2
    static final int CRC_LEN = 2;
    static final int MAX_PAYLOAD = 4096;    // 按协议约定的上限，越小越能挡住伪造的长度
    static final int MAX_ERRORS = 32;

    private int consecutiveErrors;

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
        while (in.readableBytes() >= HEADER + CRC_LEN) {
            int start = in.readerIndex();
            if (in.getUnsignedShort(start) != MAGIC) {
                in.skipBytes(1);                                   // 不是帧头，前移 1 字节继续找
                continue;
            }
            int length = in.getUnsignedShort(start + 4);           // 无符号读取，0~65535
            if (length > MAX_PAYLOAD) {                            // 长度不合理：这个 0xABCD 不是真帧头
                if (!resync(ctx, in)) return;
                continue;
            }
            int frameLen = HEADER + length + CRC_LEN;
            if (in.readableBytes() < frameLen) {
                return;                                            // 半包，等更多数据
            }
            int expected = Crc16.modbus(in, start + 2, 4 + length);
            int actual = in.getUnsignedShort(start + HEADER + length);
            if (expected != actual) {
                if (!resync(ctx, in)) return;
                continue;
            }
            byte[] payload = new byte[length];
            in.getBytes(start + HEADER, payload);
            out.add(new DeviceFrame(in.getByte(start + 2), in.getByte(start + 3), payload));
            in.skipBytes(frameLen);
            consecutiveErrors = 0;
        }
    }

    /** 丢弃 1 字节重新寻找帧头；连续错误过多说明对端不是本协议，断开 */
    private boolean resync(ChannelHandlerContext ctx, ByteBuf in) {
        in.skipBytes(1);
        if (++consecutiveErrors > MAX_ERRORS) {
            in.skipBytes(in.readableBytes());
            ctx.close();
            return false;
        }
        return true;
    }
}
```

要点：

- 全程用 `getXxx(index)` 按绝对位置读取，确认整帧有效后才 `skipBytes` 移动读指针，不需要 `mark` / `reset`
- 长度用 `getUnsignedShort`，`readShort` 在长度超过 32767 时会得到负数，`new byte[负数]` 直接抛异常
- CRC 失败不再抛异常给后面的 Handler：抛异常通常导致 `exceptionCaught` 里关连接，一个坏帧就让设备掉线；错误次数应进监控，某台 DTU 的 CRC 错误率突然升高往往意味着现场线路有问题

### 4、CRC 与编码器

```java
public final class Crc16 {

    /** CRC-16/MODBUS：初值 0xFFFF，多项式 0xA001（反射） */
    public static int modbus(ByteBuf buf, int from, int length) {
        int crc = 0xFFFF;
        for (int i = from; i < from + length; i++) {
            crc ^= buf.getUnsignedByte(i);
            for (int k = 0; k < 8; k++) {
                crc = (crc & 1) != 0 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
            }
        }
        return crc & 0xFFFF;
    }
}

@ChannelHandler.Sharable   // 无状态，所有连接共享一个实例
public class DeviceFrameEncoder extends MessageToByteEncoder<DeviceFrame> {

    @Override
    protected void encode(ChannelHandlerContext ctx, DeviceFrame frame, ByteBuf out) {
        int start = out.writerIndex();
        out.writeShort(DeviceFrameDecoder.MAGIC);
        out.writeByte(frame.version());
        out.writeByte(frame.command());
        out.writeShort(frame.payload().length);
        out.writeBytes(frame.payload());
        out.writeShort(Crc16.modbus(out, start + 2, 4 + frame.payload().length));
    }
}
```

没有编码器时，业务代码 `writeAndFlush(pong)` 写出的是一个 Java 对象，Netty 无法发送，写操作以 `UnsupportedOperationException` 失败，设备永远收不到 PONG。**有出站消息就必须有对应的编码器**，并且排在业务 Handler 前面。

---

## 三、Pipeline、鉴权与心跳

### 1、Pipeline 组装

```java
@Component
public class DeviceChannelInitializer extends ChannelInitializer<SocketChannel> {

    private final DeviceFrameEncoder encoder = new DeviceFrameEncoder();
    private final EventExecutorGroup businessGroup = new DefaultEventExecutorGroup(16);
    private final HeartbeatHandler heartbeat;            // 以下四个依赖由构造器注入，构造器省略
    private final DeviceBusinessHandler business;
    private final DeviceAuthenticator authenticator;
    private final ChannelRegistry registry;

    @Override
    protected void initChannel(SocketChannel ch) {
        ch.pipeline()
          .addLast(new IdleStateHandler(180, 0, 0, TimeUnit.SECONDS))  // 心跳 60s，3 个周期没数据判定掉线
          .addLast(new DeviceFrameDecoder())                            // 有状态，每连接一个
          .addLast(encoder)
          .addLast(new AuthHandler(authenticator, registry))            // 有状态，鉴权成功后移除自己
          .addLast(heartbeat)
          .addLast(businessGroup, "business", business);                // 业务放到独立线程组
    }
}
```

`HeartbeatHandler`、`DeviceBusinessHandler` 是标注了 `@Component` 和 `@ChannelHandler.Sharable` 的无状态单例，由构造器注入；连接级数据放在 Channel 的 `AttributeKey` 里。心跳周期的取舍（IoT 设备常见 30 ~ 120 秒）和读空闲超时的计算方法见 [心跳与连接管理](/netty/9_heartbeat)。

### 2、鉴权：第一帧必须是 AUTH

```java
public class AuthHandler extends SimpleChannelInboundHandler<DeviceFrame> {

    private final DeviceAuthenticator authenticator;     // 每个连接 new 一个，构造器省略
    private final ChannelRegistry registry;

    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        // 10 秒内没完成鉴权就断开，防止空连接占用资源
        ctx.executor().schedule(() -> {
            if (ctx.pipeline().get(AuthHandler.class) != null) ctx.close();
        }, 10, TimeUnit.SECONDS);
        ctx.fireChannelActive();
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, DeviceFrame frame) {
        if (frame.command() != DeviceFrame.CMD_AUTH) {
            ctx.close();                                   // 未鉴权就发业务帧
            return;
        }
        // 载荷：deviceId、时间戳、HMAC-SHA256(设备密钥, deviceId|timestamp)，校验时间窗防重放
        authenticator.verify(frame.payload()).ifPresentOrElse(deviceId -> {
            registry.register(deviceId, ctx.channel());
            ctx.pipeline().remove(this);
        }, ctx::close);
    }
}
```

`DeviceAuthenticator` 只查本地缓存的设备密钥，不在 IO 线程上访问数据库；一机一密与证书认证的选择见 [设备安全](./1_security)。

### 3、心跳

`HeartbeatHandler` 与 Netty 模块的服务端心跳是同一种写法：收到 `CMD_PING` 回一帧 `CMD_PONG`（经 `DeviceFrameEncoder` 编码），其余帧原样向后传；读空闲超时就关闭连接。代码见 [心跳与连接管理 · 服务端：读空闲关闭 + 回复 PONG](/netty/9_heartbeat#_3、服务端-读空闲关闭-回复-pong)，把其中的 `ProtocolMessage` 换成 `DeviceFrame` 即可。

---

## 四、连接管理与下行路由

### 1、连接注册表

本机的「设备 ID → Channel」表与 [心跳与连接管理 · 连接管理](/netty/9_heartbeat#五、连接管理) 里的在线会话表是同一种写法：用 `AttributeKey` 把设备 ID 绑在 Channel 上，同一设备重复登录时踢掉旧连接，连接关闭时用两个参数的 `remove(deviceId, ch)` 只删自己，避免误删刚注册的新连接。网关多出来的是跨节点的路由：

```java
@Component
public class ChannelRegistry {

    private final ConcurrentHashMap<String, Channel> channels = new ConcurrentHashMap<>();
    private final DeviceRouteStore routes;   // Redis：device:route:{id} → 节点 ID，构造器注入（省略）

    public void register(String deviceId, Channel ch) {
        // 写本机映射、踢掉旧连接：同 Netty 模块的在线会话表（省略）
        routes.markOnline(deviceId);                         // 写入本节点 ID，带过期时间，心跳时续期
        ch.closeFuture().addListener(f -> {
            if (channels.remove(deviceId, ch)) {             // 删掉的确实是自己这条连接，才清路由
                routes.markOffline(deviceId);
            }
        });
    }

    public Optional<Channel> find(String deviceId) {
        return Optional.ofNullable(channels.get(deviceId)).filter(Channel::isActive);
    }
}
```

- **路由跟着本机映射走**：重连时新连接先注册、旧连接的关闭回调后触发，只有 `remove(deviceId, ch)` 返回 true 才清路由，否则会把新连接刚写的路由删掉
- **路由要续期**：`markOnline` 写入的记录带过期时间，每次心跳续一次；节点宕机来不及清理时，靠过期让设备被视为离线

### 2、集群下行

1. 平台下发指令时，先查 Redis 中 `device:route:{id}` 得到设备所在节点
2. 把指令投递到该节点专属的通道（Kafka 分区、MQTT Topic `gateways/{nodeId}/downlink` 或 RPC）
3. 节点从注册表找到 Channel，检查 `isWritable()` 后写出；不可写说明对端消费慢、出站缓冲已超过高水位，指令应拒绝或延后，而不是继续堆积

走 MQTT 接入的设备判断在线用的是另外几种做法，对照见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。写水位的配置与背压处理见 [生产实践与调优](/netty/12_production)。

---

## 五、多协议适配与统一消息

```java
/** 写进 Kafka 主题 iot.telemetry 的统一消息，JSON 序列化后字段名不变 */
public record TelemetryMessage(
        String deviceId,              // 鉴权通过后的设备 ID，同时是 Kafka 消息 Key
        String protocol,              // tcp / mqtt / modbus
        long timestamp,               // 毫秒；设备时间优先，没有时用网关接收时间
        Map<String, Object> metrics) {}   // 测点名 → 值，设备没报的测点不出现

@Component
public class TelemetrySink {

    private final KafkaTemplate<String, TelemetryMessage> kafka;   // 构造器注入（省略）

    public void accept(TelemetryMessage msg) {
        kafka.send("iot.telemetry", msg.deviceId(), msg);   // 按设备分区，保证单设备有序
    }
}
```

`TelemetryMessage` 是全模块唯一的遥测消息约定：字段含义、JSON 形状和设备侧的载荷格式写在 [遥测数据链路 · Topic 与消息约定](../3_platform/2_data#_1、topic-与消息约定)，读 `iot.telemetry` 的 Flink 作业与 [规则引擎](../3_platform/6_rule_engine) 都按它解析。时间戳用毫秒整数而不是 `Instant`，是为了让 EMQX 规则 SQL、Flink 和 Java 三方不依赖各自的时间序列化配置就能对上。

各适配器只依赖 `TelemetrySink`：私有协议适配器在 `DeviceBusinessHandler` 里把 `CMD_DATA` 帧的载荷解析成 `TelemetryMessage`；MQTT 这一路由订阅者转换，见 [MQTT 客户端 · 处理器](./3_mqtt_client#_5、处理器)，或直接用 EMQX 规则引擎转发；Modbus 采集服务把读数发到 MQTT，走的也是 MQTT 这一路，见 [Modbus 采集](./4_modbus)。新增协议就是新增一个适配器，下游不需要改动。

**为什么不用内存队列做总线**：用 `LinkedBlockingQueue` 在网关内部做消息总线有三个问题：进程重启时队列里的数据全部丢失；"队列满了先 `poll` 再 `offer`"不是原子操作，并发下仍会失败；单节点内存无法承受下游长时间故障。直接写 Kafka 获得持久化和削峰能力；需要断网续传的边缘网关，用本地磁盘队列缓冲，见 [边缘计算](../1_basics/4_edge)。Kafka 的配置与选型见 [消息队列总览](/messaging/0_overview)；规模不大、不想多运维一套 Kafka 时，用 Redis Streams 做总线的取舍见 [数据流水线 · 为什么是 Redis Streams 而不是 Kafka](../4_practice/4_pipeline#十、为什么是-redis-streams-而不是-kafka)。

---

## 六、服务端启停（Netty 4.2）

网关的服务端启停没有 IoT 特有的部分，照 Netty 模块的写法即可：Netty 4.2 中 `NioEventLoopGroup` 已标记为过时，线程组改用 `MultiThreadIoEventLoopGroup` 加 IO 处理器工厂创建，见 [生产实践与调优 · 线程模型配置](/netty/12_production#一、线程模型配置)；用 `SmartLifecycle` 管理启停，`start` 只等端口绑定完成，`stop` 先关监听端口、通知设备迁移，再关闭线程组，代码与完整的停机步骤见 [生产实践与调优 · 优雅停机](/netty/12_production#六、优雅停机)。要避开的旧写法是在 `ApplicationRunner.run` 里调用 `closeFuture().sync()`：它会让 Spring Boot 的启动线程一直阻塞，后面的 Runner 都不会执行，应用也永远不会进入"已启动"状态。网关这边要显式配置的只有两项：`SO_BACKLOG` 按设备集中重连的规模调大，`WRITE_BUFFER_WATER_MARK` 设好高低水位，第四节下行前的 `isWritable()` 检查靠的就是它。

---

## 小结

- 网关只做协议适配、连接管理和转发，状态放影子、规则放规则引擎，节点保持无状态
- 带 CRC 的帧有两种解码策略：可靠链路用长度字段拆帧、坏帧断开；DTU 透传用单个 `ByteToMessageDecoder` 找帧头、坏帧跳 1 字节重新同步；两者不要叠加
- 长度按无符号读取并设上限，CRC 失败计数而不是抛异常；有出站消息就必须配编码器
- 第一帧必须鉴权并设鉴权超时；注册表用 `remove(key, value)` 处理重复登录，路由记录写 Redis 并带过期时间
- 多协议统一成 `TelemetryMessage` 写入 Kafka，它是全模块唯一的遥测消息约定；心跳、本机连接表和服务端启停沿用 Netty 模块的写法

## 参考资料

- Netty 4.2 迁移说明：[https://netty.io/wiki/netty-4.2-migration-guide.html](https://netty.io/wiki/netty-4.2-migration-guide.html)
- Netty API 文档：[https://netty.io/4.2/api/index.html](https://netty.io/4.2/api/index.html)
- CRC 参数目录（CRC-16/MODBUS）：[https://reveng.sourceforge.io/crc-catalogue/16.htm](https://reveng.sourceforge.io/crc-catalogue/16.htm)

> 下一篇：[遥测数据链路](../3_platform/2_data)

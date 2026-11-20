---
description: 带流水号与 CRC 的私有帧、应答与重发、挑战鉴权、集群下行、国标帧对照、自研与现成网关取舍
---

# Netty 接入网关

> 前置阅读：[自定义私有协议](/netty/8_custom_protocol)、[心跳与连接管理](/netty/9_heartbeat)

很多存量设备只会通过 TCP 发自定义二进制帧，平台需要自研接入网关维持长连接并统一协议。本篇讲带流水号与应答的 CRC 帧、挑战式鉴权、设备路由与集群下行、多协议适配，以及自研与现成网关的取舍，基线为 Netty 4.2。

---

## 一、网关的职责

典型存量设备如 DTU、工控终端、只会厂家私有 TCP 协议的老式充电桩（充电桩的通行协议是 OCPP，EMQX 网关支持的 OCPP 1.6-J 跑在 WebSocket 上，新桩直接走 OCPP，不需要自研）。设备说的是标准协议时先看第七节的现成网关。本篇只讲 IoT 场景特有的部分，心跳、本机连接表、服务端启停这些通用写法在 [Netty 总览](/netty/0_overview) 模块，用到时给出链接；版本基线为 JDK 21、Netty 4.2、Spring Boot 4。

![多协议设备接入网关](../../assets/iot/iot-gateway-arch.svg)

| 职责 | 说明 |
|------|------|
| 协议适配 | 私有 TCP、MQTT 等每种接入方式一个适配器，把原始数据翻译成统一的 `TelemetryMessage`；Modbus 这类现场总线由采集服务轮询后以网关身份走 MQTT 进来 |
| 连接管理 | 鉴权、心跳、重复登录处理，维护"设备 ID → 连接"的映射 |
| 上行转发 | 统一消息写入 Kafka，由下游做入库、规则计算，网关本身不做重业务 |
| 下行路由 | 平台下发指令时，找到设备所在的网关节点和连接并写出 |

网关是无状态的连接层：设备状态放在 [设备影子](../3_platform/3_device_shadow)，业务规则放在 [规则引擎与告警](../3_platform/6_rule_engine)。这样网关节点可以随时扩缩容，节点故障时设备重连到其他节点即可。这里的网关是平台侧的接入层，和现场替子设备上报的边缘网关不是一回事，后者见 [网关与子设备](./5_gateway_subdevice)。

---

## 二、带 CRC 的私有协议帧

`LengthFieldBasedFrameDecoder` 的参数、编解码器体系见 [自定义私有协议](/netty/8_custom_protocol)，`IdleStateHandler` 的原理见 [心跳与连接管理](/netty/9_heartbeat)。

### 1、帧格式

| 字段 | 字节数 | 说明 |
|------|--------|------|
| Magic | 2 | 固定 `0xABCD`，用于识别和重新对齐帧边界 |
| Version | 1 | 协议版本 |
| Command | 1 | `0x01` AUTH 鉴权、`0x02` DATA 数据上报、`0x03` CHALLENGE 鉴权挑战、`0x10` PING、`0x11` PONG、`0x20` DOWN 下行指令、`0x80` ACK 通用应答 |
| Seq | 2 | 流水号，**无符号**；发送方每发一帧加 1，到 65535 后回到 0；应答帧原样带回被应答帧的 Seq |
| Length | 2 | 仅 Payload 的字节数，**无符号** |
| Payload | N | 业务数据，JSON 或 TLV 二进制 |
| CRC16 | 2 | CRC-16/MODBUS，覆盖 Version 到 Payload 的全部字节 |

多字节字段都是大端（高字节在前），CRC 也是；这和 Modbus RTU 把 CRC 低字节放在前面不同，只是算法同名。Payload 最长 4096 字节。

与 [自定义私有协议](/netty/8_custom_protocol) 中的通用帧相比，多了流水号和 CRC 两个字段。CRC 是因为设备经串口转 TCP 的 DTU 接入时，链路上可能出现噪声字节，TCP 自身的校验管不到串口那一段；流水号是为了应答。

**应答规则**：ACK 帧的 Seq 等于被应答帧的 Seq，载荷 2 字节——被应答的 Command 和结果码（`0` 成功、`1` 处理失败、`2` 鉴权失败、`3` 不支持的命令、`4` 格式错误）。

| 帧 | 谁回应 | 回什么 |
|----|--------|--------|
| CHALLENGE（平台 → 设备） | 设备 | 一帧 AUTH |
| AUTH | 平台 | ACK：成功，或「鉴权失败」后断开连接 |
| DATA | 平台 | 写入总线成功后回 ACK 成功；写入失败回 ACK 失败；载荷解析不了回「格式错误」 |
| DOWN（平台 → 设备） | 设备 | 执行后回 ACK，平台据此把指令标为已执行 |
| PING | 平台 | PONG，Seq 相同 |

有了流水号与应答，设备侧的重发与平台侧的去重才有依据：

- **设备重发**：DATA 发出后约 10 秒没收到同一 Seq 的 ACK（或收到「处理失败」），用**同一个 Seq** 重发，最多重试 3 次；仍不成功就缓存到本地，重连后补发。不能换新 Seq 重发，否则平台无法认出这是同一帧。收到「格式错误」则丢弃这一帧、不再重发：内容本身有问题，重发多少次结果都一样
- **平台去重**：网关按连接记住最近处理成功的若干个 Seq（下文示例为 64 个），重复到达的帧不再写总线、只补一个 ACK；跨重连的重复（设备在 ACK 丢失后断线重连再补发）网关认不出来，交给下游按「设备 ID + 采集时间」幂等
- **下行同理**：平台发 DOWN 时登记 Seq 与指令 ID 的对应关系，收到设备 ACK 再标记完成，超时未应答按指令的重试策略处理，见 [指令下发与服务调用](../3_platform/4_command)。DOWN 的载荷沿用 MQTT 指令的 `{"id","method","params"}`；设备回的 ACK 只带结果码，网关按 Seq 找回指令 ID，再按 `{"id","code","data"}` 的形状上报执行结果，指令服务不必区分设备走的是 MQTT 还是私有 TCP

### 2、两种解码策略，不要混用

| 链路 | 推荐解码方式 | 遇到坏帧 |
|------|------------|---------|
| 设备直连 TCP，链路可靠 | `LengthFieldBasedFrameDecoder` 拆帧（本帧为 `new LengthFieldBasedFrameDecoder(8 + 4096 + 2, 6, 2, 2, 0)`：最大帧长为帧头 8 + 载荷上限 4096 + CRC 2，长度字段跳过 Magic 到 Seq 的 6 字节、占 2 字节，`lengthAdjustment = 2` 补上末尾 CRC，不剥离帧头）+ `MessageToMessageDecoder` 解析 | 魔数、长度或 CRC 不对就关闭连接，设备重连后重新对齐 |
| 串口透传（DTU），可能有噪声 | 单个 `ByteToMessageDecoder` 自己找帧头、校验 CRC | 丢 1 个字节，从下一个 `0xABCD` 重新同步；连续错误过多再断开 |

**不能把两者叠在一起**：`LengthFieldBasedFrameDecoder` 已经按长度切出一帧，后面的解码器再"跳 1 字节找帧头"毫无意义，帧内剩下的字节只会被当成垃圾继续解析。第一种写法的拆帧与解析同 Netty 模块的 `ProtocolDecoder`（见 [自定义私有协议](/netty/8_custom_protocol)），只是解析时多一步 CRC 校验，校验失败就关闭连接；下面实现第二种。

### 3、重新同步解码器

```java
public record DeviceFrame(byte version, byte command, int seq, byte[] payload) {
    public static final byte VERSION = 1;
    public static final byte CMD_AUTH = 0x01, CMD_DATA = 0x02, CMD_CHALLENGE = 0x03,
            CMD_PING = 0x10, CMD_PONG = 0x11, CMD_DOWN = 0x20, CMD_ACK = (byte) 0x80;
    public static final byte RESULT_OK = 0, RESULT_FAILED = 1, RESULT_AUTH_FAILED = 2, RESULT_UNSUPPORTED = 3,
            RESULT_BAD_FORMAT = 4;

    /** 通用应答：Seq 取被应答帧的 Seq，载荷是被应答的命令字 + 结果码 */
    public static DeviceFrame ack(DeviceFrame request, byte result) {
        return new DeviceFrame(VERSION, CMD_ACK, request.seq(), new byte[] {request.command(), result});
    }
}

/** 有状态（错误计数），每个连接 new 一个，不能标注 @Sharable */
public class DeviceFrameDecoder extends ByteToMessageDecoder {

    static final int MAGIC = 0xABCD;
    static final int HEADER = 8;            // Magic 2 + Version 1 + Command 1 + Seq 2 + Length 2
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
            int length = in.getUnsignedShort(start + 6);           // 无符号读取，0~65535
            if (length > MAX_PAYLOAD) {                            // 长度不合理：这个 0xABCD 不是真帧头
                if (!resync(ctx, in)) return;
                continue;
            }
            int frameLen = HEADER + length + CRC_LEN;
            if (in.readableBytes() < frameLen) {
                return;                                            // 半包，等更多数据
            }
            int expected = Crc16.modbus(in, start + 2, HEADER - 2 + length);   // Version 起到 Payload 止
            int actual = in.getUnsignedShort(start + HEADER + length);
            if (expected != actual) {
                if (!resync(ctx, in)) return;
                continue;
            }
            byte[] payload = new byte[length];
            in.getBytes(start + HEADER, payload);
            out.add(new DeviceFrame(in.getByte(start + 2), in.getByte(start + 3),
                    in.getUnsignedShort(start + 4), payload));
            in.skipBytes(frameLen);
            consecutiveErrors = 0;
        }
    }

    /** 魔数对上了但长度或 CRC 不对：丢弃 1 字节重新寻找帧头，这样的错误连续太多就断开 */
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
- 不含魔数的字节是直接跳过的，不计入错误次数；从头到尾不发 `0xABCD` 的对端（端口扫描、发错协议的客户端）不会触发这里的断开，由下一节的鉴权超时关掉
- 噪声里恰好出现 `0xABCD` 且「长度」不超过 4096 时，解码器会一直等到攒够这么多字节才发现 CRC 不对，这期间后面的真帧被卡住；上报间隔很长的设备上这段等待可能很久，这是「跳字节重新同步」这种写法的固有局限
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
        if (frame.payload().length > DeviceFrameDecoder.MAX_PAYLOAD) {     // 超长的帧对端会当成坏帧，发之前就拦住
            throw new EncoderException("payload too large: " + frame.payload().length);
        }
        int start = out.writerIndex();
        out.writeShort(DeviceFrameDecoder.MAGIC);
        out.writeByte(frame.version());
        out.writeByte(frame.command());
        out.writeShort(frame.seq());
        out.writeShort(frame.payload().length);
        out.writeBytes(frame.payload());
        out.writeShort(Crc16.modbus(out, start + 2, DeviceFrameDecoder.HEADER - 2 + frame.payload().length));
    }
}
```

没有编码器时，业务代码 `writeAndFlush(pong)` 写出的是一个 Java 对象，Netty 无法发送，写操作以 `UnsupportedOperationException` 失败，设备永远收不到 PONG。**有出站消息就必须有对应的编码器**，并且排在业务 Handler 前面。本协议的出站消息有 CHALLENGE、ACK、PONG、DOWN 四种，都经它编码。

### 5、与 JT/T 808、GB/T 32960 对照

本篇的帧是示例约定。国内车载与新能源车场景有两份事实标准：道路运输车辆卫星定位终端用 JT/T 808，电动汽车远程监控用 GB/T 32960。三者逐字段对照如下：

| 项 | 本篇私有帧 | JT/T 808 | GB/T 32960 |
|----|-----------|----------|------------|
| 帧边界 | 起始魔数 `0xABCD` + 长度字段，没有结束符 | 首尾各一个标识位 `0x7e` | 起始符 `##`（2016 版）或 `$$`（2025 版）+ 数据单元长度 |
| 转义 | 无，靠长度与 CRC 重新同步 | 帧内 `0x7e` 写成 `0x7d 0x02`、`0x7d` 写成 `0x7d 0x01` | 无 |
| 消息类型 | Command，1 字节 | 消息 ID，2 字节；终端上行如 `0x0200` 位置信息汇报，平台下行都以 `0x8` 开头 | 命令标识 1 字节（`0x01` 车辆登入、`0x02` 实时信息上报、`0x03` 补发信息上报、`0x04` 车辆登出、`0x07` 心跳、`0x08` 终端校时）+ 应答标志 1 字节 |
| 设备标识 | 不在帧头，鉴权后绑定到连接 | 每帧消息头带终端手机号，BCD 码，2013 版 6 字节、2019 版 10 字节 | 每帧带 17 字节车辆识别码（VIN） |
| 流水号 | Seq，2 字节 | 消息流水号，2 字节 | 帧头没有；车辆登入的数据单元里带登入流水号 |
| 长度 | 2 字节，只算 Payload | 2 字节「消息体属性」的低 10 位 | 2 字节数据单元长度 |
| 分包 | 无 | 消息体属性里有分包位，分包时消息头多出总包数与包序号 | 无 |
| 加密 | 无，需要时靠 TLS | 消息体属性里 3 位加密标识 | 1 字节加密方式：`0x01` 不加密、`0x02` RSA、`0x03` AES-128，2025 版另有 SM2、SM4 |
| 校验 | CRC-16/MODBUS，2 字节，覆盖 Version 到 Payload | 1 字节异或，从消息头算到校验码前一字节，在转义还原之后计算 | 1 字节 BCC（异或），从命令单元算到校验码前一字节 |
| 应答 | `0x80` 通用应答，带回 Seq 与结果码 | 终端通用应答 `0x0001`、平台通用应答 `0x8001`，消息体带应答流水号、应答 ID 和结果 | 用同一个命令标识回包，应答标志 `0x01` 成功、`0x02` 错误、`0x03` VIN 重复；主动发起的命令包应答标志为 `0xFE` |
| 鉴权 | 平台下发 CHALLENGE，设备回 AUTH（第三节） | 首次 `0x0100` 注册，平台 `0x8100` 应答下发鉴权码；之后每次连接先发 `0x0102` 鉴权 | `0x01` 车辆登入 |

两份国标的标准原文需要购买，上表按 EMQX 开源的 JT/T 808 与 GB/T 32960 网关的帧解析实现及其数据交换格式文档逐字段核对（JT/T 808 覆盖 2013 与 2019 版，GB/T 32960 覆盖 2016 与 2025 版）。能看出的共同点有两条：国标都在每帧里带设备标识，平台不必依赖连接状态就能认出是谁；都有流水号或应答标志加通用应答，可靠性靠「应答 + 重发」而不是靠 TCP。本篇的帧在这两点上对齐了应答，设备标识则选择绑定在连接上，帧更短，代价是网关必须维护连接与设备的对应关系。设备说的就是这两种协议时，不需要按本篇自研，直接用第七节的现成网关。

---

## 三、Pipeline、鉴权与心跳

### 1、Pipeline 组装

```java
@Component
public class DeviceChannelInitializer extends ChannelInitializer<SocketChannel> {

    private final DeviceFrameEncoder encoder = new DeviceFrameEncoder();
    // 业务线程组声明成 Bean：@Bean(destroyMethod = "shutdownGracefully") new DefaultEventExecutorGroup(16)，随容器关闭
    private final EventExecutorGroup businessGroup;      // 以下五个依赖由构造器注入，构造器省略
    private final HeartbeatHandler heartbeat;
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

只校验「设备 ID + 时间戳 + HMAC」的鉴权帧可以被重放：攻击者在链路上截下一帧 AUTH，在时间窗内原样发到一条新连接上就能冒充设备，而且这个办法依赖设备时钟准。两种补法：

| 做法 | 防重放的原理 | 代价 |
|------|-------------|------|
| 服务端挑战（下面的示例） | 每条连接由平台下发一个新随机数，签名只对这条连接有效；不依赖设备时钟 | 建连多一个往返；载荷仍是明文，数据可以被窃听，CRC 也防不了篡改 |
| TLS（`SslHandler`） | 鉴权帧和之后的数据都在加密通道里，截不到也改不了 | 设备要有 TLS 协议栈和 CA 证书，MCU 的内存与握手耗时都要算；纯串口透传的 DTU 多半做不到 |

```java
public class AuthHandler extends SimpleChannelInboundHandler<DeviceFrame> {

    private static final SecureRandom RANDOM = new SecureRandom();
    private final DeviceAuthenticator authenticator;     // 每个连接 new 一个，构造器省略
    private final ChannelRegistry registry;
    private final byte[] nonce = new byte[16];           // 本连接的挑战值，只用这一次

    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        RANDOM.nextBytes(nonce);
        // 连上就下发挑战：设备必须用这次的随机数签名，截获的旧 AUTH 帧拿到新连接上无效
        ctx.writeAndFlush(new DeviceFrame(DeviceFrame.VERSION, DeviceFrame.CMD_CHALLENGE, 0, nonce.clone()));
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
        // 载荷：deviceId + HMAC-SHA256(设备密钥, deviceId|nonce)
        authenticator.verify(frame.payload(), nonce).ifPresentOrElse(deviceId -> {
            registry.register(deviceId, ctx.channel());
            ctx.writeAndFlush(DeviceFrame.ack(frame, DeviceFrame.RESULT_OK));
            ctx.pipeline().remove(this);
        }, () -> ctx.writeAndFlush(DeviceFrame.ack(frame, DeviceFrame.RESULT_AUTH_FAILED))
                    .addListener(ChannelFutureListener.CLOSE));   // 先告诉设备失败，再断开
    }
}
```

- **回应答再断开**：鉴权失败也回一帧 ACK，设备能区分「密钥错了」和「网络断了」，前者不该无限重试；鉴权失败要按来源 IP 计数限速，见下文第 5 小节
- **选 TLS 时**：10 秒的鉴权超时是从连接建立算起的，包含 TLS 握手，MCU 握手慢时要放宽；启动时建一次 `SslContext`，在 `initChannel` 里把 `sslContext.newHandler(ch.alloc())` 加在 Pipeline 最前面，后面的解码器拿到的就是解密后的字节；此时鉴权帧可以沿用简单的「设备 ID + 签名」，两种做法也可以叠加

`DeviceAuthenticator` 只查本地缓存的设备密钥，不在 IO 线程上访问数据库；`registry.register` 里写路由用的是异步的 Redis 客户端，方法立即返回，同样不阻塞 IO 线程；一机一密与证书认证的选择见 [设备安全](./1_security)。

### 3、心跳

`HeartbeatHandler` 与 Netty 模块的服务端心跳是同一种写法：收到 `CMD_PING` 回一帧 Seq 相同的 `CMD_PONG`（经 `DeviceFrameEncoder` 编码），其余帧原样向后传；读空闲超时就关闭连接。代码见 [心跳与连接管理 · 服务端：读空闲关闭 + 回复 PONG](/netty/9_heartbeat#_3、服务端-读空闲关闭-回复-pong)，照搬时改三处：

- 那边的 `HeartbeatServerHandler` 是每条连接 new 一个；这里要注入成单例，类上必须加 `@ChannelHandler.Sharable`，否则第二条连接加入 Pipeline 时就会抛异常
- 消息类型换成 `DeviceFrame`，PONG 写成 `new DeviceFrame(DeviceFrame.VERSION, DeviceFrame.CMD_PONG, ping.seq(), new byte[0])`
- 收到 PING 时顺带给这台设备的路由续期（异步写 Redis），见第四节；不续的话路由到期后，在线的设备会被当成离线

### 4、业务 Handler：DATA 应答与去重

心跳之后是业务 Handler：

```java
@Component
@ChannelHandler.Sharable
public class DeviceBusinessHandler extends SimpleChannelInboundHandler<DeviceFrame> {

    private static final AttributeKey<RecentSeqs> RECENT = AttributeKey.valueOf("recentSeqs");
    private final TelemetrySink sink;            // 以下三个依赖由构造器注入，构造器省略
    private final TelemetryParser parser;        // DATA 载荷 → TelemetryMessage，按协议约定实现
    private final CommandTracker commands;       // 下行指令的 Seq 与指令 ID 对应表

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, DeviceFrame frame) {
        String deviceId = ctx.channel().attr(ChannelRegistry.DEVICE_ID).get();
        switch (frame.command()) {
            case DeviceFrame.CMD_DATA -> onData(ctx, deviceId, frame);
            case DeviceFrame.CMD_ACK -> {                 // 设备对 DOWN 的应答：载荷是命令字 + 结果码
                if (frame.payload().length >= 2) {
                    commands.complete(deviceId, frame.seq(), frame.payload()[1]);
                }
            }
            default -> ctx.writeAndFlush(DeviceFrame.ack(frame, DeviceFrame.RESULT_UNSUPPORTED));
        }
    }

    private void onData(ChannelHandlerContext ctx, String deviceId, DeviceFrame frame) {
        RecentSeqs recent = ctx.channel().attr(RECENT).get();
        if (recent == null) {
            recent = new RecentSeqs(64);
            ctx.channel().attr(RECENT).set(recent);
        }
        if (recent.contains(frame.seq())) {              // 设备没收到 ACK 而重发的帧：已经写过，只补 ACK
            ctx.writeAndFlush(DeviceFrame.ack(frame, DeviceFrame.RESULT_OK));
            return;
        }
        TelemetryMessage message;
        try {
            message = parser.parse(deviceId, frame.payload());
        } catch (RuntimeException e) {
            // 载荷解析不了，重发也没用：回「格式错误」让设备丢弃这一帧，不让它进入重发和补发
            ctx.writeAndFlush(DeviceFrame.ack(frame, DeviceFrame.RESULT_BAD_FORMAT));
            return;
        }
        RecentSeqs seen = recent;
        sink.accept(message)
            .whenComplete((ok, ex) -> ctx.executor().execute(() -> {   // 回到本连接的线程再改状态
                if (ex == null) {
                    seen.add(frame.seq());
                }
                // 写入 Kafka 成功才回成功；失败回失败码，设备稍后用同一个 Seq 重发
                ctx.writeAndFlush(DeviceFrame.ack(frame, ex == null ? DeviceFrame.RESULT_OK : DeviceFrame.RESULT_FAILED));
            }));
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        ctx.close();   // 记日志后关闭连接；不重写的话异常只在 Pipeline 末尾打一条警告，连接留在不确定的状态
    }
}

/** 最近处理成功的流水号，固定容量，先进先出淘汰；只在所属连接的线程上访问 */
final class RecentSeqs {
    private final int capacity;
    private final ArrayDeque<Integer> order = new ArrayDeque<>();
    private final Set<Integer> seen = new HashSet<>();

    RecentSeqs(int capacity) { this.capacity = capacity; }

    boolean contains(int seq) { return seen.contains(seq); }

    void add(int seq) {
        if (seen.add(seq)) {
            order.addLast(seq);
            if (order.size() > capacity) seen.remove(order.removeFirst());
        }
    }
}
```

「写入总线成功才确认」与 MQTT 那一路的手动 ack 是同一个思路，失败时的完整处理见 [可靠上报与接入层主备 · 写入总线成功后才确认](../4_practice/3_reliable_uplink#四、transport-写入总线成功后才确认)。

### 5、接入层防护

网关直接面对公网设备，Pipeline 最前面还应有两道关：

- **单 IP 连接数与建连速率**：放一个共享的限流 Handler，按来源 IP 计数，超过上限直接关闭；设备直连时在 `channelActive` 里计数，经负载均衡时那一刻还不知道真实 IP，要等读到下一条说的 PROXY 头之后再计（NAT 后面挂着大量设备的 IP 要单独放宽）；全局建连速率用令牌桶限制每秒新连接数，鉴权失败也按 IP 计数，连续失败的 IP 临时拉黑。这样批量重连或恶意建连时，压力停在接入层，不会打到鉴权和 Redis
- **负载均衡后取真实 IP**：经四层负载均衡转发后，网关看到的来源地址是负载均衡器的，上面的限流和审计就全错了。在负载均衡器上开启 PROXY protocol，网关 Pipeline 最前面加 Netty 的 `HAProxyMessageDecoder`（`netty-codec-haproxy` 模块），从它解出的 `HAProxyMessage` 取 `sourceAddress()` 存进 Channel 属性，再交给限流与审计；`HAProxyMessage` 是引用计数对象，取完地址要 `release()`。负载均衡器没开 PROXY protocol 时不能加这个解码器，否则设备的第一帧会被当成 PROXY 头解析失败

限流阈值怎么定、重连风暴时服务端与设备端各自怎么退让，见 [海量连接与连接风暴](./7_connection_storm)。

---

## 四、连接管理与下行路由

### 1、连接注册表

本机的「设备 ID → Channel」表与 [心跳与连接管理 · 连接管理](/netty/9_heartbeat#五、连接管理) 里的在线会话表是同一种写法：用 `AttributeKey` 把设备 ID 绑在 Channel 上，同一设备重复登录时踢掉旧连接，连接关闭时用两个参数的 `remove(deviceId, ch)` 只删自己，避免误删刚注册的新连接。网关多出来的是跨节点的路由：

```java
@Component
public class ChannelRegistry {

    public static final AttributeKey<String> DEVICE_ID = AttributeKey.valueOf("deviceId");   // 鉴权成功后绑到 Channel 上
    private final ConcurrentHashMap<String, Channel> channels = new ConcurrentHashMap<>();
    private final DeviceRouteStore routes;   // Redis：device:route:{id} → 节点 ID，构造器注入（省略）

    public void register(String deviceId, Channel ch) {
        // 写本机映射、踢掉旧连接：同 Netty 模块的在线会话表（省略）
        routes.markOnline(deviceId);                         // 写入本节点 ID，带过期时间，心跳时续期
        ch.closeFuture().addListener(f -> {
            if (channels.remove(deviceId, ch)) {             // 删掉的确实是自己这条连接，才清路由
                routes.removeIfMine(deviceId);           // 路由里记的还是本节点才删，见下文
            }
        });
    }

    public Optional<Channel> find(String deviceId) {
        return Optional.ofNullable(channels.get(deviceId)).filter(Channel::isActive);
    }
}
```

- **路由跟着本机映射走**：重连时新连接先注册、旧连接的关闭回调后触发，只有 `remove(deviceId, ch)` 返回 true 才清路由，否则会把新连接刚写的路由删掉
- **清路由要比较着删**：上一条只防住了重连到同一个节点。设备经负载均衡重连到另一个节点时，旧节点上那条半开的连接要等 180 秒读空闲才关闭，那时它在本机的 `remove` 照样返回 true；无条件删路由会把新节点写的记录删掉。所以 `removeIfMine` 在 Redis 里用脚本做「值等于本节点 ID 才删除」
- **路由读写不占 IO 线程**：`register` 和关闭回调都跑在 EventLoop 上，`DeviceRouteStore` 用异步的 Redis 客户端，方法立即返回
- **路由要续期**：`markOnline` 写入的记录带过期时间，心跳 Handler 每收到一次 PING 续一次；节点宕机来不及清理时，靠过期让设备被视为离线

### 2、集群下行

1. 平台下发指令时，先查 Redis 中 `device:route:{id}` 得到设备所在节点
2. 把指令投递到该节点专属的通道（Kafka 分区、MQTT Topic `gateways/{nodeId}/downlink` 或 RPC）
3. 节点从注册表找到 Channel，检查 `isWritable()` 后写出一帧 DOWN，并登记它的 Seq；不可写说明对端消费慢、出站缓冲已超过高水位，指令应拒绝或延后，而不是继续堆积
4. 设备执行后回 ACK，节点按 Seq 找到指令、上报执行结果；超时未应答由指令服务决定重发还是置为失败，见 [指令下发与服务调用](../3_platform/4_command)

走 MQTT 接入的设备判断在线用的是另外几种做法，对照见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。写水位的配置与背压处理见 [生产实践与调优](/netty/12_production)。

---

## 五、多协议适配与统一消息

```java
/** 写进 Kafka 主题 iot.telemetry 的统一消息，JSON 序列化后字段名不变 */
public record TelemetryMessage(
        String deviceId,              // 鉴权通过后的设备 ID，同时是 Kafka 消息 Key
        String protocol,              // 消息进入平台的方式：tcp（本篇的私有协议）/ mqtt
        long timestamp,               // 毫秒；设备时间优先，没有时用网关接收时间
        Map<String, Object> metrics) {}   // 测点名 → 值，设备没报的测点不出现

@Component
public class TelemetrySink {

    private final KafkaTemplate<String, TelemetryMessage> kafka;   // 构造器注入（省略）

    /** 返回写入结果，调用方据此决定向设备回 ACK 成功还是失败 */
    public CompletableFuture<?> accept(TelemetryMessage msg) {
        return kafka.send("iot.telemetry", msg.deviceId(), msg);   // 按设备分区，保证单设备有序
    }
}
```

`TelemetryMessage` 是 Broker 与接入网关**之后**的内部信封，不是设备协议：MQTT 设备上报的是 `{"ts", "values"}`，私有协议设备上报的是 DATA 帧，网关与采集器上报的是按子设备分组的 `gateways/{gatewayId}/telemetry`，三者都在接入层转成它，设备侧的 `values` 对应它的 `metrics`。它是全模块唯一的遥测内部消息：字段含义、JSON 形状和设备侧的载荷格式写在 [遥测数据链路 · Topic 与消息约定](../3_platform/2_data#_1、topic-与消息约定)，读 `iot.telemetry` 的 Flink 作业与 [规则引擎与告警](../3_platform/6_rule_engine) 都按它解析。时间戳用毫秒整数而不是 `Instant`，是为了让 EMQX 规则 SQL、Flink 和 Java 三方不依赖各自的时间序列化配置就能对上。

各适配器只依赖 `TelemetrySink`：私有协议适配器在 `DeviceBusinessHandler` 里把 `CMD_DATA` 帧的载荷解析成 `TelemetryMessage`；MQTT 这一路由订阅者转换，见 [MQTT 客户端 · 处理器](./3_mqtt_client#_5、处理器)，或直接用 EMQX 规则引擎转发；Modbus 采集服务以网关身份把读数发到 `gateways/{gatewayId}/telemetry`，拆成每台子设备一条之后走的也是 MQTT 这一路，见 [Modbus 采集](./4_modbus) 与 [网关与子设备](./5_gateway_subdevice)。新增协议就是新增一个适配器，下游不需要改动。

**为什么不用内存队列做总线**：用 `LinkedBlockingQueue` 在网关内部做消息总线有三个问题：进程重启时队列里的数据全部丢失；"队列满了先 `poll` 再 `offer`"不是原子操作，并发下仍会失败；单节点内存无法承受下游长时间故障。直接写 Kafka 获得持久化和削峰能力；需要断网续传的边缘网关，用本地磁盘队列缓冲，见 [边缘计算](../1_basics/4_edge)。Kafka 的配置与选型见 [消息队列总览](/messaging/0_overview)；规模不大、不想多运维一套 Kafka 时，用 Redis Streams 做总线的取舍见 [数据流水线 · 为什么是 Redis Streams 而不是 Kafka](../4_practice/4_pipeline#十、为什么是-redis-streams-而不是-kafka)。

---

## 六、服务端启停（Netty 4.2）

网关的服务端启停没有 IoT 特有的部分，照 Netty 模块的写法即可：Netty 4.2 中 `NioEventLoopGroup` 已标记为过时，线程组改用 `MultiThreadIoEventLoopGroup` 加 IO 处理器工厂创建，见 [生产实践与调优 · 线程模型配置](/netty/12_production#一、线程模型配置)；用 `SmartLifecycle` 管理启停，`start` 只等端口绑定完成，`stop` 先关监听端口、通知设备迁移，再关闭线程组，代码与完整的停机步骤见 [生产实践与调优 · 优雅停机](/netty/12_production#六、优雅停机)。要避开的旧写法是在 `ApplicationRunner.run` 里调用 `closeFuture().sync()`：它会让 Spring Boot 的启动线程一直阻塞，后面的 Runner 都不会执行，应用也永远不会进入"已启动"状态。网关这边要显式配置的只有两项：`SO_BACKLOG` 按设备集中重连的规模调大，`WRITE_BUFFER_WATER_MARK` 设好高低水位，第四节下行前的 `isWritable()` 检查靠的就是它。

---

## 七、自研还是用现成网关

本篇的自研网关不是唯一选择。设备说的是标准协议时，先看现成的：

| 方案 | 能接什么 | 适合 | 注意 |
|------|---------|------|------|
| EMQX 多协议网关 | 内置 MQTT-SN、STOMP、CoAP、LwM2M、OCPP、GB/T 32960、JT/T 808、NATS；接进来的设备在 EMQX 里就是普通客户端，复用认证、授权和规则引擎 | 设备说的是这些标准协议 | 用 gRPC 外挂自定义协议的 ExProto 网关在 6.2.0 弃用、6.3.0 已移除，私有协议在 EMQX 6.3 及以后没法再挂到 EMQX 上，这是在 6.3+ 上自研网关的正当理由 |
| JetLinks 协议包 | 把私有协议的编解码写成 jar 加载到平台，官方模板同时实现了 MQTT、HTTP、TCP、UDP 四种接入 | 平台本身选了 JetLinks | 协议包依赖的核心库版本要与平台一致，见 [平台选型 · JetLinks 协议包](../1_basics/2_platform#六、jetlinks-协议包) |
| ThingsBoard IoT Gateway | Socket 连接器在网关上起 TCP / UDP 服务端，按字节区间从原始载荷里切出测点；另有 OCPP、Modbus 等连接器 | 平台是 ThingsBoard，帧结构简单固定 | 只能按固定字节区间取值，变长 TLV、分包、应答与重发要写自定义连接器 |
| 云厂商协议网关 | 阿里云物联网平台有 JT/T 808（2019 版）与 GB/T 32960 云网关（该平台 2025 年 2 月起已停止新购，只对存量实例有意义）；华为云 IoTDA 的泛协议接入可以开通用 TCP 端口，配置拆帧规则（分隔符、定长或长度字段）和编解码插件 | 平台就是这家云 | 阿里云的 JT/T 808 云网关只在企业版实例和部分地域可用；编解码要按平台的插件规范写 |
| 自研 Netty 网关（本篇） | 任何协议 | 厂家私有协议；要和自有平台的鉴权、总线、设备台账深度集成 | 连接管理、限流、集群下行、协议升级都要自己维护 |

判断顺序：标准协议（OCPP、JT/T 808、GB/T 32960、LwM2M 等）直接用现成网关；私有协议先看所用平台有没有协议插件机制；两者都不满足，或者对确认时机、背压、路由有自己的要求时，才自研。

---

## 小结

- 网关只做协议适配、连接管理和转发，状态放影子、规则放规则引擎，节点保持无状态
- 帧里要有流水号和通用应答：AUTH 成功失败都回帧，DATA 写入总线成功才回 ACK，设备没等到 ACK 就用同一个流水号重发，网关按流水号去重
- 带 CRC 的帧有两种解码策略：可靠链路用长度字段拆帧、坏帧断开；DTU 透传用单个 `ByteToMessageDecoder` 找帧头、坏帧跳 1 字节重新同步；两者不要叠加
- 长度按无符号读取并设上限，CRC 失败计数而不是抛异常；有出站消息就必须配编码器
- 第一帧必须鉴权并设鉴权超时；用服务端挑战或 TLS 防止鉴权帧被重放；接入层按 IP 限连接数与建连速率，负载均衡之后用 PROXY protocol 取真实 IP
- 注册表用 `remove(key, value)` 处理重复登录，路由记录写 Redis 并带过期时间，心跳时续期，清理时只删记着本节点的那一条
- 多协议统一成 `TelemetryMessage` 写入 Kafka，它是接入层之后的内部信封，不是设备协议；心跳、本机连接表和服务端启停沿用 Netty 模块的写法
- 标准协议（OCPP、JT/T 808、GB/T 32960 等）优先用 EMQX 多协议网关或云厂商网关；EMQX 6.3 移除 ExProto 之后，私有协议才是自研网关的主要场景

## 参考资料

- Netty 4.2 迁移说明：[https://netty.io/wiki/netty-4.2-migration-guide.html](https://netty.io/wiki/netty-4.2-migration-guide.html)
- Netty API 文档：[https://netty.io/4.2/api/index.html](https://netty.io/4.2/api/index.html)
- CRC 参数目录（CRC-16/MODBUS）：[https://reveng.sourceforge.io/crc-catalogue/16.htm](https://reveng.sourceforge.io/crc-catalogue/16.htm)
- Netty HAProxyMessageDecoder：[https://netty.io/4.2/api/io/netty/handler/codec/haproxy/HAProxyMessageDecoder.html](https://netty.io/4.2/api/io/netty/handler/codec/haproxy/HAProxyMessageDecoder.html)
- EMQX 多协议网关（含 ExProto 弃用与移除说明）：[https://docs.emqx.com/en/emqx/latest/gateway/gateway.html](https://docs.emqx.com/en/emqx/latest/gateway/gateway.html)
- EMQX 6.3 不兼容变更（ExProto 移除）：[https://docs.emqx.com/en/emqx/latest/changes/breaking-changes-6.3.html](https://docs.emqx.com/en/emqx/latest/changes/breaking-changes-6.3.html)
- EMQX JT/T 808 网关与数据交换格式：[https://docs.emqx.com/en/emqx/latest/gateway/jt808.html](https://docs.emqx.com/en/emqx/latest/gateway/jt808.html)、[https://docs.emqx.com/en/emqx/latest/gateway/jt808_data_exchange.html](https://docs.emqx.com/en/emqx/latest/gateway/jt808_data_exchange.html)
- EMQX GB/T 32960 网关与数据交换格式：[https://docs.emqx.com/en/emqx/latest/gateway/gbt32960.html](https://docs.emqx.com/en/emqx/latest/gateway/gbt32960.html)、[https://docs.emqx.com/en/emqx/latest/gateway/gbt32960_data_exchange.html](https://docs.emqx.com/en/emqx/latest/gateway/gbt32960_data_exchange.html)
- EMQX JT/T 808 帧解析实现：[https://github.com/emqx/emqx/blob/master/apps/emqx_gateway_jt808/src/emqx_jt808_frame.erl](https://github.com/emqx/emqx/blob/master/apps/emqx_gateway_jt808/src/emqx_jt808_frame.erl)
- EMQX GB/T 32960 帧解析实现：[https://github.com/emqx/emqx/blob/master/apps/emqx_gateway_gbt32960/src/emqx_gbt32960_frame.erl](https://github.com/emqx/emqx/blob/master/apps/emqx_gateway_gbt32960/src/emqx_gbt32960_frame.erl)
- EMQX OCPP 网关：[https://docs.emqx.com/en/emqx/latest/gateway/ocpp.html](https://docs.emqx.com/en/emqx/latest/gateway/ocpp.html)
- ThingsBoard IoT Gateway Socket 连接器：[https://thingsboard.io/docs/iot-gateway/config/socket/](https://thingsboard.io/docs/iot-gateway/config/socket/)
- 阿里云 JT/T 808 协议云网关：[https://help.aliyun.com/zh/iot/user-guide/jt-or-t-808-gateways](https://help.aliyun.com/zh/iot/user-guide/jt-or-t-808-gateways)
- 阿里云 GB/T 32960 协议云网关：[https://www.alibabacloud.com/help/zh/iot/user-guide/gb-t-32960-cloud-gateway-overview](https://www.alibabacloud.com/help/zh/iot/user-guide/gb-t-32960-cloud-gateway-overview)
- 华为云 IoTDA 创建泛协议配置：[https://support.huaweicloud.com/api-iothub/CreateProtocolConfig.html](https://support.huaweicloud.com/api-iothub/CreateProtocolConfig.html)

> 下一篇：[海量连接与连接风暴](./7_connection_storm) —— 设备退避与抖动、负载均衡、EMQX 限速、内核调优、认证与会话恢复。

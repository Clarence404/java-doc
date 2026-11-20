---
description: 寄存器与功能码、TCP 与 RTU、digitalpetri modbus、点表与字节序、网关代报、现成采集软件选型
---

# Modbus 采集

> 前置阅读：[通信协议](../1_basics/1_protocol)

PLC、电表、变频器这类工业设备大多只会说 Modbus，平台侧由采集服务充当主站周期轮询。本篇讲 TCP 与 RTU 采集、点表与数值解码、以网关身份代子设备上报、自写与现成采集软件的取舍，基线为 JDK 21。

---

## 一、采集需要掌握的协议细节

Modbus 是主从协议：主站（采集服务、边缘网关、上位机）发起请求，从站（仪表、PLC）只应答，同一链路上的从站用单元 ID（RTU 里叫从站地址）区分。采集服务周期轮询从站寄存器，换算成工程量后以网关身份上报 MQTT。示例库为 digitalpetri modbus 2.2.0，备选 j2mod 3.4.0。

### 1、四类数据区

| 数据区 | 读写 | 读功能码 | 写功能码 | 典型内容 |
|--------|------|---------|---------|---------|
| 线圈（Coils） | 读写，1 bit | 0x01 | 0x05 / 0x0F | 继电器、开关量输出 |
| 离散输入（Discrete Inputs） | 只读，1 bit | 0x02 | 无 | 门磁、限位开关 |
| 输入寄存器（Input Registers） | 只读，16 bit | 0x04 | 无 | 传感器测量值 |
| 保持寄存器（Holding Registers） | 读写，16 bit | 0x03 | 0x06 / 0x10 | 测量值、设定值、参数 |

厂家手册常用 `40001` 这类"5 位地址"表示保持寄存器第 1 个，协议报文里的地址却是从 0 开始的偏移。**`40001` 对应请求地址 0**，读错一位得到的是相邻寄存器的值，而且不会报错。

### 2、TCP 与 RTU

| 维度 | Modbus TCP | Modbus RTU |
|------|-----------|-----------|
| 链路 | 以太网，默认端口 502 | RS-485 / RS-232 串口 |
| 帧格式 | MBAP 头（事务 ID、协议 ID、长度、单元 ID）+ PDU | 从站地址 + PDU + CRC16 |
| 并发 | 一个连接上可有多个在途请求（靠事务 ID 匹配），但很多从站只处理串行请求 | 半双工总线，同一时刻只能有一个请求 |
| 帧边界 | 由 MBAP 长度字段界定 | 靠 3.5 个字符时间的静默间隔 |
| 常见问题 | 从站允许的并发连接数很少 | 波特率、校验位不匹配；总线上一个设备超时会拖慢整条总线 |

还有一种常见形态是 **RTU over TCP**：现场的串口设备接一个 DTU（串口服务器），DTU 把 RTU 帧原样透传到 TCP。这时报文仍带 CRC、没有 MBAP 头，要用 RTU 编解码跑在 TCP 连接上。

---

## 二、库选型

| 库 | 最新版本 | JDK | 特点 |
|----|---------|-----|------|
| digitalpetri modbus | 2.2.0（2026-11） | 17+ | 基于 Netty，同步与异步 API，支持 TCP、RTU（串口）、RTU over TCP、TLS，客户端与服务端都有 |
| j2mod | 3.4.0（2026-09） | 8+ | 同步 API，支持 TCP、UDP、RTU、ASCII，资料多，存量项目常见 |

新项目推荐 digitalpetri modbus：连接由传输层维护，断线自动重连，异步 API 适合同时采集大量从站。只能用 JDK 8 的存量项目继续用 j2mod，但同样要改成长连接。

从 2.1.x 升到 2.2.0 有几处不兼容，本篇示例已按 2.2.0 写：

- **断线不再等到超时**：连接断开时在途请求立刻以 `ModbusConnectionLostException` 失败，向未连接的传输层发请求以 `ModbusNotConnectedException` 失败；同步调用把它们包成 `ModbusExecutionException` 抛出。2.1.x 里断线表现为 `ModbusTimeoutException`，按超时写的告警与重试逻辑要改
- **响应会被校验**：返回的 PDU 解不出来或和请求对不上（例如功能码不符）时以 `ModbusMalformedResponseException` 失败；越界的地址、数量在发送前就以 `IllegalArgumentException` 拒绝
- **RTU 客户端一次只发一个请求**：后面的请求在客户端排队，排队期间就超时的请求以 `QueuedRequestTimeoutException` 失败，它从没发出去，可以放心重试。异步接口直接拿到这个异常；同步调用抛的仍是 `ModbusTimeoutException`，它在 `getCause()` 里
- **API 变化**：`WriteSingleRegisterRequest.value()` 改为返回 `byte[]`（两个 int 参数的构造器保留）；`ModbusClientConfig` 和串口的 `SerialPortTransportConfig` 都加了字段，旧的全参构造器不能用了，改用 `create(cfg -> …)` 或 Builder，本篇示例本来就是这种写法

```xml
<!-- Modbus TCP 与 RTU over TCP -->
<dependency>
    <groupId>com.digitalpetri.modbus</groupId>
    <artifactId>modbus-tcp</artifactId>
    <version>2.2.0</version>
</dependency>
<!-- Modbus RTU 串口，依赖 jSerialComm -->
<dependency>
    <groupId>com.digitalpetri.modbus</groupId>
    <artifactId>modbus-serial</artifactId>
    <version>2.2.0</version>
</dependency>
```

---

## 三、Modbus TCP 采集

### 1、建立长连接

每次轮询都新建、关闭 TCP 连接是最常见的错误写法：建连本身有开销，而且不少 PLC 只允许几个并发连接，频繁建连会触发从站拒绝或进入保护状态。正确做法是每个 TCP 端点一条长连接（端点是一台从站，或一个后面挂着多台从站的 DTU，同一个端点下靠单元 ID 区分），断线由传输层自动重连。

```java
import com.digitalpetri.modbus.client.ModbusTcpClient;
import com.digitalpetri.modbus.tcp.client.NettyTcpClientTransport;

import java.time.Duration;

public final class ModbusTcpSource implements AutoCloseable {

    private final ModbusTcpClient client;

    public ModbusTcpSource(String host, int port) throws Exception {
        var transport = NettyTcpClientTransport.create(cfg -> cfg
                .setHostname(host)
                .setPort(port)                              // 默认 502
                .setConnectTimeout(Duration.ofSeconds(3))
                .setConnectPersistent(true));               // 默认即为 true：断开后按 1、2、4…32 秒退避重连
        this.client = ModbusTcpClient.create(transport,
                cfg -> cfg.setRequestTimeout(Duration.ofSeconds(2)));
        client.connect();
    }

    public ModbusTcpClient client() {
        return client;
    }

    @Override
    public void close() throws Exception {
        client.disconnect();
    }
}
```

### 2、读取保持寄存器

```java
import com.digitalpetri.modbus.exceptions.ModbusConnectionLostException;
import com.digitalpetri.modbus.exceptions.ModbusExecutionException;
import com.digitalpetri.modbus.exceptions.ModbusMalformedResponseException;
import com.digitalpetri.modbus.exceptions.ModbusNotConnectedException;
import com.digitalpetri.modbus.exceptions.ModbusResponseException;
import com.digitalpetri.modbus.exceptions.ModbusTimeoutException;
import com.digitalpetri.modbus.pdu.ReadHoldingRegistersRequest;

// 单元 ID 1，从地址 0 开始读 10 个寄存器（对应手册里的 40001~40010）
try {
    var response = source.client().readHoldingRegisters(1, new ReadHoldingRegistersRequest(0, 10));
    byte[] raw = response.registers();                      // 每个寄存器 2 字节，按线上顺序（高字节在前）
    // 解码见第五节
} catch (ModbusResponseException e) {
    // 从站返回异常码：0x02 非法地址、0x03 非法数值等，通常是点表配错
    log.warn("从站异常响应 fc={} code={}", e.getFunctionCode(), e.getExceptionCode());
} catch (ModbusTimeoutException e) {
    // 连接正常但到期没等到响应：单元 ID 错、从站忙或已掉线
    log.warn("请求超时 unit=1");
} catch (ModbusExecutionException e) {
    // 2.2.0 起断线不再表现为超时，而是包在这里，按 cause 区分
    switch (e.getCause()) {
        case ModbusConnectionLostException lost -> log.warn("请求在途时连接断开，传输层会自动重连");
        case ModbusNotConnectedException idle -> log.warn("当前未连接，本轮跳过");
        case ModbusMalformedResponseException bad -> log.warn("响应与请求对不上：{}", bad.getMessage());
        case null, default -> log.warn("请求执行失败", e);
    }
}
```

`readHoldingRegistersAsync` 返回 `CompletionStage`，同时采集几百个从站时用异步接口，不必为每个从站占一个线程；异步接口不经过同步包装，`CompletionStage` 里拿到的直接是上面这些异常本身。断线、超时都不该沿用旧值，处理办法见第五节。写请求失败后不要盲目重试：超时或请求在途时断线，请求可能已经到了从站；能确定没发出去的只有 `ModbusNotConnectedException` 和 RTU 客户端的排队超时。

---

## 四、Modbus RTU 采集

### 1、串口直连

```java
import com.digitalpetri.modbus.client.ModbusRtuClient;
import com.digitalpetri.modbus.pdu.ReadInputRegistersRequest;
import com.digitalpetri.modbus.serial.client.SerialPortClientTransport;
import com.fazecast.jSerialComm.SerialPort;

import java.time.Duration;

var transport = SerialPortClientTransport.create(cfg -> {
    cfg.setSerialPort("/dev/ttyUSB0");      // Windows 上为 COM3 这类名称
    cfg.setBaudRate(9600);                  // 必须与从站一致
    cfg.setDataBits(8);
    cfg.setParity(SerialPort.EVEN_PARITY);  // 常见配置 8E1，以设备手册为准
    cfg.setStopBits(SerialPort.ONE_STOP_BIT);
});
var client = ModbusRtuClient.create(transport,
        cfg -> cfg.setRequestTimeout(Duration.ofMillis(500)));
client.connect();

var response = client.readInputRegisters(3, new ReadInputRegistersRequest(0, 2)); // 从站地址 3
```

### 2、RTU 总线的特殊约束

- **严格串行**：一条 RS-485 总线上同一时刻只能有一个请求在途，多个从站必须排队轮询，不能并发。2.2.0 的 `ModbusRtuClient` 自己保证一次只发一个请求，其余在客户端排队，所以请求超时里也包含排队时间，超时要按「排在前面的请求数 × 单次耗时」留足
- **超时要短**：某个从站掉线时，每次轮询都要等满超时；10 个从站、每个超时 2 秒，一轮就可能拖到 20 秒。超时设到几百毫秒，并对连续失败的从站降低轮询频率
- **一条总线一个主站**：同一总线上挂两个主站会产生冲突，现场改造时要确认原有 PLC 或 HMI 是否也在当主站
- **RTU over TCP**：DTU 透传场景用 `NettyRtuClientTransport.create(cfg -> cfg.setHostname(...).setPort(...))` 创建传输层，再交给 `ModbusRtuClient`

---

## 五、点表驱动的采集服务

![Modbus 采集链路](../../assets/iot/modbus-collector.svg)

### 1、点表

把"哪个寄存器是什么含义"从代码里拿出来，做成配置或数据库表，新增一种设备只需要加点表：

```java
/** 数据区决定读功能码 */
public enum Area {
    COIL(0x01), DISCRETE_INPUT(0x02), HOLDING_REGISTER(0x03), INPUT_REGISTER(0x04);
    public final int readFunctionCode;
    Area(int fc) { this.readFunctionCode = fc; }
}

public enum DataType { BOOL, INT16, UINT16, INT32, UINT32, FLOAT32, INT64, UINT64, FLOAT64 }

/** 把 32 位值的四个字节记作 A B C D（A 最高位），线上按什么顺序出现；64 位同理，按寄存器推广 */
public enum Endian {
    ABCD,   // 大端，Modbus 规范的默认
    BADC,   // 每个寄存器内两个字节互换
    CDAB,   // 寄存器先后颠倒（低字在前），最常见的「字交换」
    DCBA    // 完全小端
}

public record Point(
        String name,        // temperature
        int unitId,         // 单元 ID（RTU 的从站地址），同一个 DTU 后面常挂多台
        Area area,          // 数据区，决定功能码
        int address,        // 协议地址，从 0 开始
        DataType type,
        Endian endian,      // 只对 32 / 64 位类型有意义；16 位只区分 ABCD 与 BADC
        double scale,       // 工程量 = 原始值 × scale，如 0.1
        String unit) {

    /** 占几个寄存器；线圈与离散输入是位，按 1 计 */
    public int registerCount() {
        return switch (type) {
            case BOOL, INT16, UINT16 -> 1;
            case INT32, UINT32, FLOAT32 -> 2;
            case INT64, UINT64, FLOAT64 -> 4;
        };
    }
}
```

点表的字段并不是本篇发明的，现成的采集软件都有一套等价的配置，换算关系如下（字段名以各自的官方文档为准）：

| 本篇的点表字段 | ThingsBoard IoT Gateway（Modbus 连接器） | EMQX Neuron（Modbus 驱动） |
|---------------|------------------------------------------|---------------------------|
| `unitId` | 设备级的 `unitId` | 地址前缀 `SLAVE!`，如 `1!400001` 的 `1` |
| `area` | 测点的 `functionCode`（读用 1–4） | 地址首位的区号：`0` 线圈、`1` 离散输入、`3` 输入寄存器、`4` 保持寄存器 |
| `address`（从 0 起） | `address` | 区号之后的地址，默认从 1 起（节点参数 Start Address 可改为从 0 起） |
| `type` | `type`：`bits`、`16int`、`16uint`、`32int`、`32uint`、`32float`、`64int`、`64uint`、`64float`、`string` 等，寄存器个数写在 `objectsCount` | 标签类型：`BIT`、`INT16`、`UINT16`、`INT32`、`UINT32`、`INT64`、`UINT64`、`FLOAT`、`DOUBLE`、`STRING`、`BYTES` |
| `endian` | 设备级的 `byteOrder`（寄存器内的字节顺序）与 `wordOrder`（多个寄存器的先后），各取 `BIG` / `LITTLE`，两者组合出四种，默认都是 `LITTLE` | 地址后缀：`#LL` 即 1234（ABCD，默认）、`#LB` 即 2143（BADC）、`#BL` 即 3412（CDAB）、`#BB` 即 4321（DCBA） |
| `scale` | `multiplier`、`divider` | 标签的 Decimal：设备值 × Decimal = 上报值 |
| 轮询周期 | 设备级的 `pollPeriod`（毫秒） | 所在组的 Interval（毫秒，最小 100），同组标签一起轮询、一起上报 |

两家的默认字节序不同（ThingsBoard 默认 `LITTLE`，Neuron 默认 ABCD），从一个软件迁到另一个时最容易在这里出错：字节序要跟着设备手册重新确认，不能照抄配置值。

### 2、解码

```java
import java.nio.ByteBuffer;

public final class RegisterDecoder {

    /** 寄存器类测点。raw 为一次批量读取返回的字节，baseAddress 为本次读取的起始地址 */
    public static double decode(byte[] raw, int baseAddress, Point p) {
        int offset = (p.address() - baseAddress) * 2;
        ByteBuffer buf = ByteBuffer.wrap(toBigEndian(raw, offset, p.registerCount(), p.endian()));
        double value = switch (p.type()) {
            case BOOL    -> buf.getShort(0) != 0 ? 1 : 0;
            case INT16   -> buf.getShort(0);                     // 有符号：0xFFF6 → -10
            case UINT16  -> Short.toUnsignedInt(buf.getShort(0));
            case INT32   -> buf.getInt(0);
            case UINT32  -> Integer.toUnsignedLong(buf.getInt(0));
            case FLOAT32 -> buf.getFloat(0);
            case INT64   -> buf.getLong(0);
            case UINT64  -> Double.parseDouble(Long.toUnsignedString(buf.getLong(0)));
            case FLOAT64 -> buf.getDouble(0);
        };
        return value * p.scale();
    }

    /** 线圈与离散输入：响应里每个字节装 8 个点，低位在前 */
    public static boolean decodeBit(byte[] bits, int baseAddress, Point p) {
        int i = p.address() - baseAddress;
        return (bits[i / 8] >> (i % 8) & 1) == 1;
    }

    /** 把线上的字节按 endian 还原成 ABCD（大端），之后统一用 ByteBuffer 的大端读法 */
    static byte[] toBigEndian(byte[] raw, int offset, int registers, Endian endian) {
        boolean reverseRegisters = endian == Endian.CDAB || endian == Endian.DCBA;
        boolean swapBytes = endian == Endian.BADC || endian == Endian.DCBA;
        byte[] out = new byte[registers * 2];
        for (int r = 0; r < registers; r++) {
            int src = offset + (reverseRegisters ? registers - 1 - r : r) * 2;
            out[r * 2]     = swapBytes ? raw[src + 1] : raw[src];
            out[r * 2 + 1] = swapBytes ? raw[src] : raw[src + 1];
        }
        return out;
    }
}
```

- **有符号数**：温度这类可能为负的量，寄存器值 `0xFFF6` 按无符号读是 65526，乘以 0.1 变成 6552.6；按 `short` 读才是 -10，乘以 0.1 得 -1.0
- **字节序**：32 位整数和浮点数占两个寄存器，64 位占四个，不同厂家的顺序不同。四种排法里 ABCD 与 CDAB 最常见，BADC、DCBA 多见于把内存原样搬进寄存器的设备；只能看手册或现场比对确认，所以做成点表字段
- **64 位与精度**：`double` 只能精确表示 2^53 以内的整数，电能累计这类 UINT64 计数器可能超过；要求逐位精确时不乘系数、按 `long` 或字符串上报

### 3、批量读取与调度

- **合并相邻点**：把地址连续或间隔很小的点合并成一次请求，单次读取上限是 125 个寄存器；一次读 20 个寄存器远比发 20 次请求快
- **一个从站一个调度任务**：用 `ScheduledExecutorService.scheduleWithFixedDelay` 而不是 `scheduleAtFixedRate`，上一轮超时时不会出现请求堆叠
- **变化上报**：只有数值变化超过死区（如温度 0.2℃）或距上次上报超过最大间隔时才发 MQTT，能大幅减少上行流量
- **读不到就不报**：读取失败时不要沿用旧值，下游才能区分"数值没变"和"设备掉线"。本模块的遥测载荷没有质量位，做法是失败的测点从这一轮里省略，不要报 null 或 0，见 [物模型与解码 · 缺测与零值](../4_practice/2_thing_model#九、缺测与零值)；整台子设备连续几轮都读不到时，声明它下线，见下一小节

### 4、生命周期

```java
import org.springframework.context.SmartLifecycle;

@Component
public class ModbusCollector implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(ModbusCollector.class);
    private static final int OFFLINE_AFTER_FAILURES = 3;    // 连续几轮整台读不到，就声明这台子设备下线

    private final List<DeviceProfile> devices;             // 子设备 ID + 连接地址 + 点表，来自配置或数据库
    private final GatewayMqttClient mqtt;                   // 采集服务自己的那条 MQTT 连接，clientid 是它的网关 ID
    private final JsonMapper json;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);
    private final Map<String, Integer> failures = new ConcurrentHashMap<>();   // 子设备 ID → 连续失败的轮数
    private volatile boolean running;

    public ModbusCollector(MqttSettings settings, List<DeviceProfile> devices, JsonMapper json) {
        this.devices = devices;
        this.json = json;
        // 每次连上 Broker（含自动重连）都重新声明一遍子设备：网关离线时平台已经把它名下的子设备全部置为离线
        this.mqtt = new GatewayMqttClient(settings, this::declareOnlineDevices);
    }

    @Override
    public void start() {
        // 不等连接结果：Broker 暂时连不上由客户端的自动重连接着试，不该让采集服务起不来
        mqtt.start(this::onCommand);
        for (DeviceProfile device : devices) {
            scheduler.scheduleWithFixedDelay(() -> pollSafely(device),
                    0, device.interval().toMillis(), TimeUnit.MILLISECONDS);
        }
        running = true;
    }

    private void declareOnlineDevices() {
        for (DeviceProfile device : devices) {
            if (failures.getOrDefault(device.id(), 0) < OFFLINE_AFTER_FAILURES) {
                mqtt.publish("connect", deviceJson(device));
            }
        }
    }

    private void pollSafely(DeviceProfile device) {
        try {
            // 批量读取 + RegisterDecoder 解码，测点名 → 工程量；读失败的测点不放进来，整台读不到时为空
            Map<String, Object> values = device.poll();
            if (values.isEmpty()) {
                if (failures.merge(device.id(), 1, Integer::sum) == OFFLINE_AFTER_FAILURES) {
                    mqtt.publish("disconnect", deviceJson(device));    // 总线上轮询不到了
                }
                return;
            }
            Integer failed = failures.remove(device.id());
            if (failed != null && failed >= OFFLINE_AFTER_FAILURES) {
                mqtt.publish("connect", deviceJson(device));           // 之前声明过下线，恢复后重新声明上线
            }
            Map<String, Object> reading = Map.of("ts", System.currentTimeMillis(), "values", values);
            // 按子设备分组：{"子设备 ID": [{"ts": …, "values": {…}}]}，QoS 1
            mqtt.publish("telemetry", json.writeValueAsString(Map.of(device.id(), List.of(reading))));
        } catch (Exception e) {
            // 异常不能抛出，否则该任务会被调度器静默取消
            log.warn("采集失败 device={}", device.id(), e);
        }
    }

    private void onCommand(Mqtt5Publish publish) {
        // 平台经网关发给子设备的指令（gateways/{gatewayId}/cmd），处理与应答见「网关与子设备」
    }

    @Override
    public void stop() {
        running = false;
        scheduler.shutdown();
        try {
            scheduler.awaitTermination(5, TimeUnit.SECONDS);   // 等在途的那一轮读完，再声明下线、关连接
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        for (DeviceProfile device : devices) {
            mqtt.publish("disconnect", deviceJson(device));
            device.closeQuietly();
        }
        mqtt.close();                                        // 先把保留的在线状态改成离线，再断开
    }

    private String deviceJson(DeviceProfile device) {
        return json.writeValueAsString(Map.of("device", device.id()));
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
```

`SmartLifecycle` 让采集在 Spring 容器完全就绪后才启动，并在关闭时先停调度、等在途的一轮读完、再声明下线和释放连接；不要在 `@PostConstruct` 里建连和启动线程。MQTT 这一侧用的是 [MQTT 客户端](./3_mqtt_client) 第二节的 `GatewayMqttClient`：它只在 `gateways/{gatewayId}/` 前缀下收发，登记了遗嘱，并在每次连上之后回调 `declareOnlineDevices`。

两处容易漏掉的状态：

- **重连之后要重新声明**：只在启动时发一次 `connect` 的话，MQTT 断线重连之后子设备在平台上会一直是离线，遥测却照常上报
- **读不到要声明下线**：整台子设备连续几轮读不到就发 `disconnect`，恢复后再发 `connect`；只打日志的话，平台会一直显示它在线

采集服务用**一条** MQTT 连接替所有从站上报，所以它在平台眼里是一个网关，子设备是它下面的电表、PLC：

- **为什么不直接发 `devices/{子设备 ID}/telemetry`**：设备 ACL 只允许连接发布 `devices/${clientid}/…`，采集服务的 clientid 是它自己的 ID，代发子设备的 Topic 会被拒绝；给它放开 `devices/+/telemetry` 又等于让它能冒充任何设备。所以网关走自己的 `gateways/{gatewayId}/…` 前缀，ACL 规则见 [设备安全 · 网关与采集器](./1_security#_5、网关与采集器-一条连接代多台设备)
- **载荷形状**：每台子设备一个数组，元素就是单台设备的 `{"ts", "values"}`（形状参照 ThingsBoard 网关 MQTT API），同一轮多台子设备的读数可以合并成一条消息；平台拆包后得到的与设备直连上报的完全一样，再转成内部的 `TelemetryMessage`，约定见 [遥测数据链路 · Topic 与消息约定](../3_platform/2_data#_1、topic-与消息约定)
- **QoS**：默认 QoS 1；采样很密、丢几个点无所谓的测点可以降到 QoS 0
- **网关自身在线**：`gateways/{gatewayId}/status` 是采集服务这条连接的遗嘱 Topic，也是它每次连上之后发布的保留消息，都在 `GatewayMqttClient` 里；它掉线时平台据此把名下子设备一并标为离线

平台怎么登记网关与子设备的拓扑、核对子设备归属、经网关下发指令，见 [网关与子设备](./5_gateway_subdevice)。

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 读到的值和设备面板对不上，差一个点 | 把 `40001` 直接当地址，或厂家地址从 1 开始 | 统一换算为从 0 开始的偏移，现场逐点比对 |
| 负温度变成几千 | 按无符号读取 | 有符号量用 `getShort` |
| 浮点数是天文数字 | 字节序不对 | 点表里配置 ABCD / BADC / CDAB / DCBA，现场逐个试 |
| 从站频繁拒绝连接 | 每次轮询新建连接，或给同一个 DTU 后面的每台从站各开一条，超出并发连接数 | 每个 TCP 端点一条长连接，同一端点下按单元 ID 区分 |
| RTU 整条总线采集变慢 | 某个从站离线，每次都等满超时 | 缩短超时，对连续失败的从站降频 |
| 返回异常码 0x02 | 读取范围包含从站不存在的地址 | 拆分批量读取，避开空洞地址 |
| 升级 digitalpetri 2.2.0 后断线告警没了 | 断线从 `ModbusTimeoutException` 改为包在 `ModbusExecutionException` 里的 `ModbusConnectionLostException` | 按第三节的写法区分 cause |
| 采集服务上报被 Broker 拒绝 | 用网关的连接往 `devices/{子设备 ID}/…` 发布，被设备 ACL 拒掉 | 改走 `gateways/{gatewayId}/telemetry` |

---

## 七、自己写采集服务还是用现成采集软件

上面几节讲的是用 Java 自己写采集服务。工业现场更常见的做法是直接部署现成的采集软件，它们已经把点表配置、断线重连、降频、MQTT 上报做成了界面或配置文件。几个主流选项（现状核实于 2026 年 11 月）：

| 软件 | 形态 | 许可与现状 | 适合 |
|------|------|-----------|------|
| EMQX Neuron | 独立的工业协议网关（C 编写），南向驱动覆盖 Modbus、OPC UA、EtherNet/IP 等 70 多种协议，北向直接发 MQTT | 商业版 EMQX Neuron（原 NeuronEX）自带永久免费许可，限 30 个点位，超过要买许可；GitHub 上的开源 neuron 为 LGPL-3.0，仍在持续提交 | 点位多、协议杂，希望在 Web 界面上配点表的工厂现场 |
| ThingsBoard IoT Gateway | Python 进程，连接器包括 Modbus、OPC-UA、BACnet、S7、CAN、BLE、OCPP 等 | Apache-2.0，2026-10 发布 3.8.6 | 平台就是 ThingsBoard，或平台实现了它的网关 MQTT API |
| EdgeX Foundry device-modbus | Go 写的设备服务，EdgeX 边缘框架的一部分 | Apache-2.0；EdgeX 4.0 是长期支持版，device-modbus 2026-05 发布 v4.0.2 | 已经用 EdgeX 搭边缘侧 |
| Apache PLC4X | 驱动库，有 Java、Go、C、Python 实现，Modbus 支持 TCP、RTU、ASCII，用统一的地址语法读写 | Apache-2.0，2026-09 发布 1.0.0 | 用 Java 自己写采集，又要同时接 S7、EtherNet/IP 等多种 PLC 协议 |
| Node-RED + node-red-contrib-modbus | 低代码的流程编排（Node.js），拖节点完成读取、换算、上报 | Node-RED 为 Apache-2.0，2026-11 发布 5.0.10；Modbus 节点为 BSD-3-Clause，5.62.1 | 规模小、要快速验证，或现场工程师自己维护 |

怎么选：

- **默认先看现成软件**：点表维护、驱动兼容、现场调试这些活儿它们做得比新写的服务成熟，现场工程师也更熟悉；平台只要能收它们发出的 MQTT（多数支持自定义 Topic 与载荷模板，按本模块的 `gateways/{gatewayId}/…` 约定配置即可）
- **适合自己写的场景**：点表要和平台的设备台账、物模型放在同一个库里统一维护；采集逻辑里有业务判断（按工况切换采样频率、按计划停采）；或者整个平台都是 Java 栈，不想在边缘多运维一个异构进程。即使自己写，也优先在 digitalpetri modbus 或 PLC4X 之上写，不要自己拼 Modbus 报文
- **边缘侧的通用取舍**（断网缓存、本地规则、边缘框架选型）见 [边缘计算](../1_basics/4_edge)

---

## 小结

- Modbus 有四类数据区，采集最常用功能码 0x03 和 0x04；手册里的 `40001` 对应协议地址 0
- TCP 走 MBAP 头、端口 502；RTU 走串口、靠 CRC 和静默间隔分帧，总线严格串行；DTU 透传是 RTU over TCP
- 新项目用 digitalpetri modbus 2.2.0（Netty、自动重连、TCP 与 RTU 都支持），JDK 8 存量项目可用 j2mod；2.2.0 起断线以 `ModbusConnectionLostException` 立即失败，RTU 客户端一次只发一个请求
- 每个 TCP 端点一条长连接，按点表批量读取，`scheduleWithFixedDelay` 调度，异常不能逃出任务
- 点表至少包含单元 ID、数据区、地址、类型、字节序（ABCD / BADC / CDAB / DCBA）、缩放系数，与 ThingsBoard IoT Gateway、Neuron 的配置字段一一对应；读失败的测点省略不报，不沿用旧值
- 采集服务是网关：用 `gateways/{gatewayId}/connect` 声明子设备上线（MQTT 每次重连之后都要重新声明），整台读不到时发 `disconnect`，用 `gateways/{gatewayId}/telemetry` 按子设备分组上报
- 工业现场优先考虑 Neuron、ThingsBoard IoT Gateway 等现成软件，点表要和业务库打通时再自己写

## 参考资料

- digitalpetri modbus：[https://github.com/digitalpetri/modbus](https://github.com/digitalpetri/modbus)
- digitalpetri modbus 2.2.0 发布说明（兼容性变化）：[https://github.com/digitalpetri/modbus/releases/tag/v2.2.0](https://github.com/digitalpetri/modbus/releases/tag/v2.2.0)
- digitalpetri modbus 错误与异常：[https://github.com/digitalpetri/modbus/blob/v2.2.0/docs/user/reference/errors-and-exceptions.md](https://github.com/digitalpetri/modbus/blob/v2.2.0/docs/user/reference/errors-and-exceptions.md)
- digitalpetri modbus 超时与重连：[https://github.com/digitalpetri/modbus/blob/v2.2.0/docs/user/how-to/operations/configure-timeouts-and-reconnection.md](https://github.com/digitalpetri/modbus/blob/v2.2.0/docs/user/how-to/operations/configure-timeouts-and-reconnection.md)
- j2mod：[https://github.com/steveohara/j2mod](https://github.com/steveohara/j2mod)
- Modbus Organization（协议规范下载）：[https://www.modbus.org/](https://www.modbus.org/)
- ThingsBoard IoT Gateway Modbus 连接器配置：[https://thingsboard.io/docs/iot-gateway/config/modbus/](https://thingsboard.io/docs/iot-gateway/config/modbus/)
- ThingsBoard 网关 MQTT API · 遥测：[https://thingsboard.io/docs/reference/gateway-api/telemetry/](https://thingsboard.io/docs/reference/gateway-api/telemetry/)
- ThingsBoard IoT Gateway：[https://github.com/thingsboard/thingsboard-gateway](https://github.com/thingsboard/thingsboard-gateway)
- EMQX Neuron Modbus TCP 驱动（地址格式与字节序）：[https://docs.emqx.com/en/emqx-neuron/latest/configuration/south-devices/modbus-tcp/modbus-tcp.html](https://docs.emqx.com/en/emqx-neuron/latest/configuration/south-devices/modbus-tcp/modbus-tcp.html)
- EMQX Neuron 组与标签：[https://docs.emqx.com/en/emqx-neuron/latest/configuration/groups-tags/groups-tags.html](https://docs.emqx.com/en/emqx-neuron/latest/configuration/groups-tags/groups-tags.html)
- EMQX Neuron 许可：[https://docs.emqx.com/en/emqx-neuron/latest/installation/license.html](https://docs.emqx.com/en/emqx-neuron/latest/installation/license.html)
- neuron（开源版）：[https://github.com/emqx/neuron](https://github.com/emqx/neuron)
- EdgeX device-modbus-go：[https://github.com/edgexfoundry/device-modbus-go](https://github.com/edgexfoundry/device-modbus-go)
- Apache PLC4X Modbus 驱动：[https://plc4x.apache.org/plc4x/latest/users/protocols/modbus.html](https://plc4x.apache.org/plc4x/latest/users/protocols/modbus.html)
- node-red-contrib-modbus：[https://github.com/BiancoRoyal/node-red-contrib-modbus](https://github.com/BiancoRoyal/node-red-contrib-modbus)

> 下一篇：[网关与子设备](./5_gateway_subdevice)

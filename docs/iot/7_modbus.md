---
description: 寄存器与功能码、TCP 与 RTU、digitalpetri modbus 与 j2mod、长连接轮询、点表、数值解码
---

# Modbus 采集

> 前置阅读：[通信协议](./1_protocol)

PLC、电表、变频器这类工业设备大多只会说 Modbus，平台侧由采集服务充当主站周期轮询。本篇讲 TCP 与 RTU 采集、点表与批量读取、数值解码、常见坑，基线为 JDK 21。

---

## 一、采集需要掌握的协议细节

采集服务（或边缘网关）周期轮询从站寄存器，换算成工程量后上报 MQTT。示例库为 digitalpetri modbus 2.1.6，备选 j2mod 3.4.0。

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
| digitalpetri modbus | 2.1.6 | 17+ | 基于 Netty，同步与异步 API，支持 TCP、RTU（串口）、RTU over TCP、TLS，客户端与服务端都有 |
| j2mod | 3.4.0 | 8+ | 同步 API，支持 TCP、UDP、RTU、ASCII，资料多，存量项目常见 |

新项目推荐 digitalpetri modbus：连接由传输层维护，断线自动重连，异步 API 适合同时采集大量从站。只能用 JDK 8 的存量项目继续用 j2mod，但同样要改成长连接。

```xml
<!-- Modbus TCP 与 RTU over TCP -->
<dependency>
    <groupId>com.digitalpetri.modbus</groupId>
    <artifactId>modbus-tcp</artifactId>
    <version>2.1.6</version>
</dependency>
<!-- Modbus RTU 串口，依赖 jSerialComm -->
<dependency>
    <groupId>com.digitalpetri.modbus</groupId>
    <artifactId>modbus-serial</artifactId>
    <version>2.1.6</version>
</dependency>
```

---

## 三、Modbus TCP 采集

### 1、建立长连接

每次轮询都新建、关闭 TCP 连接是最常见的错误写法：建连本身有开销，而且不少 PLC 只允许几个并发连接，频繁建连会触发从站拒绝或进入保护状态。正确做法是每个从站一个长连接，断线由传输层自动重连。

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
                .setConnectPersistent(true));               // 连接断开后自动重连
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
import com.digitalpetri.modbus.exceptions.ModbusResponseException;
import com.digitalpetri.modbus.exceptions.ModbusTimeoutException;
import com.digitalpetri.modbus.pdu.ReadHoldingRegistersRequest;

// 单元 ID 1，从地址 0 开始读 10 个寄存器（对应手册里的 40001~40010）
try {
    var response = source.client().readHoldingRegisters(1, new ReadHoldingRegistersRequest(0, 10));
    byte[] raw = response.registers();                      // 每个寄存器 2 字节，大端
    // 解码见第五节
} catch (ModbusResponseException e) {
    // 从站返回异常码：0x02 非法地址、0x03 非法数值等，通常是点表配错
    log.warn("从站异常响应 fc={} code={}", e.getFunctionCode(), e.getExceptionCode());
} catch (ModbusTimeoutException e) {
    log.warn("请求超时，从站离线或网络中断");
}
```

`readHoldingRegistersAsync` 返回 `CompletionStage`，同时采集几百个从站时用异步接口，不必为每个从站占一个线程。

---

## 四、Modbus RTU 采集

### 1、串口直连

```java
import com.digitalpetri.modbus.client.ModbusRtuClient;
import com.digitalpetri.modbus.serial.client.SerialPortClientTransport;
import com.fazecast.jSerialComm.SerialPort;

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

- **严格串行**：一条 RS-485 总线上同一时刻只能有一个请求在途，多个从站必须排队轮询，不能并发
- **超时要短**：某个从站掉线时，每次轮询都要等满超时；10 个从站、每个超时 2 秒，一轮就可能拖到 20 秒。超时设到几百毫秒，并对连续失败的从站降低轮询频率
- **一条总线一个主站**：同一总线上挂两个主站会产生冲突，现场改造时要确认原有 PLC 或 HMI 是否也在当主站
- **RTU over TCP**：DTU 透传场景用 `NettyRtuClientTransport.create(cfg -> cfg.setHostname(...).setPort(...))` 创建传输层，再交给 `ModbusRtuClient`

---

## 五、点表驱动的采集服务

![Modbus 采集链路](../assets/iot/modbus-collector.svg)

### 1、点表

把"哪个寄存器是什么含义"从代码里拿出来，做成配置或数据库表，新增一种设备只需要加点表：

```java
public enum DataType { INT16, UINT16, INT32, FLOAT32 }

public enum WordOrder { BIG_ENDIAN, WORD_SWAPPED }   // ABCD 或 CDAB

public record Point(
        String name,        // temperature
        int address,        // 寄存器偏移，从 0 开始
        DataType type,
        WordOrder order,
        double scale,       // 工程量 = 原始值 × scale，如 0.1
        String unit) {

    public int registerCount() {
        return switch (type) {
            case INT16, UINT16 -> 1;
            case INT32, FLOAT32 -> 2;
        };
    }
}
```

### 2、解码

```java
import java.nio.ByteBuffer;

public final class RegisterDecoder {

    /** raw 为一次批量读取返回的字节，baseAddress 为本次读取的起始地址 */
    public static double decode(byte[] raw, int baseAddress, Point p) {
        int offset = (p.address() - baseAddress) * 2;
        ByteBuffer buf = ByteBuffer.wrap(raw);                  // 默认大端，与 Modbus 一致
        double value = switch (p.type()) {
            case INT16   -> buf.getShort(offset);               // 有符号：0xFFF6 → -10
            case UINT16  -> Short.toUnsignedInt(buf.getShort(offset));
            case INT32   -> wordAware(buf, offset, p.order()).getInt(0);
            case FLOAT32 -> wordAware(buf, offset, p.order()).getFloat(0);
        };
        return value * p.scale();
    }

    private static ByteBuffer wordAware(ByteBuffer buf, int offset, WordOrder order) {
        byte[] b = new byte[4];
        buf.get(offset, b);
        if (order == WordOrder.WORD_SWAPPED) {                  // CDAB：高低字交换
            b = new byte[] {b[2], b[3], b[0], b[1]};
        }
        return ByteBuffer.wrap(b);
    }
}
```

- **有符号数**：温度这类可能为负的量，寄存器值 `0xFFF6` 按无符号读是 65526，乘以 0.1 变成 6552.6；按 `short` 读才是 -10，乘以 0.1 得 -1.0
- **字序**：32 位整数和浮点数占两个寄存器，不同厂家高低字顺序不同（ABCD、CDAB 最常见），只能看手册或现场比对确认，所以把它做成点表字段

### 3、批量读取与调度

- **合并相邻点**：把地址连续或间隔很小的点合并成一次请求，单次读取上限是 125 个寄存器；一次读 20 个寄存器远比发 20 次请求快
- **一个从站一个调度任务**：用 `ScheduledExecutorService.scheduleWithFixedDelay` 而不是 `scheduleAtFixedRate`，上一轮超时时不会出现请求堆叠
- **变化上报**：只有数值变化超过死区（如温度 0.2℃）或距上次上报超过最大间隔时才发 MQTT，能大幅减少上行流量
- **数据质量**：读取失败时上报带 `quality=BAD` 的状态而不是沿用旧值，下游才能区分"数值没变"和"设备掉线"

### 4、生命周期

```java
import org.springframework.context.SmartLifecycle;

@Component
public class ModbusCollector implements SmartLifecycle {

    private final List<DeviceProfile> devices;             // 设备地址 + 点表，来自配置或数据库
    private final MqttGateway mqtt;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);
    private volatile boolean running;

    public ModbusCollector(List<DeviceProfile> devices, MqttGateway mqtt) {
        this.devices = devices;
        this.mqtt = mqtt;
    }

    @Override
    public void start() {
        for (DeviceProfile device : devices) {
            scheduler.scheduleWithFixedDelay(() -> pollSafely(device),
                    0, device.interval().toMillis(), TimeUnit.MILLISECONDS);
        }
        running = true;
    }

    private void pollSafely(DeviceProfile device) {
        try {
            Map<String, Double> metrics = device.poll();   // 批量读取 + RegisterDecoder 解码
            mqtt.publish("devices/" + device.id() + "/data", 0, Json.write(metrics));
        } catch (Exception e) {
            // 异常不能抛出，否则该任务会被调度器静默取消
            log.warn("采集失败 device={}", device.id(), e);
        }
    }

    @Override
    public void stop() {
        running = false;
        scheduler.shutdown();
        devices.forEach(DeviceProfile::closeQuietly);
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
```

`SmartLifecycle` 让采集在 Spring 容器完全就绪后才启动，并在关闭时先停止调度、再释放连接；不要在 `@PostConstruct` 里建连和启动线程。`MqttGateway` 的定义见 [MQTT 客户端](./6_mqtt_client)。

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 读到的值和设备面板对不上，差一个点 | 把 `40001` 直接当地址，或厂家地址从 1 开始 | 统一换算为从 0 开始的偏移，现场逐点比对 |
| 负温度变成几千 | 按无符号读取 | 有符号量用 `getShort` |
| 浮点数是天文数字 | 字序不对 | 点表里配置 ABCD / CDAB |
| 从站频繁拒绝连接 | 每次轮询新建连接，超出从站并发连接数 | 每个从站一个长连接 |
| RTU 整条总线采集变慢 | 某个从站离线，每次都等满超时 | 缩短超时，对连续失败的从站降频 |
| 返回异常码 0x02 | 读取范围包含从站不存在的地址 | 拆分批量读取，避开空洞地址 |

---

## 小结

- Modbus 有四类数据区，采集最常用功能码 0x03 和 0x04；手册里的 `40001` 对应协议地址 0
- TCP 走 MBAP 头、端口 502；RTU 走串口、靠 CRC 和静默间隔分帧，总线严格串行；DTU 透传是 RTU over TCP
- 新项目用 digitalpetri modbus（Netty、自动重连、TCP 与 RTU 都支持），JDK 8 存量项目可用 j2mod
- 每个从站一个长连接，按点表批量读取，`scheduleWithFixedDelay` 调度，异常不能逃出任务
- 解码时注意有符号数、字序和缩放系数，失败要上报数据质量而不是沿用旧值

## 参考资料

- digitalpetri modbus：[https://github.com/digitalpetri/modbus](https://github.com/digitalpetri/modbus)
- j2mod：[https://github.com/steveohara/j2mod](https://github.com/steveohara/j2mod)
- Modbus Organization（协议规范下载）：[https://www.modbus.org/](https://www.modbus.org/)

> 下一篇：[设备影子](./8_device_shadow)

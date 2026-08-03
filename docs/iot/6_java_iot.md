# Java IoT 实战

> 参考资料：
> * Eclipse Paho Java：[https://eclipse.dev/paho/index.php?page=clients/java/index.php](https://eclipse.dev/paho/index.php?page=clients/java/index.php)
> * EMQX Java SDK：[https://www.emqx.com/zh/blog/how-to-use-mqtt-in-java](https://www.emqx.com/zh/blog/how-to-use-mqtt-in-java)
> * j2mod Modbus：[https://github.com/steveohara/j2mod](https://github.com/steveohara/j2mod)

## 一、技术栈全景

| 设备接入层 | 消息中间件 | 业务处理层 | 存储层 |
|-----------|-----------|-----------|--------|
| Netty | EMQX Broker | Spring Boot | TDengine |
| Eclipse Paho（MQTT）| Kafka | 规则引擎服务 | InfluxDB |
| j2mod（Modbus）| | 设备影子服务 | MySQL / Redis |
| Eclipse Milo（OPC-UA）| | OTA 服务 | |

---

## 二、MQTT 客户端（Eclipse Paho）

### 依赖

```xml
<dependency>
    <groupId>org.eclipse.paho</groupId>
    <artifactId>org.eclipse.paho.client.mqttv3</artifactId>
    <version>1.2.5</version>
</dependency>
```

### 基础连接与发布订阅

```java
import org.eclipse.paho.client.mqttv3.*;

public class MqttDemo {

    public static void main(String[] args) throws MqttException {
        String broker     = "tcp://emqx.example.com:1883";
        String clientId   = "device-001";
        String username   = "device-001";
        String password   = "your-secret";

        MqttClient client = new MqttClient(broker, clientId);

        // 连接配置
        MqttConnectOptions options = new MqttConnectOptions();
        options.setUserName(username);
        options.setPassword(password.toCharArray());
        options.setCleanSession(true);
        options.setKeepAliveInterval(60);
        // 遗嘱消息：设备异常离线时自动发布
        options.setWill("devices/device-001/status",
                        "{\"status\":\"offline\"}".getBytes(), 1, true);

        client.connect(options);
        System.out.println("已连接到 Broker");

        // 订阅下行指令
        client.subscribe("devices/device-001/command", 1, (topic, message) -> {
            String payload = new String(message.getPayload());
            System.out.println("收到指令：" + payload);
        });

        // 发布上行数据
        String data = "{\"temperature\": 36.5, \"humidity\": 60}";
        MqttMessage msg = new MqttMessage(data.getBytes());
        msg.setQos(1);
        client.publish("devices/device-001/data", msg);

        System.out.println("数据已发布");
    }
}
```

### TLS 安全连接

```java
import javax.net.ssl.SSLSocketFactory;

MqttConnectOptions options = new MqttConnectOptions();
options.setSocketFactory(createSslSocketFactory(
    "/certs/ca.pem",
    "/certs/client.pem",
    "/certs/client.key"
));

MqttClient client = new MqttClient("ssl://emqx.example.com:8883", clientId);
client.connect(options);
```

---

## 三、Spring Boot 集成 MQTT

### 依赖（使用 Spring Integration MQTT）

```xml
<dependency>
    <groupId>org.springframework.integration</groupId>
    <artifactId>spring-integration-mqtt</artifactId>
</dependency>
```

### 配置类

```java
@Configuration
public class MqttConfig {

    @Value("${mqtt.broker}")
    private String broker;

    @Bean
    public MqttPahoClientFactory mqttClientFactory() {
        DefaultMqttPahoClientFactory factory = new DefaultMqttPahoClientFactory();
        MqttConnectOptions options = new MqttConnectOptions();
        options.setServerURIs(new String[]{broker});
        options.setUserName("server");
        options.setPassword("secret".toCharArray());
        factory.setConnectionOptions(options);
        return factory;
    }

    // 消息接收通道
    @Bean
    public MessageChannel mqttInputChannel() {
        return new DirectChannel();
    }

    // 入站适配器（订阅）
    @Bean
    public MessageProducerSupport mqttInbound(MqttPahoClientFactory factory) {
        MqttPahoMessageDrivenChannelAdapter adapter =
            new MqttPahoMessageDrivenChannelAdapter("server-inbound", factory,
                "devices/+/data");   // 订阅所有设备的数据 Topic
        adapter.setOutputChannel(mqttInputChannel());
        adapter.setQos(1);
        return adapter;
    }

    // 出站适配器（发布）
    @Bean
    @ServiceActivator(inputChannel = "mqttOutboundChannel")
    public MessageHandler mqttOutbound(MqttPahoClientFactory factory) {
        MqttPahoMessageHandler handler =
            new MqttPahoMessageHandler("server-outbound", factory);
        handler.setAsync(true);
        handler.setDefaultQos(1);
        return handler;
    }
}
```

### 消息处理 Service

```java
@Service
public class DeviceDataService {

    // 处理设备上报的数据
    @ServiceActivator(inputChannel = "mqttInputChannel")
    public void handleDeviceData(Message<String> message) {
        String topic   = (String) message.getHeaders().get(MqttHeaders.RECEIVED_TOPIC);
        String payload = message.getPayload();
        // 解析 topic 获取 deviceId
        String deviceId = topic.split("/")[1];  // devices/{deviceId}/data
        System.out.println("设备 " + deviceId + " 上报：" + payload);
        // 写入时序数据库...
    }
}
```

---

## 四、Modbus TCP 读写（j2mod）

```xml
<dependency>
    <groupId>com.ghgande</groupId>
    <artifactId>j2mod</artifactId>
    <version>3.2.0</version>
</dependency>
```

```java
import com.ghgande.j2mod.modbus.io.ModbusTCPTransaction;
import com.ghgande.j2mod.modbus.msg.ReadMultipleRegistersRequest;
import com.ghgande.j2mod.modbus.msg.ReadMultipleRegistersResponse;
import com.ghgande.j2mod.modbus.net.TCPMasterConnection;

public class ModbusDemo {

    public static void main(String[] args) throws Exception {
        // 连接 Modbus TCP 从站
        TCPMasterConnection conn = new TCPMasterConnection(
            InetAddress.getByName("192.168.1.100"));
        conn.setPort(502);
        conn.connect();

        // 读取保持寄存器（功能码 03），从地址 0 读取 10 个寄存器
        ReadMultipleRegistersRequest request =
            new ReadMultipleRegistersRequest(0, 10);
        request.setUnitID(1);  // 从站地址

        ModbusTCPTransaction transaction = new ModbusTCPTransaction(conn);
        transaction.setRequest(request);
        transaction.execute();

        ReadMultipleRegistersResponse response =
            (ReadMultipleRegistersResponse) transaction.getResponse();

        for (int i = 0; i < response.getWordCount(); i++) {
            System.out.println("寄存器[" + i + "] = " + response.getRegisterValue(i));
        }

        conn.close();
    }
}
```

---

## 五、设备接入服务设计模式

### 设备接入架构

![设备接入服务架构](../assets/iot/iot-device-access-arch.svg)

### 设备影子（Device Shadow）

设备影子是云端维护的设备状态镜像，解决设备离线时仍能查询/下发指令的问题：

```java
// 设备上线时同步影子状态
@Service
public class DeviceShadowService {

    @Autowired
    private RedisTemplate<String, String> redis;

    // 设备上报状态 → 更新影子
    public void updateShadow(String deviceId, String stateJson) {
        redis.opsForValue().set("shadow:" + deviceId, stateJson);
    }

    // 查询设备当前状态（设备离线也能返回最后状态）
    public String getShadow(String deviceId) {
        return redis.opsForValue().get("shadow:" + deviceId);
    }

    // 下发指令（设备在线则立即推送，离线则缓存待上线后推送）
    public void sendCommand(String deviceId, String command) {
        redis.opsForList().rightPush("pending_cmd:" + deviceId, command);
    }
}
```

---

## 六、Netty 自定义私有协议接入

> 通用帧格式设计、`LengthFieldBasedFrameDecoder` 参数详解及编解码器模板，见 [Netty → 自定义私有协议](../netty/6_custom_protocol.md)。本节在通用模式基础上加入 **CRC16 校验**，适配 IoT 设备接入场景。

### 私有协议帧格式

| 字段 | 字节数 | 说明 |
|------|--------|------|
| 帧头（Magic） | 2 | 固定值 `0xABCD`，用于同步帧边界 |
| 协议版本 | 1 | 当前版本号 |
| 命令字（Command） | 1 | 消息类型，如 `0x01` 数据上报、`0x10` PING、`0x11` PONG |
| 数据体长度（Length） | 2 | 数据体字节数（不含帧头和 CRC） |
| 数据体（Payload） | N | 业务数据，JSON 或二进制编码 |
| CRC 校验 | 2 | 对命令字 + 数据体做 CRC16 校验 |

### 协议帧 POJO

```java
@Data
public class DeviceMessage {
    /** 命令字常量 */
    public static final byte CMD_DATA  = 0x01;  // 设备数据上报
    public static final byte CMD_PING  = 0x10;  // 心跳请求
    public static final byte CMD_PONG  = 0x11;  // 心跳响应

    private short magic;     // 帧头，固定 0xABCD
    private byte  version;   // 协议版本
    private byte  command;   // 命令字
    private short length;    // 数据体长度
    private byte[] payload;  // 数据体
    private short crc;       // CRC16 校验值
}
```

### MessageDecoder（ByteToMessageDecoder）

```java
public class DeviceMessageDecoder extends ByteToMessageDecoder {

    private static final short MAGIC = (short) 0xABCD;
    // 帧头(2) + 版本(1) + 命令字(1) + 长度(2) + CRC(2) = 8 字节固定开销
    private static final int HEADER_LENGTH = 8;

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in,
                          List<Object> out) throws Exception {
        // 等待至少收到固定头部
        if (in.readableBytes() < HEADER_LENGTH) {
            return;
        }

        // 标记读指针，便于回退
        in.markReaderIndex();

        // 验证帧头
        short magic = in.readShort();
        if (magic != MAGIC) {
            // 帧头不匹配，跳过一个字节重新寻找同步点
            in.resetReaderIndex();
            in.skipBytes(1);
            return;
        }

        byte  version = in.readByte();
        byte  command = in.readByte();
        short length  = in.readShort();

        // 等待完整数据体 + CRC
        if (in.readableBytes() < length + 2) {
            in.resetReaderIndex();
            return;
        }

        byte[] payload = new byte[length];
        in.readBytes(payload);
        short crc = in.readShort();

        // 验证 CRC
        short expectedCrc = CrcUtil.crc16(command, payload);
        if (crc != expectedCrc) {
            // CRC 校验失败，丢弃当前帧
            ctx.fireExceptionCaught(new IllegalStateException(
                "CRC 校验失败，expected=" + expectedCrc + ", actual=" + crc));
            return;
        }

        DeviceMessage msg = new DeviceMessage();
        msg.setMagic(magic);
        msg.setVersion(version);
        msg.setCommand(command);
        msg.setLength(length);
        msg.setPayload(payload);
        msg.setCrc(crc);
        out.add(msg);
    }
}
```

### CRC 工具类

```java
public class CrcUtil {
    /** CRC16/MODBUS 算法 */
    public static short crc16(byte command, byte[] payload) {
        int crc = 0xFFFF;
        crc ^= (command & 0xFF);
        for (int i = 0; i < 8; i++) {
            if ((crc & 0x0001) != 0) {
                crc = (crc >>> 1) ^ 0xA001;
            } else {
                crc >>>= 1;
            }
        }
        for (byte b : payload) {
            crc ^= (b & 0xFF);
            for (int i = 0; i < 8; i++) {
                if ((crc & 0x0001) != 0) {
                    crc = (crc >>> 1) ^ 0xA001;
                } else {
                    crc >>>= 1;
                }
            }
        }
        return (short) crc;
    }
}
```

### 业务 Handler（心跳 + 数据处理）

```java
@ChannelHandler.Sharable
public class DeviceBusinessHandler extends SimpleChannelInboundHandler<DeviceMessage> {

    private static final Logger log = LoggerFactory.getLogger(DeviceBusinessHandler.class);

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, DeviceMessage msg) {
        switch (msg.getCommand()) {
            case DeviceMessage.CMD_PING:
                // 收到 PING，回复 PONG
                DeviceMessage pong = buildPong();
                ctx.writeAndFlush(pong);
                log.debug("收到心跳 PING，已回复 PONG，channel={}", ctx.channel().id());
                break;
            case DeviceMessage.CMD_DATA:
                // 处理设备数据上报
                String json = new String(msg.getPayload(), StandardCharsets.UTF_8);
                log.info("收到设备数据：{}", json);
                // 推送到消息队列或时序数据库...
                break;
            default:
                log.warn("未知命令字：0x{}", Integer.toHexString(msg.getCommand()));
        }
    }

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
        if (evt instanceof IdleStateEvent) {
            IdleStateEvent idleEvent = (IdleStateEvent) evt;
            if (idleEvent.state() == IdleState.READER_IDLE) {
                // 设备 30s 未发送任何数据（含心跳），关闭连接
                log.warn("设备心跳超时，关闭连接：{}", ctx.channel().remoteAddress());
                ctx.close();
            }
        }
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        log.error("连接异常：{}，原因：{}", ctx.channel().remoteAddress(), cause.getMessage());
        ctx.close();
    }

    private DeviceMessage buildPong() {
        DeviceMessage pong = new DeviceMessage();
        pong.setMagic((short) 0xABCD);
        pong.setVersion((byte) 1);
        pong.setCommand(DeviceMessage.CMD_PONG);
        pong.setPayload(new byte[0]);
        pong.setLength((short) 0);
        pong.setCrc(CrcUtil.crc16(DeviceMessage.CMD_PONG, new byte[0]));
        return pong;
    }
}
```

### ChannelInitializer 组装 Pipeline

```java
@Component
public class DeviceServerInitializer extends ChannelInitializer<SocketChannel> {

    private final DeviceBusinessHandler businessHandler;

    public DeviceServerInitializer(DeviceBusinessHandler businessHandler) {
        this.businessHandler = businessHandler;
    }

    @Override
    protected void initChannel(SocketChannel ch) {
        ChannelPipeline pipeline = ch.pipeline();

        // 1. 基于长度字段的帧解码器（处理 TCP 粘包/拆包）
        //    lengthFieldOffset=4（magic2+version1+command1），lengthFieldLength=2
        pipeline.addLast(new LengthFieldBasedFrameDecoder(
            65536,   // 最大帧长度
            4,       // 长度字段偏移量（跳过 magic+version+command）
            2,       // 长度字段字节数
            2,       // 长度字段值需额外加上 CRC 的 2 字节
            0        // 不跳过任何初始字节（解码器保留完整帧）
        ));

        // 2. 自定义消息解码器
        pipeline.addLast(new DeviceMessageDecoder());

        // 3. 心跳检测：读空闲 30s 触发 IdleStateEvent
        pipeline.addLast(new IdleStateHandler(30, 0, 0, TimeUnit.SECONDS));

        // 4. 业务处理（Sharable，可共享单例）
        pipeline.addLast(businessHandler);
    }
}
```

### Netty Server 启动

```java
@Component
public class DeviceServer implements ApplicationRunner {

    @Value("${iot.server.port:9000}")
    private int port;

    private final DeviceServerInitializer initializer;

    public DeviceServer(DeviceServerInitializer initializer) {
        this.initializer = initializer;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        EventLoopGroup bossGroup   = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup();
        try {
            ServerBootstrap bootstrap = new ServerBootstrap();
            bootstrap.group(bossGroup, workerGroup)
                     .channel(NioServerSocketChannel.class)
                     .option(ChannelOption.SO_BACKLOG, 1024)
                     .childOption(ChannelOption.TCP_NODELAY, true)
                     .childHandler(initializer);

            ChannelFuture future = bootstrap.bind(port).sync();
            System.out.println("设备接入服务器启动，监听端口：" + port);
            future.channel().closeFuture().sync();
        } finally {
            bossGroup.shutdownGracefully();
            workerGroup.shutdownGracefully();
        }
    }
}
```

---

## 七、OTA 升级服务实现

### OTA 升级整体流程

```
平台创建升级任务
      ↓
MQTT 下发升级指令到设备（devices/{deviceId}/ota/command）
      ↓
设备收到指令 → 从 firmwareUrl 下载固件包
      ↓
设备校验 MD5 签名
      ↓
设备安装固件（断电重启）
      ↓
设备上报升级结果（devices/{deviceId}/ota/status）
      ↓
平台更新任务状态
```

### OTA 任务状态机

```java
public enum OtaStatus {
    PENDING,      // 任务已创建，等待下发
    NOTIFIED,     // 指令已下发到设备
    DOWNLOADING,  // 设备正在下载固件
    INSTALLING,   // 设备正在安装固件
    SUCCESS,      // 升级成功
    FAILED;       // 升级失败

    /** 判断是否可以流转到目标状态 */
    public boolean canTransitionTo(OtaStatus next) {
        switch (this) {
            case PENDING:     return next == NOTIFIED;
            case NOTIFIED:    return next == DOWNLOADING || next == FAILED;
            case DOWNLOADING: return next == INSTALLING || next == FAILED;
            case INSTALLING:  return next == SUCCESS    || next == FAILED;
            default:          return false; // 终态不可再流转
        }
    }
}
```

### OTA 任务实体

```java
@Entity
@Table(name = "ota_task")
@Data
public class OtaTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String deviceId;
    private String firmwareUrl;    // 固件包下载地址（OSS / MinIO）
    private String version;        // 目标固件版本
    private String md5;            // 固件包 MD5，用于设备端校验

    @Enumerated(EnumType.STRING)
    private OtaStatus status;

    private String failReason;     // 失败原因
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
```

### 创建升级任务接口

```java
@RestController
@RequestMapping("/api/ota")
public class OtaController {

    @Autowired
    private OtaService otaService;

    /**
     * 创建 OTA 升级任务
     * POST /api/ota/task
     * Body: { "deviceIds": ["d001","d002"], "firmwareUrl": "...", "version": "2.1.0", "md5": "..." }
     */
    @PostMapping("/task")
    public ResponseEntity<List<OtaTask>> createTask(@RequestBody OtaTaskRequest request) {
        List<OtaTask> tasks = otaService.createTasks(request);
        return ResponseEntity.ok(tasks);
    }
}
```

### OTA 核心 Service

```java
@Service
@Slf4j
public class OtaService {

    @Autowired
    private OtaTaskRepository taskRepo;

    @Autowired
    private MqttGateway mqttGateway;  // Spring Integration MQTT 出站网关

    @Autowired
    private ObjectMapper objectMapper;

    /** 批量创建升级任务并立即下发 MQTT 指令 */
    public List<OtaTask> createTasks(OtaTaskRequest request) {
        return request.getDeviceIds().stream().map(deviceId -> {
            OtaTask task = new OtaTask();
            task.setDeviceId(deviceId);
            task.setFirmwareUrl(request.getFirmwareUrl());
            task.setVersion(request.getVersion());
            task.setMd5(request.getMd5());
            task.setStatus(OtaStatus.PENDING);
            task.setCreatedAt(LocalDateTime.now());
            taskRepo.save(task);

            // 下发 MQTT 升级指令
            sendOtaCommand(task);
            task.setStatus(OtaStatus.NOTIFIED);
            return taskRepo.save(task);
        }).collect(Collectors.toList());
    }

    /** 向设备下发 OTA 升级指令 */
    private void sendOtaCommand(OtaTask task) {
        try {
            Map<String, Object> command = new HashMap<>();
            command.put("taskId",      task.getId());
            command.put("firmwareUrl", task.getFirmwareUrl());
            command.put("version",     task.getVersion());
            command.put("md5",         task.getMd5());

            String payload = objectMapper.writeValueAsString(command);
            String topic   = "devices/" + task.getDeviceId() + "/ota/command";
            mqttGateway.sendToMqtt(topic, payload);
            log.info("OTA 指令已下发，deviceId={}, version={}", task.getDeviceId(), task.getVersion());
        } catch (JsonProcessingException e) {
            throw new RuntimeException("OTA 指令序列化失败", e);
        }
    }

    /**
     * 处理设备上报的 OTA 状态
     * 订阅 Topic：devices/+/ota/status
     */
    @ServiceActivator(inputChannel = "mqttInputChannel")
    public void handleOtaStatus(Message<String> message) {
        String topic = (String) message.getHeaders().get(MqttHeaders.RECEIVED_TOPIC);
        // 过滤非 OTA 状态上报
        if (topic == null || !topic.endsWith("/ota/status")) {
            return;
        }
        String deviceId = topic.split("/")[1];

        try {
            Map<String, Object> status = objectMapper.readValue(
                message.getPayload(), new TypeReference<>() {});

            Long      taskId    = Long.valueOf(status.get("taskId").toString());
            OtaStatus newStatus = OtaStatus.valueOf(status.get("status").toString().toUpperCase());
            String    reason    = (String) status.getOrDefault("reason", null);

            OtaTask task = taskRepo.findById(taskId)
                .orElseThrow(() -> new IllegalArgumentException("OTA 任务不存在：" + taskId));

            if (task.getStatus().canTransitionTo(newStatus)) {
                task.setStatus(newStatus);
                task.setFailReason(reason);
                task.setUpdatedAt(LocalDateTime.now());
                taskRepo.save(task);
                log.info("OTA 状态更新，deviceId={}, taskId={}, status={}", deviceId, taskId, newStatus);
            } else {
                log.warn("非法 OTA 状态流转，当前={}, 目标={}", task.getStatus(), newStatus);
            }
        } catch (Exception e) {
            log.error("处理 OTA 状态上报失败，topic={}", topic, e);
        }
    }
}
```

### 固件包 MD5 校验工具（Java 服务端生成 MD5）

```java
import java.io.InputStream;
import java.security.MessageDigest;

public class FirmwareUtil {

    /** 计算输入流的 MD5 十六进制字符串 */
    public static String md5Hex(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("MD5");
        byte[] buffer = new byte[8192];
        int len;
        while ((len = input.read(buffer)) != -1) {
            digest.update(buffer, 0, len);
        }
        byte[] hash = digest.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /** 上传固件文件时同步计算并保存 MD5，供 OTA 任务使用 */
    public static String computeAndVerify(InputStream input, String expectedMd5) throws Exception {
        String actual = md5Hex(input);
        if (!actual.equalsIgnoreCase(expectedMd5)) {
            throw new IllegalStateException(
                "固件 MD5 校验失败，expected=" + expectedMd5 + ", actual=" + actual);
        }
        return actual;
    }
}
```

---

## 八、规则引擎设计

### 规则引擎的作用

IoT 平台需要对设备实时数据做条件判断并触发动作：

- **告警**：温度 > 80℃ → 推送钉钉告警
- **联动控制**：烟雾传感器触发 → 下发关闭风机指令
- **数据转发**：特定设备数据 → 转发到第三方 Webhook

### 数据模型

```java
/** 规则 */
@Entity
@Table(name = "iot_rule")
@Data
public class Rule {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;        // 规则名称
    private String deviceId;    // 适用设备（null 表示所有设备）
    private boolean enabled;    // 是否启用

    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    private List<Condition> conditions;  // 触发条件（AND 关系）

    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    private List<Action> actions;        // 触发后执行的动作
}

/** 条件 */
@Entity
@Table(name = "iot_rule_condition")
@Data
public class Condition {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String field;       // 设备数据字段名，如 "temperature"
    private String operator;    // 运算符：GT / GTE / LT / LTE / EQ / NEQ
    private Double threshold;   // 阈值
}

/** 动作 */
@Entity
@Table(name = "iot_rule_action")
@Data
public class Action {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    private ActionType type;    // ALARM / COMMAND / WEBHOOK

    private String target;      // 告警接收人 / 设备 ID / Webhook URL
    private String template;    // 消息模板或指令内容
}

public enum ActionType {
    ALARM,    // 发送告警通知
    COMMAND,  // 下发设备控制指令
    WEBHOOK   // 调用外部 Webhook
}
```

### 设备数据 VO

```java
@Data
public class DeviceData {
    private String deviceId;
    private LocalDateTime timestamp;
    /** 设备上报的数据字段，如 {"temperature": 85.0, "humidity": 40.0} */
    private Map<String, Double> metrics;
}
```

### 规则引擎核心执行逻辑

```java
@Service
@Slf4j
public class RuleEngine {

    @Autowired
    private RuleRepository ruleRepo;

    @Autowired
    private ActionExecutor actionExecutor;

    /**
     * 对一条设备数据执行所有匹配的规则
     * 由 MQTT 消息处理器调用
     */
    public void evaluate(DeviceData data) {
        // 从缓存加载规则（Redis 热更新，见下文）
        List<Rule> rules = loadRules(data.getDeviceId());

        for (Rule rule : rules) {
            if (!rule.isEnabled()) {
                continue;
            }
            if (matchAllConditions(rule.getConditions(), data)) {
                log.info("规则触发，ruleId={}, deviceId={}", rule.getId(), data.getDeviceId());
                rule.getActions().forEach(action -> actionExecutor.execute(action, data));
            }
        }
    }

    /** 条件匹配（ALL 条件均满足才触发） */
    private boolean matchAllConditions(List<Condition> conditions, DeviceData data) {
        return conditions.stream().allMatch(cond -> {
            Double value = data.getMetrics().get(cond.getField());
            if (value == null) {
                return false;
            }
            switch (cond.getOperator()) {
                case "GT":  return value >  cond.getThreshold();
                case "GTE": return value >= cond.getThreshold();
                case "LT":  return value <  cond.getThreshold();
                case "LTE": return value <= cond.getThreshold();
                case "EQ":  return value.equals(cond.getThreshold());
                case "NEQ": return !value.equals(cond.getThreshold());
                default:
                    log.warn("未知运算符：{}", cond.getOperator());
                    return false;
            }
        });
    }

    /** 优先从 Redis 缓存加载规则，未命中则查数据库 */
    private List<Rule> loadRules(String deviceId) {
        // 加载：全局规则 + 该设备专属规则
        List<Rule> rules = new ArrayList<>(ruleRepo.findByDeviceIdIsNullAndEnabledTrue());
        rules.addAll(ruleRepo.findByDeviceIdAndEnabledTrue(deviceId));
        return rules;
    }
}
```

### 动作执行器

```java
@Service
@Slf4j
public class ActionExecutor {

    @Autowired
    private MqttGateway mqttGateway;

    @Autowired
    private RestTemplate restTemplate;

    @Autowired
    private AlarmNotifier alarmNotifier;

    public void execute(Action action, DeviceData data) {
        try {
            switch (action.getType()) {
                case ALARM:
                    // 渲染告警消息模板并发送通知
                    String message = renderTemplate(action.getTemplate(), data);
                    alarmNotifier.send(action.getTarget(), message);
                    break;
                case COMMAND:
                    // 向目标设备下发指令
                    String topic = "devices/" + action.getTarget() + "/command";
                    mqttGateway.sendToMqtt(topic, action.getTemplate());
                    log.info("联动指令已下发，设备={}, 指令={}", action.getTarget(), action.getTemplate());
                    break;
                case WEBHOOK:
                    // 调用外部 Webhook
                    Map<String, Object> body = new HashMap<>();
                    body.put("deviceId",  data.getDeviceId());
                    body.put("timestamp", data.getTimestamp().toString());
                    body.put("metrics",   data.getMetrics());
                    restTemplate.postForEntity(action.getTarget(), body, String.class);
                    break;
            }
        } catch (Exception e) {
            log.error("规则动作执行失败，actionType={}, target={}", action.getType(), action.getTarget(), e);
        }
    }

    private String renderTemplate(String template, DeviceData data) {
        // 简单替换占位符，如 "设备 {deviceId} 温度超标：{temperature}"
        String result = template.replace("{deviceId}", data.getDeviceId());
        for (Map.Entry<String, Double> entry : data.getMetrics().entrySet()) {
            result = result.replace("{" + entry.getKey() + "}", String.valueOf(entry.getValue()));
        }
        return result;
    }
}
```

### 规则热更新（Redis 缓存 + 无重启更新）

```java
@Service
public class RuleCacheService {

    private static final String CACHE_KEY_PREFIX = "iot:rules:";

    @Autowired
    private RedisTemplate<String, Object> redis;

    @Autowired
    private RuleRepository ruleRepo;

    /** 加载并缓存规则，TTL 5 分钟 */
    public List<Rule> getCachedRules(String deviceId) {
        String key = CACHE_KEY_PREFIX + deviceId;
        Object cached = redis.opsForValue().get(key);
        if (cached != null) {
            return (List<Rule>) cached;
        }
        List<Rule> rules = ruleRepo.findByDeviceIdAndEnabledTrue(deviceId);
        redis.opsForValue().set(key, rules, 5, TimeUnit.MINUTES);
        return rules;
    }

    /** 规则变更时主动清除缓存，下次访问自动重新加载 */
    public void invalidate(String deviceId) {
        redis.delete(CACHE_KEY_PREFIX + deviceId);
        redis.delete(CACHE_KEY_PREFIX + "global"); // 同时清除全局规则缓存
    }
}
```

> 规则持久化建议：规则数据存 MySQL，由运维平台 CRUD 管理；Redis 作二级缓存，TTL 5 分钟；规则变更时调用 `invalidate()` 主动失效，无需重启服务即可生效。

---

## 九、多协议网关实战

### 多协议网关定位

```
设备层                    网关层                      平台层
──────────────           ────────────────────         ──────────────
MQTT 设备      →         MqttConnector               ↗
Modbus 设备    →         ModbusConnector    →  MessageBus  →  平台 MQTT Broker
OPC-UA 设备    →         OpcUaConnector              ↘         （统一 Topic）
```

网关的职责：
1. 各协议 Connector 独立接入对应设备
2. 将各协议原始数据转换为统一的 `DeviceMessage` 格式
3. 通过内部 MessageBus（内存队列或 Kafka）解耦各协议处理
4. 统一发布到平台 MQTT Broker

### 协议连接器接口

```java
public interface ProtocolConnector {

    /** 启动连接器，开始接收设备数据 */
    void start();

    /** 停止连接器，释放资源 */
    void stop();

    /** 返回该连接器支持的协议名称 */
    String getProtocol();
}
```

### 统一消息格式

```java
@Data
@Builder
public class DeviceMessage {
    private String deviceId;     // 设备 ID
    private String protocol;     // 接入协议：mqtt / modbus / opcua
    private long   timestamp;    // 数据时间戳（毫秒）
    /** 原始数据，JSON 格式，如 {"temperature": 36.5, "humidity": 60} */
    private String payload;
}
```

### 内部消息总线

```java
@Component
public class MessageBus {

    /** 使用 LinkedBlockingQueue 作为内存消息总线，容量 10000 */
    private final BlockingQueue<DeviceMessage> queue = new LinkedBlockingQueue<>(10000);

    public void publish(DeviceMessage message) {
        if (!queue.offer(message)) {
            // 队列满时丢弃最旧消息（或记录指标）
            queue.poll();
            queue.offer(message);
        }
    }

    public DeviceMessage consume(long timeoutMs) throws InterruptedException {
        return queue.poll(timeoutMs, TimeUnit.MILLISECONDS);
    }
}
```

### MQTT Connector 实现

```java
@Component
@Slf4j
public class MqttConnector implements ProtocolConnector {

    @Value("${iot.gateway.mqtt.broker:tcp://localhost:1883}")
    private String broker;

    @Autowired
    private MessageBus messageBus;

    private MqttClient client;

    @Override
    public void start() {
        try {
            client = new MqttClient(broker, "gateway-mqtt-" + System.currentTimeMillis());
            MqttConnectOptions opts = new MqttConnectOptions();
            opts.setCleanSession(true);
            client.connect(opts);

            // 订阅所有设备上报的原始数据
            client.subscribe("raw/+/data", 1, (topic, message) -> {
                String deviceId = topic.split("/")[1];
                DeviceMessage msg = DeviceMessage.builder()
                    .deviceId(deviceId)
                    .protocol(getProtocol())
                    .timestamp(System.currentTimeMillis())
                    .payload(new String(message.getPayload(), StandardCharsets.UTF_8))
                    .build();
                messageBus.publish(msg);
            });
            log.info("MQTT Connector 已启动，连接到 {}", broker);
        } catch (MqttException e) {
            throw new RuntimeException("MQTT Connector 启动失败", e);
        }
    }

    @Override
    public void stop() {
        try {
            if (client != null && client.isConnected()) {
                client.disconnect();
            }
        } catch (MqttException e) {
            log.warn("MQTT Connector 停止异常", e);
        }
    }

    @Override
    public String getProtocol() {
        return "mqtt";
    }
}
```

### Modbus Connector 实现（轮询读取）

```java
@Component
@Slf4j
public class ModbusConnector implements ProtocolConnector {

    @Value("${iot.gateway.modbus.host:192.168.1.100}")
    private String modbusHost;

    @Value("${iot.gateway.modbus.port:502}")
    private int modbusPort;

    @Autowired
    private MessageBus messageBus;

    private volatile boolean running = false;
    private Thread pollThread;

    @Override
    public void start() {
        running = true;
        pollThread = new Thread(this::pollLoop, "modbus-poll-thread");
        pollThread.setDaemon(true);
        pollThread.start();
        log.info("Modbus Connector 已启动，轮询 {}:{}", modbusHost, modbusPort);
    }

    private void pollLoop() {
        while (running) {
            try {
                readAndPublish();
                Thread.sleep(5000);  // 每 5 秒轮询一次
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                log.error("Modbus 轮询异常", e);
                try { Thread.sleep(10000); } catch (InterruptedException ie) { break; }
            }
        }
    }

    private void readAndPublish() throws Exception {
        TCPMasterConnection conn = null;
        try {
            conn = new TCPMasterConnection(InetAddress.getByName(modbusHost));
            conn.setPort(modbusPort);
            conn.connect();

            // 读取保持寄存器 0-9，对应温度/湿度/电压等
            ReadMultipleRegistersRequest req = new ReadMultipleRegistersRequest(0, 10);
            req.setUnitID(1);
            ModbusTCPTransaction tx = new ModbusTCPTransaction(conn);
            tx.setRequest(req);
            tx.execute();

            ReadMultipleRegistersResponse resp =
                (ReadMultipleRegistersResponse) tx.getResponse();

            // 将寄存器值转换为 JSON（按业务映射寄存器含义）
            Map<String, Object> metrics = new LinkedHashMap<>();
            metrics.put("temperature", resp.getRegisterValue(0) / 10.0);  // 寄存器 0：温度，精度 0.1℃
            metrics.put("humidity",    resp.getRegisterValue(1) / 10.0);  // 寄存器 1：湿度，精度 0.1%
            metrics.put("voltage",     resp.getRegisterValue(2) / 100.0); // 寄存器 2：电压，精度 0.01V

            String payload = new ObjectMapper().writeValueAsString(metrics);

            // 构造统一消息并发布到 MessageBus
            DeviceMessage msg = DeviceMessage.builder()
                .deviceId("modbus-device-001")
                .protocol(getProtocol())
                .timestamp(System.currentTimeMillis())
                .payload(payload)
                .build();
            messageBus.publish(msg);
            log.debug("Modbus 数据已采集并发布：{}", payload);

        } finally {
            if (conn != null) {
                conn.close();
            }
        }
    }

    @Override
    public void stop() {
        running = false;
        if (pollThread != null) {
            pollThread.interrupt();
        }
    }

    @Override
    public String getProtocol() {
        return "modbus";
    }
}
```

### 统一数据处理器（MessageBus → 平台 MQTT）

```java
@Component
@Slf4j
public class GatewayDataProcessor implements ApplicationRunner {

    @Autowired
    private MessageBus messageBus;

    @Autowired
    private MqttGateway mqttGateway;  // 向平台 MQTT Broker 发布

    @Autowired
    private ObjectMapper objectMapper;

    @Override
    public void run(ApplicationArguments args) {
        Thread processorThread = new Thread(this::processLoop, "gateway-processor");
        processorThread.setDaemon(true);
        processorThread.start();
        log.info("网关数据处理器已启动");
    }

    private void processLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                DeviceMessage msg = messageBus.consume(1000);
                if (msg == null) {
                    continue;
                }
                // 转换并发布到平台统一 Topic：platform/devices/{deviceId}/data
                String platformTopic   = "platform/devices/" + msg.getDeviceId() + "/data";
                String platformPayload = buildPlatformPayload(msg);
                mqttGateway.sendToMqtt(platformTopic, platformPayload);
                log.debug("已转发到平台，deviceId={}, protocol={}", msg.getDeviceId(), msg.getProtocol());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                log.error("网关数据处理异常", e);
            }
        }
    }

    private String buildPlatformPayload(DeviceMessage msg) throws Exception {
        Map<String, Object> platform = new LinkedHashMap<>();
        platform.put("deviceId",  msg.getDeviceId());
        platform.put("protocol",  msg.getProtocol());
        platform.put("timestamp", msg.getTimestamp());
        platform.put("data",      objectMapper.readValue(msg.getPayload(), Map.class));
        return objectMapper.writeValueAsString(platform);
    }
}
```

### Spring Boot 启动所有 Connector

```java
@Configuration
@Slf4j
public class GatewayConfig {

    /**
     * 注入所有 ProtocolConnector 实现，@PostConstruct 统一启动
     * 新增协议只需实现 ProtocolConnector 接口并注册为 Spring Bean
     */
    @Autowired
    private List<ProtocolConnector> connectors;

    @PostConstruct
    public void startAllConnectors() {
        connectors.forEach(connector -> {
            try {
                connector.start();
                log.info("协议连接器已启动：{}", connector.getProtocol());
            } catch (Exception e) {
                log.error("协议连接器启动失败：{}", connector.getProtocol(), e);
            }
        });
    }

    @PreDestroy
    public void stopAllConnectors() {
        connectors.forEach(connector -> {
            try {
                connector.stop();
                log.info("协议连接器已停止：{}", connector.getProtocol());
            } catch (Exception e) {
                log.warn("协议连接器停止异常：{}", connector.getProtocol(), e);
            }
        });
    }
}
```

> 扩展新协议只需新增一个实现 `ProtocolConnector` 接口的 Spring Bean，无需修改现有代码，符合开闭原则。

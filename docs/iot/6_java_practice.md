# Java IoT 实战

> 参考资料：
> * Eclipse Paho Java：[https://eclipse.dev/paho/index.php?page=clients/java/index.php](https://eclipse.dev/paho/index.php?page=clients/java/index.php)
> * EMQX Java SDK：[https://www.emqx.com/zh/blog/how-to-use-mqtt-in-java](https://www.emqx.com/zh/blog/how-to-use-mqtt-in-java)
> * j2mod Modbus：[https://github.com/steveohara/j2mod](https://github.com/steveohara/j2mod)

## 一、技术栈全景

```
设备接入层      消息中间件        业务处理层            存储层
──────────     ──────────       ────────────────     ──────────
Netty          EMQX Broker      Spring Boot          TDengine
Eclipse Paho   Kafka            规则引擎服务           InfluxDB
j2mod                           设备影子服务           MySQL/Redis
Eclipse Milo                    OTA 服务
```

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

```
设备（MQTT / Modbus / HTTP）
    ↓
接入网关（Netty）
    ├── 协议解析（MQTT / Modbus / 私有协议）
    ├── 设备认证（查 Redis 验证 token）
    └── 消息分发 → Kafka
              ↓
        消息处理服务
            ├── 写入时序数据库
            ├── 触发规则引擎
            └── 更新设备状态（Redis）
```

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

> [!warning]
> 待补充：Netty 自定义私有协议接入、OTA 升级服务实现、规则引擎设计、多协议网关实战

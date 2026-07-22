# IoT 与工业协议

> 官方规范：[MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html) / [CoAP RFC 7252](https://www.rfc-editor.org/rfc/rfc7252.html) / [Modbus](https://www.modbus.org/specs.php) / [OPC UA](https://opcfoundation.org/)

---

## 一、MQTT

MQTT（Message Queuing Telemetry Transport）是基于发布/订阅模型的轻量级消息协议，运行在 TCP 之上，专为低带宽、高延迟、不稳定网络设计。

### 核心概念

```
Publisher (IoT Device)
    │── publish(topic, payload) ──►│
                                   │  MQTT Broker（如 EMQX、Mosquitto）
    ◄── publish ────────────────── │
Subscriber (应用服务)
```

| 概念 | 说明 |
|------|------|
| **Topic** | 消息路由路径，用 `/` 分层，如 `sensor/room1/temperature` |
| **Wildcard** | `+` 匹配单层（`sensor/+/temperature`），`#` 匹配多层（`sensor/#`）|
| **Retain** | Broker 保留最后一条消息，新订阅者立即收到历史值 |
| **Will Message** | 设备异常断线时 Broker 代为发布遗嘱消息，用于下线告警 |
| **Keep Alive** | 心跳间隔，超时未收到 PINGREQ 则断开连接 |

### QoS 三个等级

| QoS | 名称 | 语义 | 原理 | 适用 |
|-----|------|------|------|------|
| 0 | At most once | 最多一次，可能丢失 | 发后不管 | 实时传感器数据，少量丢失可接受 |
| 1 | At least once | 至少一次，可能重复 | 发后等 PUBACK，无响应重发 | 告警事件，业务层做幂等 |
| 2 | Exactly once | 精确一次 | 4 步握手（PUBLISH→PUBREC→PUBREL→PUBCOMP）| 计费、控制指令 |

### Java Paho 客户端

```xml
<dependency>
    <groupId>org.eclipse.paho</groupId>
    <artifactId>org.eclipse.paho.client.mqttv3</artifactId>
    <version>1.2.5</version>
</dependency>
```

```java
@Component
public class MqttService {

    private MqttClient client;

    @PostConstruct
    public void connect() throws MqttException {
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(false);           // 持久会话，重连后恢复订阅
        options.setKeepAliveInterval(60);
        options.setAutomaticReconnect(true);
        options.setUserName("user");
        options.setPassword("password".toCharArray());
        options.setWill("device/status", "offline".getBytes(), 1, true);

        client = new MqttClient("tcp://localhost:1883",
            "gateway-" + UUID.randomUUID(), new MemoryPersistence());

        client.setCallback(new MqttCallbackExtended() {
            @Override
            public void connectComplete(boolean reconnect, String serverURI) {
                subscribeTopics();
            }
            @Override
            public void messageArrived(String topic, MqttMessage message) {
                log.info("Topic: {}, Payload: {}", topic, new String(message.getPayload()));
            }
            @Override public void deliveryComplete(IMqttDeliveryToken token) {}
            @Override public void connectionLost(Throwable cause) {}
        });

        client.connect(options);
        subscribeTopics();
    }

    private void subscribeTopics() {
        try {
            client.subscribe("sensor/+/temperature", 1);
        } catch (MqttException e) {
            log.error("Subscribe failed", e);
        }
    }

    public void publish(String topic, String payload, int qos) throws MqttException {
        MqttMessage message = new MqttMessage(payload.getBytes(StandardCharsets.UTF_8));
        message.setQos(qos);
        client.publish(topic, message);
    }
}
```

### EMQX（生产级 Broker）

```yaml
services:
  emqx:
    image: emqx/emqx:5.7
    ports:
      - "1883:1883"     # MQTT TCP
      - "8083:8083"     # MQTT over WebSocket
      - "8883:8883"     # MQTT over TLS
      - "18083:18083"   # 管理控制台
    volumes:
      - ./emqx_data:/opt/emqx/data
```

---

## 二、CoAP

CoAP（Constrained Application Protocol）是面向受限设备（MCU）的应用层协议，运行在 **UDP** 之上，比 MQTT 更轻量。

| 对比 | MQTT | CoAP |
|------|------|------|
| 传输层 | TCP | UDP |
| 模型 | 发布/订阅 | 请求/响应（类似 HTTP REST）|
| 消息大小 | 较小 | 极小（4 字节固定头）|
| 可靠性 | TCP 保证 | 应用层 ACK（CON/NON 消息类型）|
| 适用设备 | 网关、嵌入式 Linux | MCU、传感器节点（Arduino/STM32）|

---

## 三、Modbus（工业总线）

Modbus 是工业自动化领域最广泛的串行通信协议，用于 PLC、仪表与 SCADA 系统之间的通信。

| 变体 | 物理层 | 典型距离 | 特点 |
|------|--------|---------|------|
| Modbus RTU | RS-485 串口 | 1200m | 二进制紧凑，工厂现场总线 |
| Modbus TCP | 以太网 | 无限 | RTU 封装于 TCP，工业以太网主流 |
| Modbus ASCII | RS-232 | 15m | 可读 ASCII，调试用 |

```
主站（Master/Client） → 请求帧 → 从站（Slave/Server，地址 1-247）
从站 ← 响应帧 ← 主站
```

Java 可使用 [j2mod](https://github.com/steveohara/j2mod) 库进行 Modbus TCP 通信。

---

## 四、OPC UA（工业互联网）

OPC UA 是工业 IoT 的统一标准，独立于平台和厂商，内置证书认证 + 加密传输。

**常见架构**：设备 → OPC UA → 边缘网关 → MQTT → 云端平台 → Kafka/数据库

---

## 五、协议选型

| 场景 | 推荐 |
|------|------|
| 移动设备/嵌入式 Linux 接入云平台 | **MQTT** |
| MCU/低功耗传感器节点 | **CoAP** |
| 工厂 PLC、仪表、SCADA 通信 | **Modbus RTU/TCP** |
| 工业互联网、跨厂商设备互联 | **OPC UA** |
| 大规模设备数据流入大数据平台 | **MQTT → Kafka** |

---
description: 网关代子设备的主流模型对照、两种信任模型、本模块的网关 Topic 与拓扑表、拆包校验、级联离线、续传乱序与下行转发
---

# 网关与子设备

> 前置阅读：[设备安全](./1_security)、[设备注册与生命周期](./2_provisioning)、[Modbus 采集](./4_modbus)

Modbus 仪表、Zigbee 传感器、PLC 自己连不上平台，要由现场的网关代为接入，平台却仍要把每台子设备当作独立设备来管。本篇讲主流平台的网关模型、两种信任模型、本模块的网关 Topic 与拓扑表、级联离线与下行转发，基线为 JDK 21、Spring Boot 4、EMQX 6.x。

---

## 一、要解决的问题

### 1、两种「网关」不要混

| | 边缘网关（本篇） | 接入网关 |
|---|---|---|
| 位置 | 现场，和设备在同一个车间或楼宇 | 云侧，和平台在同一个机房 |
| 对平台来说是什么 | 一台设备，用自己的凭据连 Broker，代多台子设备收发 | 平台的一部分，替 Broker 承载私有协议的长连接 |
| 子设备 | 不会说 MQTT 或 TCP/IP，经现场总线（RS-485、Zigbee、蓝牙）挂在网关下 | 设备自己会联网，只是说私有协议 |
| 本模块的写法 | 本篇 | [Netty 接入网关](./6_netty_gateway) |

Azure IoT Edge 的文档把边缘网关分成三种模式，正好对应下面要讨论的身份问题：**透明网关**（子设备在云端有自己的身份，网关只转发）、**协议转换**（云端只认网关，子设备的数据看起来都来自网关）、**身份转换**（网关替子设备向云端提供身份，子设备在云端是一等设备，有自己的孪生与方法）。

### 2、平台要管住的四件事

- **身份**：哪台子设备挂在哪个网关下，网关说「这是 meter-01 的数据」能不能信
- **状态**：网关掉线时，它下面的子设备算不算离线
- **数据**：网关断网时缓存、恢复后补传，时间戳与顺序以谁为准
- **下行**：发给子设备的指令怎么经网关送达

---

## 二、主流平台怎么做

### 1、各家对照

| 平台 | 子设备身份 | 上下线与上报 | 下行 | 限制与现状 |
|------|-----------|-------------|------|-----------|
| 阿里云物联网平台 | 子设备有自己的 DeviceSecret；网关发 `/sys/{pk}/{dn}/thing/topo/add` 建拓扑关系，载荷带用子设备密钥算的签名；子设备也可以由网关代为动态注册 | 网关发 `/ext/session/{pk}/{dn}/combine/login`、`batch_login`、`logout`，参数含子设备的 productKey、deviceName、时间戳与签名 | 子设备上线后由网关代为收发；拓扑关系变化经 `…/thing/topo/change` 通知网关 | 一个网关同时在线的子设备不超过 2,000；拓扑添加单次最多 30 个，批量上线单次最多 50 个；文档已标为停止维护 |
| ThingsBoard Gateway MQTT API | 只认网关自己的凭据，子设备名写在载荷里 | `v1/gateway/connect` 载荷 `{"device":"Device A","type":"Sensor A"}`，设备不存在时自动创建（`type` 是设备配置，缺省为 default）；`v1/gateway/telemetry` 载荷 `{"Device A":[{"ts":…,"values":{…}}]}` | `v1/gateway/rpc`：下行 `{"device":…,"data":{"id":…,"method":…,"params":…}}`，应答 `{"device":…,"id":…,"data":…}` | 另有 `v1/gateway/attributes`、`v1/gateway/claim` |
| AWS IoT Greengrass V2 | 客户端设备（client device）本身就是 AWS IoT thing，持有自己的证书，clientId 必须等于 thing 名 | 连核心设备（core device）上的本地 Broker（Moquette 3.1.1 或 EMQX 5 组件），由 client device auth 组件认证并按设备组策略授权，MQTT bridge 组件把消息转到 IoT Core | 经 MQTT bridge 反向转发；shadow manager 可同步客户端设备的影子 | 离线认证要显式开启：凭据在核心设备上的保留时长 `clientDeviceTrustDurationMinutes` 默认 1 分钟，等于不开 |
| Azure IoT Edge | 透明网关：子设备有自己的 IoT Hub 身份，在 Hub 里设置 parent/child 关系；身份转换：网关代为提供身份 | 透明网关下子设备照常用 MQTT / AMQP 连网关 | 透明与身份转换下云端可以逐台寻址；协议转换下只能寻址网关，所有子设备共用网关的云到设备队列，最多 50 条 | 子设备只能有一个父设备，父设备默认最多 100 个子设备（`MaxConnectedClients` 可调） |
| 华为云 IoTDA | 子设备可由网关调用「网关新增子设备」接口、应用调用创建设备接口或在控制台添加 | 子设备状态由网关上报，网关上报不了时子设备状态不刷新；网关单次最多替 50 个子设备上报属性 | 网关订阅命令下发 Topic 代收 | 只有 MQTT 直连的设备能当网关 |
| EMQX | Broker 本身没有子设备概念，每个 MQTT 连接就是一个客户端 | — | — | 多协议网关（MQTT-SN、CoAP、LwM2M、OCPP、JT/T 808 等）是让非 MQTT 设备直连 Broker，每台仍是独立客户端，不是网关代子设备 |

### 2、两种信任模型

上表归结起来只有两种：

| | 子设备自带凭据 | 信任网关 |
|---|---|---|
| 代表 | 阿里云、Greengrass、Azure 透明网关 | ThingsBoard、Azure 协议转换与身份转换 |
| 平台认证谁 | 网关和每一台子设备 | 只有网关 |
| 子设备 ID 从哪来 | 子设备凭据里的身份，网关伪造不了 | 网关在载荷里声明，平台核对拓扑表 |
| 网关被攻破 | 只能截断或丢弃数据，伪造不了子设备 | 它名下全部子设备的数据都能伪造，但碰不到别的网关的子设备 |
| 前提与成本 | 子设备要能保存密钥、算签名；凭据分发与轮换随子设备数量增长 | 平台侧多一张拓扑表；网关要按高权限账号管理 |
| 适合 | 子设备是有 MCU 的智能终端 | Modbus 仪表、继电器这类没有计算能力也没有身份的存量设备 |

**本模块的示例采用信任网关**，与 ThingsBoard 的 Gateway API 同构，子设备在平台上是有独立 ID、独立影子的一等设备，相当于 Azure 说的身份转换。与 ThingsBoard 的差别有两处：子设备必须先在平台登记并绑定到网关，网关声明的未知设备不会被自动创建；Topic 里带网关 ID，这样 ACL 能把 Topic 绑定到网关的连接身份。

---

## 三、本模块的约定

![网关代子设备接入：拓扑、上报流程与信任模型](../../assets/iot/gateway-subdevice.svg)

### 1、Topic 与载荷

| Topic | 方向 | 载荷 | 说明 |
|-------|------|------|------|
| `gateways/{gatewayId}/status` | 网关 → 平台 | `{"online": true}` | 保留消息，同时是网关的遗嘱（`{"online": false}`） |
| `gateways/{gatewayId}/connect` | 网关 → 平台 | `{"device": "meter-01"}` | 声明这台子设备经本网关上线 |
| `gateways/{gatewayId}/disconnect` | 网关 → 平台 | `{"device": "meter-01"}` | 声明这台子设备下线（总线上轮询不到了） |
| `gateways/{gatewayId}/telemetry` | 网关 → 平台 | `{"meter-01": [{"ts": 1767225600000, "values": {"temperature": 25.3}}]}` | 按子设备分组，每台可以带多个时间点；`ts` 可省略，省略时用平台收到消息的时间 |
| `gateways/{gatewayId}/cmd` | 平台 → 网关 | `{"device": "meter-01", "id": "req-…", "method": "…", "params": {…}}` | 发给子设备的指令，见第四节第 4 小节 |
| `gateways/{gatewayId}/response` | 网关 → 平台 | `{"device": "meter-01", "id": "req-…", "code": 200, "data": {…}}` | 子设备指令的应答 |

`{gatewayId}` 就是网关连接时的 clientid，它自己也是一台在 [设备注册与生命周期](./2_provisioning) 里登记的设备，产品类型为网关。时序是：网关 CONNECT 并登记遗嘱 → 发布保留的 `status` 在线 → 逐台发 `connect` → 周期上报 `telemetry` → 子设备轮询不到时发 `disconnect`；网关自己异常掉线时 Broker 代发遗嘱。遥测载荷里每个时间点的形状与直连设备的 `devices/{deviceId}/telemetry` 相同，见 [通信协议 · Topic 约定](../1_basics/1_protocol#_7、topic-约定)。

### 2、拓扑表与绑定

```sql
CREATE TABLE gateway_subdevice (
    device_id  VARCHAR(64) PRIMARY KEY REFERENCES device (device_id),  -- 一台子设备同一时刻只挂一个网关
    gateway_id VARCHAR(64) NOT NULL REFERENCES device (device_id),
    bound_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gateway_subdevice_gateway ON gateway_subdevice (gateway_id);
```

- **绑定只走平台接口**：运维或应用在平台上把子设备绑到网关，网关自己声明的 `connect` 只用来报在线，不建立绑定。网关能自建绑定的话，被攻破的网关可以把任何还没绑定的设备拉到自己名下
- **子设备也走生命周期**：子设备照样有未激活、已激活、已禁用、已注销四个状态，禁用的子设备即使网关还在报也一律丢弃
- **主键是子设备**：一台子设备只能挂一个网关，与 Azure 的「子设备只能有一个父设备」一致；换网关见第四节

### 3、拆包成 TelemetryMessage

网关的上报进入平台后，拆成每台子设备各自的 `TelemetryMessage` 写进 Kafka 主题 `iot.telemetry`，下游与直连设备走同一条链路，不用知道数据是经网关来的。消息字段约定见 [遥测数据链路 · Topic 与消息约定](../3_platform/2_data#_1、topic-与消息约定)：

```java
public record GatewayPoint(Long ts, Map<String, Object> values) {}

@Component
public class GatewayTelemetryHandler {

    private static final Logger log = LoggerFactory.getLogger(GatewayTelemetryHandler.class);
    private static final TypeReference<Map<String, List<GatewayPoint>>> BATCH = new TypeReference<>() {};

    private final JsonMapper json;
    private final TopologyCache topology;            // 子设备 → 网关的绑定与子设备状态，绑定变更时主动失效
    private final KafkaTemplate<String, TelemetryMessage> kafka;
    private final Counter foreignDevice;
    private final Clock clock;
    // 构造器省略：foreignDevice = Counter.builder("iot.gateway.foreign_device").register(meters)

    @ServiceActivator(inputChannel = "gatewayTelemetryChannel")
    public void handle(@Header(MqttHeaders.RECEIVED_TOPIC) String topic, byte[] payload) {
        String gatewayId = topic.split("/")[1];      // gateways/{gatewayId}/telemetry，ACL 已把它绑定到网关的 clientid
        long receivedAt = clock.millis();
        Map<String, List<GatewayPoint>> batch = json.readValue(payload, BATCH);
        batch.forEach((deviceId, points) -> {
            if (!topology.isActiveAndBoundTo(deviceId, gatewayId)) {
                foreignDevice.increment();           // 载荷里的子设备不在这个网关名下，或已被禁用
                log.warn("gateway {} reported unbound device {}", gatewayId, deviceId);
                return;
            }
            for (GatewayPoint p : points) {
                if (p.values() == null || p.values().isEmpty()) {
                    continue;
                }
                long ts = p.ts() != null ? p.ts() : receivedAt;
                // 按子设备 ID 分区：同一台子设备的数据有序，与直连设备一致
                kafka.send("iot.telemetry", deviceId, new TelemetryMessage(deviceId, "mqtt", ts, p.values()));
            }
        });
    }
}
```

- **校验发生在平台，不在 Broker**：ACL 只能保证网关写的是自己的 `gateways/{gatewayId}/` 前缀，载荷里写的是哪台子设备 Broker 不看。所以网关遥测不适合用 EMQX 规则 SQL 直接转 Kafka，要经过能查拓扑表的订阅者，订阅与路由写法见 [MQTT 客户端 · 连接配置与入站路由](./3_mqtt_client#_3、连接配置与入站路由)
- **越权计数不带标签**：被拒的子设备 ID 只进日志与安全事件，指标不按网关或设备打标签，避免序列数随设备数膨胀
- **`protocol` 填 `mqtt`**：它表示消息进入平台的方式；子设备在现场用的是 Modbus 还是 Zigbee，属于设备档案，不放进遥测信封

### 4、ACL

网关账号由认证服务返回 `client_attrs.role = "gateway"`，文件规则只放行它自己前缀下的 Topic，规则写在 [设备安全 · 网关与采集器](./1_security#_5、网关与采集器-一条连接代多台设备)。按本篇的 Topic 表，网关需要发布 `gateways/${clientid}/status`、`connect`、`disconnect`、`telemetry`、`response`，订阅 `gateways/${clientid}/cmd`；平台服务账号反过来。所有规则都用 `${clientid}` 模板，规则条数与网关数、子设备数无关。

---

## 四、状态与边界情况

### 1、网关离线时子设备的状态

华为云的文档写得很直白：子设备状态由网关上报，网关上报不了，子设备状态就不刷新。平台不做处理的话，网关断电后它下面的几十台子设备会一直显示在线。本模块的规则：

| 事件 | 子设备状态 |
|------|-----------|
| 网关发 `connect` | 这台子设备在线 |
| 网关发 `disconnect` | 这台子设备离线，原因记为「网关报告」 |
| 网关 `status` 变为离线（遗嘱或 EMQX 的断开事件） | 网关名下全部子设备级联离线，原因记为「网关离线」 |
| 网关重新上线 | 子设备不自动恢复，等网关重新逐台发 `connect` |

网关重连后不自动恢复子设备，是因为网关重启期间总线上的设备可能已经变了；让网关重新声明一遍，状态才可信。在线状态的乱序问题（旧事件盖掉新状态）与直连设备相同，做法见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。

### 2、子设备换网关

现场改线、网关更换时子设备会挂到新网关下。流程是平台先解绑再绑定（一条 UPDATE 改 `gateway_id`），绑定生效后拓扑缓存失效：

- 新网关在绑定生效前发来的数据按越权丢弃，所以要先改绑定、再让新网关开始采集
- 旧网关之后还在发的数据同样被丢弃，这是想要的结果：两个网关同时轮询同一台仪表时，只认一个
- 子设备的历史数据、影子都挂在子设备 ID 上，换网关不影响

### 3、断网续传、乱序与时间戳

边缘网关的价值之一是断网时先存在本地：ThingsBoard IoT Gateway 把遥测缓冲在本地防止断网丢数据，Azure IoT Edge 网关也会存下送不出去的消息与孪生更新。恢复后补传带来三个问题：

- **时间戳以采样时刻为准**：Modbus 仪表多数没有时钟，`ts` 由网关在读到数据的那一刻打上，所以网关必须做 NTP 校时；平台对 `ts` 设合理范围（Conduit 的做法是「当前时间 − 30 天」到「当前时间 + 5 分钟」，见 [设备接入与鉴权 · 连接参数与上报格式](../4_practice/1_access#十、连接参数与上报格式)），越界的点丢弃并告警，说明网关时钟坏了
- **补传的数据是乱序的**：时序库按时间戳落库，乱序写入没问题；「最新值」这类状态要比较时间戳，旧数据不能盖掉新值
- **补传要限速**：上百个网关同时恢复、同时倾倒几个小时的积压，对平台就是一次流量风暴；网关侧按固定速率补传，与实时数据分开排队，见 [海量连接与连接风暴](./7_connection_storm)

### 4、下行指令

发给子设备的指令有两种送法：

| 做法 | 怎么做 | 代价 |
|------|--------|------|
| 网关订阅子设备的 Topic | 网关替每台子设备订阅 `devices/{子设备}/cmd`，ACL 按拓扑逐条授权 | ACL 规则数随子设备数增长：EMQX 内置数据库默认每个客户端最多 100 条规则（`max_rules`），一台子设备两条，默认只够 50 台 |
| 平台改写到网关的 Topic（本模块） | 平台查拓扑表，把发给 `meter-01` 的指令改投 `gateways/{gatewayId}/cmd`，载荷多一个 `device`；网关应答到 `gateways/{gatewayId}/response`，平台核对 `device` 归属后再按 `id` 配对 | 平台的指令服务多一步查拓扑；ACL 只要两条模板规则 |

本模块选第二种，与 ThingsBoard 的 `v1/gateway/rpc` 同构，差别是载荷不再嵌一层 `data`，直接是指令的标准形状加 `device` 字段，平台转回内部的应答消息后，下游分不出指令是直达还是经网关。请求 ID、超时、MQTT 5 的 Response Topic 等通用部分见 [指令下发与服务调用](../3_platform/4_command)；子设备不在线时（网关报了 `disconnect` 或网关离线），指令直接按离线处理，不往网关投。

子设备的影子与 OTA 也按子设备 ID 管理：期望值变化经上面这条改写后的指令通道送到网关，由网关翻译成写寄存器之类的现场操作，见 [设备影子](../3_platform/3_device_shadow)；子设备固件通常由网关代下载、代刷写，任务对象仍是子设备，见 [OTA 升级](../3_platform/5_ota)。

---

## 五、现成的网关软件

现场网关大多不用从头写：

| 软件 | 一句话 | 说明 |
|------|--------|------|
| ThingsBoard IoT Gateway | ThingsBoard 官方的开源网关，Apache 2.0 | 连接器覆盖 MQTT、Modbus、OPC UA、BACnet、BLE、CAN、SNMP 等，断网时把遥测缓冲在本地 |
| EMQX Neuron / Neuron | 工业协议网关，开源版 Neuron 为 LGPL-3.0 | 商业版原名 NeuronEX，现在叫 EMQX Neuron，官方称支持 70 多种工业协议；开源版的 Dashboard 已暂停开发与维护 |
| EdgeX Foundry | LF Edge 的边缘框架 | 南向 Device Service 对接设备协议，北向导出到 MQTT、Kafka，见 [边缘计算](../1_basics/4_edge) |
| Node-RED | OpenJS 基金会旗下的流式编程工具 | 浏览器里拖节点连线，适合原型和小规模现场集成 |

选型时看两件事：北向能不能按本篇的 Topic 与载荷输出（不行就在网关上加一层转换）；断网缓冲是落盘还是只在内存。自己写采集服务时的点表、轮询与解码见 [Modbus 采集](./4_modbus)。

---

## 六、常见坑

- **网关能自建绑定**：被攻破的网关把未绑定的设备都拉到自己名下。绑定只走平台接口
- **只认 Topic 不核对载荷**：ACL 管住了网关前缀，载荷里的子设备 ID 却没人查。平台拆包时必须核对拓扑表
- **网关离线后子设备一直在线**：没有做级联离线；网关重连后又把子设备全部置回在线
- **网关时钟不准**：补传的数据落到错误的时间，或被当成未来数据。网关要校时，平台要对 `ts` 设范围
- **按子设备逐条写 ACL**：内置数据库每个客户端默认最多 100 条规则，子设备一多就超限

---

## 小结

- 边缘网关是现场的一台设备，代不会联网的子设备收发；云侧的接入网关是平台的一部分，两者解决的问题不同
- 主流平台有两种信任模型：子设备自带凭据（阿里云、Greengrass、Azure 透明网关），网关只是通道；信任网关（ThingsBoard、Azure 身份转换），平台只认证网关、靠拓扑表核对子设备归属
- 本模块采用信任网关：`gateways/{gatewayId}/connect|disconnect|telemetry|status|cmd|response`，ACL 只需模板规则；绑定只走平台接口，拆包时逐台核对拓扑表，再拆成各子设备的 `TelemetryMessage`
- 网关离线时子设备级联离线，网关重连后等它重新声明；补传的数据以网关打的采样时间为准，要校时、限速、容忍乱序
- 下行指令由平台查拓扑表改投网关的 `cmd` Topic，避免按子设备逐条授权

## 参考资料

- 阿里云物联网平台 · 网关与子设备：[https://help.aliyun.com/zh/iot/user-guide/gateways-and-sub-devices](https://help.aliyun.com/zh/iot/user-guide/gateways-and-sub-devices)
- 阿里云物联网平台 · 子设备上下线：[https://help.aliyun.com/zh/iot/user-guide/connect-or-disconnect-sub-devices](https://help.aliyun.com/zh/iot/user-guide/connect-or-disconnect-sub-devices)
- 阿里云物联网平台 · 管理拓扑关系：[https://help.aliyun.com/zh/iot/user-guide/manage-topological-relationships](https://help.aliyun.com/zh/iot/user-guide/manage-topological-relationships)
- ThingsBoard · Gateway MQTT API：[https://thingsboard.io/docs/reference/gateway-mqtt-api/](https://thingsboard.io/docs/reference/gateway-mqtt-api/)
- ThingsBoard IoT Gateway：[https://github.com/thingsboard/thingsboard-gateway](https://github.com/thingsboard/thingsboard-gateway)
- AWS IoT Greengrass · Interact with local IoT devices：[https://docs.aws.amazon.com/greengrass/v2/developerguide/interact-with-local-iot-devices.html](https://docs.aws.amazon.com/greengrass/v2/developerguide/interact-with-local-iot-devices.html)
- AWS IoT Greengrass · Connect client devices to core devices：[https://docs.aws.amazon.com/greengrass/v2/developerguide/connect-client-devices.html](https://docs.aws.amazon.com/greengrass/v2/developerguide/connect-client-devices.html)
- AWS IoT Greengrass · Authenticating clients while offline：[https://docs.aws.amazon.com/greengrass/v2/developerguide/offline-authentication.html](https://docs.aws.amazon.com/greengrass/v2/developerguide/offline-authentication.html)
- Azure IoT Edge · Use IoT Edge as a gateway for downstream devices：[https://learn.microsoft.com/en-us/azure/iot-edge/iot-edge-as-gateway](https://learn.microsoft.com/en-us/azure/iot-edge/iot-edge-as-gateway)
- 华为云 IoTDA · 网关与子设备：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0052.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0052.html)
- 华为云 IoTDA · 网关上报子设备属性：[https://support.huaweicloud.com/api-iothub/iot_06_v5_7011.html](https://support.huaweicloud.com/api-iothub/iot_06_v5_7011.html)
- EMQX · Multi-Protocol Gateway：[https://docs.emqx.com/en/emqx/latest/gateway/gateway.html](https://docs.emqx.com/en/emqx/latest/gateway/gateway.html)
- EMQX · Built-in Database authorization（`max_rules`）：[https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html)
- EMQX Neuron 文档：[https://docs.emqx.com/en/neuronex/latest/](https://docs.emqx.com/en/neuronex/latest/)
- Neuron（开源版）：[https://github.com/emqx/neuron](https://github.com/emqx/neuron)
- Node-RED · About：[https://nodered.org/about/](https://nodered.org/about/)

> 下一篇：[Netty 接入网关](./6_netty_gateway)

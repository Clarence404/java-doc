---
description: MQTT 会话与 5.0、CoAP / LwM2M、LoRaWAN、NB-IoT、Modbus、OPC UA
---

# 通信协议

> **本篇目标**：讲清 MQTT 的 QoS、会话、保留消息、遗嘱和 5.0 新特性各自解决什么问题，知道 CoAP、LwM2M、LoRaWAN、NB-IoT、Zigbee、Modbus、OPC UA 分别用在哪一层、什么场景，能按场景做协议选型。
>
> **前置阅读**：[TCP 与 UDP](/protocols/1_tcp_udp)（MQTT 跑在 TCP 上，CoAP 跑在 UDP 上）

本篇只讲协议语义和选型。Java 客户端代码见 [MQTT 客户端](./6_mqtt_client) 和 [Modbus 采集](./7_modbus)，Broker 部署见 [平台选型](./2_platform)，TLS 与双向证书见 [HTTPS 与 TLS](/protocols/3_https_tls)。

---

## 一、协议总览

IoT 协议按所处层次分为三类，一个系统往往三类都会用到：现场设备用工业总线或无线接入连到网关，网关再用应用层协议把数据送上云。

| 类别 | 协议 | 解决什么 |
|------|------|---------|
| **应用层（消息传输）** | MQTT、CoAP / LwM2M、HTTP、AMQP | 设备或网关与云平台之间的数据交换 |
| **无线接入** | NB-IoT、LoRaWAN、Zigbee、BLE | 设备到网关或基站的最后一跳 |
| **工业总线** | Modbus、OPC UA | PLC、仪表与上位机、SCADA 之间的通信 |

---

## 二、MQTT

**MQTT（Message Queuing Telemetry Transport）**：基于发布 / 订阅模型的轻量级消息协议，运行在 TCP 之上（也可以跑在 WebSocket 上），由 OASIS 标准化，现行版本是 3.1.1 和 5.0。发布方和订阅方互不感知，全部经由 Broker 按 Topic 转发，这是它适合海量设备接入的根本原因。

![MQTT 发布 / 订阅模型](../assets/iot/mqtt-pubsub.svg)

### 1、核心概念

| 概念 | 说明 |
|------|------|
| Broker | 消息中间人，负责鉴权、按 Topic 匹配并转发消息（如 EMQX、Mosquitto） |
| Topic | 分层的消息路由路径，如 `factory/line1/temp` |
| 通配符 | `+` 匹配单层（`sensor/+/temperature`），`#` 匹配剩余所有层（`sensor/#`），只能用于订阅 |
| Client ID | 客户端在 Broker 上的唯一身份，会话按它保存；同一 Client ID 再次连接会把旧连接踢下线 |
| Keep Alive | 心跳间隔（秒）。客户端在这段时间内没有其他报文要发时发送 PINGREQ；Broker 在 1.5 倍 Keep Alive 内收不到客户端的任何报文就断开连接 |

### 2、QoS 三个等级

QoS 约定的是**一跳之内**的投递语义：发布方到 Broker 是一跳，Broker 到订阅方是另一跳，两跳各自按自己的 QoS 执行，订阅方实际收到的 QoS 取发布 QoS 与订阅 QoS 中的较小值。

![MQTT QoS 握手流程](../assets/iot/mqtt-qos-flow.svg)

| QoS | 语义 | 报文交互 | 适用 |
|-----|------|---------|------|
| 0 | 最多一次，可能丢 | 只发 PUBLISH | 高频遥测数据，丢一两条无所谓 |
| 1 | 至少一次，可能重复 | PUBLISH → PUBACK，未确认则重发 | 告警、事件，配合业务幂等 |
| 2 | 恰好一次 | PUBLISH → PUBREC → PUBREL → PUBCOMP | 重复执行代价大的指令 |

QoS 2 的「恰好一次」只在客户端与 Broker 之间成立，并不是端到端保证：Broker 宕机、订阅方处理失败、消息桥接到 Kafka 后再消费，都可能重复或丢失。重要指令仍然要在业务层带请求 ID 做幂等，并用响应消息确认执行结果。QoS 2 每条消息四次交互，吞吐明显低于 QoS 1，实践中大多数场景用 **QoS 1 + 业务幂等**。

### 3、会话、保留消息与遗嘱

**持久会话**：客户端以不清理会话的方式连接（3.1.1 的 `cleanSession=false`，5.0 的 `Clean Start=false` 且 Session Expiry Interval 大于 0）后，Broker 会按 Client ID 保存它的订阅关系，以及离线期间收到的 QoS 1 / 2 消息，客户端重连后继续投递。前提是 **Client ID 必须固定**，每次启动随机生成 Client ID 等于每次都开新会话。

**保留消息（Retained Message）**：发布时带 retain 标志，Broker 会为该 Topic 只保存最新一条，新订阅者订阅时立即收到。适合设备在线状态、最新配置这类「订阅即需要当前值」的数据；发布一条空 payload 的保留消息即可清除。

**遗嘱消息（Will Message）**：客户端在 CONNECT 时登记一条遗嘱，非正常断开（网络中断、心跳超时）时由 Broker 代为发布，正常发送 DISCONNECT 则不发布。常见用法是遗嘱 Topic 设为 `devices/{clientId}/status`、payload 为 `offline`、带 retain，上线后再发一条 `online` 的保留消息覆盖。遗嘱 Topic 要按设备区分，所有设备共用一个 Topic 会互相覆盖。

### 4、MQTT 5.0 新特性

MQTT 5.0 于 2019 年成为 OASIS 标准，协议主体与 3.1.1 一致，增加的是工程上常用的能力。

**原因码（Reason Code）**：CONNACK、PUBACK、SUBACK、DISCONNECT 等报文都带具体原因码，排查连接失败、发布被拒不再靠猜。常见的几个：

| 原因码 | 含义 |
|--------|------|
| `0x00` | 成功 |
| `0x80` | 未指明的错误 |
| `0x87` | 未授权（如 ACL 拒绝） |
| `0x94` | Topic 别名无效 |
| `0x97` | 超出配额（如限流） |
| `0x9B` | 不支持该 QoS |
| `0x9E` | 不支持共享订阅 |

**共享订阅（Shared Subscription）**：订阅 `$share/{group}/{topic}`，同一组内的多个订阅者分摊消息，每条消息只投递给组内一个成员，类似 Kafka 的消费者组。后端多实例消费设备数据时用它做负载均衡，避免每个实例都收到全量消息。例如三个实例都订阅 `$share/worker/devices/+/data`，每条设备数据只会被其中一个实例处理。组内的分配策略（随机、轮询、按 Client ID 哈希等）由 Broker 决定，不由协议规定。

**消息过期（Message Expiry Interval）**：发布时设置有效期（秒），过期后 Broker 不再投递给订阅者。适合有时效的控制指令，避免设备离线很久后上线收到早已失效的命令。

**用户属性（User Properties）**：消息上附带任意键值对，作用类似 HTTP Header，可用来传追踪 ID、协议版本、数据格式，不必改动 payload。

**请求 / 响应（Request / Response）**：请求方在 PUBLISH 中带上 Response Topic 和 Correlation Data，响应方处理完后发布到 Response Topic，并把 Correlation Data 原样带回，请求方据此找到对应请求。平台给设备下发指令并等待执行结果就是这种模式。

![MQTT 5.0 请求 / 响应](../assets/iot/mqtt5-request-response.svg)

**Clean Start 与 Session Expiry Interval**：3.1.1 的 `cleanSession` 一个布尔值同时决定「连接时是否丢弃旧会话」和「断开后是否保留会话」，5.0 把它拆成两个字段。Clean Start 只管连接时是否新建会话；Session Expiry Interval 管断开后会话保留多久，0 表示断开即清除，`0xFFFFFFFF` 表示永不过期，其他值表示保留的秒数。

**Topic 别名（Topic Alias）**：连接内用一个 2 字节整数代替很长的 Topic 字符串，减少高频小报文的带宽开销。

### 5、3.1.1 与 5.0 对比

| 特性 | 3.1.1 | 5.0 |
|------|-------|-----|
| 原因码 | 只有 CONNACK 带少量返回码 | 所有确认类报文都带原因码 |
| 共享订阅 | 无（部分 Broker 自行扩展） | 协议原生支持 |
| 消息过期 | 不支持 | 支持 |
| 用户属性 | 不支持 | 支持 |
| 请求 / 响应 | 自行约定 Topic 和请求 ID | Response Topic + Correlation Data |
| 会话控制 | 布尔 `cleanSession` | Clean Start + Session Expiry Interval |

存量设备固件大量停留在 3.1.1，主流 Broker 同时支持两个版本，新设备和后端服务优先用 5.0。

### 6、Broker 选型

| Broker | 语言 | 许可 | 特点 |
|--------|------|------|------|
| **EMQX** | Erlang | 5.9 起为 BSL 1.1（单节点免费，集群需 License），5.8 及以前的开源版为 Apache 2.0 | 功能全（规则引擎、数据集成、多协议网关），性能高 |
| Mosquitto | C | EPL 2.0 / EDL 1.0 | 轻量、单机，适合开发测试和小规模部署 |
| NanoMQ | C | MIT | 面向边缘网关的轻量 Broker，可桥接到云端 Broker |
| VerneMQ | Erlang | 源码 Apache 2.0，官方二进制包与镜像商用需订阅 | 原生分布式集群 |
| HiveMQ | Java | 社区版 Apache 2.0，企业版商业许可 | 企业版集群与运维能力强 |

部署方式和 EMQX 许可细节统一放在 [平台选型](./2_platform)，本篇不重复。

### 7、Java 客户端

Eclipse Paho Java 客户端（`mqttv3` 最后一个版本 1.2.5 发布于 2020 年）已多年未更新，新项目建议使用仍在维护的 HiveMQ MQTT Client，或通过 Spring Integration 封装收发。客户端选型、固定 Client ID、重连后重新订阅、共享订阅消费等写法见 [MQTT 客户端](./6_mqtt_client)。

---

## 三、CoAP 与 LwM2M

### 1、CoAP

**CoAP（Constrained Application Protocol，RFC 7252）**：面向受限设备的 REST 风格协议，运行在 UDP 之上，固定头只有 4 字节，资源和方法（GET / POST / PUT / DELETE）的概念与 HTTP 一致，可以通过代理与 HTTP 互转。

| 特性 | 说明 |
|------|------|
| 传输层 | UDP，安全层用 DTLS |
| 编程模型 | 请求 / 响应，资源用 URI 标识 |
| 可靠性 | CON 消息需要 ACK 并按指数退避重传，NON 消息不确认 |
| 观察模式 | Observe 选项让客户端订阅资源变化，近似推送 |
| 多播 | 支持（基于 UDP），MQTT 不支持 |
| 适用场景 | 电池供电的 MCU、NB-IoT 终端、局域网设备 |

### 2、MQTT 与 CoAP 对比

| 对比项 | MQTT | CoAP |
|--------|------|------|
| 传输层 | TCP | UDP |
| 模型 | 发布 / 订阅，经 Broker | 请求 / 响应，点对点 |
| 固定头 | 2 字节 | 4 字节 |
| 可靠性 | QoS 0 / 1 / 2 | CON / NON 消息类型 |
| 连接 | 需要维持长连接与心跳 | 无连接，适合长时间休眠的设备 |
| 适合场景 | 网络较稳定、需要服务端主动下发 | 极低功耗、间歇在线 |

### 3、LwM2M

**LwM2M（Lightweight M2M）**：OMA SpecWorks 制定的设备管理协议，传输层基于 CoAP（也可用 DTLS 加密）。它在 CoAP 之上规定了标准的对象模型（如设备信息、固件升级、连接监控对象），以及注册、上报、下发、固件升级等标准流程，在 NB-IoT 表计、运营商物联网平台中很常见。Java 侧的开源实现是 Eclipse Leshan（服务端与客户端），EMQX 也提供 LwM2M 网关把设备接入到 MQTT 体系。

---

## 四、LoRa 与 LoRaWAN

**LoRa（Long Range）**：Semtech 的远距离低功耗无线调制技术，属于物理层。

**LoRaWAN**：LoRa Alliance 制定的基于 LoRa 的网络协议，规定了终端、网关、网络服务器、应用服务器的分工和通信规则。

| 特性 | 说明 |
|------|------|
| 通信距离 | 城区约 2～5 km，空旷地区可达 10 km 以上 |
| 功耗 | 极低，电池可用数年 |
| 速率 | 约 0.3～50 kbps |
| 频段 | 非授权频段（中国常用 470～510 MHz） |
| 适用场景 | 智慧农业、园区资产追踪、远程抄表 |

![LoRaWAN 网络架构](../assets/iot/lorawan-arch.svg)

---

## 五、NB-IoT

**NB-IoT（Narrowband IoT）**：3GPP 标准化的蜂窝低功耗广域网技术，复用运营商的授权频段和基站。

| 特性 | 说明 |
|------|------|
| 覆盖 | 复用运营商基站，深度覆盖能力强（地下室、井下） |
| 功耗 | 极低，支持 PSM（省电模式）和 eDRX（扩展非连续接收） |
| 速率 | 几十 kbps 量级，只适合小数据量 |
| 连接数 | 3GPP 设计目标约每小区 5 万个连接 |
| 费用 | 需要运营商物联网卡和流量资费 |
| 适用场景 | 水电气表、烟感、井盖、停车位检测 |

NB-IoT 与 LoRa 的对比：

| 对比项 | NB-IoT | LoRa |
|--------|--------|------|
| 频段 | 授权频段（运营商） | 非授权频段 |
| 网络部署 | 复用运营商网络 | 自建网关 |
| 成本 | 持续的流量资费 | 一次性网关成本 |
| 适合场景 | 大范围公共部署 | 园区、农场等私有网络 |

NB-IoT 终端常用 CoAP / LwM2M 或 MQTT 上报，进入 PSM 后设备不可达，平台下发的指令需要缓存到设备下次唤醒，这正是 [设备影子](./8_device_shadow) 要解决的问题。

---

## 六、Zigbee

**Zigbee**：基于 IEEE 802.15.4 的短距离、低功耗无线 Mesh 网络协议。

| 特性 | 说明 |
|------|------|
| 通信距离 | 单跳约 10～100 m，通过 Mesh 中继扩展 |
| 拓扑 | Mesh 网状网络，路由设备可以中继 |
| 功耗 | 极低 |
| 节点数 | 地址空间支持 6.5 万个节点，实际网络通常几十到几百个节点 |
| 频段 | 2.4 GHz（全球通用） |
| 适用场景 | 智能家居（灯光、插座、传感器）、楼宇自动化 |

常见做法是用 [Zigbee2MQTT](https://www.zigbee2mqtt.io/) 把 Zigbee 设备桥接到 MQTT Broker，后端只需要对接 MQTT。

---

## 七、Modbus

**Modbus**：1979 年由 Modicon 提出的工业通信协议，至今仍是 PLC、仪表、变频器最常见的接口。

| 变体 | 传输介质 | 说明 |
|------|---------|------|
| **Modbus RTU** | RS-485 / RS-232 串口 | 二进制帧，带 CRC 校验，最常用 |
| **Modbus ASCII** | RS-485 / RS-232 串口 | ASCII 编码，可读但效率低，已少用 |
| **Modbus TCP** | 以太网，默认端口 502 | 去掉 CRC，增加 MBAP 报文头 |

核心概念：

| 概念 | 说明 |
|------|------|
| 主站 / 从站 | 主站（上位机、网关）发起请求，从站（仪表、PLC）只应答，从站用 Unit ID 区分 |
| 数据区 | 线圈（可读写的位）、离散输入（只读位）、输入寄存器（只读 16 位）、保持寄存器（可读写 16 位） |
| 功能码 | 01 读线圈、03 读保持寄存器、04 读输入寄存器、05 写单个线圈、06 写单个寄存器、16 写多个寄存器 |

Modbus 只定义寄存器读写，不定义数据含义：一个 32 位浮点数占两个寄存器，高低字的顺序因厂商而异，必须对照设备的点表解析。寄存器解析与轮询采集的写法见 [Modbus 采集](./7_modbus)。

---

## 八、OPC UA

**OPC UA（OPC Unified Architecture）**：OPC Foundation 制定的工业互操作标准（IEC 62541），工业 4.0 参考架构中的核心通信规范。

| 特性 | 说明 |
|------|------|
| 传输方式 | 客户端 / 服务器模式支持 OPC UA TCP 二进制（`opc.tcp://`）、HTTPS、WebSocket；1.04 起增加 PubSub 模式，可通过 MQTT、AMQP、UDP 发布数据 |
| 数据模型 | 面向对象的信息模型（节点、变量、方法、事件），自带语义和类型 |
| 安全性 | 内置应用认证、签名、加密，基于 X.509 证书 |
| 跨平台 | 与操作系统、编程语言无关 |
| 适用场景 | 设备与 MES / ERP 对接、产线数据采集、数字孪生 |

Modbus 与 OPC UA 的对比：

| 对比项 | Modbus | OPC UA |
|--------|--------|--------|
| 年代 | 1979 年 | 2008 年发布首版 |
| 数据模型 | 只有寄存器地址，含义靠点表 | 带语义的信息模型 |
| 安全性 | 原生没有；Modbus/TCP Security 规范可选 TLS（端口 802），设备支持很少 | 内置认证与加密 |
| 复杂度 | 低 | 高 |
| 适合 | 存量 PLC、仪表 | 新建产线、需要互操作的系统 |

Java 侧的开源实现是 [Eclipse Milo](https://github.com/eclipse-milo/milo)（OPC UA 客户端与服务端）。常见架构是：设备通过 OPC UA 接入边缘网关，网关转成 MQTT（或直接用 OPC UA PubSub over MQTT）上送云端，云端再桥接到 Kafka 或写入时序库。

---

## 九、协议选型速查

| 场景 | 推荐协议 |
|------|---------|
| 设备或网关与云平台双向通信 | MQTT |
| 电池供电、长时间休眠的受限设备 | CoAP / LwM2M |
| 园区、农场等自建低功耗广域网 | LoRaWAN |
| 大范围公共设施部署（运营商网络） | NB-IoT |
| 智能家居短距组网 | Zigbee（经网关桥接 MQTT） |
| 存量 PLC、仪表接入 | Modbus RTU / TCP |
| 新建产线、需要语义互操作 | OPC UA |
| 海量设备数据进入大数据平台 | MQTT 接入，Broker 桥接到 [Kafka](/messaging/2_kafka) |

---

## 小结

- MQTT 是 IoT 应用层的事实标准：经 Broker 的发布 / 订阅、按 Topic 路由，QoS 只保证一跳的投递语义，重要指令仍要业务幂等
- 持久会话依赖固定的 Client ID；保留消息解决「订阅即拿到当前值」，遗嘱消息解决「异常离线通知」
- MQTT 5.0 的原因码、共享订阅、消息过期、请求 / 响应、Clean Start 与 Session Expiry Interval 都是工程上常用的能力，新项目优先用 5.0
- CoAP 面向休眠的受限设备，LwM2M 在其上规定了设备管理对象和流程；LoRaWAN 和 NB-IoT 分别对应自建网络和运营商网络
- Modbus 只有寄存器没有语义，解析依赖点表；OPC UA 自带信息模型和安全机制，适合新建系统

## 参考资料

- MQTT Version 5.0（OASIS Standard）：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
- MQTT 规范汇总：[https://mqtt.org/mqtt-specification/](https://mqtt.org/mqtt-specification/)
- RFC 7252 The Constrained Application Protocol (CoAP)：[https://www.rfc-editor.org/info/rfc7252](https://www.rfc-editor.org/info/rfc7252)
- Eclipse Leshan（LwM2M）：[https://github.com/eclipse-leshan/leshan](https://github.com/eclipse-leshan/leshan)
- LoRaWAN 规范：[https://lora-alliance.org/resource_hub/lorawan-specification-v1-0-3/](https://lora-alliance.org/resource_hub/lorawan-specification-v1-0-3/)
- OPC UA 规范：[https://opcfoundation.org/developer-tools/specifications-unified-architecture](https://opcfoundation.org/developer-tools/specifications-unified-architecture)
- Eclipse Milo：[https://github.com/eclipse-milo/milo](https://github.com/eclipse-milo/milo)
- HiveMQ MQTT Client：[https://github.com/hivemq/hivemq-mqtt-client](https://github.com/hivemq/hivemq-mqtt-client)

> 下一篇：[平台选型](./2_platform) —— 商业云平台与开源平台对比、EMQX 许可与部署、ThingsBoard 规则链、JetLinks 协议扩展。

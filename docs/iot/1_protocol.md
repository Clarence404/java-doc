# IoT 通信协议

> 参考资料：
> * MQTT 规范：[https://mqtt.org/mqtt-specification/](https://mqtt.org/mqtt-specification/)
> * LoRaWAN 规范：[https://lora-alliance.org/resource_hub/lorawan-specification-v1-0-3/](https://lora-alliance.org/resource_hub/lorawan-specification-v1-0-3/)
> * OPC-UA 规范：[https://opcfoundation.org/developer-tools/specifications-unified-architecture](https://opcfoundation.org/developer-tools/specifications-unified-architecture)

## 一、协议总览

IoT 协议按应用场景分为三类：

| 类别 | 协议 | 适用场景 |
|------|------|---------|
| **应用层（消息传输）** | MQTT、CoAP、HTTP、AMQP | 设备与云平台数据交换 |
| **无线接入（低功耗广域）** | NB-IoT、LoRa、Zigbee、BLE | 设备与网关/基站通信 |
| **工业总线** | Modbus、OPC-UA | 工业设备与 SCADA/上位机通信 |

---

## 二、MQTT

**MQTT（Message Queuing Telemetry Transport）**：基于发布/订阅模型的轻量级消息协议，运行在 TCP 之上，是 IoT 最主流的应用层协议。

### 核心概念

| 概念 | 说明 |
|------|------|
| Broker | 消息中间人，负责接收并转发消息（如 EMQX、Mosquitto） |
| Publisher | 发布者，设备向 Topic 推送数据 |
| Subscriber | 订阅者，服务端订阅 Topic 接收数据 |
| Topic | 消息路由路径，如 `factory/line1/temp` |
| QoS | 服务质量：0（最多一次）/ 1（至少一次）/ 2（有且仅一次） |
| Retain | 保留消息，新订阅者立即获取最新值 |
| Will | 遗嘱消息，设备异常离线时自动发布 |

### 主流 Broker

| Broker | 语言 | 特点 |
|--------|------|------|
| **EMQX**（推荐） | Erlang | 高性能，支持集群，企业级，Web 管理界面 |
| Mosquitto | C | 轻量，适合嵌入式和测试环境 |
| VerneMQ | Erlang | 分布式，适合大规模部署 |
| HiveMQ | Java | 商业版功能强，提供开源社区版 |

> 官网：[https://www.emqx.io](https://www.emqx.io)

---

## 三、CoAP

**CoAP（Constrained Application Protocol）**：面向受限设备的 REST 风格协议，运行在 UDP 之上，比 MQTT 更轻量。

| 特性 | 说明 |
|------|------|
| 传输层 | UDP（更省资源） |
| 编程模型 | 类似 HTTP（GET / POST / PUT / DELETE） |
| 可靠性 | 支持 ACK + 重传，可选可靠交付 |
| 多播 | 支持（MQTT 不支持） |
| 适用场景 | MCU、NB-IoT 终端、局域网 IoT |

### MQTT vs CoAP

| 对比项 | MQTT | CoAP |
|--------|------|------|
| 传输层 | TCP | UDP |
| 模型 | 发布/订阅 | 请求/响应 |
| 可靠性 | 高（QoS 保障） | 轻量（重传可选） |
| 功耗 | 中 | 低 |
| 适合场景 | 稳定网络、状态保留 | 受限设备、低功耗网络 |

---

## 四、LoRa / LoRaWAN

**LoRa（Long Range）**：Semtech 的低功耗远距离无线技术，物理层调制方式。
**LoRaWAN**：基于 LoRa 的网络协议标准，定义了网络架构和通信规则。

| 特性 | 说明 |
|------|------|
| 通信距离 | 城区 2～5 km，空旷地区 10～15 km |
| 功耗 | 极低，电池可用数年 |
| 速率 | 0.3～50 kbps（低速） |
| 频段 | 非授权频段（中国 470 MHz） |
| 适用场景 | 智慧农业、智慧城市、资产追踪、远程抄表 |

**LoRaWAN 网络架构：**
```
终端设备（传感器）
    ↓ LoRa 无线
网关（Gateway）
    ↓ TCP/IP（4G / 以太网）
网络服务器（Network Server）
    ↓ MQTT / HTTP
应用服务器
```

---

## 五、NB-IoT

**NB-IoT（Narrowband IoT）**：基于蜂窝网络的低功耗广域物联网技术，由 3GPP 标准化，使用运营商授权频段。

| 特性 | 说明 |
|------|------|
| 覆盖 | 广（复用运营商基站），穿透力强 |
| 功耗 | 极低，支持 PSM 省电模式 |
| 速率 | 上行 ~60 kbps，下行 ~30 kbps |
| 连接数 | 单基站支持 10 万+ 设备 |
| 费用 | 需购买运营商 SIM 卡流量 |
| 适用场景 | 水电气表、路灯、停车位、烟感探测器 |

**NB-IoT vs LoRa：**

| 对比项 | NB-IoT | LoRa |
|--------|--------|------|
| 频段 | 授权（运营商） | 非授权 |
| 覆盖部署 | 复用运营商网络 | 需自建网关 |
| 成本 | 有持续流量费 | 一次性网关成本 |
| 适合场景 | 大规模公共部署 | 园区 / 农场私有网络 |

---

## 六、Zigbee

**Zigbee**：基于 IEEE 802.15.4 的短距离、低功耗无线网状网络协议。

| 特性 | 说明 |
|------|------|
| 通信距离 | 10～100 m |
| 拓扑 | Mesh 网状网络，设备间可中继 |
| 功耗 | 极低 |
| 节点数 | 单网络支持 65000+ 设备 |
| 频段 | 2.4 GHz（全球）|
| 适用场景 | 智能家居（灯光、插座、传感器）、楼宇自动化 |

> 常见实践：[Zigbee2MQTT](https://www.zigbee2mqtt.io/) 将 Zigbee 设备桥接到 MQTT Broker

---

## 七、Modbus

**Modbus**：1979 年提出的工业串行通信协议，至今仍是工业领域最广泛使用的现场总线协议之一。

| 变体 | 传输介质 | 说明 |
|------|---------|------|
| **Modbus RTU** | RS-485 / RS-232 串口 | 二进制编码，最常用 |
| **Modbus ASCII** | RS-485 / RS-232 串口 | ASCII 编码，可读性好 |
| **Modbus TCP** | 以太网（TCP/IP） | 现代工业设备主流 |

**核心概念：**

| 概念 | 说明 |
|------|------|
| 主站（Master）| 发起请求方（上位机、PLC、网关） |
| 从站（Slave）| 响应请求方（传感器、仪表、执行器） |
| 功能码 | 03 读保持寄存器 / 06 写单寄存器 / 16 写多寄存器 |
| 寄存器地址 | 从站数据存储位置 |

**适用场景：** PLC、变频器、电表、工业传感器等老旧设备接入。

> Java 开源库：[j2mod](https://github.com/steveohara/j2mod)（支持 Modbus RTU + TCP）

---

## 八、OPC-UA

**OPC-UA（OPC Unified Architecture）**：工业互联网的现代标准协议，由 OPC Foundation 制定，是工业 4.0 的核心通信规范。

| 特性 | 说明 |
|------|------|
| 传输层 | TCP / HTTPS / WebSocket |
| 数据模型 | 面向对象信息模型（节点、变量、方法、事件） |
| 安全性 | 内置认证、加密、X.509 证书 |
| 跨平台 | 与操作系统、编程语言无关 |
| 适用场景 | 工厂设备与 MES/ERP 对接、工业数字孪生 |

**Modbus vs OPC-UA：**

| 对比项 | Modbus | OPC-UA |
|--------|--------|--------|
| 年代 | 1979，老协议 | 2008，现代标准 |
| 数据模型 | 简单寄存器 | 丰富信息模型 |
| 安全性 | 无 | 内置加密认证 |
| 复杂度 | 低 | 高 |
| 适合 | 老旧工业设备 | 新型智能设备 |

> Java 开源库：[Eclipse Milo](https://github.com/eclipse/milo)（OPC-UA 客户端 + 服务端完整实现）

---

## 九、协议选型速查

| 场景 | 推荐协议 |
|------|---------|
| 设备与云平台数据上报 | MQTT |
| 微控制器、低功耗局域网 | CoAP |
| 大范围低功耗部署（自建网络） | LoRaWAN |
| 公共设施大规模部署（运营商网络） | NB-IoT |
| 智能家居短距网状组网 | Zigbee |
| 工业老旧设备接入（PLC / 仪表） | Modbus RTU / TCP |
| 工厂设备现代化互联、工业数字化 | OPC-UA |

> [!warning]
> 待补充：MQTT 5.0 新特性详解、Modbus 实战代码、OPC-UA 节点模型与 Eclipse Milo 示例

# IoT 与工业协议

> 官方规范：[MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html) / [CoAP RFC 7252](https://www.rfc-editor.org/rfc/rfc7252.html) / [Modbus](https://www.modbus.org/specs.php) / [OPC UA](https://opcfoundation.org/)

IoT 与工业协议速览，协议原理、QoS、客户端代码与选型详见 [IoT 通信协议](/iot/1_protocol)。

| 协议 | 传输层 | 通信模型 | 典型场景 |
|------|--------|----------|----------|
| MQTT | TCP | 发布/订阅（Broker） | 设备与云平台数据上报 |
| CoAP | UDP | 请求/响应（REST 风格） | MCU、低功耗传感器节点 |
| Modbus | RS-485 串口 / TCP | 主从（请求/响应） | PLC、仪表、SCADA 通信 |
| OPC UA | TCP / HTTPS / WebSocket | 客户端/服务端 + 发布/订阅 | 工业互联网、跨厂商设备互联 |
| LoRaWAN | LoRa 无线（非授权频段） | 星型网络（终端 → 网关 → 网络服务器） | 智慧农业、远程抄表 |
| NB-IoT | 蜂窝网络（授权频段） | 终端 → 运营商基站 → 平台 | 水电气表、烟感、停车位 |
| Zigbee | IEEE 802.15.4（2.4 GHz） | Mesh 网状网络 | 智能家居、楼宇自动化 |

> 详细内容：[IoT 通信协议](/iot/1_protocol)

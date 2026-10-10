# IoT 总览

本模块从 Java 后端视角讲物联网：设备协议、平台选型、边缘计算、数据存储与设备安全，再落到 Java 接入实战。单片机固件和射频硬件不在范围内。

**版本基线（2026 年 10 月）**：MQTT 5.0、EMQX 6.x、TDengine 3.x、KubeEdge 1.23、EdgeX Foundry 4.0、ThingsBoard 4.x、JDK 21、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. [通信协议](./1_protocol)：MQTT 的 QoS、保留消息、遗嘱、共享订阅与 5.0 新特性，以及 CoAP、LwM2M、LoRaWAN、NB-IoT、Modbus、OPC UA 的定位
2. [平台选型](./2_platform)：商业云平台与开源平台对比、EMQX 许可与部署、ThingsBoard 规则链、JetLinks 协议扩展
3. [边缘计算](./3_edge)：云边端分工、EdgeX Foundry、KubeEdge 云边协同、边缘 AI 推理
4. [数据处理](./4_data)：时序数据落库、流式计算与告警
5. [设备安全](./5_security)：设备身份、传输加密、Topic 级访问控制
6. [MQTT 客户端](./6_mqtt_client)：Java MQTT 客户端选型、重连与会话、Spring Integration 收发
7. [Modbus 采集](./7_modbus)：寄存器读写、轮询调度与数据解析
8. [设备影子](./8_device_shadow)：期望值与上报值、版本号与离线指令
9. [Netty 接入网关](./9_netty_gateway)：私有二进制协议接入、会话管理与上下行路由
10. [OTA 升级](./10_ota)：固件签名校验、防回滚、A/B 分区与灰度发布
11. [规则引擎](./11_rule_engine)：规则模型、条件匹配与动作执行

复习时用 [高频面试题](./99_interview) 自测，答案在 [IoT 面试题解答](/interview/24_iot)。

---

## 三、关联模块

一套典型的 IoT 系统分为四层：感知层（传感器、MCU）负责采集，网络层（MQTT / NB-IoT / LoRa 等）负责传输，平台层（Broker、设备管理、规则引擎、时序库）负责汇聚和处理，应用层（看板、告警、业务系统）负责使用数据。

![IoT 四层架构](../assets/iot/iot-four-layers.svg)

版本说明：MQTT 3.1.1 仍是大量存量设备的默认版本，差异在正文标出；EMQX 从 5.9.0 起开源版与企业版合并，改用 BSL 1.1 许可，单节点生产免费、多节点集群需 License，细节见 [平台选型](./2_platform)，不想受此约束可选 Mosquitto、NanoMQ。

- [网络协议 · TCP 与 UDP](/protocols/1_tcp_udp)：MQTT 跑在 TCP 上、CoAP 跑在 UDP 上，连接与重传行为的基础
- [网络协议 · HTTPS 与 TLS](/protocols/3_https_tls)：MQTT over TLS、设备双向证书认证（mTLS）的原理
- [Netty 总览](/netty/0_overview)：设备网关的线程模型、粘包拆包、[自定义私有协议](/netty/8_custom_protocol) 与 [心跳与连接管理](/netty/9_heartbeat)
- [时序数据库](/database/4_nosql/1_time_series_db)：TDengine、InfluxDB、IoTDB 的数据模型与选型
- [消息队列总览](/messaging/0_overview)：设备数据从 MQTT 桥接到 Kafka 后的削峰与分发
- [Flink 总览](/flink/0_overview)：设备数据的窗口聚合与实时告警
- [零信任架构](/security/9_zero_trust)：设备身份与最小权限访问的通用原则
- [Kubernetes](/cloud-native/6_kubernetes)：KubeEdge 所依赖的云端集群
- [AI 总览](/ai/0_overview)：边缘推理所用模型的来源与接入方式
- [IoT 面试题解答](/interview/24_iot)：本模块高频问题的答案汇总

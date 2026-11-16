# IoT 总览

本模块从 Java 后端视角讲物联网：先选协议和平台，再把设备安全地接进来，然后是数据链路、设备影子、OTA、规则引擎这些平台能力，最后用配套仓库 Conduit IoT 串讲一个多租户物联网平台是怎么做出来的。单片机固件和射频硬件不在范围内。

**版本基线（2026 年 10 月）**：MQTT 5.0、EMQX 5.9+ / 6.x、TDengine 3.x、KubeEdge 1.23、EdgeX Foundry 4.0、ThingsBoard 4.x、JDK 21、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

一套典型的 IoT 系统分为四层：感知层（传感器、MCU）负责采集，网络层（MQTT / NB-IoT / LoRa 等）负责传输，平台层（Broker、设备管理、规则引擎、时序库）负责汇聚和处理，应用层（看板、告警、业务系统）负责使用数据。

![IoT 四层架构](../assets/iot/iot-four-layers.svg)

1. [通信协议](./1_protocol)：MQTT 的 QoS、保留消息、遗嘱、共享订阅与 5.0 新特性，以及 CoAP、LwM2M、LoRaWAN、NB-IoT、Modbus、OPC UA 的定位
2. [平台选型](./2_platform)：商业云平台与开源平台对比、选型建议、ThingsBoard 规则链、JetLinks 协议包
   - [EMQX 许可与部署](./2_platform_emqx)：Broker 对比、5.9 起的 BSL 许可、单节点部署、三节点集群与四层负载均衡
3. [边缘计算](./3_edge)：云边端分工、EdgeX Foundry、KubeEdge 云边协同、边缘 AI 推理
4. [设备安全](./5_security)：设备身份、传输加密、Topic 级访问控制
5. [MQTT 客户端](./6_mqtt_client)：Java MQTT 客户端选型、重连与会话、Spring Integration 收发
6. [Modbus 采集](./7_modbus)：寄存器读写、轮询调度与数据解析
7. [Netty 接入网关](./8_netty_gateway)：私有二进制协议接入、会话管理与上下行路由
8. [遥测数据链路](./9_data)：时序数据落库、流式计算与告警
9. [设备影子](./9_device_shadow)：期望值与上报值、版本号与离线指令
10. [OTA 升级](./10_ota)：固件签名校验、防回滚、A/B 分区与灰度发布
11. [规则引擎](./11_rule_engine)：规则模型、条件匹配与动作执行

「平台实战」一组以配套仓库 [Conduit IoT](https://github.com/Clarence404/conduit-iot) 为例，把前面的协议、选型和接入写法串成一个能跑的多租户物联网平台，每篇按「问题、设计决定、关键代码、怎么验证、已知限制」的顺序讲。这一组跟随配套仓库使用 Spring Boot 3.5，与上面的站点基线不同，文中的代码与数字都固定在仓库的一个提交上。

12. [平台实战概览](./12_conduit_intro)：Conduit 的定位与版本进度、一条上报的全过程、接入与业务为什么分两个进程
13. [设备接入与鉴权](./13_conduit_access)：topic 设计、一机一密、EMQX HTTP 鉴权回调、ACL 与在线状态
14. [物模型与解码](./14_conduit_thing_model)：属性定义与逐测点校验、可插拔解码器、缺测与零值约定
15. [可靠上报与接入层主备](./15_conduit_reliable_uplink)：业务回执与设备重发、写入总线后才确认、Redis 锁选主、共享订阅
16. [数据流水线](./16_conduit_pipeline)：Redis Streams 消费与认领、退避重试与死信、批处理
17. [时序存储与历史查询](./17_conduit_telemetry)：InfluxDB 3 宽表建模、最新值、自动聚合、遥测重放
18. [多租户与授权](./18_conduit_tenant)：租户强制过滤、组合外键、组织模型、范围授权、会话吊销

19～21 号预留给设备影子、OTA 升级、规则引擎在 Conduit 里的实现篇：这三项 Conduit 还没有实现，目前只有上面设备影子、OTA 升级、规则引擎这三篇的通用设计。

22. [压测与瓶颈排查](./22_conduit_capacity)：计数守恒判据、阶梯压测、逐跳定位瓶颈与几次被推翻的结论
23. [部署与可观测](./23_conduit_deploy)：Compose 部署包、Flyway 迁移与演示数据、健康检查、指标看板

复习时用 [高频面试题](./99_interview) 自测，答案在 [IoT 面试题解答](/interview/33_iot)。

---

## 三、关联模块

版本说明：MQTT 3.1.1 仍是大量存量设备的默认版本，差异在正文标出；EMQX 从 5.9 起改用 BSL 1.1 许可，对部署方式的限制与替代的 Broker 见 [EMQX 许可与部署](./2_platform_emqx)；EMQX 配置从 5.x 起使用 HOCON 语法。

- [网络协议 · TCP 与 UDP](/protocols/1_tcp_udp)：MQTT 跑在 TCP 上、CoAP 跑在 UDP 上，连接与重传行为的基础
- [网络协议 · HTTPS 与 TLS](/protocols/3_https_tls)：MQTT over TLS、设备双向证书认证（mTLS）的原理
- [Netty 总览](/netty/0_overview)：设备网关的线程模型、粘包拆包、[自定义私有协议](/netty/8_custom_protocol) 与 [心跳与连接管理](/netty/9_heartbeat)
- [时序数据库](/nosql/4_time_series_db)：TDengine、InfluxDB、IoTDB 的数据模型与选型
- [消息队列总览](/messaging/0_overview)：设备数据从 MQTT 桥接到 Kafka 后的削峰与分发
- [Flink 总览](/flink/0_overview)：设备数据的窗口聚合与实时告警
- [监控视频接入](/media/8_video_surveillance)：摄像头类设备走 RTSP / ONVIF / GB/T 28181 取流，与设备平台的集成方式
- [零信任架构](/security/9_zero_trust)：设备身份与最小权限访问的通用原则
- [Kubernetes](/cloud-native/6_kubernetes)：KubeEdge 所依赖的云端集群
- [AI 总览](/ai/0_overview)：边缘推理所用模型的来源与接入方式
- [分布式锁](/distributed/3_lock)：平台实战里接入层用 Redis 锁做单活多备的原理
- [Redis 典型应用场景](/cache/4_redis_scenario)：平台实战用作消息总线的 Redis Streams 消费组、确认与认领
- [权限系统架构设计](/architecture/6_access_control)：多租户平台里角色、权限与数据范围的通用设计
- [性能分析方法论](/high-perf/2_methodology)：平台实战压测篇所用的定位思路
- [IoT 面试题解答](/interview/33_iot)：本模块高频问题的答案汇总

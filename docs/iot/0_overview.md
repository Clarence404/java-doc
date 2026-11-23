# IoT 总览

本模块从 Java 后端视角讲物联网，按「协议与选型、接入与安全、平台能力、平台实战」四组展开：先选协议和平台，再把设备安全地注册、接入进来，然后是物模型、遥测数据链路、设备影子、指令下发、OTA、规则引擎与告警这些平台能力，最后用配套仓库 Conduit IoT 串讲一个多租户物联网平台是怎么做出来的。单片机固件和射频硬件不在范围内。

**版本基线（2026 年 10 月）**：MQTT 5.0、EMQX 6.x、TDengine 3.x、KubeEdge 1.23、EdgeX Foundry 4.0、ThingsBoard 4.x、JDK 21、Spring Boot 4

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

一套典型的 IoT 系统分为四层：感知层（传感器、MCU）负责采集，网络层（MQTT / NB-IoT / LoRa 等）负责传输，平台层（Broker、设备管理、规则引擎、时序库）负责汇聚和处理，应用层（看板、告警、业务系统）负责使用数据。

![IoT 四层架构](../assets/iot/iot-four-layers.svg)

通用篇讲业界主流平台的通用设计：每遇到一处自定的约定（Topic、载荷、状态机），都先给出阿里云、华为云、AWS、Azure、ThingsBoard 等主流平台的做法对照，再说明本模块示例采用哪一种。全模块共用一套 Topic 与载荷约定，主文档是通信协议篇的「Topic 约定」一节。

**协议与选型**

1. [通信协议](./1_basics/1_protocol)：MQTT 的 QoS、会话与 5.0 新特性，本模块的 Topic 约定与主流平台对照，以及 Sparkplug B、CoAP、LwM2M、LoRaWAN、NB-IoT、Matter、Modbus、OPC UA 的定位
2. [平台选型](./1_basics/2_platform)：商业云平台与开源平台对比、许可对比、选型建议、ThingsBoard 规则链、JetLinks 协议包
3. [EMQX 许可与部署](./1_basics/3_emqx_deploy)：Broker 对比、5.9 起的 BSL 许可、单节点部署、三节点集群与四层负载均衡
4. [边缘计算](./1_basics/4_edge)：云边分工、边缘框架对比、EdgeX Foundry、KubeEdge 云边协同、边缘 AI 推理

**接入与安全**

5. [设备安全](./2_access/1_security)：一机一密与建连签名、X.509 与 mTLS、EMQX 认证与 Topic 授权、安全审计、零信任与标准合规对照
6. [设备注册与生命周期](./2_access/2_provisioning)：一型一密动态注册与主流预配模型、生命周期状态机、禁用与踢线、凭据轮换与设备转移
7. [MQTT 客户端](./2_access/3_mqtt_client)：Java MQTT 客户端选型、重连与持久会话、共享订阅、Spring Integration 收发
8. [Modbus 采集](./2_access/4_modbus)：寄存器与功能码、点表驱动的轮询采集、字节序解析、采集服务作为网关代报
9. [网关与子设备](./2_access/5_gateway_subdevice)：主流网关模型、两种信任模型、网关 Topic 与拓扑表、级联离线、续传乱序与下行转发
10. [Netty 接入网关](./2_access/6_netty_gateway)：带流水号与 CRC 的私有帧、应答与重发、挑战鉴权、集群下行路由
11. [海量连接与连接风暴](./2_access/7_connection_storm)：设备退避与抖动、负载均衡、EMQX 限速与抖动检测、认证与会话恢复、容量规划与演练

**平台能力**

12. [物模型](./3_platform/1_thing_model)：属性、事件、服务三要素与主流平台对照、数据类型与版本演进、上报校验
13. [遥测数据链路](./3_platform/2_data)：EMQX 转发 Kafka、Flink 离线检测、时序库建模、降采样与 Grafana
14. [设备影子](./3_platform/3_device_shadow)：desired / reported / delta、主流平台对照、版本冲突与命名影子
15. [指令下发与服务调用](./3_platform/4_command)：同步、异步与离线缓存三档，请求与应答配对、命令状态机、幂等与超时
16. [OTA 升级](./3_platform/5_ota)：固件签名与清单、防回滚与 A/B 分区、断点续传、分批灰度与任务状态机
17. [规则引擎与告警](./3_platform/6_rule_engine)：主流平台三类规则模型、触发-条件-动作引擎、边沿触发与恢复、设备告警模型

**平台实战**

「平台实战」一组以配套仓库 [Conduit IoT](https://github.com/Clarence404/conduit-iot) 为例，把前面的协议、选型和接入写法串成一个能跑的多租户物联网平台，每篇按「问题、设计决定、关键代码、怎么验证、已知限制」的顺序讲。这一组跟随配套仓库使用 Spring Boot 3.5，与上面的站点基线不同，文中的代码与数字都固定在仓库的一个提交上。

18. [平台实战概览](./4_practice/0_intro)：Conduit 的定位与版本进度、一条上报的全过程、接入与业务为什么分两个进程
19. [设备接入与鉴权](./4_practice/1_access)：topic 设计、一机一密、EMQX HTTP 鉴权回调、ACL 与在线状态
20. [物模型与解码](./4_practice/2_thing_model)：通用物模型的属性子集、逐测点校验、可插拔解码器、缺测与零值约定
21. [可靠上报与接入层主备](./4_practice/3_reliable_uplink)：业务回执与设备重发、写入总线后才确认、Redis 锁选主、共享订阅
22. [数据流水线](./4_practice/4_pipeline)：Redis Streams 消费与认领、退避重试与死信、批处理
23. [时序存储与历史查询](./4_practice/5_telemetry)：InfluxDB 3 宽表建模、最新值、自动聚合、遥测重放
24. [多租户与授权](./4_practice/6_tenant)：租户强制过滤、组合外键、组织模型、范围授权、会话吊销
25. [压测与瓶颈排查](./4_practice/10_capacity)：计数守恒判据、阶梯压测、逐跳定位瓶颈与几次被推翻的结论
26. [部署与可观测](./4_practice/11_deploy)：Compose 部署包、Flyway 迁移与演示数据、健康检查、指标看板

平台实战的 7–9 号预留给设备影子、OTA 升级、规则引擎在 Conduit 里的实现篇：这三项 Conduit 还没有实现，目前只有平台能力一组里 [设备影子](./3_platform/3_device_shadow)、[OTA 升级](./3_platform/5_ota)、[规则引擎与告警](./3_platform/6_rule_engine) 三篇的通用设计。

复习时用 [高频面试题](./99_interview) 自测，答案在 [IoT 面试题解答](/interview/33_iot)。

---

## 三、关联模块

版本说明：MQTT 3.1.1 仍是大量存量设备的默认版本，差异在正文标出；EMQX 从 5.9 起改用 BSL 1.1 许可，对部署方式的限制与替代的 Broker 见 [EMQX 许可与部署](./1_basics/3_emqx_deploy)；EMQX 配置从 5.x 起使用 HOCON 语法。

- [网络协议 · TCP 与 UDP](/protocols/1_tcp_udp)：MQTT 跑在 TCP 上、CoAP 跑在 UDP 上，连接与重传行为的基础
- [网络协议 · HTTPS 与 TLS](/protocols/3_https_tls)：MQTT over TLS、设备双向证书认证（mTLS）的原理
- [Netty 总览](/netty/0_overview)：设备网关的线程模型、粘包拆包、[自定义私有协议](/netty/8_custom_protocol) 与 [心跳与连接管理](/netty/9_heartbeat)
- [时序数据库概览](/nosql/8_tsdb)：TDengine、InfluxDB、IoTDB 的数据模型与选型
- [消息队列总览](/messaging/0_overview)：设备数据从 MQTT 桥接到 Kafka 后的削峰与分发
- [Flink 总览](/flink/0_overview)：设备数据的窗口聚合与实时告警
- [监控视频接入](/media/8_video_surveillance)：摄像头类设备走 RTSP / ONVIF / GB/T 28181 取流，与设备平台的集成方式
- [零信任架构](/security/9_zero_trust)：设备身份与最小权限访问的通用原则
- [Kubernetes](/cloud-native/6_kubernetes)：KubeEdge 所依赖的云端集群
- [AI 总览](/ai/0_overview)：边缘推理所用模型的来源与接入方式
- [幂等设计](/architecture/3_idempotence)：指令重复投递只执行一次、规则动作去重的通用做法
- [分布式锁](/distributed/4_lock)：平台实战里接入层用 Redis 锁做单活多备的原理
- [Redis 典型应用场景](/cache/4_redis_scenario)：平台实战用作消息总线的 Redis Streams 消费组、确认与认领
- [权限系统架构设计](/architecture/6_access_control)：多租户平台里角色、权限与数据范围的通用设计
- [性能分析方法论](/high-perf/2_methodology)：平台实战压测篇所用的定位思路
- [IoT 面试题解答](/interview/33_iot)：本模块高频问题的答案汇总

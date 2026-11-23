---
description: 云平台与开源平台对比、许可对比、选型建议、ThingsBoard 规则链与告警规则、JetLinks 协议包
---

# 平台选型

> 前置阅读：[通信协议](./1_protocol)

IoT 平台提供设备接入、设备管理、规则引擎、数据存储与可视化等能力，分为商业云平台、可私有化部署的完整平台、只做接入的 Broker 和家居生态平台四类。本篇讲各类平台的对比与选型建议、ThingsBoard 规则链、JetLinks 协议包。

---

## 一、平台分类

| 类型 | 说明 | 代表产品 |
|------|------|---------|
| **商业云平台** | 开箱即用，按量计费，免运维，能力与厂商云生态绑定 | 华为云 IoTDA、腾讯云 IoT Explorer、涂鸦开发者平台、AWS IoT Core、Azure IoT Hub、阿里云物联网平台（已停止新购） |
| **可私有化部署的完整平台** | 私有化部署，可二次开发，需自行运维；许可各不相同，见下文的许可对比 | ThingsBoard、JetLinks、IoT-DC3 |
| **接入层组件** | 只负责 MQTT 等协议接入与消息路由，平台能力自建 | EMQX、Mosquitto、NanoMQ |
| **家居生态平台** | 面向智能家居，偏个人和消费场景 | Home Assistant、openHAB、米家 |

各家的功能清单里反复出现几个名词，本模块各有专篇，这里只把它们当功能名：物模型是平台对设备能力（属性、事件、服务）的结构化描述，各家格式不同，见 [物模型](../3_platform/1_thing_model)；其余见 [设备注册与生命周期](../2_access/2_provisioning)、[设备影子](../3_platform/3_device_shadow)、[指令下发与服务调用](../3_platform/4_command)、[OTA 升级](../3_platform/5_ota)、[规则引擎与告警](../3_platform/6_rule_engine)。

---

## 二、商业云平台

### 1、华为云 IoTDA

- **定位**：华为云的设备接入服务（IoTDA，前身为 OceanConnect），偏工业和政企场景
- **核心能力**：设备接入（MQTT、CoAP、LwM2M、HTTPS，Modbus 与 OPC UA 经边缘网关接入）与管理、产品模型（即物模型）、设备影子、规则引擎、OTA，边缘侧配合华为云 IoTEdge
- **实例**：标准版与企业版（独享实例）两种在售；开通服务即送一个标准版免费单元，限 1,000 台设备同时在线、每天 1 万条消息，只用于调试，不承诺商用 SLA
- **适合**：国内项目快速上云，工业制造、智慧城市、大型政企项目

### 2、腾讯云 IoT Explorer

- **定位**：腾讯云的物联网开发平台，与微信生态结合紧密
- **核心能力**：设备接入、物模型、数据开发，配套腾讯连连小程序做设备控制
- **注意**：2024 年 6 月 20 日起，新注册的用户要先购买公共实例激活码才能使用公共实例，此前已开通的用户不受影响
- **适合**：消费类智能硬件、需要微信小程序控制设备的场景

### 3、涂鸦开发者平台

- **定位**：面向消费类智能硬件的一站式平台，把联网模组与固件（TuyaOS）、可配置的 OEM App、云端 API 一起提供
- **核心能力**：按品类给出现成的产品开发方案，平台内采购模组与授权码，量产后有设备监控、OTA、数据看板和售后工具
- **适合**：没有 App 和云端团队、要把智能家居产品快速做出来的硬件厂商；代价是模组、App、云都绑在涂鸦体系内

### 4、AWS IoT

- **定位**：全球化部署最成熟的 IoT 云服务
- **核心能力**：IoT Core（设备接入、规则、Device Shadow 设备影子）、Greengrass（边缘运行时）、IoT SiteWise（工业设备数据建模与采集）
- **注意**：AWS IoT Analytics 已于 2025 年 12 月 15 日停止支持，IoT Events 已于 2026 年 5 月 20 日停止支持，数据分析改用 IoT Core 规则把数据转到 Kinesis、S3 等服务再处理
- **适合**：全球化部署、已经在用 AWS 的企业

### 5、Azure IoT

- **定位**：微软云的 IoT 服务，云端是 IoT Hub，边缘是 IoT Edge 与 IoT Operations
- **IoT Hub**：设备接入、设备孪生（Device Twin，相当于设备影子）、直接方法（Direct Method，同步指令）、云到设备消息，配套设备预配服务（DPS）做批量注册
- **不是通用 MQTT Broker**：官方文档明确写着 IoT Hub 不是功能完整的 MQTT Broker。正式可用的经典连接配置只支持 MQTT 3.1.1，Topic 是预定义的固定几个，不支持 QoS 2，不持久化保留消息，设备之间不能互发消息，每台设备只允许一条 MQTT 连接；需要自定 Topic 的云端 Broker 时，官方建议改用 Azure Event Grid 的 MQTT Broker（支持 3.1.1 与 5.0）
- **Azure IoT Operations**：运行在 Azure Arc 纳管的边缘 Kubernetes 集群上的一组数据服务，内置边缘 MQTT Broker（3.1.1 与 5.0）、OPC UA 等连接器和数据流，把工厂现场数据整理后送上云，见 [边缘计算](./4_edge)
- **适合**：全球化部署、已经在用 Azure 的企业，以及工厂 OT 数据上云

### 6、阿里云物联网平台

- **现状**：官方计费文档写明「物联网平台自 2025 年 2 月 1 日起不再支持新购」，产品文档也已标为停止维护。存量实例仍可按文档续费和升降配，**新项目不能再选它**
- **核心能力**：设备接入（MQTT / CoAP / HTTP）、物模型（Alink 协议）、规则引擎与数据流转、OTA 升级
- **存量用户**：继续使用没有问题，但要把迁移列入规划。迁移的主要工作量在设备侧的 Topic 与载荷，差别见 [通信协议 · 主流平台 Topic 与载荷对照](./1_protocol#_8、主流平台-topic-与载荷对照)；国内很多资料和设备 SDK 仍按 Alink 写，读到时知道它是这家的私有格式即可

### 7、商业平台对比

| 平台 | 新项目可选 | 国内访问 | 边缘方案 | 适合场景 |
|------|-----------|---------|---------|---------|
| 华为云 IoTDA | 是 | 好 | IoTEdge | 国内快速上云、大型工业与政企 |
| 腾讯云 IoT Explorer | 是（新用户需购买激活码） | 好 | 一般 | 消费 IoT、微信生态 |
| 涂鸦开发者平台 | 是 | 好 | — | 消费类智能硬件整体方案 |
| AWS IoT | 是 | 需走中国区 | Greengrass | 全球化部署 |
| Azure IoT | 是 | 需走中国区 | IoT Edge、IoT Operations | 全球化部署、工厂 OT 数据上云 |
| 阿里云物联网平台 | 否（2025 年 2 月起停止新购） | 好 | — | 仅存量项目 |

云平台的产品名、售卖策略和功能调整较频繁，阿里云停止新购、AWS 下线 IoT Analytics 都是近两年的事，选型前以各厂商官网的当前产品页为准。

---

## 三、开源与源码可见平台

### 1、ThingsBoard

- **定位**：功能最完整的可私有化部署的 IoT 平台，当前主线为 4.x；4.4 起不再是开源许可，见下面的「许可」
- **技术栈**：Java（Spring Boot）；实体数据存 PostgreSQL，时序数据可选 PostgreSQL、Cassandra 或 TimescaleDB；微服务模式下用 Kafka 做内部消息队列
- **核心功能**：设备管理、设备与资产关系、可视化规则链、Dashboard、多租户、OTA
- **规则脚本**：TBEL（ThingsBoard Expression Language）是过滤、转换等规则节点的默认脚本语言，执行快、自带沙箱；JavaScript 仍然可用
- **许可**：4.3 及以前分社区版（CE，Apache 2.0）和专业版（PE，商业许可）。4.4（2026 年 9 月发布）起两版合并成一个产品，改用 BUSL 1.1，源码可见但不是 OSI 意义上的开源：商用的免费额度是 100 台设备、一个生产实例，并保留 ThingsBoard 品牌；教育与非营利的非商业用途是 1000 台。集成、调度、报表等原先 PE 才有的功能进了公开仓库，去掉品牌（白标）、商业支持和超出额度需要商业许可。4.3 CE 仍是 Apache 2.0，安全更新到 2027 年 7 月；每个版本发布 4 年后转为 Apache 2.0

### 2、EMQX

- **定位**：高性能 MQTT Broker，专注接入层，不是完整的 IoT 平台
- **技术栈**：Erlang/OTP
- **核心功能**：MQTT 3.1.1 / 5.0、集群、认证与 ACL、规则引擎与数据集成（转发到 Kafka、数据库等）、多协议网关（CoAP、LwM2M 等）、Dashboard
- **适合**：自建 IoT 平台的消息接入层，或替代云厂商的托管 Broker
- **许可与部署**：5.9 起的许可对集群和托管服务有限制，细则和部署写法见 [EMQX 许可与部署](./3_emqx_deploy)

### 3、JetLinks

- **定位**：国内的响应式 IoT 开源平台
- **技术栈**：Java 17、Spring Boot 3、Spring WebFlux、Project Reactor、R2DBC、Netty / Vert.x；时序存储可选 ElasticSearch、TDengine、TimescaleDB
- **核心功能**：多协议设备接入（MQTT、TCP、UDP、HTTP、CoAP 等）、物模型、规则引擎、可视化
- **版本**：社区版 Apache 2.0，企业版为商业许可

### 4、其他

- **IoT-DC3**：README 自述为「面向 Physical AI 的开源工业物联网运行时」，基于 Java 21、Spring Boot 4、Spring Cloud 2025 的分布式微服务架构，按协议拆成驱动模块（Modbus TCP / RTU、OPC UA、OPC DA、西门子 S7 等），并提供驱动 SDK；许可是 **AGPL 3.0**，改动后作为商业服务对外提供而不开源需要另购商业授权
- **openHAB**：Java 实现的智能家居自动化平台，绑定（binding）生态丰富，EPL 2.0 许可
- **Home Assistant**：Python 实现、社区最活跃的开源智能家居平台，Apache 2.0 许可，不适合企业 IoT

### 5、许可对比

| 产品 | 开源 / 免费部分 | 商业部分 |
|------|----------------|---------|
| ThingsBoard | 4.3 CE：Apache 2.0（安全更新到 2027 年 7 月）；4.4 起 BUSL 1.1，商用免费额度为 100 台设备、一个生产实例 | 超出额度、白标、商业支持 |
| EMQX | 5.9 起 BSL 1.1，单节点生产免费（细则见 [EMQX 许可与部署 · 许可变化](./3_emqx_deploy#二、许可变化)） | 多节点集群等需商业 License |
| JetLinks | 社区版：Apache 2.0 | 企业版：商业许可 |
| IoT-DC3 | AGPL 3.0（改动后对外提供网络服务须开源） | 闭源商用需商业授权 |
| openHAB | EPL 2.0 | 无 |
| Home Assistant | Apache 2.0 | 无 |

---

## 四、选型建议

| 场景 | 推荐 |
|------|------|
| 国内快速上云，不想运维 | 华为云 IoTDA |
| 消费类智能硬件，要现成的 App 或小程序 | 腾讯云 IoT Explorer / 涂鸦开发者平台 |
| 全球化部署 | AWS IoT / Azure IoT |
| 已经在用阿里云物联网平台 | 存量实例继续用并规划迁移，新项目另选 |
| 私有化部署完整平台 | ThingsBoard（4.4 起商用超过 100 台设备要买许可；不买就停在 4.3 CE，它的安全更新到 2027 年 7 月） |
| 自建平台的接入层，单节点够用 | EMQX 单节点（限平台自用；要把平台交付给第三方或做成对外的服务时先确认许可），或 Mosquitto |
| 自建平台的接入层，需要集群且不打算采购 License | 从源码构建 VerneMQ；EMQX 5.8 开源版已于 2026 年 2 月停止维护，只适合内网或过渡期 |
| 边缘网关上的轻量 Broker | NanoMQ |
| 国内团队自研平台、需要读改源码 | JetLinks 社区版；IoT-DC3 是 AGPL 3.0，闭源商用前先确认授权 |
| 个人智能家居 | Home Assistant |

选型时除了功能，还要确认三件事：许可是否允许你的部署方式（集群、SaaS、随硬件销售），时序数据存在哪里、能否换成团队熟悉的存储（见 [时序数据库概览](/nosql/8_tsdb)），设备规模增长后接入层能否水平扩展（连接数上去之后的调优见 [海量连接与连接风暴](../2_access/7_connection_storm)）。选云平台还要多想一步：平台停售或调价时设备侧要改多少，设备的 Topic 与载荷越贴近通用形状，迁移越省事。

接入层选了 EMQX 或还在几个 Broker 之间比较时，接着读 [EMQX 许可与部署](./3_emqx_deploy)：Broker 对比表、5.9 起的许可细则、单节点与三节点集群的部署写法都在那一篇。

决定自研时具体要搭哪些东西，[平台实战概览](../4_practice/0_intro) 用配套仓库 Conduit IoT 给了一个完整的例子：EMQX 只做接入层，鉴权、物模型、数据流水线、时序存储与多租户都由平台自己实现。

---

## 五、ThingsBoard 规则链

### 1、规则链与消息

ThingsBoard 的规则引擎由**规则链（Rule Chain）**组成，设备上报的消息默认进入租户的根规则链（设备配置里可以另指定一条规则链），在节点之间流转。每条消息由三部分组成：

- **msg**：消息体，通常是设备上报的 JSON 数据
- **metadata**：上下文信息，如设备名称、设备类型、时间戳
- **msgType**：消息类型，如遥测上报 `POST_TELEMETRY_REQUEST`、属性上报 `POST_ATTRIBUTES_REQUEST`

节点处理完消息后按输出关系（如 `Success`、`True`、`False`、`Post telemetry`）把消息交给下一个节点。

| 节点 | 作用 |
|------|------|
| **Message Type Switch** | 按消息类型分流到不同分支 |
| **Script 过滤节点** | 执行 TBEL（或 JavaScript）表达式，返回 `true` 走 True 分支，`false` 走 False 分支 |
| **Save Timeseries** | 把消息中的字段保存为时序数据 |
| **Create Alarm** | 创建告警，或更新已存在的活动告警 |
| **REST API Call** | 调用外部 HTTP 接口 |

### 2、示例：温度超限告警

需求：设备上报温度，`temperature > 80` 时创建 CRITICAL 级别告警。

![ThingsBoard 规则链：温度超限告警](../../assets/iot/thingsboard-rule-chain.svg)

Script 过滤节点的 TBEL 脚本：

```javascript
// TBEL 语法与 JavaScript 接近；字段不存在时先判空，避免脚本报错
return msg.temperature != null && msg.temperature > 80;
```

Create Alarm 节点的关键配置：

- **Alarm type**：`HighTemperature`，同一设备同类型的活动告警只有一条，重复触发只会更新它
- **Alarm severity**：`CRITICAL`
- **告警传播**：勾选「Propagate alarm to related entities」后，告警会沿实体关系传播到上级实体（例如设备所属的资产），可以限定关系类型；另有选项把告警传播给直接所有者、整条所有权链或租户。这样在资产或客户层面就能看到下属设备的告警

告警的清除通常再配一个反向条件（如 `temperature <= 75`）接 Clear Alarm 节点，两个阈值之间留出回差，避免在临界值附近反复告警、恢复。

不想改规则链时，用**告警规则（Alarm Rules）**也能配出同样的逻辑。ThingsBoard 4.3 重做了这项功能，官方称为 Alarm Rules 2.0：

- **配在哪**：规则在 Alarms 页统一管理，可以配在设备配置（Device Profile）、资产配置（Asset Profile）上，也可以直接配到某台设备、某个资产或某个客户；官方建议优先配在配置上，同类设备共用一份
- **条件类型**：简单条件、持续时长（条件连续成立多久）、重复次数（条件连续成立多少次）三种，一条规则里可以组合多个测点
- **Missing For**：某个测点超过设定时长没有收到数据就告警，用来做设备停报检测，不必再自己写定时任务
- **兼容**：4.3 之前写在设备配置里的告警规则升级后继续有效

阈值、回差、持续时长、停报检测这些告警设计在各平台是通用的，见 [规则引擎与告警](../3_platform/6_rule_engine)。

### 3、用 HTTP 上报遥测

ThingsBoard 的设备 HTTP API 用设备的 Access Token 鉴权，后端或测试工具可以模拟设备上报遥测，触发规则链：

```java
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class ThingsBoardTelemetryClient {

    private final RestClient restClient;

    // Spring Boot 4 中 RestClient.Builder 的自动配置在 spring-boot-starter-restclient 里
    public ThingsBoardTelemetryClient(RestClient.Builder builder,
                                      @Value("${thingsboard.base-url}") String baseUrl) {
        this.restClient = builder.baseUrl(baseUrl).build();
    }

    /**
     * @param accessToken 设备 Access Token（设备详情页获取）
     * @param telemetry   遥测数据，如 {"temperature": 85, "humidity": 60}
     */
    public void pushTelemetry(String accessToken, Map<String, Object> telemetry) {
        restClient.post()
                .uri("/api/v1/{token}/telemetry", accessToken)
                .contentType(MediaType.APPLICATION_JSON)
                .body(telemetry)
                .retrieve()
                .toBodilessEntity();   // 非 2xx 响应会抛出 RestClientResponseException
    }
}
```

Access Token 出现在 URL 路径中，生产环境必须使用 HTTPS，并避免在网关和应用日志中记录完整 URL。

---

## 六、JetLinks 协议包

JetLinks 用**协议包**接入私有协议设备：协议包是一个独立的 jar，平台在「协议管理」中加载后，产品选择该协议即可接入对应设备。协议包的结构如下：

- **ProtocolSupportProvider**：协议包的入口（SPI），在 `create` 方法中构造并返回协议支持对象
- **CompositeProtocolSupport**：协议支持的组合实现，设置协议 ID、名称，按传输方式（MQTT、TCP、UDP、HTTP 等）注册以下组件
  - **DeviceMessageCodec**：编解码器，上行把设备报文解码为平台标准消息（属性上报、事件、上下线等），下行把平台指令（读写属性、调用功能）编码为设备报文
  - **Authenticator**：设备认证逻辑，如校验 MQTT 用户名密码、TCP 首包中的密钥
  - **配置元数据**：在产品或设备上需要填写的配置项，如密钥
  - **物模型编解码**：一般直接使用平台内置的 JetLinks 物模型格式

自己开发协议包时，建议以官方的 [jetlinks-official-protocol](https://github.com/jetlinks/jetlinks-official-protocol) 为模板：它用 `CompositeProtocolSupport` 同时实现了 MQTT、HTTP、TCP（4 字节长度前缀的二进制帧）和 UDP 四种接入方式，复制后修改报文格式和认证逻辑即可。协议包依赖的 JetLinks 核心库版本要与平台版本一致，否则加载时可能出现类不兼容。

TCP 私有协议的帧格式设计、粘包拆包和心跳是通用问题，见 [自定义私有协议](/netty/8_custom_protocol)、[心跳与连接管理](/netty/9_heartbeat)，不依赖平台自建网关的写法见 [Netty 接入网关](../2_access/6_netty_gateway)。

---

## 小结

- 云平台省运维但绑定厂商，而且会停售：阿里云物联网平台 2025 年 2 月起不再支持新购，国内新项目看华为云 IoTDA，全球化看 AWS IoT 或 Azure IoT
- Azure IoT Hub 不是通用 MQTT Broker，正式可用的连接方式下 Topic 固定；各家云平台的 Topic 与载荷都不相同，换平台要改设备侧
- ThingsBoard、JetLinks 是完整平台，其中 ThingsBoard 从 4.4 起改用 BUSL 1.1，商用免费额度是 100 台设备；EMQX 只做接入层，平台能力要自己组合
- 选型除了功能还要确认三件事：许可是否允许你的部署方式、时序数据存在哪里、接入层能否水平扩展；EMQX 的许可与部署单独成篇
- ThingsBoard 规则链里，消息由 msg、metadata、msgType 组成，脚本默认用 TBEL；告警传播是沿实体关系和所有权向上传播；4.3 起的告警规则可以配到配置、单个实体或客户，并支持停报检测
- JetLinks 私有协议通过协议包接入：ProtocolSupportProvider 构造 CompositeProtocolSupport，按传输方式注册编解码器和认证器

## 参考资料

- 阿里云物联网平台计费概述（停止新购说明）：[https://help.aliyun.com/zh/iot/product-overview/billing-overview](https://help.aliyun.com/zh/iot/product-overview/billing-overview)
- 华为云 IoTDA 产品规格：[https://support.huaweicloud.com/productdesc-iothub/iot_04_0014.html](https://support.huaweicloud.com/productdesc-iothub/iot_04_0014.html)
- 腾讯云物联网开发平台公共实例使用公告：[https://cloud.tencent.com/document/product/1081/107530](https://cloud.tencent.com/document/product/1081/107530)
- 涂鸦开发者平台简介：[https://developer.tuya.com/cn/docs/iot/introduction-of-tuya?id=K914joffendwh](https://developer.tuya.com/cn/docs/iot/introduction-of-tuya?id=K914joffendwh)
- Azure IoT Hub 的 MQTT 支持（与 Event Grid 的对比）：[https://learn.microsoft.com/en-us/azure/iot/iot-mqtt-connect-to-iot-hub](https://learn.microsoft.com/en-us/azure/iot/iot-mqtt-connect-to-iot-hub)
- Azure IoT Operations 概述：[https://learn.microsoft.com/en-us/azure/iot-operations/overview-iot-operations](https://learn.microsoft.com/en-us/azure/iot-operations/overview-iot-operations)
- IoT-DC3：[https://github.com/pnoker/iot-dc3](https://github.com/pnoker/iot-dc3)
- ThingsBoard 文档：[https://thingsboard.io/docs/](https://thingsboard.io/docs/)
- ThingsBoard 告警规则：[https://thingsboard.io/docs/user-guide/alarm-rules/](https://thingsboard.io/docs/user-guide/alarm-rules/)
- ThingsBoard 4.3 发布说明（Alarm Rules 2.0）：[https://thingsboard.io/blog/thingsboard-4-3-alarm-rules-2-0-enhanced-calculated-fields-api-keys-and-more/](https://thingsboard.io/blog/thingsboard-4-3-alarm-rules-2-0-enhanced-calculated-fields-api-keys-and-more/)
- ThingsBoard TBEL：[https://thingsboard.io/docs/user-guide/tbel/](https://thingsboard.io/docs/user-guide/tbel/)
- ThingsBoard Create Alarm 节点：[https://thingsboard.io/docs/reference/rule-engine/nodes/action/create-alarm/](https://thingsboard.io/docs/reference/rule-engine/nodes/action/create-alarm/)
- JetLinks 社区版：[https://github.com/jetlinks/jetlinks-community](https://github.com/jetlinks/jetlinks-community)
- JetLinks 官方协议包：[https://github.com/jetlinks/jetlinks-official-protocol](https://github.com/jetlinks/jetlinks-official-protocol)
- AWS IoT Analytics 停止支持说明：[https://docs.aws.amazon.com/zh_cn/iotanalytics/latest/userguide/iotanalytics-end-of-support.html](https://docs.aws.amazon.com/zh_cn/iotanalytics/latest/userguide/iotanalytics-end-of-support.html)

> 下一篇：[EMQX 许可与部署](./3_emqx_deploy) —— Broker 对比、5.9 起的 BSL 许可、单节点部署、三节点集群与四层负载均衡。

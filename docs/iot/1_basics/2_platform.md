---
description: 云平台与开源平台对比、许可对比、选型建议、ThingsBoard 规则链、JetLinks 协议包
---

# 平台选型

> 前置阅读：[通信协议](./1_protocol)

IoT 平台提供设备接入、设备管理、规则引擎、数据存储与可视化等能力，分为云托管、完整开源平台和纯接入 Broker 三类。本篇讲各类平台的对比与选型建议、ThingsBoard 规则链、JetLinks 协议包。

---

## 一、平台分类

| 类型 | 说明 | 代表产品 |
|------|------|---------|
| **商业云平台** | 开箱即用，按量计费，免运维，能力与厂商云生态绑定 | 阿里云物联网平台、华为云 IoTDA、腾讯云 IoT Explorer、AWS IoT Core |
| **开源完整平台** | 私有化部署，可二次开发，需自行运维 | ThingsBoard、JetLinks、IoT-DC3 |
| **接入层组件** | 只负责 MQTT 等协议接入与消息路由，平台能力自建 | EMQX、Mosquitto、NanoMQ |
| **家居生态平台** | 面向智能家居，偏个人和消费场景 | Home Assistant、openHAB、米家、涂鸦 |

---

## 二、商业云平台

### 1、阿里云物联网平台

- **定位**：国内使用最广的托管 IoT 平台
- **核心能力**：设备接入（MQTT / CoAP / HTTP）、物模型、规则引擎与数据流转、OTA 升级，以及配套的边缘计算能力
- **适合**：国内互联网与工业企业快速上云

### 2、华为云 IoTDA

- **定位**：华为云的设备接入服务（IoTDA，前身为 OceanConnect），偏工业和政企场景
- **核心能力**：设备接入与管理、设备影子、规则引擎、OTA，边缘侧配合华为云 IoTEdge
- **适合**：工业制造、智慧城市、大型政企项目

### 3、腾讯云 IoT Explorer

- **定位**：腾讯云的物联网开发平台，与微信生态结合紧密
- **核心能力**：设备接入、物模型、数据开发，配套腾讯连连小程序做设备控制
- **适合**：消费类智能硬件、需要微信小程序控制设备的场景

### 4、AWS IoT

- **定位**：全球化部署最成熟的 IoT 云服务
- **核心能力**：IoT Core（设备接入、规则、Device Shadow 设备影子）、Greengrass（边缘运行时）、IoT SiteWise（工业设备数据建模与采集）
- **注意**：AWS IoT Analytics 已于 2025 年 12 月 15 日停止支持，IoT Events 已于 2026 年 5 月 20 日停止支持，数据分析改用 IoT Core 规则把数据转到 Kinesis、S3 等服务再处理
- **适合**：全球化部署、已经在用 AWS 的企业

### 5、商业平台对比

| 平台 | 国内访问 | 边缘计算 | 工业支持 | 适合场景 |
|------|---------|---------|---------|---------|
| 阿里云物联网平台 | 好 | 有 | 中 | 国内互联网、工业 |
| 华为云 IoTDA | 好 | 有（IoTEdge） | 强 | 大型工业、政企 |
| 腾讯云 IoT Explorer | 好 | 一般 | 弱 | 消费 IoT、微信生态 |
| AWS IoT | 国内访问需走中国区 | 有（Greengrass） | 中 | 全球化部署 |

云平台的产品名和功能调整较频繁，选型前以各厂商官网的当前产品页为准。

---

## 三、开源平台

### 1、ThingsBoard

- **定位**：功能最完整的开源 IoT 平台，当前主线为 4.x
- **技术栈**：Java（Spring Boot）；实体数据存 PostgreSQL，时序数据可选 PostgreSQL、Cassandra 或 TimescaleDB；微服务模式下用 Kafka 做内部消息队列
- **核心功能**：设备管理、设备与资产关系、可视化规则链、Dashboard、多租户、OTA
- **规则脚本**：TBEL（ThingsBoard Expression Language）是过滤、转换等规则节点的默认脚本语言，执行快、自带沙箱；JavaScript 仍然可用
- **版本**：社区版（CE）Apache 2.0，专业版（PE）为商业许可，白标、集成等能力在 PE 中

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

- **IoT-DC3**：基于 Spring Cloud 的分布式 IoT 平台，按协议拆分驱动微服务（Modbus、MQTT、OPC 等）
- **openHAB**：Java 实现的智能家居自动化平台，绑定（binding）生态丰富，EPL 2.0 许可
- **Home Assistant**：Python 实现、社区最活跃的开源智能家居平台，Apache 2.0 许可，不适合企业 IoT

### 5、许可对比

| 产品 | 开源 / 免费部分 | 商业部分 |
|------|----------------|---------|
| ThingsBoard | CE：Apache 2.0 | PE：商业许可 |
| EMQX | 5.9 起 BSL 1.1，单节点生产免费（细则见 [EMQX 许可与部署 · 许可变化](./3_emqx_deploy#二、许可变化)） | 多节点集群等需商业 License |
| JetLinks | 社区版：Apache 2.0 | 企业版：商业许可 |
| openHAB | EPL 2.0 | 无 |
| Home Assistant | Apache 2.0 | 无 |

---

## 四、选型建议

| 场景 | 推荐 |
|------|------|
| 快速上云，不想运维 | 阿里云物联网平台 / 华为云 IoTDA |
| 全球化部署 | AWS IoT |
| 私有化部署完整平台 | ThingsBoard |
| 自建平台的接入层，单节点够用 | EMQX 单节点，或 Mosquitto |
| 自建平台的接入层，需要集群且不打算采购 License | EMQX 5.8 开源版（不再有新功能），或从源码构建 VerneMQ |
| 边缘网关上的轻量 Broker | NanoMQ |
| 国内团队自研平台、需要读改源码 | JetLinks / IoT-DC3 |
| 个人智能家居 | Home Assistant |

选型时除了功能，还要确认三件事：许可是否允许你的部署方式（集群、SaaS、随硬件销售），时序数据存在哪里、能否换成团队熟悉的存储（见 [时序数据库](/nosql/4_time_series_db)），设备规模增长后接入层能否水平扩展。

接入层选了 EMQX 或还在几个 Broker 之间比较时，接着读 [EMQX 许可与部署](./3_emqx_deploy)：Broker 对比表、5.9 起的许可细则、单节点与三节点集群的部署写法都在那一篇。

决定自研时具体要搭哪些东西，[平台实战概览](../4_practice/0_intro) 用配套仓库 Conduit IoT 给了一个完整的例子：EMQX 只做接入层，鉴权、物模型、数据流水线、时序存储与多租户都由平台自己实现。

---

## 五、ThingsBoard 规则链

### 1、规则链与消息

ThingsBoard 的规则引擎由**规则链（Rule Chain）**组成，设备上报的每条消息都会进入租户的根规则链，在节点之间流转。每条消息由三部分组成：

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

告警的清除通常再配一个反向条件（如 `temperature <= 75`）接 Clear Alarm 节点，两个阈值之间留出回差，避免在临界值附近反复告警、恢复。新版本也可以在设备配置（Device Profile）中用告警规则配置同样的逻辑，无需改动规则链。

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

- 云平台省运维但绑定厂商；ThingsBoard、JetLinks 是完整平台；EMQX 只做接入层，平台能力要自己组合
- 选型除了功能还要确认三件事：许可是否允许你的部署方式、时序数据存在哪里、接入层能否水平扩展；EMQX 的许可与部署单独成篇
- ThingsBoard 规则链里，消息由 msg、metadata、msgType 组成，脚本默认用 TBEL；告警传播是沿实体关系和所有权向上传播
- JetLinks 私有协议通过协议包接入：ProtocolSupportProvider 构造 CompositeProtocolSupport，按传输方式注册编解码器和认证器

## 参考资料

- ThingsBoard 文档：[https://thingsboard.io/docs/](https://thingsboard.io/docs/)
- ThingsBoard TBEL：[https://thingsboard.io/docs/user-guide/tbel/](https://thingsboard.io/docs/user-guide/tbel/)
- ThingsBoard Create Alarm 节点：[https://thingsboard.io/docs/reference/rule-engine/nodes/action/create-alarm/](https://thingsboard.io/docs/reference/rule-engine/nodes/action/create-alarm/)
- JetLinks 社区版：[https://github.com/jetlinks/jetlinks-community](https://github.com/jetlinks/jetlinks-community)
- JetLinks 官方协议包：[https://github.com/jetlinks/jetlinks-official-protocol](https://github.com/jetlinks/jetlinks-official-protocol)
- AWS IoT Analytics 停止支持说明：[https://docs.aws.amazon.com/zh_cn/iotanalytics/latest/userguide/iotanalytics-end-of-support.html](https://docs.aws.amazon.com/zh_cn/iotanalytics/latest/userguide/iotanalytics-end-of-support.html)

> 下一篇：[EMQX 许可与部署](./3_emqx_deploy) —— Broker 对比、5.9 起的 BSL 许可、单节点部署、三节点集群与四层负载均衡。

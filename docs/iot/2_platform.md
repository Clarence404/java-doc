# IoT 平台选型

> 参考资料：
> * ThingsBoard：[https://thingsboard.io](https://thingsboard.io)
> * EMQX：[https://www.emqx.io](https://www.emqx.io)
> * JetLinks：[https://gitee.com/jetlinks](https://gitee.com/jetlinks)

## 一、平台分类

| 类型 | 说明 | 代表产品 |
|------|------|---------|
| **商业云平台** | 开箱即用，按量计费，免运维 | 阿里云 IoT、华为云 IoT、腾讯云 IoT、AWS IoT |
| **开源自建平台** | 私有化部署，可定制，需运维 | ThingsBoard、EMQX、JetLinks、IoT-DC3 |
| **消费级生态平台** | 面向智能家居，硬件绑定 | 小米 IoT / 米家、涂鸦 IoT |

---

## 二、商业云平台

### 阿里云 IoT

- **定位**：国内使用最广的企业级 IoT 云平台
- **核心能力**：设备接入（MQTT / CoAP / HTTP）、规则引擎、物模型、OTA 升级、边缘计算（Link IoT Edge）
- **适合**：国内互联网 / 工业企业，需要快速上云
- 官网：[https://iot.aliyun.com](https://iot.aliyun.com)

### 华为云 IoT

- **定位**：偏工业和政企场景，与华为设备生态深度集成
- **核心能力**：设备接入、IoT 边缘（IEF）、数字孪生、与华为 OceanConnect 对接
- **适合**：工业制造、智慧城市、大型政企项目
- 官网：[https://www.huaweicloud.com/product/iot.html](https://www.huaweicloud.com/product/iot.html)

### 腾讯云 IoT

- **定位**：与腾讯 AI / 微信生态集成能力强
- **核心能力**：IoT Hub（设备接入）、IoT Explorer（平台）、腾讯连连 App
- **适合**：消费 IoT、智能家居品牌、需要微信小程序控制设备的场景
- 官网：[https://cloud.tencent.com/product/iot-class](https://cloud.tencent.com/product/iot-class)

### AWS IoT

- **定位**：全球最成熟的 IoT 云服务
- **核心能力**：IoT Core（设备接入）、Greengrass（边缘计算）、Device Shadow（设备影子）、IoT Analytics
- **适合**：全球化部署、已上 AWS 的企业
- 官网：[https://aws.amazon.com/iot](https://aws.amazon.com/iot)

### 商业平台对比

| 平台 | 国内延迟 | 边缘计算 | 工业支持 | 适合场景 |
|------|---------|---------|---------|---------|
| 阿里云 IoT | 优 | ✅ | 中 | 国内互联网 / 工业 |
| 华为云 IoT | 优 | ✅ | 强 | 大型工业 / 政企 |
| 腾讯云 IoT | 优 | 一般 | 弱 | 消费 IoT / 微信生态 |
| AWS IoT | 差（国内）| ✅ | 中 | 全球化部署 |

---

## 三、开源平台

### ThingsBoard

- **定位**：功能最完整的开源 IoT 平台，支持私有化部署
- **技术栈**：Java（Spring Boot）+ PostgreSQL / Cassandra
- **核心功能**：设备管理、规则引擎（可视化拖拽）、Dashboard 看板、多租户、OTA 升级
- **部署方式**：Docker / K8s，支持社区版（免费）和专业版
- **适合**：需要自建完整 IoT 平台的企业
- 官网：[https://thingsboard.io](https://thingsboard.io)
- GitHub：[https://github.com/thingsboard/thingsboard](https://github.com/thingsboard/thingsboard)

### EMQX

- **定位**：高性能 MQTT Broker，不是完整 IoT 平台，专注消息接入层
- **技术栈**：Erlang/OTP
- **核心功能**：MQTT 3.1.1 / 5.0、集群、桥接、规则引擎（数据转发到 Kafka / DB）、Web 管理界面
- **适合**：作为自建 IoT 平台的消息接入组件，或替代云厂商 MQTT Broker
- 官网：[https://www.emqx.io](https://www.emqx.io)
- GitHub：[https://github.com/emqx/emqx](https://github.com/emqx/emqx)

### JetLinks

- **定位**：国内响应式 IoT 开源平台，全响应式架构
- **技术栈**：Java（Spring WebFlux + R2DBC）+ ReactiveX
- **核心功能**：设备接入、物模型、规则引擎、可视化、多协议支持
- **适合**：国内团队自建 IoT 平台，希望源码可读可改
- GitHub：[https://gitee.com/jetlinks](https://gitee.com/jetlinks)

### IoT-DC3

- **定位**：基于 Spring Cloud 的分布式 IoT 平台
- **技术栈**：Spring Cloud + Netty
- **特点**：微服务架构，支持多种驱动（Modbus / MQTT / OPC-DA）
- GitHub / 文档：[https://doc.dc3.site](https://doc.dc3.site)

### OpenHAB

- **定位**：智能家居自动化平台，重点在家居设备集成
- **特点**：插件生态丰富（2000+ 绑定），支持 Zigbee / Z-Wave / KNX / MQTT 等
- **适合**：个人智能家居、非商业 IoT 项目
- 官网：[https://www.openhab.org](https://www.openhab.org)

### Home Assistant

- **定位**：最流行的开源智能家居平台
- **技术栈**：Python
- **特点**：插件生态极其丰富，社区活跃，专注家居自动化，不适合企业 IoT
- **适合**：个人家居玩家
- 官网：[https://www.home-assistant.io](https://www.home-assistant.io)

---

## 四、选型建议

| 场景 | 推荐 |
|------|------|
| 快速上云，不想运维 | 阿里云 / 华为云 IoT |
| 全球化部署 | AWS IoT |
| 私有化部署完整平台 | ThingsBoard |
| 自建平台的消息接入层 | EMQX |
| 国内团队自研 IoT 平台 | JetLinks / IoT-DC3 |
| 个人智能家居 | Home Assistant |

> [!warning]
> 待补充：ThingsBoard 规则引擎实战、EMQX 集群部署、JetLinks 二次开发指南

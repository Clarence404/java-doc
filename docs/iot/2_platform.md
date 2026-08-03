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

---

## 五、ThingsBoard 规则引擎实战

### 规则链基本概念

ThingsBoard 规则引擎基于 **规则链（Rule Chain）** 工作，消息在节点间流转：

```
设备上报消息 → Message → Rule Node（处理/过滤/转发）→ Next Rule Node → ...
```

每条消息携带：
- **消息体（msg）**：JSON 格式的设备数据
- **元数据（metadata）**：设备 ID、设备名称、租户 ID 等上下文信息
- **消息类型（msgType）**：如 `POST_TELEMETRY_REQUEST`、`POST_ATTRIBUTES_REQUEST`

### 核心节点类型

| 节点类型 | 作用 |
|---------|------|
| **Message Type Switch** | 按消息类型路由，将不同类型分发到不同分支 |
| **Script Filter（JS）** | 执行 JavaScript 表达式过滤消息，返回 `true` 放行，`false` 过滤掉 |
| **Save Timeseries** | 将消息体中的字段保存为时序数据到数据库 |
| **Create Alarm** | 根据条件创建或更新告警，支持告警级别（CRITICAL / MAJOR / WARNING） |
| **Rest API Call** | 向外部 HTTP 接口发送请求，可携带消息体 |

### 场景示例：温度超阈值创建告警

**需求**：设备上报温度，当 `temperature > 80` 时创建 CRITICAL 级别告警。

**配置思路**：

```
POST_TELEMETRY_REQUEST
        ↓
Message Type Switch
        ↓（匹配 POST_TELEMETRY_REQUEST）
Script Filter：temperature > 80
        ↓（True）
Create Alarm：type=HighTemperature, severity=CRITICAL
```

**Script Filter 节点脚本示例**：

```javascript
// 过滤条件：温度超过 80 度
return msg.temperature > 80;
```

**Create Alarm 节点关键配置**：
- Alarm Type：`HighTemperature`
- Alarm Severity：`CRITICAL`
- Propagate：勾选（向上级租户传播）

### 通过 REST API 上报遥测数据（Java 示例）

ThingsBoard 提供设备 API，Java 后端可直接模拟设备上报遥测触发规则引擎。

**使用 RestTemplate 上报：**

```java
import org.springframework.web.client.RestTemplate;
import org.springframework.http.*;
import java.util.Map;

public class ThingsBoardTelemetryClient {

    private static final String TB_HOST = "http://localhost:8080";

    /**
     * 向 ThingsBoard 上报遥测数据
     *
     * @param accessToken 设备访问 Token（在 ThingsBoard 设备详情页获取）
     * @param telemetry   遥测数据，如 {"temperature": 85, "humidity": 60}
     */
    public void pushTelemetry(String accessToken, Map<String, Object> telemetry) {
        RestTemplate restTemplate = new RestTemplate();

        String url = TB_HOST + "/api/v1/" + accessToken + "/telemetry";

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        HttpEntity<Map<String, Object>> request = new HttpEntity<>(telemetry, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(url, request, String.class);

        if (response.getStatusCode() == HttpStatus.OK) {
            System.out.println("遥测数据上报成功");
        } else {
            System.err.println("上报失败，状态码：" + response.getStatusCode());
        }
    }
}
```

**使用 HttpClient（Java 11+）上报：**

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

public class ThingsBoardHttpClient {

    private static final String TB_HOST = "http://localhost:8080";
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public void pushTelemetry(String accessToken, Map<String, Object> telemetry) throws Exception {
        String body = objectMapper.writeValueAsString(telemetry);
        String url = TB_HOST + "/api/v1/" + accessToken + "/telemetry";

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println("HTTP 状态码：" + response.statusCode());
    }
}
```

---

## 六、EMQX 集群部署

### 单机 vs 集群适用场景

| 模式 | 适用场景 |
|------|---------|
| **单机** | 开发测试、设备数量 < 10 万、无高可用要求 |
| **集群** | 生产环境、设备数量 > 10 万、需要水平扩展与故障转移 |

EMQX 集群基于 Erlang 分布式实现，节点间自动同步路由表和会话信息，客户端断线重连到任意节点均可恢复订阅。

### Docker Compose 三节点集群配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  emqx1:
    image: emqx:5.7
    container_name: emqx1
    hostname: emqx1
    environment:
      - EMQX_NODE__NAME=emqx@emqx1
      - EMQX_CLUSTER__DISCOVERY_STRATEGY=static
      - EMQX_CLUSTER__STATIC__SEEDS=emqx@emqx1,emqx@emqx2,emqx@emqx3
    ports:
      - "1883:1883"    # MQTT
      - "8083:8083"    # MQTT over WebSocket
      - "18083:18083"  # Dashboard（仅第一个节点对外暴露）
    networks:
      - emqx-net
    volumes:
      - emqx1-data:/opt/emqx/data

  emqx2:
    image: emqx:5.7
    container_name: emqx2
    hostname: emqx2
    environment:
      - EMQX_NODE__NAME=emqx@emqx2
      - EMQX_CLUSTER__DISCOVERY_STRATEGY=static
      - EMQX_CLUSTER__STATIC__SEEDS=emqx@emqx1,emqx@emqx2,emqx@emqx3
    ports:
      - "1884:1883"
      - "8084:8083"
    networks:
      - emqx-net
    volumes:
      - emqx2-data:/opt/emqx/data

  emqx3:
    image: emqx:5.7
    container_name: emqx3
    hostname: emqx3
    environment:
      - EMQX_NODE__NAME=emqx@emqx3
      - EMQX_CLUSTER__DISCOVERY_STRATEGY=static
      - EMQX_CLUSTER__STATIC__SEEDS=emqx@emqx1,emqx@emqx2,emqx@emqx3
    ports:
      - "1885:1883"
      - "8085:8083"
    networks:
      - emqx-net
    volumes:
      - emqx3-data:/opt/emqx/data

networks:
  emqx-net:
    driver: bridge

volumes:
  emqx1-data:
  emqx2-data:
  emqx3-data:
```

启动集群：

```bash
docker-compose up -d
```

### Nginx TCP 负载均衡配置

在 `nginx.conf` 中添加 `stream` 块，代理 MQTT 1883 端口：

```nginx
# nginx.conf（需要编译 --with-stream 模块）
stream {
    upstream emqx_cluster {
        least_conn;
        server 127.0.0.1:1883;
        server 127.0.0.1:1884;
        server 127.0.0.1:1885;
    }

    server {
        listen 1883;
        proxy_pass emqx_cluster;
        proxy_timeout 30s;
        proxy_connect_timeout 5s;
    }
}
```

设备连接 Nginx 的 1883 端口，请求被轮询转发到三个 EMQX 节点。

### 集群状态查看

进入任意 EMQX 节点容器查看集群状态：

```bash
# 进入容器
docker exec -it emqx1 bash

# 查看集群状态（所有节点及其角色）
emqx_ctl cluster status

# 预期输出示例：
# Cluster status: #{running_nodes =>
#     ['emqx@emqx1','emqx@emqx2','emqx@emqx3'],
#   stopped_nodes => []}

# 查看当前连接数
emqx_ctl broker stats | grep connections.count

# 查看集群节点详情
emqx_ctl cluster info
```

---

## 七、JetLinks 二次开发指南

### 核心扩展点：设备协议（ProtocolSupport）

JetLinks 支持通过实现 `ProtocolSupport` 接口来接入自定义设备协议，适用于企业私有协议或行业专用协议（如 Modbus 变种、私有二进制帧）。

扩展架构：

```
自定义协议包
    └── ProtocolSupport（协议描述）
            └── DeviceMessageCodec（消息编解码）
                    ├── encode()  Java 消息 → 字节流（下行）
                    └── decode()  字节流 → Java 消息（上行）
```

### Maven 依赖

```xml
<dependencies>
    <!-- JetLinks 协议开发核心包 -->
    <dependency>
        <groupId>org.jetlinks</groupId>
        <artifactId>jetlinks-supports</artifactId>
        <version>2.0.0</version>
    </dependency>

    <!-- 响应式支持 -->
    <dependency>
        <groupId>io.projectreactor</groupId>
        <artifactId>reactor-core</artifactId>
    </dependency>
</dependencies>
```

### 自定义协议骨架代码

**实现 ProtocolSupport 接口：**

```java
import org.jetlinks.core.ProtocolSupport;
import org.jetlinks.core.message.codec.DeviceMessageCodec;
import org.jetlinks.core.message.codec.Transport;
import org.jetlinks.core.metadata.DefaultConfigMetadata;
import org.jetlinks.core.metadata.DeviceMetadataCodec;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * 自定义设备协议实现
 * 向 JetLinks 平台注册本协议后，平台可通过该协议接入对应设备
 */
public class MyDeviceProtocol implements ProtocolSupport {

    /** 协议唯一标识，用于平台内检索和绑定 */
    @Override
    public String getId() {
        return "my-device-protocol-v1";
    }

    /** 协议显示名称，展示在 JetLinks 管理界面 */
    @Override
    public String getName() {
        return "我的设备私有协议 V1";
    }

    /** 协议描述 */
    @Override
    public String getDescription() {
        return "适用于 XX 系列传感器的私有二进制协议，基于 TCP 长连接";
    }

    /**
     * 声明本协议支持的传输方式
     * 常用值：Transport.MQTT / Transport.TCP / Transport.UDP / Transport.HTTP
     */
    @Override
    public Flux<Transport> getSupportedTransport() {
        return Flux.just(Transport.MQTT, Transport.TCP);
    }

    /**
     * 返回对应传输方式的消息编解码器
     */
    @Override
    public Mono<? extends DeviceMessageCodec> getMessageCodec(Transport transport) {
        return Mono.just(new MyDeviceMessageCodec());
    }

    /** 返回设备物模型的编解码实现（可使用内置 JetLinksDeviceMetadataCodec） */
    @Override
    public Mono<? extends DeviceMetadataCodec> getMetadataCodec() {
        return Mono.just(JetLinksDeviceMetadataCodec.getInstance());
    }

    /** 协议配置项定义（可选，无需额外配置时返回空） */
    @Override
    public Mono<? extends ConfigMetadata> getConfigMetadata(Transport transport) {
        return Mono.empty();
    }
}
```

### 消息编解码器（DeviceMessageCodec）示例

```java
import org.jetlinks.core.message.DeviceMessage;
import org.jetlinks.core.message.codec.*;
import org.jetlinks.core.message.property.ReportPropertyMessage;
import reactor.core.publisher.Mono;

import java.util.HashMap;
import java.util.Map;

/**
 * 自定义消息编解码器
 * decode：将设备上报的原始消息（MQTT payload）解析为 JetLinks 标准消息
 * encode：将平台下发的指令转换为设备可识别的格式
 */
public class MyDeviceMessageCodec implements DeviceMessageCodec {

    @Override
    public Transport getSupportTransport() {
        return Transport.MQTT;
    }

    /**
     * 解码：设备上报数据 → JetLinks 标准消息
     * 示例：解析 JSON 格式的属性上报 {"temperature":25.6, "humidity":60}
     */
    @Override
    public Mono<DeviceMessage> decode(MessageDecodeContext context) {
        // 获取原始 MQTT 消息
        MqttMessage mqttMessage = (MqttMessage) context.getMessage();
        String payload = mqttMessage.getPayload().toString(java.nio.charset.StandardCharsets.UTF_8);

        // 简单 JSON 解析（实际项目建议使用 Jackson 或 Fastjson）
        Map<String, Object> props = parseJson(payload);

        // 构造 JetLinks 属性上报消息
        ReportPropertyMessage message = new ReportPropertyMessage();
        message.setDeviceId(context.getDevice().getDeviceId());
        message.setTimestamp(System.currentTimeMillis());
        message.setProperties(props);

        return Mono.just(message);
    }

    /**
     * 编码：平台下发指令 → 设备可识别的格式
     * 示例：将读取属性指令转为设备协议格式
     */
    @Override
    public Mono<EncodedMessage> encode(MessageEncodeContext context) {
        // 根据 context.getMessage() 的类型处理不同指令
        // 此处简单返回空（只做上行解析的场景可返回 Mono.empty()）
        return Mono.empty();
    }

    /** 简易 JSON 解析，仅用于示例 */
    private Map<String, Object> parseJson(String json) {
        // 实际项目请使用 Jackson ObjectMapper 等成熟库
        Map<String, Object> map = new HashMap<>();
        // ... 解析逻辑
        return map;
    }
}
```

### 注册协议到 Spring 容器

```java
import org.jetlinks.core.ProtocolSupports;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ProtocolConfig {

    /**
     * 在 Spring 启动时将自定义协议注册到 JetLinks
     */
    @Bean
    public ApplicationRunner registerProtocol(ProtocolSupports protocolSupports) {
        return args -> protocolSupports.register(new MyDeviceProtocol());
    }
}
```

注册完成后，在 JetLinks 管理界面「协议管理」中即可看到并选择该协议绑定设备产品。

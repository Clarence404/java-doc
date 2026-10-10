---
description: HiveMQ 客户端、持久会话与重连、共享订阅、Spring Integration MQTT v5、Topic 路由
---

# MQTT 客户端

> 前置阅读：[通信协议](./1_protocol)

本篇讲 Java 侧怎么接入 MQTT 5：独立进程（网关、采集器、压测工具）用 HiveMQ MQTT Client，Spring Boot 业务服务用 Spring Integration MQTT，并配好持久会话、自动重连、共享订阅和按 Topic 路由。版本基线：JDK 21、Spring Boot 4.x（依赖管理带 Spring Integration 7.x）、HiveMQ MQTT Client 1.4.0、Paho mqttv5 1.2.5。

---

## 一、客户端选型

### 1、三个可选项

| 选项 | 协议版本 | 现状 | 适合场景 |
|------|---------|------|---------|
| HiveMQ MQTT Client | MQTT 5 / 3.1.1 | 持续发版，1.4.0 发布于 2026 年 8 月；提供 Async、Reactive（RxJava）、Blocking 三套 API | 网关、采集器、压测工具等独立进程 |
| Eclipse Paho Java（mqttv3 / mqttv5） | 3.1.1 / 5 | 最后一个正式版是 2020 年的 1.2.5，此后没有新版本 | 存量项目；Spring Integration 的底层依赖 |
| Spring Integration MQTT | 3.1.1 / 5 | 随 Spring Integration 发版，适配器底层仍是 Paho | Spring Boot 业务服务，需要与通道、路由、网关组合 |

**结论**：新写的独立客户端用 HiveMQ MQTT Client；Spring Boot 服务用 Spring Integration 的 **v5 适配器**（`Mqttv5PahoMessageDrivenChannelAdapter` / `Mqttv5PahoMessageHandler`），接受它依赖 Paho 的现实，把 MQTT 收发封装在一个配置类里，将来替换客户端时影响面最小。

### 2、不再推荐的写法

- `org.eclipse.paho.client.mqttv3` 只支持 MQTT 3.1.1，拿不到会话过期、消息过期、共享订阅标准语法、原因码等 MQTT 5 能力
- 用 `System.currentTimeMillis()` 拼随机 clientId 并设 `cleanSession=true`：每次重连都是新会话，断线期间的 QoS 1 消息全部丢失，多实例时还会重复消费
- 把用户名、密码写在配置类里：凭据应来自环境变量或密钥管理系统，设备侧推荐一机一密或 X.509 证书，见 [设备安全](./5_security)

---

## 二、HiveMQ MQTT Client

### 1、依赖

```xml
<dependency>
    <groupId>com.hivemq</groupId>
    <artifactId>hivemq-mqtt-client</artifactId>
    <version>1.4.0</version>
</dependency>
```

### 2、建连：TLS、自动重连、持久会话、遗嘱

```java
import com.hivemq.client.mqtt.MqttGlobalPublishFilter;
import com.hivemq.client.mqtt.datatypes.MqttQos;
import com.hivemq.client.mqtt.mqtt5.Mqtt5AsyncClient;
import com.hivemq.client.mqtt.mqtt5.Mqtt5Client;
import com.hivemq.client.mqtt.mqtt5.message.publish.Mqtt5Publish;
import com.hivemq.client.mqtt.mqtt5.message.subscribe.suback.Mqtt5SubAck;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public record MqttSettings(String host, int port, String clientId,
                           String username, String password, String sharedGroup) {}

public final class GatewayMqttClient implements AutoCloseable {

    private final MqttSettings settings;
    private final Mqtt5AsyncClient client;
    // 业务处理放到虚拟线程，不占用客户端的 Netty IO 线程
    private final ExecutorService worker = Executors.newVirtualThreadPerTaskExecutor();

    public GatewayMqttClient(MqttSettings settings) {
        this.settings = settings;
        this.client = Mqtt5Client.builder()
                .identifier(settings.clientId())          // 固定且全局唯一，重连后才能接上原会话
                .serverHost(settings.host())
                .serverPort(settings.port())              // TLS 端口 8883
                .sslWithDefaultConfig()                   // 用 JDK 默认信任库校验服务端证书
                .automaticReconnect()
                    .initialDelay(1, TimeUnit.SECONDS)
                    .maxDelay(60, TimeUnit.SECONDS)       // 指数退避上限，避免全网设备同时重连
                    .applyAutomaticReconnect()
                .buildAsync();
    }

    public CompletableFuture<Void> start(Consumer<Mqtt5Publish> handler) {
        // 先注册全局回调再连接：持久会话里积压的消息在 CONNACK 之后立刻到达，晚注册会漏掉
        client.publishes(MqttGlobalPublishFilter.ALL, handler, worker);

        return client.connectWith()
                .cleanStart(false)                        // 复用 Broker 上的会话
                .sessionExpiryInterval(3600)              // 断线后会话保留 1 小时
                .keepAlive(60)
                .simpleAuth()
                    .username(settings.username())
                    .password(settings.password().getBytes(StandardCharsets.UTF_8))
                    .applySimpleAuth()
                .willPublish()
                    .topic("gateways/" + settings.clientId() + "/status")
                    .qos(MqttQos.AT_LEAST_ONCE)
                    .payload("{\"online\":false}".getBytes(StandardCharsets.UTF_8))
                    .retain(true)
                    .applyWillPublish()
                .send()
                .thenCompose(connAck -> subscribe())
                .thenAccept(subAck -> { });
    }

    // subscribe()、sendCommand()、close() 见下一小节
```

几个参数的取舍：

- **`cleanStart(false)` + `sessionExpiryInterval`**：MQTT 5 把 3.1.1 的 `cleanSession` 拆成两个参数，前者决定是否接续旧会话，后者决定断线后 Broker 保留会话多久；两者配合才能做到"短暂断线不丢 QoS 1 消息"
- **遗嘱 + retain**：网关异常掉线时 Broker 代发 `online=false`，新订阅者也能立刻读到最新在线状态；连接成功后要主动发一条保留的 `online=true` 覆盖旧状态，正常断开时 Broker 不发遗嘱，需要自己先发 `online=false`
- **回调线程**：HiveMQ 客户端的回调默认跑在内部 Netty 线程上，回调里做数据库写入会拖慢整个连接，所以用第三个参数传入独立的 Executor

### 3、订阅与发布

```java
    private CompletableFuture<Mqtt5SubAck> subscribe() {
        // 共享订阅：同组多个实例分摊消息，每条只投递给组内一个实例
        String filter = "$share/" + settings.sharedGroup() + "/devices/+/data";
        return client.subscribeWith()
                .topicFilter(filter)
                .qos(MqttQos.AT_LEAST_ONCE)
                .send();
    }

    public CompletableFuture<?> sendCommand(String deviceId, String json) {
        return client.publishWith()
                .topic("devices/" + deviceId + "/command")
                .qos(MqttQos.AT_LEAST_ONCE)
                .messageExpiryInterval(300)               // 设备 5 分钟内没上线，指令自动作废
                .payload(json.getBytes(StandardCharsets.UTF_8))
                .send();
    }

    @Override
    public void close() {
        client.disconnect().join();
        worker.close();
    }
}
```

- **共享订阅**：`$share/{组名}/{过滤器}` 是 MQTT 5 的标准语法，EMQX、HiveMQ、Mosquitto 2.x 都支持；平台服务横向扩容时靠它分摊消息，而不是让每个实例收全量再去重
- **消息过期**：控制类指令一定要设 `messageExpiryInterval`，否则设备离线一天后上线，会收到一串早已过时的开关指令
- 收到的 `Mqtt5Publish` 用 `getTopic().toString()` 取 Topic、`getPayloadAsBytes()` 取内容；回调里不要抛异常，失败的消息记录下来走补偿

### 4、双向 TLS

一机一密之外，设备或网关常用 X.509 证书做身份认证。HiveMQ 客户端接收标准的 `KeyManagerFactory` / `TrustManagerFactory`：

```java
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.TrustManagerFactory;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;

static Mqtt5AsyncClient mtlsClient(MqttSettings s, Path p12, char[] p12Pass, Path trustStore, char[] trustPass)
        throws Exception {
    KeyStore keyStore = KeyStore.getInstance("PKCS12");
    try (InputStream in = Files.newInputStream(p12)) {
        keyStore.load(in, p12Pass);                     // 客户端证书 + 私钥
    }
    KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    kmf.init(keyStore, p12Pass);

    KeyStore trust = KeyStore.getInstance("PKCS12");
    try (InputStream in = Files.newInputStream(trustStore)) {
        trust.load(in, trustPass);                      // 签发 Broker 证书的 CA
    }
    TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    tmf.init(trust);

    return Mqtt5Client.builder()
            .identifier(s.clientId())
            .serverHost(s.host())
            .serverPort(8883)
            .sslConfig()
                .keyManagerFactory(kmf)
                .trustManagerFactory(tmf)
                .applySslConfig()
            .buildAsync();
}
```

PEM 格式的证书和私钥先用 `openssl pkcs12 -export` 合成 PKCS12，比在代码里解析 PEM 简单可靠。证书链校验、mTLS 握手细节见 [HTTPS 与 TLS](/protocols/3_https_tls)，设备证书的签发与烧录见 [设备安全](./5_security)。

---

## 三、Spring Integration MQTT

### 1、消息流

![Spring Integration MQTT 消息流](../assets/iot/mqtt-spring-integration.svg)

入站：适配器订阅 `devices/+/data` 与 `devices/+/ota/status` 两个过滤器，消息进入路由器，按 `MqttHeaders.RECEIVED_TOPIC` 分发到遥测通道或 OTA 状态通道，每个通道只有一个处理器。出站：业务代码调用 `MqttGateway`，消息经出站通道交给 v5 出站 Handler 发布。两个方向共用一个 `ClientManager`，即一个 MQTT 连接。

### 2、依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-integration</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.integration</groupId>
    <artifactId>spring-integration-mqtt</artifactId>
    <!-- 版本由 Spring Boot 依赖管理提供 -->
</dependency>
<dependency>
    <!-- spring-integration-mqtt 把 Paho 声明为 optional，需要显式引入；Boot 不管理它的版本 -->
    <groupId>org.eclipse.paho</groupId>
    <artifactId>org.eclipse.paho.mqttv5.client</artifactId>
    <version>1.2.5</version>
</dependency>
```

### 3、连接配置与入站路由

```java
@ConfigurationProperties(prefix = "iot.mqtt")
public record MqttProperties(
        String serverUri,      // ssl://emqx.example.com:8883
        String clientId,       // 每个实例唯一，如 platform-${HOSTNAME}
        String username,
        String password,       // 来自环境变量或密钥管理，不写进代码仓库
        String sharedGroup) {} // 共享订阅组名，如 platform
```

```java
import org.eclipse.paho.mqttv5.client.IMqttAsyncClient;
import org.eclipse.paho.mqttv5.client.MqttConnectionOptions;
import org.springframework.integration.annotation.IntegrationComponentScan;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.dsl.IntegrationFlow;
import org.springframework.integration.mqtt.core.ClientManager;
import org.springframework.integration.mqtt.core.Mqttv5ClientManager;
import org.springframework.integration.mqtt.inbound.Mqttv5PahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.outbound.Mqttv5PahoMessageHandler;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;

@Configuration
@IntegrationComponentScan
@EnableConfigurationProperties(MqttProperties.class)
public class MqttIntegrationConfig {

    @Bean
    public ClientManager<IMqttAsyncClient, MqttConnectionOptions> mqttClientManager(MqttProperties props) {
        MqttConnectionOptions options = new MqttConnectionOptions();
        options.setServerURIs(new String[] {props.serverUri()});
        options.setUserName(props.username());
        options.setPassword(props.password().getBytes(StandardCharsets.UTF_8));
        options.setCleanStart(false);              // 持久会话
        options.setSessionExpiryInterval(3600L);
        options.setAutomaticReconnect(true);       // 由客户端负责重连
        options.setMaxReconnectDelay(60_000);
        return new Mqttv5ClientManager(options, props.clientId());
    }

    @Bean
    public IntegrationFlow mqttInboundFlow(ClientManager<IMqttAsyncClient, MqttConnectionOptions> clientManager,
                                           MqttProperties props) {
        String share = "$share/" + props.sharedGroup() + "/";
        var adapter = new Mqttv5PahoMessageDrivenChannelAdapter(clientManager,
                share + "devices/+/data",
                share + "devices/+/ota/status");   // 两个过滤器都要订阅，否则 OTA 状态永远收不到
        adapter.setQos(1, 1);
        return IntegrationFlow.from(adapter)
                .route(Message.class, MqttIntegrationConfig::routeByTopic)
                .get();
    }

    static String routeByTopic(Message<?> message) {
        String topic = message.getHeaders().get(MqttHeaders.RECEIVED_TOPIC, String.class);
        return topic != null && topic.endsWith("/ota/status") ? "otaStatusChannel" : "telemetryChannel";
    }

    @Bean
    public MessageChannel telemetryChannel() {
        return new DirectChannel();
    }

    @Bean
    public MessageChannel otaStatusChannel() {
        return new DirectChannel();
    }

    @Bean
    public IntegrationFlow mqttOutboundFlow(ClientManager<IMqttAsyncClient, MqttConnectionOptions> clientManager) {
        var handler = new Mqttv5PahoMessageHandler(clientManager);
        handler.setAsync(true);
        handler.setDefaultQos(1);
        return IntegrationFlow.from("mqttOutboundChannel").handle(handler).get();
    }
}
```

为什么要显式路由：`DirectChannel` 有多个订阅者时按轮询分发，**每条消息只会交给其中一个处理器**。如果遥测处理器和 OTA 处理器都挂在同一个 `DirectChannel` 上，各自只能收到大约一半消息，且无法通过在方法里判断 Topic 补救。正确做法是一条通道只挂一个处理器，按 Topic 路由；确实需要多个处理器都收到同一条消息时，用 `PublishSubscribeChannel`。

### 4、出站网关

```java
import org.springframework.integration.annotation.MessagingGateway;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.handler.annotation.Header;

@MessagingGateway(defaultRequestChannel = "mqttOutboundChannel")
public interface MqttGateway {

    void publish(@Header(MqttHeaders.TOPIC) String topic,
                 @Header(MqttHeaders.QOS) int qos,
                 String payload);
}
```

v5 出站 Handler 对 `byte[]` 原样发布，对 `String` 先转成字节，其他类型交给配置的 `MessageConverter`。业务代码注入 `MqttGateway` 即可下发指令，不需要接触 Paho 的 API。

### 5、处理器

```java
@Component
public class TelemetryHandler {

    private final KafkaTemplate<String, String> kafka;

    public TelemetryHandler(KafkaTemplate<String, String> kafka) {
        this.kafka = kafka;
    }

    @ServiceActivator(inputChannel = "telemetryChannel")
    public void handle(@Header(MqttHeaders.RECEIVED_TOPIC) String topic, byte[] payload) {
        String deviceId = topic.split("/")[1];   // devices/{deviceId}/data
        // 只做轻量转发，按 deviceId 分区保证同一设备有序
        kafka.send("iot.telemetry", deviceId, new String(payload, StandardCharsets.UTF_8));
    }
}
```

- 入站适配器的消息在 Paho 回调线程上处理，回调返回后客户端才确认 QoS 1 消息；处理慢会让 Broker 侧积压，所以这里只转发到 Kafka，入库、规则计算放到下游消费者
- 对丢消息零容忍时，可以开启 `adapter.setManualAcks(true)`，在处理成功后通过消息头里的确认回调手动 ack
- OTA 状态通道的处理器见 [OTA 升级](./10_ota)；Kafka 之后的流处理与入库见 [数据处理](./4_data)

---

## 四、工程要点

EMQX 的部署与授权模式见 [平台选型](./2_platform)。

### 1、clientId 与会话

| 问题 | 现象 | 做法 |
|------|------|------|
| 多实例共用一个 clientId | 两个实例互相踢下线，日志里不断重连 | clientId 拼上主机名或 Pod 名，保证全局唯一 |
| 每次启动随机 clientId | 持久会话失效，Broker 上残留大量过期会话 | 同一实例重启后保持同一个 clientId |
| 横向扩容后消息被重复处理 | 每个实例都订阅了全量 Topic | 改用 `$share/{组名}/...` 共享订阅 |
| 断线期间消息丢失 | `cleanStart=true` 或会话过期时间太短 | `cleanStart=false`，会话过期时间覆盖最长的预期断线时长 |

### 2、QoS 与幂等

- 遥测数据量大、可容忍偶发丢失，用 QoS 0 或 1；指令、OTA 状态这类必须送达的消息用 QoS 1
- QoS 1 是"至少一次"，网络抖动时会重复投递；消费端按业务 ID（设备 ID + 序号或时间戳）去重，比使用 QoS 2 代价更低。去重方案见 [幂等设计](/architecture/5_idempotence)
- MQTT 只保证同一 Topic、同一会话内的顺序；共享订阅把消息分到多个实例后，跨实例的顺序需要在 Kafka 分区或业务版本号上保证

### 3、连接规模

单个平台服务通常只维护少量 MQTT 连接，海量设备连接由 Broker 承担。如果需要用 Java 直接承载设备长连接（私有 TCP 协议），见 [Netty 接入网关](./9_netty_gateway)。

---

## 小结

- 独立客户端优先 HiveMQ MQTT Client（MQTT 5、持续维护）；Paho 最后一个正式版停在 2020 年的 1.2.5，只在 Spring Integration 中作为底层依赖使用
- MQTT 5 的 `cleanStart=false` + `sessionExpiryInterval` 实现持久会话；clientId 必须固定且唯一，控制指令要设消息过期时间
- 平台服务横向扩容用 `$share` 共享订阅，QoS 1 的重复投递靠业务 ID 去重
- Spring Integration 用 v5 适配器，入站订阅所有需要的过滤器，再按 `RECEIVED_TOPIC` 路由，一条 `DirectChannel` 只挂一个处理器
- 回调线程里只做轻量转发，凭据来自外部配置，生产环境走 8883 TLS 端口

## 参考资料

- HiveMQ MQTT Client：[https://github.com/hivemq/hivemq-mqtt-client](https://github.com/hivemq/hivemq-mqtt-client)
- HiveMQ MQTT Client 文档：[https://hivemq.github.io/hivemq-mqtt-client/](https://hivemq.github.io/hivemq-mqtt-client/)
- Eclipse Paho Java：[https://github.com/eclipse-paho/paho.mqtt.java](https://github.com/eclipse-paho/paho.mqtt.java)
- Spring Integration MQTT Support：[https://docs.spring.io/spring-integration/reference/mqtt.html](https://docs.spring.io/spring-integration/reference/mqtt.html)
- MQTT Version 5.0（OASIS）：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)

> 下一篇：[Modbus 采集](./7_modbus)

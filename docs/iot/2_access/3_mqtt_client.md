---
description: HiveMQ 客户端、持久会话与重连、共享订阅、Spring Integration MQTT v5、Topic 路由
---

# MQTT 客户端

> 前置阅读：[通信协议](../1_basics/1_protocol)

Java 服务接入 MQTT 5 有独立客户端和 Spring 集成两种方式。本篇讲 HiveMQ 客户端、Spring Integration MQTT、持久会话与重连、共享订阅，基线为 JDK 21、Spring Boot 4。

---

## 一、客户端选型

独立进程（网关、采集器、压测工具）用 HiveMQ MQTT Client，Spring Boot 业务服务用 Spring Integration MQTT。库的版本：HiveMQ MQTT Client 1.4.2、Paho mqttv5 1.2.5、Spring Integration 7.0.2 及以上（原因见第三节）。

本篇的范围是 **Java 写的服务端与网关侧客户端**：平台服务、边缘网关、采集器。设备固件侧（MCU、RTOS）不在这里，那一侧用各平台提供的 C SDK 或 Eclipse Paho 的嵌入式 C 客户端，但会话、QoS、重连这些取舍是相通的。

### 1、三个可选项

| 选项 | 协议版本 | 现状 | 适合场景 |
|------|---------|------|---------|
| HiveMQ MQTT Client | MQTT 5 / 3.1.1 | 持续发版，1.4.2 发布于 2026 年 11 月；提供 Async、Reactive（RxJava）、Blocking 三套 API | 网关、采集器、压测工具等独立进程 |
| Eclipse Paho Java（mqttv3 / mqttv5） | 3.1.1 / 5 | 最后一个正式版是 2020 年 7 月的 1.2.5，此后没有新版本 | 存量项目；Spring Integration 的底层依赖 |
| Spring Integration MQTT | 3.1.1 / 5 | 随 Spring Integration 发版，适配器底层仍是 Paho | Spring Boot 业务服务，需要与通道、路由、网关组合 |

**结论**：新写的独立客户端用 HiveMQ MQTT Client；Spring Boot 服务用 Spring Integration 的 **v5 适配器**（`Mqttv5PahoMessageDrivenChannelAdapter` / `Mqttv5PahoMessageHandler`），接受它依赖 Paho 的现实，把 MQTT 收发封装在一个配置类里，将来替换客户端时影响面最小。

### 2、不再推荐的写法

- `org.eclipse.paho.client.mqttv3` 只支持 MQTT 3.1.1，拿不到会话过期、消息过期、共享订阅标准语法、原因码等 MQTT 5 能力
- 用 `System.currentTimeMillis()` 拼随机 clientId 并设 `cleanSession=true`：每次重连都是新会话，断线期间的 QoS 1 消息全部丢失
- 把用户名、密码写在配置类里：凭据应来自环境变量或密钥管理系统，设备侧推荐一机一密或 X.509 证书，见 [设备安全](./1_security)

---

## 二、HiveMQ MQTT Client

下面以一个网关进程为例：它用自己的设备 ID 连接 Broker，在 `gateways/{gatewayId}/` 前缀下替下挂的子设备声明上下线、上报遥测，并接收平台转给子设备的指令。这组 Topic 与载荷的约定见 [网关与子设备](./5_gateway_subdevice)。

### 1、依赖

```xml
<dependency>
    <groupId>com.hivemq</groupId>
    <artifactId>hivemq-mqtt-client</artifactId>
    <version>1.4.2</version>
</dependency>
```

### 2、建连：TLS、自动重连、持久会话、遗嘱

```java
import com.hivemq.client.mqtt.MqttGlobalPublishFilter;
import com.hivemq.client.mqtt.datatypes.MqttQos;
import com.hivemq.client.mqtt.mqtt5.Mqtt5AsyncClient;
import com.hivemq.client.mqtt.mqtt5.Mqtt5Client;
import com.hivemq.client.mqtt.mqtt5.message.publish.Mqtt5Publish;
import com.hivemq.client.mqtt.mqtt5.message.publish.Mqtt5PublishResult;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public record MqttSettings(String host, int port, String gatewayId,
                           String username, String password) {}

public final class GatewayMqttClient implements AutoCloseable {

    private final MqttSettings settings;
    private final String prefix;                          // gateways/{gatewayId}/，ACL 只放行这个前缀
    private final Runnable onOnline;                      // 每次连上之后要重做的事：重新逐台声明子设备
    private final Mqtt5AsyncClient client;
    // 业务处理放到虚拟线程，不占用客户端的 Netty IO 线程
    private final ExecutorService worker = Executors.newVirtualThreadPerTaskExecutor();

    public GatewayMqttClient(MqttSettings settings, Runnable onOnline) {
        this.settings = settings;
        this.prefix = "gateways/" + settings.gatewayId() + "/";
        this.onOnline = onOnline;
        this.client = Mqtt5Client.builder()
                .identifier(settings.gatewayId())         // 网关自己的设备 ID，固定且全局唯一，重连后才能接上原会话
                .serverHost(settings.host())
                .serverPort(settings.port())              // TLS 端口 8883
                .sslWithDefaultConfig()                   // 用 JDK 默认信任库校验服务端证书
                .automaticReconnect()
                    .initialDelay(1, TimeUnit.SECONDS)
                    .maxDelay(60, TimeUnit.SECONDS)       // 指数退避的上限；错开重连靠的是客户端自带的随机抖动
                    .applyAutomaticReconnect()
                // 首次连接和每次自动重连成功都会回调：掉线时遗嘱已经把保留的状态改成离线，要重新报在线
                .addConnectedListener(context -> worker.execute(this::announceOnline))
                .buildAsync();
    }

    public CompletableFuture<Void> start(Consumer<Mqtt5Publish> cmdHandler) {
        // 先注册全局回调再连接：持久会话里积压的指令在 CONNACK 之后立刻到达，晚注册会漏掉
        client.publishes(MqttGlobalPublishFilter.ALL, cmdHandler, worker);

        return client.connectWith()
                .cleanStart(false)                        // 复用 Broker 上的会话
                .sessionExpiryInterval(3600)              // 断线后会话保留 1 小时
                .keepAlive(60)
                .simpleAuth()
                    .username(settings.username())
                    .password(settings.password().getBytes(StandardCharsets.UTF_8))
                    .applySimpleAuth()
                .willPublish()
                    .topic(prefix + "status")
                    .qos(MqttQos.AT_LEAST_ONCE)
                    .payload("{\"online\":false}".getBytes(StandardCharsets.UTF_8))
                    .retain(true)
                    .applyWillPublish()
                .send()
                // 只订阅发给自己名下子设备的指令；网关不用共享订阅
                .thenCompose(connAck -> client.subscribeWith()
                        .topicFilter(prefix + "cmd")
                        .qos(MqttQos.AT_LEAST_ONCE)
                        .send())
                .thenAccept(subAck -> { });
    }

    private void announceOnline() {
        publish("status", "{\"online\":true}", true).thenRun(onOnline);
    }

    // publish()、close() 见下一小节
```

几个参数的取舍：

- **`cleanStart(false)` + `sessionExpiryInterval`**：MQTT 5 把 3.1.1 的 `cleanSession` 拆成两个参数，前者决定是否接续旧会话，后者决定断线后 Broker 保留会话多久；两者配合才能做到"短暂断线不丢 QoS 1 消息"，前提是离线期间的消息没有超出 Broker 的会话队列上限、Broker 自身没有重启，见 [可靠上报与接入层主备 · EMQX 会话怎么选](../4_practice/3_reliable_uplink#五、emqx-会话怎么选)
- **遗嘱 + retain**：网关异常掉线时 Broker 代发 `online=false`，新订阅者也能立刻读到最新在线状态；连接成功后要主动发一条保留的 `online=true` 覆盖旧状态，而且自动重连成功后也要再发一次，所以放在连接成功的监听器里，不放在 `start()` 里。平台在网关离线时会把它名下的子设备一起置为离线，网关连回来后要重新逐台声明，`onOnline` 就是留给这件事的；正常断开时 Broker 不发遗嘱，需要自己先发 `online=false`；在线状态的其他做法见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)
- **自动重连的退避**：每次重连的等待时间是 `min(initialDelay × 2^已重试次数, maxDelay)`，再上下浮动最多 25%（上限设 60 秒时实际最长约 75 秒）。`maxDelay` 只决定最长等多久；一批客户端同时掉线后不在同一时刻连回来，靠的是这个浮动，没有它，指数退避只是让所有客户端整齐地一起等、一起重连。设备规模上去之后退避与抖动怎么定、服务端怎么限流，见 [海量连接与连接风暴](./7_connection_storm)
- **回调线程**：HiveMQ 客户端的回调默认跑在内部 Netty 线程上，回调里做数据库写入会拖慢整个连接，所以用第三个参数传入独立的 Executor。要做到「处理成功才确认」，用多一个 `manualAcknowledgement` 参数的重载 `publishes(filter, callback, executor, true)`，处理完再调 `publish.acknowledge()`，完整的顺序见 [可靠上报与接入层主备 · 写入总线成功后才确认](../4_practice/3_reliable_uplink#四、transport-写入总线成功后才确认)

### 3、发布与关闭

```java
    /** 发到 gateways/{gatewayId}/{suffix}：suffix 取 connect、disconnect、telemetry、response */
    public CompletableFuture<Mqtt5PublishResult> publish(String suffix, String json) {
        return publish(suffix, json, false);
    }

    private CompletableFuture<Mqtt5PublishResult> publish(String suffix, String json, boolean retain) {
        return client.publishWith()
                .topic(prefix + suffix)
                .qos(MqttQos.AT_LEAST_ONCE)
                .retain(retain)
                .payload(json.getBytes(StandardCharsets.UTF_8))
                .send();
    }

    @Override
    public void close() {
        // 正常断开时 Broker 不发遗嘱，先把保留的状态改成离线再断开
        publish("status", "{\"online\":false}", true)
                .thenCompose(result -> client.disconnect())
                .join();
        worker.close();
    }
}
```

- 网关只在自己的前缀下收发：发布 `status`、`connect`、`disconnect`、`telemetry`、`response`，订阅 `cmd`。写别的 Topic 会被 ACL 拒绝，规则见 [设备安全 · 网关与采集器](./1_security#_5、网关与采集器-一条连接代多台设备)
- 收到的 `Mqtt5Publish` 用 `getTopic().toString()` 取 Topic、`getPayloadAsBytes()` 取内容；回调里不要抛异常，失败的消息记录下来走补偿
- `send()` 返回的 Future 完成只表示 Broker 收下了这条 PUBLISH

平台服务这一侧要做的是另外两件事：订阅全部设备的上报、给设备下发指令。它用自己的 clientId 连接，不登记网关的遗嘱；Spring Boot 服务一般用下一节的 Spring Integration，独立进程可以用同一个 HiveMQ 客户端：

```java
import com.hivemq.client.mqtt.mqtt5.message.subscribe.suback.Mqtt5SubAck;

    // platform：平台服务自己的连接，clientId 是稳定的实例编号

    static CompletableFuture<Mqtt5SubAck> subscribeTelemetry(Mqtt5AsyncClient platform, String sharedGroup) {
        // 共享订阅：同组多个实例分摊消息，每条只投递给组内一个实例
        return platform.subscribeWith()
                .topicFilter("$share/" + sharedGroup + "/devices/+/telemetry")
                .qos(MqttQos.AT_LEAST_ONCE)
                .send();
    }

    /** json 形如 {"id":"req-42","method":"reboot","params":{}}，requestId 与其中的 id 相同 */
    static CompletableFuture<Mqtt5PublishResult> sendCommand(Mqtt5AsyncClient platform,
                                                            String deviceId, String requestId, String json) {
        return platform.publishWith()
                .topic("devices/" + deviceId + "/cmd")
                .qos(MqttQos.AT_LEAST_ONCE)
                .messageExpiryInterval(300)               // 设备 5 分钟内没上线，指令自动作废
                .responseTopic("devices/" + deviceId + "/response")            // MQTT 5：告诉设备应答发到哪里
                .correlationData(requestId.getBytes(StandardCharsets.UTF_8))   // 设备在应答里原样带回，用来配对
                .payload(json.getBytes(StandardCharsets.UTF_8))
                .send();
    }
```

- **共享订阅**：`$share/{组名}/{过滤器}` 是 MQTT 5 的标准语法，EMQX、HiveMQ、Mosquitto 2.x 都支持；平台服务横向扩容时靠它分摊消息，而不是让每个实例收全量再去重
- **消息过期**：控制类指令一定要设 `messageExpiryInterval`，否则设备离线一天后上线，会收到一串早已过时的开关指令
- **指令与应答**：指令发到 `devices/{deviceId}/cmd`，载荷 `{"id":"请求 ID","method":"…","params":{…}}`；设备把结果发到 `devices/{deviceId}/response`，载荷 `{"id":"同一个请求 ID","code":200,"data":{…}}`。MQTT 5 下同时带上 Response Topic 与 Correlation Data 两个属性，3.1.1 的设备只能靠载荷里的 `id` 配对。Broker 收下指令不表示设备执行了；等应答、超时、设备离线时怎么办，见 [指令下发与服务调用](../3_platform/4_command)

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
            .identifier(s.gatewayId())
            .serverHost(s.host())
            .serverPort(s.port())
            .sslConfig()
                .keyManagerFactory(kmf)
                .trustManagerFactory(tmf)
                .applySslConfig()
            .buildAsync();
}
```

PEM 格式的证书和私钥先用 `openssl pkcs12 -export` 合成 PKCS12，比在代码里解析 PEM 简单可靠。证书链校验、mTLS 握手细节见 [HTTPS 与 TLS](/protocols/3_https_tls)，设备证书的签发与烧录见 [设备安全](./1_security)。

---

## 三、Spring Integration MQTT

### 1、消息流

![Spring Integration MQTT 消息流](../../assets/iot/mqtt-spring-integration.svg)

入站：适配器订阅 `devices/+/telemetry` 与 `devices/+/ota/status` 两个过滤器，消息进入路由器，按 `MqttHeaders.RECEIVED_TOPIC` 分发到遥测通道或 OTA 状态通道，每个通道只有一个处理器。出站：业务代码调用 `MqttGateway`，消息经出站通道交给 v5 出站 Handler 发布。两个方向共用一个 `ClientManager`，即一个 MQTT 连接。

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
        String clientId,       // 每个实例唯一、重启后不变，如 platform-0（StatefulSet 的序号）
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

    private static final Logger log = LoggerFactory.getLogger(MqttIntegrationConfig.class);

    @Bean
    public ClientManager<IMqttAsyncClient, MqttConnectionOptions> mqttClientManager(MqttProperties props) {
        MqttConnectionOptions options = new MqttConnectionOptions();
        options.setServerURIs(new String[] {props.serverUri()});
        options.setUserName(props.username());
        options.setPassword(props.password().getBytes(StandardCharsets.UTF_8));
        options.setCleanStart(false);              // 持久会话
        options.setSessionExpiryInterval(3600L);
        options.setAutomaticReconnect(true);       // 由 Paho 负责重连：间隔从 1 秒起每次翻倍，没有随机抖动
        options.setMaxReconnectDelay(60_000);      // 毫秒；间隔小于它时才翻倍，所以实际会停在 64 秒
        return new Mqttv5ClientManager(options, props.clientId());
    }

    @Bean
    public IntegrationFlow mqttInboundFlow(ClientManager<IMqttAsyncClient, MqttConnectionOptions> clientManager,
                                           MqttProperties props) {
        String share = "$share/" + props.sharedGroup() + "/";
        var adapter = new Mqttv5PahoMessageDrivenChannelAdapter(clientManager,
                share + "devices/+/telemetry",
                share + "devices/+/ota/status");   // 两个过滤器都要订阅，否则 OTA 状态永远收不到
        adapter.setQos(1, 1);
        // 处理器抛出的异常送到错误通道；不设的话异常会一路抛回 Paho 的回调线程
        adapter.setErrorChannelName("mqttErrorChannel");
        return IntegrationFlow.from(adapter)
                .route(Message.class, MqttIntegrationConfig::routeByTopic)
                .get();
    }

    static String routeByTopic(Message<?> message) {
        String topic = message.getHeaders().get(MqttHeaders.RECEIVED_TOPIC, String.class);
        if (topic != null && topic.startsWith("devices/") && topic.endsWith("/ota/status")) {
            return "otaStatusChannel";
        }
        if (topic != null && topic.startsWith("devices/") && topic.endsWith("/telemetry")) {
            return "telemetryChannel";
        }
        // 其他篇加订阅（指令应答、网关遥测）时在这里加分支；没有分支的 Topic 丢弃，nullChannel 是内置的丢弃通道
        return "nullChannel";
    }

    @Bean
    public IntegrationFlow mqttErrorFlow() {
        return IntegrationFlow.from("mqttErrorChannel")
                .handle(message -> log.warn("MQTT 消息处理失败: {}", message.getPayload()))
                .get();
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

连接配置里有两处要知道底细：

- **Paho v5 的自动重连没有抖动**：Paho 1.2.5 的重连间隔从 1 秒开始，每失败一次就在「当前间隔小于 `maxReconnectDelay`」时翻倍，不加随机量；上限设 60 秒时序列是 1、2、4、8、16、32、64 秒，最后停在 64 秒而不是 60 秒。这个间隔还是 `MqttAsyncClient` 的一个静态字段，同一个 JVM 里的多个 Paho v5 客户端共用。平台服务只有几条连接，这样用没有问题；但它不能当设备侧或大批量客户端的重连范例，那种场景要自己加抖动，或用上一节的 HiveMQ 客户端，见 [海量连接与连接风暴](./7_connection_storm)
- **`$share` 共享订阅有版本前提**：Paho v5 收到消息后拿订阅时的过滤器和消息 Topic 做字面比较，不会去掉 `$share/{组名}/` 前缀，结果是消息到了客户端却被 Paho 自己丢掉。Spring Integration 先在 [#8879](https://github.com/spring-projects/spring-integration/issues/8879) 里用订阅标识符绕开了这个缺陷（6.3.0，并回补到 6.2.2、6.1.6），但像本例这样经 `ClientManager` 共用连接、只订阅共享过滤器时仍然收不到消息，直到 [#10682](https://github.com/spring-projects/spring-integration/issues/10682) 才修好，修复版本是 7.0.2（6.5 线为 6.5.6）。所以本节写法要求 Spring Integration 7.0.2 及以上，升级前先确认 Spring Boot 带的版本；排查时若发现「同时订阅普通过滤器才收得到」，就是撞上了这个问题

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

    private final KafkaTemplate<String, TelemetryMessage> kafka;
    private final JsonMapper json;

    public TelemetryHandler(KafkaTemplate<String, TelemetryMessage> kafka, JsonMapper json) {
        this.kafka = kafka;
        this.json = json;
    }

    /** 设备载荷：{"ts": 1767225600000, "values": {"temperature": 25.3, "humidity": 60.1}}，ts 可省略 */
    public record DeviceTelemetry(Long ts, Map<String, Object> values) {}

    @ServiceActivator(inputChannel = "telemetryChannel")
    public void handle(@Header(MqttHeaders.RECEIVED_TOPIC) String topic, byte[] payload) {
        String deviceId = topic.split("/")[1];   // devices/{deviceId}/telemetry，已由 ACL 绑定到 clientid
        DeviceTelemetry t = json.readValue(payload, DeviceTelemetry.class);
        if (t.values() == null || t.values().isEmpty()) {
            throw new IllegalArgumentException("遥测载荷缺少 values: " + topic);
        }
        long ts = t.ts() != null ? t.ts() : System.currentTimeMillis();   // 设备没带时间就用接收时间
        // values 原样成为统一消息的 metrics，按 deviceId 分区保证同一设备有序
        kafka.send("iot.telemetry", deviceId, new TelemetryMessage(deviceId, "mqtt", ts, t.values()));
    }
}
```

- 这一步做的是「设备协议 → 内部信封」的转换：设备载荷是 `{"ts", "values"}`，`TelemetryMessage`（设备 ID、接入方式、毫秒时间戳、测点）是 Broker 之后才出现的内部消息，`values` 对应它的 `metrics`；两者的约定见 [遥测数据链路 · Topic 与消息约定](../3_platform/2_data#_1、topic-与消息约定)，这里转出来的消息与 EMQX 规则引擎转发的形状相同，下游不用区分来源。载荷不是合法 JSON 或缺少 `values` 时抛异常，消息进入配置类里设的 `mqttErrorChannel`，记录后丢弃或转死信。入站适配器一定要设错误通道：没有的话异常会抛回 Paho 的回调线程，这条消息不会被确认
- 网关与采集器代子设备上报的 `gateways/+/telemetry` 是另一种载荷（按子设备分组的数组），要另订阅、另挂一个处理器，拆成每台子设备一条 `TelemetryMessage` 之前先核对子设备归属，见 [网关与子设备](./5_gateway_subdevice)
- 入站适配器的消息在 Paho 回调线程上处理，回调返回后客户端才确认 QoS 1 消息；处理慢会让 Broker 侧积压，所以这里只转发到 Kafka，入库、规则计算放到下游消费者
- 对丢消息零容忍时改成手动确认：像本例这样经 `ClientManager` 共用连接时，开关要设在 `Mqttv5ClientManager` 上（`setManualAcks(true)`），设在适配器上不起作用；处理成功后用 `StaticMessageHeaderAccessor.getAcknowledgmentCallback(message).acknowledge()` 确认；「写入下游成功才确认」的完整顺序与失败时的处理见 [可靠上报与接入层主备 · 写入总线成功后才确认](../4_practice/3_reliable_uplink#四、transport-写入总线成功后才确认)
- OTA 状态通道的处理器见 [OTA 升级](../3_platform/5_ota)；Kafka 之后的流处理与入库见 [遥测数据链路](../3_platform/2_data)

---

## 四、工程要点

### 1、clientId 与会话

| 问题 | 现象 | 做法 |
|------|------|------|
| 多实例共用一个 clientId | 两个实例互相踢下线，日志里不断重连 | clientId 拼上稳定的实例编号（如 StatefulSet 的序号），保证全局唯一 |
| 每次启动随机 clientId（用每次发布都会变的 Pod 名也算） | 接不上原会话；每次启动都留下一个没人认领的旧会话，过期前它还挂着共享订阅、继续分走一部分消息 | 同一实例重启后保持同一个 clientId |
| 横向扩容后消息被重复处理 | 每个实例都订阅了全量 Topic | 改用 `$share/{组名}/...` 共享订阅 |
| 断线期间消息丢失 | `cleanStart=true` 或会话过期时间太短 | `cleanStart=false`，会话过期时间覆盖最长的预期断线时长 |

「每个实例唯一的 clientId + 共享订阅 + 持久会话 + 自动重连」这套模型有两条边界，[可靠上报与接入层主备](../4_practice/3_reliable_uplink) 在 EMQX 上实测过：

- **成员离线时消息不改派**：共享订阅组里某个实例离线但会话还在时，分给它的消息排进它的会话等它回来，不会转给其他实例；实例长时间不回来（如缩容后没清会话），这部分流量就一直滞留，见 [主实例的多条连接与共享订阅](../4_practice/3_reliable_uplink#七、主实例的多条连接与共享订阅)
- **主备不能开自动重连**：想让同一时刻只有一个实例消费、其余待命时，各实例共用同一组 clientId，下台的旧主自动连回来会把新主踢掉，两边互踢；断线后要先确认自己仍是主再重连，见 [单活多备：Redis 锁选主](../4_practice/3_reliable_uplink#六、单活多备-redis-锁选主)

### 2、QoS 与幂等

- 遥测默认用 QoS 1；采样很密、丢几个点不影响结论的测点可以降到 QoS 0，换来更低的 Broker 与设备开销。指令、OTA 状态这类必须送达的消息用 QoS 1
- QoS 1 是"至少一次"，网络抖动时会重复投递；消费端按业务 ID（设备 ID + 序号或时间戳）去重，比使用 QoS 2 代价更低。去重方案见 [幂等设计](/architecture/3_idempotence)
- MQTT 只保证同一客户端、同一 Topic、同一 QoS 等级内的顺序（同一个 Topic 混用 QoS 0 和 QoS 1 时，两种之间不保序）；共享订阅把消息分到多个实例后，跨实例的顺序需要在 Kafka 分区或业务版本号上保证

### 3、连接规模

单个平台服务通常只维护少量 MQTT 连接，海量设备连接由 Broker 承担，Broker 的选择、单节点与集群的部署见 [EMQX 许可与部署](../1_basics/3_emqx_deploy)。如果需要用 Java 直接承载设备长连接（私有 TCP 协议），见 [Netty 接入网关](./6_netty_gateway)。

---

## 小结

- 独立客户端优先 HiveMQ MQTT Client（MQTT 5、持续维护，自动重连自带随机抖动）；Paho 最后一个正式版停在 2020 年的 1.2.5，重连没有抖动，只在 Spring Integration 中作为底层依赖使用
- MQTT 5 的 `cleanStart=false` + `sessionExpiryInterval` 实现持久会话；clientId 必须固定且唯一，在线状态要在每次连上之后重新发布，控制指令要设消息过期时间，并带上 Response Topic 与 Correlation Data
- 平台服务横向扩容用 `$share` 共享订阅（经 `ClientManager` 使用时 Spring Integration 要 7.0.2 及以上），QoS 1 的重复投递靠业务 ID 去重
- Spring Integration 用 v5 适配器，入站订阅所有需要的过滤器，再按 `RECEIVED_TOPIC` 路由，一条 `DirectChannel` 只挂一个处理器
- 回调线程里只做轻量转发，把设备载荷 `{"ts", "values"}` 转成内部的 `TelemetryMessage`；入站适配器要设错误通道，手动确认的开关在 `ClientManager` 上；凭据来自外部配置，生产环境走 8883 TLS 端口

## 参考资料

- HiveMQ MQTT Client：[https://github.com/hivemq/hivemq-mqtt-client](https://github.com/hivemq/hivemq-mqtt-client)
- HiveMQ MQTT Client 文档：[https://hivemq.github.io/hivemq-mqtt-client/](https://hivemq.github.io/hivemq-mqtt-client/)
- HiveMQ MQTT Client 自动重连实现（退避与抖动）：[https://github.com/hivemq/hivemq-mqtt-client/blob/v1.4.2/src/main/java/com/hivemq/client/internal/mqtt/lifecycle/MqttClientAutoReconnectImpl.java](https://github.com/hivemq/hivemq-mqtt-client/blob/v1.4.2/src/main/java/com/hivemq/client/internal/mqtt/lifecycle/MqttClientAutoReconnectImpl.java)
- Eclipse Paho Java：[https://github.com/eclipse-paho/paho.mqtt.java](https://github.com/eclipse-paho/paho.mqtt.java)
- Paho mqttv5 自动重连实现：[https://github.com/eclipse-paho/paho.mqtt.java/blob/v1.2.5/org.eclipse.paho.mqttv5.client/src/main/java/org/eclipse/paho/mqttv5/client/MqttAsyncClient.java](https://github.com/eclipse-paho/paho.mqtt.java/blob/v1.2.5/org.eclipse.paho.mqttv5.client/src/main/java/org/eclipse/paho/mqttv5/client/MqttAsyncClient.java)
- Eclipse Paho 嵌入式 C 客户端：[https://github.com/eclipse-paho/paho.mqtt.embedded-c](https://github.com/eclipse-paho/paho.mqtt.embedded-c)
- Spring Integration 共享订阅问题 #8879：[https://github.com/spring-projects/spring-integration/issues/8879](https://github.com/spring-projects/spring-integration/issues/8879)
- Spring Integration 共享订阅问题 #10682：[https://github.com/spring-projects/spring-integration/issues/10682](https://github.com/spring-projects/spring-integration/issues/10682)
- Spring Integration MQTT Support：[https://docs.spring.io/spring-integration/reference/mqtt.html](https://docs.spring.io/spring-integration/reference/mqtt.html)
- MQTT Version 5.0（OASIS）：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)

> 下一篇：[Modbus 采集](./4_modbus)

---
description: 同步 / 异步 / 离线缓存三档、主流平台对照、请求与应答配对、命令状态机、幂等与超时、多实例应答回传
---

# 指令下发与服务调用

> 前置阅读：[MQTT 客户端](../2_access/3_mqtt_client)、[物模型](./1_thing_model)、[设备影子](./3_device_shadow)

指令下发解决「让设备现在做一件事，并知道做成了没有」，物模型里的服务调用就走这条通道。本篇讲主流平台的做法、请求与应答怎么配对、命令状态机、幂等与超时，以及一份最小实现，基线为 JDK 21、Spring Boot 4、Redis 8。

---

## 一、指令与期望状态

### 1、两类下行

平台向设备下行有两种意图：

- **设置期望状态**：上报周期改成 30 秒、灯调到 80% 亮度。关心的是最终结果，设备离线也要记住，上线后拿到最新值即可，中间改过几次无所谓
- **执行一个动作**：重启、拍照、开门、抄一次表。每一次都要执行且只执行一次，过了时效就不该再做，调用方还要知道结果

前者走 [设备影子](./3_device_shadow) 的 `desired`，后者走本篇的指令通道。Azure IoT Hub 的官方选型指南就是这样划分的：要立即确认结果的命令（如打开风扇）用直接方法，让设备进入某个状态的长时命令（如把遥测间隔设为 30 分钟）用孪生的 desired 属性，单向通知用云到设备消息。

### 2、属性设置、服务调用、消息透传

| | 属性设置 | 服务调用 | 消息透传 |
|--|--|--|--|
| 物模型 | 读写属性 | 服务（入参、出参） | 不经过物模型 |
| 通道 | 设备影子 `desired` → `delta` | `devices/{deviceId}/cmd` 与 `…/response` | 自定义 Topic，载荷平台不解析 |
| 设备离线 | 保留期望值，上线后对齐 | 立即失败，或缓存到上线、带过期时间 | 取决于 QoS 与会话 |
| 结果 | `delta` 清空即生效 | 每次调用一个状态与结果 | 平台不知道 |
| 典型 | 上报周期、阈值、开关 | 重启、拍照、校时 | 私有协议、旧固件兼容 |
| 主流对应 | 阿里云属性设置、Azure 可写属性、ThingsBoard 共享属性 | 阿里云服务、Azure 直接方法、AWS Commands、ThingsBoard RPC | 阿里云自定义 Topic、Azure 云到设备消息 |

---

## 二、主流平台怎么做

### 1、对照表

| 平台 | 能力 | 下行 / 应答 Topic | 请求 ID 在哪 | 超时与限额 | 设备离线时 |
|------|------|------------------|-------------|-----------|-----------|
| 阿里云 | 服务调用（异步） | `/sys/{productKey}/{deviceName}/thing/service/{服务标识}`，应答 `…_reply` | 载荷 `id` | — | — |
| 阿里云 | RRPC（同步，服务的同步调用也走它） | `/sys/${productKey}/${deviceName}/rrpc/request/${messageId}`，应答 `…/rrpc/response/${messageId}` | Topic 里的 `messageId` | 设备须在 8 秒内应答；RRpc 接口的 `Timeout` 为 1000～8000 ms | 返回 `OFFLINE` |
| Azure IoT Hub | 直接方法 | `$iothub/methods/POST/{method}/?$rid={request id}`，应答 `$iothub/methods/res/{status}/?$rid={request id}` | Topic 里的 `$rid` | 响应超时 5～300 秒（默认 30），请求与响应各 128 KB；请求以 QoS 0 下发 | `connectTimeoutInSeconds` 默认 0（必须在线），最大 300；等不到返回 404 |
| Azure IoT Hub | 云到设备消息 | 单向 | — | 每台设备队列最多 50 条，TTL 最长 2 天（默认 1 小时） | 排队，过期进死信 |
| AWS IoT | Commands（2024 年 11 月 GA） | `$aws/commands/things/{thingName}/executions/+/request/{format}`，应答 `…/executions/{executionId}/response/{format}` | Topic 里的 `executionId` | 执行超时默认 10 秒、最长 12 小时 | 靠 MQTT 持久会话补发；会话默认保留 60 分钟，更长的命令要申请提高 |
| AWS IoT | Jobs | 面向一批设备 | `jobId` | 有执行超时、重试、熔断配置 | 任务排队，设备上线后取 |
| 华为云 IoTDA | 同步命令（MQTT 设备只支持这种） | `$oc/devices/{device_id}/sys/commands/request_id={request_id}`，应答 `…/commands/response/request_id={request_id}` | Topic 里的 `request_id` | 设备须在 20 秒内响应 | 失败 |
| 华为云 IoTDA | 异步命令（LwM2M / CoAP 设备） | 立即下发或缓存下发 | — | 缓存最长 48 小时，不指定时默认 24 小时 | 缓存下发：设备上线或上报数据时再发 |
| ThingsBoard | 服务端 RPC（单向 / 双向，轻量 / 持久化） | `v1/devices/me/rpc/request/$id`，应答 `v1/devices/me/rpc/response/$id` | Topic 里的 `$id` | 默认 10 000 ms，最小 5 000 ms；持久化 RPC 可设过期时间与重试次数 | 轻量 RPC 丢失；持久化 RPC 存库等设备重连 |
| 腾讯云 IoT Explorer | 行为调用 | `$thing/down/action/{ProductID}/{DeviceName}`，应答 `$thing/up/action/…` | 载荷 `clientToken` | — | — |

阿里云帮助中心已把物联网平台的文档标注为「文档停止维护」，这里只作为载荷派的代表。

### 2、归纳成三档

| 档位 | 调用方体验 | 设备离线 | 代表 |
|------|-----------|---------|------|
| 同步调用 | 一次请求等到结果或超时，秒级 | 立即失败 | Azure 直接方法、阿里云 RRPC、华为云同步命令、ThingsBoard 双向轻量 RPC |
| 异步（带回执） | 立即拿到命令 ID，之后查询状态或收回调 | 视配置失败或排队 | 阿里云异步服务、AWS Commands、ThingsBoard 持久化 RPC |
| 离线缓存 / 批量任务 | 提交一个任务，按设备逐台跟踪 | 缓存到上线、带过期时间 | 华为云缓存下发、Azure 云到设备消息、AWS Jobs |

同步调用本质上是「异步加一个等待」：平台内部仍是发请求、收应答两条消息，只是调用方的接口挂起等结果。所以实现上先做好异步，再在上面包一层带超时的等待。

---

## 三、请求与应答怎么配对

### 1、两派做法

| 做法 | 谁在用 | 好处 | 代价 |
|------|-------|------|------|
| 请求 ID 进 Topic | ThingsBoard、Azure、AWS Commands、华为云、阿里云 RRPC | Broker 和规则引擎不解析载荷就能路由；载荷可以是二进制 | 设备要订阅带通配符的 Topic；ACL 要按前缀授权 |
| 请求 ID 进载荷 | 阿里云 Alink（`id`）、腾讯云（`clientToken`） | Topic 固定，ACL 一条规则；与载荷里的其他字段一起签名、记日志 | 不解析载荷就不知道是哪次请求 |
| MQTT 5 Response Topic + Correlation Data | 协议原生 | 请求方在 PUBLISH 里指定应答 Topic 和关联数据，Broker 原样转给订阅者，响应方带回关联数据 | 只有 MQTT 5；存量 3.1.1 设备用不上 |

MQTT 5 规范对这两个属性的规定：带 Response Topic 的消息就是一条请求；服务端必须把 Response Topic 和 Correlation Data 原样转发给所有收到这条消息的订阅者。AWS IoT Core 也支持这一模式。

### 2、本模块的约定

```json
// 平台 → 设备：devices/dev001/cmd
{"id": "c-7f3a9e", "method": "reboot", "params": {"delaySeconds": 5}}

// 设备 → 平台：devices/dev001/response
{"id": "c-7f3a9e", "code": 200, "data": {}}
```

- **Topic 固定为 `devices/{deviceId}/cmd` 与 `devices/{deviceId}/response`，请求 ID 放载荷**：设备的 ACL 就是两条 `${clientid}` 规则，订阅 `cmd`、发布 `response`，见 [设备安全](../2_access/1_security)；MQTT 3.1.1 设备同样能用
- **MQTT 5 下同时带 Response Topic 与 Correlation Data**：Response Topic 填 `devices/{deviceId}/response`，Correlation Data 填请求 ID 的 UTF-8 字节。支持 MQTT 5 的设备 SDK 按协议自动回填，不用读载荷里的 `id`；两者都有时以载荷为准
- **`code` 借用 HTTP 状态码**：200 成功，202 已收到、正在执行，4xx 设备拒绝（方法不支持、参数不合法），5xx 执行失败。Azure 直接方法与 IoT Plug and Play 的可写属性回执用的也是 HTTP 状态码
- **`method` 就是物模型的服务标识**：平台下发前按服务定义校验 `params`，见 [物模型 · 上报校验](./1_thing_model#_2、上报校验)
- **挂在网关下的子设备**：平台查拓扑表，把指令改投 `gateways/{gatewayId}/cmd`，载荷多一个 `device` 字段，网关应答到 `gateways/{gatewayId}/response`，平台核对归属后按同一个 `id` 配对，命令表与状态机不变，见 [网关与子设备 · 下行指令](../2_access/5_gateway_subdevice#_4、下行指令)

---

## 四、命令的生命周期

![指令下发：同步调用与异步调用（设备离线）的时序，以及 CREATED、SENT、DELIVERED、SUCCEEDED、TIMED_OUT、EXPIRED、FAILED / REJECTED 组成的状态机](../../assets/iot/command-lifecycle.svg)

| 本模块 | 含义 | 谁推进 | AWS Commands | ThingsBoard 持久化 RPC | 华为云异步命令 |
|-------|------|-------|-------------|---------------------|--------------|
| `CREATED` | 已落库，未发出 | 平台创建 | `CREATED` | `QUEUED` | `PENDING` |
| `SENT` | 已发布到 Broker | 平台发布成功后 | — | `SENT` | `SENT` |
| `DELIVERED` | 设备确认收到、正在执行（可选） | 设备回 `code: 202` | `IN_PROGRESS` | `DELIVERED` | `DELIVERED` |
| `SUCCEEDED` | 执行成功 | 设备回 200 | `SUCCEEDED` | `SUCCESSFUL` | `SUCCESSFUL` |
| `REJECTED` | 设备拒绝执行 | 设备回 4xx | `REJECTED` | — | — |
| `FAILED` | 执行失败 | 设备回 5xx | `FAILED` | `FAILED`（重试用尽） | `FAILED` |
| `TIMED_OUT` | 发出后超时没有结果 | 平台扫描 | `TIMED_OUT` | `TIMEOUT` | `TIMEOUT` |
| `EXPIRED` | 到过期时间还没发出去 | 平台扫描 | — | `EXPIRED` | `EXPIRED` |

- **`SENT` 只说明 Broker 收下了**：QoS 1 的 PUBACK 来自 Broker，不来自设备；设备收没收到要靠 202 或最终应答
- **超时之后的迟到应答照样记账**：AWS 把平台判定的 `TIMED_OUT` 视为非终态，设备之后上报的成功或失败会覆盖它。同步调用方已经拿到超时，但命令记录要反映设备实际做了什么，否则运维看到「超时」去重发，设备就重启了两次
- **`EXPIRED` 与 `TIMED_OUT` 分开**：前者设备根本没收到，可以放心重发；后者设备可能已经执行，重发前要先确认

---

## 五、关键设计点

### 1、幂等：重发不等于重复执行

QoS 1 会重复投递，平台补发、调用方重试也会让同一条命令到达多次。两端各管一半：

- **平台**：命令 ID 由平台生成，重发用同一个 ID；调用方传入业务幂等键（如工单号）时，同一个键只建一条命令，见 [幂等设计](/architecture/3_idempotence)
- **设备**：记住最近处理过的命令 ID 与结果，重复到达时不再执行，直接把上次的结果再应答一遍

```java
/** 设备侧：最近 256 条命令的结果，重复的 id 直接回放结果 */
private final Map<String, Response> recent = new LinkedHashMap<>(256, 0.75f, true) {
    @Override
    protected boolean removeEldestEntry(Map.Entry<String, Response> eldest) {
        return size() > 256;
    }
};
```

### 2、超时：等待不能占住线程

同步调用最常见的错误写法是在业务线程里 `Thread.sleep` 轮询数据库，或 `future.get()` 阻塞等待：设备一慢，线程池就被占满。做法是把等待交给 `CompletableFuture`：控制器直接返回它，Spring MVC 会把请求转为异步处理，不占用请求线程；超时由 `orTimeout` 触发，超时返回 504（与 Azure 直接方法一致）。

超时要分两个：同步调用方愿意等多久（几秒到几十秒），和命令本身多久没结果算超时（异步命令可以是几分钟到几小时，AWS Commands 最长 12 小时）。

### 3、离线设备

| 策略 | 做法 | 适合 |
|------|------|------|
| 立即失败 | 下发前查在线状态，不在线直接返回 | 同步调用、交互式控制 |
| 缓存到上线 | 命令留在 `CREATED`，设备上线时按创建顺序补发 | 抄表、上传日志这类晚点做也行的动作 |
| 带过期时间 | 缓存同时设 `expireAt`，过期标 `EXPIRED` 不再发 | 有时效的动作，绝大多数情况都该设 |

- **离线不发、上线补发**：不要把离线设备的命令直接发进 Broker 让持久会话去排队。会话会过期、Broker 队列有上限，而且 MQTT 3.1.1 没有消息过期，排在队列里的旧命令设备上线后照样会执行
- **MQTT 5 的 Message Expiry 只是第二道保险**：发布时把剩余有效期（`expireAt` 减当前时间）写进 Message Expiry Interval，设备在线期间短暂断线、消息排进会话时，过期后 Broker 就不再投递
- **QoS 与持久会话的边界**：QoS 1 加持久会话保证的是「设备在会话有效期内重连能收到」，不保证执行，也不保证 Broker 重启后还在。参数怎么配见 [MQTT 客户端](../2_access/3_mqtt_client)，EMQX 会话的实测边界见 [可靠上报与接入层主备 · EMQX 会话怎么选](../4_practice/3_reliable_uplink#五、emqx-会话怎么选)；协议层面的 QoS 与会话见 [通信协议](../1_basics/1_protocol)

### 4、多实例：应答回到发起的实例

平台多实例部署时，各实例用 `$share/{组名}/devices/+/response` 共享订阅分摊应答，一条应答只会被其中一个实例收到，而等待它的 `CompletableFuture` 可能在另一个实例上。两种做法：

| 做法 | 怎么做 | 取舍 |
|------|-------|------|
| 收到后广播 | 收到应答的实例先按条件更新命令表，再用 Redis 发布订阅广播结果，持有等待者的实例完成它 | 简单；Redis 发布订阅不保证送达，丢了的那次同步调用按超时处理，命令表里的状态仍然正确 |
| 按实例的应答 Topic | MQTT 5 的 Response Topic 填发起实例专属的 Topic，应答直接回到该实例 | 不用广播；但设备要能发布到平台指定的任意 Topic，ACL 放宽，3.1.1 设备用不上 |

本模块用第一种：设备的 ACL 保持只能发布 `devices/{自己}/response`。

### 5、权限、审计与批量

- **谁能下发**：按「操作人 × 设备分组 × 服务」授权，重启、开锁这类高危服务单独授权或二次确认
- **留痕**：命令表本身就是审计日志，记操作人、来源（页面、接口、规则引擎）、参数、结果；不要只记在应用日志里
- **规则引擎触发的指令**也走同一个下发服务，不直接往 `cmd` 发布，见 [规则引擎与告警](./6_rule_engine)
- **批量下发**不是循环调用同步接口：先按分组创建一个任务，展开成逐台的命令，由调度器限速下发并统计成功率，超过失败阈值就暂停，见 [OTA 升级 · 任务编排与灰度](./5_ota#五、任务编排与灰度)。AWS 也把批量远程操作放在 Jobs 而不是 Commands

---

## 六、最小实现

Java 21、Spring Boot 4，MQTT 收发沿用 [MQTT 客户端](../2_access/3_mqtt_client) 里的 Spring Integration 配置。

### 1、命令表与状态机

```java
public enum CommandStatus {
    CREATED, SENT, DELIVERED, SUCCEEDED, FAILED, REJECTED, TIMED_OUT, EXPIRED;

    /** 允许流转到当前状态的前置状态；应答可能比 SENT 的更新先落库，所以终态也接受 CREATED */
    public Set<CommandStatus> allowedFrom() {
        return switch (this) {
            case CREATED -> Set.of();
            case SENT -> Set.of(CREATED);
            case DELIVERED -> Set.of(CREATED, SENT);
            case SUCCEEDED, FAILED, REJECTED -> Set.of(CREATED, SENT, DELIVERED, TIMED_OUT);  // 迟到的应答也记账
            case TIMED_OUT -> Set.of(SENT, DELIVERED);
            case EXPIRED -> Set.of(CREATED);
        };
    }

    public static CommandStatus fromCode(int code) {
        if (code == 202) return DELIVERED;
        if (code >= 200 && code < 300) return SUCCEEDED;
        return code >= 400 && code < 500 ? REJECTED : FAILED;
    }

    public boolean terminal() {
        return this == SUCCEEDED || this == FAILED || this == REJECTED;
    }
}
```

命令表 `iot_command` 的主要列：`id`（平台生成）、`device_id`、`method`、`params`、`status`、`code`、`result`、`operator`、`expire_at`（过了还没发出就 `EXPIRED`）、`deadline_at`（发出后到这个时间还没结果就 `TIMED_OUT`）、各状态的时间戳。状态更新与 [OTA 升级](./5_ota) 的任务表一样用条件更新：

```java
public interface CommandRepository extends JpaRepository<Command, String> {

    @Transactional
    @Modifying
    @Query("""
            update Command c set c.status = :to, c.code = :code, c.result = :result,
                   c.updatedAt = CURRENT_TIMESTAMP
             where c.id = :id and c.deviceId = :deviceId and c.status in :from
            """)
    int transition(String id, String deviceId, CommandStatus to, Set<CommandStatus> from,
                   Integer code, String result);

    @Transactional
    @Modifying
    @Query("update Command c set c.status = 'SENT', c.deadlineAt = :deadline where c.id = :id and c.status = 'CREATED'")
    int markSent(String id, Instant deadline);

    @Transactional
    @Modifying
    @Query("update Command c set c.status = 'TIMED_OUT' where c.status in ('SENT', 'DELIVERED') and c.deadlineAt < :now")
    int timeoutOverdue(Instant now);

    @Transactional
    @Modifying
    @Query("update Command c set c.status = 'EXPIRED' where c.status = 'CREATED' and c.expireAt < :now")
    int expireOverdue(Instant now);

    @Query("select c from Command c where c.deviceId = :deviceId and c.status = 'CREATED' and c.expireAt > :now order by c.createdAt")
    List<Command> findPending(String deviceId, Instant now);
}
```

`deviceId` 也作为条件，设备伪造别人的命令 ID 改不了别人的记录。

### 2、出站：带 Response Topic 与 Correlation Data

在 `MqttGateway` 上加一个方法。Spring Integration 的 v5 出站适配器默认会把这三个头映射成 MQTT 5 属性（`MESSAGE_EXPIRY_INTERVAL` 接受 `Long`，`CORRELATION_DATA` 接受 `byte[]`）：

```java
@MessagingGateway(defaultRequestChannel = "mqttOutboundChannel")
public interface MqttGateway {

    void publish(@Header(MqttHeaders.TOPIC) String topic, @Header(MqttHeaders.QOS) int qos, String payload);

    void publishRequest(@Header(MqttHeaders.TOPIC) String topic,
                        @Header(MqttHeaders.QOS) int qos,
                        @Header(MqttHeaders.MESSAGE_EXPIRY_INTERVAL) Long expirySeconds,
                        @Header(MqttHeaders.RESPONSE_TOPIC) String responseTopic,
                        @Header(MqttHeaders.CORRELATION_DATA) byte[] correlationData,
                        String payload);
}
```

### 3、下发服务

```java
public record CommandRequest(String deviceId, String method, JsonNode params,
                             Duration timeout, Duration ttl) {}
public record CommandResult(String id, CommandStatus status, Integer code, JsonNode data) {}

@Service
public class CommandService {

    private final CommandRepository commands;
    private final DeviceOnlineRegistry online;      // 在线状态，做法见下文
    private final ThingModelCache models;
    private final MqttGateway mqtt;
    private final JsonMapper json;
    // 本实例上正在等结果的同步调用
    private final Map<String, CompletableFuture<CommandResult>> waiting = new ConcurrentHashMap<>();

    // 构造器省略

    /** 异步：落库后立即返回命令 ID；在线就马上发，不在线等上线补发，过了 ttl 作废 */
    public String submit(CommandRequest req, String operator) {
        Command cmd = commands.save(Command.create(validate(req), operator));   // CREATED
        if (online.isOnline(req.deviceId())) {
            dispatch(cmd);
        }
        return cmd.getId();
    }

    /** 同步：不在线立即失败；在线则等结果，最长 req.timeout()，不占用调用线程 */
    public CompletableFuture<CommandResult> invoke(CommandRequest req, String operator) {
        if (!online.isOnline(req.deviceId())) {
            return CompletableFuture.failedFuture(new DeviceOfflineException(req.deviceId()));
        }
        Command cmd = commands.save(Command.create(validate(req), operator));
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        waiting.put(cmd.getId(), result);                 // 先登记再发送，应答再快也不会漏
        dispatch(cmd);
        return result.orTimeout(req.timeout().toMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((r, e) -> waiting.remove(cmd.getId()));
    }

    void dispatch(Command cmd) {
        String device = cmd.getDeviceId();
        long ttl = Duration.between(Instant.now(), cmd.getExpireAt()).toSeconds();
        if (ttl <= 0) {
            return;                                        // 已过期，交给扫描任务标 EXPIRED
        }
        ObjectNode body = json.createObjectNode()
                .put("id", cmd.getId()).put("method", cmd.getMethod());
        body.set("params", cmd.getParams());
        mqtt.publishRequest("devices/" + device + "/cmd", 1, ttl,
                "devices/" + device + "/response", cmd.getId().getBytes(StandardCharsets.UTF_8),
                json.writeValueAsString(body));
        commands.markSent(cmd.getId(), Instant.now().plus(cmd.getTimeout()));
    }

    /** 收到结果广播时调用：本实例有人在等就交给它 */
    void complete(CommandResult result) {
        CompletableFuture<CommandResult> f = waiting.remove(result.id());
        if (f != null) {
            f.complete(result);
        }
    }

    private CommandRequest validate(CommandRequest req) {
        // 用 models 取设备所属产品的物模型，按服务定义校验 method 与 params，不合法抛 400
        return req;
    }
}
```

- 先发消息再标 `SENT`：两步之间崩溃时命令停在 `CREATED`，上线补发或下一轮会再发一次，设备按 ID 去重；反过来先标再发，崩溃时就是「显示已发、实际没发」
- 控制器返回 `invoke` 的 `CompletableFuture`，异常里的 `TimeoutException` 映射为 504，`DeviceOfflineException` 映射为 404，与 Azure 直接方法的约定一致

### 4、应答处理与结果广播

入站适配器多订阅一个 `$share/{组名}/devices/+/response`，路由时把以 `/response` 结尾的 Topic 送到 `commandResponseChannel`：

```java
@Component
public class CommandResponseHandler {

    private final CommandRepository commands;
    private final StringRedisTemplate redis;
    private final JsonMapper json;

    // 构造器省略

    @ServiceActivator(inputChannel = "commandResponseChannel")
    public void handle(@Header(MqttHeaders.RECEIVED_TOPIC) String topic, byte[] payload) {
        String deviceId = topic.split("/")[1];                         // devices/{deviceId}/response
        JsonNode resp = json.readTree(payload);
        String id = resp.path("id").asString();
        int code = resp.path("code").asInt();
        CommandStatus to = CommandStatus.fromCode(code);
        int updated = commands.transition(id, deviceId, to, to.allowedFrom(), code, resp.path("data").toString());
        if (updated == 1 && to != CommandStatus.DELIVERED) {
            var result = new CommandResult(id, to, code, resp.path("data"));
            redis.convertAndSend("iot:cmd:done", json.writeValueAsString(result));   // 等待者可能在别的实例
        }
        // updated == 0：重复应答、乱序或伪造的 ID，记录后忽略
    }
}
```

```java
@Bean
public RedisMessageListenerContainer commandDoneListener(RedisConnectionFactory factory,
                                                         CommandService service, JsonMapper json) {
    var container = new RedisMessageListenerContainer();
    container.setConnectionFactory(factory);
    container.addMessageListener((message, pattern) ->
            service.complete(json.readValue(message.getBody(), CommandResult.class)),
            new ChannelTopic("iot:cmd:done"));
    return container;
}
```

载荷用 Jackson 3 的 `JsonNode`（Spring Boot 4 默认），`asString()` 是 Jackson 3 里取文本值的方法。

### 5、超时扫描与上线补发

```java
@Component
public class CommandSweeper {

    private final CommandRepository commands;
    private final CommandService service;

    // 构造器省略

    /** 两条都是条件批量更新，多实例同时跑也不会重复推进，不需要分布式锁 */
    @Scheduled(fixedDelay = 5_000)
    public void sweep() {
        Instant now = Instant.now();
        commands.timeoutOverdue(now);
        commands.expireOverdue(now);
    }

    /** 设备上线：按创建顺序补发未过期的命令 */
    @EventListener
    public void onOnline(DeviceOnlineEvent event) {
        for (Command cmd : commands.findPending(event.deviceId(), Instant.now())) {
            service.dispatch(cmd);
        }
    }
}
```

`DeviceOnlineEvent` 与 `DeviceOnlineRegistry` 来自 Broker 的上下线事件或设备的状态 Topic，几种判定在线的做法见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。上线事件可能重复到达，补发因此会重复，靠设备侧按 ID 去重兜住。

---

## 七、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 设备上线后执行了一串过时的开关命令 | 离线时把命令发进了 Broker，靠会话排队 | 离线不发、上线补发，命令带过期时间 |
| 设备重启了两次 | QoS 1 重复投递或平台重发，设备没去重 | 平台重发用同一个 ID，设备按 ID 回放结果 |
| 同步接口一慢，整个服务没有可用线程 | 业务线程阻塞等待应答 | 返回 `CompletableFuture`，`orTimeout` 超时 |
| 应答到了，调用方仍然超时 | 共享订阅把应答分给了别的实例 | 收到应答的实例广播结果，或按实例的应答 Topic |
| 显示超时，其实设备执行成功了 | 超时被当成终态，迟到的应答被丢弃 | `TIMED_OUT` 允许被设备的最终应答覆盖 |
| 命令状态乱跳 | 先查再改，重复或乱序应答覆盖了终态 | 条件更新，非法流转直接忽略 |
| 把「设置上报周期」做成命令，设备离线就丢 | 状态类下行没走影子 | 期望状态走设备影子，命令只做一次性动作 |

---

## 小结

- 长时状态走设备影子，即时动作走指令；同步调用是「异步加等待」，先做好异步再包一层超时
- 主流平台分三档：同步调用、带回执的异步、离线缓存或批量任务；请求 ID 有进 Topic 和进载荷两派，MQTT 5 另有 Response Topic 与 Correlation Data
- 本模块 Topic 固定为 `devices/{deviceId}/cmd` 与 `devices/{deviceId}/response`，请求 ID 放载荷，MQTT 5 下同时带 Response Topic 与 Correlation Data，ACL 简单且兼容 3.1.1
- 命令状态 `CREATED → SENT → DELIVERED → SUCCEEDED / FAILED / REJECTED`，平台扫描出 `TIMED_OUT` 与 `EXPIRED`，迟到的应答仍然记账；状态用条件更新推进
- 设备按命令 ID 去重，平台离线不发、上线补发、带过期时间；多实例下收到应答的实例广播结果；批量下发走任务编排
- 本篇讲的是通用设计；配套仓库 Conduit IoT 尚未实现指令下发（在它的路线图里），目前见 [平台实战概览](../4_practice/0_intro)

## 参考资料

- Azure IoT Hub · 云到设备通信选型指南：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-c2d-guidance](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-c2d-guidance)
- Azure IoT Hub · 直接方法：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-direct-methods](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-direct-methods)
- Azure IoT Hub · 云到设备消息：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-messages-c2d](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-messages-c2d)
- IoT Plug and Play 约定（可写属性回执，已归档）：[https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention](https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention)
- AWS IoT Device Management commands：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command.html)
- AWS IoT Commands 概念与执行状态：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command-concepts.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command-concepts.html)
- AWS IoT Commands 启动与监控执行（超时、持久会话、Topic）：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command-execution-start-monitor.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-remote-command-execution-start-monitor.html)
- Announcing Commands feature for AWS IoT Device Management：[https://aws.amazon.com/about-aws/whats-new/2024/11/commands-feature-aws-iot-device-management](https://aws.amazon.com/about-aws/whats-new/2024/11/commands-feature-aws-iot-device-management)
- AWS IoT Jobs 与执行状态：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html)
- AWS IoT Core · MQTT（持久会话、MQTT 5 请求响应）：[https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html)
- 阿里云物联网平台 · 什么是 RRPC：[https://help.aliyun.com/zh/iot/user-guide/what-is-rrpc](https://help.aliyun.com/zh/iot/user-guide/what-is-rrpc)
- 阿里云物联网平台 · 调用 RRPC 通信相关 Topic：[https://help.aliyun.com/zh/iot/user-guide/use-rrpc-specific-topics](https://help.aliyun.com/zh/iot/user-guide/use-rrpc-specific-topics)
- 阿里云物联网平台 · RRpc 接口：[https://help.aliyun.com/zh/iot/developer-reference/api-rrpc-2018-01-20](https://help.aliyun.com/zh/iot/developer-reference/api-rrpc-2018-01-20)
- 阿里云物联网平台 · 设备属性、事件、服务：[https://help.aliyun.com/zh/iot/user-guide/device-properties-events-and-services](https://help.aliyun.com/zh/iot/user-guide/device-properties-events-and-services)
- 华为云 IoTDA · 命令下发：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0339.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0339.html)
- ThingsBoard · RPC：[https://thingsboard.io/docs/user-guide/rpc/](https://thingsboard.io/docs/user-guide/rpc/)
- ThingsBoard · MQTT Device API：[https://thingsboard.io/docs/reference/mqtt-api/](https://thingsboard.io/docs/reference/mqtt-api/)
- 腾讯云物联网开发平台 · 物模型协议：[https://cloud.tencent.com/document/product/1081/34916](https://cloud.tencent.com/document/product/1081/34916)
- MQTT Version 5.0（OASIS，Response Topic、Correlation Data、Message Expiry Interval）：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
- Spring Integration MQTT Support：[https://docs.spring.io/spring-integration/reference/mqtt.html](https://docs.spring.io/spring-integration/reference/mqtt.html)

> 下一篇：[OTA 升级](./5_ota)

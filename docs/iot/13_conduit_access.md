---
description: topic 设计与解析、设备密钥生成与哈希、EMQX HTTP 鉴权回调与拒绝原因、超时处理、ACL、上下线与在线状态
---

# 设备接入与鉴权

> 前置阅读：[平台实战概览](./12_conduit_intro)、[设备安全](./5_security)、[通信协议](./1_protocol)

设备要先被平台认出来、被限制在自己的 topic 里，后面的数据才谈得上可信。本篇讲 Conduit 的 topic 设计、设备凭据、EMQX HTTP 鉴权回调、ACL 和在线状态，以及两份排查报告带来的改动，基线为 JDK 21、Spring Boot 3.5。

---

## 一、要解决的问题

一台设备从出厂到能上报，平台要回答四个问题：

| 问题 | Conduit 的回答 | 在哪 |
|------|---------------|------|
| 你是谁 | 一机一密：`deviceKey` 加 `deviceSecret`，平台只存密钥的哈希 | 第三节 |
| 让不让你连 | EMQX 每次连接同步回调 server，server 说 allow 才放行 | 第四节 |
| 连上后能碰哪些 topic | EMQX 文件 ACL，按 clientId 把设备锁在自己的 topic 里 | 第八节 |
| 你现在在不在线 | EMQX 的上下线事件为主，上报数据补偿 | 第九节 |

认证方式的对比（密钥、HMAC 签名、X.509 证书）和 EMQX 认证授权的通用配置见 [设备安全](./5_security)，本篇只讲 Conduit 选的这一种是怎么落地的。先说结论：它选的是最简单的「用户名加密钥、HTTP 回调校验」，没有 TLS，没有证书，这是当前版本的已知限制，不是推荐做法。

---

## 二、Topic 设计与解析

### 1、三段式 topic

| 方向 | Topic | 状态 |
|------|-------|------|
| 上行属性 | `conduit/{productKey}/{deviceKey}/up/property` | 已实现 |
| 上行事件 | `conduit/{productKey}/{deviceKey}/up/event` | 能解析，流水线按 `UNSUPPORTED_TYPE` 进死信 |
| 下行回执 | `conduit/{productKey}/{deviceKey}/down/ack` | 已实现，见 [可靠上报与接入层主备](./15_conduit_reliable_uplink) |
| 下行命令 | `conduit/{productKey}/{deviceKey}/down/command` | V0.1 设计文档里预留，未实现 |

topic 里放产品和设备两段，方向和类型放在后面，有三个考虑：

- **ACL 只看一段**：设备的 clientId 等于 `deviceKey`，规则写成 `conduit/+/${clientid}/up/#` 就能把每台设备限制在自己的 topic 里，不用为每台设备生成规则
- **transport 不查库就能路由**：产品、设备、消息类型都从 topic 里取，接入层不需要连 PostgreSQL
- **订阅一个通配就收全量**：`conduit/+/+/up/#` 覆盖全部设备的全部上行

### 2、解析：纯函数，不合格就丢

```java
/** conduit/{productKey}/{deviceKey}/up/{property|event} */
private static Optional<ParsedTopic> parseDeviceTopic(String topic) {
    String[] p = topic.split("/", -1);
    if (p.length != 5 || !"conduit".equals(p[0]) || !"up".equals(p[3])
            || p[1].isEmpty() || p[2].isEmpty()) {
        return Optional.empty();
    }
    MessageType type = switch (p[4]) {
        case "property" -> MessageType.PROPERTY;
        case "event" -> MessageType.EVENT;
        default -> null;
    };
    return Optional.ofNullable(type).map(t -> new ParsedTopic(p[1], p[2], t));
}
```

代码见 [`TopicParser`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/mqtt/TopicParser.java)。几个细节：

- `split("/", -1)` 保留末尾的空段，`conduit/pk/dk/up/` 这种少一段的 topic 会得到 5 段但最后一段是空串，落进 `default` 被丢弃
- 同一个解析器还处理 EMQX 的系统 topic `$SYS/brokers/{node}/clients/{clientid}/connected` 与 `disconnected`，得到 `PRESENCE_CONNECTED` / `PRESENCE_DISCONNECTED`，此时 `productKey` 为 null
- 解析不出来的 topic 由 transport 记一条 WARN、直接确认丢弃，不进总线

### 3、topic 里的 productKey 不可信

ACL 只约束了 `deviceKey` 那一段，`productKey` 那段是 `+`，设备可以随便填。所以 transport 把它原样放进 `RawMessage`，由 server 的流水线核对：消息里的 `productKey` 与设备在库里所属的产品不一致时，整条消息进死信 `PRODUCT_MISMATCH`。租户更是从不取自设备侧，流水线只认按 `deviceKey` 查出来的 `tenantId`。

---

## 三、设备凭据：生成与哈希

### 1、生成

```java
private static final char[] ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789".toCharArray();
private final SecureRandom random = new SecureRandom();

public String deviceKey()    { return next(16); }
/** 设备密钥：32 位随机串，明文只在创建/重置时返回一次。 */
public String deviceSecret() { return next(32); }
```

代码见 [`KeyGenerator`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/security/KeyGenerator.java)。`productKey` 与 `deviceKey` 都是 16 位小写字母加数字，全平台唯一（数据库唯一约束）；`deviceSecret` 是 32 位，36 个字符里取 32 次，约 165 bit 的随机性。

密钥由平台生成而不是让用户填，省掉了弱口令这一类问题。对外接口只有两个时刻会返回明文：

| 接口 | 说明 |
|------|------|
| `POST /api/v1/devices` | 新建设备，响应里带一次 `deviceSecret` |
| `POST /api/v1/devices/{deviceKey}/reset-secret` | 重置，返回一次新密钥，旧密钥立即失效 |

### 2、哈希：SHA-256 加盐，不用 bcrypt

```java
/** 设备密钥哈希：SHA-256(salt + secret)。不用 bcrypt，避免重连风暴时鉴权 CPU 过载；
 *  密钥本身是 32 位随机串，熵足够，不需要慢哈希。 */
public String hash(String secret, String salt) {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    return HexFormat.of().formatHex(digest.digest((salt + secret).getBytes(StandardCharsets.UTF_8)));
}

public boolean matches(String secret, String salt, String expectedHash) {
    return MessageDigest.isEqual(hash(secret, salt).getBytes(StandardCharsets.UTF_8),
            expectedHash.getBytes(StandardCharsets.UTF_8));
}
```

代码见 [`SecretHasher`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/security/SecretHasher.java)（片段省略了异常处理）。同一个仓库里，登录用户的密码用 BCrypt，设备密钥却用快哈希，两处的取舍正好相反：

| | 用户密码 | 设备密钥 |
|---|---|---|
| 谁定的 | 人，可能很弱 | 平台随机生成，32 位 |
| 慢哈希防什么 | 库泄露后被字典和暴力猜出 | 随机串本来就猜不出，慢哈希没有额外收益 |
| 校验频率 | 登录一次 | 每次 MQTT 连接一次，断网恢复时成千上万台同时重连 |
| 选择 | BCrypt | SHA-256 加 16 字节随机盐 |

慢哈希的「慢」是故意的，一次要几十毫秒 CPU。Broker 重启或网络抖动后全体设备同时重连，鉴权回调的 CPU 就会成为瓶颈，设备等不到 CONNACK 又继续重试，越堆越多。密钥已经是高熵随机串时，这个代价换不来安全性。

比较用 `MessageDigest.isEqual`，耗时不随「前几位相同」而变化，避免从响应时间一位一位猜出哈希。

### 3、表里存什么

`device` 表里和凭据有关的只有三列：`secret_hash`（64 位十六进制）、`secret_salt`（32 位十六进制）、`status`（`ENABLED` / `DISABLED`），见 [`V1__init.sql`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/resources/db/migration/V1__init.sql)。明文密钥不落库、不进日志，丢了只能重置。

---

## 四、EMQX HTTP 鉴权回调

![设备连接与鉴权时序：设备 CONNECT，EMQX 回调 server，server 查身份后返回 allow 或 deny](../assets/iot/conduit-auth-flow.svg)

### 1、EMQX 侧的配置

```hocon
authentication = [
  {
    mechanism = password_based
    backend = http
    method = post
    url = "__CONDUIT_AUTH_URL__/internal/mqtt/auth"
    body { clientid = "${clientid}", username = "${username}", password = "${password}" }
    headers { "X-Conduit-Internal-Token" = "__CONDUIT_INTERNAL_TOKEN__" }
    request_timeout = "10s"
  }
]
```

模板见 [`base.hocon.tpl`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/dev/emqx/base.hocon.tpl)（片段有删节），两个 `__占位符__` 在容器启动时由环境变量渲染。认证链里只有这一个认证器，所以 server 说了算。

### 2、server 侧：先验 token，再判身份

```java
@PostMapping("/internal/mqtt/auth")
public Map<String, Object> authenticate(
        @RequestHeader(value = "X-Conduit-Internal-Token", required = false) String token,
        @RequestBody MqttAuthRequest request) {
    if (token == null || props.token() == null || props.token().isBlank()
            || !MqttAuthService.constantEquals(token, props.token())) {
        throw ApiException.unauthorized("invalid internal token");
    }
    Decision decision = service.authenticate(request.clientid(), request.username(), request.password());
    if (!decision.allow()) {
        return Map.of("result", "deny");
    }
    return Map.of("result", "allow", "is_superuser", decision.superuser());
}
```

代码见 [`MqttAuthController`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/mqttauth/MqttAuthController.java)。响应有两层含义，不要混：

| server 返回 | 含义 | EMQX 的处理 |
|-------------|------|------------|
| HTTP 200 + `{"result":"allow"}` | 身份校验通过 | 放行 |
| HTTP 200 + `{"result":"deny"}` | 请求合法，但这台设备不让连 | 拒绝，设备收到未授权的 CONNACK |
| HTTP 401 | 调用方不是 EMQX（内部 token 缺失或不对） | 视为回调失败，拒绝连接 |

`/internal/mqtt/auth` 和 REST API 在同一个端口上，不走 JWT，靠内部 token 保护。这个 token 是 server 的必填配置：[`MqttAuthProperties`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/mqttauth/MqttAuthProperties.java) 的构造器里发现 token 或 transport 密码为空就直接抛异常，进程起不来，避免鉴权接口在没有保护的状态下对外服务。

### 3、判定顺序

[`MqttAuthService#authenticate`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/mqttauth/MqttAuthService.java) 按下面的顺序判断，命中即返回：

| 顺序 | 条件 | 结论（reason） |
|------|------|---------------|
| 1 | clientId、用户名、密码任一为 null | 拒绝 `missing_credentials` |
| 2 | 用户名等于配置的 transport 用户名：密码一致且 clientId 以 `conduit-` 开头 | 放行并标为超级用户 `transport`；否则拒绝 `transport_rejected` |
| 3 | clientId 不等于用户名 | 拒绝 `client_id_mismatch` |
| 4 | 按用户名（即 deviceKey）查不到设备 | 拒绝 `unknown_device` |
| 5 | 设备被禁用 | 拒绝 `device_disabled` |
| 6 | 设备所属租户被停用 | 拒绝 `tenant_disabled` |
| 7 | 密钥哈希不匹配 | 拒绝 `wrong_secret` |
| 8 | 以上都通过 | 放行 `device` |

第 3 步要求 clientId 必须等于用户名，这是 ACL 能用 `${clientid}` 做隔离的前提：如果允许设备 A 用自己的账号、B 的 clientId 连上来，ACL 就会把 B 的 topic 放给它。

transport 自己也是 EMQX 的一个客户端，走同一个回调。它返回 `is_superuser = true`，EMQX 对超级用户不检查 ACL，所以它能订阅全部设备的上行 topic 和 `$SYS` 事件。`conduit-` 前缀还顺带保证了设备冒充不了它：`deviceKey` 的字符集里没有连字符。

不管拒绝原因是什么，返回给 EMQX 的都只是 `deny`，设备侧看到的也只是「未授权」，不告诉它是账号不存在还是密钥不对。原因只进 server 的 DEBUG 日志和指标。

---

## 五、身份缓存

每次连接查一次 PostgreSQL，在集中重连时扛不住。设备身份缓存在 Redis：

| 项 | 取值 |
|----|------|
| 键 | `conduit:auth:{deviceKey}` |
| 值 | JSON：deviceKey、tenantId、设备状态、密钥哈希与盐、productKey、租户状态 |
| 过期 | 5 分钟 |
| 主动清除 | 设备启用 / 禁用、重置密钥、删除设备；租户停用 / 启用时清掉该租户全部设备 |
| 不存在的设备 | 不缓存空结果 |

查询在 [`DeviceIdentityLookup`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/device/DeviceIdentityLookup.java)，缓存本身在 [`DeviceIdentityCache`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/device/DeviceIdentityCache.java)。同一份缓存鉴权和流水线都在用，流水线按批一次 `MGET`。有三处容错值得看：

- **Redis 不可用时降级直查 PostgreSQL**：读缓存抛异常只记 WARN，继续查库；回填失败也只记 WARN。Redis 抖动不会让设备连不上
- **缓存内容损坏按未命中处理**：反序列化失败就删掉这一条再回源，不会一直卡在坏数据上
- **重置密钥后先改库再清缓存**：旧密钥在下一次鉴权时就失效，不用等 5 分钟

这份缓存是全平台唯一一个不带租户前缀、按请求里的 `deviceKey` 直接读的 Redis 键，所以缓存的身份里必须带可信的 `tenantId`，后续处理只采用它，见 [多租户与授权](./18_conduit_tenant)。

---

## 六、拒绝原因：让「连不上」看得见

### 1、问题

按 EMQX 的协议，拒绝也是 HTTP 200。EMQX 自己只知道放行了多少、拒绝了多少，server 的访问日志里全是 200，「为什么被拒」只有 `MqttAuthService` 那一段代码知道。设备大面积连不上时，只能翻 DEBUG 日志猜。

### 2、做法

给每种结论一个计数器 `conduit.mqtt.auth{result, reason}`（Prometheus 里是 `conduit_mqtt_auth_total`），两个放行原因加七个拒绝原因，共 9 个序列：

```java
/** 启动即注册全部原因的计数器，从未发生的原因在 Prometheus 里是 0 而不是没有序列。 */
for (Outcome o : Outcome.values()) {
    counters.put(o, Counter.builder("conduit.mqtt.auth")
            .tag("result", o.allow ? "allow" : "deny")
            .tag("reason", o.name().toLowerCase())
            .register(meters));
}
```

两个设计点：

- **标签取值有限**：只有结论和原因，不带 clientId。带上设备标识的话每台设备一个序列，几万台设备就把 Prometheus 撑爆，指标的基数问题见 [指标监控](/observability/2_metrics)
- **启动就注册全部序列**：Micrometer 的计数器默认第一次用到才出现。某个原因从没发生过时，「没有序列」和「是 0」在看板上不一样：前者画不出线，告警表达式也算不出结果

### 3、它立刻派上了用场

[测试报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-mqtt-auth-deny-reasons.md) 里，先用已知结论的连接核对计数：5 次错密钥对应 `wrong_secret` +5，一次不存在的设备对应 `unknown_device` +1，一次 clientId 与用户名不一致对应 `client_id_mismatch` +1；EMQX 自己统计的鉴权失败 10 分钟增量 17，和 server 各拒绝原因之和一致。

核对过程中多出了 10 次不是测试发起的 `wrong_secret`。顺着 EMQX 日志找到来源是模拟器：压测脚本重置了 600 台压测设备的密钥，其中 100 台同时也被模拟器模拟着，模拟器拿旧密钥重连被拒。两个工具共用同一批设备会互相作废对方的密钥，这类冲突以前只能靠推断，有了按原因的计数直接看得见。后来模拟器加了 `SIM_EXCLUDE_PRODUCTS`，默认不碰压测产品。

---

## 七、超时与 server 不可用

### 1、server 不可用时

鉴权是整条链路上唯一的同步依赖，行为要说清楚：

| 情况 | 结果 |
|------|------|
| server 停了或重启中 | 新连接被拒绝，设备按自己的重连策略重试；**已连接的设备不受影响**，继续上报，数据由 transport 写进总线排队 |
| server 刚启动、EMQX 先起来 | EMQX 不依赖 server 启动，回调失败时自行重试；server 就绪后恢复 |
| Redis 不可用 | 鉴权降级直查 PostgreSQL，照常工作 |
| PostgreSQL 不可用 | 缓存命中的设备（5 分钟内连过）还能通过，其余失败 |
| 回调超过 EMQX 的超时 | 按失败处理，设备被判未授权后重连，不丢数据 |

设备被拒后重连是安全的：没连上就没发出数据，不存在「发了但丢了」。

### 2、一次被误判为「长连接半开」的超时

EMQX 与 server 分机部署后，两次出现成批设备鉴权被拒：EMQX 日志是回调超时（当时是 5 秒），server 这边却根本没收到请求。最初立项的名字是「鉴权长连接偶发半开」，[排查报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-auth-timeout-investigation.md) 对比两端的连接表，一步就把这个猜测否掉了。真正的原因在三层之下：宿主机 CPU 紧张，EMQX 所在的虚拟机短暂得不到调度，入站包在虚拟化层被丢；恰好丢的是鉴权请求或响应时，TCP 按指数退避重传，总等待超过 5 秒，设备就被判未授权。取证步骤与对照实验在 [压测与瓶颈排查](./22_conduit_capacity)，这里只记它给鉴权留下的东西：

- **鉴权超时从 5 秒放宽到 10 秒**（[复测报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-ring-timeout-retest.md)）。5 秒容不下一次丢包后的两三轮 TCP 重传，10 秒留出了余量；代价是 server 真的挂掉时，设备要多等几秒才收到拒绝
- **设备侧必须有重连**。这次的丢包来自桌面虚拟化，独立服务器一般遇不到，但「丢包使鉴权超时、设备被拒」在任何网络都可能发生
- **先取证再定性**。「半开连接」听起来合理，连接表对比一步就能排除；报告的标题保留了最初的错误猜测，结论一节明确写「不是网络连接半开」

---

## 八、ACL：把设备锁在自己的 topic 里

认证回答「你是谁」，授权回答「你能发到哪、订阅哪」。Conduit 的授权只有三行：

```erlang
%% 设备只能发布自己的上行 topic、订阅自己的下行 topic。
%% transport 由鉴权回调标记为 superuser，不受这里的规则约束。
{allow, all, publish, ["conduit/+/${clientid}/up/#"]}.
{allow, all, subscribe, ["conduit/+/${clientid}/down/#"]}.
{deny, all}.
```

规则见 [`acl.conf`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/dev/emqx/acl.conf)，配套的授权配置是 `no_match = deny`、`deny_action = ignore`，并开启了授权缓存。

- **规则数量与设备数无关**：`${clientid}` 是占位符，EMQX 在检查时替换成当前连接的 clientId。一万台设备还是这三行
- **认证和授权分开**：server 只管「让不让连」，topic 权限完全由 EMQX 本地判断，发布消息时不回调 server，没有额外的网络往返
- **越权发布被丢弃而不是断开**：`deny_action = ignore` 时，设备往别人的 topic 发消息，消息被丢掉，连接保留
- **最后一行兜底拒绝**：没匹配上任何 allow 的操作一律不允许，包括订阅 `$SYS` 和通配符 `#`

这套规则依赖第四节的「clientId 必须等于用户名」。文件 ACL、内置数据库、HTTP 授权几种方式的对比见 [设备安全](./5_security)。

---

## 九、上下线事件与在线状态

### 1、事件从哪来

设备不需要自己报「我上线了」。EMQX 配置里打开了 `client_connected` 与 `client_disconnected` 两个系统事件，发布在 `$SYS/brokers/{node}/clients/{clientid}/connected` 与 `disconnected` 上。transport 订阅这两个 topic，把事件组装成 `PRESENCE_CONNECTED` / `PRESENCE_DISCONNECTED` 类型的 `RawMessage`，和数据走同一条总线。

- 主 transport 开多条连接时，上下线事件只由第 0 条订阅，否则每条连接各收一份
- clientId 以 `conduit-` 开头的是平台自己的客户端，它们的上下线事件直接丢弃

server 侧由 [`PresenceHandler`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/presence/PresenceHandler.java) 取出事件里的 `connected_at` / `disconnected_at` 和客户端 IP，交给 [`PresenceStore`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/presence/PresenceStore.java) 写进 Redis 的 hash `conduit:presence:{deviceKey}`。

### 2、乱序：旧事件不能盖掉新状态

事件经过 EMQX、transport、Redis Streams、流水线四跳才落到状态上，中间有重投和多线程，到达顺序不保证。设备快速断开又连上时，「断开」事件可能比「连接」事件晚到，直接覆盖的话设备明明在线却显示离线。

做法是每条状态记录带一个 `since`（事件发生的时刻，取自 EMQX 的时钟），只接受不早于它的事件：

```lua
-- event：仅当 ts >= since 才生效
if curSince and curSource ~= 'data' and tonumber(curSince) > ts then
  return 0
end
redis.call('HSET', KEYS[1], 'online', ARGV[1], 'since', ARGV[2], 'clientIp', ARGV[3], 'source', 'event')
return 1
```

读、比较、写三步放在一段 [Lua 脚本](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/resources/redis/presence-apply.lua) 里原子执行（片段有删节），多个流水线线程同时处理同一台设备的事件也不会交错。

### 3、数据补偿：没收到连接事件怎么办

只靠事件有一个洞：设备在 transport 订阅 `$SYS` 之前就已经连上了（比如 transport 重启期间），连接事件没人收，设备一直在报数据却显示离线。所以在线状态有第二个来源：流水线每处理完一批属性数据，就把这批设备按「数据」来源标记一次。

两个来源的可信度不同，规则也不同：

| 来源 | 时间取自 | 规则 |
|------|---------|------|
| 事件 | EMQX 的时钟 | 权威。`ts >= since` 就生效，并把 `since` 推进到事件时间 |
| 数据 | transport 的接收时间 | 只做补偿，**永远不推进已有记录的 `since`** |

数据来源细分三种情况：

- **没有记录**：置为在线
- **已在线**：不改状态，只刷新 `lastSeen`
- **已离线**：只有数据时间超过 `since` 加 10 秒宽限期才翻转为在线

10 秒宽限期针对的是「刚断开的设备还有在途数据」：断连事件已经处理了，几百毫秒后流水线又处理到它断开前发的最后几条数据，不能因此把它复活。两个时钟不同源也是原因之一，transport 与 EMQX 的时间差可能让先后顺序看起来是反的。

还有一条例外：当前记录是由数据推断出来的（`source = data`）时，它的 `since` 来自另一个时钟，不可信，此时事件总是生效。

数据补偿是尽力而为的：在消息确认之后执行，Redis 失败只记一条 WARN，不重试，不影响数据入库。遥测重放不走这条路径，否则重放旧数据会把早已离线的设备标成在线。

### 4、页面上看到的

设备列表的「在线」来自 `conduit:presence`，「最后上报」来自最新值 hash 里的保留字段 `__last`，两者是分开的：在线状态说的是连接，最后上报说的是数据。列表分页查 PostgreSQL，当前页的这两项用一次 Redis pipeline 补齐。

---

## 十、连接参数与上报格式

设备侧要对接的全部约定在 [设备接入指南](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md) 里，这里摘出和本篇有关的部分。

| 参数 | 取值 |
|------|------|
| 协议 | MQTT 3.1.1 或 5 |
| 端口 | 默认 1883，未启用 TLS |
| clientId | deviceKey |
| 用户名 | deviceKey，必须与 clientId 相同 |
| 密码 | deviceSecret |
| 建议 keepalive | 60 秒 |

上报用 QoS 1 发到 `conduit/{productKey}/{deviceKey}/up/property`，标准 JSON 格式：

```json
{
  "id": "dev01-000123",
  "ts": 1760400000000,
  "params": { "Ua": 220.1, "Ia": 5.2, "mode": "auto", "alarm": false }
}
```

| 字段 | 规则 |
|------|------|
| `id` | 可选，1～128 个字符，同一设备内唯一；带上即启用可靠上报，平台写入总线后向 `down/ack` 发回执 |
| `ts` | 采样时间，毫秒时间戳，必须在「当前时间 − 30 天」到「当前时间 + 5 分钟」之间；普通上报可省略，缺省取平台接收时间 |
| `params` | 非空对象，值只能是数字、字符串、布尔 |

格式的解析、另一种扁平 JSON 格式和按物模型的校验在 [物模型与解码](./14_conduit_thing_model)，`id` 与业务回执在 [可靠上报与接入层主备](./15_conduit_reliable_uplink)。QoS 等级的含义见 [通信协议](./1_protocol)。

接入指南里「连接被拒绝」的四个常见原因，正好对应第四节的判定表：clientId 与用户名不一致、密钥错误或已重置、设备被禁用、EMQX 与 server 的内部 token 不一致。前三个现在能在 `conduit_mqtt_auth_total` 上直接分辨；第四个 server 返回 401，不计入这个指标，要看 EMQX 的日志。

---

## 十一、ProtocolAdapter：给其他协议留的口子

```java
public interface ProtocolAdapter {
    String name();
    /** 建立连接并开始接收，就绪（连接与订阅都成功）后才返回。 */
    void start(BooleanSupplier stillValid);
    /** 立即停止接收并断开，幂等；可与进行中的 start 并发调用，使其失败返回。 */
    void stop();
    boolean isConnected();
    /** 连接已断开且不会自行恢复（断线、会话被接管等），需由调用方 stop 后重新 start。 */
    boolean needsRestart();
}
```

接口见 [`ProtocolAdapter`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/adapter/ProtocolAdapter.java)，目前唯一的实现是 [`MqttProtocolAdapter`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/mqtt/MqttProtocolAdapter.java)。适配器要做的事只有一件：把某种协议收到的东西变成 `RawMessage` 交给 `MessageBus`。产品、设备、类型怎么从协议里取出来是适配器自己的事，payload 原样透传。

这个接口的形状是被主备切换逼出来的，不是凭空设计的：

- **`start` 要等到就绪才返回**：选主协调器需要知道「这个实例现在真的在收消息了」，健康检查的 `connected` 才有意义
- **`stillValid` 回调**：连接 Broker 可能要几秒，这期间实例可能已经丢了主身份。适配器在发出连接请求前和订阅前各问一次「我还是主吗」，不是就放弃，避免下台的实例晚到一步连上去，把新主实例的会话顶掉
- **`needsRestart` 而不是自动重连**：断线后要不要重连，取决于这个实例还是不是主，这个判断在协调器手里，适配器只负责报告

选主和会话接管的细节在 [可靠上报与接入层主备](./15_conduit_reliable_uplink)。要说明的是，「新增协议只需新增一个实现」目前还是设计意图：仓库里没有第二个实现来检验这个接口够不够用。HTTP 接入没有长连接，Modbus TCP 是平台主动轮询，它们的鉴权和在线状态都和 MQTT 不一样，本篇讲的回调、ACL、`$SYS` 事件都是 MQTT 这一种协议的做法。

---

## 十二、验证

| 结论 | 测试 / 报告 | 类型 |
|------|------------|------|
| 属性、事件、上下线四种 topic 解析正确，不合格的返回空 | [`TopicParserTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/mqtt/TopicParserTest.java) | 单元 |
| 盐是 32 位十六进制，哈希确定，不同盐结果不同，只有正确密钥匹配 | [`SecretHasherTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/security/SecretHasherTest.java) | 单元 |
| 正确密钥放行；错密钥、禁用设备、未知设备、clientId 不一致都拒绝 | [`MqttAuthIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthIT.java) | 集成（HTTP 接口） |
| transport 以超级用户放行，密码或 clientId 不对则拒绝 | [`MqttAuthIT#allowsTransportAsSuperuser`、`#deniesTransportWithWrongPasswordOrClientId`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthIT.java) | 集成 |
| 内部 token 缺失或错误返回 401 | [`MqttAuthIT#rejectsMissingOrWrongInternalToken`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthIT.java) | 集成 |
| 停用租户不等缓存过期就生效，启用后恢复 | [`MqttAuthIT#disablingATenantTakesEffectDespiteTheCacheAndEnablingRestoresIt`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthIT.java) | 集成 |
| 9 种结论各计入对应原因，启动即注册全部序列且初值为 0 | [`MqttAuthServiceTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthServiceTest.java) | 单元 |
| token 或 transport 密码为空时启动失败 | [`MqttAuthPropertiesTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/mqttauth/MqttAuthPropertiesTest.java) | 单元 |
| 身份缓存：回源并回填、命中不查库、不缓存空结果、损坏条目自动修复、批量读取失败降级查库 | [`DeviceIdentityLookupIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/device/DeviceIdentityLookupIT.java) | 集成（真实 Redis、PostgreSQL） |
| 旧事件不覆盖新状态；宽限期内的数据不复活设备，超过才复活；数据不推进 `since` | [`PresenceStoreIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/presence/PresenceStoreIT.java) | 集成（真实 Redis） |
| 晚到的断开事件不覆盖更新的连接事件（经过整条流水线） | [`PipelineIT#staleDisconnectDoesNotOverrideNewerConnect`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 计数与真实连接的结论一一对应，与 EMQX 的失败数一致 | [2026-10-30 MQTT 鉴权按原因计数](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-mqtt-auth-deny-reasons.md) | 测试报告（真实 EMQX） |
| 鉴权超时由虚拟化层丢包引起，不是连接半开 | [2026-10-30 鉴权回调排查](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-auth-timeout-investigation.md) | 排查报告（取证与对照实验） |

第一份报告自己写明了没做的事：改动之后 `MqttAuthIT` 没有重跑，理由是它只断言 HTTP 响应，而改动只加了计数器。测试报告把「没验证什么」和「验证了什么」写在一起，读的人才知道结论的边界在哪。

---

## 十三、已知限制

- **没有 TLS**。密钥在 CONNECT 报文里明文传输，同一网络里抓包就能拿到。接入指南写明只适合内网和演示环境；证书认证在路线图 V0.4，TLS 与 mTLS 在 V0.8
- **密钥是长期有效的静态凭据**。只有手动重置，没有定期轮换、过期和吊销列表
- **禁用设备不会断开它已有的连接**。鉴权只发生在连接那一刻，禁用后设备继续在线，它之后上报的数据进死信 `DEVICE_DISABLED`，直到它下次重连才被拒。停用租户同理，已连接设备的上报进 `TENANT_DISABLED`
- **鉴权没有限流**。同一台设备拿错密钥反复重连，每次都会打到 server；设备重连限速与退避在路线图 V0.3-E
- **租户停用时清缓存是尽力而为**。清 Redis 失败只记一条 WARN，此时要等最长 5 分钟缓存过期才生效
- **拒绝原因不返回给设备**。设备侧只能看到「未授权」，要定位得有平台侧的指标或日志权限
- **在线状态没有过期时间**。`conduit:presence` 不设 TTL，状态只在收到事件或数据时才变；断开事件如果没能送达（例如 EMQX 自身异常退出），设备会停留在「在线」，直到它下一次上下线
- **只支持设备直连**。网关代子设备认证和上下线在路线图 V0.4

---

## 小结

- topic 是 `conduit/{productKey}/{deviceKey}/up|down/...`，transport 不查库就能路由，ACL 只需按 clientId 约束一段；topic 里的 `productKey` 不可信，由流水线核对
- 设备密钥是平台生成的 32 位随机串，只在创建和重置时返回一次；库里存 SHA-256 加盐的哈希，不用 bcrypt 是为了重连风暴时鉴权不成为 CPU 瓶颈
- EMQX 每次连接同步回调 `/internal/mqtt/auth`，server 先用常量时间比较校验内部 token，再按固定顺序判定；拒绝也是 HTTP 200，原因不回给设备
- 设备身份在 Redis 缓存 5 分钟，状态变更、重置密钥、删除时主动清除，Redis 不可用时降级直查 PostgreSQL
- 拒绝原因按 `conduit.mqtt.auth{result, reason}` 计数，标签取值有限、启动即注册全部序列，上线当天就查出了模拟器与压测脚本争用设备密钥
- 鉴权超时从 5 秒放宽到 10 秒，起因是一次被误判为「连接半开」的虚拟化层丢包；server 不可用只影响新连接
- ACL 只有三行文件规则，依赖「clientId 等于用户名」；在线状态以 EMQX 事件为准、上报数据做补偿，用 `since` 和 10 秒宽限期处理乱序
- 当前没有 TLS、没有凭据轮换、禁用设备不踢连接，这些都在路线图里

## 参考资料

- Conduit 设备接入指南：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md)
- Conduit V0.1 设计文档：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md)
- EMQX 文档 · 使用 HTTP 服务进行密码认证：[https://docs.emqx.com/zh/emqx/latest/guides/access-control/authn/http.html](https://docs.emqx.com/zh/emqx/latest/guides/access-control/authn/http.html)
- EMQX 文档 · ACL 文件：[https://docs.emqx.com/zh/emqx/latest/guides/access-control/authz/file.html](https://docs.emqx.com/zh/emqx/latest/guides/access-control/authz/file.html)
- OWASP Password Storage Cheat Sheet：[https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

> 下一篇：[物模型与解码](./14_conduit_thing_model)

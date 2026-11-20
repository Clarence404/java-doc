---
description: IoT 威胁模型、一机一密与建连签名、X.509 与 mTLS、EMQX 认证与 ACL、安全审计、零信任、标准合规对照
---

# 设备安全

> 前置阅读：[HTTPS 与 TLS](/protocols/3_https_tls)、[零信任架构](/security/9_zero_trust)、[通信协议](../1_basics/1_protocol)

IoT 设备安全是从设备身份到数据的整套防护。本篇讲一机一密与 X.509、EMQX 认证与 Topic 授权、越权与暴力破解发现、零信任落地、标准与合规对照，基线为 EMQX 6.x（配置沿用 5.x 起的 HOCON 语法）。

---

## 一、IoT 安全的特殊性

### 1、与 Web 安全的差异

| 挑战 | 说明 | 带来的要求 |
|------|------|-----------|
| 设备资源受限 | MCU 内存、算力有限 | 优先 ECC（P-256）而不是 RSA；会话复用减少握手 |
| 数量庞大 | 几万到几百万台设备 | 凭证必须自动化签发、轮换、吊销 |
| 长期无人值守 | 部署后很难物理接触 | 漏洞修复依赖安全的 OTA |
| 物理可接触 | 设备可能被拆解、读 Flash | 私钥放安全芯片，关闭调试口 |
| 供应链长 | 芯片、模组、产线、代工厂 | 产线环节也要纳入信任链 |

### 2、常见攻击与防护

| 攻击 | 说明 | 防护 |
|------|------|------|
| 默认 / 弱口令 | 出厂统一密码被批量利用 | 一机一密，禁止共享凭证 |
| 暴露的调试接口 | 通过 UART / JTAG 读出固件和密钥 | 量产时熔断或禁用调试口，开启 Flash 读保护 |
| 中间人 | 劫持通信、篡改数据 | TLS + 设备校验服务端证书，必要时 mTLS |
| 重放 | 截获合法消息重复发送 | 消息带时间戳与 Nonce，服务端去重 |
| 越权订阅 | 设备订阅 `#` 或其他设备的 Topic | Topic 级 ACL，兜底拒绝 |
| 暴力破解 | 枚举设备凭证 | 认证失败审计与告警，按来源 IP 限速 |
| 连接风暴 | 大量设备同时重连，或攻击者批量建连，耗尽 Broker 与认证服务 | 监听器限制建连速率与单 IP 连接数；重连退避与容量规划见 [海量连接与连接风暴](./7_connection_storm) |
| 不安全的更新 | 固件被替换或回滚到有漏洞的旧版本 | 固件签名、防回滚、A/B 分区（见第五节） |

以上覆盖了 OWASP IoT Top 10 中最常见的几项；它与 ETSI EN 303 645、NIST IR 8259A、欧盟 CRA 的逐项对照，以及本篇没有覆盖的部分，见第八节。

---

## 二、设备身份与认证

下文 EMQX 配置均为 5.x 起的 HOCON 语法（`${clientid}` 占位符、API Key 调用 REST API），5.9+ 与 6.x 通用，4.x 的 `%c` / `%u` 写法与 `acl.conf` 旧格式不再适用。

### 1、认证方式对比

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| 用户名 / 密码（一机一密） | 每台设备唯一密钥，CONNECT 时携带 | 资源最受限的设备，必须配合 TLS |
| HMAC 签名 | 用设备密钥对设备标识与时间戳等内容签名作为密码，密钥不上网 | 公有云 IoT 平台常用，各家的拼法见本节第 3 小节 |
| JWT | 设备持有带 `exp` 的令牌，过期后重新获取 | 设备能定期访问令牌服务的场景 |
| HTTP 认证服务 | EMQX 把凭证转发给业务服务判定 | 设备台账在业务系统中，需要自定义逻辑 |
| X.509 证书（mTLS） | 设备持有客户端证书，TLS 握手时校验 | 工业、能源、车联网等高安全要求场景 |
| TLS-PSK / DTLS-PSK | 双方预共享对称密钥完成 TLS / DTLS 握手 | 不便处理证书的 CoAP 等低功耗设备 |

### 2、一机一密与一型一密

**一机一密**：每台设备出厂烧录唯一的 DeviceSecret 或证书，单台泄露只影响这一台，可以单独禁用或吊销。本篇后面的认证、ACL 与审计都以它为前提。

**一型一密**：同型号共用一份产品级凭据，设备首次上线时用它换取本机凭据（动态注册），解决的是产线无法逐台烧录的问题；动态注册有哪些形态、注册接口怎么防伪造、换到本机凭据后产品级凭据怎么处置，见 [设备注册与生命周期](./2_provisioning)。

### 3、HMAC 签名 + EMQX HTTP 认证

设备不直接发送 DeviceSecret，而是发送签名，签名中带时间戳以限制重放窗口。MQTT 没有规定签名怎么放进 CONNECT，每个平台各有一套拼法；下面三个字段是**本模块的示例约定**，不是哪家平台的格式：

| CONNECT 字段 | 取值 |
|--------------|------|
| clientid | `dev001`（设备 ID） |
| username | `dev001&1767225600000`（设备 ID + 毫秒时间戳） |
| password | `HMAC-SHA256(DeviceSecret, "clientId=dev001&ts=1767225600000")` 的十六进制 |

主流平台的做法对照如下，接哪家就按哪家的格式，思路都是「密钥不上网，只传由它算出来的东西」：

| 平台 | clientId | username | password | 时间 |
|------|----------|----------|----------|------|
| 本篇示例 | 设备 ID | `设备 ID&毫秒时间戳` | HMAC-SHA256，密钥为 DeviceSecret，原文 `clientId=…&ts=…`，十六进制 | 必带，服务端校验前后 5 分钟 |
| 阿里云物联网平台 | `自定义 ID\|securemode=3,signmethod=hmacsha1,timestamp=…\|`，竖线之间是扩展参数：`securemode` 2 为 TLS 直连、3 为 TCP 直连，`signmethod` 可选 hmacmd5 / hmacsha1 / hmacsha256 | `deviceName&productKey` | 以 deviceSecret 为密钥做 HMAC；原文是 clientId、deviceName、productKey、timestamp 按参数名字典序依次拼接「参数名 + 值」，如 `clientId12345deviceNamedeviceproductKeypktimestamp789` | `timestamp` 可以不传 |
| 华为云 IoTDA | `设备 ID_0_签名类型_时间戳`，时间戳是 UTC 的 `YYYYMMDDHH`；签名类型 0 不校验时间戳、1 校验 | 设备 ID | HMAC-SHA256，**以时间戳为密钥、设备密钥为内容** | 必带（精确到小时），是否校验由签名类型决定 |
| Azure IoT Hub | 设备 ID | `{IoT Hub 主机名}/{设备 ID}/?api-version=2021-04-12` | SAS 令牌：`SharedAccessSignature sig={签名}&se={过期时间}&sr={资源 URI}` | 没有时间窗，令牌自带过期时间 `se` |
| AWS IoT Core | — | — | 不用设备密钥签名：设备通常用 X.509 客户端证书；要沿用用户名密码或自定义令牌时，接自定义授权方（Lambda） | — |

本篇示例与它们的差异有两处：时间戳放在 username 里而不是 clientId 里，这样 clientId 就等于设备 ID，ACL 的 `${clientid}` 可以直接用；时间窗是强制的。**强制时间窗的前提是设备有可靠时钟**——没有 RTC、每次上电都要先联网对时的设备，建连时的时间可能还是出厂值，所以阿里云的 timestamp 允许不传，华为云留了不校验时间戳的类型 0。设备做不到先对时（NTP、基站授时）就不要强制时间窗，改由服务端下发随机数做挑战应答（写法见 [Netty 接入网关 · 鉴权](./6_netty_gateway#_2、鉴权-第一帧必须是-auth)），或直接用证书。

EMQX 认证链配置一个 HTTP 认证器，把凭证转给设备台账服务判定。配置了认证器后，未通过认证的客户端会被拒绝，不再需要单独的「禁止匿名」开关：

```hocon
authentication = [
  {
    mechanism = password_based
    backend = http
    method = post
    url = "http://device-registry:8080/emqx/authn"
    body {
      clientid = "${clientid}"
      username = "${username}"
      password = "${password}"
      peerhost = "${peerhost}"
    }
    headers { "Content-Type" = "application/json" }
  }
]
```

台账服务返回 `{"result": "allow" | "deny" | "ignore"}`；返回 4xx / 5xx 时 EMQX 视为 `ignore`，继续走认证链中的下一个认证器，全部都没通过则拒绝连接。

```java
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.web.bind.annotation.*;

// 以下三个类型分属不同文件
public record AuthnRequest(String clientid, String username, String password, String peerhost) {}

public record AuthnResult(String result, @JsonProperty("is_superuser") boolean superuser) {
    static AuthnResult allow() { return new AuthnResult("allow", false); }
    static AuthnResult deny()  { return new AuthnResult("deny", false); }
}

@RestController
public class EmqxAuthnController {

    private static final long MAX_SKEW_MS = Duration.ofMinutes(5).toMillis();
    private final DeviceSecretStore secrets;   // 设备台账：按设备 ID 取出解密后的 DeviceSecret
    private final Clock clock;

    public EmqxAuthnController(DeviceSecretStore secrets, Clock clock) {
        this.secrets = secrets;
        this.clock = clock;
    }

    @PostMapping("/emqx/authn")
    public AuthnResult authenticate(@RequestBody AuthnRequest req) throws GeneralSecurityException {
        String[] parts = req.username() == null ? new String[0] : req.username().split("&", 2);
        // username 中的设备 ID 必须等于 clientid，否则 ACL 中的 ${clientid} 可以被随意指定
        if (parts.length != 2 || !parts[0].equals(req.clientid())) {
            return AuthnResult.deny();
        }
        long ts;
        byte[] actual;
        try {
            ts = Long.parseLong(parts[1]);
            actual = HexFormat.of().parseHex(req.password());
        } catch (IllegalArgumentException | NullPointerException e) {
            return AuthnResult.deny();
        }
        if (Math.abs(clock.millis() - ts) > MAX_SKEW_MS) {
            return AuthnResult.deny();                       // 时间戳过旧，疑似重放
        }
        byte[] secret = secrets.find(req.clientid()).orElse(null);
        if (secret == null) {
            return AuthnResult.deny();
        }
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        byte[] expected = mac.doFinal(("clientId=" + req.clientid() + "&ts=" + ts)
                .getBytes(StandardCharsets.UTF_8));
        return MessageDigest.isEqual(expected, actual) ? AuthnResult.allow() : AuthnResult.deny();
    }
}
```

- **DeviceSecret 的存储**：HMAC 需要原始密钥，不能像用户密码那样只存哈希；台账中用 KMS 托管的密钥加密存储
- **clientid 绑定身份**：ACL 依赖 `${clientid}`，如果认证不校验 clientid，设备可以自报别人的 ID；在 EMQX 6.3 之前还可以用 `+` 之类的字符当 clientid，让 `devices/${clientid}/cmd` 变成通配订阅（6.3 起默认拦截，见第四节第 3 小节）
- **容量**：每次连接都会调用该服务，设备批量重连时它最先被打满，认证一慢，设备超时重试又会放大流量；峰值怎么估、怎么限流与缓存见 [海量连接与连接风暴](./7_connection_storm)
- **响应里还能带权限与过期时间**：`client_attrs`、`expire_at`、`acl` 三个可选字段见本节第 6 小节
- **另一种取舍：传密钥、只存哈希**：设备把密钥本身放在 password 里（必须走 TLS），服务端就不需要原始密钥，台账可以只存加盐哈希，库泄露后拿不到可用的凭据；代价是密钥每次连接都出现在链路上。HMAC 方案正好反过来：密钥不上网，但台账必须可逆存储。配套仓库 Conduit 选的是前一种（它当前还没有启用 TLS，这一点写在它的已知限制里），哈希算法怎么选、身份怎么缓存见 [设备接入与鉴权 · 设备凭据](../4_practice/1_access#三、设备凭据-生成与哈希) 与 [身份缓存](../4_practice/1_access#五、身份缓存)

### 4、X.509 证书签发

证书认证的核心原则是**私钥在哪里生成，就只待在哪里**：设备在安全芯片内生成密钥对，只把 CSR 交给 CA 签名；平台不生成、也不下发设备私钥。

![设备证书签发与接入](../../assets/iot/iot-cert-provisioning.svg)

下面的 openssl 命令演示整个过程。生产中根 CA 离线保管，用中间 CA 签发设备证书，CA 私钥放在 HSM / KMS 中，绝不能放在跑批量脚本的机器上：

```bash
# 1) 设备 CA（演示用）：ECDSA P-256
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -new -x509 -days 3650 -key ca.key -out ca.pem \
  -subj "/O=MyCompany/CN=IoT-Device-CA"

# 2) 设备侧：生成密钥与 CSR（理想情况下在安全芯片内完成，私钥不导出）
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out dev001.key
openssl req -new -key dev001.key -out dev001.csr -subj "/O=MyCompany/CN=dev001"

# 3) CA 签发：限定为客户端认证用途，并写入 CRL 分发点
cat > device-ext.cnf <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
crlDistributionPoints = URI:http://pki.example.com/device-ca.crl
EOF
openssl x509 -req -days 730 -sha256 -in dev001.csr \
  -CA ca.pem -CAkey ca.key -CAcreateserial \
  -extfile device-ext.cnf -out dev001.pem

openssl verify -CAfile ca.pem dev001.pem
```

- **选 P-256 而不是 RSA 2048**：密钥和签名更短，MCU 上握手更快、占用内存更少
- **`extendedKeyUsage = clientAuth`**：部分 Broker 和 TLS 库会校验用途，缺少时握手失败；同时防止设备证书被拿去当服务端证书
- **CN 填设备 ID**：Broker 可以直接从证书中取出设备身份（见第三节）

设备端需要保存的内容：

| 内容 | 作用 | 保密性 |
|------|------|--------|
| CA 证书（信任锚） | 校验 Broker 的服务端证书 | 公开，但要防篡改 |
| 设备证书 | TLS 握手时出示给 Broker | 公开 |
| 设备私钥 | TLS 握手时签名 | 只存在于安全芯片（SE / TPM）或加密存储区，不可导出 |

产线上记录「设备序列号 ↔ 证书序列号」的对应关系，后续吊销、换证都靠它。

### 5、证书轮换与吊销

- **有效期**：设备证书 1–2 年；到期前由平台下发「换证」指令
- **换证流程**：设备在本地生成新密钥对，通过当前有效的 TLS 连接提交新 CSR（可采用 EST，RFC 7030），拿到新证书后切换；整个过程私钥不离开设备
- **吊销先靠台账**：设备报废或疑似泄露时，第一步是在设备台账里禁用这台设备并踢掉在线连接，认证服务此后对它一律返回 `deny`。这也是主流平台的做法：Azure IoT Hub 的文档写明它认证设备时不检查 CA 的证书吊销列表，证书可能泄露时的处置就是在身份注册表里禁用设备。禁用、踢线与设备的整个生命周期见 [设备注册与生命周期](./2_provisioning)
- **CRL 是第二道**：把证书加入 CRL 后，EMQX 开启 `enable_crl_check` 的监听器会在 TLS 握手阶段拒绝它。限制有四条：只有 `ssl` 类型的监听器支持，`wss` 与 QUIC 监听器不支持；要求 `verify = verify_peer`；CRL 地址取自设备证书里的分发点，CRL 自身要带 Issuing Distribution Point 扩展；EMQX 把取到的 CRL 缓存在本地，默认每 15 分钟刷新一次，所以吊销不是立刻生效，而且检查只发生在握手时，已经连着的设备要靠踢线断开
- **CA 轮换**：设备内预置新旧两个 CA 证书，先下发新 CA，再逐步换签设备证书

### 6、HTTP 认证响应的进阶字段

第 3 小节的台账服务只返回了 `result`。EMQX 的 HTTP 认证器还认三个可选字段，认证的同时把「这台设备是谁、能干什么、凭证到什么时候」一并交给 Broker：

```json
{
  "result": "allow",
  "is_superuser": false,
  "client_attrs": {"role": "gateway", "productKey": "pk-meter"},
  "expire_at": 1767229200,
  "acl": [
    {"permission": "allow", "action": "publish", "topic": "gateways/${clientid}/telemetry", "qos": [1]}
  ]
}
```

| 字段 | 起始版本 | 作用 |
|------|---------|------|
| `client_attrs` | 5.7 | 给这条连接打上键值对属性（键和值都必须是字符串），连接结束即清除；ACL 里可以用 `${client_attrs.名字}` 当 Topic 占位符，也可以用 `{client_attr, "名字", "值"}` 当匹配条件 |
| `expire_at` | 5.8 | 认证有效期的截止时间（Unix 秒）；到点后 EMQX 断开连接，设备重连时重新认证，作用与 JWT 的 `exp` 相同 |
| `acl` | 5.8 | 随认证结果下发的权限规则，检查顺序排在所有授权数据源之前；没有命中时继续走第四节的 `authorization.sources` |

`client_attrs` 的用处是做**产品或租户维度**的 ACL：`${clientid}` 只能把设备锁在自己的 Topic 里，Topic 里还带产品、租户这类层级时，由台账服务在认证时返回 `productKey`、`tenantId`，规则写成 `up/${client_attrs.productKey}/${clientid}/#`，一条规则管住所有产品。属性也可以不经认证服务，用 `mqtt.client_attrs_init` 从 clientid、username 或证书字段里截取；两处同名时以认证器返回的为准。第四节第 3 小节用它区分普通设备与网关。

---

## 三、传输加密

所有设备流量只走 TLS（MQTT 8883 端口）；CoAP 等基于 UDP 的协议用 DTLS。握手、前向保密与证书链校验的原理见 [HTTPS 与 TLS](/protocols/3_https_tls)。

EMQX 开启强制双向认证时，`verify = verify_peer` 只表示「请求并校验客户端证书」，客户端不出示证书时仍可连接；必须同时设置 `fail_if_no_peer_cert = true`：

```hocon
listeners.ssl.default {
  bind = "0.0.0.0:8883"
  ssl_options {
    cacertfile = "etc/certs/device-ca.pem"   # 只信任设备 CA，不要用系统公共 CA 包
    certfile   = "etc/certs/server.pem"
    keyfile    = "etc/certs/server.key"
    versions   = ["tlsv1.3", "tlsv1.2"]
    verify     = verify_peer
    fail_if_no_peer_cert = true
    enable_crl_check     = true
  }
}

# 关闭明文 1883 监听器
listeners.tcp.default.enable = false

# 用证书 CN 作为 clientid / username，设备无法自报他人身份
mqtt {
  peer_cert_as_clientid = cn
  peer_cert_as_username = cn
}
```

- **`peer_cert_as_*` 必须配合强制 mTLS**：否则客户端可以出示任意自签名证书，填任意 CN
- **CN 必须唯一**：两台设备 CN 相同会因 clientid 冲突互相踢下线
- **资源受限设备**：TLS 1.3 + ECDHE-ECDSA 套件，开启会话复用，减少每次重连的完整握手

---

## 四、Topic 授权（EMQX ACL）

### 1、认证与授权的分工

| 层 | 回答的问题 | EMQX 配置 |
|----|-----------|----------|
| 认证（authentication） | 你是谁、能不能连上来 | `authentication` 认证链；配置后未认证的客户端直接被拒绝 |
| 授权（authorization） | 你能发布 / 订阅哪些 Topic | `authorization.sources` 按顺序匹配，都不命中时按 `no_match` 处理 |

拒绝匿名连接是认证层的事；授权层做 Topic 粒度的最小权限，并用 `no_match = deny` 兜底。

### 2、授权配置

```hocon
authorization {
  no_match    = deny          # 没有规则命中时拒绝（6.0 起默认即为 deny）
  deny_action = disconnect    # 越权时断开连接；默认 ignore 只丢弃该操作
  cache { enable = true, max_size = 32, ttl = 1m }
  sources = [
    { type = file, enable = true, path = "etc/acl.conf" }
    { type = built_in_database, enable = true }
  ]
}
```

`deny_action` 是一个取舍：`disconnect` 让越权的设备立刻掉线，问题暴露得早，但固件把 Topic 写错时会变成反复重连；默认的 `ignore` 只丢弃越权的那一次操作、连接保留，越权要靠第六节的授权事件才看得见。

`sources` 按顺序检查，第一个给出结果的数据源生效。授权结果有缓存，修改规则后最长要等一个 `ttl` 才对已连接的客户端生效。除文件和内置数据库外，EMQX 内置 MySQL、PostgreSQL、MongoDB、Redis、LDAP、HTTP 数据源，规则量大或要和业务系统打通时直接配置，不需要插件。

### 3、文件规则（acl.conf）

```erlang
%% EMQX 5.x acl.conf：自上而下匹配，第一条命中的规则生效

%% 1. 任何客户端都不能订阅全量通配和系统主题（{eq, ...} 表示按字面匹配，不展开通配符）
{deny, all, subscribe, ["$SYS/#", {eq, "#"}, {eq, "+/#"}]}.

%% 2. 平台服务：订阅所有设备的上报、在线状态、指令响应、OTA 进度、影子请求和网关代报与应答，
%%    向任意设备下发指令、OTA 任务和影子响应，向任意网关下发子设备指令
{allow, {username, "iot-backend"}, subscribe,
 ["devices/+/telemetry", "devices/+/event", "devices/+/status", "devices/+/response",
  "devices/+/ota/status", "devices/+/shadow/update", "devices/+/shadow/get",
  "gateways/+/connect", "gateways/+/disconnect", "gateways/+/telemetry", "gateways/+/status",
  "gateways/+/response"]}.
{allow, {username, "iot-backend"}, publish,
 ["devices/+/cmd", "devices/+/ota/cmd", "gateways/+/cmd",
  "devices/+/shadow/update/accepted", "devices/+/shadow/update/rejected",
  "devices/+/shadow/update/delta", "devices/+/shadow/update/documents",
  "devices/+/shadow/get/accepted", "devices/+/shadow/get/rejected"]}.

%% 3. 应用侧服务（用户名以 app- 开头）：只读影子的变更文档
{allow, {username, {re, "^app-"}}, subscribe, ["devices/+/shadow/update/documents"]}.

%% 4. 设备：只能发布自己的上报、在线状态（含遗嘱）、指令响应、OTA 进度和影子请求，
%%    只能订阅自己的指令、OTA 任务和影子响应
{allow, all, publish,
 ["devices/${clientid}/telemetry", "devices/${clientid}/event", "devices/${clientid}/status",
  "devices/${clientid}/response", "devices/${clientid}/ota/status",
  "devices/${clientid}/shadow/update", "devices/${clientid}/shadow/get"]}.
{allow, all, subscribe,
 ["devices/${clientid}/cmd", "devices/${clientid}/ota/cmd",
  "devices/${clientid}/shadow/update/accepted", "devices/${clientid}/shadow/update/rejected",
  "devices/${clientid}/shadow/update/delta",
  "devices/${clientid}/shadow/get/accepted", "devices/${clientid}/shadow/get/rejected"]}.

%% 5. 网关与采集器（认证服务返回 client_attrs.role = "gateway" 的连接）：在自己的 gateways/ 前缀下
%%    声明子设备上下线、按子设备分组代报遥测、发布自身在线状态与子设备指令的应答，订阅发给子设备的指令
{allow, {client_attr, "role", "gateway"}, publish,
 ["gateways/${clientid}/connect", "gateways/${clientid}/disconnect",
  "gateways/${clientid}/telemetry", "gateways/${clientid}/status", "gateways/${clientid}/response"]}.
{allow, {client_attr, "role", "gateway"}, subscribe, ["gateways/${clientid}/cmd"]}.

%% 6. 文件后面还有其他数据源（这里是内置数据库）时，末尾不写 {deny, all}：它会让文件对所有请求
%%    都给出结果，排在后面的数据源永远查不到；其余请求交给 no_match = deny 拒绝
```

- **Topic 与全模块约定一致**：`devices/…` 各 Topic 见 [通信协议 · Topic 约定](../1_basics/1_protocol#_7、topic-约定)；影子的 Topic 与语义见 [设备影子](../3_platform/3_device_shadow)，`update/documents` 带变更前后的完整文档，是给应用侧看的，设备不订阅；指令与应答（`cmd` / `response`）见 [指令下发与服务调用](../3_platform/4_command)
- **占位符**：5.x 用 `${clientid}`、`${username}`、`${client_attrs.名字}`，4.x 的 `%c`、`%u` 不再生效
- **占位符的值不能带 `/`、`+`、`#`（6.3 起）**：EMQX 6.3 开始校验代入 Topic 模板的值，默认不允许出现这三个字符，由 `authorization.topic_template_allow` 的 `slash`、`plus`、`hash` 三个开关控制，默认都是 `false`。渲染失败的那条 Topic 过滤器，在 `legacy` 安全档下被跳过、继续匹配后面的规则，在 `hardened` 安全档下直接拒绝这次操作。clientid 里本来就带 `/` 的存量设备（如 `tenant-a/dev001`）升级到 6.3 后会匹配不上原来的规则，升级前要先排查；只有确实需要时才打开对应开关
- **匹配条件**：`{username, "..."}`、`{clientid, "..."}`、`{client_attr, "名字", "值"}`、`{ipaddr, "10.0.0.0/8"}`，前三个的值都支持正则，如 `{username, {re, "^svc-"}}`；多个条件用 `{'and', [...]}`、`{'or', [...]}` 组合
- **按 username 授权的前提**：username 必须经过认证；只用证书认证时，用上文的 `peer_cert_as_username = cn` 让 username 也来自证书，否则任何设备都能自称 `iot-backend`
- **通过 Dashboard 或 REST API 改过文件规则后**，EMQX 会把规则保存到 `data/authz/acl.conf`，不再读取 `path` 指向的原文件
- **只有文件一个数据源时**，末尾写 `{deny, all}` 与靠 `no_match = deny` 兜底效果相同，写不写都行。配套仓库 Conduit 就是这种情况：规则只有三行并以 `{deny, all}` 结尾，`deny_action` 用默认的 `ignore`，见 [设备接入与鉴权 · ACL](../4_practice/1_access#八、acl-把设备锁在自己的-topic-里)

### 4、内置数据库与 REST API

设备上线、下线频繁变化的规则放在内置数据库，通过 REST API 增删。REST API 使用 API Key 认证：在 Dashboard「系统设置 → API 密钥」创建（或用 `api_key.bootstrap_file` 在启动时导入），以 HTTP Basic 方式携带；Dashboard 的登录用户名和密码不能直接用于 Basic 认证。

```bash
# 为 dev001 写入规则：请求体是数组，可一次提交多台设备
curl -X POST "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients" \
  -u "${EMQX_API_KEY}:${EMQX_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "clientid": "dev001",
      "rules": [
        {"action": "publish",   "permission": "allow", "topic": "devices/dev001/telemetry"},
        {"action": "subscribe", "permission": "allow", "topic": "devices/dev001/cmd"}
      ]
    }
  ]'

# 查询、删除单台设备的规则
curl -u "${EMQX_API_KEY}:${EMQX_API_SECRET}" \
  "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients/dev001"
curl -X DELETE -u "${EMQX_API_KEY}:${EMQX_API_SECRET}" \
  "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients/dev001"
```

API Key 按最小权限分配角色，密钥放在密钥管理系统中；18083 管理端口只对内网开放。

### 5、网关与采集器：一条连接代多台设备

第 3 小节的设备规则有一个前提：一条连接只代表一台设备，Topic 里的设备 ID 等于 `clientid`。[Modbus 采集](./4_modbus) 的采集服务、边缘网关不满足这个前提——它们用一条连接替几十上百台不会说 MQTT 的子设备上报，往 `devices/{子设备 ID}/telemetry` 发布会被 `no_match = deny` 拒掉。给它们放开 `devices/+/telemetry` 等于让一个网关能冒充全平台任何设备，所以另开 `gateways/` 前缀（规则 5）：

| Topic | 载荷 | 用途 |
|-------|------|------|
| `gateways/{gatewayId}/connect`、`…/disconnect` | `{"device": "子设备 ID"}` | 声明某台子设备经本网关上线、下线 |
| `gateways/{gatewayId}/telemetry` | `{"子设备 ID": [{"ts": 1767225600000, "values": {"temperature": 25.3}}]}` | 按子设备分组代报遥测 |
| `gateways/{gatewayId}/status` | `{"online": true}` | 网关自身的在线状态，同时是遗嘱 Topic |
| `gateways/{gatewayId}/cmd`、`…/response` | 指令与应答的标准形状加 `{"device": "子设备 ID"}` | 平台把发给子设备的指令改投到网关，网关订阅 `cmd`、发布 `response` |

ACL 在这里只能做到一半：`gateways/${clientid}/…` 保证网关只能写自己的前缀，但载荷里写的是哪台子设备，Broker 不看也管不了。剩下的一半由平台在拆包时补上：本模块采用「信任网关」模型，只认证网关，子设备 ID 由网关在载荷里声明，平台核对这台子设备确实绑定在这个网关名下才接受，否则丢弃并记安全事件；另一种是子设备自带凭据、网关只做转发。两种信任模型的对照与取舍见 [网关与子设备 · 两种信任模型](./5_gateway_subdevice#_2、两种信任模型)。

无论哪种模型，都要把网关当成比普通设备权限更大的账号来管：`role = "gateway"` 只能由台账服务按设备类型返回，不能由设备自报；网关的凭据优先用证书，上下线与越权事件单独配告警。拓扑关系怎么登记、子设备的上下线与指令怎么经网关转发、主流平台的网关模型对照，也在那一篇。自研接入网关节点之间的内部下行通道 `gateways/{nodeId}/downlink`（见 [Netty 接入网关](./6_netty_gateway)）同理，给节点账号单独授订阅权限，不与设备共用规则。

---

## 五、OTA 与固件安全

OTA 既是修复漏洞的唯一通道，也是最危险的攻击入口：攻击者一旦能推送固件，就等于拿到了全部设备。安全的 OTA 至少包括四件事：发布方用私钥对固件的 SHA-256 摘要做 ECDSA 或 Ed25519 签名，设备用内置公钥验签（MD5 既不是签名，也不抗碰撞，不能用来防篡改）；设备记录单调递增的安全版本号，拒绝安装更低版本，防止回滚到有漏洞的旧固件；A/B 双分区写入新固件，启动失败自动回退；配合安全启动（Secure Boot），保证每次上电运行的都是验签通过的固件。任务编排、灰度与断点续传等实现细节见 [OTA 升级](../3_platform/5_ota)。

---

## 六、审计与零信任落地

### 1、安全事件采集

EMQX 的审计日志（`log.audit`）记录的是 Dashboard、REST API、CLI 上的**管理操作**，不记录设备的连接与认证。设备侧的安全事件用规则引擎订阅内置事件，再转发到 Kafka / HTTP，最终进入 SIEM：

| 事件 Topic | 用途 | 关键字段 |
|------------|------|---------|
| `$events/client/connected` | 设备上线，记录来源 IP | `clientid`、`username`、`peername` |
| `$events/client/disconnected` | 设备下线及原因 | `reason` |
| `$events/client/connack` | 连接被拒（认证失败等） | `reason_code`、`peername` |
| `$events/auth/check_authn_complete` | 认证结果 | `reason_code` |
| `$events/auth/check_authz_complete` | 授权结果，`result = deny` 即越权尝试 | `result`、`topic`、`action`、`peerhost` |

```sql
-- 越权尝试：转发到安全事件 Topic，按 clientid / peerhost 聚合告警
SELECT clientid, username, peerhost, topic, action, result, timestamp
FROM "$events/auth/check_authz_complete"
WHERE result = 'deny'
```

上下线事件除了用于审计，也是维护设备在线状态的一种来源，几种做法的对照见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。

典型告警规则：同一来源 IP 短时间大量认证失败（暴力破解）、单台设备反复越权（固件被篡改或配置错误）、设备从未出现过的地区上线（凭证外泄）。

### 2、零信任措施

零信任的通用原则见 [零信任架构](/security/9_zero_trust)，落到 IoT 是下面几项：

| 原则 | IoT 中的做法 |
|------|-------------|
| 每个设备独立身份 | 一机一密或设备证书，禁止同型号共用凭证 |
| 最小权限 | ACL 只放行 `devices/${clientid}/...`，网关只放行 `gateways/${clientid}/...`，后台服务按职责拆分账号 |
| 持续验证 | JWT 带 `exp`（HTTP 认证用响应里的 `expire_at`），EMQX 默认在令牌过期后断开连接（`disconnect_after_expire`），设备重连时重新认证；有效期要加随机抖动，否则同一批签发的令牌同时过期，等于自己制造一次连接风暴，见 [海量连接与连接风暴](./7_connection_storm) |
| 微隔离 | 按区域划分设备网段，网关作为唯一出口，Broker 不直接暴露在公网 |
| 全程可观测 | 认证、授权、上下线事件全部进入 SIEM |

网络微分段的典型做法：

![IoT 网络微分段](../../assets/iot/iot-network-segmentation.svg)

- 不同车间的设备网段之间默认拒绝互访，一台设备被攻破不会横向扩散
- 边缘网关是区域唯一出口，统一管理本区域设备的认证和流量
- 负载均衡只放行 8883，EMQX 集群不直接暴露在公网；Dashboard 与 REST API 端口只在管理网可达

---

## 七、安全检查清单

| 阶段 | 措施 |
|------|------|
| 一、基础 | 只开放 8883，关闭 1883；配置认证器，拒绝未认证连接；每台设备独立凭证 |
| 二、权限 | 部署 ACL，设备只能访问自己的 Topic，网关与采集器只能用自己的 `gateways/` 前缀；`no_match = deny` 兜底，文件之后还有其他数据源时文件规则末尾不写 `{deny, all}`；API Key 最小权限 |
| 三、设备 | 私钥放安全芯片；量产禁用 UART / JTAG；删除测试账号与默认口令 |
| 四、固件 | OTA 签名验签、防回滚、A/B 分区、安全启动 |
| 五、隔离 | 设备网段微分段，管理端口只对内网开放 |
| 六、持续 | 证书 / 令牌定期轮换；吊销先在台账禁用并踢线，再配 CRL；认证与越权事件接入 SIEM 并配置告警 |
| 七、合规 | 公开漏洞报告渠道，写明支持期限，固件带 SBOM，退役时擦除数据（见第八节） |

---

## 八、标准与合规对照

前面七节按「怎么做」组织，这一节换成「标准要求了什么」来核对。常被引用的是下面四份：

| 标准 | 发布方与版本 | 管什么 |
|------|-------------|--------|
| OWASP IoT Top 10 | OWASP，2018 版 | 十类最常见的 IoT 风险（I1–I10），适合当自查清单 |
| ETSI EN 303 645 | ETSI，V3.1.3（2024-09） | 消费类 IoT 的安全基线：5.1–5.13 共 13 组条款，加第 6 章数据保护条款 |
| NIST IR 8259A | NIST，2020-05 | 设备应具备的 6 项网络安全能力：设备标识、设备配置、数据保护、接口的逻辑访问、软件更新、安全状态感知 |
| 欧盟 Cyber Resilience Act（CRA） | 条例 (EU) 2024/2847，2024-12-10 生效；漏洞报告义务自 2026-09-11 起适用，其余主要义务自 2027-12-11 起适用 | 在欧盟销售的带数字元素产品的强制要求：附件一第一部分是产品的安全属性，第二部分是漏洞处理，附件二是必须告知用户的信息 |

逐项对到本篇：

| 要求 | 出处 | 本篇 |
|------|------|------|
| 不用通用默认口令，每台设备唯一身份 | OWASP I1；EN 303 645 5.1；IR 8259A 设备标识 | 已覆盖：第二节 |
| 通信加密 | OWASP I7；EN 303 645 5.5；IR 8259A 数据保护 | 已覆盖：第三节 |
| 减少暴露面，接口只对授权方开放 | OWASP I2、I3、I9；EN 303 645 5.6；IR 8259A 接口的逻辑访问 | 已覆盖：第四节 ACL、第六节微分段、调试口禁用 |
| 安全更新与软件完整性 | OWASP I4；EN 303 645 5.3、5.7；IR 8259A 软件更新 | 已覆盖：第五节与 OTA 篇 |
| 敏感参数安全存储、物理加固 | OWASP I10；EN 303 645 5.4 | 已覆盖：私钥放安全芯片、Flash 读保护 |
| 检查遥测数据，掌握安全状态 | EN 303 645 5.10；IR 8259A 安全状态感知 | 已覆盖：第六节 |
| 设备管理（资产、配置、退役） | OWASP I8；IR 8259A 设备配置 | 部分覆盖：台账与生命周期在 [设备注册与生命周期](./2_provisioning) |
| 漏洞报告渠道与响应 | EN 303 645 5.2；CRA 附件一第二部分 | 未覆盖，见下 |
| 明示支持期限 | EN 303 645 5.3；CRA 附件二 | 未覆盖，见下 |
| 第三方组件与 SBOM | OWASP I5；CRA 附件一第二部分 | 未覆盖，见下 |
| 个人数据保护与退役擦除 | OWASP I6；EN 303 645 5.8、5.11、第 6 章；CRA 附件一第一部分 | 未覆盖，见下 |

没有覆盖的四项大多不是接入层的技术问题，但产品要出海或过认证时绕不开：

- **漏洞报告渠道与响应**：EN 303 645 的 5.2-1 要求厂商公开漏洞披露政策，至少写明报告问题的联系方式、多久确认收到、多久同步一次处理进展。CRA 附件一第二部分同样要求制定并执行协调漏洞披露政策、提供接收漏洞报告的联系地址；自 2026-09-11 起，制造商发现产品中被积极利用的漏洞还必须上报。落地上至少要有一个公开的安全邮箱或页面、内部的分级与修复时限，以及能把修复推到设备上的 OTA
- **明示支持期限**：EN 303 645 的 5.3-13 要求以用户看得懂的方式公布软件更新的支持期；CRA 附件二要求告知用户支持期的截止日期，条例序言第 60 段给的尺度是支持期不少于五年，产品预期使用时间更短的除外。支持期一旦公布就是承诺：期内的设备型号都要留着能编译、能签名、能灰度的固件流水线
- **第三方组件与 SBOM**：OWASP I5 针对的是使用不安全或过时的组件；CRA 附件一第二部分的第一条就是以通用的机器可读格式编制软件物料清单（SBOM）。做法是固件构建时生成 SBOM（SPDX、CycloneDX 是两种常见格式），随版本归档，漏洞库更新时拿它反查哪些在网版本受影响
- **个人数据与退役擦除**：EN 303 645 的 5.11-1 要求用户能用简单的方式擦除设备上的全部用户数据，5.11-2 建议关联的云端服务也能删除个人数据；CRA 附件一第一部分要求用户能安全、方便、永久地清除全部数据和设置。对应到实现：恢复出厂时清掉凭据、Wi-Fi 配置与本地缓存；平台侧注销设备时禁用凭据，并按约定删除或匿名化它的遥测与影子

条款编号以各标准的现行版本为准，原文链接见文末参考资料。

---

## 小结

- IoT 安全的难点在规模、物理可接触和长期无人值守，凭证必须一机一密、可自动轮换和吊销
- 密码类方案用 HMAC 签名 + 时间戳，DeviceSecret 不上网；签名怎么放进 CONNECT 各平台不同，本篇的拼法只是示例约定；强制时间窗要求设备有可靠时钟；认证服务要校验 clientid 与设备身份一致
- 证书方案选 ECDSA P-256，私钥在设备内生成、永不离开设备；EMQX 用 `verify_peer` + `fail_if_no_peer_cert = true` 强制 mTLS，用 `peer_cert_as_clientid = cn` 绑定身份；吊销先在台账禁用并踢线，CRL 只有 `ssl` 监听器支持、有缓存延迟
- EMQX 5.x 授权用 `${clientid}` 占位符、`{eq, ...}` 字面匹配，`no_match = deny` 兜底（文件之后还有其他数据源时，文件规则末尾不写 `{deny, all}`，否则后面的数据源查不到）；6.3 起占位符的值默认不能带 `/`、`+`、`#`；REST API 用 API Key，请求体是数组
- 一条连接代多台设备的网关与采集器走 `gateways/${clientid}/…`，ACL 只能把网关锁在自己的前缀里，子设备归属要由平台按拓扑关系核对
- OTA 要签名、防回滚、A/B 分区与安全启动，细节在 OTA 篇
- 设备安全事件来自规则引擎的 `$events/...`，不是审计日志；零信任落地为独立身份、最小权限、持续验证、微隔离和全程可观测
- 对照 OWASP IoT Top 10、EN 303 645、IR 8259A 与 CRA，本篇没有覆盖的是漏洞披露、支持期限、SBOM 和退役擦除

## 参考资料

- OWASP Internet of Things Project：[https://owasp.org/www-project-internet-of-things/](https://owasp.org/www-project-internet-of-things/)
- OWASP IoT Top 10（2018）条目：[https://wiki.owasp.org/index.php/OWASP_Internet_of_Things_Project](https://wiki.owasp.org/index.php/OWASP_Internet_of_Things_Project)
- ETSI EN 303 645 V3.1.3：[https://www.etsi.org/deliver/etsi_en/303600_303699/303645/03.01.03_60/en_303645v030103p.pdf](https://www.etsi.org/deliver/etsi_en/303600_303699/303645/03.01.03_60/en_303645v030103p.pdf)
- NIST IR 8259A IoT Device Cybersecurity Capability Core Baseline：[https://csrc.nist.gov/pubs/ir/8259/a/final](https://csrc.nist.gov/pubs/ir/8259/a/final)
- 欧盟 Cyber Resilience Act 概览与适用日期：[https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act](https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act)
- 条例 (EU) 2024/2847 全文：[https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R2847](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R2847)
- 阿里云物联网平台 MQTT-TCP 连接通信：[https://help.aliyun.com/zh/iot/user-guide/establish-mqtt-connections-over-tcp](https://help.aliyun.com/zh/iot/user-guide/establish-mqtt-connections-over-tcp)
- 华为云 IoTDA 设备连接鉴权：[https://support.huaweicloud.com/api-iothub/iot_06_v5_3009.html](https://support.huaweicloud.com/api-iothub/iot_06_v5_3009.html)
- Azure IoT Hub 使用 MQTT 通信：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-mqtt-connect-to-iot-hub](https://learn.microsoft.com/en-us/azure/iot-hub/iot-mqtt-connect-to-iot-hub)
- Azure IoT Hub X.509 证书认证（吊销）：[https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-x509](https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-x509)
- AWS IoT Core 客户端认证：[https://docs.aws.amazon.com/iot/latest/developerguide/client-authentication.html](https://docs.aws.amazon.com/iot/latest/developerguide/client-authentication.html)
- AWS IoT Core 自定义认证与授权：[https://docs.aws.amazon.com/iot/latest/developerguide/custom-authentication.html](https://docs.aws.amazon.com/iot/latest/developerguide/custom-authentication.html)
- EMQX 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html)
- EMQX HTTP 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html)
- EMQX 认证返回的权限列表（ACL）：[https://docs.emqx.com/en/emqx/latest/access-control/authn/acl.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/acl.html)
- EMQX 客户端属性：[https://docs.emqx.com/en/emqx/latest/client-attributes/client-attributes.html](https://docs.emqx.com/en/emqx/latest/client-attributes/client-attributes.html)
- EMQX 授权（Topic 占位符与 topic_template_allow）：[https://docs.emqx.com/en/emqx/latest/access-control/authz/authz.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/authz.html)
- EMQX 6.3 不兼容变更：[https://docs.emqx.com/en/emqx/latest/changes/breaking-changes-6.3.html](https://docs.emqx.com/en/emqx/latest/changes/breaking-changes-6.3.html)
- EMQX JWT 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html)
- EMQX X.509 证书认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/x509.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/x509.html)
- EMQX 授权与 ACL 文件：[https://docs.emqx.com/en/emqx/latest/access-control/authz/file.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/file.html)
- EMQX 内置数据库授权：[https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html)
- EMQX SSL/TLS 双向认证：[https://docs.emqx.com/en/emqx/latest/network/emqx-mqtt-tls.html](https://docs.emqx.com/en/emqx/latest/network/emqx-mqtt-tls.html)
- EMQX CRL 检查：[https://docs.emqx.com/en/emqx/latest/network/crl.html](https://docs.emqx.com/en/emqx/latest/network/crl.html)
- EMQX REST API 与 API Key：[https://docs.emqx.com/en/emqx/latest/admin/api.html](https://docs.emqx.com/en/emqx/latest/admin/api.html)
- EMQX 规则 SQL 事件与字段：[https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html](https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html)
- RFC 7030 Enrollment over Secure Transport（EST）：[https://www.rfc-editor.org/rfc/rfc7030](https://www.rfc-editor.org/rfc/rfc7030)

> 下一篇：[设备注册与生命周期](./2_provisioning)

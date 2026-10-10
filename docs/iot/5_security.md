---
description: IoT 威胁模型、一机一密、X.509 与 mTLS、EMQX 5.x 认证授权与 ACL、安全事件审计、零信任落地
---

# 设备安全

> **本篇目标**：掌握 IoT 设备从身份到数据的整套防护——一机一密与 X.509 证书怎么发、EMQX 5.x 的认证和 Topic 授权怎么配、越权与暴力破解怎么发现，以及零信任在设备网络中怎么落地。
>
> **前置阅读**：[HTTPS 与 TLS](/protocols/3_https_tls)（证书链与 mTLS）、[零信任架构](/security/9_zero_trust)、[通信协议](./1_protocol)

TLS 握手、证书链校验等通用原理见 [HTTPS 与 TLS](/protocols/3_https_tls)，零信任的通用原则见 [零信任架构](/security/9_zero_trust)，本篇只讲设备侧特有的做法。

版本基线：配置均为 EMQX 5.x 语法（HOCON 配置、`${clientid}` 占位符、API Key 调用 REST API），6.x 沿用同一套语法；4.x 的 `%c` / `%u` 写法与 `acl.conf` 旧格式不再适用。EMQX 5.9 起的许可变化见 [平台选型](./2_platform)。

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
| 连接风暴 | 大量设备同时重连压垮 Broker | 客户端指数退避加随机抖动，Broker 连接速率限制 |
| 不安全的更新 | 固件被替换或回滚到有漏洞的旧版本 | 固件签名、防回滚、A/B 分区（见第五节） |

以上覆盖了 OWASP IoT Top 10 中最常见的几项，完整列表见文末参考资料。

---

## 二、设备身份与认证

### 1、认证方式对比

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| 用户名 / 密码（一机一密） | 每台设备唯一密钥，CONNECT 时携带 | 资源最受限的设备，必须配合 TLS |
| HMAC 签名 | 用设备密钥对 `clientId + 时间戳` 签名作为密码，密钥不上网 | 公有云 IoT 平台常用 |
| JWT | 设备持有带 `exp` 的令牌，过期后重新获取 | 设备能定期访问令牌服务的场景 |
| HTTP 认证服务 | EMQX 把凭证转发给业务服务判定 | 设备台账在业务系统中，需要自定义逻辑 |
| X.509 证书（mTLS） | 设备持有客户端证书，TLS 握手时校验 | 工业、能源、车联网等高安全要求场景 |
| TLS-PSK / DTLS-PSK | 双方预共享对称密钥完成 TLS / DTLS 握手 | 不便处理证书的 CoAP 等低功耗设备 |

### 2、一机一密与一型一密

| 模式 | 说明 | 风险 |
|------|------|------|
| 一机一密 | 每台设备出厂烧录唯一的 DeviceSecret 或证书 | 单台泄露只影响这一台，可单独吊销 |
| 一型一密 | 同型号共用 ProductSecret，首次上线用它「动态注册」换取本机密钥 | ProductSecret 泄露后，攻击者可以伪造该型号的新设备；注册接口必须校验设备序列号白名单，并且每台设备只能注册一次 |

一型一密只是解决产线无法逐台烧录的折中，换到本机密钥后应立刻弃用 ProductSecret。

### 3、HMAC 签名 + EMQX HTTP 认证

设备不直接发送 DeviceSecret，而是发送签名，签名中带时间戳以限制重放窗口：

| CONNECT 字段 | 取值 |
|--------------|------|
| clientid | `dev001`（设备 ID） |
| username | `dev001&1767225600000`（设备 ID + 毫秒时间戳） |
| password | `HMAC-SHA256(DeviceSecret, "clientId=dev001&ts=1767225600000")` 的十六进制 |

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
- **clientid 绑定身份**：ACL 依赖 `${clientid}`，如果认证不校验 clientid，设备可以用 `+` 之类的字符当 clientid，让 `devices/${clientid}/cmd` 变成通配订阅
- **容量**：每次连接都会调用该服务，设备批量重连时它就是瓶颈，需要按连接风暴的峰值压测和扩容

### 4、X.509 证书签发

证书认证的核心原则是**私钥在哪里生成，就只待在哪里**：设备在安全芯片内生成密钥对，只把 CSR 交给 CA 签名；平台不生成、也不下发设备私钥。

![设备证书签发与接入](../assets/iot/iot-cert-provisioning.svg)

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
- **吊销**：设备报废或疑似泄露时将证书加入 CRL；EMQX 的 SSL 监听器支持 CRL 检查（`enable_crl_check`），被吊销的设备在 TLS 握手阶段即被拒绝
- **CA 轮换**：设备内预置新旧两个 CA 证书，先下发新 CA，再逐步换签设备证书

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

拒绝匿名连接是认证层的事；授权层做 Topic 粒度的最小权限，并用 `no_match = deny` 加末尾 `{deny, all}` 兜底。

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

`sources` 按顺序检查，第一个给出结果的数据源生效。授权结果有缓存，修改规则后最长要等一个 `ttl` 才对已连接的客户端生效。除文件和内置数据库外，EMQX 内置 MySQL、PostgreSQL、MongoDB、Redis、LDAP、HTTP 数据源，规则量大或要和业务系统打通时直接配置，不需要插件。

### 3、文件规则（acl.conf）

```erlang
%% EMQX 5.x acl.conf：自上而下匹配，第一条命中的规则生效

%% 1. 任何客户端都不能订阅全量通配和系统主题（{eq, ...} 表示按字面匹配，不展开通配符）
{deny, all, subscribe, ["$SYS/#", {eq, "#"}, {eq, "+/#"}]}.

%% 2. 后台服务：订阅所有设备上报，向任意设备下发指令
{allow, {username, "iot-backend"}, subscribe, ["devices/+/telemetry", "devices/+/event"]}.
{allow, {username, "iot-backend"}, publish, ["devices/+/cmd"]}.

%% 3. 设备：只能发布自己的上报，只能订阅自己的指令
{allow, all, publish, ["devices/${clientid}/telemetry", "devices/${clientid}/event"]}.
{allow, all, subscribe, ["devices/${clientid}/cmd"]}.

%% 4. 兜底：其余一律拒绝
{deny, all}.
```

- **占位符**：5.x 用 `${clientid}`、`${username}`，4.x 的 `%c`、`%u` 不再生效
- **匹配条件**：`{username, "..."}`、`{clientid, "..."}`、`{ipaddr, "10.0.0.0/8"}`，用户名和 clientid 支持正则 `{username, {re, "^svc-"}}`
- **按 username 授权的前提**：username 必须经过认证；只用证书认证时，用上文的 `peer_cert_as_username = cn` 让 username 也来自证书，否则任何设备都能自称 `iot-backend`
- **通过 Dashboard 或 REST API 改过文件规则后**，EMQX 会把规则保存到 `data/authz/acl.conf`，不再读取 `path` 指向的原文件

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

---

## 五、OTA 与固件安全

OTA 既是修复漏洞的唯一通道，也是最危险的攻击入口：攻击者一旦能推送固件，就等于拿到了全部设备。安全的 OTA 至少包括四件事：发布方用私钥对固件的 SHA-256 摘要做 ECDSA 或 Ed25519 签名，设备用内置公钥验签（MD5 既不是签名，也不抗碰撞，不能用来防篡改）；设备记录单调递增的安全版本号，拒绝安装更低版本，防止回滚到有漏洞的旧固件；A/B 双分区写入新固件，启动失败自动回退；配合安全启动（Secure Boot），保证每次上电运行的都是验签通过的固件。任务编排、灰度与断点续传等实现细节见 [OTA 升级](./10_ota)。

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

典型告警规则：同一来源 IP 短时间大量认证失败（暴力破解）、单台设备反复越权（固件被篡改或配置错误）、设备从未出现过的地区上线（凭证外泄）。

### 2、零信任措施

零信任的通用原则见 [零信任架构](/security/9_zero_trust)，落到 IoT 是下面几项：

| 原则 | IoT 中的做法 |
|------|-------------|
| 每个设备独立身份 | 一机一密或设备证书，禁止同型号共用凭证 |
| 最小权限 | ACL 只放行 `devices/${clientid}/...`，后台服务按职责拆分账号 |
| 持续验证 | JWT 带 `exp`，EMQX 默认在令牌过期后断开连接（`disconnect_after_expire`），设备重连时重新认证；令牌有效期加随机抖动，避免大批设备同时过期、同时重连 |
| 微隔离 | 按区域划分设备网段，网关作为唯一出口，Broker 不直接暴露在公网 |
| 全程可观测 | 认证、授权、上下线事件全部进入 SIEM |

网络微分段的典型做法：

![IoT 网络微分段](../assets/iot/iot-network-segmentation.svg)

- 不同车间的设备网段之间默认拒绝互访，一台设备被攻破不会横向扩散
- 边缘网关是区域唯一出口，统一管理本区域设备的认证和流量
- 负载均衡只放行 8883，EMQX 集群不直接暴露在公网；Dashboard 与 REST API 端口只在管理网可达

---

## 七、安全检查清单

| 阶段 | 措施 |
|------|------|
| 一、基础 | 只开放 8883，关闭 1883；配置认证器，拒绝未认证连接；每台设备独立凭证 |
| 二、权限 | 部署 ACL，设备只能访问自己的 Topic；`no_match = deny` + 末尾 `{deny, all}`；API Key 最小权限 |
| 三、设备 | 私钥放安全芯片；量产禁用 UART / JTAG；删除测试账号与默认口令 |
| 四、固件 | OTA 签名验签、防回滚、A/B 分区、安全启动 |
| 五、隔离 | 设备网段微分段，管理端口只对内网开放 |
| 六、持续 | 证书 / 令牌定期轮换，吊销走 CRL；认证与越权事件接入 SIEM 并配置告警 |

---

## 小结

- IoT 安全的难点在规模、物理可接触和长期无人值守，凭证必须一机一密、可自动轮换和吊销
- 密码类方案用 HMAC 签名 + 时间戳，DeviceSecret 不上网；认证服务要校验 clientid 与设备身份一致
- 证书方案选 ECDSA P-256，私钥在设备内生成、永不离开设备；EMQX 用 `verify_peer` + `fail_if_no_peer_cert = true` 强制 mTLS，用 `peer_cert_as_clientid = cn` 绑定身份
- EMQX 5.x 授权用 `${clientid}` 占位符、`{eq, ...}` 字面匹配，`no_match = deny` 加 `{deny, all}` 兜底；REST API 用 API Key，请求体是数组
- OTA 要签名、防回滚、A/B 分区与安全启动，细节在 OTA 篇
- 设备安全事件来自规则引擎的 `$events/...`，不是审计日志；零信任落地为独立身份、最小权限、持续验证、微隔离和全程可观测

## 参考资料

- OWASP Internet of Things Project：[https://owasp.org/www-project-internet-of-things/](https://owasp.org/www-project-internet-of-things/)
- EMQX 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html)
- EMQX HTTP 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html)
- EMQX JWT 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html)
- EMQX X.509 证书认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/x509.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/x509.html)
- EMQX 授权与 ACL 文件：[https://docs.emqx.com/en/emqx/latest/access-control/authz/file.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/file.html)
- EMQX 内置数据库授权：[https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/mnesia.html)
- EMQX SSL/TLS 双向认证：[https://docs.emqx.com/en/emqx/latest/network/emqx-mqtt-tls.html](https://docs.emqx.com/en/emqx/latest/network/emqx-mqtt-tls.html)
- EMQX CRL 检查：[https://docs.emqx.com/en/emqx/latest/network/crl.html](https://docs.emqx.com/en/emqx/latest/network/crl.html)
- EMQX REST API 与 API Key：[https://docs.emqx.com/en/emqx/latest/admin/api.html](https://docs.emqx.com/en/emqx/latest/admin/api.html)
- EMQX 规则 SQL 事件与字段：[https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html](https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html)
- RFC 7030 Enrollment over Secure Transport（EST）：[https://www.rfc-editor.org/rfc/rfc7030](https://www.rfc-editor.org/rfc/rfc7030)

> 下一篇：[MQTT 客户端](./6_mqtt_client)

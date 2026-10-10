---
description: TLS 1.3 握手、前向保密、证书链校验、SNI / ALPN / HSTS、mTLS、SSL Bundle
---

# HTTPS 与 TLS

> 前置阅读：[HTTP](./2_http)

HTTPS 就是跑在 TLS 之上的 HTTP，负责加密、防篡改和身份校验。本篇讲 TLS 1.3 握手、证书链校验、mTLS、SSL Bundle 配置与 PKIX 报错排查，基线为 TLS 1.3。

---

## 一、为什么需要 HTTPS

主流版本为 TLS 1.3（RFC 8446）和 1.2（RFC 5246），SSL 3.0、TLS 1.0 / 1.1 已被废弃（RFC 7568、RFC 8996）。

### 1、明文 HTTP 的三个问题

| 威胁 | 例子 | TLS 的对策 |
|------|------|-----------|
| 窃听 | 公共 Wi-Fi 上抓包看到密码、Cookie | **加密**：握手协商出对称密钥，之后的数据全部加密 |
| 篡改 | 运营商在页面里插广告、改下载包 | **完整性**：AEAD 加密算法（AES-GCM、ChaCha20-Poly1305）自带认证标签，被改过的记录直接解密失败 |
| 冒充 | DNS 被劫持，连到了假冒的服务器 | **身份认证**：服务端出示 CA 签发的证书，并用私钥证明证书是自己的 |

### 2、非对称与对称加密的分工

非对称加密能在不安全的信道上建立共享秘密、证明身份，但计算慢；对称加密快，但双方必须事先有相同的密钥。TLS 把两者组合起来：

- **握手阶段**：用 ECDHE 协商出共享秘密，用证书和签名（RSA 或 ECDSA）证明服务端身份
- **数据阶段**：用协商出来的密钥做对称加密，单连接每秒可以处理 GB 级数据

HTTPS 带来的额外开销主要是握手的 1 个 RTT 和一次签名运算；数据加密在有 AES 指令集的 CPU 上开销很小。

---

## 二、TLS 1.3 握手

![TLS 1.2（ECDHE）与 TLS 1.3 完整握手对比](../assets/protocols/tls-handshake.svg)

### 1、完整握手：1-RTT

1. **ClientHello**：客户端发送支持的版本（`supported_versions`）、密码套件、**直接附上自己的 ECDHE 公钥**（`key_share`），以及要访问的域名（SNI）和应用协议列表（ALPN）
2. **ServerHello**：服务端选定套件，回自己的 `key_share`。到这一步双方都能算出共享秘密，立刻派生出**握手密钥**，之后的握手消息全部加密
3. **服务端加密消息**：`EncryptedExtensions`（ALPN 结果等）、可选的 `CertificateRequest`（仅 mTLS）、`Certificate`（证书链）、`CertificateVerify`（用证书私钥对握手记录签名，证明自己持有私钥）、`Finished`（对整个握手的 MAC）
4. **客户端校验并回复**：校验证书链和签名，回 `Finished`（mTLS 时先发自己的 `Certificate` 和 `CertificateVerify`），随后即可发送应用数据

关键在第 1 步：TLS 1.3 的客户端**猜测**服务端支持的曲线（通常是 X25519），在第一个包里就把公钥发过去，省掉了 TLS 1.2 中单独协商参数的一个来回。猜错了服务端会回 `HelloRetryRequest`，多花一个 RTT。

### 2、与 TLS 1.2 的区别

| 维度 | TLS 1.2 | TLS 1.3 |
|------|---------|---------|
| 完整握手 | 2-RTT | 1-RTT |
| 密钥交换 | 允许静态 RSA（无前向保密）和 (EC)DHE | 只允许 (EC)DHE，前向保密成为必选 |
| 加密方式 | 允许 CBC 模式（MAC-then-Encrypt，出过 Lucky13 等漏洞）和 AEAD | 只允许 AEAD（AES-GCM、ChaCha20-Poly1305 等） |
| 弱算法 | RC4 已被 RFC 7465 禁止，但 SHA-1 签名、3DES 等仍可能被配置启用 | 套件只剩 5 个，弱算法全部移除 |
| 证书 | 明文传输，中间设备能看到 | 加密传输 |
| 会话恢复 | Session ID / Session Ticket（RFC 5077） | 统一为 PSK，可选 0-RTT |
| 重新协商、压缩 | 支持（都出过漏洞） | 移除 |

### 3、会话恢复与 0-RTT

完整握手后，服务端会发一个 `NewSessionTicket`，客户端下次连接时带上它（PSK），可以跳过证书校验，仍然 1-RTT 完成握手。

如果双方都开启了 **0-RTT（early data）**，客户端在 ClientHello 后面直接附上请求数据，服务端收到第一个包就能处理。代价是：

- **early data 可以被重放**：攻击者截获这个包后再发一次，服务端无法区分。所以 0-RTT 只应用于幂等请求（如 GET 静态资源），绝不能用于下单、转账
- **服务端的做法**：通常只在 CDN、边缘网关开启；转发给后端时带上 `Early-Data: 1` 头，后端对不能重放的请求返回 `425 Too Early`（RFC 8470），让客户端完成完整握手后重发
- **前向保密变弱**：early data 只用 PSK 派生的密钥加密，若会话票据密钥泄露，这部分数据可以被解密

QUIC 内置 TLS 1.3，同样具备 1-RTT 和 0-RTT，限制也相同，见 [HTTP](./2_http) 的 HTTP/3 一节。

---

## 三、密钥交换与前向保密

### 1、静态 RSA 密钥交换为什么被淘汰

TLS 1.2 的 RSA 密钥交换里，客户端生成预主密钥，用服务器证书里的 RSA 公钥加密后发过去。问题在于：**会话密钥的安全完全依赖服务器的长期私钥**。攻击者今天录下所有加密流量，几年后一旦拿到私钥（泄露、被入侵、被强制交出），就能解密过去全部的会话。

### 2、ECDHE 与前向保密

ECDHE（椭圆曲线临时 Diffie-Hellman）的做法：

- 每次握手双方各生成一对**临时**密钥，交换公钥后各自算出相同的共享秘密，私钥用完即丢
- 证书私钥只用来对握手内容**签名**（`CertificateVerify`），证明“我是证书的主人”，不参与生成会话密钥
- 即使证书私钥日后泄露，攻击者也算不出以前每次握手的临时私钥，**历史流量依然安全**，这就是前向保密（Forward Secrecy）

常用曲线是 X25519 和 P-256。主流浏览器已开始默认使用 X25519 与 ML-KEM 的混合密钥交换，以防“现在录下、将来用量子计算机解密”。

### 3、密钥派生

TLS 1.3 用 HKDF 从共享秘密逐级派生出多组密钥：握手密钥只加密握手消息，应用数据用另一组密钥，两个方向的密钥也各不相同。连接存续期间还可以通过 `KeyUpdate` 消息更换应用密钥。这些细节由 TLS 库处理，业务侧只需知道“不同阶段用不同密钥”。

---

## 四、证书与证书链校验

### 1、证书里有什么

| 字段 | 说明 |
|------|------|
| Subject | 证书主体，早期用 CN 写域名 |
| Subject Alternative Name（SAN） | 证书覆盖的域名或 IP 列表，**主机名校验只看它**，现代客户端已不再看 CN |
| Issuer | 签发者，即上一级 CA |
| Validity | 有效期 notBefore / notAfter |
| Public Key | 证书主人的公钥 |
| 扩展 | BasicConstraints（是不是 CA）、Key Usage / Extended Key Usage（用途）、吊销信息地址等 |
| Signature | 上一级 CA 用自己的私钥对以上内容的签名 |

### 2、证书链校验

![证书链校验：从叶子证书逐级验到受信根](../assets/protocols/cert-chain.svg)

服务端在 `Certificate` 消息里下发叶子证书和中间证书（**不需要也不应该下发根证书**）。客户端从叶子开始，每一张都用上一级证书的公钥验签，同时检查有效期、用途、吊销状态，直到碰到一张存在于本地信任库里的根证书为止；叶子证书还要检查 SAN 是否包含当前访问的域名。

最常见的配置错误是**服务端漏配中间证书**：浏览器有时能通过缓存或 AIA 扩展自动补全，看起来正常；但 Java、curl 等客户端不会补，直接报错。部署时要用 `fullchain` 而不是只有叶子证书的文件。

### 3、吊销检查

证书私钥泄露后，CA 要能吊销它，客户端也要能查到：

| 机制 | 说明 |
|------|------|
| CRL | CA 定期发布被吊销证书的序列号列表，客户端下载比对 |
| OCSP | 客户端实时向 CA 查询单张证书状态，但会向 CA 暴露用户在访问哪个站点 |
| OCSP Stapling | 服务端定期向 CA 取 OCSP 响应，握手时一并发给客户端，解决隐私和性能问题 |

出于隐私考虑，Let's Encrypt 已在 2025 年关闭 OCSP 服务，只发布 CRL。浏览器也大多采用自己汇总后推送的吊销列表，而不是逐个在线查询。

### 4、有效期越来越短

按 CA/Browser Forum 的 SC-081 决议，公网证书的最长有效期从 398 天逐步缩短：2026 年 3 月 15 日起为 200 天，2027 年起 100 天，2029 年起 47 天。手工续期已经不现实，应使用 ACME 协议自动签发与续期（如 Certbot、cert-manager），并配合下文 Spring Boot SSL Bundle 的热加载。企业内部私有 CA 不受该规则约束。

### 5、中间人攻击为什么失败

中间人可以截获连接，但拿不到目标域名的有效证书：它自己签的证书链到不了客户端信任的根，正规 CA 也不会给它签别人的域名。所以客户端一定会报证书错误，除非：

- 用户或管理员把中间人的根证书装进了信任库（企业上网行为管理、抓包工具都是这么做的）
- 代码里关闭了校验，比如信任所有证书、跳过主机名校验。这等于把 HTTPS 退化成了只防窃听不防冒充，生产代码中禁止出现

### 6、常见证书文件格式

| 格式 | 扩展名 | 内容 | 常见用途 |
|------|--------|------|----------|
| PEM | `.pem` `.crt` `.key` | Base64 文本，带 `-----BEGIN ...-----` 标记，证书和私钥通常分开 | Nginx、Kubernetes Secret、Spring Boot PEM Bundle |
| DER | `.der` `.cer` | PEM 对应的二进制形式 | Windows、部分 Java 工具 |
| PKCS#12 | `.p12` `.pfx` | 私钥 + 证书链打包，带密码保护 | Java 的默认 keystore 类型（JDK 9 起） |
| JKS | `.jks` | Java 专有格式 | 旧项目，新项目改用 PKCS#12 |
| CSR | `.csr` | 证书签名请求，含公钥和主体信息 | 向 CA 申请证书 |

---

## 五、TLS 扩展：SNI、ALPN 与 HSTS

### 1、SNI：一个 IP 上多个域名

服务端要在握手时出示证书，但此时还没收到 HTTP 的 `Host` 头，不知道客户端要访问哪个站点。SNI（Server Name Indication，RFC 6066）让客户端在 ClientHello 里带上域名，网关据此选择证书，也可以据此路由（如 Nginx `ssl_preread`、Kubernetes Ingress 的 TLS 透传）。

SNI 是明文的，中间设备能看到用户访问的域名。ECH（Encrypted Client Hello，RFC 9849）把真实的 ClientHello 加密后放在一个外层 ClientHello 里，用来解决这个问题，目前主要由大型 CDN 和浏览器支持。

### 2、ALPN：协商应用层协议

ALPN（RFC 7301）让客户端在 ClientHello 里列出支持的协议（如 `h2`、`http/1.1`），服务端在 `EncryptedExtensions` 里选定一个。**浏览器只通过 ALPN 协商 HTTP/2**，所以 TLS 终结点（Nginx、网关、内嵌容器）不支持 ALPN 时，h2 永远不会生效；gRPC over TLS 同样依赖 ALPN 协商 `h2`。

### 3、HSTS：防止被降级到 HTTP

用户在地址栏输入 `example.com` 时，浏览器先发的是 HTTP 请求，再被 301 重定向到 HTTPS。这第一个明文请求可以被中间人劫持，让用户一直停留在 HTTP（SSL 剥离攻击）。HSTS（RFC 6797）的做法是服务端在 HTTPS 响应里声明：

```http
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

- 浏览器在 `max-age` 内对该域名只用 HTTPS，证书错误时也不允许用户点“继续访问”
- `includeSubDomains` 覆盖所有子域，开启前要确认每个子域都已支持 HTTPS
- 第一次访问前浏览器还不知道 HSTS 策略，需要提交到浏览器内置的 preload 列表才能彻底解决；进入列表后很难撤销，要谨慎

Spring Security 默认会在 HTTPS 响应上写入 HSTS 头；在网关统一终结 TLS 时，一般由网关添加。

---

## 六、mTLS 双向认证

普通 TLS 只有服务端出示证书，客户端是匿名的。mTLS 要求客户端也出示证书，适合服务间调用、IoT 设备接入、开放平台的机构对接等场景。握手上只多了三条消息（见第二节的握手图中方括号部分）：

1. 服务端在加密的握手消息里发送 `CertificateRequest`，说明自己接受哪些 CA 签发的客户端证书
2. 客户端在 `Finished` 之前发送自己的 `Certificate` 和 `CertificateVerify`，用客户端私钥签名证明身份
3. 服务端用**自己的信任库**校验客户端证书链，再从证书的 Subject 或 SAN 中取出调用方身份（如服务名、SPIFFE ID），交给授权逻辑

几个要点：

- 服务端的信任库决定“谁能连进来”，应只放内部 CA，而不是系统默认的公网根证书列表
- mTLS 只解决“对方是谁”，不解决“它能做什么”，授权仍需在应用层完成
- TLS 1.3 下客户端没带证书时，服务端会以 `certificate_required` 告警断开连接

在服务网格（如 Istio）里，mTLS 由 Sidecar 自动完成，证书由控制面签发和轮换，业务代码无感知，这部分属于零信任架构的落地方式，见 [零信任架构](/security/9_zero_trust)。

---

## 七、Java 中的 TLS

### 1、keystore 与 truststore

| 概念 | 放什么 | 回答的问题 | JSSE 系统属性 |
|------|--------|-----------|---------------|
| keystore | 自己的私钥 + 证书链 | “我是谁”：服务端出示证书、mTLS 客户端出示证书 | `javax.net.ssl.keyStore` |
| truststore | 信任的 CA 证书（只有公钥） | “我信谁”：校验对端证书链时找根 | `javax.net.ssl.trustStore` |

不指定 truststore 时，JDK 使用 `$JAVA_HOME/lib/security/cacerts`，其中是 JDK 自带的公网根证书。调用使用私有 CA 的内部服务时，应为这个客户端单独配置 truststore，而不是修改全局 `cacerts`（升级 JDK 后会被覆盖）。JDK 11 起支持 TLS 1.3（JEP 332）。

### 2、Spring Boot SSL Bundle

Spring Boot 3.1 起提供 SSL Bundle：在 `spring.ssl.bundle.*` 下定义一组证书材料，服务端、HTTP 客户端、Redis、Kafka 等组件都通过名字引用，不再各写一套 `key-store`、`trust-store` 配置。

**服务端（含 mTLS）**：

```yaml
spring:
  ssl:
    bundle:
      pem:
        web-server:
          reload-on-update: true                            # 证书文件变化时自动热加载
          keystore:
            certificate: "file:/etc/app/tls/fullchain.pem"  # 叶子 + 中间证书
            private-key: "file:/etc/app/tls/privkey.pem"
          truststore:
            certificate: "file:/etc/app/tls/client-ca.pem"  # 仅 mTLS：信任哪个 CA 签发的客户端证书
          options:
            enabled-protocols: "TLSv1.3"

server:
  port: 8443
  ssl:
    bundle: "web-server"
    client-auth: need          # mTLS：need 必须带客户端证书，want 可选；单向 TLS 删掉这一行
```

热加载目前支持 Tomcat 和 Netty 两种内嵌服务器，配合 cert-manager、Certbot 自动续期后无需重启应用。

**客户端（调用私有 CA 签发证书的内部服务，并携带客户端证书）**：

```yaml
spring:
  ssl:
    bundle:
      pem:
        order-client:
          keystore:                                         # mTLS 时客户端自己的证书与私钥
            certificate: "file:/etc/app/tls/client.pem"
            private-key: "file:/etc/app/tls/client-key.pem"
          truststore:                                       # 信任服务端证书的签发 CA
            certificate: "file:/etc/app/tls/internal-ca.pem"
```

```java
@Configuration
public class OrderClientConfig {

    @Bean
    RestClient orderRestClient(RestClient.Builder builder, RestClientSsl ssl) {
        return builder.baseUrl("https://order.internal:8443")
                .apply(ssl.fromBundle("order-client"))
                .build();
    }
}
```

- `RestClientSsl` 由 Spring Boot 3.2+ 自动配置；Spring Boot 4 中它的包名移到了 `org.springframework.boot.restclient.autoconfigure`
- `RestTemplate` 用 `RestTemplateBuilder` 的 `sslBundle(...)` 应用同一个 Bundle，`WebClient` 对应 `WebClientSsl`
- 证书材料也可以是 JKS / PKCS#12，把 `pem` 换成 `jks` 并配置 `keystore.location`、`keystore.password` 即可；密码通过环境变量或密钥管理系统注入，不写进配置文件

### 3、keytool 常用命令

```bash
# 生成本地开发用的自签名证书（PKCS#12），只用于开发环境
keytool -genkeypair -alias dev-server -keyalg EC -groupname secp256r1 \
  -storetype PKCS12 -keystore dev-server.p12 -validity 90 \
  -dname "CN=localhost" -ext "SAN=dns:localhost,ip:127.0.0.1"

# 把内部 CA 证书导入单独的信任库
keytool -importcert -alias internal-ca -file internal-ca.pem \
  -storetype PKCS12 -keystore truststore.p12

# 查看 keystore 内容与证书链
keytool -list -v -keystore truststore.p12
```

---

## 八、常见错误排查

| 错误信息 | 原因 | 处理 |
|----------|------|------|
| `PKIX path building failed ... unable to find valid certification path to requested target` | 校验链时找不到受信根：对端用私有 CA 或自签名证书；对端漏发中间证书；公司代理替换了证书 | 用 `openssl s_client -showcerts` 看对端实际下发了哪些证书；漏中间证书让对端改用 fullchain；私有 CA 则把 CA 证书放进该客户端的 truststore（SSL Bundle） |
| `No subject alternative names matching ...` | 访问的域名或 IP 不在证书的 SAN 中 | 用证书里有的域名访问，或重新签发包含该名称的证书 |
| `CertificateExpiredException` / `NotYetValidException` | 证书过期，或本机时钟不准 | 续期证书，检查 NTP |
| `Received fatal alert: handshake_failure` / `protocol_version` | 双方没有共同支持的协议版本或密码套件，如老服务只支持 TLS 1.0 | 对齐 `enabled-protocols` 和套件，推动老服务升级 |
| `Received fatal alert: certificate_required` / `bad_certificate` | mTLS 场景下客户端没带证书，或证书不被服务端信任 | 检查客户端 keystore 配置和服务端 truststore |

排查工具：

- `openssl s_client -connect host:443 -servername host -showcerts`：看服务端下发的证书链、协商出的版本和套件
- JVM 参数 `-Djavax.net.debug=ssl:handshake`：打印 Java 侧完整握手过程，日志量大，只在排查时临时开启

**常见坑**：搜 PKIX 报错时常看到“自定义一个信任所有证书的 `TrustManager`”的写法。这会让任何中间人都能冒充服务端，正确做法永远是把正确的 CA 放进 truststore。

---

## 九、相关：OAuth2、JWT 与单点登录

TLS 解决的是传输通道的安全和服务端（mTLS 时还有客户端）的身份；“哪个用户在调用、能访问哪些资源”属于应用层的认证授权，在应用安全模块展开：

- 令牌结构、签名算法与吊销：[JWT 令牌机制](/security/1_jwt)
- 授权码模式、PKCE、客户端凭证模式：[OAuth2](/security/2_oauth2)
- 身份层与 id_token：[OIDC](/security/3_oidc)
- CAS、SAML、OIDC 单点登录选型：[单点登录](/security/4_sso)
- 接口签名、防重放、Token 设计：[API 安全](/security/6_api_security)

---

## 小结

- HTTPS = HTTP + TLS：非对称算法负责密钥协商和身份认证，对称 AEAD 算法负责数据加密与完整性
- TLS 1.3 的 ClientHello 直接带上 ECDHE 公钥，1-RTT 完成握手，ServerHello 之后的握手消息（含证书）全部加密；TLS 1.2 需要 2-RTT
- 0-RTT 的 early data 可被重放，只能用于幂等请求，后端用 `425 Too Early` 兜底
- ECDHE 每次握手使用临时密钥，证书私钥只做签名，因此具备前向保密；TLS 1.3 移除了静态 RSA 密钥交换和 CBC 套件
- 证书链从叶子逐级验签到本地信任库中的根，同时检查有效期、SAN、用途和吊销；服务端必须下发中间证书
- SNI 选证书，ALPN 协商 h2，HSTS 防止降级；mTLS 多了 `CertificateRequest` 和客户端的 `Certificate` / `CertificateVerify`
- Java 里 keystore 回答“我是谁”，truststore 回答“我信谁”；Spring Boot 用 SSL Bundle 统一配置并支持热加载
- 遇到 PKIX 错误，先看对端下发了哪些证书，再修 truststore，绝不信任所有证书
- OAuth2、JWT 这类应用层认证协议不在本篇范围，见第九节的链接。

## 参考资料

- RFC 8446 TLS 1.3：[https://www.rfc-editor.org/rfc/rfc8446.html](https://www.rfc-editor.org/rfc/rfc8446.html)
- RFC 5246 TLS 1.2：[https://www.rfc-editor.org/rfc/rfc5246.html](https://www.rfc-editor.org/rfc/rfc5246.html)
- RFC 7465 Prohibiting RC4 Cipher Suites：[https://www.rfc-editor.org/rfc/rfc7465.html](https://www.rfc-editor.org/rfc/rfc7465.html)
- RFC 8996 Deprecating TLS 1.0 and TLS 1.1：[https://www.rfc-editor.org/rfc/rfc8996.html](https://www.rfc-editor.org/rfc/rfc8996.html)
- RFC 8470 Using Early Data in HTTP：[https://www.rfc-editor.org/rfc/rfc8470.html](https://www.rfc-editor.org/rfc/rfc8470.html)
- RFC 5280 X.509 证书与 CRL：[https://www.rfc-editor.org/rfc/rfc5280.html](https://www.rfc-editor.org/rfc/rfc5280.html)
- RFC 6066 TLS Extensions（SNI）：[https://www.rfc-editor.org/rfc/rfc6066.html](https://www.rfc-editor.org/rfc/rfc6066.html)
- RFC 7301 ALPN：[https://www.rfc-editor.org/rfc/rfc7301.html](https://www.rfc-editor.org/rfc/rfc7301.html)
- RFC 6797 HSTS：[https://www.rfc-editor.org/rfc/rfc6797.html](https://www.rfc-editor.org/rfc/rfc6797.html)
- RFC 9849 TLS Encrypted Client Hello：[https://www.rfc-editor.org/rfc/rfc9849.html](https://www.rfc-editor.org/rfc/rfc9849.html)
- JEP 332 Transport Layer Security (TLS) 1.3：[https://openjdk.org/jeps/332](https://openjdk.org/jeps/332)
- Spring Boot SSL：[https://docs.spring.io/spring-boot/reference/features/ssl.html](https://docs.spring.io/spring-boot/reference/features/ssl.html)
- Spring Boot REST Clients（SSL Bundle 用法）：[https://docs.spring.io/spring-boot/reference/io/rest-client.html](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- Let's Encrypt OCSP Service Has Reached End of Life：[https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life.html](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life.html)

> 下一篇：[DNS](./4_dns) —— 域名层级、递归与迭代、记录类型、TTL 与缓存、DoH / DoT、JVM DNS 缓存。

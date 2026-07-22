# 安全协议

> 官方规范：[TLS 1.3 RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) / [OAuth 2.0 RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) / [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)
>
> 认证授权（JWT / OAuth2 / SSO）的详细内容见 → [安全体系](../security/)

---

## 一、TLS/HTTPS

TLS（Transport Layer Security）在传输层提供加密、完整性校验和身份认证。HTTPS = HTTP + TLS。

### TLS 1.3 握手流程（1-RTT）

```
Client                                Server
  │── ClientHello (支持的密码套件、key_share) ────►│
  │◄── ServerHello (选定套件、key_share) ──────────│
  │◄── {Certificate, CertificateVerify, Finished} ─│  (已加密)
  │── {Finished} ──────────────────────────────────►│
  │
  └── 握手完成，开始加密传输（1-RTT）
```

**TLS 1.2 vs TLS 1.3**

| 对比 | TLS 1.2 | TLS 1.3 |
|------|---------|---------|
| 握手轮次 | 2-RTT | 1-RTT（会话恢复可 0-RTT）|
| 前向保密 | 可选 | 强制（ECDHE）|
| 加密算法 | RC4/3DES 等弱算法仍允许 | 移除所有弱算法 |
| 证书加密 | 明文传输 | 证书本身加密传输 |
| 性能 | 较慢 | 更快 |

### Spring Boot 启用 HTTPS

```yaml
server:
  port: 8443
  ssl:
    enabled: true
    key-store: classpath:keystore.p12
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    key-store-type: PKCS12
    key-alias: myapp
    protocol: TLS
    enabled-protocols: TLSv1.3
    ciphers: TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256
```

生成自签名证书（开发测试用）：

```bash
keytool -genkeypair -alias myapp -keyalg RSA -keysize 2048 \
  -storetype PKCS12 -keystore keystore.p12 -validity 365 \
  -dname "CN=localhost, OU=Dev, O=Company, L=City, ST=State, C=CN"
```

---

## 二、mTLS（双向 TLS）

标准 TLS 只验证服务端证书（客户端匿名）。mTLS 要求**双方互相验证证书**，常用于服务间通信（零信任网络）。

```
Client                          Server
  │── 证书 + ClientHello ──────►│  服务端验证客户端证书
  │◄── 证书 + ServerHello ───── │  客户端验证服务端证书
  │     (双方互信后建立通道)      │
```

**Spring Boot 服务端配置 mTLS**

```yaml
server:
  ssl:
    client-auth: need         # need=必须提供客户端证书，want=可选
    trust-store: classpath:truststore.p12
    trust-store-password: ${SSL_TRUSTSTORE_PASSWORD}
    trust-store-type: PKCS12
```

**RestTemplate 客户端携带证书**

```java
@Bean
public RestTemplate mtlsRestTemplate() throws Exception {
    KeyStore keyStore = KeyStore.getInstance("PKCS12");
    keyStore.load(new ClassPathResource("client.p12").getInputStream(),
        clientKeystorePassword.toCharArray());

    SSLContext sslContext = SSLContextBuilder.create()
        .loadKeyMaterial(keyStore, clientKeystorePassword.toCharArray())
        .loadTrustMaterial(null, new TrustSelfSignedStrategy())
        .build();

    HttpClient httpClient = HttpClients.custom()
        .setSSLContext(sslContext)
        .build();

    return new RestTemplate(new HttpComponentsClientHttpRequestFactory(httpClient));
}
```

---

## 三、证书体系

```
Root CA（根证书）
    └── Intermediate CA（中间证书）
            └── Leaf Certificate（叶子证书，服务使用）
```

| 概念 | 说明 |
|------|------|
| **CA** | Certificate Authority，受信任的证书颁发机构 |
| **CSR** | Certificate Signing Request，申请证书时向 CA 提交的请求 |
| **PKCS12 (.p12)** | 含私钥 + 证书的容器格式，有密码保护 |
| **PEM (.pem/.crt/.key)** | Base64 编码文本格式，Nginx/Linux 常用 |
| **CRL / OCSP** | 证书吊销列表 / 在线证书状态协议，用于验证证书是否被吊销 |
| **SNI** | Server Name Indication，TLS 扩展，允许同一 IP 部署多个域名证书 |

---

## 四、OAuth2 / JWT / SSO

认证授权相关协议（OAuth2、JWT、OIDC、SAML、单点登录）在实际工程中与 Spring Security 深度结合，详细内容见安全体系专章：

- **认证与授权** → [security/认证授权](../security/)
- **API 安全（Token 设计、接口签名）** → [security/API 安全](../security/)

---

## 五、协议选型速查

| 场景 | 方案 |
|------|------|
| 浏览器/App 到服务端加密 | **TLS 1.3 + HTTPS** |
| 微服务间零信任认证 | **mTLS** |
| 用户身份认证（第三方登录）| **OAuth2 + OIDC** |
| 无状态 API 鉴权 | **JWT（Bearer Token）** |
| 企业单点登录 | **SAML 2.0 / OIDC** |
| 内部服务 API 签名 | **HMAC-SHA256 请求签名** |

---
description: 角色与令牌、授权码 + PKCE、客户端凭证、设备码、刷新令牌、内省、RFC 9700 安全实践、Spring 落地
---

# OAuth2

> **本篇目标**：搞清 OAuth 2 的四个角色、令牌与 scope；掌握 OAuth 2.1 保留的三种授权模式（授权码 + PKCE、客户端凭证、设备码）和刷新令牌的工作方式；会在 JWT 本地验签与 Introspection 之间做选择；能按 RFC 9700 安全实践检查一个 OAuth 接入，并用 Spring Security 7 写出客户端、资源服务器与授权服务器的最小配置。
>
> **前置阅读**：[JWT 令牌机制](./1_jwt)（JWT 结构与签名）

OAuth 2 是一个**授权委托**框架：用户（资源所有者）把"以我的名义访问某些资源"的有限权限交给第三方应用，而不交出自己的密码。本篇的规范基线是 RFC 6749（核心框架）+ RFC 6750（Bearer 令牌）+ **RFC 9700**（OAuth 2.0 安全最佳实践，BCP 240，2025 年 1 月发布）；**OAuth 2.1 截至 2026 年 10 月仍是 IETF 草案**（draft-ietf-oauth-v2-1-16，2026-09），还不是 RFC，但它基本就是"RFC 6749 + 历年安全修订"的合订本，新系统按它设计即可。框架代码以 Spring Boot 4 / Spring Security 7 为准。

在 OAuth 之上加身份认证（"你是谁"）的是 [OIDC](./3_oidc)，多个系统共用一次登录的是 [单点登录](./4_sso)。

---

## 一、OAuth 2 解决什么问题

在 OAuth 出现之前，第三方应用想读你在 A 网站的数据，只能让你把 A 网站的账号密码交给它，结果是权限无法限定、无法单独撤销、密码泄露面扩大。OAuth 2 的做法是：由 A 网站的**授权服务器**在用户同意后，给第三方应用发一张**访问令牌**（access token），令牌上限定了能做什么（scope）、给谁用（audience）、多久过期。

**OAuth 2 本身是授权协议，不是认证协议**：拿到 access token 只说明"某个客户端被允许访问某些资源"，并不能可靠地告诉客户端"当前用户是谁"。日常说的"用微信 / GitHub 登录"，是在 OAuth 流程之上再取用户信息完成的登录，标准化的做法就是 OIDC，详见 [OIDC](./3_oidc)。

---

## 二、四个角色与两类客户端

| 角色 | 说明 | 示例 |
|------|------|------|
| **Resource Owner**（资源所有者） | 能授权访问资源的人，通常就是用户 | 网盘用户 |
| **Client**（客户端） | 代表用户（或代表自己）访问资源的应用 | 第三方相册应用、后台任务 |
| **Authorization Server**（授权服务器） | 认证用户、征得同意并签发令牌 | Keycloak、Spring Authorization Server、云厂商 IAM |
| **Resource Server**（资源服务器） | 持有受保护资源，校验令牌后提供 API | 网盘文件 API、订单服务 |

按能否保管密钥，客户端分为两类，这直接决定了能用哪些授权模式和客户端认证方式：

| 类型 | 特点 | 典型形态 | 客户端认证 |
|------|------|----------|------------|
| **机密客户端**（Confidential） | 运行在服务端，能安全保存凭证 | 有后端的 Web 应用、BFF、微服务 | `client_secret_basic`、`private_key_jwt`（RFC 7523）、mTLS（RFC 8705） |
| **公共客户端**（Public） | 代码在用户设备上，任何内置密钥都能被提取 | SPA、移动 App、桌面程序、CLI | 无（`none`），只能靠 PKCE 与重定向地址约束 |

授权服务器对外的核心端点有两个：**授权端点**（`/authorize`，浏览器访问，走前端通道）和**令牌端点**（`/token`，客户端后端直连，走后端通道）。另外还有可选的撤销端点（RFC 7009）、内省端点（RFC 7662）、设备授权端点（RFC 8628）和元数据端点 `/.well-known/oauth-authorization-server`（RFC 8414）。

---

## 三、令牌与 scope

### 1、access token 与 refresh token

| | access token | refresh token |
|---|---|---|
| 用途 | 调用资源服务器 API | 到令牌端点换新的 access token |
| 发给谁 | 资源服务器 | 只发给授权服务器，绝不发给资源服务器 |
| 有效期 | 短，通常 5～15 分钟 | 长，数小时到数十天，可设空闲超时 |
| 格式 | JWT（RFC 9068）或不透明字符串 | 通常是不透明随机串 |
| 泄露后果 | 在有效期内可被冒用 | 能持续换出新令牌，危害更大，必须轮换或绑定发送方 |

令牌端点的标准响应：

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMTAifQ...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIA",
  "scope": "order.read"
}
```

`token_type` 为 `Bearer` 时，谁拿到令牌谁就能用（RFC 6750），调用方式是 `Authorization: Bearer <token>`；OAuth 2.1 禁止把令牌放在 URL 查询参数里。为 `DPoP` 时令牌与客户端私钥绑定，见第八节。

### 2、scope 与 audience

- **scope** 描述"允许做什么"，是空格分隔的字符串，含义由授权服务器和资源服务器约定，例如 `order.read order.write`。按最小权限申请，用户同意页会逐项展示
- **audience**（JWT 的 `aud`）描述"令牌给谁用"。资源服务器必须校验 `aud` 是自己，否则发给 A 服务的令牌可以拿去调 B 服务。客户端可以用 Resource Indicators（RFC 8707）的 `resource` 参数为指定资源服务器申请令牌
- scope 不是用户权限：令牌的实际权限 = 用户本身拥有的权限 ∩ 客户端被授予的 scope。细粒度的"能操作哪些数据"仍由资源服务器的权限模型决定，见 [权限模型：RBAC 与 ABAC](./5_rbac_abac)

---

## 四、授权模式总览

RFC 6749 定义了四种经典授权模式（授权码、隐式、密码、客户端凭证），另有刷新令牌机制；后续 RFC 又扩展了设备码、令牌交换等模式。OAuth 2.1 删掉了两种不安全的经典模式：

| 授权模式 | `grant_type` | 适用场景 | OAuth 2.1 / RFC 9700 |
|----------|--------------|----------|----------------------|
| 授权码 + PKCE | `authorization_code` | 有用户参与的一切客户端：Web、SPA、App | 保留，**所有客户端都必须用 PKCE** |
| 客户端凭证 | `client_credentials` | 服务间调用、后台任务，没有用户 | 保留 |
| 设备码（RFC 8628） | `urn:ietf:params:oauth:grant-type:device_code` | 电视、CLI、IoT 等不便输入的设备 | 作为扩展继续使用 |
| 刷新令牌 | `refresh_token` | 续期 access token（不是独立的授权方式） | 保留，公共客户端须轮换或绑定发送方 |
| 令牌交换（RFC 8693） | `urn:ietf:params:oauth:grant-type:token-exchange` | 服务 A 拿用户令牌换一个调用服务 B 的令牌（委托 / 降权） | 作为扩展继续使用 |
| 隐式（Implicit） | 无（`response_type=token`） | 早期 SPA | **已删除**：令牌出现在 URL 片段，易经历史记录、Referer 泄露，且无法绑定客户端 |
| 密码（ROPC） | `password` | 早期自家 App | **已删除**：客户端直接接触用户密码，无法支持 MFA，与 OAuth 初衷相悖 |

旧系统还在用隐式或密码模式的，SPA 改为授权码 + PKCE（最好配合 BFF），自家 App 也改为授权码 + PKCE（通过系统浏览器）。Spring Security 7 的 OAuth2 客户端已经移除了密码模式支持。

---

## 五、授权码 + PKCE

### 1、流程

![OAuth 2 授权码 + PKCE 流程](../assets/security/oauth2-auth-code-pkce-flow.svg)

授权码模式把流程拆成两段：**前端通道**经过浏览器，只传递一次性、短时效（通常不超过 1 分钟）的 code；**后端通道**由客户端直连令牌端点，用 code 换令牌，令牌不经过浏览器。所以说"令牌不经过浏览器"，但 code 是经过浏览器的，这正是需要 PKCE 的原因。

第 ② 步的授权请求：

```http
GET /oauth2/authorize?response_type=code
    &client_id=portal-web
    &redirect_uri=https%3A%2F%2Fportal.example.com%2Flogin%2Foauth2%2Fcode%2Fportal
    &scope=order.read
    &state=af0ifjsldkj
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    &code_challenge_method=S256 HTTP/1.1
Host: auth.example.com
```

第 ⑤ 步的令牌请求（机密客户端用 HTTP Basic 认证自己）：

```http
POST /oauth2/token HTTP/1.1
Host: auth.example.com
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=SplxlOBeZQQYbYS6WxSbIA
&redirect_uri=https%3A%2F%2Fportal.example.com%2Flogin%2Foauth2%2Fcode%2Fportal
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

### 2、PKCE 原理

PKCE（Proof Key for Code Exchange，RFC 7636）让客户端证明"来换令牌的就是当初发起授权的那个客户端"：

1. 客户端每次发起授权前生成一个高熵随机串 `code_verifier`（43～128 个字符）
2. 计算 `code_challenge = BASE64URL(SHA256(code_verifier))`，随授权请求发出，授权服务器把它和 code 关联保存
3. 换令牌时带上原始 `code_verifier`，授权服务器重新计算并比对，不一致就拒绝

攻击者即使截获了 code（恶意 App 注册相同的自定义 URL Scheme、日志或 Referer 泄露），没有 `code_verifier` 也换不出令牌。`code_challenge_method` 必须用 `S256`，`plain` 只用于无法计算 SHA-256 的极端环境。

```java
SecureRandom random = new SecureRandom();
byte[] bytes = new byte[32];
random.nextBytes(bytes);
String codeVerifier = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);

byte[] digest = MessageDigest.getInstance("SHA-256")
        .digest(codeVerifier.getBytes(StandardCharsets.US_ASCII));
String codeChallenge = Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
```

实际项目不用手写，Spring Security、各语言 OAuth 客户端库都会自动生成。

### 3、为什么机密客户端也要 PKCE

早期把 PKCE 当成"移动端 / SPA 专用"，因为机密客户端有 client_secret。RFC 9700 和 OAuth 2.1 要求**所有客户端都用 PKCE**，因为它还能防**授权码注入**：攻击者把自己账号的 code 塞进受害者的回调，client_secret 挡不住这种攻击，PKCE 能挡住（code 与发起会话的 verifier 绑定）。PKCE 也因此可以替代 `state` 防 CSRF 的作用，但 `state` 仍常用来携带回跳地址等应用状态，建议照常使用。

---

## 六、客户端凭证、设备码与刷新令牌

![客户端凭证、刷新令牌与设备码](../assets/security/oauth2-other-grants.svg)

### 1、客户端凭证（Client Credentials）

没有用户参与，客户端以自己的身份申请令牌，只能用于机密客户端：

```http
POST /oauth2/token HTTP/1.1
Host: auth.example.com
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=order.read
```

- 令牌代表的是"服务 A"，不是某个用户；需要把用户身份带到下游时，用令牌交换（RFC 8693）而不是透传用户令牌
- 不返回 refresh token，过期了直接再申请；客户端应缓存令牌到过期前再刷新，别每次调用都换
- 生产环境优先用 `private_key_jwt` 或 mTLS 做客户端认证，比共享的 client_secret 更好轮换

### 2、设备码（Device Authorization Grant，RFC 8628）

设备先向设备授权端点申请 `device_code`（设备自己留着）和 `user_code`（展示给用户），用户在手机浏览器打开 `verification_uri` 输入 `user_code` 并登录授权；设备按返回的 `interval` 轮询令牌端点，期间收到 `authorization_pending`（继续等）或 `slow_down`（加大间隔），用户同意后拿到令牌。智能电视登录、`gh auth login`、`az login --use-device-code` 都是这个模式。扫码登录与它思路一致，见 [扫码登录](/scenario/18_qr_login)。

### 3、刷新令牌（Refresh Token）

access token 过期后，客户端用 `grant_type=refresh_token` 换新令牌，用户无感知。要点：

- **轮换**（rotation）：每次刷新都签发新的 refresh token 并作废旧的。若旧 refresh token 再次出现（**重用检测**），说明它已被窃取，授权服务器应吊销这条授权链上的所有令牌
- **绑定发送方**：公共客户端的 refresh token 要么轮换，要么用 DPoP 绑定，二选一（OAuth 2.1 要求）
- **有效期**：设置绝对过期时间和空闲超时；用户改密码、注销、被禁用时主动吊销
- 刷新时可以申请更小的 scope，不能申请比原授权更大的 scope

---

## 七、资源服务器如何校验令牌

| 方式 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **JWT 本地验签**（RFC 9068） | 从 `jwks_uri` 拉公钥缓存，本地校验签名、`iss`、`aud`、`exp` | 不访问授权服务器，延迟低，可水平扩展 | 签发后无法立即作废，只能靠短有效期或黑名单 |
| **不透明令牌 + Introspection**（RFC 7662） | 每次（或带缓存）调用授权服务器的内省端点，返回 `active` 与 claims | 吊销实时生效，令牌内容不外泄 | 每个请求多一次网络调用，授权服务器成为热点 |

```http
POST /oauth2/introspect HTTP/1.1
Host: auth.example.com
Authorization: Basic <base64(resource_server_id:secret)>
Content-Type: application/x-www-form-urlencoded

token=2YotnFZFEjr1zCsicMWpAA
```

```json
{
  "active": true,
  "client_id": "portal-web",
  "sub": "248289761001",
  "scope": "order.read",
  "aud": "order-service",
  "exp": 1791625200
}
```

常见的组合是：对外网关做 Introspection 或把不透明令牌换成内部 JWT（Phantom Token 模式），内部服务之间用短期 JWT 本地验签。用户登出、客户端下线时调用撤销端点（RFC 7009）作废 refresh token；JWT access token 的提前作废方案见 [JWT 令牌机制](./1_jwt)。

---

## 八、安全最佳实践（RFC 9700）

RFC 9700 汇总了十多年来针对 OAuth 的真实攻击和对策，OAuth 2.1 把其中大部分变成了硬性要求：

| 风险 | 攻击方式 | 对策 |
|------|----------|------|
| 重定向地址篡改 | 授权服务器做前缀或通配匹配，攻击者注册 `https://app.example.com.evil.com` 之类的地址截获 code | `redirect_uri` **精确字符串匹配**（只有原生 App 的回环地址允许端口可变），禁止通配符 |
| 开放重定向 | 客户端或授权服务器存在不校验目标的跳转接口，被串联用来外泄 code 或令牌 | 客户端不提供开放跳转；授权服务器对无效请求不自动跳回 |
| 授权码截获与注入 | 恶意 App 劫持回调、把攻击者的 code 塞进受害者会话 | 所有客户端使用 PKCE（S256），code 一次性且短时效，重复使用时吊销已签发令牌 |
| CSRF | 诱导用户的浏览器完成攻击者发起的授权 | PKCE + `state`（不可预测、与用户会话绑定） |
| 混淆攻击（Mix-Up） | 客户端对接多个授权服务器时，被骗把 code 发给错误的一方 | 校验授权响应中的 `iss` 参数（RFC 9207），每个授权服务器用不同的 `redirect_uri` |
| 令牌泄露与重放 | Bearer 令牌被日志、代理、XSS 窃取后直接冒用 | 短有效期、校验 `aud`、令牌不进 URL；高安全场景用**发送方约束令牌**（DPoP 或 mTLS） |
| refresh token 被盗 | 长效令牌被持续用来换新令牌 | 轮换 + 重用检测，或绑定发送方 |
| 权限过大 | 申请超出需要的 scope，令牌泄露后影响面大 | 最小权限 scope，按资源服务器限定 `aud` |
| 浏览器端存令牌 | SPA 把令牌放在 localStorage，一个 XSS 就全部泄露 | 采用 BFF：令牌留在服务端，浏览器只持有 HttpOnly + Secure + SameSite 的会话 Cookie |

### 发送方约束令牌：DPoP 与 mTLS

Bearer 令牌的根本问题是"谁拿到谁能用"。发送方约束（sender-constrained）让令牌只能由持有特定密钥的客户端使用：

- **DPoP**（RFC 9449）：客户端生成一对密钥，每个请求都附带一个用私钥签名的 `DPoP` 证明头（一个短 JWT，包含 HTTP 方法 `htm`、目标地址 `htu`、时间 `iat`、唯一 `jti`，调用资源服务器时还要带令牌哈希 `ath`）。授权服务器把公钥指纹写进令牌的 `cnf.jkt`，资源服务器校验证明头的签名和指纹是否匹配。调用方式变为 `Authorization: DPoP <token>` 加 `DPoP: <proof>`。工作在应用层，适合 SPA 和移动端
- **mTLS**（RFC 8705）：客户端用证书建立双向 TLS，令牌里记录证书指纹 `cnf.x5t#S256`，资源服务器比对当前连接的客户端证书。适合服务间调用和金融级场景，前提是有证书体系，见 [零信任架构](./9_zero_trust) 和 [HTTPS 与 TLS](/protocols/3_https_tls)

Spring Security 资源服务器已支持校验 DPoP 绑定的访问令牌（JWT 与不透明令牌均可），Spring Authorization Server 也能签发 DPoP 绑定令牌。

::: warning BFF 是浏览器应用的首选
SPA 直接做公共客户端（授权码 + PKCE，令牌存在 JS 内存）在规范上可行，但任何 XSS 都能拿到令牌。IETF 的《OAuth 2.0 for Browser-Based Applications》草案把 BFF（Backend for Frontend）列为最推荐的架构：OAuth 流程和令牌都在后端完成，浏览器与 BFF 之间用会话 Cookie，再配合 CSRF 防护，见 [常见漏洞与防护](./8_vulnerabilities)。
:::

---

## 九、Spring 落地

Spring Boot 4 的三个 OAuth starter（旧名 `spring-boot-starter-oauth2-*` 已废弃）：

| 角色 | starter | 主要 DSL |
|------|---------|----------|
| 客户端（登录 + 调下游） | `spring-boot-starter-security-oauth2-client` | `oauth2Login()`、`oauth2Client()` |
| 资源服务器 | `spring-boot-starter-security-oauth2-resource-server` | `oauth2ResourceServer()` |
| 授权服务器 | `spring-boot-starter-security-oauth2-authorization-server` | `oauth2AuthorizationServer()` |

### 1、客户端：登录与调用下游 API

一个门户应用：用户通过授权码模式登录，后台再用客户端凭证调订单服务。两个注册共用同一个授权服务器：

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          portal:                                   # 用户登录：授权码模式
            provider: auth
            client-id: portal-web
            client-secret: ${PORTAL_CLIENT_SECRET}
            authorization-grant-type: authorization_code
            scope: openid, profile, order.read      # 带 openid 即走 OIDC 登录
          order-api:                                # 服务间调用：客户端凭证模式
            provider: auth
            client-id: portal-backend
            client-secret: ${PORTAL_BACKEND_SECRET}
            authorization-grant-type: client_credentials
            scope: order.read
        provider:
          auth:
            issuer-uri: https://auth.example.com    # 启动时读取元数据，自动发现各端点
```

```java
import static org.springframework.security.oauth2.client.web.client.RequestAttributeClientRegistrationIdResolver.clientRegistrationId;

@Configuration
@EnableWebSecurity
public class OAuth2ClientConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/", "/error").permitAll()
                .anyRequest().authenticated())
            .oauth2Login(Customizer.withDefaults())     // 授权码登录，回调地址 /login/oauth2/code/{registrationId}
            .oauth2Client(Customizer.withDefaults())
            .build();
    }

    @Bean
    RestClient orderRestClient(RestClient.Builder builder, OAuth2AuthorizedClientManager manager) {
        return builder
            .baseUrl("https://order.example.com")
            .requestInterceptor(new OAuth2ClientHttpRequestInterceptor(manager))  // 自动获取、缓存、刷新令牌
            .build();
    }
}

@Service
class OrderClient {

    private final RestClient orderRestClient;

    OrderClient(RestClient orderRestClient) {
        this.orderRestClient = orderRestClient;
    }

    String findOrder(long id) {
        return orderRestClient.get()
            .uri("/orders/{id}", id)
            .attributes(clientRegistrationId("order-api"))   // 指定用哪个注册换令牌
            .retrieve()
            .body(String.class);
    }
}
```

- `OAuth2ClientHttpRequestInterceptor` 按注册的 `authorization-grant-type` 获取令牌，过期前自动刷新，并加上 `Authorization` 头
- 若下游用 HTTP Interface 声明，可在接口或方法上加 `@ClientRegistrationId("order-api")`，再注册一个 `OAuth2RestClientHttpServiceGroupConfigurer.from(manager)` Bean，效果相同（Spring Security 7 支持类型级注解）
- 默认的 `OAuth2AuthorizedClientManager` 依赖当前 HTTP 请求；在定时任务等没有请求上下文的线程里调用客户端凭证，需要自定义一个 `AuthorizedClientServiceOAuth2AuthorizedClientManager`
- 授权码登录的 PKCE：公共客户端（不配 `client-secret`、`client-authentication-method: none`）自动启用；机密客户端可在 `ClientRegistration` 的 `ClientSettings` 上设置 `requireProofKey(true)`，前提是授权服务器支持

### 2、资源服务器

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com   # 自动获取 JWK Set，并校验 iss
          audiences: order-service               # 校验 aud
        # 不透明令牌改用 Introspection：
        # opaquetoken:
        #   introspection-uri: https://auth.example.com/oauth2/introspect
        #   client-id: order-service
        #   client-secret: ${ORDER_SERVICE_SECRET}
```

```java
@Bean
SecurityFilterChain apiFilterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(a -> a
            .requestMatchers(HttpMethod.GET, "/orders/**").hasAuthority("SCOPE_order.read")
            .requestMatchers("/orders/**").hasAuthority("SCOPE_order.write")
            .anyRequest().authenticated())
        .oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()))
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .build();
}
```

默认把 `scope` claim 映射成 `SCOPE_xxx` 权限。Keycloak 角色映射、网关作为资源服务器的写法见 [Spring SSO 接入](/spring/11_single_sign_on) 和 [Spring Security](/spring/9_security)。

### 3、授权服务器

Spring Authorization Server 自 **Spring Security 7.0 起并入 Spring Security 主项目**，坐标为 `org.springframework.security:spring-security-oauth2-authorization-server`，版本跟随 Spring Security；授权码模式默认要求 PKCE。开发环境用属性就能注册客户端：

```yaml
spring:
  security:
    oauth2:
      authorizationserver:
        issuer: https://auth.example.com
        client:
          portal-web:
            registration:
              client-id: portal-web
              client-secret: ${PORTAL_CLIENT_SECRET_HASH}   # 存 {bcrypt} 前缀的哈希，不存明文
              client-authentication-methods: client_secret_basic
              authorization-grant-types: authorization_code, refresh_token
              redirect-uris: https://portal.example.com/login/oauth2/code/portal
              scopes: openid, profile, order.read
            require-authorization-consent: true
          portal-backend:
            registration:
              client-id: portal-backend
              client-secret: ${PORTAL_BACKEND_SECRET_HASH}
              client-authentication-methods: client_secret_basic
              authorization-grant-types: client_credentials
              scopes: order.read
```

Boot 会自动配置协议端点过滤器链、表单登录和内存版客户端存储，适合本地联调。生产环境需要两条过滤器链、JDBC 持久化客户端与授权记录、固定并轮换签名密钥，完整代码见 [Spring SSO 接入：Spring Authorization Server 实战](/spring/11_single_sign_on#七、spring-authorization-server-实战)。

---

## 小结

- OAuth 2 是授权委托框架，核心产物是带 scope、audience 和有效期的 access token；"你是谁"交给 OIDC
- OAuth 2.1 仍是草案，但方向已定：只保留授权码 + PKCE、客户端凭证和刷新令牌，隐式与密码模式删除；设备码、令牌交换作为扩展照常使用
- 授权码模式的 code 走前端通道、令牌走后端通道；PKCE 对所有客户端都必须，它同时防授权码截获和授权码注入
- refresh token 要轮换并做重用检测；资源服务器在 JWT 本地验签和 Introspection 之间按"吊销实时性 vs 性能"取舍，并始终校验 `aud`
- RFC 9700 的关键要求：`redirect_uri` 精确匹配、令牌不进 URL、多授权服务器校验 `iss`、高安全场景用 DPoP / mTLS 约束令牌；浏览器应用优先 BFF
- Spring Security 7 一个体系覆盖三种角色：`oauth2Login` / `oauth2Client` + `RestClient` 拦截器、`oauth2ResourceServer`、内置的 Spring Authorization Server

## 参考资料

- OAuth 2.0 核心框架：[RFC 6749 - The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- Bearer 令牌：[RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
- PKCE：[RFC 7636 - Proof Key for Code Exchange](https://datatracker.ietf.org/doc/html/rfc7636)
- 安全最佳实践：[RFC 9700 - Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)
- OAuth 2.1 草案：[draft-ietf-oauth-v2-1 - The OAuth 2.1 Authorization Framework](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- 令牌撤销与内省：[RFC 7009 - Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)、[RFC 7662 - Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
- JWT 访问令牌：[RFC 9068 - JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
- 设备码与令牌交换：[RFC 8628 - Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)、[RFC 8693 - Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- 发送方约束令牌：[RFC 9449 - DPoP](https://datatracker.ietf.org/doc/html/rfc9449)、[RFC 8705 - Mutual-TLS Client Authentication and Certificate-Bound Access Tokens](https://datatracker.ietf.org/doc/html/rfc8705)
- 授权服务器元数据与 iss 参数：[RFC 8414 - Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)、[RFC 9207 - Authorization Server Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207)
- 资源指示：[RFC 8707 - Resource Indicators for OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc8707)
- 浏览器应用架构：[OAuth 2.0 for Browser-Based Applications（IETF 草案）](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)
- Spring Security OAuth2 Client：[OAuth2 Authorized Clients](https://docs.spring.io/spring-security/reference/servlet/oauth2/client/authorized-clients.html)、[HTTP Service Clients Integration](https://docs.spring.io/spring-security/reference/features/integrations/rest/http-service-client.html)
- Spring Security 资源服务器 DPoP：[DPoP-bound Access Tokens](https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/dpop-tokens.html)
- Spring Authorization Server：[OAuth 2.0 Authorization Server - Getting Started](https://docs.spring.io/spring-security/reference/servlet/oauth2/authorization-server/getting-started.html)
- Spring Security 7.0 新特性：[What's New in Spring Security 7.0](https://docs.spring.io/spring-security/reference/7.0/whats-new.html)

> 下一篇：[OIDC](./3_oidc) —— 在 OAuth 2 之上加一层身份认证：ID Token、Discovery 与第三方登录。

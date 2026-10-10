---
description: ID Token、登录流程与校验、nonce、Discovery 与 JWKS、UserInfo、Spring 接入
---

# OIDC

> **本篇目标**：理解 OIDC 在 OAuth 2 之上加了什么；分清 ID Token 与 Access Token 的用途和校验方式；走通授权码 + PKCE 的登录流程，知道 state、nonce、PKCE 各防什么；会用 Discovery 与 JWKS 自动对接 IdP，并用 Spring Boot 的 `oauth2Login` 完成 OIDC 登录与登出。
>
> **前置阅读**：[OAuth2](./2_oauth2)（角色、授权码 + PKCE）、[JWT 令牌机制](./1_jwt)（JWT 结构与签名）

OIDC（OpenID Connect）是建立在 OAuth 2 之上的**身份认证层**：OAuth 2 回答"这个客户端能访问什么"，OIDC 回答"当前登录的用户是谁"。本篇以 OpenID Connect Core 1.0（含 2023 年 12 月的勘误集 2）为准，配套规范包括 Discovery 1.0、RP-Initiated / Front-Channel / Back-Channel Logout 1.0；框架代码以 Spring Boot 4 / Spring Security 7 为准。多个系统共用一次登录的整体方案见 [单点登录](./4_sso)。

---

## 一、OIDC 在 OAuth 2 上加了什么

OIDC 没有发明新的授权流程，而是在 OAuth 2 授权码流程上做了几处标准化扩展：

| 扩展 | 内容 |
|------|------|
| `openid` scope | 授权请求的 scope 包含 `openid` 即表示这是一次 OIDC 认证请求 |
| **ID Token** | 令牌端点额外返回一个 JWT，描述"谁、何时、如何"完成了登录 |
| UserInfo 端点 | 用 access token 获取用户资料的标准接口 |
| 标准 claims 与 scope | `profile`、`email`、`address`、`phone` 等 scope 对应一组约定好的 claim |
| Discovery 与 JWKS | 元数据和签名公钥的标准发布方式（Discovery 是独立规范） |
| 会话管理与登出 | RP 发起登出、前端通道 / 后端通道登出等配套规范 |

角色名称也随之变化：授权服务器在 OIDC 里叫 **OP**（OpenID Provider，也常被称为 IdP），客户端叫 **RP**（Relying Party），用户叫 **End-User**。

| 对比 | OAuth 2 | OIDC |
|------|---------|------|
| 解决的问题 | 授权：能访问什么 | 认证：你是谁 |
| 核心产物 | access token | access token + **ID Token** |
| 用户身份 | 没有标准，各家自定义"取用户信息"接口 | ID Token 的 `iss` + `sub` 唯一标识用户 |
| 典型场景 | 第三方应用访问用户的资源 | 企业 SSO、"用 XX 账号登录" |

---

## 二、ID Token 与 Access Token

两者都可能是 JWT，但给谁看、用来做什么完全不同：

| | ID Token | Access Token |
|---|---|---|
| 接收方（`aud`） | RP 自己（`aud` 是 RP 的 `client_id`） | 资源服务器（API） |
| 用途 | 让 RP 确认登录结果，建立本地会话 | 调用 API |
| 格式 | 规范要求必须是 JWT | JWT 或不透明串，由 OP 决定 |
| 谁来校验 | RP | 资源服务器 |
| 能否发给 API | **不能** | 能，这就是它的用途 |

::: warning 不要把 ID Token 当 API 令牌
ID Token 的 `aud` 是 RP 的 client_id，资源服务器若接受它，就等于接受"发给别人的凭证"，任何拿到某个 RP 的 ID Token 的人都能冒充用户调 API。调用 API 一律用 access token，资源服务器校验 access token 的 `aud`。同理，RP 也不应该靠解析 access token 来确认用户身份，access token 的内容对客户端来说应视为不透明。
:::

ID Token 解码后的 payload：

```jsonc
{
  "iss": "https://auth.example.com/realms/demo",   // 签发方，必须与 Discovery 中的 issuer 完全一致
  "sub": "f3c2a6e1-7b8d-4c3e-9a51-2d0e8b6f4a17",   // 用户在该 OP 下的唯一、稳定标识
  "aud": "portal-web",                              // 受众：RP 的 client_id
  "azp": "portal-web",                              // 授权方，aud 有多个值时用来确认
  "exp": 1791625200,                                // 过期时间
  "iat": 1791624900,                                // 签发时间
  "auth_time": 1791624880,                          // 用户实际完成认证的时间
  "nonce": "n-0S6_WzA2Mj",                          // RP 在授权请求中带的随机值，原样返回
  "acr": "urn:example:mfa",                         // 认证上下文等级，如是否经过 MFA
  "amr": ["pwd", "otp"],                            // 实际使用的认证方式
  "at_hash": "77QmUPtjPfzWtF2AnpK9RQ",              // 同时签发的 access token 的哈希
  "name": "Zhang San",
  "email": "zhangsan@example.com"
}
```

几个容易用错的点：

- **用户唯一标识是 `iss` + `sub`**，不是 `email` 或 `preferred_username`：邮箱可改、可重复注册，用它关联本地账号会导致账号接管
- `auth_time` 与 `acr` 用于"敏感操作要求最近登录过 / 必须经过 MFA"，授权请求可以用 `max_age`、`acr_values` 提出要求，RP 必须在 ID Token 里核对结果
- 用户资料类 claim（`name`、`email`）是否出现在 ID Token 里由 OP 决定，拿不到时去 UserInfo 端点取

---

## 三、登录流程（授权码 + PKCE）

![OIDC 登录流程](../assets/security/oidc-login-flow.svg)

1. 用户访问 RP 的受保护页面，RP 发现没有本地会话
2. RP 生成 `state`、`nonce`、`code_verifier` 并存入会话，把浏览器重定向到 OP 的授权端点：`response_type=code`、`client_id`、`redirect_uri`、`scope=openid profile`、`state`、`nonce`、`code_challenge` + `code_challenge_method=S256`
3. 用户在 OP 登录并同意授权；若 OP 上已有全局会话（例如刚登录过另一个系统），这一步自动跳过，这就是 SSO 的来源
4. OP 302 回 `redirect_uri`，带上一次性的 `code` 和原样的 `state`
5. RP 核对 `state` 与会话中保存的一致
6. RP 后端直连令牌端点，提交 `code` + `code_verifier`，并完成客户端认证（`client_secret_basic`、`private_key_jwt` 等；公共客户端无此项）
7. OP 返回 ID Token、access token，以及可选的 refresh token
8. RP 校验 ID Token，通过后建立本地会话
9. 需要更多用户资料时，用 access token 调 UserInfo 端点

第 8 步的校验清单（OIDC Core 3.1.3.7），任何一项失败都必须拒绝登录：

- 用 OP 的 JWKS 公钥按 Header 中的 `kid`、`alg` 验签，`alg` 必须在双方约定的范围内（拒绝 `none`）
- `iss` 与 OP 的 issuer 完全一致
- `aud` 包含自己的 `client_id`；`aud` 有多个值时检查 `azp`
- `exp` 未过期，`iat` 在合理范围内（允许少量时钟偏差）
- `nonce` 与本次请求时保存的值一致
- 有 `at_hash` 时可校验它与 access token 匹配；有 `max_age` / `acr_values` 要求时核对 `auth_time` / `acr`

规范允许"通过 TLS 直连令牌端点拿到的 ID Token"以服务端证书校验代替验签，但主流库都会照常验签，没有理由关掉。

---

## 四、state、nonce 与 PKCE 各防什么

三个随机值经常被混为一谈，实际各管一段：

| 参数 | 绑定对象 | 防御的攻击 | 谁校验 |
|------|----------|------------|--------|
| `state` | 授权请求 ↔ 回调 | 登录 CSRF：攻击者让受害者的浏览器完成攻击者发起的登录；也用来携带回跳地址 | RP 在回调时 |
| `nonce` | 授权请求 ↔ ID Token | ID Token 重放与注入：把别处截获的 ID Token 塞进当前登录 | RP 在验 ID Token 时 |
| PKCE | 授权请求 ↔ 令牌请求 | 授权码截获与注入：截获的 code 无法在别的会话中兑换 | OP 在令牌端点 |

在授权码 + PKCE 流程里，PKCE 已经覆盖了大部分 `nonce` 防的场景，但 OIDC Core 仍要求在隐式和混合流程中必须带 `nonce`，主流 RP 库（包括 Spring Security）在授权码流程中也默认生成并校验，保持开启即可。

---

## 五、Discovery 与 JWKS

### 1、Discovery

OpenID Connect Discovery 1.0 是独立于 Core 的规范，只对支持动态注册的 OP 强制，但 Keycloak、Entra ID、Okta、Google 等主流 IdP 都提供。元数据固定发布在 issuer 后面的 `/.well-known/openid-configuration`：

```http
GET /realms/demo/.well-known/openid-configuration HTTP/1.1
Host: auth.example.com
```

```json
{
  "issuer": "https://auth.example.com/realms/demo",
  "authorization_endpoint": "https://auth.example.com/realms/demo/protocol/openid-connect/auth",
  "token_endpoint": "https://auth.example.com/realms/demo/protocol/openid-connect/token",
  "userinfo_endpoint": "https://auth.example.com/realms/demo/protocol/openid-connect/userinfo",
  "jwks_uri": "https://auth.example.com/realms/demo/protocol/openid-connect/certs",
  "end_session_endpoint": "https://auth.example.com/realms/demo/protocol/openid-connect/logout",
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "id_token_signing_alg_values_supported": ["RS256", "ES256"],
  "backchannel_logout_supported": true
}
```

客户端只需配置 issuer，其余端点自动发现。规范要求返回的 `issuer` 必须与请求所用的 issuer 完全一致（包括结尾斜杠），这是防止元数据被替换的关键检查，反向代理改写域名时最容易在这里出错。

### 2、JWKS 与密钥轮换

`jwks_uri` 返回 OP 当前的签名公钥集合：

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "2026-10",
      "use": "sig",
      "alg": "RS256",
      "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      "e": "AQAB"
    }
  ]
}
```

RP 应缓存 JWKS，遇到不认识的 `kid` 时重新拉取一次（OP 轮换密钥时会先发布新公钥，过渡期新旧并存），而不是每次验签都请求。Spring Security 的 `NimbusJwtDecoder` 默认就是这样处理的。签名算法选择与密钥轮换的细节见 [JWT 令牌机制](./1_jwt)。

---

## 六、UserInfo 与标准 Claims

标准 scope 与 claim 的对应关系（OIDC Core 5.4）：

| scope | 返回的 claim |
|-------|--------------|
| `openid` | `sub`（必需，表示这是 OIDC 请求） |
| `profile` | `name`、`family_name`、`given_name`、`preferred_username`、`picture`、`locale`、`zoneinfo`、`updated_at` 等 |
| `email` | `email`、`email_verified` |
| `phone` | `phone_number`、`phone_number_verified` |
| `address` | `address`（结构化对象） |
| `offline_access` | 不是 claim，用来申请可在用户离线时使用的 refresh token |

```http
GET /realms/demo/protocol/openid-connect/userinfo HTTP/1.1
Host: auth.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMTAifQ...
```

```json
{
  "sub": "f3c2a6e1-7b8d-4c3e-9a51-2d0e8b6f4a17",
  "name": "Zhang San",
  "preferred_username": "zhangsan",
  "email": "zhangsan@example.com",
  "email_verified": true
}
```

UserInfo 返回的 `sub` **必须与 ID Token 的 `sub` 一致**，不一致说明响应被替换，要丢弃。用 `email` 关联本地账号前先检查 `email_verified`，否则攻击者可以在 OP 上注册一个他人邮箱来接管账号。

---

## 七、会话与登出

OIDC 的登出分三类：**RP 发起登出**（RP-Initiated Logout，RP 把浏览器重定向到 OP 的 `end_session_endpoint`，带 `id_token_hint` 和 `post_logout_redirect_uri`，结束 OP 上的全局会话）、**前端通道登出**（Front-Channel Logout，OP 在浏览器里用隐藏 iframe 依次加载各 RP 的登出地址，受第三方 Cookie 限制影响越来越不可靠）和**后端通道登出**（Back-Channel Logout，OP 直接向各 RP 的登出端点 POST 一个签名的 `logout_token`，RP 据其中的 `sid` / `sub` 销毁本地会话，生产环境推荐）。这三者在多系统场景下怎么组合、各自的坑和"短会话 + 静默续期"的降级方案，统一在 [单点登录](./4_sso) 中讲解。

---

## 八、常见 OIDC Provider

应用侧的对接方式都一样（配置 issuer、client_id、client_secret），差异主要在部署形态和管理能力：

| Provider | 形态 | 特点 |
|----------|------|------|
| Keycloak | 开源自建（Apache 2.0） | CNCF 孵化项目，支持 OIDC / OAuth 2 / SAML 2.0、LDAP / AD 联邦、社交登录，功能全面；Red Hat 提供商业支持版 |
| Spring Authorization Server | 开源框架，自己写授权服务 | 已并入 Spring Security 7，适合需要深度定制登录流程和令牌内容的场景，见 [OAuth2](./2_oauth2) |
| Microsoft Entra ID | 云服务 | 原 Azure AD（2023 年更名），企业 Microsoft 365 体系的身份中心；issuer 形如 `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| Auth0 / Okta | 云服务 | 同属 Okta 公司，Auth0 偏面向开发者与 C 端应用，Okta 偏企业员工身份 |
| Google | 云服务 | 标准 OIDC Provider，常用于"用 Google 账号登录" |
| Authing | 国内云服务 | 国内 IDaaS，支持 OIDC / OAuth 2 / SAML / CAS，提供中文文档与私有化部署 |
| MaxKey | 国产开源自建 | Dromara 社区项目，支持 OIDC / OAuth 2 / SAML 2.0 / CAS，中文界面 |

国内的微信、QQ 等"开放平台登录"大多基于 OAuth 2 自定义扩展，不返回标准 ID Token，需要按各平台文档单独对接，不能当作标准 OIDC Provider 配置。

---

## 九、Spring Boot 接入

引入 `spring-boot-starter-security-oauth2-client`，`registration` 与 `provider` 用同一个 ID 关联：

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:                                  # registrationId，回调地址为 /login/oauth2/code/keycloak
            client-id: portal-web
            client-secret: ${PORTAL_CLIENT_SECRET}
            authorization-grant-type: authorization_code
            scope: openid, profile, email            # 必须包含 openid 才会走 OIDC
        provider:
          keycloak:
            issuer-uri: https://auth.example.com/realms/demo   # 读取 Discovery，自动配置各端点与 JWKS
```

```java
@Configuration
@EnableWebSecurity
public class OidcLoginConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http,
                                            ClientRegistrationRepository registrations) throws Exception {
        // RP 发起登出：本地会话销毁后，重定向到 OP 的 end_session_endpoint 并带上 id_token_hint
        OidcClientInitiatedLogoutSuccessHandler logoutSuccessHandler =
            new OidcClientInitiatedLogoutSuccessHandler(registrations);
        logoutSuccessHandler.setPostLogoutRedirectUri("{baseUrl}/");

        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/", "/error").permitAll()
                .anyRequest().authenticated())
            .oauth2Login(Customizer.withDefaults())
            .logout(l -> l.logoutSuccessHandler(logoutSuccessHandler))
            .build();
    }
}

@RestController
class MeController {

    record Me(String sub, String name, String email) {}

    @GetMapping("/me")
    Me me(@AuthenticationPrincipal OidcUser user) {
        return new Me(user.getSubject(), user.getFullName(), user.getEmail());
    }
}
```

Spring Security 在这套配置下自动完成的事：

- 生成 `state` 与 `nonce`，回调时核对；公共客户端自动启用 PKCE
- 用 JWKS 校验 ID Token 的签名、`iss`、`aud`、`exp`、`nonce`（`OidcIdTokenValidator`），并按需调用 UserInfo 合并 claims，得到 `OidcUser`
- 登出时通过 `OidcClientInitiatedLogoutSuccessHandler` 走 RP-Initiated Logout；后端通道登出用 `.oidcLogout(l -> l.backChannel(Customizer.withDefaults()))` 开启

Keycloak 角色映射、后端通道登出的完整配置与集群下的会话处理见 [Spring SSO 接入](/spring/11_single_sign_on)。

---

## 小结

- OIDC = OAuth 2 授权码流程 + `openid` scope + ID Token + UserInfo + Discovery，解决"用户是谁"
- ID Token 给 RP 自己看、Access Token 给 API 用，两者不能混用；用户唯一标识是 `iss` + `sub`，不是邮箱
- 登录用授权码 + PKCE，`state` 防登录 CSRF，`nonce` 防 ID Token 重放，PKCE 防授权码截获；RP 必须完整校验签名、`iss`、`aud`、`exp`、`nonce`
- Discovery 让客户端只配 issuer 就能对接，JWKS 按 `kid` 缓存并在遇到新 `kid` 时刷新，以支持 OP 轮换密钥
- 登出分 RP 发起、前端通道、后端通道三种，多系统组合方案见单点登录篇
- Spring Boot 中配置 `registration` + `provider`（同一 ID，scope 含 `openid`）并开启 `oauth2Login`，校验与 PKCE 由框架完成

## 参考资料

- OIDC 核心规范：[OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- Discovery：[OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- 登出规范：[RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)、[Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html)、[Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- JWK 格式：[RFC 7517 - JSON Web Key](https://datatracker.ietf.org/doc/html/rfc7517)
- OAuth 安全最佳实践：[RFC 9700 - Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)
- Spring Security OAuth2 Login：[OAuth 2.0 Login](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/index.html)、[OIDC Logout](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/logout.html)
- Keycloak：[Keycloak Documentation](https://www.keycloak.org/documentation)、[CNCF 项目页 - Keycloak](https://www.cncf.io/projects/keycloak/)
- Microsoft Entra ID：[Microsoft identity platform and OpenID Connect protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
- MaxKey：[MaxKey 官方文档](https://www.maxkey.top/)

> 下一篇：[单点登录](./4_sso) —— 三方票据模型、CAS / SAML / OIDC 方案对比与单点登出。

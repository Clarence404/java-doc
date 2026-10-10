---
description: 三方票据模型、两层会话、CAS / SAML / OIDC 对比、跨域 SSO、单点登出、网关令牌中继
---

# 单点登录

> 前置阅读：[OAuth2](/security/2_oauth2)、[OIDC](/security/3_oidc)

单点登录（Single Sign-On，SSO）指用户在一个认证中心登录一次，就能访问多个相互信任的系统。本篇讲与具体框架无关的原理与选型：三方票据模型、两层会话、CAS / SAML 2.0 / OIDC 对比、跨域与前后端分离、单点登出与网关令牌中继。

---

## 一、三方票据模型

所有 SSO 方案的骨架都一样：

参与方有三个：**认证中心**（Identity Provider，IdP，负责验证身份、签发票据）、**业务系统**（CAS 和 SAML 里叫 Service Provider，SP；OIDC 里叫 Relying Party，RP）、以及在两者之间来回跳转的**浏览器**。

1. 用户访问子系统 A，A 发现没有本地会话，把浏览器重定向到认证中心
2. 认证中心验证身份（或发现已有全局会话直接放行），在**认证中心自己的域名**下种下全局会话 Cookie，并签发一次性**票据**
3. 浏览器带着票据回到 A，A 的后端拿票据向认证中心**验证并换取用户信息**，建立 A 自己的本地会话
4. 用户再访问子系统 B，同样被重定向到认证中心；全局会话还在，认证中心直接签发新票据，用户**无需再次输入密码**

![SSO 三方票据模型](../assets/security/sso-ticket-model.svg)

各协议的差别只在「票据长什么样、怎么验证」：

| 协议 | 回跳时浏览器带回的票据 | 业务系统怎么验证 |
|------|----------------------|----------------|
| CAS | Service Ticket（ST），一次性随机串 | 后端调 CAS Server 的 `/p3/serviceValidate` 换取用户信息 |
| SAML 2.0 | 签名的 XML 断言（Assertion），通常经浏览器 POST 回来 | 用预先交换的 IdP 证书本地验签 |
| OIDC | 授权码（code） | 后端用 code + PKCE 校验值换取 ID Token，再按 JWKS 公钥验签 |

票据都要满足三个条件：**短时有效、只能用一次、绑定到具体业务系统**（CAS 绑定 `service`，SAML 绑定 `Audience` 与 ACS 地址，OIDC 绑定 `client_id` 与 `redirect_uri`）。即使在 URL 中被截获，也很难拿去冒充用户。

---

## 二、两层会话：IdP 会话与应用会话

SSO 之后浏览器里同时存在两类会话，很多「登出不干净」「刷新失败」的问题都源于把它们混为一谈。

![IdP 全局会话与应用本地会话](../assets/security/sso-session-layers.svg)

| 会话 | 存在哪里 | 由谁控制时长 | 作用 |
|------|---------|------------|------|
| 全局会话（SSO Session，CAS 中是 TGT） | IdP 服务端，Cookie 写在 IdP 域名下 | IdP 配置（Keycloak 的 SSO Session Idle / Max，CAS 的 TGT 过期策略） | 决定用户去下一个系统时要不要重新输密码 |
| 本地会话 | 各业务系统自己（Servlet Session、Spring Session、BFF 会话） | 各系统自己的超时配置 | 决定用户在本系统内的请求是否已登录 |
| 令牌（OIDC 场景） | 客户端或 BFF 服务端 | IdP 签发时确定 | Access Token 调 API，Refresh Token 续期，ID Token 只用来证明登录 |

几条容易踩的规则：

- **两层会话相互独立**：全局会话过期后，本地会话照样有效，直到自己超时或收到单点登出通知；反过来，本地会话过期时只要全局会话还在，用户被重定向一次就静默登录回来了
- **Refresh Token 的寿命受全局会话约束**：以 Keycloak 为例，普通 Refresh Token 绑定 SSO Session，寿命不会超过 SSO Session Idle / Max，全局会话结束后刷新就会失败，客户端要回到登录流程，不需要额外申请 `offline_access`
- **`offline_access` 不是用来对齐会话的**：申请它得到的是离线令牌（Offline Token），不受 SSO Session 超时约束，用户登出后仍然有效，只受 Offline Session Idle / Max 控制。它适合需要长期代表用户执行的后台任务，普通 Web 登录不要申请
- **ID Token 只给客户端用**：它证明「用户在某时刻登录过」，不能当作调用 API 的凭证，也不应该被拿来续期本地会话

::: tip 同域会话共享不等于 SSO
同一主域下的多个应用（`a.example.com`、`b.example.com`）把 Cookie 写在父域、会话放进 Redis，就能共享登录态，这只是「共享同一个本地会话」，配置方法见 [分布式会话](/distributed/5_session)。SSO 解决的是**跨域名、跨系统、跨组织**的登录问题，每个系统有自己的会话，只是共用同一个认证中心。
:::

---

## 三、CAS 协议

CAS（Central Authentication Service）由 Apereo 基金会维护，是高校和传统企业内网 SSO 的常见选择，当前协议版本为 CAS 3.0。

### 1、票据

| 票据 | 说明 |
|------|------|
| TGT（Ticket Granting Ticket） | 登录成功后在 CAS Server 端创建，代表全局会话 |
| TGC（Ticket Granting Cookie） | 写在 CAS Server 域名下的 Cookie，值指向 TGT |
| ST（Service Ticket） | 访问某个业务系统时签发，**一次性、绑定 service**，CAS Server 默认 10 秒过期 |
| PGT / PT（Proxy Granting / Proxy Ticket） | 代理模式：后端服务代表用户访问另一个 CAS 保护的服务时使用 |

### 2、登录流程

![CAS 票据流程](../assets/security/sso-cas-flow.svg)

1. 浏览器访问业务系统，未登录，302 到 `https://cas.example.com/cas/login?service=<业务系统回调地址>`
2. 用户在 CAS 登录成功，CAS 种下 TGC，并 302 回 `service` 地址，URL 上带一次性 `ticket=ST-...`
3. 业务系统后端调用 `/p3/serviceValidate?service=...&ticket=...`（服务器之间直连），返回 XML 或 JSON 格式的用户名与属性，业务系统据此建立本地会话
4. 访问第二个系统时 TGC 还在，CAS 直接签发新 ST，用户不用再输密码

CAS 协议简单、接入成本低，但只解决「登录」：没有标准的 API 授权模型，也不适合移动端和第三方应用。新系统如果已经有 OIDC 能力，优先用 OIDC；Apereo CAS Server 本身也能同时作为 OIDC / SAML IdP 运行。

---

## 四、SAML 2.0

SAML 2.0（Security Assertion Markup Language，OASIS 2005 年发布）基于 XML，是企业间联邦认证和 SaaS 企业登录的事实标准，Salesforce、Microsoft 365 等 SaaS 的企业 SSO 都支持它。

| 概念 | 说明 |
|------|------|
| IdP | 身份提供方，如 Microsoft Entra ID（2023 年由 Azure AD 更名而来）、AD FS、Okta、Keycloak |
| SP | 业务系统，对外暴露 ACS（Assertion Consumer Service）地址接收断言 |
| Assertion | IdP 签名（可选加密）的 XML 身份声明，含主体、属性、有效期、受众 |
| Metadata | 双方预先交换的 XML，包含实体 ID、证书、各端点地址，信任关系就靠它建立 |
| Binding | 消息怎么传：HTTP-Redirect（放 URL）、HTTP-POST（自动提交的表单）、Artifact（只传引用，后端再取） |

两种发起方式：

- **SP 发起**：用户先访问业务系统，SP 生成 `AuthnRequest` 重定向到 IdP，IdP 认证后把断言 POST 回 SP 的 ACS。推荐这种方式，SP 可以校验 `InResponseTo` 与自己发出的请求是否对应
- **IdP 发起**：用户在企业门户点图标，IdP 直接把断言 POST 给 SP。没有对应的请求可比对，更容易遭受断言注入和重放，SP 要严格校验有效期并记录已用过的断言 ID

SAML 的特点是格式重（XML + XML 签名，验签实现历史上多次出现签名包装漏洞，必须用成熟库），但在企业合规场景非常成熟。新建系统优先用 OIDC；需要接入客户的企业 IdP、或 SaaS 产品要支持企业登录时，SAML 仍然绕不开。

---

## 五、OIDC

OIDC（OpenID Connect）在 OAuth2 授权码流程之上增加了 ID Token 和标准化的用户信息，JSON + JWT，移动端、SPA、微服务都适用，是新系统的首选。协议细节（授权码 + PKCE、ID Token 校验、Discovery）见 [OIDC](/security/3_oidc)。

![基于 OIDC 的单点登录](../assets/security/sso-flow.svg)

SSO 效果来自 IdP 的全局会话：用户访问应用 B 时被重定向到 IdP，IdP 发现 SSO Session 还在，直接回跳授权码，整个过程用户只看到几次页面跳转。几个常用的控制参数：

| 参数 | 作用 |
|------|------|
| `prompt=none` | 静默检查：有全局会话就直接返回 code，没有则返回 `login_required` 错误，不显示登录页 |
| `prompt=login` / `max_age` | 强制重新认证，或要求登录时间不早于指定秒数（敏感操作前使用），结果体现在 ID Token 的 `auth_time` |
| `acr_values` | 要求认证强度，比如必须经过 MFA |

---

## 六、方案对比与选型

| 维度 | CAS | SAML 2.0 | OIDC |
|------|-----|---------|------|
| 票据 | Service Ticket | XML 断言 | 授权码 + ID Token（JWT） |
| 验证方式 | 后端回调 CAS 验票 | 本地验 XML 签名 | 后端换令牌，按 JWKS 验签 |
| 信任建立 | 在 CAS Server 登记 service | 交换 Metadata | 注册客户端，Discovery 自动发现端点 |
| API 授权 | 无标准方案 | 无（需另配 OAuth2） | 天然带 Access Token |
| 移动端 / SPA | 不适合 | 不适合 | 适合（PKCE、BFF） |
| 单点登出 | 后端通道为主 | SLO（Redirect / POST / SOAP） | Front / Back-Channel、RP 发起登出 |
| 典型场景 | 企业 / 高校内网存量系统 | 企业联邦、SaaS 企业登录 | 新建系统、微服务、互联网应用 |

**选型建议**：

- 新建系统、微服务体系、需要同时管 API 授权 → **OIDC**
- 存量内网 Web 系统已经接入 CAS → 继续用 CAS，新系统接同一个 IdP 的 OIDC 端点
- 要接入客户的企业 IdP（Entra ID、Okta、AD FS），或你的 SaaS 要支持企业 SSO → **SAML 2.0**（同时提供 OIDC 更好）
- 只是想统一账号密码来源 → LDAP / AD。它是**目录服务**，只解决「账号存在哪」，各系统仍要各自登录一次，常作为 IdP 背后的账号源

不想自己写认证中心时直接部署 IAM 平台，它们自带用户管理、多协议、管理界面，应用侧按标准协议对接即可：

| | Keycloak | MaxKey |
|---|---|---|
| 背景 | 2023 年起为 CNCF 孵化项目，Red Hat 为主要维护方 | 国产开源（Dromara 社区） |
| 协议 | OIDC / OAuth2 / SAML 2.0 | OIDC / OAuth2 / SAML 2.0 / CAS |
| 账号源 | 内置 + LDAP / AD 联邦 + 社交登录 + 企业 IdP 代理 | 内置 + LDAP / AD |
| 特点 | 功能全、生态大，概念较多 | 中文文档友好，含 CAS 协议，开箱即用 |

国内中小项目也常用 Sa-Token SSO 自建轻量认证中心，接入方式见 [Spring SSO 接入](/spring/11_single_sign_on)。

---

## 七、跨域 SSO 与前后端分离

### 1、跨域名为什么也能 SSO

Cookie 不能跨域名共享，所以 `a.com` 和 `b.net` 不可能共享同一个会话 Cookie。SSO 不需要共享：全局会话 Cookie 只写在 IdP 域名下，每次都是浏览器**顶层跳转**到 IdP，这时 IdP 的 Cookie 属于第一方 Cookie，浏览器会正常带上。各应用只需要处理「回跳 + 验票 + 建立本地会话」，本地会话 Cookie 写在各自域名下。

需要注意的浏览器行为：

- **SameSite**：会话 Cookie 推荐 `SameSite=Lax`，顶层 GET 跳转会带上。授权码默认通过 GET 回跳，没有问题；但 SAML 的 HTTP-POST 绑定和 OIDC 的 `response_mode=form_post` 是**跨站 POST**，`Lax` Cookie 不会被带上，SP 如果把「发出的请求状态」存在会话里就会丢失。要么把这类回调用的 Cookie 设为 `SameSite=None; Secure`，要么让回调处理不依赖会话
- **不要用 `SameSite=Strict` 作为登录会话 Cookie**：从 IdP 跳回来属于跨站导航，Strict Cookie 不会发送，用户会表现为「登录后又被要求登录」
- **依赖 iframe 的方案越来越不可靠**：Safari、Firefox 默认拦截第三方 Cookie，隐藏 iframe 里的 `prompt=none` 静默续期、OIDC Session Management 的 `check_session_iframe`、前端通道登出都可能拿不到 IdP 的 Cookie

### 2、前后端分离：用 BFF 而不是在浏览器里存令牌

单页应用（SPA）直接在浏览器里完成授权码 + PKCE、把 Access Token 存在内存或 `localStorage`，技术上可行，但令牌暴露在 JavaScript 可及的范围里，一次 XSS 就能被盗用，静默续期又受第三方 Cookie 限制。

IETF 的 OAuth 2.0 for Browser-Based Applications（2026 年 8 月发布为 RFC 10017，BCP）把 **BFF（Backend for Frontend）** 列为最安全的架构，推荐业务系统、敏感应用和处理个人数据的应用采用：

1. 前端访问 BFF，未登录时 BFF 作为**机密客户端**发起授权码 + PKCE 流程
2. 令牌保存在 BFF 服务端会话里，浏览器只拿到 `HttpOnly; Secure; SameSite=Lax` 的会话 Cookie
3. 前端所有 API 请求发给 BFF，BFF 附上 Access Token 转发给后端服务，令牌过期由 BFF 用 Refresh Token 续期
4. 因为改回了 Cookie 认证，BFF 必须开启 CSRF 防护，并限制转发目标只能是允许的后端地址

BFF 常常就是 API 网关本身，见下一节。

---

## 八、单点登出（SLO）

登录一次容易，**登出一次**难：用户在系统 A 点了登出，只销毁了 A 的本地会话，IdP 的全局会话和 B、C 的本地会话都还活着。完整的单点登出要做三件事：销毁本地会话、通知 IdP 销毁全局会话、IdP 再通知其他已登录的系统。

### 1、前端通道与后端通道

![单点登出的前端通道与后端通道](../assets/security/sso-slo-channels.svg)

| 方式 | 做法 | 优点 | 问题 |
|------|------|------|------|
| 前端通道（Front-Channel） | IdP 登出页里为每个应用嵌一个 iframe（或依次重定向），由浏览器访问各应用的登出地址 | 应用能直接清掉浏览器里的本地会话 Cookie | 依赖第三方 Cookie 和页面停留，任何一个 iframe 失败都没有感知 |
| 后端通道（Back-Channel，推荐） | IdP 服务端直接 POST 各应用的回调端点 | 不依赖浏览器，可重试、可记录 | 应用必须能被 IdP 访问到，并能按会话标识找到对应的本地会话 |
| 短会话兜底 | 本地会话只保留几分钟，过期后靠全局会话静默续上 | 实现最简单 | 登出后最多残留一个本地会话周期 |

各协议的实现：

- **CAS**：默认后端通道，CAS Server 向每个用过该 TGT 的 service POST 一个 `logoutRequest` 参数（内含 SAML 格式的 `LogoutRequest`，`SessionIndex` 即当初的 ST），应用按 ST 找到会话销毁；也支持前端通道
- **SAML 2.0**：SP 或 IdP 发起 `LogoutRequest`，IdP 逐个通知其他 SP，可走 Redirect / POST（前端）或 SOAP（后端）绑定，实际部署中 SP 支持程度参差不齐
- **OIDC**：拆成三个规范（均于 2022 年定稿）
  - **RP-Initiated Logout**：应用把浏览器重定向到 IdP 的 `end_session_endpoint`，带上 `id_token_hint` 和登记过的 `post_logout_redirect_uri`，由 IdP 销毁全局会话
  - **Back-Channel Logout**：IdP 向应用登记的 `backchannel_logout_uri` POST 一个 `logout_token`（签名 JWT），必须包含 `iss`、`aud`、`iat`、`exp`、`jti` 和值为 `http://schemas.openid.net/event/backchannel-logout` 的 `events`，`sub` 与 `sid` 至少一个，**禁止出现 `nonce`**；应用验签后返回 200
  - **Front-Channel Logout**：IdP 在登出页中用 iframe 加载应用登记的 `frontchannel_logout_uri`，可带 `iss` 与 `sid` 参数

### 2、落地要点

- 应用登录时要记录 **IdP 会话标识与本地会话的映射**（OIDC 的 `sid`、CAS 的 ST），否则收到登出通知也不知道该销毁哪个会话
- 多实例部署时这份映射和本地会话都要放在共享存储里：通知可能落到实例 A，而用户的会话在实例 B。Spring Security 的对应配置（`OidcSessionRegistry`）见 [Spring SSO 接入](/spring/11_single_sign_on)
- 后端通道的回调地址要对 IdP 可达，但不要暴露给公网的其他调用者；验签失败、`events` 不对、带 `nonce` 的令牌一律拒绝
- 无状态 JWT 的 Access Token 无法被登出通知撤销，只能靠**短有效期**（几分钟）兜底，需要立即失效时配合令牌黑名单或改用不透明令牌 + 内省，见 [JWT 令牌机制](/security/1_jwt)
- 设计阶段就要和业务确认登出的实时性要求：很多系统最终采用「后端通道 + 短会话兜底」的组合

---

## 九、网关令牌中继

微服务架构里，SSO 的终点通常是 API 网关：网关作为 OAuth2 客户端完成登录（也就是上一节的 BFF），下游服务作为资源服务器只校验 Access Token。

![BFF 网关的令牌中继](../assets/security/sso-gateway-token-relay.svg)

Spring Cloud Gateway（Server WebFlux）提供 `TokenRelay` 过滤器，把当前登录用户的 Access Token 放进 `Authorization: Bearer` 头转发给下游。需要引入 `spring-boot-starter-security-oauth2-client`，并配置好客户端注册信息：

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: gateway
            client-secret: ${GATEWAY_CLIENT_SECRET}
            authorization-grant-type: authorization_code
            scope: openid,profile
        provider:
          keycloak:
            issuer-uri: https://sso.example.com/realms/demo
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: order-service
              uri: lb://order-service
              predicates:
                - Path=/api/orders/**
              filters:
                - TokenRelay=        # 不带参数：转发登录用户的 Access Token
```

- 网关的安全配置开启 `oauth2Login()`；令牌默认保存在内存版的 `ReactiveOAuth2AuthorizedClientService` 里，网关多实例时改用 `WebSessionServerOAuth2AuthorizedClientRepository` 把令牌存进会话，再用 Spring Session 把会话放进 Redis，否则请求落到另一个实例就找不到令牌
- 下游服务按资源服务器方式校验签名、`iss`、`exp`，并校验 `aud` 是否包含自己，防止拿发给别的服务的令牌来调用；配置见 [Spring Security](/spring/9_security)
- 服务之间继续调用时，要么继续透传用户令牌，要么用客户端凭证换服务身份令牌（必要时用 RFC 8693 令牌交换缩小权限范围），见 [零信任架构](/security/9_zero_trust)
- 网关路由、限流和作为资源服务器的写法见 [API 网关](/spring-cloud/2_api_gateway)

---

## 小结

- 所有 SSO 方案都是三方票据模型：IdP 维护全局会话并签发一次性、短时、绑定业务系统的票据，业务系统验票后建立本地会话
- 全局会话与本地会话相互独立；Refresh Token 寿命受全局会话约束，`offline_access` 得到的离线令牌不随 SSO 会话结束，不要用它来「对齐会话」
- 新系统选 OIDC；存量内网系统可保留 CAS；对接企业 IdP 和 SaaS 企业登录用 SAML 2.0；LDAP 只是账号源
- 跨域名 SSO 靠顶层跳转到 IdP 实现，注意 SameSite 对跨站 POST 回调的影响；前后端分离优先用 BFF，令牌不进浏览器
- 单点登出优先后端通道，记录 `sid` / ST 与本地会话的映射并放进共享存储，再用短会话兜底
- 网关作为 OAuth2 客户端登录，用 `TokenRelay` 把 Access Token 转给下游，下游作为资源服务器校验

Spring Security 对接 LDAP / CAS / SAML2 / OIDC、Keycloak 实战、Spring Authorization Server 和 Sa-Token SSO 的配置代码见 [Spring SSO 接入](/spring/11_single_sign_on)；同一主域下的多实例会话共享见 [分布式会话](/distributed/5_session)。

---

## 参考资料

- CAS 协议规范：[CAS Protocol Specification](https://apereo.github.io/cas/development/protocol/CAS-Protocol-Specification.html)
- CAS 单点登出：[Logout and Single Logout (SLO)](https://apereo.github.io/cas/development/installation/Logout-Single-Signout.html)
- SAML 2.0 技术概览：[Security Assertion Markup Language (SAML) V2.0 Technical Overview](https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html)
- OIDC 核心规范：[OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- OIDC 登出规范：[RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)、[Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)、[Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html)、[Session Management 1.0](https://openid.net/specs/openid-connect-session-1_0.html)
- 浏览器应用的 OAuth 最佳实践：[RFC 10017 - OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)
- Keycloak 会话与令牌超时、离线访问：[Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/)
- Keycloak 项目状态：[CNCF - Keycloak](https://www.cncf.io/projects/keycloak/)
- Azure AD 更名：[New name for Azure Active Directory](https://learn.microsoft.com/en-us/entra/fundamentals/new-name)
- MaxKey 官网：[MaxKey 单点登录认证系统](https://maxkey.top/)
- Spring Security OIDC 登出：[OIDC Logout](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/logout.html)
- Spring Cloud Gateway 令牌中继：[TokenRelay GatewayFilter Factory](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/gatewayfilter-factories/tokenrelay-factory.html)

> 下一篇：[权限模型：RBAC 与 ABAC](./5_rbac_abac)

# SSO 单点登录

> 参考资料：
> * Spring Security LDAP：[https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html)
> * CAS 官网：[https://apereo.github.io/cas/](https://apereo.github.io/cas/)
> * OAuth2 RFC：[https://datatracker.ietf.org/doc/html/rfc6749](https://datatracker.ietf.org/doc/html/rfc6749)

> 本文聚焦 Spring 生态下 SSO 的落地方案。OAuth2 协议见 → [OAuth2](/security/2_oauth2)　OIDC 协议见 → [OIDC](/security/3_oidc)　JWT 令牌详见 → [JWT](/security/1_jwt)

## 一、什么是 SSO

**SSO（Single Sign-On，单点登录）**：用户只需登录一次，即可访问多个相互信任的应用系统，无需重复认证。

所有 SSO 方案的共同骨架都是**三方票据模型**：

1. 用户访问子系统 A，A 发现未登录 → 重定向到**认证中心**
2. 认证中心校验身份（或发现已有全局会话直接放行）→ 签发**票据**（Ticket / Code / Assertion）
3. 带着票据回跳子系统 A → A 拿票据到认证中心**验证换取用户信息** → 建立自己的局部会话
4. 用户再访问子系统 B → 重定向到认证中心 → 全局会话还在，**免登录**直接发票据

各方案的差异只在票据格式和验证方式：CAS 用 Service Ticket、OAuth2/OIDC 用授权码 + Token、SAML2 用 XML 断言。

### 同域会话共享 ≠ SSO

先排除一个常见混淆：同一主域下的多个应用（`a.example.com` / `b.example.com`）用 **Cookie 顶域 + Spring Session（Redis）** 共享会话即可，不需要 SSO 全套（见 [分布式会话](../distributed/4_session)）。SSO 解决的是**跨域、跨系统、跨信任边界**的登录问题。

## 二、主流方案对比

| 方案 | 协议类型 | 票据形式 | 适用场景 | 复杂度 |
|------|---------|---------|---------|--------|
| LDAP | 目录协议 | —（统一账号，不是 SSO 票据）| 企业内网统一账号 | 中 |
| CAS | SSO 专用协议 | Service Ticket | 企业内部多 Web 系统 | 中 |
| SAML2 | XML 联邦认证 | XML Assertion | 跨企业 / 对接 Okta、Azure AD | 高 |
| OAuth2 / OIDC | 授权 + 认证协议 | 授权码 + ID Token | 互联网应用、微服务统一认证 | 中 |
| MaxKey / Keycloak | IAM 平台 | 以上协议全支持 | 快速搭建企业级认证中心 | 低（开箱即用）|

**选型决策**：

- 新建微服务体系 / 互联网产品 → **OIDC**（事实标准，Spring 支持最好）
- 存量企业内部多 Web 系统 → CAS（老牌，接入简单）
- 要和外部企业系统（Okta / Azure AD）联邦 → SAML2
- 不想自己搭认证中心 → Keycloak（国际主流）/ MaxKey（国产）
- 只是统一账号密码来源 → LDAP（它只解决"账号在哪"，不解决"登录一次"）

## 三、LDAP

**LDAP（Lightweight Directory Access Protocol）**：轻量级目录访问协议，常用于企业内网存储用户账号信息（如 Active Directory）。

- 定位注意：LDAP 本身**只是统一账号库**，各系统仍要各登录一次；它常作为 CAS / Keycloak 背后的账号源
- 典型场景：公司 AD 域账号统一登录 OA / Jira / GitLab

```java
// Spring Security 对接 LDAP
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
               .formLogin(Customizer.withDefaults())
               .build();
}

@Bean
AuthenticationManager ldapAuthManager(BaseLdapPathContextSource contextSource) {
    LdapBindAuthenticationManagerFactory factory =
        new LdapBindAuthenticationManagerFactory(contextSource);
    factory.setUserDnPatterns("uid={0},ou=people");
    return factory.createAuthenticationManager();
}
```

> 官方文档：[Spring LDAP Authentication](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html#servlet-authentication-ldap-embedded)

## 四、CAS

**CAS（Central Authentication Service）**：Apereo 开源的 SSO 协议和服务端实现，专为企业多系统单点登录设计。

**票据流程（对应第一节骨架）**：

1. 浏览器访问子系统 → 未登录 → 302 到 `CAS Server /login?service=子系统地址`
2. CAS 登录成功 → 浏览器种下 **TGC**（全局会话 Cookie），并 302 回子系统，URL 带一次性 **ST**（Service Ticket）
3. 子系统后端拿 ST 调 CAS 的 `/serviceValidate` **服务端间验证** → 返回用户信息 → 子系统建立局部会话
4. 访问第二个系统时 TGC 还在 → CAS 直接签发新 ST，免输密码

关键设计：ST **一次性、短有效期（默认 10s）、绑定 service**，即使被截获也难以重放。

```xml
<!-- 子系统接入：cas-client 过滤器（或 Spring Security CAS 模块） -->
<dependency>
  <groupId>org.apereo.cas.client</groupId>
  <artifactId>cas-client-support-springboot</artifactId>
</dependency>
```

```yaml
cas:
  server-url-prefix: https://cas.example.com
  client-host-url: https://app-a.example.com
  validation-type: CAS3
```

> 服务端模板：[cas-overlay-template](https://github.com/apereo/cas-overlay-template)

## 五、SAML2

**SAML2（Security Assertion Markup Language 2.0）**：基于 XML 的联邦认证标准，广泛用于企业与第三方系统的身份对接。

- 角色：**IdP**（身份提供方，如 Azure AD / Okta）+ **SP**（服务提供方，你的应用）
- 断言（Assertion）经 XML 签名，通过浏览器 POST 传递，双方靠预先交换的 **metadata**（证书 + 端点）建立信任
- 适合跨企业场景；新系统之间对接优先选 OIDC（JSON/JWT 比 XML 签名省心得多）

```yaml
# Spring Security 作为 SP 对接企业 IdP
spring:
  security:
    saml2:
      relyingparty:
        registration:
          okta:
            assertingparty:
              metadata-uri: https://xxx.okta.com/app/xxx/sso/saml/metadata
```

> 官方文档：[Spring Security SAML2](https://docs.spring.io/spring-security/reference/servlet/saml2/index.html)

## 六、OAuth2 / OIDC

**OAuth2**：授权框架，本质是"允许第三方应用访问用户资源"。
**OIDC（OpenID Connect）**：在 OAuth2 之上增加身份认证层（**ID Token**，一个 JWT），是目前最主流的 SSO 标准。

**授权码流程（Authorization Code + PKCE，唯一推荐模式）**：

1. 应用把用户重定向到认证中心 `/authorize`（带 `client_id`、`redirect_uri`、`scope=openid`）
2. 用户在认证中心登录（第二个应用来时全局会话仍在 → 免登录）
3. 认证中心 302 回 `redirect_uri`，带一次性**授权码 code**
4. 应用后端用 code + client_secret 换 **ID Token（我是谁）+ Access Token（能访问什么）**
5. 校验 ID Token 签名与 claims → 登录完成

> 旧的隐式模式、密码模式在 OAuth 2.1 中已废弃，新系统一律授权码 + PKCE。

```yaml
# Spring Security 作为 OIDC Client：几行配置完成对接
spring:
  security:
    oauth2:
      client:
        registration:
          sso:
            client-id: order-web
            client-secret: xxx
            scope: openid,profile
            authorization-grant-type: authorization_code
        provider:
          sso:
            issuer-uri: https://auth.example.com   # 自动发现所有端点
```

```java
// 资源服务器侧：微服务只需校验 JWT
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com
```

认证中心自建选 **Spring Authorization Server**（官方 OAuth2/OIDC 服务端），或直接用 Keycloak。

## 七、单点登出（SLO）：最容易被忽略的难题

登录一次很容易，**登出一次**很难：用户在系统 A 登出，B/C 的局部会话还活着。

| 方案 | 做法 | 问题 |
|------|------|------|
| 前端通道 | 认证中心页面内嵌各系统登出 iframe | 被浏览器三方 Cookie 限制逐步废掉 |
| 后端通道（推荐）| 认证中心逐个回调各系统的登出端点（CAS Single Logout / OIDC Back-Channel Logout）| 各系统必须实现回调并能定位到对应会话 |
| 短会话 + 静默续期 | 局部会话只有几分钟，靠全局会话静默刷新 | 登出后最多残留几分钟，实现最简单 |

> 工程上大量系统实际采用第三种"降级"方案——设计阶段就要和业务确认登出的实时性要求。

## 八、IAM 平台：Keycloak 与 MaxKey

不想从零搭认证中心时，直接部署 IAM 平台（自带用户管理、多协议支持、管理界面）：

| | Keycloak | MaxKey |
|---|---|---|
| 背景 | Red Hat 开源，国际事实标准 | 国产开源（Dromara 社区）|
| 协议 | OIDC / OAuth2 / SAML2 | OAuth2 / OIDC / SAML2 / CAS / JWT |
| 账号源 | 内置 + LDAP/AD 联邦 + 社交登录 | 内置 + LDAP/AD |
| 特点 | 功能最全、生态大；界面英文、概念多 | 中文友好、含 CAS 协议、开箱即用 |

Spring 应用对接方式与第六节完全一致（它们就是标准的 OIDC Provider），只需把 `issuer-uri` 指过去。

> Keycloak：[https://www.keycloak.org/](https://www.keycloak.org/)　MaxKey：[https://maxkey.top/](https://maxkey.top/)

## 九、相关文档

- [认证授权框架横向对比（Spring Security / Shiro / Sa-Token）](./10_auth_framework)
- [OAuth2](/security/2_oauth2) / [OIDC](/security/3_oidc) / [JWT](/security/1_jwt)：协议细节
- [分布式会话](/distributed/4_session)：同域会话共享方案

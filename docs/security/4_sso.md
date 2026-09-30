# 单点登录

> 参考资料：
> * CAS 官网：[https://apereo.github.io/cas/](https://apereo.github.io/cas/)
> * Keycloak：[https://www.keycloak.org/](https://www.keycloak.org/)　MaxKey：[https://maxkey.top/](https://maxkey.top/)

> 本文聚焦 SSO 原理、方案对比与选型（与框架无关）。OIDC 协议见 → [OIDC](/security/3_oidc)；OAuth2 协议见 → [OAuth2](/security/2_oauth2)；Spring 生态接入配置见 → [SSO 单点登录（Spring）](/spring/11_single_sign_on)；Sa-Token SSO 见 → [安全框架对比](/spring/10_auth_framework)

单点登录（Single Sign-On）指用户只需登录一次，即可访问多个相互信任的系统，无需重复认证。

![SSO 单点登录流程](../assets/security/sso-flow.svg)

**核心角色：**
- **认证服务（Identity Provider, IdP）**：统一认证中心，验证身份、颁发票据/令牌
- **服务提供方（Service Provider, SP）**：业务系统，信任 IdP 颁发的凭证
- **票据 / 令牌**：证明用户已在 IdP 完成认证的凭证（Session Ticket、JWT、SAML Assertion）

---

## 一、三方票据模型

所有 SSO 方案的共同骨架都是**三方票据模型**：

1. 用户访问子系统 A，A 发现未登录 → 重定向到**认证中心**
2. 认证中心校验身份（或发现已有全局会话直接放行）→ 签发**票据**（Ticket / Code / Assertion）
3. 带着票据回跳子系统 A → A 拿票据到认证中心**验证换取用户信息** → 建立自己的局部会话
4. 用户再访问子系统 B → 重定向到认证中心 → 全局会话还在，**免登录**直接发票据

![SSO 三方票据模型](../assets/security/sso-ticket-model.svg)

各方案的差异只在票据格式和验证方式：CAS 用 Service Ticket、OAuth2/OIDC 用授权码 + Token、SAML2 用 XML 断言。

---

## 二、方案对比与选型

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

**场景速查**：

| 场景 | 推荐方案 |
|------|---------|
| 同根域名多子系统 | Spring Session + Redis 共享 Session |
| 国内企业跨域多系统 | **Sa-Token SSO**（部署简单，文档丰富）|
| 现代微服务，需要标准 OIDC | **Keycloak**（开源，功能完整）|
| 对接企业 AD / LDAP | Keycloak（内置 LDAP federation）|
| 对接第三方（微信/GitHub/企业微信）| Spring Security OAuth2 Client |
| 传统 Java 企业系统 | Apereo CAS Server |
| 跨公司 / 跨组织联邦认证 | SAML 2.0 |

---

## 三、Session 共享方案（同域内部系统）

### 同域会话共享 ≠ SSO

先排除一个常见混淆：同一主域下的多个应用（`a.example.com` / `b.example.com`）用 **Cookie 顶域 + Spring Session（Redis）** 共享会话即可，不需要 SSO 全套（见 [分布式会话](/distributed/5_session)）。SSO 解决的是**跨域、跨系统、跨信任边界**的登录问题。

### Cookie 跨子域 + Redis 共享 Session

设置 Cookie 的 `domain=.example.com`，让所有子域都能读取同一 Session Cookie；后端将 Session 存入 Redis，所有子系统共享。

```xml
<dependency>
  <groupId>org.springframework.session</groupId>
  <artifactId>spring-session-data-redis</artifactId>
</dependency>
```

```yaml
spring:
  session:
    # Spring Boot 3 已移除 store-type，classpath 中存在 spring-session-data-redis 即自动配置
    timeout: 30m
  data:
    redis:
      host: redis-server
```

```java
@Bean
public CookieSerializer cookieSerializer() {
    DefaultCookieSerializer serializer = new DefaultCookieSerializer();
    serializer.setDomainName(".example.com");  // 跨子域共享
    serializer.setCookieName("SESSION");
    serializer.setUseHttpOnlyCookie(true);
    serializer.setUseSecureCookie(true);
    return serializer;
}
```

**限制**：只适合同根域名。跨域名或跨公司系统无法用 Cookie 共享 Session，需要下面的方案。

---

## 四、LDAP 的定位

**LDAP（Lightweight Directory Access Protocol）**：轻量级目录访问协议，常用于企业内网存储用户账号信息（如 Active Directory）。

- 定位注意：LDAP 本身**只是统一账号库**，各系统仍要各登录一次；它常作为 CAS / Keycloak 背后的账号源
- 典型场景：公司 AD 域账号统一登录 OA / Jira / GitLab

---

## 五、CAS 协议（Central Authentication Service）

Apereo 基金会维护，是传统企业 SSO 的主流协议，适合 Java 应用集成内网系统。

### 核心票据

| 票据 | 说明 |
|------|------|
| TGT（Ticket Granting Ticket）| 用户登录成功后颁发，存于 CAS Server，代表已认证身份 |
| TGC（Ticket Granting Cookie）| 浏览器 Cookie，指向 TGT |
| ST（Service Ticket）| 访问某个 SP 时颁发，**一次性使用**，短有效期（默认 10s）|

### 登录流程

![CAS 票据流程](../assets/security/sso-cas-flow.svg)

1. 浏览器访问子系统 → 未登录 → 302 到 `CAS Server /login?service=子系统地址`
2. CAS 登录成功 → 浏览器种下 **TGC**（全局会话 Cookie），并 302 回子系统，URL 带一次性 **ST**（Service Ticket）
3. 子系统后端拿 ST 调 CAS 的 `/serviceValidate` **服务端间验证** → 返回用户信息 → 子系统建立局部会话
4. 访问第二个系统时 TGC 还在 → CAS 直接签发新 ST，免输密码

关键设计：ST **一次性、短有效期（默认 10s）、绑定 service**，即使被截获也难以重放。

### 单点注销

用户在 SP-A 注销 → SP-A 通知 CAS Server 销毁 TGT → CAS Server 向所有关联的 SP 发送 back-channel logout 请求 → 各 SP 销毁本地 Session（流程图见下文第八节「单点登出（SLO）」）。

---

## 六、SAML 2.0

基于 XML 的企业级联邦认证协议，适合与企业 AD/LDAP、第三方 SaaS（Salesforce、Office 365）集成。

| 角色 | 说明 |
|------|------|
| IdP（Identity Provider）| 身份提供方，如企业 AD FS、Okta |
| SP（Service Provider）| 业务系统 |
| SAML Assertion | XML 格式的身份声明，由 IdP 签名 |

- 断言（Assertion）经 XML 签名，通过浏览器 POST 传递，双方靠预先交换的 **metadata**（证书 + 端点）建立信任

**特点**：格式重（XML + XML 签名），配置复杂，但在企业合规场景中成熟度高。  
新项目推荐用 OIDC 替代 SAML，除非需要对接老系统或强制合规要求 SAML。

---

## 七、OIDC 方案（现代推荐）

在 OAuth2 授权码流程上增加身份层，JSON-based，轻量，是当前主流 SSO 协议。

协议原理与授权码 + PKCE 流程详见 → [OIDC](/security/3_oidc)

### SSO 流程（以 Keycloak 为例）

![OIDC 授权码流程](../assets/security/sso-oidc-flow.svg)

再访问业务系统 B 时，Keycloak 发现已有 SSO Session，直接返回 code，用户无需再次登录。

---

## 八、单点登出（SLO）：最容易被忽略的难题

登录一次很容易，**登出一次**很难：用户在系统 A 登出，B/C 的局部会话还活着。

| 方案 | 做法 | 问题 |
|------|------|------|
| 前端通道 | 认证中心页面内嵌各系统登出 iframe | 被浏览器三方 Cookie 限制逐步废掉 |
| 后端通道（推荐）| 认证中心逐个回调各系统的登出端点（CAS Single Logout / OIDC Back-Channel Logout）| 各系统必须实现回调并能定位到对应会话 |
| 短会话 + 静默续期 | 局部会话只有几分钟，靠全局会话静默刷新 | 登出后最多残留几分钟，实现最简单 |

后端通道（推荐方案）的工作方式：

![单点登出后端通道](../assets/security/sso-logout-backchannel.svg)

> 工程上大量系统实际采用第三种"降级"方案——设计阶段就要和业务确认登出的实时性要求。

---

## 九、IAM 平台：Keycloak 与 MaxKey

不想从零搭认证中心时，直接部署 IAM 平台（自带用户管理、多协议支持、管理界面）：

| | Keycloak | MaxKey |
|---|---|---|
| 背景 | Red Hat 开源，国际事实标准 | 国产开源（Dromara 社区）|
| 协议 | OIDC / OAuth2 / SAML2 | OAuth2 / OIDC / SAML2 / CAS / JWT |
| 账号源 | 内置 + LDAP/AD 联邦 + 社交登录 | 内置 + LDAP/AD |
| 特点 | 功能最全、生态大；界面英文、概念多 | 中文友好、含 CAS 协议、开箱即用 |

它们就是标准的 OIDC Provider，应用侧对接方式与普通 OIDC 完全一致。

---

## 十、Java 框架落地

- **Spring Security**（LDAP / CAS Client / SAML2 SP / OIDC Client / Keycloak）→ [SSO 单点登录（Spring）](/spring/11_single_sign_on)
- **Sa-Token SSO**（同域 / 跨域 ticket 模式）→ [安全框架对比 · Sa-Token](/spring/10_auth_framework)

---

## 十一、常见问题

### 1、Token 刷新与 SSO Session 不一致

OIDC `access_token` 短期有效，但 Keycloak SSO Session 可能更长。刷新 token 时确保同时续期 SSO Session：

```java
// Spring Security 自动处理刷新，需要开启 refresh_token scope
scope: openid, profile, email, offline_access
```

### 2、单点注销不彻底

OIDC 的 **Front-Channel Logout** 依赖浏览器加载隐藏的 `<iframe>`，各 SP 不一定都能注销成功。  
生产环境推荐 **Back-Channel Logout**（Keycloak 向各 SP 发 POST 请求），可靠性更高。

### 3、前后端分离场景

前后端分离时不能用 Cookie 传递票据，改用 **Token 模式**：
1. 前端重定向到 IdP 登录
2. IdP 返回 `code` 到前端
3. 前端用 `code` 调后端换取 `access_token`（PKCE 防截获）
4. 后端验证 token 后返回业务 JWT

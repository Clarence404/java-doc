# 单点登录（SSO）

单点登录（Single Sign-On）指用户只需登录一次，即可访问多个相互信任的系统，无需重复认证。

**核心角色：**
- **认证服务（Identity Provider, IdP）**：统一认证中心，验证身份、颁发票据/令牌
- **服务提供方（Service Provider, SP）**：业务系统，信任 IdP 颁发的凭证
- **票据 / 令牌**：证明用户已在 IdP 完成认证的凭证（Session Ticket、JWT、SAML Assertion）

---

## 一、Session 共享方案（同域内部系统）

适合同一根域名下的多个子系统（如 `a.example.com` 和 `b.example.com`）。

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
    store-type: redis
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

## 二、CAS 协议（Central Authentication Service）

Apereo 基金会维护，是传统企业 SSO 的主流协议，适合 Java 应用集成内网系统。

### 核心票据

| 票据 | 说明 |
|------|------|
| TGT（Ticket Granting Ticket）| 用户登录成功后颁发，存于 CAS Server，代表已认证身份 |
| TGC（Ticket Granting Cookie）| 浏览器 Cookie，指向 TGT |
| ST（Service Ticket）| 访问某个 SP 时颁发，**一次性使用**，有效期几分钟 |

### 登录流程

```
用户              SP（业务系统）          CAS Server
 │                    │                      │
 │── 访问 SP ─────────►│                      │
 │                    │── 未登录，302 重定向 ──►│
 │── 输入账号密码 ──────────────────────────►  │
 │◄──────── 颁发 TGC（Cookie）+ 302 带 ST ────│
 │── 带 ST 访问 SP ────►│                      │
 │                    │── 验证 ST ────────────►│
 │                    │◄── 返回用户信息 ─────────│
 │◄── 登录成功 ─────────│                      │

（再访问另一个 SP 时，CAS 发现已有 TGC，直接颁发新 ST，用户无感知）
```

### 单点注销

```
用户在 SP-A 注销
    ↓
SP-A 通知 CAS Server 销毁 TGT
    ↓
CAS Server 向所有关联的 SP 发送 back-channel logout 请求
    ↓
各 SP 销毁本地 Session
```

---

## 三、SAML 2.0

基于 XML 的企业级联邦认证协议，适合与企业 AD/LDAP、第三方 SaaS（Salesforce、Office 365）集成。

| 角色 | 说明 |
|------|------|
| IdP（Identity Provider）| 身份提供方，如企业 AD FS、Okta |
| SP（Service Provider）| 业务系统 |
| SAML Assertion | XML 格式的身份声明，由 IdP 签名 |

**特点**：格式重（XML + XML 签名），配置复杂，但在企业合规场景中成熟度高。  
新项目推荐用 OIDC 替代 SAML，除非需要对接老系统或强制合规要求 SAML。

---

## 四、OIDC 方案（现代推荐）

在 OAuth2 授权码流程上增加身份层，JSON-based，轻量，是当前主流 SSO 协议。

协议原理详见 → [OAuth2 与 OIDC](/security/1_oauth2_oidc)

### SSO 流程（以 Keycloak 为例）

```
用户              业务系统 A            Keycloak（IdP）
 │                    │                      │
 │── 访问 A ──────────►│                      │
 │                    │── 302 重定向到 Keycloak►│
 │── 登录（首次）────────────────────────────►  │
 │◄────────── 颁发 Keycloak SSO Session + code─│
 │── 带 code 访问 A ───►│                      │
 │                    │── 用 code 换 tokens ───►│
 │                    │◄── id_token + access_token│
 │◄── 登录成功 ─────────│                      │

（再访问业务系统 B 时，Keycloak 发现已有 SSO Session，直接返回 code，用户无需再次登录）
```

---

## 五、Java 框架实现

### Sa-Token SSO（推荐国内项目）

Sa-Token 内置三种 SSO 模式：
- **模式一（同域）**：共享 Cookie domain
- **模式二（跨域，前后端不分离）**：ticket 跳转
- **模式三（跨域，前后端分离）**：ticket 换 token

```xml
<dependency>
  <groupId>cn.dev33</groupId>
  <artifactId>sa-token-sso</artifactId>
  <version>1.39.0</version>
</dependency>
```

```yaml
# 认证中心（SSO Server）
sa-token:
  sso-server:
    ticket-timeout: 300       # ticket 有效期（秒）
    allow-url: "*"            # 允许的回调 URL（生产环境应配置白名单）
    is-check-sign: true       # 开启参数签名校验

# 业务子系统（SSO Client）
sa-token:
  sso-client:
    server-url: http://sso.example.com   # 认证中心地址
    is-slo: true                          # 开启单点注销
```

```java
// 认证中心：处理登录
@RequestMapping("/sso/doLogin")
public SaResult doLogin(String name, String pwd) {
    if ("admin".equals(name) && "123456".equals(pwd)) {
        StpUtil.login(10001);
        return SaResult.ok("登录成功");
    }
    return SaResult.error("用户名或密码错误");
}

// 子系统：SSO 回调，ticket 换取 loginId
@RequestMapping("/sso/login")
public Object ssoLogin(String ticket, String back) {
    return SaSsoClientProcessor.instance.ssoLogin(ticket, back);
}
```

### Keycloak + Spring Security（推荐生产）

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-oauth2-client</artifactId>
</dependency>
```

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: my-app
            client-secret: ${KEYCLOAK_SECRET}
            authorization-grant-type: authorization_code
            scope: openid, profile, email
            redirect-uri: "{baseUrl}/login/oauth2/code/keycloak"
        provider:
          keycloak:
            issuer-uri: http://keycloak:8080/realms/my-realm
```

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/public/**").permitAll()
            .anyRequest().authenticated())
        .oauth2Login(Customizer.withDefaults())          // 触发 OIDC SSO 流程
        .logout(logout -> logout
            .logoutSuccessUrl(                           // 注销后跳转到 Keycloak 单点注销
                "http://keycloak:8080/realms/my-realm/protocol/openid-connect/logout"
                + "?post_logout_redirect_uri=http://myapp.com"))
        .build();
}
```

---

## 六、选型建议

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

## 七、常见问题

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

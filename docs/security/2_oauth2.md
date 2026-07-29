# OAuth2

> 参考资料：
> * OAuth2 RFC 6749：[https://datatracker.ietf.org/doc/html/rfc6749](https://datatracker.ietf.org/doc/html/rfc6749)

> 本文聚焦 OAuth2 协议框架。基于 OAuth2 的身份认证层见 → [OIDC](/security/3_oidc)；SSO 落地实现见 → [单点登录](/security/4_sso)
>
> JWT 令牌格式详见 → [JWT](/security/1_jwt)

---

## 一、OAuth2 是什么

**OAuth2（Open Authorization 2.0）**：一个授权框架，解决的是「第三方应用如何在用户授权下安全访问其资源」的问题。

> 典型场景：用微信登录第三方 App —— 用户授权微信将头像、昵称共享给该 App，但不暴露微信密码。

**注意：OAuth2 本质是授权（Authorization），不是认证（Authentication）**，它告诉你"能访问什么"，不告诉你"你是谁"。

---

## 二、OAuth2 四个角色

| 角色 | 说明 | 示例 |
|------|------|------|
| **Resource Owner** | 资源所有者，即用户 | 微信用户 |
| **Client** | 请求访问资源的第三方应用 | 第三方 App |
| **Authorization Server** | 颁发访问令牌的服务 | 微信授权服务器 |
| **Resource Server** | 持有受保护资源的服务器 | 微信用户信息接口 |

---

## 三、四种授权模式

### 3.1 授权码模式（Authorization Code）⭐ 最安全，最常用

适合有后端服务的 Web 应用，Token 不经过浏览器，安全性高。

![OAuth2 授权码流程](../assets/security/oauth2-auth-code-flow.svg)

**PKCE 扩展**（Proof Key for Code Exchange）：为移动端 / SPA 增强安全性，防止授权码被截获。

### 3.2 客户端凭证模式（Client Credentials）

适合服务间（M2M）调用，没有用户参与，Client 直接用自己的 ID + Secret 换 Token。

```
微服务 A ──[client_id + client_secret]──► Authorization Server ──► access_token
微服务 A ──[access_token]──► 微服务 B（资源服务器）
```

### 3.3 刷新令牌模式（Refresh Token）

`access_token` 有效期短（通常 1 小时），过期后用 `refresh_token`（有效期长）换新的 `access_token`，避免用户重复登录。

```
access_token 过期
    ↓
Client 携带 refresh_token 请求 Authorization Server
    ↓
获得新的 access_token（+ 可选新 refresh_token）
```

### 3.4 隐式模式（Implicit）⚠️ 已不推荐

Token 直接返回到浏览器 URL，安全性差，OAuth2.1 中已废弃，SPA 应改用授权码 + PKCE。

---

## 四、常见安全风险

| 风险 | 说明 | 防护 |
|------|------|------|
| **令牌泄露** | access_token 被截获 | HTTPS 传输，缩短有效期 |
| **CSRF 攻击** | 伪造授权请求 | 授权请求携带随机 `state` 参数，回调时验证 |
| **授权码截获** | code 被中间人截获 | 使用 PKCE，code_verifier 验证 |
| **Refresh Token 滥用** | 长效 token 被盗 | 设置 refresh_token 轮换策略，单次使用 |
| **权限过大** | scope 申请过多权限 | 最小权限原则，精细化 scope |

> [!warning]
> 待补充：Spring Authorization Server 实战、Token 吊销（Revocation）机制、多租户场景

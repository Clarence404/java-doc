---
description: id_token、授权码 + PKCE 流程、Discovery、Front/Back-Channel Logout；目标：能区分认证与授权，理解第三方登录
---

# OIDC

> OIDC（OpenID Connect）基于 OAuth2 构建，在授权层之上增加了标准的身份认证协议。OAuth2 协议基础见 → [OAuth2](/security/2_oauth2)；SSO 原理与选型见 → [单点登录](/security/4_sso)；JWT 令牌格式见 → [JWT](/security/1_jwt)
>
> Spring Boot 对接 OIDC / Keycloak（依赖、配置、角色映射、Back-Channel Logout）见 → [SSO 单点登录（Spring）](/spring/11_single_sign_on)

---

## 一、OIDC 是什么

**OIDC（OpenID Connect）**：在 OAuth2 之上增加了身份认证层，解决 OAuth2 只能授权、不能认证的问题。

| 对比 | OAuth2 | OIDC |
|------|--------|------|
| 解决问题 | 授权（能访问什么） | 认证（你是谁）|
| 核心产物 | access_token | access_token + **id_token** |
| id_token | 无 | JWT 格式，包含用户身份信息（sub、name、email 等）|

---

## 二、OIDC 新增内容

- **id_token**：JWT 格式的身份令牌，包含用户信息（`sub` = 用户唯一标识）
- **UserInfo Endpoint**：用 access_token 请求该接口可获取更详细的用户信息
- **scope**：新增 `openid`、`profile`、`email` 等标准 scope

```json
// id_token 解码后的 Payload 示例
{
  "iss": "https://accounts.google.com",   // 签发方
  "sub": "110169484474386276334",          // 用户唯一 ID
  "aud": "my-client-id",                  // 受众（Client ID）
  "exp": 1715000000,                      // 过期时间
  "iat": 1714996400,                      // 签发时间
  "email": "user@example.com",
  "name": "Zhang San"
}
```

---

## 三、登录流程（授权码 + PKCE）

**授权码流程（Authorization Code + PKCE，唯一推荐模式）**：

![OIDC 授权码流程](../assets/security/sso-oidc-flow.svg)

1. 应用把用户重定向到认证中心 `/authorize`（带 `client_id`、`redirect_uri`、`scope=openid`）
2. 用户在认证中心登录（第二个应用来时全局会话仍在 → 免登录）
3. 认证中心 302 回 `redirect_uri`，带一次性**授权码 code**
4. 应用后端用 code + client_secret 换 **ID Token（我是谁）+ Access Token（能访问什么）**
5. 校验 ID Token 签名与 claims → 登录完成

---

## 四、Discovery Endpoint

OIDC 规定 IdP 必须在固定路径暴露元数据，客户端无需手动配置各个端点地址：

```
GET /.well-known/openid-configuration
```

返回示例（Keycloak）：

```json
{
  "issuer": "https://keycloak.example.com/realms/my-realm",
  "authorization_endpoint": "https://keycloak.example.com/realms/my-realm/protocol/openid-connect/auth",
  "token_endpoint":         "https://keycloak.example.com/realms/my-realm/protocol/openid-connect/token",
  "userinfo_endpoint":      "https://keycloak.example.com/realms/my-realm/protocol/openid-connect/userinfo",
  "jwks_uri":               "https://keycloak.example.com/realms/my-realm/protocol/openid-connect/certs",
  "end_session_endpoint":   "https://keycloak.example.com/realms/my-realm/protocol/openid-connect/logout",
  "scopes_supported":       ["openid", "profile", "email", "offline_access"],
  "response_types_supported": ["code"],
  "id_token_signing_alg_values_supported": ["RS256", "ES256"]
}
```

Spring Security 的 `issuer-uri` 配置会自动请求该端点完成初始化，无需手动填写 `authorization_endpoint` 等地址：

```yaml
spring:
  security:
    oauth2:
      client:
        provider:
          keycloak:
            issuer-uri: https://keycloak.example.com/realms/my-realm  # 自动发现所有端点
```

---

## 五、Front-Channel / Back-Channel Logout

OIDC 定义了两种单点注销方式：

| 维度 | Front-Channel Logout | Back-Channel Logout |
|------|---------------------|---------------------|
| 机制 | IdP 在浏览器中加载各 SP 的注销 URL（隐藏 iframe）| IdP 向各 SP 直接发送 HTTP POST 请求 |
| 可靠性 | 低（浏览器拦截、网络不通、iframe 加载失败均会导致漏注销）| 高（服务端直连，不依赖浏览器）|
| 对 SP 要求 | SP 提供注销 URL，浏览器可访问 | SP 提供可被 IdP 访问的内网端点 |
| 适用场景 | 简单演示 / 老系统兼容 | **生产环境推荐** |

> Spring Security 开启 Back-Channel Logout 的配置见 → [SSO 单点登录（Spring）· 单点登出配置](/spring/11_single_sign_on)；SLO 方案整体选型见 → [单点登录](/security/4_sso)

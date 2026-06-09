# 认证与授权

> 本文聚焦认证授权基础概念与模型。Spring 框架中 Security / Sa-Token / Shiro 的具体实现对比见 → [安全框架横向对比](/spring/10_auth_framework)

## 核心概念

- **认证（Authentication）**：你是谁（Who are you）
- **授权（Authorization）**：你能做什么（What can you do）
- **鉴权（Access Control）**：是否有权限执行当前操作

## OAuth 2.0 / OIDC

> 协议原理、四种授权模式、PKCE 扩展详见 → [OAuth2 与 OIDC](/security/6_oauth2_oidc)

## JWT

> 令牌结构、签名算法、失效策略、安全风险详见 → [JWT](/security/7_jwt)

## RBAC / ABAC

> [!warning] 待补充
>
> RBAC 模型设计、ABAC 策略引擎、与 Spring Security 集成

## SSO 单点登录

> [!warning] 待补充
>
> 基于 Session / Token 的 SSO、CAS 协议、SAML、OIDC

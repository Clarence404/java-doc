# 安全体系总览

## 模块导航

| 模块 | 覆盖内容 |
|------|----------|
| [OAuth2 与 OIDC](./1_oauth2_oidc) | 四种授权模式、OIDC 身份层、安全风险 |
| [JWT 令牌机制](./2_jwt) | 令牌结构、签名算法、失效与刷新策略 |
| [单点登录（SSO）](./3_sso) | Session SSO、CAS、SAML、OIDC、Sa-Token、Keycloak |
| [认证与授权](./4_authentication) | RBAC / ABAC 模型、权限数据库设计 |
| [API 安全](./5_api_security) | 接口签名、防重放、HTTPS |
| [数据安全](./6_data_security) | 加密算法、数据脱敏、密钥管理 |
| [常见漏洞与防护](./7_vulnerabilities) | OWASP Top 10、SQL 注入、XSS、CSRF、反序列化 |
| [零信任架构](./8_zero_trust) | 零信任模型、mTLS、OPA 动态授权 |
| [审计日志与密钥管理](./9_audit_secret) | 操作审计、密钥轮换、Vault |

---

## 安全分层模型

```
应用层：认证 / 授权 / 输入校验 / 输出编码
传输层：HTTPS / TLS / mTLS
数据层：加密存储 / 脱敏 / 审计日志
基础设施：防火墙 / WAF / 入侵检测
```

---

## 关联模块

- Spring Security 实现细节 → [spring/9_spring_security](../spring/9_spring_security)
- 认证框架（Sa-Token / Shiro）→ [spring/10_auth_framework](../spring/10_auth_framework)
- 访问控制模型 → [architecture/9_access_control_model](../architecture/9_access_control_model)
- 安全通信协议（TLS / mTLS）→ [protocols/4_security_protocols](../protocols/4_security_protocols)

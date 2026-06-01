# 安全体系总览

## 模块导航

| 模块 | 覆盖内容 |
|------|----------|
| [认证与授权](./1_authentication) | OAuth2、JWT、RBAC、ABAC、SSO |
| [API 安全](./2_api_security) | 接口签名、防重放、幂等、限流 |
| [数据安全](./3_data_security) | 加密算法、数据脱敏、密钥管理 |
| [常见漏洞](./4_vulnerabilities) | OWASP Top 10、SQL 注入、XSS、CSRF |
| [零信任架构](./5_zero_trust) | 零信任模型、mTLS、动态授权 |
| [OAuth2、OIDC 与 JWT](./6_oauth_oidc_jwt) | 授权模式、身份认证、令牌管理、安全风险 |
| [审计日志与密钥管理](./7_audit_secret) | 操作审计、密钥轮换、KMS、Vault |

## 安全分层模型

```
应用层：认证 / 授权 / 输入校验 / 输出编码
传输层：HTTPS / TLS / mTLS
数据层：加密存储 / 脱敏 / 审计日志
基础设施：防火墙 / WAF / 入侵检测
```

## 与其他模块的关系

- Spring Security 实现细节 → [spring/9_spring_security](../spring/9_spring_security)
- 认证框架（Sa-Token / Shiro）→ [spring/10_auth_framework](../spring/10_auth_framework)
- 单点登录 → [spring/11_single_sign_on](../spring/11_single_sign_on)
- 访问控制模型 → [architecture/9_access_control_model](../architecture/9_access_control_model)
- 安全通信协议 → [protocols/4_security_protocols](../protocols/4_security_protocols)

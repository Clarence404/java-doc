# 安全体系总览

安全模块覆盖 Java 后端常见的认证授权、接口防护、数据保护、漏洞治理、零信任、审计与密钥管理。阅读时建议按“身份 → 接口 → 数据 → 运行治理”的顺序建立整体安全视角。

## 一、模块导航

| 模块 | 覆盖内容 | 重点产出 |
|------|----------|----------|
| [JWT 令牌机制](./1_jwt) | 令牌结构、签名算法、失效与刷新策略 | 会设计短期 Access Token 与 Refresh Token |
| [OAuth2](./2_oauth2) | 授权框架、四角色、四种授权模式、安全风险 | 能理解 OAuth2 授权框架与 PKCE |
| [OIDC](./3_oidc) | id_token、UserInfo Endpoint、与 OAuth2 对比 | 能区分认证与授权，理解第三方登录 |
| [单点登录（SSO）](./4_sso) | Session SSO、CAS、SAML、OIDC、Sa-Token、Keycloak | 能选择合适的企业登录方案 |
| [认证与授权](./5_rbac_abac) | RBAC / ABAC 模型、权限数据库设计、OPA | 能落地菜单、按钮、数据权限 |
| [API 安全](./6_api_security) | 接口签名、防重放、API Key、CORS、HTTPS | 能保护开放接口与内部服务接口 |
| [数据安全](./7_data_security) | 加密算法、脱敏、密钥管理、操作审计、Vault | 能处理敏感字段、密钥轮换、合规审计 |
| [常见漏洞与防护](./8_vulnerabilities) | OWASP Top 10、SQL 注入、XSS、CSRF、反序列化 | 能识别常见 Web 风险并制定防护 |
| [零信任架构](./9_zero_trust) | 零信任模型、mTLS、OPA 动态授权 | 能理解服务间身份与动态策略 |

## 二、推荐阅读路径

1. 先读 [JWT](./1_jwt)、[OAuth2](./2_oauth2)、[OIDC](./3_oidc)、[单点登录（SSO）](./4_sso)，建立身份与登录体系。
2. 再读 [认证与授权](./5_rbac_abac)，区分认证、授权、RBAC、ABAC 和数据权限。
3. 然后读 [API 安全](./6_api_security) 与 [常见漏洞与防护](./8_vulnerabilities)，补齐接口暴露面的防护手段。
4. 接着读 [数据安全](./7_data_security)，覆盖敏感数据、密钥轮换、日志和追责。
5. 最后读 [零信任架构](./9_zero_trust)，把单体/网关视角扩展到微服务、服务网格和动态授权。

## 三、安全分层模型

![安全分层模型](../assets/security/security-layers.svg)

| 层次 | 核心问题 | 常见措施 |
|------|----------|----------|
| 身份层 | 谁在访问系统 | MFA、SSO、OIDC、会话管理、Token 生命周期 |
| 授权层 | 能访问什么资源 | RBAC、ABAC、数据权限、最小权限、越权测试 |
| 接口层 | 请求是否可信 | HTTPS、签名、防重放、限流、输入校验、错误响应收敛 |
| 数据层 | 敏感数据如何保护 | 字段加密、脱敏、备份加密、密钥轮换、访问审计 |
| 运行层 | 风险如何发现与追踪 | 审计日志、告警、漏洞扫描、依赖治理、应急预案 |

## 四、工程落地清单

- 登录态：Access Token 短有效期，Refresh Token 可撤销、可轮换。
- 权限：所有资源操作都做服务端鉴权，不依赖前端隐藏按钮。
- 接口：开放 API 必须有身份、签名、防重放、频率限制和错误码规范。
- 数据：密码只存哈希，敏感字段加密或脱敏，日志禁止打印明文密钥和 Token。
- 配置：密钥不入库、不入 Git，生产环境使用 KMS / Vault / 云密钥管理。
- 审计：关键操作记录操作者、对象、时间、结果、来源 IP 和 TraceId。
- 漏洞：依赖升级、镜像扫描、SAST / DAST、渗透测试要进入发布流程。

## 五、关联模块

- Spring Security 实现细节 → [spring/9_security](../spring/9_security)
- 认证框架（Sa-Token / Shiro）→ [spring/10_auth_framework](../spring/10_auth_framework)
- 访问控制模型 → [architecture/6_access_control](../architecture/6_access_control)
- 安全通信协议（TLS / mTLS）→ [protocols/4_security_protocols](../protocols/4_security_protocols)

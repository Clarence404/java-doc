# 应用安全总览

应用安全模块覆盖身份与令牌（JWT、OAuth2、OIDC、SSO）、权限模型、API 与数据安全、漏洞防护和零信任，按「身份 → 授权 → 接口 → 数据 → 运行治理」建立整体视角。

**版本基线（2026 年 10 月）**：Spring Boot 4、Spring Security 7、OIDC Core 1.0、OWASP Top 10:2025

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. **身份与登录**：先读 [JWT 令牌机制](./1_jwt)，再读 [OAuth2](./2_oauth2)、[OIDC](./3_oidc) 和 [单点登录](./4_sso)，弄清令牌格式、授权流程、身份层与跨系统登录的关系。
2. **授权**：读 [权限模型：RBAC 与 ABAC](./5_rbac_abac)，区分认证与授权，掌握 RBAC、ABAC 与数据权限。
3. **接口与漏洞**：读 [API 安全](./6_api_security) 与 [常见漏洞与防护](./8_vulnerabilities)，补齐签名、防重放、CORS、输入校验以及 OWASP Top 10 的防护手段。
4. **数据**：读 [数据安全](./7_data_security)，覆盖加密、脱敏、密钥管理与审计日志。
5. **架构演进**：最后读 [零信任架构](./9_zero_trust)，把网关边界的视角扩展到服务间 mTLS、持续验证与动态授权。

复习时用 [高频面试题](./99_interview) 自测，答案在 [应用安全面试题解答](/interview/23_security)。

## 三、安全分层模型

![安全分层模型](../assets/security/security-layers.svg)

| 层次 | 核心问题 | 常见措施 | 详见 |
|------|----------|----------|------|
| 身份层 | 谁在访问系统 | MFA、SSO、OIDC、会话管理、令牌生命周期 | [JWT 令牌机制](./1_jwt)、[OIDC](./3_oidc) |
| 授权层 | 能访问什么资源 | RBAC、ABAC、数据权限、最小权限、越权测试 | [权限模型：RBAC 与 ABAC](./5_rbac_abac) |
| 接口层 | 请求是否可信 | HTTPS、签名、防重放、限流、输入校验、错误响应收敛 | [API 安全](./6_api_security) |
| 数据层 | 敏感数据如何保护 | 字段加密、脱敏、备份加密、密钥轮换、访问审计 | [数据安全](./7_data_security) |
| 运行层 | 风险如何发现与追踪 | 审计日志、告警、漏洞扫描、依赖与供应链治理、应急预案 | [常见漏洞与防护](./8_vulnerabilities) |

## 四、工程落地清单

上线前逐项对照，每一项的具体做法见对应文章：

- **登录态**：Access Token 短有效期，Refresh Token 轮换并做重用检测；浏览器应用走 BFF，令牌不进前端（[JWT 令牌机制](./1_jwt)）。
- **权限**：所有资源操作都在服务端鉴权，不依赖前端隐藏按钮；水平越权（改 ID 访问他人数据）要有专项测试。
- **接口**：开放 API 具备身份、签名、防重放、频率限制和统一的错误响应，详细错误只进日志。
- **数据**：密码只存 Argon2id / bcrypt 哈希，敏感字段加密或脱敏，日志里不出现明文密钥和令牌。
- **密钥**：密钥不进代码库和镜像，生产用云 KMS 或密钥管理服务；HashiCorp Vault 自 2023 年改为 BSL 许可，需要开源许可时可选 Linux 基金会下的分支 OpenBao。
- **审计**：关键操作记录操作者、对象、时间、结果、来源 IP 与 TraceId，审计日志防篡改、单独留存。
- **供应链**：依赖升级、SBOM、镜像扫描与签名、SAST / DAST 纳入发布流程（OWASP Top 10:2025 新增「软件供应链失败」类别）。

## 五、关联模块

本模块讲协议原理与系统级策略，Spring Security 的配置细节放在 Spring 模块（Spring Authorization Server 已并入 Spring Security 项目）。标准基线：OAuth 2.1 仍是草案，落地以 RFC 9700 为准，授权码模式统一加 PKCE（RFC 7636）；浏览器应用参考 RFC 10017（BFF）；JWT 按 RFC 8725 与 RFC 9068；零信任参考 NIST SP 800-207；密码哈希用 Argon2id 或 bcrypt。

- Spring Security 配置（过滤器链、Resource Server、方法级权限、动态权限）→ [Spring Security](/spring/9_security)
- 认证框架选型（Spring Security / Sa-Token / Shiro）→ [安全框架对比](/spring/10_auth_framework)
- Spring 生态 SSO 接入（LDAP / CAS / SAML2 / OIDC / Keycloak / Spring Authorization Server）→ [Spring SSO 接入](/spring/11_single_sign_on)
- 权限系统架构（PEP / PDP、权限缓存、数据权限拦截）→ [权限系统架构设计](/architecture/6_access_control)
- 服务端会话与 Spring Session → [分布式会话](/distributed/5_session)
- 网关统一鉴权（网关作为 OAuth2 资源服务器）→ [API 网关](/spring-cloud/2_api_gateway)
- 服务间 mTLS 与网格安全策略 → [服务网格](/microservices/3_service_mesh)
- 证书与 TLS / mTLS 协议 → [HTTPS 与 TLS](/protocols/3_https_tls)
- Actuator 端点暴露与保护 → [Actuator 监控](/spring-boot/7_actuator)
- 日志脱敏与日志体系 → [日志](/spring-boot/12_logging)、[日志体系](/observability/1_logging)
- 依赖漏洞扫描与制品安全 → [依赖治理](/engineering/6_dependency_governance)、[制品与版本管理](/devops/6_artifact_version)
- 限流与防刷 → [限流与过载保护](/high-avail/7_rate_limiting)
- 物联网设备认证与安全 → [设备安全](/iot/5_security)

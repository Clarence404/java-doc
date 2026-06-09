# SSO 单点登录解决方案

> 参考资料：
> * Spring Security LDAP：[https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html)
> * CAS 官网：[https://apereo.github.io/cas/](https://apereo.github.io/cas/)
> * OAuth2 RFC：[https://datatracker.ietf.org/doc/html/rfc6749](https://datatracker.ietf.org/doc/html/rfc6749)

> 本文聚焦 Spring 生态下 SSO 的落地方案。OAuth2 / OIDC 协议原理见 → [OAuth2 与 OIDC](/security/6_oauth2_oidc)　JWT 令牌详见 → [JWT](/security/7_jwt)

## 一、什么是 SSO

**SSO（Single Sign-On，单点登录）**：用户只需登录一次，即可访问多个相互信任的应用系统，无需重复认证。

核心流程：用户登录认证中心 → 获取票据（Token / Cookie）→ 访问各子系统时自动校验票据。

## 二、主流方案对比

| 方案 | 协议类型 | 适用场景 | 复杂度 |
|------|---------|---------|--------|
| LDAP | 目录协议 | 企业内网统一账号 | 中 |
| CAS | SSO 专用协议 | 企业内部多系统 | 中 |
| SAML2 | XML 联邦认证 | 跨企业 / 与第三方系统对接 | 高 |
| OAuth2 / OIDC | 授权 + 认证协议 | 互联网应用，第三方登录 | 中 |
| Max-key | 国产 IAM 平台 | 企业统一身份管理平台 | 低（开箱即用） |

## 三、LDAP

**LDAP（Lightweight Directory Access Protocol）**：轻量级目录访问协议，常用于企业内网存储用户账号信息（如 Active Directory）。

- 适合：企业内部统一账号体系，员工登录内部系统
- Spring Security 原生支持 LDAP 认证
- 典型场景：公司 AD 域账号统一登录 OA / Jira / GitLab

> 官方文档：[Spring LDAP Authentication](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html#servlet-authentication-ldap-embedded)

## 四、CAS

**CAS（Central Authentication Service）**：Apereo 开源的 SSO 协议和服务端实现，专为企业多系统单点登录设计。

- 适合：企业内部多个 Web 应用的统一登录
- 架构：独立部署 CAS Server，各子系统集成 CAS Client
- 支持多种认证方式：用户名密码 / LDAP / OAuth2 / SAML

> 官网：[https://apereo.github.io/cas/](https://apereo.github.io/cas/)
> 
> 服务端模板：[https://github.com/apereo/cas-overlay-template](https://github.com/apereo/cas-overlay-template)

## 五、SAML2

**SAML2（Security Assertion Markup Language 2.0）**：基于 XML 的联邦认证标准，广泛用于企业与第三方系统的身份对接。

- 适合：跨企业 SSO，与 Okta / Azure AD / Google Workspace 等对接
- 角色：IdP（身份提供方）+ SP（服务提供方）
- Spring Security 内置 SAML2 支持

> 官方文档：[SpringSecurity-Saml2](https://docs.spring.io/spring-security/reference/servlet/saml2/index.html)

## 六、OAuth2 / OIDC

**OAuth2**：授权框架，本质是"允许第三方应用访问用户资源"。
**OIDC（OpenID Connect）**：在 OAuth2 之上增加身份认证层，是目前最主流的 SSO 标准。

- 适合：互联网应用第三方登录（微信 / GitHub / Google 登录）、微服务统一认证
- 四种授权模式：授权码 / 隐式 / 密码 / 客户端凭证
- Spring Authorization Server 是官方 OAuth2 服务端实现

> RFC：[https://datatracker.ietf.org/doc/html/rfc6749](https://datatracker.ietf.org/doc/html/rfc6749)
> 
> Spring Security OAuth2：[https://docs.spring.io/spring-security/reference/servlet/oauth2/index.html](https://docs.spring.io/spring-security/reference/servlet/oauth2/index.html)

## 七、Max-key

**Max-key**：国产开源 IAM（身份访问管理）平台，提供 SSO、用户管理、权限管理一体化解决方案。

- 适合：需要快速部署企业级身份管理平台的国内项目
- 支持协议：OAuth2 / SAML2 / CAS / LDAP
- 特点：中文友好、界面完整、开箱即用

> 官网：[https://maxkey.top/](https://maxkey.top/)
> 
> GitHub：[https://gitee.com/dromara/MaxKey](https://gitee.com/dromara/MaxKey)

> [!warning]
> 待补充

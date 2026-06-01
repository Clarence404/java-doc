# 安全协议

这些协议用于保证数据传输的安全性、完整性以及身份认证。

## 官方规范入口

| 协议 | 官方 / 原始规范 |
|------|----------------|
| TLS 1.3 | [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) |
| OAuth 2.0 | [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) |
| OpenID Connect | [OpenID Connect Specs](https://openid.net/developers/specs/) |
| JWT | [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html) |
| Kerberos | [RFC 4120](https://www.rfc-editor.org/rfc/rfc4120.html) |
| SAML 2.0 | [OASIS SAML 2.0](https://www.oasis-open.org/standard/saml/) |
| WebAuthn | [W3C WebAuthn](https://www.w3.org/TR/webauthn-3/) |

- **TLS（Transport Layer Security，传输层安全协议）**：用于加密 HTTP（HTTPS），保护数据传输安全。
- **SSL（Secure Sockets Layer）**：TLS 的前身，现已逐步被 TLS 取代。
- **OAuth 2.0**：授权协议，允许第三方应用访问用户数据（如 OAuth 登录 Facebook、Google）。
- **JWT（JSON Web Token）**：用于身份验证的轻量级令牌，常用于前后端分离的应用。
- **Kerberos**：一种基于票据的身份认证协议，适用于分布式系统。
- **SAML（Security Assertion Markup Language）**：基于 XML 的单点登录（SSO）协议，常用于企业级认证。

---
description: 认证与授权、密码登录与防撞库、会话与令牌选型、TOTP 与恢复码、Passkeys、一次性令牌、记住我
---

# 认证与登录

认证回答「你是谁」，是授权、令牌和单点登录的前提。本篇讲密码登录的正确做法、会话与令牌的选择、MFA、Passkeys 与一次性令牌登录，基线为 Spring Security 7。

---

## 一、认证与授权

认证（Authentication）确认请求方的身份，授权（Authorization）判断这个身份能做什么。两者顺序固定：先认证，再授权；授权模型见 [权限模型：RBAC 与 ABAC](./5_rbac_abac)。

| 对比项 | 认证 | 授权 |
|--------|------|------|
| 回答的问题 | 你是谁 | 你能做什么 |
| 依据 | 密码、动态码、Passkey、证书 | 角色、属性、资源归属 |
| 失败时的 HTTP 状态 | 401 Unauthorized（未认证） | 403 Forbidden（已认证但无权） |
| Spring Security 组件 | `AuthenticationManager` / `AuthenticationProvider` | `AuthorizationManager` |

认证凭据按来源分三类，**多因素**指同时使用不同类别的凭据，两个密码不算两个因素：

- **你知道的**：密码、PIN、安全问题
- **你拥有的**：手机上的 TOTP 应用、硬件安全密钥、绑定的设备
- **你本身的**：指纹、人脸，通常只在设备本地用来解锁「你拥有的」那把密钥，生物特征本身不上传服务端

Spring Security 的过滤器链、`UserDetailsService` 等基础配置见 [Spring Security](/spring/9_security)，本篇只写与登录安全相关的部分。

---

## 二、密码登录：把基础做对

### 1、存储与密码策略

密码只存 Argon2id 或 bcrypt 慢哈希，Spring Security 用 `DelegatingPasswordEncoder` 记录算法前缀并在登录时平滑升级，参数与代码见 [数据安全](./7_data_security#密码哈希)。

密码规则以 NIST SP 800-63B-4（2025 年 8 月定稿）为准，它推翻了不少老习惯：

| 规则 | NIST 800-63B-4 要求 | 老做法 |
|------|---------------------|--------|
| 最小长度 | 单因素 15 位；作为 MFA 一部分时至少 8 位 | 8 位 |
| 最大长度 | 至少支持 64 位，允许空格与 Unicode | 限制 16 或 20 位 |
| 组合规则 | 不得强制「大小写 + 数字 + 符号」 | 强制组合 |
| 定期更换 | 不得强制定期改密，有泄露证据时才要求更换 | 90 天强制改密 |
| 黑名单 | 新密码必须比对常用密码、泄露密码、用户名与站点名 | 无 |
| 粘贴与密码管理器 | 必须允许 | 禁止粘贴 |

### 2、泄露密码检查

Spring Security 提供 `CompromisedPasswordChecker` 接口和基于 Have I Been Pwned 的实现 `HaveIBeenPwnedRestApiPasswordChecker`。查询使用 k-匿名：只发送密码 SHA-1 的前 5 个十六进制字符，在返回的候选后缀里本地比对，明文和完整哈希都不出本机。

注册一个 `CompromisedPasswordChecker` Bean，表单登录使用的 `DaoAuthenticationProvider` 会自动启用它：密码正确但已泄露时抛出 `CompromisedPasswordException`，在失败处理器里引导用户去改密码，而不是只提示「登录失败」：

```java
import java.io.IOException;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.password.CompromisedPasswordChecker;
import org.springframework.security.authentication.password.CompromisedPasswordException;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationFailureHandler;
import org.springframework.security.web.authentication.password.HaveIBeenPwnedRestApiPasswordChecker;

@Configuration
public class PasswordLoginConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/login", "/reset-password").permitAll()
                .anyRequest().authenticated())
            .formLogin(form -> form
                .loginPage("/login")
                .failureHandler(new CompromisedAwareFailureHandler()));
        return http.build();
    }

    @Bean
    CompromisedPasswordChecker compromisedPasswordChecker() {
        return new HaveIBeenPwnedRestApiPasswordChecker();
    }

    static class CompromisedAwareFailureHandler implements AuthenticationFailureHandler {

        private final AuthenticationFailureHandler fallback =
                new SimpleUrlAuthenticationFailureHandler("/login?error");

        @Override
        public void onAuthenticationFailure(HttpServletRequest request, HttpServletResponse response,
                AuthenticationException exception) throws IOException, ServletException {
            if (exception instanceof CompromisedPasswordException) {
                response.sendRedirect(request.getContextPath() + "/reset-password?reason=breached");
                return;
            }
            fallback.onAuthenticationFailure(request, response, exception);
        }
    }
}
```

- 注册和改密接口同样调用 `compromisedPasswordChecker.check(rawPassword)` 拦截泄露密码，这是 NIST 黑名单要求的落地方式
- 检查依赖外网 API，内网环境可以下载 Pwned Passwords 离线哈希库，自己实现 `CompromisedPasswordChecker`

### 3、防账号枚举

账号枚举指攻击者通过不同的响应判断某个账号是否存在，进而缩小撞库范围或做定向钓鱼。

- **统一错误提示**：登录失败一律返回「用户名或密码错误」。Spring Security 的 `hideUserNotFoundExceptions` 默认开启，用户不存在也抛 `BadCredentialsException`
- **统一响应时间**：用户不存在时不算哈希，响应会明显更快。`DaoAuthenticationProvider` 在用户不存在时会对一个假密码做一次哈希比对，自定义 `AuthenticationProvider` 时要保留这一点
- **注册与找回密码**：注册时「该邮箱已被使用」、找回密码时「该账号不存在」同样会泄露信息，统一提示「如果该邮箱已注册，你会收到一封邮件」
- **锁定提示**：账号锁定后不要返回「账号已锁定」，否则等于确认账号存在且密码被试过

### 4、限流、锁定与撞库

撞库（Credential Stuffing）是用其他网站泄露的「用户名 + 密码」批量尝试登录，每个账号只试一两次，按账号锁定很难拦住；暴力破解则是对单个账号反复猜。两者要分层防：

| 层次 | 做法 | 主要拦截 |
|------|------|----------|
| 按 IP / 设备限流 | 网关或登录接口按 IP、设备指纹做滑动窗口限流 | 单源高频尝试 |
| 按账号节流 | 连续失败后逐级延迟或短时锁定（如 5 次失败锁 15 分钟） | 针对单个账号的暴力破解 |
| 人机校验 | 失败次数或风险分达到阈值后再出验证码 | 自动化脚本 |
| 泄露密码检查 | 登录时发现密码在泄露库里，强制改密 | 撞库中真正有效的那部分凭据 |
| 风险识别 | 新设备、新地区、异常时段登录要求二次验证 | 凭据已失窃的情况 |
| MFA | 拿到密码也登录不了 | 兜底 |

限流算法与 Redis 实现见 [限流与过载保护](/high-avail/7_rate_limiting)，用 Flink CEP 实时识别「连续失败后成功」的撞库特征见 [Flink 实战场景](/flink/8_scenarios)。

按账号锁定可以基于 Spring Security 的认证事件实现。Spring Boot 默认注册了 `DefaultAuthenticationEventPublisher`，认证成功和失败都会发布事件：

```java
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.context.event.EventListener;
import org.springframework.security.authentication.event.AuthenticationFailureBadCredentialsEvent;
import org.springframework.security.authentication.event.AuthenticationSuccessEvent;
import org.springframework.stereotype.Component;

@Component
public class LoginAttemptService {

    private static final int MAX_FAILURES = 5;
    private static final Duration LOCK_DURATION = Duration.ofMinutes(15);

    // 演示用本地 Map；多实例部署换成 Redis（INCR + EXPIRE），键为用户名
    private final Map<String, Attempt> attempts = new ConcurrentHashMap<>();

    private record Attempt(int failures, Instant lastFailure) {
    }

    @EventListener
    public void onFailure(AuthenticationFailureBadCredentialsEvent event) {
        String username = event.getAuthentication().getName();
        attempts.merge(username, new Attempt(1, Instant.now()),
                (old, latest) -> new Attempt(old.failures() + 1, latest.lastFailure()));
    }

    @EventListener
    public void onSuccess(AuthenticationSuccessEvent event) {
        attempts.remove(event.getAuthentication().getName());
    }

    /** 在 UserDetailsService 中调用，映射为 UserDetails 的 accountLocked */
    public boolean isLocked(String username) {
        Attempt attempt = attempts.get(username);
        if (attempt == null || attempt.failures() < MAX_FAILURES) {
            return false;
        }
        if (attempt.lastFailure().plus(LOCK_DURATION).isBefore(Instant.now())) {
            attempts.remove(username);
            return false;
        }
        return true;
    }
}
```

::: warning 锁定本身也是攻击面
按用户名永久锁定会让攻击者故意输错密码把别人锁死。锁定要有时限并逐级加长，配合按 IP 限流与验证码；NIST 800-63B-4 把单个账号连续失败的上限定为 100 次，超过才要求禁用该凭据，企业通常取更低的值。
:::

---

## 三、登录之后：会话还是令牌

认证成功后要给客户端一个「已登录」的凭证，后续请求靠它识别身份。常见两种形态：

| 对比项 | 服务端会话（Session + Cookie） | 令牌（Bearer Token） |
|--------|-------------------------------|----------------------|
| 状态存放 | 服务端存会话，浏览器只拿会话 ID | 令牌自包含（JWT）或服务端可查（不透明令牌） |
| 退出 / 踢人 | 删会话即刻生效 | JWT 需要短有效期 + 吊销设计 |
| 集群 | 需要共享会话（Spring Session + Redis） | 天然无状态，资源服务本地验签 |
| CSRF | Cookie 自动携带，必须防 CSRF | 放在 Authorization 头时不受 CSRF 影响 |
| 适合 | 同站点的浏览器应用、管理后台 | 移动端、第三方客户端、服务间调用、开放 API |

选型原则：

- **浏览器应用优先用会话**：自建前后端同站点时，会话 Cookie 比把 JWT 放进浏览器更简单也更安全；集群部署用 Spring Session，见 [分布式会话](/distributed/5_session)
- **令牌交给 OAuth2 体系**：移动端、第三方接入或多服务架构，用 OAuth2 授权服务器签发短期访问令牌，格式与吊销见 [JWT 令牌机制](./1_jwt)，授权流程见 [OAuth2](./2_oauth2)
- **SPA 走 BFF**：前端只持有会话 Cookie，令牌留在服务端的 BFF 里，见 [JWT 令牌机制](./1_jwt#九、token-存在哪里)

使用会话时要守住以下几点，其中会话固定防护 Spring Security 默认开启：

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SessionLoginConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .sessionManagement(session -> session
                .sessionFixation(fixation -> fixation.changeSessionId())   // 默认值：登录后更换会话 ID
                .maximumSessions(3))                                       // 同一账号最多 3 个会话
            .logout(logout -> logout
                .invalidateHttpSession(true)
                .deleteCookies("SESSION"));                                // Spring Session 的 Cookie 名
        return http.build();
    }
}
```

- **会话固定**：登录前后必须更换会话 ID，否则攻击者预先种下的会话 ID 登录后就成了已认证会话
- **超时**：设置空闲超时（如 30 分钟）和绝对超时（如 12 小时），绝对超时要自己在会话里记录登录时间判断
- **Cookie 属性**：`HttpOnly`、`Secure`、`SameSite=Lax`，能用 `__Host-` 前缀就用
- **敏感操作再认证**：改密码、改绑手机、提现前要求重新输入密码或通过 MFA，不只看「已登录」
- **改密后清理**：修改密码、重置密码后让该账号的其他会话全部失效

---

## 四、多因素认证（MFA）

### 1、为什么短信验证码不够

短信验证码是最普及的第二因素，但它的弱点很明确：

- **SIM 卡劫持**：攻击者冒充用户到运营商补卡或携号转网，验证码直接发到攻击者手里
- **信令网络漏洞**：SS7 等电信信令协议可以被用来拦截短信
- **实时钓鱼**：仿冒网站把用户输入的验证码实时转发给真网站，任何「输入一串码」的方式都挡不住
- **成本与滥用**：短信接口会被刷量消耗费用，发送前要做图形验证与限流

NIST 800-63B-4 把基于电话网络的短信、语音验证码列为「受限」认证方式：可以用，但必须同时提供其他方式，并在发送前检查换卡、携号转网等风险信号。条件允许时优先 Passkey，其次 TOTP，短信只做兜底。

### 2、TOTP：基于时间的一次性密码

TOTP（RFC 6238）是 Google Authenticator、Microsoft Authenticator 等应用使用的算法，本质是把当前时间作为计数器的 HOTP（RFC 4226）：

1. **绑定**：服务端生成至少 160 位随机密钥，以 `otpauth://totp/站点:用户?secret=Base32密钥&issuer=站点` 的形式生成二维码，用户扫码后让其输入一次动态码确认绑定成功
2. **计算**：双方各自计算 `T = floor(当前 Unix 时间 / 30)`，对 `HMAC-SHA1(密钥, T)` 做动态截断，取 6 位数字
3. **校验**：服务端允许前后各 1 个时间步的时钟偏差，并记录最近一次成功的时间步，同一个码不能用第二次

下面的实现只依赖 JDK，可用于理解算法；生产中密钥生成和 Base32 编码可借助 Apache Commons Codec 等库：

```java
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Instant;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class TotpVerifier {

    private static final long STEP_SECONDS = 30;
    private static final int WINDOW = 1;          // 允许前后各 1 个时间步（±30 秒）

    private TotpVerifier() {
    }

    /**
     * 校验动态码，成功返回匹配的时间步，失败返回 -1。
     * 调用方保存返回值，下次传入 lastUsedStep，拒绝重复使用同一时间步的码。
     */
    public static long verify(byte[] secret, String code, long lastUsedStep) {
        if (code == null || !code.matches("\\d{6}")) {
            return -1;
        }
        long current = Instant.now().getEpochSecond() / STEP_SECONDS;
        for (long step = current - WINDOW; step <= current + WINDOW; step++) {
            if (step <= lastUsedStep) {
                continue;
            }
            byte[] expected = generate(secret, step).getBytes(StandardCharsets.US_ASCII);
            if (MessageDigest.isEqual(expected, code.getBytes(StandardCharsets.US_ASCII))) {
                return step;
            }
        }
        return -1;
    }

    static String generate(byte[] secret, long step) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret, "HmacSHA1"));
            byte[] hash = mac.doFinal(ByteBuffer.allocate(Long.BYTES).putLong(step).array());
            int offset = hash[hash.length - 1] & 0x0f;   // 动态截断：最后 4 位决定起始下标
            int binary = ((hash[offset] & 0x7f) << 24)
                    | ((hash[offset + 1] & 0xff) << 16)
                    | ((hash[offset + 2] & 0xff) << 8)
                    | (hash[offset + 3] & 0xff);
            return String.format("%06d", binary % 1_000_000);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

- **密钥要加密存储**：TOTP 密钥是共享秘密，服务端必须能还原，不能像密码那样只存哈希，用字段加密或信封加密保护，见 [数据安全](./7_data_security#信封加密)
- **校验接口要限流**：6 位数字只有 100 万种组合，不限流可以在有效窗口内被暴力尝试
- **TOTP 防不住实时钓鱼**：它解决的是密码泄露，钓鱼网站照样能实时转发动态码

### 3、恢复码

用户换手机、丢手机后需要恢复入口，恢复流程往往是整套认证里最薄弱的一环：

- 绑定 MFA 时生成 8～10 个一次性恢复码（每个至少 10 位随机字符），**只展示一次**，提示用户离线保存
- 服务端像密码一样只存哈希，用掉一个作废一个；重新生成时旧码全部作废
- 使用恢复码登录后通知用户，并引导重新绑定 MFA
- 人工客服重置 MFA 必须有严格的身份核验流程，社工攻击常从这里突破

### 4、Spring Security 7 的多因素支持

Spring Security 7 引入了内置的多因素认证：每种认证方式成功后，会给 `Authentication` 添加一个 `FactorGrantedAuthority`，如表单登录得到 `FACTOR_PASSWORD`、一次性令牌得到 `FACTOR_OTT`、Passkey 得到 `FACTOR_WEBAUTHN`。用 `@EnableMultiFactorAuthentication` 声明需要哪些因素，缺少的因素会自动引导到对应的登录页补齐：

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.authorization.EnableMultiFactorAuthentication;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.authority.FactorGrantedAuthority;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableMultiFactorAuthentication(authorities = {
        FactorGrantedAuthority.PASSWORD_AUTHORITY,
        FactorGrantedAuthority.OTT_AUTHORITY })
public class MfaConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/admin/**").hasRole("ADMIN")   // 实际要求：密码 + 一次性令牌 + ADMIN
                .anyRequest().authenticated())                   // 实际要求：密码 + 一次性令牌
            .formLogin(Customizer.withDefaults())                // 提供 FACTOR_PASSWORD
            .oneTimeTokenLogin(Customizer.withDefaults());       // 提供 FACTOR_OTT
        return http.build();
    }
}
```

内置因素包括密码、一次性令牌、WebAuthn、X.509 证书和 OAuth2 授权码登录。TOTP 不在其中，需要自己实现一个 `AuthenticationProvider` 并在成功时加上自定义的因素权限。只想对部分接口要求 MFA 时，用 `@EnableMultiFactorAuthentication(authorities = {})` 关闭全局要求，再通过 `AuthorizationManagerFactory` 按路径配置，示例见第五节的 Passkey 配置。

---

## 五、Passkeys 与 WebAuthn

### 1、核心概念

Passkey 是基于 FIDO2 标准的无密码凭据：浏览器端 API 是 W3C 的 WebAuthn，浏览器与认证器之间的协议是 FIDO 联盟的 CTAP2。注册时认证器为当前网站生成一对密钥，**私钥留在设备里，服务端只保存公钥**；登录时认证器用私钥对服务端的随机挑战签名，服务端用公钥验签。

它比密码和 TOTP 强在三点：

- **抗钓鱼**：凭据与网站域名（rpId）绑定，浏览器只会把 `example.com` 的凭据交给 `example.com`，仿冒域名拿不到签名
- **服务端无秘密**：数据库泄露只泄露公钥，没有可以拿去撞库的东西
- **一步完成多因素**：持有设备（你拥有的）+ 指纹或 PIN 解锁（你本身的 / 你知道的），一次操作即满足 MFA

| 术语 | 含义 |
|------|------|
| RP（Relying Party） | 依赖方，即你的网站；rpId 通常是注册域名，如 `example.com` |
| challenge | 服务端每次生成的随机数，防止签名被重放 |
| 凭证 ID / user handle | 认证器中凭据的标识 / 服务端分配给用户的不透明 ID，不要用邮箱或手机号 |
| 可发现凭证 | 凭据存了 user handle，登录时不用先输用户名；Passkey 都是可发现凭证 |
| UP / UV | 用户在场（触碰）/ 用户验证（指纹、PIN），登录时应要求 UV |
| 同步与设备绑定 | 同步 Passkey 通过 iCloud 钥匙串、Google 密码管理器等跨设备同步；硬件安全密钥是设备绑定的，不可导出 |
| 签名计数器 | 认证器每次签名递增，用于发现克隆；同步 Passkey 通常恒为 0，不能依赖它 |

### 2、注册与认证仪式

WebAuthn 把注册和登录称为「仪式」（ceremony），两者结构相同：服务端出题，浏览器转交认证器，认证器生成密钥或签名，服务端校验。

![WebAuthn 注册与认证仪式](../assets/security/webauthn-ceremony.svg)

服务端校验时必须检查：challenge 与本次下发的一致、`origin` 在允许列表内、rpId 哈希匹配、用户验证标志位已置位，以及签名能用登记的公钥验证通过。这些都由框架完成，不要自己解析 CBOR 手写校验。

### 3、Spring Security 7 配置

Spring Security 6.4 起内置 Passkeys 支持，7.0 起放在独立模块 `spring-security-webauthn` 中（版本由 Spring Boot 管理）：

```xml
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-webauthn</artifactId>
</dependency>
```

下面的配置允许两种登录方式：Passkey 单独即可访问 `/account/**`，没有 Passkey 的用户需要「密码 + 一次性令牌」两个因素；凭据存在数据库里：

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcOperations;
import org.springframework.security.authorization.AllRequiredFactorsAuthorizationManager;
import org.springframework.security.authorization.AuthorizationManagers;
import org.springframework.security.authorization.DefaultAuthorizationManagerFactory;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.webauthn.management.JdbcPublicKeyCredentialUserEntityRepository;
import org.springframework.security.web.webauthn.management.JdbcUserCredentialRepository;

@Configuration
public class PasskeyConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        AllRequiredFactorsAuthorizationManager<Object> passkey = AllRequiredFactorsAuthorizationManager
                .<Object>builder()
                .requireFactor(factor -> factor.webauthnAuthority())
                .build();
        AllRequiredFactorsAuthorizationManager<Object> passwordAndOtt = AllRequiredFactorsAuthorizationManager
                .<Object>builder()
                .requireFactor(factor -> factor.passwordAuthority())
                .requireFactor(factor -> factor.ottAuthority())
                .build();
        DefaultAuthorizationManagerFactory<Object> mfa = new DefaultAuthorizationManagerFactory<>();
        mfa.setAdditionalAuthorization(AuthorizationManagers.anyOf(passkey, passwordAndOtt));   // 两组因素满足其一

        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/account/**").access(mfa.authenticated())
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .oneTimeTokenLogin(Customizer.withDefaults())
            .webAuthn(webAuthn -> webAuthn
                .rpName("Example")
                .rpId("example.com")                          // 注册域名，子域名共享时写父域
                .allowedOrigins("https://example.com"));      // 必须与浏览器地址栏的 origin 完全一致
        return http.build();
    }

    @Bean
    JdbcPublicKeyCredentialUserEntityRepository userEntityRepository(JdbcOperations jdbc) {
        return new JdbcPublicKeyCredentialUserEntityRepository(jdbc);
    }

    @Bean
    JdbcUserCredentialRepository userCredentialRepository(JdbcOperations jdbc) {
        return new JdbcUserCredentialRepository(jdbc);
    }
}
```

不配置这两个仓库时凭据存在内存中，重启即丢失。默认端点如下，四个 POST 请求都需要 CSRF Token：

| 用途 | 端点 | 说明 |
|------|------|------|
| 注册页 | `GET /webauthn/register` | Spring Security 自带的参考页面 |
| 获取注册参数 | `POST /webauthn/register/options` | 要求已登录，生成并暂存 challenge |
| 提交注册结果 | `POST /webauthn/register` | `navigator.credentials.create()` 的结果 |
| 获取认证参数 | `POST /webauthn/authenticate/options` | 生成新的 challenge |
| 提交认证结果 | `POST /login/webauthn` | `navigator.credentials.get()` 的结果 |

### 4、落地要点

- **先登录再注册**：注册端点要求已认证，通常在密码或一次性令牌登录后引导用户「添加 Passkey」
- **HTTPS 必需**：WebAuthn 只在安全上下文中可用，本地开发的 `localhost` 例外
- **允许多个 Passkey**：用户可能有手机、电脑和硬件密钥，账号设置页要能查看、命名和删除凭据
- **保留恢复路径**：Passkey 丢失后的恢复方式（另一把 Passkey、恢复码、人工核验）决定了整体安全下限
- **自动填充登录**：前端调用 `navigator.credentials.get()` 时传 `mediation: "conditional"`，用户名输入框会直接列出可用的 Passkey，过渡期与密码登录并存

---

## 六、一次性令牌登录与「记住我」

### 1、一次性令牌登录

一次性令牌（One-Time Token，OTT）登录就是「邮件魔法链接」或「邮件验证码」：用户输入用户名，系统把一个短期、只能用一次的令牌发到其邮箱，凭令牌登录。Spring Security 6.4 起用 `oneTimeTokenLogin()` 开启：

| 项目 | 默认值 |
|------|--------|
| 生成令牌 | `POST /ott/generate`，参数 `username` |
| 提交页面 | `GET /login/ott`，链接带 `?token=` 时自动填入 |
| 登录处理 | `POST /login/ott` |
| 有效期 | 5 分钟，可通过 `GenerateOneTimeTokenRequestResolver` 调整 |
| 存储 | `InMemoryOneTimeTokenService`；生产用 `JdbcOneTimeTokenService` |

框架不负责发送令牌，必须提供一个 `OneTimeTokenGenerationSuccessHandler` Bean：

```java
import java.io.IOException;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.authentication.ott.OneTimeToken;
import org.springframework.security.web.authentication.ott.OneTimeTokenGenerationSuccessHandler;
import org.springframework.security.web.authentication.ott.RedirectOneTimeTokenGenerationSuccessHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;

@Component
public class MagicLinkSuccessHandler implements OneTimeTokenGenerationSuccessHandler {

    /** 应用自己的发送接口：按用户名查邮箱并发信，用户不存在时静默返回 */
    public interface LoginLinkSender {
        void send(String username, String link);
    }

    private final LoginLinkSender sender;
    private final OneTimeTokenGenerationSuccessHandler redirect =
            new RedirectOneTimeTokenGenerationSuccessHandler("/ott/sent");

    public MagicLinkSuccessHandler(LoginLinkSender sender) {
        this.sender = sender;
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, OneTimeToken token)
            throws IOException, ServletException {
        String link = UriComponentsBuilder.fromUriString("https://example.com")   // 用固定域名，不信任 Host 头
                .path("/login/ott")
                .queryParam("token", token.getTokenValue())
                .toUriString();
        sender.send(token.getUsername(), link);
        redirect.handle(request, response, token);   // 无论账号是否存在都跳到同一个「已发送」页
    }
}
```

- **链接域名写死**：根据请求的 Host 头拼链接，攻击者伪造 Host 就能让真实用户收到指向恶意域名的令牌
- **先 GET 后 POST**：默认的 `GET /login/ott` 只展示确认页，真正登录是 POST，邮件安全网关预扫描链接不会把令牌提前用掉
- **防枚举与限流**：生成接口对存在和不存在的用户返回同样的页面，并按用户名和 IP 限制发送频率
- **安全等级等于邮箱**：邮箱被盗就等于账号被盗，高价值账号要叠加其他因素

### 2、记住我

「记住我」在会话过期后用一个长期 Cookie 自动重新登录，本质是一个有效期数周的凭证。Spring Security 提供两种实现：

| 实现 | Cookie 内容 | 被盗后 |
|------|------------|--------|
| `TokenBasedRememberMeServices`（默认） | 用户名、过期时间与签名（签名包含密码哈希，默认 SHA-256） | 到期前一直可用，只有改密码才能让它失效 |
| `PersistentTokenBasedRememberMeServices` | 系列号 + 随机令牌，服务端存表，每次使用都换新令牌 | 同一系列号出现旧令牌即判定被盗，删除该用户全部记录 |

需要「记住我」时选持久化方案，并把敏感操作限定为完整认证：

```java
import javax.sql.DataSource;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.rememberme.JdbcTokenRepositoryImpl;
import org.springframework.security.web.authentication.rememberme.PersistentTokenRepository;

@Configuration
public class RememberMeConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, PersistentTokenRepository tokenRepository)
            throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/account/security/**").fullyAuthenticated()   // 记住我登录的用户需重新输入密码
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .rememberMe(remember -> remember
                .tokenRepository(tokenRepository)
                .tokenValiditySeconds(14 * 24 * 3600));
        return http.build();
    }

    @Bean
    PersistentTokenRepository tokenRepository(DataSource dataSource) {
        JdbcTokenRepositoryImpl repository = new JdbcTokenRepositoryImpl();
        repository.setDataSource(dataSource);   // 表结构见 JdbcTokenRepositoryImpl.CREATE_TABLE_SQL
        return repository;
    }
}
```

- 记住我登录得到的是 `RememberMeAuthenticationToken`，`authenticated()` 放行，`fullyAuthenticated()` 不放行，改密、支付等操作用后者
- 退出登录和修改密码时删除该用户的全部记住我记录
- 公共电脑、管理后台不提供记住我；有 SSO 或长会话时通常不需要它

---

## 七、登录安全检查清单

上线前逐项对照：

- **密码**：Argon2id / bcrypt 存储；最小长度按 NIST 要求，不强制组合与定期改密；注册、改密与登录时检查泄露密码
- **防枚举**：登录、注册、找回密码、一次性令牌生成的响应内容与耗时一致
- **防暴力与撞库**：按 IP、账号、设备分层限流，逐级延迟或短时锁定，异常时出验证码，风险登录要求二次验证
- **会话**：登录后更换会话 ID；Cookie 设置 `HttpOnly`、`Secure`、`SameSite`；有空闲与绝对超时；退出与改密时会话全部失效
- **MFA**：管理后台和高价值操作强制 MFA；优先 Passkey，其次 TOTP，短信只做兜底；恢复码只存哈希
- **再认证**：改密码、改绑手机或邮箱、关闭 MFA、导出数据前重新验证身份
- **通知**：新设备登录、改密、MFA 变更时通过已绑定渠道通知用户
- **审计**：登录成功与失败记录用户、IP、设备、结果与 TraceId，日志里不出现密码和令牌，见 [数据安全](./7_data_security#四、审计日志)
- **传输**：登录相关页面全站 HTTPS 并开启 HSTS

---

## 小结

- 认证确认身份，授权决定权限；失败分别对应 401 与 403；多因素指不同类别的凭据
- 密码只存慢哈希，规则按 NIST 800-63B-4：重长度、不强制组合与定期改密、比对泄露库；Spring Security 用 `CompromisedPasswordChecker` 一个 Bean 即可接入
- 统一错误提示与耗时防枚举；按 IP、账号、设备分层限流，锁定要有时限，泄露密码检查与 MFA 是撞库的兜底
- 同站点浏览器应用优先用服务端会话，移动端、第三方与多服务用 OAuth2 令牌，SPA 走 BFF
- 短信验证码易被劫持和钓鱼；TOTP 按 RFC 6238 实现，防重放、密钥加密存储；恢复码一次性且只存哈希
- Passkey 私钥不出设备、凭据绑定域名，天然抗钓鱼；Spring Security 7 用 `webAuthn()`、`oneTimeTokenLogin()` 与 `@EnableMultiFactorAuthentication` 即可组合出多种登录策略
- 一次性令牌的安全等级等于邮箱；记住我用持久化令牌，敏感操作要求 `fullyAuthenticated()`

## 参考资料

- 数字身份指南：[NIST SP 800-63B-4 - Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html)
- TOTP / HOTP：[RFC 6238 - TOTP: Time-Based One-Time Password Algorithm](https://datatracker.ietf.org/doc/html/rfc6238)、[RFC 4226 - HOTP: An HMAC-Based One-Time Password Algorithm](https://datatracker.ietf.org/doc/html/rfc4226)
- WebAuthn 规范：[W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- Passkeys 介绍：[FIDO Alliance - Passkeys](https://fidoalliance.org/passkeys/)
- Spring Security Passkeys：[Passkeys](https://docs.spring.io/spring-security/reference/servlet/authentication/passkeys.html)
- Spring Security 一次性令牌：[One-Time Token Login](https://docs.spring.io/spring-security/reference/servlet/authentication/onetimetoken.html)
- Spring Security 多因素认证：[Multi-Factor Authentication](https://docs.spring.io/spring-security/reference/servlet/authentication/mfa.html)
- Spring Security 泄露密码检查：[Password Storage - Compromised Password Checking](https://docs.spring.io/spring-security/reference/features/authentication/password-storage.html)
- Spring Security 记住我：[Remember-Me Authentication](https://docs.spring.io/spring-security/reference/servlet/authentication/rememberme.html)
- OWASP：[Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)、[Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- Have I Been Pwned：[Pwned Passwords API](https://haveibeenpwned.com/API/v3#PwnedPasswords)

> 下一篇：[JWT 令牌机制](./1_jwt)

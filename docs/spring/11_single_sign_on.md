---
description: LDAP / CAS / SAML2 / OIDC 接入、Keycloak 登出、授权服务器、Sa-Token SSO
---

# Spring SSO 接入

> **本篇目标**：能在 Spring Boot 4 / Spring Security 7 中完成 LDAP、CAS、SAML2、OIDC 四类单点登录接入，正确处理 Keycloak 的角色映射与单点登出，用 Spring Authorization Server 自建认证中心，并掌握 Sa-Token SSO 的接入方式。
>
> **前置阅读**：[单点登录](/security/4_sso)、[OIDC](/security/3_oidc)、[Spring Security](./9_security)

本篇只讲 Spring 生态下的接入配置。SSO 原理（三方票据模型、方案对比与选型、CAS 票据、单点登出、IAM 平台）见 [单点登录](/security/4_sso)；OIDC 协议见 [OIDC](/security/3_oidc)；OAuth2 协议见 [OAuth2](/security/2_oauth2)；JWT 见 [JWT 令牌机制](/security/1_jwt)。

---

## 一、接入方式速览

| 协议 | Boot 4 依赖 | Spring 扮演的角色 | 典型对接方 |
|------|------------|------------------|-----------|
| LDAP | `spring-boot-starter-ldap` + `spring-security-ldap` | 用统一账号库做认证（不是 SSO 票据） | OpenLDAP、AD |
| CAS | `spring-security-cas` | CAS Client | Apereo CAS |
| SAML2 | `spring-boot-starter-security-saml2` | Service Provider（SP） | ADFS、Okta、企业 IdP |
| OIDC | `spring-boot-starter-security-oauth2-client` | Relying Party（OIDC Client） | Keycloak、MaxKey、Okta、Entra ID |
| JWT 资源服务器 | `spring-boot-starter-security-oauth2-resource-server` | 资源服务器，校验 access_token | 任意 OAuth2 授权服务器 |
| 自建认证中心 | `spring-boot-starter-security-oauth2-authorization-server` | OAuth2 / OIDC 授权服务器 | 自家各子系统 |

> Boot 4 起 OAuth2 相关 starter 统一加上 `security-` 前缀，旧名 `spring-boot-starter-oauth2-client` 等仍可用但已废弃。

---

## 二、LDAP

LDAP 只是统一账号库，不是 SSO 票据方案，定位说明见 [单点登录](/security/4_sso)。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-ldap</artifactId>   <!-- 自动配置 LdapContextSource -->
</dependency>
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-ldap</artifactId>
</dependency>
```

```yaml
spring:
  ldap:
    urls: ldaps://ldap.example.com:636
    base: dc=example,dc=com
    username: cn=readonly,dc=example,dc=com   # 只读查询账号，用于搜索用户与组
    password: ${LDAP_PASSWORD}
```

```java
@Configuration
@EnableWebSecurity
public class LdapSecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .build();
    }

    // Boot 自动配置的 LdapContextSource 实现了 BaseLdapPathContextSource
    @Bean
    AuthenticationManager ldapAuthenticationManager(BaseLdapPathContextSource contextSource) {
        LdapBindAuthenticationManagerFactory factory =
            new LdapBindAuthenticationManagerFactory(contextSource);
        factory.setUserDnPatterns("uid={0},ou=people");            // 相对 spring.ldap.base
        // 从 ou=groups 下查用户所属组，组名映射为 ROLE_xxx
        factory.setLdapAuthoritiesPopulator(
            new DefaultLdapAuthoritiesPopulator(contextSource, "ou=groups"));
        return factory.createAuthenticationManager();
    }
}
```

AD 域控用 `ActiveDirectoryLdapAuthenticationProvider` 更简单（按 `userPrincipalName` 绑定）。本地开发可用 `spring.ldap.embedded.*` 启动内嵌 UnboundID 服务器。

---

## 三、CAS

CAS 票据流程（TGC / ST）见 [单点登录](/security/4_sso)。已使用 Spring Security 的应用用 `spring-security-cas`（版本由 Spring Security BOM 管理，会传递引入 Apereo `cas-client-core`）：

```xml
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-cas</artifactId>
</dependency>
```

```java
@Configuration
@EnableWebSecurity
public class CasSecurityConfig {

    private static final String CAS_SERVER = "https://cas.example.com/cas";

    @Bean
    ServiceProperties serviceProperties() {
        ServiceProperties sp = new ServiceProperties();
        sp.setService("https://app-a.example.com/login/cas");   // 回调地址，CasAuthenticationFilter 默认处理 /login/cas
        sp.setSendRenew(false);
        return sp;
    }

    @Bean
    CasAuthenticationProvider casAuthenticationProvider(ServiceProperties sp,
                                                        UserDetailsService userDetailsService) {
        CasAuthenticationProvider provider = new CasAuthenticationProvider();
        provider.setServiceProperties(sp);
        provider.setTicketValidator(new Cas30ServiceTicketValidator(CAS_SERVER));   // CAS 3.0 协议，可返回属性
        provider.setAuthenticationUserDetailsService(
            new UserDetailsByNameServiceWrapper<>(userDetailsService));             // 用户名 → 本地角色
        provider.setKey("app-a-cas-provider");
        return provider;
    }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, ServiceProperties sp,
                                    CasAuthenticationProvider provider) throws Exception {
        CasAuthenticationEntryPoint entryPoint = new CasAuthenticationEntryPoint();
        entryPoint.setLoginUrl(CAS_SERVER + "/login");
        entryPoint.setServiceProperties(sp);

        CasAuthenticationFilter casFilter = new CasAuthenticationFilter();
        casFilter.setAuthenticationManager(new ProviderManager(provider));
        // 手动添加的认证过滤器需显式把认证结果存入 Session
        casFilter.setSecurityContextRepository(new HttpSessionSecurityContextRepository());

        return http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .exceptionHandling(e -> e.authenticationEntryPoint(entryPoint))   // 未登录 → 跳 CAS 登录页
            .addFilter(casFilter)
            .build();
    }
}
```

`Cas30ServiceTicketValidator` 来自 `org.apereo.cas.client.validation` 包。不使用 Spring Security 的老项目，也可以直接用 Apereo 的 `org.apereo.cas.client:cas-client-support-springboot`（4.x 为 Jakarta 线，版本不受 Boot BOM 管理，必须显式写版本，并在配置类上加 `@EnableCasClient`，否则 `cas.*` 配置不生效）。服务端部署用官方 [cas-overlay-template](https://github.com/apereo/cas-overlay-template)。

---

## 四、SAML2

SAML2 角色与 metadata 信任机制见 [单点登录](/security/4_sso)。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-saml2</artifactId>
</dependency>
```

SAML2 模块基于 OpenSAML（Spring Security 7 默认使用 `OpenSaml5AuthenticationProvider`），OpenSAML 发布在 Shibboleth 仓库，构建时需要加上：

```xml
<repositories>
    <repository>
        <id>shibboleth-releases</id>
        <url>https://build.shibboleth.net/maven/releases/</url>
        <snapshots><enabled>false</enabled></snapshots>
    </repository>
</repositories>
```

```yaml
# Spring Security 作为 SP 对接企业 IdP，registrationId = okta
spring:
  security:
    saml2:
      relyingparty:
        registration:
          okta:
            assertingparty:
              metadata-uri: https://xxx.okta.com/app/xxx/sso/saml/metadata   # 从 metadata 读取 IdP 证书与端点
```

```java
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(a -> a.anyRequest().authenticated())
        .saml2Login(Customizer.withDefaults())
        .saml2Logout(Customizer.withDefaults())    // SAML 单点登出
        .saml2Metadata(Customizer.withDefaults())  // 暴露 SP metadata 供 IdP 导入
        .build();
}
```

在 IdP 侧需要登记：

- **ACS 地址**（断言消费端点）：`{baseUrl}/login/saml2/sso/{registrationId}`
- **SP Entity ID**：默认 `{baseUrl}/saml2/service-provider-metadata/{registrationId}`，也就是 metadata 地址

角色映射：断言中的组属性在 `Saml2AuthenticatedPrincipal#getAttribute(...)` 中，用 `GrantedAuthoritiesMapper` 或自定义 `OpenSaml5AuthenticationProvider` 的 response 转换器映射为 `ROLE_xxx`。

---

## 五、OIDC Client 与资源服务器

授权码 + PKCE 流程见 [OIDC](/security/3_oidc)。

### 1、Web 应用作为 OIDC Client

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-oauth2-client</artifactId>
</dependency>
```

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          sso:                                   # registrationId
            client-id: order-web
            client-secret: ${SSO_CLIENT_SECRET}
            scope: openid, profile, email
            authorization-grant-type: authorization_code
            # redirect-uri 默认 {baseUrl}/login/oauth2/code/{registrationId}，一般不必写
        provider:
          sso:
            issuer-uri: https://auth.example.com   # 启动时读取 /.well-known/openid-configuration，自动发现所有端点
```

`SecurityFilterChain` 中加 `.oauth2Login(Customizer.withDefaults())` 即可完成登录。

### 2、微服务作为资源服务器

微服务不参与登录，只校验网关或前端传来的 access_token：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-oauth2-resource-server</artifactId>
</dependency>
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com   # 自动获取 JWK Set 并校验 iss
          audiences: order-service               # 校验 aud，防止其他服务的 Token 被拿来调用本服务
```

默认只把 `scope` 映射为 `SCOPE_xxx` 权限。Keycloak 的角色在 access_token 的 `realm_access.roles` 中，需要自定义转换器：

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class ResourceServerConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/admin/**").hasRole("admin")
                .anyRequest().authenticated())
            .oauth2ResourceServer(rs -> rs.jwt(jwt ->
                jwt.jwtAuthenticationConverter(keycloakJwtConverter())))
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .build();
    }

    private JwtAuthenticationConverter keycloakJwtConverter() {
        JwtGrantedAuthoritiesConverter scopes = new JwtGrantedAuthoritiesConverter();  // 保留 SCOPE_xxx
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setPrincipalClaimName("preferred_username");
        converter.setJwtGrantedAuthoritiesConverter(jwt -> {
            Collection<GrantedAuthority> authorities = new ArrayList<>(scopes.convert(jwt));
            Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
            if (realmAccess != null && realmAccess.get("roles") instanceof Collection<?> roles) {
                roles.forEach(r -> authorities.add(new SimpleGrantedAuthority("ROLE_" + r)));
            }
            return authorities;
        });
        return converter;
    }
}
```

---

## 六、Keycloak 实战

Keycloak / MaxKey 都是标准 OIDC Provider，对接方式与第五节相同，只需把 `issuer-uri` 指向 realm。

### 1、配置

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: my-app
            client-secret: ${KEYCLOAK_SECRET}
            authorization-grant-type: authorization_code
            scope: openid, profile, email
        provider:
          keycloak:
            issuer-uri: https://keycloak.example.com/realms/my-realm
```

### 2、过滤器链：登录 + 双向单点登出

一条过滤器链同时完成三件事：OIDC 登录、接收 Keycloak 的 Back-Channel 登出通知、用户在本应用点注销时通知 Keycloak（RP-Initiated Logout）。

```java
@Configuration
@EnableWebSecurity
public class KeycloakSecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http,
                                    ClientRegistrationRepository clientRegistrationRepository) throws Exception {
        // RP-Initiated Logout：从 issuer 元数据发现 end_session_endpoint，自动带上 id_token_hint
        OidcClientInitiatedLogoutSuccessHandler logoutSuccessHandler =
            new OidcClientInitiatedLogoutSuccessHandler(clientRegistrationRepository);
        logoutSuccessHandler.setPostLogoutRedirectUri("{baseUrl}");   // 需在 Keycloak 客户端登记为合法回跳地址

        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/public/**").permitAll()
                .anyRequest().authenticated())
            .oauth2Login(Customizer.withDefaults())
            .logout(l -> l.logoutSuccessHandler(logoutSuccessHandler))
            .oidcLogout(l -> l.backChannel(Customizer.withDefaults()))   // 接收 Keycloak 的登出通知
            .build();
    }
}
```

不要用 `logoutSuccessUrl` 手工拼 Keycloak 的登出地址：Keycloak 18 起要求请求携带 `id_token_hint`（或 `client_id`）才能按 `post_logout_redirect_uri` 回跳，否则停在确认页或直接拒绝。`OidcClientInitiatedLogoutSuccessHandler` 会自动处理这些参数。

### 3、角色映射

**Keycloak 默认只把 `realm_access.roles` 放进 access_token**，ID Token 和 UserInfo 中没有。所以在 `oauth2Login` 应用里读角色有两个前提选项：

- 在 Keycloak 的 Client Scopes → `roles` → Mappers → `realm roles` 中打开「Add to ID token」（或「Add to userinfo」）
- 或者不在登录端取角色，而是让后端资源服务器从 access_token 读取（见第五节第 2 小节），这也是微服务架构中更常见的做法

打开 ID Token 映射后，用 `GrantedAuthoritiesMapper` 把角色加入权限集合（容器中存在该 Bean 时 `oauth2Login` 会自动使用）：

```java
@Bean
GrantedAuthoritiesMapper keycloakAuthoritiesMapper() {
    return authorities -> {
        Set<GrantedAuthority> mapped = new HashSet<>(authorities);
        for (GrantedAuthority authority : authorities) {
            if (authority instanceof OidcUserAuthority oidc) {
                Map<String, Object> realmAccess = oidc.getIdToken().getClaimAsMap("realm_access");
                if (realmAccess != null && realmAccess.get("roles") instanceof Collection<?> roles) {
                    roles.forEach(r -> mapped.add(new SimpleGrantedAuthority("ROLE_" + r)));
                }
            }
        }
        return mapped;
    };
}
```

```java
@GetMapping("/me")
public Map<String, Object> me(@AuthenticationPrincipal OidcUser user) {
    return Map.of(
        "sub",   user.getSubject(),                        // 用户唯一 ID，关联本地账号用它而不是用户名
        "name",  Objects.requireNonNullElse(user.getFullName(), ""),
        "email", Objects.requireNonNullElse(user.getEmail(), ""),
        "roles", user.getAuthorities().stream().map(GrantedAuthority::getAuthority).toList()
    );
}
```

### 4、单点登出要点

Front-Channel / Back-Channel 原理对比见 [OIDC](/security/3_oidc)，SLO 方案选型见 [单点登录](/security/4_sso)。

| 方向 | 触发方 | Spring 配置 | Keycloak 配置 |
|------|--------|-------------|---------------|
| 应用 → Keycloak | 用户在本应用点注销 | `OidcClientInitiatedLogoutSuccessHandler` | 客户端「Valid post logout redirect URIs」 |
| Keycloak → 应用 | 用户在其他应用或 Keycloak 注销 | `.oidcLogout(l -> l.backChannel(...))` | 客户端「Backchannel logout URL」填 `{baseUrl}/logout/connect/back-channel/{registrationId}` |

- Back-Channel 是服务器对服务器的 POST，Keycloak 必须能直接访问应用地址（内网地址或网关地址）
- Spring 默认把「OIDC Provider 会话 ↔ 应用会话」的对应关系保存在内存里，多实例部署时要提供共享的 `OidcSessionRegistry` 实现，否则登出通知落到 A 实例时，B 实例上的会话不会失效

---

## 七、Spring Authorization Server 实战

### 1、版本变化

Spring Authorization Server（SAS）是 Spring 官方的 OAuth 2.1 / OIDC 1.0 授权服务器实现。**自 Spring Security 7.0 起，SAS 并入 Spring Security 主项目**，1.5.x 是最后一个独立发布的版本线：

- Maven 坐标仍是 `org.springframework.security:spring-security-oauth2-authorization-server`，版本改为跟随 Spring Security（7.x）
- Boot 4 starter：`spring-boot-starter-security-oauth2-authorization-server`
- DSL 入口变成 `HttpSecurity#oauth2AuthorizationServer(...)`，不再需要 `OAuth2AuthorizationServerConfigurer` 加 `http.with(...)` 的写法

自建还是用 Keycloak：需要深度定制登录流程、Token 内容、与自有用户体系紧耦合时自建；只想要开箱即用的用户管理、社交登录、管理后台时用 Keycloak。

### 2、最小可用配置

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-oauth2-authorization-server</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jdbc</artifactId>   <!-- 客户端与授权记录持久化 -->
</dependency>
```

授权服务器需要**两条过滤器链**：第一条只匹配协议端点（`/oauth2/authorize`、`/oauth2/token`、`/.well-known/*` 等），第二条负责用户登录。

```java
@Configuration
@EnableWebSecurity
public class AuthorizationServerConfig {

    @Bean
    @Order(1)
    SecurityFilterChain authorizationServerFilterChain(HttpSecurity http) throws Exception {
        http
            .oauth2AuthorizationServer(as -> {
                http.securityMatcher(as.getEndpointsMatcher());   // 只接管协议端点
                as.oidc(Customizer.withDefaults());               // 开启 OIDC：UserInfo、Discovery、RP-Initiated Logout
            })
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            // 浏览器访问授权端点未登录时，跳转到登录页
            .exceptionHandling(e -> e.defaultAuthenticationEntryPointFor(
                new LoginUrlAuthenticationEntryPoint("/login"),
                new MediaTypeRequestMatcher(MediaType.TEXT_HTML)));
        return http.build();
    }

    @Bean
    @Order(2)
    SecurityFilterChain loginFilterChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())   // 生产环境换成自定义登录页，用户来自 UserDetailsService
            .build();
    }

    @Bean
    AuthorizationServerSettings authorizationServerSettings() {
        return AuthorizationServerSettings.builder()
            .issuer("https://auth.example.com")    // 固定 issuer，集群与反向代理后必须显式设置
            .build();
    }
}
```

### 3、客户端与授权记录持久化

默认的内存实现重启即丢失，生产环境用 JDBC 实现。建表脚本在 jar 包内 `org/springframework/security/oauth2/server/authorization/` 目录下（`oauth2-registered-client-schema.sql`、`oauth2-authorization-schema.sql`、`oauth2-authorization-consent-schema.sql`），用 Flyway 纳入版本管理。

```java
@Configuration
public class AuthorizationStoreConfig {

    @Bean
    RegisteredClientRepository registeredClientRepository(JdbcTemplate jdbcTemplate) {
        return new JdbcRegisteredClientRepository(jdbcTemplate);
    }

    @Bean
    OAuth2AuthorizationService authorizationService(JdbcTemplate jdbcTemplate,
                                                    RegisteredClientRepository clients) {
        return new JdbcOAuth2AuthorizationService(jdbcTemplate, clients);
    }

    @Bean
    OAuth2AuthorizationConsentService authorizationConsentService(JdbcTemplate jdbcTemplate,
                                                                  RegisteredClientRepository clients) {
        return new JdbcOAuth2AuthorizationConsentService(jdbcTemplate, clients);
    }
}
```

### 4、注册客户端：授权码 + PKCE 与客户端凭证

```java
@Component
@RequiredArgsConstructor
public class ClientInitializer implements ApplicationRunner {

    private final RegisteredClientRepository clients;
    private final PasswordEncoder passwordEncoder;

    @Override
    public void run(ApplicationArguments args) {
        // 1. 前端 SPA / App：公共客户端，没有 secret，必须用 PKCE
        if (clients.findByClientId("order-spa") == null) {
            clients.save(RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("order-spa")
                .clientAuthenticationMethod(ClientAuthenticationMethod.NONE)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUri("https://order.example.com/callback")
                .postLogoutRedirectUri("https://order.example.com/")
                .scope(OidcScopes.OPENID)
                .scope(OidcScopes.PROFILE)
                .clientSettings(ClientSettings.builder().requireProofKey(true).build())
                .tokenSettings(TokenSettings.builder()
                    .accessTokenTimeToLive(Duration.ofMinutes(15))
                    .reuseRefreshTokens(false)             // Refresh Token 轮换
                    .build())
                .build());
        }
        // 2. 服务间调用：机密客户端，客户端凭证模式，没有用户参与
        if (clients.findByClientId("report-job") == null) {
            clients.save(RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("report-job")
                .clientSecret(passwordEncoder.encode(System.getenv("REPORT_JOB_SECRET")))
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
                .scope("order.read")
                .build());
        }
    }
}
```

简单场景也可以只用配置：`spring.security.oauth2.authorizationserver.client.<id>.registration.*`，由 Boot 自动生成内存版 `RegisteredClientRepository`。

### 5、签名密钥与 Token 定制

```java
@Bean
JWKSource<SecurityContext> jwkSource(KeyStoreKeyProvider keyProvider) {
    // 从密钥库 / KMS 加载固定 RSA 密钥，不要每次启动随机生成：
    // 随机密钥会导致重启后旧 Token 全部验签失败，多实例之间签名也不一致
    RSAKey current = keyProvider.currentRsaKey();
    RSAKey previous = keyProvider.previousRsaKey();   // 轮换期间同时发布新旧公钥
    return new ImmutableJWKSet<>(new JWKSet(List.of(current, previous)));
}

// 把用户角色写入 access_token，资源服务器即可直接鉴权
@Bean
OAuth2TokenCustomizer<JwtEncodingContext> tokenCustomizer() {
    return context -> {
        if (OAuth2TokenType.ACCESS_TOKEN.equals(context.getTokenType())
                && context.getPrincipal().getAuthorities() != null) {
            Set<String> roles = context.getPrincipal().getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(a -> a.startsWith("ROLE_"))
                .collect(Collectors.toSet());
            context.getClaims().claim("roles", roles);
        }
    };
}
```

`KeyStoreKeyProvider` 是示意的自定义组件，负责从 PKCS12 密钥库或 KMS 读出 `RSAKey`。

### 6、生产要点

- issuer 固定且与对外域名一致，资源服务器用同一个 `issuer-uri` 校验
- 授权记录表（`oauth2_authorization`）会持续增长，需要定时清理过期记录
- 登录页、同意页自定义，叠加 MFA、验证码、登录失败锁定（见 [API 安全](/security/6_api_security)）
- 密钥定期轮换：先发布新公钥，再切换签名私钥，旧公钥保留到旧 Token 全部过期

---

## 八、Sa-Token SSO 接入

Sa-Token 框架本身的用法见 [安全框架对比](./10_auth_framework)。`sa-token-sso` 提供三种模式：

| 模式 | 场景 | ticket 校验方式 |
|------|------|----------------|
| 模式一 | 同一顶级域名（共享 Cookie） | 不需要 ticket，共享 Redis 会话 |
| 模式二 | 跨域，各系统可连同一个 Redis | Client 直接读 Redis 校验 ticket |
| 模式三 | 跨域，且 Client 不能连认证中心的 Redis | Client 通过 HTTP 调认证中心校验 ticket（`is-http: true`） |

### 1、依赖

```xml
<!-- 版本由 sa-token-bom 统一管理，见「安全框架对比」 -->
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-spring-boot4-starter</artifactId>
</dependency>
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-sso</artifactId>
</dependency>
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-redis-template</artifactId>
</dependency>
<dependency>
    <groupId>org.apache.commons</groupId>
    <artifactId>commons-pool2</artifactId>
</dependency>
```

### 2、认证中心（SSO Server）

认证中心 `application.yml`：

```yaml
sa-token:
  sso-server:
    ticket-timeout: 300                  # ticket 有效期（秒）
    clients:
      order-web:                         # 逐个登记接入的子系统
        client: order-web
        allow-url: https://order.example.com/sso/login   # 回调白名单，生产环境禁止写 *
        secret-key: ${SSO_ORDER_WEB_SECRET}               # 参数签名密钥，与子系统一致
```

```java
@RestController
@RequiredArgsConstructor
public class SsoServerController {

    private final UserService userService;
    private final PasswordEncoder passwordEncoder;

    // 统一处理 /sso/auth（授权）、/sso/doLogin（登录）、/sso/signout（单点注销）等端点
    @RequestMapping("/sso/*")
    public Object ssoRequest() {
        return SaSsoServerProcessor.instance.dister();
    }

    @Autowired
    private void configSso(SaSsoServerTemplate ssoServerTemplate) {
        // 未登录时返回登录页（前后端分离时返回 JSON，由前端跳转）
        ssoServerTemplate.strategy.notLoginView = () -> new ModelAndView("sso-login");
        // 账号密码校验
        ssoServerTemplate.strategy.doLoginHandle = (name, pwd) -> {
            User user = userService.findByUsername(name);
            if (user == null || !passwordEncoder.matches(pwd, user.getPasswordHash())) {
                return SaResult.error("用户名或密码错误");
            }
            StpUtil.login(user.getId());
            return SaResult.ok().setData(StpUtil.getTokenValue());
        };
    }
}
```

### 3、业务子系统（SSO Client）

子系统 `application.yml`：

```yaml
sa-token:
  sso-client:
    client: order-web
    server-url: https://sso.example.com   # 认证中心地址
    secret-key: ${SSO_ORDER_WEB_SECRET}
    # is-http: true                       # 模式三：不连认证中心的 Redis，改为 HTTP 校验 ticket
```

```java
@RestController
public class SsoClientController {

    // 统一处理 /sso/login（跳转认证中心 / ticket 换登录态）、/sso/logout（单点注销）、/sso/pushC（接收推送）
    @RequestMapping("/sso/*")
    public Object ssoRequest() {
        return SaSsoClientProcessor.instance.dister();
    }
}
```

两个 yml 分别属于两个独立应用，不能合并到同一个文件中（同一 YAML 文件里出现两次顶层 `sa-token:` 键是非法的）。

---

## 小结

- Boot 4 的 OAuth2 starter 改名为 `spring-boot-starter-security-oauth2-*`；SAML2 用 `spring-boot-starter-security-saml2`，OpenSAML 需加 Shibboleth 仓库
- LDAP 需要 `spring-security-ldap` + `spring.ldap.*` 配置；CAS 优先用 `spring-security-cas`，Apereo starter 需显式版本和 `@EnableCasClient`
- OIDC Client 只需 `issuer-uri` 自动发现端点；资源服务器校验 `iss` 与 `aud`，Keycloak 角色从 access_token 的 `realm_access.roles` 读取
- Keycloak 默认不把角色放进 ID Token，登录端读角色要先开 mapper，或交给资源服务器处理
- 注销用 `OidcClientInitiatedLogoutSuccessHandler`（自动带 `id_token_hint`），接收登出用 `oidcLogout().backChannel()`，多实例需共享 `OidcSessionRegistry`
- Spring Authorization Server 已并入 Spring Security 7，DSL 为 `oauth2AuthorizationServer(...)`；生产环境用 JDBC 存储、固定 issuer、固定并轮换签名密钥
- Sa-Token SSO 按「同域 / 跨域同 Redis / 跨域 HTTP 校验」选模式，`allow-url` 必须是白名单

## 参考资料

- Spring Security OAuth2 Login：[https://docs.spring.io/spring-security/reference/servlet/oauth2/login/index.html](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/index.html)
- Spring Security OIDC Logout：[https://docs.spring.io/spring-security/reference/servlet/oauth2/login/logout.html](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/logout.html)
- Spring Authorization Server：[https://docs.spring.io/spring-security/reference/servlet/oauth2/authorization-server/index.html](https://docs.spring.io/spring-security/reference/servlet/oauth2/authorization-server/index.html)
- Spring Security LDAP：[https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html)
- Spring Security SAML2：[https://docs.spring.io/spring-security/reference/servlet/saml2/index.html](https://docs.spring.io/spring-security/reference/servlet/saml2/index.html)
- Keycloak 文档：[https://www.keycloak.org/documentation](https://www.keycloak.org/documentation)
- Sa-Token SSO：[https://sa-token.com/doc.html](https://sa-token.com/doc.html)

> 下一篇：[Spring Batch 批处理](./12_batch) —— 分块读写、重启语义与分区扩展，用 Spring Batch 6 写可靠的批处理作业。

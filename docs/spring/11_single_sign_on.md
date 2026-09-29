# SSO 单点登录

> 参考资料：
> * Spring Security LDAP：[https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html)
> * CAS 官网：[https://apereo.github.io/cas/](https://apereo.github.io/cas/)
> * OAuth2 RFC：[https://datatracker.ietf.org/doc/html/rfc6749](https://datatracker.ietf.org/doc/html/rfc6749)

> 本文只保留 Spring 生态下的 SSO 接入配置。SSO 原理（三方票据模型、方案对比与选型、CAS 票据、单点登出、IAM 平台）见 → [单点登录](/security/4_sso)　OIDC 协议见 → [OIDC](/security/3_oidc)　OAuth2 协议见 → [OAuth2](/security/2_oauth2)　JWT 令牌详见 → [JWT](/security/1_jwt)

## 一、LDAP

LDAP 只是统一账号库，不是 SSO 票据方案（定位说明见 → [单点登录 · LDAP 的定位](/security/4_sso)）。

```java
// Spring Security 对接 LDAP
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
               .formLogin(Customizer.withDefaults())
               .build();
}

@Bean
AuthenticationManager ldapAuthManager(BaseLdapPathContextSource contextSource) {
    LdapBindAuthenticationManagerFactory factory =
        new LdapBindAuthenticationManagerFactory(contextSource);
    factory.setUserDnPatterns("uid={0},ou=people");
    return factory.createAuthenticationManager();
}
```

> 官方文档：[Spring LDAP Authentication](https://docs.spring.io/spring-security/reference/servlet/authentication/passwords/ldap.html#servlet-authentication-ldap-embedded)

## 二、CAS

CAS 票据流程（TGC / ST）见 → [单点登录 · CAS 协议](/security/4_sso)。

```xml
<!-- 子系统接入：cas-client 过滤器（或 Spring Security CAS 模块） -->
<dependency>
  <groupId>org.apereo.cas.client</groupId>
  <artifactId>cas-client-support-springboot</artifactId>
</dependency>
```

```yaml
cas:
  server-url-prefix: https://cas.example.com
  client-host-url: https://app-a.example.com
  validation-type: CAS3
```

> 服务端模板：[cas-overlay-template](https://github.com/apereo/cas-overlay-template)

## 三、SAML2

SAML2 角色与 metadata 信任机制见 → [单点登录 · SAML 2.0](/security/4_sso)。

```yaml
# Spring Security 作为 SP 对接企业 IdP
spring:
  security:
    saml2:
      relyingparty:
        registration:
          okta:
            assertingparty:
              metadata-uri: https://xxx.okta.com/app/xxx/sso/saml/metadata
```

> 官方文档：[Spring Security SAML2](https://docs.spring.io/spring-security/reference/servlet/saml2/index.html)

## 四、OAuth2 / OIDC

授权码 + PKCE 流程见 → [OIDC](/security/3_oidc)。

```yaml
# Spring Security 作为 OIDC Client：几行配置完成对接
spring:
  security:
    oauth2:
      client:
        registration:
          sso:
            client-id: order-web
            client-secret: xxx
            scope: openid,profile
            authorization-grant-type: authorization_code
        provider:
          sso:
            issuer-uri: https://auth.example.com   # 自动发现所有端点
```

```yaml
# 资源服务器侧：微服务只需校验 JWT
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com
```

认证中心自建选 **Spring Authorization Server**（官方 OAuth2/OIDC 服务端），或直接用 Keycloak。

## 五、Keycloak 实战（Spring Boot）

Keycloak / MaxKey 就是标准的 OIDC Provider，对接方式与第四节完全一致，只需把 `issuer-uri` 指过去。

### 依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-oauth2-client</artifactId>
</dependency>
```

### 配置

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
            redirect-uri: "{baseUrl}/login/oauth2/code/keycloak"
        provider:
          keycloak:
            issuer-uri: http://keycloak:8080/realms/my-realm
```

### SecurityFilterChain

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/public/**").permitAll()
            .anyRequest().authenticated())
        .oauth2Login(login -> login
            .userInfoEndpoint(ui -> ui
                .oidcUserService(oidcUserService())))  // 自定义用户信息加载
        .oidcLogout(logout -> logout
            .backChannel(Customizer.withDefaults()))
        .build();
}
```

### 从 id_token 提取用户信息

```java
@GetMapping("/me")
public Map<String, Object> me(@AuthenticationPrincipal OidcUser user) {
    return Map.of(
        "sub",   user.getSubject(),          // 用户唯一 ID
        "name",  user.getFullName(),
        "email", user.getEmail(),
        "roles", user.getClaimAsStringList("roles")  // Keycloak 自定义 claim
    );
}
```

### 自定义 Keycloak 角色映射

Keycloak 将角色放在 `realm_access.roles` 而非标准字段，需要自定义 `OidcUserService`：

```java
@Bean
public OidcUserService oidcUserService() {
    OidcUserService delegate = new OidcUserService();
    return new OidcUserService() {
        @Override
        public OidcUser loadUser(OidcUserRequest request) throws OAuth2AuthenticationException {
            OidcUser oidcUser = delegate.loadUser(request);

            // 从 realm_access.roles 提取角色
            Map<String, Object> realmAccess =
                oidcUser.getClaimAsMap("realm_access");
            List<String> roles = realmAccess != null
                ? (List<String>) realmAccess.get("roles")
                : List.of();

            List<GrantedAuthority> authorities = roles.stream()
                .map(r -> new SimpleGrantedAuthority("ROLE_" + r.toUpperCase()))
                .collect(Collectors.toList());
            authorities.addAll(oidcUser.getAuthorities());

            return new DefaultOidcUser(authorities, oidcUser.getIdToken(),
                oidcUser.getUserInfo());
        }
    };
}
```

## 六、单点登出配置

Front-Channel / Back-Channel 原理对比见 → [OIDC](/security/3_oidc)；SLO 方案选型见 → [单点登录](/security/4_sso)。

### Back-Channel Logout

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: my-app
            client-secret: ${KEYCLOAK_SECRET}
            scope: openid, profile, email
```

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .oauth2Login(Customizer.withDefaults())
        .oidcLogout(logout -> logout
            .backChannel(Customizer.withDefaults())  // 开启 Back-Channel Logout
        )
        .build();
}
```

Keycloak 会在用户注销时向 `{baseUrl}/logout/connect/back-channel/{registrationId}` 发送 POST 请求，Spring Security 自动处理 Session 销毁。

### 注销后跳转到 Keycloak 登出端点

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/public/**").permitAll()
            .anyRequest().authenticated())
        .oauth2Login(Customizer.withDefaults())          // 触发 OIDC SSO 流程
        .logout(logout -> logout
            .logoutSuccessUrl(                           // 注销后跳转到 Keycloak 单点注销
                "http://keycloak:8080/realms/my-realm/protocol/openid-connect/logout"
                + "?post_logout_redirect_uri=http://myapp.com"))
        .build();
}
```

## 七、相关文档

- [单点登录](/security/4_sso)：SSO 原理、方案对比、单点登出、IAM 平台
- [认证授权框架横向对比（Spring Security / Shiro / Sa-Token）](./10_auth_framework)：含 Sa-Token SSO
- [OAuth2](/security/2_oauth2) / [OIDC](/security/3_oidc) / [JWT](/security/1_jwt)：协议细节
- [分布式会话](/distributed/4_session)：同域会话共享方案

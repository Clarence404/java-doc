---
description: 过滤器链、Resource Server 校验 JWT、自定义 JWT 过滤器、方法级权限、动态权限
---

# Spring Security

> **本篇目标**：理解 Spring Security 7 的过滤器链与授权架构，能为前后端分离的 API 写出无状态的安全配置：用 OAuth2 Resource Server 签发与校验 JWT、用 `@PreAuthorize` 做方法级权限、用 `AuthorizationManager` 实现数据库驱动的动态 URL 权限。
>
> **前置阅读**：[MVC](./3_mvc)、[JWT 令牌机制](/security/1_jwt)

> 参考资料：
> * Spring Security Reference：[https://docs.spring.io/spring-security/reference/](https://docs.spring.io/spring-security/reference/)
> * Servlet Architecture：[https://docs.spring.io/spring-security/reference/servlet/architecture.html](https://docs.spring.io/spring-security/reference/servlet/architecture.html)
> * OAuth 2.0 Resource Server JWT：[https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html](https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html)
> * Authorization Architecture：[https://docs.spring.io/spring-security/reference/servlet/authorization/architecture.html](https://docs.spring.io/spring-security/reference/servlet/authorization/architecture.html)
> * Spring Boot Security：[https://docs.spring.io/spring-boot/reference/web/spring-security.html](https://docs.spring.io/spring-boot/reference/web/spring-security.html)

本篇只讲 Spring Security 的配置与代码，版本基线为 Spring Security 7（Spring Boot 4）。JWT 结构、签名算法、续期与吊销见 [JWT 令牌机制](/security/1_jwt)；OAuth2 / OIDC 协议见 [OAuth2](/security/2_oauth2)、[OIDC](/security/3_oidc)；权限模型见 [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)。

---

## 一、核心架构

### 1、过滤器链

Spring Security 在 Servlet 应用中本质是一组 **Servlet Filter**。容器只认识一个 `DelegatingFilterProxy`，它把请求转交给 Spring 容器中的 `FilterChainProxy`，后者按请求选出第一条匹配的 `SecurityFilterChain`，依次执行链上的安全过滤器：

![Spring Security 7 Servlet 过滤器链](../assets/spring/spring_security_filter_chain.svg)

| 过滤器 | 职责 |
|--------|------|
| `SecurityContextHolderFilter` | 从 `SecurityContextRepository` 加载 `SecurityContext` 放入 `SecurityContextHolder`；无状态 API 每次都是空的 |
| `CsrfFilter` | 校验 CSRF Token，无状态 Bearer Token API 可关闭 |
| 认证过滤器 | `BearerTokenAuthenticationFilter`（Resource Server）、`UsernamePasswordAuthenticationFilter`（表单登录）或自定义过滤器，认证成功后把 `Authentication` 写入上下文 |
| `AnonymousAuthenticationFilter` | 上下文仍为空时填充匿名身份 |
| `ExceptionTranslationFilter` | 捕获后续抛出的认证 / 授权异常：未认证 → `AuthenticationEntryPoint`（401），已认证但无权限 → `AccessDeniedHandler`（403） |
| `AuthorizationFilter` | 最后一道关：把请求交给 `AuthorizationManager` 判定是否放行 |

> Security 6 起 URL 授权由 `authorizeHttpRequests` + `AuthorizationFilter` + `AuthorizationManager` 完成。旧的 `FilterSecurityInterceptor`、`AccessDecisionManager`、`FilterInvocationSecurityMetadataSource` 属于废弃的 Access API，Security 7 已将其移到单独的 `spring-security-access` 遗留模块，新代码不要再用。

排查时可以开启 `logging.level.org.springframework.security=TRACE`，启动日志会打印每条链上的过滤器列表，请求日志会打印每个过滤器的执行情况。

### 2、多条 SecurityFilterChain

一个应用可以声明多条链，用 `securityMatcher` 限定范围、`@Order` 决定匹配顺序，**第一条匹配的链生效**，其他链不再执行：

```java
@Bean
@Order(1)
SecurityFilterChain actuatorChain(HttpSecurity http) throws Exception {
    return http
        .securityMatcher("/actuator/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/actuator/health/**").permitAll()
            .anyRequest().hasRole("OPS"))
        .httpBasic(Customizer.withDefaults())
        .build();
}
// 不写 securityMatcher 的链匹配所有请求，放在最后（如下文的 apiChain）
```

### 3、认证信息存在哪里

| 组件 | 职责 |
|------|------|
| `SecurityContextHolder` | 持有当前线程的 `SecurityContext`，默认 `ThreadLocal` 策略 |
| `Authentication` | 当前用户：`principal`（身份）、`credentials`（凭证）、`authorities`（权限） |
| `AuthenticationManager` / `ProviderManager` | 认证入口，委托给一组 `AuthenticationProvider` |
| `DaoAuthenticationProvider` | 用 `UserDetailsService` 加载用户、用 `PasswordEncoder` 校验密码 |
| `JwtAuthenticationProvider` | Resource Server 中用 `JwtDecoder` 校验 Token，再由 `JwtAuthenticationConverter` 转成 `Authentication` |
| `AuthorizationManager` | 授权决策接口，URL 授权与方法授权都基于它 |

因为默认是 `ThreadLocal`，切换线程后上下文就没了：`@Async`、自建线程池、虚拟线程中需要用 `DelegatingSecurityContextExecutor` / `DelegatingSecurityContextAsyncTaskExecutor` 包装执行器，或用 `TaskDecorator` 传递。

---

## 二、SecurityFilterChain 配置

前后端分离、Bearer Token 认证的 API 典型配置：

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity          // 开启 @PreAuthorize / @PostAuthorize
public class SecurityConfig {

    private static final String UNAUTHORIZED = "{\"code\":401,\"message\":\"请先登录\"}";
    private static final String FORBIDDEN = "{\"code\":403,\"message\":\"权限不足\"}";

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http,
                                 JwtAuthenticationConverter jwtAuthenticationConverter,
                                 DynamicAuthorizationManager dynamicAuthorizationManager) throws Exception {
        AuthenticationEntryPoint entryPoint = (req, res, ex) -> writeJson(res, 401, UNAUTHORIZED);
        AccessDeniedHandler deniedHandler = (req, res, ex) -> writeJson(res, 403, FORBIDDEN);

        return http
            // 无状态 API：Token 放在 Authorization 头，浏览器不会自动携带，CSRF 防护可关闭
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .formLogin(AbstractHttpConfigurer::disable)
            .httpBasic(AbstractHttpConfigurer::disable)
            .cors(Customizer.withDefaults())                 // 使用容器中的 CorsConfigurationSource

            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/login").permitAll()
                .requestMatchers("/swagger-ui/**", "/v3/api-docs/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().access(dynamicAuthorizationManager)     // 其余走动态权限，见第六节
            )

            // 校验 Bearer JWT（第四节）
            .oauth2ResourceServer(o -> o
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter))
                .authenticationEntryPoint(entryPoint))       // Token 无效、过期时的响应

            .exceptionHandling(e -> e
                .authenticationEntryPoint(entryPoint)        // 未携带 Token
                .accessDeniedHandler(deniedHandler))
            .build();
    }

    @Bean
    AuthenticationManager authenticationManager(AuthenticationConfiguration config) throws Exception {
        return config.getAuthenticationManager();            // 登录接口需要手动调用认证
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        // 存储格式 {bcrypt}$2a$...，以后换算法（如 argon2）无需迁移旧密码
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }

    private static void writeJson(HttpServletResponse res, int status, String body) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.setCharacterEncoding(StandardCharsets.UTF_8.name());
        res.getWriter().write(body);
    }
}
```

- `requestMatchers` 按声明顺序匹配，**先具体后宽泛**，`anyRequest()` 必须放最后
- `hasRole("ADMIN")` 实际检查的是 `ROLE_ADMIN` 权限；`hasAuthority("order:delete")` 原样比对
- 已有的旧密码哈希没有 `{bcrypt}` 前缀时，`DelegatingPasswordEncoder` 会匹配失败，可用 `setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder())` 兼容
- CORS 的 `CorsConfigurationSource` 配置见 [Web 开发](/spring-boot/2_web_dev)

---

## 三、用户加载：UserDetailsService

登录时 `DaoAuthenticationProvider` 调用 `UserDetailsService` 加载用户。返回**自定义的 `UserDetails`**，把 userId 等业务字段带出来，后面签发 Token 时直接使用：

```java
// 认证主体：不要用 Lombok @Data / record 默认 toString，避免密码进日志
public record LoginUser(Long id, String username, String password, boolean enabled,
                        List<GrantedAuthority> authorities) implements UserDetails {

    @Override public String getUsername() { return username; }
    @Override public String getPassword() { return password; }
    @Override public Collection<? extends GrantedAuthority> getAuthorities() { return authorities; }
    @Override public boolean isEnabled() { return enabled; }
    @Override public boolean isAccountNonExpired() { return true; }
    @Override public boolean isAccountNonLocked() { return true; }
    @Override public boolean isCredentialsNonExpired() { return true; }

    @Override
    public String toString() {
        return "LoginUser[id=" + id + ", username=" + username + "]";
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {

    private final SysUserMapper userMapper;
    private final PermissionMapper permissionMapper;

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        SysUser user = userMapper.findByUsername(username);
        if (user == null) {
            throw new UsernameNotFoundException("用户不存在: " + username);
        }
        // 角色加 ROLE_ 前缀，权限码原样：ROLE_ADMIN、order:delete
        List<GrantedAuthority> authorities = new ArrayList<>();
        permissionMapper.findRoleCodesByUserId(user.getId())
            .forEach(r -> authorities.add(new SimpleGrantedAuthority("ROLE_" + r)));
        permissionMapper.findPermCodesByUserId(user.getId())
            .forEach(p -> authorities.add(new SimpleGrantedAuthority(p)));

        return new LoginUser(user.getId(), user.getUsername(), user.getPassword(),
                             user.isEnabled(), List.copyOf(authorities));
    }
}
```

用户、角色、权限的表设计见 [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)。

---

## 四、JWT 认证：OAuth2 Resource Server（推荐）

Spring Security 自带 JWT 校验能力：**OAuth2 Resource Server**。它负责从 `Authorization: Bearer` 头取 Token、验签、校验 `exp` / `nbf` / `iss`、把 claims 转成权限，不需要自己写过滤器和解析代码。

### 1、依赖

```xml
<!-- Boot 4；Boot 3 为 spring-boot-starter-oauth2-resource-server（Boot 4 中仍可用但已废弃） -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-oauth2-resource-server</artifactId>
</dependency>
```

它会引入 `spring-security-oauth2-jose`（基于 Nimbus），同时提供 `JwtDecoder`（校验）与 `JwtEncoder`（签发）。

### 2、两种部署方式

| 方式 | Token 由谁签发 | 配置 |
|------|-------------|------|
| 对接授权服务器 | Keycloak、Spring Authorization Server、云厂商 IdP | 只需 `spring.security.oauth2.resourceserver.jwt.issuer-uri`，自动发现 JWK Set 并校验 `iss` |
| 应用自签发 | 本应用的登录接口 | 自行声明 `JwtEncoder` / `JwtDecoder`，见下文 |

对接授权服务器是更规范的做法：多个服务共用一个签发方，公钥通过 JWK Set 分发，密钥轮换不影响资源服务。Spring Authorization Server 在 Security 7 中已并入 Spring Security 项目，接入方式见 [Spring SSO 接入](./11_single_sign_on)。

### 3、应用自签发：RSA 密钥对

```yaml
app:
  jwt:
    issuer: https://api.example.com
    ttl: 30m
    public-key: classpath:keys/public.pem     # 生产从密钥管理服务或挂载文件读取
    private-key: classpath:keys/private.pem   # PKCS#8 格式（BEGIN PRIVATE KEY）
```

```java
@Configuration
public class JwtConfig {

    // @EnableWebSecurity 注册了 RSA 密钥转换器，@Value 可以直接把 PEM 资源转成密钥对象
    @Bean
    JwtDecoder jwtDecoder(@Value("${app.jwt.public-key}") RSAPublicKey publicKey,
                          @Value("${app.jwt.issuer}") String issuer) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(publicKey).build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer));   // exp、nbf + iss
        return decoder;
    }

    @Bean
    JwtEncoder jwtEncoder(@Value("${app.jwt.public-key}") RSAPublicKey publicKey,
                          @Value("${app.jwt.private-key}") RSAPrivateKey privateKey) {
        RSAKey jwk = new RSAKey.Builder(publicKey).privateKey(privateKey).keyID("app-key-1").build();
        return new NimbusJwtEncoder(new ImmutableJWKSet<>(new JWKSet(jwk)));
    }

    // claims 中的 authorities 数组 → GrantedAuthority（默认读 scope/scp 并加 SCOPE_ 前缀）
    @Bean
    JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtGrantedAuthoritiesConverter authorities = new JwtGrantedAuthoritiesConverter();
        authorities.setAuthoritiesClaimName("authorities");
        authorities.setAuthorityPrefix("");       // 值本身已是 ROLE_ADMIN / order:delete
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(authorities);
        return converter;                          // principal 名默认取 sub，即 userId
    }
}
```

- 优先用 RS256 / ES256 非对称签名：只有签发方持有私钥，其他服务拿公钥即可验签。只有单体应用自签自验时才考虑 HS256（`NimbusJwtDecoder.withSecretKey(...)`），密钥至少 256 位
- 权限映射也可以只用配置完成：`spring.security.oauth2.resourceserver.jwt.authorities-claim-name` 与 `authority-prefix`
- 密钥轮换（`kid`）、多服务公钥分发、Token 黑名单见 [JWT 令牌机制](/security/1_jwt)

### 4、登录接口签发 Token

```java
@Service
@RequiredArgsConstructor
public class TokenService {

    private final JwtEncoder jwtEncoder;

    @Value("${app.jwt.issuer}")
    private String issuer;

    @Value("${app.jwt.ttl}")
    private Duration ttl;

    public String issue(LoginUser user) {
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
            .issuer(issuer)
            .subject(String.valueOf(user.id()))
            .issuedAt(now)
            .expiresAt(now.plus(ttl))
            .claim("username", user.getUsername())
            .claim("authorities", user.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority).toList())
            .build();
        // 未指定 JwsHeader 时默认 RS256
        return jwtEncoder.encode(JwtEncoderParameters.from(claims)).getTokenValue();
    }
}

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthenticationManager authenticationManager;
    private final TokenService tokenService;

    @PostMapping("/login")
    public TokenVO login(@RequestBody @Valid LoginDTO dto) {
        // 密码错误抛 BadCredentialsException，用户禁用抛 DisabledException，交给全局异常处理返回 401
        Authentication auth = authenticationManager.authenticate(
            UsernamePasswordAuthenticationToken.unauthenticated(dto.username(), dto.password()));
        LoginUser user = (LoginUser) auth.getPrincipal();     // 第三节返回的就是 LoginUser
        return new TokenVO(tokenService.issue(user), "Bearer");
    }
}
```

后续请求携带 `Authorization: Bearer <token>`，`BearerTokenAuthenticationFilter` 校验通过后，`Authentication` 是 `JwtAuthenticationToken`：`getName()` 为 userId（`sub`），`getPrincipal()` 为 `Jwt`，权限来自 Token 中的 `authorities`。**整个过程不查数据库**，这才是无状态 JWT 的意义；代价是权限变更要等 Token 过期才生效，所以访问 Token 有效期要短，配合刷新 Token 使用。

---

## 五、自定义 JWT 过滤器（JJWT 方案）

存量项目常见「JJWT + 自定义 `OncePerRequestFilter`」的写法。能用 Resource Server 时优先用它；需要保留这种写法时，注意以下几点：

- Token 只解析一次，权限直接取自 claims，**不要每个请求都 `loadUserByUsername` 查库**
- `parseSignedClaims` 已经校验了过期时间，过期抛 `ExpiredJwtException`，不需要再写 `isExpired`
- **不要把过滤器声明成 `@Component`**：Boot 会把容器中的 `Filter` Bean 自动注册到 Servlet 容器，结果在安全链外和链内各执行一次。直接 `new` 后加入安全链；必须是 Bean 时，用 `FilterRegistrationBean.setEnabled(false)` 关掉自动注册

```java
// JJWT 0.12：签发与解析
@Component
public class JwtUtil {

    private final SecretKey key;
    private final Duration ttl;

    public JwtUtil(@Value("${app.jwt.secret}") String base64Secret,      // 至少 256 位
                   @Value("${app.jwt.ttl:30m}") Duration ttl) {
        this.key = Keys.hmacShaKeyFor(Decoders.BASE64.decode(base64Secret));
        this.ttl = ttl;
    }

    public String generate(LoginUser user) {
        Instant now = Instant.now();
        return Jwts.builder()
            .subject(String.valueOf(user.id()))
            .claim("username", user.getUsername())
            .claim("authorities", user.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority).toList())
            .issuedAt(Date.from(now))
            .expiration(Date.from(now.plus(ttl)))
            .signWith(key)
            .compact();
    }

    public Claims parse(String token) {          // 签名错误、过期、格式错误都会抛 JwtException
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
    }
}
```

```java
// 认证后的主体：实现 AuthenticatedPrincipal，authentication.getName() 返回 userId
public record JwtPrincipal(Long id, String username) implements AuthenticatedPrincipal {
    @Override
    public String getName() { return String.valueOf(id); }
}

public class JwtAuthFilter extends OncePerRequestFilter {     // 不加 @Component

    private static final Logger log = LoggerFactory.getLogger(JwtAuthFilter.class);

    private final JwtUtil jwtUtil;

    public JwtAuthFilter(JwtUtil jwtUtil) {
        this.jwtUtil = jwtUtil;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            chain.doFilter(request, response);
            return;
        }
        try {
            Claims claims = jwtUtil.parse(header.substring(7));          // 只解析一次
            List<?> raw = claims.get("authorities", List.class);
            List<GrantedAuthority> authorities = raw == null ? List.of()
                : raw.stream().map(String::valueOf).<GrantedAuthority>map(SimpleGrantedAuthority::new).toList();
            JwtPrincipal principal = new JwtPrincipal(
                Long.valueOf(claims.getSubject()), claims.get("username", String.class));

            UsernamePasswordAuthenticationToken authentication =
                UsernamePasswordAuthenticationToken.authenticated(principal, null, authorities);
            authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));

            SecurityContext context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(authentication);
            SecurityContextHolder.setContext(context);
        } catch (JwtException | IllegalArgumentException e) {
            // 不写入上下文：受保护资源会被 ExceptionTranslationFilter 转到 401
            log.debug("JWT 校验失败: {}", e.getMessage());
        }
        chain.doFilter(request, response);
    }
}
```

在第二节的配置中，把 `.oauth2ResourceServer(...)` 换成：

```java
.addFilterBefore(new JwtAuthFilter(jwtUtil), UsernamePasswordAuthenticationFilter.class)
```

登录接口与第四节相同，只是用 `jwtUtil.generate(user)` 签发。

---

## 六、方法级权限

### 1、@PreAuthorize / @PostAuthorize

`@EnableMethodSecurity` 开启后，以下注解基于 `AuthorizationManager` 实现（取代旧的 `@EnableGlobalMethodSecurity`）：

```java
@Service
public class OrderService {

    // 管理员，或者访问自己的数据（authentication.name 在两种 JWT 方案中都是 userId）
    @PreAuthorize("hasRole('ADMIN') or #userId.toString() == authentication.name")
    public List<OrderVO> listByUser(Long userId) { ... }

    @PreAuthorize("hasAuthority('order:delete')")
    public void deleteOrder(Long orderId) { ... }

    // 方法执行后校验返回值：只能看自己的订单
    @PostAuthorize("hasRole('ADMIN') or returnObject.userId().toString() == authentication.name")
    public OrderVO getById(Long id) { ... }

    // 复杂规则委托给 Bean：@beanName.method(...)
    @PreAuthorize("@orderPermission.canEdit(#orderId, authentication)")
    public void edit(Long orderId, OrderEditDTO dto) { ... }
}
```

- 方法级权限同样基于代理，**同类内部调用不生效**，见 [AOP · 自调用失效问题](./2_aop)
- `#userId` 按参数名引用，依赖 `-parameters` 编译参数（Boot 构建插件默认开启）
- `@PostAuthorize` 在方法**执行之后**判断，方法里的写操作已经发生，只适合只读方法
- 集合过滤可用 `@PreFilter` / `@PostFilter`，但它在内存中过滤，大数据量应在 SQL 层做数据权限，见 [权限系统架构设计](/architecture/6_access_control)

### 2、权限注解模板

权限码散落在大量 SpEL 字符串里不好维护，可以定义元注解（Security 6.4+ 支持模板参数）：

```java
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@PreAuthorize("hasAuthority('{value}')")
public @interface RequirePermission {
    String value();
}

@Configuration
class MethodSecurityConfig {
    @Bean
    static AnnotationTemplateExpressionDefaults templateExpressionDefaults() {
        return new AnnotationTemplateExpressionDefaults();       // 开启 {value} 占位符替换
    }
}

// 使用
@RequirePermission("order:delete")
public void deleteOrder(Long orderId) { ... }
```

---

## 七、动态权限：AuthorizationManager

URL 与权限码的对应关系存在数据库里（权限表带 `resource` / `method` 列），运行时按请求匹配，调整权限不用发版。Security 6/7 的做法是实现 `AuthorizationManager<RequestAuthorizationContext>`，通过 `.anyRequest().access(...)` 挂到 `AuthorizationFilter` 上（第二节配置已接入）。

```java
public record PermissionRule(String method, PathPattern pattern, String permission) {

    boolean matches(String requestMethod, PathContainer path) {
        return ("*".equals(method) || method.equalsIgnoreCase(requestMethod)) && pattern.matches(path);
    }
}

// 规则缓存：启动时加载，权限变更后刷新（多实例通过 MQ / Redis Pub/Sub 广播刷新）
@Component
@RequiredArgsConstructor
public class PermissionRuleCache {

    private final PermissionMapper permissionMapper;
    private volatile List<PermissionRule> rules = List.of();

    @EventListener(ApplicationReadyEvent.class)
    public void refresh() {
        this.rules = permissionMapper.selectUrlPermissions().stream()     // method, resource, perm_code
            .map(p -> new PermissionRule(p.method(),
                                         PathPatternParser.defaultInstance.parse(p.resource()),
                                         p.permCode()))
            .toList();
    }

    public List<PermissionRule> rules() {
        return rules;
    }
}

@Component
@RequiredArgsConstructor
public class DynamicAuthorizationManager implements AuthorizationManager<RequestAuthorizationContext> {

    private final PermissionRuleCache ruleCache;
    private final AuthenticationTrustResolver trustResolver = new AuthenticationTrustResolverImpl();

    @Override
    public AuthorizationResult authorize(Supplier<? extends Authentication> authentication,
                                         RequestAuthorizationContext context) {
        Authentication auth = authentication.get();
        if (!trustResolver.isAuthenticated(auth)) {          // null 或匿名
            return new AuthorizationDecision(false);
        }

        HttpServletRequest request = context.getRequest();
        PathContainer path = PathContainer.parsePath(
            request.getRequestURI().substring(request.getContextPath().length()));
        Set<String> required = ruleCache.rules().stream()
            .filter(r -> r.matches(request.getMethod(), path))
            .map(PermissionRule::permission)
            .collect(Collectors.toSet());

        if (required.isEmpty()) {
            return new AuthorizationDecision(true);          // 未配置规则：登录即可访问（也可改为默认拒绝）
        }
        boolean granted = auth.getAuthorities().stream()
            .map(GrantedAuthority::getAuthority)
            .anyMatch(required::contains);
        return new AuthorizationDecision(granted);
    }
}
```

- 规则在内存中匹配，**不要每个请求查数据库**；权限数据变更时刷新缓存
- 「未配置规则时放行还是拒绝」是安全策略选择：默认拒绝更安全，但每个新接口都要先配规则
- 用户拥有哪些权限码来自 Token（第四节），所以给用户调整角色后要等 Token 刷新才生效；需要即时生效时在这里改为按 userId 查缓存中的最新权限
- 权限缓存刷新与网关 / 服务的鉴权分工见 [权限系统架构设计](/architecture/6_access_control)

---

## 八、核心组件速查

| 组件 | 职责 |
|------|------|
| `SecurityFilterChain` | 一条安全过滤器链的配置入口，可以有多条 |
| `SecurityContextHolder` / `SecurityContextRepository` | 当前线程的认证信息 / 跨请求保存上下文（有状态时用 Session） |
| `AuthenticationManager` / `AuthenticationProvider` | 认证入口 / 具体认证方式 |
| `UserDetailsService` / `UserDetails` | 加载用户 / 用户主体 |
| `PasswordEncoder` | 密码哈希与校验，推荐 `DelegatingPasswordEncoder` |
| `JwtDecoder` / `JwtEncoder` | 校验 / 签发 JWT（Resource Server） |
| `JwtAuthenticationConverter` | JWT claims → `Authentication` 与权限 |
| `AuthorizationFilter` | URL 授权的执行点 |
| `AuthorizationManager` | 授权决策，URL 与方法授权共用 |
| `ExceptionTranslationFilter` | 认证 / 授权异常 → `AuthenticationEntryPoint`（401）/ `AccessDeniedHandler`（403） |
| `OncePerRequestFilter` | 自定义过滤器基类，保证一次请求只执行一次 |

---

## 小结

- 请求经 `DelegatingFilterProxy` → `FilterChainProxy` → 第一条匹配的 `SecurityFilterChain`，授权由最后的 `AuthorizationFilter` 交给 `AuthorizationManager` 完成；`FilterSecurityInterceptor` 等 Access API 已移入遗留模块
- 无状态 API：关闭 CSRF、Session 设为 STATELESS，自定义 401 / 403 JSON 响应；密码用 `DelegatingPasswordEncoder`
- JWT 推荐用 OAuth2 Resource Server：`JwtDecoder` 验签与校验 `iss`，`JwtAuthenticationConverter` 从 claims 映射权限，`JwtEncoder` 签发；对接授权服务器只需 `issuer-uri`
- 自定义 JJWT 过滤器要只解析一次、不查库、不注册成 `@Component`；`UserDetailsService` 返回自定义 `UserDetails` 才能取到 userId
- 方法级权限用 `@PreAuthorize`，注意自调用失效；权限码多时用元注解模板
- 动态 URL 权限实现 `AuthorizationManager<RequestAuthorizationContext>`，规则缓存在内存，通过 `access(...)` 接入
- `SecurityContextHolder` 默认 ThreadLocal，异步与虚拟线程需要用 `DelegatingSecurityContext*` 包装执行器

> 下一篇：[安全框架对比](./10_auth_framework) —— Spring Security、Shiro 与 Sa-Token 的取舍，以及 Sa-Token 的权限与 SSO 用法。

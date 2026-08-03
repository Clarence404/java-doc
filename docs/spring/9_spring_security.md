# Spring Security

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-security/reference/](https://docs.spring.io/spring-security/reference/)
> * Spring Security JWT 实战：[https://www.baeldung.com/spring-security-oauth-jwt](https://www.baeldung.com/spring-security-oauth-jwt)

## 一、核心架构

Spring Security 本质是一条 **Servlet Filter Chain**，所有安全逻辑通过过滤器串联。

```
请求
  → DelegatingFilterProxy          （桥接 Spring 容器与 Servlet 容器）
    → FilterChainProxy
      → SecurityFilterChain        （过滤器链）
          UsernamePasswordAuthenticationFilter  认证
          BasicAuthenticationFilter
          ExceptionTranslationFilter            异常处理
          FilterSecurityInterceptor             授权
  → Controller
```

---

## 二、SecurityFilterChain 配置

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity   // 开启 @PreAuthorize 等方法级权限
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;
    private final UserDetailsServiceImpl userDetailsService;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        return http
            // 禁用不需要的组件（前后端分离）
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .formLogin(AbstractHttpConfigurer::disable)
            .httpBasic(AbstractHttpConfigurer::disable)

            // 请求授权规则
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/**").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/swagger-ui/**", "/v3/api-docs/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            )

            // 异常处理
            .exceptionHandling(e -> e
                .authenticationEntryPoint((req, res, ex) -> {
                    res.setStatus(401);
                    res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"code\":401,\"message\":\"请先登录\"}");
                })
                .accessDeniedHandler((req, res, ex) -> {
                    res.setStatus(403);
                    res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"code\":403,\"message\":\"权限不足\"}");
                })
            )

            // JWT 过滤器放在用户名密码过滤器之前
            .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
            .build();
    }

    @Bean
    public AuthenticationManager authManager(AuthenticationConfiguration config) throws Exception {
        return config.getAuthenticationManager();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

---

## 三、UserDetailsService 实现

```java
@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {

    private final UserRepository userRepo;

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        User user = userRepo.findByUsername(username)
            .orElseThrow(() -> new UsernameNotFoundException("用户不存在: " + username));

        // 加载权限（ROLE_ 前缀是角色，无前缀是权限码）
        List<GrantedAuthority> authorities = user.getRoles().stream()
            .flatMap(role -> {
                List<GrantedAuthority> list = new ArrayList<>();
                list.add(new SimpleGrantedAuthority("ROLE_" + role.getCode()));
                role.getPermissions().stream()
                    .map(p -> new SimpleGrantedAuthority(p.getCode()))
                    .forEach(list::add);
                return list.stream();
            })
            .collect(Collectors.toList());

        return new org.springframework.security.core.userdetails.User(
            user.getUsername(),
            user.getPassword(),
            user.isEnabled(),
            true, true, true,
            authorities
        );
    }
}
```

---

## 四、JWT 集成

### 4.1 JwtUtil 工具类

```java
@Component
public class JwtUtil {

    @Value("${jwt.secret}")
    private String secret;

    @Value("${jwt.expiration:86400}")
    private long expirationSeconds;

    public String generate(Long userId, String username, List<String> roles) {
        return Jwts.builder()
            .subject(String.valueOf(userId))
            .claim("username", username)
            .claim("roles", roles)
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + expirationSeconds * 1000))
            .signWith(getKey())
            .compact();
    }

    public Claims parse(String token) {
        return Jwts.parser()
            .verifyWith(getKey())
            .build()
            .parseSignedClaims(token)
            .getPayload();
    }

    public Long getUserId(String token) {
        return Long.parseLong(parse(token).getSubject());
    }

    public boolean isExpired(String token) {
        return parse(token).getExpiration().before(new Date());
    }

    private SecretKey getKey() {
        return Keys.hmacShaKeyFor(Decoders.BASE64.decode(secret));
    }
}
```

### 4.2 JWT 认证过滤器

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtUtil jwtUtil;
    private final UserDetailsServiceImpl userDetailsService;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            filterChain.doFilter(request, response);
            return;
        }

        String token = header.substring(7);
        try {
            Long userId = jwtUtil.getUserId(token);
            // 避免重复解析
            if (SecurityContextHolder.getContext().getAuthentication() == null) {
                String username = jwtUtil.parse(token).get("username", String.class);
                UserDetails userDetails = userDetailsService.loadUserByUsername(username);
                UsernamePasswordAuthenticationToken auth =
                    new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());
                auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        } catch (JwtException e) {
            log.warn("JWT 解析失败: {}", e.getMessage());
            // 不写入 SecurityContext，后续会被 AuthenticationEntryPoint 处理
        }

        filterChain.doFilter(request, response);
    }
}
```

### 4.3 登录接口

```java
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthenticationManager authManager;
    private final JwtUtil jwtUtil;

    @PostMapping("/login")
    public Result<LoginVO> login(@RequestBody @Valid LoginDTO dto) {
        try {
            Authentication auth = authManager.authenticate(
                new UsernamePasswordAuthenticationToken(dto.getUsername(), dto.getPassword())
            );
            UserDetails user = (UserDetails) auth.getPrincipal();
            List<String> roles = user.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .collect(Collectors.toList());
            // 从自定义 UserDetails 获取 userId
            Long userId = ((CustomUserDetails) user).getId();
            String token = jwtUtil.generate(userId, user.getUsername(), roles);
            return Result.ok(new LoginVO(token, user.getUsername(), roles));
        } catch (BadCredentialsException e) {
            return Result.fail(401, "用户名或密码错误");
        }
    }
}
```

---

## 五、方法级权限控制

```java
@Service
public class OrderService {

    // SpEL 表达式：admin 角色 OR 当前用户访问自己的数据
    @PreAuthorize("hasRole('ADMIN') or #userId == authentication.principal.id")
    public OrderVO getOrder(Long orderId, Long userId) { ... }

    // 必须有权限码
    @PreAuthorize("hasAuthority('order:delete')")
    public void deleteOrder(Long orderId) { ... }

    // 对返回值做权限过滤
    @PostAuthorize("returnObject.userId == authentication.principal.id")
    public Order getById(Long id) { ... }
}
```

---

## 六、核心组件速查

| 组件 | 职责 |
|------|------|
| `SecurityContextHolder` | 存储当前认证信息，默认 ThreadLocal |
| `AuthenticationManager` | 认证入口，委托给 ProviderManager |
| `UserDetailsService` | 加载用户信息（需自行实现） |
| `PasswordEncoder` | 密码加密与校验（推荐 BCryptPasswordEncoder） |
| `SecurityFilterChain` | 过滤器链配置入口 |
| `OncePerRequestFilter` | 每次请求只执行一次的过滤器基类 |

---
description: Security / Sa-Token / Shiro 对比、Sa-Token 鉴权与封禁、Shiro 3、迁移与选型
---

# 安全框架对比

> **本篇目标**：看清 Spring Security、Sa-Token、Apache Shiro 三者的定位与当前版本状态，能在 Spring Boot 4 中正确接入 Sa-Token（含拦截器、异常处理、WebFlux），了解 Shiro 3 的接入方式，并能根据项目约束做出选型、规划迁移。
>
> **前置阅读**：[Spring Security](./9_security)

> 参考资料：
> * Sa-Token 官方文档：[https://sa-token.com/doc.html](https://sa-token.com/doc.html)
> * Apache Shiro：[https://shiro.apache.org/documentation.html](https://shiro.apache.org/documentation.html)
> * Apache Shiro 3.0.0 发布说明：[https://shiro.apache.org/blog/2026/06/apache-shiro-300-released.html](https://shiro.apache.org/blog/2026/06/apache-shiro-300-released.html)
> * Spring Security：[https://docs.spring.io/spring-security/reference/](https://docs.spring.io/spring-security/reference/)

本篇只讲框架选型与 API 用法。权限模型（RBAC / ABAC）见 [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)；OAuth2 / JWT 见 [OAuth2](/security/2_oauth2) / [JWT 令牌机制](/security/1_jwt)；SSO 原理见 [单点登录](/security/4_sso)，Sa-Token SSO 的接入代码见 [Spring SSO 接入](./11_single_sign_on)。

---

## 一、三大框架对比

| 对比项 | Spring Security | Sa-Token | Apache Shiro |
|--------|----------------|----------|-------------|
| 定位 | Spring 官方安全框架 | 国产轻量级权限认证框架 | Apache 通用 Java 安全框架 |
| 当前版本（2026-10） | 7.x（随 Boot 4） | 1.46.x | 3.0.x |
| Boot 4 支持 | 原生 | `sa-token-spring-boot4-starter` | Shiro 3 起支持 Boot 3 / 4 |
| 集成模型 | Servlet 过滤器链 + `AuthorizationManager` | 拦截器 / 注解 + 静态工具类 `StpUtil` | `SecurityManager` + `Realm` + 过滤器 |
| 功能完整度 | 完整（表单、OAuth2、SAML2、LDAP、方法安全） | 较完整（会话、踢人、封禁、二级认证、SSO、OAuth2） | 基础（认证、授权、会话、加密） |
| Boot 集成 | 自动配置，开箱即用 | starter + 少量 yml | 有 starter，但过滤器链、Realm 需自行组合 |
| 分布式会话 | 配合 Spring Session 或无状态 JWT | 内置 Redis 持久化插件 | 需自行实现 `SessionDAO` |
| OAuth2 / OIDC 服务端 | 内置 Authorization Server（Security 7 起并入主项目） | `sa-token-oauth2` 插件 | 无 |
| 响应式（WebFlux） | 支持 | 支持（`sa-token-reactor-spring-boot4-starter`） | 不支持 |
| 学习曲线 | 高 | 低 | 中 |
| 社区状态 | 活跃（Spring 生态） | 活跃（国内社区为主） | 维护节奏慢，1.x / 2.x 已 EOL |

一句话：**Spring Security 能力最全、与 Spring 生态绑定最深；Sa-Token 上手最快、API 最直白；Shiro 适合非 Spring 或遗留项目。**

---

## 二、Sa-Token 实战

### 1、依赖

Sa-Token 按 Boot 大版本拆分 starter，用 BOM 统一版本，避免各模块版本漂移：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>cn.dev33</groupId>
            <artifactId>sa-token-bom</artifactId>
            <version>1.46.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <!-- Boot 4.x；Boot 3.x 用 sa-token-spring-boot3-starter，Boot 2.x 用 sa-token-spring-boot-starter -->
    <dependency>
        <groupId>cn.dev33</groupId>
        <artifactId>sa-token-spring-boot4-starter</artifactId>
    </dependency>
    <!-- 可选：会话数据存 Redis（基于 Spring Data Redis 的 RedisTemplate），集群部署必选 -->
    <dependency>
        <groupId>cn.dev33</groupId>
        <artifactId>sa-token-redis-template</artifactId>
    </dependency>
    <dependency>
        <groupId>org.apache.commons</groupId>
        <artifactId>commons-pool2</artifactId>
    </dependency>
</dependencies>
```

```yaml
sa-token:
  token-name: Authorization   # 前端放在请求头 Authorization 中
  timeout: 86400              # Token 有效期（秒），-1 永不过期
  active-timeout: 1800        # 最低活跃频率（秒），超时未访问则冻结
  is-concurrent: true         # 允许同账号多端同时登录
  is-share: false             # 多次登录不复用 Token，便于按端踢下线
  token-style: uuid
  is-log: false
```

### 2、登录 / 登出

```java
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final UserService userService;
    private final PasswordEncoder passwordEncoder;   // 例如 BCryptPasswordEncoder，需自行声明 Bean

    @PostMapping("/login")
    public SaResult login(@RequestBody @Valid LoginDTO dto) {
        User user = userService.findByUsername(dto.username());
        if (user == null || !passwordEncoder.matches(dto.password(), user.getPasswordHash())) {
            return SaResult.error("用户名或密码错误");   // 不区分「用户不存在」与「密码错误」
        }
        StpUtil.login(user.getId(), "PC");             // 第二个参数为设备类型，可按端踢下线
        return SaResult.data(StpUtil.getTokenInfo());
    }

    @PostMapping("/logout")
    public SaResult logout() {
        StpUtil.logout();
        return SaResult.ok();
    }

    @GetMapping("/me")
    public SaResult me() {
        return SaResult.data(StpUtil.getLoginIdAsLong());
    }
}

public record LoginDTO(@NotBlank String username, @NotBlank String password) {}
```

### 3、注册拦截器：注解鉴权的前提

`@SaCheckLogin` / `@SaCheckRole` 等注解**由 `SaInterceptor` 解析**，不注册拦截器时注解不生效，这是最常见的接入错误。

```java
@Configuration
public class SaTokenConfig implements WebMvcConfigurer {

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 1. 注解鉴权；2. 路由级兜底：除登录接口外全部要求登录
        registry.addInterceptor(new SaInterceptor(handler ->
                    SaRouter.match("/**")
                            .notMatch("/api/auth/login", "/actuator/health")
                            .check(r -> StpUtil.checkLogin())))
                .addPathPatterns("/**");
    }
}
```

### 4、权限 / 角色校验

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @SaCheckRole("admin")
    @DeleteMapping("/{id}")
    public SaResult delete(@PathVariable Long id) {
        userService.delete(id);
        return SaResult.ok();
    }

    @SaCheckPermission("user:edit")
    @PutMapping("/{id}")
    public SaResult update(@PathVariable Long id, @RequestBody UserUpdateDTO dto) {
        userService.update(id, dto);
        return SaResult.ok();
    }
}

// 编程式鉴权：适合按数据动态判断的场景
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepo;

    public void deleteOrder(Long orderId) {
        StpUtil.checkPermission("order:delete");   // 无权限抛 NotPermissionException
        orderRepo.deleteById(orderId);
    }
}
```

### 5、实现权限数据接口

框架在鉴权时回调 `StpInterface` 取权限码与角色码。该方法**每次鉴权都会调用**，应读缓存而不是直接查库：

```java
@Component
@RequiredArgsConstructor
public class StpInterfaceImpl implements StpInterface {

    private final PermissionCacheService permissionCache;   // 内部可用 Caffeine / Redis 缓存

    @Override
    public List<String> getPermissionList(Object loginId, String loginType) {
        return permissionCache.permissionCodes(Long.parseLong(loginId.toString()));
        // 如 ["user:list", "user:edit", "order:delete"]，支持通配符 "user:*"
    }

    @Override
    public List<String> getRoleList(Object loginId, String loginType) {
        return permissionCache.roleCodes(Long.parseLong(loginId.toString()));
    }
}
```

权限缓存的失效与刷新策略见 [权限系统架构设计](/architecture/6_access_control)。

### 6、统一异常处理

鉴权失败抛出的是 Sa-Token 自己的异常，需要映射成合适的 HTTP 状态码：

```java
@RestControllerAdvice
public class SaTokenExceptionHandler {

    @ExceptionHandler(NotLoginException.class)
    public ResponseEntity<SaResult> notLogin(NotLoginException e) {
        // e.getType() 区分：未提供 Token / Token 无效 / 已过期 / 被顶下线 / 被踢下线
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(SaResult.error(e.getMessage()));
    }

    @ExceptionHandler({NotPermissionException.class, NotRoleException.class})
    public ResponseEntity<SaResult> forbidden(SaTokenException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(SaResult.error("无访问权限"));
    }
}
```

### 7、踢人、封禁与二级认证

```java
StpUtil.kickout(userId);                 // 踢下线：该账号所有 Token 失效，再访问抛 NotLoginException
StpUtil.kickout(userId, "PC");           // 只踢 PC 端
StpUtil.logout(userId);                  // 强制注销（与踢人的区别：提示语不同）

StpUtil.disable(userId, 86400);          // 封禁 1 天：登录时需先 StpUtil.checkDisable(userId)
StpUtil.isDisable(userId);
StpUtil.untieDisable(userId);            // 解封

StpUtil.openSafe(120);                   // 二级认证：敏感操作前再次验证密码，有效 120 秒
StpUtil.checkSafe();                     // 未处于二级认证状态则抛 NotSafeException
```

> 封禁不会自动踢下线：封禁后通常紧跟一次 `kickout`，否则已登录的会话仍然有效。

### 8、WebFlux 项目

响应式项目换用 reactor starter，并用全局过滤器 `SaReactorFilter` 代替拦截器：

```xml
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-reactor-spring-boot4-starter</artifactId>
</dependency>
```

```java
@Configuration
public class SaTokenReactorConfig {

    @Bean
    public SaReactorFilter saReactorFilter() {
        return new SaReactorFilter()
            .addInclude("/**")
            .addExclude("/api/auth/login")
            .setAuth(obj -> SaRouter.match("/**", r -> StpUtil.checkLogin()))
            .setError(e -> SaResult.error(e.getMessage()));
    }
}
```

Spring Cloud Gateway 统一鉴权也采用这种方式，网关与服务的鉴权分工见 [权限系统架构设计](/architecture/6_access_control)。

### 9、SSO 与 OAuth2 插件

- **SSO**：`sa-token-sso` 提供同域、跨域共享 Redis、跨域独立 Redis 三种模式，接入代码见 [Spring SSO 接入](./11_single_sign_on)
- **OAuth2**：`sa-token-oauth2` 可搭建简单的 OAuth2 授权服务；需要标准 OIDC、与第三方 IdP 互通时，优先用 Spring Authorization Server 或 Keycloak

---

## 三、Apache Shiro

### 1、版本现状

- **Shiro 3.0**（2026 年 6 月发布）：JDK 17 起步，只支持 Jakarta EE（不再有 `javax` 版本），支持 Spring 6 / 7 与 Spring Boot 3 / 4；JDK 25+ 上用 Scoped Values 替代 ThreadLocal 绑定 `Subject`
- 默认安全加固：路径匹配默认大小写不敏感、默认过滤器链加入 `NoAccessFilter`、默认放行 CORS 预检请求；`PrincipalCollection` 默认实现改为不可变（升级时注意）
- **Shiro 1.x / 2.x 已 EOL**，新项目或升级 Boot 4 时应直接上 3.x

### 2、接入

```xml
<dependency>
    <groupId>org.apache.shiro</groupId>
    <artifactId>shiro-spring-boot-web-starter</artifactId>
    <version>3.0.1</version>
</dependency>
```

```java
public class UserRealm extends AuthorizingRealm {

    private final UserService userService;

    public UserRealm(UserService userService, CredentialsMatcher matcher) {
        super(matcher);                       // 密码比对交给 CredentialsMatcher，不在 Realm 里手写
        this.userService = userService;
    }

    // 授权：返回角色与权限
    @Override
    protected AuthorizationInfo doGetAuthorizationInfo(PrincipalCollection principals) {
        Long userId = (Long) principals.getPrimaryPrincipal();
        SimpleAuthorizationInfo info = new SimpleAuthorizationInfo();
        info.setRoles(userService.getRoleCodes(userId));
        info.setStringPermissions(userService.getPermissionCodes(userId));
        return info;
    }

    // 认证：只负责按用户名取出凭证
    @Override
    protected AuthenticationInfo doGetAuthenticationInfo(AuthenticationToken token)
            throws AuthenticationException {
        String username = (String) token.getPrincipal();
        User user = userService.findByUsername(username);
        if (user == null) {
            throw new UnknownAccountException();
        }
        return new SimpleAuthenticationInfo(user.getId(), user.getPasswordHash(), getName());
    }
}

@Configuration
public class ShiroConfig {

    @Bean
    public Realm userRealm(UserService userService) {
        return new UserRealm(userService, new PasswordMatcher());   // 校验 DefaultPasswordService 生成的哈希
    }

    // starter 会自动创建 SecurityManager 与 ShiroFilter，只需声明过滤器链
    @Bean
    public ShiroFilterChainDefinition shiroFilterChainDefinition() {
        DefaultShiroFilterChainDefinition chain = new DefaultShiroFilterChainDefinition();
        chain.addPathDefinition("/api/auth/login", "anon");
        chain.addPathDefinition("/api/admin/**", "authc, roles[admin]");
        chain.addPathDefinition("/**", "authc");
        return chain;
    }
}
```

方法级鉴权用 `@RequiresRoles` / `@RequiresPermissions`，由 starter 自动注册的 AOP Advisor 解析。

---

## 四、并存与迁移

### 1、不要叠加两个安全框架

项目已经引入 Spring Security（哪怕只是为了 OAuth2 Client 或 Actuator 鉴权），就不要再叠加 Sa-Token 或 Shiro。两套框架各有一份「当前用户」上下文和一条过滤器链，结果是：

- 认证状态不一致：一边已登录、一边认为匿名
- 过滤器顺序难以控制，CSRF、CORS、Session 策略互相干扰
- 排查问题时需要同时理解两套机制

只是需要 Spring Security 的某个工具（如 `PasswordEncoder`），引入 `spring-security-crypto` 即可，不会带入过滤器链。

### 2、Shiro 迁移到 Spring Security

| Shiro | Spring Security |
|-------|-----------------|
| `Realm#doGetAuthenticationInfo` | `UserDetailsService` + `PasswordEncoder`（或自定义 `AuthenticationProvider`） |
| `Realm#doGetAuthorizationInfo` | `UserDetails#getAuthorities()`，复杂规则用 `AuthorizationManager` |
| `ShiroFilterChainDefinition`（anon / authc / roles） | `SecurityFilterChain` 的 `authorizeHttpRequests` |
| `@RequiresRoles` / `@RequiresPermissions` | `@EnableMethodSecurity` + `@PreAuthorize` |
| `SecurityUtils.getSubject()` | `SecurityContextHolder.getContext().getAuthentication()` |
| `SessionDAO`（分布式会话） | Spring Session（Redis / JDBC） |
| `HashedCredentialsMatcher` | `DelegatingPasswordEncoder`（`{bcrypt}` 等前缀，可兼容旧哈希） |

迁移要点：先用 `DelegatingPasswordEncoder` 兼容旧密码哈希，用户登录成功后再升级为新算法（`UserDetailsPasswordService`）；权限码保持不变，只替换校验入口，按 URL 分批切换。

---

## 五、选型建议

| 场景 | 推荐 |
|------|------|
| Spring Boot 标准企业项目，需要与 Spring 生态（OAuth2、Actuator、Spring Session）深度集成 | Spring Security |
| 微服务 + OAuth2 / OIDC，需要自建授权服务器 | Spring Security + Spring Authorization Server（或 Keycloak） |
| 国内中小项目，追求开发速度，需要踢人、封禁、多端登录等会话管理能力 | Sa-Token（集群部署加 Redis 插件） |
| 非 Spring 的 Java 项目，或存量 Shiro 项目 | Shiro 3.x；存量项目升级 Boot 4 时评估是否迁移到 Spring Security |
| 已使用 Spring Security 的项目 | 继续使用，不叠加其他框架 |

---

## 小结

- Spring Security 7 能力最全，OAuth2 授权服务器已并入主项目；Sa-Token 上手最快；Shiro 3.0 支持 Boot 4，1.x / 2.x 已 EOL
- Sa-Token 按 Boot 大版本选 starter（Boot 4 用 `sa-token-spring-boot4-starter`），用 `sa-token-bom` 统一版本；集群部署必须接 Redis
- Sa-Token 注解鉴权依赖 `SaInterceptor`，不注册拦截器注解不生效；`StpInterface` 每次鉴权都会回调，要读缓存
- 鉴权异常统一映射：`NotLoginException` → 401，`NotPermissionException` / `NotRoleException` → 403
- 封禁不等于踢下线，封禁后要 `kickout`；WebFlux 用 reactor starter + `SaReactorFilter`
- Shiro 接入只需声明 `Realm` 与 `ShiroFilterChainDefinition`，密码比对交给 `CredentialsMatcher`
- 一个应用只用一个安全框架；Shiro 迁移 Spring Security 按「Realm → UserDetailsService / AuthorizationManager」映射，密码用 `DelegatingPasswordEncoder` 平滑过渡

> 下一篇：[Spring SSO 接入](./11_single_sign_on) —— LDAP、CAS、SAML2、OIDC、Keycloak 与自建授权服务器的 Spring 接入配置。

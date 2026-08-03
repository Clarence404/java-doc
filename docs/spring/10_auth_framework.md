# 安全框架横向对比

> 参考资料：
> * Sa-Token 官方文档：[https://sa-token.cc/doc.html](https://sa-token.cc/doc.html)
> * Apache Shiro：[https://shiro.apache.org/documentation.html](https://shiro.apache.org/documentation.html)
> * Spring Security：[https://docs.spring.io/spring-security/reference/](https://docs.spring.io/spring-security/reference/)

> 本文聚焦框架选型与 API 使用。认证授权基础概念（RBAC / ABAC / OAuth2 / JWT）见 → [认证与授权](/security/0_security)

## 一、三大框架对比

| 对比项 | Spring Security | Sa-Token | Apache Shiro |
|--------|----------------|----------|-------------|
| 定位 | Spring 官方安全框架 | 轻量级 Java 权限框架 | 通用 Java 安全框架 |
| 集成难度 | 中（需理解过滤器链） | 低（开箱即用） | 低 |
| 功能完整度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 与 Spring Boot 集成 | 原生，无缝 | 良好 | 需手动配置 |
| 微服务 / 分布式支持 | 需配合 OAuth2 | 内置 Redis 分布式 Session | 需自行扩展 |
| 响应式支持 | ✅ WebFlux | ❌ | ❌ |
| 学习曲线 | 高 | 低 | 中 |
| 社区活跃度 | 高（Spring 生态） | 高（国内活跃） | 中（趋于维护态） |

---

## 二、Sa-Token 实战

```xml
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-spring-boot3-starter</artifactId>
    <version>1.38.0</version>
</dependency>
<!-- 分布式 Session（可选）-->
<dependency>
    <groupId>cn.dev33</groupId>
    <artifactId>sa-token-redis-jackson</artifactId>
    <version>1.38.0</version>
</dependency>
```

```yaml
sa-token:
  token-name: Authorization
  timeout: 86400          # Token 有效期（秒）
  is-concurrent: true     # 允许同账号多端登录
  is-share: true          # 同端多次登录复用同一 Token
  token-style: uuid
  is-log: false
```

### 2.1 登录 / 登出

```java
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    @PostMapping("/login")
    public Result<String> login(@RequestBody LoginDTO dto) {
        // 校验用户名密码
        User user = userService.authenticate(dto.getUsername(), dto.getPassword());
        if (user == null) {
            return Result.fail(401, "用户名或密码错误");
        }
        // 登录，绑定 userId
        StpUtil.login(user.getId());
        // 获取 Token
        return Result.ok(StpUtil.getTokenValue());
    }

    @PostMapping("/logout")
    public Result<Void> logout() {
        StpUtil.logout();
        return Result.ok();
    }

    @GetMapping("/me")
    public Result<Long> me() {
        return Result.ok(StpUtil.getLoginIdAsLong());
    }
}
```

### 2.2 权限 / 角色校验

```java
// 接口注解鉴权
@SaCheckLogin
@GetMapping("/profile")
public Result<UserVO> profile() { ... }

@SaCheckRole("admin")
@DeleteMapping("/{id}")
public Result<Void> delete(@PathVariable Long id) { ... }

@SaCheckPermission("user:edit")
@PutMapping("/{id}")
public Result<Void> update(@PathVariable Long id, @RequestBody UserUpdateDTO dto) { ... }

// 编程式鉴权
@Service
public class OrderService {

    public void deleteOrder(Long orderId) {
        StpUtil.checkPermission("order:delete");    // 无权限抛异常
        // 或
        if (!StpUtil.hasPermission("order:delete")) {
            throw new BusinessException("无删除权限");
        }
        orderRepo.deleteById(orderId);
    }
}
```

### 2.3 实现权限数据接口

```java
@Component
public class StpInterfaceImpl implements StpInterface {

    @Autowired
    private UserService userService;

    @Override
    public List<String> getPermissionList(Object loginId, String loginType) {
        Long userId = Long.parseLong(loginId.toString());
        return userService.getPermissionCodes(userId);
        // 返回如：["user:list", "user:edit", "order:delete"]
    }

    @Override
    public List<String> getRoleList(Object loginId, String loginType) {
        Long userId = Long.parseLong(loginId.toString());
        return userService.getRoleCodes(userId);
        // 返回如：["admin", "operator"]
    }
}
```

### 2.4 其他实用功能

```java
// 踢人下线（强制某用户下线）
StpUtil.kickout(userId);

// 账号封禁（禁止登录 N 秒）
StpUtil.disable(userId, 86400);
StpUtil.isDisable(userId);    // 检查是否被封禁

// 二级认证（敏感操作前要求重新验证）
StpUtil.openSafe(120);        // 开启二级认证，有效期 120 秒
StpUtil.checkSafe();          // 校验是否处于二级认证状态

// Token 信息
TokenInfo info = StpUtil.getTokenInfo();
```

---

## 三、Apache Shiro（简要）

```java
// 自定义 Realm
public class UserRealm extends AuthorizingRealm {

    @Autowired
    private UserService userService;

    // 授权
    @Override
    protected AuthorizationInfo doGetAuthorizationInfo(PrincipalCollection principals) {
        Long userId = (Long) principals.getPrimaryPrincipal();
        SimpleAuthorizationInfo info = new SimpleAuthorizationInfo();
        info.setRoles(userService.getRoles(userId));
        info.setStringPermissions(userService.getPermissions(userId));
        return info;
    }

    // 认证
    @Override
    protected AuthenticationInfo doGetAuthenticationInfo(AuthenticationToken token)
            throws AuthenticationException {
        String username = (String) token.getPrincipal();
        User user = userService.findByUsername(username);
        if (user == null) {
            throw new UnknownAccountException("用户不存在");
        }
        return new SimpleAuthenticationInfo(user.getId(), user.getPassword(),
            ByteSource.Util.bytes(user.getSalt()), getName());
    }
}

// Shiro 配置
@Bean
public SecurityManager securityManager(UserRealm realm) {
    DefaultWebSecurityManager manager = new DefaultWebSecurityManager();
    manager.setRealm(realm);
    return manager;
}
```

---

## 四、选型建议

| 场景 | 推荐 |
|------|------|
| Spring Boot 单体 / 标准企业项目 | Spring Security |
| 快速开发、不想深入安全框架 | Sa-Token |
| 非 Spring 的 Java 项目 | Shiro |
| 微服务 + OAuth2 / OIDC | Spring Security + Spring Authorization Server |
| 国内中小项目，需要分布式 Session | Sa-Token + Redis |

# 认证与授权

> 本文聚焦认证授权基础概念与权限模型。OAuth2/OIDC 协议见 → [OAuth2 与 OIDC](/security/1_oauth2_oidc)；JWT 格式见 → [JWT](/security/2_jwt)；SSO 实现方案见 → [单点登录](/security/3_sso)；Spring Security / Sa-Token 框架实现见 → [认证框架](/spring/10_auth_framework)

---

## 一、核心概念

| 概念 | 说明 | 示例 |
|------|------|------|
| **认证（Authentication）** | 验证你是谁 | 用户名密码登录、扫码、指纹 |
| **授权（Authorization）** | 确定你能做什么 | 管理员可删除用户，普通用户不可 |
| **鉴权（Access Control）** | 每次操作时判断是否有权限 | 请求到达接口时检查 token + 权限 |

---

## 二、RBAC 模型（Role-Based Access Control）

最广泛使用的权限模型：用户通过角色拥有权限，而非直接给用户授权。

### RBAC 进阶模型

| 模型 | 特性 |
|------|------|
| **RBAC0**（基础）| 用户 → 角色 → 权限，多角色叠加 |
| **RBAC1**（角色继承）| 角色间有层级，子角色继承父角色权限 |
| **RBAC2**（约束）| 互斥角色（同一用户不能同时持有两个角色）、角色数量上限 |

### 数据库设计

```sql
-- 用户表
CREATE TABLE sys_user (
  id       BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50)  UNIQUE NOT NULL,
  password VARCHAR(100) NOT NULL
);

-- 角色表
CREATE TABLE sys_role (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_code VARCHAR(50)  UNIQUE NOT NULL,   -- 如 ADMIN、EDITOR
  role_name VARCHAR(100) NOT NULL
);

-- 权限（资源/接口）表
CREATE TABLE sys_permission (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  perm_code VARCHAR(100) UNIQUE NOT NULL,   -- 如 user:delete、order:export
  type      TINYINT    NOT NULL,            -- 1=菜单 2=按钮 3=接口
  parent_id BIGINT                          -- 树形结构
);

-- 用户-角色（多对多）
CREATE TABLE sys_user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

-- 角色-权限（多对多）
CREATE TABLE sys_role_permission (
  role_id BIGINT NOT NULL,
  perm_id BIGINT NOT NULL,
  PRIMARY KEY (role_id, perm_id)
);
```

查询用户所有权限：

```sql
SELECT DISTINCT p.perm_code
FROM sys_user u
JOIN sys_user_role ur ON u.id = ur.user_id
JOIN sys_role_permission rp ON ur.role_id = rp.role_id
JOIN sys_permission p ON rp.perm_id = p.id
WHERE u.id = #{userId}
```

### Spring Security 集成

```java
// 加载用户权限（UserDetailsService）
@Override
public UserDetails loadUserByUsername(String username) {
    User user = userMapper.findByUsername(username);
    List<String> perms = permissionMapper.findByUserId(user.getId());

    List<GrantedAuthority> authorities = perms.stream()
        .map(SimpleGrantedAuthority::new)
        .toList();
    return new org.springframework.security.core.userdetails.User(
        user.getUsername(), user.getPassword(), authorities);
}

// 方法级权限注解
@PreAuthorize("hasAuthority('user:delete')")
@DeleteMapping("/users/{id}")
public void deleteUser(@PathVariable Long id) { ... }

@PreAuthorize("hasRole('ADMIN')")
@GetMapping("/admin/dashboard")
public DashboardVO getDashboard() { ... }

// FilterChain 级别配置
http.authorizeHttpRequests(auth -> auth
    .requestMatchers("/admin/**").hasRole("ADMIN")
    .requestMatchers(HttpMethod.DELETE, "/api/**").hasAuthority("data:delete")
    .anyRequest().authenticated());
```

---

## 三、ABAC 模型（Attribute-Based Access Control）

通过**属性表达式**动态决策权限，比 RBAC 更灵活，适合规则复杂且动态变化的场景（金融风控、多租户 SaaS）。

**三类属性：**

| 属性类型 | 说明 | 示例 |
|---------|------|------|
| 主体（Subject）| 操作者的属性 | 角色、部门、职级、所在地 |
| 资源（Resource）| 被访问对象的属性 | 数据分类、所属部门、密级 |
| 环境（Environment）| 访问时的上下文 | 时间、IP、设备类型 |

策略示例：`允许访问 IF 用户是审计员 AND 数据属于同一部门 AND 访问时间在工作时间内`

### OPA（Open Policy Agent）

```rego
# policy.rego
package authz

import future.keywords.if

default allow := false

# 管理员可以访问所有资源
allow if {
    input.user.role == "admin"
}

# 用户只能读取自己的数据
allow if {
    input.method == "GET"
    input.resource.owner_id == input.user.id
}

# 审计员只能在工作时间访问报表
allow if {
    input.user.role == "auditor"
    input.path[0] == "reports"
    to_number(time.clock(time.now_ns())[0]) >= 9
    to_number(time.clock(time.now_ns())[0]) < 18
}
```

```java
// Spring 拦截器调用 OPA
@Component
public class OpaAuthInterceptor implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest request, ...) {
        Map<String, Object> input = Map.of(
            "method",   request.getMethod(),
            "path",     Arrays.asList(request.getRequestURI().split("/")),
            "user",     SecurityContextHolder.getContext().getAuthentication().getPrincipal()
        );
        boolean allowed = opaClient.evaluate("authz", Map.of("input", input));
        if (!allowed) {
            response.sendError(HttpStatus.FORBIDDEN.value());
            return false;
        }
        return true;
    }
}
```

### RBAC vs ABAC 选型

| 维度 | RBAC | ABAC |
|------|------|------|
| 实现复杂度 | 低 | 高 |
| 权限粒度 | 角色级 | 属性组合级（更细）|
| 适合场景 | 权限规则稳定、较少变化 | 规则复杂、动态变化 |
| 典型框架 | Spring Security、Sa-Token | OPA、Casbin |

> 大多数业务系统用 RBAC0 即可。访问控制模型的完整讨论见 → [访问控制模型](/architecture/9_access_control_model)

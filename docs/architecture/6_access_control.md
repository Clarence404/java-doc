# 访问控制模型

> 访问控制决定"谁能对什么资源做什么操作"，是权限系统设计的核心。

---

## 一、四种主流模型

| 模型 | 全称 | 核心思想 | 适用场景 |
|------|------|---------|---------|
| **RBAC** | 基于角色的访问控制 | 用户 → 角色 → 权限 | 企业内部系统，主流方案 |
| **ABAC** | 基于属性的访问控制 | 用户属性 + 资源属性 + 环境动态判断 | 细粒度权限、零信任、云平台 |
| **DAC** | 自主访问控制 | 资源所有者自行决定授权 | 文件系统、小型系统 |
| **MAC** | 强制访问控制 | 系统强制定义安全级别，禁止降级 | 军事、政府高安全场景 |

---

## 二、RBAC 详解与落地

### 1. 数据模型（5张表）

```sql
-- 用户表
CREATE TABLE sys_user (
    id       BIGINT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(128) NOT NULL,
    status   TINYINT DEFAULT 1  -- 1启用 0禁用
);

-- 角色表
CREATE TABLE sys_role (
    id        BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_code VARCHAR(64) NOT NULL UNIQUE,  -- 如 ROLE_ADMIN
    role_name VARCHAR(64) NOT NULL
);

-- 权限表
CREATE TABLE sys_permission (
    id       BIGINT PRIMARY KEY AUTO_INCREMENT,
    perm_key VARCHAR(128) NOT NULL UNIQUE,  -- 如 order:read, order:delete
    perm_name VARCHAR(64),
    resource VARCHAR(128),   -- 资源路径，如 /api/order/**
    method   VARCHAR(10)     -- HTTP方法：GET POST DELETE
);

-- 用户-角色关联
CREATE TABLE sys_user_role (
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, role_id)
);

-- 角色-权限关联
CREATE TABLE sys_role_permission (
    role_id BIGINT NOT NULL,
    perm_id BIGINT NOT NULL,
    PRIMARY KEY (role_id, perm_id)
);
```

### 2. Spring Security + JWT 集成

```java
// 加载用户权限
@Service
public class UserDetailsServiceImpl implements UserDetailsService {
    @Autowired private UserMapper userMapper;
    @Autowired private PermissionMapper permMapper;

    @Override
    public UserDetails loadUserByUsername(String username) {
        SysUser user = userMapper.selectByUsername(username);
        if (user == null) throw new UsernameNotFoundException(username);

        // 查询该用户的所有权限
        List<String> perms = permMapper.selectPermKeysByUserId(user.getId());
        List<GrantedAuthority> authorities = perms.stream()
            .map(SimpleGrantedAuthority::new)
            .collect(toList());

        return new org.springframework.security.core.userdetails.User(
            user.getUsername(), user.getPassword(), authorities);
    }
}

// 接口级权限控制
@RestController
@RequestMapping("/api/order")
public class OrderController {

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('order:read')")
    public OrderResponse getOrder(@PathVariable Long id) { ... }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasAuthority('order:delete') or hasRole('ADMIN')")
    public void deleteOrder(@PathVariable Long id) { ... }
}
```

### 3. 动态权限（数据库驱动）

```java
@Component
public class DynamicSecurityMetadataSource implements FilterInvocationSecurityMetadataSource {
    @Autowired private PermissionMapper permMapper;

    @Override
    public Collection<ConfigAttribute> getAttributes(Object object) {
        String requestUrl = ((FilterInvocation) object).getRequestUrl();
        String method = ((FilterInvocation) object).getHttpRequest().getMethod();

        // 从 DB 匹配权限（也可缓存到 Redis，定时刷新）
        List<String> perms = permMapper.selectPermKeysByUrl(requestUrl, method);
        if (perms.isEmpty()) return null;  // null = 不需要权限

        return perms.stream()
            .map(SecurityConfig::createList)
            .flatMap(Collection::stream)
            .collect(toList());
    }
}
```

---

## 三、ABAC 详解与落地

基于**属性**动态判断权限，比 RBAC 更灵活，适合多维条件组合。

**属性类型**：
- **主体属性**：用户的部门、职级、地区
- **资源属性**：数据的归属部门、密级、创建者
- **环境属性**：访问时间、IP 地址、设备类型

```java
// 策略定义（可存 DB，动态配置）
public interface AccessPolicy {
    boolean evaluate(Subject subject, Resource resource, Environment env);
}

// 示例：只有同部门且在工作时间才能查看文档
public class DeptTimePolicy implements AccessPolicy {
    @Override
    public boolean evaluate(Subject subject, Resource resource, Environment env) {
        boolean sameDept = subject.getDeptId().equals(resource.getOwnerDeptId());
        boolean workHour = env.getHour() >= 9 && env.getHour() < 18;
        return sameDept && workHour;
    }
}

// 决策点（PDP）
@Service
public class AbacDecisionService {
    @Autowired private List<AccessPolicy> policies;

    public boolean canAccess(Subject subject, Resource resource, Environment env) {
        return policies.stream().allMatch(p -> p.evaluate(subject, resource, env));
    }
}
```

---

## 四、数据权限（行级权限）

除接口权限外，常见需求是**只能看到自己部门的数据**。

```java
// MyBatis Plus 数据权限拦截器
@Component
public class DataScopeInterceptor implements InnerInterceptor {
    @Override
    public void beforeQuery(Executor e, MappedStatement ms, Object parameter,
                            RowBounds rb, ResultHandler rh, BoundSql sql) {
        SysUser currentUser = SecurityUtils.getCurrentUser();
        if (currentUser.isAdmin()) return;  // 管理员不限制

        String originalSql = sql.getSql();
        String scopeSql = addDataScope(originalSql, currentUser.getDeptId());
        // 反射修改 sql...
    }

    private String addDataScope(String sql, Long deptId) {
        // 追加 AND dept_id = #{deptId} 或 AND dept_id IN (子部门列表)
        return sql + " AND dept_id = " + deptId;
    }
}
```

---

## 五、模型对比与选型

| 维度 | RBAC | ABAC | DAC | MAC |
|------|------|------|-----|-----|
| 实现复杂度 | 低 | 高 | 低 | 高 |
| 灵活性 | 中 | 高 | 高 | 低 |
| 安全性 | 中 | 高 | 低 | 最高 |
| 运维成本 | 低 | 高 | 低 | 高 |
| 适用场景 | 企业系统 | 云平台/零信任 | 文件系统 | 军事/政府 |

**选型建议**：
- 普通业务系统 → **RBAC**（5张表 + Spring Security）
- 需要细粒度/动态权限 → **RBAC + ABAC 混合**（RBAC 控制接口级，ABAC 控制数据级）
- 角色爆炸（角色数量超过 100）→ 考虑迁移到 ABAC

---
description: RBAC / ABAC / DAC / MAC、权限数据库设计、OPA、数据权限、模型选型；目标：能落地菜单、按钮、数据权限
---

# 权限模型：RBAC 与 ABAC

> 本文聚焦认证授权基础概念与权限模型（与框架无关）。JWT 格式见 → [JWT](/security/1_jwt)；OAuth2 协议见 → [OAuth2](/security/2_oauth2)；OIDC 协议见 → [OIDC](/security/3_oidc)；SSO 实现方案见 → [单点登录](/security/4_sso)
>
> 权限系统整体架构（PEP / PDP 部署、网关与服务鉴权分工、权限缓存、数据权限拦截实现）见 → [权限系统架构设计](/architecture/6_access_control)；Spring Security / Sa-Token 框架实现见 → [Spring Security](/spring/9_security) / [认证框架](/spring/10_auth_framework)

---

## 一、核心概念

| 概念 | 说明 | 示例 |
|------|------|------|
| **认证（Authentication）** | 验证你是谁 | 用户名密码登录、扫码、指纹 |
| **授权（Authorization）** | 确定你能做什么 | 管理员可删除用户，普通用户不可 |
| **鉴权（Access Control）** | 每次操作时判断是否有权限 | 请求到达接口时检查 token + 权限 |

访问控制决定"谁能对什么资源做什么操作"，是权限系统设计的核心。四种主流模型：

| 模型 | 全称 | 核心思想 | 适用场景 |
|------|------|---------|---------|
| **RBAC** | 基于角色的访问控制 | 用户 → 角色 → 权限 | 企业内部系统，主流方案 |
| **ABAC** | 基于属性的访问控制 | 用户属性 + 资源属性 + 环境动态判断 | 细粒度权限、零信任、云平台 |
| **DAC** | 自主访问控制 | 资源所有者自行决定授权 | 文件系统、小型系统 |
| **MAC** | 强制访问控制 | 系统强制定义安全级别，禁止降级 | 军事、政府高安全场景 |

---

## 二、RBAC 模型（Role-Based Access Control）

![RBAC 权限模型](../assets/security/rbac-model.svg)

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

常见扩展字段：

- 用户表加 `status TINYINT DEFAULT 1`（1 启用 0 禁用）
- 需要按 URL 动态鉴权时，权限表加 `resource VARCHAR(128)`（资源路径，如 `/api/order/**`）与 `method VARCHAR(10)`（HTTP 方法：GET POST DELETE），实现见 → [Spring Security · 动态权限](/spring/9_security)

查询用户所有权限：

```sql
SELECT DISTINCT p.perm_code
FROM sys_user u
JOIN sys_user_role ur ON u.id = ur.user_id
JOIN sys_role_permission rp ON ur.role_id = rp.role_id
JOIN sys_permission p ON rp.perm_id = p.id
WHERE u.id = #{userId}
```

> Spring Security 加载权限、`@PreAuthorize` 与 FilterChain 级配置见 → [Spring Security · RBAC 集成](/spring/9_security)

---

## 三、ABAC 模型（Attribute-Based Access Control）

通过**属性表达式**动态决策权限，比 RBAC 更灵活，适合规则复杂且动态变化的场景（金融风控、多租户 SaaS）。

**三类属性：**

| 属性类型 | 说明 | 示例 |
|---------|------|------|
| 主体（Subject）| 操作者的属性 | 角色、部门、职级、所在地 |
| 资源（Resource）| 被访问对象的属性 | 数据分类、所属部门、密级、创建者 |
| 环境（Environment）| 访问时的上下文 | 时间、IP、设备类型 |

策略示例：`允许访问 IF 用户是审计员 AND 数据属于同一部门 AND 访问时间在工作时间内`

### 纯 Java 实现（策略接口 + PDP）

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

### OPA（Open Policy Agent）

```go
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

---

## 四、数据权限（行级权限）

除接口权限外，常见需求是**只能看到自己部门的数据**。两者解决的问题不同：

| 维度 | 接口权限（功能权限）| 数据权限（行级权限）|
|------|------------------|------------------|
| 回答的问题 | 能不能调这个接口 / 看到这个按钮 | 调得通之后能看到哪些行 |
| 典型规则 | `order:delete`、`hasRole('ADMIN')` | 仅本人、本部门、本部门及子部门、全部 |
| 判定时机 | 请求进入 Controller 之前 | 查询 SQL 执行时追加过滤条件 |
| 模型归属 | RBAC 为主 | 本质是 ABAC（主体部门 vs 资源所属部门）|

设计要点：

- 数据范围通常挂在**角色**上（如"部门经理 → 本部门及子部门"），多角色取并集
- 管理员 / 超级角色跳过过滤
- 过滤条件必须在**服务端 SQL 层**统一追加，不能依赖前端传参

> SQL 拦截器实现（MyBatis-Plus `InnerInterceptor`）与拦截架构见 → [权限系统架构设计](/architecture/6_access_control)

---

## 五、模型对比与选型

### 四种模型对比

| 维度 | RBAC | ABAC | DAC | MAC |
|------|------|------|-----|-----|
| 实现复杂度 | 低 | 高 | 低 | 高 |
| 灵活性 | 中 | 高 | 高 | 低 |
| 安全性 | 中 | 高 | 低 | 最高 |
| 运维成本 | 低 | 高 | 低 | 高 |
| 适用场景 | 企业系统 | 云平台/零信任 | 文件系统 | 军事/政府 |

### RBAC vs ABAC

| 维度 | RBAC | ABAC |
|------|------|------|
| 实现复杂度 | 低 | 高 |
| 权限粒度 | 角色级 | 属性组合级（更细）|
| 适合场景 | 权限规则稳定、较少变化 | 规则复杂、动态变化 |
| 典型框架 | Spring Security、Sa-Token | OPA、Casbin |

**选型建议**：
- 普通业务系统 → **RBAC**（5张表 + Spring Security），大多数业务系统用 RBAC0 即可
- 需要细粒度/动态权限 → **RBAC + ABAC 混合**（RBAC 控制接口级，ABAC 控制数据级）
- 角色爆炸（角色数量超过 100）→ 考虑迁移到 ABAC

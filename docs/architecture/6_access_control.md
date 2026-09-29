# 权限系统架构设计

> 本文讨论权限系统在分布式架构中"放在哪、怎么缓存、怎么拦数据"。权限模型本身（RBAC / ABAC / DAC / MAC、5 张表、OPA 策略、选型）见 → [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)；Spring Security 接线代码（UserDetailsService、`@PreAuthorize`、动态权限）见 → [Spring Security](/spring/9_security)

---

## 一、权限系统的四个角色

无论用 RBAC 还是 ABAC，一次鉴权都可以拆成四个职责（术语源自 XACML，零信任架构也沿用）：

| 角色 | 全称 | 职责 | 典型落点 |
|------|------|------|---------|
| **PEP** | Policy Enforcement Point（执行点）| 拦截请求，向 PDP 询问结果并执行放行 / 拒绝 | 网关过滤器、Spring Security FilterChain、`@PreAuthorize`、SQL 拦截器 |
| **PDP** | Policy Decision Point（决策点）| 根据策略 + 属性计算 allow / deny | 应用内鉴权服务、OPA、Casbin Enforcer |
| **PAP** | Policy Administration Point（管理点）| 维护角色、权限、策略 | 权限管理后台 |
| **PIP** | Policy Information Point（信息点）| 为决策提供属性：用户部门、资源归属、时间、IP | 用户中心、组织架构服务、业务库 |

设计原则：**PEP 可以有很多个，PDP 的规则只维护一份**。同一条规则如果在网关、服务、前端各写一遍，迟早会出现不一致。

---

## 二、鉴权放在哪一层

### 网关级 vs 服务级

| 维度 | 网关级鉴权 | 服务级鉴权 |
|------|-----------|-----------|
| 能拿到的信息 | Token、URL、HTTP 方法、Header | 完整业务上下文（订单归属、审批状态）|
| 适合的规则 | 认证、粗粒度 URL / 角色校验、黑白名单 | 方法级权限、资源归属校验、数据权限 |
| 优点 | 统一入口，非法请求不进内网，业务服务无感 | 规则贴近业务，能做细粒度判断 |
| 缺点 | 无法判断"这条数据是不是你的" | 每个服务都要接入，容易遗漏 |

**推荐分工**：网关负责**认证 + 粗粒度授权**，服务负责**细粒度授权 + 数据权限**。

1. 网关校验 JWT 签名与有效期，拒绝未登录请求
2. 网关按 URL 前缀做角色级拦截（如 `/admin/**` 需 `ADMIN`）
3. 网关把解析后的用户标识透传给下游（如 `X-User-Id`），**必须先删除客户端自带的同名 Header**，防止伪造
4. 服务内用 `@PreAuthorize` 做权限码校验，用 SQL 拦截器做数据范围过滤

### 服务间调用

内部服务互调不能默认"内网可信"：要么继续透传用户 Token（按用户身份鉴权），要么使用服务身份（OAuth2 Client Credentials / mTLS）按服务身份鉴权。详见 → [零信任架构](/security/9_zero_trust)

### 集中式 PDP 的部署形态

| 形态 | 做法 | 适用 |
|------|------|------|
| 应用内嵌 | 每个服务引入权限 SDK，本地计算 | 单体、少量服务，延迟最低 |
| 集中权限服务 | 独立权限服务提供 `check(user, perm)` 接口 | 多服务共享规则，需加缓存兜底 |
| Sidecar（如 OPA）| 每个 Pod 旁挂策略引擎，策略集中下发 | 服务网格、策略频繁变化的场景 |

---

## 三、权限数据的缓存与刷新

每个请求都查 5 张表不可接受，权限数据必须缓存；难点在于**权限变更后多快生效**。

### 权限放在哪

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| 写进 JWT | 登录时把角色 / 权限码放入 claims | 无需查询，网关可直接判断 | Token 变大；改权限要等 Token 过期 |
| Redis 集中缓存 | `perm:user:{userId}` → 权限码集合 | 改权限后删 key 即可生效 | 每次请求一次 Redis 往返 |
| 本地缓存 + Redis | Caffeine 本地缓存，Redis 作二级 | 延迟最低 | 需要广播失效，多节点一致性更复杂 |

常见折中：**JWT 只放 userId 和角色**，权限码走 Redis / 本地缓存；URL → 权限码的映射（动态权限表）数据量小、变化少，适合全量加载到本地缓存并定时刷新。

### 变更后如何刷新

| 策略 | 做法 | 生效时间 |
|------|------|---------|
| TTL 过期 | 缓存设 5~10 分钟过期 | 最多延迟一个 TTL |
| 主动失效 | 管理后台改权限后删除相关用户的缓存 key | 秒级 |
| 广播失效 | 改权限后发 MQ / Redis Pub/Sub 消息，各节点清本地缓存 | 秒级，适合本地缓存 |
| 权限版本号 | 用户表存 `perm_version`，Token 携带版本号，不一致则强制重新加载 / 重新登录 | 下一次请求 |

注意"角色改了影响多少人"：修改一个角色的权限，要失效**所有持有该角色的用户**的缓存；用户量大时宜按角色维度缓存（`perm:role:{roleId}`），用户只缓存角色列表。

> JWT 吊销与版本号策略见 → [JWT · 失效与刷新策略](/security/1_jwt)；两级缓存一致性见 → [两级缓存](/cache/8_two_level_cache)

---

## 四、数据权限拦截架构

数据权限（行级权限）的原理与数据范围类型见 → [权限模型 · 数据权限](/security/5_rbac_abac)。架构上的关键是：**在哪一层统一追加过滤条件**。

| 拦截位置 | 做法 | 评价 |
|---------|------|------|
| Controller / Service 手写 | 每个查询自己拼 `dept_id` 条件 | 易遗漏，不推荐 |
| AOP 注解 | `@DataScope` 标记方法，切面把范围条件放入上下文 | 声明式，需配合 SQL 层落地 |
| ORM / SQL 拦截器 | 在 SQL 执行前统一改写 | 覆盖最全，主流做法 |
| 数据库行级安全（RLS）| PostgreSQL Row Level Security 等 | 最底层，但与连接池 / 多租户会话变量耦合 |

典型链路：网关 / FilterChain 解析出当前用户 → 用户上下文（ThreadLocal / SecurityContext）带上部门与数据范围 → Mapper 方法可选 `@DataScope` 标记 → SQL 拦截器读取上下文并改写 SQL。

### MyBatis-Plus 数据权限拦截器

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

落地注意：

- 示例用字符串拼接只为说明思路；生产应使用 JSqlParser 解析 SQL 后在 WHERE 中追加条件（MyBatis-Plus 自带的 `DataPermissionInterceptor` 即基于此），避免 `ORDER BY` / `LIMIT` / 子查询场景拼错
- "本部门及子部门"不要每次递归查组织树：部门表冗余 `ancestors` 路径字段，或把子部门 ID 列表缓存起来
- 统计报表、定时任务等**无用户上下文**的调用要显式声明跳过，而不是因为取不到用户就默认放开
- 多租户的 `tenant_id` 过滤与数据权限是两层，应分别拦截，不要混在一条规则里

---

## 五、演进路线

| 阶段 | 形态 | 关注点 |
|------|------|--------|
| 单体 | Spring Security / Sa-Token + RBAC 5 张表 | 菜单、按钮、接口权限一套模型 |
| 微服务初期 | 网关认证 + 各服务 `@PreAuthorize`，权限码缓存到 Redis | Header 透传安全、缓存失效 |
| 微服务成熟 | 独立权限中心（PAP + PDP），统一 SDK / 网关插件 | 规则只维护一份，审计变更 |
| 规则复杂 / 零信任 | RBAC + ABAC 混合，OPA Sidecar 做策略引擎 | 策略即代码、策略测试与灰度 |

---

## 六、相关文档

- [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)：模型、表设计、OPA、选型
- [Spring Security](/spring/9_security)：RBAC 集成、动态权限、方法级权限
- [安全框架对比](/spring/10_auth_framework)：Sa-Token / Shiro 权限 API
- [零信任架构](/security/9_zero_trust)：mTLS、OPA 动态授权
- [JWT](/security/1_jwt)：Token 失效、吊销与版本号

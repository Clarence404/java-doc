---
description: RBAC0–3 与角色爆炸、ABAC、ReBAC、模型选型、OPA / Rego v1、jCasbin、方法级授权
---

# 权限模型：RBAC 与 ABAC

> 前置阅读：[JWT 令牌机制](/security/1_jwt)、[Spring Security](/spring/9_security)

认证（Authentication）回答「你是谁」，授权（Authorization）回答「你能对什么资源做什么操作」。本篇讲 RBAC（含 RBAC0–3 与角色爆炸）、ABAC、ReBAC 三种授权模型的思路与选型，以及用 OPA（Rego v1）和 jCasbin 抽离策略并接入 Spring Security 7。

---

## 一、核心概念

一次授权判断可以抽象成：**主体（Subject）能否对资源（Resource）执行操作（Action）**，判断时可能还要参考环境（时间、IP、设备）。不同模型的区别在于「凭什么判断」：

| 模型 | 判断依据 | 典型场景 |
|------|---------|---------|
| DAC（自主访问控制） | 资源所有者自行授权给他人 | 文件系统权限、网盘共享 |
| MAC（强制访问控制） | 系统给主体和资源定密级，强制比较 | 军工、政务涉密系统、SELinux |
| RBAC（基于角色） | 用户拥有哪些角色，角色拥有哪些权限 | 企业内部系统、后台管理，最主流 |
| ABAC（基于属性） | 主体、资源、环境属性是否满足策略表达式 | 细粒度、动态规则，云平台、零信任 |
| ReBAC（基于关系） | 主体与资源之间是否存在某种关系（直接或沿关系图传递） | 文档协作、组织树、多租户 SaaS |

DAC 和 MAC 在业务系统里很少单独使用，下面重点讲后三种。

---

## 二、RBAC 模型

![RBAC 权限模型](../assets/security/rbac-model.svg)

RBAC（Role-Based Access Control）不直接给用户授权，而是「用户 → 角色 → 权限」两级多对多。人员变动时只调整用户的角色，权限定义保持稳定。

### 1、RBAC0–3 分级

分级来自 Sandhu 等人 1996 年提出的 RBAC96 模型，NIST 在此基础上形成了 ANSI INCITS 359 标准（分为核心 RBAC、层次 RBAC、静态职责分离、动态职责分离）：

| 级别 | 特性 | 例子 |
|------|------|------|
| **RBAC0**（核心） | 用户、角色、权限、会话；用户可持有多个角色，权限取并集 | 张三同时是「编辑」和「审核员」 |
| **RBAC1**（角色继承） | 角色之间有层级，上级角色自动拥有下级角色的权限 | 「部门经理」继承「员工」的全部权限 |
| **RBAC2**（约束） | 职责分离（SoD）：静态互斥（不能同时被分配）、动态互斥（同一会话不能同时激活）；角色基数上限、先决角色 | 「出纳」和「会计」互斥 |
| **RBAC3**（统一） | RBAC1 + RBAC2，继承与约束同时存在 | 大型企业 IAM |

多数业务系统用 RBAC0 加少量角色继承就够了；财务、审批类系统要认真实现职责分离约束，否则会出现「自己提交、自己审批」。

### 2、数据库设计

经典的 5 张表：

```sql
-- 用户表
CREATE TABLE sys_user (
  id       BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50)  NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,           -- 存 BCrypt / Argon2 哈希
  status   TINYINT      NOT NULL DEFAULT 1  -- 1 启用 0 禁用
);

-- 角色表
CREATE TABLE sys_role (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_code VARCHAR(50)  NOT NULL UNIQUE,   -- 如 ADMIN、EDITOR
  role_name VARCHAR(100) NOT NULL,
  parent_id BIGINT                          -- 角色继承（RBAC1），可为空
);

-- 权限表：菜单、按钮、接口
CREATE TABLE sys_permission (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  perm_code VARCHAR(100) NOT NULL UNIQUE,   -- 如 user:delete、order:export
  type      TINYINT      NOT NULL,          -- 1 菜单 2 按钮 3 接口
  parent_id BIGINT                          -- 菜单树
);

-- 用户-角色
CREATE TABLE sys_user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

-- 角色-权限
CREATE TABLE sys_role_permission (
  role_id BIGINT NOT NULL,
  perm_id BIGINT NOT NULL,
  PRIMARY KEY (role_id, perm_id)
);
```

查询某个用户的全部权限码（`?` 为参数占位符，MyBatis 中写作 `#{userId}`）：

```sql
SELECT DISTINCT p.perm_code
FROM sys_user_role ur
JOIN sys_role_permission rp ON ur.role_id = rp.role_id
JOIN sys_permission p       ON rp.perm_id = p.id
WHERE ur.user_id = ?;
```

需要按 URL 动态鉴权时，权限表再加 `resource`（路径模式，如 `/api/orders/**`）和 `method`（HTTP 方法）两列，运行时匹配的实现见 [Spring Security · 动态权限](/spring/9_security)。

### 3、角色爆炸

RBAC 的典型失败方式是**角色爆炸**：每出现一个新的维度组合，就新建一个角色。比如「华东区-订单-只读」「华东区-订单-审批」「华南区-订单-只读」……地区 × 业务线 × 操作级别相乘，角色数很快上百上千，没人说得清某个角色到底能干什么，离职、转岗时权限也回收不干净。

应对办法：

- **角色只表达职能**，组织、地区、租户这类维度不要编进角色名，改为用户或资源的属性，在数据权限或 ABAC 规则里处理
- **角色继承**收敛重复授权；**带域的 RBAC**（同一用户在不同租户 / 项目里有不同角色，Casbin 称为 RBAC with domains）解决多租户
- 定期做权限审计（Access Review），清理长期未使用的角色和授权
- 当规则本质上是「属性比较」或「对象间关系」时，换成 ABAC 或 ReBAC，而不是继续加角色

---

## 三、ABAC 模型

ABAC（Attribute-Based Access Control）用**属性 + 策略表达式**动态决策，NIST SP 800-162 给出了它的标准定义。

| 属性类别 | 说明 | 示例 |
|---------|------|------|
| 主体（Subject） | 操作者的属性 | 角色、部门、职级、安全等级 |
| 资源（Resource） | 被访问对象的属性 | 所属部门、密级、创建人、状态 |
| 操作（Action） | 要执行的动作 | 读、写、审批、导出 |
| 环境（Environment） | 访问时的上下文 | 时间、IP、设备是否受管、风险评分 |

策略示例：*审计员可以在工作日 9:00–18:00 读取本部门的报表*。这条规则如果用 RBAC 表达，需要按部门、时间段拆出一堆角色；用 ABAC 只是一条表达式。

ABAC 的代价是规则分散、难以回答「张三到底能看到什么」，因此通常把策略集中到一个**策略决策点（PDP）**里统一维护，业务代码只负责收集属性、执行决策结果。早期标准是 OASIS 的 XACML 3.0（XML 语法，较重），现在更常用 OPA / Rego、AWS 开源的 Cedar 这类策略即代码方案，见第六节。

最简单的落地是在应用内把策略写成代码，适合规则不多的场景：

```java
public record Subject(String userId, String deptId, Set<String> roles) {}
public record Resource(String type, String ownerDeptId) {}
public record Environment(LocalTime time, DayOfWeek day) {}

public interface AccessPolicy {
    boolean applies(Subject subject, Resource resource, String action);
    boolean permit(Subject subject, Resource resource, String action, Environment env);
}

// 审计员只能在工作时间读取本部门报表
@Component
public class AuditorReportPolicy implements AccessPolicy {

    @Override
    public boolean applies(Subject subject, Resource resource, String action) {
        return subject.roles().contains("AUDITOR") && "report".equals(resource.type());
    }

    @Override
    public boolean permit(Subject subject, Resource resource, String action, Environment env) {
        boolean workday  = env.day().getValue() <= DayOfWeek.FRIDAY.getValue();
        boolean workHour = !env.time().isBefore(LocalTime.of(9, 0)) && env.time().isBefore(LocalTime.of(18, 0));
        return "read".equals(action)
            && subject.deptId().equals(resource.ownerDeptId())
            && workday && workHour;
    }
}

// 决策点：没有任何策略适用时默认拒绝；有适用策略时全部通过才放行
@Service
public class AbacDecisionService {

    private final List<AccessPolicy> policies;

    public AbacDecisionService(List<AccessPolicy> policies) {
        this.policies = policies;
    }

    public boolean decide(Subject subject, Resource resource, String action) {
        LocalDateTime now = LocalDateTime.now(ZoneId.of("Asia/Shanghai"));
        Environment env = new Environment(now.toLocalTime(), now.getDayOfWeek());
        List<AccessPolicy> applicable = policies.stream()
            .filter(p -> p.applies(subject, resource, action))
            .toList();
        return !applicable.isEmpty()
            && applicable.stream().allMatch(p -> p.permit(subject, resource, action, env));
    }
}
```

规则多起来、或者需要多个服务共用同一套规则时，就该换成独立的策略引擎。

---

## 四、ReBAC 模型

ReBAC（Relationship-Based Access Control）把权限建模成**对象之间的关系图**：「alice 是文档 1 的编辑者」「文档 1 在财务文件夹里」「bob 是财务文件夹的查看者」，于是 bob 可以查看文档 1。权限沿关系传递，天然适合文档协作、组织树、多租户这类「谁和谁有关系」的场景，也就是 Google Drive 式的分享模型。

代表实现是 Google 的 Zanzibar（2019 年 USENIX ATC 论文，支撑 Drive、YouTube 等产品的统一授权），开源实现有：

- **OpenFGA**：源自 Auth0 / Okta，2025 年 10 月升级为 CNCF 孵化项目，提供 Java SDK
- **SpiceDB**：AuthZed 开源，Schema 语言接近 Zanzibar 原始设计

以 OpenFGA 的建模语言为例：

```text
model
  schema 1.1

type user

type folder
  relations
    define owner: [user]
    define viewer: [user] or owner

type document
  relations
    define parent: [folder]
    define owner: [user]
    define editor: [user] or owner
    define viewer: [user] or editor or viewer from parent
```

写入关系元组（`对象#关系@用户`）：`folder:finance#viewer@user:bob`、`document:q3-report#parent@folder:finance`。之后调用 `check(user:bob, viewer, document:q3-report)` 返回 `true`：bob 是文件夹的查看者，查看权限沿 `parent` 关系传到了文档。

ReBAC 的权限数据（关系元组）存在独立的授权服务里，业务数据变化时（建文档、移动文件夹、加成员）要同步写关系，这是它最大的工程成本。另一个难点是「列出用户能看到的所有文档」，需要授权服务提供 `ListObjects` 一类接口，或在业务库里另做冗余。

---

## 五、模型对比与选型

![三种授权模型对比](../assets/security/rbac-abac-models.svg)

| 维度 | RBAC | ABAC | ReBAC |
|------|------|------|-------|
| 判断依据 | 用户的角色 | 主体 / 资源 / 环境属性 | 主体与对象的关系（可传递） |
| 粒度 | 功能级（菜单、按钮、接口） | 任意细，可到字段与时间段 | 对象级（具体某个文档、项目） |
| 规则变化 | 稳定，调整靠改角色分配 | 改策略即可，适合频繁变化 | 改关系元组，随业务数据实时变化 |
| 可审计性 | 好：一眼看出某角色有哪些权限 | 差：需要工具评估「谁能访问什么」 | 中：可沿关系图展开 |
| 实现成本 | 低，5 张表 + 框架注解 | 高，需要属性来源和策略引擎 | 高，需要独立授权服务并同步关系 |
| 典型实现 | Spring Security、Sa-Token、jCasbin | OPA、Cedar、jCasbin（ABAC 模型） | OpenFGA、SpiceDB |
| 适用场景 | 企业内部系统、后台管理 | 风控、多条件审批、零信任动态授权 | 文档协作、组织树、多租户 SaaS |

**选型建议**：

- 普通业务系统 → **RBAC**，大多数场景 RBAC0 + 少量角色继承即可
- 有「同部门」「本人创建」「工作时间」这类条件 → **RBAC + ABAC**：RBAC 管能不能调这个接口，ABAC 规则管能不能动这条数据
- 有「分享给某人」「继承上级文件夹权限」的需求 → 对象级权限交给 **ReBAC**，功能权限仍用 RBAC
- 角色数持续膨胀、角色名里编进了地区和部门 → 说明维度放错了位置，把这些维度改成属性

### 数据权限

功能权限回答「能不能调这个接口」，数据权限（行级权限）回答「调通之后能看到哪些行」，本质是一条 ABAC 规则：主体的部门与资源所属部门比较。

- 常见数据范围：仅本人、本部门、本部门及子部门、全部、自定义部门集合
- 数据范围通常挂在**角色**上（如「部门经理 → 本部门及子部门」），多角色取并集；超级管理员跳过过滤
- 过滤条件必须在服务端统一追加，不能依赖前端传参

在哪一层追加条件、MyBatis-Plus 拦截器的实现和落地注意事项见 [权限系统架构设计 · 数据权限拦截架构](/architecture/6_access_control)。

---

## 六、OPA 策略引擎

OPA（Open Policy Agent）是 CNCF 毕业项目，用声明式语言 **Rego** 编写策略，把「是否允许」从业务代码中抽离出来。业务服务（PEP）把请求上下文作为 `input` 发给 OPA，OPA 结合策略和外部数据（`data`）计算结果并返回。同一个引擎还用于 Kubernetes 准入控制（Gatekeeper）、Envoy / Istio 外部授权、Terraform 计划检查，零信任架构中的定位见 [零信任架构](/security/9_zero_trust)。

### 1、Rego v1 策略

OPA 1.0（2024 年 12 月）起 **Rego v1 成为默认语法**：规则体前必须写 `if`、多值规则必须写 `contains`，`in`、`every` 等关键字直接可用，不再需要 `import future.keywords` 或 `import rego.v1`。旧策略可以用 `opa check --v0-v1` 检查、`opa fmt --write --v0-v1` 自动改写。

```rego
package httpapi.authz

default allow := false

# 管理员放行所有请求
allow if "ROLE_ADMIN" in input.user.authorities

# 用户只能读取自己的资料：GET /users/{id}
allow if {
    input.method == "GET"
    input.path == ["users", input.user.id]
}

# 审计员只能在北京时间 9:00–18:00 读取报表
allow if {
    "ROLE_AUDITOR" in input.user.authorities
    input.method == "GET"
    input.path[0] == "reports"
    hour := time.clock([time.now_ns(), "Asia/Shanghai"])[0]
    hour >= 9
    hour < 18
}
```

- `default allow := false`：没有任何规则命中时结果明确为 `false`，而不是「未定义」，调用方不必区分两种情况
- `time.clock` 直接返回 `[时, 分, 秒]` 数组；不传时区时按 **UTC** 计算，国内业务一定要传 `Asia/Shanghai`，否则差 8 小时
- 策略和普通代码一样要写单元测试，用 `opa test` 运行：

```rego
package httpapi.authz_test

import data.httpapi.authz

test_user_reads_own_profile if {
    authz.allow with input as {"method": "GET", "path": ["users", "u1"], "user": {"id": "u1", "authorities": []}}
}

test_user_cannot_read_others if {
    not authz.allow with input as {"method": "GET", "path": ["users", "u2"], "user": {"id": "u1", "authorities": []}}
}
```

### 2、部署方式

| 方式 | 做法 | 适用 |
|------|------|------|
| Sidecar / 本机守护进程 | 每个 Pod 旁跑一个 OPA，服务调 `localhost:8181` | 微服务，延迟最低（亚毫秒级本地调用） |
| 集中式服务 | 独立部署 OPA 集群，所有服务远程调用 | 服务少、可接受一次网络往返 |
| 嵌入式 | Go 程序直接嵌入 OPA 库；Java 可把策略编译成 Wasm 后在进程内执行 | 对延迟极敏感 |

策略通过 **Bundle** 从对象存储或 HTTP 服务定期拉取，各实例保持一致；开启**决策日志**（Decision Logs）把每次 `input` 与结果上报，用于审计和排查「为什么被拒」。

### 3、接入 Spring Security：完整示例

把 OPA 作为 `AuthorizationManager` 挂到 `authorizeHttpRequests` 上，所有请求在进入 Controller 之前统一询问 OPA。OPA 的 Data API 为 `POST /v1/data/<包路径>/<规则名>`，请求体为 `{"input": ...}`，响应为 `{"result": ...}`。

```java
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.function.Supplier;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.security.authentication.AuthenticationTrustResolver;
import org.springframework.security.authentication.AuthenticationTrustResolverImpl;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.authorization.AuthorizationResult;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class OpaAuthorizationManager implements AuthorizationManager<RequestAuthorizationContext> {

    private static final Logger log = LoggerFactory.getLogger(OpaAuthorizationManager.class);

    private final RestClient restClient;
    private final AuthenticationTrustResolver trustResolver = new AuthenticationTrustResolverImpl();

    public OpaAuthorizationManager(@Value("${opa.url:http://localhost:8181}") String opaUrl) {
        HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(200))
            .build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        requestFactory.setReadTimeout(Duration.ofMillis(300));      // 授权在关键路径上，超时要短
        this.restClient = RestClient.builder()
            .baseUrl(opaUrl)
            .requestFactory(requestFactory)
            .build();
    }

    @Override
    public AuthorizationResult authorize(Supplier<? extends Authentication> authentication,
                                         RequestAuthorizationContext context) {
        Authentication auth = authentication.get();
        if (!trustResolver.isAuthenticated(auth)) {                  // null 或匿名用户
            return new AuthorizationDecision(false);
        }

        HttpServletRequest request = context.getRequest();
        String path = request.getRequestURI().substring(request.getContextPath().length());

        // 只放可序列化的简单值，不要把 Principal 对象直接塞进去
        Map<String, Object> input = Map.of(
            "method", request.getMethod(),
            "path", Arrays.stream(path.split("/")).filter(s -> !s.isEmpty()).toList(),
            "user", Map.of(
                "id", auth.getName(),
                "authorities", auth.getAuthorities().stream()
                    .map(GrantedAuthority::getAuthority)
                    .toList()));

        try {
            OpaResponse response = restClient.post()
                .uri("/v1/data/httpapi/authz/allow")
                .body(Map.of("input", input))
                .retrieve()
                .body(OpaResponse.class);
            boolean allowed = response != null && Boolean.TRUE.equals(response.result());
            return new AuthorizationDecision(allowed);
        } catch (RestClientException e) {
            log.warn("OPA 调用失败，按拒绝处理: {}", e.getMessage());
            return new AuthorizationDecision(false);                 // 失败即拒绝（fail closed）
        }
    }

    record OpaResponse(Boolean result) {}
}
```

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain apiFilterChain(HttpSecurity http, OpaAuthorizationManager opa) throws Exception {
        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health/**").permitAll()
                .anyRequest().access(opa))
            .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
            .build();
    }
}
```

- `.access(opa)` 把 OPA 决策挂到 `AuthorizationFilter` 上；Spring Security 7 中 `requestMatchers(String)` 默认使用 `PathPatternRequestMatcher`
- `auth.getName()` 和 `authorities` 的内容取决于 JWT 的映射方式（`sub`、`scope`、角色声明怎么转成 `GrantedAuthority`），见 [Spring Security](/spring/9_security)
- **失败即拒绝**：OPA 不可用时宁可返回 403，也不要放行；同时给 OPA 配健康检查和告警，Sidecar 部署可以把网络失败的概率降到最低
- 这一层只适合「按路径、方法、身份」判断；需要业务数据（订单归属、审批状态）的规则，要么由服务把这些属性放进 `input`，要么通过 Bundle 把数据同步给 OPA，要么在方法级授权里处理（第八节）

---

## 七、jCasbin

Casbin 是一个多语言的授权库，Java 版为 jCasbin（Maven 坐标 `org.casbin:jcasbin`；官方说明自 1.100.0 起 groupId 迁移为 `org.apache.casbin`，包名仍为 `org.casbin.jcasbin`，版本以 Maven Central 为准）。它的特点是**用一个模型文件描述授权模型**，ACL、RBAC、带域的 RBAC、ABAC 都只是不同的模型配置，嵌入在应用进程内执行，不需要额外部署服务。

模型文件 `model.conf`（RBAC + URL 通配匹配）：

```ini
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch2(r.obj, p.obj) && regexMatch(r.act, p.act)
```

策略文件 `policy.csv`（`p` 是权限规则，`g` 是用户与角色的关系）：

```csv
p, admin, /api/orders/*, (GET)|(POST)|(DELETE)
p, staff, /api/orders/*, GET
g, alice, admin
g, bob, staff
```

```java
Enforcer enforcer = new Enforcer("casbin/model.conf", "casbin/policy.csv");

enforcer.enforce("alice", "/api/orders/1001", "DELETE");   // true：admin 允许 DELETE
enforcer.enforce("bob", "/api/orders/1001", "DELETE");     // false：staff 只能 GET
```

- 生产环境用 JDBC 等 Adapter 把策略存进数据库，多实例之间用 Watcher（如基于 Redis）同步策略变更
- 多租户用 RBAC with domains 模型（`g = _, _, _`），同一用户在不同租户里有不同角色，避免角色爆炸
- 和 OPA 的取舍：jCasbin 是进程内库，零网络开销、上手快，适合单个 Java 应用或少量服务；OPA 是独立引擎，适合多语言、多服务、Kubernetes 准入等需要统一策略平台的场景

---

## 八、Spring Security 方法级授权

URL 级授权只能看到路径和身份，涉及具体业务对象的判断放在方法级更合适。Spring Security 7 的方法安全全部基于 `AuthorizationManager`：`@EnableMethodSecurity` 开启后，`@PreAuthorize` 由 `PreAuthorizeAuthorizationManager` 在方法执行前求值；7.0 还新增了 `AuthorizationManagerFactory`，统一创建 `hasRole`、`hasAuthority` 等判定，需要全局修改角色前缀或信任解析器时声明一个该类型的 Bean。

Spring Security 的完整接线代码（加载权限、动态 URL 权限、注解模板）见 [Spring Security](/spring/9_security)。

把三种模型接到方法上：

```java
@Configuration
@EnableMethodSecurity
public class MethodSecurityConfig {

    // RBAC1：角色继承，ADMIN 自动拥有 MANAGER 和 STAFF 的权限
    @Bean
    static RoleHierarchy roleHierarchy() {
        return RoleHierarchyImpl.withDefaultRolePrefix()
            .role("ADMIN").implies("MANAGER")
            .role("MANAGER").implies("STAFF")
            .build();
    }

    // 让 @PreAuthorize 中的 hasRole 也认角色继承
    @Bean
    static MethodSecurityExpressionHandler methodSecurityExpressionHandler(RoleHierarchy roleHierarchy) {
        DefaultMethodSecurityExpressionHandler handler = new DefaultMethodSecurityExpressionHandler();
        handler.setRoleHierarchy(roleHierarchy);
        return handler;
    }
}

@Service
public class DocumentService {

    // RBAC：权限码
    @PreAuthorize("hasAuthority('document:create')")
    public void create(DocumentCreateCmd cmd) { /* ... */ }

    // ABAC / ReBAC：复杂判断委托给 Bean，Bean 内部可以查业务库、调 OPA 或 OpenFGA
    @PreAuthorize("@documentAuthz.canEdit(#documentId, authentication)")
    public void edit(Long documentId, DocumentEditCmd cmd) { /* ... */ }
}

@Component("documentAuthz")
public class DocumentAuthorization {

    private final DocumentRepository documents;

    public DocumentAuthorization(DocumentRepository documents) {
        this.documents = documents;
    }

    public boolean canEdit(Long documentId, Authentication auth) {
        return documents.findById(documentId)
            .map(doc -> doc.ownerId().equals(auth.getName())
                     || doc.editorIds().contains(auth.getName()))
            .orElse(false);
    }
}
```

- 方法级授权基于代理，**同类内部调用不生效**；`#documentId` 按参数名引用，依赖 `-parameters` 编译参数（Spring Boot 构建插件默认开启）
- `@PostAuthorize` 在方法执行后判断，只适合只读方法；`@PostFilter` 在内存中过滤集合，大数据量要用数据权限在 SQL 层过滤
- `@PreAuthorize` 的更多写法（权限注解模板、动态 URL 权限的 `AuthorizationManager` 实现）见 [Spring Security · 方法级权限](/spring/9_security)

---

## 小结

- RBAC 按角色授权，RBAC0 是核心，RBAC1 加继承，RBAC2 加职责分离约束，RBAC3 两者兼有；角色名里编进组织、地区等维度会导致角色爆炸，应把这些维度改为属性
- ABAC 用主体、资源、操作、环境属性和策略表达式决策，粒度最细但可审计性差，适合集中到策略引擎维护
- ReBAC 把权限建模成关系图，权限沿关系传递，适合文档分享、组织树和多租户，代价是要同步关系数据
- 实际系统通常组合使用：RBAC 管功能权限，ABAC 管条件与数据权限，ReBAC 管对象级分享
- OPA 1.0 起默认 Rego v1，`if` / `contains` 必写；接入 Spring Security 时作为 `AuthorizationManager`，超时要短并且失败即拒绝；`time.clock` 默认 UTC
- jCasbin 用模型文件切换 ACL / RBAC / ABAC，适合进程内授权；方法级授权用 `@PreAuthorize` 委托 Bean 处理业务对象判断

权限系统在分布式架构中的部署（PEP / PDP / PAP / PIP 分工、网关与服务的鉴权边界、权限缓存刷新、数据权限 SQL 拦截）见 [权限系统架构设计](/architecture/6_access_control)。

---

## 参考资料

- NIST RBAC 项目与标准：[Role Based Access Control - NIST CSRC](https://csrc.nist.gov/projects/role-based-access-control)
- NIST ABAC 指南：[SP 800-162 Guide to Attribute Based Access Control (ABAC) Definition and Considerations](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)
- XACML 规范：[eXtensible Access Control Markup Language (XACML) Version 3.0](https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html)
- Zanzibar 论文：[Zanzibar: Google's Consistent, Global Authorization System（USENIX ATC 2019）](https://www.usenix.org/conference/atc19/presentation/pang)
- OpenFGA 概念：[OpenFGA Concepts](https://openfga.dev/docs/concepts)
- OpenFGA 项目状态：[CNCF - OpenFGA](https://www.cncf.io/projects/openfga/)
- SpiceDB 文档：[AuthZed Docs](https://authzed.com/docs)
- Rego 语言：[OPA Policy Language](https://www.openpolicyagent.org/docs/policy-language)
- Rego v0 升级到 v1：[Upgrading to OPA v1.0](https://www.openpolicyagent.org/docs/v0-upgrade)
- OPA 时间函数：[Time Built-in Functions](https://www.openpolicyagent.org/docs/policy-reference/builtins/time)
- OPA REST API：[OPA REST API](https://www.openpolicyagent.org/docs/rest-api)
- Casbin 文档：[Casbin Overview](https://casbin.org/docs/overview)、[jCasbin](https://github.com/casbin/jcasbin)
- Spring Security 授权架构（`AuthorizationManager`、`AuthorizationManagerFactory`、角色继承）：[Authorization Architecture](https://docs.spring.io/spring-security/reference/servlet/authorization/architecture.html)
- Spring Security 方法安全：[Method Security](https://docs.spring.io/spring-security/reference/servlet/authorization/method-security.html)

> 下一篇：[API 安全](./6_api_security)

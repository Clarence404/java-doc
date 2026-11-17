---
description: 租户上下文与强制过滤、组合外键、受控系统通道、组织模型、角色绑定与 SQL 范围、会话吊销与邮件邀请
---

# 多租户与授权

> 前置阅读：[平台实战概览](./0_intro)、[设备接入与鉴权](./1_access)、[权限模型：RBAC 与 ABAC](/security/5_rbac_abac)

多租户平台里最贵的缺陷是「A 看到了 B 的数据」，Conduit 把租户当作安全与资源边界，再在租户内用项目、站点划出授权范围。本篇讲租户上下文与强制过滤、组织模型、角色绑定与 SQL 数据范围、会话吊销与邮件邀请，以及越权测试，基线为 JDK 21、Spring Boot 3.5。

---

## 一、本篇做什么

这部分是分四步做出来的，每一步解决一个问题：

| 版本 | 问题 | 做法 |
|------|------|------|
| V0.2-C | 多个客户共用一套平台，数据怎么分开，谁来管租户 | `tenant_id` 列 + 租户拦截器；平台管理员、租户管理员、只读用户三种角色；进入租户代为操作 |
| V0.3-A | 漏写一个条件就越权，靠自觉不够 | 租户组合外键、跨租户查询收口到受控系统通道、一事务一租户、越权测试套件 |
| V0.3-B1 / B2 | 一个租户里也要分「谁能动哪些设备」 | 客户、项目、站点、资产组织模型；权限目录、五个预置角色、自定义角色、三级绑定、SQL 数据范围 |
| V0.3-B3 | 撤权、禁用要立刻生效；新成员怎么加入 | 服务端会话与授权版本；一次性邮件邀请 |

![租户内组织模型与角色绑定的三级范围](../../assets/iot/conduit-tenant-scope.svg)

RBAC 的模型本身（用户、角色、权限、数据范围）见 [权限模型：RBAC 与 ABAC](/security/5_rbac_abac)，一套权限系统该有哪些表和模块见 [权限系统架构设计](/architecture/6_access_control)。本篇只讲这些模型落到一个多租户 IoT 平台上时做了哪些取舍。

---

## 二、租户是什么边界

先把词定死，后面所有设计都从这几句话推出来：

- **租户（tenant）是合同、计费、资源与安全边界**。两个租户之间默认什么都不共享
- **客户（customer）是租户内的业务归类，不是子租户**。一家运维公司（租户）服务十个业主（客户），业主之间的隔离靠项目授权，而不是再套一层租户
- **产品是租户级共享模板**，租户内所有项目共用；设备才有归属

几条账号规则，都由代码和数据库约束保证：

| 规则 | 取值 |
|------|------|
| 租户编码 | `^[a-z][a-z0-9-]{1,31}$`，创建后不可修改 |
| 用户名 | 3～32 位，字母开头，全平台唯一，所以登录不用选租户 |
| 密码 | 8～64 位，含字母和数字，BCrypt 存储 |
| 平台管理员 | `tenant_id` 为空，由数据库约束保证；不属于任何租户 |
| 默认租户 `default` | 不能停用或删除 |
| 删除租户 | 要求先没有产品和设备，用户随之删除 |

**停用租户**是一个需要想清楚数据面的动作，不只是「不让登录」：

- 用户登录与续期被拒
- 清掉该租户设备的身份缓存，之后 MQTT 鉴权拒绝该租户的设备
- 已经连着的设备继续上报的数据进死信，原因 `TENANT_DISABLED`

---

## 三、租户上下文与强制过滤

### 1、上下文：一个线程变量

每个 HTTP 请求由 `JwtAuthFilter` 从令牌里取出租户并绑定到当前线程；后台任务没有请求，必须显式绑定：

```java
// 以指定租户执行，结束后恢复调用前的绑定（支持嵌套）
TenantContext.callAs(tenantId, () -> deviceMapper.selectList(null));

// 取当前租户；未绑定时抛 IllegalStateException
long tenantId = TenantContext.require();
```

源码：[`TenantContext`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/tenant/TenantContext.java)。

### 2、过滤：MyBatis-Plus 租户拦截器

业务表都带 `tenant_id`，拦截器给每条 SQL 自动补上条件：

```java
/** 不按租户过滤的表：租户表本身，以及登录时需要全局查找的用户表。 */
static final Set<String> TENANT_FREE_TABLES = Set.of("tenant", "app_user");

interceptor.addInnerInterceptor(new TenantLineInnerInterceptor(new TenantLineHandler() {
    @Override
    public Expression getTenantId() {
        return new LongValue(TenantContext.require());      // 没绑定租户：直接抛异常
    }

    @Override
    public boolean ignoreTable(String tableName) {
        return TENANT_FREE_TABLES.contains(tableName);
    }
}));
```

关键在 `require()`：**没有租户上下文时不是「查全部」，而是直接失败**。忘了绑定租户的后台任务会在第一条 SQL 上报错，而不是悄悄读到所有租户的数据。这是「失败关闭」，整篇里会反复出现。

两张不过滤的表各有原因：`tenant` 是租户表本身；`app_user` 登录时要按全平台唯一的用户名查找。代价是**按租户查用户必须显式带 `tenant_id`**，这一条靠代码评审和越权测试守。

连加锁语句也要确认。`select id from product where id = ? for update` 经拦截器改写后是：

```sql
select id from product where id = ? and tenant_id = 5 for update
```

`ProductLockTenantSqlIT` 抓取最终的预编译 SQL，断言租户条件在 `FOR UPDATE` 之前。

---

## 四、数据库兜底：租户组合外键

拦截器管的是「读写哪一行」，管不了「这一行指向谁」。如果租户 A 的设备行里 `product_id` 填了租户 B 的产品 ID，每条 SQL 都带着正确的 `tenant_id`，数据却已经串了。

做法是把外键从 `(product_id)` 改成 `(tenant_id, product_id)`，让数据库拒绝跨租户关联（Flyway V5）：

```sql
alter table product
    add constraint uk_product_tenant_id unique (tenant_id, id);

alter table device
    drop constraint device_product_id_fkey;
alter table device
    add constraint fk_device_product
        foreign key (tenant_id, product_id) references product (tenant_id, id);
```

- **先加 `(tenant_id, id)` 唯一约束**：组合外键必须引用一个唯一键
- **子行的 `tenant_id` 必须与父行一致**：这句话不再是约定，是数据库约束
- 后来的组织表、角色绑定表全部照这个写法，例如站点引用项目是 `(tenant_id, project_id)`，角色绑定引用站点是 `(tenant_id, project_id, site_id)`

迁移前做了两件事，都记在 [租户隔离测试报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-22-tenant-isolation.md) 里：到真实库的 `pg_constraint` 里查出旧外键的实际名字，而不是按 PostgreSQL 的默认命名规则去猜；先跑两条脏数据查询（子行与父行租户不一致），确认是 0 行再迁移，没有发现就不做「静默清理」。

---

## 五、受控系统通道

有些查询天生跨租户：设备连上来时只带着全局唯一的 `deviceKey`，鉴权回调要先查到它才知道是哪个租户的；平台首页要统计所有租户。完全禁止跨租户做不到，能做的是**让跨租户查询只有一条路，而且这条路很显眼**。

三条规则：

1. **跨租户 Mapper 只能放在 `tenant.system` 包**，方法上标注 `@InterceptorIgnore(tenantLine = "true")`。例如按全局 `deviceKey` 查可信设备身份的 `DeviceIdentityMapper`，一条 SQL 关联设备、产品、租户三张表，把租户 id 与租户状态一起带出来

2. **调用必须经 `TenantContext.callAsSystem(purpose, …)`**。系统模式会清掉当前租户，于是普通 Mapper 因为缺少租户上下文立即失败，只有上面那个包里显式豁免的 Mapper 能执行；每次进入记一行 INFO，写明用途，不记查询参数

3. **一个事务只服务一个租户**。活跃事务已经绑定了租户之后，不许切到别的租户，也不许进系统模式，`TenantContext` 在切换前检查并抛出 `IllegalStateException`

第 1 条靠架构测试守：`InterceptorIgnoreArchitectureTest` 扫描源码，`@InterceptorIgnore` 只允许出现在 `tenant.system` 包里。谁在业务包里加一个豁免注解，构建就红。

---

## 六、Redis 与 InfluxDB：先过 PostgreSQL

最新值、在线状态在 Redis，历史数据在 InfluxDB，它们没有租户拦截器。这里没有给 Redis 键加租户前缀，而是定了一条访问规则：

> 访问 Redis 或 InfluxDB 之前，必须先经受租户过滤的 PostgreSQL 查询拿到设备，再用查出来的 `deviceKey` 去读写；禁止直接用请求参数里的 `deviceKey`。

`deviceKey` 全局唯一，所以只要「拿到 `deviceKey`」这一步过了租户过滤，后面的键就不会指向别人的数据。请求 `GET /devices/{别人的 deviceKey}/latest` 时，第一步的 PostgreSQL 查询就查不到，返回 404，根本走不到 Redis。

唯一的平台级例外是设备身份缓存 `conduit:auth:{deviceKey}`：设备上报时还不知道租户。规则是缓存的身份必须携带可信的 `tenantId`，后续处理只采用这个值，不信任报文里的任何租户信息。

这条规则的弱点也要说清楚：它是约定加测试，不是存储层的强制。Redis 键与 InfluxDB 标签里的隔离全靠应用访问路径正确。

---

## 七、为什么不用行级安全

V0.3-A 原本的计划是「PostgreSQL 行级安全（RLS）或等价的数据库强制隔离」。评估后的决定是**不采用 RLS**，维持「`tenant_id` 列 + 拦截器 + 组合外键 + 受控系统通道」。取舍写得很直接：

| | 应用层方案（现状） | RLS |
|---|---|---|
| 谁来拦 | MyBatis-Plus 拦截器 | 数据库 |
| 不经过 MyBatis 的访问（原生 JDBC、数据库工具直连） | 不拦 | 拦 |
| 换数据库 | 可迁移 | PostgreSQL 专属 |
| 连接池 | 无额外要求 | 每次取连接要设置会话变量，忘了重置就是事故 |

也就是说，隔离保证全部留在应用层：持有数据库凭据直连 SQL 的人，数据库不会替应用拦。这是明确接受的代价，不是没想到。

重新评估的触发条件当时写了三条：出现一条真实的跨租户泄露；引入不经过 MyBatis 的数据访问路径；多人协作开发或业务表超过 10 张。组织与授权做完后业务表超过了 10 张，按约定重评了一次，结论仍是不引入，并且定下来「不再定期重提，唯一的触发条件是出现真实的跨租户泄露」。RLS 是纯叠加能力，将来要加不会让现在的东西返工。

---

## 八、平台管理员与代入

平台管理员不属于任何租户，平时只能用 `/api/v1/platform/**` 管理租户。要帮某个租户排查问题时，「进入租户」：

| 动作 | 接口 | 行为 |
|------|------|------|
| 进入 | `POST /platform/tenants/{code}/enter` | 签发带 `tid` 与 `imp`（代入标记）的令牌；停用的租户返回 409 |
| 退出 | `POST /auth/exit-tenant` | 换回平台管理员自己的令牌 |
| 续期 | 刷新令牌 | 目标租户已停用或删除时，退回平台管理员自己的令牌 |

几个边界：

- **代入令牌不能访问平台接口**。进了租户就是租户内的身份，不能两头通吃
- **代入期间的权限每次请求重新解析**，按该租户的所有者范围计算，不沿用进入那一刻的快照
- **代入期间不能改密码**
- **留痕**：进入与退出各记一行 INFO；代入期间每个写请求（POST / PUT / DELETE / PATCH）由 `ImpersonationLogFilter` 在完成后记一行 INFO，被拒绝的写请求同样记，但不记请求体和查询串
- **前端固定显示提示条**「正在以平台管理员身份操作租户：XX」，避免忘了自己在别人的租户里

目前的留痕只是应用日志，不是可查询、可导出的审计记录，见文末「已知限制」。

---

## 九、租户内的组织模型

一个租户里的设备可能属于不同业主、不同园区，需要一个「按什么划分授权」的骨架（Flyway V6）：

| 对象 | 含义 | 约束 |
|------|------|------|
| 客户 `customer` | 业务归类 | 可选；不是授权范围 |
| 项目 `project` | **主要授权范围** | 可选关联一个客户 |
| 站点 `site` | 物理位置，带时区 | 必属一个项目 |
| 资产 `asset` | 站点里的设备组、产线、楼层 | 必属一个站点；父子必须同站点，禁止成环，最多 8 层 |
| 设备 `device` | — | 必属一个站点；可选关联同站点的资产 |

- **每个租户有一个不可删除的默认项目与默认站点**。V6 迁移为存量租户各建一对，并把存量设备归入默认站点；新建租户在同一个事务里创建这两者。部分唯一索引保证每个租户只有一个默认项目：

  ```sql
  create unique index uk_project_tenant_default on project (tenant_id) where is_default;
  ```

- **老客户端不传站点也能建设备**：回退到默认站点
- **跨租户、跨站点的关联由组合外键拒绝**：设备挂到别的站点的资产上，数据库直接报错
- **Redis 键与 InfluxDB 标签不含组织维度**。设备换站点只改 PostgreSQL 一行，历史数据不用搬；代价是按项目聚合遥测要先查出设备列表
- **停用项目或站点不阻断设备遥测**，只拒绝其中设备与资产的管理操作。数据面不该因为一个管理状态丢数据

B1 交付时还出过一次「只交了数据库和接口，没有页面入口」的遗漏，被指出后补上了组织管理页面，[测试报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-v0.3b-b1-organization.md) 里照实记着；之后项目多了一条规矩：每个新功能必须带可操作的演示数据和入口。

---

## 十、权限目录、角色与绑定

### 1、权限目录

权限码是代码里一个不可变的集合，形如 `资源.动作`：

```java
public static final Set<String> ALL = Set.of("tenant.read", "tenant.manage", "member.read", "member.manage",
        "role.manage", "customer.read", "customer.manage", "project.read", "project.manage", "project.member.manage",
        "site.read", "site.manage", "asset.read", "asset.manage", "product.read", "product.manage",
        "device.read", "device.manage", "device.secret.rotate", "device.command", "telemetry.latest.read",
        "telemetry.history.read", "telemetry.replay", "audit.read", "audit.export");
```

目录里预留了设备命令、审计、重放的权限码，不代表对应的租户接口已经开放。源码：[`PermissionCatalog`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/authorization/PermissionCatalog.java)。

### 2、五个预置角色

| 角色 | 可绑定的范围 | 能力 |
|------|-------------|------|
| `TENANT_OWNER` 租户所有者 | 租户 | 全部权限，管理所有者绑定 |
| `TENANT_ADMIN` 租户管理员 | 租户 | 除 `tenant.manage`、`telemetry.replay` 外的全部；不能变更所有者 |
| `PROJECT_ADMIN` 项目管理员 | 项目 | 管理项目内站点、资产、设备与项目成员；不能改共享产品或租户用户 |
| `OPERATOR` 运维人员 | 项目 / 站点 | 查看范围内资源，管理设备、重置设备密钥 |
| `VIEWER` 只读成员 | 租户 / 项目 / 站点 | 只读范围内资源与遥测 |

预置角色的权限写死在代码里，不可编辑。

### 3、自定义角色

租户管理员可以建自定义角色，规则都是为了堵提权：

- 角色键必须以 `CUSTOM_` 开头，只能选权限目录里的权限码
- **不能授予自己没有的权限**
- `tenant.manage` 只属于内置的所有者角色
- 有绑定的角色不能删除；停用后绑定保留，但权限从下一次请求起失效
- 修改角色可用的范围时，若已有不兼容的绑定，返回 409

### 4、三级绑定

权限不是直接给用户，而是「用户 + 角色 + 范围」的一条绑定（Flyway V8）：

```sql
create table role_binding (
    -- 省略 id、tenant_id、user_id、role_id、scope_type、project_id、site_id 的列定义
    foreign key (tenant_id,user_id) references app_user(tenant_id,id) on delete cascade,
    foreign key (tenant_id,role_id) references role_definition(tenant_id,id),
    foreign key (tenant_id,project_id) references project(tenant_id,id),
    foreign key (tenant_id,project_id,site_id) references site(tenant_id,project_id,id),
    check ((scope_type='TENANT' and project_id is null and site_id is null)
        or (scope_type='PROJECT' and project_id is not null and site_id is null)
        or (scope_type='SITE' and project_id is not null and site_id is not null))
);
```

- **范围与列的对应关系由 `check` 约束保证**：租户级绑定不能带项目，站点级绑定必须同时带项目与站点
- **四条组合外键**：用户、角色、项目、站点都必须和绑定在同一个租户，站点还必须属于指定的项目
- **多条绑定取并集**：同一个人可以是项目 A 的项目管理员、项目 B 的只读成员
- **替换是全量、原子的**：`PUT /users/{username}/bindings` 最多 100 条，有一条非法就整体拒绝，原绑定保留

**所有者保护**：至少保留一名启用的所有者。撤销、降级、禁用、删除最后一个所有者都会被拒绝，检查在租户行锁内串行执行，两个并发请求不可能各撤一个把所有者撤光。

**项目成员委派**：项目管理员可以在「组织 → 项目 → 成员」给租户内已有账号分配本项目或其下站点的角色，但只能委派自己在这个项目里已有的权限，不能动租户级或其他项目的绑定，也不能操作租户管理员与所有者。

---

## 十一、执行链：从路径到 SQL

```text
请求 → JwtAuthFilter（身份、租户、会话）→ PermissionGateFilter（路径 → 权限码）
     → AuthorizationService（回源 PostgreSQL 解析绑定）→ 租户 / 范围 / 分页拦截器（改写 SQL）
```

### 1、路径到权限码：集中登记，未知入口拒绝

`PermissionGateFilter` 是「路径 → 权限码」的唯一映射：

```java
if (path.startsWith("/api/v1/devices/")) {
    if (path.endsWith("/latest"))       return "telemetry.latest.read";
    if (path.endsWith("/history"))      return "telemetry.history.read";
    if (path.endsWith("/reset-secret")) return "device.secret.rotate";
    // ……
}
```

- **没登记的业务入口返回一个不可授予的哨兵码**，也就是默认拒绝。新加一个接口忘了登记，结果是谁都访问不了，而不是谁都能访问
- 测试 `AuthorizationIT#everyExistingBusinessRouteHasRegisteredPermission` 遍历当前所有业务路由，确认每一条都有登记
- **资源越权返回 404，集合与动作越权返回 403**。直接访问一台无权设备的详情、最新值、历史或重置密钥都是 404：不向调用方透露「这个资源存在，只是你没权限」

### 2、数据范围：写进 SQL，而不是查出来再过滤

列表、计数、详情、写入都在 SQL 里限制范围。实现是 MyBatis-Plus 的数据权限拦截器：从请求内的权限快照生成一段条件，解析成表达式后追加到 SQL 上；这段条件解析失败时直接抛异常，也是失败关闭。

一个在项目 12 有项目级绑定、在站点 31 有站点级绑定的用户查设备列表，SQL 会被追加上：

```sql
device.site_id in (
  select azs.id from site azs
  where azs.tenant_id = 5 and (azs.project_id in (12) or azs.id in (31))
)
```

- **只用数据库里读到的数字 ID 拼条件**，不用请求里的任何字符串，所以这段拼接没有注入面
- **子查询显式带租户**，不依赖外层拦截器
- **没有任何绑定时 ID 集合是 `-1`**，条件恒假，而不是把条件省掉
- **总数与列表一致**：因为条件在 SQL 里，分页的 `total` 不会把无权的设备算进去。「查出来再过滤」做不到这一点，页大小和总数都会露出别人有多少数据
- 设备与资产的写操作还会追加「所在站点与项目必须是启用状态」，这就是停用站点后设备只读的实现

源码：[`AuthorizedScope`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/authorization/AuthorizedScope.java)、[`ScopeDataPermissionHandler`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/authorization/ScopeDataPermissionHandler.java)。

### 3、每次请求回源

权限每个请求直接读 PostgreSQL，没有 Redis 权限缓存：

- 撤权在下一个请求就生效
- 不存在「Redis 挂了，权限怎么算」这个问题，也就不存在故障时放行的路径
- 代价是每个业务请求多几条查询。管理接口的流量远小于设备上报，设备上报链路不走用户授权，所以这个代价目前可以接受

响应里还带一份 `permissions`，前端据此显示行内按钮（只读身份是隐藏而不是禁用）。菜单和按钮只是提示，实际拦截全在后端。

---

## 十二、发布开关与兼容迁移

给一个已经在跑的系统换授权模型，最怕的是「一升级，有人突然没权限了，或者突然多了权限」。这里用了一个三态开关 `CONDUIT_AUTHORIZATION_MODE`：

| 模式 | 行为 | 用途 |
|------|------|------|
| `shadow`（默认） | 仍按旧角色放行，只用新内核算一遍，把「新模型会拒绝」的请求记成日志 `Authorization shadow denied`；不装载 SQL 数据范围 | 切换前观察 |
| `enforce` | 新权限码与 SQL 范围正式生效，未知业务入口默认拒绝 | 正式执行 |
| `read-only` | 保留新的数据范围，拒绝业务写入 | 故障保护 |

- **`shadow` 不是安全回退**：它等于旧的全租户权限。已经依赖范围授权之后再退回 `shadow` 或回滚旧版应用，会让项目成员恢复全租户可见
- **`read-only` 才是保护开关**：出问题时收紧，而不是放开
- **非法取值启动失败**，不会默认降级成全权

旧账号怎么过渡？迁移没有「一次性给所有旧用户生成绑定」，而是加了一个显式的接管标志 `authz_managed`：

- `authz_managed = false`：按数据库里当前的旧角色给兼容权限。最早创建且启用的管理员视为所有者，其他管理员是租户管理员，旧只读用户是租户级只读
- 保存绑定时在同一事务内置为 `true` 并替换全部绑定。此后**空绑定就是没有权限**，不会回落成旧的全租户只读

为什么不在迁移里一次生成：启动时自动创建的管理员可能晚于 Flyway 执行，新建账号也要有兼容路径；用显式标志区分「兼容中」与「已接管」，既不会让迁移后新增的管理员没有授权，也不会让撤权后旧角色复活。

升级步骤：先备份 PostgreSQL → 升级应用执行 V8 → `shadow` 下看日志 → 改 `enforce` 并重建 server 容器。迁移只加表加列，不删旧的 `app_user.role`，也不做破坏性的回退迁移。

---

## 十三、会话与邀请

### 1、可吊销的会话

V0.2-C 的登录是纯 JWT：access 令牌 15 分钟，禁用用户、改角色要等对方下次续期才生效，最长 15 分钟。授权细化之后这个窗口不能接受了——撤掉一个人的项目权限，他还能再操作 15 分钟。JWT 的结构与无状态的代价见 [JWT 令牌机制](/security/1_jwt)。

B3 的做法是 JWT 不变，旁边加服务端状态（Flyway V9）：一张 `user_session` 表（会话 ID、用户、refresh 令牌的哈希、过期与吊销时间），以及 `app_user.authz_version` 授权版本列。

- 令牌里带会话 ID `sid` 与授权版本 `av`。每个请求用 `user_session` 与 `app_user.authz_version` 校验
- **禁用账号、改权限、登出、撤销会话，在下一个请求就失效**（返回 401）；重新登录后按新权限访问，资源越权仍是 404
- **refresh 令牌只存 SHA-256**，同一会话每次刷新原子轮换，旧的 refresh 再用返回 401
- 改密码会吊销全部旧会话并新建一个；进入、退出租户沿用同一个会话
- 用户在「个人设置 → 登录会话」能看到自己的会话，可以退出单条或全部
- 生产环境拒绝不带 `sid` 的旧令牌，所以升级后所有人要重新登录一次

把会话放到服务端的各种做法见 [分布式会话](/distributed/5_session)。

### 2、一次性邮件邀请

- **只存令牌的 SHA-256**（Flyway V10 的 `token_hash char(64) not null unique`），库里没有链接也没有明文令牌，日志也不输出
- 48 小时过期，可撤销，只能接受一次
- 经 `InvitationNotificationChannel` 发送，第一个实现是 SMTP。**邮件发不出去就回滚**：创建邀请时必须找到通道、配置了公开地址并且发送成功，否则返回 503，数据库里的邀请记录一并回滚，不会留下一条「对方永远收不到」的邀请
- 演示环境用 Mailpit 收件；正式环境换成受控的 SMTP 与 HTTPS 的公开地址
- **邀请只支持租户管理员、只读成员两种角色，这是最终形态**。需要项目或站点级范围的成员，接受邀请后由管理员到用户页配置。邀请里带完整范围角色的方案评估后决定不做

几项明确决定不做的：租户级密码策略、密码历史与过期、失败锁定、MFA，都不实施，也不预留字段。由此留下一个要直说的缺口：**登录失败目前不限流**。

---

## 十四、跨租户与越权测试

隔离做没做对，只能靠「以攻击者的身份去试」来证明。测试都用 Testcontainers 起真实的 PostgreSQL。

**跨租户**（`CrossTenantApiIT`）：租户 A 对租户 B 的产品、属性、物模型、设备、最新值、历史、重置密钥和用户的写操作全部返回 404；列表不含 B 的资源；概览计数只算 A；用 B 的产品给 A 建设备返回 404。

**数据库约束**（`TenantScopedForeignKeyIT`、`OrganizationModelIT`）：绕过应用直接插入跨租户、跨站点的关联行，被 PostgreSQL 拒绝。

**范围授权**（`AuthorizationIT`）。同一个账号在项目 A 是项目管理员、B 是只读、C 没有绑定：

| 检查 | 期望 |
|------|------|
| 设备分页 | `total` = 2，C 的设备不在列表 |
| A 的设备 | 可写 |
| B 的设备 | 读 200；写入与重置密钥 404 |
| C 的设备 | 详情、归属、最新值、历史全部 404 |
| 共享产品 | 可读，但看不到无权设备的数量；不能修改 |
| 站点级运维 | 只看到指定站点，不因同项目有别的站点而扩大 |
| 清空绑定后用原令牌再请求 | 立即被拒，不回落成旧的全租户只读 |
| 撤销最后一个所有者 | 拒绝 |
| 跨租户绑定 | 404；直接插库被组合外键拒绝 |
| 非法的批量替换 | 整体失败，原绑定保留 |
| 平台代入令牌访问平台接口 | 拒绝 |

**可复现的演示**。[`deploy/demo/authorization-demo.py`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/demo/authorization-demo.py) 通过正式 API 建出 A / B / C 三个项目和两个演示账号，带 `--verify` 时在 `enforce` 模式下实测「A 可写、B 写入 404、C 不可见、用户管理 403」。脚本幂等：重跑不覆盖已有账号的密码、状态和人工授权；口令只从环境变量读，不进仓库。

有一处测试上的教训值得记：B3 上线后首轮回归有 6 条旧测试失败。旧测试在撤权后继续拿着同一个 access 令牌，期待资源级的 404；新规则是先拒绝这个旧令牌、返回 401。处理方式是保留「立即失效」的规则，把测试改成先断言旧令牌 401、再重新登录检查范围，没有放宽失效断言。

---

## 十五、验证

| 结论 | 测试 / 报告 | 类型 |
|------|------------|------|
| 没绑定租户时查询失败；系统模式清除并恢复绑定；事务中不能切租户或进系统模式 | [`TenantContextTest#systemModeClearsAndRestoresNestedBindings`、`#activeTransactionCannotSwitchTenantOrEnterSystemMode`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/TenantContextTest.java) | 单元 |
| 拦截器豁免只存在于系统包 | [`InterceptorIgnoreArchitectureTest#interceptorIgnoreOnlyExistsInSystemPackage`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/InterceptorIgnoreArchitectureTest.java) | 架构 |
| 加锁语句的租户条件在 `FOR UPDATE` 之前 | [`ProductLockTenantSqlIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/ProductLockTenantSqlIT.java) | 集成 |
| 数据库拒绝跨租户的设备与属性关联 | [`TenantScopedForeignKeyIT#rejectsCrossTenantDeviceAndPropertyButAcceptsSameTenantRows`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/TenantScopedForeignKeyIT.java) | 集成 |
| 另一个租户的产品、设备、用户资源全部不可见 | [`CrossTenantApiIT#foreignProductDeviceAndUserResourcesAreHidden`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/CrossTenantApiIT.java) | 接口 |
| 代入只写目标租户并留痕；代入令牌不能用平台接口；被拒的写请求记日志但不含请求体 | [`ImpersonationIT#entersWritesOnlyTheTargetTenantAndLogsWrites`、`#impersonationTokensCannotUseThePlatformApi`、`#rejectedImpersonatedWritesAreLoggedWithoutBodyOrQuery`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/platform/ImpersonationIT.java) | 接口 |
| 停用租户阻止登录并清设备身份缓存；默认租户不能停用或删除 | [`PlatformTenantApiIT#disablingBlocksLoginAndEnablingRestoresIt`、`#disablingEvictsTheDeviceIdentityCache`、`#theDefaultTenantCannotBeDisabledEnabledOrDeleted`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/platform/PlatformTenantApiIT.java) | 接口 |
| 每个租户恰有一个默认项目与站点；跨租户、跨站点关联被拒 | [`OrganizationModelIT#everyMigratedTenantHasOneDefaultProjectAndSite`、`#rejectsCrossTenantAndCrossSiteRelationships`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/organization/OrganizationModelIT.java) | 集成 |
| 范围过滤覆盖列表、计数与设备的全部入口 | [`AuthorizationIT#scopeFiltersListsCountsAndAllDeviceEntrypoints`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/AuthorizationIT.java) | 接口 |
| 撤权立即生效且不回落旧角色；不能撤最后一个所有者 | [`AuthorizationIT#revokeIsImmediateAndNoLegacyViewerFallback`、`#cannotMoveIntoUnauthorizedSiteOrRevokeLastOwner`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/AuthorizationIT.java) | 接口 |
| 自定义角色可绑定、停用，解绑后才能删；项目管理员只能委派本项目 | [`AuthorizationIT#customRoleCanBeBoundDisabledAndDeletedOnlyAfterUnbind`、`#projectAdminDelegatesOnlyOwnProjectWithoutTenantEscalation`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/AuthorizationIT.java) | 接口 |
| 每条业务路由都登记了权限；未知路由失败关闭；`shadow` 的拒绝不改变旧结果 | [`AuthorizationIT#everyExistingBusinessRouteHasRegisteredPermission`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/AuthorizationIT.java)、[`PermissionGateFilterTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/PermissionGateFilterTest.java) | 接口 + 单元 |
| `read-only` 下管理员可读不可写，返回的权限里没有写操作 | [`AuthorizationReadOnlyIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/authorization/AuthorizationReadOnlyIT.java) | 接口 |
| 撤销一个会话只让它的令牌失效；登出与授权版本变化立即失效 | [`SessionIT#revokingOneSessionInvalidatesItsAccessTokenButLeavesAnotherSessionActive`、`#logoutAndAuthorizationVersionInvalidateAccessImmediately`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/auth/SessionIT.java) | 接口 |
| 邀请只能接受一次；撤销或过期后不能接受 | [`InvitationIT#invitationIsDeliveredAndCanBeAcceptedOnce`、`#revokedAndExpiredInvitationsCannotBeAccepted`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/auth/InvitationIT.java) | 接口 |

各阶段的完整回归与演示环境验收见测试报告：[租户隔离](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-22-tenant-isolation.md)、[组织骨架](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-v0.3b-b1-organization.md)、[授权内核](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-authorization-kernel.md)、[自定义角色与项目成员](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-custom-roles-project-members.md)、[身份治理](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-identity-governance.md)。

---

## 十六、已知限制与还没做的

**现状的限制**：

- **隔离只在应用层**。持有数据库凭据直连 SQL、或将来引入不经过 MyBatis 的访问路径，数据库不会替应用拦；Redis 与 InfluxDB 的隔离靠「先过 PostgreSQL」这条约定
- **默认模式是 `shadow`**。新部署不改开关的话，细粒度授权只是在观察，实际生效的仍是旧的租户管理员 / 只读两级
- **没有持久化审计**。代入、授权变更、管理操作只记应用日志（操作者、租户、目标、条数，不记请求体），不能查询、导出，也没有保留策略
- **登录失败不限流**，没有锁定与 MFA（已决定不实施）
- **邀请邮件的真实投递只在演示环境用 Mailpit 验证过**，没有接过真实的 SMTP 服务
- **权限每请求回源 PostgreSQL**，没有做过管理接口高并发下的压测
- **安全测试通过不等于证明了所有攻击路径都不通**。测试覆盖的是已经想到的路径

**路线图里还没做的**（[roadmap](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md) 的 V0.3 子项目）：

| 子项目 | 内容 | 状态 |
|--------|------|------|
| B4 持久化审计 | 全量审计日志、操作人与代入人追踪、导出与保留策略 | 未做 |
| C 租户生命周期控制面 | 创建、分配、暂停、恢复、注销的幂等可审计状态机；保留区域 / 集群 / 存储路由字段；生产与演示两种启动模式 | 未做 |
| D 计量与配额 | 先定计量事件、单位、去重键、时间窗口，再做设备数、用户数、消息速率、存储保留期、API 频率配额 | 未做 |
| E 资源治理 | 租户级调度隔离、公平调度、积压上限、查询预算；设备重连限速 | 未做 |
| 行级安全 | 数据库强制隔离 | 决定不做，触发条件是出现真实的跨租户泄露 |
| 商业化（V0.9） | 自助注册、套餐、账单、对账 | 未做，依赖 C 与 D |

现在的「租户」能挡住**看**，挡不住**抢**：一个租户的设备疯狂上报，会占掉所有租户共用的总线、流水线和时序库。访问隔离做了，资源隔离还没开始，这是离生产级 SaaS 最大的一段距离。设备影子、OTA、规则引擎这些后续功能落地时，同样要先回答「租户归属、权限码、配额、审计」四个问题。

---

## 小结

- 租户是安全与资源边界，客户只是租户内的业务归类；用户名全平台唯一，租户编码不可改，平台管理员不属于任何租户
- 强制过滤靠 MyBatis-Plus 租户拦截器，租户取自线程变量，**没绑定租户时直接失败**而不是查全部；`tenant` 与 `app_user` 两张表不过滤
- 拦截器管不了「指向谁」，所以外键一律写成 `(tenant_id, …)` 组合外键，由数据库拒绝跨租户关联
- 跨租户查询只有一条路：`tenant.system` 包里的豁免 Mapper + `callAsSystem(用途)` + 一事务一租户，由架构测试守住；Redis 与 InfluxDB 必须先经受租户过滤的 PostgreSQL 查询拿到设备
- 行级安全评估后决定不用，隔离保证留在应用层，代价是数据库直连不受保护
- 租户内用项目、站点做授权范围：权限目录 + 五个预置角色 + 自定义角色 + 租户 / 项目 / 站点三级绑定，多条绑定取并集；范围写进 SQL，资源越权返回 404，未登记的入口默认拒绝
- 授权每请求回源 PostgreSQL，没有缓存；发布用 `shadow → enforce`，故障保护是 `read-only`，旧账号靠 `authz_managed` 标志显式接管
- JWT 之外加服务端会话与授权版本，禁用、改权、登出在下一个请求生效；邀请只存令牌哈希，48 小时一次性，邮件发不出去就回滚
- 配额、计量计费、租户生命周期、持久化审计都还没做：访问隔离有了，资源隔离还没有

## 参考资料

- Conduit IoT 授权说明：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/authorization.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/authorization.md)
- Conduit IoT 身份治理说明：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/identity-governance.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/identity-governance.md)
- 设计文档：[租户与用户（V0.2-C）](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-16-conduit-v0.2c-tenants-users-design.md)、[租户隔离加固](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-22-conduit-tenant-isolation-design.md)、[组织模型与 RBAC](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-26-conduit-v0.3b-organization-rbac-design.md)
- MyBatis-Plus · 多租户插件：[https://baomidou.com/plugins/tenant/](https://baomidou.com/plugins/tenant/)
- PostgreSQL · Row Security Policies：[https://www.postgresql.org/docs/current/ddl-rowsecurity.html](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- ThingsBoard · Tenant Profiles（租户限额与队列策略的参照）：[https://thingsboard.io/docs/user-guide/tenant-profiles/](https://thingsboard.io/docs/user-guide/tenant-profiles/)

> 下一篇：[压测与瓶颈排查](./10_capacity)

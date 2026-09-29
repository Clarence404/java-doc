# 分布式会话

> 分布式场景下，多个服务实例无法共享本地内存中的 Session，需要统一的会话管理方案。

---

## 一、Session 的问题根源

传统 Web 应用将 Session 存储在 **服务器内存**中，单机没问题。部署多实例后：

```
用户第一次请求 → 实例 A 创建 Session
用户第二次请求 → 负载均衡到实例 B → B 没有该 Session → 认证失败
```

**三种解法：**
1. **粘性会话（Sticky Session）**：同一用户始终路由到同一实例（Nginx ip_hash），治标不治本，实例宕机会话丢失
2. **Session 复制**：各实例间同步 Session，网络开销大，不推荐
3. **集中存储（主流方案）**：Session 存 Redis，各实例共享读取

---

## 二、Cookie-Session 模式

### 2.1 工作流程

```
1. 用户登录 → 服务端创建 Session，存入内存/Redis，返回 Set-Cookie: JSESSIONID=xxx
2. 浏览器后续请求自动携带 Cookie: JSESSIONID=xxx
3. 服务端通过 ID 查找 Session，获取用户信息
```

### 2.2 特点

| 优点 | 缺点 |
|------|------|
| 服务端完全控制会话生命周期 | 依赖 Cookie，跨域麻烦 |
| 可随时强制下线（删 Session） | 移动端 / 小程序不友好 |
| 实现简单成熟 | 分布式下需集中存储 |

---

## 三、JWT（JSON Web Token）

### 3.1 结构

JWT 由三部分组成，`.` 分隔：

```
Header.Payload.Signature
```

| 部分 | 内容 |
|------|------|
| Header | 算法类型（HS256 / RS256）、token 类型 |
| Payload | 用户信息（userId、roles、exp 过期时间等），Base64 编码，**可解码，不可存敏感信息** |
| Signature | `HMAC(Base64(Header) + "." + Base64(Payload), secret)` |

### 3.2 工作流程

```
1. 用户登录 → 服务端生成 JWT，返回给客户端
2. 客户端存储（localStorage / Cookie）
3. 后续请求携带：Authorization: Bearer <token>
4. 服务端验证签名 + 过期时间，无需查库或 Redis
```

### 3.3 优缺点

| 优点 | 缺点 |
|------|------|
| **无状态**，服务端不存储，天然支持分布式 | **无法主动失效**，token 未过期就一直有效 |
| 跨域友好，适合前后端分离 / 移动端 | Payload 可被解码，不能存敏感信息 |
| 减少数据库查询 | token 体积较大（含用户信息） |
| 支持跨服务传递用户信息 | 密钥泄露风险较高 |

### 3.4 无法主动失效的解决方案

JWT 最大痛点：用户退出登录 / 修改密码后，旧 token 在过期前仍有效。

**常见缓解方案：**

1. **短有效期 + Refresh Token**：Access Token 有效期 15min，Refresh Token 有效期 7 天存 Redis，过期需重新登录
2. **黑名单**：退出时将 token 存入 Redis 黑名单，每次请求校验，牺牲了无状态优势
3. **版本号**：用户信息里加 tokenVersion，修改密码时版本+1，旧 token 携带旧版本号校验失败

::: tip 建议
对安全要求高（需要强制下线、踢人、密码修改即时失效）的系统，慎用纯 JWT 方案，或配合 Redis 黑名单使用。
:::

---

## 四、Redis Session

### 4.1 方案原理

将 Session 数据存入 Redis，服务端只保存 Session ID（通过 Cookie 传递）。所有实例共享同一个 Redis，实现 Session 共享。

```
用户请求 → 携带 Cookie(sessionId) → 任意实例 → 查 Redis → 获取 Session
```

### 4.2 Spring Session 集成

Spring Session 是 Spring 官方提供的 Session 管理抽象，支持 Redis、JDBC、Hazelcast 等后端存储，**对业务代码透明**，无需改动 `HttpSession` 使用方式。

**Maven 依赖：**
```xml
<dependency>
    <groupId>org.springframework.session</groupId>
    <artifactId>spring-session-data-redis</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

**配置：**
```yaml
spring:
  session:
    store-type: redis
    timeout: 30m
    redis:
      namespace: spring:session
  redis:
    host: localhost
    port: 6379
```

**启用注解（Spring Boot 自动配置，通常无需手动加）：**
```java
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 1800)
```

**业务代码无需改动，直接用 `HttpSession`：**
```java
@GetMapping("/login")
public String login(HttpSession session, String username) {
    session.setAttribute("user", username);
    return "ok";
}
```

### 4.3 Redis 中的存储结构

Spring Session 在 Redis 中使用以下三个 key：

```
spring:session:sessions:<sessionId>          # Hash，存 Session 属性
spring:session:sessions:expires:<sessionId>  # String，TTL 控制
spring:session:expirations:<时间戳>           # Set，过期清理索引
```

---

## 五、三种方案对比

| 维度 | Cookie-Session（内存） | Cookie-Session（Redis） | JWT |
|------|----------------------|------------------------|-----|
| 存储位置 | 服务端内存 | Redis | 客户端 |
| 分布式支持 | ❌ 需 Sticky Session | ✅ 天然支持 | ✅ 天然支持 |
| 主动失效 | ✅ 删 Session | ✅ 删 Redis key | ⚠️ 需额外机制 |
| 服务端压力 | 内存占用 | Redis 查询 | 无（验签即可） |
| 跨域 | ⚠️ 麻烦 | ⚠️ 麻烦 | ✅ 友好 |
| 移动端 / 小程序 | ⚠️ 不友好 | ⚠️ 不友好 | ✅ 友好 |
| 安全性 | 高（服务端控制） | 高（服务端控制） | 中（密钥管理） |
| 实现复杂度 | 低 | 低（Spring Session） | 中 |

---

## 六、选型建议

```
传统 Web（后端渲染 / 管理后台）   →  Redis Session（Spring Session），简单可靠
前后端分离 / 移动端 / 小程序      →  JWT（短有效期 + Refresh Token）
高安全要求（金融 / 即时下线）     →  Redis Session 或 JWT + 黑名单
微服务跨服务传递用户信息          →  JWT（无需每个服务都查 Redis）
```

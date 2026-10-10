---
description: 多实例会话问题、粘性会话、Spring Session + Redis、Redis 键结构、JWT 取舍、选型
---

# 分布式会话

> 前置阅读：[分布式架构](./1_distributed)

多实例部署下，存在单机内存里的会话会随请求落到不同实例而丢失。本篇讲用 Spring Boot 4 + Spring Session 把会话放进 Redis、默认与索引两种存储结构的区别，以及服务端会话与 JWT 的选择。

---

## 一、问题与解法

Servlet 容器默认把 Session 放在**本实例内存**里。部署多实例后，用户第一次请求落到实例 A 并建立会话，第二次请求被负载均衡转到实例 B，B 找不到这个会话，用户被要求重新登录。

| 解法 | 做法 | 问题 |
|------|------|------|
| 粘性会话（Sticky Session） | 负载均衡按 IP 或 Cookie 把同一用户固定到同一实例 | 实例重启或宕机会话就丢；负载不均；扩缩容时会话迁移 |
| 会话复制 | 实例之间互相同步会话（如 Tomcat 集群复制） | 网络与内存开销随实例数增长，不适合大规模 |
| **集中存储** | 会话存到 Redis 等外部存储，所有实例共享 | 多一次 Redis 访问；Redis 要高可用 |
| 无状态令牌 | 用户信息放进签名令牌（JWT），服务端不存会话 | 难以主动失效，见第三节 |

集中存储是服务端会话的主流做法：

![集中式 Session：任意实例都能读到会话](../assets/distributed/session-sharing.svg)

---

## 二、Spring Session + Redis

Spring Session 用一个过滤器（`SessionRepositoryFilter`）替换容器的 `HttpSession` 实现，把会话读写转到 Redis、JDBC 等存储。业务代码照常使用 `HttpSession`，无需改动。

### 1、依赖与配置（Spring Boot 4）

```xml
<!-- Boot 4 按模块拆分了自动配置，用 Session 专用 starter（会带上 Spring Data Redis） -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-session-data-redis</artifactId>
</dependency>
```

```yaml
spring:
  data:
    redis:                      # Boot 3.0 起是 spring.data.redis.*，不是 spring.redis.*
      host: redis.internal
      port: 6379
      password: ${REDIS_PASSWORD}
  session:
    timeout: 30m                # 会话空闲超时，默认取 server.servlet.session.timeout
    data:
      redis:                    # Boot 4 由 spring.session.redis.* 改名而来
        namespace: myapp:session
        flush-mode: on-save     # on-save：请求结束时写回；immediate：每次 setAttribute 立即写
        repository-type: default  # default 或 indexed，见下文

server:
  servlet:
    session:
      cookie:
        http-only: true
        secure: true
        same-site: lax
```

几点注意：

- 引入上面的 starter 后 Boot 会自动配置，**不需要** `@EnableRedisHttpSession`。一旦手动加上 `@Enable*HttpSession`，Boot 的会话自动配置会退让，上面 `spring.session.*` 的属性全部失效，超时等参数只能写在注解里。Boot 3.x 则是 `spring-boot-starter-data-redis` + `spring-session-data-redis`，属性前缀为 `spring.session.redis.*`
- Spring Session 的 Cookie 名默认是 `SESSION`，Boot 会把 `server.servlet.session.cookie.*` 应用到它
- 会话属性默认用 JDK 序列化，放进会话的对象要实现 `Serializable`，且类结构变化后旧会话可能反序列化失败。改用 JSON 时定义名为 `springSessionDefaultRedisSerializer` 的 `RedisSerializer<Object>` Bean；会话里存有 Spring Security 对象时，还要为 ObjectMapper 注册 Spring Security 提供的 Jackson 模块

### 2、登录示例

```java
@PostMapping("/login")
public ResponseEntity<Void> login(@RequestBody @Valid LoginRequest req, HttpServletRequest request) {
    User user = authService.authenticate(req.username(), req.password());
    HttpSession session = request.getSession();
    request.changeSessionId();                       // 登录后更换会话 ID，防会话固定攻击
    session.setAttribute("userId", user.getId());
    return ResponseEntity.noContent().build();
}
```

登录用 POST 并把凭据放在请求体里，不要把用户名密码放进 URL。使用 Spring Security 时，认证成功后默认就会更换会话 ID，不需要手写。

### 3、Redis 中的存储结构

Spring Session 3.0 起有两种 Redis 仓库：

| 仓库 | 启用方式 | Redis 中的 key | 能力 |
|------|----------|----------------|------|
| `RedisSessionRepository`（默认） | `repository-type: default` | `<namespace>:sessions:<sessionId>`，一个带 TTL 的 Hash | 简单高效；没有会话过期 / 删除事件，不能按用户名查会话 |
| `RedisIndexedSessionRepository` | `repository-type: indexed` 或 `@EnableRedisIndexedHttpSession` | 会话 Hash、用于触发过期事件的 `sessions:expires:<id>`、按分钟分桶的过期集合、按用户名建立的索引集合 | 发布 `SessionCreated / Deleted / Expired` 事件；支持 `FindByIndexNameSessionRepository` 按用户名查询与踢人；依赖 Redis 键空间通知 |

只需要共享会话时用默认仓库。需要「查看某用户所有在线会话、强制下线」或并发会话控制时用 indexed，它会多写几个 key，并要求 Redis 开启键空间通知（托管 Redis 可能禁用 `CONFIG` 命令，此时需提前在服务端配置好）。

---

## 三、JWT 的取舍

JWT 把用户标识和过期时间等声明放进令牌，用签名防篡改，服务端验签即可，不需要查会话存储。结构、签名算法与吊销方案的细节见 [JWT 令牌机制](/security/1_jwt)，这里只讲它与服务端会话的区别：

- **优点**：无状态，天然支持多实例与跨服务传递身份；适合移动端、第三方 API 调用
- **缺点**：签发后在过期前一直有效，退出登录、修改密码、封号都无法立即生效。常见缓解是短有效期 Access Token + 可吊销的 Refresh Token，或在 Redis 维护黑名单 / 令牌版本号，但这又引回了服务端状态
- **存放位置**：放在 `localStorage` 会被 XSS 读取。浏览器场景优先放在 `HttpOnly + Secure + SameSite` 的 Cookie 中，同时做好 CSRF 防护

在微服务内部，常见做法是网关校验外部令牌（会话或 JWT），再以内部令牌或请求头把用户身份传给下游服务。

---

## 四、方案对比

| 维度 | 内存会话 | Spring Session + Redis | JWT |
|------|----------|------------------------|-----|
| 状态存放 | 实例内存 | Redis | 客户端 |
| 多实例 | 需要粘性会话 | 支持 | 支持 |
| 主动失效 / 踢人 | 支持（仅本实例） | 支持（删除会话；按用户踢人需 indexed） | 需要黑名单或版本号 |
| 每次请求开销 | 本地内存 | 一次 Redis 访问 | 验签 |
| 跨域 / 移动端 | 依赖 Cookie | 依赖 Cookie，也可用 `X-Auth-Token` 头传会话 ID | 方便 |
| 实现复杂度 | 低 | 低 | 中（密钥管理、续期、吊销） |

---

## 五、选型建议

| 场景 | 方案 | 理由 |
|------|------|------|
| 服务端渲染、管理后台 | Spring Session + Redis | 简单，可随时失效 |
| 浏览器访问的前后端分离应用 | Spring Session + Redis，或放在 HttpOnly Cookie 中的短期令牌 | 同域下 Cookie 会话足够安全简单 |
| 移动端、开放 API | 短期 JWT + Refresh Token | 不依赖 Cookie，服务端无状态 |
| 需要即时下线、并发登录控制 | Spring Session（indexed）或 JWT + 黑名单 | 必须有服务端状态 |
| 微服务间传递身份 | 网关验证后向下游传内部令牌或身份头 | 下游不必各自访问会话存储 |

---

## 小结

- 多实例丢会话的根因是会话存在实例内存里；粘性会话治标不治本，主流是集中存储
- Spring Boot 4 下 Redis 连接用 `spring.data.redis.*`，Spring Session 用 `spring.session.data.redis.*`
- 不要手动加 `@EnableRedisHttpSession`，否则 Boot 的会话属性全部失效
- 默认仓库只存一个带 TTL 的 Hash，没有过期事件和按用户名索引；需要踢人用 indexed
- 登录后更换会话 ID，Cookie 设置 HttpOnly、Secure、SameSite
- JWT 无状态但难以即时失效，细节以 [JWT 令牌机制](/security/1_jwt) 为准

## 参考资料

- Spring Session 参考文档：[https://docs.spring.io/spring-session/reference/](https://docs.spring.io/spring-session/reference/)
- Spring Session Redis 配置：[https://docs.spring.io/spring-session/reference/configuration/redis.html](https://docs.spring.io/spring-session/reference/configuration/redis.html)
- Spring Boot Spring Session：[https://docs.spring.io/spring-boot/reference/web/spring-session.html](https://docs.spring.io/spring-boot/reference/web/spring-session.html)
- Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- Spring Security Session Management：[https://docs.spring.io/spring-security/reference/servlet/authentication/session-management.html](https://docs.spring.io/spring-security/reference/servlet/authentication/session-management.html)
- RFC 7519 JSON Web Token：[https://datatracker.ietf.org/doc/html/rfc7519](https://datatracker.ietf.org/doc/html/rfc7519)

> 下一篇：[分布式调度](./6_job_scheduler) —— 多实例下定时任务如何只执行一次，分片、错过触发与幂等，以及 XXL-JOB、ElasticJob、PowerJob 的选型。

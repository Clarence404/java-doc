---
description: Server WebFlux 与 MVC、请求链路、OAuth2 鉴权、限流、CORS、灰度路由、网关选型
---

# API 网关

> 前置阅读：[注册发现](./1_service_registry)

网关把鉴权、限流、跨域、日志等横切关注点收敛到统一入口，免去客户端直连各服务、每个服务各写一遍。本篇讲 Spring Cloud Gateway 2025.x 的两种形态、请求链路，以及鉴权、限流、跨域、灰度路由的生产配置与网关选型。

---

## 一、两种形态：Server WebFlux 与 Server MVC

**Spring Cloud 2025.0 起，Gateway 拆成两个独立的服务端实现，2025.1 删除了旧的 `spring-cloud-starter-gateway` 等 artifact，配置前缀同步改名。**

没有网关与有网关的对比：

| 维度 | 无网关 | 有网关 |
|------|-------|-------|
| 客户端访问 | 直连各服务地址，内部拓扑外泄 | 只访问网关，按路径路由到内部服务 |
| 鉴权 / 限流 / CORS | 每个服务各自实现，口径不一 | 网关统一处理，服务只关心业务 |
| 灰度与流量调度 | 难以在入口统一控制 | 按请求头、用户、权重切流 |
| 监控 | 分散在各服务 | 入口统一埋点、统一访问日志 |

| 维度 | Gateway Server WebFlux | Gateway Server MVC |
|------|----------------------|--------------------|
| Starter | `spring-cloud-starter-gateway-server-webflux` | `spring-cloud-starter-gateway-server-webmvc` |
| 配置前缀 | `spring.cloud.gateway.server.webflux.*` | `spring.cloud.gateway.server.webmvc.*` |
| 运行模型 | Reactor Netty，事件循环非阻塞 | Servlet 容器（Tomcat / Jetty），可配合虚拟线程 |
| 过滤器模型 | `GlobalFilter` / `GatewayFilter`，返回 `Mono<Void>` | `HandlerFilterFunction`，前置 / 后置函数 |
| 生态 | 功能最全，内置 Redis 令牌桶限流、TokenRelay 等 | 功能在追赶，过滤器写法与普通 Spring MVC 一致 |
| 适合 | 高并发入口、长连接、已有 Gateway 存量 | 团队不熟悉响应式、需要在过滤器中调用阻塞 API |

两者只能选一个。存量项目从 2024.0 及更早升级时，要同时改依赖和配置前缀：**旧的 `spring.cloud.gateway.routes` 等键在 2025.1 不再生效，路由会静默丢失**，启动后先用 actuator 的 `gateway/routes` 端点核对路由是否加载。OpenRewrite 提供了「Migrate Spring Cloud Gateway Properties」配方，可以批量改前缀。

本文示例以 Server WebFlux 为主。

---

## 二、核心概念与请求链路

| 概念 | 说明 |
|------|------|
| **Route（路由）** | 网关的基本单元：ID + 目标 URI + 断言集合 + 过滤器列表 |
| **Predicate（断言）** | 判断请求是否命中路由（Path / Method / Header / Query / Host / Weight 等） |
| **GatewayFilter** | 路由级过滤器，只对所在路由生效，通过配置声明 |
| **GlobalFilter** | 全局过滤器，对所有路由生效，通过 Bean 声明 |
| **Order** | 过滤器执行顺序，值越小越先执行 Pre 逻辑、越后执行 Post 逻辑 |

![Gateway Server WebFlux 请求处理链路](../assets/spring-cloud/gateway-pipeline.svg)

1. `RoutePredicateHandlerMapping` 按路由顺序逐个匹配断言，命中第一个即停止
2. `FilteringWebHandler` 把所有 `GlobalFilter` 与该路由的 `GatewayFilter` 合并，按 `Order` 排成一条链
3. 链上过滤器在 `chain.filter(exchange)` 之前的代码是 Pre 逻辑，之后（`then(...)`）的是 Post 逻辑
4. `ReactiveLoadBalancerClientFilter` 把 `lb://order-service` 解析为具体实例，`NettyRoutingFilter` 发起转发
5. 响应沿过滤链逆序返回，执行各过滤器的 Post 逻辑

Server MVC 的链路类似：`RouterFunction` 匹配路由，`before` / `after` 过滤函数包住 `HandlerFunction` 的转发。

---

## 三、路由配置

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-gateway-server-webflux</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-discovery</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: order-service
              uri: lb://order-service              # lb:// 表示经注册中心 + LoadBalancer 选实例
              order: 10
              predicates:
                - Path=/api/orders/**
              filters:
                - StripPrefix=1                    # /api/orders/1 -> /orders/1
                - name: RequestRateLimiter
                  args:
                    redis-rate-limiter.replenishRate: 100   # 令牌每秒补充速率
                    redis-rate-limiter.burstCapacity: 200   # 桶容量，允许的突发量
                    key-resolver: "#{@ipKeyResolver}"

            - id: user-service
              uri: lb://user-service
              order: 20
              predicates:
                - Path=/api/users/**
                - Method=GET,POST
              filters:
                - StripPrefix=1

          default-filters:                          # 对所有路由生效的路由级过滤器
            - DedupeResponseHeader=Access-Control-Allow-Origin
          httpclient:
            connect-timeout: 2000                   # 连接超时（ms）
            response-timeout: 5s                    # 响应超时，单条路由可在 metadata 中覆盖
```

Server MVC 的 YAML 结构基本相同，前缀换成 `spring.cloud.gateway.server.webmvc`。

**动态路由**：路由不必写死在配置文件里，有三种运行时更新方式：

- 路由放在 Nacos 等配置中心，配置变更触发刷新事件后网关重建路由
- 通过 actuator `gateway` 端点增删路由，再调用 `POST /actuator/gateway/refresh`；该端点必须只在内网暴露并鉴权
- 实现 `RouteDefinitionRepository`，把路由存在 Redis 或数据库中，由运营后台管理

---

## 四、统一鉴权：网关作为 OAuth2 资源服务器

**标准做法是让网关成为 OAuth2 Resource Server，由 Spring Security 完成 JWT 验签、过期与签发方校验，而不是手写 JWT 解析过滤器。** JWT、OAuth2 的原理见 [JWT 令牌机制](/security/1_jwt) 与 [OAuth2](/security/2_oauth2)，API 层的其他防护见 [API 安全](/security/6_api_security)。

```xml
<!-- Boot 4 中的新名称；Boot 3.x 为 spring-boot-starter-oauth2-resource-server -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security-oauth2-resource-server</artifactId>
</dependency>
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com/realms/shop   # 启动时拉取 JWK Set，按 kid 自动轮换公钥
```

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;

@Configuration
@EnableWebFluxSecurity
public class GatewaySecurityConfig {

    @Bean
    public SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http) {
        return http
            .csrf(ServerHttpSecurity.CsrfSpec::disable)          // 纯 Token API，无 Cookie 会话
            .authorizeExchange(ex -> ex
                .pathMatchers("/api/users/login", "/api/users/register", "/actuator/health/**").permitAll()
                .pathMatchers("/api/admin/**").hasAuthority("SCOPE_admin")
                .anyExchange().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
            .build();
    }
}
```

验签通过后，把用户标识透传给下游。**必须先删除客户端自带的同名请求头**，否则外部请求可以伪造身份：

```java
import java.util.Optional;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class UserHeaderRelayFilter implements GlobalFilter, Ordered {

    private static final String USER_ID_HEADER = "X-User-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        return exchange.getPrincipal()
            .ofType(JwtAuthenticationToken.class)
            .map(auth -> Optional.of(auth.getToken().getSubject()))
            .defaultIfEmpty(Optional.empty())
            .flatMap(userId -> chain.filter(exchange.mutate()
                .request(req -> req.headers(headers -> {
                    headers.remove(USER_ID_HEADER);                       // 丢弃外部伪造的值
                    userId.ifPresent(id -> headers.set(USER_ID_HEADER, id));
                }))
                .build()));
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 100;   // 在路由转发之前执行
    }
}
```

- Spring Security 的 `WebFilter` 在网关的 `DispatcherHandler` 之前执行，所以过滤器里能拿到已认证的 `Principal`
- 原始 `Authorization` 头默认会转发给下游，下游服务可以再做一次资源服务器校验（零信任），也可以只信任网关注入的请求头，前提是下游只能从网关访问
- 网关同时作为 OAuth2 Client（BFF 模式）时，可用 `TokenRelay` 过滤器把登录得到的 Access Token 转发给下游，需额外引入 `spring-boot-starter-security-oauth2-client`

---

## 五、限流

`RequestRateLimiter` 使用 Redis + Lua 实现令牌桶，需要响应式 Redis：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis-reactive</artifactId>
</dependency>
```

```java
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.cloud.gateway.support.ipresolver.XForwardedRemoteAddressResolver;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.core.publisher.Mono;

@Configuration
public class RateLimiterConfig {

    // 网关前面还有一层 SLB / Nginx 时，getRemoteAddress() 拿到的是代理 IP；
    // maxTrustedIndex(1) 只信任 X-Forwarded-For 中最后一跳代理写入的地址，防止客户端伪造
    private final XForwardedRemoteAddressResolver addressResolver =
        XForwardedRemoteAddressResolver.maxTrustedIndex(1);

    @Bean
    public KeyResolver ipKeyResolver() {
        return exchange -> Mono.justOrEmpty(addressResolver.resolve(exchange))
            .map(address -> address.getAddress().getHostAddress());
    }

    // 按用户限流：依赖上文鉴权后注入的 X-User-Id；取不到时返回空，
    // 由 deny-empty-key（默认 true）拒绝，不要兜底成固定值，否则所有匿名请求共用一个桶
    @Bean
    public KeyResolver userKeyResolver() {
        return exchange -> Mono.justOrEmpty(
            exchange.getRequest().getHeaders().getFirst("X-User-Id"));
    }
}
```

同一应用里定义了多个 `KeyResolver` Bean 时，路由配置里要用 `key-resolver` 显式指定。限流算法对比、阈值怎么定、网关限流与应用内限流如何分层，见 [限流与过载保护](/high-avail/7_rate_limiting)。

---

## 六、跨域（CORS）

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          globalcors:
            cors-configurations:
              '[/**]':
                allowed-origin-patterns:
                  - "https://*.example.com"      # 带凭证时不能放开为 *
                allowed-methods: [GET, POST, PUT, DELETE, OPTIONS]
                allowed-headers: "*"
                allow-credentials: true
                max-age: 3600
```

跨域只在网关处理一次，下游服务不要再加 CORS 响应头，否则浏览器收到重复的 `Access-Control-Allow-Origin` 会直接报错（上文 `DedupeResponseHeader` 是兜底）。

---

## 七、灰度路由

**路由上的 `metadata` 不会传给负载均衡器，不能用来选实例。** 网关内的灰度有两种正确做法。

### 1、按权重切到独立服务

灰度版本注册成独立服务名（如 `order-service-canary`），用 `Weight` 断言按比例分流：

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: order-stable
              uri: lb://order-service
              predicates:
                - Path=/api/orders/**
                - Weight=order-group, 95
              filters:
                - StripPrefix=1
            - id: order-canary
              uri: lb://order-service-canary
              predicates:
                - Path=/api/orders/**
                - Weight=order-group, 5
              filters:
                - StripPrefix=1
```

适合按比例放量；同一用户的多次请求可能落到不同版本。

### 2、按请求头选实例（LoadBalancer Hint）

灰度实例与稳定实例共用服务名，用实例元数据区分。网关里的 `ReactiveLoadBalancerClientFilter` 会把请求头放进 `RequestDataContext`，Spring Cloud LoadBalancer 的 Hint 过滤器据此选实例：

```yaml
# 网关
spring:
  cloud:
    loadbalancer:
      hint-header-name: X-Version          # 默认 X-SC-LB-Hint
---
# 灰度实例（order-service 的 canary 部署）
spring:
  cloud:
    nacos:
      discovery:
        metadata:
          hint: canary
```

网关侧还要把实例列表供应链配置为 `withDiscoveryClient().withCaching().withHints()`，配置类写法见 [服务治理 · 区域优先与 Hint 路由](./5_service_governance)。带 `X-Version: canary` 的请求优先落到灰度实例，找不到时回落到全部实例；需要「无标记请求必须避开灰度实例」或按用户 ID 百分比放量时，用自定义 `ReactorServiceInstanceLoadBalancer`，同样见服务治理一篇。灰度标记必须逐跳透传，否则第二跳之后就回到稳定版本。

发布策略（蓝绿、金丝雀、K8s Ingress 灰度）的整体设计见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 八、网关选型

| 维度 | Spring Cloud Gateway | Kong | APISIX | Envoy 系（Envoy Gateway、Higress、Istio Gateway） |
|------|---------------------|------|--------|------|
| 实现 | Java（Reactor Netty / Servlet） | OpenResty（Lua） | OpenResty（Lua），etcd 存配置 | C++ 数据面 + 控制面 |
| 性能 | 中，受 JVM 与过滤器逻辑影响 | 高 | 高 | 高 |
| 动态配置 | actuator 端点、配置中心刷新、自定义 `RouteDefinitionRepository` | Admin API | Admin API，配置秒级生效 | xDS 动态下发，K8s Gateway API 声明式配置 |
| 扩展方式 | Java 过滤器，可直接复用 Spring 生态 | Lua / Go 插件 | Lua / 多语言插件 | Wasm、Lua 扩展 |
| 适合 | Java 微服务体系，鉴权逻辑与业务耦合较深 | 企业 API 管理 | 高性能流量网关 | 运行在 K8s 上、已使用或计划使用服务网格 |

常见分层：入口用 Nginx / APISIX / Envoy 做流量网关（TLS 终止、WAF、全局限流），其后用 Spring Cloud Gateway 做业务网关（鉴权、聚合、灰度）。服务网格中东西向流量的治理见 [服务网格](/microservices/3_service_mesh)。

网关在架构中的位置与 BFF 模式见 [微服务设计模式](/microservices/2_patterns)。

---

## 小结

- Spring Cloud 2025.x 的 Gateway 分为 Server WebFlux 与 Server MVC 两个 starter，旧 starter 在 2025.1 删除；配置前缀改为 `spring.cloud.gateway.server.webflux.*` / `webmvc.*`，旧键不再生效
- 请求链路：断言匹配路由，Global 与路由过滤器按 Order 合并成链，Pre 逻辑在前、Post 逻辑逆序在后，`lb://` 由 LoadBalancer 解析
- 鉴权用 OAuth2 Resource Server（Boot 4 starter 为 `spring-boot-starter-security-oauth2-resource-server`），透传用户信息前先删除外部同名请求头
- `RequestRateLimiter` 基于 Redis 令牌桶；在代理之后按 IP 限流要用 `XForwardedRemoteAddressResolver`，取不到 key 时拒绝而不是共用一个桶
- CORS 只在网关处理一次，带凭证时不能使用通配来源
- 路由 `metadata` 不参与选实例；灰度用 `Weight` 断言分流到独立服务，或用 LoadBalancer Hint / 自定义负载均衡器按请求头选实例
- Java 业务网关选 Spring Cloud Gateway，K8s 与服务网格环境优先考虑 Envoy 系网关，两者常分层组合

## 参考资料

- Spring Cloud Gateway 参考文档：[https://docs.spring.io/spring-cloud-gateway/reference/](https://docs.spring.io/spring-cloud-gateway/reference/)
- Spring Cloud 2025.1（Oakwood）发布说明：[https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released)
- Spring Security OAuth2 Resource Server（Reactive）：[https://docs.spring.io/spring-security/reference/reactive/oauth2/resource-server/jwt.html](https://docs.spring.io/spring-security/reference/reactive/oauth2/resource-server/jwt.html)
- Kubernetes Gateway API：[https://gateway-api.sigs.k8s.io/](https://gateway-api.sigs.k8s.io/)

> 下一篇：[服务通信](./3_communication) —— 网关之后的服务间调用：HTTP Service Clients、OpenFeign、gRPC 与 Dubbo 如何选。

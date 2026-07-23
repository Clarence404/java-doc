# API 网关

> 参考资料：
> * Spring Cloud Gateway：[https://spring.io/projects/spring-cloud-gateway](https://spring.io/projects/spring-cloud-gateway)
> * Kong：[https://docs.konghq.com/](https://docs.konghq.com/)
> * APISIX：[https://apisix.apache.org/docs/](https://apisix.apache.org/docs/)

---

## 一、为什么需要 API 网关

没有网关时，客户端需要直接知道每个微服务的地址，并各自处理认证、限流、日志：

```
无网关：
  Client → order-service:8081
  Client → user-service:8082    ← 每个服务各自处理鉴权/限流
  Client → payment-service:8083

有网关：
  Client → Gateway:8080 → order-service
                        → user-service    ← 统一入口，横切关注点集中处理
                        → payment-service
```

网关承担的职责：**路由分发、统一鉴权、限流熔断、请求/响应变换、灰度发布、监控埋点**。

---

## 二、Spring Cloud Gateway 核心概念

| 概念 | 说明 |
|------|------|
| **Route（路由）** | 网关的基本单元：匹配规则 + 目标 URI + 过滤器列表 |
| **Predicate（断言）** | 判断请求是否匹配该路由的条件（Path/Method/Header/Query 等）|
| **Filter（过滤器）** | 对请求或响应进行处理（Pre Filter / Post Filter）|
| **GlobalFilter** | 全局过滤器，对所有路由生效 |
| **GatewayFilter** | 路由级过滤器，只对指定路由生效 |

```
请求 → Predicate 匹配 → Pre Filters → 代理到目标服务 → Post Filters → 响应
```

---

## 三、基础路由配置

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-gateway</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service          # lb:// 表示从注册中心负载均衡
          predicates:
            - Path=/api/orders/**
          filters:
            - StripPrefix=1                # 去掉路径前缀 /api
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100    # 令牌桶每秒补充速率
                redis-rate-limiter.burstCapacity: 200    # 桶容量
                key-resolver: "#{@ipKeyResolver}"

        - id: user-service
          uri: lb://user-service
          predicates:
            - Path=/api/users/**
            - Method=GET,POST
          filters:
            - StripPrefix=1
            - AddRequestHeader=X-Gateway-Source, gateway   # 添加来源标识

      # 全局默认过滤器
      default-filters:
        - DedupeResponseHeader=Access-Control-Allow-Origin  # 去重响应头
```

---

## 四、JWT 鉴权（GlobalFilter）

```java
@Component
@Order(-1)  // 优先级最高
public class AuthGlobalFilter implements GlobalFilter {

    private static final String AUTHORIZATION = "Authorization";
    private static final String BEARER = "Bearer ";

    // 白名单路径（无需鉴权）
    private final List<String> whiteList = List.of(
        "/api/users/login", "/api/users/register", "/actuator/health"
    );

    private final JwtUtils jwtUtils;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String path = exchange.getRequest().getPath().toString();

        // 白名单直接放行
        if (whiteList.stream().anyMatch(path::startsWith)) {
            return chain.filter(exchange);
        }

        String authHeader = exchange.getRequest().getHeaders().getFirst(AUTHORIZATION);
        if (authHeader == null || !authHeader.startsWith(BEARER)) {
            return unauthorized(exchange);
        }

        String token = authHeader.substring(BEARER.length());
        try {
            Claims claims = jwtUtils.parseToken(token);
            // 将用户信息透传给下游服务
            ServerHttpRequest mutatedRequest = exchange.getRequest().mutate()
                .header("X-User-Id", claims.getSubject())
                .header("X-User-Role", claims.get("role", String.class))
                .build();
            return chain.filter(exchange.mutate().request(mutatedRequest).build());
        } catch (JwtException e) {
            return unauthorized(exchange);
        }
    }

    private Mono<Void> unauthorized(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        byte[] body = "{\"code\":401,\"message\":\"Unauthorized\"}".getBytes(StandardCharsets.UTF_8);
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(body);
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }
}
```

---

## 五、限流（Redis + 令牌桶）

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis-reactive</artifactId>
</dependency>
```

```java
@Configuration
public class RateLimiterConfig {

    // 按 IP 限流
    @Bean
    public KeyResolver ipKeyResolver() {
        return exchange -> Mono.just(
            exchange.getRequest().getRemoteAddress().getAddress().getHostAddress()
        );
    }

    // 按用户 ID 限流（需先经过鉴权 Filter 注入 X-User-Id）
    @Bean
    public KeyResolver userKeyResolver() {
        return exchange -> Mono.justOrEmpty(
            exchange.getRequest().getHeaders().getFirst("X-User-Id")
        ).defaultIfEmpty("anonymous");
    }
}
```

---

## 六、跨域配置（CORS）

```yaml
spring:
  cloud:
    gateway:
      globalcors:
        corsConfigurations:
          '[/**]':
            allowedOriginPatterns: "*"
            allowedMethods:
              - GET
              - POST
              - PUT
              - DELETE
              - OPTIONS
            allowedHeaders: "*"
            allowCredentials: true
            maxAge: 3600
```

---

## 七、灰度发布（流量染色）

通过 Header 或元数据将请求路由到指定版本的实例：

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service-canary
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
            - Header=X-Version, canary    # 带此 Header 的请求路由到 canary 实例
          filters:
            - StripPrefix=1
          metadata:
            version: canary
```

下游服务在 Nacos 注册元数据中标记 `version=canary`，Spring Cloud LoadBalancer 配合自定义 `ReactorServiceInstanceLoadBalancer` 过滤版本。

---

## 八、主流网关对比

| 维度 | Spring Cloud Gateway | Kong | APISIX |
|------|---------------------|------|--------|
| 语言 | Java | Lua（OpenResty）| Lua（OpenResty）|
| 性能 | 中（Reactor 非阻塞）| 高 | 极高 |
| 生态 | Spring Cloud 原生 | 插件丰富 | 插件丰富，国产活跃 |
| 动态配置 | 需重启或 Nacos | Admin API 动态 | Admin API 动态 |
| 适合场景 | Java 微服务体系 | 企业 API 管理 | 高性能，云原生 |

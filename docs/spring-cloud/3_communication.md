---
description: HTTP Service Clients、负载均衡 RestClient、OpenFeign、gRPC 与 Dubbo
---

# 服务通信

> **本篇目标**：掌握 Spring Cloud 2025.1 下服务间同步调用的推荐写法（HTTP Service Clients + LoadBalancer），了解 OpenFeign 的维护状态与存量项目的正确配置，能在 HTTP、gRPC、Dubbo 3 与异步消息之间做选型。
>
> **前置阅读**：[注册发现](./1_service_registry)

---

## 一、通信模式

| 模式 | 典型实现 | 特点 | 适用 |
|------|---------|------|------|
| **同步 HTTP** | HTTP Service Clients、`RestClient`、OpenFeign | 简单直观，调试方便，跨语言 | 大多数内部调用、对外 API |
| **同步 RPC** | gRPC（HTTP/2 + Protobuf）、Dubbo 3（Triple / Dubbo 协议） | 强类型契约，序列化开销小，支持流式 | 内部高频调用、多语言服务 |
| **异步消息** | Kafka / RocketMQ / RabbitMQ、Spring Cloud Stream | 解耦、削峰、最终一致 | 事件驱动、非核心链路异步化 |

**Spring 生态的 HTTP 客户端在 Framework 7 中完成了换代**：`RestTemplate` 在 7.1 中标记为废弃（计划 8.0 移除），同步调用用 `RestClient`，声明式接口用 HTTP Service Clients；Spring Cloud OpenFeign 自 2022.0 起功能冻结，只接受缺陷修复，官方建议新项目迁移到 HTTP Service Clients。`RestClient` 与 HTTP 接口在 Boot 中的通用用法见 [Web 开发](/spring-boot/2_web_dev)，版本差异见 [Spring Boot 版本演进](/spring-boot/11_versions)。

---

## 二、HTTP Service Clients（推荐）

### 1、声明接口

```java
import java.util.List;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.PostExchange;

@HttpExchange("/users")
public interface UserClient {

    @GetExchange("/{id}")
    UserResponse getUser(@PathVariable Long id);

    @PostExchange
    UserResponse createUser(@RequestBody CreateUserRequest request);

    @GetExchange("/batch")
    List<UserResponse> getUserBatch(@RequestParam List<Long> ids);
}
```

### 2、注册与负载均衡

Framework 7 的 `@ImportHttpServices` 按「组」批量注册客户端代理；Spring Cloud LoadBalancer 5.0 起为每个组自动接入负载均衡：组没有配置 `base-url` 时默认使用 `http://<组名>`，组名即注册中心里的服务名。

```java
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.service.registry.ImportHttpServices;

@SpringBootApplication
@ImportHttpServices(group = "user-service", types = UserClient.class)
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
```

```yaml
spring:
  http:
    serviceclient:
      user-service:                         # 组名 = 服务名
        base-url: lb://user-service         # 可省略；显式写 lb:// 便于阅读，也可带路径前缀
        connect-timeout: 2s
        read-timeout: 3s
```

依赖只需 `spring-cloud-starter-loadbalancer` 与注册中心 starter。`base-url` 写成不带 `lb` 的普通地址时不会接入负载均衡，适合调用外部 API。

调用方直接注入接口：

```java
@Service
public class PaymentService {

    private final UserClient userClient;

    public PaymentService(UserClient userClient) {
        this.userClient = userClient;
    }

    public void pay(Long userId) {
        UserResponse user = userClient.getUser(userId);
        // ...
    }
}
```

下游返回 4xx / 5xx 时抛出 `HttpClientErrorException` / `HttpServerErrorException`（均继承 `RestClientResponseException`），调用方按需转换为业务异常。

### 3、透传请求头

按组定制客户端（统一加请求头、拦截器）用 `RestClientHttpServiceGroupConfigurer`：

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.web.client.support.RestClientHttpServiceGroupConfigurer;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@Configuration
public class HttpServiceClientConfig {

    @Bean
    public RestClientHttpServiceGroupConfigurer authRelayConfigurer() {
        return groups -> groups.forEachClient((group, builder) ->
            builder.requestInterceptor((request, body, execution) -> {
                if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
                    String token = attrs.getRequest().getHeader(HttpHeaders.AUTHORIZATION);
                    if (token != null) {
                        request.getHeaders().set(HttpHeaders.AUTHORIZATION, token);
                    }
                }
                return execution.execute(request, body);
            }));
    }
}
```

`RequestContextHolder` 绑定在处理请求的线程上，切到线程池或 `@Async` 后取不到值，需要显式传递上下文，见 [虚拟线程](/java/30_topic_virtual_thread) 中的上下文传播与 [服务治理 · 灰度标记透传](./5_service_governance)。

### 4、命令式调用：@LoadBalanced RestClient

不想定义接口时，用带负载均衡的 `RestClient.Builder`，URL 中直接写服务名：

```java
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
public class RestClientConfig {

    @Bean
    @LoadBalanced
    public RestClient.Builder loadBalancedRestClientBuilder() {
        return RestClient.builder();
    }
}
```

```java
UserResponse user = restClientBuilder.build()
    .get()
    .uri("http://user-service/users/{id}", userId)
    .retrieve()
    .body(UserResponse.class);
```

带 `@LoadBalanced` 的 Builder 只能用来调注册中心里的服务，调用外部地址要另建一个普通的 `RestClient.Builder`。响应式技术栈对应 `@LoadBalanced WebClient.Builder`。

---

## 三、OpenFeign（存量项目）

Spring Cloud OpenFeign 仍随 2025.1 发布、可以继续使用，但不再增加新特性。存量项目维持现状即可，新模块优先用 HTTP Service Clients；两者接口写法相近，迁移成本主要在注解替换（`@FeignClient` + `@GetMapping` → `@HttpExchange` + `@GetExchange`）。

### 1、接入

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
```

```java
@SpringBootApplication
@EnableFeignClients
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}

// name 为注册中心中的服务名，path 为公共路径前缀
@FeignClient(name = "user-service", path = "/users", fallback = UserClientFallback.class)
public interface UserFeignClient {

    @GetMapping("/{id}")
    UserResponse getUser(@PathVariable("id") Long id);

    @PostMapping
    UserResponse createUser(@RequestBody CreateUserRequest request);
}
```

### 2、降级生效的前提

**只写 `fallback` 不会生效**，必须满足以下之一：

| 方案 | 依赖 | 开关 |
|------|------|------|
| Spring Cloud CircuitBreaker + Resilience4j | `spring-cloud-starter-circuitbreaker-resilience4j` | `spring.cloud.openfeign.circuitbreaker.enabled: true` |
| Sentinel | `spring-cloud-starter-alibaba-sentinel` | `feign.sentinel.enabled: true` |

```java
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class UserClientFallback implements UserFeignClient {

    @Override
    public UserResponse getUser(Long id) {
        return UserResponse.empty(id);          // 读接口：返回兜底数据
    }

    @Override
    public UserResponse createUser(CreateUserRequest request) {
        // 写接口：不能静默成功，抛出让调用方感知失败
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "用户服务暂时不可用");
    }
}
```

需要区分「熔断拒绝」与「下游报错」时用 `fallbackFactory` 拿到异常原因，Sentinel 下的写法见 [Spring Cloud Alibaba](./6_alibaba)。

### 3、超时与压缩

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:                    # 全局默认
            connect-timeout: 2000
            read-timeout: 5000
            logger-level: basic       # NONE / BASIC / HEADERS / FULL
          user-service:               # 按服务覆盖
            read-timeout: 3000
      compression:
        request:
          enabled: true               # 请求体超过 min-request-size（默认 2048 字节）才压缩
        response:
          enabled: true
```

OpenFeign 默认连接 10s、读取 60s，远大于合理值，必须显式配置；默认不重试。超时取值与重试预算见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。透传请求头实现 `RequestInterceptor`，写法与上文拦截器相同，示例见 [服务治理 · 灰度标记透传](./5_service_governance)。

---

## 四、gRPC

gRPC 基于 HTTP/2 + Protobuf，`.proto` 文件即契约，自动生成多语言客户端与服务端代码。Protobuf 定义与 Spring Boot 接入代码见 [远程调用协议](/protocols/3_rpc_protocols)。

- **HTTP/2 多路复用**：一条连接上并发多个请求，消除了 HTTP/1.1 的应用层队头阻塞；但 TCP 层丢包时同一连接上的所有流仍会等待重传，只有 HTTP/3（QUIC）才消除传输层队头阻塞
- **Protobuf 二进制序列化**：通常比 JSON 体积更小、编解码更快，具体收益取决于消息结构，需要按业务数据实测；序列化方案对比见 [序列化](/java/19_topic_serialization)
- **流式调用**：服务端流、客户端流、双向流
- **代价**：浏览器不能直接调用（需要 gRPC-Web 或网关转码），抓包调试不如 JSON 直观，负载均衡要按请求而不是按连接（长连接会让 L4 负载均衡失效）

---

## 五、Dubbo 3

Dubbo 3 的 Triple 协议基于 HTTP/2、兼容 gRPC，同时保留高性能的 Dubbo 协议，自带注册发现（可用 Nacos）、负载均衡与服务治理，适合 Java 为主、调用量大、需要接口级治理的团队。Dubbo 的接入基于 Spring Boot 3.5，Boot 4 适配以官方发布为准。完整内容见 [Dubbo](/microservices/4_dubbo)。

---

## 六、选型

| 场景 | 推荐 |
|------|------|
| 新建 Spring Cloud 项目的内部调用 | HTTP Service Clients + LoadBalancer |
| 存量 OpenFeign 项目 | 继续使用，配好超时与降级前提，新模块逐步迁移 |
| 对外暴露、浏览器或第三方调用 | REST（HTTP + JSON） |
| 调用量大、对延迟与序列化开销敏感的内部链路 | gRPC 或 Dubbo 3 |
| 需要双向流式传输 | gRPC |
| 多语言混合（Java + Go + Python） | gRPC，或 Dubbo 3 Triple |
| 非核心链路、下游可延迟处理 | 异步消息 |

协议选型以契约管理成本、团队熟悉度和链路上的观测能力为主，性能差距只在调用量大、消息体大的链路上才显著。

---

## 七、异步通信

下单后通知、积分、统计等非核心操作适合用消息解耦：发送方只保证消息可靠投递，消费方各自订阅、独立扩缩。消息模型、可靠投递与幂等消费见 [消息队列总览](/messaging/0_overview)，屏蔽具体 MQ 的 Spring 编程模型见 [Spring Cloud Stream](./7_stream)。

---

## 小结

- 同步调用的推荐写法是 HTTP Service Clients：`@HttpExchange` 声明接口，`@ImportHttpServices` 按组注册，LoadBalancer 5.0 起自动按组名（服务名）负载均衡
- 命令式调用用 `@LoadBalanced RestClient.Builder`；`RestTemplate` 在 Framework 7.1 已废弃
- OpenFeign 自 2022.0 起功能冻结，存量项目可继续用；`fallback` 只有在开启 CircuitBreaker（Resilience4j）或 Sentinel 集成后才生效
- 写接口的降级不能静默返回成功；默认超时过大，必须按服务显式配置
- `RequestContextHolder` 是线程绑定的，异步与线程池场景要显式传递请求头
- gRPC 消除了 HTTP 层队头阻塞，TCP 层仍有；Protobuf 收益需实测；Dubbo 3 Triple 兼容 gRPC，当前基于 Boot 3.5
- 非核心链路用消息异步化，细节在消息队列模块与 Spring Cloud Stream

## 参考资料

- Spring Framework HTTP Service Clients：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)
- Spring Cloud LoadBalancer：[https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)
- Spring Cloud OpenFeign：[https://docs.spring.io/spring-cloud-openfeign/reference/](https://docs.spring.io/spring-cloud-openfeign/reference/)
- gRPC：[https://grpc.io/docs/](https://grpc.io/docs/)

> 下一篇：[配置中心](./4_config_center) —— 用 `spring.config.import` 接入 Nacos Config，理解 gRPC 推送下的配置刷新链路。

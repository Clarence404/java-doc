# 服务间通信

> 参考资料：
> * OpenFeign：[https://docs.spring.io/spring-cloud-openfeign/docs/current/reference/html/](https://docs.spring.io/spring-cloud-openfeign/docs/current/reference/html/)
> * gRPC 官方文档：[https://grpc.io/docs/](https://grpc.io/docs/)

---

## 一、通信模式概览

| 模式 | 协议 | 特点 | 适用 |
|------|------|------|------|
| **同步 HTTP** | REST / OpenFeign | 简单，生态广，可读性好 | 对外 API、内部简单调用 |
| **同步 RPC** | gRPC（HTTP/2 + Protobuf）| 高性能，强类型，支持流式 | 内部高频调用 |
| **异步消息** | Kafka / RocketMQ / RabbitMQ | 解耦，削峰，最终一致 | 事件驱动、跨服务异步 |

---

## 二、OpenFeign 声明式调用

OpenFeign 是 Spring Cloud 提供的声明式 HTTP 客户端，用接口 + 注解替代手写 HTTP 请求代码。

### 依赖

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

### 启用

```java
@SpringBootApplication
@EnableFeignClients
public class OrderApplication { ... }
```

### 声明 Feign 客户端

```java
// name 对应注册中心的服务名，path 对应服务的 context-path
@FeignClient(name = "user-service", path = "/users",
             fallback = UserClientFallback.class)
public interface UserClient {

    @GetMapping("/{id}")
    UserResponse getUser(@PathVariable("id") Long id);

    @PostMapping
    UserResponse createUser(@RequestBody CreateUserRequest request);

    @GetMapping("/batch")
    List<UserResponse> getUserBatch(@RequestParam("ids") List<Long> ids);
}
```

### 降级实现

```java
@Component
public class UserClientFallback implements UserClient {

    @Override
    public UserResponse getUser(Long id) {
        return UserResponse.empty(id);  // 返回兜底数据
    }

    @Override
    public UserResponse createUser(CreateUserRequest request) {
        throw new ServiceUnavailableException("用户服务暂时不可用");
    }

    @Override
    public List<UserResponse> getUserBatch(List<Long> ids) {
        return Collections.emptyList();
    }
}
```

### 配置调优

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
          user-service:               # 服务级覆盖
            read-timeout: 3000
      compression:
        request:
          enabled: true               # 开启请求压缩（Body > 2048 bytes 时）
        response:
          enabled: true
```

### 请求拦截器（透传 Token）

```java
@Component
public class FeignAuthInterceptor implements RequestInterceptor {

    @Override
    public void apply(RequestTemplate template) {
        // 从当前请求上下文取 Token，透传给下游服务
        ServletRequestAttributes attributes =
            (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attributes != null) {
            String token = attributes.getRequest().getHeader("Authorization");
            if (StringUtils.hasText(token)) {
                template.header("Authorization", token);
            }
        }
    }
}
```

---

## 三、gRPC

> 完整 Protobuf 定义 + Spring Boot 接入代码见 → [远程调用协议 - gRPC](../protocols/3_rpc_protocols.md)

gRPC 核心优势：
- **HTTP/2 多路复用**：同一连接并发多个请求，无队头阻塞
- **Protobuf 序列化**：比 JSON 体积小 3-10x，解析快 5-10x
- **强类型接口**：`.proto` 文件即契约，自动生成客户端/服务端代码
- **流式支持**：单向流（服务端推送）/ 双向流

### OpenFeign vs gRPC 选型

| 场景 | 推荐 |
|------|------|
| 对外暴露 API、浏览器直接调用 | OpenFeign（REST）|
| 内部服务间高频调用（> 1000 QPS）| gRPC |
| 需要双向流式传输 | gRPC |
| 团队全 Java，快速开发 | OpenFeign |
| 多语言混合（Java + Go + Python）| gRPC |

---

## 四、异步通信：消息中间件

消息队列适合以下场景：

```
下单 → 写订单库（同步）
     → 发 MQ 消息（异步）
           ├── 库存服务消费：扣减库存
           ├── 通知服务消费：发短信/邮件
           └── 积分服务消费：增加积分
```

| 优点 | 说明 |
|------|------|
| **解耦** | 下单服务不依赖库存/通知/积分服务的可用性 |
| **削峰** | 突发流量堆积在 MQ 中，消费者按自身处理能力消化 |
| **异步** | 用户不需要等待非核心链路（通知、积分）完成 |

> 详见：[消息队列](../messaging/0_mq.md)

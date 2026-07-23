# 服务治理

> 参考资料：
> * Sentinel：[https://sentinelguard.io/zh-cn/docs/introduction.html](https://sentinelguard.io/zh-cn/docs/introduction.html)
> * Spring Cloud LoadBalancer：[https://spring.io/projects/spring-cloud-commons](https://spring.io/projects/spring-cloud-commons)

---

## 一、服务治理全景

服务治理是保障微服务稳定运行的综合手段，覆盖从流量接入到服务下线的完整生命周期：

```
流量入口
    ↓
负载均衡 → 将请求分发到健康实例
    ↓
限流     → 超出阈值拒绝请求，保护服务不被压垮
    ↓
熔断降级 → 下游故障时快速失败，防止雪崩
    ↓
超时重试 → 临时故障自动重试，永久故障快速失败
    ↓
服务实例（含健康检查、优雅上下线）
```

---

## 二、负载均衡

### Spring Cloud LoadBalancer（替代 Ribbon）

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    loadbalancer:
      ribbon:
        enabled: false    # 禁用 Ribbon，使用 Spring Cloud LoadBalancer
```

### 常见负载均衡策略

| 策略 | 特点 | 适用 |
|------|------|------|
| **轮询（Round Robin）** | 依次分发，默认策略 | 实例性能相近 |
| **随机（Random）** | 随机选择实例 | 简单场景 |
| **加权轮询** | 按权重分发，性能强的实例多承担流量 | 实例配置不均 |
| **最少连接** | 选择当前活跃连接数最少的实例 | 长连接场景 |
| **一致性哈希** | 相同 key 始终路由到同一实例 | 有状态服务、缓存亲和性 |

### 自定义负载均衡（按版本路由，灰度发布）

```java
@Bean
public ReactorLoadBalancer<ServiceInstance> versionLoadBalancer(
        Environment environment, LoadBalancerClientFactory factory) {
    String serviceId = environment.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
    return new VersionLoadBalancer(factory.getLazyProvider(serviceId, ServiceInstanceListSupplier.class));
}

public class VersionLoadBalancer implements ReactorServiceInstanceLoadBalancer {
    @Override
    public Mono<Response<ServiceInstance>> choose(Request request) {
        // 从 Request Header 中取目标版本
        String targetVersion = extractVersionFromRequest(request);
        return serviceInstanceListSupplier.get()
            .next()
            .map(instances -> {
                List<ServiceInstance> matched = instances.stream()
                    .filter(i -> targetVersion.equals(i.getMetadata().get("version")))
                    .collect(Collectors.toList());
                if (matched.isEmpty()) matched = instances;  // 降级为全量
                return new DefaultResponse(matched.get(new Random().nextInt(matched.size())));
            });
    }
}
```

---

## 三、限流（Sentinel）

### 接入

```xml
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-sentinel</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    sentinel:
      transport:
        dashboard: localhost:8080    # Sentinel 控制台地址
      eager: true                    # 提前初始化，不等第一次请求
```

### 注解方式限流 + 降级

```java
@Service
public class OrderService {

    // 限流：QPS 超过 10 时执行 blockHandler
    @SentinelResource(
        value = "createOrder",
        blockHandler = "createOrderBlocked",
        fallback = "createOrderFallback"
    )
    public OrderResponse createOrder(CreateOrderRequest request) {
        // 核心业务逻辑
        return orderRepository.save(request);
    }

    // 限流时的处理（BlockException 必须是最后一个参数）
    public OrderResponse createOrderBlocked(CreateOrderRequest request, BlockException ex) {
        log.warn("Order creation rate limited: {}", ex.getClass().getSimpleName());
        throw new RateLimitException("系统繁忙，请稍后重试");
    }

    // 降级时的处理（下游异常 / 慢调用）
    public OrderResponse createOrderFallback(CreateOrderRequest request, Throwable ex) {
        log.error("Order creation fallback triggered", ex);
        return OrderResponse.degraded("服务暂时不可用，请稍后重试");
    }
}
```

### 限流规则动态推送（Nacos 数据源）

```yaml
spring:
  cloud:
    sentinel:
      datasource:
        flow:
          nacos:
            server-addr: localhost:8848
            data-id: ${spring.application.name}-flow-rules
            group-id: SENTINEL_GROUP
            data-type: json
            rule-type: flow
```

---

## 四、超时与重试

### OpenFeign 超时配置

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:                       # 全局默认
            connect-timeout: 2000        # 连接超时 2s
            read-timeout: 5000           # 读取超时 5s
          payment-service:               # 服务级覆盖
            read-timeout: 10000          # 支付服务允许更长超时
```

### 重试策略

```java
@Configuration
public class FeignConfig {
    @Bean
    public Retryer feignRetryer() {
        // 初始间隔 100ms，最大间隔 1s，最多重试 3 次
        return new Retryer.Default(100, 1000, 3);
    }
}
```

**重试注意事项**：
- 只对幂等接口（GET / 查询类）开启重试
- POST / 写操作**不能**自动重试，需业务层保证幂等后再重试

---

## 五、优雅上下线

```
优雅上线（预热）：
  服务启动后流量逐渐增大，避免冷启动时大量请求打到未预热的实例
  Sentinel 支持 Warm Up 模式（启动后 10s 内逐步达到配置的 QPS 上限）

优雅下线（排水）：
  1. 从注册中心注销（停止接入新流量）
  2. 等待进行中请求完成（设置排水时间，通常 10-30s）
  3. 进程退出
```

```yaml
# Spring Boot 内置优雅停机
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s    # 等待进行中请求完成的最大时间
```

---

## 六、服务版本与兼容性

| 策略 | 说明 |
|------|------|
| **语义版本（SemVer）** | Major.Minor.Patch，破坏性变更升 Major |
| **API 版本** | URL 路径版本（`/v1/`，`/v2/`），并行运行新旧版本 |
| **向后兼容** | 新增字段不删除旧字段；Protobuf 字段编号不变 |
| **Consumer-Driven Contract** | 用 Pact 等工具确保 Provider 变更不破坏 Consumer |

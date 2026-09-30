# 服务治理

> 参考资料：
> * Spring Cloud LoadBalancer：[https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)
> * Resilience4j：[https://resilience4j.readme.io/docs](https://resilience4j.readme.io/docs)
> * Sentinel：[https://sentinelguard.io/zh-cn/docs/introduction.html](https://sentinelguard.io/zh-cn/docs/introduction.html)

本篇讲 Spring Cloud 中服务治理能力的**框架落地**：Spring Cloud LoadBalancer 的配置与自定义、灰度路由、Resilience4j 接入。各项手段的原理、选型与阈值怎么定，见 [高可用](/high-avail/0_overview) 模块。

---

## 一、服务治理全景

服务治理覆盖一次调用从进入系统到落到实例的全过程：

![服务治理全景](../assets/spring-cloud/governance-overview.svg)

| 环节 | Spring Cloud 落地 | 原理与策略 |
|------|------------------|-----------|
| 负载均衡 | Spring Cloud LoadBalancer | [高可用 - 负载均衡](/high-avail/3_load_balancing) |
| 限流 | Sentinel、Gateway `RequestRateLimiter` | [高可用 - 限流与过载保护](/high-avail/7_rate_limiting) |
| 熔断降级 | Resilience4j、Sentinel | [高可用 - 熔断](/high-avail/5_circuit_breaking)、[降级](/high-avail/6_degradation) |
| 超时重试与隔离 | OpenFeign 超时、Resilience4j Retry / Bulkhead | [高可用 - 超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead) |
| 健康检查与上下线 | Actuator 探针、优雅停机 | [高可用 - 冗余与故障转移](/high-avail/2_redundancy_failover)、[优雅上下线与变更](/high-avail/8_graceful_release) |

---

## 二、负载均衡：Spring Cloud LoadBalancer

Spring Cloud LoadBalancer（SCL）是客户端负载均衡：调用方从注册中心获取实例列表，在本进程内选择实例。它替代了已停止维护的 Ribbon，Spring Cloud 2020.0 起 Ribbon 已被移除，无需再做任何"关闭 Ribbon"的配置。

### 1、接入与实例缓存

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
<!-- 生产环境建议引入 Caffeine，SCL 会用它作为实例列表缓存；缺少时使用默认缓存并在启动日志中告警 -->
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    loadbalancer:
      cache:
        enabled: true
        ttl: 35s          # 实例列表缓存时间，也是实例下线后调用方的最长感知延迟之一
        capacity: 256
```

`ttl` 越长，注册中心压力越小，但实例下线后调用方越晚感知。注册中心推送、客户端缓存叠加起来的总延迟，决定了优雅下线时需要等待多久，见 [优雅上下线与变更](/high-avail/8_graceful_release)。

### 2、内置能力

| 能力 | 开启方式 | 说明 |
|------|---------|------|
| 轮询 | 默认 | `RoundRobinLoadBalancer` |
| 随机 | 自定义配置返回 `RandomLoadBalancer` | 见下方示例 |
| 区域优先 | `spring.cloud.loadbalancer.configurations: zone-preference` | 优先选择元数据 `zone` 与调用方相同的实例，同区无实例时使用全部实例 |
| 主动健康检查 | `configurations: health-check` | SCL 自行探测实例健康端点，适合实例列表不来自注册中心的场景 |
| 同实例优先 | `configurations: same-instance-preference` | 重试时优先选择上次的实例 |
| 基于请求的粘滞 | `configurations: request-based-sticky-session` | 按 Cookie 中的实例 ID 路由 |
| Hint 路由 | 构建器 `withHints()` | 按请求头与实例元数据 `hint` 匹配 |
| 加权 | 构建器 `withWeighted()`（较新版本提供，使用前确认版本） | 按实例元数据 `weight` 加权 |

指定某个服务使用随机策略：

```java
// 不要加 @Configuration，也不要放在组件扫描路径下，否则会变成所有服务共用的全局配置
public class RandomLoadBalancerConfig {

    @Bean
    public ReactorLoadBalancer<ServiceInstance> randomLoadBalancer(Environment env,
                                                                   LoadBalancerClientFactory factory) {
        String serviceId = env.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
        return new RandomLoadBalancer(
            factory.getLazyProvider(serviceId, ServiceInstanceListSupplier.class), serviceId);
    }
}

@Configuration
@LoadBalancerClient(name = "order-service", configuration = RandomLoadBalancerConfig.class)
public class LoadBalancerClientsConfig {
}
```

### 3、区域优先与 Hint 路由

**区域优先和简单的按标签路由不需要自己写负载均衡器，用内置的实例列表过滤器组合即可。**

```yaml
spring:
  cloud:
    loadbalancer:
      zone: zone-a                        # 调用方所在区域
      hint-header-name: X-Version         # 从该请求头读取 hint，默认 X-SC-LB-Hint
```

```java
// 实例列表过滤链：注册中心 → 区域优先 → Hint 匹配 → 缓存
public class GovernanceLoadBalancerConfig {

    @Bean
    public ServiceInstanceListSupplier serviceInstanceListSupplier(ConfigurableApplicationContext context) {
        return ServiceInstanceListSupplier.builder()
            .withDiscoveryClient()
            .withZonePreference()
            .withHints()
            .withCaching()
            .build(context);
    }
}

@Configuration
@LoadBalancerClients(defaultConfiguration = GovernanceLoadBalancerConfig.class)
public class LoadBalancerClientsConfig {
}
```

实例侧在注册元数据中声明区域与标签，例如 Nacos：

```yaml
spring:
  cloud:
    nacos:
      discovery:
        metadata:
          zone: zone-a
          hint: gray          # 灰度实例；请求头 X-Version: gray 时优先路由到这里
```

Hint 过滤在找不到匹配实例时会返回全部实例，适合"灰度实例不可用就回到稳定版本"的场景。

### 4、自定义负载均衡器：灰度路由

**规则超出"元数据等值匹配"时（按用户 ID 百分比放量、无标记请求必须避开灰度实例），实现 `ReactorServiceInstanceLoadBalancer`。**

```java
/**
 * 灰度负载均衡：
 * 1. 请求头 X-Version 有值 → 优先路由到元数据 version 相同的实例
 * 2. 无标记请求 → 只路由到非灰度实例，避免普通流量打到灰度版本
 * 3. 候选为空时回退到全部实例
 */
@Slf4j
public class GrayLoadBalancer implements ReactorServiceInstanceLoadBalancer {

    private static final String VERSION_HEADER = "X-Version";
    private static final String VERSION_KEY = "version";
    private static final String GRAY = "gray";

    private final ObjectProvider<ServiceInstanceListSupplier> supplierProvider;
    private final String serviceId;

    public GrayLoadBalancer(ObjectProvider<ServiceInstanceListSupplier> supplierProvider, String serviceId) {
        this.supplierProvider = supplierProvider;
        this.serviceId = serviceId;
    }

    @Override
    public Mono<Response<ServiceInstance>> choose(Request request) {
        ServiceInstanceListSupplier supplier =
            supplierProvider.getIfAvailable(NoopServiceInstanceListSupplier::new);
        String version = extractVersion(request);
        return supplier.get(request).next().map(instances -> select(instances, version));
    }

    private String extractVersion(Request request) {
        if (request.getContext() instanceof RequestDataContext context) {
            return context.getClientRequest().getHeaders().getFirst(VERSION_HEADER);
        }
        return null;
    }

    private Response<ServiceInstance> select(List<ServiceInstance> instances, String version) {
        if (instances.isEmpty()) {
            log.warn("没有可用实例 serviceId={}", serviceId);
            return new EmptyResponse();
        }
        List<ServiceInstance> candidates = instances.stream()
            .filter(i -> {
                String v = i.getMetadata().get(VERSION_KEY);
                return version != null ? version.equals(v) : !GRAY.equals(v);
            })
            .toList();
        if (candidates.isEmpty()) {
            candidates = instances;
        }
        ServiceInstance chosen = candidates.get(ThreadLocalRandom.current().nextInt(candidates.size()));
        return new DefaultResponse(chosen);
    }
}

// 注册：同样不加 @Configuration
public class GrayLoadBalancerConfig {

    @Bean
    public ReactorLoadBalancer<ServiceInstance> grayLoadBalancer(Environment env,
                                                                 LoadBalancerClientFactory factory) {
        String serviceId = env.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
        return new GrayLoadBalancer(
            factory.getLazyProvider(serviceId, ServiceInstanceListSupplier.class), serviceId);
    }
}

@Configuration
@LoadBalancerClients(defaultConfiguration = GrayLoadBalancerConfig.class)
public class GrayLoadBalancerClientsConfig {
}
```

`RequestDataContext` 由 Gateway、`WebClient`、`RestTemplate` 与 OpenFeign 的负载均衡集成负责构造，请求头可以直接读到。

### 5、灰度标记透传

**只有入口带灰度标记是不够的，每一跳都要把标记传给下一跳**，否则第二跳之后就回到了稳定版本。

```java
// OpenFeign：把当前请求的灰度标记透传给下游
@Component
public class GrayHeaderInterceptor implements RequestInterceptor {

    private static final String VERSION_HEADER = "X-Version";

    @Override
    public void apply(RequestTemplate template) {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
            String version = attrs.getRequest().getHeader(VERSION_HEADER);
            if (version != null) {
                template.header(VERSION_HEADER, version);
            }
        }
    }
}
```

- `RequestContextHolder` 绑定在请求线程上，切换到线程池执行时会丢失，异步场景需要用 TransmittableThreadLocal 或链路追踪的 Baggage 传递
- MQ 消息同样要把标记写进消息头，消费端按标记选择灰度或稳定的消费组

---

## 三、限流与熔断

**Spring Cloud 中常用两套方案：Resilience4j（配合 Spring Cloud CircuitBreaker 抽象）与 Sentinel。** 选型取决于是否需要控制台与动态规则。

| 对比 | Resilience4j | Sentinel |
|------|-------------|----------|
| 能力 | 熔断、重试、限流、舱壁（信号量 / 线程池）、TimeLimiter | 流控、熔断、热点参数限流、系统自适应保护 |
| 规则配置 | 配置文件为主，改动需重新加载配置 | 控制台 + 动态数据源（Nacos 等） |
| 可观测 | 通过 Micrometer 暴露指标 | 自带控制台实时监控 |
| 适合 | 规则相对固定、希望轻量无外部组件 | 需要运营期动态调整规则、国内 Alibaba 技术栈 |

Resilience4j 注解接入（依赖 `resilience4j-spring-boot3` 与 `spring-boot-starter-aop`）：

```java
@Service
@Slf4j
public class InventoryFacade {

    @CircuitBreaker(name = "inventory", fallbackMethod = "queryFallback")
    public Stock query(Long skuId) {
        return inventoryClient.query(skuId);
    }

    private Stock queryFallback(Long skuId, Throwable e) {
        log.warn("库存查询降级 skuId={}, cause={}", skuId, e.toString());
        return Stock.unknown(skuId);
    }
}
```

```yaml
resilience4j:
  circuitbreaker:
    instances:
      inventory:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 50              # 统计最近 50 次调用
        minimum-number-of-calls: 20          # 样本不足 20 次不计算失败率
        failure-rate-threshold: 50           # 失败率 ≥ 50% 打开熔断
        slow-call-duration-threshold: 1s
        slow-call-rate-threshold: 50         # 慢调用比例 ≥ 50% 也打开熔断
        wait-duration-in-open-state: 10s     # 打开 10s 后进入半开
        permitted-number-of-calls-in-half-open-state: 5
```

- 熔断阈值怎么定、Sentinel 与 Resilience4j 的详细对比见 [高可用 - 熔断](/high-avail/5_circuit_breaking)
- Sentinel 的资源定义、规则类型、Nacos 规则持久化与 OpenFeign 集成见 [Spring Cloud Alibaba](./6_alibaba)
- 限流算法与阈值见 [高可用 - 限流与过载保护](/high-avail/7_rate_limiting)

---

## 四、超时与重试

OpenFeign 默认超时（连接 10s、读取 60s）远大于合理值，必须按服务显式配置；Spring Cloud OpenFeign 默认使用 `Retryer.NEVER_RETRY` 不重试，需要重试时只对幂等接口开启，并控制重试放大。超时取值、分层超时推导、退避与重试预算见 [高可用 - 超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)，Feign 的超时配置项见 [服务通信](./3_communication)。

---

## 五、优雅上下线

上线先预热再放量，下线先注销、等调用方刷新实例列表，再处理完在途请求后退出：

![优雅上下线流程](../assets/spring-cloud/graceful-online-offline.svg)

停机顺序、`server.shutdown: graceful`、K8s `preStop`、预热与权重爬升的完整说明见 [高可用 - 优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 六、服务版本与兼容性

| 策略 | 说明 |
|------|------|
| **语义版本（SemVer）** | Major.Minor.Patch，破坏性变更升 Major |
| **API 版本** | URL 路径版本（`/v1/`，`/v2/`），并行运行新旧版本 |
| **向后兼容** | 新增字段不删除旧字段；Protobuf 字段编号不变 |
| **Consumer-Driven Contract** | 用 Pact 等工具确保 Provider 变更不破坏 Consumer |

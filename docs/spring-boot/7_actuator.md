---
description: 端点暴露与访问控制、健康检查、存活 / 就绪探针、自定义端点、Micrometer 指标、端点安全
---

# Actuator 监控

> **本篇目标**：掌握 Boot 4 下 Actuator 的暴露与访问模型，用好内置健康检查和存活 / 就绪探针，写出能编译、标签规范的 Micrometer 业务指标，并把管理端点安全地开放给运维与监控系统。
>
> **前置阅读**：[配置管理](./6_config)

> 参考资料：
> * Spring Boot Actuator：[https://docs.spring.io/spring-boot/reference/actuator/index.html](https://docs.spring.io/spring-boot/reference/actuator/index.html)
> * Actuator Endpoints：[https://docs.spring.io/spring-boot/reference/actuator/endpoints.html](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
> * Actuator Metrics：[https://docs.spring.io/spring-boot/reference/actuator/metrics.html](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
> * Micrometer：[https://docs.micrometer.io/micrometer/reference/](https://docs.micrometer.io/micrometer/reference/)

本篇以 Spring Boot 4.x 为基线，3.x 的差异在对应位置标出。指标与链路在平台侧的采集、存储与告警见 [指标监控](/observability/2_metrics) 与 [链路追踪](/observability/3_tracing)，本篇只讲应用侧。

---

## 一、接入、暴露与访问控制

### 1、引入依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

### 2、暴露与访问是两件事

| 维度 | 含义 | 配置 |
|------|------|------|
| 暴露（exposure） | 端点能否通过 HTTP / JMX 被访问到 | `management.endpoints.web.exposure.include` / `exclude` |
| 访问（access，3.4+） | 端点允许哪些操作 | `management.endpoint.<id>.access`：`none` / `read-only` / `unrestricted` |

默认情况下 HTTP 上**只暴露 `health`**；访问级别方面，除 `shutdown` 与 `heapdump` 外都是 `unrestricted`（`heapdump` 从 3.5 起默认 `none`）。

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus,loggers
      base-path: /actuator
    access:
      default: read-only          # 全局默认只读，写操作逐个放开
      max-permitted: read-only    # 全局上限：任何端点都不能超过只读（生产推荐）
  endpoint:
    loggers:
      access: unrestricted        # 允许 POST 调整日志级别（需在 max-permitted 之内）
    health:
      show-details: when-authorized
      roles: OPS
```

`max-permitted` 是整个应用的上限，上例中 `loggers` 实际仍只能只读；需要在线调整日志级别时，把 `max-permitted` 放宽到 `unrestricted`，再用 `default: read-only` 控制其余端点。

Boot 3.4 之前用 `management.endpoint.<id>.enabled`（如 `management.endpoint.shutdown.enabled=true`）开关端点，该属性在 3.4 废弃；`management.endpoints.web.exposure.include: "*"` 在任何版本都不该用于生产。

### 3、独立管理端口

```yaml
management:
  server:
    port: 8081            # 管理端点走独立端口，只在集群内网开放
```

独立端口后，网关和 Ingress 只转发业务端口，Prometheus、K8s 探针访问管理端口，从网络层隔开业务流量与运维流量。

---

## 二、常用端点

| 端点 | 说明 | 生产建议 |
|------|------|---------|
| `health` | 健康状态与探针分组 | 暴露，细节需鉴权 |
| `info` | 构建信息、Git 信息、自定义 `info.*` | 暴露 |
| `metrics` | 指标列表，`/metrics/{name}` 查单个指标 | 鉴权 |
| `prometheus` | Prometheus 文本格式指标 | 暴露给抓取方，走管理端口 |
| `loggers` | 查看 / 在线调整日志级别 | 鉴权，用完恢复 |
| `env` / `configprops` | 配置属性与来源，值默认脱敏 | 鉴权，不改 `show-values` |
| `beans` / `conditions` | Bean 列表、自动配置条件评估报告 | 排障时临时开放 |
| `mappings` | 全部请求映射 | 排障时临时开放 |
| `scheduledtasks` | `@Scheduled` 任务清单 | 鉴权 |
| `caches` | 缓存管理器与缓存名 | 鉴权 |
| `startup` | 启动步骤耗时（需 `BufferingApplicationStartup`） | 启动优化时开放，见 [启动与部署优化](./14_startup) |
| `httpexchanges` | 最近的 HTTP 请求（3.0 前叫 `httptrace`，需提供 `HttpExchangeRepository` Bean） | 一般不开 |
| `sbom`（3.3+） | 软件物料清单，用于漏洞扫描 | 鉴权 |
| `threaddump` | 线程转储 | 鉴权 |
| `heapdump` | 堆转储，可能包含密码、Token 等内存数据 | 默认 `none`，不要开放 |
| `shutdown` | 优雅关闭应用 | 默认 `none`，不要开放 |

`env`、`configprops`、`quartz` 的值从 Boot 3.0 起默认显示为 `******`，由 `management.endpoint.<id>.show-values`（`never` / `when-authorized` / `always`）控制。

```bash
# 在线调整日志级别（需 loggers 为 unrestricted 且已鉴权）
curl -X POST http://localhost:8081/actuator/loggers/com.example.order \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":"DEBUG"}'
```

日志级别的分组与用法见 [日志](./12_logging)。

---

## 三、健康检查

### 1、内置健康指示器

引入对应依赖后自动注册，不需要自己写：

| key | 条件 | 检查方式 |
|-----|------|---------|
| `db` | 有 `DataSource` | 借连接执行 `Connection#isValid` 或配置的校验查询 |
| `redis` | 有 Redis 连接工厂 | 执行 `PING` / 读取服务器信息 |
| `rabbit` / `mongodb` / `elasticsearch` | 对应客户端存在 | 连接并读取版本等信息 |
| `diskspace` | 默认开启 | 剩余空间低于阈值（默认 10MB）时 DOWN |
| `ping` | 默认开启 | 恒为 UP |
| `ssl` | 配置了 SSL Bundle | 证书过期为 DOWN，临近过期给出警告 |
| `livenessstate` / `readinessstate` | 探针开启时 | 应用可用性状态，见第四节 |

用 `management.health.<key>.enabled=false` 关闭单个指示器。**不要再写一个叫 `database` / `redis` 的自定义指示器去重复检查**：内置的不会因此被替换，`/health` 里会出现两份，还多一倍连接开销。

### 2、自定义业务健康检查

自定义指示器适合检查内置没覆盖的东西，例如核心下游、消息积压：

```java
import java.time.Duration;
import org.springframework.boot.health.contributor.AbstractHealthIndicator;   // Boot 4
import org.springframework.boot.health.contributor.Health;
import org.springframework.stereotype.Component;

// Bean 名去掉 HealthIndicator 后缀即为 key：/actuator/health 中显示为 orderBacklog
@Component
public class OrderBacklogHealthIndicator extends AbstractHealthIndicator {

    private static final long DOWN_THRESHOLD = 10_000;

    private final OrderQueueService queueService;

    public OrderBacklogHealthIndicator(OrderQueueService queueService) {
        super("订单积压检查失败");
        this.queueService = queueService;
    }

    @Override
    protected void doHealthCheck(Health.Builder builder) {
        long backlog = queueService.pendingCount();      // 必须是快速、带超时的检查
        builder.withDetail("backlog", backlog)
               .withDetail("threshold", DOWN_THRESHOLD);
        if (backlog > DOWN_THRESHOLD) {
            builder.down();
        } else {
            builder.up();
        }
    }
}
```

- **Boot 4 的包名**：健康相关类迁到独立的 `spring-boot-health` 模块，包名从 `org.springframework.boot.actuate.health` 变为 `org.springframework.boot.health.contributor`；Boot 3.x 用前者
- `AbstractHealthIndicator` 会把 `doHealthCheck` 抛出的异常转成 DOWN，比自己 try/catch 更省事
- detail 只放诊断需要的数字，**不要放连接串、主机名、账号**——`show-details` 一旦放开，这些都会暴露
- 健康检查会被探针和负载均衡高频调用，检查逻辑要快；慢检查不要放进存活探针

开启细节后 `/actuator/health` 的输出形如（`diskSpace` 的数值单位是字节）：

```json
{
  "status": "UP",
  "components": {
    "db": { "status": "UP", "details": { "database": "MySQL", "validationQuery": "isValid()" } },
    "diskSpace": { "status": "UP", "details": { "total": 536870912000, "free": 214748364800, "threshold": 10485760 } },
    "orderBacklog": { "status": "UP", "details": { "backlog": 1280, "threshold": 10000 } },
    "ping": { "status": "UP" }
  }
}
```

---

## 四、存活 / 就绪探针与健康分组

### 1、探针

| 分组 | 路径 | 含义 | 失败后果 |
|------|------|------|---------|
| `liveness` | `/actuator/health/liveness` | 进程是否还活着、能否自愈 | K8s 重启容器 |
| `readiness` | `/actuator/health/readiness` | 是否可以接收流量 | 从 Service 端点中摘除，不重启 |

Boot 4 起探针分组**默认开启**（3.x 只在检测到 Kubernetes 环境时自动开启，其他环境需 `management.endpoint.health.probes.enabled=true`）。设置 `management.endpoint.health.probes.add-additional-paths=true` 后，还会在**业务端口**上提供 `/livez`、`/readyz`，适合探针必须走业务端口的场景。

### 2、分组里放什么

```yaml
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState,db,redis   # 就绪：依赖不可用就先摘流量
        liveness:
          include: livenessState             # 存活：只看应用自身，不放外部依赖
```

**外部依赖不要放进存活探针**：数据库抖动时，存活失败会让所有 Pod 被同时重启，把一次依赖故障放大成全量重启。

### 3、K8s 配置示例

```yaml
startupProbe:                      # 慢启动应用先由 startupProbe 兜住，成功后才开始存活检查
  httpGet: { path: /actuator/health/liveness, port: 8081 }
  periodSeconds: 5
  failureThreshold: 30
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8081 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8081 }
  periodSeconds: 5
```

应用可以通过发布 `AvailabilityChangeEvent` 主动切换就绪状态（例如预热完成后再 `ACCEPTING_TRAFFIC`）。停机时就绪状态如何先于连接关闭、与 K8s 的 `preStop` 怎么配合，见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 五、自定义端点

```java
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.actuate.endpoint.annotation.Endpoint;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.annotation.Selector;
import org.springframework.boot.actuate.endpoint.annotation.WriteOperation;
import org.springframework.stereotype.Component;

@Component
@Endpoint(id = "localcache")      // id 用小写字母，避免驼峰和连字符
public class LocalCacheEndpoint {

    private final LocalCacheManager cacheManager;

    public LocalCacheEndpoint(LocalCacheManager cacheManager) {
        this.cacheManager = cacheManager;
    }

    // GET /actuator/localcache
    @ReadOperation
    public Map<String, Object> summary() {
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        return Map.of(
            "caches", cacheManager.names(),
            "heapUsedBytes", memory.getHeapMemoryUsage().getUsed());
    }

    // GET /actuator/localcache/{name}
    @ReadOperation
    public Map<String, Object> stats(@Selector String name) {
        return Map.of("name", name, "size", cacheManager.size(name));
    }

    // POST /actuator/localcache，body: {"name": "product"}；不传 name 则清空全部
    @WriteOperation
    public void evict(@Nullable String name) {
        if (name == null) {
            cacheManager.clearAll();
        } else {
            cacheManager.clear(name);
        }
    }
}
```

- Boot 4 中可选参数必须用 `org.jspecify.annotations.Nullable` 标注；Spring 自己的 `org.springframework.lang.Nullable` 不再被识别，参数会变成必填
- 写操作受访问级别约束：上例要能 POST，需要 `management.endpoint.localcache.access=unrestricted`，并在 `exposure.include` 中加入 `localcache`
- CPU、内存、线程数这类通用数据不必自己写端点，内置指标 `process.cpu.usage`、`jvm.memory.used`、`jvm.threads.live` 已经有了

---

## 六、指标：Micrometer 与 Prometheus

![指标链路](../assets/spring-boot/actuator-metrics-pipeline.svg)

### 1、接入 Prometheus

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  prometheus:
    metrics:
      export:
        enabled: true          # 默认即为 true，有依赖就生效
  metrics:
    tags:
      application: ${spring.application.name}   # 所有指标附加公共标签
    distribution:
      percentiles-histogram:
        http.server.requests: true              # 输出直方图桶，在 Prometheus 侧算 P99
```

Boot 2.x 的 `management.metrics.export.prometheus.enabled` 在 3.0 改为 `management.prometheus.metrics.export.enabled`，旧键在 3.x / 4.x 中不再生效。环境区分建议在 Prometheus 抓取配置里加 `env` 标签，而不是在应用里写 `${spring.profiles.active}`（多 Profile 时会拼成逗号串）。

### 2、自定义业务指标

Boot 会自动配置 `MeterRegistry`，直接注入；Meter 在构造器里创建并赋给 final 字段：

```java
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final MeterRegistry registry;
    private final Timer createTimer;
    private final Queue<Long> pendingOrders = new ConcurrentLinkedQueue<>();

    public OrderService(MeterRegistry registry) {
        this.registry = registry;
        this.createTimer = Timer.builder("order.create.duration")
                .description("下单耗时")
                .publishPercentileHistogram()           // 交给 Prometheus 计算分位数
                .register(registry);
        Gauge.builder("order.pending.size", pendingOrders, Queue::size)
                .description("待处理订单数")
                .register(registry);                    // Gauge 持有对象的弱引用，对象需被其他地方强引用
    }

    public OrderVO create(OrderCreateDTO dto) {
        return createTimer.record(() -> {
            try {
                OrderVO vo = doCreate(dto);
                countCreated(dto.channel(), "success");
                return vo;
            } catch (RuntimeException e) {
                countCreated(dto.channel(), "failure");
                throw e;
            }
        });
    }

    // 同一个指标名始终使用同一组标签键（channel + result）
    private void countCreated(String channel, String result) {
        Counter.builder("order.created")
               .description("下单次数")
               .tag("channel", channel)
               .tag("result", result)
               .register(registry)                      // 相同名称与标签会返回已注册的同一个 Counter
               .increment();
    }

    private OrderVO doCreate(OrderCreateDTO dto) { /* 业务逻辑 */ return null; }
}
```

指标设计的三条规则：

- **同名同键**：同一指标名的标签键集合必须一致，Prometheus 注册表遇到不一致的键会注册失败（视 Micrometer 版本抛异常或丢弃该指标）
- **标签值有限**：`channel`、`result` 这种枚举值可以，用户 ID、订单号、完整 URL 不行——每个组合都是一条时间序列，高基数会拖垮 Prometheus
- **命名用点分小写**：`order.created` 在 Prometheus 中会被转成 `order_created_total`，不要自己加 `_total` 后缀

依赖其他 Bean 才能计算的指标（如某个队列长度），也可以声明 `MeterBinder` Bean，由 Boot 在合适的时机绑定。

### 3、Observation API

Micrometer 1.10 起的 Observation API 一次埋点同时产出指标（Timer）和链路 Span，Spring MVC、`RestClient`、Kafka 等组件内部都基于它：

```java
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;

@Service
public class PaymentService {

    private final ObservationRegistry observationRegistry;

    public PaymentService(ObservationRegistry observationRegistry) {
        this.observationRegistry = observationRegistry;
    }

    public PayResult pay(PayCommand cmd) {
        return Observation.createNotStarted("payment.pay", observationRegistry)
                .lowCardinalityKeyValue("channel", cmd.channel())     // 进指标和 Span
                .highCardinalityKeyValue("orderNo", cmd.orderNo())    // 只进 Span，不进指标
                .observe(() -> doPay(cmd));
    }

    private PayResult doPay(PayCommand cmd) { /* 调用支付渠道 */ return null; }
}
```

也可以在方法上加 `@Observed(name = "payment.pay")`，需要 `spring-boot-starter-aspectj`（Boot 3.x 为 `spring-boot-starter-aop`）并设置 `management.observations.annotations.enabled=true`。高 / 低基数的区分正是上一小节「标签值有限」规则的落地。链路追踪的接入与 traceId 写入日志见 [日志](./12_logging) 和 [链路追踪](/observability/3_tracing)。

### 4、Prometheus 抓取与 Grafana

```yaml
# prometheus.yml
scrape_configs:
  - job_name: order-service
    metrics_path: /actuator/prometheus
    scrape_interval: 15s
    static_configs:
      - targets: ['order-service:8081']
        labels:
          env: prod
```

K8s 中通常用 Prometheus Operator 的 `ServiceMonitor` / `PodMonitor` 做服务发现，而不是静态地址。Grafana 可以先导入社区维护的 JVM（Micrometer）看板起步，再按业务指标自建看板；社区看板的指标名可能随 Micrometer 版本变化，导入后需核对。

---

## 七、端点安全

引入 Spring Security 后，若没有自定义 `SecurityFilterChain`，Boot 默认保护除 `/health` 外的全部端点。自定义时用 `EndpointRequest` 单独为管理端点建一条过滤链：

```java
import static org.springframework.security.config.Customizer.withDefaults;

import org.springframework.boot.security.autoconfigure.actuate.web.servlet.EndpointRequest;  // Boot 4
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration(proxyBeanMethods = false)
public class ActuatorSecurityConfig {

    @Bean
    @Order(1)
    public SecurityFilterChain actuatorFilterChain(HttpSecurity http) throws Exception {
        http.securityMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(EndpointRequest.to("health", "info", "prometheus")).permitAll()
                .anyRequest().hasRole("OPS"))
            .httpBasic(withDefaults());
        return http.build();
    }
}
```

Boot 3.x 中 `EndpointRequest` 位于 `org.springframework.boot.actuate.autoconfigure.security.servlet`。即使 `prometheus` 放行，也应配合独立管理端口与网络策略，只让监控系统访问。SecurityFilterChain 的基础见 [Security](/spring/9_security)。

---

## 小结

- 暴露（exposure）决定能否访问，访问级别（access，3.4+）决定能做什么；生产用 `max-permitted` 设上限，默认只暴露 `health`
- `heapdump`、`shutdown` 默认不可访问，不要开放；`env` / `configprops` 默认脱敏
- 数据库、Redis 等健康检查是内置的，自定义指示器只写业务检查；Boot 4 的健康类在 `org.springframework.boot.health.contributor`
- Boot 4 探针默认开启；存活探针只看自身，外部依赖放就绪分组
- 自定义端点 id 用小写，可选参数用 JSpecify 的 `@Nullable`，写操作需要 `unrestricted`
- 业务指标：注入 `MeterRegistry`、构造器创建 Meter、同名同键、标签低基数；Observation 一次埋点产出指标与 Span
- Prometheus 开关是 `management.prometheus.metrics.export.enabled`；管理端点走独立端口并用 `EndpointRequest` 鉴权

> 下一篇：[自定义 Starter](./8_custom_starter) —— 把通用能力封装成可插拔的自动配置，理解 Boot 是如何装配那上百个组件的。

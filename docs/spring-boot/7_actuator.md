# Actuator 监控

> 参考资料：
> * Spring Boot Actuator：[https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html](https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html)
> * Micrometer：[https://micrometer.io/](https://micrometer.io/)

## 一、快速接入

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,loggers,env,beans
        # include: "*"  暴露全部（生产慎用）
      base-path: /actuator
  endpoint:
    health:
      show-details: when-authorized   # always / never / when-authorized
    shutdown:
      enabled: false   # 禁止远程关闭
  info:
    env:
      enabled: true    # 允许 /info 读取 info.* 配置

info:
  app:
    name: my-service
    version: 1.0.0
    description: 示例服务
```

---

## 二、核心端点

| 端点 | 说明 |
|------|------|
| `/actuator/health` | 健康检查（UP / DOWN / UNKNOWN） |
| `/actuator/info` | 应用信息 |
| `/actuator/metrics` | 运行指标，`/metrics/{name}` 查具体指标 |
| `/actuator/env` | 环境变量与配置属性 |
| `/actuator/beans` | 查看所有 Bean |
| `/actuator/loggers` | 查看 / 动态调整日志级别 |
| `/actuator/mappings` | 查看所有 URL 映射 |
| `/actuator/threaddump` | 线程 dump |
| `/actuator/heapdump` | 堆 dump（谨慎暴露） |

```bash
# 动态调整日志级别（无需重启）
curl -X POST http://localhost:8080/actuator/loggers/com.example.service \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":"DEBUG"}'
```

---

## 三、自定义健康检查

```java
@Component("database")
public class DatabaseHealthIndicator implements HealthIndicator {

    private final DataSource dataSource;

    public DatabaseHealthIndicator(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public Health health() {
        try (Connection conn = dataSource.getConnection()) {
            boolean valid = conn.isValid(2);   // 2 秒超时
            if (valid) {
                return Health.up()
                    .withDetail("database", conn.getMetaData().getDatabaseProductName())
                    .withDetail("url", conn.getMetaData().getURL())
                    .build();
            }
            return Health.down().withDetail("reason", "连接校验失败").build();
        } catch (SQLException e) {
            return Health.down(e).withDetail("reason", e.getMessage()).build();
        }
    }
}

// Redis 健康检查
@Component("redis")
public class RedisHealthIndicator implements HealthIndicator {

    private final RedisTemplate<String, Object> redisTemplate;

    @Override
    public Health health() {
        try {
            redisTemplate.opsForValue().get("health-check-probe");
            return Health.up().withDetail("ping", "PONG").build();
        } catch (Exception e) {
            return Health.down().withDetail("error", e.getMessage()).build();
        }
    }
}
```

访问 `/actuator/health` 返回：

```json
{
  "status": "UP",
  "components": {
    "database": { "status": "UP", "details": { "database": "MySQL", "url": "..." } },
    "redis":    { "status": "UP", "details": { "ping": "PONG" } },
    "diskSpace": { "status": "UP", "details": { "total": 500GB, "free": 200GB } }
  }
}
```

---

## 四、自定义端点

```java
@Component
@Endpoint(id = "systemStats")
public class SystemStatsEndpoint {

    // GET /actuator/systemStats
    @ReadOperation
    public Map<String, Object> stats() {
        OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        return Map.of(
            "cpuLoad",      String.format("%.1f%%", os.getSystemLoadAverage() * 100),
            "heapUsed",     memory.getHeapMemoryUsage().getUsed() / 1024 / 1024 + "MB",
            "heapMax",      memory.getHeapMemoryUsage().getMax() / 1024 / 1024 + "MB",
            "threadCount",  ManagementFactory.getThreadMXBean().getThreadCount(),
            "uptime",       ManagementFactory.getRuntimeMXBean().getUptime() / 1000 + "s"
        );
    }

    // GET /actuator/systemStats/{type}
    @ReadOperation
    public Map<String, Object> statsByType(@Selector String type) {
        return switch (type) {
            case "memory" -> memoryStats();
            case "thread" -> threadStats();
            default -> Map.of("error", "未知类型: " + type);
        };
    }

    // POST /actuator/systemStats（写操作）
    @WriteOperation
    public void clearCache(@Nullable String cacheName) {
        // 执行清缓存操作
    }
}
```

---

## 五、Prometheus + Grafana 集成

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
  metrics:
    export:
      prometheus:
        enabled: true
    tags:
      application: ${spring.application.name}  # 所有指标附加 application 标签
      env: ${spring.profiles.active:default}
```

访问 `/actuator/prometheus` 即可看到 Prometheus 格式的指标文本。

### 5.1 自定义业务指标

```java
@Service
@RequiredArgsConstructor
public class OrderMetricsService {

    private final MeterRegistry meterRegistry;
    private final Counter orderCreatedCounter;
    private final Timer orderProcessTimer;

    @PostConstruct
    public void init() {
        // 计数器
        Counter.builder("order.created.total")
            .description("创建的订单总数")
            .tag("channel", "api")
            .register(meterRegistry);

        // 计时器
        Timer.builder("order.process.duration")
            .description("订单处理耗时")
            .publishPercentiles(0.5, 0.95, 0.99)
            .register(meterRegistry);

        // Gauge（实时值，如队列大小）
        Gauge.builder("order.queue.size", orderQueue, Queue::size)
            .description("待处理订单队列大小")
            .register(meterRegistry);
    }

    public OrderVO createOrder(OrderCreateDTO dto) {
        return orderProcessTimer.record(() -> {
            OrderVO result = doCreate(dto);
            meterRegistry.counter("order.created.total", "status", "success").increment();
            return result;
        });
    }
}
```

### 5.2 Prometheus 抓取配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'my-service'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['localhost:8080']
    scrape_interval: 15s
```

> Grafana 导入 Spring Boot Dashboard（ID: 11378 或 12900）即可开箱即用。

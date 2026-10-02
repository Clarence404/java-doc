---
description: Nacos / Sentinel / Seata 实操、版本对齐、整体组合架构
---

# Alibaba

- 官网：[https://sca.aliyun.com](https://sca.aliyun.com/)
- 前 5 篇讲的是各能力的**抽象层与选型**，本篇讲国内最主流的一套落地组合：**Nacos + Sentinel + Seata**。

## 一、定位与版本对齐

| 能力 | 抽象层（前几篇） | Alibaba 落地实现 |
|------|----------------|-----------------|
| 注册发现 | [服务注册与发现](./1_service_registry) | **Nacos** Discovery |
| 配置中心 | [配置中心](./4_config_center) | **Nacos** Config |
| 限流熔断 | [服务治理](./5_service_governance) | **Sentinel** |
| 分布式事务 | — | **Seata** |
| 消息驱动 | [Spring Cloud Stream](./7_stream) | RocketMQ Binder |

**版本对齐是第一大坑**：Spring Boot / Spring Cloud / Spring Cloud Alibaba 三者版本强绑定，必须按官方[版本说明](https://sca.aliyun.com/docs/2023/overview/version-explain/)对表选择，如 Boot 3.2.x → Cloud 2023.0.x → SCA 2023.0.x。

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.alibaba.cloud</groupId>
      <artifactId>spring-cloud-alibaba-dependencies</artifactId>
      <version>2023.0.1.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

---

## 二、Nacos：注册中心 + 配置中心二合一

```xml
<dependency>
  <groupId>com.alibaba.cloud</groupId>
  <artifactId>spring-cloud-starter-alibaba-nacos-discovery</artifactId>
</dependency>
<dependency>
  <groupId>com.alibaba.cloud</groupId>
  <artifactId>spring-cloud-starter-alibaba-nacos-config</artifactId>
</dependency>
```

```yaml
spring:
  application:
    name: order-service
  cloud:
    nacos:
      server-addr: 127.0.0.1:8848
      discovery:
        namespace: dev            # 命名空间隔离环境（dev/test/prod）
        group: DEFAULT_GROUP
      config:
        namespace: dev
        file-extension: yaml
  config:
    import: nacos:order-service.yaml   # Boot 2.4+ 取代 bootstrap.yml 的方式
```

### 关键机制

- **三层隔离模型**：`namespace`（环境）→ `group`（业务线）→ `dataId`（应用配置文件），规划好再上，后期迁移很痛
- **配置热更新**：`@RefreshScope` 标注的 Bean 在 Nacos 改配置后自动刷新；`@ConfigurationProperties` 无需注解天然支持
- **临时实例 vs 持久实例**：默认临时实例走客户端心跳（5s 心跳 / 15s 不健康 / 30s 摘除）；持久实例由服务端主动探测
- **集群部署**：生产至少 3 节点 + MySQL 外置存储，客户端配 VIP 或多地址

```java
@RestController
@RefreshScope
public class ConfigController {
    @Value("${order.timeout:3000}")
    private int timeout;    // Nacos 控制台改配置，无需重启即生效
}
```

---

## 三、Sentinel：流控与熔断

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
        dashboard: 127.0.0.1:8080   # Sentinel 控制台
      eager: true                    # 启动即注册，不等第一次请求
```

### 资源定义与兜底

```java
@Service
public class OrderService {

    @SentinelResource(
        value = "createOrder",                  // 资源名，控制台按它配规则
        blockHandler = "createOrderBlocked",    // 被流控/熔断时的处理
        fallback = "createOrderFallback")       // 业务异常时的降级
    public OrderResult createOrder(OrderRequest req) { ... }

    // 签名 = 原方法 + BlockException（必须 public，同类或 blockHandlerClass 指定）
    public OrderResult createOrderBlocked(OrderRequest req, BlockException ex) {
        return OrderResult.busy("系统繁忙，请稍后重试");
    }

    public OrderResult createOrderFallback(OrderRequest req, Throwable t) {
        return OrderResult.degraded();
    }
}
```

### 常用规则

| 规则 | 关键参数 | 典型用法 |
|------|---------|---------|
| **流控** | QPS / 并发线程数；快速失败 / Warm Up / 匀速排队 | 秒杀入口限 QPS，冷启动用 Warm Up |
| **熔断降级** | 慢调用比例 / 异常比例 / 异常数 | RT > 500ms 且比例超 50% 熔断 10s |
| **热点参数** | 对方法某个参数的特定值单独限流 | 对爆款 skuId 单独限流 |
| **系统自适应** | Load / CPU / 入口 RT / 并发 / 全局 QPS | 整机保护的最后防线 |

各类规则的原理与阈值设定见高可用模块：[熔断](/high-avail/5_circuit_breaking)、[降级](/high-avail/6_degradation)、[限流与过载保护](/high-avail/7_rate_limiting)。

`blockHandler` 与 `fallback` 的分工：`blockHandler` 只处理规则触发抛出的 `BlockException`（流控、熔断、系统保护）；`fallback` 处理业务代码抛出的异常。两者都配置时，`BlockException` 走 `blockHandler`。

### 规则代码示例

生产环境规则应来自配置中心（见下文"规则持久化"），代码方式适合单测和本地调试。

```java
// 1. 流控：queryOrder 单机 100 QPS，超出快速失败
FlowRule flowRule = new FlowRule("queryOrder");
flowRule.setGrade(RuleConstant.FLOW_GRADE_QPS);
flowRule.setCount(100);
flowRule.setControlBehavior(RuleConstant.CONTROL_BEHAVIOR_DEFAULT);  // 快速失败
FlowRuleManager.loadRules(Collections.singletonList(flowRule));
```

```java
// 2. 热点参数：queryItem 第 0 个参数（itemId）每个值 50 QPS，爆款 1001 单独放宽到 200 QPS
ParamFlowRule paramRule = new ParamFlowRule("queryItem")
        .setParamIdx(0)
        .setGrade(RuleConstant.FLOW_GRADE_QPS)
        .setCount(50);
ParamFlowItem hotItem = new ParamFlowItem()
        .setObject(String.valueOf(1001L))
        .setClassType(long.class.getName())
        .setCount(200);
paramRule.setParamFlowItemList(Collections.singletonList(hotItem));
ParamFlowRuleManager.loadRules(Collections.singletonList(paramRule));
```

```java
// 3. 熔断：慢调用比例（RT > 500ms 的比例超过 60% 熔断 10s）
DegradeRule slowRule = new DegradeRule("callDownstream")
        .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType())
        .setCount(500)                 // 慢调用 RT 阈值（ms）
        .setSlowRatioThreshold(0.6)
        .setMinRequestAmount(10)       // 最小请求数
        .setStatIntervalMs(10_000)     // 统计窗口（ms）
        .setTimeWindow(10);            // 熔断时长（s）

// 4. 熔断：异常比例（5s 内异常比例超过 50% 熔断 5s）
DegradeRule errorRule = new DegradeRule("callDownstream")
        .setGrade(CircuitBreakerStrategy.ERROR_RATIO.getType())
        .setCount(0.5)
        .setMinRequestAmount(5)
        .setStatIntervalMs(5_000)
        .setTimeWindow(5);

DegradeRuleManager.loadRules(List.of(slowRule, errorRule));
```

```java
// 5. 熔断状态变化监听：打开 / 半开 / 关闭时上报日志与告警
EventObserverRegistry.getInstance().addStateChangeObserver("logObserver",
        (prevState, newState, rule, snapshotValue) ->
                log.warn("熔断状态变化 {} -> {}，资源={}，快照值={}",
                        prevState, newState, rule.getResource(), snapshotValue));
```

### 与 OpenFeign 集成

开启后每个 Feign 接口方法自动成为 Sentinel 资源，**资源名格式为 `HTTP方法:协议://服务名/路径`**，如 `GET:http://order-service/api/orders/{id}`，控制台和规则里都按这个名字配置。

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
```

```yaml
feign:
  sentinel:
    enabled: true   # 开启 Feign 对 Sentinel 的支持
```

```java
@FeignClient(name = "order-service", fallbackFactory = OrderClientFallbackFactory.class)
public interface OrderClient {

    @GetMapping("/api/orders/{id}")
    Result<Order> getOrder(@PathVariable("id") Long id);

    @PostMapping("/api/orders")
    Result<String> createOrder(@RequestBody CreateOrderRequest req);
}
```

```java
// fallbackFactory 能拿到异常原因，比 fallback 更适合区分"熔断拒绝"与"下游报错"
@Slf4j
@Component
public class OrderClientFallbackFactory implements FallbackFactory<OrderClient> {

    @Override
    public OrderClient create(Throwable cause) {
        return new OrderClient() {
            @Override
            public Result<Order> getOrder(Long id) {
                log.warn("订单查询降级 id={}, cause={}", id, cause.toString());
                return Result.fail(503, "订单服务暂不可用，请稍后重试");
            }

            @Override
            public Result<String> createOrder(CreateOrderRequest req) {
                // 写操作不能静默返回成功，抛出让调用方感知失败
                throw new ServiceUnavailableException("订单服务不可用，创建失败", cause);
            }
        };
    }
}
```

Resilience4j 方案（Spring Cloud CircuitBreaker）的对比见 [服务治理](./5_service_governance)。

### 规则持久化（Nacos 数据源）

**默认规则只存在应用内存，重启即丢，生产必须持久化。** 引入 `sentinel-datasource-nacos` 后，应用启动时从 Nacos 拉取规则并监听变更：

```xml
<dependency>
  <groupId>com.alibaba.csp</groupId>
  <artifactId>sentinel-datasource-nacos</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    sentinel:
      datasource:
        flow-rules:                       # 名称自定义，每种规则一个数据源
          nacos:
            server-addr: ${nacos.server-addr}
            namespace: ${nacos.namespace}
            data-id: ${spring.application.name}-flow-rules
            group-id: SENTINEL_GROUP
            data-type: json
            rule-type: flow               # flow / degrade / param-flow / system / authority
        degrade-rules:
          nacos:
            server-addr: ${nacos.server-addr}
            namespace: ${nacos.namespace}
            data-id: ${spring.application.name}-degrade-rules
            group-id: SENTINEL_GROUP
            data-type: json
            rule-type: degrade
```

Nacos 中 `order-service-degrade-rules` 的内容（`grade` 0 = 慢调用比例，1 = 异常比例，2 = 异常数）：

```json
[
  {
    "resource": "callDownstream",
    "grade": 0,
    "count": 500,
    "slowRatioThreshold": 0.6,
    "minRequestAmount": 10,
    "statIntervalMs": 10000,
    "timeWindow": 10
  }
]
```

::: warning 数据流向是单向的
`sentinel-datasource-nacos` 只负责 **Nacos → 应用** 的拉取与监听。开源 Sentinel 控制台默认把规则直接推送到应用内存，**不会写回 Nacos**，控制台上改的规则在应用重启后丢失，还可能被 Nacos 的下一次推送覆盖。两种做法：

- 约定只在 Nacos 中修改规则，控制台仅用于查看监控
- 改造 Dashboard，实现 `DynamicRuleProvider` / `DynamicRulePublisher` 读写 Nacos（官方源码 test 目录下有 Nacos 示例），实现"控制台 → Nacos → 应用"
:::

---

## 四、Seata：分布式事务

### AT 模式原理（默认，业务零侵入）

三个角色：**TC**（事务协调者，独立部署的 seata-server）、**TM**（事务发起方）、**RM**（各参与方的数据源代理）。

两阶段流程：

1. **一阶段**：RM 拦截业务 SQL，解析出前后镜像写入 `undo_log` 表，**与业务 SQL 同一本地事务提交**，立即释放本地锁；同时向 TC 注册分支并上报状态
2. **二阶段提交**：TC 通知各分支异步删除 `undo_log`，几乎零开销
3. **二阶段回滚**：RM 根据 `undo_log` 生成反向 SQL 补偿；回滚前校验后镜像与当前数据一致（防脏写，靠 TC 的**全局锁**）

```java
// 事务发起方：一个注解开启全局事务
@GlobalTransactional(timeoutMills = 30000, name = "create-order")
public void createOrder(OrderRequest req) {
    orderMapper.insert(order);          // 本地库
    storageClient.deduct(req.skuId());  // 远程：库存服务
    accountClient.debit(req.userId());  // 远程：账户服务
    // 任何一步异常 → TC 协调所有分支回滚
}
```

```yaml
seata:
  application-id: order-service
  tx-service-group: my_tx_group
  registry:
    type: nacos           # seata-server 也注册到 Nacos
    nacos:
      server-addr: 127.0.0.1:8848
```

> 每个业务库都要建 `undo_log` 表；`@GlobalTransactional` 只加在**发起方**，参与方不用加。

### 四种模式选型

| 模式 | 侵入性 | 一致性 | 适用 |
|------|-------|--------|------|
| **AT（默认）** | 零侵入 | 最终一致（二阶段前有中间态）| 大多数 CRUD 场景 |
| TCC | 高（每个操作写 Try/Confirm/Cancel）| 强于 AT | 资金类、需要资源预留 |
| Saga | 中（写补偿逻辑）| 最终一致 | 长流程、跨企业服务 |
| XA | 零侵入 | 强一致 | 数据库支持 XA 且并发不高 |

> 分布式事务的第一原则仍然是**能不用就不用**：优先考虑消息最终一致 / 本地消息表 / 对账补偿（见 [分布式事务理论](../distributed/4_transaction)），Seata 是"必须同步强一致"时的选项。

---

## 五、整体组合架构

```yaml
# 一套典型的 SCA 微服务技术栈
网关:      Spring Cloud Gateway（+ Sentinel 网关流控）
注册/配置:  Nacos 集群（3 节点 + MySQL）
服务通信:   OpenFeign（+ Sentinel 降级）
分布式事务: Seata（AT 模式，seata-server 注册进 Nacos）
消息:      RocketMQ（+ Spring Cloud Stream Binder）
可观测:    Micrometer Tracing + SkyWalking / Prometheus
```

---

## 六、相关文档

- 抽象层：[注册发现](./1_service_registry) / [网关](./2_api_gateway) / [通信](./3_communication) / [配置中心](./4_config_center) / [治理](./5_service_governance)
- [分布式事务理论（2PC / TCC / Saga）](../distributed/4_transaction)
- 高可用：[熔断](/high-avail/5_circuit_breaking) / [降级](/high-avail/6_degradation) / [限流与过载保护](/high-avail/7_rate_limiting)

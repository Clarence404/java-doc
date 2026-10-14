---
description: 版本对齐、Nacos 部署要点、Sentinel 资源与规则、规则持久化、Seata AT 模式、整体组合架构
---

# Spring Cloud Alibaba

> 前置阅读：[服务治理](./5_service_governance)

Nacos + Sentinel + Seata 是国内最常用的 Spring Cloud 落地组合。本篇讲版本对齐、Sentinel 的资源定义、规则配置、OpenFeign 集成与 Nacos 持久化，以及 Seata AT 模式的两阶段机制与生产配置。

---

## 一、定位与版本对齐

| 能力 | 抽象层 | Alibaba 落地实现 |
|------|-------|-----------------|
| 注册发现 | [注册发现](./1_service_registry) | Nacos Discovery |
| 配置中心 | [配置中心](./4_config_center) | Nacos Config |
| 限流熔断 | [服务治理](./5_service_governance) | Sentinel |
| 分布式事务 | [分布式事务](/distributed/4_transaction) | Seata |
| 消息驱动 | [Spring Cloud Stream](./7_stream) | RocketMQ Binder |

**版本对齐是第一大坑**：Spring Boot、Spring Cloud、Spring Cloud Alibaba 三者强绑定，必须按官方版本说明对表选择。

| Spring Cloud Alibaba | Spring Cloud | Spring Boot | Nacos | Sentinel | Seata | RocketMQ |
|------|------|------|------|------|------|------|
| 2025.1.0.0 | 2025.1.x | 4.0.x | 3.1.1 | 1.8.9 | 2.5.0 | 5.3.1 |
| 2025.0.0.0 | 2025.0.x | 3.5.x | 3.0.3 | 1.8.9 | 2.5.0 | 5.3.1 |

Spring Cloud 2025.1.2 起支持 Boot 4.1，升级 Boot 小版本前先确认 SCA 对应版本已发布。

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>4.0.6</version>
</parent>

<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-dependencies</artifactId>
      <version>2025.1.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <dependency>
      <groupId>com.alibaba.cloud</groupId>
      <artifactId>spring-cloud-alibaba-dependencies</artifactId>
      <version>2025.1.0.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

上面的 Boot 与 Spring Cloud 补丁版本仅作示意，以发布说明中的组合为准。SCA 2025.1 起不再支持 bootstrap 配置，Nacos 配置统一用 `spring.config.import` 加载。

---

## 二、Nacos

Nacos 的注册发现机制（gRPC 长连接、临时与持久实例、保护阈值）见 [注册发现](./1_service_registry)，配置接入与刷新链路见 [配置中心](./4_config_center)。生产部署要点：

- 集群至少 3 节点，外置 MySQL 存储，客户端配置多个地址或通过 VIP / 域名访问
- 放通端口：8848（HTTP）、9848（客户端 gRPC）、9849（节点间 gRPC）；Nacos 3.x 的控制台使用独立端口（文档示例为 8080）
- Nacos 3.x 服务端要求 JDK 17，默认开启鉴权，客户端配置 `spring.cloud.nacos.username` / `password`
- 命名空间、分组、dataId 的规划在接入前定好，后期迁移代价很大

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
        dashboard: 127.0.0.1:8858   # Sentinel 控制台；本地还跑着 Nacos 3.x 控制台时避开 8080
      eager: true                    # 启动即连接控制台，不等第一次请求
```

### 1、资源定义与兜底

```java
@Service
public class OrderService {

    @SentinelResource(
        value = "createOrder",                  // 资源名，控制台按它配规则
        blockHandler = "createOrderBlocked",    // 被流控 / 熔断时的处理
        fallback = "createOrderFallback")       // 业务异常时的降级
    public OrderResult createOrder(OrderRequest req) { ... }

    // 签名 = 原方法参数 + BlockException（必须 public，位于同类或 blockHandlerClass 指定的类中）
    public OrderResult createOrderBlocked(OrderRequest req, BlockException ex) {
        return OrderResult.busy("系统繁忙，请稍后重试");
    }

    public OrderResult createOrderFallback(OrderRequest req, Throwable t) {
        return OrderResult.degraded();
    }
}
```

`blockHandler` 只处理规则触发抛出的 `BlockException`（流控、熔断、系统保护）；`fallback` 处理业务代码抛出的异常。两者都配置时，`BlockException` 走 `blockHandler`。

### 2、常用规则

| 规则 | 关键参数 | 典型用法 |
|------|---------|---------|
| **流控** | QPS / 并发线程数；快速失败 / Warm Up / 匀速排队 | 秒杀入口限 QPS，冷启动用 Warm Up |
| **熔断降级** | 慢调用比例 / 异常比例 / 异常数 | 慢调用比例超阈值时熔断一段时间 |
| **热点参数** | 对方法某个参数的特定值单独限流 | 对爆款 skuId 单独限流 |
| **系统自适应** | Load / CPU / 入口 RT / 并发 / 全局 QPS | 整机保护的最后防线 |
| **集群流控** | Token Server 统一发放令牌，按集群总量计数 | 需要严格控制集群总 QPS 的接口 |

各类规则的原理与阈值设定见高可用模块：[熔断](/high-avail/5_circuit_breaking)、[降级](/high-avail/6_degradation)、[限流与过载保护](/high-avail/7_rate_limiting)。

### 3、规则代码示例

生产环境规则应来自配置中心（见下文规则持久化），代码方式适合单测和本地调试。

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
// 5. 熔断状态变化监听：打开 / 半开 / 关闭时上报日志与告警（log 为所在类的 SLF4J Logger）
EventObserverRegistry.getInstance().addStateChangeObserver("logObserver",
        (prevState, newState, rule, snapshotValue) ->
                log.warn("熔断状态变化 {} -> {}，资源={}，快照值={}",
                        prevState, newState, rule.getResource(), snapshotValue));
```

### 4、与 OpenFeign 集成

开启后每个 Feign 接口方法自动成为 Sentinel 资源，**资源名格式为 `HTTP方法:协议://服务名/路径`**，如 `GET:http://order-service/api/orders/{id}`，控制台和规则里都按这个名字配置。

```yaml
feign:
  sentinel:
    enabled: true   # 开启 Feign 对 Sentinel 的支持，否则 fallback / fallbackFactory 不生效
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.openfeign.FallbackFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

// fallbackFactory 能拿到异常原因，比 fallback 更适合区分「熔断拒绝」与「下游报错」
@Component
public class OrderClientFallbackFactory implements FallbackFactory<OrderClient> {

    private static final Logger log = LoggerFactory.getLogger(OrderClientFallbackFactory.class);

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
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "订单服务不可用，创建失败", cause);
            }
        };
    }
}
```

OpenFeign 已功能冻结，新项目的调用方式与 Resilience4j 方案见 [服务通信](./3_communication) 与 [服务治理](./5_service_governance)。网关层流控使用 `spring-cloud-alibaba-sentinel-gateway` 适配模块，与 Gateway Server WebFlux 在 Boot 4 上的兼容性以 SCA 发布说明为准。

### 5、规则持久化（Nacos 数据源）

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

Nacos 3.x 默认开启鉴权，数据源同样需要配置 `username` / `password`。Nacos 中 `order-service-degrade-rules` 的内容（`grade` 0 = 慢调用比例，1 = 异常比例，2 = 异常数）：

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
- 改造 Dashboard，实现 `DynamicRuleProvider` / `DynamicRulePublisher` 读写 Nacos（官方源码 test 目录下有 Nacos 示例），实现「控制台 → Nacos → 应用」
:::

---

## 四、Seata：分布式事务

**能不用分布式事务就不用**：优先考虑事务消息、本地消息表、对账补偿，Seata 是「必须同步得到一致结果」时的选项。各方案的原理与选型见 [分布式事务](/distributed/4_transaction)，本节只讲 Seata 在 Spring Cloud 中的落地。

### 1、依赖与版本

Seata 已进入 Apache 基金会，2.x 起 Maven groupId 为 `org.apache.seata`，包名改为 `org.apache.seata.*`（保留了兼容旧 `io.seata` 包名的过渡模块）。SCA 2025.1 的 BOM 自带 Seata 2.5.0，可显式覆盖到最新稳定版 2.6.0；无论选哪个，seata-server 与客户端版本保持一致。

```xml
<dependency>
  <groupId>com.alibaba.cloud</groupId>
  <artifactId>spring-cloud-starter-alibaba-seata</artifactId>
</dependency>
```

### 2、AT 模式两阶段

AT 模式由 TC（独立部署的 seata-server）、TM（`@GlobalTransactional` 发起方）、RM（参与方的数据源代理）协作：一阶段业务 SQL 与 `undo_log` 同一本地事务提交并持有全局锁，二阶段提交时异步删日志、回滚时按前镜像补偿。两阶段流程、读写隔离与回滚失败的原因见 [分布式事务 · AT 模式](/distributed/4_transaction#_3、at-模式)，本篇只讲接入。

### 3、代码与配置

`@GlobalTransactional` 只加在事务发起方（完整示例见 [分布式事务 · AT 模式](/distributed/4_transaction#_3、at-模式)），参与方只需接入 Seata 数据源代理。客户端配置：

```yaml
seata:
  application-id: order-service
  tx-service-group: order_tx_group
  service:
    vgroup-mapping:
      order_tx_group: default       # 事务分组映射到 TC 集群名
  registry:
    type: nacos                     # 通过 Nacos 发现 seata-server
    nacos:
      server-addr: 127.0.0.1:8848
      application: seata-server
      group: SEATA_GROUP
```

- 每个参与方的业务库都要建 `undo_log` 表；参与方方法不加 `@GlobalTransactional`
- 全局事务 ID（XID）需要随调用透传，Seata starter 为 OpenFeign 等常用客户端自动处理；其他客户端要自行把 `RootContext.getXID()` 放入请求头 `TX_XID`，并在下游绑定
- 下游返回错误码而不抛异常时，发起方要自己判断并抛出异常，否则全局事务会被提交
- seata-server 生产使用 db 或 raft 存储模式，多节点部署

### 4、模式选择

Spring Cloud 链路里默认用 AT（关系库常规 CRUD，零侵入）；资金类、需要资源预留或涉及非数据库资源用 TCC，长流程用 Saga，强一致低并发用 XA。四种模式的一致性、隔离与性能对比见 [分布式事务 · 四种模式](/distributed/4_transaction#_2、四种模式)，TCC 的空回滚、悬挂、幂等见 [TCC](/distributed/4_transaction#三、tcc)。

---

## 五、整体组合架构

| 层次 | 组件 | 说明 |
|------|------|------|
| 网关 | Spring Cloud Gateway（Server WebFlux） | 配合 Sentinel 网关流控适配模块 |
| 注册 / 配置 | Nacos 集群（3 节点 + MySQL） | 临时实例走 gRPC 长连接 |
| 服务通信 | HTTP Service Clients / OpenFeign + LoadBalancer | 存量 Feign 接 Sentinel 降级 |
| 流控熔断 | Sentinel + Nacos 规则持久化 | 规则只在 Nacos 修改 |
| 分布式事务 | Seata（AT 模式，seata-server 注册进 Nacos） | 仅用于必须同步一致的链路 |
| 消息 | RocketMQ（Spring Cloud Stream Binder 或原生客户端） | 事务消息覆盖大部分最终一致场景 |
| 可观测 | Micrometer Tracing + SkyWalking / Prometheus | 链路、指标、日志关联 traceId |

![Spring Cloud Alibaba 技术栈](../assets/spring-cloud/sca-stack.svg)

---

## 小结

- Boot 4.0 对应 Spring Cloud 2025.1 与 SCA 2025.1.0.0（Nacos 3.1.1、Sentinel 1.8.9、Seata 2.5.0），Boot 3.5 对应 2025.0 系列；同时导入 Spring Cloud 与 SCA 两个 BOM
- SCA 2025.1 取消 bootstrap，Nacos 配置统一 `spring.config.import`；Nacos 机制细节在注册发现与配置中心两篇
- Sentinel 用 `@SentinelResource` 定义资源，`blockHandler` 处理规则拦截、`fallback` 处理业务异常；Feign 集成需 `feign.sentinel.enabled`
- 生产规则必须持久化到 Nacos，数据流向是 Nacos → 应用，控制台改的规则不会写回
- Seata 2.x 归属 Apache，包名 `org.apache.seata`；接入要点：发起方加 `@GlobalTransactional`、各参与库建 `undo_log`、XID 随调用透传、下游返回错误码时发起方要主动抛异常
- 分布式事务能不用就不用，模式选择与理论在分布式模块

## 参考资料

- Spring Cloud Alibaba：[https://sca.aliyun.com/](https://sca.aliyun.com/)
- 版本说明：[https://sca.aliyun.com/docs/2025.x/overview/version-explain/](https://sca.aliyun.com/docs/2025.x/overview/version-explain/)
- Sentinel：[https://sentinelguard.io/zh-cn/docs/introduction.html](https://sentinelguard.io/zh-cn/docs/introduction.html)
- Apache Seata：[https://seata.apache.org/](https://seata.apache.org/)
- Nacos：[https://nacos.io/docs/latest/what-is-nacos/](https://nacos.io/docs/latest/what-is-nacos/)

> 下一篇：[Spring Cloud Stream](./7_stream) —— 用 Binder 抽象屏蔽具体 MQ，函数式模型下的消费组、分区与死信。

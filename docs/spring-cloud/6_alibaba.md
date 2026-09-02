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
| **系统自适应** | Load / CPU / 全局 QPS 兜底 | 整机保护的最后防线 |

> **规则持久化是必做项**：默认规则存内存，重启即丢。生产必须配 `sentinel.datasource` 推送到 Nacos，控制台改规则 → 写入 Nacos → 应用监听生效。

与 OpenFeign 集成：`feign.sentinel.enabled=true` 后，每个 Feign 接口方法自动成为 Sentinel 资源，配合 `fallback` 类实现远程调用降级（对比 Resilience4j 方案见 [服务治理](./5_service_governance)）。

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

> 分布式事务的第一原则仍然是**能不用就不用**：优先考虑消息最终一致 / 本地消息表 / 对账补偿（见 [分布式事务理论](../distributed/3_transaction)），Seata 是"必须同步强一致"时的选项。

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
- [分布式事务理论（2PC / TCC / Saga）](../distributed/3_transaction)
- [高可用：限流熔断降级](../high-avail/0_overview)

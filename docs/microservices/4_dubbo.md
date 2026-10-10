---
description: 调用流程、Boot 3.5 接入、Triple 协议、负载均衡与容错、SPI 扩展、与 Spring Cloud 选型
---

# Dubbo

> 前置阅读：[RPC 协议](/protocols/5_rpc_protocols)、[服务通信](/spring-cloud/3_communication)

Dubbo 是 RPC 服务框架，本篇讲它的调用流程、Spring Boot + Nacos 搭建、Triple 协议、负载均衡、集群容错、SPI 扩展与选型。版本基线为 **Dubbo 3.3.x**（写作时最新 3.3.6），其 Starter 面向 Boot 3.x，引入 Dubbo 的服务需停留在 **Spring Boot 3.5**，Boot 4 适配以官方发布为准。

---

## 一、定位

Dubbo 是 Apache 顶级项目，是一个**微服务 RPC 服务框架**。要先看清它所在的层次：

| 层次 | 代表 | 说明 |
|------|------|------|
| 协议 / 通信库 | gRPC、Thrift | 只解决「怎么把调用发过去」 |
| **服务框架（Dubbo 在这层）** | Dubbo、Spring Cloud | 在通信之上叠加注册发现、负载均衡、集群容错、服务治理 |

所以 Dubbo 对标的是 **Spring Cloud 技术栈**，而不是 gRPC。Dubbo 3 主打云原生：Triple 协议（兼容 gRPC，并支持 HTTP/1.1、HTTP/2、HTTP/3 访问）、应用级服务发现、Kubernetes 友好。

---

## 二、架构与调用流程

![Dubbo 架构与调用流程](../assets/microservices/dubbo-architecture.svg)

| 角色 | 职责 |
|------|------|
| **Provider** | 启动时向注册中心注册服务，监听端口接收调用 |
| **Consumer** | 启动时订阅所需服务，缓存 Provider 地址列表；调用时在本地做负载均衡后**直连 Provider** |
| **注册中心** | 存储服务地址并推送变更（Nacos / ZooKeeper）；**不在调用链路上**，宕机不影响已建立的调用 |

注册中心只做「通讯录」，RPC 流量是 Consumer 到 Provider 的点对点长连接，这与经过网关转发的 HTTP 调用有本质区别。

Dubbo 3 引入**应用级服务发现**：注册中心按应用而不是按接口登记实例，接口与方法的元数据单独存放，注册中心的数据量和推送量大幅下降。3.x 默认双注册（接口级 + 应用级）以兼容 2.x 消费者，全部升级后可设置 `dubbo.registry.register-mode=instance` 只保留应用级注册。

---

## 三、快速上手（Spring Boot 3.5 + Dubbo 3.3 + Nacos）

### 1、依赖与配置

```xml
<properties>
  <dubbo.version>3.3.6</dubbo.version>
</properties>

<dependencies>
  <dependency>
    <groupId>org.apache.dubbo</groupId>
    <artifactId>dubbo-spring-boot-starter</artifactId>
    <version>${dubbo.version}</version>
  </dependency>
  <dependency>
    <groupId>org.apache.dubbo</groupId>
    <artifactId>dubbo-nacos-spring-boot-starter</artifactId>
    <version>${dubbo.version}</version>
  </dependency>
</dependencies>
```

```yaml
dubbo:
  application:
    name: order-service
  protocol:
    name: tri          # Triple 协议（Dubbo 3 推荐）
    port: 50051
  registry:
    address: nacos://127.0.0.1:8848
```

### 2、公共 API 模块

接口与 DTO 放在单独的 jar 中，Provider 与 Consumer 共同依赖：

```java
package com.example.order.api;

public interface OrderService {
    OrderDTO getOrder(Long id);
}
```

```java
package com.example.order.api;

import java.io.Serial;
import java.io.Serializable;
import java.math.BigDecimal;

public class OrderDTO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private Long id;
    private Long userId;
    private BigDecimal amount;
    private String status;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
}
```

跨网络传输的 DTO **必须实现 `Serializable`**：Dubbo 3.2 起序列化类检查默认是 STRICT 模式，且默认校验类是否实现 `Serializable`，不满足会在反序列化时被拒绝。接口方法签名中出现的类型会自动加入允许列表，其他类型（如多态子类）需要在 `security/serialize.allowlist` 中登记。序列化方案的背景见 [序列化](/java/19_topic_serialization)。

### 3、Provider

```java
package com.example.order.provider;

import org.apache.dubbo.config.spring.context.annotation.EnableDubbo;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@EnableDubbo                        // 扫描 @DubboService 并导出服务
public class OrderProviderApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderProviderApplication.class, args);
    }
}
```

```java
package com.example.order.provider;

import java.util.Optional;

import com.example.order.api.OrderDTO;

// 数据访问层（可由 MyBatis / JPA 实现，这里只声明所需方法）
public interface OrderRepository {
    Optional<OrderDTO> findById(Long id);
}
```

```java
package com.example.order.provider;

import com.example.order.api.OrderDTO;
import com.example.order.api.OrderService;
import org.apache.dubbo.config.annotation.DubboService;

@DubboService(timeout = 3000)       // 同时也是 Spring Bean，可构造器注入
public class OrderServiceImpl implements OrderService {

    private final OrderRepository orderRepository;

    public OrderServiceImpl(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Override
    public OrderDTO getOrder(Long id) {
        return orderRepository.findById(id).orElse(null);
    }
}
```

### 4、Consumer

```java
package com.example.payment;

import com.example.order.api.OrderDTO;
import com.example.order.api.OrderService;
import org.apache.dubbo.config.annotation.DubboReference;
import org.springframework.stereotype.Service;

@Service
public class PaymentService {

    @DubboReference(retries = 2)    // 读接口，失败可换一台重试
    private OrderService orderService;

    public void pay(Long orderId) {
        OrderDTO order = orderService.getOrder(orderId);   // 远程调用，写法与本地调用相同
        if (order == null) {
            throw new IllegalArgumentException("订单不存在: " + orderId);
        }
        // 调用支付渠道、记录支付流水……
    }
}
```

与 HTTP 客户端的直观差异：Dubbo 面向**接口 jar 包**（强类型契约，编译期校验），HTTP Service Clients / OpenFeign 面向 **HTTP 端点**（松耦合，跨语言友好）。

---

## 四、Triple 协议

### 1、Triple 与 dubbo 协议

| 维度 | dubbo 协议（2.x 默认） | Triple 协议（3.x 推荐） |
|------|----------------------|------------------------|
| 传输层 | TCP 上的私有二进制协议 | 基于 HTTP，3.3 起同时支持 HTTP/1.1、HTTP/2、HTTP/3 |
| 跨语言 / 网关穿透 | 差，需要 Dubbo 客户端 | 好，与 gRPC 互通，可用 curl、浏览器、普通 HTTP 网关访问 |
| 流式调用 | 不支持 | 支持（Server Stream / Client Stream / 双向流） |
| 序列化 | 2.x 默认 Hessian2；3.2 默认 fastjson2，3.3 起改回 Hessian2 | IDL 模式用 Protobuf；Java 接口模式默认 Hessian2，也支持 JSON |

### 2、3.3 的变化

Dubbo 3.3 对 Triple 做了较大升级（官方称 Triple X）：

- **多 HTTP 版本**：同一端口同时接受 HTTP/1.1 与 HTTP/2 请求，无需额外端口；HTTP/3 基于 QUIC，客户端先走 HTTP/2，服务端通过 `Alt-Svc` 响应头声明支持后自动切换，配置方式见官方 triple-http3 示例
- **Triple Rest**：可以直接用 HTTP 访问 Dubbo 服务，也支持用 Spring MVC、JAX-RS 注解或 Dubbo 自己的 `@Mapping` 定义 REST 路径，服务因此可以直接挂在普通 HTTP 网关后面

```bash
# 默认路径为 /{接口全限定名}/{方法名}，参数可走 query 或 body
curl "http://127.0.0.1:50051/com.example.order.api.OrderService/getOrder?id=1"
```

按参数名绑定 query 参数依赖编译时保留参数名（`-parameters`，Spring Boot 的父 POM 已默认开启）。

---

## 五、负载均衡与集群容错

### 1、负载均衡策略

Consumer 在本地从地址列表中选择 Provider（`@DubboReference(loadbalance = "...")`）：

| 策略 | 说明 |
|------|------|
| `random`（默认） | 加权随机 |
| `roundrobin` | 加权轮询 |
| `leastactive` | 最少活跃调用数：慢的机器积压的调用多，自然收到更少请求 |
| `shortestresponse` | 最短平均响应时间 |
| `consistenthash` | 一致性哈希，相同参数的请求落到同一 Provider，对本地缓存友好 |

### 2、集群容错策略

调用失败后怎么处理（`@DubboReference(cluster = "...")`）：

| 策略 | 行为 | 适用 |
|------|------|------|
| `failover`（默认） | 换一台重试（`retries` 次，默认 2） | 读操作 |
| `failfast` | 立即报错，不重试 | **写操作 / 非幂等操作** |
| `failsafe` | 失败忽略，返回空 | 日志、审计类旁路调用 |
| `failback` | 失败记录，后台定时重发 | 通知类 |
| `forking` | 并行调用多台，取最先返回的结果 | 实时性要求高、能容忍资源浪费 |
| `broadcast` | 逐台调用全部节点，任一失败即失败 | 通知所有节点刷新本地缓存 |

**默认 failover + retries 是写操作的经典大坑**：超时不等于失败，Provider 可能已经执行成功，重试会造成重复扣款或重复下单。写接口要么 `cluster = "failfast"`，要么把幂等做扎实（见 [幂等设计](/architecture/5_idempotence)）。

---

## 六、SPI 扩展机制

Dubbo 的协议、负载均衡、集群容错、过滤器、序列化、注册中心几乎都通过自研 SPI 装配，是「微内核 + 插件」架构的代表。本节是 Dubbo SPI 的主文档，Java 原生 `ServiceLoader` 见 [SPI 机制](/java/20_topic_spi)。

### 1、与 Java 原生 SPI 的区别

| 维度 | Java 原生 SPI（`ServiceLoader`） | Dubbo SPI |
|------|-------------------------------|-----------|
| 配置格式 | 每行一个实现类全名 | `name=实现类全名`，按名称索引 |
| 获取方式 | 遍历全部实现 | **按名称获取**，只实例化用到的实现 |
| 依赖注入 | 不支持 | setter 注入其他扩展点 |
| 包装增强 | 不支持 | Wrapper 类自动包装，相当于 AOP |
| 运行时选择 | 不支持 | `@Adaptive` 按 URL 参数动态选择实现 |
| 条件激活 | 不支持 | `@Activate` 按分组、参数自动激活（如过滤器链） |

### 2、扩展点定义与加载

- 扩展点接口标注 `@SPI`，可指定默认实现名
- 配置文件放在 `META-INF/dubbo/internal/`、`META-INF/dubbo/`、`META-INF/services/` 下，文件名为扩展点接口全名，内容为 `name=实现类`
- Dubbo 3 通过 `ScopeModel`（`FrameworkModel` / `ApplicationModel` / `ModuleModel`）获取 `ExtensionLoader`，静态的 `ExtensionLoader.getExtensionLoader` 已过时

```properties
# META-INF/dubbo/internal/org.apache.dubbo.rpc.Protocol（Dubbo 内置）
dubbo=org.apache.dubbo.rpc.protocol.dubbo.DubboProtocol
tri=org.apache.dubbo.rpc.protocol.tri.TripleProtocol
```

```java
import org.apache.dubbo.rpc.Protocol;
import org.apache.dubbo.rpc.model.ApplicationModel;

Protocol protocol = ApplicationModel.defaultModel()
        .getExtensionLoader(Protocol.class)
        .getExtension("tri");
```

### 3、Adaptive、Activate 与 Wrapper

| 机制 | 作用 | 典型用途 |
|------|------|---------|
| `@Adaptive` | 生成自适应代理，调用时从 URL 参数读出扩展名再委派给真实实现 | `Protocol`、`Cluster`、`LoadBalance` 按配置切换 |
| `@Activate` | 声明扩展在什么分组（provider / consumer）、什么参数下自动激活，并指定顺序 | 过滤器链 `Filter` |
| Wrapper 类 | 构造器参数是扩展点接口本身的实现类，被自动套在真实实现外层 | 为所有 `Protocol` 统一加监听、过滤逻辑 |

### 4、自定义扩展：同机房优先的负载均衡

```java
package com.example.rpc;

import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

import org.apache.dubbo.common.URL;
import org.apache.dubbo.rpc.Invocation;
import org.apache.dubbo.rpc.Invoker;
import org.apache.dubbo.rpc.cluster.loadbalance.AbstractLoadBalance;

public class ZonePreferLoadBalance extends AbstractLoadBalance {

    private static final String LOCAL_ZONE = System.getenv().getOrDefault("ZONE", "");

    @Override
    protected <T> Invoker<T> doSelect(List<Invoker<T>> invokers, URL url, Invocation invocation) {
        List<Invoker<T>> sameZone = invokers.stream()
                .filter(invoker -> LOCAL_ZONE.equals(invoker.getUrl().getParameter("zone")))
                .toList();
        List<Invoker<T>> candidates = sameZone.isEmpty() ? invokers : sameZone;   // 同机房无可用实例时退回全部
        return candidates.get(ThreadLocalRandom.current().nextInt(candidates.size()));
    }
}
```

```properties
# META-INF/dubbo/org.apache.dubbo.rpc.cluster.LoadBalance
zonePrefer=com.example.rpc.ZonePreferLoadBalance
```

Provider 通过 `@DubboService(parameters = {"zone", "hz-a"})` 把机房信息写进服务 URL，Consumer 用 `@DubboReference(loadbalance = "zonePrefer")` 启用。

### 5、自定义扩展：透传租户 ID 的过滤器

```java
package com.example.rpc;

import org.apache.dubbo.common.constants.CommonConstants;
import org.apache.dubbo.common.extension.Activate;
import org.apache.dubbo.rpc.Filter;
import org.apache.dubbo.rpc.Invocation;
import org.apache.dubbo.rpc.Invoker;
import org.apache.dubbo.rpc.Result;
import org.apache.dubbo.rpc.RpcException;
import org.slf4j.MDC;

@Activate(group = CommonConstants.PROVIDER)      // 只在 Provider 侧自动激活
public class TenantFilter implements Filter {

    @Override
    public Result invoke(Invoker<?> invoker, Invocation invocation) throws RpcException {
        String tenantId = invocation.getAttachment("tenantId");
        if (tenantId != null) {
            MDC.put("tenantId", tenantId);
        }
        try {
            return invoker.invoke(invocation);
        } finally {
            MDC.remove("tenantId");
        }
    }
}
```

```properties
# META-INF/dubbo/org.apache.dubbo.rpc.Filter
tenant=com.example.rpc.TenantFilter
```

Consumer 侧在发起调用前写入隐式参数：`RpcContext.getClientAttachment().setAttachment("tenantId", tenantId)`。

---

## 七、常用治理能力

```java
@DubboReference(
    version = "1.0.0",       // 版本：新旧实现共存，灰度切换（Provider 侧 @DubboService 声明相同版本）
    group = "campaign-a",    // 分组：同一接口的多套实现相互隔离
    timeout = 3000,          // 超时：Consumer 侧配置优先于 Provider 侧
    cluster = "failfast",    // 写接口不重试
    mock = "true"            // 降级：调用失败（非业务异常）时走接口同包下的 OrderServiceMock 类
)
private OrderService orderService;
```

- **泛化调用**（`GenericService`）：不依赖接口 jar，按接口名、方法名和参数直接调用，网关、测试平台常用
- **隐式参数**（`RpcContext` attachment）：跨服务透传租户 ID、灰度标记等上下文，见上一节的过滤器
- **可观测性**：Dubbo 3.2 起基于 Micrometer 提供指标与链路追踪集成（`dubbo-spring-boot-observability-starter` 等），可对接 OpenTelemetry / Zipkin，追踪体系见 [链路追踪](/observability/3_tracing)
- **限流熔断**：通常与 Sentinel 组合，见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba)；分布式事务用 Seata，见 [分布式事务](/distributed/4_transaction)

---

## 八、Dubbo vs Spring Cloud 选型

| 维度 | Dubbo 3 | Spring Cloud |
|------|---------|--------------|
| 通信方式 | RPC 长连接（Triple / dubbo 协议），性能高 | HTTP / REST（HTTP Service Clients，存量项目用 OpenFeign），通用性好 |
| 契约形式 | 接口 jar，强类型 | HTTP 端点 + DTO，松耦合 |
| 服务治理 | 框架内建（路由、权重、降级、容错） | 由组件拼装（LoadBalancer、Resilience4j / Sentinel、Gateway） |
| 跨语言 | Triple 与 gRPC 互通、支持 REST 访问后可行 | 天然（HTTP） |
| Spring Boot 版本 | 目前停留在 Boot 3.5 | 随 Spring 官方节奏，已支持 Boot 4 |
| 生态 | 国内成熟，常与 Nacos / Sentinel / Seata 组合 | 全球主流，Spring 官方维护 |

Spring Cloud OpenFeign 已进入功能完备状态，只做维护；Spring 生态的新项目用 Framework 的 HTTP Service Clients，见 [服务通信](/spring-cloud/3_communication)。

**选型速记**：内部服务间高频调用、性能敏感、团队熟悉 Dubbo → Dubbo；对外暴露多、跨语言、希望紧跟 Spring Boot 版本 → Spring Cloud。两者也常混用：内部 Dubbo，边界 REST。

---

## 小结

- Dubbo 是 RPC 服务框架，对标 Spring Cloud 而非 gRPC；注册中心不在调用链路上，Consumer 本地负载均衡后直连 Provider
- 当前基线 Dubbo 3.3，基于 Spring Boot 3.5，Boot 4 适配以官方发布为准
- 3.2 起序列化类检查默认 STRICT，DTO 必须实现 `Serializable`，非签名类型要登记允许列表
- Triple 是 Dubbo 3 推荐协议：与 gRPC 互通，3.3 起支持 HTTP/1.1、HTTP/2、HTTP/3 与 REST 访问
- 默认 `failover` 会重试，写接口必须改 `failfast` 或保证幂等
- Dubbo SPI 在原生 SPI 基础上增加按名获取、依赖注入、Wrapper、`@Adaptive` 与 `@Activate`，自定义负载均衡、过滤器都通过它接入

## 参考资料

- Dubbo 官方文档：[https://cn.dubbo.apache.org/zh-cn/overview/home/](https://cn.dubbo.apache.org/zh-cn/overview/home/)
- Triple 3.3 新特性：[https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/protocol/triple-3.3/](https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/protocol/triple-3.3/)
- Dubbo SPI 扩展：[https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/spi/](https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/spi/)
- 序列化类检查：[https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/tasks/security/class-check/](https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/tasks/security/class-check/)
- GitHub Releases：[https://github.com/apache/dubbo/releases](https://github.com/apache/dubbo/releases)

> 返回：[微服务总览](./0_overview)

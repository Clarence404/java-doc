# Dubbo

- 官网：[https://dubbo.apache.org](https://dubbo.apache.org/zh-cn/)
- 协议层的横向对比（gRPC / REST / Dubbo 协议）见 [远程调用协议](../protocols/3_rpc_protocols)

## 一、定位

Dubbo 是 Apache 顶级项目的**微服务 RPC 框架**——注意它的层次：

| 层次 | 代表 | 说明 |
|------|------|------|
| 协议 / 通信库 | gRPC、Thrift | 只解决"怎么把调用发过去" |
| **服务框架（Dubbo 在这层）** | Dubbo、Spring Cloud | 在通信之上叠加注册发现、负载均衡、集群容错、服务治理 |

所以 Dubbo 对标的是 **Spring Cloud 技术栈**，而不是 gRPC。Dubbo 3（2021+）主打云原生：Triple 协议（兼容 gRPC）、应用级服务发现、Kubernetes 友好。

---

## 二、架构与调用流程

![Dubbo 架构与调用流程](../assets/microservices/dubbo-architecture.svg)

| 角色 | 职责 |
|------|------|
| **Provider** | 启动时向注册中心注册服务；通过 Netty Server 监听调用 |
| **Consumer** | 启动时订阅所需服务，缓存 Provider 地址列表；调用时本地做负载均衡后**直连 Provider** |
| **注册中心** | 服务地址的存储与变更推送（Nacos / ZooKeeper）；**不在调用链路上**，宕机不影响已建立的调用 |

> 关键认知：注册中心只做"通讯录"，RPC 流量是 Consumer → Provider 点对点长连接，这与经过网关转发的 HTTP 调用有本质区别。

---

## 三、快速上手（Spring Boot 3 + Dubbo 3 + Nacos）

```xml
<dependency>
  <groupId>org.apache.dubbo</groupId>
  <artifactId>dubbo-spring-boot-starter</artifactId>
  <version>3.3.0</version>
</dependency>
<dependency>
  <groupId>org.apache.dubbo</groupId>
  <artifactId>dubbo-nacos-spring-boot-starter</artifactId>
  <version>3.3.0</version>
</dependency>
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

```java
// 公共 API 模块（单独 jar，Provider/Consumer 共享）
public interface OrderService {
    OrderDTO getOrder(Long id);
}

// Provider 侧：暴露服务
@DubboService(version = "1.0.0", timeout = 3000)
public class OrderServiceImpl implements OrderService {
    @Override
    public OrderDTO getOrder(Long id) { ... }
}

// Consumer 侧：像本地 Bean 一样注入远程服务
@Service
public class PaymentService {
    @DubboReference(version = "1.0.0", retries = 2)
    private OrderService orderService;

    public void pay(Long orderId) {
        OrderDTO order = orderService.getOrder(orderId);  // 远程调用，形如本地
        ...
    }
}
```

> 与 OpenFeign 的直观差异：Dubbo 面向**接口 jar 包**（强类型契约，编译期校验），Feign 面向 **HTTP 端点**（松耦合，跨语言友好）。

---

## 四、核心机制

### 1、Triple 协议 vs Dubbo 协议

| | dubbo 协议（2.x 默认）| Triple 协议（3.x 推荐）|
|---|---|---|
| 传输层 | TCP 私有二进制协议 | **HTTP/2** |
| 跨语言 / 网关穿透 | 差（私有协议）| 好，**与 gRPC 互通** |
| 流式调用 | ❌ | ✅ Server/Client/双向流 |
| 序列化 | Hessian2 默认 | Protobuf（也支持 JSON）|

### 2、负载均衡策略

Consumer 本地从地址列表中选择 Provider：

| 策略 | 说明 |
|------|------|
| `random`（默认）| 加权随机 |
| `roundrobin` | 加权轮询 |
| `leastactive` | 最少活跃调用数——慢的机器收到更少请求，**天然倾斜避让** |
| `shortestresponse` | 最短平均响应时间 |
| `consistenthash` | 一致性哈希，同参数请求打到同一 Provider（本地缓存友好）|

### 3、集群容错策略

调用失败后怎么办（`@DubboReference(cluster = "...")`）：

| 策略 | 行为 | 适用 |
|------|------|------|
| `failover`（默认）| 换一台重试（`retries` 次）| 读操作 |
| `failfast` | 立即报错，不重试 | **写操作 / 非幂等** |
| `failsafe` | 失败忽略，返回空 | 日志、审计类旁路调用 |
| `failback` | 失败记录，定时重发 | 通知类 |
| `forking` | 并行调多台，取最快 | 实时性要求高、容忍资源浪费 |
| `broadcast` | 逐台全调，任一失败即失败 | 通知所有节点刷新缓存 |

> **默认 failover + retries 是写操作的经典大坑**：超时不等于失败，重试可能造成重复扣款。写接口要么 `failfast`，要么把幂等做扎实（见 [幂等设计](../architecture/5_idempotence)）。

### 4、SPI 扩展机制

Dubbo 几乎所有组件（协议、负载均衡、过滤器、序列化）都通过自研 SPI 装配，是"微内核 + 插件"架构的代表：

- 对比 Java 原生 SPI：支持**按名获取**（不必全量实例化）、IoC 依赖注入、AOP 包装
- `@SPI` 标注扩展点，`@Adaptive` 生成自适应代理，运行时按 URL 参数动态选择实现

```java
// 自定义负载均衡：META-INF/dubbo/org.apache.dubbo.rpc.cluster.LoadBalance
// 文件内容：myLb=com.xxx.MyLoadBalance
@DubboReference(loadbalance = "myLb")
private OrderService orderService;
```

### 5、常用治理能力

```java
@DubboReference(
    version = "1.0.0",       // 版本：灰度共存（1.0.0 / 2.0.0 同时在线）
    group = "campaign-a",    // 分组：同接口多实现隔离
    timeout = 3000,          // 超时：Consumer 侧配置优先于 Provider 侧
    mock = "com.xxx.OrderServiceMock"  // 服务降级：失败时走本地 Mock 兜底
)
private OrderService orderService;
```

- **泛化调用**（GenericService）：不依赖接口 jar 直接按方法名/参数调用，网关、测试平台常用
- **隐式参数**（RpcContext / attachment）：跨服务透传 traceId、租户 ID

---

## 五、Dubbo vs Spring Cloud 选型

| 维度 | Dubbo 3 | Spring Cloud |
|------|---------|--------------|
| 通信方式 | RPC 长连接（Triple/HTTP2），性能高 | HTTP/REST（OpenFeign），通用性好 |
| 契约形式 | 接口 jar，强类型 | HTTP 端点 + DTO，松耦合 |
| 服务治理 | 框架内建（路由/降级/权重）| 依赖组件拼装（Sentinel/Gateway）|
| 跨语言 | Triple 互通 gRPC 后可行 | 天然（HTTP）|
| 生态 | 国内成熟，常与 Nacos/Sentinel 组合 | 全球主流，Spring 官方 |
| 典型组合 | **Dubbo + Nacos + Sentinel + Seata** | Spring Cloud (Alibaba) 全家桶 |

**选型速记**：内部服务间高频调用、性能敏感 → Dubbo；对外暴露多、团队 Spring 技术栈深、跨语言 → Spring Cloud。两者也常混用：内部 Dubbo，边界 REST。

---

## 六、相关文档

- [远程调用协议（gRPC / REST 对比）](../protocols/3_rpc_protocols)
- [Spring Cloud 服务通信](../spring-cloud/3_communication)
- [微服务通信模式](./2_patterns)

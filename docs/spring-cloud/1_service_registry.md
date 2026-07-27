# 服务注册与发现

> 参考资料：
> * Nacos 官方文档：[https://nacos.io/zh-cn/docs/what-is-nacos.html](https://nacos.io/zh-cn/docs/what-is-nacos.html)
> * Consul 文档：[https://developer.hashicorp.com/consul/docs](https://developer.hashicorp.com/consul/docs)
> * Eureka：[https://github.com/Netflix/eureka](https://github.com/Netflix/eureka)

---

## 一、为什么需要服务注册与发现

微服务架构中，服务实例的 IP 和端口动态变化（扩缩容、重启、故障），不能再用硬编码地址调用。服务注册与发现解决了**地址动态感知**和**自动上下线**两个核心问题。

```
传统方式：调用方硬编码 http://192.168.1.10:8080  ← 实例重启后 IP 变了就挂

注册发现：
  服务启动 → 向注册中心注册（IP+端口+元数据）
  调用方   → 从注册中心查询 "order-service" 的实例列表
           → 客户端负载均衡选择一个实例发起调用
  服务下线 → 心跳超时后注册中心自动剔除，调用方不再路由到该实例
```

---

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **注册中心** | 统一存储服务实例地址信息的中央仓库 |
| **服务注册** | 服务启动时向注册中心上报 IP、端口、服务名、元数据 |
| **服务发现** | 调用方根据服务名从注册中心获取实例列表 |
| **心跳检测** | 服务定期发送心跳，注册中心超时未收到则剔除该实例 |
| **客户端发现** | 调用方自己查询注册中心并做负载均衡（Spring Cloud 模式）|
| **服务端发现** | 调用方访问负载均衡器，由其查询注册中心（Kubernetes Service 模式）|

---

## 三、主流方案对比

| 组件 | 一致性模型 | 健康检查 | 配置中心 | 适用场景 |
|------|-----------|---------|---------|---------|
| **Nacos** | AP（默认）/ CP 可切 | 心跳 + 主动探测 | ✅ 内置 | 国内主流，注册+配置二合一 |
| **Eureka** | AP | 心跳（自我保护机制）| ❌ | Spring Cloud 原生，简单场景 |
| **Consul** | CP（Raft）| 多种（HTTP/TCP/Script/gRPC）| ✅ KV 存储 | 多数据中心，强一致场景 |
| **etcd** | CP（Raft）| TTL Lease | ❌ | Kubernetes 内置，基础设施层 |
| **ZooKeeper** | CP（ZAB）| 临时节点 | ❌ | Dubbo 原生，老项目 |

**AP vs CP 的选择**：注册中心的核心诉求是**高可用**（宁可返回旧数据也不能不可用），因此**大多数场景选 AP 模型**（Nacos 默认 / Eureka），只有对数据强一致有强依赖时才用 CP（Consul / etcd）。

---

## 四、Nacos Spring Boot 接入

### 依赖

```xml
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-discovery</artifactId>
</dependency>
```

### 配置

```yaml
spring:
  application:
    name: order-service          # 服务名，注册中心的 key
  cloud:
    nacos:
      discovery:
        server-addr: localhost:8848
        namespace: dev           # 命名空间隔离（dev/test/prod）
        group: DEFAULT_GROUP
        # 元数据（灰度发布时用于流量打标）
        metadata:
          version: v1
          zone: cn-north
```

`@SpringBootApplication` + 上述配置即可，无需额外注解，服务启动时自动注册。

### 服务调用（OpenFeign + LoadBalancer）

```java
// 声明式 HTTP 客户端，服务名替代 IP
@FeignClient(name = "order-service")
public interface OrderClient {
    @GetMapping("/orders/{id}")
    OrderResponse getOrder(@PathVariable("id") String orderId);
}

// 调用方注入使用，Spring Cloud LoadBalancer 自动轮询实例
@Service
public class PaymentService {
    private final OrderClient orderClient;

    public void processPayment(String orderId) {
        OrderResponse order = orderClient.getOrder(orderId);
        // ...
    }
}
```

### 优雅下线

```yaml
# 应用关闭时先从注册中心注销，再等待进行中请求完成
management:
  endpoint:
    shutdown:
      enabled: true
  endpoints:
    web:
      exposure:
        include: shutdown
```

```java
// 通过 Actuator /actuator/shutdown 触发优雅停机
// 或设置 spring.cloud.nacos.discovery.deregister-on-shutdown=true（默认 true）
```

---

## 五、Nacos 健康检查机制

```
临时实例（默认）：
  客户端每 5 秒发送心跳给 Nacos
  15 秒未收到心跳 → 标记为不健康
  30 秒未收到心跳 → 从注册表删除

永久实例（metadata 中设置 preserved.register.source=KUBERNETES）：
  Nacos 主动探测（HTTP/TCP/MySQL），不健康但不删除
  适合 Kubernetes 等平台管理的实例
```

---

## 六、Nacos AP/CP 切换

Nacos 1.x：通过 `ephemeral` 参数控制，`true`（默认）使用 Distro 协议（AP），`false` 使用 Raft 协议（CP）。

Nacos 2.x：统一使用 gRPC 长连接替代 HTTP 心跳，性能大幅提升，AP/CP 切换逻辑不变。

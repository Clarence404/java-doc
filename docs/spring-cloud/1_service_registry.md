---
description: 注册发现核心概念、注册中心对比、Nacos 2.x+ gRPC 机制、临时与持久实例、Spring Cloud 接入
---

# 注册发现

> 前置阅读：[Spring Cloud 总览](./0_overview)

微服务实例的 IP 和端口随扩缩容、重启、故障迁移不断变化，注册发现解决**地址动态感知**和**自动上下线**两件事。本篇讲客户端发现链路、注册中心选型、Nacos 2.x / 3.x 的连接模型、临时与持久实例、保护阈值，以及在 Spring Cloud 2025.1 中接入。

---

## 一、核心概念与流程

### 1、概念

| 概念 | 说明 |
|------|------|
| **注册中心** | 统一存储服务实例地址与元数据的中心节点 |
| **服务注册** | 实例启动后上报服务名、IP、端口、元数据（版本、区域、权重） |
| **服务发现** | 调用方按服务名获取实例列表，并订阅后续变更 |
| **健康检查** | 注册中心判断实例是否可用：客户端心跳 / 长连接存活，或服务端主动探测 |
| **客户端发现** | 调用方自己拿实例列表并做负载均衡（Spring Cloud 模式） |
| **服务端发现** | 调用方只访问一个固定地址，由负载均衡器或 Kubernetes Service 选实例 |

Spring Cloud 用 `ServiceRegistry`（注册）、`DiscoveryClient` / `ReactiveDiscoveryClient`（发现）两组接口做抽象，Nacos、Consul、Eureka、Kubernetes 各自实现；负载均衡统一交给 Spring Cloud LoadBalancer，见 [服务治理](./5_service_governance)。

### 2、一次调用的完整链路

![服务注册与发现流程](../assets/spring-cloud/registry-flow.svg)

1. 提供者启动、Web 容器就绪后，Spring Cloud 自动注册（`AbstractAutoServiceRegistration` 监听 `WebServerInitializedEvent`）
2. 消费者首次调用某服务时订阅该服务，拉取实例列表
3. 实例变化时，Nacos 通过 gRPC 长连接主动推送给订阅者
4. 注册中心按实例类型做健康检查与剔除
5. 消费者侧 LoadBalancer 从本地缓存的实例列表中选一个
6. 直连该实例发起调用，注册中心不在调用链路上

**注册中心不在请求链路上**：它短暂不可用时，消费者仍可用本地缓存的实例列表继续调用，只是感知不到新变化。

---

## 二、注册中心对比

| 组件 | 一致性模型 | 健康检查 | 配置中心 | 现状与适用场景 |
|------|-----------|---------|---------|---------|
| **Nacos** | 临时实例 AP（Distro），持久实例 CP（JRaft） | 长连接存活 + 服务端探测 | 内置 | 国内主流，注册与配置二合一 |
| **Consul** | CP（Raft） | HTTP / TCP / gRPC / Script 探测 | KV 存储 | 多数据中心、多语言 |
| **Kubernetes** | etcd（Raft）之上的 Service / EndpointSlice | Readiness 探针 | ConfigMap / Secret | 运行在 K8s 上时可直接用平台能力，应用侧用 Spring Cloud Kubernetes 或直接走 Service DNS |
| **Eureka** | AP | 客户端心跳 + 自我保护 | 无 | Eureka 2.x 已停止，1.x 只维护；Spring Cloud Netflix 仍发布 Eureka 模块，新项目不推荐 |
| **ZooKeeper** | CP（ZAB） | 临时节点 + 会话 | 无 | Dubbo 老项目常见 |

**为什么注册中心更适合 AP**：注册中心的核心诉求是可用性，宁可返回稍旧的实例列表，也不能因选主或网络分区导致整个集群无法注册和查询；调用方还有本地缓存与重试兜底。CAP 的理论细节见 [分布式理论](/distributed/2_theorem)。

**选型**：Spring Cloud Alibaba 技术栈选 Nacos；部署在 Kubernetes 且服务都在集群内时，优先用平台自带的 Service 发现，减少一个中间件；多语言、跨数据中心选 Consul。

---

## 三、Nacos 2.x / 3.x 机制

### 1、连接模型：gRPC 长连接

Nacos 1.x 的临时实例靠客户端每 5 秒 HTTP 心跳、15 秒标记不健康、30 秒剔除。**Nacos 2.0 起改为 gRPC 长连接**：

| 维度 | Nacos 1.x | Nacos 2.x / 3.x |
|------|-----------|-----------------|
| 通信 | HTTP 短连接 + UDP 推送 | gRPC 长连接（客户端端口 = 主端口 + 1000，默认 9848） |
| 临时实例健康 | 5s 心跳 / 15s 不健康 / 30s 剔除 | 实例绑定在连接上，连接断开即剔除该连接注册的所有实例 |
| 变更推送 | UDP 推送 + 定时拉取兜底 | 服务端通过长连接主动推送 |
| 集群间同步 | Distro / Raft（自研） | Distro / JRaft，节点间 gRPC 端口默认 9849 |

连接存活靠 gRPC 层的周期性探活：客户端或服务端检测到连接失效时，连接上的临时实例立即下线，不再有固定的「15 秒 / 30 秒」窗口。防火墙和安全组要放通 9848 / 9849，只开 8848 会导致客户端连不上。

### 2、临时实例与持久实例

| 维度 | 临时实例（默认） | 持久实例 |
|------|----------------|---------|
| 声明方式 | `ephemeral: true`（默认） | `spring.cloud.nacos.discovery.ephemeral: false` |
| 存储与一致性 | 内存，Distro 协议，AP | 持久化，JRaft，CP |
| 健康检查 | 客户端连接存活 | 服务端主动探测（TCP / HTTP / MySQL） |
| 不健康时 | 连接断开即删除 | 标记不健康但不删除，需显式注销 |
| 适用 | 普通微服务实例 | 数据库、外部服务等无法运行 Nacos 客户端的节点 |

AP / CP 不是集群级开关，而是**由每个实例的 `ephemeral` 属性决定**；Nacos 2.x 起同一服务内不再允许混用两类实例。

### 3、保护阈值与本地容灾

- **保护阈值**（服务级，0~1）：健康实例占比低于阈值时，Nacos 返回全部实例（含不健康的），宁可部分请求失败，也不让流量全部压到少数健康实例上导致雪崩
- **客户端本地缓存**：Naming 客户端在内存和本地磁盘保存服务列表，Nacos Server 全部宕机时，已有实例仍可继续调用，新实例无法被发现
- 客户端配置多个 Server 地址或使用 VIP / 域名，避免单点

### 4、Nacos 3.x 的变化

Nacos 3.0（2025 年 GA）起，服务端要求 JDK 17+，控制台与服务端端口分离（控制台独立端口，文档示例为 8080），控制台与 API 默认开启鉴权，首次部署必须配置鉴权密钥。客户端接入的变化是要带上凭据：

```yaml
spring:
  cloud:
    nacos:
      server-addr: nacos-1:8848,nacos-2:8848,nacos-3:8848
      username: ${NACOS_USERNAME}
      password: ${NACOS_PASSWORD}
```

本地同时运行 Sentinel 控制台时注意避开 8080 端口冲突。

---

## 四、Spring Cloud 接入

### 1、依赖与配置

版本由 `spring-cloud-alibaba-dependencies` BOM 管理，对表方式见 [Spring Cloud Alibaba](./6_alibaba)。

```xml
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-discovery</artifactId>
</dependency>
```

```yaml
spring:
  application:
    name: order-service              # 服务名，注册中心的 key
  cloud:
    nacos:
      server-addr: localhost:8848
      discovery:
        namespace: dev               # 命名空间隔离环境（填命名空间 ID）
        group: DEFAULT_GROUP
        ephemeral: true              # 默认临时实例
        metadata:                    # 元数据：灰度、区域路由时使用
          version: v1
          zone: zone-a
```

不需要 `@EnableDiscoveryClient`，引入 starter 后自动注册。调用方用服务名访问实例的写法（`@LoadBalanced RestClient`、HTTP Service Clients、OpenFeign）见 [服务通信](./3_communication)。

### 2、注册时机与下线

- 注册发生在 Web 容器启动之后；如果应用还需预热缓存、连接池，可以先关闭自动注册（`spring.cloud.nacos.discovery.register-enabled: false`），预热完成后再手动调用 `NacosAutoServiceRegistration#start()`，或者配合 K8s Readiness 控制放量
- Spring 容器关闭时自动注销实例；调用方感知还要叠加推送与 LoadBalancer 缓存的延迟，所以下线要「先注销、再等待、后停机」
- 不要通过 Web 暴露 `/actuator/shutdown` 做停机；用 `server.shutdown: graceful`（Boot 3.4 起默认）加 SIGTERM / K8s `preStop`

完整的停机顺序、等待时长推导与 K8s 配置见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 小结

- 注册发现解决地址动态感知与自动上下线；Spring Cloud 用 `ServiceRegistry` / `DiscoveryClient` 抽象，负载均衡交给 LoadBalancer
- 注册中心不在调用链路上，消费者靠本地缓存的实例列表直连调用，注册中心短暂故障不影响已有调用
- 注册中心优先 AP；Spring Cloud Alibaba 选 Nacos，跑在 K8s 上可直接用 Service 发现，Eureka 不再用于新项目
- Nacos 2.x 起用 gRPC 长连接，临时实例随连接断开被剔除，没有 1.x 的 5s / 15s / 30s 心跳窗口；要放通 9848 / 9849 端口
- AP / CP 由实例的 `ephemeral` 决定：临时实例走 Distro（AP），持久实例走 JRaft（CP）并由服务端主动探测
- 保护阈值防止健康实例过少时流量集中雪崩；客户端本地缓存保证 Server 全挂时已有实例仍可调用
- Nacos 3.x 要求 JDK 17、控制台端口独立、默认开启鉴权，客户端需配置用户名密码

## 参考资料

- Nacos 官方文档：[https://nacos.io/docs/latest/what-is-nacos/](https://nacos.io/docs/latest/what-is-nacos/)
- Spring Cloud Alibaba Nacos Discovery：[https://sca.aliyun.com/docs/2025.x/user-guide/nacos/overview/](https://sca.aliyun.com/docs/2025.x/user-guide/nacos/overview/)
- Spring Cloud Commons（DiscoveryClient / ServiceRegistry）：[https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/common-abstractions.html](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/common-abstractions.html)
- Consul：[https://developer.hashicorp.com/consul/docs](https://developer.hashicorp.com/consul/docs)

> 下一篇：[API 网关](./2_api_gateway) —— 统一入口上的路由、鉴权、限流与灰度，以及 Gateway Server WebFlux 与 Server MVC 的选择。

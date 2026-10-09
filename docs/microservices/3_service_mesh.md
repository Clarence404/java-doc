---
description: Istio 架构、Sidecar 与 Ambient、流量管理、mTLS、可观测性、与 Spring Cloud 取舍
---

# 服务网格

> **本篇目标**：理解服务网格把服务治理下沉到基础设施层的思路，掌握 Istio 的控制面 / 数据面结构、Sidecar 与 Ambient 两种数据面的差异，能写出正确的流量路由与 mTLS 配置，并能在 Spring Cloud、Dubbo 与服务网格之间做取舍。
>
> **前置阅读**：[微服务设计模式](./2_patterns)、[Kubernetes](/cloud-native/6_kubernetes)

---

## 一、什么是服务网格

服务网格（Service Mesh）是微服务间通信的**基础设施层**：把负载均衡、重试、熔断、mTLS、遥测这些横切能力从业务进程里的 SDK 中拿出来，交给与业务一起部署的代理，业务代码不再感知。

![SDK 模式与 Sidecar 模式对比](../assets/microservices/mesh-vs-sdk.svg)

| 方式 | 治理能力放在哪里 | 典型组合 |
|------|-----------------|---------|
| SDK 模式 | 业务进程内的依赖库，随应用一起发布 | Spring Cloud LoadBalancer + Resilience4j / Sentinel + Micrometer Tracing；Dubbo 内建治理 |
| 服务网格 | 业务进程外的代理，由控制面统一下发配置 | Istio（Envoy）、Linkerd |

SDK 模式的问题在于：治理能力与语言绑定，多语言团队要维护多套 SDK；SDK 升级需要所有服务重新发布。服务网格把这些能力变成平台能力，改路由、开 mTLS 只需改配置。代价是多了一层代理和一个需要运维的控制面。

---

## 二、Istio 架构

![Istio 控制面与数据面](../assets/microservices/istio-architecture.svg)

| 层次 | 组件 | 职责 |
|------|------|------|
| **控制面** | istiod | 从 Kubernetes 获取服务与端点（服务发现），把路由、安全策略翻译成 Envoy 配置并通过 xDS 下发，作为 CA 为工作负载签发和轮转证书 |
| **数据面** | Envoy（Sidecar 模式）或 ztunnel + waypoint（Ambient 模式） | 实际承载服务间流量，执行控制面下发的路由、负载均衡、熔断、mTLS 与遥测 |

Istio 1.5 起把早期的 Pilot、Citadel、Galley 等多个控制面组件合并为单一的 istiod 二进制，Galley 不再作为独立组件存在。现在讨论 Istio 控制面时，按功能（xDS 下发、服务发现、证书签发）理解 istiod 即可。

---

## 三、数据面：Sidecar 与 Ambient

Istio 有两种数据面模式。Ambient 模式在 Istio 1.24（2024 年 11 月）达到 GA，ztunnel、waypoint 及相关 API 被标记为 Stable。

![Istio Sidecar 模式与 Ambient 模式对比](../assets/microservices/sidecar-vs-ambient.svg)

### 1、Sidecar 模式

每个 Pod 注入一个 Envoy 容器，Pod 的出入流量被透明拦截到 Envoy，L4 与 L7 能力都在 Pod 内完成。

```bash
# 为命名空间开启自动注入，之后新建或重建的 Pod 才会带上 Sidecar
kubectl label namespace production istio-injection=enabled
```

特点是功能最完整、隔离最好，但每个 Pod 都要为代理预留 CPU 与内存，升级 Envoy 需要滚动重启业务 Pod。

### 2、Ambient 模式

Ambient 把数据面拆成两层，业务 Pod 里不再有代理：

| 组件 | 部署方式 | 能力 |
|------|---------|------|
| **ztunnel** | 每个节点一个（DaemonSet） | L4：mTLS 加密与身份、L4 授权策略、TCP 遥测 |
| **waypoint** | 按命名空间或按服务部署的 Envoy，可选 | L7：HTTP 路由、重试、故障注入、L7 授权策略、HTTP 遥测 |

```bash
# 安装 Ambient 配置的 Istio
istioctl install --set profile=ambient

# 把命名空间纳入 Ambient 网格：无需重启 Pod，立即获得 mTLS 与 L4 策略
kubectl label namespace production istio.io/dataplane-mode=ambient

# 需要 L7 能力时，为命名空间部署 waypoint 并让命名空间使用它
istioctl waypoint apply -n production --enroll-namespace
```

### 3、如何选择

| 维度 | Sidecar 模式 | Ambient 模式 |
|------|-------------|-------------|
| 资源开销 | 每个 Pod 一份 Envoy，随 Pod 数线性增长 | 每节点一个 ztunnel，L7 只在需要的地方部署 waypoint |
| 接入与升级 | 注入和升级代理都要重启业务 Pod | 打标签即接入，升级 ztunnel 不重启业务 Pod |
| L7 能力 | 默认全量具备 | 按需开启（部署 waypoint） |
| 成熟度 | 最成熟，生态与案例最多 | 1.24 起 GA，部分高级特性与多集群场景需核对当前版本文档 |
| 适合 | 需要每个工作负载都有完整 L7 治理 | 以 mTLS、零信任为首要目标，或希望降低资源开销 |

官方性能测试（Istio 1.24，1 KB 负载、1000 QPS）给出的单代理资源占用：Sidecar 约 0.20 vCPU / 60 MB，waypoint 约 0.25 vCPU / 60 MB，ztunnel 约 0.06 vCPU / 12 MB。实际开销与流量模型强相关，以自己环境的压测为准。

---

## 四、流量管理

Istio 1.22 起 `networking.istio.io/v1` 与 `security.istio.io/v1` 已 GA，VirtualService、DestinationRule、Gateway、PeerAuthentication 等资源推荐使用 v1；旧的 v1alpha3 / v1beta1 仍兼容，只需改 `apiVersion` 即可迁移。

### 1、VirtualService（虚拟服务）

定义「请求被路由到哪里」。**`http` 下的路由按顺序匹配，第一条命中即生效**，所以带 `match` 的精确规则必须放在前面，不带 `match` 的兜底路由放最后：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: order-service
spec:
  hosts:
    - order-service
  http:
    # 1. 精确规则在前：带 x-canary: true 的请求（测试人员）固定路由到 v2
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: order-service
            subset: v2
    # 2. 兜底规则在后：其余流量按 90 / 10 金丝雀分流
    - route:
        - destination:
            host: order-service
            subset: v1
          weight: 90
        - destination:
            host: order-service
            subset: v2
          weight: 10
```

如果把无 `match` 的分流规则写在前面，它会接住所有请求，后面的 Header 规则永远不会生效。

### 2、DestinationRule（目标规则）

定义「到达目标服务后怎么调」：子集、负载均衡、连接池与异常实例剔除：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: order-service
spec:
  host: order-service
  trafficPolicy:
    loadBalancer:
      simple: LEAST_REQUEST      # 最少请求；LEAST_CONN 已废弃，由 LEAST_REQUEST 取代
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 1000
        http2MaxRequests: 1000
    outlierDetection:            # 异常实例剔除，相当于实例级熔断
      consecutive5xxErrors: 5    # 连续 5 次 5xx
      interval: 10s              # 每 10 秒扫描一次
      baseEjectionTime: 30s      # 至少剔除 30 秒
      maxEjectionPercent: 50     # 最多剔除一半实例，防止全部被摘除
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
```

### 3、Kubernetes Gateway API

Istio 也支持用 Kubernetes Gateway API 配置流量，并推荐它作为入口网关和 Ambient waypoint 的路由 API。Gateway API 不使用子集，而是每个版本一个 Service；规则按匹配的精确程度决定优先级，带 Header 匹配的规则优先于不带的：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order-service
spec:
  parentRefs:
    - group: ""
      kind: Service              # 东西向路由：挂到服务上，由 waypoint 执行
      name: order-service
      port: 8080
  rules:
    - matches:
        - headers:
            - name: x-canary
              value: "true"
      backendRefs:
        - name: order-service-v2
          port: 8080
    - backendRefs:
        - name: order-service-v1
          port: 8080
          weight: 90
        - name: order-service-v2
          port: 8080
          weight: 10
```

南北向入口用 Gateway API 的 `Gateway` + `HTTPRoute` 即可，与 Ingress 的对比见 [Nginx 与 Ingress](/cloud-native/7_nginx_ingress)。

---

## 五、mTLS 服务间加密

Istio 为网格内的服务间通信自动建立 mTLS，业务代码无需改动：

```yaml
# 命名空间级严格 mTLS
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT    # STRICT 只接受 mTLS；PERMISSIVE 同时接受明文，用于存量服务逐步接入
```

istiod 作为 CA 为每个工作负载签发短期证书并自动轮转，证书中的身份遵循 SPIFFE 规范，形如 `spiffe://cluster.local/ns/production/sa/order-service`——服务身份绑定到 Kubernetes ServiceAccount，而不是 IP。基于这个身份可以再用 `AuthorizationPolicy` 做「谁能调用谁」的授权。零信任模型本身见 [零信任架构](/security/9_zero_trust)。

---

## 六、可观测性

代理位于每一跳的流量路径上，可以在不改业务代码的情况下产出统一的遥测数据：

| 数据类型 | 去向 | 说明 |
|---------|------|------|
| 指标 | Prometheus | 请求数、错误率、延迟分布，按源 / 目标服务标签聚合 |
| 访问日志 | 日志平台 | 每次请求的响应码、耗时、上下游地址 |
| 链路追踪 | Jaeger / Zipkin / OpenTelemetry Collector | 代理为每一跳生成 Span |
| 拓扑可视化 | Kiali | 服务拓扑、流量与健康状态 |

注意链路追踪**并非完全零侵入**：代理只能看到单跳请求，应用必须把入站请求中的追踪头（W3C `traceparent` 或 B3 `x-b3-*`）带到出站请求上，链路才能串起来。Spring Boot 应用接入 Micrometer Tracing 后会自动完成传播。追踪体系见 [链路追踪](/observability/3_tracing) 与 [OpenTelemetry](/observability/5_opentelemetry)。

---

## 七、Service Mesh vs Spring Cloud

| 维度 | Spring Cloud（SDK） | Service Mesh（Istio） |
|------|--------------------|----------------------|
| 实现方式 | 依赖库侵入业务进程 | 进程外代理，对业务透明 |
| 语言限制 | Java / Spring 生态 | 语言无关 |
| 治理变更 | 改代码或配置中心，部分需重新发布 | 改 CRD，由控制面下发，无需发布业务 |
| 运维门槛 | 低，开发者熟悉 | 高，需要 Kubernetes 与平台团队 |
| 性能开销 | 进程内调用，没有额外网络跳数 | 每次调用多经过代理（Sidecar 模式两跳），增加延迟与 CPU / 内存占用 |
| 治理粒度 | 可以细到方法、业务参数（如 Sentinel 热点参数限流） | 基于请求属性（路径、Header、身份），感知不到业务语义 |
| 适合场景 | Java 单语言团队，需要业务语义级治理 | 多语言混合、已全面上 Kubernetes、有专职平台团队 |

**选型建议**：

- 纯 Java 微服务、团队以业务开发为主 → Spring Cloud / Spring Cloud Alibaba（见 [Alibaba](/spring-cloud/6_alibaba)）
- 多语言混合、已上 Kubernetes、有专职平台团队 → Istio
- 两者也可组合使用：网格负责 mTLS、L4 策略和统一遥测，SDK 保留需要业务语义的治理（如参数级限流、业务降级）；此时要避免同一能力两处重复配置，例如重试只在一层开启，否则重试次数会相乘

---

## 八、方案对比与落地取舍

### 1、Istio / Linkerd / Kuma

| 维度 | Istio | Linkerd | Kuma |
|------|-------|---------|------|
| 维护方 | Google / IBM 发起，CNCF 毕业项目 | Buoyant 发起，CNCF 毕业项目 | Kong 发起，CNCF 沙箱项目 |
| 数据面 | Envoy（Sidecar）或 ztunnel + waypoint（Ambient） | 自研 linkerd2-proxy（Rust） | Envoy |
| 功能丰富度 | 最全（流量、安全、策略、多集群） | 精简，聚焦核心能力 | 中等，内置多区域 / 多集群 |
| 资源开销 | Sidecar 模式较高，Ambient 模式显著降低 | 低 | 中 |
| 运行环境 | Kubernetes 为主（也支持虚拟机） | Kubernetes | Kubernetes + 虚拟机 / 裸机 |
| 适合 | 功能要求全面、有平台团队 | 追求简单、低开销 | 混合环境、多区域部署 |

选型时还要看发布模型：自 2024 年 2 月起，开源 Linkerd 项目只发布 edge 版本（滚动发布、可能包含破坏性变更、不回移修复），稳定版由厂商发行版提供，例如 Buoyant 的 Buoyant Enterprise for Linkerd（生产使用有商业授权要求）。需要长期稳定分支的团队要把这一点算进成本。

### 2、南北向 vs 东西向流量

| 流量方向 | 含义 | 负责组件 |
|---------|------|---------|
| **南北向** | 集群外部客户端 → 集群内部服务 | API 网关 / Ingress（鉴权、限流、协议转换、对外 API 管理） |
| **东西向** | 集群内服务 ↔ 服务 | 服务网格（服务发现、负载均衡、熔断、mTLS、遥测） |

两者是互补关系：API 网关管入口，服务网格管内部调用。Istio 也提供入口网关处理南北向流量，但面向外部开发者的 API 管理（开放平台、计费、文档）通常仍交给专门的 API 网关，见 [API 网关](/spring-cloud/2_api_gateway)。

### 3、落地取舍

| 考量 | 说明 |
|------|------|
| 复杂度 | 引入控制面、CRD 配置与代理，排障链路变长，需要熟悉 Envoy 与 Kubernetes 网络 |
| 性能开销 | Sidecar 模式每跳多经过两次代理；对延迟敏感的链路先压测，或评估 Ambient 模式 |
| 团队成熟度 | 需要专职平台 / SRE 团队维护升级；小团队、单语言场景优先 SDK 方案 |
| 渐进落地 | 先用 Ambient 或 PERMISSIVE 模式接入，拿到 mTLS 与统一遥测，再逐步接管流量治理 |

---

## 小结

- 服务网格把通信治理从 SDK 下沉到进程外代理，换来语言无关和无需发布即可变更，代价是多一层代理和一个控制面
- istiod 是单一控制面二进制，负责服务发现、xDS 配置下发和证书签发；早期的 Pilot / Citadel / Galley 已合并
- 数据面有两种：Sidecar 每 Pod 一个 Envoy；Ambient（1.24 起 GA）用每节点 ztunnel 提供 L4 与 mTLS，需要 L7 时再部署 waypoint
- 配置用 `networking.istio.io/v1` 与 `security.istio.io/v1`；VirtualService 路由按顺序匹配，精确规则在前、兜底在后；负载均衡用 `LEAST_REQUEST`
- 链路追踪仍需应用转发追踪头；网格与 SDK 组合使用时避免重试等能力重复配置
- 选型：Java 单语言、需要业务语义级治理选 Spring Cloud，多语言、已上 Kubernetes、有平台团队选 Istio

## 参考资料

- Istio 官方文档：[https://istio.io/latest/docs/](https://istio.io/latest/docs/)
- Istio Ambient 模式：[https://istio.io/latest/docs/ambient/](https://istio.io/latest/docs/ambient/)
- Istio v1 API 介绍：[https://istio.io/latest/blog/2024/v1-apis/](https://istio.io/latest/blog/2024/v1-apis/)
- Istio 性能与可扩展性：[https://istio.io/latest/docs/ops/deployment/performance-and-scalability/](https://istio.io/latest/docs/ops/deployment/performance-and-scalability/)
- Kubernetes Gateway API：[https://gateway-api.sigs.k8s.io/](https://gateway-api.sigs.k8s.io/)
- Envoy 文档：[https://www.envoyproxy.io/docs/](https://www.envoyproxy.io/docs/)
- Linkerd 发布模型：[https://linkerd.io/releases/](https://linkerd.io/releases/)

> 下一篇：[Dubbo](./4_dubbo) —— 另一条 SDK 路线：面向接口的 RPC 服务框架与 Triple 协议。

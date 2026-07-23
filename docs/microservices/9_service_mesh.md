# 服务网格

> 参考资料：
> * Istio 官方文档：[https://istio.io/latest/docs/](https://istio.io/latest/docs/)
> * Envoy 代理：[https://www.envoyproxy.io/docs/](https://www.envoyproxy.io/docs/)

---

## 一、什么是服务网格

服务网格（Service Mesh）是微服务间通信的**基础设施层**，将服务间通信的横切关注点（负载均衡、熔断、mTLS、可观测性）从业务代码中**下沉到基础设施**，业务服务无感知。

```
无服务网格：
  order-service（含 SDK：Ribbon + Hystrix + Sleuth）
      ↓ HTTP
  payment-service（含 SDK：Ribbon + Hystrix + Sleuth）

有服务网格（Sidecar 模式）：
  order-service  ← Envoy Sidecar ←─────────→ Envoy Sidecar → payment-service
  （纯业务逻辑）   （流量拦截/路由/熔断/mTLS/可观测）
```

所有网络流量经 Sidecar 代理，业务代码无需引入任何治理 SDK。

---

## 二、核心架构

```
控制面（Control Plane）           数据面（Data Plane）
┌─────────────────────┐          ┌──────────────┐
│  Istiod             │  xDS API │  Envoy Proxy │ ← 每个 Pod 一个 Sidecar
│  ├── Pilot（路由）   │─────────►│  ├── 路由     │
│  ├── Citadel（证书）│          │  ├── 负载均衡  │
│  └── Galley（配置）  │          │  ├── 熔断限流  │
└─────────────────────┘          │  ├── mTLS     │
                                 │  └── 遥测数据  │
                                 └──────────────┘
```

| 层次 | 组件 | 职责 |
|------|------|------|
| **控制面** | Istiod | 管理 Envoy 配置分发、证书颁发、服务发现 |
| **数据面** | Envoy Sidecar | 实际处理服务间流量，执行控制面下发的策略 |

---

## 三、流量管理

### VirtualService（虚拟服务）

定义流量路由规则，类似于应用层的路由：

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: order-service
spec:
  hosts:
    - order-service
  http:
    # 金丝雀发布：10% 流量到 v2，90% 到 v1
    - route:
        - destination:
            host: order-service
            subset: v1
          weight: 90
        - destination:
            host: order-service
            subset: v2
          weight: 10

    # 基于 Header 的流量染色（测试人员路由到 v2）
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: order-service
            subset: v2
```

### DestinationRule（目标规则）

定义目标服务的子集和负载均衡策略：

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: order-service
spec:
  host: order-service
  trafficPolicy:
    loadBalancer:
      simple: LEAST_CONN       # 最少连接负载均衡
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 1000
        http2MaxRequests: 1000
    outlierDetection:          # 熔断：异常实例自动剔除
      consecutive5xxErrors: 5  # 连续 5 次 5xx 错误
      interval: 10s
      baseEjectionTime: 30s
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
```

---

## 四、mTLS 服务间加密

Istio 可为所有服务间通信自动注入 mTLS，无需业务代码改动：

```yaml
# 开启严格 mTLS（整个 namespace）
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT    # STRICT=强制 mTLS，PERMISSIVE=兼容模式（新老混合过渡用）
```

Istiod 的 Citadel 模块自动颁发和轮转服务证书，证书基于 SPIFFE 标准（服务身份不再是 IP，而是 `spiffe://cluster.local/ns/default/sa/order-service`）。

---

## 五、可观测性

Envoy Sidecar 自动上报遥测数据，无需业务代码埋点：

```
流量指标 → Prometheus（请求数、错误率、P99 延迟）
访问日志 → 结构化日志（含 TraceId、请求耗时、响应码）
分布式追踪 → Jaeger / Zipkin（自动传播 B3/W3C Trace Header）
可视化 → Kiali（服务拓扑图、流量热力图）
```

---

## 六、Service Mesh vs Spring Cloud

| 维度 | Spring Cloud | Service Mesh（Istio）|
|------|-------------|---------------------|
| 实现方式 | SDK 侵入（代码引入依赖）| Sidecar 非侵入 |
| 语言限制 | Java 生态 | 语言无关（Polyglot）|
| 功能载体 | 业务进程内 | 独立 Envoy 进程 |
| 运维复杂度 | 低（开发者熟悉）| 高（需要 Kubernetes + Istio）|
| 性能开销 | SDK 调用几乎无额外开销 | Sidecar 代理增加约 1-3ms 延迟 |
| 流量控制粒度 | 代码级 | 基础设施级（无需发布）|
| 适合场景 | Java 单语言团队，中小规模 | 多语言混合，大规模，云原生 |

**选型建议**：
- 纯 Java 微服务，团队规模中等 → Spring Cloud Alibaba（Nacos + Sentinel + Gateway）
- 多语言混合，已上 Kubernetes，有专职平台团队 → Istio
- 国内大厂实践：通常两者混用（Spring Cloud 做业务治理，Service Mesh 做基础设施层 mTLS 和可观测性）

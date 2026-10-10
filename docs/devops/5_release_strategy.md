---
description: 滚动、蓝绿、金丝雀、Argo Rollouts、功能开关与暗发布、上线检查、回滚、DORA 指标
---

# 发布策略

> **本篇目标**：分清滚动、蓝绿、金丝雀、功能开关和暗发布各自解决什么问题，能写出可以直接 apply 的 Kubernetes 清单（Deployment、Gateway API HTTPRoute、Istio、Argo Rollouts），按检查单上线、按预案回滚，并用 DORA 指标衡量发布能力。
>
> **前置阅读**：[Kubernetes](/cloud-native/6_kubernetes)、[优雅上下线与变更](/high-avail/8_graceful_release)

发布策略回答的是「新版本怎么替换旧版本、出了问题怎么退回去」。本篇是站内发布配置的主文档：优雅停机、PDB、服务预热这些「单个实例怎么平滑上下线」的细节放在 [优雅上下线与变更](/high-avail/8_graceful_release)，这里只讲「整批实例与流量怎么切换」。示例以 2026 年 10 月为基准：Kubernetes 1.37、Gateway API v1、Istio `networking.istio.io/v1`、Argo Rollouts 1.10、Spring Boot 4。

---

## 一、发布方式全景

部署（deploy）和发布（release）是两件事：部署是把新代码放到生产环境运行，发布是让用户真正用到新功能。前三种方式在**基础设施层**切换版本，后两种在**应用层**把部署和发布拆开。

| 方式 | 做法 | 停机 | 回滚速度 | 额外资源 | 适用场景 |
|------|------|------|---------|---------|---------|
| 停机发布 | 停旧版本、起新版本 | 有 | 快（重新部署旧版本） | 无 | 内部系统、有维护窗口 |
| 滚动发布 | 分批替换实例 | 无 | 慢（再滚一遍） | 少（maxSurge 个） | 常规迭代、无状态服务 |
| 蓝绿发布 | 两套完整环境，一次切全部流量 | 无 | 秒级（切回旧环境） | 双倍 | 重大版本、要求快速回滚 |
| 金丝雀发布 | 按比例或按用户逐步放量 | 无 | 快（权重归零） | 少 | 高风险变更、核心链路 |
| 功能开关 | 代码已上线，按开关决定是否生效 | 无 | 秒级（关开关） | 无 | 业务功能灰度、A/B 实验 |
| 暗发布 | 新逻辑接收真实流量但不影响用户 | 无 | 不涉及 | 视镜像比例而定 | 重构、性能验证、迁移比对 |

选型的经验：

- 默认用**滚动发布**，前提是新旧版本可以并存（接口与表结构前后兼容）
- 核心链路、改动大的版本用**金丝雀 + 自动指标分析**，交给 Argo Rollouts 这类工具执行，见第五节
- 业务功能的「上线」与「开放」解耦用**功能开关**，部署可以随时做，开放由产品决定
- 不能让新旧版本同时对外服务的场景（例如协议不兼容的大版本）用**蓝绿**

---

## 二、滚动发布

Deployment 默认的 `RollingUpdate` 策略：先按 `maxSurge` 多起新 Pod，新 Pod 就绪后再按 `maxUnavailable` 下线旧 Pod，循环直到全部替换。

![滚动更新过程：先扩容新 Pod，就绪后再缩容旧 Pod](../assets/devops/release-strategy-rolling.svg)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order
  namespace: shop
spec:
  replicas: 4
  revisionHistoryLimit: 5          # 保留的旧 ReplicaSet 数，决定 rollout undo 能回退多远
  minReadySeconds: 10              # 就绪后稳定 10s 才计为可用
  selector:
    matchLabels:
      app: order
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0            # 滚动期间可用副本数不低于 replicas
      maxSurge: 1                  # 每次最多多起 1 个新 Pod
  template:
    metadata:
      labels:
        app: order
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: order
          image: registry.example.com/shop/order:1.4.0
          ports:
            - containerPort: 8080
          readinessProbe:          # Spring Boot 的就绪分组，不就绪不接流量
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            periodSeconds: 10
          startupProbe:            # 慢启动由 startupProbe 兜住，成功前不做存活检查
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            periodSeconds: 5
            failureThreshold: 30
          lifecycle:
            preStop:
              sleep:
                seconds: 10        # 等 Endpoints 摘除传播完再停机
```

几个要点：

- **`maxUnavailable: 0` + `maxSurge`**：保证滚动期间可用实例不减少，与 [优雅上下线与变更](/high-avail/8_graceful_release) 的建议一致；代价是需要多出 `maxSurge` 个 Pod 的资源配额
- **就绪探针用 `/actuator/health/readiness`**：只看是否能接流量；外部依赖不放进存活探针，分组配置见 [Actuator 监控](/spring-boot/7_actuator)
- **`preStop.sleep` 是原生动作**：由 kubelet 执行，不依赖镜像里的 shell，distroless 镜像也能用；它在 Kubernetes 1.34 GA。需要在 preStop 里调接口主动下线时才用 `exec`，此时镜像必须带 `sh` 和 `curl`
- **新旧版本会并存**：滚动过程中两个版本同时处理请求，接口不能有破坏性变更，表结构按「先扩展后收缩」演进，见第八节

停机顺序、`terminationGracePeriodSeconds` 怎么算、PDB 与滚动参数的区别，见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 三、蓝绿发布

同时运行两套完整环境：蓝是当前生产，绿是新版本。绿环境部署好、验证通过后，把入口一次性指向绿；出问题再指回蓝。

![蓝绿发布流量切换示意图](../assets/devops/blue-green-deploy.svg)

### 1、用 Service selector 手工切换

两套 Deployment 的 Pod 标签只差 `version`，Service 通过 selector 决定流量去哪：

```bash
# 1. 部署绿环境并等待就绪
kubectl apply -f order-green.yaml
kubectl rollout status deployment/order-green -n shop

# 2. 通过绿环境的独立 Service 或 port-forward 冒烟验证
kubectl port-forward -n shop deployment/order-green 18080:8080

# 3. 切流量：strategic merge patch 只改 version，selector 里的其他键保持不变
kubectl patch service order -n shop \
  -p '{"spec":{"selector":{"version":"green"}}}'

# 4. 出问题切回蓝
kubectl patch service order -n shop \
  -p '{"spec":{"selector":{"version":"blue"}}}'
```

注意事项：

- **切换不是瞬时的**：Service selector 变更后，EndpointSlice 与 kube-proxy 规则需要几秒传播；已经建立的 HTTP keep-alive 和 gRPC 长连接会继续打到蓝环境，直到连接被关闭或回收。所以蓝环境要保留到观察期结束，不能切完就删
- **共享的数据库与消息队列不会跟着切**：两套环境读写同一份数据，表结构同样要前后兼容；绿环境的定时任务、MQ 消费者在切换前要么不启动，要么能安全并行
- **资源翻倍**：观察期内两套环境同时在跑，确认稳定后再缩容蓝环境

### 2、用 Argo Rollouts 托管蓝绿

手工 patch 容易漏步骤。Argo Rollouts 的 `blueGreen` 策略把「部署预览版本 → 分析 → 切换 → 延迟缩容旧版本」做成声明式流程：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: order
  namespace: shop
spec:
  replicas: 4
  selector:
    matchLabels:
      app: order
  template:
    metadata:
      labels:
        app: order
    spec:
      containers:
        - name: order
          image: registry.example.com/shop/order:1.4.0
          ports:
            - containerPort: 8080
  strategy:
    blueGreen:
      activeService: order          # 生产流量入口
      previewService: order-preview # 新版本的预览入口，供冒烟测试
      autoPromotionEnabled: false   # 需要人工 promote 才切换
      scaleDownDelaySeconds: 300    # 切换后旧版本保留 5 分钟，便于秒级回退
```

`order` 和 `order-preview` 两个 Service 由 Rollouts 自动注入 `rollouts-pod-template-hash` 选择器，不需要手工维护 `version` 标签。确认预览版本没问题后执行 `kubectl argo rollouts promote order -n shop` 切换。

---

## 四、金丝雀发布

先把少量流量（例如 10%）导到新版本，观察错误率和延迟，没问题再逐步放大到 100%。按比例分流需要入口层支持权重，按副本数比例（4 个 Pod 里换 1 个）只能做到粗粒度的 25%。

### 1、Gateway API：HTTPRoute 权重（推荐）

Gateway API 是 Kubernetes 官方的下一代入口 API，权重分流是标准字段，不依赖某个控制器的注解。社区 ingress-nginx 已于 2026 年 3 月停止维护，新项目直接用 Gateway API，背景与迁移见 [Nginx、Ingress 与 Gateway API](/cloud-native/7_nginx_ingress)。

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order
  namespace: shop
spec:
  parentRefs:
    - name: public-gw
      namespace: infra
      sectionName: https
  hostnames:
    - shop.example.com
  rules:
    # 测试人员带请求头固定走新版本
    - matches:
        - path:
            type: PathPrefix
            value: /api/orders
          headers:
            - name: x-canary
              value: "true"
      backendRefs:
        - name: order-v2
          port: 8080
    # 其余流量按 90 / 10 分流，逐步调整为 70/30 → 40/60 → 0/100
    - matches:
        - path:
            type: PathPrefix
            value: /api/orders
      backendRefs:
        - name: order-v1
          port: 8080
          weight: 90
        - name: order-v2
          port: 8080
          weight: 10
```

`order-v1` 和 `order-v2` 是分别选中新旧版本 Pod 的两个 Service。Gateway API 按匹配的精确程度选规则，带请求头条件的规则优先于只有路径条件的规则，与书写顺序无关。

### 2、Istio：VirtualService + DestinationRule

服务网格内的东西向调用（服务 A 调服务 B）不经过入口网关，灰度要在网格里做。Istio 的 API 从 1.22 起提供 `v1` 版本，`hosts` 是必填字段，版本用 DestinationRule 的 subset 区分：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: order
  namespace: shop
spec:
  host: order
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: order
  namespace: shop
spec:
  hosts:
    - order                        # 匹配调用方访问的服务名
  http:
    - match:                       # 精确规则在前：按请求头固定走 v2
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: order
            subset: v2
    - route:                       # 兜底规则在后：按权重分流
        - destination:
            host: order
            subset: v1
          weight: 90
        - destination:
            host: order
            subset: v2
          weight: 10
```

VirtualService 的 `http` 规则按书写顺序匹配，第一条命中即生效，这点和 Gateway API 不同。Istio Ambient 模式下 L7 路由由 waypoint 代理执行，官方推荐用 Gateway API 的 HTTPRoute 表达；Sidecar 与 Ambient 的选择、DestinationRule 的连接池与异常剔除，见 [服务网格](/microservices/3_service_mesh)。

### 3、Ingress 注解方式（存量）

还在用 ingress-nginx（或兼容其注解的控制器）的存量集群，金丝雀靠注解实现。它要求**先有一个同 host、同 path 的主 Ingress**，金丝雀 Ingress 才会生效：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: order
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api/orders
            pathType: Prefix
            backend:
              service:
                name: order-v1
                port:
                  number: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: order-canary
  namespace: shop
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"       # 10% 流量到新版本
    nginx.ingress.kubernetes.io/canary-by-header: x-canary # 请求头为 always 时强制走金丝雀
spec:
  ingressClassName: nginx
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api/orders
            pathType: Prefix
            backend:
              service:
                name: order-v2
                port:
                  number: 8080
```

注解是控制器私有约定，换控制器就要重写；社区 ingress-nginx 已不再发布安全修复，这段配置只作为迁移前的过渡，迁移步骤见 [Nginx、Ingress 与 Gateway API](/cloud-native/7_nginx_ingress)。

### 4、灰度维度

| 维度 | 实现位置 | 适用场景 |
|------|---------|---------|
| 流量比例 | HTTPRoute 权重、VirtualService 权重 | 通用灰度，看整体指标 |
| 请求头 / Cookie | 网关或网格按 Header 匹配 | 内测人员、自动化验证 |
| 用户 ID / 白名单 | 网关按用户标识路由，或功能开关按用户判断 | 指定用户先用，体验一致 |
| 地域 / 机房 | 按机房分批发布，或网关按 IP 归属路由 | 分区域放量，缩小故障半径 |
| 租户 | 网关或功能开关按 tenantId 判断 | SaaS 产品分租户灰度 |

按比例分流时，同一个用户的多次请求可能落在不同版本上。需要「同一用户始终看到同一版本」的场景，用按用户 ID 路由或功能开关，而不是纯权重。Spring Cloud 体系下按请求头路由的负载均衡实现见 [Spring Cloud 服务治理](/spring-cloud/5_service_governance)。

---

## 五、渐进式交付：Argo Rollouts

手工改权重有两个问题：每一步都要有人盯着，以及「指标正不正常」靠人眼判断。渐进式交付（Progressive Delivery）把这两件事自动化：按步骤放量，每步用监控指标做分析，达标自动推进，不达标自动回滚。

![金丝雀渐进式交付：每步分析通过才推进，失败自动回滚](../assets/devops/release-strategy-canary.svg)

主流工具有两个：Argo Rollouts（Argo 项目，用 `Rollout` 资源替代 Deployment）和 Flagger（Flux 项目，在现有 Deployment 旁边自动生成金丝雀副本）。下面以 Argo Rollouts + Gateway API 为例，它和 Argo CD 配合时由 Argo CD 同步清单、Rollouts 执行发布过程，GitOps 部分见 [Argo CD](/cloud-native/9_argocd)。

### 1、Rollout：定义放量步骤

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: order
  namespace: shop
spec:
  replicas: 4
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: order
  template:
    metadata:
      labels:
        app: order
    spec:
      containers:
        - name: order
          image: registry.example.com/shop/order:1.4.0
          ports:
            - containerPort: 8080
  strategy:
    canary:
      stableService: order-stable     # Rollouts 会给它注入稳定版本的 Pod 选择器
      canaryService: order-canary     # 同上，指向金丝雀版本
      trafficRouting:
        plugins:
          argoproj-labs/gatewayAPI:   # Gateway API 插件，改写下面 HTTPRoute 的权重
            httpRoute: order
            namespace: shop
      analysis:                       # 后台分析：从第 2 步开始持续运行，失败即中止
        startingStep: 1
        templates:
          - templateName: success-rate
        args:
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest
      steps:
        - setWeight: 10
        - pause: { duration: 5m }
        - setWeight: 30
        - pause: { duration: 5m }
        - setWeight: 60
        - pause: { duration: 10m }
```

对应的 HTTPRoute 只需写好两个后端，权重由 Rollouts 在发布过程中改写，初始值保持「稳定版本 100、金丝雀 0」：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order
  namespace: shop
spec:
  parentRefs:
    - name: public-gw
      namespace: infra
      sectionName: https
  hostnames:
    - shop.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/orders
      backendRefs:
        - name: order-stable
          port: 8080
          weight: 100
        - name: order-canary
          port: 8080
          weight: 0
```

`order-stable` 与 `order-canary` 是两个普通 Service，selector 都写 `app: order`、端口 8080，Rollouts 运行时再追加版本哈希。Gateway API 插件需要先在 `argo-rollouts-config` ConfigMap 的 `trafficRouterPlugins` 中登记下载地址，具体写法见文末的插件文档。

### 2、AnalysisTemplate：用指标判断能否推进

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
  namespace: shop
spec:
  args:
    - name: canary-hash
  metrics:
    - name: success-rate
      interval: 1m                    # 每分钟查一次
      failureLimit: 2                 # 累计失败 2 次即判定分析失败
      successCondition: result[0] >= 0.99
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(rate(http_server_requests_seconds_count{namespace="shop",rollouts_pod_template_hash="{{args.canary-hash}}",outcome!="SERVER_ERROR"}[2m]))
            /
            sum(rate(http_server_requests_seconds_count{namespace="shop",rollouts_pod_template_hash="{{args.canary-hash}}"}[2m]))
```

`http_server_requests_seconds_count` 是 Spring Boot（Micrometer）暴露的 HTTP 请求计数，`outcome` 标签区分成功与服务端错误。查询按 `rollouts_pod_template_hash` 只统计金丝雀 Pod，前提是 Prometheus 抓取时用 relabel 把这个 Pod 标签带进指标；指标接入见 [指标监控](/observability/2_metrics)。

发布过程中的操作：

| 操作 | 命令 |
|------|------|
| 查看进度与每步状态 | `kubectl argo rollouts get rollout order -n shop --watch` |
| 跳过当前暂停，进入下一步 | `kubectl argo rollouts promote order -n shop` |
| 手工中止，权重归零回到稳定版本 | `kubectl argo rollouts abort order -n shop` |
| 回退到上一个版本 | `kubectl argo rollouts undo order -n shop` |

分析失败时 Rollouts 自动中止，金丝雀权重归零，流量全部回到稳定版本，Rollout 状态变为 `Degraded`；修复后推送新镜像会开始新一轮发布。

::: tip 分析指标怎么选
优先用和 SLO 一致的指标：成功率、P99 延迟、关键业务量（如下单数）是否异常下跌。样本太少时比率波动很大，放量早期（1%～5%）的分析窗口要长一些，或者在查询里加最小请求数条件。SLO 与错误预算见 [可用性度量](/high-avail/1_sla_slo)。
:::

---

## 六、功能开关与暗发布

### 1、功能开关：把部署和发布分开

功能开关（Feature Flag）让新代码随版本部署到生产，但默认关闭，再按用户、租户、比例逐步打开。好处是回滚不需要重新部署，关开关即可；主干开发时未完成的功能也能安全合入，与 [Git 工作流](./1_git_workflow) 的主干开发配合使用。

开关的取值来源可以是配置中心，也可以是专门的开关平台（Unleash、flagd、LaunchDarkly 等）。CNCF 的 OpenFeature 定义了与厂商无关的 SDK 接口，业务代码只依赖 OpenFeature API，后端换平台时只换 Provider：

```java
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.Value;
import java.util.Map;

public class CheckoutService {

    private final Client flags = OpenFeatureAPI.getInstance().getClient();

    public Receipt checkout(Order order) {
        // targetingKey 用用户 ID，平台据此做按用户或按比例的稳定分桶
        var ctx = new ImmutableContext(order.userId(),
                Map.of("tenant", new Value(order.tenantId())));
        if (flags.getBooleanValue("new-checkout", false, ctx)) {
            return newCheckout(order);
        }
        return legacyCheckout(order);
    }
}
```

应用启动时调用一次 `OpenFeatureAPI.getInstance().setProviderAndWait(provider)` 注册具体平台的 Provider。默认值 `false` 是兜底：开关平台不可用时走旧逻辑。基于配置中心的简单实现与多环境开关配置见 [环境管理](./7_env_management)。

开关的治理：

- **分类型管理**：发布开关（灰度用，全量后删除）、运维开关（降级用，长期保留）、实验开关（A/B 用，实验结束删除），不同类型有不同的生命周期
- **设负责人和到期时间**：发布开关全量后在下一个迭代删除代码分支，否则开关组合越来越多，测试覆盖不了
- **变更有审计**：生产开关的修改和代码发布一样要有记录，故障排查时能关联到「刚刚改了哪个开关」

### 2、暗发布：用真实流量验证但不影响用户

暗发布（Dark Launch）让新版本处理真实请求，但结果不返回给用户。常见两种做法：

| 做法 | 实现 | 适用场景 |
|------|------|---------|
| 流量镜像 | 网关把请求复制一份发给新版本，丢弃其响应 | 重构后的服务做性能和结果比对 |
| 代码内双跑 | 功能开关打开「影子模式」，新旧逻辑都执行，只返回旧结果并记录差异 | 计费、风控等计算逻辑替换 |

Gateway API 的 `RequestMirror` 过滤器可以直接做流量镜像：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order
  namespace: shop
spec:
  parentRefs:
    - name: public-gw
      namespace: infra
      sectionName: https
  hostnames:
    - shop.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/orders
      filters:
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: order-v2       # 镜像流量发给新版本，响应被丢弃
              port: 8080
      backendRefs:
        - name: order-v1           # 用户实际拿到的是旧版本的响应
          port: 8080
```

::: warning 镜像流量会产生真实副作用
被镜像的写请求在新版本上同样会执行：写数据库、发消息、调用第三方支付。镜像只适合只读接口，或新版本连接隔离的影子库、关闭对外调用；否则会出现重复下单、重复扣款。
:::

---

## 七、上线检查单

检查单把「可灰度、可监控、可回滚」落到每次发布，原则见 [优雅上下线与变更 - 变更三板斧](/high-avail/8_graceful_release)。代码评审要求见 [Code Review](./3_code_review)，制品与镜像版本见 [制品与版本管理](./6_artifact_version)。

### 1、发布前

- [ ] 变更已评审合并，CI 通过，镜像按不可变标签或 digest 引用
- [ ] 预发环境验证通过（功能 + 回归 + 关键链路冒烟）
- [ ] 数据库变更符合先扩展后收缩，脚本已在预发执行过，大表变更评估过锁表风险
- [ ] 配置变更已在配置中心预发命名空间验证，生产配置差异已核对
- [ ] 回滚方案明确：上一个版本号、开关名称、需要人工处理的数据
- [ ] 发布窗口避开业务高峰，不在封网期；已通知关联团队

### 2、发布中

- [ ] 发布大盘打开，按版本对比成功率、P99、QPS
- [ ] 金丝雀每一步都等分析结果或观察期结束，再推进
- [ ] 关键接口冒烟通过
- [ ] 出现异常先回滚，再定位

### 3、发布后

- [ ] 错误率、P99 与发布前基线持平
- [ ] 核心业务指标（下单量、支付成功率）无异常下跌
- [ ] 无新增告警；日志中无新的异常类型
- [ ] 发布记录已更新，发布开关的清理已排期

---

## 八、回滚

回滚的第一原则：**代码可以随时退，数据不能退**。所有变更都按「回滚代码时不需要回滚数据」来设计。

### 1、代码回滚

| 发布方式 | 回滚做法 |
|------|------|
| Deployment 滚动 | `kubectl rollout undo deployment/order -n shop`，或 `--to-revision=<n>` 回到指定版本，`kubectl rollout history` 查看历史 |
| 蓝绿 | Service selector 或 activeService 指回旧版本 |
| 金丝雀 / Argo Rollouts | `kubectl argo rollouts abort`，权重归零 |
| GitOps 管理的应用 | 在配置仓库 `git revert` 镜像版本的提交，由 Argo CD 同步，避免集群与 Git 不一致 |
| 功能开关 | 关闭开关，无需部署 |

用了 Argo CD 自动同步时，直接在集群里 `kubectl rollout undo` 会被下一次同步改回去，回滚要走 Git，见 [Argo CD](/cloud-native/9_argocd)。

### 2、数据库变更：先扩展后收缩

「发布脚本 ADD COLUMN、回滚脚本 DROP COLUMN」看起来对称，实际上 DROP 会丢掉发布后写入的数据。正确做法是让表结构始终兼容新旧两个版本的代码：

| 阶段 | 操作 | 回滚代码是否安全 |
|------|------|-----------------|
| 扩展 | 新增列 / 表，允许为空或有默认值；新代码同时写新旧字段 | 安全，旧代码忽略新列 |
| 迁移 | 回填历史数据，新代码切换为读新字段 | 安全，旧字段仍在更新 |
| 收缩 | 观察至少一个发布周期后，代码不再使用旧字段，再删除旧列 | 安全，此时已不会回退到依赖旧列的版本 |

改列类型、改列名同样拆成「加新列 → 双写 → 切读 → 删旧列」。迁移脚本用 Flyway 版本化管理，见 [数据库版本迁移](/spring-boot/4_flyway)。

### 3、配置回滚

Nacos、Apollo 都保留配置历史，可以回滚到任一版本。配置变更是秒级全量生效的，比代码发布更危险，同样要先灰度到少量实例，见 [优雅上下线与变更 - 配置与数据变更](/high-avail/8_graceful_release)。

---

## 九、度量与复盘

### 1、DORA 指标

DORA（DevOps Research and Assessment）用 5 个指标衡量软件交付表现，分为吞吐和稳定性两类：

| 类别 | 指标 | 含义 |
|------|------|------|
| 吞吐 | 部署频率（Deployment frequency） | 一段时间内部署到生产的次数 |
| 吞吐 | 变更前置时间（Change lead time） | 代码提交到在生产运行所需的时间 |
| 吞吐 | 失败部署恢复时间（Failed deployment recovery time） | 部署失败、需要立即干预后，恢复服务所需的时间 |
| 稳定性 | 变更失败率（Change fail rate） | 部署后需要立即干预（回滚、热修复）的比例 |
| 稳定性 | 部署返工率（Deployment rework rate） | 因生产事故而触发的计划外部署所占的比例 |

旧版四指标中的 MTTR 已被「失败部署恢复时间」取代：后者只统计由部署引起的故障，不混入硬件故障、外部依赖故障。DORA 的研究结论是吞吐和稳定性并不冲突，小批量、高频发布的团队往往两者都更好。

落地时数据来源：

- 部署频率、前置时间：CI/CD 流水线与 Git 提交时间，见 [CI/CD](./2_ci_cd)
- 变更失败率、返工率：发布记录中标记为回滚或热修复的部署
- 恢复时间：故障工单中「部署时间」到「恢复时间」的差值

指标用于观察团队趋势，不要拿来做个人考核，否则数据会被「优化」得失去意义。

### 2、发布记录与复盘

每次发布留一条记录，发布引起故障时它就是复盘的起点：

| 字段 | 示例 |
|------|------|
| 版本 | order 1.4.0（镜像 digest 前 12 位） |
| 时间 / 负责人 | 2026-10-08 21:00，张三 |
| 变更内容 | 订单超时自动取消；新增 `orders.cancel_at` 列 |
| 发布方式 | Argo Rollouts 金丝雀 10% → 30% → 60% → 100% |
| 结果 | 成功 / 回滚 / 热修复（用于计算变更失败率与返工率） |
| 关联开关 | `auto-cancel`，计划 2026-10-22 清理 |

发布导致故障时按无责复盘处理：还原时间线、用 5 Whys 找到流程上的根因（例如「检查单没有配置核对项」），改进项要有负责人和截止时间。复盘模板、时间线与改进项跟踪见 [故障应急与复盘](/high-avail/11_incident_response)。

---

## 小结

- 滚动发布是默认选择，用 `maxUnavailable: 0` + `maxSurge` 保证可用实例数，探针用 Boot 的 readiness / liveness 分组，preStop 用原生 `sleep` 动作
- 蓝绿切换不是瞬时的：长连接仍会留在旧环境，旧环境要保留到观察期结束
- 金丝雀优先用 Gateway API HTTPRoute 权重；网格内用 Istio `v1` 的 VirtualService（`hosts` 必填）；ingress-nginx 注解只用于存量过渡
- 渐进式交付用 Argo Rollouts 或 Flagger：按步骤放量，Prometheus 指标分析不达标自动回滚
- 功能开关把部署与发布分开，开关要分类、有负责人和到期时间；暗发布注意镜像写请求的副作用
- 回滚代码不回滚数据：表结构按先扩展后收缩演进
- 用 DORA 的 5 个指标衡量交付能力，发布记录是复盘的起点

---

## 参考资料

- Kubernetes Deployment 与滚动更新：[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- Kubernetes 容器生命周期钩子（sleep 动作）：[Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- KEP-3960 Pod 生命周期 sleep 动作：[Pod lifecycle sleep action](https://www.kubernetes.dev/resources/keps/3960/)
- Gateway API 流量拆分：[HTTP traffic splitting](https://gateway-api.sigs.k8s.io/guides/traffic-splitting/)
- Gateway API 请求镜像：[HTTP request mirroring](https://gateway-api.sigs.k8s.io/guides/http-request-mirroring/)
- ingress-nginx 退役公告：[Ingress NGINX Retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- ingress-nginx 金丝雀注解：[Annotations - Canary](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/#canary)
- Istio 流量管理：[Traffic Management](https://istio.io/latest/docs/concepts/traffic-management/)
- Istio VirtualService 参考：[Virtual Service](https://istio.io/latest/docs/reference/config/networking/virtual-service/)
- Argo Rollouts 金丝雀：[Canary Deployment Strategy](https://argoproj.github.io/argo-rollouts/features/canary/)
- Argo Rollouts 蓝绿：[BlueGreen Deployment Strategy](https://argoproj.github.io/argo-rollouts/features/bluegreen/)
- Argo Rollouts 分析：[Analysis & Progressive Delivery](https://argoproj.github.io/argo-rollouts/features/analysis/)
- Argo Rollouts Gateway API 插件：[Gateway API plugin](https://rollouts-plugin-trafficrouter-gatewayapi.readthedocs.io/)
- Flagger：[Flagger 文档](https://docs.flagger.app/)
- OpenFeature Java SDK：[open-feature/java-sdk](https://github.com/open-feature/java-sdk)
- DORA 指标：[DORA's software delivery performance metrics](https://dora.dev/guides/dora-metrics/)

> 下一篇：[制品与版本管理](./6_artifact_version)

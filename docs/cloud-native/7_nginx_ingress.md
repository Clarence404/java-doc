---
description: Nginx 反向代理、Ingress 与 pathType、ingress-nginx 退役迁移、Gateway API
---

# Nginx、Ingress 与 Gateway API

> **本篇目标**：能写出一个可用的 Nginx 反向代理配置，掌握 Kubernetes Ingress 的资源模型与 `pathType` 匹配规则，了解社区 ingress-nginx 退役的影响，并能用 Gateway API（GatewayClass / Gateway / HTTPRoute）搭出一套南北向入口、从 Ingress 平滑迁移过去。
>
> **前置阅读**：[Kubernetes](./6_kubernetes)（Pod、Service、Deployment）

南北向流量指从集群外部进入集群的流量。本篇以 2026 年 10 月为基线：Kubernetes 官方已冻结 Ingress API、推荐改用 Gateway API；社区版 ingress-nginx 控制器已在 2026 年 3 月停止维护。入口分层（DNS、CDN、LVS / SLB）这类系统级架构见 [接入层架构](/high-con/1_access_layer)，TLS 握手与证书链原理见 [HTTPS 与 TLS](/protocols/3_https_tls)。

---

## 一、南北向入口的位置

一个请求从公网到达 Pod，通常要经过这几跳：

1. **外部负载均衡**：云厂商的 SLB / NLB，或自建 LVS，负责四层转发，给入口一个固定的公网 IP
2. **七层入口**：Nginx、Ingress 控制器或 Gateway API 实现，按域名和路径路由、卸载 TLS
3. **Service**：集群内的稳定访问点，入口控制器通常直接读取它背后的 Endpoints，把请求发给 Pod
4. **Pod**：真正处理请求的应用实例

虚拟机时代，第 2 跳就是一台手工维护配置的 Nginx。到了 Kubernetes，Pod 的 IP 随时在变，手写 `upstream` 不再可行，于是有了**控制器模式**：用户只声明「哪个域名、哪个路径转给哪个 Service」，控制器监听这些资源，自动生成并热加载代理配置。Ingress 和 Gateway API 就是这份声明的两代标准。

---

## 二、Nginx 反向代理要点

不管入口最终跑在 Kubernetes 里还是虚拟机上，Nginx 的配置模型都值得掌握：很多 Ingress 控制器底层就是 Nginx，排查问题时最终还是要看生成的 `nginx.conf`。

### 1、一个可用的 server 块

下面的配置可以直接放进 `/etc/nginx/conf.d/shop.conf`，用 `nginx -t` 校验后 `nginx -s reload` 生效：

```nginx
upstream order_backend {
    least_conn;                                   # 选当前连接数最少的节点
    server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;                                 # 每个 worker 与上游保持的空闲长连接数
}

server {
    listen 80;
    server_name shop.example.com;

    # 健康检查：精确匹配，命中后不再找其他 location
    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    # 静态资源：/static/app.js -> /var/www/shop/static/app.js
    location ^~ /static/ {
        root /var/www/shop;
        expires 7d;
    }

    # 接口反向代理
    location /api/ {
        proxy_pass http://order_backend;          # 末尾不带 /，URI 原样转发
        proxy_http_version 1.1;                   # 上游长连接需要 HTTP/1.1
        proxy_set_header Connection "";           # 清掉 Connection: close
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;                   # 两次读之间的间隔，不是整个请求的总时长
    }
}
```

几个容易踩的点：

- **`keepalive` 要配套**：只写 `keepalive 32` 不够，必须同时设置 `proxy_http_version 1.1` 和清空 `Connection` 头，否则 Nginx 每个请求都会和上游新建 TCP 连接，高并发下产生大量 TIME_WAIT
- **`proxy_pass` 末尾的斜杠**：`location /api/` 配 `proxy_pass http://order_backend/;`（带斜杠）会把 `/api/` 前缀替换成 `/`，后端收到的是 `/orders`；不带斜杠则原样转发 `/api/orders`
- **`proxy_read_timeout` 默认 60 秒**：慢接口、SSE、长轮询要单独调大，否则 Nginx 主动断开并返回 504
- **后端拿真实 IP 和协议**：Spring Boot 应用配置 `server.forward-headers-strategy: native`（Tomcat 读取 `X-Forwarded-*`），否则重定向地址会变成 `http://` 或内网地址

负载均衡算法、健康检查与会话保持见 [负载均衡](/high-avail/3_load_balancing)；`limit_req` 限流和前面有 CDN 时用 `real_ip` 模块取真实 IP 见 [接入层架构](/high-con/1_access_layer)。

### 2、location 匹配优先级

| 写法 | 含义 | 优先级 |
|------|------|--------|
| `location = /healthz` | 精确匹配 | 最高，命中即停止 |
| `location ^~ /static/` | 前缀匹配，命中后不再检查正则 | 次之 |
| `location ~ \.php$` / `~*` | 正则匹配（`~*` 不区分大小写） | 按配置文件中出现的顺序，第一个命中的胜出 |
| `location /api/` | 普通前缀匹配 | 最低，多个命中时取最长的那个 |

实际流程是：先找出最长的普通前缀匹配并记住；如果它带 `^~` 就直接用；否则依次检查正则，命中第一个就用正则的；都不命中再回到记住的最长前缀。

---

## 三、Kubernetes Ingress

### 1、资源模型

Ingress 体系由三部分组成：

- **Ingress 控制器**：真正处理流量的进程，以 Deployment 形式跑在集群里，前面通常挂一个 `type: LoadBalancer` 的 Service。Kubernetes 本身不带控制器，需要单独安装
- **IngressClass**：声明「某一类 Ingress 由哪个控制器处理」，一般由控制器的 Helm Chart 自动创建；加上注解 `ingressclass.kubernetes.io/is-default-class: "true"` 后成为默认类
- **Ingress**：应用开发者编写的路由规则，通过 `ingressClassName` 选择控制器

```yaml
# IngressClass：通常由控制器安装时创建，这里以 Traefik 为例
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: public
spec:
  controller: traefik.io/ingress-controller
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  namespace: shop
spec:
  ingressClassName: public
  tls:
    - hosts:
        - shop.example.com
      secretName: shop-example-com-tls   # 同命名空间下 kubernetes.io/tls 类型的 Secret
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api/orders
            pathType: Prefix
            backend:
              service:
                name: order-service
                port:
                  number: 8080
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

### 2、pathType

`networking.k8s.io/v1` 要求每条路径都显式写 `pathType`：

| pathType | 匹配规则 | 示例：`path: /foo` |
|----------|----------|--------------------|
| `Exact` | 完整路径精确匹配，区分大小写 | 匹配 `/foo`，不匹配 `/foo/`、`/foo/bar` |
| `Prefix` | 按 `/` 切分后逐段做前缀匹配 | 匹配 `/foo`、`/foo/`、`/foo/bar`，**不匹配** `/foobar` |
| `ImplementationSpecific` | 由控制器自行解释 | 行为取决于实现，换控制器时最容易出问题 |

同一个 Host 下多条路径都能命中时，最长的路径优先；长度相同时 `Exact` 优先于 `Prefix`。

> [!tip]
> 新写的 Ingress 尽量只用 `Exact` 和 `Prefix`。`ImplementationSpecific` 加正则路径是迁移到其他控制器或 Gateway API 时最大的兼容性风险。

### 3、Ingress 的局限

Ingress 规范只定义了「域名 + 路径 → Service」和 TLS，这之外的能力（重写、限流、超时、灰度、跨域、请求头改写）全靠控制器私有注解，例如 `nginx.ingress.kubernetes.io/canary-weight`。结果是：

- **不可移植**：换一个控制器，注解几乎要全部重写
- **职责混在一起**：监听端口、证书这类运维关心的配置和业务路由写在同一个对象里，权限难以拆分
- **只覆盖 HTTP**：TCP / UDP / gRPC 的路由没有标准写法

Kubernetes 官方文档已明确：Ingress API 已冻结，不再增加新特性，但作为 GA API 不会被移除；新项目推荐使用 Gateway API。

---

## 四、社区 ingress-nginx 退役

### 1、时间线与影响

| 时间 | 事件 |
|------|------|
| 2025-11-11 | Kubernetes SIG Network 与安全响应委员会宣布退役社区版 ingress-nginx |
| 2026-01-29 | Kubernetes 指导委员会与安全响应委员会联合发声明，敦促尽快迁移 |
| 2026-03 | 尽力维护期结束，此后不再发布任何版本、缺陷修复或安全补丁 |

已部署的实例**不会自动停止工作**，安装清单和镜像也继续可下载。真正的风险在于：作为直接暴露在公网的组件，之后发现的任何漏洞都不会再有上游修复。

### 2、别和 F5 NGINX Ingress Controller 混淆

两个名字很像的项目经常被搞混：

| 项目 | 维护方 | 注解前缀 | 状态 |
|------|--------|----------|------|
| `kubernetes/ingress-nginx` | Kubernetes 社区 | `nginx.ingress.kubernetes.io/` | 已退役 |
| NGINX Ingress Controller（`nginx/kubernetes-ingress`） | F5 / NGINX | `nginx.org/` | 继续维护，也提供 Gateway API 实现（NGINX Gateway Fabric） |

判断集群里装的是哪一个，看 Ingress 上的注解前缀或控制器镜像名即可。

### 3、出路

- **首选**：迁移到 Gateway API，实现可选 Envoy Gateway、Istio、Cilium、NGINX Gateway Fabric、Traefik、Kong 或云厂商的托管网关
- **过渡**：短期内无法改资源模型时，换一个仍在维护的 Ingress 控制器（Traefik、HAProxy、F5 NGINX Ingress Controller 等），保留 Ingress 资源，只改写注解
- **继续用旧版**：只能作为临时状态，至少要收紧暴露面（只开放必要端口、禁用 `configuration-snippet` 这类允许注入任意配置的注解），并排期迁移

---

## 五、Gateway API

### 1、资源模型与角色分工

![Ingress 与 Gateway API 资源模型](../assets/cloud-native/ingress-gateway-model.svg)

Gateway API 把 Ingress 一个对象拆成三层，分别对应三类角色：

- **GatewayClass**（基础设施提供方）：声明用哪个实现，类似 IngressClass
- **Gateway**（集群运维）：一个具体的入口实例，定义监听的端口、协议、域名和证书，以及允许哪些命名空间的路由挂上来
- **HTTPRoute**（应用开发者）：业务路由，通过 `parentRefs` 挂到 Gateway 上，按 host、路径、请求头匹配，转发到一个或多个 Service

此外还有 `GRPCRoute`、`TLSRoute` 等路由类型，以及跨命名空间引用时用来授权的 `ReferenceGrant`。核心资源在 2023 年 10 月的 v1.0 进入 GA，之后每个版本持续把实验特性提升到标准通道；本文示例只用标准通道（Standard channel）的字段。

### 2、安装一个实现

Gateway API 的 CRD 不随 Kubernetes 内置，需要安装一个实现。以 Envoy Gateway 为例，它的 Helm Chart 会一并安装 Gateway API 的标准 CRD（Helm 用法见下一篇 [Helm](./8_helm)）：

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.2 -n envoy-gateway-system --create-namespace

kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available
```

如果选的实现不自带 CRD，可以单独安装官方发布的标准通道清单（版本号以 Gateway API 发布页为准）：

```bash
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml
```

### 3、完整示例：HTTPS 入口 + 灰度

先准备两个命名空间和证书。生产环境证书一般由 cert-manager 自动签发和续期，这里用已有证书演示：

```bash
kubectl create namespace infra
kubectl create namespace shop
kubectl create secret tls example-com-tls -n infra \
  --cert=tls.crt --key=tls.key
```

运维在 `infra` 命名空间创建 GatewayClass 和 Gateway：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public-gw
  namespace: infra
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same               # 80 端口只接受 infra 内的路由（用于跳转 HTTPS）
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.example.com"
      tls:
        mode: Terminate            # 在网关卸载 TLS
        certificateRefs:
          - kind: Secret
            name: example-com-tls
      allowedRoutes:
        namespaces:
          from: All                # 生产中可改为 Selector，只放行打了标签的命名空间
---
# HTTP 统一 301 跳转到 HTTPS
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: infra
spec:
  parentRefs:
    - name: public-gw
      sectionName: http
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

应用开发者在自己的 `shop` 命名空间写 HTTPRoute，把 10% 的流量切到新版本：

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
      timeouts:
        request: 30s               # 整个请求的超时
      backendRefs:
        - name: order-v1
          port: 8080
          weight: 90
        - name: order-v2
          port: 8080
          weight: 10
```

验证：

```bash
# 看 Gateway 是否已分配地址、状态为 Programmed
kubectl get gateway public-gw -n infra

# 看路由是否被 Gateway 接受（status.parents[].conditions 中 Accepted=True）
kubectl get httproute order -n shop -o yaml

GW_IP=$(kubectl get gateway public-gw -n infra -o jsonpath='{.status.addresses[0].value}')
curl --resolve shop.example.com:443:$GW_IP https://shop.example.com/api/orders
```

证书是自签名的话，`curl` 需要加 `-k` 或用 `--cacert` 指定 CA。按请求头灰度、流量镜像等更多写法，以及网格内东西向流量的 Gateway API 用法，见 [服务网格](/microservices/3_service_mesh)；发布流程层面的灰度策略见 [发布策略](/devops/5_release_strategy)。

### 4、证书自动化

- **cert-manager** 是集群内签发与续期证书的事实标准：Ingress 上加注解 `cert-manager.io/cluster-issuer: <issuer 名>`，它会自动申请证书并写入 `tls.secretName` 指定的 Secret
- cert-manager 同样支持为 Gateway 的 HTTPS 监听签发证书，但需要在 cert-manager 中开启 Gateway API 支持，具体参数见其官方文档
- 证书链、SNI、TLS 1.3 握手等原理不在本篇展开，见 [HTTPS 与 TLS](/protocols/3_https_tls)

---

## 六、Ingress 与 Gateway API 对比

| 维度 | Ingress | Gateway API |
|------|---------|-------------|
| 状态 | GA，已冻结，不再演进 | GA，持续迭代，官方推荐 |
| 资源拆分 | IngressClass + Ingress | GatewayClass + Gateway + 各类 Route |
| 角色分工 | 运维与开发共用一个对象 | 基础设施、集群运维、应用开发各管一层 |
| 协议 | HTTP / HTTPS | HTTP、HTTPS、gRPC、TLS 透传，TCP / UDP 在实验通道 |
| 路径匹配 | `Exact` / `Prefix` / 实现自定义 | `Exact` / `PathPrefix` / `RegularExpression`（正则为扩展支持） |
| 头部匹配、重定向、改写 | 私有注解 | 标准字段（`matches.headers`、`filters`） |
| 按权重灰度 | 私有注解 | `backendRefs[].weight` 标准字段 |
| 跨命名空间 | 不支持，Ingress 只能指向同命名空间的 Service | Route 挂到其他命名空间的 Gateway；引用其他命名空间的后端需 `ReferenceGrant` 授权 |
| 状态反馈 | 只有分配的地址 | 每个 Route 有 `Accepted` / `ResolvedRefs` 等条件，便于排查 |
| 可移植性 | 差，注解随控制器而变 | 标准字段在各实现间一致，扩展能力通过 Policy 类资源附加 |

选型建议很直接：**新集群直接上 Gateway API**；已有 Ingress 的集群，如果用的是社区 ingress-nginx，按第七节排期迁移；用的是其他仍在维护的控制器，可以在下一次大改动时顺带迁移。

---

## 七、从 Ingress 迁移到 Gateway API

### 1、迁移步骤

1. **盘点现状**：列出所有 Ingress 和用到的注解，注解越多，迁移工作量越大

   ```bash
   kubectl get ingress -A
   kubectl get ingress -A -o yaml | grep -o 'nginx.ingress.kubernetes.io/[a-z-]*' | sort | uniq -c
   ```

2. **选定实现并安装**：新实现会分配一个新的负载均衡地址，和旧控制器并行运行，互不影响

3. **用 ingress2gateway 生成初稿**：Kubernetes SIG Network 维护的转换工具，2026 年 3 月发布 1.0，能把 Ingress 及部分 ingress-nginx 注解转换成 Gateway / HTTPRoute

   ```bash
   go install github.com/kubernetes-sigs/ingress2gateway@v1.0.0
   # 读取当前集群所有命名空间的 Ingress，输出 Gateway API 资源
   ingress2gateway print --providers=ingress-nginx --all-namespaces > gateway-resources.yaml
   # 也可以离线转换清单文件
   ingress2gateway print --providers=ingress-nginx --input-file=ingress.yaml
   ```

4. **人工审查**：工具输出的是初稿，无法转换的注解会给出提示；把 GatewayClass 改成自己的实现，按角色拆分 Gateway 与 HTTPRoute 的归属

5. **并行验证**：用 `curl --resolve` 直接打新网关地址做回归，对比状态码、重定向、请求头和超时行为

6. **切流量**：DNS 逐步指向新地址（先降低 TTL），旧控制器保留一段时间用于回滚，确认无流量后再下线

### 2、常见坑

- **私有注解没有对应字段**：`configuration-snippet`、`server-snippet` 这类直接注入 Nginx 配置的注解，只能改用实现自己的扩展资源（如 Envoy Gateway 的 `BackendTrafficPolicy`、`SecurityPolicy`）重新表达
- **路径语义差异**：ingress-nginx 在某些注解（如 `use-regex`、`rewrite-target`）下会把同一 Host 的所有路径都当正则处理，迁移后匹配结果可能变化，官方博客专门整理了这类「出乎意料的默认行为」，迁移前务必对照一遍
- **默认超时与请求体大小**：旧控制器的默认值（读超时、`proxy-body-size`）和新实现不同，大文件上传、慢接口要显式配置
- **客户端真实 IP**：外部负载均衡到网关这一跳是否保留源 IP（`externalTrafficPolicy: Local` 或 PROXY protocol），需要在新实现上重新确认

---

## 八、Nginx、API 网关与服务网格的边界

| 组件 | 管什么 | 典型能力 | 详见 |
|------|--------|----------|------|
| Nginx / Ingress / Gateway API | 南北向入口：外部流量进集群 | 域名路由、TLS 卸载、静态资源、粗粒度限流 | 本篇 |
| API 网关（Spring Cloud Gateway 等） | 业务入口：面向 API 的治理 | 统一鉴权、按用户限流、协议转换、聚合 | [API 网关](/spring-cloud/2_api_gateway) |
| 服务网格（Istio、Linkerd） | 东西向：服务之间的调用 | mTLS、重试熔断、细粒度流量、调用观测 | [服务网格](/microservices/3_service_mesh)、[Service Mesh](./10_service_mesh) |

常见的组合是：云负载均衡 → Gateway API 实现（TLS 卸载、域名路由）→ 业务 API 网关（鉴权、业务限流）→ 微服务。小团队不必每层都上：Gateway API 已经能做路由、重定向、权重灰度，很多场景不再需要单独的 Nginx 层；只有当鉴权、按租户限流这类逻辑需要用 Java 编写时，才值得再加一层业务网关。

---

## 小结

- 七层入口的本质是反向代理；Kubernetes 用控制器模式把「声明路由」和「生成代理配置」分开
- Nginx 配置重点：上游长连接三件套、`proxy_pass` 斜杠语义、`proxy_read_timeout`、location 优先级
- Ingress 只标准化了 host / path / TLS，其余全靠私有注解；`pathType` 优先用 `Exact` 和 `Prefix`；Ingress API 已冻结
- 社区 ingress-nginx 已于 2026 年 3 月停止维护，不再有安全补丁；注意与 F5 的 NGINX Ingress Controller 区分
- Gateway API 按角色拆成 GatewayClass / Gateway / HTTPRoute，权重灰度、重定向、头部匹配、超时都是标准字段
- 迁移路径：盘点注解 → 安装新实现 → ingress2gateway 生成初稿 → 并行验证 → DNS 切流

---

## 参考资料

- Kubernetes 文档 Ingress：[https://kubernetes.io/docs/concepts/services-networking/ingress/](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- Kubernetes 文档 Gateway API：[https://kubernetes.io/docs/concepts/services-networking/gateway/](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- Gateway API 官方站点：[https://gateway-api.sigs.k8s.io/](https://gateway-api.sigs.k8s.io/)
- Ingress NGINX Retirement: What You Need to Know（2025-11-11）：[https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- Ingress NGINX: Statement from the Kubernetes Steering and Security Response Committees（2026-01-29）：[https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)
- Before You Migrate: Five Surprising Ingress-NGINX Behaviors You Need to Know：[https://kubernetes.io/blog/2026/02/27/ingress-nginx-before-you-migrate/](https://kubernetes.io/blog/2026/02/27/ingress-nginx-before-you-migrate/)
- Announcing Ingress2Gateway 1.0：[https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)
- ingress2gateway 仓库：[https://github.com/kubernetes-sigs/ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway)
- Envoy Gateway Quickstart：[https://gateway.envoyproxy.io/docs/tasks/quickstart/](https://gateway.envoyproxy.io/docs/tasks/quickstart/)
- Nginx 文档 ngx_http_core_module（location）：[https://nginx.org/en/docs/http/ngx_http_core_module.html#location](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)
- Nginx 文档 ngx_http_upstream_module（keepalive）：[https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive)
- cert-manager 文档：[https://cert-manager.io/docs/](https://cert-manager.io/docs/)

> 下一篇：[Helm](./8_helm) —— 用 Chart 打包 Kubernetes 应用，管理安装、升级与回滚。

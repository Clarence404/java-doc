---
description: 云原生栈中的位置、Sidecar 与 Ambient 安装、平台前置条件、控制面与数据面升级
---

# Service Mesh

> **本篇目标**：从运维角度了解服务网格在 Kubernetes 上怎么装、装之前要确认什么、怎么升级；概念、流量管理与选型取舍见主文 [服务网格](/microservices/3_service_mesh)。
>
> **前置阅读**：[Kubernetes](./6_kubernetes)、[Nginx、Ingress 与 Gateway API](./7_nginx_ingress)

---

## 一、在云原生栈中的位置

- **南北向流量**（集群外 → 集群内）：由 Ingress 或 Gateway API 的网关负责，见 [Nginx、Ingress 与 Gateway API](./7_nginx_ingress)
- **东西向流量**（服务 → 服务）：由服务网格接管，提供 mTLS、重试超时、流量切分与统一遥测
- 数据面有两种形态：每个 Pod 注入 Envoy 的 **Sidecar 模式**，以及每节点 ztunnel 负责 L4、按需部署 waypoint 负责 L7 的 **Ambient 模式**（Istio 1.24 起 GA）。两者的原理与对比见 [服务网格 · 数据面](/microservices/3_service_mesh)，mTLS 的协议基础见 [HTTPS 与 TLS](/protocols/3_https_tls)

下文以 Istio 为例，截至 2026 年 10 月最新版本为 1.31。

---

## 二、安装方式

Istio 支持 `istioctl` 和 Helm 两种安装方式。快速试用用 `istioctl install --set profile=ambient`（或默认 profile 的 Sidecar 模式）；生产环境更常用 Helm，便于纳入 [Helm](./8_helm) 或 [Argo CD](./9_argocd) 统一管理。

Ambient 模式用 Helm 安装的完整步骤：

```bash
helm repo add istio https://blob.istio.io/istio-release/charts
helm repo update

# 1. CRD 与集群级资源
helm install istio-base istio/base -n istio-system --create-namespace --wait

# 2. Gateway API CRD（多数集群默认没有，waypoint 依赖它）
kubectl get crd gateways.gateway.networking.k8s.io &> /dev/null || \
  kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.0/experimental-install.yaml

# 3. 控制面 istiod
helm install istiod istio/istiod -n istio-system --set profile=ambient --wait

# 4. CNI 节点代理：负责把 Pod 流量重定向到 ztunnel
helm install istio-cni istio/cni -n istio-system --set profile=ambient --wait

# 5. ztunnel（DaemonSet，每节点一个）
helm install ztunnel istio/ztunnel -n istio-system --wait
```

装好后，给命名空间打 `istio.io/dataplane-mode=ambient` 标签即可纳入网格，无需重启 Pod。Sidecar 模式只需要第 1、3 步（istiod 不加 `profile=ambient`），再给命名空间打 `istio-injection=enabled` 并重建 Pod。

> [!tip]
> Sidecar 模式下要关注代理与业务容器的启停顺序。Istio 1.27 起默认以 Kubernetes 原生 Sidecar（`restartPolicy: Always` 的 init 容器）注入 Envoy，代理先于业务容器启动、后于业务容器退出；若关闭了原生 Sidecar，可在网格配置中开启 `holdApplicationUntilProxyStarts`。优雅下线的整体做法见 [优雅上下线](/high-avail/8_graceful_release)。

---

## 三、平台前置条件

Ambient 依赖 `istio-cni` 在节点上改写流量规则，和集群原有 CNI、托管平台的实现细节相关，安装前要核对官方平台说明：

| 平台 / CNI | 需要注意 |
|------|------|
| GKE | 所有 Chart 加 `global.platform=gke`（CNI 二进制路径非标准） |
| EKS（VPC CNI + Pod 安全组） | `POD_SECURITY_GROUP_ENFORCING_MODE` 需设为 `standard`，否则健康探针失败 |
| K3s / k3d / minikube / MicroK8s | 分别设置 `global.platform=k3s` / `k3d` / `minikube` / `microk8s` |
| OpenShift | `istio-cni` 与 ztunnel 装在 `kube-system`，并设置 `global.platform=openshift` |
| Cilium | 设置 `cni.exclusive=false` 允许 CNI 链式调用；不支持 BPF masquerade |

Sidecar 模式对 CNI 的要求更少（默认由 init 容器改写 iptables），但该 init 容器需要 `NET_ADMIN` 权限，受 Pod Security 限制的集群可改用 `istio-cni` 插件。

---

## 四、升级

网格升级的难点在数据面：控制面可以并行部署新旧版本，数据面代理却贴着业务流量。

| 维度 | Sidecar 模式 | Ambient 模式 |
|------|------|------|
| 控制面 | 按 revision 并行部署新 istiod，逐个命名空间切换 | 同样支持 revision，网关与 waypoint 通过 revision tag 逐步切换 |
| 数据面 | 命名空间改标签 `istio.io/rev=<新版本>` 后**滚动重启业务 Pod** 才会换代理 | 升级 ztunnel 不重启业务 Pod，但会**短暂中断该节点上的网格流量**，长连接受影响最大 |
| 建议做法 | 按命名空间分批重启，观察后再推进 | 先 cordon / drain 节点再升级 ztunnel，或用蓝绿节点池 |

通用规则：

- 顺序是 `base` → istiod → `istio-cni` → ztunnel → 网关与 waypoint；CNI 与 ztunnel 最多落后控制面一个小版本
- Sidecar 模式的 revision 升级示例：

```bash
istioctl install --set revision=canary
kubectl label namespace production istio-injection- istio.io/rev=canary
kubectl rollout restart deployment -n production
```

- `istio-injection` 标签优先级高于 `istio.io/rev`，切换时必须先删掉它（上面命令里的 `istio-injection-`）
- 确认新版本稳定后再删除旧控制面

---

## 小结

- 网关管南北向，网格管东西向；数据面有 Sidecar 与 Ambient 两种，原理和选型看 [服务网格](/microservices/3_service_mesh)
- 生产用 Helm 安装，Ambient 需要 `base`、Gateway API CRD、istiod、`istio-cni`、ztunnel 五部分
- Ambient 对节点 CNI 与托管平台有要求，装前先查平台前置条件
- 升级先控制面后数据面：Sidecar 要滚动重启业务 Pod，Ambient 升级 ztunnel 要先排空节点

---

## 参考资料

- Istio Ambient Helm 安装：[Install with Helm](https://istio.io/latest/docs/ambient/install/helm/)
- Ambient 平台前置条件：[Platform-Specific Prerequisites](https://istio.io/latest/docs/ambient/install/platform-prerequisites/)
- Ambient 升级：[Upgrade with Helm](https://istio.io/latest/docs/ambient/upgrade/helm/)
- Sidecar 模式金丝雀升级：[Canary Upgrades](https://istio.io/latest/docs/setup/upgrade/canary/)
- Istio 版本支持周期：[Supported Releases](https://istio.io/latest/docs/releases/supported-releases/)

> 下一篇：[Terraform](./11_terraform)

# Kubernetes

Kubernetes（简称 K8s）是一个开源的容器编排平台，用于自动化部署、扩缩容和管理容器化应用，广泛用于云原生架构中。

## 一、基本概念

- **Pod**：最小的部署单元，封装了一个或多个容器。
- **Node**：Kubernetes 集群中的一台主机，分为 Master 和 Worker。
- **Service**：定义一组 Pod 的访问策略，提供负载均衡。
- **Deployment**：用于声明式地管理 Pod 和 ReplicaSet。
- **ConfigMap / Secret**：用于管理配置信息和敏感信息。
- **Namespace**：逻辑隔离的命名空间，用于资源分组管理。

### Helm

Helm 是 Kubernetes 的包管理工具，类似于 Linux 系统的 apt/yum，用于简化应用的部署和管理。

- 支持版本控制、参数化部署
- 安装模板化的 Kubernetes 资源（称为 Chart）
- 命令示例：

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install my-release bitnami/nginx
````

## 二、开源K8s平台

### 1、Rancher

[Rancher 官网](https://www.rancher.cn/quick-start/)

Rancher 是一个开源的 Kubernetes 管理平台，提供统一的多集群管理能力，适合企业进行大规模容器集群运维。

* 支持多 Kubernetes 集群统一管理
* 提供 UI 仪表盘、权限控制、镜像仓库集成等功能
* 支持 RKE、K3s 等轻量级集群部署方式

### 2、Sealos

[Sealos 官网](https://sealos.run/)

Sealos 是一个云原生操作系统，致力于一键构建、部署、运维云操作系统环境，尤其适用于 Kubernetes 集群的自动化部署。

* 简洁的一键集群安装方式（`sealos run`）
* 支持创建完整的云平台集群
* 结合云原生生态，提供平台化的集群管理能力

### 3、KubeSphere

[KubeSphere 官网](https://www.kubesphere.io/zh/)

KubeSphere 是基于 Kubernetes 的容器平台，提供完整的 DevOps、微服务治理、多租户、监控告警等功能。

* 丰富的图形界面和企业级功能模块
* 内置 DevOps、流水线、Istio 服务治理、日志收集、监控等
* 适合中大型企业级容器平台解决方案



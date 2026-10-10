# 云原生总览

云原生模块从 Linux 与虚拟化基础出发，覆盖容器与编排（Docker、Kubernetes、Ingress、Helm、Argo CD、Service Mesh）、基础设施自动化（Terraform、Ansible、cloud-init 与 Packer、IaC 工程实践），以及公有云平台与 VPS 选购。

**版本基线（2026 年 10 月）**：Kubernetes 1.37（容器运行时为 containerd / CRI-O，dockershim 自 1.24 起移除）；Docker Engine + Compose v2（`docker compose`，默认构建器为 BuildKit）；Helm 4（Helm 3 仅提供安全修复至 2026-11）；Argo CD 3.x；南北向入口推荐 Gateway API（社区版 ingress-nginx 已于 2026 年 3 月停止维护）；Terraform / OpenTofu；服务器操作系统以 Ubuntu 26.04 LTS 与 RHEL 10 系（Rocky / AlmaLinux 10）为准。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. **Linux 与虚拟化**：先读 [Linux 概览](./1_linux) 与 [Linux 发行版](./2_linux_distros)，再读 [虚拟化概览](./3_virtual) 与 [虚拟化工具](./4_virtual_tools)，搭好本地实验环境。
2. **容器与编排**：读 [Docker](./5_docker) 与 [Kubernetes](./6_kubernetes)，掌握镜像、容器和编排的核心模型。
3. **交付链路**：读 [Nginx 与 Ingress](./7_nginx_ingress)、[Helm](./8_helm)、[Argo CD](./9_argocd)，形成从入口流量、打包到持续部署的链路；服务间流量治理再读 [Service Mesh](./10_service_mesh)。
4. **基础设施即代码**：读 [Terraform](./11_terraform)、[Ansible](./12_ansible) 与 [cloud-init 与 Packer](./12_cloud_init)，把资源创建、镜像与主机配置纳入代码管理，再按 [IaC 工程实践](./12_iac_practice) 接入 PR 评审与 CI。
5. **云平台与选购**：按需阅读 [云计算概览](./13_cloud_overview)，再看国内、国际云平台、Cloudflare 边缘服务与 VPS 选购。

复习时用 [高频面试题](./99_interview) 自测，答案在 [云原生面试题解答](/interview/21_cloud_native)。

## 三、关联模块

- CI/CD 与发布策略 → [DevOps 总览](/devops/0_overview)
- 日志 / 指标 / 链路追踪 → [可观测性总览](/observability/0_overview)
- 弹性扩缩容与多活容灾 → [水平扩展与无状态化](/high-con/2_scale_out) / [多活与容灾](/high-avail/9_multi_active)
- 健康检查、探针与故障转移 → [冗余与故障转移](/high-avail/2_redundancy_failover)；优雅停机与滚动发布 → [优雅上下线与变更](/high-avail/8_graceful_release)
- 应用侧健康端点与探针分组 → [Actuator 监控](/spring-boot/7_actuator)
- 服务网格的架构与选型 → [服务网格](/microservices/3_service_mesh)
- 证书与 TLS 终止 → [HTTPS 与 TLS](/protocols/3_https_tls)
- 镜像签名、SBOM 与供应链安全 → [应用安全总览](/security/0_overview)

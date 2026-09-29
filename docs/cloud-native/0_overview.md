# 云原生总览

云原生模块从 Linux 与虚拟化基础出发，覆盖容器与编排（Docker、Kubernetes、Ingress、Helm、Argo CD、Service Mesh）、基础设施自动化（Terraform、Ansible），以及公有云平台与 VPS 选购。

## 一、模块导航

| 分组 | 文档 | 覆盖内容 |
|------|------|----------|
| Linux 基础 | [Linux 概述](./1_linux) | Unix 渊源、发展历程、通用核心命令 |
| | [Linux 发行版](./2_linux_distros) | RHEL / Debian / Alpine / SUSE / 国产发行版与选型 |
| 虚拟化 | [虚拟机](./3_virtual) | 虚拟机发展与分类、常用虚拟机 |
| | [常用工具](./4_virtual_tools) | Hyper-V、VMware、WSL |
| 容器与编排 | [Docker](./5_docker) | 镜像、网络、常用命令、Docker Compose |
| | [Kubernetes](./6_kubernetes) | 基本概念、开源 K8s 平台 |
| | [Nginx 与 Ingress](./7_nginx_ingress) | 反向代理与 Ingress 入口 |
| | [Helm](./8_helm) | Chart、values 参数化、常用命令 |
| | [Argo CD](./9_argocd) | GitOps、Application 定义、工作流程 |
| | [Service Mesh](./10_service_mesh) | 在云原生栈中的位置（主文见微服务模块） |
| 基础设施自动化 | [Terraform](./11_terraform) | HCL、State 管理、多环境、Terraform vs Pulumi |
| | [Ansible](./17_ansible) | 无 Agent 架构、Playbook、Role 工程化 |
| 云平台与选购 | [云平台概述](./12_cloud_overview) | 基本概念、核心服务分类、选型维度 |
| | [国际云](./13_cloud_global) | AWS / Azure / GCP 核心服务对照 |
| | [国内云](./14_cloud_domestic) | 阿里云 / 腾讯云 / 华为云对照与选型 |
| | [Cloudflare](./15_cloudflare) | DNS、CDN、WAF、Workers、R2、Tunnel、Pages |
| | [VPS 选购](./16_vps_intro) | 线路、机房、服务商对比与选购建议 |

## 二、推荐阅读路径

1. 先读 [Linux 概述](./1_linux) 与 [发行版](./2_linux_distros)，打好运维基础。
2. 再读 [Docker](./5_docker) 与 [Kubernetes](./6_kubernetes)，掌握容器化与编排的核心。
3. 然后读 [Nginx 与 Ingress](./7_nginx_ingress)、[Helm](./8_helm)、[Argo CD](./9_argocd)，形成从打包到持续部署的链路。
4. 接着读 [Terraform](./11_terraform) 与 [Ansible](./17_ansible)，把基础设施纳入代码管理。
5. 最后按需阅读云平台与 VPS 相关文档。

## 三、关联模块

- CI/CD 与发布策略 → [DevOps](/devops/0_overview)
- 可观测性（日志 / 指标 / 链路追踪）→ [可观测性](/observability/0_overview)
- 弹性扩缩容与多活容灾 → [高并发 - 水平扩展](/high-con/1_scale_out) / [高可用 - 多活与容灾](/high-avail/8_multi_active)

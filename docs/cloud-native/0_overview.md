# 云原生总览

云原生模块从 Linux 与虚拟化基础出发，覆盖容器与编排（Docker、Kubernetes、Ingress、Helm、Argo CD、Service Mesh）、基础设施自动化（Terraform、Ansible），以及公有云平台与 VPS 选购。

## 一、模块导航

<ModuleNav />

## 二、推荐阅读路径

1. 先读 [Linux 概览](./1_linux) 与 [发行版](./2_linux_distros)，打好运维基础。
2. 再读 [Docker](./5_docker) 与 [Kubernetes](./6_kubernetes)，掌握容器化与编排的核心。
3. 然后读 [Nginx 与 Ingress](./7_nginx_ingress)、[Helm](./8_helm)、[Argo CD](./9_argocd)，形成从打包到持续部署的链路。
4. 接着读 [Terraform](./11_terraform) 与 [Ansible](./12_ansible)，把基础设施纳入代码管理。
5. 最后按需阅读云平台与 VPS 相关文档。

## 三、关联模块

- CI/CD 与发布策略 → [DevOps](/devops/0_overview)
- 可观测性（日志 / 指标 / 链路追踪）→ [可观测性](/observability/0_overview)
- 弹性扩缩容与多活容灾 → [高并发 - 水平扩展](/high-con/2_scale_out) / [高可用 - 多活与容灾](/high-avail/9_multi_active)

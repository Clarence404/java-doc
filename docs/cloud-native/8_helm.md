# Helm

> 参考资料：
> * 官方文档：[https://helm.sh/docs/](https://helm.sh/docs/)
> * Artifact Hub（Chart 仓库）：[https://artifacthub.io/](https://artifacthub.io/)

## 一、是什么

**Helm** 是 Kubernetes 的包管理器，作用类似 Linux 的 `apt` / `yum`。

在 K8s 中部署一个应用，往往需要编写十几个 YAML（Deployment、Service、ConfigMap、Ingress……），Helm 将这些 YAML 打包成一个
**Chart**，通过参数化模板统一管理，一条命令即可完成安装、升级、回滚。

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Chart** | Helm 包，包含应用所需的所有 K8s 资源模板 |
| **Release** | Chart 在集群中的一次部署实例，同一个 Chart 可部署多个 Release |
| **Repository** | Chart 的远程仓库，类似 npm registry / Docker Hub |
| **values.yaml** | Chart 的默认参数文件，部署时可覆盖 |
| **templates/** | 存放 K8s YAML 模板，用 `{{ .Values.xxx }}` 引用参数 |

### Chart 目录结构

```
my-app/
├── Chart.yaml          # Chart 元信息（名称、版本、描述）
├── values.yaml         # 默认参数
├── templates/          # K8s 资源模板
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
└── charts/             # 依赖的子 Chart
```

## 三、常用命令

```bash
# 添加仓库
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# 查找 Chart
helm search repo nginx

# 安装（指定 Release 名称 + Chart 名称）
helm install my-nginx bitnami/nginx

# 安装时覆盖参数
helm install my-nginx bitnami/nginx --set service.type=NodePort
helm install my-nginx bitnami/nginx -f custom-values.yaml

# 升级
helm upgrade my-nginx bitnami/nginx --set image.tag=1.25

# 回滚到上一个版本
helm rollback my-nginx 1

# 查看已部署的 Release
helm list

# 卸载
helm uninstall my-nginx
```

## 四、values.yaml 参数化示例

```yaml
# values.yaml 默认值
replicaCount: 2
image:
  repository: nginx
  tag: "1.24"
service:
  type: ClusterIP
  port: 80
```

```yaml
# templates/deployment.yaml 引用参数
spec:
  replicas: {{ .Values.replicaCount }}
  containers:
    - image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
```

## 五、适用场景

- ✅ 将公司内部应用打包成 Chart，统一管理多套环境（dev / staging / prod）的配置差异
- ✅ 快速安装开源中间件（MySQL、Redis、Kafka 等）到 K8s 集群
- ✅ 结合 CI/CD 流水线，实现一键发布
- ❌ 不适合用来管理云基础设施（VPC、云主机等），那是 Terraform 的工作

> [!warning]
> 待补充：自定义 Chart 开发实战、Helm Hooks、依赖管理

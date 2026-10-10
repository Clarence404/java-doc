---
description: GitOps 拉取模型、安装、Application 与 ApplicationSet、同步与回滚、多集群、密钥
---

# Argo CD

> **本篇目标**：理解 GitOps 的拉取模型，能安装 Argo CD 3.x，写出可直接运行的 Application / ApplicationSet，分清同步状态与健康状态，知道在自动同步下该怎么回滚，以及多环境、密钥、渐进式发布各用什么方案。
>
> **前置阅读**：[Kubernetes](./6_kubernetes)、[Helm](./8_helm)、[CI/CD](/devops/2_ci_cd)

**Argo CD** 是 CNCF 毕业项目，基于 GitOps 理念为 Kubernetes 做持续交付：把集群的期望状态放在 Git 仓库里，Argo CD 运行在集群内，持续对比「Git 里写的」与「集群里跑的」，有差异就同步。本文以 Argo CD 3.x 为基线（3.0 于 2025 年 5 月发布，截至 2026 年 10 月最新为 3.5）。

---

## 一、GitOps 与拉取模型

传统流水线在 CI 里直接 `kubectl apply` 或 `helm upgrade`（推送式）；GitOps 下 CI 只负责构建镜像并把新的 image tag 提交到**配置仓库**，部署由集群内的 Argo CD 拉取完成。

![GitOps 拉取式交付流程](../assets/cloud-native/argocd-gitops-flow.svg)

| 对比项 | 推送式（CI 直接部署） | 拉取式（Argo CD） |
|------|--------------|----------------|
| 集群写权限 | CI 持有 kubeconfig，凭证在集群外 | 只有集群内的 Argo CD 有写权限 |
| 部署记录 | 散落在流水线日志里 | Git 提交历史即部署历史 |
| 回滚 | 重跑旧流水线 | `git revert` 配置仓库 |
| 漂移处理 | 有人手工改了集群也不知道 | 持续对比，可自动纠正 |

![推送式部署与 GitOps 拉取式部署的权限边界](../assets/cloud-native/argocd-push-vs-pull.svg)

流水线本身的设计（阶段划分、制品管理、质量门禁）见 [CI/CD](/devops/2_ci_cd)，这里只讲部署这一段。

> [!tip]
> 应用代码和部署配置建议放在**两个仓库**：CI 往配置仓库提交 image tag 不会再次触发应用构建，权限也能分开管理。

---

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Application** | 最小管理单元：从哪个仓库的哪个路径 / Chart，同步到哪个集群的哪个命名空间 |
| **AppProject** | 对一组 Application 的约束：允许的源仓库、目标集群与命名空间、可创建的资源类型 |
| **ApplicationSet** | 用生成器批量生成 Application，适合多环境、多集群 |
| **Sync** | 把集群状态对齐到 Git 中的期望状态 |
| **同步状态** | `Synced` / `OutOfSync`：集群与 Git 是否一致 |
| **健康状态** | `Healthy` / `Progressing` / `Degraded` / `Suspended` / `Missing`：资源本身是否正常运行 |

同步状态和健康状态是**两个独立维度**：配置已同步（`Synced`），Pod 仍可能因为镜像拉不下来而 `Degraded`；反过来，有人手工改了副本数，应用可能仍 `Healthy` 但已 `OutOfSync`。

内部主要组件：

- **argocd-repo-server**：拉取 Git 并渲染清单（纯 YAML、Kustomize、Helm）。Helm Chart 用 `helm template` 渲染后再 apply，所以集群里看不到 Helm Release，`helm list` 为空
- **argocd-application-controller**：持续对比期望与实际状态，执行同步
- **argocd-server**：Web UI、API 与 CLI 入口
- **argocd-applicationset-controller**：根据 ApplicationSet 生成 Application

---

## 三、安装

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

- 必须用 `--server-side`：ApplicationSet 等 CRD 超过了客户端 apply 的注解大小上限（262 KB），普通 `kubectl apply` 会报错
- 生产环境把 URL 中的 `stable` 换成固定版本号（如 `v3.5.4`），或用官方 Helm Chart（`argo/argo-cd`）安装，便于升级与回退
- 高可用部署用 `manifests/ha/install.yaml`

获取初始密码并登录：

```bash
# 初始 admin 密码保存在 argocd-initial-admin-secret 中
argocd admin initial-password -n argocd

# 本地访问 UI / API
kubectl port-forward svc/argocd-server -n argocd 8080:443

# 另开终端登录（自签证书加 --insecure）
argocd login localhost:8080 --username admin --insecure
```

改完密码后删除 `argocd-initial-admin-secret`。正式环境通过 Ingress 或 Gateway 暴露 `argocd-server`，并接入 SSO（OIDC / Dex）。

3.0 相对 2.x 有几处默认行为变化，升级前需要核对：

- 资源跟踪方式默认改为**注解**（`argocd.argoproj.io/tracking-id`），不再用 `app.kubernetes.io/instance` 标签
- RBAC 更细：对 Application 的 `update` / `delete` 权限默认不再延伸到其下的子资源
- 查看 Pod 日志需要显式授予 `logs` 权限

---

## 四、Application 定义

下面的示例使用官方示例仓库，可以直接 `kubectl apply -f` 运行：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: guestbook
  namespace: argocd
  finalizers:
    # 删除 Application 时级联删除它创建的集群资源
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: guestbook
  destination:
    server: https://kubernetes.default.svc   # Argo CD 所在集群
    namespace: guestbook
  syncPolicy:
    automated:
      prune: true        # Git 中删掉的资源，集群中同步删除
      selfHeal: true     # 集群被手工改动时自动改回 Git 的状态
    syncOptions:
      - CreateNamespace=true   # 目标命名空间不存在时自动创建
```

| 字段 | 作用 |
|------|------|
| `finalizers` | 不加这个 finalizer，删除 Application 只删 Argo CD 里的记录，集群资源会保留 |
| `automated` | 不写则为手动同步，Git 变化后只标记 `OutOfSync`，等人点 Sync |
| `prune` | 默认 `false`，防止误删；开启后 Git 中移除的资源会被删除 |
| `selfHeal` | 默认 `false`；开启后手工 `kubectl edit` 的改动会被还原 |
| `CreateNamespace=true` | 不加且命名空间不存在时，同步直接失败 |

Helm Chart 作为源时，`source` 写成 Chart 仓库加 `helm` 参数：

```yaml
  source:
    repoURL: https://prometheus-community.github.io/helm-charts
    chart: kube-prometheus-stack
    targetRevision: 77.0.0        # Chart 版本，按需替换
    helm:
      releaseName: monitoring
      valuesObject:
        grafana:
          enabled: true
```

由于 Argo CD 用 `helm template` 渲染，Chart 里的 Helm hook 会被映射为 Argo CD 的同步钩子（如 `pre-install` → `PreSync`），Chart 本身的写法见 [Helm](./8_helm)。

---

## 五、同步策略、回滚与告警

### 1、漂移检测与自愈

有人直接改了集群里的资源，Argo CD 会把应用标为 `OutOfSync`，并在 UI 中显示差异；只有开启了 `selfHeal` 才会自动改回去。Argo CD 本身**不会主动通知**，需要配置 Notifications（见下文）。

HPA 修改副本数这类「合理的漂移」，在 Application 里用 `ignoreDifferences` 排除：

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

### 2、回滚

开启自动同步后，`argocd app rollback` 会被拒绝——否则下一轮同步又会把集群拉回 Git 的版本。两种做法：

- **推荐**：在配置仓库执行 `git revert`，Argo CD 自动同步到旧版本，Git 历史与集群保持一致
- **紧急**：先关闭自动同步，再回滚到历史版本，事后补提交到 Git

```bash
# 查看部署历史，记下要回到的 ID
argocd app history guestbook

# 关闭自动同步后回滚
argocd app set guestbook --sync-policy none
argocd app rollback guestbook <ID>
```

### 3、Sync Wave 与钩子

同一次同步内的资源顺序用注解控制，数字小的先应用，上一波资源健康后才进入下一波：

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-1"    # 例如先建 ConfigMap / Secret
```

数据库迁移这类一次性任务写成 Job，挂在同步钩子上：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: flyway/flyway:11
          args: ["-url=jdbc:postgresql://postgres:5432/app", "-user=app", "migrate"]
          env:
            - name: FLYWAY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: password
```

钩子阶段有 `PreSync`、`Sync`、`PostSync`、`SyncFail`；迁移失败时同步中止，新版本不会上线。

### 4、Notifications

Notifications 已内置在 Argo CD 中，在 `argocd-notifications-cm` 配置通知渠道（Slack、邮件、Webhook 等）与触发器，再给 Application 加订阅注解：

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-sync-failed.slack: deploy-alerts
    notifications.argoproj.io/subscribe.on-health-degraded.slack: deploy-alerts
```

Argo CD 同时暴露 Prometheus 指标（如 `argocd_app_info` 的同步与健康标签），也可以走统一告警链路，见 [告警体系](/observability/4_alerting)。

---

## 六、多环境与多集群：ApplicationSet

「App of Apps」用一个 Application 管理一个目录下的多个 Application 清单，适合少量固定应用。环境、集群一多，用 ApplicationSet 更省事：写一份模板，由生成器批量产出 Application。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: guestbook
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - list:
        elements:
          - env: dev
            cluster: https://kubernetes.default.svc
          - env: staging
            cluster: https://kubernetes.default.svc
  template:
    metadata:
      name: 'guestbook-{{.env}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/argoproj/argocd-example-apps.git
        targetRevision: HEAD
        path: guestbook
      destination:
        server: '{{.cluster}}'
        namespace: 'guestbook-{{.env}}'
      syncPolicy:
        syncOptions:
          - CreateNamespace=true
```

| 生成器 | 用途 |
|------|------|
| `list` | 手写环境 / 集群列表 |
| `cluster` | 遍历已注册到 Argo CD 的集群，按标签筛选 |
| `git` | 按配置仓库的目录或文件生成，新增目录即新增应用 |
| `matrix` / `merge` | 组合多个生成器，如「集群 × 应用」 |

外部集群用 `argocd cluster add <kubeconfig-context>` 注册，Argo CD 会在目标集群创建 ServiceAccount 并保存凭证。多团队共用时，每个团队一个 AppProject，限制可用的源仓库、目标集群和命名空间，再配合 RBAC 控制谁能同步哪些应用。各环境的配置差异如何组织见 [环境管理](/devops/7_env_management)。

---

## 七、周边工具

### 1、密钥管理

Git 里不能放明文 Secret，常用方案：

| 方案 | 做法 |
|------|------|
| Sealed Secrets | 用集群公钥加密成 `SealedSecret` 提交到 Git，集群内控制器解密 |
| External Secrets Operator | Git 里只放引用，运行时从 Vault、云厂商密钥服务同步成 Secret |
| SOPS | 加密 YAML 中的值，需要在 repo-server 侧集成解密插件 |

密钥治理的通用原则见 [数据安全](/security/7_data_security)。

### 2、镜像版本更新

CI 构建完镜像后，有两种方式把新 tag 写进配置仓库：

- **CI 回写**：流水线最后一步修改 `values.yaml` 或 `kustomization.yaml` 并提交，简单直观，最常用
- **Argo CD Image Updater**：独立组件，监听镜像仓库，按语义化版本等策略自动更新并回写 Git，适合不想让 CI 持有配置仓库写权限的场景

### 3、渐进式发布：Argo Rollouts

Argo CD 只负责「把 Git 状态同步到集群」，Deployment 自带的滚动更新无法按流量比例灰度、也不会按指标自动回滚。Argo Rollouts 是同属 Argo 项目的独立控制器，用 `Rollout` 资源替代 Deployment，支持金丝雀与蓝绿发布，可结合 Ingress、Gateway API 或服务网格切分流量，并按 Prometheus 等指标分析结果自动推进或回滚。它和 Argo CD 配合使用：Argo CD 同步 `Rollout` 清单，Rollouts 负责发布过程。发布策略本身见 [发布策略](/devops/5_release_strategy)。

---

## 小结

- GitOps 把部署从「CI 推」改成「集群内拉」：Git 是唯一事实来源，集群写权限收敛到 Argo CD
- 同步状态（Synced / OutOfSync）与健康状态（Healthy / Degraded 等）相互独立，排查时分开看
- 安装 3.x 要用 `kubectl apply --server-side`；升级自 2.x 注意注解跟踪与 RBAC 默认值变化
- Application 记得加 finalizer 和 `CreateNamespace=true`；`prune` / `selfHeal` 按需开启
- 自动同步下用 `git revert` 回滚；漂移需要 `selfHeal` 才会自动纠正，告警需要配 Notifications
- 多环境多集群用 ApplicationSet + AppProject；密钥用 Sealed Secrets / External Secrets；灰度发布交给 Argo Rollouts

---

## 参考资料

- Argo CD 官方文档：[Argo CD Documentation](https://argo-cd.readthedocs.io/en/stable/)
- 安装与入门：[Getting Started](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- 2.x 升级到 3.0：[Upgrading 2.14 to 3.0](https://argo-cd.readthedocs.io/en/stable/operator-manual/upgrading/2.14-3.0/)
- 同步选项与自动同步：[Automated Sync Policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- Sync Wave 与钩子：[Sync Phases and Waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- ApplicationSet：[Generating Applications with ApplicationSet](https://argo-cd.readthedocs.io/en/stable/user-guide/application-set/)
- Notifications：[Notifications Overview](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/)
- Argo Rollouts：[Argo Rollouts Documentation](https://argo-rollouts.readthedocs.io/en/stable/)
- GitOps 原则：[OpenGitOps](https://opengitops.dev/)

> 下一篇：[Service Mesh](./10_service_mesh)

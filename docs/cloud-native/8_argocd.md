# Argo CD

> 参考资料：
> * 官方文档：[https://argo-cd.readthedocs.io/](https://argo-cd.readthedocs.io/)
> * GitOps 概念：[https://opengitops.dev/](https://opengitops.dev/)

## 一、是什么

**Argo CD** 是基于 **GitOps** 理念的 Kubernetes 持续交付工具。

核心思想：**以 Git 仓库作为唯一事实来源（Single Source of Truth）**，集群的期望状态全部通过 Git 管理，Argo CD 自动监听 Git
变更并将集群同步到最新状态。

## 二、GitOps 是什么

传统 CI/CD：代码提交 → 流水线构建镜像 → **直接 `kubectl apply`** 推送到集群（Push 模式）

GitOps：代码提交 → 流水线构建镜像 → **更新 Git 仓库中的部署配置** → Argo CD 检测到变化 → 自动拉取并同步到集群（Pull 模式）

| 对比项 | 传统 CI/CD 推送 | GitOps（Argo CD） |
|------|--------------|----------------|
| 部署触发方式 | 流水线直接 kubectl | Argo CD 监听 Git 变更后拉取 |
| 配置版本管理 | 不一定有版本记录 | Git 历史即部署历史 |
| 回滚 | 重新执行旧流水线 | `git revert` 即可触发回滚 |
| 权限收敛 | CI 需要集群权限 | 只有 Argo CD 有集群权限 |
| 可审计性 | 一般 | 每次变更都有 Git 记录 |

## 三、核心概念

| 概念 | 说明 |
|------|------|
| **Application** | Argo CD 的最小管理单元，定义"从哪个 Git 路径同步到哪个 K8s 集群/命名空间" |
| **Sync** | 将集群状态对齐到 Git 中定义的期望状态 |
| **Drift** | 集群实际状态与 Git 期望状态不一致（漂移），Argo CD 会告警 |
| **App of Apps** | 用一个 Application 管理多个 Application，实现多服务统一部署 |

## 四、工作流程

```
开发者提交代码
  → CI 构建镜像，推送到镜像仓库
  → CI 更新 Git 配置仓库（修改 image tag）
  → Argo CD 检测到 Git 变化
  → 自动对比集群现状 vs Git 期望状态
  → 执行 Sync，将新版本应用到集群
  → 同步成功 → 健康状态变为 Synced / Healthy
```

## 五、Application 定义示例

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/my-org/k8s-configs
    targetRevision: main
    path: apps/my-app            # Git 仓库中的路径
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:                   # 自动同步
      prune: true                # 删除 Git 中已移除的资源
      selfHeal: true             # 自动修复漂移
```

## 六、常用 CLI 命令

```bash
# 登录
argocd login <argocd-server>

# 查看所有应用
argocd app list

# 手动触发同步
argocd app sync my-app

# 查看应用状态
argocd app get my-app

# 回滚到上一个版本
argocd app rollback my-app
```

## 七、适用场景

- ✅ 多套环境（dev / staging / prod）的 K8s 应用统一管理
- ✅ 需要完整部署审计记录（谁改了什么、什么时候改的）
- ✅ 团队希望收敛集群写权限，只让 Argo CD 操作集群
- ✅ 搭配 Helm Chart 或 Kustomize 使用效果最佳

> [!warning]
> 待补充：多集群管理、RBAC 权限控制、Notifications 告警集成

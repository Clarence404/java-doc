---
description: Helm 4 基线、Chart 模板、升级回滚、多环境 values、OCI 发布、Hooks、Kustomize
---

# Helm

> 前置阅读：[Kubernetes](./6_kubernetes)

Helm 是 Kubernetes 的包管理器，把一组 YAML 写成参数化模板 Chart，一条命令完成安装、升级、回滚。本篇讲第三方 Chart、自定义 Chart、values 与回滚、多环境和 OCI 发布，基线为 Helm 4.0。

---

## 一、版本基线

本文以 **Helm 4** 为基线：

| 时间 | 事件 |
|------|------|
| 2025-11-12 | Helm 4.0.0 发布 |
| 2026-07-08 | Helm 3 停止缺陷修复 |
| 2026-11-11 | Helm 3 停止安全修复，此后不再维护 |

Helm 4 对日常使用影响最大的变化：

- **默认 Server-Side Apply**：新安装的 Release 默认用服务端应用（字段归属由 API Server 跟踪，冲突时报错而不是静默覆盖）；从 Helm 3 带过来的 Release 在升级、回滚时沿用原来的客户端应用方式，可用 `--server-side=true` 显式切换
- **基于 kstatus 的等待**：`--wait` 单独使用时采用 `watcher` 策略，按资源的标准状态判断是否就绪；不加 `--wait` 时只等待 Hook
- **参数改名**：`--atomic` 改为 `--rollback-on-failure`，`--force` 改为 `--force-replace`；旧参数仍可用但会输出弃用警告
- **其他**：插件体系改为基于 WebAssembly，post-renderer 也改为插件形式；Chart 打包结果可复现
- **兼容性**：`apiVersion: v2` 的 Chart 照常可用，Helm 3 时代的 Chart 无需修改

安装 Helm 4（任选其一）：

```bash
# macOS / Linux
brew install helm

# Windows
winget install Helm.Helm

# 官方脚本，安装最新的 Helm 4
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh
./get_helm.sh

helm version
```

---

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Chart** | Helm 包：一组模板 + 默认参数 + 元信息，可以是本地目录、`.tgz` 包或仓库中的制品 |
| **values** | 模板参数。Chart 自带 `values.yaml` 作为默认值，安装时用 `-f` 文件或 `--set` 覆盖 |
| **Release** | Chart 在集群中的一次安装实例，名称在命名空间内唯一；同一个 Chart 可以装多个 Release |
| **revision** | Release 的版本号。每次 install / upgrade / rollback 都生成一个新 revision |
| **仓库** | 存放 Chart 的地方：传统 HTTP 仓库（`index.yaml`），或 OCI 镜像仓库（Harbor、GHCR、Docker Hub 等） |

![Helm：Chart 渲染与 Release 版本历史](../assets/cloud-native/helm-release-flow.svg)

Helm 是纯客户端工具：它在本地把模板和 values 渲染成普通的 Kubernetes 清单，提交给 API Server，再把这次的清单和 values 以 Secret（类型 `helm.sh/release.v1`）存在 Release 所在的命名空间。`helm history` 读的就是这些 Secret，回滚时取出旧 revision 的清单重新提交。

---

## 三、使用第三方 Chart

### 1、仓库与查找

```bash
# 传统 HTTP 仓库
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm search repo prometheus-community/kube-prometheus-stack --versions | head

# 在 Artifact Hub 上搜索公开 Chart
helm search hub ingress
```

越来越多的项目直接把 Chart 发布到 OCI 仓库，不需要 `helm repo add`，用 `oci://` 地址直接操作：

```bash
helm show chart  oci://docker.io/envoyproxy/gateway-helm --version v1.9.2
helm show values oci://docker.io/envoyproxy/gateway-helm --version v1.9.2 > eg-values.yaml
```

> [!warning]
> 2025 年 8 月起，Bitnami 停止免费发布和更新其绝大部分 Chart 与镜像，旧的 `charts.bitnami.com` 仓库与 `bitnami/*` 镜像已归档或下线，网上大量 `helm install xxx bitnami/...` 的教程照抄会出现镜像拉取失败。选用第三方 Chart 时优先使用项目官方维护的 Chart，并锁定 `--version`。

### 2、安装、查看、卸载

```bash
# 先看默认参数，挑出要改的写进自己的文件
helm show values prometheus-community/kube-prometheus-stack > monitoring-values.yaml

# 安装：Release 名 + Chart，锁定版本，指定命名空间
helm install monitoring prometheus-community/kube-prometheus-stack \
  --version <chart 版本> \
  -n monitoring --create-namespace \
  -f monitoring-values.yaml

# 查看
helm list -A                         # 所有命名空间的 Release
helm status monitoring -n monitoring
helm get values monitoring -n monitoring          # 用户覆盖的值
helm get values monitoring -n monitoring --all    # 合并后的全部值
helm get manifest monitoring -n monitoring        # 实际提交到集群的清单

# 卸载（默认同时删除历史记录；加 --keep-history 可保留）
helm uninstall monitoring -n monitoring
```

`<chart 版本>` 取自上一步 `helm search repo --versions` 的 CHART VERSION 列。不锁版本时每次安装都会拿到最新版，环境之间无法保证一致。

---

## 四、编写自己的 Chart

### 1、目录结构

`helm create order-service` 会生成一个可运行的脚手架，删减后一个典型的业务 Chart 如下：

```text
order-service/
├── Chart.yaml            # 元信息：名称、Chart 版本、应用版本、依赖
├── values.yaml           # 默认参数
├── values.schema.json    # 可选：values 的 JSON Schema 校验
├── .helmignore           # 打包时忽略的文件
├── charts/               # 依赖的子 Chart（helm dependency update 下载到这里）
└── templates/
    ├── _helpers.tpl      # 命名模板（下划线开头的文件不会被渲染成资源）
    ├── deployment.yaml
    ├── service.yaml
    ├── NOTES.txt         # 安装成功后打印给用户的说明
    └── tests/
        └── test-connection.yaml
```

### 2、Chart.yaml 与 values.yaml

```yaml
# Chart.yaml
apiVersion: v2
name: order-service
description: Order service of the shop
type: application
version: 0.3.0          # Chart 自身的版本，模板有改动就要递增（SemVer）
appVersion: "1.8.2"     # 应用版本，这里约定等于镜像 tag
```

```yaml
# values.yaml
replicaCount: 2

image:
  repository: registry.example.com/shop/order-service
  tag: ""                 # 为空时使用 Chart.yaml 的 appVersion
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 8080

javaOpts: "-XX:MaxRAMPercentage=75.0"

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    memory: 1Gi
```

`version` 和 `appVersion` 是两回事：只改了镜像版本，`appVersion` 变；改了模板，`version` 必须变，否则仓库里同一个版本号会对应两份不同的内容。

### 3、命名模板与资源模板

公共的名称和标签放在 `_helpers.tpl`，各资源用 `include` 引用，保证 Deployment 的 selector 与 Service 的 selector 永远一致：

```yaml
{{/* templates/_helpers.tpl */}}
{{- define "order-service.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "order-service.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "order-service.labels" -}}
{{ include "order-service.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}
```

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "order-service.fullname" . }}
  labels:
    {{- include "order-service.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "order-service.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "order-service.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: JAVA_TOOL_OPTIONS
              value: {{ .Values.javaOpts | quote }}
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: http
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: http
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

```yaml
# templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "order-service.fullname" . }}
  labels:
    {{- include "order-service.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "order-service.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
```

```text
{{- /* templates/NOTES.txt */ -}}
{{ .Release.Name }} 已部署到命名空间 {{ .Release.Namespace }}。
本地访问：
  kubectl port-forward -n {{ .Release.Namespace }} svc/{{ include "order-service.fullname" . }} 8080:{{ .Values.service.port }}
```

模板语法是 Go template 加 Sprig 函数库，最常用的几个：

- `{{- ... }}` / `{{ ... -}}`：去掉左侧 / 右侧的空白和换行，控制生成的 YAML 缩进
- `include` + `nindent N`：引入命名模板并整体缩进 N 格（比 `template` 好用，因为能接管道）
- `toYaml`：把 values 中的一整段对象原样输出，适合 `resources`、`nodeSelector`、`tolerations`
- `default`、`quote`、`required "错误提示" .Values.xxx`：缺省值、加引号、必填校验

探针路径对应 Spring Boot Actuator 的健康分组，见 [Actuator 监控](/spring-boot/7_actuator)；`MaxRAMPercentage` 等容器内 JVM 参数见 [GC 调优](/jvm/6_gc_tuning)。

### 4、values.schema.json

values 写错（比如副本数写成字符串、漏填镜像仓库）时，默认要到 API Server 报错才会发现。放一个 JSON Schema，`helm install` / `upgrade` / `lint` / `template` 都会先做校验：

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["replicaCount", "image"],
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "required": ["repository"],
      "properties": {
        "repository": { "type": "string", "minLength": 1 },
        "tag": { "type": "string" },
        "pullPolicy": { "enum": ["Always", "IfNotPresent", "Never"] }
      }
    }
  }
}
```

### 5、本地校验与渲染

```bash
helm lint ./order-service                        # 语法与最佳实践检查
helm template order ./order-service -f values-prod.yaml > rendered.yaml   # 本地渲染，不连集群
helm install order ./order-service -n shop --dry-run=server               # 连集群做服务端校验，不真正创建
```

`helm template` 的输出就是最终提交的清单，代码评审时把渲染结果一起 diff，比只看模板更直观。Argo CD 部署 Helm Chart 时也是先 `helm template` 渲染、再由自己完成应用，所以那类 Release 在 `helm list` 里看不到。

---

## 五、升级与回滚

### 1、CI 中的标准命令

```bash
helm upgrade --install order ./order-service \
  -n shop --create-namespace \
  -f values.yaml -f values-prod.yaml \
  --set image.tag="${GIT_SHA}" \
  --wait --timeout 10m \
  --rollback-on-failure
```

- `upgrade --install`：Release 不存在就安装、存在就升级，同一条命令可以反复执行，适合流水线
- `-f` 可以写多次，**后面的文件覆盖前面的**；`--set` 的优先级最高，适合只在流水线里确定的值（镜像 tag）
- `--wait`：等待 Deployment 等资源真正就绪才算成功，否则 Helm 在提交清单后立刻返回成功
- `--rollback-on-failure`（Helm 3 中叫 `--atomic`）：失败或在超时时间内没有就绪，就自动回滚到上一个成功的 revision；设置它时 `--wait` 默认采用 `watcher` 策略

### 2、values 合并的坑

`helm upgrade` 只要带了 `-f` 或 `--set`，就**以 Chart 的默认值为基础**，再叠加本次传入的值；上一次安装时传过、这次没再传的值会被丢弃：

```bash
helm install order ./order-service -n shop --set service.type=NodePort
helm upgrade order ./order-service -n shop --set replicaCount=3
# 结果：service.type 回到默认的 ClusterIP
```

| 做法 | 行为 | 建议 |
|------|------|------|
| 每次都传完整的 `-f` 文件 | 结果只取决于 Chart 默认值与这些文件，可重复 | **推荐**，values 文件放进 Git |
| `--reuse-values` | 在上次的值上叠加本次覆盖，但**忽略新版 Chart 新增的默认值** | 升级 Chart 版本时容易漏掉新参数 |
| `--reset-then-reuse-values` | 先取新版 Chart 的默认值，再叠加上次的值和本次覆盖 | 临时手工改一个值时可用 |

### 3、历史与回滚

```bash
helm history order -n shop

# 回滚到上一个 revision（省略版本号或写 0）
helm rollback order -n shop

# 回滚到指定的 revision 3
helm rollback order 3 -n shop
```

回滚不会删除历史，而是**把目标 revision 的清单和值复制成一个新的 revision**（见上图的 revision 3）。历史记录默认最多保留 10 个，可用 `--history-max` 调整。

> [!warning]
> Helm 回滚只回滚 Kubernetes 资源，不回滚数据库。如果新版本跑过不兼容的表结构变更，回滚后旧代码可能读不了新表结构。表结构变更要按「先兼容、后清理」分多次发布，见 [数据库版本迁移](/spring-boot/4_flyway)；滚动更新期间的流量摘除见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 六、多环境 values

推荐的组织方式是**一个 Chart、多份 values 文件**，环境差异只写在各自的文件里：

```text
deploy/
├── order-service/        # Chart
├── values.yaml           # 各环境共用的覆盖
├── values-dev.yaml
├── values-staging.yaml
└── values-prod.yaml
```

```yaml
# values-prod.yaml：只写与默认值不同的部分
replicaCount: 4
resources:
  requests:
    cpu: "1"
    memory: 2Gi
  limits:
    memory: 2Gi
```

不要在 values 文件里写数据库密码等敏感信息。常见做法是：密钥由 External Secrets Operator 从 Vault 或云密钥服务同步成 Kubernetes Secret，Chart 只引用 Secret 的名字。环境划分与配置管理的整体策略见 [环境管理](/devops/7_env_management)。

---

## 七、依赖与 OCI 发布

### 1、依赖

在 `Chart.yaml` 中声明依赖，`helm dependency update` 会把它们下载到 `charts/` 并生成 `Chart.lock`：

```yaml
# Chart.yaml 追加
dependencies:
  - name: shop-common
    version: "~1.2.0"                       # 允许 1.2.x
    repository: oci://registry.example.com/charts
    condition: shopCommon.enabled           # 由 values 控制是否启用
```

```bash
helm dependency update ./order-service
```

子 Chart 的参数在父 Chart 的 values 中以子 Chart 名为键覆盖（例如 `shop-common:` 下的字段）。公司内部常把通用的标签、探针、HPA 模板做成 `type: library` 的库 Chart，各服务作为依赖引入，避免每个 Chart 重复写一遍。

> [!tip]
> MySQL、Redis、Kafka 这类有状态中间件，生产环境更推荐使用云托管服务或官方 Operator，而不是作为业务 Chart 的子依赖一起安装、一起升级。

### 2、打包与推送到 OCI 仓库

```bash
helm package ./order-service                     # 生成 order-service-0.3.0.tgz
helm registry login registry.example.com -u ci-bot --password-stdin < token.txt
helm push order-service-0.3.0.tgz oci://registry.example.com/charts

# 其他环境直接从 OCI 仓库安装
helm upgrade --install order oci://registry.example.com/charts/order-service \
  --version 0.3.0 -n shop -f values-prod.yaml
```

OCI 仓库里 Chart 的 tag 就是 `Chart.yaml` 的 `version`，与镜像共用同一套仓库、权限和清理策略。制品版本与仓库管理见 [制品与版本管理](/devops/6_artifact_version)。

---

## 八、Hooks 与测试

Hook 是带特殊注解的普通资源，会在 Release 生命周期的特定时刻执行，常用于数据库迁移、数据初始化、发布通知。下面用 Flyway 在每次安装、升级前执行表结构迁移，先在 `values.yaml` 中加上迁移参数：

```yaml
# values.yaml 追加
migration:
  # 以官方 flyway 镜像为基础、把 SQL 脚本打进 /flyway/sql 的迁移镜像
  image: registry.example.com/shop/order-migration:1.8.2
  jdbcUrl: jdbc:mysql://order-db.example.internal:3306/order
```

```yaml
# templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "order-service.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: flyway
          image: "{{ .Values.migration.image }}"
          args: ["migrate"]
          env:
            - name: FLYWAY_URL
              value: {{ .Values.migration.jdbcUrl | quote }}
            - name: FLYWAY_USER
              valueFrom:
                secretKeyRef:
                  name: order-db
                  key: username
            - name: FLYWAY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: order-db
                  key: password
```

- `pre-install` / `pre-upgrade` Hook 在 Chart 的其他资源之前执行，因此它引用的 Secret `order-db` 必须事先存在（由密钥同步工具创建，而不是放在同一个 Chart 里）
- Hook 失败会让本次 install / upgrade 失败；Hook 创建的资源不属于 Release，`helm uninstall` 不会删除它们，靠 `hook-delete-policy` 清理
- `templates/tests/` 下带 `"helm.sh/hook": test` 注解的 Pod 是冒烟测试，部署后执行 `helm test order -n shop` 运行

数据库迁移也可以放在应用启动时由 Flyway 自动执行，两种做法的取舍见 [数据库版本迁移](/spring-boot/4_flyway)。

---

## 九、Helm、Kustomize 与其他工具的边界

| 维度 | Helm | Kustomize |
|------|------|-----------|
| 思路 | 模板 + 参数 | 原始 YAML + 补丁叠加（base / overlays） |
| 安装 | 独立 CLI | 内置于 `kubectl apply -k` |
| 版本与发布 | Chart 有版本号，可打包分发；Release 有历史与回滚 | 没有包和历史的概念，交给 Git 和 GitOps 工具 |
| 适合 | 分发给他人安装的软件、参数多的通用服务模板 | 团队内部清单的环境差异化，不想引入模板语法 |

两者也能组合：用 Helm 渲染第三方 Chart，再用 Kustomize 打补丁。

Helm 在整条交付链中的位置：

- **Terraform** 管云资源（VPC、托管 Kubernetes 集群、数据库实例），Helm 不适合做这件事，见 [Terraform](./11_terraform)
- **Helm** 把应用打包成 Chart，负责渲染和版本管理
- **Argo CD** 持续把 Git 中声明的 Chart 版本和 values 同步到集群，取代流水线里直接执行 `helm upgrade`，见下一篇

---

## 小结

- Helm 4 已是当前主线，Helm 3 在 2026-11-11 后不再有安全修复；`--atomic` / `--force` 已改名为 `--rollback-on-failure` / `--force-replace`
- Chart 是模板 + values，Release 是安装实例，每次变更生成一个 revision，历史以 Secret 存在集群中
- 第三方 Chart 优先选官方维护的、锁定 `--version`；不要再照抄 Bitnami 的旧教程
- 自写 Chart：标签与名称放 `_helpers.tpl`，加 `values.schema.json` 做校验，用 `helm lint` / `helm template` 在本地检查
- CI 用 `helm upgrade --install --wait --rollback-on-failure`，每次传完整的 values 文件，避免值被静默重置
- 回滚是复制旧 revision 生成新 revision，只管 Kubernetes 资源，不管数据库
- Chart 推送到 OCI 仓库，与镜像共用一套制品管理

---

## 参考资料

- Helm 官方文档：[https://helm.sh/docs/](https://helm.sh/docs/)
- Helm 4 Released：[https://helm.sh/blog/helm-4-released/](https://helm.sh/blog/helm-4-released/)
- Helm 4 Overview（与 Helm 3 的差异）：[https://helm.sh/docs/overview/](https://helm.sh/docs/overview/)
- helm upgrade 命令参考：[https://helm.sh/docs/helm/helm_upgrade/](https://helm.sh/docs/helm/helm_upgrade/)
- helm rollback 命令参考：[https://helm.sh/docs/helm/helm_rollback/](https://helm.sh/docs/helm/helm_rollback/)
- Chart Template Guide：[https://helm.sh/docs/chart_template_guide/](https://helm.sh/docs/chart_template_guide/)
- Chart Hooks：[https://helm.sh/docs/topics/charts_hooks/](https://helm.sh/docs/topics/charts_hooks/)
- Use OCI-based registries：[https://helm.sh/docs/topics/registries/](https://helm.sh/docs/topics/registries/)
- Artifact Hub：[https://artifacthub.io/](https://artifacthub.io/)
- Kustomize 文档：[https://kubectl.docs.kubernetes.io/references/kustomize/](https://kubectl.docs.kubernetes.io/references/kustomize/)

> 下一篇：[Argo CD](./9_argocd) —— 用 GitOps 把 Git 中声明的期望状态持续同步到集群。

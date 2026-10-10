---
description: 主干触发、GitHub Actions、OIDC、digest 晋级、供应链安全、Jenkins、GitLab CI
---

# CI/CD

> 前置阅读：[Git 工作流](./1_git_workflow)、[Docker](/cloud-native/5_docker)、[Kubernetes](/cloud-native/6_kubernetes)

本篇按主干开发搭建一条 Java 服务的完整流水线：PR 构建、测试与门禁，合并后构建镜像并签发来源证明，按同一 digest 晋级生产，OIDC 部署与 Workflow 安全，并给出 Jenkins 与 GitLab CI 的等价写法。示例以 GitHub Actions 为主，Action 版本以 2026 年 10 月为准：checkout v7、setup-java v6、upload-artifact v7、download-artifact v8、docker/build-push-action v7、codeql-action v4。

---

## 一、流水线的组成

本篇只讲流水线怎么编排，各环节的细节由对应文章负责：质量门禁的 Sonar / JaCoCo 配置见 [代码质量](/engineering/3_code_quality)，镜像标签、签名与来源证明见 [制品与版本管理](./6_artifact_version)，滚动 / 蓝绿 / 金丝雀见 [发布策略](./5_release_strategy)，多环境划分见 [环境管理](./7_env_management)，基础设施代码的流水线见 [IaC 工程实践](/cloud-native/12_iac_practice)。

### 1、三个概念

| 概念 | 含义 | 人工介入 |
|------|------|----------|
| 持续集成（CI） | 每次提交都自动构建和测试，尽早发现集成问题 | 无 |
| 持续交付（Continuous Delivery） | 每个通过 CI 的提交都产出可发布的制品，并自动部署到预发；上生产需要人点一下 | 生产前审批 |
| 持续部署（Continuous Deployment） | 通过所有检查后自动上生产 | 无，依赖完善的测试、监控和自动回滚 |

大多数后端团队的目标是持续交付：main 永远可发布，发布是一个审批动作，而不是一次重新构建。

### 2、一条主干流水线

![CI/CD 主干流水线](../assets/devops/ci-cd-pipeline.svg)

整条流水线围绕三条原则设计：

- **一次构建，多处晋级**：镜像只在 main 上构建一次，staging 和 production 部署的是同一个 digest；发布时不重新编译，避免「测的和上线的不是同一个东西」
- **制品不可变**：用提交 SHA 或 digest 标识镜像，不部署 `latest` 这类会被覆盖的标签；Kubernetes 看到镜像字符串没变也不会触发滚动更新
- **门禁前移**：能在 PR 上发现的问题（编译、测试、覆盖率、漏洞）不留到合并后；合并后的阶段只负责出制品和部署

---

## 二、触发策略：跟着主干走

站点统一采用主干开发 / GitHub Flow（见 [Git 工作流](./1_git_workflow)）：没有 develop 分支，功能分支通过 PR 合入 main，发布用 tag 标记。流水线的触发与之一一对应：

| 事件 | 跑什么 | 产出 |
|------|--------|------|
| PR 指向 main（含后续推送） | 构建、测试、质量门禁、安全扫描 | 检查结果，作为分支保护的必需检查 |
| 推送到 main（即 PR 合并） | 同上，再构建镜像、签发来源证明、部署 staging | 镜像 `sha-<commit>` 及其 digest |
| 推送 tag `v*` | 解析该提交已有镜像的 digest，加版本标签，审批后部署生产 | 镜像 `1.4.0`（与 `sha-<commit>` 同一 digest） |
| 手动 `workflow_dispatch` | 重新部署某个 digest，用于回滚或补发 | 无新制品 |

几点约定：

- **tag 只打在 main 上已经通过 CI 的提交**，发布流水线只负责「找到这个提交的镜像并晋级」，镜像不存在就直接失败
- 定时任务（夜间全量扫描、依赖更新）用 `schedule` 单独写一个 Workflow，不混进主流水线
- 用 `GITHUB_TOKEN` 推送的 tag 或提交**不会**再触发新的 Workflow（防止递归）；如果由机器人自动打 tag，要用 GitHub App 令牌

---

## 三、GitHub Actions：CI 与镜像构建

### 1、完整的 ci.yml

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

# 顶层只给只读，需要更多权限的 Job 单独申请
permissions:
  contents: read

# 同一分支 / PR 只保留最新一次运行；main 上不取消，避免半途中断的部署
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  IMAGE: ghcr.io/acme/order-service

jobs:
  build:
    name: 构建与测试（JDK ${{ matrix.java }}）
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        java: ['21', '25']
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: ${{ matrix.java }}
          cache: maven          # 按 pom.xml 哈希缓存 ~/.m2/repository

      - name: 编译、测试、覆盖率与门禁
        run: ./mvnw -B -ntp verify

      - name: 上传测试与覆盖率报告
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v7
        with:
          name: reports-jdk${{ matrix.java }}
          path: |
            target/surefire-reports/
            target/site/jacoco/
          retention-days: 7

      - name: 上传 JAR 供镜像构建使用
        if: ${{ matrix.java == '21' && github.event_name == 'push' }}
        uses: actions/upload-artifact@v7
        with:
          name: app-jar
          path: target/*.jar
          retention-days: 3

  codeql:
    name: CodeQL 扫描
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read            # 私有仓库读取运行信息需要
      security-events: write   # 上传扫描结果
    steps:
      - uses: actions/checkout@v7
      - uses: github/codeql-action/init@v4
        with:
          languages: java-kotlin
          build-mode: none     # Java 无需编译即可分析
      - uses: github/codeql-action/analyze@v4

  image:
    name: 构建镜像并签发来源证明
    needs: [build, codeql]
    if: ${{ github.event_name == 'push' }}
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write          # 推送到 GHCR
      id-token: write          # 来源证明使用 Sigstore 签名
      attestations: write      # 写入 attestation
    outputs:
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v7

      - uses: actions/download-artifact@v8
        with:
          name: app-jar
          path: target

      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.IMAGE }}
          tags: type=sha,format=long     # 生成 sha-<40 位提交号>

      - id: push
        uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - uses: actions/attest-build-provenance@v4
        with:
          subject-name: ${{ env.IMAGE }}
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true

  deploy-staging:
    name: 部署 staging
    needs: image
    uses: ./.github/workflows/deploy.yml
    permissions:
      contents: read
      id-token: write
    with:
      environment: staging
      image: ghcr.io/acme/order-service@${{ needs.image.outputs.digest }}
```

镜像构建直接使用上一步产出的 JAR，Dockerfile 只需 `COPY target/*.jar` 到运行时基础镜像，分层与瘦身写法见 [Docker](/cloud-native/5_docker)。

### 2、几个关键设计

- **最小权限**：顶层 `permissions: contents: read`，只有 `image` 拿到 `packages: write`，只有部署和签名的 Job 拿到 `id-token: write`。一个 Job 被攻破时，能动的范围就这么大。新建组织的 `GITHUB_TOKEN` 默认已是只读，但显式写出来才不依赖仓库设置
- **并发控制**：PR 上新推送会取消旧运行，省 Runner；main 上不取消，排队执行，部署 Job 另有按环境分组的 `concurrency`，同一环境不会并行部署
- **矩阵构建**：JDK 21 是基线，JDK 25 作为前向兼容检查一起跑；`fail-fast: false` 让一个版本失败时另一个版本照常出结果。只从 21 的构建上传 JAR，保证镜像里的字节码和基线一致
- **缓存**：`setup-java` 的 `cache: maven` 缓存本地仓库，键是所有 `pom.xml` 的哈希；镜像层缓存用 `type=gha` 存在 Actions 缓存中。缓存按分支隔离，PR 可以读取 main 的缓存，main 读不到 PR 的缓存，这本身就是一道防投毒的边界。其他工具（Gradle 之外的 CLI、前端依赖）用 `actions/cache`
- **报告留存**：`if: ${{ !cancelled() }}` 让测试失败时也上传报告，方便下载排查；`retention-days` 控制占用

### 3、质量门禁放在哪里

覆盖率阈值由 JaCoCo 的 `check` 目标绑定在 `verify` 阶段，`./mvnw verify` 不达标就失败；Sonar 扫描作为单独 Step 追加在构建之后，并用 `if: github.event.pull_request.head.repo.fork != true` 跳过拿不到 `SONAR_TOKEN` 的 fork PR，插件、阈值与「只看新代码」的门禁条件统一见 [代码质量](/engineering/3_code_quality)。依赖漏洞、许可证扫描与 SBOM 的治理策略见 [依赖治理](/engineering/6_dependency_governance)。

在仓库的分支保护（或 Ruleset）里把 `构建与测试（JDK 21）`、`构建与测试（JDK 25）`、`CodeQL 扫描` 设为必需检查，门禁才真正拦得住合并。PR 模板与评审要求见 [Code Review](./3_code_review)。

### 4、来源证明

`actions/attest-build-provenance` 为镜像 digest 生成 SLSA 来源证明（谁、在哪个仓库、哪次运行、哪个提交构建的），用 Sigstore 短期证书签名并推送到镜像仓库。部署前可以用 `gh attestation verify oci://ghcr.io/acme/order-service@sha256:... --repo acme/order-service` 校验。v4 起它是 `actions/attest` 的薄封装，两者择一即可。私有仓库使用 attestation 需要 GitHub Enterprise Cloud。cosign 签名、准入校验与 SBOM 附加见 [制品与版本管理](./6_artifact_version)。

---

## 四、部署：可复用工作流 + OIDC

### 1、OIDC 取代长期密钥

部署 Job 需要集群凭证。不要把 kubeconfig 或云厂商 AccessKey 存进 Secrets，而是让 GitHub 签发的 OIDC 令牌去云上换一个**几分钟有效**的临时角色：

- 云端：在 IAM（阿里云为 RAM）中登记 GitHub 的 OIDC 身份提供商，创建部署角色，信任策略限定 `sub` 为 `repo:acme/order-service:environment:production` 这类具体环境
- Workflow：Job 申请 `id-token: write`，用 `aws-actions/configure-aws-credentials` 换取临时凭证
- 效果：仓库里没有可泄露的长期密钥；不满足环境保护规则的运行连令牌都拿不到

信任策略写法、`sub` 格式（含 2026 年 7 月起新仓库默认带不可变 ID 的变化）详见 [IaC 工程实践](/cloud-native/12_iac_practice)，这里直接使用。

### 2、deploy.yml：被 staging 和生产共用

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      image:
        description: 带 digest 的镜像引用，如 ghcr.io/acme/order-service@sha256:...
        type: string
        required: true

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    name: 部署到 ${{ inputs.environment }}
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    environment: ${{ inputs.environment }}
    concurrency:
      group: deploy-${{ inputs.environment }}
      cancel-in-progress: false
    env:
      IMAGE: ${{ inputs.image }}
      NS: ${{ vars.K8S_NAMESPACE }}
      APP: order-service
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - uses: azure/setup-kubectl@v5
        with:
          version: v1.37.1          # 与集群版本相差不超过一个小版本

      - name: 获取集群凭证
        run: aws eks update-kubeconfig --name "${{ vars.EKS_CLUSTER }}" --region "${{ vars.AWS_REGION }}"

      - name: 滚动更新
        run: |
          kubectl -n "$NS" set image "deployment/$APP" app="$IMAGE"
          kubectl -n "$NS" annotate "deployment/$APP" \
            kubernetes.io/change-cause="deploy ${IMAGE} run ${GITHUB_RUN_ID}" --overwrite
          kubectl -n "$NS" rollout status "deployment/$APP" --timeout=5m

      - name: 发布后验证（5xx 比例）
        env:
          PROM_URL: ${{ vars.PROMETHEUS_URL }}
        run: |
          sleep 120
          QUERY='sum(rate(http_server_requests_seconds_count{job="order-service",status=~"5.."}[2m])) / sum(rate(http_server_requests_seconds_count{job="order-service"}[2m]))'
          RATIO=$(curl -fsS "$PROM_URL/api/v1/query" --data-urlencode "query=${QUERY}" \
            | jq -r '.data.result[0].value[1] // "0"')
          echo "5xx ratio: ${RATIO}"
          if awk -v r="$RATIO" 'BEGIN { exit !(r > 0.01) }'; then
            echo "5xx 比例超过 1%，判定发布失败"
            exit 1
          fi

      - name: 失败回滚
        if: ${{ failure() }}
        run: |
          kubectl -n "$NS" rollout undo "deployment/$APP"
          kubectl -n "$NS" rollout status "deployment/$APP" --timeout=5m
```

要点：

- **环境级变量**：`vars.K8S_NAMESPACE`、`vars.DEPLOY_ROLE_ARN` 等配置在 GitHub 的 Environment 上，staging 与 production 各一套，同一份 Workflow 自动取到对应值；这里只放非敏感配置
- **环境保护**：`production` 环境配置必需审批人、禁止自审、只允许 tag `v*` 部署；审批通过前 Job 不会开始，也拿不到 OIDC 令牌
- **变更记录**：`--record` 自 kubectl 1.22 起已废弃，改为写 `kubernetes.io/change-cause` 注解，`kubectl rollout history` 中即可看到每个版本的来源
- **指标口径**：Spring Boot 通过 Micrometer 暴露的是 `http_server_requests_seconds_count`，错误率必须是「5xx 速率 / 总速率」的比值；`job` 标签取决于 Prometheus 的抓取配置。`jq -r` 去掉引号，`// "0"` 处理无数据的情况，比较用 `awk`，不依赖 `bc`
- **边界**：这只是滚动更新加一道指标检查，不是金丝雀。按流量比例放量、自动分析和中止属于渐进式交付，用 Argo Rollouts 或网关权重实现，见 [发布策略](./5_release_strategy)；Deployment、探针与滚动参数见 [Kubernetes](/cloud-native/6_kubernetes)

### 3、release.yml：tag 触发，晋级同一个 digest

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read

env:
  IMAGE: ghcr.io/acme/order-service

jobs:
  promote:
    name: 解析并标记镜像
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    outputs:
      digest: ${{ steps.resolve.outputs.digest }}
    steps:
      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: resolve
        name: 找到该提交的镜像，加版本标签
        run: |
          SRC="${IMAGE}:sha-${GITHUB_SHA}"
          DIGEST=$(docker buildx imagetools inspect "$SRC" --format '{{json .Manifest}}' | jq -r '.digest')
          docker buildx imagetools create --tag "${IMAGE}:${GITHUB_REF_NAME#v}" "$SRC"
          echo "digest=${DIGEST}" >> "$GITHUB_OUTPUT"

  deploy-production:
    name: 部署生产
    needs: promote
    uses: ./.github/workflows/deploy.yml
    permissions:
      contents: read
      id-token: write
    with:
      environment: production
      image: ghcr.io/acme/order-service@${{ needs.promote.outputs.digest }}
```

`imagetools create` 只是给已有清单加一个标签，digest 不变，所以 `1.4.0` 与 `sha-<commit>` 指向同一份字节。调用可复用工作流时 `with` 中不能使用 `env` 上下文，因此镜像名写成字面量（也可以放进仓库变量 `vars`）。版本号规则与镜像标签策略见 [制品与版本管理](./6_artifact_version)。

---

## 五、拉取式部署：GitOps

上面的 `deploy.yml` 是**推送式**：CI 持有集群凭证，主动改集群。集群多、权限要求严格时，更常见的做法是**拉取式** GitOps：

![推送式与拉取式部署对比](../assets/devops/ci-cd-push-vs-pull.svg)

- CI 不再调用 kubectl，而是向配置仓库提交（或开 PR）一行镜像 digest 的变更
- 集群内的 Argo CD 持续比对配置仓库与集群实际状态，发现差异就同步；有人手工改了集群，也会被拉回期望状态
- 集群 API 无需对 CI 开放，审计记录就是配置仓库的提交历史，回滚等于 `git revert`

CI 中更新配置仓库的核心一步，以 Kustomize 为例：

```bash
cd deploy/overlays/production
kustomize edit set image "ghcr.io/acme/order-service@${DIGEST}"
git commit -am "deploy order-service ${DIGEST}"
git push
```

推送配置仓库需要一个只对该仓库有写权限的 GitHub App 令牌或 Deploy Key，不要复用个人 PAT。也可以不改 CI，由 Argo CD Image Updater 监听镜像仓库自动回写。Application、同步策略与多集群管理见 [Argo CD](/cloud-native/9_argocd)。

---

## 六、流水线自身的安全

流水线手里有制品仓库和集群的写权限，是供应链攻击的首选目标。

### 1、第三方 Action 固定到提交 SHA

Action 的版本标签可以被改写。2026 年 3 月 19 日，攻击者利用此前泄露的凭证，把 `aquasecurity/trivy-action` 77 个版本标签中的 76 个强推到窃取 CI 密钥的恶意提交（CVE-2026-33634，已列入 CISA KEV），按标签引用的流水线在运行时把内存和文件中的凭证发往外部，只有按 SHA 引用的流水线不受影响。

```yaml
steps:
  # 固定到完整的 40 位提交 SHA，行尾注释版本号，便于人读和自动升级
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: actions/setup-java@de7274f081f381c8f8158605e0321c36c376e2e6 # v6.0.1
```

本文其他示例为了易读写的是主版本标签，落到生产仓库时全部换成 SHA，再用 Dependabot 自动发升级 PR：

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ['*']
```

组织管理员还可以在「允许的 Action」策略中勾选强制 SHA 固定（2025 年 8 月上线），未固定的 Workflow 会直接运行失败；同一策略支持用 `!` 前缀屏蔽特定 Action 或版本。

### 2、fork PR 与 pull_request_target

- 来自 fork 的 `pull_request` 运行时，`GITHUB_TOKEN` 只读、拿不到 Secrets 和 OIDC 令牌，这是安全的默认行为，需要密钥的 Step 用条件跳过即可
- 不要为了让 fork PR 拿到密钥而改用 `pull_request_target` 再检出 PR 代码：那等于用仓库的权限执行陌生人的代码。checkout v7 起，在 `pull_request_target` 和 `workflow_run` 中检出 fork PR 的代码会被直接拦截

### 3、表达式注入

`run:` 中直接拼接 `${{ github.event.pull_request.title }}` 这类用户可控内容，会在 Shell 解析前被原样替换，标题里写一段命令就能执行。一律先放进环境变量再引用：

```yaml
- name: 打印 PR 标题
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR title is $PR_TITLE"
```

### 4、Secrets 与环境

- 能用 OIDC 的地方不用长期密钥；必须保留的密钥放在 Environment 级 Secrets 中，只有通过该环境保护规则的 Job 才能读取
- Runner 日志会自动遮蔽已登记的 Secret，但经过 Base64 等变换后的值不会被遮蔽，不要打印派生值
- 自托管 Runner 不要服务公开仓库；需要时用临时（ephemeral）Runner，每个 Job 用完即销毁

---

## 七、Jenkins Pipeline

适合私有化部署、需要对接内部系统或已有 Jenkins 平台的团队。下面的 Jenkinsfile 假设运行在 Multibranch Pipeline 中（`branch`、`tag` 条件只在多分支 / 组织类型的任务里生效），并启用了 tag 发现；需要 Pipeline、Credentials Binding、JUnit、Coverage、Kubernetes CLI、SonarQube Scanner 插件。

```groovy
// Jenkinsfile
pipeline {
    // 顶层不占执行器：等待人工审批时不会白白占着 Agent
    agent none

    options {
        timeout(time: 60, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    environment {
        REGISTRY = 'registry.example.com'
        IMAGE    = 'registry.example.com/acme/order-service'
    }

    stages {
        stage('CI') {
            agent { label 'docker' }
            stages {
                stage('构建与测试') {
                    steps {
                        sh './mvnw -B -ntp verify'
                    }
                    post {
                        always {
                            junit testResults: 'target/surefire-reports/*.xml', allowEmptyResults: true
                            recordCoverage(tools: [[parser: 'JACOCO', pattern: 'target/site/jacoco/jacoco.xml']])
                        }
                    }
                }

                stage('质量门禁') {
                    steps {
                        withSonarQubeEnv('SonarQube') {
                            sh './mvnw -B -ntp org.sonarsource.scanner.maven:sonar-maven-plugin:sonar'
                        }
                        timeout(time: 10, unit: 'MINUTES') {
                            waitForQualityGate abortPipeline: true
                        }
                    }
                }

                stage('构建并推送镜像') {
                    when { branch 'main' }
                    steps {
                        withCredentials([usernamePassword(credentialsId: 'registry-cred',
                                usernameVariable: 'REG_USER', passwordVariable: 'REG_PASS')]) {
                            // 单引号：由 Shell 展开变量，密钥不经过 Groovy 插值
                            sh '''
                                echo "$REG_PASS" | docker login "$REGISTRY" -u "$REG_USER" --password-stdin
                                docker build -t "$IMAGE:sha-$GIT_COMMIT" .
                                docker push "$IMAGE:sha-$GIT_COMMIT"
                            '''
                        }
                    }
                }

                stage('部署 staging') {
                    when { branch 'main' }
                    steps {
                        withKubeConfig([credentialsId: 'kubeconfig-staging']) {
                            sh '''
                                kubectl -n staging set image deployment/order-service app="$IMAGE:sha-$GIT_COMMIT"
                                kubectl -n staging rollout status deployment/order-service --timeout=5m
                            '''
                        }
                    }
                }
            }
        }

        stage('部署生产') {
            when {
                tag 'v*'
                beforeInput true
            }
            input {
                message '确认部署到生产环境？'
                ok '发布'
                submitter 'release-managers'
            }
            agent { label 'docker' }
            steps {
                withKubeConfig([credentialsId: 'kubeconfig-production']) {
                    sh '''
                        kubectl -n production set image deployment/order-service app="$IMAGE:sha-$GIT_COMMIT"
                        kubectl -n production rollout status deployment/order-service --timeout=5m
                    '''
                }
            }
        }
    }

    post {
        failure {
            mail to: 'order-team@example.com',
                 subject: "构建失败：${env.JOB_NAME} #${env.BUILD_NUMBER}",
                 body: "详情：${env.BUILD_URL}"
        }
    }
}
```

与旧写法相比的几处修正：

- **审批不占执行器**：顶层 `agent none`，生产阶段的 `input` 在分配 Agent 之前执行，等审批的几个小时里不占用构建机；`beforeInput true` 让非 tag 构建在弹出审批前就跳过
- **密钥不插值**：`docker login` 放在单引号 `sh` 中、用 `--password-stdin`，避免密钥出现在命令行和 Jenkins 的不安全插值警告里
- **显式命名空间**：每条 kubectl 都带 `-n`，不依赖 kubeconfig 的当前上下文；staging 与生产使用不同的凭证
- **覆盖率**：旧的 JaCoCo 插件已停止维护，改用 Coverage 插件的 `recordCoverage`
- **制品不可变**：镜像标签用 `sha-<commit>`，镜像仓库开启标签不可变（Harbor、ECR 都支持），tag 构建部署的就是 main 上已构建的那个镜像

---

## 八、GitLab CI 对照

GitLab CI 的概念与 GitHub Actions 基本对应：`stages` / `job` 对应 Job，`rules` 对应触发条件，`environment` 加受保护环境对应审批，`id_tokens` 对应 OIDC。

```yaml
# .gitlab-ci.yml
stages: [build, deploy]

workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG =~ /^v/

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=$CI_PROJECT_DIR/.m2/repository"

build:
  stage: build
  image: eclipse-temurin:21-jdk
  script:
    - ./mvnw -B -ntp verify
  cache:
    key:
      files: [pom.xml]
    paths: [.m2/repository]
  artifacts:
    when: always
    reports:
      junit: target/surefire-reports/TEST-*.xml
    paths: [target/*.jar]
    expire_in: 1 week

deploy-production:
  stage: deploy
  image: registry.example.com/tools/deployer:1.0   # 内部镜像，含 aws CLI 与 kubectl
  rules:
    - if: $CI_COMMIT_TAG =~ /^v/
      when: manual
  environment: production
  id_tokens:
    AWS_ID_TOKEN:
      aud: sts.amazonaws.com
  script:
    - echo "$AWS_ID_TOKEN" > /tmp/web-identity-token
    - export AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/web-identity-token AWS_ROLE_ARN="$DEPLOY_ROLE_ARN"
    - aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "$AWS_REGION"
    - kubectl -n production set image deployment/order-service app="$CI_REGISTRY_IMAGE:sha-$CI_COMMIT_SHA"
    - kubectl -n production rollout status deployment/order-service --timeout=5m
```

- `workflow.rules` 只为 MR、默认分支和 `v*` tag 创建流水线，不会出现分支流水线与 MR 流水线重复
- `id_tokens` 让 GitLab 签发带指定 `aud` 的 JWT，AWS CLI 读取 `AWS_WEB_IDENTITY_TOKEN_FILE` 与 `AWS_ROLE_ARN` 后自动换取临时凭证；`DEPLOY_ROLE_ARN` 等放在 CI/CD 变量中
- `production` 设为受保护环境并指定可部署人员，`when: manual` 的按钮才只对他们可点
- 镜像构建 Job 可用 Docker-in-Docker 或 Buildah，思路与 GitHub Actions 相同，此处从略

---

## 九、常见坑

- **折叠的 `run:` 加反斜杠**：`run: kubectl set image deployment/app \` 后面换行续写，没有 `|` 时 YAML 会把换行折叠成空格，Shell 收到的是「反斜杠 + 空格」，参数被拆坏。多行命令一律写 `run: |`
- **部署 `latest`**：标签内容会变，无法追溯也无法回滚；而且 Deployment 中的镜像字符串不变，`kubectl set image` 不会触发滚动更新。按 digest 或 `sha-<commit>` 部署
- **发布时重新构建**：tag 触发重新 `mvn package` 和 `docker build`，产出的 digest 与 staging 验证过的不同。tag 只做晋级
- **错误率用绝对值**：`rate(...{status=~"5.."}[5m]) > 0.01` 比较的是每秒请求数，不是百分比；`jq` 不加 `-r` 输出带引号的字符串，后续数值比较直接报错
- **以为 `rollout status` 会推进发布**：它只是等待并观察当前滚动更新结束，不会「全量」任何东西
- **Secrets 在 fork PR 中为空**：Sonar、镜像推送这类需要密钥的 Step 要加条件跳过，否则外部贡献者的 PR 永远红
- **机器人打的 tag 不触发发布**：`GITHUB_TOKEN` 产生的事件不触发新 Workflow，改用 GitHub App 令牌
- **Action 写 `@master` 或主版本标签就上生产**：上游被攻破时随下一次运行进入你的流水线，固定 SHA 并让 Dependabot 维护

---

## 小结

- 主干开发下流水线只有三种触发：PR 跑门禁，合并到 main 构建一次并部署 staging，tag 晋级同一个 digest 到生产
- Workflow 默认 `contents: read`，写权限按 Job 申请；`concurrency` 让 PR 只保留最新运行、同一环境串行部署；矩阵、依赖缓存和镜像层缓存控制耗时
- 部署用 OIDC 换短期凭证，环境保护规则决定谁能拿到生产凭证；部署逻辑抽成可复用工作流，staging 与生产共用一份
- 推送式简单直接，拉取式 GitOps 把集群凭证留在集群内，适合多集群与严格隔离
- 流水线本身是攻击面：第三方 Action 固定到提交 SHA，不在 `pull_request_target` 中执行 fork 代码，用户输入经环境变量进入 Shell
- 门禁配置、发布策略、制品签名、环境划分各有归属文章，流水线只负责把它们串起来

## 参考资料

- GitHub Actions Workflow 语法：[Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- 可复用工作流：[Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- 矩阵构建：[Running variations of jobs in a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)
- 并发控制：[Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- 部署环境与保护规则：[Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- 变量与环境级变量：[Store information in variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)
- OIDC 与 AWS：[Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- 安全使用参考（固定 SHA、fork 与令牌权限）：[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- 表达式注入：[Script injections](https://docs.github.com/en/actions/concepts/security/script-injections)
- 强制 SHA 固定策略：[GitHub Actions policy now supports blocking and SHA pinning actions](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/)
- Dependabot 升级 Action：[Keeping your actions up to date with Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
- 来源证明：[Using artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- trivy-action 标签篡改事件：[CVE-2026-33634](https://www.cve.org/CVERecord?id=CVE-2026-33634)
- actions/setup-java（Maven 缓存）：[GitHub 仓库](https://github.com/actions/setup-java)
- CodeQL Action：[GitHub 仓库](https://github.com/github/codeql-action)
- Docker 构建缓存（type=gha）：[Cache management with GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/)
- docker buildx imagetools：[imagetools inspect](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)
- Kubernetes Deployment（rollout、change-cause）：[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- Jenkins 声明式流水线语法：[Pipeline Syntax](https://www.jenkins.io/doc/book/pipeline/syntax/)
- Jenkins Coverage 插件：[Coverage](https://plugins.jenkins.io/coverage/)
- Jenkins Kubernetes CLI 插件：[Kubernetes CLI](https://plugins.jenkins.io/kubernetes-cli/)
- GitLab CI/CD YAML 语法：[CI/CD YAML syntax reference](https://docs.gitlab.com/ci/yaml/)
- GitLab OIDC：[OpenID Connect (OIDC) Authentication Using ID Tokens](https://docs.gitlab.com/ci/secrets/id_token_authentication/)
- Argo CD：[Argo CD 文档](https://argo-cd.readthedocs.io/en/stable/)

> 下一篇：[Code Review](./3_code_review)

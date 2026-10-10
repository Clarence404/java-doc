---
description: SemVer 与 SNAPSHOT、Nexus / Harbor、digest 部署、cosign 签名、SLSA 溯源
---

# 制品与版本管理

> **本篇目标**：分清 SemVer 与 Maven SNAPSHOT 的边界，用 CI 友好版本号替代 release 插件；配好 Nexus 与 Harbor（凭证不落盘、tag 不可变、Chart 走 OCI）；部署时用镜像 digest 而不是 tag；给镜像加上 cosign keyless 签名和 SLSA 溯源证明，并在集群准入时校验，做到线上任意一个 Pod 都能追溯到具体提交。
>
> **前置阅读**：[CI/CD](./2_ci_cd)、[Docker](/cloud-native/5_docker)

制品（artifact）是 CI 产出、CD 消费的东西：Jar、镜像、Helm Chart。本篇回答三个问题：**版本号怎么定、制品放哪里、怎么证明线上跑的就是那次构建的产物**。Maven 依赖冲突的调解机制见 [构建工具](/engineering/1_build_tools)，依赖漏洞扫描、License 合规与 SBOM 生成见 [依赖治理](/engineering/6_dependency_governance)，本篇不重复。

---

## 一、制品类型与仓库

| 类型 | 格式 | 常用仓库 | 构建工具 |
|------|------|---------|---------|
| Java 库 / 应用包 | `.jar` | Nexus / Artifactory | Maven / Gradle |
| 容器镜像 | OCI Image | Harbor / GHCR / ECR / ACR | Docker BuildKit / Jib |
| Helm Chart | OCI Artifact（`.tgz` 推送） | Harbor / GHCR 等 OCI 仓库 | Helm 3.8+ |
| 前端静态包 | `.tgz` / `.zip` | Nexus（npm hosted）/ 对象存储 | npm / pnpm |
| 签名、SBOM、溯源证明 | OCI Referrer | 与镜像同仓库 | cosign / BuildKit / GitHub Attestations |

两条原则：

- **制品只构建一次**：同一个产物从 test 一路晋级到 prod，各环境的差异只靠配置注入，不为每个环境重新打包（环境划分见 [环境管理](./7_env_management)）
- **发布版本不可覆盖**：release 仓库禁止重复部署同一版本，镜像仓库开启 tag 不可变，否则「同一个版本号」在不同时间可能是两份不同的二进制

Harbor 自 v2.8 起移除了 ChartMuseum，Chart 统一以 OCI 制品存放，和镜像共用项目、权限与清理策略：

```bash
helm package ./my-app-chart                      # 生成 my-app-1.2.0.tgz，版本取 Chart.yaml
helm push my-app-1.2.0.tgz oci://harbor.example.com/charts
```

Chart 的写法与 OCI 仓库用法见 [Helm](/cloud-native/8_helm)。

---

## 二、版本号规范

### 1、语义化版本（SemVer）

格式：`MAJOR.MINOR.PATCH[-预发标识][+构建元数据]`

| 版本段 | 何时递增 | 示例 |
|--------|---------|------|
| **MAJOR** | 不兼容的 API 变更 | `1.4.2` → `2.0.0` |
| **MINOR** | 向后兼容的新功能 | `1.4.2` → `1.5.0` |
| **PATCH** | 向后兼容的缺陷修复 | `1.4.2` → `1.4.3` |

预发版本排在对应正式版之前，预发标识按点分段逐段比较（纯数字按数值比，字母按 ASCII 比）：

| 版本 | 含义 | 排序 |
|------|------|------|
| `2.0.0-alpha.1` | 内测，接口可能大改 | 最小 |
| `2.0.0-beta.2` | 公测，功能基本冻结 | 大于 alpha |
| `2.0.0-rc.1` | 发布候选，只修缺陷 | 大于 beta |
| `2.0.0` | 正式版 | 最大 |
| `2.0.0+build.456` | 带构建元数据 | 比较时忽略 `+` 之后的部分，与 `2.0.0` 同序 |

几个容易踩的点：

- `0.y.z` 表示初始开发阶段，任何变更都可能不兼容，对外发布的库应尽早到 `1.0.0`
- 业务服务（不被别人依赖的应用）的版本号主要用于追溯，严格的「兼容性语义」主要约束**被依赖的库与 API**
- 已发布的版本内容不得修改，修错只能发新版本

### 2、Maven SNAPSHOT 与 RELEASE

`1.3.0-SNAPSHOT` 是 **Maven 的约定**，不是 SemVer 的预发标识：SemVer 里 `-SNAPSHOT` 只是一个普通的预发字符串，而 Maven 会对它做特殊处理。

| 维度 | SNAPSHOT | RELEASE |
|------|----------|---------|
| 版本示例 | `1.3.0-SNAPSHOT` | `1.3.0` |
| 部署去向 | snapshot 仓库，每次部署生成带时间戳的唯一版本（如 `1.3.0-20261010.083015-7`） | release 仓库，一个版本只能部署一次 |
| 依赖解析 | 按更新策略（默认每天）检查远端是否有更新的快照 | 解析一次后缓存在本地，不再变化 |
| 可变性 | 同一坐标的内容会变 | 不可变 |
| 适用 | 开发期内部联调 | 任何要上线、要被他人依赖的产物 |

生产制品必须是 RELEASE 版本；`maven-release-plugin` 发布时也会拒绝依赖 SNAPSHOT 的项目，这条约束在 CI 里同样应该检查（可用 `maven-enforcer-plugin` 的 `requireReleaseDeps` 规则）。

### 3、CI 友好版本号

传统的 `mvn release:prepare release:perform` 会在仓库里提交两次「改版本号」的 commit 并打 tag，与 trunk-based 流程配合别扭。Maven 3.5+ 支持 CI 友好版本：pom 里只写占位符，真实版本由 CI 根据 Git tag 传入。

```xml
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>${revision}</version>

  <properties>
    <!-- 本地默认值，CI 发布时用 -Drevision 覆盖 -->
    <revision>1.3.0-SNAPSHOT</revision>
  </properties>

  <build>
    <!-- 固定产物文件名，Dockerfile 里才能写确定的路径 -->
    <finalName>app</finalName>
    <plugins>
      <!-- 部署前把 ${revision} 展开成真实版本，否则下游解析不到 -->
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>flatten-maven-plugin</artifactId>
        <version>1.8.0</version>
        <configuration>
          <updatePomFile>true</updatePomFile>
          <flattenMode>resolveCiFriendliesOnly</flattenMode>
        </configuration>
        <executions>
          <execution>
            <id>flatten</id>
            <phase>process-resources</phase>
            <goals><goal>flatten</goal></goals>
          </execution>
          <execution>
            <id>flatten-clean</id>
            <phase>clean</phase>
            <goals><goal>clean</goal></goals>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
```

```bash
# 推送 tag v1.3.0 触发的发布任务里
VERSION="${GITHUB_REF_NAME#v}"           # v1.3.0 → 1.3.0
./mvnw -B deploy -Drevision="${VERSION}"
```

这样版本号的唯一来源是 Git tag，仓库里没有「改版本号」的提交。Maven 4 原生支持 CI 友好版本、不再需要 flatten 插件，但截至 2026 年 10 月 Maven 4.0.0 仍处于 RC 阶段，生产构建继续用 Maven 3.9.x。

---

## 三、Maven 私服（Nexus）

Nexus 里常用三种仓库：

| 类型 | 作用 | 示例 |
|------|------|------|
| **proxy** | 代理并缓存公网仓库 | `maven-central` |
| **hosted** | 存放自己发布的制品，分 release / snapshot | `maven-releases`、`maven-snapshots` |
| **group** | 把多个仓库聚合成一个地址，客户端只配这一个 | `maven-public` |

`maven-releases` 的部署策略设为 **Disable redeploy**，保证版本不可覆盖；snapshot 仓库配清理任务，只保留最近若干个快照。

客户端配置（`~/.m2/settings.xml`），凭证从环境变量读取，不写明文：

```xml
<settings>
  <servers>
    <server>
      <id>nexus</id>
      <username>${env.NEXUS_USERNAME}</username>
      <password>${env.NEXUS_PASSWORD}</password>
    </server>
    <server>
      <id>nexus-releases</id>
      <username>${env.NEXUS_USERNAME}</username>
      <password>${env.NEXUS_PASSWORD}</password>
    </server>
    <server>
      <id>nexus-snapshots</id>
      <username>${env.NEXUS_USERNAME}</username>
      <password>${env.NEXUS_PASSWORD}</password>
    </server>
  </servers>

  <mirrors>
    <!-- 所有依赖走 Nexus 的 group 仓库，由它代理 Maven Central -->
    <mirror>
      <id>nexus</id>
      <mirrorOf>*</mirrorOf>
      <url>https://nexus.example.com/repository/maven-public/</url>
    </mirror>
  </mirrors>
</settings>
```

```xml
<!-- pom.xml：发布地址，id 与 settings.xml 中的 server id 对应 -->
<distributionManagement>
  <repository>
    <id>nexus-releases</id>
    <url>https://nexus.example.com/repository/maven-releases/</url>
  </repository>
  <snapshotRepository>
    <id>nexus-snapshots</id>
    <url>https://nexus.example.com/repository/maven-snapshots/</url>
  </snapshotRepository>
</distributionManagement>
```

- 一律用 HTTPS：Maven 3.8.1 起默认屏蔽 HTTP 仓库（内置的 `maven-default-http-blocker` 镜像）
- CI 中的账号用 Nexus 的专用部署账号或 User Token，权限只给目标仓库的写入；开发者本机只需要读权限
- 本机必须存密码时，用 `mvn --encrypt-master-password` / `mvn --encrypt-password` 生成密文；Maven 4 改用新的加密机制，升级时需要重新生成

---

## 四、镜像标签与 digest

### 1、标签策略

镜像有两种引用方式：**tag**（`my-app:1.3.0`，可变的名字）和 **digest**（`my-app@sha256:...`，内容哈希，不可变）。tag 方便人读，digest 才能保证拉到的就是那份内容。

| 标签 | 用途 | 是否用于部署 |
|------|------|-------------|
| `{git-sha}`（如 `3f9c2a1`） | 每次构建的主标签，对应唯一提交 | 可以，配合 tag 不可变 |
| `{version}`（如 `1.3.0`） | 发版归档，便于人查找 | 可以，配合 tag 不可变 |
| `main` / `latest` | 指向最新构建，方便本地拉取 | 禁止 |
| `@sha256:...` | 内容寻址 | **推荐**，生产清单最终落到 digest |

团队内统一用 7 位短 SHA（`git rev-parse --short=7 HEAD`），CI、Harbor、部署清单里都用同一种写法，排查时才对得上。

### 2、按 digest 部署

构建推送后，CI 直接拿到 digest，把它写进部署清单：

```bash
IMAGE=harbor.example.com/backend/my-app
GIT_SHA=$(git rev-parse --short=7 HEAD)

docker buildx build --push -t "${IMAGE}:${GIT_SHA}" \
  --metadata-file build-meta.json .
DIGEST=$(jq -r '."containerimage.digest"' build-meta.json)   # sha256:...

# 写入 Kustomize overlay（GitOps 仓库），生成 images[].digest 字段
cd deploy/overlays/prod
kustomize edit set image "${IMAGE}@${DIGEST}"
```

生成的 `kustomization.yaml` 片段：

```yaml
images:
  - name: harbor.example.com/backend/my-app
    digest: sha256:6f1d0c3e9a...   # 由 CI 写入，渲染后 Pod 的 image 为 my-app@sha256:...
```

按 digest 部署后：回滚就是把 digest 改回上一个；即使有人覆盖了某个 tag，线上也不受影响；签名校验也是针对 digest 的（见第六节）。已有镜像查 digest 用 `docker buildx imagetools inspect harbor.example.com/backend/my-app:3f9c2a1`。

### 3、Harbor 镜像仓库

| 能力 | 用法 |
|------|------|
| 项目（Project） | 按团队或业务线划分，如 `backend`、`charts`，权限按项目授予 |
| 机器人账号 | CI 推送、集群拉取各用一个，只授予对应项目的 push / pull 权限，不用个人账号 |
| Tag 不可变规则 | 对 `backend/**` 下匹配 `v*`、7 位 SHA 的 tag 开启不可变，推送同名 tag 会被拒绝 |
| 保留策略 | 只保留最近 N 个或 N 天内被拉取过的制品，定期垃圾回收 |
| 代理缓存 | 建 proxy cache 项目代理 Docker Hub，避开限流并统一扫描 |
| 签名与 Referrer | 原生识别 cosign 签名、SBOM 等 OCI 附属制品，删除镜像时一并清理 |

集群拉取私有镜像需要 `imagePullSecret`，用机器人账号创建：

```bash
kubectl create secret docker-registry harbor-pull \
  --namespace prod \
  --docker-server=harbor.example.com \
  --docker-username='robot$backend+puller' \
  --docker-password="${HARBOR_ROBOT_TOKEN}"
```

```yaml
# Deployment 片段
spec:
  template:
    spec:
      imagePullSecrets:
        - name: harbor-pull
      containers:
        - name: my-app
          image: harbor.example.com/backend/my-app@sha256:6f1d0c3e9a...
```

Kubernetes 1.24 移除 dockershim 后，节点通过 containerd / CRI-O 拉镜像，排查拉取问题用 `crictl pull`、`crictl images`，而不是 `docker pull`。

---

## 五、构建追溯

线上出问题时，要能从 Pod 一路反查到引入问题的代码变更：

![构建追溯链](../assets/devops/artifact-trace-chain.svg)

| 步骤 | 命令 / 数据来源 |
|------|----------------|
| Pod 跑的是哪个镜像 | `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].imageID}'`，得到 digest |
| 镜像由哪次构建产出 | `gh attestation verify` 输出的溯源证明里有仓库、workflow 与 run ID（见第六节） |
| 对应哪个提交 | 镜像标签 `org.opencontainers.image.revision` |
| 改了什么 | `git show <commit>`，或在 PR 中查看评审记录 |

追溯信息用 OCI 规范定义的标准 Label 写进镜像。注意 **`FROM` 之前声明的 `ARG` 只能用于 `FROM` 行本身**，进入构建阶段后失效，必须在阶段内重新声明，否则 Label 全是空值：

```dockerfile
# 构建阶段：用 Spring Boot 的 jarmode=tools 按依赖分层解压
FROM eclipse-temurin:21-jre AS builder
WORKDIR /builder
COPY target/app.jar application.jar
RUN java -Djarmode=tools -jar application.jar extract --layers --destination extracted

# 运行阶段
FROM eclipse-temurin:21-jre
WORKDIR /application
COPY --from=builder /builder/extracted/dependencies/ ./
COPY --from=builder /builder/extracted/spring-boot-loader/ ./
COPY --from=builder /builder/extracted/snapshot-dependencies/ ./
COPY --from=builder /builder/extracted/application/ ./

# ARG 在本阶段内声明才可见；放在 COPY 之后，避免每次提交都让前面的层缓存失效
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG VERSION=unknown
LABEL org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/example/my-app"

ENTRYPOINT ["java", "-jar", "application.jar"]
```

- `COPY target/app.jar` 依赖 pom 里的 `<finalName>app</finalName>`；写 `target/*.jar` 时，一旦目录里有多个 Jar（如 sources Jar），`COPY` 会因目标不是目录而失败
- `jarmode=tools` 需要 Spring Boot 3.3+；镜像分层、非 root 用户等 Dockerfile 细节见 [Docker](/cloud-native/5_docker)

```bash
GIT_SHA=$(git rev-parse --short=7 HEAD)
docker build \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg VERSION="${VERSION}" \
  -t "harbor.example.com/backend/my-app:${GIT_SHA}" .

# 查看追溯信息
docker inspect --format '{{json .Config.Labels}}' "harbor.example.com/backend/my-app:${GIT_SHA}"
```

用 `docker/build-push-action` 时，可以搭配 `docker/metadata-action` 自动生成这组 OCI Label 与标签。

---

## 六、供应链安全：签名、溯源与部署验证

Label 是构建者自己写的，任何人都能伪造。供应链安全要回答两件事：**这个镜像是不是我们的流水线构建的（签名）**，以及**它是用哪份源码、哪个流程构建的（溯源证明）**；然后在部署时强制校验。

![供应链安全流程](../assets/devops/artifact-supply-chain.svg)

| 证据 | 回答的问题 | 工具 |
|------|-----------|------|
| SBOM | 镜像里有哪些组件和版本 | CycloneDX Maven 插件、Syft、BuildKit `--sbom`；生成方式见 [依赖治理](/engineering/6_dependency_governance) |
| 签名 | 镜像是否出自可信身份，内容有没有被篡改 | Sigstore cosign |
| 溯源证明（Provenance） | 由哪个仓库、哪个提交、哪个 workflow 构建 | GitHub Artifact Attestations、BuildKit `--provenance`，格式遵循 SLSA |

### 1、SLSA 等级

SLSA（Supply-chain Levels for Software Artifacts）v1.0 的构建轨道分三级，可作为团队的阶段目标：

| 等级 | 要求 | 落地方式 |
|------|------|---------|
| Build L1 | 产出溯源证明，记录构建过程 | 任意生成 provenance 的工具 |
| Build L2 | 在托管构建平台上构建，证明由平台签名 | GitHub Actions + `actions/attest` |
| Build L3 | 构建环境隔离，构建步骤无法篡改证明 | 平台级隔离 + 可复用 workflow 生成证明 |

### 2、在 CI 中签名并生成溯源证明

cosign 的 **keyless** 模式不需要管理私钥：流水线用 GitHub 的 OIDC 令牌向 Sigstore 的 Fulcio 换取短期证书，签名记录写入公开透明日志 Rekor，证书里携带「哪个仓库的哪个 workflow」这一身份。

```yaml
# .github/workflows/release-image.yml
name: release-image

on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read

env:
  IMAGE: harbor.example.com/backend/my-app

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # keyless 签名与 attestation 都需要 OIDC 令牌
      attestations: write    # 写入 GitHub Artifact Attestations
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
          cache: maven

      - run: ./mvnw -B verify

      - name: 计算短 SHA
        run: echo "SHORT_SHA=${GITHUB_SHA::7}" >> "$GITHUB_ENV"

      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: harbor.example.com
          username: ${{ secrets.HARBOR_ROBOT_NAME }}
          password: ${{ secrets.HARBOR_ROBOT_TOKEN }}

      - name: 构建并推送
        id: build
        uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ env.SHORT_SHA }}
          build-args: |
            GIT_COMMIT=${{ github.sha }}
            VERSION=${{ github.ref_name }}

      - name: 生成 SLSA 溯源证明
        uses: actions/attest@v4
        with:
          subject-name: ${{ env.IMAGE }}          # 不带 tag
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true

      - uses: sigstore/cosign-installer@v4.1.0

      - name: keyless 签名（按 digest）
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
        run: cosign sign --yes "${IMAGE}@${DIGEST}"
```

- 签名、证明都针对 **digest**，签 tag 没有意义（tag 可被改指向）
- `actions/attest` 不传 `sbom-path` 时默认生成 SLSA build provenance；传入 SBOM 文件则生成 SBOM 证明
- 示例中的官方 Action 用主版本号便于阅读；生产中所有第三方 Action 都应固定到完整 commit SHA，由 Renovate / Dependabot 负责升级（原因见第七节的 trivy-action 事件）

### 3、部署前验证

本地或流水线中手动验证：

```bash
DIGEST=sha256:6f1d0c3e9a...   # 替换为实际 digest
IMAGE=harbor.example.com/backend/my-app

# 验证签名：只认 example/my-app 仓库 release-image.yml 在 main 或 v* tag 上的构建
cosign verify "${IMAGE}@${DIGEST}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/example/my-app/\.github/workflows/release-image\.yml@refs/(heads/main|tags/v.*)$'

# 验证溯源证明：确认由 example/my-app 仓库构建
gh attestation verify "oci://${IMAGE}@${DIGEST}" -R example/my-app
```

真正的防线在集群准入：用 Kyverno 的 `ImageValidatingPolicy`（Kyverno 1.19 中为稳定版）拒绝未签名或签名身份不符的镜像。

```yaml
apiVersion: policies.kyverno.io/v1
kind: ImageValidatingPolicy
metadata:
  name: verify-backend-images
spec:
  validationActions: [Deny]
  matchConstraints:
    resourceRules:
      - apiGroups: ['']
        apiVersions: ['v1']
        operations: ['CREATE', 'UPDATE']
        resources: ['pods']
  matchImageReferences:
    - glob: 'harbor.example.com/backend/*'
  attestors:
    - name: cosign
      cosign:
        keyless:
          identities:
            - issuer: 'https://token.actions.githubusercontent.com'
              subjectRegExp: '^https://github\.com/example/my-app/\.github/workflows/release-image\.yml@refs/(heads/main|tags/v.*)$'
  validations:
    - expression: >-
        images.containers.map(image, verifyImageSignatures(image, [attestors.cosign])).all(e, e > 0)
      message: '镜像未通过签名校验'
```

- 先用 `validationActions: [Audit]` 观察一段时间，确认存量工作负载都已签名，再切到 `Deny`
- 不用 Kyverno 的团队可选 Sigstore 官方的 policy-controller，思路相同
- 旧版 `ClusterPolicy` 的 `verifyImages` 规则仍可用，但 Kyverno 已将 `ClusterPolicy` 标为弃用，新策略用 CEL 风格的 `ImageValidatingPolicy`

---

## 七、镜像漏洞扫描

Maven 依赖的漏洞扫描（OWASP Dependency-Check、OSV）与自动升级（Renovate）属于依赖治理，见 [依赖治理](/engineering/6_dependency_governance)。镜像层面还要扫基础镜像里的系统包，常用 Trivy：

```bash
# 安装（Homebrew 核心仓库已收录）
brew install trivy

# 扫描镜像，HIGH 及以上漏洞返回非 0
trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed \
  harbor.example.com/backend/my-app:3f9c2a1
```

GitHub Actions 中，在第六节 `build` job 的「构建并推送」步骤之后追加扫描步骤，并给该 job 的 `permissions` 加上 `security-events: write`（上传 SARIF 需要）：

```yaml
      - name: 镜像漏洞扫描
        # 固定到 v0.35.0 的完整 commit SHA，不要用 @master 或可变 tag
        uses: aquasecurity/trivy-action@57a97c7e7821a5776cebc9bb87c984fa69cba8f1
        with:
          image-ref: ${{ env.IMAGE }}@${{ steps.build.outputs.digest }}
          format: sarif
          output: trivy-results.sarif
          severity: HIGH,CRITICAL
          exit-code: '1'

      - name: 上传扫描结果
        if: always()                 # 扫描失败（exit-code 1）时也要上传结果
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: trivy-results.sarif
```

前面的 `docker/login-action` 已登录 Harbor，Trivy 会复用这份凭证拉取私有镜像。若希望先扫描再签名，把这两步放在签名步骤之前，扫描不通过时不会产生签名，准入策略自然会拦住这个镜像。

::: warning trivy-action 标签被篡改事件
2026 年 3 月 19 日，攻击者用泄露的凭证强推了 `aquasecurity/trivy-action` 77 个版本 tag 中的 76 个，以及 `setup-trivy` 的全部 tag，指向窃取 CI 密钥的恶意代码（CVE-2026-33634），同期还发布了恶意的 Trivy v0.69.4 二进制。引用 `@master` 或版本 tag 的流水线都会执行恶意代码，固定 commit SHA 的不受影响。教训：第三方 Action 一律固定完整 SHA；工具二进制校验签名或校验和；一旦可能执行过恶意版本，轮换流水线能接触到的全部密钥。
:::

Harbor 也内置 Trivy 扫描器，可在项目中开启「推送时自动扫描」并设置「阻止拉取存在严重漏洞的镜像」，作为 CI 之外的第二道关。

---

## 小结

- SemVer 约束被依赖的库与 API；`-SNAPSHOT` 是 Maven 约定，快照可变、只用于开发期，生产只用不可变的 RELEASE
- 用 `${revision}` + flatten 插件让 Git tag 成为版本号的唯一来源；Maven 4 原生支持，但仍在 RC 阶段
- Nexus 用 proxy / hosted / group 三类仓库，release 仓库禁止重复部署；凭证走环境变量，地址一律 HTTPS
- Harbor 开 tag 不可变、机器人账号、保留策略；Chart 以 OCI 制品推送，不再用 ChartMuseum
- tag 给人看，digest 给机器用：生产清单落到 `image@sha256:...`，回滚就是换回上一个 digest
- `FROM` 前的 `ARG` 进入阶段后失效，追溯 Label 用 OCI 标准键并在阶段内声明
- 供应链三件套：SBOM（见依赖治理）、cosign keyless 签名、SLSA 溯源证明；部署前用 Kyverno 校验签名身份
- 第三方 Action 固定完整 commit SHA，trivy-action 事件证明可变 tag 不可信

## 参考资料

- 语义化版本规范：[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
- Maven CI 友好版本：[Maven CI Friendly Versions](https://maven.apache.org/guides/mini/guide-maven-ci-friendly.html)
- flatten-maven-plugin：[Flatten Maven Plugin](https://www.mojohaus.org/flatten-maven-plugin/)
- Maven 密码加密：[Password Encryption](https://maven.apache.org/guides/mini/guide-encryption.html)
- Harbor 文档（Tag 不可变、机器人账号、OCI 制品）：[Harbor Docs](https://goharbor.io/docs/)
- Helm OCI 仓库：[Use OCI-based registries](https://helm.sh/docs/topics/registries/)
- OCI 镜像标准注解：[OCI Image Spec Annotations](https://github.com/opencontainers/image-spec/blob/main/annotations.md)
- Spring Boot 分层镜像 Dockerfile：[Dockerfiles](https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html)
- Kustomize 镜像替换：[images](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/images/)
- SLSA 规范：[SLSA v1.0 Build Track](https://slsa.dev/spec/v1.0/levels)
- Sigstore cosign 签名与验证：[Signing Containers](https://docs.sigstore.dev/cosign/signing/signing_with_containers/)、[Verifying Signatures](https://docs.sigstore.dev/cosign/verifying/verify/)
- cosign-installer：[sigstore/cosign-installer](https://github.com/sigstore/cosign-installer)
- GitHub Artifact Attestations：[Using artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)、[actions/attest](https://github.com/actions/attest)
- docker/build-push-action：[GitHub 仓库](https://github.com/docker/build-push-action)
- Kyverno ImageValidatingPolicy：[ImageValidatingPolicy](https://kyverno.io/docs/policy-types/image-validating-policy/)
- Trivy：[Trivy 文档](https://trivy.dev/)
- trivy-action 事件：[CVE-2026-33634（NVD）](https://nvd.nist.gov/vuln/detail/cve-2026-33634)
- GitHub Actions 安全加固（固定 SHA）：[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)

> 下一篇：[环境管理](./7_env_management)

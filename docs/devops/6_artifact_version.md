# 制品与版本管理

---

## 一、制品类型

| 类型 | 格式 | 存储位置 | 构建工具 |
|------|------|---------|---------|
| Java 应用包 | `.jar` / `.war` | Nexus | Maven / Gradle |
| 容器镜像 | Docker Image | Harbor / ECR | Docker / Buildkit |
| Helm Chart | `.tgz` | ChartMuseum / Harbor | Helm |
| 前端静态包 | `.zip` / `.tar.gz` | Nexus / OSS | npm / pnpm |
| npm 包 | `.tgz` | Nexus (npm proxy) | npm / pnpm |

---

## 二、语义化版本（SemVer）

格式：`MAJOR.MINOR.PATCH[-预发标识][+构建元数据]`

| 版本段 | 何时递增 | 示例 |
|--------|---------|------|
| **MAJOR** | 不兼容的 API 变更 | `1.x.x` → `2.0.0` |
| **MINOR** | 向后兼容的新功能 | `1.2.x` → `1.3.0` |
| **PATCH** | 向后兼容的 Bug 修复 | `1.2.3` → `1.2.4` |

**特殊版本标识**：

```
1.0.0-SNAPSHOT     开发中快照版本（Maven），不稳定，禁止生产使用
1.0.0-alpha.1      内测版本
1.0.0-beta.2       公测版本
1.0.0-rc.1         发布候选版本
1.0.0              正式发布版本
```

**Maven 版本规范**：

```xml
<!-- 开发阶段 -->
<version>1.3.0-SNAPSHOT</version>

<!-- 发布阶段（去掉 SNAPSHOT） -->
<version>1.3.0</version>

<!-- 发布命令（自动去掉 SNAPSHOT、打 Tag、推送） -->
<!-- mvn release:prepare release:perform -->
```

---

## 三、Docker 镜像标签策略

```bash
# ❌ 只打 latest（无法追溯、无法回滚）
docker tag my-app:build registry.example.com/my-app:latest

# ✅ 多标签策略
IMAGE=registry.example.com/my-app
GIT_SHA=$(git rev-parse --short HEAD)
VERSION=$(mvn help:evaluate -Dexpression=project.version -q -DforceStdout)

docker build -t ${IMAGE}:${GIT_SHA} .           # 精确可追溯（主标签）
docker tag ${IMAGE}:${GIT_SHA} ${IMAGE}:${VERSION}  # 语义版本
docker tag ${IMAGE}:${GIT_SHA} ${IMAGE}:latest      # 便于引用（生产谨慎使用）

docker push ${IMAGE}:${GIT_SHA}
docker push ${IMAGE}:${VERSION}
docker push ${IMAGE}:latest
```

**镜像标签规范**：

| 标签 | 用途 | 示例 |
|------|------|------|
| `{git-sha}` | 精确追溯，部署使用 | `abc1234` |
| `{version}` | 语义版本，发版归档 | `2.1.0` |
| `{branch}-latest` | 分支最新，测试环境 | `develop-latest` |
| `latest` | 最新稳定版，开发拉取 | `latest` |

---

## 四、Nexus 私有仓库配置

```xml
<!-- Maven settings.xml（~/.m2/settings.xml） -->
<settings>
  <servers>
    <server>
      <id>nexus-releases</id>
      <username>deploy-user</username>
      <password>your-password</password>
    </server>
    <server>
      <id>nexus-snapshots</id>
      <username>deploy-user</username>
      <password>your-password</password>
    </server>
  </servers>

  <mirrors>
    <!-- 所有依赖走私有 Nexus（Nexus 代理公网 Maven Central） -->
    <mirror>
      <id>nexus</id>
      <mirrorOf>*</mirrorOf>
      <url>http://nexus.example.com/repository/maven-public/</url>
    </mirror>
  </mirrors>
</settings>
```

```xml
<!-- pom.xml：配置发布地址 -->
<distributionManagement>
  <repository>
    <id>nexus-releases</id>
    <url>http://nexus.example.com/repository/maven-releases/</url>
  </repository>
  <snapshotRepository>
    <id>nexus-snapshots</id>
    <url>http://nexus.example.com/repository/maven-snapshots/</url>
  </snapshotRepository>
</distributionManagement>
```

---

## 五、Harbor 镜像仓库

```bash
# 登录
docker login harbor.example.com -u admin

# 镜像命名规范：harbor地址/项目/应用名:标签
docker tag my-app harbor.example.com/backend/my-app:2.1.0

# 推送
docker push harbor.example.com/backend/my-app:2.1.0

# 拉取（Kubernetes 部署时使用）
docker pull harbor.example.com/backend/my-app:abc1234
```

```yaml
# Kubernetes 拉取私有镜像配置
apiVersion: v1
kind: Secret
metadata:
  name: harbor-secret
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64编码的docker config>

---
# Deployment 引用
spec:
  template:
    spec:
      imagePullSecrets:
        - name: harbor-secret
      containers:
        - image: harbor.example.com/backend/my-app:abc1234
```

---

## 六、构建追溯链

生产事故排查时，能从故障现象反推到具体代码提交。

```
生产故障
  ↑
查 Pod 正在运行的镜像 Tag：abc1234
  ↑
查 Harbor：abc1234 镜像由 CI 流水线 #456 构建
  ↑
查 GitHub Actions #456：触发提交 abc1234（feat(order): 新增超时取消）
  ↑
查 Git log：abc1234 = 张三 在 2024-01-15 14:30 的提交
  ↑
查 diff：找到引入问题的代码变更
```

**在镜像 Label 中写入追溯信息**：

```dockerfile
# Dockerfile
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG VERSION=unknown

FROM eclipse-temurin:21-jre-alpine

LABEL git.commit="${GIT_COMMIT}" \
      build.time="${BUILD_TIME}" \
      app.version="${VERSION}"

COPY target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

```bash
# CI 构建时注入
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  --build-arg VERSION=${VERSION} \
  -t my-app:${GIT_COMMIT} .

# 查看镜像追溯信息
docker inspect my-app:abc1234 | jq '.[0].Config.Labels'
```

---

## 七、依赖安全治理

### OWASP Dependency-Check（Maven）

```xml
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>9.0.9</version>
  <configuration>
    <failBuildOnCVSS>7</failBuildOnCVSS>   <!-- CVSS ≥ 7（高危）时构建失败 -->
    <format>HTML</format>
  </configuration>
</plugin>
```

```bash
# 本地扫描
mvn dependency-check:check

# CI 中加入流水线（定期扫描，非每次构建）
mvn dependency-check:check -DfailBuildOnCVSS=9   # 仅严重漏洞阻断
```

### 镜像漏洞扫描（Trivy）

```bash
# 安装
brew install aquasecurity/trivy/trivy

# 扫描本地镜像
trivy image my-app:2.1.0

# CI 中扫描（HIGH 及以上漏洞阻断构建）
trivy image --exit-code 1 --severity HIGH,CRITICAL \
  harbor.example.com/backend/my-app:${GIT_SHA}
```

```yaml
# GitHub Actions 集成
- name: 镜像漏洞扫描
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: harbor.example.com/backend/my-app:${{ github.sha }}
    format: 'sarif'
    output: 'trivy-results.sarif'
    severity: 'HIGH,CRITICAL'
    exit-code: '1'

- name: 上传扫描结果
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: 'trivy-results.sarif'
```

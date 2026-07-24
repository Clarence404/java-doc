# CI/CD 持续集成与部署

> 参考资料：
> * GitHub Actions 文档：[https://docs.github.com/en/actions](https://docs.github.com/en/actions)
> * Jenkins 文档：[https://www.jenkins.io/doc/](https://www.jenkins.io/doc/)
> * GitLab CI/CD：[https://docs.gitlab.com/ee/ci/](https://docs.gitlab.com/ee/ci/)

---

## 一、CI/CD 核心概念

| 概念 | 说明 |
|------|------|
| **CI（持续集成）** | 代码合并后自动触发构建、测试，快速发现集成问题 |
| **CD（持续交付）** | CI 通过后自动发布到测试/预发环境，人工确认后上生产 |
| **CD（持续部署）** | 全自动，无人工确认，直接部署到生产（需极高测试覆盖率） |

### 标准流水线阶段

```
代码提交
  → Lint / 格式检查
  → 单元测试 + 覆盖率
  → 构建（Maven/Gradle）
  → 静态代码分析（SonarQube）
  → 镜像构建 + 推送
  → 部署到测试环境
  → 集成测试 / 冒烟测试
  → [人工确认]
  → 部署到生产环境
```

---

## 二、GitHub Actions（推荐）

### Java 项目完整 CI 流水线

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

env:
  JAVA_VERSION: '21'
  IMAGE_NAME: my-app

jobs:
  test:
    name: 单元测试
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 设置 JDK
        uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: 'temurin'
          cache: maven

      - name: 运行测试
        run: mvn test -B

      - name: 上传覆盖率报告
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: target/site/jacoco/

  sonar:
    name: 代码质量分析
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # SonarQube 需要完整历史

      - uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: 'temurin'
          cache: maven

      - name: SonarQube 扫描
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}
        run: |
          mvn verify sonar:sonar \
            -Dsonar.projectKey=my-app \
            -Dsonar.host.url=$SONAR_HOST_URL \
            -Dsonar.token=$SONAR_TOKEN

  build-push:
    name: 构建并推送镜像
    runs-on: ubuntu-latest
    needs: sonar
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: 'temurin'
          cache: maven

      - name: 构建 JAR
        run: mvn package -DskipTests -B

      - name: 登录镜像仓库
        uses: docker/login-action@v3
        with:
          registry: ${{ secrets.REGISTRY }}
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: 构建并推送镜像
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ secrets.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
            ${{ secrets.REGISTRY }}/${{ env.IMAGE_NAME }}:latest

  deploy-test:
    name: 部署测试环境
    runs-on: ubuntu-latest
    needs: build-push
    environment: test
    steps:
      - name: 部署到测试环境
        run: |
          curl -X POST "${{ secrets.DEPLOY_HOOK_TEST }}" \
            -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
            -d '{"image":"${{ github.sha }}"}'
```

### CD 流水线（生产部署）

```yaml
# .github/workflows/deploy-prod.yml
name: Deploy to Production

on:
  workflow_dispatch:           # 手动触发
    inputs:
      image_tag:
        description: '镜像 Tag（默认最新）'
        required: false
        default: 'latest'

jobs:
  deploy:
    name: 生产部署
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    steps:
      - name: 金丝雀发布（10% 流量）
        run: kubectl set image deployment/my-app \
          my-app=${{ secrets.REGISTRY }}/my-app:${{ inputs.image_tag }} \
          --record

      - name: 观察 5 分钟
        run: sleep 300

      - name: 检查错误率
        run: |
          ERROR_RATE=$(curl -s "${{ secrets.PROMETHEUS_URL }}/api/v1/query" \
            --data-urlencode 'query=rate(http_requests_total{status=~"5.."}[5m])' \
            | jq '.data.result[0].value[1]')
          echo "Error rate: $ERROR_RATE"
          if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
            echo "❌ 错误率超过 1%，触发回滚"
            kubectl rollout undo deployment/my-app
            exit 1
          fi

      - name: 全量发布
        run: kubectl rollout status deployment/my-app
```

---

## 三、Jenkins Pipeline

适合私有化部署、需要复杂自定义流程的场景。

```groovy
// Jenkinsfile
pipeline {
    agent any

    environment {
        IMAGE_NAME = 'my-app'
        REGISTRY   = 'registry.example.com'
    }

    stages {
        stage('检出代码') {
            steps {
                checkout scm
            }
        }

        stage('单元测试') {
            steps {
                sh 'mvn test -B'
            }
            post {
                always {
                    junit 'target/surefire-reports/*.xml'
                    jacoco execPattern: 'target/jacoco.exec'
                }
            }
        }

        stage('代码质量') {
            steps {
                withSonarQubeEnv('SonarQube') {
                    sh 'mvn sonar:sonar'
                }
                timeout(time: 5, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        stage('构建镜像') {
            steps {
                sh "mvn package -DskipTests -B"
                sh "docker build -t ${REGISTRY}/${IMAGE_NAME}:${GIT_COMMIT} ."
            }
        }

        stage('推送镜像') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'registry-cred',
                    usernameVariable: 'REG_USER',
                    passwordVariable: 'REG_PASS'
                )]) {
                    sh "docker login ${REGISTRY} -u ${REG_USER} -p ${REG_PASS}"
                    sh "docker push ${REGISTRY}/${IMAGE_NAME}:${GIT_COMMIT}"
                }
            }
        }

        stage('部署测试环境') {
            steps {
                sh "kubectl set image deployment/my-app my-app=${REGISTRY}/${IMAGE_NAME}:${GIT_COMMIT}"
                sh "kubectl rollout status deployment/my-app --timeout=120s"
            }
        }

        stage('部署生产环境') {
            when { branch 'main' }
            input {
                message "确认部署到生产环境？"
                ok "确认发布"
            }
            steps {
                sh "kubectl set image deployment/my-app my-app=${REGISTRY}/${IMAGE_NAME}:${GIT_COMMIT} -n production"
            }
        }
    }

    post {
        failure {
            dingtalk(
                robot: 'dingtalk-robot',
                type: 'MARKDOWN',
                title: "❌ 构建失败：${JOB_NAME} #${BUILD_NUMBER}",
                text: ["构建失败，请查看：${BUILD_URL}"]
            )
        }
        success {
            echo "✅ 流水线执行成功"
        }
    }
}
```

---

## 四、质量门禁（SonarQube）

在流水线中强制执行代码质量标准，不达标则阻断合并。

### 推荐质量门配置

| 指标 | 阈值 | 说明 |
|------|------|------|
| 新增代码覆盖率 | ≥ 80% | 仅检查本次 PR 新增代码 |
| 新增代码重复率 | ≤ 3% | |
| Blocker 问题 | = 0 | 严重 Bug、安全漏洞 |
| Critical 问题 | = 0 | 高危问题 |
| 可靠性评级 | A | |
| 安全性评级 | A | |

### Maven 插件配置

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.sonarsource.scanner.maven</groupId>
    <artifactId>sonar-maven-plugin</artifactId>
    <version>3.10.0.2594</version>
</plugin>
<plugin>
    <groupId>org.jacoco</groupId>
    <artifactId>jacoco-maven-plugin</artifactId>
    <version>0.8.11</version>
    <executions>
        <execution>
            <goals><goal>prepare-agent</goal></goals>
        </execution>
        <execution>
            <id>report</id>
            <phase>test</phase>
            <goals><goal>report</goal></goals>
        </execution>
    </executions>
</plugin>
```

---

## 五、多环境部署策略

| 环境 | 触发方式 | 部署策略 | 数据库 |
|------|---------|---------|--------|
| **dev** | push 到 develop | 自动 | 独立开发库 |
| **test** | PR 合并到 develop | 自动 | 独立测试库（定期从 prod 脱敏同步）|
| **staging** | 手动触发 | 蓝绿 | 与 prod 结构一致的预发库 |
| **production** | 人工审批 | 金丝雀 → 全量 | 生产库 |

```yaml
# 多环境 Kubernetes 部署（Kustomize）
# kustomize/base/deployment.yaml - 公共配置
# kustomize/overlays/test/     - 测试环境差异（副本数、资源限制）
# kustomize/overlays/prod/     - 生产环境差异

# 部署命令
kubectl apply -k kustomize/overlays/prod/
```

---
description: BOM 策略、Enforcer 约束、Renovate / Dependabot、漏洞扫描、License 合规与 SBOM
---

# 依赖治理

> 前置阅读：[构建工具](./1_build_tools)

依赖治理要回答版本谁说了算、冲突怎么提前发现、漏洞和许可证风险怎么持续兜底、出事时能否马上说清「我们用了什么」。本篇用 BOM 与 Version Catalog、maven-enforcer、Renovate / Dependabot、漏洞扫描、License 检查与 CycloneDX SBOM 搭建治理闭环，版本以 2026 年 10 月为准：Spring Boot 4.1.1、Spring Cloud 2025.1.3、Dependency-Check 13.0.0、maven-enforcer-plugin 3.6.3。

---

## 一、治理闭环

![依赖治理闭环](../assets/engineering/dependency-governance-loop.svg)

一个 Spring Boot 服务的运行时类路径上通常有 150 个以上的 jar，其中绝大多数是传递依赖。

| 环节 | 目的 | Maven | Gradle |
|------|------|-------|--------|
| 声明 | 版本只有一个来源 | BOM + 父 POM `dependencyManagement` | platform + Version Catalog |
| 约束 | 冲突和禁用库在构建期失败 | maven-enforcer-plugin | `failOnVersionConflict`、依赖锁定 |
| 扫描 | 发现已知漏洞 | Dependency-Check / OSV-Scanner / Trivy | 同左（OSV / Trivy 与构建工具无关） |
| 研判 | 修复或有期限地接受风险 | 抑制文件，写理由与到期日 | 同左 |
| 升级 | 小步、持续地升级 | Renovate / Dependabot | 同左，识别 `libs.versions.toml` |
| 合规与留档 | 许可证合规、可追溯 | license-maven-plugin、CycloneDX | CycloneDX Gradle 插件、依赖校验 |

落地顺序建议：先统一声明（不然后面的工具都在「多个版本来源」上打补丁），再接自动升级（降低后续修漏洞的成本），然后上扫描与约束，最后补 License 与 SBOM。

---

## 二、BOM 策略

### 1、版本从哪里来：优先级

![Maven 版本来源优先级](../assets/engineering/dependency-governance-bom-precedence.svg)

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 依赖声明上直接写的 `<version>` | 只对这条直接依赖生效，传递依赖不受影响 |
| 2 | 本 POM（含继承自父 POM）的 `dependencyManagement` 显式条目 | 总是压过 import 进来的 BOM |
| 3 | 先声明的 import BOM | 多个 BOM 管理同一构件时，**先 import 的生效** |
| 4 | 后声明的 import BOM | 只补充前面没管理到的构件 |
| 5 | 依赖调解 | 以上都没管到时，按最短路径 / 先声明决定 |

两个推论：想让某个 BOM 「赢」，就把它放在前面，或者干脆在自己的 `dependencyManagement` 里显式写该构件；继承 `spring-boot-starter-parent` 时，parent 里的托管版本属于第 2 级，在子 POM 再 import 一个更新的 Jackson / Netty BOM **不会生效**，要用 parent 提供的版本属性覆盖。

### 2、组合多个 BOM

Spring Cloud 发布列车与 Boot 版本是绑定的，必须按 [官方兼容表](https://spring.io/projects/spring-cloud) 选择：2025.1.x（Oakwood）对应 Boot 4.0.x 与 4.1.x（4.1.x 需 2025.1.2 及以上），Boot 3.5 对应的 2025.0.x 已停止维护。

```xml
<properties>
  <spring-boot.version>4.1.1</spring-boot.version>
  <spring-cloud.version>2025.1.3</spring-cloud.version>
</properties>

<dependencyManagement>
  <dependencies>
    <!-- 公司 BOM 放最前：与下面两个 BOM 重叠的构件以它为准 -->
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>platform-bom</artifactId>
      <version>2026.10.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>${spring-boot.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-dependencies</artifactId>
      <version>${spring-cloud.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

### 3、覆盖单个托管版本

修漏洞时经常需要在 Boot 发布补丁版之前单独提升某个库：

| 接入方式 | 覆盖方法 |
|----------|----------|
| 继承 `spring-boot-starter-parent` | 改 parent 暴露的版本属性，如 `<logback.version>`；属性名见 Boot 文档的「Dependency Versions」附录 |
| import `spring-boot-dependencies` | 属性无效；在自己的 `dependencyManagement` 中、BOM 之前显式声明该构件，或 import 该库自己的 BOM 并放在 Boot BOM 之前 |
| Gradle + dependency-management 插件 | `extra["logback.version"] = "x.y.z"` |
| Gradle + platform | `constraints { implementation("ch.qos.logback:logback-classic:x.y.z") }` 或 `resolutionStrategy` |

覆盖是临时措施：在覆盖处写注释说明原因（CVE 编号）和「Boot 升到哪个版本后删除」，否则它会在后续升级中悄悄把版本钉死。

### 4、团队自定义 BOM

多个微服务共享内部组件时，发布一个只含 `dependencyManagement` 的 BOM：

```xml
<!-- platform-bom/pom.xml -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>platform-bom</artifactId>
  <version>2026.10.0</version>
  <packaging>pom</packaging>

  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>common-web</artifactId>
        <version>1.4.0</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>common-mq</artifactId>
        <version>1.2.3</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
```

消费方的 import 同样**必须放在 `<dependencyManagement><dependencies>` 里**（`import` 作用域只在这里合法），写法即上一小节第一个条目。BOM 自身不要继承 `spring-boot-starter-parent`，否则 Boot 的全部托管版本会被一起带进来，打乱消费方的优先级。

Gradle 中用 `java-platform` 插件发布等价的平台：

```kotlin
// platform/build.gradle.kts
plugins {
    `java-platform`
}

dependencies {
    constraints {
        api("com.example:common-web:1.4.0")
        api("com.example:common-mq:1.2.3")
    }
}
```

消费方用 `implementation(platform("com.example:platform:2026.10.0"))` 引入。

---

## 三、构建期约束

### 1、maven-enforcer-plugin

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-enforcer-plugin</artifactId>
  <version>3.6.3</version>
  <executions>
    <execution>
      <id>enforce</id>
      <goals>
        <goal>enforce</goal>
      </goals>
      <configuration>
        <rules>
          <requireMavenVersion>
            <version>[3.9.0,)</version>
          </requireMavenVersion>
          <requireJavaVersion>
            <version>[21,)</version>
          </requireJavaVersion>
          <!-- 传递依赖要求的版本高于实际解析版本时失败 -->
          <requireUpperBoundDeps/>
          <!-- 同一 POM 中重复声明同一依赖时失败 -->
          <banDuplicatePomDependencyVersions/>
          <bannedDependencies>
            <excludes>
              <exclude>commons-logging:commons-logging</exclude>
              <exclude>log4j:log4j</exclude>
              <exclude>org.apache.logging.log4j:log4j-core:[,2.17.1)</exclude>
            </excludes>
          </bannedDependencies>
        </rules>
      </configuration>
    </execution>
  </executions>
</plugin>
```

`enforce` 目标默认绑定在 `validate` 阶段，所以任何构建一开始就会检查。规则选择：

| 规则 | 作用 | 建议 |
|------|------|------|
| `requireUpperBoundDeps` | 防止「近的低版本」压过「远的高版本」导致 `NoSuchMethodError` | 推荐所有项目启用 |
| `dependencyConvergence` | 同一构件在树中出现多个版本即失败 | 最严格，老项目会报大量冲突，适合新项目或核心库 |
| `bannedDependencies` | 禁用库与漏洞版本区间 | 维护一份团队黑名单，放在公司父 POM |
| `banDuplicatePomDependencyVersions` | 拦截 POM 中的重复声明 | 成本低，推荐启用 |

这些规则放进公司父 POM 的 `pluginManagement` 与 `plugins`，所有服务自动继承。

### 2、Gradle：冲突即失败与依赖锁定

```kotlin
// build.gradle.kts
configurations.all {
    resolutionStrategy {
        // 出现版本冲突时失败，而不是静默选最高版本
        failOnVersionConflict()
    }
}

dependencyLocking {
    lockAllConfigurations()
}
```

```bash
# 生成 / 更新 gradle.lockfile（提交到 Git）
./gradlew dependencies --write-locks
```

锁文件让动态版本（`1.+`、`latest.release`）和传递依赖在每次构建中保持一致，升级时通过 PR 修改锁文件，变化一目了然。Maven 没有内置锁文件，靠「不使用版本区间 + BOM 全量托管」达到同样效果。

---

## 四、自动升级

### 1、Renovate

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "schedule:weekends"],
  "prConcurrentLimit": 5,
  "minimumReleaseAge": "3 days",
  "packageRules": [
    {
      "matchPackageNames": ["/^org\\.springframework/"],
      "groupName": "Spring"
    },
    {
      "matchUpdateTypes": ["patch"],
      "matchCurrentVersion": "!/^0/",
      "automerge": true
    },
    {
      "matchUpdateTypes": ["major"],
      "dependencyDashboardApproval": true
    }
  ]
}
```

文件名是 `renovate.json`，必须是严格 JSON，不能写注释（需要注释时改用 `renovate.json5`）。几个要点：

- `config:recommended` 取代了已弃用的 `config:base`；包名匹配统一用 `matchPackageNames`，正则写在 `/…/` 中，取代已弃用的 `matchPackagePatterns`
- `minimumReleaseAge` 让新版本发布满 3 天才提 PR，给上游撤回问题版本留出时间，也降低遭遇「投毒版本」的概率
- patch 自动合并的前提是分支保护要求 CI 通过；major 升级需在 Dependency Dashboard 中人工批准后才创建 PR
- Renovate 能识别 Maven 的 parent、属性中的版本号、`libs.versions.toml`、Dockerfile 基础镜像和 GitHub Actions

### 2、Dependabot

GitHub 原生功能，在 `.github/dependabot.yml` 中配置：

```yaml
version: 2
updates:
  - package-ecosystem: "maven"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    cooldown:
      default-days: 3
    groups:
      spring:
        patterns:
          - "org.springframework*"
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

`open-pull-requests-limit` 只限制版本升级 PR，安全更新 PR 不计入上限；`cooldown` 同样只作用于版本升级。示例用 `ignore` 屏蔽了所有 major 升级，major 版本改为定期人工评估。Gradle 项目把 `package-ecosystem` 换成 `gradle`。

### 3、怎么选

| 维度 | Renovate | Dependabot |
|------|----------|------------|
| 平台 | GitHub、GitLab、Bitbucket、Azure DevOps、Gitea，可自托管 | 仅 GitHub |
| 配置能力 | 规则引擎丰富：分组、自动合并、Dashboard 审批、预设复用 | 够用：分组、忽略、冷却期 |
| 安全更新 | 读取 OSV 等漏洞源 | 与 GitHub Advisory、Dependabot alerts 深度集成 |
| 适合 | 多平台、多仓库统一策略的团队 | 只用 GitHub、追求零运维 |

二者择一即可，同一仓库同时开启会产生重复 PR。无论哪个，关键都是**小步快跑**：每周合并 patch / minor，比一年后一次性跨大版本便宜得多。

---

## 五、漏洞扫描

### 1、OWASP Dependency-Check

```xml
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>13.0.0</version>
  <configuration>
    <!-- 从 settings.xml 中 id 为 nvd 的 server 读取 API Key（password 字段） -->
    <nvdApiServerId>nvd</nvdApiServerId>
    <failBuildOnCVSS>7</failBuildOnCVSS>
    <formats>
      <format>HTML</format>
      <format>JSON</format>
    </formats>
    <suppressionFiles>
      <suppressionFile>dependency-check-suppressions.xml</suppressionFile>
    </suppressionFiles>
  </configuration>
</plugin>
```

```bash
# 单模块扫描；多模块工程在根目录用 aggregate 生成一份汇总报告
./mvnw -B dependency-check:check
./mvnw -B dependency-check:aggregate

# 只更新本地漏洞库（适合 CI 中单独的定时任务）
./mvnw -B dependency-check:update-only
```

注意事项：

- **NVD API Key 实际上是必需的**：NVD 改用 API 2.0 之后，没有 Key 时首次同步要数小时并频繁被限流。Key 免费申请，放在 `settings.xml` 的 `<server>` 中或通过 `nvdApiKey` 参数传入，不要写进 POM 明文
- **缓存漏洞库**：CI 中缓存本地仓库下的 `org/owasp/dependency-check-data` 目录，否则每次构建都要重新下载
- **`failBuildOnCVSS` 默认是 11**，即永不失败，必须显式设置阈值；报告默认在 `target/dependency-check-report.html`
- 13.x 起插件要求 Maven 3.8.1 及以上

### 2、误报抑制：带理由、带到期日

```xml
<?xml version="1.0" encoding="UTF-8"?>
<suppressions xmlns="https://jeremylong.github.io/DependencyCheck/dependency-suppression.1.3.xsd">
  <suppress until="2027-01-31Z">
    <notes>CVE-2026-12345 仅影响 XML 外部实体解析，本服务未启用该功能；已评估，等待上游 2.4.1 发布后升级</notes>
    <packageUrl regex="true">^pkg:maven/com\.example/legacy-parser@.*$</packageUrl>
    <vulnerabilityName>CVE-2026-12345</vulnerabilityName>
  </suppress>
</suppressions>
```

`until` 是 `<suppress>` 的**属性**而不是子元素，到期后该漏洞会重新出现在报告中，迫使团队重新评估。每条抑制都应写明：不可利用的理由、评估人或工单号、计划的修复方式；抑制文件的变更走 Code Review。可以开启 `failBuildOnUnusedSuppressionRule`，让已修复的依赖对应的残留抑制规则也被清理掉。

### 3、其他扫描器

| 工具 | 漏洞源 | 用法 | 特点 |
|------|--------|------|------|
| OSV-Scanner | OSV.dev（汇总 GitHub Advisory 等） | `osv-scanner scan source -r .` | 与构建工具无关，误报少，速度快 |
| Trivy | 多源聚合 | `trivy fs --scanners vuln .`；`trivy sbom bom.json` | 同时扫文件系统、镜像、SBOM，适合和镜像扫描共用一套工具 |
| GitHub Dependabot alerts | GitHub Advisory Database | 开启依赖图后自动生效 | 零配置，直接在仓库 Security 页提示 |
| Dependency-Check | NVD + OSS Index 等 | Maven / Gradle 插件 | 基于 CPE 匹配，覆盖广，误报相对多 |

推荐组合：PR 上跑一个快的（OSV-Scanner 或 Trivy），每日定时跑一次全量（Dependency-Check 或对 SBOM 的扫描），镜像扫描见 [Docker](/cloud-native/5_docker)。在 CI 中使用第三方扫描 Action 时，按 [CI/CD](/devops/2_ci_cd) 的要求把 Action 固定到完整 commit SHA。

### 4、研判：不是每个 CVE 都要立刻升级

扫描报告出来后按三个问题分级处理：

1. **是否可达**：漏洞函数是否真的会被调用（例如只影响某个未启用的模块或特性）
2. **是否暴露**：受影响组件是否处理外部输入、是否在公网入口上
3. **是否有修复版本**：有则直接升级（优先升级直接依赖或 BOM，再考虑单独覆盖），无则评估缓解措施并带到期日抑制

高危且可达、暴露的漏洞按应急变更处理；其余随每周的升级 PR 消化。常见漏洞类型与防护见 [常见漏洞与防护](/security/8_vulnerabilities)。

---

## 六、License 合规

### 1、构建期检查依赖许可证

`license-maven-plugin` 的 `add-third-party` / `aggregate-add-third-party` 目标收集所有依赖的许可证，并能在出现黑名单许可证时让构建失败（`check-file-header` 检查的是源码文件头，与依赖许可证无关）：

```xml
<plugin>
  <groupId>org.codehaus.mojo</groupId>
  <artifactId>license-maven-plugin</artifactId>
  <version>2.7.1</version>
  <executions>
    <execution>
      <id>check-third-party-licenses</id>
      <phase>verify</phase>
      <goals>
        <goal>add-third-party</goal>
      </goals>
      <configuration>
        <failOnMissing>true</failOnMissing>
        <failOnBlacklist>true</failOnBlacklist>
        <excludedScopes>test,provided</excludedScopes>
        <excludedLicenses>
          <excludedLicense>GNU Affero General Public License (AGPL) version 3.0</excludedLicense>
          <excludedLicense>GNU General Public License (GPL) version 3.0</excludedLicense>
        </excludedLicenses>
        <licenseMerges>
          <licenseMerge>Apache License, Version 2.0|The Apache Software License, Version 2.0|Apache-2.0|Apache 2.0</licenseMerge>
          <licenseMerge>MIT License|MIT|The MIT License</licenseMerge>
        </licenseMerges>
      </configuration>
    </execution>
  </executions>
</plugin>
```

```bash
# 多模块工程汇总所有依赖的许可证清单
./mvnw -B license:aggregate-add-third-party
# 输出 target/generated-sources/license/THIRD-PARTY.txt
```

同一许可证在不同 POM 里写法五花八门，`excludedLicenses` 按名称精确匹配，所以要先用 `licenseMerges` 把别名归一，再写黑名单（被合并的名称以每行第一个为准）。另一条路线是生成 CycloneDX SBOM 后交给 Dependency-Track 等平台统一做许可证策略，适合服务数量多的团队。

### 2、许可证风险分级

| 类别 | 代表 | 风险 | 说明 |
|------|------|------|------|
| 宽松型 | MIT、Apache-2.0、BSD | 低 | 保留版权与许可声明即可；Apache-2.0 还带专利授权 |
| 弱 Copyleft | LGPL、MPL-2.0、EPL-2.0 | 中 | 修改了该库本身的文件需要开源这些修改；作为独立库引用通常可以 |
| 强 Copyleft | GPL-2.0 / GPL-3.0 | 高 | 分发的衍生作品整体需按 GPL 开源，商业分发前需法务评估 |
| 网络 Copyleft | AGPL-3.0 | 极高 | 通过网络提供服务也触发开源义务，SaaS 场景通常禁用 |
| 源码可用（非 OSI 开源） | BSL、SSPL、Elastic License 等 | 高 | 常限制「作为托管服务提供」，一些项目从开源许可证改为此类，升级大版本前要复核许可证 |

上表只是工程上的风险提示，不构成法律意见；具体判断以公司法务的结论为准。

---

## 七、SBOM 与依赖完整性

### 1、生成 CycloneDX SBOM

SBOM（Software Bill of Materials）是一份机器可读的「这个制品包含哪些组件、什么版本、什么许可证」的清单。漏洞爆发时（如 Log4Shell 一类事件），有 SBOM 的团队可以在几分钟内查出受影响的服务，而不是挨个仓库翻依赖树。

`spring-boot-starter-parent` 已预配置 `cyclonedx-maven-plugin`（在 `generate-resources` 阶段执行 `makeAggregateBom`），只需声明插件：

```xml
<build>
  <plugins>
    <plugin>
      <groupId>org.cyclonedx</groupId>
      <artifactId>cyclonedx-maven-plugin</artifactId>
    </plugin>
  </plugins>
</build>
```

构建后 SBOM 位于 `target/classes/META-INF/sbom/application.cdx.json`，并随 fat jar 一起打包，jar 的 manifest 中会写入它的位置供扫描工具发现。不使用 parent 时需要自己写插件版本（当前为 2.9.3）与执行配置，默认产物是 `target/bom.json` 与 `target/bom.xml`。

Gradle 应用 CycloneDX 插件后，Spring Boot 插件会自动把 SBOM 打进 `bootJar`：

```kotlin
plugins {
    id("org.cyclonedx.bom") version "3.5.1"
}
```

### 2、运行时暴露：/actuator/sbom

Actuator 会自动发现 jar 内的 CycloneDX SBOM，以 `application` 为 id 暴露出来。该端点默认不通过 HTTP 暴露，需要显式开启，并且应只对内网或运维鉴权开放：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,sbom
```

```bash
curl http://localhost:8080/actuator/sbom              # {"ids":["application"]}
curl http://localhost:8080/actuator/sbom/application  # CycloneDX JSON
```

拿到 SBOM 后可以离线扫描，不需要源码与构建环境：

```bash
trivy sbom target/classes/META-INF/sbom/application.cdx.json
```

Actuator 端点的安全暴露方式见 [Actuator 监控](/spring-boot/7_actuator)。SBOM 作为制品附件发布、对 SBOM 和镜像做签名与溯源（cosign、SLSA provenance）见 [制品与版本管理](/devops/6_artifact_version)。

### 3、依赖完整性校验

扫描解决的是「已知漏洞」，完整性校验解决的是「下载到的 jar 是不是真的那一个」：

制品签名与溯源见 [制品与版本管理](/devops/6_artifact_version)。

- **Gradle 依赖校验**：生成 `gradle/verification-metadata.xml`，记录每个依赖的 SHA-256，之后任何哈希不匹配都会让构建失败。升级依赖时重新生成并在 PR 中评审差异

```bash
./gradlew --write-verification-metadata sha256 help
```

- **Maven 校验和策略**：使用 `-C`（`--strict-checksums`）让校验和不匹配时构建失败，而不是只打警告；公司 Nexus 代理开启校验和验证，开发机与 CI 一律只从代理拉取
- **不用版本区间与 SNAPSHOT 发布**：`[1.0,2.0)` 与 `-SNAPSHOT` 会让同一份源码在不同时间解析出不同依赖，发布版本必须全部是固定版本

---

## 小结

- 依赖治理是「声明 → 约束 → 扫描 → 研判 → 升级 → 合规与留档」的循环，先统一版本来源再上工具
- Maven 版本优先级：直接写的版本 > 本 POM（含父 POM）的 dependencyManagement > 先 import 的 BOM > 后 import 的 BOM > 调解；BOM import 必须写在 `dependencyManagement` 中，继承 Boot parent 时用属性覆盖版本
- 用 maven-enforcer 的 `requireUpperBoundDeps`、`bannedDependencies` 在构建期拦截冲突与禁用库；Gradle 用 `failOnVersionConflict` 与依赖锁定
- Renovate / Dependabot 二选一，配置冷却期、分组和 patch 自动合并，小步持续升级
- Dependency-Check 必须配 NVD API Key 和明确的 CVSS 阈值；抑制规则用 `until` 属性设到期日并写明理由；PR 用 OSV-Scanner / Trivy 快扫
- License 检查用 `add-third-party` + `failOnBlacklist`，先归一许可证名称；警惕 AGPL 与源码可用类许可证
- Boot parent 内置 CycloneDX，SBOM 随 jar 发布并可经 `/actuator/sbom` 读取；Gradle 依赖校验与 Maven 严格校验和守住下载完整性

## 参考资料

- Maven 依赖机制（import 作用域与 BOM 优先级）：[Introduction to the Dependency Mechanism](https://maven.apache.org/guides/introduction/introduction-to-dependency-mechanism.html)
- Maven Enforcer 内置规则：[Built-In Rules](https://maven.apache.org/enforcer/enforcer-rules/index.html)
- Spring Cloud 与 Boot 版本对应：[Spring Cloud 项目页](https://spring.io/projects/spring-cloud)
- Spring Boot 托管依赖版本：[Dependency Versions](https://docs.spring.io/spring-boot/appendix/dependency-versions/index.html)
- Gradle 平台与约束：[Platforms](https://docs.gradle.org/current/userguide/platforms.html)
- Gradle 依赖锁定：[Locking Dependency Versions](https://docs.gradle.org/current/userguide/dependency_locking.html)
- Gradle 依赖校验：[Verifying Dependencies](https://docs.gradle.org/current/userguide/dependency_verification.html)
- Renovate 配置项：[Configuration Options](https://docs.renovatebot.com/configuration-options/)
- Dependabot 配置项：[Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- Dependency-Check Maven 插件配置：[dependency-check-maven Configuration](https://jeremylong.github.io/DependencyCheck/dependency-check-maven/configuration.html)
- Dependency-Check 抑制文件：[Suppressing False Positives](https://jeremylong.github.io/DependencyCheck/general/suppression.html)
- NVD API Key 申请：[NVD Developers](https://nvd.nist.gov/developers/request-an-api-key)
- OSV-Scanner：[OSV-Scanner 文档](https://google.github.io/osv-scanner/)
- Trivy SBOM 扫描：[Trivy SBOM](https://trivy.dev/latest/docs/target/sbom/)
- License Maven Plugin：[add-third-party 目标](https://www.mojohaus.org/license-maven-plugin/add-third-party-mojo.html)
- Spring Boot 生成 SBOM：[Generate a CycloneDX SBOM](https://docs.spring.io/spring-boot/how-to/build.html)
- Spring Boot SBOM 端点：[Software Bill of Materials (sbom)](https://docs.spring.io/spring-boot/api/rest/actuator/sbom.html)
- CycloneDX Maven 插件：[cyclonedx-maven-plugin](https://github.com/CycloneDX/cyclonedx-maven-plugin)
- CycloneDX Gradle 插件：[cyclonedx-gradle-plugin](https://github.com/CycloneDX/cyclonedx-gradle-plugin)

> 下一篇：[API 设计规范](./7_api_design_rule)

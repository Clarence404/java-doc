# 依赖治理

---

## 一、依赖分类

| 类型 | 说明 | Maven scope |
|------|------|------------|
| **直接依赖** | 项目 pom.xml 显式声明的依赖 | compile / test / provided |
| **传递依赖** | 直接依赖引入的间接依赖 | 继承直接依赖的 scope |
| **可选依赖** | `<optional>true</optional>`，不传递给消费方 | — |
| **测试依赖** | 只在测试阶段使用 | test |

---

## 二、版本冲突排查

```bash
# 查看完整依赖树
mvn dependency:tree

# 显示冲突（被省略的版本用 omitted for conflict 标注）
mvn dependency:tree -Dverbose

# 只看指定 artifact 的冲突
mvn dependency:tree -Dverbose -Dincludes=com.fasterxml.jackson.core:jackson-databind

# Gradle 等效命令
./gradlew dependencies --configuration compileClasspath
```

**冲突解决优先级**（Maven）：
1. `<dependencyManagement>` 锁定版本（最强，推荐）
2. `<exclusion>` 排除传递依赖后手动引入期望版本
3. 在 pom.xml 直接声明直接依赖（路径最短原则）

```xml
<!-- 推荐：通过 dependencyManagement 统一锁定 -->
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.15.3</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

---

## 三、BOM 版本锁定

BOM（Bill of Materials）是一组版本约定的 POM，引入后该组件族无需单独声明版本。

```xml
<!-- 引入多个 BOM（后引入的覆盖先引入的同 artifact 版本） -->
<dependencyManagement>
  <dependencies>
    <!-- Spring Boot BOM（锁定 Spring 全家桶）-->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>3.2.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <!-- Spring Cloud BOM -->
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-dependencies</artifactId>
      <version>2023.0.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

**自定义 BOM**（适合多个微服务共享版本）：

```xml
<!-- common-bom/pom.xml -->
<packaging>pom</packaging>
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>common-utils</artifactId>
      <version>1.2.0</version>
    </dependency>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>common-api</artifactId>
      <version>1.2.0</version>
    </dependency>
  </dependencies>
</dependencyManagement>

<!-- 各微服务 pom.xml 引入，统一版本 -->
<dependency>
  <groupId>com.example</groupId>
  <artifactId>common-bom</artifactId>
  <version>1.2.0</version>
  <type>pom</type>
  <scope>import</scope>
</dependency>
```

---

## 四、漏洞扫描

### OWASP Dependency-Check

```xml
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>9.0.9</version>
  <configuration>
    <failBuildOnCVSS>7</failBuildOnCVSS>   <!-- CVSS ≥ 7 阻断构建 -->
    <format>HTML</format>
    <suppressionFile>dependency-check-suppress.xml</suppressionFile>
  </configuration>
</plugin>
```

```bash
# 本地扫描（首次需下载 NVD 数据库，较慢）
mvn dependency-check:check

# 查看 HTML 报告
open target/dependency-check-report.html
```

**误报抑制**（`dependency-check-suppress.xml`）：

```xml
<suppressions>
  <suppress>
    <notes>CVE-2023-xxxx 在当前使用方式下不可利用，已评估</notes>
    <cve>CVE-2023-xxxx</cve>
    <until>2025-01-01</until>  <!-- 到期自动恢复报告 -->
  </suppress>
</suppressions>
```

---

## 五、依赖自动升级

### Renovate（推荐）

Renovate 是开源的依赖自动更新工具，在 GitHub 上以 App 形式运行，自动发 PR 升级依赖。

```json
// renovate.json（放项目根目录）
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:base"],
  "schedule": ["every weekend"],          // 每周末检查
  "prConcurrentLimit": 5,                // 最多同时开 5 个 PR
  "packageRules": [
    {
      "matchPackagePatterns": ["^org.springframework"],
      "groupName": "Spring Framework",   // Spring 系合并为一个 PR
      "automerge": false                 // 不自动合并，需人工 Review
    },
    {
      "matchUpdateTypes": ["patch"],
      "automerge": true                  // patch 版本自动合并
    }
  ]
}
```

---

## 六、License 合规检查

```xml
<plugin>
  <groupId>org.codehaus.mojo</groupId>
  <artifactId>license-maven-plugin</artifactId>
  <version>2.3.0</version>
  <executions>
    <execution>
      <id>check-licenses</id>
      <phase>verify</phase>
      <goals><goal>check-file-header</goal></goals>
    </execution>
  </executions>
</plugin>
```

```bash
# 列出所有依赖的 License
mvn license:aggregate-add-third-party
# 输出到 target/generated-sources/license/THIRD-PARTY.txt
```

**License 风险等级**：

| License | 商业友好 | 注意事项 |
|---------|---------|---------|
| MIT / Apache 2.0 / BSD | ✅ 友好 | 保留版权声明即可 |
| LGPL | ⚠️ 有条件 | 动态链接可用，静态链接需开源修改部分 |
| GPL | ❌ 高风险 | 传染性，商业项目需评估法律风险 |
| AGPL | ❌ 极高风险 | 网络服务也视为分发，需开源整个项目 |

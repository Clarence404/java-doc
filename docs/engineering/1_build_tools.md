---
description: Maven 生命周期与作用域、依赖调解、Wrapper 与 mvnd、Gradle 9、多模块项目
---

# 构建工具

> **本篇目标**：讲清 Maven 的生命周期、作用域与依赖调解机制，能写出可直接运行的 Maven / Gradle 9 构建配置（Wrapper、surefire / failsafe 分工、Spring Boot 插件、Version Catalog、配置缓存），并搭出分层清晰的多模块工程。
>
> **前置阅读**：[工程效率总览](./0_overview)

本篇是构建机制的主文档：生命周期、作用域、依赖调解规则都在这里讲；BOM 选型、版本约束、漏洞扫描、自动升级、License 与 SBOM 等依赖「治理」放在 [依赖治理](./6_dependency_governance)；JaCoCo、Sonar 与格式化插件放在 [代码质量](./3_code_quality)。版本以 2026 年 10 月为准：Maven 3.9.16、Gradle 9.8、Spring Boot 4.1.x、JDK 21。

---

## 一、Maven 生命周期与插件

### 1、三套生命周期

Maven 有三套相互独立的生命周期：`clean`（清理 `target/`）、`default`（构建与发布）、`site`（生成项目站点）。日常说的「生命周期」指 `default`，它由一串有序的阶段（phase）组成，**执行某个阶段会先依次执行它之前的所有阶段**，所以 `mvn install` 一定会先跑 `test`。

![Maven default 生命周期](../assets/engineering/build-tools-maven-lifecycle.svg)

| 阶段 | 做什么 | 默认绑定（jar 打包） |
|------|--------|----------------------|
| `validate` | 校验 POM 与工程结构 | 无，常把 enforcer 绑在这里 |
| `compile` | 处理资源、编译主代码 | `resources:resources`、`compiler:compile` |
| `test` | 编译并运行单元测试 | `compiler:testCompile`、`surefire:test` |
| `package` | 打成 jar / war | `jar:jar`；Spring Boot 插件在此 `repackage` |
| `pre-integration-test` / `integration-test` / `post-integration-test` | 准备环境、运行集成测试、清理环境 | 无，声明 failsafe 后绑定 `integration-test` |
| `verify` | 检查集成测试与质量门禁结果，决定构建成败 | 无，failsafe 的 `verify`、`jacoco:check` 常绑在这里 |
| `install` | 安装到本地仓库 `~/.m2/repository` | `install:install` |
| `deploy` | 推送到远程仓库（Nexus 等） | `deploy:deploy` |

表中只列出常用阶段，`generate-sources`、`process-resources`、`prepare-package` 等中间阶段同样存在，代码生成类插件（OpenAPI Generator、MapStruct 之外的源码生成器）通常绑在 `generate-sources`。

### 2、阶段与目标

插件的最小执行单元是目标（goal），如 `surefire:test`。阶段本身什么也不做，只是挂载目标的位置。有两种调用方式：

```bash
# 按阶段执行：会执行 validate → … → package 上绑定的全部目标
mvn package

# 直接执行某个目标：只跑这一个，不触发前面的阶段
mvn dependency:tree

# 混用：先 clean 生命周期，再 default 生命周期到 verify
mvn clean verify
```

CI 中推荐 `mvn -B verify`（`-B` 为批处理模式，不输出交互式进度）；只有发布流水线才需要 `deploy`，本地极少需要 `install`，多模块之间的引用用 `-pl` / `-am` 解决（见第五节）。

---

## 二、依赖作用域与传递

### 1、六种作用域

| scope | 编译主代码 | 编译 / 运行测试 | 打进运行时 | 是否传递 | 典型场景 |
|-------|-----------|----------------|-----------|---------|---------|
| `compile`（默认） | 是 | 是 | 是 | 是 | 业务依赖 |
| `provided` | 是 | 是 | 否 | 否 | Servlet API（外部容器提供）、Lombok |
| `runtime` | 否 | 是 | 是 | 是 | JDBC 驱动 |
| `test` | 否 | 是 | 否 | 否 | JUnit、Mockito、Testcontainers |
| `system` | 是 | 是 | 否 | 否 | 引用本机路径的 jar，已不推荐 |
| `import` | — | — | — | — | 只能用在 `dependencyManagement` 中导入 BOM |

`optional` **不是作用域**，而是独立的 `<optional>true</optional>` 元素，可以和任何作用域组合，含义是「我用到了，但不传递给依赖我的项目」。框架用它声明可选集成（例如某个 starter 同时支持两种 JSON 库），Spring Initializr 给 Lombok 生成的就是 `<optional>true</optional>`。Maven 4 还新增了 `compile-only`、`test-only`、`test-runtime` 三种作用域，但需要 4.1.0 模型版本，Maven 3.9 不识别。

### 2、作用域如何传递

传递依赖的最终作用域由「直接依赖的作用域」和「它自己在上游 POM 中的作用域」共同决定（`-` 表示不会被引入）：

| 直接依赖 \ 传递依赖 | compile | provided | runtime | test |
|--------------------|---------|----------|---------|------|
| compile | compile | - | runtime | - |
| provided | provided | - | provided | - |
| runtime | runtime | - | runtime | - |
| test | test | - | test | - |

两条结论最常用：上游的 `provided` 和 `test` 依赖永远不会传递下来（所以「上游有、我这里缺类」时要自己声明）；`test` 作用域下引入的一切都只在测试类路径上。

---

## 三、依赖调解

### 1、两条调解规则

同一个构件（`groupId:artifactId`）在依赖树里出现多个版本时，Maven 只保留一个，规则是：

1. **最短路径优先**：离当前项目层级最近的那个版本胜出
2. **同深度先声明优先**：深度相同时，在 POM 中先声明的那条路径胜出

![Maven 依赖调解](../assets/engineering/build-tools-dependency-mediation.svg)

注意 Maven **不比较版本高低**：近的 1.0 会压过远的 2.0，这正是「运行时报 `NoSuchMethodError`」的高发原因。Gradle 的默认策略不同，它会在所有候选中选**最高版本**，同一棵依赖树在两种工具里可能解析出不同结果。

### 2、排查：看清谁赢了

```bash
# 完整依赖树；-Dverbose 会把被调解掉的版本标成 omitted for conflict with x.y
mvn dependency:tree -Dverbose

# 只看某个构件出现在哪些路径上
mvn dependency:tree -Dverbose -Dincludes=com.google.guava:guava

# 有声明但没用到、用到了却没声明（靠传递依赖碰巧拿到）的依赖
mvn dependency:analyze
```

### 3、干预调解：exclusion 与 dependencyManagement

`<dependencyManagement>` 中声明的版本会**压过调解规则**，对直接依赖和传递依赖都生效，是修正版本的首选；`<exclusions>` 用于把不该出现的传递依赖整个剔除：

```xml
<dependencyManagement>
  <dependencies>
    <!-- 无论 guava 从哪条路径传递进来，都解析为这个版本 -->
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.7.2-jre</version>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>legacy-client</artifactId>
    <version>2.3.0</version>
    <exclusions>
      <!-- 剔除老客户端自带的 commons-logging，日志统一走 SLF4J -->
      <exclusion>
        <groupId>commons-logging</groupId>
        <artifactId>commons-logging</artifactId>
      </exclusion>
    </exclusions>
  </dependency>
</dependencies>
```

团队层面如何让冲突在构建期就失败（`dependencyConvergence`、`requireUpperBoundDeps`）、禁用哪些库、版本谁说了算，见 [依赖治理](./6_dependency_governance)。

### 4、BOM 导入

BOM（Bill of Materials）是只包含 `dependencyManagement` 的 POM，通过 `type=pom` + `scope=import` 导入后，它管理的构件都不用再写版本。导入**必须写在 `<dependencyManagement>` 里**：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>4.1.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

多个 BOM 管理同一构件时谁生效、如何覆盖 BOM 里的单个版本、团队自定义 BOM 的做法，统一在 [依赖治理第二节](./6_dependency_governance) 讲。

---

## 四、Maven 工程实践

### 1、Maven Wrapper：锁定 Maven 版本

Wrapper 让项目自带「用哪个 Maven 版本」的声明，CI 和每个开发者都执行 `./mvnw`，不再依赖本机安装的版本：

```bash
# 在项目根目录生成 mvnw、mvnw.cmd 与 .mvn/wrapper/maven-wrapper.properties
mvn wrapper:wrapper -Dmaven=3.9.16

# 之后一律使用 Wrapper
./mvnw -B verify
```

`maven-wrapper-plugin` 3.3 起默认生成 `only-script` 类型，不再往仓库里放 `maven-wrapper.jar`，脚本会按 `maven-wrapper.properties` 中的 `distributionUrl` 下载 Maven。可以在该文件中加 `distributionSha256Sum` 校验下载包；公司内网把 `distributionUrl` 指向 Nexus 代理即可。`mvnw`、`mvnw.cmd` 和 `.mvn/` 目录都要提交到 Git。

### 2、mvnd：常驻进程加速本地构建

[Maven Daemon（mvnd）](https://github.com/apache/maven-mvnd) 借鉴 Gradle Daemon：构建进程常驻，插件类加载与 JIT 结果在多次构建间复用，并默认并行构建多模块（线程数为 CPU 核数减一）。1.x 版本内嵌 Maven 3.9（1.0.6 对应 3.9.16），2.x 对应 Maven 4，目前仍是预览版。

```bash
mvnd verify               # 用法与 mvn 一致
mvnd -pl order-service -am test
mvnd --stop               # 停止所有 daemon
```

mvnd 适合本地反复构建的大型多模块工程；CI 每次都是全新环境，常驻进程优势不明显，仍推荐 `./mvnw`。

### 3、单元测试与集成测试分开跑

surefire 默认只运行 `**/Test*.java`、`**/*Test.java`、`**/*Tests.java`、`**/*TestCase.java`，`*IT.java` 本来就不会被它执行，不需要额外排除。集成测试交给 failsafe，它在 `integration-test` 阶段运行 `*IT.java`，并在 `verify` 阶段才判定失败，保证 `post-integration-test` 的清理动作一定执行：

```xml
<build>
  <plugins>
    <!-- 单元测试：使用 surefire 默认 includes 即可 -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
    </plugin>
    <!-- 集成测试：*IT.java / IT*.java / *ITCase.java -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-failsafe-plugin</artifactId>
      <executions>
        <execution>
          <goals>
            <goal>integration-test</goal>
            <goal>verify</goal>
          </goals>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

以上片段假设使用 `spring-boot-starter-parent`，它已管理两个插件的版本，并为 failsafe 配好了 `classesDirectory`（否则 `repackage` 之后 failsafe 找不到原始 class）。不用 parent 时需自行写上版本（当前为 3.6.0）。常用开关：`-DskipTests` 跳过两者的执行，`-DskipITs` 只跳过集成测试，`-Dtest=OrderServiceTest` 只跑指定单测。集成测试的写法见 [集成测试](/testing/3_integration_test)。

### 4、Spring Boot 的 Maven 配置

Boot 项目有两种接入方式：

| 方式 | 写法 | 得到什么 |
|------|------|----------|
| 继承 parent | `<parent>` 指向 `spring-boot-starter-parent` | 依赖版本管理 + 插件版本与默认配置（编码、`-parameters`、资源过滤、failsafe、CycloneDX 等） |
| 导入 BOM | 在 `dependencyManagement` 中 import `spring-boot-dependencies` | 只有依赖版本管理，插件版本与配置要自己写 |

公司已有统一父 POM 时用第二种。用 parent 时可以通过属性覆盖单个托管版本（如 `<logback.version>`），导入 BOM 时属性覆盖无效，要在自己的 `dependencyManagement` 中显式声明该构件。

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>4.1.1</version>
  <relativePath/>
</parent>

<properties>
  <java.version>21</java.version>
</properties>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc</artifactId>
  </dependency>
  <dependency>
    <groupId>org.projectlombok</groupId>
    <artifactId>lombok</artifactId>
    <optional>true</optional>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc-test</artifactId>
    <scope>test</scope>
  </dependency>
</dependencies>

<build>
  <plugins>
    <plugin>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-maven-plugin</artifactId>
    </plugin>
  </plugins>
</build>
```

几个容易踩的点：

- **Lombok 不用再手动从 fat jar 中排除**：Boot 4 起 `repackage` 默认不打包 `optional` 依赖（需要时用 `<includeOptional>true</includeOptional>` 恢复），把 Lombok 声明为 `optional` 即可
- **JDK 23+ 的注解处理器**：javac 不再自动运行类路径上的处理器，Lombok / MapStruct 要在 `maven-compiler-plugin` 的 `annotationProcessorPaths` 中显式声明，完整配置见 [效率工具库](/java/98_dev_tool)
- **Boot 4 的 starter 改名**：Web 是 `spring-boot-starter-webmvc`，测试按技术拆成 `spring-boot-starter-<技术>-test`；分层 jar、`build-image` 与 AOT 见 [启动与部署优化](/spring-boot/14_startup)

### 5、可复现构建与常用命令

同一份源码两次构建产出字节级相同的 jar，制品的哈希才有意义（签名、SBOM、缓存都依赖它）。在 POM 中固定归档时间戳即可，使用 `maven-release-plugin` 发版时它会自动更新这个值：

```xml
<properties>
  <project.build.outputTimestamp>2026-10-01T00:00:00Z</project.build.outputTimestamp>
</properties>
```

```bash
./mvnw -B verify -T 1C            # 每个 CPU 核一个线程并行构建模块
./mvnw -B verify -U               # 强制检查远程仓库的 SNAPSHOT / 版本更新
./mvnw -B verify -o               # 离线模式，只用本地仓库
./mvnw -B test -pl order-service -am   # 只构建 order-service 及其依赖的模块
mvn help:effective-pom            # 查看合并 parent、BOM、profile 后的最终 POM
```

---

## 五、Gradle 9

### 1、Gradle 9 要点

| 项目 | 说明 |
|------|------|
| 运行环境 | Gradle 9 自身需要 JDK 17+ 运行；编译项目用的 JDK 通过 toolchain 单独指定，两者解耦 |
| DSL | Kotlin DSL（`build.gradle.kts`）自 8.2 起是新项目默认，有类型检查和 IDE 补全；Groovy DSL 仍支持 |
| 依赖版本 | 用 Version Catalog（`gradle/libs.versions.toml`）集中管理 |
| 配置缓存 | 缓存「配置阶段」的结果，第二次构建直接跳到执行阶段，需在 `gradle.properties` 中开启 |
| 冲突解决 | 默认选最高版本，与 Maven 的最短路径规则不同 |

始终通过 Gradle Wrapper（`./gradlew`）执行构建，升级用 `./gradlew wrapper --gradle-version 9.8.1`，并提交 `gradlew`、`gradlew.bat` 与 `gradle/wrapper/` 目录。

### 2、Spring Boot 项目的 build.gradle.kts

只应用 `org.springframework.boot` 插件**不会**引入依赖版本管理，此时不写版本的 starter 无法解析。需要同时应用 `io.spring.dependency-management` 插件（Boot 插件检测到它后会自动导入 Boot 的 BOM）：

```kotlin
// build.gradle.kts
plugins {
    java
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.example"
version = "1.0.0-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    compileOnly("org.projectlombok:lombok")
    annotationProcessor("org.projectlombok:lombok")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
```

另一种做法是不用 dependency-management 插件，改用 Gradle 原生的平台依赖，构建更快，但不能再用 `extra["logback.version"]` 这类属性覆盖托管版本：

```kotlin
dependencies {
    implementation(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    annotationProcessor(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
}
```

`platform` 只作用于声明它的配置及继承该配置的配置，所以 `annotationProcessor` 这类独立配置需要单独声明一次。

### 3、Version Catalog

```toml
# gradle/libs.versions.toml
[versions]
spring-boot = "4.1.1"
mapstruct = "1.6.3"

[libraries]
mapstruct = { module = "org.mapstruct:mapstruct", version.ref = "mapstruct" }
mapstruct-processor = { module = "org.mapstruct:mapstruct-processor", version.ref = "mapstruct" }

[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }
spring-dependency-management = { id = "io.spring.dependency-management", version = "1.1.7" }
```

```kotlin
// build.gradle.kts 中按类型安全的访问器引用，连字符变成点
plugins {
    java
    alias(libs.plugins.spring.boot)
    alias(libs.plugins.spring.dependency.management)
}

dependencies {
    implementation(libs.mapstruct)
    annotationProcessor(libs.mapstruct.processor)
}
```

Catalog 只是「版本与坐标的集中声明」，不会像 BOM 那样约束传递依赖；需要约束传递依赖时仍要用 platform / BOM。Renovate 和 Dependabot 都能直接识别并升级 `libs.versions.toml`。

### 4、gradle.properties 与构建缓存

`.properties` 文件**不支持行尾注释**：`org.gradle.caching=true  # 注释` 会把整串文字当成值，开关实际没有生效。注释必须单独成行：

```properties
# gradle.properties
# 本地构建缓存：任务输出按输入哈希缓存，clean 之后也能复用
org.gradle.caching=true
# 配置缓存：跳过重复的配置阶段
org.gradle.configuration-cache=true
# 多模块并行执行
org.gradle.parallel=true
# Gradle Daemon 的堆大小（Daemon 默认已开启，无需再配置 org.gradle.daemon）
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8
```

配置缓存遇到不兼容的插件时默认让构建失败，排查期可以临时加 `--configuration-cache-problems=warn`，但不要把 `warn` 长期写进配置，它可能让缓存命中时基于不完整的状态执行。

`org.gradle.caching=true` 只开启**本机**的构建缓存。要让 CI 与开发机之间复用任务输出，还要在 `settings.gradle.kts` 中配置远程缓存，通常只允许 CI 写入：

```kotlin
// settings.gradle.kts
buildCache {
    remote<HttpBuildCache> {
        url = uri("https://gradle-cache.example.com/cache/")
        isPush = System.getenv("CI") != null
        credentials {
            username = System.getenv("GRADLE_CACHE_USER")
            password = System.getenv("GRADLE_CACHE_PASSWORD")
        }
    }
}
```

### 5、Gradle 中排查依赖

```bash
# 某个配置的完整依赖树（-> 表示版本被冲突解决改写）
./gradlew dependencies --configuration runtimeClasspath

# 等价于 Maven 的 -Dincludes：某个依赖为什么是这个版本、从哪里来
./gradlew dependencyInsight --dependency guava --configuration runtimeClasspath
```

---

## 六、多模块项目

### 1、父 POM 与模块分层

```xml
<!-- 根目录 pom.xml -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.1.1</version>
    <relativePath/>
  </parent>

  <groupId>com.example</groupId>
  <artifactId>order-parent</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <packaging>pom</packaging>

  <modules>
    <module>order-api</module>
    <module>order-service</module>
    <module>order-web</module>
  </modules>

  <properties>
    <java.version>21</java.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <!-- 模块之间的引用也在这里统一版本，子模块只写 groupId + artifactId -->
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>order-api</artifactId>
        <version>${project.version}</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>order-service</artifactId>
        <version>${project.version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
```

| 模块 | 内容 | 依赖方向 |
|------|------|----------|
| `order-api` | 对外接口、DTO、错误码，不依赖 Spring，可被其他服务以 jar 形式引用 | 不依赖其他业务模块 |
| `order-service` | 领域逻辑、仓储、外部调用 | 依赖 `order-api` |
| `order-web` | Controller、启动类、配置；唯一配置 `spring-boot-maven-plugin` 的模块 | 依赖 `order-service` |

几条约定：依赖只能单向向下，禁止循环；只有 `order-web` 打可执行 jar，其余模块是普通 jar（若在父 POM 的 `<build><plugins>` 中声明了 Boot 插件，会让所有模块都执行 `repackage`）；在根目录构建时，用 `-pl order-web -am` 让 Maven 在同一次 reactor 中先构建上游模块，不必先 `install` 到本地仓库。

### 2、Maven 4 的现状

截至 2026 年 10 月，Maven 4.0.0 仍是 RC（最新 4.0.0-rc-7），生产项目继续使用 3.9.x。值得提前了解的变化：构建 POM 与消费者 POM 分离（发布到仓库的 POM 会去掉 parent、profile 等仅构建期需要的信息）；`<modules>` 更名为 `<subprojects>`，子模块可以省略 parent 的版本；新增上文提到的三种作用域。这些新特性都需要 4.1.0 模型版本，Maven 3.9 无法读取，迁移前要确认 IDE、CI 与插件都已支持。

---

## 七、私有仓库与镜像

Nexus 仓库的规划、发布凭证与制品版本规范见 [制品与版本管理](/devops/6_artifact_version)。开发机只需在 `~/.m2/settings.xml` 中把所有请求导向公司代理仓库：

```xml
<settings>
  <mirrors>
    <mirror>
      <id>nexus</id>
      <mirrorOf>*</mirrorOf>
      <url>https://nexus.example.com/repository/maven-public/</url>
    </mirror>
  </mirrors>
</settings>
```

仓库地址必须是 `https`：Maven 3.8.1 起内置的 `maven-default-http-blocker` 会拦截所有外部 `http` 仓库。凭证写在 `settings.xml` 的 `<servers>` 中（`id` 与 mirror 的 `id` 一致），不要写进项目 POM；CI 中通过环境变量注入，并用 `mvn --encrypt-password` 或密钥管理服务避免明文。

---

## 小结

- Maven 有 clean / default / site 三套生命周期，执行阶段会带上之前的所有阶段；集成测试是独立阶段，`verify` 负责判定结果
- 作用域只有 compile / provided / runtime / test / system / import，`optional` 是独立元素；上游的 provided 与 test 依赖不会传递
- Maven 调解按「最短路径优先、同深度先声明优先」，不比较版本高低；`dependencyManagement` 压过调解，是修正版本的首选，Gradle 则默认选最高版本
- 用 Wrapper 锁定构建工具版本，mvnd 加速本地构建；单测交给 surefire、集成测试交给 failsafe，不要用 `<excludes>` 硬拆
- Gradle 9 需要同时应用 Boot 插件与 dependency-management 插件（或 platform）才能写无版本依赖；用 Version Catalog 管版本，用配置缓存与远程构建缓存提速，`.properties` 注释必须单独成行
- 多模块单向分层，只有入口模块打可执行 jar；Maven 4 仍是 RC，生产继续用 3.9.x

## 参考资料

- Maven 生命周期：[Introduction to the Build Lifecycle](https://maven.apache.org/guides/introduction/introduction-to-the-lifecycle.html)
- Maven 依赖机制（作用域、调解、import）：[Introduction to the Dependency Mechanism](https://maven.apache.org/guides/introduction/introduction-to-dependency-mechanism.html)
- Maven 版本历史：[Maven Releases History](https://maven.apache.org/docs/history.html)
- Maven Wrapper：[Maven Wrapper](https://maven.apache.org/tools/wrapper/)
- Maven Daemon：[apache/maven-mvnd](https://github.com/apache/maven-mvnd)
- Failsafe 插件用法：[Maven Failsafe Plugin – Usage](https://maven.apache.org/surefire/maven-failsafe-plugin/usage.html)
- Maven 可复现构建：[Configuring for Reproducible Builds](https://maven.apache.org/guides/mini/guide-reproducible-builds.html)
- Spring Boot Maven 插件：[Spring Boot Maven Plugin](https://docs.spring.io/spring-boot/maven-plugin/index.html)
- Spring Boot Gradle 插件依赖管理：[Managing Dependencies](https://docs.spring.io/spring-boot/gradle-plugin/managing-dependencies.html)
- Gradle 兼容性矩阵：[Compatibility Matrix](https://docs.gradle.org/current/userguide/compatibility.html)
- Gradle Version Catalog：[Version Catalogs](https://docs.gradle.org/current/userguide/version_catalogs.html)
- Gradle 配置缓存：[Configuration Cache](https://docs.gradle.org/current/userguide/configuration_cache_enabling.html)
- Gradle 构建缓存：[Build Cache](https://docs.gradle.org/current/userguide/build_cache.html)

> 下一篇：[开发工具](./2_dev_tools)

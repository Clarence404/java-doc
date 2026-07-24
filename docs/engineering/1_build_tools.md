# 构建工具

---

## 一、Maven

### 生命周期

Maven 有三套独立生命周期，常用的是 **default**：

| 阶段 | 说明 |
|------|------|
| `validate` | 校验项目结构是否正确 |
| `compile` | 编译主代码 |
| `test` | 运行单元测试 |
| `package` | 打包（jar / war） |
| `verify` | 运行集成测试验证包 |
| `install` | 安装到本地仓库 |
| `deploy` | 推送到远程仓库 |

执行某阶段会自动触发之前所有阶段。

### 依赖作用域（scope）

| scope | 编译 | 测试 | 运行 | 典型场景 |
|-------|------|------|------|---------|
| `compile`（默认） | ✅ | ✅ | ✅ | 业务依赖 |
| `test` | ❌ | ✅ | ❌ | JUnit、Mockito |
| `provided` | ✅ | ✅ | ❌ | Servlet API（容器提供） |
| `runtime` | ❌ | ✅ | ✅ | JDBC 驱动 |
| `optional` | ✅ | ✅ | ❌ | 框架可选模块，不传递给消费方 |

### 依赖冲突解决

**Maven 调解规则**：
1. 路径最短优先（直接依赖 > 传递依赖）
2. 路径相同则声明顺序靠前优先

```bash
# 查看依赖树，定位冲突
mvn dependency:tree -Dverbose

# 过滤指定依赖
mvn dependency:tree -Dverbose -Dincludes=com.fasterxml.jackson.core:jackson-databind
```

```xml
<!-- 排除传递依赖 -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-web</artifactId>
  <exclusions>
    <exclusion>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
    </exclusion>
  </exclusions>
</dependency>

<!-- 强制锁定版本（覆盖传递依赖） -->
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

### BOM（Bill of Materials）

BOM 是专门用来锁定一组依赖版本的 POM，引入后无需再指定版本号：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>3.2.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<!-- 之后引入 Spring 系依赖无需写版本 -->
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
</dependencies>
```

### 常用插件

```xml
<!-- 跳过集成测试（保留单元测试） -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <excludes>**/*IT.java</excludes>
  </configuration>
</plugin>

<!-- 生成可执行 Fat Jar -->
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <excludes>
      <exclude>
        <groupId>org.projectlombok</groupId>
        <artifactId>lombok</artifactId>
      </exclude>
    </excludes>
  </configuration>
</plugin>

<!-- 代码覆盖率 -->
<plugin>
  <groupId>org.jacoco</groupId>
  <artifactId>jacoco-maven-plugin</artifactId>
  <version>0.8.11</version>
  <executions>
    <execution><goals><goal>prepare-agent</goal></goals></execution>
    <execution>
      <id>report</id>
      <phase>verify</phase>
      <goals><goal>report</goal></goals>
    </execution>
  </executions>
</plugin>
```

---

## 二、Gradle

### Groovy DSL vs Kotlin DSL

| 特性 | Groovy DSL (`build.gradle`) | Kotlin DSL (`build.gradle.kts`) |
|------|-----------------------------|---------------------------------|
| 语法 | 动态，简洁 | 静态类型，IDE 补全更好 |
| 重构 | 困难 | 方便（类型安全） |
| 推荐场景 | 旧项目维护 | 新项目首选 |

```kotlin
// build.gradle.kts 示例
plugins {
    id("org.springframework.boot") version "3.2.0"
    id("java")
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.test {
    useJUnitPlatform()
}
```

### 增量构建与构建缓存

```properties
# gradle.properties
org.gradle.caching=true      # 开启构建缓存（跨机器复用，适合 CI）
org.gradle.parallel=true     # 并行构建多模块
org.gradle.daemon=true       # Daemon 进程常驻，避免每次 JVM 冷启动
org.gradle.jvmargs=-Xmx2g   # 给 Gradle JVM 更多内存
```

---

## 三、多模块项目

### 父 POM 设计原则

```xml
<!-- parent/pom.xml -->
<groupId>com.example</groupId>
<artifactId>my-project</artifactId>
<version>1.0.0-SNAPSHOT</version>
<packaging>pom</packaging>

<modules>
  <module>my-api</module>
  <module>my-service</module>
  <module>my-web</module>
</modules>

<properties>
  <java.version>21</java.version>
</properties>

<dependencyManagement>
  <!-- 统一管理版本，子模块只声明 groupId + artifactId -->
</dependencyManagement>
```

**分层原则**：
- `my-api`：只放接口和 DTO，无 Spring 依赖，被其他模块引用
- `my-service`：业务逻辑，依赖 `my-api`
- `my-web`：Controller 层，依赖 `my-service`，打包入口

```xml
<!-- my-service/pom.xml 引用 my-api -->
<dependency>
  <groupId>com.example</groupId>
  <artifactId>my-api</artifactId>
  <version>${project.version}</version>
</dependency>
```

---

## 四、私有仓库

Nexus 详细配置见 [devops/6_artifact_version](../devops/6_artifact_version)，本地开发常用配置：

```xml
<!-- ~/.m2/settings.xml：所有请求走私有 Nexus -->
<mirrors>
  <mirror>
    <id>nexus</id>
    <mirrorOf>*</mirrorOf>
    <url>http://nexus.example.com/repository/maven-public/</url>
  </mirror>
</mirrors>
```

```bash
# 强制从远程拉取最新 SNAPSHOT
mvn clean install -U

# 离线模式（本地缓存已完整时加速构建）
mvn clean package -o
```

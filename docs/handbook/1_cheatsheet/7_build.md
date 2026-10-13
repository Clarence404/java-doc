---
description: Maven 与 Gradle 的构建、跳过与单测、多模块、依赖分析、版本升级、Spring Boot 运行打包、构建排障
---

# Maven 与 Gradle 命令速查

> 前置阅读：[构建工具](/engineering/1_build_tools)、[依赖治理](/engineering/2_dependency_governance)

本篇按场景列出 Maven 与 Gradle 常用命令，覆盖构建测试、多模块、依赖分析、Spring Boot 打包与排障，基线为 Maven 3.9、Gradle 9。

---

## 一、Maven 构建与测试

| 场景 | 命令 | 说明 |
|------|------|------|
| CI 标准构建 | `./mvnw -B -ntp verify` | `-B` 批处理模式，`-ntp` 不打印下载进度；`verify` 包含集成测试与校验插件 |
| 打包跳过测试执行 | `./mvnw package -DskipTests` | 仍会编译测试代码 |
| 连测试编译也跳过 | `./mvnw package -Dmaven.test.skip=true` | 依赖 `test-jar` 的模块会因此失败 |
| 只跑一个测试类 | `./mvnw test -Dtest=OrderServiceTest` | 支持通配：`-Dtest='Order*Test'` |
| 只跑一个测试方法 | `./mvnw test -Dtest='OrderServiceTest#shouldCreateOrder'` | 多模块中加 `-Dsurefire.failIfNoSpecifiedTests=false`，避免其他模块因无匹配测试而失败 |
| 测试失败也继续 | `./mvnw verify -Dmaven.test.failure.ignore=true` | 先看完全部失败用例，再逐个处理 |
| 激活 Profile | `./mvnw package -Pprod` | 多个用逗号分隔；`-P '!dev'` 为禁用 |
| 多线程构建 | `./mvnw -T 1C verify` | 每个 CPU 核一个线程，模块间无依赖的部分并行 |
| 离线构建 | `./mvnw -o verify` | 只用本地仓库，排查网络问题或内网构建 |
| 强制更新快照与失败缓存 | `./mvnw -U verify` | 解决「之前下载失败被缓存，之后不再重试」 |
| 安装到本地仓库 | `./mvnw install -DskipTests` | 只在需要被其他本地工程引用时用，多模块内部用 `-am` |
| 发布到私服 | `./mvnw deploy -DskipTests` | 私服地址在 `distributionManagement`，凭证在 `settings.xml` |
| 指定 settings 文件 | `./mvnw -s ~/.m2/settings-company.xml verify` | 区分公司私服与个人配置 |

---

## 二、Maven 多模块

| 场景 | 命令 | 说明 |
|------|------|------|
| 只构建某模块及其依赖 | `./mvnw -pl order-service -am package` | `-am` 同时构建它依赖的模块 |
| 构建依赖某模块的模块 | `./mvnw -pl common -amd verify` | 改了公共模块后，验证所有下游 |
| 排除某模块 | `./mvnw -pl '!docs' verify` | 多个用逗号分隔 |
| 从失败的模块继续 | `./mvnw -rf :order-service verify` | 前面已成功的模块不再重复构建 |
| 统一修改版本号 | `./mvnw versions:set -DnewVersion=1.3.0 -DgenerateBackupPoms=false` | 同步修改父子模块的版本 |

---

## 三、Maven 依赖与配置分析

| 场景 | 命令 | 说明 |
|------|------|------|
| 看依赖树 | `./mvnw dependency:tree` | 多模块时加 `-pl` 只看某个模块 |
| 看某依赖从哪里引入 | `./mvnw dependency:tree -Dincludes=com.google.guava:guava` | 格式为 `groupId:artifactId`，支持通配 |
| 看被调解掉的冲突版本 | `./mvnw dependency:tree -Dverbose` | 显示 `omitted for conflict with` 等被舍弃的版本 |
| 找未声明 / 未使用的依赖 | `./mvnw dependency:analyze` | 基于字节码分析，反射与 SPI 加载的依赖会被误报为未使用 |
| 看合并后的最终 POM | `./mvnw help:effective-pom -Doutput=effective-pom.xml` | 包含 parent、BOM、Profile 合并后的结果，查版本来源 |
| 看当前激活的 Profile | `./mvnw help:active-profiles` | 确认环境变量或文件触发的 Profile 是否生效 |
| 看最终生效的 settings | `./mvnw help:effective-settings` | 确认镜像与私服配置；输出中密码会被隐藏 |
| 看依赖可升级版本 | `./mvnw versions:display-dependency-updates` | 列出每个依赖的新版本 |
| 看插件可升级版本 | `./mvnw versions:display-plugin-updates` | 同时检查插件对 Maven 版本的要求 |
| 拷贝运行时依赖 | `./mvnw dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/lib` | 排查打包结果或制作瘦 jar |
| 生成 / 升级 Wrapper | `mvn wrapper:wrapper -Dmaven=3.9.16` | 生成 `mvnw` 与 `.mvn/wrapper/`，一并提交 |

---

## 四、Gradle 构建与测试

| 场景 | 命令 | 说明 |
|------|------|------|
| 完整构建 | `./gradlew build` | 包含编译、测试与 `check` 阶段的所有校验 |
| 跳过测试 | `./gradlew build -x test` | `-x` 排除任意任务 |
| 只跑一个测试类 | `./gradlew test --tests 'com.example.order.OrderServiceTest'` | 支持通配：`--tests '*OrderServiceTest'` |
| 只跑一个测试方法 | `./gradlew test --tests 'com.example.order.OrderServiceTest.shouldCreateOrder'` | 类名与方法名之间用点号 |
| 强制重跑测试 | `./gradlew test --rerun` | 只让该任务忽略增量与缓存；`--rerun-tasks` 会让全部任务重跑 |
| 失败后继续执行其他任务 | `./gradlew build --continue` | 一次收集所有模块的失败 |
| 只构建某个子项目 | `./gradlew :order-service:build` | 路径以冒号开头，从根项目算起 |
| 传入项目属性 | `./gradlew build -Penv=prod` | 构建脚本中用 `providers.gradleProperty("env")` 读取 |
| 离线构建 | `./gradlew build --offline` | 只用本地缓存 |
| 只看会执行哪些任务 | `./gradlew build --dry-run` | 不真正执行，检查任务依赖 |
| 发布到本地 Maven 仓库 | `./gradlew publishToMavenLocal` | 需应用 `maven-publish` 插件 |
| 升级 Wrapper | `./gradlew wrapper --gradle-version 9.8.1` | 提交 `gradlew`、`gradlew.bat` 与 `gradle/wrapper/` |

---

## 五、Gradle 依赖与诊断

| 场景 | 命令 | 说明 |
|------|------|------|
| 看运行时依赖树 | `./gradlew dependencies --configuration runtimeClasspath` | 子项目用 `:order-service:dependencies` |
| 看某依赖为什么是这个版本 | `./gradlew dependencyInsight --dependency guava --configuration runtimeClasspath` | 显示所有请求的版本与冲突解决原因 |
| 强制刷新依赖 | `./gradlew build --refresh-dependencies` | 忽略缓存的元数据，重新检查远程仓库 |
| 看构建脚本自身的依赖 | `./gradlew buildEnvironment` | 排查插件版本冲突 |
| 列出所有任务 | `./gradlew tasks --all` | 查找插件提供的任务名 |
| 看任务的参数说明 | `./gradlew help --task test` | 列出 `--tests` 等任务选项 |
| 列出子项目 | `./gradlew projects` | 查看多项目结构 |
| 看可用 JDK 工具链 | `./gradlew javaToolchains` | 确认 Gradle 识别到的 JDK 版本与路径 |
| 输出详细日志 | `./gradlew build --info --stacktrace` | 仍不够时改用 `--debug`，日志量很大 |
| 查看 Daemon 状态 | `./gradlew --status` | 列出运行中的 Daemon 与状态 |
| 停止 Daemon | `./gradlew --stop` | 修改 `gradle.properties` 中 JVM 参数后，或 Daemon 异常时执行 |

---

## 六、Spring Boot 运行与打包

| 场景 | 命令 | 说明 |
|------|------|------|
| 本地运行（Maven） | `./mvnw spring-boot:run` | 多模块时在应用模块目录执行，或加 `-pl` |
| 本地运行（Gradle） | `./gradlew bootRun` | 子项目用 `:order-service:bootRun` |
| 指定 Profile（Maven） | `./mvnw spring-boot:run -Dspring-boot.run.profiles=dev` | 多个 Profile 用逗号分隔 |
| 指定 Profile（Gradle） | `./gradlew bootRun --args='--spring.profiles.active=dev'` | `--args` 传给应用的命令行参数 |
| 远程调试（Maven） | `./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"` | IDE 远程连接 5005 端口 |
| 远程调试（Gradle） | `./gradlew bootRun --debug-jvm` | 默认监听 5005，并等待调试器连上后才启动 |
| 打可执行 jar（Maven） | `./mvnw package -DskipTests` | 由 `spring-boot-maven-plugin` 的 `repackage` 生成 |
| 打可执行 jar（Gradle） | `./gradlew bootJar` | 产物在 `build/libs/` |
| 构建 OCI 镜像（Maven） | `./mvnw spring-boot:build-image -DskipTests` | 基于 Cloud Native Buildpacks，需要本机有 Docker |
| 构建 OCI 镜像（Gradle） | `./gradlew bootBuildImage` | 同上 |
| 编译原生镜像（Maven） | `./mvnw -Pnative native:compile` | 需 GraalVM 与 `native-maven-plugin` |
| 编译原生镜像（Gradle） | `./gradlew nativeCompile` | 需 GraalVM 与 `org.graalvm.buildtools.native` 插件 |

---

## 七、构建排障

| 场景 | 命令 | 说明 |
|------|------|------|
| 依赖下载失败后一直报错 | `./mvnw -U verify` | Maven 会缓存失败结果（`.lastUpdated` 文件），`-U` 强制重新检查 |
| 看 Maven 完整调试日志 | `./mvnw -X verify > build.log` | 含依赖解析、插件参数、仓库访问细节；只要异常堆栈用 `-e` |
| 确认 Maven 与 JDK 版本 | `./mvnw -v` | CI 上「本地能过、流水线失败」先比对这里 |
| 确认 Gradle 与 JDK 版本 | `./gradlew -v` | 同时显示 Gradle、Kotlin、运行 Gradle 的 JVM 版本 |
| 类找不到或版本冲突 | `./mvnw dependency:tree -Dverbose -Dincludes=com.fasterxml.jackson.core` | Gradle 对应 `dependencyInsight`，找出实际生效的版本 |
| 配置缓存报错 | `./gradlew build --no-configuration-cache` | 临时关闭确认是否为配置缓存兼容问题，再按报告修复脚本 |
| 构建缓存疑似脏数据 | `./gradlew build --no-build-cache --rerun-tasks` | 不读缓存、全部重跑，验证是否为缓存问题 |

::: tip 优先使用 Wrapper
团队项目一律用 `./mvnw` 与 `./gradlew`，保证本地与 CI 使用同一版本的构建工具；Windows 下对应 `mvnw.cmd` 与 `gradlew.bat`。
:::

---

## 小结

最常用的 5 条：

1. `./mvnw -B -ntp verify`：CI 标准构建
2. `./mvnw -pl order-service -am package`：只构建一个模块
3. `./mvnw dependency:tree -Dincludes=<groupId>:<artifactId>`：查依赖从哪来
4. `./gradlew dependencyInsight --dependency <name> --configuration runtimeClasspath`：查 Gradle 依赖版本来源
5. `./gradlew test --tests '<类全名>.<方法名>'`：只跑一个测试

生命周期、作用域与依赖调解的原理见 [构建工具](/engineering/1_build_tools)，BOM 与版本约束见 [依赖治理](/engineering/2_dependency_governance)。

---

## 参考资料

- Maven 命令行选项：[Maven CLI Options Reference](https://maven.apache.org/ref/current/maven-embedder/cli.html)
- 运行单个测试：[Running a Single Test — Maven Surefire Plugin](https://maven.apache.org/surefire/maven-surefire-plugin/examples/single-test.html)
- 依赖插件：[Apache Maven Dependency Plugin](https://maven.apache.org/plugins/maven-dependency-plugin/)
- 版本插件：[Versions Maven Plugin](https://www.mojohaus.org/versions/versions-maven-plugin/)
- Gradle 命令行：[Command-Line Interface](https://docs.gradle.org/current/userguide/command_line_interface.html)
- Gradle 依赖排查：[Viewing and Debugging Dependencies](https://docs.gradle.org/current/userguide/viewing_debugging_dependencies.html)
- Spring Boot Maven 插件运行：[Running your Application with Maven](https://docs.spring.io/spring-boot/maven-plugin/run.html)
- Spring Boot Gradle 插件运行：[Running your Application with Gradle](https://docs.spring.io/spring-boot/gradle-plugin/running.html)

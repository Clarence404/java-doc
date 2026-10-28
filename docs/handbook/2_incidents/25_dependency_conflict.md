---
description: NoSuchMethodError、Arthas 定位类来源、dependency:tree、最近者优先、enforcer 拦截
---

# 依赖冲突导致 NoSuchMethodError

> 前置阅读：[构建工具](/engineering/1_build_tools)、[类加载机制](/jvm/2_class_loading)

报表服务升级 SDK 后编译、测试、启动都通过，上线却抛 `NoSuchMethodError`。本篇复盘低版本 Guava 胜出的原因及定位与拦截手段，基线为 JDK 21、Maven 3.9。

---

## 一、现象

10 月 13 日 10:20 report-service 发布 2.14.0，主要变更是 storage-sdk 从 1.8 升到 2.3。10:41 起告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 10:41 | `HttpErrorRateHigh`：`/reports/export` 接口 5xx 比例 100% |
| 10:42 | 应用日志出现 `java.lang.NoSuchMethodError`，只在导出接口上出现 |
| 10:45 | 其他报表查询接口、服务启动与健康检查均正常 |

```text
2026-10-13T10:41:07.218+08:00 ERROR 1 --- [nio-8080-exec-12] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() ... threw exception
java.lang.NoSuchMethodError: 'java.util.stream.Collector com.google.common.collect.ImmutableList.toImmutableList()'
	at com.example.storage.sdk.upload.MultipartPlanner.plan(MultipartPlanner.java:73)
	at com.example.storage.sdk.StorageClient.putObject(StorageClient.java:142)
	at com.example.report.export.ReportExporter.upload(ReportExporter.java:88)
	...
```

---

## 二、影响

- 10:41–11:05 共 24 分钟，报表导出全部失败，约 350 次导出请求报错，运营同学的日报导出推迟
- 导出任务失败后状态为"失败"，没有生成残缺文件；回滚后由用户手动重新导出
- 只影响用到对象存储上传的路径，其他接口不受影响，所以启动和健康检查都没有发现问题

---

## 三、排查过程

### 1、读懂异常

`NoSuchMethodError` 是链接期错误：调用方的字节码里写着要调用 `ImmutableList.toImmutableList()`（返回 `Collector`），运行时 JVM 在实际加载的 `ImmutableList` 类里找不到这个方法签名。

- **调用方**：`com.example.storage.sdk...MultipartPlanner`，即新升级的 SDK，它编译时用的 Guava 有这个方法（Guava 21 起提供）
- **被调用方**：运行时加载的 `ImmutableList`，显然来自一个更老的 Guava

编译能通过，是因为报表服务自己的代码没有调用这个方法，编译器只检查本项目源码；SDK 是已编译好的 jar，它对 Guava 的引用要到运行时第一次执行那行代码时才解析。

### 2、线上确认类来自哪个 jar

用 Arthas 附着到线上进程（先把这个 Pod 从流量中摘除再操作）：

```bash
sc -d com.google.common.collect.ImmutableList
```

示例输出（节选）：

```text
 class-info        com.google.common.collect.ImmutableList
 code-source       jar:nested:/app/report-service.jar/!BOOT-INF/lib/guava-20.0.jar!/
 name              com.google.common.collect.ImmutableList
 ...
 class-loader      +-org.springframework.boot.loader.launch.LaunchedClassLoader@6d06d69c
                     +-jdk.internal.loader.ClassLoaders$AppClassLoader@5a07e868
                       +-jdk.internal.loader.ClassLoaders$PlatformClassLoader@1b9e1916
 classLoaderHash   6d06d69c
```

运行时用的是 `guava-20.0.jar`。确认方法确实不存在：

```bash
sm com.google.common.collect.ImmutableList toImmutableList
```

输出为空（`Affect(row-cnt:0)`）。需要进一步确认运行的 SDK 代码是否就是新版本，用 `jad` 反编译调用处：

```bash
jad com.example.storage.sdk.upload.MultipartPlanner plan
```

能看到 `.collect(ImmutableList.toImmutableList())`，说明 SDK 是新版本，问题只在 Guava 版本。fat jar 里有没有同时打进两个 Guava：

```bash
unzip -l report-service.jar | grep -i "guava"
```

示例输出：

```text
  2442625  2026-10-13 10:02   BOOT-INF/lib/guava-20.0.jar
```

只有一个，说明不是"两个 jar 里有同名类、谁先加载谁生效"，而是 Maven 在构建时就选了 20.0。

::: tip 没有 Arthas 时
在预发环境用 `-Xlog:class+load=info`（JDK 9+，旧写法 `-verbose:class` 仍可用）启动，日志会打印每个类从哪里加载：

```text
[2.317s][info][class,load] com.google.common.collect.ImmutableList source: jar:nested:/app/report-service.jar/!BOOT-INF/lib/guava-20.0.jar!/
```

日志量很大，只在复现环境开启，并配合 `grep` 指定类名。
:::

### 3、构建期：谁把 20.0 带进来的

```bash
./mvnw dependency:tree -Dverbose -Dincludes=com.google.guava:guava
```

示例输出：

```text
[INFO] com.example:report-service:jar:2.14.0
[INFO] +- com.example:legacy-excel-kit:jar:3.2.1:compile
[INFO] |  \- com.google.guava:guava:jar:20.0:compile
[INFO] \- com.example:storage-sdk:jar:2.3.0:compile
[INFO]    \- (com.google.guava:guava:jar:33.7.2-jre:compile - omitted for conflict with 20.0)
```

两条路径深度相同（都是第 2 层），Maven 的调解规则是"路径最近者优先，深度相同时先声明者优先"。`legacy-excel-kit` 在 `pom.xml` 里声明在 `storage-sdk` 前面，所以 20.0 胜出，SDK 要求的 33.7.2-jre 被丢弃。

升级前的 storage-sdk 1.8 依赖的是 Guava 19，用的方法在 20.0 里都有，所以过去一直相安无事。

### 4、为什么测试没发现

- 报表导出的单元测试把 `StorageClient` 整个 mock 掉了，SDK 内部代码从未执行
- 集成测试连的是本地 MinIO，但只覆盖了小文件；`MultipartPlanner` 只在文件大于 16MB 走分片上传时才调用，测试数据没有覆盖

---

## 四、根因

1. **传递依赖版本冲突**：`legacy-excel-kit` 传递引入 Guava 20.0，`storage-sdk 2.3.0` 传递引入 Guava 33.7.2-jre，路径深度相同，按声明顺序 20.0 胜出
2. **新 SDK 用到了高版本才有的 API**：`ImmutableList.toImmutableList()` 在 Guava 21 才加入，运行时找不到方法签名
3. **构建期没有冲突检查**：项目没有启用 `requireUpperBoundDeps` 等规则，"近的低版本压过远的高版本"没有被拦截
4. **测试没有执行真实 SDK 代码路径**：mock 掉了第三方客户端，大文件分片路径没有覆盖

`NoSuchMethodError` 只在执行到那行代码时才出现，启动成功、健康检查通过都不能证明依赖是一致的。

---

## 五、修复

### 1、止血

- 10:52 回滚到 2.13.2（`kubectl rollout undo deploy/report-service`），11:05 导出接口恢复
- 通知运营同学重新导出失败的报表

### 2、统一版本

在 `dependencyManagement` 里显式指定 Guava 版本，压过调解规则：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.7.2-jre</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

强制升到高版本前要确认老依赖兼容：`legacy-excel-kit` 用到的 Guava API 在 33.x 中都还在（Guava 会删除标记为 `@Deprecated` 一段时间的 API）。验证方式是让 `legacy-excel-kit` 自己的测试用例在 33.7.2-jre 下跑一遍，再用 `jdeps` 或 IDE 检查它引用的 Guava 类与方法。如果老依赖确实不兼容新版本，就只能升级或替换老依赖，或者对其中一方做 shade 重定位包名。

修复后再看一次：

```bash
./mvnw dependency:tree -Dverbose -Dincludes=com.google.guava:guava
```

```text
[INFO] com.example:report-service:jar:2.14.1
[INFO] +- com.example:legacy-excel-kit:jar:3.2.1:compile
[INFO] |  \- com.google.guava:guava:jar:33.7.2-jre:compile (version managed from 20.0)
[INFO] \- com.example:storage-sdk:jar:2.3.0:compile
[INFO]    \- (com.google.guava:guava:jar:33.7.2-jre:compile - omitted for duplicate)
```

### 3、构建期拦截

在公司父 POM 中启用 `maven-enforcer-plugin` 的 `requireUpperBoundDeps`：传递依赖要求的版本高于实际解析版本时构建直接失败。本次的 2.14.0 在这条规则下会报（示例输出）：

```text
[ERROR] Rule 0: org.apache.maven.enforcer.rules.dependency.RequireUpperBoundDeps failed with message:
Failed while enforcing RequireUpperBoundDeps. The error(s) are [
Require upper bound dependencies error for com.google.guava:guava:20.0 paths to dependency are:
+-com.example:report-service:2.14.0
  +-com.example:legacy-excel-kit:3.2.1
    +-com.google.guava:guava:20.0
and
+-com.example:report-service:2.14.0
  +-com.example:storage-sdk:2.3.0
    +-com.google.guava:guava:33.7.2-jre
]
```

规则配置与 `dependencyConvergence` 的取舍见 [依赖治理](/engineering/2_dependency_governance#_1、maven-enforcer-plugin)。同一个类出现在多个不同坐标的 jar 里（例如 `google-collections` 与 `guava`），版本调解管不到，可以用 MojoHaus `extra-enforcer-rules` 中的 `banDuplicateClasses` 规则检查。

### 4、补测试

- 对象存储相关集成测试改为用 Testcontainers 启动 MinIO，覆盖大于分片阈值的文件
- 第三方 SDK 不整个 mock，至少有一条测试真实执行 SDK 的主要路径

---

## 六、预防

**构建规范**：

- 父 POM 统一启用 `requireUpperBoundDeps`；常见公共库（Guava、Jackson、Netty、commons 系列）在团队 BOM 中统一版本
- 升级任何依赖的 PR，CI 自动输出升级前后 `dependency:tree` 的差异作为评论，评审时必须看"有哪些传递依赖的版本变了"

**发布验证**：

- 发布后冒烟测试覆盖依赖第三方 SDK 的核心路径（上传、支付、短信等），不能只看启动和健康检查
- 告警规则中单独监控 `NoSuchMethodError`、`NoClassDefFoundError`、`ClassNotFoundException` 的日志关键字，出现即告警：

```logql
sum by (app) (count_over_time({namespace="prod"} |~ "NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException" [5m])) > 0
```

---

## 七、涉及知识点

- 依赖调解规则与 `exclusion`、`dependencyManagement`：[构建工具](/engineering/1_build_tools#三、依赖调解)
- enforcer 规则、团队 BOM 与升级流程：[依赖治理](/engineering/2_dependency_governance)
- 类加载失败的几类异常对照：[故障排查](/jvm/9_troubleshooting#十二、类加载失败)
- 类加载器与"同名类不同加载器"：[类加载机制](/jvm/2_class_loading)
- Arthas `sc`、`sm`、`jad` 的用法：[Arthas 速查](/handbook/1_cheatsheet/3_arthas#四、类与类加载器)
- Maven 依赖排查命令：[Maven 与 Gradle 命令速查](/handbook/1_cheatsheet/7_build)

---

## 小结

- `NoSuchMethodError` / `NoSuchFieldError` 基本都是依赖版本冲突：编译时的版本和运行时加载的版本不一致
- 线上先用 Arthas `sc -d` 看类来自哪个 jar，`sm` / `jad` 确认方法与代码；没有 Arthas 就用 `-Xlog:class+load`
- 构建期用 `dependency:tree -Dverbose` 找"omitted for conflict"，理解"最近者优先、同深度先声明者优先"
- 修复用 `dependencyManagement` 统一版本，并用 `requireUpperBoundDeps` 把同类问题拦在构建期

## 参考资料

- 依赖调解规则：[Maven — Introduction to the Dependency Mechanism](https://maven.apache.org/guides/introduction/introduction-to-dependency-mechanism.html)
- `dependency:tree` 参数：[Apache Maven Dependency Plugin — dependency:tree](https://maven.apache.org/plugins/maven-dependency-plugin/tree-mojo.html)
- `requireUpperBoundDeps` 规则：[Maven Enforcer — Require Upper Bound Dependencies](https://maven.apache.org/enforcer/enforcer-rules/requireUpperBoundDeps.html)
- `banDuplicateClasses` 规则：[MojoHaus Extra Enforcer Rules](https://www.mojohaus.org/extra-enforcer-rules/)
- `-Xlog` 统一日志：[The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- `NoSuchMethodError` 的语义：[Java SE 21 API — NoSuchMethodError](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/NoSuchMethodError.html)
- Arthas 命令：[Arthas 文档 — sc](https://arthas.aliyun.com/doc/sc.html)

> 下一篇：[服务器被植入挖矿程序](./26_crypto_mining)

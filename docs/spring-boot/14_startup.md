---
description: 启动耗时度量、懒加载与裁剪、CDS / AOT 缓存、AOT 与 Native Image、CRaC、镜像构建
---

# 启动与部署优化

> **本篇目标**：知道 Spring Boot 应用的启动时间花在哪里、怎么量；能按场景在 CDS、AOT 缓存、CRaC、Native Image 之间做选择，并把它们落到容器镜像里。
>
> **前置阅读**：[启动流程与自动配置](./1_spring_boot)、[Spring Boot 版本演进](./11_versions)

> 参考资料：
> * SpringApplication（启动跟踪 / 懒加载 / 虚拟线程）：[https://docs.spring.io/spring-boot/reference/features/spring-application.html](https://docs.spring.io/spring-boot/reference/features/spring-application.html)
> * AOT Cache：[https://docs.spring.io/spring-boot/reference/packaging/aot-cache.html](https://docs.spring.io/spring-boot/reference/packaging/aot-cache.html)
> * Spring Framework JVM AOT Cache：[https://docs.spring.io/spring-framework/reference/integration/aot-cache.html](https://docs.spring.io/spring-framework/reference/integration/aot-cache.html)
> * GraalVM Native Image 支持：[https://docs.spring.io/spring-boot/reference/packaging/native-image/introducing-graalvm-native-images.html](https://docs.spring.io/spring-boot/reference/packaging/native-image/introducing-graalvm-native-images.html)
> * Checkpoint and Restore：[https://docs.spring.io/spring-framework/reference/integration/checkpoint-restore.html](https://docs.spring.io/spring-framework/reference/integration/checkpoint-restore.html)
> * Dockerfiles：[https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html](https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html)

一个典型 Spring Boot 服务的启动时间由三块组成：**JVM 加载和链接成千上万个类**、**Spring 解析配置并创建 Bean**、**JIT 把热点代码编译到峰值**。本篇的各种手段，本质都是把其中某一块挪到构建期，或者干脆跳过。

---

## 一、为什么要关心启动

### 1、启动时间直接影响的场景

| 场景 | 启动慢的后果 |
|------|--------------|
| 弹性扩容（HPA） | 流量高峰来了，新实例几十秒后才就绪，扩容赶不上 |
| Serverless / 缩容到零 | 冷启动时间直接计入首个请求的响应时间 |
| K8s 滚动发布 | 每批 Pod 等待就绪，实例多时整次发布被拉长；启动探针超时还会反复重启 |
| 故障恢复 | 节点宕机后 Pod 重新调度，恢复时间 = 调度 + 启动 + 预热 |
| 本地开发与 CI | 每次重启、每个集成测试上下文都要付一次启动成本 |

### 2、内存同样是部署成本

启动快往往伴随内存小：加载的类少、元数据少，同样规格的节点能放更多实例。容器内存怎么分配给堆、Metaspace、线程栈等区域见 [JVM 层性能策略](/high-perf/5_jvm_tuning)，本篇只讲 Spring Boot 侧能做什么。

::: tip 先判断值不值得
长期运行、扩缩容不频繁的在线服务，几十秒启动通常可以接受，用"预热流量 + 就绪后置"处理冷启动毛刺就够了（见 [优雅上下线与变更](/high-avail/8_graceful_release)）。只有启动时间真正卡住扩容、Serverless 或发布效率时，才值得投入下面成本较高的方案。
:::

---

## 二、先度量：时间花在哪

### 1、启动日志

Spring Boot 启动完成时会打印一行汇总：

```text
Started OrderApplication in 6.512 seconds (process running for 7.104)
```

前者是 `SpringApplication.run()` 的耗时，后者是从 JVM 进程启动算起。两者差值大，说明 JVM 自身启动（类加载、Agent 等）占比高；差值小而前者大，瓶颈在 Bean 创建。

### 2、ApplicationStartup：逐步骤计时

Spring Framework 提供 `ApplicationStartup` 接口记录启动过程中的步骤（`StartupStep`），比如每个 Bean 的实例化、每个后置处理器的执行。Spring Boot 提供了带缓冲的实现 `BufferingApplicationStartup`：

```java
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.metrics.buffering.BufferingApplicationStartup;

@SpringBootApplication
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(OrderApplication.class);
        // 缓冲 2048 个步骤，超出部分丢弃
        app.setApplicationStartup(new BufferingApplicationStartup(2048));
        app.run(args);
    }
}
```

再暴露 Actuator 的 `startup` 端点（Actuator 接入方式见 [Actuator 监控](./7_actuator)）：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,startup
```

```bash
# 查看已记录的步骤（快照）
curl http://localhost:8080/actuator/startup
# 取出并清空缓冲区
curl -X POST http://localhost:8080/actuator/startup
```

返回的 `timeline.events[]` 中每个事件带 `startupStep.name`（如 `spring.beans.instantiate`）、`tags`（如 `beanName`）和 `duration`。按 `duration` 排序，就能找到最慢的 Bean，常见元凶是启动时建连接池、拉远程配置、预加载缓存、扫描大量 Mapper。

### 3、JFR：关联 JVM 事件

另一个实现 `FlightRecorderApplicationStartup` 会把 Spring 的启动步骤写进 JFR 记录，可以和 GC、类加载、内存分配放在同一条时间线上看：

```java
import org.springframework.core.metrics.jfr.FlightRecorderApplicationStartup;

app.setApplicationStartup(new FlightRecorderApplicationStartup());
```

```bash
java -XX:StartFlightRecording:filename=startup.jfr,duration=30s -jar app.jar
```

---

## 三、低成本优化

### 1、懒加载

```yaml
spring:
  main:
    lazy-initialization: true
```

开启后 Bean 在第一次被使用时才创建，启动阶段只创建必要的 Bean。也可以用 `SpringApplication#setLazyInitialization(true)` 编程开启，个别需要立即初始化的 Bean 用 `@Lazy(false)` 排除。

代价必须清楚：

- **配置错误延迟暴露**：一个配错的 Bean 不会在启动时失败，而是在第一个请求用到它时才报错，容易让"启动成功、就绪通过"的实例接到流量后才出错
- **首个请求变慢**：Bean 创建、连接建立的成本挪到了首批请求上，延迟毛刺更明显
- **内存要按全量 Bean 估算**：堆大小要容纳所有 Bean，不能只按启动时的占用来定

所以官方默认不开启。实践中更常见的做法是**只在本地开发和测试环境开启**，生产保持立即初始化，让问题在启动时暴露。

### 2、裁剪自动配置与依赖

启动时每个自动配置类都要加载并评估条件，classpath 上依赖越多，评估和创建的东西越多：

- **去掉用不到的 starter**：这是最有效的裁剪。Spring Boot 4 把原来的大 JAR（如 `spring-boot-autoconfigure`）拆成了更小的模块，各技术都有专属 starter，按需引入的粒度更细（迁移细节见 [版本演进](./11_versions)）
- **查看条件评估报告**：启动时加 `--debug`（或配置 `debug=true`）会打印哪些自动配置生效、哪些没生效及原因；运行中可通过 Actuator 的 `conditions` 端点查看
- **排除确实不需要的自动配置**：`@SpringBootApplication(exclude = ...)` 或 `spring.autoconfigure.exclude` 配置项

### 3、控制扫描范围与启动期 IO

- 组件扫描从启动类所在包往下扫，启动类放在业务根包即可，不要放到 `com` 这类过宽的包下
- 启动期的远程调用（拉配置、注册服务、预热缓存）往往比 Bean 创建本身更慢：能异步的异步，能延后到就绪之后的延后，并给远程调用设置超时
- 连接池的最小空闲连接数会在启动时建立连接，按需设置

### 4、JVM 参数

| 参数 | 作用 | 适用 |
|------|------|------|
| `-XX:TieredStopAtLevel=1` | 只用 C1 编译，编译开销小、启动快，但峰值性能明显下降 | 仅限本地开发 |
| `-Xlog:class+load` | 输出类加载日志，确认 CDS / AOT 缓存是否命中 | 排查 |
| `-XX:MaxRAMPercentage` | 按容器内存比例设置堆上限 | 容器部署，见第八节 |

JIT 分层编译的原理见 [JIT 编译](/jvm/7_jit)。

---

## 四、CDS 与 AOT 缓存

### 1、原理

两者都是 HotSpot 的特性，思路相同：**做一次"训练运行"，把启动期的工作成果存成文件，之后的启动直接映射复用**。区别在于存了多少东西：

| 特性 | 存什么 | JDK 要求 | 效果 |
|------|--------|----------|------|
| CDS / AppCDS | 解析、校验后的类元数据 | 主流 JDK 均可 | 缩短类加载，不影响 JIT 预热 |
| AOT 缓存（JEP 483） | 已加载、已链接的类 | JDK 24+ | 比 CDS 更进一步 |
| AOT 命令行简化（JEP 514） | 一条命令完成训练并生成缓存 | JDK 25+ | 使用更简单 |
| AOT 方法 profiling（JEP 515） | 训练时的方法 profile | JDK 25+ | JIT 更早编译热点，缩短预热 |

Spring Boot 官方文档的建议是：**Java 25 及以上优先用 AOT 缓存，更早的 Java 版本用 CDS**。Project Leyden 各 JEP 的说明见 [JIT 编译](/jvm/7_jit)。

![五种启动路径对比](../assets/spring-boot/startup_paths.svg)

### 2、先解压成适合缓存的布局

缓存对 classpath 有严格要求：JAR 列表必须一致且顺序相同、不能用目录和 `*` 通配符、JAR 的时间戳要保留、训练与运行必须是同一个 JVM。Spring Boot 的可执行 fat jar（JAR 套 JAR）不满足这些条件，所以要先用 `tools` jarmode 解压（Spring Boot 3.3 起提供）：

```bash
java -Djarmode=tools -jar my-app.jar extract --destination application
cd application
```

解压后得到一个只含应用代码的 `my-app.jar` 和放依赖的 `lib/` 目录，`my-app.jar` 的 Manifest 以 JAR 列表形式引用依赖，正好满足缓存要求。**缓存只对解压后的形式生效**，直接对 fat jar 使用没有效果。

### 3、训练运行：spring.context.exit=onRefresh

训练运行需要把应用启动起来，但又不希望它真的开始对外服务。Spring Framework 提供了 `spring.context.exit=onRefresh`：`ApplicationContext` 刷新完成后进程自动退出。此时所有非懒加载的单例已创建、`afterPropertiesSet` 已执行，但生命周期组件尚未启动，也没有发布 `ContextRefreshedEvent`。

```bash
# Java 25+：AOT 缓存
java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -jar my-app.jar
java -XX:AOTCache=app.aot -jar my-app.jar

# Java 24：AOT 缓存需要两步（两步 classpath 必须相同）
java -XX:AOTMode=record -XX:AOTConfiguration=app.aotconf -Dspring.context.exit=onRefresh -jar my-app.jar
java -XX:AOTMode=create -XX:AOTConfiguration=app.aotconf -XX:AOTCache=app.aot -jar my-app.jar

# Java 24 以下：CDS
java -XX:ArchiveClassesAtExit=application.jsa -Dspring.context.exit=onRefresh -jar my-app.jar
java -XX:SharedArchiveFile=application.jsa -jar my-app.jar
```

注意几点：

- **缓存与应用版本、Java 版本绑定**：应用代码或依赖一变就要重新训练，所以训练运行应放进构建流水线或镜像构建里，而不是手工维护
- **训练时要避免连外部系统**：`onRefresh` 之前创建的 Bean 如果启动时就连数据库、注册中心，训练环境要么提供这些依赖，要么通过配置在训练时关闭
- **`onRefresh` 只优化启动**：它退出得早，方法 profile 几乎没有采集到。想让 JEP 515 的 profile 发挥作用、同时缩短预热，需要用接近生产的负载跑训练
- **确认命中**：加 `-Xlog:class+load:file=aot-cache.log`，从缓存加载的类会标注 `source: shared objects file`

### 4、与 Spring AOT 叠加

第五节的 Spring AOT 处理也可以在 JVM 上使用（不编 Native），把 Bean 定义的解析挪到构建期；官方文档说明它可以和 AOT 缓存叠加，进一步缩短启动。代价是继承了 AOT 的限制（Bean 定义在构建期固定），见下一节。

---

## 五、Spring AOT 与 GraalVM Native Image

### 1、Spring AOT 处理做了什么

运行时的 Spring 靠反射解析 `@Configuration`、评估条件、生成 CGLIB 代理。AOT 处理在**构建期**把应用启动到"Bean 定义已确定"的阶段（不创建 Bean 实例），然后产出：

- **Java 源码**：Bean 定义的注册代码，用 `setInstanceSupplier(MyConfiguration::new)` 这类直接调用替代反射；以及一个 `ApplicationContextInitializer`，运行时用它初始化容器
- **字节码**：CGLIB 代理类提前生成
- **GraalVM 提示文件**：反射、资源、序列化、动态代理、JNI 的 JSON 元数据，放在 `META-INF/native-image/` 下

生成物位置：Maven 在 `target/spring-aot/main/` 下，Gradle 在 `build/generated/aotSources` 等目录下。

在 JVM 上使用 AOT 代码（Maven 用 `native` profile 打包，Gradle 需引入 `org.springframework.boot.aot` 插件）：

```bash
mvn -Pnative package
java -Dspring.aot.enabled=true -jar target/my-app.jar
```

### 2、构建原生可执行文件

Native Image 在 AOT 处理的基础上，由 GraalVM 从 `main` 入口做静态分析，只把可达的代码编译成机器码。Spring Boot 4 要求用 **JDK 25 对应的 GraalVM / Liberica NIK 25** 构建。两条路径：

| 方式 | Maven | Gradle | 产物 |
|------|-------|--------|------|
| Native Build Tools | `mvn -Pnative native:compile` | `gradle nativeCompile` | 本机可执行文件 |
| Buildpacks | `mvn -Pnative spring-boot:build-image` | `gradle bootBuildImage` | 包含可执行文件的容器镜像 |

- Maven 需继承 `spring-boot-starter-parent`（提供 `native` profile）并声明 `org.graalvm.buildtools:native-maven-plugin`
- Gradle 需在 `plugins` 中引入 `org.graalvm.buildtools.native`
- Buildpacks 方式不需要本机装 GraalVM，但需要 Docker；构建很吃内存，macOS 上官方建议给 Docker 至少 8GB

### 3、补充提示：RuntimeHints

Spring 能推断大部分提示，比如 `@RestController` 方法的入参和返回值。推断不到的场景（自己用反射调用、读取 classpath 资源、直接用 `RestClient` 反序列化某个 DTO）需要手动补：

```java
import org.springframework.aot.hint.ExecutableMode;
import org.springframework.aot.hint.RuntimeHints;
import org.springframework.aot.hint.RuntimeHintsRegistrar;
import org.springframework.aot.hint.annotation.RegisterReflectionForBinding;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.ImportRuntimeHints;
import org.springframework.util.ReflectionUtils;

@Configuration
@ImportRuntimeHints(AppRuntimeHints.class)
@RegisterReflectionForBinding(PaymentCallback.class)   // RestClient 直接反序列化的 DTO
class NativeConfig {
}

class AppRuntimeHints implements RuntimeHintsRegistrar {

    @Override
    public void registerHints(RuntimeHints hints, ClassLoader classLoader) {
        // 反射调用的方法
        hints.reflection().registerMethod(
                ReflectionUtils.findMethod(PluginLoader.class, "load", String.class),
                ExecutableMode.INVOKE);
        // classpath 资源
        hints.resources().registerPattern("rules/*.json");
        // JDK 动态代理
        hints.proxies().registerJdkProxy(RemoteService.class);
    }
}
```

提示可以用 `RuntimeHintsPredicates` 写单元测试校验。第三方库的提示 Spring 不负责，由 GraalVM 的 [reachability metadata 仓库](https://github.com/oracle/graalvm-reachability-metadata) 提供；库不在其中时，可以在 JVM 上挂 `-agentlib:native-image-agent=config-output-dir=...` 跑一遍应用，用 tracing agent 收集缺失的提示。

### 4、限制

Native Image 和 JVM 上的 Spring AOT 共享"封闭世界"假设，这是选型时最需要评估的：

- **classpath 在构建期固定**，运行时不能再加 JAR、不能动态加载类
- **Bean 定义不能在运行时改变**：`@Profile` 和按 profile 区分的配置受限；会决定 Bean 是否创建的属性（如 `@ConditionalOnProperty`、各种 `.enabled` 开关）在运行时改了不生效。需要"同一个包按环境开关组件"的应用要重新设计配置方式
- **反射、资源、序列化、动态代理**都要有提示，漏了就是运行时 `ClassNotFoundException` / `NoSuchMethodException`，而且只在走到那条路径时才暴露，必须有足够的原生测试覆盖
- **构建慢且吃资源**：一次构建通常是分钟级，内存占用大，CI 成本明显上升
- **没有运行时 JIT**：峰值吞吐通常低于预热后的 HotSpot；依赖 Java Agent 做字节码增强的工具（部分 APM 探针、Arthas 等）无法照搬

适合的场景：Serverless 函数、CLI 工具、扩缩容极频繁的小服务、内存预算紧张的边缘部署。

---

## 六、CRaC：检查点与恢复

### 1、原理

CRaC（Coordinated Restore at Checkpoint）基于 Linux 的 CRIU，把**运行中的 JVM 进程整体快照到磁盘**，之后直接从快照恢复。如果快照是在预热完成后打的，恢复出来的 JVM 也已经是预热状态。Spring Framework 6.1 / Spring Boot 3.2 起提供支持。

前提条件：

- 支持 CRaC 的 JDK（如 Azul Zulu with CRaC、BellSoft Liberica with CRaC），**目前仅限 Linux**
- classpath 中有 `org.crac:crac` 库（1.4.0 及以上）
- 启动参数指定 `-XX:CRaCCheckpointTo=PATH` 或 `-XX:CRaCRestoreFrom=PATH`

### 2、两种用法

```bash
# 方式一：按需快照。先正常启动并施加预热流量，再手动打快照
java -XX:CRaCCheckpointTo=/opt/crac -jar app.jar
jcmd app.jar JDK.checkpoint

# 方式二：启动时自动快照，在 LifecycleProcessor.onRefresh 阶段打快照
java -Dspring.context.checkpoint=onRefresh -XX:CRaCCheckpointTo=/opt/crac -jar app.jar

# 恢复
java -XX:CRaCRestoreFrom=/opt/crac
```

快照前 Spring 会调用所有运行中 Bean 的 `Lifecycle.stop()`，恢复后再调用 `Lifecycle.start()`，让它们关闭、重开连接与线程。自动快照方式发生在启动阶段，**得不到预热好的 JVM**。

### 3、风险

- **快照包含进程内存**：环境变量、配置里的密码、密钥都会落进快照文件，快照的存储与分发要按敏感数据对待
- **资源要能断开重连**：Spring Boot 只管理了有限范围的资源（部分 socket、文件、线程池），其他依赖和业务代码持有的连接要自己实现生命周期管理
- **固定频率任务会补跑**：按需快照时，`@Scheduled(fixedRate = ...)` 在快照到恢复期间错过的执行，会在恢复后集中补执行，建议改用 `fixedDelay` 或 cron
- **实例唯一状态**：随机数种子、实例 ID、本地缓存的时间戳在所有恢复出的实例里都相同，需要在恢复后重新生成

CRaC 不在 OpenJDK 主线，绑定特定发行版和 Linux，恢复要求操作系统和 CPU 架构相近，引入前要评估运维成本。

---

## 七、虚拟线程开关

`spring.threads.virtual.enabled=true`（Java 21+，官方强烈建议 Java 24+）改变的是**运行期的并发模型**，对启动时间没有直接帮助，但能减少为扛住阻塞 IO 而预留的平台线程和线程栈内存；部署时注意虚拟线程都是守护线程，没有其他非守护线程的应用需配 `spring.main.keep-alive=true` 防止 JVM 提前退出。开关的作用范围、钉住问题与收益边界见 [异步任务与定时任务](./9_async_schedule)。

---

## 八、容器镜像构建

### 1、分层解压的 Dockerfile

镜像分层的目标是：依赖不变时只重新推送应用代码那一层。`tools` jarmode 的 `--layers` 选项按变化频率解压成 `dependencies`、`spring-boot-loader`、`snapshot-dependencies`、`application` 四个目录，同时得到的布局正好适合 AOT 缓存，可以在镜像构建中顺手完成训练：

```dockerfile
FROM bellsoft/liberica-openjre-debian:25-cds AS builder
WORKDIR /builder
ARG JAR_FILE=target/*.jar
COPY ${JAR_FILE} application.jar
RUN java -Djarmode=tools -jar application.jar extract --layers --destination extracted

FROM bellsoft/liberica-openjre-debian:25-cds
WORKDIR /application
# 变化越少的层越靠前，提高层缓存命中率
COPY --from=builder /builder/extracted/dependencies/ ./
COPY --from=builder /builder/extracted/spring-boot-loader/ ./
COPY --from=builder /builder/extracted/snapshot-dependencies/ ./
COPY --from=builder /builder/extracted/application/ ./
# 训练运行，生成 AOT 缓存（Java 25+）
RUN java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -jar application.jar
ENTRYPOINT ["java", "-XX:AOTCache=app.aot", "-XX:MaxRAMPercentage=75", "-jar", "application.jar"]
```

`-jar application.jar` 启动的是解压后的瘦 JAR，不是构建产出的 fat jar。训练运行和最终运行必须使用同一个 JDK 镜像。Docker 本身的使用见 [Docker](/cloud-native/5_docker)。

### 2、Buildpacks：不写 Dockerfile

`spring-boot:build-image`（Maven）/ `bootBuildImage`（Gradle）用 Paketo Buildpacks 直接生成分层镜像，通过构建环境变量开启启动优化：

| 变量 | 作用 | 要求 |
|------|------|------|
| `BP_JVM_AOTCACHE_ENABLED=true` | 构建时做训练运行，把 AOT 缓存放进镜像并在启动时使用 | Java 25+ |
| `BP_JVM_CDS_ENABLED=true` | 同上，生成 CDS 归档 | Spring Boot 3.3+ |

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration>
        <image>
            <env>
                <BP_JVM_AOTCACHE_ENABLED>true</BP_JVM_AOTCACHE_ENABLED>
            </env>
        </image>
    </configuration>
</plugin>
```

训练运行如果会连外部系统，可以用 `TRAINING_RUN_JAVA_TOOL_OPTIONS` 只为训练运行覆盖 JVM 参数（例如关闭某些组件）。

### 3、内存设置

- 容器里不要写死 `-Xmx`，用 `-XX:MaxRAMPercentage` 按 limit 比例设置；堆以外还有 Metaspace、线程栈、直接内存、Code Cache，比例一般取 50～75%，具体分析见 [JVM 层性能策略](/high-perf/5_jvm_tuning)
- 官方文档把「缩短启动时间、降低内存占用」同时列为 CDS / AOT 缓存的收益，内存规格可在启用后重新压测确定

### 4、和 K8s 探针配合

启动优化缩短的是"进程起来"的时间，实例能不能接流量还取决于探针：给慢启动应用配 `startupProbe`，就绪探针指向 Actuator 的 readiness 组，预热完成后再标记就绪。探针与优雅上下线见 [Actuator 监控](./7_actuator) 与 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 九、方案对比与选型

| 方案 | 启动 | 峰值性能 | 内存 | 构建成本 | 主要约束 |
|------|------|----------|------|----------|----------|
| 普通 JVM | 慢（基准） | 高，需预热 | 高 | 低 | 无 |
| CDS | 较快 | 高，预热不变 | 略降 | 低，多一次训练运行 | 需解压布局、同一 JVM、应用变化需重训 |
| AOT 缓存 | 快 | 高，预热缩短（JDK 25+） | 略降 | 低，多一次训练运行 | Java 24+（Boot 推荐 25+）；同上 |
| CRaC | 很快，可直接到峰值 | 高 | 与 JVM 相当 | 中，需快照流程 | 特定 JDK + Linux；快照含敏感数据；资源要能断开重连 |
| Native Image | 最快（毫秒级） | 通常低于预热后的 JIT | 最低 | 高，构建慢且吃资源 | 封闭世界；反射等需提示；Bean 定义构建期固定 |

选型建议：

1. **先度量，再做低成本优化**：去掉无用依赖、处理启动期远程调用，往往能拿到可观的收益
2. **JVM 部署的默认选择**：Java 25+ 用 AOT 缓存，Java 21 用 CDS，放进镜像构建流水线，几乎没有代码改造
3. **Native Image**：启动时间和内存是核心指标（Serverless、频繁扩缩容）且能接受封闭世界约束时采用
4. **CRaC**：需要"恢复即峰值"、且能接受特定发行版与运维复杂度时再考虑

---

## 小结

- 启动时间 = 类加载链接 + Bean 创建 + JIT 预热；优化手段的本质是把其中一部分挪到构建期或直接跳过
- 用 `BufferingApplicationStartup` + Actuator `startup` 端点找最慢的 Bean，常见瓶颈是启动期的远程调用和连接建立
- 懒加载能缩短启动，但会把配置错误和初始化成本推迟到首个请求，建议只在开发和测试环境开启
- CDS / AOT 缓存都需要先用 `java -Djarmode=tools -jar app.jar extract` 解压，再用 `-Dspring.context.exit=onRefresh` 做训练运行；Java 25+ 优先 AOT 缓存，缓存与应用版本、JVM 绑定
- Spring AOT 在构建期生成 Bean 定义代码与 GraalVM 提示；Native Image 启动最快、内存最省，代价是封闭世界、Bean 定义固定、构建慢、峰值吞吐偏低
- CRaC 从进程快照恢复，能做到恢复即峰值，但依赖特定 JDK 与 Linux，快照包含敏感数据
- 虚拟线程开关改变运行期并发模型，不直接缩短启动
- 镜像用分层解压或 Buildpacks（`BP_JVM_AOTCACHE_ENABLED` / `BP_JVM_CDS_ENABLED`）构建，内存用 `MaxRAMPercentage` 按比例设置

> 返回：[Spring Boot 总览](./0_overview)

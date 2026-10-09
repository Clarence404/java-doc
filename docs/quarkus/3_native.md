---
description: 原生构建、反射登记、类初始化时机、容器镜像、Kubernetes 扩展、健康与指标
---

# 原生镜像与云原生部署

> **本篇目标**：掌握 Quarkus 原生镜像的构建方式与常见坑（反射、资源、类初始化时机），能用扩展一键生成容器镜像与 Kubernetes 清单，接好健康检查与指标，并能根据业务场景在 JVM 模式与原生模式之间做出取舍。
>
> **前置阅读**：[Quarkus 概览](./1_basics)、[JIT 编译](/jvm/7_jit)、[启动与部署优化](/spring-boot/14_startup)

> 参考资料：
> * 构建原生可执行文件：[https://quarkus.io/guides/building-native-image](https://quarkus.io/guides/building-native-image)
> * 原生应用编写技巧：[https://quarkus.io/guides/writing-native-applications-tips](https://quarkus.io/guides/writing-native-applications-tips)
> * 最低 Mandrel / GraalVM 版本说明：[https://quarkus.io/blog/mandrel-25-minimum-version/](https://quarkus.io/blog/mandrel-25-minimum-version/)
> * 容器镜像：[https://quarkus.io/guides/container-image](https://quarkus.io/guides/container-image)
> * 部署到 Kubernetes：[https://quarkus.io/guides/deploying-to-kubernetes](https://quarkus.io/guides/deploying-to-kubernetes)
> * SmallRye Health：[https://quarkus.io/guides/smallrye-health](https://quarkus.io/guides/smallrye-health)
> * Micrometer：[https://quarkus.io/guides/telemetry-micrometer](https://quarkus.io/guides/telemetry-micrometer)

GraalVM Native Image 的通用原理（静态分析、闭世界假设、AOT 编译）见 [JIT 编译](/jvm/7_jit)，Spring Boot 的原生方案与 CDS / AOT 缓存对比见 [启动与部署优化](/spring-boot/14_startup)。本篇只讲 Quarkus 特有的部分。

---

## 一、原生构建流程

### 1、为什么 Quarkus 做原生更顺

![Quarkus 原生镜像构建流水线](../assets/quarkus/quarkus-native-build.svg)

`native-image` 的难点在于**闭世界假设**：构建期必须知道所有会被反射访问的类、动态代理接口和资源文件，否则运行时找不到。Spring 需要专门的 AOT 引擎在构建期「模拟启动」来推导这些信息；Quarkus 的扩展本来就在构建期处理元数据，**登记反射、资源、代理是扩展的分内工作**，因此用官方扩展的应用通常不需要手写 `reflect-config.json`。

### 2、Mandrel 与 GraalVM

| 发行版 | 说明 |
|--------|------|
| Mandrel | Red Hat 维护的 GraalVM 下游发行版，只包含 `native-image` 所需部分，Quarkus 默认构建镜像 |
| GraalVM | Oracle / GraalVM 社区版，功能更全（如 Truffle 多语言） |

Quarkus 3.36 起官方支持的最低版本提升到 **Mandrel / GraalVM 25.0**，3.31 起默认使用 25.0。

### 3、构建命令

```bash
# 本机已安装 Mandrel / GraalVM
./mvnw install -Dnative

# 本机无需安装 GraalVM：在容器里构建（产物为 Linux 可执行文件）
./mvnw install -Dnative -DskipTests -Dquarkus.native.container-build=true

# 原生集成测试（对构建出的可执行文件跑 @QuarkusIntegrationTest）
./mvnw verify -Dnative
```

```properties
# 构建器镜像，默认 mandrel
quarkus.native.builder-image=mandrel
# 限制 native-image 进程内存
quarkus.native.native-image-xmx=6g
# 透传额外参数
quarkus.native.additional-build-args=--initialize-at-run-time=com.example.legacy.TokenCache
```

构建资源要求高：`native-image` 进程通常需要数 GB 内存，耗时以分钟计，可用 `quarkus.native.native-image-xmx` 限制上限。CI 中建议单独的原生构建任务，不要和单元测试挤在一起。

---

## 二、反射与资源登记

### 1、什么时候需要手动登记

- 自己的类被 JSON 序列化，但**没有出现在 REST 端点签名里**（例如放在 `Map<String, Object>` 中返回、或手动调用 `ObjectMapper`）
- 使用了没有 Quarkus 扩展的第三方库，且它内部依赖反射
- 通过 `Class.forName` 动态加载类

典型症状：JSON 输出为空对象 `{}`、报「No default constructor found」、`ClassNotFoundException`。

### 2、`@RegisterForReflection`

```java
import io.quarkus.runtime.annotations.RegisterForReflection;

// 自己的类：直接标注
@RegisterForReflection
public record AuditEvent(String type, String operator, long timestamp) {}

// 第三方类：用一个空的持有类集中登记
@RegisterForReflection(targets = {
        com.thirdparty.sdk.SignRequest.class,
        com.thirdparty.sdk.SignResponse.class
})
public class ThirdPartyReflectionConfig {}
```

- 嵌套类默认一并登记，不需要时用 `ignoreNested = true`
- 需要 Java 序列化时加 `serialization = true`
- 也可以用 GraalVM 标准方式，把 `reflect-config.json` 放在 `src/main/resources/META-INF/native-image/<groupId>/<artifactId>/`

### 3、资源文件

`native-image` 默认不打包类路径资源。Quarkus 扩展会自动包含它们需要的资源（如 `application.properties`、Flyway 迁移脚本），自定义资源用：

```properties
quarkus.native.resources.includes=templates/**,certs/*.pem
```

`META-INF/resources` 下的文件会被自动包含，但它们同时会作为静态 Web 资源对外暴露，**不要把私密文件放在这里**。

---

## 三、构建期初始化与运行期初始化

### 1、默认策略

**Quarkus 默认在构建期初始化所有类**：类的静态初始化块在构建时执行，结果作为镜像堆快照写进可执行文件。运行时直接使用快照，省去了初始化开销——这也是原生镜像启动快的原因之一。

### 2、典型坑

| 写法 | 问题 | 修正 |
|------|------|------|
| `static final long START = System.currentTimeMillis();` | 值固定为**构建时间** | 放到 `@Singleton` Bean 的实例字段，或延迟到运行期初始化 |
| 静态字段持有 `Random` / `SecureRandom`、线程、文件句柄、网络连接 | 构建失败：GraalVM 检测到这类对象进入镜像堆（`Random` 的种子会被固化）即报错 | 改为运行期创建（懒加载），或用 `--initialize-at-run-time` 延迟该类初始化 |
| 静态块读取环境变量 / 配置 | 读到的是构建机的值 | 改用注入的配置 |

延迟初始化通过构建参数指定：

```properties
# 多个类之间的逗号在 properties 中需要转义
quarkus.native.additional-build-args=--initialize-at-run-time=com.example.IdGenerator\\,com.example.legacy.TokenCache
```

这类问题在 JVM 模式下完全不会出现，**必须用原生集成测试覆盖**，只跑 JVM 模式的单测发现不了。

### 3、其他原生限制

- 可选依赖会把大量代码拉进可达性分析，可能导致构建失败，尽量拆到独立模块
- 重写的 `toString` / `equals` / `hashCode` 里调用反射或第三方库，容易触发构建问题
- 日志：Commons Logging / Log4j 的 `ClassNotFoundException` 可以通过排除这些库、改用 JBoss Logging 适配器解决
- 运行期字节码生成（如运行时创建 CGLIB 代理的库）在原生模式下不可用

---

## 四、容器镜像

### 1、构建方式

| 扩展 | 特点 |
|------|------|
| `quarkus-container-image-jib` | 不需要 Dockerfile，推送到仓库时不依赖 Docker 守护进程；本地构建不推送时仍需 Docker 来登记镜像 |
| `quarkus-container-image-docker` / `-podman` | 使用项目里 `src/main/docker/` 下的 Dockerfile |
| `quarkus-container-image-buildpack` | Cloud Native Buildpacks |
| `quarkus-container-image-openshift` | 在 OpenShift 集群内构建 |

```properties
quarkus.container-image.build=true
quarkus.container-image.push=true
quarkus.container-image.registry=registry.example.com
quarkus.container-image.group=trade
quarkus.container-image.name=order-service
quarkus.container-image.tag=${GIT_SHA:latest}
```

### 2、基础镜像

Jib 的默认基础镜像按模式选择：JVM 模式用 UBI 9 的 OpenJDK 运行时镜像（按应用目标 Java 版本选 17 / 21 / 25），原生模式用 `quay.io/quarkus/ubi9-quarkus-micro-image:2.0`。国内环境通常需要把基础镜像同步到内部仓库，用 `quarkus.jib.base-jvm-image` / `quarkus.jib.base-native-image` 指定。

### 3、JVM 模式的分层

JVM 模式的产物是 `target/quarkus-app/` 目录，而不是一个 fat jar：

- `lib/`：第三方依赖，变化最少，放在镜像最底层
- `app/`：应用代码
- `quarkus/`：增强生成的类
- `quarkus-run.jar`：启动入口

这个布局天然适合分层缓存，只改业务代码时只有很小的一层需要重新推送。不要把它改成 uber-jar 再打镜像，那样会丢掉分层优势。

---

## 五、Kubernetes 扩展、健康检查与指标

### 1、生成部署清单

引入 `quarkus-kubernetes` 后，构建时在 `target/kubernetes/` 生成 `kubernetes.yml` 与 `kubernetes.json`，内容根据项目自动推导（镜像名、端口、探针、环境变量）：

```properties
quarkus.kubernetes.replicas=3
quarkus.kubernetes.resources.requests.cpu=250m
quarkus.kubernetes.resources.requests.memory=256Mi
quarkus.kubernetes.resources.limits.memory=512Mi
quarkus.kubernetes.env.secrets=order-db-secret
quarkus.kubernetes.env.configmaps=order-config
# 默认 false；为 true 时构建后直接部署到当前上下文集群
quarkus.kubernetes.deploy=false
```

生产中更常见的做法是**只用它生成清单作为起点**，再纳入 Helm Chart 或 GitOps 仓库管理，而不是在构建流水线里直接 `deploy=true`。Kubernetes 本身的资源模型与发布策略见 [Kubernetes](/cloud-native/6_kubernetes)。

### 2、健康检查

`quarkus-smallrye-health` 提供 MicroProfile Health 实现：

| 端点 | 用途 | 对应 K8s 探针 |
|------|------|---------------|
| `/q/health/live` | 进程是否需要被重启 | livenessProbe |
| `/q/health/ready` | 是否可以接流量 | readinessProbe |
| `/q/health/started` | 是否完成启动 | startupProbe |

数据源、Kafka、Redis 等扩展会自动注册就绪检查；与 Kubernetes 扩展同时使用时，探针会被自动写进生成的清单。自定义检查：

```java
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.health.HealthCheck;
import org.eclipse.microprofile.health.HealthCheckResponse;
import org.eclipse.microprofile.health.Readiness;

@Readiness
@ApplicationScoped
public class PaymentGatewayHealthCheck implements HealthCheck {

    private final PaymentGatewayClient client;

    PaymentGatewayHealthCheck(PaymentGatewayClient client) {
        this.client = client;
    }

    @Override
    public HealthCheckResponse call() {
        boolean ok = client.ping();
        return HealthCheckResponse.named("payment-gateway").status(ok).build();
    }
}
```

和 Spring Boot Actuator 一样的原则：**存活探针不要检查外部依赖**，否则下游抖动会让所有实例被反复重启；外部依赖只放进就绪检查，且要设置较短的超时。

### 3、指标

`quarkus-micrometer-registry-prometheus` 在 `/q/metrics` 暴露 Prometheus 格式指标，HTTP 服务端 / 客户端、JVM、数据源连接池、Kafka 等指标由扩展自动绑定。业务指标直接注入 `MeterRegistry`。指标体系与告警设计见 [指标监控](/observability/2_metrics)，链路追踪用 `quarkus-opentelemetry`，见 [OpenTelemetry](/observability/5_opentelemetry)。

> 原生模式下 JVM 相关指标（GC、内存池）的含义与 HotSpot 不同，Serial GC 是原生镜像的默认收集器，仪表盘不能直接照搬 JVM 模式的阈值。

---

## 六、JVM 模式还是原生模式

### 1、定性对比

| 维度 | JVM 模式 | 原生模式 |
|------|----------|----------|
| 启动时间 | 秒级以内（已比传统框架快） | 毫秒级 |
| 常驻内存 | 较低 | 更低 |
| 峰值吞吐 | 高，JIT 根据运行时画像优化 | 通常低于充分预热的 JIT；Oracle GraalVM 可用 PGO 缩小差距 |
| 预热 | 需要 | 几乎不需要 |
| GC 选择 | G1、ZGC 等全部可用 | 默认 Serial GC，选择有限 |
| 诊断工具 | JFR、jstack、Arthas、async-profiler 全套 | 能力受限，部分工具不可用 |
| 构建 | 快 | 慢、吃内存，需要额外的原生测试 |
| 兼容性 | 任何 Java 库 | 反射、动态类加载需登记，部分库不可用 |

具体数字与应用、硬件、GC 配置强相关，官方与社区测评的结果差异很大，**以自己的服务压测为准**。

### 2、选型建议

| 场景 | 推荐 |
|------|------|
| Serverless / FaaS、按请求拉起的任务、CLI 工具 | 原生模式，冷启动收益直接体现在延迟和成本上 |
| 高密度部署、实例多但单实例流量小（如大量内部小服务） | 原生模式，内存节省可换算成节点数 |
| 长期运行、高吞吐的核心服务 | JVM 模式，峰值吞吐与可观测性更重要 |
| 依赖大量无扩展的第三方库 | JVM 模式，原生适配成本高 |
| 只想改善启动但不想承担原生的约束 | JVM 模式 + AOT 缓存（JDK 25，见 [启动与部署优化](/spring-boot/14_startup)） |

一个务实的路径：先用 JVM 模式上线拿到构建期增强的大部分收益，再挑冷启动敏感的服务做原生化，并在 CI 中同时跑 JVM 与原生两套集成测试。

---

## 小结

- Quarkus 的扩展在构建期本就掌握反射、资源、代理信息，所以原生构建比 Spring 顺；Quarkus 3.36 起最低支持 Mandrel / GraalVM 25.0
- 手写登记集中在三类：未出现在端点签名中的序列化类、无扩展的第三方库、动态类加载；用 `@RegisterForReflection` 和 `quarkus.native.resources.includes`
- 默认构建期初始化所有类，静态字段里的时间戳、随机数、环境变量会被固化，必须用原生集成测试覆盖
- 容器镜像用 Jib 扩展最省事，JVM 模式的 `quarkus-app/` 布局天然分层，不要改成 uber-jar
- Kubernetes 扩展生成清单作为起点，健康检查分 live / ready / started，存活探针不查外部依赖
- 原生模式适合冷启动敏感与高密度部署，长期运行的高吞吐服务通常留在 JVM 模式

> 下一篇：[响应式与消息](./4_reactive) —— Mutiny、Kafka 响应式消息与事件总线，以及虚拟线程能在多大程度上替代响应式写法。

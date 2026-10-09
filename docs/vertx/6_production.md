---
description: 集群管理器、配置、Micrometer 与链路、健康检查、测试、打包停机、调优与常见坑
---

# 集群与生产实践

> **本篇目标**：能把 Vert.x 服务稳定地跑在生产环境——理解集群的组成与 Kubernetes 下的网络配置，接好配置、指标、链路与健康检查，用 vertx-junit5 写异步测试，掌握打包、优雅停机与性能调优，并对常见事故有预案。
>
> **前置阅读**：[Event Bus](./3_eventbus)、[响应式数据访问](./5_data)

---

## 一、集群

### 1、集群提供什么

单个 Vert.x 进程已经能用满多核。集群解决的是**跨进程**的问题：

| 能力 | 说明 |
|------|------|
| 集群 Event Bus | 不同节点的 Verticle 通过同一套 `send` / `publish` / `request` 通信 |
| 共享数据 | 集群范围的 `AsyncMap`、分布式锁 `getLock`、计数器 `getCounter` |
| 成员管理 | 节点加入、离开、故障检测，订阅表随之更新 |

![Vert.x 集群架构](../assets/vertx/cluster-arch.svg)

Cluster Manager 只负责**成员发现、订阅表和共享数据**，Event Bus 消息本身走节点之间的 TCP 直连。官方提供的实现：

| Cluster Manager | 特点 |
|-----------------|------|
| Hazelcast | 默认选择，资料最多。Vert.x 5 默认绑定 Hazelcast 5.3（支持 JDK 11），升级 Hazelcast 版本前先确认其 JDK 要求 |
| Infinispan | Red Hat 系，与 Quarkus / Keycloak 技术栈一致 |
| Apache Ignite | 已在用 Ignite 做缓存或计算网格时选择 |

### 2、创建集群实例

```java
import io.vertx.core.Vertx;
import io.vertx.core.VertxOptions;
import io.vertx.core.eventbus.EventBusOptions;
import io.vertx.spi.cluster.hazelcast.HazelcastClusterManager;

String podIp = System.getenv("POD_IP");

Vertx.builder()
    .with(new VertxOptions().setEventBusOptions(new EventBusOptions()
        .setHost(podIp)                    // Event Bus 监听地址
        .setPort(15701)
        .setClusterPublicHost(podIp)       // 告诉其他节点用什么地址连我
        .setClusterPublicPort(15701)))
    .withClusterManager(new HazelcastClusterManager())
    .buildClustered()
    .compose(vertx -> vertx.deployVerticle(MainVerticle::new, new DeploymentOptions().setInstances(4)))
    .onFailure(err -> {
      log.error("start failed", err);
      System.exit(1);
    });
```

Vert.x 5 中 `Vertx.clusteredVertx(options)` 被 `Vertx.builder().withClusterManager(...).buildClustered()` 取代。

Hazelcast 配置的查找顺序：系统属性 `vertx.hazelcast.config` 指定的文件 → classpath 根目录的 `cluster.xml` → jar 内置的 `default-cluster.xml`。不要用 `-Dhazelcast.config`，Vert.x 不识别它。

### 3、Kubernetes 中的集群

容器网络是集群配置最容易出问题的地方：

- **成员发现**：关闭 multicast 与自动探测，启用 Hazelcast 的 Kubernetes 发现，并通过 **Headless Service**（`clusterIP: None`）的 DNS 找到同伴 Pod；
- **地址宣告**：Event Bus 默认可能绑定到错误的网卡或宣告 `localhost`，要像上面的代码那样用 Downward API 注入 `POD_IP`，设置 `host` 与 `clusterPublicHost`；
- **端口**：Hazelcast 成员端口（默认 5701）和 Event Bus 端口都要在 NetworkPolicy 中放行；
- **滚动发布**：节点要优雅下线并逐个替换，避免多数成员同时消失导致数据分区丢失；用健康检查作为就绪探针，集群未加入成功前不接流量。

只读或无状态的节点可以配置为 Hazelcast **lite member**：不持有数据分区，增减节点时不会触发分区迁移，但集群中至少要有一个数据节点。Kubernetes 本身的探针、滚动更新策略见 [Kubernetes](/cloud-native/6_kubernetes)。

### 4、要不要上集群

集群 Event Bus 带来了「透明的分布式」，也带来了脑裂、序列化兼容、滚动升级等复杂度。经验上：

- **服务之间的调用**优先用 HTTP / gRPC + 服务发现，这是团队和运维都熟悉的模式；
- **需要节点间低延迟广播**（如 WebSocket 连接分布在多个节点、要按用户推送）时，集群 Event Bus 很顺手；
- **关键业务事件**无论是否集群都要走持久化消息队列，理由见 [Event Bus](./3_eventbus)。

---

## 二、配置

```java
import io.vertx.config.ConfigRetriever;
import io.vertx.config.ConfigRetrieverOptions;
import io.vertx.config.ConfigStoreOptions;

ConfigRetriever retriever = ConfigRetriever.create(vertx, new ConfigRetrieverOptions()
    .setScanPeriod(30_000)                                     // 30s 轮询一次变更
    .addStore(new ConfigStoreOptions().setType("file").setFormat("yaml")
        .setConfig(new JsonObject().put("path", "conf/application.yaml")))
    .addStore(new ConfigStoreOptions().setType("env"))          // 环境变量覆盖文件
    .addStore(new ConfigStoreOptions().setType("sys")));        // 系统属性优先级最高

retriever.getConfig()
    .compose(cfg -> vertx.deployVerticle(ApiVerticle::new,
        new DeploymentOptions().setConfig(cfg).setInstances(cfg.getInteger("http.instances", 4))));

retriever.listen(change -> {
  JsonObject next = change.getNewConfiguration();
  vertx.eventBus().publish("internal.config.changed", next);   // 由各 Verticle 自行应用
});
```

- 后添加的 store 覆盖先添加的同名键；YAML 格式需要额外引入 `vertx-config-yaml`，Kubernetes ConfigMap、Consul、Vault 等也有对应的 store 模块；
- Verticle 内通过 `config()` 读取部署时传入的配置。**部署后配置不会自动更新**，动态配置要像上面一样通过 Event Bus 通知，并在各 Verticle 自己的 Context 上应用；
- 密码、密钥不要写进配置文件，用环境变量或密钥管理服务注入。

---

## 三、指标与链路

### 1、Micrometer 指标

```java
import io.vertx.micrometer.Label;
import io.vertx.micrometer.MicrometerMetricsOptions;
import io.vertx.micrometer.PrometheusScrapingHandler;
import io.vertx.micrometer.VertxPrometheusOptions;

Vertx vertx = Vertx.builder()
    .with(new VertxOptions().setMetricsOptions(new MicrometerMetricsOptions()
        .setPrometheusOptions(new VertxPrometheusOptions().setEnabled(true))
        .setJvmMetricsEnabled(true)                  // JVM 内存、GC、线程指标
        .addLabels(Label.HTTP_ROUTE)                 // 5.x 默认关闭路由标签，按需开启
        .setEnabled(true)))
    .build();

// 在 Router 中暴露抓取端点（需要引入 micrometer-registry-prometheus）
router.route("/metrics").handler(PrometheusScrapingHandler.create());
```

已有 Micrometer 注册表（比如与其他组件共用）时，在上面的基础上再调用 `.withMetrics(new MicrometerMetricsFactory(registry))` 传入；`MicrometerMetricsOptions` 仍需 `setEnabled(true)`，Vert.x 默认不启用指标 SPI。

重点关注的指标：

| 指标 | 含义 | 告警思路 |
|------|------|----------|
| `vertx_http_server_requests_total` / `vertx_http_server_response_time_seconds` | 请求量与延迟 | P99 延迟、5xx 比例 |
| `vertx_pool_queue_pending` / `vertx_pool_in_use` / `vertx_pool_queue_time_seconds` | Worker 池、连接池的排队与占用（Vert.x 5 中 HTTP 客户端连接池指标也改名为 `vertx_pool_*`） | 排队持续大于 0 说明池不够或下游变慢 |
| `vertx_eventbus_pending` | Event Bus 待处理消息 | 持续增长说明 consumer 处理不过来 |
| 阻塞线程告警日志 | 「has been blocked for」 | 出现即告警，按堆栈定位 |

`HTTP_ROUTE` 标签要求路由路径是模板（`/orders/:id`），不要把真实 ID 拼进路径作为标签，否则时间序列数量会爆炸。指标体系与告警设计见 [指标监控](/observability/2_metrics)。

### 2、OpenTelemetry 链路

```java
import io.vertx.tracing.opentelemetry.OpenTelemetryTracingFactory;

Vertx vertx = Vertx.builder()
    .withTracer(new OpenTelemetryTracingFactory(openTelemetrySdk))
    .build();
```

只引入模块不配 SDK 时拿到的是 no-op Tracer，trace ID 全为 0，必须自己构建 `OpenTelemetrySdk`（或使用 Java Agent 提供的全局实例）。各组件默认的追踪策略：

| 组件 | 默认策略 | 含义 |
|------|----------|------|
| HTTP 服务端 | `ALWAYS` | 没有上游 trace 时新建 |
| HTTP 客户端 | `PROPAGATE` | 只在已有 trace 中上报 span |
| Event Bus | `PROPAGATE` | 同上，可通过 `DeliveryOptions#setTracingPolicy` 调整 |

跨异步回调传递 trace 上下文依赖 Vert.x 的 Context，**自己在 JDK 线程池里执行的代码不会自动带上 trace**。日志中的 traceId 可以借助 Reactiverse Contextual Logging（已发布支持 Vert.x 5 的大版本）写入 MDC。OpenTelemetry 的整体架构见 [OpenTelemetry](/observability/5_opentelemetry)。

### 3、健康检查

```java
import io.vertx.ext.healthchecks.Status;
import io.vertx.ext.web.healthchecks.HealthCheckHandler;

HealthCheckHandler readiness = HealthCheckHandler.create(vertx);
readiness.register("database", 2_000, promise ->
    pool.query("SELECT 1").execute()
        .onSuccess(r -> promise.complete(Status.OK()))
        .onFailure(err -> promise.complete(Status.KO())));

router.get("/health/live").handler(ctx -> ctx.response().end("UP"));   // 存活：进程在、Event Loop 能响应
router.get("/health/ready").handler(readiness);                        // 就绪：依赖可用
```

Vert.x 5 中 `HealthCheckHandler` 移到了 `io.vertx.ext.web.healthchecks` 包。**存活探针不要检查数据库**，否则数据库抖动会让 Kubernetes 重启所有 Pod，把局部故障放大成全面故障。

---

## 四、测试

### 1、vertx-junit5

```java
import io.vertx.core.Vertx;
import io.vertx.ext.web.client.WebClient;
import io.vertx.ext.web.codec.BodyCodec;
import io.vertx.junit5.VertxExtension;
import io.vertx.junit5.VertxTestContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(VertxExtension.class)
class MainVerticleTest {

  private WebClient client;     // 存为字段：Vert.x 5 中未被引用的客户端可能在异步操作进行中被 Cleaner 回收

  @BeforeEach
  void deploy(Vertx vertx, VertxTestContext ctx) {
    client = WebClient.create(vertx);
    vertx.deployVerticle(new MainVerticle()).onComplete(ctx.succeedingThenComplete());
  }

  @Test
  void hello(Vertx vertx, VertxTestContext ctx) {
    client.get(8080, "localhost", "/hello/vertx")
        .as(BodyCodec.jsonObject())
        .send()
        .onSuccess(resp -> ctx.verify(() -> {
          assertThat(resp.statusCode()).isEqualTo(200);
          assertThat(resp.body().getString("hello")).isEqualTo("vertx");
          ctx.completeNow();
        }))
        .onFailure(ctx::failNow);
  }
}
```

要点：

- 扩展会为每个测试注入新的 `Vertx` 并在结束后关闭；
- **断言必须包在 `ctx.verify(...)` 里**，否则回调线程中的 `AssertionError` 不会让测试失败，只会等到超时；
- 多个异步条件用 `ctx.checkpoint(n)`，每满足一次调用 `flag()`；超时用 `@Timeout` 调整；
- Vert.x 5 的 `succeeding()` 无参形式改为 `succeedingThenComplete()`。

### 2、集成测试

数据库、Redis、Kafka 用 Testcontainers 启动真实依赖，比 Mock 响应式客户端可靠得多，用法见 [Testcontainers](/testing/5_testcontainers)。测试中端口用 `0` 让系统分配，避免并行测试端口冲突。

---

## 五、打包与部署

### 1、启动方式

| 方式 | 说明 | 建议 |
|------|------|------|
| 自己写 `main()` | 用 `Vertx.builder()` 创建实例并部署，完全可控 | **推荐**，指标、链路、集群都在代码里显式配置 |
| `VertxApplication` | 取代 4.x 的 `Launcher`；`Main-Verticle` 写入 MANIFEST，支持 `-instances`、`-conf`、`-cluster`、`-vt` 等参数 | 仍为 Preview，API 可能变化 |
| `vertx` CLI | 5.x 已删除 | 不再使用 |

打包为 fat jar 可以用 `maven-shade-plugin`，或 Vert.x Maven Plugin 2.0（支持 Vert.x 5）。

### 2、优雅停机

```java
public static void main(String[] args) {
  Vertx vertx = Vertx.vertx();
  vertx.deployVerticle(MainVerticle::new, new DeploymentOptions().setInstances(4))
      .onFailure(err -> vertx.close());

  Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    // 在非 Vert.x 线程上可以 await；close() 会卸载所有 Verticle，依次调用 stop()
    vertx.close().await();
  }));
}
```

收到 `SIGTERM` 后：Kubernetes 先把 Pod 从 Endpoints 中摘除（存在延迟）→ 进程执行关闭钩子 → 各 Verticle 的 `stop()` 中调用 `server.shutdown()`，停止接收新连接并等待在途请求完成（默认最多 30 秒）→ 关闭连接池、生产者。配合 `preStop` 短暂休眠与 `terminationGracePeriodSeconds`，才能做到发布期间零报错，完整流程见 [优雅上下线与变更](/high-avail/8_graceful_release)。

### 3、容器与 Native

- 容器内用 `-XX:MaxRAMPercentage` 控制堆大小，注意 Netty 的直接内存同样计入容器内存限制；
- Vert.x 应用依赖反射少，适合构建 GraalVM Native Image，但 Hazelcast 等模块需要额外的反射配置；需要 Native 的项目更省心的路线是直接使用 Quarkus。Native Image 与 AOT 的通用原理见 [JIT 编译](/jvm/7_jit)。

---

## 六、性能调优

| 方向 | 做法 | 说明 |
|------|------|------|
| Event Loop 数 | 默认 2 × 核数，一般不需要调整 | 容器中确认 JVM 识别到的核数与 CPU limit 一致 |
| HTTP Verticle 实例数 | 等于核数 | 少于核数时部分 Event Loop 不接连接 |
| 原生传输 | `setPreferNativeTransport(true)` 并引入对应 Netty native 依赖 | epoll / io_uring 比 NIO 系统调用更少；Vert.x 5 基于 Netty 4.2，io_uring 已进入主线 |
| 阻塞池隔离 | 不同阻塞任务用命名 `WorkerExecutor` | 避免一个慢任务拖垮所有阻塞操作 |
| 连接池 | 连接池、WebClient 池按压测设置，等待队列设上限 | 默认值（SQL 4、HTTP/1 5、等待队列无界）都偏保守或偏危险 |
| 序列化 | 避免在 Event Loop 上处理大 JSON，Event Bus 只传小消息 | 大对象序列化本身就是阻塞 |
| HTTP 协议 | 内部调用开启 HTTP/2 或长连接复用；5.1 起支持 HTTP/3 | 减少握手开销 |
| 压缩 | `HttpServerOptions#setCompressionSupported(true)` | 节省带宽但消耗 CPU，网关已压缩时不要重复 |

调优前先用指标和阻塞线程告警确认瓶颈在哪里。Netty 层面的参数（缓冲区、水位线、内存分配器）原理见 [生产实践与调优](/netty/12_production)。

---

## 七、常见坑

| 现象 | 根因 | 处理 |
|------|------|------|
| 偶发全体请求变慢，日志出现 blocked thread | Event Loop 上有阻塞调用（JDBC、同步 SDK、大 JSON、锁） | 按告警堆栈定位，移入 Worker / 虚拟线程，或换响应式客户端 |
| 请求挂起直到客户端超时，没有任何日志 | Future 链没有处理失败，或 Handler 既没响应也没 `next()` | 链尾统一 `.onFailure(ctx::fail)`，配置 `TimeoutHandler` 与全局异常处理器 |
| 下游变慢后内存持续上涨直至 OOM | 连接池 / WebClient 等待队列默认无界 | 设置 `maxWaitQueueSize` 与超时，配合熔断 |
| 数据库连接数随实例数暴涨 | 每个 Verticle 实例各建一个连接池 | 使用 `setShared(true)` 的共享池 |
| 计数器、缓存数据不一致 | 误以为多个 Verticle 实例共享字段 | 全局状态用 `SharedData` 或外部存储 |
| 集群节点间消息不通 | Event Bus 宣告了错误的地址（`localhost`、容器内部网卡） | 设置 `host` / `clusterPublicHost` 为 Pod IP，放行端口 |
| 发布后偶发 `NO_HANDLERS` | consumer 集群注册未完成就开始接流量 | 等 `completion()` 后再报告就绪 |
| 消息丢失 | 把 Event Bus 当可靠队列，或拦截器忘记 `next()` | 关键事件走持久化 MQ；检查拦截器 |
| `executeBlocking` 吞吐很差 | 默认 `ordered=true`，同一 Context 上串行 | 独立任务传 `false` |
| 升级 Vert.x 5 后测试偶发 `Pool closed` | 客户端未被引用，被 Cleaner 回收 | 客户端存为字段并显式关闭 |
| 进程无法退出 | 部署失败后没有关闭 `Vertx`，非守护线程仍在运行 | 失败分支调用 `vertx.close()` 或退出进程 |

---

## 小结

- 集群 = Cluster Manager（成员、订阅表、共享数据）+ 节点间 TCP 直连的 Event Bus；官方实现为 Hazelcast、Infinispan、Ignite，Vert.x 5 用 `Vertx.builder().withClusterManager(...).buildClustered()` 创建
- Kubernetes 中用 Headless Service 做成员发现，Event Bus 的 `host` / `clusterPublicHost` 设为 Pod IP；服务间调用优先 HTTP / gRPC，集群 Event Bus 用于节点间广播
- 配置用 `ConfigRetriever` 组合文件、环境变量、系统属性，动态变更通过 Event Bus 通知各 Verticle
- 指标用 `MicrometerMetricsOptions` 开启（已有注册表时 `withMetrics` 传入），重点看 `vertx_pool_*` 排队与 Event Bus 积压；OpenTelemetry 通过 `withTracer` 接入，必须配置 SDK
- 存活探针不查依赖，就绪探针检查依赖；`HealthCheckHandler` 在 Vert.x 5 中移到 Web 模块
- 测试用 vertx-junit5，断言包进 `ctx.verify`；客户端存为字段避免被回收
- 推荐自写 `main()`，关闭钩子里 `vertx.close()`，`stop()` 中 `server.shutdown()` 优雅停机
- 调优先看指标：实例数等于核数、原生传输、阻塞池隔离、连接池与等待队列上限

## 参考资料

- Hazelcast Cluster Manager：[https://vertx.io/docs/vertx-hazelcast/java/](https://vertx.io/docs/vertx-hazelcast/java/)
- Vert.x Config：[https://vertx.io/docs/vertx-config/java/](https://vertx.io/docs/vertx-config/java/)
- Vert.x Micrometer Metrics：[https://vertx.io/docs/vertx-micrometer-metrics/java/](https://vertx.io/docs/vertx-micrometer-metrics/java/)
- Vert.x OpenTelemetry：[https://vertx.io/docs/vertx-opentelemetry/java/](https://vertx.io/docs/vertx-opentelemetry/java/)
- Vert.x JUnit 5：[https://vertx.io/docs/vertx-junit5/java/](https://vertx.io/docs/vertx-junit5/java/)
- Vert.x Application Launcher（Preview）：[https://vertx.io/docs/vertx-launcher-application/java/](https://vertx.io/docs/vertx-launcher-application/java/)

> 返回：[Vert.x 总览](./0_overview)

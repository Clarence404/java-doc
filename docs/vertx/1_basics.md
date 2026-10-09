---
description: 工具包定位、与 Netty 关系、Vert.x 5 变化、与 WebFlux / Quarkus 对比、选型
---

# Vert.x 概览

> **本篇目标**：弄清 Vert.x 是什么、不是什么，它和 Netty、Spring WebFlux、Quarkus 分别是什么关系；掌握 Vert.x 5 相对 4.x 的关键变化，能判断一个项目该不该用 Vert.x、用到什么程度。
>
> **前置阅读**：[Reactor 模型](/netty/2_reactor)、[WebFlux](/spring/8_webflux)

> 参考资料：
> * 官方文档：[https://vertx.io/docs/](https://vertx.io/docs/)
> * What's new in Vert.x 5：[https://vertx.io/blog/whats-new-in-vert-x-5/](https://vertx.io/blog/whats-new-in-vert-x-5/)
> * Vert.x 4 到 5 迁移指南：[https://vertx.io/docs/guides/vertx-5-migration-guide/](https://vertx.io/docs/guides/vertx-5-migration-guide/)
> * Vert.x 5.1 / 5.2 发布说明：[https://vertx.io/blog/whats-new-in-vert-x-5-1/](https://vertx.io/blog/whats-new-in-vert-x-5-1/)、[https://vertx.io/blog/whats-new-in-vert-x-5-2/](https://vertx.io/blog/whats-new-in-vert-x-5-2/)
> * Quarkus Vert.x Reference：[https://quarkus.io/guides/vertx-reference](https://quarkus.io/guides/vertx-reference)

Eclipse Vert.x 是一套运行在 JVM 上的**事件驱动、非阻塞的工具包（toolkit）**。它在 Netty 之上补齐了一个后端服务需要的大部分能力——HTTP 服务端与客户端、路由、响应式数据库客户端、消息、集群、指标与链路——但不规定应用怎么组织、不带依赖注入容器、不扫描注解。用一句话概括：**Netty 给你 Channel 和 ByteBuf，Vert.x 给你 Router 和 Pool，Spring 给你一整套编程模型**。

---

## 一、Vert.x 是什么

### 1、工具包而不是框架

框架和工具包的区别在于控制权：框架调用你的代码（IoC），工具包被你的代码调用。Vert.x 属于后者：

| 维度 | Vert.x | Spring Boot |
|------|--------|-------------|
| 入口 | 自己写 `main()`，`Vertx.vertx()` 创建实例 | `SpringApplication.run()` 接管启动 |
| 组件装配 | 手动 new / 工厂方法，或自行接 Guice、Dagger | IoC 容器 + 自动配置 |
| 依赖粒度 | 按模块引入 jar，`vertx-core` 本身很小 | Starter 打包一组依赖 |
| 编程模型 | 回调式 Future、Event Bus、Verticle | 注解 + 同步 / Reactor 两套 |
| 启动 | 毫秒到百毫秒级，几乎没有反射扫描 | 秒级，取决于 Bean 数量 |

这带来两个直接后果：**一是轻**，没有容器、没有类路径扫描，启动快、内存占用小，非常适合网关、协议接入、边车之类的基础设施组件；**二是要自己做架构**，分层、配置、事务边界、异常约定都要团队自行约定，否则代码很容易退化成层层嵌套的回调面条。

### 2、核心概念速览

| 概念 | 作用 | 详见 |
|------|------|------|
| `Vertx` | 整个运行时的入口，持有 Event Loop 线程组、Worker 池、Event Bus、定时器 | [Event Loop 与 Verticle](./2_core) |
| Event Loop | 处理 IO 事件与回调的线程，**绝不能阻塞** | [Event Loop 与 Verticle](./2_core) |
| Verticle | 部署单元，类似 Actor：一个实例的所有回调总在同一个线程上执行 | [Event Loop 与 Verticle](./2_core) |
| `Future` / `Promise` | 异步结果的读端与写端，Vert.x 5 唯一的异步 API 形式 | [Event Loop 与 Verticle](./2_core) |
| Event Bus | 进程内 / 集群内的消息总线，Verticle 之间解耦通信 | [Event Bus](./3_eventbus) |
| Router | Vert.x Web 的路由器，把 HTTP 请求分派给 Handler 链 | [Vert.x Web 与 HTTP 客户端](./4_web) |
| Pool | 响应式 SQL 客户端的连接池 | [响应式数据访问](./5_data) |
| Cluster Manager | 集群成员发现与共享数据的 SPI 实现 | [集群与生产实践](./6_production) |

### 3、技术栈分层

![Vert.x 技术栈分层](../assets/vertx/vertx-stack.svg)

- **Netty 层**：Vert.x Core 的网络 IO 全部由 Netty 承担，包括 NIO / epoll / kqueue / io_uring 传输。Netty 的 Reactor、Pipeline、ByteBuf 原理见 [Netty 总览](/netty/0_overview)，这里不再展开。
- **Vert.x Core**：在 Netty 之上加了一层「执行上下文（Context）」的抽象，把网络事件、定时器、Event Bus 消息、异步结果的回调统一调度到正确的线程上，并提供 HTTP/1.x、HTTP/2、HTTP/3、TCP、UDP、DNS、文件系统等 API。
- **生态模块**：Web、各类数据库客户端、消息客户端、认证、配置、健康检查、指标等都是独立 jar，按需引入。
- **上层**：Quarkus 的反应式核心直接使用 Vert.x（官方文档原话为「Quarkus uses Vert.x underneath」），所以学 Vert.x 也就理解了 Quarkus 的线程模型。

---

## 二、与 Netty 的关系

Vert.x 不是另一个网络框架，它是 **Netty 的使用者**。二者的分工：

| 关注点 | 直接用 Netty | 用 Vert.x |
|--------|--------------|-----------|
| 线程模型 | 自己组 `bossGroup` / `workerGroup`，自己决定业务线程池 | Event Loop + Worker 池 + 虚拟线程，已经规定好 |
| 协议实现 | 自己写或组合 Codec | HTTP / WebSocket / gRPC / MQTT 等开箱即用 |
| 异步结果 | `ChannelFuture`，只覆盖 IO 操作 | 全 API 统一 `Future<T>`，可组合 |
| 内存管理 | 自己负责 `ByteBuf` 引用计数 | `Buffer` 封装掉了引用计数，几乎不会泄漏 |
| 适用 | 私有二进制协议、极致性能、要求控制每个字节 | 绝大多数基于标准协议的服务端 |

经验法则：**私有 TCP 协议网关、需要精细控制内存与背压的场景直接用 Netty**（参考 [自定义私有协议](/netty/8_custom_protocol)）；**HTTP / WebSocket / 数据库访问为主的业务服务用 Vert.x**，可以省掉大量样板代码。Vert.x 5 把 Netty 相关的方法挪到了内部 API（如 `BufferInternal`、`VertxInternal#nettyEventLoopGroup()`），业务代码不应再直接摸 Netty 对象。

---

## 三、Vert.x 5 的关键变化

Vert.x 5 是一次大版本清理，截至 2026 年 10 月最新稳定版为 5.2.1（5.1 引入 HTTP/3 与 QUIC，5.2 增加 HTTP `QUERY` 方法、gRPC over Event Bus 流式调用等）。4.5.x 线仍在发布维护补丁，但新项目应直接上 5.x。

### 1、只保留 Future 模型

4.x 同时提供回调（`Handler<AsyncResult<T>>`）与 Future 两套 API，**5.x 删除了所有回调重载，只保留 Future**：

```java
// Vert.x 4（5 中已删除）
server.listen(8080, ar -> {
  if (ar.succeeded()) { /* ... */ }
});

// Vert.x 5
server.listen(8080)
    .onSuccess(s -> log.info("listening on {}", s.actualPort()))
    .onFailure(err -> log.error("listen failed", err));
```

迁移 4.x 代码时，凡是最后一个参数是 `Handler<AsyncResult<...>>` 的调用都要改写；Kotlin 的 `*Await` 扩展也被删除，统一改用 `coAwait()`。

### 2、VerticleBase 与 Deployable

新增 `VerticleBase`，`start()` / `stop()` 直接返回 `Future<?>`，不再需要手动完成 `Promise`：

```java
import io.vertx.core.Future;
import io.vertx.core.VerticleBase;

public class HttpVerticle extends VerticleBase {

  @Override
  public Future<?> start() {
    return vertx.createHttpServer()
        .requestHandler(req -> req.response().end("hello"))
        .listen(8080);
  }
}
```

`VerticleBase` 实现了新的函数式接口 `Deployable`，旧的 `Verticle` 接口也继承自它；`AbstractVerticle` 仍然保留且未废弃。

### 3、其他重要变化

| 变化 | 4.x 写法 | 5.x 写法 |
|------|----------|----------|
| 创建实例 / 集群 / 指标 / 链路 | `Vertx.clusteredVertx(options)`、`options.setMetricsOptions(...)` 里塞注册表 | `Vertx.builder().withClusterManager(..).withMetrics(..).withTracer(..)` |
| Worker Verticle | `DeploymentOptions#setWorker(true)` | `setThreadingModel(ThreadingModel.WORKER)` |
| 阻塞代码 | `executeBlocking(promise -> ...)` | `executeBlocking(() -> result)`，参数是 `Callable` |
| 组合 Future | `CompositeFuture.all(...)` | `Future.all(...)` |
| 同步风格 | Vert.x Sync（Quasar 字节码增强） | 已删除，改用虚拟线程 Verticle + `Future.await()` |
| 命令行 | `vertx run` CLI、`io.vertx.core.Launcher` | CLI 删除；Launcher 废弃，由 `VertxApplication` 取代（预览） |
| SQL 连接池 | `PgPool.pool(...)` | `PgBuilder.pool().with(..).connectingTo(..).using(vertx).build()`，返回通用 `Pool` |
| 日志 | `io.vertx.core.logging.Logger` | 废弃，直接用 SLF4J 或 Log4j 2 |
| 最低 JDK | 8 | 11（虚拟线程能力需要 21） |

新能力方面：io_uring 随 Netty 4.2 开箱可用、HTTP 客户端支持客户端负载均衡、新增 Service Resolver、大部分模块支持 JPMS、HTTP 服务端与客户端支持优雅关闭。

被标记为「日落」（5.x 仍可用、6.x 移除）的模块：gRPC Netty、旧版 JDBC API（`vertx-jdbc-client` 中基于 SQL Client API 的实现不受影响）、Service Discovery、RxJava 2、OpenTracing、Vert.x Unit。新项目不要再选它们。

---

## 四、与 WebFlux、Netty、Quarkus 对比

| 维度 | Vert.x | Spring WebFlux | Quarkus | 裸 Netty |
|------|--------|----------------|---------|----------|
| 本质 | 工具包 | Spring 的响应式 Web 栈 | 完整框架（构建期优化） | 网络库 |
| 底层 | Netty | 默认 Reactor Netty | Vert.x（进而 Netty） | NIO / native |
| 异步抽象 | `Future<T>`，回调式组合 | `Mono` / `Flux`，带背压的 Reactive Streams | Mutiny `Uni` / `Multi`，也可写阻塞代码 | `ChannelFuture` |
| 依赖注入 | 无 | Spring IoC | ArC（CDI，构建期生成） | 无 |
| 阻塞代码 | Worker / 虚拟线程 Verticle | `boundedElastic` 调度器 | `@Blocking`、虚拟线程 | 自己切线程池 |
| 学习成本 | 中：API 少，但要自己定架构 | 高：Reactor 操作符与调试 | 中：熟悉 Spring 的人上手快 | 高 |
| 生态 | 官方模块覆盖面广，第三方少 | Spring 生态全量可用 | Quarkus 扩展生态 | 几乎没有 |
| 典型场景 | 网关、IoT 接入、实时推送、轻量微服务 | 已在 Spring 体系内的高并发服务 | 云原生微服务、Native 镜像 | 私有协议、中间件 |

几个容易混淆的点：

- **Vert.x 的 Future 没有背压**：`Future` 只表示单个结果。流式数据用 `ReadStream` / `WriteStream` 的 `pause()` / `resume()` 与 `pipeTo()` 做流控，概念上弱于 Reactive Streams 的 `request(n)`。需要复杂流处理时，可以用 Vert.x 的 RxJava 3 或 Mutiny 绑定。WebFlux 的背压与操作符见 [WebFlux](/spring/8_webflux)。
- **Quarkus 不是 Vert.x 的竞争者，而是上层**：Quarkus REST、反应式路由、反应式数据源都跑在 Vert.x 的 Event Loop 上，在 Quarkus 里可以直接注入 `Vertx` 实例使用原生 API。
- **虚拟线程改变了权衡**：JDK 21 以后，「为了高并发必须写响应式代码」的理由大幅减弱，见 [虚拟线程](/java/30_topic_virtual_thread)。Vert.x 的价值更多落在「轻量 + 协议丰富 + 事件驱动模型」上，而不只是「非阻塞」。

---

## 五、什么时候用 Vert.x

### 1、适合的场景

- **连接密集型服务**：WebSocket / SSE 推送、IoT 设备长连接、MQTT 接入，单机几十万连接时 Event Loop 模型的内存优势明显。
- **网关与代理**：HTTP 反向代理、协议转换（HTTP ↔ gRPC ↔ Event Bus），Vert.x 自带 HTTP Proxy 模块。
- **对启动时间和内存敏感的组件**：Sidecar、Serverless 函数、命令行工具。
- **事件驱动的内部系统**：用 Event Bus 把采集、计算、推送拆成多个 Verticle，单进程起步，需要时再集群化。

### 2、不太适合的场景

- **CRUD 为主的业务系统**：Spring Boot + 虚拟线程的开发效率与生态更好，团队招聘也更容易。
- **重度依赖阻塞 SDK**：大量 JDBC、老旧 SOAP / 文件 SDK，全部塞进 `executeBlocking` 就失去了 Vert.x 的意义。
- **团队没有异步编程经验**：最常见的事故是在 Event Loop 上调用了阻塞方法，或者 Future 链中漏掉错误处理导致请求永远不返回。

### 3、选型建议

| 现状 | 建议 |
|------|------|
| 已是 Spring 体系，需要高并发 | Spring Boot + 虚拟线程优先，确有需要再上 WebFlux |
| 新建云原生微服务，看重启动与镜像体积 | Quarkus（它已经替你用好了 Vert.x），见 [Quarkus 总览](/quarkus/0_overview) |
| 网关、推送、IoT 接入等基础设施组件 | Vert.x |
| 私有二进制协议、中间件开发 | Netty |

---

## 六、最小可运行示例

Maven 依赖（用 BOM 管理版本）：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.vertx</groupId>
      <artifactId>vertx-stack-depchain</artifactId>
      <version>5.2.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>io.vertx</groupId>
    <artifactId>vertx-web</artifactId>
  </dependency>
</dependencies>
```

```java
import io.vertx.core.DeploymentOptions;
import io.vertx.core.Future;
import io.vertx.core.VerticleBase;
import io.vertx.core.Vertx;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Router;

public class MainVerticle extends VerticleBase {

  @Override
  public Future<?> start() {
    Router router = Router.router(vertx);
    router.get("/hello/:name").handler(ctx ->
        ctx.json(new JsonObject().put("hello", ctx.pathParam("name"))));

    return vertx.createHttpServer()
        .requestHandler(router)
        .listen(config().getInteger("http.port", 8080));
  }

  public static void main(String[] args) {
    Vertx vertx = Vertx.vertx();
    vertx.deployVerticle(MainVerticle::new,
            new DeploymentOptions().setInstances(Runtime.getRuntime().availableProcessors()))
        .onSuccess(id -> System.out.println("deployed " + id))
        .onFailure(err -> {
          err.printStackTrace();
          vertx.close();
        });
  }
}
```

注意三点：

1. `deployVerticle` 传 `Supplier`（`MainVerticle::new`）才能部署多实例，同一个实例对象不能部署两次；
2. 多个实例监听同一端口不会报 `BindException`，Vert.x 只绑定一次 socket，再把连接轮询分给各实例，这是 Vert.x 利用多核的标准方式；
3. 部署失败要关闭 `Vertx`，否则 Event Loop 是非守护线程，进程不会退出。

---

## 小结

- Vert.x 是建立在 Netty 之上的事件驱动工具包：提供运行时与协议能力，不提供 IoC 与应用结构，轻量但需要团队自己定架构
- 核心抽象：Event Loop（不能阻塞）、Verticle（单线程语义的部署单元）、Future（唯一异步形式）、Event Bus（解耦通信）
- Vert.x 5 删除回调 API 只保留 Future，新增 `VerticleBase`、`Vertx.builder()`，`executeBlocking` 改收 `Callable`，Vert.x Sync 由虚拟线程取代，最低 JDK 11
- 与 Netty 是上下层关系，与 Quarkus 也是上下层关系（Quarkus 底层用 Vert.x），与 WebFlux 是同层竞品
- 连接密集、网关、IoT、实时推送用 Vert.x；CRUD 业务优先 Spring Boot + 虚拟线程；私有协议直接用 Netty

> 下一篇：[Event Loop 与 Verticle](./2_core) —— 理解多 Reactor 线程模型、黄金法则与 Future 组合，这是写对 Vert.x 代码的基础。

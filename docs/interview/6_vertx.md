---
description: 黄金法则、三种 Verticle、Future、Event Bus 语义、Vert.x Web、响应式数据、集群与生产
---

# Vert.x 面试题解答

> 题目清单见 [Vert.x 面试题](/vertx/99_interview)；细节见 [Vert.x 总览](/vertx/0_overview)。
>
> 版本基线：Vert.x 5.2、JDK 21 / 25。

## 一、核心模型

### Q1：Vert.x 是什么？和 Netty、WebFlux、Quarkus 是什么关系？

**一句话**：Vert.x 是建立在 Netty 之上的事件驱动、非阻塞工具包，补齐了 HTTP、路由、响应式数据库客户端、集群等能力，但不带依赖注入，也不规定应用结构。

- 工具包不是框架：你的代码调用它，自己写 `main()`，启动快、内存小，但分层和约定要团队自己定
- 与 Netty 是上下层：Netty 给 Channel 和 ByteBuf，Vert.x 给 Router 和 Pool，`Buffer` 封装掉了引用计数
- 与 Quarkus 也是上下层：Quarkus 的 HTTP 层和响应式客户端就跑在 Vert.x 的 Event Loop 上
- 与 WebFlux 是同层竞品：Vert.x 的 `Future` 只表示单个结果、没有背压，流式数据靠 `pause()` / `resume()` / `pipeTo()`
- Vert.x 5：删除回调 API 只保留 Future，新增 `VerticleBase`、`Vertx.builder()`、虚拟线程 Verticle

**常见坑**：CRUD 为主的业务系统用 Spring Boot + 虚拟线程更合适；Vert.x 更适合网关、IoT 接入、实时推送这类连接密集的组件。

→ 详见 [Vert.x 概览](/vertx/1_basics#四、与-webflux、netty、quarkus-对比)

### Q2：Vert.x 的线程模型是怎样的？什么是黄金法则？

**一句话**：每个 `Vertx` 实例有多个 Event Loop（默认 2 × CPU 核数，官方叫 Multi-Reactor），同一个 Verticle 实例的回调永远在同一个线程上执行；黄金法则是「永远不要阻塞 Event Loop」，因为一个线程要服务成百上千个连接。

- 单线程语义：Verticle 里的字段不用加锁，但多个实例之间不共享字段，全局状态用 `SharedData` 或外部存储
- 常见隐性阻塞：同步 JDBC、`Thread.sleep()`、`future.get()` / `join()`、`synchronized` 锁等待、同步日志、大 JSON 序列化
- 阻塞线程检查器：Event Loop 单次执行超过 2 秒（默认）告警 `has been blocked for`，只告警不打断
- 生产建议把 Event Loop 阈值调到 100–200 ms，压测阶段就能暴露大部分隐性阻塞

→ 详见 [Event Loop 与 Verticle](/vertx/2_core#_2、黄金法则-永远不要阻塞-event-loop)

### Q3：三种 Verticle 有什么区别？阻塞代码应该放在哪里？

**一句话**：Verticle 是部署单元，Vert.x 5 用 `ThreadingModel` 决定它跑在哪类线程上：标准 Verticle 跑 Event Loop 不能阻塞，Worker 和虚拟线程 Verticle 可以阻塞。

| 类型 | 执行线程 | 用途 |
|------|----------|------|
| `EVENT_LOOP`（默认） | 固定的 Event Loop | HTTP 服务、协议处理 |
| `WORKER` | Worker 池，同一时刻只有一个线程执行该实例 | 包装阻塞 SDK |
| `VIRTUAL_THREAD` | 虚拟线程（JDK 21+） | 用 `await()` 同步风格编排下游调用 |

- 零散阻塞调用用 `executeBlocking(() -> ...)`：在 Worker 线程执行，结果回到原 Context 回调
- Worker 池默认只有 20 个线程且全局共享，不同阻塞任务用命名 `WorkerExecutor` 隔离

**常见坑**：`executeBlocking` 默认 `ordered=true`，同一 Context 上串行执行，独立任务要传 `false`；`await()` 在 Event Loop 上调用会抛 `IllegalStateException`。

→ 详见 [Event Loop 与 Verticle](/vertx/2_core#二、三种-verticle)

### Q4：Vert.x 的 Future 怎么组合？错误处理有哪些坑？

**一句话**：`compose` 串行接异步操作、`map` 做同步转换、`Future.all / any / join` 做并发组合；最大的坑是链尾不处理失败，请求会静默挂起。

- `Promise` 是写端、`Future` 是读端，对外 API 只暴露 `Future`
- `Future.all` 任一失败立即失败，`join` 等全部完成再判定；要部分结果就先给每个 Future 加 `otherwise(默认值)`
- `recover` 失败时换一个 Future 兜底，`timeout` 超时转失败，`eventually` 无论成败都做清理
- 回调里抛出的异常不会自动变成失败的 Future，而是交给全局异常处理器，务必设置

**常见坑**：在 `map` 里做 IO 会得到 `Future<Future<T>>`；HTTP 场景统一在链尾 `.onFailure(ctx::fail)`。

→ 详见 [Event Loop 与 Verticle](/vertx/2_core#四、future-与-promise)

## 二、Event Bus 与 Web

### Q5：Event Bus 有哪几种通信模式？request 要注意什么？

**一句话**：地址就是一个字符串，`send` 点对点（多个 consumer 时轮询投给一个）、`publish` 广播给所有 consumer、`request` 是请求响应，consumer 在注册它的 Context 上执行，同样不能阻塞。

- `send` 的轮询就是内建负载均衡：消费型 Verticle 部署 4 个实例，消息自动分摊
- `request` 默认超时 30 秒，对同步调用链太长，要按下游 SLA 设 `setSendTimeout`
- 失败分四类：`TIMEOUT`、`NO_HANDLERS`（地址上没人）、`RECIPIENT_FAILURE`（对方调了 `msg.fail`）、`ERROR`，对 `RECIPIENT_FAILURE` 不要无脑重试
- 服务端每条异步分支都必须 `reply` 或 `fail`，否则调用方只能等超时
- 消息默认用 `JsonObject`；自定义类型实现 `MessageCodec`，`transform` 决定本地投递是否拷贝

**常见坑**：拦截器忘记调用 `next()`，消息会静默消失。

→ 详见 [Event Bus](/vertx/3_eventbus#二、三种通信模式)

### Q6：Event Bus 的投递语义是什么？什么时候必须换成消息队列？

**一句话**：尽力而为、至多一次：消息只在内存中流转，没有持久化、没有确认重传，所以资金和状态变更类事件必须落 Kafka 这类持久化消息队列。

- 地址上暂时没有 consumer：`send` / `publish` 直接丢弃，`request` 立即以 `NO_HANDLERS` 失败
- 接收节点崩溃、进程重启、consumer 抛异常，消息都会丢且不重投
- 官方建议 consumer 幂等、发送方故障后重试，相当于在业务层做成至少一次
- 顺序：同一发送方到同一 consumer 有序，但 `send` 跨 consumer 无序；要按 key 有序就把 key 哈希到不同地址，每个地址只部署一个 consumer

| 需求 | Event Bus | Kafka / RocketMQ |
|------|-----------|------------------|
| 进程内解耦、节点间低延迟调用 | 合适 | 过重 |
| 消息不能丢、回放、削峰 | 不合适 | 合适 |

→ 详见 [Event Bus](/vertx/3_eventbus#五、投递语义)

### Q7：Vert.x Web 的 Handler 链是怎么工作的？为什么请求会一直挂着？

**一句话**：`Router` 按注册顺序匹配 Route，Handler 之间通过 `RoutingContext` 传数据；每个 Handler 必须写响应、调用 `ctx.next()` 或 `ctx.fail()` 三选一，都没做请求就会挂起。

- `BodyHandler` 默认上限 10 MB，要按接口收紧，并挂在所有读 body 的 Handler 之前
- `blockingHandler` 默认串行，独立任务传 `false`，更好的做法是放到虚拟线程 Verticle
- 认证用 `JWTAuthHandler`（失败 401），授权用 `AuthorizationHandler`（权限不足 403）
- 统一错误：`failureHandler` 管 Route 内的失败，`errorHandler(404)` 管路由级失败（无匹配、方法不允许）

**常见坑**：异步回调里抛的异常不会进 `failureHandler`，既没响应也没日志，Future 链必须显式 `.onFailure(ctx::fail)`，再配一个 `TimeoutHandler` 兜底。

→ 详见 [Vert.x Web 与 HTTP 客户端](/vertx/4_web#一、router-与-handler-链)

### Q8：WebClient 调用下游有哪些坑？

**一句话**：三个默认值最容易出事：每个目标只有 5 个连接、等待队列无界、不加 `expecting` 时 4xx / 5xx 也算成功。

- WebClient 在 Verticle 启动时创建一次复用，每次请求新建会导致连接无法复用
- 按下游容量设 `http1MaxSize` 与 `maxWaitQueueSize`，否则下游一慢请求就在队列里无限堆积直到 OOM
- `.expecting(HttpResponseExpectation.SC_SUCCESS)` 把非 2xx 转成失败，从 RestTemplate、Feign 迁过来的人最容易漏
- `timeout` 同时设置连接超时和空闲超时；熔断用 `CircuitBreaker`，重试只用于幂等接口
- 客户端负载均衡支持轮询、最少请求、一致性哈希等，默认只用 DNS 解析出的第一个 IP

→ 详见 [Vert.x Web 与 HTTP 客户端](/vertx/4_web#六、webclient)

## 三、数据访问、集群与生产

### Q9：Vert.x 为什么要用响应式 SQL 客户端？连接池要注意什么？

**一句话**：JDBC 是同步 API，放在 Event Loop 上会拖住整个线程，包进 `executeBlocking` 又让吞吐受限于 Worker 池；Vert.x 的 SQL 客户端自己实现数据库网络协议，发出查询立即返回，结果到达时回到原 Context。

- 代价：放弃 JDBC、HikariCP、MyBatis、JPA 生态（ORM 可用 Hibernate Reactive），数据库本身也不会更快
- 默认值偏危险：`maxSize` 4、等待队列无界、获取连接超时 30 秒，生产都要显式调整
- 多个 Verticle 实例用 `setShared(true)` 加同名共享一个池，否则连接数 = 实例数 × maxSize
- 永远用 `preparedQuery` + `Tuple` 传参；批量用 `executeBatch`；大结果集在事务内用游标流并处理背压
- 只有从池里借出的连接上并发发出的语句才会流水线（PG 默认 256），直接在 `Pool` 上执行不会

**常见坑**：16 个实例各建一个 `maxSize=20` 的池，单机 320 个连接，扩到 10 台直接打满数据库。

→ 详见 [响应式数据访问](/vertx/5_data#二、pool-api)

### Q10：响应式客户端的事务怎么写？Kafka 消费怎么保证不丢？

**一句话**：`pool.withTransaction` 按返回的 Future 成败决定提交或回滚，事务边界完全由代码结构决定；Kafka 消费关闭自动提交、处理成功再提交具体 offset，得到至少一次语义。

- 事务内只能用传入的 `client`，用 `pool` 执行的语句在另一个连接上，不在事务里
- 所有操作必须用 `compose` 串进同一条链，漏掉的异步操作会让事务提前提交
- 事务里不要调外部 HTTP，下游变慢会长时间占住连接和行锁
- Kafka：处理前 `pause()`、处理完 `resume()` 形成背压；无参 `commit()` 会提交整批，逐条处理要提交 `offset + 1`，消费逻辑必须幂等

**常见坑**：响应式客户端没有 Spring 那样的声明式事务和传播行为，手动 `begin` 后漏掉 `close()` 会泄漏连接。

→ 详见 [响应式数据访问](/vertx/5_data#四、事务)、[Kafka 客户端](/vertx/5_data#六、kafka-客户端)

### Q11：Vert.x 集群是怎么组成的？在 Kubernetes 上要注意什么？

**一句话**：集群 = Cluster Manager（成员发现、「地址 → 节点」订阅表、共享数据）+ 节点间 TCP 直连的 Event Bus，消息本身不经 Cluster Manager 中转；官方实现有 Hazelcast、Infinispan、Ignite。

- Vert.x 5 用 `Vertx.builder().withClusterManager(...).buildClustered()` 创建
- 成员发现：关掉 multicast，用 Hazelcast 的 Kubernetes 发现 + Headless Service
- 地址宣告：用 Downward API 注入 `POD_IP`，设置 Event Bus 的 `host` 和 `clusterPublicHost`，否则可能宣告 `localhost` 导致节点间消息不通
- consumer 集群注册要等 `completion()` 完成再接流量，否则发布后偶发 `NO_HANDLERS`
- 要不要上集群：服务间调用优先 HTTP / gRPC，集群 Event Bus 适合节点间广播（如 WebSocket 按用户推送）

→ 详见 [集群与生产实践](/vertx/6_production#一、集群)

### Q12：Vert.x 服务上生产要做哪些事？线上最常见的问题有哪些？

**一句话**：监控看 Worker 池 / 连接池排队和阻塞线程告警，健康检查区分存活与就绪，停机时 `stop()` 里 `server.shutdown()` 等在途请求完成。

- 指标：`MicrometerMetricsOptions` 开启，重点看 `vertx_pool_*` 排队和 `vertx_eventbus_pending` 积压；路由标签只用路径模板
- 链路：`withTracer` 接入 OpenTelemetry，必须配置 SDK，否则 trace ID 全为 0
- 存活探针不查数据库，否则数据库抖动会让 Kubernetes 重启所有 Pod
- 测试：vertx-junit5 中断言必须包在 `ctx.verify(...)` 里，否则只会等到超时

| 现象 | 根因 |
|------|------|
| 偶发全体变慢 | Event Loop 上有阻塞调用 |
| 请求挂起没日志 | Future 链没处理失败 |
| 下游变慢后 OOM | 连接池 / WebClient 等待队列无界 |

→ 详见 [集群与生产实践](/vertx/6_production#七、常见坑)

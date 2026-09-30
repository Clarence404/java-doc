# 开发总结 - Spring Cloud

> 精华提炼，细节详见 [Spring Cloud](/spring-cloud/0_overview) / [微服务](/microservices/0_overview)

## 一、Spring Cloud 的核心组件有哪些？如何选型？

| 能力 | Netflix 老一代（多已停更）| 当前主流 |
|------|------------------------|---------|
| 注册发现 | Eureka | **Nacos** / Consul |
| 配置中心 | Spring Cloud Config | **Nacos Config** / Apollo |
| 网关 | Zuul 1.x | **Spring Cloud Gateway** |
| 服务调用 | Feign | **OpenFeign** |
| 负载均衡 | Ribbon | **Spring Cloud LoadBalancer** |
| 熔断限流 | Hystrix | **Sentinel** / Resilience4j |
| 分布式事务 | — | **Seata** |
| 链路追踪 | Sleuth + Zipkin | **Micrometer Tracing** / SkyWalking / OpenTelemetry |

Spring Cloud 2020.0 起已移除 Ribbon、Hystrix、Zuul；国内项目常用 **Spring Cloud Alibaba**（Nacos + Sentinel + Seata）+ Spring Cloud 官方的 Gateway / OpenFeign / LoadBalancer 组合。选型时注意 Spring Boot、Spring Cloud、Spring Cloud Alibaba 三者的**版本对应关系**。

详见：<RouteLink to="/spring-cloud/0_overview">Spring Cloud 总览</RouteLink> / <RouteLink to="/spring-cloud/6_alibaba">Spring Cloud Alibaba</RouteLink>

## 二、注册中心如何选型？Eureka、Nacos、Consul、ZooKeeper 有什么区别？

| 对比项 | Eureka | Nacos | Consul | ZooKeeper |
|--------|--------|-------|--------|-----------|
| CAP | **AP** | **AP + CP 可切换** | CP（Raft）| CP（ZAB）|
| 健康检查 | 客户端心跳 | 心跳 / 长连接（临时实例）、服务端主动探测（持久实例）| 服务端主动探测（HTTP/TCP/脚本）| 临时节点 + 会话 |
| 配置中心 | ❌ | ✅ | ✅ KV | 勉强可用 |
| 变更通知 | 客户端定时拉取（30s）| 服务端推送 | Long Polling / Watch | Watch |
| 维护状态 | 2.x 停止开发 | 活跃 | 活跃 | 活跃 |
| 典型场景 | 老项目 | 国内 Spring Cloud 首选 | 多语言、跨数据中心 | Dubbo 老项目、Kafka 旧版 |

**注册中心为什么更适合 AP**：注册中心短暂不一致（多拿到一个已下线实例）可以通过客户端重试 / 熔断兜底；但如果为了强一致在选主期间**拒绝服务**，所有服务都无法发现彼此，影响面更大。ZooKeeper 选主期间不可用就是它不适合做注册中心的主要原因。

详见：<RouteLink to="/spring-cloud/1_service_registry">服务注册与发现</RouteLink>

## 三、Nacos 注册中心的原理要点？

**两类实例，两套一致性协议**：

| 实例类型 | 配置 | 一致性协议 | 健康检查 | 宕机后 |
|---------|------|----------|---------|--------|
| **临时实例（默认）** | `ephemeral=true` | **Distro（AP）**：各节点负责部分数据，异步复制 | 1.x 客户端 5s 心跳；2.x gRPC 长连接存活即健康 | 1.x 15s 标记不健康、30s 剔除；2.x 连接断开即剔除 |
| 持久实例 | `ephemeral=false` | **Raft（CP，JRaft）** | 服务端主动探测（TCP/HTTP）| 标记不健康但**不删除** |

**关键机制**：

- **服务发现**：客户端订阅服务后，服务端变更时**主动推送**（1.x UDP 推送 + 定时拉取兜底；2.x 基于 gRPC 双向流推送）
- **本地缓存与容灾**：客户端缓存服务列表并落盘（failover 目录），Nacos Server 全挂时仍可使用旧列表调用
- **保护阈值**：健康实例比例低于阈值时，把不健康实例也返回给调用方，防止流量全部压到少数健康实例上导致雪崩
- **数据模型**：`Namespace`（环境隔离）→ `Group` → `Service` → `Cluster` → `Instance`

详见：<RouteLink to="/spring-cloud/1_service_registry">Nacos 健康检查与 AP/CP 切换</RouteLink>

## 四、API 网关的作用是什么？Spring Cloud Gateway 的原理？

**网关职责**：统一入口、路由转发、鉴权（JWT）、限流、跨域、灰度发布、协议转换、日志与监控。把横切能力从各微服务中剥离。

**三个核心概念**：

| 概念 | 含义 | 示例 |
|------|------|------|
| **Route** | 路由：ID + 目标 URI + 断言集合 + 过滤器集合 | `uri: lb://order-service` |
| **Predicate** | 断言：决定请求是否匹配该路由 | `Path=/order/**`、`Header`、`Method`、`Weight` |
| **Filter** | 过滤器：请求前后修改请求/响应 | `StripPrefix`、`RequestRateLimiter`、自定义 `GlobalFilter` |

**请求处理流程**：

1. Reactor Netty 接收请求 → WebFlux `DispatcherHandler`
2. **`RoutePredicateHandlerMapping`** 遍历路由，用 Predicate 匹配出目标 Route
3. **`FilteringWebHandler`** 把 `GlobalFilter` 与该路由的 `GatewayFilter` 合并按 `Order` 排序，组成过滤器链
4. 执行 "pre" 逻辑（鉴权、限流、加 Header）→ `ReactiveLoadBalancerClientFilter` 把 `lb://` 解析为具体实例 → `NettyRoutingFilter` 转发到下游
5. 响应返回，逆序执行 "post" 逻辑

**为什么基于 WebFlux**：网关是典型 IO 密集型、高并发场景，非阻塞模型用少量线程支撑大量连接。**过滤器中禁止写阻塞代码**（如同步调 Redis / JDBC），否则会阻塞 EventLoop 线程拖垮整个网关；也不能和 `spring-boot-starter-web` 混用（需要 Servlet 栈时使用新版的 Gateway Server MVC）。

详见：<RouteLink to="/spring-cloud/2_api_gateway">API 网关</RouteLink>

## 五、OpenFeign 的工作原理？

**启动阶段**：

1. `@EnableFeignClients` 导入 `FeignClientsRegistrar`（`ImportBeanDefinitionRegistrar`）
2. 扫描 `@FeignClient` 接口，为每个接口注册一个 **`FeignClientFactoryBean`**
3. `getObject()` 时通过 `Feign.Builder` 组装 Contract（`SpringMvcContract` 解析 `@GetMapping` 等注解）、Encoder / Decoder、拦截器，最终用 **JDK 动态代理**生成接口实现
4. 每个 FeignClient 拥有独立的子容器（`NamedContextFactory`），可单独配置超时、日志、拦截器

**调用阶段**：

1. 代理的 `InvocationHandler` 找到方法对应的 `MethodHandler`
2. 根据方法元数据和参数构建 `RequestTemplate`
3. 执行 `RequestInterceptor`（常用于透传 Token、TraceId）
4. `FeignBlockingLoadBalancerClient` 通过 LoadBalancer 把服务名解析为具体实例
5. 底层 HTTP 客户端发请求（默认 `HttpURLConnection`，**生产建议换 OkHttp / Apache HttpClient 5 以使用连接池**）
6. Decoder 反序列化响应；非 2xx 交给 `ErrorDecoder`

**常见坑**：超时默认值不合理需显式配置；GET 传对象需 `@SpringQueryMap`；Feign 重试默认关闭，开启需确保接口幂等。

详见：<RouteLink to="/spring-cloud/3_communication">OpenFeign 声明式调用</RouteLink>

## 六、Spring Cloud LoadBalancer 是怎么做负载均衡的？

- **客户端负载均衡**：调用方从注册中心拿到实例列表，在本地选择实例（区别于 Nginx 这类服务端负载均衡）
- 替代了进入维护模式的 Ribbon，基于 Reactor 实现

**核心组件**：

| 组件 | 作用 |
|------|------|
| `ServiceInstanceListSupplier` | 提供实例列表，可叠加装饰：缓存、健康检查、同 Zone 优先、同实例粘滞、按权重 |
| `ReactorServiceInstanceLoadBalancer` | 选择算法，内置 `RoundRobinLoadBalancer`（默认）、`RandomLoadBalancer` |
| `@LoadBalanced` | 给 `RestTemplate` / `WebClient` 加拦截器，把 `http://service-name` 解析为实例地址 |

**策略对比**：

| 策略 | 特点 |
|------|------|
| 轮询 | 简单均匀，默认 |
| 随机 | 无状态 |
| 加权 | 按机器配置分配 |
| 最少连接 / 最短响应 | 感知负载，需自定义实现 |
| 一致性哈希 | 同一 Key 落同一实例，利于本地缓存 |

**扩展**：实现 `ReactorServiceInstanceLoadBalancer`，按实例元数据（如 `version=gray`）筛选，即可实现**灰度发布**。

详见：<RouteLink to="/spring-cloud/5_service_governance">负载均衡</RouteLink>

## 七、配置中心动态刷新的原理是什么？

**服务端 → 客户端的变更感知**：

| 版本 | 机制 |
|------|------|
| Nacos 1.x | **HTTP 长轮询**：客户端带上配置 MD5 请求，服务端无变更时 hold 约 29.5s，期间有变更立即返回；有变更后客户端再拉取最新内容 |
| Nacos 2.x | **gRPC 长连接**：服务端直接推送变更通知 |
| Apollo | HTTP 长轮询 + 定时拉取兜底 |

**客户端 → Bean 的刷新**：

1. Nacos 客户端收到变更 → 发布 `RefreshEvent`
2. `ContextRefresher` 重新加载 `Environment` 中的 PropertySource，计算变更的 key，发布 `EnvironmentChangeEvent`
3. **`@ConfigurationProperties` Bean**：`ConfigurationPropertiesRebinder` 重新绑定，无需额外注解
4. **`@RefreshScope` Bean**：该作用域 Bean 实际注入的是代理，刷新时**销毁缓存的目标对象**，下次调用时用新配置重新创建

**注意**：`@Value` 需配合 `@RefreshScope` 才会刷新；`@RefreshScope` Bean 重建期间有短暂开销，定时任务 / 连接池等有状态 Bean 慎用。敏感配置应加密存储，配置变更要有灰度和回滚能力。

详见：<RouteLink to="/spring-cloud/4_config_center">配置动态刷新原理</RouteLink>

## 八、Sentinel 限流熔断的原理？

**核心设计：责任链（ProcessorSlotChain）**。每个资源（`@SentinelResource` / URL）进入时依次经过 Slot：

| Slot | 作用 |
|------|------|
| `NodeSelectorSlot` / `ClusterBuilderSlot` | 构建调用树与统计节点 |
| **`StatisticSlot`** | 实时统计 QPS、RT、线程数、异常数 |
| `AuthoritySlot` | 黑白名单 |
| `SystemSlot` | 系统自适应保护（Load、CPU、总 QPS）|
| `ParamFlowSlot` | 热点参数限流 |
| **`FlowSlot`** | 流控规则校验 |
| **`DegradeSlot`** | 熔断规则校验 |

**统计：滑动时间窗口（`LeapArray`）**。默认 1s 切 2 个桶，环形数组复用桶，按当前时间定位桶累加，统计时汇总窗口内有效桶，避免固定窗口边界突刺。

**流控**：

- 维度：QPS / 并发线程数；调用关系：直接、关联、链路
- 效果：**快速失败**（默认）、**Warm Up**（令牌桶预热，冷启动逐步放量）、**排队等待**（漏桶匀速，适合削峰）

**熔断（Sentinel 1.8+）**：

| 策略 | 触发条件 |
|------|---------|
| 慢调用比例 | RT 超阈值的请求比例超过设定值 |
| 异常比例 | 异常请求比例超过设定值 |
| 异常数 | 统计窗口内异常数超过设定值 |

熔断状态同样是 Closed → Open（熔断时长）→ Half-Open（放一个探测请求）→ 成功回 Closed / 失败回 Open。

**生产要点**：规则默认存内存，重启丢失，需接 Nacos 数据源持久化并实现控制台推送；`blockHandler` 处理限流/熔断异常，`fallback` 处理业务异常。

详见：<RouteLink to="/spring-cloud/6_alibaba">Sentinel</RouteLink> / <RouteLink to="/interview/14_high_avail">开发总结 - 高可用</RouteLink>

## 九、Seata AT 模式的原理？

**三个角色**：

| 角色 | 职责 |
|------|------|
| TC（Transaction Coordinator）| 独立部署的 Seata Server，维护全局事务和分支状态、全局锁 |
| TM（Transaction Manager）| 发起方（`@GlobalTransactional`），开启 / 提交 / 回滚全局事务 |
| RM（Resource Manager）| 各服务的数据源代理，注册分支、上报状态、执行分支提交 / 回滚 |

**一阶段（业务 SQL 直接提交）**：

1. 数据源代理解析 SQL，查询修改前数据作为 **before image**
2. 执行业务 SQL，查询修改后数据作为 **after image**
3. 生成 **undo_log** 记录，与业务数据在**同一个本地事务**中写入
4. 提交前向 TC 注册分支并**申请全局锁**（锁定被修改的行）
5. 本地事务提交，释放本地锁

**二阶段**：

- **全局提交**：TC 通知各分支异步删除 undo_log，释放全局锁，非常快
- **全局回滚**：用 after image 与当前数据比对（**校验脏写**，不一致则需人工处理），一致则用 before image 生成反向 SQL 补偿，删除 undo_log

**隔离性**：

- 写隔离：全局锁保证不同全局事务不会同时修改同一行
- 读隔离：默认**读未提交**（其他事务可能读到一阶段已提交但最终回滚的数据）；需要读已提交时用 `SELECT ... FOR UPDATE`（会被代理并检查全局锁）

**四种模式对比**：

| 模式 | 侵入性 | 一致性 | 性能 | 适用 |
|------|-------|-------|------|------|
| **AT** | 无（自动生成回滚）| 最终一致 | 较高 | 大部分关系库业务 |
| TCC | 高（手写 Try/Confirm/Cancel）| 最终一致 | 高 | 核心资金、需要资源预留 |
| Saga | 中（写补偿）| 最终一致 | 高 | 长事务、跨外部系统 |
| XA | 无 | 强一致 | 低（全程持锁）| 强一致要求且并发不高 |

详见：<RouteLink to="/spring-cloud/6_alibaba">Seata</RouteLink> / <RouteLink to="/distributed/4_transaction">分布式事务</RouteLink>

## 十、链路追踪中 traceId 是如何在服务间传递的？

**核心概念**：`traceId`（一次完整请求链路唯一）、`spanId`（链路中的一次调用）、`parentSpanId`（父子关系）。

**传递方式**：

| 场景 | 传递方式 |
|------|---------|
| HTTP / Feign / Gateway | 请求头：W3C `traceparent`（OpenTelemetry / Micrometer 默认）或 B3 `X-B3-TraceId`（Zipkin）|
| 进程内 | `ThreadLocal` 保存当前 Span，同时写入日志 **MDC**，日志模板打印 `%X{traceId}` |
| 线程池 / 异步 | `ThreadLocal` 不会自动传递，需包装：`TransmittableThreadLocal`、Micrometer `ContextSnapshot`、Spring `TaskDecorator` |
| 消息队列 | 生产者把 trace 上下文写入消息 Header，消费者取出续接 |
| RPC（Dubbo / gRPC）| Attachment / Metadata |

**实现方案**：

- **SDK 埋点**：Spring Boot 3 使用 **Micrometer Tracing**（替代 Sleuth），桥接 Brave 或 OpenTelemetry，自动为 Web、Feign、RestTemplate、WebClient 埋点
- **Agent 无侵入**：SkyWalking / OpenTelemetry Java Agent 通过字节码增强自动拦截框架调用

**采样**：全量采集成本高，通常按比例采样（如 10%），错误和慢请求尾部采样全保留。

详见：<RouteLink to="/observability/3_tracing">链路追踪</RouteLink>

## 十一、什么是服务雪崩？如何进行服务治理？

**雪崩过程**：下游服务 C 变慢 → 调用方 B 的线程阻塞等待 → B 的线程池 / 连接池耗尽 → B 也不可用 → 上游 A 跟着被拖垮，故障沿调用链反向扩散。

**常见诱因**：下游故障或慢查询、流量突增、缓存失效击穿 DB、**无限制重试**放大流量、同步长链路调用。

**治理手段**：

| 手段 | 作用 | 实现 |
|------|------|------|
| **超时** | 快速释放线程，每一层都要设置且逐层递减 | Feign / HTTP 客户端超时 |
| **限流** | 保护自己不被打垮 | Sentinel、网关 `RequestRateLimiter` |
| **熔断** | 下游异常时快速失败，停止无效调用，给下游恢复时间 | Sentinel、Resilience4j |
| **降级** | 返回兜底数据，保核心链路 | `fallback`、开关降级 |
| **隔离（舱壁）** | 不同依赖使用独立线程池 / 信号量，故障不串扰 | Resilience4j Bulkhead、Sentinel 并发线程数 |
| **重试（有节制）** | 仅幂等接口，指数退避 + 次数上限 | Spring Retry、Resilience4j Retry |
| **异步化** | 非核心链路走 MQ 解耦 | RocketMQ / Kafka |
| **优雅上下线** | 发布时不丢请求 | 先从注册中心摘除再停机 |

详见：<RouteLink to="/spring-cloud/5_service_governance">服务治理</RouteLink> / <RouteLink to="/interview/14_high_avail">开发总结 - 高可用</RouteLink>

## 十二、Spring Cloud Stream 解决什么问题？

- 在业务代码和具体 MQ 之间加一层 **Binder 抽象**，业务只面向 `Supplier` / `Function` / `Consumer` 函数编程，切换 Kafka / RocketMQ / RabbitMQ 只需换依赖和配置
- 统一了**消费组**（同组竞争消费、不同组广播）、**分区**（保证同 Key 有序）、重试与死信等概念
- 代价：屏蔽了各 MQ 的高级特性（如 RocketMQ 事务消息、Kafka 精细调优），重度使用特定 MQ 能力时直接用原生客户端更合适

详见：<RouteLink to="/spring-cloud/7_stream">Spring Cloud Stream</RouteLink>

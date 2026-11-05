---
description: Nacos、网关、OpenFeign、Sentinel、Seata、Stream、链路追踪、Dubbo、服务网格
---

# 微服务治理面试题解答

> 题目清单见 [微服务治理面试题](/service-governance/99_interview)，模块入口见 [微服务治理总览](/service-governance/0_overview)；拆分、通信、契约等架构题见 [微服务架构面试题解答](/interview/17_microservices)，分布式事务理论见 [分布式基础面试题解答](/interview/16_distributed)。
>
> 版本基线：Spring Boot 4.x、Spring Cloud 2025.1.x、Spring Cloud Alibaba 2025.1.0.0（Nacos 3.x）、Dubbo 3.3、Istio 1.30 / 1.31。

## 一、注册与配置

### Q1：Spring Boot、Spring Cloud、Spring Cloud Alibaba 的版本如何对应？

**一句话**：三者强绑定，必须照官方版本对照表选，并同时引入 Spring Cloud 和 Spring Cloud Alibaba（SCA）两个 BOM（统一管理依赖版本的清单）。

| Spring Boot | Spring Cloud | SCA |
|-------------|--------------|-----|
| 4.0.x | 2025.1.x | 2025.1.0.0（Nacos 3.1.1，取消 bootstrap） |
| 3.5.x | 2025.0.x | 2025.0.0.0 |
| 2.6.x / 2.7.x | 2021.0.x | 2021.0.x（老项目） |

- 每个 Spring Cloud 版本只支持特定的 Boot 版本，SCA 再跟着 Spring Cloud 走
- 升级 Boot 前先确认对应的 Spring Cloud 和 SCA 已经发布；Dubbo 这类非 Spring 组件要单独核对

→ 详见 [微服务治理总览 · Spring Cloud 版本与选型速查](/service-governance/0_overview#三、spring-cloud-版本与选型速查)、[Spring Cloud Alibaba](/service-governance/6_alibaba#一、定位与版本对齐)

### Q2：注册中心如何选型？Nacos、Eureka、Consul、ZooKeeper、Kubernetes 有什么区别？

**一句话**：用 Spring Cloud Alibaba 就选 Nacos（注册和配置一个搞定）；服务全在 K8s 里优先用自带的 Service，少一个中间件；多语言、跨机房选 Consul；Eureka 只维护不更新，新项目不推荐。

| 组件 | 一致性 | 自带配置中心 | 现状 |
|------|-------|------------|------|
| Nacos | 临时实例 AP，持久实例 CP | 有 | 国内主流 |
| Consul | CP | KV 存储 | 适合多数据中心 |
| Kubernetes | 基于 etcd | ConfigMap | 平台原生 |
| Eureka | AP | 无 | 只维护 |
| ZooKeeper | CP | 无 | Dubbo 老项目 |

→ 详见 [注册发现](/service-governance/1_service_registry#二、注册中心对比)

### Q3：注册中心为什么更适合 AP？ZooKeeper 做注册中心有什么问题？

**一句话**：注册中心最重要的是一直能用。数据短暂不准（比如拿到一个刚下线的实例）可以靠重试、熔断兜住；但如果为了数据一致而拒绝注册和查询，所有服务都找不到彼此，影响大得多。

- ZooKeeper 是 CP（优先保证一致）：选主期间整个集群不能用，网络分区时少数派那边也不能用
- 大量服务的临时节点和变更通知，也会给 ZooKeeper 带来很大压力
- 注册中心不在调用路径上，短暂故障时调用方用缓存的列表继续调

→ 详见 [注册发现](/service-governance/1_service_registry#二、注册中心对比)、[分布式理论](/distributed/2_theorem)

### Q4：Nacos 的临时实例和持久实例有什么区别？AP / CP 是由什么决定的？

**一句话**：AP 还是 CP 不是整个集群的开关，而是看每个实例的 `ephemeral` 属性：临时实例（默认）走 AP，持久实例走 CP。

| 对比 | 临时实例（默认） | 持久实例 |
|------|----------------|---------|
| 配置 | `ephemeral: true` | `ephemeral: false` |
| 存储 / 一致性 | 内存，AP | 落盘，CP（Raft） |
| 健康检查 | 看客户端连接是否还在 | 服务端主动探测 |
| 不健康时 | 连接断了就删除 | 只标记不健康，要手动注销 |
| 适合 | 普通微服务 | 数据库等装不了 Nacos 客户端的节点 |

**常见坑**：「按集群切换 AP / CP 模式」是 1.x 的老说法；2.x 起同一个服务里也不能混用两种实例。

→ 详见 [注册发现](/service-governance/1_service_registry#_2、临时实例与持久实例)

### Q5：Nacos 2.x / 3.x 怎么判断实例健康？需要放通哪些端口？

**一句话**：临时实例靠 gRPC 长连接判断健康，连接一断就立刻剔除该连接注册的实例，变更由服务端主动推送；1.x 的「5 秒 HTTP 心跳、15 秒不健康、30 秒剔除」只是历史背景。

- 8848：HTTP（开放接口、老客户端）
- 9848（主端口 + 1000）：客户端 gRPC
- 9849：集群节点之间的 gRPC
- Nacos 3.x 控制台独立端口（默认 8080），与服务端端口分开

**常见坑**：防火墙只开了 8848，2.x 客户端连不上；Nacos 3.x 默认只给控制台和管理 API 开鉴权，客户端 API 鉴权要手动打开，打开后客户端要配用户名和密码。

→ 详见 [注册发现](/service-governance/1_service_registry#_1、连接模型-grpc-长连接)

### Q6：Nacos 的保护阈值是什么？Nacos Server 全挂了服务还能调用吗？

**一句话**：保护阈值是一个 0~1 的比例。健康实例占比低于它时，Nacos 把不健康的实例也一起返回，宁可部分请求失败，也不让所有流量压垮仅剩的几台健康机器。

- Nacos 全挂了，已有服务还能调：客户端在内存和本地磁盘都缓存了服务列表
- 但这时新实例发现不了，下线的实例也剔除不掉
- 避免单点：客户端配多个地址或域名；集群至少 3 个节点、用外部 MySQL

→ 详见 [注册发现](/service-governance/1_service_registry#_3、保护阈值与本地容灾)

### Q7：Spring Cloud Alibaba 2025.1 为什么不再支持 bootstrap？如何用 `spring.config.import` 接入 Nacos？

**一句话**：bootstrap 是 Boot 2.4 之前「先加载远程配置」的老办法，后来被 Boot 自己的 `spring.config.import` 取代；SCA 2025.1 干脆去掉了支持，`bootstrap.yml` 里的配置不会再被读取。

- 接入：在 `application.yml` 里写 `spring.config.import: nacos:order-service.yaml`，可导入多个，后面的优先级高
- 不加 `optional:` 前缀时，Nacos 连不上或配置不存在会直接启动失败，核心配置建议这样，问题早暴露
- 数据源这类不该运行时改的配置，加 `refreshEnabled=false`
- 升级时把 `bootstrap.yml` 里的 Nacos 地址、命名空间等全部搬到 `application.yml`

→ 详见 [配置中心](/service-governance/4_config_center#_1、依赖与-spring-config-import)

### Q8：配置中心动态刷新的原理是什么？Nacos 怎么把变更通知到客户端？

**一句话**：服务端只通知「配置变了」，客户端收到后自己去拉新内容，比对 MD5 确实变了才刷新 Spring 里的配置。

- 刷新过程：发出刷新事件 → 重新加载配置、找出变化的键 → 重新绑定 `@ConfigurationProperties` 类，并销毁 `@RefreshScope` 的 Bean 等待重建
- 2.x / 3.x：客户端与服务端保持 gRPC 长连接，配置变更时服务端主动推送通知
- 背景：1.x 用 HTTP 长轮询（服务端挂住约 30 秒），连接多时服务端压力大，2.x 起被 gRPC 推送取代
- 兜底：客户端定期全量比对 MD5，还会存本地快照，Nacos 不可用时也能靠快照启动

→ 详见 [配置中心](/service-governance/4_config_center#三、动态刷新原理)

### Q9：`@RefreshScope` 的原理是什么？`@Value` 与 `@ConfigurationProperties` 的刷新有什么区别？

**一句话**：`@RefreshScope` 的 Bean 注入的其实是一个代理，刷新时把背后的真实对象扔掉，下次调用再用新配置重建；`@ConfigurationProperties` 不用加 `@RefreshScope`，刷新时直接在原对象上改字段值。

| 对比 | `@ConfigurationProperties` | `@RefreshScope` |
|------|--------------------------|-----------------|
| 刷新方式 | 原对象，字段被覆盖 | 销毁对象，下次调用重建 |
| 副作用 | 按旧配置算好的东西（如建好的线程池）不会变 | 初始化逻辑重新跑，带连接、定时任务的 Bean 会被反复创建 |
| 适合 | 大多数业务参数 | 少数要整体重建的 Bean |

- `@Value` 字段只有所在 Bean 加了 `@RefreshScope` 才会更新
- record 这类构造器绑定的配置类不可变，不会被刷新

→ 详见 [配置中心](/service-governance/4_config_center#_2、读取配置)

## 二、调用与网关

### Q10：OpenFeign 还推荐用吗？HTTP Service Clients 如何接入负载均衡？

**一句话**：OpenFeign 从 2022.0 起只修 bug 不加功能，老项目可以继续用；新项目官方推荐 Spring 自带的 HTTP Service Clients（用 `@HttpExchange` 声明接口）。

- 注册：Framework 7 用 `@ImportHttpServices` 按组注册客户端
- 负载均衡：LoadBalancer 5.0 起自动接入，组没配 `base-url` 时默认 `http://<组名>`，组名就是注册中心里的服务名
- `base-url` 写成普通地址时不走负载均衡，适合调外部 API
- 迁移主要是换注解：`@FeignClient` + `@GetMapping` 改成 `@HttpExchange` + `@GetExchange`

→ 详见 [服务通信](/service-governance/3_communication#二、http-service-clients-推荐)

### Q11：OpenFeign 的工作原理是什么？为什么配置了 fallback 却不生效？

**一句话**：启动时扫描 `@FeignClient` 接口，用 JDK 动态代理生成实现类；调用时把方法上的注解拼成 HTTP 请求，经过拦截器、负载均衡选实例，发出去再把响应转成对象。

- 非 2xx 响应交给 `ErrorDecoder` 处理
- fallback 不生效：只写 `fallback` 不够，必须开启熔断集成
- 用 Resilience4j：引入 circuitbreaker starter，配 `spring.cloud.openfeign.circuitbreaker.enabled: true`
- 用 Sentinel：引入 Sentinel starter，配 `feign.sentinel.enabled: true`

**常见坑**：默认读超时 60 秒，远大于合理值，必须按服务显式配置；写接口的降级不能假装返回成功。

→ 详见 [服务通信](/service-governance/3_communication#_2、降级生效的前提)

### Q12：Spring Cloud LoadBalancer 有哪些内置能力？如何基于它实现灰度路由？

**一句话**：Spring Cloud LoadBalancer 是在调用方本地做负载均衡的组件，取代了已移除的 Ribbon，默认轮询，还能通过配置组合出多种选实例策略。

- 内置：轮询 / 随机、同机房优先、加权、按请求头匹配实例（Hint）、按 API 版本选实例、健康检查
- 简单灰度：请求头和实例元数据等值匹配（如 `X-Version: canary`），直接用 Hint
- 复杂灰度（按用户比例放量、不带标记的请求必须避开灰度实例）：自己实现负载均衡器，从请求上下文读请求头选实例

**常见坑**：灰度标记没有一跳一跳往下传，第二跳之后就回到了稳定版本。

→ 详见 [流量治理](/service-governance/5_traffic_governance#二、负载均衡-spring-cloud-loadbalancer)、[高可用面试题解答](/interview/21_high_avail#q17-服务端负载均衡与客户端负载均衡-spring-cloud-loadbalancer-有什么区别)

### Q13：API 网关的作用是什么？Route、Predicate、Filter 分别是什么，请求如何流转？

**一句话**：网关是统一入口，把鉴权、限流、跨域、灰度、日志这些公共的事集中做掉，内部有哪些服务对外不可见。

- Route（路由）：一条转发规则，包含 ID、目标地址、断言和过滤器
- Predicate（断言）：判断请求能不能命中这条路由，比如看路径、请求头
- Filter（过滤器）：在转发前后加处理，分单条路由的和全局的
- 流转：按顺序匹配路由（命中第一条就停）→ 过滤器链执行转发前逻辑 → 负载均衡选实例并转发 → 响应再倒着经过过滤器链

**常见坑**：WebFlux 版网关跑在少量事件循环线程上，过滤器里同步查 Redis、数据库会卡住整个网关。

→ 详见 [API 网关](/service-governance/2_api_gateway#二、核心概念与请求链路)

### Q14：Gateway Server WebFlux 与 Server MVC 如何选？2025.x 的依赖与配置前缀有何变化？

**一句话**：2025.0 起网关拆成 WebFlux 和 MVC 两个独立版本，2025.1 删掉了旧的 `spring-cloud-starter-gateway`，配置前缀也改了，两者只能选一个。

| 对比 | Server WebFlux | Server MVC |
|------|---------------|-----------|
| 配置前缀 | `spring.cloud.gateway.server.webflux.*` | `spring.cloud.gateway.server.webmvc.*` |
| 运行模型 | 非阻塞（Reactor Netty） | Servlet，可配虚拟线程 |
| 适合 | 高并发入口、功能最全 | 团队不熟响应式、过滤器要调阻塞接口 |

**常见坑**：升级后旧的 `spring.cloud.gateway.routes` 不再生效，路由会悄悄丢失、也不报错；升级后用 actuator 的 `gateway/routes` 端点核对。

→ 详见 [API 网关](/service-governance/2_api_gateway#一、两种形态-server-webflux-与-server-mvc)

### Q15：网关统一鉴权怎么做？如何防止下游收到伪造的用户请求头？

**一句话**：让网关作为 OAuth2 资源服务器，交给 Spring Security 校验 JWT（签名、过期、签发方），不要自己手写解析；校验通过后把用户信息写进请求头传给下游。

- 写之前必须先删掉客户端自带的同名请求头，否则外部可以直接伪造身份
- 下游只信网关加的请求头，前提是下游只能从网关访问（网络隔离）；做不到就把 `Authorization` 原样转发，让下游自己再验一次
- 网关同时作为 OAuth2 客户端时，用 `TokenRelay` 过滤器把令牌转发给下游

→ 详见 [API 网关](/service-governance/2_api_gateway#四、统一鉴权-网关作为-oauth2-资源服务器)、[JWT 令牌机制](/security/1_jwt)

### Q16：网关灰度路由为什么不能用路由 metadata？正确做法是什么？

**一句话**：路由上的 `metadata` 不会传给负载均衡器，所以没法用它选实例。正确做法有两种。

| 做法 | 怎么做 | 特点 |
|------|-------|------|
| 按权重分流 | 灰度版本注册成单独服务名，用 `Weight` 断言按比例分 | 简单，但同一用户可能一会儿新版一会儿旧版 |
| 按请求头选实例 | 新旧实例同名、用实例元数据区分，负载均衡器按请求头选 | 可按用户、标记精确控制 |

- 按请求头选时，实例列表要配 `withDiscoveryClient().withCaching().withHints()`
- 灰度标记必须一跳一跳往下传

→ 详见 [API 网关](/service-governance/2_api_gateway#七、灰度路由)

## 三、服务治理

### Q17：Netflix 组件（Ribbon、Hystrix、Zuul、Sleuth）分别被什么替代？为什么被替换？

**一句话**：2018 年 Netflix 把 Hystrix、Ribbon 等转为只维护，Zuul 1 是阻塞 IO 扛不住高并发，Spring 就换成了自己的实现，2020.0 起移除了 Ribbon、Hystrix、Zuul。

| 原组件 | 替代 |
|--------|------|
| Ribbon | Spring Cloud LoadBalancer |
| Hystrix | Resilience4j、Sentinel |
| Zuul 1 | Spring Cloud Gateway |
| Sleuth（2022.0 起不再发布） | Micrometer Tracing |
| Eureka（还在，只维护） | Nacos、Consul、Kubernetes Service |

- 不是 Netflix 的 OpenFeign 也已功能冻结，新项目用 HTTP Service Clients
- Spring Cloud Config 不是 Netflix 组件，仍在维护

→ 详见 [微服务治理总览 · Spring Cloud 版本与选型速查](/service-governance/0_overview#三、spring-cloud-版本与选型速查)

### Q18：什么是服务雪崩？Spring Cloud 中有哪些治理手段？

**一句话**：下游变慢 → 调用方线程一直等 → 线程池耗尽 → 调用方也挂了 → 故障沿调用链一路往上传，这就是雪崩。

- 超时：每次调用都显式设超时，越往下游越短
- 限流：Sentinel、网关的 `RequestRateLimiter`
- 熔断降级：下游错误多了先「断开」一段时间直接走降级，用 Resilience4j 或 Sentinel
- 隔离：给不同下游分开的线程或并发额度（Resilience4j Bulkhead、Sentinel 并发数）
- 重试：只对幂等接口、只在一层做

→ 详见 [流量治理](/service-governance/5_traffic_governance#一、流量治理全景)、[高可用面试题解答](/interview/21_high_avail#五、熔断)

### Q19：Sentinel 的核心原理（Slot 链、滑动窗口）是什么？

**一句话**：每次访问资源都要穿过一串「关卡」（Slot 链）：前面的关卡负责统计 QPS、响应时间、异常数，后面的关卡拿统计结果检查限流、熔断规则，任何一关不通过就抛 `BlockException`。

- 统计关：`StatisticSlot` 记录 QPS、响应时间、线程数、异常数
- 规则关：黑白名单、系统保护、热点参数限流、流控（`FlowSlot`）、熔断（`DegradeSlot`）
- 滑动窗口：默认把 1 秒分成 2 个 500ms 的小格，环形数组循环复用，统计时把窗口内的格子加起来
- 为什么用滑动窗口：避免固定窗口在两个窗口交界处瞬间放进两倍流量

→ 详见 [Spring Cloud Alibaba · Slot 链：规则是怎么生效的](/service-governance/6_alibaba#_6、slot-链-规则是怎么生效的)、[限流与过载保护](/high-avail/7_rate_limiting#八、sentinel-限流)

### Q20：Sentinel 有哪些流控效果和熔断策略？规则如何持久化？

**一句话**：流控有三种效果：快速失败（默认）、预热（冷启动时慢慢放量）、匀速排队（削峰）；熔断按慢调用比例、异常比例、异常数三种策略触发。

- 熔断状态：关闭（正常）→ 打开（直接拒绝）→ 半开（放少量请求试探，好了就恢复）
- 规则默认只在内存里，重启就丢，生产要持久化到 Nacos；持久化后控制台改的规则为什么还会丢，完整答案见 [高可用面试题解答](/interview/21_high_avail) Q32

→ 详见 [Spring Cloud Alibaba](/service-governance/6_alibaba#_5、规则持久化-nacos-数据源)

### Q21：Framework 7 的 `@Retryable` / `@ConcurrencyLimit` 与 Resilience4j、Sentinel 如何分工？

**一句话**：简单重试和并发限制用 Spring 7 自带的注解，不用加依赖；要熔断用 Resilience4j；要在控制台动态改规则、按参数限流用 Sentinel。

| 能力 | Framework 7 | Resilience4j | Sentinel |
|------|------------|--------------|----------|
| 重试 | `@Retryable` | 有 | 无 |
| 并发限制 | `@ConcurrencyLimit`（单实例） | Bulkhead | 并发线程数流控 |
| 熔断 | 无 | 有 | 有 |
| 动态改规则 | 无 | 主要靠配置文件 | 控制台 + Nacos |

- Framework 7 注解需要 `@EnableResilientMethods` 开启
- Resilience4j 通过 Spring Cloud CircuitBreaker 接入，换实现不改业务代码

**常见坑**：几个一起用时重试只在一层开，否则次数相乘。

→ 详见 [流量治理](/service-governance/5_traffic_governance#_2、framework-7-内置容错注解)、[Retry 重试](/spring/6_retry)

### Q22：如何按 API 版本把请求路由到不同实例？

**一句话**：服务端用 Spring 7 自带的 API 版本功能声明版本，调用方用 LoadBalancer 5.0 的 `api-version` 配置按版本选实例，v1、v2 实例用同一个服务名注册，按版本分流。

- 服务端写法：`@GetMapping(path = "/orders/{id}", version = "2")`
- 版本从哪读：Boot 4 用 `spring.mvc.apiversion.*` 配置，可来自请求头、查询参数、路径或媒体类型
- 调用方：只挑实例元数据 `API_VERSION` 匹配的实例
- 前提：接口尽量向后兼容（只加字段不删），真有破坏性改动才发新版本

→ 详见 [流量治理](/service-governance/5_traffic_governance#六、服务版本与兼容性)

## 四、分布式事务

### Q23：Seata 在 Spring Cloud 中怎么接入？有哪些常见坑？

**一句话**：引入 `spring-cloud-starter-alibaba-seata`，独立部署 seata-server（TC），只在事务发起方加 `@GlobalTransactional`，参与方接入数据源代理并建好 `undo_log` 表即可。

- 版本：2.1 起 groupId 和包名都是 `org.apache.seata`；SCA 2025.1 BOM 自带 2.5.0，可覆盖到 2.6.0，seata-server 与客户端版本要一致
- 配置：`tx-service-group` 经 `vgroup-mapping` 映射到 TC 集群名，`registry.type: nacos` 从 Nacos 发现 seata-server
- XID 透传：OpenFeign 等常用客户端由 starter 自动处理；自定义客户端要把 `RootContext.getXID()` 放进请求头 `TX_XID`，下游再绑定
- seata-server 生产用 db 或 raft 存储，多节点部署
- AT 原理、读写隔离和四种模式怎么选见 [分布式基础面试题解答 Q17](/interview/16_distributed#q17-seata-at-的原理是什么-全局锁和读隔离是怎样的-回滚什么时候会失败)、[Q18](/interview/16_distributed#q18-seata-的-at、tcc、saga、xa-怎么选)

**常见坑**：下游返回错误码而不抛异常时，发起方要自己判断并抛异常，否则全局事务会被提交。

→ 详见 [Spring Cloud Alibaba](/service-governance/6_alibaba#四、seata-分布式事务)

## 五、消息与链路

### Q24：Spring Cloud Stream 解决什么问题？`@StreamListener` 还能用吗？

**一句话**：在业务代码和具体 MQ 之间加一层抽象（Binder），业务只写普通的 `Supplier` / `Function` / `Consumer` Bean，看不到任何 MQ API，换 MQ 只要换依赖和配置。

- `@StreamListener` 等注解写法在 Stream 4.0（2022.0）已删除，只剩函数式写法
- 业务事件触发的发送用 `StreamBridge`
- 还能用 Test Binder 测试，不用真起 MQ
- 代价：各 MQ 的高级特性（RocketMQ 事务消息、Kafka Streams 等）被屏蔽，用得深就直接用原生客户端

→ 详见 [Spring Cloud Stream](/service-governance/7_stream#一、解决什么问题)、[Spring Cloud Stream · 函数式编程模型](/service-governance/7_stream#二、函数式编程模型)

### Q25：Spring Cloud Stream 如何配置消费组、重试与死信？

**一句话**：生产环境每个消费者都要显式配 `group`：同组的实例抢着消费（每条只处理一次），不同组各收一份。

- 不配 `group`：每个实例都是匿名订阅者，消息会被重复处理，而且重启期间的消息会丢
- 顺序：用 `partition-key-expression` 让同一业务键进同一分区
- 重试：默认在消费线程里本地重试，会卡住消费线程，次数别太大
- 死信：重试耗尽后进死信队列（Kafka 配 `enable-dlq`，RabbitMQ 配 `auto-bind-dlq`），再人工或定时处理

**常见坑**：重试和消费者重新分配分区都会导致重复投递，消费逻辑必须幂等。

→ 详见 [Spring Cloud Stream](/service-governance/7_stream#三、核心机制)

### Q26：Sleuth 之后用什么做链路追踪？traceId 如何跨服务、跨线程、跨 MQ 传递？

**一句话**：Sleuth 不支持 Boot 3，已停止发布；现在统一用 Micrometer Tracing（底层可接 Brave 或 OpenTelemetry），Web、`RestClient`、Kafka 等常用组件都自动埋点。

- 跨服务：放在请求头里，默认是 W3C 标准的 `traceparent`
- 进程内：存在当前线程上，同时写进日志 MDC，日志里就能打出 traceId
- 跨线程池 / `@Async`：用 `TaskDecorator` 或 `ContextSnapshot` 把上下文带过去
- 跨 MQ：生产者写进消息头，消费者取出来接着用
- 采样率默认 10%（`management.tracing.sampling.probability`）；不想改代码可用 SkyWalking 或 OpenTelemetry Java Agent

→ 详见 [日志](/spring-boot/9_logging#五、mdc-与-traceid-传递)、[链路追踪](/observability/3_tracing)、[OpenTelemetry](/observability/5_opentelemetry)

## 六、Dubbo 与服务网格

### Q27：Dubbo 的注册中心宕机为什么不影响已建立的调用？什么是应用级服务发现？

**一句话**：注册中心只是通讯录。消费方启动时把提供方地址缓存到本地，调用时直接和提供方长连接通信，不经过注册中心。所以它挂了，已有调用照常，只是感知不到新上线或下线的实例。

- 应用级服务发现（Dubbo 3）：注册中心按「应用」登记实例，而不是按「每个接口」登记，注册和推送的数据量大大减少
- 这样也和 Spring Cloud、Kubernetes 的「按应用 / 服务」模型对齐
- 3.x 默认接口级和应用级都注册，兼容老消费方；全部升级后设 `dubbo.registry.register-mode=instance` 只留应用级

→ 详见 [Dubbo](/service-governance/8_dubbo#二、架构与调用流程)

### Q28：Triple 协议与 dubbo 协议有什么区别？

**一句话**：dubbo 协议是 TCP 上的私有协议，快但不好跨语言、过不了普通网关；Triple 是 Dubbo 3 推荐的协议，基于 HTTP、兼容 gRPC，curl 和浏览器都能直接调。

| 对比 | dubbo 协议 | Triple |
|------|-----------|--------|
| 传输 | 私有 TCP | HTTP/1.1、HTTP/2、HTTP/3 |
| 跨语言 / 网关 | 差 | 和 gRPC 互通，可放在 HTTP 网关后 |
| 流式调用 | 不支持 | 支持 |

**常见坑**：3.2 起默认严格检查序列化类，DTO 不实现 `Serializable` 会调用失败。

→ 详见 [Dubbo](/service-governance/8_dubbo#四、triple-协议)

### Q29：Dubbo 默认的 failover 为什么对写操作是陷阱？

**一句话**：默认的 `failover` 失败就换一台重试（默认再试 2 次）。但超时不等于失败，提供方可能已经执行成功、只是回得慢，重试就会重复扣款、重复下单。

- 读接口：用默认 `failover` 没问题
- 写接口、不幂等的接口：改成 `failfast`（失败立即报错，不重试），或者把幂等做好
- 记日志这类旁路调用：`failsafe`（出错直接忽略）
- 发通知这类：`failback`（失败后在后台重发）

→ 详见 [Dubbo](/service-governance/8_dubbo#_2、集群容错策略)、[幂等设计](/architecture/3_idempotence)

### Q30：Dubbo SPI 与 Java SPI 有什么区别？`@Adaptive`、`@Activate` 做什么？

**一句话**：Java 自带的 SPI（`ServiceLoader`）只能把所有实现全部加载出来遍历；Dubbo SPI 按名字取实现，用到哪个才创建哪个，还能自动注入依赖、自动套包装类。

- `@Adaptive`：运行时根据调用参数里的配置，决定用哪个实现（比如按配置切换协议、负载均衡策略）
- `@Activate`：按条件自动启用并排序，典型用法是过滤器链
- Wrapper：自动包在实现外面的一层，统一加监听、过滤逻辑，类似 AOP
- 协议、负载均衡、容错策略、过滤器、序列化都是通过 Dubbo SPI 装配的

→ 详见 [Dubbo](/service-governance/8_dubbo#六、spi-扩展机制)、[SPI 机制](/java/20_topic_spi)

### Q31：Dubbo 和 Spring Cloud 怎么选？

**一句话**：内部服务高频互调、看重性能、团队熟悉 Dubbo，选 Dubbo；对外接口多、跨语言、想跟紧 Spring Boot 新版本，选 Spring Cloud。也常混用：内部 Dubbo，对外 REST。

| 对比 | Dubbo 3 | Spring Cloud |
|------|---------|--------------|
| 通信 | RPC 长连接 | HTTP |
| 接口约定 | Java 接口 jar | HTTP 地址 + DTO |
| 治理 | 框架自带 | 多个组件拼起来 |
| Spring Boot 4 | 目前基于 Boot 3.5，以官方发布为准 | 已支持 |

→ 详见 [Dubbo](/service-governance/8_dubbo#八、dubbo-vs-spring-cloud-选型)

### Q32：什么是服务网格？istiod 负责什么，控制面与数据面如何分工？

**一句话**：服务网格把重试、熔断、加密、监控这些通信能力从业务代码里拿出来，交给和服务一起部署的代理去做。好处是和语言无关、改配置不用发版；代价是多一层代理和一套要运维的控制面。

- 控制面 istiod：从 Kubernetes 读服务信息，把路由和安全规则翻译成代理配置下发；还当证书机构，给每个服务发证书
- 数据面：真正转发流量的代理（Sidecar 模式是每个 Pod 一个 Envoy；Ambient 模式是 ztunnel + waypoint），负责路由、负载均衡、加密和监控数据
- 早期的 Pilot、Citadel、Galley 已合并成 istiod，按功能理解即可

→ 详见 [服务网格](/service-governance/9_service_mesh#二、istio-架构)

### Q33：Istio 的 Sidecar 模式与 Ambient 模式有什么区别？ztunnel 与 waypoint 各做什么？

**一句话**：Sidecar 模式给每个 Pod 塞一个代理，什么都在 Pod 里做；Ambient 模式（1.24 起正式可用）业务 Pod 里没有代理，把工作拆给两类组件。

- ztunnel：每个节点一个，负责四层的事——加密（mTLS）、身份、按身份授权
- waypoint：可选，按命名空间或服务部署，负责七层的事——HTTP 路由、重试、按路径授权

| 对比 | Sidecar | Ambient |
|------|---------|---------|
| 资源开销 | 随 Pod 数量增长 | 每节点一个 ztunnel，七层按需部署 |
| 接入、升级 | 要重启业务 Pod | 打标签就接入，升级不重启业务 |
| 七层能力 | 默认就有 | 部署 waypoint 后才有 |
| 适合 | 每个服务都要完整治理 | 主要为了加密 / 零信任、想省资源 |

→ 详见 [服务网格](/service-governance/9_service_mesh#三、数据面-sidecar-与-ambient)

### Q34：为什么 VirtualService 的路由规则顺序很重要？

**一句话**：VirtualService 的路由规则从上往下匹配，第一条命中就生效。精确规则（比如按请求头去灰度版本）要写在前面，兜底规则放最后。

- 写反了：不带 `match` 的兜底规则会接走所有请求，后面的灰度规则永远不生效
- 对比：Kubernetes Gateway API（`HTTPRoute`）按规则的精确程度排优先级，带 Header 匹配的规则自动优先于不带的，不看书写顺序
- Istio 推荐用 Gateway API 配入口网关和 Ambient waypoint 的路由，换过去就不用操心规则顺序

→ 详见 [服务网格](/service-governance/9_service_mesh#_1、virtualservice-虚拟服务)

### Q35：Istio 如何实现 mTLS？SPIFFE 身份是什么？网格下的链路追踪是零侵入的吗？

**一句话**：istiod 给每个服务发短期证书并自动更换，代理之间自动加密互认（mTLS，双方都验对方证书），业务代码不用改。

- SPIFFE 身份：证书里写的服务身份，形如 `spiffe://cluster.local/ns/production/sa/order-service`，绑定的是 Kubernetes ServiceAccount 而不是 IP
- 有了身份就能用 `AuthorizationPolicy` 规定「谁能调谁」
- 平滑接入：先用 `PERMISSIVE`（明文和加密都收），全部接好后切 `STRICT`
- 链路追踪不是完全零侵入：代理只看到单次请求，应用要把收到的追踪头转发到下游请求上；Spring Boot 接入 Micrometer Tracing 后自动处理

→ 详见 [服务网格](/service-governance/9_service_mesh#五、mtls-服务间加密)、[零信任架构](/security/9_zero_trust)

### Q36：服务网格与 Spring Cloud 如何选？组合使用时要注意什么？

**一句话**：纯 Java、要按业务参数做治理（比如按商品 ID 限流）选 Spring Cloud；多语言、全面上了 Kubernetes、有专门平台团队选 Istio。

| 对比 | Spring Cloud | Istio |
|------|-------------|-------|
| 实现 | 依赖库，在业务进程里 | 进程外代理，业务无感 |
| 性能 | 无额外转发 | 每次调用多过一层代理 |
| 治理粒度 | 能到方法和业务参数 | 只认路径、请求头、身份 |
| 运维门槛 | 低 | 高 |

**常见坑**：一起用时同一能力两边都开，比如重试两边都配，重试次数会相乘。网格管加密和统一监控，SDK 管业务级治理。

→ 详见 [服务网格](/service-governance/9_service_mesh#七、service-mesh-vs-spring-cloud)

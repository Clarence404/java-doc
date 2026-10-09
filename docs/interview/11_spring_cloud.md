---
description: 拆分迁移、服务网格、Dubbo、微服务模式、Nacos、配置刷新、网关、Feign、Sentinel、Seata
---

# 开发总结 - 微服务与 Spring Cloud

> 精华提炼，细节详见 [微服务总览](/microservices/0_overview) 与 [Spring Cloud 总览](/spring-cloud/0_overview)；题目清单见 [微服务面试题](/microservices/99_interview) 与 [Spring Cloud 面试题](/spring-cloud/99_interview)，本页按清单的分组与顺序作答：一至五组对应微服务题单，六至十组对应 Spring Cloud 题单。
> 版本基线：Spring Boot 4.x、Spring Cloud 2025.1.x（Oakwood）、Spring Cloud Alibaba 2025.1.0.0（Nacos 3.x、Sentinel 1.8.9、Seata 2.5 / Apache Seata）、Istio 1.24+、Dubbo 3.3（基于 Spring Boot 3.5）。熔断、降级、限流的策略与阈值见 [开发总结 - 高可用](/interview/14_high_avail)，分布式事务理论见 [开发总结 - 分布式](/interview/10_distributed)。

## 一、拆分与演进

### Q1：微服务和单体架构各有什么优缺点？什么时候该拆分？

**核心结论**：微服务用**分布式系统的复杂度**换取**独立交付、独立扩展和故障隔离**。拆分没有「多少人、多少行代码」的硬阈值，看的是信号：先用单体把业务跑通、把边界看清（MonolithFirst），再按需拆分。

| 对比 | 单体 | 微服务 |
|------|------|--------|
| 开发与调试 | 简单，本地调用 | 网络调用会超时、失败、乱序 |
| 部署 | 改一行也全量发布 | 按服务独立发布，回滚范围小 |
| 扩展 | 只能整体扩容 | 只给热点服务扩容 |
| 故障 | 一个模块拖垮整个进程 | 配好超时熔断时可隔离 |
| 一致性 | 本地事务 | 需要 Saga、Outbox 等最终一致方案 |
| 运维 | 一个应用 | 依赖容器化、CI/CD、链路追踪、配置中心 |

| 拆分信号 | 建议 |
|---------|------|
| 多团队共用发布窗口、互相阻塞；模块迭代节奏差异大；少数模块扩展需求特殊 | 开始规划拆分，高频变化或热点模块优先 |
| 业务边界模糊、基础设施（容器化、监控）不足、团队小业务简单 | 先在单体内模块化、补基础设施，暂不拆 |

→ 详见 [微服务优势与挑战](/microservices/1_pros_and_cons#五、何时拆分)

### Q2：微服务和 SOA 的区别是什么？

**核心结论**：可以把微服务理解为**去掉 ESB 与重量级协议、把服务粒度降到单个业务能力、数据去中心化**的 SOA。

| 对比 | SOA | 微服务 |
|------|-----|--------|
| 通信 | ESB + WS-* 协议，智能管道 | HTTP / gRPC / MQ，「智能端点、哑管道」 |
| 粒度 | 粗，面向企业系统集成 | 细，面向单个业务能力 |
| 数据 | 常见共享数据库 | 每个服务独立数据存储 |
| 治理 | 集中式、统一技术栈 | 去中心化、允许技术异构 |
| 目标 | 跨系统复用 | 快速迭代、独立交付 |

→ 详见 [微服务优势与挑战](/microservices/1_pros_and_cons#_3、微服务-vs-soa)

### Q3：微服务拆分的原则是什么？如何避免过度拆分和「分布式单体」？

**核心结论**：按**限界上下文**（DDD）划定边界是最推荐的方法，按业务能力拆分是更粗粒度的起点；每个服务单一职责、自治、独占数据。「分布式单体」是最坏结果：服务拆开了，却仍必须一起发布、一起扩容、一起故障。

| 原则 | 反模式 |
|------|-------|
| 一个上下文一个模型一个服务，服务间通过 API 或事件协作 | 按技术分层拆（controller 服务、dao 服务） |
| Database per Service，禁止多个服务读写同一张表 | 共享数据库，任何 DDL 波及多个服务 |
| 高内聚：一次需求尽量只改一个服务 | 一个需求改五个服务、按固定顺序联合发布 |
| 异步优先、接口向后兼容 | 长同步调用链，任一环节故障整条链失败 |

- 防过度拆分：服务数量与团队维护能力匹配；拆分前先在单体内做模块化验证边界；调用关系频繁且总是一起变化的模块不要拆开

→ 详见 [微服务设计模式](/microservices/2_patterns#一、服务拆分模式)、[DDD 领域驱动设计](/architecture/3_ddd)

### Q4：如何把单体迁移到微服务？绞杀者模式怎么做？

**核心结论**：渐进式迁移，不做大爆炸式重写。三种互补策略：**停止挖掘**（新功能直接做成独立服务，用防腐层与单体协作）、**前后端分离**、**抽取服务**（绞杀者模式）。

绞杀者模式：

1. 在单体前加 API 网关，所有流量先经过网关（此时只做透传）
2. 选一个模块抽成独立服务、迁移数据，网关把对应路由切到新服务
3. 新服务稳定后删除单体中的旧代码；出问题把路由切回单体即可回滚
4. 重复 2、3，直到单体下线

- **优先抽取**：频繁变化的、资源需求特殊的、边界清晰耦合少的（适合作为第一个试点）
- **数据迁移最难**：先让新服务通过 API 读写单体数据，再用双写或 CDC 同步到新库，最后切断对旧表的访问

→ 详见 [微服务优势与挑战](/microservices/1_pros_and_cons#六、单体到微服务的迁移策略)

## 二、通信与 RPC

### Q5：客户端服务发现与服务端服务发现有什么区别？

**核心结论**：客户端发现由**调用方**从注册中心拉取实例列表、本地负载均衡后直连（Nacos + Spring Cloud LoadBalancer、Dubbo）；服务端发现由调用方访问一个**固定地址**，平台转发到健康实例（Kubernetes Service、服务网格）。

| 对比 | 客户端发现 | 服务端发现 |
|------|-----------|-----------|
| 负载均衡位置 | 调用方进程内 | 平台（kube-proxy、代理） |
| 语言绑定 | 需要各语言 SDK | 语言无关 |
| 网络跳数 | 直连，少一跳 | 多一层转发 |
| 灵活性 | 可按业务元数据做灰度、区域优先 | 依赖平台能力 |

- 注册中心不在调用链路上：短暂故障时调用方用本地缓存的实例列表继续调用

→ 详见 [微服务设计模式](/microservices/2_patterns#_3、服务发现-service-discovery)

### Q6：服务间同步调用与异步消息怎么选？

**核心结论**：需要立即得到结果用同步调用（HTTP Service Clients / gRPC / Dubbo）；可以延迟处理、需要削峰或解耦、一个事件多方消费时用消息队列。核心链路同步、非核心链路异步是常见组合。

| 场景 | 方式 |
|------|------|
| 下单要立即知道库存是否扣减成功 | 同步调用 |
| 下单后发积分、通知、统计 | 消息异步，发送方只保证可靠投递 |
| 读多写少、查询模型差异大 | CQRS + 领域事件异步更新读模型 |

- 同步调用要设超时并控制调用链深度；异步要处理可靠投递、重复消费（幂等）、顺序与最终一致

→ 详见 [微服务设计模式](/microservices/2_patterns#_4、同步与异步通信)、[消息队列基础](/messaging/1_basics)

### Q7：gRPC、Dubbo 与 HTTP（REST）分别适合什么场景？

**核心结论**：对外暴露、浏览器与第三方调用用 REST；内部调用量大、对延迟与序列化敏感、需要流式或多语言时用 gRPC；Java 为主、需要接口级治理时用 Dubbo 3。协议选型以契约管理成本、团队熟悉度和观测能力为主，性能差距只在调用量大、消息体大的链路才显著。

| 对比 | REST（HTTP + JSON） | gRPC | Dubbo 3 |
|------|-------------------|------|---------|
| 契约 | 端点 + DTO，松耦合 | `.proto`，多语言代码生成 | 接口 jar，强类型 |
| 传输 | HTTP/1.1 或 2 | HTTP/2 + Protobuf，支持双向流 | Triple（兼容 gRPC）或 dubbo 协议 |
| 浏览器 | 直接可用 | 需 gRPC-Web 或转码 | Triple 支持 HTTP 访问 |
| 治理 | 靠 Spring Cloud 组件拼装 | 靠网格或自建 | 框架内建 |

- gRPC 的 HTTP/2 多路复用消除了应用层队头阻塞，TCP 层丢包仍会阻塞同一连接上的所有流；长连接会让 L4 负载均衡失效，要按请求均衡

→ 详见 [服务通信](/spring-cloud/3_communication#六、选型)、[远程调用协议](/protocols/3_rpc_protocols)

## 三、服务网格与 Dubbo

### Q8：什么是服务网格？istiod 负责什么，控制面与数据面如何分工？

**核心结论**：服务网格是服务间通信的**基础设施层**：把负载均衡、重试、熔断、mTLS、遥测从业务进程的 SDK 中拿出来，交给与业务一起部署的代理，治理能力语言无关、改配置不用发布业务。代价是多一层代理和一个要运维的控制面。

| 层次 | 组件 | 职责 |
|------|------|------|
| 控制面 | istiod（单一二进制） | 从 Kubernetes 获取服务与端点；把路由、安全策略翻译成 Envoy 配置经 xDS 下发；作为 CA 签发、轮转工作负载证书 |
| 数据面 | Envoy Sidecar，或 ztunnel + waypoint（Ambient） | 实际承载流量，执行路由、负载均衡、熔断、mTLS 与遥测 |

- Istio 1.5 起早期的 Pilot、Citadel、Galley 已合并为 istiod，按功能理解即可

→ 详见 [服务网格](/microservices/3_service_mesh#二、istio-架构)

### Q9：Istio 的 Sidecar 模式与 Ambient 模式有什么区别？ztunnel 与 waypoint 各做什么？

**核心结论**：Sidecar 模式每个 Pod 注入一个 Envoy，L4 / L7 能力都在 Pod 内完成；Ambient 模式（1.24 起 GA）把数据面拆成两层、业务 Pod 中没有代理：**ztunnel**（每节点一个 DaemonSet）负责 L4——mTLS、身份、L4 授权与 TCP 遥测；**waypoint**（按命名空间或服务部署的 Envoy，可选）负责 L7——HTTP 路由、重试、故障注入、L7 授权。

| 维度 | Sidecar | Ambient |
|------|---------|---------|
| 资源开销 | 随 Pod 数线性增长 | 每节点一个 ztunnel，L7 按需部署 |
| 接入与升级 | 注入、升级代理都要重启业务 Pod | 打标签即接入，升级 ztunnel 不重启业务 |
| L7 能力 | 默认全量 | 部署 waypoint 后才有 |
| 成熟度 | 最成熟 | 1.24 GA，多集群等高级场景需核对文档 |
| 适合 | 每个工作负载都要完整 L7 治理 | 以 mTLS / 零信任为首要目标、希望降低开销 |

→ 详见 [服务网格](/microservices/3_service_mesh#三、数据面-sidecar-与-ambient)

### Q10：为什么 VirtualService 的路由规则顺序很重要？

**核心结论**：VirtualService 中 `http` 下的路由**按顺序匹配、第一条命中即生效**。带 `match` 的精确规则（如按 Header 路由到灰度版本）必须写在前面，不带 `match` 的兜底或按权重分流的规则写在最后；反过来写，兜底规则会接住所有请求，后面的 Header 规则永远不生效。

- Kubernetes Gateway API（`HTTPRoute`）按匹配的精确程度决定优先级，带 Header 匹配的规则优先，不依赖书写顺序
- 资源使用 `networking.istio.io/v1`（1.22 起 GA）；负载均衡用 `LEAST_REQUEST`

→ 详见 [服务网格](/microservices/3_service_mesh#_1、virtualservice-虚拟服务)

### Q11：Istio 如何实现 mTLS？SPIFFE 身份是什么？网格下的链路追踪是零侵入的吗？

**核心结论**：istiod 作为 CA 为每个工作负载签发短期证书并自动轮转，代理之间自动建立 mTLS，业务代码不用改；证书中的身份遵循 SPIFFE 规范，形如 `spiffe://cluster.local/ns/production/sa/order-service`，**身份绑定到 Kubernetes ServiceAccount 而不是 IP**，再基于它用 `AuthorizationPolicy` 控制「谁能调用谁」。

- 渐进接入：先用 `PERMISSIVE` 模式同时接受明文与 mTLS，全部接入后切 `STRICT`
- **链路追踪不是完全零侵入**：代理只看到单跳请求，应用必须把入站的追踪头（W3C `traceparent` 或 B3）带到出站请求上，链路才能串起来；Spring Boot 接入 Micrometer Tracing 后自动传播

→ 详见 [服务网格](/microservices/3_service_mesh#五、mtls-服务间加密)、[零信任架构](/security/9_zero_trust)

### Q12：服务网格与 Spring Cloud 如何选？组合使用时要注意什么？

**核心结论**：纯 Java、团队以业务开发为主、需要业务语义级治理（参数级限流、业务降级）选 Spring Cloud；多语言混合、已全面上 Kubernetes、有专职平台团队选 Istio。

| 维度 | Spring Cloud（SDK） | Istio（网格） |
|------|-------------------|--------------|
| 实现 | 依赖库侵入业务进程 | 进程外代理，对业务透明 |
| 治理变更 | 改代码或配置中心，部分需发布 | 改 CRD，控制面下发 |
| 性能 | 进程内，无额外跳数 | 每次调用多经过代理 |
| 治理粒度 | 可到方法、业务参数 | 基于路径、Header、身份，不懂业务语义 |
| 运维门槛 | 低 | 高 |

- 组合使用：网格负责 mTLS、L4 策略和统一遥测，SDK 保留业务语义治理；**同一能力只在一处开启**，例如重试两处都开会让次数相乘

→ 详见 [服务网格](/microservices/3_service_mesh#七、service-mesh-vs-spring-cloud)

### Q13：Dubbo 的注册中心宕机为什么不影响已建立的调用？什么是应用级服务发现？

**核心结论**：注册中心只是「通讯录」：Consumer 启动时订阅并**缓存** Provider 地址列表，调用时本地负载均衡后与 Provider **点对点长连接直连**，注册中心不在调用链路上。它宕机时已有调用照常进行，只是感知不到实例变化。

Dubbo 3 的**应用级服务发现**：注册中心按应用而不是按接口登记实例，接口与方法的元数据单独存放，注册数据量和推送量大幅下降，也与 Spring Cloud、Kubernetes 的服务模型对齐。3.x 默认双注册（接口级 + 应用级）兼容 2.x 消费者，全部升级后设 `dubbo.registry.register-mode=instance` 只保留应用级。

→ 详见 [Dubbo](/microservices/4_dubbo#二、架构与调用流程)

### Q14：Triple 协议与 dubbo 协议有什么区别？

**核心结论**：dubbo 协议是 TCP 上的私有二进制协议，性能好但跨语言、穿透网关差；Triple 是 Dubbo 3 推荐协议，**基于 HTTP、兼容 gRPC**，3.3 起同一端口同时支持 HTTP/1.1、HTTP/2，并可协商升级到 HTTP/3，还能用 curl、浏览器、普通 HTTP 网关访问（Triple Rest）。

| 维度 | dubbo 协议 | Triple |
|------|-----------|--------|
| 传输 | 私有 TCP 协议 | HTTP/1.1、HTTP/2、HTTP/3 |
| 跨语言 / 网关 | 差 | 与 gRPC 互通，可挂在 HTTP 网关后 |
| 流式调用 | 不支持 | 服务端流、客户端流、双向流 |
| 序列化 | Hessian2 | IDL 模式 Protobuf；Java 接口模式默认 Hessian2 |

- 3.2 起序列化类检查默认 STRICT，DTO 必须实现 `Serializable`，非签名类型要登记允许列表

→ 详见 [Dubbo](/microservices/4_dubbo#四、triple-协议)

### Q15：Dubbo 默认的 failover 为什么对写操作是陷阱？

**核心结论**：默认集群容错 `failover` 在调用失败时换一台重试（`retries` 默认 2，最多共 3 次）。但**超时不等于失败**——Provider 可能已经执行成功，只是响应慢，重试就会造成重复扣款、重复下单。写接口要么改 `cluster = "failfast"`（立即报错），要么把幂等做扎实。

| 策略 | 适用 |
|------|------|
| `failover`（默认） | 读操作 |
| `failfast` | 写操作、非幂等操作 |
| `failsafe` | 日志、审计类旁路调用 |
| `failback` | 通知类，失败后台重发 |
| `forking` / `broadcast` | 并行取最快 / 通知所有节点 |

→ 详见 [Dubbo](/microservices/4_dubbo#_2、集群容错策略)、[幂等方案总结](/architecture/5_idempotence)

### Q16：Dubbo SPI 与 Java SPI 有什么区别？`@Adaptive`、`@Activate` 做什么？

**核心结论**：Java 原生 `ServiceLoader` 只能遍历实例化全部实现；Dubbo SPI 用 `name=实现类` 配置，**按名称获取、只实例化用到的实现**，并支持依赖注入、Wrapper 自动包装（相当于 AOP）、`@Adaptive` 运行时选择、`@Activate` 条件激活。协议、负载均衡、集群容错、过滤器、序列化都通过它装配。

| 机制 | 作用 | 典型用途 |
|------|------|---------|
| `@Adaptive` | 生成自适应代理，调用时从 URL 参数读出扩展名再委派 | `Protocol`、`Cluster`、`LoadBalance` 按配置切换 |
| `@Activate` | 按分组（provider / consumer）和参数自动激活并排序 | 过滤器链 |
| Wrapper | 构造器参数是扩展点本身的实现类，自动套在外层 | 统一加监听、过滤逻辑 |

- Dubbo 3 通过 `ScopeModel` 获取 `ExtensionLoader`，静态的 `getExtensionLoader` 已过时

→ 详见 [Dubbo](/microservices/4_dubbo#六、spi-扩展机制)、[SPI 机制](/java/20_topic_spi)

### Q17：Dubbo 和 Spring Cloud 怎么选？

**核心结论**：内部服务间高频调用、性能敏感、团队熟悉 Dubbo 选 Dubbo；对外暴露多、跨语言、希望紧跟 Spring Boot 版本选 Spring Cloud。两者也常混用：内部 Dubbo，边界 REST。

| 维度 | Dubbo 3 | Spring Cloud |
|------|---------|--------------|
| 通信 | RPC 长连接（Triple / dubbo） | HTTP（HTTP Service Clients，存量 OpenFeign） |
| 契约 | 接口 jar，强类型 | HTTP 端点 + DTO |
| 治理 | 框架内建 | 组件拼装（LoadBalancer、Resilience4j / Sentinel、Gateway） |
| Spring Boot 版本 | 目前基于 Boot 3.5，Boot 4 适配以官方发布为准 | 已支持 Boot 4 |

→ 详见 [Dubbo](/microservices/4_dubbo#八、dubbo-vs-spring-cloud-选型)

## 四、微服务模式

### Q18：BFF 是什么？和 API 网关有什么区别？

**核心结论**：API 网关是所有客户端的**统一入口**，负责路由、鉴权、限流、协议转换等通用横切能力；BFF（Backend for Frontend）是**为某一类客户端专属**的聚合层（移动端、Web 各一个），负责裁剪字段、合并请求、按页面结构定制接口，避免一个「万能网关」被各端需求拉扯。

- BFF 由对应前端团队拥有，只做聚合与适配，不承载核心业务规则
- 常见组合：网关在前做通用能力，其后按客户端类型分 BFF；网关作为 OAuth2 Client 时也是一种 BFF 形态（`TokenRelay` 转发令牌）

→ 详见 [微服务设计模式](/microservices/2_patterns#_2、bff-backend-for-frontend)

### Q19：Database per Service 之后如何做跨服务查询？API Composition 还是 CQRS？

**核心结论**：数据量小、实时性要求高的简单查询用 **API Composition**——由网关、BFF 或查询服务并行调用各服务后在内存中拼接；需要跨服务分页、排序、复杂过滤或大批量关联时用 **CQRS**——写端通过领域事件异步更新一个为查询优化的读模型（如 Elasticsearch 宽表），代价是读写之间的最终一致延迟。

- 「独占数据」指逻辑所有权：同一 MySQL 实例上不同 schema、只授权给对应服务的账号也可以；**禁止**多个服务直接读写同一张表

→ 详见 [微服务设计模式](/microservices/2_patterns#三、数据管理模式)、[架构模式与风格](/architecture/2_arch_patterns)

### Q20：Outbox 模式如何保证「写库 + 发消息」的原子性？

**核心结论**：在**同一个本地事务**里写业务表和 outbox 表，事务提交即两者同时生效；由独立的投递进程把 outbox 中的消息发到 MQ，成功后标记完成，失败重试。消息因此「至少一次」投递，消费端按业务键幂等。

| 投递方式 | 特点 |
|---------|------|
| 轮询 outbox 表 | 实现简单，有轮询延迟与数据库压力 |
| CDC（Debezium Outbox Event Router 监听 binlog） | 延迟低，不给业务库加轮询压力 |

- 不能在数据库事务里直接发 MQ：事务回滚了消息已发出，或事务提交了消息发送失败
- 已用 RocketMQ 时也可以用事务消息（半消息 + 回查）

→ 详见 [微服务设计模式](/microservices/2_patterns#_5、outbox-事务发件箱)、[分布式事务](/distributed/4_transaction)

### Q21：Saga 的编排式与协同式有什么区别？

**核心结论**：Saga 把跨服务长事务拆成一串本地事务，失败时按逆序执行补偿。**编排式**（Orchestration）由一个协调者集中驱动每一步、调用补偿，流程清晰、便于监控，适合步骤多、补偿复杂的场景；**协同式**（Choreography）由各服务监听事件自主推进，没有中心节点、耦合更低，但步骤一多流程就难以追踪，适合步骤少的场景。

- Saga 没有隔离性，中间状态对外可见，要靠业务设计（如「处理中」状态）和补偿的幂等来兜底

→ 详见 [微服务设计模式](/microservices/2_patterns#_4、saga)、[分布式事务](/distributed/4_transaction#六、saga-事务-长事务补偿机制)

### Q22：消费者驱动契约测试解决什么问题？

**核心结论**：微服务各自发布，提供方改了接口很容易破坏调用方，而端到端测试要拉起多个服务、慢且脆弱。消费者驱动契约测试由**调用方声明依赖的契约**（请求与期望响应），提供方在 CI 中用这些契约验证实现，接口一旦破坏调用方就**构建失败**，用远低于端到端测试的成本守住服务间接口。常用工具是 Spring Cloud Contract 与 Pact。

→ 详见 [微服务设计模式](/microservices/2_patterns#_4、消费者驱动契约测试-consumer-driven-contract)、[契约测试](/testing/6_contract_test)

## 五、分布式场景

### Q23：微服务之间的分布式事务如何处理？

**核心结论**：**能不用分布式事务就不用**。优先用最终一致方案：本地消息表 / Outbox、事务消息、Saga、对账补偿；只有「必须同步得到一致结果」的链路才用 Seata（AT / TCC）这类同步方案。

| 场景 | 方案 |
|------|------|
| 下单后通知其他服务，允许短暂不一致 | Outbox / 事务消息 + 幂等消费 |
| 长流程、跨外部系统 | Saga |
| 资金类、需要资源预留 | TCC |
| 关系库常规 CRUD、要求同步一致、并发不高 | Seata AT |

→ 详见 [分布式事务](/distributed/4_transaction#九、方案选型总结)、[开发总结 - 分布式](/interview/10_distributed#四、分布式事务有哪些解决方案)

### Q24：微服务接口如何实现幂等？

**核心结论**：网络超时、客户端重试、MQ 重复投递、Dubbo failover 都会让同一请求到达多次，所以写接口必须幂等。核心是**为每次业务操作确定唯一标识**，再在服务端做去重：

| 手段 | 适用 |
|------|------|
| 唯一索引（业务单号） | 插入类操作，最简单可靠 |
| 幂等表 / 去重记录与业务写入同一本地事务 | MQ 消费、通用写接口 |
| Token 机制（先取 token，提交时删除） | 表单防重复提交 |
| 状态机 / 乐观锁（`WHERE status = ?` / 版本号） | 状态流转、扣减类操作 |
| Redis `SET NX` | 高并发下的快速判重，需配合持久化兜底 |

→ 详见 [幂等方案总结](/architecture/5_idempotence)、[开发总结 - 系统架构](/interview/15_architecture#五、接口幂等性如何设计)

### Q25：服务间如何传递认证信息与上下文（用户身份、灰度标记、traceId）？

**核心结论**：所有上下文都靠**请求头逐跳透传**，每一跳都要传给下一跳，否则第二跳之后就丢了。

| 上下文 | 做法 |
|--------|------|
| 用户身份 | 网关作为 OAuth2 Resource Server 验签后，**先删除外部同名请求头**再注入用户标识；或原样转发 `Authorization` 让下游再做一次资源服务器校验（零信任） |
| 灰度标记 | HTTP Service Clients / `RestClient` 用 `ClientHttpRequestInterceptor`，OpenFeign 用 `RequestInterceptor`；MQ 写进消息头 |
| traceId | Micrometer Tracing 自动注入 W3C `traceparent` 并写入 MDC |
| Dubbo | `RpcContext` attachment + Filter |

- `RequestContextHolder` 绑定在请求线程上，切到线程池或 `@Async` 后取不到，要用 `TaskDecorator`、Micrometer Context Propagation 或链路 Baggage 显式传递

→ 详见 [API 网关](/spring-cloud/2_api_gateway#四、统一鉴权-网关作为-oauth2-资源服务器)、[服务治理](/spring-cloud/5_service_governance#_5、灰度标记透传)

## 六、注册与配置

### Q26：Spring Boot、Spring Cloud、Spring Cloud Alibaba 的版本如何对应？

**核心结论**：三者强绑定，必须按官方版本说明对表选择，同时导入 Spring Cloud 与 SCA 两个 BOM。Spring Cloud 的每个 release train 只支持特定的 Boot 大 / 小版本，SCA 再跟随 Spring Cloud。

| Spring Boot | Spring Cloud | Spring Cloud Alibaba | 组件版本 / 说明 |
|-------------|--------------|---------------------|---------------|
| 4.0.x | 2025.1.x（Oakwood，子项目统一 5.0.x） | 2025.1.0.0 | Nacos 3.1.1、Sentinel 1.8.9、Seata 2.5.0、RocketMQ 5.3.1；取消 bootstrap |
| 4.1.x | 2025.1.2 及以上 | 以 SCA 发布说明为准 | Spring Cloud 2025.1.2 起支持 Boot 4.1 |
| 3.5.x | 2025.0.x（Northfields） | 2025.0.0.0 | Nacos 3.0.3；开源支持已于 2026-06 结束 |
| 2.6.x / 2.7.x | 2021.0.x（Jubilee） | 2021.0.x | `javax` 时代的存量项目 |

- 升级 Boot 小版本前，先确认对应的 Spring Cloud 与 SCA 已发布；Dubbo 等非 Spring 管理的组件单独核对

→ 详见 [Spring Cloud 总览](/spring-cloud/0_overview#三、版本与选型速查)、[Spring Cloud Alibaba](/spring-cloud/6_alibaba#一、定位与版本对齐)

### Q27：注册中心如何选型？Nacos、Eureka、Consul、ZooKeeper、Kubernetes 有什么区别？

**核心结论**：Spring Cloud Alibaba 技术栈选 Nacos（注册与配置二合一）；服务都在 K8s 集群内时优先用平台自带的 Service 发现，少一个中间件；多语言、跨数据中心选 Consul；Eureka 仍随 Spring Cloud Netflix 发布但只维护，新项目不推荐。

| 组件 | 一致性模型 | 健康检查 | 配置中心 | 现状 |
|------|-----------|---------|---------|------|
| Nacos | 临时实例 AP（Distro），持久实例 CP（JRaft） | 长连接存活 + 服务端探测 | 内置 | 国内主流 |
| Consul | CP（Raft） | HTTP / TCP / gRPC / 脚本探测 | KV 存储 | 多数据中心 |
| Kubernetes | etcd 之上的 Service / EndpointSlice | Readiness 探针 | ConfigMap / Secret | 平台原生 |
| Eureka | AP | 客户端心跳 + 自我保护 | 无 | Eureka 2.x 已放弃，1.x 维护 |
| ZooKeeper | CP（ZAB） | 临时节点 + 会话 | 无 | Dubbo 老项目 |

→ 详见 [注册发现](/spring-cloud/1_service_registry#二、注册中心对比)

### Q28：注册中心为什么更适合 AP？ZooKeeper 做注册中心有什么问题？

**核心结论**：注册中心的核心诉求是可用性：短暂不一致（多拿到一个已下线实例）可以靠调用方重试、熔断、本地缓存兜底；但如果为了强一致在选主或网络分区期间**拒绝注册和查询**，所有服务都无法发现彼此，影响面大得多。

- ZooKeeper 是 CP：Leader 选举期间集群不可用，少数派分区内的节点也无法提供服务；大量临时节点的会话管理与 Watch 风暴也给它带来压力
- 注册中心不在调用链路上，短暂故障时调用方用缓存的实例列表继续调用

→ 详见 [注册发现](/spring-cloud/1_service_registry#二、注册中心对比)、[分布式理论](/distributed/2_theorem)

### Q29：Nacos 的临时实例和持久实例有什么区别？AP / CP 是由什么决定的？

**核心结论**：AP / CP **不是集群级开关，而是由每个实例的 `ephemeral` 属性决定**：临时实例（默认）走 Distro 协议（AP），持久实例走 JRaft（CP）。Nacos 1.x 时代按集群切换 `serverMode` 的说法已经过时，2.x 起同一服务内也不再允许混用两类实例。

| 维度 | 临时实例（默认） | 持久实例 |
|------|----------------|---------|
| 声明 | `ephemeral: true` | `spring.cloud.nacos.discovery.ephemeral: false` |
| 存储 / 一致性 | 内存，Distro，AP | 持久化，JRaft，CP |
| 健康检查 | 客户端连接存活 | 服务端主动探测（TCP / HTTP / MySQL） |
| 不健康时 | 连接断开即删除 | 标记不健康但不删除，需显式注销 |
| 适用 | 普通微服务实例 | 数据库等无法运行 Nacos 客户端的节点 |

→ 详见 [注册发现](/spring-cloud/1_service_registry#_2、临时实例与持久实例)

### Q30：Nacos 2.x 与 1.x 的健康检查有何不同？需要放通哪些端口？

**核心结论**：1.x 的临时实例靠客户端每 5 秒 HTTP 心跳、15 秒标记不健康、30 秒剔除；**2.0 起改为 gRPC 长连接**，实例绑定在连接上，连接断开即剔除该连接注册的所有实例，没有固定的 15s / 30s 窗口；变更也由服务端通过长连接主动推送，不再是 UDP 推送 + 定时拉取。

| 端口 | 用途 |
|------|------|
| 8848 | HTTP（OpenAPI、旧客户端） |
| 9848（主端口 + 1000） | 客户端 gRPC |
| 9849 | 集群节点间 gRPC |
| 控制台独立端口 | Nacos 3.x 控制台与服务端端口分离（文档示例为 8080） |

- 只开 8848 会导致 2.x 客户端连不上；Nacos 3.x 服务端要求 JDK 17、默认开启鉴权，客户端要配 `username` / `password`

→ 详见 [注册发现](/spring-cloud/1_service_registry#_1、连接模型-grpc-长连接)

### Q31：Nacos 的保护阈值是什么？Nacos Server 全挂了服务还能调用吗？

**核心结论**：保护阈值（服务级，0~1）是在**健康实例占比低于阈值**时，Nacos 返回全部实例（含不健康的），宁可部分请求失败，也不让流量全部压到少数健康实例上导致雪崩。Nacos Server 全挂时**已有实例仍可调用**：客户端在内存和本地磁盘缓存了服务列表，只是新实例无法被发现、下线实例无法被剔除。

- 客户端配置多个 Server 地址或使用 VIP / 域名避免单点；集群至少 3 节点、外置 MySQL

→ 详见 [注册发现](/spring-cloud/1_service_registry#_3、保护阈值与本地容灾)

### Q32：Spring Cloud Alibaba 2025.1 为什么不再支持 bootstrap？如何用 `spring.config.import` 接入 Nacos？

**核心结论**：bootstrap 上下文是 Boot 2.4 之前「先加载远程配置」的老机制，Boot 2.4 / Spring Cloud 2020.0 起已默认关闭（需额外引入 `spring-cloud-starter-bootstrap`），Boot 的 `spring.config.import` 统一了外部配置源的加载；SCA 2025.1 顺势去掉了 bootstrap 支持，`bootstrap.yml` 中的配置不会再被读取。

- 接入：在 `application.yml` 中写 `spring.config.import: nacos:order-service.yaml`，可导入多个 dataId，后导入的优先级更高
- 不带 `optional:` 时 Nacos 不可达或 dataId 不存在会启动失败，核心配置建议这样强制暴露问题
- 数据源这类不应运行时变更的配置加 `refreshEnabled=false`
- 升级时把 `bootstrap.yml` 中的 Nacos 地址、命名空间、共享配置全部迁到 `application.yml`

→ 详见 [配置中心](/spring-cloud/4_config_center#_1、依赖与-spring-config-import)

### Q33：配置中心动态刷新的原理是什么？Nacos 1.x 长轮询与 2.x 推送有什么区别？

**核心结论**：服务端只发「变更通知」，客户端收到后**主动拉取**内容并比对 MD5，确有变化才触发刷新：`NacosContextRefresher` 发布 `RefreshEvent` → `ContextRefresher` 重新加载配置源、计算变化的键并发布 `EnvironmentChangeEvent` → `ConfigurationPropertiesRebinder` 重绑定属性类，`RefreshScope.refreshAll()` 销毁 `@RefreshScope` Bean。

| 维度 | Nacos 1.x | Nacos 2.x / 3.x |
|------|-----------|-----------------|
| 感知变更 | HTTP 长轮询：带 MD5 请求，服务端挂起约 29.5s | gRPC 长连接，服务端主动推送 |
| 无变更时 | 挂起到期返回 200 空结果（不是 304），客户端立即发起下一轮 | 无请求，连接保持 |
| 服务端压力 | 每个客户端持续占一个挂起请求 | 连接复用，压力显著降低 |

- 客户端还会定期全量比对 MD5 兜底，并把配置写入本地快照，Nacos 不可用时也能用快照启动
- Apollo 用 HTTP 长轮询 + 定时拉取兜底

→ 详见 [配置中心](/spring-cloud/4_config_center#三、动态刷新原理)

### Q34：`@RefreshScope` 的原理是什么？`@Value` 与 `@ConfigurationProperties` 的刷新有什么区别？

**核心结论**：`@RefreshScope` Bean 实际注入的是**作用域代理**，刷新时销毁缓存的目标对象，下一次方法调用时用新配置**重建**；`@ConfigurationProperties`（JavaBean 写法）不需要 `@RefreshScope`，`EnvironmentChangeEvent` 触发 `ConfigurationPropertiesRebinder` **原地重新绑定**同一个实例。`@Value` 注入的字段只有所在 Bean 标了 `@RefreshScope` 才会更新。

| 维度 | `@ConfigurationProperties` 重绑定 | `@RefreshScope` |
|------|--------------------------------|-----------------|
| 行为 | 同一实例，字段被覆盖 | 销毁目标对象，懒重建 |
| 副作用 | 初始化时算出的派生状态（如按配置建的线程池）不更新 | 重新执行初始化逻辑，持有连接、定时任务的 Bean 会被反复创建 |
| 适用 | 绝大多数业务参数 | 少数需要整体重建的 Bean |

- record 等构造器绑定的属性类不可变，不会被重绑定
- 重建失败（新配置非法）时异常抛到业务请求上，上线前用 `@Validated` 校验配置；需要在变化时执行动作，监听 `EnvironmentChangeEvent`

→ 详见 [配置中心](/spring-cloud/4_config_center#_2、读取配置)

## 七、调用与网关

### Q35：OpenFeign 还推荐用吗？HTTP Service Clients 如何接入负载均衡？

**核心结论**：Spring Cloud OpenFeign 自 2022.0 起**功能冻结**，只修缺陷，仍随 2025.1 发布、存量项目可继续用；官方建议新项目迁移到 Spring Framework 的 **HTTP Service Clients**（`@HttpExchange` 接口）。Framework 7 用 `@ImportHttpServices` 按组注册客户端代理，**Spring Cloud LoadBalancer 5.0 起为每个组自动接入负载均衡**：组没配 `base-url` 时默认 `http://<组名>`，组名就是注册中心里的服务名。

- 依赖只需 `spring-cloud-starter-loadbalancer` 与注册中心 starter；`base-url` 写成普通地址时不接入负载均衡，适合调外部 API
- 按组统一加请求头、拦截器用 `RestClientHttpServiceGroupConfigurer`；命令式调用用 `@LoadBalanced RestClient.Builder`
- 迁移成本主要在注解替换：`@FeignClient` + `@GetMapping` → `@HttpExchange` + `@GetExchange`

→ 详见 [服务通信](/spring-cloud/3_communication#二、http-service-clients-推荐)

### Q36：OpenFeign 的工作原理是什么？为什么配置了 fallback 却不生效？

**核心结论**：启动时 `@EnableFeignClients` 导入 `FeignClientsRegistrar`（`ImportBeanDefinitionRegistrar`），为每个 `@FeignClient` 接口注册 `FeignClientFactoryBean`，`getObject()` 用 `SpringMvcContract` 解析 `@GetMapping` 等注解，组装 Encoder / Decoder / 拦截器，最终用 **JDK 动态代理**生成实现；调用时按方法元数据构建 `RequestTemplate` → 执行 `RequestInterceptor` → LoadBalancer 把服务名解析为实例 → HTTP 客户端发送 → Decoder 解析响应，非 2xx 交给 `ErrorDecoder`。

**只写 `fallback` 不会生效**，必须开启熔断集成之一：

| 方案 | 依赖 | 开关 |
|------|------|------|
| Spring Cloud CircuitBreaker + Resilience4j | `spring-cloud-starter-circuitbreaker-resilience4j` | `spring.cloud.openfeign.circuitbreaker.enabled: true` |
| Sentinel | `spring-cloud-starter-alibaba-sentinel` | `feign.sentinel.enabled: true` |

- 默认超时连接 10s、读取 60s，远大于合理值，必须按服务显式配置；默认不重试，开启时只对幂等接口
- 写接口的降级不能静默返回成功；需要区分「熔断拒绝」与「下游报错」用 `fallbackFactory`

→ 详见 [服务通信](/spring-cloud/3_communication#_2、降级生效的前提)

### Q37：Spring Cloud LoadBalancer 有哪些内置能力？如何基于它实现灰度路由？

**核心结论**：SCL 是客户端负载均衡，替代了 2020.0 移除的 Ribbon，默认轮询。内置能力通过 `spring.cloud.loadbalancer.configurations` 或 `ServiceInstanceListSupplier` 构建器组合：

| 能力 | 说明 |
|------|------|
| 轮询 / 随机 | 默认 `RoundRobinLoadBalancer`，可配置 `RandomLoadBalancer` |
| 区域优先 | `zone-preference`，同区无实例时用全部 |
| Hint 路由 | `withHints()`，按请求头与实例元数据 `hint` 等值匹配，找不到回落到全部实例 |
| 加权 | `weighted`（Commons 4.1 / 2023.0 起），按元数据 `weight` |
| 子集 | `subset`，每个调用方只连部分实例 |
| API 版本 | `api-version`（Commons 5.0 起），按元数据 `API_VERSION` 匹配 |
| 健康检查 / 粘滞 | `health-check`、`same-instance-preference`、`request-based-sticky-session` |

灰度路由：等值匹配（如 `X-Version: canary`）直接用 Hint；规则更复杂（按用户 ID 百分比放量、无标记请求必须避开灰度实例）时实现 `ReactorServiceInstanceLoadBalancer`，从 `RequestDataContext` 读请求头选实例。**灰度标记必须逐跳透传**，否则第二跳之后就回到稳定版本。

- 实例列表缓存 TTL 计入下线感知延迟；算法原理见高可用答案页

→ 详见 [服务治理](/spring-cloud/5_service_governance#二、负载均衡-spring-cloud-loadbalancer)、[开发总结 - 高可用](/interview/14_high_avail#q16-服务端负载均衡与客户端负载均衡-spring-cloud-loadbalancer-有什么区别)

### Q38：API 网关的作用是什么？Route、Predicate、Filter 分别是什么，请求如何流转？

**核心结论**：网关把鉴权、限流、跨域、灰度、日志等横切关注点收敛到统一入口，客户端只访问网关，内部拓扑不外泄。**Route** 是基本单元（ID + 目标 URI + 断言 + 过滤器），**Predicate** 判断请求是否命中路由（Path / Method / Header / Weight 等），**Filter** 分路由级 `GatewayFilter` 与全局 `GlobalFilter`。

请求流转（Server WebFlux）：

1. `RoutePredicateHandlerMapping` 按顺序匹配断言，命中第一个即停止
2. `FilteringWebHandler` 合并 `GlobalFilter` 与该路由的 `GatewayFilter`，按 `Order` 排成链
3. `chain.filter(exchange)` 之前是 Pre 逻辑，之后是 Post 逻辑
4. `ReactiveLoadBalancerClientFilter` 把 `lb://order-service` 解析为实例，`NettyRoutingFilter` 转发
5. 响应沿过滤链逆序返回

- Server WebFlux 运行在事件循环上，**过滤器里禁止阻塞调用**（同步查 Redis / JDBC）
- 常见分层：入口用 Nginx / APISIX / Envoy 做流量网关，其后用 Spring Cloud Gateway 做业务网关

→ 详见 [API 网关](/spring-cloud/2_api_gateway#二、核心概念与请求链路)

### Q39：Gateway Server WebFlux 与 Server MVC 如何选？2025.x 的依赖与配置前缀有何变化？

**核心结论**：Spring Cloud 2025.0 起 Gateway 拆成两个独立实现，**2025.1 删除了旧的 `spring-cloud-starter-gateway` 等 artifact**，配置前缀同步改名，两者只能选一个。

| 维度 | Server WebFlux | Server MVC |
|------|---------------|-----------|
| Starter | `spring-cloud-starter-gateway-server-webflux` | `spring-cloud-starter-gateway-server-webmvc` |
| 配置前缀 | `spring.cloud.gateway.server.webflux.*` | `spring.cloud.gateway.server.webmvc.*` |
| 运行模型 | Reactor Netty，非阻塞 | Servlet 容器，可配合虚拟线程 |
| 过滤器 | `GlobalFilter` / `GatewayFilter`，返回 `Mono<Void>` | `HandlerFilterFunction` |
| 适合 | 高并发入口、长连接、功能最全（Redis 令牌桶、TokenRelay） | 团队不熟悉响应式、过滤器要调阻塞 API |

- **旧的 `spring.cloud.gateway.routes` 等键在 2025.1 不再生效，路由会静默丢失**；升级后用 actuator 的 `gateway/routes` 端点核对，OpenRewrite 有批量改前缀的配方

→ 详见 [API 网关](/spring-cloud/2_api_gateway#一、两种形态-server-webflux-与-server-mvc)

### Q40：网关统一鉴权怎么做？如何防止下游收到伪造的用户请求头？

**核心结论**：标准做法是让网关成为 **OAuth2 Resource Server**，由 Spring Security 完成 JWT 验签、过期与签发方校验（Boot 4 starter 为 `spring-boot-starter-security-oauth2-resource-server`），而不是手写 JWT 解析过滤器。验签通过后把用户标识写入请求头透传给下游，**写入前必须先删除客户端自带的同名请求头**，否则外部请求可以直接伪造身份。

- Spring Security 的 `WebFilter` 在 `DispatcherHandler` 之前执行，`GlobalFilter` 中能拿到已认证的 `Principal`
- 下游只信任网关注入的请求头的前提是**下游只能从网关访问**（网络隔离）；否则原样转发 `Authorization` 让下游再做一次资源服务器校验
- 网关同时作为 OAuth2 Client（BFF）时用 `TokenRelay` 过滤器转发 Access Token

→ 详见 [API 网关](/spring-cloud/2_api_gateway#四、统一鉴权-网关作为-oauth2-资源服务器)、[JWT 令牌机制](/security/1_jwt)

### Q41：网关灰度路由为什么不能用路由 metadata？正确做法是什么？

**核心结论**：路由上的 `metadata` **不会传给负载均衡器**，不能用来选实例。正确做法有两种：

| 做法 | 实现 | 特点 |
|------|------|------|
| 按权重切到独立服务 | 灰度版本注册成独立服务名（如 `order-service-canary`），用 `Weight` 断言按比例分流 | 简单，同一用户的多次请求可能落到不同版本 |
| 按请求头选实例 | 灰度与稳定实例同名、用实例元数据区分；网关把请求头放进 `RequestDataContext`，LoadBalancer 的 Hint 过滤器或自定义 `ReactorServiceInstanceLoadBalancer` 据此选实例 | 可按用户、标记精确控制 |

- 实例列表供应链要配置 `withDiscoveryClient().withCaching().withHints()`；灰度标记必须逐跳透传
- 蓝绿、金丝雀等整体发布策略见高可用模块

→ 详见 [API 网关](/spring-cloud/2_api_gateway#七、灰度路由)

## 八、服务治理

### Q42：Netflix 组件（Ribbon、Hystrix、Zuul、Sleuth）分别被什么替代？为什么被替换？

**核心结论**：2018 年 Netflix 把 Hystrix、Ribbon 等转入维护模式，Zuul 1 基于阻塞 IO 不适合高并发网关，Spring 随后提供了自己的抽象与实现，Spring Cloud **2020.0 起移除了 Ribbon、Hystrix、Zuul**。

| 原组件 | 现状 | 替代方案 |
|--------|------|---------|
| Ribbon | 2020.0 移除 | Spring Cloud LoadBalancer |
| Hystrix | 2020.0 移除 | Spring Cloud CircuitBreaker + Resilience4j、Sentinel |
| Zuul 1 | 2020.0 移除 | Spring Cloud Gateway |
| Archaius | 2020.0 移除 | Spring Cloud Config、Nacos Config |
| Eureka | 仍随 Spring Cloud Netflix 发布，只维护 | Nacos、Consul、Kubernetes Service |
| Sleuth | 2022.0 起不再发布（最后为 3.1.x，不支持 Boot 3） | Micrometer Tracing + OpenTelemetry |
| OpenFeign（非 Netflix，作对照） | 2022.0 起功能冻结 | HTTP Service Clients |

- Spring Cloud Config 不是 Netflix 组件，仍在维护，随 2025.1 发布

→ 详见 [Spring Cloud 总览](/spring-cloud/0_overview#三、版本与选型速查)

### Q43：什么是服务雪崩？Spring Cloud 中有哪些治理手段？

**核心结论**：下游变慢 → 调用方线程阻塞等待 → 线程池 / 连接池耗尽 → 调用方也不可用 → 故障沿调用链反向扩散。治理靠**超时、限流、熔断、降级、隔离、有节制的重试**组合，策略原理与阈值见高可用答案页，这里只对应 Spring Cloud 的落地组件：

| 手段 | Spring Cloud 落地 |
|------|------------------|
| 超时 | HTTP Service Clients / `RestClient` / OpenFeign 显式配置，逐层递减 |
| 限流 | Sentinel、Gateway `RequestRateLimiter` |
| 熔断降级 | Resilience4j（CircuitBreaker 抽象）、Sentinel |
| 隔离 | Resilience4j Bulkhead、Sentinel 并发线程数 |
| 重试 | 只对幂等接口、只在一层；Framework 7 `@Retryable` 或 Resilience4j Retry |
| 优雅上下线 | 先注销、等调用方刷新实例列表、再停机 |

→ 详见 [服务治理](/spring-cloud/5_service_governance#一、服务治理全景)、[开发总结 - 高可用](/interview/14_high_avail#五、熔断)

### Q44：Sentinel 的核心原理（Slot 链、滑动窗口）是什么？

**核心结论**：每个资源（`@SentinelResource` 方法、URL、Feign 方法）进入时依次经过一条**责任链（ProcessorSlotChain）**：前面的 Slot 负责构建调用树与**实时统计**，后面的 Slot 依据统计结果做**规则校验**，任一规则不通过就抛 `BlockException`。

| Slot | 作用 |
|------|------|
| `NodeSelectorSlot` / `ClusterBuilderSlot` | 构建调用树与统计节点 |
| `StatisticSlot` | 统计 QPS、RT、线程数、异常数 |
| `AuthoritySlot` / `SystemSlot` | 黑白名单 / 系统自适应保护 |
| `ParamFlowSlot` | 热点参数限流 |
| `FlowSlot` / `DegradeSlot` | 流控 / 熔断规则校验 |

统计用**滑动时间窗口 `LeapArray`**：默认 1 秒切成 2 个 500ms 桶，环形数组复用桶，按当前时间定位桶累加，统计时汇总窗口内的有效桶，避免固定窗口的边界突刺。

→ 详见 [限流与过载保护](/high-avail/7_rate_limiting#八、sentinel-限流)、[Spring Cloud Alibaba](/spring-cloud/6_alibaba#三、sentinel-流控与熔断)

### Q45：Sentinel 有哪些流控效果和熔断策略？规则如何持久化？

**核心结论**：流控按 QPS 或并发线程数，效果有**快速失败**（默认）、**Warm Up**（冷启动逐步放量）、**匀速排队**（漏桶，削峰）；熔断策略有**慢调用比例、异常比例、异常数**三种，状态机为 Closed → Open → Half-Open。阈值怎么定、`blockHandler` 与 `fallback` 的区别见高可用答案页。

规则持久化：

- 默认规则只存在应用内存，**重启即丢**，生产引入 `sentinel-datasource-nacos`，启动时从 Nacos 拉取规则并监听变更
- **数据流向是单向的**：只有 Nacos → 应用；开源控制台默认把规则推到应用内存、不写回 Nacos，控制台改的规则重启后丢失，还可能被 Nacos 的下一次推送覆盖
- 两种做法：约定只在 Nacos 改规则、控制台只看监控；或改造 Dashboard 实现 `DynamicRuleProvider` / `DynamicRulePublisher`，形成「控制台 → Nacos → 应用」

→ 详见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba#_5、规则持久化-nacos-数据源)、[开发总结 - 高可用](/interview/14_high_avail#q31-sentinel-规则持久化到-nacos-后-控制台修改的规则为什么重启会丢失)

### Q46：Framework 7 的 `@Retryable` / `@ConcurrencyLimit` 与 Resilience4j、Sentinel 如何分工？

**核心结论**：**简单重试与并发限制**用 Framework 7 内置（`@EnableResilientMethods` 开启，无额外依赖）；需要**熔断状态机、慢调用统计、舱壁、时间限制**用 Resilience4j（Boot 4 下通过 Spring Cloud CircuitBreaker 5.0 的 `CircuitBreakerFactory` 接入，换实现不改业务代码）；需要**控制台动态调规则、热点参数限流、系统自适应保护**用 Sentinel。

| 能力 | Framework 7 | Resilience4j | Sentinel |
|------|------------|--------------|----------|
| 重试 | `@Retryable` / `RetryTemplate` | Retry | — |
| 并发限制 | `@ConcurrencyLimit`（单实例） | Bulkhead | 并发线程数流控 |
| 熔断 | 无 | 有 | 有 |
| 动态规则 | 无 | 配置文件为主 | 控制台 + Nacos |

- 三者叠加时注意重试只在一层开启；Resilience4j 注解写法在 Boot 4 上以其官方发布的兼容版本为准

→ 详见 [服务治理](/spring-cloud/5_service_governance#_2、framework-7-内置容错注解)、[Retry 重试](/spring/6_retry)

### Q47：如何按 API 版本把请求路由到不同实例？

**核心结论**：服务端用 Framework 7 内置的 API 版本控制声明版本（`@GetMapping(path = "/orders/{id}", version = "2")`，Boot 4 用 `spring.mvc.apiversion.*` 配置版本从请求头、查询参数、路径或媒体类型读取）；客户端侧 Spring Cloud LoadBalancer 5.0 的 `api-version` 配置按请求携带的版本，只选实例元数据 `API_VERSION` 匹配的实例，让 v1、v2 实例**同名注册、按版本分流**。

- 前提仍是接口向后兼容：只增不删字段，破坏性变更才发新版本，并用契约测试在 CI 中发现对调用方的破坏

→ 详见 [服务治理](/spring-cloud/5_service_governance#六、服务版本与兼容性)

## 九、分布式事务

### Q48：Seata AT 模式的原理是什么？一阶段和二阶段分别做了什么？

**核心结论**：AT 模式靠**数据源代理自动生成回滚日志**实现两阶段：一阶段业务 SQL 直接提交，二阶段提交只需异步删日志，回滚时按前镜像补偿。三个角色：TC（独立部署的 seata-server）、TM（`@GlobalTransactional` 发起方）、RM（各参与方的数据源代理）。

| 阶段 | 做什么 |
|------|-------|
| 一阶段 | RM 拦截业务 SQL，查询修改前后的数据作为前 / 后镜像写入 `undo_log`，与业务 SQL 在**同一本地事务**提交；提交前向 TC 注册分支并获取被修改行的**全局锁**；本地提交后立即释放数据库行锁 |
| 二阶段提交 | TC 通知各分支异步删除 `undo_log`、释放全局锁，开销很小 |
| 二阶段回滚 | 用后镜像校验当前数据未被全局事务之外的写入修改，再按前镜像生成反向 SQL 补偿 |

- Seata 2.x 归属 Apache，groupId 与包名为 `org.apache.seata`；每个参与方库建 `undo_log` 表，参与方方法不加 `@GlobalTransactional`
- XID 需随调用透传：starter 为 OpenFeign 等常用客户端自动处理，其他客户端要自己把 `RootContext.getXID()` 放进 `TX_XID` 请求头；下游返回错误码而不抛异常时，发起方要自己抛异常，否则全局事务会被提交

→ 详见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba#_2、at-模式两阶段)

### Q49：Seata AT 模式的读写隔离如何保证？什么情况下回滚会失败？

**核心结论**：**写隔离**靠全局锁：同一行在全局事务结束前不会被另一个全局事务修改。**读隔离**在全局层面默认是**读未提交**：其他事务可能读到一阶段已提交、但最终会回滚的数据；需要读已提交时对读语句使用 `SELECT ... FOR UPDATE`，由 Seata 代理检查全局锁。

回滚失败的主要来源是**不经过 Seata 数据源代理的写入**（其他系统、运维脚本直接改库）：它们不受全局锁约束，二阶段回滚时后镜像与当前数据对不上（脏写），无法自动回滚，只能人工处理。

→ 详见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba#_2、at-模式两阶段)

### Q50：Seata AT、TCC、Saga、XA 模式如何选择？

**核心结论**：关系库常规 CRUD 用 AT（无侵入）；资金类、需要资源预留或涉及非数据库资源用 TCC；长流程、跨外部系统用 Saga；数据库支持 XA、要求强一致且并发不高用 XA。四种模式的原理对比、TCC 的空回滚 / 悬挂 / 幂等见分布式答案页。

| 模式 | 侵入性 | 隔离方式 |
|------|-------|---------|
| AT | 无，依赖数据源代理 | 全局锁保证写隔离，读默认未提交 |
| TCC | 高，每个操作写 Try / Confirm / Cancel | Try 预留资源 |
| Saga | 中，每步写补偿 | 无隔离，靠补偿与业务设计 |
| XA | 无，依赖数据库 XA | 数据库锁持续到二阶段结束 |

→ 详见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba#_4、模式选择)、[开发总结 - 分布式](/interview/10_distributed#四、分布式事务有哪些解决方案)

## 十、消息与链路

### Q51：Spring Cloud Stream 解决什么问题？`@StreamListener` 还能用吗？

**核心结论**：在业务代码与具体 MQ 之间加一层 **Binder 抽象**：业务只写 `Supplier` / `Function` / `Consumer` Bean，不出现任何 MQ API，换 MQ = 换 Binder 依赖 + 改配置，还能用 Test Binder 免起中间件做测试。**`@StreamListener` 等注解模型在 Stream 4.0（2022.0）已移除**，只剩函数式模型；由业务事件触发的发送用 `StreamBridge`。

- 代价：屏蔽了各 MQ 的高级特性（RocketMQ 事务消息与定时消息、Kafka Streams、精确一次调优），用得越深越该直连原生客户端
- Binding 命名为 `<函数名>-in-<N>` / `<函数名>-out-<N>`；函数 Bean 不能叫 `notify`、`wait` 等与 `Object` final 方法同名的名字
- Stream 构建在 Spring Integration 之上；RocketMQ Binder 由 Spring Cloud Alibaba 提供

→ 详见 [Spring Cloud Stream](/spring-cloud/7_stream#一、解决什么问题)

### Q52：Spring Cloud Stream 如何配置消费组、重试与死信？

**核心结论**：**生产环境每个消费 Binding 都必须显式配置 `group`**：不配时每个实例是匿名订阅者（广播），且匿名订阅不持久化，重启期间的消息会丢；配了之后同组实例竞争消费。重试默认是消费线程内的本地重试，耗尽后进入死信，由人工或定时任务兜底。

| 配置 | 说明 |
|------|------|
| `group` | 同组竞争、不同组广播 |
| 分区 | `partition-key-expression` 保证同一业务键有序；Kafka Binder 交给 Kafka 原生分区分配 |
| 本地重试 | `max-attempts`、退避参数；会阻塞消费线程，不宜过大 |
| 死信 | Kafka 用 `enable-dlq`，RabbitMQ 用 `auto-bind-dlq` |

- 重试与 Rebalance 都会导致重复投递，消费逻辑必须幂等；在本地事务里直接发消息有不一致风险，用事务消息或 Outbox

→ 详见 [Spring Cloud Stream](/spring-cloud/7_stream#三、核心机制)

### Q53：Sleuth 之后用什么做链路追踪？traceId 如何跨服务、跨线程、跨 MQ 传递？

**核心结论**：Spring Cloud Sleuth 不支持 Boot 3，2022.0 起不再发布；Boot 3+ / 4 统一用 **Micrometer Tracing**（桥接 Brave 或 OpenTelemetry，导出到 Zipkin、OTLP 等），Boot 4 还提供 `spring-boot-starter-opentelemetry`。Observation API 一次埋点同时产出指标与 Span，Web、`RestClient`、HTTP Service Clients、Kafka 等组件自动埋点。

| 场景 | 传递方式 |
|------|---------|
| HTTP 跨服务 | 请求头：W3C `traceparent`（默认）或 B3 `X-B3-TraceId` |
| 进程内 | 当前 Span 存在 ThreadLocal，同时写入 MDC，日志模板输出 traceId |
| 线程池 / `@Async` | `TaskDecorator` 或 Micrometer `ContextSnapshot` 包装 |
| 响应式 | `spring.reactor.context-propagation=auto` |
| MQ | 生产者把上下文写入消息头，消费者取出续接 |
| Dubbo / gRPC | Attachment / Metadata |

- 采样率 `management.tracing.sampling.probability` 默认 0.1；无侵入方案是 SkyWalking / OpenTelemetry Java Agent 字节码增强

→ 详见 [日志](/spring-boot/12_logging#五、mdc-与-traceid-传递)、[链路追踪](/observability/3_tracing)、[OpenTelemetry](/observability/5_opentelemetry)

---
description: 服务拆分、网关 / BFF / 服务发现、数据管理、可靠性、可观测与测试、Sidecar / 绞杀者
---

# 微服务设计模式

> **本篇目标**：建立微服务模式的整体地图，知道每类问题有哪些标准解法、各自适用什么场景，并能顺着链接找到对应模式的详细文档。
>
> **前置阅读**：[微服务优势与挑战](./1_pros_and_cons)

微服务设计模式与 GoF 设计模式（见 [设计模式总览](/patterns/0_overview)）不在同一层面：GoF 解决类与对象的组织问题，微服务模式解决**分布式系统架构层面**的问题——服务怎么拆、怎么通信、数据怎么管、失败怎么兜底。本篇是一份模式目录：每个模式说清「解决什么问题、何时使用」，已有主文档的模式只给一句话和链接。

| 类别 | 模式 |
|------|------|
| 拆分 | 按业务能力拆分、按限界上下文拆分 |
| 通信 | API 网关、BFF、服务发现、同步与异步通信 |
| 数据 | Database per Service、API Composition、CQRS、Event Sourcing |
| 可靠性 | 熔断、超时 / 重试 / 隔离、限流、Saga、Outbox |
| 可观测与测试 | 分布式追踪、健康检查 API、外部化配置、消费者驱动契约测试 |
| 部署与迁移 | Sidecar、绞杀者 |

---

## 一、服务拆分模式

### 1、按业务能力拆分（Decompose by Business Capability）

按「企业做什么」划分服务，每个服务对应一项相对稳定的业务能力。以电商为例：

| 服务 | 负责的业务能力 |
|------|---------------|
| 用户服务 | 注册、登录、个人信息 |
| 商品服务 | 商品信息、类目、上下架 |
| 库存服务 | 库存扣减、预占与释放 |
| 订单服务 | 下单、取消、订单查询 |
| 支付服务 | 支付、退款、对账 |
| 通知服务 | 短信、邮件、App 推送 |

**适用**：业务能力清晰、各能力演化速度不同。业务能力比组织结构和技术分层稳定，因此服务边界也更稳定。

### 2、按限界上下文拆分（Decompose by Subdomain）

用 DDD 的限界上下文划定服务边界：同一个词在不同上下文中含义不同，各自独立建模。例如「订单」在订单上下文关注商品、金额和状态机，在物流上下文关注收货地址和运单号，在财务上下文关注税额和发票。每个上下文一个模型、一个服务，服务间通过事件或 API 协作，不共享数据库。这是目前最推荐的拆分方法，限界上下文的识别与上下文映射见 [DDD 领域驱动设计](/architecture/3_ddd)。

**拆分时机**：不要过早拆分。拆分的信号（发布互相阻塞、迭代节奏差异大、扩展需求不同）见 [微服务优势与挑战](./1_pros_and_cons)。

---

## 二、通信模式

### 1、API 网关（API Gateway）

客户端不直接访问各个服务，而是经由统一网关完成路由、鉴权、限流、协议转换和响应聚合。网关负责南北向流量，服务间的东西向流量交给服务调用框架或服务网格。Spring Cloud Gateway 的用法见 [API 网关](/spring-cloud/2_api_gateway)。

### 2、BFF（Backend for Frontend）

为不同类型的客户端分别提供专属的聚合层，避免一个「万能网关」被各端需求拉扯：

![BFF：为不同客户端提供专属聚合层](../assets/microservices/bff.svg)

| 客户端 | 聚合层 | 职责 |
|--------|--------|------|
| 移动端 App | BFF-Mobile | 裁剪响应字段、合并请求，适配弱网与小屏 |
| Web 前端 | BFF-Web | 聚合多个服务的数据，按页面结构定制接口 |
| 第三方开发者 | 开放 API 网关 | OAuth2 授权、配额与限流、稳定的对外契约 |

**适用**：不同客户端对数据格式、字段、协议的需求差异较大，且各端由不同团队负责。BFF 应由对应前端团队拥有，只做聚合与适配，不承载核心业务规则。

### 3、服务发现（Service Discovery）

服务实例的地址随扩缩容和发布不断变化，需要注册中心维护实例清单：

| 方式 | 做法 | 代表 |
|------|------|------|
| 客户端发现 | 调用方从注册中心拉取实例列表，本地做负载均衡后直连 | Nacos / Eureka + Spring Cloud LoadBalancer、Dubbo |
| 服务端发现 | 调用方只访问一个固定地址，由平台转发到健康实例 | Kubernetes Service、服务网格 |

注册中心的选型与原理见 [注册发现](/spring-cloud/1_service_registry)。

### 4、同步与异步通信

| 场景 | 推荐方式 |
|------|---------|
| 需要立即得到结果 | HTTP Service Clients（`@HttpExchange`）/ OpenFeign（存量项目）/ gRPC / Dubbo |
| 可以异步处理、需要削峰或解耦 | 消息队列（Kafka / RocketMQ / RabbitMQ） |
| 读多写少、查询模型差异大 | CQRS + 领域事件异步同步读模型 |

Spring Cloud OpenFeign 已进入功能完备（feature-complete）状态，只做维护不再加新特性；新项目优先用 Spring Framework 的 HTTP Service Clients（基于 `RestClient` / `WebClient` 的 `@HttpExchange` 接口）。两者的写法对比见 [服务通信](/spring-cloud/3_communication)，消息队列的可靠性与幂等见 [消息队列基础](/messaging/1_basics)。

---

## 三、数据管理模式

### 1、Database per Service

每个服务独占自己的数据存储，其他服务只能通过它的 API 或事件访问这些数据：

| 服务 | 数据存储 |
|------|---------|
| order-service | order_db（MySQL） |
| product-service | product_db（MySQL）+ 搜索索引（Elasticsearch） |
| user-service | user_db（MySQL） |
| session-service | 专用 Redis，不与其他服务共享 |

「独占」指逻辑上的所有权，不一定是物理上的独立实例：同一个 MySQL 实例上的不同 schema、只授权给对应服务的账号也能满足要求。**禁止**多个服务直接读写同一张表——这会形成隐式耦合，任何 DDL 变更都会波及多个服务。

代价是跨服务查询和跨服务事务变难，下面的 API Composition、CQRS 与可靠性一节的 Saga 正是为此而生。

### 2、API Composition

跨服务查询时，由一个组合者（API 网关、BFF 或专门的查询服务）依次或并行调用各服务，再在内存中拼接结果。例如订单详情页并行查询订单、商品、物流三个服务后组装返回。

**适用**：数据量小、实时性要求高的简单查询。若需要跨服务做分页、排序、复杂过滤或大批量关联，内存拼接代价过高，应改用 CQRS 物化一个专门的读模型。

### 3、CQRS（命令查询职责分离）

写模型与读模型分离：写端保持规范化与强一致，通过领域事件异步更新为查询优化的读模型（如 Elasticsearch 宽表）。在微服务中它常用来解决「Database per Service 之后跨服务查询难」的问题，代价是读写之间的最终一致延迟。原理、模型与实现见 [架构模式与风格](/architecture/2_arch_patterns)。

### 4、Event Sourcing（事件溯源）

不存当前状态，而是把状态变化的事件序列作为唯一事实来源，当前状态由重放事件得到。它天然产出领域事件，可与 CQRS、Saga 配合；适合需要完整审计与历史回溯的场景（账户、订单），但建模、事件版本演进和快照的复杂度高，需谨慎引入。详见 [架构模式与风格](/architecture/2_arch_patterns)。

---

## 四、可靠性模式

### 1、熔断器（Circuit Breaker）

下游失败率或慢调用比例超过阈值时快速失败，避免故障沿调用链扩散成雪崩；一段时间后半开试探，恢复后自动关闭。状态机与参数调优见 [熔断](/high-avail/5_circuit_breaking)，Spring Cloud 中的接入见 [服务治理](/spring-cloud/5_service_governance)。

### 2、超时、重试与隔离

每个远程调用都要设超时；重试只用于幂等操作并配退避与上限；用线程池或信号量隔离（舱壁）防止一个慢依赖耗尽全部资源。详见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

### 3、限流

在网关和服务入口限制请求速率与并发，保护系统不被突发流量压垮。算法与分布式限流见 [限流与过载保护](/high-avail/7_rate_limiting)。

### 4、Saga

把跨服务的长事务拆成一串本地事务，每一步失败时按逆序执行补偿操作，实现最终一致。分编排式（Orchestration，由协调者集中驱动）与协同式（Choreography，各服务监听事件自主推进）两种：步骤多、补偿逻辑复杂时选编排式，步骤少、追求解耦时选协同式。两种协调模式、与 TCC 的区别及 Seata Saga 见 [分布式事务](/distributed/4_transaction)。

### 5、Outbox（事务发件箱）

解决「写数据库」和「发消息」的原子性问题：业务数据与待发消息在**同一个本地事务**里写入业务表和 outbox 表，再由独立的投递进程把 outbox 中的消息发到 MQ，投递成功后标记完成，消费端按业务键幂等。投递进程可以轮询 outbox 表，也可以用 Debezium 等 CDC 工具监听 binlog（Debezium 提供 Outbox Event Router），后者延迟更低、不给业务库加轮询压力。本地消息表方案见 [分布式事务](/distributed/4_transaction)，CDC 投递见 [CDC 工具](/database/5_practice/0_cdc_tools)，消息侧的可靠投递与幂等消费见 [消息队列基础](/messaging/1_basics)。

---

## 五、可观测与测试模式

### 1、分布式追踪（Distributed Tracing）

为每个外部请求分配 TraceId，在服务间调用时传播上下文，记录每一跳的 Span，用于定位慢调用与错误。Spring Boot 通过 Micrometer Tracing 接入，标准协议是 W3C Trace Context 与 OpenTelemetry，见 [链路追踪](/observability/3_tracing) 与 [OpenTelemetry](/observability/5_opentelemetry)。

### 2、健康检查 API（Health Check API）

每个服务暴露健康检查端点，供注册中心、负载均衡和 Kubernetes 探针判断实例能否接收流量。Spring Boot Actuator 提供 `/actuator/health` 以及 `liveness` / `readiness` 分组，与 Kubernetes 的存活探针、就绪探针一一对应；就绪检查只应包含「不可用就不该接流量」的依赖，避免一个下游故障导致全部实例被摘除。

### 3、外部化配置（Externalized Configuration）

同一个制品在不同环境运行，配置（数据库地址、开关、阈值）从环境变量、Kubernetes ConfigMap / Secret 或配置中心注入，支持不重新打包就修改甚至动态刷新。配置中心的选型与用法见 [配置中心](/spring-cloud/4_config_center)。

### 4、消费者驱动契约测试（Consumer-Driven Contract）

由调用方声明自己依赖的接口契约（请求与期望响应），提供方在 CI 中用这些契约验证自己的实现，接口一旦破坏调用方就构建失败。它用比端到端测试低得多的成本守住服务间接口。常用工具是 Spring Cloud Contract 与 Pact，见 [契约测试](/testing/6_contract_test)。

---

## 六、部署与迁移模式

### 1、Sidecar

把通用能力（流量代理、mTLS、遥测、配置同步）放进与业务容器同 Pod 部署的独立进程，业务代码无需引入 SDK、也不限语言。它是服务网格数据面的经典形态，Istio 的 Sidecar 模式与无 Sidecar 的 Ambient 模式对比见 [服务网格](./3_service_mesh)。

### 2、绞杀者（Strangler Fig）

在单体前加网关，把模块逐个抽取为新服务并切换路由，直到单体可以下线；任何一步出问题都能把路由切回单体。迁移步骤、抽取顺序与数据迁移见 [微服务优势与挑战](./1_pros_and_cons)。

---

## 小结

- 微服务模式解决的是分布式架构问题，与 GoF 模式不在同一层面
- 拆分优先按限界上下文，按业务能力拆分是更粗粒度的起点；拆分时机看信号而不是规模数字
- 通信：网关管南北向，BFF 按客户端定制聚合；同步调用新项目用 HTTP Service Clients，OpenFeign 只做存量维护；能异步就用 MQ 解耦
- 数据：Database per Service 是前提，跨服务查询用 API Composition 或 CQRS，跨服务事务用 Saga，「写库 + 发消息」原子性用 Outbox
- 可靠性靠超时、重试、隔离、熔断、限流的组合；可观测性靠分布式追踪与健康检查；接口兼容靠契约测试

## 参考资料

- Microservice Architecture 模式目录（Chris Richardson）：[https://microservices.io/patterns/](https://microservices.io/patterns/)
- Spring Cloud OpenFeign：[https://spring.io/projects/spring-cloud-openfeign](https://spring.io/projects/spring-cloud-openfeign)
- Spring Framework REST Clients（HTTP Service Clients）：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)

> 下一篇：[服务网格](./3_service_mesh) —— 把服务治理从 SDK 下沉到基础设施层，看 Istio 的 Sidecar 与 Ambient 两种数据面。

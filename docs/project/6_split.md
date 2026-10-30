---
description: 先拆库存与支付、模块 api 变远程接口、按服务拆库与数据迁移、Nacos 与网关、HTTP 接口客户端、Kubernetes 部署
---

# 拆分服务

> 前置阅读：[工程搭建](./1_project_setup)、[服务拆分](/microservices/2_service_split)、[注册发现](/microservices/10_service_registry)

日订单涨到 100 万、团队扩到 20 人后，一个 jar 让 4 个小组的发布互相阻塞，库存和支付也没法单独扩容。本篇讲先拆什么、数据库怎么拆、Spring Cloud 选型与 Kubernetes 部署，基线为 Spring Boot 4、Spring Cloud 2025.1、Kubernetes 1.37。

---

## 一、背景

经过阶段二的 [引入缓存](./4_cache) 和 [异步化](./5_async)，数据库和下单链路都还扛得住，问题出在「人」和「发布」上：

- **量**：日订单 100 万，平均每秒 12 单，晚高峰下单约 300 QPS；活动时扣减集中在几十个爆款 SKU 上，支付回调也在开奖、整点时成批涌入
- **人**：20 人分成 4 个小组：交易组（订单）、商品与会员组（商品、用户）、库存组、支付组
- **发布**：`mall-app` 仍是唯一的可执行 jar，每周四统一发版，一次构建加全量回归约 2 小时；近一个月有 3 次因为别组的问题整包回滚，支付组接入新渠道的需求排了三周才上线
- **扩容**：活动时吃紧的只有库存扣减和支付回调，却只能把整个 `mall-app`（每实例 8 G 堆）成倍扩，连带数据库连接数一起翻倍
- **隔离**：支付渠道的商户密钥和证书对所有模块可见，任何一个模块的依赖漏洞都会波及支付

这正是 [服务拆分 · 什么时候该拆](/microservices/2_service_split#一、什么时候该拆、什么时候不该拆) 里列的三个信号：发布互相阻塞（别组问题导致整包回滚）、迭代节奏差异（支付组接渠道要快发，只能等每周四的大版本）、扩展需求不同（吃紧的只有库存扣减和支付回调），三者同时出现了。团队扩到 20 人只是背景，主文档并不按人数判断。

---

## 二、选项

### 1、拆到什么程度

| 方案 | 做法 | 好处 | 代价 |
|------|------|------|------|
| 继续单体 | 分支治理 + 发版火车，按模块开关功能 | 不增加任何中间件 | 发布仍是一个整体，扩容问题无解 |
| **先拆两个** | 拆出库存、支付，其余留在 `mall-app` | 解决最痛的两处，中间件一次到位，风险可控 | `mall-app` 里仍有两个组共用一个 jar |
| 全部拆开 | 订单、商品、用户、库存、支付各自成服务 | 每个组完全独立 | 一次引入 5 处远程调用和跨库一致性问题，20 人还要分出人维护平台 |

### 2、逐个模块评估

| 模块 | 拆出来的收益 | 拆出来的代价 | 结论 |
|------|------------|------------|------|
| 库存 | 写热点，活动时要单独扩容；库存组发布频繁 | 下单从本地事务变成跨服务调用 | **拆** |
| 支付 | 对接外部渠道，变更节奏与订单不同；密钥需要隔离；渠道变慢不能拖住订单线程 | 支付成功改订单状态变成跨服务 | **拆** |
| 商品 | 读多，但阶段二已有两级缓存，扩 `mall-app` 就够 | 下单计价多一次远程调用 | 暂不拆 |
| 用户 | 量小、变更少 | 几乎每个请求都要查用户 | 暂不拆 |
| 订单 | 核心域，交易组独占 | 依赖其余所有模块，最难拆 | 不拆，作为留在单体里的核心 |

先拆的标准是**边界清楚、收益明显、出错可回退**。库存和支付在阶段一就有独立的 `api` 包和独立的表，是最容易拆干净的两块；按变更频率和非功能需求划分的依据见 [服务拆分 · 拆分依据](/microservices/2_service_split#二、拆分依据)。

---

## 三、决策

**选「先拆两个」**：从 `mall-app` 拆出 `inventory-service` 和 `payment-service`，订单、商品、用户留在 `mall-app`；新增入口网关 `mall-gateway`，注册与配置用 Nacos，服务调用用 HTTP 接口客户端，数据库拆成三个库，部署迁到 Kubernetes。

![阶段三：拆出库存与支付服务后的部署结构](../assets/project/qingyou-split-architecture.svg)

同时明确**现在不做**的事：

| 不做 | 原因 | 什么时候做 |
|------|------|-----------|
| 服务网格 | 只有 4 个 Java 服务，负载均衡、超时都由 Spring Cloud 在进程内完成；Sidecar 的运维成本远大于收益，取舍见 [服务网格](/microservices/21_service_mesh#_3、落地取舍) | 出现多语言服务、需要服务间 mTLS 时再评估 |
| 继续拆订单 | 下单、查询、取消都归交易组，共享 `t_order` 和状态机，拆开只会多出分布式事务 | 交易组再分组、或订单查询压力独立变大时 |
| 拆商品、用户 | 见上表，扩 `mall-app` 实例即可 | 商品组与交易组的发布冲突明显时 |
| 每服务一个仓库 | 仍在 `qingyou-mall` 一个仓库，按模块各自打镜像、各自流水线即可独立发布 | 跨组代码评审成为瓶颈时 |
| 分布式事务框架 | 下单扣库存先用过渡做法，见第四节 | 下一篇 [跨服务一致性](./7_consistency) 也不引入，改用库存预占 + 本地消息表 |
| 订单分库分表 | 订单表一年约 3.65 亿行，先做历史订单归档；`order_no` 改为嵌入用户 ID 低位，为以后按 `user_id` 分片留路，迁移方式见 [分库分表与中间件](/database/5_practice/3_sharding#_1、不停机迁移五步) | 归档后单表仍超过容量规划时 |

---

## 四、模块边界让拆分变便宜

### 1、api 包变成远程契约

阶段一定下的规则「模块之间只能调用对方 `api` 包」，加上 CI 里的 ArchUnit `ModuleBoundaryTest`，保证了订单代码从没直接碰过库存的 Mapper。拆分时只需三步：

1. 把 `mall-inventory` 的 `api` 包抽成独立的小模块 `mall-inventory-api`（`InventoryApi`、DTO、`InventoryErrorCode`），其余代码连同启动类组成 `inventory-service`
2. 在 `InventoryApi` 上加 `@HttpExchange` 注解，库存服务的 Controller 实现它，`mall-app` 用同一个接口生成客户端
3. 订单代码里注入的仍是 `InventoryApi`，调用处不用改成拼 URL、解析响应；要重写的只有事务边界，见下一节

```java
// mall-inventory-api：com.qingyou.inventory.api.InventoryApi
@HttpExchange("/internal/inventory")
public interface InventoryApi {

    @GetExchange("/stocks")
    List<StockView> listStocks(@RequestParam List<Long> skuIds);

    @PostExchange("/deduct")
    void deduct(@RequestBody DeductStockRequest req);      // 按 sku_id 升序条件更新，和阶段一同一条 SQL

    @PostExchange("/restore")
    void restore(@RequestBody RestoreStockRequest req);
}

// inventory-service：Controller 直接实现接口，路径与参数注解从接口继承
@RestController
class InventoryController implements InventoryApi { /* 调用原来的 InventoryService */ }
```

服务端和客户端共用一个接口，契约不会两边写漂；代价是改接口就同时影响两边，所以沿用 [接口设计](./3_api_design) 的兼容规则：只加字段、不改含义。`/internal/**` 只在集群内可达，网关不路由它。包与模块的划分方法见 [工程结构与分包](/architecture/2_package_structure#六、用工具守住边界)。

支付同理：`mall-order` 里的 `pay` 包整体迁进 `payment-service`，`PayErrorCode` 跟着走，前缀 `PAY_` 不变。支付服务反过来要查订单金额、在支付成功后改订单状态，所以 `mall-order` 也抽出 `mall-order-api`，放 `OrderQueryApi` 和新增的 `OrderPayApi`。

### 2、本地事务变成远程调用

阶段一下单是「扣库存 + 写订单」一个本地事务；库存拆走后这个事务包不住了。本篇先用一个过渡写法，让拆分能独立上线：

```java
// com.qingyou.order.place.PlaceOrderService（节选，拆分过渡期）
Order existing = orderMapper.selectByUserAndBizNo(userId, idemKey);
if (existing != null) {
    return PlaceOrderResult.replayed(existing);          // 重试请求不再远程扣库存
}
String orderNo = orderNoGenerator.next(userId);          // 嵌入用户 ID 低位
inventoryApi.deduct(new DeductStockRequest(orderNo, lines));
try {
    return PlaceOrderResult.created(placeOrderTxService.create(userId, orderNo, idemKey, req, items));
} catch (RuntimeException e) {                           // 写单失败（含并发撞 uk_user_biz）：把库存还回去
    inventoryApi.restore(new RestoreStockRequest(orderNo, lines));
    if (e instanceof DuplicateKeyException) {
        return PlaceOrderResult.replayed(orderMapper.selectByUserAndBizNo(userId, idemKey));
    }
    throw e;
}
```

这段代码有三个已知的洞：`deduct` 超时不知道扣没扣上；`restore` 本身可能失败；进程在两步之间崩溃。过渡期不自动重试写接口，靠每日的库存与订单核对脚本人工处理，彻底的解法是下一篇 [跨服务一致性](./7_consistency) 的库存预占。

支付成功的过渡做法类似：`payment-service` 处理渠道回调时先更新 `t_payment`，再同步调用 `OrderPayApi.markPaid`，由 `mall-app` 在本地事务里改订单状态并写 `t_outbox`；调用失败就给渠道返回失败，靠渠道的回调重试兜底，所以两边都必须按订单号幂等。

---

## 五、按服务拆库与数据迁移

拆分后每个服务只连自己的库，账号也分开：`qingyou_mall`（订单、商品、用户）、`qingyou_inventory`（`t_inventory`）、`qingyou_payment`（`t_payment`）。库存是写热点，单独一个 MySQL 8.4 实例；支付库暂时和 `qingyou_mall` 共用实例、账号隔离。原则见 [服务拆分 · 每服务独享库](/microservices/2_service_split#_1、每服务独享库) 与 [微服务设计模式 · Database per Service](/microservices/3_patterns#_1、database-per-service)。

迁移按「先拆部署、再拆数据」走，以库存为例：

![库存数据从 qingyou_mall 迁到 qingyou_inventory 的四步](../assets/project/qingyou-db-split-steps.svg)

- **① 先拆部署**：`inventory-service` 上线，但数据源仍指向 `qingyou_mall`，只用一个只能访问 `t_inventory` 的账号；网关和 `mall-app` 按比例切流量过去，有问题切回单体内的实现即可，这一步就是 [绞杀者模式](/microservices/3_patterns#_2、绞杀者-strangler-fig)
- **② 建新库并同步**：订阅 `qingyou_mall` 的 binlog，把 `t_inventory` 的存量和增量同步到 `qingyou_inventory`，工具选型见 [CDC 工具](/database/5_practice/0_cdc_tools)
- **③ 对账与演练**：比对行数与分段 checksum，在预发环境完整演练一次切换与回切
- **④ 停写切换**：凌晨低峰停写库存接口数秒，等增量追平后切数据源，同时开反向同步，保留一周再断开，最后回收旧表的写权限

**不在业务代码里双写**：库存是条件更新 `stock >= ?`，两边各执行一次，任何一边失败都会让两个库的库存对不上，而且没有可以兜底的「正确值」；binlog 同步只有一个写入源，出错可以重放。双写与 CDC 的取舍、每一步的回退方式见 [服务拆分 · 双写与数据迁移](/microservices/2_service_split#_3、双写与数据迁移)。

`t_inventory` 只有约 8 万行（一个 SKU 一行，含已下架），同步和对账都在分钟级；`t_payment` 每天新增约 100 万行，步骤相同，只是同步要提前几天开始。拆库后运营后台里「订单联表支付单」的报表不能再跨库 JOIN，改成从数仓查，见 [服务拆分 · 跨服务查询](/microservices/2_service_split#_3、跨服务查询)。

---

## 六、Spring Cloud 选型

| 能力 | 可选 | 决策 | 理由 |
|------|------|------|------|
| 注册发现 | Nacos / K8s Service | Nacos | 迁移期 `mall-app` 还在云主机上，新服务在 Kubernetes 里，Nacos 能跨两边 |
| 配置中心 | Nacos Config / ConfigMap | Nacos Config | 和注册中心同一套，支持按环境的命名空间与动态刷新 |
| 网关 | Spring Cloud Gateway / 只用 Ingress | Gateway（WebFlux 版） | 需要统一 JWT 校验、按路径路由、灰度切流 |
| 服务调用 | OpenFeign / HTTP 接口客户端 | HTTP 接口客户端 | 框架内置，接口可以服务端客户端共用；OpenFeign 只剩维护 |
| 负载均衡 | Spring Cloud LoadBalancer | 默认轮询 | 实例同构，暂不需要权重或区域路由 |

Spring Boot 取 4.0.x、Spring Cloud 取 2025.1；Spring Cloud Alibaba 有自己的 BOM（`spring-cloud-alibaba-dependencies`），按官方版本对表导入 2025.1.0.0，对表见 [Spring Cloud Alibaba](/microservices/15_alibaba)。

### 1、Nacos：注册与配置

每个服务的 `application.yml` 只留连接信息，业务配置放 Nacos；命名空间按 dev / test / prod 隔离，数据库密码这类密钥不进 Nacos，改由 Kubernetes Secret 注入环境变量，取代阶段一的 `EnvironmentFile`：

```yaml
spring:
  application:
    name: inventory-service                      # 即注册中心里的服务名
  cloud:
    nacos:
      server-addr: ${NACOS_ADDR}
      username: ${NACOS_USERNAME}
      password: ${NACOS_PASSWORD}
      discovery:
        namespace: ${NACOS_NAMESPACE}
      config:
        namespace: ${NACOS_NAMESPACE}
        file-extension: yaml
  config:
    import:
      - optional:nacos:mall-common.yaml?group=COMMON_GROUP   # 各服务公共配置
      - nacos:inventory-service.yaml                         # 本服务配置，缺了启动失败
```

接入与刷新机制见 [注册发现 · Spring Cloud 接入](/microservices/10_service_registry#四、spring-cloud-接入) 和 [配置中心 · Nacos Config 接入](/microservices/13_config_center#二、nacos-config-接入)。

### 2、mall-gateway：只路由 /api

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: payment
              uri: lb://payment-service
              predicates:
                - Path=/api/payments/**          # 含渠道回调，回调路径免 JWT、改验渠道签名
            - id: mall-app
              uri: lb://mall-app
              order: 100                         # 兜底路由放最后
              predicates:
                - Path=/api/**
          httpclient:
            connect-timeout: 1000
            response-timeout: 5s
```

对外路径保持 [接口设计](./3_api_design) 里的样子，客户端无感；库存不对外暴露，商品详情里的库存由 `mall-app` 查。网关作为资源服务器统一校验 JWT，下游服务仍用同一把公钥再校验一次，不只凭请求头里的用户 ID 放行，写法见 [API 网关 · 统一鉴权](/microservices/11_api_gateway#四、统一鉴权-网关作为-oauth2-资源服务器)。

### 3、HTTP 接口客户端与超时

`mall-app` 按服务名注册客户端组，组名就是 Nacos 里的服务名，LoadBalancer 自动接入：

```java
@SpringBootApplication
@ImportHttpServices(group = "inventory-service", types = InventoryApi.class)
public class MallApplication { /* ... */ }
```

```yaml
spring:
  http:
    serviceclient:
      inventory-service:
        connect-timeout: 200ms
        read-timeout: 800ms          # 扣减 P99 约 30ms，留足余量但不能拖住下单线程
```

两条约定：一是超时必须显式配，默认值会让一个慢实例拖垮调用方线程池；二是写接口（`deduct`、`restore`、`markPaid`）**不开自动重试**，超时按失败处理。下游返回的 `ProblemDetail` 在客户端组里统一转成 `RemoteBizException`，保留 `code`，这样 `STOCK_INSUFFICIENT` 能原样回到前端：

```java
@Bean
RestClientHttpServiceGroupConfigurer remoteErrorConfigurer(JsonMapper jsonMapper) {
    return groups -> groups.forEachClient((group, builder) ->
        builder.defaultStatusHandler(HttpStatusCode::isError, (request, response) -> {
            ProblemDetail pd = jsonMapper.readValue(response.getBody(), ProblemDetail.class);
            throw new RemoteBizException(response.getStatusCode(), pd);   // 全局异常处理器按 code 透传
        }));
}
```

为什么不选 OpenFeign、客户端组的注册与透传请求头，见 [服务通信 · 选型](/microservices/12_communication#六、选型)；熔断、重试与限流放到「稳定性」一篇。

---

## 七、Kubernetes 部署

迁移顺序是**新服务先上 Kubernetes**：`inventory-service`、`payment-service`、`mall-gateway` 直接部署在集群里，`mall-app` 继续跑在云主机上，两边都注册到 Nacos，互相按服务名调用；新服务稳定一个月后，`mall-app` 再迁入集群。每个服务一个 Deployment 加一个 Service：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
  namespace: qingyou
spec:
  replicas: 3
  strategy:
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}     # 先起新的、就绪后再停旧的
  selector:
    matchLabels: {app: inventory-service}
  template:
    metadata:
      labels: {app: inventory-service}
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: qingyou/inventory-service:1.4.0
          ports: [{containerPort: 8080}]
          envFrom: [{secretRef: {name: inventory-service-secret}}]
          resources:
            requests: {cpu: "1", memory: 2Gi}
            limits: {memory: 2Gi}
          startupProbe:
            httpGet: {path: /actuator/health/liveness, port: 8080}
            periodSeconds: 5
            failureThreshold: 24                         # 最多给 2 分钟启动
          livenessProbe:
            httpGet: {path: /actuator/health/liveness, port: 8080}
          readinessProbe:
            httpGet: {path: /actuator/health/readiness, port: 8080}
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "curl -s -X POST localhost:8080/internal/offline; sleep 15"]
---
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
  namespace: qingyou
spec:
  selector: {app: inventory-service}
  ports: [{port: 80, targetPort: 8080}]
```

探针、资源与滚动参数的含义见 [Kubernetes · 探针、滚动更新与优雅终止](/cloud-native/6_kubernetes#四、探针、滚动更新与优雅终止)，JVM 在容器里的内存设置见 [Kubernetes · JVM 在容器里](/cloud-native/6_kubernetes#_3、jvm-在容器里)。

::: tip 用 Nacos 发现时，readiness 不挡流量
服务间调用走的是 Nacos 里的 Pod IP，不经过 Kubernetes Service，所以 readiness 失败、Pod 从 Service 后端摘除，Nacos 里的实例照样接流量。停机时要在 `preStop` 里先主动从 Nacos 注销再等待，启动时预热完成再注册；顺序与参数见 [优雅上下线与变更 · Kubernetes 配合](/high-avail/8_graceful_release#_3、kubernetes-配合)。Service 留给网关前的 Ingress、监控抓取和排障使用。
:::

---

## 八、代价与后续

| 本篇的决策 | 带来的问题 | 在哪解决 |
|-----------|-----------|---------|
| 下单先远程扣库存、写单失败再回补 | 超时不知道扣没扣、回补可能失败，库存和订单会对不上 | 下一篇 [跨服务一致性](./7_consistency) |
| 支付成功同步调用 `markPaid` | 依赖渠道回调重试兜底，订单服务长时间不可用时只能人工补单 | [跨服务一致性](./7_consistency) |
| 一次下单多了 1–2 次远程调用 | 库存服务变慢会拖住下单线程，大促时故障会沿调用链扩散 | 「稳定性」 |
| 请求跨 4 个进程 | 一个下单失败要翻网关、`mall-app`、库存服务三处日志 | 「可观测与发布」 |
| 每个服务独立发布 | 发布次数从每周 1 次变成每天数次，需要灰度与快速回滚 | 「可观测与发布」 |

拆分之后，4 个小组都能按自己的节奏发布，活动前只给 `inventory-service` 和 `payment-service` 扩容；代价是一致性、稳定性和排障都从「进程内的事」变成了「网络上的事」，后面三篇依次处理。

---

## 小结

- 拆分的触发条件是发布互相阻塞、迭代节奏差异、扩展需求不同同时出现，而不是日订单或人数到了某个数
- 先拆边界清楚、收益明显的库存和支付；订单、商品、用户留在 `mall-app`，不拆订单、不上服务网格
- 模块化单体的 `api` 包直接变成远程契约：`InventoryApi` 加 `@HttpExchange`，服务端实现、客户端注入，订单代码不改
- 每服务独享库，数据按「先拆部署 → binlog 同步 → 对账 → 停写切换」迁移，不在业务代码里双写
- Nacos 管注册与配置，`mall-gateway` 只路由 `/api/**`，服务间用 HTTP 接口客户端并显式配超时，写接口不自动重试
- 新服务先上 Kubernetes 1.37，`mall-app` 后迁；用 Nacos 发现时停机要先注销再等待

---

## 参考资料

- Spring Framework Reference · HTTP Service Client：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html#rest-http-service-client](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html#rest-http-service-client)
- Spring Cloud Gateway Reference：[https://docs.spring.io/spring-cloud-gateway/reference/](https://docs.spring.io/spring-cloud-gateway/reference/)
- Nacos 文档 · Spring Cloud Alibaba 集成：[https://nacos.io/docs/latest/ecology/use-nacos-with-spring-cloud/](https://nacos.io/docs/latest/ecology/use-nacos-with-spring-cloud/)
- Kubernetes Documentation · Configure Liveness, Readiness and Startup Probes：[https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- Martin Fowler · StranglerFigApplication：[https://martinfowler.com/bliki/StranglerFigApplication.html](https://martinfowler.com/bliki/StranglerFigApplication.html)

> 下一篇：[跨服务一致性](./7_consistency) —— 下单、扣库存、支付跨服务后怎么保证一致

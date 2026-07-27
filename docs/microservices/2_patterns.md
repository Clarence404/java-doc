# 微服务设计模式

> 参考资料：
> * 《Microservices Patterns》Chris Richardson：[https://microservices.io/patterns/](https://microservices.io/patterns/)

微服务设计模式与 GoF 23 种模式不同，它关注的是**分布式系统架构层面**的问题解法。

---

## 一、服务拆分模式

### 1.1 按业务能力拆分（Business Capability）

按照业务域进行服务边界划分，每个服务对应一个独立业务能力。

```
电商系统按业务能力拆分：
  ├── 用户服务（用户注册、登录、个人信息）
  ├── 商品服务（商品信息、库存、分类）
  ├── 订单服务（下单、取消、查询）
  ├── 支付服务（支付、退款）
  └── 通知服务（短信、邮件、Push）
```

**适用**：业务边界清晰、各能力演化速度不同时。

### 1.2 按限界上下文拆分（DDD Bounded Context）

基于 DDD 的限界上下文划定服务边界，是目前**最推荐**的拆分方法。

```
"订单" 在不同上下文含义不同：
  订单上下文：订单号、商品、数量、金额、状态机
  物流上下文：同一个订单 → 关注收货地址、运单号、物流状态
  财务上下文：同一个订单 → 关注金额、税、发票

每个上下文独立建模，服务间通过事件或 API 协作，不共享数据库。
```

**拆分时机**：不要过早拆分。单体应用代码量 > 50k LOC、团队 > 8 人、部署频率被单体拖累时，才值得拆分。

---

## 二、通信模式

### 2.1 API Gateway 模式

客户端不直接访问各微服务，通过统一网关路由、鉴权、限流。

> 详见：[API 网关](./4_api_gateway.md)

### 2.2 BFF（Backend for Frontend）

为不同客户端（Web / Mobile / 第三方）分别提供专属聚合层：

```
Mobile App → BFF-Mobile（裁剪响应字段，适配弱网）→ 各微服务
Web App   → BFF-Web（聚合多服务数据，服务端渲染）→ 各微服务
第三方      → Open API Gateway（OAuth2 限流）→ 各微服务
```

**适用**：不同客户端对数据格式、字段、协议需求差异较大时。

### 2.3 服务间同步 vs 异步

| 场景 | 推荐方式 |
|------|---------|
| 需要立即得到结果 | OpenFeign（同步 HTTP）/ gRPC |
| 可以异步处理 | 消息队列（Kafka / RocketMQ）|
| 读多写少，高并发 | CQRS + 异步事件驱动 |

---

## 三、数据管理模式

### 3.1 Database per Service

每个微服务独占自己的数据库，保证服务间数据隔离与自治。

```
order-service   → order_db（MySQL）
product-service → product_db（MySQL + Elasticsearch）
user-service    → user_db（MySQL）
session-service → Redis（专用，不共享）
```

**禁止**：多个微服务共享同一张表，这会造成隐式耦合，任何 DDL 变更都影响多个服务。

### 3.2 CQRS（命令查询职责分离）

将写操作（Command）与读操作（Query）分离到不同模型，提升读写性能：

```
写操作：POST /orders → Command Handler → 写 MySQL（规范化、强一致）
                                     ↓ 发布领域事件
读操作：GET /orders  → Query Handler  → 读 Elasticsearch（宽表、高性能）
                                     ↑ 消费事件，异步同步数据
```

### 3.3 Event Sourcing（事件溯源）

以事件序列作为数据存储的唯一来源，当前状态通过重放事件计算得到：

```
传统方式：存 ORDER 表的当前状态（status=PAID）
事件溯源：存事件流
  → OrderCreated {orderId=1, amount=100}
  → OrderPaid    {orderId=1, paymentId=p1}
  → OrderShipped {orderId=1, trackingNo=T123}

当前状态 = 重放所有事件 → 可回溯任意历史时刻状态
```

**适用**：需要完整审计日志、时间旅行、事件回放的场景（金融账户、订单系统）。实现复杂度高，谨慎引入。

---

## 四、可靠性模式

### 4.1 Circuit Breaker（熔断器）

服务调用失败率达到阈值时自动熔断，防止雪崩。

> 详见：[高可用 - 熔断](../high-avail/)

### 4.2 Saga 模式（分布式事务）

分布式事务的替代方案，通过一系列本地事务 + 补偿操作保证最终一致性。

```
编排式 Saga（Orchestration）：
  Saga Orchestrator 集中控制事务流程
  Orchestrator → 调用 order-service.createOrder()
              → 调用 inventory-service.reserveStock()
              → 调用 payment-service.processPayment()
              → 任一步失败 → 逆向调用补偿操作

协同式 Saga（Choreography）：
  各服务监听事件，自主决定下一步
  OrderCreated 事件 → inventory-service 监听 → 预留库存 → 发布 StockReserved 事件
  StockReserved 事件 → payment-service 监听 → 扣款 → 发布 PaymentCompleted 事件
  任一步失败 → 发布补偿事件
```

| 对比 | 编排式 | 协同式 |
|------|--------|--------|
| 流程可见性 | 高（Orchestrator 集中）| 低（分散在各服务）|
| 耦合度 | 中（依赖 Orchestrator）| 低（只依赖事件）|
| 调试难度 | 低 | 高（需追踪事件流）|
| 适合 | 步骤多、有复杂补偿逻辑 | 步骤少、解耦优先 |

### 4.3 Outbox Pattern（事务发件箱）

解决"写数据库"和"发消息"的原子性问题：

```
问题：
  写数据库成功 → 发 MQ 消息失败 → 数据不一致
  发 MQ 消息成功 → 写数据库失败 → 消息已发无法撤回

Outbox 方案：
  ① 业务写入 + 消息写入 outbox 表，同一个本地事务
  ② 独立 Relay 进程扫描 outbox 表，将消息发送到 MQ
  ③ 发送成功后标记 outbox 记录为已发送

工具：Debezium CDC（监听 outbox 表的 binlog，直接推送到 Kafka）
```

---

## 五、部署模式

### 5.1 Sidecar 模式

将通用能力（监控、日志、服务发现、mTLS）以独立进程附加在主服务旁，是 Service Mesh 的基础。

> 详见：[服务网格](./9_service_mesh.md)

### 5.2 Strangler Fig（绞杀者模式）

逐步用微服务替代单体应用，不做大爆炸式重写：

```
阶段 1：在单体前加 API Gateway，所有流量经网关
阶段 2：将某一功能模块抽取为独立微服务，网关将对应流量路由到新服务
阶段 3：重复阶段 2，逐步"绞杀"单体
阶段 N：单体功能全部迁移完成，单体下线
```

**优点**：风险可控，可随时回滚单个模块到单体，无需整体停机。

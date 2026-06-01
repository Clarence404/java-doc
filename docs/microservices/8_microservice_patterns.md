# 设计模式

> 参考资料：
> * 《Microservices Patterns》Chris Richardson：[https://microservices.io/patterns/](https://microservices.io/patterns/)
> * 苏三说技术-10种微服务设计模式：[https://mp.weixin.qq.com/s/8ByiPSCGI0mQ0mARoTU8hA](https://mp.weixin.qq.com/s/8ByiPSCGI0mQ0mARoTU8hA)

微服务设计模式与 GoF 23 种模式不同，它关注的是**分布式系统架构层面**的问题解法。

---

## 一、服务拆分模式

### 1.1 按业务能力拆分（Business Capability）

按照业务域进行服务边界划分，每个服务对应一个独立业务能力。

### 1.2 按限界上下文拆分（DDD Bounded Context）

基于 DDD 的限界上下文划定服务边界，是目前最推荐的拆分方法。

> [!warning]
> 待补充

---

## 二、通信模式

### 2.1 API Gateway 模式

客户端不直接访问各微服务，通过统一网关路由、鉴权、限流。

> 详见：[API 网关](./4_api_gateway.md)

### 2.2 BFF（Backend for Frontend）

为不同客户端（Web / Mobile / 第三方）分别提供专属网关层。

> [!warning]
> 待补充

---

## 三、数据管理模式

### 3.1 Database per Service

每个微服务独占自己的数据库，保证服务间数据隔离与自治。

### 3.2 CQRS（命令查询职责分离）

将写操作（Command）与读操作（Query）分离到不同模型，提升读写性能。

### 3.3 Event Sourcing（事件溯源）

以事件序列作为数据存储的唯一来源，可重放历史状态。

> [!warning]
> 待补充

---

## 四、可靠性模式

### 4.1 Circuit Breaker（熔断器）

服务调用失败率达到阈值时自动熔断，防止雪崩。

> 详见：[高可用-熔断](../high-avail/2_circuit_breaking.md)

### 4.2 Saga 模式

分布式事务的替代方案，通过一系列本地事务 + 补偿操作保证最终一致性。

> [!warning]
> 待补充

### 4.3 Outbox Pattern（事务发件箱）

解决"写数据库"和"发消息"的原子性问题，保证消息可靠投递。

> [!warning]
> 待补充

---

## 五、部署模式

### 5.1 Sidecar 模式

将通用能力（监控、日志、服务发现）以独立进程附加在主服务旁，是 Service Mesh 的基础。

### 5.2 Strangler Fig（绞杀者模式）

逐步用微服务替代单体应用，详见：[单体到微服务](./1_pros_and_cons.md)

> [!warning]
> 待补充

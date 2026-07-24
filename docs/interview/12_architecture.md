# 开发总结-系统架构

> 精华提炼，细节详见 [architecture/](../architecture/0_overview)、[microservices/](../microservices/0_overview)

## 一、微服务和单体架构各有什么优缺点？什么时候该拆分？

**单体架构**：所有功能打包在一个应用中。
- 优点：开发简单、部署方便、调试容易、性能好（无网络开销）
- 缺点：代码耦合严重、单点故障、技术栈统一、扩展粒度粗

**微服务架构**：按业务域拆分为独立服务，各自部署。
- 优点：独立部署、技术栈灵活、按需扩容、故障隔离
- 缺点：分布式复杂性（事务、一致性）、网络开销、运维成本高

**什么时候拆分**：
- 团队规模 > 10 人，多团队协作冲突大
- 某个模块需要独立扩容（如秒杀服务）
- 业务边界清晰，可以按 DDD 限界上下文划分
- 不建议一开始就微服务，可先单体后逐步拆分

## 二、微服务拆分的原则是什么？

**正确的拆分维度**：
- **单一职责**：每个服务只做一件事，内聚度高
- **业务边界**：按 DDD 限界上下文划分（如订单域、用户域、商品域）
- **独立数据**：每个服务拥有自己的数据库，不共享表
- **团队匹配**：按团队组织划分（康威定律：系统架构 = 团队沟通结构）

**拆分粒度误区**：不是越细越好，过细导致：
- 分布式事务激增
- 服务间调用链路过长，延迟增加
- 运维、监控、部署复杂度指数级上升

## 三、微服务的核心组件有哪些？如何选型？

| 组件 | 国内主流选型 | 说明 |
|------|------------|------|
| 注册中心 | **Nacos**（推荐）/ Eureka / Consul | Nacos 同时做配置中心，且支持 CP/AP 切换 |
| 配置中心 | **Nacos** / Apollo / Spring Cloud Config | Apollo 功能更完整；Nacos 轻量一体 |
| 网关 | **Spring Cloud Gateway** / APISIX | Gateway 原生 WebFlux 响应式；APISIX 生态丰富 |
| 负载均衡 | **Spring Cloud LoadBalancer** | Ribbon 已停止维护 |
| 熔断限流 | **Sentinel**（国内）/ Resilience4j | Sentinel 有可视化 Dashboard，配置动态推送 |
| 链路追踪 | **SkyWalking** / Zipkin / Jaeger | SkyWalking 对 Java 支持最好，探针无侵入 |
| 服务调用 | **OpenFeign** / gRPC | OpenFeign 声明式 HTTP；gRPC 高性能二进制 |

## 四、DDD 的核心概念是什么？

**领域驱动设计（Domain-Driven Design）**是一种聚焦业务复杂度的设计方法，核心概念：

| 概念 | 说明 |
|------|------|
| **领域（Domain）** | 业务问题空间，如电商领域、支付领域 |
| **限界上下文（Bounded Context）** | 解决方案的边界，一个上下文内术语含义唯一；对应微服务的拆分边界 |
| **聚合根（Aggregate Root）** | 聚合内的入口实体，外部只能通过聚合根操作内部对象，维护数据一致性 |
| **实体（Entity）** | 有唯一标识（ID）的对象，通过 ID 判等 |
| **值对象（Value Object）** | 无身份标识，通过属性判等（如金额、地址、坐标） |
| **领域事件（Domain Event）** | 聚合状态变化后发出的事件，驱动跨聚合的最终一致 |
| **仓储（Repository）** | 聚合的持久化接口，屏蔽底层存储细节 |

**与微服务的关系**：限界上下文 ≈ 微服务边界，一个限界上下文通常对应一个微服务。

## 五、接口幂等性如何设计？

更多详情见：<RouteLink to="/scenario/12_idempotent">业务场景-幂等设计</RouteLink>

**幂等**：同一请求执行多次和执行一次的结果相同。

**常见场景**：支付回调重推、MQ 消费重试、接口网络超时重试、用户重复点击。

**常用方案**：

| 方案 | 原理 | 适用场景 |
|------|------|---------|
| **唯一索引** | DB 唯一约束天然防重 | 插入类操作，如订单号去重 |
| **Token 机制** | 请求前获取 token，提交时 Lua 原子校验+删除 | 表单重复提交 |
| **Redis SETNX** | `SET key value NX EX ttl`，执行过就跳过 | MQ 消费去重、接口防重 |
| **乐观锁版本号** | `UPDATE ... WHERE version = ?`，更新失败说明已处理 | 状态流转类操作 |
| **状态机** | 只允许合法的状态迁移，已终态不再处理 | 订单、审批流程 |

```java
// Token 机制核心 Lua 脚本（校验 + 删除原子执行）
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
// 返回 0 说明 token 不存在或已被消费，拒绝重复请求
```

## 六、访问控制模型有哪些？RBAC 和 ABAC 的区别？

| 模型 | 全称 | 核心思想 | 适用场景 |
|------|------|---------|---------|
| **RBAC** | Role-Based Access Control | 用户 → 角色 → 权限，通过角色关联权限 | 企业内部系统，主流方案 |
| **ABAC** | Attribute-Based Access Control | 基于用户属性、资源属性、环境条件动态判断 | 细粒度权限、多维度条件控制 |
| **ACL** | Access Control List | 每个资源维护一份可访问用户列表 | 文件系统、细粒度资源控制 |
| **DAC** | Discretionary Access Control | 资源所有者自行决定授权 | 操作系统文件权限 |

**RBAC 典型实现**：5张表（用户、角色、权限、用户-角色、角色-权限），Spring Security + JWT 实现鉴权，接口权限注解 `@PreAuthorize("hasRole('ADMIN')")`。

**什么时候用 ABAC**：RBAC 角色爆炸（角色数量太多）时，或需要基于时间、地点、设备等动态条件判断权限时。

## 七、如何设计一个日志追踪系统？

**核心需求**：在分布式系统中，一次请求经过多个服务，需要能串联全链路日志。

**TraceId + SpanId 机制**：

```
请求进入 → 生成 TraceId（全局唯一）
  ├── 服务A处理 → SpanId=1，记录日志 [TraceId=xxx, SpanId=1]
  ├── 调用服务B → SpanId=1.1，记录日志 [TraceId=xxx, SpanId=1.1]
  └── 调用服务C → SpanId=1.2，记录日志 [TraceId=xxx, SpanId=1.2]
```

**日志采集链路（ELK 方案）**：

```
应用日志（结构化 JSON）
    → Filebeat（采集）/ Fluentd
    → Kafka（缓冲削峰）
    → Logstash（过滤 + 处理）
    → Elasticsearch（存储 + 索引）
    → Kibana（可视化查询）
```

**最佳实践**：
- 日志格式统一为 JSON（便于解析和检索）
- 必须包含 `traceId`、`spanId`、`userId`、`timestamp`、`level`
- 敏感信息脱敏（手机号、身份证、银行卡号打码）
- 日志分级（DEBUG 只开发环境，生产 INFO/WARN/ERROR）
- 全链路追踪推荐 SkyWalking（探针无侵入，自动注入 TraceId）

## 八、如何设计一个 API 网关？

**网关的核心职责**：

| 功能 | 说明 |
|------|------|
| 路由转发 | 根据路径 / 域名将请求转发到对应服务 |
| 鉴权认证 | JWT 解析、OAuth2 Token 校验，统一处理 |
| 限流熔断 | 接口级、用户级限流，保护后端服务 |
| 负载均衡 | 结合注册中心动态获取服务实例 |
| 协议转换 | HTTP → gRPC、HTTP → WebSocket |
| 日志审计 | 记录请求日志，支持链路追踪 |
| 灰度发布 | 按比例 / 按用户群体路由到新版本 |

**Spring Cloud Gateway 核心概念**：Route（路由）+ Predicate（断言/匹配条件）+ Filter（过滤器链）。

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service     # lb:// 表示从注册中心负载均衡
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=1           # 去掉路径前缀
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100   # 每秒令牌数
                redis-rate-limiter.burstCapacity: 200   # 最大突发
```

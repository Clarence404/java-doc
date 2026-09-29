# 水平扩展与无状态化

> 参考链接：[Kubernetes HPA 官方文档](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) · [The Twelve-Factor App](https://12factor.net/zh_cn/)

水平扩展是高并发的第一原则：**系统容量应当能通过加机器线性提升**。要做到这一点，服务必须无状态、流量必须能均匀分发、有状态部分必须能分片。

---

## 一、垂直扩展 vs 水平扩展

| 对比项 | 垂直扩展（Scale Up） | 水平扩展（Scale Out） |
|--------|----------------------|------------------------|
| 方式 | 换更强的机器（CPU、内存、SSD） | 加更多同构机器 |
| 改造成本 | 几乎为零，代码不用改 | 需无状态化、负载均衡、数据分片 |
| 上限 | 受单机硬件天花板限制 | 理论上接近线性，受共享资源（DB、锁）限制 |
| 成本曲线 | 高配机器价格非线性上涨 | 普通机器，成本近似线性 |
| 可用性 | 单点，机器挂即服务挂 | 多副本天然冗余 |
| 适用 | 早期业务、数据库主库、短期应急 | 应用层、缓存层、分片后的存储层 |

**实践建议**：先垂直、后水平。业务早期一台 16C32G 往往比 8 台 2C4G 更省心；当单机接近上限或需要高可用时，再投入水平扩展改造。但**应用层从第一天起就应保持无状态**，这几乎没有额外成本，却决定了后续能否平滑扩容。

---

## 二、无状态化

无状态服务：任意一个请求可以被路由到任意一个实例处理，结果一致。实例之间可以随时增删，不需要数据迁移。

### 1、常见的"状态"及外置方案

| 状态 | 问题 | 外置方案 |
|------|------|----------|
| HTTP Session | 用户请求换了机器即丢失登录态 | Redis 集中存储（Spring Session）或 JWT 无状态令牌 |
| 本地文件（上传、导出） | 其他实例读不到 | 对象存储（OSS / S3 / MinIO） |
| 本地内存计数、限流 | 多实例各算各的，总量失控 | Redis 计数 / 分布式限流 |
| 本地定时任务 | 多实例重复执行 | 分布式调度（XXL-JOB）或分布式锁 |
| 本地缓存 | 实例间数据不一致 | 允许短暂不一致 + 广播失效（见[两级缓存](/cache/8_two_level_cache)） |
| WebSocket 长连接 | 消息需要推到持有连接的实例 | 连接注册表 + MQ 广播 / 路由 |

Session 外置的完整方案对比（粘性会话、Session 复制、集中存储、Token）见 [分布式会话](/distributed/5_session)。

### 2、Spring Session 外置到 Redis

```yaml
spring:
  session:
    store-type: redis          # Spring Boot 3.x 引入 spring-session-data-redis 即自动生效
    timeout: 30m
    redis:
      namespace: app:session
  data:
    redis:
      host: redis.internal
      port: 6379
```

### 3、无状态化检查点

- 代码中是否有 `static` 可变集合保存业务数据
- 是否依赖 `HttpSession` 存储大对象（外置后每次请求都要序列化传输）
- 是否写本地磁盘并假设下次还能读到
- 定时任务、MQ 消费是否能容忍多实例并行
- 实例启动是否依赖人工配置（应从配置中心拉取）

---

## 三、服务拆分

将单体服务拆分为多个服务，每个服务独立部署、独立扩容，避免"一个模块的流量拖垮整个应用"。

![系统拆分](../assets/concurrency/sys_split.svg)

**拆分原则**：

- 按业务域拆分（用户、订单、库存、支付各自独立）
- 高频写服务与高频读服务分离（如商品详情读服务与商品管理写服务）
- 无状态服务水平扩展，有状态服务垂直扩展或分片
- 流量特征差异大的模块分开部署，按各自峰值独立扩容（如秒杀服务单独集群）

**拆分对扩展性的收益**：单体只能整体扩容，10 倍流量只落在"商品详情"时也要把整个应用扩 10 倍；拆分后只需扩容商品读服务，资源利用率大幅提升。

拆分的粒度、边界划分方法见 [微服务](/microservices/0_overview)。

---

## 四、负载均衡入口

水平扩展的前提是流量能被均匀分发到各个实例。典型的分层入口：

| 层级 | 组件 | 作用 |
|------|------|------|
| DNS | 智能 DNS / GSLB | 按地域、运营商把用户导向就近机房 |
| 四层 | LVS / 云 SLB / NLB | 高性能 TCP 转发，承接百万级连接 |
| 七层 | Nginx / Ingress / API 网关 | 按域名、路径路由，TLS 卸载，限流鉴权 |
| 服务间 | Spring Cloud LoadBalancer / Dubbo | 客户端负载均衡，基于注册中心实例列表 |

负载均衡算法（轮询、加权、最少连接、一致性哈希）与健康检查详见 [负载均衡](/high-avail/7_load_balancing)。

**高并发下的注意点**：

- 七层网关本身要能水平扩展，前面挂四层负载均衡
- 慎用一致性哈希 / IP Hash 做"伪粘性"，会让热点用户集中到单实例
- 新实例上线要做**预热**（逐步放量），避免 JIT 未编译、连接池未建立时被打满

---

## 五、自动扩缩容

手动扩容响应慢，流量突增时来不及。Kubernetes HPA（Horizontal Pod Autoscaler）根据指标自动调整副本数：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 4
  maxReplicas: 40
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60     # 目标 CPU 水位 60%，留出突发余量
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100                 # 每 60s 最多翻倍
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # 缩容观察 5 分钟，防抖动
```

**局限与应对**：

| 问题 | 说明 | 应对 |
|------|------|------|
| 扩容有延迟 | 拉镜像 + JVM 启动 + 预热，通常 30s ~ 数分钟 | 大促前提前手动扩容；保持合理 `minReplicas` |
| CPU 不代表瓶颈 | IO 密集型服务 CPU 很低但线程池已满 | 基于 QPS、队列长度等自定义指标（Prometheus Adapter / KEDA） |
| 下游扛不住 | 应用扩了 10 倍，DB 连接数也翻了 10 倍 | 扩容前核算连接池总量 = 实例数 × 单实例池大小 |

K8s 基础与 Deployment 配置见 [Kubernetes](/cloud-native/6_kubernetes)。

---

## 六、有状态服务的扩展

数据库、缓存、MQ 等有状态组件无法简单"加机器"，核心手段是**分片（Sharding）**：把数据按某个键切分到多个节点，每个节点只负责一部分。

| 组件 | 分片方式 | 扩容方式 |
|------|----------|----------|
| Redis Cluster | 16384 个哈希槽分配到各主节点 | 新增节点后迁移槽位 |
| Kafka | Topic 分为多个 Partition | 增加 Partition（已有数据不迁移，影响 key 顺序） |
| MySQL | 分库分表，按分片键路由 | 数据迁移 + 双写，成本最高 |
| Elasticsearch | 索引分为多个 Primary Shard | 分片数创建后不可改，需 reindex |

**分片路由策略**：

- **取模**：`hash(key) % N`，简单均匀，但 N 变化时几乎所有数据要迁移
- **范围**：按 ID 或时间范围，扩容只需新增区间，但易产生写热点
- **一致性哈希 / 虚拟槽**：扩容只迁移部分数据，见 [一致性哈希](/distributed/9_consistent_hashing)

数据库分片的具体方案见 [数据层扩展](/high-con/4_data_scaling)。

---

## 七、水平扩展检查清单

- [ ] 应用实例无本地状态，任意实例可随时下线
- [ ] Session / Token 集中存储或无状态令牌
- [ ] 文件存储使用对象存储
- [ ] 定时任务使用分布式调度，MQ 消费支持多实例并行且幂等
- [ ] 入口层（网关、Nginx）可水平扩展，前置四层负载均衡
- [ ] 新实例上线有预热机制，下线有优雅停机（摘流量 → 等待在途请求 → 退出）
- [ ] HPA 指标与服务瓶颈匹配，设置合理的 min/max 副本数
- [ ] 核算扩容后下游资源（DB 连接数、Redis 连接数、MQ 分区数）是否足够
- [ ] 有状态组件已规划分片方案与扩容路径

---
description: 负载均衡算法、故障摘除、Nginx 配置、会话保持、客户端负载均衡
---

# 负载均衡

> 前置阅读：[冗余与故障转移](./2_redundancy_failover)

负载均衡决定每个请求交给哪个实例，对高可用而言要做好两件事：**把流量分得均匀**，以及**把故障实例及时摘掉**。本篇讲负载均衡算法、故障摘除、Nginx 配置、会话保持与客户端负载均衡（区域优先与灰度路由）。

---

## 一、负载均衡算法

**没有万能算法：实例同构、请求耗时相近时用轮询；耗时差异大时看连接数或响应时间；需要"同一个 key 落到同一实例"时用哈希。** 接入层分几级（DNS / GSLB → CDN → LVS / SLB → Nginx / 网关）属于高并发的入口设计，见 [接入层架构](/high-con/1_access_layer)。

![轮询与平滑加权轮询](../assets/high-avail/lb-round-robin.svg)

| 算法 | 原理 | 适用场景 | 注意事项 |
|------|------|---------|---------|
| 轮询（Round Robin） | 按顺序依次分配 | 实例配置相同、请求耗时相近 | 不感知实例实际负载 |
| 加权轮询 | 按权重比例分配；Nginx 使用平滑加权，避免连续打到同一实例 | 实例配置不一致、预热期逐步放量 | 权重需要随实例变化调整 |
| 随机 / 加权随机 | 随机选择，请求量大时趋近均匀 | 客户端负载均衡，实现简单 | 小流量下分布不均 |
| 最少连接（Least Connections） | 选当前活跃连接数最少的实例 | 长短请求混合、长连接 | 需要维护连接计数；新实例会被瞬间灌满，需配合预热 |
| 最短响应时间 / P2C | 随机选两个，取负载或延迟更低的一个 | 实例性能波动大的 RPC 场景 | 需要采集实时指标 |
| 哈希 / 一致性哈希 | 按 userId、IP 等计算哈希，一致性哈希在扩缩容时只迁移少量 key | 本地缓存亲和、有状态服务、分布式存储 | 热点 key 会导致单实例过载；用虚拟节点改善均匀度 |

::: tip P2C（Power of Two Choices）
"随机挑两个取较优"几乎不增加开销，却能显著降低最大负载。Envoy 的 `LEAST_REQUEST` 默认就是 P2C，Dubbo 3 也提供了 `p2c` 策略。
:::

---

## 二、健康检查与故障摘除

**负载均衡必须与健康检查配合，否则会把请求持续发给已故障的实例。** 主动 / 被动检查、Nginx `max_fails`、K8s 探针、注册中心摘除时效等内容统一见 [冗余与故障转移](./2_redundancy_failover)。

负载均衡侧还需注意两点：

- **失败转移只对幂等请求开启**：换实例重试等于一次重试，非幂等写请求可能被执行两次
- **限制转移次数**：`proxy_next_upstream_tries` 或客户端重试次数设为 1～2，避免一个请求把所有实例都试一遍

---

## 三、Nginx 负载均衡配置

**Nginx 默认使用加权轮询（权重默认为 1），`least_conn`、`ip_hash`、`hash` 指令切换算法。**

```nginx
upstream backend {
    # 默认轮询；weight 实现加权轮询
    server 10.0.0.1:8080 weight=3;
    server 10.0.0.2:8080 weight=1;
    server 10.0.0.3:8080 weight=1;
    keepalive 64;                          # 与上游保持的空闲长连接数
}

upstream backend_least {
    least_conn;                            # 最少连接
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
}

upstream backend_hash {
    hash $arg_userId consistent;           # 按 userId 一致性哈希（ketama）
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
}

server {
    listen 80;
    location /api/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";    # 配合 keepalive 复用上游连接
        proxy_connect_timeout 1s;
        proxy_read_timeout 10s;
        proxy_next_upstream error timeout; # 连接失败或超时换下一个实例
        proxy_next_upstream_tries 2;
    }
}
```

---

## 四、会话保持

**会话保持（Sticky Session）是给有状态服务打的补丁：它让负载不均、让实例下线时丢会话，优先做无状态化。**

| 方式 | 做法 | 问题 |
|------|------|------|
| IP 哈希 | `ip_hash` 按客户端 IP 路由 | NAT / 代理后大量用户共用一个 IP，负载严重倾斜 |
| Cookie 粘滞 | 负载均衡写入路由 Cookie（Nginx Plus `sticky`、云 SLB 会话保持） | 实例故障时会话仍然丢失 |
| 一致性哈希 | 按 userId 等业务 key 哈希 | 扩缩容时部分用户迁移 |
| **无状态化（推荐）** | Session 外置到 Redis 或改用 Token | 需要改造，见 [水平扩展与无状态化](/high-con/2_scale_out) |

确实需要亲和性的场景（本地缓存命中率、长连接网关），用一致性哈希并接受扩缩容时的少量迁移，而不是依赖粘滞会话保证正确性。

---

## 五、客户端负载均衡

**微服务之间通常不经过集中式代理，而是调用方从注册中心拉取实例列表、在本地选择实例，这就是客户端负载均衡。** Spring Cloud 中的实现是 Spring Cloud LoadBalancer（SCL，替代已停止维护的 Ribbon），Dubbo、gRPC 也都内置客户端负载均衡。

| 对比 | 服务端负载均衡（Nginx / LVS / SLB） | 客户端负载均衡（SCL / Dubbo） |
|------|----------------------------------|----------------------------|
| 位置 | 独立的代理层 | 调用方进程内 |
| 实例列表来源 | 静态配置或服务发现集成 | 注册中心推送 / 拉取，本地缓存 |
| 优点 | 对调用方透明、语言无关 | 少一跳、无代理单点、可按调用上下文路由 |
| 缺点 | 多一跳、代理自身需要高可用 | 每种语言都要 SDK；实例列表有感知延迟 |

SCL 的常用能力：

- **内置算法**：默认轮询，可替换为随机，或按实例元数据 `weight` 加权（较新版本）
- **区域优先**：优先选择与调用方同可用区的实例，同区无可用实例时再跨区，降低跨区延迟并在单区故障时自动溢出
- **Hint 路由**：按请求头与实例元数据匹配，可实现简单的灰度路由
- **自定义策略**：实现 `ReactorServiceInstanceLoadBalancer`，按版本、标签等规则挑选实例

区域优先、Hint 配置与自定义灰度负载均衡器的完整代码见 [Spring Cloud 服务治理](/spring-cloud/5_service_governance)。

::: warning 灰度路由的关键是标记透传
按请求头路由到灰度实例，只在第一跳生效是不够的：链路上每个服务都要把灰度标记透传到下一跳（Feign 拦截器、MQ 消息头），否则下游会回到稳定版本。
:::

---

## 六、弹性扩缩容

按负载自动增减实例（K8s HPA）属于容量层面的手段，见 [水平扩展与无状态化](/high-con/2_scale_out)；扩缩容与发布期间如何保证可用实例数（PDB、`maxUnavailable`）见 [优雅上下线与变更](./8_graceful_release)。

---

## 小结

- 实例同构用轮询；耗时差异大用最少连接或 P2C；需要亲和性用一致性哈希，并警惕热点 key
- 负载均衡要配合健康检查摘除故障实例，失败转移只对幂等请求开启并限制次数
- 会话保持是补丁，优先无状态化
- 微服务间多用客户端负载均衡，SCL 内置区域优先与 Hint 路由；灰度路由需要全链路透传标记

## 参考资料

- Nginx 负载均衡入门：[Using nginx as HTTP load balancer](https://nginx.org/en/docs/http/load_balancing.html)
- Nginx upstream 模块参数（max_fails、least_conn 等）：[Module ngx_http_upstream_module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
- P2C 原始论文：[The Power of Two Choices in Randomized Load Balancing](https://www.eecs.harvard.edu/~michaelm/postscripts/tpds2001.pdf)
- Spring Cloud LoadBalancer 官方文档：[Spring Cloud LoadBalancer](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)
- Kubernetes 水平自动扩缩容：[Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)

> 下一篇：[超时、重试与隔离](./4_timeout_retry_bulkhead) —— 实例选好了，调用下游时如何不被慢依赖拖垮。

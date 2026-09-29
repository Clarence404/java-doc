# 面试高频题

> 汇总高可用方向的核心面试问题，完整解答见 <RouteLink to="/interview/10_high_avail">开发总结-高可用</RouteLink>

## 一、可用性度量

- **SLA 99.99% 意味着每年多少故障时间？每月呢？**
- **SLA、SLO、SLI 分别是什么？三者什么关系？**
- **什么是错误预算？如何用它约束发布节奏？**
- **为什么基于燃烧速率告警比直接按错误率告警更好？**
- **MTBF、MTTR 是什么？提升可用性应优先降低哪一个？**
- **四个 99.9% 的服务串联，整体可用率是多少？两个 99% 的实例并联呢？**  
  → 详见 <RouteLink to="/high-avail/1_sla_slo">可用性度量</RouteLink>

## 二、冗余与故障转移

- **冷备、温备、热备有什么区别？**
- **主备、主主、集群三种模式各有什么优缺点？**
- **K8s 的 liveness 和 readiness 探针有什么区别？liveness 为什么不能检查数据库？**
- **Keepalived 如何实现 VIP 漂移？**
- **什么是脑裂？有哪些防护手段？fencing token 是什么？**
- **MySQL 主库宕机如何自动切换？MHA、Orchestrator、MGR 有什么区别？**  
  → 详见 <RouteLink to="/high-avail/2_redundancy_failover">冗余与故障转移</RouteLink>

## 三、限流

- **常见限流算法有哪些？令牌桶和漏桶的区别？**
- **固定窗口限流有什么问题？滑动窗口如何解决？**
- **如何用 Redis + Lua 实现滑动窗口限流？**
- **Sentinel 有哪些限流规则？热点参数限流是什么？**  
  → 详见 <RouteLink to="/high-avail/3_rate_limiting">限流</RouteLink>

## 四、熔断降级

- **熔断器的三种状态是什么？如何切换？**
- **Sentinel 和 Hystrix（Resilience4j）有什么区别？**
- **服务降级有哪些级别和策略？**
- **`@SentinelResource` 的 `blockHandler` 和 `fallback` 有什么区别？**  
  → 详见 <RouteLink to="/high-avail/4_circuit_breaking">熔断</RouteLink> · <RouteLink to="/high-avail/5_degradation">降级</RouteLink>

## 五、隔离、超时与重试

- **线程池隔离和信号量隔离的区别？各自适用什么场景？**
- **超时设置的原则是什么？各层都需要设置吗？**
- **重试适用于哪些场景？非幂等接口能直接加重试吗？**
- **指数退避算法是什么？为什么要加 Jitter？**  
  → 详见 <RouteLink to="/high-avail/6_bulkhead_retry">隔离、重试与超时</RouteLink>

## 六、负载均衡

- **常见负载均衡算法有哪些？一致性哈希解决什么问题？**
- **四层负载均衡和七层负载均衡的区别？**
- **HPA 如何工作？PodDisruptionBudget 的作用是什么？**  
  → 详见 <RouteLink to="/high-avail/7_load_balancing">负载均衡</RouteLink>

## 七、多活与容灾

- **RPO 和 RTO 分别是什么？**
- **同城双活和异地多活的区别？各自解决什么问题？**
- **两地三中心是什么架构？异地灾备中心为什么"不敢切"？**
- **什么是单元化？如何选择路由键？全局数据如何处理？**
- **双向数据同步如何避免复制回环和写冲突？**
- **计划内切流为什么要先禁写？**  
  → 详见 <RouteLink to="/high-avail/8_multi_active">多活与容灾</RouteLink>

## 八、优雅上下线与变更

- **什么是优雅停机？如何在 Spring Boot 中实现？**
- **K8s 中如何配合实现优雅停机？`preStop` 的作用是什么？为什么需要 sleep？**
- **为什么新实例启动后需要预热？有哪些预热手段？**
- **变更三板斧是什么？**
- **配置变更有什么风险？如何灰度发布配置？**  
  → 详见 <RouteLink to="/high-avail/9_graceful_release">优雅上下线与变更</RouteLink>

## 九、混沌工程

- **混沌工程是什么？有哪些工具？**
- **混沌实验如何控制爆炸半径？**  
  → 详见 <RouteLink to="/high-avail/10_chaos_engineering">混沌工程</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/10_high_avail">开发总结-高可用</RouteLink>
:::

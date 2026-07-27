# 面试高频题

> 汇总高可用方向的核心面试问题，完整解答见 <RouteLink to="/interview/9_high_avail">开发总结-高可用</RouteLink>

## 一、限流

- **常见限流算法有哪些？令牌桶和漏桶的区别？**
- **固定窗口限流有什么问题？滑动窗口如何解决？**
- **如何用 Redis + Lua 实现滑动窗口限流？**
- **Sentinel 有哪些限流规则？热点参数限流是什么？**

## 二、熔断降级

- **熔断器的三种状态是什么？如何切换？**
- **Sentinel 和 Hystrix（Resilience4j）有什么区别？**
- **服务降级有哪些级别和策略？**
- **`@SentinelResource` 的 `blockHandler` 和 `fallback` 有什么区别？**  
  → 详见 <RouteLink to="/high-avail/2_circuit_breaking">熔断</RouteLink>

## 三、超时与重试

- **超时设置的原则是什么？各层都需要设置吗？**
- **重试适用于哪些场景？非幂等接口能直接加重试吗？**
- **指数退避算法是什么？如何实现？**

## 四、高可用架构

- **什么是优雅停机？如何在 Spring Boot 中实现？**
- **K8s 中如何配合实现优雅停机？`preStop` 的作用是什么？**
- **SLA 99.99% 意味着每年多少故障时间？**
- **同城双活和异地多活的区别？各自解决什么问题？**
- **混沌工程是什么？有哪些工具？**

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/9_high_avail">开发总结-高可用</RouteLink>
:::

# 面试高频题

> 汇总高性能方向的核心面试问题，完整解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink>

## 一、性能指标与方法论

- **QPS、TPS、RT、并发数之间是什么关系？如何用 Little 定律估算线程池大小？**
- **为什么不能只看平均响应时间？P99 和 P999 分别意味着什么？**
- **接口突然变慢，你的排查思路是什么？（系统资源 → JVM → 线程/锁 → 外部依赖）**
## 二、基准测试与分析工具

- **为什么用 `System.nanoTime` 循环测性能不可靠？JMH 是如何解决的？**
- **火焰图怎么看？CPU 火焰图和 wall-clock 火焰图有什么区别？**
- **线上 CPU 使用率飙高，如何定位到具体的代码行？**  
  → 详见 <RouteLink to="/high-perf/9_profilers">性能分析工具</RouteLink>

## 三、代码与池化

- **有哪些常见的代码级性能优化手段？`HashMap` 初始容量应该如何设置？**
- **数据库连接池的大小如何确定？连接池是不是越大越好？**
- **HTTP 客户端连接池需要关注哪些参数？为什么会出现 `NoHttpResponseException`？**  
  → 详见 <RouteLink to="/high-perf/5_pooling">池化技术</RouteLink>

## 四、异步、批量与 IO

- **如何把一个串行调用多个下游的接口优化为并行？需要注意什么？**
- **什么是请求合并？适合什么场景，有什么代价？**
- **什么是零拷贝？Kafka 为什么吞吐量高？**
## 五、数据访问

- **慢 SQL 如何发现、分析和优化？**
- **深分页为什么慢？有哪些优化方案？**
- **JDBC 批量插入为什么没有变快？`rewriteBatchedStatements` 的作用是什么？**
- **什么是 N+1 查询问题？如何发现和解决？**  
  → 详见 <RouteLink to="/high-perf/8_db_performance">数据访问性能</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink>
:::

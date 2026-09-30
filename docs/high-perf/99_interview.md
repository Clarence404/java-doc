# 面试高频题

> 汇总高性能方向的核心面试问题，完整解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink>

## 一、指标与方法论

- **QPS、TPS、RT、并发数之间是什么关系？如何用 Little 定律估算所需线程数或连接数？**
- **为什么不能只看平均响应时间？P99 和 P999 分别意味着什么？**
- **USE 方法和 RED 方法分别适合什么场景？**
- **接口突然变慢，你的排查思路是什么？（系统资源 → JVM → 线程/锁 → 外部依赖）**
- **Amdahl 定律对性能优化有什么指导意义？**

→ 详见 <RouteLink to="/high-perf/1_metrics">性能指标</RouteLink>、<RouteLink to="/high-perf/2_methodology">性能分析方法论</RouteLink>

## 二、分析工具与基准测试

- **火焰图怎么看？CPU 火焰图和 wall-clock 火焰图有什么区别？**
- **线上 CPU 使用率飙高，如何定位到具体的代码行？**
- **JFR 能采集哪些信息？适合排查什么问题？**
- **为什么用 `System.nanoTime` 循环测性能不可靠？JMH 是如何解决的？**

→ 详见 <RouteLink to="/high-perf/3_profilers">性能分析工具</RouteLink>、<RouteLink to="/high-perf/4_benchmark">基准测试（JMH）</RouteLink>

## 三、JVM 层

- **低延迟和高吞吐场景分别怎么选垃圾收集器？**
- **应用刚启动时 RT 毛刺明显，原因是什么？如何缓解？**
- **为什么降低对象分配速率往往比调 GC 参数更有效？**

→ 详见 <RouteLink to="/high-perf/5_jvm_tuning">JVM 层性能策略</RouteLink>

## 四、代码与池化

- **有哪些常见的代码级性能优化手段？`HashMap` 初始容量应该如何设置？**
- **为什么不建议用异常做流程控制？日志有哪些常见的性能坑？**
- **数据库连接池的大小如何确定？连接池是不是越大越好？**
- **如何发现和排查连接泄漏？**
- **HTTP 客户端连接池需要关注哪些参数？为什么会出现 `NoHttpResponseException`？**
- **什么对象不应该池化？**

→ 详见 <RouteLink to="/high-perf/6_code_optimization">代码级优化</RouteLink>、<RouteLink to="/high-perf/7_pooling">池化技术</RouteLink>

## 五、异步、批量与 IO

- **如何把一个串行调用多个下游的接口优化为并行？需要注意什么？**
- **`CompletableFuture.orTimeout` 超时后，底层任务会被取消吗？**
- **什么是对冲请求（Hedged Request）？有什么使用前提？**
- **什么是请求合并？适合什么场景，有什么代价？**
- **什么是零拷贝？Kafka 为什么吞吐量高？开启 TLS 后有什么影响？**
- **HTTP/1.1、HTTP/2、HTTP/3 在连接复用上有什么区别？**

→ 详见 <RouteLink to="/high-perf/8_async_batch">异步与批量</RouteLink>、<RouteLink to="/high-perf/9_io_network">IO 与网络优化</RouteLink>

## 六、数据访问

- **慢 SQL 如何发现、分析和优化？为什么要按总耗时排序？**
- **深分页为什么慢？有哪些优化方案？游标分页需要什么索引？**
- **JDBC 批量插入为什么没有变快？`rewriteBatchedStatements` 的作用是什么？**
- **什么是 N+1 查询问题？如何发现和解决？**
- **`IN` 列表过长会带来什么问题？**

→ 详见 <RouteLink to="/high-perf/10_db_performance">数据访问性能</RouteLink>

## 七、综合案例

- **讲一次你做过的接口性能优化：如何定目标、建基线、定位和验证？**
- **如何证明一项优化确实有效，而不是环境波动？**
- **优化上线后，如何防止性能回归？**

→ 详见 <RouteLink to="/high-perf/11_case_study">端到端优化案例</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/10_high_avail">开发总结-三高</RouteLink>
:::

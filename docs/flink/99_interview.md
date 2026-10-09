---
description: Flink 方向题目清单
---

# 面试高频题

> 汇总 Flink 流计算的高频面试问题，完整解答见 <RouteLink to="/interview/6_flink">开发总结 - Flink</RouteLink>

## 一、基础与架构

- **Flink 与 Spark Streaming、Kafka Streams 如何选型？**
- **JobManager 的 Dispatcher、ResourceManager、JobMaster 各负责什么？Slot 隔离什么？一个作业需要多少 Slot？**
- **什么是算子链？什么情况下会断链？**
- **Flink 2.0 有哪些破坏性变化？为什么移除 Per-Job 模式？**
- **为什么 maxParallelism 上线后不能改？Key Group 是什么？**  
  → 详见 <RouteLink to="/flink/1_basics">Flink 概览</RouteLink>、<RouteLink to="/flink/4_state_checkpoint">状态与容错</RouteLink>

## 二、DataStream

- **KafkaSource 的 offset 以什么为准？提交到 Kafka 的 offset 有什么用？**
- **解析失败为什么不能抛异常？脏数据怎么处理？**
- **维表关联为什么用异步 I/O？有序与无序模式有什么区别？timeout 要注意什么？**
- **为什么要避免 Kryo 序列化？Lambda 的泛型擦除怎么解决？**  
  → 详见 <RouteLink to="/flink/2_datastream">DataStream API</RouteLink>

## 三、时间与窗口

- **什么是水位线？多输入算子的水位线如何计算？**
- **窗口迟迟不触发是什么原因？怎么解决？（空闲分区 / idleness）**
- **迟到数据有哪三道防线？allowedLateness 对下游有什么要求？**
- **滚动、滑动、会话窗口有什么区别？滑动窗口为什么可能状态爆炸？按自然日统计要注意什么？**
- **增量聚合与全量窗口函数有什么区别？如何组合使用？**
- **Window Join 与 Interval Join 有什么区别？**  
  → 详见 <RouteLink to="/flink/3_time_window">时间、水位线与窗口</RouteLink>

## 四、状态与容错

- **状态 TTL 的语义是什么？有哪些坑？**
- **HashMap、RocksDB、ForSt 状态后端如何选择？**
- **Checkpoint 的原理是什么（barrier、对齐）？非对齐 Checkpoint 解决什么问题？**
- **Checkpoint 与 Savepoint 有什么区别？为什么要给算子设置 uid？**
- **如何实现端到端精确一次？两阶段提交的流程是什么？Kafka 事务 Sink 要注意什么？**
- **Checkpoint 超时或耗时长如何排查与优化？**  
  → 详见 <RouteLink to="/flink/4_state_checkpoint">状态与容错</RouteLink>、<RouteLink to="/flink/7_deployment">部署与运维</RouteLink>

## 五、SQL 与 CDC

- **什么是动态表？+I / -U / +U / -D 分别何时出现？append、retract、upsert 流有什么区别？**
- **为什么一条 SQL 写 Kafka 会报 doesn't support consuming update changes？怎么解决？**
- **为什么窗口 TVF 优于无界 GROUP BY？CUMULATE 适合什么场景？**
- **Regular、Interval、Temporal、Lookup Join 的状态占用和结果确定性有什么差异？如何选型？**
- **table.exec.state.ttl 默认值是多少？TTL 过期对聚合与 Join 结果有什么影响？**
- **Flink CDC 的无锁增量快照算法如何保证全量与增量衔接一致？**
- **MySQL CDC 需要哪些数据库配置与权限？server-id 冲突会怎样？**
- **Flink CDC 的端到端精确一次在哪一段成立？下游为什么必须有主键？**  
  → 详见 <RouteLink to="/flink/5_sql">Flink SQL 与 Table API</RouteLink>、<RouteLink to="/flink/6_cdc">Flink CDC</RouteLink>

## 六、部署与调优

- **TaskManager 内存由哪几部分组成？容器被 OOMKilled 但 JVM 无异常，通常是什么原因？**
- **如何定位反压的根源算子？**
- **Flink 数据倾斜有哪几种来源？如何处理？为什么加并行度无效？**
- **升级作业时哪些改动会导致无法从 Savepoint 恢复？Kubernetes Operator 的 upgradeMode 有什么区别？**
- **用 Flink 实现实时 GMV 大屏，如何保证口径准确、0 点清零与幂等写入？**
- **维表关联有哪些方案？维度数据晚到怎么办？**  
  → 详见 <RouteLink to="/flink/7_deployment">部署与运维</RouteLink>、<RouteLink to="/flink/8_scenarios">实战场景</RouteLink>、<RouteLink to="/flink/5_sql">Flink SQL 与 Table API</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/6_flink">开发总结 - Flink</RouteLink>
:::

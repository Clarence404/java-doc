# 高可用概览

参考链接：[advanced-java 高可用架构](https://gitee.com/Doocs/advanced-java#%E9%AB%98%E5%8F%AF%E7%94%A8%E6%9E%B6%E6%9E%84) · [Google SRE Book](https://sre.google/sre-book/table-of-contents/)

## 一、什么是高可用

高可用（High Availability，HA）是指系统在**实例宕机、依赖失败、机房故障、错误变更**等异常情况下，仍能持续对外提供服务的能力。它关注的不是"不出故障"，而是：

- **故障影响面小**：一个依赖或一个实例出问题，不拖垮整体（隔离、熔断、降级）
- **故障恢复快**：自动发现、自动切换、快速回滚（冗余、健康检查、故障转移）
- **可度量**：用 SLA / SLO / 错误预算量化"多可用才够"，见 [可用性度量](/high-avail/1_sla_slo)

高可用的本质手段只有两类：**冗余**（多副本、多机房，消除单点）与**控制**（限流、熔断、降级、隔离，限制故障扩散）。

---

## 二、核心策略

| 故障场景 | 典型表现 | 应对手段 | 对应文章 |
|---------|---------|---------|---------|
| 单实例宕机 | 进程崩溃、机器掉电、Pod 被驱逐 | 多副本 + 健康检查 + 自动摘除 | [冗余与故障转移](/high-avail/2_redundancy_failover) |
| 数据库 / 缓存主节点故障 | 写入失败、连接中断 | 主从切换、哨兵 / Raft 选主、fencing 防脑裂 | [冗余与故障转移](/high-avail/2_redundancy_failover) |
| 流量超出容量 | 线程池 / 连接池耗尽，RT 飙升 | 限流、排队、负载卸除 | [限流](/high-avail/3_rate_limiting) |
| 下游依赖故障 | 调用超时、错误率上升 | 熔断快速失败 | [熔断](/high-avail/4_circuit_breaking) |
| 资源不足、非核心功能拖累 | 核心链路被挤占 | 主动降级、开关、兜底数据 | [降级](/high-avail/5_degradation) |
| 慢依赖引发雪崩 | 一个慢服务拖垮整条链路 | 舱壁隔离 + 超时 + 有限重试 | [隔离、重试与超时](/high-avail/6_bulkhead_retry) |
| 实例负载不均 / 容量不足 | 部分实例过热 | 负载均衡、HPA 弹性扩容 | [负载均衡](/high-avail/7_load_balancing) |
| 机房 / 地域级故障 | 整个 AZ 或城市不可用 | 同城双活、两地三中心、单元化 | [多活与容灾](/high-avail/8_multi_active) |
| 发布 / 配置变更 | 上线后错误率突增 | 优雅上下线、灰度、可回滚 | [优雅上下线与变更](/high-avail/9_graceful_release) |
| 未知脆弱点 | 预案从未演练，真出事时失效 | 故障注入、演练 | [混沌工程](/high-avail/10_chaos_engineering) |

> 经验数据：线上故障中相当大比例由**变更**（发布、配置、数据修复）引起，因此"变更可灰度、可监控、可回滚"与冗余同等重要。

治理组件的框架层用法（Sentinel、Resilience4j、Nacos 等）见 [Spring Cloud 服务治理](/spring-cloud/5_service_governance) 与 [Spring Cloud Alibaba](/spring-cloud/6_alibaba)。

---

## 三、与高性能、高并发的关系

| 维度 | 高性能 | 高并发 | 高可用 |
|------|-------|-------|-------|
| 关注问题 | 单次请求够不够快 | 流量大时扛不扛得住 | 出故障时停不停服 |
| 核心指标 | RT、P99 延迟、吞吐 | QPS / TPS、并发数、容量水位 | 可用率、MTTR、错误预算 |
| 典型手段 | 缓存、索引优化、异步化、减少 IO | 水平扩展、分库分表、削峰、池化 | 冗余、故障转移、限流熔断降级、多活 |
| 模块 | [高性能](/high-perf/0_overview) | [高并发](/high-con/0_overview) | 本模块 |

三者相互影响：性能差会放大并发压力，并发超出容量会演变为可用性故障；限流、降级等高可用手段又以牺牲部分请求为代价保住整体。

---

## 四、模块导航

| 文章 | 说明 |
|------|------|
| [可用性度量](/high-avail/1_sla_slo) | 几个 9、SLA / SLO / SLI、错误预算、MTBF / MTTR、串并联可用性计算 |
| [冗余与故障转移](/high-avail/2_redundancy_failover) | 冷备 / 温备 / 热备，主备 / 主主 / 集群，健康检查，自动切换，脑裂与 fencing，数据层 HA |
| [限流](/high-avail/3_rate_limiting) | 固定窗口 / 滑动窗口 / 令牌桶 / 漏桶，Redis + Lua，Guava，Gateway，Sentinel |
| [熔断](/high-avail/4_circuit_breaking) | 三态机，Sentinel / Resilience4j 规则，OpenFeign 集成 |
| [降级](/high-avail/5_degradation) | 系统级 / 业务级降级，静态 / 动态降级，规则持久化 |
| [隔离、重试与超时](/high-avail/6_bulkhead_retry) | 线程池 / 信号量隔离，指数退避重试，分层超时，负载卸除 |
| [负载均衡](/high-avail/7_load_balancing) | 负载均衡算法与层次，Nginx，Spring Cloud LoadBalancer，K8s HPA / PDB |
| [多活与容灾](/high-avail/8_multi_active) | RPO / RTO，同城双活，两地三中心，异地多活，单元化，流量调度 |
| [优雅上下线与变更](/high-avail/9_graceful_release) | 优雅停机，服务预热，灰度发布，变更三板斧 |
| [混沌工程](/high-avail/10_chaos_engineering) | ChaosBlade / Chaos Mesh，故障注入实战与检查单 |
| [面试高频题](/high-avail/99_interview) | 高可用方向问题汇总 |

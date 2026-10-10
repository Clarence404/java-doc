---
description: 三大信号、RED 与 USE、结构化日志、Loki 选型、指标类型与基数、PromQL、链路传播与采样、OpenTelemetry、告警与燃烧速率
---

# 可观测性面试题解答

> 题目清单见 [可观测性高频面试题](/observability/99_interview)；细节见 [可观测性总览](/observability/0_overview)。
>
> 版本基线：Spring Boot 4.x（Micrometer 1.16+ / Micrometer Tracing 1.6+）、OpenTelemetry Java agent 2.x、Prometheus 3.x、Loki 3.x、Grafana 13.x。

## 一、基础

### Q1：可观测性的三大信号是什么？各自解决什么问题？

**一句话**：指标告诉你「出没出事」，链路告诉你「事出在哪一跳」，日志告诉你「为什么出事」，三者靠 traceId 串起来才好用。

| 信号 | 回答的问题 | 成本特征 |
|------|------------|----------|
| 指标 | 健康吗、趋势如何 | 只和时间序列数（基数）有关 |
| 链路 | 一次请求慢在哪一段 | 量大，通常要采样 |
| 日志 | 具体发生了什么 | 随请求量线性增长，最贵 |

- 排障顺序：指标告警 → 链路找到慢的那一跳 → 看那一跳的日志和异常栈
- 互相跳转：日志带 traceId、直方图桶带 exemplar（指向一条具体 trace 的样本），否则三个后端是三座孤岛
- 第四种常被提到的是 Profiles（带调用栈的持续采样，火焰图），回答「代码层面为什么慢」

→ 详见 [可观测性总览](/observability/0_overview#一、三大信号与-profiles)

### Q2：监控和可观测性有什么区别？

**一句话**：监控是对「已知问题」预设看板和阈值；可观测性是遇到「没想到的问题」时，还能凭系统输出的数据临时下钻查清楚。

- 监控：先想好要看什么（CPU、错误率），配好图和告警，问题超出预设就抓瞎
- 可观测性：数据带足维度（标签、属性、traceId），可以按任意维度切片、关联、追溯
- 两者不是替代关系：可观测性平台上照样要有监控看板和告警
- 告警不是第四种信号，而是建在信号之上的判断规则

→ 详见 [可观测性总览](/observability/0_overview#一、三大信号与-profiles)

### Q3：RED、USE、四个黄金信号分别是什么？怎么用？

**一句话**：RED 看服务、USE 看资源、黄金信号看面向用户的系统；落地就是「每个服务一行 RED、每类关键资源一行 USE」，再加业务指标。

| 方法 | 看谁 | 指标 |
|------|------|------|
| RED | 服务 / 接口 | 请求速率、错误、耗时分布 |
| USE | CPU、线程池、连接池等资源 | 利用率、饱和度（排队）、错误 |
| 黄金信号 | 面向用户的系统 | 延迟、流量、错误、饱和度 |

- 黄金信号出自 Google SRE，可以看成 RED 加一项饱和度
- 排查：先用 RED 找到出问题的接口，再用 USE 查它依赖的资源
- 延迟看 P95 / P99，平均值会被大量快请求掩盖长尾

→ 详见 [指标监控](/observability/2_metrics#三、该看哪些指标-red、use-与四个黄金信号)

## 二、日志与指标

### Q4：为什么日志要结构化？字段怎么约定？

**一句话**：文本日志要靠正则解析，格式一变就失败；JSON 一行一个事件，采集端零解析，查询端直接按字段过滤。

- Spring Boot 3.4 起内置 `ecs`、`logstash`、`gelf` 三种结构化格式，全公司选定一种，字段名才统一
- 必带字段：时间戳（UTC）、级别、服务名 / 版本 / 环境、traceId / spanId（由 Micrometer Tracing 写入 MDC，MDC 即线程上的日志上下文）
- message 写给人看，订单号、耗时等放独立字段给机器查
- Pod、节点、命名空间由采集 Agent 补，应用不要自己写

**常见坑**：自己再生成一套 requestId，和 traceId 对不上；数值字段输出成字符串，没法做范围过滤。

→ 详见 [日志体系](/observability/1_logging#三、结构化日志与字段规范)

### Q5：ELK 和 Loki 怎么选？Loki 的标签该怎么设计？

**一句话**：要全文检索、复杂查询、安全审计选 Elasticsearch；以排障为主、已经用 Prometheus + Grafana 选 Loki，成本低得多。

- ES：所有字段建倒排索引，搜得强，但索引体积大、要 SSD、运维重
- Loki：只给标签建索引，正文压缩成块放对象存储，查询先按标签选流再扫描
- Loki 里一组标签值组合就是一条流（stream），标签越散流越多，索引膨胀、查询变慢
- 标签只放集群、命名空间、服务名、环境这类取值少的；traceId、orderId 绝不做标签，放结构化元数据（随日志存、可过滤、不分流）
- 日志量极大且要 SQL 统计分析时考虑 ClickHouse

→ 详见 [日志体系](/observability/1_logging#_2、loki-的标签与基数)

### Q6：Prometheus 的四种指标类型是什么？

**一句话**：Counter 只增不减、Gauge 可增可减、Histogram 按桶计数让服务端算分位数、Summary 在客户端直接算好分位数。

| 类型 | 典型指标 | 怎么查 |
|------|----------|--------|
| Counter | 请求数、下单数 | 必须套 `rate()` / `increase()` |
| Gauge | 队列长度、连接池活跃数 | 直接看或 `avg_over_time()` |
| Histogram | 请求耗时 | `histogram_quantile()` |
| Summary | 单实例耗时分位数 | 读 `quantile` 标签，不能跨实例聚合 |

- Counter 进程重启归零，裸值画出来是锯齿，`rate()` 会自动处理重置
- Micrometer 的 `Timer` 默认导出为 Summary，开 `publishPercentileHistogram()` 才变成 Histogram

→ 详见 [指标监控](/observability/2_metrics#_1、prometheus-类型与-micrometer-对应)

### Q7：Histogram 和 Summary 怎么选？

**一句话**：多副本部署的服务一律用 Histogram，因为桶计数可以相加、能跨实例聚合，分位数还能事后随便换。

- Histogram：分位数在 PromQL 查询时算，精度取决于桶边界（桶内线性插值，误差上限是桶宽）
- Summary：分位数在应用进程内算，较精确，但只有配置时指定的那几个
- 桶是累积的：`le="0.25"` 表示耗时不超过 0.25 秒的请求数
- 原生直方图（Native Histogram）用指数稀疏桶，精度更高、序列更少，Prometheus 3.x 已稳定

**常见坑**：把多个实例 Summary 的 `quantile="0.99"` 求平均当整体 P99，这个数没有任何统计意义。

→ 详见 [指标监控](/observability/2_metrics#_2、histogram-与-summary-怎么选)

### Q8：什么是高基数问题？怎么防？

**一句话**：一个指标的序列数等于各标签取值数相乘再乘桶数，把用户 ID、订单号这类无界值当标签，序列会爆炸，Prometheus 内存暴涨甚至 OOM。

- 用户 ID、订单号、手机号只放日志或 Span，不进指标标签
- URI 用路由模板 `/orders/{id}`，不要用原始路径 `/orders/1024`
- 异常用类名或错误码，不用 message；外部输入的值先映射白名单，未知归 `other`
- 应用侧用 `MeterFilter.maximumAllowableTags` 限取值数，抓取侧用 `sample_limit` 设单目标样本上限
- 排查用 Prometheus UI 的 TSDB Status 页，看哪个指标序列最多

→ 详见 [指标监控](/observability/2_metrics#_2、基数-指标系统最常见的事故)

### Q9：rate 和 irate 有什么区别？histogram_quantile 有哪些坑？

**一句话**：`rate` 是窗口内的平均每秒增长率，看板和告警默认用它；`irate` 只用最后两个样本，适合看尖刺，不要用来告警。

- `increase` = `rate` × 窗口秒数，有外推，结果可能是小数
- 窗口至少取抓取间隔的 4 倍，Grafana 里用 `$__rate_interval`
- 先 rate 后 sum：`sum(rate(x[5m]))` 对，先 sum 会把某实例重启的归零混进去
- `histogram_quantile` 聚合时必须保留 `le`：写 `sum by (le, uri)`，丢了 `le` 结果为空
- 不能对分位数再聚合，要聚合就回到桶上聚合

→ 详见 [指标监控](/observability/2_metrics#_3、聚合的坑)

## 三、链路追踪

### Q10：Trace、Span 是什么？链路是怎么跨服务串起来的？

**一句话**：Trace 是一次请求的完整调用链，由一棵 Span 树组成；每次跨进程调用时把 traceId 等上下文塞进请求头，接收方取出来当父级，链路就连起来了。

- Span：调用链里的一段工作，有开始时间、耗时、类型（SERVER / CLIENT / PRODUCER / CONSUMER）
- 发送方放上下文叫 Inject，接收方取叫 Extract，干这事的组件叫 Propagator
- 默认标准是 W3C `traceparent` 头：版本、traceId、父 spanId、采样标记四段
- traceId 全链路不变，父 spanId 每跳一次换成发送方的 spanId
- 新老系统混跑（如 B3）要让 Propagator 同时支持多种格式，否则在格式不一致的那一跳断开

→ 详见 [链路追踪](/observability/3_tracing#二、上下文传播)

### Q11：traceId 在线程池、@Async、MQ 里为什么会丢？怎么解决？

**一句话**：当前 Span 存在 ThreadLocal 里，一换线程就拿不到；跨 MQ 时消息里没带上下文也会断，解决办法是提交任务时拍快照、发消息时把上下文写进消息头。

- 线程池：给 `ThreadPoolTaskExecutor` 设 `ContextPropagatingTaskDecorator`，提交时快照、执行时恢复（含 MDC）
- `@Async`：Boot 4.1+ 设 `spring.task.execution.propagate-context=true`；`CompletableFuture` 传装饰过的执行器，别用默认 commonPool
- 虚拟线程同样不会自动继承上下文，自建执行器要用 `ContextExecutorService.wrap` 包装
- Kafka：开启 `spring.kafka.template/listener.observation-enabled`，`traceparent` 写进记录头，消费端据此续上
- 用 OTel Java agent 时，它会插桩 JDK 的 Executor，线程池上下文自动带上

**常见坑**：自己 `new` 的 `KafkaTemplate` 不读配置，要手动 `setObservationEnabled(true)`。

→ 详见 [链路追踪](/observability/3_tracing#_1、线程池与-async)

### Q12：头部采样和尾部采样有什么区别？

**一句话**：头部采样在请求一开始就决定留不留，简单省事但会丢掉大部分出错和慢的请求；尾部采样等整条链路结束后再按结果挑，能「错误全留、慢请求全留」，代价是 Collector 要缓存数据。

| 维度 | 头部采样 | 尾部采样 |
|------|----------|----------|
| 决策时机 | 根 Span 创建时 | Trace 结束后 |
| 能否按结果挑 | 不能 | 能 |
| 代价 | 几乎没有 | Collector 内存与 QPS 成正比 |

- 尾部采样要求同一 Trace 的 Span 落到同一 Collector，多副本前面加按 traceID 路由的 `load_balancing`
- 应用侧采样率要调到 1.0，否则 Collector 只能在已被丢掉的剩余数据里挑
- 中小规模用头部 0.1～1.0；大规模、重视错误链路用尾部采样

→ 详见 [链路追踪](/observability/3_tracing#五、采样策略)

### Q13：OpenTelemetry 由哪些部分组成？Java agent 和 Micrometer Tracing 怎么选？

**一句话**：OTel 是厂商中立的遥测标准，包括 API、SDK、插桩、Collector、OTLP 协议和语义约定；Java 接入要么零代码挂 agent，要么用 Spring 的 Micrometer 体系，二选一。

- API 与 SDK 分离：类库只依赖 API 埋点，没配 SDK 时调用是空操作
- Collector：独立进程，负责接收、批处理、脱敏、采样、加 K8s 元数据，换后端只改它的配置
- 语义约定：统一属性名（如 `http.request.method`），后端才能统一查询
- agent：字节码插桩，覆盖最广，但不支持原生镜像、启动变慢
- Micrometer（Boot 4 的 `spring-boot-starter-opentelemetry`）：加依赖、用 `management.*` 配置，支持原生镜像

**常见坑**：agent 和 Micrometer Tracing 同时启用，会产生重复的 Span。

→ 详见 [OpenTelemetry](/observability/5_opentelemetry#二、java-接入方式对比)

## 四、告警

### Q14：什么样的告警是好告警？Alertmanager 怎么降噪？

**一句话**：好告警必须可行动、对准用户能感知的症状、紧急度匹配通知方式、附 Runbook（处置手册）；Alertmanager 用分组、抑制、静默把一次故障压成少量有用通知。

- 症状（成功率降、P99 超标）才打电话；原因类（连接池等待、消费积压）进群当线索
- 分组：`group_by` 相同的告警合成一条，10 个实例挂了只发一条
- `group_wait` 等同批告警凑齐、`group_interval` 控制组内更新间隔、`repeat_interval` 控制重复提醒
- 抑制：根因或高等级告警 firing 时，压掉 `equal` 标签相同的下游症状或低等级告警
- 静默：发布窗口等计划内操作临时屏蔽

**常见坑**：抑制规则的 `equal` 标签两边都缺失也算相等，规则漏标签会误压别的服务的告警。

→ 详见 [告警体系](/observability/4_alerting#_1、四条标准)

### Q15：为什么推荐 SLO 燃烧速率告警？怎么配？

**一句话**：固定阈值「错误率 > 5%」要么太敏感要么太迟钝，燃烧速率直接衡量「错误预算花得多快」，更贴近对 SLO 的真实威胁。

- 错误预算 = 1 − SLO，如 99.9% 的月预算约 43 分钟
- 燃烧速率 = 实际错误率 / (1 − SLO)，为 1 表示刚好在周期结束时用完
- 典型配置：1 小时 + 5 分钟窗口、速率 14.4 立即呼叫（1 小时烧掉 2% 月预算）
- 长短双窗口同时满足才触发：长窗口保证不是毛刺，短窗口保证恢复后告警及时解除

→ 详见 [可用性度量](/high-avail/1_sla_slo#_2、燃烧速率告警)

---
description: 链路追踪与日志关联、统一指标与告警、SLO 与燃烧率告警、业务大盘、金丝雀发布与自动回滚、先扩后缩、优雅上下线
---

# 可观测与发布

> 前置阅读：[跨服务一致性](./7_consistency)、[可观测性总览](/observability/0_overview)、[发布策略](/devops/7_release_strategy)

拆成 4 个服务、每天发布数次之后，「出了问题能不能很快看到、发错了能不能很快退回」成了大促前必须补的课。本篇讲链路追踪与日志、统一告警与业务大盘、金丝雀发布与数据库变更，基线为 Spring Boot 4、Kubernetes 1.37、Prometheus 3、Argo CD 3。

---

## 一、背景

进入阶段四，日常下单约 300 QPS，大促峰值 5000 QPS；团队仍是 20 人，新增 1 名专职 SRE。上一篇 [稳定性](./8_stability) 管的是「依赖出问题时别被拖垮」，这一篇管的是「出了问题能不能看见、改坏了能不能退回」。阶段三留下了三笔账：

- **排障要翻 3 处日志**：一次下单经过 `mall-gateway`、`mall-app`、`inventory-service`，日志散在不同 Pod 里，只能按时间和订单号逐个 `kubectl logs` 去对；网关里的请求和库存服务里的那次 `reserve` 对不上号。近两个月的 6 次线上问题，定位平均花了 40 分钟，其中 30 分钟在找日志；[稳定性 · 背景](./8_stability#一、背景) 里年中大促那 25 分钟，值班也是先翻了一轮日志，才确认慢在库存服务的 `reserve`
- **告警分散在 5 个地方**：Redis 的内存与主从切换在云监控，消费堆积与死信在 RocketMQ 托管控制台，`outbox.pending.age` 和缓存命中率在各服务的 Actuator 里，接口错误率没人配。[引入缓存](./4_cache) 和 [异步化](./5_async) 定下的那些阈值各发各的群，值班的人收到告警也不知道该先看哪个
- **发布从每周 1 次变成每天 3–5 次**：仍是 Kubernetes 默认的滚动更新，新版本在 10 分钟内替换完全部 Pod，坏版本也一样。上个月 `inventory-service` 一次发布让 `reserve` 有 2% 的请求返回 500，25 分钟后才被客服反馈发现，回滚又花了 10 分钟

一致性窗口也需要被看见：[跨服务一致性](./7_consistency) 里「支付成功 → 订单待发货」平时在 1 秒内完成，可一旦消费积压就会拉长到分钟级，目前只能等用户投诉。

---

## 二、选项

### 1、链路与日志

| 方案 | 做法 | 青柚的代价 |
|------|------|-----------|
| 继续只看日志 | 网关生成请求 ID，各服务透传后写进日志 | 只能串日志，看不出哪一跳慢；RocketMQ、JDBC、Redis 调用都要自己埋点 |
| Micrometer Tracing | 每个服务加依赖，经 OTel bridge 导出 | 和 Spring 的 Observation 对齐；但 RocketMQ 5 客户端没有现成埋点，要自己写 |
| OpenTelemetry Java Agent | 镜像里挂 `-javaagent`，零代码自动埋点 | 启动慢几秒，内存多占一些；agent 版本要跟着升级 |
| SkyWalking | 自带 agent、OAP 与 UI | 一套独立的存储和界面，和 Prometheus、Grafana 不互通 |
| 云厂商 APM | 托管，开箱即用 | 数据在厂商侧，指标与告警要分别在两边维护 |

日志存储在 ELK 和 Loki 之间选：ELK 全文检索强，但索引全部字段，存储和运维成本都高；Loki 只给少量标签建索引、按 traceId 过滤行，和 Tempo、Prometheus 同在 Grafana 里互相跳转。两者的对比见 [日志体系 · 三类方案对比](/observability/1_logging#_1、三类方案对比)。

### 2、发布

| 方案 | 回滚速度 | 青柚的代价 |
|------|---------|-----------|
| 滚动更新（现状） | 再滚一次，约 10 分钟 | 坏版本会逐步替换全部 Pod，靠人盯 |
| 蓝绿 | 秒级切回 | 双倍资源；一次切全部流量，出问题时影响面是 100% |
| 手工金丝雀 | 快 | 每一步要有人改权重、看大盘，每天 3–5 次发布盯不过来 |
| Argo Rollouts 渐进式交付 | 自动中止，分钟级 | 要学 `Rollout` 资源；分析指标选错会误判 |

各种发布方式的对比见 [发布策略 · 发布方式全景](/devops/7_release_strategy#一、发布方式全景)。

---

## 三、决策

| 方面 | 决策 | 理由 |
|------|------|------|
| 采集 | OpenTelemetry Java Agent 2.x → OTel Collector | 4 个服务零代码接入，HTTP、JDBC、Lettuce、RocketMQ 5 客户端都有自动埋点；后端以后换了只改 Collector |
| 链路 | Tempo，Collector 尾部采样 | 只存对象存储，不建索引；错误和慢请求全部保留 |
| 指标 | Prometheus 抓取各服务 `/actuator/prometheus` | 阶段二已有的 Micrometer 指标（命中率、`outbox.pending.age`）原样复用 |
| 日志 | JSON 输出到 stdout，Collector 采集进 Loki | 日志带 `trace_id`，从 Trace 一键跳到这次请求的全部日志 |
| 告警 | SLO 燃烧率告警 + 组件告警，统一经 Alertmanager 推到值班 IM | 一个入口、一套分级；云监控和 MQ 控制台的告警下线 |
| 发布 | GitHub Actions 构建镜像 → Argo CD 同步 → Argo Rollouts 金丝雀 5% → 25% → 100% | 每步按错误率和 P99 自动分析，不达标自动回滚，目标 5 分钟内恢复 |
| 数据库变更 | Flyway，先扩后缩 | 任何时刻回滚代码都不需要回滚表结构 |

agent 只负责链路，指标仍走 Micrometer：agent 2.x 默认不桥接 Micrometer 指标，两边都开会出现两套口径不同的 HTTP 指标，所以关掉 agent 的指标导出。两条接入路线的取舍见 [OpenTelemetry · Java 接入方式对比](/observability/5_opentelemetry#二、java-接入方式对比)。没选 Micrometer Tracing，是因为 4 个服务都要加依赖、改配置，RocketMQ 5 客户端的生产与消费还得自己埋点；agent 只改镜像和环境变量，代价是启动慢几秒、agent 版本要跟着升级。[接口设计](./3_api_design) 约定的 `ProblemDetail.traceId` 字段名不变，取值改成从 OpenTelemetry 的当前 Span 读，见第五节。

### 1、明确不做

- **不上服务网格**：金丝雀按 Pod 数分流已经够用，Istio 的 sidecar 和控制面要 SRE 专门维护，触发条件放到「复盘」讨论
- **不自建 ELK，不存全量日志**：INFO 日志在 Loki 保留 7 天，ERROR 保留 30 天；审计类日志另走数仓
- **不买商业 APM，不做自动根因分析**：先把三类信号串起来，人能 5 分钟内定位，再谈自动化
- **暂不做持续剖析**：CPU 热点靠压测时临时抓火焰图，方法见 [持续剖析与 eBPF](/observability/6_profiling)
- **不做蓝绿**：大促时 `mall-app` 有 16 个 Pod，双倍资源不划算，金丝雀的影响面也更小

---

## 四、三类信号怎么串起来

![青柚商城的可观测数据流：应用 → OTel Collector → Tempo / Loki / Prometheus → Grafana 与 Alertmanager](../assets/project/observability-pipeline.svg)

- **一次请求一个 traceId**：agent 在 `mall-gateway` 入口生成 Trace，经 HTTP 头 `traceparent` 传到 `mall-app` 和 `inventory-service`，经消息属性传到消费者；每一跳的耗时、SQL、Redis 命令都在同一个 Trace 里
- **日志带 traceId**：agent 往 MDC 写 `trace_id`、`span_id`，结构化日志原样输出成 JSON 字段；Grafana 里从 Tempo 的 Span 点「查看日志」，就是按这个字段过滤 Loki
- **指标暂不带 exemplar**：Micrometer 要给直方图附带 traceId，得有 `SpanContext` 来源（Micrometer Tracing，或 agent 的 Micrometer 桥接），青柚两者都没开；即使开了，尾部采样丢掉的普通 Trace 对应的 exemplar 也点不开。从 P99 尖刺到链路，按服务、接口和时间窗在 Tempo 里用 TraceQL 查慢 Trace

Collector 分两层：每个节点一个 DaemonSet 接收本节点 Pod 的 OTLP 并读取容器日志；Span 按 traceId 转发给网关层的 3 个副本做尾部采样，错误、慢于 800ms 的 Trace 全部保留，其余保留 10%。部署方式见 [OpenTelemetry · 在 Kubernetes 上部署](/observability/5_opentelemetry#六、在-kubernetes-上部署)，采样策略的取舍见 [链路追踪 · 采样策略](/observability/3_tracing#五、采样策略)。

---

## 五、关键实现

### 1、挂 agent、输出 JSON 日志

agent 打进基础镜像，配置全部由环境变量传入（以 `mall-app` 为例，节选）：

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-javaagent:/opt/otel/opentelemetry-javaagent.jar"
  - name: OTEL_SERVICE_NAME
    value: mall-app
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: service.namespace=qingyou,deployment.environment.name=prod
  - name: NODE_IP
    valueFrom: {fieldRef: {fieldPath: status.hostIP}}
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://$(NODE_IP):4318                  # 发给本节点的 Collector
  - name: OTEL_TRACES_SAMPLER_ARG
    value: "1.0"                                   # 全量上报，采样交给 Collector
  - name: OTEL_METRICS_EXPORTER
    value: none                                    # 指标走 Micrometer，避免两套口径
  - name: OTEL_LOGS_EXPORTER
    value: none                                    # 日志走 stdout，由 Collector 采集
```

```yaml
# application.yml（各服务公共部分，放 Nacos 的 mall-common.yaml）
logging:
  structured:
    format:
      console: logstash          # MDC 里的 trace_id、span_id 成为 JSON 顶层字段
management:
  metrics:
    tags:
      application: ${spring.application.name}
    distribution:
      slo:
        http.server.requests: 800ms      # 生成 le="0.8" 的桶，延迟 SLO 直接用它算
```

Loki 只用 `namespace`、`app`、`level` 三个标签，traceId 不做标签，原因见 [日志体系 · Loki 的标签与基数](/observability/1_logging#_2、loki-的标签与基数)。错误响应里的 `traceId` 改从当前 Span 取，阶段一的 `TraceIdFilter` 下线：

```java
pd.setProperty("traceId", Span.current().getSpanContext().getTraceId());   // 字段名不变，客户端无感
```

### 2、让 Trace 穿过本地消息表

agent 能自动把 `traceparent` 写进 RocketMQ 消息，但 `t_outbox` 的消息由 `OutboxRelayJob` 在另一个线程发出，Trace 在这里断开：消费者那一段会挂到一个和下单无关的定时任务下。解法是写 outbox 时把当前的 `traceparent` 一起存下，投递时再恢复：

```java
// OutboxWriter.append：与业务数据同一事务写入
Map<String, String> carrier = new HashMap<>();
W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, Map::put);
record.setTraceParent(carrier.get("traceparent"));        // 定时消息 order-timeout 不存，免得一条 Trace 拖 15 分钟

// OutboxRelay.send：在原 Trace 下发送，agent 生成的 producer span 挂回下单请求
Context parent = W3CTraceContextPropagator.getInstance().extract(Context.root(), r, OUTBOX_GETTER);
try (Scope ignored = parent.makeCurrent()) {
    producer.send(b.build());
}
```

`OUTBOX_GETTER` 是一个只返回 `r.traceParent()` 的 `TextMapGetter`。`mall-app`、`payment-service`、`inventory-service` 三份 `t_outbox` 都加 `trace_parent` 列，迁移脚本见第七节。改完后，从网关的下单请求一路能看到 `payment-succeeded`、`order-paid` 的生产与各消费组的处理，一致性窗口里每一段花了多久一目了然。

### 3、SLO 与燃烧率告警

| SLO | 口径（30 天） | 错误预算 |
|-----|--------------|---------|
| 下单成功率 99.9% | `POST /api/orders` 中非 5xx 的占比；`STOCK_INSUFFICIENT` 这类 4xx 业务失败不算错 | 0.1%，按日订单 100 万约 3 万次失败请求 |
| 下单 P99 < 800ms | 800ms 内完成的请求占比 ≥ 99% | 1% 的请求可以慢于 800ms |

告警不按「错误率 > x%」，而按错误预算的燃烧速率，快慢两档。下面是成功率 SLO 的规则（延迟 SLO 写法相同，把分子换成 `le="0.8"` 桶之外的请求）：

```yaml
groups:
  - name: mall-app-place-order-slo
    rules:
      - record: slo:place_order:error_ratio:rate5m
        expr: |
          sum(rate(http_server_requests_seconds_count{application="mall-app",method="POST",uri="/api/orders",status=~"5.."}[5m]))
          / sum(rate(http_server_requests_seconds_count{application="mall-app",method="POST",uri="/api/orders"}[5m]))
      # rate30m、rate1h、rate6h 同理，略
      - alert: PlaceOrderBudgetFastBurn          # 1 小时烧掉月度预算的 2%
        expr: |
          slo:place_order:error_ratio:rate1h > (14.4 * 0.001)
          and slo:place_order:error_ratio:rate5m > (14.4 * 0.001)
        labels: {severity: page, team: trade}
        annotations:
          summary: "下单错误预算快速燃烧，当前错误率 {{ $value | humanizePercentage }}"
      - alert: PlaceOrderBudgetSlowBurn          # 6 小时烧掉 5%
        expr: |
          slo:place_order:error_ratio:rate6h > (6 * 0.001)
          and slo:place_order:error_ratio:rate30m > (6 * 0.001)
        labels: {severity: page, team: trade}
```

`page` 级推到值班 IM 并电话呼叫，`ticket` 级只进值班群、第二天处理。燃烧速率的公式和阈值表见 [可用性度量 · 燃烧速率告警](/high-avail/1_sla_slo#_2、燃烧速率告警)，Alertmanager 的分组、抑制与路由见 [告警体系 · Alertmanager 路由与通知](/observability/4_alerting#三、alertmanager-路由与通知)。

### 4、统一告警：把前几篇的阈值收拢

阶段二、三定下的阈值不改口径，连同上一篇新增的熔断、限流指标，全部迁到 Prometheus 规则里。Redis 用 `redis_exporter` 抓取，RocketMQ 托管实例的堆积与死信通过云厂商的 Prometheus 接入导入：

| 来源 | 指标 | 告警条件 | 级别 |
|------|------|---------|------|
| [引入缓存](./4_cache) | 商品详情回源 QPS | 超过 100 QPS | page |
| 同上 | L1 命中率；Redis `evicted_keys`、主从切换 | 命中率低于 70%；驱逐大于 0；发生切换 | ticket |
| [异步化](./5_async) | `outbox.pending.age`（三个服务） | 超过 1 分钟 | page |
| 同上 | `t_outbox` 失败记录数；各消费组死信数 | 大于 0（`notify-consumer` 的死信除外） | ticket |
| 同上 | 各消费组堆积量、消费延迟 | 堆积超过 5000 条或延迟超过 5 分钟 | ticket |
| [跨服务一致性](./7_consistency) | `order-payment-consumer` 消费延迟 | 超过 1 分钟 | page |
| 同上 | 对账差异数 `reconcile.diff.count` | 大于 0 | ticket |
| [稳定性](./8_stability) | `inventory-reserve`、`payment-query` 熔断器状态 | 进入 OPEN | page |
| 同上 | 舱壁拒绝数、网关 429 比例、`ORDER_PENDING_LIMIT` 次数 | 持续 5 分钟高于压测时的基线 | ticket |

熔断与舱壁的指标由 Resilience4j 的 Micrometer 绑定暴露，网关的 429 来自 `mall-gateway` 自己的 HTTP 指标。`order-payment-consumer` 单独收紧到 1 分钟，因为它就是「支付成功，订单确认中」那个窗口；其余消费组晚几分钟只是积分、通知晚到。RocketMQ 实例整体不可用时，用 Alertmanager 的抑制规则压掉各消费组的堆积告警，只留根因那一条。

### 5、业务大盘

技术指标正常不代表生意正常，所以单独有一块业务大盘，大促时投在值班室的屏幕上：

| 面板 | 看什么 | 异常的样子 |
|------|-------|-----------|
| 下单量（每分钟） | 与上周同时段对比 | 突然掉一半而错误率不高，多半是前端或网关的问题 |
| 支付成功率（按渠道） | 渠道回调成功的占比 | 某个渠道单独下跌，切换默认渠道 |
| `t_outbox` 最老待发送时长 | 三个服务各一条线 | 持续上涨说明中继或 Broker 出了问题 |
| 各消费组堆积 | `order-payment-consumer` 置顶 | 只有一个组涨，是这个组的下游慢了 |
| 对账差异数 | 每天凌晨的结果 | 某类差异连续两天出现，说明有系统性 bug |
| 稳定性保护 | 熔断器状态、限流命中、`qingyou.degrade.*` 当前取值 | 大促时一眼看出哪些保护正在起作用、哪些功能已被降级 |

`outbox` 待发送时长与消费堆积分开看，就能把「一致性窗口变长」定位到中继、Broker 还是消费者那一段，这个思路在 [异步化](./5_async) 里已经用过。看板的布局原则见 [指标监控 · Grafana 看板设计](/observability/2_metrics#_2、grafana-看板设计)。

---

## 六、金丝雀发布与自动回滚

![金丝雀发布：构建 → 同步 → 5% → 25% → 100%，每步分析不达标自动中止](../assets/project/canary-release-steps.svg)

流水线分工：GitHub Actions 跑 `./mvnw -B verify`、构建镜像、把镜像 digest 写进 GitOps 仓库；Argo CD 发现变更后同步，先用 PreSync 钩子执行 Flyway 迁移，再更新 `Rollout` 的镜像；Argo Rollouts 按步骤放量并自动分析。流水线与 GitOps 的写法见 [CI/CD · 拉取式部署：GitOps](/devops/4_ci_cd#五、拉取式部署-gitops)，钩子见 [Argo CD · Sync Wave 与钩子](/cloud-native/9_argocd#_3、sync-wave-与钩子)。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: mall-app
  namespace: qingyou
spec:
  replicas: 4
  # selector、template 与阶段三的 Deployment 相同（含探针、preStop），略
  strategy:
    canary:
      analysis:
        startingStep: 1                   # 从第一次暂停开始持续分析
        templates: [{templateName: canary-health}]
        args:
          - name: app
            value: mall-app
          - name: canary-hash
            valueFrom: {podTemplateHashValue: Latest}
      steps:
        - setWeight: 5
        - pause: {duration: 5m}
        - setWeight: 25
        - pause: {duration: 10m}
        - setWeight: 100
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: canary-health
  namespace: qingyou
spec:
  args: [{name: app}, {name: canary-hash}]
  metrics:
    - name: error-rate
      interval: 1m
      failureLimit: 1                     # 累计两次不达标即中止
      successCondition: result[0] < 0.005
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(rate(http_server_requests_seconds_count{application="{{args.app}}",rollouts_pod_template_hash="{{args.canary-hash}}",status=~"5.."}[2m]))
            / sum(rate(http_server_requests_seconds_count{application="{{args.app}}",rollouts_pod_template_hash="{{args.canary-hash}}"}[2m]))
    - name: p99
      interval: 1m
      failureLimit: 1
      successCondition: result[0] < 0.8
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            histogram_quantile(0.99, sum by (le) (rate(http_server_requests_seconds_bucket{application="{{args.app}}",rollouts_pod_template_hash="{{args.canary-hash}}"}[2m])))
```

几个落地细节：

- **按 Pod 数分流，不配 `trafficRouting`**：网关和服务之间按 Nacos 里的实例轮询，Kubernetes 层的权重路由管不到这段流量，Rollouts 就按比例换算金丝雀 Pod 数并向上取整。平时 `mall-app` 只有 4 个 Pod，5% 这一步实际是一个 Pod 的份额，比名义值大；要精确到 5% 得有按权重切流的网关或服务网格，现阶段接受这个误差
- **指标只看金丝雀**：Prometheus 抓取时把 Pod 标签 `rollouts-pod-template-hash` 带进指标，分析查询按它过滤；样本太少时比率抖动大，所以每步至少暂停 5 分钟
- **5 分钟回滚怎么来**：分析每分钟一次、两次不达标即中止，Rollouts 把金丝雀缩容、流量回到稳定版本，从坏指标出现到恢复约 3 分钟；中止后 GitOps 仓库里还是新版本，由发布人 revert 那次提交，Argo CD 不会再把它推上去
- **大促前 48 小时冻结**：冻结期内 Argo CD 关闭自动同步，只允许经值班负责人批准的修复，与 [稳定性](./8_stability) 的大促预案一致；批准的修复同样走金丝雀和自动分析，不再全靠审批把关

Rollout 与 AnalysisTemplate 的完整字段见 [发布策略 · 渐进式交付：Argo Rollouts](/devops/7_release_strategy#五、渐进式交付-argo-rollouts)。

### 1、上线与下线不丢请求

金丝雀放量和回滚都在频繁地起停 Pod，阶段三的探针和 `preStop` 在这里变成了每天都要经过的路径。在 [拆分服务](./6_split) 的基础上补两条：

- **预热完成再注册**：Nacos 的自动注册发生在 Web 服务器启动时，早于预热；改为关掉自动注册（`spring.cloud.nacos.discovery.register-enabled: false`），在就绪状态变为 `ACCEPTING_TRAFFIC` 时再注册。预热放在 `ApplicationRunner` 里：建好连接池、加载头部商品进 L1，所以 readiness 和 Nacos 注册都在预热之后
- **停机先注销、再停消费、最后停 Web**：`preStop` 先从 Nacos 注销并等待 15 秒，`server.shutdown: graceful` 让在途请求处理完；RocketMQ 消费者在 Spring 容器关闭时先停止拉取，已拉到的消息处理完再退出，处理不完的由 Broker 重投，靠消费幂等兜住

```java
@Component
@RequiredArgsConstructor
class RegisterWhenReady {
    private final ServiceRegistry<Registration> serviceRegistry;
    private final Registration registration;

    @EventListener
    void onReadiness(AvailabilityChangeEvent<ReadinessState> event) {
        if (event.getState() == ReadinessState.ACCEPTING_TRAFFIC) {
            serviceRegistry.register(registration);      // 预热完成才进入 Nacos，网关才会把流量发过来
        }
    }
}
```

停机顺序与参数见 [优雅上下线与变更 · Kubernetes 配合](/high-avail/8_graceful_release#_3、kubernetes-配合)，预热写法见 [优雅上下线与变更 · 预热完成再就绪](/high-avail/8_graceful_release#_1、预热完成再就绪)。

### 2、功能开关

新代码先发布、默认关闭，再由开关逐步打开，这样「部署」和「放出功能」是两件事。开关和 [稳定性](./8_stability) 的降级开关放在同一处 Nacos 配置里，按 `qingyou.feature.*` 命名，每个开关登记负责人和到期时间，上线一个月后清理。

改 Nacos 配置等同于一次发布：降级开关、限流阈值和功能开关的配置文件放在 GitOps 仓库里评审，合并后由流水线推送；先用 Nacos 的 Beta 发布推给一个 Pod 观察 5 分钟再全量，回滚就是 revert 后重新推送，每次变更都有提交记录。应急降级来不及走流程时，值班负责人可以直接在 Nacos 控制台改，事后补提交。功能开关的做法见 [环境管理 · 功能开关](/devops/6_env_management#五、功能开关-feature-flag)。

---

## 七、数据库变更：先扩后缩

金丝雀期间新旧两个版本同时在跑，回滚时旧版本要能面对新表结构，所以每次表变更都得让新旧代码都能跑。全部 DDL 进 Flyway，迁移由 PreSync Job 用有 DDL 权限的账号执行，应用 Pod 上 `spring.flyway.enabled=false`，运行账号只有 DML 权限。

第五节的 `trace_parent` 是一次纯扩展，旧版本不认识这一列，照常插入，值为空：

```sql
-- mall-app：db/migration/V20261020_01__outbox_add_trace_parent.sql（另两个服务同样一份）
ALTER TABLE t_outbox ADD COLUMN trace_parent VARCHAR(55) NULL COMMENT 'W3C traceparent，可为空' AFTER payload;
```

删东西才需要「缩」，而且要拆成几次发布。拆库遗留在 `qingyou_mall` 里的 `t_inventory` 和 `t_payment` 就是这样收掉的：

| 发布 | 迁移脚本 | 代码 | 能否回滚到上一版 |
|------|---------|------|----------------|
| 第 1 次 | 无 | 删掉对旧表的最后一处只读引用（运营报表） | 能，旧表还在 |
| 第 2 次（一个发布周期后） | `RENAME TABLE t_inventory TO t_inventory_deprecated`（`t_payment` 同理） | 无 | 能；万一有漏网的读，报错暴露出来，改名回去即可 |
| 第 3 次（再观察两周） | `DROP TABLE t_inventory_deprecated` | 无 | 不涉及，已无代码依赖 |

加列带默认值、加索引前先在压测环境用同量级数据测耗时；`t_order` 这类大表的 DDL 走 Online DDL，超过 5 分钟的交给 gh-ost 在低峰单独执行，不放进 PreSync。Flyway 的命名、并发迁移和上线规范见 [数据库版本迁移 · 并发迁移与发布](/spring-boot/4_flyway#_5、并发迁移与发布)，先扩后缩的通用步骤见 [发布策略 · 数据库变更：先扩展后收缩](/devops/7_release_strategy#_2、数据库变更-先扩展后收缩)。

---

## 八、代价与后续

上线两个月的数据：线上问题的平均定位时间从 40 分钟降到 8 分钟；发布导致的故障有 3 次被金丝雀分析拦下，影响面都只有一个 Pod，均在 5 分钟内自动回滚。

| 本篇的决策 | 带来的问题 | 在哪里解决 |
|-----------|-----------|-----------|
| 自建 Collector、Tempo、Loki、Prometheus | 一整套平台要 SRE 维护，Prometheus 单实例的容量和保留期有上限 | 暂时接受；序列数过百万时再上长期存储，见 [指标监控 · 存储与高可用](/observability/2_metrics#_5、存储与高可用) |
| 尾部采样保留 10% 正常 Trace | 用户报「下单成功但慢」时，那次请求可能没被保留 | 用日志里的 `trace_id` 找回调用顺序；慢于 800ms 的本来就全留 |
| 金丝雀按 Pod 数分流 | 第一步的实际比例大于 5%，也做不到按用户或地域灰度 | 「复盘」：服务网格什么时候值得上 |
| 先扩后缩 | 一次删列、改名要拆成 2–3 次发布，周期以周计 | 接受，这是「随时能回滚」的价格 |
| 对账仍是每日一次 | 有了大盘和告警，差异仍要到第二天才知道 | 「复盘」：什么时候值得做准实时对账 |

---

## 小结

- 阶段四的三笔账：排障要翻 3 处日志、告警分散在 5 个地方、每天 3–5 次发布却靠滚动更新加人盯
- 采集统一用 OpenTelemetry Java Agent 2.x → OTel Collector：链路进 Tempo 并尾部采样，日志 JSON 带 `trace_id` 进 Loki，指标仍由 Micrometer 暴露给 Prometheus，一起在 Grafana 里看
- 本地消息表要手动存取 `traceparent`，否则 Trace 在中继处断开；定时消息不带，免得 Trace 拖 15 分钟
- 下单成功率 99.9%、P99 < 800ms 两条 SLO，按燃烧率快慢两档告警；缓存、Outbox、消费堆积、死信、对账差异的阈值原样收进 Prometheus，再加上熔断与限流指标，经 Alertmanager 统一推送
- 发布走 GitHub Actions → Argo CD → Argo Rollouts，5% → 25% → 100% 每步自动分析错误率与 P99，不达标自动回滚，约 3 分钟恢复
- 表结构只做向前兼容的变更，删除拆成多次发布；预热完成再注册，停机先注销再停消费；不上服务网格、不做蓝绿

---

## 参考资料

- OpenTelemetry · Java Agent Configuration：[https://opentelemetry.io/docs/zero-code/java/agent/configuration/](https://opentelemetry.io/docs/zero-code/java/agent/configuration/)
- Google SRE Workbook · Alerting on SLOs：[https://sre.google/workbook/alerting-on-slos/](https://sre.google/workbook/alerting-on-slos/)
- Argo Rollouts · Canary Deployment Strategy：[https://argo-rollouts.readthedocs.io/en/stable/features/canary/](https://argo-rollouts.readthedocs.io/en/stable/features/canary/)
- Argo Rollouts · Analysis & Progressive Delivery：[https://argo-rollouts.readthedocs.io/en/stable/features/analysis/](https://argo-rollouts.readthedocs.io/en/stable/features/analysis/)
- Spring Boot How-to · Database Initialization：[https://docs.spring.io/spring-boot/how-to/data-initialization.html](https://docs.spring.io/spring-boot/how-to/data-initialization.html)

> 下一篇：[复盘](./10_retrospective) —— 把四个阶段的决策串成一条时间线，看哪些做对了、哪些可以重来

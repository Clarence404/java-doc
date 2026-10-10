---
description: 好告警标准、Prometheus 告警规则、Alertmanager 路由抑制静默、IM 通知接入、降噪与漏报
---

# 告警体系

> **本篇目标**：以 order-service 为例，从「什么样的告警值得发」出发，写出一组可直接上线的 Prometheus 告警规则并用 promtool 做单元测试；再用 Alertmanager 的路由树、分组、抑制和静默把告警送到对的人，接入钉钉 / 飞书 / 企业微信与邮件；最后讲降噪手段、典型误报与漏报，以及 Grafana Alerting 与 Alertmanager 怎么选。
>
> **前置阅读**：[指标监控](./2_metrics)、[Actuator 监控](/spring-boot/7_actuator)、[可用性度量](/high-avail/1_sla_slo)

本篇只讲「告警怎么定义、怎么投递」。边界划分如下：SLO、错误预算和燃烧速率的计算见 [可用性度量](/high-avail/1_sla_slo)；故障分级（P0–P3）、On-call 排班、升级路径和复盘见 [故障应急与复盘](/high-avail/11_incident_response)；应用侧如何暴露 `/actuator/prometheus` 指标见 [Actuator 监控](/spring-boot/7_actuator) 第六节；Prometheus 长期存储与高可用见 [时序数据库](/database/4_nosql/1_time_series_db)。版本以 2026 年 10 月为准：Prometheus 3.x、Alertmanager 0.34。

---

## 一、什么是好告警

### 1、四条标准

告警的唯一目的是**让人采取行动**。每多一条无须处理的告警，值班人对下一条告警的信任就少一分，最后真正的故障被淹没在噪声里。一条合格的告警应同时满足：

| 标准 | 含义 | 反例 |
|------|------|------|
| 可行动 | 收到后有明确的事要做，且必须由人做 | 「CPU 使用率 80%」，看完什么也不用做 |
| 对准症状 | 告警用户能感知到的问题（失败、变慢、不可达），而不是内部原因 | 「某个线程池队列有积压」，但接口成功率和延迟都正常 |
| 紧急度匹配通知方式 | 需要立即处理的才打电话，其余进群或进工单 | 磁盘 7 天后写满，半夜电话叫醒值班 |
| 有 Runbook | 每条告警附处置手册链接：含义、影响、排查步骤、止血手段 | 告警只有一句「order-service 异常」 |

「对准症状」不等于不监控原因。原因类指标（线程池、连接池、GC、磁盘）照样采集、上看板，只是**不直接呼叫人**：它们作为 warning 进群、作为定位线索出现在 Runbook 里，或者作为「快要出事」的预警（如磁盘按趋势预测写满）。

| 层次 | 示例 | 通知方式 |
|------|------|---------|
| 症状（用户可感知） | 下单成功率下降、P99 超标、拨测失败、错误预算快速燃烧 | critical：电话 / 短信 + 值班群 |
| 原因（即将影响用户） | 连接池等待、消费积压持续增长、老年代 GC 后仍接近满 | warning：团队工作群 |
| 趋势（需要计划处理） | 磁盘 3 天内写满、证书 14 天内过期 | info：邮件或工单 |

告警级别（critical / warning / info）与故障级别（P0–P3）是两回事：前者决定**怎么通知**，后者是故障发生后对**影响范围**的判定，后者见 [故障应急与复盘](/high-avail/11_incident_response) 第一节。

### 2、告警来源分层

| 来源 | 工具 | 发现什么 | 特点 |
|------|------|---------|------|
| 黑盒探测 | blackbox_exporter、外部拨测平台 | 从用户视角看「能不能访问」：DNS、TLS、HTTP 状态码 | 最接近用户感受；应用完全收不到请求时只有它能发现 |
| 指标 | Prometheus 告警规则 | 错误率、延迟、饱和度、资源 | 主力，规则表达力强、成本低 |
| 日志 | Loki Ruler、Elasticsearch Watcher | 特定错误关键字、异常堆栈突增 | 适合指标覆盖不到的场景，查询成本高，规则要少而精 |
| 链路 | Trace 后端的 RED 指标（由 Span 派生） | 某条调用链、某个下游的延迟与错误 | 通常先转成指标再告警，而不是直接对 Span 告警 |

实践中以指标告警为主、黑盒探测兜底，日志告警只用于少数「只在日志里出现」的信号（如对账失败、支付回调验签失败）。Loki Ruler 的规则格式与 Prometheus 相同，只是 `expr` 写 LogQL：

```yaml
# Loki ruler 规则文件：订单服务错误日志占比超过 5%
groups:
  - name: order-service-logs
    rules:
      - alert: OrderServiceErrorLogRatioHigh
        expr: |
          sum by (app) (rate({namespace="order", app="order-service"} |= "ERROR" [5m]))
          /
          sum by (app) (rate({namespace="order", app="order-service"} [5m]))
          > 0.05
        for: 10m
        labels:
          severity: warning
          team: order
        annotations:
          summary: "order-service ERROR 日志占比 {{ $value | humanizePercentage }}"
          runbook_url: "https://wiki.example.com/runbook/order-service#error-log-ratio"
```

日志的采集与结构化见 [日志体系](./1_logging)，链路派生指标见 [链路追踪](./3_tracing)。

---

## 二、Prometheus 告警规则

### 1、告警的生命周期

Prometheus 按 `evaluation_interval`（全局默认 1m）周期性计算规则表达式，表达式返回的**每条时间序列**都是一个告警实例：

| 状态 | 含义 |
|------|------|
| inactive | 表达式没有返回该序列 |
| pending | 表达式返回了该序列，但持续时间还不到 `for` |
| firing | 持续时间达到 `for`，Prometheus 开始把告警推给 Alertmanager |

- **`for`**：条件必须连续满足这么久才触发，过滤瞬时毛刺。中途有一次不满足就回到 inactive，重新计时
- **`keep_firing_for`**：条件不再满足后继续保持 firing 一段时间，防止指标在阈值附近来回跳时反复「触发 → 恢复 → 触发」
- **`labels`**：附加到告警上的标签，用于 Alertmanager 路由和抑制，`severity`、`team` 是最常用的两个
- **`annotations`**：给人看的信息，`summary`、`description`、`runbook_url` 是约定俗成的键，可以用 `{{ $labels.xxx }}` 和 `{{ $value }}` 模板

Prometheus 侧的接入配置：

```yaml
# prometheus.yml
global:
  evaluation_interval: 1m
rule_files:
  - /etc/prometheus/rules/*.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager-0:9093', 'alertmanager-1:9093', 'alertmanager-2:9093']
```

注意 `targets` 要列出**全部** Alertmanager 实例，不要在前面挂负载均衡，原因见第四节的高可用。

### 2、order-service 的规则文件

下面的规则依赖 [Actuator 监控](/spring-boot/7_actuator) 中的配置：指标带公共标签 `application`，并开启了 `http.server.requests` 的直方图桶（否则没有 `_bucket` 序列，P99 无法计算）。抓取任务名为 `order-service`。

```yaml
# /etc/prometheus/rules/order-service-alerts.yml
groups:
  - name: order-service-availability
    rules:
      # 单个实例抓取失败：其余副本仍在服务，进群即可
      - alert: OrderServiceInstanceDown
        expr: up{job="order-service"} == 0
        for: 2m
        labels:
          severity: warning
          team: order
          application: order-service
        annotations:
          summary: "order-service 实例 {{ $labels.instance }} 抓取失败"
          description: "实例已连续 2 分钟无法抓取 /actuator/prometheus，检查进程、探针与网络策略。"
          runbook_url: "https://wiki.example.com/runbook/order-service#instance-down"

      # 全部实例不可用，或抓取目标从服务发现中消失
      - alert: OrderServiceAllDown
        expr: sum(up{job="order-service"}) == 0 or absent(up{job="order-service"})
        for: 1m
        labels:
          severity: critical
          team: order
          application: order-service
        annotations:
          summary: "order-service 没有任何可用实例"
          runbook_url: "https://wiki.example.com/runbook/order-service#all-down"

      # 5xx 比例超过 5%，且每秒请求数大于 1，避免低流量时一两个错误就触发
      - alert: OrderServiceHighErrorRate
        expr: |
          (
            sum by (application) (rate(http_server_requests_seconds_count{application="order-service", status=~"5.."}[5m]))
            /
            sum by (application) (rate(http_server_requests_seconds_count{application="order-service"}[5m]))
          ) > 0.05
          and
          sum by (application) (rate(http_server_requests_seconds_count{application="order-service"}[5m])) > 1
        for: 5m
        labels:
          severity: critical
          team: order
        annotations:
          summary: "order-service 5xx 比例 {{ $value | humanizePercentage }}"
          runbook_url: "https://wiki.example.com/runbook/order-service#high-error-rate"

      # P99 延迟超过 1 秒，排除 Actuator 端点
      - alert: OrderServiceHighLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum by (application, le) (
              rate(http_server_requests_seconds_bucket{application="order-service", uri!~"/actuator.*"}[5m])
            )
          ) > 1
        for: 10m
        labels:
          severity: warning
          team: order
        annotations:
          summary: "order-service P99 延迟 {{ $value | humanizeDuration }}"
          runbook_url: "https://wiki.example.com/runbook/order-service#high-latency"

  - name: order-service-saturation
    rules:
      # 老年代 GC 后存活数据接近上限：内存泄漏或堆偏小的信号
      - alert: OrderServiceOldGenNearlyFull
        expr: |
          jvm_gc_live_data_size_bytes{application="order-service"}
          /
          jvm_gc_max_data_size_bytes{application="order-service"} > 0.85
        for: 15m
        labels:
          severity: warning
          team: order
        annotations:
          summary: "{{ $labels.instance }} 老年代 GC 后占用 {{ $value | humanizePercentage }}"
          runbook_url: "https://wiki.example.com/runbook/order-service#old-gen"

      # Hikari 连接池有线程持续排队等连接
      - alert: OrderServiceDbPoolPending
        expr: max by (application, instance, pool) (hikaricp_connections_pending{application="order-service"}) > 5
        for: 5m
        labels:
          severity: warning
          team: order
        annotations:
          summary: "{{ $labels.instance }} 连接池 {{ $labels.pool }} 等待线程 {{ $value }}"
          runbook_url: "https://wiki.example.com/runbook/order-service#db-pool"

      # Kafka 消费积压超过 1 万条且仍在增长（指标来自 kafka_exporter）
      - alert: OrderConsumerLagGrowing
        expr: |
          sum by (consumergroup, topic) (kafka_consumergroup_lag{consumergroup="order-service"}) > 10000
          and
          sum by (consumergroup, topic) (delta(kafka_consumergroup_lag{consumergroup="order-service"}[10m])) > 0
        for: 10m
        labels:
          severity: warning
          team: order
          application: order-service
        annotations:
          summary: "{{ $labels.topic }} 消费积压 {{ $value }} 条且持续增长"
          runbook_url: "https://wiki.example.com/runbook/order-service#consumer-lag"

  - name: order-service-probe
    rules:
      # 黑盒拨测：从集群外访问下单健康接口失败
      - alert: OrderApiProbeFailed
        expr: probe_success{job="blackbox-order-api"} == 0
        for: 2m
        labels:
          severity: critical
          team: order
          application: order-service
        annotations:
          summary: "拨测 {{ $labels.instance }} 失败"
          runbook_url: "https://wiki.example.com/runbook/order-service#probe-failed"

  - name: meta
    rules:
      # 告警链路心跳：永远触发，由外部心跳服务检测「长时间没收到」
      - alert: Watchdog
        expr: vector(1)
        labels:
          severity: none
        annotations:
          summary: "告警链路心跳，始终处于 firing 状态"
```

几个写法上的要点：

- **`and` 保留左侧的值**：错误率规则里 `$value` 是比例而不是 QPS，所以注解里能用 `humanizePercentage`
- **`by` 子句两侧要一致**：`and` 按标签集合做匹配，左右两边都 `sum by (application)` 才能对上
- **用 `absent()` 兜底**：目标从服务发现中消失时 `up` 序列根本不存在，`up == 0` 永远不会触发
- **规则标签补齐 `application`**：`up` 和 `kafka_consumergroup_lag` 本身没有 `application` 标签，在规则里补上，Alertmanager 才能按它统一分组和抑制
- **阈值来自 SLO 和压测，而不是拍脑袋**：P99 的 1 秒、错误率的 5% 应与 [可用性度量](/high-avail/1_sla_slo) 中的 SLO 对齐

告警表达式中重复出现的计算（如各服务的错误率）应提取为 recording rule 预先计算，1_sla_slo 中的燃烧速率规则就是这种写法；PromQL 本身见 [指标监控](./2_metrics)。

### 3、用 promtool 测试规则

规则也是代码，应该在 CI 中校验语法并做单元测试。先检查语法：

```bash
promtool check rules /etc/prometheus/rules/order-service-alerts.yml
```

再为关键规则写测试，用合成的时间序列验证「何时 pending、何时 firing、注解渲染成什么样」：

```yaml
# order-service-alerts.test.yml
rule_files:
  - order-service-alerts.yml
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      # 前 2 分钟正常，之后持续抓取失败
      - series: 'up{job="order-service", instance="order-1:8081"}'
        values: '1 1 0x10'
    alert_rule_test:
      - eval_time: 3m
        alertname: OrderServiceInstanceDown
        exp_alerts: []          # 只失败了 1 分钟，仍在 pending
      - eval_time: 5m
        alertname: OrderServiceInstanceDown
        exp_alerts:
          - exp_labels:
              severity: warning
              team: order
              application: order-service
              job: order-service
              instance: order-1:8081
            exp_annotations:
              summary: "order-service 实例 order-1:8081 抓取失败"
              description: "实例已连续 2 分钟无法抓取 /actuator/prometheus，检查进程、探针与网络策略。"
              runbook_url: "https://wiki.example.com/runbook/order-service#instance-down"
```

```bash
promtool test rules order-service-alerts.test.yml
```

测试只比对 firing 的告警，pending 状态视为「没有告警」。Spring Boot 或 Micrometer 升级时指标名、标签可能变化，这类测试配合 `absent()` 守卫能尽早发现「规则还在、但再也匹配不到数据」的问题。

### 4、在 Kubernetes 中管理规则

用 kube-prometheus-stack（安装见 [Helm](/cloud-native/8_helm)）时，规则以 `PrometheusRule` 资源随应用一起交付，Prometheus Operator 自动加载：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: order-service-alerts
  namespace: order
  labels:
    release: monitoring        # 需匹配 Prometheus 的 ruleSelector，默认是 Helm release 名
spec:
  groups:
    - name: order-service-availability
      rules:
        - alert: OrderServiceInstanceDown
          expr: up{job="order-service"} == 0
          for: 2m
          labels:
            severity: warning
            team: order
            application: order-service
          annotations:
            summary: "order-service 实例 {{ $labels.instance }} 抓取失败"
            runbook_url: "https://wiki.example.com/runbook/order-service#instance-down"
```

规则写好却不生效，最常见的原因就是标签和 `ruleSelector` 对不上。规则文件和应用代码放在同一仓库，由 [CI/CD](/devops/2_ci_cd) 运行 promtool 校验后再通过 GitOps 同步。

---

## 三、Alertmanager 路由与通知

### 1、整体流程

![告警路由流程](../assets/observability/alerting-routing.svg)

Prometheus 只负责「判断是否触发」，并在告警 firing 期间持续把它重复推送给 Alertmanager。Alertmanager 负责后面所有事情：把同类告警合并成一条通知（分组）、在根因告警存在时压制症状告警（抑制）、在变更窗口内临时屏蔽（静默）、按标签决定发给谁（路由），并在告警恢复时发送恢复通知。

### 2、路由树

```yaml
# alertmanager.yml
global:
  smtp_smarthost: smtp.example.com:587
  smtp_from: alertmanager@example.com
  smtp_auth_username: alertmanager@example.com
  smtp_auth_password_file: /etc/alertmanager/secrets/smtp_password
  smtp_require_tls: true

route:
  receiver: default-email                 # 根路由：兜底接收者，所有告警都从这里进入
  group_by: [alertname, application]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers:
        - alertname="Watchdog"
      receiver: deadmans-switch
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 1m
    - matchers:
        - severity="critical"
      receiver: oncall-critical
      group_wait: 10s
      repeat_interval: 1h
    - matchers:
        - team="order"
        - severity="warning"
      receiver: order-team-dingtalk
    - matchers:
        - severity="info"
      receiver: default-email
      active_time_intervals: [workhours]  # 只在工作时间发送

time_intervals:
  - name: workhours
    time_intervals:
      - weekdays: ['monday:friday']
        times:
          - start_time: '09:00'
            end_time: '19:00'
        location: Asia/Shanghai

receivers:
  - name: default-email
    email_configs:
      - to: order-team@example.com
        send_resolved: true
  - name: oncall-critical
    webhook_configs:
      - url: http://alert-adapter.monitoring:8080/feishu/order-oncall   # 飞书值班群，见第五节
        max_alerts: 20
      - url: https://oncall.example.com/api/alertmanager                 # 值班平台负责电话 / 短信与升级
  - name: order-team-dingtalk
    webhook_configs:
      - url: http://prometheus-webhook-dingtalk.monitoring:8060/dingtalk/order-team/send
  - name: deadmans-switch
    webhook_configs:
      - url: https://heartbeat.example.com/ping/order-prod
        send_resolved: false
```

路由匹配规则：

- 告警从根路由进入，**按顺序**尝试子路由，命中第一个就停止；需要同时发给多个子路由时，在该子路由上写 `continue: true`
- 子路由未写的参数（`group_by`、各种 interval）继承父路由
- `matchers` 是一个列表，列表内各条件之间是「与」关系；支持 `=`、`!=`、`=~`、`!~`。旧的 `match` / `match_re` 已废弃
- `active_time_intervals` 表示只在时间段内发送，`mute_time_intervals` 表示时间段内不发送；时间段统一定义在顶层 `time_intervals`，默认时区是 UTC，必须显式写 `location`

改完路由后，用 amtool 验证某组标签会落到哪个接收者：

```bash
amtool check-config alertmanager.yml
amtool config routes test --config.file=alertmanager.yml severity=critical team=order
amtool config routes show --config.file=alertmanager.yml
```

### 3、分组与三个时间参数

`group_by` 中标签值相同的告警归为一组，一组只发一条通知。滚动发布导致 10 个实例同时抓取失败时，值班人收到的是一条「OrderServiceInstanceDown，10 个实例」，而不是 10 条消息。

| 参数 | 默认值 | 作用 |
|------|-------|------|
| `group_wait` | 30s | 新分组出现后，等待这么久再发第一条通知，让同一批告警凑齐 |
| `group_interval` | 5m | 分组内有新告警加入或有告警恢复时，距离上一条通知至少间隔这么久再发 |
| `repeat_interval` | 4h | 分组内容没变化时，多久重复提醒一次 |

- `group_by` 太粗（如只按 `alertname`）会把不同服务的告警混在一起；太细（如包含 `instance`）则失去聚合效果。特殊值 `group_by: ['...']` 表示按全部标签分组，等于关闭分组
- critical 路由把 `group_wait` 调小、`repeat_interval` 调到 1h；warning 和 info 保持默认或更长，避免同一件事反复刷屏

---

## 四、抑制、静默与高可用

### 1、抑制：根因出现时压制症状

```yaml
# alertmanager.yml（续）
inhibit_rules:
  # 同一告警同时存在 critical 和 warning 时，只发 critical
  - source_matchers:
      - severity="critical"
    target_matchers:
      - severity="warning"
    equal: [alertname, application]
  # 服务整体不可用时，不再单独发该服务的延迟、连接池等告警
  - source_matchers:
      - alertname="OrderServiceAllDown"
    target_matchers:
      - severity=~"warning|info"
    equal: [application]
```

含义是：当存在匹配 `source_matchers` 的 firing 告警时，匹配 `target_matchers` 且 `equal` 中所有标签值都相同的告警不再发送。两个注意点：

- **`equal` 中的标签两边都缺失也算「相等」**。如果规则漏写了 `application` 标签，一条 critical 告警可能压掉其他服务的 warning。这也是第二节要在规则里补齐标签的原因
- 抑制规则要保守，宁可多收一条也不要误压。典型用法只有两类：高等级压低等级、上游根因压下游症状（如节点宕机压制该节点上所有 Pod 告警）

### 2、静默：计划内的临时屏蔽

静默按匹配条件在一段时间内屏蔽告警，用于计划内变更、已知问题处理中等场景。可以在 Alertmanager UI 上创建，也可以用 amtool：

```bash
# 发布窗口内静默 order-service 的错误率告警 2 小时
amtool silence add alertname=OrderServiceHighErrorRate application=order-service \
  --duration=2h --comment="v2.3.1 发布窗口，变更单 CHG-1024" \
  --alertmanager.url=http://alertmanager:9093

amtool silence query --alertmanager.url=http://alertmanager:9093
amtool silence expire <silence-id> --alertmanager.url=http://alertmanager:9093
```

静默必须带**到期时间和说明**（谁、为什么、关联哪个变更或故障），并且范围越窄越好。长期静默往往意味着这条告警本身就不该存在，应该回头修改或删除规则，而不是一直静默。周期性的维护窗口用 `time_intervals` 配置，不要每次手工建静默。

### 3、高可用

Alertmanager 以集群方式运行，实例之间通过 gossip 协议（默认端口 9094）同步静默和「哪些通知已经发过」：

```bash
alertmanager --config.file=/etc/alertmanager/alertmanager.yml \
  --cluster.listen-address=0.0.0.0:9094 \
  --cluster.peer=alertmanager-1:9094 \
  --cluster.peer=alertmanager-2:9094
```

- Prometheus 要把告警**同时发给所有实例**（第二节 `alerting.alertmanagers` 中列全），由集群内部去重；挂负载均衡只发给其中一个，反而会在实例故障时丢告警
- 高可用的 Prometheus 双副本各自评估规则、各自推送，Alertmanager 按标签去重；两个副本 `external_labels` 中用于区分副本的标签（如 `replica`）要在 `alerting.alert_relabel_configs` 中用 `labeldrop` 去掉，否则会被当成两组告警
- 在 Kubernetes 中由 Prometheus Operator 的 `Alertmanager` 资源管理副本数和集群参数，路由可以拆到各团队命名空间的 `AlertmanagerConfig` 中

---

## 五、通知渠道接入

### 1、渠道与接入方式

| 渠道 | 接入方式 | 说明 |
|------|---------|------|
| 邮件 | 内置 `email_configs` | 适合 info 级与日报类通知；默认不发恢复通知，需要时显式写 `send_resolved: true` |
| 企业微信应用消息 | 内置 `wechat_configs` | 走企业微信应用接口，需要 `corp_id`、`api_secret`、`agent_id` |
| 企业微信群机器人 | 自建或社区 webhook 适配器 | 群机器人的 Webhook 不是 Alertmanager 的格式，需要转换 |
| 钉钉群机器人 | 社区适配器 prometheus-webhook-dingtalk | 默认监听 8060 端口，按 target 名区分机器人 |
| 飞书群机器人 | 自建或社区 webhook 适配器 | 支持签名校验，下面给出一个 Spring Boot 实现 |
| 值班平台 | 内置 `pagerduty_configs`、`opsgenie_configs` 等，或 webhook | 电话 / 短信、自动升级、排班交给专业平台 |

Alertmanager 的 `webhook_configs` 会以固定的 JSON 格式（`version: "4"`，包含 `status`、`commonLabels`、`commonAnnotations`、`alerts` 数组等字段）POST 到目标地址，各 IM 适配器的工作就是把它翻译成对应机器人的消息格式。

钉钉适配器的配置：

```yaml
# prometheus-webhook-dingtalk 的 config.yml
targets:
  order-team:
    url: https://oapi.dingtalk.com/robot/send?access_token=<access_token>
    secret: <signing_secret>      # 机器人开启「加签」时填写
```

Alertmanager 中对应的地址是 `http://<适配器地址>:8060/dingtalk/order-team/send`。`access_token` 与签名密钥用 Kubernetes Secret 挂载，不要提交到仓库。

### 2、自建飞书适配器

适配器逻辑很简单，自建的好处是消息格式、@ 人规则、多租户路由都可控。下面是一个基于 Spring Boot 4（依赖 `spring-boot-starter-webmvc`）的最小实现，Alertmanager 的 `oncall-critical` 接收者把告警发到 `/feishu/order-oncall`。

```java
package com.example.alertadapter;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

// Alertmanager webhook 请求体中用到的字段
@JsonIgnoreProperties(ignoreUnknown = true)
public record AlertmanagerPayload(
        String status,
        Map<String, String> commonLabels,
        List<Alert> alerts) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Alert(
            String status,
            Map<String, String> labels,
            Map<String, String> annotations,
            String startsAt) {
    }
}
```

```java
package com.example.alertadapter;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "alert-adapter.feishu")
public record FeishuProperties(Map<String, Target> targets) {

    public record Target(String webhookUrl, String secret) {
    }
}
```

```java
package com.example.alertadapter;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

@RestController
@RequestMapping("/feishu")
public class FeishuAlertController {

    private static final int MAX_ALERTS_IN_MESSAGE = 10;   // 飞书单条消息体不超过 20 KB

    private final FeishuProperties properties;
    private final RestClient restClient = RestClient.create();

    public FeishuAlertController(FeishuProperties properties) {
        this.properties = properties;
    }

    @PostMapping("/{target}")
    public ResponseEntity<Void> forward(@PathVariable String target,
                                        @RequestBody AlertmanagerPayload payload) {
        FeishuProperties.Target config = properties.targets().get(target);
        if (config == null) {
            return ResponseEntity.notFound().build();
        }
        long timestamp = Instant.now().getEpochSecond();       // 秒级时间戳
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("timestamp", String.valueOf(timestamp));
        body.put("sign", sign(timestamp, config.secret()));
        body.put("msg_type", "text");
        body.put("content", Map.of("text", render(payload)));

        Map<String, Object> response = restClient.post()
                .uri(config.webhookUrl())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(new ParameterizedTypeReference<>() {
                });
        // 飞书业务失败时 HTTP 仍是 200，靠 code 判断；返回 5xx 让 Alertmanager 重试
        Object code = response == null ? null : response.get("code");
        if (!(code instanceof Number number) || number.intValue() != 0) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
        return ResponseEntity.ok().build();
    }

    // 签名：以「timestamp + 换行 + secret」为密钥，对空字符串做 HmacSHA256，再 Base64
    static String sign(long timestamp, String secret) {
        try {
            String stringToSign = timestamp + "\n" + secret;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(stringToSign.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getEncoder().encodeToString(mac.doFinal(new byte[0]));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("飞书签名计算失败", e);
        }
    }

    private static String render(AlertmanagerPayload payload) {
        StringBuilder text = new StringBuilder()
                .append('[').append(payload.status().toUpperCase()).append("] ")
                .append(payload.commonLabels().getOrDefault("alertname", "unknown"))
                .append("，共 ").append(payload.alerts().size()).append(" 条\n");
        payload.alerts().stream().limit(MAX_ALERTS_IN_MESSAGE).forEach(alert -> text
                .append("- ").append(alert.labels().getOrDefault("severity", "-"))
                .append(" | ").append(alert.annotations().getOrDefault("summary", ""))
                .append(" | 开始于 ").append(alert.startsAt()).append('\n')
                .append("  Runbook：").append(alert.annotations().getOrDefault("runbook_url", "无"))
                .append('\n'));
        if (payload.alerts().size() > MAX_ALERTS_IN_MESSAGE) {
            text.append("其余 ").append(payload.alerts().size() - MAX_ALERTS_IN_MESSAGE)
                    .append(" 条请到 Alertmanager 查看");
        }
        return text.toString();
    }
}
```

启动类加 `@ConfigurationPropertiesScan` 让 `FeishuProperties` 生效，配置从环境变量注入：

```yaml
alert-adapter:
  feishu:
    targets:
      order-oncall:
        webhook-url: ${FEISHU_ORDER_ONCALL_URL}
        secret: ${FEISHU_ORDER_ONCALL_SECRET}
```

实现要点：

- **失败要返回 5xx**：Alertmanager 对网络错误和 5xx 会重试，对一般的 4xx 不重试。飞书业务失败（签名错误、限流）HTTP 状态仍是 200，必须解析 `code`
- **注意频率限制**：飞书自定义机器人每分钟 100 次、每秒 5 次，分组和 `max_alerts` 本身就是在控制消息量
- **Webhook 地址即凭证**：任何拿到地址的人都能往群里发消息，地址与签名密钥都放在 Secret 中
- 适配器本身也是告警链路的一环，要部署多副本，并对 `alertmanager_notifications_failed_total` 设置告警（见第七节）

---

## 六、降噪与值班

### 1、降噪手段

| 手段 | 解决的问题 | 做法 |
|------|-----------|------|
| `for` 持续时间 | 瞬时毛刺触发告警 | 症状类 2–10 分钟，资源类 10–15 分钟；必须短于「用户能容忍的发现时间」 |
| `keep_firing_for` | 指标在阈值附近抖动，反复触发和恢复 | 对容易抖动的规则设置 5–10 分钟 |
| 最小流量条件 | 低峰期少量请求失败导致比例飙高 | 错误率规则加 `and 请求速率 > N` |
| 分组 | 一次故障产生几十条消息 | `group_by` 按服务和告警名聚合 |
| 抑制 | 根因与症状同时告警 | 高等级压低等级、上游压下游 |
| 燃烧速率告警 | 固定阈值要么太敏感、要么太迟钝 | 按错误预算消耗速度告警，长短双窗口，见下文 |
| 分级通知 | 所有告警都打电话 | 只有 critical 呼叫，warning 进群，info 进邮件或工单 |

固定阈值告警（「错误率 > 5%」）的根本问题是没有考虑持续时间与影响面：1% 的错误率持续一整天，可能比 10% 持续一分钟更伤 SLO。成熟的做法是让 critical 告警以错误预算燃烧速率为准，长短双窗口同时满足才触发，具体公式、阈值表和 recording rule 写法见 [可用性度量](/high-avail/1_sla_slo) 第三节，这里不再重复。该页示例用的 `severity: page` 与本篇的 `critical` 是同一个含义，团队内统一一套取值即可。

### 2、度量告警质量

降噪需要数据支撑。Prometheus 会为每个 pending / firing 告警生成 `ALERTS` 序列，可以直接用来做告警质量看板：

```promql
# 过去 7 天各告警处于 firing 的评估次数排行（乘以评估间隔即为触发时长）
topk(10, sum by (alertname) (count_over_time(ALERTS{alertstate="firing"}[7d])))
```

定期（建议每周值班交接时）回顾以下指标，配合 [故障应急与复盘](/high-avail/11_incident_response) 第二节的值班负担统计：

- **每班告警数与夜间呼叫次数**：负担过重说明告警或系统稳定性需要治理
- **可行动率**：收到后确实采取了处理动作的告警占比，长期低于一半的规则应该修改或删除
- **漏报**：由用户反馈或客服先发现的故障，说明对应的症状告警缺失
- **MTTD**：从故障开始到告警触发的时间，衡量 `for` 和阈值是否合理

每条告警都应有负责人。新增告警需要说明对应的用户影响和 Runbook；连续一个季度没有触发、或触发后从不处理的告警，进入清理清单。

### 3、值班衔接

告警发出之后的事情（确认、定级、止血、升级、复盘）属于故障应急流程，见 [故障应急与复盘](/high-avail/11_incident_response)。告警侧要做的是让这个流程更顺：告警标题直接说明「哪个服务、什么症状、多严重」；注解带上 Runbook、Grafana 看板和最近变更的链接；critical 告警交给值班平台负责未确认自动升级，而不是靠 `repeat_interval` 在群里反复刷。

---

## 七、误报与漏报案例

### 1、误报

| 现象 | 原因 | 改进 |
|------|------|------|
| 凌晨错误率告警，实际只有 3 个请求失败了 2 个 | 低流量下比例失真 | 加最小流量条件，或改用燃烧速率告警 |
| 每次发布都收到 InstanceDown | 滚动重启期间实例短暂不可抓取 | `for` 大于单实例重启时间；实例级告警只发 warning，服务级用 `OrderServiceAllDown` |
| 告警「触发 → 恢复 → 触发」刷屏 | 指标在阈值附近抖动 | 设置 `keep_firing_for`，或拉开触发阈值 |
| 规则多出一份重复告警 | Prometheus 双副本推送时带了不同的 `replica` 外部标签 | 推送前去掉副本标签，让 Alertmanager 去重 |
| 一条 critical 压掉了别的服务的 warning | 抑制规则 `equal` 中的标签在两边都缺失，被视为相等 | 规则统一补齐 `application` 等标签 |

### 2、漏报

| 现象 | 原因 | 改进 |
|------|------|------|
| 服务被误删，没有任何告警 | 目标从服务发现中消失，`up` 序列不存在 | `absent()` 兜底，如 `OrderServiceAllDown` |
| 升级 Spring Boot 后延迟告警再也没响过 | 指标名或标签变化，规则匹配不到数据 | promtool 单元测试 + 升级检查清单；对关键指标加 `absent()` 守卫 |
| 网关挂了，应用错误率一切正常 | 请求根本没到达应用，应用侧指标没有分母 | 黑盒拨测 + 网关 / 入口层指标告警 |
| 故障期间群里一片安静 | Alertmanager 宕机、适配器 token 过期或被限流 | Watchdog 心跳发到外部服务，长时间收不到心跳即告警；对 `alertmanager_notifications_failed_total` 的增长告警 |
| 只告警 5xx，401 风暴没人知道 | 认证服务故障导致大量 4xx，被当成客户端错误 | 对关键接口的 4xx 比例突增单独告警，或以业务成功率作为 SLI |

告警链路自身的健康检查可以这样写：

```yaml
# 加入 meta 规则组：Alertmanager 通知发送失败
- alert: AlertmanagerNotificationsFailing
  expr: sum by (integration) (rate(alertmanager_notifications_failed_total[5m])) > 0
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "Alertmanager 通过 {{ $labels.integration }} 发送通知持续失败"
    runbook_url: "https://wiki.example.com/runbook/alerting#notifications-failing"
```

通知渠道本身坏了，这条告警可能也发不出去，所以 Watchdog 心跳要发到**独立于本链路**的外部服务，由它在收不到心跳时走另一条渠道（如短信）通知。

---

## 八、Grafana Alerting 与 Alertmanager

Grafana 自带告警功能（Grafana 11 起移除了旧版告警，只保留统一告警），其通知层本身基于 Alertmanager 实现，也可以把告警转发给外部 Alertmanager。

| 维度 | Prometheus 规则 + Alertmanager | Grafana Alerting |
|------|-------------------------------|-----------------|
| 规则数据源 | 只能用 PromQL（Loki Ruler 用 LogQL） | Grafana 支持的任意数据源，可跨源组合（如 Prometheus + MySQL） |
| 配置方式 | YAML 文件，进 Git，promtool 校验和单测 | 以 UI 为主，也支持文件 provisioning、API 与 Terraform |
| 通知渠道 | 内置邮件、企业微信应用、Slack 等，钉钉 / 飞书群需适配器 | 联系点内置钉钉、企业微信等更多渠道 |
| 规则评估位置 | Prometheus 本地评估，不依赖 Grafana 可用 | Grafana 服务端评估，Grafana 故障时告警也停止 |
| 适合场景 | 核心服务告警、规则即代码、平台团队统一治理 | 数据源分散、业务方自助配置、看板与告警一体 |

建议：核心服务的告警规则以 Prometheus 规则文件为准，进仓库、走评审和测试；Grafana Alerting 用于非 Prometheus 数据源（如业务库中的订单量）和业务方自助的告警。无论用哪种，路由、分级、抑制和 Runbook 的原则都相同，最好让两者共用同一个 Alertmanager 做通知，避免出现两套路由规则。

---

## 小结

- 告警只为驱动行动：对准用户可感知的症状，紧急度决定通知方式，每条带 Runbook
- Prometheus 规则用 `for` 过滤毛刺、`keep_firing_for` 防抖、`absent()` 防漏，标签决定路由，注解给人看；规则进仓库并用 promtool 校验与单测
- Alertmanager 依次做分组、抑制、静默、路由，`group_wait` / `group_interval` / `repeat_interval` 控制通知节奏；`matchers` 取代废弃的 `match`
- 钉钉、飞书、企业微信群机器人通过 webhook 适配器接入，适配器失败要返回 5xx 让 Alertmanager 重试
- critical 告警以 SLO 燃烧速率为准，用告警质量数据持续清理噪声；Watchdog 心跳保证告警链路本身可被监控
- 核心告警用 Prometheus + Alertmanager 管成代码，Grafana Alerting 补充其他数据源

## 参考资料

- 告警规则：[Prometheus Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- 规则单元测试：[Unit testing for rules](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)
- 模板函数（humanizePercentage 等）：[Template reference](https://prometheus.io/docs/prometheus/latest/configuration/template_reference/)
- 告警实践：[Prometheus Alerting best practices](https://prometheus.io/docs/practices/alerting/)
- Alertmanager 概念（分组、抑制、静默、高可用）：[Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/)
- Alertmanager 配置：[Alertmanager Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- Alertmanager 版本：[Alertmanager Releases](https://github.com/prometheus/alertmanager/releases)
- amtool：[Alertmanager README](https://github.com/prometheus/alertmanager#amtool)
- PrometheusRule 与 AlertmanagerConfig：[Prometheus Operator API reference](https://prometheus-operator.dev/docs/api-reference/api/)
- Loki 告警规则：[Loki Alerting and recording rules](https://grafana.com/docs/loki/latest/alert/)
- 钉钉适配器：[prometheus-webhook-dingtalk](https://github.com/timonwong/prometheus-webhook-dingtalk)
- 飞书自定义机器人（签名校验、频率限制）：[自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- Grafana 告警：[Grafana Alerting](https://grafana.com/docs/grafana/latest/alerting/)
- SRE 告警理念：[Google SRE Book - Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)

> 下一篇：[OpenTelemetry](./5_opentelemetry)

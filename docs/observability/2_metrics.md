---
description: 指标类型、RED / USE、自定义指标与基数控制、Prometheus 采集、PromQL、Grafana
---

# 指标监控

> 前置阅读：[日志体系](./1_logging)、[Actuator 监控](/spring-boot/7_actuator)

指标是按时间采样的数值，体积小、可聚合，回答整体现在怎么样、和平时比有无变化。本篇讲指标模型与类型、基数控制、抓取配置、PromQL 与看板，基线为 Prometheus 3.x。

---

## 一、指标模型

Prometheus 当前最新 3.15，长期支持线 3.13 LTS；应用侧用 Spring Boot 4.x 自带的 Micrometer，示例统一用 `order-service`，并给出指标清单。

Prometheus 的一切都是**时间序列**：指标名 + 一组标签（label）唯一确定一条序列，序列上是一串 `(时间戳, float64 值)` 样本。下面是 `order-service` 在 `/actuator/prometheus` 输出的一段文本格式：

```text
# HELP http_server_requests_seconds
# TYPE http_server_requests_seconds histogram
http_server_requests_seconds_bucket{application="order-service",method="POST",outcome="SUCCESS",status="200",uri="/orders",le="0.1"} 850
http_server_requests_seconds_bucket{application="order-service",method="POST",outcome="SUCCESS",status="200",uri="/orders",le="+Inf"} 1000
http_server_requests_seconds_count{application="order-service",method="POST",outcome="SUCCESS",status="200",uri="/orders"} 1000
http_server_requests_seconds_sum{application="order-service",method="POST",outcome="SUCCESS",status="200",uri="/orders"} 62.4
```

几个要点：

- **标签决定序列数**：上面 `method`、`status`、`uri`、`le` 每多一个取值，就多一批序列。序列数是 Prometheus 内存和查询开销的主要来源，第五节专门讲基数控制
- **目标标签由抓取端追加**：Prometheus 抓取时自动加上 `job`、`instance`，并为每个目标生成 `up` 序列（抓取成功为 1，失败为 0），这是"实例宕机"告警的基础
- **命名约定**：使用基本单位（秒、字节），单位作为后缀（`_seconds`、`_bytes`），计数器以 `_total` 结尾。Micrometer 里写点分小写名 `order.created`，导出时自动转成 `order_created_total`，Timer 自动带 `_seconds`，不要自己拼后缀
- **Prometheus 3 支持 UTF-8 指标名和标签名**：OpenTelemetry 风格的 `http.server.request.duration` 可以原样存储（查询时要写成 `{"http.server.request.duration"}`）。Micrometer 的 Prometheus 注册表仍输出下划线名，二者混用时注意同一指标不要出现两种写法

---

## 二、四种指标类型

### 1、Prometheus 类型与 Micrometer 对应

| Prometheus 类型 | 语义 | Micrometer 对应 | 典型指标 | 查询方式 |
|----------------|------|-----------------|----------|----------|
| Counter | 只增不减的累计值，进程重启归零 | `Counter`、`FunctionCounter` | 请求数、下单数、GC 次数 | 必须套 `rate()` / `increase()` |
| Gauge | 可增可减的瞬时值 | `Gauge`、`TimeGauge` | 队列长度、连接池活跃数、堆使用量 | 直接看，或 `avg_over_time()` |
| Histogram | 按预设桶累计计数，附带 `_sum`、`_count` | `Timer` / `DistributionSummary` 开启 `publishPercentileHistogram()` | 请求耗时、消息大小 | `histogram_quantile()` |
| Summary | 客户端直接算好分位数，附带 `_sum`、`_count` | `Timer` / `DistributionSummary` 默认形态，或配置 `publishPercentiles()` | 单实例的耗时分位数 | 直接读 `quantile` 标签，不能跨实例聚合 |

Micrometer 的 `Timer`（耗时）和 `DistributionSummary`（非时间的分布，如金额、字节数）是"分布类"指标的统一入口，导出成哪种 Prometheus 类型取决于配置：

- 什么都不配：导出为 `summary` 类型，只有 `_count`、`_sum`，外加一个 `_max` Gauge（近一段时间的最大值）
- `publishPercentileHistogram()` 或 `management.metrics.distribution.percentiles-histogram.<name>=true`：导出为 `histogram`，带一组 `le` 桶，**分位数交给 Prometheus 算**，生产推荐这种
- `publishPercentiles(0.95, 0.99)`：在应用内算好分位数，以 `quantile` 标签输出，只适合看单实例
- `serviceLevelObjectives(...)` 或 `management.metrics.distribution.slo.<name>`：额外生成与 SLO 阈值对齐的桶，例如 `le="0.3"`，延迟 SLI 直接用这个桶计算（见 [可用性度量](/high-avail/1_sla_slo) 第六节）

`Counter` 的值只能用 `rate()` / `increase()` 看变化：裸值在每次发布重启后归零，直接画图会是一条锯齿线，`rate()` 会自动识别并处理这种重置。

### 2、Histogram 与 Summary 怎么选

![经典直方图的累积桶与分位数插值](../assets/observability/metrics-histogram-buckets.svg)

Histogram 的桶是**累积**的：`le="0.25"` 表示耗时不超过 0.25 秒的请求数。`histogram_quantile()` 先算出目标排名落在哪个桶，再在桶内**线性插值**，所以结果的误差上限就是桶宽。

| 维度 | Histogram | Summary |
|------|-----------|---------|
| 分位数在哪算 | 服务端（PromQL 查询时） | 客户端（应用进程内） |
| 能否跨实例聚合 | 能，桶计数可以相加 | 不能，分位数相加或求平均没有意义 |
| 能否事后换分位数 | 能，P90 / P99 / P99.9 随便查 | 不能，只有配置时指定的那几个 |
| 精度 | 取决于桶边界，插值有误差 | 在配置的误差范围内较精确 |
| 序列数 | 每个标签组合 × 桶数 | 每个标签组合 × 分位数个数 |
| 适用 | 多实例服务的延迟、SLO 计算 | 单实例、桶边界难以预估的场景 |

结论：多副本部署的服务一律用 Histogram。Summary 最常见的误用是对多个实例的 `quantile="0.99"` 求平均当作整体 P99，这个数字既不是 P99 也不是任何有意义的统计量。

Micrometer 开启 `publishPercentileHistogram()` 后默认会生成几十个桶（按预设的指数分布覆盖 1ms 到 30s 左右），可以用 `minimumExpectedValue` / `maximumExpectedValue` 收窄范围，减少无用的桶。

### 3、原生直方图（Native Histogram）

经典直方图的痛点是桶边界要提前定、每个桶都是一条独立序列。原生直方图用**指数分布的稀疏桶**，一个样本里装下整个分布，精度更高、序列数更少：

- Prometheus **3.8 起原生直方图成为稳定特性**；3.9 起 `native-histograms` 特性开关变为空操作，需要在全局或抓取任务里显式设置 `scrape_native_histograms: true`，remote_write 转发则需 `send_native_histograms: true`。官方计划在 v4 把这两个设置的默认值改为 `true`
- 查询时没有 `le` 标签，聚合直接作用在直方图样本上：`histogram_quantile(0.99, sum by (uri) (rate(http_server_requests_seconds[5m])))`
- 应用侧需要客户端库输出原生直方图。截至撰写时，Spring Boot 默认的 Micrometer Prometheus 注册表输出的仍是经典直方图；如果改走 OTLP 推送（见第六节），可设置 `management.otlp.metrics.export.histogram-flavor: base2-exponential-bucket-histogram`，指数直方图进入 Prometheus 后即以原生直方图存储

存量看板和告警大量依赖 `_bucket{le=...}`，迁移时两套查询要并行一段时间，不建议一次性切换。

---

## 三、该看哪些指标：RED、USE 与四个黄金信号

三套方法论是指标清单的骨架，区别在于观察对象：

| 方法 | 观察对象 | 指标 | 在 Spring Boot 中的来源 |
|------|----------|------|------------------------|
| RED | 服务 / 接口 | Rate（请求速率）、Errors（错误）、Duration（耗时分布） | `http_server_requests_seconds_*`、`http_client_requests_seconds_*` |
| USE | 资源（CPU、内存、线程池、连接池） | Utilization（利用率）、Saturation（饱和度 / 排队）、Errors（错误） | `process_cpu_usage`、`executor_*`、`hikaricp_*`、node_exporter |
| 四个黄金信号 | 面向用户的系统 | Latency（延迟）、Traffic（流量）、Errors（错误）、Saturation（饱和度） | RED 三项 + 最紧张资源的饱和度 |

四个黄金信号出自 Google SRE，可以看成 RED 加上一项饱和度。实际落地时：**每个服务一行 RED、每类关键资源一行 USE**，再加业务指标，就是一张合格看板的主体（第八节）。排查时先用 RED 找到出问题的接口，再用 USE 查它依赖的资源，具体流程见 [性能分析方法论](/high-perf/2_methodology)。

延迟一定看分位数（P95 / P99），平均值会被大量快请求掩盖长尾，原因见 [性能指标](/high-perf/1_metrics) 第二节。

---

## 四、分层指标清单

下面按层列出 Java 服务最常用的指标，名称为 Prometheus 中实际出现的名字：

| 层 | 采集方式 | 关键指标 | 关注点 |
|----|----------|----------|--------|
| 主机 / 节点 | node_exporter | `node_cpu_seconds_total`、`node_memory_MemAvailable_bytes`、`node_filesystem_avail_bytes`、`node_network_receive_bytes_total` | CPU 利用率、可用内存、磁盘剩余、网络吞吐 |
| 容器 | kubelet / cAdvisor | `container_cpu_cfs_throttled_periods_total`、`container_memory_working_set_bytes` | CPU 限流、接近内存 limit（OOMKilled 前兆） |
| JVM | Micrometer 自动绑定 | `jvm_memory_used_bytes{area="heap"}`、`jvm_gc_pause_seconds_*`、`jvm_threads_live_threads`、`process_cpu_usage` | 老年代占用趋势、GC 停顿时间占比、线程数 |
| Web 容器 | Micrometer | `http_server_requests_seconds_*`、`tomcat_threads_busy_threads` | RED；Tomcat 线程指标需 `server.tomcat.mbeanregistry.enabled=true` |
| 线程池 | Micrometer 绑定 `ThreadPoolTaskExecutor` | `executor_active_threads`、`executor_queued_tasks`、`executor_pool_size_threads` | 队列堆积即饱和 |
| 连接池 | HikariCP 自动绑定 | `hikaricp_connections_active`、`hikaricp_connections_pending`、`hikaricp_connections_acquire_seconds_*` | `pending > 0` 持续出现说明池不够或有慢 SQL |
| 数据库 | mysqld_exporter | `mysql_global_status_threads_running`、`mysql_global_status_slow_queries` | 并发执行线程、慢查询增速 |
| 缓存 | redis_exporter | `redis_connected_clients`、`redis_memory_used_bytes`、`redis_keyspace_hits_total` | 内存水位、命中率 |
| 消息队列 | kafka-exporter 等 | `kafka_consumergroup_lag` | 消费积压 |
| 业务 | 自定义 Micrometer 指标 | `order_created_total{result}`、`order_payment_duration_seconds_*` | 下单量、支付成功率、与上周同期对比 |

业务指标最容易被忽略，却最能直接反映故障：接口全部 200、延迟正常，但下单量掉了一半，只有业务指标能发现。线程池采集的注意事项见 [线程池实战](/java/28_topic_thread_pool)，JVM 指标的解读见 [JVM 总览](/jvm/0_overview)。

---

## 五、Java 自定义指标与基数控制

依赖、端点暴露，以及 `Counter` / `Gauge` / `Timer` 的基本写法和"同名同键、标签值有限"两条规则已在 [Actuator 监控](/spring-boot/7_actuator) 第六节给出，这里补充分布类指标、SLO 桶和基数防护。

### 1、Timer 与 DistributionSummary

支付环节同时关心耗时分布和金额分布：

```java
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.math.BigDecimal;
import java.time.Duration;
import org.springframework.stereotype.Service;

@Service
public class PaymentService {

    public record PayCommand(String orderNo, String channel, BigDecimal amount) {}

    public record PayResult(boolean success) {}

    public interface PaymentChannelClient {
        PayResult pay(PayCommand cmd);
    }

    private final MeterRegistry registry;
    private final PaymentChannelClient channelClient;
    private final DistributionSummary amountSummary;

    public PaymentService(MeterRegistry registry, PaymentChannelClient channelClient) {
        this.registry = registry;
        this.channelClient = channelClient;
        this.amountSummary = DistributionSummary.builder("order.payment.amount")
                .description("支付成功的订单金额")
                .baseUnit("yuan")                                  // 导出为 order_payment_amount_yuan
                .serviceLevelObjectives(50, 200, 1000, 5000)       // 按金额档位生成桶
                .register(registry);
    }

    public PayResult pay(PayCommand cmd) {
        Timer.Sample sample = Timer.start(registry);
        String result = "failure";
        try {
            PayResult payResult = channelClient.pay(cmd);
            if (payResult.success()) {
                result = "success";
                amountSummary.record(cmd.amount().doubleValue());
            }
            return payResult;
        } finally {
            // 结果标签在调用结束后才确定，所以用 Sample 延后选定 Timer
            sample.stop(Timer.builder("order.payment.duration")
                    .description("调用支付渠道耗时")
                    .tag("channel", cmd.channel())                 // alipay / wechat / unionpay
                    .tag("result", result)                         // success / failure
                    .publishPercentileHistogram()
                    .serviceLevelObjectives(Duration.ofMillis(300), Duration.ofSeconds(1))
                    .minimumExpectedValue(Duration.ofMillis(5))
                    .maximumExpectedValue(Duration.ofSeconds(10))
                    .register(registry));                          // 同名同标签返回已注册的 Timer
        }
    }
}
```

要点：

- `orderNo` 只用于日志和链路，**绝不能作为标签**；需要同时进指标和 Span 时，用 Observation API 的 `highCardinalityKeyValue` 区分（见 [Actuator 监控](/spring-boot/7_actuator) 第六节）
- `minimumExpectedValue` / `maximumExpectedValue` 把默认几十个桶收窄到 5ms～10s，`serviceLevelObjectives` 再补上 300ms 和 1s 两个对齐 SLO 的桶
- 通过注入的 `MeterRegistry` 注册，不要用静态的 `Metrics.globalRegistry`，后者不受 Spring 管理，指标不会出现在 `/actuator/prometheus`

### 2、基数：指标系统最常见的事故

一个指标的序列数 = 各标签取值数的乘积 × 桶数。`http_server_requests_seconds` 有 `method`、`uri`、`status`、`outcome`、`exception` 等标签，再乘以几十个桶，一个服务的这一个指标就可能有上万条序列。真正的事故来自**无界标签**：

| 错误做法 | 后果 | 正确做法 |
|----------|------|----------|
| 用户 ID、订单号、手机号作标签 | 序列数随用户量线性增长 | 只放进日志 / Span |
| 原始路径 `/orders/1024` 作 `uri` | 每个订单一条序列 | 用路由模板 `/orders/{id}`；`RestClient` 调用写成 `uri("/orders/{id}", id)` 而不是字符串拼接 |
| 异常 message、SQL 文本作标签 | 取值不可枚举 | 用异常类名或错误码 |
| 渠道、地区等"看似有限"的值直接透传外部输入 | 被恶意请求打出任意取值 | 先映射到白名单，未知值归为 `other` |

后果是 Prometheus 内存暴涨、查询超时，严重时 OOM 导致整个监控失明。应用侧和抓取侧各加一道防线：

```java
import io.micrometer.core.instrument.config.MeterFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class MetricsFilterConfig {

    // order.payment.* 的 channel 标签最多 20 个取值，超出后新组合的指标被丢弃
    @Bean
    MeterFilter limitPaymentChannelTag() {
        return MeterFilter.maximumAllowableTags("order.payment", "channel", 20, MeterFilter.deny());
    }

    // 不需要的指标直接不注册
    @Bean
    MeterFilter denyTomcatSessionMeters() {
        return MeterFilter.denyNameStartsWith("tomcat.sessions");
    }
}
```

Spring Boot 会把容器里的 `MeterFilter` Bean 自动应用到 `MeterRegistry`。HTTP 指标另有现成的上限 `management.metrics.web.server.max-uri-tags`（客户端为 `management.metrics.web.client.max-uri-tags`），默认 100，超出后新 `uri` 取值被拒绝。

抓取侧可用 `metric_relabel_configs` 丢弃指标、用 `sample_limit` 设置单个目标的样本上限（超限则本次抓取整体失败，`up` 变为 0，能及时暴露问题），示例见下一节。排查哪个指标序列最多，用 Prometheus UI 的 **Status → TSDB Status** 页面，它按指标名和标签列出序列数排行。

---

## 六、Prometheus 采集

### 1、拉模型

![Prometheus 拉模型](../assets/observability/metrics-pull-model.svg)

Prometheus 默认**主动拉取**（pull）：通过服务发现拿到目标列表，按 `scrape_interval` 定时请求每个目标的指标端点。相比由应用推送，拉模型的好处是：

- 目标是否存活一目了然（`up` 指标），推模式下"没数据"无法区分是没流量还是挂了
- 抓取频率由监控端统一控制，应用不会因为推送失败而堆积内存
- 本地调试直接 `curl` 指标端点就能看到全部数据

推模式只在两种情况下使用：**短生命周期的批任务**（跑完就退出，等不到下一次抓取）推到 Pushgateway，Spring Boot 对应依赖为 `io.prometheus:prometheus-metrics-exporter-pushgateway` 并设置 `management.prometheus.metrics.export.pushgateway.enabled=true`；以及统一走 OTLP 的场景（本节第 4 小节）。Pushgateway 不会自动过期旧数据，不要把常驻服务挂在上面。

### 2、抓取配置

Kubernetes 中不写静态地址，用 `kubernetes_sd_configs` 发现 Pod，再用 relabel 过滤和改写标签：

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: prod-sh             # 多个 Prometheus 汇总时区分来源

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: order-service
    metrics_path: /actuator/prometheus
    sample_limit: 20000          # 单个目标样本数上限，防基数爆炸
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [order]
    relabel_configs:
      # 只保留 app=order-service 的 Pod 上名为 management 的端口
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: order-service
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_name]
        regex: management
        action: keep
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
    metric_relabel_configs:
      # 抓取后、入库前丢弃不需要的指标
      - source_labels: [__name__]
        regex: jvm_buffer_.*
        action: drop
```

`relabel_configs` 作用在**目标**上（抓谁、目标带什么标签），`metric_relabel_configs` 作用在**抓到的样本**上（存什么），两者容易混淆。改完配置用 `promtool check config prometheus.yml` 校验。

抓取间隔一般 15～30 秒；后文 PromQL 的 `rate()` 窗口至少取抓取间隔的 4 倍，所以 15 秒抓取对应 `[1m]` 起步，告警常用 `[5m]`。

### 3、Prometheus Operator：ServiceMonitor

用 kube-prometheus-stack（Prometheus Operator）部署时，抓取目标通过 CRD 声明，不再手改 `prometheus.yml`。应用的 Service 先给管理端口起名：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: order
  labels:
    app: order-service
spec:
  selector:
    app: order-service
  ports:
    - name: http
      port: 8080
    - name: management         # ServiceMonitor 按端口名引用
      port: 8081
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: order-service
  namespace: order
  labels:
    release: kube-prometheus-stack   # 需匹配 Prometheus 资源的 serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: order-service
  endpoints:
    - port: management
      path: /actuator/prometheus
      interval: 15s
```

最常见的"抓不到"原因是 `metadata.labels` 与 Prometheus 资源的 `serviceMonitorSelector` 不匹配，或者 ServiceMonitor 所在命名空间不在 `serviceMonitorNamespaceSelector` 范围内。没有 Service 的工作负载（如 Flink 作业、DaemonSet 中的 agent）用 `PodMonitor`。独立管理端口的配置见 [Actuator 监控](/spring-boot/7_actuator) 第一节，部署清单见 [Kubernetes](/cloud-native/6_kubernetes)。

### 4、OTLP 推送到 Prometheus 3

Prometheus 3 可以直接接收 OTLP 指标，适合已经统一使用 OpenTelemetry 的团队，或者 Serverless、批任务等无法被抓取的场景：

- 启动参数加 `--web.enable-otlp-receiver`，接收地址为 `http://<prometheus>:9090/api/v1/otlp/v1/metrics`（OTLP/HTTP）
- OTLP 的资源属性默认不转为标签，`service.name`（与 `service.namespace`）映射为 `job`，`service.instance.id` 映射为 `instance`，其余资源属性放在 `target_info` 序列里；需要直接作为标签的用 `otlp.promote_resource_attributes` 提升
- 推送数据可能乱序到达，官方建议开启约 30 分钟的乱序窗口

```yaml
# prometheus.yml 中与 OTLP 相关的部分
otlp:
  promote_resource_attributes:
    - service.name
    - service.namespace
    - service.instance.id
    - deployment.environment.name
storage:
  tsdb:
    out_of_order_time_window: 30m
```

应用侧引入 `io.micrometer:micrometer-registry-otlp`，配置推送地址：

```yaml
management:
  otlp:
    metrics:
      export:
        url: http://prometheus.monitoring:9090/api/v1/otlp/v1/metrics
        step: 15s                 # 推送周期，默认 1m，太长会让 rate() 很粗糙
        base-time-unit: seconds   # 默认 milliseconds，统一为秒与 Prometheus 约定一致
```

Micrometer 默认使用累积（cumulative）时间性，与 Prometheus 的 Counter 语义一致。生产中更常见的做法是应用推给 OpenTelemetry Collector，由 Collector 统一处理后再写入 Prometheus，见 [OpenTelemetry](./5_opentelemetry)。

### 5、存储与高可用

Prometheus 单机、无副本，本地 TSDB 默认保留 15 天，定位是短期存储。高可用的常规做法是两份相同配置的 Prometheus 同时抓取，Alertmanager 负责告警去重；长期存储和多集群全局查询通过 `remote_write` 接 Thanos、VictoriaMetrics 或 Grafana Mimir。存储原理与方案对比见 [时序数据库](/database/4_nosql/1_time_series_db) 第四节，本篇不展开。

---

## 七、PromQL 必会

### 1、rate、irate 与 increase

| 函数 | 含义 | 适用 |
|------|------|------|
| `rate(v[5m])` | 窗口内的平均每秒增长率，自动处理计数器重置，并外推到窗口边界 | 看板、告警、recording rules，**默认用它** |
| `irate(v[5m])` | 只用窗口内最后两个样本计算的瞬时速率 | 想看尖刺的高精度图，不要用于告警 |
| `increase(v[1h])` | 窗口内的增长量，等于 `rate × 窗口秒数` | "过去 1 小时下了多少单"这类展示 |

两个细节：

- `increase()` 也做了外推，结果可能是 `99.7` 这样的小数，不是精确计数，需要精确值请查业务库
- Prometheus 3 起区间选择器改为**左开右闭**，恰好落在窗口左边界的样本不再计入。窗口只等于一个抓取间隔时（如 1 分钟抓取配 `[1m]`），窗口里可能只剩一个样本，`rate()` 直接返回空。窗口至少取抓取间隔的 4 倍；Grafana 中用 `$__rate_interval` 自动兼顾抓取间隔和图表步长

### 2、常用查询

以下都基于 Spring Boot 默认的 HTTP 指标，`application` 标签来自 `management.metrics.tags.application`：

```promql
# QPS：按接口
sum by (uri) (rate(http_server_requests_seconds_count{application="order-service"}[5m]))

# 错误率：5xx 请求占比
sum(rate(http_server_requests_seconds_count{application="order-service", status=~"5.."}[5m]))
  /
sum(rate(http_server_requests_seconds_count{application="order-service"}[5m]))

# P99 延迟：按接口，聚合时必须保留 le
histogram_quantile(0.99,
  sum by (le, uri) (rate(http_server_requests_seconds_bucket{application="order-service"}[5m])))

# 平均延迟：sum 的速率除以 count 的速率
sum(rate(http_server_requests_seconds_sum{application="order-service"}[5m]))
  /
sum(rate(http_server_requests_seconds_count{application="order-service"}[5m]))

# GC 停顿时间占比：每秒有多少秒在 STW
sum by (instance) (rate(jvm_gc_pause_seconds_sum{application="order-service"}[5m]))

# 连接池排队：任一连接池持续有等待线程
max by (instance, pool) (hikaricp_connections_pending{application="order-service"}) > 0

# 支付成功率：按渠道
sum by (channel) (rate(order_payment_duration_seconds_count{result="success"}[5m]))
  /
sum by (channel) (rate(order_payment_duration_seconds_count[5m]))

# 下单量同比上周
sum(increase(order_created_total{result="success"}[1h]))
  /
sum(increase(order_created_total{result="success"}[1h] offset 1w))
```

### 3、聚合的坑

- **先 rate 后 sum**：`sum(rate(x[5m]))` 正确，`rate(sum(x)[5m:])` 错误。先求和会把某个实例重启造成的计数器归零混进总和，`rate()` 无法识别为重置
- **histogram_quantile 必须保留 le**：`sum by (uri)` 丢掉了 `le`，函数拿不到桶边界，结果为空；正确写法是 `sum by (le, uri)`
- **比例要用速率之和相除**：整体错误率是"错误请求速率之和 / 总请求速率之和"，不能对每个实例的错误率求 `avg()`，后者让小流量实例和大流量实例权重相同
- **不能对分位数再聚合**：不要对各实例的 P99 求平均，也不要对 Summary 的 `quantile` 求平均；要聚合就回到桶上聚合
- **没有数据不等于 0**：某个接口没有 5xx 时，错误率分子查询为空，除法结果也为空，告警不会触发但看板显示"No data"。需要显示 0 时在分子后加 `or vector(0)`；检测"指标消失"用 `absent()`
- **标签不一致会匹配失败**：二元运算默认要求两侧标签完全一致，左右聚合维度不同时用 `on(...)` / `ignoring(...)` 指定匹配标签

---

## 八、Recording Rules 与 Grafana 看板

### 1、Recording Rules：预计算高频查询

看板每次刷新、告警每次评估都要对全部原始序列重新计算 `rate` 和 `histogram_quantile`。把常用表达式定期预计算成新序列，查询就只扫描少量结果序列：

```yaml
# /etc/prometheus/rules/order-service-http.yml
groups:
  - name: order-service-http
    interval: 30s
    rules:
      - record: application_uri:http_server_requests:rate5m
        expr: sum by (application, uri) (rate(http_server_requests_seconds_count[5m]))

      - record: application:http_server_requests_errors:ratio_rate5m
        expr: |
          sum by (application) (rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
          /
          sum by (application) (rate(http_server_requests_seconds_count[5m]))

      - record: application_uri_le:http_server_requests_seconds_bucket:rate5m
        expr: sum by (application, uri, le) (rate(http_server_requests_seconds_bucket[5m]))
```

使用预计算结果算 P99：

```promql
histogram_quantile(0.99,
  application_uri_le:http_server_requests_seconds_bucket:rate5m{application="order-service"})
```

- 命名遵循官方约定 `level:metric:operations`：冒号前是保留的聚合维度，中间是原指标名，后面是做过的运算
- 预计算桶速率时同样要保留 `le`，分位数在查询时再算，这样同一条规则能支撑 P90 / P99 / P99.9
- 规则文件用 `promtool check rules` 校验，在 CI 中执行；SLO 错误率和燃烧速率的规则写法见 [可用性度量](/high-avail/1_sla_slo) 第三节，告警规则见 [告警体系](./4_alerting)

### 2、Grafana 看板设计

一张服务看板按"从症状到原因"自上而下排布：

| 行 | 内容 | 面板 |
|----|------|------|
| 第一行：RED | QPS、错误率、P50 / P99 延迟 | Stat 显示当前值 + Time series 显示趋势 |
| 第二行：资源（USE） | CPU、堆内存、GC 停顿占比、线程池队列、Hikari 活跃 / 等待 | Time series，阈值线标出容量上限 |
| 第三行：依赖 | 下游 HTTP 客户端延迟、Redis / MySQL / Kafka 关键指标 | Time series |
| 第四行：业务 | 下单量、支付成功率、与上周同期对比 | Stat + Time series |

设计要点：

- **用变量做下钻**：定义 `application`、`instance`、`uri` 变量，例如 `label_values(http_server_requests_seconds_count, application)`，面板查询写成 `sum by (uri) (rate(http_server_requests_seconds_count{application="$application"}[$__rate_interval]))`，一张看板服务所有同类应用
- **看板即代码**：看板 JSON 纳入 Git，通过 Grafana provisioning 或 Terraform / Grafonnet 部署，避免在界面上手改后无人知晓；社区 JVM 看板可以作为起点，导入后核对指标名
- **从指标跳到链路**：开启 exemplars 后，延迟面板上的点会带一个 traceId，点击直接打开对应的 Trace。需要三处配合：应用引入 Micrometer Tracing（自动提供 `SpanContext`，默认只附带被采样的 trace，由 `management.tracing.exemplars.include` 控制）；Prometheus 以 `--enable-feature=exemplar-storage` 启动并使用 OpenMetrics 格式抓取；Grafana 数据源配置 exemplar 到 Tempo / Jaeger 的跳转。链路侧见 [链路追踪](./3_tracing)
- **少而精**：一张看板控制在 20 个面板以内，每个面板回答一个明确的问题；没人看的面板删掉，它们只会拖慢加载

---

## 小结

- 时间序列 = 指标名 + 标签，标签取值数的乘积就是序列数；Counter 必须套 `rate()` / `increase()`，延迟用 Histogram 在服务端算分位数，多实例场景不要用 Summary
- Micrometer 的 `Timer` / `DistributionSummary` 开启 `publishPercentileHistogram()` 导出为 Histogram，用 `serviceLevelObjectives` 补上与 SLO 对齐的桶；Prometheus 3.8 起原生直方图稳定，3.9 起需显式开启 `scrape_native_histograms`
- 指标清单按 RED（服务）+ USE（资源）+ 业务指标组织，延迟看 P99 而不是平均值
- 用户 ID、订单号、原始路径不能作标签；应用侧用 `MeterFilter` 和 `max-uri-tags` 限制，抓取侧用 `sample_limit` 和 `metric_relabel_configs` 兜底
- Kubernetes 中用 ServiceMonitor 声明抓取目标；批任务用 Pushgateway，统一 OpenTelemetry 的场景可用 `--web.enable-otlp-receiver` 直接推 OTLP
- PromQL 记住四条：先 rate 后 sum、`histogram_quantile` 保留 `le`、比例用速率之和相除、窗口至少 4 倍抓取间隔；高频查询沉淀为 recording rules，看板按 RED → 资源 → 依赖 → 业务排布并纳入版本管理

相关内容：应用侧依赖、端点暴露与 `MeterRegistry` 基础用法见 [Actuator 监控](/spring-boot/7_actuator) 第六节；平均值与分位数、Little 定律见 [性能指标](/high-perf/1_metrics)；USE / RED 的排查用法见 [性能分析方法论](/high-perf/2_methodology)；Prometheus 本地 TSDB 与长期存储见 [时序数据库](/database/4_nosql/1_time_series_db) 第四节；SLO 与燃烧速率告警见 [可用性度量](/high-avail/1_sla_slo)；告警规则与 Alertmanager 见 [告警体系](./4_alerting)。

## 参考资料

- Prometheus 数据模型与指标类型：[Data Model](https://prometheus.io/docs/concepts/data_model/)、[Metric Types](https://prometheus.io/docs/concepts/metric_types/)
- 指标命名约定：[Metric and Label Naming](https://prometheus.io/docs/practices/naming/)
- Histogram 与 Summary 对比：[Histograms and Summaries](https://prometheus.io/docs/practices/histograms/)
- 原生直方图规范：[Native Histograms](https://prometheus.io/docs/specs/native_histograms/)
- 抓取配置：[Prometheus Configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
- 特性开关：[Feature Flags](https://prometheus.io/docs/prometheus/latest/feature_flags/)
- OTLP 接收：[Using Prometheus as Your OpenTelemetry Backend](https://prometheus.io/docs/guides/opentelemetry/)
- PromQL 函数：[Query Functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)
- Recording Rules：[Recording Rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/)、[Rules Best Practices](https://prometheus.io/docs/practices/rules/)
- Prometheus 版本发布：[Prometheus Releases](https://github.com/prometheus/prometheus/releases)
- Prometheus Operator：[ServiceMonitor API](https://prometheus-operator.dev/docs/api-reference/api/#monitoring.coreos.com/v1.ServiceMonitor)
- Spring Boot 指标：[Spring Boot - Metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
- Micrometer 概念：[Micrometer Concepts](https://docs.micrometer.io/micrometer/reference/concepts.html)
- 四个黄金信号：[Google SRE Book - Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- Grafana 看板最佳实践：[Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)

> 下一篇：[链路追踪](./3_tracing)

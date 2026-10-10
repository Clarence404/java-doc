---
description: 测试类型、开放与闭合模型、协调遗漏、k6 场景与阈值、Gatling、JMeter、CI 门禁、瓶颈分析
---

# 性能测试

> **本篇目标**：分清冒烟、负载、压力、浸泡、尖峰、断点六类测试各自回答什么问题；理解开放模型与闭合模型的差别，以及闭合模型为什么会因「协调遗漏」把长尾测得偏乐观；以 order-service 为例，用 k6 写出带场景、预热和阈值的压测脚本，再给出 Gatling Java DSL 与 JMeter 命令行的等价写法；最后把压测接进 CI，并知道结果出来后去哪里找瓶颈。
>
> **前置阅读**：[性能指标](/high-perf/1_metrics)、[性能分析方法论](/high-perf/2_methodology)、[集成测试](./3_integration_test)

本篇讲接口级、服务级的压测怎么设计、怎么执行、怎么判定通过。相关主题由其他文章负责：方法级的微基准用 JMH，见 [基准测试（JMH）](/high-perf/4_benchmark)；压测结果怎么换算成机器数、全链路压测与影子库怎么做，见 [容量评估与规划](/high-con/8_capacity_planning)；定位瓶颈的方法与工具见 [性能分析方法论](/high-perf/2_methodology) 和 [性能分析工具](/high-perf/3_profilers)。

工具版本以 2026 年 10 月为准：k6 2.3（2.0 于 2026 年 5 月发布；1.0 于 2025 年 5 月发布，起原生支持 TypeScript 脚本），Gatling 3.16（Maven 插件 4.21），JMeter 5.6.3。示例统一压测 order-service 的两个接口：`POST /api/orders` 下单（成功返回 201 和订单 JSON），`GET /api/orders/{id}` 查单（成功返回 200）。

---

## 一、六类性能测试

「性能测试」是一组测试的统称。它们用的工具相同，区别在于负载形态和要回答的问题：

| 类型 | 回答的问题 | 负载形态 | 典型时长 | 通过标准 |
|------|-----------|---------|---------|---------|
| 冒烟（Smoke） | 脚本、环境、数据是否可用 | 1–5 个 VU，极低负载 | 1–3 分钟 | 功能检查全部通过，无报错 |
| 负载（Load） | 预期峰值下是否满足 SLO | 爬坡到预期峰值后保持 | 10–60 分钟 | P95 / P99、错误率达到阈值 |
| 压力（Stress） | 超过峰值时如何退化、能否恢复 | 阶梯加压到峰值的 1.5–2 倍以上 | 30–60 分钟 | 退化可控（限流、降级生效），撤压后能恢复 |
| 浸泡（Soak） | 长时间运行是否泄漏、衰减 | 峰值的 60%–80% 持续运行 | 4–24 小时 | 延迟、内存、连接数不随时间爬升 |
| 尖峰（Spike） | 瞬间流量能否扛住或被限流挡住 | 数秒内拉到数倍峰值，再回落 | 5–15 分钟 | 不雪崩，弹性扩容或限流按预期动作 |
| 断点（Breakpoint） | 系统的上限在哪里 | 持续线性加压直到出错 | 直到阈值失败 | 记录出错时的负载与瓶颈资源 |

![六类性能测试的负载形态](../assets/testing/perf-test-load-profiles.svg)

几点说明：

- **先冒烟再加压**。冒烟测试的作用是把脚本错误、测试数据缺失、环境配置问题挡在大规模压测之前，否则跑半小时才发现全是 400，白白占用环境。
- **「基线」是结果，不是测试类型**。同一套负载测试在固定环境下跑出的 P95 / P99、吞吐和资源使用率，存档后就是基线，后续版本拿来对比（见第七节）。
- **压力测试的重点在退化方式**，不只是找崩溃点。线上更关心的是超载时限流有没有生效、线程池有没有被拖死、撤压后能否自己恢复，这些与 [限流](/high-avail/7_rate_limiting)、[熔断](/high-avail/5_circuit_breaking)、[降级](/high-avail/6_degradation) 的配置直接相关。
- **断点测试的结果用于容量规划**，但容量点不是崩溃点，而是「P99 达标且 CPU ≤ 70%」时的负载，换算方法见 [容量评估与规划](/high-con/8_capacity_planning) 第二节。

---

## 二、工作负载模型：开放与闭合

选对负载模型比选工具更重要。压测工具按两种方式产生请求：

| 模型 | 控制的量 | 下一个请求何时发出 | 系统变慢时 |
|------|---------|------------------|-----------|
| 闭合模型（Closed） | 并发用户数（VU 数） | 当前 VU 收到响应（加上思考时间）之后 | 发送变慢，到达率被动下降 |
| 开放模型（Open） | 到达速率（每秒多少个请求 / 迭代） | 按时间表发出，与上一个请求是否返回无关 | 在途请求增加，排队如实体现在延迟里 |

![闭合模型与开放模型](../assets/testing/perf-test-workload-model.svg)

### 1、协调遗漏

闭合模型有一个隐蔽的问题：**系统卡顿时，压测工具自己也跟着停了**，本该在卡顿期间到达的请求根本没有发出，自然也不会被记录成慢请求。这就是协调遗漏（Coordinated Omission），概念最早在 [性能指标](/high-perf/1_metrics) 第二节提到过，这里用数字看它的影响：

- 10 个 VU、无思考时间，正常 RT 为 10ms，吞吐约 1000 次/秒
- 服务因 Full GC 停顿 2 秒：闭合模型下这 2 秒里只有 10 个请求在等，记录下 10 个 2 秒的样本
- 真实流量下，这 2 秒内本应到达约 2000 个请求，它们都会排队，延迟在 0–2 秒之间
- 闭合模型在 10 万个样本里只多了 10 个慢样本，P99 几乎不变；开放模型会记录下约 2000 个慢样本，P99 明显变差

结论：**面向大量独立用户的在线接口，用开放模型压测**，它模拟的是「用户不会因为你慢就少来」。闭合模型适合本身就是固定并发的场景，比如固定大小线程池的批处理客户端、连接数固定的内部调用方。

### 2、各工具的对应写法

| 工具 | 闭合模型 | 开放模型 |
|------|---------|---------|
| k6 | `constant-vus`、`ramping-vus`（顶层 `stages` 选项就是 `ramping-vus`） | `constant-arrival-rate`、`ramping-arrival-rate` |
| Gatling | `injectClosed(constantConcurrentUsers / rampConcurrentUsers)` | `injectOpen(constantUsersPerSec / rampUsersPerSec)` |
| JMeter | Thread Group | Open Model Thread Group（实验性）；或 Thread Group 配合 Precise Throughput Timer |
| wrk / wrk2 | wrk 是闭合模型，存在协调遗漏 | wrk2 用 `-R` 指定固定速率，并按计划发送时间修正延迟 |

### 3、开放模型的 VU 预算

k6 的到达率执行器仍然需要 VU 来执行迭代，只是 VU 数由速率倒推。按 Little 定律，所需 VU 数 ≈ 到达率 × 单次迭代耗时：每秒 200 次、每次 50ms，平均只占用 10 个 VU；但 RT 升到 1 秒时就需要 200 个。`preAllocatedVUs` 按正常 RT 估算并留余量，`maxVUs` 按「能容忍的最差 RT」估算。

VU 用完时，k6 不会排队等待，而是放弃这次迭代并计入 `dropped_iterations`。**出现 dropped_iterations 说明实际施加的负载低于计划值**，这一轮结果不能直接拿来判定容量，要么调大 `maxVUs`，要么检查压测机本身是否已成瓶颈。

---

## 三、指标与通过标准

### 1、看哪些指标

| 指标 | k6 内置指标 | 说明 |
|------|------------|------|
| 吞吐量 | `http_reqs`、`iterations` | 每秒完成的请求 / 迭代数；开放模型下应与计划速率一致 |
| 延迟分位数 | `http_req_duration` | 发送 + 等待 + 接收的时间，不含 DNS 与建连；看 P95 / P99，不看平均值 |
| 错误率 | `http_req_failed` | 默认把 200–399 之外的状态码和网络错误算作失败，可用 `http.setResponseCallback` 调整 |
| 功能检查通过率 | `checks` | `check()` 的通过比例，check 失败本身不影响退出码，要配阈值 |
| 负载是否打足 | `dropped_iterations`、`vus` | 见上一节 |
| 服务端资源 | 来自被测系统的监控 | CPU、GC、线程池、连接池、DB，按 USE 方法逐项看 |

分位数为什么不能看平均值、为什么不能对多台实例的 P99 求平均，见 [性能指标](/high-perf/1_metrics) 第二节。服务视角的 RED（Rate / Errors / Duration）与资源视角的 USE（Utilization / Saturation / Errors）见 [性能分析方法论](/high-perf/2_methodology)。

### 2、客户端与服务端两份数据

压测工具测到的是**客户端视角**的延迟，包含网络与排队；应用自身的 Micrometer 指标是**服务端视角**。两者都要看：客户端 P99 高而服务端 P99 正常，问题在网络、负载均衡、网关或压测机；两者一起升高，问题在服务内部或下游。

服务端 P99 需要应用开启直方图（`management.metrics.distribution.percentiles-histogram.http.server.requests: true`，接入方式见 [Actuator 监控](/spring-boot/7_actuator) 第六节），然后在 Prometheus 里按接口计算：

```promql
histogram_quantile(
  0.99,
  sum by (le) (
    rate(http_server_requests_seconds_bucket{application="order-service", uri="/api/orders", method="POST"}[1m])
  )
)
```

### 3、阈值从哪里来

通过标准不要拍脑袋定，从 SLO 推导：如果线上 SLO 是「下单接口 99% 的请求在 500ms 内完成」，压测阈值就是 `p(99)<500`，再留一些余量（压测环境往往比生产干净）。SLO 的制定方法见 [可用性度量](/high-avail/1_sla_slo)。一般至少设三类阈值：延迟分位数、错误率、功能检查通过率。

---

## 四、k6 实战：order-service 压测

k6 用 Go 实现，脚本用 JavaScript 或 TypeScript 编写，单机可以模拟大量 VU，资源占用低，阈值失败时以非零退出码结束，天然适合 CI。本篇以 k6 为主要示例。

### 1、测试数据

查单接口需要已存在的订单号，下单接口需要合法的商品号。压测前从压测库导出两份 JSON 数组放在脚本旁边：

```text
perf/
├── order-load.js
└── data/
    ├── product-ids.json    # [1001, 1002, ...]，约 1000 个上架商品
    └── order-ids.json      # [500001, 500002, ...]，约 1 万个历史订单，从压测库随机抽取
```

数据量要足够大、分布接近生产。只用一个商品号或一个订单号压测，会让缓存命中率接近 100%、数据库行锁集中在一行，测出的结果既不像生产，也找不到真实瓶颈。

### 2、脚本

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// SharedArray 只在 init 阶段加载一次，所有 VU 共享同一份只读数据
const productIds = new SharedArray('productIds', () => JSON.parse(open('./data/product-ids.json')));
const orderIds = new SharedArray('orderIds', () => JSON.parse(open('./data/order-ids.json')));

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const options = {
  scenarios: {
    // 冒烟：1 个 VU 跑通完整流程，PR 流水线使用
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      exec: 'smoke',
    },
    // 预热：JIT、连接池、缓存进入稳态，不参与按场景设置的阈值
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'createOrder',
    },
    // 查单：固定每秒 200 次，开放模型
    query_order: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '10m',
      startTime: '1m',
      preAllocatedVUs: 40,
      maxVUs: 200,
      exec: 'queryOrder',
    },
    // 下单：每秒 10 次起步，爬坡到每秒 50 次并保持
    create_order: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      startTime: '1m',
      preAllocatedVUs: 30,
      maxVUs: 300,
      stages: [
        { duration: '2m', target: 50 }, // 2 分钟内从 10/s 线性升到 50/s
        { duration: '6m', target: 50 }, // 目标不变，即保持 50/s 共 6 分钟
        { duration: '2m', target: 0 },  // 2 分钟内线性降到 0
      ],
      exec: 'createOrder',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{scenario:query_order}': ['p(95)<100', 'p(99)<200'],
    'http_req_duration{scenario:create_order}': [
      'p(95)<300',
      // 下单 P99 持续超标就提前终止，前 1 分钟不判定
      { threshold: 'p(99)<500', abortOnFail: true, delayAbortEval: '1m' },
    ],
    dropped_iterations: ['count<100'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function createOrder() {
  const body = JSON.stringify({
    userId: 1 + Math.floor(Math.random() * 100000),
    productId: pick(productIds),
    quantity: 1,
  });
  const res = http.post(`${BASE_URL}/api/orders`, body, {
    headers: JSON_HEADERS,
    tags: { name: 'POST /api/orders' },
  });
  check(res, {
    'create: status 201': (r) => r.status === 201,
    'create: has id': (r) => r.status === 201 && r.json('id') !== undefined,
  });
  return res;
}

export function queryOrder() {
  const res = http.get(`${BASE_URL}/api/orders/${pick(orderIds)}`, {
    tags: { name: 'GET /api/orders/{id}' },
  });
  check(res, { 'query: status 200': (r) => r.status === 200 });
}

export function smoke() {
  const created = createOrder();
  if (created.status === 201) {
    const res = http.get(`${BASE_URL}/api/orders/${created.json('id')}`, {
      tags: { name: 'GET /api/orders/{id}' },
    });
    check(res, { 'smoke: query created order': (r) => r.status === 200 });
  }
  sleep(1);
}
```

脚本里几个容易写错的地方：

- **`stages` 的每一段都是线性过渡**：从上一段的目标值，在 `duration` 内线性变化到本段 `target`。想要「保持」，就再写一段 `target` 相同的阶段，如上面第二段。顶层 `options.stages` 也是同样的语义。
- **错误率直接用内置的 `http_req_failed`**，不需要再自定义一个 `Rate` 指标统计非 200。201 在默认的 200–399 范围内，算作成功。
- **给请求打 `name` 标签**。k6 默认用完整 URL 作为 `name`，`/api/orders/500001`、`/api/orders/500002` 会变成成千上万个时间序列，汇总报告和后端存储都会被撑爆。
- **按场景设置阈值**：k6 会给每个样本自动打上 `scenario` 标签，`http_req_duration{scenario:create_order}` 只统计下单场景，预热阶段的慢请求不会拉低结果；`http_req_failed` 这类全局阈值仍包含预热。
- **所有场景都写了 `exec`，所以不需要 `export default`**。不带 `--scenario` 运行时所有场景会同时启动，包括 smoke，因此运行时要显式选择场景。

### 3、运行

```bash
# 冒烟：只运行 smoke 场景，绑定在其他场景上的阈值会被跳过
k6 run --scenario smoke -e BASE_URL=http://localhost:8080 perf/order-load.js

# 负载测试：预热 + 查单 + 下单
k6 run --scenario warmup,query_order,create_order \
  -e BASE_URL=http://order-service.perf.svc:8080 perf/order-load.js

# 用容器运行：挂载整个目录，脚本里 open() 读取的数据文件才能找到
docker run --rm -v "$PWD/perf:/perf" -w /perf grafana/k6:2.3.0 \
  run --scenario smoke -e BASE_URL=http://host.docker.internal:8080 order-load.js
```

结束时 k6 会打印汇总：每个阈值是否通过、各指标的 `summaryTrendStats` 统计值、各 check 的通过数。任何阈值失败，进程以非零退出码结束；`abortOnFail` 触发的提前终止同样如此。

### 4、实时观测与报告

压测期间要把 k6 的客户端指标和应用的服务端指标放在同一个 Grafana 里对照着看。k6 内置 Prometheus remote write 输出，Prometheus 需要以 `--web.enable-remote-write-receiver` 启动：

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://prometheus.monitoring:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),max' \
k6 run -o experimental-prometheus-rw \
  --scenario warmup,query_order,create_order \
  -e BASE_URL=http://order-service.perf.svc:8080 perf/order-load.js
```

写入的时间序列统一以 `k6_` 开头，趋势类指标按 `K6_PROMETHEUS_RW_TREND_STATS` 拆成多个序列，如 `k6_http_req_duration_p99`。Prometheus 的部署与长期存储见 [时序数据库](/database/4_nosql/1_time_series_db)。

不想搭监控时，用 k6 自带的 Web 看板，并在结束时导出一份 HTML 报告，方便归档和放进 CI 制品：

```bash
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=k6-report.html \
  k6 run --scenario warmup,query_order,create_order perf/order-load.js
```

---

## 五、Gatling：Java DSL

团队希望压测脚本和业务代码使用同一种语言、同一套构建工具时，Gatling 是更自然的选择：场景用 Java 编写，放在 `src/test/java` 下，由 Maven 插件运行。Gatling 的注入模型同样分开放（`injectOpen`）和闭合（`injectClosed`），同一个场景里不能混用两类注入步骤。

```xml
<dependencies>
  <dependency>
    <groupId>io.gatling.highcharts</groupId>
    <artifactId>gatling-charts-highcharts</artifactId>
    <version>3.16.0</version>
    <scope>test</scope>
  </dependency>
</dependencies>

<build>
  <plugins>
    <plugin>
      <groupId>io.gatling</groupId>
      <artifactId>gatling-maven-plugin</artifactId>
      <version>4.21.12</version>
    </plugin>
  </plugins>
</build>
```

与 k6 脚本对应的下单 + 查单场景：

```java
package com.example.order.perf;

import static io.gatling.javaapi.core.CoreDsl.*;
import static io.gatling.javaapi.http.HttpDsl.*;

import io.gatling.javaapi.core.ScenarioBuilder;
import io.gatling.javaapi.core.Simulation;
import io.gatling.javaapi.http.HttpProtocolBuilder;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.Stream;

public class OrderSimulation extends Simulation {

    private static final String BASE_URL = System.getProperty("baseUrl", "http://localhost:8080");

    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(BASE_URL)
            .acceptHeader("application/json")
            .contentTypeHeader("application/json");

    // 无限 Feeder：每个虚拟用户取一组随机的 userId / productId
    private final Iterator<Map<String, Object>> orderFeeder = Stream.generate(
                    () -> Map.<String, Object>of(
                            "userId", ThreadLocalRandom.current().nextLong(1, 100_001),
                            "productId", ThreadLocalRandom.current().nextLong(1001, 2001)))
            .iterator();

    private final ScenarioBuilder createAndQuery = scenario("create-and-query-order")
            .feed(orderFeeder)
            .exec(http("POST /api/orders")
                    .post("/api/orders")
                    .body(StringBody("{\"userId\":#{userId},\"productId\":#{productId},\"quantity\":1}"))
                    .check(status().is(201))
                    .check(jsonPath("$.id").saveAs("orderId")))
            .pause(1)
            .exec(http("GET /api/orders/{id}")
                    .get("/api/orders/#{orderId}")
                    .check(status().is(200)));

    {
        setUp(createAndQuery.injectOpen(
                        rampUsersPerSec(5).to(50).during(120), // 2 分钟内到达率从 5/s 升到 50/s
                        constantUsersPerSec(50).during(360)))  // 保持 50/s 共 6 分钟
                .protocols(httpProtocol)
                .assertions(
                        global().responseTime().percentile(99.0).lt(500),
                        global().failedRequests().percent().lt(1.0),
                        details("POST /api/orders").responseTime().percentile(95.0).lt(300));
    }
}
```

```bash
./mvnw gatling:test \
  -Dgatling.simulationClass=com.example.order.perf.OrderSimulation \
  -DbaseUrl=http://order-service.perf.svc:8080
```

要点：

- `injectOpen` 里的「用户」是按到达率注入的，每个用户走完场景就结束，对应 k6 的到达率执行器；`rampUsersPerSec(...).to(...)` 是到达率的线性爬坡。
- `#{userId}` 是 Gatling 表达式语言，引用 Feeder 或 `saveAs` 存入会话的值。
- 任意一条断言失败，本次模拟就判定为失败，可用作 CI 门禁。运行结束后在 `target/gatling/` 下生成 HTML 报告。
- 字段初始化先于实例初始化块执行，所以 `setUp` 写在初始化块里可以安全引用上面的字段。

---

## 六、JMeter 5.6：命令行模式

JMeter 的优势是协议覆盖广、有 GUI 方便录制和调试，很多测试团队已有大量 `.jmx` 资产。内置取样器覆盖 HTTP、JDBC、JMS、TCP、LDAP、FTP、SMTP 等；gRPC、Dubbo、Kafka 需要第三方插件。JMeter 5.6.x 支持 Java 8 及以上运行，官方推荐 Java 17 或更高版本。

### 1、线程组语义

| 配置 | 含义 |
|------|------|
| Number of Threads | 线程数，即闭合模型下的并发用户数 |
| Ramp-up period | 所有线程在多少秒内依次启动完毕 |
| Loop Count | 每个线程执行的循环次数 |
| Specify Thread lifetime → Duration | 线程运行时长 |

同时设置了循环次数和持续时间时，**先达到哪个条件就先停止**，并不是持续时间优先。按时长控制压测时，把 Loop Count 设为 Infinite。

需要按到达率压测时，用 Open Model Thread Group（官方标注为实验性），它用表达式描述到达率的变化：

```text
rate(0) random_arrivals(2 min) rate(50/sec) random_arrivals(6 min) rate(50/sec) random_arrivals(2 min) rate(0)
```

含义与 k6 示例的下单场景相同：2 分钟内从 0 线性升到每秒 50 次，保持 6 分钟，再用 2 分钟降到 0。

### 2、命令行执行

压测必须用非 GUI 模式，GUI 只用于编写和调试脚本。参数通过 `-J` 传入，`.jmx` 里用 `${__P(threads,50)}`、`${__P(duration,600)}`、`${__P(host,localhost)}` 读取，同一份脚本就能在不同环境和负载下复用：

```bash
# -n 非 GUI；-t 测试计划；-l 结果文件；-j 运行日志
# -e 结束后生成 HTML 报告；-o 报告目录（必须不存在或为空）；-f 先删除已有结果文件和报告目录
jmeter -n -t perf/order.jmx -l results.jtl -j jmeter.log \
  -e -o report -f \
  -Jthreads=100 -Jduration=600 -Jhost=order-service.perf.svc

# 只根据已有结果文件重新生成报告
jmeter -g results.jtl -o report-regenerated
```

### 3、断言与门禁

JMeter 的 Duration Assertion 是**逐个样本**判定的：单个响应超过设定的毫秒数就标记为失败，它不能表达「P99 < 500ms」。分位数只出现在事后生成的 HTML 报告里（报告目录中的 `statistics.json` 也有一份机器可读的汇总）。所以在 CI 里用 JMeter 做门禁，需要额外写一步解析结果并判定；如果门禁是主要诉求，直接用 k6 的阈值或 Gatling 的断言更省事。

### 4、工具怎么选

| 工具 | 脚本 | 负载模型 | 门禁 | 适合 |
|------|------|---------|------|------|
| k6 | JavaScript / TypeScript | 开放、闭合都内置 | 阈值失败即非零退出码 | 研发自测、CI 门禁、API 压测 |
| Gatling | Java / Kotlin / Scala DSL | 开放、闭合都内置 | 断言失败即模拟失败 | Java 团队，脚本与代码同仓同构建 |
| JMeter | GUI 编辑的 XML（.jmx） | 默认闭合，开放模型为实验性 | 需自行解析结果 | 多协议、已有 .jmx 资产、测试团队主导 |
| wrk2 | 命令行 + Lua | 固定速率 | 无 | 单接口快速摸底 |

---

## 七、环境、数据与执行规范

### 1、环境

- **规格与生产一致**：同样的实例规格、JVM 参数、副本数、连接池大小；下游依赖用真实服务，或用挡板按生产 RT 模拟。规格不一致时，结果只能做纵向对比，不能直接推算线上容量。
- **压测机与被测系统分开部署**，并监控压测机自身的 CPU 和网卡。压测机 CPU 打满时，k6 发不出计划的请求、测到的延迟也会包含本机调度延迟。
- **压测环境独占**：同一时间只跑一个压测任务，其他团队的联调流量也会污染结果。
- **生产环境全链路压测**涉及流量染色、影子库、挡板与熔断开关，见 [容量评估与规划](/high-con/8_capacity_planning) 第五节，本篇不展开。

### 2、数据

- **数据量接近生产**：订单表只有几千行时，索引全在内存里，慢 SQL 根本暴露不出来。
- **参数分布接近生产**：热点商品、长尾商品按比例混合，用户号足够分散，避免缓存命中率虚高或行锁集中。
- **写接口要考虑数据膨胀和清理**：下单压测会持续写入订单，需要在压测前后清理，或使用可以整体重建的压测库。

### 3、预热

JVM 刚启动时代码以解释模式运行，JIT 编译、类加载、连接池建连、本地缓存填充都在前几分钟发生，这段时间的延迟不代表稳态。处理方式有两种：一是像上面的脚本那样单独设一个 `warmup` 场景，其他场景用 `startTime` 延后启动，阈值只绑定正式场景；二是压测前单独跑一轮预热。JVM 层面的预热手段（CDS、CRaC 等）见 [启动优化](/spring-boot/14_startup)。

### 4、基线与对比

每次正式压测都要记录：被测版本（commit / 镜像 digest）、环境规格、JVM 参数、脚本版本、数据量，以及结果（各场景 P95 / P99、吞吐、错误率、CPU、GC 停顿）。存档后作为基线，新版本按同一条件重跑并对比，例如 P99 变差超过 10% 或吞吐下降超过 5% 就视为性能回退，需要排查后才能发布。

### 5、压测时同步观测

只看压测报告无法定位问题。压测期间至少盯住：应用的 `http_server_requests` 延迟与错误、JVM 堆和 GC 停顿、Tomcat / Netty 线程池、HikariCP 的 `hikaricp_connections_active` 与 `hikaricp_connections_pending`、数据库的慢查询与锁等待。指标接入见 [Actuator 监控](/spring-boot/7_actuator)，日志与 traceId 关联见 [日志](/spring-boot/12_logging)。

---

## 八、在 CI 中运行

性能测试进 CI 要分层，不能每个 PR 都跑一小时压测：

| 层级 | 触发 | 内容 | 环境 |
|------|------|------|------|
| 冒烟 | 每个 PR | `--scenario smoke`，验证脚本与接口可用，阈值只做功能检查 | CI 内用 Docker Compose 拉起服务 |
| 回归负载 | 每晚 / 发布前 | 预热 + 负载场景，与基线对比 | 独占的压测环境 |
| 压力 / 浸泡 / 断点 | 大促前、重大架构变更后 | 按需手动触发 | 独占的压测环境 |

GitHub 托管的 Runner 是共享虚拟机，性能波动大，只适合冒烟和粗粒度的趋势监控；回归负载应在与压测环境同机房的自托管 Runner 上执行。下面是夜间回归负载的工作流，`grafana/setup-k6-action` 负责安装指定版本的 k6，阈值失败时 `k6 run` 返回非零退出码，任务随之失败：

```yaml
name: perf-nightly

on:
  schedule:
    - cron: '0 18 * * *'   # UTC 18:00，即北京时间 02:00
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: perf-env          # 压测环境独占，同一时间只跑一个
  cancel-in-progress: false

jobs:
  load-test:
    runs-on: [self-hosted, perf]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7

      - uses: grafana/setup-k6-action@v1
        with:
          k6-version: '2.3.0'

      - name: Run load test
        env:
          BASE_URL: ${{ vars.PERF_BASE_URL }}
          K6_WEB_DASHBOARD: 'true'
          K6_WEB_DASHBOARD_EXPORT: k6-report.html
        run: |
          k6 run --scenario warmup,query_order,create_order \
            -e BASE_URL="$BASE_URL" perf/order-load.js

      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: k6-report
          path: k6-report.html
```

几点约定：

- `BASE_URL` 先放进 `env` 再在脚本里引用，而不是把 `${{ }}` 表达式直接拼进 `run`，避免表达式注入；Action 固定到 commit SHA、最小权限等通用规则见 [CI/CD](/devops/2_ci_cd)。
- `concurrency` 保证同一时间只有一个工作流在压测环境上运行，`cancel-in-progress: false` 让新任务排队而不是打断正在进行的压测。
- `if: always()` 保证阈值失败时也能上传报告，失败的那次最需要看报告。
- PR 冒烟的写法相同，把场景换成 `--scenario smoke`，并在前面加一步用 Docker Compose 拉起 order-service 及其依赖；冒烟只判功能和错误率，不设严格的延迟阈值，否则共享 Runner 的波动会让 PR 频繁误报。

---

## 九、结果分析与瓶颈定位

### 1、读负载曲线

把负载测试或断点测试的结果画成「负载—吞吐—P99」曲线，通常能看到三个区域：

![负载、吞吐与延迟曲线](../assets/testing/perf-test-load-curve.svg)

| 区域 | 现象 | 含义 |
|------|------|------|
| 线性区 | 吞吐随负载线性增长，P99 基本平稳 | 资源有余量，正常工作范围 |
| 饱和区 | 吞吐增长放缓直至见顶，P99 开始抬升 | 某个资源接近饱和，容量点就在这一区间的起点附近 |
| 过载区 | 吞吐不升反降，P99 急剧恶化，错误率上升 | 排队失控，线程、连接被慢请求占满，可能引发雪崩 |

### 2、先确认结果有效

分析之前先排除压测本身的问题：

- `dropped_iterations` 是否为 0，实际吞吐是否达到计划速率
- 压测机 CPU、网卡是否打满
- 错误是什么类型：4xx 往往是测试数据或脚本问题，5xx 和超时才是被测系统的问题
- 客户端 P99 与服务端 P99 差距是否过大（差距大说明问题在网络、网关或压测机）

### 3、从现象到根因

确认结果有效后，按 [性能分析方法论](/high-perf/2_methodology) 的自顶向下流程定位：先用 RED 找到慢的接口，再用 USE 逐项检查 CPU、内存、线程池、连接池、下游。常见现象与第一步动作：

| 现象 | 可能原因 | 第一步 |
|------|---------|--------|
| CPU 接近 100% | 计算热点、序列化开销、GC 频繁 | async-profiler CPU 火焰图，见 [性能分析工具](/high-perf/3_profilers) |
| CPU 不高但响应慢 | 锁竞争、慢 SQL、连接池等待、下游慢 | wall-clock 火焰图；`jstack` 找 BLOCKED / WAITING 线程；看 `hikaricp_connections_pending` |
| 连接超时、连接被拒 | 线程池或连接池耗尽、端口或文件句柄耗尽 | 线程池与连接池指标；`ss -s` 看连接汇总，`ss -tan state time-wait \| wc -l` 统计 TIME-WAIT |
| 浸泡测试中内存持续增长 | 内存泄漏、缓存无上限 | `jcmd <pid> GC.heap_info` 看堆使用；对比多次堆转储，见 [诊断工具](/jvm/8_monitoring_tools) |
| P99 周期性尖刺 | GC 停顿、定时任务、日志刷盘 | GC 日志与 JFR 录制，见 [JVM 层性能策略](/high-perf/5_jvm_tuning) |

线上环境无法重启或加参数时，用 Arthas 的 `trace`、`profiler` 等命令在运行中定位，见 [线上诊断](/engineering/4_diagnosis)。找到瓶颈并调整后，按同一条件重跑压测验证效果，各层并发参数的调整方法见 [并发参数调优](/high-con/7_concurrency_tuning)，容量换算见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 六类测试负载形态不同、目的不同：冒烟验证脚本，负载验证 SLO，压力看退化，浸泡查泄漏，尖峰看弹性，断点找上限
- 在线接口用开放模型（k6 到达率执行器、Gatling `injectOpen`）压测；闭合模型会因协调遗漏把长尾测得偏乐观
- `dropped_iterations` 非零、压测机打满时，结果不能用于判定容量
- 阈值从 SLO 推导，至少覆盖延迟分位数、错误率、功能检查三类；k6 阈值和 Gatling 断言失败都可以直接让 CI 失败
- 预热、数据量与分布、独占环境、基线对比决定结果是否可信
- 分析先确认结果有效，再按 RED / USE 自顶向下定位，用火焰图和诊断工具找根因，最后回到压测验证

## 参考资料

- k6 场景与执行器：[Scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/)
- k6 开放与闭合模型：[Open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
- k6 固定到达率执行器：[Constant arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)
- k6 阈值：[Thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/)
- k6 内置指标：[Built-in metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/)
- k6 运行选项（`--scenario`、`summaryTrendStats`）：[Options reference](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/)
- k6 Prometheus remote write 输出：[Prometheus remote write](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/)
- k6 Web 看板：[Web dashboard](https://grafana.com/docs/k6/latest/results-output/web-dashboard/)
- k6 2.0 发布说明：[k6 v2.0.0 release notes](https://grafana.com/docs/k6/latest/release-notes/v2.0.0/)
- setup-k6-action：[GitHub 仓库](https://github.com/grafana/setup-k6-action)
- Gatling 注入模型：[Injection](https://docs.gatling.io/concepts/injection/)
- Gatling 断言：[Assertions](https://docs.gatling.io/concepts/assertions/)
- Gatling Maven 插件：[Maven plugin](https://docs.gatling.io/integrations/build-tools/maven-plugin/)
- JMeter 命令行参数：[Getting Started: CLI mode](https://jmeter.apache.org/usermanual/get-started.html)
- JMeter 组件参考（Thread Group、Open Model Thread Group、Duration Assertion）：[Component Reference](https://jmeter.apache.org/usermanual/component_reference.html)
- wrk2（固定速率与协调遗漏修正）：[GitHub 仓库](https://github.com/giltene/wrk2)

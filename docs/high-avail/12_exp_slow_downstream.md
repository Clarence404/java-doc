---
description: 库存服务变慢 5 秒的对照实验、超时 / 舱壁 / 熔断 / 连接池逐层效果、熔断没打开的原因
---

# 下游变慢实验

> 前置阅读：[超时、重试与隔离](./4_timeout_retry_bulkhead)、[熔断](./5_circuit_breaking)、[稳定性](/project/8_stability)

mall-evolution 在「稳定性」一章给下单配了超时、舱壁和熔断，这套配置在下游真的变慢时管不管用？本篇把库存服务拖慢 5 秒，逐层打开保护实测，并记录由此改掉的两处配置。

## 一、现象与假设

订单服务下单时要调库存服务的预占接口（reserve）。库存服务一变慢，下单卡住是意料之中的；意料之外的是商品详情也跟着打不开，而详情页根本不调 reserve。

实验要验证三件事：

| 假设 | 怎么验证 |
|------|---------|
| 没有保护时，一个慢接口会拖垮整个服务 | 看详情页的成功率 |
| 超时、舱壁、熔断每加一层，都有一个看得见的改善 | 逐层打开，同样的流量再压一次 |
| 服务间 HTTP 连接池的默认值（每个下游实例 5 条连接）会成为瓶颈 | 最后一组只改连接池 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 网关 → mall-app（订单、商品）→ 库存服务，各 1 个实例 |
| 流量 | 下单 40 次/秒 + 商品详情 100 次/秒，持续 6 分钟，客户端超时 10 秒 |
| 故障 | 第 60 秒起给库存服务的 reserve 接口加 5 秒延迟，持续 180 秒后撤销 |
| 环境 | 四个服务与压测都在一台 Windows 开发机上，MySQL、Redis、Nacos、RocketMQ 在本机虚拟机里 |
| 版本 | JDK 21、Spring Boot 4、Resilience4j 2、Apache HttpClient 5 |

五组配置只差下面几项，其余完全相同：

| 组 | 读超时（mall-app → 库存） | 网关超时 | 舱壁 | 熔断 | 连接池 |
|----|------|------|------|------|------|
| 无保护 | 60 秒 | 60 秒 | 无 | 无 | 默认：每个下游实例 5 条，取连接最多等 3 分钟 |
| 只加超时 | **500ms** | **3 秒** | 无 | 无 | 默认 |
| 加舱壁 | 500ms | 3 秒 | **60 个并发** | 无 | 默认 |
| 加熔断（项目的正式配置） | 500ms | 3 秒 | 60 | **开** | 默认 |
| 放开连接池 | 500ms | 3 秒 | 60 | 开 | **每个下游实例 100 条，取连接最多等 100ms** |

熔断的参数：10 秒时间窗口、至少 100 次调用、失败率 ≥ 50% 或慢调用率 ≥ 60% 时打开，打开 5 秒后放 20 个请求试探。

### 对应的代码

「加熔断」这一组就是 [稳定性](/project/8_stability) 第四节定下来的配置，实验没有另写一套。几个关键位置：

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 下单调库存：熔断器包住远程调用 | [`InventoryReserveClient`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/place/InventoryReserveClient.java) |
| 熔断、舱壁、读超时的参数 | [`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml) 的 `resilience4j` 与 `spring.http.serviceclient` |
| 哪些异常算失败 | [`RemoteFailurePredicate`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/remote/RemoteFailurePredicate.java) |
| 详情页的库存提示（本机缓存 + 远程查询） | [`StockQueryService`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/stock/StockQueryService.java) |
| 服务间连接池的开关 | [`HttpClientPoolConfig`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/remote/HttpClientPoolConfig.java) |
| 故障注入（只在 demo profile 下存在） | [`DemoFaultRulesController`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/demo/fault/DemoFaultRulesController.java) |
| 压测场景 | [`SlowDownstreamSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/SlowDownstreamSimulation.java) |

下单调库存只有一行，熔断器和舱壁都由 Spring Cloud CircuitBreaker 按名字 `inventory-reserve` 套上去：

```java
public ReserveResult reserve(ReserveStockRequest req) {
    return circuitBreaker.run(() -> inventoryApi.reserve(req), InventoryReserveClient::rethrow);
}
```

故障是往库存服务发一条规则注入的，到期自动失效：

```http
PUT /internal/demo/faults/a-reserve-slow
{"method": "POST", "path": "/internal/inventory/reserve", "delayMs": 5000, "ttlSeconds": 240}
```

每组跑了 3–6 轮，共 22 轮（不含第六节的验证）。同一组各轮的状态码占比相差不到 2 个百分点，下面的数字取其中一轮。

## 三、结果

![库存服务变慢期间商品详情每 10 秒的成功率](../assets/high-avail/exp-slow-downstream-detail.svg)

故障持续的 180 秒内：

| 组 | 详情页成功率 | 下单失败得快不快 | mall-app 忙线程（中位 / 最大） | 库存服务实际收到的 reserve |
|----|------|------|------|------|
| 无保护 | 2% | 36% 等满 10 秒超时，63% 连接被拒 | 200 / 200 | 约 190 次（1 次/秒） |
| 只加超时 | 2% | 57% 等 3 秒后 504，42% 连接被拒 | 200 / 200 | 约 1700 次 |
| 加舱壁 | 99% | 75% 立刻 503，24% 等 3 秒后 504 | 60 / 200 | 约 1700 次 |
| 加熔断 | 99% | 75% 立刻 503，24% 等 3 秒后 504 | 60 / 200 | 约 1700 次 |
| 放开连接池 | 100% | 87% 在 5ms 左右 503，13% 在 0.5 秒超时 | 0 / 23 | 约 950 次 |

故障期间下单本来就做不成（库存服务要 5 秒才响应），所以下单看的是失败得快不快。故障撤销后，前两组要 10–20 秒才恢复，后三组详情页不受影响、下单在 2–12 秒内恢复。

三个和预期不一样的地方，下面逐个说明：

- 只加超时，详情页一点没救回来
- 加了熔断和没加一样，熔断器从头到尾没打开过
- 真正让下单失败得快的是连接池那一组

## 四、逐组分析

### 1、无保护：详情页为什么跟着挂

线程栈给出了答案。故障第 30 秒时，mall-app 的 200 个 Tomcat 线程：

| 线程在做什么 | 数量 |
|------|------|
| 排队等一条到库存服务的连接 | 109 |
| 等本机缓存加载库存提示（同一个 key 只让一个线程去查，其余等它） | 91 |
| 空闲 | 0 |

这 109 个线程的栈顶都是同一处，在 HttpClient 的连接池里等：

```text
"http-nio-8080-exec-1" waiting on condition
    at org.apache.hc.core5.pool.StrictConnPool$1.get(StrictConnPool.java:178)
    at org.apache.hc.client5.http.impl.classic.InternalExecRuntime.acquireEndpoint(InternalExecRuntime.java:111)
```

关键就在这里。mall-app 到库存服务总共只有 5 条连接，每条被一个 reserve 占住 5 秒，所以库存服务每秒只收到 1 个请求（180 秒约 190 次），而压测每秒发 40 个下单。剩下的线程都在排队等连接，一等最多 3 分钟。

详情页不调 reserve，但它要查「有货 / 无货」的提示，这个查询走的是同一个下游、同一个连接池，也排在同一条队里。200 个线程很快全部卡住，详情页自然打不开。

故障约 1 分钟后，失败的形态从「等 10 秒超时」变成了「连接被拒」：请求在 Tomcat 里越积越多，压测 140 次/秒乘以 58 秒约等于 8192，正好是 Tomcat 默认的最大连接数。实验没有采集连接数指标，这一条是按时间推断的。

### 2、只加超时：管不到排队这一段

读超时从 60 秒改成 500ms，库存服务收到的请求从每秒 1 个涨到每秒约 10 个（5 条连接，每条 0.5 秒超时一次），仅此而已。mall-app 的线程栈反而更难看：

| 线程在做什么 | 第 30 秒 | 第 90 秒 |
|------|------|------|
| 排队等连接 | 183 | 200 |
| 等本机缓存加载 | 17 | 0 |

读超时管的是**拿到连接之后**等响应的时间，排队等连接是另一个超时（connection request timeout），HttpClient 5 的默认值是 3 分钟。所以这一组唯一的变化是网关 3 秒超时让用户早点看到 504，服务本身没有任何好转。

### 3、加舱壁：详情页救回来了

舱壁把同时调 reserve 的线程限制在 60 个，第 61 个直接拿到 503，不再占线程。Tomcat 忙线程稳定在 60 个，剩下 140 个线程可以服务详情页，详情页成功率回到 99%。

下单还有 24% 要等 3 秒：这部分是进了舱壁的 60 个线程，它们仍在排队等那 5 条连接，直到被网关的 3 秒超时切断。

### 4、加熔断：熔断器没有打开

这一组用的是项目的正式配置，结果和上一组几乎一样。查指标：整个故障期间，熔断器状态一直是关闭，拒绝次数为 0。

`inventory-reserve` 这个熔断器当时的配置（节选）：

```yaml
resilience4j:
  circuitbreaker:
    instances:
      inventory-reserve:
        sliding-window-type: TIME_BASED
        sliding-window-size: 10
        minimum-number-of-calls: 100
        failure-rate-threshold: 50
        slow-call-rate-threshold: 60
        record-failure-predicate: io.github.clarence404.mall.common.remote.RemoteFailurePredicate
```

原因在熔断器自己的统计里：

| 熔断器记录的调用（故障 180 秒内） | 次数 |
|------|------|
| 失败 | 1750 |
| 成功 | 7145 |

这段时间真正成功的下单只有几十个，7145 次「成功」绝大部分是**被舱壁拒绝的调用**。Spring Cloud CircuitBreaker 把舱壁包在熔断器里面，舱壁满时抛出的 `BulkheadFullException` 不在项目配置的「算失败」名单里（只记超时、连接失败和 5xx），Resilience4j 对既不算失败、也没声明忽略的异常一律记成功。

于是失败率最高只到 22%（阈值 50%），慢调用率最高 47%（阈值 60%），熔断器永远够不着阈值。舱壁越满，被稀释得越厉害。

### 5、放开连接池：失败变快，熔断器也打开了

连接池改成每个下游实例 100 条、取连接最多等 100ms 之后：

- 调用不再排队，每次都在 500ms 读超时后失败，舱壁没有被占满（剩余许可最少时还有 38 个）
- 没有舱壁拒绝来稀释，失败率很快到 100%，熔断器在故障后约 11 秒打开
- 打开后下单在 5ms 左右直接失败，之后每 5 秒放一批请求试探，库存服务收到的请求降到原来的一半左右
- mall-app 忙线程中位数为 0，详情页的耗时和故障前没有差别

熔断器花了 11 秒才打开，是因为 10 秒的时间窗口里还留着故障前的成功调用，失败率要等它们滑出去才过半。窗口越长，统计越稳，打开得也越慢。

## 五、实验暴露的两个问题

| 问题 | 影响 | 可以怎么改 |
|------|------|-----------|
| 服务间连接池用的是 HttpClient 5 的默认值（每个下游实例 5 条、等连接 3 分钟） | 下游一变慢，调用全部排在连接池里，读超时不起作用，舱壁被排队的线程占满 | 连接数按舱壁许可数配，取连接的等待时间设成百毫秒级 |
| 舱壁的拒绝被熔断器算成成功 | 舱壁占满时熔断器打不开 | 在熔断器配置里把 `BulkheadFullException` 声明为忽略（不计入统计） |

两个问题叠在一起才有了第四组的结果：连接池太小导致舱壁被占满，舱壁占满又让熔断器失效。两处都已经在 mall-evolution 里改掉，见下一节。

::: tip 排查顺序
下游变慢时先看线程栈里线程卡在哪一步：等连接、等响应还是等许可。三者对应的是三个不同的配置，只调读超时解决不了前后两种。
:::

## 六、修复后

改动只有配置，提交见 [`520468e`](https://github.com/Clarence404/mall-evolution/commit/520468e)。连接池三个服务都加了；熔断器的三个实例都加了忽略项：

```yaml
mall:
  http-client:
    max-connections-per-route: 100       # 原来不配，用 HttpClient 5 的默认值 5
    max-connections-total: 200           # 默认 25
    connection-request-timeout: 100ms    # 默认 3 分钟

resilience4j:
  circuitbreaker:
    instances:
      inventory-reserve:
        ignore-exceptions:               # 舱壁满的异常不计入统计，不再被记成成功
          - io.github.resilience4j.bulkhead.BulkheadFullException
```

同样的故障再压一次，为了分清两处改动各自的作用，中间加了一组「只改熔断器」：

| 组 | 熔断器 | 详情页成功率 | 下单失败得快不快 | 库存服务收到的 reserve |
|----|------|------|------|------|
| 修复前（原正式配置） | 没有打开 | 99% | 75% 立刻 503，24% 等 3 秒后 504 | 约 1700 次 |
| 只让熔断器忽略舱壁异常 | 故障后 8 秒打开 | 99% | 91% 立刻 503，7% 超时后 500，1% 等 3 秒后 504 | 约 580 次 |
| 两处都改（现在的正式配置） | 故障后 10 秒打开 | 100% | 86% 立刻 503，13% 在 0.5 秒超时 | 约 940 次 |

- 只改熔断器就足以让它打开：被舱壁拒绝的调用不再稀释失败率，库存服务收到的请求降到三分之一
- 连接池不放开时，仍有约 1% 的下单卡在等连接上，被网关 3 秒超时切断；详情页也还有不到 1% 的 504
- 两处都改之后的结果与第五组一致，mall-app 忙线程最多 22 个

「修复前」这一行是在新代码上把旧值钉回去重跑的，两轮结果与第三节相同，说明差别确实来自这两项配置。这几轮验证期间环境里的数据库仍有卡顿，数字与前面各轮的偏差在 1 个百分点以内。

## 七、复现

实验的方案、参数和脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录，每组一条命令：

```powershell
.\experiments\a-slow-downstream\run.ps1 -Variant a0-no-protection
.\experiments\a-slow-downstream\run.ps1 -Variant a3-circuit-breaker
.\experiments\a-slow-downstream\run.ps1 -Variant a4-pool
.\experiments\a-slow-downstream\run.ps1 -Variant a3b-ignore-bulkhead
.\experiments\a-slow-downstream\run.ps1 -Variant a5-fixed
```

前五组的参数文件把修复前的连接池和熔断配置钉住了，现在跑出来仍是第三节的结果；`a5-fixed` 是修复后的正式配置。

脚本会起服务、压测、在第 90 秒和第 150 秒抓线程栈，结果写到 `experiments/out/`。几点局限：

- 服务、压测、采样都在同一台机器上，绝对数值只对这台机器成立，看的是组间差异
- 「连接被拒」是 Windows 的表现，Linux 上连接队列满了默认是丢弃握手包，调用方看到的是连接超时
- 白天有一部分轮次里虚拟机上的数据库提交偶尔卡 2–5 秒，这些轮次的结果与其余轮次一致

## 小结

- 一个慢接口拖垮整个服务，靠的是共享的资源：Tomcat 线程池和到同一个下游的连接池
- 读超时只管拿到连接之后的等待，排队等连接要单独设超时
- 舱壁保住的是其他接口，被隔离的接口本身不会变快
- 熔断器能不能打开，要看它统计到的失败率；包在里面的舱壁、重试都会改变这个数
- 保护手段要在故障注入下实测，光看配置看不出它们之间的相互影响

## 参考资料

- 熔断器对异常的三种处理（记失败、忽略、记成功）：[Resilience4j: CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker)
- 连接池的默认上限与取连接超时：[Apache HttpClient 5: Connection management](https://hc.apache.org/httpcomponents-client-5.5.x/)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[重试风暴与幂等实验](./13_exp_retry_storm) —— 下游只抖了 20 秒，为什么故障结束后系统还是恢复不过来。

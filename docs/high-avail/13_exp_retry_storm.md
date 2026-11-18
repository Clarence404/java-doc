---
description: 20 秒小故障被重试放大成长时间不可用的对照实验、重试预算与舱壁的作用、超时重试与幂等键
---

# 重试风暴与幂等实验

> 前置阅读：[超时、重试与隔离](./4_timeout_retry_bulkhead)、[稳定性](/project/8_stability)、[下游变慢实验](./12_exp_slow_downstream)

mall-evolution 在「稳定性」一章定了重试规则：只读查询最多重试 1 次，写操作靠幂等键。本篇把这套规则和它的反面各压一遍，看一次 20 秒的小故障之后系统多久恢复、会不会重复下单。

## 一、现象与假设

App 支付后会轮询支付状态：App → 网关 → mall-app → 支付服务。这条链路上有两层重试，App 一层，mall-app 调支付服务又一层。

| 假设 | 怎么验证 |
|------|---------|
| 不受控的重试会把一次小故障放大成故障结束后也恢复不了的状态 | 同一个 20 秒的小故障，换四种重试组合 |
| 两层重试里，离瓶颈近的那一层更关键 | 只管住 App 端、只管住服务端各跑一组 |
| 超时后重试如果换了幂等键，会重复下单 | 让一部分下单响应迟到，数每个用户最终有几单 |

## 二、重试风暴

### 1、实验设置

| 项 | 取值 |
|----|------|
| 流量 | 600 个用户先各下一单，之后每秒 150 次首次查询（不含重试），持续 5 分钟，App 超时 2 秒 |
| 瓶颈 | 支付查询最多 10 个并发、每个占 40ms，容量约 250 次/秒，平时负载六成 |
| 小故障 | 轮询第 60 秒起每个查询变成 400ms（容量掉到约 25 次/秒），20 秒后恢复 |
| 连接池 | 四组都放开服务间连接池，排除[下游变慢实验](./12_exp_slow_downstream)里连接池的影响 |

支付服务的排队不设超时：调用方放弃的请求，轮到时照样处理。真实的服务大多也是这样。

| 组 | App 端重试 | mall-app 端重试 | mall-app 端舱壁 |
|----|-----------|----------------|----------------|
| 两端都不受控 | 立刻重试，最多 3 次 | 立刻重试 3 次 | 无 |
| 只管住 App 端 | 指数退避加抖动（200ms 起、2 秒封顶），重试预算 10% | 立刻重试 3 次 | 无 |
| 只管住服务端 | 立刻重试，最多 3 次 | 重试 1 次，退避 20–80ms | 20 个并发 |
| 两端都受控 | 同「只管住 App 端」 | 同「只管住服务端」 | 20 个并发 |

重试预算 10% 的意思是：重试次数不超过首次请求数的 10%，超出的重试直接放弃。

### 2、对应的代码

「两端都受控」这一组的服务端，就是 [稳定性](/project/8_stability) 第五节「重试风暴」定下来的做法；App 端的退避和预算由压测脚本模拟。

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 查支付状态：重试 + 熔断 + 舱壁 | [`PaymentQueryClient`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/query/PaymentQueryClient.java) |
| 舱壁许可数、熔断参数 | [`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml) 的 `payment-query` |
| App 端的重试策略与重试预算（压测侧） | [`ClientRetryPolicy`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/ClientRetryPolicy.java)、[`RetryBudget`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/RetryBudget.java) |
| 下单幂等：幂等键 + 唯一索引 | [`PlaceOrderController`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/place/PlaceOrderController.java)、[`PlaceOrderService`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/place/PlaceOrderService.java) |
| 压测场景 | [`RetryStormSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/RetryStormSimulation.java)、[`RetryIdempotencySimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/RetryIdempotencySimulation.java) |

服务端的重试用的是 Spring Framework 7 自带的 `@Retryable`，只对超时和连接失败重试，默认 1 次、退避 20–80ms；熔断打开或舱壁满时直接返回「系统繁忙」，不进入重试：

```java
@Retryable(
        includes = ResourceAccessException.class,
        maxRetriesString = "${mall.remote.payment-query.retry.max-retries:1}",
        delayString = "${mall.remote.payment-query.retry.delay:20ms}",
        jitterString = "${mall.remote.payment-query.retry.jitter:60ms}")
public PaymentStatusView query(String orderNo) {
    return circuitBreaker.run(() -> paymentApi.query(orderNo), t -> {
        if (t instanceof CallNotPermittedException || t instanceof BulkheadFullException) {
            throw new BizException(CommonErrorCode.SYSTEM_BUSY);
        }
        ...
    });
}
```

「不受控」的两组把这里的重试次数改成 3、退避改成 0，并去掉舱壁，其余代码不变。

### 3、结果

![20 秒小故障前后首次查询每 10 秒的成功率](../assets/high-avail/exp-retry-storm-success.svg)

| 组 | App 端重试次数（首次请求 45000 次） | 小故障结束后多久恢复 | 轮数 |
|----|------|------|------|
| 两端都不受控 | 96733 / 105747 | 202 秒 / 压测结束前（220 秒）没恢复 | 2 |
| 只管住 App 端 | 3607，另有 35980 次被预算拦下 | 压测结束前没恢复 | 1 |
| 只管住服务端 | 9667 | 3 秒 | 1 |
| 两端都受控 | 337 / 334，另有约 3200 次被预算拦下 | 2 秒 / 2 秒 | 2 |

恢复的判定是首次查询成功率回到 95% 以上并保持 10 秒。

### 4、不受控时为什么恢复不了

小故障只有 20 秒，支付服务的处理能力在第 94 秒就回到了 250 次/秒，但系统停在了一个自己走不出来的状态：

| 环节 | 观测到的情况 |
|------|-------------|
| 支付服务 | 200 个 Tomcat 线程全忙：10 个在处理，190 个在排队 |
| mall-app | 每次调用失败后立刻重试，小故障结束后失败的尝试有 6.5 万–10.5 万次，是放弃次数的 4 倍 |
| App | 每个首次查询平均带出 2.1–2.4 次重试 |

排队 190 个、每秒处理 250 个，排到队尾要等约 0.76 秒，而 mall-app 的读超时是 0.5 秒。所以支付服务处理的每一个请求，调用方都已经放弃了；调用方放弃后立刻重试，又补上一个排队的。支付服务满负荷运转，有效产出接近零。

故障的原因（查询变慢）已经消失，维持故障的是重试自己。这种状态叫亚稳态故障，特点是**去掉诱因也不恢复**，要靠外力打破：减流量、重启或者限并发。两轮里有一轮在 202 秒后恢复、另一轮到压测结束也没恢复，可见恢复与否带有偶然性。

### 5、哪一层更关键

- **只管住 App 端**：App 的重试从 10 万次降到 3607 次，但系统照样没恢复。mall-app 每次调用仍会打 4 次支付服务，150 次/秒的首次查询就足以维持住排队
- **只管住服务端**：App 仍然立刻重试 3 次，系统却在 3 秒内恢复。舱壁把 mall-app 同时调支付服务的请求限制在 20 个，支付服务里排队的最多 10 个，等待时间远小于读超时，处理出来的结果都有人要

离瓶颈最近的一层限制了并发，下游才不会做白工，这是恢复的前提。App 端的退避和预算减少的是无效流量：两端都受控时，App 的重试只有 334 次，小故障期间 92% 以上的首次查询直接拿到 503，客户端可以提示「支付结果确认中」。

::: warning 熔断器在这组实验里同样没有打开
两端都受控的那一组配了熔断（失败率 50% 打开），实测失败率最高只到 19%，原因和[下游变慢实验](./12_exp_slow_downstream)里一样：舱壁的拒绝被熔断器记成了成功。起作用的是舱壁和有限的重试次数。这个问题已经修掉，`payment-query` 一并加了忽略项，见[下游变慢实验](./12_exp_slow_downstream)的「修复后」一节；本实验的参数文件钉住了修复前的值，复现出来仍是这里的数字。
:::

## 三、超时重试与幂等

### 1、实验设置

| 项 | 取值 |
|----|------|
| 流量 | 每秒 5 个新用户各下一单，持续 60 秒，共 300 个下单意图 |
| 故障 | 30% 的下单请求在订单写库之后，响应晚 2.5 秒才发出 |
| App | 超时 1.5 秒，超时后立刻重试，最多 3 次 |
| 核对 | 结束后查每个用户的订单列表，数一共生成了几单 |

两组的差别只有一处：重试时 `Idempotency-Key` 请求头是每次换新的，还是整个下单意图用同一个。服务端的幂等实现见 [接口设计](/project/3_api_design) 第五节：订单表对「用户 + 幂等键」建唯一索引，重复请求撞上索引后查出第一次的订单返回。

### 2、结果

| 组 | 第 1 轮：生成 2 单的用户 | 第 2 轮：生成 2 单的用户 |
|----|------|------|
| 每次重试换新键 | 100 / 300（33%） | 84 / 300（28%） |
| 始终同一个键 | 0 / 300 | 0 / 300 |

换新键的那一组，重复下单的比例和响应迟到的比例（30%）基本一致：服务端已经下单成功，只是响应没赶上，App 以为失败再下一次，就是第二单。重复单没有超过 2 单，是因为订单服务另有一条频控（同一商品待支付最多 2 单），第三次请求收到了 409。

同一个键的那一组，服务端认出这是同一次下单，直接返回第一次的结果，响应头带 `Idempotent-Replayed`。两轮里分别有 1 个和 4 个用户重试 3 次后仍然超时，但他们名下也只有 1 单。

所以带副作用的接口要重试，前提是整个意图用同一个幂等键；键应当在用户点下按钮时生成，而不是在每次发请求时生成。

## 四、复现

```powershell
.\experiments\b-retry-storm\run.ps1 -Variant b1-naive
.\experiments\b-retry-storm\run.ps1 -Variant b1-controlled
.\experiments\b-retry-storm\run.ps1 -Variant b2-new-key
.\experiments\b-retry-storm\run.ps1 -Variant b2-same-key
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 支付查询的容量是注入出来的模型（并发上限加固定耗时），不是支付服务的真实容量
- 两个单边组各只跑了 1 轮，结论只取「恢复 / 没恢复」这个量级上的差别
- App 的重试由压测脚本模拟，真实 App 还会受用户手动刷新的影响

## 小结

- 重试次数会逐层相乘：App 3 次乘以服务端 3 次，一个失败的请求最多打下游 16 次
- 不受控的重试能让系统在故障原因消失后继续不可用，恢复要靠限并发、减流量
- 离瓶颈最近的一层必须限制并发，保证下游处理出来的结果还有人在等
- 调用方用退避、抖动和重试预算减少无效流量，拿到明确的 503 就不要再重试
- 写接口的重试必须带幂等键，并且整个意图只用一个

## 参考资料

- 退避、抖动与重试的取舍：[AWS Builders' Library: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- 重试预算与级联故障：[Google SRE Book: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- 亚稳态故障的定义与案例：[Metastable Failures in Distributed Systems（HotOS 2021）](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf)

> 下一篇：[滚动发布实验](./14_exp_rolling_restart) —— 逐个重启实例时请求丢在哪一步。

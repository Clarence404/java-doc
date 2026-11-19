---
description: 连接池 5 到 80、Tomcat 线程 50 到 400、实例 1 到 3 的闭环压测、池子加大后下单被行锁拖垮
---

# 连接池与实例数实验

> 前置阅读：[并发参数调优](./7_concurrency_tuning)、[水平扩展与无状态化](./2_scale_out)、[稳定性](/project/8_stability)

mall-evolution 的 mall-app 用 20 条数据库连接、200 个 Tomcat 线程。本篇用固定并发数的闭环压测，实测连接池从 5 加到 80、线程数从 50 加到 400、实例从 1 个加到 3 个，吞吐各变了多少，代价落在哪里。

## 一、现象与假设

吞吐上不去时最顺手的三个动作是加连接池、加线程、加实例。它们加的都是「同时能有多少个请求往下游走」，而下游的数据库只有一个。

| 假设 | 怎么验证 |
|------|---------|
| 连接池加大，吞吐跟着涨，涨到某个值之后不再涨 | 连接池 5、10、20、40、80 各压一遍 |
| Tomcat 线程数多于连接池时，再加线程没有用 | 线程数 50、200、400 |
| 数据库是共用的，实例翻倍吞吐不会翻倍 | 1、2、3 个实例，并发数同比例加 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 网关 → mall-app（1–3 个实例）→ 库存服务、支付服务各 1 个实例，共用一个 MySQL |
| 压测模型 | 闭环：200 个虚拟用户不加思考时间循环，收到响应立刻发下一个请求 |
| 请求构成 | 每一圈 95% 查订单列表（一次带分页的查询），5% 下单；下单在 3 个 SKU 里随机挑 |
| 时长 | 预热 30 秒，正式 5 分钟，取第 40–330 秒 |
| 基准配置 | mall-app 连接池 20、取连接最多等 3 秒、Tomcat 200 线程；库存服务连接池 40 |
| 轮数 | 每个变体 2 轮，下文写两轮的数值或范围 |

用闭环而不用固定到达速率，是因为这次要比的就是吞吐：闭环下吞吐由被测系统决定，池子从 20 加到 80 之后吞吐变没变可以直接读出来。并发数固定在 200，所以查询和下单的比例是 95 比 5，吞吐高了下单的到达量也跟着高，这一点在第四节会用到。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| mall-app 的连接池（默认 20，生产 30） | [`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml)、[`application-prod.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application-prod.yml) |
| 库存服务的连接池（40 条，取连接最多等 250ms） | [`inventory-service/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/resources/application.yml) |
| 实例数与自动扩缩容 | [`deploy/k8s/mall-app.yaml`](https://github.com/Clarence404/mall-evolution/blob/main/deploy/k8s/mall-app.yaml)、[`hpa.yaml`](https://github.com/Clarence404/mall-evolution/blob/main/deploy/k8s/hpa.yaml) |
| 调预占的超时、舱壁、熔断 | [`InventoryReserveClient`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/place/InventoryReserveClient.java) |
| 压测场景与各变体参数 | [`PoolSizingSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/PoolSizingSimulation.java)、[`experiments/h-pool-sizing/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/h-pool-sizing) |

各变体只改启动参数里的一项，其余都是正式配置：

```properties
# experiments/h-pool-sizing/common.properties（节选）
[mall-app]
spring.datasource.hikari.maximum-pool-size=20
spring.datasource.hikari.connection-timeout=3000
server.tomcat.threads.max=200

[inventory-service]
spring.datasource.hikari.maximum-pool-size=40
spring.datasource.hikari.connection-timeout=250
```

环境与 [热点库存实验](./11_exp_hot_stock) 相同：压测工具和服务在一台 20 核的开发机上，MySQL、Redis 在一台 4 核 6GB 的虚拟机里，MySQL 放宽了落盘设置。这一组没有用持锁时间模型，预占的耗时是真实的。

## 三、结果

### 1、连接池大小

![连接池从 5 加到 80 时查询与下单吞吐的变化](../assets/high-con/exp-pool-sizing-throughput.svg)

| 连接池 | 查订单列表（次/秒） | 查询 P50 / P99 | 下单成功（单/秒） | 下单成功率 | 单次占用连接 | 数据库虚拟机 CPU |
|------|------|------|------|------|------|------|
| 5 | 1990 / 2220 | 76ms / 166ms | 105 / 117 | 100% | 1.3ms | 60% |
| 10 | 2442 / 2674 | 62ms / 143ms | 129 / 140 | 100% | 2.5ms | 76% |
| 20（正式配置） | 2697 / 2799 | 56ms / 134ms | 141 / 148 | 100% | 5.1ms | 86% |
| 40 | 3211 / 3154 | 39ms / 94ms | 65 / 83 | 39% / 50% | 9.0ms | 91% |
| 80 | 3408 / 3429 | 36ms / 112ms | 39 / 42 | 22% / 23% | 7.9ms | 90% |

吞吐、成功数、成功率按「第一轮 / 第二轮」列出，耗时与 CPU 取两轮的平均。「单次占用连接」是 HikariCP 记录的一次借出到归还的平均时间，大致就是一次查询在数据库上花的时间。连接池 80 那一组实际只用到 36 条。

### 2、Tomcat 线程数

连接池固定 20：

| Tomcat 线程数 | 查订单列表（次/秒） | 查询 P50 / P99 | 下单成功（单/秒） | 下单 P50 / P99 | 等连接的线程 |
|------|------|------|------|------|------|
| 50 | 2459 / 2509 | 70ms / 97ms | 129 / 131 | 159ms / 206ms | 35 |
| 200（正式配置） | 2697 / 2799 | 56ms / 134ms | 141 / 148 | 235ms / 376ms | 168 |
| 400 | 2863 / 2790 | 55ms / 130ms | 150 / 146 | 228ms / 366ms | 167 |

### 3、实例数

每个实例都是正式配置，并发数按实例数同比例加：

| 实例数（并发数） | 查订单列表（次/秒） | 查询 P50 / P99 | 下单成功（单/秒） | 下单成功率 | 数据库虚拟机 CPU |
|------|------|------|------|------|------|
| 1（200） | 2802 / 2854 | 55ms / 127ms | 148 / 150 | 100% | 86% |
| 2（400） | 2866 / 2945 | 92ms / 289ms | 64 / 68 | 42% / 44% | 91% |
| 3（600） | 3073 / 3155 | 143ms / 446ms | 23 / 24 | 14% | 92% |

三条假设都成立，但都只说对了一半：吞吐确实不再涨，没想到的是下单会垮。

## 四、逐组分析

### 1、5 条连接就有 20 条的七成半

连接池 5 的时候，200 个线程里常年有 196 个在等连接，平均等 70ms，听上去很糟。但吞吐有连接池 20 的 76%，全部成功，数据库的 CPU 只用了 60%。

连接数翻两番，查询吞吐只多了 30%。多出来的连接并没有让数据库干得更快，只是让更多查询同时挤进去：

| 连接池 | 同时在数据库里的查询 | 单次占用连接 | 每条连接每秒完成 |
|------|------|------|------|
| 5 | 5 | 1.3ms | 约 440 次 |
| 10 | 10 | 2.5ms | 约 270 次 |
| 20 | 20 | 5.1ms | 约 145 次 |
| 40 | 40 | 9.0ms | 约 80 次 |

每条连接的产出一路下降，因为数据库所在的虚拟机只有 4 个核，并发的查询多于核数之后，多出来的在数据库里面排队。**请求在连接池外面排队，和在数据库里面排队，等的时间差不多，区别是后者还占着数据库的资源。**

### 2、池子加大之后，下单被行锁拖垮

连接池从 20 加到 40，查询吞吐涨了 15%，下单成功率从 100% 掉到 39%–50%；加到 80，查询涨了 24%，下单只剩 22%–23%。

下单走的是另一条路：mall-app 调库存服务预占，库存服务在同一个 MySQL 上更新库存行。3 个 SKU 就是 3 行，每一单都要拿其中一行的行锁。

| 连接池 | 预占接口服务端 P99 | 行锁等待次数 | 行锁等待累计 | 熔断器打开的时间占比（第二轮） |
|------|------|------|------|------|
| 5 | 23ms | 0.5 万 | 9 秒 | 0 |
| 10 | 36ms | 0.9 万 | 23 秒 | 0 |
| 20 | 71ms | 1.9 万 | 132 秒 | 0 |
| 40 | 950ms | 3.3 万 | 5900 秒 | 21% |
| 80 | 990ms | 2.2 万 | 5000 秒 | 45% |

从 20 到 40，行锁等待累计涨了 40 多倍。过程是这样的：

- **查询把数据库占满**：40 条连接同时查询，数据库 CPU 到了 91%，每条语句都变慢，预占事务里的语句也不例外，持有行锁的时间跟着变长
- **下单的到达量也高了**：闭环里查询快了，同样的 200 个用户转得更快，每秒下单的尝试从约 147 单涨到 160–190 单
- **两头一挤，行锁排起队**：库存服务的 40 条连接全部用上，预占 P99 从 71ms 到 950ms，超过 mall-app 的 500ms 读超时
- **之后就是 [热点库存实验](./11_exp_hot_stock) 里单行的那条路**：超时的预占白做、补偿的 `release` 再抢同一把锁、熔断打开

库存服务的日志里是取不到连接，mall-app 的日志里是读超时和快速失败：

```text
# inventory-service（连接池 40 的那一轮，3949 次）
CannotCreateTransactionException: Could not open JDBC Connection for transaction

# mall-app
ResourceAccessException: I/O error on POST request for "http://inventory-service/internal/inventory/reserve": Read timed out   （4043 次）
系统繁忙，快速失败：当前人数较多，请稍后再试                                                                                 （19101 次）
释放预占失败，交给过期回查，orderNo=...                                                                                      （4455 次）
```

查订单列表在这几组里一直是 100% 成功，P99 还更低了。只看查询接口的吞吐和耗时，连接池 40 是一次成功的调优。**连接池在这里的作用是给数据库限流**：20 条连接把数据库的并发卡在它还能从容处理的范围里，放开之后多出来的吞吐，是从同一个数据库上的其他业务那里挤出来的。

### 3、线程数：50 个线程更稳，400 个和 200 个一样

Tomcat 线程数 50 时，查询吞吐比 200 时低约 10%，但查询 P99 从 134ms 降到 97ms，下单 P99 从 376ms 降到 206ms，成功率同样是 100%。线程少了，同时等连接的从 168 个降到 35 个，请求改在 Tomcat 的连接队列里等，进来之后等连接的时间从 46ms 降到 10ms。

400 个线程和 200 个没有差别，这一组什么也说明不了：并发数只有 200，线程数超过 200 之后多出来的线程没有请求可接。要比出差别得把并发数加到 400 以上，这次没有做。

### 4、加实例：吞吐没涨，下单垮了

2 个实例、400 个并发，查询吞吐只比 1 个实例多 3%，P99 从 127ms 涨到 289ms；3 个实例多 10%，P99 到了 446ms。下单成功率 100% → 43% → 14%，垮的过程和连接池加大那一组一样：实例翻倍等于数据库连接翻倍（20 → 40 → 60），数据库 CPU 从 86% 到 91%、92%。

mall-app 自己并不忙，每个实例进程的 CPU 占用率反而随实例数下降（单实例时约 15%，3 个实例时各 7%）。**加实例加的是应用层的处理能力，而这里缺的是数据库的**。[水平扩展与无状态化](./2_scale_out) 讲的「加机器线性提升容量」有一个前提：瓶颈在被加的那一层。

这也是 [并发参数调优](./7_concurrency_tuning) 第三节那条规则的实测版：扩容前要核算的是所有实例的连接池之和。规则里写的上限是数据库的 `max_connections`，这次连接数没到那个上限（MySQL 的 `max_connections` 是 151，3 个实例时 mall-app 用 60 条、库存服务 40 条），数据库先在 CPU 上到头了。

## 五、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 连接池按数据库能同时处理多少查询来定，不按应用有多少线程 | 4 核的数据库，5 条连接已有 20 条的 76%，40 条时每条连接的产出只剩 5 条时的五分之一 |
| 调连接池、加实例之前，先看共用这个数据库的其他业务 | 查询多了 15%–24%，下单成功率掉到 22%–50% |
| 调优的验收不能只看被调的那个接口 | 查订单列表全程 100% 成功，P99 还降了 |
| 扩实例时把单实例连接池同比例调小，或者先确认数据库有余量 | 2 个实例吞吐多 3%，下单成功率 43% |
| 线程数不必远大于连接池，多出来的线程只是换个地方排队 | 50 个线程吞吐低 10%，P99 低三到四成 |
| 等连接的线程数多不等于连接池小 | 连接池 5 时 196 个线程在等，数据库却只用了六成 |

## 六、复现

```powershell
.\experiments\h-pool-sizing\run.ps1 -Variant h1-pool-5      # 还有 h1-pool-10、20、40、80
.\experiments\h-pool-sizing\run.ps1 -Variant h2-tomcat-50   # 还有 h2-tomcat-400
.\experiments\h-pool-sizing\run.ps1 -Variant h3-app-2       # 还有 h3-app-1、h3-app-3
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 数据库所在的虚拟机只有 4 个核，同一台虚拟机上还有 Redis 和 RocketMQ；「5 条连接就够」是这台数据库的结论，换成 32 核的实例，合适的连接数会大得多，变化的方向不变
- 压测工具、网关、服务都在同一台开发机上，3 个实例时开发机自己也更忙，查询耗时的增长里有这一部分
- 闭环压测里下单的到达量随吞吐变化，连接池 40、80 两组的下单压力比 20 那组高 12%–22%；下单垮掉是数据库变慢和到达量变高共同造成的，没有拆开
- 同一变体的两轮之间吞吐相差 1%–10%，原因没有查，所以表里把两轮都列出来
- Tomcat 400 线程那一组因为并发数只有 200，没有比出差别

## 小结

- 连接池从 5 加到 20，查询吞吐多 30%；从 20 加到 80 再多 24%，下单成功率从 100% 掉到 22%
- 数据库并发多于它的核数之后，多出来的查询在数据库里排队，每条连接的产出下降
- 连接池是数据库的限流阀，放开它等于让一个接口去挤同库的其他业务
- 加实例等于加连接：2 个实例吞吐只多 3%，下单成功率 43%
- 调优的效果要在全链路上验收，被调的那个接口往往是最好看的一个

## 参考资料

- 连接池大小与数据库核数的关系：[HikariCP Wiki: About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[高可用总览](/high-avail/0_overview) —— 容量之内扛得住之后，高可用解决的是故障与过载时怎么不停服。

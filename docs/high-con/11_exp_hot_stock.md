---
description: 单行库存与 4、8、16 个桶的阶梯压测对照、过拐点后成功数的塌陷与平台、桶数翻倍容量不翻倍的原因
---

# 热点库存实验

> 前置阅读：[热点问题](./6_hotspot)、[稳定性](/project/8_stability)

mall-evolution 给活动 SKU 的库存分了桶，用来拆开单行上的行锁排队。本篇把下单全部打到同一个 SKU，实测单行与 4、8、16 个桶各能扛到多少，以及过了拐点之后各自是怎么坏的。

## 一、现象与假设

大促时一个爆款会吃掉很大一部分下单。每一单都要在同一行库存上执行 `UPDATE ... SET stock = stock - 1`，行锁一次只给一个事务，其余的排队。[稳定性](/project/8_stability) 第七节的做法是把这一行拆成多个桶，按订单号哈希到其中一行，第八节的压测第 1 轮「爆款单行锁排队」就是它的由来。

| 假设 | 怎么验证 |
|------|---------|
| 单行库存的容量由一次预占持锁多久决定 | 下单速率逐级加上去，看拐点在哪 |
| 拆成 n 个桶，容量约为 n 倍 | 4、8、16 个桶各压一遍 |
| 过了拐点，成功数会停在容量上 | 看拐点之后每秒还能成功多少单 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 网关 → mall-app → 库存服务、支付服务，各 1 个实例 |
| 流量 | 全部是下单，全部买 SKU 20001，每单 1 件，每单换一个新用户 |
| 加压方式 | 先以 20 单/秒预热 30 秒，再从 50 单/秒起每 90 秒加 50，加到 450 单/秒，共 9 级 |
| 持锁时间模型 | 预占扣完库存后，在事务里（行锁还没放）多停留 10ms |
| 关单 | 下单后没人支付，60 秒后超时关单，库存还回原来那一行或那个桶 |
| 客户端 | 超时 3 秒，不重试 |
| 变体 | 单行、4 个桶、8 个桶、16 个桶；压测前拆桶，压完等库存还清再并回单行 |

持锁时间用模型而不用真实耗时，是因为开发机上一次预占的事务只有几毫秒，单行的拐点远在这台机器的其他瓶颈之后，压不出来。给它一个固定的 10ms 之后，拐点落在几十到几百单/秒，四个变体的差别都能看到。代价是下文的绝对数值由这 10ms 决定，可以带走的是各变体之间的相对关系和坏掉的方式。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 预占：单行与分桶两条路径、选桶与换桶 | [`ReservationService`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/reserve/ReservationService.java) |
| 拆桶、并桶 | [`InventoryBucketService`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/bucket/InventoryBucketService.java)、[`BucketAdminController`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/bucket/BucketAdminController.java) |
| 桶上的条件更新 | [`InventoryBucketMapper`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/bucket/InventoryBucketMapper.java) |
| 持锁时间模型（只在 demo profile 生效） | [`ReserveHold`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/reserve/ReserveHold.java)、[`DemoReserveHold`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/demo/DemoReserveHold.java) |
| mall-app 调预占：超时、舱壁、熔断 | [`InventoryReserveClient`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/place/InventoryReserveClient.java)、[`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml) |
| 库存服务的连接池 | [`inventory-service/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/resources/application.yml) |
| 压测场景与各变体参数 | [`HotStockSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/HotStockSimulation.java)、[`experiments/e-hot-stock/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/e-hot-stock) |

预占的两条路径在同一个方法里，模型加在扣完库存之后、事务提交之前：

```java
// ReservationService.reserve（节选），整个方法在一个事务里
int buckets = bucketCount(l.skuId());
if (buckets == 0) {
    reservationMapper.insert(r);
    if (inventoryMapper.reserve(l.skuId(), l.quantity()) == 0) {   // 单行：stock >= n 的条件更新
        throw insufficient(orderNo, l);
    }
} else {
    r.setBucketNo(reserveInBuckets(orderNo, l, buckets));         // 分桶：从 hash(order_no) % n 号桶开始试
    reservationMapper.insert(r);
}
hold.afterDeduct(); // 正式环境是空操作；实验里停 10ms
return ReserveResult.OK;
```

下文的分析会反复用到三个正式配置，实验里都没有改：

```yaml
# inventory-service：连接池 40 条，拿不到连接最多等 250ms
spring.datasource.hikari: {maximum-pool-size: 40, connection-timeout: 250}

# mall-app：调库存服务的读超时 500ms；同时最多 60 个预占调用，满了立即拒绝
spring.http.serviceclient.inventory-service: {connect-timeout: 200ms, read-timeout: 500ms}
resilience4j.bulkhead.instances.inventory-reserve: {max-concurrent-calls: 60, max-wait-duration: 0}
```

### 环境

压测工具、网关和三个服务跑在同一台 20 核的开发机上，MySQL、Redis、RocketMQ、Nacos 在这台机器上的一台 4 核 6GB 虚拟机里。有两点会影响数值：

- **MySQL 的落盘设置放宽了**：`innodb_flush_log_at_trx_commit=2`、`sync_binlog=0`。默认的每次提交都落盘，在每秒几百次提交时会把虚拟磁盘打停 1 到 9 秒，放宽之后才能稳定压测
- **仍有零星卡顿**：每轮 14 分钟里虚拟机还会停顿 0 到 3 次，多数不到 1 秒，个别到几秒，最长的一次 19 秒。停顿的那一级成功率会掉几个百分点，下表各档取多轮的中位数

## 三、结果

![下单到达速率逐级升高时每秒下单成功数](../assets/high-con/exp-hot-stock-throughput.svg)

每一级压 90 秒，表里是每秒下单成功数和成功率（单行 2 轮、4 个桶 4 轮、8 个桶 3 轮、16 个桶 4 轮的中位数）：

| 到达速率（单/秒） | 单行 | 4 个桶 | 8 个桶 | 16 个桶 |
|------|------|------|------|------|
| 50 | 50（100%） | 50（100%） | 50（100%） | 50（100%） |
| 100 | 25（25%） | 100（100%） | 99（100%） | 99（100%） |
| 150 | 14（10%） | 149（100%） | 149（100%） | 149（100%） |
| 200 | 12（6%） | 199（100%） | 199（100%） | 199（100%） |
| 250 | 11（5%） | 224（90%） | 249（100%） | 249（100%） |
| 300 | 11（4%） | 214（71%） | 287（96%） | 299（100%） |
| 350 | 11（3%） | 208（60%） | 271（78%） | 347（99%） |
| 400 | 11（3%） | 200（50%） | 276（69%） | 398（100%） |
| 450 | 10（2%） | 202（45%） | 283（63%） | 439（98%） |

| 变体 | 最后一个全部成功的档位 | 拐点之后每秒成功 | 拐点之后的失败 |
|------|------|------|------|
| 单行 | 50 单/秒 | 约 11 单 | 熔断打开，大部分请求直接 503 |
| 4 个桶 | 200 单/秒 | 200–225 单 | 超出的部分被舱壁拒绝（503） |
| 8 个桶 | 250 单/秒 | 270–285 单 | 同上 |
| 16 个桶 | 400 单/秒 | 450 单/秒时成功 97%–98% | 少量 503 |

三条假设里，第一条成立，后两条都不成立：桶数翻倍容量没有翻倍，单行过了拐点也没有停在容量上。

## 四、逐组分析

### 1、单行：过了拐点掉到容量的两成

50 单/秒时一切正常，预占接口在库存服务端平均 21ms（其中 10ms 是模型），P99 33ms。到 100 单/秒，每秒成功的只剩 23–26 单，再往上稳定在 11 单左右，比 50 单/秒时还少得多。

容量不够本身只会让超出的那部分失败。成功数掉到容量以下，是因为排队的请求在做无用功：

- **排队时间超过了调用方的超时**：库存服务的 40 条连接全部压在同一行上，一个在执行、39 个在等行锁。每个事务持锁约 14ms（10ms 模型加上提交），排在队尾要等 500ms 以上，而 mall-app 调预占的读超时正是 500ms
- **调用方放弃了，库存服务不知道**：超时的预占仍然会轮到、扣库存、持锁 10ms、提交，只是没有人要这个结果了
- **补偿也要抢同一把锁**：mall-app 对超时的订单再调一次 `release`，把刚扣的库存还回去，它同样排在这一行上。这一轮里 mall-app 记了 6319 次「释放预占失败，交给过期回查」
- **熔断打开**：预占的超时与慢调用超过了阈值，`inventory-reserve` 熔断器打开，之后每 5 秒放 20 个请求试探，其余直接返回 503

数据库侧的计数能对上：这一轮 InnoDB 记了 2.7 万次行锁等待，累计等了 6500 秒，平均每次 245ms；库存服务每秒有 3 到 4 次取连接超时。

熔断在这里起的是保护作用，它让 450 单/秒的到达量里只有二十来个真正打到库存服务。但每秒 11 单的成功数说明，**热点行过载之后靠熔断只能止损，恢复不了吞吐**，要么把到达量限在拐点以下，要么把这一行拆开。

### 2、4 个桶与 8 个桶：成功数停在平台上

4 个桶在 200 单/秒时全部成功，250 单/秒起成功数停在 200–225 单/秒；8 个桶在 250 单/秒时全部成功，350 单/秒起停在 270–285 单/秒。到达量再怎么加，成功数基本不动，多出来的请求被 mall-app 的舱壁立即拒绝，熔断器全程没有打开。

和单行相比，区别在于排在每一把锁后面的队伍短了。40 条连接分到 4 个桶，每个桶后面约 10 个事务，等锁的时间在 200ms 上下，加上等连接的时间，成功请求的 P50 约 230–260ms，都赶在 500ms 的读超时之前完成，没有白做的预占。

8 个桶在第 705 秒（400 单/秒那一级）的线程栈：

| 库存服务的线程在做什么 | 线程数 |
|------|------|
| 执行桶的 `UPDATE`，在等行锁 | 26 |
| 等连接池 | 26 |
| 执行 `release` 的更新（上一分钟的订单到期关单） | 6 |
| 预占事务的 `COMMIT`（持有桶锁） | 4 |
| 停在 10ms 的模型上（持有桶锁） | 3 |

40 条连接里真正在推进的只有七八个，和桶数一致；其余的都在等。

### 3、桶数翻倍，容量没有翻倍

| 变体 | 平台上每秒成功 | 平均到每个桶 | 每个桶处理一单的时间 |
|------|------|------|------|
| 4 个桶 | 约 221 单 | 55 单/秒 | 约 18ms |
| 8 个桶 | 约 280 单 | 35 单/秒 | 约 28ms |

桶多了一倍，每个桶的周转却慢了一半多。先排除选桶不均：8 个桶在 300 单/秒那一级的 70 秒里，各桶的预占记录数在 2538 到 2715 之间，是均匀的。

慢下来的是持锁期间的那几步。分桶路径上，桶的行锁从 `UPDATE` 拿到，要等后面的 `INSERT` 预占记录、10ms 模型和 `COMMIT` 都做完才放。上一节的线程栈里，7 个持有桶锁的事务有 4 个停在 `COMMIT`、3 个停在模型的 10ms 上，提交花的时间已经不比 10ms 短。

提交变慢是因为数据库更忙了：数据库所在的虚拟机在 4 个桶的平台上 CPU 是 69%，8 个桶时 76%。同一台数据库上单次查询随负载从 1.3ms 涨到 9ms 的过程，[连接池与实例数实验](./12_exp_pool_sizing) 里量得更直接。另一个来源是关单：一分钟前下的订单到期后，`release` 要回到同一个桶加库存，也占这把锁。实验没有把这两个来源拆开。

16 个桶在 450 单/秒时成功率 97%–98%，行锁已经不是主要矛盾，但库存服务的 40 条连接用到了 39 条，mall-app 的 20 条连接全部在用、还有 44 个线程在等。再加桶也不会更快，下一个瓶颈是连接池和数据库本身。[稳定性](/project/8_stability) 第八节的三轮压测走的是同一个顺序：第 1 轮单行锁排队，分桶之后第 2 轮就是库存服务取连接超时。

### 4、和「10 个桶约 6000 TPS」的关系

[稳定性](/project/8_stability) 第七节按「单行约 600 TPS，10 个桶上限约 6000 TPS」估算桶数，用的是线性关系。这次实验的绝对数值由 10ms 的模型决定，不能和 600 TPS 直接比；能比的是倍数：

| 桶数 | 最后一个全部成功的档位 | 相对单行 |
|------|------|------|
| 1（单行） | 50 单/秒 | 1 倍 |
| 4 | 200 单/秒 | 4 倍 |
| 8 | 250 单/秒 | 5 倍 |
| 16 | 400 单/秒 | 8 倍 |

4 个桶以内接近线性，往后每翻一倍只多出六成左右。阶梯每级 50 单/秒，拐点的位置只能精确到这个粒度，但趋势是清楚的：**线性估算只在数据库还有余量时成立**，桶数要按压测结果定，不能按乘法定。

## 五、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 热点行的到达量必须限在拐点以下，或者把行拆开 | 单行过了拐点，成功数从 50 单/秒掉到 11 单/秒 |
| 调用方的超时要大于「连接数 ÷ 桶数 × 单次持锁时间」，否则缩小库存服务的连接池 | 单行时 40 个事务排一把锁，队尾等 500ms 以上，超时的预占全是白做 |
| 舱壁满了立即拒绝，并且不计入熔断统计 | 分桶之后超出的请求被舱壁拒掉，成功数稳在平台上，熔断没有误开 |
| 持锁期间的语句越少越好 | 桶的周转时间从 18ms 涨到 28ms，慢在持锁期间的 `INSERT` 与 `COMMIT` |
| 桶数按压测定，线性估算要打折 | 4 个桶 4 倍，8 个桶 5 倍，16 个桶 8 倍 |
| 拆桶之后接着看连接池和数据库 | 16 个桶时库存服务 40 条连接用到 39 条 |

## 六、复现

```powershell
.\experiments\e-hot-stock\run.ps1 -Variant e0-single-row
.\experiments\e-hot-stock\run.ps1 -Variant e1-buckets-4
.\experiments\e-hot-stock\run.ps1 -Variant e2-buckets-8
.\experiments\e-hot-stock\run.ps1 -Variant e3-buckets-16
```

脚本会在压测前调 `/internal/inventory/buckets/{skuId}/split` 拆桶，压完等库存还清再并回单行。参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 10ms 的持锁时间是模型，结论是各变体的相对关系，不是库存服务的真实容量
- 压测工具、服务、数据库挤在一台机器上，数据库所在的虚拟机只有 4 核；桶数多了之后先到头的是这台虚拟机
- MySQL 放宽了落盘设置，每次提交都落盘时持锁时间会更长、拐点更靠前
- 没有人支付，所有订单 60 秒后都会关单并释放库存，释放的量和下单一样多；真实大促里大部分订单会支付，释放少得多

## 小结

- 单行库存 50 单/秒正常，100 单/秒时每秒只成功 23–26 单，之后稳定在 11 单：排队超过调用方超时，白做的预占和补偿把容量吃掉了
- 分桶之后过载的表现变成「成功数停在平台上」，多出来的请求被舱壁立即拒绝
- 4 个桶 4 倍、8 个桶 5 倍、16 个桶 8 倍，桶数翻倍容量不翻倍，慢在持锁期间的语句随数据库变忙而变慢
- 行锁拆开之后，下一个瓶颈是库存服务的连接池和数据库

## 参考资料

- InnoDB 行锁与锁等待：[MySQL 8.4 Reference Manual: InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[连接池与实例数实验](./12_exp_pool_sizing) —— 行锁拆开之后轮到连接池和数据库，池子加大、实例加倍各能换来多少吞吐。

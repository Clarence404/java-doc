---
description: 下单量短时升到 3 倍时关单消息的消费延迟对照、消费线程 2、4、8 个的积压与追平时间、消费能力的估算
---

# 异步削峰实验

> 前置阅读：[异步与削峰](./4_async_peak_shaving)、[异步化](/project/5_async)

mall-evolution 把关单后释放库存放到了消息队列之后。本篇让下单量短时升到平时的 3 倍，实测下单接口受不受影响，以及消费端 2、4、8 个线程时消息各晚多久、多久追平。

## 一、现象与假设

削峰的说法是「洪峰先落进队列，消费端按自己的速度慢慢处理」。这句话有两个没说出来的条件：消费端的速度得高于平时的流量，积压的那段时间业务得等得起。

| 假设 | 怎么验证 |
|------|---------|
| 异步之后，下单接口不受消费快慢影响 | 看高峰前、中、后下单的成功率与 P99 |
| 消费能力高于高峰流量时没有积压 | 8 个消费线程 |
| 消费能力介于平时与高峰之间时，高峰期积压，过后能追平 | 4 个消费线程 |
| 消费能力低于平时流量时，积压只增不减 | 2 个消费线程 |

## 二、实验设置

这次看的是下单之后的一条异步链路：订单 60 秒没支付，定时消息到期，mall-app 关单并发出 `order-cancelled`，库存服务的 `inventory-release-consumer` 消费它、释放预占的库存。实验里没有人支付，所以每一单 60 秒后都会走到这一步，下单的高峰会在 60 秒后原样变成关单消息的高峰。

| 项 | 取值 |
|----|------|
| 拓扑 | 网关 → mall-app → 库存服务、支付服务，各 1 个实例；RocketMQ 单节点 |
| 流量 | 平时 20 单/秒；第 90 秒起升到 60 单/秒，持续 60 秒后回到 20 单/秒；第 390 秒停止下单，再观察 4 分钟 |
| 关单 | 下单后 60 秒未支付即关单（正式环境是 15 分钟） |
| 消费能力模型 | `inventory-release-consumer` 处理每条消息前多停留 100ms |
| 变体 | 不加停留、8 个线程（对照）；加停留后 2、4、8 个线程 |
| 客户端 | 超时 3 秒，不重试 |

释放预占本身只要几毫秒，8 个线程每秒能处理上千条，这台机器上压不出积压。加上 100ms 的停留之后，每个线程每秒处理 9 条多，线程数直接决定消费能力。这是模型，对应的真实情况是消费逻辑里有一次慢的外部调用。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 下单时写定时消息（本地消息表） | [异步化](/project/5_async) 第五节；[`OrderTimeoutMessage`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/cancel/OrderTimeoutMessage.java) |
| 关单的消费组（mall-app，2 个线程） | [`OrderConsumersConfig`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/mq/OrderConsumersConfig.java) |
| 释放预占的消费组（库存服务，8 个线程） | [`InventoryConsumersConfig`](https://github.com/Clarence404/mall-evolution/blob/main/inventory-service/src/main/java/io/github/clarence404/mall/inventory/reserve/InventoryConsumersConfig.java) |
| 消费线程数 | [`ConsumerFactory`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/mq/ConsumerFactory.java)、[`RocketMqProperties`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/mq/RocketMqProperties.java) |
| 消费延迟指标 `mq.consume.delay` | [`ConsumeInstrumentation`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/mq/ConsumeInstrumentation.java) |
| 消费能力模型（只在 demo profile 生效） | [`ConsumeHold`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/mq/ConsumeHold.java)、[`DemoConsumeDelay`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/demo/DemoConsumeDelay.java) |
| 压测场景与各变体参数 | [`AsyncPeakSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/AsyncPeakSimulation.java)、[`experiments/g-async-peak/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/g-async-peak) |

消费线程数是 [异步化](/project/5_async) 第九节「消费线程数显式设置」定下来的，每个消费组单独一个线程池：

```yaml
# inventory-service/application.yml
mall:
  rocketmq:
    consumption-threads: 8   # 每个消费组的消费线程数（客户端不设时是 20）：2 个消费组 × 8 = 16，不超过连接池（40）的一半
```

消费延迟是为这次实验加的正式指标，所有消费组都有。它记的是一条消息处理完的时刻减去它产生的时刻，在 Broker 里排队、投递、处理三段都算在内：

```java
// ConsumeInstrumentation.wrap（节选）
return view -> {
    hold.beforeConsume(consumerGroup); // 正式环境是空操作；实验里停 100ms
    ConsumeResult result = ConsumeResult.FAILURE;
    try {
        result = listener.apply(view);
        return result;
    } finally {
        long delayMs = Math.max(0, clockMillis.getAsLong() - dueAtMillis(view));
        (result == ConsumeResult.SUCCESS ? success : failure).record(Duration.ofMillis(delayMs));
    }
};
```

环境与 [热点库存实验](./11_exp_hot_stock) 相同。

## 三、结果

![下单高峰过后释放预占的平均消费延迟](../assets/high-con/exp-async-peak-delay.svg)

下单接口在所有变体里都一样：平时与高峰期成功率都是 100%，P99 在 14–27ms 之间，看不出高峰。

关单消息在第 150–210 秒到达高峰（60 条/秒），释放预占这一侧：

| 变体 | 实测消费能力 | 高峰期消费速率 | 平均消费延迟：平时 / 最高 | 追平用时 | 轮数 |
|------|------|------|------|------|------|
| 不加停留，8 个线程 | 远高于 60 条/秒 | 60 条/秒 | 不到 0.1 秒 / 不到 0.1 秒 | 没有积压 | 2 |
| 停留 100ms，8 个线程 | 约 75 条/秒 | 60 条/秒 | 0.2 秒 / 0.4 秒 | 没有积压 | 2 |
| 停留 100ms，4 个线程 | 37 条/秒 | 37 条/秒 | 0.3 秒 / 约 28 秒 | 高峰结束后约 80 秒 | 2 |
| 停留 100ms，2 个线程 | 19 条/秒 | 19 条/秒 | 从第一条起就在涨 / 超过 190 秒 | 停止下单约 4 分钟后才消化完 | 2 |

四条假设都成立。下单接口确实不知道后面发生了什么，后面发生的事差别很大。

## 四、逐组分析

### 1、下单接口：与消费快慢无关

下单请求里同步做的只有预占库存、写订单和写本地消息表，关单与释放都在消息之后。2 个线程那一组的释放延迟到了 3 分钟以上，同一时刻下单的 P99 仍然是十几毫秒。

这是异步的收益，也是它的风险：**入口的指标全是绿的，积压只有在消费侧的指标上才看得见**。[异步化](/project/5_async) 第六节给消费延迟定的告警线是 5 分钟，2 个线程那一组的平均延迟在高峰过后涨到 2–3 分钟，还没碰到这条线，而在告警之前下单接口不会给出任何信号。

### 2、消费能力 = 线程数 ÷ 单条处理时间

| 线程数 | 按每条 107ms 估算 | 实测 |
|------|------|------|
| 2 | 18.7 条/秒 | 18.7 条/秒 |
| 4 | 37.4 条/秒 | 37.4 条/秒 |
| 8 | 74.8 条/秒 | 没有压到上限 |

107ms 是从 2 个线程的实测值反推出来的：100ms 的停留，加上释放预占和拉取消息的约 7ms。用它去算 4 个线程，和实测一致。消费线程在第 180 秒（关单高峰中间）的线程栈也对得上：2 个线程和 4 个线程的两组，所有消费线程都停在处理上，没有一个空闲；不加停留的对照组 8 个线程全部空闲。

这一组里消费能力只由线程数决定，是因为每条消息的时间几乎都花在等待上，库存服务的连接池最多同时用到 2 条，CPU 也闲着。消费逻辑如果是在等数据库，加线程会像 [连接池与实例数实验](./12_exp_pool_sizing) 那样把压力转给数据库，消费能力不会按线程数线性涨。

### 3、4 个线程：积压 80 秒追平

平时 20 条/秒，消费能力 37 条/秒，平均延迟 0.3 秒。关单高峰的 60 秒里每秒到达 60 条、消费 37 条，每秒多积压约 23 条：

| 量 | 估算 | 实测 |
|------|------|------|
| 高峰结束时的积压 | (60 − 37.4) × 60 ≈ 1360 条 | — |
| 最后一批高峰消息的延迟 | 1360 ÷ 37.4 ≈ 36 秒 | 最大 36.7 秒，30 秒窗口的平均最高 28 秒 |
| 追平用时 | 1360 ÷ (37.4 − 20) ≈ 78 秒 | 约 80 秒 |

估算和实测对得上。追平靠的是高峰过后的余量（37.4 − 20 = 17.4 条/秒），**余量越小追得越慢**：消费能力如果只有 25 条/秒，同样的高峰要追 7 分钟。

对业务来说，这 1360 条消息就是 1360 件已经关单、还没还回去的库存，最多晚了半分多钟才能重新卖。

### 4、2 个线程：从第一条消息起就在欠账

消费能力 18.7 条/秒，比平时的 20 条/秒还低一点。每秒只差 1.3 条，平时看上去「差不多够」，但积压从第一条消息起就没有停过：

| 压测开始后 | 平均消费延迟 |
|------|------|
| 第 120 秒（高峰前） | 5 秒 |
| 第 180 秒（关单高峰中） | 13 秒 |
| 第 240 秒 | 54 秒 |
| 第 300 秒 | 95 秒 |
| 第 360 秒 | 136 秒 |
| 第 600 秒（停止下单 3 分半之后） | 190 秒 |

高峰过去之后延迟还在涨，因为到达量回到 20 条/秒仍然高于消费能力，没有余量去消化高峰留下的积压。直到第 390 秒停止下单、第 450 秒最后一批关单消息发出，队列才开始真正变短，到观察结束时基本消化完。

真实系统不会停止下单。**消费能力低于平时流量的消费组，不存在「过了高峰就好了」**，它需要的是加线程、加实例或者把消费逻辑改快，等是等不回来的。

### 5、停留 100ms 的 8 个线程：有余量就没有事

消费能力约 75 条/秒，高于高峰的 60 条/秒。平均延迟平时 0.2 秒、高峰 0.4 秒，最大 0.7 秒，高峰一过就回到 0.2 秒。高峰期间 8 个线程基本都在忙，但没有积压。

和 4 个线程那组相比，线程数多一倍，换来的是高峰期平均延迟从 28 秒降到 0.4 秒。两组在平时的表现几乎一样（0.2 秒与 0.3 秒），差别只在高峰时才显出来。

## 五、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 消费能力按「线程数 ÷ 单条处理时间」估算，上线前和平时流量、高峰流量各比一次 | 由 2 个线程的实测值推 4 个线程，误差不到 1% |
| 消费能力必须高于平时流量，并留出追积压的余量 | 2 个线程只差 1.3 条/秒，延迟在 10 分钟里涨到 3 分钟以上 |
| 能接受的最大延迟决定消费能力，不是「能消费完就行」 | 4 个线程最终追平了，但高峰消息晚了 36 秒 |
| 监控看消费延迟或堆积量，不看入口接口 | 下单 P99 全程 14–27ms |
| 加消费线程之前先看单条消息的时间花在哪 | 这里花在等待上，加线程线性有效；花在数据库上就不是 |

## 六、复现

```powershell
.\experiments\g-async-peak\run.ps1 -Variant g0-baseline
.\experiments\g-async-peak\run.ps1 -Variant g1-slow-2
.\experiments\g-async-peak\run.ps1 -Variant g2-slow-4
.\experiments\g-async-peak\run.ps1 -Variant g3-slow-8
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 100ms 的停留是模型，线程在停留期间不占数据库连接也不占 CPU，所以消费能力和线程数严格成正比；真实的慢消费多半在等某个下游，加线程的效果要打折
- 高峰只有 60 秒、3 倍，积压最多一千多条，RocketMQ 本身毫无压力；这组实验没有测 Broker 的堆积能力
- 定时消息（`order-timeout`）的消费延迟在 1 秒以下的读数不可信（投递时刻只精确到秒），所以关单那个消费组只看了有没有积压，没有列延迟
- 平均延迟取自 Prometheus 里 30 秒窗口的均值，直方图的分位数在 2 分钟以上的桶太粗，没有采用
- 2 个线程那一组有一轮虚拟机卡顿了 6 秒，下单失败了一批，那一轮没有采用，另补了一轮

## 小结

- 下单接口在四组里没有差别，异步把消费侧的快慢和入口隔开了，问题也因此只在消费侧的指标上可见
- 消费能力等于线程数除以单条处理时间，2、4 个线程实测 18.7、37.4 条/秒，与估算一致
- 消费能力高于高峰（8 个线程）：延迟不到 1 秒；介于平时与高峰之间（4 个线程）：高峰消息最多晚 36 秒，80 秒追平；低于平时（2 个线程）：延迟一直涨到 3 分钟以上
- 追平靠的是高峰过后的余量，余量为负就永远追不平

## 参考资料

- RocketMQ 5 的消费者类型与消费并发：[Apache RocketMQ: PushConsumer](https://rocketmq.apache.org/docs/featureBehavior/06consumertype/)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[热点库存实验](./11_exp_hot_stock) —— 读和写的洪峰之后，看流量集中到同一行库存时单行与分桶各能扛多少。

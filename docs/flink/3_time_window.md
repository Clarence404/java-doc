---
description: 时间语义、WatermarkStrategy、空闲与对齐、迟到数据、窗口与窗口函数、Trigger、双流 Join
---

# 时间、水位线与窗口

> **本篇目标**：理解事件时间与水位线如何在乱序数据上给出正确结果，能为业务选择合适的乱序容忍度、空闲检测与迟到数据策略，掌握滚动 / 滑动 / 会话窗口与增量聚合的写法，并能用 Interval Join 关联两条流。
>
> **前置阅读**：[DataStream API](./2_datastream)

「统计每分钟的订单金额」这句话里的「每分钟」到底指什么？是订单**发生**的那一分钟，还是 Flink **收到**订单的那一分钟？网络抖动、App 离线补传、上游积压都会让二者相差几秒到几小时。只要结果需要和业务对账，答案就只能是前者——这就引出了事件时间和水位线。

---

## 一、时间语义

| 时间 | 定义 | 优点 | 缺点 | 适用 |
|------|------|------|------|------|
| 事件时间（Event Time） | 事件实际发生的时间，写在数据里 | 结果确定、可重放、与业务口径一致 | 需要水位线，有等待延迟 | 对账、报表、风控、计费等**绝大多数业务** |
| 处理时间（Processing Time） | 算子所在机器的当前时钟 | 简单、延迟最低 | 结果依赖处理速度，重放或积压时结果不同 | 监控类近似统计、对准确性不敏感的场景 |

关键区别在于**可重放性**：用事件时间，今天重跑上周的数据，结果和上周实时算出的一模一样；用处理时间，重跑时所有数据都挤在同一分钟里，结果完全不同。

> Flink 1.12 起默认就是事件时间语义，无需再调用 `setStreamTimeCharacteristic`。是否使用事件时间，取决于是否配置了 `WatermarkStrategy` 以及选用 `EventTime` 还是 `ProcessingTime` 窗口。

---

## 二、水位线（Watermark）

### 1、水位线是什么

水位线是混在数据流中的一种特殊记录，携带时间戳 `T`，含义是：**「事件时间 ≤ T 的数据应该都已经到了」**。下游算子据此判断某个窗口是否可以关闭计算、某个事件时间定时器是否可以触发。

![有界乱序 5s：水位线推进与 10s 滚动窗口触发](../assets/flink/flink-watermark.svg)

水位线本质上是在**延迟和完整性之间做权衡**：水位线推进得越慢（容忍乱序越大），结果越完整，但输出越晚；推进得越快，延迟低，但更多数据会被判为迟到。

### 2、WatermarkStrategy

```java
WatermarkStrategy<OrderEvent> strategy = WatermarkStrategy
        .<OrderEvent>forBoundedOutOfOrderness(Duration.ofSeconds(5))   // 容忍 5 秒乱序
        .withTimestampAssigner((event, recordTs) -> event.eventTime())  // 从数据中提取毫秒时间戳
        .withIdleness(Duration.ofMinutes(1));                           // 1 分钟无数据的分片视为空闲
```

| 内置策略 | 水位线计算 | 场景 |
|----------|-----------|------|
| `forBoundedOutOfOrderness(d)` | 已见最大时间戳 − d − 1ms | **最常用**，数据有一定乱序 |
| `forMonotonousTimestamps()` | 已见最大时间戳 − 1ms | 时间戳严格递增，如单分区按时间写入的日志 |
| `noWatermarks()` | 不产生 | 只用处理时间 |

水位线**周期性**生成：默认每 200 ms（`pipeline.auto-watermark-interval`）调用一次生成器，而不是每条数据都发一个水位线。

**乱序容忍度怎么定**：观察数据「事件时间与到达时间之差」的分布，取 P99 或 P999 作为初始值，再结合业务可接受的输出延迟调整。剩下的长尾交给迟到数据机制处理，而不是一味调大容忍度。

### 3、水位线在算子间的传播

- 一个算子有多个输入通道时（如 `keyBy` 之后、`union` 之后），它的当前水位线 = **所有输入通道水位线的最小值**。
- 这意味着**最慢的那个分区决定了整个作业的进度**：只要有一个 Kafka 分区没有数据，它的水位线就不前进，下游所有窗口都不会触发。

### 4、空闲检测（Idleness）

典型事故：作业并行度 8，topic 有 6 个分区，或者夜间某些分区没有数据——窗口结果迟迟不输出。原因就是空闲分区卡住了最小水位线。

`withIdleness(Duration)` 让一个分片在指定时间内没有数据时标记为空闲，下游计算最小值时暂时忽略它；有数据到来后自动恢复。注意：

- 空闲超时要明显大于正常的数据间隔，否则低流量分区会被频繁误判为空闲，其数据反而成为迟到数据。
- Flink 2.0 起，反压和水位线对齐造成的阻塞时间不再计入空闲超时，避免了「被反压的分区被误判为空闲」。

### 5、水位线对齐（Alignment）

另一类问题：从头回溯消费时，某些分区很快、某些分区很慢，快的分区产生的数据大量堆积在窗口状态中等待慢分区的水位线，状态暴涨。

```java
WatermarkStrategy.<OrderEvent>forBoundedOutOfOrderness(Duration.ofSeconds(5))
        .withTimestampAssigner((e, ts) -> e.eventTime())
        .withWatermarkAlignment("orders-group", Duration.ofSeconds(20), Duration.ofSeconds(1));
```

同一对齐组内的 Source 分片，水位线领先最慢者超过 20 秒时**暂停读取**，等慢的追上来。限制：**只对新 Source API 生效，且必须在 `fromSource` 时传入**，在 `assignTimestampsAndWatermarks` 中设置无效。

### 6、在哪里分配水位线

**优先在 Source 上分配**：`env.fromSource(source, strategy, name)`。KafkaSource 会**按分区**分别跟踪水位线再取最小值，一个子任务读多个分区时各分区的乱序不会相互叠加，同时也只有这种方式支持水位线对齐。在后续算子上用 `assignTimestampsAndWatermarks` 只是退而求其次的做法（例如数据要先解析才能拿到时间戳）。

---

## 三、迟到数据

水位线越过窗口结束时间后才到达的数据称为**迟到数据**，默认直接丢弃。Flink 提供三道防线：

| 防线 | 机制 | 代价 |
|------|------|------|
| 1. 水位线延迟 | `forBoundedOutOfOrderness` 的容忍度 | 所有窗口统一推迟输出 |
| 2. 允许迟到 `allowedLateness` | 窗口触发后状态再保留一段时间，迟到数据到达时**再次触发**并输出更新后的结果 | 窗口状态保留更久；下游会收到同一窗口的多次结果 |
| 3. 侧输出 `sideOutputLateData` | 超过允许迟到时间的数据输出到侧输出流 | 需要单独处理（补偿、对账、落库） |

```java
OutputTag<OrderEvent> lateTag = new OutputTag<OrderEvent>("late-orders") {};

SingleOutputStreamOperator<UserAmount> result = orders
        .keyBy(OrderEvent::userId)
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
        .allowedLateness(Duration.ofMinutes(5))
        .sideOutputLateData(lateTag)
        .aggregate(new SumAgg(), new AttachWindow());

DataStream<OrderEvent> late = result.getSideOutput(lateTag);
```

> **下游必须能处理更新**：开启 `allowedLateness` 后，同一个 `(userId, windowStart)` 可能输出多次，后一次结果覆盖前一次。写入 MySQL / Redis 要用以窗口为主键的 upsert，写 Kafka 时下游按 key 取最新值。如果下游是「追加写」的明细表，就会重复累加。

---

## 四、窗口类型

![三种时间窗口（横轴为事件时间）](../assets/flink/flink-window-types.svg)

| 窗口 | 分配器 | 特点 | 典型场景 |
|------|--------|------|----------|
| 滚动（Tumbling） | `TumblingEventTimeWindows.of(size)` | 固定大小、不重叠，每条数据属于一个窗口 | 每分钟 PV、每小时 GMV |
| 滑动（Sliding） | `SlidingEventTimeWindows.of(size, slide)` | 固定大小、按步长滑动，可重叠 | 「最近 10 分钟、每 1 分钟更新」的趋势监控 |
| 会话（Session） | `EventTimeSessionWindows.withGap(gap)` | 无固定大小，相邻数据间隔超过 gap 就切分 | 用户会话分析、一次连续操作 |
| 全局（Global） | `GlobalWindows.create()` | 同一 key 的所有数据一个窗口，默认触发器永不触发 | 必须配合自定义 Trigger，如计数窗口 `countWindow(n)` |

各窗口都有对应的 `ProcessingTime` 版本（`TumblingProcessingTimeWindows` 等）。需要注意的细节：

- **时区对齐**：窗口按 UTC 纪元对齐，中国（UTC+8）按自然日统计要设置偏移：`TumblingEventTimeWindows.of(Duration.ofDays(1), Duration.ofHours(-8))`，否则一天的窗口是从早上 8 点切分的。
- **滑动窗口的成本**：每条数据会被复制到 `size / slide` 个窗口中。窗口 1 小时、步长 1 秒意味着每条数据进入 3600 个窗口，状态和 CPU 都会爆炸。步长过小时改用「滚动小窗口 + 下游累加」或 `KeyedProcessFunction` 自行维护。
- **会话窗口会合并**：每条数据先生成一个独立窗口，再与重叠的窗口合并，所以会话窗口只能用支持 `merge` 的聚合（`AggregateFunction` 需正确实现 `merge`）。`withDynamicGap` 可以按数据动态决定 gap。
- **窗口是按 key 的**：`keyBy` 后的窗口每个 key 一份状态；`windowAll` 是非 keyed 窗口，并行度只能为 1，是单点瓶颈，尽量避免。

---

## 五、窗口函数

### 1、增量聚合 vs 全量聚合

| 函数 | 计算方式 | 窗口状态 | 能否拿到窗口元信息 |
|------|----------|----------|--------------------|
| `reduce(ReduceFunction)` | 增量：每来一条就与累加值合并 | 一个值 | 否 |
| `aggregate(AggregateFunction)` | 增量：输入、累加器、输出类型可不同 | 一个累加器 | 否 |
| `process(ProcessWindowFunction)` | 全量：窗口触发时拿到所有元素的 `Iterable` | **窗口内全部数据** | 是（窗口起止、水位线、状态） |
| `aggregate(agg, processWindowFunction)` | 增量聚合，触发时把结果交给 `ProcessWindowFunction` | 一个累加器 | 是 |

**生产首选第四种组合**：状态只保留一个累加器，又能拿到窗口起止时间写入结果，示例见 [DataStream API](./2_datastream) 的完整示例。只有在需要全部元素时（如求中位数、窗口内排序取 TopN）才用纯 `ProcessWindowFunction`，并注意窗口内数据量。

### 2、AggregateFunction 四个方法

```java
public class AvgAmount implements AggregateFunction<OrderEvent, long[], Double> {
    @Override public long[] createAccumulator() { return new long[2]; }            // [count, sum]
    @Override public long[] add(OrderEvent e, long[] acc) { acc[0]++; acc[1] += e.amount(); return acc; }
    @Override public Double getResult(long[] acc) { return acc[0] == 0 ? 0.0 : (double) acc[1] / acc[0]; }
    @Override public long[] merge(long[] a, long[] b) { a[0] += b[0]; a[1] += b[1]; return a; }   // 会话窗口合并时调用
}
```

---

## 六、Trigger 与 Evictor

**Trigger** 决定窗口何时计算、何时清理。每个窗口分配器都有默认 Trigger：事件时间窗口用 `EventTimeTrigger`（水位线越过窗口结束时触发），全局窗口用永不触发的 `NeverTrigger`。

最常见的自定义需求是**提前输出**：按天统计 GMV，但大屏要求每分钟刷新一次当日累计值。

```java
orders.keyBy(OrderEvent::userId)
      .window(TumblingEventTimeWindows.of(Duration.ofDays(1), Duration.ofHours(-8)))
      .trigger(ContinuousEventTimeTrigger.of(Duration.ofMinutes(1)))   // 每推进 1 分钟事件时间输出一次
      .aggregate(new SumAgg(), new AttachWindow());
```

**Evictor** 在窗口函数执行前后移除部分元素，内置 `CountEvictor`、`DeltaEvictor`、`TimeEvictor`。使用 Evictor 会让窗口**无法增量聚合**（必须保留全部元素），代价很高，实践中很少使用。

> 复杂的触发与清理逻辑，与其组合 Trigger + Evictor，不如直接用 `KeyedProcessFunction` + 状态 + 定时器实现，代码更直观、状态更可控。按天累计这类需求，在 Flink SQL 中可以直接用 `CUMULATE` 窗口表达，见 [Flink SQL 与 Table API](./5_sql)。

---

## 七、双流 Join

### 1、Window Join

两条流按 key 进入同一个窗口，窗口触发时对两边元素做笛卡尔积配对，**内连接语义**：

```java
public record PaymentEvent(String orderId, long amount, long payTime) {}

DataStream<String> joined = orders.join(payments)
        .where(OrderEvent::orderId)
        .equalTo(PaymentEvent::orderId)
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(5)))
        .apply((order, pay) -> order.orderId() + "," + pay.payTime(), Types.STRING);
```

问题是**窗口边界会切断关联**：订单在 4:59 创建、在 5:01 支付，就会落到两个窗口而关联不上。

### 2、Interval Join（更常用）

以一侧事件为基准，关联另一侧在时间区间内的数据，**没有窗口边界问题**：

```java
// 支付时间在下单后 0 ~ 15 分钟内
DataStream<String> paid = orders.keyBy(OrderEvent::orderId)
        .intervalJoin(payments.keyBy(PaymentEvent::orderId))
        .between(Duration.ZERO, Duration.ofMinutes(15))
        .process(new ProcessJoinFunction<OrderEvent, PaymentEvent, String>() {
            @Override
            public void processElement(OrderEvent order, PaymentEvent pay, Context ctx, Collector<String> out) {
                out.collect(order.orderId() + " paid in " + (pay.payTime() - order.eventTime()) + "ms");
            }
        });
```

| 要点 | 说明 |
|------|------|
| 时间语义 | 只支持事件时间 |
| 连接类型 | 只支持内连接；边界默认闭区间，可用 `lowerBoundExclusive()` / `upperBoundExclusive()` 调整 |
| 状态 | 两侧数据都会缓存，直到水位线超过可能匹配的区间才清理；**区间越大状态越大** |
| 外连接 | DataStream 没有直接的 Interval 外连接，「下单 15 分钟未支付」这类需求用 `connect` + `KeyedCoProcessFunction` + 定时器实现，或用 Flink SQL 的 Interval Join |

### 3、如何选择

- 两侧事件有明确的先后与时间区间（下单 → 支付、曝光 → 点击）：**Interval Join**。
- 需要按固定周期对齐两侧数据：Window Join，或 `coGroup`（能拿到两侧各自的元素列表，可实现外连接）。
- 一侧是缓慢变化的维表：不要用双流 Join，用 [DataStream API](./2_datastream) 中的异步 I/O，或 Broadcast State。
- 复杂的多流关联、需要 Left Join：优先考虑 Flink SQL，见 [Flink SQL 与 Table API](./5_sql)。

---

## 小结

- 业务计算默认用事件时间：结果确定、可重放；处理时间只适合近似监控
- 水位线 T 表示「事件时间 ≤ T 的数据都到了」，是延迟与完整性的权衡；有界乱序策略的水位线 = 最大时间戳 − 容忍度 − 1ms，默认每 200 ms 生成一次
- 多输入算子取所有输入水位线的最小值，空闲分区会卡住整个作业，用 `withIdleness` 解决；回溯时快慢分区差距大用水位线对齐
- 优先在 `fromSource` 上分配水位线，以获得按分区跟踪与对齐能力
- 迟到数据三道防线：乱序容忍度 → `allowedLateness` 再次触发 → 侧输出兜底；开启允许迟到后下游必须按窗口 upsert
- 滚动、滑动、会话、全局四类窗口；按自然日统计设置 −8 小时偏移；滑动步长过小会让状态爆炸；`windowAll` 并行度为 1
- 窗口函数首选「`AggregateFunction` 增量聚合 + `ProcessWindowFunction` 补窗口信息」；Evictor 会让增量聚合失效
- 双流关联优先 Interval Join，注意区间大小决定状态大小；外连接用 `KeyedCoProcessFunction` 或 Flink SQL

## 参考资料

- 时间概念：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/concepts/time/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/concepts/time/)
- 生成水位线：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/event-time/generating_watermarks/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/event-time/generating_watermarks/)
- 窗口：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/windows/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/windows/)
- 双流 Join：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/joining/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/joining/)

> 下一篇：[状态与容错](./4_state_checkpoint) —— 状态如何存储、Checkpoint 如何做出一致性快照，以及怎样实现端到端精确一次。

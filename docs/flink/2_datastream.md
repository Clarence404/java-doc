---
description: Source API、转换算子、ProcessFunction、定时器、侧输出、分区、异步 I/O、Sink V2、类型
---

# DataStream API

> 前置阅读：[Flink 概览](./1_basics)

DataStream 作业的骨架固定为环境、Source、转换、Sink 和 `execute()`，算子代码会被序列化发到 TaskManager 执行。本篇讲 KafkaSource、ProcessFunction 与定时器、异步 I/O、精确一次 KafkaSink 与常见坑，基线为 Flink 2.2。

---

## 一、执行环境

算子函数被序列化后在远端执行是很多坑的根源；常见坑包括类型推断、Kryo 回退等。

![典型 DataStream 作业拓扑](../assets/flink/flink-datastream-pipeline.svg)

```java
// 本地 IDE 运行时自动创建 MiniCluster；提交到集群时连接集群
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
```

需要在代码里设置引擎级参数时，传入 `Configuration`（Flink 2.x 推荐方式，很多旧的 `ExecutionConfig` setter 已被删除）：

```java
Configuration conf = new Configuration();
conf.set(RestartStrategyOptions.RESTART_STRATEGY, "exponential-delay");
conf.set(PipelineOptions.GENERIC_TYPES, false);   // 禁止 Kryo 回退，见第八节
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment(conf);
env.setParallelism(4);
env.enableCheckpointing(60_000);
```

> **优先级**：代码里的配置 > 提交命令行参数 > 集群 `config.yaml`。生产上建议并行度、Checkpoint 间隔、状态后端等运维参数放在部署配置里（便于不改代码调整），业务相关的才写在代码中。

---

## 二、Source：新 Source API 与 KafkaSource

### 1、新 Source API（FLIP-27）

Flink 2.0 删除了旧的 `SourceFunction`，所有连接器统一使用新 Source API。它把 Source 拆成两部分：

| 组件 | 运行位置 | 职责 |
|------|----------|------|
| SplitEnumerator | JobManager | 发现分片（Kafka 分区、文件块），分配给读取者，处理动态新增分区 |
| SourceReader | TaskManager | 读取被分配的分片，产出记录与水位线，在 Checkpoint 时记录读取位置 |

好处是：分片发现集中在一处、流批统一（同一个 Source 可以是有界或无界）、支持按分片生成水位线和水位线对齐。

### 2、KafkaSource

```java
KafkaSource<String> source = KafkaSource.<String>builder()
        .setBootstrapServers("kafka-1:9092,kafka-2:9092")
        .setTopics("orders")
        .setGroupId("flink-user-amount")
        .setStartingOffsets(OffsetsInitializer.earliest())
        .setValueOnlyDeserializer(new SimpleStringSchema())
        .setProperty("partition.discovery.interval.ms", "60000")   // 动态发现新分区
        .build();

DataStream<String> raw = env.fromSource(source, WatermarkStrategy.noWatermarks(), "kafka-orders");
```

需要理解的几个要点：

- **位点以 Checkpoint 为准**：作业从 Checkpoint / Savepoint 恢复时，读取位置来自状态，`setStartingOffsets` 只在**首次启动**生效。
- **提交回 Kafka 的 offset 只用于监控**：默认在 Checkpoint 完成后把 offset 提交到消费组，方便用 Kafka 工具看消费延迟；它**不参与容错**，所以消费组 lag 偶尔「倒退」不代表丢数据。
- **并行度不要超过分区数**：多出来的 SourceReader 拿不到分片会空闲，空闲 Reader 不产生水位线会卡住下游窗口（解法见[时间、水位线与窗口](./3_time_window)的 idleness）。
- 有界读取（补数、回溯）用 `.setBounded(OffsetsInitializer.timestamp(...))`，读到指定位置后作业自然结束。

Kafka 本身的分区、消费组与事务机制见 [Kafka](/messaging/2_kafka)。

---

## 三、转换算子

| 算子 | 输入 → 输出 | 说明 |
|------|-------------|------|
| `map` | 1 → 1 | 字段转换 |
| `flatMap` | 1 → 0..N | 拆分、过滤与转换合一 |
| `filter` | 1 → 0/1 | 过滤 |
| `keyBy` | DataStream → KeyedStream | 按 key 哈希重分区，之后才能用 Keyed State、定时器和 keyed 窗口 |
| `reduce` / `sum` / `max` | KeyedStream → DataStream | 滚动聚合，**每来一条输出一次当前累计值** |
| `window` + 窗口函数 | KeyedStream → DataStream | 按窗口聚合，窗口结束才输出 |
| `process` | 任意 | 最底层，可访问状态、定时器、侧输出 |
| `union` / `connect` | 多流合一 | `union` 要求类型相同；`connect` 允许不同类型，配合 `CoProcessFunction` |

使用 `keyBy` 时有两个常见坑：

1. **key 必须有稳定的 `hashCode()`**：不能用数组、枚举（枚举 `hashCode` 每个 JVM 不同）作为 key，否则同一个 key 会被发到不同的子任务。用 `String`、`Long` 或 record 最稳妥。
2. **数据倾斜**：热点 key 全部落到一个子任务上，该子任务反压拖慢整个作业。常见解法是「两阶段聚合」：先 `keyBy(key + 随机后缀)` 局部聚合，再 `keyBy(key)` 合并。

滚动聚合（不开窗的 `reduce`）的状态会**永久保留**每个 key 的累计值，key 无限增长时必须配合状态 TTL，见[状态与容错](./4_state_checkpoint)。

---

## 四、ProcessFunction 与定时器

`ProcessFunction` 家族是 DataStream 的「瑞士军刀」：能拿到每条记录的时间戳、注册定时器、读写状态、输出到侧输出。最常用的是 `KeyedProcessFunction`。

### 1、示例：订单超时未支付告警

需求：收到「订单创建」事件后 15 分钟内没有收到「支付」事件，就输出告警。这是「定时器 + 状态」的典型用法，用窗口很难表达。

```java
public record OrderEvent(String orderId, String userId, String type, long amount, long eventTime) {}

public class OrderTimeoutFunction extends KeyedProcessFunction<String, OrderEvent, String> {

    private static final long TIMEOUT_MS = Duration.ofMinutes(15).toMillis();
    private transient ValueState<Long> timerState;

    @Override
    public void open(OpenContext openContext) {
        timerState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("timeout-timer", Types.LONG));
    }

    @Override
    public void processElement(OrderEvent e, Context ctx, Collector<String> out) throws Exception {
        if ("CREATED".equals(e.type())) {
            long fireAt = e.eventTime() + TIMEOUT_MS;
            ctx.timerService().registerEventTimeTimer(fireAt);
            timerState.update(fireAt);
        } else if ("PAID".equals(e.type())) {
            Long fireAt = timerState.value();
            if (fireAt != null) {
                ctx.timerService().deleteEventTimeTimer(fireAt);   // 已支付，取消定时器
            }
            timerState.clear();
        }
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<String> out) throws Exception {
        out.collect("订单超时未支付: " + ctx.getCurrentKey());
        timerState.clear();
    }
}

// 使用：orders.keyBy(OrderEvent::orderId).process(new OrderTimeoutFunction())
```

### 2、定时器的语义

| 要点 | 说明 |
|------|------|
| 作用域 | 定时器按 **key + 时间戳** 去重，同一 key 同一时刻注册多次只触发一次 |
| 事件时间定时器 | 水位线越过时间戳时触发；水位线不前进就永远不触发 |
| 处理时间定时器 | 机器时钟到点触发 |
| 容错 | 定时器保存在状态中，随 Checkpoint 持久化，恢复后继续有效 |
| 线程安全 | `onTimer` 与 `processElement` 不会并发执行，无需加锁 |

> **坑**：每个 key 注册大量定时器会撑大状态（RocksDB 中定时器也存储在状态里）。可以把时间戳按秒或分钟取整后再注册，让同一窗口内的定时器合并。

---

## 五、侧输出（Side Output）

一个算子需要输出多种结果时（正常数据、脏数据、迟到数据、告警），用侧输出代替 `split`（早已删除）或者多次 `filter`：

```java
static final OutputTag<String> DIRTY = new OutputTag<String>("dirty") {};   // 匿名子类，保留泛型信息

SingleOutputStreamOperator<OrderEvent> parsed = raw.process(new ProcessFunction<String, OrderEvent>() {
    private transient ObjectMapper mapper;

    @Override
    public void open(OpenContext openContext) {
        mapper = new ObjectMapper();      // 不可序列化的对象在 open 中创建，并声明 transient
    }

    @Override
    public void processElement(String value, Context ctx, Collector<OrderEvent> out) {
        try {
            out.collect(mapper.readValue(value, OrderEvent.class));
        } catch (Exception ex) {
            ctx.output(DIRTY, value);     // 脏数据走侧输出，不抛异常
        }
    }
});

DataStream<String> dirty = parsed.getSideOutput(DIRTY);
```

**解析失败绝不要抛异常**：抛出异常会触发作业重启，重启后从 Checkpoint 重放又会遇到同一条脏数据，形成无限重启循环（俗称「毒丸消息」）。正确做法是侧输出到死信 topic，加监控告警后人工处理。

---

## 六、分区策略

| 方法 | 分发方式 | 使用场景 |
|------|----------|----------|
| `keyBy` | 按 key 哈希到 Key Group，再映射到子任务 | 需要按 key 聚合、使用 Keyed State |
| `rebalance` | 全局轮询 | 上游分区数据不均（如 Kafka 分区倾斜），**并行度不同时的默认策略** |
| `rescale` | 只在本地相邻的子任务间轮询 | 并行度成倍数关系，想均衡又不想全连接网络传输 |
| `shuffle` | 随机 | 很少用 |
| `broadcast` | 每条发给所有下游子任务 | 小数据量的配置、规则流（配合 Broadcast State） |
| `forward` | 一对一 | **并行度相同时的默认策略**，可形成算子链 |
| `global` | 全部发给第一个子任务 | 全局排序、全局 TopN 的最后一步，单点瓶颈 |
| `partitionCustom` | 自定义 `Partitioner` | 特殊路由 |

经验：Source 后面接一个 `rebalance()` 可以缓解 Kafka 分区倾斜带来的负载不均，但会断开算子链、增加一次序列化与网络传输，需要权衡。

---

## 七、异步 I/O：维表关联

实时流常需要用订单里的 `userId` 去 Redis / MySQL / HTTP 服务查用户等级等维度信息。在 `map` 里同步调用的问题是：**每条记录都要等一次网络往返**，单个子任务吞吐被网络延迟锁死（10 ms 延迟 → 每秒 100 条）。

异步 I/O 让一个子任务同时挂起多个请求，吞吐近似提升到「容量 / 延迟」：

```java
public record EnrichedOrder(OrderEvent order, String userLevel) {}

public class UserLevelLookup extends RichAsyncFunction<OrderEvent, EnrichedOrder> {

    private transient HttpClient client;

    @Override
    public void open(OpenContext openContext) {
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
    }

    @Override
    public void asyncInvoke(OrderEvent order, ResultFuture<EnrichedOrder> resultFuture) {
        HttpRequest req = HttpRequest.newBuilder(
                URI.create("http://user-service/users/" + order.userId() + "/level")).build();
        client.sendAsync(req, HttpResponse.BodyHandlers.ofString())
              .whenComplete((resp, err) -> {
                  String level = (err == null && resp.statusCode() == 200) ? resp.body() : "UNKNOWN";
                  resultFuture.complete(List.of(new EnrichedOrder(order, level)));   // 降级而非失败
              });
    }

    @Override
    public void timeout(OrderEvent order, ResultFuture<EnrichedOrder> resultFuture) {
        resultFuture.complete(List.of(new EnrichedOrder(order, "UNKNOWN")));   // 默认实现是抛异常导致重启
    }
}

DataStream<EnrichedOrder> enriched = AsyncDataStream.unorderedWait(
        parsed, new UserLevelLookup(), 1000, TimeUnit.MILLISECONDS, 100);   // 超时 1s，最多 100 个在途请求
```

| 要点 | 说明 |
|------|------|
| 必须用真正的异步客户端 | 在 `asyncInvoke` 里调用阻塞 API 等于没用异步，还会卡住算子线程；没有异步客户端时用独立线程池包装，并控制线程数 |
| `unorderedWait` vs `orderedWait` | 无序模式结果先完成先输出，延迟低；有序模式保持输入顺序，有额外缓冲开销。事件时间下，无序模式也不会跨越水位线乱序 |
| `capacity` | 在途请求上限，满了会反压上游，也保护了下游服务 |
| `timeout()` | 默认超时会抛异常导致作业重启，生产上一定要覆盖为降级逻辑 |
| 重试 | `AsyncDataStream.unorderedWaitWithRetry` 配合 `AsyncRetryStrategies` 可声明式重试 |
| 缓存 | 维表变化不频繁时，在 Function 内加一层本地缓存（如 Caffeine）可大幅减少请求 |

> 维表关联在 Flink SQL 里有更简洁的 Lookup Join 写法，见 [Flink SQL 与 Table API](./5_sql)。

---

## 八、Sink：Sink V2 与 KafkaSink

### 1、Sink V2 的结构

Flink 2.0 删除了 `SinkFunction` 与 Sink V1，统一使用 `org.apache.flink.api.connector.sink2.Sink`：

| 组件 | 职责 |
|------|------|
| `SinkWriter` | 每个子任务一个，接收记录、缓冲、在 Checkpoint 前 `flush` |
| `Committer`（可选，实现 `SupportsCommitter`） | Checkpoint 完成后提交「预提交」的数据，实现两阶段提交 |
| `SupportsWriterState`（可选） | Writer 自身有状态需要随 Checkpoint 保存时实现 |

不需要事务的简单 Sink 只需实现 `createWriter`：

```java
public class LoggingSink implements Sink<String> {
    @Override
    public SinkWriter<String> createWriter(WriterInitContext context) {
        return new SinkWriter<>() {
            private final List<String> buffer = new ArrayList<>();

            @Override
            public void write(String element, Context ctx) {
                buffer.add(element);
            }

            @Override
            public void flush(boolean endOfInput) {   // Checkpoint 前调用：刷出缓冲，保证至少一次
                buffer.forEach(System.out::println);
                buffer.clear();
            }

            @Override
            public void close() {}
        };
    }
}
```

**`flush` 是至少一次的关键**：Checkpoint 完成意味着「之前的数据都已处理」，如果数据还躺在内存缓冲里没写出去，恢复后这部分就丢了。

### 2、KafkaSink

```java
KafkaSink<String> sink = KafkaSink.<String>builder()
        .setBootstrapServers("kafka-1:9092,kafka-2:9092")
        .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                .setTopic("user-amount-1m")
                .setValueSerializationSchema(new SimpleStringSchema())
                .build())
        .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
        .setTransactionalIdPrefix("user-amount-job")          // 精确一次时必填，同一 Kafka 集群内各应用唯一
        .setProperty("transaction.timeout.ms", "900000")
        .build();
```

| 投递保证 | 机制 | 下游可见时机 |
|----------|------|--------------|
| `NONE` | 不做保证 | 立即 |
| `AT_LEAST_ONCE` | Checkpoint 时 flush 并等待所有 ack | 立即，故障恢复后可能重复 |
| `EXACTLY_ONCE` | Kafka 事务，Checkpoint 完成后提交 | **Checkpoint 完成后**，且下游必须设置 `isolation.level=read_committed` |

精确一次模式的事务超时、Checkpoint 间隔对延迟的影响，见[状态与容错](./4_state_checkpoint)的端到端精确一次一节。

---

## 九、序列化与类型信息的坑

Flink 在算子间传输、保存状态时都要序列化数据，它会在作业构建时**静态分析**每个算子的输入输出类型，选择对应的序列化器：

| 类型 | 序列化器 | 性能 |
|------|----------|------|
| 基本类型、`String`、数组、Tuple | 内置专用序列化器 | 最好 |
| POJO / Java record | `PojoSerializer`，按字段序列化，**支持状态 Schema 演进**（增删字段） | 好 |
| 其他（无法识别的类、接口、含无法分析字段的类） | 回退到 **Kryo** 通用序列化 | 差，且**不支持 Schema 演进** |

POJO 规则：类是 `public` 且独立（非非静态内部类）、有 public 无参构造器、所有非 static 非 transient 字段要么 public 非 final，要么有符合命名的 getter / setter。**Java record 从 Flink 1.19 起也被识别为 POJO**，可以放心用 record 做事件类型。

常见坑：

1. **Lambda 泛型擦除**：`flatMap(e -> ...)`、返回 `Tuple2` 等泛型类型的 Lambda，Flink 推断不出输出类型会报 `InvalidTypesException`。用 `.returns(Types.TUPLE(Types.STRING, Types.LONG))` 或 `.returns(new TypeHint<...>(){})` 显式声明，或改用匿名类 / 具名类。
2. **静默回退到 Kryo**：字段类型是接口（如 `List<Item>` 以外的自定义接口）、缺少无参构造器，都会让整个类回退到 Kryo。日志中出现 `is treated as a generic type` 的提示要重视。建议生产作业设置 `pipeline.generic-types: false`，一旦有类型要走 Kryo 就直接报错，把问题提前到开发期。
3. **状态类型变更**：Kryo 序列化的状态类改了字段，Savepoint 恢复会失败；POJO / record 支持增删字段，但**不支持修改字段类型**。
4. **算子函数被序列化**：Function 对象会被 Java 序列化发到 TaskManager。成员变量里的数据库连接、`ObjectMapper`、HTTP 客户端等要声明为 `transient` 并在 `open()` 里创建，否则报 `NotSerializableException`；匿名内部类会隐式持有外部类引用，外部类不可序列化时同样报错。

Java 序列化机制本身见 [序列化](/java/19_topic_serialization)。

---

## 十、完整示例：每用户每分钟下单金额

需求：从 Kafka `orders` 读取 JSON 订单，脏数据写入死信 topic；按用户统计每分钟（事件时间）下单笔数与金额，精确一次写入 `user-amount-1m`。

```java
package com.example.flink;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.streaming.api.functions.windowing.ProcessWindowFunction;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.time.Duration;

public class UserAmountJob {

    public record OrderEvent(String orderId, String userId, String type, long amount, long eventTime) {}
    public record Acc(long count, long sum) {}
    public record UserAmount(String userId, long windowStart, long windowEnd, long orderCount, long totalAmount) {}

    static final OutputTag<String> DIRTY = new OutputTag<String>("dirty") {};
    static final String BROKERS = "kafka-1:9092,kafka-2:9092";

    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.enableCheckpointing(60_000);   // 精确一次 Sink 依赖 Checkpoint

        KafkaSource<String> source = KafkaSource.<String>builder()
                .setBootstrapServers(BROKERS)
                .setTopics("orders")
                .setGroupId("flink-user-amount")
                .setStartingOffsets(OffsetsInitializer.earliest())
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();

        // 1. 读取并解析，脏数据走侧输出
        SingleOutputStreamOperator<OrderEvent> orders = env
                .fromSource(source, WatermarkStrategy.noWatermarks(), "kafka-orders")
                .process(new ParseFunction()).name("parse").uid("parse");

        // 2. 分配事件时间与水位线：允许 5 秒乱序，分区 1 分钟无数据视为空闲
        DataStream<OrderEvent> withWm = orders.assignTimestampsAndWatermarks(
                WatermarkStrategy.<OrderEvent>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                        .withTimestampAssigner((e, ts) -> e.eventTime())
                        .withIdleness(Duration.ofMinutes(1)));

        // 3. 按用户开 1 分钟滚动窗口，增量聚合 + 补充窗口信息
        DataStream<String> result = withWm
                .filter(e -> "CREATED".equals(e.type()))
                .keyBy(OrderEvent::userId)
                .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
                .aggregate(new SumAgg(), new AttachWindow())
                .name("user-amount-1m").uid("user-amount-1m")
                .map(UserAmountJob::toJson);

        // 4. 精确一次写出结果；脏数据至少一次写入死信 topic
        result.sinkTo(kafkaSink("user-amount-1m", DeliveryGuarantee.EXACTLY_ONCE)).uid("sink-result");
        orders.getSideOutput(DIRTY)
              .sinkTo(kafkaSink("orders-dlq", DeliveryGuarantee.AT_LEAST_ONCE)).uid("sink-dlq");

        env.execute("user-amount-1m");
    }

    static class ParseFunction extends ProcessFunction<String, OrderEvent> {
        private transient ObjectMapper mapper;

        @Override
        public void open(OpenContext openContext) {
            mapper = new ObjectMapper();
        }

        @Override
        public void processElement(String value, Context ctx, Collector<OrderEvent> out) {
            try {
                out.collect(mapper.readValue(value, OrderEvent.class));
            } catch (Exception ex) {
                ctx.output(DIRTY, value);
            }
        }
    }

    /** 增量聚合：窗口内只保存一个累加器，而不是全部订单 */
    static class SumAgg implements AggregateFunction<OrderEvent, Acc, Acc> {
        @Override public Acc createAccumulator() { return new Acc(0, 0); }
        @Override public Acc add(OrderEvent e, Acc acc) { return new Acc(acc.count() + 1, acc.sum() + e.amount()); }
        @Override public Acc getResult(Acc acc) { return acc; }
        @Override public Acc merge(Acc a, Acc b) { return new Acc(a.count() + b.count(), a.sum() + b.sum()); }
    }

    /** 窗口触发时拿到聚合结果与窗口边界 */
    static class AttachWindow extends ProcessWindowFunction<Acc, UserAmount, String, TimeWindow> {
        @Override
        public void process(String userId, Context ctx, Iterable<Acc> elements, Collector<UserAmount> out) {
            Acc acc = elements.iterator().next();   // 与增量聚合组合时只有一个元素
            out.collect(new UserAmount(userId, ctx.window().getStart(), ctx.window().getEnd(),
                    acc.count(), acc.sum()));
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    static String toJson(UserAmount r) throws Exception {
        return JSON.writeValueAsString(r);
    }

    static KafkaSink<String> kafkaSink(String topic, DeliveryGuarantee guarantee) {
        var builder = KafkaSink.<String>builder()
                .setBootstrapServers(BROKERS)
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic(topic)
                        .setValueSerializationSchema(new SimpleStringSchema())
                        .build())
                .setDeliveryGuarantee(guarantee);
        if (guarantee == DeliveryGuarantee.EXACTLY_ONCE) {
            builder.setTransactionalIdPrefix("user-amount-job-" + topic)
                   .setProperty("transaction.timeout.ms", "900000");
        }
        return builder.build();
    }
}
```

几个设计取舍：

- **水位线在解析后分配**：因为 Source 输出的是原始字符串，拿不到事件时间。代价是失去 KafkaSource 的「按分区生成水位线」能力——一个子任务读多个分区时，各分区的乱序会叠加。对乱序敏感时，可以写一个容错的 `DeserializationSchema` 直接产出 `OrderEvent`（解析失败返回 `null` 即跳过，并记录指标），然后在 `fromSource` 时传入水位线策略。
- **`toJson` 用静态 `ObjectMapper`**：`ObjectMapper` 线程安全，`map` 中的方法引用不捕获外部对象，静态字段在每个 TaskManager 的类加载时各自初始化，不涉及序列化。
- **每个有状态算子与 Sink 都设置了 `uid`**：后续调整拓扑仍可从 Savepoint 恢复。
- **依赖**：`flink-streaming-java`、`flink-clients`（provided），`flink-connector-kafka:5.0.0-2.2`、`jackson-databind`（打进 fat jar）。

---

## 小结

- 作业骨架：环境 → Source → 转换 → Sink → `execute()`；Function 会被序列化发往 TaskManager，不可序列化的资源声明 `transient` 并在 `open(OpenContext)` 中创建
- Flink 2.x 只有新 Source API 与 Sink V2；KafkaSource 的位点以 Checkpoint 为准，提交到 Kafka 的 offset 只用于监控
- `keyBy` 的 key 需要稳定的 `hashCode`；不开窗的滚动聚合状态永久增长，要配 TTL；热点 key 用两阶段聚合
- `KeyedProcessFunction` + 定时器能表达超时、延迟触发等窗口难以表达的逻辑；定时器按 key + 时间去重，随 Checkpoint 持久化
- 脏数据走侧输出到死信 topic，绝不能抛异常，否则陷入重启循环
- 维表关联用异步 I/O：必须用真正的异步客户端、覆盖 `timeout()` 降级、用 `capacity` 控制并发，并加本地缓存
- 精确一次 KafkaSink 要设置 `transactionalIdPrefix` 与事务超时，下游读 `read_committed`，数据在 Checkpoint 完成后才可见
- 用 POJO / record 做数据类型，设置 `pipeline.generic-types: false` 杜绝 Kryo 回退；Lambda 泛型用 `.returns(...)` 声明

## 参考资料

- DataStream API 概览：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/overview/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/overview/)
- Kafka 连接器：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/datastream/kafka/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/connectors/datastream/kafka/)
- 异步 I/O：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/asyncio/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/asyncio/)
- 类型与序列化：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/serialization/types_serialization/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/fault-tolerance/serialization/types_serialization/)

> 下一篇：[时间、水位线与窗口](./3_time_window) —— 事件时间与水位线如何处理乱序和迟到数据，以及各类窗口与 Join 的选择。

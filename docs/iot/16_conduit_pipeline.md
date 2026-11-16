---
description: 总线接口与 Redis Streams 实现、消费与认领、重试与死信、批处理、微批、积压观测
---

# 数据流水线

> 前置阅读：[可靠上报与接入层主备](./15_conduit_reliable_uplink)、[物模型与解码](./14_conduit_thing_model)、[Redis 基础](/cache/1_redis_base)

数据流水线是 transport 把消息写进总线之后、数据落进时序库之前的那一段：server 以消费组拉取，解码、校验、写库，全部成功才确认。本篇讲 RawMessage 与 MessageBus、Redis Streams 实现、消费顺序与幂等、重试与死信、两处批处理和选型取舍，基线为 JDK 21、Spring Boot 3.5。

---

## 一、流水线在哪一段

Conduit 的接入和处理是两个进程：`conduit-transport` 只管把设备协议的报文搬进总线，`conduit-server` 负责所有业务解析，两者只通过 `conduit-common` 里的消息格式和总线接口通信。为什么这样分见 [平台实战概览](./12_conduit_intro)。

![数据流水线：从总线到时序库](../assets/iot/conduit-pipeline.svg)

| 模块 | 类 | 职责 |
|------|----|------|
| `conduit-common` | `RawMessage` / `RawMessageCodec` | 协议无关的消息，以及它与 Stream 字段的互转 |
| `conduit-common` | `MessageBus` / `RedisStreamMessageBus` | 总线接口与 Redis Streams 实现 |
| `conduit-common` | `Delivery` / `PublishResult` | 一次投递（带投递次数）；批量发布中单条的结果 |
| `conduit-server` | `PipelineWorker` | 后台消费线程，每条是消费组里的一个消费者 |
| `conduit-server` | `PipelineRunner` | 读一批或认领一批，交给处理器 |
| `conduit-server` | `PipelineProcessor` | 消费侧的事：分流、死信、确认、在线状态 |
| `conduit-server` | `TelemetryIngestor` | 解码 → 物模型校验 → 写时序库 → 写最新值，流水线与遥测重放共用 |
| `conduit-server` | `Backoff` / `LatestCoalescer` | 可恢复错误的退避重试；同批最新值合并 |

Redis Stream 的命令与消费组的基本概念见 [Redis 基础](/cache/1_redis_base)，这里只讲 Conduit 怎么用。

---

## 二、RawMessage：协议无关的消息

```java
public record RawMessage(String productKey, String deviceKey, MessageType type, byte[] payload,
                         long receivedAt, Map<String, String> attributes) {

    public RawMessage {
        Objects.requireNonNull(deviceKey, "deviceKey");
        Objects.requireNonNull(type, "type");
        payload = payload == null ? new byte[0] : payload;
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }
}
```

transport 从 MQTT topic 里解析出产品、设备和类型，`payload` 原样带走，一个字节都不解析。`MessageType` 有四种：`PROPERTY`（属性上报）、`EVENT`（事件，暂不支持）、`PRESENCE_CONNECTED` 与 `PRESENCE_DISCONNECTED`（EMQX 的上下线事件）。上下线事件和数据走同一条总线，由 server 更新在线状态。

写进 Stream 时一条消息展开成几个字段，见 [`RawMessageCodec`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/main/java/dev/conduit/common/message/RawMessageCodec.java)：

| Stream 字段 | 内容 |
|-------------|------|
| `pk` | 产品 Key；上下线事件拿不到时省略 |
| `dk` | 设备 Key（等于 MQTT clientId） |
| `type` | 消息类型的枚举名 |
| `payload` | 原始字节的 Base64 |
| `receivedAt` | transport 收到的时间（毫秒） |
| `attr.<名称>` | 协议相关的附加信息，目前只有 `attr.topic`（原始 topic） |

- **payload 用 Base64**：Stream 的字段值按字符串处理，Base64 让二进制协议也能原样过总线，代价是体积大约三分之一
- **`receivedAt` 是整条链路的时间参照**：设备没带 `ts` 时用它做采样时间，入库延迟指标也拿它当起点
- **信封和载荷分开对待**：`fromFields` 发现必填字段缺失、类型或数字非法时抛 `IllegalArgumentException`，消费侧据此把整条原始字段送进死信（`MALFORMED_ENVELOPE`），这是平台内部的问题，和设备发了什么无关

---

## 三、MessageBus：接口与 Redis Streams 实现

```java
public interface MessageBus {
    String publish(RawMessage message);
    List<PublishResult> publish(List<RawMessage> messages);
    void ensureGroup(String group);
    List<Delivery> read(String group, String consumer, int count, Duration block);
    List<Delivery> claimStale(String group, String consumer, Duration minIdle, int count);
    void ack(String group, List<String> ids);
    void deadLetter(String group, Delivery delivery, String reason);
    void recordDead(Delivery delivery, String reason, Map<String, String> details);
    List<Delivery> range(String startId, String endId, int count);
}
```

语义是**至少一次**：消费者处理成功后必须 `ack`，否则消息会被重新认领。接口里没有任何 Redis 的字眼，将来换 Kafka 或 RabbitMQ 时只换实现；当前唯一的实现是 [`RedisStreamMessageBus`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/main/java/dev/conduit/common/bus/RedisStreamMessageBus.java)。

| 方法 | Redis 命令 | 要点 |
|------|-----------|------|
| `publish(单条)` | `XADD … MAXLEN ~ 1000000` | 返回条目 id |
| `publish(批量)` | 管道里的多条 `XADD` | 一次往返；不原子，逐条返回成败 |
| `ensureGroup` | `XGROUP CREATE … 0-0 MKSTREAM` | 幂等，`BUSYGROUP` 忽略 |
| `read` | `XREADGROUP … >` | 只读没投递过的新消息，投递次数记 1 |
| `claimStale` | `XPENDING … IDLE` + `XCLAIM` | 服务端按空闲时间筛，投递次数为既有次数加 1 |
| `ack` | `XACK` | 空列表不发命令 |
| `deadLetter` | 写死信流 + `XACK` | 先写后确认，顺序不能反 |
| `recordDead` | 只写死信流 | 原消息部分成功、仍要留痕时用 |
| `range` | `XRANGE` | 只读、不进消费组，遥测重放用 |

两个流：上行流 `conduit:stream:up`（近似裁剪到 100 万条），死信流 `conduit:stream:dead`（10 万条）。

### 1、批量发布：允许部分成功

```java
public record PublishResult(String id, RuntimeException failure) {
    public PublishResult {
        if ((id == null) == (failure == null)) {
            throw new IllegalArgumentException("PublishResult requires exactly one of id / failure");
        }
    }
}
```

Redis 管道不是事务，一批 `XADD` 里可以有的成功有的失败。接口因此逐条返回结果而不是整批抛异常：调用方只确认成功的那些，失败的重投；如果整批重发，已经写入的条目就重复了。这里有一个实测出来的细节：管道里任一命令失败时，Spring Data Redis 不会把异常放进结果列表，而是整体抛 `RedisPipelineException`，成功命令的结果在它的 `getPipelineResult()` 里。实现里捕获它、取回逐条结果继续映射。

### 2、认领：先筛再抢

消费者读走消息后崩溃，消息就停在消费组的待确认列表里。认领分两步：

```java
// 一、XPENDING key group IDLE <ms> - + <count>：服务端筛出空闲超时的条目，拿到既有投递次数
List<Object[]> stale = pendingIdle(group, minIdle, count > 0 ? count : DEFAULT_CLAIM_COUNT);
// 二、XCLAIM 转给当前消费者；deliveryCount = 既有次数 + 1
List<MapRecord<String, Object, Object>> claimed = redis.opsForStream().claim(
        props.streamKey(), group, consumer, minIdle, ids);
```

- **空闲时间在服务端过滤**：`XPENDING` 带 `IDLE` 参数，取回来的窗口里全是真正超时的条目，不会被队首那些刚被认领过的条目占满
- **投递次数来自 Redis**：流水线靠它判断「这条已经试过几次」，超过上限就送死信
- **`XPENDING` 的 `COUNT` 必须是正数**：批大小配成「不限」时这里退回 1000，调用方本来就是循环认领到取不到为止

### 3、死信：先留痕再确认

`deadLetter` 是「写死信流 → `XACK` 原消息」两步，中间崩溃会产生一条重复的死信记录，但不会丢消息；反过来先确认再写，崩溃就丢了。死信记录在原始字段之上叠加 `reason`、`originalId`、`deliveryCount`、`failedAt`，这几个标准字段最后写入，附加详情盖不掉它们。

---

## 四、server：一批消息的处理顺序

[`PipelineWorker`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineWorker.java) 启动 `conduit.pipeline.workers` 条（默认 4）虚拟线程，每条是消费组 `conduit-server` 里的一个独立消费者。每条线程的循环很简单：

```java
while (running) {
    try {
        if (clock.millis() >= nextClaimAt) {
            while (running && runner.claimOnce(consumer) > 0) { }     // 先把遗留的认领处理完
            nextClaimAt = clock.millis() + props.claimInterval().toMillis();
        }
        runner.pollOnce(consumer);                                    // 再读新消息，最长阻塞 1 秒
        backoff = INITIAL_BACKOFF_MS;
    } catch (Exception e) {
        Thread.sleep(backoff);                                        // Redis 不可用等：1 秒起翻倍，30 秒封顶
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
}
```

读到的一批交给 [`PipelineProcessor#process`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineProcessor.java)，顺序是固定的：

| 步骤 | 做什么 | 粒度 |
|------|--------|------|
| ① 查身份 | 把本批属性消息的 deviceKey 去重，一次 `MGET` 查缓存，未命中的才回源 PostgreSQL | 每批一次 |
| ② 解码与校验 | 逐条：设备存在、租户启用、设备启用、产品一致 → 选解码器解码 → 逐测点对物模型 | 每条 |
| ③ 写 InfluxDB | 全部合格的点一次写入，写入要等 WAL 刷盘 | 每批一次 |
| ④ 更新最新值 | 合并后一次 pipeline 提交，Lua 脚本逐测点比较时间戳 | 每批一次 |
| ⑤ 确认 | 一次 `XACK` | 每批一次 |
| ⑥ 标记在线 | 按设备取本批最大的 `receivedAt`，一次 pipeline；尽力而为，失败只记 WARN | 每批一次 |

- **确认排在两个存储都写成功之后**：任何一步之前崩溃，消息都还在待确认列表里，60 秒后被认领重做
- **上下线事件不进这条路**：处理完直接确认；`EVENT` 类型暂不支持，进死信 `UNSUPPORTED_TYPE`
- **标记在线必须在确认之后**，而且不重试：它只是补偿「设备在 transport 订阅之前就已经连上、没收到连接事件」的情况，权威来源仍是 EMQX 的上下线事件
- **解码与校验的规则**见 [物模型与解码](./14_conduit_thing_model)；时序库与最新值的存法见 [时序存储与历史查询](./17_conduit_telemetry)

### 1、重复投递为什么是安全的

至少一次意味着重复不可避免：transport 被杀时已写入总线但没来得及确认的消息会被 EMQX 重投；server 写完 InfluxDB 但没确认就崩溃，会被认领重做；带 `id` 的设备收不到回执会重发。三个下游各自吸收重复：

| 下游 | 怎么吸收 |
|------|---------|
| InfluxDB | 同一序列（租户、产品、设备）同一时间戳的点覆盖为相同的值 |
| 最新值 | Lua 脚本按测点比较 `ts`，不早于当前值才写；重放的旧数据盖不掉新值 |
| 在线状态 | 数据来源不推进 `since`，晚到的断连事件仍然生效 |

因为三处都不依赖到达顺序，4 个消费者并发处理、各批完成顺序不确定也没有问题。这也是敢并发的前提。

---

## 五、错误分三类

流水线里出了错，去向只有三种：进死信、原地等、留给认领。

### 1、消息本身有问题：进死信

重试多少次结果都一样的错误，写一条死信记录后确认原消息，不再处理。

| 死信原因 | 含义 |
|---------|------|
| `MALFORMED_ENVELOPE` | 总线上的条目缺必填字段（平台内部问题） |
| `MALFORMED_JSON` / `INVALID_PARAMS` / `TS_OUT_OF_RANGE` | 载荷不是合法 JSON、测点非法、时间戳不在「过去 30 天到未来 5 分钟」内 |
| `UNKNOWN_DEVICE` / `DEVICE_DISABLED` / `TENANT_DISABLED` / `PRODUCT_MISMATCH` | 设备不存在、被禁用、所属租户已停用、topic 里的产品与设备不符 |
| `UNKNOWN_CODEC` / `UNSUPPORTED_TYPE` | 产品配置的解码器不存在；消息类型暂不支持 |
| `FIELD_REJECTED` | 测点不符合物模型 |
| `FIELD_TYPE_CONFLICT` | InfluxDB 逐行拒绝（同一测点前后类型不一致） |
| `PROCESSING_ERROR` | 意外的运行时异常，只影响这一条 |
| `MAX_DELIVERY_EXCEEDED` | 同一条消息投递超过 5 次（`max-deliveries`） |

`FIELD_REJECTED` 比较特殊：全部测点都不合格时整条进死信；只有部分不合格时，合格的测点照常入库并确认，另外用 `recordDead` 留一条记录说明哪些测点被剔除、原因是什么。

### 2、下游暂时不可用：原地退避

InfluxDB、Redis、PostgreSQL 连不上时，[`Backoff`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/Backoff.java) 在原地重试：1 秒起翻倍、30 秒封顶，**不限次数**，也不消耗投递次数。理由是「消息保持未确认」比「丢数据」好，下游恢复后接着处理即可。

关键在于怎么判断「可恢复」：

```java
public static boolean isRecoverable(Throwable e) {
    Throwable current = e;
    for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
        if (current instanceof TelemetryUnavailableException
                || current instanceof DataAccessResourceFailureException
                || current instanceof TransientDataAccessException
                || current instanceof RecoverableDataAccessException) {
            return true;
        }
        current = current.getCause();
    }
    return false;
}
```

- **沿 cause 链找**：MyBatis 会把「取不到连接」包成 `MyBatisSystemException`，只看顶层会把数据库宕机误判成不可恢复，然后把一批好消息全送进死信
- **InfluxDB 的 413 与 400 不算可恢复**：请求体过大、请求本身有问题，重发同样的载荷永远不会成功。这条是事故换来的，见第六节

### 3、处理到一半进程没了：认领

进程被杀、线程在退避中被中断，或者遇到不可恢复但又不是单条消息能背的错误（比如整批写入被 InfluxDB 以 400 拒绝），这批消息保持未确认。其他消费者（或重启后的自己）每 10 秒扫描一次（`claim-interval`），把空闲超过 60 秒（`claim-min-idle`）的条目认领过来重做。同一条消息第 6 次被投递时进死信 `MAX_DELIVERY_EXCEEDED`，避免一条毒消息无限循环。

::: warning claim-min-idle 必须远大于单批处理时长
否则会把别的消费者正在处理的消息抢过来重复处理。默认 60 秒对应的是「一批约 1 秒」的正常节奏；批大小调得很大、单批处理变成几十秒时，这个值要跟着调。
:::

还有一个自愈细节：Redis 重启且数据丢失时消费组也没了，读取会报 `NOGROUP`。`PipelineRunner` 沿 cause 链识别到它就重建消费组再抛出，由外层退避后重试。

---

## 六、批处理：吞吐等于批大小除以刷盘周期

流水线今天的批处理参数，几乎每一个都对应一次压测里撞到的墙。

### 1、每秒 100 条的天花板

2026-10-27 第一次认真压测，按 1,000 条/秒发 180 秒。客户端全绿：18 万条全部确认、零错误。服务端消费组的积压却一路涨到 16 万，停压后观察到的排空速度是精确的每秒 100 条，而 server 的 CPU 只有 3%～17%。

逐项排除之后定位到 InfluxDB：把批从 100 调到 1,000，吞吐线性变成 998 条/秒；把阻塞读缩到 50 毫秒，仍是 100 条/秒；直接写 InfluxDB 10 行就要约 1 秒。实验数据见 [压测与瓶颈排查](./22_conduit_capacity)。

InfluxDB 3 的写入默认要等下一次 WAL 刷盘才返回，刷盘间隔默认 1 秒。流水线每批只写一次，于是**吞吐 = 批大小 ÷ 1 秒**，批大小当时写死 100。演示负载每秒十几条，永远暴露不出来。

### 2、批不能太小，也不能不设限

修复是把批大小做成配置。但两头都有坑：

- **太大会停摆**：批设成 10 万时 InfluxDB 返回 413（请求体超过 10 MiB）。当时的写入器把除 400 以外的 HTTP 错误都当「下游不可用」，于是流水线无限退避重发同一个超大载荷，积压冻结、不进死信、健康检查还是 UP。修法两条：写入按 `conduit.influx.max-request-bytes`（默认 8 MiB）切块；413 与 400 一样改判为不可恢复
- **不设限会吃光内存**：批大小 `-1` 表示一次取走流里当前可读的全部消息，而流的上限是 100 万条。压测后 server 占了 4.7 GB，宿主机满 swap。根因是两件事叠加：容器没有内存上限时，`-XX:MaxRAMPercentage=75` 按宿主机总内存算堆

最后定下来的默认值：

| 配置 | 默认 | 说明 |
|------|-----|------|
| `conduit.pipeline.batch-size` | 20000 | 每次读取或认领的上限；`-1` 仍合法 |
| `conduit.pipeline.workers` | 4 | 并发的消费者数 |
| `conduit.pipeline.block` | 1 秒 | 阻塞读的最长时间，须小于 Redis 客户端命令超时 |
| `conduit.pipeline.claim-min-idle` / `claim-interval` | 60 秒 / 10 秒 | 认领的门槛与扫描间隔 |
| `conduit.pipeline.max-deliveries` | 5 | 超过进死信 |
| `conduit.influx.max-request-bytes` | 8 MiB | 单次写入请求的字节上限 |

同时给各 Java 容器设了内存上限（server 1500m、transport 512m）。

### 3、并发消费者：把等刷盘的时间摊薄

单线程时，等 WAL 刷盘的近 1 秒里线程纯等，Redis 和 CPU 都闲着。InfluxDB 的刷盘是周期性的，同一周期内到达的多个写请求会被同一次刷盘一起落盘，所以让多批同时在途就能把等待摊薄，而每批仍然等到刷盘后才确认，持久性不变。

反方向的尝试是把 WAL 刷盘间隔从 1 秒缩到 100 毫秒，实测吞吐反而降了 36%：批变小了，每批的固定开销摊不薄。这条结论写进了项目约定：不要缩短刷盘间隔。

---

## 七、Redis 往返：从每条两次到每批几次

批大小放开后，入库峰值到了约 2,900 条/秒就上不去了。这次排除了三个嫌疑：InfluxDB（每批只写一次，CPU 0.16%）、JVM 内存（堆占用 12.6%）、Redis 刷盘策略（`XADD` 平均 6.92 微秒）。真正的原因在代码结构里：

| 操作 | 频次 |
|------|------|
| 写 InfluxDB、`XACK`、标记在线 | 每批一次 |
| 查设备身份（一次 `GET`） | **每条一次** |
| 更新最新值（一次 `EVALSHA`） | **每条一次** |

每条消息 2 次串行的 Redis 网络往返，按每次约 0.15 毫秒算是 0.3 毫秒一条，约 3,300 条/秒，和实测峰值吻合。

修复是把这两项也按批做（[往返定位报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-pipeline-redis-roundtrips.md)）：

- **身份**：批内 deviceKey 去重后一次 `MGET`，未命中的才回源数据库
- **最新值**：每条仍然是一次 `EVALSHA`，但整批放进一个 pipeline 提交；Lua 脚本原样复用，「旧数据不覆盖新值」的语义一个字没动

批量化带来一个新问题：一批里有一条坏数据怎么办。这里确立了一个模式，身份和最新值都照此处理：

```java
try {
    backoff.run("latest update batch", () -> { ingestor.updateLatestBatch(points); return null; });
    return candidates;                                   // 批量成功
} catch (RuntimeException e) {
    log.warn("Batch latest update failed, falling back to per-item update: {}", e.toString());
}
for (PendingProperty item : candidates) {                // 批量失败：退回逐条
    try {
        backoff.run("latest update", () -> { ingestor.updateLatest(item.prepared().point()); return null; });
        ok.add(item);
    } catch (RuntimeException e) {
        dead(item.delivery(), DeadReason.PROCESSING_ERROR);   // 只让出错的那条进死信
    }
}
```

**批量遇到不可恢复的错误就退回逐条**，使失败只影响出错的那一条。脚本是幂等的，批量里已经执行的部分逐条重做不会改变结果。

### 1、同批合并最新值

往返次数降下来之后，下一个瓶颈在 Redis 自己：最新值脚本每条消息调用一次，12,000 条/秒时 Redis 单线程用到 91%，其中 `EVALSHA` 占 58.9%，而 Redis 一满，transport 的 `XADD` 跟着排队。但一批几千条消息里同一台设备常有十几条，最新值只关心每个测点最新的那次写入。

[`LatestCoalescer`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/LatestCoalescer.java) 在提交前剔除「被同批后续消息完全覆盖」的点：同一设备，位于它之后的某条消息 `ts` 不小于它、且测点集合包含它的全部测点，那它在每个测点上都不会是胜者，去掉不改变最终状态。

- **判定保守**：每台设备只拿「已保留的后续点里 `ts` 最大的那个」来比，覆盖不了全部测点就保留。宁可多调一次，也不冒漏写的险；这样每个点是 O(1) 判定
- **被剔除的消息照常确认**：它对最新值的贡献已被后续点覆盖，对 InfluxDB 的写入不受影响
- **只作用于批量路径**：批量失败退回逐条时不合并，出错路径与改动前一致

效果是 10,000 条/秒档位上最新值阶段从 1856 毫秒降到 98 毫秒，每批周期从 3367 毫秒降到 942 毫秒。

---

## 八、transport 侧的微批

写总线这一头也有同样的问题。transport 的投递线程是单线程串行的（为了保序），每条消息一次 `XADD` 往返时，持续投递实测只有约 1,230 条/秒，低于接入速率时 EMQX 的会话队列就会溢出。所以 transport 改成攒批：

| 配置 | 默认 | 含义 |
|------|-----|------|
| `conduit.transport.mqtt.batch-size` | 64 | 一次提交到总线的最大条数；设为 1 即退回逐条 |
| `conduit.transport.mqtt.batch-delay` | 5 毫秒 | 攒不满时最多等这么久，也是 PUBACK 的最坏额外延迟 |

满 64 条立即提交，否则最迟 5 毫秒提交。提交仍在同一条线程上，批内按到达顺序、批间按提交顺序，顺序不变；确认的规则也不变，见 [可靠上报与接入层主备](./15_conduit_reliable_uplink)。

### 1、批大小和 EMQX 的在途窗口

transport 手里「还没提交的条目」，在 EMQX 那边就是「已投递未确认」的在途消息，数量被 `mqtt.max_inflight` 硬限。两者的关系起初想错了，以为必须相等。固定 6,000 条/秒过载的对照实验否定了它：窗口 32、批 32 时稳态投递 2,605 条/秒，窗口 256、批 256 时 3,309 条/秒，窗口 1024、批 64 时约 4,000 条/秒，五组数据见 [压测与瓶颈排查](./22_conduit_capacity)。原因在窗口与批的比例：

- **批大于窗口**：永远攒不满，每批白等满 5 毫秒
- **批等于窗口**：EMQX 发 N 条、等全部确认、再发 N 条，每批之间空一次完整往返，是停等协议
- **窗口是批的若干倍**：提交当前批的同时下一批已经在途

规则因此是 **`batch-size ≤ max_inflight`，且窗口应为批的若干倍**。窗口也不能无限大：在途消息堆在 EMQX 连接进程的信箱里，越过 `force_shutdown.max_mailbox_size` 连接会被强杀，所以完整的约束是 `batch-size ≤ max_inflight ≪ max_mailbox_size`，仓库默认 64 / 512 / 1000（EMQX 默认值）。信箱那一侧的故事留给 [压测与瓶颈排查](./22_conduit_capacity)。

每组只测了一次，绝对值要按区间理解；能站住的结论是「窗口大于批能显著提升吞吐」。同一份对照里把 Redis 的 `appendfsync` 从 `always` 放宽到 `everysec` 能多 32%，但没有采用：transport 拿 `XADD` 成功当作向设备确认的依据，刷盘策略怎么定的见 [可靠上报与接入层主备](./15_conduit_reliable_uplink)。

---

## 九、背压与积压怎么看

这条链路上没有一个统一的「背压」开关，每一段慢了，表现和后果都不一样：

| 哪一段慢 | 消息堆在哪 | 堆满的后果 |
|---------|-----------|-----------|
| server 入库慢（InfluxDB 慢、消费者不够） | Redis 上行流：消费组积压增长 | 超过 `MAXLEN` 约 100 万条后，最旧的条目被裁剪，包括还没消费的 |
| Redis 慢或不可用 | transport 阻塞重试、不确认 → EMQX 在途窗口占满 → 会话 mqueue 增长 | mqueue 溢出丢弃，计入 `mqueue_dropped` |
| transport 全部离线 | EMQX 会话 mqueue | 同上 |

第一行要特别留意：**server 再慢，transport 写总线照样成功、照样向设备确认**，设备侧和 EMQX 侧看不出任何异常。2026-10-27 那轮压测如果只看客户端，会被判成通过。所以容量结论必须同时看服务端。

| 指标 | 来源 | 看什么 |
|------|------|--------|
| 上行流长度、消费组积压与待确认数 | redis-exporter（监控栈里配置了检查这两个流） | 积压持续增长就是入库跟不上 |
| `conduit.pipeline.batch.size` | server | 批没攒满说明受到达率限制，不是系统到顶；攒满了才是受批大小或下游限制 |
| `conduit.pipeline.stage{stage=…}` | server | `total`、`identity`、`decode`、`influx`、`latest`、`ack` 各阶段耗时，定位卡在哪一步 |
| `conduit.pipeline.ingest.latency` | server | 从 transport 收到到入库成功的耗时；只记实时消费、成功入库的消息 |
| `conduit.pipeline.processed{type}` / `conduit.pipeline.dead{reason}` | server | 处理条数与死信条数 |
| `conduit.transport.session.mqueue.len` / `.mqueue.dropped` / `.inflight` | transport | EMQX 会话队列水位、丢弃数、在途数 |

几个指标的口径值得多说一句：

- **`total` 只在含属性数据的批上记录**：上下线事件会产生大量近乎零耗时的小批，算进去会让 `total` 的均值远低于它的子阶段，相减得出负数
- **用指标而不是 DEBUG 日志测耗时**：高负载下打开逐条 DEBUG 本身就会把被测对象拖慢
- **入库延迟含两个进程的时钟差**：`receivedAt` 取自 transport 的时钟，计时用 server 的时钟；分机部署时时钟漂移会直接体现为延迟偏差，负值按 0 记
- **遥测重放不记入库延迟**：重放的是旧数据，算出来是几小时甚至几天，会彻底污染百分位

验收吞吐时用的是**计数守恒**而不是速率：客户端收到的 PUBACK 数等于 InfluxDB 的行数，且丢弃、死信都为 0。原因就是上表第一行和第二行：过载时速率看着照样不低。

---

## 十、为什么是 Redis Streams 而不是 Kafka

仓库里没有单独的选型对比文档，下面是按 V0.1 设计、`MessageBus` 的注释和后来的实测整理的取舍。

| 维度 | Redis Streams（当前） | Kafka |
|------|---------------------|-------|
| 额外组件 | 无：最新值、在线状态、身份缓存、选主锁本来就要 Redis | 多一套集群要部署、监控、备份 |
| 至少一次 | 消费组 + 待确认列表 + 认领，逐条确认 | 消费组 + 位点提交，按分区顺序提交 |
| 单条失败 | 这一条进死信，其余照常确认 | 位点是连续的，要自己做跳过或重试主题 |
| 保留与回放 | 按条数裁剪（约 100 万条），内存为主 | 按时间或容量保留在磁盘，回放是常规能力 |
| 水平扩展 | 一个流在一个节点上，命令单线程执行 | 分区天然并行，按设备分区还能保序 |
| 多个下游各读一遍 | 可以建多个消费组，但都压在同一个节点上 | 常规用法，流计算生态直接对接 |
| 持久性 | 单节点 AOF `always`，已确认的写入实测不丢；主从复制是异步的 | 多副本同步确认 |

选 Redis Streams 的理由是这个阶段它够用，而且便宜：单机部署一共就那几个容器，再加一套 Kafka 集群，部署和排障的成本比它解决的问题大。「逐条确认 + 单条进死信」也正好贴合遥测场景里「一条坏消息不该挡住后面的」这个需求。

代价也是明确的：

- **缓冲深度有限**：上行流按 100 万条近似裁剪，server 长时间宕机时，超出的未消费条目会被静默裁掉，认领也取不回，这与「每条消息要么入库要么进死信」不完全一致
- **总线和状态存储共用一个 Redis**：最新值脚本把 Redis 打满时，transport 的 `XADD` 跟着变慢，第七节的合并就是为这个做的
- **扩不出去**：单节点、单线程，Redis Cluster 也只能把不同的 key 分到不同节点，一个流分不开

所以接口先抽象好。V0.1 的路线里就写了「评估 Redis Streams 是否够用」和「评估 Kafka」两个节点；当数据要同时喂给规则引擎、数据转发和流计算，或者需要长时间回放时，换 Kafka 是自然的一步。那条路线站内有完整的一篇：[遥测数据链路](./9_data) 讲的就是 MQTT → Kafka → Flink → 时序库。几种消息队列的通用对比见 [消息队列总览](/messaging/0_overview) 与 [MQ 选型](/messaging/6_selection)。

---

## 十一、验证

| 结论 | 证据 | 类型 |
|------|------|------|
| RawMessage 与 Stream 字段互转，必填字段缺失时抛异常 | [`RawMessageCodecTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/test/java/dev/conduit/common/message/RawMessageCodecTest.java) | 单元 |
| 批量发布按序返回、`XADD` 失败时逐条给出失败而不是整体抛出 | [`RedisStreamMessageBusIT#publishesBatchInOrderAndReturnsOneResultPerMessage`、`#batchReturnsPerMessageFailuresInsteadOfThrowingWhenXaddFails`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/test/java/dev/conduit/common/bus/RedisStreamMessageBusIT.java) | 集成 |
| 未确认的消息可被认领且投递次数加一；空闲不够久的不认领；认领不被队首刚认领过的条目饿死 | 同上，`#unackedMessageCanBeClaimedWithIncreasedDeliveryCount`、`#claimSkipsMessagesNotIdleLongEnough`、`#claimStaleIsNotStarvedByRecentlyClaimedEntriesAtHeadOfPending` | 集成 |
| 死信带原因并确认原消息；`recordDead` 只留痕不确认；两个流都按上限近似裁剪 | 同上，`#deadLetterStoresReasonAndAcksOriginal`、`#recordDeadWritesDetailsButDoesNotAck`、`#publishTrimsStreamApproximately` | 集成 |
| 合格数据写入 InfluxDB 与最新值；旧消息不覆盖最新值；各类坏消息进对应的死信 | [`PipelineIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 未确认的消息被认领后处理；超过最大投递次数进死信 | 同上，`#unackedMessageIsClaimedAndProcessed`、`#messageExceedingMaxDeliveriesGoesToDeadLetter` | 集成 |
| InfluxDB、Redis 不可用时原地重试到恢复；MyBatis 包装的数据库宕机也算可恢复 | [`PipelineProcessorTest#retriesWriteInPlaceUntilInfluxRecovers`、`#retriesLatestUpdateOnRedisFailure`、`#dbOutageWrappedByMyBatisIsRetriedInPlace`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineProcessorTest.java)，[`BackoffTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/BackoffTest.java) | 单元 |
| 身份每批查一次、最新值每批提交一次；坏条目只让自己进死信 | 同上，`#identitiesAreLookedUpOncePerBatchAndLatestUpdatedOncePerBatch`、`#badLatestParametersDeadLetterOnlyThatMessageAndTheRestAreBatched` | 单元 |
| 确认之后才标记在线；写死信记录后确认暂时失败不会重复写记录 | 同上，`#marksOnlineOnlyAfterAck`、`#transientAckFailureAfterDeadRecordDoesNotDuplicateTheRecord` | 单元 |
| 入库延迟每条成功消息一个样本，死信与重放不计，时钟漂移不出负值 | 同上，`#recordsOneLatencySamplePerIngestedMessage` 等四项，[延迟指标报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-ingest-latency.md) | 单元 |
| 批量更新最新值与逐条更新得到完全相同的状态 | [`LatestValueStoreIT#batchUpdateProducesExactlyTheSameStateAsOneByOneUpdates`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/LatestValueStoreIT.java)，[批量化验证报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-pipeline-batch-redis.md) | 集成 |
| 同批合并：后续更旧或测点不全时不剔除，同毫秒保留靠后的 | [`LatestCoalescerTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/LatestCoalescerTest.java) | 单元 |
| 超限批次按字节切成多次请求，跨块的拒绝行号映射正确，413 不可恢复 | [`TelemetryWriterTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/TelemetryWriterTest.java) | 单元 |
| transport 攒满批或到时提交；部分成功时只重提失败的；回执在写入之后、确认之前；批内保序 | [`MqttProtocolAdapterTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/mqtt/MqttProtocolAdapterTest.java) | 单元 |
| 批固定 100 时吞吐钉在 100 条/秒，修复后排空 21 万条积压约 2,780 条/秒，行数与发送数一致 | [吞吐上限定位报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-load-test-and-pipeline-ceiling.md) | 压测 |
| 发送中途强杀 server，重启后 500 条恰好入库 | [`ReliabilityE2EIT#killingTheServerMidStreamLosesNothing`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-e2e/src/test/java/dev/conduit/e2e/ReliabilityE2EIT.java) | e2e |

---

## 十二、已知限制

- **上行流按条数裁剪**：server 长时间跟不上或宕机时，超过约 100 万条的未消费条目会丢，且没有计数；目前靠积压监控提前发现
- **死信只能看、不能重投**：首页总览会按原因统计最近 1 小时的死信，但没有「修好之后重新处理」的入口，细节要用 `redis-cli` 查死信流
- **遥测重放只覆盖仍在流里的数据**：确认只是把消息移出待确认列表，条目本身留在流里直到被裁剪，所以 InfluxDB 丢数后可以按时间范围重放；超出保留范围的找不回
- **物模型缓存是进程内的**：多实例消费同一个消费组时，改了物模型最长 60 秒后其他实例才看到，这期间新测点可能被判为未定义
- **消费者数只在进程内扩**：`workers` 是同一个 server 进程里的虚拟线程；拆成多个 server 实例用的是同一套消费组机制，但没有专门验证过
- **吞吐数字的适用范围**：本文的数字来自单台 8 核虚拟机上的单机部署，只能说明当时那套环境；整条链路的容量结论与口径见 [压测与瓶颈排查](./22_conduit_capacity)

---

## 小结

- transport 只把报文包成 `RawMessage` 写进总线，不做业务解析；payload 以 Base64 放进 Stream 字段，`receivedAt` 是全链路的时间参照
- `MessageBus` 接口屏蔽了 Redis：发布、读取、认领、确认、死信、范围读取；当前实现是 Redis Streams 的 `XADD`、`XREADGROUP`、`XPENDING` + `XCLAIM`、`XACK`
- server 一批的顺序是「查身份 → 解码校验 → 写 InfluxDB → 更新最新值 → 确认 → 标记在线」，两个存储都写成功才确认；重复由同时间戳覆盖与按 `ts` 比较吸收
- 错误分三类：消息本身有问题进死信；下游不可用原地退避 1 秒到 30 秒、不限次数；处理到一半中断的保持未确认，60 秒后被认领，超过 5 次进死信
- 入库吞吐约等于批大小除以 WAL 刷盘周期：批默认 20000、按 8 MiB 切块、4 个消费者并发；413 与 400 不可恢复；不要缩短刷盘间隔
- Redis 往返按批做：身份一次 `MGET`、最新值一次 pipeline，批量失败退回逐条；同批合并让最新值阶段从 1856 毫秒降到 98 毫秒
- transport 微批 64 条或 5 毫秒；`batch-size ≤ max_inflight ≪ max_mailbox_size`，窗口是批的若干倍
- server 慢时积压在 Redis 流里而设备侧毫无察觉，所以容量看积压与计数守恒，不看客户端
- 选 Redis Streams 是因为这个阶段够用且不加组件，代价是缓冲深度有限、扩不出去；接口已抽象，换 Kafka 时只换实现

## 参考资料

- Conduit IoT · V0.1 设计（数据流与错误处理）：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md)
- Conduit IoT · 吞吐上限定位、根因与修复：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-load-test-and-pipeline-ceiling.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-load-test-and-pipeline-ceiling.md)
- Conduit IoT · 流水线入库瓶颈定位（Redis 往返）：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-pipeline-redis-roundtrips.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-pipeline-redis-roundtrips.md)
- Conduit IoT · 出口侧瓶颈定量对照：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-throughput-ab.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-throughput-ab.md)
- Conduit IoT · 压测 VM 不崩溃的最大吞吐：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-vm-max-throughput.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-vm-max-throughput.md)
- Redis 文档 · Streams：[https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)
- Redis 文档 · XPENDING：[https://redis.io/docs/latest/commands/xpending/](https://redis.io/docs/latest/commands/xpending/)
- Spring Data Redis Reference · Redis Streams：[https://docs.spring.io/spring-data/redis/reference/redis/redis-streams.html](https://docs.spring.io/spring-data/redis/reference/redis/redis-streams.html)

> 下一篇：[时序存储与历史查询](./17_conduit_telemetry)

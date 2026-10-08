---
description: 同步转异步、批量化、请求合并、预计算
---

# 异步与批量

> **本篇目标**：学会用并行调用缩短关键路径、用批量化和请求合并摊薄固定开销，并清楚每种手段的代价。
>
> **前置阅读**：[池化技术](./7_pooling)

先记住两句话：**异步的目标是缩短关键路径**——主流程只等待必须等待的事；**批量的目标是摊薄固定开销**——把 N 次网络往返、N 次事务提交合并为 1 次。

---

## 一、同步转异步

### 1、识别可异步的部分

**先按"是否在关键路径上、是否相互依赖"给操作分类，再决定串行、并行还是异步。**

| 类型 | 特征 | 处理方式 | 例子 |
|------|------|----------|------|
| 关键路径、有依赖 | 后一步依赖前一步结果 | 保持同步 | 校验库存 → 扣库存 |
| 关键路径、相互独立 | 结果都要，但彼此无依赖 | **并行调用** | 商品详情页同时查商品、价格、评价 |
| 非关键路径 | 用户不需要等待结果 | **异步执行** | 发短信、写审计日志、更新统计、推送 |

### 2、并行调用：CompletableFuture

**串行调用 3 个各 100ms 的下游约 300ms，并行后约等于最慢的一个。** 下面的示例是本知识库中并行聚合的标准写法：

```java
@Slf4j
@Service
public class ProductDetailService {

    private final ExecutorService ioPool;   // 专用、有界的 IO 线程池，不要使用 ForkJoinPool.commonPool()

    public ProductDetailService(@Qualifier("detailIoPool") ExecutorService ioPool) {
        this.ioPool = ioPool;
    }

    public ProductDetailVO getDetail(long productId) {
        CompletableFuture<Product> productF =
                CompletableFuture.supplyAsync(() -> productClient.get(productId), ioPool);
        CompletableFuture<Price> priceF =
                CompletableFuture.supplyAsync(() -> priceClient.get(productId), ioPool);
        // 非核心数据：失败或超时都降级为空列表，不影响整页
        CompletableFuture<List<Review>> reviewF =
                CompletableFuture.supplyAsync(() -> reviewClient.top(productId, 10), ioPool)
                        .exceptionally(ex -> {
                            log.warn("评价查询失败，降级为空, productId={}", productId, ex);
                            return List.of();
                        })
                        .completeOnTimeout(List.of(), 200, TimeUnit.MILLISECONDS);

        try {
            return CompletableFuture.allOf(productF, priceF, reviewF)
                    .thenApply(v -> ProductDetailVO.of(productF.join(), priceF.join(), reviewF.join()))
                    .orTimeout(500, TimeUnit.MILLISECONDS)   // 整体超时预算
                    .join();
        } catch (CompletionException e) {
            // join() 把任务异常和 TimeoutException 包装成 CompletionException，取 cause 区分处理
            Throwable cause = e.getCause();
            if (cause instanceof TimeoutException) {
                throw new BizException("商品详情查询超时", cause);
            }
            throw new BizException("商品详情查询失败", cause);
        }
    }
}
```

- 必须使用**独立、有界的线程池**；`commonPool` 默认线程数为核数 − 1，被阻塞 IO 占满后会拖垮所有使用它的代码。
- 核心数据失败要整体失败并给出明确异常；非核心数据用 `exceptionally` / `completeOnTimeout` 降级。
- API 细节与异常传播规则见 [CompletableFuture](/java/29_topic_completable_future)。

::: warning orTimeout / completeOnTimeout 不会取消底层任务
这两个方法只是让 **Future 提前完成**，正在执行的 `productClient.get()` 不会被中断，IO 线程和连接仍被占用，直到下游返回或客户端自身超时（`CompletableFuture.cancel(true)` 同样不会中断执行线程）。因此 **HTTP / RPC 客户端本身必须设置连接和读超时**，且应不大于这里的超时预算，否则慢下游会逐渐占满 `ioPool`。
:::

### 3、非关键路径：进程内异步与 MQ

**允许丢失的轻量任务用进程内线程池；不允许丢失、跨服务的任务用 MQ。**

| 方式 | 可靠性 | 适用场景 | 注意事项 |
|------|--------|----------|----------|
| `@Async` / 线程池 | 进程内，重启或宕机会丢失任务 | 本地统计、缓存预热 | 必须指定自定义线程池；同类内部调用不生效（代理失效） |
| Spring 事件 + `@TransactionalEventListener` | 进程内，事务提交后触发 | 同服务内解耦 | 同样不保证可靠 |
| 消息队列 / 事务消息 | 持久化、可重试 | 发券、通知、积分 | 幂等、顺序、最终一致性 |

```java
@Configuration
@EnableAsync
public class AsyncConfig {
    @Bean("notifyExecutor")
    public ThreadPoolTaskExecutor notifyExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(1000);           // 有界队列
        executor.setThreadNamePrefix("notify-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}

@Async("notifyExecutor")
public void sendOrderNotice(Long orderId) { ... }
```

MQ 异步、受理 + 异步回执、Write-Behind 等系统级模式见 [异步与削峰](/high-con/4_async_peak_shaving)；幂等设计见 [幂等性](/architecture/5_idempotence)。

---

## 二、长尾治理：对冲请求

**并行聚合的 RT 取决于最慢的分支，分支越多越容易被长尾拖累。** 除了超时降级，读请求还可以用对冲请求（Hedged Request）削减长尾：首个请求在 P95 耗时内未返回，就向另一个副本再发一次，谁先返回用谁。对冲的适用条件与原理见 [性能分析方法论 - 长尾治理](./2_methodology)，本节只给实现。

```java
/** 对冲调用：hedgeDelayMs 后仍未返回则再发一次，取最先成功的结果 */
public <T> CompletableFuture<T> hedged(Supplier<T> call, long hedgeDelayMs,
                                       Executor pool, ScheduledExecutorService timer) {
    CompletableFuture<T> result = new CompletableFuture<>();
    AtomicInteger attempts = new AtomicInteger(1);
    AtomicInteger failures = new AtomicInteger();
    BiConsumer<T, Throwable> onDone = (v, ex) -> {
        if (ex == null) {
            result.complete(v);                                  // 先成功者胜出，后到的结果被忽略
        } else if (failures.incrementAndGet() == attempts.get()) {
            result.completeExceptionally(ex);                    // 所有已发出的请求都失败
        }
    };
    CompletableFuture.supplyAsync(call, pool).whenComplete(onDone);
    ScheduledFuture<?> hedge = timer.schedule(() -> {
        if (!result.isDone()) {
            attempts.incrementAndGet();
            CompletableFuture.supplyAsync(call, pool).whenComplete(onDone);
        }
    }, hedgeDelayMs, TimeUnit.MILLISECONDS);
    result.whenComplete((v, ex) -> hedge.cancel(false));
    return result;
}
```

| 要点 | 说明 |
|------|------|
| 只用于幂等读 | 写请求重复发送会造成重复副作用 |
| 延迟取 P95 左右 | 太早会成倍放大下游流量，太晚削不掉长尾；额外流量通常控制在 5% 以内 |
| 下游要能路由到不同副本 | 两次落到同一台慢节点就没有意义 |
| 优先用框架能力 | gRPC 的 `hedgingPolicy` 内置对冲；与重试共用重试预算，防止放大故障 |

对冲与重试的关系、重试预算见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 三、批量化

### 1、为什么批量能提速

**每次操作都有与数据量无关的固定开销**：网络 RTT、SQL 解析、事务提交（redo log 刷盘）、系统调用。批量把它摊到多条数据上：

| 方式 | 总耗时 |
|------|-------|
| 逐条 | `N × (固定开销 + 单条处理)` |
| 批量 | `⌈N / batch⌉ × 固定开销 + N × 单条处理` |

### 2、常见批量手段

| 场景 | 逐条做法 | 批量做法 | 关键点 |
|------|----------|----------|--------|
| MySQL 写入 | 循环 `insert` | JDBC `addBatch` / 多值 `INSERT` | MySQL 驱动需开启 `rewriteBatchedStatements=true`，每批 500～1000 条 |
| MySQL 查询 | 循环按 id 查 | `WHERE id IN (...)` | IN 列表不宜过长，分批 |
| Redis | 循环 `GET` / `SET` | `MGET` / `MSET` / Pipeline | Pipeline 非原子；集群模式下需按 slot 分组 |
| MQ 发送 | 每条单独发送 | Kafka `batch.size` + `linger.ms`；RocketMQ 批量发送 | 批量增加单条延迟 |
| RPC | 循环调用单条接口 | 提供批量接口 `batchGet(ids)` | 限制单批上限，防止大请求 |
| 日志 / 文件 | 每条 `write` + flush | 缓冲写、异步刷盘 | 宕机可能丢失缓冲区数据 |

Redis Pipeline 示例（Spring Data Redis）：

```java
List<Object> results = redisTemplate.executePipelined((RedisCallback<Object>) conn -> {
    for (String key : keys) {
        conn.stringCommands().get(key.getBytes(StandardCharsets.UTF_8));
    }
    return null;   // 必须返回 null，结果由 executePipelined 按顺序返回
});
```

MySQL 批量写入的事务与注意事项见 [数据访问性能](./10_db_performance)，驱动层细节见 [MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver)；Kafka 批量参数见 [Kafka](/messaging/2_kafka)。

### 3、批大小如何选

- 批太小收益不明显；批太大导致单次请求过大、锁持有时间长、失败重试代价高。
- 经验值：SQL 批量 500～1000 行、Redis Pipeline 100～1000 条命令，最终以压测为准。
- 大批量写入应**分批提交事务**，避免大事务导致主从延迟和长时间锁等待。

---

## 四、请求合并

### 1、思路

**把一个短时间窗口（如 10ms）内的单 key 查询收集起来，合并成一次批量查询，再把结果分发回各调用方。** 适合大量请求同时按单个 id 查询的场景。

| 维度 | 说明 |
|------|------|
| 收益 | 下游调用次数从 N 降到 N / 批大小，数据库或 RPC 压力显著下降 |
| 代价 | 调用方的等待 = **窗口等待 + 批量加载耗时**，而不只是一个窗口 |
| 适用 | QPS 高、下游支持批量接口、对几毫秒延迟不敏感 |
| 不适用 | QPS 低（凑不满批，只增加延迟）、强实时场景 |

与防缓存击穿的 SingleFlight（同一 key 只放一个请求回源）不同，请求合并针对的是**不同 key** 的批量化，SingleFlight 见 [热点问题](/high-con/6_hotspot)。

### 2、简易实现

```java
@Slf4j
public class RequestMerger<K, V> implements AutoCloseable {

    private record Pending<K, V>(K key, CompletableFuture<Optional<V>> future) {}

    private final BlockingQueue<Pending<K, V>> queue = new LinkedBlockingQueue<>(10_000);
    private final Function<List<K>, Map<K, V>> batchLoader;
    private final Executor loaderPool;           // 批量加载在独立线程池执行，不阻塞调度线程
    private final int maxBatch;
    private final ScheduledExecutorService scheduler;

    public RequestMerger(Function<List<K>, Map<K, V>> batchLoader, Executor loaderPool,
                         int maxBatch, long windowMs) {
        this.batchLoader = batchLoader;
        this.loaderPool = loaderPool;
        this.maxBatch = maxBatch;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "request-merger");
            t.setDaemon(true);                   // 守护线程，不阻止 JVM 退出
            return t;
        });
        scheduler.scheduleWithFixedDelay(this::flush, windowMs, windowMs, TimeUnit.MILLISECONDS);
    }

    /** 调用方提交单个 key；结果为空表示 key 不存在，失败时 future 异常完成 */
    public CompletableFuture<Optional<V>> submit(K key) {
        CompletableFuture<Optional<V>> future = new CompletableFuture<>();
        if (!queue.offer(new Pending<>(key, future))) {
            future.completeExceptionally(new RejectedExecutionException("merger queue full"));
        }
        return future;
    }

    /** 每个窗口把积攒的请求按 maxBatch 切批，交给 loaderPool 批量加载 */
    private void flush() {
        List<Pending<K, V>> batch = new ArrayList<>(maxBatch);
        while (queue.drainTo(batch, maxBatch) > 0) {
            List<Pending<K, V>> current = List.copyOf(batch);
            batch.clear();
            try {
                loaderPool.execute(() -> load(current));
            } catch (RejectedExecutionException e) {
                current.forEach(p -> p.future().completeExceptionally(e));
            }
        }
    }

    private void load(List<Pending<K, V>> batch) {
        List<K> keys = batch.stream().map(Pending::key).distinct().toList();
        try {
            Map<K, V> result = batchLoader.apply(keys);
            // 批量接口通常不返回不存在的 key，显式转成 Optional.empty()，不要让调用方拿到 null
            batch.forEach(p -> p.future().complete(Optional.ofNullable(result.get(p.key()))));
        } catch (Exception e) {
            log.warn("批量加载失败, size={}", keys.size(), e);
            batch.forEach(p -> p.future().completeExceptionally(e));
        }
    }

    /** 应用关闭时调用：停止调度，并让尚未处理的请求失败返回 */
    @Override
    public void close() {
        scheduler.shutdown();
        List<Pending<K, V>> rest = new ArrayList<>();
        queue.drainTo(rest);
        rest.forEach(p -> p.future().completeExceptionally(new IllegalStateException("merger closed")));
    }
}

// 使用：窗口 10ms，单批最多 100 个 id；调用方必须设置超时
RequestMerger<Long, Product> merger =
        new RequestMerger<>(ids -> productDao.batchGetAsMap(ids), loaderPool, 100, 10);
Optional<Product> p = merger.submit(productId).get(200, TimeUnit.MILLISECONDS);
```

生产使用时还需考虑：队列达到 `maxBatch` 时立即触发而不必等满窗口、监控批大小与等待耗时分布、下游批量接口的单批上限。成熟实现可参考 GraphQL 生态的 DataLoader（Java 版为 `java-dataloader`）。

---

## 五、预计算与物化

**把"查询时计算"提前到"写入时或离线计算"，查询时直接读结果。**

| 手段 | 做法 | 例子 |
|------|------|------|
| 冗余字段 | 写入时同步维护汇总值 | 订单表冗余商品名称；帖子表维护 `comment_count` |
| 汇总表 / 物化视图 | 定时或增量计算聚合结果 | 按天统计销售额的报表表 |
| 缓存预热 | 流量到来前把热点数据加载进缓存 | 大促前预热商品详情 |
| 离线计算 | 批处理任务生成结果 | 推荐列表、排行榜 |
| 搜索引擎宽表 | 通过 CDC 将多表数据同步为 ES 宽表 | 商品搜索、订单多条件查询 |

- 预计算的代价是**写放大与一致性**：数据变更时必须同步更新预计算结果，要考虑更新失败、延迟和补偿。
- 缓存预热与一致性策略见 [缓存一致性](/cache/10_cache_consistency)；CDC 同步见 [CDC 工具](/database/5_practice/0_cdc_tools)。

---

## 六、权衡

| 手段 | 收益 | 代价 |
|------|------|------|
| 并行调用 | RT 从各段之和降为最大值 | 线程资源占用，异常与超时处理更复杂 |
| 对冲请求 | 削减长尾 | 下游额外流量，仅限幂等读 |
| 异步化（线程池） | 缩短关键路径 | 任务可能丢失，上下文与链路追踪需传递 |
| 异步化（MQ） | 解耦、削峰、可靠 | 最终一致性、幂等、消息积压、运维成本 |
| 批量化 | 吞吐成倍提升 | 单条延迟增加，部分失败处理复杂 |
| 请求合并 | 下游压力大幅下降 | 额外等待，低 QPS 时反而变慢 |
| 预计算 | 查询极快 | 写放大、数据一致性、存储成本 |

原则：**异步和批量都是用"一致性、实时性或复杂度"换"延迟或吞吐"**，引入前要确认业务能接受这些代价。

---

## 小结

- 先分类：有依赖的串行、独立的并行、非关键路径的异步
- 并行聚合用独立有界线程池；`orTimeout` 不取消底层任务，客户端超时必须单独设置，`join` 要处理 `CompletionException`
- 幂等读的长尾可用对冲请求削减，但要控制额外流量
- 批量化摊薄固定开销，批大小以压测为准、大批量分批提交
- 请求合并的等待是"窗口 + 加载耗时"，只适合高 QPS 且下游支持批量的场景

> 下一篇：[IO 与网络优化](./9_io_network) —— 少拷贝、少等待、少传输、少往返。

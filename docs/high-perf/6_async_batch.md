# 异步与批量

> 异步的目标是**缩短关键路径**：让主流程只等待必须等待的事情；批量的目标是**摊薄固定开销**：把 N 次网络往返、N 次事务提交、N 次系统调用合并为 1 次。

---

## 一、同步转异步

### 1、识别可异步的部分

一个请求中的操作可以分为三类：

| 类型 | 特征 | 处理方式 | 例子 |
|------|------|----------|------|
| 关键路径、有依赖 | 后一步依赖前一步结果 | 保持同步 | 校验库存 → 扣库存 |
| 关键路径、相互独立 | 结果都要，但彼此无依赖 | **并行调用** | 商品详情页同时查商品、价格、评价 |
| 非关键路径 | 用户不需要等待结果 | **异步执行** | 发短信、写审计日志、更新统计、推送 |

### 2、并行调用：CompletableFuture

串行调用 3 个各 100ms 的下游，总耗时约 300ms；并行后约等于最慢的一个：

```java
@Service
public class ProductDetailService {

    private final ExecutorService ioPool;   // 专用 IO 线程池，不要使用 ForkJoinPool.commonPool()

    public ProductDetailService(@Qualifier("detailIoPool") ExecutorService ioPool) {
        this.ioPool = ioPool;
    }

    public ProductDetailVO getDetail(long productId) {
        CompletableFuture<Product> productF =
                CompletableFuture.supplyAsync(() -> productClient.get(productId), ioPool);
        CompletableFuture<Price> priceF =
                CompletableFuture.supplyAsync(() -> priceClient.get(productId), ioPool);
        CompletableFuture<List<Review>> reviewF =
                CompletableFuture.supplyAsync(() -> reviewClient.top(productId, 10), ioPool)
                        .completeOnTimeout(List.of(), 200, TimeUnit.MILLISECONDS); // 非核心数据超时降级

        return CompletableFuture.allOf(productF, priceF, reviewF)
                .thenApply(v -> ProductDetailVO.of(productF.join(), priceF.join(), reviewF.join()))
                .orTimeout(500, TimeUnit.MILLISECONDS)
                .join();
    }
}
```

- 必须使用**独立、有界的线程池**；默认的 `commonPool` 线程数为核数 − 1，被阻塞 IO 占满后会拖垮所有使用它的代码。
- 每个异步分支设置超时，非核心数据超时后降级而不是整体失败。
- API 细节与异常处理见 [CompletableFuture 专题](/java/29_topic_completable_future)。

### 3、非关键路径：@Async 与 MQ

| 方式 | 可靠性 | 适用场景 | 注意事项 |
|------|--------|----------|----------|
| `@Async` / 线程池 | 进程内，重启或宕机会丢失任务 | 允许丢失的轻量任务：本地统计、缓存预热 | 必须指定自定义线程池；同类内部调用不生效（代理失效） |
| Spring 事件 + `@TransactionalEventListener` | 进程内，事务提交后触发 | 同服务内解耦 | 同样不保证可靠 |
| 消息队列 | 持久化、可重试 | 跨服务、不允许丢失：发券、通知、积分 | 需处理重复消费（幂等）、消息顺序、最终一致性 |
| 本地消息表 / 事务消息 | 与业务事务原子 | 必须与本地事务一致的异步操作 | 实现复杂度较高 |

```java
@Configuration
@EnableAsync
public class AsyncConfig {
    @Bean("notifyExecutor")
    public ThreadPoolTaskExecutor notifyExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(1000);
        executor.setThreadNamePrefix("notify-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}

@Async("notifyExecutor")
public void sendOrderNotice(Long orderId) { ... }
```

MQ 的选型与可靠投递见 [消息队列概述](/messaging/0_overview)；幂等设计见 [幂等性](/architecture/5_idempotence)。

---

## 二、批量化

### 1、为什么批量能提速

每次操作都有与数据量无关的**固定开销**：网络 RTT、SQL 解析、事务提交（redo log 刷盘）、系统调用。批量把固定开销摊到多条数据上：

```text
逐条耗时 ≈ N × (固定开销 + 单条处理)
批量耗时 ≈ ⌈N / batch⌉ × 固定开销 + N × 单条处理
```

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
    return null;   // 返回值必须为 null，结果从 executePipelined 返回
});
```

MySQL 批量写入的细节见 [数据访问性能](/high-perf/8_db_performance)；Kafka 批量参数见 [Kafka](/messaging/1_kafka)。

### 3、批大小如何选

- 批太小收益不明显，批太大会导致单次请求过大、锁持有时间长、失败重试代价高。
- 经验值：SQL 批量 500～1000 行、Redis Pipeline 100～1000 条命令，最终以压测为准。
- 大批量写入应**分批提交事务**，避免大事务导致主从延迟和长时间锁等待。

---

## 三、请求合并

### 1、思路

在高频、小粒度的查询场景（如大量请求同时按单个 id 查询商品），把一个**短时间窗口**（如 10ms）内的请求收集起来，合并成一次批量查询，再把结果分发回各个调用方。

| 维度 | 说明 |
|------|------|
| 收益 | 下游调用次数从 N 降到 N / 批大小，数据库或 RPC 压力显著下降 |
| 代价 | 每个请求最多额外等待一个时间窗口 |
| 适用 | QPS 高、下游支持批量接口、对几毫秒延迟不敏感 |
| 不适用 | QPS 低（凑不满批，只增加延迟）、强实时场景 |

### 2、简易实现

```java
public class RequestMerger<K, V> {

    private record Pending<K, V>(K key, CompletableFuture<V> future) {}

    private final BlockingQueue<Pending<K, V>> queue = new LinkedBlockingQueue<>(10_000);
    private final Function<List<K>, Map<K, V>> batchLoader;
    private final int maxBatch;

    public RequestMerger(Function<List<K>, Map<K, V>> batchLoader, int maxBatch, long windowMs) {
        this.batchLoader = batchLoader;
        this.maxBatch = maxBatch;
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(
                r -> new Thread(r, "request-merger"));
        scheduler.scheduleWithFixedDelay(this::flush, windowMs, windowMs, TimeUnit.MILLISECONDS);
    }

    /** 调用方提交单个 key，拿到一个 Future */
    public CompletableFuture<V> submit(K key) {
        CompletableFuture<V> future = new CompletableFuture<>();
        if (!queue.offer(new Pending<>(key, future))) {
            future.completeExceptionally(new RejectedExecutionException("merger queue full"));
        }
        return future;
    }

    /** 定时把窗口内积攒的请求合并成批量调用 */
    private void flush() {
        List<Pending<K, V>> batch = new ArrayList<>(maxBatch);
        while (queue.drainTo(batch, maxBatch) > 0) {
            List<K> keys = batch.stream().map(Pending::key).distinct().toList();
            try {
                Map<K, V> result = batchLoader.apply(keys);
                batch.forEach(p -> p.future().complete(result.get(p.key())));
            } catch (Exception e) {
                batch.forEach(p -> p.future().completeExceptionally(e));
            }
            batch.clear();
        }
    }
}

// 使用：窗口 10ms，单批最多 100 个 id
RequestMerger<Long, Product> merger =
        new RequestMerger<>(ids -> productDao.batchGetAsMap(ids), 100, 10);
Product p = merger.submit(productId).get(200, TimeUnit.MILLISECONDS);
```

生产使用时还需考虑：调用方超时、批量调用在独立线程池执行（避免阻塞调度线程）、监控批大小分布。成熟实现可参考 Hystrix 的 `HystrixCollapser` 思路或 GraphQL 的 DataLoader。

---

## 四、预计算与物化

把"查询时计算"提前到"写入时或离线计算"，查询时直接读结果：

| 手段 | 做法 | 例子 |
|------|------|------|
| 冗余字段 | 写入时同步维护汇总值 | 订单表冗余商品名称；帖子表维护 `comment_count` |
| 汇总表 / 物化视图 | 定时或增量计算聚合结果 | 按天统计销售额的报表表 |
| 缓存预热 | 在流量到来前把热点数据加载进缓存 | 大促前预热商品详情 |
| 离线计算 | 批处理任务生成结果 | 推荐列表、排行榜 |
| 搜索引擎宽表 | 通过 CDC 将多表数据同步为 ES 宽表 | 商品搜索、订单多条件查询 |

- 预计算的代价是**写放大与一致性**：数据变更时必须同步更新预计算结果，需考虑更新失败、延迟和补偿。
- 缓存预热与一致性策略见 [缓存一致性](/cache/10_cache_consistency)；CDC 同步见 [CDC 工具](/database/5_practice/0_cdc_tools)。

---

## 五、权衡

| 手段 | 收益 | 代价 |
|------|------|------|
| 并行调用 | RT 从各段之和降为最大值 | 线程资源占用、异常与超时处理更复杂 |
| 异步化（线程池） | 缩短关键路径 | 任务可能丢失，排错更难（上下文、链路追踪需传递） |
| 异步化（MQ） | 解耦、削峰、可靠 | 最终一致性、幂等、消息积压、运维成本 |
| 批量化 | 吞吐成倍提升 | 单条延迟增加、部分失败处理复杂 |
| 请求合并 | 下游压力大幅下降 | 额外窗口延迟，低 QPS 时反而变慢 |
| 预计算 | 查询极快 | 写放大、数据一致性、存储成本 |

原则：**异步和批量都是用"一致性、实时性或复杂度"换"延迟或吞吐"**，引入前要明确业务能否接受这些代价。

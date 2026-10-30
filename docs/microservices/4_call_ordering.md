---
description: 乱序成因、消除顺序依赖、按业务键路由、实例内按 key 串行、版本号兜底、分布式锁为何不行
---

# 接口调用顺序性

> 前置阅读：[微服务设计模式](./3_patterns)、[一致性哈希](/distributed/9_consistent_hashing)

同步调用的执行顺序不等于发送顺序，「先创建后更新」到了服务端可能反过来。本篇讲乱序成因、消除顺序依赖，以及「同 key 路由 → 实例内串行 → 版本号兜底」三道防线。

---

## 一、为什么会乱序

调用方先发「创建」再发「更新」，到了服务端却可能先执行「更新」：两个请求被负载均衡分到不同实例、进了不同线程，或者第一次请求超时重试，旧请求比新请求更晚到达。分布式环境下**请求的到达顺序和执行顺序都不受发送顺序约束**。

---

## 二、先问是不是真的需要顺序

多数「顺序问题」可以靠业务设计消掉，成本远低于在基础设施上保证顺序：

| 做法 | 例子 |
|------|------|
| 调用方串行 | 等「创建」返回成功后再发「更新」，不并发发送同一业务对象的请求 |
| 合并成一个请求 | 「创建 + 设置属性」做成一个接口，而不是先后两次调用 |
| 状态机拒绝非法迁移 | 支付回调先于订单创建到达时返回失败，让对方按重试策略稍后再来 |
| 发全量状态而不是增量指令 | 同步「库存现在是 80」而不是「库存减 20」，配合版本号只保留最新值，乱序也不会算错 |

---

## 三、三道防线

确实需要顺序时，只需要**同一业务键（订单号、账户号）内有序**，不同业务键之间互不影响，不要追求全局有序。做法按位置分三层：

![按业务键保证调用顺序的三道防线](../assets/microservices/call-ordering-defenses.svg)

### 1、同一业务键路由到同一处

让同一个订单号的请求总是落在同一个实例，或进入同一个消息队列分区。

| 通道 | 做法 |
|------|------|
| RPC | Dubbo 一致性哈希负载均衡：`@DubboReference(loadbalance = "consistenthash", parameters = {"hash.arguments", "0"})`，按第 1 个参数哈希 |
| HTTP | Nginx `hash $http_x_order_id consistent;`，或 Istio `DestinationRule` 的 `consistentHash` 按请求头选实例 |
| 异步 | 改走 MQ，以业务键作为分区键（Kafka 消息 key、RocketMQ 5.x MessageGroup），单分区单线程消费，见 [消息队列基础 · 顺序消息](/messaging/1_basics#五、顺序消息) |

一致性哈希只解决「去同一个实例」，原理见 [一致性哈希](/distributed/9_consistent_hashing)。它有两个缺口：实例扩缩容的瞬间，一部分业务键会换到新实例，新旧实例上可能同时有同一个键的请求在执行；单个热点键的流量全部压在一个实例上，无法水平分摊。

### 2、实例内按业务键串行

请求到了同一个实例，Web 容器仍会用多个线程并发处理。可以按业务键哈希到固定数量的单线程通道，同一个键永远在同一个通道里排队执行：

```java
public final class KeyedSerialExecutor implements AutoCloseable {

    private final ExecutorService[] lanes;

    public KeyedSerialExecutor(int laneCount, int queueCapacity) {
        lanes = new ExecutorService[laneCount];
        for (int i = 0; i < laneCount; i++) {
            lanes[i] = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                    new ArrayBlockingQueue<>(queueCapacity),
                    Thread.ofPlatform().name("lane-" + i).factory(),
                    new ThreadPoolExecutor.AbortPolicy());
        }
    }

    /** 同一个 key 总是进入同一个单线程通道，按提交顺序执行；队列满时抛 RejectedExecutionException */
    public <T> CompletableFuture<T> submit(Object key, Supplier<T> task) {
        int lane = Math.floorMod(key.hashCode(), lanes.length);
        return CompletableFuture.supplyAsync(task, lanes[lane]);
    }

    @Override
    public void close() {
        for (ExecutorService lane : lanes) {
            lane.close();
        }
    }
}
```

- `Math.floorMod` 保证 `hashCode()` 为负数时下标仍在 `[0, laneCount)` 内；`ExecutorService.close()` 是 JDK 19 起提供的，会等待已提交任务执行完
- 通道数决定并行度：16 个通道最多同时处理 16 个不同的业务键；队列必须有界，满了就拒绝并让调用方重试，不能无限堆积
- 它只保证「按到达本实例的顺序」执行，挡不住网络上已经颠倒的请求，所以还需要下一层兜底。线程池参数的取舍见 [线程池](/java/28_topic_thread_pool)

### 3、数据层用版本号 / 序列号兜底

前两层都只是降低乱序概率，真正保证正确性的是这一层。调用方为同一业务键的每个请求带上单调递增的序列号（或业务时间戳），服务端只接受比当前记录更新的请求：

```java
@Repository
public class OrderStatusRepository {

    private final JdbcClient jdbc;

    public OrderStatusRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** 返回 false 表示请求过期或重复，直接丢弃，不报错 */
    public boolean applyIfNewer(long orderId, String newStatus, long seq) {
        int rows = jdbc.sql("""
                UPDATE t_order
                SET status = :status, last_seq = :seq
                WHERE order_id = :orderId AND last_seq < :seq
                """)
                .param("status", newStatus)
                .param("seq", seq)
                .param("orderId", orderId)
                .update();
        return rows == 1;
    }
}
```

| 业务语义 | 收到乱序请求时 |
|---------|--------------|
| 只关心最终状态（同步资料、库存快照） | `last_seq < :seq` 条件更新，过期请求直接丢弃 |
| 状态机流转（订单：待支付 → 已支付 → 已发货） | 条件里再加 `AND status IN (允许的前置状态)`，非法迁移拒绝，由调用方重试 |
| 每一步都必须执行、不能跳（账务流水） | 要求序列号连续：收到 `seq = n + 2` 而当前是 `n` 时先暂存或拒绝，等 `n + 1` 到达后再按序处理；这类场景通常直接改走 MQ 顺序消息更简单 |

---

## 四、分布式锁不能保证顺序

锁只保证同一时刻只有一个请求在执行，不保证谁先拿到锁：后发出的请求完全可能先抢到锁。它还会让每次调用多一次 Redis 往返，锁过期后两个请求仍可能并发执行。真要用锁，也得配合上面的版本号检查（相当于 Fencing Token），见 [分布式锁](/distributed/3_lock)。

---

## 小结

- 分布式环境下请求的到达顺序和执行顺序都不受发送顺序约束
- 先靠业务设计消掉顺序依赖：调用方串行、合并请求、状态机拒绝、发全量状态
- 确需有序时只保证同一业务键内有序：一致性哈希或 MQ 分区键路由 → 实例内按 key 串行 → 版本号 / 状态机兜底
- 前两层只降低乱序概率，正确性靠数据层的条件更新；分布式锁不保证顺序，用锁也要配合版本号（Fencing Token）

## 参考资料

- Dubbo 负载均衡（一致性哈希）：[https://cn.dubbo.apache.org/zh-cn/overview/what/core-features/load-balance/](https://cn.dubbo.apache.org/zh-cn/overview/what/core-features/load-balance/)
- Nginx upstream hash：[https://nginx.org/en/docs/http/ngx_http_upstream_module.html#hash](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#hash)
- Istio DestinationRule（consistentHash）：[https://istio.io/latest/docs/reference/config/networking/destination-rule/](https://istio.io/latest/docs/reference/config/networking/destination-rule/)

> 下一篇：[注册发现](./10_service_registry) —— 进入 Spring Cloud 落地：注册中心选型与 Nacos 的连接、实例与接入

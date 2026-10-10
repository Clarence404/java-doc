---
description: HTTP 幂等语义、Idempotency-Key、唯一约束、条件更新、消费去重、Redis 状态机、下单与支付回调
---

# 幂等设计

> **本篇目标**：分清 HTTP 语义上的幂等与业务幂等，按「插入 / 更新 / 消费 / 提交」四类操作选对方案；知道 SETNX 占位、事务外去重、锁租约过期这几类常见错误，能把下单防重、支付回调、退款做成可重试的接口。
>
> **前置阅读**：[事务管理](/spring/4_transaction)、[消息队列基础](/messaging/1_basics)

**幂等**：同一个操作执行一次和执行多次，对系统状态的影响相同。注意说的是「状态」，不是「响应」：第二次 `DELETE` 返回 404 也算幂等。

分布式系统里重复请求无法避免：客户端超时重试、网关和 RPC 框架自动重试、MQ 至少一次投递、支付渠道重推回调、用户连点按钮。所以幂等不是「锦上添花」，而是**允许重试的前提**——重试策略见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 一、幂等的语义与幂等键

### 1、重复请求从哪来

| 场景 | 不做幂等的后果 |
|------|------|
| 用户重复点击「提交」 | 创建多笔订单 |
| 网络超时后客户端 / 网关 / Feign / Dubbo 重试 | 重复扣款、重复下单（超时不等于失败，下游可能已经执行成功） |
| MQ 消费成功但确认失败、Rebalance 后位点回退 | 重复加积分、重复发券 |
| 支付渠道重推回调 | 重复记账、重复发货 |
| 多实例定时任务重复触发 | 重复发短信、重复结算 |

### 2、HTTP 方法的幂等语义

[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) 规定了方法层面的语义，它是协议约定，**不等于实现自动幂等**：

| 方法 | 安全（不改状态） | 幂等 | 说明 |
|------|:---:|:---:|------|
| GET / HEAD / OPTIONS | 是 | 是 | 只读；实现里不能夹带「查询即扣次数」之类的副作用 |
| PUT | 否 | 是 | 整体替换资源，多次执行结果相同 |
| DELETE | 否 | 是 | 第二次删除可以返回 404 或 204，服务端状态一致即可 |
| POST | 否 | 否 | 创建、触发动作，需要额外的幂等机制 |
| PATCH | 否 | 否 | 「余额 +10」这类增量修改不幂等；「状态设为 X」这类覆盖修改可以做成幂等 |

能用「设为某值」表达的修改，尽量不要用「增加某值」；客户端能确定资源 ID 时，用 `PUT /orders/{requestNo}` 代替 `POST /orders`，天然幂等。接口风格约定见 [API 设计规范](/engineering/7_api_design_rule)。

### 3、幂等键：用什么判断「是同一次请求」

| 来源 | 例子 | 适用 |
|------|------|------|
| 业务唯一键 | 订单号、支付流水号 `tradeNo`、退款单号、`订单号 + 动作类型` | 首选：重试、补发、换 msgId 都不变 |
| 客户端请求号 | 确认页下发的 `requestNo`、客户端生成的 UUID | 创建类接口，业务上还没有单号时 |
| 中间件 ID | MQ 的 msgId | 不推荐：生产者重试、业务补发时 msgId 会变 |

对外开放的 API 可以采用 IETF 草案 [Idempotency-Key 请求头](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)（Stripe 等支付 API 的通行做法）：

- 客户端为每个「逻辑请求」生成一个唯一值（通常是 UUID），重试时**原样带上同一个值**
- 服务端按 `调用方 + Idempotency-Key` 记录请求指纹（如请求体摘要）与首次的响应，重复请求直接返回首次响应
- 同一个 key 配不同的请求体，返回 422；首次请求还在处理中又收到重试，返回 409；要求必须带 key 却没带，返回 400
- key 要设保留期（如 24 小时），并在接口文档里写明

---

## 二、按操作类型选方案

| 操作类型 | 首选方案 | 补充手段 |
|------|------|------|
| **插入类**（创建订单、支付流水） | 业务键唯一约束，冲突时返回已有记录 | 请求号 / Idempotency-Key 作为唯一列 |
| **更新类**（状态流转、扣减） | 条件更新：`WHERE status = 旧状态` 或 `WHERE version = ?`，按影响行数判断 | 状态机定义合法流转 |
| **消费类**（MQ、回调、事件监听） | 去重记录与业务写入在**同一个本地事务**，唯一约束兜底 | Redis 状态机挡住大量重复 |
| **提交类**（表单、按钮） | 请求号写进业务表的唯一列 | Token 快速拦截、前端按钮置灰 |

推荐优先级：**唯一约束 / 同事务去重记录 > 条件更新（状态机、版本号）> 请求号与 Token（防重复提交）> Redis 状态机（加速层，DB 兜底）**。分布式锁只负责把并发请求串行化，本身不构成幂等方案。

::: warning 常见错误：先 SETNX 占位，再处理业务
`setIfAbsent(key, "1", ttl)` 成功就处理、失败就当作重复跳过：一旦业务抛异常或进程崩溃，占位还在，后续重试（MQ 重投、客户端重试）都会被当成「已处理」跳过，请求就这样丢了。去重标记必须**与业务结果一起提交**（同一个本地事务），或者用带「处理中 / 已完成」状态、失败即删除的 Redis 状态机（见第六节）。
:::

---

## 三、唯一约束：插入类操作

数据库唯一约束是唯一一个**不依赖应用代码正确性**的防线，其他方案都应该以它兜底。

```sql
ALTER TABLE orders  ADD UNIQUE KEY uk_user_request (user_id, request_no);
ALTER TABLE payment ADD UNIQUE KEY uk_trade_no (trade_no);
```

```java
public Order createOrder(CreateOrderCmd cmd) {
    Order order = Order.from(cmd);              // request_no 来自客户端
    try {
        orderMapper.insert(order);
        return order;
    } catch (DuplicateKeyException e) {
        // 重复请求：返回首次创建的订单，而不是报错
        return orderMapper.selectByRequestNo(cmd.userId(), cmd.requestNo());
    }
}
```

要点：

- 冲突时**返回首次结果**，调用方才能放心重试；只打日志忽略会让客户端拿不到订单号
- 先做「查是否存在再插入」有并发窗口，两个请求可能同时查到不存在；它只能当作减少异常的优化，唯一约束不能省
- 插入语句放在事务的第一步，冲突时还没做其他写入
- 在 MySQL 中唯一键冲突只让这条语句失败，事务仍可继续；PostgreSQL 中任何语句报错都会让整个事务失效，应改用 `INSERT ... ON CONFLICT DO NOTHING` 并按影响行数判断
- 不要在内层 `@Transactional` 方法里抛出 `DuplicateKeyException` 再在外层捕获：内层事务边界已把共享事务标记为 rollback-only，外层提交时会抛 `UnexpectedRollbackException`

**通用去重表**：业务表上不方便加唯一约束（比如一个请求要写多张表）时，单独建一张去重表，与业务写入放在同一个事务里：

```sql
CREATE TABLE idem_record (
    biz_type   VARCHAR(32)  NOT NULL,   -- 如 order_create、points_add
    idem_key   VARCHAR(64)  NOT NULL,   -- 业务键或请求号
    created_at DATETIME     NOT NULL,
    PRIMARY KEY (biz_type, idem_key)
);
```

业务失败 → 事务回滚 → 去重记录也不存在 → 重试可以再次执行；并发重复 → 后到的请求在唯一键上等待前者提交后得到冲突，自然跳过。去重记录按保留期定期清理。

---

## 四、条件更新：状态机与版本号

更新类操作不要「先查状态、判断、再无条件 UPDATE」——两个并发请求可能都通过检查。把判断条件写进 UPDATE 的 WHERE，由数据库行锁保证只有一个成功：

```java
public enum OrderStatus {
    PENDING, PAID, SHIPPED, COMPLETED, CANCELLED
}

@Mapper
public interface OrderMapper {
    // 只有 PENDING / PAID 可以取消；已发货、已完成的订单影响行数为 0
    @Update("UPDATE orders SET status = 'CANCELLED', updated_at = NOW() " +
            "WHERE id = #{id} AND status IN ('PENDING', 'PAID')")
    int cancel(@Param("id") long id);

    @Select("SELECT * FROM orders WHERE id = #{id}")
    Order selectById(@Param("id") long id);
}

public void cancelOrder(long orderId) {
    if (orderMapper.cancel(orderId) == 1) {
        return;                                      // 本次成功取消
    }
    Order order = orderMapper.selectById(orderId);
    if (order == null) {
        throw new IllegalArgumentException("订单不存在: " + orderId);
    }
    if (order.getStatus() == OrderStatus.CANCELLED) {
        return;                                      // 已是目标状态：重复请求，按成功返回
    }
    throw new IllegalStateException("当前状态不可取消: " + order.getStatus());
}
```

- 影响行数为 0 时**重新读取当前状态**：已是目标状态按成功返回（幂等），其他状态才报业务错误
- 状态机本身就是幂等的：条件里已经有「旧状态」，不需要再叠加版本号
- 版本号（乐观锁）解决的是「非状态字段的并发覆盖」：客户端读到 `version = 5`，提交时带上 `WHERE id = ? AND version = 5` 并 `version = version + 1`；重复提交带的还是旧版本号，影响行数为 0，此时读取当前值，已经是期望结果就返回成功，否则返回 409 让用户刷新
- 扣减类操作用 `SET stock = stock - #{n} WHERE id = ? AND stock >= #{n}` 防超卖，但扣减本身不幂等，需要配合扣减流水的唯一约束（`uk_order_sku`）

---

## 五、消费幂等：同事务去重记录

MQ、领域事件、Spring 事件监听都是至少一次投递，**「至少一次投递 + 幂等消费 = 效果上恰好一次」**，不要指望中间件给出端到端的 exactly-once。

```java
@Transactional(rollbackFor = Exception.class)
public void onOrderPaid(OrderPaidEvent evt) {
    try {
        idemRecordMapper.insert("points_add", evt.orderNo());   // 业务键，不用 msgId
    } catch (DuplicateKeyException e) {
        return;                                                  // 已处理过：确认消息
    }
    pointsService.addPoints(evt.userId(), evt.amount());         // 与去重记录同事务提交
}
```

- 去重键用**业务键**（订单号 + 动作），不要用 Broker 的 msgId
- `@Transactional` 只在通过 Spring 代理调用时生效：监听器调用本类的这个方法会让事务失效，应放到另一个 Bean 中
- 消费结果不在同一个库时（例如调用外部接口），用第六节的 Redis 状态机，外部接口再以业务键做幂等
- 各 MQ 的确认、重投与死信细节见 [消息队列基础](/messaging/1_basics)

---

## 六、Redis 状态机：加速层

当重复请求量很大、想在数据库之前挡掉，或业务结果不落在同一个库时，用带状态的占位，而不是「占位即完成」：

![Redis 幂等状态机](../assets/architecture/idem-redis-state.svg)

```java
@Component
public class IdempotentExecutor {
    private static final String PROCESSING = "PROCESSING";
    private static final String DONE = "DONE:";
    private final StringRedisTemplate redis;

    public IdempotentExecutor(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** 同一个 key 只执行一次 action，重复调用返回首次结果 */
    public String runOnce(String key, Supplier<String> action) {
        Boolean first = redis.opsForValue()
                .setIfAbsent(key, PROCESSING, Duration.ofMinutes(2));   // 短 TTL：大于最长处理时间
        if (!Boolean.TRUE.equals(first)) {
            String value = redis.opsForValue().get(key);
            if (value == null || PROCESSING.equals(value)) {
                throw new RetryLaterException("请求处理中，请稍后重试");  // 不能当成功返回
            }
            return value.substring(DONE.length());                      // 已完成：返回首次结果
        }
        try {
            String result = action.get();
            redis.opsForValue().set(key, DONE + result, Duration.ofDays(1)); // 长 TTL：覆盖重试窗口
            return result;
        } catch (RuntimeException e) {
            redis.delete(key);                                           // 失败释放占位，允许重试
            throw e;
        }
    }
}

public class RetryLaterException extends RuntimeException {
    public RetryLaterException(String message) { super(message); }
}
```

- 看到 `PROCESSING` 只能返回「处理中」（HTTP 409 / MQ 不确认等待重投），**不能当作成功**，否则前一次处理失败时这次请求就丢了
- 处理时间超过短 TTL 时占位会过期，另一个请求可能并发执行；更严格的做法是占位值带 UUID，完成和释放时用 Lua 比较后再改写或删除（同分布式锁的释放方式，见 [分布式锁](/distributed/3_lock)）
- Redis 与业务库不是原子的：业务已提交但 `DONE` 没写成功、或 Redis 主从切换丢了 key，都会让请求再执行一次，所以业务层仍要有唯一约束或条件更新兜底

---

## 七、Token 与请求号：防重复提交

经典 Token 机制：打开页面时领取 Token，提交时原子地「校验并删除」，删除成功才处理。

```java
private static final DefaultRedisScript<Long> CHECK_AND_DEL = new DefaultRedisScript<>(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        Long.class);

public String issueToken(String userId) {
    String token = UUID.randomUUID().toString();
    redis.opsForValue().set("idem:token:" + token, userId, Duration.ofMinutes(10));  // 覆盖填表时间
    return token;
}

public boolean consumeToken(String token, String userId) {
    Long deleted = redis.execute(CHECK_AND_DEL, List.of("idem:token:" + token), userId);
    return Long.valueOf(1L).equals(deleted);
}
```

Token 有两个局限：校验时就被删除，之后业务失败，用户重试会被拒为「重复提交」（需要重新签发 Token）；并发重复请求拿到的是报错而不是首次结果。所以**生产上更推荐把 Token 当作请求号写进业务表的唯一列**（第三节的 `uk_user_request`）：重复提交返回首次创建的订单，失败的请求可以带同一个请求号安全重试。Redis 里的 Token 校验只作为快速拦截。

---

## 八、分布式锁：只做串行化

分布式锁能让同一业务键的请求排队执行，但它不记录「做没做过」，也会因为租约过期失效，**不能单独承担幂等**。确实要用时，锁内仍要有条件更新作为真正的判断：

```java
public RefundResult refund(String refundNo) {
    RLock lock = redisson.getLock("lock:refund:" + refundNo);
    boolean locked;
    try {
        locked = lock.tryLock(0, TimeUnit.SECONDS);   // 不传 leaseTime：启用看门狗自动续期
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RetryLaterException("线程被中断");
    }
    if (!locked) {
        throw new RetryLaterException("退款处理中");   // 拿不到锁 ≠ 已处理
    }
    try {
        // 真正的防线：PENDING → PROCESSING 的条件更新，只有一个请求能成功
        if (refundMapper.markProcessing(refundNo) == 0) {
            Refund current = refundMapper.selectByNo(refundNo);
            if (current == null) {
                throw new IllegalArgumentException("退款单不存在: " + refundNo);
            }
            return RefundResult.of(current);           // 已处理或处理中：返回当前状态
        }
        Refund refund = refundMapper.selectByNo(refundNo);
        payClient.refund(refundNo, refund.getAmount()); // 退款单号作为渠道侧幂等键
        refundMapper.markSuccess(refundNo);
        return RefundResult.of(refundMapper.selectByNo(refundNo));
    } finally {
        if (lock.isHeldByCurrentThread()) {
            lock.unlock();
        }
    }
}
```

- `tryLock(wait, lease, unit)` 显式传入租约会关闭看门狗，业务超过租约时锁提前释放，第二个请求进入；`unlock` 前判断 `isHeldByCurrentThread()`，避免释放别人的锁时抛 `IllegalMonitorStateException`
- 即使用了看门狗，GC 停顿、网络分区仍可能让两个节点同时以为自己持锁，所以锁内的条件更新不能省（这也是 fencing token 的思路）
- 调用外部渠道失败或超时，退款单停在 `PROCESSING`，由补偿任务按退款单号向渠道**查询**结果后推进，而不是直接重新发起退款
- 有了条件更新，这里的锁其实可以去掉；保留它只是为了减少并发请求打到数据库和外部渠道。锁的实现与 Redlock 争议见 [分布式锁](/distributed/3_lock)

---

## 九、业务案例：下单与支付回调

### 1、下单防重

1. 用户打开确认页时，服务端生成请求号 `requestNo` 下发（或由客户端生成 UUID），同一个确认页只用一个请求号
2. 提交时带上 `Idempotency-Key: {requestNo}`；前端按钮置灰只是体验优化，不是防线
3. 服务端在一个事务里插入订单（`uk_user_request` 唯一约束）、写库存扣减流水、写 Outbox 消息
4. 唯一键冲突 → 返回首次创建的订单号；事务失败 → 整体回滚，客户端可带同一个请求号重试
5. 订单创建后的通知、延时关单消息都走 Outbox 或事务消息，不在事务里直接发 MQ，见 [消息队列基础](/messaging/1_basics)

### 2、支付回调

支付渠道会多次推送同一笔结果，也可能先推「成功」再推「成功」、或在订单已取消后才推「成功」：

```java
@Transactional(rollbackFor = Exception.class)
public void onPaid(PayNotify notify) {
    // 验签、金额与商户号校验在调用本方法前完成
    int rows = orderMapper.markPaid(notify.orderNo(), notify.tradeNo());  // WHERE order_no = ? AND status = 'PENDING'
    if (rows == 0) {
        Order order = orderMapper.selectByOrderNo(notify.orderNo());
        if (order != null && order.getStatus() == OrderStatus.PAID
                && notify.tradeNo().equals(order.getTradeNo())) {
            return;                                    // 重复通知：直接按成功应答
        }
        throw new PayStateException("订单状态异常，进入人工或自动退款流程: " + notify.orderNo());
    }
    paymentMapper.insert(Payment.from(notify));        // uk_trade_no 兜底
    outboxMapper.insert(OutboxMessage.orderPaid(notify.orderNo()));  // 发货、积分等下游通知
}
```

- 事务提交后再给渠道应答「成功」；处理失败返回失败，让渠道按其重试策略重推
- 「已取消订单收到支付成功」不能简单忽略，要走退款或人工处理
- 回调可能永远不来：用定时任务对超时未支付的订单**主动查询**渠道，与回调走同一个幂等入口

---

## 十、方案对比

| 方案 | 适用操作 | 并发安全 | 失败后能否重试 | 说明 |
|------|------|------|------|------|
| 唯一约束 / 去重表（同事务） | 插入、消费 | 是，数据库保证 | 能，回滚后记录不存在 | 首选，其他方案的兜底 |
| 条件更新（状态机） | 状态流转 | 是，行锁保证 | 能 | 影响行数为 0 时读当前状态 |
| 版本号 | 非状态字段更新 | 是 | 能 | 解决并发覆盖，需客户端携带版本 |
| 请求号 / Idempotency-Key | 创建类接口 | 依赖唯一约束 | 能，带同一请求号 | 返回首次结果 |
| Token（校验即删除） | 表单提交 | 是，Lua 原子 | 需重新签发 | 只做快速拦截 |
| Redis 状态机 | 任意，加速层 | 是 | 能，失败删除占位 | 与 DB 非原子，需兜底 |
| 分布式锁 | 任意 | 依赖租约 | — | 只串行化，不记录结果 |

---

## 小结

- 幂等看的是对系统状态的影响；HTTP 方法的幂等是协议语义，POST / PATCH 需要业务自己做
- 幂等键优先用业务键，其次客户端请求号；对外 API 可采用 `Idempotency-Key` 请求头，重复请求返回首次响应
- 插入靠唯一约束，更新靠条件更新，消费靠同事务去重记录，提交靠请求号写进唯一列
- 不要「先 SETNX 占位再处理」：去重标记要与业务结果一起提交，或用处理中 / 已完成状态机并在失败时删除
- 分布式锁不传租约才有看门狗，锁内仍需条件更新；拿不到锁返回「处理中」而不是「重复」
- 支付回调：验签 → 条件更新 → 同事务记账与 Outbox → 提交后应答，并配合主动查询补偿

## 参考资料

- RFC 9110 HTTP Semantics · Idempotent Methods：[https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2)
- The Idempotency-Key HTTP Header Field（IETF 草案）：[https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- Stripe API · Idempotent requests：[https://docs.stripe.com/api/idempotent_requests](https://docs.stripe.com/api/idempotent_requests)
- PostgreSQL INSERT · ON CONFLICT：[https://www.postgresql.org/docs/current/sql-insert.html](https://www.postgresql.org/docs/current/sql-insert.html)
- Redisson · Locks and synchronizers：[https://redisson.org/docs/data-and-services/locks-and-synchronizers/](https://redisson.org/docs/data-and-services/locks-and-synchronizers/)
- Spring Data Redis · Scripting：[https://docs.spring.io/spring-data/redis/reference/redis/scripting.html](https://docs.spring.io/spring-data/redis/reference/redis/scripting.html)

> 下一篇：[权限系统架构设计](./6_access_control) —— 权限系统的 PEP / PDP 部署、网关与服务的鉴权分工、权限缓存刷新与数据权限拦截。

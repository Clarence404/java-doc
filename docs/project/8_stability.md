---
description: 首次大促的故障复盘、超时熔断与舱壁、重试风暴治理、按用户限流与下单频控、热点库存分桶、降级开关、压测与大促预案
---

# 稳定性

> 前置阅读：[跨服务一致性](./7_consistency)、[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)、[限流与过载保护](/high-avail/7_rate_limiting)

大促把下单峰值从日常约 300 QPS 推到 5000 QPS，库存服务一慢就拖垮整条下单链路。本篇讲超时熔断与隔离、限流与频控、热点库存分桶、降级、压测与大促预案，基线为 Spring Boot 4、Spring Cloud 2025.1、Resilience4j 2。

---

## 一、背景

阶段三的拆分和一致性改造上线后，第一次年中大促只做了一件准备：把 `mall-app` 从 4 个 Pod 临时扩到 8 个。0 点开抢，下单请求在一分钟内冲到约 4000 QPS，随后 25 分钟的下单成功率只有 58%：

| 时间 | 现象 | 根因 |
|------|------|------|
| 00:00 | `reserve` 的 P99 从 30ms 涨到 1.5s | 20 个爆款 SKU 的预占都是同一行 `t_inventory` 的条件更新，单行实测只扛约 600 TPS，其余请求排队等行锁 |
| 00:01 | 商品详情、订单列表也开始超时 | 等 `reserve` 的请求占住 Tomcat 线程：4000 QPS × 0.8s 读超时 ≈ 3200 个并发，8 个 Pod 一共只有 1600 个线程，同进程里的其他接口跟着排队 |
| 00:03 | 网关入口请求涨到约 9000 QPS | 用户连点、App 自动重试 2 次；每个超时的 `reserve` 还会触发一次 `release`，库存服务收到的请求翻倍 |
| 00:08 | 部分订单 `t_outbox` 积压 8 分钟 | RocketMQ 托管实例按日常规格购买，发送 TPS 触到上限被限流 |
| 00:25 | 恢复 | 值班手动下架 3 个爆款并滚动重启 `mall-app` |

事后还发现另一类问题：某个 2000 件的爆款，开抢前 15 分钟有 1100 件被约 300 个账号下单不付款锁住，真实用户看到「已售罄」，15 分钟后这些订单超时关单，库存才回来。

下一次大促是双 11，按历史数据预估：下单峰值 5000 QPS，商品详情读峰值约 6 万 QPS，日常仍在 300 QPS 左右。团队还是 20 人，新增 1 名专职 SRE。[拆分服务](./6_split) 和 [跨服务一致性](./7_consistency) 留下的几个问题这次必须一起解决：

- 库存服务变慢会拖住下单线程，故障沿调用链扩散
- `reserve` 结果未知时立即释放，加上客户端重试，形成重试风暴
- 预占在付款前就锁住库存，恶意下单不付款就能让爆款「售罄」
- 同一 SKU 的预占是单行条件更新，5000 QPS 下成为写热点，行锁排队
- RocketMQ 托管实例从没按大促流量评估过容量

---

## 二、选项

| 问题 | 候选方案 | 放到青柚的代价 |
|------|---------|---------------|
| 熔断与隔离 | 只靠超时 / Spring Framework 7 `@Retryable` + `@ConcurrencyLimit` / Resilience4j / Sentinel | 只靠超时，下游持续变慢时线程照样被占满；框架内置注解没有熔断状态机；Sentinel 要部署 Dashboard，规则持久化到 Nacos 要自己改造；Resilience4j 是进程内库，配置随 Nacos 刷新，但没有控制台 |
| 限流放在哪层 | Ingress `limit_req` / `mall-gateway` 的 `RequestRateLimiter` / `mall-app` 内 | Ingress 拿不到用户身份，会误伤同一出口 IP；网关已校验 JWT，能按「用户 + 接口」限，但依赖 Redis；`mall-app` 能看懂业务规则，却挡不住流量 |
| 热点库存 | 维持单行 / 分桶 / Redis 预扣 / 合并更新 | 单行约 600 TPS 是硬上限；分桶要处理「总数够、当前桶不够」；Redis 预扣有两份库存要对账，Sentinel 切换可能丢写超卖，预占模型要重写；合并更新让每个请求多等一个批次窗口 |
| 压测在哪做 | 生产全链路压测 / 同构压测环境 / 只压单接口 | 生产压测要每个服务和中间件都识别压测标记，漏一处就污染生产；同构环境要按生产规格搭一套、造数据；只压单接口测不出跨服务的线程、连接池和 MQ 瓶颈，年中大促就是这么漏掉的 |

熔断组件的完整对比见 [熔断 · 选型：Sentinel、Resilience4j 与 Hystrix](/high-avail/5_circuit_breaking#四、选型-sentinel、resilience4j-与-hystrix)，热点方案的原理见 [热点问题 · 写热点：热点行更新](/high-con/6_hotspot#三、写热点-热点行更新)，影子库的做法见 [容量评估与规划 · 全链路压测与影子库](/high-con/8_capacity_planning#五、全链路压测与影子库)。

---

## 三、决策

![大促下单链路的分层保护](../assets/project/stability-protection-layers.svg)

| 问题 | 决策 |
|------|------|
| 库存服务变慢拖住下单 | 超时预算收紧：网关整体 5s → 3s，`reserve` 读超时 800ms → 500ms（连接仍为 200ms）；Resilience4j 熔断实例 `inventory-reserve`、`payment-query`，信号量舱壁限制调用库存服务的并发 |
| 重试风暴 | 写接口一律不自动重试；只读查询最多重试 1 次并加随机退避；熔断或舱壁拒绝时快速失败，也不再调 `release` |
| 恶意下单不付款 | 网关 `RequestRateLimiter` 按「用户 + 接口」限流；下单频控：每个用户同一 SKU 的待支付订单最多 2 单；活动 SKU 支付超时从 15 分钟缩短为 5 分钟 |
| 单 SKU 写热点 | 只对活动白名单 SKU 分桶，表 `t_inventory_bucket`，默认 10 桶，按 `order_no` 哈希选桶、桶空换桶 |
| 非核心功能拖累核心 | 降级开关放 Nacos 配置 `qingyou.degrade.*`，由 SRE 与值班负责人决定开关 |
| 容量心里没底 | Gatling 在同构压测环境按 1.5 倍峰值即 7500 QPS 压测；生产只在低峰做只读压测 |
| 大促当天的执行 | 提前 3 天扩容、缓存预热、大促前 48 小时发布冻结、值班表与预案演练、RocketMQ 容量评估 |

**不选 Sentinel**：要的熔断和舱壁 Resilience4j 都有，限流已经在网关做了，没有必要再为一个控制台多运维一套 Dashboard 和规则持久化。

### 明确不做

| 不做 | 原因 | 什么时候做 |
|------|------|-----------|
| Redis 预扣库存 | 5000 QPS 分到 20 个爆款，每个 SKU 最多两三千 TPS，10 个桶就够；预扣会让库存有两份，和 [跨服务一致性](./7_consistency) 的预占、对账全部要重做 | 单 SKU 每秒上万的秒杀活动，届时单独走 [秒杀](/scenario/4_seckill) 的链路 |
| 网关全局总量限流 | 全局令牌桶的所有请求都落在同一个 Redis key 上，自己成了热点；总量保护交给服务内的舱壁和熔断 | 出现外部恶意流量打满网关时，在 Ingress 按 IP 加 |
| 生产全链路压测 | 影子库改造涉及 4 个服务和 RocketMQ，一次漏改就污染生产数据 | 压测环境与生产的差异大到结论不可信时 |
| 大促依赖 HPA 自动扩容 | 0 点尖峰在一分钟内到达，Pod 启动加预热要 2 分钟，扩容赶不上 | 日常仍保留 HPA，大促按预案提前扩 |
| 自适应限流 | 阈值靠压测定、按预案调，团队还没有足够的数据支撑自动调整 | 大促次数多了、积累了容量曲线以后 |

---

## 四、超时、熔断与舱壁

### 1、超时预算

从外往里，超时一层比一层短，外层要能覆盖内层的全部尝试：

| 位置 | 超时 | 说明 |
|------|------|------|
| `mall-gateway` → 下游 | 整体 3s | 由 [拆分服务](./6_split) 的 5s 收紧，超过 3s 用户早已离开或重试 |
| `mall-app` → `inventory-service` 的 `reserve` | 连接 200ms / 读 500ms | 由阶段三的 800ms 收紧：分桶后的压测里 `reserve` 在 7500 QPS 下 P99 约 120ms，500ms 仍有 4 倍余量；而按 Little 定律，每慢 300ms，每个 Pod 就要多占约 90 个线程 |
| `mall-app` → `payment-service` 的查询 | 连接 200ms / 读 500ms | 只读，允许重试 1 次 |
| 库存库 HikariCP 获取连接 | 200ms | 池子耗尽时快速失败，不在应用里排队 |

超时值怎么定、为什么外层要覆盖内层，见 [超时、重试与隔离 · 超时值怎么定](/high-avail/4_timeout_retry_bulkhead#_3、超时值怎么定)。

### 2、熔断与舱壁配置

```yaml
# mall-app 在 Nacos 中的配置（节选）
spring:
  http:
    serviceclient:
      inventory-service: {connect-timeout: 200ms, read-timeout: 500ms}
      payment-service: {connect-timeout: 200ms, read-timeout: 500ms}
  cloud:
    circuitbreaker:
      resilience4j:
        disable-time-limiter: true                # 超时只由 HTTP 客户端控制，避免 TimeLimiter 默认 1s 抢先触发
resilience4j:
  circuitbreaker:
    instances:
      inventory-reserve:
        sliding-window-type: TIME_BASED
        sliding-window-size: 10                   # 统计最近 10 秒
        minimum-number-of-calls: 100
        failure-rate-threshold: 50
        slow-call-duration-threshold: 300ms       # 慢于 300ms 记为慢调用
        slow-call-rate-threshold: 60
        wait-duration-in-open-state: 5s
        permitted-number-of-calls-in-half-open-state: 20
        record-failure-predicate: com.qingyou.common.remote.RemoteFailurePredicate   # 只记超时与 5xx
      payment-query: {sliding-window-type: TIME_BASED, sliding-window-size: 10, minimum-number-of-calls: 50, failure-rate-threshold: 50, wait-duration-in-open-state: 10s}
  bulkhead:
    instances:
      inventory-reserve:
        max-concurrent-calls: 60                  # 每个 Pod 同时调用库存服务的上限
        max-wait-duration: 0                      # 拿不到许可立即拒绝，不排队
```

- **`STOCK_INSUFFICIENT` 不计入失败**：`RemoteFailurePredicate` 只把超时、连接失败和 5xx 记为失败，4xx 是正常的业务结果，否则爆款卖完时熔断器会误以为库存服务坏了
- **舱壁用信号量而不是线程池**：调用仍在 Tomcat 线程里执行，没有线程切换；配额按 [性能指标 · 指标之间的关系：Little 定律](/high-perf/1_metrics#四、指标之间的关系-little-定律) 估：大促时每个 Pod 约 310 QPS，P99 30ms 时稳态并发约 10，取 60 能容忍 P99 涨到约 200ms；再慢就拒绝，最多占住 60 个线程，其余 140 个线程留给商品详情和订单查询
- 参数含义与 Resilience4j 的接入方式见 [服务治理 · Resilience4j 与 Sentinel](/microservices/14_service_governance#_1、resilience4j-与-sentinel)，信号量与线程池舱壁的取舍见 [超时、重试与隔离 · 信号量隔离](/high-avail/4_timeout_retry_bulkhead#_2、信号量隔离)

### 3、下单侧：被拒绝就是确定失败

[跨服务一致性](./7_consistency) 里 `PlaceOrderService` 对 `reserve` 的处理只有两类：明确失败直接抛，结果未知先释放。熔断和舱壁带来了第三类：请求根本没发出去。

```java
// mall-app：com.qingyou.order.place.PlaceOrderService（阶段四，节选）
try {
    inventoryReserveClient.reserve(new ReserveStockRequest(orderNo, lines));  // 经 inventory-reserve 熔断器与舱壁
} catch (RemoteBizException e) {
    throw e;                                          // STOCK_INSUFFICIENT：明确失败
} catch (CallNotPermittedException | BulkheadFullException e) {
    throw new BizException(CommonErrorCode.SYSTEM_BUSY);   // 没发出去：库存没动，不需要 release
} catch (RuntimeException e) {                        // 超时或 5xx：结果未知
    releaseQuietly(orderNo, lines);                   // release 同样经过熔断器，被拒绝时交给过期回查
    throw e;
}
```

`InventoryReserveClient` 是对 `InventoryApi` 的一层包装，用 `CircuitBreakerFactory.create("inventory-reserve")` 执行调用并原样抛出异常。`SYSTEM_BUSY` 是 `mall-common` 新增的通用错误码，返回 503 并带 `Retry-After: 2`，App 显示「当前人数较多，请稍后再试」。熔断打开的 5 秒里，下单请求在 `mall-app` 内就失败返回，Tomcat 线程不再被占住，商品详情和订单查询照常可用。

`release` 被熔断器拒绝时，预占记录保持 RESERVED，由 [跨服务一致性](./7_consistency) 的 `ReservationExpireJob` 回收。活动 SKU 的支付超时缩短为 5 分钟后，它们的 `expire_at` 随之变为下单后 20 分钟，大促期间这个任务从每 5 分钟改为每分钟运行一次，尽快把库存还回来。

### 4、降级

熔断解决的是「下游坏了怎么办」，降级解决的是「容量不够时先舍弃什么」。开关统一放在 Nacos：

```yaml
# Nacos：mall-app.yaml（大促时的取值）
qingyou:
  degrade:
    recommend-enabled: false        # 商品详情、购物车的「猜你喜欢」，关闭后返回运营配置的固定列表
    points-display-enabled: false   # 订单详情、我的页面不再实时查积分
    order-list-months: 3            # 订单列表只查近 3 个月；0 表示不限制
```

应用里用 `@ConfigurationProperties(prefix = "qingyou.degrade")` 绑定到 `DegradeProperties`，Nacos 推送后实时生效。订单列表只查近 3 个月时，由 3 个月前的时间算出雪花 ID 的下界，追加 `AND id >= ?`，仍走 `idx_user_id (user_id, id)`，不需要新索引。

| 级别 | 什么时候 | 谁决定 |
|------|---------|--------|
| 预案降级 | 大促开始前 1 小时，按预案关掉推荐和积分展示 | 值班负责人按预案执行，不需要再讨论 |
| 应急降级 | `mall-app` 的 CPU 持续超过 70%，或下单 P99 超过 800ms | SRE 提出，值班负责人拍板，在值班群里记录开关的人和时间 |
| 恢复 | 峰值过去 30 分钟，指标回落 | 同上，按相反顺序逐个打开 |

下单、支付、库存三条核心链路不设降级开关，只靠限流和熔断保护。降级手段与开关的写法见 [降级 · 动态降级：配置中心开关](/high-avail/6_degradation#_2、动态降级-配置中心开关)。

---

## 五、重试风暴

年中大促的 9000 QPS 里，一大半是重试出来的。治理原则是**只在一层重试，写操作不重试**，每一层的做法：

| 层 | 原来 | 现在 |
|----|------|------|
| App | 失败自动重试 2 次；按钮可以连点 | 提交后按钮置灰；用户手动重试沿用同一个 `Idempotency-Key`；收到 429、503 时按 `Retry-After` 等待 |
| `mall-gateway` | 未配置重试 | 保持不配 `Retry` 过滤器，网关只负责超时 |
| `mall-app` → 写接口（`reserve`、`release`、`confirm`） | 不重试 | 不变；结果未知按失败处理，靠幂等键和过期回查收敛 |
| `mall-app` → 只读查询（库存展示、支付单查询） | 不重试 | 最多重试 1 次，随机退避 20–80ms |
| 熔断打开或舱壁满 | 无 | 直接失败，不重试也不 `release` |
| RocketMQ 消费 | 阶梯退避重投 | 不变，消费端幂等 |

只读查询的重试用 Spring Framework 7 自带的注解：

```java
// mall-app：com.qingyou.product.stock.StockQueryService
@Retryable(includes = ResourceAccessException.class, maxRetries = 1, delay = 20, jitter = 60)
public List<StockView> listStocks(List<Long> skuIds) {
    return inventoryApi.listStocks(skuIds);           // 失败时商品详情改用 Redis 里 10 秒 TTL 的「有货」提示
}
```

为什么多层重试会成倍放大、重试预算怎么算，见 [超时、重试与隔离 · 重试放大控制](/high-avail/4_timeout_retry_bulkhead#_3、重试放大控制)。

---

## 六、限流与下单频控

### 1、网关按「用户 + 接口」限流

下单单独拆出一条路由，阈值比其他接口严：

```yaml
# mall-gateway 在 Nacos 中的配置（节选）
spring:
  cloud:
    gateway:
      server:
        webflux:
          httpclient:
            response-timeout: 3s
          routes:
            - id: order-place
              uri: lb://mall-app
              order: 10
              predicates:
                - Path=/api/orders
                - Method=POST
              filters:
                - name: RequestRateLimiter
                  args:
                    redis-rate-limiter.replenishRate: 1     # 每个用户每秒 1 次
                    redis-rate-limiter.burstCapacity: 3     # 允许连点 3 次的突发
                    key-resolver: "#{@userRouteKeyResolver}"
            # 兜底路由 mall-app（/api/**）挂同样的过滤器，每个用户每秒 20 次、突发 40，略
```

```java
// mall-gateway：com.qingyou.gateway.RateLimitConfig
@Bean
KeyResolver userRouteKeyResolver() {
    return exchange -> exchange.getPrincipal()           // 网关已校验 JWT，principal 名即用户 ID
            .map(p -> p.getName() + ":" + exchange.<Route>getAttribute(GATEWAY_ROUTE_ATTR).getId());
}
```

`RedisRateLimiter` 的 Redis key 只由 `KeyResolver` 的结果决定，所以要把路由 ID 拼进去，否则同一用户在所有路由上共用一个桶。未登录请求取不到 principal，按默认的 `deny-empty-key` 直接拒绝；商品详情这类匿名可访问的接口走单独的路由，不挂这个过滤器。限流用的是阶段二那套 Redis 8 主从，Redis 故障时 `RedisRateLimiter` 默认放行，这是有意的选择：限流挂了不能让下单跟着挂。参数含义见 [API 网关 · 限流](/microservices/11_api_gateway#五、限流)，各层限流的分工见 [限流与过载保护 · 限流放在哪一层](/high-avail/7_rate_limiting#二、限流放在哪一层)。

### 2、下单频控

网关限流挡得住脚本刷接口，挡不住 300 个账号每人慢慢下几单。频控在 `mall-app` 里按业务规则做，放在计价之后、`reserve` 之前：

```sql
-- 该用户在本次下单 SKU 上的待支付订单数；id 下界取 30 分钟前的雪花 ID，只扫该用户最近的订单
SELECT i.sku_id, COUNT(*) AS cnt
FROM t_order o
JOIN t_order_item i ON i.order_id = o.id
WHERE o.user_id = ? AND o.id >= ? AND o.status = 10
  AND i.sku_id IN (?, ?, ?)
GROUP BY i.sku_id;
```

任一 SKU 的 `cnt` 已经达到 2 就返回 409 和 `ORDER_PENDING_LIMIT`，提示「您有未支付的订单，请先完成支付」。这里没有加锁，同一用户的并发请求可能都通过检查，多出一单；网关已经把每个用户限制在每秒 1 次，这点误差可以接受。

另一半是缩短锁定时间：活动白名单 SKU 放在 Nacos 配置 `qingyou.promo.activity-sku-ids`，订单里只要有一个活动 SKU，`order-timeout` 定时消息就按 5 分钟投递。两条一起作用后，一个账号最多锁住同一爆款 2 件、5 分钟。限流之外的防刷手段（接口签名、设备指纹、风控）不在本系列范围内，思路见 [秒杀](/scenario/4_seckill#_2、防刷)。

---

## 七、热点库存分桶

![活动 SKU 的分桶预占](../assets/project/hot-inventory-buckets.svg)

### 1、表结构

```sql
-- qingyou_inventory 库
ALTER TABLE t_inventory ADD COLUMN bucket_count TINYINT NOT NULL DEFAULT 0 COMMENT '0 不分桶';
ALTER TABLE t_inventory_reservation ADD COLUMN bucket_no TINYINT NULL COMMENT 'confirm / release 回到同一个桶';

CREATE TABLE t_inventory_bucket (
    sku_id     BIGINT      NOT NULL,
    bucket_no  TINYINT     NOT NULL,
    stock      INT         NOT NULL COMMENT '本桶可售',
    reserved   INT         NOT NULL DEFAULT 0 COMMENT '本桶已预占未确认',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (sku_id, bucket_no)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '活动 SKU 分桶库存';

-- 预占：从哈希桶开始依次尝试，影响 1 行即成功
UPDATE t_inventory_bucket
SET stock = stock - ?, reserved = reserved + ?
WHERE sku_id = ? AND bucket_no = ? AND stock >= ?;
```

### 2、怎么用

- **只拆活动白名单 SKU**：大促前一天，库存组对白名单里的 SKU 执行 `InventoryBucketService.split(skuId, 10)`，在一个事务里锁住 `t_inventory` 这一行，把 `stock` 平均分到 10 个桶，再把 `bucket_count` 置为 10；其余几万个 SKU 继续走单行条件更新，代码路径不变
- **为什么是 10 桶**：压测里单行约 600 TPS；最热的 SKU 预计吃掉峰值的 40%，即约 2000 TPS，按 1.5 倍余量要 3000 TPS，10 个桶的上限约 6000 TPS
- **选桶与换桶**：`reserve` 读到 `bucket_count > 0` 时，从 `hash(order_no) % 10` 号桶开始执行上面的 UPDATE，影响 0 行就试下一个桶，10 个桶都不够才返回 `STOCK_INSUFFICIENT`；选中的桶号写进预占记录，`confirm`、`release` 按记录回到同一个桶
- **隔离级别**：库存库用 READ COMMITTED，条件不满足的 UPDATE 在语句结束就释放行锁，换桶时不会被空桶的锁拖住
- **再平衡**：`BucketRebalanceJob` 每 5 秒检查一次，把余量最多的桶匀一半给已空的桶，避免「总数还有、每个桶都不够」；活动 SKU 每单限购 1–2 件，最后几件时的误判影响很小
- **大促结束**：低峰时执行 `InventoryBucketService.merge`，等各桶的预占都确认或释放后，把余量并回 `t_inventory`，`bucket_count` 置回 0

分桶后商品页展示的库存是各桶 `stock` 之和，仍经 10 秒 TTL 的缓存；[跨服务一致性](./7_consistency) 的每日对账中「预占 vs 库存」一项，对分桶 SKU 改为按桶汇总比对。通用做法见 [库存与票务 · 热点 SKU：拆分库存](/scenario/22_inventory#七、热点-sku-拆分库存) 与 [热点问题 · 分桶库存](/high-con/6_hotspot#_3、分桶库存)。

---

## 八、压测

压测脚本放在 `qingyou-mall` 的 `perf` 模块，用 Gatling 的 Java DSL 编写，和业务代码同仓、同一套 Maven 构建：

```java
// perf：com.qingyou.perf.PromoSimulation
public class PromoSimulation extends Simulation {
    // protocol 与 feeder 定义略：压测环境预置 20 万个账号（每人每秒限流 1 次，账号要足够分散），SKU 按预估分布集中在 20 个爆款
    ScenarioBuilder placeOrder = scenario("place-order")
            .feed(users).feed(skus)
            .exec(http("POST /api/orders").post("/api/orders")
                    .header("Authorization", "Bearer #{token}")
                    .header("Idempotency-Key", session -> UUID.randomUUID().toString())
                    .body(ElFileBody("place-order.json"))
                    .check(status().in(201, 409)));                     // 409 库存不足属于正常结果

    {
        setUp(placeOrder.injectOpen(
                        rampUsersPerSec(500).to(7500).during(Duration.ofMinutes(10)),
                        constantUsersPerSec(7500).during(Duration.ofMinutes(15))))
                .protocols(protocol)
                .assertions(
                        details("POST /api/orders").responseTime().percentile(99.0).lt(800),
                        details("POST /api/orders").failedRequests().percent().lt(0.1));
    }
}
```

- **目标 7500 QPS**：峰值 5000 QPS 的 1.5 倍；用开放模型（`injectOpen`）按到达率注入，后端变慢时压力不会自动减小，才能暴露排队问题。商品详情的读流量用另一组压测机，按 9 万 QPS 同时压。开放与闭合模型的区别见 [性能测试 · Gatling：Java DSL](/testing/7_performance_test#五、gatling-java-dsl)，压测与 JMH 的分工见 [基准测试（JMH） · JMH 与压测的分工](/high-perf/4_benchmark#六、jmh-与压测的分工)
- **在哪里压**：压测环境与生产同构，Pod 规格与数量、MySQL 实例规格、RocketMQ 托管实例规格都与大促当天一致，数据按生产量级造；生产不写压测数据，只在凌晨低峰对商品详情做只读压测，验证 CDN、Ingress 和缓存这几层

三轮压测的结果如下，第 3 轮的故障注入就是一次预案演练，做法见 [混沌工程](/high-avail/10_chaos_engineering)：

| 轮次 | 结果 | 发现 | 处理 |
|------|------|------|------|
| 1 | 2600 QPS 出现拐点，P99 2.4s | 爆款单行锁排队 | 活动 SKU 分桶 |
| 2 | 6100 QPS 时 `inventory-service` 报获取连接超时 | 每个 Pod 的 HikariCP 30 个连接不够 | 连接池调到 40，`inventory-service` 扩到 8 Pod，库存库 `max_connections` 相应调高 |
| 3 | 7500 QPS 稳定 15 分钟，P99 520ms，失败率 0.03% | 无 | 再对库存服务注入 800ms 延迟，确认熔断 5 秒内打开、商品详情不受影响 |

---

## 九、大促预案

### 1、时间线

| 时间 | 事项 | 负责 |
|------|------|------|
| T-14 天 | 三轮压测完成；确定限流阈值、降级清单和扩容清单 | SRE + 各组 |
| T-3 天 | 扩容：`mall-app` 4→16 Pod、`inventory-service` 3→8 Pod，库存库与 Redis 按压测结论升规格；RocketMQ 托管实例升规格 | SRE |
| T-2 天 | 发布冻结开始（大促前 48 小时），只允许修复故障的变更，且需值班负责人审批 | 值班负责人 |
| T-1 天 | 活动 SKU 分桶；缓存预热：活动商品的 `product:detail:{skuId}` 写入 Redis，Pod 启动时加载进 Caffeine 后才就绪；预案演练：按开关清单逐个切换一次 | 库存组、交易组、SRE |
| 大促前 1 小时 | 执行预案降级；值班人员到位 | 值班负责人 |
| 大促后 | 恢复降级开关；合并分桶；T+2 天缩容；复盘 | 各组 |

值班表每个时段都有交易、库存、支付三组各一人加 SRE，值班负责人由技术负责人轮值。扩容与预热的通用清单见 [容量评估与规划 · 大促预案](/high-con/8_capacity_planning#六、大促预案) 与 [缓存架构设计 · 缓存预热](/high-con/3_cache_architecture#三、缓存预热)；商品详情 6 万 QPS 的读流量绝大部分由 [引入缓存](./4_cache) 的 Caffeine 吸收，预热的意义是让新扩出来的 Pod 不在 0 点集中回源。

### 2、RocketMQ 容量评估

年中大促的消息积压，是因为托管实例的规格从没按大促算过。按每笔订单产生的消息估算：峰值时 `order-timeout` 每单一条约 5000 条/秒，`payment-succeeded` 与 `order-paid` 按 70% 支付率共约 7000 条/秒，`order-cancelled` 约 1500 条/秒，发送合计约 1.35 万条/秒。积压的原因与处理见 [RocketMQ · 消息积压](/messaging/3_rocketmq#_3、消息积压)。

- **规格**：按 1.5 倍余量选 2 万 TPS 档；`order-paid` 有 `points-consumer`、`notify-consumer`、`shipment-consumer`、`inventory-confirm-consumer` 4 个消费组，规格按「发送 + 消费」确认
- **定时消息存量**：活动订单 5 分钟后投递，峰值时约 5000 × 300 = 150 万条在等待，要在实例的定时消息上限以内
- **消费者并发**：`inventory-confirm-consumer` 的线程数跟着 `inventory-service` 扩容同步调整，避免预占长时间停在 RESERVED

---

## 十、代价与后续

| 本篇的决策 | 带来的问题 | 在哪里解决 |
|-----------|-----------|-----------|
| 熔断、舱壁、限流、降级 | 开没开、拦了多少，只能翻各服务的日志和 Actuator 端点，大促当天值班看不过来 | 下一篇「可观测与发布」：熔断状态、限流命中、降级开关进统一大盘与告警 |
| 降级开关和限流阈值放在 Nacos | 改配置就是改线上行为，却没有灰度，也没有统一的变更记录 | 「可观测与发布」：配置变更与代码发布同样灰度、可回滚 |
| 大促前 48 小时发布冻结 | 冻结期内的线上问题只能硬扛，风险全压在审批上 | 「可观测与发布」：冻结期内批准的修复也走金丝雀与自动回滚，不再全靠审批硬扛 |
| 活动 SKU 分桶 | 换桶、再平衡与合并增加了库存逻辑，最后几件可能误判售罄 | 「复盘」：回头看分桶与 Redis 预扣的取舍 |
| 只在同构压测环境压测 | 环境再像也不是生产，第三方渠道与网络出口压不到 | 「复盘」：什么时候值得做生产全链路压测 |

---

## 小结

- 年中大促的事故链是：热点行排队 → `reserve` 变慢 → 下单线程占满 → 同进程接口全部超时 → 重试放大流量；任何一环被挡住都不会扩散
- 超时一层比一层短：网关 3s，`reserve` 连接 200ms / 读 500ms；Resilience4j 的 `inventory-reserve` 熔断加每 Pod 60 并发的信号量舱壁，把库存服务的故障关在 60 个线程里
- 写接口不重试，只读查询最多重试 1 次并随机退避；熔断或舱壁拒绝是确定失败，直接返回 `SYSTEM_BUSY`，不再 `release`
- 网关按「用户 + 接口」令牌桶限流，`mall-app` 限制同一 SKU 待支付最多 2 单，活动 SKU 支付超时缩短为 5 分钟
- 只对活动白名单 SKU 分 10 桶，按 `order_no` 哈希选桶、桶空换桶；不做 Redis 预扣
- 容量靠 Gatling 在同构环境按 7500 QPS 压出来，大促按预案提前扩容、预热、冻结发布，RocketMQ 规格按消息量单独评估

## 参考资料

- Resilience4j Documentation · CircuitBreaker：[https://resilience4j.readme.io/docs/circuitbreaker](https://resilience4j.readme.io/docs/circuitbreaker)
- Spring Cloud Circuit Breaker Reference · Resilience4j：[https://docs.spring.io/spring-cloud-circuitbreaker/reference/spring-cloud-circuitbreaker-resilience4j.html](https://docs.spring.io/spring-cloud-circuitbreaker/reference/spring-cloud-circuitbreaker-resilience4j.html)
- Spring Cloud Gateway Reference · RequestRateLimiter GatewayFilter Factory：[https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/gatewayfilter-factories/requestratelimiter-factory.html](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/gatewayfilter-factories/requestratelimiter-factory.html)
- Gatling Documentation · Injection：[https://docs.gatling.io/concepts/injection/](https://docs.gatling.io/concepts/injection/)
- Google SRE Book · Handling Overload：[https://sre.google/sre-book/handling-overload/](https://sre.google/sre-book/handling-overload/)

> 下一篇：[可观测与发布](./9_observability_release) —— 链路追踪、统一告警与大盘，金丝雀发布与 5 分钟回滚

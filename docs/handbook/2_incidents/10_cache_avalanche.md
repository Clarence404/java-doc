---
description: 预热 key 同时过期引发雪崩、热点 key 回源击穿、连接池耗尽排查、TTL 抖动与合并回源
---

# 缓存雪崩与击穿

> 前置阅读：[缓存最佳实践](/cache/11_cache_rule)、[缓存架构设计](/high-con/3_cache_architecture)

大促开场 30 分钟后订单确认页大面积超时，根因是 12 万个 SKU 缓存同时过期、爆款回源没有合并。本篇按现象到预防完整复盘，基线为 Spring Boot 4、Redis 8、MySQL 8.4。

---

## 一、现象

9 月 26 日 19:30 运营预热任务启动，20:00 大促开场。order-service（6 个 Pod，HikariCP `maximum-pool-size=50`、`connection-timeout=3000`）在 20:30 前后集中告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 20:30:08 | `RedisHitRateLow`：Redis Cluster 命中率从 99.2% 跌到 41% |
| 20:30:20 | `MySQLThreadsRunningHigh`：主库 `Threads_running` 从 12 升到 287，CPU 97% |
| 20:30:35 | `HikariPendingHigh`：`hikaricp_connections_pending` 单 Pod 最高 186 |
| 20:31 | `HttpP99High`：订单确认接口 `GET /api/orders/confirm` P99 从 95ms 升到 4.8s，错误率 23% |

Grafana 上同一时刻出现三条"断崖"：Redis `keyspace_misses` 速率从 50/s 跳到 3.4 万/s，MySQL QPS 从 2.1k 跳到 1.9 万，订单确认 QPS（约 6k）基本不变。流量没有变，变的是缓存。

---

## 二、影响

- 20:30–20:44 共 14 分钟，订单确认接口约 19 万次请求失败或超时，用户看到"商品信息加载失败"，下单转化率比同时段预估低 31%
- MySQL 主库被打满，同库的支付回调写入延迟升到 2s 以上，回调方触发重试，带来一轮额外写压力
- 21:00 前后出现第二波小规模命中率下跌（降到 83%），持续约 1 分钟
- 无数据错乱：订单确认只读，下单事务未受影响

---

## 三、排查过程

### 1、确认是缓存失效，不是流量突增

```bash
# 每 10 秒取一次，对比 keyspace_misses、expired_keys 的增量
for i in 1 2; do redis-cli -h 10.0.3.11 INFO stats | grep -E "keyspace_hits|keyspace_misses|expired_keys:"; sleep 10; done
```

示例输出：

```text
expired_keys:2318047
keyspace_hits:918244103
keyspace_misses:6120577
expired_keys:2338129
keyspace_hits:918261480
keyspace_misses:6177012
```

10 秒内这个分片过期了 2 万个 key，未命中增加 5.6 万次，命中只增加 1.7 万次，命中率降到约 24%。`expired_keys` 的激增说明 key 是"到期"消失的，不是被淘汰（`evicted_keys` 没变）或被误删。

### 2、看 key 数量与 TTL 分布

```bash
redis-cli -h 10.0.3.11 INFO keyspace
redis-cli -h 10.0.3.11 --scan --pattern 'order:sku:*' --count 1000 | head -2000 \
  | xargs -n 1 redis-cli -h 10.0.3.11 TTL | sort -n | uniq -c | sort -rn | head -5
```

示例输出：

```text
# Keyspace
db0:keys=201377,expires=201104,avg_ttl=1611042,subexpiry=0
    318 1781
    297 1782
    281 1780
    264 1783
    240 1779
```

20:32 采样到的 `order:sku:*` 都是刚被请求回填的 key，TTL 全部挤在 1779–1783 秒之间：回填用的也是固定 1800 秒，这批 key 会在 21:00 前后再次集中过期。

### 3、看数据库在执行什么

```sql
SELECT LEFT(current_statement, 70) AS stmt, COUNT(*) AS cnt, MAX(time) AS max_s
FROM sys.session
WHERE command = 'Query'
GROUP BY stmt ORDER BY cnt DESC LIMIT 3;
```

示例输出：

```text
+------------------------------------------------------------------------+-----+-------+
| stmt                                                                   | cnt | max_s |
+------------------------------------------------------------------------+-----+-------+
| SELECT s.id, s.title, s.price, p.promo_price, t.ship_fee FROM t_sku s  | 241 |     6 |
| UPDATE t_payment_callback SET status = 'DONE', updated_at = NOW() WHE  |  31 |     3 |
| SELECT id, user_id, status FROM t_order WHERE order_no = 'O20260926203 |   9 |     1 |
+------------------------------------------------------------------------+-----+-------+
```

241 个会话在执行同一条 SKU 详情 SQL。按参数再细分（`performance_schema.events_statements_current` 的 `SQL_TEXT`），其中 118 个查的是同一个 `s.id = 1001`，即主推爆款：这一部分是击穿，其余是 12 万个 key 同时过期带来的雪崩。

### 4、确认应用侧耗时花在哪

```bash
kubectl exec -it order-service-6c8b-q7m2k -- java -jar /opt/arthas/arthas-boot.jar 1
# 进入 Arthas 后：
trace com.example.order.sku.SkuQueryService getSku '#cost > 1000' -n 1
```

示例输出：

```text
`---ts=2026-09-26 20:31:47;thread_name=http-nio-8080-exec-142;id=2c1;is_daemon=true;priority=5;TCCL=...
    `---[3127.40ms] com.example.order.sku.SkuQueryService:getSku()
        +---[0.92ms] org.springframework.data.redis.core.ValueOperations:get() #57
        `---[3125.88ms] com.example.order.sku.SkuMapper:selectDetail() #61
```

Redis 读只用了 0.9ms，3.1 秒花在查库上；结合日志里的 `HikariPool-1 - Connection is not available, request timed out after 3000ms (total=50, active=50, idle=0, waiting=186)`，大部分时间是在等连接，不是 SQL 本身慢。

### 5、找到同时过期的源头

预热任务的日志与代码：

```text
2026-09-26T19:30:02.115+08:00  INFO 1 --- [   warmup-job-1] c.e.o.sku.SkuWarmupJob : warmup start, skuCount=120000
2026-09-26T19:30:41.870+08:00  INFO 1 --- [   warmup-job-1] c.e.o.sku.SkuWarmupJob : warmup done, written=120000, cost=39755ms
```

```java
// SkuWarmupJob：40 秒内写完 12 万个 key，TTL 全部是 30 分钟
redis.opsForValue().set("order:sku:" + sku.getId(), json, Duration.ofMinutes(30));
```

40 秒写完、TTL 统一 30 分钟，过期时间被压缩在 20:00:02–20:00:42 这 40 秒里，但告警在 20:30。继续翻变更记录：19:58 运营在后台把预热时间改成了 20:00，任务在 20:00:05 第二次执行，`SET` 重新设置了 TTL（20:00 那一轮过期几乎被同时覆盖，只有不到 1 分钟的轻微抖动），于是集中过期点落在 20:30:05–20:30:45，与告警时间吻合。

---

## 四、根因

- **直接原因**：预热任务给 12 万个 key 设置相同的 30 分钟 TTL，40 秒内写完，导致它们在 20:30 前后 40 秒内集中过期（雪崩）
- **放大因素**：
  - 回源没有合并：`getSku` 是"读缓存 → 未命中查库 → 写缓存"的手写逻辑，同一个爆款 SKU 被 118 个线程同时查库（击穿）
  - 业务回填也用固定 TTL，把集中过期点平移到下一个 30 分钟，形成第二波
  - 数据库没有保护：确认页与支付回调共用主库和同一个连接池，查询被打满后连带拖慢写入
- **为什么没提前发现**：压测时缓存是逐步预热的，从未模拟"大批 key 同时冷启动"；命中率告警阈值设在 50% 以下，触发时已经过了最佳处置时间

---

## 五、修复

### 1、止血

1. 20:33 网关对 `GET /api/orders/confirm` 限流到 3000 QPS，超出部分返回"排队中"提示（见 [限流与过载保护](/high-avail/7_rate_limiting)）
2. 20:35 打开降级开关：确认页的运费模板、促销文案改为读本地兜底数据，只保留价格与库存的实时查询（见 [降级](/high-avail/6_degradation)）
3. 20:38 用脚本按 TTL 1800–2700 秒随机重新预热全部 SKU，打散下一次过期点；20:44 命中率恢复到 98%，解除限流
4. 21:00 前后的第二波来自 20:30–20:38 被业务回填、不在预热清单里的约 3 万个长尾 SKU，命中率短暂降到 83%，数据库扛住了，未再限流

### 2、根治

**TTL 加随机抖动**，预热和回填走同一套逻辑。Spring Data Redis 支持按条目计算 TTL：

```java
@Bean
RedisCacheManagerBuilderCustomizer skuCacheTtl() {
    RedisCacheConfiguration sku = RedisCacheConfiguration.defaultCacheConfig()
            // 30 分钟基础 TTL + 0~10 分钟随机抖动
            .entryTtl((key, value) -> Duration.ofSeconds(1800 + ThreadLocalRandom.current().nextInt(600)));
    return builder -> builder.withCacheConfiguration("sku", sku);
}
```

**同一 key 只回源一次**：单 JVM 内用 `sync = true` 合并并发回源，6 个实例最多 6 次；爆款再加跨实例互斥重建或逻辑过期（写法见 [缓存最佳实践 · 击穿防护](/cache/11_cache_rule#五、缓存击穿防护)）：

```java
@Cacheable(cacheNames = "sku", key = "#skuId", sync = true)   // 同一 key 并发未命中时只放一个线程查库
public SkuDetail getSku(long skuId) {
    return skuMapper.selectDetail(skuId);
}
```

**本地缓存兜底热点**：爆款 SKU 加一层 Caffeine（`expireAfterWrite=5s`），Redis 整体失效时数据库最多看到每实例每 5 秒一次查询（见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)）。

**隔离读写**：确认页查询改走只读从库并使用独立连接池，支付回调保留主库连接池，互不抢占（见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#三、隔离)）。

---

## 六、预防

**监控告警**（redis_exporter + Prometheus，阈值按自身基线调整）：

```yaml
- alert: RedisHitRateDrop
  expr: |
    sum(rate(redis_keyspace_hits_total{cluster="order-cache"}[1m]))
      / (sum(rate(redis_keyspace_hits_total{cluster="order-cache"}[1m]))
         + sum(rate(redis_keyspace_misses_total{cluster="order-cache"}[1m]))) < 0.9
  for: 1m
  labels: {severity: critical}
- alert: RedisExpireBurst
  expr: sum(rate(redis_expired_keys_total{cluster="order-cache"}[1m])) > 5 * sum(rate(redis_expired_keys_total{cluster="order-cache"}[1h] offset 1d))
  for: 2m
  labels: {severity: warning}
```

再加一条 `hikaricp_connections_pending > 20` 持续 1 分钟的告警，它往往比接口超时更早出现。

**代码规则**：

- 所有写缓存的地方（预热、回填、主动刷新）统一走一个带抖动的 TTL 工具方法，Code Review 时拒绝裸写 `Duration.ofMinutes(30)`
- 回源必须经过合并（`sync = true`、Caffeine `get(key, loader)` 或互斥重建），禁止手写"查缓存 → 查库 → 写缓存"
- 批量预热任务的执行时间、数量登记到变更系统，修改需要评审

**测试**：

- 单元测试：对 TTL 工具方法采样 1 万次，断言最大值与最小值之差不小于 500 秒
- 压测增加"冷缓存"场景：压测开始前 `FLUSHDB` 测试集群，以大促峰值流量冲击，验证数据库连接池和限流是否兜得住（见 [性能测试](/testing/7_performance_test)）

---

## 七、涉及知识点

- 雪崩、击穿的防护写法：[缓存最佳实践](/cache/11_cache_rule#六、缓存雪崩防护)
- 缓存预热的设计：[缓存架构设计](/high-con/3_cache_architecture#三、缓存预热)
- `@Cacheable(sync = true)` 与 Spring Cache 陷阱：[Cache 抽象](/spring/5_cache)
- 热点请求合并：[热点问题](/high-con/6_hotspot#四、热点请求-single-flight)
- Arthas `trace` 用法：[线上诊断](/engineering/7_diagnosis#_3、trace-拆解方法内部耗时)
- 慢 SQL 与执行情况定位：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain#四、慢-sql-定位)
- 限流与降级：[限流与过载保护](/high-avail/7_rate_limiting)、[降级](/high-avail/6_degradation)

---

## 小结

- 流量不变而数据库 QPS 暴涨，先看 Redis 的 `keyspace_misses` 和 `expired_keys`：是到期、淘汰还是误删，处置完全不同
- 雪崩看 TTL 分布，击穿看同一参数的并发查询数，两者常常同时发生
- 根治靠"TTL 抖动 + 回源合并 + 本地缓存兜底 + 读写连接池隔离"，预热与回填必须用同一套 TTL 逻辑
- 冷缓存压测和命中率告警是最便宜的预防

## 参考资料

- 过期机制与 TTL：[EXPIRE — Redis Docs](https://redis.io/docs/latest/commands/expire/)
- `INFO` 字段说明：[INFO — Redis Docs](https://redis.io/docs/latest/commands/info/)
- `--scan` 等命令行选项：[Redis CLI — Redis Docs](https://redis.io/docs/latest/develop/tools/cli/)
- 按条目计算 TTL：[Redis Cache — Spring Data Redis](https://docs.spring.io/spring-data/redis/reference/redis/redis-cache.html)
- `@Cacheable(sync = true)`：[Declarative Annotation-based Caching — Spring Framework](https://docs.spring.io/spring-framework/reference/integration/cache/annotations.html)
- `sys.session` 视图：[The session and x$session Views — MySQL 8.4 Reference Manual](https://dev.mysql.com/doc/refman/8.4/en/sys-session.html)
- `trace` 命令：[trace — Arthas](https://arthas.aliyun.com/doc/trace.html)
- 导出指标：[redis_exporter](https://github.com/oliver006/redis_exporter)

> 下一篇：[热 Key](./11_hot_key)

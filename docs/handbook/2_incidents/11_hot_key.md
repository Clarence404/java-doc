---
description: 直播爆款单 key 打满一个分片、--hotkeys 与 OBJECT FREQ 定位、本地缓存与多副本 key
---

# 热 Key

> 前置阅读：[Redis 实战](/cache/5_redis_practice#三、热-key)、[热点问题](/high-con/6_hotspot)

直播爆款上架后，Redis Cluster 只有一个分片 CPU 打满，落在它上面的请求一起超时。本篇按现象到预防完整复盘，基线为 Spring Boot 4、Redis 8。

---

## 一、现象

10 月 1 日 20:00 直播开始，20:03 主播上架 SKU 2088。订单缓存集群为 Redis Cluster 6 主 6 从（10.0.3.11–16 为主节点，`maxmemory-policy allkeys-lru`），order-service 6 个 Pod，Lettuce 命令超时 1 秒：

| 时间 | 告警 / 现象 |
|------|-------------|
| 20:04 | `RedisNodeCpuHigh`：10.0.3.16 CPU 99%，其余 5 个主节点 15%–22% |
| 20:05 | `RedisNetOutHigh`：10.0.3.16 出网带宽 325 MB/s，逼近云主机 2.5 Gbps 上限 |
| 20:05 | 应用日志大量 `RedisCommandTimeoutException: Command timed out after 1 second(s)` |
| 20:06 | `HttpErrorRateHigh`：订单确认接口错误率 12%，P99 从 80ms 升到 1.3s；购物车服务同时告警 |

和缓存雪崩不同，这次命中率一直在 99% 以上、数据库毫无压力。异常集中在一个节点：整个集群 QPS 只涨了 60%，但 10.0.3.16 一个节点的 QPS 涨了 5 倍。

---

## 二、影响

- 20:05–20:24 共 19 分钟，订单确认接口约 14 万次请求失败，直播间下单转化率比同场预估低 40%
- 受害的不只是爆款：slot 13653–16383 上的所有 key（约 1/6 的购物车、用户会话数据）读写都在排队，购物车服务错误率 7%
- Lettuce 超时后上层重试一次，给已经打满的节点又加了约 10% 的请求
- 无数据错乱，均为读失败

---

## 三、排查过程

### 1、先看是不是单节点问题

```bash
for i in 11 12 13 14 15 16; do
  echo -n "10.0.3.$i "
  redis-cli -h 10.0.3.$i INFO stats | grep -E "instantaneous_ops_per_sec|instantaneous_output_kbps" | tr '\r\n' '  '
  echo
done
```

示例输出：

```text
10.0.3.11 instantaneous_ops_per_sec:17842  instantaneous_output_kbps:21033.52
10.0.3.12 instantaneous_ops_per_sec:18915  instantaneous_output_kbps:22870.14
10.0.3.13 instantaneous_ops_per_sec:17206  instantaneous_output_kbps:20118.77
10.0.3.14 instantaneous_ops_per_sec:18377  instantaneous_output_kbps:21946.05
10.0.3.15 instantaneous_ops_per_sec:17690  instantaneous_output_kbps:20761.39
10.0.3.16 instantaneous_ops_per_sec:81264  instantaneous_output_kbps:332780.46
```

一个节点的 QPS 是其他节点的 4.5 倍，出网流量是 15 倍。流量倾斜到一个分片，典型的热 Key（或大 Key 被高频读）。

### 2、确认不是慢命令

```bash
redis-cli -h 10.0.3.16 INFO commandstats | grep -E "cmdstat_(get|set|hget|del):"
redis-cli -h 10.0.3.16 SLOWLOG LEN
```

示例输出：

```text
cmdstat_get:calls=1873456021,usec=3311290855,usec_per_call=1.77,rejected_calls=0,failed_calls=0
cmdstat_set:calls=91276540,usec=301212383,usec_per_call=3.30,rejected_calls=0,failed_calls=0
cmdstat_hget:calls=402118897,usec=402911032,usec_per_call=1.00,rejected_calls=0,failed_calls=0
cmdstat_del:calls=8812301,usec=26437152,usec_per_call=3.00,rejected_calls=0,failed_calls=0
(integer) 0
```

`GET` 每次只要 1.77 微秒，慢日志为空：单条命令不慢，是**数量太多**。主线程忙于处理请求和往外写 5KB 级的响应，CPU 和网卡一起被打满。

### 3、找出是哪个 key

先试 `OBJECT FREQ`，集群用的是 LRU 策略，没有访问频率可查：

```bash
redis-cli -h 10.0.3.16 OBJECT FREQ order:sku:2088
```

示例输出：

```text
(error) ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.
```

这是纯缓存集群，按规范本该用 `allkeys-lfu`。在故障节点上临时切换，等一分钟让计数器积累，再扫描热点：

```bash
redis-cli -h 10.0.3.16 CONFIG SET maxmemory-policy allkeys-lfu
redis-cli -h 10.0.3.16 --hotkeys -i 0.1
```

示例输出（节选）：

```text
# Scanning the entire keyspace to find hot keys as well as
# average sizes per key type.  You can use -i 0.1 to sleep 0.1 sec
# per 100 SCAN commands (not usually needed).

[00.00%] Hot key '"cart:u:83017721"' found so far with counter 9
[12.47%] Hot key '"order:sku:2088"' found so far with counter 255
[37.82%] Hot key '"order:sku:1001"' found so far with counter 41

-------- summary -------

Sampled 1203381 keys in the keyspace!
hot key found with counter: 255	keyname: "order:sku:2088"
hot key found with counter: 41	keyname: "order:sku:1001"
hot key found with counter: 9	keyname: "cart:u:83017721"
```

LFU 计数器是对数增长的，255 是上限，远高于其他 key。`--hotkeys` 会 `SCAN` 整个节点，`-i 0.1` 让它每 100 次 SCAN 停顿 0.1 秒，避免给已经打满的节点再加压。

### 4、算一算这个 key 的分量

```bash
redis-cli -h 10.0.3.16 MEMORY USAGE order:sku:2088
redis-cli -h 10.0.3.16 CLUSTER KEYSLOT order:sku:2088
```

示例输出：

```text
(integer) 5344
(integer) 13825
```

slot 13825 落在 10.0.3.16 负责的 13653–16383 区间。5.3KB × 约 6.2 万次/秒 ≈ 330 MB/s，与节点出网流量吻合：几乎全部额外流量来自这一个 key。Cluster 按 slot 分片，**一个 key 永远只在一个节点上**，加分片解决不了。

### 5、为什么读这么多次

直播间当时订单确认 QPS 约 2.1 万，读次数却是 6.2 万。在一个 Pod 上用 Arthas 对比调用次数：

```bash
monitor -c 5 -n 1 com.example.order.web.ConfirmController confirm
monitor -c 5 -n 1 com.example.order.sku.SkuCacheClient get
```

示例输出：

```text
 timestamp            class                                       method   total  success  fail  avg-rt(ms)  fail-rate
-----------------------------------------------------------------------------------------------------------------------
 2026-10-01 20:07:15  com.example.order.web.ConfirmController     confirm  17520  15418    2102  418.62      12.00%

 timestamp            class                                       method   total  success  fail  avg-rt(ms)  fail-rate
-----------------------------------------------------------------------------------------------------------------------
 2026-10-01 20:07:21  com.example.order.sku.SkuCacheClient        get      52608  46294    6314  136.15      12.00%
```

每次确认请求读了 3 次同一个 SKU：算价、校验库存、匹配促销规则各自调用一次 `SkuCacheClient.get`，每次都完整反序列化 5KB 的详情对象。

---

## 四、根因

- **直接原因**：直播爆款 SKU 2088 的详情 key 被以约 6.2 万次/秒读取，全部落在一个分片，单节点主线程与网卡打满
- **放大因素**：
  - 一次请求重复读同一个 key 3 次，读放大 3 倍
  - Value 是 5.3KB 的完整详情，订单确认只需要价格、库存状态等不到 300 字节的字段
  - 没有本地缓存层，每次读都走网络；Lettuce 超时后上层再重试一次
  - 缓存集群用 `allkeys-lru`，出事时连 `--hotkeys` 都用不了，定位多花了 6 分钟
- **为什么没提前发现**：直播排期没有同步给技术侧做热点预案；压测流量按 SKU 均匀分布，从未模拟单品集中访问

---

## 五、修复

### 1、止血

1. 20:09 网关对订单确认接口开启热点参数限流：`skuId=2088` 单独限 8000 QPS，其他 SKU 不受影响，超出部分提示"排队中"（见 [限流与过载保护](/high-avail/7_rate_limiting)）
2. 20:10 关闭上层的 Redis 读重试，去掉 10% 的放大
3. 20:22 紧急发布带本地缓存的版本（下文代码，开关默认只对热点 SKU 名单生效），20:24 10.0.3.16 QPS 降到 1.9 万，解除限流

### 2、根治

**热点 SKU 加本地缓存**，短 TTL 保证价格变更最多延迟几秒，详情更新时通过 Redis Pub/Sub 广播失效（完整方案见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)）：

```java
private final Cache<Long, SkuBrief> hotLocal = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofSeconds(3))
        .recordStats()
        .build();

public SkuBrief getBrief(long skuId) {
    if (hotSkuRegistry.isHot(skuId)) {                         // 名单来自配置中心 + 自动探测
        return hotLocal.get(skuId, this::loadFromRedis);       // 同 key 并发只加载一次
    }
    return loadFromRedis(skuId);
}
```

**一次请求只读一次**：确认流程开始时取一次 `SkuBrief`，作为参数传给算价、库存、促销三个步骤，不再各自查缓存。

**瘦身 Value**：订单确认改读 `order:sku:brief:{id}`（价格、库存状态、限购数，约 260 字节），详情页才读完整对象。

**本地缓存不适用时用多副本 key**：例如需要跨实例一致计数的场景，把 key 复制为 `order:sku:2088:0` ~ `:7`，读时随机选一个。实测这 8 个后缀分别落在 slot 13643、9578、5385、1320、13775、9710、5517、1452，覆盖了全部 6 个分片；写时要更新或删除全部副本（见 [热点问题 · key 打散](/high-con/6_hotspot#_2、key-打散-多副本)）。库存扣减这类写热点是另一回事，见 [热点问题 · 写热点](/high-con/6_hotspot#三、写热点-热点行更新)。

**缓存集群改为 `allkeys-lfu`**，写进配置文件而不是只靠 `CONFIG SET`，`--hotkeys` 与 `OBJECT FREQ` 随时可用。

---

## 六、预防

**监控告警**：热 Key 的特征是"集群整体正常、单节点异常"，告警要看节点间的倾斜度：

```yaml
- alert: RedisOpsSkew
  expr: |
    max by (cluster) (rate(redis_commands_processed_total{cluster="order-cache",role="master"}[1m]))
      / avg by (cluster) (rate(redis_commands_processed_total{cluster="order-cache",role="master"}[1m])) > 3
  for: 2m
  labels: {severity: critical}
- alert: RedisNetOutHigh
  expr: rate(redis_net_output_bytes_total{cluster="order-cache"}[1m]) > 200 * 1024 * 1024
  for: 1m
  labels: {severity: warning}
```

**热点探测**：客户端对读取的 key 做滑动窗口 Top-K 统计（每实例每秒超过 500 次视为热点），自动加入 `hotSkuRegistry` 并上报监控，思路见 [热点问题 · 热点 key 探测](/high-con/6_hotspot#一、热点-key-探测)。

**流程与代码规则**：

- 直播、秒杀等活动在排期系统登记 SKU，提前一天加入热点名单并预热本地缓存
- 同一请求内对同一个缓存 key 只读一次；Code Review 关注循环或多个步骤里的重复 `get`
- 缓存 Value 按使用场景拆分，高频读的 key 控制在 1KB 以内
- Redis 超时后不在应用层盲目重试，避免放大

**测试**：压测数据按 Zipf 分布生成，至少一个场景让单个 SKU 承担 30% 以上的流量，观察单分片 CPU 与出网带宽（见 [性能测试](/testing/7_performance_test)）。

---

## 七、涉及知识点

- 热 Key 的发现与处理：[Redis 实战](/cache/5_redis_practice#三、热-key)
- 热点探测、读热点与写热点治理：[热点问题](/high-con/6_hotspot)
- Cluster 槽位与分片：[Redis 集群](/cache/3_redis_cluster#四、cluster-模式)
- 淘汰策略与监控指标：[缓存最佳实践](/cache/11_cache_rule#九、监控告警)
- 本地缓存：[Caffeine](/cache/7_caffeine)、[两级缓存（L1 + L2）](/cache/8_two_level_cache)
- Arthas `monitor`：[线上诊断](/engineering/7_diagnosis#_4、stack-与-monitor)

---

## 小结

- 集群整体正常、单节点 CPU 或带宽打满，优先怀疑热 Key；`INFO commandstats` 能排除慢命令
- `--hotkeys` 和 `OBJECT FREQ` 依赖 LFU 策略，纯缓存集群应常态化使用 `allkeys-lfu`
- 一个 key 只在一个分片上，加分片无效；靠本地缓存、读放大治理、Value 瘦身、多副本 key
- 告警看节点间倾斜度，活动排期要进入热点名单

## 参考资料

- `--hotkeys`、`-i` 等选项：[Redis CLI — Redis Docs](https://redis.io/docs/latest/develop/tools/cli/)
- LFU 计数器：[OBJECT FREQ — Redis Docs](https://redis.io/docs/latest/commands/object-freq/)
- 淘汰策略：[Key eviction — Redis Docs](https://redis.io/docs/latest/develop/reference/eviction/)
- 槽位计算：[CLUSTER KEYSLOT — Redis Docs](https://redis.io/docs/latest/commands/cluster-keyslot/)
- `INFO commandstats`：[INFO — Redis Docs](https://redis.io/docs/latest/commands/info/)
- `monitor` 命令：[monitor — Arthas](https://arthas.aliyun.com/doc/monitor.html)
- 本地缓存：[Caffeine Wiki](https://github.com/ben-manes/caffeine/wiki)

> 下一篇：[MQ 消息积压](./12_mq_backlog)

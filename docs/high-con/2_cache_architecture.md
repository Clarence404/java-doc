# 缓存架构设计

> 参考链接：[京东 hotkey（JD-hotkey）](https://gitee.com/jd-platform-opensource/hotkey) · [有赞透明多级缓存解决方案 TMC](https://tech.youzan.com/tmc/)

绝大多数互联网业务读多写少（读写比 10:1 甚至 100:1），**缓存是扛读流量最有效的手段**：让请求在越靠前的层级被拦截，落到数据库的流量就越少。本文聚焦系统级的缓存分层与策略，Redis、Caffeine 等技术细节见 [缓存模块](/cache/1_redis_base)。

---

## 一、多级缓存架构

![缓存加速](../assets/concurrency/cache.svg)

一个请求从用户到数据库，可以在五个层级被缓存拦截：

| 层级 | 典型实现 | 延迟 | 容量 | 缓存内容 |
|------|----------|------|------|----------|
| 浏览器 / App | HTTP Cache-Control、App 本地存储 | 0 | 小 | 静态资源、低频变化配置 |
| CDN | 云 CDN、边缘节点 | 几 ms（就近） | 大 | 静态资源、静态化页面、可公开的接口响应 |
| Nginx 本地缓存 | `proxy_cache`、OpenResty `lua_shared_dict` | < 1 ms | 中（单机内存/磁盘） | 热点接口响应、商品详情片段 |
| 应用本地缓存 | Caffeine、Guava Cache | 微秒级 | 小（JVM 堆） | 热点数据、配置、字典 |
| 分布式缓存 | Redis Cluster | 1 ms 左右 | 大（集群） | 业务数据主缓存 |
| 数据库 | MySQL | 几 ms ~ 几百 ms | 全量 | 数据源 |

**设计原则**：

- **越靠前越"脏"**：前置层命中率高、延迟低，但失效控制最难（CDN 刷新以分钟计，浏览器缓存无法主动失效）
- **按数据特征选层**：静态资源走 CDN；千人一面的热点数据可以放 Nginx / 本地缓存；千人千面的数据只能到 Redis
- **每层都要有 TTL 兜底**：即使失效通知丢失，数据也能在可接受时间内自愈

应用本地缓存 + Redis 的两级缓存实现与失效广播见 [两级缓存](/cache/8_two_level_cache)。

---

## 二、命中率与一致性取舍

### 1、整体命中率的放大效应

假设 Redis 命中率 95%，数据库承载 5% 的读流量；如果在前面加一层命中率 80% 的本地缓存：

- 到达 Redis 的流量 = 20%
- 到达 DB 的流量 = 20% × 5% = **1%**

本地缓存把 DB 流量再降了 5 倍，同时 Redis 的 QPS 和带宽压力也降了 5 倍。这就是多级缓存在高并发下的价值。

### 2、各层一致性取舍

| 层级 | 一致性保障 | 可接受的不一致窗口 | 适用数据 |
|------|------------|---------------------|----------|
| CDN / 浏览器 | 仅 TTL + 主动刷新（分钟级生效） | 分钟 ~ 小时 | 图片、JS/CSS、静态页 |
| Nginx 本地缓存 | 短 TTL（1 ~ 10s） | 秒级 | 商品详情、活动页 |
| 应用本地缓存 | 短 TTL + MQ / Pub-Sub 广播失效 | 毫秒 ~ 秒级 | 热点商品、配置 |
| Redis | 更新 DB 后删除缓存 + 延迟双删 / Binlog 订阅 | 毫秒级 | 业务数据 |

**不适合多级缓存的数据**：余额、库存精确值、权限等强一致数据，最多只缓存到 Redis，且写路径必须严格处理。

缓存与数据库一致性的完整方案（Cache Aside、延迟双删、Canal 订阅 Binlog）见 [缓存一致性](/cache/10_cache_consistency)。

---

## 三、缓存预热

冷启动或大促开始时缓存为空，瞬间流量会直接击穿到 DB。预热即**在流量到来前把热点数据提前加载进缓存**。

| 预热方式 | 做法 | 适用场景 |
|----------|------|----------|
| 启动预热 | 应用启动时加载配置、字典、Top N 热门数据到本地缓存 | 本地缓存 |
| 定时预热 | 定时任务按访问统计把次日热门商品写入 Redis | 日常热点 |
| 活动预热 | 大促 / 秒杀前把活动商品、库存推送到 Redis 和本地缓存 | 可预知热点 |
| 流量回放 | 把线上访问日志回放到新集群 | 新集群上线、机房切换 |

```java
@Component
@RequiredArgsConstructor
public class HotItemWarmer implements ApplicationRunner {

    private final ItemMapper itemMapper;
    private final Cache<Long, ItemDTO> localCache;          // Caffeine
    private final StringRedisTemplate redis;

    @Override
    public void run(ApplicationArguments args) {
        // 启动时预热 Top 1000 热门商品（热度由离线任务计算）
        List<ItemDTO> hotItems = itemMapper.selectTopHot(1000);
        for (ItemDTO item : hotItems) {
            localCache.put(item.getId(), item);
            // Redis TTL 加随机抖动，避免同时过期
            long ttl = 3600 + ThreadLocalRandom.current().nextInt(600);
            redis.opsForValue().set("item:" + item.getId(), JSON.toJSONString(item),
                    ttl, TimeUnit.SECONDS);
        }
    }
}
```

**注意**：预热期间要控制对 DB 的并发（分批 + 限速），否则预热本身就会压垮数据库；K8s 中可配合 `readinessProbe`，预热完成前不接流量。

---

## 四、热点 key 探测

可预知的热点（活动商品）可以预热，但**突发热点**（突发新闻、明星同款）无法提前知道，需要实时探测。

### 1、探测方式对比

| 方式 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 客户端统计 | 应用内滑动窗口统计 key 访问次数 | 实现简单、无额外组件 | 单机视角，全局热点可能被分散而漏判 |
| 代理层统计 | Twemproxy / Codis / 自研 Proxy 统计 | 全局视角 | 需要代理层 |
| Redis 自带 | `redis-cli --hotkeys`（需 LFU 淘汰策略）、`MONITOR` | 无需改代码 | 离线分析，`MONITOR` 影响性能 |
| 集中式探测 | 客户端上报访问 → 计算集群汇总 → 推送热点列表 | 全局准确、秒级 | 需部署独立组件 |

### 2、京东 hotkey 的思路

JD-hotkey 是集中式探测的典型实现：

1. **客户端 SDK**：在应用内对每次 key 访问做本地计数，每 500ms 批量上报给 Worker
2. **Worker 集群**：按 key 哈希分配，滑动窗口统计（如 1s 内访问 > 1000 次即判定为热点）
3. **推送**：Worker 通过长连接把热点 key 推送给**所有**应用实例
4. **本地缓存**：应用收到推送后把该 key 的值缓存到 JVM 本地，后续请求直接命中本地，不再访问 Redis
5. **自动过期**：热度下降后本地缓存到期自动淘汰

从探测到全集群生效通常在 1 秒内，可以扛住突发热点对单个 Redis 分片的冲击。热点 key 的其他治理手段（key 打散、多副本）见 [热点问题](/high-con/5_hotspot)。

### 3、客户端简易统计实现

```java
/** 基于 Caffeine 的单机热点统计：1 秒窗口内访问超阈值则晋升本地缓存 */
public class HotKeyDetector {

    private static final int THRESHOLD = 500;

    private final Cache<String, LongAdder> counter = Caffeine.newBuilder()
            .expireAfterWrite(1, TimeUnit.SECONDS)   // 1 秒滚动窗口（近似）
            .maximumSize(100_000)
            .build();

    public boolean isHot(String key) {
        LongAdder adder = counter.get(key, k -> new LongAdder());
        adder.increment();
        return adder.sum() >= THRESHOLD;
    }
}
```

---

## 五、缓存三大问题

| 问题 | 现象 | 高并发下的典型诱因 | 核心解法 |
|------|------|--------------------|----------|
| **缓存穿透** | 查询不存在的数据，每次都打到 DB | 恶意攻击、爬虫遍历不存在的 ID | 布隆过滤器预过滤；缓存空值（短 TTL）；参数校验 |
| **缓存击穿** | 单个热点 key 过期瞬间，大量请求并发重建 | 热门商品缓存到期 | 互斥锁只允许一个请求回源；逻辑过期 + 异步刷新；热点 key 不过期 |
| **缓存雪崩** | 大量 key 同时失效或 Redis 整体不可用 | 批量预热 TTL 相同；Redis 宕机 | TTL 加随机抖动；多级缓存兜底；Redis 集群高可用；熔断降级 |

详细方案与代码见 [缓存最佳实践 - 缓存穿透防护](/cache/11_cache_rule)、[Redis 典型场景 - 布隆过滤器](/cache/4_redis_scenario) 与 [缓存一致性](/cache/10_cache_consistency)。

---

## 六、设计清单

- [ ] 读写比、数据是否千人一面，决定缓存可以前置到哪一层
- [ ] 每层缓存都有 TTL 兜底，TTL 加随机抖动
- [ ] 强一致数据不进本地缓存 / CDN
- [ ] 可预知热点在流量到来前预热，预热过程限速
- [ ] 有突发热点探测与本地缓存自动晋升机制
- [ ] 回源有并发控制（互斥锁 / 单飞），防击穿
- [ ] 监控各层命中率，命中率骤降要告警

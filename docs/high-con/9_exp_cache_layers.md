---
description: 不用缓存、只用 Redis、两级缓存的阶梯压测对照、热点失效时单飞与否的回源次数、空值缓存对随机 ID 的效果
---

# 多级缓存实验

> 前置阅读：[缓存架构设计](./3_cache_architecture)、[引入缓存](/project/4_cache)

mall-evolution 的商品详情用本机 Caffeine 加 Redis 两级缓存，带单飞和空值缓存。本篇把这几层逐个关掉，实测每一层挡住了多少回源，热点失效和查不存在的商品时各自差多少。

## 一、现象与假设

[引入缓存](/project/4_cache) 第四节给商品详情加了两级缓存，第六节用单飞防击穿、用空值缓存防穿透。这些做法各自的效果在那一章里是估算，这次逐项量一遍。

| 假设 | 怎么验证 |
|------|---------|
| 不用缓存时，数据库会先于应用到达拐点 | 详情请求逐级加压，三种缓存配置各压一遍 |
| 热点商品的缓存失效时，单飞只让一个请求回源 | 每 20 秒让热点失效一次，对比开、关单飞 |
| 缓存空值能挡住查不存在商品的请求 | 固定的 100 个不存在 ID 与每次随机的 ID，各自对比开、关空值缓存 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 网关 → mall-app，1 个实例；MySQL、Redis 各 1 个 |
| 逐层对照 | 详情请求从 200 次/秒起每 60 秒加 200，到 1600 次/秒；另一组从 2000 加到 4000，每级 1000。80% 的请求给最热的 1 个 SKU，其余平分给另外 2 个 |
| 击穿 | 300 次/秒全部请求同一个 SKU，每 20 秒让它的缓存失效一次，共 8 次；回源按 200ms 的慢查询算，不经过 Redis |
| 穿透 | 200 次/秒全部请求不存在的 SKU，持续 180 秒，共 3.6 万次 |
| 客户端 | 超时 3 秒，不重试 |
| 轮数 | 每个变体 2 轮 |

击穿那一组有两处是模型。回源真实的耗时只有两三毫秒，失效瞬间到达的请求太少，开不开单飞看不出差别，所以让每次回源多花 200ms，并且在这 200ms 里一直占着一条数据库连接，对应真实系统里的一条慢查询。关掉 Redis 是因为有 Redis 时本机缓存失效后只会读到 Redis，到不了数据库。

商品库里上架的只有 3 个 SKU，这决定了逐层对照那一组测不出本机缓存容量不够、冷数据回源这类问题，测的只是「每个请求多一次网络调用或多一次查询」的代价。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 两级缓存的读路径、单飞、空值缓存 | [`ProductDetailService`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/detail/ProductDetailService.java) |
| 逐层关掉缓存的开关（只在 demo profile 生效） | [`DetailCachePolicy`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/detail/DetailCachePolicy.java)、[`DemoDetailCachePolicy`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/detail/DemoDetailCachePolicy.java) |
| 让缓存失效的管理接口 | [`ProductAdminController`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/admin/ProductAdminController.java) |
| mall-app 的连接池（20 条）与 Redis 超时（200ms） | [`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml) |
| 压测场景与各变体参数 | [`CacheLayersSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/CacheLayersSimulation.java)、[`experiments/f-cache-layers/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/f-cache-layers) |

单飞用的是 Caffeine 自带的加载函数，同一个 key 并发未命中时只有一个线程执行它：

```java
// ProductDetailService.get（节选）
if (policy.l1Enabled() && policy.singleFlightEnabled()) {
    // 同一 skuId 并发未命中时，本 JVM 只有一个线程去查 Redis / 数据库
    Optional<ProductDetailView> cached = local.get(skuId, id -> {
        Optional<ProductDetailView> loaded = loadFromRemote(id, source);
        return cacheableInL1(loaded) ? loaded : null;
    });
    view = cached != null ? cached : Optional.empty();
} else if (policy.l1Enabled()) {
    // 仅演示环境：不单飞。并发未命中的请求各自加载、各自回填
    view = local.getIfPresent(skuId);
    if (view == null) {
        view = loadFromRemote(skuId, source);
        ...
    }
}
```

实验的各个变体只改这几个开关，正式环境全部是默认值：

```properties
# experiments/f-cache-layers/common.properties（节选）
mall.demo.detail-cache.l1-enabled=true              # 本机 Caffeine
mall.demo.detail-cache.l2-enabled=true              # Redis
mall.demo.detail-cache.single-flight-enabled=true   # 单飞
mall.demo.detail-cache.null-cache-enabled=true      # 缓存空值
mall.demo.detail-cache.load-delay-ms=0              # 每次回源多花多久
```

环境与 [热点库存实验](./11_exp_hot_stock) 相同：压测工具和服务在一台 20 核的开发机上，MySQL、Redis 在一台 4 核 6GB 的虚拟机里。

## 三、逐层对照：没有压出拐点

三种配置在 200 到 1600 次/秒的 8 级里全部 100% 成功，耗时几乎是平的：

| 配置 | P50 | P99 | 每秒查库 | 每秒读 Redis | 虚拟机 CPU（200 → 1600 次/秒） |
|------|------|------|------|------|------|
| 不用缓存 | 2–3ms | 4–5ms，1400 次/秒起 16ms | 等于请求数 | 0 | 4% → 12% |
| 只有 Redis | 2ms | 3–4ms | 0 | 等于请求数 | 2% → 4% |
| 本机 + Redis | 1ms | 2–3ms | 0 | 0.1 | 2% → 3% |

再往上的一组从 2000 加到 4000 次/秒（每级 60 秒，三种配置各 2 轮），同样全部 100% 成功。表里是「P50 / P99」，每级的头 10 秒不计入（从预热的 50 次/秒跳到 2000 次/秒时连接和线程要现建，头几秒的耗时不代表稳定状态）：

| 配置 | 2000 次/秒 | 3000 次/秒 | 4000 次/秒 | 虚拟机 CPU（2000 → 4000 次/秒） |
|------|------|------|------|------|
| 不用缓存 | 3ms / 16ms | 4ms / 16ms | 4ms / 18–20ms | 15% → 22% → 31% |
| 只有 Redis | 2ms / 5ms | 3ms / 6ms | 3ms / 7–8ms | 5% → 7% → 10% |
| 本机 + Redis | 1.5ms / 4ms | 2ms / 4ms | 2ms / 4–5ms | 3% → 4% → 5% |

不用缓存时虚拟机的 CPU 随请求数近似线性上升，4000 次/秒时用到 31%，同一级两级缓存只有 5%；耗时上三者的差距仍然只有几毫秒。

第一条假设在这台机器上没有验证出来。商品详情的回源是一条按主键的查询，表里只有几行，数据库处理它比想象的便宜得多。

缓存在这一组里的价值不在「不加就垮」，而在这三项：

- **数据库的负载**：不用缓存的一轮查了 43 万次库，有缓存的两组各不到 10 次。数据库的 CPU 少用的部分看上去不多，但 [连接池与实例数实验](./12_exp_pool_sizing) 里同一台数据库在 86% 到 91% 之间就让下单从全部成功变成一半失败，省下来的每个百分点都是其他业务的余量
- **耗时**：本机缓存命中时 P50 是 1ms，只用 Redis 是 2ms，不用缓存是 2–3ms。[引入缓存](/project/4_cache) 第四节写的「L1 命中时 P99 从约 3ms 降到 1ms 以内」，实测是 3–4ms 降到 2–3ms，方向一致，幅度小一些（这里的耗时是从压测工具量的，含网关）
- **对 Redis 的依赖**：两级缓存时每秒只读 0.1 次 Redis（3 个 SKU 各自 30 秒过期一次），Redis 抖动时绝大多数请求感觉不到

缓存不可或缺的场景在下一节：回源不便宜的时候。

## 四、击穿：单飞与不单飞

![热点商品的缓存每 20 秒失效一次时每秒最慢的请求耗时](../assets/high-con/exp-cache-breakdown-max.svg)

300 次/秒全部请求同一个 SKU，每 20 秒失效一次，回源一次 200ms：

| 配置 | 每次失效的回源次数 | 失效后变慢的时间 | 变慢期间的 P95 / P99 / 最慢 | 受影响的请求 |
|------|------|------|------|------|
| 单飞 | 1 | 约 0.2 秒 | 160ms / 206ms / 210ms | 约 60 个 |
| 不单飞 | 约 75 | 约 0.7 秒 | 510ms / 660ms / 687ms | 约 200 个 |

两轮的数值几乎一样（单飞 180 秒内共回源 13 次，不单飞 611 次与 617 次）。其余时间两组的 P99 都是 2ms。

### 1、单飞：一个回源，其余的等它

缓存失效后的 200ms 里到达约 60 个请求。第一个去回源，其余的等它的结果，最慢的一个等了整整一次回源的时间（约 210ms）。回源一结束，60 个请求一起返回，之后的请求命中本机缓存。

### 2、不单飞：慢的时间是回源时间的三倍多

没有单飞时，这 60 个请求各自回源。回源耗时只有 200ms，最慢的请求却等了 687ms，原因在连接池：

- mall-app 的连接池是 20 条，每次回源占一条连接 200ms
- 60 多个回源一次只能跑 20 个，要分三四批，最后一批到第 600ms 之后才拿到连接
- 排队的这 0.6 秒里缓存一直是空的，新到的请求继续加入回源的队伍，所以回源次数是 75 而不是 60

**击穿的代价不只是多查了几十次库，还把连接池占满了一段时间**。这 0.7 秒里，mall-app 上所有要用数据库的接口都在同一个连接池后面排队。这次只有详情一个接口在压，换成正式流量，下单也会被这几十个回源挡在后面。回源越慢、失效瞬间的请求越多，这段时间就越长：按 3000 次/秒算，失效后的 200ms 里 Tomcat 的 200 个线程会全部卡在回源上，20 条连接要排 10 批，也就是 2 秒。

### 3、单飞挡不住的部分

单飞之后仍有约 60 个请求慢了 200ms，占那一秒的五分之一。要连这部分也消掉，得让缓存不在请求路径上失效：快过期时后台刷新，或者逻辑过期后先返回旧值。mall-evolution 没有做，因为真实回源只有两三毫秒。

单飞也只在一个实例内有效。3 个实例就是最多 3 个回源，[引入缓存](/project/4_cache) 第六节写的「几个实例最多几个请求到库」说的是这个。

## 五、穿透：空值缓存对随机 ID 无效

200 次/秒请求不存在的 SKU，180 秒共 3.6 万次：

| 请求的 ID | 缓存空值 | 查库次数 | 本机缓存条目数 | 耗时 P50 |
|------|------|------|------|------|
| 固定的 100 个 | 开 | 301 | 约 100 | 2.2ms |
| 固定的 100 个 | 关 | 约 36000 | 3 | 3.2ms |
| 每次随机 | 开 | 约 36000 | 6000 | 3.5ms |
| 每次随机 | 关 | 约 36000 | 3 | 3.2ms |

固定 ID 时空值缓存很有效，查库从 3.6 万次降到 301 次：100 个 ID 各查一次，之后 Redis 里的空值 60 秒过期再查一次，180 秒里一共 3 次。

随机 ID 时开不开没有区别，每个请求都是第一次见的 ID，全部打到数据库。开着反而多了两样东西：

- **本机缓存被占掉六成**：空值在本机缓存里放 30 秒，200 次/秒就是常驻 6000 条，而容量上限是 1 万条。请求速率超过 333 次/秒，这些没有人会再查的空值就会开始把真正的商品挤出去
- **Redis 里常驻一批没用的 key**：每个随机 ID 都往 Redis 写一条 60 秒的空值，按速率算常驻约 1.2 万条（这一项是按速率推算的，没有去 Redis 里数）

这一组的四个变体耗时都只有几毫秒，200 次/秒的主键查询对数据库不算什么。危险在于这是外部能直接控制的量：把速率加到几千，[连接池与实例数实验](./12_exp_pool_sizing) 里的情形就会重演，而空值缓存帮不上忙。

[引入缓存](/project/4_cache) 第六节的选择是「格式校验加空值缓存，暂不做布隆过滤器」。实验里的随机 ID 格式都是合法的，格式校验拦不住。**空值缓存防的是有限的一批不存在的 ID 被反复查，防不了遍历**；后者要在回源之前就能判断 ID 不存在，也就是布隆过滤器，或者在网关按来源限流。

## 六、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 缓存的收益先看给数据库省了多少，再看接口快了多少 | 主键查询不用缓存也只要 2–3ms，但每秒多 1600 次查库 |
| 热点 key 必须单飞，而且要算上连接池 | 不单飞时 75 个回源挤 20 条连接，慢了 0.7 秒，是回源时间的三倍多 |
| 回源慢的 key 不能等过期了再加载 | 单飞之后仍有五分之一的请求等满一次回源 |
| 空值缓存要和「ID 是否可能存在」的判断配合 | 随机 ID 时查库次数没有减少，本机缓存还被占掉六成 |
| 空值的过期时间和条目数要单独限制 | 空值与正常数据共用 1 万条的容量 |

## 七、复现

```powershell
.\experiments\f-cache-layers\run.ps1 -Variant f1-no-cache                     # 还有 f1-redis-only、f1-two-level
.\experiments\f-cache-layers\run.ps1 -Variant f2-breakdown-single-flight      # 还有 f2-breakdown-no-single-flight
.\experiments\f-cache-layers\run.ps1 -Variant f3-penetration-random-on        # 还有 repeat-on、repeat-off、random-off
.\experiments\f-cache-layers\run.ps1 -Variant f1-no-cache -Set "experiment:ha.startRps=2000","experiment:ha.stepRps=1000","experiment:ha.maxRps=4000"
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 商品只有 3 个，回源是最便宜的一种查询；逐层对照没有压出拐点是这个前提下的结论，换成带联表的详情或上万个 SKU，结果会不一样
- 逐层对照最高只压到 4000 次/秒：再往上压测工具自己先出问题（5000 次/秒时连接被拒、内存溢出），被测的服务还没到头
- 击穿那一组的 200ms 回源、回源期间占着连接都是模型
- 只有 1 个 mall-app 实例，多实例之间本机缓存失效的广播、各实例各自回源都没有测
- 穿透那一组「随机 ID、不缓存空值」的第二轮里，环境卡顿了约 1.5 秒，Tomcat 的 200 个线程一度全部占满；表里的耗时取的是另一轮
- 没有测雪崩（大量 key 同时过期）和 Redis 故障时的回源

## 小结

- 商品详情这种主键查询，到 4000 次/秒不用缓存也没有垮；缓存省下的是数据库的负载和 1–2ms 的耗时
- 热点失效时，单飞让回源从 75 次降到 1 次，变慢的时间从 0.7 秒降到 0.2 秒
- 不单飞的代价主要在连接池：几十个回源把 20 条连接占满，拖慢的是所有用数据库的接口
- 空值缓存把固定 ID 的查库从 3.6 万次降到 301 次，对随机 ID 完全无效，还占掉本机缓存六成的容量

## 参考资料

- Caffeine 的加载与并发语义：[Caffeine Wiki: Population](https://github.com/ben-manes/caffeine/wiki/Population)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[异步削峰实验](./10_exp_async_peak) —— 读流量之后看写：下单量升到 3 倍时，消息队列后面的消费端晚多久、多久追平。

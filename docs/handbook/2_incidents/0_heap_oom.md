---
description: 无界本地缓存导致 Java heap space、OOM dump 取证、MAT 定位、Caffeine 限容与告警
---

# 堆内存溢出

> 前置阅读：[故障排查](/jvm/9_troubleshooting)、[诊断工具](/jvm/8_monitoring_tools)

大促首日订单服务接连抛出 `Java heap space`，根因是一个没有容量上限的本地缓存。本篇复盘从 GC 趋势、dump 取证到 MAT 定位与修复，基线为 JDK 21、Spring Boot 4。

---

## 一、现象

10 月 9 日 20:05 大促开场，20:31 起 order-service（6 个 Pod，每个 `limits.memory=6Gi`，`-Xms4g -Xmx4g`，G1）陆续告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 20:31 | `JvmOldGenHigh`：Pod order-service-7d9f-x2k4p 老年代使用率 93%，持续 5 分钟 |
| 20:36 | `HttpP99High`：下单接口 P99 从 180ms 升到 4.2s |
| 20:38 | 应用日志出现 `java.lang.OutOfMemoryError: Java heap space`，同一 Pod 下单错误率 37% |
| 20:41 | 第二个 Pod 出现同样的 OOM；网关 5xx 比例 8% |

Grafana 上 `jvm_memory_used_bytes{area="heap"}` 呈"台阶式上涨"：每次 GC 后的低点都比上一次高，开场 30 分钟从 1.1GB 涨到 3.9GB，Full GC 后也降不下来。

---

## 二、影响

- 20:38–21:02 共 24 分钟，下单成功率从 99.95% 跌到最低 91.2%，约 1.3 万笔下单请求失败，用户侧表现为"系统繁忙，请稍后再试"
- 出问题的 Pod 因 OOM 后线程状态异常，未自动退出，K8s 存活探针仍偶尔成功，流量没有及时摘除
- 无数据错乱：下单在事务内失败回滚，库存预占由补偿任务释放

---

## 三、排查过程

### 1、确认是哪种 OOM

```bash
kubectl logs order-service-7d9f-x2k4p --since=30m | grep -m3 -B2 -A8 "OutOfMemoryError"
```

示例输出（节选）：

```text
2026-10-09T20:38:12.418+08:00 ERROR 1 --- [nio-8080-exec-87] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() ... threw exception
java.lang.OutOfMemoryError: Java heap space
	at java.base/java.util.Arrays.copyOf(Arrays.java:3541)
	at java.base/java.util.ArrayList.grow(ArrayList.java:237)
	at com.example.order.price.PriceSnapshotService.buildSnapshot(PriceSnapshotService.java:88)
	...
```

消息是 `Java heap space`，确定是堆。注意栈顶只是"最后一个申请内存失败的地方"，不一定是泄漏点，不能据此下结论。

### 2、看 GC 趋势：泄漏还是不够用

```bash
kubectl exec order-service-7d9f-x2k4p -- jstat -gcutil 1 5000 4
```

示例输出：

```text
  S0     S1     E      O      M     CCS    YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT
  0.00   0.00   0.00  98.71  97.12  93.40   4127   58.214    37   61.902    212    9.418   129.534
  0.00   0.00   0.00  98.85  97.12  93.40   4127   58.214    38   63.711    212    9.418   131.343
  0.00   0.00  12.50  98.85  97.12  93.40   4128   58.229    38   63.711    212    9.418   131.358
  0.00   0.00   0.00  99.02  97.12  93.40   4128   58.229    39   65.488    214    9.502   133.218
```

`O` 列 Full GC 后仍在 98% 以上，`FGC` 每十几秒加 1、每次约 1.8s：存活对象确实越来越多，是**泄漏**（或无界增长），不是瞬时峰值。加内存只能推迟。

### 3、取现场

启动参数里已有 `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/`，OOM 时已自动生成 dump：

```bash
kubectl exec order-service-7d9f-x2k4p -- ls -lh /data/dump/
```

示例输出：

```text
-rw------- 1 app app 3.8G Oct  9 20:38 java_pid1.hprof
```

`/data/dump` 挂的是 `emptyDir`，Pod 重启后会丢失，先拷出来再处理 Pod：

```bash
kubectl cp order-service-7d9f-x2k4p:/data/dump/java_pid1.hprof ./heap-x2k4p.hprof
```

没有自动 dump 时，用 `jcmd 1 GC.heap_dump /data/dump/heap.hprof` 手动导出；dump 会让进程停顿数秒，先把 Pod 从 Service 摘掉再导。

### 4、快速看类直方图

在第二个还没 OOM 的 Pod 上先看一眼，不用等 dump 下载完：

```bash
kubectl exec order-service-7d9f-m8q2c -- jcmd 1 GC.class_histogram | head -12
```

示例输出：

```text
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:      18734512     1198508768  [B (java.base@21.0.8)
   2:      18702133      448851192  java.lang.String (java.base@21.0.8)
   3:       6234890      299274720  java.math.BigDecimal (java.base@21.0.8)
   4:       2078230      182884240  com.example.order.price.PriceSnapshot
   5:       2079117       99797616  java.util.concurrent.ConcurrentHashMap$Node
   6:       2078230       66503360  com.example.order.price.SnapshotKey
```

`PriceSnapshot` 有 200 万个，`ConcurrentHashMap$Node` 数量和它几乎一样：大量快照被放在一个 Map 里。

### 5、MAT 定位引用链

用 MAT 打开 dump，Leak Suspects 报告第一条：

```text
Problem Suspect 1
One instance of "java.util.concurrent.ConcurrentHashMap" loaded by "org.springframework.boot.loader.launch.LaunchedClassLoader @ 0x6c0012a40"
occupies 2,934,512,640 (71.23%) bytes.
Keywords: java.util.concurrent.ConcurrentHashMap
          com.example.order.price.PriceSnapshotService
```

再看 Dominator Tree → 该 Map → Path to GC Roots：

```text
java.util.concurrent.ConcurrentHashMap @ 0x6c1a2b3c8       2,934,512,640
'- CACHE class com.example.order.price.PriceSnapshotService
   '- <class loader> org.springframework.boot.loader.launch.LaunchedClassLoader
```

被 `PriceSnapshotService` 的静态字段 `CACHE` 引用，GC Roots 是类本身，永远不会被回收。随便展开几个 key，发现 `SnapshotKey` 里有 `requestTime` 字段，每个 key 都不同。

---

## 四、根因

`PriceSnapshotService` 用静态 `ConcurrentHashMap` 缓存"用户 + 商品列表"的价格快照，本意是让同一用户短时间内重复进入结算页时不必重算：

```java
private static final Map<SnapshotKey, PriceSnapshot> CACHE = new ConcurrentHashMap<>();

public PriceSnapshot snapshot(long userId, List<Long> skuIds) {
    SnapshotKey key = new SnapshotKey(userId, skuIds, Instant.now());   // requestTime 进了 key
    return CACHE.computeIfAbsent(key, this::buildSnapshot);
}
```

两个问题叠加：

1. **没有容量上限和过期**：只放不删，平时 QPS 低、每周发版重启，增长被掩盖
2. **key 里混进了请求时间**：上周为了"区分活动前后价格"加的 `requestTime` 让缓存命中率为 0，每次请求都新增一条，等于把所有请求的快照全部留在堆里

大促 QPS 是平时 15 倍，30 分钟就把 4GB 堆填满。

---

## 五、修复

### 1、止血

- 20:44 对告警 Pod 执行滚动重启（`kubectl rollout restart deploy/order-service`），重启前已拷出 dump
- 20:50 通过配置中心关闭"结算页快照缓存"开关，代码里该开关关闭时直接计算不走缓存，堆增长停止
- 21:02 错误率恢复到 0.05% 以下

### 2、根治

缓存改用 Caffeine，限制条数和存活时间，key 只保留真正决定价格的字段：

```java
private final Cache<SnapshotKey, PriceSnapshot> cache = Caffeine.newBuilder()
        .maximumSize(200_000)                         // 按单条约 1KB 估算，上限约 200MB
        .expireAfterWrite(Duration.ofMinutes(5))      // 活动价变更后最多 5 分钟生效
        .recordStats()
        .build();

public PriceSnapshot snapshot(long userId, List<Long> skuIds, long priceVersion) {
    // priceVersion 来自活动配置版本号，替代 requestTime 区分活动前后
    SnapshotKey key = new SnapshotKey(userId, List.copyOf(skuIds), priceVersion);
    return cache.get(key, this::buildSnapshot);
}
```

同时把缓存注册到 Micrometer（`CaffeineCacheMetrics.monitor(registry, cache, "priceSnapshot")`），命中率、大小、驱逐数进入看板。

JVM 参数补上 OOM 后快速退出，让 K8s 立刻重建 Pod，而不是留一个"半死"进程继续接流量：

```text
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/
-XX:+ExitOnOutOfMemoryError
```

dump 目录改挂持久卷，避免重启丢现场。

---

## 六、预防

**监控告警**：

```yaml
- alert: JvmHeapAfterGcHigh
  # GC 后老年代占用仍超过 85%，比"堆使用率高"更能反映泄漏（Micrometer：live = 最近一次 GC 后的老年代占用）
  expr: |
    jvm_gc_live_data_size_bytes / jvm_gc_max_data_size_bytes > 0.85
  for: 10m
  labels: {severity: warning}
- alert: JvmFullGcFrequent
  expr: increase(jvm_gc_pause_seconds_count{action="end of major GC"}[5m]) > 3
  for: 5m
  labels: {severity: critical}
```

**代码规范**：

- 禁止用静态 `Map` 做缓存；本地缓存统一用 Caffeine，必须设置 `maximumSize` / `maximumWeight` 和过期时间（加入 Code Review 清单，ArchUnit 规则检查 `static final Map` 字段）
- 缓存 key 只能包含决定结果的业务字段，禁止时间戳、请求 ID、`traceId`

**测试**：

- 压测脚本增加"持续 1 小时稳定压测"场景，观察 GC 后老年代曲线是否平稳，而不只看峰值 RT
- 发布前对预发环境做一次 `GC.class_histogram` 对比（压测前 / 后），数量只增不减的业务类要能解释

---

## 七、涉及知识点

- 堆 OOM 的判断与常见泄漏场景：[故障排查](/jvm/9_troubleshooting#三、outofmemoryerror-java-heap-space)
- `jstat`、`jcmd`、MAT 的用法：[诊断工具](/jvm/8_monitoring_tools#九、mat-memory-analyzer-tool)
- OOM 相关启动参数：[GC 调优](/jvm/6_gc_tuning#_4、oom-保护)
- 堆的分代与对象晋升：[内存结构](/jvm/1_memory#四、内存分配与晋升策略)
- Caffeine 容量与过期策略：[Caffeine](/cache/7_caffeine)
- 告警规则编写与分级：[告警体系](/observability/4_alerting)

---

## 小结

- 判断堆 OOM 先看 GC 后老年代：降不下来是泄漏，加内存只能推迟
- OOM 栈顶只是最后一次分配失败的位置，泄漏点要靠 dump 的 Dominator Tree 和 GC Roots 引用链确认
- 现场先保再处理：自动 dump + 持久卷 + `ExitOnOutOfMemoryError`
- 本地缓存必须有上限和过期，key 里不能混入每次都不同的字段

## 参考资料

- 内存泄漏排查方法：[Troubleshoot Memory Leaks — Java Troubleshooting Guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshooting-memory-leaks.html)
- `-XX:+HeapDumpOnOutOfMemoryError`、`-XX:+ExitOnOutOfMemoryError`：[The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- `GC.class_histogram`、`GC.heap_dump`：[The jcmd Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- MAT 使用文档：[Eclipse Memory Analyzer](https://eclipse.dev/mat/)
- Caffeine 驱逐策略：[Caffeine Wiki — Eviction](https://github.com/ben-manes/caffeine/wiki/Eviction)

> 下一篇：[Metaspace 溢出](./1_metaspace_oom)

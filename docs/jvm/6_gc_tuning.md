# GC 调优实践

## 一、调优目标

调优前先明确目标，三者不可兼得：

| 目标 | 关注指标 | 推荐收集器 |
|------|---------|-----------|
| 高吞吐量 | GC 时间占比 < 1% | Parallel GC |
| 低延迟 | P99 停顿时间 | G1 / ZGC |
| 小内存占用 | 堆内存大小 | Serial / G1 |

**黄金法则：先监控，再调优；不要过早优化；每次只改一个参数。**

---

## 二、核心 JVM 参数

### 内存大小

```bash
# 堆（初始 = 最大，避免动态扩容抖动）
-Xms4g -Xmx4g

# 年轻代（NewRatio = 老年代/年轻代，默认2）
-XX:NewRatio=2
-XX:NewSize=1g -XX:MaxNewSize=2g   # 或直接指定

# Eden:S0:S1 = SurvivorRatio:(1):(1)，默认 8:1:1
-XX:SurvivorRatio=8

# 每线程栈大小（默认 512k-1m，线程多时考虑缩小）
-Xss512k

# 元空间（设上限防止无限扩张）
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m
```

### GC 选择

```bash
-XX:+UseG1GC           # G1（JDK9+ 默认）
-XX:+UseZGC            # ZGC（JDK11+）
-XX:+ZGenerational     # 分代 ZGC（JDK21+，需配合 UseZGC）
-XX:+UseParallelGC     # Parallel（高吞吐）
-XX:+UseSerialGC       # Serial（小内存）
```

### 晋升控制

```bash
-XX:MaxTenuringThreshold=15        # 晋升年龄阈值（默认15）
-XX:PretenureSizeThreshold=16m     # 大对象直接进老年代的阈值（G1/Serial/Parallel 有效）
-XX:TargetSurvivorRatio=50         # Survivor 区目标占用率
```

### OOM 保护

```bash
-XX:+HeapDumpOnOutOfMemoryError    # OOM 时自动 dump
-XX:HeapDumpPath=/logs/heapdump.hprof
-XX:OnOutOfMemoryError="kill -9 %p"  # OOM 后重启进程（配合守护进程）
```

---

## 三、G1 调优

```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200           # 目标停顿（软目标，不保证）
-XX:G1HeapRegionSize=16m           # Region 大小（2-32MB，2的幂，推荐堆/2048）
-XX:InitiatingHeapOccupancyPercent=45  # 触发并发标记的堆占用率（调低=更频繁标记）
-XX:G1ReservePercent=10            # 预留空间（防止晋升失败）
-XX:G1MixedGCCountTarget=8        # Mixed GC 的目标轮数
-XX:G1HeapWastePercent=5           # 可回收空间 < 5% 时停止 Mixed GC
```

**调优思路：**
- 停顿时间过长 → 调小 `MaxGCPauseMillis` 或 `G1HeapRegionSize`
- Full GC 频繁 → 增大 `G1ReservePercent`，降低 `InitiatingHeapOccupancyPercent`
- 大对象问题 → 大于 Region/2 的对象直接进 Humongous Region，连续 Region 分配，调大 Region 大小

---

## 四、ZGC 调优

```bash
-XX:+UseZGC
-XX:+ZGenerational                 # JDK21+ 开启分代
-XX:ConcGCThreads=2                # 并发 GC 线程数（默认 CPU/4）
-XX:ZCollectionInterval=0          # GC 间隔（0=自适应）
-XX:ZAllocationSpikeTolerance=2    # 分配速率峰值容忍倍数
```

ZGC 基本上"开箱即用"，调优空间有限，主要靠合理设置堆大小（建议至少 4 倍活跃对象大小）。

---

## 五、GC 日志

### JDK 9+ 统一日志格式

```bash
-Xlog:gc*:file=/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=10M
```

常用 tag：`gc`（基础）、`gc*`（全部）、`gc+heap`（含堆信息）

### JDK 8（旧格式）

```bash
-XX:+PrintGCDetails -XX:+PrintGCDateStamps
-Xloggc:/logs/gc.log
-XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=10M
```

---

## 六、完整启动配置示例

### 通用服务（JDK17+，G1）

```bash
java -Xms4g -Xmx4g \
     -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -XX:G1HeapRegionSize=16m \
     -XX:InitiatingHeapOccupancyPercent=45 \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/logs/heapdump.hprof \
     -Xlog:gc*:file=/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=10M \
     -jar app.jar
```

### 低延迟服务（JDK21+，ZGC）

```bash
java -Xms8g -Xmx8g \
     -XX:+UseZGC -XX:+ZGenerational \
     -XX:ConcGCThreads=2 \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/logs/heapdump.hprof \
     -Xlog:gc*:file=/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=10M \
     -jar app.jar
```

### 批处理（JDK11+，Parallel）

```bash
java -Xms4g -Xmx4g \
     -XX:+UseParallelGC \
     -XX:MaxGCPauseMillis=500 \
     -XX:GCTimeRatio=19 \
     -jar batch.jar
```

---

## 七、常见 GC 问题处理

### Full GC 频繁

| 原因 | 解决 |
|------|------|
| 老年代不足 | 增大堆内存，调大 `NewRatio` 让年轻代更大 |
| 晋升年龄太小 | 调大 `MaxTenuringThreshold` |
| 大对象太多 | 调大 `PretenureSizeThreshold`，检查代码 |
| 内存泄漏 | 用 MAT 分析 heap dump |

### GC 停顿时间长

| 原因 | 解决 |
|------|------|
| 堆内存过大 | 减小堆或换 ZGC |
| GC 线程不足 | 增加 `ParallelGCThreads` / `ConcGCThreads` |
| Humongous 对象（G1） | 增大 Region 大小 |
| 换用低延迟收集器 | ZGC / Shenandoah |

---

## 八、常见面试问题

**Q：如何确定堆内存大小？**
一般原则：最大堆 = 活跃对象大小 × 3-4 倍（G1）；ZGC 至少 4 倍。通过 `jstat -gc` 观察老年代稳定后的 Full GC 后大小即为活跃对象大小。

**Q：`-Xms` 和 `-Xmx` 为什么推荐设为相同值？**
若两者不同，堆需要在 Xms~Xmx 之间动态扩缩容，扩容操作本身会触发 GC 并带来额外开销；设为相同值可以消除这种抖动。

**Q：线上不能加 `-XX:+HeapDumpOnOutOfMemoryError` 吗？**
可以加，推荐加。dump 文件生成时会有短暂停顿，但 OOM 时进程往往已不可用，dump 是排查问题的关键证据；不开启的话 OOM 后无从分析。

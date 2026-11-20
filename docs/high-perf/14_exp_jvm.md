---
description: 四种收集器与两档堆的耗时和停顿、P99 钉在 16 毫秒的原因、JDK 21 与 25、不预热接流量与慢启动、只用 C1
---

# 收集器与预热实验

> 前置阅读：[JVM 层性能策略](./5_jvm_tuning)、[GC 收集器](/jvm/5_gc_collectors)、[JIT 编译](/jvm/7_jit)

mall-evolution 的 mall-app 一直用默认的收集器和 512MB–1GB 的堆。本篇在同一组只读流量下换收集器、堆大小和 JDK，再让没有预热的实例直接接流量，看耗时与停顿各差多少，基线为 JDK 21，其中两个变体在 JDK 25 上再跑一遍。

## 一、现象与假设

收集器选型是最常被拿出来讨论的 JVM 调优项。[JVM 层性能策略](./5_jvm_tuning) 的建议是先确认 GC 和尾部耗时有关再动，这一篇就来确认一遍。

| 假设 | 怎么验证 |
|------|---------|
| 换收集器不影响平均值和 P50，影响的是 P99.9 之后的尾部 | Serial、Parallel、G1、ZGC 各压一遍，比各分位数 |
| ZGC 的停顿最短，代价是多用 CPU | GC 日志里的停顿，进程 CPU |
| 堆减半，回收次数翻倍，单次停顿变化不大 | 1GB 与 512MB 各一组 |
| 没有预热的实例直接接满流量，头几十秒会很慢；流量慢慢加上来可以避免 | 不预热全速、不预热但 30 秒爬坡 |
| JIT 的最后一层编译值不少 CPU | 只开第一层编译器（C1）再压 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 压测直接打 mall-app 的端口，不经网关；被测的只有 mall-app 的 JVM |
| CPU | mall-app 进程绑在 4 个逻辑 CPU 上，JVM 加 `-XX:ActiveProcessorCount=4`，相当于一个 4 核的容器 |
| 流量 | 开放模型、固定速率：订单列表 1000 次/秒、订单详情 1000 次/秒，只读；在 100 个用户里随机挑，数据页都在数据库的缓存里 |
| 时长 | 预热 60 秒，正式 240 秒；冷启动的两个变体不预热，压 180 秒 |
| 记录 | GC 日志（`-Xlog:gc*,safepoint`）、压测端每个请求的耗时、进程 CPU |
| 轮数 | 每个变体 2 轮，下文按「第一轮 / 第二轮」列出 |

不经网关是因为 [耗时定位实验](./12_exp_locate) 量过，一次查询里网关那一跳比 mall-app 自己还久，会把 JVM 的差别盖住。绑核是因为开发机有 28 个逻辑 CPU，不限制的话并发回收的线程永远有空闲的核可用，看不出它和业务线程抢 CPU。

| 变体 | 收集器 | 堆 | JDK | 预热 |
|------|------|------|------|------|
| 8 个 | Serial、Parallel、G1、分代 ZGC | 1GB、512MB | 21 | 60 秒 |
| 2 个 | G1、ZGC | 1GB | 25 | 60 秒 |
| 不预热 | G1 | 1GB | 21 | 无，第 0 秒就是全速 |
| 慢启动 | G1 | 1GB | 21 | 无，开头 30 秒从 10% 线性升到 100% |
| 只用 C1 | G1，`-XX:TieredStopAtLevel=1` | 1GB | 21 | 60 秒 |

这个流量下 mall-app 用 1.2 个核（4 核的 30%），每秒分配约 340MB，完整回收之后堆里还剩约 180MB。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 正式的 JVM 参数（堆取容器内存的 75%，收集器用默认值） | [`Dockerfile`](https://github.com/Clarence404/mall-evolution/blob/main/Dockerfile)、[`deploy/k8s/mall-app.yaml`](https://github.com/Clarence404/mall-evolution/blob/main/deploy/k8s/mall-app.yaml) |
| 启动预热与预热完再注册 | [`ProductWarmupRunner`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/detail/ProductWarmupRunner.java)、[`RegisterWhenReady`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/lifecycle/RegisterWhenReady.java) |
| 绑核与各变体的 JVM 参数 | [`experiments/k-jvm/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/k-jvm)、[`HaExperiment.psm1`](https://github.com/Clarence404/mall-evolution/blob/main/experiments/lib/HaExperiment.psm1) |
| 压测场景 | [`LocateSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/LocateSimulation.java) |

各变体只换一行 JVM 参数：

```properties
# experiments/k-jvm/common.properties（节选）
[script]
mallAppCpus=4

[jvm]
mall-app=-Xms1g -Xmx1g -XX:ActiveProcessorCount=4 -XX:+UseG1GC -Xlog:gc*,safepoint:file={run}/gc-{name}.log:time,uptime,level,tags

# experiments/k-jvm/k1-zgc-512m.properties
[jvm]
mall-app=-Xms512m -Xmx512m -XX:ActiveProcessorCount=4 -XX:+UseZGC -XX:+ZGenerational -Xlog:gc*,safepoint:file={run}/gc-{name}.log:time,uptime,level,tags
```

## 三、收集器与堆大小：耗时上分不出来

订单列表在压测端看到的耗时，JDK 21（第一轮 / 第二轮）：

| 收集器 | 堆 | 平均 | P50 | P99 | P99.9 | 最大 |
|------|------|------|------|------|------|------|
| Serial | 1GB | 4.11ms / 4.01ms | 3.59ms / 3.49ms | 16.5ms / 16.6ms | 19.7ms / 19.3ms | 44ms / 32ms |
| Parallel | 1GB | 4.07ms / 3.93ms | 3.60ms / 3.44ms | 16.6ms / 16.6ms | 19.2ms / 18.9ms | 55ms / 47ms |
| G1 | 1GB | 3.96ms | 3.52ms | 16.5ms | 19.1ms | 35ms |
| ZGC | 1GB | 4.38ms / 4.01ms | 3.85ms / 3.57ms | 16.7ms / 16.5ms | 35.1ms / 19.4ms | 295ms / 51ms |
| Serial | 512MB | 4.07ms / 4.03ms | 3.54ms / 3.50ms | 16.5ms / 16.6ms | 19.3ms / 19.1ms | 39ms / 32ms |
| Parallel | 512MB | 3.94ms / 3.93ms | 3.45ms / 3.44ms | 16.6ms / 16.6ms | 18.8ms / 19.0ms | 26ms / 42ms |
| G1 | 512MB | 4.00ms / 4.01ms | 3.53ms / 3.58ms | 16.6ms / 16.4ms | 19.4ms / 19.2ms | 34ms / 33ms |
| ZGC | 512MB | 4.13ms / 4.07ms | 3.69ms / 3.62ms | 16.5ms / 16.5ms | 20.1ms / 19.5ms | 78ms / 32ms |

G1 1GB 夜里只有一轮可用：另一轮启动时端口被别的进程占着，后来补的几轮要么被同一台机器上的分析任务干扰、要么是白天跑的，机器状态不一样，放在第四节单独看。

八个变体的平均值都在 3.9–4.4ms，P50 在 3.4–3.9ms，P99 全部是 16.4–16.7ms，P99.9 除了一轮之外都是 19–20ms。**在这个负载下，换收集器、把堆减半，压测端看到的耗时没有可以分辨的差别**，连预期会不一样的 P99.9 也一样。

ZGC 1GB 的第一轮是那个例外：第 176–177 秒有两秒整体变慢，最大 295ms。那两秒 GC 日志里没有停顿，同一时刻数据库虚拟机的 CPU 从 25% 升到 59%，更像是数据库那头的抖动；第二轮没有再出现。

差别在 GC 日志里：

![240 秒里垃圾回收一共让业务线程停了多久](../assets/high-perf/exp-jvm-gc-pause.svg)

| 收集器 | 堆 | 停顿次数 | 停顿合计 | 最长一次 | mall-app 用的 CPU |
|------|------|------|------|------|------|
| Serial | 1GB | 278 / 280 | 1798ms / 1637ms | 9.6ms / 9.5ms | 1.18 核 / 1.17 核 |
| Parallel | 1GB | 225 / 221 | 472ms / 507ms | 3.9ms / 11.3ms | 1.19 核 / 1.13 核 |
| G1 | 1GB | 125 | 501ms | 6.6ms | 1.23 核 |
| ZGC | 1GB | 836 / 649 | 15ms / 11ms | 0.05ms / 0.45ms | 1.39 核 / 1.28 核 |
| Serial | 512MB | 567 / 563 | 2635ms / 2612ms | 7.6ms / 7.7ms | 1.22 核 / 1.19 核 |
| Parallel | 512MB | 458 / 460 | 752ms / 862ms | 12.8ms / 4.5ms | 1.14 核 / 1.12 核 |
| G1 | 512MB | 259 / 272 | 735ms / 789ms | 5.3ms / 4.7ms | 1.22 核 / 1.23 核 |
| ZGC | 512MB | 2042 / 1560 | 33ms / 26ms | 0.09ms / 0.06ms | 1.37 核 / 1.31 核 |

- **停顿合计差两个数量级**：240 秒里 Serial 512MB 一共停了 2.6 秒（1.1% 的时间），G1 和 Parallel 是 0.5–0.9 秒，ZGC 是 11–33 毫秒
- **单次停顿都很短**：最长的一次也只有 13ms，ZGC 不到半毫秒。堆里只有 180MB 活对象，年轻代回收要拷贝的东西很少
- **堆减半，次数翻倍**：四种收集器从 1GB 到 512MB，停顿次数都是原来的 2 倍上下，单次停顿没有变长
- **ZGC 多用一成 CPU**：1.3–1.4 核对 1.1–1.2 核，并发回收的线程在和业务线程分那 4 个核

停顿合计差了两个数量级，耗时却一样，是因为停顿在这里本来就不是尾部的来源。Serial 512MB 是最差的一档，也只有 1.1% 的时间处在停顿里，每次 5ms 上下；赶上停顿的请求多等几毫秒，从 3.5ms 变成 8ms，还到不了 P99 的 16.5ms。P99 那个位置上是别的东西。

## 四、P99 钉在 16.5ms：不是 GC

八个变体的 P99 都是 16.5ms，这本身就不正常：收集器不同、停顿差两个数量级，尾部却一模一样，说明决定 P99 的东西和 GC 无关。把分位数放下，看分布：

![订单列表的耗时分布](../assets/high-perf/exp-jvm-latency-hump.svg)

绝大多数请求在 2–6ms，之后迅速减少；但在 15–20ms 处又冒出一个小峰，装着 2.3%–3.0% 的请求（订单详情是 2.9%–4.0%）。超过 1% 的请求在这个小峰里，P99 就落在峰上。所有 JDK 21 的变体都有这个峰，位置和大小都一样。

15ms 多一点是一个很特别的数：Windows 默认的时钟周期是 15.6ms。写一个二十行的小程序，量一下「让线程挂起 10 微秒」实际睡了多久：

| 调用 | JDK 21 | JDK 25 |
|------|------|------|
| `LockSupport.parkNanos(10 微秒)` | 15.2ms | 1.5ms |
| `LockSupport.parkNanos(1 毫秒)` | 15.2ms | 1.5ms |
| `Thread.sleep(1)` | 2.0ms | 2.0ms |

在这台 Windows 开发机上，JDK 21 的短时间挂起会一直睡到下一个时钟周期。剩下的问题是谁在请求路径上做这种挂起。给 mall-app 录一段 JFR，把 1ms 以上的线程挂起连同调用栈都记下来，按「挂起了 10–20ms」筛：

```text
6754 次，平均 12.6ms，要求挂起的时长 = 0.01 ms
    com.zaxxer.hikari.util.ConcurrentBag.requite
    com.zaxxer.hikari.pool.HikariPool.recycle
    com.zaxxer.hikari.pool.PoolEntry.recycle
    com.zaxxer.hikari.pool.ProxyConnection.close
    org.springframework.jdbc.datasource.DataSourceUtils.doCloseConnection
```

是连接池归还连接的地方。HikariCP 归还一条连接时，如果发现有别的线程正在借连接，会先让出 CPU 自旋一阵，还没交接出去就挂起 10 微秒再试。200 个 Tomcat 线程共用 20 条连接，这种碰撞每秒有三十多次；每一次，本该 10 微秒的挂起在 JDK 21 上变成 13ms，正在等这条连接的线程也跟着多等。

接着怀疑绑核：如果正在借连接的线程在 4 个核上抢不到 CPU，来还连接的线程就更容易走到挂起那一步。第二天上午把绑核和不绑核各跑了两轮。这时机器上有别的程序在用，数字不能和夜里的直接比，只在这四轮之间比：

| 当天上午 | 小峰里的请求 | 平均 | P50 | P99 |
|------|------|------|------|------|
| 绑 4 核 | 约 11% / 约 11% | 4.82ms / 5.20ms | 3.30ms / 3.48ms | 17.6ms / 18.1ms |
| 不绑核 | 3.8% / 2.5% | 3.69ms / 3.65ms | 2.93ms / 3.05ms | 15.9ms / 15.8ms |

不绑核时小峰还在，P99 仍然落在 16ms 上，所以绑核不是原因。绑核会把它放大：同样绑 4 核，夜里机器空闲时是 2.6%，白天有别的程序来分这几个核时到了 11%。

这个小峰是「Windows 加 JDK 21」的产物。时钟周期 15.6ms 是 Windows 的特性，生产环境的 Linux 上短时间挂起一般是几十微秒，不会有这个峰；这次没有在 Linux 上量。但找到它的过程和平台无关：

- **各变体的尾部一模一样，先怀疑尾部和正在比的东西无关**
- **看分布，不只看分位数**：P99 是 16.5ms 这个数字本身说明不了什么，分布上的第二个峰才是线索
- **用一个最小的程序验证猜测**，再用带调用栈的事件找到具体是哪一行

## 五、换成 JDK 25

同样的 G1 和 ZGC、1GB 的堆，mall-app 换成 JDK 25（第一轮 / 第二轮）：

| 变体 | 平均 | P50 | P99 | P99.9 | 小峰里的请求 | mall-app 用的 CPU |
|------|------|------|------|------|------|------|
| G1，JDK 21 | 3.96ms | 3.52ms | 16.5ms | 19.1ms | 2.6% | 1.23 核 |
| G1，JDK 25 | 3.59ms / 3.57ms | 3.43ms / 3.41ms | 7.7ms / 7.7ms | 16.5ms / 14.8ms | 0.12% / 0.11% | 1.16 核 / 1.11 核 |
| ZGC，JDK 21 | 4.38ms / 4.01ms | 3.85ms / 3.57ms | 16.7ms / 16.5ms | 35.1ms / 19.4ms | 2.5% | 1.39 核 / 1.28 核 |
| ZGC，JDK 25 | 3.71ms / 3.67ms | 3.56ms / 3.53ms | 7.8ms / 7.8ms | 16.5ms / 16.6ms | 0.14% / 0.16% | 1.25 核 / 1.24 核 |

P99 从 16.5ms 降到 7.7ms，平均值低了 0.3–0.4ms。换收集器换不来的尾部改善，换 JDK 换来了，原因是上一节那个小峰：JDK 25 上短时间挂起是 1.5ms，同样的碰撞只多等 1.5ms，小峰里的请求从 2.6% 降到 0.1%。P50 只差 0.1ms，绝大多数请求并没有变快。

JDK 25 上 G1 和 ZGC 之间仍然没有差别：P99 都是 7.7–7.8ms，P99.9 都在 15–17ms。ZGC 的 CPU 还是比 G1 高一成。

## 六、没有预热就接流量

![刚启动的实例接流量头 60 秒逐秒的中位耗时](../assets/high-perf/exp-jvm-cold-start.svg)

服务起来之后一个请求都没处理过，第 0 秒就按 2000 次/秒打过来：

| 指标 | 不预热，全速（第一轮 / 第二轮） | 不预热，30 秒爬坡 |
|------|------|------|
| 失败的请求（都在头 10 秒） | 3610 个 / 5839 个 | 0 / 0 |
| 中位耗时超过 1 秒的时段 | 第 2–17 秒 / 第 2–11 秒 | 无 |
| 恢复到中位耗时 10ms 以内 | 第 23 秒 / 第 17 秒 | 第 2–3 秒 |
| 之后的耗时 | 和预热过的一样 | 和预热过的一样 |

全速的那一组，头 8–9 秒里有 3600–5800 个请求直接失败，其中 95%–98% 是连接被拒绝：代码还在解释执行，处理的速度跟不上请求进来的速度，连接排满了就开始拒绝。之后的十来秒里请求不再失败，但中位耗时是 1–3 秒，因为要先消化积压。到第 17–23 秒才恢复正常，这段时间里 JIT 把热点代码编译完了。

爬坡的那一组从 200 次/秒开始，30 秒升到 2000 次/秒，一个请求都没有失败，除了第 1 秒的中位耗时是 0.5 秒之外，之后一直是几毫秒。同样没有预热，差别只是给了 JIT 追上来的时间。爬坡的第一轮在第 28–29 秒（流量快升满时）有两秒中位耗时到了 0.4–0.5 秒，第二轮没有。

预热过的几组在压测的预热阶段其实也经历了一次同样的冷启动（预热也是第 0 秒全速），其中 ZGC 的 GC 日志里多出一样东西：

| ZGC 变体 | 预热阶段的分配停顿（各轮） | 最长一次 | 正式阶段 |
|------|------|------|------|
| 1GB，JDK 21 | 2868 次 / 392 次 | 1306ms / 520ms | 0 |
| 512MB，JDK 21 | 3955 次 / 3125 次 | 602ms / 829ms | 0 |
| 1GB，JDK 25 | 885 次 / 514 次 | 863ms / 1118ms | 0 |

分配停顿（Allocation Stall）是 ZGC 来不及回收、申请内存的线程只能原地等的情况。ZGC 没有长的全局停顿，但回收跟不上分配时，代价以这种形式出现。冷启动时积压的请求一起涌进来，分配速率远高于平时，1GB 的堆也不够它周转。正式阶段一次也没有出现。

mall-evolution 现在的启动预热（[`ProductWarmupRunner`](https://github.com/Clarence404/mall-evolution/blob/main/mall-product/src/main/java/io/github/clarence404/mall/product/detail/ProductWarmupRunner.java)）热的是连接池和商品缓存，没有热代码。这一组说明新实例注册进来之后还需要一段小流量的时间：金丝雀发布的分步放量自带这个效果，直接滚动更新、新实例一就绪就接满流量的话，会有十几秒的慢请求。这次没有改代码。

## 七、只用 C1

`-XX:TieredStopAtLevel=1` 让 JIT 停在第一层编译器，不做第二层（C2）的深度优化：

| 指标 | 默认（C1 + C2） | 只用 C1（第一轮 / 第二轮） |
|------|------|------|
| mall-app 用的 CPU | 1.23 核 | 2.50 核 / 2.50 核 |
| 订单列表平均耗时 | 3.96ms | 5.93ms / 5.97ms |
| P50 | 3.52ms | 5.83ms / 5.85ms |
| P99 | 16.5ms | 13.2ms / 13.4ms |

同样的流量，CPU 多用一倍，平均耗时高 50%。C2 的优化在这个服务上值一半的 CPU。

P99 反而低了 3ms，是第四节那个小峰的缘故：只用 C1 时小峰里的请求是 1.1%，刚好贴着 1% 的线，P99 落在了峰的前沿。这再次说明单看一个分位数容易得出相反的结论。

## 八、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 先确认停顿是尾部的来源，再考虑换收集器 | 四种收集器停顿合计差两个数量级，P99、P99.9 没有差别 |
| 比较之前先看耗时的分布 | 2.3%–3.0% 的请求在 15–20ms 的小峰里，P99 是它决定的，和 GC 无关 |
| 各变体的尾部一模一样时，去找和变体无关的原因 | 小峰来自连接池归还连接时的一次短暂挂起，在这台机器的 JDK 21 上被放大到 13ms |
| 堆的大小按活对象的倍数给，够用之后再加大只是减少回收次数 | 活对象 180MB，512MB 和 1GB 耗时一样，停顿次数差一倍 |
| ZGC 要留出 CPU 和内存的余量 | 多用一成 CPU；冷启动时回收跟不上，出现最长 1.3 秒的分配停顿 |
| 新实例先接小流量 | 不预热全速：头 8–9 秒大量失败，17–23 秒才恢复；30 秒爬坡：零失败 |
| 升级 JDK 之后重新量一遍，不沿用旧版本上的结论 | 同样的代码，JDK 25 的 P99 是 JDK 21 的一半 |

## 九、复现

```powershell
.\experiments\k-jvm\run.ps1 -Variant k1-g1-1g          # 还有 k1-<serial|parallel|g1|zgc>-<1g|512m>
.\experiments\k-jvm\run.ps1 -Variant k1-zgc-1g-jdk25   # 要设环境变量 MALL_JAVA25_HOME
.\experiments\k-jvm\run.ps1 -Variant k2-cold           # 还有 k2-ramp、k2-c1-only
.\experiments\k-jvm\run.ps1 -Variant k1-g1-1g-jfr      # 给 mall-app 录 JFR，找挂起出在哪；k1-g1-1g-unpinned 是不绑核
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 服务跑在 Windows 开发机上，第四节的小峰是这个平台特有的；Linux 上没有量，各收集器之间的差别在 Linux 上可能会显出来一些，但「停顿只占 1% 的时间、每次几毫秒」这一点不会变
- 负载只到 4 核的 30%，活对象只有 180MB。堆给得更紧、对象更多、CPU 更满的时候，收集器之间会有差别，这次没有量到那个区间
- 正式的部署是 8GB 内存、6GB 的堆，比实验里的 1GB 大得多；堆越大单次回收要处理的东西越多，停顿的数字不能直接搬过去
- 压测端每个请求新建一条连接，冷启动时「连接被拒绝」比连接复用的客户端来得更早
- 冷启动全速那一类场景对压测工具也不友好：近三十轮里有 3 轮，压测端在预热阶段的连接被拒之后内存溢出、再没有恢复，这 3 轮作废重跑
- ZGC 1GB 第一轮的两秒抖动、爬坡第一轮的两秒抖动，原因都没有查清
- G1 1GB 这个基准变体夜里只有一轮；白天补的绑核两轮小峰大了几倍，说明这个现象对机器当时的状态很敏感，表里 2%–3% 这个数只对夜里空闲的机器成立

## 小结

- Serial、Parallel、G1、ZGC 在 1GB 和 512MB 的堆上，平均、P50、P99、P99.9 都分不出差别；差别在停顿合计（2.6 秒到 11 毫秒）和 CPU（ZGC 多一成）
- P99 钉在 16.5ms 是因为 2%–3% 的请求落在 15–20ms 的小峰里：连接池归还连接时一次 10 微秒的挂起，在 Windows 的 JDK 21 上睡满一个 15.6ms 的时钟周期
- 换成 JDK 25，同样的挂起是 1.5ms，P99 降到 7.7ms；G1 和 ZGC 之间仍然没有差别
- 不预热全速接流量，头 8–9 秒大量失败、17–23 秒才恢复；用 30 秒爬坡则没有失败。ZGC 在冷启动时还会出现分配停顿
- 只用 C1 编译器，CPU 多用一倍，平均耗时高 50%

## 参考资料

- 收集器的选择与调优：[HotSpot Virtual Machine Garbage Collection Tuning Guide (Java 21)](https://docs.oracle.com/en/java/javase/21/gctuning/)
- 分代 ZGC：[JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
- GC 日志的写法：[JEP 271: Unified GC Logging](https://openjdk.org/jeps/271)
- 连接池的借还逻辑：[HikariCP: ConcurrentBag](https://github.com/brettwooldridge/HikariCP/blob/dev/src/main/java/com/zaxxer/hikari/util/ConcurrentBag.java)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[微基准实验](./15_exp_microbench) —— 用 JMH 量几段每个请求都会走到的代码，再把结果放回一次请求里看占多少。

---
description: Serial / Parallel / CMS / G1 / ZGC（含分代 ZGC）/ Shenandoah 对比与选型
---

# GC 收集器

> 前置阅读：[GC 原理](./4_gc_theory)

收集器的演进主线是**把越来越多的 GC 工作从 STW 挪到并发阶段**：Serial 全程停顿 → Parallel 多线程停顿 → CMS 并发标记 → G1 可预测停顿 → ZGC / Shenandoah 并发整理。本篇讲 HotSpot 各款收集器的工作方式、适用场景与 JDK 版本演进，以及按业务目标选型。

---

## 一、收集器概览

**经典收集器分年轻代与老年代两块、需要成对搭配；G1 之后的收集器自己管理整个堆。**

| 收集器 | 负责区域 | 线程 | 算法 | 状态 |
|-------|---------|------|------|------|
| Serial | 年轻代 | 单线程 | 复制 | 可用 |
| ParNew | 年轻代 | 多线程 | 复制 | JDK 9 废弃、JDK 10 移除 |
| Parallel Scavenge | 年轻代 | 多线程 | 复制 | 可用 |
| Serial Old | 老年代 | 单线程 | 标记-整理 | 可用 |
| Parallel Old | 老年代 | 多线程 | 标记-整理 | 可用 |
| CMS | 老年代 | 并发 | 标记-清除 | JDK 9 废弃、JDK 14 移除 |
| G1 | 整堆（分 Region） | 并行 + 并发 | 整体标记-整理，Region 间复制 | JDK 9 起默认 |
| ZGC | 整堆 | 并发 | 并发标记-整理 | JDK 15 起生产可用 |
| Shenandoah | 整堆 | 并发 | 并发标记-整理 | OpenJDK 12 合入 |
| Epsilon | 整堆 | — | 不回收 | JDK 11 实验性引入 |

### 1、经典收集器的搭配

| 年轻代 | 老年代 | 启用参数 | 说明 |
|-------|-------|---------|------|
| Serial | Serial Old | `-XX:+UseSerialGC` | 单线程组合 |
| Parallel Scavenge | Parallel Old | `-XX:+UseParallelGC` | 吞吐量优先，JDK 8 默认 |
| ParNew | CMS（后备 Serial Old） | `-XX:+UseConcMarkSweepGC` | 低停顿组合，JDK 14 起已不可用 |

---

## 二、经典分代收集器

### 1、Serial / Serial Old

**单线程收集，GC 时暂停所有应用线程；简单、额外开销最小。**

- 年轻代用复制算法，老年代用标记-整理
- 适合单核 CPU、小堆（几百 MB 以内）的客户端或小型容器
- 参数：`-XX:+UseSerialGC`

### 2、ParNew

**Serial 的多线程版本，历史上唯一能与 CMS 搭配的并行年轻代收集器。**

- JDK 9 起 `-XX:+UseParNewGC` 被废弃（只能随 CMS 隐式启用），JDK 10 移除该参数
- CMS 移除后，ParNew 也随之退出历史

### 3、Parallel Scavenge / Parallel Old

**关注吞吐量**（吞吐量 = 用户代码时间 / (用户代码时间 + GC 时间)）。

- 年轻代、老年代都多线程并行回收，但全程 STW
- 自适应调节（`-XX:+UseAdaptiveSizePolicy`，默认开启）：根据目标自动调整 Eden / Survivor 大小和晋升阈值
- 参数：`-XX:+UseParallelGC`、`-XX:MaxGCPauseMillis`、`-XX:GCTimeRatio=99`（GC 时间占比目标 1/(1+99)）
- **JDK 8 默认收集器**，适合批处理、离线计算等不在意单次停顿的场景

### 4、CMS（Concurrent Mark Sweep）

**第一款真正意义上的并发收集器，用标记-清除回收老年代，目标是缩短停顿。**

| 阶段 | 是否 STW | 工作内容 |
|------|---------|---------|
| 初始标记 | 是 | 只标记 GC Roots 直接关联的对象，很快 |
| 并发标记 | 否 | 从初始标记结果出发遍历对象图，耗时最长 |
| 重新标记 | 是 | 用增量更新修正并发标记期间变动的引用 |
| 并发清除 | 否 | 清除未标记对象，不移动存活对象 |

- **内存碎片**：标记-清除不整理，碎片严重时只能 Full GC
- **占用 CPU**：并发阶段与业务线程抢 CPU，核数少时影响明显
- **浮动垃圾**：并发阶段新产生的垃圾本轮无法回收，因此必须预留空间提前启动；预留不足会发生 Concurrent Mode Failure，退化为 Serial Old 单线程 Full GC，停顿极长
- JDK 9 标记废弃，JDK 14 移除；参数 `-XX:+UseConcMarkSweepGC` 仅对 JDK 13 及以前有效

---

## 三、G1（Garbage First）

**G1 把堆划分为大量等大的 Region，每次优先回收"垃圾最多、回收收益最高"的 Region，从而把停顿控制在目标时间内。** JDK 9 起为默认收集器。

### 1、Region 布局

![G1 Region 分布](../assets/jvm/g1-region-layout.svg)

- 每个 Region 在某一时刻扮演 Eden、Survivor、Old 或 Humongous 中的一种角色，回收后重新变为空闲，不要求同类 Region 物理连续
- **Region 大小**：1MB–32MB，必须是 2 的幂；默认按堆约划分 2048 个 Region 计算；JDK 18 起上限提高到 512MB。可用 `-XX:G1HeapRegionSize` 显式指定
- **Humongous**：大小 ≥ Region 一半的对象直接分配到一个或多个连续的 Humongous Region，逻辑上属于老年代
- 每个 Region 有自己的 **RSet**（记忆集），记录其他 Region 指向本 Region 的引用，回收单个 Region 时无需扫描整堆

### 2、回收过程

| 阶段 | 是否 STW | 说明 |
|------|---------|------|
| Young GC | 是 | 回收所有 Eden 和 Survivor Region，存活对象复制到新的 Survivor / Old Region |
| 并发标记周期 | 大部分并发 | 老年代占用达到 IHOP 阈值后启动：初始标记（搭 Young GC 便车）→ 并发标记（SATB）→ 最终标记（STW）→ 清理 |
| Mixed GC | 是 | 回收全部年轻代 + 一批回收收益最高的 Old Region，通常分多轮进行 |
| Full GC | 是 | 兜底手段，发生在转移失败、Humongous 分配失败等情况；JDK 10 起（JEP 307）为多线程并行 |

### 3、为什么能控制停顿

G1 记录每个 Region 的存活对象比例和历史回收耗时，每次在 `MaxGCPauseMillis` 目标内挑选回收收益最高的 Region 组成回收集合（CSet），同时动态调整年轻代大小。这是一个**软目标**：尽力达到，不保证。

### 4、关键参数

```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200                # 目标停顿时间（软目标，默认 200ms）
-XX:G1HeapRegionSize=16m                # Region 大小，一般无需设置
-XX:InitiatingHeapOccupancyPercent=45   # IHOP 初始值，JDK 9 起默认自适应调整
```

- 适合 4GB 到数十 GB 的堆，兼顾吞吐与延迟，是大多数服务端应用的默认选择
- 调优方法见 [GC 调优](./6_gc_tuning)

---

## 四、ZGC（Z Garbage Collector）

**ZGC 把标记、转移、重定位几乎全部并发执行，停顿时间不随堆大小和存活对象数量增长。**

### 1、核心技术

- **染色指针**（Colored Pointers）：把 GC 状态编码在 64 位指针的元数据位中，不需要读对象头就能知道指针状态
- **读屏障**（Load Barrier）：业务线程从堆中加载引用时检查指针颜色，遇到"旧地址"就就地修正，这是并发转移的基础
- **并发转移**：对象移动与业务线程同时进行，转移过程中的访问由读屏障兜底

### 2、版本演进

| JDK 版本 | 变化 |
|---------|------|
| JDK 11 | 实验性引入（Linux x64） |
| JDK 15 | 转为生产可用（JEP 377） |
| JDK 16 | 并发线程栈扫描（JEP 376），停顿降至亚毫秒级 |
| JDK 21 | 引入分代 ZGC（JEP 439），需 `-XX:+ZGenerational` 开启 |
| JDK 23 | 分代模式成为 ZGC 默认（JEP 474），`ZGenerational` 选项废弃 |
| JDK 24 | 移除非分代模式（JEP 490） |

- 分代 ZGC 让年轻对象可以更频繁、更低成本地回收，吞吐和内存占用都优于非分代版本
- 支持 TB 级堆；停顿通常在 1ms 以内，代价是读屏障带来的少量吞吐损耗

### 3、启用参数（按 JDK 版本）

```bash
# JDK 15–20：非分代 ZGC
-XX:+UseZGC

# JDK 21–22：需显式开启分代
-XX:+UseZGC -XX:+ZGenerational

# JDK 23 及以后：默认就是分代 ZGC
-XX:+UseZGC
```

- `-XX:ZCollectionInterval`：定时触发 GC 的间隔（秒），默认 0 表示不启用定时触发，按分配速率自适应触发
- `-XX:SoftMaxHeapSize`：软堆上限，ZGC 尽量把堆控制在此值以下，突发时仍可用到 `-Xmx`

---

## 五、Shenandoah

**与 ZGC 定位相近的超低延迟收集器，由 Red Hat 主导，核心同样是并发整理。**

- OpenJDK 12 合入主线，并被回移到部分 JDK 11u / 8u 发行版（如 Red Hat 构建）；Oracle JDK 不包含
- 早期用 Brooks 转发指针（每个对象多一个字）实现并发转移；**JDK 13 起改用 LRB（Load Reference Barrier）**，不再需要转发指针字
- 并发标记使用 SATB；停顿通常为毫秒级，与堆大小基本无关
- 参数：`-XX:+UseShenandoahGC`

---

## 六、Epsilon

**什么都不回收的"无操作"收集器，内存耗尽时直接 OOM。**

- JDK 11 引入（JEP 318），需 `-XX:+UnlockExperimentalVMOptions -XX:+UseEpsilonGC`
- 用途：性能基准测试（排除 GC 干扰）、极短生命周期的任务、验证应用的内存分配量

---

## 七、收集器对比

| 收集器 | 回收范围 | 典型停顿 | 吞吐量 | 适用场景 |
|--------|---------|---------|--------|---------|
| Serial | 年轻代 + 老年代 | 长（与堆大小相关） | 低 | 单核、小堆 |
| Parallel | 年轻代 + 老年代 | 较长 | **最高** | 批处理、离线计算 |
| CMS | 老年代 | 短 | 中 | 已移除 |
| **G1** | 整堆 | 可控（目标默认 200ms） | 中高 | 通用服务端 |
| **ZGC** | 整堆 | **< 1ms**（JDK 16+） | 中高（分代后） | 低延迟、大堆 |
| Shenandoah | 整堆 | 毫秒级 | 中 | 低延迟、大堆 |

---

## 八、选型指南

### 1、JVM 的默认选择

不指定收集器时，JDK 9 及以后会先判断是否为"服务器级"机器：**CPU 少于 2 个或物理内存（容器中为内存 limit）小于 1792MB 时默认 Serial，否则默认 G1**。JDK 8 在服务器级机器上默认 Parallel。容器里 CPU / 内存配额较小时，很容易意外落到 Serial，生产环境建议显式指定收集器。

### 2、按场景选择

| 场景 | 推荐 | 说明 |
|------|------|------|
| 通用服务（JDK 11+） | G1 | 默认即可，调优资料最丰富 |
| JDK 8 存量服务 | G1 | 8u 后期版本的 G1 已稳定，CMS 不再演进 |
| 低延迟、P99 敏感（JDK 17+） | ZGC | JDK 21+ 使用分代 ZGC |
| 批处理 / 离线计算 | Parallel | 最大化吞吐 |
| 大堆（数十 GB 以上） | ZGC | G1 大堆下 Mixed / Full GC 停顿更难控制 |
| 小堆（< 1GB）、单核容器 | Serial | 开销最小 |
| 性能测试 | Epsilon | 排除 GC 干扰 |

---

## 小结

- 经典收集器分年轻代 / 老年代成对使用；**ParNew 在 JDK 10 移除、CMS 在 JDK 14 移除**
- **Parallel** 吞吐优先，是 JDK 8 默认；**G1** 用 Region + 回收收益排序实现可预测停顿，JDK 9 起默认，Full GC 自 JDK 10 并行
- **ZGC** 靠染色指针 + 读屏障实现并发转移，JDK 21 引入分代、JDK 23 默认分代、JDK 24 移除非分代
- **Shenandoah** 自 JDK 13 起用 LRB 取代 Brooks 指针，同样是并发整理
- 小配额容器可能被自动选为 Serial，生产环境**显式指定收集器**

## 参考资料

- 官方收集器介绍与选型：[Available Collectors](https://docs.oracle.com/en/java/javase/21/gctuning/available-collectors.html)
- G1 并行 Full GC：[JEP 307: Parallel Full GC for G1](https://openjdk.org/jeps/307)
- CMS 移除：[JEP 363: Remove the Concurrent Mark Sweep (CMS) Garbage Collector](https://openjdk.org/jeps/363)
- 分代 ZGC：[JEP 439: Generational ZGC](https://openjdk.org/jeps/439)
- 分代 ZGC 成为默认：[JEP 474: ZGC: Generational Mode by Default](https://openjdk.org/jeps/474)
- Shenandoah：[JEP 189: Shenandoah: A Low-Pause-Time Garbage Collector](https://openjdk.org/jeps/189)

> 下一篇：[GC 调优](./6_gc_tuning) —— 有了收集器，如何设定目标、读 GC 日志、调整参数。

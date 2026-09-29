# 垃圾收集器详解

## 一、收集器概览

```
年轻代收集器          老年代收集器
─────────────────────────────────────────
Serial          ←→  Serial Old
ParNew          ←→  CMS（已淘汰）
Parallel Scavenge ←→ Parallel Old
────────────────────────────────
G1（整堆，分 Region）
ZGC（整堆）
Shenandoah（整堆）
```

---

## 二、各收集器详解

### Serial / Serial Old

- **单线程**，GC 时 STW，暂停所有应用线程
- 年轻代用复制算法，老年代用标记-整理
- 简单高效，适合**单核 CPU / 小内存客户端**（如嵌入式、桌面应用）
- 参数：`-XX:+UseSerialGC`

### ParNew

- Serial 的**多线程版本**，年轻代并行 GC
- 老年代配合 CMS 使用（CMS 只能搭配 ParNew / Serial）
- 参数：`-XX:+UseParNewGC`（JDK9+ 需配合 CMS 才能启用）

### Parallel Scavenge / Parallel Old

- 关注**吞吐量**（= 用户代码时间 / (用户代码时间 + GC 时间)）
- 支持自适应调节策略（`-XX:+UseAdaptiveSizePolicy`），自动调整 Eden/Survivor 比例
- 参数：`-XX:+UseParallelGC`，`-XX:MaxGCPauseMillis=200`，`-XX:GCTimeRatio=99`
- **JDK8 默认收集器**，适合批处理、离线计算

### CMS（Concurrent Mark Sweep）—— 已淘汰

- **四阶段**：
  1. 初始标记（STW，标记 GC Roots 直接关联对象，很快）
  2. 并发标记（与用户线程并发，耗时）
  3. 重新标记（STW，修正并发标记期间变动的引用，增量更新）
  4. 并发清除（与用户线程并发）
- 缺点：**内存碎片**（标记-清除算法）；并发阶段占用 CPU；浮动垃圾；并发模式失败退化为 Serial Old
- JDK 9 标记废弃，JDK 14 移除
- 参数：`-XX:+UseConcMarkSweepGC`

### G1（Garbage First）—— JDK9 默认

**核心思想**：将堆划分为大量等大的 **Region**（1MB-32MB），每个 Region 可以是 Eden/Survivor/Old/Humongous（大对象），不要求物理连续。

```
┌───┬───┬───┬───┬───┬───┐
│ E │ E │ S │ O │ H │ E │
├───┼───┼───┼───┼───┼───┤
│ O │   │ O │ E │ S │ O │
└───┴───┴───┴───┴───┴───┘
E=Eden  S=Survivor  O=Old  H=Humongous(大对象)
```

**GC 过程：**
1. **Young GC**：回收所有 Eden Region，STW
2. **并发标记**：与应用线程并发，标记存活对象
3. **Mixed GC**：回收所有 Eden + 部分价值最高（垃圾最多）的 Old Region，STW
4. **Full GC**（兜底）：空间不足时退化，单线程 STW

**关键参数：**
```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200          # 目标停顿时间（软目标）
-XX:G1HeapRegionSize=16m          # Region 大小（2MB-32MB，2的幂）
-XX:InitiatingHeapOccupancyPercent=45  # 触发并发标记的堆占用率
```

- 适合**堆 6GB-32GB**，平衡吞吐量与延迟

### ZGC（Z Garbage Collector）—— JDK11+，JDK15 生产可用

**核心技术：**
- **染色指针**（Colored Pointers）：将 GC 状态编码到指针高位，无需额外内存
- **读屏障**（Load Barrier）：访问对象时检查指针颜色，触发修正（实现并发重定位）
- **并发重定位**：对象移动与应用线程并发执行

**特点：**
- STW 仅 1-2ms（根扫描阶段），几乎全程并发
- 支持 TB 级堆内存
- JDK 21 引入分代 ZGC（`-XX:+ZGenerational`），吞吐量进一步提升

```bash
-XX:+UseZGC
-XX:+ZGenerational          # JDK21+ 开启分代
-XX:ZCollectionInterval=5   # GC 间隔（秒，0=自适应）
```

### Shenandoah（JDK12+）

- Red Hat 贡献，与 ZGC 定位相近（超低延迟）
- 使用 Brooks Forwarding Pointer（每个对象额外一个指针字）实现并发压缩
- STW < 10ms，适合大堆低延迟场景
- 参数：`-XX:+UseShenandoahGC`

### Epsilon（JDK11+）

- 不执行任何 GC，内存耗尽时直接 OOM
- 用途：**性能基准测试**（排除 GC 干扰）、短生命周期应用、验证应用内存使用

---

## 三、收集器对比

| 收集器 | 年代 | STW 时间 | 吞吐量 | 适用场景 |
|--------|------|----------|--------|---------|
| Serial | 年轻+老年 | 长 | 低 | 单核、小内存 |
| Parallel | 年轻+老年 | 中 | **高** | 批处理、JDK8 默认 |
| CMS | 老年代 | 短 | 中 | 已淘汰 |
| **G1** | 整堆 | 可控 | 中高 | 通用，6-32GB 堆 |
| **ZGC** | 整堆 | **< 1ms** | 中 | 超低延迟，大堆 |
| Shenandoah | 整堆 | < 10ms | 中 | 超低延迟，大堆 |

---

## 四、选型指南

| 场景 | 推荐 | 说明 |
|------|------|------|
| JDK 8 通用 | G1 | CMS 已废弃，G1 稳定 |
| JDK 11+ 通用 | G1 | 默认即可 |
| JDK 17+ 低延迟 | ZGC | 成熟稳定 |
| JDK 21+ 低延迟 | Generational ZGC | 分代 ZGC，吞吐更好 |
| 批处理/离线计算 | Parallel | 最大化吞吐量 |
| 堆 > 32GB | ZGC | G1 大堆停顿时间难控制 |
| 堆 < 2GB | Serial / G1 | Serial 更简单 |
| 性能测试 | Epsilon | 排除 GC 干扰 |

---

## 五、常见面试问题

**Q：G1 为什么能控制停顿时间？**
G1 根据每个 Region 的存活对象比例和历史回收耗时，优先回收性价比最高（垃圾多）的 Region，在目标停顿时间内尽量回收更多垃圾，是一种"软实时"策略。

**Q：ZGC 为什么 STW 时间极短？**
ZGC 将几乎所有 GC 工作（标记、重定位、引用处理）都并发执行；染色指针让 JVM 无需暂停应用即可知道对象状态；读屏障实现了并发移动对象。只有初始根扫描（很快）需要 STW。

**Q：CMS 的浮动垃圾是什么？**
并发标记/清除阶段应用线程仍在运行，这期间产生的新垃圾无法在本次 GC 中回收，只能等下次。若浮动垃圾导致老年代满，CMS 退化为 Serial Old 进行 Full GC，停顿时间极长。

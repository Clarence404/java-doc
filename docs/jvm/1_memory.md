# 内存结构

> **本篇目标**：弄清 JVM 运行时各内存区域存什么、谁私有谁共享、会抛什么异常，以及对象在堆中的布局与分配路径。

JVM 规范把运行时内存划分为若干区域，HotSpot 在实现上又有自己的取舍（如元空间、TLAB、压缩指针）。先记住一句话：**线程私有的区域管"怎么执行"，线程共享的区域管"数据放哪"。**

---

## 一、运行时数据区

**程序计数器、虚拟机栈、本地方法栈随线程创建；堆和方法区随 JVM 启动创建、所有线程共享。** 直接内存不属于规范定义的运行时数据区，但同样可能 OOM。

![JVM 运行时数据区](../assets/jvm/runtime-data-area.svg)

| 区域 | 线程 | 存储内容 | 典型异常 | 常用参数 |
|------|------|---------|---------|---------|
| 程序计数器 | 私有 | 当前字节码指令地址 | 无 | — |
| 虚拟机栈 | 私有 | 栈帧（局部变量表、操作数栈等） | `StackOverflowError` / `OutOfMemoryError` | `-Xss` |
| 本地方法栈 | 私有 | Native 方法调用 | 同上 | HotSpot 与虚拟机栈合一 |
| 堆 | 共享 | 对象实例、数组、静态变量、字符串常量池 | `OutOfMemoryError: Java heap space` | `-Xms` / `-Xmx` |
| 方法区（元空间） | 共享 | 类元数据、运行时常量池 | `OutOfMemoryError: Metaspace` | `-XX:MaxMetaspaceSize` |
| 直接内存 | — | NIO 堆外缓冲区 | `OutOfMemoryError: Direct buffer memory` | `-XX:MaxDirectMemorySize` |

### 1、程序计数器

- 记录当前线程正在执行的字节码指令地址，线程切换后靠它恢复执行位置
- 执行 Native 方法时值为 Undefined
- 规范中唯一没有规定任何 `OutOfMemoryError` 的区域

### 2、Java 虚拟机栈

- 每次方法调用创建一个**栈帧**压栈，方法返回时出栈；栈帧结构详见 [字节码执行](./3_bytecode)
- 栈深度超过上限抛 `StackOverflowError`（常见于无终止递归）；无法为新线程分配栈时抛 `OutOfMemoryError: unable to create native thread`
- `-Xss` 设置每个线程的栈大小，默认值与平台有关（Linux x64 为 1MB）

### 3、本地方法栈

- 为 Native 方法服务；HotSpot 不区分两者，本地方法栈与虚拟机栈合二为一

### 4、堆

- 存放对象实例和数组，是 GC 管理的主要区域
- 分代收集器将其划分为年轻代（Eden + 两个 Survivor）与老年代；G1 / ZGC 在此之上改为 Region 化管理，详见 [GC 收集器](./5_gc_collectors)
- **静态变量也在堆中**：JDK 7 起，类的静态字段随该类的 `java.lang.Class` 对象存放在堆里，而不是方法区
- `-Xms`（初始）/ `-Xmx`（最大），服务端通常设为相等，避免运行期扩缩容带来的停顿

### 5、方法区（元空间）

**方法区是规范概念，元空间是 HotSpot JDK 8+ 的实现**，存放类元数据（类结构、方法字节码、字段描述）和运行时常量池。

| JDK 版本 | 方法区实现 | 字符串常量池 | 静态变量 |
|---------|-----------|-------------|---------|
| JDK 6 及之前 | 永久代（PermGen，堆内固定大小） | 永久代 | 永久代 |
| JDK 7 | 永久代 | **堆** | **堆**（随 Class 对象） |
| JDK 8+ | **元空间**（本地内存） | 堆 | 堆 |

- 替换永久代的原因：永久代大小需预先指定、难以估算，动态生成类多时易 `OutOfMemoryError: PermGen space`；元空间使用本地内存按需扩展，也便于 HotSpot 与 JRockit 合并
- `-XX:MaxMetaspaceSize` 默认不设上限，**建议显式设置**，防止类加载器泄漏把本机内存耗尽
- `-XX:MetaspaceSize` 是首次触发元空间 GC 的高水位线，**不是初始容量**
- 开启压缩类指针时，类元数据中的 Klass 结构放在独立的 Compressed Class Space（`-XX:CompressedClassSpaceSize`，默认 1GB）

::: tip JIT 代码不在元空间
JIT 编译出的本地机器码存放在 HotSpot 的 Code Cache（`-XX:ReservedCodeCacheSize`），它也是堆外内存，写满后会停止编译，详见 [JIT 编译](./7_jit)。
:::

### 6、直接内存

- 通过 `ByteBuffer.allocateDirect()` 或 `Unsafe.allocateMemory()` 在堆外分配，NIO 读写时可省去一次堆内到堆外的复制
- `DirectByteBuffer` 受 `-XX:MaxDirectMemorySize` 限制（未设置时默认与最大堆大小相当）；`Unsafe` 直接分配的内存不受此限制
- 堆外内存不计入 `-Xmx`，容器环境中需要为它预留空间，详见 [GC 调优](./6_gc_tuning)

---

## 二、对象内存布局

**HotSpot 中一个普通对象由对象头、实例数据、对齐填充三部分组成；数组对象的对象头多一个 4 字节的长度字段。**

![HotSpot 对象内存布局](../assets/jvm/object-layout.svg)

### 1、Mark Word

Mark Word 存储对象运行时数据，其内容随锁状态复用。64 位 JVM 的经典编码如下：

| 锁状态 | Mark Word 内容（64 位） | 锁标志位 |
|--------|------------------------|---------|
| 无锁 | unused（25）+ hashCode（31）+ unused（1）+ 分代年龄（4）+ 偏向标志 0 | 01 |
| 偏向锁 | 线程 ID（54）+ Epoch（2）+ unused（1）+ 分代年龄（4）+ 偏向标志 1 | 01 |
| 轻量级锁 | 指向栈中锁记录的指针（62） | 00 |
| 重量级锁 | 指向 Monitor 的指针（62） | 10 |
| GC 标记 | 转发指针等 GC 信息 | 11 |

- 分代年龄只有 4 位，所以 `-XX:MaxTenuringThreshold` 最大为 15
- 偏向锁自 JDK 15 起默认禁用并废弃（JEP 374），后续版本已移除；锁升级细节见 [专项 - synchronized](/java/24_topic_synchronized)
- JDK 24 引入实验性紧凑对象头（JEP 450），JDK 25 转为正式特性（JEP 519），但默认不开启，需要加 `-XX:+UseCompactObjectHeaders`，把 Mark Word 与类指针压进 8 字节

### 2、压缩指针

**64 位 JVM 有两个独立的压缩开关：`UseCompressedOops` 压缩对象引用，`UseCompressedClassPointers` 压缩对象头里的 Klass Pointer。** 两者都默认开启。

| 参数 | 压缩对象 | 生效条件 | 失效后果 |
|------|---------|---------|---------|
| `-XX:+UseCompressedOops` | 字段、数组元素中的对象引用（8 → 4 字节） | 最大堆 ≤ 约 32GB | 堆超过阈值时自动关闭，所有引用变回 8 字节 |
| `-XX:+UseCompressedClassPointers` | 对象头中的 Klass Pointer（8 → 4 字节） | 类指针指向 Compressed Class Space，与堆大小无关 | 对象头变为 16 字节 |

- 32GB 的来源：4 字节引用可表示 2³² 个地址，按 8 字节对齐寻址即 2³² × 8 = 32GB；调大 `ObjectAlignmentInBytes` 可提高上限，但填充浪费也会增加
- 堆从 31GB 调到 33GB，压缩指针失效，可用对象容量可能反而下降，**大堆要么控制在 32GB 以下，要么明显高于它**
- JDK 15 之前 `UseCompressedClassPointers` 依赖 `UseCompressedOops`，关闭后者会一并关闭前者；JDK 15 起两者解耦

---

## 三、TLAB（Thread Local Allocation Buffer）

**TLAB 是每个线程在 Eden 中预先划走的一小块私有缓冲区，线程在自己的 TLAB 里用指针碰撞分配对象，免去多线程争抢 Eden 分配指针的 CAS 竞争。** 默认开启（`-XX:+UseTLAB`）。

### 1、大小与参数

- TLAB 大小**自适应调整**（`-XX:+ResizeTLAB`，默认开启）：JVM 根据每个线程的历史分配速率、Eden 大小和线程数动态计算，不是固定值
- `-XX:TLABWasteTargetPercent`（默认 1）：TLAB 允许浪费的空间占 Eden 的目标比例，参与计算 TLAB 大小，并非"TLAB 默认占 Eden 1%"
- `-XX:TLABRefillWasteFraction`（默认 64）：决定 TLAB 剩余空间多小时可以丢弃并重新申请
- 一般无需调整，确认 TLAB 行为可用 `-Xlog:gc+tlab=trace`

### 2、对象分配路径

1. JIT 逃逸分析判定对象不逃逸时，可能通过**标量替换**直接消除分配（详见 [JIT 编译](./7_jit)）
2. 在当前线程 TLAB 中指针碰撞分配
3. TLAB 剩余空间不足：剩余很少则丢弃旧 TLAB、申请新 TLAB；否则本次直接在 Eden 共享区 CAS 分配
4. Eden 也不足时触发 Young GC，GC 后重试
5. 大对象可能直接进入老年代（见下节）

---

## 四、内存分配与晋升策略

**经典分代收集器下：对象先在 Eden 分配，熬过足够多次 Young GC 后晋升老年代；大对象和"年龄过半"的对象可以提前晋升。**

| 策略 | 规则 | 关键参数 |
|------|------|---------|
| 优先在 Eden 分配 | 绝大多数新对象在 Eden 中诞生 | `-Xmn` / `-XX:NewRatio` |
| 大对象直接进老年代 | 仅 Serial / ParNew 支持；G1 中 ≥ Region 一半的对象作为 Humongous 对象直接分配到 Humongous Region | `-XX:PretenureSizeThreshold` |
| 长期存活对象晋升 | 每熬过一次 Young GC 年龄 +1，达到阈值晋升 | `-XX:MaxTenuringThreshold`（默认 15） |
| 动态年龄判断 | 见下文 | `-XX:TargetSurvivorRatio`（默认 50） |
| 空间分配担保 | 见下文 | — |

### 1、动态年龄判断

晋升阈值不是固定的 `MaxTenuringThreshold`，每次 Young GC 后 JVM 会重新计算：

1. 按年龄**从小到大**累加 Survivor 中各年龄对象的大小
2. 累加到某个年龄 N 时，总和超过 Survivor 容量 × `TargetSurvivorRatio`（默认 50%）
3. 本轮晋升阈值取 N 与 `MaxTenuringThreshold` 的较小值，**年龄 ≥ 阈值的对象都会晋升**

所以"Survivor 中同年龄对象超过一半才晋升"的说法并不准确：触发条件是累计值，被晋升的是该年龄及以上的所有对象。可用 `-Xlog:gc+age=trace` 观察年龄分布。

### 2、空间分配担保

Young GC 时存活对象可能多到 Survivor 放不下，需要老年代兜底。JDK 6u24 之后规则简化为（`-XX:HandlePromotionFailure` 不再生效）：

- 老年代最大连续可用空间 **>** 新生代所有对象总大小，或 **>** 历次晋升到老年代的平均大小 → 执行 Young GC
- 否则直接执行 Full GC

::: warning 适用范围
以上两条规则描述的是 Serial / Parallel 等经典分代实现。G1 没有这一前置检查，晋升空间不足表现为 Evacuation Failure（日志中的 to-space exhausted），详见 [GC 收集器](./5_gc_collectors)。
:::

---

## 五、String 常量池

**JDK 7 起字符串常量池（StringTable）移到堆中**，其中的字符串可以被 GC 回收；常量池本身是一张固定桶数的哈希表。

### 1、intern()

`intern()` 的语义：常量池已有相等字符串则返回池中引用；没有则把当前字符串**的引用**登记进池并返回它（JDK 7+）。

```java
String s1 = new String("hello");   // "hello" 字面量已在常量池；s1 是堆上的新对象
String s2 = s1.intern();           // 池中已有 "hello"，返回池中那个对象
String s3 = "hello";               // 字面量，直接引用池中对象

System.out.println(s1 == s2);  // false：s1 是另一个堆对象
System.out.println(s2 == s3);  // true：同一个池中对象

String s4 = new String("ab") + new String("c");  // 运行期拼接，池中还没有 "abc"
s4.intern();                                      // JDK 7+：把 s4 的引用登记进池
System.out.println(s4 == "abc");  // JDK 7+ 为 true；JDK 6 复制到永久代，为 false
```

- 适用场景：大量重复且取值有限的字符串（如编码、状态字段），`intern()` 可显著省内存
- 池的桶数由 `-XX:StringTableSize` 决定，默认值随 JDK 版本不同，以所用 JDK 为准；intern 量很大时可调大，减少哈希冲突

### 2、字符串去重（String Deduplication）

```bash
# G1 自 JDK 8u20 支持；JDK 18 起 Serial / Parallel / ZGC / Shenandoah 也支持
-XX:+UseStringDeduplication
```

| 对比项 | `intern()` | 字符串去重 |
|--------|-----------|-----------|
| 触发方式 | 代码显式调用 | GC 期间后台自动进行 |
| 合并对象 | String 对象本身（返回同一引用） | 只共享底层 `byte[]`（JDK 8 为 `char[]`），String 对象仍各自独立 |
| `==` 结果 | 变为 `true` | 不变 |
| 代价 | 查表开销、需要改代码 | 额外的后台线程与少量 CPU |

---

## 小结

- 程序计数器、虚拟机栈、本地方法栈线程私有；堆、方法区线程共享；直接内存在堆外，不受 `-Xmx` 约束
- JDK 7 起静态变量与字符串常量池都在堆中；JDK 8 起方法区由元空间实现，只存类元数据等，建议显式设置 `MaxMetaspaceSize`
- 对象 = 对象头（Mark Word + Klass Pointer [+ 数组长度]）+ 实例数据 + 对齐填充；`UseCompressedOops` 管引用、`UseCompressedClassPointers` 管类指针，前者受 32GB 堆限制
- 对象分配走 TLAB → Eden 共享区 → Young GC；TLAB 大小自适应
- 晋升看年龄阈值、动态年龄（累计超过 `TargetSurvivorRatio`）与大对象规则；`PretenureSizeThreshold` 只对 Serial / ParNew 有效，G1 用 Humongous 对象

> 下一篇：[类加载机制](./2_class_loading) —— 元空间里的类元数据是怎么来的：类从 `.class` 文件到可用 `Class` 对象的全过程。

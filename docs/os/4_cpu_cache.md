---
description: 缓存层级与缓存行、MESI 协议、Store Buffer 与内存屏障、JMM 映射、伪共享与 @Contended
---

# CPU 缓存与伪共享

> 前置阅读：[内存管理与 Page Cache](./3_memory)、[JMM 内存模型](/java/22_topic_jmm)

CPU 比内存快两个数量级，靠多级缓存填平，缓存的工作方式直接决定并发代码的快慢。本篇讲缓存行、MESI、内存屏障与伪共享，基线为 x86-64 与 JDK 21。

---

## 一、缓存层级

### 1、为什么要多级缓存

一次 DRAM 访问约 80–100 ns，这段时间里一个 3 GHz 的核心可以执行几百条指令。缓存利用两种局部性把常用数据留在离核心更近的地方：

- **时间局部性**：刚访问过的数据很快会再被访问，比如循环变量、热点对象
- **空间局部性**：访问了某个地址，附近的地址很快也会被访问，比如顺序遍历数组

### 2、各级缓存的量级

| 层级 | 归属 | 典型容量 | 访问延迟（量级） |
|------|------|---------|----------------|
| 寄存器 | 每核 | 几十个 | 0 周期，随指令执行 |
| L1d / L1i | 每核私有，数据与指令分开 | 32–64 KB | 约 4–5 周期（约 1 ns） |
| L2 | 每核私有（部分 ARM 设计为簇共享） | 512 KB–2 MB | 约 12–16 周期 |
| L3（LLC） | 同一插槽或同一 CCD 内的核共享 | 数十 MB | 约 40–70 周期 |
| 主内存 | 全部核共享；多插槽时有 NUMA 远近之分 | GB 级 | 约 80–100 ns，跨 NUMA 节点更慢 |

具体数字随微架构变化，记住「每下一层慢几倍到十几倍」即可。本机的缓存参数可以这样查：

```bash
lscpu --caches                                                # 各级缓存容量与共享关系
getconf LEVEL1_DCACHE_LINESIZE                                # 缓存行大小，x86-64 一般为 64
cat /sys/devices/system/cpu/cpu0/cache/index0/coherency_line_size
```

### 3、缓存行

缓存与内存之间交换数据的最小单位是**缓存行**（Cache Line），x86-64 与大多数 ARM 服务器芯片为 64 字节，Apple M 系列为 128 字节。读一个 `long`，实际会把它所在的整个 64 字节搬进 L1。

这带来两个直接后果：

- **顺序访问快、跳跃访问慢**：遍历 `int[]` 时一次加载能用上 16 个元素；遍历 `LinkedList` 或对象引用数组时，每个元素可能都在不同的行上，还会打乱硬件预取
- **按行而不是按变量做一致性**：两个毫无关系的变量，只要落在同一行，就会在多核之间互相牵连，这就是后文的伪共享

```java
int[][] grid = new int[4096][4096];

// 行优先：内存连续，缓存行和预取都能用上
for (int i = 0; i < 4096; i++)
    for (int j = 0; j < 4096; j++) sum += grid[i][j];

// 列优先：每次访问跨一个内层数组，几乎每次都缓存未命中，通常慢数倍
for (int j = 0; j < 4096; j++)
    for (int i = 0; i < 4096; i++) sum += grid[i][j];
```

Java 的二维数组是「数组的数组」，内层数组各自是独立对象，列优先遍历时每一步都要换到另一个对象上，局部性更差。

---

## 二、缓存一致性：MESI

### 1、四种状态

每个核心有自己的 L1 / L2，同一缓存行可能同时存在于多个核心中。硬件用**缓存一致性协议**保证所有核心对同一地址最终看到一致的值，MESI 是其基础版本，每个缓存行处于四种状态之一：

| 状态 | 含义 | 本核读 | 本核写 |
|------|------|-------|-------|
| M（Modified） | 只有本核有，且已被修改，与内存不一致 | 直接读 | 直接写 |
| E（Exclusive） | 只有本核有，与内存一致 | 直接读 | 直接写，转为 M，无需通知别人 |
| S（Shared） | 多个核都有，与内存一致 | 直接读 | 先广播失效请求，等其他核确认后转为 M |
| I（Invalid） | 无效，相当于不在缓存里 | 发起读请求，从其他核或内存取 | 发起 RFO（Read For Ownership），取得独占后再写 |

实际处理器用的是扩展版本：Intel 为 MESIF（多一个负责转发的 F 状态），AMD 为 MOESI（多一个 O 状态，脏数据可以直接在核间共享而不先写回内存）。原理相同：**写之前必须取得这一行的独占权，其他核上的副本全部失效**。

### 2、写操作的代价

一个核写 S 或 I 状态的行时，要经过核间互联发消息、等待其他核回复确认。这正是多线程争抢同一个变量时变慢的根源：

- `AtomicLong.incrementAndGet()` 在高并发下，那一行在各核之间来回「乒乓」，每次 `lock xadd` / CAS 都要先抢到这一行的独占权
- `synchronized` 锁对象头、AQS 的 `state` 字段同理，竞争越激烈，花在搬运缓存行上的时间越多

这些开销来自一致性协议本身，与锁算法无关，所以「减少对同一缓存行的写竞争」是所有高性能并发结构的共同思路。

---

## 三、Store Buffer 与内存屏障

### 1、为什么要 Store Buffer

如果每次写 S 状态的行都原地等待其他核确认失效，核心会频繁停顿。于是处理器在核心和 L1 之间加了 **Store Buffer**：写操作先放进缓冲区，核心继续执行后续指令，等独占权拿到后再把数据提交到 L1。接收方也有类似的优化：收到失效请求后先放进**失效队列**（Invalidate Queue）立即确认，稍后再真正作废本地副本。

这两个缓冲让缓存本身保持一致，却让「写对其他核可见的时间点」被推迟，从程序的角度看就像指令被重排了：

- x86-64 采用 TSO（全存储序）模型，只允许「写之后的读」先于写对外可见，即 **StoreLoad 重排**
- ARM、RISC-V 是弱内存模型，读读、读写、写写都可能重排

可见性问题的完整来源（JIT 优化、Store Buffer、乱序执行）见 [JMM 内存模型](/java/22_topic_jmm#_1、问题不在「缓存不一致」)。

### 2、内存屏障

内存屏障（Memory Barrier / Fence）是限制重排的指令，按禁止的方向分为四类：

| 屏障 | 保证 | x86-64 | AArch64 |
|------|------|--------|---------|
| LoadLoad | 屏障前的读先于屏障后的读完成 | 天然满足，无需指令 | `dmb ishld` 或用 `ldar` |
| StoreStore | 屏障前的写先于屏障后的写对外可见 | 天然满足 | `dmb ishst` 或用 `stlr` |
| LoadStore | 屏障前的读先于屏障后的写 | 天然满足 | `dmb ish` 或用 `ldar` |
| StoreLoad | 屏障前的写对外可见后，屏障后的读才执行 | `mfence`，或带 `lock` 前缀的指令 | `dmb ish` |

StoreLoad 最贵：它要求排空 Store Buffer，核心必须等所有挂起的写都提交到缓存。

### 3、JMM 怎么落到硬件上

JMM 本身用 happens-before 定义语义，并不规定屏障；屏障是 JVM 在具体 CPU 上实现这些语义的手段。HotSpot 的大致做法：

| Java 语义 | x86-64 上的实现 | AArch64 上的实现 |
|-----------|----------------|-----------------|
| volatile 读 | 普通 `mov`，不需要屏障 | `ldar`（acquire 读） |
| volatile 写 | `mov` 后加 `lock addl $0,(rsp)`（作用等同 StoreLoad），或直接用 `xchg` | `stlr`（release 写） |
| CAS（`compareAndSet`） | `lock cmpxchg`，自带全屏障 | `casal` 或 `ldaxr` / `stlxr` 循环 |
| `synchronized` 进入 / 退出 | 加锁、解锁快速路径都用 CAS；膨胀为重量级锁后，退出是 release 写 | 同左，使用 acquire / release 指令 |

所以在 x86 上 volatile 读几乎免费、volatile 写要付一次 StoreLoad 的代价。屏障插入规则与 volatile 的精确语义见 [JMM 内存模型](/java/22_topic_jmm#四、volatile-的精确语义)，CAS 的硬件指令见 [原子类](/java/26_topic_atomic#一、cas-原子操作的硬件基础)。

---

## 四、伪共享

### 1、成因

**伪共享**（False Sharing）指多个线程各自写**不同的变量**，但这些变量恰好在**同一个缓存行**里，于是每次写都让对方核心上的整行失效，效果和争抢同一个变量一样。

![伪共享：两个线程写不同字段，却在争同一个缓存行](../assets/os/false_sharing.svg)

它只影响性能，不影响正确性，所以不会出现在功能测试里，常在压测或线上发现「加核不加吞吐」时才暴露。容易出现的地方：

- 同一个对象里被不同线程频繁更新的多个计数器、序号字段
- 对象数组或 `long[]` 里相邻的元素分别由不同线程写，比如按线程下标分槽的统计数组
- 生产者与消费者各自维护的读写指针放在同一个对象里（队列、环形缓冲区）

### 2、用 JMH 观察

用 JMH 的 `@Group` 让两个线程同时运行，分别写同一对象的两个字段，对比填充前后的吞吐：

```java
@State(Scope.Group)
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 3)
@Measurement(iterations = 5)
// 应用类上的 @Contended 默认被忽略，需要关闭限制
@Fork(value = 1, jvmArgsAppend = "-XX:-RestrictContended")
public class FalseSharingBenchmark {

    static final class Plain {
        volatile long a;               // a、b 相邻，几乎必然落在同一缓存行
        volatile long b;
    }

    static final class Padded {
        @Contended volatile long a;    // 各自前后填充，独占缓存行
        @Contended volatile long b;
    }

    final Plain plain = new Plain();
    final Padded padded = new Padded();

    // 每个字段只有一个线程写，volatile 自增在这里不存在丢失更新
    @Benchmark @Group("plain") @GroupThreads(1)
    public void plainA() { plain.a++; }

    @Benchmark @Group("plain") @GroupThreads(1)
    public void plainB() { plain.b++; }

    @Benchmark @Group("padded") @GroupThreads(1)
    public void paddedA() { padded.a++; }

    @Benchmark @Group("padded") @GroupThreads(1)
    public void paddedB() { padded.b++; }
}
```

`@Contended` 位于 `jdk.internal.vm.annotation` 包，该包没有导出，编译时要加 `--add-exports java.base/jdk.internal.vm.annotation=ALL-UNNAMED`。在多核机器上 `padded` 组的吞吐通常是 `plain` 组的数倍，差距取决于两个线程是否落在不同物理核以及核间互联的距离；如果两个线程被调度到同一物理核的两个超线程上，它们共用 L1，差距会明显缩小。JMH 的工程搭建与结果解读见 [基准测试（JMH）](/high-perf/4_benchmark)。

### 3、解决方式

**@Contended**（JEP 142，JDK 8 引入）：

- 标在字段上，JVM 在该字段前后各填充一段空白；标在类上，则整个对象的字段前后填充
- 同一个分组名的字段放在一起，例如 `@Contended("group1")`，组与组之间填充隔开
- 填充宽度由 `-XX:ContendedPaddingWidth` 控制，默认 **128 字节**而不是 64，因为部分 Intel 处理器的相邻行预取器会成对加载两个缓存行
- 只对 JDK 自身的类默认生效，应用代码要加 `-XX:-RestrictContended`；它是 JDK 内部 API，后续版本有变化的可能

JDK 内部用到它的地方：`Striped64.Cell`（`LongAdder` 的槽）、`ConcurrentHashMap.CounterCell`（`size()` 计数）、`Thread` 中 `ThreadLocalRandom` 使用的种子字段。

**手工填充**：不依赖 JVM 参数，适合类库。注意 HotSpot 会重排同一个类内的字段，直接在一个类里写一串 `long p1, p2 ...` 不一定能隔开；可靠的做法是利用「父类字段排在子类字段之前」，用继承层次把热点字段夹在中间：

```java
abstract class LhsPadding { long p01, p02, p03, p04, p05, p06, p07; }
abstract class Value extends LhsPadding { volatile long value; }
abstract class RhsPadding extends Value { long p09, p10, p11, p12, p13, p14, p15; }

public final class PaddedCounter extends RhsPadding {
    public void increment() { value++; }   // 单写者场景
    public long get() { return value; }
}
```

LMAX Disruptor 的 `Sequence` 用的就是这种写法。

**换个思路，不共享**：每个线程写自己的变量，读时再汇总，比填充更根本。`ThreadLocal` 累加、按线程分槽再合并都属于这一类，`LongAdder` 则把它做成了通用工具。

### 4、LongAdder：分槽加填充

`AtomicLong` 只有一个值，所有线程争同一个缓存行。`LongAdder` 在出现竞争后改为一个 `Cell` 数组，线程按探针值散列到不同的 `Cell` 上累加，`sum()` 时再把 `base` 和所有 `Cell` 加起来。每个 `Cell` 都用 `@Contended` 修饰，否则数组里相邻的 `Cell` 又会挤进同一缓存行，分槽就白做了。

这就是本篇的两条主线合在一起：**分槽**减少了对同一变量的写竞争，**填充**消除了不同变量之间的伪共享。代价是内存和读的精确性，`sum()` 不是原子快照。`Striped64` 的扩容规则与选型建议见 [原子类](/java/26_topic_atomic#五、longadder-与-longaccumulator)。

### 5、什么时候值得处理

- 先测量：用 `perf c2c`（Linux perf 的缓存行争用分析）或 JMH 对比确认热点确实是伪共享，再动手
- 只对**被多个线程高频写**的字段处理；只读或低频写的字段填充只会浪费内存，还会降低缓存利用率
- 对象数量大的类不要填充，每个对象多出 256 字节，内存和 GC 压力会抵消收益

---

## 小结

- 缓存按行（通常 64 字节）工作，顺序访问能吃满缓存行和预取，跳跃访问代价高
- MESI 等一致性协议保证各核缓存一致，但写之前要取得独占权，多核争写同一行就会在核间来回搬运
- Store Buffer 与失效队列让写的可见性被推迟，表现为重排；内存屏障用来约束顺序，StoreLoad 最贵
- JMM 用 happens-before 定义语义，HotSpot 在 x86 上用 `lock` 前缀指令、在 ARM 上用 acquire / release 指令实现 volatile 和 CAS
- 伪共享是不同变量落在同一缓存行引起的性能问题，用 `@Contended`、继承填充或「不共享」解决，`LongAdder` 是分槽加填充的典型
- 先用 JMH 或 `perf c2c` 确认，再只对高频写的少数字段做填充

## 参考资料

- JEP 142 Reduce Cache Contention on Specified Fields：[https://openjdk.org/jeps/142](https://openjdk.org/jeps/142)
- The JSR-133 Cookbook for Compiler Writers：[https://gee.cs.oswego.edu/dl/jmm/cookbook.html](https://gee.cs.oswego.edu/dl/jmm/cookbook.html)
- Linux 内核文档 Linux Kernel Memory Barriers：[https://docs.kernel.org/core-api/wrappers/memory-barriers.html](https://docs.kernel.org/core-api/wrappers/memory-barriers.html)
- Intel 64 and IA-32 Architectures Optimization Reference Manual：[https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
- perf-c2c(1) 手册：[https://man7.org/linux/man-pages/man1/perf-c2c.1.html](https://man7.org/linux/man-pages/man1/perf-c2c.1.html)
- JMH 项目：[https://github.com/openjdk/jmh](https://github.com/openjdk/jmh)
- LongAdder API（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/LongAdder.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/LongAdder.html)

> 下一篇：[Load 与 CPU 利用率](./5_load_cpu) —— Load Average 的真实含义、Load 高 CPU 低的原因，以及 CPU 各项占比怎么读。

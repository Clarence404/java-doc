---
description: CAS 硬件基础、VarHandle、Atomic 类族、ABA 与版本戳、LongAdder、原子类与锁的取舍
---

# 原子类（Atomic）

> **本篇目标**：理解 CAS 在硬件和 JVM 层面怎样实现、有什么代价，会用 `Atomic*`、`VarHandle`、字段更新器写无锁代码，弄清 ABA 问题与 `AtomicStampedReference` 的引用相等陷阱，并能在 `AtomicLong`、`LongAdder` 和锁之间做出选择。
>
> **前置阅读**：[JMM 内存模型](./22_topic_jmm)、[显式锁（Lock）](./25_topic_lock)

> 参考资料：
> * java.util.concurrent.atomic 包说明（Java SE 25）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/atomic/package-summary.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/atomic/package-summary.html)
> * VarHandle（Java SE 25 API）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/invoke/VarHandle.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/invoke/VarHandle.html)
> * JEP 193 — Variable Handles：[https://openjdk.org/jeps/193](https://openjdk.org/jeps/193)
> * JEP 471 — Deprecate the Memory-Access Methods in sun.misc.Unsafe for Removal：[https://openjdk.org/jeps/471](https://openjdk.org/jeps/471)
> * JEP 498 — Warn upon Use of Memory-Access Methods in sun.misc.Unsafe：[https://openjdk.org/jeps/498](https://openjdk.org/jeps/498)

`volatile` 只保证可见性和有序性，`count++` 这类「读-改-写」仍然不是原子的。加锁可以解决，但对单个变量来说代价偏重。`java.util.concurrent.atomic` 包用 CAS 提供了**不阻塞线程**的单变量原子更新，它也是 AQS、`ConcurrentHashMap`、线程池等 JUC 组件的底层基础。

---

## 一、CAS：原子操作的硬件基础

### 1、语义

CAS（Compare-And-Swap / Compare-And-Set）有三个操作数：内存位置 V、期望值 A、新值 B。**当且仅当 V 的当前值等于 A 时，把 V 更新为 B**，并返回是否成功；整个「比较 + 写入」由硬件保证不可分割。

在它之上可以写出任意的「读-改-写」原子操作，模式是循环重试：

```java
AtomicInteger value = new AtomicInteger();

int prev, next;
do {
    prev = value.get();              // 读当前值
    next = prev * 2 + 1;             // 基于当前值计算新值
} while (!value.compareAndSet(prev, next));   // 期间被别人改过就重试
```

这种「先操作、冲突了再重试」的策略就是乐观并发控制，与「先加锁、再操作」的悲观锁相对。

### 2、硬件指令

| 平台 | 实现 |
|------|------|
| x86-64 | `lock cmpxchg`：`lock` 前缀让 CPU 独占对应缓存行，比较和写入在一条指令内完成；`getAndAdd` 系列用 `lock xadd`，一条指令完成，没有失败重试 |
| AArch64（ARMv8.0） | LL/SC：`ldaxr`（加载并标记独占）+ `stlxr`（仅当期间无其他写入时存储成功），失败则在循环里重试 |
| AArch64（ARMv8.1+） | LSE 原子指令（`cas`、`ldadd` 等），HotSpot 检测到 CPU 支持时默认使用 |

HotSpot 会把 `AtomicInteger.getAndIncrement`、`compareAndSet` 等调用**内联为上述指令**（intrinsic），并不会真的执行一段 Java 循环。所以在 x86 上 `incrementAndGet` 本身就是一条 `lock xadd`，而 `updateAndGet(f)` 这类需要先算新值的操作仍然是 CAS 循环。

### 3、内存语义

原子类的 `get`/`set` 具有 `volatile` 读写语义，`compareAndSet` 和 `getAndAdd` 等同时具有 `volatile` 读和 `volatile` 写的语义，因此也参与 happens-before：线程 A 在 CAS 成功之前写入的普通变量，对随后读到这次 CAS 结果的线程 B 可见。详见 [JMM 内存模型](./22_topic_jmm)。

### 4、代价与局限

| 问题 | 说明 | 应对 |
|------|------|------|
| 竞争下的自旋浪费 | 同一变量被大量线程同时更新时，CAS 失败率升高，线程在重试里空转 CPU；即使是不会失败的 `lock xadd`，缓存行也在各核之间来回传递，吞吐量会随核数增加而下降 | 写多读少的计数用 `LongAdder`；竞争极重时用锁让线程休眠 |
| 只能保护一个变量 | 两个变量要一起更新时，分别 CAS 无法保证整体原子 | 把它们放进一个不可变对象，用 `AtomicReference` 整体替换；或者加锁 |
| ABA | 值从 A 改成 B 又改回 A，CAS 无法察觉 | 版本戳 `AtomicStampedReference`，见第四节 |

---

## 二、从 Unsafe 到 VarHandle

### 1、实现演进

| 版本 | 底层 |
|------|------|
| JDK 8 | `sun.misc.Unsafe` 的 `compareAndSwapInt` 等方法 + 字段偏移量 |
| JDK 9+ | 原子类改用 JDK 内部的 `jdk.internal.misc.Unsafe` 和 `VarHandle`；`VarHandle`（JEP 193）成为应用代码的标准 API |
| JDK 23 | `sun.misc.Unsafe` 的内存访问方法（含 CAS）被标记为「废弃待删除」（JEP 471） |
| JDK 24 | 首次调用这些方法会在运行时打印警告（JEP 498） |

结论：**业务代码和类库不要再直接用 `sun.misc.Unsafe` 做 CAS**，单变量用 `Atomic*`，需要对普通字段做原子操作时用 `VarHandle` 或字段更新器。

### 2、VarHandle

`VarHandle` 是对某个字段、数组元素或堆外内存的「类型化引用」，可以按不同的内存访问模式读写它，并支持 CAS 与原子加：

```java
import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

public class Sequence {
    private volatile long value;                 // 被 CAS 的字段，声明为 volatile 便于普通读写也具备可见性

    private static final VarHandle VALUE;
    static {
        try {
            VALUE = MethodHandles.lookup().findVarHandle(Sequence.class, "value", long.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public long next() {
        return (long) VALUE.getAndAdd(this, 1L) + 1;     // 原子加，返回旧值
    }

    public boolean advanceTo(long expected, long target) {
        return VALUE.compareAndSet(this, expected, target);
    }
}
```

`VarHandle` 的方法是签名多态的：调用处的参数和返回值类型就是这次调用的「方法类型」，应与字段类型一致（这里传 `1L`，返回值强转为 `long`；不强转得到的是 `Object`，无法参与运算）。默认会做有限的类型适配（如 `int` 拓宽为 `long`），无法适配时运行时抛 `WrongMethodTypeException`；用 `withInvokeExactBehavior()` 可以要求类型严格一致。

访问模式由弱到强：

| 模式 | 读 / 写方法 | 保证 |
|------|-------------|------|
| Plain | `get` / `set` | 与普通字段访问相同，无顺序保证 |
| Opaque | `getOpaque` / `setOpaque` | 对同一变量的访问有序、最终可见，不约束其他变量 |
| Acquire / Release | `getAcquire` / `setRelease` | 单向屏障：release 之前的写对 acquire 之后的读可见，常用于发布对象 |
| Volatile | `getVolatile` / `setVolatile` | 完整的 `volatile` 语义（全序） |

绝大多数业务代码用 Volatile 语义（也就是 `Atomic*` 的默认方法）即可，弱模式只在性能极敏感、且能证明正确性的底层代码里使用。

### 3、字段更新器

`AtomicIntegerFieldUpdater`、`AtomicLongFieldUpdater`、`AtomicReferenceFieldUpdater` 基于反射对某个类的 `volatile` 字段做原子操作。和每个对象持有一个 `AtomicInteger` 相比，它**不额外创建对象**，在对象数量巨大时能省下可观的内存，Netty 的 `ByteBuf` 引用计数就是这样实现的：

```java
public class Connection {
    private static final AtomicIntegerFieldUpdater<Connection> STATE =
            AtomicIntegerFieldUpdater.newUpdater(Connection.class, "state");

    private volatile int state;   // 必须是 volatile int（不能是 Integer），且不能是 static

    public boolean open() {
        return STATE.compareAndSet(this, 0, 1);
    }
}
```

限制：字段必须是 `volatile`、非 `static`，对更新器的创建方可访问；`AtomicIntegerFieldUpdater` 只能用于 `int` 字段。新代码中 `VarHandle` 可以完全替代字段更新器，且没有反射检查的开销。

---

## 三、Atomic 类族

### 1、基本类型

| 类 | 对应类型 | 说明 |
|----|----------|------|
| `AtomicInteger` | `int` | 计数器、状态码 |
| `AtomicLong` | `long` | 序列号、ID 生成、需要精确当前值的计数 |
| `AtomicBoolean` | `boolean` | 只执行一次的开关（`compareAndSet(false, true)`） |

常用方法（以 `AtomicInteger` 为例）：

| 方法 | 语义 |
|------|------|
| `get()` / `set(v)` | volatile 读 / 写 |
| `incrementAndGet()` / `getAndIncrement()` / `addAndGet(d)` | 原子加，返回新值或旧值 |
| `compareAndSet(expect, update)` | CAS |
| `updateAndGet(f)` / `getAndUpdate(f)` | 用函数计算新值，内部 CAS 循环 |
| `accumulateAndGet(x, f)` / `getAndAccumulate(x, f)` | 用二元函数合并 `x` 与当前值 |
| `lazySet(v)` / `setRelease(v)` | 只有 release 语义的写，不保证立刻被其他线程看到，开销更小 |
| `weakCompareAndSetPlain` / `weakCompareAndSetVolatile` 等 | 允许无故失败（spurious failure）的弱 CAS，只能用在循环里；旧的 `weakCompareAndSet` 自 JDK 9 起废弃 |

```java
AtomicInteger maxSeen = new AtomicInteger(Integer.MIN_VALUE);
maxSeen.accumulateAndGet(latencyMs, Math::max);   // 原子地记录最大值

AtomicBoolean started = new AtomicBoolean();
if (started.compareAndSet(false, true)) {
    // 只有第一个调用者会进入
}
```

**传给 `updateAndGet` / `accumulateAndGet` 的函数必须无副作用**：CAS 失败时它会被再次调用，一次更新里函数可能执行多次。

### 2、引用类型

| 类 | 说明 |
|----|------|
| `AtomicReference<V>` | 原子更新一个对象引用 |
| `AtomicStampedReference<V>` | 引用 + `int` 版本戳，解决 ABA |
| `AtomicMarkableReference<V>` | 引用 + `boolean` 标记，常用于标记节点「已逻辑删除」 |

多个字段需要一起原子更新时，把它们放进一个不可变对象，用 `AtomicReference` 整体替换：

```java
record Range(int lower, int upper) { }

private final AtomicReference<Range> range = new AtomicReference<>(new Range(0, 100));

public void setLower(int lower) {
    range.updateAndGet(r -> {
        if (lower > r.upper()) {
            throw new IllegalArgumentException("lower > upper");
        }
        return new Range(lower, r.upper());   // 每次生成新对象，旧对象不变
    });
}
```

### 3、数组

`AtomicIntegerArray`、`AtomicLongArray`、`AtomicReferenceArray<E>` 对数组的**每个元素**提供原子操作（`incrementAndGet(i)`、`compareAndSet(i, expect, update)`）。构造时传入的数组会被复制一份，之后对原数组的修改不影响原子数组；数组引用本身不需要也不能 CAS。

---

## 四、ABA 问题

### 1、什么是 ABA

CAS 只比较「值是否等于期望值」，不关心中间是否被改过。经典场景是无锁栈的出栈：

1. 栈顶是 A，A 的下一个是 B。线程 1 读到 `head = A`、`next = B`，准备 `CAS(head, A, B)`，此时被挂起
2. 线程 2 弹出 A、弹出 B，再把 A 压回去，此时栈是 `A → C`
3. 线程 1 恢复，`CAS(head, A, B)` 成功，栈顶变成了早已出栈的 B，C 丢失

在 Java 里，只要不复用节点对象，GC 保证「被引用的对象地址不会被重新分配」，上面这种由内存复用导致的 ABA 不太常见；但**对象池复用节点**，或者 CAS 的是一个有业务含义的值（余额从 100 变 50 再变回 100，而你关心的是「期间是否发生过变动」）时，ABA 依然会造成错误。

### 2、AtomicStampedReference 与引用相等

`AtomicStampedReference` 内部保存一个不可变的 `Pair(reference, stamp)`，CAS 时**同时**比较引用和版本戳，每次修改都让版本戳递增，A→B→A 之后版本号已经变了，CAS 就会失败：

```java
record Account(long balance) {
    Account withdraw(long amount) { return new Account(balance - amount); }
}

AtomicStampedReference<Account> ref = new AtomicStampedReference<>(new Account(100), 0);

int[] stampHolder = new int[1];
Account current = ref.get(stampHolder);            // 同时取出引用和版本戳
Account updated = current.withdraw(50);
boolean ok = ref.compareAndSet(current, updated,   // 期望引用 + 期望版本
                               stampHolder[0], stampHolder[0] + 1);
```

关键陷阱：**引用比较用的是 `==`，不是 `equals`**。期望值必须是从 `get()` 拿到的那个对象本身：

```java
AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(1000, 0);
int stamp = ref.getStamp();

ref.compareAndSet(1000, 2000, stamp, stamp + 1);   // false！
```

两个 `1000` 分别自动装箱，`Integer` 缓存只覆盖 −128 到 127，它们是两个不同的对象，`==` 不成立，CAS 静默失败。很多教程用 `1`、`2` 这样的小整数做示例，恰好命中缓存才「能跑」。`AtomicReference<Integer>` 同样存在这个问题。

### 3、AtomicMarkableReference

只关心「有没有被改过」而不关心改了几次时，可以用一个 `boolean` 标记代替版本号，典型用法是无锁链表中把节点标记为已删除，再由后续操作物理摘除。它不能完全杜绝 ABA（标记可能被改回去），适用面比版本戳窄。

---

## 五、LongAdder 与 LongAccumulator

### 1、为什么需要 LongAdder

`AtomicLong` 的所有线程都在更新**同一个内存位置**。在多核高并发下，这个变量所在的缓存行在各个核之间频繁失效、迁移，竞争越激烈吞吐越低。`LongAdder`（JDK 8）的思路是**分散热点**：不同线程更新不同的槽，读的时候再汇总。

### 2、Striped64 结构

![LongAdder 结构](../assets/java/longadder-cells.svg)

`LongAdder` 继承自 `Striped64`，核心字段：

- `base`：无竞争时直接 CAS 这个字段，此时 `LongAdder` 与 `AtomicLong` 开销相当
- `Cell[] cells`：一旦对 `base` 的 CAS 失败（说明有竞争），就初始化 `cells` 数组；每个线程用自己的探针值（`ThreadLocalRandom` 维护的 probe）散列到某个 `Cell` 上 CAS
- 某个 `Cell` 上 CAS 仍然冲突时，线程会更换探针重新散列；冲突持续时数组成倍扩容，长度为 2 的幂，扩到不小于 CPU 核数为止
- `Cell` 用 `@Contended` 注解填充，保证每个 `Cell` 独占一个缓存行，避免伪共享：如果两个 `Cell` 落在同一个缓存行（通常 64 字节），一个核写其中一个会让其他核上整行失效，分槽就失去了意义

代价是内存：竞争发生后，每个 `LongAdder` 会额外持有一组带填充的 `Cell`。

### 3、sum() 不是原子快照

```java
LongAdder requests = new LongAdder();
requests.increment();             // 高并发写
long total = requests.sum();      // base + Σ cells
```

`sum()` 逐个读取 `base` 和各个 `Cell` 再相加，期间其他线程的更新可能被计入、也可能没被计入。在没有并发更新的时刻读，结果是精确的；有并发更新时，结果是某个「近似当前值」。因此：

- **不能用 `LongAdder` 做序列号或 ID 生成**：没有 `incrementAndGet` 这种「加一并返回新值」的原子操作
- 不能基于 `sum()` 做 CAS 式判断（如「余量大于 0 才扣减」）
- `sumThenReset()` 适合「每个统计周期取值并清零」，但同样不是原子的，清零期间的少量更新可能丢失或计入下一周期

### 4、LongAccumulator

`LongAccumulator` 把「加法」推广为任意二元函数，用于并发统计最大值、最小值等：

```java
LongAccumulator maxLatency = new LongAccumulator(Long::max, Long.MIN_VALUE);
maxLatency.accumulate(latencyMs);     // 并发写
long max = maxLatency.get();          // 汇总
```

累加函数必须**无副作用**，并且结果不能依赖应用顺序（满足交换律、结合律，如 `max`、`min`、`+`），因为各个 `Cell` 的合并顺序不确定。对应的浮点版本是 `DoubleAdder`、`DoubleAccumulator`。

### 5、选型

| 场景 | 推荐 |
|------|------|
| 需要精确的当前值、或「加一并返回」：序列号、ID、状态标志 | `AtomicLong` / `AtomicInteger` |
| 写多读少的统计计数：QPS、请求数、错误数 | `LongAdder` |
| 并发统计最大 / 最小值 | `LongAccumulator` |
| 按 key 分别计数 | `ConcurrentHashMap<K, LongAdder>` + `computeIfAbsent(k, x -> new LongAdder()).increment()`，见 [代码级优化](/high-perf/6_code_optimization) |
| 低并发，或对内存敏感（对象数量巨大） | `AtomicLong` 或字段更新器 |

---

## 六、竞争下的行为：原子类与锁

| 维度 | 原子类（CAS） | 锁（`synchronized` / `ReentrantLock`） |
|------|---------------|----------------------------------------|
| 失败时 | 线程不阻塞，立即重试或返回 | 线程排队，最终 park 挂起 |
| 低 / 中竞争 | 开销最小，没有上下文切换 | 也很快，无竞争时只是一次 CAS |
| 高竞争（同一变量） | CAS 循环失败率上升，CPU 空转；缓存行在核间往返 | 线程睡眠不占 CPU，但有唤醒和上下文切换开销 |
| 保护范围 | 单个变量（或一个不可变对象引用） | 任意代码块、多个变量 |
| 公平性 | 没有公平概念，谁先 CAS 成功算谁的 | `synchronized` 非公平；`ReentrantLock` 默认非公平，可选公平 |
| 可组合性 | 两个原子操作连在一起就不再原子 | 临界区内可以做任意复合操作 |

经验：单变量的计数、状态切换、引用替换优先用原子类；写热点计数用 `LongAdder`；涉及多个变量的不变式、或需要「检查后执行」一整段逻辑时用锁。不要为了「无锁」把简单的临界区改写成难以验证的 CAS 循环。

---

## 小结

- CAS = 比较并交换，由硬件保证原子：x86 是 `lock cmpxchg` / `lock xadd`，ARM 是 LL/SC 或 ARMv8.1 的 LSE 指令；HotSpot 把原子类方法内联为这些指令
- 原子类的读写具有 `volatile` 语义，CAS 同时具有 volatile 读和写的语义
- JDK 9+ 应用代码用 `VarHandle` 或字段更新器做字段级 CAS；`sun.misc.Unsafe` 的内存访问方法在 JDK 23 废弃待删除、JDK 24 起使用时告警
- `updateAndGet` 等方法的函数可能被重复调用，必须无副作用；多变量原子更新用「不可变对象 + `AtomicReference`」
- ABA 用 `AtomicStampedReference` 解决，但它按 `==` 比较引用，期望值必须是 `get()` 拿到的那个对象，装箱的大整数会让 CAS 静默失败
- `LongAdder` = `base` + `@Contended` 的 `Cell[]`，竞争时分散更新、读时汇总；`sum()` 不是原子快照，不能用于 ID 生成
- 原子类没有公平性概念；`synchronized` 是非公平锁

> 下一篇：[同步工具类](./27_topic_juc_tools) —— 线程之间如何「等齐」与「限流」：CountDownLatch、CyclicBarrier、Semaphore、Phaser。

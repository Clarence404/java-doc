---
description: 可见性来源、happens-before、volatile、锁的内存语义、安全发布、VarHandle
---

# JMM 内存模型

> 前置阅读：[集合框架](./21_topic_collection)

JMM（Java Memory Model）是 JLS 第 17 章定义的规则，规定一次读操作允许看到哪些写操作的值，只要程序没有数据竞争，其行为就等同于顺序一致（DRF-SC 保证）。本篇讲 happens-before 的判断方法，以及 `volatile`、`synchronized`、`final` 各自保证了什么、没保证什么。

---

## 一、为什么需要 JMM

### 1、问题不在「缓存不一致」

常见的说法是「每个核心有自己的缓存，Core 2 读到了缓存里的旧值」。这与现代硬件不符：x86、ARM 的多级缓存都由 MESI 一类的**缓存一致性协议**维护，一个写一旦提交到 L1，其他核心随后读到的一定是新值。

真正让一个线程「看不到」另一个线程写入的，是缓存之前的几层：

![可见性问题的真实来源](../assets/java/jmm-cpu-store-buffer.svg)

| 来源 | 发生在哪 | 典型后果 |
|------|---------|---------|
| JIT 编译优化 | C1 / C2 把字段读提升出循环、把值放在寄存器、合并或删除读写 | 循环读一个普通 `boolean` 永远看不到变化 |
| Store Buffer | 写先进入核心私有的写缓冲，稍后才提交到缓存 | 本核心的后续读先于自己的写对外可见（StoreLoad 重排） |
| 乱序执行 / 失效队列 | CPU 为了吞吐量乱序执行、延迟处理失效消息 | ARM 等弱内存模型上读读、写写也可能重排 |

`javac` 几乎不做重排序，编译器层面的重排几乎都来自 JIT。

### 2、实际最常见的可见性 Bug：JIT 循环提升

```java
class StopFlag {
    private boolean stop;          // 普通字段

    void runLoop() {
        while (!stop) {            // C2 可能把 stop 的读提升到循环外：
            // 空循环或纯计算         // if (!stop) { while (true) { ... } }
        }
    }

    void shutdown() { stop = true; }
}
```

在 HotSpot 上，`runLoop` 被 C2 编译后很可能**永远不退出**。原因不是「写没刷回主内存」，而是 JIT 认为单线程语义下 `stop` 在循环内不会变，于是只读一次。JMM 允许这种优化，因为两个线程之间没有 happens-before 关系。把 `stop` 声明为 `volatile` 后，JIT 必须每次重新读取，问题消失。

### 3、主内存 / 工作内存：一个历史教学模型

《深入理解 Java 虚拟机》里「线程私有的工作内存 + 共享主内存 + read / load / use / assign / store / write / lock / unlock 八种操作」的描述来自 JSR-133 之前（JDK 1.4 及更早）的规范。它适合用来直观理解「线程可能看到旧值」，但：

- 工作内存不是真实存在的硬件或 JVM 结构，大致对应寄存器、Store Buffer、编译器优化后的局部副本
- 自 JDK 5（JSR-133）起，JLS 第 17 章用**同步顺序 + happens-before** 定义语义，八种操作已不在规范中
- 推理并发代码时，用 happens-before 判断，而不是去想「什么时候刷回主内存」

---

## 二、三大特性

### 1、可见性

一个线程的写，另一个线程能否以及何时看到。JMM 只保证：存在 happens-before 关系时一定看到；不存在时可能永远看不到（上面的循环提升）。

保证可见性的手段：`volatile`、`synchronized` / `Lock`、`final` 字段（构造完成后）、`java.util.concurrent` 中的类、线程 `start` / `join`。

### 2、原子性

操作不可分割，其他线程看不到中间状态。

- 引用以及 `int`、`boolean` 等 32 位及以下基本类型的单次读写是原子的
- JLS 17.7：非 `volatile` 的 `long` / `double` 写**允许**被拆成两次 32 位写，与 JVM 位数无关；64 位 HotSpot 实际上是原子的，但规范不保证。`volatile long` / `volatile double` 的读写保证原子
- 复合操作（`i++`、检查后执行 check-then-act）不是原子的，需要锁或 CAS（`AtomicInteger`、`LongAdder`）

### 3、有序性

单线程内，JIT 和 CPU 可以随意重排，只要结果与按程序顺序执行一致（as-if-serial）。多线程下，另一个线程可能观察到「乱序」的结果，只有 happens-before 能约束跨线程可见的顺序。

---

## 三、happens-before

### 1、定义：可见性与顺序保证，不是时间先后

若操作 A happens-before 操作 B（记作 A hb B），则 **A 的结果对 B 可见，且在 B 看来 A 排在 B 之前**。

- A hb B 不要求 A 在时间上先执行：只要 B 观察不到区别，JIT 照样可以重排
- A 在时间上先执行，也不代表 A hb B：没有同步的两个线程之间不存在 hb，B 可能看不到 A 的写
- 两个冲突访问（至少一个是写）之间没有 hb，就是**数据竞争**；有数据竞争的程序不保证顺序一致

![volatile 写读建立的 happens-before 链](../assets/java/jmm-happens-before.svg)

### 2、JLS 规定的规则

| 规则 | 内容 |
|------|------|
| 程序顺序 | 同一线程内，按程序顺序前面的操作 hb 后面的操作 |
| 监视器锁 | 对一个 monitor 的 unlock hb 之后对**同一** monitor 的 lock |
| volatile | 对 volatile 变量的写 hb 之后对**同一**变量的读 |
| 线程启动 | `Thread.start()` hb 被启动线程的任何操作 |
| 线程终止 | 线程的所有操作 hb 其他线程检测到它终止（`join()` 返回、`isAlive()` 返回 false） |
| 线程中断 | `interrupt()` hb 被中断线程检测到中断（抛 `InterruptedException` 或 `isInterrupted()` 为 true） |
| 默认值 | 每个变量默认值（0 / false / null）的写入 hb 每个线程的第一个操作 |
| 对象终结 | 构造器结束 hb `finalize()` 开始；`finalize()` 自 JDK 18 起被标记为待移除（JEP 421），新代码不要依赖 |
| 传递性 | A hb B 且 B hb C，则 A hb C |

「之后」指同步顺序（synchronization order）中的之后：所有线程的 volatile 读写、加锁解锁、线程启动终止构成一个全序，每个线程看到的这个顺序是一致的。

### 3、java.util.concurrent 的额外保证

JLS 只覆盖语言层面，`java.util.concurrent` 包文档另外声明了一组 hb 边，日常代码多数依赖的是这些：

| 场景 | happens-before 关系 |
|------|-------------------|
| 并发集合 | 放入 `ConcurrentHashMap`、`BlockingQueue` 等之前的操作 hb 另一线程取出或访问该元素之后的操作 |
| 提交任务 | 向 `Executor` 提交 `Runnable` / `Callable` 之前的操作 hb 任务开始执行 |
| Future | 异步计算中的操作 hb 另一线程从 `Future.get()` 返回之后的操作 |
| 同步器 | `Lock.unlock`、`Semaphore.release`、`CountDownLatch.countDown` 之前的操作 hb 成功的 `lock` / `acquire` / `await` 之后的操作 |
| Exchanger | 每对成功交换的线程，`exchange()` 之前的操作 hb 对方 `exchange()` 返回之后的操作 |
| 屏障 | `CyclicBarrier.await` / `Phaser` 到达之前的操作 hb 屏障动作，屏障动作 hb 其他线程从 `await` 返回 |

所以「主线程填好对象，`queue.put(obj)`，消费线程 `take()` 后读字段」不需要任何 `volatile`。

---

## 四、volatile 的精确语义

### 1、规范层面

- **可见性 + 有序性**：对 volatile 变量的写 hb 之后对同一变量的读；加上程序顺序和传递性，写之前的所有普通写都对读之后的代码可见
- **全序**：所有 volatile 读写参与同步顺序，任意两个线程看到的 volatile 操作顺序一致
- **单次读写原子**：包括 `long` / `double`
- **不保证复合操作原子性**：`volatile int count; count++` 仍然会丢更新，用 `AtomicInteger` / `LongAdder`

「volatile 写立即刷新到主内存、读每次从主内存读」是把实现手段当成了语义。读完全可以命中一致的 L1 缓存；关键是 JIT 不能把它缓存在寄存器里，也不能把前后的普通读写越过它重排。

### 2、实现层面：内存屏障

JSR-133 Cookbook 给出的保守插入策略（实际 JIT 会按平台去掉多余屏障）：

| 操作 | 之前插入 | 之后插入 | 禁止的重排 |
|------|---------|---------|-----------|
| volatile 写 | StoreStore | StoreLoad | 前面的普通写不能移到 volatile 写之后；volatile 写不能与后面的 volatile 读交换 |
| volatile 读 | — | LoadLoad + LoadStore | 后面的普通读写不能移到 volatile 读之前 |

x86（TSO 模型）只允许 StoreLoad 重排，所以 volatile 读不需要任何屏障指令，volatile 写之后只需一条 `lock addl` 或用 `xchg` 完成写入，这也是 volatile 写比读贵的原因。ARM / AArch64 上则用 `ldar` / `stlr` 这类 acquire / release 指令实现。

### 3、适用场景

| 适合 | 不适合 |
|------|-------|
| 状态标志（停止开关、初始化完成标记） | 计数器、累加 |
| 一写多读的配置引用（整体替换不可变对象） | 依赖旧值的更新（check-then-act） |
| DCL 中的实例引用 | 多个变量之间有不变式约束 |

---

## 五、synchronized 与 Lock 的内存语义

### 1、acquire / release，而不是全屏障

JSR-133 下，获取 monitor（`monitorenter`）具有 **acquire** 语义，释放 monitor（`monitorexit`）具有 **release** 语义：

- 临界区内的读写不能移出临界区：不能提前到 lock 之前，也不能推迟到 unlock 之后
- 临界区外的读写**可以移入**临界区（「蟑螂旅馆」规则：只进不出）。这正是 JIT 能做锁粗化的依据
- 线程 A unlock 之前的所有写，对之后 lock 同一个 monitor 的线程 B 可见

因此「`synchronized` 首尾各插一道全屏障」「进入时清空工作内存」都是概念模型，不是规范。真正的保证只针对**同一把锁**：两个线程分别锁不同对象，彼此之间没有任何 hb。

`ReentrantLock` 等 `Lock` 实现通过 AQS 中 `volatile int state` 的读写和 CAS 获得同样的 acquire / release 语义，`java.util.concurrent.locks.Lock` 接口文档明确要求实现具备与内置 monitor 相同的内存同步语义。

锁的实现细节（对象头、锁状态、ObjectMonitor、虚拟线程）见 [synchronized](./24_topic_synchronized)。

### 2、volatile vs synchronized

| | volatile | synchronized / Lock |
|--|----------|---------------------|
| 可见性 | 有 | 有（同一把锁之间） |
| 原子性 | 仅单次读写 | 整个临界区 |
| 有序性 | 禁止跨 volatile 访问的相关重排 | acquire / release |
| 阻塞 | 不阻塞 | 竞争时阻塞 |
| 开销 | 读几乎无开销，写有一次 StoreLoad | 无竞争时一次 CAS，竞争时排队 |

---

## 六、final 字段与安全发布

### 1、final 的初始化安全

```java
public final class Point {
    private final int x;
    private int y;

    public Point(int x, int y) {
        this.x = x;   // final 字段
        this.y = y;   // 普通字段
    }
}
```

JLS 17.5 保证：构造器结束时（freeze），final 字段的值以及通过它能到达的对象，对任何**之后拿到该对象引用**的线程都可见，即使引用是通过数据竞争拿到的。`x` 一定是构造器写入的值；普通字段 `y` 没有这个保证，可能看到 0。

前提：构造期间 `this` 不能逸出，例如在构造器里注册监听器、启动线程、把 `this` 赋给静态字段。

`record` 的组件字段都是 `private final`，天然享有这一保证；不可变对象是最简单的线程安全手段。

### 2、安全发布的方式

「发布」指让其他线程拿到对象引用。以下方式都能保证对方看到完整构造后的对象：

| 方式 | 说明 |
|------|------|
| 静态初始化器 | `static final Foo FOO = new Foo();`，由类初始化锁保证 |
| volatile 字段或 `AtomicReference` | 写引用 hb 读引用 |
| 锁保护的字段 | 写和读都在同一把锁内 |
| 并发容器 | 放入 `ConcurrentHashMap`、`BlockingQueue` 等 |
| final 字段 | 引用存放在另一个正确构造对象的 final 字段中 |

---

## 七、双重检查锁（DCL）

### 1、为什么必须加 volatile

`instance = new Singleton()` 在底层是三步：分配内存、执行构造器初始化字段、把引用写入 `instance`。没有 hb 约束时，JIT 或 CPU 可以让「发布引用」先于「初始化」对其他线程可见：

![new Singleton() 的三步与 DCL 的重排序风险](../assets/java/jmm-dcl-reorder.svg)

```java
public final class ConfigHolder {
    private static volatile ConfigHolder instance;   // 必须 volatile

    private final Map<String, String> props;

    private ConfigHolder() {
        this.props = loadFromDisk();
    }

    public static ConfigHolder getInstance() {
        ConfigHolder local = instance;                 // 只读一次 volatile，减少开销
        if (local == null) {
            synchronized (ConfigHolder.class) {
                local = instance;
                if (local == null) {
                    local = new ConfigHolder();
                    instance = local;                  // volatile 写：release
                }
            }
        }
        return local;
    }

    private static Map<String, String> loadFromDisk() {
        return Map.of();
    }
}
```

加了 `volatile` 后，第一次检查的 volatile 读与 `instance = local` 的 volatile 写构成 hb，构造器中的所有写都对读线程可见。

### 2、通常不需要 DCL

- 懒加载的**静态**单例：用静态内部持有类（Holder 模式）或枚举，由类初始化保证线程安全和懒加载，代码更短
- DCL 只在需要懒加载**实例字段**（每个对象各有一份昂贵的派生值）时才有意义

单例的各种写法与取舍见 [单例模式](/patterns/1_creational_singleton)。

---

## 八、VarHandle 访问模式

JDK 9（JEP 193）引入的 `VarHandle` 可以对普通字段、数组元素按需选择内存语义，`java.util.concurrent` 内部已经从 `Unsafe` 迁移到它。业务代码很少直接用，但理解它有助于看懂 JUC 源码。

| 访问模式 | 方法 | 语义强度 |
|---------|------|---------|
| Plain | `get` / `set` | 与普通字段相同，无保证 |
| Opaque | `getOpaque` / `setOpaque` | 单个变量上的访问不被消除、对自身有一致顺序，不建立 hb |
| Acquire / Release | `getAcquire` / `setRelease` | 只保证单方向的顺序，比 volatile 便宜（省掉 StoreLoad） |
| Volatile | `getVolatile` / `setVolatile` | 与 volatile 字段相同 |
| 原子更新 | `compareAndSet`、`getAndAdd` 等 | 默认 volatile 语义，另有 `Acquire` / `Release` / `Plain` 变体 |

```java
import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

class Publisher {
    private Object payload;                 // 普通字段
    private boolean ready;                  // 普通字段，用 VarHandle 控制语义

    private static final VarHandle READY;
    static {
        try {
            READY = MethodHandles.lookup().findVarHandle(Publisher.class, "ready", boolean.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    void publish(Object p) {
        payload = p;
        READY.setRelease(this, true);       // 之前的写不能移到它之后
    }

    Object tryRead() {
        return (boolean) READY.getAcquire(this) ? payload : null;   // 之后的读不能移到它之前
    }
}
```

另外还有显式栅栏 `VarHandle.fullFence()` / `acquireFence()` / `releaseFence()` / `loadLoadFence()` / `storeStoreFence()`。自旋等待循环中可以调用 `Thread.onSpinWait()`（JDK 9），提示 CPU 降低功耗、让出超线程资源。

多个线程频繁写同一缓存行上的不同变量会造成伪共享（缓存行在核心之间反复失效），`LongAdder` 内部用 `@Contended` 填充规避。它影响的是性能，不影响正确性，与 JMM 语义无关。

---

## 九、JMM 与 JVM 内存结构的区别

两者名字相近，讨论的是不同维度：

| | JVM 运行时数据区 | Java 内存模型（JMM） |
|--|---------------|-------------------|
| 出处 | JVM 规范 JVMS §2.5，由 HotSpot 等实现 | Java 语言规范 JLS 第 17 章 |
| 关注点 | 堆、栈、方法区等内存区域的划分与管理 | 多线程下读能看到哪些写 |
| 解决问题 | 内存如何分配、回收 | 线程之间如何安全共享数据 |
| 详见 | [内存结构](/jvm/1_memory) | 本文 |

---

## 小结

- 现代 CPU 缓存是一致的，可见性问题来自 JIT 优化（寄存器、循环提升）、Store Buffer 和乱序执行；主内存 / 工作内存只是历史教学模型
- happens-before 是可见性与顺序保证，不是时间先后；没有 hb 的冲突访问就是数据竞争
- JLS 规则之外，`java.util.concurrent` 的并发集合、Executor、Future、同步器都提供 hb 边，日常代码主要依赖它们
- volatile 的精确语义是：写 hb 后续对同一变量的读、参与同步全序、单次读写原子；不保证复合操作原子性；x86 上只有写之后的 StoreLoad 有成本
- 锁是 acquire / release 语义，不是全屏障；临界区外的代码可以移入，保证只对同一把锁成立
- final 字段在构造完成后对所有线程可见（this 不逸出为前提）；安全发布靠静态初始化、volatile、锁、并发容器或 final
- DCL 必须 volatile，但静态单例优先用 Holder 或枚举
- VarHandle 提供 plain / opaque / acquire-release / volatile 四档语义，是 JUC 的底层工具

## 参考资料

- JLS 第 17 章 Threads and Locks：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html)
- java.util.concurrent 内存一致性说明：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html)
- JSR-133 FAQ：[https://www.cs.umd.edu/~pugh/java/memoryModel/jsr-133-faq.html](https://www.cs.umd.edu/~pugh/java/memoryModel/jsr-133-faq.html)
- JEP 193 Variable Handles：[https://openjdk.org/jeps/193](https://openjdk.org/jeps/193)

> 下一篇：[线程基础](./23_topic_thread_basics) —— 线程的状态、创建、中断与协作，以及 ThreadLocal 的上下文传递。

---
description: Monitor 语义、字节码、锁实现演进、ObjectMonitor、锁消除、虚拟线程 pinning
---

# synchronized

> **本篇目标**：说清 `synchronized` 在语言层面保证什么，在字节码和 HotSpot 中如何实现；能按 JDK 版本区分偏向锁、栈锁、新轻量级锁和 ObjectMonitor，知道 JDK 21–25 中与虚拟线程、对象头相关的变化。
>
> **前置阅读**：[JMM 内存模型](./22_topic_jmm)、[线程基础](./23_topic_thread_basics)

> 参考资料：
> * JLS 17.1 Synchronization：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.1](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.1)
> * JEP 374 Deprecate and Disable Biased Locking：[https://openjdk.org/jeps/374](https://openjdk.org/jeps/374)
> * JEP 491 Synchronize Virtual Threads without Pinning：[https://openjdk.org/jeps/491](https://openjdk.org/jeps/491)
> * JEP 519 Compact Object Headers：[https://openjdk.org/jeps/519](https://openjdk.org/jeps/519)
> * JEP 390 Warnings for Value-Based Classes：[https://openjdk.org/jeps/390](https://openjdk.org/jeps/390)

---

## 一、语义：锁的是对象的 monitor

### 1、三种写法

每个 Java 对象都关联一个 monitor（监视器），`synchronized` 获取的就是它：

| 写法 | 锁住的 monitor |
|------|---------------|
| `synchronized (obj) { ... }` | `obj` 的 monitor |
| `public synchronized void f()` | `this` 的 monitor |
| `public static synchronized void f()` | 当前类的 `Class` 对象（`MyClass.class`）的 monitor |

实例方法锁和静态方法锁是两把不同的锁，互不阻塞。

### 2、语言层面的保证

- **互斥**：同一时刻最多一个线程持有某个 monitor
- **可重入**：持有 monitor 的线程可以再次进入同一 monitor 的同步块，内部维护重入计数，完全退出后才释放
- **内存语义**：获取 monitor 具有 acquire 语义，释放具有 release 语义；unlock hb 之后对同一 monitor 的 lock，详见 [JMM 内存模型](./22_topic_jmm)
- **异常安全**：同步块因异常退出时，monitor 一定被释放
- **不可中断、不可超时**：等待进入 `synchronized` 的线程不响应中断，需要可中断、超时或公平性时用 [显式锁（Lock）](./25_topic_lock)

偏向锁、轻量级锁、锁膨胀都是 HotSpot 的**实现优化**，JLS 只定义 monitor 的语义。讨论「锁升级」时必须先说是哪个 JDK 版本。

### 3、锁对象怎么选

```java
public class Inventory {
    private final Object lock = new Object();     // 私有、final、专用
    private int stock;

    public void deduct(int n) {
        synchronized (lock) {
            if (stock < n) {
                throw new IllegalStateException("库存不足");
            }
            stock -= n;
        }
    }
}
```

- 用 `private final` 的专用锁对象，避免外部代码锁住同一个对象（锁 `this` 时，任何拿到引用的代码都能参与竞争）
- 字段不能是可变的：锁对象被重新赋值后，不同线程锁的是不同对象，互斥失效
- 不要锁 `String` 字面量（常量池共享，全局同一个对象）和 `Integer`、`LocalDate` 等值类型类，见本文第九节

---

## 二、字节码：monitorenter 与 ACC_SYNCHRONIZED

```java
public class Counter {
    private final Object lock = new Object();
    private int count;

    public void inc() {
        synchronized (lock) { count++; }
    }

    public synchronized void dec() { count--; }
}
```

`javap -c -v Counter` 的关键输出（常量池编号省略）：

```text
public void inc();
   0: aload_0
   1: getfield      // Field lock:Ljava/lang/Object;
   4: dup
   5: astore_1
   6: monitorenter                // 获取 lock 的 monitor
   7: aload_0
   8: dup
   9: getfield      // Field count:I
  12: iconst_1
  13: iadd
  14: putfield      // Field count:I
  17: aload_1
  18: monitorexit                 // 正常路径释放
  19: goto          27
  22: astore_2
  23: aload_1
  24: monitorexit                 // 异常路径释放
  25: aload_2
  26: athrow
  27: return
  Exception table:
     from    to  target type
         7    19    22   any
        22    25    22   any

public synchronized void dec();
  flags: (0x0021) ACC_PUBLIC, ACC_SYNCHRONIZED
```

- **同步块**：`javac` 生成一条 `monitorenter` 和两条 `monitorexit`，第二条位于覆盖整个同步块的 `any` 异常处理器中，保证抛异常也会释放
- **同步方法**：字节码里没有 monitor 指令，只在方法标志中设置 `ACC_SYNCHRONIZED`，JVM 在调用前获取、返回或抛异常时释放
- 两者在 JIT 编译后走同一套加锁代码，性能没有差别

---

## 三、对象头与锁状态位

HotSpot 中每个对象的对象头包含 Mark Word（64 位 JVM 上 8 字节）和类型指针。Mark Word 的最低 2 位是锁标志：`01` 未锁定、`00` 轻量级锁定、`10` 已膨胀为 ObjectMonitor、`11` 供 GC 标记使用。各状态下 Mark Word 的完整位布局见 [内存结构](/jvm/1_memory)。

几个和锁相关的要点：

- **identity hashCode 与锁互相影响**：未锁定时哈希值直接存在 Mark Word 中。JDK 8 中，对一个偏向锁对象调用 `Object.hashCode()` / `System.identityHashCode()` 会撤销偏向；栈锁状态下哈希值存在被替换出去的原 Mark Word 中，需要时可能触发膨胀
- **`wait()` 一定会膨胀**：WaitSet 只存在于 ObjectMonitor 中
- **紧凑对象头**：JDK 25 起 `-XX:+UseCompactObjectHeaders`（JEP 519）成为正式特性，把 Mark Word 与类指针压缩进 8 字节，默认不开启；它依赖新轻量级锁，不支持旧的栈锁

---

## 四、HotSpot 锁实现的版本演进

![HotSpot synchronized 实现的版本演进](../assets/java/sync-lock-evolution.svg)

| 版本 | 变化 |
|------|------|
| JDK 6 ~ 14 | 偏向锁默认开启（JVM 启动约 4 秒后生效，`BiasedLockingStartupDelay`），加锁路径为偏向锁、栈锁（经典「轻量级锁」）、ObjectMonitor |
| JDK 15 | JEP 374：偏向锁默认关闭并标记废弃，`-XX:+UseBiasedLocking` 仍可手动开启；ObjectMonitor 改为后台线程异步收缩（deflation） |
| JDK 17 | 与 15 相同，偏向锁需手动开启 |
| JDK 18 | 偏向锁代码从 HotSpot 移除，`UseBiasedLocking` 变为 obsolete（设置会告警并被忽略） |
| JDK 21 | 引入新的轻量级锁实现（实验参数 `-XX:LockingMode=2`），以线程私有的 lock-stack 代替栈上 Lock Record |
| JDK 23 | 新轻量级锁成为默认（`LockingMode` 默认值改为 2），旧栈锁仍可通过参数选择 |
| JDK 24 | JEP 491：虚拟线程在 `synchronized` 中阻塞不再钉住载体线程；`LockingMode` 参数标记废弃 |
| JDK 25 | JEP 519 紧凑对象头转正；ObjectMonitor 的 cxq 与 EntryList 两个队列合并为一个 entry_list |
| JDK 26 | `LockingMode` 参数 obsolete，只保留新轻量级锁 |

结论：**JDK 17 及以后，默认路径中已经没有偏向锁；JDK 23 及以后，默认路径中也没有经典的 Lock Record 栈锁。**「无锁 → 偏向锁 → 轻量级锁 → 重量级锁」只适用于 JDK 8 ~ 14。

---

## 五、JDK 8 的经典路径（历史）

JDK 8 仍有大量存量系统，理解这一路径有助于读老资料和排查老版本问题。

### 1、偏向锁

- 开启时，类的原型 Mark Word 带偏向标志，新对象创建后处于**匿名偏向**状态（偏向线程 ID 为空），而不是「无锁」
- 第一个线程加锁时用一次 CAS 把自己的线程 ID 写入 Mark Word，此后该线程重入、再次加锁都**无需 CAS**
- 另一个线程来加锁时需要**撤销偏向**：必须等到全局安全点（后期版本部分改用握手），检查原持有线程的栈帧，再把对象改为未锁定或栈锁状态
- 同一个类的对象撤销次数过多时，HotSpot 会批量重偏向（默认阈值 20）或批量撤销并禁用该类的偏向（默认阈值 40）

JEP 374 移除它的理由：现代应用多用 JUC 并发容器，「对象只被一个线程反复加锁」的场景（如早期 `Vector`、`Hashtable`）收益变小；撤销需要安全点，在线程多、锁对象多的服务中反而造成停顿；同时它让 HotSpot 同步子系统的代码复杂、难以维护。

### 2、栈锁（经典轻量级锁）

1. 线程在当前栈帧中分配一个 Lock Record
2. 把对象原来的 Mark Word 复制到 Lock Record 中（Displaced Mark Word）
3. CAS 把对象的 Mark Word 替换为指向该 Lock Record 的指针，锁标志变为 `00`
4. 解锁时 CAS 把 Displaced Mark Word 写回对象头

### 3、竞争时并不在轻量级锁上自旋

常见说法是「轻量级锁 CAS 失败后自旋，自旋失败再升级为重量级锁」。HotSpot 的实际做法是：栈锁 CAS 失败、发现锁被别的线程持有时，**直接膨胀**为 ObjectMonitor；自适应自旋发生在膨胀之后的 `ObjectMonitor::enter` 中，自旋仍拿不到锁才 park 阻塞。自旋也不是一种锁状态，Mark Word 中没有它的位置。

---

## 六、JDK 21+ 的加锁路径

### 1、新轻量级锁与膨胀

![JDK 23+ 默认加锁路径](../assets/java/sync-lock-path.svg)

新轻量级锁（HotSpot 内部称 `LM_LIGHTWEIGHT`）的变化：

- 每个线程有一个容量很小的 **lock-stack**，记录当前持有的轻量级锁对象
- 加锁时 CAS 只把 Mark Word 的锁位从 `01` 改为 `00`，Mark Word 其余内容（包括哈希值）保持不变，**不再有 Displaced Mark Word**
- 判断「锁归谁」不再看 Mark Word 中的指针，而是看对象是否在某个线程的 lock-stack 中
- 重入时把同一对象再压一次栈；lock-stack 满了、出现竞争、调用 `wait()` 等情况下膨胀为 ObjectMonitor

这一设计让 Mark Word 不再需要存放指向栈的指针，是紧凑对象头能实现的前提。

### 2、ObjectMonitor

![ObjectMonitor：入口队列、owner 与 WaitSet](../assets/java/object-monitor.svg)

| 字段 | 作用 |
|------|------|
| `owner` | 当前持有者 |
| `recursions` | 重入次数 |
| 入口队列 | 竞争失败、已 park 的线程。JDK 24 及以前分为两部分：新到线程无锁压入的 `cxq` 栈和释放者从中挑选继任者的 `EntryList`；JDK 25 合并为一个 `entry_list`，按到达顺序挑选继任者 |
| `WaitSet` | 调用 `wait()` 的线程；被 `notify`、超时或中断后移回入口队列，重新竞争 monitor 才能从 `wait()` 返回 |

竞争流程：

1. 线程进入 `ObjectMonitor::enter`，先尝试 CAS 设置 owner
2. 失败后**自适应自旋**：根据这个 monitor 上次自旋是否成功，动态决定自旋多久；持有者正在运行、临界区很短时，自旋可以避免一次 park / unpark 和上下文切换
3. 自旋仍失败，把自己加入入口队列并 park
4. owner 释放时选出继任者并 unpark，被唤醒的线程重新竞争（`synchronized` 是非公平锁，新来的线程可以插队）

### 3、锁会「降级」

空闲的 ObjectMonitor 会被收缩（deflation）：对象头恢复为未锁定，monitor 结构被回收复用。JDK 15 起由专门的后台线程异步完成。「锁只能升级不能降级」的说法不严谨。

---

## 七、JIT 优化：锁消除与锁粗化

### 1、锁消除

C2 通过逃逸分析发现锁对象不会逃逸出当前线程时，删除加锁解锁操作（`-XX:+EliminateLocks`，默认开启，依赖 `-XX:+DoEscapeAnalysis`）：

```java
public String join(String a, String b) {
    StringBuffer sb = new StringBuffer();   // sb 不逃逸
    sb.append(a).append(b);                 // append 是 synchronized 方法，锁被消除
    return sb.toString();
}
```

### 2、锁粗化

相邻的多个同步块锁的是同一个对象时，JIT 可以把它们合并为一个更大的同步块，减少反复加锁解锁。JMM 允许临界区外的代码移入临界区，这是锁粗化合法的依据。

这两项优化意味着：微基准测试中测到的 `synchronized` 开销可能被优化掉，需要用 JMH 正确设计，见 [基准测试（JMH）](/high-perf/4_benchmark)。

---

## 八、虚拟线程与 pinning

虚拟线程在阻塞时会从载体线程（carrier thread）上卸载，让载体去运行其他虚拟线程。**pinning（钉住）** 指虚拟线程阻塞时无法卸载，连同载体线程一起阻塞。

| 版本 | `synchronized` 中阻塞的行为 |
|------|---------------------------|
| JDK 21 ~ 23 | 在 `synchronized` 块或方法中执行阻塞操作（IO、`sleep`、`Object.wait`、等待进入另一个 monitor）会钉住载体线程。载体线程数默认等于 CPU 核数，大量钉住会让所有虚拟线程停摆 |
| JDK 24+ | JEP 491：虚拟线程可以在持有、等待或进入 monitor 时卸载，`synchronized` 不再导致 pinning |

JDK 24 之后仍会钉住的情况：

- 栈上存在本地方法帧：JNI 或 FFM API 调用的本地代码回调到 Java 后阻塞
- 在类初始化器（`static {}`）中阻塞，或等待另一个线程完成类初始化
- 加载类时阻塞

排查与应对：

- 使用 JFR 事件 `jdk.VirtualThreadPinned` 定位钉住的位置（JDK 24 起事件中会给出钉住原因）；`-Djdk.tracePinnedThreads` 在 JDK 24 中已移除
- 仍在 JDK 21 的项目：把包住阻塞 IO 的 `synchronized` 改为 `ReentrantLock`，或升级到 JDK 25 LTS
- 虚拟线程的完整内容见 [虚拟线程](./30_topic_virtual_thread)

---

## 九、不要在值类型类上同步

`Integer`、`Long`、`Optional`、`LocalDate`、`List.of()` 返回的集合等被标注为**值类型类（value-based class）**：相等的实例可能是同一个对象，也可能不是，未来的 Valhalla 值对象中甚至没有 identity。在它们上加锁要么意外地与无关代码共享一把锁（如 `Integer` 缓存 -128 ~ 127），要么将来直接失败。

```java
private Integer count = 0;

public void inc() {
    synchronized (count) {   // 错误：count++ 后 count 指向新对象，且缓存的 Integer 全局共享
        count++;
    }
}
```

JDK 16（JEP 390）起：

- `javac` 对这类同步给出 `[synchronization]` 警告
- 运行时可用 `-XX:DiagnoseSyncOnValueBasedClasses=1`（直接报致命错误）或 `=2`（记录日志）检测

---

## 十、synchronized 还是 ReentrantLock

| 维度 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 使用 | 语法级，自动释放 | 必须在 `finally` 中 `unlock()` |
| 可中断 / 超时 | 不支持 | `lockInterruptibly()`、`tryLock(timeout)` |
| 公平性 | 非公平 | 可选公平 |
| 条件队列 | 一个 WaitSet | 多个 `Condition` |
| 诊断 | `jstack` 显示 `waiting to lock` 及持有者 | 显示 `parking to wait for`，持有者需看 AQS |
| 虚拟线程 | JDK 21 ~ 23 会钉住，JDK 24+ 无问题 | 不钉住 |

没有特殊需求时优先 `synchronized`：代码简单、不会忘记释放，在 JDK 24+ 上与虚拟线程配合也没有障碍。需要中断、超时、公平、多条件时用 `ReentrantLock`，见 [显式锁（Lock）](./25_topic_lock)。

---

## 小结

- `synchronized` 锁的是对象的 monitor，提供互斥、可重入和 acquire / release 内存语义；锁状态和升级是 HotSpot 的实现优化，不是语言规范
- 同步块编译为 `monitorenter` 加两条 `monitorexit`（含异常路径），同步方法用 `ACC_SYNCHRONIZED` 标志
- 偏向锁 JDK 15 默认关闭、JDK 18 代码移除；新轻量级锁 JDK 21 引入、JDK 23 成为默认、JDK 26 成为唯一实现
- JDK 8 的栈锁在竞争时直接膨胀，自适应自旋发生在 ObjectMonitor 内部；自旋不是锁状态
- ObjectMonitor 由 owner、重入计数、入口队列和 WaitSet 组成，JDK 25 把 cxq 与 EntryList 合并；空闲 monitor 会被异步收缩
- C2 通过逃逸分析做锁消除，并对相邻同步块做锁粗化
- JDK 21 ~ 23 中在 `synchronized` 内阻塞会钉住虚拟线程的载体线程，JDK 24（JEP 491）解决；用 JFR `jdk.VirtualThreadPinned` 排查剩余情况
- 不要在 `Integer`、`String` 字面量等值类型类或共享对象上同步，锁对象用 `private final` 专用对象

> 下一篇：[显式锁（Lock）](./25_topic_lock) —— AQS、ReentrantLock、读写锁与 StampedLock，看可中断、可超时的锁如何实现。

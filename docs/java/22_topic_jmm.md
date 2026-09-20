 专项 - JMM 内存模型

> JMM（Java Memory Model）定义了多线程程序中变量的**读写规则**，是理解 `volatile`、`synchronized`、`final` 线程安全语义的理论基础。

---

## 一、主内存与工作内存

JMM 将内存抽象为两层：

| | 主内存（Main Memory） | 工作内存（Working Memory） |
|--|--------------------|-----------------------|
| 位置 | 所有线程共享 | 每个线程私有（对应 CPU 缓存 + 寄存器） |
| 存储 | 所有共享变量的"权威副本" | 当前线程用到的变量副本 |
| 操作 | read / write | load / use / assign / store |

线程对变量的所有操作都在工作内存中进行，**不能直接操作主内存**；线程间通信必须经过主内存中转。

---

## 二、三大特性

### 2.1 可见性（Visibility）

一个线程对共享变量的修改，**另一个线程能否立即看到**。

```java
// 没有可见性保障的例子
boolean flag = false;           // 主内存

// 线程 A
flag = true;                    // 写入工作内存，可能未刷回主内存

// 线程 B
while (!flag) { /* 可能永远循环 */ }
```

解决方案：`volatile`、`synchronized`、`Lock`、`final`（安全发布）。

### 2.2 原子性（Atomicity）

操作不可被中断，要么全部执行，要么全部不执行。

- Java 基本类型（`long`/`double` 在 32 位 JVM 上除外）的**单次读写**是原子的
- 复合操作（如 `i++`，等价于 read → add → write 三步）**不是**原子的
- 解决方案：`synchronized`、`Lock`、`AtomicXxx`（CAS）

### 2.3 有序性（Ordering）

编译器和 CPU 为了优化可能对指令进行**重排序**，JMM 保证单线程语义不变，但多线程下可能出现问题。

---

## 三、happens-before 原则

JMM 通过 happens-before 规则向程序员承诺：如果操作 A happens-before 操作 B，则 A 的结果对 B 可见，且 A 在 B 之前执行。

| 规则 | 说明 |
|------|------|
| **程序顺序规则** | 同一线程，前面的操作 happens-before 后面的操作 |
| **监视器锁规则** | `unlock` happens-before 后续对同一锁的 `lock` |
| **volatile 变量规则** | 对 volatile 变量的写 happens-before 后续对该变量的读 |
| **线程启动规则** | `Thread.start()` happens-before 该线程的任何操作 |
| **线程终止规则** | 线程所有操作 happens-before `Thread.join()` 返回 |
| **线程中断规则** | `interrupt()` happens-before 被中断线程检测到中断 |
| **对象终结规则** | 构造函数结束 happens-before `finalize()` 开始 |
| **传递性** | A hb B 且 B hb C，则 A hb C |

---

## 四、指令重排序

### 4.1 三种重排序来源

```
源代码 → [编译器重排序] → [指令级并行重排序] → [内存系统重排序] → 最终执行
```

- **编译器重排序**：JIT/javac 调整代码顺序（不改变单线程语义）
- **处理器重排序**：CPU 乱序执行、写缓冲区延迟写回
- **内存系统重排序**：多级缓存导致写操作对其他核心不立即可见

### 4.2 经典问题：双重检查锁（DCL）

```java
// 错误写法（无 volatile）
public class Singleton {
    private static Singleton instance;
    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();  // ← 分三步：分配内存、初始化、赋值
                    // 重排序后可能：分配内存 → 赋值 → 初始化
                    // 其他线程拿到半初始化对象！
                }
            }
        }
        return instance;
    }
}

// 正确写法：加 volatile 禁止重排序
private static volatile Singleton instance;
```

---

## 五、volatile 的内存语义

`volatile` 提供**可见性**和**禁止重排序**，但**不保证原子性**。

```java
volatile boolean ready = false;
int data = 0;

// 线程 A
data = 42;          // 普通写
ready = true;       // volatile 写 → 刷新所有工作内存变量到主内存，并插入 StoreStore + StoreLoad 屏障

// 线程 B
if (ready) {        // volatile 读 → 使工作内存失效，从主内存重新读，插入 LoadLoad + LoadStore 屏障
    use(data);      // 可以看到 data = 42（happens-before 保证）
}
```

**内存屏障（Memory Barrier）**：JVM 通过插入 4 类屏障（LoadLoad / StoreStore / LoadStore / StoreLoad）实现 volatile 语义。

---

## 六、synchronized 的内存语义

- **进入 synchronized 块**：将工作内存中对应变量清空，强制从主内存重新读取
- **退出 synchronized 块**：将工作内存中修改的变量全部刷回主内存

因此 `synchronized` 同时提供**可见性 + 原子性 + 有序性**（重量级保证）。

---

## 七、final 的内存语义

`final` 字段在构造函数中的初始化，对所有线程可见，**无需额外同步**（禁止了构造期间的写操作与构造后读操作的重排序）。

```java
// 安全发布：final 字段无需 volatile 就能正确可见
public class FinalExample {
    final int x;
    FinalExample() { x = 1; }
}
```

---

## 八、常见面试问题

**Q：`volatile` 能保证线程安全吗？**

不能保证复合操作的原子性。`i++` 在 volatile 下仍然不安全，需要用 `AtomicInteger` 或 `synchronized`。

**Q：`volatile` 和 `synchronized` 的区别？**

| | volatile | synchronized |
|--|----------|-------------|
| 可见性 | ✅ | ✅ |
| 原子性 | ❌（单次读写✅） | ✅ |
| 有序性 | ✅（禁止重排序） | ✅ |
| 阻塞 | 不阻塞 | 会阻塞 |
| 适用场景 | 状态标志、DCL | 复合操作、临界区 |

**Q：happens-before 和内存可见性的关系？**

happens-before 是 JMM 对可见性的规范化描述：若 A happens-before B，则 A 的写对 B 的读可见。程序员不需要了解底层屏障，只需关注 happens-before 规则。

**Q：为什么双重检查锁需要 volatile？**

`new Object()` 不是原子操作，JIT 可能重排序为"分配内存→赋值→初始化"。另一线程可能在初始化完成前拿到半初始化的对象。`volatile` 的 StoreLoad 屏障禁止该重排序。

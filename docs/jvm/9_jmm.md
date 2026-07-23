# Java 内存模型（JMM）

> 参考规范：[JSR-133: Java Memory Model and Thread Specification](https://www.cs.umd.edu/~pugh/java/memoryModel/jsr133.pdf) / 《深入理解 Java 虚拟机》第 12 章

---

## 一、为什么需要 JMM

现代 CPU 有多级缓存（L1/L2/L3），每个核心有自己的缓存。多线程程序中：

```
CPU Core 1                CPU Core 2
┌──────────┐              ┌──────────┐
│  L1 Cache│              │  L1 Cache│
│  x = 1   │              │  x = 0   │  ← Core 2 读到的是缓存旧值
└────┬─────┘              └────┬─────┘
     │                         │
     └──────── 主内存 ──────────┘
               x = 1（已更新）
```

加上编译器/CPU 的**指令重排序**优化，多线程程序的执行结果难以预测。JMM 定义了一套规则，让开发者可以推断多线程程序的行为。

---

## 二、主内存与工作内存

JMM 的抽象模型：

```
线程 A                    线程 B
┌────────────┐            ┌────────────┐
│  工作内存   │            │  工作内存   │
│  变量副本   │            │  变量副本   │
└─────┬──────┘            └──────┬─────┘
      │  read/write/lock/unlock   │
      └──────── 主内存 ───────────┘
                共享变量
```

| 操作 | 说明 |
|------|------|
| `read` | 从主内存读取变量值到工作内存 |
| `load` | 把 read 到的值放入工作内存副本 |
| `use` | 把工作内存中的值传给执行引擎 |
| `assign` | 把执行引擎的值赋给工作内存副本 |
| `store` | 把工作内存副本值传输到主内存 |
| `write` | 把 store 传来的值写入主内存变量 |

---

## 三、happens-before 原则

happens-before 是 JMM 对外提供的**可见性保证**：若操作 A happens-before 操作 B，则 A 的结果对 B 可见。

**8 条 happens-before 规则：**

| 规则 | 说明 |
|------|------|
| **程序顺序规则** | 同一线程内，按代码顺序，前面的操作 hb 后面的操作 |
| **监视器锁规则** | 解锁（unlock）hb 后续对同一锁的加锁（lock）|
| **volatile 变量规则** | volatile 写 hb 后续对同一变量的 volatile 读 |
| **线程启动规则** | `Thread.start()` hb 该线程的任何操作 |
| **线程终止规则** | 线程所有操作 hb `Thread.join()` 返回 |
| **线程中断规则** | `interrupt()` hb 被中断线程检测到中断 |
| **对象终结规则** | 构造函数结束 hb `finalize()` 开始 |
| **传递性规则** | 若 A hb B，B hb C，则 A hb C |

---

## 四、volatile

`volatile` 提供两个语义：**可见性** + **禁止重排序**（但不保证原子性）。

### 可见性

```java
// 线程 A
volatile boolean flag = false;
flag = true;   // volatile 写：立即刷新到主内存

// 线程 B
while (!flag) { ... }  // volatile 读：每次从主内存读，不用缓存副本
// flag = true 后，线程 B 能立即感知
```

### 禁止重排序（内存屏障）

JMM 对 volatile 读写插入内存屏障：

```
volatile 写：
  StoreStore 屏障  ← 写之前：普通写不能重排到 volatile 写之后
  volatile 写
  StoreLoad 屏障   ← 写之后：volatile 写不能重排到后续读之前

volatile 读：
  volatile 读
  LoadLoad 屏障    ← 读之后：后续普通读不能重排到 volatile 读之前
  LoadStore 屏障
```

### 不能保证原子性

```java
volatile int count = 0;

// 多线程执行 count++ 仍然不安全！
// count++ 等价于：
//   int tmp = count;  // 读
//   tmp = tmp + 1;    // 计算
//   count = tmp;      // 写
// 读-改-写不是原子操作，volatile 无法保证

// ✅ 应改用 AtomicInteger 或 synchronized
AtomicInteger count = new AtomicInteger(0);
count.incrementAndGet();
```

---

## 五、指令重排序

编译器和 CPU 会在不改变**单线程语义**的前提下对指令重排序以提升性能，但会破坏多线程程序的正确性。

### 经典案例：双重检查锁（DCL）

```java
// ❌ 错误版本：instance 未加 volatile
public class Singleton {
    private static Singleton instance;

    public static Singleton getInstance() {
        if (instance == null) {               // 第一次检查
            synchronized (Singleton.class) {
                if (instance == null) {       // 第二次检查
                    instance = new Singleton();
                    // 对象创建分三步：
                    // 1. 分配内存
                    // 2. 初始化对象
                    // 3. 将引用赋给 instance
                    // 步骤 2 和 3 可能被重排序！
                    // 另一个线程看到非 null 的 instance 但对象未初始化完毕
                }
            }
        }
        return instance;
    }
}

// ✅ 正确版本：volatile 禁止重排序
public class Singleton {
    private static volatile Singleton instance;  // 加 volatile

    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();  // 写操作前有 StoreStore 屏障，保证初始化完成才对外可见
                }
            }
        }
        return instance;
    }
}
```

---

## 六、synchronized 的内存语义

`synchronized` 不仅保证互斥，还提供内存可见性：

```
进入 synchronized 块：清空工作内存，强制从主内存重新读取变量
退出 synchronized 块：将工作内存中的修改立即刷新到主内存
```

等价于在 `synchronized` 块首尾各插入一个全屏障（Full Memory Barrier）。

---

## 七、final 的内存语义

```java
public class FinalExample {
    final int x;
    int y;

    public FinalExample() {
        x = 1;   // final 写
        y = 2;   // 普通写
    }
}

FinalExample obj = new FinalExample();
// JMM 保证：构造函数中 final 字段的写入，在构造函数完成后对其他线程可见
// 即：其他线程读到 obj 引用后，obj.x 一定是 1（不会看到默认值 0）
// 但 obj.y 不保证（普通字段，可能看到 0）
```

**前提**：对象引用不能在构造函数中"逸出"（提前发布 this 引用）。

---

## 八、JMM vs JVM 内存结构

常见混淆，本质上是两个不同维度：

| | JVM 内存结构 | Java 内存模型（JMM）|
|--|------------|-------------------|
| 关注点 | 运行时内存**区域划分**（堆/栈/方法区）| 多线程的**可见性和有序性规则** |
| 层次 | JVM 实现层面 | 语言规范层面（JSR-133）|
| 解决问题 | 内存怎么分配和管理 | 多线程之间如何安全共享数据 |
| 对应文件 | [JVM 内存结构](./0_memory.md) | 本文 |

---

## 九、常见面试问题

**Q：volatile 能替代 synchronized 吗？**
不能完全替代。`volatile` 只保证可见性和有序性，不保证原子性（如 `i++`）。`synchronized` 三者都保证。`volatile` 适合状态标志位（`boolean flag`）、DCL 中的引用变量；需要复合操作时用 `synchronized` 或 `java.util.concurrent` 原子类。

**Q：happens-before 和时间先后顺序的关系？**
没有直接关系。A 在时间上先于 B 执行，不代表 A happens-before B；反之 A hb B 也不代表 A 一定先执行（只保证 A 的结果对 B 可见）。happens-before 是一种**可见性保证**，不是执行顺序约束。

**Q：为什么说 long/double 的读写不是原子的？**
JMM 允许将 64 位的 long/double 读写拆分为两次 32 位操作（商业 JVM 通常实现为原子，但规范不保证）。声明 `volatile long` 可强制原子读写。

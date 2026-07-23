# JIT 编译器

## 一、JIT 编译基础

JVM 默认使用**混合执行模式**：方法先解释执行，多次调用后触发 JIT 编译为本地机器码缓存，后续调用直接执行机器码。

```
字节码 → 解释器（逐条翻译）→ 检测热点 → JIT 编译器（编译为机器码）→ 直接执行
```

**热点代码两类：**
- 多次调用的方法（方法调用计数器超阈值）
- 多次执行的循环体（回边计数器超阈值，触发 OSR 栈上替换）

---

## 二、分层编译（Tiered Compilation）

JDK 7 引入，JDK 8 默认开启（`-XX:+UseTieredCompilation`）。

```
Level 0：解释执行，收集方法调用统计信息
Level 1：C1 编译（无优化，仅编译）→ 快速启动
Level 2：C1 编译（有限 profiling）
Level 3：C1 编译（完整 profiling）→ 收集类型信息等
Level 4：C2 编译（激进优化）→ 峰值性能
```

| 编译器 | 特点 | 触发阈值（默认） |
|--------|------|-----------------|
| **C1**（Client Compiler） | 编译快，优化有限 | 2000 次方法调用 |
| **C2**（Server Compiler） | 编译慢，优化激进 | 10000 次方法调用 |

典型执行路径：`0 → 3 → 4`（热点方法先被 C1 快速编译，再被 C2 深度优化）

---

## 三、主要优化技术

### 方法内联（Method Inlining）

将被调用方法的代码直接嵌入调用方，消除方法调用开销（参数传递、栈帧创建）。

```java
// 优化前
int result = add(a, b);
private int add(int x, int y) { return x + y; }

// JIT 内联后（概念上等效）
int result = a + b;  // 直接展开，无方法调用
```

内联是其他优化的基础：内联后暴露更多上下文，触发常量折叠、死代码消除等。

**内联限制：**
- 方法体超过 `35` 字节码指令（`-XX:MaxInlineSize=35`）默认不内联（热方法可放宽到 `325`）
- 多态调用（多个实现类）难以内联（虚方法去虚化后才可以）

### 逃逸分析（Escape Analysis）

分析对象是否"逃逸"出方法或线程范围，从而做出以下优化：

**栈上分配（Stack Allocation）：**
```java
// 对象未逃逸出方法，可在栈上分配，随栈帧销毁无需 GC
public int calculate() {
    Point p = new Point(1, 2);   // p 不逃逸
    return p.x + p.y;            // 随方法结束自动回收
}
```

**标量替换（Scalar Replacement）：**
```java
// 对象被拆解为基本类型，完全不创建对象
// Point(1,2).x + Point(1,2).y → 直接用 1 + 2
```

**同步消除（Lock Elision）：**
```java
// 对象未逃逸则无多线程竞争，锁被消除
public void method() {
    Object lock = new Object();    // lock 不逃逸
    synchronized (lock) { ... }   // 锁被消除
}
```

参数：`-XX:+DoEscapeAnalysis`（JDK 6u23+ 默认开启）

### 常量折叠与死代码消除

```java
// 编译期/JIT 期间常量折叠
int x = 2 * 3 * 100;  // → 600

// 死代码消除
if (false) { doSomething(); }  // 整块删除
```

### 去虚化（Devirtualization）

虚方法调用（`invokevirtual`）通常无法内联（运行时才知道实际类型）。JIT 通过类型 profiling 发现调用点实际只有一种类型时，可做**内联缓存**（Inline Cache）甚至完全去虚化后内联。

---

## 四、OSR（On-Stack Replacement）

循环体执行次数达到阈值时，JIT 直接替换**正在执行的栈帧**（不等方法返回），让循环后续迭代以编译后的代码执行。常见于长时间运行的循环。

---

## 五、代码缓存（Code Cache）

JIT 编译后的本地代码存放在代码缓存中（堆外内存）：

```bash
-XX:ReservedCodeCacheSize=256m     # 代码缓存上限（JDK9+ 默认 240MB）
-XX:+PrintCompilation              # 打印 JIT 编译记录
```

代码缓存满时 JVM 停止编译（退化为解释执行），可通过 JConsole 的 "Code Cache" 监控。

---

## 六、GraalVM 与 AOT

**GraalVM**（JDK 17+ 集成 Graal JIT）：用 Java 编写的 JIT 编译器，支持更激进的优化，与 C2 竞争。

**Native Image（AOT 编译）：**
```bash
native-image -jar app.jar  # 编译为原生可执行文件
```
- 启动时间从秒级降至毫秒级（无 JVM 启动、无 JIT 预热）
- 内存占用大幅降低
- 代价：运行时无 JIT 优化，峰值吞吐量略低；动态特性（反射、动态代理）需要额外配置
- Spring Boot 3.x 支持通过 GraalVM Native Image 构建原生镜像

---

## 七、虚拟线程（Project Loom，JDK 21）

虚拟线程是 JDK 21 正式发布的轻量级线程，由 JVM 而非 OS 调度，彻底改变了高并发 I/O 场景的编程模型。

### 平台线程 vs 虚拟线程

| 对比 | 平台线程（OS Thread）| 虚拟线程（Virtual Thread）|
|------|---------------------|--------------------------|
| 创建开销 | 高（约 1MB 栈，OS 系统调用）| 极低（初始栈几百字节，JVM 管理）|
| 数量上限 | 千级（受 OS 限制）| 百万级 |
| 阻塞时 | OS 线程挂起，占用资源 | 自动卸载（unmount），载体线程继续执行其他任务 |
| 调度 | OS 调度器 | JVM ForkJoinPool（Work-Stealing）|
| 适用 | CPU 密集型 | I/O 密集型（HTTP 调用、数据库查询）|

### 挂载 / 卸载机制

```
虚拟线程 VT ─── 挂载（mount）──► 载体线程（平台线程）
                                    │
                   遇到阻塞 I/O     │
                        ↓          │
          VT 卸载（unmount）◄─────────┤  载体线程空闲，可执行其他 VT
                        │
          I/O 完成后重新挂载到任意载体线程
```

虚拟线程阻塞时只消耗极少堆内存（保存栈帧的连续数组），而不占用 OS 线程。

### 使用方式

```java
// 1. 直接创建（类似普通线程）
Thread vt = Thread.ofVirtual().name("vt-1").start(() -> {
    // 阻塞 I/O 会自动挂起，无需特殊处理
    String result = httpClient.get("https://api.example.com/data");
    System.out.println(result);
});

// 2. ExecutorService（推荐，每任务一个虚拟线程）
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = IntStream.range(0, 10_000)
        .mapToObj(i -> executor.submit(() -> fetchData(i)))
        .collect(Collectors.toList());
    // 10000 个并发请求，实际只用少量载体线程
}

// 3. Spring Boot 3.2+ 一键启用
// application.yaml:
// spring.threads.virtual.enabled: true
```

### 注意事项

```java
// ❌ 虚拟线程中使用 synchronized 持有锁时阻塞 → 载体线程被"钉住"（pinned），无法卸载
synchronized (lock) {
    socket.read(buffer);  // 阻塞时载体线程不能释放给其他虚拟线程
}

// ✅ 改用 ReentrantLock，阻塞时可正常卸载
ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    socket.read(buffer);  // 阻塞时虚拟线程卸载，载体线程可执行其他任务
} finally {
    lock.unlock();
}
```

**其他注意点：**
- `ThreadLocal` 仍可用，但百万虚拟线程时内存占用显著；JDK 21 引入 `ScopedValue` 作为替代
- 不适合 CPU 密集型任务（虚拟线程数量多但载体线程只有核心数个）
- 线程池对虚拟线程无意义（虚拟线程创建成本极低，不需要复用）

---

## 八、常见面试问题

**Q：为什么 Java 程序刚启动时慢，运行一段时间后变快？**
启动时字节码解释执行，JIT 编译需要积累足够的运行数据（热点检测）才能触发；编译完成后直接执行机器码，性能大幅提升。这个过程叫 **JIT 预热**（Warm-up）。

**Q：逃逸分析能保证对象一定在栈上分配吗？**
不能。逃逸分析是启发式的，实现上通常先做标量替换而非真正栈上分配；且 JIT 会在分析代价过高时放弃。可以说"未逃逸对象有机会被优化为栈上分配或标量替换"。

**Q：方法内联对代码有什么影响？**
提升性能（消除调用开销、触发进一步优化）；也会增大代码体积（Code Cache 占用），极端情况下可能降低 CPU 指令缓存命中率。因此 JIT 会根据方法大小限制内联深度。

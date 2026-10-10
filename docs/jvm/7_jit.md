---
description: 分层编译、内联与去虚化、逃逸分析、OSR、Code Cache、Graal 与 AOT 启动优化
---

# JIT 编译

> 前置阅读：[GC 调优](./6_gc_tuning)

**Java 程序"越跑越快"的原因是 JIT**：方法先解释执行，被判定为热点后由 C1 / C2 编译成本地机器码。本篇以 JDK 21 LTS 的 HotSpot 为基准，讲分层编译、关键优化、Code Cache 与 AOT 启动优化。

---

## 一、JIT 编译基础

**HotSpot 默认是混合模式：解释执行 + 热点编译。** 编译的单位是方法（OSR 时是循环），编译结果缓存在 Code Cache 中复用。

| 概念 | 一句话定位 |
|------|-----------|
| 解释器 | 逐条解释字节码，启动快、执行慢，同时收集 profiling 数据 |
| C1（Client Compiler） | 编译快、优化保守，负责快速产出机器码并收集 profile |
| C2（Server Compiler） | 编译慢、优化激进，基于 profile 产出峰值性能代码 |
| Code Cache | 存放编译后机器码的堆外内存区域 |
| OSR | 把正在执行的长循环"原地"切换到编译后的代码 |

一段代码的执行过程：

1. 字节码先由解释器执行，同时计数、收集类型等 profiling 信息
2. 计数器超过阈值，方法被判定为热点，提交给后台编译线程
3. 编译完成后，方法入口切换到机器码，后续调用直接执行机器码
4. 若运行时假设被打破（如出现新的子类），编译代码被废弃，回退解释执行（**逆优化**，Deoptimization）

**热点探测靠两类计数器：**

| 计数器 | 统计对象 | 超阈值后 |
|--------|---------|---------|
| 方法调用计数器（Invocation Counter） | 方法被调用的次数 | 编译整个方法，下次调用生效 |
| 回边计数器（Back-edge Counter） | 循环体向回跳转的次数 | 触发 OSR 编译，正在执行的循环中途切换 |

::: tip 相关运行模式
`-Xint` 只解释执行，`-Xcomp` 首次调用即编译，默认 `-Xmixed`。`-Xcomp` 缺少 profile 反而优化不佳，一般只用于测试。
:::

---

## 二、分层编译（Tiered Compilation）

**分层编译让 C1 负责"快"、C2 负责"好"。** JDK 7 引入，JDK 8 起默认开启（`-XX:+UseTieredCompilation`）。

### 1、五个编译级别

| 级别 | 执行方式 | profiling | 说明 |
|------|---------|-----------|------|
| 0 | 解释执行 | 有 | 所有方法的起点 |
| 1 | C1 编译，完全优化 | 无 | 用于简单方法（如 getter），C2 优化也没有更多收益 |
| 2 | C1 编译 | 有限（调用 / 回边计数） | C2 编译队列繁忙时的过渡 |
| 3 | C1 编译 | 完整（含分支、类型 profile） | 为 C2 收集数据，比 2 级慢一些 |
| 4 | C2 编译 | 无 | 基于 profile 激进优化，峰值性能 |

**典型路径是 `0 → 3 → 4`**：热点方法先被 C1 带 profiling 编译，数据足够后再由 C2 深度优化。简单方法走 `0 → 3 → 1`；C2 队列过长时可能走 `0 → 2 → 3 → 4`；发生逆优化则回到 0 级重新积累。

### 2、编译阈值

**分层模式下，是否进入下一级由调用计数与回边计数共同决定**，默认值如下（以所用 JDK 为准，可用 `java -XX:+PrintFlagsFinal -version | grep Tier` 查看）：

| 参数 | 默认值 | 含义 |
|------|-------|------|
| `Tier3InvocationThreshold` | 200 | 调用次数超过它 → 编译到 3 级 |
| `Tier3CompileThreshold` | 2000 | 调用次数 + 回边次数超过它（且调用数超过 `Tier3MinInvocationThreshold`）→ 编译到 3 级 |
| `Tier3BackEdgeThreshold` | 60000 | 回边次数超过它 → 3 级 OSR 编译 |
| `Tier4InvocationThreshold` | 5000 | 调用次数超过它 → 编译到 4 级（C2） |
| `Tier4CompileThreshold` | 15000 | 调用次数 + 回边次数超过它（且调用数超过 `Tier4MinInvocationThreshold`）→ 编译到 4 级 |
| `Tier4BackEdgeThreshold` | 40000 | 回边次数超过它 → 4 级 OSR 编译 |

- 实际阈值还会按编译队列长度和编译线程数动态缩放，队列越忙，阈值越高
- 对照：关闭分层（`-XX:-UseTieredCompilation`）时只用 C2，阈值为 `CompileThreshold=10000`

::: warning 不要随意调阈值
阈值调低会让大量"温"方法挤占编译线程和 Code Cache，调高会拉长预热。线上一般保持默认，预热问题用预热流量解决，见 [JVM 层性能策略](/high-perf/5_jvm_tuning)。
:::

---

## 三、主要优化技术

**方法内联是一切优化的基础**：内联后调用方与被调方的代码合在一起，才暴露出常量折叠、逃逸分析、去虚化等优化机会。

### 1、方法内联（Method Inlining）

把被调用方法的代码直接嵌入调用处，消除调用开销（参数传递、栈帧创建、跳转）。

```java
// 优化前
int result = add(a, b);
private int add(int x, int y) { return x + y; }

// JIT 内联后（概念上等效）
int result = a + b;
```

**内联限制（以字节码大小计，不是指令条数）：**

| 参数 | 默认值 | 含义 |
|------|-------|------|
| `MaxInlineSize` | 35 字节 | 非热点方法，字节码不超过它才内联 |
| `FreqInlineSize` | 325 字节 | 热点方法（频繁调用）允许的字节码上限，与平台有关 |
| `MaxInlineLevel` | 15 | 最大内联嵌套深度（JDK 14 起由 9 调为 15） |

- 已编译成较大机器码的方法、异常处理密集的方法可能拒绝内联
- 查看内联决策：`-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining`

### 2、去虚化（Devirtualization）

**虚方法调用（`invokevirtual` / `invokeinterface`）要运行时才知道目标，本来难以内联；JIT 借助类型 profile 和类层次分析把它变成直接调用。**

| 调用点类型 | 实际出现的类型数 | JIT 处理 |
|-----------|----------------|---------|
| 单态（monomorphic） | 1 种 | 加类型检查后直接内联 |
| 双态（bimorphic） | 2 种 | 两路类型判断，分别内联 |
| 多态（megamorphic） | 3 种及以上 | 走虚表 / 接口表查找，通常不内联 |

另外，若类层次分析（CHA）发现某方法当前只有一个实现，也可直接内联；之后加载了新的子类，已编译代码会被**逆优化**。

### 3、逃逸分析（Escape Analysis）

**逃逸分析判断对象是否会被方法外或其他线程访问；未逃逸的对象可以做标量替换和同步消除。** `-XX:+DoEscapeAnalysis` 自 JDK 6u23 起默认开启，且依赖内联——对象传给未被内联的方法就视为逃逸。

| 逃逸程度 | 含义 | 可做的优化 |
|---------|------|-----------|
| 不逃逸 | 只在方法内使用 | 标量替换、同步消除 |
| 方法逃逸 | 作为返回值或参数传出 | 同步消除受限，不能消除分配 |
| 线程逃逸 | 赋给静态字段 / 被其他线程访问 | 无 |

**标量替换（Scalar Replacement，`-XX:+EliminateAllocations`）**：把对象拆成若干局部变量（放在寄存器或栈帧中），完全不创建对象。

```java
public int calculate() {
    Point p = new Point(1, 2);   // p 不逃逸
    return p.x + p.y;
}
// 标量替换后（概念上等效）：int x = 1; int y = 2; return x + y;  —— 没有 new
```

**同步消除（Lock Elision，`-XX:+EliminateLocks`）**：锁对象不逃逸，就不存在竞争，`synchronized` 被去掉。

```java
public void method() {
    Object lock = new Object();    // lock 不逃逸
    synchronized (lock) { ... }    // 锁被消除
}
```

::: warning HotSpot 没有真正的栈上分配
常说的"栈上分配"在 HotSpot 中并不存在：它不会把完整对象放到栈上，而是**通过标量替换消除分配**。对象一旦需要作为整体存在（例如被存入数组、在分支中逃逸），仍在堆上分配。逃逸分析效果依赖内联，不稳定，性能优化以分配火焰图实测为准。
:::

### 4、其他常见优化

| 优化 | 作用 |
|------|------|
| 常量折叠 / 常量传播 | `2 * 3 * 100` 直接算成 `600` |
| 死代码消除 | 删除永远不会执行的分支和结果未被使用的计算 |
| 公共子表达式消除 | 相同表达式只计算一次 |
| 循环优化 | 循环展开、范围检查消除、循环不变量外提 |
| 空值检查消除 | 用隐式检查（依赖信号处理）替代显式判空 |
| Intrinsic | 对 `System.arraycopy`、`String.equals`、`Math` 等方法直接替换为手写的高效机器码 |

---

## 四、OSR（On-Stack Replacement）

**OSR 解决"方法只调用一次，但里面有个跑很久的循环"的问题。** 回边计数超过阈值时，JIT 以循环入口为起点编译一个特殊版本，并把**正在执行的栈帧**替换为编译代码的栈帧，循环后续迭代直接执行机器码。

- 典型场景：`main` 方法里的大循环、批处理任务中的长循环
- `-XX:+PrintCompilation` 输出中带 `%` 标记的就是 OSR 编译
- OSR 代码只能从循环入口进入，优化效果通常不如常规编译，这也是微基准测试要用 JMH 的原因之一

---

## 五、代码缓存（Code Cache）

**Code Cache 是 JIT 机器码的存放地，属于堆外内存；满了之后 JIT 停止编译，新的热点代码只能解释执行，性能明显下降。**

```bash
-XX:ReservedCodeCacheSize=256m     # 代码缓存上限（分层编译下默认 240MB）
-XX:+PrintCompilation              # 打印 JIT 编译记录
jcmd <pid> Compiler.codecache      # 查看 Code Cache 使用情况（JDK 9+）
```

- JDK 9 起 Code Cache 分段（JEP 197）：非方法代码、带 profile 代码（C1）、不带 profile 代码（C2）三段分开管理
- 满时日志出现 `CodeCache is full. Compiler has been disabled.`；大应用、动态生成类多的应用需要关注
- Code Cache 计入进程内存，容器中核算内存时不要漏掉，见 [JVM 层性能策略](/high-perf/5_jvm_tuning)

**`PrintCompilation` 输出中常见标记：**

| 标记 | 含义 |
|------|------|
| `%` | OSR 编译 |
| `s` | synchronized 方法 |
| `!` | 方法含异常处理器 |
| `n` | native 方法包装 |
| 数字列 0–4 | 编译级别 |
| `made not entrant` | 编译代码被废弃（逆优化或被更高级别替代） |

---

## 六、Graal 与 AOT

**JIT 的代价是预热：刚启动时解释执行 + C1 为主，要跑一段时间才达到峰值。** 缩短启动与预热有几条路线，成熟度差别很大。

### 1、Graal 编译器

- Graal 是用 Java 编写的 JIT 编译器，通过 JVMCI 接入 HotSpot，可替代 C2
- JDK 10 以实验特性引入 OpenJDK（JEP 317，`-XX:+UnlockExperimentalVMOptions -XX:+UseJVMCICompiler`）
- JDK 17 从 OpenJDK 中移除（JEP 410，同时移除了 JDK 9 引入的 `jaotc` AOT 工具）
- 现在要使用 Graal JIT，需要使用 **GraalVM 发行版**

### 2、GraalVM Native Image

```bash
native-image -jar app.jar   # 编译为原生可执行文件
```

- 构建期做静态分析（封闭世界假设），直接生成机器码，启动从秒级降到毫秒级，内存占用大幅降低
- 代价：没有运行时 JIT，峰值吞吐通常低于 HotSpot；反射、动态代理、资源加载需要额外配置
- Spring Boot 3.x 通过 AOT 处理支持构建 Native Image

### 3、HotSpot AOT 缓存（Project Leyden）

**在一次"训练运行"中记录启动期的工作成果，存成 AOT 缓存，后续启动直接复用。** 仍然是 HotSpot，JIT 照常工作。

| 版本 | 特性 | 作用 |
|------|------|------|
| JDK 24 | JEP 483：AOT 类加载与链接 | 缓存已加载、已链接的类，缩短启动 |
| JDK 25 | JEP 514：AOT 命令行易用性 | 一条 `-XX:AOTCacheOutput` 完成训练并生成缓存 |
| JDK 25 | JEP 515：AOT 方法 profiling | 缓存训练时的方法 profile，JIT 启动后更快编译热点，缩短预热 |

```bash
# JDK 25：训练运行并生成缓存
java -XX:AOTCacheOutput=app.aot -jar app.jar
# 生产启动时使用缓存
java -XX:AOTCache=app.aot -jar app.jar
```

JDK 21 不可用。与 AppCDS、CRaC 的选型对比见 [JVM 层性能策略](/high-perf/5_jvm_tuning)。

::: tip 虚拟线程
虚拟线程（JDK 21）属于并发模型，与 JIT 无关，原理与使用见 [虚拟线程](/java/30_topic_virtual_thread)。
:::

---

## 小结

- HotSpot 默认混合模式，方法调用计数与回边计数决定热点，长循环通过 OSR 中途切换到机器码
- 分层编译 0–4 级，典型路径 `0 → 3 → 4`：C1 带 profiling 快速编译，C2 基于 profile 激进优化
- 内联是优化的基础（`MaxInlineSize=35`、`FreqInlineSize=325` 字节）；去虚化依赖类型 profile，假设失效会逆优化
- 逃逸分析在 HotSpot 中通过标量替换消除分配、同步消除去掉锁，没有真正的栈上分配
- Code Cache 满会停止编译；缩短启动与预热可选 AOT 缓存（JDK 24+）、Native Image 等，Graal JIT 需用 GraalVM 发行版

> 下一篇：[诊断工具](./8_monitoring_tools) —— 从 jcmd、jstack、jmap 到 JFR 与 NMT，看清运行中的 JVM。

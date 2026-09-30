# 开发总结 - JVM

> 精华提炼，细节详见 [JVM 总览](/jvm/0_overview)。以 JDK 21 LTS 为基准，兼顾 JDK 8 / 17 与 25。

## 一、内存结构

### 1、JVM 的运行流程是什么？

**核心结论**：源码经 javac 编译为字节码，JVM 用**类加载器**把 class 加载进**运行时数据区**，由**执行引擎**（解释器 + JIT）翻译成机器码交给 CPU，需要时通过**本地方法接口**调用 C/C++ 库。

| 组成 | 职责 |
|------|------|
| 类加载子系统 | 加载 → 链接（验证、准备、解析）→ 初始化，生成 `Class` 对象 |
| 运行时数据区 | 程序计数器、虚拟机栈、本地方法栈、堆、方法区 |
| 执行引擎 | 解释器、JIT 编译器（C1 / C2）、垃圾收集器 |
| 本地方法接口（JNI） | 调用 native 库 |

→ 详见 [JVM 内存结构](/jvm/1_memory)

### 2、JVM 内存区域有哪些？各区域的作用是什么？

**核心结论**：线程私有的程序计数器、虚拟机栈、本地方法栈管"怎么执行"；线程共享的堆、方法区管"数据放哪"。直接内存不属于规范定义的运行时数据区，但同样会 OOM。

| 区域 | 线程 | 存储内容 | 典型异常 |
|------|------|---------|---------|
| 程序计数器 | 私有 | 当前字节码指令地址 | 无（规范唯一不会 OOM 的区域） |
| 虚拟机栈 | 私有 | 栈帧：局部变量表、操作数栈、动态链接、返回地址 | `StackOverflowError` / OOM |
| 本地方法栈 | 私有 | native 方法调用（HotSpot 与虚拟机栈合一） | 同上 |
| 堆 | 共享 | 对象实例、数组，以及静态变量、字符串常量池（JDK 7+） | `Java heap space` |
| 方法区（元空间） | 共享 | 类元数据、运行时常量池 | `Metaspace` |
| 直接内存 | — | NIO 堆外缓冲区 | `Direct buffer memory` |

→ 详见 [JVM 内存结构](/jvm/1_memory)

### 3、堆和栈的区别？堆和方法区的区别？

**核心结论**：栈是线程私有的方法执行空间，随方法调用自动分配释放；堆是线程共享的对象存储空间，由 GC 回收。方法区同样线程共享，但存的是类的结构信息（元数据），不是对象实例。

| 对比项 | 虚拟机栈 | 堆 | 方法区（元空间） |
|--------|---------|----|----------------|
| 线程 | 私有 | 共享 | 共享 |
| 存什么 | 栈帧（局部变量、操作数） | 对象实例、数组、静态变量 | 类元数据、方法字节码、运行时常量池 |
| 生命周期 | 随方法调用入栈出栈 | 由 GC 回收 | 类卸载时回收 |
| 大小参数 | `-Xss` | `-Xms` / `-Xmx` | `-XX:MaxMetaspaceSize` |
| 所在内存 | 本地内存 | JVM 堆 | 本地内存（JDK 8+） |

- 局部变量是基本类型时值在栈上；是引用时栈上只存引用，对象本身在堆上（除非被 JIT 标量替换消除）

→ 详见 [JVM 内存结构](/jvm/1_memory)

### 4、方法区在 JDK 8 后有什么变化？为什么用元空间替代永久代？

**核心结论**：JDK 8 用**元空间**（本地内存）取代了**永久代**（堆内固定大小），字符串常量池和静态变量早在 JDK 7 就已移到堆中。

| JDK 版本 | 方法区实现 | 字符串常量池 | 静态变量 |
|---------|-----------|-------------|---------|
| JDK 6 及之前 | 永久代 | 永久代 | 永久代 |
| JDK 7 | 永久代 | 堆 | 堆（随 Class 对象） |
| JDK 8+ | 元空间 | 堆 | 堆 |

替换原因：

- 永久代大小要预先指定、难以估算，动态生成类多时容易 `OutOfMemoryError: PermGen space`
- 元空间使用本地内存按需扩展，类元数据的回收与堆 GC 解耦
- 便于 HotSpot 与 JRockit 合并（JRockit 没有永久代）

注意 `-XX:MaxMetaspaceSize` 默认不设上限，**建议显式设置**；`-XX:MetaspaceSize` 是首次触发元空间 GC 的高水位，不是初始容量。

→ 详见 [JVM 内存结构](/jvm/1_memory)

### 5、Java 对象一定在堆上分配吗？

**核心结论**：语义上对象都在堆上，但 JIT 的逃逸分析发现对象不逃逸时，可以通过**标量替换**把对象拆成局部变量，**根本不创建对象**。HotSpot 并没有把完整对象放到栈上的"栈上分配"。

- 标量替换依赖内联与逃逸分析（`-XX:+DoEscapeAnalysis`、`-XX:+EliminateAllocations`，默认开启），效果不稳定
- 对象需要作为整体存在（存入数组、在分支中逃逸）时仍在堆上分配
- 多数对象分配在线程私有的 TLAB 中，这仍然是堆的一部分

→ 详见 [JIT 编译](/jvm/7_jit)

### 6、什么是内存泄漏？和内存溢出的区别？

**核心结论**：内存泄漏是**不再使用的对象仍被引用、无法回收**，是原因；内存溢出（OOM）是**申请内存时空间不足**，是结果。泄漏持续积累最终导致溢出，但溢出也可能只是容量不够。

| 对比项 | 内存泄漏 | 内存溢出 |
|--------|---------|---------|
| 本质 | 对象无用但仍可达 | 分配时没有足够空间 |
| 表现 | GC 后老年代占用持续上涨、Full GC 也降不下来 | 抛出 `OutOfMemoryError` |
| 处理 | heap dump + MAT 找引用链，修代码 | 泄漏则修代码；容量不足则扩容或降低占用 |

常见泄漏：静态集合只增不减、监听器未注销、`ThreadLocal` 未 `remove()`、缓存无上限、类加载器泄漏。

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)

### 7、OOM 有哪几种类型？各是什么原因？

**核心结论**：看 `OutOfMemoryError` 后面的消息判断是哪块内存不够，排查方向完全不同。

| 错误消息 | 区域 | 典型原因 |
|---------|------|---------|
| `Java heap space` | 堆 | 内存泄漏、大对象、流量突增、堆过小 |
| `GC overhead limit exceeded` | 堆 | GC 耗时超过 98% 却回收不到 2%（主要见于 Parallel，`UseGCOverheadLimit`） |
| `Metaspace` / `Compressed class space` | 元空间 | 动态代理生成大量类、类加载器泄漏 |
| `Direct buffer memory` | 直接内存 | ByteBuf 未释放、`MaxDirectMemorySize` 过小、`DisableExplicitGC` |
| `unable to create native thread` | OS 线程 | 线程数超过 `ulimit -u` / `pids.limit`、线程无界增长 |
| `StackOverflowError`（不是 OOM，属于 Error） | 虚拟机栈 | 递归过深、循环引用导致的无限递归 |

另外，**容器 OOMKilled 不是 JVM 的 OOM**：进程总内存超过容器 limit 被内核杀掉（退出码 137），没有 Java 异常和 heap dump。

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)

### 8、String 常量池在哪里？JDK 6 和 JDK 7+ 有什么区别？

**核心结论**：JDK 6 在永久代，JDK 7 起移到堆中，池中字符串可以被 GC 回收。

- 常量池（StringTable）本质是一张固定桶数的哈希表，桶数由 `-XX:StringTableSize` 决定（默认值随版本不同）
- 移到堆中的好处：避免永久代空间不足，字符串可以正常参与 GC
- 这一迁移也改变了 `intern()` 的行为（见下题）

→ 详见 [JVM 内存结构](/jvm/1_memory)

### 9、String.intern() 的作用和使用场景？

**核心结论**：池中已有相等字符串就返回池中引用；没有时 JDK 7+ 把**当前对象的引用**登记进池并返回（JDK 6 是把字符串**复制**到永久代）。

```java
String s1 = new String("hello");
System.out.println(s1 == s1.intern());       // false：池中早有字面量 "hello"

String s4 = new String("ab") + new String("c");  // 池中还没有 "abc"
s4.intern();                                      // JDK 7+ 登记 s4 的引用
System.out.println(s4 == "abc");                  // JDK 7+ true，JDK 6 false
```

- 使用场景：大量重复且取值有限的字符串（编码、状态、标签），intern 后共享同一对象省内存
- 对比 G1 等的字符串去重（`-XX:+UseStringDeduplication`）：只共享底层 `byte[]`，String 对象仍各自独立，`==` 结果不变

→ 详见 [JVM 内存结构](/jvm/1_memory)

## 二、类加载

### 10、类加载的完整过程是怎样的？

**核心结论**：加载 → 验证 → 准备 → 解析 → 初始化，中间三步合称链接。各阶段按顺序开始，但可以交叉进行，解析可推迟到首次使用。

| 阶段 | 做什么 |
|------|-------|
| 加载 | 按全限定名获取字节流，生成元空间中的类元数据和堆中的 `Class` 对象 |
| 验证 | 文件格式（魔数、版本）、元数据语义、字节码（StackMapTable）、符号引用 |
| 准备 | 为静态变量分配内存并赋**零值**；编译期常量直接赋值 |
| 解析 | 符号引用 → 直接引用，HotSpot 多为惰性解析 |
| 初始化 | 执行 `<clinit>`（静态赋值 + `static {}`），父类先于子类，JVM 保证只执行一次且加锁 |

→ 详见 [类加载机制](/jvm/2_class_loading)

### 11、双亲委派模型的原理和作用？

**核心结论**：类加载器收到请求先委托父加载器，父加载器无法完成才自己加载。作用是**避免重复加载**和**保护核心类库**。

1. `findLoadedClass` 检查是否已加载
2. 委托父加载器 `loadClass`，一直到 Bootstrap
3. 父加载器都找不到，才调用自己的 `findClass`

| 加载器（JDK 9+） | 加载范围 | JDK 8 对照 |
|----------------|---------|-----------|
| Bootstrap | `java.base` 等核心模块 | `rt.jar` |
| Platform | `java.sql` 等部分平台模块 | Extension，`jre/lib/ext` |
| Application | classpath 与模块路径 | 同名 |

- 父子关系是组合（`parent` 字段），不是继承
- JDK 9+ 委派前会先按包名定位所属模块，模块归哪个加载器就直接交给它
- 即使绕过委派，`defineClass` 也会拒绝定义 `java.*` 包下的类

→ 详见 [类加载机制](/jvm/2_class_loading)

### 12、如何打破双亲委派？为什么 Tomcat 要打破？

**核心结论**：重写 `loadClass()` 改变委派顺序，或让父加载器借用子加载器（TCCL），都属于打破双亲委派。

| 场景 | 做法 |
|------|------|
| SPI（JDBC、JNDI） | `DriverManager` 在上层加载器，驱动在 classpath；`ServiceLoader` 用线程上下文类加载器（TCCL）加载实现类，父"向下"借子 |
| Tomcat | 每个 Web 应用一个 WebApp ClassLoader，JDK 类仍交给上层，其余类**先在本应用查找**再委派 Common |
| OSGi | 每个 Bundle 一个加载器，按 `Import-Package` / `Export-Package` 网状委派 |
| 热部署 | 新建加载器加载新版本类，丢弃旧加载器 |

**Tomcat 为什么要打破**：同一 Tomcat 部署多个应用，它们可能依赖同一类库的不同版本；按双亲委派会共享同一个版本，WebApp ClassLoader "先自己后父亲"实现了应用间隔离，同时通过 Common 共享公共类库。

→ 详见 [类加载机制](/jvm/2_class_loading)

### 13、类的初始化时机有哪些？（主动引用 vs 被动引用）

**核心结论**：只有 6 种**主动引用**会触发初始化，其余都是被动引用。

主动引用：

1. `new`、`getstatic`、`putstatic`、`invokestatic`（编译期常量除外）
2. 反射调用，如 `Class.forName("X")`
3. 初始化子类时父类未初始化
4. 包含 `main` 方法的主类
5. `MethodHandle` 解析结果为 `REF_getStatic` / `REF_putStatic` / `REF_invokeStatic` / `REF_newInvokeSpecial`
6. 接口定义了 `default` 方法，其实现类初始化时先初始化该接口

被动引用（不触发初始化）：

- 通过子类引用父类的静态字段：只初始化父类
- 定义类的数组：`new Parent[10]` 只创建数组类
- 引用编译期常量：常量已内联到调用方常量池
- `ClassLoader.loadClass()` 只加载不初始化；`Class.forName(name, false, loader)` 也不初始化

→ 详见 [类加载机制](/jvm/2_class_loading)

### 14、如何判断两个类是否相同？

**核心结论**：**全限定名相同 + 定义它的类加载器相同**，缺一不可。

- 同一个 `.class` 被两个加载器加载，得到两个不同的类：相互赋值抛 `ClassCastException`，`instanceof` 返回 `false`
- 线上常见于热部署、插件化、多个 Web 应用共享对象时出现"`X cannot be cast to X`"

→ 详见 [类加载机制](/jvm/2_class_loading)

### 15、`static final` 常量为什么在准备阶段就能赋值？

**核心结论**：编译期常量（`static final` 且值为基本类型或 `String` 字面量）的值在编译时已确定，写入了 Class 文件字段的 `ConstantValue` 属性，准备阶段直接读取赋值，无需等 `<clinit>`。

```java
public static int value = 123;                  // 准备阶段 0，初始化阶段才赋 123
public static final int MAX = 100;              // 准备阶段直接 100
public static final Object LOCK = new Object(); // 不是编译期常量，初始化阶段赋值
```

→ 详见 [类加载机制](/jvm/2_class_loading)

## 三、字节码执行

### 16、JVM 字节码是基于栈还是基于寄存器执行的？

**核心结论**：基于**操作数栈**。指令从栈顶取操作数、把结果压回栈顶。

| 对比项 | 栈式（JVM 字节码） | 寄存器式（Dalvik / ART） |
|--------|------------------|------------------------|
| 指令长度 | 短，多数零地址 | 较长，需编码寄存器号 |
| 指令条数 | 较多 | 较少 |
| 移植性 | 不依赖硬件寄存器，易移植 | 与寄存器模型相关 |

JIT 编译后生成的机器码仍会充分使用 CPU 寄存器，栈式只是字节码层面的设计。

→ 详见 [字节码执行](/jvm/3_bytecode)

### 17、`i++` 和 `++i` 的字节码有什么区别？

**核心结论**：区别在于 `iinc`（直接对局部变量表 slot 加 1）与 `iload`（读值入栈）的先后。

| 表达式 | 字节码顺序 | 表达式的值 |
|--------|-----------|-----------|
| `j = i++` | `iload` → `iinc` → `istore` | 旧值 |
| `j = ++i` | `iinc` → `iload` → `istore` | 新值 |

- 单独作为语句（`i++;`）时，两者都只编译成一条 `iinc`，没有区别
- 经典陷阱：`i = i++` 结果不变，因为先把旧值压栈，`iinc` 后又用旧值覆盖了 `i`

→ 详见 [字节码执行](/jvm/3_bytecode)

### 18、Lambda 为什么用 `invokedynamic` 实现，而不是编译成匿名内部类？

**核心结论**：把"如何生成实现类"推迟到运行期由 `LambdaMetafactory` 决定，不生成磁盘 `.class`，并且实现策略可以随 JDK 升级改进而无需重新编译。

执行过程：

1. javac 把 Lambda 体编译成私有方法（如 `lambda$main$0`），使用处生成一条 `invokedynamic`
2. **首次执行**：调用引导方法 `LambdaMetafactory`，在内存中生成实现函数式接口的类（JDK 15+ 为隐藏类），返回 `CallSite` 并与该指令链接
3. **后续执行**：直接走已链接的 `CallSite`，不再调用引导方法；无捕获的 Lambda 通常复用同一实例
4. 调用函数式方法（如 `Predicate.test()`）走普通的 `invokeinterface`

| 对比项 | 匿名内部类 | Lambda |
|--------|-----------|--------|
| 编译产物 | 每个一个 `Outer$1.class` | 无额外磁盘 class |
| 类加载 | 按需加载每个类文件 | 首次执行时在内存生成，之后复用 |
| `this` | 匿名类实例 | 外围类实例 |

→ 详见 [字节码执行](/jvm/3_bytecode)

## 四、垃圾回收

### 19、如何判断对象是否可以被回收？

**核心结论**：HotSpot 用**可达性分析**：从 GC Roots 出发沿引用链遍历，遍历不到的对象即为垃圾。没有采用引用计数。

| 方法 | 原理 | 问题 |
|------|------|------|
| 引用计数 | 被引用 +1，失去引用 -1，为 0 回收 | 无法处理循环引用（A ↔ B 都不可达，计数却不为 0） |
| 可达性分析 | 从 GC Roots 遍历对象图 | 需要 STW 枚举根，并发标记需要屏障防漏标 |

另外还有四种引用强度影响回收：强引用不回收、软引用内存不足时回收、弱引用下次 GC 回收、虚引用只用于回收通知（配合 `ReferenceQueue` / `Cleaner`）。

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 20、有哪些 GC Roots？为什么它们可以作为根？

**核心结论**：GC Roots 是程序"正在使用"的入口，本身不需要证明存活——线程栈上的变量、已加载类的静态字段等，程序随时可能访问它们。

| GC Root | 说明 |
|---------|------|
| 虚拟机栈中的引用 | 局部变量、方法参数 |
| 本地方法栈中的 JNI 引用 | native 代码持有的对象 |
| 类静态字段 | 已加载类的 static 字段 |
| 常量引用 | 如字符串常量池中的字符串 |
| 被 `synchronized` 持有的对象 | 锁对象 |
| JVM 内部引用 | 基本类型的 Class 对象、常驻异常、系统类加载器等 |

只回收部分区域时（Young GC、G1 Mixed GC），其他区域指向本区域的引用也要作为额外的根，靠记忆集 / 卡表提供。

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 21、常见垃圾回收算法有哪些？

**核心结论**：标记-清除、复制、标记-整理三种，分别牺牲了连续性、空间和移动成本。

| 算法 | 过程 | 优点 | 缺点 | 应用 |
|------|------|------|------|------|
| 标记-清除 | 标记存活对象，回收其余 | 不移动对象 | 内存碎片；传统实现需要 STW | CMS 老年代 |
| 复制 | 存活对象复制到另一块，整体清空原块 | 无碎片，指针碰撞分配 | 朴素实现空间利用率 50% | 年轻代（Eden + 2 Survivor，利用率 90%） |
| 标记-整理 | 标记后把存活对象向一端移动 | 无碎片 | 移动对象、更新引用开销大 | Serial Old、Parallel Old、Full GC |

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 22、分代收集的原理是什么？新生代和老年代用的是哪种算法？

**核心结论**：基于"绝大多数对象朝生夕死、熬过越多次 GC 越难死"两条假说，把堆分成年轻代和老年代，按存活率选算法：年轻代用**复制**，老年代用**标记-清除 / 标记-整理**。

| 区域 | 默认比例 | 回收方式 |
|------|---------|---------|
| Eden : S0 : S1 | 8 : 1 : 1（`SurvivorRatio=8`） | Young GC，复制算法 |
| 老年代 : 年轻代 | 2 : 1（`NewRatio=2`，调大则年轻代变小） | 标记-清除（CMS）或标记-整理 |

晋升规则：年龄达到 `MaxTenuringThreshold`（默认 15）；动态年龄判断（按年龄从小到大累加，超过 Survivor × `TargetSurvivorRatio` 50% 时，取该年龄为阈值）；Survivor 放不下直接晋升；大对象直接进老年代（`PretenureSizeThreshold` 仅 Serial / ParNew 有效，G1 用 Humongous Region）。

G1、分代 ZGC 仍然分代，但各代是逻辑上的 Region 集合。

→ 详见 [GC 原理](/jvm/4_gc_theory)、[JVM 内存结构](/jvm/1_memory)

### 23、Minor GC、Major GC 和 Full GC 的区别与触发条件？

**核心结论**：Minor（Young）GC 只回收年轻代；Major GC 只回收老年代；Full GC 回收**整个堆 + 元空间**。口语中常把 Major 与 Full 混用，排查以 GC 日志为准。

| 类型 | 触发条件 |
|------|---------|
| Young GC | **Eden 空间不足**。TLAB 分配失败不是直接条件：先申请新 TLAB 或在 Eden 共享区分配，Eden 也放不下才触发 |
| Major GC | 目前只有 CMS 的并发收集是单独回收老年代 |
| Mixed GC（G1） | 并发标记完成后，回收年轻代 + 部分收益高的老年代 Region |
| Full GC | 老年代放不下晋升 / 大对象；元空间达到高水位；空间分配担保失败（Serial / Parallel）；CMS Concurrent Mode Failure、G1 转移失败后仍不够；`System.gc()` |

空间分配担保（JDK 6u24 后）：老年代最大连续空间大于新生代对象总大小，或大于历次晋升平均大小，就执行 Young GC，否则 Full GC。

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 24、Minor GC 需要扫描整个老年代吗？跨代引用怎么处理？

**核心结论**：不需要。老年代指向年轻代的引用由**记忆集 / 卡表**记录，Young GC 只扫描脏卡。

- **卡表**：把老年代按 512 字节划分卡页，某卡页中有对象引用了年轻代就标记为脏卡
- **写屏障**：引用赋值时由 JIT 插入的代码负责维护卡表
- G1 为每个 Region 维护 RSet，记录其他 Region 指向本 Region 的引用，原理相同

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 25、什么是三色标记？并发标记为什么会漏标，CMS 和 G1 分别怎么解决？

**核心结论**：三色标记用白 / 灰 / 黑描述标记进度。并发标记时业务线程修改引用，**同时**满足两个条件就会把存活对象漏标；CMS 用增量更新破坏条件一，G1 用 SATB 破坏条件二。

| 颜色 | 含义 |
|------|------|
| 白 | 未访问，标记结束仍为白即是垃圾 |
| 灰 | 已访问，但引用的对象还没扫描完 |
| 黑 | 自身及引用都已扫描，不再回头 |

漏标的两个必要条件：

1. 黑色对象**新增**了指向白色对象的引用
2. 所有从灰色对象到该白色对象的路径都被**删除**

| 方案 | 破坏条件 | 做法 | 使用者 |
|------|---------|------|-------|
| 增量更新 | 条件一 | 写屏障记录新增引用，把黑色对象重新置灰，重新标记阶段再扫描 | CMS |
| SATB（原始快照） | 条件二 | 写屏障在引用删除前记录旧值，按标记开始时的快照标记，被删目标本轮视为存活（产生浮动垃圾） | G1、Shenandoah |

ZGC 不使用 SATB，靠染色指针与读屏障实现并发标记和转移。

→ 详见 [GC 原理](/jvm/4_gc_theory)

### 26、`System.gc()` 一定会触发 Full GC 吗？`-XX:+DisableExplicitGC` 有什么影响？

**核心结论**：`System.gc()` 只是建议，默认情况下多数收集器会执行一次 Full GC，但 JVM 可以忽略或改为并发 GC。**不要随手加 `DisableExplicitGC`**，它可能导致 `OutOfMemoryError: Direct buffer memory`。

- `DirectByteBuffer` 的堆外内存要等 Java 对象被回收、`Cleaner` 执行后才释放
- 分配直接内存超过 `MaxDirectMemorySize` 时，JDK 会调用 `System.gc()` 触发引用处理并重试
- 禁用显式 GC 后这一步失效，堆内长期没有 GC 时堆外内存释放不了，最终 OOM
- 想避免显式 GC 带来长停顿，用 **`-XX:+ExplicitGCInvokesConcurrent`**：G1 下改为一次并发周期

→ 详见 [GC 原理](/jvm/4_gc_theory)

## 五、垃圾收集器

### 27、Serial、Parallel、CMS、G1、ZGC 各有什么特点？

**核心结论**：演进主线是把越来越多的 GC 工作从 STW 挪到并发阶段。

| 收集器 | 特点 | 典型停顿 | 状态 / 适用 |
|--------|------|---------|------------|
| Serial / Serial Old | 单线程，复制 + 标记-整理 | 长 | 单核、小堆；小配额容器可能被自动选中 |
| Parallel Scavenge / Old | 多线程并行，吞吐优先 | 较长 | JDK 8 默认；批处理 |
| ParNew | Serial 的多线程版，配合 CMS | — | JDK 9 废弃、JDK 10 移除 |
| CMS | 并发标记-清除老年代 | 短 | JDK 9 废弃、JDK 14 移除 |
| G1 | Region 化，按回收收益选 Region，停顿可预测 | 可控（默认目标 200ms） | JDK 9 起默认 |
| ZGC | 染色指针 + 读屏障，并发转移 | 亚毫秒（JDK 16+） | JDK 15 生产可用，JDK 21+ 用分代 ZGC |
| Shenandoah | 并发整理，JDK 13 起用 LRB | 毫秒级 | OpenJDK 12 合入，Oracle JDK 不含 |

JVM 默认选择（JDK 9+）：CPU 少于 2 个或内存小于 1792MB 的非"服务器级"机器用 Serial，否则用 G1。生产环境建议显式指定。

→ 详见 [GC 收集器](/jvm/5_gc_collectors)

### 28、CMS 的垃圾回收过程？它有什么缺点？

**核心结论**：四个阶段，两次短暂 STW；主要缺点是碎片、占 CPU、浮动垃圾导致 Concurrent Mode Failure。

| 阶段 | STW | 内容 |
|------|-----|------|
| 初始标记 | 是 | 只标记 GC Roots 直接关联的对象 |
| 并发标记 | 否 | 遍历对象图，耗时最长 |
| 重新标记 | 是 | 用增量更新修正并发期间的变化 |
| 并发清除 | 否 | 清除未标记对象，不移动存活对象 |

- **内存碎片**：标记-清除不整理，碎片严重只能 Full GC
- **占用 CPU**：并发阶段与业务线程争抢，核数少时明显
- **浮动垃圾**：并发阶段新产生的垃圾本轮回收不了，必须预留空间提前启动；预留不足发生 **Concurrent Mode Failure**，退化为 Serial Old 单线程 Full GC，停顿极长
- JDK 14 已移除，新项目用 G1 或 ZGC

→ 详见 [GC 收集器](/jvm/5_gc_collectors)

### 29、G1 的工作原理？Region 是什么？为什么它能预测停顿时间？

**核心结论**：G1 把堆分成大量等大的 Region，每次在停顿目标内优先回收"垃圾最多、收益最高"的 Region（Garbage First）。

- **Region**：1MB–32MB（2 的幂，默认按堆约 2048 个计算；JDK 18 起上限 512MB），每个 Region 动态扮演 Eden / Survivor / Old / Humongous；≥ Region 一半的对象放入 Humongous Region
- **RSet**：每个 Region 记录外部指向它的引用，回收单个 Region 不必扫全堆

| 阶段 | 说明 |
|------|------|
| Young GC | STW，回收全部 Eden 与 Survivor |
| 并发标记周期 | 老年代占用达到 IHOP（JDK 9 起自适应）后启动，初始标记 → 并发标记（SATB）→ 最终标记 → 清理 |
| Mixed GC | 年轻代 + 一批收益最高的 Old Region，分多轮 |
| Full GC | 兜底，JDK 10 起并行 |

**可预测停顿**：G1 记录每个 Region 的存活比例和历史回收耗时，在 `MaxGCPauseMillis` 内挑选收益最高的 Region 组成回收集合，并动态调整年轻代大小。这是软目标，所以**不要用 `-Xmn` / `NewRatio` 固定年轻代**，否则目标失效。

→ 详见 [GC 收集器](/jvm/5_gc_collectors)

### 30、ZGC 如何实现低延迟？

**核心结论**：标记、转移、重定位几乎全部并发执行，停顿不随堆大小和存活对象数量增长；关键技术是**染色指针 + 读屏障**。

- **染色指针**：GC 状态编码在 64 位指针的元数据位中，不读对象头就知道指针状态
- **读屏障**：业务线程加载引用时检查指针颜色，遇到旧地址就地修正，从而支持并发转移
- **STW 只剩几个很短的暂停**（标记开始、标记结束、转移开始等），JDK 16 起线程栈也并发扫描，停顿降至亚毫秒级
- 代价：读屏障带来少量吞吐损耗、并发阶段占用额外 CPU，堆需要留余量，否则出现 Allocation Stall

→ 详见 [GC 收集器](/jvm/5_gc_collectors)

### 31、什么是分代 ZGC？各 JDK 版本如何启用？

**核心结论**：分代 ZGC 在 ZGC 上加入年轻代 / 老年代划分，让朝生夕死的对象可以更频繁、更低成本地回收，吞吐和内存占用都优于非分代版本。

| JDK 版本 | 变化 | 启用参数 |
|---------|------|---------|
| JDK 15–20 | 只有非分代 ZGC | `-XX:+UseZGC` |
| JDK 21–22 | 引入分代 ZGC（JEP 439），需显式开启 | `-XX:+UseZGC -XX:+ZGenerational` |
| JDK 23 | 分代成为默认（JEP 474），`ZGenerational` 废弃 | `-XX:+UseZGC` |
| JDK 24+ | 移除非分代模式（JEP 490） | `-XX:+UseZGC` |

- `ZCollectionInterval` 默认 0，表示不启用定时触发
- `SoftMaxHeapSize` 设软上限，ZGC 尽量把堆控制在其下，突发时仍可用到 `-Xmx`

→ 详见 [GC 收集器](/jvm/5_gc_collectors)

## 六、JIT 编译

### 32、为什么 Java 程序刚启动时慢，运行一段时间后变快？分层编译是怎样的？

**核心结论**：启动时以解释执行为主，热点方法积累足够的调用 / 回边计数后才由 JIT 编译为机器码，这个过程叫**预热**（Warm-up）；分层编译让 C1 先快速编译并收集 profile，C2 再做激进优化。

| 级别 | 执行方式 |
|------|---------|
| 0 | 解释执行（收集 profiling） |
| 1 | C1，完全优化，无 profiling（简单方法） |
| 2 | C1，有限 profiling |
| 3 | C1，完整 profiling |
| 4 | C2，基于 profile 激进优化 |

- 典型路径 `0 → 3 → 4`；逆优化时回到 0 级
- 阈值由调用计数与回边计数共同决定：`Tier3InvocationThreshold=200`、`Tier3CompileThreshold=2000`、`Tier4InvocationThreshold=5000`、`Tier4CompileThreshold=15000`（以所用 JDK 为准）；关闭分层时 `CompileThreshold=10000`
- 长循环通过 **OSR** 中途切换到编译代码
- 缓解预热：预热流量、就绪探针后置、JDK 24+ 的 AOT 缓存（JEP 483 / 515）

→ 详见 [JIT 编译](/jvm/7_jit)

### 33、逃逸分析能保证对象在栈上分配吗？

**核心结论**：不能，而且 HotSpot **没有真正的栈上分配**。逃逸分析判定对象不逃逸后，做的是**标量替换**（把对象拆成局部变量、消除分配）和**同步消除**。

- 逃逸分析依赖内联：对象传给未被内联的方法就视为逃逸
- 分析代价过高、对象需要作为整体存在时，JIT 会放弃优化，对象仍在堆上分配
- 准确的说法是"未逃逸对象有机会被标量替换，从而不在堆上分配"

→ 详见 [JIT 编译](/jvm/7_jit)

### 34、方法内联有什么好处和代价？

**核心结论**：好处是消除调用开销，并为常量折叠、逃逸分析、去虚化等后续优化暴露上下文；代价是机器码膨胀，占用 Code Cache，极端情况下降低 CPU 指令缓存命中率。

- 限制按字节码大小计：非热点方法 `MaxInlineSize=35` 字节，热点方法 `FreqInlineSize=325` 字节；嵌套深度 `MaxInlineLevel`（JDK 14 起默认 15）
- 虚方法靠类型 profile 去虚化：单态、双态可内联，多态（3 种及以上类型）通常不内联
- 假设失效（如加载了新子类）会触发逆优化
- 实践：热点路径保持方法短小，避免调用点过度多态

→ 详见 [JIT 编译](/jvm/7_jit)

## 七、JVM 调优与排查

### 35、JVM 常用参数有哪些？

**核心结论**：按"堆、分代、栈、元空间、收集器、诊断"六类记。

| 类别 | 参数 | 说明 |
|------|------|------|
| 堆 | `-Xms` / `-Xmx` | 初始 / 最大堆，服务端设为相同 |
| 堆（容器） | `-XX:InitialRAMPercentage` / `-XX:MaxRAMPercentage` | 按容器内存比例设置堆 |
| 分代 | `-Xmn`、`-XX:NewRatio`、`-XX:SurvivorRatio` | G1 下不建议固定年轻代 |
| 栈 | `-Xss` | 每线程栈，Linux x64 默认 1MB |
| 元空间 | `-XX:MetaspaceSize` / `-XX:MaxMetaspaceSize` | 前者是首次触发 GC 的高水位，后者是上限（建议显式设置） |
| 直接内存 | `-XX:MaxDirectMemorySize` | 默认约等于最大堆 |
| 收集器 | `-XX:+UseG1GC`、`-XX:+UseZGC`、`-XX:MaxGCPauseMillis` | 显式指定收集器与停顿目标 |
| 诊断 | `-XX:+HeapDumpOnOutOfMemoryError`、`-XX:HeapDumpPath`、`-XX:+ExitOnOutOfMemoryError`、`-Xlog:gc*` | OOM 现场与 GC 日志 |

→ 详见 [GC 调优](/jvm/6_gc_tuning)

### 36、如何确定堆内存大小？`-Xms` 和 `-Xmx` 为什么推荐设成相同？

**核心结论**：先测出**活跃数据量**（Full GC 或 G1 并发标记后老年代的稳定占用），G1 取其 3～4 倍，ZGC 至少 4 倍；`-Xms` 与 `-Xmx` 相同可以避免运行期扩缩堆。

- 活跃数据量可从 GC 日志、`jstat -gc` 观察 GC 后的老年代占用得到
- 堆在 `Xms`～`Xmx` 之间扩缩时，伴随额外的 GC 与向操作系统申请 / 归还内存，带来停顿抖动
- 设为相同值也让容量规划更直观；`-XX:+AlwaysPreTouch` 还可在启动时预先触碰内存页

→ 详见 [GC 调优](/jvm/6_gc_tuning)

### 37、容器中如何设置 JVM 内存？为什么会被 OOMKilled？

**核心结论**：用 `MaxRAMPercentage` 按容器 limit 比例设置堆（通常 50～75%），给堆外留足空间；OOMKilled 是**进程总内存超过容器 limit 被内核杀掉**，不是 JVM OOM。

- 容器感知：JDK 10 起默认开启 `UseContainerSupport`（8u191 回移），cgroup v2 需 JDK 15+ 或较新的 11u / 8u 更新版本
- 默认 `MaxRAMPercentage=25` 偏保守；显式设置 `-Xmx` 时该比例不生效
- 计入容器内存的还有：元空间、直接内存、线程栈、Code Cache、GC 数据结构、本地库，应显式限制 `MaxDirectMemorySize`、`MaxMetaspaceSize`
- 确认 OOMKilled：`kubectl describe pod`（Reason: OOMKilled，Exit Code 137）、`dmesg`；用 NMT 核算堆外占用
- 小配额容器（CPU < 2 或内存 < 1792MB）默认会选 Serial，显式指定收集器

→ 详见 [GC 调优](/jvm/6_gc_tuning)、[JVM 层性能策略](/high-perf/5_jvm_tuning)

### 38、jcmd 和 NMT 能做什么？

**核心结论**：`jcmd` 是 JDK 9+ 首选的诊断总入口，覆盖 jstack、jmap、jinfo 的大部分功能并能控制 JFR；NMT 统计 JVM 自身的堆外内存，用于排查 RSS 远大于 `-Xmx`、容器 OOMKilled。

| jcmd 命令 | 作用 |
|----------|------|
| `help` | 列出该 JVM 支持的命令 |
| `VM.flags` / `VM.system_properties` | 生效参数 / 系统属性 |
| `GC.heap_info` | 堆概况（替代已移除的 `jmap -heap`，也可用 `jhsdb jmap --heap --pid`） |
| `GC.class_histogram` | 对象直方图（会触发 Full GC） |
| `Thread.print` | 线程堆栈 |
| `GC.heap_dump <file>` | 导出 heap dump |
| `JFR.start` / `JFR.dump` | JFR 录制 |
| `VM.native_memory` | NMT 查询 |

NMT 用法：启动加 `-XX:NativeMemoryTracking=summary`，运行中 `jcmd <pid> VM.native_memory baseline`，一段时间后 `summary.diff` 看哪块在增长；看 committed 而不是 reserved；NMT 统计不到 JNI 本地库自行 malloc 的内存。

容器中 attach 失败通常是用户、PID 命名空间或 `/tmp` 不一致，进入容器执行 jcmd 或使用 jattach。

→ 详见 [诊断工具](/jvm/8_monitoring_tools)

### 39、如何排查 CPU 100% 问题？

**核心结论**：`top` 找进程 → `top -H -p` 找线程 → TID 转十六进制 → 在 thread dump 中按 `nid` 定位栈，并区分业务线程、GC 线程还是 JIT 编译线程。

```bash
top -H -p <pid>                 # 找到高 CPU 线程 TID
printf "%x\n" <tid>             # 转十六进制，如 3039
jstack <pid> | grep "nid=0x3039" -A 30
```

- 常见原因：死循环、自旋、活锁、频繁 GC、正则回溯爆炸、大量序列化 / 加解密
- **死锁不会导致 CPU 高**：死锁线程处于 BLOCKED，不消耗 CPU，表现为无响应
- 高 CPU 线程是 `GC Thread` / `G1 Conc` 时查 GC 日志；是 `C2 CompilerThread` 时多为启动期短时现象
- 间隔几秒多抓几次 dump，确认一直在同一处；Arthas `thread -n 3` 可一步定位

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)

### 40、如何排查内存溢出问题？线上能开 `-XX:+HeapDumpOnOutOfMemoryError` 吗？

**核心结论**：先看 OOM 消息确定区域，堆 OOM 用 heap dump + MAT 找泄漏；`HeapDumpOnOutOfMemoryError` **线上推荐开启**，它是事后分析的关键证据。

1. 看 `OutOfMemoryError` 的消息：heap / Metaspace / Direct buffer / native thread
2. `jstat -gcutil` 观察 GC 后老年代是否持续上涨（泄漏 vs 容量不足）
3. 取 heap dump：优先用 OOM 时自动生成的，或 `jcmd <pid> GC.heap_dump`
4. MAT：Leak Suspects → Dominator Tree（Retained Heap）→ Path to GC Roots
5. 修代码或调整容量，复测

为什么线上要开：生成 dump 会有停顿、需要磁盘空间（≥ 堆大小），但 OOM 时服务本已不可用，没有 dump 就无从分析。配合 `-XX:+ExitOnOutOfMemoryError` 让进程退出、由 K8s 或守护进程重启；容器中 dump 目录挂载持久卷。

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)

### 41、如何排查频繁 Full GC？

**核心结论**：先从 GC 日志找 Full GC 的**触发原因**，再对症处理；GC 后老年代降不下来优先怀疑内存泄漏。

| 原因 | 处理 |
|------|------|
| 内存泄漏（GC 后老年代持续上涨） | heap dump + MAT |
| 堆偏小，活跃数据接近老年代容量 | 按活跃数据 3～4 倍扩堆 |
| 对象过早晋升 | 增大年轻代 / Survivor，检查动态年龄 |
| 大对象 / Humongous 过多 | 优化代码；G1 调大 `G1HeapRegionSize` |
| 元空间不足（`Metadata GC Threshold`） | 调大 `MaxMetaspaceSize`，排查动态类生成 |
| 显式 `System.gc()` | 定位调用方，或 `-XX:+ExplicitGCInvokesConcurrent` |
| G1 并发标记太晚（`To-space exhausted`） | 检查 IHOP、`G1ReservePercent`、堆大小 |

工具：GC 日志 + GCEasy / GCViewer、`jstat -gccause`、`jcmd GC.class_histogram`。

→ 详见 [GC 调优](/jvm/6_gc_tuning)

## 八、Java 内存模型（JMM）

### 42、JMM 是什么？解决了什么问题？

**核心结论**：JMM 是 Java 语言规范定义的一套规则，规定多线程下一个线程的写**何时、以何种方式**对另一个线程可见，屏蔽不同 CPU 和编译器在缓存、重排序上的差异，解决**可见性、原子性、有序性**问题。

- 抽象模型：共享变量在主内存，每个线程有工作内存（对应 CPU 缓存、寄存器等）
- 对开发者的承诺：正确同步（volatile、锁、final、happens-before）的程序表现为顺序一致
- 注意与 JVM 内存结构（堆、栈、方法区）区分：一个是并发语义规范，一个是运行时内存划分

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

### 43、happens-before 的 8 条规则是什么？

**核心结论**：A happens-before B 意味着 A 的结果对 B 可见，且 A 的执行顺序排在 B 之前（在可见性意义上）。

| 规则 | 说明 |
|------|------|
| 程序顺序 | 同一线程内，前面的操作 hb 后面的操作 |
| 监视器锁 | 解锁 hb 后续对同一锁的加锁 |
| volatile | volatile 写 hb 后续对同一变量的读 |
| 线程启动 | `Thread.start()` hb 该线程内的任何操作 |
| 线程终止 | 线程内所有操作 hb 其他线程从 `join()` 返回 |
| 线程中断 | `interrupt()` hb 被中断线程检测到中断 |
| 对象终结 | 构造函数结束 hb `finalize()` 开始 |
| 传递性 | A hb B 且 B hb C，则 A hb C |

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

### 44、volatile 能保证原子性吗？适合什么场景？

**核心结论**：不能。volatile 保证**可见性**和**禁止重排序**，但 `count++` 这类"读-改-写"复合操作仍不是原子的。

- 实现：volatile 写前后、读后插入内存屏障，写入立即刷新、读取强制从主内存获取
- 适合：状态标志（`volatile boolean running`）、一写多读的配置、DCL 单例中的实例引用
- 需要原子性时用 `AtomicInteger` / `LongAdder`，或加锁

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

### 45、为什么 DCL 单例需要 volatile？不加会有什么问题？

**核心结论**：`instance = new Singleton()` 分为分配内存、初始化对象、赋值引用三步，后两步可能重排序；不加 volatile，其他线程可能在第一次检查时拿到**非 null 但未初始化完成**的对象。

```java
private static volatile Singleton instance;

public static Singleton getInstance() {
    if (instance == null) {                 // 第一次检查：无锁快速路径
        synchronized (Singleton.class) {
            if (instance == null) {         // 第二次检查
                instance = new Singleton(); // volatile 禁止"赋值引用"排到"初始化"之前
            }
        }
    }
    return instance;
}
```

替代方案：静态内部类单例（依赖 `<clinit>` 线程安全）、枚举单例。

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

### 46、synchronized 除了互斥，还有什么内存语义？

**核心结论**：还保证**可见性**和**有序性**：解锁前把修改刷新到主内存，加锁时让本线程重新读取共享变量；对应 happens-before 的监视器锁规则。

- 解锁 hb 后续对同一把锁的加锁，所以前一个持锁线程的所有写，对下一个持锁线程可见
- 临界区内的代码不会被重排序到临界区之外
- 因此 synchronized 同时提供原子性、可见性、有序性

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

### 47、final 字段的内存语义是什么？

**核心结论**：构造函数内对 final 字段的写入，不会被重排序到"把对象引用赋给其他变量"之后；其他线程只要拿到对象引用，就一定能看到 final 字段初始化后的值。普通字段没有这个保证。

- 前提：构造过程中 `this` 没有逸出（没有在构造函数里把 `this` 发布出去）
- 这是不可变对象（如 `String`）无需同步即可安全共享的基础

→ 详见 [专项 - JMM 内存模型](/java/22_topic_jmm)

## 九、虚拟线程

### 48、虚拟线程和平台线程的区别？

**核心结论**：平台线程与 OS 线程 1:1 映射，成本高、数量有限；虚拟线程（JDK 21 正式）由 JVM 调度，多个虚拟线程复用少量载体线程，成本极低、可百万级创建。

| 对比项 | 平台线程 | 虚拟线程 |
|--------|---------|---------|
| 映射 | 1:1 OS 线程 | M:N，挂载到载体线程（平台线程）上运行 |
| 栈 | MB 级，预先分配 | 按需增长，存放在堆上 |
| 数量 | 千级 | 百万级 |
| 调度 | OS 调度器 | JVM，默认用 `ForkJoinPool` 作为调度器 |
| 池化 | 必须池化 | **不池化**，每任务一个，用 `Semaphore` 限制下游并发 |
| 适合 | CPU 密集、需精确控制并发 | 大量阻塞 IO 的高并发任务 |

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(() -> callRemoteService());
}
```

Spring Boot 3.2+ 配置 `spring.threads.virtual.enabled=true` 即可让 Tomcat 与 `@Async` 使用虚拟线程。

→ 详见 [专项 - 线程池](/java/28_topic_thread_pool)

### 49、虚拟线程的挂载/卸载（mount/unmount）机制是什么？

**核心结论**：虚拟线程运行时**挂载**到某个载体线程上；遇到阻塞 IO、`sleep`、`LockSupport.park` 等操作时**卸载**，把栈帧保存到堆上，载体线程转去执行其他虚拟线程；阻塞结束后重新挂载到任意空闲载体线程继续执行。

- JDK 把 socket、`sleep`、j.u.c 锁等阻塞点改造成"park 虚拟线程"，业务代码写法不变
- 阻塞期间只占用少量堆内存保存栈帧，不占用 OS 线程
- 无法卸载的情况称为**钉住**（pinning），见第 51 题

→ 详见 [专项 - 线程池](/java/28_topic_thread_pool)

### 50、虚拟线程为什么不适合 CPU 密集型任务？

**核心结论**：虚拟线程的收益来自"阻塞时让出载体线程"；CPU 密集型任务不阻塞、一直占着载体线程，而载体线程数默认约等于 CPU 核数，创建再多虚拟线程也不会更快，反而增加调度开销。

- 虚拟线程提升的是**吞吐量**（同时处理更多阻塞请求），不是单任务的**速度**
- CPU 密集任务仍用固定大小的平台线程池（核数左右）或 `ForkJoinPool`

→ 详见 [专项 - 线程池](/java/28_topic_thread_pool)

### 51、虚拟线程中使用 synchronized 有什么问题？如何解决？

**核心结论**：JDK 21–23 中，虚拟线程在 `synchronized` 块内阻塞会**钉住**载体线程，无法卸载，大量钉住会耗尽载体线程；JDK 24（JEP 491）已消除 `synchronized` 导致的钉住。

- JDK 21–23 的解决办法：持锁期间有阻塞 IO 的代码改用 `ReentrantLock`
- 用 `-Djdk.tracePinnedThreads=full`（JDK 21–23）或 JFR 的 `jdk.VirtualThreadPinned` 事件定位钉住
- 调用 native 方法或外部函数时仍会钉住，与 JDK 版本无关
- 其他注意：虚拟线程数量巨大，`ThreadLocal` 缓存大对象会放大内存占用，可考虑 `ScopedValue`

→ 详见 [专项 - 线程池](/java/28_topic_thread_pool)

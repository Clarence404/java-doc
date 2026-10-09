---
description: JDK 8 到 27 关键特性、预览到正式的演进、移除与废弃、升级坑点与版本选型
---

# 版本演进

> **本篇目标**：按升级路径（8 → 11 → 17 → 21 → 25 → 26/27）梳理每个版本对后端开发真正有影响的特性，分清哪些已正式发布、哪些仍是预览，掌握各阶段升级最常踩的兼容性坑，并能给新老项目做版本选型。
>
> **前置阅读**：[Lambda、Stream 与注解](./1_advanced)

![Java LTS 版本时间线](../assets/java/java-lts-timeline.svg)

自 JDK 10 起 Java 每六个月发布一个版本（3 月、9 月），每两年指定一个 LTS（长期支持）版本。非 LTS 版本只维护到下一版发布，新特性通常以**预览（Preview，需 `--enable-preview`）**或**孵化（Incubator，独立的 `jdk.incubator.*` 模块）**形式在非 LTS 中迭代，定稿后才进入正式 API。本站版本基线为 **JDK 21 / 25 LTS**；截至 2026 年 10 月，最新版本是 JDK 27（2026-09 GA）。

---

## 一、Java 8 核心特性（起点）

Java 8（2014）引入了函数式编程，是迄今影响最大的一次语言升级：

| 特性 | 说明 | 详见 |
|------|------|------|
| Lambda / 方法引用 / 函数式接口 | `invokedynamic` 实现，非匿名内部类 | [Lambda、Stream 与注解](./1_advanced) |
| Stream API / Optional | 声明式集合处理、返回值空语义 | [Lambda、Stream 与注解](./1_advanced) |
| `java.time` | 不可变、线程安全，替代 `Date` / `Calendar` / `SimpleDateFormat` | [日期与时间](./17_topic_time) |
| 接口 `default` / `static` 方法 | 接口可演进而不破坏实现类 | — |
| `CompletableFuture` | 可组合的异步编程 | [CompletableFuture](./29_topic_completable_future) |
| 元空间替代永久代 | 类元数据移到本地内存，`-XX:MaxMetaspaceSize` | [内存结构](/jvm/1_memory) |
| 重复注解、类型注解 | `@Repeatable`、`TYPE_USE` | [Lambda、Stream 与注解](./1_advanced) |

```java
interface Greeting {
    default String hello(String name) { return "Hello, " + name; }   // 实现类可不重写
    static Greeting create() { return new Greeting() {}; }
}
```

多个接口提供同签名的 `default` 方法时，实现类必须重写并用 `A.super.hello(name)` 明确选择，否则编译失败。

---

## 二、Java 8 → Java 11（LTS）

### 1、模块系统（Java 9）

```java
// module-info.java
module com.example.order {
    requires java.sql;
    requires transitive com.example.common;   // 依赖传递给使用者
    exports com.example.order.api;            // 只导出 API 包
    opens com.example.order.entity;           // 允许框架在运行时深度反射
}
```

模块系统（JPMS）把 JDK 自身拆成了 `java.base`、`java.sql` 等模块，并开始限制对 JDK 内部 API 的访问。大多数业务应用仍运行在类路径（未命名模块）上，不必编写 `module-info.java`；但 JDK 内部封装在 JDK 16/17 收紧后直接影响升级，见第三节第 7 小节。`jlink` 可以基于模块裁剪出最小运行时镜像，用于缩小容器镜像。

### 2、集合工厂方法（Java 9 / 10）

```java
List<String> list = List.of("a", "b", "c");
Set<Integer> set = Set.of(1, 2, 3);
Map<String, Integer> map = Map.of("k1", 1, "k2", 2);
Map<String, Integer> big = Map.ofEntries(Map.entry("k1", 1), Map.entry("k2", 2));
List<String> copy = List.copyOf(source);    // Java 10，source 本身已不可变时直接返回
```

注意：返回的集合**不可修改**（修改抛 `UnsupportedOperationException`）、**不允许 `null`** 元素 / 键 / 值（NPE），`Set.of` / `Map.of` 遇到重复元素直接抛 `IllegalArgumentException`，且 `Set` / `Map` 的迭代顺序不固定。用它替换 `Arrays.asList` 或 Guava `ImmutableList` 时要逐一确认这些语义。

### 3、局部变量类型推断 var（Java 10 / 11）

```java
var orders = new ArrayList<Order>();                 // 推断为 ArrayList<Order>
for (var entry : map.entrySet()) {
    System.out.println(entry.getKey() + "=" + entry.getValue());
}
BiFunction<Integer, Integer, Integer> add = (@NonNull var a, @NonNull var b) -> a + b;   // Java 11：Lambda 参数可用 var 以便加注解
```

`var` 只用于局部变量（含 for 循环、try-with-resources），不能用于字段、方法参数、返回类型；`var x = null` 无法编译，`var list = new ArrayList<>()` 会被推断成 `ArrayList<Object>`，都是常见误用。右侧类型一眼可见时才用。

### 4、HttpClient（Java 11）

```java
HttpClient client = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(3))
    .build();
HttpRequest request = HttpRequest.newBuilder(URI.create("https://example.com/api"))
    .timeout(Duration.ofSeconds(5))
    .GET()
    .build();
HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
      .thenApply(HttpResponse::body);
```

标准库自带，支持 HTTP/2 与异步；JDK 26 起可选 HTTP/3（见第八节）。`HttpClient` 实例应复用，JDK 21 起它实现了 `AutoCloseable`。

### 5、String 与 Files 新方法（Java 11）

```java
"  ".isBlank();                  // true
" hello ".strip();     // "hello"，Unicode 空白感知；trim() 只去掉 <= U+0020 的字符
"a\nb\nc".lines().count();       // 3
"ha".repeat(3);                  // "hahaha"
Files.writeString(Path.of("a.txt"), "content");
String content = Files.readString(Path.of("a.txt"));    // 默认 UTF-8
```

### 6、开发体验

- **JShell**（Java 9）：交互式 REPL，验证 API 行为很方便
- **单文件源码直接运行**（Java 11，JEP 330）：`java Hello.java`，无需先 `javac`；JDK 22 扩展到多文件（JEP 458）

### 7、JVM 与平台层

以下变化以一句话列出，原理在对应模块展开：

- G1 成为默认 GC（Java 9），见 [GC 收集器](/jvm/5_gc_collectors)
- 紧凑字符串（Java 9）：纯 Latin-1 内容的 `String` 用 `byte[]` 每字符 1 字节存储，见 [String](./11_topic_string)
- 容器感知（Java 10，已回移到 8u191）：JVM 按 cgroup 限制计算 CPU 数与默认堆大小，容器中用 `-XX:MaxRAMPercentage` 而不是写死 `-Xmx`
- JFR / JMC 开源（Java 11），生产环境可免费使用，见 [性能分析工具](/high-perf/3_profilers)
- TLS 1.3（Java 11）

### 8、移除 Java EE 与 CORBA 模块（Java 11，JEP 320）

`javax.xml.bind`（JAXB）、`javax.xml.ws`（JAX-WS）、`javax.activation`、`javax.annotation`（`@PostConstruct` 所在包）、CORBA 被移出 JDK。8 → 11 升级时出现 `NoClassDefFoundError: javax/xml/bind/...` 就是这个原因，需要显式引入依赖，例如 `jakarta.xml.bind:jakarta.xml.bind-api` 加 `org.glassfish.jaxb:jaxb-runtime`。注意 Spring Boot 3 起已迁移到 `jakarta.*` 命名空间，`javax.*` 版本的依赖需要一并替换。

---

## 三、Java 11 → Java 17（LTS）

### 1、Switch 表达式（Java 14）

```java
int workHours = switch (day) {
    case MONDAY, FRIDAY -> 6;
    case TUESDAY -> 7;
    default -> {
        log.info("other day: {}", day);
        yield 8;                      // 代码块中用 yield 返回值
    }
};
```

箭头形式没有贯穿（fall-through）；作为表达式时必须穷尽所有情况，对枚举写全所有常量即可省略 `default`。

### 2、文本块（Java 15）

```java
String json = """
        {
          "name": "Java",
          "version": 17
        }
        """;
```

以结束定界符或最左侧内容决定缩进基准，行尾空白自动去除；`\` 结尾表示不换行，`\s` 保留一个空格。

### 3、instanceof 模式匹配（Java 16）

```java
if (obj instanceof String s && !s.isBlank()) {
    System.out.println(s.toLowerCase());
}
```

### 4、Record（Java 16）

```java
public record Point(int x, int y) {
    public Point {                        // 紧凑构造器：做校验，字段赋值由编译器补全
        if (x < 0 || y < 0) throw new IllegalArgumentException("坐标不能为负");
    }
}

Point p = new Point(1, 2);
p.x();                                    // 访问器方法名与组件同名，不是 getX()
```

Record 是浅不可变的数据载体：字段 `private final`，自动生成构造器、访问器、`equals` / `hashCode` / `toString`；不能继承其他类（隐式继承 `java.lang.Record`），可以实现接口。适合 DTO、值对象、方法内的多返回值；Jackson 2.12+ 支持直接序列化，但 JPA 实体需要可变性和无参构造器，不能用 record。

### 5、Sealed 类（Java 17）

```java
public sealed interface Payment permits CardPayment, WalletPayment, BankTransfer {}

public record CardPayment(String cardNo) implements Payment {}
public record WalletPayment(String walletId) implements Payment {}
public non-sealed class BankTransfer implements Payment {}   // 允许继续扩展
```

子类型必须是 `final`、`sealed` 或 `non-sealed` 之一。真正的价值在 JDK 21：`switch` 对 sealed 类型做模式匹配时，编译器能检查是否穷尽，见第四节第 2 小节。

### 6、其他常用改进

- **有帮助的 NullPointerException**（Java 14 引入，JEP 358；Java 15 起默认开启）：异常信息直接指出哪个变量为 null，如 `Cannot invoke "String.length()" because "user.name" is null`
- **`Stream.toList()`**（Java 16）：返回不可修改列表，见 [Lambda、Stream 与注解](./1_advanced)
- **ZGC、Shenandoah 转为正式**（Java 15）
- **隐藏类**（Java 15，JEP 371）：Lambda 与动态代理生成的类改用它定义

### 7、JDK 内部 API 强封装（Java 16 / 17）——11 → 17 的头号迁移问题

- Java 9 ~ 15：对 JDK 内部类（如 `sun.*`、`java.lang` 的私有字段）的深度反射只打印 `illegal reflective access` 警告
- Java 16（JEP 396）：默认改为拒绝，仍可用 `--illegal-access=permit` 临时放开
- Java 17（JEP 403）：移除 `--illegal-access`，只能按包逐个放开

```shell
# 报错形如 InaccessibleObjectException: Unable to make field private ... accessible:
#   module java.base does not "opens java.lang" to unnamed module
java --add-opens java.base/java.lang=ALL-UNNAMED \
     --add-opens java.base/java.util=ALL-UNNAMED \
     -jar app.jar
```

`--add-opens` 只是权宜之计，根本解决办法是升级用到深度反射的库（老版本的 Lombok、Groovy、CGLIB、序列化框架等）。Spring Boot 3.x / Spring Framework 6.x 起最低要求 Java 17，详见 [Spring Boot 版本演进](/spring-boot/11_versions)。

---

## 四、Java 21（LTS）

### 1、虚拟线程（JEP 444）

虚拟线程是由 JVM 调度的轻量级线程：运行时挂载在少量载体线程（一个专用 `ForkJoinPool`）上，遇到阻塞 IO 时卸载、让出载体线程，因此可以用「一个请求一个线程」的同步写法支撑大量并发 IO。

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = urls.stream()
        .map(url -> executor.submit(() -> fetch(url)))
        .toList();
}   // close() 等待所有任务结束
```

使用要点：

- 不要池化虚拟线程，每个任务新建一个；限制下游并发用 `Semaphore`
- JDK 21 ~ 23 中在 `synchronized` 块内阻塞会钉住（pin）载体线程，**JDK 24 起由 JEP 491 解决**；本地方法（JNI）帧和类初始化期间的阻塞仍会 pin
- JDK 24 移除了 `-Djdk.tracePinnedThreads`，排查 pin 用 JFR 事件 `jdk.VirtualThreadPinned`
- 适合 IO 密集型，对 CPU 密集型没有收益；`ThreadLocal` 在海量线程下会放大内存占用，考虑 `ScopedValue`

完整原理、调度模型与最佳实践见 [虚拟线程](./30_topic_virtual_thread)；Spring Boot 中的开启方式见 [异步任务与定时任务](/spring-boot/9_async_schedule)。

### 2、Record 模式与 switch 模式匹配（JEP 440 / 441）

```java
sealed interface Shape permits Circle, Rect {}
record Circle(double r) implements Shape {}
record Rect(double w, double h) implements Shape {}

static double area(Shape shape) {
    return switch (shape) {
        case Circle(double r) -> Math.PI * r * r;           // record 模式：直接解构
        case Rect(double w, double h) when w == h -> w * w;  // when 守卫
        case Rect(double w, double h) -> w * h;
    };   // sealed + 穷尽检查：不需要 default；新增 Shape 子类型时这里编译失败
}

static String format(Object obj) {
    return switch (obj) {
        case null -> "null";                 // switch 终于可以显式处理 null
        case Integer i -> "int: " + i;
        case String s when s.length() > 5 -> "long string: " + s;
        case String s -> "short string: " + s;
        default -> obj.toString();
    };
}
```

sealed + record + 模式匹配组合起来，就是 Java 版的代数数据类型：用编译器保证分支完整，替代访问者模式和 `instanceof` 链。

### 3、Sequenced Collections（JEP 431）

```java
List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
list.getFirst();    // 1，替代 list.get(0)
list.getLast();     // 3，替代 list.get(list.size() - 1)
list.reversed();    // [3, 2, 1]，返回视图而非拷贝

LinkedHashMap<String, Integer> lru = new LinkedHashMap<>();
lru.firstEntry();
lru.pollLastEntry();
lru.putFirst("k", 1);
```

新增 `SequencedCollection` / `SequencedSet` / `SequencedMap` 接口，统一了「有确定顺序」的集合在首尾的访问方式。

### 4、其他

- **分代 ZGC**（JEP 439），见 [GC 收集器](/jvm/5_gc_collectors)
- **准备禁止动态加载 Agent**（JEP 451）：运行时 attach 的 Java Agent 会打印警告，APM / Mock 工具应改为启动参数 `-javaagent` 加载，或显式 `-XX:+EnableDynamicAgentLoading`
- **JDK 17 → 21 之间的重要变化**：默认字符集统一为 UTF-8（JDK 18，JEP 400，Windows 上读写文件不指定编码的老代码行为会变）；核心反射改用方法句柄实现（JDK 18，JEP 416）；弃用 `finalize()` 准备移除（JDK 18，JEP 421）
- **同期的预览特性**：结构化并发（JEP 453）、Scoped Values（JEP 446）、String Templates（JEP 430）、未命名模式与变量（JEP 443）、未命名类与实例 main（JEP 445），后续走向见第七节

---

## 五、Java 22 / 23 / 24

| 特性 | 版本 / JEP | 状态 |
|------|-----------|------|
| 未命名变量与模式 `_` | 22 / JEP 456 | 正式（21 预览） |
| 外部函数与内存 API（FFM） | 22 / JEP 454 | 正式，替代 JNI 与 `Unsafe` 堆外内存 |
| 多文件源码直接运行 | 22 / JEP 458 | 正式 |
| G1 区域固定 | 22 / JEP 423 | 正式，JNI 临界区不再阻塞 GC |
| Markdown 文档注释 `///` | 23 / JEP 467 | 正式 |
| ZGC 默认分代模式 | 23 / JEP 474 | 正式 |
| `sun.misc.Unsafe` 内存访问方法弃用 | 23 / JEP 471 | 弃用；24 起使用时打印警告（JEP 498） |
| javac 默认不再运行类路径上的注解处理器 | 23 | 需显式声明处理器路径，见 [Lambda、Stream 与注解](./1_advanced) |
| Stream Gatherers | 24 / JEP 485 | 正式（22、23 预览） |
| Class-File API | 24 / JEP 484 | 正式，替代 ASM 解析 / 生成字节码 |
| AOT 类加载与链接 | 24 / JEP 483 | 正式（`-XX:AOTCache`），缩短启动时间 |
| 虚拟线程同步不再 pin | 24 / JEP 491 | 正式，`synchronized` 内阻塞会释放载体线程 |
| 永久禁用 Security Manager | 24 / JEP 486 | 已禁用（17 起弃用） |
| ZGC 移除非分代模式 | 24 / JEP 490 | 已移除 |
| 抗量子 ML-KEM / ML-DSA | 24 / JEP 496、497 | 正式 |
| 紧凑对象头 | 24 / JEP 450 | 实验性，25 转正式 |
| String Templates | 21、22 预览 | **23 撤回**，不再提供 |

```java
// 未命名变量（22）：不关心的变量用 _
try {
    doSomething();
} catch (IOException _) {
    log.warn("ignored");
}
int count = 0;
for (var _ : list) count++;
boolean isCircle = shape instanceof Circle(_);     // 只关心类型，不关心组件

// Stream Gatherers（24）：自定义中间操作
List<List<Integer>> windows = Stream.of(1, 2, 3, 4, 5)
    .gather(Gatherers.windowFixed(2))
    .toList();                                    // [[1, 2], [3, 4], [5]]

List<Integer> prefixSums = Stream.of(1, 2, 3, 4, 5)
    .gather(Gatherers.scan(() -> 0, Integer::sum))
    .toList();                                    // [1, 3, 6, 10, 15]

// mapConcurrent：用虚拟线程并发执行映射，限制最大并发，结果保持原顺序
List<String> bodies = urls.stream()
    .gather(Gatherers.mapConcurrent(16, url -> fetch(url)))
    .toList();

// FFM（22）：不写 C 胶水代码直接调用本地函数
Linker linker = Linker.nativeLinker();
MethodHandle strlen = linker.downcallHandle(
    linker.defaultLookup().find("strlen").orElseThrow(),
    FunctionDescriptor.of(ValueLayout.JAVA_LONG, ValueLayout.ADDRESS));
try (Arena arena = Arena.ofConfined()) {
    MemorySegment cString = arena.allocateFrom("Hello");
    long len = (long) strlen.invokeExact(cString);    // 5
}
```

`Gatherers.mapConcurrent` 是「对一批 IO 调用做有上限的并发」的标准库方案，比在并行流里做 IO 安全得多（并行流的问题见 [Lambda、Stream 与注解](./1_advanced)）。

---

## 六、Java 25（LTS）

Java 25（2025-09）是 21 之后的 LTS，共 18 个 JEP。**正式定稿**的语言 / API 特性有：Scoped Values、灵活构造器体、模块导入声明、紧凑源文件与实例 main 方法、密钥派生函数 API；**结构化并发与原始类型模式匹配仍是预览**。

### 1、Scoped Values（正式，JEP 506）

```java
static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

void handle(Request req) {
    User user = authenticate(req);
    ScopedValue.where(CURRENT_USER, user).run(() -> service.process(req));
}

// 调用链任意深处读取，无需逐层传参
void audit() {
    User user = CURRENT_USER.get();               // 未绑定时抛 NoSuchElementException
    String name = CURRENT_USER.isBound() ? CURRENT_USER.get().name() : "anonymous";
}
```

| 维度 | ThreadLocal | ScopedValue |
|------|-------------|-------------|
| 可变性 | `set` 随时修改 | 绑定后不可变，只能在内层重新绑定 |
| 生命周期 | 直到 `remove()` 或线程结束，线程池中易泄漏 | 随 `run` / `call` 结束自动解绑 |
| 子线程继承 | `InheritableThreadLocal` 在创建线程时拷贝 | 只有通过 `StructuredTaskScope.fork` 创建的子任务自动继承；普通 `new Thread`、线程池任务**不继承** |
| 虚拟线程 | 每个线程一份副本，海量线程下内存放大 | 共享绑定，开销低 |

ThreadLocal 的原理与泄漏问题见 [线程基础](./23_topic_thread_basics)。

### 2、结构化并发（第五次预览，JEP 505）

JDK 25 重新设计了 API：不再通过 `new StructuredTaskScope.ShutdownOnFailure()` 创建，而是用静态工厂 `open()` 并传入 `Joiner` 策略。需要 `--enable-preview`，且 JDK 26（JEP 525）、27（JEP 533）仍在预览并继续调整。

```java
// JDK 25 + --enable-preview
Response handle(long id) throws InterruptedException {
    try (var scope = StructuredTaskScope.open()) {    // 默认策略：全部成功，任一失败即取消其余
        StructuredTaskScope.Subtask<User> user = scope.fork(() -> fetchUser(id));
        StructuredTaskScope.Subtask<Order> order = scope.fork(() -> fetchOrder(id));
        scope.join();                                  // 有子任务失败时抛 StructuredTaskScope.FailedException
        return new Response(user.get(), order.get());
    }   // 离开作用域时所有子任务都已结束，不会泄漏线程
}

// 其他策略：任一成功即返回（如多副本竞速）
try (var scope = StructuredTaskScope.open(StructuredTaskScope.Joiner.<String>anySuccessfulResultOrThrow())) {
    scope.fork(() -> queryReplica("a"));
    scope.fork(() -> queryReplica("b"));
    String first = scope.join();
}
```

对比 JDK 21 的写法（JEP 453，同样是预览）：

```java
// JDK 21 + --enable-preview，在 JDK 25 上已无法编译
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    StructuredTaskScope.Subtask<User> user = scope.fork(() -> fetchUser(id));
    StructuredTaskScope.Subtask<Order> order = scope.fork(() -> fetchOrder(id));
    scope.join().throwIfFailed();
    return new Response(user.get(), order.get());
}
```

预览 API 每个版本都可能不兼容，生产代码在它定稿前更适合用 `CompletableFuture` 或虚拟线程 + `ExecutorService`。

### 3、原始类型模式匹配（第三次预览，JEP 507）

`instanceof` 与 `switch` 支持原始类型模式；`instanceof int` 的语义是「该值能否**无损**转换为 int」。需要 `--enable-preview`，JDK 26（JEP 530）、27（JEP 532）仍为预览。

```java
long value = 42L;
if (value instanceof int i) {               // 只有 long 值落在 int 范围内才匹配
    useInt(i);
}

int status = response.statusCode();
String desc = switch (status) {             // switch 表达式，结果赋给变量
    case 200 -> "OK";
    case int s when s >= 400 && s < 500 -> "客户端错误 " + s;
    case int s -> "其他状态 " + s;           // 无条件模式，保证穷尽
};
```

### 4、灵活的构造器体（正式，JEP 513）

`super(...)` / `this(...)` 之前允许出现语句（称为构造器序言），但序言中不能读取 `this` 或调用实例方法；**可以给本类尚未初始化的字段赋值**。

```java
class PositiveRange extends Range {
    private final int width;

    PositiveRange(int lo, int hi) {
        if (lo < 0 || hi <= lo) {
            throw new IllegalArgumentException("非法区间");   // 先校验，失败时不必白白构造父类
        }
        this.width = hi - lo;     // 在 super() 前初始化本类字段
        super(lo, hi);            // 父类构造器若调用了被重写的方法，此时 width 已就绪
    }
}
```

这消除了「为了在 `super()` 前做计算而写静态辅助方法」的样板代码，也修复了父类构造器回调子类方法时读到未初始化字段的经典问题。

### 5、模块导入声明与紧凑源文件（正式，JEP 511 / 512）

```java
// 模块导入：一次导入模块导出的全部包
import module java.base;      // java.util、java.io、java.time 等全部可用
import module java.sql;
```

```java
// Hello.java：紧凑源文件 + 实例 main 方法，java Hello.java 直接运行
void main() {
    IO.println("Hello, JDK 25");   // java.lang.IO，紧凑源文件自动导入 java.base 模块
}
```

主要服务于脚本、教学和小工具；业务项目中仍建议显式 `import` 具体类，避免同名类歧义。

### 6、Java 25 变化汇总

| 特性 | JEP | 状态 | 说明 |
|------|-----|------|------|
| Scoped Values | 506 | 正式 | ThreadLocal 的不可变替代 |
| 灵活构造器体 | 513 | 正式 | `super()` 前可校验、可初始化本类字段 |
| 模块导入声明 | 511 | 正式 | `import module M` |
| 紧凑源文件与实例 main | 512 | 正式 | `void main()`、`java.lang.IO` |
| 密钥派生函数 API | 510 | 正式 | HKDF 等 KDF 的标准接口 |
| 紧凑对象头 | 519 | 正式（产品特性） | `-XX:+UseCompactObjectHeaders`，对象头 12 → 8 字节，见 [内存结构](/jvm/1_memory) |
| 分代 Shenandoah | 521 | 正式（产品特性） | |
| AOT 命令行简化 / AOT 方法剖析 | 514 / 515 | 正式 | `-XX:AOTCacheOutput` 一步生成缓存；缓存中带方法剖析数据，预热更快 |
| JFR CPU 时间剖析 | 509 | 实验性（仅 Linux） | |
| JFR 协作式采样 / 方法计时与追踪 | 518 / 520 | 正式 | |
| 移除 32 位 x86 移植 | 503 | 已移除 | |
| 结构化并发 | 505 | 第五次预览 | API 重新设计 |
| 原始类型模式匹配 | 507 | 第三次预览 | |
| Stable Values | 502 | 预览 | JDK 26 起更名为 Lazy Constants |
| PEM 编码 | 470 | 预览 | |
| Vector API | 508 | 第十次孵化 | |

---

## 七、预览特性的演进路线

| 特性 | 21 | 22 | 23 | 24 | 25 | 26 | 27 |
|------|----|----|----|----|----|----|----|
| 结构化并发 | 预览 453 | 二次 462 | 三次 480 | 四次 499 | 五次 505（新 API） | 六次 525 | 七次 533 |
| Scoped Values | 预览 446 | 二次 464 | 三次 481 | 四次 487 | **正式 506** | | |
| 未命名变量与模式 | 预览 443 | **正式 456** | | | | | |
| 紧凑源文件与实例 main | 预览 445 | 二次 463 | 三次 477 | 四次 495 | **正式 512** | | |
| 灵活构造器体 | | 预览 447 | 二次 482 | 三次 492 | **正式 513** | | |
| 模块导入声明 | | | 预览 476 | 二次 494 | **正式 511** | | |
| Stream Gatherers | | 预览 461 | 二次 473 | **正式 485** | | | |
| 原始类型模式匹配 | | | 预览 455 | 二次 488 | 三次 507 | 四次 530 | 五次 532 |
| Stable Values / Lazy Constants | | | | | 预览 502 | 二次 526 | 三次 531 |
| String Templates | 预览 430 | 二次 459 | **撤回** | | | | |

表中数字为 JEP 编号。预览特性可能在任何版本改名、改 API 甚至撤回（String Templates 就是例子），只适合试验，不应进入生产代码。

---

## 八、Java 26 / 27（已发布）

两者都是非 LTS 版本：JDK 26 于 2026-03-17 GA，JDK 27 于 2026-09-15 GA。Valhalla 的值类型（JEP 401）尚未进入这两个版本。

### 1、Java 26（10 个 JEP）

| JEP | 特性 | 对后端的影响 |
|-----|------|--------------|
| 500 | 为「final 真正不可变」做准备 | 通过深度反射修改 `final` 字段时打印警告（每个模块一次），未来版本将默认拒绝；用 `--illegal-final-field-mutation=debug` 定位调用栈，必要时 `--enable-final-field-mutation=ALL-UNNAMED` 放开 |
| 504 | 移除 Applet API | 仅影响极老的桌面代码 |
| 516 | AOT 对象缓存支持任意 GC | AOT 缓存可与 ZGC 等收集器一起使用 |
| 517 | HttpClient 支持 HTTP/3 | 需显式开启，默认仍为 HTTP/2，服务端不支持时自动降级 |
| 522 | G1 减少同步以提升吞吐 | 升级即生效 |
| 524 | PEM 编码（第二次预览） | |
| 525 | 结构化并发（第六次预览） | |
| 526 | Lazy Constants（第二次预览） | 原 Stable Values，延迟初始化且可被 JIT 当作常量 |
| 529 | Vector API（第十一次孵化） | |
| 530 | 原始类型模式匹配（第四次预览） | |

```java
HttpClient client = HttpClient.newBuilder()
    .version(HttpClient.Version.HTTP_3)      // JDK 26+，按客户端或按请求开启
    .build();
```

JEP 500 对后端最值得关注：依赖注入、序列化、Mock 框架如果通过 `Field.set` 改写 `final` 字段，在 JDK 26 上会出现警告。处理思路和 JDK 17 的强封装一样——先升级相关库，再考虑命令行放开。

### 2、Java 27（9 个 JEP）

| JEP | 特性 | 对后端的影响 |
|-----|------|--------------|
| 523 | G1 在所有环境下都是默认 GC | 此前在 CPU 或内存很少的环境（小规格容器）中 JVM 会自动选 Serial GC，现在统一为 G1；对小规格容器的内存占用和停顿要重新评估 |
| 534 | 紧凑对象头默认开启 | 无需再加 `-XX:+UseCompactObjectHeaders`；回退用 `-XX:-UseCompactObjectHeaders` |
| 527 | TLS 1.3 后量子混合密钥交换 | |
| 536 | JFR 进程内数据脱敏 | 录制中的敏感数据可在进程内脱敏后再导出 |
| 531 | Lazy Constants（第三次预览） | |
| 532 | 原始类型模式匹配（第五次预览） | |
| 533 | 结构化并发（第七次预览） | |
| 537 | Vector API（第十二次孵化） | |
| 538 | PEM 编码（第三次预览） | |

---

## 九、移除与废弃速查

| 版本 | 变化 | 升级影响 |
|------|------|----------|
| 11 | 移除 Java EE / CORBA 模块（JEP 320） | JAXB、JAX-WS、`javax.annotation` 需单独引入依赖 |
| 14 | 移除 CMS（JEP 363） | 改用 G1 / ZGC，清理 `-XX:+UseConcMarkSweepGC` 等参数 |
| 15 | 移除 Nashorn JS 引擎（JEP 372） | 改用 GraalJS 等独立引擎 |
| 15 | 偏向锁默认禁用并弃用（JEP 374），18 移除代码 | 依赖偏向锁调优的老参数失效，见 [synchronized](./24_topic_synchronized) |
| 16 / 17 | 强封装 JDK 内部（JEP 396 / 403） | 深度反射报 `InaccessibleObjectException`，需 `--add-opens` 或升级库 |
| 17 | Security Manager 弃用（JEP 411），24 永久禁用（JEP 486） | 调用 `System.setSecurityManager` 会抛异常 |
| 18 | 默认字符集改为 UTF-8（JEP 400） | 不指定编码的文件读写在 Windows 上行为变化 |
| 18 | 终结（`finalize`）弃用待移除（JEP 421） | 用 `Cleaner` 或 try-with-resources 替代 |
| 21 | 动态加载 Agent 打印警告（JEP 451） | Agent 改为 `-javaagent` 启动加载 |
| 23 / 24 | `Unsafe` 内存访问方法弃用，24 起打印警告（JEP 471 / 498） | 迁移到 `VarHandle` 与 FFM API |
| 24 | ZGC 移除非分代模式（JEP 490） | `-XX:-ZGenerational` 失效 |
| 24 | 限制 JNI 使用的准备（JEP 472） | 调用 JNI 时打印警告，可用 `--enable-native-access` 消除 |
| 25 | 移除 32 位 x86 移植（JEP 503） | |
| 26 | 深度反射修改 final 字段打印警告（JEP 500） | 见第八节 |

---

## 十、升级检查与版本选型

### 1、升级检查清单

1. **先升依赖再升 JDK**：Spring Boot、Lombok、MapStruct、ByteBuddy / CGLIB、Mockito、Jackson 等依赖字节码或深度反射的库，需要支持目标 JDK 的版本（Lombok 对应关系见 [效率工具库](./98_dev_tool)）
2. **`jdeps --jdk-internals`** 扫描对 JDK 内部 API 的依赖
3. **清理 JVM 参数**：已移除的参数（CMS、`--illegal-access`、`-XX:+UseBiasedLocking` 等）会让 JVM 拒绝启动或打印警告
4. **构建配置**：`maven.compiler.release` / Gradle toolchain 指向目标版本；JDK 23+ 显式声明注解处理器路径
5. **观察运行时警告**：动态 Agent、JNI、`Unsafe`、final 字段修改等警告都在提示「下一个版本会变成错误」
6. **GC 与内存回归**：对比升级前后的 GC 日志、RSS 与延迟，GC 原理见 [GC 收集器](/jvm/5_gc_collectors)

### 2、版本选型建议

| 场景 | 建议 |
|------|------|
| 新项目 | **JDK 25**（或团队已有 21 基础设施时用 21），Spring Boot 3.x / 4.x 至少需要 17 |
| 重度使用虚拟线程 | **JDK 25**：24 起 `synchronized` 不再 pin，21 上需要把热点 `synchronized` 改成 `ReentrantLock` |
| 存量 JDK 8 / 11 | 视为遗留版本，新功能不再基于它们开发；规划升级到 17 → 21/25，主要成本在强封装与 `javax` → `jakarta` |
| 非 LTS（26 / 27） | 用于验证新特性和提前发现兼容问题，不建议直接用于生产 |
| 预览 / 孵化特性 | 不进入生产代码 |

---

## 小结

- 8 → 11：模块系统、集合工厂方法、`var`、HttpClient；Java EE 模块被移除是首个大坑
- 11 → 17：record、sealed、switch 表达式、文本块、instanceof 模式匹配；JDK 内部强封装（16/17）是最大的迁移成本，Spring Boot 3 起要求 17
- 21：虚拟线程正式发布，record 模式 + switch 模式匹配 + sealed 实现穷尽检查，Sequenced Collections，分代 ZGC
- 22 ~ 24：FFM、未命名变量、Stream Gatherers、Class-File API、AOT 缓存正式；JEP 491 解决 `synchronized` pin；String Templates 在 23 撤回
- 25：Scoped Values、灵活构造器体、模块导入、紧凑源文件正式，紧凑对象头成为产品特性；结构化并发与原始类型模式匹配仍是预览
- 26 / 27：HTTP/3、final 字段修改警告、G1 全面默认、紧凑对象头默认开启；结构化并发、原始类型模式、Lazy Constants 继续预览
- 新项目选 JDK 25，用虚拟线程优先 24+；预览特性不进生产

## 参考资料

- OpenJDK 各版本项目页（含最终 JEP 列表）：[https://openjdk.org/projects/jdk/](https://openjdk.org/projects/jdk/)
- JEP 索引：[https://openjdk.org/jeps/0](https://openjdk.org/jeps/0)
- Oracle Java SE 支持路线图：[https://www.oracle.com/java/technologies/java-se-support-roadmap.html](https://www.oracle.com/java/technologies/java-se-support-roadmap.html)
- JDK 25 文档：[https://docs.oracle.com/en/java/javase/25/](https://docs.oracle.com/en/java/javase/25/)

> 下一篇：[异常体系](./10_topic_exception) —— 进入语言机制部分，从受检与非受检异常的设计讲到生产中的异常处理规范。
